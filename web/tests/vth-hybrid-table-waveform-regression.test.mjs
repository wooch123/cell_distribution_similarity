import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  detectChartPanels,
} from "../lib/vth-chart-panel-core.mjs";
import {
  extractUpperArcPeakEvidence,
} from "../lib/vth-image-analysis-core.mjs";
import {
  buildForegroundMasks,
} from "../lib/vth-image-core.mjs";
import {
  searchSimilarityImage,
} from "../lib/vth-similarity-api-core.mjs";
import {
  hybridTableFarSeparatedPeakFixture,
  hybridTableMultipleFarSeparatedPeakFixture,
  hybridTableVthAndKpiLatticeBoundaryFixtures,
  hybridTableWaveformFixture,
  isolatedTableFarSeparatedPeakFixture,
  leftHalfHybridTableDeepAndModerateVthFixture,
  leftHalfHybridTableMultipleFarSeparatedPeakFixture,
  leftHalfHybridTableVthAndKpiFixture,
} from "./helpers/hybrid-table-waveform-fixture.mjs";

const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

function normalizeBounds(bounds) {
  if ("left" in bounds) return bounds;
  return {
    left: bounds.x,
    top: bounds.y,
    right: bounds.x + bounds.width - 1,
    bottom: bounds.y + bounds.height - 1,
  };
}

function boundsArea(bounds) {
  const value = normalizeBounds(bounds);
  return (
    (value.right - value.left + 1) *
    (value.bottom - value.top + 1)
  );
}

function intersectionArea(first, second) {
  const a = normalizeBounds(first);
  const b = normalizeBounds(second);
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

function cropRgb(fixture, bounds) {
  const width = bounds.right - bounds.left + 1;
  const height = bounds.bottom - bounds.top + 1;
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const sourceOffset =
      ((bounds.top + y) * fixture.width + bounds.left) * 3;
    pixels.set(
      fixture.pixels.subarray(
        sourceOffset,
        sourceOffset + width * 3,
      ),
      y * width * 3,
    );
  }
  return { pixels, width, height };
}

function maximumOneToOneMatching(actualPanels, expectedCharts) {
  const adjacency = expectedCharts.map((chart) =>
    actualPanels
      .map((panel, panelIndex) => {
        const overlap = intersectionArea(
          panel.bounds.source,
          chart.bounds,
        );
        return {
          panelIndex,
          overlap,
          valid:
            overlap / Math.max(1, boundsArea(chart.bounds)) >=
            0.7,
        };
      })
      .filter(({ valid }) => valid)
      .sort(
        (first, second) => second.overlap - first.overlap,
      ),
  );
  const expectedForPanel = new Array(
    actualPanels.length,
  ).fill(-1);

  function assign(expectedIndex, visited) {
    for (const { panelIndex } of adjacency[expectedIndex]) {
      if (visited.has(panelIndex)) continue;
      visited.add(panelIndex);
      if (
        expectedForPanel[panelIndex] === -1 ||
        assign(expectedForPanel[panelIndex], visited)
      ) {
        expectedForPanel[panelIndex] = expectedIndex;
        return true;
      }
    }
    return false;
  }

  let matchedCount = 0;
  for (
    let expectedIndex = 0;
    expectedIndex < expectedCharts.length;
    expectedIndex += 1
  ) {
    if (assign(expectedIndex, new Set())) matchedCount += 1;
  }
  return {
    matchedCount,
    unmatchedPanelCount: expectedForPanel.filter(
      (expectedIndex) => expectedIndex === -1,
    ).length,
  };
}

test("hybrid table fixture deterministically mixes merged, unequal, text, numeric, empty, and waveform cells", () => {
  const fixture = hybridTableWaveformFixture();
  assert.deepEqual(
    [fixture.width, fixture.height],
    [1280, 720],
  );
  assert.equal(fixture.expectedChartCount, 8);
  assert.deepEqual(
    fixture.charts.map(
      ({ row, column, peakCount }) => [
        row,
        column,
        peakCount,
      ],
    ),
    [
      [0, 0, 1],
      [0, 2, 4],
      [0, 4, 2],
      [1, 1, 5],
      [1, 3, 3],
      [2, 0, 2],
      [2, 4, 4],
      [3, 2, 3],
    ],
  );
  assert.equal(
    createHash("sha256")
      .update(fixture.bytes)
      .digest("hex"),
    "984d8735410e2f9f8a45b8cec06528b6af2b8bd603c92234b2c2b5c1212f4e7c",
  );
});

