import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { encode as encodePng } from "fast-png";

import {
  detectChartPanels,
} from "../lib/vth-chart-panel-core.mjs";
import {
  searchSimilarityImage,
} from "../lib/vth-similarity-api-core.mjs";
import {
  largeTextOnlyFixtures,
} from "./helpers/large-text-waveform-fixtures.mjs";
import {
  tinyColoredTableFixture,
} from "./helpers/tiny-multichart-fixtures.mjs";

const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

const WHITE = [255, 255, 255];
const FRAME = [28, 32, 38];
const GRID = [220, 224, 230];
const CURVES = [
  [18, 105, 212],
  [213, 52, 45],
  [31, 145, 72],
  [136, 76, 194],
];

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
      for (
        let localX = -radius;
        localX <= radius;
        localX += 1
      ) {
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

function chartGridFixture({
  width,
  height,
  count,
  angles,
  varied = false,
  jitter = false,
}) {
  const canvas = {
    width,
    height,
    channels: 3,
    pixels: new Uint8Array(width * height * 3).fill(
      WHITE[0],
    ),
  };
  const charts = [];
  const rows = count === 4 ? 2 : 3;
  const columns = count === 4 ? 2 : 4;
  const gap = count === 4 ? 8 : 12;
  const margin = Math.max(
    2,
    Math.round(Math.min(width, height) * 0.018),
  );
  const cellWidth =
    (width - margin * 2 - (columns - 1) * gap) / columns;
  const cellHeight =
    (height - margin * 2 - (rows - 1) * gap) / rows;
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const scale = varied
      ? [0.56, 0.72, 0.9, 0.64, 0.82][index % 5]
      : angles.some((angle) => angle !== 0)
        ? 0.72
        : 0.9;
    const plotWidth = Math.max(
      18,
      Math.floor(cellWidth * scale),
    );
    const plotHeight = Math.max(
      14,
      Math.floor(cellHeight * scale),
    );
    const patch = cropInk(
      rotatePatch(
        chartSource(
          plotWidth,
          plotHeight,
          index % 5 === 0 ? 1 : 4 + (index % 3),
          index,
        ),
        angles[index % angles.length],
      ),
    );
    const jitterX = jitter
      ? (((index * 37) % 101) / 100 - 0.5) *
        Math.min(cellWidth * 0.7, gap + cellWidth * 0.14)
      : 0;
    const jitterY = jitter
      ? (((index * 61) % 97) / 96 - 0.5) *
        Math.min(cellHeight * 0.7, gap + cellHeight * 0.14)
      : 0;
    const left = Math.round(
      margin +
        column * (cellWidth + gap) +
        (cellWidth - patch.width) / 2 +
        jitterX,
    );
    const top = Math.round(
      margin +
        row * (cellHeight + gap) +
        (cellHeight - patch.height) / 2 +
        jitterY,
    );
    blitInk(canvas, patch, left, top);
    charts.push({
      left,
      top,
      right: left + patch.width - 1,
      bottom: top + patch.height - 1,
      peakCount: index % 5 === 0 ? 1 : 4 + (index % 3),
      expectedValleyCount:
        index % 5 === 0 ? 0 : 3 + (index % 3),
    });
  }
  return { ...canvas, charts };
}

const TITLE_GLYPHS = Object.freeze([
  ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  ["10001", "10001", "01010", "01010", "00100", "00100", "00100"],
]);

function drawLargeTitle(pixels, width, height, left, top) {
  const scale = 6;
  const glyphGap = 14;
  let cursor = left;
  for (const glyph of TITLE_GLYPHS) {
    for (let row = 0; row < glyph.length; row += 1) {
      for (
        let column = 0;
        column < glyph[row].length;
        column += 1
      ) {
        if (glyph[row][column] !== "1") continue;
        for (let localY = 0; localY < scale; localY += 1) {
          drawLine(
            pixels,
            width,
            height,
            cursor + column * scale,
            top + row * scale + localY,
            cursor + (column + 1) * scale - 1,
            top + row * scale + localY,
            FRAME,
          );
        }
      }
    }
    cursor += glyph[0].length * scale + glyphGap;
  }
}

function drawOutsideCard(pixels, width, height, bounds) {
  for (let inset = 0; inset < 3; inset += 1) {
    drawLine(
      pixels,
      width,
      height,
      bounds.left + inset,
      bounds.top + inset,
      bounds.right - inset,
      bounds.top + inset,
      FRAME,
    );
    drawLine(
      pixels,
      width,
      height,
      bounds.left + inset,
      bounds.bottom - inset,
      bounds.right - inset,
      bounds.bottom - inset,
      FRAME,
    );
    drawLine(
      pixels,
      width,
      height,
      bounds.left + inset,
      bounds.top + inset,
      bounds.left + inset,
      bounds.bottom - inset,
      FRAME,
    );
    drawLine(
      pixels,
      width,
      height,
      bounds.right - inset,
      bounds.top + inset,
      bounds.right - inset,
      bounds.bottom - inset,
      FRAME,
    );
  }
  for (const ratio of [0.27, 0.55, 0.78]) {
    const y = Math.round(
      bounds.top + (bounds.bottom - bounds.top) * ratio,
    );
    drawLine(
      pixels,
      width,
      height,
      bounds.left + 18,
      y,
      bounds.right - 24 - Math.round(ratio * 18),
      y,
      FRAME,
      3,
    );
  }
}

