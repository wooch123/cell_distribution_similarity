import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  localTablelikeWaveformFixtures,
} from "./helpers/local-tablelike-waveform-fixtures.mjs";

const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);
const fixtures = localTablelikeWaveformFixtures();

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

function normalizedBounds(bounds) {
  if ("left" in bounds) return bounds;
  return {
    left: bounds.x,
    top: bounds.y,
    right: bounds.x + bounds.width - 1,
    bottom: bounds.y + bounds.height - 1,
  };
}

function area(bounds) {
  const value = normalizedBounds(bounds);
  return (
    (value.right - value.left + 1) *
    (value.bottom - value.top + 1)
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

function assertPanelBoundsMatch(response, fixture) {
  const unmatched = new Set(
    response.panels.map((_panel, index) => index),
  );
  for (const expected of fixture.charts) {
    const best = [...unmatched]
      .map((panelIndex) => ({
        panelIndex,
        overlap:
          intersectionArea(
            response.panels[panelIndex].bounds.source,
            expected.bounds,
          ) / area(expected.bounds),
      }))
      .sort(
        (first, second) => second.overlap - first.overlap,
      )[0];
    assert.ok(
      best && best.overlap >= 0.7,
      `${fixture.name}: chart ${expected.index} must have one matching physical crop`,
    );
    unmatched.delete(best.panelIndex);
  }
  assert.equal(
    unmatched.size,
    0,
    `${fixture.name}: no row-wide merge or unrelated crop is allowed`,
  );
}

async function assertApiTopology(fixture) {
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
        (chart) => chart.expectedPeakCount,
      ),
      valleyCounts: fixture.charts.map(
        (chart) => chart.expectedValleyCount,
      ),
    },
    `${fixture.name}: every physical cell must remain an independent distribution in reading order`,
  );
  assertPanelBoundsMatch(response, fixture);
}

test("bilinear local-lattice fixtures preserve exact per-cell peak and valley evidence", async (context) => {
  for (const fixture of fixtures) {
    await context.test(fixture.name, () => {
      for (const chart of fixture.charts) {
        const cropped = cropRgb(fixture, chart.bounds);
        const foreground = buildForegroundMasks(
          cropped.pixels,
          cropped.width,
          cropped.height,
          3,
        );
        const topology = extractUpperArcPeakEvidence(
          foreground.curveSalientMask,
          foreground.curveSalientMask,
          foreground.curveColorMasks,
          cropped.width,
          cropped.height,
          { minimumPeakCount: 1 },
        );
        assert.equal(
          topology.accepted,
          true,
          `${fixture.name}/chart-${chart.index}: source pixels must contain an accepted waveform`,
        );
        assert.equal(
          topology.peakCount,
          chart.expectedPeakCount,
          `${fixture.name}/chart-${chart.index}: fixture peak count drifted`,
        );
        assert.equal(
          topology.descriptor.valleyLocations.length,
          chart.expectedValleyCount,
          `${fixture.name}/chart-${chart.index}: fixture valley count drifted`,
        );
      }
    });
  }
});

test("640x360 half-canvas bilinear lattice remains a passing control", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "half-canvas-4x4-control",
  );
  await assertApiTopology(fixture);
});

test("1280x720 center-small 4x4 lattice separates all 16 charts", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "center-small-4x4",
  );
  await assertApiTopology(fixture);
});

test("1280x720 center-small single row separates all four charts", async () => {
  const fixture = fixtures.find(
    ({ name }) =>
      name === "center-small-single-row-1x4",
  );
  await assertApiTopology(fixture);
});
