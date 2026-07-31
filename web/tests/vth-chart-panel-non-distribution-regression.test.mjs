import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decode as decodePng,
  encode as encodePng,
} from "fast-png";
import jpeg from "jpeg-js";

import {
  detectChartPanels,
  detectChartPanelsFromMask,
  measureChartCurveEvidence,
} from "../lib/vth-chart-panel-core.mjs";
import { rotateBinaryMask } from "../lib/vth-image-core.mjs";
import {
  analyzeSimilarityImage,
  SimilarityApiError,
  searchSimilarityImage,
  validateTrainingWaveformImage,
} from "../lib/vth-similarity-api-core.mjs";
import { coloredFloatingSineTableFixture } from "./helpers/color-series-fixtures.mjs";
import {
  shadedNumericTablePng,
  sparklineTablePng,
} from "./helpers/table-fixtures.mjs";

const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

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

function drawFrame(mask, width, bounds, thickness = 2) {
  drawLine(
    mask,
    width,
    bounds.left,
    bounds.top,
    bounds.right,
    bounds.top,
    thickness,
  );
  drawLine(
    mask,
    width,
    bounds.left,
    bounds.bottom,
    bounds.right,
    bounds.bottom,
    thickness,
  );
  drawLine(
    mask,
    width,
    bounds.left,
    bounds.top,
    bounds.left,
    bounds.bottom,
    thickness,
  );
  drawLine(
    mask,
    width,
    bounds.right,
    bounds.top,
    bounds.right,
    bounds.bottom,
    thickness,
  );
}

function drawDistribution(mask, width, bounds, peakCenters) {
  const insetX = Math.max(8, Math.round((bounds.right - bounds.left) * 0.04));
  const insetY = Math.max(8, Math.round((bounds.bottom - bounds.top) * 0.08));
  const left = bounds.left + insetX;
  const right = bounds.right - insetX;
  const top = bounds.top + insetY;
  const bottom = bounds.bottom - insetY;
  const usableHeight = bottom - top;
  let previous;

  for (let x = left; x <= right; x += 1) {
    const progress = (x - left) / Math.max(1, right - left);
    let response = 0;
    for (const center of peakCenters) {
      const distance = (progress - center) / 0.095;
      response = Math.max(
        response,
        Math.exp(-0.5 * distance * distance),
      );
    }
    const y = Math.round(bottom - response * usableHeight * 0.82);
    if (previous) {
      drawLine(mask, width, previous.x, previous.y, x, y, 2);
    }
    previous = { x, y };
  }
}

function drawChart(mask, width, bounds, peakCenters) {
  drawFrame(mask, width, bounds);
  drawDistribution(mask, width, bounds, peakCenters);
}

function drawTextLine(mask, width, left, top, glyphCount) {
  for (let index = 0; index < glyphCount; index += 1) {
    const x = left + index * 11;
    const variant = index % 4;
    drawLine(mask, width, x, top, x, top + 11, 1);
    drawLine(mask, width, x, top, x + 6, top, 1);
    if (variant === 0 || variant === 2) {
      drawLine(mask, width, x, top + 5, x + 5, top + 5, 1);
    }
    if (variant !== 1) {
      drawLine(mask, width, x, top + 11, x + 6, top + 11, 1);
    }
    if (variant === 3) {
      drawLine(mask, width, x + 6, top, x + 6, top + 11, 1);
    }
  }
}

function drawExplanationCard(mask, width, bounds) {
  drawFrame(mask, width, bounds);
  const availableGlyphs = Math.max(
    5,
    Math.floor((bounds.right - bounds.left - 36) / 11),
  );
  for (let row = 0; row < 9; row += 1) {
    drawTextLine(
      mask,
      width,
      bounds.left + 18,
      bounds.top + 24 + row * 24,
      Math.max(5, availableGlyphs - (row % 3) * 4),
    );
  }
}

function drawTable(mask, width, bounds, columns = 7, rows = 9) {
  drawFrame(mask, width, bounds);
  for (let column = 1; column < columns; column += 1) {
    const x = Math.round(
      bounds.left +
        ((bounds.right - bounds.left) * column) / columns,
    );
    drawLine(mask, width, x, bounds.top, x, bounds.bottom, 2);
  }
  for (let row = 1; row < rows; row += 1) {
    const y = Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * row) / rows,
    );
    drawLine(mask, width, bounds.left, y, bounds.right, y, 2);
  }
}

function drawSharedGridWaveformTable(
  mask,
  width,
  bounds,
  columns = 5,
  rows = 4,
) {
  for (let column = 0; column <= columns; column += 1) {
    const x = Math.round(
      bounds.left +
        ((bounds.right - bounds.left) * column) / columns,
    );
    drawLine(mask, width, x, bounds.top, x, bounds.bottom, 3);
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * row) / rows,
    );
    drawLine(mask, width, bounds.left, y, bounds.right, y, 3);
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      drawDistribution(
        mask,
        width,
        {
          left: Math.round(
            bounds.left +
              ((bounds.right - bounds.left) * column) /
                columns,
          ),
          top: Math.round(
            bounds.top +
              ((bounds.bottom - bounds.top) * row) / rows,
          ),
          right: Math.round(
            bounds.left +
              ((bounds.right - bounds.left) *
                (column + 1)) /
                columns,
          ),
          bottom: Math.round(
            bounds.top +
              ((bounds.bottom - bounds.top) * (row + 1)) /
                rows,
          ),
        },
        [0.5],
      );
    }
  }
}