test("all eight ground-truth table cells contain exact upper-arc topology", () => {
  const fixture = hybridTableWaveformFixture();
  for (const chart of fixture.charts) {
    const crop = cropRgb(fixture, chart.plotBounds);
    const masks = buildForegroundMasks(
      crop.pixels,
      crop.width,
      crop.height,
      3,
    );
    const topology = extractUpperArcPeakEvidence(
      masks.curveSalientMask,
      masks.curveSalientMask,
      masks.curveColorMasks,
      crop.width,
      crop.height,
      { minimumPeakCount: 1 },
    );
    assert.equal(
      topology.accepted,
      true,
      `cell ${chart.row}:${chart.column} must contain a valid waveform`,
    );
    assert.deepEqual(
      {
        peaks: topology.peakCount,
        valleys:
          topology.descriptor.valleyLocations.length,
      },
      {
        peaks: chart.peakCount,
        valleys: chart.expectedValleyCount,
      },
      `cell ${chart.row}:${chart.column} fixture topology drifted`,
    );
  }
});

test("a completely separated valley remains one two-peak distribution inside a table cell", async () => {
  const fixture = hybridTableFarSeparatedPeakFixture();
  const targetCrop = cropRgb(
    fixture,
    fixture.farSeparatedTarget.plotBounds,
  );
  const masks = buildForegroundMasks(
    targetCrop.pixels,
    targetCrop.width,
    targetCrop.height,
    3,
  );
  const topology = extractUpperArcPeakEvidence(
    masks.curveSalientMask,
    masks.curveSalientMask,
    masks.curveColorMasks,
    targetCrop.width,
    targetCrop.height,
    { minimumPeakCount: 1 },
  );
  assert.deepEqual(
    {
      accepted: topology.accepted,
      peaks: topology.peakCount,
      valleys: topology.descriptor?.valleyLocations.length,
    },
    {
      accepted: true,
      peaks: 2,
      valleys: 1,
    },
    "fixture must contain two source-measured lobes owned by one chart frame",
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });
  assert.deepEqual(
    {
      panelCount: response.panelCount,
      peakCounts: response.panels.map(
        (panel) => panel.descriptor.peakLocations.length,
      ),
      valleyCounts: response.panels.map(
        (panel) => panel.descriptor.valleyLocations.length,
      ),
      observedStateCounts: response.panels.map(
        (panel) => panel.descriptor.observedStateCount,
      ),
      regularized: response.panels.map(
        (panel) => panel.descriptor.regularized,
      ),
    },
    {
      panelCount: fixture.expectedChartCount,
      peakCounts: fixture.charts.map(
        (chart) => chart.peakCount,
      ),
      valleyCounts: fixture.charts.map(
        (chart) => chart.expectedValleyCount,
      ),
      observedStateCounts: fixture.charts.map(
        (chart) => chart.peakCount,
      ),
      regularized: fixture.charts.map(() => false),
    },
    "the table grid must not split or discard a physically framed disconnected distribution",
  );
});

test("one far-separated distribution survives as the table's only waveform", async () => {
  const fixture = isolatedTableFarSeparatedPeakFixture();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.deepEqual(
    {
      panelCount: response.panelCount,
      peakCounts: response.panels.map(
        (panel) => panel.descriptor.peakLocations.length,
      ),
      valleyCounts: response.panels.map(
        (panel) => panel.descriptor.valleyLocations.length,
      ),
      regularized: response.panels.map(
        (panel) => panel.descriptor.regularized,
      ),
    },
    {
      panelCount: 1,
      peakCounts: [2],
      valleyCounts: [1],
      regularized: [false],
    },
  );
});

