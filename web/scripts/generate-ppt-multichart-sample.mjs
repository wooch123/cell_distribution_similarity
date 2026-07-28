import { mkdir, writeFile } from "node:fs/promises";

import { encode as encodePng } from "fast-png";

const WIDTH = 1600;
const HEIGHT = 900;
const OUTPUT_URL = new URL(
  "../public/samples/vnand-ppt-12-chart-sample.png",
  import.meta.url,
);

const COLORS = {
  slide: [242, 245, 248],
  white: [255, 255, 255],
  navy: [19, 35, 58],
  ink: [43, 53, 66],
  muted: [105, 116, 130],
  cardBorder: [217, 224, 231],
  grid: [222, 228, 234],
  red: [204, 71, 74],
  orange: [226, 139, 55],
  green: [58, 151, 116],
  blue: [47, 116, 181],
  violet: [124, 91, 171],
  teal: [38, 139, 145],
  brown: [148, 98, 63],
  magenta: [190, 73, 137],
};

const GLYPHS = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00100", "00100", "01000", "10000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

const rgb = new Uint8Array(WIDTH * HEIGHT * 3);

function setPixel(x, y, color) {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const offset = (Math.round(y) * WIDTH + Math.round(x)) * 3;
  rgb[offset] = color[0];
  rgb[offset + 1] = color[1];
  rgb[offset + 2] = color[2];
}

function fillRect(x, y, width, height, color) {
  const startX = Math.max(0, Math.round(x));
  const startY = Math.max(0, Math.round(y));
  const endX = Math.min(WIDTH, Math.round(x + width));
  const endY = Math.min(HEIGHT, Math.round(y + height));
  for (let localY = startY; localY < endY; localY += 1) {
    for (let localX = startX; localX < endX; localX += 1) {
      setPixel(localX, localY, color);
    }
  }
}

function drawLine(x1, y1, x2, y2, color, thickness = 1) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  const radius = Math.max(0, Math.floor(thickness / 2));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let localY = y - radius; localY <= y + radius; localY += 1) {
      for (let localX = x - radius; localX <= x + radius; localX += 1) {
        setPixel(localX, localY, color);
      }
    }
  }
}

function drawRect(x, y, width, height, color, thickness = 1) {
  for (let offset = 0; offset < thickness; offset += 1) {
    drawLine(x + offset, y + offset, x + width - offset, y + offset, color);
    drawLine(
      x + offset,
      y + height - offset,
      x + width - offset,
      y + height - offset,
      color,
    );
    drawLine(x + offset, y + offset, x + offset, y + height - offset, color);
    drawLine(
      x + width - offset,
      y + offset,
      x + width - offset,
      y + height - offset,
      color,
    );
  }
}

function drawDashedLine(x1, y1, x2, y2, color, dash = 5, gap = 4) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  for (let step = 0; step <= steps; step += 1) {
    if (step % (dash + gap) >= dash) continue;
    setPixel(
      Math.round(x1 + ((x2 - x1) * step) / steps),
      Math.round(y1 + ((y2 - y1) * step) / steps),
      color,
    );
  }
}

function measureText(text, scale = 1) {
  return Math.max(0, text.length * 6 * scale - scale);
}

function drawText(text, x, y, color, scale = 1) {
  let cursor = Math.round(x);
  for (const rawCharacter of text.toUpperCase()) {
    const glyph = GLYPHS[rawCharacter] ?? GLYPHS[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== "1") continue;
        fillRect(
          cursor + column * scale,
          y + row * scale,
          scale,
          scale,
          color,
        );
      }
    }
    cursor += 6 * scale;
  }
}

function stateCountAt(chartIndex) {
  return chartIndex % 4 === 0 ? 4 : 8;
}

function densityAt(progress, chartIndex) {
  const stateCount = stateCountAt(chartIndex);
  const left = 0.075 + (chartIndex % 3) * 0.003;
  const right = 0.925 - ((chartIndex + 1) % 3) * 0.003;
  const spacing = (right - left) / (stateCount - 1);
  let density = 0;
  for (let state = 0; state < stateCount; state += 1) {
    const rowDrift =
      (Math.floor(chartIndex / 4) - 1) *
      0.0015 *
      (state - (stateCount - 1) / 2);
    const center =
      left + state * spacing + rowDrift;
    const widthFactor =
      (stateCount === 4 ? 0.095 : 0.135) +
      ((chartIndex * 5 + state * 3) % 5) *
        (stateCount === 4 ? 0.003 : 0.004);
    const tailFactor =
      progress < center
        ? 1 + ((chartIndex + state) % 3) * 0.025
        : 1 + ((chartIndex * 2 + state) % 4) * 0.02;
    const width = spacing * widthFactor * tailFactor;
    const z = (progress - center) / width;
    const amplitude =
      0.8 + ((chartIndex * 7 + state * 5) % 6) * 0.035;
    density += amplitude * Math.exp(-0.5 * z * z);
  }
  return Math.max(1e-6, Math.min(1, density));
}

