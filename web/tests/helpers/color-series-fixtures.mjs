import { encode as encodePng } from "fast-png";

export const COLOR_SERIES_PALETTE = Object.freeze([
  [219, 48, 62],
  [35, 104, 224],
  [20, 157, 91],
  [177, 57, 190],
]);

const SERIES_SHAPES = Object.freeze([
  {
    centers: [0.1, 0.34, 0.59, 0.85],
    widths: [0.055, 0.063, 0.052, 0.06],
    amplitudes: [0.92, 0.98, 0.88, 1],
    baseline: 0.02,
  },
  {
    centers: [0.13, 0.38, 0.63, 0.88],
    widths: [0.073, 0.047, 0.07, 0.046],
    amplitudes: [0.86, 1, 0.91, 0.82],
    baseline: 0.07,
  },
  {
    centers: [0.08, 0.3, 0.55, 0.8],
    widths: [0.045, 0.078, 0.048, 0.077],
    amplitudes: [1, 0.83, 0.96, 0.87],
    baseline: 0.12,
  },
  {
    centers: [0.15, 0.42, 0.68, 0.91],
    widths: [0.064, 0.052, 0.083, 0.052],
    amplitudes: [0.8, 0.94, 1, 0.9],
    baseline: 0.16,
  },
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
  dashPeriod = 0,
) {
  const steps = Math.max(
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
    1,
  );
  const radius = Math.max(0, Math.floor((thickness - 1) / 2));
  for (let step = 0; step <= steps; step += 1) {
    if (dashPeriod && step % dashPeriod >= dashPeriod / 2) {
      continue;
    }
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
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

function drawPseudoText(
  pixels,
  width,
  height,
  left,
  top,
  glyphCount,
  color = [45, 48, 54],
) {
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const x = left + glyph * 9;
    drawLine(
      pixels,
      width,
      height,
      x,
      top,
      x + 5,
      top,
      color,
    );
    drawLine(
      pixels,
      width,
      height,
      x,
      top,
      x,
      top + 8,
      color,
    );
    if (glyph % 3 !== 1) {
      drawLine(
        pixels,
        width,
        height,
        x,
        top + 4,
        x + 4,
        top + 4,
        color,
      );
    }
    if (glyph % 2 === 0) {
      drawLine(
        pixels,
        width,
        height,
        x,
        top + 8,
        x + 5,
        top + 8,
        color,
      );
    }
  }
}

function seriesResponse(progress, seriesIndex) {
  const shape = SERIES_SHAPES[seriesIndex];
  let response = 0;
  for (let index = 0; index < shape.centers.length; index += 1) {
    const distance =
      (progress - shape.centers[index]) / shape.widths[index];
    response = Math.max(
      response,
      shape.amplitudes[index] *
        Math.exp(-0.5 * distance * distance),
    );
  }
  return response;
}

function seriesY(
  progress,
  seriesIndex,
  bounds,
  crossingMode,
) {
  const shape = SERIES_SHAPES[seriesIndex];
  const plotHeight = bounds.bottom - bounds.top;
  const response = seriesResponse(progress, seriesIndex);
  let normalizedY =
    0.88 -
    response * 0.7 +
    shape.baseline * (0.35 + progress * 0.65);

  if (crossingMode === "near") {
    normalizedY +=
      (seriesIndex - 1.5) *
      0.026 *
      Math.sin(progress * Math.PI * 6 + seriesIndex * 0.8);
  } else if (crossingMode === "overlap") {
    const overlapWeight = Math.max(
      0,
      1 - Math.abs(progress - 0.51) / 0.13,
    );
    const sharedResponse =
      (seriesResponse(progress, 0) +
        seriesResponse(progress, 1)) /
      2;
    const sharedY = 0.88 - sharedResponse * 0.7;
    normalizedY =
      normalizedY * (1 - overlapWeight) +
      sharedY * overlapWeight;
  }

  return Math.round(
    bounds.top +
      14 +
      normalizedY * Math.max(1, plotHeight - 28),
  );
}

function addChartDecorations(
  pixels,
  width,
  height,
  bounds,
  colors,
  options,
) {
  const frameColor = [37, 41, 47];
  const gridColor = [207, 212, 220];
  drawLine(
    pixels,
    width,
    height,
    bounds.left,
    bounds.top,
    bounds.right,
    bounds.top,
    frameColor,
    2,
  );
  drawLine(
    pixels,
    width,
    height,
    bounds.left,
    bounds.bottom,
    bounds.right,
    bounds.bottom,
    frameColor,
    2,
  );
  drawLine(
    pixels,
    width,
    height,
    bounds.left,
    bounds.top,
    bounds.left,
    bounds.bottom,
    frameColor,
    2,
  );
  drawLine(
    pixels,
    width,
    height,
    bounds.right,
    bounds.top,
    bounds.right,
    bounds.bottom,
    frameColor,
    2,
  );

  if (options.grid !== false) {
    for (const ratio of [0.2, 0.4, 0.6, 0.8]) {
      const x = Math.round(
        bounds.left + (bounds.right - bounds.left) * ratio,
      );
      drawLine(
        pixels,
        width,
        height,
        x,
        bounds.top + 1,
        x,
        bounds.bottom - 1,
        gridColor,
        1,
      );
    }
    for (const ratio of [0.17, 0.34, 0.51, 0.68, 0.85]) {
      const y = Math.round(
        bounds.top + (bounds.bottom - bounds.top) * ratio,
      );
      drawLine(
        pixels,
        width,
        height,
        bounds.left + 1,
        y,
        bounds.right - 1,
        y,
        gridColor,
        1,
      );
    }
  }

  if (options.labels !== false) {
    drawPseudoText(pixels, width, height, 76, 22, 22);
    for (let tick = 0; tick < 6; tick += 1) {
      drawPseudoText(
        pixels,
        width,
        height,
        12,
        bounds.top + tick * 52,
        4,
      );
    }
    colors.forEach((color, index) => {
      const top = 26 + index * 13;
      drawLine(
        pixels,
        width,
        height,
        width - 150,
        top,
        width - 130,
        top,
        color,
        3,
      );
      drawPseudoText(
        pixels,
        width,
        height,
        width - 122,
        top - 4,
        7,
      );
    });
  }
}

/**
 * Synthetic log-scale VTH plot containing one to four full-width chromatic
 * distributions. Axes, pale grids, tick labels and a colored legend are
 * included so fixtures exercise the same clutter found in PPT exports.
 */
export function colorSeriesChartFixture(options = {}) {
  const width = options.width ?? 720;
  const height = options.height ?? 440;
  const seriesCount = Math.max(
    1,
    Math.min(4, Math.round(options.seriesCount ?? 3)),
  );
  const bounds = {
    left: 70,
    top: 54,
    right: width - 40,
    bottom: height - 62,
  };
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const colors = (
    Array.isArray(options.colors)
      ? options.colors
      : COLOR_SERIES_PALETTE
  ).slice(0, seriesCount);
  if (colors.length !== seriesCount) {
    throw new Error("seriesCount와 동일한 수의 색상이 필요합니다.");
  }

  addChartDecorations(
    pixels,
    width,
    height,
    bounds,
    colors,
    options,
  );

  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex += 1) {
    let previous = null;
    for (let x = bounds.left + 5; x <= bounds.right - 5; x += 1) {
      const progress =
        (x - bounds.left - 5) /
        Math.max(1, bounds.right - bounds.left - 10);
      const y = seriesY(
        progress,
        seriesIndex,
        bounds,
        options.crossingMode ?? "near",
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
          colors[seriesIndex],
          options.lineThickness ?? 3,
        );
      }
      previous = { x, y };
    }
  }

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
    bounds,
    seriesCount,
    colors,
  };
}