function drawCompactSparklineTable(mask, width, bounds) {
  drawTable(mask, width, bounds, 2, 2);
  let previous;
  for (let x = bounds.left + 7; x <= bounds.right - 7; x += 1) {
    const progress =
      (x - bounds.left - 7) /
      Math.max(1, bounds.right - bounds.left - 14);
    const response = Math.max(
      Math.exp(-0.5 * ((progress - 0.28) / 0.07) ** 2),
      0.8 *
        Math.exp(
          -0.5 * ((progress - 0.72) / 0.09) ** 2,
        ),
    );
    const y = Math.round(
      bounds.top + 62 - response * 30,
    );
    if (previous) {
      drawLine(mask, width, previous.x, previous.y, x, y, 2);
    }
    previous = { x, y };
  }
}

function drawIrregularTextTable(
  mask,
  width,
  bounds,
  {
    columns,
    rows,
    borderless = false,
    merged = false,
    partial = false,
  },
) {
  const rowY = Array.from({ length: rows + 1 }, (_, index) =>
    Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * index) / rows,
    ),
  );
  const columnX = Array.from(
    { length: columns + 1 },
    (_, index) =>
      Math.round(
        bounds.left +
          ((bounds.right - bounds.left) * index) / columns,
      ),
  );
  if (!borderless) drawFrame(mask, width, bounds);
  for (let row = 1; row < rows; row += 1) {
    const right =
      partial && row % 3 === 1
        ? columnX[Math.max(2, columns - 2)]
        : bounds.right;
    drawLine(mask, width, bounds.left, rowY[row], right, rowY[row], 2);
  }
  for (let column = 1; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      if (
        (merged && (row === 0 || (row + column) % 4 === 0)) ||
        (partial && column % 2 === 0 && row > rows / 2)
      ) {
        continue;
      }
      drawLine(
        mask,
        width,
        columnX[column],
        rowY[row],
        columnX[column],
        rowY[row + 1],
        2,
      );
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if ((row * 3 + column) % 5 === 0) continue;
      const availableWidth =
        columnX[column + 1] - columnX[column] - 18;
      drawTextLine(
        mask,
        width,
        columnX[column] + 8,
        rowY[row] + 7,
        Math.max(1, Math.min(5, Math.floor(availableWidth / 9))),
      );
    }
  }
}

function drawEmptyCoordinateSystem(mask, width, bounds) {
  drawFrame(mask, width, bounds);
  for (const ratio of [0.2, 0.4, 0.6, 0.8]) {
    const x = Math.round(
      bounds.left + (bounds.right - bounds.left) * ratio,
    );
    drawLine(mask, width, x, bounds.top, x, bounds.bottom, 1);
  }
  for (const ratio of [0.25, 0.5, 0.75]) {
    const y = Math.round(
      bounds.top + (bounds.bottom - bounds.top) * ratio,
    );
    drawLine(mask, width, bounds.left, y, bounds.right, y, 1);
  }
  for (let index = 0; index < 8; index += 1) {
    const x =
      bounds.left +
      Math.round(((bounds.right - bounds.left) * index) / 7);
    drawLine(mask, width, x, bounds.bottom, x, bounds.bottom + 7, 1);
  }
}

function drawRectangleShapes(mask, width, bounds) {
  drawFrame(mask, width, bounds);
  const inset = {
    left: bounds.left + 35,
    top: bounds.top + 35,
    right: bounds.right - 35,
    bottom: bounds.bottom - 35,
  };
  drawFrame(mask, width, inset, 3);
  const centerY = Math.round((inset.top + inset.bottom) / 2);
  drawLine(mask, width, inset.left, centerY, inset.right, centerY, 2);
  drawLine(
    mask,
    width,
    Math.round((inset.left + inset.right) / 2),
    inset.top,
    Math.round((inset.left + inset.right) / 2),
    inset.bottom,
    2,
  );
}

function drawFlowDiagram(mask, width, bounds) {
  const boxWidth = Math.round((bounds.right - bounds.left) * 0.28);
  const boxHeight = Math.round((bounds.bottom - bounds.top) * 0.22);
  const first = {
    left: bounds.left,
    top: bounds.top,
    right: bounds.left + boxWidth,
    bottom: bounds.top + boxHeight,
  };
  const second = {
    left: bounds.right - boxWidth,
    top: bounds.top + Math.round(boxHeight * 1.25),
    right: bounds.right,
    bottom: bounds.top + Math.round(boxHeight * 2.25),
  };
  const third = {
    left: bounds.left + Math.round(boxWidth * 0.35),
    top: bounds.bottom - boxHeight,
    right: bounds.left + Math.round(boxWidth * 1.35),
    bottom: bounds.bottom,
  };
  for (const [index, box] of [first, second, third].entries()) {
    drawFrame(mask, width, box, 2);
    drawTextLine(
      mask,
      width,
      box.left + 10,
      box.top + Math.round(boxHeight * 0.42),
      5 + index,
    );
  }
  const firstY = Math.round((first.top + first.bottom) / 2);
  const secondY = Math.round((second.top + second.bottom) / 2);
  const thirdX = Math.round((third.left + third.right) / 2);
  drawLine(mask, width, first.right, firstY, second.left, firstY, 2);
  drawLine(mask, width, second.left, firstY, second.left, secondY, 2);
  drawLine(mask, width, second.left, secondY, second.right, secondY, 2);
  drawLine(mask, width, second.left, secondY, thirdX, secondY, 2);
  drawLine(mask, width, thirdX, secondY, thirdX, third.top, 2);
  drawLine(mask, width, thirdX - 7, third.top - 8, thirdX, third.top, 2);
  drawLine(mask, width, thirdX + 7, third.top - 8, thirdX, third.top, 2);
}