function chartGridWithOutsideDistractorsFixture() {
  const board = chartGridFixture({
    width: 800,
    height: 450,
    count: 4,
    angles: [0],
  });
  const width = 1120;
  const height = 630;
  const boardOffset = { x: 38, y: 138 };
  const pixels = new Uint8Array(width * height * 3).fill(255);
  for (let y = 0; y < board.height; y += 1) {
    const sourceStart = y * board.width * board.channels;
    const targetStart =
      ((boardOffset.y + y) * width + boardOffset.x) * 3;
    pixels.set(
      board.pixels.subarray(
        sourceStart,
        sourceStart + board.width * board.channels,
      ),
      targetStart,
    );
  }
  drawLargeTitle(pixels, width, height, 55, 42);
  const cardBounds = Object.freeze({
    left: 900,
    top: 184,
    right: 1081,
    bottom: 424,
  });
  drawOutsideCard(
    pixels,
    width,
    height,
    cardBounds,
  );
  const charts = board.charts.map((chart) => ({
    ...chart,
    left: chart.left + boardOffset.x,
    top: chart.top + boardOffset.y,
    right: chart.right + boardOffset.x,
    bottom: chart.bottom + boardOffset.y,
  }));
  return {
    name: "physical-2x2-board-with-title-and-card",
    width,
    height,
    channels: 3,
    pixels,
    bytes: encodePng({
      width,
      height,
      channels: 3,
      depth: 8,
      data: pixels,
    }),
    mimeType: "image/png",
    charts,
    distractors: Object.freeze([
      Object.freeze({
        kind: "large-title",
        bounds: Object.freeze({
          left: 55,
          top: 42,
          right: 173,
          bottom: 83,
        }),
      }),
      Object.freeze({
        kind: "outlined-card",
        bounds: cardBounds,
      }),
    ]),
  };
}

function chartGridWithExternalWaveformFixture() {
  const board = chartGridFixture({
    width: 800,
    height: 450,
    count: 4,
    angles: [0],
  });
  const width = 1160;
  const height = 720;
  const boardOffset = { x: 30, y: 28 };
  const pixels = new Uint8Array(width * height * 3).fill(255);
  for (let y = 0; y < board.height; y += 1) {
    const sourceStart = y * board.width * board.channels;
    const targetStart =
      ((boardOffset.y + y) * width + boardOffset.x) * 3;
    pixels.set(
      board.pixels.subarray(
        sourceStart,
        sourceStart + board.width * board.channels,
      ),
      targetStart,
    );
  }
  const externalPatch = cropInk(
    chartSource(230, 140, 3, 19),
  );
  const externalLeft = 900;
  const externalTop = 545;
  blitInk(
    { width, height, pixels },
    externalPatch,
    externalLeft,
    externalTop,
  );
  const charts = [
    ...board.charts.map((chart) => ({
      ...chart,
      left: chart.left + boardOffset.x,
      top: chart.top + boardOffset.y,
      right: chart.right + boardOffset.x,
      bottom: chart.bottom + boardOffset.y,
      cohort: "2x2-lattice",
    })),
    {
      left: externalLeft,
      top: externalTop,
      right: externalLeft + externalPatch.width - 1,
      bottom: externalTop + externalPatch.height - 1,
      peakCount: 3,
      expectedValleyCount: 2,
      cohort: "independent",
    },
  ];
  return {
    name: "physical-2x2-board-with-external-waveform",
    width,
    height,
    channels: 3,
    pixels,
    bytes: encodePng({
      width,
      height,
      channels: 3,
      depth: 8,
      data: pixels,
    }),
    mimeType: "image/png",
    charts,
  };
}

function boundsArea(bounds) {
  return (
    (bounds.right - bounds.left + 1) *
    (bounds.bottom - bounds.top + 1)
  );
}

function intersectionArea(first, second) {
  return (
    Math.max(
      0,
      Math.min(first.right, second.right) -
        Math.max(first.left, second.left) +
        1,
    ) *
    Math.max(
      0,
      Math.min(first.bottom, second.bottom) -
        Math.max(first.top, second.top) +
        1,
    )
  );
}

function center(bounds) {
  return {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  };
}

