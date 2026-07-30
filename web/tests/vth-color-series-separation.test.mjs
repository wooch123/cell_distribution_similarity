import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import jpeg from "jpeg-js";
import { encode as encodePng } from "fast-png";

import {
  detectChartPanels,
  detectChartPanelsFromMask,
} from "../lib/vth-chart-panel-core.mjs";
import {
  analyzeForegroundMasks,
  applyVerifiedWaveformEvidence,
  extractColorDistributionCandidates,
} from "../lib/vth-image-analysis-core.mjs";
import { buildForegroundMasks } from "../lib/vth-image-core.mjs";
import {
  analyzeSimilarityImage,
  searchSimilarityImage,
  SimilarityApiError,
  validateTrainingWaveformImage,
} from "../lib/vth-similarity-api-core.mjs";
import { alignedCurveSimilarity } from "../lib/vth-shape-core.mjs";
import {
  COLOR_SERIES_PALETTE,
  chromaticAndNeutralPairFixture,
  chromaticAndNeutralSeriesFixture,
  coloredCellTableFixture,
  coloredFloatingSineTableFixture,
  colorSeriesChartFixture,
  mixedPanelColorSeriesFixture,
  monochromeSeriesChartFixture,
  rotateRgbFixture,
  rotatedChromaticAndNeutralSeriesFixture,
  segmentedChromaticAndNeutralSeriesFixture,
} from "./helpers/color-series-fixtures.mjs";

const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

function foregroundFor(fixture) {
  return buildForegroundMasks(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
}

function jpegBytesForRgb(pixels, width, height, quality = 92) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = pixels[index * 3];
    rgba[index * 4 + 1] = pixels[index * 3 + 1];
    rgba[index * 4 + 2] = pixels[index * 3 + 2];
    rgba[index * 4 + 3] = 255;
  }
  return jpeg.encode({ data: rgba, width, height }, quality).data;
}

function twoPanelDocumentFixture(
  first,
  second,
  { jpegQuality } = {},
) {
  const margin = 12;
  const gutter = 24;
  const secondOffsetY = 72;
  const width =
    margin * 2 + first.width + gutter + second.width;
  const height =
    margin * 2 +
    Math.max(first.height, secondOffsetY + second.height);
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const blit = (fixture, offsetX, offsetY) => {
    for (let y = 0; y < fixture.height; y += 1) {
      const sourceOffset = y * fixture.width * 3;
      const targetOffset =
        ((offsetY + y) * width + offsetX) * 3;
      pixels.set(
        fixture.pixels.subarray(
          sourceOffset,
          sourceOffset + fixture.width * 3,
        ),
        targetOffset,
      );
    }
  };
  blit(first, margin, margin);
  blit(
    second,
    margin + first.width + gutter,
    margin + secondOffsetY,
  );
  return {
    width,
    height,
    channels: 3,
    pixels,
    bytes:
      jpegQuality === undefined
        ? encodePng({
            width,
            height,
            data: pixels,
            channels: 3,
            depth: 8,
          })
        : jpegBytesForRgb(
            pixels,
            width,
            height,
            jpegQuality,
          ),
    mimeType:
      jpegQuality === undefined ? "image/png" : "image/jpeg",
  };
}

function ambiguousTwinSeriesFixture() {
  const fixture = colorSeriesChartFixture({
    width: 600,
    height: 360,
    seriesCount: 2,
    crossingMode: "near",
  });
  const pixels = Uint8Array.from(fixture.pixels);
  const red = COLOR_SERIES_PALETTE[0];
  const blue = COLOR_SERIES_PALETTE[1];
  const matches = (offset, color) =>
    pixels[offset] === color[0] &&
    pixels[offset + 1] === color[1] &&
    pixels[offset + 2] === color[2];
  const redCurvePixels = [];
  for (
    let y = fixture.bounds.top;
    y <= fixture.bounds.bottom;
    y += 1
  ) {
    for (
      let x = fixture.bounds.left;
      x <= fixture.bounds.right;
      x += 1
    ) {
      const offset = (y * fixture.width + x) * 3;
      if (matches(offset, red)) {
        redCurvePixels.push({ x, y });
      } else if (matches(offset, blue)) {
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
      }
    }
  }
  for (const { x, y } of redCurvePixels) {
    const shiftedY = y + 10;
    const progress =
      (x - fixture.bounds.left) /
      Math.max(1, fixture.bounds.right - fixture.bounds.left);
    const shiftedX =
      x + Math.round(Math.sin(progress * Math.PI * 4) * 3);
    if (
      shiftedX < fixture.bounds.left ||
      shiftedX > fixture.bounds.right ||
      shiftedY > fixture.bounds.bottom
    ) {
      continue;
    }
    const offset =
      (shiftedY * fixture.width + shiftedX) * 3;
    pixels[offset] = blue[0];
    pixels[offset + 1] = blue[1];
    pixels[offset + 2] = blue[2];
  }
  return {
    ...fixture,
    pixels,
    bytes: encodePng({
      width: fixture.width,
      height: fixture.height,
      data: pixels,
      channels: 3,
      depth: 8,
    }),
  };
}