function drawEllipse(mask, width, rotation = 0) {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  let previous;
  for (let index = 0; index <= 720; index += 1) {
    const angle = (index * Math.PI) / 360;
    const horizontal = 220 * Math.cos(angle);
    const vertical = 100 * Math.sin(angle);
    const point = {
      x: Math.round(
        320 + horizontal * cosine - vertical * sine,
      ),
      y: Math.round(
        180 + horizontal * sine + vertical * cosine,
      ),
    };
    if (previous) {
      drawLine(
        mask,
        width,
        previous.x,
        previous.y,
        point.x,
        point.y,
        3,
      );
    }
    previous = point;
  }
}

function drawCurvedArrow(mask, width) {
  let previous;
  for (let x = 30; x <= 609; x += 1) {
    const progress = (x - 30) / 580;
    const point = {
      x,
      y: Math.round(270 - 200 * progress ** 0.65),
    };
    if (previous) {
      drawLine(
        mask,
        width,
        previous.x,
        previous.y,
        point.x,
        point.y,
        3,
      );
    }
    previous = point;
  }
  drawLine(mask, width, 609, 70, 580, 75, 3);
  drawLine(mask, width, 609, 70, 595, 98, 3);
}

function drawFramelessTwoPeakDistribution(mask, width) {
  let previous;
  for (let x = 25; x <= 365; x += 1) {
    const progress = (x - 25) / 340;
    const response = Math.max(
      Math.exp(-0.5 * ((progress - 0.25) / 0.04) ** 2),
      Math.exp(-0.5 * ((progress - 0.75) / 0.04) ** 2),
    );
    const point = {
      x,
      y: Math.round(355 - response * 120),
    };
    if (previous) {
      drawLine(
        mask,
        width,
        previous.x,
        previous.y,
        point.x,
        point.y,
        3,
      );
    }
    previous = point;
  }
}

function drawFramelessSinglePeak(
  mask,
  width,
  left,
  right,
  center,
) {
  let previous;
  for (let x = left; x <= right; x += 1) {
    const progress = (x - left) / Math.max(1, right - left);
    const response = Math.exp(
      -0.5 * ((progress - center) / 0.15) ** 2,
    );
    const point = {
      x,
      y: Math.round(360 - 240 * response),
    };
    if (previous) {
      drawLine(
        mask,
        width,
        previous.x,
        previous.y,
        point.x,
        point.y,
        2,
      );
    }
    previous = point;
  }
}

function maskToRgb(mask, foreground = 20) {
  const rgb = new Uint8Array(mask.length * 3).fill(255);
  mask.forEach((value, index) => {
    if (!value) return;
    const offset = index * 3;
    rgb[offset] = foreground;
    rgb[offset + 1] = foreground;
    rgb[offset + 2] = foreground;
  });
  return rgb;
}

function putRgb(
  rgb,
  width,
  height,
  x,
  y,
  color = [20, 20, 20],
) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const offset = (y * width + x) * 3;
  rgb[offset] = color[0];
  rgb[offset + 1] = color[1];
  rgb[offset + 2] = color[2];
}

