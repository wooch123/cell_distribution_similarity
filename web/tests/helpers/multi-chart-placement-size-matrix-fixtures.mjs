const WHITE = [255, 255, 255];
const FRAME = [28, 32, 38];
const GRID = [220, 224, 230];
const CURVES = Object.freeze([
  [18, 105, 212],
  [213, 52, 45],
  [31, 145, 72],
  [136, 76, 194],
]);

function setPixel(pixels, width, height, x, y, color) {
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
) {
  const steps = Math.max(
    1,
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
  );
  const radius = Math.max(0, Math.floor((thickness - 1) / 2));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let localY = -radius; localY <= radius; localY += 1) {
      for (let localX = -radius; localX <= radius; localX += 1) {
        setPixel(
          pixels,
          width,
          height,
          x + localX,
          y + localY,
          color,
        );
      }
    }
  }
}

function chartSource(plotWidth, plotHeight, peakCount, seed) {
  const margin = 3;
  const width = plotWidth + margin * 2;
  const height = plotHeight + margin * 2;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const left = margin;
  const top = margin;
  const right = left + plotWidth - 1;
  const bottom = top + plotHeight - 1;
  const thickness = Math.max(
    1,
    Math.min(
      3,
      Math.round(Math.min(plotWidth, plotHeight) / 70),
    ),
  );

  for (const [x1, y1, x2, y2] of [
    [left, top, right, top],
    [left, bottom, right, bottom],
    [left, top, left, bottom],
    [right, top, right, bottom],
  ]) {
    drawLine(
      pixels,
      width,
      height,
      x1,
      y1,
      x2,
      y2,
      FRAME,
      thickness,
    );
  }
  for (const ratio of [0.25, 0.5, 0.75]) {
    const x = Math.round(left + ratio * (right - left));
    drawLine(
      pixels,
      width,
      height,
      x,
      top + 1,
      x,
      bottom - 1,
      GRID,
    );
  }
  for (const ratio of [1 / 3, 2 / 3]) {
    const y = Math.round(top + ratio * (bottom - top));
    drawLine(
      pixels,
      width,
      height,
      left + 1,
      y,
      right - 1,
      y,
      GRID,
    );
  }

  const curveLeft =
    left + Math.max(2, Math.round(plotWidth * 0.035));
  const curveRight =
    right - Math.max(2, Math.round(plotWidth * 0.035));
  const curveBottom =
    bottom - Math.max(2, Math.round(plotHeight * 0.07));
  const amplitude = Math.max(5, plotHeight * 0.58);
  const centers = Array.from(
    { length: peakCount },
    (_unused, index) =>
      peakCount === 1
        ? 0.5
        : 0.08 + (0.84 * index) / (peakCount - 1),
  );
  const sigma =
    peakCount === 1
      ? 0.18
      : Math.max(0.035, 0.22 / Math.max(2, peakCount));
  let previous = null;
  for (let x = curveLeft; x <= curveRight; x += 1) {
    const progress =
      (x - curveLeft) / Math.max(1, curveRight - curveLeft);
    let response = 0;
    for (const center of centers) {
      response = Math.max(
        response,
        Math.exp(
          -0.5 * ((progress - center) / sigma) ** 2,
        ),
      );
    }
    const y = Math.round(
      curveBottom -
        response *
          amplitude *
          (1 -
            0.05 *
              Math.sin(
                progress * Math.PI * (2 + (seed % 4)),
              )),
    );
    if (previous) {
      const colorIndex = Math.min(
        peakCount - 1,
        Math.floor(progress * peakCount),
      );
      drawLine(
        pixels,
        width,
        height,
        previous.x,
        previous.y,
        x,
        y,
        CURVES[(colorIndex + seed) % CURVES.length],
        thickness,
      );
    }
    previous = { x, y };
  }
  return { pixels, width, height };
}

