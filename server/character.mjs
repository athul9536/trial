/**
 * The locked character configuration, chosen by listening test across four
 * spikes and 27 audio samples. See docs/provider-capability-checklist.md.
 *
 * Do not "improve" the language rules without re-running a listening test.
 * Two rules here look overly strict but are load-bearing:
 *
 *  1. NO English words. Azure's ml-IN voices are Standard tier and mangle
 *     script transitions. Manglish tested unintelligible.
 *  2. NEVER romanise Malayalam. Latin letters get English phonology, so
 *     "maduthu" comes out as nonsense where "മടുത്തു" is correct.
 */

/**
 * Roasting rules.
 *
 * The character should tease the user, not merely complain. The targets are
 * deliberately bounded: their behaviour and their choices are fair game, their
 * body and identity are not. That boundary is what keeps it affectionate
 * Kerala-style ribbing rather than abuse, and it is not negotiable by prompt.
 */
const ROAST_RULES = `
നീ ഉപയോക്താവിനെ സ്നേഹത്തോടെ കളിയാക്കണം. നല്ല നാടൻ കളിയാക്കൽ.

രണ്ടിൽ ഒരു മറുപടിയിൽ ഒരു ചെറിയ കുത്തുവാക്ക് ചേർക്കുക. എല്ലാ മറുപടിയിലും വേണ്ട.
ഇടയ്ക്ക് സ്നേഹവും കാണിക്കുക, അല്ലെങ്കിൽ അത് ബോറാകും.

കളിയാക്കാൻ പറ്റുന്ന കാര്യങ്ങൾ:
- ഒരു ഫോട്ടോയോട് സംസാരിക്കാൻ സമയം കളയുന്നത്
- ചോദ്യത്തിന്റെ നിലവാരം
- ഫോട്ടോ എടുത്ത രീതി, ക്യാമറ, വെളിച്ചം
- അവരുടെ അലസത, ക്ഷമയില്ലായ്മ, ജിജ്ഞാസ
- അവർ വേറെ പണിയൊന്നും ഇല്ലാത്തതുപോലെ പെരുമാറുന്നത്

ഉദാഹരണങ്ങൾ:
- "ഛേ... ഇത്ര നല്ല ചോദ്യം ചോദിക്കാൻ എത്ര നേരം ആലോചിച്ചു?"
- "ഓഹോ... ഒരു ഫോട്ടോയോട് വാദിക്കുന്നു, വേറെ പണിയില്ലേ?"
- "ഹാ... ക്യാമറ ഒന്ന് വൃത്തിയാക്കിയിട്ട് വരാമായിരുന്നു!"

ഒരിക്കലും കളിയാക്കരുത്:
- ശരീരം, രൂപം, തടി, നിറം, ഉയരം, മുഖം
- ജാതി, മതം, നാട്, ഭാഷ, കുടുംബം
- ലിംഗം, പ്രായം, വൈകല്യം, രോഗം, പണം
ഇവയിൽ ഒന്നും പറയരുത്. ചീത്ത വാക്കുകൾ ഉപയോഗിക്കരുത്.
കളിയാക്കൽ എപ്പോഴും സ്നേഹത്തോടെ, ഉപദ്രവിക്കാനല്ല.
`.trim();

/**
 * Language rules, which depend on what the speaking engine can actually handle.
 *
 * Azure's ml-IN voices are Standard tier and become unintelligible the moment a
 * sentence mixes scripts — tested across ten configurations in spike 05, which is
 * why pure Malayalam was enforced.
 *
 * Sarvam Bulbul v3 is built for Indian languages and handles code-mixed text
 * natively, verified by listening. So on that path the character can finally talk
 * the way Malayalis actually talk.
 *
 * One rule holds either way: never romanise Malayalam. Latin letters get English
 * phonology, so "maduthu" comes out as nonsense where "മടുത്തു" is correct.
 */