function drawRgbLine(
  rgb,
  width,
  height,
  x1,
  y1,
  x2,
  y2,
  thickness = 2,
  color = [20, 20, 20],
) {
  const steps = Math.max(
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
    1,
  );
  const radius = Math.floor(thickness / 2);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (
        let offsetX = -radius;
        offsetX <= radius;
        offsetX += 1
      ) {
        putRgb(
          rgb,
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

function fillRgbRectangle(
  rgb,
  width,
  height,
  left,
  top,
  right,
  bottom,
  color,
) {
  for (
    let y = Math.max(0, Math.round(top));
    y <= Math.min(height - 1, Math.round(bottom));
    y += 1
  ) {
    for (
      let x = Math.max(0, Math.round(left));
      x <= Math.min(width - 1, Math.round(right));
      x += 1
    ) {
      putRgb(rgb, width, height, x, y, color);
    }
  }
}

function rowsFiveSparklineTable(columns) {
  const width = 640;
  const height = 360;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const left = 70;
  const right = 570;
  const top = 55;
  const bottom = 305;
  const rows = 5;
  for (let row = 0; row <= rows; row += 1) {
    const y = Math.round(
      top + ((bottom - top) * row) / rows,
    );
    drawRgbLine(rgb, width, height, left, y, right, y);
  }
  for (let column = 0; column <= columns; column += 1) {
    const x = Math.round(
      left + ((right - left) * column) / columns,
    );
    drawRgbLine(rgb, width, height, x, top, x, bottom);
  }
  const centerY = Math.round(
    top + (bottom - top) / rows / 2,
  );
  let previous;
  for (let x = left + 7; x <= right - 7; x += 1) {
    const progress =
      (x - left - 7) / (right - left - 14);
    const response = Math.max(
      Math.exp(-0.5 * ((progress - 0.28) / 0.07) ** 2),
      0.8 *
        Math.exp(
          -0.5 * ((progress - 0.72) / 0.09) ** 2,
        ),
    );
    const y = Math.round(centerY + 15 - response * 30);
    if (previous) {
      drawRgbLine(
        rgb,
        width,
        height,
        previous.x,
        previous.y,
        x,
        y,
        2,
        [0, 95, 190],
      );
    }
    previous = { x, y };
  }
  return { rgb, width, height };
}

function fourByFiveSparklineTable({
  partial = false,
  openOuter = false,
} = {}) {
  const width = 900;
  const height = 540;
  const rows = 4;
  const columns = 5;
  const left = 65;
  const right = 835;
  const top = 55;
  const bottom = 485;
  const cellWidth = (right - left) / columns;
  const cellHeight = (bottom - top) / rows;
  const rgb = new Uint8Array(width * height * 3).fill(255);

  for (let row = 0; row <= rows; row += 1) {
    const y = Math.round(top + row * cellHeight);
    if (partial && row % 2 === 1) {
      drawRgbLine(
        rgb,
        width,
        height,
        left,
        y,
        Math.round(left + 2.2 * cellWidth),
        y,
      );
      drawRgbLine(
        rgb,
        width,
        height,
        Math.round(left + 3.1 * cellWidth),
        y,
        right,
        y,
      );
    } else {
      drawRgbLine(rgb, width, height, left, y, right, y);
    }
  }
  for (let column = 0; column <= columns; column += 1) {
    const x = Math.round(left + column * cellWidth);
    if (partial && column % 2 === 0) {
      drawRgbLine(
        rgb,
        width,
        height,
        x,
        top,
        x,
        Math.round(top + 1.6 * cellHeight),
      );
      drawRgbLine(
        rgb,
        width,
        height,
        x,
        Math.round(top + 2.4 * cellHeight),
        x,
        bottom,
      );
    } else {
      drawRgbLine(rgb, width, height, x, top, x, bottom);
    }
  }
  if (openOuter) {
    fillRgbRectangle(
      rgb,
      width,
      height,
      left - 4,
      top - 4,
      right + 4,
      top + 4,
      [255, 255, 255],
    );
    fillRgbRectangle(
      rgb,
      width,
      height,
      right - 4,
      top - 4,
      right + 4,
      bottom + 4,
      [255, 255, 255],
    );
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const insetLeft = left + column * cellWidth + 10;
      const insetRight =
        left + (column + 1) * cellWidth - 10;
      const baseline =
        top + (row + 1) * cellHeight - 14;
      const center =
        0.35 +
        (((row * columns + column) % 4) * 0.1) / 3;
      let previous;
      for (
        let x = Math.round(insetLeft);
        x <= Math.round(insetRight);
        x += 1
      ) {
        const progress =
          (x - insetLeft) / (insetRight - insetLeft);
        const response = Math.exp(
          -0.5 * ((progress - center) / 0.13) ** 2,
        );
        const y = Math.round(
          baseline - response * cellHeight * 0.62,
        );
        if (previous) {
          drawRgbLine(
            rgb,
            width,
            height,
            previous.x,
            previous.y,
            x,
            y,
            2,
            [20, 100, 185],
          );
        }
        previous = { x, y };
      }
    }
  }
  return { rgb, width, height };
}

function rotateRgbNearest(source, degrees) {
  const output = new Uint8Array(
    source.width * source.height * 3,
  ).fill(255);
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = (source.width - 1) / 2;
  const centerY = (source.height - 1) / 2;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const localX = x - centerX;
      const localY = y - centerY;
      const sourceX = Math.round(
        centerX + localX * cosine + localY * sine,
      );
      const sourceY = Math.round(
        centerY - localX * sine + localY * cosine,
      );
      if (
        sourceX < 0 ||
        sourceX >= source.width ||
        sourceY < 0 ||
        sourceY >= source.height
      ) {
        continue;
      }
      const sourceOffset =
        (sourceY * source.width + sourceX) * 3;
      const targetOffset = (y * source.width + x) * 3;
      output[targetOffset] = source.rgb[sourceOffset];
      output[targetOffset + 1] =
        source.rgb[sourceOffset + 1];
      output[targetOffset + 2] =
        source.rgb[sourceOffset + 2];
    }
  }
  return { ...source, rgb: output };
}

function downsampleRgbNearest(source, width, height) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        source.width - 1,
        Math.floor(((x + 0.5) * source.width) / width),
      );
      const sourceY = Math.min(
        source.height - 1,
        Math.floor(((y + 0.5) * source.height) / height),
      );
      const sourceOffset =
        (sourceY * source.width + sourceX) * 3;
      const targetOffset = (y * width + x) * 3;
      rgb[targetOffset] = source.rgb[sourceOffset];
      rgb[targetOffset + 1] = source.rgb[sourceOffset + 1];
      rgb[targetOffset + 2] = source.rgb[sourceOffset + 2];
    }
  }
  return { rgb, width, height };
}

function resizeRgbBilinear(source, width, height) {
  const rgb = new Uint8Array(width * height * 3);
  const xRatio = source.width / width;
  const yRatio = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) * yRatio - 0.5;
    const top = Math.max(0, Math.floor(sourceY));
    const bottom = Math.min(source.height - 1, top + 1);
    const yWeight = Math.max(0, sourceY - top);
    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) * xRatio - 0.5;
      const left = Math.max(0, Math.floor(sourceX));
      const right = Math.min(source.width - 1, left + 1);
      const xWeight = Math.max(0, sourceX - left);
      const targetOffset = (y * width + x) * 3;
      const topLeftOffset = (top * source.width + left) * 3;
      const topRightOffset = (top * source.width + right) * 3;
      const bottomLeftOffset =
        (bottom * source.width + left) * 3;
      const bottomRightOffset =
        (bottom * source.width + right) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const topValue =
          source.rgb[topLeftOffset + channel] * (1 - xWeight) +
          source.rgb[topRightOffset + channel] * xWeight;
        const bottomValue =
          source.rgb[bottomLeftOffset + channel] * (1 - xWeight) +
          source.rgb[bottomRightOffset + channel] * xWeight;
        rgb[targetOffset + channel] = Math.round(
          topValue * (1 - yWeight) + bottomValue * yWeight,
        );
      }
    }
  }
  return { rgb, width, height };
}

