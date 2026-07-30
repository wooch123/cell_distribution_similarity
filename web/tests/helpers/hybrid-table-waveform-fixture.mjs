import { encode as encodePng } from "fast-png";

const WIDTH = 1280;
const HEIGHT = 720;

const COLORS = Object.freeze({
  paper: [255, 255, 255],
  frame: [56, 64, 76],
  grid: [220, 225, 232],
  header: [232, 238, 247],
  text: [47, 54, 66],
  muted: [128, 136, 148],
  blue: [24, 102, 210],
  red: [210, 52, 64],
  green: [24, 147, 84],
  violet: [139, 69, 174],
});

const CURVE_COLORS = Object.freeze([
  COLORS.blue,
  COLORS.red,
  COLORS.green,
  COLORS.violet,
]);

const TABLE = Object.freeze({
  left: 48,
  top: 54,
  right: 1231,
  bottom: 670,
});

// The first interval is a merged header. The remaining four rows and
// five columns deliberately have unequal sizes.
const ROW_EDGES = Object.freeze([
  54, 132, 250, 398, 514, 670,
]);
const COLUMN_EDGES = Object.freeze([
  48, 229, 481, 691, 981, 1231,
]);

const WAVEFORM_CELLS = Object.freeze([
  { row: 0, column: 0, peakCount: 1 },
  { row: 0, column: 2, peakCount: 4 },
  { row: 0, column: 4, peakCount: 2 },
  { row: 1, column: 1, peakCount: 5 },
  { row: 1, column: 3, peakCount: 3 },
  { row: 2, column: 0, peakCount: 2 },
  { row: 2, column: 4, peakCount: 4 },
  { row: 3, column: 2, peakCount: 3 },
]);

function offset(x, y) {
  return (y * WIDTH + x) * 3;
}

function paintPixel(pixels, x, y, color) {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const pixelOffset = offset(x, y);
  pixels[pixelOffset] = color[0];
  pixels[pixelOffset + 1] = color[1];
  pixels[pixelOffset + 2] = color[2];
}

function fillRect(pixels, bounds, color) {
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      paintPixel(pixels, x, y, color);
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
    1,
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
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
        paintPixel(pixels, localX, localY, color);
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
  bounds,
  rows,
  {
    color = COLORS.text,
    rowGap = 13,
    seed = 0,
  } = {},
) {
  const availableWidth = bounds.right - bounds.left + 1;
  for (let row = 0; row < rows; row += 1) {
    const top = bounds.top + row * rowGap;
    if (top + 7 > bounds.bottom) break;
    const lineRatio = 0.48 + ((row * 17 + seed * 11) % 43) / 100;
    const right = Math.min(
      bounds.right,
      bounds.left + Math.round(availableWidth * lineRatio),
    );
    for (
      let cursor = bounds.left;
      cursor <= right;
      cursor += 12
    ) {
      const glyphWidth = 4 + ((cursor + row + seed) % 5);
      drawLine(
        pixels,
        cursor,
        top,
        Math.min(right, cursor + glyphWidth),
        top,
        color,
      );
      drawLine(
        pixels,
        cursor,
        top,
        cursor,
        top + 7,
        color,
      );
      if ((cursor + row + seed) % 2 === 0) {
        drawLine(
          pixels,
          cursor,
          top + 4,
          Math.min(right, cursor + glyphWidth),
          top + 4,
          color,
        );
      }
    }
  }
}

function cellBounds(row, column) {
  return {
    left: COLUMN_EDGES[column],
    top: ROW_EDGES[row + 1],
    right: COLUMN_EDGES[column + 1],
    bottom: ROW_EDGES[row + 2],
  };
}