function twoColorChartWithNeutralGuideFixture(guideMode) {
  const fixture = colorSeriesChartFixture({
    width: 600,
    height: 360,
    seriesCount: 2,
    crossingMode: "near",
  });
  const pixels = Uint8Array.from(fixture.pixels);
  const color = [24, 27, 31];
  const { left, top, right, bottom } = fixture.bounds;
  for (let x = left + 5; x <= right - 5; x += 1) {
    const progress =
      (x - left - 5) / Math.max(1, right - left - 10);
    const centerY =
      guideMode === "horizontal"
        ? Math.round(top + (bottom - top) * 0.56)
        : Math.round(
            bottom -
              20 -
              progress * Math.max(1, bottom - top - 40),
          );
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const targetX = x + offsetX;
        const targetY = centerY + offsetY;
        if (
          targetX < 0 ||
          targetX >= fixture.width ||
          targetY < 0 ||
          targetY >= fixture.height
        ) {
          continue;
        }
        const offset =
          (targetY * fixture.width + targetX) * 3;
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
      }
    }
  }
  return {
    ...fixture,
    pixels,
    bytes: encodePng({
      width: fixture.width,
      height: fixture.height,
      data: pixels,
      channels: 3,
      depth: 8,
    }),
  };
}

function assertSeriesContract(analysis, expectedCount) {
  assert.equal(analysis.series.length, expectedCount);
  assert.ok(
    Number.isInteger(analysis.selectedSeriesIndex) &&
      analysis.selectedSeriesIndex >= 0 &&
      analysis.selectedSeriesIndex < expectedCount,
  );
  assert.deepEqual(
    analysis.series.map((series) => series.seriesIndex),
    Array.from({ length: expectedCount }, (_, index) => index),
  );
  assert.deepEqual(
    analysis.series.map((series) => series.selected),
    Array.from(
      { length: expectedCount },
      (_, index) => index === analysis.selectedSeriesIndex,
    ),
  );
  assert.deepEqual(
    analysis.profile,
    analysis.series[analysis.selectedSeriesIndex].profile,
    "the compatibility profile must remain the most-irregular selected series",
  );
}

test("splits at most two colored distributions and otherwise targets only the most-irregular trace", async (context) => {
  for (const seriesCount of [2, 3, 4]) {
    await context.test(`${seriesCount} color series`, () => {
      const fixture = colorSeriesChartFixture({
        width: 600,
        height: 360,
        seriesCount,
        crossingMode: "near",
      });
      const foreground = foregroundFor(fixture);

      assert.equal(
        foreground.curveColorMasks.length,
        seriesCount,
        "each real hue must survive foreground cleanup",
      );

      const separated = extractColorDistributionCandidates(
        foreground.curveColorMasks,
        fixture.width,
        fixture.height,
        fixture.bounds,
      );
      assert.equal(separated.distributionCount, seriesCount);
      assert.equal(separated.candidates.length, seriesCount);
      assert.deepEqual(
        [...separated.candidates]
          .sort((left, right) => left.sourceIndex - right.sourceIndex)
          .map((candidate) => candidate.sourceIndex),
        Array.from({ length: seriesCount }, (_, index) => index),
      );
      assert.ok(
        separated.candidates.every(
          (candidate) =>
            candidate.separationMode === "color" &&
            candidate.observedColumnRatio >= 0.62 &&
            candidate.descriptor.stateCount === 4,
        ),
      );

      const analysis = analyzeForegroundMasks(
        foreground.broadMask,
        foreground.salientMask,
        fixture.width,
        fixture.height,
        foreground.curveSalientMask,
        foreground.curveColorMasks,
      );
      const targetSeriesCount =
        seriesCount <= 2 ? seriesCount : 1;
      assertSeriesContract(analysis, targetSeriesCount);
      assert.equal(
        analysis.distributionSelection.distributionCount,
        seriesCount,
      );
      assert.equal(
        analysis.distributionSelection.selectedSeriesIndex,
        analysis.selectedSeriesIndex,
      );
      assert.equal(
        analysis.distributionSelection.targetDistributionCount,
        targetSeriesCount,
      );
      assert.equal(
        analysis.distributionSelection.mode,
        seriesCount <= 2
          ? "most-irregular"
          : "most-irregular-only",
      );
      assert.deepEqual(
        analysis.preprocessing.colorSeriesPolicy,
        {
          maximumIndependentSeries: 2,
          applied: true,
          collapsedToMostIrregular: seriesCount > 2,
          detectedSeriesCount: seriesCount,
          targetSeriesCount,
          selectedSourceIndex:
            analysis.distributionSelection.selectedIndex,
        },
      );
      assert.ok(
        analysis.series.every(
          (series) => series.separationMode === "color",
        ),
      );
      if (seriesCount > 2) {
        assert.equal(
          analysis.series[0].sourceIndex,
          analysis.distributionSelection.selectedIndex,
        );
        assert.equal(
          analysis.series[0].irregularityScore,
          analysis.distributionSelection.irregularityScore,
          "the collapsed target must be the measured most-irregular trace",
        );
      }

      for (let left = 0; left < analysis.series.length; left += 1) {
        for (
          let right = left + 1;
          right < analysis.series.length;
          right += 1
        ) {
          assert.ok(
            alignedCurveSimilarity(
              analysis.series[left].profile,
              analysis.series[right].profile,
            ) < 0.995,
            "physically different color traces must not be deduplicated",
          );
        }
      }
    });
  }
});

test("keeps two traces independent when they closely overlap through the center valleys", () => {
  const fixture = colorSeriesChartFixture({
    width: 600,
    height: 360,
    seriesCount: 2,
    crossingMode: "overlap",
  });
  const foreground = foregroundFor(fixture);
  const separated = extractColorDistributionCandidates(
    foreground.curveColorMasks,
    fixture.width,
    fixture.height,
    fixture.bounds,
  );

  assert.equal(separated.distributionCount, 2);
  assert.equal(separated.candidates.length, 2);
  assert.ok(
    separated.candidates.every(
      (candidate) =>
        candidate.observedColumnRatio >= 0.62 &&
        candidate.separationMode === "color",
    ),
  );

  const analysis = analyzeForegroundMasks(
    foreground.broadMask,
    foreground.salientMask,
    fixture.width,
    fixture.height,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
  );
  assertSeriesContract(analysis, 2);
});