function encodeTableFixture(source, jpegQuality) {
  if (jpegQuality === undefined) {
    return {
      ...source,
      bytes: encodePng({
        width: source.width,
        height: source.height,
        data: source.rgb,
        channels: 3,
      }),
      mimeType: "image/png",
      decodedRgb: source.rgb,
      channels: 3,
    };
  }
  const rgba = new Uint8Array(
    source.width * source.height * 4,
  );
  for (let index = 0; index < source.width * source.height; index += 1) {
    rgba[index * 4] = source.rgb[index * 3];
    rgba[index * 4 + 1] = source.rgb[index * 3 + 1];
    rgba[index * 4 + 2] = source.rgb[index * 3 + 2];
    rgba[index * 4 + 3] = 255;
  }
  const bytes = jpeg.encode(
    {
      data: rgba,
      width: source.width,
      height: source.height,
    },
    jpegQuality,
  ).data;
  const decoded = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: false,
    tolerantDecoding: true,
  });
  return {
    ...source,
    bytes,
    mimeType: "image/jpeg",
    decodedRgb: decoded.data,
    channels: Math.round(
      decoded.data.length / (source.width * source.height),
    ),
  };
}

function darkMaskFromRgb(rgb, channels) {
  const mask = new Uint8Array(
    Math.floor(rgb.length / channels),
  );
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * channels;
    if (
      Math.min(
        rgb[offset],
        rgb[offset + 1],
        rgb[offset + 2],
      ) < 220
    ) {
      mask[index] = 1;
    }
  }
  return mask;
}

function assertPanelMatches(result, expected, tolerance = 12) {
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
    `missing distribution chart centered at ${expectedCenterX},${expectedCenterY}`,
  );
  return match;
}

test("rejects standalone non-distribution slide content", async (context) => {
  const width = 720;
  const height = 420;
  const bounds = { left: 45, top: 38, right: 674, bottom: 376 };
  const cases = [
    ["explanation text block", drawExplanationCard],
    ["table and grid", drawTable],
    ["empty coordinate system", drawEmptyCoordinateSystem],
    ["rectangular shapes", drawRectangleShapes],
    ["flowchart and diagram", drawFlowDiagram],
  ];

  for (const [name, draw] of cases) {
    await context.test(name, () => {
      const mask = new Uint8Array(width * height);
      draw(mask, width, bounds);
      const result = detectChartPanelsFromMask(mask, width, height, {
        fallbackToWholeImage: false,
      });

      assert.equal(result.fallbackUsed, false);
      assert.equal(
        result.detectedPanelCount,
        0,
        `${name} must not be accepted as a distribution chart`,
      );
      assert.equal(result.panels.length, 0);
    });
  }
});

test("keeps only real single-peak and multi-peak distributions on a mixed FHD canvas", () => {
  const width = 1920;
  const height = 1080;
  const mask = new Uint8Array(width * height);
  const singlePeak = {
    left: 42,
    top: 48,
    right: 682,
    bottom: 420,
  };
  const multiplePeaks = {
    left: 1390,
    top: 574,
    right: 1872,
    bottom: 1025,
  };

  drawChart(mask, width, singlePeak, [0.5]);
  drawChart(mask, width, multiplePeaks, [0.16, 0.38, 0.61, 0.83]);
  drawExplanationCard(mask, width, {
    left: 752,
    top: 50,
    right: 1360,
    bottom: 418,
  });
  drawEmptyCoordinateSystem(mask, width, {
    left: 1450,
    top: 52,
    right: 1870,
    bottom: 420,
  });
  drawTable(mask, width, {
    left: 42,
    top: 562,
    right: 690,
    bottom: 1026,
  });
  drawFlowDiagram(mask, width, {
    left: 780,
    top: 570,
    right: 1295,
    bottom: 1015,
  });
  drawRectangleShapes(mask, width, {
    left: 1060,
    top: 700,
    right: 1345,
    bottom: 1005,
  });

  const startedAt = performance.now();
  const result = detectChartPanelsFromMask(mask, width, height, {
    fallbackToWholeImage: false,
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.fallbackUsed, false);
  assert.equal(
    result.detectedPanelCount,
    2,
    "only the two wave-like distributions may become searchable data",
  );
  assert.equal(result.panels.length, 2);

  const singlePanel = assertPanelMatches(result, singlePeak);
  const multiplePanel = assertPanelMatches(result, multiplePeaks);
  const singleEvidence = measureChartCurveEvidence(
    { ...singlePeak, axisMode: singlePanel.axisMode },
    mask,
    width,
  );
  const multipleEvidence = measureChartCurveEvidence(
    { ...multiplePeaks, axisMode: multiplePanel.axisMode },
    mask,
    width,
  );
  assert.equal(singleEvidence.valid, true);
  assert.equal(multipleEvidence.valid, true);
  assert.ok(
    singleEvidence.localizedSinglePeak ||
      singleEvidence.logScaleParabolicPeak,
    "the real single-peak distribution must retain rounded-peak evidence",
  );
  assert.ok(
    multipleEvidence.fullWidthTrace,
    "the multi-peak distribution must retain a coherent wave trace",
  );
  assert.ok(
    result.rejectedNonChartCount >= 4,
    "the mixed slide must record rejected non-chart candidates",
  );
  assert.ok(
    elapsedMs < 2500,
    `mixed FHD rejection took ${elapsedMs.toFixed(1)} ms`,
  );
});

test("separates two frameless single-peak distributions across a two-pixel gutter", () => {
  const width = 800;
  const height = 400;
  const mask = new Uint8Array(width * height);
  drawFramelessSinglePeak(mask, width, 20, 397, 0.45);
  drawFramelessSinglePeak(mask, width, 400, 777, 0.55);

  for (let y = 0; y < height; y += 1) {
    mask[y * width + 398] = 0;
    mask[y * width + 399] = 0;
    assert.equal(mask[y * width + 398], 0);
    assert.equal(mask[y * width + 399], 0);
  }

  for (const result of [
    detectChartPanelsFromMask(mask, width, height),
    detectChartPanels(maskToRgb(mask), width, height, 3),
  ]) {
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.detectedPanelCount, 2);
    assert.equal(result.panels.length, 2);
    assert.ok(result.panels[0].right <= 397);
    assert.ok(result.panels[1].left >= 400);
    assert.ok(
      result.panels.every(
        (panel) =>
          panel.detectionReason === "frameless-curve-region",
      ),
    );
  }
});

