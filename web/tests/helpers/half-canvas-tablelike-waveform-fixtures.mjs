import { encode as encodePng } from "fast-png";

const WIDTH = 800;
const HEIGHT = 450;

const COLORS = Object.freeze({
  paper: [255, 255, 255],
  frame: [70, 78, 88],
  grid: [226, 230, 235],
  text: [47, 54, 64],
  tableHeader: [239, 242, 246],
  blue: [25, 103, 210],
  red: [207, 55, 68],
  green: [25, 147, 86],
  violet: [139, 70, 174],
});

const CURVE_COLORS = Object.freeze([
  COLORS.blue,
  COLORS.red,
  COLORS.green,
  COLORS.violet,
]);

const CASES = Object.freeze([
  {
    name: "left-half-12",
    side: "left",
    count: 12,
    rows: 4,
    columns: 3,
    chartRegion: {
      left: 10,
      top: 10,
      right: 390,
      bottom: 439,
    },
    contentRegion: {
      left: 410,
      top: 10,
      right: 789,
      bottom: 439,
    },
  },
  {
    name: "right-half-10",
    side: "right",
    count: 10,
    rows: 5,
    columns: 2,
    chartRegion: {
      left: 410,
      top: 10,
      right: 789,
      bottom: 439,
    },
    contentRegion: {
      left: 10,
      top: 10,
      right: 390,
      bottom: 439,
    },
  },
  {
    name: "top-half-6",
    side: "top",
    count: 6,
    rows: 2,
    columns: 3,
    chartRegion: {
      left: 10,
      top: 8,
      right: 789,
      bottom: 217,
    },
    contentRegion: {
      left: 10,
      top: 233,
      right: 789,
      bottom: 441,
    },
  },
  {
    name: "bottom-half-2",
    side: "bottom",
    count: 2,
    rows: 1,
    columns: 2,
    chartRegion: {
      left: 10,
      top: 233,
      right: 789,
      bottom: 441,
    },
    contentRegion: {
      left: 10,
      top: 8,
      right: 789,
      bottom: 217,
    },
  },
]);

const SHARED_BOUNDARY_LATTICE_CASE = Object.freeze({
  name: "left-half-shared-boundary-4x4",
  side: "left",
  count: 16,
  rows: 4,
  columns: 4,
  sharedBoundaries: true,
  peakCounts: Object.freeze(
    Array.from(
      { length: 16 },
      (_value, index) => 1 + (index % 4),
    ),
  ),
  chartRegion: {
    left: 10,
    top: 35,
    right: 410,
    bottom: 415,
  },
  contentRegion: {
    left: 430,
    top: 35,
    right: 789,
    bottom: 415,
  },
});

const GRAYSCALE_SHARED_BOUNDARY_LATTICE_CASE =
  Object.freeze({
    ...SHARED_BOUNDARY_LATTICE_CASE,
    name: "left-half-grayscale-shared-boundary-4x4",
    grayscaleCurves: true,
  });

const SINGLE_PEAK_SHARED_BOUNDARY_LATTICE_CASE =
  Object.freeze({
    ...SHARED_BOUNDARY_LATTICE_CASE,
    name: "left-half-single-peak-shared-boundary-4x4",
    peakCounts: Object.freeze(Array(16).fill(1)),
  });

const SINGLE_ROW_SHARED_BOUNDARY_LATTICE_CASE =
  Object.freeze({
    ...SHARED_BOUNDARY_LATTICE_CASE,
    name: "left-half-single-row-shared-boundary-1x4",
    count: 4,
    rows: 1,
    columns: 4,
    peakCounts: Object.freeze([1, 2, 3, 4]),
    chartRegion: {
      left: 10,
      top: 35,
      right: 410,
      bottom: 132,
    },
  });

function pixelOffset(width, x, y) {
  return (y * width + x) * 3;
}

function paintPixel(
  state,
  x,
  y,
  color,
  {
    broad = true,
    salient = true,
    curve = false,
    colorIndex = -1,
  } = {},
) {
  if (x < 0 || x >= state.width || y < 0 || y >= state.height) {
    return;
  }
  const offset = pixelOffset(state.width, x, y);
  state.pixels[offset] = color[0];
  state.pixels[offset + 1] = color[1];
  state.pixels[offset + 2] = color[2];
  const index = y * state.width + x;
  if (broad) state.broadMask[index] = 1;
  if (salient) state.salientMask[index] = 1;
  if (curve) state.curveMask[index] = 1;
  if (colorIndex >= 0) {
    state.curveColorMasks[colorIndex][index] = 1;
  }
}

