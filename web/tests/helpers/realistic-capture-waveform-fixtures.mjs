import jpeg from "jpeg-js";

const COLORS = Object.freeze({
  paper: [247, 249, 252],
  white: [255, 255, 255],
  ink: [30, 38, 50],
  muted: [91, 103, 120],
  border: [138, 151, 167],
  grid: [220, 227, 235],
  paleBlue: [224, 237, 250],
  paleGreen: [224, 242, 233],
  paleOrange: [250, 235, 216],
  paleViolet: [238, 229, 247],
  red: [200, 56, 63],
  blue: [35, 105, 190],
  green: [38, 147, 92],
  violet: [126, 80, 176],
});

const SOURCE_COLUMNS = Object.freeze([
  [59, 232],
  [286, 458],
  [511, 684],
  [737, 909],
  [963, 1136],
]);
const SOURCE_ROWS = Object.freeze([
  [123, 245],
  [300, 422],
  [476, 600],
  [655, 780],
]);
const SOURCE_PANELS = Object.freeze(
  SOURCE_ROWS.flatMap(([top, bottom]) =>
    SOURCE_COLUMNS.map(([left, right]) => ({
      left,
      top,
      right,
      bottom,
    })),
  ),
);
const SOURCE_ORDER = Object.freeze([
  11, 2, 17, 6, 19, 4, 13, 0, 8, 15, 5,
]);

const CASES = Object.freeze({
  1: {
    name: "realistic-jpeg-1",
    width: 1024,
    height: 640,
    quality: 82,
    charts: [
      [794, 480, 230, 160],
    ],
    distractors: [
      ["text-card", 20, 20, 340, 180],
      ["table", 400, 20, 950, 250],
      ["process-diagram", 30, 280, 400, 610],
      ["rectangle-card", 430, 330, 690, 590],
    ],
  },
  3: {
    name: "realistic-jpeg-3",
    width: 1280,
    height: 720,
    quality: 84,
    charts: [
      [0, 245, 260, 180],
      [510, 25, 190, 140],
      [1180, 625, 67, 49],
    ],
    labelChartIndexes: [0, 1, 2],
    distractors: [
      ["text-card", 40, 25, 400, 175],
      ["table", 760, 40, 1230, 310],
      ["process-diagram", 330, 360, 750, 660],
      ["rectangle-card", 810, 390, 1100, 570],
    ],
  },
  7: {
    name: "realistic-jpeg-7",
    width: 1600,
    height: 900,
    quality: 82,
    charts: [
      [0, 230, 250, 170],
      [300, 3, 190, 140],
      [525, 178, 120, 90],
      [652, 208, 95, 70],
      [820, 500, 240, 160],
      [1190, 305, 145, 105],
      [1533, 851, 67, 49],
    ],
    distractors: [
      ["text-card", 600, 5, 1050, 150],
      ["table", 30, 500, 550, 800],
      ["process-diagram", 1080, 20, 1480, 245],
      ["rectangle-card", 1110, 520, 1500, 760],
    ],
  },
  11: {
    name: "realistic-jpeg-11",
    width: 1920,
    height: 1080,
    quality: 80,
    charts: [
      [0, 380, 300, 205],
      [355, 0, 190, 140],
      [590, 210, 120, 90],
      [718, 238, 95, 70],
      [870, 500, 67, 49],
      [955, 620, 48, 35],
      [1080, 50, 250, 175],
      [1400, 700, 160, 115],
      [1750, 310, 170, 125],
      [80, 900, 220, 150],
      [1800, 1000, 120, 80],
    ],
    distractors: [
      ["text-card", 20, 30, 320, 250],
      ["table", 350, 400, 820, 780],
      ["process-diagram", 1050, 290, 1380, 560],
      ["rectangle-card", 1400, 40, 1700, 300],
    ],
  },
});

