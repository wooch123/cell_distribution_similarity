import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyzeSimilarityImage,
  searchSimilarityImage,
} from "../lib/vth-similarity-api-core.mjs";
import {
  wideFloorTouchWaveformFixtures,
} from "./helpers/wide-floor-touch-waveform-fixtures.mjs";

const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);
const fixtures = wideFloorTouchWaveformFixtures();

function expectedTopology(fixture) {
  return {
    panelCount: fixture.expected.panelCount,
    seriesCounts: [fixture.expected.seriesCount],
    stateCounts: [[fixture.expected.stateCount]],
    peakCounts: [[fixture.expected.peakCount]],
    valleyCounts: [[fixture.expected.valleyCount]],
  };
}

function responseTopology(response) {
  return {
    panelCount: response.panelCount,
    seriesCounts: response.panels.map(
      (panel) => panel.seriesCount,
    ),
    stateCounts: response.panels.map((panel) =>
      panel.series.map(
        (series) => series.descriptor.stateCount,
      ),
    ),
    peakCounts: response.panels.map((panel) =>
      panel.series.map(
        (series) => series.descriptor.peakLocations.length,
      ),
    ),
    valleyCounts: response.panels.map((panel) =>
      panel.series.map(
        (series) => series.descriptor.valleyLocations.length,
      ),
    ),
  };
}

function sourcePanelCoverage(panel, bounds) {
  const panelBounds = panel.bounds.source;
  const panelRight =
    panelBounds.x + panelBounds.width - 1;
  const panelBottom =
    panelBounds.y + panelBounds.height - 1;
  const overlapWidth = Math.max(
    0,
    Math.min(panelRight, bounds.right) -
      Math.max(panelBounds.x, bounds.left) +
      1,
  );
  const overlapHeight = Math.max(
    0,
    Math.min(panelBottom, bounds.bottom) -
      Math.max(panelBounds.y, bounds.top) +
      1,
  );
  return (
    (overlapWidth * overlapHeight) /
    Math.max(
      1,
      (bounds.right - bounds.left + 1) *
        (bounds.bottom - bounds.top + 1),
    )
  );
}

async function searchFixture(fixture) {
  return searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
}

test("wide-state fixtures force API upscale while preserving whole-image 12/11 topology", async (context) => {
  for (const fixture of fixtures) {
    await context.test(fixture.name, async () => {
      const analysis = await analyzeSimilarityImage(
        fixture.bytes,
        fixture.mimeType,
      );
      const actual = {
        sourceWidth: analysis.sourceWidth,
        sourceHeight: analysis.sourceHeight,
        processedWidth: analysis.processedWidth,
        processedHeight: analysis.processedHeight,
        stateCount: analysis.descriptor.stateCount,
        peakCount: analysis.descriptor.peakLocations.length,
        valleyCount: analysis.descriptor.valleyLocations.length,
      };
      const expected = {
        sourceWidth: fixture.expected.sourceWidth,
        sourceHeight: fixture.expected.sourceHeight,
        processedWidth: fixture.expected.processedWidth,
        processedHeight: fixture.expected.processedHeight,
        stateCount: fixture.expected.stateCount,
        peakCount: fixture.expected.peakCount,
        valleyCount: fixture.expected.valleyCount,
      };
      if (fixture.parameters.colorCount === 1) {
        actual.seriesCount = analysis.series.length;
        expected.seriesCount = fixture.expected.seriesCount;
      }
      assert.deepEqual(
        actual,
        expected,
        `${fixture.name}: full-raster topology must remain exact after the API resize`,
      );
    });
  }
});

test("nearby above-floor and gridless cases remain one exact chart", async (context) => {
  const boundaryFixtures = fixtures.filter(
    (fixture) =>
      fixture.name === "dense-above-floor-monochrome" ||
      fixture.name === "gridless-floor-monochrome",
  );
  for (const fixture of boundaryFixtures) {
    await context.test(fixture.name, async () => {
      const response = await searchFixture(fixture);
      assert.deepEqual(
        responseTopology(response),
        expectedTopology(fixture),
        `${fixture.name}: a benign one-factor boundary must not change panel or topology counts`,
      );
    });
  }
});

test("dense grid and floor-touch valleys stay one 12-peak chart across state colors", async (context) => {
  const floorTouchFixtures = fixtures.filter(
    (fixture) =>
      fixture.parameters.denseGrid &&
      fixture.parameters.floorTouch,
  );
  for (const fixture of floorTouchFixtures) {
    await context.test(
      `${fixture.parameters.colorCount} color`,
      async () => {
        const response = await searchFixture(fixture);
        if (fixture.parameters.colorCount === 1) {
          assert.deepEqual(
            responseTopology(response),
            expectedTopology(fixture),
            `${fixture.name}: grid lines inside one enclosing frame must not become independent open-L charts`,
          );
          return;
        }
        assert.equal(
          response.panelCount,
          1,
          `${fixture.name}: state colors must not split one enclosing physical chart`,
        );
        assert.equal(response.panels.length, 1);
        assert.ok(
          sourcePanelCoverage(
            response.panels[0],
            fixture.bounds,
          ) >= 0.9,
          `${fixture.name}: the selected panel must enclose at least 90% of the physical plot`,
        );
      },
    );
  }
});