export function monochromeSeriesChartFixture(options = {}) {
  const fixture = colorSeriesChartFixture({
    ...options,
    seriesCount: 1,
    crossingMode: "none",
  });
  return {
    ...fixture,
    seriesCount: 1,
  };
}

export function chromaticAndNeutralSeriesFixture(options = {}) {
  return colorSeriesChartFixture({
    ...options,
    seriesCount: 3,
    crossingMode: options.crossingMode ?? "near",
    colors: [
      COLOR_SERIES_PALETTE[0],
      COLOR_SERIES_PALETTE[1],
      [24, 27, 31],
    ],
  });
}

export function chromaticAndNeutralPairFixture(options = {}) {
  return colorSeriesChartFixture({
    ...options,
    seriesCount: 2,
    crossingMode: options.crossingMode ?? "near",
    colors: [
      COLOR_SERIES_PALETTE[0],
      [24, 27, 31],
    ],
  });
}

export function segmentedChromaticAndNeutralSeriesFixture(
  options = {},
) {
  const width = options.width ?? 600;
  const height = options.height ?? 360;
  const bounds = {
    left: 70,
    top: 94,
    right: width - 40,
    bottom: height - 62,
  };
  const pixels = new Uint8Array(width * height * 3).fill(255);
  addChartDecorations(
    pixels,
    width,
    height,
    bounds,
    [...COLOR_SERIES_PALETTE, [24, 27, 31]],
    options,
  );

  let previousColored = null;
  let previousNeutral = null;
  for (let x = bounds.left + 5; x <= bounds.right - 5; x += 1) {
    const progress =
      (x - bounds.left - 5) /
      Math.max(1, bounds.right - bounds.left - 10);
    const coloredY = seriesY(
      progress,
      0,
      bounds,
      "near",
    );
    const neutralY = seriesY(
      progress,
      1,
      bounds,
      "near",
    );
    const segmentIndex = Math.min(
      COLOR_SERIES_PALETTE.length - 1,
      Math.floor(progress * COLOR_SERIES_PALETTE.length),
    );
    if (previousColored) {
      drawLine(
        pixels,
        width,
        height,
        previousColored.x,
        previousColored.y,
        x,
        coloredY,
        COLOR_SERIES_PALETTE[segmentIndex],
        3,
      );
    }
    if (previousNeutral) {
      drawLine(
        pixels,
        width,
        height,
        previousNeutral.x,
        previousNeutral.y,
        x,
        neutralY,
        [24, 27, 31],
        3,
      );
    }
    previousColored = { x, y: coloredY };
    previousNeutral = { x, y: neutralY };
  }

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
    bounds,
    seriesCount: 2,
  };
}