const FOUR_K_CASE = Object.freeze({
  name: "realistic-jpeg-4k-small",
  width: 3840,
  height: 2160,
  quality: 84,
  charts: [
    [0, 530, 240, 160],
    [1250, 0, 120, 90],
    [2110, 1020, 95, 70],
    [2212, 1040, 67, 49],
    [3200, 350, 190, 140],
    [3792, 2125, 48, 35],
  ],
  distractors: [
    ["text-card", 300, 100, 1000, 450],
    ["table", 1350, 500, 1950, 1000],
    ["process-diagram", 2500, 800, 3200, 1500],
    ["rectangle-card", 3250, 1500, 3700, 1950],
  ],
  labelChartIndexes: [],
});

function setPixel(pixels, width, height, x, y, color) {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  if (
    roundedX < 0 ||
    roundedX >= width ||
    roundedY < 0 ||
    roundedY >= height
  ) {
    return;
  }
  const offset = (roundedY * width + roundedX) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function createCanvas(width, height) {
  const pixels = new Uint8Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 3;
    pixels[offset] = COLORS.paper[0];
    pixels[offset + 1] = COLORS.paper[1];
    pixels[offset + 2] = COLORS.paper[2];
  }
  return pixels;
}

function fillRect(pixels, width, height, bounds, color) {
  for (
    let y = Math.max(0, bounds.top);
    y <= Math.min(height - 1, bounds.bottom);
    y += 1
  ) {
    for (
      let x = Math.max(0, bounds.left);
      x <= Math.min(width - 1, bounds.right);
      x += 1
    ) {
      setPixel(pixels, width, height, x, y, color);
    }
  }
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
) {
  const steps = Math.max(
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
    1,
  );
  const radius = Math.max(0, Math.floor(thickness / 2));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let localY = y - radius; localY <= y + radius; localY += 1) {
      for (let localX = x - radius; localX <= x + radius; localX += 1) {
        setPixel(
          pixels,
          width,
          height,
          localX,
          localY,
          color,
        );
      }
    }
  }
}