test("keeps a full-width single-peak color independent from a multi-peak color through API and training", async () => {
  const fixture = colorSeriesChartFixture({
    width: 600,
    height: 360,
    seriesCount: 2,
    stateCounts: [1, 4],
    crossingMode: "near",
  });
  const foreground = foregroundFor(fixture);
  const separated = extractColorDistributionCandidates(
    foreground.curveColorMasks,
    fixture.width,
    fixture.height,
    fixture.bounds,
  );

  assert.equal(separated.distributionCount, 2);
  assert.deepEqual(
    [...separated.candidates]
      .sort((left, right) => left.sourceIndex - right.sourceIndex)
      .map((candidate) => candidate.descriptor.stateCount),
    [1, 4],
  );

  const analysis = await analyzeSimilarityImage(
    fixture.bytes,
    fixture.mimeType,
  );
  assertSeriesContract(analysis, 2);
  assert.deepEqual(
    analysis.series
      .map((series) => series.descriptor.stateCount)
      .sort((left, right) => left - right),
    [1, 4],
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  assert.equal(response.panelCount, 1);
  assert.equal(response.panels[0].seriesCount, 2);
  assert.deepEqual(
    response.panels[0].series
      .map((series) => series.query.stateCount)
      .sort((left, right) => left - right),
    [1, 4],
  );

  for (const series of analysis.series) {
    const validated = await validateTrainingWaveformImage({
      bytes: fixture.bytes,
      mimeType: fixture.mimeType,
      profile: series.profile,
      stateCount: series.descriptor.stateCount,
      sourceSelection: {
        panelIndex: 0,
        panelCount: 1,
        seriesIndex: series.seriesIndex,
        seriesCount: 2,
      },
    });
    assert.equal(validated.panelCount, 1);
    assert.equal(validated.seriesCount, 2);
    assert.equal(
      validated.matchedSeriesIndex,
      series.seriesIndex,
    );
    assert.ok(validated.profileSimilarity >= 0.985);
  }
});

test("includes a single-peak color in the irregularity comparison before collapsing three colors", async () => {
  const fixture = colorSeriesChartFixture({
    width: 600,
    height: 360,
    seriesCount: 3,
    stateCounts: [1, 4, 4],
    crossingMode: "near",
  });
  const foreground = foregroundFor(fixture);
  const separated = extractColorDistributionCandidates(
    foreground.curveColorMasks,
    fixture.width,
    fixture.height,
    fixture.bounds,
  );
  assert.equal(separated.distributionCount, 3);
  assert.ok(
    separated.candidates.some(
      (candidate) => candidate.descriptor.stateCount === 1,
    ),
  );

  const analysis = await analyzeSimilarityImage(
    fixture.bytes,
    fixture.mimeType,
  );
  assertSeriesContract(analysis, 1);
  assert.equal(
    analysis.distributionSelection.distributionCount,
    3,
  );
  assert.equal(
    analysis.distributionSelection.targetDistributionCount,
    1,
  );
  assert.equal(
    analysis.distributionSelection.mode,
    "most-irregular-only",
  );
});

test("rejects neutral diagonal and horizontal guides without collapsing two real colors", async (context) => {
  for (const guideMode of ["diagonal", "horizontal"]) {
    await context.test(`${guideMode} guide`, async () => {
      const fixture =
        twoColorChartWithNeutralGuideFixture(guideMode);
      const analysis = await analyzeSimilarityImage(
        fixture.bytes,
        fixture.mimeType,
      );
      assertSeriesContract(analysis, 2);
      assert.equal(
        analysis.distributionSelection.distributionCount,
        2,
      );
      assert.equal(
        analysis.preprocessing.colorSeriesPolicy
          .collapsedToMostIrregular,
        false,
      );
      assert.ok(
        analysis.series.every(
          (series) => series.separationMode === "color",
        ),
      );

      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: publicCorpus,
        origin: "https://dove9999.com",
      });
      assert.equal(response.panelCount, 1);
      assert.equal(response.panels[0].seriesCount, 2);

      const selected = analysis.series[0];
      const validated = await validateTrainingWaveformImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        profile: selected.profile,
        stateCount: selected.descriptor.stateCount,
        sourceSelection: {
          panelIndex: 0,
          panelCount: 1,
          seriesIndex: 0,
          seriesCount: 2,
        },
      });
      assert.equal(validated.panelCount, 1);
      assert.equal(validated.seriesCount, 2);
      assert.equal(validated.matchedSeriesIndex, 0);
    });
  }
});