function maximumPhysicalMatching(actual, expected) {
  const adjacency = expected.map((expectedBounds) => {
    const expectedCenter = center(expectedBounds);
    const expectedArea = boundsArea(expectedBounds);
    const minimumDimension = Math.min(
      expectedBounds.right - expectedBounds.left + 1,
      expectedBounds.bottom - expectedBounds.top + 1,
    );
    return actual
      .map((actualBounds, actualIndex) => {
        const actualCenter = center(actualBounds);
        const overlap = intersectionArea(
          actualBounds,
          expectedBounds,
        );
        const centerDistance = Math.hypot(
          actualCenter.x - expectedCenter.x,
          actualCenter.y - expectedCenter.y,
        );
        return {
          actualIndex,
          valid:
            overlap / Math.max(1, expectedArea) >= 0.52 &&
            centerDistance <=
              Math.max(8, minimumDimension * 0.32),
          overlap,
          centerDistance,
        };
      })
      .filter(({ valid }) => valid)
      .sort(
        (first, second) =>
          second.overlap - first.overlap ||
          first.centerDistance - second.centerDistance,
      );
  });
  const expectedForActual = new Array(actual.length).fill(-1);
  function assign(expectedIndex, visited) {
    for (const { actualIndex } of adjacency[expectedIndex]) {
      if (visited.has(actualIndex)) continue;
      visited.add(actualIndex);
      if (
        expectedForActual[actualIndex] === -1 ||
        assign(expectedForActual[actualIndex], visited)
      ) {
        expectedForActual[actualIndex] = expectedIndex;
        return true;
      }
    }
    return false;
  }
  let matchedCount = 0;
  for (
    let expectedIndex = 0;
    expectedIndex < expected.length;
    expectedIndex += 1
  ) {
    if (assign(expectedIndex, new Set())) matchedCount += 1;
  }
  return {
    matchedCount,
    unmatchedActualCount: expectedForActual.filter(
      (expectedIndex) => expectedIndex === -1,
    ).length,
  };
}

function assertPhysicalPanelMatching(detected, fixture, context) {
  const matching = maximumPhysicalMatching(
    detected.panels,
    fixture.charts,
  );
  assert.equal(
    matching.matchedCount,
    fixture.charts.length,
    `${context}: every returned crop must cover its physical source chart`,
  );
  assert.equal(
    matching.unmatchedActualCount,
    0,
    `${context}: no grid-cell placeholder may replace a physical chart crop`,
  );
}

test("recovers uniform and mixed three-degree repeated chart boards without whole-image fallback", () => {
  for (const angles of [[-3], [3], [-3, 0, 3]]) {
    const fixture = chartGridFixture({
      width: 1280,
      height: 720,
      count: 12,
      angles,
      varied: angles.length > 1,
      jitter: angles.length > 1,
    });
    const detected = detectChartPanels(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
    );
    assert.equal(
      detected.panels.length,
      12,
      `${angles.join(",")} degree chart board must retain all cells`,
    );
    assert.equal(detected.fallbackUsed, false);
    assertPhysicalPanelMatching(
      detected,
      fixture,
      `${angles.join(",")} degree chart board`,
    );
    assert.equal(
      detected.diagnostics.smallAngleRepeatedGridRecovery
        .applied,
      true,
    );
    assert.ok(
      detected.panels.every(
        (panel) =>
          panel.detectionReason ===
          "small-angle-repeated-waveform-grid",
      ),
    );
  }
});

test("uses a strict physical 2 by 2 waveform cohort across formerly non-monotonic raster sizes", () => {
  for (const [width, height] of [
    [400, 225],
    [800, 450],
    [960, 540],
    [1120, 630],
  ]) {
    const fixture = chartGridFixture({
      width,
      height,
      count: 4,
      angles: [0],
    });
    const detected = detectChartPanels(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
    );
    assert.equal(
      detected.panels.length,
      4,
      `${width}×${height} must retain every physical chart`,
    );
    assertPhysicalPanelMatching(
      detected,
      fixture,
      `${width}×${height} physical 2 by 2 board`,
    );
    assert.equal(detected.fallbackUsed, false);
    assert.equal(
      detected.diagnostics.smallPhysicalWaveformGridProof
        .applied,
      true,
    );
  }
});

