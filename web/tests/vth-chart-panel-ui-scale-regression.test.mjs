import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import { detectChartPanels } from "../lib/vth-chart-panel-core.mjs";
import { searchSimilarityImage } from "../lib/vth-similarity-api-core.mjs";
import { uiScaledRgba } from "./helpers/ui-raster-scale.mjs";

const corpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);
const fixtures = [
  {
    name: "vth-02s-s0042-00003--base.png",
    processed: [1920, 879],
    stateCount: 2,
  },
  {
    name: "vth-02s-s0043-00017--base.png",
    processed: [1920, 831],
    stateCount: 2,
  },
  {
    name: "vth-16s-s0042-00006--base.png",
    processed: [1920, 837],
    stateCount: 16,
  },
];

function sourceBounds(panel, processed, source) {
  const left = Math.max(
    0,
    Math.floor((panel.x / processed.width) * source.width),
  );
  const top = Math.max(
    0,
    Math.floor((panel.y / processed.height) * source.height),
  );
  const right = Math.min(
    source.width,
    Math.ceil(
      ((panel.x + panel.width) / processed.width) *
        source.width,
    ),
  );
  const bottom = Math.min(
    source.height,
    Math.ceil(
      ((panel.y + panel.height) / processed.height) *
        source.height,
    ),
  );
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function drawLine(mask, width, x1, y1, x2, y2, thickness = 2) {
  const height = Math.floor(mask.length / width);
  const steps = Math.max(
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
    1,
  );
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let localY = y; localY < y + thickness; localY += 1) {
      for (let localX = x; localX < x + thickness; localX += 1) {
        if (
          localX >= 0 &&
          localX < width &&
          localY >= 0 &&
          localY < height
        ) {
          mask[localY * width + localX] = 1;
        }
      }
    }
  }
}

function drawTwoPeakDistribution(mask, width) {
  let previous;
  for (let x = 25; x <= 365; x += 1) {
    const progress = (x - 25) / 340;
    const response = Math.max(
      Math.exp(-0.5 * ((progress - 0.25) / 0.04) ** 2),
      Math.exp(-0.5 * ((progress - 0.75) / 0.04) ** 2),
    );
    const point = {
      x,
      y: Math.round(355 - response * 120),
    };
    if (previous) {
      drawLine(
        mask,
        width,
        previous.x,
        previous.y,
        point.x,
        point.y,
        3,
      );
    }
    previous = point;
  }
}

function drawThreeByThreeTable(
  mask,
  width,
  left,
  top,
  tableWidth,
  tableHeight,
) {
  for (let line = 0; line <= 3; line += 1) {
    const x = Math.round(left + (tableWidth * line) / 3);
    const y = Math.round(top + (tableHeight * line) / 3);
    drawLine(mask, width, x, top, x, top + tableHeight);
    drawLine(mask, width, left, y, left + tableWidth, y);
  }
}

test("preserves complete small corpus curves after the browser UI raster scale", async () => {
  for (const fixture of fixtures) {
    const bytes = await readFile(
      new URL(
        `../public/corpus/${fixture.name}`,
        import.meta.url,
      ),
    );
    const source = decodePng(bytes);
    const processed = uiScaledRgba(
      source.data,
      source.width,
      source.height,
      source.channels,
    );
    assert.deepEqual(
      [processed.width, processed.height],
      fixture.processed,
      `${fixture.name} must exercise the same bounded raster as the UI`,
    );

    const detected = detectChartPanels(
      processed.pixels,
      processed.width,
      processed.height,
      processed.channels,
      { sourceScale: processed.scale },
    );
    assert.equal(
      detected.panels.length,
      1,
      `${fixture.name} must retain one distribution after UI upscaling`,
    );
    assert.equal(detected.fallbackUsed, true);
    assert.equal(
      detected.panels[0].detectionReason,
      "whole-image-fallback",
    );
    const mapped = sourceBounds(
      detected.panels[0],
      processed,
      source,
    );
    assert.ok(mapped.width / source.width >= 0.9);
    assert.ok(mapped.height / source.height >= 0.9);

    const response = await searchSimilarityImage({
      bytes,
      mimeType: "image/png",
      topK: 1,
      corpus,
      origin: "https://dove9999.com",
    });
    assert.equal(response.panelCount, 1);
    assert.equal(response.panelDetection.fallbackUsed, true);
    assert.equal(response.query.stateCount, fixture.stateCount);
    const apiBounds = response.panels[0].bounds.source;
    assert.ok(apiBounds.width / source.width >= 0.9);
    assert.ok(apiBounds.height / source.height >= 0.9);
  }
});

test("crops a frameless waveform away from detached small tables", () => {
  for (const [tableWidth, tableHeight] of [
    [24, 20],
    [40, 40],
    [80, 20],
    [80, 60],
  ]) {
    const width = 760;
    const height = 420;
    const mask = new Uint8Array(width * height);
    drawTwoPeakDistribution(mask, width);
    drawThreeByThreeTable(
      mask,
      width,
      430,
      48,
      tableWidth,
      tableHeight,
    );

    const detected = detectChartPanels(
      (() => {
        const rgb = new Uint8Array(mask.length * 3).fill(255);
        mask.forEach((value, index) => {
          if (!value) return;
          rgb[index * 3] = 20;
          rgb[index * 3 + 1] = 20;
          rgb[index * 3 + 2] = 20;
        });
        return rgb;
      })(),
      width,
      height,
      3,
    );
    assert.equal(detected.panels.length, 1);
    assert.equal(
      detected.fallbackUsed,
      false,
      `${tableWidth}×${tableHeight} table must not leak through whole-image fallback`,
    );
    assert.equal(
      detected.panels[0].detectionReason,
      "frameless-curve-region",
    );
    assert.ok(detected.panels[0].right < 400);
  }
});
