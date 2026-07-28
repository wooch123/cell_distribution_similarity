import assert from "node:assert/strict";
import test from "node:test";

import {
  detectChartPanels,
  detectChartPanelsFromMask,
} from "../lib/vth-chart-panel-core.mjs";

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

function drawFrame(mask, width, bounds) {
  const { left, top, right, bottom } = bounds;
  drawLine(mask, width, left, top, right, top, 2);
  drawLine(mask, width, left, bottom, right, bottom, 2);
  drawLine(mask, width, left, top, left, bottom, 2);
  drawLine(mask, width, right, top, right, bottom, 2);
}

function drawOpenAxes(mask, width, bounds) {
  const { left, top, right, bottom } = bounds;
  drawLine(mask, width, left, top, left, bottom, 2);
  drawLine(mask, width, left, bottom, right, bottom, 2);
}

function drawDistributionCurve(
  mask,
  width,
  bounds,
  peakCenters,
) {
  const insetX = Math.max(5, Math.round((bounds.right - bounds.left) * 0.04));
  const insetY = Math.max(5, Math.round((bounds.bottom - bounds.top) * 0.07));
  const left = bounds.left + insetX;
  const right = bounds.right - insetX;
  const top = bounds.top + insetY;
  const bottom = bounds.bottom - insetY;
  const usableHeight = bottom - top;
  let previous = null;

  for (let x = left; x <= right; x += 1) {
    const progress = (x - left) / Math.max(1, right - left);
    let response = 0;
    for (const center of peakCenters) {
      const distance = (progress - center) / 0.105;
      response = Math.max(response, Math.exp(-0.5 * distance * distance));
    }
    const y = Math.round(bottom - response * usableHeight * 0.82);
    if (previous) {
      drawLine(mask, width, previous.x, previous.y, x, y, 2);
    }
    previous = { x, y };
  }
}

function drawChart(mask, width, bounds, peakCenters, axisMode = "rectangle") {
  if (axisMode === "l-axis") drawOpenAxes(mask, width, bounds);
  else drawFrame(mask, width, bounds);
  drawDistributionCurve(mask, width, bounds, peakCenters);
}

function drawTable(mask, width, bounds) {
  drawFrame(mask, width, bounds);
  for (const ratio of [0.25, 0.5, 0.75]) {
    const x = Math.round(
      bounds.left + (bounds.right - bounds.left) * ratio,
    );
    drawLine(mask, width, x, bounds.top, x, bounds.bottom, 2);
  }
  for (const ratio of [0.2, 0.4, 0.6, 0.8]) {
    const y = Math.round(
      bounds.top + (bounds.bottom - bounds.top) * ratio,
    );
    drawLine(mask, width, bounds.left, y, bounds.right, y, 2);
  }
}

function drawDiagram(mask, width, left, top) {
  const first = { left, top, right: left + 105, bottom: top + 68 };
  const second = {
    left: left + 155,
    top: top + 35,
    right: left + 265,
    bottom: top + 108,
  };
  drawFrame(mask, width, first);
  drawFrame(mask, width, second);
  drawLine(
    mask,
    width,
    first.right,
    Math.round((first.top + first.bottom) / 2),
    second.left,
    Math.round((second.top + second.bottom) / 2),
    3,
  );
}

function drawChevron(mask, width, bounds) {
  const centerX = Math.round((bounds.left + bounds.right) / 2);
  const apexY = Math.round(
    bounds.top + (bounds.bottom - bounds.top) * 0.2,
  );
  const tailY = Math.round(
    bounds.top + (bounds.bottom - bounds.top) * 0.78,
  );
  const leftX = Math.round(
    bounds.left + (bounds.right - bounds.left) * 0.22,
  );
  const rightX = Math.round(
    bounds.left + (bounds.right - bounds.left) * 0.78,
  );
  drawLine(mask, width, leftX, tailY, centerX, apexY, 2);
  drawLine(mask, width, centerX, apexY, rightX, tailY, 2);
}

function maskToRgb(mask) {
  const rgb = new Uint8Array(mask.length * 3).fill(255);
  mask.forEach((value, index) => {
    if (!value) return;
    rgb[index * 3] = 18;
    rgb[index * 3 + 1] = 18;
    rgb[index * 3 + 2] = 18;
  });
  return rgb;
}