function drawWaveformChart(
  pixels,
  cell,
  peakCount,
  chartIndex,
) {
  const cellWidth = cell.right - cell.left + 1;
  const cellHeight = cell.bottom - cell.top + 1;
  const frame = {
    left: cell.left + Math.max(8, Math.round(cellWidth * 0.055)),
    top: cell.top + Math.max(8, Math.round(cellHeight * 0.075)),
    right:
      cell.right - Math.max(7, Math.round(cellWidth * 0.045)),
    bottom:
      cell.bottom - Math.max(8, Math.round(cellHeight * 0.07)),
  };
  drawRect(pixels, frame, COLORS.frame);

  const frameWidth = frame.right - frame.left + 1;
  const frameHeight = frame.bottom - frame.top + 1;
  const plot = {
    left: frame.left + Math.max(8, Math.round(frameWidth * 0.07)),
    top: frame.top + Math.max(8, Math.round(frameHeight * 0.11)),
    right: frame.right - Math.max(7, Math.round(frameWidth * 0.04)),
    bottom:
      frame.bottom - Math.max(8, Math.round(frameHeight * 0.09)),
  };
  for (const ratio of [0.25, 0.5, 0.75]) {
    const x = Math.round(
      plot.left + (plot.right - plot.left) * ratio,
    );
    const y = Math.round(
      plot.top + (plot.bottom - plot.top) * ratio,
    );
    drawLine(
      pixels,
      x,
      plot.top,
      x,
      plot.bottom,
      COLORS.grid,
    );
    drawLine(
      pixels,
      plot.left,
      y,
      plot.right,
      y,
      COLORS.grid,
    );
  }

  const color = CURVE_COLORS[chartIndex % CURVE_COLORS.length];
  const centers = Array.from(
    { length: peakCount },
    (_value, peakIndex) =>
      (peakIndex + 0.62) / (peakCount + 0.24),
  );
  const sigma = Math.max(
    0.025,
    Math.min(0.095, 0.26 / Math.max(1, peakCount)),
  );
  let previous;
  for (let x = plot.left; x <= plot.right; x += 1) {
    const progress =
      (x - plot.left) / Math.max(1, plot.right - plot.left);
    const response = Math.max(
      ...centers.map((center, peakIndex) => {
        const amplitude = 0.86 + ((peakIndex + chartIndex) % 3) * 0.06;
        return (
          amplitude *
          Math.exp(-0.5 * ((progress - center) / sigma) ** 2)
        );
      }),
    );
    const y = Math.round(
      plot.bottom -
        Math.min(1, response) * (plot.bottom - plot.top) * 0.82,
    );
    if (previous) {
      drawLine(
        pixels,
        previous.x,
        previous.y,
        x,
        y,
        color,
        2,
      );
    }
    previous = { x, y };
  }

  return {
    bounds: Object.freeze(frame),
    plotBounds: Object.freeze(plot),
  };
}

function drawNumericCell(pixels, cell, seed) {
  const inset = {
    left: cell.left + 14,
    top: cell.top + 17,
    right: cell.right - 14,
    bottom: cell.bottom - 12,
  };
  drawPseudoText(pixels, inset, 4, {
    rowGap: 18,
    seed,
  });
  const barLeft = inset.left + Math.round((seed % 4) * 0.08 * (inset.right - inset.left));
  drawLine(
    pixels,
    barLeft,
    inset.bottom - 6,
    Math.min(inset.right, barLeft + 22 + (seed % 5) * 8),
    inset.bottom - 6,
    COLORS.muted,
    3,
  );
}

function drawMixedContent(pixels, waveCellKeys) {
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      if (waveCellKeys.has(`${row}:${column}`)) continue;
      const cell = cellBounds(row, column);
      const kind = (row * 5 + column) % 4;
      if (kind === 0) continue;
      if (kind === 1) {
        drawPseudoText(
          pixels,
          {
            left: cell.left + 13,
            top: cell.top + 18,
            right: cell.right - 13,
            bottom: cell.bottom - 12,
          },
          5,
          {
            rowGap: 17,
            seed: row * 5 + column,
          },
        );
      } else if (kind === 2) {
        drawNumericCell(pixels, cell, row * 5 + column);
      } else {
        const shape = {
          left: cell.left + Math.round((cell.right - cell.left) * 0.23),
          top: cell.top + Math.round((cell.bottom - cell.top) * 0.2),
          right: cell.right - Math.round((cell.right - cell.left) * 0.2),
          bottom: cell.bottom - Math.round((cell.bottom - cell.top) * 0.22),
        };
        drawRect(pixels, shape, COLORS.muted, 2);
        drawLine(
          pixels,
          shape.left,
          shape.bottom,
          shape.right,
          shape.top,
          COLORS.muted,
          2,
        );
      }
    }
  }
}

