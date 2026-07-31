import assert from "node:assert/strict";
import test from "node:test";

import { encode as encodePng } from "fast-png";

import {
  detectChartPanels,
} from "../lib/vth-chart-panel-core.mjs";
import {
  searchSimilarityImage,
} from "../lib/vth-similarity-api-core.mjs";
import {
  largeTextOnlyFixtures,
} from "./helpers/large-text-waveform-fixtures.mjs";
import {
  multiChartPlacementSizeMatrixFixtures,
} from "./helpers/multi-chart-placement-size-matrix-fixtures.mjs";
import {
  tinyColoredTableFixture,
} from "./helpers/tiny-multichart-fixtures.mjs";

const EMPTY_CORPUS = Object.freeze({
  version: "placement-size-matrix",
  yScale: "log",
  candidates: Object.freeze([]),
});

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

function boundsArea(bounds) {
  const normalized = normalizedBounds(bounds);
  return (
    Math.max(0, normalized.right - normalized.left + 1) *
    Math.max(0, normalized.bottom - normalized.top + 1)
  );
}

function intersectionArea(first, second) {
  const a = normalizedBounds(first);
  const b = normalizedBounds(second);
  return (
    Math.max(
      0,
      Math.min(a.right, b.right) -
        Math.max(a.left, b.left) +
        1,
    ) *
    Math.max(
      0,
      Math.min(a.bottom, b.bottom) -
        Math.max(a.top, b.top) +
        1,
    )
  );
}

function center(bounds) {
  const normalized = normalizedBounds(bounds);
  return {
    x: (normalized.left + normalized.right) / 2,
    y: (normalized.top + normalized.bottom) / 2,
  };
}

function minimumBlankGap(charts) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let firstIndex = 0; firstIndex < charts.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < charts.length;
      secondIndex += 1
    ) {
      const first = charts[firstIndex].bounds;
      const second = charts[secondIndex].bounds;
      const horizontal = Math.max(
        0,
        Math.max(first.left, second.left) -
          Math.min(first.right, second.right) -
          1,
      );
      const vertical = Math.max(
        0,
        Math.max(first.top, second.top) -
          Math.min(first.bottom, second.bottom) -
          1,
      );
      minimum = Math.min(
        minimum,
        Math.hypot(horizontal, vertical),
      );
    }
  }
  return minimum;
}

function maximumOneToOnePhysicalMatching(actual, expected) {
  const adjacency = expected.map((expectedBounds) => {
    const expectedCenter = center(expectedBounds);
    const expectedArea = boundsArea(expectedBounds);
    const minimumDimension = Math.min(
      expectedBounds.right - expectedBounds.left + 1,
      expectedBounds.bottom - expectedBounds.top + 1,
    );
    return actual
      .map((actualBounds, actualIndex) => {
        const actualCenter = center(actualBounds);
        const overlap = intersectionArea(
          actualBounds,
          expectedBounds,
        );
        const centerDistance = Math.hypot(
          actualCenter.x - expectedCenter.x,
          actualCenter.y - expectedCenter.y,
        );
        return {
          actualIndex,
          valid:
            overlap / Math.max(1, expectedArea) >= 0.52 &&
            centerDistance <=
              Math.max(8, minimumDimension * 0.32),
          overlap,
          centerDistance,
        };
      })
      .filter(({ valid }) => valid)
      .sort(
        (first, second) =>
          second.overlap - first.overlap ||
          first.centerDistance - second.centerDistance,
      );
  });
  const expectedForActual = new Array(actual.length).fill(-1);
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
    expectedIndex < expected.length;
    expectedIndex += 1
  ) {
    if (assign(expectedIndex, new Set())) {
      matchedExpected.add(expectedIndex);
    }
  }
  return {
    matchedCount: matchedExpected.size,
    missedExpectedIndexes: expected
      .map((_bounds, index) => index)
      .filter((index) => !matchedExpected.has(index)),
    unmatchedActualIndexes: expectedForActual
      .map((expectedIndex, index) => ({
        expectedIndex,
        index,
      }))
      .filter(({ expectedIndex }) => expectedIndex === -1)
      .map(({ index }) => index),
    expectedIndexesByActual: expectedForActual,
  };
}