test("collapses red, blue, and black traces to the most-irregular target without promoting neutral chart furniture", async () => {
  const fixture = chromaticAndNeutralSeriesFixture({
    width: 600,
    height: 360,
  });
  const foreground = foregroundFor(fixture);
  assert.equal(
    foreground.curveColorMasks.length,
    2,
    "the neutral trace must not be mislabeled as a hue mask",
  );

  const analysis = analyzeForegroundMasks(
    foreground.broadMask,
    foreground.salientMask,
    fixture.width,
    fixture.height,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
  );
  assertSeriesContract(analysis, 1);
  assert.equal(
    analysis.distributionSelection.distributionCount,
    3,
  );
  assert.equal(
    analysis.distributionSelection.mode,
    "most-irregular-only",
  );
  assert.equal(
    analysis.preprocessing.colorSeriesPolicy
      .collapsedToMostIrregular,
    true,
  );
  assert.equal(
    analysis.series.filter(
      (series) =>
        !["color", "achromatic"].includes(
          series.separationMode,
        ),
    ).length,
    0,
    "axes, grid lines, ticks and labels must not become extra series",
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 2,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  assert.equal(response.panelCount, 1);
  assert.equal(response.panels[0].seriesCount, 1);
  assert.equal(response.panels[0].series.length, 1);
  assert.deepEqual(
    response.panels[0].series.map(
      (series) => series.trainingSelection,
    ),
    [0].map((seriesIndex) => ({
      panelIndex: 0,
      panelCount: 1,
      seriesIndex,
      seriesCount: 1,
    })),
  );
  assert.deepEqual(
    response.panels[0].trainingSelection,
    response.panels[0].series[
      response.panels[0].selectedSeriesIndex
    ].trainingSelection,
  );
  assert.deepEqual(
    response.trainingSelection,
    response.panels[0].trainingSelection,
  );
  for (const series of response.panels[0].series) {
    assert.equal(series.profile.length, 256);
    assert.equal(
      series.descriptor.stateCount,
      series.descriptor.peakLocations.length,
    );
    assert.equal(
      series.descriptor.valleyLocations.length,
      series.descriptor.stateCount - 1,
    );
  }
  const selectedResponseSeries =
    response.panels[0].series[
      response.panels[0].selectedSeriesIndex
    ];
  assert.deepEqual(
    response.panels[0].profile,
    selectedResponseSeries.profile,
  );
  assert.deepEqual(
    response.panels[0].descriptor,
    selectedResponseSeries.descriptor,
  );
  assert.deepEqual(response.profile, response.panels[0].profile);
  assert.deepEqual(response.descriptor, response.panels[0].descriptor);
  assert.ok(
    ["achromatic", "color"].includes(
      response.panels[0].series[0].separationMode,
    ),
  );
  assert.ok(
    response.panels[0].series.every(
      (series) => series.results.length === 2,
    ),
  );
});

test("combines one chromatic trace with one achromatic residual trace", async () => {
  const fixture = chromaticAndNeutralPairFixture({
    width: 600,
    height: 360,
  });
  const foreground = foregroundFor(fixture);
  assert.equal(
    foreground.curveColorMasks.length,
    1,
    "only the red trace belongs in a hue mask",
  );

  const analysis = analyzeForegroundMasks(
    foreground.broadMask,
    foreground.salientMask,
    fixture.width,
    fixture.height,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
  );
  assertSeriesContract(analysis, 2);
  assert.deepEqual(
    analysis.series
      .map((series) => series.separationMode)
      .sort(),
    ["achromatic", "color"],
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  assert.equal(response.panelCount, 1);
  assert.equal(response.panels[0].seriesCount, 2);
  assert.deepEqual(
    response.panels[0].series
      .map((series) => series.separationMode)
      .sort(),
    ["achromatic", "color"],
  );
  assert.ok(
    response.panels[0].series.every(
      (series) => series.results.length === 1,
    ),
  );
});

test("joins State-segment colors before pairing the distribution with a black trace", async () => {
  const fixture = segmentedChromaticAndNeutralSeriesFixture();
  const foreground = foregroundFor(fixture);
  assert.equal(foreground.curveColorMasks.length, 4);

  const perHue = extractColorDistributionCandidates(
    foreground.curveColorMasks,
    fixture.width,
    fixture.height,
    fixture.bounds,
  );
  assert.equal(
    perHue.candidates.length,
    0,
    "no State segment is a complete distribution by itself",
  );

  const analysis = analyzeForegroundMasks(
    foreground.broadMask,
    foreground.salientMask,
    fixture.width,
    fixture.height,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
  );
  assertSeriesContract(analysis, 2);
  assert.deepEqual(
    analysis.series
      .map((series) => series.separationMode)
      .sort(),
    ["achromatic", "chromatic-union"],
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  assert.equal(response.panelCount, 1);
  assert.equal(response.panels[0].seriesCount, 2);
  assert.deepEqual(
    response.panels[0].series
      .map((series) => series.separationMode)
      .sort(),
    ["achromatic", "chromatic-union"],
  );
});

test("keeps the most-irregular red, blue, or black target stable after slight chart rotation", async (context) => {
  const baselineFixture = chromaticAndNeutralSeriesFixture({
    width: 600,
    height: 360,
  });
  const baseline = await analyzeSimilarityImage(
    baselineFixture.bytes,
    baselineFixture.mimeType,
  );
  assertSeriesContract(baseline, 1);

  for (const angle of [1, 2, 3]) {
    await context.test(`${angle} degree rotation`, async () => {
      const fixture =
        rotatedChromaticAndNeutralSeriesFixture(angle, {
          width: 600,
          height: 360,
        });
      const analysis = await analyzeSimilarityImage(
        fixture.bytes,
        fixture.mimeType,
      );
      assert.equal(analysis.preprocessing.deskewApplied, true);
      assert.ok(
        Math.abs(
          Math.abs(analysis.preprocessing.deskewAngle) - angle,
        ) <= 0.5,
      );
      assertSeriesContract(analysis, 1);
      assert.equal(
        analysis.distributionSelection.mode,
        "most-irregular-only",
      );
      for (
        let seriesIndex = 0;
        seriesIndex < baseline.series.length;
        seriesIndex += 1
      ) {
        assert.ok(
          alignedCurveSimilarity(
            baseline.series[seriesIndex].profile,
            analysis.series[seriesIndex].profile,
          ) >= 0.975,
          "deskewing must keep each series profile stable",
        );
      }

      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: publicCorpus,
        origin: "https://dove9999.com",
      });
      assert.equal(response.panelCount, 1);
      assert.equal(response.panels[0].seriesCount, 1);
      assert.ok(
        response.panels[0].series.every(
          (series) => series.results.length === 1,
        ),
      );
    });
  }
});

test("preserves the single-series response contract for a monochrome chart", async () => {
  const fixture = monochromeSeriesChartFixture({
    width: 600,
    height: 360,
  });
  const foreground = foregroundFor(fixture);
  const analysis = analyzeForegroundMasks(
    foreground.broadMask,
    foreground.salientMask,
    fixture.width,
    fixture.height,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
  );

  assertSeriesContract(analysis, 1);
  assert.equal(
    analysis.distributionSelection.distributionCount,
    1,
  );
  assert.equal(analysis.selectedSeriesIndex, 0);

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 2,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  assert.equal(response.panelCount, 1);
  assert.equal(response.panels[0].seriesCount, 1);
  assert.equal(response.panels[0].selectedSeriesIndex, 0);
  assert.equal(response.panels[0].series.length, 1);
  assert.equal(response.panels[0].series[0].results.length, 2);
  assert.deepEqual(
    response.panels[0].query,
    response.panels[0].series[0].query,
  );
  assert.deepEqual(
    response.panels[0].results,
    response.panels[0].series[0].results,
  );
});

test("search API ranks two color series independently and collapses larger sets", async (context) => {
  for (const seriesCount of [2, 3, 4]) {
    await context.test(`${seriesCount} ranked series`, async () => {
      const fixture = colorSeriesChartFixture({
        width: 600,
        height: 360,
        seriesCount,
        crossingMode: "near",
      });
      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 2,
        corpus: publicCorpus,
        origin: "https://dove9999.com",
      });

      assert.equal(
        response.panelCount,
        1,
        "one coordinate system must stay one physical panel",
      );
      assert.equal(response.panels.length, 1);
      const panel = response.panels[0];
      const targetSeriesCount =
        seriesCount <= 2 ? seriesCount : 1;
      assert.equal(panel.seriesCount, targetSeriesCount);
      assert.equal(panel.series.length, targetSeriesCount);
      assert.deepEqual(
        panel.series.map((series) => series.seriesIndex),
        Array.from(
          { length: targetSeriesCount },
          (_, index) => index,
        ),
      );
      assert.deepEqual(
        panel.series.map((series) => series.selected),
        Array.from(
          { length: targetSeriesCount },
          (_, index) => index === panel.selectedSeriesIndex,
        ),
      );
      assert.ok(
        panel.series.every(
          (series) =>
            series.separationMode === "color" &&
            series.query.distributionCount === seriesCount &&
            series.query.targetDistributionCount ===
              targetSeriesCount &&
            series.query.distributionSelectionMode ===
              (seriesCount <= 2
                ? "most-irregular"
                : "most-irregular-only") &&
            series.query.colorSeriesPolicy
              .collapsedToMostIrregular ===
              (seriesCount > 2) &&
            series.results.length === 2 &&
            series.results.every(
              (result, resultIndex) =>
                result.rank === resultIndex + 1 &&
                Number.isFinite(result.score),
            ),
        ),
      );
      assert.deepEqual(
        panel.query,
        panel.series[panel.selectedSeriesIndex].query,
      );
      assert.deepEqual(
        panel.results,
        panel.series[panel.selectedSeriesIndex].results,
      );
      assert.deepEqual(response.query, panel.query);
      assert.deepEqual(response.results, panel.results);
    });
  }
});

