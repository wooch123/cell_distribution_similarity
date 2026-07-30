import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  detectChartPanels,
  detectChartPanelsFromMask,
} from "../lib/vth-chart-panel-core.mjs";
import {
  SimilarityApiError,
  searchSimilarityImage,
  validateTrainingWaveformImage,
} from "../lib/vth-similarity-api-core.mjs";
import {
  SHARED_TRAINING_CONSENT_VERSION,
  validateSharedTrainingPayload,
} from "../lib/vth-shared-training-core.mjs";
import {
  denseGuideGridSingleChartFixture,
  grayscaleSharedBoundaryHalfCanvasLatticeFixture,
  guidedMultiPeakSparklineTextTableFixture,
  guidedSingleRowMultiPeakSparklineTextTableFixture,
  halfCanvasTablelikeWaveformFixtures,
  multiPeakSparklineTextTableFixture,
  sharedBoundaryHalfCanvasLatticeFixture,
  singlePeakSharedBoundaryHalfCanvasLatticeFixture,
  singleRowSharedBoundaryHalfCanvasLatticeFixture,
} from "./helpers/half-canvas-tablelike-waveform-fixtures.mjs";
import {
  uiScaledRgba,
} from "./helpers/ui-raster-scale.mjs";

const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

function normalizedBounds(bounds) {
  if ("left" in bounds) return bounds;
  if ("bounds" in bounds) {
    return normalizedBounds(bounds.bounds.source);
  }
  return {
    left: bounds.x,
    top: bounds.y,
    right: bounds.x + bounds.width - 1,
    bottom: bounds.y + bounds.height - 1,
  };
}