function drawLine(
  state,
  x1,
  y1,
  x2,
  y2,
  color,
  thickness = 1,
  paintOptions,
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
        paintPixel(
          state,
          localX,
          localY,
          color,
          paintOptions,
        );
      }
    }
  }
}

function fillRect(
  state,
  bounds,
  color,
  paintOptions = { broad: false, salient: false },
) {
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      paintPixel(state, x, y, color, paintOptions);
    }
  }
}

function drawRect(
  state,
  bounds,
  color,
  thickness = 1,
  paintOptions,
) {
  for (let inset = 0; inset < thickness; inset += 1) {
    drawLine(
      state,
      bounds.left + inset,
      bounds.top + inset,
      bounds.right - inset,
      bounds.top + inset,
      color,
      1,
      paintOptions,
    );
    drawLine(
      state,
      bounds.left + inset,
      bounds.bottom - inset,
      bounds.right - inset,
      bounds.bottom - inset,
      color,
      1,
      paintOptions,
    );
    drawLine(
      state,
      bounds.left + inset,
      bounds.top + inset,
      bounds.left + inset,
      bounds.bottom - inset,
      color,
      1,
      paintOptions,
    );
    drawLine(
      state,
      bounds.right - inset,
      bounds.top + inset,
      bounds.right - inset,
      bounds.bottom - inset,
      color,
      1,
      paintOptions,
    );
  }
}

function drawPseudoText(
  state,
  bounds,
  rows,
  {
    rowGap = 13,
    color = COLORS.text,
  } = {},
) {
  const availableWidth = bounds.right - bounds.left + 1;
  for (let row = 0; row < rows; row += 1) {
    const y = bounds.top + row * rowGap;
    if (y + 6 > bounds.bottom) break;
    const lineRatio = 0.58 + ((row * 19) % 33) / 100;
    const lineRight = Math.min(
      bounds.right,
      bounds.left + Math.round(availableWidth * lineRatio),
    );
    for (
      let cursor = bounds.left;
      cursor <= lineRight;
      cursor += 11
    ) {
      const glyphWidth = 4 + ((cursor + row) % 4);
      drawLine(
        state,
        cursor,
        y,
        Math.min(lineRight, cursor + glyphWidth),
        y,
        color,
      );
      drawLine(
        state,
        cursor,
        y,
        cursor,
        y + 6,
        color,
      );
      if ((cursor + row) % 3 === 0) {
        drawLine(
          state,
          cursor,
          y + 3,
          Math.min(lineRight, cursor + glyphWidth),
          y + 3,
          color,
        );
      }
    }
  }
}

function drawNeutralTable(
  state,
  bounds,
  rows,
  columns,
  { cellTextRows = 1 } = {},
) {
  fillRect(
    state,
    {
      ...bounds,
      bottom: Math.min(
        bounds.bottom,
        bounds.top +
          Math.round((bounds.bottom - bounds.top + 1) / rows) -
          1,
      ),
    },
    COLORS.tableHeader,
  );
  drawRect(state, bounds, COLORS.frame);
  for (let column = 1; column < columns; column += 1) {
    const x = Math.round(
      bounds.left +
        ((bounds.right - bounds.left) * column) / columns,
    );
    drawLine(
      state,
      x,
      bounds.top,
      x,
      bounds.bottom,
      COLORS.frame,
    );
  }
  for (let row = 1; row < rows; row += 1) {
    const y = Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * row) / rows,
    );
    drawLine(
      state,
      bounds.left,
      y,
      bounds.right,
      y,
      COLORS.frame,
    );
  }
  const cellWidth =
    (bounds.right - bounds.left + 1) / columns;
  const cellHeight =
    (bounds.bottom - bounds.top + 1) / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      drawPseudoText(
        state,
        {
          left: Math.round(
            bounds.left + column * cellWidth + 5,
          ),
          top: Math.round(bounds.top + row * cellHeight + 6),
          right: Math.round(
            bounds.left + (column + 1) * cellWidth - 5,
          ),
          bottom: Math.round(
            bounds.top + (row + 1) * cellHeight - 4,
          ),
        },
        cellTextRows,
        { rowGap: cellTextRows > 1 ? 7 : 9 },
      );
    }
  }
}

