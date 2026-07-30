import assert from "node:assert/strict";
import test from "node:test";

import {
  detectChartPanels,
} from "../lib/vth-chart-panel-core.mjs";
import {
  analyzeForegroundMasks,
} from "../lib/vth-image-analysis-core.mjs";
import {
  buildForegroundMasks,
} from "../lib/vth-image-core.mjs";
import {
  guidedMultiPeakSparklineTextTableFixture,
  guidedSingleRowMultiPeakSparklineTextTableFixture,
  multiPeakSparklineTextTableFixture,
} from "./helpers/half-canvas-tablelike-waveform-fixtures.mjs";
import {
  isolatedTableSinglePeakIconNegativeFixture,
  isolatedTableSinglePeakPositiveFixtures,
} from "./helpers/isolated-table-single-peak-fixtures.mjs";

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

const positives = isolatedTableSinglePeakPositiveFixtures();

test("isolated nested-frame fixtures retain one physical 1-peak Curve before document detection", async (context) => {
  for (const fixture of positives) {
    await context.test(fixture.name, () => {
      const crop = cropRgb(
        fixture,
        fixture.target.plotBounds,
      );
      const masks = buildForegroundMasks(
        crop.pixels,
        crop.width,
        crop.height,
        3,
      );
      const analysis = analyzeForegroundMasks(
        masks.broadMask,
        masks.curveSalientMask,
        crop.width,
        crop.height,
        masks.curveSalientMask,
        masks.curveColorMasks,
      );
      assert.deepEqual(
        {
          peaks:
            analysis.descriptor.peakLocations.length,
          valleys:
            analysis.descriptor.valleyLocations.length,
          regularized:
            analysis.descriptor.regularized === true,
        },
        {
          peaks: 1,
          valleys: 0,
          regularized: false,
        },
        `${fixture.name}: fixture pixels must contain one exact bell-shaped distribution`,
      );
    });
  }
});

test("a strict nested physical frame recovers an isolated table-embedded 1-peak chart", async (context) => {
  for (const fixture of positives) {
    await context.test(fixture.name, () => {
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
        `${fixture.name}: a table document cannot become a whole-image fallback`,
      );
      assert.equal(
        detected.panels.length,
        1,
        `${fixture.name}: only the independently nested physical chart may survive`,
      );
      const [panel] = detected.panels;
      assert.ok(
        intersectionArea(panel, fixture.target.bounds) /
          Math.max(1, area(fixture.target.bounds)) >=
          0.7,
        `${fixture.name}: the panel must bind to the physical nested frame`,
      );
      const descriptor = panel.verifiedWaveform?.descriptor;
      assert.ok(
        descriptor,
        `${fixture.name}: the strict exception needs pixel-verified topology`,
      );
      assert.deepEqual(
        {
          peaks: descriptor.peakLocations.length,
          valleys: descriptor.valleyLocations.length,
          regularized: descriptor.regularized === true,
        },
        {
          peaks: 1,
          valleys: 0,
          regularized: false,
        },
        `${fixture.name}: labels, color mode and neighbouring table frames must not alter topology`,
      );
    });
  }
});

test("table sparklines and an unframed bell icon remain non-chart content", async (context) => {
  const negatives = [
    isolatedTableSinglePeakIconNegativeFixture(),
    multiPeakSparklineTextTableFixture(),
    guidedMultiPeakSparklineTextTableFixture(),
    guidedSingleRowMultiPeakSparklineTextTableFixture(),
  ];
  for (const fixture of negatives) {
    await context.test(fixture.name, () => {
      const detected = detectChartPanels(
        fixture.pixels,
        fixture.width,
        fixture.height,
        fixture.channels,
        { adaptiveUpscale: false },
      );
      assert.equal(
        detected.panels.length,
        0,
        `${fixture.name}: Curve-like table content needs its own strict nested physical frame`,
      );
      assert.equal(
        detected.fallbackUsed,
        false,
        `${fixture.name}: a rejected table artifact must not trigger whole-image fallback`,
      );
    });
  }
});