export function hybridTableWaveformFixture() {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3).fill(255);
  fillRect(
    pixels,
    {
      left: TABLE.left + 1,
      top: TABLE.top + 1,
      right: TABLE.right - 1,
      bottom: ROW_EDGES[1] - 1,
    },
    COLORS.header,
  );
  drawRect(pixels, TABLE, COLORS.frame, 2);
  for (let row = 1; row < ROW_EDGES.length - 1; row += 1) {
    drawLine(
      pixels,
      TABLE.left,
      ROW_EDGES[row],
      TABLE.right,
      ROW_EDGES[row],
      COLORS.frame,
      row === 1 ? 2 : 1,
    );
  }
  // The vertical dividers start below the merged header.
  for (
    let column = 1;
    column < COLUMN_EDGES.length - 1;
    column += 1
  ) {
    drawLine(
      pixels,
      COLUMN_EDGES[column],
      ROW_EDGES[1],
      COLUMN_EDGES[column],
      TABLE.bottom,
      COLORS.frame,
    );
  }
  drawPseudoText(
    pixels,
    {
      left: TABLE.left + 22,
      top: TABLE.top + 24,
      right: TABLE.right - 22,
      bottom: ROW_EDGES[1] - 15,
    },
    2,
    {
      rowGap: 18,
      seed: 41,
    },
  );

  const waveCellKeys = new Set(
    WAVEFORM_CELLS.map(({ row, column }) => `${row}:${column}`),
  );
  drawMixedContent(pixels, waveCellKeys);
  const charts = WAVEFORM_CELLS.map(
    ({ row, column, peakCount }, chartIndex) => {
      const cell = cellBounds(row, column);
      const chart = drawWaveformChart(
        pixels,
        cell,
        peakCount,
        chartIndex,
      );
      return Object.freeze({
        index: chartIndex,
        row,
        column,
        peakCount,
        expectedValleyCount: Math.max(0, peakCount - 1),
        cellBounds: Object.freeze(cell),
        bounds: chart.bounds,
        plotBounds: chart.plotBounds,
      });
    },
  );

  const bytes = encodePng({
    width: WIDTH,
    height: HEIGHT,
    channels: 3,
    depth: 8,
    data: pixels,
  });
  return Object.freeze({
    name: "hybrid-unequal-merged-header-4x5-table",
    width: WIDTH,
    height: HEIGHT,
    channels: 3,
    pixels,
    bytes,
    mimeType: "image/png",
    tableBounds: TABLE,
    rowEdges: ROW_EDGES,
    columnEdges: COLUMN_EDGES,
    charts: Object.freeze(charts),
    expectedChartCount: charts.length,
  });
}

function clearExactCurveColors(pixels, bounds) {
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const pixelOffset = offset(x, y);
      if (
        CURVE_COLORS.some(
          (color) =>
            pixels[pixelOffset] === color[0] &&
            pixels[pixelOffset + 1] === color[1] &&
            pixels[pixelOffset + 2] === color[2],
        )
      ) {
        pixels[pixelOffset] = COLORS.paper[0];
        pixels[pixelOffset + 1] = COLORS.paper[1];
        pixels[pixelOffset + 2] = COLORS.paper[2];
      }
    }
  }
}

function drawFarSeparatedLobes(pixels, bounds) {
  const span = bounds.right - bounds.left;
  const centers = [
    bounds.left + span * 0.18,
    bounds.left + span * 0.82,
  ];
  const halfWidth = span * 0.12;
  const baseline = bounds.bottom - 7;
  const peak = bounds.top + 12;
  for (const center of centers) {
    let previous;
    for (
      let x = Math.round(center - halfWidth);
      x <= Math.round(center + halfWidth);
      x += 1
    ) {
      const normalized =
        (x - center) / Math.max(1, halfWidth);
      const response =
        Math.cos((normalized * Math.PI) / 2) ** 2;
      const y = Math.round(
        baseline - response * (baseline - peak),
      );
      if (previous) {
        drawLine(
          pixels,
          previous.x,
          previous.y,
          x,
          y,
          COLORS.blue,
          2,
        );
      }
      previous = { x, y };
    }
  }
}

/**
 * Cross-case sentinel: one table cell contains two disconnected Gaussian
 * lobes whose empty valley spans well over 18% of the plot width. They are
 * still one physical distribution because one independent chart frame owns
 * both lobes.
 */
