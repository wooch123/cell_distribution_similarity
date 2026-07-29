import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import { detectChartPanels } from "../lib/vth-chart-panel-core.mjs";
import { searchSimilarityImage } from "../lib/vth-similarity-api-core.mjs";
import {
  fhdUnconstrainedWaveformFixture,
} from "./helpers/fhd-unconstrained-waveform-fixture.mjs";

const sourceSlide = decodePng(
  await readFile(
    new URL(
      "./fixtures/qlc-read-disturb-20-chart-slide.png",
      import.meta.url,
    ),
  ),
);
const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

const FIXTURE_SHA256 =
  "83c44f3ce056cf8590ca9115452c2170e678734b43577967d6b935bb9ef21226";

function normalizedBounds(bounds) {
  return "x" in bounds
    ? {
        left: bounds.x,
        top: bounds.y,
        right: bounds.x + bounds.width - 1,
        bottom: bounds.y + bounds.height - 1,
      }
    : bounds;
}

function boundsWidth(bounds) {
  const normalized = normalizedBounds(bounds);
  return normalized.right - normalized.left + 1;
}

function boundsHeight(bounds) {
  const normalized = normalizedBounds(bounds);
  return normalized.bottom - normalized.top + 1;
}

function boundsArea(bounds) {
  return boundsWidth(bounds) * boundsHeight(bounds);
}

function centerOf(bounds) {
  const normalized = normalizedBounds(bounds);
  return {
    x: (normalized.left + normalized.right) / 2,
    y: (normalized.top + normalized.bottom) / 2,
  };
}

function intersectionArea(first, second) {
  const a = normalizedBounds(first);
  const b = normalizedBounds(second);
  return (
    Math.max(
      0,
      Math.min(a.right, b.right) - Math.max(a.left, b.left) + 1,
    ) *
    Math.max(
      0,
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + 1,
    )
  );
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

function acceptableMatch(actual, expected) {
  const expectedWidth = boundsWidth(expected);
  const expectedHeight = boundsHeight(expected);
  const minimumDimension = Math.min(expectedWidth, expectedHeight);
  const expectedArea = boundsArea(expected);
  const actualArea = boundsArea(actual);
  const intersection = intersectionArea(actual, expected);
  const expectedCoverage = intersection / Math.max(1, expectedArea);
  const actualCoverage = intersection / Math.max(1, actualArea);
  const expectedCenter = centerOf(expected);
  const actualCenter = centerOf(actual);
  const centerDistance = Math.hypot(
    actualCenter.x - expectedCenter.x,
    actualCenter.y - expectedCenter.y,
  );
  const maximumCenterDistance = Math.max(
    4,
    minimumDimension * 0.22,
  );
  const minimumExpectedCoverage =
    minimumDimension <= 40
      ? 0.52
      : minimumDimension <= 55
        ? 0.56
        : 0.62;
  const minimumActualCoverage =
    minimumDimension <= 40 ? 0.45 : 0.52;

  return {
    valid:
      centerDistance <= maximumCenterDistance &&
      expectedCoverage >= minimumExpectedCoverage &&
      actualCoverage >= minimumActualCoverage,
    expectedCoverage,
    actualCoverage,
    centerDistance,
  };
}

function maximumGroundTruthMatching(actualBounds, expectedCharts) {
  const adjacency = expectedCharts.map(({ bounds }) =>
    actualBounds
      .map((actual, actualIndex) => ({
        actualIndex,
        ...acceptableMatch(actual, bounds),
      }))
      .filter(({ valid }) => valid)
      .sort(
        (first, second) =>
          second.expectedCoverage - first.expectedCoverage ||
          second.actualCoverage - first.actualCoverage ||
          first.centerDistance - second.centerDistance,
      ),
  );
  const expectedForActual = new Array(actualBounds.length).fill(-1);

  function assign(expectedIndex, visitedActual) {
    for (const { actualIndex } of adjacency[expectedIndex]) {
      if (visitedActual.has(actualIndex)) continue;
      visitedActual.add(actualIndex);
      if (
        expectedForActual[actualIndex] === -1 ||
        assign(expectedForActual[actualIndex], visitedActual)
      ) {
        expectedForActual[actualIndex] = expectedIndex;
        return true;
      }
    }
    return false;
  }

  const matchedExpected = new Set();
  for (
    let expectedIndex = 0;
    expectedIndex < expectedCharts.length;
    expectedIndex += 1
  ) {
    if (assign(expectedIndex, new Set())) {
      matchedExpected.add(expectedIndex);
    }
  }

  return {
    matchedCount: matchedExpected.size,
    missedExpectedIndexes: expectedCharts
      .map((_chart, index) => index)
      .filter((index) => !matchedExpected.has(index)),
    unmatchedActualIndexes: expectedForActual
      .map((expectedIndex, index) => ({ expectedIndex, index }))
      .filter(({ expectedIndex }) => expectedIndex === -1)
      .map(({ index }) => index),
  };
}

function assertOnlyGroundTruthWaveforms(
  actualBounds,
  fixture,
  label,
) {
  const matching = maximumGroundTruthMatching(
    actualBounds,
    fixture.charts,
  );
  assert.equal(
    matching.matchedCount,
    fixture.expectedChartCount,
    `${label}: matched ${matching.matchedCount}/${fixture.expectedChartCount}; missed GT [${matching.missedExpectedIndexes.join(", ")}], unmatched detections [${matching.unmatchedActualIndexes.join(", ")}]`,
  );
  assert.equal(
    actualBounds.length,
    fixture.expectedChartCount,
    `${label}: false split/merge/positive changed the expected panel count`,
  );

  for (const distractor of fixture.distractors) {
    const center = centerOf(distractor.bounds);
    assert.ok(
      actualBounds.every((bounds) => !containsPoint(bounds, center)),
      `${label}: ${distractor.type} center must be excluded`,
    );
    assert.ok(
      actualBounds.every(
        (bounds) =>
          intersectionArea(bounds, distractor.bounds) /
            Math.max(
              1,
              Math.min(
                boundsArea(bounds),
                boundsArea(distractor.bounds),
              ),
            ) <
          0.3,
      ),
      `${label}: ${distractor.type} must not substantially overlap a waveform crop`,
    );
  }
}

function minimumBlankHorizontalGutter(charts) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let firstIndex = 0; firstIndex < charts.length; firstIndex += 1) {
    const first = charts[firstIndex].bounds;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < charts.length;
      secondIndex += 1
    ) {
      const second = charts[secondIndex].bounds;
      const verticalOverlap =
        Math.min(first.bottom, second.bottom) -
        Math.max(first.top, second.top) +
        1;
      if (verticalOverlap <= 0) continue;
      if (first.right < second.left) {
        minimum = Math.min(
          minimum,
          second.left - first.right - 1,
        );
      } else if (second.right < first.left) {
        minimum = Math.min(
          minimum,
          first.left - second.right - 1,
        );
      }
    }
  }
  return minimum;
}