export function rotateRgbFixture(fixture, degrees) {
  const pixels = new Uint8Array(
    fixture.width * fixture.height * 3,
  ).fill(255);
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = (fixture.width - 1) / 2;
  const centerY = (fixture.height - 1) / 2;

  for (let y = 0; y < fixture.height; y += 1) {
    for (let x = 0; x < fixture.width; x += 1) {
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
        sourceX >= fixture.width ||
        sourceY < 0 ||
        sourceY >= fixture.height
      ) {
        continue;
      }
      const sourceOffset =
        (sourceY * fixture.width + sourceX) * 3;
      const targetOffset = (y * fixture.width + x) * 3;
      pixels[targetOffset] = fixture.pixels[sourceOffset];
      pixels[targetOffset + 1] =
        fixture.pixels[sourceOffset + 1];
      pixels[targetOffset + 2] =
        fixture.pixels[sourceOffset + 2];
    }
  }
  return {
    ...fixture,
    pixels,
    bytes: encodePng({
      width: fixture.width,
      height: fixture.height,
      data: pixels,
      channels: 3,
      depth: 8,
    }),
    rotationDegrees: degrees,
  };
}

export function rotatedChromaticAndNeutralSeriesFixture(
  degrees,
  options = {},
) {
  return rotateRgbFixture(
    chromaticAndNeutralSeriesFixture(options),
    degrees,
  );
}