test("verified table-grid topology cannot overwrite a collapsed most-irregular color target", () => {
  const collapsedFixture = colorSeriesChartFixture({
    width: 600,
    height: 360,
    seriesCount: 3,
    crossingMode: "near",
  });
  const collapsedForeground = foregroundFor(collapsedFixture);
  const collapsed = analyzeForegroundMasks(
    collapsedForeground.broadMask,
    collapsedForeground.salientMask,
    collapsedFixture.width,
    collapsedFixture.height,
    collapsedForeground.curveSalientMask,
    collapsedForeground.curveColorMasks,
  );
  assertSeriesContract(collapsed, 1);
  assert.equal(
    collapsed.preprocessing.colorSeriesPolicy
      .collapsedToMostIrregular,
    true,
  );

  const independentFixture = monochromeSeriesChartFixture({
    width: 600,
    height: 360,
  });
  const independentForeground = foregroundFor(
    independentFixture,
  );
  const independent = analyzeForegroundMasks(
    independentForeground.broadMask,
    independentForeground.salientMask,
    independentFixture.width,
    independentFixture.height,
    independentForeground.curveSalientMask,
    independentForeground.curveColorMasks,
  );
  const verifiedEvidence = {
    profile: collapsed.profile,
    descriptor: {
      ...collapsed.descriptor,
      observedStateCount:
        collapsed.descriptor.stateCount,
      regularized: false,
    },
    source: "table-grid-measured-topology",
  };
  const eligibleSingle = applyVerifiedWaveformEvidence(
    independent,
    verifiedEvidence,
  );
  assert.notStrictEqual(
    eligibleSingle,
    independent,
    "the control evidence must be eligible for the normal single-series override",
  );
  assert.equal(
    eligibleSingle.preprocessing.verifiedWaveformEvidence
      .applied,
    true,
  );
  const preserved = applyVerifiedWaveformEvidence(
    collapsed,
    verifiedEvidence,
  );

  assert.strictEqual(
    preserved,
    collapsed,
    "panel-level grid evidence must preserve the selected irregular color trace",
  );
});