function drawChart(state, chart, chartIndex) {
  drawRect(state, chart.bounds, COLORS.frame);
  const width =
    chart.bounds.right - chart.bounds.left + 1;
  const height =
    chart.bounds.bottom - chart.bounds.top + 1;
  const plot = {
    left: chart.bounds.left + Math.max(5, Math.round(width * 0.07)),
    top: chart.bounds.top + Math.max(5, Math.round(height * 0.12)),
    right:
      chart.bounds.right - Math.max(4, Math.round(width * 0.045)),
    bottom:
      chart.bounds.bottom - Math.max(5, Math.round(height * 0.1)),
  };
  const horizontalGridRatios = chart.denseSharedGrid
    ? [0.25, 0.5, 0.75]
    : [0.34, 0.67];
  const verticalGridRatios = chart.denseSharedGrid
    ? horizontalGridRatios
    : [0.33, 0.66];
  const gridColor = chart.denseSharedGrid
    ? [166, 173, 182]
    : COLORS.grid;
  for (const ratio of horizontalGridRatios) {
    const y = Math.round(
      plot.top + (plot.bottom - plot.top) * ratio,
    );
    drawLine(
      state,
      plot.left,
      y,
      plot.right,
      y,
      gridColor,
      1,
      {
        broad: true,
        salient: chart.denseSharedGrid,
      },
    );
  }
  for (const ratio of verticalGridRatios) {
    const x = Math.round(
      plot.left + (plot.right - plot.left) * ratio,
    );
    drawLine(
      state,
      x,
      plot.top,
      x,
      plot.bottom,
      gridColor,
      1,
      {
        broad: true,
        salient: chart.denseSharedGrid,
      },
    );
  }

  const peakCount = chart.peakCount;
  const peakCenters = Array.from(
    { length: peakCount },
    (_value, peakIndex) =>
      (peakIndex + 0.68) / (peakCount + 0.36),
  );
  const peakWidth = Math.max(
    0.035,
    Math.min(0.105, 0.3 / peakCount),
  );
  const colorIndex = chart.grayscaleCurve
    ? -1
    : chartIndex % CURVE_COLORS.length;
  const curveColor = chart.grayscaleCurve
    ? COLORS.text
    : CURVE_COLORS[colorIndex];
  let previous;
  for (let x = plot.left; x <= plot.right; x += 1) {
    const progress =
      (x - plot.left) / Math.max(1, plot.right - plot.left);
    let response = 0;
    for (const peakCenter of peakCenters) {
      const distance = (progress - peakCenter) / peakWidth;
      response = Math.max(
        response,
        Math.exp(-0.5 * distance * distance),
      );
    }
    const leftTail =
      0.08 *
      Math.exp(-Math.max(0, progress) * (7 + chartIndex % 3));
    const rightTail =
      0.1 *
      Math.exp(
        -Math.max(0, 1 - progress) * (6 + chartIndex % 2),
      );
    const y = Math.round(
      plot.bottom -
        Math.min(1, response + leftTail + rightTail) *
          (plot.bottom - plot.top) *
          0.84,
    );
    if (previous) {
      drawLine(
        state,
        previous.x,
        previous.y,
        x,
        y,
        curveColor,
        2,
        {
          broad: true,
          salient: true,
          curve: true,
          colorIndex,
        },
      );
    }
    previous = { x, y };
  }
}