function rotatePatch(source, degrees) {
  if (!degrees) return source;
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const width =
    Math.ceil(
      Math.abs(source.width * cosine) +
        Math.abs(source.height * sine),
    ) + 4;
  const height =
    Math.ceil(
      Math.abs(source.width * sine) +
        Math.abs(source.height * cosine),
    ) + 4;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const sourceCenterX = (source.width - 1) / 2;
  const sourceCenterY = (source.height - 1) / 2;
  const targetCenterX = (width - 1) / 2;
  const targetCenterY = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const localX = x - targetCenterX;
      const localY = y - targetCenterY;
      const sourceX = Math.round(
        sourceCenterX + localX * cosine + localY * sine,
      );
      const sourceY = Math.round(
        sourceCenterY - localX * sine + localY * cosine,
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
      const targetOffset = (y * width + x) * 3;
      pixels[targetOffset] = source.pixels[sourceOffset];
      pixels[targetOffset + 1] =
        source.pixels[sourceOffset + 1];
      pixels[targetOffset + 2] =
        source.pixels[sourceOffset + 2];
    }
  }
  return { pixels, width, height };
}

function cropInk(source) {
  let left = source.width;
  let top = source.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 3;
      if (
        source.pixels[offset] >= 248 &&
        source.pixels[offset + 1] >= 248 &&
        source.pixels[offset + 2] >= 248
      ) {
        continue;
      }
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  const width = right - left + 1;
  const height = bottom - top + 1;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceOffset =
        ((top + y) * source.width + left + x) * 3;
      const targetOffset = (y * width + x) * 3;
      pixels[targetOffset] = source.pixels[sourceOffset];
      pixels[targetOffset + 1] =
        source.pixels[sourceOffset + 1];
      pixels[targetOffset + 2] =
        source.pixels[sourceOffset + 2];
    }
  }
  return { pixels, width, height };
}

function blitInk(canvas, patch, left, top) {
  for (let y = 0; y < patch.height; y += 1) {
    for (let x = 0; x < patch.width; x += 1) {
      const sourceOffset = (y * patch.width + x) * 3;
      if (
        patch.pixels[sourceOffset] >= 248 &&
        patch.pixels[sourceOffset + 1] >= 248 &&
        patch.pixels[sourceOffset + 2] >= 248
      ) {
        continue;
      }
      const targetX = left + x;
      const targetY = top + y;
      if (
        targetX < 0 ||
        targetX >= canvas.width ||
        targetY < 0 ||
        targetY >= canvas.height
      ) {
        continue;
      }
      const targetOffset =
        (targetY * canvas.width + targetX) * 3;
      canvas.pixels[targetOffset] =
        patch.pixels[sourceOffset];
      canvas.pixels[targetOffset + 1] =
        patch.pixels[sourceOffset + 1];
      canvas.pixels[targetOffset + 2] =
        patch.pixels[sourceOffset + 2];
    }
  }
}