test("training provenance exposes only the most-irregular record when more than two colors are detected", async () => {
  const fixture = colorSeriesChartFixture({
    width: 600,
    height: 360,
    seriesCount: 3,
    crossingMode: "near",
  });
  const analysis = await analyzeSimilarityImage(
    fixture.bytes,
    fixture.mimeType,
  );
  assertSeriesContract(analysis, 1);
  assert.equal(
    analysis.distributionSelection.distributionCount,
    3,
  );

  for (const series of analysis.series) {
    const validated = await validateTrainingWaveformImage({
      bytes: fixture.bytes,
      mimeType: fixture.mimeType,
      profile: series.profile,
      stateCount: series.descriptor.stateCount,
    });
    assert.equal(validated.panelCount, 1);
    assert.equal(validated.seriesCount, 1);
    assert.equal(
      validated.matchedSeriesIndex,
      series.seriesIndex,
      "training must bind the submitted profile to the collapsed irregular target",
    );
    assert.ok(validated.profileSimilarity >= 0.985);
  }
});

test("rejects arbitrary 4/9 sourceSelection coordinates on a one-chart crop", async () => {
  const fixture = colorSeriesChartFixture({
    width: 600,
    height: 360,
    seriesCount: 3,
    crossingMode: "near",
  });
  const analysis = await analyzeSimilarityImage(
    fixture.bytes,
    fixture.mimeType,
  );
  assertSeriesContract(analysis, 1);
  const selected = analysis.series[0];
  await assert.rejects(
    () =>
      validateTrainingWaveformImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        profile: selected.profile,
        stateCount: selected.descriptor.stateCount,
        sourceSelection: {
          panelIndex: 4,
          panelCount: 9,
          seriesIndex: 2,
          seriesCount: 3,
        },
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(
        error.code,
        "source_selection_image_mismatch",
      );
      return true;
    },
  );
});

test("sourceSelection re-detects a full document, selects its reading-order panel, and returns only that authoritative JPEG crop", async () => {
  const fixture = mixedPanelColorSeriesFixture();
  const firstReference = colorSeriesChartFixture({
    width: 520,
    height: 330,
    seriesCount: 2,
    crossingMode: "near",
  });
  const secondReference = monochromeSeriesChartFixture({
    width: 520,
    height: 330,
  });
  const firstAnalysis = await analyzeSimilarityImage(
    firstReference.bytes,
    firstReference.mimeType,
  );
  const secondAnalysis = await analyzeSimilarityImage(
    secondReference.bytes,
    secondReference.mimeType,
  );
  const firstSelected = firstAnalysis.series[1];
  const firstValidated = await validateTrainingWaveformImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    profile: firstSelected.profile,
    stateCount: firstSelected.descriptor.stateCount,
    sourceSelection: {
      panelIndex: 0,
      panelCount: 2,
      seriesIndex: 1,
      seriesCount: 2,
    },
  });

  assert.equal(firstValidated.panelCount, 2);
  assert.equal(firstValidated.matchedPanelIndex, 0);
  assert.equal(firstValidated.seriesCount, 2);
  assert.equal(firstValidated.matchedSeriesIndex, 1);
  assert.ok(firstValidated.profileSimilarity >= 0.985);
  assert.ok(
    firstValidated.sourceBounds.width < fixture.width / 2,
    "the stored source must be the selected panel crop, not the slide",
  );
  assert.equal(
    firstValidated.authoritativeSourceImage.mimeType,
    "image/jpeg",
  );
  assert.equal(
    firstValidated.authoritativeSourceImage.width,
    firstValidated.sourceBounds.width,
  );
  assert.equal(
    firstValidated.authoritativeSourceImage.height,
    firstValidated.sourceBounds.height,
  );
  assert.deepEqual(
    [...firstValidated.authoritativeSourceImage.bytes.slice(0, 3)],
    [0xff, 0xd8, 0xff],
  );

  const secondSelected = secondAnalysis.series[0];
  const secondValidated = await validateTrainingWaveformImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    profile: secondSelected.profile,
    stateCount: secondSelected.descriptor.stateCount,
    sourceSelection: {
      panelIndex: 1,
      panelCount: 2,
      seriesIndex: 0,
      seriesCount: 1,
    },
  });
  assert.equal(secondValidated.panelCount, 2);
  assert.equal(secondValidated.matchedPanelIndex, 1);
  assert.equal(secondValidated.seriesCount, 1);
  assert.equal(secondValidated.matchedSeriesIndex, 0);
  assert.ok(
    secondValidated.sourceBounds.x >
      firstValidated.sourceBounds.x,
    "panelIndex must follow detector reading order",
  );
});

