import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import {
  cropInterleavedPixels,
  detectChartPanels,
  detectChartPanelsFromMask,
  repairLowResolutionLineMask,
} from "../lib/vth-chart-panel-core.mjs";

const pptSample = decodePng(
  await readFile(
    new URL(
      "../public/samples/vnand-ppt-12-chart-sample.png",
      import.meta.url,
    ),
  ),
);
const randomSampleManifest = JSON.parse(
  await readFile(
    new URL(
      "../public/samples/random-multichart-samples.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function drawLine(mask, width, x1, y1, x2, y2, thickness = 1) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let localY = y; localY < y + thickness; localY += 1) {
      for (let localX = x; localX < x + thickness; localX += 1) {
        if (
          localX >= 0 &&
          localX < width &&
          localY >= 0 &&
          localY * width + localX < mask.length
        ) {
          mask[localY * width + localX] = 1;
        }
      }
    }
  }
}

function drawFrame(mask, width, left, top, right, bottom) {
  drawLine(mask, width, left, top, right, top, 2);
  drawLine(mask, width, left, bottom, right, bottom, 2);
  drawLine(mask, width, left, top, left, bottom, 2);
  drawLine(mask, width, right, top, right, bottom, 2);
}

function drawCurve(mask, width, left, top, right, bottom, phase = 0) {
  const center = (top + bottom) / 2;
  const amplitude = (bottom - top) * 0.3;
  for (let x = left; x <= right; x += 1) {
    const progress = (x - left) / Math.max(1, right - left);
    const y = Math.round(
      center -
        amplitude *
          (0.6 * Math.sin(progress * Math.PI * 4 + phase) +
            0.25 * Math.sin(progress * Math.PI * 9)),
    );
    drawLine(mask, width, x, y, x + 1, y, 2);
  }
}

function drawFiveStateGaussianCurve(
  mask,
  width,
  left,
  top,
  right,
  bottom,
) {
  const centers = [0.1, 0.3, 0.5, 0.7, 0.9];
  let previous;
  for (let x = left + 8; x <= right - 8; x += 1) {
    const progress =
      (x - left - 8) / Math.max(1, right - left - 16);
    const response = Math.max(
      ...centers.map((center) =>
        Math.exp(
          -0.5 * ((progress - center) / 0.055) ** 2,
        ),
      ),
    );
    const y = Math.round(
      bottom - 10 - response * (bottom - top) * 0.52,
    );
    if (previous) {
      drawLine(
        mask,
        width,
        previous.x,
        previous.y,
        x,
        y,
        2,
      );
    }
    previous = { x, y };
  }
}

function drawLabel(mask, width, left, top, textWidth) {
  const glyphWidth = 5;
  const glyphGap = 3;
  const glyphCount = Math.max(
    1,
    Math.floor(textWidth / (glyphWidth + glyphGap)),
  );
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const x = left + glyph * (glyphWidth + glyphGap);
    drawLine(mask, width, x, top, x + glyphWidth, top, 2);
    drawLine(mask, width, x, top, x, top + 7, 1);
    if (glyph % 2 === 0) {
      drawLine(mask, width, x, top + 7, x + glyphWidth, top + 7);
    }
  }
}

function breakAxisRuns(
  mask,
  width,
  height,
  left,
  top,
  right,
  bottom,
  mode,
) {
  const clear = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    mask[y * width + x] = 0;
  };
  for (let x = left + 7; x < right - 4; x += 13) {
    for (let gap = 0; gap < 3; gap += 1) {
      for (const y of mode === "rectangle"
        ? [top, top + 1, bottom, bottom + 1]
        : [bottom, bottom + 1]) {
        clear(x + gap, y);
      }
    }
  }
  for (let y = top + 6; y < bottom - 4; y += 11) {
    for (let gap = 0; gap < 3; gap += 1) {
      for (const x of mode === "rectangle"
        ? [left, left + 1, right, right + 1]
        : [left, left + 1]) {
        clear(x, y + gap);
      }
    }
  }
}

function maskToRgb(mask) {
  const rgb = new Uint8Array(mask.length * 3).fill(255);
  mask.forEach((value, index) => {
    if (!value) return;
    rgb[index * 3] = 15;
    rgb[index * 3 + 1] = 15;
    rgb[index * 3 + 2] = 15;
  });
  return rgb;
}

