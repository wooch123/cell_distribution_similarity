import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  detectChartPanels,
} from "../lib/vth-chart-panel-core.mjs";
import {
  searchSimilarityImage,
  SimilarityApiError,
} from "../lib/vth-similarity-api-core.mjs";
import {
  tinyColoredTableFixture,
  tinyFourChartFixture,
  tinyGridDecoratedWaveformFixture,
  tinyNeutralGridDecoratedWaveformFixture,
  tinyTwelveChartFixture,
} from "./helpers/tiny-multichart-fixtures.mjs";
import {
  uiScaledRgba,
} from "./helpers/ui-raster-scale.mjs";

const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

function uiDetection(fixture) {
  const raster = uiScaledRgba(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  return {
    raster,
    detected: detectChartPanels(
      raster.pixels,
      raster.width,
      raster.height,
      raster.channels,
      { sourceScale: raster.scale },
    ),
  };
}

function panelCenter(bounds) {
  if ("x" in bounds) {
    return {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
  }
  return {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  };
}

function assertEveryExpectedChartMatched(
  actualBounds,
  expectedCharts,
  scale,
  tolerance,
) {
  assert.equal(actualBounds.length, expectedCharts.length);
  const unmatched = new Set(
    actualBounds.map((_bounds, index) => index),
  );
  for (const expected of expectedCharts) {
    const expectedCenter = panelCenter(expected);
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const index of unmatched) {
      const actualCenter = panelCenter(actualBounds[index]);
      const distance = Math.hypot(
        actualCenter.x - expectedCenter.x * scale,
        actualCenter.y - expectedCenter.y * scale,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    assert.notEqual(bestIndex, -1);
    assert.ok(
      bestDistance <= tolerance,
      `tiny chart near ${expectedCenter.x},${expectedCenter.y} was merged or missed`,
    );
    unmatched.delete(bestIndex);
  }
}

test("UI and API separate four variable-size charts from a 160 by 90 PNG", async () => {
  const fixture = tinyFourChartFixture();
  const { raster, detected } = uiDetection(fixture);
  assert.equal(raster.scale, 12);
  assert.deepEqual(
    [raster.width, raster.height],
    [1920, 1080],
  );
  assert.equal(detected.fallbackUsed, false);
  assert.equal(
    detected.panels.length,
    fixture.expectedChartCount,
  );
  assertEveryExpectedChartMatched(
    detected.panels,
    fixture.charts,
    raster.scale,
    60,
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });
  assert.equal(response.panelCount, fixture.expectedChartCount);
  assert.equal(
    response.panelDetection.detectedPanelCount,
    fixture.expectedChartCount,
  );
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.results.length === 1 &&
        panel.bounds.processed.width >=
          panel.bounds.source.width * 3,
    ),
  );
  assert.ok(
    response.panels.some(
      (panel) => panel.query.observedStateCount <= 2,
    ),
    "at least one compact single-peak trace must survive",
  );
});

test("UI and API separate twelve weak-boundary and single-peak charts from a 240 by 135 PNG", async () => {
  const fixture = tinyTwelveChartFixture();
  const { raster, detected } = uiDetection(fixture);
  assert.equal(raster.scale, 8);
  assert.deepEqual(
    [raster.width, raster.height],
    [1920, 1080],
  );
  assert.equal(detected.fallbackUsed, false);
  assert.equal(
    detected.panels.length,
    fixture.expectedChartCount,
  );
  assertEveryExpectedChartMatched(
    detected.panels,
    fixture.charts,
    raster.scale,
    38,
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });
  assert.equal(response.panelCount, fixture.expectedChartCount);
  assert.equal(
    response.panelDetection.detectedPanelCount,
    fixture.expectedChartCount,
  );
  assert.equal(response.panelDetection.truncated, false);
  assert.ok(
    response.panelLayout.rows >= 3 &&
      response.panelLayout.columns >= 3,
  );
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.results.length === 1 &&
        panel.bounds.source.width >= 30 &&
        panel.bounds.source.height >= 20,
    ),
  );
  assert.ok(
    response.panels.filter(
      (panel) => panel.query.observedStateCount <= 2,
    ).length >= 4,
    "all compact single-peak charts must remain independent",
  );
});

test("a real distribution survives a dense table-like grid at tiny resolution", async () => {
  const fixture = tinyGridDecoratedWaveformFixture();
  const { raster, detected } = uiDetection(fixture);
  assert.equal(raster.scale, 8);
  assert.equal(detected.panels.length, 1);
  assert.equal(detected.fallbackUsed, false);
  assert.ok(
    detected.panels[0].width >= raster.width * 0.78 &&
      detected.panels[0].height >= raster.height * 0.72,
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 2,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });
  assert.equal(response.panelCount, 1);
  assert.equal(response.panels[0].results.length, 2);
  assert.ok(response.panels[0].query.observedStateCount >= 3);
});

test("a neutral-black distribution also survives the dense table-like grid", async () => {
  const fixture = tinyNeutralGridDecoratedWaveformFixture();
  const { raster, detected } = uiDetection(fixture);
  assert.equal(raster.scale, 8);
  assert.equal(detected.fallbackUsed, false);
  assert.equal(detected.panels.length, 1);
  assert.ok(
    detected.panels[0].width >= raster.width * 0.78 &&
      detected.panels[0].height >= raster.height * 0.72,
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 2,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });
  assert.equal(response.panelCount, 1);
  assert.equal(response.panels[0].seriesCount, 1);
  assert.equal(response.panels[0].results.length, 2);
  assert.ok(response.panels[0].query.observedStateCount >= 3);
});

test("an equally small colored table remains excluded by UI and API", async () => {
  const fixture = tinyColoredTableFixture();
  const { raster, detected } = uiDetection(fixture);
  assert.equal(raster.scale, 8);
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
        origin: "http://127.0.0.1:4173",
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
