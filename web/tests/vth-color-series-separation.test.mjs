import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { detectChartPanels } from "../lib/vth-chart-panel-core.mjs";
import {
  analyzeForegroundMasks,
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
  chromaticAndNeutralPairFixture,
  chromaticAndNeutralSeriesFixture,
  coloredCellTableFixture,
  colorSeriesChartFixture,
  mixedPanelColorSeriesFixture,
  monochromeSeriesChartFixture,
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

test("separates two, three, and four colored distributions despite axes, grids, labels, and crossings", async (context) => {
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
      assertSeriesContract(analysis, seriesCount);
      assert.equal(
        analysis.distributionSelection.distributionCount,
        seriesCount,
      );
      assert.equal(
        analysis.distributionSelection.selectedSeriesIndex,
        analysis.selectedSeriesIndex,
      );
      assert.ok(
        analysis.series.every(
          (series) => series.separationMode === "color",
        ),
      );

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

test("separates a black distribution from red and blue series without promoting neutral chart furniture", async () => {
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
  assertSeriesContract(analysis, 3);
  assert.equal(
    analysis.series.filter(
      (series) => series.separationMode === "color",
    ).length,
    2,
  );
  assert.equal(
    analysis.series.filter(
      (series) => series.separationMode === "achromatic",
    ).length,
    1,
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
  assert.equal(response.panels[0].seriesCount, 3);
  assert.equal(response.panels[0].series.length, 3);
  assert.deepEqual(
    [...response.panels[0].series]
      .map((series) => series.separationMode)
      .sort(),
    ["achromatic", "color", "color"],
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

test("keeps red, blue, and black series separate after slight chart rotation", async (context) => {
  const baselineFixture = chromaticAndNeutralSeriesFixture({
    width: 600,
    height: 360,
  });
  const baseline = await analyzeSimilarityImage(
    baselineFixture.bytes,
    baselineFixture.mimeType,
  );
  assertSeriesContract(baseline, 3);

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
      assertSeriesContract(analysis, 3);
      assert.deepEqual(
        analysis.series
          .map((series) => series.separationMode)
          .sort(),
        ["achromatic", "color", "color"],
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
      assert.equal(response.panels[0].seriesCount, 3);
      assert.deepEqual(
        response.panels[0].series
          .map((series) => series.separationMode)
          .sort(),
        ["achromatic", "color", "color"],
      );
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

test("search API ranks every color series independently without multiplying physical panels", async (context) => {
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
      assert.equal(panel.seriesCount, seriesCount);
      assert.equal(panel.series.length, seriesCount);
      assert.deepEqual(
        panel.series.map((series) => series.seriesIndex),
        Array.from({ length: seriesCount }, (_, index) => index),
      );
      assert.deepEqual(
        panel.series.map((series) => series.selected),
        Array.from(
          { length: seriesCount },
          (_, index) => index === panel.selectedSeriesIndex,
        ),
      );
      assert.ok(
        panel.series.every(
          (series) =>
            series.separationMode === "color" &&
            series.query.distributionCount === seriesCount &&
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

test("training provenance accepts every extracted color series as an independent record", async () => {
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
  assertSeriesContract(analysis, 3);

  for (const series of analysis.series) {
    const validated = await validateTrainingWaveformImage({
      bytes: fixture.bytes,
      mimeType: fixture.mimeType,
      profile: series.profile,
      stateCount: series.descriptor.stateCount,
    });
    assert.equal(validated.panelCount, 1);
    assert.equal(validated.seriesCount, 3);
    assert.equal(
      validated.matchedSeriesIndex,
      series.seriesIndex,
      "training must bind the submitted profile to its source color trace",
    );
    assert.ok(validated.profileSimilarity >= 0.985);
  }
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