test("sourceSelection matches the collapsed irregular profile when JPEG hue ordering changes", async () => {
  const baseline = colorSeriesChartFixture({
    width: 520,
    height: 330,
    seriesCount: 3,
    crossingMode: "near",
  });
  const reordered = colorSeriesChartFixture({
    width: 520,
    height: 330,
    seriesCount: 3,
    crossingMode: "near",
    colors: [
      COLOR_SERIES_PALETTE[2],
      COLOR_SERIES_PALETTE[0],
      COLOR_SERIES_PALETTE[1],
    ],
  });
  const trailing = monochromeSeriesChartFixture({
    width: 520,
    height: 330,
  });
  const document = twoPanelDocumentFixture(
    reordered,
    trailing,
    { jpegQuality: 94 },
  );
  const baselineAnalysis = await analyzeSimilarityImage(
    baseline.bytes,
    baseline.mimeType,
  );
  assertSeriesContract(baselineAnalysis, 1);
  const submitted = baselineAnalysis.series[0];
  const validated = await validateTrainingWaveformImage({
    bytes: document.bytes,
    mimeType: document.mimeType,
    profile: submitted.profile,
    stateCount: submitted.descriptor.stateCount,
    sourceSelection: {
      panelIndex: 0,
      panelCount: 2,
      seriesIndex: 0,
      seriesCount: 1,
    },
  });

  assert.equal(validated.panelCount, 2);
  assert.equal(validated.matchedPanelIndex, 0);
  assert.equal(validated.seriesCount, 1);
  assert.equal(
    validated.matchedSeriesIndex,
    0,
    "the most-irregular shape must remain the sole authoritative target",
  );
  assert.ok(validated.profileSimilarity >= 0.985);
  assert.ok(
    alignedCurveSimilarity(
      validated.authoritativeProfile,
      submitted.profile,
    ) >= 0.985,
  );
});

test("sourceSelection rejects every full-document coordinate or shape mismatch", async (context) => {
  const fixture = mixedPanelColorSeriesFixture();
  const reference = colorSeriesChartFixture({
    width: 520,
    height: 330,
    seriesCount: 2,
    crossingMode: "near",
  });
  const analysis = await analyzeSimilarityImage(
    reference.bytes,
    reference.mimeType,
  );
  const selected = analysis.series[1];
  const baseInput = {
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    profile: selected.profile,
    stateCount: selected.descriptor.stateCount,
  };
  const rejectsSelectionMismatch = async (input) => {
    await assert.rejects(
      () => validateTrainingWaveformImage(input),
      (error) => {
        assert.ok(error instanceof SimilarityApiError);
        assert.equal(error.status, 422);
        assert.equal(
          error.code,
          "source_selection_image_mismatch",
        );
        return true;
      },
    );
  };

  await context.test("panelCount mismatch", () =>
    rejectsSelectionMismatch({
      ...baseInput,
      sourceSelection: {
        panelIndex: 0,
        panelCount: 3,
        seriesIndex: 1,
        seriesCount: 2,
      },
    }),
  );
  await context.test("panelIndex targets another chart", () =>
    rejectsSelectionMismatch({
      ...baseInput,
      sourceSelection: {
        panelIndex: 1,
        panelCount: 2,
        seriesIndex: 1,
        seriesCount: 2,
      },
    }),
  );
  await context.test("seriesCount mismatch", () =>
    rejectsSelectionMismatch({
      ...baseInput,
      sourceSelection: {
        panelIndex: 0,
        panelCount: 2,
        seriesIndex: 1,
        seriesCount: 3,
      },
    }),
  );
  await context.test("profile mismatch", () =>
    rejectsSelectionMismatch({
      ...baseInput,
      profile: Array.from(
        { length: 256 },
        (_, index) => (index % 2 === 0 ? 0 : 1),
      ),
      sourceSelection: {
        panelIndex: 0,
        panelCount: 2,
        seriesIndex: 1,
        seriesCount: 2,
      },
    }),
  );
  await context.test("State mismatch", () =>
    rejectsSelectionMismatch({
      ...baseInput,
      stateCount: 12,
      sourceSelection: {
        panelIndex: 0,
        panelCount: 2,
        seriesIndex: 1,
        seriesCount: 2,
      },
    }),
  );
});

test("sourceSelection rejects an ambiguous profile shared by multiple color series", async () => {
  const fixture = ambiguousTwinSeriesFixture();
  const analysis = await analyzeSimilarityImage(
    fixture.bytes,
    fixture.mimeType,
  );
  assertSeriesContract(analysis, 2);
  assert.ok(
    alignedCurveSimilarity(
      analysis.series[0].profile,
      analysis.series[1].profile,
    ) >= 0.985,
    "fixture must present two independently colored but shape-ambiguous traces",
  );

  await assert.rejects(
    () =>
      validateTrainingWaveformImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        profile: analysis.series[0].profile,
        stateCount:
          analysis.series[0].descriptor.stateCount,
        sourceSelection: {
          panelIndex: 0,
          panelCount: 1,
          seriesIndex: 0,
          seriesCount: 2,
        },
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(
        error.code,
        "source_selection_image_mismatch",
      );
      assert.match(error.message, /모호/);
      return true;
    },
  );
});

test("keeps physical panel and color-series dimensions independent on a mixed slide", async () => {
  const fixture = mixedPanelColorSeriesFixture();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 2,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });

  assert.equal(response.panelCount, 2);
  assert.equal(response.panels.length, 2);
  assert.deepEqual(
    response.panels.map((panel) => panel.seriesCount),
    fixture.expectedPanelSeriesCounts,
  );
  assert.equal(
    response.panels.reduce(
      (total, panel) => total + panel.seriesCount,
      0,
    ),
    3,
  );
  assert.ok(
    response.panels[0].bounds.processed.x <
      response.panels[1].bounds.processed.x,
    "physical chart reading order must remain left to right",
  );
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.series.length === panel.seriesCount &&
        panel.series.every(
          (series) =>
            series.results.length === 2 &&
            series.query.processedWidth <=
              panel.bounds.source.width * 4,
        ),
    ),
  );
  assert.ok(
    response.panels[0].series.every(
      (series) => series.separationMode === "color",
    ),
  );
  assert.equal(response.panels[1].series.length, 1);
  for (const panel of response.panels) {
    assert.deepEqual(
      panel.query,
      panel.series[panel.selectedSeriesIndex].query,
    );
    assert.deepEqual(
      panel.results,
      panel.series[panel.selectedSeriesIndex].results,
    );
  }
});