function drawChart(index, cardX, cardY, cardWidth, cardHeight) {
  fillRect(cardX, cardY, cardWidth, cardHeight, COLORS.white);
  drawRect(cardX, cardY, cardWidth, cardHeight, COLORS.cardBorder);

  const titles = [
    "RETENTION T+00H",
    "RETENTION T+24H",
    "RETENTION T+72H",
    "RETENTION T+168H",
    "PROGRAM FAST",
    "PROGRAM NOMINAL",
    "PROGRAM SLOW",
    "READ DISTURB",
    "TEMP -25C",
    "TEMP +25C",
    "TEMP +85C",
    "CYCLING 10K",
  ];
  drawText(titles[index], cardX + 15, cardY + 13, COLORS.ink, 2);

  const legendX = cardX + cardWidth - 79;
  drawLine(
    legendX,
    cardY + 21,
    legendX + 18,
    cardY + 21,
    COLORS.blue,
    2,
  );
  drawText(
    `${stateCountAt(index)}S PDF`,
    legendX + 23,
    cardY + 18,
    COLORS.muted,
    1,
  );

  const plotLeft = cardX + 43;
  const plotTop = cardY + 43;
  const plotRight = cardX + cardWidth - 14;
  const plotBottom = cardY + cardHeight - 31;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  for (let gridIndex = 1; gridIndex < 6; gridIndex += 1) {
    const y = Math.round(plotTop + (plotHeight * gridIndex) / 6);
    drawLine(plotLeft, y, plotRight, y, COLORS.grid);
  }
  for (let gridIndex = 1; gridIndex < 6; gridIndex += 1) {
    const x = Math.round(plotLeft + (plotWidth * gridIndex) / 6);
    drawDashedLine(x, plotTop, x, plotBottom, COLORS.grid);
  }

  drawRect(plotLeft, plotTop, plotWidth, plotHeight, COLORS.ink, 2);
  for (let tick = 0; tick <= 6; tick += 2) {
    const y = Math.round(plotTop + (plotHeight * tick) / 6);
    drawLine(plotLeft - 4, y, plotLeft, y, COLORS.ink);
    drawText(`1E${tick === 0 ? "0" : `-${tick}`}`, cardX + 6, y - 3, COLORS.muted);
  }
  for (let tick = 0; tick <= 4; tick += 1) {
    const x = Math.round(plotLeft + (plotWidth * tick) / 4);
    drawLine(x, plotBottom, x, plotBottom + 4, COLORS.ink);
    drawText(String(tick * 2 - 3), x - 3, plotBottom + 8, COLORS.muted);
  }
  drawText(
    "VTH",
    plotLeft + Math.round((plotWidth - measureText("VTH")) / 2),
    plotBottom + 19,
    COLORS.muted,
  );
  drawText("LOG Y", cardX + 6, plotTop - 12, COLORS.muted);

  const curveColors = [
    COLORS.blue,
    COLORS.orange,
    COLORS.green,
    COLORS.red,
    COLORS.violet,
    COLORS.teal,
    COLORS.brown,
    COLORS.magenta,
  ];
  const stateCount = stateCountAt(index);
  let previous = null;
  for (let localX = 4; localX <= plotWidth - 4; localX += 1) {
    const progress = localX / plotWidth;
    const density = densityAt(progress, index);
    const logValue = Math.max(-6, Math.log10(density));
    const y = plotTop + ((0 - logValue) / 6) * plotHeight;
    const colorIndex = Math.min(
      stateCount - 1,
      Math.floor(progress * stateCount),
    );
    const point = { x: plotLeft + localX, y };
    if (previous) {
      drawLine(
        previous.x,
        previous.y,
        point.x,
        point.y,
        curveColors[colorIndex],
        2,
      );
    }
    previous = point;
  }
}

fillRect(0, 0, WIDTH, HEIGHT, COLORS.slide);
fillRect(0, 0, WIDTH, 92, COLORS.navy);
fillRect(0, 87, WIDTH, 5, COLORS.green);
drawText("V-NAND VTH DISTRIBUTION REVIEW", 49, 22, COLORS.white, 4);
drawText("LOG SCALE / 12 PROCESS WINDOWS", 53, 64, [177, 199, 218], 2);
drawText("SHAPE ANALYTICS", 1370, 42, [177, 199, 218], 2);

const cardWidth = 364;
const cardHeight = 236;
const columnGap = 16;
const rowGap = 16;
const startX = 48;
const startY = 108;
for (let row = 0; row < 3; row += 1) {
  for (let column = 0; column < 4; column += 1) {
    const index = row * 4 + column;
    drawChart(
      index,
      startX + column * (cardWidth + columnGap),
      startY + row * (cardHeight + rowGap),
      cardWidth,
      cardHeight,
    );
  }
}

drawText(
  "TECHNOLOGY DEVELOPMENT / INTERNAL REVIEW",
  49,
  867,
  COLORS.muted,
  1,
);
drawText("SLIDE 01", 1494, 867, COLORS.muted, 1);

await mkdir(new URL(".", OUTPUT_URL), { recursive: true });
const encoded = encodePng({
  width: WIDTH,
  height: HEIGHT,
  data: rgb,
  channels: 3,
  depth: 8,
});
await writeFile(OUTPUT_URL, encoded);

console.log(
  JSON.stringify({
    output: OUTPUT_URL.pathname,
    width: WIDTH,
    height: HEIGHT,
    bytes: encoded.length,
    expectedStateCounts: Array.from(
      { length: 12 },
      (_, index) => stateCountAt(index),
    ),
  }),
);