test("three separated-lobe cells coexist with five ordinary charts in one table", async () => {
  const fixture =
    hybridTableMultipleFarSeparatedPeakFixture();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.deepEqual(
    {
      panelCount: response.panelCount,
      peakCounts: response.panels.map(
        (panel) => panel.descriptor.peakLocations.length,
      ),
      valleyCounts: response.panels.map(
        (panel) => panel.descriptor.valleyLocations.length,
      ),
    },
    {
      panelCount: fixture.expectedChartCount,
      peakCounts: fixture.charts.map(
        (chart) => chart.peakCount,
      ),
      valleyCounts: fixture.charts.map(
        (chart) => chart.expectedValleyCount,
      ),
    },
  );
});

test("detector keeps all eight table-contained distributions when the table occupies the left half of a slide", () => {
  const fixture =
    leftHalfHybridTableMultipleFarSeparatedPeakFixture();
  const detected = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  const normalizedPanels = detected.panels.map((panel) => ({
    bounds: {
      source: {
        left: panel.x,
        top: panel.y,
        right: panel.x + panel.width - 1,
        bottom: panel.y + panel.height - 1,
      },
    },
  }));

  assert.equal(
    detected.detectedPanelCount,
    fixture.expectedChartCount,
  );
  assert.deepEqual(
    detected.diagnostics.mixedTableWaveformCohortProof,
    {
      applied: true,
      anchorCount: fixture.expectedChartCount,
      recoveredCount: 0,
    },
    "overlapping spatial proposals must not inflate mixed-table recovery diagnostics",
  );
  assert.deepEqual(
    maximumOneToOneMatching(
      normalizedPanels,
      fixture.charts,
    ),
    {
      matchedCount: fixture.expectedChartCount,
      unmatchedPanelCount: 0,
    },
  );
});

test("API keeps exact topology for a hybrid table occupying the left half of a slide", async () => {
  const fixture =
    leftHalfHybridTableMultipleFarSeparatedPeakFixture();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.deepEqual(
    {
      panelCount: response.panelCount,
      peakCounts: response.panels.map(
        (panel) => panel.descriptor.peakLocations.length,
      ),
      valleyCounts: response.panels.map(
        (panel) => panel.descriptor.valleyLocations.length,
      ),
    },
    {
      panelCount: fixture.expectedChartCount,
      peakCounts: fixture.charts.map(
        (chart) => chart.peakCount,
      ),
      valleyCounts: fixture.charts.map(
        (chart) => chart.expectedValleyCount,
      ),
    },
  );
  assert.deepEqual(
    maximumOneToOneMatching(
      response.panels,
      fixture.charts,
    ),
    {
      matchedCount: fixture.expectedChartCount,
      unmatchedPanelCount: 0,
    },
  );
});