function boundsArea(bounds) {
  const normalized = normalizedBounds(bounds);
  return (
    (normalized.right - normalized.left + 1) *
    (normalized.bottom - normalized.top + 1)
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

function maximumMatching(actualBounds, charts) {
  const adjacency = charts.map((chart) => {
    const expectedCenter = center(chart.bounds);
    const expectedArea = boundsArea(chart.bounds);
    return actualBounds
      .map((actual, actualIndex) => {
        const actualCenter = center(actual);
        const overlap = intersectionArea(actual, chart.bounds);
        const centerDistance = Math.hypot(
          actualCenter.x - expectedCenter.x,
          actualCenter.y - expectedCenter.y,
        );
        const minimumDimension = Math.min(
          chart.bounds.right - chart.bounds.left + 1,
          chart.bounds.bottom - chart.bounds.top + 1,
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
  const expectedForActual = new Array(actualBounds.length).fill(-1);

  function assign(expectedIndex, visited) {
    for (const { actualIndex } of adjacency[expectedIndex]) {
      if (visited.has(actualIndex)) continue;
      visited.add(actualIndex);
      if (
        expectedForActual[actualIndex] === -1 ||
        assign(expectedForActual[actualIndex], visited)
      ) {
        expectedForActual[actualIndex] = expectedIndex;
        return true;
      }
    }
    return false;
  }

  let matchedCount = 0;
  for (
    let expectedIndex = 0;
    expectedIndex < charts.length;
    expectedIndex += 1
  ) {
    if (assign(expectedIndex, new Set())) matchedCount += 1;
  }
  return {
    matchedCount,
    unmatchedActualCount: expectedForActual.filter(
      (expectedIndex) => expectedIndex === -1,
    ).length,
  };
}

function assertOnlyExpectedCharts(actualBounds, fixture, boundary) {
  const matching = maximumMatching(actualBounds, fixture.charts);
  assert.equal(
    matching.matchedCount,
    fixture.expectedChartCount,
    `${fixture.name}/${boundary}: only ${matching.matchedCount}/${fixture.expectedChartCount} ground-truth waveforms were matched`,
  );
  assert.equal(
    actualBounds.length,
    fixture.expectedChartCount,
    `${fixture.name}/${boundary}: expected ${fixture.expectedChartCount} charts without table/text false positives`,
  );
  assert.equal(
    matching.unmatchedActualCount,
    0,
    `${fixture.name}/${boundary}: every detection must bind to a real waveform`,
  );

  for (const distractor of fixture.distractors) {
    if (distractor.type === "blank") continue;
    for (const actual of actualBounds) {
      const overlap = intersectionArea(actual, distractor.bounds);
      assert.ok(
        overlap / Math.max(1, boundsArea(actual)) < 0.08,
        `${fixture.name}/${boundary}: ${distractor.type} content leaked into a waveform crop`,
      );
    }
  }
}

const fixtures = halfCanvasTablelikeWaveformFixtures();
const sharedLatticeFixture =
  sharedBoundaryHalfCanvasLatticeFixture();
const grayscaleSharedLatticeFixture =
  grayscaleSharedBoundaryHalfCanvasLatticeFixture();
const singlePeakSharedLatticeFixture =
  singlePeakSharedBoundaryHalfCanvasLatticeFixture();
const singleRowSharedLatticeFixture =
  singleRowSharedBoundaryHalfCanvasLatticeFixture();
const sparklineTextTableFixture =
  multiPeakSparklineTextTableFixture();
const guidedSparklineTextTableFixture =
  guidedMultiPeakSparklineTextTableFixture();
const guidedSingleRowSparklineTextTableFixture =
  guidedSingleRowMultiPeakSparklineTextTableFixture();
const denseGuideGridSingleChartFixtures = [
  denseGuideGridSingleChartFixture(),
  denseGuideGridSingleChartFixture({ grayscaleCurve: true }),
  denseGuideGridSingleChartFixture({ nearFullImage: true }),
  denseGuideGridSingleChartFixture({
    grayscaleCurve: true,
    nearFullImage: true,
  }),
];
const FIXTURE_SHA256 = Object.freeze({
  "left-half-12":
    "90a1006be007d27db4df02085245a9d440728da9b434fa5dccea41a2eaa4e7c1",
  "right-half-10":
    "b6168c777f7bc10be94466bf126fa3000f229752b9a773f128e65e2e906ef4a4",
  "top-half-6":
    "16ab70352547a9885a81332a49372ceba817655079c31f847484364275ffdb59",
  "bottom-half-2":
    "3ab27469922e5e4dd52b6263c95d48e4c8ead959bbfdd266390f0d4b2db850c1",
  "left-half-shared-boundary-4x4":
    "b002eaff412d40b93a0d3a2f2018dcdedba749428d007570d5f3dc0e03aac699",
  "left-half-grayscale-shared-boundary-4x4":
    "ea569bed11bbb8e500c74bc708175967b10a4190d75dff1ed4ece688e07f1a44",
  "left-half-single-peak-shared-boundary-4x4":
    "287251d31cd7add847d1c82292913abc4a948b0bf5595e25ef2364f62ea682b4",
  "left-half-single-row-shared-boundary-1x4":
    "8d8fa328a81217e5f23122c8e0d391214b3d27af5a794890b0175c1a20f5f55b",
  "left-half-4x4-multi-peak-sparkline-text-table":
    "ba87113a10ca4a35b5ac610038c0cffbeb7897dcf2198b464d2a8e6dfed26347",
  "left-half-4x4-guided-multi-peak-sparkline-text-table":
    "9989f7c37a31a59f291d558744f67b29e6057c0b229d1e37b779cfb1ddf653f3",
  "left-half-1x4-guided-multi-peak-sparkline-text-table":
    "89e2c11fbaab9d4491627d8881f781147ea164b8ef7f4a2dbe4ef4591ffd3bce",
});

test("the deterministic 800x450 fixtures cover left, right, top, and bottom half-canvas bundles", () => {
  assert.deepEqual(
    fixtures.map(({ side, expectedChartCount }) => [
      side,
      expectedChartCount,
    ]),
    [
      ["left", 12],
      ["right", 10],
      ["top", 6],
      ["bottom", 2],
    ],
  );

  for (const fixture of fixtures) {
    assert.deepEqual(
      [fixture.width, fixture.height],
      [800, 450],
    );
    assert.equal(
      createHash("sha256")
        .update(fixture.bytes)
        .digest("hex"),
      FIXTURE_SHA256[fixture.name],
      `${fixture.name}: fixture pixels must remain deterministic`,
    );
    assert.ok(
      boundsArea(fixture.chartRegion) /
        (fixture.width * fixture.height) >=
        0.45,
      `${fixture.name}: chart bundle must occupy approximately half the slide`,
    );
    assert.ok(
      boundsArea(fixture.contentRegion) /
        (fixture.width * fixture.height) >=
        0.45,
      `${fixture.name}: document distractors must occupy the other half`,
    );
  }
});

test("the shared-boundary 4x4 fixture is a deterministic table lattice containing sixteen physical curves", () => {
  assert.deepEqual(
    [sharedLatticeFixture.width, sharedLatticeFixture.height],
    [800, 450],
  );
  assert.equal(
    sharedLatticeFixture.expectedChartCount,
    16,
  );
  assert.deepEqual(
    sharedLatticeFixture.charts.map(
      ({ peakCount }) => peakCount,
    ),
    [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4],
  );
  assert.equal(
    createHash("sha256")
      .update(sharedLatticeFixture.bytes)
      .digest("hex"),
    FIXTURE_SHA256[sharedLatticeFixture.name],
  );

  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const left =
        sharedLatticeFixture.charts[row * 4 + column];
      const right =
        sharedLatticeFixture.charts[row * 4 + column + 1];
      assert.equal(
        left.bounds.right,
        right.bounds.left,
        "adjacent chart frames must share one physical vertical rule",
      );
    }
  }
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const top =
        sharedLatticeFixture.charts[row * 4 + column];
      const bottom =
        sharedLatticeFixture.charts[(row + 1) * 4 + column];
      assert.equal(
        top.bounds.bottom,
        bottom.bounds.top,
        "adjacent chart frames must share one physical horizontal rule",
      );
    }
  }
});

for (const fixture of denseGuideGridSingleChartFixtures) {
  test(`${fixture.name}: one half-canvas chart survives a dense internal guide lattice`, () => {
    const maskResult = detectChartPanelsFromMask(
      fixture.broadMask,
      fixture.width,
      fixture.height,
      {
        edgeEvidenceMask: fixture.salientMask,
        curveEvidenceMask: fixture.curveMask,
        curveColorMasks: fixture.curveColorMasks,
        fallbackToWholeImage: false,
        sourceScale: 1,
      },
    );
    assert.equal(maskResult.fallbackUsed, false);
    assert.equal(
      maskResult.diagnostics.measuredCandidateSummaries.some(
        ({ guideGridWaveformRescue }) =>
          guideGridWaveformRescue === true,
      ),
      true,
      `${fixture.name}/mask: the physical lattice and cross-cell waveform must be proven independently`,
    );
    assertOnlyExpectedCharts(
      maskResult.panels,
      fixture,
      "mask-dense-guide-grid",
    );

    const rgbResult = detectChartPanels(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
      { adaptiveUpscale: false },
    );
    assert.equal(rgbResult.fallbackUsed, false);
    assert.equal(
      rgbResult.diagnostics.measuredCandidateSummaries.some(
        ({ guideGridWaveformRescue }) =>
          guideGridWaveformRescue === true,
      ),
      true,
      `${fixture.name}/rgb: guide lines must be removed before waveform validation`,
    );
    assertOnlyExpectedCharts(
      rgbResult.panels,
      fixture,
      "rgb-dense-guide-grid",
    );
  });
}

test("grayscale dense guide grid: API and selected-source training preserve five peaks and four valleys", async () => {
  const fixture = denseGuideGridSingleChartFixture({
    grayscaleCurve: true,
  });
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });

  assert.equal(response.panelDetection.fallbackUsed, false);
  assert.equal(response.panelDetection.detectedPanelCount, 1);
  assertOnlyExpectedCharts(
    response.panels,
    fixture,
    "similarity-api-dense-guide-grid",
  );
  assertExactPanelTopology(
    response,
    fixture,
    "similarity-api-dense-guide-grid",
  );

  const panel = response.panels[0];
  const verification = await validateTrainingWaveformImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    profile: panel.profile,
    stateCount: 5,
    sourceSelection: panel.trainingSelection,
  });
  assert.equal(
    verification.authoritativeDescriptor.stateCount,
    5,
  );
  assert.equal(
    verification.authoritativeDescriptor.peakLocations.length,
    5,
  );
  assert.equal(
    verification.authoritativeDescriptor.valleyLocations.length,
    4,
  );
});

