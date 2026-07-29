import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import {
  cropInterleavedPixels,
  detectChartPanels,
} from "../lib/vth-chart-panel-core.mjs";
import {
  analyzeForegroundMasks,
  extractRepeatedArchPeakEvidence,
} from "../lib/vth-image-analysis-core.mjs";
import { buildForegroundMasks } from "../lib/vth-image-core.mjs";

const EXPECTED_VISIBLE_PEAK_COUNTS = [
  1, 2, 3, 4,
  5, 6, 7, 8,
  10, 10, 11, 12,
  14, 15, 16, 17,
];

const CELL_COLUMNS = [
  [40, 300],
  [320, 585],
  [605, 870],
  [880, 1145],
];
const CELL_ROWS = [
  [105, 255],
  [275, 435],
  [455, 610],
  [625, 835],
];

async function loadFixture() {
  const bytes = await readFile(
    new URL(
      "./fixtures/state-count-sweep/scatter-outliers-1672.png",
      import.meta.url,
    ),
  );
  return decodePng(bytes);
}

function cellIndexForPanel(panel) {
  const centerX = panel.left + panel.width / 2;
  const centerY = panel.top + panel.height / 2;
  const column = CELL_COLUMNS.findIndex(
    ([left, right]) =>
      centerX >= left && centerX <= right,
  );
  const row = CELL_ROWS.findIndex(
    ([top, bottom]) =>
      centerY >= top && centerY <= bottom,
  );
  return row >= 0 && column >= 0
    ? row * CELL_COLUMNS.length + column
    : -1;
}

function repeatedArchEvidenceForCrop(crop) {
  const foreground = buildForegroundMasks(
    crop.pixels,
    crop.width,
    crop.height,
    crop.channels,
  );
  const analysis = analyzeForegroundMasks(
    foreground.broadMask,
    foreground.salientMask,
    crop.width,
    crop.height,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
  );
  return extractRepeatedArchPeakEvidence(
    foreground.broadMask,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
    crop.width,
    crop.height,
    analysis.preprocessing.bounds,
  );
}

test("scatter outliers: mask-only evidence counts every visible repeated Gaussian arch", async () => {
  const image = await loadFixture();
  const detection = detectChartPanels(
    image.data,
    image.width,
    image.height,
    image.channels,
  );
  assert.equal(detection.panels.length, 16);

  const measuredCounts = Array(16).fill(null);
  for (const panel of detection.panels) {
    const cellIndex = cellIndexForPanel(panel);
    assert.ok(cellIndex >= 0);
    const crop = cropInterleavedPixels(
      image.data,
      image.width,
      image.height,
      image.channels,
      panel,
    );
    const evidence = repeatedArchEvidenceForCrop(crop);
    const expectedCount =
      EXPECTED_VISIBLE_PEAK_COUNTS[cellIndex];
    assert.equal(
      evidence.accepted,
      true,
      `cell ${cellIndex + 1}: ${evidence.reason}`,
    );
    assert.equal(
      evidence.peakCount,
      expectedCount,
      `cell ${cellIndex + 1}: count physical caps, not its caption`,
    );
    assert.equal(
      evidence.peakCenters.length,
      expectedCount,
    );
    assert.equal(
      evidence.normalizedPeakCenters.length,
      expectedCount,
    );
    assert.ok(evidence.stability >= 0.5);
    assert.ok(
      evidence.gapCoefficientOfVariation <= 0.2,
    );
    assert.ok(evidence.expandingRatio >= 0.75);
    assert.ok(evidence.concaveRatio >= 0.75);
    assert.ok(
      evidence.medianEnvelopeCorrelation >= 0.62,
    );
    measuredCounts[cellIndex] = evidence.peakCount;
  }
  assert.deepEqual(
    measuredCounts,
    EXPECTED_VISIBLE_PEAK_COUNTS,
  );
});

test("scatter outliers: table and monotone trend distractors fail the arch geometry gate", async () => {
  const image = await loadFixture();
  const distractors = [
    {
      name: "table",
      bounds: {
        left: 1165,
        top: 335,
        width: 475,
        height: 210,
      },
    },
    {
      name: "trend",
      bounds: {
        left: 1165,
        top: 570,
        width: 480,
        height: 285,
      },
    },
  ];
  for (const distractor of distractors) {
    const crop = cropInterleavedPixels(
      image.data,
      image.width,
      image.height,
      image.channels,
      distractor.bounds,
    );
    const evidence = repeatedArchEvidenceForCrop(crop);
    assert.equal(
      evidence.accepted,
      false,
      `${distractor.name} must not become a distribution`,
    );
    assert.equal(evidence.peakCount, 0);
    assert.equal(
      evidence.reason,
      "ARCH_GEOMETRY_REJECTED",
    );
  }
});