test("crops one frameless distribution away from an adjacent table", async () => {
  const width = 760;
  const height = 420;
  const mask = new Uint8Array(width * height);
  drawFramelessTwoPeakDistribution(mask, width);
  drawTable(
    mask,
    width,
    { left: 430, top: 48, right: 720, bottom: 228 },
    5,
    5,
  );

  const rgb = maskToRgb(mask);
  const detected = detectChartPanels(rgb, width, height, 3);
  assert.equal(
    detected.panels.length,
    1,
    "the valid distribution must survive beside a non-chart table",
  );
  assert.equal(detected.fallbackUsed, false);
  assert.equal(
    detected.panels[0].detectionReason,
    "frameless-curve-region",
  );
  assert.ok(detected.panels[0].left <= 30);
  assert.ok(
    detected.panels[0].right < 400,
    "the table must not leak into the detector crop",
  );
  assert.ok(detected.rejectedNonChartCount >= 1);

  const png = encodePng({
    width,
    height,
    data: rgb,
    channels: 3,
  });
  const response = await searchSimilarityImage({
    bytes: png,
    mimeType: "image/png",
    topK: 1,
    corpus: publicCorpus,
    origin: "https://dove9999.com",
  });
  assert.equal(response.panelCount, 1);
  assert.equal(response.panelDetection.fallbackUsed, false);
  assert.equal(
    response.panels[0].detectionReason,
    "frameless-curve-region",
  );
  const sourceBounds = response.panels[0].bounds.source;
  assert.ok(sourceBounds.x <= 30);
  assert.ok(
    sourceBounds.x + sourceBounds.width < 410,
    "the API must analyze only the waveform crop, not the whole document",
  );
  assert.equal(response.results.length, 1);
});

test("does not hide a detached compact table inside a waveform fallback", () => {
  const width = 760;
  const height = 420;
  const mask = new Uint8Array(width * height);
  drawFramelessTwoPeakDistribution(mask, width);
  drawTable(
    mask,
    width,
    { left: 430, top: 48, right: 510, bottom: 108 },
    3,
    3,
  );

  const detected = detectChartPanels(
    maskToRgb(mask),
    width,
    height,
    3,
  );
  assert.equal(
    detected.panels.length,
    1,
    "the waveform should survive when a compact table is detached",
  );
  assert.equal(
    detected.fallbackUsed,
    false,
    "mixed document content must never be promoted to a whole-image waveform fallback",
  );
  assert.equal(
    detected.panels[0].detectionReason,
    "frameless-curve-region",
  );
  assert.ok(detected.panels[0].left <= 30);
  assert.ok(
    detected.panels[0].right < 400,
    "the compact table must stay outside the waveform crop",
  );
  assert.ok(detected.rejectedNonChartCount >= 1);
});

