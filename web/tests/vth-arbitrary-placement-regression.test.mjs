import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import { detectChartPanels } from "../lib/vth-chart-panel-core.mjs";
import { searchSimilarityImage } from "../lib/vth-similarity-api-core.mjs";
import {
  arbitraryRepositionedQlcSlideFixture,
  arbitraryWaveformOfficeSlideFixture,
} from "./helpers/arbitrary-waveform-slide-fixture.mjs";
import {
  colorSeriesChartFixture,
} from "./helpers/color-series-fixtures.mjs";
import {
  tinyTwelveChartFixture,
} from "./helpers/tiny-multichart-fixtures.mjs";

const qlcSource = decodePng(
  await readFile(
    new URL(
      "./fixtures/qlc-read-disturb-20-chart-slide.png",
      import.meta.url,
    ),
  ),
);
const clippedStateSourceA = decodePng(
  await readFile(
    new URL(
      "../public/corpus/vth-08s-s0042-00010--base.png",
      import.meta.url,
    ),
  ),
);
const clippedStateSourceB = decodePng(
  await readFile(
    new URL(
      "../public/corpus/vth-08s-s0043-00011--base.png",
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

const SYNTHETIC_SHA256 =
  "32667d331a2f2c17435d248945e5761b14ee3247e9e65545119dbcf2d0ffaa77";
const REPOSITIONED_QLC_SHA256 =
  "13ebdcc13f547461b80a1bad68c3f7f4da617e6e4e3f8933bf8bcb6979f10292";

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

function centerOf(bounds) {
  const normalized = normalizedBounds(bounds);
  return {
    x: (normalized.left + normalized.right) / 2,
    y: (normalized.top + normalized.bottom) / 2,
  };
}

function area(bounds) {
  const normalized = normalizedBounds(bounds);
  return (
    Math.max(0, normalized.right - normalized.left) *
    Math.max(0, normalized.bottom - normalized.top)
  );
}

function intersectionArea(first, second) {
  const a = normalizedBounds(first);
  const b = normalizedBounds(second);
  return (
    Math.max(
      0,
      Math.min(a.right, b.right) - Math.max(a.left, b.left),
    ) *
    Math.max(
      0,
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
    )
  );
}

function pixelIntersectionArea(first, second) {
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

function whiteCanvasWithPastes(width, height, pastes) {
  const pixels = new Uint8Array(width * height * 3).fill(255);
  for (const { source, left, top } of pastes) {
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const sourceOffset =
          (y * source.width + x) * source.channels;
        const targetOffset =
          ((top + y) * width + left + x) * 3;
        pixels[targetOffset] = source.data[sourceOffset];
        pixels[targetOffset + 1] =
          source.data[sourceOffset + 1];
        pixels[targetOffset + 2] =
          source.data[sourceOffset + 2];
      }
    }
  }
  return pixels;
}

function pasteNearestCrop(
  pixels,
  width,
  source,
  bounds,
  left,
  top,
  scale,
) {
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const sourceOffset =
        (y * source.width + x) * source.channels;
      for (let localY = 0; localY < scale; localY += 1) {
        for (let localX = 0; localX < scale; localX += 1) {
          const targetX =
            left + (x - bounds.left) * scale + localX;
          const targetY =
            top + (y - bounds.top) * scale + localY;
          const targetOffset =
            (targetY * width + targetX) * 3;
          pixels[targetOffset] =
            source.pixels[sourceOffset];
          pixels[targetOffset + 1] =
            source.pixels[sourceOffset + 1];
          pixels[targetOffset + 2] =
            source.pixels[sourceOffset + 2];
        }
      }
    }
  }
}