test("separates offset rectangular charts and ignores grid subdivisions", () => {
  const width = 620;
  const height = 390;
  const mask = new Uint8Array(width * height);
  drawFrame(mask, width, 35, 35, 280, 180);
  drawCurve(mask, width, 44, 48, 270, 170);
  // Dense internal grid and State-like vertical edges must not split the plot.
  for (const y of [70, 105, 140]) {
    drawLine(mask, width, 35, y, 280, y);
  }
  for (const x of [90, 145, 200, 245]) {
    drawLine(mask, width, x, 35, x, 180);
  }

  drawFrame(mask, width, 330, 210, 585, 365);
  drawCurve(mask, width, 342, 224, 573, 352, 0.8);
  for (const y of [250, 290, 330]) {
    drawLine(mask, width, 330, y, 585, y);
  }

  // Label-like strokes outside both frames.
  drawLine(mask, width, 50, 15, 82, 15, 3);
  drawLine(mask, width, 300, 255, 300, 280, 2);

  const result = detectChartPanelsFromMask(mask, width, height);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.panels.length, 2);
  const [first, second] = result.panels;
  assert.ok(first.left <= 35 && first.top <= 35);
  assert.ok(first.right >= 280 && first.bottom >= 180);
  assert.ok(second.left <= 330 && second.top <= 210);
  assert.ok(second.right >= 585 && second.bottom >= 365);
  assert.deepEqual(result.layout, { rows: 2, columns: 1 });
  assert.ok(
    result.panels.every(
      (panel) => panel.detectionReason === "closed-plot-frame",
    ),
  );
});

test("keeps a three-by-three mix of framed and L-axis VTH charts across narrow gutters", async (context) => {
  for (const blankGutter of [2, 5, 11]) {
    await context.test(
      `${blankGutter} blank pixels`,
      () => {
        const panelWidth = 260;
        const panelHeight = 180;
        const outerMargin = 25;
        const coordinateGap = blankGutter + 1;
        const width =
          outerMargin * 2 +
          panelWidth * 3 +
          coordinateGap * 2;
        const height =
          outerMargin * 2 +
          panelHeight * 3 +
          coordinateGap * 2;
        const mask = new Uint8Array(width * height);
        const expectedCenters = [];

        for (let row = 0; row < 3; row += 1) {
          for (let column = 0; column < 3; column += 1) {
            const left =
              outerMargin +
              column * (panelWidth + coordinateGap);
            const top =
              outerMargin +
              row * (panelHeight + coordinateGap);
            const right = left + panelWidth;
            const bottom = top + panelHeight;
            const lAxis = (row + column) % 2 === 1;
            if (lAxis) {
              drawLine(
                mask,
                width,
                left,
                top,
                left,
                bottom,
                2,
              );
              drawLine(
                mask,
                width,
                left,
                bottom,
                right,
                bottom,
                2,
              );
            } else {
              drawFrame(
                mask,
                width,
                left,
                top,
                right,
                bottom,
              );
            }
            for (const ratio of [0.25, 0.5, 0.75]) {
              const y = Math.round(
                top + (bottom - top) * ratio,
              );
              drawLine(
                mask,
                width,
                left,
                y,
                right,
                y,
              );
            }
            for (const ratio of [0.2, 0.4, 0.6, 0.8]) {
              const x = Math.round(
                left + (right - left) * ratio,
              );
              drawLine(
                mask,
                width,
                x,
                top,
                x,
                bottom,
              );
            }
            drawFiveStateGaussianCurve(
              mask,
              width,
              left,
              top,
              right,
              bottom,
            );
            expectedCenters.push({
              x: (left + right) / 2,
              y: (top + bottom) / 2,
            });
          }
        }

        for (const result of [
          detectChartPanelsFromMask(
            mask,
            width,
            height,
          ),
          detectChartPanels(
            maskToRgb(mask),
            width,
            height,
            3,
          ),
        ]) {
          assert.equal(result.fallbackUsed, false);
          assert.equal(result.panels.length, 9);
          assert.deepEqual(result.layout, {
            rows: 3,
            columns: 3,
          });
          for (const expected of expectedCenters) {
            assert.ok(
              result.panels.some((panel) => {
                const centerX =
                  panel.left + panel.width / 2;
                const centerY =
                  panel.top + panel.height / 2;
                return (
                  Math.abs(centerX - expected.x) <= 8 &&
                  Math.abs(centerY - expected.y) <= 8
                );
              }),
              `missing panel near ${expected.x},${expected.y}`,
            );
          }
        }
      },
    );
  }
});