export function hybridTableFarSeparatedPeakFixture() {
  const base = hybridTableWaveformFixture();
  const pixels = base.pixels.slice();
  const target = base.charts[0];
  clearExactCurveColors(pixels, target.plotBounds);
  drawFarSeparatedLobes(pixels, target.plotBounds);
  const charts = base.charts.map((chart) =>
    chart === target
      ? Object.freeze({
          ...chart,
          peakCount: 2,
          expectedValleyCount: 1,
          disconnectedLobes: true,
        })
      : chart,
  );
  const bytes = encodePng({
    width: base.width,
    height: base.height,
    channels: base.channels,
    depth: 8,
    data: pixels,
  });
  return Object.freeze({
    ...base,
    name: "hybrid-table-far-separated-two-peak-cell",
    pixels,
    bytes,
    charts: Object.freeze(charts),
    farSeparatedTarget: charts[0],
  });
}

/**
 * The same strict two-lobe chart is the only waveform in the table. Empty
 * framed cells, prose, numeric content and shapes remain present so the
 * detector cannot rely on a surrounding waveform cohort.
 */
export function isolatedTableFarSeparatedPeakFixture() {
  const base = hybridTableFarSeparatedPeakFixture();
  const pixels = base.pixels.slice();
  for (const chart of base.charts.slice(1)) {
    clearExactCurveColors(pixels, chart.plotBounds);
  }
  const target = Object.freeze({
    ...base.farSeparatedTarget,
    index: 0,
  });
  const bytes = encodePng({
    width: base.width,
    height: base.height,
    channels: base.channels,
    depth: 8,
    data: pixels,
  });
  return Object.freeze({
    ...base,
    name: "isolated-table-far-separated-two-peak-cell",
    pixels,
    bytes,
    charts: Object.freeze([target]),
    farSeparatedTarget: target,
    expectedChartCount: 1,
  });
}

export function hybridTableMultipleFarSeparatedPeakFixture() {
  const base = hybridTableWaveformFixture();
  const pixels = base.pixels.slice();
  const targetIndexes = new Set([0, 1, 2]);
  const charts = base.charts.map((chart, index) => {
    if (!targetIndexes.has(index)) return chart;
    clearExactCurveColors(pixels, chart.plotBounds);
    drawFarSeparatedLobes(pixels, chart.plotBounds);
    return Object.freeze({
      ...chart,
      peakCount: 2,
      expectedValleyCount: 1,
      disconnectedLobes: true,
    });
  });
  const bytes = encodePng({
    width: base.width,
    height: base.height,
    channels: base.channels,
    depth: 8,
    data: pixels,
  });
  return Object.freeze({
    ...base,
    name: "hybrid-table-three-far-separated-two-peak-cells",
    pixels,
    bytes,
    charts: Object.freeze(charts),
    farSeparatedTargets: Object.freeze(
      charts.filter((_, index) => targetIndexes.has(index)),
    ),
  });
}

/**
 * The complete hybrid table occupies the left half of a wider office slide.
 * Its physical chart pixels and topology are unchanged; only unrelated white
 * document space is added on the right.
 */
export function leftHalfHybridTableMultipleFarSeparatedPeakFixture() {
  const base =
    hybridTableMultipleFarSeparatedPeakFixture();
  const width = base.width * 2;
  const height = base.height;
  const pixels = new Uint8Array(width * height * 3);
  pixels.fill(255);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * base.width * 3;
    const targetStart = y * width * 3;
    pixels.set(
      base.pixels.subarray(
        sourceStart,
        sourceStart + base.width * 3,
      ),
      targetStart,
    );
  }
  const bytes = encodePng({
    width,
    height,
    channels: base.channels,
    depth: 8,
    data: pixels,
  });
  return Object.freeze({
    ...base,
    name:
      "left-half-hybrid-table-three-far-separated-" +
      "two-peak-cells",
    width,
    height,
    pixels,
    bytes,
    occupiedBounds: Object.freeze({
      left: 0,
      top: 0,
      right: base.width - 1,
      bottom: base.height - 1,
    }),
  });
}

/**
 * Only three cells remain VTH distributions. The other five physical frames
 * contain smooth three-cycle KPI sine traces that float into and out of the
 * middle of each plot instead of terminating at log-density floors.
 */
