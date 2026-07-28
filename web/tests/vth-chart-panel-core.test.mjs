import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import {
  cropInterleavedPixels,
  detectChartPanels,
  detectChartPanelsFromMask,
} from "../lib/vth-chart-panel-core.mjs";

const pptSample = decodePng(
  await readFile(
    new URL(
      "../public/samples/vnand-ppt-12-chart-sample.png",
      import.meta.url,
    ),
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
  assert.equal(result.maxPanels, 24);
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
  // A generous guard against accidentally reintroducing combinatorial
  // candidate matching for dense 4-column slides.
  assert.ok(elapsedMs < 1500, `detection took ${elapsedMs.toFixed(1)} ms`);
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
  assert.equal(result.maxPanels, 24);
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

test("caps excessive slide detections at 24 and restores row-major order", () => {
  const width = 1200;
  const height = 800;
  const mask = new Uint8Array(width * height);
  const leftStarts = [30, 270, 510, 750, 990];
  const topStarts = [30, 185, 340, 495, 650];

  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const left = leftStarts[column];
      const top = topStarts[row];
      const right = left + 180;
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
  assert.equal(result.detectedPanelCount, 25);
  assert.equal(result.panels.length, 24);
  assert.equal(result.truncated, true);
  assert.equal(result.maxPanels, 24);
  assert.ok(result.layout.rows >= 4);
  assert.ok(result.layout.columns <= 5);
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
  assert.equal(result.maxPanels, 24);
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
