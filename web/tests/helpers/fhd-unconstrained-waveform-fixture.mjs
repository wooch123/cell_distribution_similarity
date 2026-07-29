import { encode as encodePng } from "fast-png";

const WIDTH = 1920;
const HEIGHT = 1080;

const COLORS = Object.freeze({
  paper: [248, 249, 251],
  white: [255, 255, 255],
  ink: [29, 36, 47],
  muted: [92, 103, 119],
  border: [139, 151, 166],
  grid: [221, 227, 234],
  paleBlue: [228, 237, 248],
  paleGrey: [242, 244, 247],
  red: [201, 54, 62],
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

const CHART_PLACEMENTS = Object.freeze([
  [0, 0, 240, 160],
  [300, 23, 190, 140],
  [530, 9, 120, 90],
  [685, 87, 95, 70],
  [812, 6, 67, 49],
  [883, 20, 48, 35],
  [1010, 16, 315, 205],
  [1404, 45, 155, 112],
  [1838, 1, 82, 60],

  [38, 288, 260, 178],
  [335, 251, 110, 78],
  [454, 340, 52, 38],
  [570, 264, 205, 148],
  [801, 357, 72, 52],
  [920, 279, 175, 125],
  [1110, 373, 50, 36],
  [1240, 246, 285, 190],
  [1668, 314, 130, 96],
  [1830, 255, 90, 66],

  [3, 910, 240, 168],
  [290, 925, 190, 140],
  [540, 984, 120, 96],
  [700, 900, 95, 70],
  [825, 1029, 67, 49],
  [896, 1043, 48, 35],
  [1020, 858, 315, 205],
  [1420, 930, 155, 112],
  [1838, 1020, 82, 60],
]);

const SOURCE_ORDER = Object.freeze([
  11, 2, 17, 6, 19, 4, 13, 0, 8, 15,
  5, 18, 1, 10, 7, 14, 3, 16, 9, 12,
  7, 1, 18, 5, 15, 2, 12, 8,
]);

const DISTRACTORS = Object.freeze([
  {
    type: "explanation-text-card",
    bounds: { left: 20, top: 515, right: 450, bottom: 735 },
  },
  {
    type: "dense-numeric-table",
    bounds: { left: 485, top: 495, right: 1005, bottom: 780 },
  },
  {
    type: "process-diagram",
    bounds: { left: 1050, top: 520, right: 1335, bottom: 750 },
  },
  {
    type: "monotonic-line-chart",
    bounds: { left: 1390, top: 500, right: 1900, bottom: 790 },
  },
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

function blankCanvas() {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    const offset = index * 3;
    pixels[offset] = COLORS.paper[0];
    pixels[offset + 1] = COLORS.paper[1];
    pixels[offset + 2] = COLORS.paper[2];
  }
  return pixels;
}

function fillRect(pixels, bounds, color) {
  for (
    let y = Math.max(0, bounds.top);
    y <= Math.min(HEIGHT - 1, bounds.bottom);
    y += 1
  ) {
    for (
      let x = Math.max(0, bounds.left);
      x <= Math.min(WIDTH - 1, bounds.right);
      x += 1
    ) {
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
  availableWidth,
  rows,
) {
  for (let row = 0; row < rows; row += 1) {
    const y = top + row * 18;
    const rowWidth = Math.round(
      availableWidth * (0.7 + (row % 3) * 0.12),
    );
    for (let cursor = left; cursor < left + rowWidth; cursor += 13) {
      const glyphWidth = 6 + ((cursor + row) % 4);
      drawLine(
        pixels,
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
          cursor,
          y,
          cursor,
          y + 9,
          COLORS.muted,
        );
      }
    }
  }
}

function pixelSalience(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  const darkness = 255 - (red + green + blue) / 3;
  return darkness + (chroma >= 22 ? 300 + chroma : 0);
}

function copyScaledSalientCrop(
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

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const sourceTop = Math.max(
      sourceBounds.top,
      Math.floor(
        sourceBounds.top +
          (targetY * sourceCropHeight) / targetHeight,
      ),
    );
    const sourceBottom = Math.min(
      sourceBounds.bottom,
      Math.max(
        sourceTop,
        Math.ceil(
          sourceBounds.top +
            ((targetY + 1) * sourceCropHeight) / targetHeight,
        ) - 1,
      ),
    );
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const sourceLeft = Math.max(
        sourceBounds.left,
        Math.floor(
          sourceBounds.left +
            (targetX * sourceCropWidth) / targetWidth,
        ),
      );
      const sourceRight = Math.min(
        sourceBounds.right,
        Math.max(
          sourceLeft,
          Math.ceil(
            sourceBounds.left +
              ((targetX + 1) * sourceCropWidth) / targetWidth,
          ) - 1,
        ),
      );
      let selected = [255, 255, 255];
      let selectedSalience = Number.NEGATIVE_INFINITY;
      for (let sourceY = sourceTop; sourceY <= sourceBottom; sourceY += 1) {
        for (
          let sourceX = sourceLeft;
          sourceX <= sourceRight;
          sourceX += 1
        ) {
          if (
            sourceX < 0 ||
            sourceX >= sourceWidth ||
            sourceY < 0 ||
            sourceY >= sourceHeight
          ) {
            continue;
          }
          const offset =
            (sourceY * sourceWidth + sourceX) * sourceChannels;
          const color = [
            sourcePixels[offset],
            sourcePixels[offset + 1],
            sourcePixels[offset + 2],
          ];
          const salience = pixelSalience(...color);
          if (salience > selectedSalience) {
            selected = color;
            selectedSalience = salience;
          }
        }
      }
      setPixel(
        targetPixels,
        targetBounds.left + targetX,
        targetBounds.top + targetY,
        selected,
      );
    }
  }
}

function drawTextCard(pixels, bounds) {
  fillRect(pixels, bounds, COLORS.paleGrey);
  drawRect(pixels, bounds, COLORS.border, 2);
  drawPseudoText(
    pixels,
    bounds.left + 20,
    bounds.top + 24,
    bounds.right - bounds.left - 42,
    10,
  );
}

function drawTable(pixels, bounds) {
  fillRect(pixels, bounds, COLORS.white);
  drawRect(pixels, bounds, COLORS.ink, 2);
  const columns = 7;
  const rows = 8;
  for (let column = 1; column < columns; column += 1) {
    const x = Math.round(
      bounds.left +
        ((bounds.right - bounds.left) * column) / columns,
    );
    drawLine(
      pixels,
      x,
      bounds.top,
      x,
      bounds.bottom,
      COLORS.border,
      column % 3 === 0 ? 2 : 1,
    );
  }
  for (let row = 1; row < rows; row += 1) {
    const y = Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * row) / rows,
    );
    drawLine(
      pixels,
      bounds.left,
      y,
      bounds.right,
      y,
      COLORS.border,
      row % 3 === 0 ? 2 : 1,
    );
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const cellLeft = Math.round(
        bounds.left +
          ((bounds.right - bounds.left) * column) / columns,
      );
      const cellTop = Math.round(
        bounds.top +
          ((bounds.bottom - bounds.top) * row) / rows,
      );
      drawPseudoText(pixels, cellLeft + 7, cellTop + 9, 42, 1);
    }
  }
}