export function leftHalfHybridTableVthAndKpiFixture() {
  const base =
    hybridTableMultipleFarSeparatedPeakFixture();
  const sourcePixels = base.pixels.slice();
  const kpiCharts = base.charts.slice(3);
  for (
    let chartIndex = 0;
    chartIndex < kpiCharts.length;
    chartIndex += 1
  ) {
    const chart = kpiCharts[chartIndex];
    clearExactCurveColors(
      sourcePixels,
      chart.plotBounds,
    );
    const bounds = chart.plotBounds;
    const color =
      CURVE_COLORS[
        (chartIndex + 3) % CURVE_COLORS.length
      ];
    let previous = null;
    for (
      let x = bounds.left + 2;
      x <= bounds.right - 2;
      x += 1
    ) {
      const progress =
        (x - bounds.left - 2) /
        Math.max(1, bounds.right - bounds.left - 4);
      const current = {
        x,
        y: Math.round(
          (bounds.top + bounds.bottom) / 2 +
            Math.sin(progress * Math.PI * 6) *
              (bounds.bottom - bounds.top) *
              0.27,
        ),
      };
      if (previous) {
        drawLine(
          sourcePixels,
          previous.x,
          previous.y,
          current.x,
          current.y,
          color,
          2,
        );
      }
      previous = current;
    }
  }

  const width = base.width * 2;
  const height = base.height;
  const pixels = new Uint8Array(width * height * 3);
  pixels.fill(255);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * base.width * 3;
    pixels.set(
      sourcePixels.subarray(
        sourceStart,
        sourceStart + base.width * 3,
      ),
      y * width * 3,
    );
  }
  const bytes = encodePng({
    width,
    height,
    channels: base.channels,
    depth: 8,
    data: pixels,
  });
  const charts = Object.freeze(base.charts.slice(0, 3));
  return Object.freeze({
    ...base,
    name: "left-half-hybrid-table-vth-3-kpi-sine-5",
    width,
    height,
    pixels,
    bytes,
    charts,
    kpiCharts: Object.freeze(kpiCharts),
    expectedChartCount: charts.length,
    occupiedBounds: Object.freeze({
      left: 0,
      top: 0,
      right: base.width - 1,
      bottom: base.height - 1,
    }),
  });
}

function drawModerateFloorWaveform(
  pixels,
  bounds,
  peakCount,
  chartIndex,
) {
  const color =
    CURVE_COLORS[chartIndex % CURVE_COLORS.length];
  const centers =
    peakCount === 1
      ? [0.5]
      : Array.from(
          { length: peakCount },
          (_value, peakIndex) =>
            0.14 +
            (peakIndex / Math.max(1, peakCount - 1)) *
              0.72,
        );
  const amplitudes = centers.map(
    (_center, peakIndex) =>
      0.88 + ((peakIndex + chartIndex) % 3) * 0.05,
  );
  const sigma = Math.max(
    0.024,
    Math.min(0.085, 0.24 / Math.max(1, peakCount)),
  );
  const endpointFloor = 0.46;
  let previous = null;

  for (let x = bounds.left; x <= bounds.right; x += 1) {
    const progress =
      (x - bounds.left) /
      Math.max(1, bounds.right - bounds.left);
    let response;
    if (progress <= centers[0]) {
      const phase =
        progress / Math.max(1e-6, centers[0]);
      response =
        endpointFloor +
        (amplitudes[0] - endpointFloor) *
          Math.sin((phase * Math.PI) / 2) ** 2;
    } else if (progress >= centers.at(-1)) {
      const phase =
        (1 - progress) /
        Math.max(1e-6, 1 - centers.at(-1));
      response =
        endpointFloor +
        (amplitudes.at(-1) - endpointFloor) *
          Math.sin((phase * Math.PI) / 2) ** 2;
    } else {
      response = Math.max(
        ...centers.map(
          (center, peakIndex) =>
            amplitudes[peakIndex] *
            Math.exp(
              -0.5 *
                ((progress - center) / sigma) ** 2,
            ),
        ),
      );
    }
    const y = Math.round(
      bounds.bottom -
        Math.min(1, response) *
          (bounds.bottom - bounds.top) *
          0.82,
    );
    const current = { x, y };
    if (previous) {
      drawLine(
        pixels,
        previous.x,
        previous.y,
        current.x,
        current.y,
        color,
        2,
      );
    }
    previous = current;
  }
}