test("rejects shared-grid waveforms, merged cells, partial grids, and text tables", async (context) => {
  const cases = [
    {
      name: "shared 4 by 5 table with Gaussian cell icons",
      width: 900,
      height: 540,
      draw(mask, width) {
        drawSharedGridWaveformTable(mask, width, {
          left: 30,
          top: 20,
          right: 870,
          bottom: 520,
        });
      },
    },
    {
      name: "merged-cell text table",
      width: 720,
      height: 420,
      draw(mask, width) {
        drawIrregularTextTable(
          mask,
          width,
          { left: 55, top: 42, right: 665, bottom: 378 },
          { columns: 8, rows: 12, merged: true },
        );
      },
    },
    {
      name: "partial-grid text table",
      width: 720,
      height: 420,
      draw(mask, width) {
        drawIrregularTextTable(
          mask,
          width,
          { left: 55, top: 42, right: 665, bottom: 378 },
          { columns: 8, rows: 12, partial: true },
        );
      },
    },
    {
      name: "borderless text table",
      width: 720,
      height: 420,
      draw(mask, width) {
        drawIrregularTextTable(
          mask,
          width,
          { left: 55, top: 42, right: 665, bottom: 378 },
          { columns: 5, rows: 12, merged: true, borderless: true },
        );
      },
    },
    {
      name: "compact 2 by 2 table with a two-peak sparkline",
      width: 640,
      height: 360,
      draw(mask, width) {
        drawCompactSparklineTable(mask, width, {
          left: 70,
          top: 55,
          right: 570,
          bottom: 305,
        });
      },
    },
    ...[4, 15].map((angle) => ({
      name: `text table rotated ${angle} degrees`,
      width: 720,
      height: 420,
      draw(mask, width) {
        const unrotated = new Uint8Array(mask.length);
        drawIrregularTextTable(
          unrotated,
          width,
          { left: 55, top: 42, right: 665, bottom: 378 },
          { columns: 6, rows: 8, merged: true },
        );
        mask.set(
          rotateBinaryMask(
            unrotated,
            width,
            Math.floor(mask.length / width),
            angle,
          ),
        );
      },
    })),
  ];

  for (const fixture of cases) {
    await context.test(fixture.name, () => {
      const mask = new Uint8Array(
        fixture.width * fixture.height,
      );
      fixture.draw(mask, fixture.width);
      for (const result of [
        detectChartPanelsFromMask(
          mask,
          fixture.width,
          fixture.height,
        ),
        detectChartPanels(
          maskToRgb(mask),
          fixture.width,
          fixture.height,
          3,
        ),
      ]) {
        assert.equal(result.fallbackUsed, false);
        assert.equal(
          result.panels.length,
          0,
          `${fixture.name} must never become searchable distribution data`,
        );
      }
    });
  }
});

test("rejects colored sparkline tables across grid sizes, broken borders, JPEG, and rotation", async (context) => {
  const baseTable = fourByFiveSparklineTable();
  const numericTable = decodePng(shadedNumericTablePng());
  const fixtures = [
    ...Array.from({ length: 6 }, (_, index) => {
      const columns = index + 2;
      return {
        name: `five rows by ${columns} columns`,
        input: encodeTableFixture(
          rowsFiveSparklineTable(columns),
        ),
      };
    }),
    {
      name: "partial grid with open outer borders",
      input: encodeTableFixture(
        fourByFiveSparklineTable({
          partial: true,
          openOuter: true,
        }),
      ),
    },
    {
      name: "300 by 180 JPEG quality 20",
      input: encodeTableFixture(
        downsampleRgbNearest(baseTable, 300, 180),
        20,
      ),
    },
    {
      name: "shaded numeric table rotated 3 degrees",
      input: encodeTableFixture(
        rotateRgbNearest(
          {
            width: numericTable.width,
            height: numericTable.height,
            rgb: numericTable.data,
          },
          3,
        ),
      ),
    },
    ...[2, 15].map((angle) => ({
      name: `${angle}-degree rotation`,
      input: encodeTableFixture(
        rotateRgbNearest(baseTable, angle),
      ),
    })),
  ];

  for (const fixture of fixtures) {
    await context.test(fixture.name, async () => {
      const { input } = fixture;
      const mask = darkMaskFromRgb(
        input.decodedRgb,
        input.channels,
      );
      for (const result of [
        detectChartPanelsFromMask(
          mask,
          input.width,
          input.height,
        ),
        detectChartPanels(
          input.decodedRgb,
          input.width,
          input.height,
          input.channels,
        ),
      ]) {
        assert.equal(result.panels.length, 0);
        assert.equal(result.fallbackUsed, false);
      }

      await assert.rejects(
        () =>
          searchSimilarityImage({
            bytes: input.bytes,
            mimeType: input.mimeType,
            topK: 1,
            corpus: publicCorpus,
            origin: "https://dove9999.com",
          }),
        (error) => {
          assert.ok(error instanceof SimilarityApiError);
          assert.equal(error.status, 422);
          assert.equal(
            error.code,
            "distribution_waveform_not_found",
          );
          return true;
        },
      );

      await assert.rejects(
        async () => {
          const analysis = await analyzeSimilarityImage(
            input.bytes,
            input.mimeType,
          );
          return validateTrainingWaveformImage({
            bytes: input.bytes,
            mimeType: input.mimeType,
            profile: analysis.profile,
            stateCount: analysis.descriptor.stateCount,
          });
        },
        (error) => {
          assert.ok(error instanceof SimilarityApiError);
          assert.equal(error.status, 422);
          assert.equal(
            error.code,
            "distribution_waveform_not_found",
          );
          return true;
        },
      );
    });
  }
});

test("rejects bilinear low-resolution sparkline and floating KPI tables", async (context) => {
  const decodedSparkline = decodePng(sparklineTablePng());
  const floatingKpi = coloredFloatingSineTableFixture();
  const sources = [
    {
      name: "sparkline-table",
      width: decodedSparkline.width,
      height: decodedSparkline.height,
      rgb: decodedSparkline.data,
    },
    {
      name: "colored-floating-sine-table",
      width: floatingKpi.width,
      height: floatingKpi.height,
      rgb: floatingKpi.pixels,
    },
  ];

  for (const source of sources) {
    for (const [width, height] of [
      [480, 270],
      [240, 135],
    ]) {
      await context.test(
        `${source.name}-${width}x${height}-bilinear`,
        async () => {
          const input = encodeTableFixture(
            resizeRgbBilinear(source, width, height),
          );
          assert.equal(input.width, width);
          assert.equal(input.height, height);
          assert.equal(input.mimeType, "image/png");

          await assert.rejects(
            () =>
              searchSimilarityImage({
                bytes: input.bytes,
                mimeType: input.mimeType,
                topK: 1,
                corpus: publicCorpus,
                origin: "https://dove9999.com",
              }),
            (error) => {
              assert.ok(error instanceof SimilarityApiError);
              assert.equal(error.status, 422);
              assert.equal(
                error.code,
                "distribution_waveform_not_found",
              );
              return true;
            },
          );
        },
      );
    }
  }
});

