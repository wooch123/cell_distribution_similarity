import { encode as encodePng } from "fast-png";

function drawLine(
  rgb,
  width,
  height,
  x1,
  y1,
  x2,
  y2,
  thickness = 2,
) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let offsetY = 0; offsetY < thickness; offsetY += 1) {
      for (let offsetX = 0; offsetX < thickness; offsetX += 1) {
        const localX = x + offsetX;
        const localY = y + offsetY;
        if (
          localX < 0 ||
          localX >= width ||
          localY < 0 ||
          localY >= height
        ) {
          continue;
        }
        const offset = (localY * width + localX) * 3;
        rgb[offset] = 18;
        rgb[offset + 1] = 18;
        rgb[offset + 2] = 18;
      }
    }
  }
}

/**
 * A data-table false positive: the shared 2 × 2 cell borders are the primary
 * structure and the first row contains one compact sparkline. The sparkline
 * is intentionally wave-like, but it must not turn the surrounding table into
 * a searchable or trainable VTH distribution.
 */
export function sparklineTablePng() {
  const width = 640;
  const height = 360;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const left = 70;
  const right = 570;
  const top = 55;
  const bottom = 305;
  const rows = 2;
  const columns = 2;

  for (let row = 0; row <= rows; row += 1) {
    const y = Math.round(
      top + ((bottom - top) * row) / rows,
    );
    drawLine(rgb, width, height, left, y, right, y);
  }
  for (let column = 0; column <= columns; column += 1) {
    const x = Math.round(
      left + ((right - left) * column) / columns,
    );
    drawLine(rgb, width, height, x, top, x, bottom);
  }

  let previous = null;
  for (let x = left + 7; x <= right - 7; x += 1) {
    const progress =
      (x - left - 7) / Math.max(1, right - left - 14);
    const response = Math.max(
      Math.exp(-0.5 * ((progress - 0.28) / 0.07) ** 2),
      0.8 *
        Math.exp(-0.5 * ((progress - 0.72) / 0.09) ** 2),
    );
    const y = Math.round(top + 62 - response * 30);
    if (previous) {
      drawLine(
        rgb,
        width,
        height,
        previous.x,
        previous.y,
        x,
        y,
      );
    }
    previous = { x, y };
  }

  return encodePng({
    width,
    height,
    data: rgb,
    channels: 3,
    depth: 8,
  });
}

function fillRectangle(
  rgb,
  width,
  left,
  top,
  right,
  bottom,
  color,
) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * width + x) * 3;
      rgb[offset] = color[0];
      rgb[offset + 1] = color[1];
      rgb[offset + 2] = color[2];
    }
  }
}

function drawNumericGlyph(
  rgb,
  width,
  height,
  left,
  top,
  variant,
) {
  const glyphWidth = 6 + (variant % 3);
  const glyphHeight = 10 + (variant % 4);
  drawLine(
    rgb,
    width,
    height,
    left,
    top,
    left + glyphWidth,
    top,
    1,
  );
  drawLine(
    rgb,
    width,
    height,
    left,
    top,
    left,
    top + glyphHeight,
    1,
  );
  if (variant % 2 === 0) {
    drawLine(
      rgb,
      width,
      height,
      left,
      top + Math.round(glyphHeight / 2),
      left + glyphWidth,
      top + Math.round(glyphHeight / 2),
      1,
    );
  }
  if (variant % 3 !== 1) {
    drawLine(
      rgb,
      width,
      height,
      left,
      top + glyphHeight,
      left + glyphWidth,
      top + glyphHeight,
      1,
    );
  }
  if (variant % 4 === 3) {
    drawLine(
      rgb,
      width,
      height,
      left + glyphWidth,
      top,
      left + glyphWidth,
      top + glyphHeight,
      1,
    );
  }
}

/**
 * A spreadsheet-style false positive without any waveform. Alternating cell
 * fills, uneven borders, and variable numeric glyph counts previously formed
 * a synthetic whole-image Curve after salience filtering.
 */
export function shadedNumericTablePng() {
  const width = 800;
  const height = 450;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const left = 100;
  const right = 700;
  const top = 70;
  const bottom = 370;
  const rows = 6;
  const columns = 7;
  const rowY = Array.from({ length: rows + 1 }, (_, row) =>
    Math.round(top + ((bottom - top) * row) / rows),
  );
  const columnX = Array.from(
    { length: columns + 1 },
    (_, column) =>
      Math.round(left + ((right - left) * column) / columns),
  );

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if ((row + column) % 3 !== 0) continue;
      fillRectangle(
        rgb,
        width,
        columnX[column] + 2,
        rowY[row] + 2,
        columnX[column + 1] - 2,
        rowY[row + 1] - 2,
        (row + column) % 2
          ? [224, 229, 236]
          : [210, 226, 246],
      );
    }
  }

  for (let row = 0; row <= rows; row += 1) {
    drawLine(
      rgb,
      width,
      height,
      left,
      rowY[row],
      right,
      rowY[row],
      2 + (row % 3),
    );
  }
  for (let column = 0; column <= columns; column += 1) {
    drawLine(
      rgb,
      width,
      height,
      columnX[column],
      top,
      columnX[column],
      bottom,
      2 + ((column + 1) % 3),
    );
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const glyphCount = 2 + ((row * 3 + column * 5) % 5);
      for (let glyph = 0; glyph < glyphCount; glyph += 1) {
        drawNumericGlyph(
          rgb,
          width,
          height,
          columnX[column] + 8 + glyph * 11,
          rowY[row] + 10 + ((row + column) % 3),
          row * 17 + column * 11 + glyph,
        );
      }
    }
  }

  return encodePng({
    width,
    height,
    data: rgb,
    channels: 3,
    depth: 8,
  });
}
