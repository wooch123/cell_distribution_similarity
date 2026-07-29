import { encode as encodePng } from "fast-png";

const CURVE_COLORS = Object.freeze([
  [26, 102, 214],
  [211, 54, 66],
  [24, 151, 87],
  [162, 65, 184],
]);

function putPixel(
  pixels,
  width,
  height,
  x,
  y,
  color,
) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const offset = (y * width + x) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function drawLine(
  pixels,
  width,
  height,
  x1,
  y1,
  x2,
  y2,
  color,
  thickness = 1,
  { dashed = false } = {},
) {
  const steps = Math.max(
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
    1,
  );
  for (let step = 0; step <= steps; step += 1) {
    if (dashed && step % 7 >= 4) continue;
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let offsetY = 0; offsetY < thickness; offsetY += 1) {
      for (let offsetX = 0; offsetX < thickness; offsetX += 1) {
        putPixel(
          pixels,
          width,
          height,
          x + offsetX,
          y + offsetY,
          color,
        );
      }
    }
  }
}

function fillRect(
  pixels,
  width,
  height,
  left,
  top,
  right,
  bottom,
  color,
) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      putPixel(pixels, width, height, x, y, color);
    }
  }
}

function drawBoundary(pixels, width, height, chart) {
  if (chart.boundary === "none") return;
  const color =
    chart.boundary === "weak"
      ? [126, 132, 142]
      : [43, 47, 54];
  const dashed = chart.boundary === "weak";
  drawLine(
    pixels,
    width,
    height,
    chart.left,
    chart.top,
    chart.left,
    chart.bottom,
    color,
    1,
    { dashed },
  );
  drawLine(
    pixels,
    width,
    height,
    chart.left,
    chart.bottom,
    chart.right,
    chart.bottom,
    color,
    1,
    { dashed },
  );
  if (chart.boundary !== "l-axis") {
    drawLine(
      pixels,
      width,
      height,
      chart.left,
      chart.top,
      chart.right,
      chart.top,
      color,
      1,
      { dashed },
    );
    drawLine(
      pixels,
      width,
      height,
      chart.right,
      chart.top,
      chart.right,
      chart.bottom,
      color,
      1,
      { dashed },
    );
  }
}

function drawDistribution(
  pixels,
  width,
  height,
  chart,
  chartIndex,
) {
  const insetX = Math.max(2, Math.round((chart.right - chart.left) * 0.05));
  const insetY = Math.max(2, Math.round((chart.bottom - chart.top) * 0.08));
  const left = chart.left + insetX;
  const right = chart.right - insetX;
  const top = chart.top + insetY;
  const bottom = chart.bottom - insetY;
  const usableHeight = Math.max(3, bottom - top);
  const peaks = chart.peaks;
  const peakWidth =
    peaks.length === 1
      ? 0.16
      : peaks.length === 2
        ? 0.105
        : 0.075;
  let previous = null;

  for (let x = left; x <= right; x += 1) {
    const progress = (x - left) / Math.max(1, right - left);
    let response = 0;
    for (const peak of peaks) {
      const distance = (progress - peak) / peakWidth;
      response = Math.max(
        response,
        Math.exp(-0.5 * distance * distance),
      );
    }
    const tail =
      chartIndex % 3 === 0
        ? 0.06 * Math.max(0, (progress - 0.76) / 0.24)
        : 0;
    const y = Math.round(
      bottom - response * usableHeight * 0.8 + tail * usableHeight,
    );
    if (previous) {
      drawLine(
        pixels,
        width,
        height,
        previous.x,
        previous.y,
        x,
        y,
        chart.curveColor ??
          CURVE_COLORS[chartIndex % CURVE_COLORS.length],
      );
    }
    previous = { x, y };
  }
}

function drawTinyLabel(pixels, width, height, chart, index) {
  if (chart.top < 3 || index % 3 !== 0) return;
  const y = chart.top - 2;
  const maximum = Math.min(chart.right, chart.left + 13);
  for (let x = chart.left + 2; x <= maximum; x += 3) {
    drawLine(
      pixels,
      width,
      height,
      x,
      y,
      Math.min(maximum, x + 1),
      y,
      [67, 71, 78],
    );
  }
}

function encodedFixture(width, height, pixels, charts) {
  return {
    width,
    height,
    channels: 3,
    pixels,
    bytes: encodePng({
      width,
      height,
      data: pixels,
      channels: 3,
      depth: 8,
    }),
    mimeType: "image/png",
    charts,
    expectedChartCount: charts.length,
  };
}

function drawCharts(width, height, charts) {
  const pixels = new Uint8Array(width * height * 3).fill(255);
  charts.forEach((chart, index) => {
    drawBoundary(pixels, width, height, chart);
    drawDistribution(pixels, width, height, chart, index);
    drawTinyLabel(pixels, width, height, chart, index);
  });
  return encodedFixture(width, height, pixels, charts);
}