test("FHD fixture deterministically spans unconstrained positions and 48 by 35 through 315 by 205 chart sizes", () => {
  const fixture = fhdUnconstrainedWaveformFixture(sourceSlide);
  const sizes = new Set(
    fixture.charts.map(({ width, height }) => `${width}x${height}`),
  );

  assert.equal(fixture.width, 1920);
  assert.equal(fixture.height, 1080);
  assert.equal(fixture.expectedChartCount, 28);
  assert.equal(fixture.bytes.length, 488_357);
  assert.equal(
    createHash("sha256").update(fixture.bytes).digest("hex"),
    FIXTURE_SHA256,
  );
  for (const size of [
    "240x160",
    "190x140",
    "120x90",
    "95x70",
    "67x49",
    "48x35",
  ]) {
    assert.ok(sizes.has(size), `fixture must include ${size}`);
  }
  assert.equal(
    new Set(
      fixture.charts.map(({ sourcePanelIndex }) => sourcePanelIndex),
    ).size,
    20,
    "all twenty supplied real QLC plots must contribute to the FHD fixture",
  );
  assert.ok(
    new Set(
      fixture.charts.map(({ bounds }) => bounds.left),
    ).size >= 26,
  );
  assert.equal(
    new Set(
      fixture.charts.map(({ bounds }) => bounds.top),
    ).size,
    28,
  );
  assert.equal(minimumBlankHorizontalGutter(fixture.charts), 4);
  assert.ok(
    fixture.charts.some(
      ({ bounds }) => bounds.left === 0 && bounds.top === 0,
    ),
  );
  assert.ok(
    fixture.charts.some(({ bounds }) => bounds.right === 1919),
  );
  assert.ok(
    fixture.charts.some(({ bounds }) => bounds.bottom === 1079),
  );
  assert.ok(
    fixture.charts.some(
      ({ bounds }) =>
        bounds.right === 1919 && bounds.bottom === 1079,
    ),
  );
  assert.deepEqual(
    fixture.distractors.map(({ type }) => type),
    [
      "explanation-text-card",
      "dense-numeric-table",
      "process-diagram",
      "monotonic-line-chart",
    ],
  );
});

test("detector finds every variably sized waveform at arbitrary FHD coordinates and rejects distractors", () => {
  const fixture = fhdUnconstrainedWaveformFixture(sourceSlide);
  const startedAt = performance.now();
  const result = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.fallbackUsed, false);
  assert.equal(result.truncated, false);
  assertOnlyGroundTruthWaveforms(
    result.panels,
    fixture,
    "FHD detector",
  );
  assert.ok(
    elapsedMs < 12_000,
    `FHD unconstrained detection took ${elapsedMs.toFixed(1)} ms`,
  );
});

test("similarity API ranks every arbitrary FHD waveform independently without ranking distractors", async () => {
  const fixture = fhdUnconstrainedWaveformFixture(sourceSlide);
  const startedAt = performance.now();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  const elapsedMs = performance.now() - startedAt;
  const sourceBounds = response.panels.map(
    ({ bounds }) => bounds.source,
  );

  assert.equal(response.panelDetection.fallbackUsed, false);
  assert.equal(response.panelDetection.truncated, false);
  assertOnlyGroundTruthWaveforms(
    sourceBounds,
    fixture,
    "FHD similarity API",
  );
  assert.equal(response.panelCount, fixture.expectedChartCount);
  assert.equal(
    response.panelDetection.detectedPanelCount,
    fixture.expectedChartCount,
  );
  assert.equal(
    response.panelDetection.analyzedPanelCount,
    fixture.expectedChartCount,
  );
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.results.length === 1 &&
        panel.bounds.source.width > 0 &&
        panel.bounds.source.height > 0,
    ),
    "every separated waveform must receive one ranking",
  );
  const apiBudgetMs = process.env.CI ? 60_000 : 30_000;
  assert.ok(
    elapsedMs < apiBudgetMs,
    `FHD unconstrained API analysis took ${elapsedMs.toFixed(1)} ms (budget ${apiBudgetMs} ms)`,
  );
});