test("the grayscale chart lattice and multi-peak sparkline text table fixtures are deterministic 800x450 half-canvas documents", () => {
  assert.deepEqual(
    [
      grayscaleSharedLatticeFixture.width,
      grayscaleSharedLatticeFixture.height,
    ],
    [800, 450],
  );
  assert.deepEqual(
    grayscaleSharedLatticeFixture.charts.map(
      ({ peakCount }) => peakCount,
    ),
    [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4],
  );
  assert.equal(
    grayscaleSharedLatticeFixture.curveColorMasks.every(
      (mask) => mask.every((value) => value === 0),
    ),
    true,
    "the grayscale positive fixture must not accidentally retain chromatic evidence",
  );
  assert.equal(
    sparklineTextTableFixture.expectedCellCount,
    16,
  );
  assert.equal(
    sparklineTextTableFixture.tableCells.length,
    16,
  );
  assert.equal(
    sparklineTextTableFixture.tableCells.every(
      ({ peakCount }) => peakCount === 2,
    ),
    true,
    "every rejected table cell must contain a physical two-peak sparkline",
  );
  assert.equal(
    sparklineTextTableFixture.expectedChartCount,
    0,
  );

  for (const fixture of [
    grayscaleSharedLatticeFixture,
    sparklineTextTableFixture,
    guidedSparklineTextTableFixture,
  ]) {
    assert.equal(
      createHash("sha256")
        .update(fixture.bytes)
        .digest("hex"),
      FIXTURE_SHA256[fixture.name],
      `${fixture.name}: fixture pixels must remain deterministic`,
    );
    assert.ok(
      boundsArea(fixture.chartRegion) /
        (fixture.width * fixture.height) >=
        0.42,
      `${fixture.name}: the table-like bundle must occupy approximately half the slide`,
    );
  }
});

