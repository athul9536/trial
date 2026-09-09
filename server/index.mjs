/**
 * Framinu Purathu backend.
 *
 * Why this exists: we only have a long-lived Azure API key, not Entra
 * credentials, so there is no way to mint a short-lived browser token. Putting
 * the key in client code would ship a permanent secret to every visitor.
 *
 * So the Voice Live session lives here. The browser opens its own WebSocket to
 * this server and exchanges raw PCM16 audio plus small JSON control messages.
 * One browser socket == one Voice Live session, torn down together.
 */

import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { VoiceLiveClient } from "@azure/ai-voicelive";
import { AzureKeyCredential } from "@azure/core-auth";
import { CHAIR, buildSessionConfig } from "./character.mjs";
import { analyseImage, VisionError, visionModelName } from "./vision.mjs";
import { buildInstructions, validateCard } from "./characterCard.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const ENDPOINT = process.env.AZURE_VOICELIVE_ENDPOINT;
const API_KEY = process.env.AZURE_VOICELIVE_API_KEY;
const MODEL = process.env.AZURE_VOICELIVE_MODEL ?? "gpt-realtime-2.1";
const VOICE = process.env.AZURE_VOICELIVE_VOICE ?? "ml-IN-MidhunNeural";
const STT_LANGUAGES = process.env.AZURE_VOICELIVE_STT_LANGUAGES ?? "ml-IN,en-IN";
const DEBUG = process.env.DEBUG === "true";

if (!ENDPOINT || !API_KEY) {
  console.error("[fatal] AZURE_VOICELIVE_ENDPOINT and AZURE_VOICELIVE_API_KEY must be set in .env");
  process.exit(1);
}

const app = express();

