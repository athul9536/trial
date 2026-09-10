/**
 * Spike 22 — in-style mouth shapes via FLUX.1 Kontext.
 *
 * Question this answers: can an image-editing model redraw the mouth of a
 * drawing in the drawing's own style, well enough to replace the cartoon SVG
 * mouth overlay?
 *
 * The plan being tested:
 *   original artwork
 *     -> Kontext edit "same painting, mouth slightly open"   (variant: mid)
 *     -> Kontext edit "same painting, mouth open wide"       (variant: wide)
 *   then the browser crops just the mouth rectangle out of each variant and
 *   cross-fades between them using the audio amplitude that already drives the
 *   cartoon mouth.
 *
 * Cropping to the mouth rectangle is the whole trick: every other pixel on
 * screen stays the original artwork, so any global drift the editor introduces
 * is thrown away instead of showing up as a flicker.
 *
 * Four things must hold for this to be viable, and the viewer built by
 * 23-mouth-chart-viewer.mjs is how they get judged:
 *   1. the edit is not refused
 *   2. the mouth actually opens, in the artwork's own style
 *   3. framing is preserved, so the crop lands in the same place
 *   4. the crop composites without a visible seam
 *
 * Usage: node spike/22-mouth-chart.mjs [path-to-image]
 */

import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.join("spike", "out", "mouth");

const SOURCE = process.argv[2] ?? path.join("public", "examples", "mona-lisa.jpg");

/**
 * One seed across every variant. Kontext re-renders the whole image, so a
 * different seed per call would change brushwork everywhere and the crop would
 * no longer match its surroundings.
 */
const SEED = 20260910;

/**
 * The instruction has to fight the model's urge to improve the picture.
 * Everything before the colon is a lock; only the clause after it may change.
 */
const PRESERVE =
  "Keep this artwork completely unchanged: identical pose, framing, composition," +
  " background, colour palette, lighting, brushwork and level of detail." +
  " Do not redraw, restyle, sharpen or modernise anything." +
  " Change one thing only:";

const VARIANTS = [
  {
    name: "mid",
    prompt:
      `${PRESERVE} the lips part slightly, showing a narrow dark gap between them,` +
      " as if the subject has just started to speak. The rest of the face is identical.",
  },
  {
    name: "wide",
    prompt:
      `${PRESERVE} the mouth is open, lips clearly parted, the dark inside of the` +
      " mouth visible, as if the subject is speaking a loud vowel." +
      " The rest of the face is identical.",
  },
];

const endpoint = process.env.AZURE_FLUX_ENDPOINT;
const apiKey = process.env.AZURE_FLUX_API_KEY;
const model = process.env.AZURE_FLUX_MODEL ?? "FLUX.1-Kontext-pro";

if (!endpoint || !apiKey) {
  console.error("AZURE_FLUX_ENDPOINT and AZURE_FLUX_API_KEY must be set in .env");
  process.exit(1);
}

/** JPEG/PNG dimensions without pulling in an image library. */
function imageSize(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  let i = 2;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buffer[i + 1];
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  return { width: 0, height: 0 };
}

/** Nearest aspect ratio Kontext accepts, as a "w:h" string. */
function aspectRatio(width, height) {
  const options = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"];
  const target = width / height;
  let best = options[0];
  let bestError = Infinity;
  for (const option of options) {
    const [w, h] = option.split(":").map(Number);
    const error = Math.abs(w / h - target);
    if (error < bestError) {
      bestError = error;
      best = option;
    }
  }
  return best;
}

/** Pull image bytes out of whichever response shape we get back. */
async function extractImage(payload) {
  const candidates = [
    payload?.data?.[0]?.b64_json,
    payload?.image,
    payload?.result?.sample,
    payload?.data?.[0]?.url,
    payload?.result?.url,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    if (candidate.startsWith("http")) {
      const response = await fetch(candidate);
      if (!response.ok) continue;
      return Buffer.from(await response.arrayBuffer());
    }
    return Buffer.from(candidate.replace(/^data:[^,]+,/, ""), "base64");
  }
  return null;
}