test("keeps an exact 2 by 2 waveform board beside a large title and an outlined card", async () => {
  const fixture =
    chartGridWithOutsideDistractorsFixture();
  const detected = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  assert.ok(
    detected.diagnostics.geometricCandidateCount > 4,
    "the title/card fixture must add at least one unrelated geometric candidate",
  );

  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });
  const apiBounds = response.panels.map(
    (panel) => {
      const source = panel.bounds.source;
      return "left" in source
        ? source
        : {
            left: source.x,
            top: source.y,
            right: source.x + source.width - 1,
            bottom: source.y + source.height - 1,
          };
    },
  );
  assert.deepEqual(
    {
      geometricCandidateCount:
        detected.diagnostics.geometricCandidateCount,
      detectorPanelCount: detected.panels.length,
      detectorMatching: maximumPhysicalMatching(
        detected.panels,
        fixture.charts,
      ),
      smallGridProof:
        detected.diagnostics.smallPhysicalWaveformGridProof
          .applied,
      apiPanelCount: response.panelCount,
      apiMatching: maximumPhysicalMatching(
        apiBounds,
        fixture.charts,
      ),
      peakCounts: response.panels.map(
        (panel) =>
          panel.descriptor.peakLocations.length,
      ),
      valleyCounts: response.panels.map(
        (panel) =>
          panel.descriptor.valleyLocations.length,
      ),
      regularized: response.panels.map(
        (panel) => panel.descriptor.regularized,
      ),
    },
    {
      geometricCandidateCount: 5,
      detectorPanelCount: fixture.charts.length,
      detectorMatching: {
        matchedCount: fixture.charts.length,
        unmatchedActualCount: 0,
      },
      smallGridProof: true,
      apiPanelCount: fixture.charts.length,
      apiMatching: {
        matchedCount: fixture.charts.length,
        unmatchedActualCount: 0,
      },
      peakCounts: fixture.charts.map(
        (chart) => chart.peakCount,
      ),
      valleyCounts: fixture.charts.map(
        (chart) => chart.expectedValleyCount,
      ),
      regularized: fixture.charts.map(() => false),
    },
  );
});

test("keeps a 2 by 2 waveform lattice and one independent framed waveform", async () => {
  const fixture =
    chartGridWithExternalWaveformFixture();
  const latticeCharts = fixture.charts.slice(0, 4);
  const latticeBounds = {
    left: Math.min(
      ...latticeCharts.map((chart) => chart.left),
    ),
    top: Math.min(
      ...latticeCharts.map((chart) => chart.top),
    ),
    right: Math.max(
      ...latticeCharts.map((chart) => chart.right),
    ),
    bottom: Math.max(
      ...latticeCharts.map((chart) => chart.bottom),
    ),
  };
  assert.equal(
    intersectionArea(
      latticeBounds,
      fixture.charts.at(-1),
    ),
    0,
    "the fifth waveform must remain physically outside the 2 by 2 lattice",
  );
  const detected = detectChartPanels(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });
  const apiBounds = response.panels.map(
    (panel) => {
      const source = panel.bounds.source;
      return "left" in source
        ? source
        : {
            left: source.x,
            top: source.y,
            right: source.x + source.width - 1,
            bottom: source.y + source.height - 1,
          };
    },
  );
  assert.deepEqual(
    {
      geometricCandidateCount:
        detected.diagnostics.geometricCandidateCount,
      detectorPanelCount: detected.panels.length,
      detectorMatching: maximumPhysicalMatching(
        detected.panels,
        fixture.charts,
      ),
      smallGridProof:
        detected.diagnostics.smallPhysicalWaveformGridProof
          .applied,
      apiPanelCount: response.panelCount,
      apiMatching: maximumPhysicalMatching(
        apiBounds,
        fixture.charts,
      ),
      peakCounts: response.panels.map(
        (panel) =>
          panel.descriptor.peakLocations.length,
      ),
      valleyCounts: response.panels.map(
        (panel) =>
          panel.descriptor.valleyLocations.length,
      ),
      regularized: response.panels.map(
        (panel) => panel.descriptor.regularized,
      ),
    },
    {
      geometricCandidateCount: fixture.charts.length,
      detectorPanelCount: fixture.charts.length,
      detectorMatching: {
        matchedCount: fixture.charts.length,
        unmatchedActualCount: 0,
      },
      smallGridProof: false,
      apiPanelCount: fixture.charts.length,
      apiMatching: {
        matchedCount: fixture.charts.length,
        unmatchedActualCount: 0,
      },
      peakCounts: fixture.charts.map(
        (chart) => chart.peakCount,
      ),
      valleyCounts: fixture.charts.map(
        (chart) => chart.expectedValleyCount,
      ),
      regularized: fixture.charts.map(() => false),
    },
  );
});

test("the narrow recovery paths do not promote colored tables or large text", () => {
  const negatives = [
    tinyColoredTableFixture(),
    ...largeTextOnlyFixtures().slice(0, 2),
  ];
  for (const fixture of negatives) {
    const detected = detectChartPanels(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
    );
    assert.equal(detected.panels.length, 0);
    assert.equal(detected.fallbackUsed, false);
    assert.equal(
      detected.diagnostics.smallAngleRepeatedGridRecovery
        ?.applied ?? false,
      false,
    );
  }
});