function assertPanelMatches(result, expected, tolerance = 10) {
  const expectedCenterX = (expected.left + expected.right) / 2;
  const expectedCenterY = (expected.top + expected.bottom) / 2;
  const match = result.panels.find((panel) => {
    const centerX = panel.left + panel.width / 2;
    const centerY = panel.top + panel.height / 2;
    return (
      Math.abs(centerX - expectedCenterX) <= tolerance &&
      Math.abs(centerY - expectedCenterY) <= tolerance
    );
  });

  assert.ok(
    match,
    `missing chart centered at ${expectedCenterX},${expectedCenterY}`,
  );
  assert.ok(
    Math.abs(match.left - expected.left) <= tolerance &&
      Math.abs(match.top - expected.top) <= tolerance &&
      Math.abs(match.right - expected.right) <= tolerance &&
      Math.abs(match.bottom - expected.bottom) <= tolerance,
    `chart at ${expectedCenterX},${expectedCenterY} was not tightly cropped`,
  );
  return match;
}

test("separates differently sized single-peak and multi-peak charts from slide distractors", () => {
  const width = 1800;
  const height = 1000;
  const mask = new Uint8Array(width * height);
  const charts = [
    {
      bounds: { left: 38, top: 55, right: 870, bottom: 490 },
      peaks: [0.18, 0.43, 0.7],
    },
    {
      bounds: { left: 1040, top: 70, right: 1510, bottom: 330 },
      peaks: [0.52],
    },
    {
      // A valid chart can occupy less than 0.8% of a large PPT screenshot.
      bounds: { left: 1600, top: 92, right: 1732, bottom: 178 },
      peaks: [0.48],
    },
    {
      bounds: { left: 960, top: 650, right: 1255, bottom: 835 },
      peaks: [0.25, 0.62],
    },
  ];

  for (const chart of charts) {
    drawChart(mask, width, chart.bounds, chart.peaks);
  }
  drawTable(mask, width, {
    left: 70,
    top: 650,
    right: 690,
    bottom: 930,
  });
  drawDiagram(mask, width, 1450, 680);

  const result = detectChartPanels(
    maskToRgb(mask),
    width,
    height,
    3,
  );

  assert.equal(result.fallbackUsed, false);
  assert.equal(
    result.detectedPanelCount,
    charts.length,
    "all chart sizes should be retained while table and diagram cards are rejected",
  );
  assert.equal(result.panels.length, charts.length);
  for (const chart of charts) {
    assertPanelMatches(result, chart.bounds);
  }
  assert.ok(
    result.rejectedNonChartCount >= 1,
    "table and diagram rectangles should contribute rejected candidates",
  );
});

test("keeps a compact one-peak open-axis chart beside a large multi-peak chart", () => {
  const width = 1400;
  const height = 800;
  const mask = new Uint8Array(width * height);
  const large = { left: 35, top: 55, right: 760, bottom: 525 };
  const compact = {
    left: 1040,
    top: 105,
    right: 1195,
    bottom: 202,
  };

  drawChart(mask, width, large, [0.18, 0.4, 0.64, 0.83]);
  drawChart(mask, width, compact, [0.5], "l-axis");
  drawTable(mask, width, {
    left: 850,
    top: 440,
    right: 1320,
    bottom: 735,
  });

  const result = detectChartPanelsFromMask(mask, width, height);

  assert.equal(result.fallbackUsed, false);
  assert.equal(
    result.detectedPanelCount,
    2,
    "an open-axis chart should not be discarded only because it is much smaller than its slide neighbour",
  );
  assert.equal(result.panels.length, 2);
  assert.equal(assertPanelMatches(result, large).axisMode, "rectangle");
  assert.equal(assertPanelMatches(result, compact).axisMode, "l-axis");
  assert.ok(result.rejectedNonChartCount >= 1);
});