function assertSharedTableLatticeSignal(result, boundary) {
  assert.equal(
    result.diagnostics.tableLatticeDominant.axisAligned,
    true,
    `${boundary}: the joined frames must reproduce the dominant table-lattice signal`,
  );
  assert.equal(
    result.diagnostics.tableLatticeDominant.sharedFrame,
    true,
    `${boundary}: the detector must see the intentionally shared frame`,
  );
  assert.equal(
    result.diagnostics.repeatedGridRecovery.applied,
    true,
    `${boundary}: the proven waveform lattice must activate repeated-grid recovery`,
  );
  assert.equal(
    result.diagnostics.repeatedGridRecovery
      .tableEmbeddedWaveformGridProof,
    true,
    `${boundary}: table bypass requires measured multi-peak/valley proof`,
  );
  assert.equal(
    result.diagnostics.repeatedGridRecovery
      .tableLatticeShapeConsistent,
    true,
    `${boundary}: recovered rows and columns must match the physical lattice`,
  );
  assert.ok(
    result.diagnostics.repeatedGridRecovery
      .measuredMultiPeakCellCount >= 8,
    `${boundary}: at least half of the cells must independently prove multiple measured peaks`,
  );
}

function assertExactPanelTopology(response, fixture, boundary) {
  assert.equal(
    response.panels.length,
    fixture.expectedChartCount,
    `${boundary}: every physical chart must reach API analysis`,
  );
  for (
    let panelIndex = 0;
    panelIndex < fixture.charts.length;
    panelIndex += 1
  ) {
    const expectedPeakCount =
      fixture.charts[panelIndex].peakCount;
    const panel = response.panels[panelIndex];
    assert.ok(
      panel,
      `${boundary}/panel-${panelIndex + 1}: panel is missing`,
    );
    assert.equal(
      panel.query.peakCount,
      expectedPeakCount,
      `${boundary}/panel-${panelIndex + 1}: physical peak count changed`,
    );
    assert.equal(
      panel.query.stateCount,
      expectedPeakCount,
      `${boundary}/panel-${panelIndex + 1}: State count must equal physical peaks`,
    );
    assert.equal(
      panel.query.valleyCount,
      Math.max(0, expectedPeakCount - 1),
      `${boundary}/panel-${panelIndex + 1}: every adjacent peak pair must retain one valley`,
    );
    assert.equal(
      panel.query.topologyConsistent,
      true,
      `${boundary}/panel-${panelIndex + 1}: public peak/valley arrays must be internally consistent`,
    );
    const selectedSeries =
      panel.series[panel.selectedSeriesIndex] ??
      panel.series[0];
    for (const [surface, descriptor] of [
      ["panel", panel.descriptor],
      ["series", selectedSeries.descriptor],
    ]) {
      assert.equal(
        descriptor.stateCount,
        expectedPeakCount,
        `${boundary}/panel-${panelIndex + 1}/${surface}: training State count changed`,
      );
      assert.equal(
        descriptor.peakLocations.length,
        expectedPeakCount,
        `${boundary}/panel-${panelIndex + 1}/${surface}: training peak topology changed`,
      );
      assert.equal(
        descriptor.valleyLocations.length,
        Math.max(0, expectedPeakCount - 1),
        `${boundary}/panel-${panelIndex + 1}/${surface}: training valley topology changed`,
      );
    }
  }
}