function drawRect(
  pixels,
  width,
  height,
  bounds,
  color,
  thickness = 1,
) {
  for (let inset = 0; inset < thickness; inset += 1) {
    drawLine(
      pixels,
      width,
      height,
      bounds.left + inset,
      bounds.top + inset,
      bounds.right - inset,
      bounds.top + inset,
      color,
    );
    drawLine(
      pixels,
      width,
      height,
      bounds.left + inset,
      bounds.bottom - inset,
      bounds.right - inset,
      bounds.bottom - inset,
      color,
    );
    drawLine(
      pixels,
      width,
      height,
      bounds.left + inset,
      bounds.top + inset,
      bounds.left + inset,
      bounds.bottom - inset,
      color,
    );
    drawLine(
      pixels,
      width,
      height,
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
  width,
  height,
  left,
  top,
  availableWidth,
  rows,
) {
  for (let row = 0; row < rows; row += 1) {
    const y = top + row * 17;
    const rowWidth = Math.round(
      availableWidth * (0.7 + (row % 3) * 0.12),
    );
    for (let cursor = left; cursor < left + rowWidth; cursor += 13) {
      const glyphWidth = 6 + ((cursor + row) % 4);
      drawLine(
        pixels,
        width,
        height,
        cursor,
        y,
        Math.min(left + rowWidth, cursor + glyphWidth),
        y,
        COLORS.muted,
        2,
      );
      if ((cursor + row) % 3 !== 0) {
        drawLine(
          pixels,
          width,
          height,
          cursor,
          y,
          cursor,
          y + 8,
          COLORS.muted,
        );
      }
    }
  }
}

function drawChartLabels(
  pixels,
  width,
  height,
  chart,
) {
  const { bounds } = chart;
  const titleTop = Math.max(0, bounds.top - 12);
  drawPseudoText(
    pixels,
    width,
    height,
    bounds.left + 5,
    titleTop,
    Math.min(72, Math.max(24, chart.width - 10)),
    1,
  );

  for (const ratio of [0.2, 0.5, 0.8]) {
    const x = Math.round(
      bounds.left + (bounds.right - bounds.left) * ratio,
    );
    if (bounds.bottom + 5 < height) {
      drawLine(
        pixels,
        width,
        height,
        x,
        bounds.bottom + 2,
        x,
        bounds.bottom + 5,
        COLORS.ink,
      );
    }
    const y = Math.round(
      bounds.top + (bounds.bottom - bounds.top) * ratio,
    );
    const tickLeft =
      bounds.left >= 8 ? bounds.left - 5 : bounds.right + 2;
    const tickRight =
      bounds.left >= 8 ? bounds.left - 2 : bounds.right + 5;
    drawLine(
      pixels,
      width,
      height,
      tickLeft,
      y,
      tickRight,
      y,
      COLORS.ink,
    );
  }

  if (bounds.bottom + 14 < height) {
    drawPseudoText(
      pixels,
      width,
      height,
      Math.round((bounds.left + bounds.right) / 2) - 8,
      bounds.bottom + 9,
      16,
      1,
    );
  }
  const yAxisX =
    bounds.left >= 16
      ? bounds.left - 11
      : Math.min(width - 2, bounds.right + 9);
  for (
    let y = bounds.top + 8;
    y < bounds.bottom - 5;
    y += 13
  ) {
    drawLine(
      pixels,
      width,
      height,
      yAxisX,
      y,
      yAxisX,
      Math.min(bounds.bottom - 3, y + 6),
      COLORS.muted,
    );
  }
}

function bilinearChannel(
  pixels,
  width,
  channels,
  x,
  y,
  channel,
) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const height = Math.floor(pixels.length / (width * channels));
  const y1 = Math.min(height - 1, y0 + 1);
  const dx = x - x0;
  const dy = y - y0;
  const top =
    pixels[(y0 * width + x0) * channels + channel] * (1 - dx) +
    pixels[(y0 * width + x1) * channels + channel] * dx;
  const bottom =
    pixels[(y1 * width + x0) * channels + channel] * (1 - dx) +
    pixels[(y1 * width + x1) * channels + channel] * dx;
  return Math.round(top * (1 - dy) + bottom * dy);
}

function copyBilinearCrop(
  targetPixels,
  targetWidth,
  targetHeight,
  sourcePixels,
  sourceWidth,
  sourceChannels,
  sourceBounds,
  targetBounds,
) {
  const outputWidth = targetBounds.right - targetBounds.left + 1;
  const outputHeight = targetBounds.bottom - targetBounds.top + 1;
  const sourceCropWidth = sourceBounds.right - sourceBounds.left;
  const sourceCropHeight = sourceBounds.bottom - sourceBounds.top;
  for (let localY = 0; localY < outputHeight; localY += 1) {
    const sourceY =
      sourceBounds.top +
      (localY / Math.max(1, outputHeight - 1)) * sourceCropHeight;
    for (let localX = 0; localX < outputWidth; localX += 1) {
      const sourceX =
        sourceBounds.left +
        (localX / Math.max(1, outputWidth - 1)) * sourceCropWidth;
      setPixel(
        targetPixels,
        targetWidth,
        targetHeight,
        targetBounds.left + localX,
        targetBounds.top + localY,
        [
          bilinearChannel(
            sourcePixels,
            sourceWidth,
            sourceChannels,
            sourceX,
            sourceY,
            0,
          ),
          bilinearChannel(
            sourcePixels,
            sourceWidth,
            sourceChannels,
            sourceX,
            sourceY,
            1,
          ),
          bilinearChannel(
            sourcePixels,
            sourceWidth,
            sourceChannels,
            sourceX,
            sourceY,
            2,
          ),
        ],
      );
    }
  }
}

function drawTextCard(pixels, width, height, bounds) {
  fillRect(pixels, width, height, bounds, COLORS.white);
  drawRect(pixels, width, height, bounds, COLORS.border, 2);
  drawPseudoText(
    pixels,
    width,
    height,
    bounds.left + 18,
    bounds.top + 24,
    bounds.right - bounds.left - 38,
    Math.max(
      3,
      Math.floor((bounds.bottom - bounds.top - 35) / 17),
    ),
  );
}

function drawColoredTable(pixels, width, height, bounds) {
  fillRect(pixels, width, height, bounds, COLORS.white);
  const columns = 6;
  const rows = 7;
  const fills = [
    COLORS.paleBlue,
    COLORS.paleGreen,
    COLORS.paleOrange,
    COLORS.paleViolet,
  ];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if ((row + column) % 3 !== 0) continue;
      const cell = {
        left: Math.round(
          bounds.left +
            ((bounds.right - bounds.left) * column) / columns,
        ) + 2,
        top: Math.round(
          bounds.top +
            ((bounds.bottom - bounds.top) * row) / rows,
        ) + 2,
        right: Math.round(
          bounds.left +
            ((bounds.right - bounds.left) * (column + 1)) /
              columns,
        ) - 2,
        bottom: Math.round(
          bounds.top +
            ((bounds.bottom - bounds.top) * (row + 1)) /
              rows,
        ) - 2,
      };
      fillRect(
        pixels,
        width,
        height,
        cell,
        fills[(row * 2 + column) % fills.length],
      );
    }
  }
  drawRect(pixels, width, height, bounds, COLORS.ink, 2);
  for (let column = 1; column < columns; column += 1) {
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
      COLORS.border,
    );
  }
  for (let row = 1; row < rows; row += 1) {
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
      COLORS.border,
    );
  }
}

