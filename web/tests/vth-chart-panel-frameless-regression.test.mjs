import assert from "node:assert/strict";
import test from "node:test";

import {
  detectChartPanelsFromMask,
} from "../lib/vth-chart-panel-core.mjs";

function drawLine(mask, width, x1, y1, x2, y2, thickness = 1) {
  const height = Math.floor(mask.length / width);
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let offsetY = 0; offsetY < thickness; offsetY += 1) {
      for (let offsetX = 0; offsetX < thickness; offsetX += 1) {
        const localX = x + offsetX;
        const localY = y + offsetY;
        if (
          localX >= 0 &&
          localX < width &&
          localY >= 0 &&
          localY < height
        ) {
          mask[localY * width + localX] = 1;
        }
      }
    }
  }
}

function drawFramelessDistribution(
  mask,
  width,
  bounds,
  peakCenters,
  {
    peakWidth = 0.095,
    thickness = 2,
  } = {},
) {
  const usableHeight = bounds.bottom - bounds.top;
  let previous = null;

  for (let x = bounds.left; x <= bounds.right; x += 1) {
    const progress =
      (x - bounds.left) /
      Math.max(1, bounds.right - bounds.left);
    let response = 0;
    for (const center of peakCenters) {
      const distance = (progress - center) / peakWidth;
      response = Math.max(
        response,
        Math.exp(-0.5 * distance * distance),
      );
    }
    const y = Math.round(
      bounds.bottom - response * usableHeight * 0.88,
    );
    if (previous) {
      drawLine(
        mask,
        width,
        previous.x,
        previous.y,
        x,
        y,
        thickness,
      );
    }
    previous = { x, y };
  }
}

function drawBrokenAxis(mask, width, bounds) {
  const drawSegmentedLine = (x1, y1, x2, y2) => {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let start = 0; start < steps; start += 34) {
      const end = Math.min(steps, start + 19);
      const startRatio = start / steps;
      const endRatio = end / steps;
      drawLine(
        mask,
        width,
        Math.round(x1 + (x2 - x1) * startRatio),
        Math.round(y1 + (y2 - y1) * startRatio),
        Math.round(x1 + (x2 - x1) * endRatio),
        Math.round(y1 + (y2 - y1) * endRatio),
      );
    }
  };

  drawSegmentedLine(
    bounds.left,
    bounds.top,
    bounds.left,
    bounds.bottom,
  );
  drawSegmentedLine(
    bounds.left,
    bounds.bottom,
    bounds.right,
    bounds.bottom,
  );
}

function assertIndependentPanels(result, expectedBounds, message) {
  assert.equal(result.fallbackUsed, false, message);
  assert.equal(result.detectedPanelCount, expectedBounds.length, message);
  assert.equal(result.panels.length, expectedBounds.length, message);

  const unmatched = new Set(
    result.panels.map((_panel, index) => index),
  );
  for (const expected of expectedBounds) {
    const expectedWidth = expected.right - expected.left + 1;
    const expectedHeight = expected.bottom - expected.top + 1;
    const expectedCenterX = (expected.left + expected.right) / 2;
    const expectedCenterY = (expected.top + expected.bottom) / 2;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const panelIndex of unmatched) {
      const panel = result.panels[panelIndex];
      const panelCenterX = panel.left + panel.width / 2;
      const panelCenterY = panel.top + panel.height / 2;
      const normalizedDistance =
        Math.abs(panelCenterX - expectedCenterX) / expectedWidth +
        Math.abs(panelCenterY - expectedCenterY) / expectedHeight;
      if (normalizedDistance < bestDistance) {
        bestDistance = normalizedDistance;
        bestIndex = panelIndex;
      }
    }

    assert.notEqual(
      bestIndex,
      -1,
      `missing frameless chart near ${expectedCenterX},${expectedCenterY}`,
    );
    const panel = result.panels[bestIndex];
    unmatched.delete(bestIndex);
    assert.ok(
      bestDistance <= 0.36,
      `frameless chart near ${expectedCenterX},${expectedCenterY} was merged or assigned to the wrong region`,
    );
    assert.ok(
      panel.width >= expectedWidth * 0.52 &&
        panel.width <= expectedWidth * 1.6 &&
        panel.height >= expectedHeight * 0.52 &&
        panel.height <= expectedHeight * 1.7,
      `frameless chart near ${expectedCenterX},${expectedCenterY} was not independently cropped`,
    );
  }
}

