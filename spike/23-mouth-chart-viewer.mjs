/**
 * Spike server for the mouth-chart work.
 *
 * Serves two pages and one route:
 *
 *   /            crop-first flow — landmarks find the lips, only that crop is
 *                sent for editing, so the model cannot drift the rest
 *   /whole       the earlier whole-image flow, kept for comparison
 *   POST /api/edit
 *
 * The browser never holds the FLUX key, matching how the real app is built.
 * A static server rather than opening the files directly, because canvas
 * getImageData on file:// images counts as cross-origin and would throw.
 *
 * Usage: node spike/23-mouth-chart-viewer.mjs
 */

import "dotenv/config";
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { editImage, imageSize, nearestAspectRatio } from "./lib/fluxKontext.mjs";

const PORT = Number(process.env.PORT ?? 5199);
const ROOT = path.resolve("spike");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(ROOT, { index: false }));
// Same-origin so canvas reads are not tainted.
app.use("/examples", express.static(path.resolve("public", "examples")));

app.get("/", (_request, response) =>
  response.sendFile(path.join(ROOT, "mouth-crop-viewer.html")),
);

app.get("/audit", (_request, response) =>
  response.sendFile(path.join(ROOT, "landmark-audit.html")),
);

app.get("/whole", (_request, response) => {
  if (!existsSync(path.join(ROOT, "out", "mouth", "manifest.json"))) {
    response.status(404).send("Run: node spike/22-mouth-chart.mjs");
    return;
  }
  response.sendFile(path.join(ROOT, "mouth-chart-viewer.html"));
});

app.post("/api/edit", async (request, response) => {
  const { image, prompt, seed } = request.body ?? {};
  if (typeof image !== "string" || typeof prompt !== "string") {
    response.status(400).json({ error: "image and prompt are required" });
    return;
  }

  const base64 = image.replace(/^data:[^,]+,/, "");
  const startedAt = Date.now();

  try {
    const buffer = Buffer.from(base64, "base64");
    const { width, height } = imageSize(buffer);
    const aspectRatio = width && height ? nearestAspectRatio(width, height) : undefined;

    const edited = await editImage({
      imageBase64: base64,
      prompt,
      seed: Number(seed) || 20260910,
      aspectRatio,
    });

    const ms = Date.now() - startedAt;
    const out = imageSize(edited);
    console.log(
      `edit ok  ${ms}ms  in ${width}x${height} (${aspectRatio})  out ${out.width}x${out.height}`,
    );
    response.json({
      image: `data:image/jpeg;base64,${edited.toString("base64")}`,
      ms,
      requested: { width, height, aspectRatio },
      returned: out,
    });
  } catch (error) {
    console.log(`edit FAILED after ${Date.now() - startedAt}ms: ${error.message}`);
    response.status(502).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  crop-first viewer:  http://localhost:${PORT}/`);
  console.log(`  landmark audit:     http://localhost:${PORT}/audit`);
  console.log(`  whole-image viewer: http://localhost:${PORT}/whole\n`);
  console.log("  Ctrl+C to stop.\n");
});
