import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import { encode as encodePng } from "fast-png";

const OUTPUT_DIRECTORY = new URL("../public/samples/", import.meta.url);
const SAMPLE_FILE_NAME = "vnand-fhd-dense-30-chart-sample.png";
const MANIFEST_FILE_NAME =
  "vnand-fhd-dense-30-chart-sample.json";
const WIDTH = 1920;
const HEIGHT = 1080;
const SEED = 0x30f1d;

const COLORS = {
  paper: [247, 249, 252],
  white: [255, 255, 255],
  ink: [31, 39, 51],
  muted: [104, 116, 132],
  border: [174, 185, 198],
  grid: [224, 230, 237],
  blue: [37, 104, 178],
  orange: [220, 122, 43],
  green: [39, 145, 101],
  red: [199, 60, 66],
  violet: [119, 81, 172],
  teal: [27, 136, 145],
  gold: [201, 151, 31],
  photoDark: [56, 70, 89],
  photoMid: [112, 143, 166],
  photoLight: [187, 207, 218],
};

const LANE_LEFTS = [20, 328, 636, 944, 1252, 1560];
const LANE_TOPS = [28, 234, 440, 646, 852];
const WIDTHS = [
  300, 294, 288, 300, 282, 298,
  292, 175, 300, 286, 294, 300,
  284, 300, 290, 298, 280, 300,
  300, 188, 286, 300, 292, 284,
  290, 300, 282, 296, 300, 193,
];
const HEIGHTS = [
  178, 182, 170, 184, 176, 180,
  180, 110, 184, 168, 178, 182,
  166, 184, 174, 180, 170, 184,
  182, 133, 168, 184, 176, 170,
  176, 184, 166, 180, 172, 108,
];
const LEFT_OFFSETS = [0, 3, 5, 0, 5, 1];
const TOP_OFFSETS = [0, 8, 3, 10, 5, 7];
const SINGLE_PEAK_INDEXES = new Set([1, 7, 11, 16, 19, 24, 29]);

const charts = [];
for (let row = 0; row < 5; row += 1) {
  for (let column = 0; column < 6; column += 1) {
    const index = row * 6 + column;
    const left =
      LANE_LEFTS[column] +
      LEFT_OFFSETS[(index + row) % LEFT_OFFSETS.length];
    const top =
      LANE_TOPS[row] +
      TOP_OFFSETS[(index + column) % TOP_OFFSETS.length];
    const peakCount = SINGLE_PEAK_INDEXES.has(index)
      ? 1
      : index % 4 === 0
        ? 4
        : index % 4 === 1
          ? 6
          : 8;
    charts.push({
      index,
      row,
      column,
      bounds: {
        left,
        top,
        right: left + WIDTHS[index],
        bottom: top + HEIGHTS[index],
      },
      peakCount,
      singlePeak: peakCount === 1,
    });
  }
}

const distractors = [
  {
    type: "table",
    bounds: { left: 514, top: 246, right: 623, bottom: 350 },
  },
  {
    type: "diagram",
    bounds: { left: 528, top: 665, right: 623, bottom: 792 },
  },
  {
    type: "photo",
    bounds: { left: 1764, top: 862, right: 1856, bottom: 968 },
  },
];

const pixels = new Uint8Array(WIDTH * HEIGHT * 3);

function setPixel(x, y, color) {
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

function fillRect(left, top, right, bottom, color) {
  for (
    let y = Math.max(0, Math.round(top));
    y <= Math.min(HEIGHT - 1, Math.round(bottom));
    y += 1
  ) {
    for (
      let x = Math.max(0, Math.round(left));
      x <= Math.min(WIDTH - 1, Math.round(right));
      x += 1
    ) {
      setPixel(x, y, color);
    }
  }
}

function drawLine(x1, y1, x2, y2, color, thickness = 1) {
  const steps = Math.max(
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
    1,
  );
  const radius = Math.max(0, Math.floor(thickness / 2));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (
      let localY = y - radius;
      localY <= y + radius;
      localY += 1
    ) {
      for (
        let localX = x - radius;
        localX <= x + radius;
        localX += 1
      ) {
        setPixel(localX, localY, color);
      }
    }
  }
}