function intersectionOverUnion(first, second) {
  const intersection = intersectionArea(first, second);
  return (
    intersection /
    Math.max(1, area(first) + area(second) - intersection)
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

function matchGroundTruth(
  actualBounds,
  expectedCharts,
  {
    // Open-axis plots may have no visible top/right border, so the detector
    // can correctly retain the complete waveform while cropping empty axis
    // margin. Keep the same strict 0.62 overlap contract as the real QLC
    // regression and combine it with center proximity plus exact panel count
    // to reject splits, merges, and distractor boxes.
    minimumIntersectionOverUnion = 0.62,
    maximumCenterDistanceRatio = 0.13,
  } = {},
) {
  const expectedBounds = expectedCharts.map(({ bounds }) => bounds);
  const adjacency = expectedBounds.map((expected) => {
    const expectedCenter = centerOf(expected);
    const expectedDiagonal = Math.hypot(
      normalizedBounds(expected).right -
        normalizedBounds(expected).left,
      normalizedBounds(expected).bottom -
        normalizedBounds(expected).top,
    );
    return actualBounds
      .map((actual, actualIndex) => {
        const actualCenter = centerOf(actual);
        return {
          actualIndex,
          iou: intersectionOverUnion(actual, expected),
          centerDistance: Math.hypot(
            actualCenter.x - expectedCenter.x,
            actualCenter.y - expectedCenter.y,
          ),
          maximumCenterDistance: Math.max(
            5,
            expectedDiagonal * maximumCenterDistanceRatio,
          ),
        };
      })
      .filter(
        ({ iou, centerDistance, maximumCenterDistance }) =>
          iou >= minimumIntersectionOverUnion &&
          centerDistance <= maximumCenterDistance,
      )
      .sort(
        (first, second) =>
          second.iou - first.iou ||
          first.centerDistance - second.centerDistance,
      );
  });

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
  for (let expectedIndex = 0; expectedIndex < expectedBounds.length; expectedIndex += 1) {
    if (assign(expectedIndex, new Set())) {
      matchedExpected.add(expectedIndex);
    }
  }
  const missedExpectedIndexes = expectedBounds
    .map((_bounds, index) => index)
    .filter((index) => !matchedExpected.has(index));
  const unmatchedActualIndexes = expectedForActual
    .map((expectedIndex, index) => ({ expectedIndex, index }))
    .filter(({ expectedIndex }) => expectedIndex === -1)
    .map(({ index }) => index);

  return {
    matchedCount: matchedExpected.size,
    missedExpectedIndexes,
    unmatchedActualIndexes,
    expectedForActual,
  };
}

function assertAllWaveformsAndOnlyWaveforms(
  actualBounds,
  fixture,
  label,
) {
  const matching = matchGroundTruth(actualBounds, fixture.charts);
  assert.equal(
    matching.matchedCount,
    fixture.expectedChartCount,
    `${label}: only ${matching.matchedCount}/${fixture.expectedChartCount} ground-truth waveforms matched; missed GT indexes [${matching.missedExpectedIndexes.join(", ")}], unmatched detections [${matching.unmatchedActualIndexes.join(", ")}]`,
  );
  assert.equal(
    actualBounds.length,
    fixture.expectedChartCount,
    `${label}: expected exactly ${fixture.expectedChartCount} waveform panels with no distractor false positives`,
  );

  for (const distractor of fixture.distractors) {
    const distractorCenter = centerOf(distractor.bounds);
    assert.ok(
      actualBounds.every(
        (bounds) => !containsPoint(bounds, distractorCenter),
      ),
      `${label}: ${distractor.type} center must not be detected as a waveform`,
    );
    assert.ok(
      actualBounds.every(
        (bounds) =>
          intersectionArea(bounds, distractor.bounds) /
            Math.max(1, Math.min(area(bounds), area(distractor.bounds))) <
          0.35,
      ),
      `${label}: ${distractor.type} must not substantially overlap a returned waveform crop`,
    );
  }
}

function minimumOverlappingHorizontalGap(charts) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let firstIndex = 0; firstIndex < charts.length; firstIndex += 1) {
    const first = charts[firstIndex].bounds;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < charts.length;
      secondIndex += 1
    ) {
      const second = charts[secondIndex].bounds;
      const verticalOverlap = Math.min(first.bottom, second.bottom) -
        Math.max(first.top, second.top);
      if (verticalOverlap <= 0) continue;
      const gap =
        first.right < second.left
          ? second.left - first.right
          : second.right < first.left
            ? first.left - second.right
            : Number.POSITIVE_INFINITY;
      minimum = Math.min(minimum, gap);
    }
  }
  return minimum;
}