function drawColoredProcessDiagram(
  pixels,
  width,
  height,
  bounds,
) {
  fillRect(pixels, width, height, bounds, [244, 247, 250]);
  const centers = [
    [0.15, 0.2],
    [0.48, 0.16],
    [0.78, 0.38],
    [0.62, 0.76],
    [0.24, 0.72],
  ].map(([x, y]) => [
    Math.round(bounds.left + (bounds.right - bounds.left) * x),
    Math.round(bounds.top + (bounds.bottom - bounds.top) * y),
  ]);
  for (let index = 1; index < centers.length; index += 1) {
    drawLine(
      pixels,
      width,
      height,
      centers[index - 1][0],
      centers[index - 1][1],
      centers[index][0],
      centers[index][1],
      [82, 102, 127],
      3,
    );
  }
  const fills = [
    COLORS.paleBlue,
    COLORS.paleGreen,
    COLORS.paleOrange,
    COLORS.paleViolet,
    [225, 237, 242],
  ];
  const nodeWidth = Math.max(
    34,
    Math.round((bounds.right - bounds.left) * 0.18),
  );
  const nodeHeight = Math.max(
    22,
    Math.round((bounds.bottom - bounds.top) * 0.12),
  );
  centers.forEach(([centerX, centerY], index) => {
    const node = {
      left: centerX - Math.round(nodeWidth / 2),
      top: centerY - Math.round(nodeHeight / 2),
      right: centerX + Math.round(nodeWidth / 2),
      bottom: centerY + Math.round(nodeHeight / 2),
    };
    fillRect(pixels, width, height, node, fills[index]);
    drawRect(pixels, width, height, node, COLORS.border, 2);
  });
}

function drawRectangleCard(pixels, width, height, bounds) {
  fillRect(pixels, width, height, bounds, COLORS.paleBlue);
  drawRect(pixels, width, height, bounds, COLORS.blue, 3);
  const inner = {
    left: bounds.left + 25,
    top: bounds.top + 28,
    right: bounds.right - 25,
    bottom: bounds.bottom - 28,
  };
  fillRect(pixels, width, height, inner, COLORS.white);
  drawRect(pixels, width, height, inner, COLORS.green, 2);
  drawPseudoText(
    pixels,
    width,
    height,
    inner.left + 15,
    inner.top + 20,
    inner.right - inner.left - 30,
    Math.max(2, Math.floor((inner.bottom - inner.top - 20) / 20)),
  );
}

function drawDistractor(pixels, width, height, distractor) {
  if (distractor.type === "text-card") {
    drawTextCard(pixels, width, height, distractor.bounds);
  } else if (distractor.type === "table") {
    drawColoredTable(pixels, width, height, distractor.bounds);
  } else if (distractor.type === "process-diagram") {
    drawColoredProcessDiagram(
      pixels,
      width,
      height,
      distractor.bounds,
    );
  } else {
    drawRectangleCard(pixels, width, height, distractor.bounds);
  }
}

function rgbaFromRgb(rgb) {
  const rgba = new Uint8Array((rgb.length / 3) * 4);
  for (let index = 0; index < rgb.length / 3; index += 1) {
    rgba[index * 4] = rgb[index * 3];
    rgba[index * 4 + 1] = rgb[index * 3 + 1];
    rgba[index * 4 + 2] = rgb[index * 3 + 2];
    rgba[index * 4 + 3] = 255;
  }
  return rgba;
}

