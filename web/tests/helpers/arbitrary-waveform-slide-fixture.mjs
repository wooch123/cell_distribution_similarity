import { encode as encodePng } from "fast-png";

const WIDTH = 960;
const HEIGHT = 540;

const COLORS = Object.freeze({
  paper: [248, 249, 251],
  white: [255, 255, 255],
  ink: [31, 38, 49],
  muted: [95, 106, 121],
  border: [139, 150, 164],
  grid: [224, 229, 235],
  blue: [30, 105, 190],
  orange: [222, 126, 41],
  green: [37, 148, 92],
  red: [202, 57, 64],
  violet: [129, 82, 178],
  teal: [26, 143, 151],
  gold: [202, 153, 32],
  magenta: [203, 80, 146],
});

const CURVE_COLORS = Object.freeze([
  COLORS.blue,
  COLORS.orange,
  COLORS.green,
  COLORS.red,
  COLORS.violet,
  COLORS.teal,
  COLORS.gold,
  COLORS.magenta,
]);

// No two charts share an exact left, top, width, or height. The loose visual
// bands contain 5, 4, 6, and 5 charts rather than a repeated row/column grid.
// Several charts are close to one another or the image boundary, while
// distractors occupy the otherwise open spaces.
const CHART_DEFINITIONS = Object.freeze([
  [2, 2, 165, 88, "rectangle", [0.12, 0.36, 0.62, 0.86]],
  [190, 14, 312, 77, "l-axis", [0.5]],
  [339, 3, 540, 104, "rectangle", [0.07, 0.24, 0.41, 0.58, 0.75, 0.92]],
  [546, 35, 645, 90, "rectangle", [0.52]],
  [711, 4, 956, 107, "l-axis", [0.14, 0.39, 0.65, 0.87]],

  [18, 122, 133, 180, "rectangle", [0.28, 0.72]],
  [139, 105, 367, 219, "l-axis", [0.07, 0.24, 0.42, 0.59, 0.76, 0.93]],
  [403, 136, 545, 201, "rectangle", [0.48]],
  [731, 118, 954, 226, "rectangle", [0.13, 0.37, 0.63, 0.87]],

  [3, 239, 148, 316, "l-axis", [0.51]],
  [176, 228, 279, 287, "rectangle", [0.14, 0.38, 0.64, 0.88]],
  [285, 255, 500, 346, "rectangle", [0.29, 0.7]],
  [526, 221, 615, 272, "l-axis", [0.47]],
  [643, 246, 781, 321, "rectangle", [0.08, 0.25, 0.42, 0.59, 0.76, 0.92]],
  [811, 229, 957, 323, "rectangle", [0.12, 0.37, 0.63, 0.88]],

  [15, 399, 236, 533, "rectangle", [0.08, 0.24, 0.41, 0.58, 0.75, 0.92]],
  [262, 420, 369, 484, "l-axis", [0.5]],
  [396, 374, 551, 469, "rectangle", [0.13, 0.38, 0.62, 0.87]],
  [585, 431, 769, 538, "rectangle", [0.3, 0.71]],
  [805, 392, 958, 539, "l-axis", [0.08, 0.25, 0.42, 0.59, 0.76, 0.92]],
]);

const DISTRACTORS = Object.freeze([
  {
    type: "explanation-text-card",
    bounds: { left: 565, top: 112, right: 704, bottom: 201 },
  },
  {
    type: "numeric-table",
    bounds: { left: 7, top: 326, right: 241, bottom: 382 },
  },
  {
    type: "process-diagram",
    bounds: { left: 252, top: 350, right: 381, bottom: 405 },
  },
  {
    type: "monotonic-line-chart",
    bounds: { left: 568, top: 329, right: 790, bottom: 414 },
  },
]);

