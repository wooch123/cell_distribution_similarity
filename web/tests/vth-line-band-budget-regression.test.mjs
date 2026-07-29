import assert from "node:assert/strict";
import test from "node:test";

import { extractLineBands } from "../lib/vth-chart-panel-core.mjs";

test("streams and fairly bounds adversarial FHD dashed rules without losing a real axis", () => {
  const width = 1920;
  const height = 1080;
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const phase = (y * 17) % 47;
    for (let x = phase; x < width; x += 60) {
      for (
        let localX = x;
        localX < Math.min(width, x + 14);
        localX += 1
      ) {
        mask[y * width + localX] = 1;
      }
    }
  }
  for (const y of [900, 901]) {
    for (let x = 300; x <= 1400; x += 1) {
      mask[y * width + x] = 1;
    }
  }

  const started = performance.now();
  const bands = extractLineBands(
    mask,
    width,
    height,
    "horizontal",
    14,
    0,
  );
  const elapsedMilliseconds = performance.now() - started;

  assert.ok(
    bands.length <= 1024,
    `line-band hard cap exceeded: ${bands.length}`,
  );
  assert.ok(
    bands.some(
      (band) =>
        Math.abs(band.coordinate - 901) <= 2 &&
        band.start <= 300 &&
        band.end >= 1400,
    ),
    "the long physical axis was starved by short dashed-rule noise",
  );
  assert.ok(
    elapsedMilliseconds < 1500,
    `FHD line-band extraction exceeded its stress budget: ${elapsedMilliseconds.toFixed(1)}ms`,
  );
});
