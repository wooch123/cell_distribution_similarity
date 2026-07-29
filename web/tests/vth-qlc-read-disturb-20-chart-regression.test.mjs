import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import { detectChartPanels } from "../lib/vth-chart-panel-core.mjs";
import { buildForegroundMasks } from "../lib/vth-image-core.mjs";
import { searchSimilarityImage } from "../lib/vth-similarity-api-core.mjs";

const sampleBytes = await readFile(
  new URL(
    "./fixtures/qlc-read-disturb-20-chart-slide.png",
    import.meta.url,
  ),
);
const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

const EXPECTED_SHA256 =
  "24b979dd67f7a417befee59ce35b60da84876bf48088c459513d42f728a8b83e";
const EXPECTED_COLUMNS = [
  [59, 232],
  [286, 458],
  [511, 684],
  [737, 909],
  [963, 1136],
];
const EXPECTED_ROWS = [
  [123, 245],
  [300, 422],
  [476, 600],
  [655, 780],
];
const EXPECTED_PANELS = EXPECTED_ROWS.flatMap(([top, bottom]) =>
  EXPECTED_COLUMNS.map(([left, right]) => ({
    left,
    top,
    right,
    bottom,
  })),
);
const RIGHT_SIDE_DISTRACTORS = [
  {
    type: "explanation",
    bounds: { left: 1175, top: 102, right: 1646, bottom: 329 },
  },
  {
    type: "table",
    bounds: { left: 1175, top: 339, right: 1646, bottom: 575 },
  },
  {
    type: "non-distribution-rber-plot",
    bounds: { left: 1175, top: 584, right: 1646, bottom: 880 },
  },
];

function normalizedBounds(bounds) {
  if ("x" in bounds) {
    return {
      left: bounds.x,
      top: bounds.y,
      right: bounds.x + bounds.width,
      bottom: bounds.y + bounds.height,
    };
  }
  return bounds;
}

function centerOf(bounds) {
  const normalized = normalizedBounds(bounds);
  return {
    x: (normalized.left + normalized.right) / 2,
    y: (normalized.top + normalized.bottom) / 2,
  };
}

function containsPoint(bounds, point) {
  const normalized = normalizedBounds(bounds);
  return (
    point.x >= normalized.left &&
    point.x <= normalized.right &&
    point.y >= normalized.top &&
    point.y <= normalized.bottom
  );
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
    Math.max(0, a.right - a.left) *
    Math.max(0, a.bottom - a.top);
  const secondArea =
    Math.max(0, b.right - b.left) *
    Math.max(0, b.bottom - b.top);
  return intersection /
    Math.max(1, firstArea + secondArea - intersection);
}

function assertMatchesTwentyPanelGrid(
  actualPanels,
  {
    centerTolerance = 12,
    minimumIntersectionOverUnion = 0.65,
  } = {},
) {
  assert.equal(actualPanels.length, EXPECTED_PANELS.length);
  for (let index = 0; index < EXPECTED_PANELS.length; index += 1) {
    const expected = EXPECTED_PANELS[index];
    const actual = actualPanels[index];
    const expectedCenter = centerOf(expected);
    const actualCenter = centerOf(actual);
    assert.ok(
      Math.abs(actualCenter.x - expectedCenter.x) <= centerTolerance,
      `panel ${index} center x ${actualCenter.x} should match ${expectedCenter.x}`,
    );
    assert.ok(
      Math.abs(actualCenter.y - expectedCenter.y) <= centerTolerance,
      `panel ${index} center y ${actualCenter.y} should match ${expectedCenter.y}`,
    );
    const overlap = intersectionOverUnion(actual, expected);
    assert.ok(
      overlap >= minimumIntersectionOverUnion,
      `panel ${index} must tightly crop its VTH plot frame; IoU was ${overlap.toFixed(3)}`,
    );
  }
}