const SOURCE_QLC_COLUMNS = Object.freeze([
  [59, 232],
  [286, 458],
  [511, 684],
  [737, 909],
  [963, 1136],
]);
const SOURCE_QLC_ROWS = Object.freeze([
  [123, 245],
  [300, 422],
  [476, 600],
  [655, 780],
]);
const SOURCE_QLC_PANELS = Object.freeze(
  SOURCE_QLC_ROWS.flatMap(([top, bottom]) =>
    SOURCE_QLC_COLUMNS.map(([left, right]) => ({
      left,
      top,
      right,
      bottom,
    })),
  ),
);
const SOURCE_QLC_PERMUTATION = Object.freeze([
  11, 2, 17, 6, 19,
  4, 13, 0, 8,
  15, 5, 18, 1, 10, 7,
  14, 3, 16, 9, 12,
]);

function setPixel(pixels, x, y, color) {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  if (
    roundedX < 0 ||
    roundedX >= WIDTH ||
    roundedY < 0 ||
    roundedY >= HEIGHT
  ) {
    return;
  }
  const offset = (roundedY * WIDTH + roundedX) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function fillRect(pixels, left, top, right, bottom, color) {
  for (let y = Math.max(0, top); y <= Math.min(HEIGHT - 1, bottom); y += 1) {
    for (let x = Math.max(0, left); x <= Math.min(WIDTH - 1, right); x += 1) {
      setPixel(pixels, x, y, color);
    }
  }
}

function drawLine(
  pixels,
  x1,
  y1,
  x2,
  y2,
  color,
  thickness = 1,
  { dashed = false } = {},
) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  const radius = Math.max(0, Math.floor(thickness / 2));
  for (let step = 0; step <= steps; step += 1) {
    if (dashed && step % 7 >= 4) continue;
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let localY = y - radius; localY <= y + radius; localY += 1) {
      for (let localX = x - radius; localX <= x + radius; localX += 1) {
        setPixel(pixels, localX, localY, color);
      }
    }
  }
}

function drawRect(pixels, bounds, color, thickness = 1) {
  for (let inset = 0; inset < thickness; inset += 1) {
    drawLine(
      pixels,
      bounds.left + inset,
      bounds.top + inset,
      bounds.right - inset,
      bounds.top + inset,
      color,
    );
    drawLine(
      pixels,
      bounds.left + inset,
      bounds.bottom - inset,
      bounds.right - inset,
      bounds.bottom - inset,
      color,
    );
    drawLine(
      pixels,
      bounds.left + inset,
      bounds.top + inset,
      bounds.left + inset,
      bounds.bottom - inset,
      color,
    );
    drawLine(
      pixels,
      bounds.right - inset,
      bounds.top + inset,
      bounds.right - inset,
      bounds.bottom - inset,
      color,
    );
  }
}

function drawPseudoText(
  pixels,
  left,
  top,
  width,
  rows,
  color = COLORS.muted,
) {
  for (let row = 0; row < rows; row += 1) {
    const y = top + row * 11;
    const rowWidth = Math.round(width * (0.72 + (row % 3) * 0.11));
    for (let cursor = left; cursor < left + rowWidth; cursor += 9) {
      const glyphWidth = 4 + ((cursor + row) % 3);
      drawLine(
        pixels,
        cursor,
        y,
        Math.min(cursor + glyphWidth, left + rowWidth),
        y,
        color,
      );
      if ((cursor + row) % 2 === 0) {
        drawLine(pixels, cursor, y, cursor, y + 5, color);
      }
    }
  }
}