function drawDiagram(pixels, bounds) {
  fillRect(pixels, bounds, COLORS.paleGrey);
  const nodes = [
    [bounds.left + 50, bounds.top + 45],
    [bounds.left + 140, bounds.top + 42],
    [bounds.left + 225, bounds.top + 96],
    [bounds.left + 146, bounds.top + 170],
    [bounds.left + 52, bounds.top + 154],
  ];
  for (let index = 1; index < nodes.length; index += 1) {
    drawLine(
      pixels,
      nodes[index - 1][0],
      nodes[index - 1][1],
      nodes[index][0],
      nodes[index][1],
      COLORS.muted,
      3,
    );
  }
  for (const [centerX, centerY] of nodes) {
    const node = {
      left: centerX - 30,
      top: centerY - 17,
      right: centerX + 30,
      bottom: centerY + 17,
    };
    fillRect(pixels, node, COLORS.paleBlue);
    drawRect(pixels, node, COLORS.border, 2);
  }
}

function drawMonotonicChart(pixels, bounds) {
  fillRect(pixels, bounds, COLORS.white);
  drawRect(pixels, bounds, COLORS.ink, 2);
  for (const ratio of [0.2, 0.4, 0.6, 0.8]) {
    const y = Math.round(
      bounds.top + (bounds.bottom - bounds.top) * ratio,
    );
    drawLine(
      pixels,
      bounds.left + 1,
      y,
      bounds.right - 1,
      y,
      COLORS.grid,
    );
  }
  let previous;
  for (let x = bounds.left + 20; x <= bounds.right - 20; x += 1) {
    const progress =
      (x - bounds.left - 20) /
      Math.max(1, bounds.right - bounds.left - 40);
    const y = Math.round(
      bounds.bottom -
        22 -
        progress * (bounds.bottom - bounds.top - 48) +
        Math.sin(progress * Math.PI) * 5,
    );
    if (previous) {
      drawLine(
        pixels,
        previous.x,
        previous.y,
        x,
        y,
        COLORS.red,
        3,
      );
    }
    previous = { x, y };
  }
}

/**
 * Builds a deterministic FHD slide from the twenty real Read_Disturb plot
 * crops. The plot count stays below the product limit of thirty while exact
 * sizes span 48 × 35 through 315 × 205 pixels.
 */
export function fhdUnconstrainedWaveformFixture(source) {
  const sourcePixels = source.pixels ?? source.data;
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const sourceChannels = source.channels;
  if (
    sourceWidth !== 1672 ||
    sourceHeight !== 941 ||
    sourceChannels < 3 ||
    sourcePixels.length <
      sourceWidth * sourceHeight * sourceChannels
  ) {
    throw new Error("Expected the 1672 × 941 QLC source slide.");
  }

  const pixels = blankCanvas();
  const charts = CHART_PLACEMENTS.map(
    ([left, top, width, height], index) => ({
      index,
      sourcePanelIndex: SOURCE_ORDER[index],
      bounds: {
        left,
        top,
        right: left + width - 1,
        bottom: top + height - 1,
      },
      width,
      height,
    }),
  );
  for (const chart of charts) {
    copyScaledSalientCrop(
      pixels,
      sourcePixels,
      sourceWidth,
      sourceHeight,
      sourceChannels,
      SOURCE_PANELS[chart.sourcePanelIndex],
      chart.bounds,
    );
  }

  drawTextCard(pixels, DISTRACTORS[0].bounds);
  drawTable(pixels, DISTRACTORS[1].bounds);
  drawDiagram(pixels, DISTRACTORS[2].bounds);
  drawMonotonicChart(pixels, DISTRACTORS[3].bounds);

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