test("shared 4x4 lattice: mask boundary must retain all curves despite the dominant table signal", () => {
  const fixture = sharedLatticeFixture;
  const result = detectChartPanelsFromMask(
    fixture.broadMask,
    fixture.width,
    fixture.height,
    {
      edgeEvidenceMask: fixture.salientMask,
      curveEvidenceMask: fixture.curveMask,
      curveColorMasks: fixture.curveColorMasks,
      fallbackToWholeImage: false,
      sourceScale: 1,
    },
  );
  assertSharedTableLatticeSignal(result, "mask");
  assert.equal(result.fallbackUsed, false);
  assertOnlyExpectedCharts(result.panels, fixture, "mask-shared-4x4");
});

test("shared 4x4 lattice: RGB boundary must not suppress curves or admit the real table", () => {
  const fixture = sharedLatticeFixture;
  const result = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
    { adaptiveUpscale: false },
  );
  assertSharedTableLatticeSignal(result, "rgb");
  assert.equal(result.fallbackUsed, false);
  assertOnlyExpectedCharts(result.panels, fixture, "rgb-shared-4x4");
});

test("shared 4x4 lattice: browser UI RGBA boundary preserves all sixteen curves", () => {
  const fixture = sharedLatticeFixture;
  const raster = uiScaledRgba(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  assert.equal(raster.scale, 1);
  const result = detectChartPanels(
    raster.pixels,
    raster.width,
    raster.height,
    raster.channels,
    { sourceScale: raster.scale },
  );
  assertSharedTableLatticeSignal(result, "ui-rgba");
  assert.equal(result.fallbackUsed, false);
  assertOnlyExpectedCharts(
    result.panels,
    fixture,
    "ui-rgba-shared-4x4",
  );
});

test("shared 4x4 lattice: similarity API returns sixteen chart panels and excludes the document half", async () => {
  const fixture = sharedLatticeFixture;
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  assert.equal(response.panelDetection.fallbackUsed, false);
  assert.equal(response.panelDetection.truncated, false);
  assert.equal(
    response.panelDetection.detectedPanelCount,
    fixture.expectedChartCount,
  );
  assert.equal(
    response.panelDetection.analyzedPanelCount,
    fixture.expectedChartCount,
  );
  assertOnlyExpectedCharts(
    response.panels,
    fixture,
    "similarity-api-shared-4x4",
  );
  assertExactPanelTopology(
    response,
    fixture,
    "similarity-api-shared-4x4",
  );
});

test("grayscale shared 4x4 lattice: mask and RGB boundaries retain all 1/2/3/4-State charts without chromatic evidence", () => {
  const fixture = grayscaleSharedLatticeFixture;
  const maskResult = detectChartPanelsFromMask(
    fixture.broadMask,
    fixture.width,
    fixture.height,
    {
      edgeEvidenceMask: fixture.salientMask,
      curveEvidenceMask: fixture.curveMask,
      curveColorMasks: fixture.curveColorMasks,
      fallbackToWholeImage: false,
      sourceScale: 1,
    },
  );
  assert.equal(maskResult.fallbackUsed, false);
  assertOnlyExpectedCharts(
    maskResult.panels,
    fixture,
    "mask-grayscale-shared-4x4",
  );

  const rgbResult = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
    { adaptiveUpscale: false },
  );
  assert.equal(rgbResult.fallbackUsed, false);
  assertOnlyExpectedCharts(
    rgbResult.panels,
    fixture,
    "rgb-grayscale-shared-4x4",
  );
});