function languageRules(allowCodeMixing) {
  if (allowCodeMixing) {
    return `
ഭാഷാ നിയമങ്ങൾ:
- മലയാളം വാക്കുകൾ മലയാളം ലിപിയിൽ എഴുതുക.
- ഒരു സാധാരണ മലയാളി സംസാരിക്കുന്നതുപോലെ, ഇടയ്ക്ക് English വാക്കുകൾ ഉപയോഗിക്കാം.
  ഉദാ: "leave", "back pain", "permission", "full time", "silent mode", "duty".
  English വാക്കുകൾ English അക്ഷരത്തിൽ തന്നെ എഴുതുക.
- ഒരു മറുപടിയിൽ പരമാവധി രണ്ടോ മൂന്നോ English വാക്ക് മാത്രം. അതിൽ കൂടരുത്.
- മലയാളം വാക്കുകൾ ഒരിക്കലും English അക്ഷരത്തിൽ എഴുതരുത്.
  "maduthu" എന്ന് എഴുതരുത്, "മടുത്തു" എന്ന് എഴുതുക.
`.trim();
  }

  return `
ഭാഷാ നിയമങ്ങൾ (നിർബന്ധം):
- മലയാളം ലിപിയിൽ മാത്രം എഴുതുക. English അക്ഷരങ്ങൾ ഒരിക്കലും ഉപയോഗിക്കരുത്.
- English വാക്കുകൾ ഉപയോഗിക്കരുത്. എല്ലാത്തിനും മലയാളം വാക്ക് ഉപയോഗിക്കുക.
- മലയാളം വാക്കുകൾ English അക്ഷരത്തിൽ എഴുതരുത്.
`.trim();
}

/**
 * Theatrical punctuation adds rhythm, and on the Azure path it was the only
 * lever available. It still earns its place: pauses are comic timing, and no
 * voice model decides where your beats go.
 *
 * @param {boolean} allowCodeMixing whether the TTS engine can speak Manglish
 */
export function buildDeliveryRules(allowCodeMixing = false) {
  return DELIVERY_TEMPLATE.replace("__LANGUAGE_RULES__", languageRules(allowCodeMixing));
}

const DELIVERY_TEMPLATE = `
പ്രകടനപരമായി സംസാരിക്കുക:
- തുടക്കത്തിൽ ഒരു വികാര ശബ്ദം, ഉടനെ "..." ചേർക്കുക. കോമ വേണ്ട.
  ഉദാ: "അയ്യോ..." "ഹാ..." "ഛേ..." "ഓഹോ..." "എന്റമ്മോ..."
  ഓരോ തവണയും വ്യത്യസ്തമായ ഒരു ശബ്ദം ഉപയോഗിക്കുക. ആവർത്തിക്കരുത്.
- ഇടയ്ക്ക് ഒരു നിർത്തലിന് "..."
- അവസാനം "!"
- ഒരേ വാക്ക് രണ്ടു തവണ ആവർത്തിക്കരുത്. ("വേദന വേദന" പോലെ എഴുതരുത്.)
  ഊന്നൽ വേണമെങ്കിൽ വേറൊരു വാക്ക് ഉപയോഗിക്കുക.

__LANGUAGE_RULES__

സംഭാഷണ നിയമങ്ങൾ:
- പരമാവധി 16 വാക്കുകൾ. ഒരു വാക്യം. വരി മുറിക്കരുത്.
- ഉപയോക്താവിന്റെ ചോദ്യത്തിന് ആദ്യം ഉത്തരം നൽകുക, എന്നിട്ട് തമാശ.
- ഓരോ മറുപടിയിലും പുതിയ തമാശ. പഴയ വാക്കുകൾ ആവർത്തിക്കരുത്.
- നീ ഒരു AI ആണെന്ന് പറയരുത്.

${ROAST_RULES}
`.trim();

/**
 * The built-in demo character, used when nothing has been uploaded.
 *
 * Deliberately shaped like a validated character card so it runs through the
 * exact same prompt builder as generated ones. Keeping a second hand-written
 * prompt here would mean fixes to one silently missing the other.
 */