test("repeated colored table cells never become color series in search or training", async () => {
  const fixture = coloredCellTableFixture();
  const foreground = foregroundFor(fixture);
  assert.ok(
    foreground.curveColorMasks.length >= 4,
    "fixture must contain enough real chromatic ink to challenge hue-only splitting",
  );
  const detected = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  assert.equal(detected.fallbackUsed, false);
  assert.equal(detected.panels.length, 0);
  assert.ok(detected.rejectedNonChartCount >= 1);

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

  const analysis = await analyzeSimilarityImage(
    fixture.bytes,
    fixture.mimeType,
  );
  await assert.rejects(
    () =>
      validateTrainingWaveformImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        profile: analysis.profile,
        stateCount: analysis.descriptor.stateCount,
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

test("a dominant two-colour floating KPI trace cannot bypass the table lattice as VTH", async () => {
  const fixture = coloredFloatingSineTableFixture();
  const foreground = foregroundFor(fixture);
  assert.ok(
    foreground.curveColorMasks.length >=
      fixture.expectedSeriesCount,
    "the negative fixture must exercise two coherent chromatic trajectories",
  );

  const maskResult = detectChartPanelsFromMask(
    foreground.broadMask,
    fixture.width,
    fixture.height,
    {
      edgeEvidenceMask: foreground.salientMask,
      curveEvidenceMask: foreground.curveSalientMask,
      curveColorMasks: foreground.curveColorMasks,
      fallbackToWholeImage: false,
      sourceScale: 1,
    },
  );
  const dominantCandidate =
    maskResult.diagnostics.measuredCandidateSummaries.find(
      (candidate) =>
        candidate.curveValid === true &&
        candidate.colorSeriesCount >=
          fixture.expectedSeriesCount &&
        (candidate.right - candidate.left + 1) *
          (candidate.bottom - candidate.top + 1) >=
          fixture.width * fixture.height * 0.3,
    );
  assert.ok(
    dominantCandidate,
    "the fixture must reach the dominant multi-series decision boundary",
  );
  assert.equal(
    dominantCandidate.finalFilterDiagnostics
      ?.coveredByAxisAlignedTable,
    true,
  );
  assert.equal(
    dominantCandidate.finalFilterDiagnostics
      ?.dominantMultiSeriesStructuralRescue,
    false,
    "floating KPI traces have no accepted VTH floor/topology contract",
  );
  assert.equal(
    dominantCandidate.finalFilterDiagnostics?.accepted,
    false,
  );
  assert.equal(maskResult.panels.length, 0);
  assert.equal(maskResult.fallbackUsed, false);

  const rgbResult = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  assert.equal(rgbResult.panels.length, 0);
  assert.equal(rgbResult.fallbackUsed, false);

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

test("two-column colored cell tables remain non-chart data across row counts and every ingestion boundary", async (context) => {
  for (const rows of [5, 6, 8]) {
    await context.test(`${rows} rows by 2 columns`, async () => {
      const fixture = coloredCellTableFixture({
        width: 800,
        height: 450,
        rows,
        columns: 2,
      });
      const foreground = foregroundFor(fixture);
      assert.ok(
        foreground.curveColorMasks.length >= 4,
        "the table must retain enough chromatic ink to exercise color-series rescue",
      );

      const maskResult = detectChartPanelsFromMask(
        foreground.broadMask,
        fixture.width,
        fixture.height,
      );
      assert.equal(maskResult.panels.length, 0);
      assert.equal(maskResult.fallbackUsed, false);
      assert.ok(maskResult.rejectedNonChartCount >= 1);

      const rgbResult = detectChartPanels(
        fixture.pixels,
        fixture.width,
        fixture.height,
        fixture.channels,
      );
      assert.equal(
        rgbResult.panels.length,
        0,
        "colored cell fills and repeated swatches must not trigger RGB color-series fallback",
      );
      assert.equal(rgbResult.fallbackUsed, false);
      assert.ok(rgbResult.rejectedNonChartCount >= 1);

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

      // Supply a structurally valid caller profile so this assertion reaches
      // the image-provenance detector. A profile extracted from the rejected
      // table has State 0 and is correctly rejected earlier as malformed
      // input, which would not exercise the non-waveform image boundary.
      const validProfile = publicCorpus.candidates.find(
        (candidate) => candidate.stateCount === 4,
      );
      await assert.rejects(
        () =>
          validateTrainingWaveformImage({
            bytes: fixture.bytes,
            mimeType: fixture.mimeType,
            profile: validProfile.profile,
            stateCount: validProfile.stateCount,
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
  }
});

test("rotated multi-column colored cell tables remain non-chart data", async () => {
  const fixture = rotateRgbFixture(
    coloredCellTableFixture({
      width: 800,
      height: 450,
      rows: 6,
      columns: 3,
    }),
    7,
  );
  const detected = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  assert.equal(detected.panels.length, 0);
  assert.equal(detected.fallbackUsed, false);
  assert.ok(detected.rejectedNonChartCount >= 1);

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