test("fixture deterministically represents twenty non-lattice, variable waveform placements mixed with office content", () => {
  const fixture = arbitraryWaveformOfficeSlideFixture();
  const repositionedQlc =
    arbitraryRepositionedQlcSlideFixture(qlcSource);
  const widths = fixture.charts.map(
    ({ bounds }) => bounds.right - bounds.left,
  );
  const heights = fixture.charts.map(
    ({ bounds }) => bounds.bottom - bounds.top,
  );
  const areas = fixture.charts.map(({ bounds }) => area(bounds));
  const peakCounts = new Set(
    fixture.charts.map(({ peakCenters }) => peakCenters.length),
  );
  const broadBandCounts = [0, 0, 0, 0];
  for (const chart of fixture.charts) {
    const centerY = centerOf(chart.bounds).y;
    broadBandCounts[
      centerY < 105 ? 0 : centerY < 230 ? 1 : centerY < 360 ? 2 : 3
    ] += 1;
  }

  assert.equal(fixture.width, 960);
  assert.equal(fixture.height, 540);
  assert.equal(fixture.expectedChartCount, 20);
  assert.equal(
    createHash("sha256").update(fixture.bytes).digest("hex"),
    SYNTHETIC_SHA256,
  );
  assert.equal(
    createHash("sha256")
      .update(repositionedQlc.bytes)
      .digest("hex"),
    REPOSITIONED_QLC_SHA256,
  );
  assert.equal(repositionedQlc.expectedChartCount, 20);
  assert.equal(
    new Set(
      repositionedQlc.charts.map(
        ({ sourcePanelIndex }) => sourcePanelIndex,
      ),
    ).size,
    20,
    "each supplied real QLC crop must appear exactly once",
  );
  assert.deepEqual(broadBandCounts, [5, 4, 6, 5]);
  assert.equal(new Set(fixture.charts.map(({ bounds }) => bounds.left)).size, 20);
  assert.equal(new Set(fixture.charts.map(({ bounds }) => bounds.top)).size, 20);
  assert.equal(new Set(widths).size, 20);
  assert.equal(new Set(heights).size, 20);
  assert.deepEqual([...peakCounts].sort((a, b) => a - b), [1, 2, 4, 6]);
  assert.equal(
    fixture.charts.filter(({ singlePeak }) => singlePeak).length,
    6,
  );
  assert.ok(Math.max(...areas) / Math.min(...areas) >= 5);
  assert.ok(minimumOverlappingHorizontalGap(fixture.charts) <= 6);
  for (
    let firstIndex = 0;
    firstIndex < fixture.charts.length;
    firstIndex += 1
  ) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < fixture.charts.length;
      secondIndex += 1
    ) {
      assert.equal(
        pixelIntersectionArea(
          fixture.charts[firstIndex].bounds,
          fixture.charts[secondIndex].bounds,
        ),
        0,
        `ground-truth charts ${firstIndex} and ${secondIndex} must not share a physical pixel`,
      );
    }
  }
  assert.ok(
    fixture.charts.some(
      ({ bounds }) => bounds.left <= 3 && bounds.top <= 3,
    ),
    "a real chart must touch the top/left safety margin",
  );
  assert.ok(
    fixture.charts.some(
      ({ bounds }) =>
        bounds.right >= fixture.width - 2 &&
        bounds.bottom >= fixture.height - 2,
    ),
    "a real chart must touch the bottom/right safety margin",
  );
  assert.deepEqual(
    fixture.distractors.map(({ type }) => type),
    [
      "explanation-text-card",
      "numeric-table",
      "process-diagram",
      "monotonic-line-chart",
    ],
  );
});

test("detector independently extracts every arbitrary synthetic waveform and rejects all distractors", () => {
  const fixture = arbitraryWaveformOfficeSlideFixture();
  const result = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );

  assert.equal(result.fallbackUsed, false);
  assert.equal(result.truncated, false);
  assert.equal(result.diagnostics.repeatedGridRecovery.applied, false);
  assertAllWaveformsAndOnlyWaveforms(
    result.panels,
    fixture,
    "synthetic arbitrary placement",
  );
});