test("detects a closed frame and an open L axis in reading order", () => {
  const width = 700;
  const height = 330;
  const mask = new Uint8Array(width * height);
  drawFrame(mask, width, 30, 40, 300, 285);
  drawCurve(mask, width, 42, 55, 288, 270);

  drawLine(mask, width, 390, 65, 390, 280, 2);
  drawLine(mask, width, 390, 280, 665, 280, 2);
  drawCurve(mask, width, 402, 80, 650, 266, 1.3);
  // A guide within the open-axis plot should not become a new panel.
  drawLine(mask, width, 485, 65, 485, 280);
  drawLine(mask, width, 390, 180, 665, 180);

  const result = detectChartPanelsFromMask(mask, width, height);
  assert.equal(result.panels.length, 2);
  assert.deepEqual(result.layout, { rows: 1, columns: 2 });
  assert.deepEqual(
    result.panels.map((panel) => panel.axisMode),
    ["rectangle", "l-axis"],
  );
  assert.ok(result.panels[0].x < result.panels[1].x);
});

test("orders four staggered chart coordinates by visual rows", () => {
  const width = 760;
  const height = 520;
  const mask = new Uint8Array(width * height);
  const charts = [
    [20, 30, 330, 215, 0],
    [410, 65, 735, 245, 0.5],
    [55, 290, 350, 490, 1],
    [400, 270, 720, 465, 1.5],
  ];
  for (const [left, top, right, bottom, phase] of charts) {
    drawFrame(mask, width, left, top, right, bottom);
    drawCurve(mask, width, left + 10, top + 12, right - 10, bottom - 12, phase);
  }
  // Detached captions and guides must not change the panel count.
  drawLine(mask, width, 35, 12, 105, 12, 3);
  drawLine(mask, width, 500, 255, 650, 255);

  const result = detectChartPanelsFromMask(mask, width, height);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.panels.length, 4);
  assert.deepEqual(result.layout, { rows: 2, columns: 2 });
  assert.deepEqual(
    result.panels.map((panel) => panel.axisMode),
    ["rectangle", "rectangle", "rectangle", "rectangle"],
  );
  assert.ok(result.panels[0].x < result.panels[1].x);
  assert.ok(result.panels[2].x < result.panels[3].x);
  assert.ok(result.panels[0].y < result.panels[2].y);
  assert.ok(result.panels[1].y < result.panels[3].y);
});

test("separates twelve staggered PPT charts with titles, labels, and gridlines", () => {
  const width = 1280;
  const height = 720;
  const mask = new Uint8Array(width * height);
  const expectedCenters = [];
  const expectedModes = [];
  const panelWidth = 250;
  const panelHeight = 158;
  const leftStarts = [35, 345, 655, 965];
  const topStarts = [58, 284, 510];

  for (let row = 0; row < topStarts.length; row += 1) {
    for (let column = 0; column < leftStarts.length; column += 1) {
      const left = leftStarts[column] + (row % 2) * 5;
      const top =
        topStarts[row] +
        (column % 2 === 0 ? -6 : 6) +
        (row === 1 ? column - 2 : 0);
      const right = left + panelWidth;
      const bottom = top + panelHeight;
      expectedCenters.push({
        x: (left + right) / 2,
        y: (top + bottom) / 2,
      });
      const openAxis = (row + column) % 3 === 2;
      expectedModes.push(openAxis ? "l-axis" : "rectangle");
      if (openAxis) {
        drawLine(mask, width, left, top, left, bottom, 2);
        drawLine(mask, width, left, bottom, right, bottom, 2);
      } else {
        drawFrame(mask, width, left, top, right, bottom);
      }
      drawCurve(
        mask,
        width,
        left + 8,
        top + 10,
        right - 8,
        bottom - 9,
        row * 0.5 + column * 0.25,
      );
      for (const ratio of [0.25, 0.5, 0.75]) {
        const gridY = Math.round(top + panelHeight * ratio);
        drawLine(mask, width, left, gridY, right, gridY);
      }
      for (const ratio of [0.2, 0.4, 0.6, 0.8]) {
        const gridX = Math.round(left + panelWidth * ratio);
        drawLine(mask, width, gridX, top, gridX, bottom);
      }
      // Common PPT content around a chart: title above it, axis label below,
      // and a short legend swatch. These must not create extra panels.
      drawLabel(mask, width, left + 15, top - 20, 82);
      drawLabel(mask, width, left + 78, bottom + 7, 55);
      drawLine(
        mask,
        width,
        right - 48,
        top + 13,
        right - 27,
        top + 13,
        3,
      );
    }
  }

  const startedAt = performance.now();
  // Exercise the real RGB entry point used by uploaded PPT screenshots, not
  // only the lower-level precomputed-mask helper.
  const result = detectChartPanels(maskToRgb(mask), width, height, 3);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.panels.length, 12);
  assert.equal(result.detectedPanelCount, 12);
  assert.equal(result.truncated, false);
  assert.equal(result.maxPanels, 30);
  assert.deepEqual(result.layout, { rows: 3, columns: 4 });
  assert.ok(
    result.panels.every(
      (panel) =>
        panel.width >= panelWidth &&
        panel.height >= panelHeight,
    ),
  );
  assert.deepEqual(
    result.panels.map((panel) => panel.axisMode),
    expectedModes,
  );
  for (let index = 0; index < expectedCenters.length; index += 1) {
    const actual = result.panels[index];
    const expected = expectedCenters[index];
    assert.ok(
      Math.abs(actual.x + actual.width / 2 - expected.x) <= 10,
      `panel ${index} should stay in row-major column order`,
    );
    assert.ok(
      Math.abs(actual.y + actual.height / 2 - expected.y) <= 10,
      `panel ${index} should stay in row-major row order`,
    );
  }
  // Keep a wall-clock guard against accidentally reintroducing combinatorial
  // candidate matching, while allowing for shared CI runner load.
  assert.ok(elapsedMs < 3000, `detection took ${elapsedMs.toFixed(1)} ms`);
});