/**
 * All eight framed cells are real VTH distributions. The first three keep
 * deep density-floor endpoints, while the remaining five have physical
 * monotone tails that terminate at a moderate normalized height. Those five
 * still contain directly observed peaks, deep intervening valleys and pixels
 * reaching the plot floor, so they satisfy the general VTH contract without
 * satisfying its stricter localized endpoint-floor gate.
 */
export function leftHalfHybridTableDeepAndModerateVthFixture() {
  const base = hybridTableWaveformFixture();
  const sourcePixels = base.pixels.slice();
  const deepChartIndexes = new Set([0, 6, 7]);
  const charts = Object.freeze(
    base.charts.map((chart, chartIndex) => {
      clearExactCurveColors(
        sourcePixels,
        chart.plotBounds,
      );
      if (deepChartIndexes.has(chartIndex)) {
        drawFarSeparatedLobes(
          sourcePixels,
          chart.plotBounds,
        );
        return Object.freeze({
          ...chart,
          peakCount: 2,
          expectedValleyCount: 1,
          disconnectedLobes: true,
          expectedContractClass: "localized",
        });
      }
      drawModerateFloorWaveform(
        sourcePixels,
        chart.plotBounds,
        chart.peakCount,
        chartIndex,
      );
      return Object.freeze({
        ...chart,
        expectedContractClass: "accepted-only",
      });
    }),
  );
  const deepCharts = Object.freeze(
    charts.filter(
      ({ expectedContractClass }) =>
        expectedContractClass === "localized",
    ),
  );
  const moderateCharts = Object.freeze(
    charts.filter(
      ({ expectedContractClass }) =>
        expectedContractClass === "accepted-only",
    ),
  );

  const width = base.width * 2;
  const height = base.height;
  const pixels = new Uint8Array(
    width * height * base.channels,
  );
  pixels.fill(255);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * base.width * base.channels;
    pixels.set(
      sourcePixels.subarray(
        sourceStart,
        sourceStart + base.width * base.channels,
      ),
      y * width * base.channels,
    );
  }
  const bytes = encodePng({
    width,
    height,
    channels: base.channels,
    depth: 8,
    data: pixels,
  });
  return Object.freeze({
    ...base,
    name:
      "left-half-hybrid-table-vth-3-deep-" +
      "5-moderate",
    width,
    height,
    pixels,
    bytes,
    charts,
    deepCharts,
    moderateCharts,
    expectedChartCount: charts.length,
    occupiedBounds: Object.freeze({
      left: 0,
      top: 0,
      right: base.width - 1,
      bottom: base.height - 1,
    }),
  });
}

/**
 * The detector's mixed-table proof changes strategy when the detected
 * document lattice occupies 72% of the image. Keep the physical table,
 * three VTH distributions and five framed KPI sine traces byte-identical,
 * and vary only the amount of white slide space to exercise both sides of
 * that gate.
 *
 * The axis-aligned lattice inferred from this fixture is 1369 x 720 pixels.
 * Integer canvas widths therefore approximate 71%, 72% and 73% to within
 * 0.02 percentage points without resampling any source pixels.
 */
export function hybridTableVthAndKpiLatticeBoundaryFixtures() {
  const base = leftHalfHybridTableVthAndKpiFixture();
  const variants = [
    { targetLatticeRatio: 0.71, width: 1928 },
    { targetLatticeRatio: 0.72, width: 1902 },
    { targetLatticeRatio: 0.73, width: 1875 },
  ];

  return Object.freeze(
    variants.map(({ targetLatticeRatio, width }) => {
      const pixels = new Uint8Array(
        width * base.height * base.channels,
      );
      pixels.fill(255);
      for (let y = 0; y < base.height; y += 1) {
        const sourceStart =
          y * base.width * base.channels;
        const targetStart = y * width * base.channels;
        pixels.set(
          base.pixels.subarray(
            sourceStart,
            sourceStart + width * base.channels,
          ),
          targetStart,
        );
      }
      const bytes = encodePng({
        width,
        height: base.height,
        channels: base.channels,
        depth: 8,
        data: pixels,
      });
      return Object.freeze({
        ...base,
        name:
          `hybrid-table-vth-3-kpi-5-lattice-` +
          `${Math.round(targetLatticeRatio * 100)}pct`,
        targetLatticeRatio,
        width,
        pixels,
        bytes,
      });
    }),
  );
}