function gridCharts(definition) {
  if (definition.sharedBoundaries) {
    const horizontalSpan =
      definition.chartRegion.right -
      definition.chartRegion.left;
    const verticalSpan =
      definition.chartRegion.bottom -
      definition.chartRegion.top;
    return Array.from(
      { length: definition.count },
      (_value, index) => {
        const row = Math.floor(index / definition.columns);
        const column = index % definition.columns;
        return {
          index,
          denseSharedGrid: true,
          grayscaleCurve:
            definition.grayscaleCurves === true,
          peakCount:
            definition.peakCounts?.[index] ??
            3 + ((index * 5 + definition.count) % 4),
          bounds: {
            left: Math.round(
              definition.chartRegion.left +
                (horizontalSpan * column) /
                  definition.columns,
            ),
            top: Math.round(
              definition.chartRegion.top +
                (verticalSpan * row) / definition.rows,
            ),
            right: Math.round(
              definition.chartRegion.left +
                (horizontalSpan * (column + 1)) /
                  definition.columns,
            ),
            bottom: Math.round(
              definition.chartRegion.top +
                (verticalSpan * (row + 1)) /
                  definition.rows,
            ),
          },
        };
      },
    );
  }
  const gap = 5;
  const regionWidth =
    definition.chartRegion.right -
    definition.chartRegion.left +
    1;
  const regionHeight =
    definition.chartRegion.bottom -
    definition.chartRegion.top +
    1;
  const cellWidth =
    (regionWidth - gap * (definition.columns - 1)) /
    definition.columns;
  const cellHeight =
    (regionHeight - gap * (definition.rows - 1)) /
    definition.rows;
  return Array.from({ length: definition.count }, (_value, index) => {
    const row = Math.floor(index / definition.columns);
    const column = index % definition.columns;
    return {
      index,
      grayscaleCurve:
        definition.grayscaleCurves === true,
      peakCount: 3 + ((index * 5 + definition.count) % 4),
      bounds: {
        left: Math.round(
          definition.chartRegion.left +
            column * (cellWidth + gap),
        ),
        top: Math.round(
          definition.chartRegion.top +
            row * (cellHeight + gap),
        ),
        right: Math.round(
          definition.chartRegion.left +
            column * (cellWidth + gap) +
            cellWidth -
            1,
        ),
        bottom: Math.round(
          definition.chartRegion.top +
            row * (cellHeight + gap) +
            cellHeight -
            1,
        ),
      },
    };
  });
}

function contentLayout(region) {
  const width = region.right - region.left + 1;
  const height = region.bottom - region.top + 1;
  const horizontal = width >= height * 1.35;
  if (horizontal) {
    return {
      text: {
        left: region.left + 5,
        top: region.top + 5,
        right: region.left + Math.round(width * 0.38),
        bottom: region.bottom - 5,
      },
      table: {
        left: region.left + Math.round(width * 0.43),
        top: region.top + 5,
        right: region.left + Math.round(width * 0.78),
        bottom: region.bottom - 5,
      },
      blank: {
        left: region.left + Math.round(width * 0.82),
        top: region.top + 5,
        right: region.right - 5,
        bottom: region.bottom - 5,
      },
    };
  }
  return {
    text: {
      left: region.left + 5,
      top: region.top + 5,
      right: region.right - 5,
      bottom: region.top + Math.round(height * 0.27),
    },
    table: {
      left: region.left + 5,
      top: region.top + Math.round(height * 0.34),
      right: region.right - 5,
      bottom: region.top + Math.round(height * 0.72),
    },
    blank: {
      left: region.left + 5,
      top: region.top + Math.round(height * 0.77),
      right: region.right - 5,
      bottom: region.bottom - 5,
    },
  };
}

function createFixtureState() {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    const offset = index * 3;
    pixels[offset] = COLORS.paper[0];
    pixels[offset + 1] = COLORS.paper[1];
    pixels[offset + 2] = COLORS.paper[2];
  }
  return {
    width: WIDTH,
    height: HEIGHT,
    pixels,
    broadMask: new Uint8Array(WIDTH * HEIGHT),
    salientMask: new Uint8Array(WIDTH * HEIGHT),
    curveMask: new Uint8Array(WIDTH * HEIGHT),
    curveColorMasks: CURVE_COLORS.map(
      () => new Uint8Array(WIDTH * HEIGHT),
    ),
  };
}