test("recovers ten low-resolution charts scattered at unrelated coordinates", () => {
  const width = 420;
  const height = 260;
  const mask = new Uint8Array(width * height);
  const charts = [
    [8, 8, 90, 58, "rectangle"],
    [130, 4, 213, 56, "l-axis"],
    [284, 18, 412, 75, "rectangle"],
    [35, 85, 111, 139, "l-axis"],
    [165, 76, 258, 136, "rectangle"],
    [304, 100, 396, 153, "l-axis"],
    [6, 164, 99, 221, "rectangle"],
    [126, 183, 213, 250, "l-axis"],
    [244, 160, 327, 217, "rectangle"],
    [340, 190, 414, 246, "rectangle"],
  ];
  const expectedCenters = [];

  charts.forEach(([left, top, right, bottom, mode], index) => {
    if (mode === "rectangle") {
      drawFrame(mask, width, left, top, right, bottom);
    } else {
      drawLine(mask, width, left, top, left, bottom, 2);
      drawLine(mask, width, left, bottom, right, bottom, 2);
    }
    breakAxisRuns(
      mask,
      width,
      height,
      left,
      top,
      right,
      bottom,
      mode,
    );
    drawCurve(
      mask,
      width,
      left + 5,
      top + 5,
      right - 5,
      bottom - 5,
      index * 0.27,
    );
    expectedCenters.push({
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      mode,
    });
  });
  drawLabel(mask, width, 225, 7, 38);
  drawLabel(mask, width, 108, 151, 32);

  const repaired = repairLowResolutionLineMask(
    mask,
    width,
    height,
  );
  assert.ok(repaired.repairedPixelCount > 100);
  assert.equal(repaired.maximumGap, 3);

  const result = detectChartPanelsFromMask(mask, width, height);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.panels.length, charts.length);
  assert.equal(result.detectedPanelCount, charts.length);
  assert.equal(result.lowResolutionRecovery.applied, true);
  assert.ok(
    result.panels.some((panel) => panel.axisMode === "l-axis"),
  );

  for (const expected of expectedCenters) {
    const match = result.panels.find(
      (panel) =>
        Math.abs(panel.x + panel.width / 2 - expected.x) <= 7 &&
        Math.abs(panel.y + panel.height / 2 - expected.y) <= 7,
    );
    assert.ok(match, `missing scattered panel at ${expected.x},${expected.y}`);
    assert.equal(match.axisMode, expected.mode);
  }
});