function drawAxes(pixels, chart) {
  const { bounds, axisMode } = chart;
  if (axisMode === "rectangle") {
    drawRect(pixels, bounds, COLORS.ink);
  } else {
    drawLine(
      pixels,
      bounds.left,
      bounds.top,
      bounds.left,
      bounds.bottom,
      COLORS.ink,
    );
    drawLine(
      pixels,
      bounds.left,
      bounds.bottom,
      bounds.right,
      bounds.bottom,
      COLORS.ink,
    );
  }

  const chartWidth = bounds.right - bounds.left;
  const chartHeight = bounds.bottom - bounds.top;
  for (const ratio of [0.25, 0.5, 0.75]) {
    const y = Math.round(bounds.top + chartHeight * ratio);
    drawLine(
      pixels,
      bounds.left + 1,
      y,
      bounds.right - 1,
      y,
      COLORS.grid,
    );
  }
  const verticalLines = chartWidth >= 150 ? [0.2, 0.4, 0.6, 0.8] : [0.33, 0.67];
  for (const ratio of verticalLines) {
    const x = Math.round(bounds.left + chartWidth * ratio);
    drawLine(
      pixels,
      x,
      bounds.top + 1,
      x,
      bounds.bottom - 1,
      COLORS.grid,
    );
  }
}

function drawDistribution(pixels, chart, chartIndex) {
  const { bounds, peakCenters } = chart;
  const insetX = Math.max(4, Math.round((bounds.right - bounds.left) * 0.055));
  const insetY = Math.max(4, Math.round((bounds.bottom - bounds.top) * 0.09));
  const left = bounds.left + insetX;
  const right = bounds.right - insetX;
  const top = bounds.top + insetY;
  const bottom = bounds.bottom - insetY;
  const usableHeight = Math.max(4, bottom - top);
  const peakWidth =
    peakCenters.length === 1 ? 0.13 : peakCenters.length === 2 ? 0.09 : 0.052;
  let previous;

  for (let x = left; x <= right; x += 1) {
    const progress = (x - left) / Math.max(1, right - left);
    let response = 0;
    for (let peakIndex = 0; peakIndex < peakCenters.length; peakIndex += 1) {
      const asymmetry = progress < peakCenters[peakIndex] ? 0.88 : 1.14;
      const distance =
        (progress - peakCenters[peakIndex]) / (peakWidth * asymmetry);
      response = Math.max(response, Math.exp(-0.5 * distance * distance));
    }
    const rightTail =
      chartIndex % 4 === 0
        ? 0.07 * Math.max(0, (progress - 0.78) / 0.22)
        : 0;
    const y = Math.round(
      bottom - response * usableHeight * 0.82 + rightTail * usableHeight,
    );
    if (previous) {
      const nearestPeak = peakCenters.reduce(
        (best, center, index) =>
          Math.abs(center - progress) <
          Math.abs(peakCenters[best] - progress)
            ? index
            : best,
        0,
      );
      drawLine(
        pixels,
        previous.x,
        previous.y,
        x,
        y,
        CURVE_COLORS[(nearestPeak + chartIndex) % CURVE_COLORS.length],
        1,
      );
    }
    previous = { x, y };
  }
}

function drawChart(pixels, chart, chartIndex) {
  fillRect(
    pixels,
    chart.bounds.left,
    chart.bounds.top,
    chart.bounds.right,
    chart.bounds.bottom,
    COLORS.white,
  );
  drawAxes(pixels, chart);
  drawDistribution(pixels, chart, chartIndex);
  if (chart.bounds.top >= 12 && chartIndex % 3 === 0) {
    drawPseudoText(
      pixels,
      chart.bounds.left + 3,
      chart.bounds.top - 8,
      Math.min(45, chart.bounds.right - chart.bounds.left),
      1,
      COLORS.ink,
    );
  }
}

function drawTextCard(pixels, bounds) {
  fillRect(pixels, bounds.left, bounds.top, bounds.right, bounds.bottom, [241, 244, 248]);
  drawRect(pixels, bounds, COLORS.border);
  drawPseudoText(pixels, bounds.left + 8, bounds.top + 10, 116, 7);
}