function drawRect(left, top, right, bottom, color, thickness = 1) {
  for (let inset = 0; inset < thickness; inset += 1) {
    drawLine(
      left + inset,
      top + inset,
      right - inset,
      top + inset,
      color,
    );
    drawLine(
      left + inset,
      bottom - inset,
      right - inset,
      bottom - inset,
      color,
    );
    drawLine(
      left + inset,
      top + inset,
      left + inset,
      bottom - inset,
      color,
    );
    drawLine(
      right - inset,
      top + inset,
      right - inset,
      bottom - inset,
      color,
    );
  }
}

function drawPseudoText(left, top, width, rows = 1) {
  for (let row = 0; row < rows; row += 1) {
    const y = top + row * 5;
    const rowWidth = Math.round(width * (0.72 + row * 0.16));
    for (let cursor = left; cursor < left + rowWidth; cursor += 7) {
      drawLine(
        cursor,
        y,
        Math.min(cursor + 4, left + rowWidth),
        y,
        COLORS.muted,
      );
    }
  }
}

function seededNoise(index, state) {
  let value = (SEED ^ (index * 0x9e3779b1) ^ (state * 0x85ebca6b)) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0xffffffff;
}

function peakCenters(chart) {
  if (chart.peakCount === 1) {
    return [0.42 + seededNoise(chart.index, 0) * 0.16];
  }
  const left = 0.07;
  const right = 0.93;
  const spacing = (right - left) / (chart.peakCount - 1);
  return Array.from({ length: chart.peakCount }, (_, state) => {
    const jitter =
      (seededNoise(chart.index, state) - 0.5) * spacing * 0.08;
    return left + state * spacing + jitter;
  });
}

function densityAt(progress, chart, centers) {
  let density = 1e-7;
  const spacing =
    centers.length === 1
      ? 0.2
      : (centers.at(-1) - centers[0]) /
        Math.max(1, centers.length - 1);
  for (let state = 0; state < centers.length; state += 1) {
    const center = centers[state];
    const baseWidth =
      centers.length === 1
        ? 0.105
        : spacing * (chart.index % 3 === 0 ? 0.22 : 0.17);
    const width =
      baseWidth *
      (progress < center ? 0.82 : 1.18) *
      (0.92 + seededNoise(chart.index, state + 31) * 0.16);
    const z = (progress - center) / width;
    density +=
      (0.78 + seededNoise(chart.index, state + 61) * 0.21) *
      Math.exp(-0.5 * z * z);
  }
  return Math.max(1e-7, Math.min(1, density));
}

function drawChart(chart) {
  const { left, top, right, bottom } = chart.bounds;
  const chartWidth = right - left;
  const chartHeight = bottom - top;
  fillRect(left, top, right, bottom, COLORS.white);

  for (let grid = 1; grid < 4; grid += 1) {
    const y = top + (chartHeight * grid) / 4;
    drawLine(left, y, right, y, COLORS.grid);
  }
  for (let grid = 1; grid < 5; grid += 1) {
    const x = left + (chartWidth * grid) / 5;
    drawLine(x, top, x, bottom, COLORS.grid);
  }
  drawRect(left, top, right, bottom, COLORS.ink, 2);

  const centers = peakCenters(chart);
  const curveColors = [
    COLORS.blue,
    COLORS.orange,
    COLORS.green,
    COLORS.red,
    COLORS.violet,
    COLORS.teal,
    COLORS.gold,
    COLORS.blue,
  ];
  let previous = null;
  for (let x = left + 3; x <= right - 3; x += 1) {
    const progress = (x - (left + 3)) / Math.max(1, chartWidth - 6);
    const density = densityAt(progress, chart, centers);
    const logDensity = Math.max(-6, Math.log10(density));
    const y = top + 3 + ((0 - logDensity) / 6) * (chartHeight - 6);
    const stateIndex = Math.min(
      centers.length - 1,
      Math.max(
        0,
        centers.findIndex((center) => progress <= center),
      ),
    );
    const point = { x, y };
    if (previous) {
      drawLine(
        previous.x,
        previous.y,
        point.x,
        point.y,
        curveColors[stateIndex],
        2,
      );
    }
    previous = point;
  }

  // Detached title and axis-label strokes make this resemble a dense PPT
  // screenshot while remaining outside the expected plot-frame crop.
  drawPseudoText(left + 5, Math.max(2, top - 9), Math.min(42, chartWidth / 4));
  drawPseudoText(
    left + Math.round(chartWidth * 0.43),
    Math.min(HEIGHT - 3, bottom + 6),
    Math.min(26, chartWidth / 6),
  );
}

