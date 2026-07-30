import assert from "node:assert/strict";
import test from "node:test";

import {
  detectChartPanels,
} from "../lib/vth-chart-panel-core.mjs";
import {
  sharedBoundaryHalfCanvasLatticeFixture,
} from "./helpers/half-canvas-tablelike-waveform-fixtures.mjs";

const WHITE = Object.freeze([255, 255, 255]);
const NEUTRAL_LABEL = Object.freeze([43, 49, 61]);
const COLOR_LABEL = Object.freeze([201, 48, 63]);

function pixelOffset(width, x, y) {
  return (y * width + x) * 3;
}

function setPixel(pixels, width, x, y, color) {
  const offset = pixelOffset(width, x, y);
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function isChromaticPixel(pixels, offset) {
  const red = pixels[offset];
  const green = pixels[offset + 1];
  const blue = pixels[offset + 2];
  return (
    Math.max(red, green, blue) -
      Math.min(red, green, blue) >=
      42 &&
    Math.min(red, green, blue) <= 210
  );
}

function eraseCurvePixels(
  fixture,
  pixels,
  chart,
  { centerOnly = false } = {},
) {
  const chartWidth =
    chart.bounds.right - chart.bounds.left + 1;
  const centerLeft =
    chart.bounds.left + Math.round(chartWidth * 0.35);
  const centerRight =
    chart.bounds.left + Math.round(chartWidth * 0.65);
  for (
    let y = chart.bounds.top;
    y <= chart.bounds.bottom;
    y += 1
  ) {
    for (
      let x = chart.bounds.left;
      x <= chart.bounds.right;
      x += 1
    ) {
      if (
        centerOnly &&
        (x < centerLeft || x > centerRight)
      ) {
        continue;
      }
      const offset = pixelOffset(fixture.width, x, y);
      if (isChromaticPixel(pixels, offset)) {
        setPixel(pixels, fixture.width, x, y, WHITE);
      }
    }
  }
}

function drawChartLabel(fixture, pixels, chart, color) {
  const chartWidth =
    chart.bounds.right - chart.bounds.left + 1;
  const chartHeight =
    chart.bounds.bottom - chart.bounds.top + 1;
  // Keep the pseudo title above the plot ink. The label is an artifact to
  // remove, not a destructive overwrite of the ground-truth Curve.
  const top =
    chart.bounds.top + Math.max(3, Math.round(chartHeight * 0.035));
  const left =
    chart.bounds.left + Math.max(8, Math.round(chartWidth * 0.1));
  const glyphHeight = Math.max(
    4,
    Math.round(chartHeight * 0.055),
  );
  const glyphWidth = Math.max(
    3,
    Math.round(chartWidth * 0.035),
  );
  const gap = Math.max(3, Math.round(chartWidth * 0.025));
  for (let glyph = 0; glyph < 6; glyph += 1) {
    const glyphLeft = left + glyph * (glyphWidth + gap);
    for (let y = top; y <= top + glyphHeight; y += 1) {
      for (
        let x = glyphLeft;
        x <= glyphLeft + glyphWidth;
        x += 1
      ) {
        const border =
          x === glyphLeft ||
          x === glyphLeft + glyphWidth ||
          y === top ||
          y === top + glyphHeight ||
          (glyph % 2 === 0 &&
            y === top + Math.round(glyphHeight * 0.5));
        if (border) {
          setPixel(
            pixels,
            fixture.width,
            x,
            y,
            color,
          );
        }
      }
    }
  }
}

function mutateFixture(base, indexes, mode) {
  const pixels = base.pixels.slice();
  for (const index of indexes) {
    const chart = base.charts[index];
    if (mode === "delete") {
      eraseCurvePixels(base, pixels, chart);
    } else if (mode === "center-gap") {
      eraseCurvePixels(base, pixels, chart, {
        centerOnly: true,
      });
    } else if (mode === "neutral-label") {
      drawChartLabel(base, pixels, chart, NEUTRAL_LABEL);
    } else if (mode === "color-label") {
      drawChartLabel(base, pixels, chart, COLOR_LABEL);
    }
  }
  return {
    ...base,
    pixels,
  };
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

function matchPanelsOneToOne(panels, expectedCharts) {
  const adjacency = expectedCharts.map((chart) =>
    panels
      .map((panel, panelIndex) => ({
        panelIndex,
        overlap:
          intersectionArea(panel, chart.bounds) /
          Math.max(1, area(chart.bounds)),
      }))
      .filter(({ overlap }) => overlap >= 0.65)
      .sort(
        (first, second) => second.overlap - first.overlap,
      ),
  );
  const expectedForPanel = new Array(panels.length).fill(-1);
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
    if (assign(expectedIndex, new Set())) {
      matchedCount += 1;
    }
  }
  const panelForExpected = new Array(
    expectedCharts.length,
  ).fill(-1);
  for (
    let panelIndex = 0;
    panelIndex < expectedForPanel.length;
    panelIndex += 1
  ) {
    const expectedIndex = expectedForPanel[panelIndex];
    if (expectedIndex >= 0) {
      panelForExpected[expectedIndex] = panelIndex;
    }
  }
  return {
    matchedCount,
    unmatchedPanelCount: expectedForPanel.filter(
      (expectedIndex) => expectedIndex === -1,
    ).length,
    panelForExpected,
  };
}

const affectedIndexesByCount = Object.freeze({
  1: Object.freeze([5]),
  2: Object.freeze([0, 15]),
  4: Object.freeze([0, 5, 10, 15]),
});

test("a damaged 4x4 table cohort preserves every independently verified cell without synthesizing missing cells", async (context) => {
  for (const mode of [
    "delete",
    "center-gap",
    "neutral-label",
    "color-label",
  ]) {
    for (const affectedCount of [1, 2, 4]) {
      await context.test(
        `${mode}/${affectedCount}-cells`,
        () => {
          const base =
            sharedBoundaryHalfCanvasLatticeFixture();
          const affectedIndexes =
            affectedIndexesByCount[affectedCount];
          const fixture = mutateFixture(
            base,
            affectedIndexes,
            mode,
          );
          const curveDamaged =
            mode === "delete" || mode === "center-gap";
          const affected = new Set(affectedIndexes);
          const expectedCharts = curveDamaged
            ? fixture.charts.filter(
                (_chart, index) => !affected.has(index),
              )
            : fixture.charts;
          const damagedCharts = curveDamaged
            ? fixture.charts.filter(
                (_chart, index) => affected.has(index),
              )
            : [];

          const detected = detectChartPanels(
            fixture.pixels,
            fixture.width,
            fixture.height,
            fixture.channels,
            { adaptiveUpscale: false },
          );
          assert.equal(
            detected.fallbackUsed,
            false,
            `${mode}/${affectedCount}: a table cohort must never become a whole-image fallback`,
          );
          assert.equal(
            detected.panels.length,
            expectedCharts.length,
            `${mode}/${affectedCount}: return only cells whose Curve topology remains exact`,
          );

          const matching = matchPanelsOneToOne(
            detected.panels,
            expectedCharts,
          );
          assert.deepEqual(
            {
              matchedCount: matching.matchedCount,
              unmatchedPanelCount:
                matching.unmatchedPanelCount,
            },
            {
              matchedCount: expectedCharts.length,
              unmatchedPanelCount: 0,
            },
            `${mode}/${affectedCount}: every retained panel must bind one-to-one to a physical source cell`,
          );

          for (
            let expectedIndex = 0;
            expectedIndex < expectedCharts.length;
            expectedIndex += 1
          ) {
            const expected = expectedCharts[expectedIndex];
            const panel =
              detected.panels[
                matching.panelForExpected[expectedIndex]
              ];
            const descriptor =
              panel.verifiedWaveform?.descriptor;
            assert.ok(
              descriptor,
              `${mode}/${affectedCount}/chart-${expected.index}: retained cells need verified physical topology`,
            );
            assert.deepEqual(
              {
                peaks: descriptor.peakLocations.length,
                valleys: descriptor.valleyLocations.length,
              },
              {
                peaks: expected.peakCount,
                valleys: expected.peakCount - 1,
              },
              `${mode}/${affectedCount}/chart-${expected.index}: labels and cohort recovery must not invent or drop extrema`,
            );
          }

          for (const damaged of damagedCharts) {
            assert.equal(
              detected.panels.some(
                (panel) =>
                  intersectionArea(panel, damaged.bounds) /
                    Math.max(1, area(damaged.bounds)) >=
                  0.65,
              ),
              false,
              `${mode}/${affectedCount}/chart-${damaged.index}: a topology-damaged cell must not be synthesized from its neighbours`,
            );
          }
        },
      );
    }
  }
});
