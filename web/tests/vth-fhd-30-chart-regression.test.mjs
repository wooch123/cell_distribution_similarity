import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import {
  MAXIMUM_CHART_PANELS,
  detectChartPanels,
  detectChartPanelsFromMask,
} from "../lib/vth-chart-panel-core.mjs";
import { searchSimilarityImage } from "../lib/vth-similarity-api-core.mjs";

const sampleBytes = await readFile(
  new URL(
    "../public/samples/vnand-fhd-dense-30-chart-sample.png",
    import.meta.url,
  ),
);
const sampleManifest = JSON.parse(
  await readFile(
    new URL(
      "../public/samples/vnand-fhd-dense-30-chart-sample.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const corpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

function centerOfBounds(bounds) {
  if ("x" in bounds) {
    return {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
  }
  return {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  };
}

function dimensionsOfBounds(bounds) {
  if ("x" in bounds) {
    return { width: bounds.width, height: bounds.height };
  }
  return {
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
  };
}

function assertPanelsMatchManifest(
  actualBounds,
  { centerTolerance = 18, dimensionToleranceRatio = 0.16 } = {},
) {
  assert.equal(actualBounds.length, sampleManifest.charts.length);
  for (let index = 0; index < sampleManifest.charts.length; index += 1) {
    const expected = sampleManifest.charts[index].bounds;
    const actual = actualBounds[index];
    const expectedCenter = centerOfBounds(expected);
    const actualCenter = centerOfBounds(actual);
    assert.ok(
      Math.abs(actualCenter.x - expectedCenter.x) <= centerTolerance,
      `panel ${index} center x ${actualCenter.x} should match ${expectedCenter.x}`,
    );
    assert.ok(
      Math.abs(actualCenter.y - expectedCenter.y) <= centerTolerance,
      `panel ${index} center y ${actualCenter.y} should match ${expectedCenter.y}`,
    );

    const expectedSize = dimensionsOfBounds(expected);
    const actualSize = dimensionsOfBounds(actual);
    const allowedWidthDifference = Math.max(
      18,
      expectedSize.width * dimensionToleranceRatio,
    );
    const allowedHeightDifference = Math.max(
      14,
      expectedSize.height * dimensionToleranceRatio,
    );
    assert.ok(
      Math.abs(actualSize.width - expectedSize.width) <=
        allowedWidthDifference,
      `panel ${index} width ${actualSize.width} should tightly crop ${expectedSize.width}`,
    );
    assert.ok(
      Math.abs(actualSize.height - expectedSize.height) <=
        allowedHeightDifference,
      `panel ${index} height ${actualSize.height} should tightly crop ${expectedSize.height}`,
    );
  }
}

function boundsContainsPoint(bounds, point) {
  const normalized = normalizedBounds(bounds);
  return (
    point.x >= normalized.left &&
    point.x <= normalized.right &&
    point.y >= normalized.top &&
    point.y <= normalized.bottom
  );
}

function normalizedBounds(bounds) {
  return "x" in bounds
    ? {
        left: bounds.x,
        top: bounds.y,
        right: bounds.x + bounds.width,
        bottom: bounds.y + bounds.height,
      }
    : bounds;
}

function intersectionOverUnion(first, second) {
  const a = normalizedBounds(first);
  const b = normalizedBounds(second);
  const intersectionWidth = Math.max(
    0,
    Math.min(a.right, b.right) - Math.max(a.left, b.left),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  );
  const intersection = intersectionWidth * intersectionHeight;
  const firstArea =
    Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top);
  const secondArea =
    Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
  return intersection / Math.max(1, firstArea + secondArea - intersection);
}

function assertRowMajorOrder(bounds, rows = 5, columns = 6) {
  assert.equal(bounds.length, rows * columns);
  for (let row = 0; row < rows; row += 1) {
    const rowBounds = bounds.slice(row * columns, (row + 1) * columns);
    for (let column = 1; column < rowBounds.length; column += 1) {
      assert.ok(
        centerOfBounds(rowBounds[column - 1]).x <
          centerOfBounds(rowBounds[column]).x,
        `row ${row} must be ordered from left to right`,
      );
    }
    if (row > 0) {
      const previousRow = bounds.slice(
        (row - 1) * columns,
        row * columns,
      );
      assert.ok(
        Math.max(...previousRow.map((panel) => centerOfBounds(panel).y)) <
          Math.min(...rowBounds.map((panel) => centerOfBounds(panel).y)),
        `row ${row} must follow row ${row - 1}`,
      );
    }
  }
}

function drawMaskLine(
  mask,
  width,
  height,
  x1,
  y1,
  x2,
  y2,
  thickness = 2,
) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  const radius = Math.max(0, Math.floor(thickness / 2));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (
      let localY = y - radius;
      localY <= y + radius;
      localY += 1
    ) {
      for (
        let localX = x - radius;
        localX <= x + radius;
        localX += 1
      ) {
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

function drawMaskChart(mask, width, height, bounds, phase) {
  const { left, top, right, bottom } = bounds;
  drawMaskLine(mask, width, height, left, top, right, top, 1);
  drawMaskLine(mask, width, height, left, bottom, right, bottom, 1);
  drawMaskLine(mask, width, height, left, top, left, bottom, 1);
  drawMaskLine(mask, width, height, right, top, right, bottom, 1);
  let previous = null;
  for (let x = left + 5; x <= right - 5; x += 1) {
    const progress = (x - left - 5) / Math.max(1, right - left - 10);
    const y = Math.round(
      top +
        (bottom - top) * 0.56 -
        (bottom - top) *
          (0.26 * Math.sin(progress * Math.PI * 6 + phase) +
            0.09 * Math.sin(progress * Math.PI * 13)),
    );
    if (previous) {
      drawMaskLine(
        mask,
        width,
        height,
        previous.x,
        previous.y,
        x,
        y,
      );
    }
    previous = { x, y };
  }
}

test("sample deterministically represents thirty tightly packed FHD charts", () => {
  const decoded = decodePng(sampleBytes);
  const digest = createHash("sha256")
    .update(sampleBytes)
    .digest("hex");
  const panelAreas = sampleManifest.charts.map(({ bounds }) => {
    const dimensions = dimensionsOfBounds(bounds);
    return dimensions.width * dimensions.height;
  });

  assert.equal(decoded.width, 1920);
  assert.equal(decoded.height, 1080);
  assert.equal(sampleManifest.width, decoded.width);
  assert.equal(sampleManifest.height, decoded.height);
  assert.equal(sampleManifest.bytes, sampleBytes.length);
  assert.equal(sampleManifest.sha256, digest);
  assert.equal(sampleManifest.expectedChartCount, 30);
  assert.deepEqual(sampleManifest.layout, { rows: 5, columns: 6 });
  assert.ok(
    sampleManifest.minimumHorizontalGapPixels <= 3,
    "at least one adjacent pair must have a three-pixel-or-smaller gutter",
  );
  assert.ok(
    sampleManifest.minimumVerticalGapPixels <= 24,
    "vertical gutters must remain dense at FHD resolution",
  );
  assert.equal(sampleManifest.singlePeakChartIndexes.length, 7);
  assert.deepEqual(
    sampleManifest.distractors.map(({ type }) => type),
    ["table", "diagram", "photo"],
  );
  assert.ok(
    Math.max(...panelAreas) / Math.min(...panelAreas) >= 2.5,
    "the sample must exercise substantially different chart sizes",
  );
});

test("detector separates all thirty dense FHD charts and rejects distractors", () => {
  const decoded = decodePng(sampleBytes);
  const startedAt = performance.now();
  const result = detectChartPanels(
    decoded.data,
    decoded.width,
    decoded.height,
    decoded.channels,
  );
  const elapsedMs = performance.now() - startedAt;

  assert.equal(MAXIMUM_CHART_PANELS, 30);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.detectedPanelCount, 30);
  assert.equal(result.panels.length, 30);
  assert.equal(result.maxPanels, 30);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.layout, sampleManifest.layout);
  assertPanelsMatchManifest(result.panels);
  assertRowMajorOrder(result.panels);
  for (let index = 0; index < result.panels.length; index += 1) {
    assert.ok(
      intersectionOverUnion(
        result.panels[index],
        sampleManifest.charts[index].bounds,
      ) >= 0.72,
      `panel ${index} must retain at least 0.72 IoU with its plot frame`,
    );
  }

  for (const distractor of sampleManifest.distractors) {
    const distractorCenter = centerOfBounds(distractor.bounds);
    assert.ok(
      result.panels.every(
        (panel) => !boundsContainsPoint(panel, distractorCenter),
      ),
      `${distractor.type} must not be returned as a chart panel`,
    );
  }
  // The regression intentionally allows more work than smaller PPT samples
  // and shared CI load, but still catches accidental combinatorial scans.
  assert.ok(
    elapsedMs < 15_000,
    `FHD 30-panel detection took ${elapsedMs.toFixed(1)} ms`,
  );
});

test("processed-scale mask keeps thirty panels across two-to-eleven blank-pixel gutters", () => {
  const width = 1600;
  const height = 900;
  const mask = new Uint8Array(width * height);
  // These one-pixel plot frames use coordinate gaps of 3, 4, 6, 9, and 12
  // pixels. Excluding both boundary coordinates, that leaves 2, 3, 5, 8,
  // and 11 genuinely blank pixels between adjacent charts.
  const horizontalIntervals = [
    [10, 270],
    [273, 532],
    [536, 795],
    [801, 1060],
    [1069, 1328],
    [1340, 1593],
  ];
  const verticalIntervals = [
    [10, 170],
    [174, 334],
    [342, 502],
    [514, 674],
    [680, 840],
  ];
  const expected = [];

  for (let row = 0; row < verticalIntervals.length; row += 1) {
    for (let column = 0; column < horizontalIntervals.length; column += 1) {
      const [left, right] = horizontalIntervals[column];
      const [top, bottom] = verticalIntervals[row];
      const bounds = { left, top, right, bottom };
      expected.push(bounds);
      drawMaskChart(
        mask,
        width,
        height,
        bounds,
        row * 0.29 + column * 0.17,
      );
    }
  }

  const result = detectChartPanelsFromMask(mask, width, height, {
    fallbackToWholeImage: false,
  });

  assert.equal(result.detectedPanelCount, 30);
  assert.equal(result.panels.length, 30);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.layout, { rows: 5, columns: 6 });
  assertRowMajorOrder(result.panels);
  const overlaps = expected.map((bounds, index) =>
    intersectionOverUnion(result.panels[index], bounds),
  );
  assert.ok(
    Math.min(...overlaps) >= 0.72,
    `processed panels must remain tightly cropped; minimum IoU was ${Math.min(
      ...overlaps,
    ).toFixed(3)}`,
  );
});

test("similarity API returns an independent ranking for every FHD chart", async () => {
  const response = await searchSimilarityImage({
    bytes: sampleBytes,
    mimeType: "image/png",
    topK: 1,
    corpus,
    origin: "https://dove9999.com",
  });

  assert.equal(response.panelCount, 30);
  assert.equal(response.panelDetection.detectedPanelCount, 30);
  assert.equal(response.panelDetection.analyzedPanelCount, 30);
  assert.equal(response.panelDetection.maxPanels, 30);
  assert.equal(response.panelDetection.truncated, false);
  assert.equal(response.panelDetection.fallbackUsed, false);
  assert.deepEqual(response.panelLayout, sampleManifest.layout);
  assert.deepEqual(
    response.panels.map(({ panelIndex }) => panelIndex),
    Array.from({ length: 30 }, (_, index) => index),
  );
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.results.length === 1 &&
        panel.bounds.source.width > 0 &&
        panel.bounds.source.height > 0 &&
        panel.bounds.normalized.width > 0 &&
        panel.bounds.normalized.width < 1,
    ),
    "each separated source crop must be analyzed and ranked independently",
  );
  const sourceBounds = response.panels.map(({ bounds }) => bounds.source);
  const processedBounds = response.panels.map(
    ({ bounds }) => bounds.processed,
  );
  assertPanelsMatchManifest(
    sourceBounds,
    { centerTolerance: 22, dimensionToleranceRatio: 0.2 },
  );
  assertRowMajorOrder(sourceBounds);
  for (let index = 0; index < sourceBounds.length; index += 1) {
    assert.ok(
      intersectionOverUnion(
        sourceBounds[index],
        sampleManifest.charts[index].bounds,
      ) >= 0.66,
      `API panel ${index} must retain at least 0.66 source-space IoU`,
    );
    assert.ok(
      Math.abs(
        processedBounds[index].width / sourceBounds[index].width -
          1,
      ) <= 0.03,
      "FHD panel detection must preserve the native 1920×1080 raster",
    );
  }
  for (const distractor of sampleManifest.distractors) {
    const distractorCenter = centerOfBounds(distractor.bounds);
    assert.ok(
      sourceBounds.every(
        (bounds) => !boundsContainsPoint(bounds, distractorCenter),
      ),
      `${distractor.type} must not be ranked by the API`,
    );
  }
});
