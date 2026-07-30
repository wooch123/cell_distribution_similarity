import { encode as encodePng } from "fast-png";

const CURVE_COLORS = Object.freeze([
  Object.freeze([26, 105, 220]),
  Object.freeze([224, 61, 53]),
  Object.freeze([23, 156, 87]),
  Object.freeze([180, 66, 193]),
]);

const WIDTH = 837;
const HEIGHT = 300;
const MARGIN = 25;
const PEAK_SPACING = 62;
const STATE_COUNT = 12;

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
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
    1,
  );
  const radius = Math.max(
    0,
    Math.floor((thickness - 1) / 2),
  );
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let localY = y - radius; localY <= y + radius; localY += 1) {
      for (
        let localX = x - radius;
        localX <= x + radius;
        localX += 1
      ) {
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

function drawFrame(pixels, bounds) {
  const axis = [38, 42, 48];
  drawLine(
    pixels,
    WIDTH,
    HEIGHT,
    bounds.left,
    bounds.top,
    bounds.right,
    bounds.top,
    axis,
    2,
  );
  drawLine(
    pixels,
    WIDTH,
    HEIGHT,
    bounds.left,
    bounds.bottom,
    bounds.right,
    bounds.bottom,
    axis,
    2,
  );
  drawLine(
    pixels,
    WIDTH,
    HEIGHT,
    bounds.left,
    bounds.top,
    bounds.left,
    bounds.bottom,
    axis,
    2,
  );
  drawLine(
    pixels,
    WIDTH,
    HEIGHT,
    bounds.right,
    bounds.top,
    bounds.right,
    bounds.bottom,
    axis,
    2,
  );
}

function drawDenseGuideGrid(pixels, bounds) {
  const grid = [215, 219, 225];
  const columnStep = Math.round(PEAK_SPACING / 2);
  for (
    let x = bounds.left + columnStep;
    x < bounds.right;
    x += columnStep
  ) {
    drawLine(
      pixels,
      WIDTH,
      HEIGHT,
      x,
      bounds.top + 1,
      x,
      bounds.bottom - 1,
      grid,
    );
  }
  for (let row = 1; row < 8; row += 1) {
    const y = Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * row) / 8,
    );
    drawLine(
      pixels,
      WIDTH,
      HEIGHT,
      bounds.left + 1,
      y,
      bounds.right - 1,
      y,
      grid,
    );
  }
}

function drawStateLobes(
  pixels,
  bounds,
  {
    colorCount,
    valleyFloorRatio,
  },
) {
  const firstCenter = bounds.left + PEAK_SPACING * 0.72;
  const lastCenter = bounds.right - PEAK_SPACING * 0.72;
  const centers = Array.from(
    { length: STATE_COUNT },
    (_value, index) =>
      firstCenter +
      ((lastCenter - firstCenter) * index) /
        (STATE_COUNT - 1),
  );
  const plotHeight = bounds.bottom - bounds.top;
  const floorY =
    bounds.top + valleyFloorRatio * plotHeight;

  for (
    let peakIndex = 0;
    peakIndex < centers.length;
    peakIndex += 1
  ) {
    let halfWidth = PEAK_SPACING * 0.39;
    if (peakIndex === centers.length - 1) {
      halfWidth *= 1.55;
    }
    const left = Math.round(centers[peakIndex] - halfWidth);
    const right = Math.round(centers[peakIndex] + halfWidth);
    const peakY =
      bounds.top +
      (0.11 + ((peakIndex * 3 + STATE_COUNT) % 5) * 0.025) *
        plotHeight;
    let previous = null;
    for (let x = left; x <= right; x += 1) {
      const normalized =
        (x - centers[peakIndex]) / Math.max(1, halfWidth);
      const response =
        Math.abs(normalized) > 1
          ? 0
          : Math.cos((normalized * Math.PI) / 2) ** 2;
      const y = Math.round(
        floorY - response * (floorY - peakY),
      );
      if (previous) {
        drawLine(
          pixels,
          WIDTH,
          HEIGHT,
          previous.x,
          previous.y,
          x,
          y,
          CURVE_COLORS[peakIndex % colorCount],
          2,
        );
      }
      previous = { x, y };
    }
  }
}

export function wideFloorTouchWaveformFixture({
  name = "dense-floor-monochrome",
  denseGrid = true,
  floorTouch = true,
  colorCount = 1,
} = {}) {
  if (![1, 2, 4].includes(colorCount)) {
    throw new Error("colorCount must be one of 1, 2, or 4.");
  }
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3).fill(255);
  const bounds = Object.freeze({
    left: MARGIN,
    top: MARGIN,
    right: WIDTH - MARGIN - 1,
    bottom: HEIGHT - MARGIN - 1,
  });
  drawFrame(pixels, bounds);
  if (denseGrid) drawDenseGuideGrid(pixels, bounds);
  drawStateLobes(pixels, bounds, {
    colorCount,
    valleyFloorRatio: floorTouch ? 0.998 : 0.94,
  });

  return Object.freeze({
    name,
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
    expected: Object.freeze({
      panelCount: 1,
      seriesCount: 1,
      stateCount: STATE_COUNT,
      peakCount: STATE_COUNT,
      valleyCount: STATE_COUNT - 1,
      sourceWidth: WIDTH,
      sourceHeight: HEIGHT,
      processedWidth: 1920,
      processedHeight: 688,
    }),
    parameters: Object.freeze({
      denseGrid,
      floorTouch,
      colorCount,
    }),
    bounds,
  });
}

export function wideFloorTouchWaveformFixtures() {
  return Object.freeze([
    wideFloorTouchWaveformFixture(),
    wideFloorTouchWaveformFixture({
      name: "dense-above-floor-monochrome",
      floorTouch: false,
    }),
    wideFloorTouchWaveformFixture({
      name: "gridless-floor-monochrome",
      denseGrid: false,
    }),
    wideFloorTouchWaveformFixture({
      name: "dense-floor-two-colors",
      colorCount: 2,
    }),
    wideFloorTouchWaveformFixture({
      name: "dense-floor-four-colors",
      colorCount: 4,
    }),
  ]);
}