/** BFL returns a job for some deployments and the image inline for others. */
async function resolveJob(payload, headers) {
  let current = payload;
  const pollUrl = current?.polling_url ?? current?.status_url;
  if (!pollUrl) return current;

  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const response = await fetch(pollUrl, { headers });
    current = await response.json();
    const status = String(current?.status ?? "").toLowerCase();
    if (status.includes("ready") || status.includes("succeed") || status.includes("complet")) {
      return current;
    }
    if (status.includes("fail") || status.includes("error") || status.includes("moderat")) {
      throw new Error(`job ${status}: ${JSON.stringify(current).slice(0, 300)}`);
    }
  }
  throw new Error("job did not finish within 90s");
}

/**
 * Provider route first, because it is the only one that takes a seed. Falls
 * back to the OpenAI-compatible edits route, which works but re-rolls the
 * whole image on every call.
 */
async function editViaProvider(imageBase64, prompt, ratio) {
  // The docs give this route as <resource>.api.cognitive.microsoft.com, which
  // does not resolve for this resource. The provider path is served from the
  // resource's own hostname instead.
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  const url = `${base}providers/blackforestlabs/v1/flux-kontext-pro?api-version=preview`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      prompt,
      input_image: imageBase64,
      seed: SEED,
      aspect_ratio: ratio,
      output_format: "jpeg",
      safety_tolerance: 2,
    }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`provider HTTP ${response.status}: ${text.slice(0, 300)}`);
  return extractImage(await resolveJob(JSON.parse(text), headers));
}

async function editViaImageApi(imageBuffer, prompt, size) {
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  const url = `${base}openai/v1/images/edits?api-version=preview`;

  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", size);
  form.append("image", new Blob([imageBuffer], { type: "image/jpeg" }), "artwork.jpg");

  const response = await fetch(url, { method: "POST", headers: { "api-key": apiKey }, body: form });
  const text = await response.text();
  if (!response.ok) throw new Error(`image api HTTP ${response.status}: ${text.slice(0, 300)}`);
  return extractImage(JSON.parse(text));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const original = await readFile(SOURCE);
  const { width, height } = imageSize(original);
  const ratio = aspectRatio(width, height);
  const base64 = original.toString("base64");

  console.log(`source     ${SOURCE}  ${width}x${height}  -> aspect ${ratio}`);
  console.log(`model      ${model}   seed ${SEED}`);

  await writeFile(path.join(OUT_DIR, "closed.jpg"), original);

  // Kontext caps at 1 MP, so ask for the largest allowed box on this ratio.
  const [rw, rh] = ratio.split(":").map(Number);
  const scale = Math.sqrt((1024 * 1024) / (rw * rh));
  const size = `${Math.round((rw * scale) / 16) * 16}x${Math.round((rh * scale) / 16) * 16}`;

  const results = [{ name: "closed", file: "closed.jpg", ms: 0, route: "original" }];

  for (const variant of VARIANTS) {
    const startedAt = Date.now();
    let image = null;
    let route = "provider";

    try {
      image = await editViaProvider(base64, variant.prompt, ratio);
    } catch (error) {
      console.log(`  provider route failed: ${error.message}`);
      console.log("  falling back to the Image API edits route (no seed control)");
      route = "image-api";
      try {
        image = await editViaImageApi(original, variant.prompt, size);
      } catch (fallbackError) {
        console.log(`  image api route failed: ${fallbackError.message}`);
      }
    }

    const ms = Date.now() - startedAt;
    if (!image) {
      console.log(`FAIL       ${variant.name}  after ${ms}ms`);
      results.push({ name: variant.name, file: null, ms, route });
      continue;
    }

    const file = `${variant.name}.jpg`;
    await writeFile(path.join(OUT_DIR, file), image);
    const size2 = imageSize(image);
    console.log(
      `ok         ${variant.name.padEnd(6)} ${ms}ms  ${image.length} bytes` +
        `  ${size2.width}x${size2.height}  via ${route}`,
    );
    results.push({ name: variant.name, file, ms, route, ...size2 });
  }

  await writeFile(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(
      { source: SOURCE, width, height, ratio, seed: SEED, model, variants: results },
      null,
      2,
    ),
  );

  console.log(`\nwrote ${OUT_DIR}`);
  console.log("next: node spike/23-mouth-chart-viewer.mjs   then open the printed URL");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