test("keeps a real multi-State VTH Curve after a 15-degree rotation", () => {
  const width = 720;
  const height = 420;
  const unrotated = new Uint8Array(width * height);
  drawChart(
    unrotated,
    width,
    { left: 55, top: 42, right: 665, bottom: 378 },
    [0.12, 0.28, 0.44, 0.6, 0.76, 0.9],
  );
  const rotated = rotateBinaryMask(
    unrotated,
    width,
    height,
    15,
  );

  for (const result of [
    detectChartPanelsFromMask(rotated, width, height),
    detectChartPanels(maskToRgb(rotated), width, height, 3),
  ]) {
    assert.equal(result.panels.length, 1);
  }
});

test("rejects ellipse and curved-arrow explanation artwork at mask, RGB, and API boundaries", async (context) => {
  const width = 640;
  const height = 360;
  const cases = [
    ["ellipse", drawEllipse],
    [
      "rotated ellipse",
      (mask, localWidth) =>
        drawEllipse(mask, localWidth, Math.PI / 4),
    ],
    ["curved arrow with arrowhead", drawCurvedArrow],
  ];

  for (const [name, draw] of cases) {
    await context.test(name, async () => {
      const mask = new Uint8Array(width * height);
      draw(mask, width);

      const maskResult = detectChartPanelsFromMask(
        mask,
        width,
        height,
      );
      assert.equal(
        maskResult.panels.length,
        0,
        `${name} must not enter the mask-level distribution path`,
      );
      assert.equal(maskResult.fallbackUsed, false);

      const rgb = maskToRgb(mask);
      const rgbResult = detectChartPanels(rgb, width, height, 3);
      assert.equal(
        rgbResult.panels.length,
        0,
        `${name} must not enter the RGB distribution path`,
      );
      assert.equal(rgbResult.fallbackUsed, false);

      const png = encodePng({
        width,
        height,
        data: rgb,
        channels: 3,
      });
      await assert.rejects(
        () =>
          searchSimilarityImage({
            bytes: png,
            mimeType: "image/png",
            topK: 1,
            corpus: publicCorpus,
            origin: "https://dove9999.com",
          }),
        (error) => {
          assert.ok(error instanceof SimilarityApiError);
          assert.equal(error.status, 422);
          assert.equal(
            error.code,
            "distribution_waveform_not_found",
          );
          return true;
        },
        `${name} must be rejected at the public API boundary`,
      );
    });
  }
});

test("accepts all 196 public corpus PNGs as distributions through the detector", async () => {
  assert.equal(publicCorpus.candidateCount, 196);
  assert.equal(publicCorpus.candidates.length, 196);
  const startedAt = performance.now();
  const invalidDetections = [];

  for (const candidate of publicCorpus.candidates) {
    const bytes = await readFile(
      new URL(`../public${candidate.image}`, import.meta.url),
    );
    const decoded = decodePng(bytes);
    const result = detectChartPanels(
      decoded.data,
      decoded.width,
      decoded.height,
      decoded.channels,
    );
    if (result.panels.length !== 1) {
      invalidDetections.push({
        id: candidate.id,
        width: decoded.width,
        height: decoded.height,
        panelCount: result.panels.length,
        rejectedNonChartCount: result.rejectedNonChartCount,
      });
    }
  }

  assert.deepEqual(
    invalidDetections,
    [],
    "each known single-chart corpus distribution must be accepted exactly once",
  );
  const elapsedMs = performance.now() - startedAt;
  // Shared GitHub runners can briefly run at roughly half local throughput
  // while the full pixel-regression suite is active. Keep the strict local
  // guard, but leave enough CI headroom to distinguish load jitter from an
  // actual combinatorial detector regression.
  const detectorBudgetMs = process.env.CI ? 90_000 : 30_000;
  assert.ok(
    elapsedMs < detectorBudgetMs,
    `196-image detector acceptance took ${elapsedMs.toFixed(1)} ms (budget ${detectorBudgetMs} ms)`,
  );
});

test("accepts representative corpus sources and State counts through the similarity API", async () => {
  const representatives = new Map();
  for (const candidate of publicCorpus.candidates) {
    const source =
      candidate.sourceCollection ??
      "generated_base";
    const key = `${source}:${candidate.stateCount}`;
    if (!representatives.has(key)) {
      representatives.set(key, candidate);
    }
  }
  assert.equal(
    representatives.size,
    6,
    "the API audit must cover 2/4/8/16-State base images and 4/8-State fault images",
  );

  for (const [group, candidate] of representatives) {
    const bytes = await readFile(
      new URL(`../public${candidate.image}`, import.meta.url),
    );
    let response;
    try {
      response = await searchSimilarityImage({
        bytes,
        mimeType: "image/png",
        topK: 1,
        corpus: publicCorpus,
        origin: "https://dove9999.com",
      });
    } catch (error) {
      assert.fail(
        `${group} representative ${candidate.id} was rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    assert.ok(response.panelCount >= 1);
    assert.ok(response.panels.length >= 1);
    assert.equal(response.results.length, 1);
  }
});
