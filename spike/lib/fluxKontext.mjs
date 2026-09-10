/**
 * FLUX.1 Kontext image editing against Microsoft Foundry.
 *
 * Shared by the spike scripts and the spike server so the request shape and its
 * gotchas live in one place.
 *
 * Two findings worth keeping:
 *
 * 1. The provider route is documented as
 *    <resource>.api.cognitive.microsoft.com, which does not resolve for this
 *    resource at all. It is served from the resource's own hostname instead.
 *
 * 2. The OpenAI-compatible images/edits route returns "Model not supported with
 *    Responses API" for this deployment, so the provider route is the only one
 *    that works. That is the better route anyway: it is the only one exposing
 *    `seed`, and a shared seed is what stops brushwork changing between the
 *    mouth variants.
 */

const ASPECT_OPTIONS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "7:3", "3:7"];

/** Nearest aspect ratio the model accepts, as a "w:h" string. */
export function nearestAspectRatio(width, height) {
  const target = width / height;
  let best = ASPECT_OPTIONS[0];
  let bestError = Infinity;
  for (const option of ASPECT_OPTIONS) {
    const [w, h] = option.split(":").map(Number);
    const error = Math.abs(w / h - target);
    if (error < bestError) {
      bestError = error;
      best = option;
    }
  }
  return best;
}

/** Image dimensions from JPEG or PNG headers, without an image library. */
export function imageSize(buffer) {
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

function config() {
  const endpoint = process.env.AZURE_FLUX_ENDPOINT;
  const apiKey = process.env.AZURE_FLUX_API_KEY;
  if (!endpoint || !apiKey) {
    throw new Error("AZURE_FLUX_ENDPOINT and AZURE_FLUX_API_KEY must be set in .env");
  }
  return {
    base: endpoint.endsWith("/") ? endpoint : `${endpoint}/`,
    apiKey,
    model: process.env.AZURE_FLUX_MODEL ?? "FLUX.1-Kontext-pro",
  };
}

async function extractImage(payload) {
  const candidates = [
    payload?.data?.[0]?.b64_json,
    payload?.image,
    payload?.result?.sample,
    payload?.data?.[0]?.url,
    payload?.result?.url,
  ].filter((value) => typeof value === "string");

  for (const candidate of candidates) {
    if (candidate.startsWith("http")) {
      const response = await fetch(candidate);
      if (!response.ok) continue;
      return Buffer.from(await response.arrayBuffer());
    }
    return Buffer.from(candidate.replace(/^data:[^,]+,/, ""), "base64");
  }
  return null;
}

/** Some deployments return the image inline, others return a job to poll. */
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
 * Edit an image in context.
 *
 * @param {object} options
 * @param {string} options.imageBase64 source image, base64 without a data: prefix
 * @param {string} options.prompt      instruction describing the single change
 * @param {number} options.seed        shared across variants so only the
 *                                     instructed region differs between them
 * @param {string} [options.aspectRatio]
 * @returns {Promise<Buffer>} edited image bytes
 */
export async function editImage({ imageBase64, prompt, seed, aspectRatio }) {
  const { base, apiKey, model } = config();
  const url = `${base}providers/blackforestlabs/v1/flux-kontext-pro?api-version=preview`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      prompt,
      input_image: imageBase64,
      seed,
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      output_format: "jpeg",
      safety_tolerance: 2,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
  }

  const image = await extractImage(await resolveJob(JSON.parse(text), headers));
  if (!image) throw new Error(`no image in response: ${text.slice(0, 300)}`);
  return image;
}
