import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAggressiveEdgeCurveMask,
  buildCurveMask,
  buildForegroundMasks,
  cropCurveMaskToContent,
  deskewForegroundMasks,
  detectPlotBounds,
  estimateDeskewAngle,
  filterCurveComponents,
  rotateBinaryMask,
  suppressPlotLabels,
  suppressMaskNoise,
} from "../lib/vth-image-core.mjs";
import {
  alignedCurveSimilarity,
  canonicalProfileFromCurveMask,
} from "../lib/vth-shape-core.mjs";
import {
  analyzeForegroundMasks,
  distributionIrregularityScore,
  extractColorDistributionCandidates,
  extractCurveDistributionCandidates,
  reconcileStateDescriptor,
  shouldPreferSalientDescriptor,
  shouldPreferRetrievalSalientDescriptor,
} from "../lib/vth-image-analysis-core.mjs";

function drawHorizontal(mask, width, y, startX, endX, thickness = 1) {
  for (let offset = 0; offset < thickness; offset += 1) {
    for (let x = startX; x <= endX; x += 1) {
      mask[(y + offset) * width + x] = 1;
    }
  }
}

function drawVertical(mask, width, x, startY, endY, thickness = 1) {
  for (let offset = 0; offset < thickness; offset += 1) {
    for (let y = startY; y <= endY; y += 1) {
      mask[y * width + x + offset] = 1;
    }
  }
}

function drawCurve(mask, width, startX, endX, baseY, amplitude) {
  let previousY = null;
  for (let x = startX; x <= endX; x += 1) {
    const phase = (x - startX) / Math.max(1, endX - startX);
    const y = Math.round(baseY - Math.sin(phase * Math.PI) * amplitude);
    const fromY = previousY === null ? y : Math.min(previousY, y);
    const toY = previousY === null ? y : Math.max(previousY, y);
    for (let localY = fromY; localY <= toY; localY += 1) {
      for (let offset = -1; offset <= 1; offset += 1) {
        mask[(localY + offset) * width + x] = 1;
      }
    }
    previousY = y;
  }
}

function drawProfile(mask, width, height, profile, baseY, amplitude) {
  let previousY = null;
  for (let x = 0; x < width; x += 1) {
    const profileIndex = Math.round(
      (x / Math.max(1, width - 1)) * (profile.length - 1),
    );
    const y = Math.round(baseY - amplitude * profile[profileIndex]);
    const fromY = previousY === null ? y : Math.min(previousY, y);
    const toY = previousY === null ? y : Math.max(previousY, y);
    for (let localY = fromY; localY <= toY; localY += 1) {
      for (let offset = -1; offset <= 1; offset += 1) {
        if (localY + offset < 0 || localY + offset >= height) continue;
        mask[(localY + offset) * width + x] = 1;
      }
    }
    previousY = y;
  }
}

function gaussianProfile(centers, widths, amplitudes = []) {
  return Array.from({ length: 256 }, (_, index) => {
    const x = index / 255;
    return Math.max(
      ...centers.map((center, peakIndex) => {
        const width = widths[peakIndex] ?? widths.at(-1);
        const amplitude = amplitudes[peakIndex] ?? 1;
        return (
          amplitude *
          Math.exp(-(((x - center) / width) ** 2))
        );
      }),
    );
  });
}

const TEST_GLYPHS = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
};

