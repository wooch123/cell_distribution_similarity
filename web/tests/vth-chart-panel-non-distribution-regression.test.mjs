import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decode as decodePng,
  encode as encodePng,
} from "fast-png";

import {
  detectChartPanels,
  detectChartPanelsFromMask,
  measureChartCurveEvidence,
} from "../lib/vth-chart-panel-core.mjs";
import {
  SimilarityApiError,
  searchSimilarityImage,
} from "../lib/vth-similarity-api-core.mjs";

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
  assert.ok(
    elapsedMs < 30000,
    `196-image detector acceptance took ${elapsedMs.toFixed(1)} ms`,
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