function drawTable({ left, top, right, bottom }) {
  fillRect(left, top, right, bottom, COLORS.white);
  drawRect(left, top, right, bottom, COLORS.ink, 2);
  for (let column = 1; column < 3; column += 1) {
    const x = left + ((right - left) * column) / 3;
    drawLine(x, top, x, bottom, COLORS.ink);
  }
  for (let row = 1; row < 4; row += 1) {
    const y = top + ((bottom - top) * row) / 4;
    drawLine(left, y, right, y, COLORS.ink);
  }
  for (let row = 0; row < 4; row += 1) {
    drawPseudoText(
      left + 5,
      top + 10 + row * ((bottom - top) / 4),
      23,
    );
  }
}

function drawDiagram({ left, top, right, bottom }) {
  fillRect(left, top, right, bottom, COLORS.white);
  const boxHeight = 27;
  const first = {
    left: left + 7,
    top: top + 8,
    right: right - 28,
    bottom: top + 8 + boxHeight,
  };
  const second = {
    left: left + 25,
    top: bottom - boxHeight - 8,
    right: right - 7,
    bottom: bottom - 8,
  };
  drawRect(
    first.left,
    first.top,
    first.right,
    first.bottom,
    COLORS.ink,
    2,
  );
  drawRect(
    second.left,
    second.top,
    second.right,
    second.bottom,
    COLORS.ink,
    2,
  );
  drawPseudoText(first.left + 5, first.top + 11, 31);
  drawPseudoText(second.left + 5, second.top + 11, 31);
  drawLine(
    first.right,
    (first.top + first.bottom) / 2,
    second.left,
    (second.top + second.bottom) / 2,
    COLORS.ink,
    2,
  );
}

function drawPhoto({ left, top, right, bottom }) {
  fillRect(left, top, right, bottom, COLORS.photoLight);
  for (let stripe = 0; stripe < 7; stripe += 1) {
    const x = left + ((right - left) * stripe) / 7;
    drawLine(
      x,
      top,
      x + (right - left) * 0.42,
      bottom,
      stripe % 2 ? COLORS.photoDark : COLORS.photoMid,
      5,
    );
  }
  fillRect(
    left + 8,
    bottom - 25,
    right - 7,
    bottom - 7,
    COLORS.photoDark,
  );
  drawRect(left, top, right, bottom, COLORS.border, 2);
}

fillRect(0, 0, WIDTH - 1, HEIGHT - 1, COLORS.paper);
drawPseudoText(24, 8, 164, 2);
charts.forEach(drawChart);
drawTable(distractors[0].bounds);
drawDiagram(distractors[1].bounds);
drawPhoto(distractors[2].bounds);

const encoded = encodePng({
  width: WIDTH,
  height: HEIGHT,
  data: pixels,
  channels: 3,
  depth: 8,
});

const minimumHorizontalGapPixels = Math.min(
  ...charts.flatMap((chart, index) =>
    charts
      .slice(index + 1)
      .filter((other) => other.row === chart.row)
      .map((other) => other.bounds.left - chart.bounds.right),
  ),
);
const minimumVerticalGapPixels = Math.min(
  ...charts.flatMap((chart, index) =>
    charts
      .slice(index + 1)
      .filter((other) => other.column === chart.column)
      .map((other) => other.bounds.top - chart.bounds.bottom),
  ),
);

const manifest = {
  fileName: SAMPLE_FILE_NAME,
  width: WIDTH,
  height: HEIGHT,
  seed: SEED,
  expectedChartCount: charts.length,
  layout: { rows: 5, columns: 6 },
  minimumHorizontalGapPixels,
  minimumVerticalGapPixels,
  singlePeakChartIndexes: charts
    .filter((chart) => chart.singlePeak)
    .map((chart) => chart.index),
  charts,
  distractors,
  bytes: encoded.length,
  sha256: createHash("sha256").update(encoded).digest("hex"),
};

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
await writeFile(
  new URL(SAMPLE_FILE_NAME, OUTPUT_DIRECTORY),
  encoded,
);
await writeFile(
  new URL(MANIFEST_FILE_NAME, OUTPUT_DIRECTORY),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(JSON.stringify(manifest, null, 2));