function drawTestLabel(mask, width, x, y, text, scale = 2) {
  let cursorX = x;
  for (const character of text) {
    const glyph = TEST_GLYPHS[character];
    if (!glyph) {
      cursorX += 3 * scale;
      continue;
    }
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel !== "1") return;
        for (let localY = 0; localY < scale; localY += 1) {
          for (let localX = 0; localX < scale; localX += 1) {
            mask[
              (y + rowIndex * scale + localY) * width +
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

function drawDashedHorizontal(mask, width, y, startX, endX, thickness = 1) {
  for (let offset = 0; offset < thickness; offset += 1) {
    for (let x = startX; x <= endX; x += 1) {
      if ((x - startX) % 7 < 4) mask[(y + offset) * width + x] = 1;
    }
  }
}

function drawDashedVertical(mask, width, x, startY, endY, thickness = 1) {
  for (let offset = 0; offset < thickness; offset += 1) {
    for (let y = startY; y <= endY; y += 1) {
      if ((y - startY) % 7 < 4) mask[y * width + x + offset] = 1;
    }
  }
}

test("detects an open patent-style L axis and excludes outside labels", () => {
  const width = 700;
  const height = 460;
  const mask = new Uint8Array(width * height);
  drawVertical(mask, width, 72, 48, 400, 2);
  drawHorizontal(mask, width, 400, 72, 650, 2);
  drawCurve(mask, width, 110, 280, 330, 120);
  drawCurve(mask, width, 330, 510, 345, 105);
  drawHorizontal(mask, width, 18, 250, 430, 2);

  const bounds = detectPlotBounds(mask, width, height);
  assert.equal(bounds.axesDetected, true);
  assert.equal(bounds.axisMode, "l-axis");
  assert.ok(bounds.left > 72);
  assert.ok(bounds.top >= 48);
  assert.ok(bounds.right < 651);
  assert.ok(bounds.bottom < 401);
});

test("removes internal reference lines and sparse detached labels", () => {
  const width = 700;
  const height = 460;
  const mask = new Uint8Array(width * height);
  drawVertical(mask, width, 72, 48, 400, 2);
  drawHorizontal(mask, width, 400, 72, 650, 2);
  drawCurve(mask, width, 110, 280, 330, 120);
  drawCurve(mask, width, 330, 510, 345, 105);
  drawVertical(mask, width, 560, 90, 380, 2);

  for (let y = 120; y <= 128; y += 1) {
    for (let x = 400; x <= 410; x += 1) mask[y * width + x] = 1;
  }

  const bounds = detectPlotBounds(mask, width, height);
  const cleaned = buildCurveMask(
    suppressMaskNoise(mask, width, height),
    width,
    height,
    bounds,
  );
  const referenceX = 560 - bounds.left;
  const labelX = 405 - bounds.left;
  const labelY = 124 - bounds.top;

  assert.equal(bounds.axisMode, "l-axis");
  assert.ok(cleaned.removedStraightColumns >= 2);
  assert.equal(cleaned.componentFilterApplied, true);
  assert.equal(cleaned.mask[labelY * cleaned.width + labelX], 0);
  assert.equal(
    cleaned.mask.reduce(
      (sum, value, index) =>
        index % cleaned.width === referenceX ? sum + value : sum,
      0,
    ),
    0,
  );
  assert.ok(cleaned.mask.reduce((sum, value) => sum + value, 0) > 500);
});

test("preserves rectangular multi-state plot detection", () => {
  const width = 620;
  const height = 360;
  const mask = new Uint8Array(width * height);
  drawHorizontal(mask, width, 30, 60, 580, 2);
  drawHorizontal(mask, width, 330, 60, 580, 2);
  drawVertical(mask, width, 60, 30, 330, 2);
  drawVertical(mask, width, 580, 30, 330, 2);
  for (let state = 0; state < 16; state += 1) {
    const startX = 72 + state * 30;
    drawCurve(mask, width, startX, startX + 24, 280, 70);
  }

  const bounds = detectPlotBounds(mask, width, height);
  assert.equal(bounds.axesDetected, true);
  assert.equal(bounds.axisMode, "rectangle");
  assert.ok(bounds.right - bounds.left > width * 0.8);
  assert.ok(bounds.bottom - bounds.top > height * 0.8);

  const cleaned = buildCurveMask(
    suppressMaskNoise(mask, width, height),
    width,
    height,
    bounds,
  );
  assert.equal(cleaned.componentFilterApplied, true);
  const content = cropCurveMaskToContent(
    cleaned.mask,
    cleaned.width,
    cleaned.height,
  );
  assert.ok(content.width <= cleaned.width);
  assert.ok(content.height < cleaned.height);
});

test("prefers the full plot frame over dense interior State edges", () => {
  const width = 940;
  const height = 385;
  const mask = new Uint8Array(width * height);
  drawHorizontal(mask, width, 35, 58, 906, 2);
  drawHorizontal(mask, width, 327, 58, 906, 2);
  drawVertical(mask, width, 58, 35, 327, 2);
  drawVertical(mask, width, 906, 35, 327, 2);

  for (let state = 0; state < 16; state += 1) {
    const center = 72 + state * 54;
    drawVertical(mask, width, center, 80, 326, 2);
  }
  drawHorizontal(mask, width, 205, 58, 906, 1);

  const bounds = detectPlotBounds(mask, width, height);

  assert.equal(bounds.axisMode, "rectangle");
  assert.ok(bounds.left <= 62);
  assert.ok(bounds.right >= 902);
  assert.ok(bounds.right - bounds.left > width * 0.85);
  assert.ok(bounds.bottom - bounds.top > height * 0.7);
});

test("ignores a text-like vertical stroke outside a rectangular plot", () => {
  const width = 620;
  const height = 360;
  const mask = new Uint8Array(width * height);
  drawHorizontal(mask, width, 30, 60, 580, 2);
  drawHorizontal(mask, width, 330, 60, 580, 2);
  drawVertical(mask, width, 60, 30, 330, 2);
  drawVertical(mask, width, 580, 30, 330, 2);
  drawVertical(mask, width, 18, 20, 70, 2);
  drawVertical(mask, width, 18, 150, 180, 2);
  drawVertical(mask, width, 18, 290, 340, 2);

  const bounds = detectPlotBounds(mask, width, height);

  assert.equal(bounds.axisMode, "rectangle");
  assert.ok(bounds.left >= 60);
  assert.ok(bounds.right <= 580);
});

test("builds a grid-clean edge hypothesis without erasing curves", () => {
  const width = 620;
  const height = 360;
  const mask = new Uint8Array(width * height);
  drawHorizontal(mask, width, 30, 60, 580, 2);
  drawHorizontal(mask, width, 180, 60, 580, 1);
  drawHorizontal(mask, width, 330, 60, 580, 2);
  drawVertical(mask, width, 60, 30, 330, 2);
  drawVertical(mask, width, 580, 30, 330, 2);
  drawCurve(mask, width, 90, 280, 260, 100);
  drawCurve(mask, width, 330, 540, 270, 105);

  const bounds = detectPlotBounds(mask, width, height);
  const aggressive = buildAggressiveEdgeCurveMask(
    mask,
    width,
    height,
    bounds,
  );
  const gridY = 180 - bounds.top;
  const retainedGridPixels = aggressive.mask.reduce(
    (sum, value, index) =>
      Math.floor(index / aggressive.width) === gridY ? sum + value : sum,
    0,
  );

  assert.equal(bounds.axisMode, "rectangle");
  assert.ok(aggressive.activePixels > 100);
  assert.ok(retainedGridPixels < aggressive.width * 0.1);
});

test("removes a dense solid grid and restores curve crossings", () => {
  const width = 720;
  const height = 420;
  const mask = new Uint8Array(width * height);
  const bounds = {
    left: 50,
    top: 30,
    right: 670,
    bottom: 390,
    axesDetected: true,
    axisMode: "rectangle",
  };
  drawHorizontal(mask, width, 30, 50, 670, 2);
  drawHorizontal(mask, width, 390, 50, 670, 2);
  drawVertical(mask, width, 50, 30, 390, 2);
  drawVertical(mask, width, 670, 30, 390, 2);
  for (const y of [100, 170, 240, 310]) {
    drawHorizontal(mask, width, y, 50, 670, 1);
  }
  for (const x of [150, 270, 390, 510]) {
    drawVertical(mask, width, x, 30, 390, 1);
  }
  drawCurve(mask, width, 72, 350, 320, 245);
  drawCurve(mask, width, 365, 645, 330, 235);

  const cleaned = buildCurveMask(mask, width, height, bounds);
  assert.ok(cleaned.removedStraightRows >= 12);
  assert.ok(cleaned.removedStraightColumns >= 12);
  assert.ok(cleaned.restoredCurvePixels > 20);
  for (const sourceY of [100, 170, 240, 310]) {
    const localY = sourceY - bounds.top;
    let retained = 0;
    for (let x = 0; x < cleaned.width; x += 1) {
      retained += cleaned.mask[localY * cleaned.width + x];
    }
    assert.ok(retained < cleaned.width * 0.08);
  }
  assert.ok(cleaned.mask.reduce((sum, value) => sum + value, 0) > 900);
});

test("removes dashed grid components while retaining a non-grid plateau", () => {
  const width = 520;
  const height = 280;
  const mask = new Uint8Array(width * height);
  drawDashedHorizontal(mask, width, 72, 0, width - 1);
  drawDashedHorizontal(mask, width, 205, 0, width - 1);
  drawDashedVertical(mask, width, 130, 0, height - 1);
  drawDashedVertical(mask, width, 390, 0, height - 1);
  drawHorizontal(mask, width, 135, 165, 340, 3);

  const cleaned = buildCurveMask(mask, width, height, {
    left: 0,
    top: 0,
    right: width - 1,
    bottom: height - 1,
    axesDetected: true,
    axisMode: "rectangle",
  });
  assert.ok(cleaned.removedStraightRows >= 6);
  let verticalGridPixels = 0;
  for (const x of [130, 390]) {
    for (let y = 0; y < height; y += 1) {
      verticalGridPixels += cleaned.mask[y * cleaned.width + x];
    }
  }
  assert.ok(verticalGridPixels < height * 0.08);
  let plateauPixels = 0;
  for (let y = 135; y <= 137; y += 1) {
    for (let x = 165; x <= 340; x += 1) {
      plateauPixels += cleaned.mask[y * width + x];
    }
  }
  assert.ok(plateauPixels > 500);
});

test("removes background speckles, tick marks and partial guide lines", () => {
  const width = 620;
  const height = 360;
  const mask = new Uint8Array(width * height);
  const bounds = {
    left: 60,
    top: 30,
    right: 580,
    bottom: 330,
    axesDetected: true,
    axisMode: "rectangle",
  };
  for (let state = 0; state < 16; state += 1) {
    const startX = 72 + state * 30;
    drawCurve(mask, width, startX, startX + 24, 280, 70);
  }
  drawHorizontal(mask, width, 145, 115, 215, 1);
  drawVertical(mask, width, 430, 90, 155, 1);
  for (const [x, y] of [
    [90, 52],
    [246, 96],
    [360, 198],
    [544, 64],
  ]) {
    mask[y * width + x] = 1;
    mask[(y + 1) * width + x + 1] = 1;
  }
  for (const x of [92, 172, 252, 332, 412, 492, 552]) {
    drawVertical(mask, width, x, 324, 329, 1);
  }

  const cleaned = buildCurveMask(
    suppressMaskNoise(mask, width, height),
    width,
    height,
    bounds,
  );
  const localGuideY = 145 - bounds.top;
  const localGuideX = 430 - bounds.left;
  let horizontalGuideInk = 0;
  let verticalGuideInk = 0;
  for (let x = 115 - bounds.left; x <= 215 - bounds.left; x += 1) {
    horizontalGuideInk += cleaned.mask[localGuideY * cleaned.width + x];
  }
  for (let y = 90 - bounds.top; y <= 155 - bounds.top; y += 1) {
    verticalGuideInk += cleaned.mask[y * cleaned.width + localGuideX];
  }

  assert.equal(cleaned.componentFilterApplied, true);
  assert.ok(cleaned.removedGuideComponents >= 2);
  assert.equal(horizontalGuideInk, 0);
  assert.equal(verticalGuideInk, 0);
  assert.ok(cleaned.mask.reduce((sum, value) => sum + value, 0) > 900);
});

test("preserves a close peak-valley chain while removing surrounding noise", () => {
  const width = 420;
  const height = 220;
  const mask = new Uint8Array(width * height);
  for (let x = 45; x <= 375; x += 1) {
    const normalized = (x - 45) / 330;
    const closePeaks =
      Math.exp(-(((normalized - 0.43) / 0.12) ** 2)) +
      0.98 * Math.exp(-(((normalized - 0.59) / 0.11) ** 2));
    const y = Math.round(175 - closePeaks * 88);
    for (let offset = -1; offset <= 1; offset += 1) {
      mask[(y + offset) * width + x] = 1;
    }
  }
  for (let index = 0; index < 180; index += 1) {
    const x = (index * 97) % width;
    const y = (index * 53) % height;
    mask[y * width + x] = 1;
  }

  const denoised = suppressMaskNoise(mask, width, height);
  const cleaned = filterCurveComponents(denoised, width, height);
  const valleyX = Math.round(45 + 0.51 * 330);
  let valleyInk = 0;
  for (let y = 55; y <= 175; y += 1) {
    for (let x = valleyX - 3; x <= valleyX + 3; x += 1) {
      valleyInk += cleaned.mask[y * width + x];
    }
  }

  assert.equal(cleaned.applied, true);
  assert.ok(valleyInk >= 3);
  assert.ok(cleaned.mask.reduce((sum, value) => sum + value, 0) > 900);
  assert.ok(
    cleaned.mask.reduce((sum, value) => sum + value, 0) <
      mask.reduce((sum, value) => sum + value, 0),
  );
});

test("removes in-plot labels and restores a Curve crossing the label box", () => {
  const width = 520;
  const height = 280;
  const clean = new Uint8Array(width * height);
  const profile = gaussianProfile(
    [0.15, 0.38, 0.62, 0.86],
    [0.06, 0.055, 0.065, 0.06],
    [0.82, 1, 0.74, 0.92],
  );
  drawProfile(clean, width, height, profile, 235, 150);
  const labeled = clean.slice();
  drawTestLabel(labeled, width, 318, 38, "STATE");
  drawTestLabel(labeled, width, 205, 112, "BAD");

  const cleaned = buildCurveMask(labeled, width, height, {
    left: 0,
    top: 0,
    right: width - 1,
    bottom: height - 1,
    axesDetected: true,
    axisMode: "rectangle",
  });
  const cleanProfile = canonicalProfileFromCurveMask(
    clean,
    width,
    height,
  ).profile;
  const labeledProfile = canonicalProfileFromCurveMask(
    cleaned.mask,
    width,
    height,
  ).profile;
  let remainingUpperLabelInk = 0;
  for (let y = 35; y <= 58; y += 1) {
    for (let x = 312; x <= 390; x += 1) {
      remainingUpperLabelInk += cleaned.mask[y * width + x];
    }
  }

  assert.equal(cleaned.labelFilterApplied, true);
  assert.ok(cleaned.removedLabelComponents >= 2);
  assert.ok(cleaned.removedLabelPixels > 100);
  assert.equal(remainingUpperLabelInk, 0);
  assert.ok(alignedCurveSimilarity(cleanProfile, labeledProfile) >= 0.99);
});

test("preserves a regular sequence of measured marker points", () => {
  const width = 420;
  const height = 220;
  const mask = new Uint8Array(width * height);
  for (let marker = 0; marker < 7; marker += 1) {
    const centerX = 120 + marker * 25;
    const centerY = 92;
    for (let y = centerY - 1; y <= centerY + 1; y += 1) {
      for (let x = centerX - 1; x <= centerX + 1; x += 1) {
        mask[y * width + x] = 1;
      }
    }
  }

  const cleaned = suppressPlotLabels(mask, width, height);

  assert.equal(cleaned.applied, false);
  assert.deepEqual(cleaned.mask, mask);
});

test("ignores a narrow partial vertical guide in the canonical profile", () => {
  const width = 520;
  const height = 280;
  const clean = new Uint8Array(width * height);
  drawCurve(clean, width, 30, 245, 235, 150);
  drawCurve(clean, width, 270, 490, 240, 145);
  const guided = clean.slice();
  drawVertical(guided, width, 180, 42, 230, 2);

  const cleanProfile = canonicalProfileFromCurveMask(
    clean,
    width,
    height,
  ).profile;
  const guidedProfile = canonicalProfileFromCurveMask(
    guided,
    width,
    height,
  ).profile;

  assert.ok(alignedCurveSimilarity(cleanProfile, guidedProfile) >= 0.995);
});

test("estimates and corrects a mildly rotated plot frame", () => {
  const width = 640;
  const height = 380;
  const mask = new Uint8Array(width * height);
  drawHorizontal(mask, width, 38, 55, 590, 2);
  drawHorizontal(mask, width, 340, 55, 590, 2);
  drawVertical(mask, width, 55, 38, 340, 2);
  drawVertical(mask, width, 590, 38, 340, 2);
  drawCurve(mask, width, 78, 300, 290, 155);
  drawCurve(mask, width, 330, 565, 300, 150);

  const rotated = rotateBinaryMask(mask, width, height, 3);
  const estimate = estimateDeskewAngle(rotated, width, height);
  const corrected = deskewForegroundMasks(
    rotated,
    rotated,
    width,
    height,
  );
  const bounds = detectPlotBounds(
    corrected.broadMask,
    width,
    height,
  );

  assert.equal(estimate.applied, true);
  assert.ok(Math.abs(estimate.angle + 3) <= 0.25);
  assert.equal(corrected.applied, true);
  assert.equal(bounds.axisMode, "rectangle");
  assert.equal(bounds.axesDetected, true);
});

test("the extended five-degree deskew keeps a physical open L-axis", () => {
  const width = 640;
  const height = 380;
  const mask = new Uint8Array(width * height);
  drawVertical(mask, width, 55, 38, 340, 3);
  drawHorizontal(mask, width, 340, 55, 590, 3);
  for (const [left, right] of [
    [75, 180],
    [200, 305],
    [325, 430],
    [450, 565],
  ]) {
    drawCurve(mask, width, left, right, 325, 180);
  }

  const rotated = rotateBinaryMask(mask, width, height, 5);
  const estimate = estimateDeskewAngle(rotated, width, height);
  const corrected = deskewForegroundMasks(
    rotated,
    rotated,
    width,
    height,
  );
  const bounds = detectPlotBounds(
    corrected.broadMask,
    width,
    height,
  );

  assert.equal(estimate.applied, true);
  assert.ok(Math.abs(estimate.angle + 5) <= 0.25);
  assert.equal(corrected.applied, true);
  assert.equal(
    corrected.extendedAngleFrameRejected,
    undefined,
  );
  assert.equal(bounds.axisMode, "l-axis");
  assert.equal(bounds.axesDetected, true);
});

test("builds identical broad and salience masks from RGB or RGBA pixels", () => {
  const width = 320;
  const height = 180;
  const makePixels = (channels) => {
    const pixels = new Uint8Array(width * height * channels).fill(255);
    const paint = (x, y, r, g, b) => {
      const offset = (y * width + x) * channels;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      if (channels === 4) pixels[offset + 3] = 255;
    };
    for (let x = 0; x < width; x += 1) paint(x, 100, 230, 230, 230);
    for (let y = 0; y < height; y += 1) paint(210, y, 230, 230, 230);
    for (let y = 20; y <= 80; y += 1) paint(300, y, 125, 125, 125);
    for (let x = 35; x <= 285; x += 1) {
      const phase = (x - 35) / 250;
      const y = Math.round(132 - 58 * Math.sin(phase * Math.PI * 2) ** 2);
      for (let offset = -1; offset <= 1; offset += 1) {
        paint(x, y + offset, 25, 100, 220);
      }
    }
    paint(8, 8, 0, 0, 0);
    return pixels;
  };

  const rgb = buildForegroundMasks(makePixels(3), width, height, 3);
  const rgba = buildForegroundMasks(makePixels(4), width, height, 4);
  assert.deepEqual(rgba.broadMask, rgb.broadMask);
  assert.deepEqual(rgba.salientMask, rgb.salientMask);
  assert.deepEqual(rgba.curveSalientMask, rgb.curveSalientMask);
  assert.deepEqual(rgba.curveColorMasks, rgb.curveColorMasks);
  assert.equal(rgb.curveColorMasks.length, 1);
  assert.equal(rgb.broadMask[8 * width + 8], 0);
  assert.equal(rgb.broadMask[100 * width + 25], 1);
  assert.equal(rgb.salientMask[100 * width + 25], 0);
  const curveX = 80;
  const curvePhase = (curveX - 35) / 250;
  const curveY = Math.round(
    132 - 58 * Math.sin(curvePhase * Math.PI * 2) ** 2,
  );
  assert.equal(rgb.salientMask[curveY * width + curveX], 1);
  assert.equal(rgb.salientMask[50 * width + 300], 0);
  assert.equal(rgb.curveSalientMask[50 * width + 300], 1);
});

test("keeps antialiased neutral Curve pixels from an enlarged low-resolution source", () => {
  const width = 120;
  const height = 72;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  for (let x = 12; x <= 108; x += 1) {
    const y = Math.round(
      48 - 18 * Math.sin(((x - 12) / 96) * Math.PI),
    );
    for (let offset = -1; offset <= 1; offset += 1) {
      const pixelOffset = ((y + offset) * width + x) * 3;
      pixels[pixelOffset] = 125;
      pixels[pixelOffset + 1] = 125;
      pixels[pixelOffset + 2] = 125;
    }
  }

  const defaultMasks = buildForegroundMasks(
    pixels,
    width,
    height,
    3,
  );
  const recoveredMasks = buildForegroundMasks(
    pixels,
    width,
    height,
    3,
    { sourceScale: 4 },
  );
  const curveIndex = 30 * width + 60;

  assert.equal(defaultMasks.salientMask[curveIndex], 0);
  assert.equal(recoveredMasks.salientMask[curveIndex], 1);
  assert.equal(recoveredMasks.curveSalientMask[curveIndex], 1);
});

test("does not let an aggressive hypothesis flip a valid physical State count", () => {
  const primary = {
    stateCount: 4,
    observedStateCount: 5,
    regularized: true,
    peakLocations: [0.1, 0.4, 0.7, 0.9],
  };
  const conflicting = {
    stateCount: 8,
    observedStateCount: 8,
    regularized: false,
    peakLocations: Array.from(
      { length: 8 },
      (_, index) => (index + 1) / 9,
    ),
    valleyLocations: Array.from(
      { length: 7 },
      (_, index) => (index + 1.5) / 9,
    ),
  };
  assert.deepEqual(reconcileStateDescriptor(primary, conflicting), primary);
  assert.deepEqual(
    reconcileStateDescriptor(
      { ...primary, stateCount: 0, observedStateCount: 0 },
      conflicting,
    ),
    conflicting,
  );
});

test("prefers an exact salient State count over a noisy regularized count", () => {
  assert.equal(
    shouldPreferSalientDescriptor(
      { stateCount: 16, observedStateCount: 8, regularized: true },
      { stateCount: 8, observedStateCount: 8, regularized: false },
    ),
    true,
  );
  assert.equal(
    shouldPreferSalientDescriptor(
      { stateCount: 8, observedStateCount: 8, regularized: false },
      { stateCount: 4, observedStateCount: 4, regularized: false },
    ),
    false,
  );
  assert.equal(
    shouldPreferSalientDescriptor(
      { stateCount: 8, observedStateCount: 10, regularized: true },
      { stateCount: 4, observedStateCount: 5, regularized: true },
      18,
    ),
    true,
  );
  assert.equal(
    shouldPreferSalientDescriptor(
      { stateCount: 4, observedStateCount: 6, regularized: true },
      { stateCount: 8, observedStateCount: 9, regularized: true },
      2,
    ),
    false,
  );
  assert.equal(
    shouldPreferSalientDescriptor(
      { stateCount: 4, observedStateCount: 3, regularized: true },
      { stateCount: 4, observedStateCount: 5, regularized: true },
      18,
      0.82,
    ),
    true,
  );
  assert.equal(
    shouldPreferSalientDescriptor(
      { stateCount: 8, observedStateCount: 6, regularized: true },
      { stateCount: 5, observedStateCount: 5, regularized: false },
      3,
      0.946596,
    ),
    false,
    "two faint standard States must not switch PNG and JPEG to different Curve hypotheses",
  );
});

test("uses a near-identical salient profile to undo line-split peaks", () => {
  assert.equal(
    shouldPreferRetrievalSalientDescriptor(
      { stateCount: 4, regularized: false },
      { stateCount: 2, regularized: false },
      13,
      0.995,
    ),
    true,
  );
  assert.equal(
    shouldPreferRetrievalSalientDescriptor(
      { stateCount: 8, regularized: false },
      { stateCount: 16, regularized: true },
      13,
      0.995,
    ),
    false,
  );
  assert.equal(
    shouldPreferRetrievalSalientDescriptor(
      { stateCount: 4, regularized: false },
      { stateCount: 2, regularized: false },
      3,
      0.995,
    ),
    false,
  );
});

test("scores asymmetric peak, width, valley and tail geometry as less regular", () => {
  const regular = gaussianProfile(
    [0.2, 0.4, 0.6, 0.8],
    [0.055, 0.055, 0.055, 0.055],
  );
  const irregular = gaussianProfile(
    [0.12, 0.32, 0.68, 0.9],
    [0.045, 0.1, 0.045, 0.12],
    [0.94, 0.72, 1, 0.61],
  );

  assert.ok(
    distributionIrregularityScore(irregular) >
      distributionIrregularityScore(regular) + 0.15,
  );
});

test("selects the most irregular Curve when one image has two distributions", () => {
  const width = 420;
  const height = 280;
  const mask = new Uint8Array(width * height);
  const regular = gaussianProfile(
    [0.2, 0.4, 0.6, 0.8],
    [0.055, 0.055, 0.055, 0.055],
  );
  const irregular = gaussianProfile(
    [0.12, 0.32, 0.68, 0.9],
    [0.045, 0.1, 0.045, 0.12],
    [0.94, 0.72, 1, 0.61],
  );
  drawProfile(mask, width, height, regular, 105, 70);
  drawProfile(mask, width, height, irregular, 245, 90);

  const result = extractCurveDistributionCandidates(
    mask,
    width,
    height,
  );

  assert.equal(result.distributionCount, 2);
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.selected.descriptor.stateCount, 4);
  assert.ok(result.selected.irregularityScore > 0.2);
  assert.ok(
    alignedCurveSimilarity(result.selected.profile, irregular) >
      alignedCurveSimilarity(result.selected.profile, regular),
  );
});

test("separates crossing colored distributions before color-independent scoring", () => {
  const width = 420;
  const height = 280;
  const regularMask = new Uint8Array(width * height);
  const irregularMask = new Uint8Array(width * height);
  const regular = gaussianProfile(
    [0.2, 0.4, 0.6, 0.8],
    [0.055, 0.055, 0.055, 0.055],
  );
  const irregular = gaussianProfile(
    [0.12, 0.32, 0.68, 0.9],
    [0.045, 0.1, 0.045, 0.12],
    [0.94, 0.72, 1, 0.61],
  );
  drawProfile(regularMask, width, height, regular, 235, 120);
  drawProfile(irregularMask, width, height, irregular, 235, 120);

  const result = extractColorDistributionCandidates(
    [regularMask, irregularMask],
    width,
    height,
    {
      left: 0,
      top: 0,
      right: width - 1,
      bottom: height - 1,
      axesDetected: false,
      axisMode: "none",
    },
  );

  assert.equal(result.distributionCount, 2);
  assert.equal(result.selectedIndex, 1);
  assert.ok(
    alignedCurveSimilarity(result.selected.profile, irregular) >
      alignedCurveSimilarity(result.selected.profile, regular),
  );
});

test("exposes every full-width colored series while keeping the most-irregular representative", () => {
  const width = 420;
  const height = 300;
  const regularMask = new Uint8Array(width * height);
  const irregularMask = new Uint8Array(width * height);
  const regular = gaussianProfile(
    [0.2, 0.4, 0.6, 0.8],
    [0.055, 0.055, 0.055, 0.055],
  );
  const irregular = gaussianProfile(
    [0.12, 0.32, 0.68, 0.9],
    [0.045, 0.1, 0.045, 0.12],
    [0.94, 0.72, 1, 0.61],
  );
  drawProfile(regularMask, width, height, regular, 115, 78);
  drawProfile(irregularMask, width, height, irregular, 245, 92);

  const pixels = new Uint8Array(width * height * 3).fill(255);
  for (let index = 0; index < regularMask.length; index += 1) {
    const offset = index * 3;
    if (regularMask[index]) {
      pixels[offset] = 224;
      pixels[offset + 1] = 42;
      pixels[offset + 2] = 54;
    }
    if (irregularMask[index]) {
      pixels[offset] = 28;
      pixels[offset + 1] = 96;
      pixels[offset + 2] = 224;
    }
  }
  const foreground = buildForegroundMasks(
    pixels,
    width,
    height,
    3,
  );
  const analysis = analyzeForegroundMasks(
    foreground.broadMask,
    foreground.salientMask,
    width,
    height,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
  );

  assert.equal(foreground.curveColorMasks.length, 2);
  assert.equal(analysis.series.length, 2);
  assert.equal(analysis.selectedSeriesIndex, 1);
  assert.equal(
    analysis.distributionSelection.selectedSeriesIndex,
    1,
  );
  assert.equal(
    analysis.preprocessing.distributionSeparationMode,
    "color",
  );
  assert.deepEqual(
    analysis.series.map((series) => series.seriesIndex),
    [0, 1],
  );
  assert.deepEqual(
    analysis.series.map((series) => series.separationMode),
    ["color", "color"],
  );
  assert.deepEqual(
    analysis.series.map((series) => series.selected),
    [false, true],
  );
  assert.deepEqual(
    analysis.profile,
    analysis.series[analysis.selectedSeriesIndex].profile,
  );
  assert.ok(
    alignedCurveSimilarity(analysis.series[0].profile, regular) >
      0.98,
  );
  assert.ok(
    alignedCurveSimilarity(analysis.series[1].profile, irregular) >
      0.98,
  );
});

test("keeps consecutive State colors as one distribution series", () => {
  const width = 420;
  const height = 240;
  const fullMask = new Uint8Array(width * height);
  const profile = gaussianProfile(
    [0.13, 0.38, 0.63, 0.87],
    [0.06, 0.055, 0.06, 0.055],
  );
  drawProfile(fullMask, width, height, profile, 190, 130);
  const segmentedColorMasks = Array.from(
    { length: 4 },
    () => new Uint8Array(width * height),
  );
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!fullMask[index]) continue;
      segmentedColorMasks[
        Math.min(3, Math.floor((x / width) * 4))
      ][index] = 1;
    }
  }

  const analysis = analyzeForegroundMasks(
    fullMask,
    fullMask,
    width,
    height,
    fullMask,
    segmentedColorMasks,
  );

  assert.equal(analysis.series.length, 1);
  assert.equal(analysis.selectedSeriesIndex, 0);
  assert.equal(
    analysis.series[0].separationMode,
    "chromatic-union",
  );
  assert.equal(analysis.series[0].selected, true);
  assert.ok(
    alignedCurveSimilarity(analysis.series[0].profile, profile) >
      0.98,
  );
});