test("separates eight frameless chart-only distributions at irregular positions and sizes", () => {
  const width = 1440;
  const height = 820;
  const mask = new Uint8Array(width * height);
  const charts = [
    {
      bounds: { left: 30, top: 42, right: 392, bottom: 215 },
      peaks: [0.18, 0.45, 0.75],
    },
    {
      bounds: { left: 430, top: 20, right: 670, bottom: 152 },
      peaks: [0.51],
    },
    {
      bounds: { left: 720, top: 56, right: 1355, bottom: 270 },
      peaks: [0.14, 0.32, 0.53, 0.78],
    },
    {
      bounds: { left: 65, top: 300, right: 245, bottom: 417 },
      peaks: [0.48],
    },
    {
      // Only twelve blank pixels separate this curve from its neighbour.
      bounds: { left: 257, top: 292, right: 560, bottom: 455 },
      peaks: [0.28, 0.68],
    },
    {
      bounds: { left: 635, top: 350, right: 904, bottom: 640 },
      peaks: [0.17, 0.46, 0.77],
    },
    {
      bounds: { left: 925, top: 307, right: 1260, bottom: 478 },
      peaks: [0.52],
    },
    {
      bounds: { left: 100, top: 550, right: 495, bottom: 750 },
      peaks: [0.13, 0.36, 0.59, 0.82],
    },
  ];

  for (const chart of charts) {
    drawFramelessDistribution(
      mask,
      width,
      chart.bounds,
      chart.peaks,
      {
        peakWidth: chart.peaks.length === 1 ? 0.13 : 0.085,
      },
    );
  }

  // A long guide and a diagonal leader are not distribution charts.
  drawLine(mask, width, 930, 700, 1380, 700, 2);
  drawLine(mask, width, 1030, 755, 1340, 650, 2);
  drawLine(mask, width, 1140, 691, 1140, 709, 2);

  const result = detectChartPanelsFromMask(mask, width, height, {
    fallbackToWholeImage: false,
  });

  assertIndependentPanels(
    result,
    charts.map((chart) => chart.bounds),
    "whitespace clustering should separate chart-only curves without relying on frames or axes",
  );
});

test("uses weak broken boundaries plus curve shape to split close mixed-size charts", () => {
  const width = 1180;
  const height = 650;
  const mask = new Uint8Array(width * height);
  const charts = [
    {
      bounds: { left: 26, top: 32, right: 350, bottom: 230 },
      peaks: [0.19, 0.46, 0.76],
      weakAxis: true,
    },
    {
      // This single-peak plot is frameless and has a narrow horizontal gutter.
      bounds: { left: 362, top: 50, right: 620, bottom: 220 },
      peaks: [0.5],
    },
    {
      bounds: { left: 700, top: 25, right: 1140, bottom: 250 },
      peaks: [0.14, 0.35, 0.58, 0.81],
      weakAxis: true,
    },
    {
      bounds: { left: 72, top: 330, right: 445, bottom: 585 },
      peaks: [0.2, 0.48, 0.77],
    },
    {
      bounds: { left: 474, top: 300, right: 800, bottom: 550 },
      peaks: [0.5],
      weakAxis: true,
    },
    {
      bounds: { left: 850, top: 340, right: 1125, bottom: 520 },
      peaks: [0.3, 0.7],
    },
  ];

  for (const chart of charts) {
    if (chart.weakAxis) {
      drawBrokenAxis(mask, width, chart.bounds);
    }
    const insetBounds = {
      left: chart.bounds.left + 8,
      top: chart.bounds.top + 7,
      right: chart.bounds.right - 7,
      bottom: chart.bounds.bottom - 8,
    };
    drawFramelessDistribution(
      mask,
      width,
      insetBounds,
      chart.peaks,
      {
        peakWidth: chart.peaks.length === 1 ? 0.13 : 0.09,
      },
    );
  }

  const result = detectChartPanelsFromMask(mask, width, height, {
    fallbackToWholeImage: false,
  });

  assertIndependentPanels(
    result,
    charts.map((chart) => chart.bounds),
    "broken axes must be treated as supporting evidence, not required panel borders",
  );
});