function makeFixture(definition) {
  const state = createFixtureState();
  const charts = gridCharts(definition);
  charts.forEach((chart, chartIndex) =>
    drawChart(state, chart, chartIndex),
  );

  const content = contentLayout(definition.contentRegion);
  drawPseudoText(
    state,
    content.text,
    definition.sharedBoundaries ? 18 : 6,
    definition.sharedBoundaries
      ? { rowGap: 7 }
      : undefined,
  );
  drawNeutralTable(
    state,
    content.table,
    definition.sharedBoundaries ? 8 : 4,
    definition.sharedBoundaries ? 5 : 4,
    definition.sharedBoundaries
      ? { cellTextRows: 3 }
      : undefined,
  );

  return {
    name: definition.name,
    side: definition.side,
    width: WIDTH,
    height: HEIGHT,
    channels: 3,
    pixels: state.pixels,
    broadMask: state.broadMask,
    salientMask: state.salientMask,
    curveMask: state.curveMask,
    curveColorMasks: state.curveColorMasks,
    bytes: encodePng({
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      depth: 8,
      data: state.pixels,
    }),
    mimeType: "image/png",
    charts,
    expectedChartCount: charts.length,
    chartRegion: definition.chartRegion,
    contentRegion: definition.contentRegion,
    distractors: [
      { type: "text", bounds: content.text },
      { type: "table", bounds: content.table },
      { type: "blank", bounds: content.blank },
    ],
  };
}

export function halfCanvasTablelikeWaveformFixtures() {
  return CASES.map(makeFixture);
}

export function sharedBoundaryHalfCanvasLatticeFixture() {
  return makeFixture(SHARED_BOUNDARY_LATTICE_CASE);
}

export function grayscaleSharedBoundaryHalfCanvasLatticeFixture() {
  return makeFixture(
    GRAYSCALE_SHARED_BOUNDARY_LATTICE_CASE,
  );
}

export function singlePeakSharedBoundaryHalfCanvasLatticeFixture() {
  return makeFixture(
    SINGLE_PEAK_SHARED_BOUNDARY_LATTICE_CASE,
  );
}

export function singleRowSharedBoundaryHalfCanvasLatticeFixture() {
  return makeFixture(
    SINGLE_ROW_SHARED_BOUNDARY_LATTICE_CASE,
  );
}

export function denseGuideGridSingleChartFixture({
  grayscaleCurve = false,
  nearFullImage = false,
} = {}) {
  const state = createFixtureState();
  const chart = {
    index: 0,
    denseSharedGrid: true,
    grayscaleCurve,
    peakCount: 5,
    bounds: nearFullImage
      ? {
          left: 18,
          top: 12,
          right: 781,
          bottom: 437,
        }
      : {
          left: 10,
          top: 2,
          right: 789,
          bottom: 232,
        },
  };
  drawRect(state, chart.bounds, COLORS.frame);

  const chartWidth =
    chart.bounds.right - chart.bounds.left + 1;
  const chartHeight =
    chart.bounds.bottom - chart.bounds.top + 1;
  const plot = {
    left:
      chart.bounds.left +
      Math.max(5, Math.round(chartWidth * 0.07)),
    top:
      chart.bounds.top +
      Math.max(5, Math.round(chartHeight * 0.12)),
    right:
      chart.bounds.right -
      Math.max(4, Math.round(chartWidth * 0.045)),
    bottom:
      chart.bounds.bottom -
      Math.max(5, Math.round(chartHeight * 0.1)),
  };
  const darkGuideColor = [47, 54, 64];
  for (let guide = 1; guide < 9; guide += 1) {
    const ratio = guide / 9;
    drawLine(
      state,
      plot.left,
      Math.round(plot.top + (plot.bottom - plot.top) * ratio),
      plot.right,
      Math.round(plot.top + (plot.bottom - plot.top) * ratio),
      darkGuideColor,
      2,
      { broad: true, salient: true },
    );
  }
  for (let guide = 1; guide < 11; guide += 1) {
    const ratio = guide / 11;
    drawLine(
      state,
      Math.round(plot.left + (plot.right - plot.left) * ratio),
      plot.top,
      Math.round(plot.left + (plot.right - plot.left) * ratio),
      plot.bottom,
      darkGuideColor,
      2,
      { broad: true, salient: true },
    );
  }
  const peakCenters = [0.1, 0.3, 0.5, 0.7, 0.9];
  const colorIndex = grayscaleCurve ? -1 : 0;
  const curveColor = grayscaleCurve
    ? COLORS.text
    : CURVE_COLORS[colorIndex];
  let previous;
  for (let x = plot.left; x <= plot.right; x += 1) {
    const progress =
      (x - plot.left) / Math.max(1, plot.right - plot.left);
    const response = Math.max(
      ...peakCenters.map((center) =>
        Math.exp(-0.5 * ((progress - center) / 0.052) ** 2),
      ),
    );
    const y = Math.round(
      plot.bottom -
        (0.2 + response * 0.16) *
          (plot.bottom - plot.top),
    );
    if (previous) {
      drawLine(
        state,
        previous.x,
        previous.y,
        x,
        y,
        curveColor,
        2,
        {
          broad: true,
          salient: true,
          curve: true,
          colorIndex,
        },
      );
    }
    previous = { x, y };
  }

  const contentRegion = nearFullImage
    ? {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
      }
    : {
        left: 10,
        top: 239,
        right: 789,
        bottom: 448,
      };

  return {
    name: grayscaleCurve
      ? nearFullImage
        ? "near-full-grayscale-single-chart-dense-guide-grid"
        : "top-half-grayscale-single-chart-dense-guide-grid"
      : nearFullImage
        ? "near-full-single-chart-dense-guide-grid"
        : "top-half-single-chart-dense-guide-grid",
    side: nearFullImage ? "full" : "top",
    width: WIDTH,
    height: HEIGHT,
    channels: 3,
    pixels: state.pixels,
    broadMask: state.broadMask,
    salientMask: state.salientMask,
    curveMask: state.curveMask,
    curveColorMasks: state.curveColorMasks,
    bytes: encodePng({
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      depth: 8,
      data: state.pixels,
    }),
    mimeType: "image/png",
    charts: [chart],
    expectedChartCount: 1,
    chartRegion: chart.bounds,
    contentRegion,
    distractors: nearFullImage
      ? []
      : [{ type: "blank", bounds: contentRegion }],
  };
}