test("keeps two clipped-State corpus charts independent across a blank gutter", () => {
  const gutter = 100;
  const secondLeft = clippedStateSourceA.width + gutter;
  const width = secondLeft + clippedStateSourceB.width;
  const height = Math.max(
    clippedStateSourceA.height,
    clippedStateSourceB.height,
  );
  const pixels = whiteCanvasWithPastes(width, height, [
    { source: clippedStateSourceA, left: 0, top: 0 },
    {
      source: clippedStateSourceB,
      left: secondLeft,
      top: 0,
    },
  ]);

  const result = detectChartPanels(pixels, width, height, 3);

  assert.equal(result.fallbackUsed, false);
  assert.equal(result.panels.length, 2);
  assert.ok(result.panels[0].right < result.panels[1].left);
  const expected = [
    {
      left: 0,
      top: 0,
      right: clippedStateSourceA.width - 1,
      bottom: clippedStateSourceA.height - 1,
    },
    {
      left: secondLeft,
      top: 0,
      right: width - 1,
      bottom: clippedStateSourceB.height - 1,
    },
  ];
  result.panels.forEach((panel, index) => {
    assert.ok(
      pixelIntersectionArea(panel, expected[index]) /
        Math.max(1, area(panel)) >=
        0.8,
    );
  });
});

test("groups one clipped-State chart after it is pasted away from the document boundary", () => {
  const margin = 100;
  const width = clippedStateSourceA.width + margin * 2;
  const height = clippedStateSourceA.height + margin * 2;
  const pixels = whiteCanvasWithPastes(width, height, [
    {
      source: clippedStateSourceA,
      left: margin,
      top: margin,
    },
  ]);

  const result = detectChartPanels(pixels, width, height, 3);
  const sourceBounds = {
    left: margin,
    top: margin,
    right: margin + clippedStateSourceA.width - 1,
    bottom: margin + clippedStateSourceA.height - 1,
  };

  assert.equal(result.fallbackUsed, false);
  assert.equal(result.panels.length, 1);
  assert.ok(
    pixelIntersectionArea(result.panels[0], sourceBounds) /
      Math.max(1, area(result.panels[0])) >=
      0.75,
  );
  assert.ok(
    result.panels[0].width >=
      clippedStateSourceA.width * 0.85,
  );
});

test("keeps a small unrelated chart outside one dominant multi-series chart", () => {
  const width = 1100;
  const height = 600;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const dominant = colorSeriesChartFixture({
    width: 720,
    height: 440,
    seriesCount: 3,
  });
  const tiny = tinyTwelveChartFixture();
  const tinyBounds = tiny.charts[10];
  for (let y = 0; y < dominant.height; y += 1) {
    pixels.set(
      dominant.pixels.subarray(
        y * dominant.width * dominant.channels,
        (y + 1) * dominant.width * dominant.channels,
      ),
      y * width * 3,
    );
  }
  pasteNearestCrop(
    pixels,
    width,
    tiny,
    tinyBounds,
    900,
    500,
    2,
  );

  const result = detectChartPanels(pixels, width, height, 3, {
    sourceScale: 2,
  });

  assert.equal(result.fallbackUsed, false);
  assert.equal(result.panels.length, 2);
  assert.ok(
    result.panels.some(
      (panel) =>
        panel.left < 100 &&
        panel.right > 600 &&
        panel.bottom < 450,
    ),
  );
  assert.ok(
    result.panels.some(
      (panel) =>
        panel.left >= 880 &&
        panel.top >= 480,
    ),
  );
});

test("detector extracts all twenty real QLC crops after arbitrary repositioning and resizing", () => {
  const fixture = arbitraryRepositionedQlcSlideFixture(qlcSource);
  const result = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );

  assert.equal(result.fallbackUsed, false);
  assert.equal(result.truncated, false);
  assert.equal(result.diagnostics.repeatedGridRecovery.applied, false);
  assertAllWaveformsAndOnlyWaveforms(
    result.panels,
    fixture,
    "real QLC crops at arbitrary positions",
  );
});

test("similarity API returns one independent ranking for every arbitrarily positioned real QLC waveform", async () => {
  const fixture = arbitraryRepositionedQlcSlideFixture(qlcSource);
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });
  const sourceBounds = response.panels.map(
    ({ bounds }) => bounds.source,
  );

  assert.equal(response.panelDetection.fallbackUsed, false);
  assert.equal(response.panelDetection.truncated, false);
  assertAllWaveformsAndOnlyWaveforms(
    sourceBounds,
    fixture,
    "similarity API arbitrary placement",
  );
  assert.equal(response.panelCount, 20);
  assert.equal(response.panelDetection.detectedPanelCount, 20);
  assert.equal(response.panelDetection.analyzedPanelCount, 20);
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.results.length === 1 &&
        panel.seriesCount === 1 &&
        panel.query.observedStateCount >= 4,
    ),
    "every real eight-State QLC crop must be analyzed as one distribution",
  );
});