test("grayscale shared 4x4 lattice: similarity API preserves exact 1/2/3/4-State topology", async () => {
  const fixture = grayscaleSharedLatticeFixture;
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  assert.equal(response.panelDetection.fallbackUsed, false);
  assert.equal(response.panelDetection.truncated, false);
  assertOnlyExpectedCharts(
    response.panels,
    fixture,
    "similarity-api-grayscale-shared-4x4",
  );
  assertExactPanelTopology(
    response,
    fixture,
    "similarity-api-grayscale-shared-4x4",
  );
  for (const [panelIndex, panel] of response.panels.entries()) {
    const validated = validateSharedTrainingPayload({
      sharingConsent: true,
      consentVersion: SHARED_TRAINING_CONSENT_VERSION,
      contributorToken: "a".repeat(43),
      deletionToken: "b".repeat(43),
      label: `grayscale-${panelIndex + 1}`,
      profile: panel.profile,
      descriptor: panel.descriptor,
    });
    assert.equal(
      validated.descriptor.stateCount,
      fixture.charts[panelIndex].peakCount,
      `shared-training/panel-${panelIndex + 1}: source-verified State topology changed`,
    );
  }
  const threePeakPanelIndex = fixture.charts.findIndex(
    ({ peakCount }) => peakCount === 3,
  );
  const threePeakPanel = response.panels[threePeakPanelIndex];
  const verification = await validateTrainingWaveformImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    profile: threePeakPanel.profile,
    stateCount: 3,
    sourceSelection: threePeakPanel.trainingSelection,
  });
  assert.equal(
    verification.authoritativeDescriptor.stateCount,
    3,
    "selected full-document provenance must retain detector-verified peak topology",
  );
  assert.equal(
    verification.authoritativeDescriptor.valleyLocations.length,
    2,
  );
});

test("single-peak shared 4x4 lattice: every chart survives the table signal with zero invented valleys", async () => {
  const fixture = singlePeakSharedLatticeFixture;
  assert.equal(
    createHash("sha256")
      .update(fixture.bytes)
      .digest("hex"),
    FIXTURE_SHA256[fixture.name],
  );
  const maskResult = detectChartPanelsFromMask(
    fixture.broadMask,
    fixture.width,
    fixture.height,
    {
      edgeEvidenceMask: fixture.salientMask,
      curveEvidenceMask: fixture.curveMask,
      curveColorMasks: fixture.curveColorMasks,
      fallbackToWholeImage: false,
      sourceScale: 1,
    },
  );
  assert.equal(maskResult.fallbackUsed, false);
  assert.equal(
    maskResult.diagnostics.repeatedGridRecovery
      .measuredTopologyCellCount,
    fixture.expectedChartCount,
  );
  assert.equal(
    maskResult.diagnostics.repeatedGridRecovery
      .measuredMultiPeakCellCount,
    0,
  );
  assert.equal(
    maskResult.diagnostics.repeatedGridRecovery
      .tableEmbeddedWaveformGridProof,
    true,
  );
  assertOnlyExpectedCharts(
    maskResult.panels,
    fixture,
    "mask-single-peak-shared-4x4",
  );

  const rgbResult = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
    { adaptiveUpscale: false },
  );
  assert.equal(rgbResult.fallbackUsed, false);
  assertOnlyExpectedCharts(
    rgbResult.panels,
    fixture,
    "rgb-single-peak-shared-4x4",
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  assertOnlyExpectedCharts(
    response.panels,
    fixture,
    "similarity-api-single-peak-shared-4x4",
  );
  assertExactPanelTopology(
    response,
    fixture,
    "similarity-api-single-peak-shared-4x4",
  );
});

