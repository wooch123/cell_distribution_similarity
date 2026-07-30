import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCurveDistributionCandidates,
} from "../lib/vth-image-analysis-core.mjs";
import {
  buildCurveMask,
  rotateBinaryMask,
} from "../lib/vth-image-core.mjs";
import {
  canonicalProfileFromCurveMask,
  descriptorFromProfile,
} from "../lib/vth-shape-core.mjs";

const WIDTH = 697;
const HEIGHT = 347;
const BOUNDS = {
  left: 0,
  top: 0,
  right: WIDTH - 1,
  bottom: HEIGHT - 1,
  axesDetected: true,
  axisMode: "rectangle",
};

const GLYPHS = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};

function paint(mask, x, y, radius = 1) {
  for (let localY = y - radius; localY <= y + radius; localY += 1) {
    for (let localX = x - radius; localX <= x + radius; localX += 1) {
      if (
        localX >= 0 &&
        localX < WIDTH &&
        localY >= 0 &&
        localY < HEIGHT
      ) {
        mask[localY * WIDTH + localX] = 1;
      }
    }
  }
}

function fourStateMask() {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  let previousY = null;
  for (let x = 0; x < WIDTH; x += 1) {
    const progress = x / (WIDTH - 1);
    const density = Math.max(
      ...[0.12, 0.38, 0.64, 0.88].map((center, index) => {
        const width = [0.07, 0.085, 0.06, 0.08][index];
        const amplitude = [0.9, 0.72, 1, 0.82][index];
        return amplitude * Math.exp(-(((progress - center) / width) ** 2));
      }),
    );
    const y = Math.round(175 - density * 118);
    if (previousY === null) {
      paint(mask, x, y);
    } else {
      for (
        let localY = Math.min(previousY, y);
        localY <= Math.max(previousY, y);
        localY += 1
      ) {
        paint(mask, x, localY);
      }
    }
    previousY = y;
  }
  return mask;
}

function drawLabel(mask, text, x, y, scale = 4) {
  let cursorX = x;
  for (const character of text) {
    const glyph = GLYPHS[character];
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((value, columnIndex) => {
        if (value !== "1") return;
        for (let localY = 0; localY < scale; localY += 1) {
          for (let localX = 0; localX < scale; localX += 1) {
            mask[
              (y + rowIndex * scale + localY) * WIDTH +
                cursorX +
                columnIndex * scale +
                localX
            ] = 1;
          }
        }
      });
    });
    cursorX += 7 * scale;
  }
}

function drawLine(mask, startX, startY, endX, endY, radius = 1) {
  const steps = Math.max(
    1,
    Math.abs(endX - startX),
    Math.abs(endY - startY),
  );
  for (let step = 0; step <= steps; step += 1) {
    const fraction = step / steps;
    paint(
      mask,
      Math.round(startX + (endX - startX) * fraction),
      Math.round(startY + (endY - startY) * fraction),
      radius,
    );
  }
}

function assertSingleFourState(mask, context) {
  const cleaned = buildCurveMask(mask, WIDTH, HEIGHT, BOUNDS);
  const distributions = extractCurveDistributionCandidates(
    cleaned.mask,
    cleaned.width,
    cleaned.height,
  );
  const canonical = canonicalProfileFromCurveMask(
    cleaned.mask,
    cleaned.width,
    cleaned.height,
  );
  const descriptor = descriptorFromProfile(canonical.profile);

  assert.equal(
    distributions.distributionCount,
    1,
    `${context}: annotation ink must not create another distribution series`,
  );
  assert.equal(descriptor.stateCount, 4, `${context}: peak count`);
  assert.equal(descriptor.peakLocations.length, 4, `${context}: peaks`);
  assert.equal(descriptor.valleyLocations.length, 3, `${context}: valleys`);
  return cleaned;
}

function leaderedLabelMask({ rotate = 0 } = {}) {
  const curve = fourStateMask();
  const annotation = new Uint8Array(WIDTH * HEIGHT);
  drawLabel(annotation, "STATE", 250, 238, 4);
  // These short leader/swatch fragments deliberately sit immediately outside
  // the label-removal padding. The former interpolation gate treated them as
  // a Curve on both sides and drew a new 188-pixel distribution track.
  drawLine(annotation, 178, 251, 221, 251);
  drawLine(annotation, 410, 251, 453, 251);
  const placed =
    rotate === 0
      ? annotation
      : rotateBinaryMask(annotation, WIDTH, HEIGHT, rotate);
  for (let index = 0; index < curve.length; index += 1) {
    curve[index] ||= placed[index];
  }
  return curve;
}

test("25px-class detached label and legend leaders do not create a series", () => {
  const cleaned = assertSingleFourState(
    leaderedLabelMask(),
    "detached 25px-class label",
  );
  assert.equal(cleaned.labelFilterApplied, true);
  assert.ok(cleaned.removedLabelComponents >= 2);
  assert.equal(cleaned.restoredLabelCrossingPixels, 0);
});

test("a five-degree detached label remains annotation ink", () => {
  assertSingleFourState(
    leaderedLabelMask({ rotate: 5 }),
    "five-degree detached label",
  );
});

test("a touching 39px-class branch is not an independent distribution", () => {
  const mask = fourStateMask();
  // The 160-column branch models a large glyph/callout touching a Curve.
  // It exceeds the historical 16% multi-column gate but is independently
  // visible over less than 30% of the plot and therefore is not a full trace.
  for (let x = 260; x <= 420; x += 1) {
    const progress = (x - 260) / 160;
    const y = Math.round(185 + 34 * Math.sin(progress * Math.PI));
    paint(mask, x, y);
  }
  drawLine(mask, 260, 185, 260, 151);
  drawLine(mask, 420, 185, 420, 137);

  assertSingleFourState(mask, "touching 39px-class branch");
});

test("a detached 124px outline callout is removed from topology", () => {
  const mask = fourStateMask();
  const left = 250;
  const top = 238;
  const width = 124;
  const height = 12;
  drawLine(mask, left, top, left + width, top, 0);
  drawLine(mask, left, top + height, left + width, top + height, 0);
  drawLine(mask, left, top, left, top + height, 0);
  drawLine(mask, left + width, top, left + width, top + height, 0);

  const cleaned = assertSingleFourState(
    mask,
    "detached 124px outline",
  );
  assert.equal(cleaned.labelFilterApplied, true);
  assert.equal(cleaned.restoredLabelCrossingPixels, 0);
});