test("splits differently sized child plots inside one slide card", () => {
  const width = 1200;
  const height = 720;
  const mask = new Uint8Array(width * height);
  const card = {
    left: 45,
    top: 42,
    right: 1085,
    bottom: 635,
  };
  const large = {
    left: 95,
    top: 135,
    right: 585,
    bottom: 510,
  };
  const compact = {
    left: 735,
    top: 205,
    right: 1015,
    bottom: 420,
  };

  drawFrame(mask, width, card);
  drawChart(mask, width, large, [0.2, 0.47, 0.76]);
  drawChart(mask, width, compact, [0.5]);

  const result = detectChartPanelsFromMask(mask, width, height);

  assert.equal(result.fallbackUsed, false);
  assert.equal(
    result.detectedPanelCount,
    2,
    "a shared decorative card must not merge independent child plots",
  );
  assert.equal(result.panels.length, 2);
  assertPanelMatches(result, large);
  assertPanelMatches(result, compact);
  assert.ok(
    result.panels.every(
      (panel) =>
        panel.left > card.left &&
        panel.top > card.top &&
        panel.right < card.right &&
        panel.bottom < card.bottom,
    ),
  );
});

test("rejects a dense 20 by 15 table without quadratic container scanning", () => {
  const width = 1200;
  const height = 800;
  const mask = new Uint8Array(width * height);
  const bounds = {
    left: 50,
    top: 50,
    right: 1150,
    bottom: 750,
  };

  drawFrame(mask, width, bounds);
  for (let row = 1; row < 20; row += 1) {
    const y = Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * row) / 20,
    );
    drawLine(mask, width, bounds.left, y, bounds.right, y, 2);
  }
  for (let column = 1; column < 15; column += 1) {
    const x = Math.round(
      bounds.left +
        ((bounds.right - bounds.left) * column) / 15,
    );
    drawLine(mask, width, x, bounds.top, x, bounds.bottom, 2);
  }

  const startedAt = performance.now();
  const result = detectChartPanelsFromMask(mask, width, height, {
    fallbackToWholeImage: false,
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.detectedPanelCount, 0);
  assert.equal(result.panels.length, 0);
  assert.ok(
    elapsedMs < 1500,
    `dense table detection took ${elapsedMs.toFixed(1)} ms`,
  );
});

test("rejects a compact framed chevron while preserving a Gaussian chart", () => {
  const width = 1400;
  const height = 800;
  const mask = new Uint8Array(width * height);
  const chart = {
    left: 45,
    top: 80,
    right: 760,
    bottom: 550,
  };
  const chevronCard = {
    left: 1040,
    top: 105,
    right: 1160,
    bottom: 185,
  };

  drawChart(mask, width, chart, [0.5]);
  drawFrame(mask, width, chevronCard);
  drawChevron(mask, width, chevronCard);

  const result = detectChartPanelsFromMask(mask, width, height);

  assert.equal(result.detectedPanelCount, 1);
  assert.equal(result.panels.length, 1);
  assertPanelMatches(result, chart);
  assert.ok(
    result.panels.every(
      (panel) =>
        !(
          panel.left <= chevronCard.left &&
          panel.right >= chevronCard.right
        ),
    ),
  );
});

test("keeps an outer plot when two internal annotation boxes contain chevrons", () => {
  const width = 1200;
  const height = 720;
  const mask = new Uint8Array(width * height);
  const outerPlot = {
    left: 55,
    top: 48,
    right: 1100,
    bottom: 660,
  };
  const firstAnnotation = {
    left: 115,
    top: 100,
    right: 405,
    bottom: 270,
  };
  const secondAnnotation = {
    left: 735,
    top: 115,
    right: 1030,
    bottom: 285,
  };
  const lowCurveBounds = {
    left: outerPlot.left,
    top: 320,
    right: outerPlot.right,
    bottom: outerPlot.bottom,
  };

  drawFrame(mask, width, outerPlot);
  drawDistributionCurve(
    mask,
    width,
    lowCurveBounds,
    [0.2, 0.48, 0.77],
  );
  for (const annotation of [firstAnnotation, secondAnnotation]) {
    drawFrame(mask, width, annotation);
    drawChevron(mask, width, annotation);
  }

  const result = detectChartPanelsFromMask(mask, width, height);

  assert.equal(result.detectedPanelCount, 1);
  assert.equal(result.panels.length, 1);
  assertPanelMatches(result, outerPlot);
});