export function createMultiChartPlacementSizeFixture(
  definition,
) {
  const {
    width,
    height,
    count,
    rows,
    columns,
    angles = [0],
    varied = true,
    jitter = true,
    edgeAnchored = false,
    gap = Math.max(
      6,
      Math.round(Math.min(width, height) * 0.012),
    ),
  } = definition;
  const canvas = {
    width,
    height,
    channels: 3,
    pixels: new Uint8Array(width * height * 3).fill(
      WHITE[0],
    ),
  };
  const charts = [];
  const margin = edgeAnchored
    ? 0
    : Math.max(
        2,
        Math.round(Math.min(width, height) * 0.014),
      );
  const cellWidth =
    (width - margin * 2 - (columns - 1) * gap) / columns;
  const cellHeight =
    (height - margin * 2 - (rows - 1) * gap) / rows;
  const scales =
    definition.scales ??
    (varied
      ? [0.56, 0.74, 0.91, 0.65, 0.83, 0.69, 0.88]
      : angles.some((angle) => angle !== 0)
        ? [0.72]
        : [0.9]);

  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const scale = scales[index % scales.length];
    const plotWidth = Math.max(
      24,
      Math.floor(cellWidth * scale),
    );
    const plotHeight = Math.max(
      18,
      Math.floor(
        cellHeight *
          scales[(index * 3 + 2) % scales.length],
      ),
    );
    const angle = angles[index % angles.length];
    const peakCount =
      index % 6 === 0 ? 1 : 3 + (index % 4);
    const patch = cropInk(
      rotatePatch(
        chartSource(
          plotWidth,
          plotHeight,
          peakCount,
          index,
        ),
        angle,
      ),
    );
    const jitterX = jitter
      ? (((index * 37) % 101) / 100 - 0.5) *
        Math.min(cellWidth * 0.36, gap + cellWidth * 0.09)
      : 0;
    const jitterY = jitter
      ? (((index * 61) % 97) / 96 - 0.5) *
        Math.min(cellHeight * 0.36, gap + cellHeight * 0.09)
      : 0;
    let left = Math.round(
      margin +
        column * (cellWidth + gap) +
        (cellWidth - patch.width) / 2 +
        jitterX,
    );
    let top = Math.round(
      margin +
        row * (cellHeight + gap) +
        (cellHeight - patch.height) / 2 +
        jitterY,
    );
    if (edgeAnchored) {
      if (column === 0) left = 0;
      if (column === columns - 1) {
        left = width - patch.width;
      }
      if (row === 0) top = 0;
      if (row === rows - 1) {
        top = height - patch.height;
      }
    }
    left = Math.max(0, Math.min(width - patch.width, left));
    top = Math.max(0, Math.min(height - patch.height, top));
    blitInk(canvas, patch, left, top);
    charts.push({
      index,
      angle,
      peakCount,
      expectedValleyCount: Math.max(0, peakCount - 1),
      bounds: {
        left,
        top,
        right: left + patch.width - 1,
        bottom: top + patch.height - 1,
      },
    });
  }
  return {
    ...canvas,
    name: definition.name,
    charts,
    expectedChartCount: charts.length,
    definition,
  };
}

export const MULTI_CHART_PLACEMENT_SIZE_CASES =
  Object.freeze([
    {
      name: "wqvga-two-opposite-edges",
      width: 400,
      height: 225,
      count: 2,
      rows: 1,
      columns: 2,
      edgeAnchored: true,
    },
    {
      name: "svga-four-variable-edge-anchored",
      width: 800,
      height: 450,
      count: 4,
      rows: 2,
      columns: 2,
      edgeAnchored: true,
      gap: 8,
    },
    {
      name: "xga-six-scattered-heterogeneous",
      width: 1024,
      height: 768,
      count: 6,
      rows: 2,
      columns: 3,
      gap: 18,
    },
    {
      name: "hd-eight-scattered-heterogeneous",
      width: 1280,
      height: 720,
      count: 8,
      rows: 2,
      columns: 4,
      gap: 12,
    },
    {
      name: "hd-twelve-small-gap-variable",
      width: 1280,
      height: 720,
      count: 12,
      rows: 3,
      columns: 4,
      gap: 3,
      scales: [1],
      jitter: false,
    },
    {
      name: "hd-twelve-mixed-three-degree",
      width: 1280,
      height: 720,
      count: 12,
      rows: 3,
      columns: 4,
      angles: [-3, 0, 3],
      gap: 12,
    },
    {
      name: "wxga-twenty-scattered-variable",
      width: 1600,
      height: 900,
      count: 20,
      rows: 4,
      columns: 5,
      gap: 9,
    },
    {
      name: "fhd-thirty-dense-variable",
      width: 1920,
      height: 1080,
      count: 30,
      rows: 5,
      columns: 6,
      gap: 4,
    },
  ]);

export function multiChartPlacementSizeMatrixFixtures() {
  return MULTI_CHART_PLACEMENT_SIZE_CASES.map(
    createMultiChartPlacementSizeFixture,
  );
}