export function tinyFourChartFixture() {
  return drawCharts(160, 90, [
    {
      left: 3,
      top: 5,
      right: 76,
      bottom: 38,
      boundary: "weak",
      peaks: [0.2, 0.5, 0.8],
    },
    {
      left: 91,
      top: 4,
      right: 157,
      bottom: 35,
      boundary: "l-axis",
      peaks: [0.5],
    },
    {
      left: 7,
      top: 52,
      right: 66,
      bottom: 87,
      boundary: "none",
      peaks: [0.48],
    },
    {
      left: 79,
      top: 45,
      right: 157,
      bottom: 88,
      boundary: "rectangle",
      peaks: [0.27, 0.7],
    },
  ]);
}

export function tinyTwelveChartFixture() {
  const charts = [
    [3, 4, 53, 36, "weak", [0.5]],
    [61, 3, 113, 34, "l-axis", [0.25, 0.7]],
    [122, 6, 178, 39, "rectangle", [0.25, 0.7]],
    [188, 2, 237, 33, "none", [0.5]],
    [5, 48, 59, 82, "rectangle", [0.28, 0.72]],
    [68, 40, 121, 76, "l-axis", [0.25, 0.7]],
    [128, 49, 182, 83, "l-axis", [0.25, 0.7]],
    [191, 43, 237, 76, "rectangle", [0.5]],
    [2, 96, 56, 132, "none", [0.5]],
    [64, 90, 122, 128, "l-axis", [0.25, 0.7]],
    [131, 96, 186, 133, "weak", [0.18, 0.5, 0.82]],
    [195, 87, 238, 126, "rectangle", [0.5]],
  ].map(
    ([left, top, right, bottom, boundary, peaks]) => ({
      left,
      top,
      right,
      bottom,
      boundary,
      peaks,
    }),
  );
  charts[5].curveColor = CURVE_COLORS[2];
  return drawCharts(240, 135, charts);
}

export function tinyGridDecoratedWaveformFixture(options = {}) {
  const width = 240;
  const height = 135;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const chart = {
    left: 10,
    top: 8,
    right: 230,
    bottom: 126,
    boundary: "rectangle",
    peaks: [0.13, 0.38, 0.63, 0.87],
    curveColor: options.curveColor,
  };
  drawBoundary(pixels, width, height, chart);

  // A shared lattice and two shaded cells intentionally resemble a table.
  for (let column = 1; column < 7; column += 1) {
    const x = Math.round(
      chart.left +
        ((chart.right - chart.left) * column) / 7,
    );
    drawLine(
      pixels,
      width,
      height,
      x,
      chart.top + 1,
      x,
      chart.bottom - 1,
      [184, 190, 200],
    );
  }
  for (let row = 1; row < 6; row += 1) {
    const y = Math.round(
      chart.top +
        ((chart.bottom - chart.top) * row) / 6,
    );
    drawLine(
      pixels,
      width,
      height,
      chart.left + 1,
      y,
      chart.right - 1,
      y,
      [184, 190, 200],
    );
  }
  fillRect(
    pixels,
    width,
    height,
    171,
    12,
    196,
    23,
    [235, 240, 248],
  );
  fillRect(
    pixels,
    width,
    height,
    199,
    12,
    226,
    23,
    [242, 236, 247],
  );
  drawDistribution(pixels, width, height, chart, 0);
  return encodedFixture(width, height, pixels, [chart]);
}

export function tinyNeutralGridDecoratedWaveformFixture() {
  return tinyGridDecoratedWaveformFixture({
    curveColor: [27, 30, 34],
  });
}

export function tinyColoredTableFixture() {
  const width = 240;
  const height = 135;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const bounds = {
    left: 8,
    top: 7,
    right: 232,
    bottom: 128,
  };
  const columns = 7;
  const rows = 6;
  const fills = [
    [240, 190, 196],
    [181, 207, 244],
    [174, 224, 195],
    [222, 191, 230],
  ];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = Math.round(
        bounds.left +
          ((bounds.right - bounds.left) * column) / columns,
      );
      const right = Math.round(
        bounds.left +
          ((bounds.right - bounds.left) * (column + 1)) / columns,
      );
      const top = Math.round(
        bounds.top +
          ((bounds.bottom - bounds.top) * row) / rows,
      );
      const bottom = Math.round(
        bounds.top +
          ((bounds.bottom - bounds.top) * (row + 1)) / rows,
      );
      fillRect(
        pixels,
        width,
        height,
        left + 2,
        top + 2,
        right - 2,
        bottom - 2,
        fills[(row + column) % fills.length],
      );
      drawLine(
        pixels,
        width,
        height,
        left + 5,
        Math.round((top + bottom) / 2),
        right - 5,
        Math.round((top + bottom) / 2),
        CURVE_COLORS[(row + column) % CURVE_COLORS.length],
      );
    }
  }
  for (let column = 0; column <= columns; column += 1) {
    const x = Math.round(
      bounds.left +
        ((bounds.right - bounds.left) * column) / columns,
    );
    drawLine(
      pixels,
      width,
      height,
      x,
      bounds.top,
      x,
      bounds.bottom,
      [41, 45, 52],
    );
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * row) / rows,
    );
    drawLine(
      pixels,
      width,
      height,
      bounds.left,
      y,
      bounds.right,
      y,
      [41, 45, 52],
    );
  }
  return encodedFixture(width, height, pixels, []);
}
