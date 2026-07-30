import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import { detectChartPanels } from "../lib/vth-chart-panel-core.mjs";
import { searchSimilarityImage } from "../lib/vth-similarity-api-core.mjs";

const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

// Ground truth is the number of physically rendered lobes, counted from the
// source pixels—not the title text. Several synthetic slides deliberately
// contain a mismatch (for example, "State Count 09" can show ten lobes), so
// using panel order or OCR here would violate shape-only retrieval.
const FIXTURES = [
  {
    name: "scatter-outliers-1672.png",
    sha256:
      "55fd995b425a15f3a5038c1f1abcc6c50f6bf7c52f4bbf32bc6b22bf1ac3862d",
    width: 1672,
    height: 941,
    maximumGridRight: 1150,
    visiblePeakCounts: [
      1, 2, 3, 4,
      5, 6, 7, 8,
      10, 10, 11, 12,
      14, 15, 16, 17,
    ],
  },
  {
    name: "clean-open-axes-1672.png",
    sha256:
      "6c7705d460f0afc169c9f736cc9b2d53339640cfc7ee3fa55e3dec3a24f8fbc1",
    width: 1672,
    height: 941,
    maximumGridRight: 1150,
    visiblePeakCounts: [
      1, 2, 3, 4,
      5, 5, 7, 8,
      8, 8, 10, 12,
      13, 14, 15, 16,
    ],
  },
  {
    name: "annotated-framed-1672.png",
    sha256:
      "5da97d8d264448b530fe55dda3398cc57266ab4ee493cfad8248a147efa0c31e",
    width: 1672,
    height: 941,
    maximumGridRight: 1280,
    visiblePeakCounts: [
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 10, 12,
      13, 15, 17, 18,
    ],
  },
  {
    name: "annotated-open-1280.png",
    sha256:
      "cf07a67d95b46789d24b97565aeea79dd1f01d40e0be2f73f6691410ed6bd54c",
    width: 1280,
    height: 720,
    maximumGridRight: 1000,
    visiblePeakCounts: [
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 10, 12,
      13, 15, 17, 18,
    ],
  },
];

const loadedFixtures = await Promise.all(
  FIXTURES.map(async (fixture) => ({
    ...fixture,
    bytes: await readFile(
      new URL(
        `./fixtures/state-count-sweep/${fixture.name}`,
        import.meta.url,
      ),
    ),
  })),
);

function sourceBounds(panel) {
  if ("left" in panel) return panel;
  const bounds = panel.bounds.source;
  return {
    left: bounds.x,
    top: bounds.y,
    right: bounds.x + bounds.width - 1,
    bottom: bounds.y + bounds.height - 1,
  };
}

function assertExactFourByFourSweep(result, fixture) {
  assert.equal(
    result.fallbackUsed ??
      result.panelDetection?.fallbackUsed,
    false,
  );
  assert.equal(result.panels.length, 16);
  assert.equal(result.detectedPanelCount ?? result.panelCount, 16);
  assert.deepEqual(result.layout ?? result.panelLayout, {
    rows: 4,
    columns: 4,
  });
  assert.ok(
    result.panels.every(
      (panel) =>
        sourceBounds(panel).right <= fixture.maximumGridRight,
    ),
    `${fixture.name} must reject the right-side explanation, table, and trend pane`,
  );
}

test("recovers every 1-to-16 State sweep panel from all four supplied office-slide layouts", () => {
  for (const fixture of loadedFixtures) {
    const digest = createHash("sha256")
      .update(fixture.bytes)
      .digest("hex");
    const decoded = decodePng(fixture.bytes);
    const detected = detectChartPanels(
      decoded.data,
      decoded.width,
      decoded.height,
      decoded.channels,
      { adaptiveUpscale: false },
    );

    assert.equal(digest, fixture.sha256);
    assert.equal(decoded.width, fixture.width);
    assert.equal(decoded.height, fixture.height);
    assertExactFourByFourSweep(detected, fixture);
    assert.equal(
      detected.diagnostics.repeatedGridRecovery.recoveryMode,
      "chromatic-repeated-lattice",
    );
    assert.equal(
      detected.diagnostics.repeatedGridRecovery.waveformCellCount,
      16,
    );
    assert.ok(
      detected.diagnostics.repeatedGridRecovery.turningCellCount >=
        12,
    );
  }
});

test("similarity API preserves all sixteen sweep panels and excludes document distractors", async () => {
  const titleCounts = Array.from(
    { length: 16 },
    (_unused, index) => index + 1,
  );
  assert.ok(
    loadedFixtures.some(
      ({ visiblePeakCounts }) =>
        !visiblePeakCounts.every(
          (count, index) => count === titleCounts[index],
        ),
    ),
    "the regression must remain independent of State-count labels",
  );
  for (const fixture of loadedFixtures) {
    const response = await searchSimilarityImage({
      bytes: fixture.bytes,
      mimeType: "image/png",
      topK: 1,
      corpus: publicCorpus,
      origin: "https://dove9999.com",
    });

    assertExactFourByFourSweep(response, fixture);
    assert.equal(response.panelDetection.analyzedPanelCount, 16);
    assert.equal(response.panelDetection.truncated, false);
    for (const [panelIndex, panel] of response.panels.entries()) {
      const visiblePeakCount =
        fixture.visiblePeakCounts[panelIndex];
      assert.equal(
        panel.query.peakCount,
        visiblePeakCount,
        `${fixture.name}/panel-${panelIndex + 1}: API must preserve the native physical peak count`,
      );
      assert.equal(
        panel.query.observedStateCount,
        visiblePeakCount,
      );
      assert.equal(panel.query.regularized, false);
      assert.equal(
        panel.query.valleyCount,
        visiblePeakCount - 1,
      );
      for (const series of panel.series) {
        assert.equal(
          series.query.topologyConsistent,
          true,
          `${fixture.name}/panel-${panelIndex + 1}/series-${series.seriesIndex + 1}: API topology must be internally consistent`,
        );
        assert.equal(
          series.query.peakCount,
          series.query.stateCount,
        );
        assert.equal(
          series.query.valleyCount,
          Math.max(0, series.query.peakCount - 1),
        );
      }
    }
  }
});