function blitRgb(
  target,
  targetWidth,
  targetHeight,
  source,
  sourceWidth,
  sourceHeight,
  offsetX,
  offsetY,
) {
  for (let y = 0; y < sourceHeight; y += 1) {
    const targetY = offsetY + y;
    if (targetY < 0 || targetY >= targetHeight) continue;
    for (let x = 0; x < sourceWidth; x += 1) {
      const targetX = offsetX + x;
      if (targetX < 0 || targetX >= targetWidth) continue;
      const sourceOffset = (y * sourceWidth + x) * 3;
      const targetOffset = (targetY * targetWidth + targetX) * 3;
      target[targetOffset] = source[sourceOffset];
      target[targetOffset + 1] = source[sourceOffset + 1];
      target[targetOffset + 2] = source[sourceOffset + 2];
    }
  }
}

/**
 * Two physical coordinate systems on one slide: the first holds two color
 * distributions and the second holds one monochrome distribution.
 */
export function mixedPanelColorSeriesFixture(options = {}) {
  const chartWidth = options.chartWidth ?? 520;
  const chartHeight = options.chartHeight ?? 330;
  const gutter = options.gutter ?? 24;
  const margin = 12;
  const verticalOffset = options.verticalOffset ?? 72;
  const width = chartWidth * 2 + gutter + margin * 2;
  const height = chartHeight + verticalOffset + margin * 2;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const multiSeries = colorSeriesChartFixture({
    width: chartWidth,
    height: chartHeight,
    seriesCount: 2,
    crossingMode: "near",
  });
  const singleSeries = monochromeSeriesChartFixture({
    width: chartWidth,
    height: chartHeight,
  });
  const secondX = margin + chartWidth + gutter;
  const secondY = margin + verticalOffset;
  blitRgb(
    pixels,
    width,
    height,
    multiSeries.pixels,
    chartWidth,
    chartHeight,
    margin,
    margin,
  );
  blitRgb(
    pixels,
    width,
    height,
    singleSeries.pixels,
    chartWidth,
    chartHeight,
    secondX,
    secondY,
  );
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
    expectedPanelSeriesCounts: [2, 1],
  };
}

/**
 * A strongly chromatic spreadsheet-like object. Every hue spans most of the
 * image through repeated cell fills and swatches, intentionally challenging
 * hue-only series logic. The shared table lattice must reject it before any
 * color group is promoted to searchable/training data.
 */
export function coloredCellTableFixture(options = {}) {
  const width = options.width ?? 720;
  const height = options.height ?? 440;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const bounds = {
    left: 38,
    top: 34,
    right: width - 38,
    bottom: height - 34,
  };
  const columns = options.columns ?? 6;
  const rows = options.rows ?? 6;
  const lineColor = [37, 41, 47];
  const fills = [
    [242, 188, 194],
    [177, 207, 247],
    [163, 223, 192],
    [222, 185, 229],
  ];

  for (let row = 0; row < rows; row += 1) {
    const top = Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * row) / rows,
    );
    const bottom = Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * (row + 1)) / rows,
    );
    for (let column = 0; column < columns; column += 1) {
      const left = Math.round(
        bounds.left +
          ((bounds.right - bounds.left) * column) / columns,
      );
      const right = Math.round(
        bounds.left +
          ((bounds.right - bounds.left) * (column + 1)) / columns,
      );
      const fill = fills[(row + column) % fills.length];
      fillRect(
        pixels,
        width,
        height,
        left + 3,
        top + 3,
        right - 3,
        bottom - 3,
        fill,
      );
      drawLine(
        pixels,
        width,
        height,
        left + 12,
        Math.round((top + bottom) / 2),
        right - 12,
        Math.round((top + bottom) / 2),
        COLOR_SERIES_PALETTE[(row + column) % 4],
        3,
      );
      drawPseudoText(
        pixels,
        width,
        height,
        left + 14,
        top + 12,
        Math.max(2, Math.floor((right - left - 24) / 9)),
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
      lineColor,
      2,
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
      lineColor,
      2,
    );
  }

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
    bounds,
  };
}