test("keeps a dense 4 by 4 slide as sixteen panels instead of grid cells", () => {
  const width = 1440;
  const height = 900;
  const mask = new Uint8Array(width * height);
  const leftStarts = [38, 398, 758, 1118];
  const topStarts = [55, 270, 485, 700];
  const panelWidth = 282;
  const panelHeight = 145;

  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const left = leftStarts[column] + (row % 2) * 4;
      const top = topStarts[row] + (column % 2) * 4;
      const right = left + panelWidth;
      const bottom = top + panelHeight;
      drawFrame(mask, width, left, top, right, bottom);
      drawCurve(
        mask,
        width,
        left + 9,
        top + 9,
        right - 9,
        bottom - 8,
        row * 0.31 + column * 0.17,
      );
      for (const ratio of [1 / 3, 2 / 3]) {
        const gridY = Math.round(top + panelHeight * ratio);
        drawLine(mask, width, left, gridY, right, gridY);
      }
      for (const ratio of [0.25, 0.5, 0.75]) {
        const gridX = Math.round(left + panelWidth * ratio);
        drawLine(mask, width, gridX, top, gridX, bottom);
      }
    }
  }

  const result = detectChartPanelsFromMask(mask, width, height);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.panels.length, 16);
  assert.equal(result.detectedPanelCount, 16);
  assert.equal(result.truncated, false);
  assert.equal(result.maxPanels, 30);
  assert.deepEqual(result.layout, { rows: 4, columns: 4 });
  for (let index = 0; index < result.panels.length; index += 1) {
    const row = Math.floor(index / 4);
    const column = index % 4;
    const panel = result.panels[index];
    assert.ok(
      Math.abs(panel.x - (leftStarts[column] + (row % 2) * 4)) <= 8,
    );
    assert.ok(
      Math.abs(panel.y - (topStarts[row] + (column % 2) * 4)) <= 8,
    );
    assert.equal(panel.axisMode, "rectangle");
  }
});

test("caps excessive slide detections at 30 and restores row-major order", () => {
  const width = 1200;
  const height = 800;
  const mask = new Uint8Array(width * height);
  const leftStarts = [30, 195, 360, 525, 690, 855, 1020];
  const topStarts = [30, 185, 340, 495, 650];

  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 7; column += 1) {
      const left = leftStarts[column];
      const top = topStarts[row];
      const right = left + 130;
      const bottom = top + 105;
      drawFrame(mask, width, left, top, right, bottom);
      drawCurve(
        mask,
        width,
        left + 7,
        top + 7,
        right - 7,
        bottom - 7,
        row * 0.2 + column * 0.1,
      );
    }
  }

  const result = detectChartPanelsFromMask(mask, width, height);
  assert.equal(result.detectedPanelCount, 35);
  assert.equal(result.panels.length, 30);
  assert.equal(result.truncated, true);
  assert.equal(result.maxPanels, 30);
  assert.ok(result.layout.rows >= 4);
  assert.ok(result.layout.columns <= 7);
  for (let index = 1; index < result.panels.length; index += 1) {
    const previous = result.panels[index - 1];
    const current = result.panels[index];
    const sameVisualRow =
      Math.abs(
        previous.y +
          previous.height / 2 -
          (current.y + current.height / 2),
      ) <= Math.max(previous.height, current.height) * 0.38;
    assert.ok(
      current.y >= previous.y || sameVisualRow,
      "selected panels should return in visual row order",
    );
    if (sameVisualRow) {
      assert.ok(
        current.x > previous.x,
        "selected panels should return left-to-right inside a row",
      );
    }
  }
});

test("RGB entry point suppresses labels and returns the same two panels", () => {
  const width = 520;
  const height = 270;
  const mask = new Uint8Array(width * height);
  drawFrame(mask, width, 22, 42, 240, 238);
  drawCurve(mask, width, 35, 55, 226, 222);
  drawFrame(mask, width, 278, 28, 500, 218);
  drawCurve(mask, width, 290, 42, 486, 202, 0.4);
  // Text-like detached blocks.
  for (let offset = 0; offset < 5; offset += 1) {
    drawLine(mask, width, 12, 10 + offset * 4, 29, 10 + offset * 4);
  }

  const result = detectChartPanels(
    maskToRgb(mask),
    width,
    height,
  );
  assert.equal(result.panels.length, 2);
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(result.layout, { rows: 1, columns: 2 });
  assert.ok(result.panels.every((panel) => panel.confidence > 0.8));
});