function normalizeDefinition(definition) {
  return {
    ...definition,
    charts: definition.charts.map(
      (
        [left, top, width, height, explicitSourcePanelIndex],
        index,
      ) => ({
        index,
        sourcePanelIndex:
          explicitSourcePanelIndex ??
          SOURCE_ORDER[index % SOURCE_ORDER.length],
        width,
        height,
        bounds: {
          left,
          top,
          right: left + width - 1,
          bottom: top + height - 1,
        },
      }),
    ),
    distractors: definition.distractors.map(
      ([type, left, top, right, bottom]) => ({
        type,
        bounds: { left, top, right, bottom },
      }),
    ),
    labelChartIndexes: [
      ...(definition.labelChartIndexes ?? []),
    ],
  };
}

function validateSource(source) {
  const sourcePixels = source.pixels ?? source.data;
  if (
    source.width !== 1672 ||
    source.height !== 941 ||
    source.channels < 3 ||
    sourcePixels.length <
      source.width * source.height * source.channels
  ) {
    throw new Error("Expected the 1672 × 941 QLC source slide.");
  }
  return sourcePixels;
}

function buildFixture(source, rawDefinition) {
  const sourcePixels = validateSource(source);
  const definition = normalizeDefinition(rawDefinition);
  const rgb = createCanvas(definition.width, definition.height);
  definition.charts.forEach((chart) => {
    copyBilinearCrop(
      rgb,
      definition.width,
      definition.height,
      sourcePixels,
      source.width,
      source.channels,
      SOURCE_PANELS[chart.sourcePanelIndex],
      chart.bounds,
    );
  });
  definition.labelChartIndexes.forEach((chartIndex) =>
    drawChartLabels(
      rgb,
      definition.width,
      definition.height,
      definition.charts[chartIndex],
    ),
  );
  definition.distractors.forEach((distractor) =>
    drawDistractor(
      rgb,
      definition.width,
      definition.height,
      distractor,
    ),
  );

  const encoded = jpeg.encode(
    {
      data: rgbaFromRgb(rgb),
      width: definition.width,
      height: definition.height,
    },
    definition.quality,
  ).data;
  const decoded = jpeg.decode(encoded, {
    useTArray: true,
    formatAsRGBA: true,
  });

  return {
    name: definition.name,
    width: decoded.width,
    height: decoded.height,
    channels: 4,
    pixels: decoded.data,
    bytes: encoded,
    mimeType: "image/jpeg",
    jpegQuality: definition.quality,
    resampling: "bilinear",
    charts: definition.charts,
    distractors: definition.distractors,
    labelChartIndexes: definition.labelChartIndexes,
    expectedChartCount: definition.charts.length,
  };
}

export function realisticCaptureWaveformFixture(source, chartCount) {
  const definition = CASES[chartCount];
  if (!definition) {
    throw new Error(
      "Supported realistic chart counts are 1, 3, 7, and 11.",
    );
  }
  return buildFixture(source, definition);
}

export function realisticFourKSmallWaveformFixture(source) {
  return buildFixture(source, FOUR_K_CASE);
}

export function realisticStandaloneQlcFixture(
  source,
  {
    sourcePanelIndex,
    width,
    height,
    quality = 82,
  },
) {
  if (
    !Number.isInteger(sourcePanelIndex) ||
    sourcePanelIndex < 0 ||
    sourcePanelIndex >= SOURCE_PANELS.length
  ) {
    throw new Error("A valid QLC sourcePanelIndex is required.");
  }
  const canvasWidth = Math.max(320, width + 100);
  const canvasHeight = Math.max(220, height + 100);
  return buildFixture(source, {
    name: `realistic-standalone-${sourcePanelIndex}-${width}x${height}`,
    width: canvasWidth,
    height: canvasHeight,
    quality,
    charts: [
      [50, 50, width, height, sourcePanelIndex],
    ],
    distractors: [],
    labelChartIndexes: [],
  });
}