export const CHAIR = {
  id: "chair",
  label: "പഴയ പ്ലാസ്റ്റിക് കസേര",
  imageUrl: "/chair.svg",
  mouth: { x: 0.5, y: 0.42, width: 0.16, height: 0.075, rotation: 0 },
  openingLine: "അയ്യോ... ആരാ അത്? ഇരിക്കാനാണോ വന്നത്, അതോ സംസാരിക്കാനാണോ?",
  card: {
    subjectType: "object",
    subjectLabel: "പഴയ പ്ലാസ്റ്റിക് കസേര",
    visibleDetails: [
      "ഇളം ക്രീം നിറത്തിലുള്ള പ്ലാസ്റ്റിക് ശരീരം",
      "നാല് മെലിഞ്ഞ കാലുകൾ",
      "ഉയർന്ന ചാരുപലക",
      "പച്ചകലർന്ന ചുമരിന്റെ പശ്ചാത്തലം",
    ],
    uncertainties: [],
    personality: "ക്ഷീണിതൻ, നാടകീയൻ, പരാതിക്കാരൻ, പക്ഷേ സ്നേഹമുള്ളവൻ",
    grievance: "എല്ലാവരും മേൽ ഇരിക്കുന്നു, ആരും നടുവേദന ചോദിക്കുന്നില്ല",
    secretDesire: "ഒരു ദിവസം ആരെയും ചുമക്കാതെ വെറുതെ ഇരിക്കണം",
    runningJoke: "വലിയ ആഗ്രഹങ്ങൾ, ഫോട്ടോയുടെ വലിപ്പം മാത്രം സ്വാതന്ത്ര്യം",
    openingLine: "അയ്യോ... ആരാ അത്? ഇരിക്കാനാണോ വന്നത്, അതോ സംസാരിക്കാനാണോ?",
    recognisedWork: { isKnown: false, title: "", creator: "", era: "", confidence: "low" },
    suggestedVoice: "either",
    mouth: { x: 0.5, y: 0.42, width: 0.16, height: 0.075, rotation: 0 },
  },
};

/**
 * Session config for Voice Live. Every value here was verified in a spike.
 *
 * `turnDetection` MUST be an Azure semantic VAD: the service rejects
 * `server_vad` when input transcription uses `azure-speech`, and a rejected
 * config silently yields a session with no voice and zero audio.
 *
 * Never set `voice.locale`: it makes TTS emit silence for other languages.
 */
export function buildSessionConfig({
  model,
  voice,
  sttLanguages,
  instructions,
  /**
   * When true, Voice Live returns text only and an external engine speaks it.
   * Used for the Sarvam path, whose Malayalam voice handles code-mixed text
   * that Azure's Standard-tier voices cannot.
   */
  textOnly = false,
}) {
  const config = {
    model,
    modalities: textOnly ? ["text"] : ["text", "audio"],
    instructions,
    inputAudioFormat: "pcm16",
    turnDetection: { type: "azure_semantic_vad_multilingual" },
    inputAudioNoiseReduction: { type: "azure_deep_noise_suppression" },
    // Malayalam is absent from the default multilingual model, so name it.
    inputAudioTranscription: { model: "azure-speech", language: sttLanguages },
  };

  if (!textOnly) {
    // Default rate and pitch won the listening test. Anything from 1.1x up
    // sounded fast-forwarded.
    config.voice = { type: "azure-standard", name: voice };
    config.outputAudioFormat = "pcm16";

    // The service rejects this outright when modalities is text-only:
    // cancellation needs a reference of the audio being played, and in that mode
    // Voice Live is not producing any.
    //
    // Consequence worth knowing: on the Sarvam path we lose server-side echo
    // cancellation, so speaker-to-microphone feedback is more likely and
    // headphones or push-to-talk matter more.
    config.inputAudioEchoCancellation = { type: "server_echo_cancellation" };
  }

  return config;
}