test("keeps Curve charts while rejecting tables and diagram cards", () => {
  const width = 900;
  const height = 560;
  const mask = new Uint8Array(width * height);

  drawFrame(mask, width, 28, 36, 370, 244);
  drawCurve(mask, width, 40, 49, 358, 229, 0.4);
  drawFrame(mask, width, 485, 320, 865, 530);
  drawCurve(mask, width, 499, 334, 851, 515, 1.2);

  // A table has a credible outer rectangle and long internal lines, but no
  // horizontally coherent Curve trace.
  drawFrame(mask, width, 485, 38, 866, 254);
  for (const x of [580, 675, 770]) {
    drawLine(mask, width, x, 38, x, 254, 2);
  }
  for (const y of [92, 146, 200]) {
    drawLine(mask, width, 485, y, 866, y, 2);
  }
  for (const y of [57, 111, 165, 219]) {
    for (const x of [501, 596, 691, 786]) {
      drawLabel(mask, width, x, y, 48);
    }
  }

  // A flow/card diagram also presents rectangular boundaries, connector
  // strokes and labels that must not be treated as distribution charts.
  drawFrame(mask, width, 34, 326, 184, 438);
  drawFrame(mask, width, 244, 392, 394, 504);
  drawLabel(mask, width, 55, 368, 90);
  drawLabel(mask, width, 265, 434, 90);
  drawLine(mask, width, 184, 382, 244, 438, 3);

  const result = detectChartPanels(
    maskToRgb(mask),
    width,
    height,
    3,
  );

  assert.equal(result.fallbackUsed, false);
  assert.equal(result.detectedPanelCount, 2);
  assert.equal(result.panels.length, 2);
  assert.ok(result.rejectedNonChartCount >= 3);
  assert.ok(result.panels[0].left <= 28);
  assert.ok(result.panels[0].right >= 370);
  assert.ok(result.panels[1].left <= 485);
  assert.ok(result.panels[1].right >= 865);
});

test("prefers dark inner plot frames over pale outer PPT chart cards", () => {
  const result = detectChartPanels(
    pptSample.data,
    pptSample.width,
    pptSample.height,
    pptSample.channels,
  );

  assert.equal(result.panels.length, 12);
  assert.deepEqual(result.layout, { rows: 3, columns: 4 });
  assert.ok(
    result.panels.every(
      (panel) =>
        panel.axisMode === "rectangle" &&
        panel.width >= 300 &&
        panel.width <= 325 &&
        panel.height >= 155 &&
        panel.height <= 180,
    ),
    "the crop must follow each dark plot frame, not its larger card border",
  );
  assert.ok(result.panels[0].x >= 85 && result.panels[0].x <= 95);
  assert.ok(result.panels[0].y >= 145 && result.panels[0].y <= 155);
});

test("separates every scattered sample and excludes non-chart content only when present", async () => {
  assert.equal(randomSampleManifest.samples.length, 4);
  for (const sample of randomSampleManifest.samples) {
    const decoded = decodePng(
      await readFile(
        new URL(`../public/samples/${sample.fileName}`, import.meta.url),
      ),
    );
    const result = detectChartPanels(
      decoded.data,
      decoded.width,
      decoded.height,
      decoded.channels,
    );

    assert.equal(
      result.detectedPanelCount,
      sample.expectedChartCount,
      `${sample.fileName} should keep only its VTH charts`,
    );
    assert.equal(result.panels.length, sample.expectedChartCount);
    if (sample.distractors.length > 0) {
      assert.ok(
        result.rejectedNonChartCount >= 1,
        `${sample.fileName} should reject table/photo/diagram candidates`,
      );
    } else {
      assert.equal(sample.chartOnly, true);
      assert.equal(sample.boundaryMode, "frameless");
    }
    assert.equal(result.fallbackUsed, false);
  }
});