function drawRepeatedTwoPeakSparklineTable(
  state,
  bounds,
  { internalGuides = false } = {},
) {
  const rows = 4;
  const columns = 4;
  const cells = [];
  drawRect(state, bounds, COLORS.frame);
  for (let row = 1; row < rows; row += 1) {
    const y = Math.round(
      bounds.top +
        ((bounds.bottom - bounds.top) * row) / rows,
    );
    drawLine(
      state,
      bounds.left,
      y,
      bounds.right,
      y,
      COLORS.frame,
    );
  }
  for (let column = 1; column < columns; column += 1) {
    const x = Math.round(
      bounds.left +
        ((bounds.right - bounds.left) * column) / columns,
    );
    drawLine(
      state,
      x,
      bounds.top,
      x,
      bounds.bottom,
      COLORS.frame,
    );
  }

  const cellWidth =
    (bounds.right - bounds.left) / columns;
  const cellHeight =
    (bounds.bottom - bounds.top) / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const cellLeft = Math.round(
        bounds.left + column * cellWidth,
      );
      const cellTop = Math.round(
        bounds.top + row * cellHeight,
      );
      const cellRight = Math.round(
        bounds.left + (column + 1) * cellWidth,
      );
      const cellBottom = Math.round(
        bounds.top + (row + 1) * cellHeight,
      );
      const curveLeft = cellLeft + 8;
      const curveRight = cellRight - 8;
      const curveTop = cellTop + 10;
      const curveBottom =
        cellBottom - (internalGuides ? 38 : 28);
      cells.push({
        index: row * columns + column,
        peakCount: 2,
        bounds: {
          left: cellLeft,
          top: cellTop,
          right: cellRight,
          bottom: cellBottom,
        },
        curveBounds: {
          left: curveLeft,
          top: curveTop,
          right: curveRight,
          bottom: curveBottom,
        },
      });
      let previous;
      if (internalGuides) {
        for (const ratio of [1 / 3, 2 / 3]) {
          const guideX = Math.round(
            curveLeft + (curveRight - curveLeft) * ratio,
          );
          const guideY = Math.round(
            curveTop + (curveBottom - curveTop) * ratio,
          );
          drawLine(
            state,
            guideX,
            curveTop,
            guideX,
            curveBottom,
            COLORS.frame,
          );
          drawLine(
            state,
            curveLeft,
            guideY,
            curveRight,
            guideY,
            COLORS.frame,
          );
        }
      }
      for (
        let x = curveLeft;
        x <= curveRight;
        x += 1
      ) {
        const progress =
          (x - curveLeft) /
          Math.max(1, curveRight - curveLeft);
        const response = Math.max(
          Math.exp(
            -0.5 * ((progress - 0.3) / 0.09) ** 2,
          ),
          0.85 *
            Math.exp(
              -0.5 *
                ((progress - 0.7) / 0.1) ** 2,
            ),
        );
        const y = Math.round(
          curveBottom -
            response *
              (curveBottom - curveTop) *
              0.72,
        );
        if (previous) {
          drawLine(
            state,
            previous.x,
            previous.y,
            x,
            y,
            COLORS.blue,
            2,
            {
              broad: true,
              salient: true,
              curve: true,
              colorIndex: 0,
            },
          );
        }
        previous = { x, y };
      }
      drawPseudoText(
        state,
        {
          left: cellLeft + 9,
          top: cellBottom - 22,
          right: cellRight - 9,
          bottom: cellBottom - 5,
        },
        3,
        { rowGap: 6 },
      );
    }
  }
  return cells;
}