// Images arrive as data URLs. Resizing happens in the browser before upload, so
// this ceiling exists to reject abuse, not normal photos.
app.use(express.json({ limit: "8mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, voices: VOICES, visionModel: visionModelName });
});

/** The built-in fallback character, used when nothing has been uploaded. */
app.get("/api/character", (_req, res) => {
  res.json({
    id: CHAIR.id,
    label: CHAIR.label,
    imageUrl: CHAIR.imageUrl,
    mouth: CHAIR.mouth,
    openingLine: CHAIR.openingLine,
  });
});

/**
 * Character store. Cards live in memory only and are never written to disk:
 * we do not persist uploaded images, transcripts or generated personalities.
 * Bounded so a long session cannot grow without limit.
 */
const characters = new Map();
const MAX_CHARACTERS = 24;

/**
 * We store the card, not finished instructions, because the prompt depends on
 * the voice the user picks afterwards. Malayalam self-descriptions are gendered,
 * so the same card produces two different prompts.
 */
function storeCharacter(card) {
  const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  characters.set(id, { card });
  while (characters.size > MAX_CHARACTERS) {
    characters.delete(characters.keys().next().value);
  }
  return id;
}

/** Malayalam has exactly two voices on Azure, so this is the whole palette. */
const VOICES = {
  male: VOICE,
  female: process.env.AZURE_VOICELIVE_VOICE_FEMALE ?? "ml-IN-SobhanaNeural",
};

function resolveVoice(requested) {
  return requested === "female" ? "female" : "male";
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** How long the user may stay silent before the character prods them. */
const IDLE_PROD_MS = 10000;

/** Stop after this many unanswered prods, so it nags rather than harasses. */
const IDLE_PROD_LIMIT = 3;

/**
 * Hidden prompts for idle prodding. Escalating, so a long silence becomes a
 * small comic arc rather than the same line three times.
 */
const IDLE_PROMPTS = [
  "ഉപയോക്താവ് കുറച്ചു നേരം ഒന്നും പറഞ്ഞില്ല. ഒരു ചെറിയ കുത്തുവാക്കോടെ അവരെ വിളിക്കുക.",
  "ഇപ്പോഴും ഒന്നും പറയുന്നില്ല. കൂടുതൽ അക്ഷമയോടെ ഒരു വാചകം പറയുക.",
  "ഇത് മൂന്നാം തവണയാണ്. നാടകീയമായി പരിഭവിച്ച്, പോകാൻ ഒരുങ്ങുന്നതുപോലെ ഒരു വാചകം പറയുക.",
];

app.post("/api/analyse", async (req, res) => {
  const dataUrl = req.body?.imageDataUrl;

  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return res.status(400).json({ error: "Expected an image data URL." });
  }

  const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
  if (!ALLOWED_IMAGE_TYPES.has(mime)) {
    return res
      .status(415)
      .json({ error: `Unsupported image type "${mime}". Use JPEG, PNG or WebP.` });
  }

  const startedAt = Date.now();
  try {
    const raw = await analyseImage(dataUrl);
    const { card, warnings } = validateCard(raw);
    const id = storeCharacter(card);

    console.log(
      `[analyse] ${card.subjectType} "${card.subjectLabel}" in ${Date.now() - startedAt}ms` +
        (warnings.length ? ` (defaulted: ${warnings.join(", ")})` : ""),
    );

    res.json({ id, card, warnings, elapsedMs: Date.now() - startedAt });
  } catch (err) {
    const message = err instanceof VisionError ? err.message : "Image analysis failed.";
    console.error("[analyse] failed:", err?.message ?? err);
    // The client can still continue by describing the subject manually, so this
    // is a recoverable error rather than a dead end.
    res.status(502).json({ error: message, recoverable: true });
  }
});

/**
 * Manual fallback for when analysis fails or the subject is misread. The user
 * describes the subject themselves and we build a card from that.
 */
app.post("/api/character/manual", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label : "";
  if (!label.trim()) {
    return res.status(400).json({ error: "Describe the subject in a few words." });
  }

  const { card } = validateCard({
    subjectType: "unclear",
    subjectLabel: label,
    visibleDetails: Array.isArray(req.body?.visibleDetails) ? req.body.visibleDetails : [],
    mouthSuggestion: req.body?.mouth,
  });
  const id = storeCharacter(card);
  res.json({ id, card, warnings: [], elapsedMs: 0 });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/realtime" });

const client = new VoiceLiveClient(ENDPOINT, new AzureKeyCredential(API_KEY));

let connectionCounter = 0;

wss.on("connection", (browser, request) => {
  const id = ++connectionCounter;
  const log = (...args) => console.log(`[conn ${id}]`, ...args);

  // The character is chosen at connect time via query string, so the session is
  // configured correctly on the first update instead of needing a round trip.
  const params = new URL(request.url ?? "/", "http://localhost").searchParams;
  const requestedId = params.get("character");
  const voiceGender = resolveVoice(params.get("voice"));
  const voiceName = VOICES[voiceGender];

  const stored = requestedId ? characters.get(requestedId) : null;
  if (requestedId && !stored) {
    // Most likely the server restarted while the page stayed open.
    log(`unknown character "${requestedId}", falling back to the chair`);
  }

  // Instructions are assembled here rather than at analysis time, because
  // Malayalam self-description is gendered and depends on the chosen voice.
  const character = stored
    ? {
        instructions: buildInstructions(stored.card, voiceGender),
        openingLine: stored.card.openingLine,
      }
    : {
        instructions: buildInstructions(CHAIR.card, voiceGender),
        openingLine: CHAIR.openingLine,
      };

  let session = null;
  let subscription = null;
  let closed = false;

  // --- idle prodding ---------------------------------------------------
  // If the user goes quiet the character speaks unprompted, which turns dead
  // air into personality. Capped so it does not nag forever or burn quota.
  let idleTimer = null;
  let idleProds = 0;
  let responseActive = false;

  // --- truncation bookkeeping ------------------------------------------
  // The id of the assistant item currently speaking, and how much audio we have
  // sent for it. The sent figure is the upper bound for truncation: the service
  // errors if asked to truncate beyond the real audio duration.
  let currentItemId = null;
  let sentAudioMs = 0;

  /** Small JSON envelope to the browser. Audio goes as binary frames. */
  const send = (message) => {
    if (browser.readyState === browser.OPEN) {
      browser.send(JSON.stringify(message));
    }
  };

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  /** Called after each response finishes, and reset whenever the user acts. */
  const scheduleIdleProd = () => {
    clearIdleTimer();
    if (closed || idleProds >= IDLE_PROD_LIMIT) return;
    idleTimer = setTimeout(() => {
      void sendIdleProd();
    }, IDLE_PROD_MS);
  };

  const sendIdleProd = async () => {
    idleTimer = null;
    if (closed || !session || responseActive) return;

    const prompt = IDLE_PROMPTS[Math.min(idleProds, IDLE_PROMPTS.length - 1)];
    idleProds += 1;
    log(`idle prod ${idleProds}`);

    try {
      await session.addConversationItem({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      });
      await session.sendEvent({ type: "response.create" });
    } catch (err) {
      log("idle prod failed:", err?.message);
    }
  };

  /** Any deliberate user action means they are still there. */
  const noteUserActivity = () => {
    idleProds = 0;
    clearIdleTimer();
  };

  const cleanup = async (reason) => {
    if (closed) return;
    closed = true;
    clearIdleTimer();
    log(`cleanup: ${reason}`);
    try {
      await subscription?.close();
    } catch {}
    try {
      await session?.disconnect();
    } catch {}
    try {
      await session?.dispose();
    } catch {}
    session = null;
    subscription = null;
    if (browser.readyState === browser.OPEN) browser.close();
  };

  const start = async () => {
    send({ type: "state", state: "connecting" });
    session = client.createSession({ model: MODEL });

    subscription = session.subscribe({
      onServerEvent: async (event) => {
        if (DEBUG) log("event", event.type);
      },

      onSessionUpdated: async (event) => {
        const voiceName = event.session?.voice?.name;
        log(`session ready, voice=${voiceName}`);
        send({ type: "state", state: "ready" });
      },

      // What the user said. Useful for captions and for debugging Malayalam
      // recognition, which is the shakiest part of the pipeline.
      onConversationItemInputAudioTranscriptionCompleted: async (event) => {
        const text = event.transcript?.trim();
        if (text) {
          log(`user: ${text}`);
          send({ type: "userTranscript", text });
        }
      },

      onInputAudioBufferSpeechStarted: async () => {
        noteUserActivity();
        send({ type: "state", state: "listening" });
        // Barge-in: the user talking over the character must stop playback
        // immediately, both here and in the browser's audio queue. The browser
        // replies with how much it actually played so we can truncate.
        send({ type: "interrupted" });
        try {
          await session?.sendEvent({ type: "response.cancel" });
        } catch (err) {
          const msg = String(err?.message ?? "");
          if (!msg.toLowerCase().includes("no active response")) {
            log("cancel failed:", msg);
          }
        }
      },

      onInputAudioBufferSpeechStopped: async () => {
        send({ type: "state", state: "thinking" });
      },

      onResponseCreated: async () => {
        responseActive = true;
        clearIdleTimer();
        send({ type: "state", state: "thinking" });
      },

      // Gives us the assistant item id, which truncation needs to address.
      onResponseOutputItemAdded: async (event) => {
        const item = event.item;
        if (item?.id) {
          currentItemId = item.id;
          sentAudioMs = 0;
          send({ type: "responseStart", itemId: item.id });
        }
      },

      onResponseAudioDelta: async (event) => {
        if (!event.delta) return;
        const chunk = Buffer.from(event.delta, "base64");
        // PCM16 mono at 24 kHz is exactly 48 bytes per millisecond.
        sentAudioMs += chunk.length / 48;
        // Binary frame, exactly as the service sent it.
        if (browser.readyState === browser.OPEN) {
          browser.send(chunk, { binary: true });
        }
      },

      onResponseAudioTranscriptDone: async (event) => {
        const text = event.transcript?.trim();
        if (text) {
          log(`chair: ${text}`);
          send({ type: "captionText", text });
        }
      },

      onResponseDone: async () => {
        responseActive = false;
        send({ type: "state", state: "idle" });
        // Start the silence clock only once the character has stopped talking.
        scheduleIdleProd();
      },

      onServerError: async (event) => {
        const message = event.error?.message ?? "unknown";
        log("server error:", message);
        send({ type: "error", message });
      },

      onDisconnected: async () => {
        log("voice live disconnected");
        send({ type: "state", state: "ended" });
        await cleanup("provider disconnected");
      },
    });

    await session.connect();
    await session.updateSession(
      buildSessionConfig({
        model: MODEL,
        voice: voiceName,
        sttLanguages: STT_LANGUAGES,
        instructions: character.instructions,
      }),
    );
    log(`session configured, voice=${voiceName} (${voiceGender})`);
  };

  browser.on("message", async (data, isBinary) => {
    if (closed || !session) return;

    // Binary == microphone audio. Hot path, keep it cheap.
    if (isBinary) {
      try {
        await session.sendAudio(new Uint8Array(data));
      } catch (err) {
        if (DEBUG) log("sendAudio failed:", err?.message);
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (message.type) {
      // Awakening: the character speaks first so the user does not have to
      // invent an opening question.
      //
      // We ask the model to produce the greeting rather than injecting a
      // pre-written line as assistant text. Injecting it meant the caption
      // showed one sentence while the audio spoke a different one.
      case "greet":
        try {
          await session.addConversationItem({
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `ആരോ നിന്റെ ചിത്രത്തിന് മുന്നിൽ വന്നു. ഇതുപോലെ ഒരു ചെറിയ വാചകത്തിൽ അവരെ അഭിവാദ്യം ചെയ്യുക: "${character.openingLine}"`,
              },
            ],
          });
          await session.sendEvent({ type: "response.create" });
        } catch (err) {
          log("greet failed:", err?.message);
          // Not fatal: the user can still just start talking.
          send({ type: "captionText", text: character.openingLine });
        }
        break;

      // Typed question. Real feature, not just test scaffolding: if microphone
      // permission is refused, the conversation can still happen by text
      // through the same realtime session and the same voice.
      case "ask": {
        const text = typeof message.text === "string" ? message.text.trim().slice(0, 500) : "";
        if (!text) break;
        noteUserActivity();
        try {
          send({ type: "userTranscript", text });
          await session.addConversationItem({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          });
          await session.sendEvent({ type: "response.create" });
        } catch (err) {
          log("ask failed:", err?.message);
          send({ type: "error", message: "Could not send that question." });
        }
        break;
      }

      case "interrupt":
        noteUserActivity();
        try {
          await session.sendEvent({ type: "response.cancel" });
        } catch {}
        send({ type: "interrupted" });
        break;

      /**
       * The browser reporting how much of a response it actually played, so we
       * can truncate the conversation item to match.
       *
       * Without this the model believes it said everything we streamed, even
       * though audio arrives faster than realtime and the user cut it off. Over
       * several interruptions its sense of the conversation drifts from reality.
       */
      case "played": {
        const itemId = typeof message.itemId === "string" ? message.itemId : null;
        if (!itemId || itemId !== currentItemId) break;

        // The service errors if asked to truncate past the real audio duration,
        // so clamp to what we actually sent.
        const heardMs = Math.max(0, Math.min(Math.round(message.ms ?? 0), Math.floor(sentAudioMs)));

        try {
          await session.sendEvent({
            type: "conversation.item.truncate",
            itemId,
            contentIndex: 0,
            audioEndInMs: heardMs,
          });
          if (DEBUG) log(`truncated ${itemId} at ${heardMs}ms of ${Math.floor(sentAudioMs)}ms`);
        } catch (err) {
          // Non-fatal: the conversation continues, just with slightly optimistic
          // context about what the user heard.
          log("truncate failed:", err?.message);
        }
        break;
      }

      // Signature interaction. The reaction is spoken by the live session, so
      // no pre-recorded audio and no generated video.
      case "escape":
        noteUserActivity();
        try {
          await session.addConversationItem({
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "നീ ഇപ്പോൾ ഫ്രെയിമിന് പുറത്ത് ചാടാൻ ശ്രമിച്ചു, പക്ഷേ ഫ്രെയിമിന്റെ അതിരിൽ ഇടിച്ചു. ആ വേദനയോടെ പ്രതികരിക്കുക.",
              },
            ],
          });
          await session.sendEvent({ type: "response.create" });
        } catch (err) {
          log("escape failed:", err?.message);
        }
        break;

      default:
        break;
    }
  });

  browser.on("close", () => cleanup("browser closed"));
  browser.on("error", (err) => cleanup(`browser error: ${err?.message}`));

  start().catch(async (err) => {
    log("startup failed:", err?.message ?? err);
    send({
      type: "error",
      message: `Could not start the realtime session: ${err?.message ?? err}`,
    });
    await cleanup("startup failed");
  });
});

httpServer.listen(PORT, () => {
  console.log(`Framinu Purathu server on http://localhost:${PORT}`);
  console.log(`  model  ${MODEL}`);
  console.log(`  voices ${VOICES.male} / ${VOICES.female}`);
  console.log(`  vision ${visionModelName}   stt ${STT_LANGUAGES}`);
});