function assertRightSideContentExcluded(actualPanels) {
  assert.ok(
    actualPanels.every(
      (panel) => normalizedBounds(panel).right <= 1150,
    ),
    "only the left-side 4 × 5 VTH chart grid may be returned",
  );
  for (const distractor of RIGHT_SIDE_DISTRACTORS) {
    const center = centerOf(distractor.bounds);
    assert.ok(
      actualPanels.every(
        (panel) => !containsPoint(panel, center),
      ),
      `${distractor.type} must not be returned as a distribution panel`,
    );
  }
}

test("uses the white document canvas instead of the one-pixel grey slide border as background", () => {
  const decoded = decodePng(sampleBytes);
  const digest = createHash("sha256")
    .update(sampleBytes)
    .digest("hex");
  const foreground = buildForegroundMasks(
    decoded.data,
    decoded.width,
    decoded.height,
    decoded.channels,
  );
  const foregroundRatio =
    foreground.broadMask.reduce(
      (sum, value) => sum + value,
      0,
    ) /
    (decoded.width * decoded.height);

  assert.equal(decoded.width, 1672);
  assert.equal(decoded.height, 941);
  assert.equal(sampleBytes.length, 1_519_222);
  assert.equal(digest, EXPECTED_SHA256);
  assert.equal(foreground.backgroundSource, "document-mode");
  assert.ok(
    foreground.background.every((value) => value >= 245),
    `expected a near-white canvas background, received ${foreground.background.join(",")}`,
  );
  assert.ok(
    foregroundRatio >= 0.07 && foregroundRatio <= 0.18,
    `document foreground ratio ${foregroundRatio.toFixed(4)} must not include the white canvas`,
  );
});

test("extracts exactly the twenty VTH panels and rejects the explanation, table, and RBER plot", () => {
  const decoded = decodePng(sampleBytes);
  const result = detectChartPanels(
    decoded.data,
    decoded.width,
    decoded.height,
    decoded.channels,
  );

  assert.equal(result.fallbackUsed, false);
  assert.equal(result.detectedPanelCount, 20);
  assert.equal(result.panels.length, 20);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.layout, { rows: 4, columns: 5 });
  assert.ok(
    result.rejectedNonChartCount >= 3,
    "the slide must record rejected non-distribution candidates",
  );
  assertMatchesTwentyPanelGrid(result.panels);
  assertRightSideContentExcluded(result.panels);
});

test("similarity API analyzes every colored eight-State VTH panel as one distribution", async () => {
  const response = await searchSimilarityImage({
    bytes: sampleBytes,
    mimeType: "image/png",
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });

  assert.equal(response.panelCount, 20);
  assert.equal(response.panelDetection.detectedPanelCount, 20);
  assert.equal(response.panelDetection.analyzedPanelCount, 20);
  assert.equal(response.panelDetection.fallbackUsed, false);
  assert.equal(response.panelDetection.truncated, false);
  assert.deepEqual(response.panelLayout, { rows: 4, columns: 5 });
  assertMatchesTwentyPanelGrid(
    response.panels.map(({ bounds }) => bounds.source),
    {
      centerTolerance: 14,
      minimumIntersectionOverUnion: 0.62,
    },
  );
  assertRightSideContentExcluded(
    response.panels.map(({ bounds }) => bounds.source),
  );
  assert.equal(
    response.panels.reduce(
      (total, panel) => total + panel.seriesCount,
      0,
    ),
    20,
    "State-segment colors must not become 160 independent full-span series",
  );
  for (const panel of response.panels) {
    assert.equal(panel.seriesCount, 1);
    assert.equal(panel.series.length, 1);
    assert.equal(panel.selectedSeriesIndex, 0);
    assert.equal(panel.query.stateCount, 8);
    assert.ok(
      panel.query.observedStateCount >= 6,
      `panel ${panel.panelIndex} should preserve the eight-State peak sequence`,
    );
    assert.ok(
      ["chromatic-union", "single"].includes(
        panel.series[0].separationMode,
      ),
      `panel ${panel.panelIndex} should merge State-segment colors`,
    );
    assert.equal(panel.series[0].results.length, 1);
    assert.deepEqual(panel.query, panel.series[0].query);
    assert.deepEqual(panel.results, panel.series[0].results);
  }
});