test("localized mixed-table proof keeps five moderate-floor VTH cells after three deep anchors", async () => {
  const fixture =
    leftHalfHybridTableDeepAndModerateVthFixture();
  assert.deepEqual(
    fixture.charts.map(
      ({ expectedContractClass }) =>
        expectedContractClass,
    ),
    [
      "localized",
      "accepted-only",
      "accepted-only",
      "accepted-only",
      "accepted-only",
      "accepted-only",
      "localized",
      "localized",
    ],
  );

  for (const chart of fixture.charts) {
    const crop = cropRgb(fixture, chart.plotBounds);
    const masks = buildForegroundMasks(
      crop.pixels,
      crop.width,
      crop.height,
      3,
    );
    const topology = extractUpperArcPeakEvidence(
      masks.curveSalientMask,
      masks.curveSalientMask,
      masks.curveColorMasks,
      crop.width,
      crop.height,
      { minimumPeakCount: 1 },
    );
    assert.deepEqual(
      {
        accepted: topology.accepted,
        peaks: topology.peakCount,
        valleys:
          topology.descriptor?.valleyLocations.length,
        regularized:
          topology.descriptor?.regularized,
      },
      {
        accepted: true,
        peaks: chart.peakCount,
        valleys: chart.expectedValleyCount,
        regularized: false,
      },
      `cell ${chart.row}:${chart.column} must remain a directly measured VTH distribution`,
    );
    const edgeSampleCount = Math.max(
      3,
      Math.round(topology.profile.length * 0.06),
    );
    const mean = (values) =>
      values.reduce((sum, value) => sum + value, 0) /
      Math.max(1, values.length);
    const leftFloor = mean(
      topology.profile.slice(0, edgeSampleCount),
    );
    const rightFloor = mean(
      topology.profile.slice(-edgeSampleCount),
    );
    const sampleProfile = (location) =>
      topology.profile[
        Math.max(
          0,
          Math.min(
            topology.profile.length - 1,
            Math.round(
              location * (topology.profile.length - 1),
            ),
          ),
        )
      ];
    assert.ok(
      topology.descriptor.peakLocations
        .map(sampleProfile)
        .every((height) => height >= 0.72),
      `cell ${chart.row}:${chart.column} must retain high physical peaks`,
    );
    assert.ok(
      topology.descriptor.valleyLocations
        .map(sampleProfile)
        .every((height) => height <= 0.58),
      `cell ${chart.row}:${chart.column} must retain intervening density-floor valleys`,
    );
    if (chart.expectedContractClass === "localized") {
      assert.ok(
        leftFloor <= 0.35 && rightFloor <= 0.35,
        `cell ${chart.row}:${chart.column} must satisfy the deep localized endpoint gate`,
      );
    } else {
      assert.ok(
        leftFloor > 0.35 &&
          leftFloor <= 0.66 &&
          rightFloor > 0.35 &&
          rightFloor <= 0.66,
        `cell ${chart.row}:${chart.column} must satisfy accepted-only moderate endpoints`,
      );
    }
    const colorUnion = new Uint8Array(
      crop.width * crop.height,
    );
    for (const colorMask of masks.curveColorMasks) {
      for (
        let index = 0;
        index < colorUnion.length;
        index += 1
      ) {
        colorUnion[index] ||= colorMask[index];
      }
    }
    let top = crop.height;
    let bottom = -1;
    for (
      let index = 0;
      index < colorUnion.length;
      index += 1
    ) {
      if (!colorUnion[index]) continue;
      const y = Math.floor(index / crop.width);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    assert.ok(
      bottom / Math.max(1, crop.height - 1) >= 0.72 &&
        (bottom - top + 1) / crop.height >= 0.48,
      `cell ${chart.row}:${chart.column} must physically reach and span the distribution floor`,
    );
  }

  const detected = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });
  assert.deepEqual(
    {
      detectorPanelCount: detected.detectedPanelCount,
      apiPanelCount: response.panelCount,
      peakCounts: response.panels.map(
        (panel) =>
          panel.descriptor.peakLocations.length,
      ),
      valleyCounts: response.panels.map(
        (panel) =>
          panel.descriptor.valleyLocations.length,
      ),
      regularized: response.panels.map(
        (panel) => panel.descriptor.regularized,
      ),
      matching: maximumOneToOneMatching(
        response.panels,
        fixture.charts,
      ),
    },
    {
      detectorPanelCount: fixture.expectedChartCount,
      apiPanelCount: fixture.expectedChartCount,
      peakCounts: fixture.charts.map(
        (chart) => chart.peakCount,
      ),
      valleyCounts: fixture.charts.map(
        (chart) => chart.expectedValleyCount,
      ),
      regularized: fixture.charts.map(() => false),
      matching: {
        matchedCount: fixture.expectedChartCount,
        unmatchedPanelCount: 0,
      },
    },
  );
});

test("localized-table detector keeps three VTH cells and rejects five framed KPI sine charts", () => {
  const fixture = leftHalfHybridTableVthAndKpiFixture();
  const detected = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  const normalizedPanels = detected.panels.map((panel) => ({
    bounds: {
      source: {
        left: panel.x,
        top: panel.y,
        right: panel.x + panel.width - 1,
        bottom: panel.y + panel.height - 1,
      },
    },
  }));

  assert.equal(
    detected.detectedPanelCount,
    fixture.expectedChartCount,
  );
  assert.deepEqual(
    maximumOneToOneMatching(
      normalizedPanels,
      fixture.charts,
    ),
    {
      matchedCount: fixture.expectedChartCount,
      unmatchedPanelCount: 0,
    },
  );
});

