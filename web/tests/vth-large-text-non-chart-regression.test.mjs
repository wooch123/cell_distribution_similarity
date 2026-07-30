import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";

import {
  detectChartPanels,
  detectChartPanelsFromMask,
} from "../lib/vth-chart-panel-core.mjs";
import {
  analyzeSimilarityImage,
  searchSimilarityImage,
  SimilarityApiError,
  validateTrainingWaveformImage,
} from "../lib/vth-similarity-api-core.mjs";
import {
  chartsWithLargeLabelsFixtures,
  denseIndependentStateArrayFixtures,
  largeTextOnlyFixtures,
} from "./helpers/large-text-waveform-fixtures.mjs";

const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

function encodeFixture(fixture) {
  return encodePng({
    width: fixture.width,
    height: fixture.height,
    data: fixture.pixels,
    channels: fixture.channels,
  });
}

function encodeJpegFixture(fixture, quality = 32) {
  const rgba = new Uint8Array(
    fixture.width * fixture.height * 4,
  );
  for (
    let sourceOffset = 0, targetOffset = 0;
    sourceOffset < fixture.pixels.length;
    sourceOffset += 3, targetOffset += 4
  ) {
    rgba[targetOffset] = fixture.pixels[sourceOffset];
    rgba[targetOffset + 1] = fixture.pixels[sourceOffset + 1];
    rgba[targetOffset + 2] = fixture.pixels[sourceOffset + 2];
    rgba[targetOffset + 3] = 255;
  }
  return jpeg.encode(
    {
      width: fixture.width,
      height: fixture.height,
      data: rgba,
    },
    quality,
  ).data;
}

function assertWaveformNotFound(error) {
  assert.ok(error instanceof SimilarityApiError);
  assert.equal(error.status, 422);
  assert.equal(error.code, "distribution_waveform_not_found");
  return true;
}

test("large title and body glyphs never become charts at mask, RGB/UI, training, or API boundaries", async (context) => {
  for (const fixture of largeTextOnlyFixtures()) {
    await context.test(fixture.name, async () => {
      const maskResult = detectChartPanelsFromMask(
        fixture.mask,
        fixture.width,
        fixture.height,
      );
      assert.equal(
        maskResult.panels.length,
        0,
        "large glyph strokes must not enter mask-level chart data",
      );
      assert.equal(maskResult.fallbackUsed, false);

      const rgbResult = detectChartPanels(
        fixture.pixels,
        fixture.width,
        fixture.height,
        fixture.channels,
      );
      assert.equal(
        rgbResult.panels.length,
        0,
        "large glyph strokes must not enter the browser RGB detector",
      );
      assert.equal(rgbResult.fallbackUsed, false);

      const bytes = encodeFixture(fixture);
      const analysis = await analyzeSimilarityImage(
        bytes,
        "image/png",
      );
      await assert.rejects(
        () =>
          validateTrainingWaveformImage({
            bytes,
            mimeType: "image/png",
            profile: analysis.profile,
            stateCount: analysis.descriptor.stateCount,
          }),
        assertWaveformNotFound,
        "training must not persist text-only input",
      );
      await assert.rejects(
        () =>
          searchSimilarityImage({
            bytes,
            mimeType: "image/png",
            topK: 1,
            corpus: publicCorpus,
            origin: "https://dove9999.com",
          }),
        assertWaveformNotFound,
        "the public API must reject text-only input",
      );
    });
  }
});

test("low-quality JPEG text cards and rotated titles remain non-chart content", async (context) => {
  const selectedNames = new Set([
    "large-normal-title-rotated-positive",
    "small-two-glyph-caption",
    "large-text-inside-outline-card",
  ]);
  for (const fixture of largeTextOnlyFixtures().filter(({ name }) =>
    selectedNames.has(name),
  )) {
    await context.test(fixture.name, async () => {
      const bytes = encodeJpegFixture(fixture);
      const decoded = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
      });
      const detected = detectChartPanels(
        decoded.data,
        decoded.width,
        decoded.height,
        4,
      );
      assert.equal(detected.panels.length, 0);
      assert.equal(detected.fallbackUsed, false);
      await assert.rejects(
        () =>
          searchSimilarityImage({
            bytes,
            mimeType: "image/jpeg",
            topK: 1,
            corpus: publicCorpus,
            origin: "https://dove9999.com",
          }),
        assertWaveformNotFound,
      );
    });
  }
});

test("shape-based text rejection preserves genuine single- and multi-peak charts with oversized labels", async (context) => {
  for (const fixture of chartsWithLargeLabelsFixtures()) {
    await context.test(fixture.name, async () => {
      for (const result of [
        detectChartPanelsFromMask(
          fixture.mask,
          fixture.width,
          fixture.height,
        ),
        detectChartPanels(
          fixture.pixels,
          fixture.width,
          fixture.height,
          fixture.channels,
        ),
      ]) {
        assert.equal(
          result.panels.length,
          1,
          "the real framed waveform must remain detectable",
        );
        assert.notEqual(
          result.panels[0].detectionReason,
          "whole-image-fallback",
          "large document labels must not replace the physical chart crop",
        );
      }

      const response = await searchSimilarityImage({
        bytes: encodeFixture(fixture),
        mimeType: "image/png",
        topK: 1,
        corpus: publicCorpus,
        origin: "https://dove9999.com",
      });
      assert.equal(response.panels.length, 1);
      assert.equal(
        response.panels[0].query.stateCount,
        fixture.peaks.length,
      );
    });
  }
});

test("dense independent 16-State thumbnails remain searchable and trainable", async (context) => {
  for (const fixture of denseIndependentStateArrayFixtures()) {
    await context.test(fixture.name, async () => {
      for (const result of [
        detectChartPanelsFromMask(
          fixture.mask,
          fixture.width,
          fixture.height,
        ),
        detectChartPanels(
          fixture.pixels,
          fixture.width,
          fixture.height,
          fixture.channels,
        ),
      ]) {
        assert.equal(result.panels.length, 1);
        assert.equal(
          result.panels[0].detectionReason,
          "whole-image-fallback",
        );
      }

      const bytes = encodeFixture(fixture);
      const analysis = await analyzeSimilarityImage(
        bytes,
        "image/png",
      );
      assert.equal(
        analysis.descriptor.stateCount,
        fixture.expectedStateCount,
      );
      await validateTrainingWaveformImage({
        bytes,
        mimeType: "image/png",
        profile: analysis.profile,
        stateCount: analysis.descriptor.stateCount,
      });
      const response = await searchSimilarityImage({
        bytes,
        mimeType: "image/png",
        topK: 1,
        corpus: publicCorpus,
        origin: "https://dove9999.com",
      });
      assert.equal(response.panels.length, 1);
      assert.equal(
        response.panels[0].query.stateCount,
        fixture.expectedStateCount,
      );
      assert.equal(
        response.panels[0].query.valleyCount,
        fixture.expectedStateCount - 1,
      );
      assert.equal(
        response.panels[0].query.topologyConsistent,
        true,
      );
    });
  }
});