export function multiPeakSparklineTextTableFixture() {
  return makeMultiPeakSparklineTextTableFixture(false);
}

export function guidedMultiPeakSparklineTextTableFixture() {
  return makeMultiPeakSparklineTextTableFixture(true);
}

export function guidedSingleRowMultiPeakSparklineTextTableFixture() {
  const fixture =
    makeMultiPeakSparklineTextTableFixture(true);
  const tableCells = fixture.tableCells.slice(0, 4);
  const tableBounds = {
    left: fixture.chartRegion.left,
    top: fixture.chartRegion.top,
    right: fixture.chartRegion.right,
    bottom: tableCells[0].bounds.bottom,
  };
  for (
    let y = tableBounds.bottom + 1;
    y < HEIGHT;
    y += 1
  ) {
    for (
      let x = tableBounds.left;
      x <= tableBounds.right;
      x += 1
    ) {
      const index = y * WIDTH + x;
      const offset = index * 3;
      fixture.pixels[offset] = COLORS.paper[0];
      fixture.pixels[offset + 1] = COLORS.paper[1];
      fixture.pixels[offset + 2] = COLORS.paper[2];
      fixture.broadMask[index] = 0;
      fixture.salientMask[index] = 0;
      fixture.curveMask[index] = 0;
      for (const colorMask of fixture.curveColorMasks) {
        colorMask[index] = 0;
      }
    }
  }
  return {
    ...fixture,
    name:
      "left-half-1x4-guided-multi-peak-sparkline-text-table",
    bytes: encodePng({
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      depth: 8,
      data: fixture.pixels,
    }),
    tableCells,
    expectedCellCount: tableCells.length,
    chartRegion: tableBounds,
    distractors: [
      { type: "sparkline-table", bounds: tableBounds },
      ...fixture.distractors.filter(
        ({ type }) => type !== "sparkline-table",
      ),
    ],
  };
}

function makeMultiPeakSparklineTextTableFixture(
  internalGuides,
) {
  const state = createFixtureState();
  const tableBounds = {
    left: 10,
    top: 35,
    right: 410,
    bottom: 415,
  };
  const documentBounds = {
    left: 430,
    top: 35,
    right: 789,
    bottom: 415,
  };
  const tableCells = drawRepeatedTwoPeakSparklineTable(
    state,
    tableBounds,
    { internalGuides },
  );
  drawPseudoText(
    state,
    documentBounds,
    24,
    { rowGap: 14 },
  );

  return {
    name: internalGuides
      ? "left-half-4x4-guided-multi-peak-sparkline-text-table"
      : "left-half-4x4-multi-peak-sparkline-text-table",
    side: "left",
    width: WIDTH,
    height: HEIGHT,
    channels: 3,
    pixels: state.pixels,
    broadMask: state.broadMask,
    salientMask: state.salientMask,
    curveMask: state.curveMask,
    curveColorMasks: state.curveColorMasks,
    bytes: encodePng({
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      depth: 8,
      data: state.pixels,
    }),
    mimeType: "image/png",
    charts: [],
    tableCells,
    expectedChartCount: 0,
    expectedCellCount: 16,
    chartRegion: tableBounds,
    contentRegion: documentBounds,
    distractors: [
      { type: "sparkline-table", bounds: tableBounds },
      { type: "text", bounds: documentBounds },
    ],
  };
}