test("localized-table API returns only three exact VTH cells beside framed KPI sine charts", async () => {
  const fixture = leftHalfHybridTableVthAndKpiFixture();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.deepEqual(
    {
      panelCount: response.panelCount,
      peakCounts: response.panels.map(
        (panel) => panel.descriptor.peakLocations.length,
      ),
      valleyCounts: response.panels.map(
        (panel) => panel.descriptor.valleyLocations.length,
      ),
    },
    {
      panelCount: fixture.expectedChartCount,
      peakCounts: fixture.charts.map(
        (chart) => chart.peakCount,
      ),
      valleyCounts: fixture.charts.map(
        (chart) => chart.expectedValleyCount,
      ),
    },
  );
  assert.deepEqual(
    maximumOneToOneMatching(
      response.panels,
      fixture.charts,
    ),
    {
      matchedCount: fixture.expectedChartCount,
      unmatchedPanelCount: 0,
    },
  );
});

for (const fixture of
  hybridTableVthAndKpiLatticeBoundaryFixtures()) {
  const percentage = Math.round(
    fixture.targetLatticeRatio * 100,
  );
  test(`${percentage}% lattice keeps three exact VTH cells and rejects five KPI sine charts`, async () => {
    const detected = detectChartPanels(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
    );
    const latticeBounds =
      detected.diagnostics.tableLatticeDominant
        .axisAlignedBounds;
    assert.ok(
      latticeBounds,
      `${percentage}% case must retain its table lattice`,
    );
    const measuredLatticeRatio =
      boundsArea(latticeBounds) /
      (fixture.width * fixture.height);
    assert.ok(
      Math.abs(
        measuredLatticeRatio -
          fixture.targetLatticeRatio,
      ) <= 0.001,
      `${percentage}% fixture measured ${(measuredLatticeRatio * 100).toFixed(3)}%`,
    );

    const response = await searchSimilarityImage({
      bytes: fixture.bytes,
      mimeType: fixture.mimeType,
      topK: 1,
      corpus: publicCorpus,
      origin: "http://127.0.0.1:4173",
    });
    assert.deepEqual(
      {
        detectorPanelCount: detected.detectedPanelCount,
        apiPanelCount: response.panelCount,
        peakCounts: response.panels.map(
          (panel) =>
            panel.descriptor.peakLocations.length,
        ),
        valleyCounts: response.panels.map(
          (panel) =>
            panel.descriptor.valleyLocations.length,
        ),
        regularized: response.panels.map(
          (panel) => panel.descriptor.regularized,
        ),
        matching: maximumOneToOneMatching(
          response.panels,
          fixture.charts,
        ),
      },
      {
        detectorPanelCount: fixture.expectedChartCount,
        apiPanelCount: fixture.expectedChartCount,
        peakCounts: fixture.charts.map(
          (chart) => chart.peakCount,
        ),
        valleyCounts: fixture.charts.map(
          (chart) => chart.expectedValleyCount,
        ),
        regularized: fixture.charts.map(() => false),
        matching: {
          matchedCount: fixture.expectedChartCount,
          unmatchedPanelCount: 0,
        },
      },
    );
  });
}

test("API returns only the eight waveform cells with exact reading-order topology and physical crops", async () => {
  const fixture = hybridTableWaveformFixture();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.deepEqual(
    {
      panelCount: response.panelCount,
      peakCounts: response.panels.map(
        (panel) => panel.descriptor.peakLocations.length,
      ),
      valleyCounts: response.panels.map(
        (panel) => panel.descriptor.valleyLocations.length,
      ),
      observedStateCounts: response.panels.map(
        (panel) => panel.descriptor.observedStateCount,
      ),
      regularized: response.panels.map(
        (panel) => panel.descriptor.regularized,
      ),
    },
    {
      panelCount: fixture.expectedChartCount,
      peakCounts: fixture.charts.map(
        (chart) => chart.peakCount,
      ),
      valleyCounts: fixture.charts.map(
        (chart) => chart.expectedValleyCount,
      ),
      observedStateCounts: fixture.charts.map(
        (chart) => chart.peakCount,
      ),
      regularized: fixture.charts.map(() => false),
    },
    "table structure and non-chart cells must neither hide nor imitate distributions",
  );

  const matching = maximumOneToOneMatching(
    response.panels,
    fixture.charts,
  );
  assert.deepEqual(
    matching,
    {
      matchedCount: fixture.expectedChartCount,
      unmatchedPanelCount: 0,
    },
    "each API panel must bind one-to-one to a physical waveform frame",
  );
});