test("keeps one pale plot frame when dark full-span grids form nested cells", () => {
  const width = 600;
  const height = 400;
  const paleFrame = new Uint8Array(width * height);
  const darkGrid = new Uint8Array(width * height);
  const coloredCurve = new Uint8Array(width * height);
  drawFrame(paleFrame, width, 50, 50, 550, 350);
  for (const y of [110, 190, 270]) {
    drawLine(darkGrid, width, 50, y, 550, y, 2);
  }
  for (const x of [140, 260, 380, 500]) {
    drawLine(darkGrid, width, x, 50, x, 350, 2);
  }
  drawCurve(coloredCurve, width, 55, 60, 545, 340);

  const rgb = new Uint8Array(width * height * 3).fill(255);
  const paint = (mask, color) => {
    mask.forEach((value, index) => {
      if (!value) return;
      const offset = index * 3;
      rgb[offset] = color[0];
      rgb[offset + 1] = color[1];
      rgb[offset + 2] = color[2];
    });
  };
  paint(paleFrame, [175, 175, 175]);
  paint(darkGrid, [35, 35, 35]);
  paint(coloredCurve, [30, 100, 220]);

  const result = detectChartPanels(rgb, width, height, 3);

  assert.equal(result.panels.length, 1);
  assert.deepEqual(result.layout, { rows: 1, columns: 1 });
  assert.ok(result.panels[0].left <= 50);
  assert.ok(result.panels[0].top <= 50);
  assert.ok(result.panels[0].right >= 550);
  assert.ok(result.panels[0].bottom >= 350);
});

test("returns one full-image fallback when no credible axes exist", () => {
  const width = 240;
  const height = 150;
  const mask = new Uint8Array(width * height);
  drawCurve(mask, width, 25, 20, 215, 125);
  drawLine(mask, width, 12, 138, 38, 138, 2);

  const result = detectChartPanelsFromMask(mask, width, height);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.detectedPanelCount, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.maxPanels, 30);
  assert.deepEqual(result.layout, { rows: 1, columns: 1 });
  assert.deepEqual(
    {
      index: result.panels[0].index,
      x: result.panels[0].x,
      y: result.panels[0].y,
      width: result.panels[0].width,
      height: result.panels[0].height,
      confidence: result.panels[0].confidence,
      detectionReason: result.panels[0].detectionReason,
      axisMode: result.panels[0].axisMode,
    },
    {
      index: 0,
      x: 0,
      y: 0,
      width,
      height,
      confidence: 0.2,
      detectionReason: "whole-image-fallback",
      axisMode: "content",
    },
  );
});

test("keeps the materially more complete nested physical plot instead of its broad outer frame", () => {
  const width = 700;
  const height = 450;
  const mask = new Uint8Array(width * height);
  const outer = {
    left: 40,
    top: 40,
    right: 620,
    bottom: 390,
  };
  const inner = {
    left: 100,
    top: 100,
    right: 500,
    bottom: 300,
  };
  drawFrame(
    mask,
    width,
    outer.left,
    outer.top,
    outer.right,
    outer.bottom,
  );
  drawFrame(
    mask,
    width,
    inner.left,
    inner.top,
    inner.right,
    inner.bottom,
  );
  let previous = { x: 118, y: 200 };
  for (let x = 119; x <= 482; x += 1) {
    const progress = (x - 118) / (482 - 118);
    const y = Math.round(
      200 + 70 * Math.sin(progress * Math.PI * 8),
    );
    drawLine(
      mask,
      width,
      previous.x,
      previous.y,
      x,
      y,
      2,
    );
    previous = { x, y };
  }

  const result = detectChartPanelsFromMask(
    mask,
    width,
    height,
  );

  assert.equal(result.panels.length, 1);
  const [panel] = result.panels;
  assert.ok(
    Math.abs(panel.left - inner.left) <= 5 &&
      Math.abs(panel.top - inner.top) <= 5 &&
      Math.abs(panel.right - inner.right) <= 6 &&
      Math.abs(panel.bottom - inner.bottom) <= 6,
    `expected inner plot, received ${JSON.stringify(panel)}`,
  );
  assert.ok(
    panel.width < outer.right - outer.left,
    "broad outer frame must not suppress the complete curve crop",
  );
});

test("rejects malformed pixel buffers deterministically", () => {
  assert.throws(
    () => detectChartPanels(new Uint8Array(31), 10, 10),
    /RGB 또는 RGBA/,
  );
});

test("crops interleaved pixels using the detector panel contract", () => {
  const pixels = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
    10, 11, 12, 13, 14, 15, 16, 17, 18,
  ]);
  const cropped = cropInterleavedPixels(
    pixels,
    3,
    2,
    3,
    { left: 1, top: 0, width: 2, height: 2 },
  );
  assert.deepEqual(
    Array.from(cropped.pixels),
    [4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 18],
  );
  assert.deepEqual(
    {
      width: cropped.width,
      height: cropped.height,
      channels: cropped.channels,
    },
    { width: 2, height: 2, channels: 3 },
  );
});