test("single-row shared 1x4 lattice: each physical chart is split and retains exact topology", async () => {
  const fixture = singleRowSharedLatticeFixture;
  assert.equal(
    createHash("sha256")
      .update(fixture.bytes)
      .digest("hex"),
    FIXTURE_SHA256[fixture.name],
  );
  const maskResult = detectChartPanelsFromMask(
    fixture.broadMask,
    fixture.width,
    fixture.height,
    {
      edgeEvidenceMask: fixture.salientMask,
      curveEvidenceMask: fixture.curveMask,
      curveColorMasks: fixture.curveColorMasks,
      fallbackToWholeImage: false,
      sourceScale: 1,
    },
  );
  assertOnlyExpectedCharts(
    maskResult.panels,
    fixture,
    "mask-single-row-shared-1x4",
  );

  const rgbResult = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
    { adaptiveUpscale: false },
  );
  assertOnlyExpectedCharts(
    rgbResult.panels,
    fixture,
    "rgb-single-row-shared-1x4",
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  assertOnlyExpectedCharts(
    response.panels,
    fixture,
    "similarity-api-single-row-shared-1x4",
  );
  assertExactPanelTopology(
    response,
    fixture,
    "similarity-api-single-row-shared-1x4",
  );
});

test("multi-peak sparkline text table: mask and RGB boundaries reject every table cell", () => {
  const fixture = sparklineTextTableFixture;
  const maskResult = detectChartPanelsFromMask(
    fixture.broadMask,
    fixture.width,
    fixture.height,
    {
      edgeEvidenceMask: fixture.salientMask,
      curveEvidenceMask: fixture.curveMask,
      curveColorMasks: fixture.curveColorMasks,
      fallbackToWholeImage: false,
      sourceScale: 1,
    },
  );
  assert.equal(maskResult.fallbackUsed, false);
  assert.equal(maskResult.panels.length, 0);

  const rgbResult = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
    { adaptiveUpscale: false },
  );
  assert.equal(rgbResult.fallbackUsed, false);
  assert.equal(rgbResult.panels.length, 0);
});

test("multi-peak sparkline text table: similarity API rejects the document as non-distribution content", async () => {
  const fixture = sparklineTextTableFixture;
  await assert.rejects(
    () =>
      searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: publicCorpus,
        origin: "https://dove9999.com",
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(
        error.code,
        "distribution_waveform_not_found",
      );
      return true;
    },
  );
});

test("guided multi-peak sparkline text table: internal rules cannot impersonate per-chart plot grids", async () => {
  const fixture = guidedSparklineTextTableFixture;
  const maskResult = detectChartPanelsFromMask(
    fixture.broadMask,
    fixture.width,
    fixture.height,
    {
      edgeEvidenceMask: fixture.salientMask,
      curveEvidenceMask: fixture.curveMask,
      curveColorMasks: fixture.curveColorMasks,
      fallbackToWholeImage: false,
      sourceScale: 1,
    },
  );
  assert.equal(maskResult.panels.length, 0);

  const rgbResult = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
    { adaptiveUpscale: false },
  );
  assert.equal(rgbResult.panels.length, 0);

  await assert.rejects(
    () =>
      searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: publicCorpus,
        origin: "https://dove9999.com",
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(
        error.code,
        "distribution_waveform_not_found",
      );
      return true;
    },
  );
});

