import { encode as encodePng } from "fast-png";

import {
  hybridTableWaveformFixture,
} from "./hybrid-table-waveform-fixture.mjs";

const WHITE = Object.freeze([255, 255, 255]);
const NEUTRAL = Object.freeze([48, 54, 64]);
const LABEL_COLOR = Object.freeze([196, 43, 57]);

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

function eraseChromaticPixels(fixture, pixels, bounds) {
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const offset = pixelOffset(fixture.width, x, y);
      if (isChromaticPixel(pixels, offset)) {
        setPixel(pixels, fixture.width, x, y, WHITE);
      }
    }
  }
}

function fillBounds(fixture, pixels, bounds, color) {
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      setPixel(pixels, fixture.width, x, y, color);
    }
  }
}

function replaceChromaticPixels(
  fixture,
  pixels,
  bounds,
  color,
) {
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const offset = pixelOffset(fixture.width, x, y);
      if (isChromaticPixel(pixels, offset)) {
        setPixel(pixels, fixture.width, x, y, color);
      }
    }
  }
}

function drawLabel(fixture, pixels, target, color) {
  const bounds = target.bounds;
  const cell = target.cellBounds;
  const width = bounds.right - bounds.left + 1;
  // This title-like artifact sits in the table cell's header margin, outside
  // the independent plot frame. It must not damage either the physical frame
  // proof or the ground-truth Curve.
  const left = bounds.left + Math.round(width * 0.12);
  const top = cell.top + 2;
  const glyphWidth = Math.max(3, Math.round(width * 0.025));
  const glyphHeight = Math.min(
    4,
    Math.max(2, bounds.top - top - 2),
  );
  const gap = Math.max(3, Math.round(width * 0.02));
  for (let glyph = 0; glyph < 7; glyph += 1) {
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

function encodeFixture(fixture, pixels) {
  return encodePng({
    width: fixture.width,
    height: fixture.height,
    channels: fixture.channels,
    depth: 8,
    data: pixels,
  });
}

function isolateSinglePeakChart({
  name,
  achromatic = false,
  labelColor = null,
  removeOtherFrames = false,
  removeTargetFrame = false,
}) {
  const base = hybridTableWaveformFixture();
  const target = base.charts.find(
    ({ peakCount }) => peakCount === 1,
  );
  const pixels = base.pixels.slice();
  for (const chart of base.charts) {
    if (chart === target) continue;
    eraseChromaticPixels(base, pixels, chart.bounds);
    if (removeOtherFrames) {
      fillBounds(base, pixels, chart.bounds, WHITE);
    }
  }
  if (achromatic) {
    replaceChromaticPixels(
      base,
      pixels,
      target.bounds,
      NEUTRAL,
    );
  }
  if (labelColor) {
    drawLabel(base, pixels, target, labelColor);
  }
  if (removeTargetFrame) {
    const retainedCurvePixels = [];
    for (
      let y = target.bounds.top;
      y <= target.bounds.bottom;
      y += 1
    ) {
      for (
        let x = target.bounds.left;
        x <= target.bounds.right;
        x += 1
      ) {
        const offset = pixelOffset(base.width, x, y);
        if (isChromaticPixel(pixels, offset)) {
          retainedCurvePixels.push([
            x,
            y,
            pixels[offset],
            pixels[offset + 1],
            pixels[offset + 2],
          ]);
        }
      }
    }
    fillBounds(base, pixels, target.bounds, WHITE);
    for (const [x, y, red, green, blue] of retainedCurvePixels) {
      setPixel(
        pixels,
        base.width,
        x,
        y,
        [red, green, blue],
      );
    }
  }
  return {
    ...base,
    name,
    pixels,
    bytes: encodeFixture(base, pixels),
    charts: removeTargetFrame ? [] : [target],
    target,
    expectedChartCount: removeTargetFrame ? 0 : 1,
    expectedPeakCount: removeTargetFrame ? 0 : 1,
    expectedValleyCount: 0,
    isolatedSinglePeak: true,
    nestedPhysicalFrame: !removeTargetFrame,
  };
}

export function isolatedTableSinglePeakPositiveFixtures() {
  return [
    isolateSinglePeakChart({
      name: "table-isolated-single-peak-color",
    }),
    isolateSinglePeakChart({
      name: "table-isolated-single-peak-achromatic",
      achromatic: true,
    }),
    isolateSinglePeakChart({
      name: "table-isolated-single-peak-neutral-label",
      labelColor: NEUTRAL,
    }),
    isolateSinglePeakChart({
      name: "table-isolated-single-peak-color-label",
      labelColor: LABEL_COLOR,
    }),
    isolateSinglePeakChart({
      name: "table-isolated-single-peak-no-other-frames",
      removeOtherFrames: true,
    }),
  ];
}

export function isolatedTableSinglePeakIconNegativeFixture() {
  return isolateSinglePeakChart({
    name: "table-isolated-single-peak-icon-without-frame",
    removeTargetFrame: true,
  });
}