function drawNumericTable(pixels, bounds) {
  fillRect(pixels, bounds.left, bounds.top, bounds.right, bounds.bottom, COLORS.white);
  drawRect(pixels, bounds, COLORS.ink);
  for (let column = 1; column < 6; column += 1) {
    const x = Math.round(
      bounds.left + ((bounds.right - bounds.left) * column) / 6,
    );
    drawLine(pixels, x, bounds.top, x, bounds.bottom, COLORS.border);
  }
  for (let row = 1; row < 4; row += 1) {
    const y = Math.round(
      bounds.top + ((bounds.bottom - bounds.top) * row) / 4,
    );
    drawLine(pixels, bounds.left, y, bounds.right, y, COLORS.border);
  }
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      const left =
        bounds.left +
        Math.round(((bounds.right - bounds.left) * column) / 6) +
        4;
      const top =
        bounds.top +
        Math.round(((bounds.bottom - bounds.top) * row) / 4) +
        5;
      drawPseudoText(pixels, left, top, 20, 1, COLORS.ink);
    }
  }
}

function drawProcessDiagram(pixels, bounds) {
  fillRect(pixels, bounds.left, bounds.top, bounds.right, bounds.bottom, [245, 247, 250]);
  const nodeCenters = [
    [bounds.left + 23, bounds.top + 21],
    [bounds.left + 74, bounds.top + 20],
    [bounds.left + 105, bounds.top + 54],
    [bounds.left + 49, bounds.top + 58],
  ];
  for (let index = 1; index < nodeCenters.length; index += 1) {
    drawLine(
      pixels,
      nodeCenters[index - 1][0],
      nodeCenters[index - 1][1],
      nodeCenters[index][0],
      nodeCenters[index][1],
      COLORS.muted,
      2,
    );
  }
  for (const [centerX, centerY] of nodeCenters) {
    const node = {
      left: centerX - 13,
      top: centerY - 8,
      right: centerX + 13,
      bottom: centerY + 8,
    };
    fillRect(pixels, node.left, node.top, node.right, node.bottom, [223, 232, 244]);
    drawRect(pixels, node, COLORS.border);
  }
}

function drawMonotonicChart(pixels, bounds) {
  fillRect(pixels, bounds.left, bounds.top, bounds.right, bounds.bottom, COLORS.white);
  drawRect(pixels, bounds, COLORS.ink);
  for (const ratio of [0.25, 0.5, 0.75]) {
    const y = Math.round(bounds.top + (bounds.bottom - bounds.top) * ratio);
    drawLine(pixels, bounds.left + 1, y, bounds.right - 1, y, COLORS.grid);
  }
  let previous;
  for (let x = bounds.left + 9; x <= bounds.right - 9; x += 1) {
    const progress =
      (x - bounds.left - 9) /
      Math.max(1, bounds.right - bounds.left - 18);
    const y = Math.round(
      bounds.bottom -
        9 -
        progress * (bounds.bottom - bounds.top - 20) +
        Math.sin(progress * Math.PI * 1.2) * 2,
    );
    if (previous) {
      drawLine(pixels, previous.x, previous.y, x, y, COLORS.red, 2);
    }
    previous = { x, y };
  }
}

function blankPaperCanvas() {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    const offset = index * 3;
    pixels[offset] = COLORS.paper[0];
    pixels[offset + 1] = COLORS.paper[1];
    pixels[offset + 2] = COLORS.paper[2];
  }
  return pixels;
}

function drawOfficeDistractors(pixels) {
  drawTextCard(pixels, DISTRACTORS[0].bounds);
  drawNumericTable(pixels, DISTRACTORS[1].bounds);
  drawProcessDiagram(pixels, DISTRACTORS[2].bounds);
  drawMonotonicChart(pixels, DISTRACTORS[3].bounds);
}

function encodedFixture(pixels, charts) {
  return {
    width: WIDTH,
    height: HEIGHT,
    channels: 3,
    pixels,
    bytes: encodePng({
      width: WIDTH,
      height: HEIGHT,
      data: pixels,
      channels: 3,
      depth: 8,
    }),
    mimeType: "image/png",
    charts,
    distractors: DISTRACTORS,
    expectedChartCount: charts.length,
  };
}