test("guided single-row 1x4 sparkline text table: local shared boundaries remain non-chart content", async () => {
  const fixture = guidedSingleRowSparklineTextTableFixture;
  assert.equal(
    createHash("sha256")
      .update(fixture.bytes)
      .digest("hex"),
    FIXTURE_SHA256[fixture.name],
  );
  const maskResult = detectChartPanelsFromMask(
    fixture.broadMask,
    fixture.width,
    fixture.height,
    {
      edgeEvidenceMask: fixture.salientMask,
      curveEvidenceMask: fixture.curveMask,
      curveColorMasks: fixture.curveColorMasks,
      fallbackToWholeImage: false,
      sourceScale: 1,
    },
  );
  assert.equal(maskResult.panels.length, 0);

  const rgbResult = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
    { adaptiveUpscale: false },
  );
  assert.equal(rgbResult.panels.length, 0);

  await assert.rejects(
    () =>
      searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: publicCorpus,
        origin: "https://dove9999.com",
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(
        error.code,
        "distribution_waveform_not_found",
      );
      return true;
    },
  );
});

for (const fixture of fixtures) {
  test(`${fixture.name}: mask boundary returns only the true table-like waveform cells`, () => {
    const maskResult = detectChartPanelsFromMask(
      fixture.broadMask,
      fixture.width,
      fixture.height,
      {
        edgeEvidenceMask: fixture.salientMask,
        curveEvidenceMask: fixture.curveMask,
        curveColorMasks: fixture.curveColorMasks,
        fallbackToWholeImage: false,
        sourceScale: 1,
      },
    );
    assert.equal(maskResult.fallbackUsed, false);
    assertOnlyExpectedCharts(
      maskResult.panels,
      fixture,
      "mask",
    );
  });

  test(`${fixture.name}: RGB boundary excludes the text and neutral table half`, () => {
    const rgbResult = detectChartPanels(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
      { adaptiveUpscale: false },
    );
    assert.equal(rgbResult.fallbackUsed, false);
    assertOnlyExpectedCharts(
      rgbResult.panels,
      fixture,
      "rgb",
    );
  });

  test(`${fixture.name}: browser UI RGBA boundary preserves every waveform cell`, () => {
    const uiRaster = uiScaledRgba(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
    );
    assert.equal(uiRaster.scale, 1);
    assert.deepEqual(
      [uiRaster.width, uiRaster.height, uiRaster.channels],
      [800, 450, 4],
    );
    const uiResult = detectChartPanels(
      uiRaster.pixels,
      uiRaster.width,
      uiRaster.height,
      uiRaster.channels,
      { sourceScale: uiRaster.scale },
    );
    assert.equal(uiResult.fallbackUsed, false);
    assertOnlyExpectedCharts(
      uiResult.panels,
      fixture,
      "ui-rgba",
    );
  });

  test(`${fixture.name}: similarity API returns only the real multi-peak panels`, async () => {
    const response = await searchSimilarityImage({
      bytes: fixture.bytes,
      mimeType: fixture.mimeType,
      topK: 1,
      corpus: publicCorpus,
      origin: "https://dove9999.com",
    });

    assert.equal(response.panelDetection.fallbackUsed, false);
    assert.equal(
      response.panelDetection.truncated,
      false,
    );
    assert.equal(
      response.panelDetection.detectedPanelCount,
      fixture.expectedChartCount,
    );
    assert.equal(
      response.panelDetection.analyzedPanelCount,
      fixture.expectedChartCount,
    );
    assertOnlyExpectedCharts(
      response.panels,
      fixture,
      "similarity-api",
    );

    for (const [panelIndex, panel] of response.panels.entries()) {
      assert.ok(
        panel.series.length >= 1,
        `${fixture.name}/panel-${panelIndex + 1}: a real multi-peak curve must remain analyzable`,
      );
      for (const series of panel.series) {
        assert.ok(
          series.query.peakCount >= 2,
          `${fixture.name}/panel-${panelIndex + 1}: the physical curve has multiple peaks`,
        );
        assert.equal(
          series.query.peakCount,
          series.query.stateCount,
        );
        assert.equal(
          series.query.valleyCount,
          series.query.peakCount - 1,
        );
      }
    }
  });
}