test("position and size cross-matrix keeps every physical chart exactly once", () => {
  const fixtures = multiChartPlacementSizeMatrixFixtures();
  assert.deepEqual(
    fixtures.map(({ expectedChartCount }) => expectedChartCount),
    [2, 4, 6, 8, 12, 12, 20, 30],
  );
  assert.deepEqual(
    fixtures.map(({ width, height }) => `${width}x${height}`),
    [
      "400x225",
      "800x450",
      "1024x768",
      "1280x720",
      "1280x720",
      "1280x720",
      "1600x900",
      "1920x1080",
    ],
  );
  const tightFixture = fixtures.find(({ name }) =>
    name.includes("small-gap"),
  );
  assert.ok(
    minimumBlankGap(tightFixture.charts) <= 2,
    "the matrix must retain a one-to-two blank-pixel chart gutter",
  );
  const edgeFixture = fixtures.find(({ name }) =>
    name.includes("edge-anchored"),
  );
  assert.ok(
    edgeFixture.charts.some(({ bounds }) => bounds.left === 0) &&
      edgeFixture.charts.some(
        ({ bounds }) => bounds.right === edgeFixture.width - 1,
      ) &&
      edgeFixture.charts.some(({ bounds }) => bounds.top === 0) &&
      edgeFixture.charts.some(
        ({ bounds }) =>
          bounds.bottom === edgeFixture.height - 1,
      ),
    "the edge case must physically touch all four document edges",
  );
  const rotationFixture = fixtures.find(({ name }) =>
    name.includes("mixed-three-degree"),
  );
  assert.deepEqual(
    [...new Set(rotationFixture.charts.map(({ angle }) => angle))],
    [-3, 0, 3],
  );
  const heterogeneousFixture = fixtures.find(({ name }) =>
    name.includes("twenty-scattered"),
  );
  const heterogeneousAreas = heterogeneousFixture.charts.map(
    ({ bounds }) => boundsArea(bounds),
  );
  assert.ok(
    Math.max(...heterogeneousAreas) /
      Math.min(...heterogeneousAreas) >=
      1.7,
    "the matrix must retain a substantial physical size range",
  );
  for (const fixture of fixtures) {
    const detected = detectChartPanels(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
    );
    const expectedBounds = fixture.charts.map(
      ({ bounds }) => bounds,
    );
    const matching = maximumOneToOnePhysicalMatching(
      detected.panels,
      expectedBounds,
    );
    assert.equal(
      detected.panels.length,
      fixture.expectedChartCount,
      `${fixture.name}: exact detection count`,
    );
    assert.equal(
      matching.matchedCount,
      fixture.expectedChartCount,
      `${fixture.name}: missed GT indexes ${JSON.stringify(
        matching.missedExpectedIndexes,
      )}`,
    );
    assert.deepEqual(
      matching.unmatchedActualIndexes,
      [],
      `${fixture.name}: every result must match one physical chart`,
    );
    assert.equal(
      detected.fallbackUsed,
      false,
      `${fixture.name}: whole-image fallback is not a panel match`,
    );
  }
});

test("placement recovery does not promote colored tables or large text sentinels", () => {
  const negatives = [
    tinyColoredTableFixture(),
    ...largeTextOnlyFixtures(),
  ];
  for (const fixture of negatives) {
    const detected = detectChartPanels(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
    );
    assert.equal(
      detected.panels.length,
      0,
      `${fixture.name ?? "negative sentinel"} must stay excluded`,
    );
    assert.equal(detected.fallbackUsed, false);
  }
});

test("search API preserves edge, tight-gap, rotated, variable-size, and FHD layouts one-to-one", async () => {
  const fixtures =
    multiChartPlacementSizeMatrixFixtures();
  for (const fixture of [
    fixtures[0],
    fixtures[4],
    fixtures[5],
    fixtures[6],
    fixtures[7],
  ]) {
    const bytes = encodePng({
      width: fixture.width,
      height: fixture.height,
      channels: fixture.channels,
      depth: 8,
      data: fixture.pixels,
    });
    const response = await searchSimilarityImage({
      bytes,
      mimeType: "image/png",
      topK: 1,
      corpus: EMPTY_CORPUS,
      origin: "http://127.0.0.1:4173",
    });
    const matching = maximumOneToOnePhysicalMatching(
      response.panels.map((panel) => panel.bounds.source),
      fixture.charts.map(({ bounds }) => bounds),
    );
    assert.equal(
      response.panelCount,
      fixture.expectedChartCount,
      `${fixture.name}: API panel count`,
    );
    assert.equal(
      matching.matchedCount,
      fixture.expectedChartCount,
      `${fixture.name}: API missed ${JSON.stringify(
        matching.missedExpectedIndexes,
      )}`,
    );
    assert.deepEqual(
      matching.unmatchedActualIndexes,
      [],
      `${fixture.name}: API returned a non-physical duplicate`,
    );
    const expectedChartsInPanelOrder =
      matching.expectedIndexesByActual.map(
        (expectedIndex) => fixture.charts[expectedIndex],
      );
    assert.deepEqual(
      response.panels.map(
        (panel) => panel.descriptor.peakLocations.length,
      ),
      expectedChartsInPanelOrder.map(
        ({ peakCount }) => peakCount,
      ),
      `${fixture.name}: placement recovery must preserve every physical peak`,
    );
    assert.deepEqual(
      response.panels.map(
        (panel) => panel.descriptor.valleyLocations.length,
      ),
      expectedChartsInPanelOrder.map(
        ({ expectedValleyCount }) => expectedValleyCount,
      ),
      `${fixture.name}: placement recovery must preserve every adjacent valley`,
    );
    assert.ok(
      response.panels.every(
        (panel) => panel.descriptor.regularized !== true,
      ),
      `${fixture.name}: no panel may receive synthetic State regularization`,
    );
  }
});