function copyScaledCrop(
  targetPixels,
  sourcePixels,
  sourceWidth,
  sourceHeight,
  sourceChannels,
  sourceBounds,
  targetBounds,
) {
  const targetWidth = targetBounds.right - targetBounds.left + 1;
  const targetHeight = targetBounds.bottom - targetBounds.top + 1;
  const sourceCropWidth = sourceBounds.right - sourceBounds.left + 1;
  const sourceCropHeight = sourceBounds.bottom - sourceBounds.top + 1;

  for (let localY = 0; localY < targetHeight; localY += 1) {
    const sourceY = Math.max(
      0,
      Math.min(
        sourceHeight - 1,
        sourceBounds.top +
          Math.round(
            (localY / Math.max(1, targetHeight - 1)) *
              (sourceCropHeight - 1),
          ),
      ),
    );
    for (let localX = 0; localX < targetWidth; localX += 1) {
      const sourceX = Math.max(
        0,
        Math.min(
          sourceWidth - 1,
          sourceBounds.left +
            Math.round(
              (localX / Math.max(1, targetWidth - 1)) *
                (sourceCropWidth - 1),
            ),
        ),
      );
      const sourceOffset =
        (sourceY * sourceWidth + sourceX) * sourceChannels;
      setPixel(
        targetPixels,
        targetBounds.left + localX,
        targetBounds.top + localY,
        [
          sourcePixels[sourceOffset],
          sourceChannels > 1
            ? sourcePixels[sourceOffset + 1]
            : sourcePixels[sourceOffset],
          sourceChannels > 2
            ? sourcePixels[sourceOffset + 2]
            : sourcePixels[sourceOffset],
        ],
      );
    }
  }
}

/**
 * A deterministic qHD office-slide fixture whose VTH plots are deliberately
 * not arranged on a recoverable lattice. It is shared by direct detector and
 * API tests so both paths must reject the same mixed office content.
 */
export function arbitraryWaveformOfficeSlideFixture() {
  const pixels = blankPaperCanvas();
  const charts = CHART_DEFINITIONS.map(
    ([left, top, right, bottom, axisMode, peakCenters], index) => ({
      index,
      bounds: { left, top, right, bottom },
      axisMode,
      peakCenters,
      singlePeak: peakCenters.length === 1,
    }),
  );

  charts.forEach((chart, index) => drawChart(pixels, chart, index));
  drawOfficeDistractors(pixels);
  return encodedFixture(pixels, charts);
}

/**
 * Reuses the twenty real QLC Read_Disturb plot crops supplied by the user,
 * but scales and places them at the same non-lattice coordinates as the
 * synthetic stress slide. This catches fixes that only infer the original
 * 4 × 5 lattice instead of independently recognizing each waveform.
 */
export function arbitraryRepositionedQlcSlideFixture(source) {
  const sourcePixels = source.pixels ?? source.data;
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const sourceChannels = source.channels;
  if (
    sourceWidth !== 1672 ||
    sourceHeight !== 941 ||
    sourceChannels < 3 ||
    sourcePixels.length < sourceWidth * sourceHeight * sourceChannels
  ) {
    throw new Error("Expected the 1672 × 941 QLC Read_Disturb source slide.");
  }

  const pixels = blankPaperCanvas();
  const charts = CHART_DEFINITIONS.map(
    ([left, top, right, bottom], index) => ({
      index,
      sourcePanelIndex: SOURCE_QLC_PERMUTATION[index],
      bounds: { left, top, right, bottom },
      axisMode: "rectangle",
      peakCenters: [
        0.07, 0.2, 0.33, 0.46, 0.59, 0.72, 0.84, 0.94,
      ],
      singlePeak: false,
    }),
  );
  for (const chart of charts) {
    copyScaledCrop(
      pixels,
      sourcePixels,
      sourceWidth,
      sourceHeight,
      sourceChannels,
      SOURCE_QLC_PANELS[chart.sourcePanelIndex],
      chart.bounds,
    );
  }
  drawOfficeDistractors(pixels);
  return encodedFixture(pixels, charts);
}
