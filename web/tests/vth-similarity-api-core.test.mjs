import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { encode as encodePng } from "fast-png";

import {
  SimilarityApiError,
  parseSimilarityImageRequest,
  searchSimilarityImage,
} from "../lib/vth-similarity-api-core.mjs";
import {
  shadedNumericTablePng,
  sparklineTablePng,
} from "./helpers/table-fixtures.mjs";

const demoQuery = await readFile(
  new URL("../public/demo-query.png", import.meta.url),
);
const pptSample = await readFile(
  new URL(
    "../public/samples/vnand-ppt-12-chart-sample.png",
    import.meta.url,
  ),
);
const mixedRandomSample = await readFile(
  new URL(
    "../public/samples/vnand-random-multichart-mixed-01.png",
    import.meta.url,
  ),
);
const variableSizeRandomSample = await readFile(
  new URL(
    "../public/samples/vnand-random-multichart-mixed-02.png",
    import.meta.url,
  ),
);
const framelessRandomSample = await readFile(
  new URL(
    "../public/samples/vnand-random-multichart-frameless-04.png",
    import.meta.url,
  ),
);
const corpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

function assertTrainingWaveform(profile, descriptor) {
  assert.equal(profile.length, 256);
  assert.ok(profile.every(Number.isFinite));
  assert.equal(descriptor.stateCount, descriptor.peakLocations.length);
  assert.equal(descriptor.peakWidths.length, descriptor.stateCount);
  assert.equal(
    descriptor.valleyLocations.length,
    descriptor.stateCount - 1,
  );
  assert.equal(
    descriptor.valleyHeights.length,
    descriptor.stateCount - 1,
  );
  assert.equal(
    descriptor.valleyDepths.length,
    descriptor.stateCount - 1,
  );
  assert.equal(
    descriptor.valleyPositionRatios.length,
    descriptor.stateCount - 1,
  );
  assert.equal(
    descriptor.peakValleyDistances.length,
    (descriptor.stateCount - 1) * 2,
  );
  assert.equal(descriptor.tailSlopes.length, 2);
}

function drawLine(rgb, width, height, x1, y1, x2, y2, thickness = 1) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let localY = y; localY < y + thickness; localY += 1) {
      for (let localX = x; localX < x + thickness; localX += 1) {
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

function drawChart(rgb, width, height, left, top, right, bottom, phase) {
  drawLine(rgb, width, height, left, top, right, top, 2);
  drawLine(rgb, width, height, left, bottom, right, bottom, 2);
  drawLine(rgb, width, height, left, top, left, bottom, 2);
  drawLine(rgb, width, height, right, top, right, bottom, 2);
  const center = (top + bottom) / 2;
  const amplitude = (bottom - top) * 0.3;
  for (let x = left + 8; x <= right - 8; x += 1) {
    const progress = (x - left) / Math.max(1, right - left);
    const y = Math.round(
      center -
        amplitude *
          (0.62 * Math.sin(progress * Math.PI * 5 + phase) +
            0.22 * Math.sin(progress * Math.PI * 11)),
    );
    drawLine(rgb, width, height, x, y, x + 1, y, 2);
  }
}

function twoPanelPng() {
  const width = 560;
  const height = 290;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  drawChart(rgb, width, height, 22, 42, 252, 258, 0);
  drawChart(rgb, width, height, 300, 28, 538, 244, 0.8);
  return encodePng({
    width,
    height,
    data: rgb,
    channels: 3,
    depth: 8,
  });
}

function nonDistributionCompositePng() {
  const width = 640;
  const height = 360;
  const rgb = new Uint8Array(width * height * 3).fill(255);

  // Dense table.
  for (let column = 0; column <= 6; column += 1) {
    const x = 24 + column * 48;
    drawLine(rgb, width, height, x, 34, x, 178, 2);
  }
  for (let row = 0; row <= 4; row += 1) {
    const y = 34 + row * 36;
    drawLine(rgb, width, height, 24, y, 312, y, 2);
  }

  // Empty coordinate system with ticks but no distribution trace.
  drawLine(rgb, width, height, 366, 34, 366, 178, 2);
  drawLine(rgb, width, height, 366, 178, 612, 178, 2);
  for (let index = 1; index <= 4; index += 1) {
    const x = 366 + index * 48;
    drawLine(rgb, width, height, x, 174, x, 182, 2);
  }
  for (let index = 1; index <= 3; index += 1) {
    const y = 178 - index * 36;
    drawLine(rgb, width, height, 362, y, 370, y, 2);
  }

  // Flow-chart boxes and straight connectors.
  const boxes = [
    [40, 232, 144, 304],
    [258, 218, 382, 292],
    [492, 238, 604, 316],
  ];
  for (const [left, top, right, bottom] of boxes) {
    drawLine(rgb, width, height, left, top, right, top, 2);
    drawLine(rgb, width, height, left, bottom, right, bottom, 2);
    drawLine(rgb, width, height, left, top, left, bottom, 2);
    drawLine(rgb, width, height, right, top, right, bottom, 2);
    for (let line = 0; line < 3; line += 1) {
      const y = top + 18 + line * 14;
      drawLine(rgb, width, height, left + 16, y, right - 16, y, 2);
    }
  }
  drawLine(rgb, width, height, 144, 268, 258, 255, 2);
  drawLine(rgb, width, height, 382, 255, 492, 277, 2);

  return encodePng({
    width,
    height,
    data: rgb,
    channels: 3,
    depth: 8,
  });
}

function singleDistributionWithDistractorsPng() {
  const width = 760;
  const height = 420;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const left = 24;
  const top = 42;
  const right = 364;
  const bottom = 366;
  drawLine(rgb, width, height, left, top, right, top, 2);
  drawLine(rgb, width, height, left, bottom, right, bottom, 2);
  drawLine(rgb, width, height, left, top, left, bottom, 2);
  drawLine(rgb, width, height, right, top, right, bottom, 2);

  let previous = null;
  for (let x = left + 14; x <= right - 14; x += 1) {
    const progress = (x - left - 14) / (right - left - 28);
    const response = Math.max(
      ...[0.13, 0.39, 0.64, 0.87].map((center) => {
        const distance = (progress - center) / 0.07;
        return Math.exp(-0.5 * distance * distance);
      }),
    );
    const y = Math.round(bottom - 18 - response * 244);
    if (previous) {
      drawLine(
        rgb,
        width,
        height,
        previous.x,
        previous.y,
        x,
        y,
        2,
      );
    }
    previous = { x, y };
  }

  // Explanatory table and card outside the real distribution panel.
  for (let column = 0; column <= 5; column += 1) {
    const x = 430 + column * 58;
    drawLine(rgb, width, height, x, 48, x, 228, 2);
  }
  for (let row = 0; row <= 5; row += 1) {
    const y = 48 + row * 36;
    drawLine(rgb, width, height, 430, y, 720, y, 2);
  }
  drawLine(rgb, width, height, 450, 278, 710, 278, 2);
  drawLine(rgb, width, height, 450, 370, 710, 370, 2);
  drawLine(rgb, width, height, 450, 278, 450, 370, 2);
  drawLine(rgb, width, height, 710, 278, 710, 370, 2);
  for (let row = 0; row < 4; row += 1) {
    drawLine(
      rgb,
      width,
      height,
      476,
      298 + row * 16,
      674 - row * 14,
      298 + row * 16,
      2,
    );
  }

  return encodePng({
    width,
    height,
    data: rgb,
    channels: 3,
    depth: 8,
  });
}

function twelvePanelPng() {
  const width = 960;
  const height = 600;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const leftStarts = [24, 264, 504, 744];
  const topStarts = [36, 226, 416];
  for (let row = 0; row < topStarts.length; row += 1) {
    for (let column = 0; column < leftStarts.length; column += 1) {
      const left = leftStarts[column] + (row % 2) * 3;
      const top = topStarts[row] + (column % 2) * 4;
      const right = left + 190;
      const bottom = top + 138;
      drawChart(
        rgb,
        width,
        height,
        left,
        top,
        right,
        bottom,
        row * 0.35 + column * 0.2,
      );
      for (const ratio of [1 / 3, 2 / 3]) {
        const y = Math.round(top + (bottom - top) * ratio);
        drawLine(rgb, width, height, left, y, right, y);
      }
      for (const ratio of [0.25, 0.5, 0.75]) {
        const x = Math.round(left + (right - left) * ratio);
        drawLine(rgb, width, height, x, top, x, bottom);
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

function lowResolutionScatteredPanelPng() {
  const width = 320;
  const height = 180;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const charts = [
    [4, 4, 80, 50],
    [117, 12, 198, 61],
    [237, 5, 316, 55],
    [25, 82, 107, 136],
    [143, 72, 230, 126],
    [243, 112, 318, 174],
  ];
  charts.forEach(([left, top, right, bottom], index) => {
    drawChart(
      rgb,
      width,
      height,
      left,
      top,
      right,
      bottom,
      index * 0.31,
    );
  });
  return encodePng({
    width,
    height,
    data: rgb,
    channels: 3,
    depth: 8,
  });
}

test("parses a raw PNG similarity request and query-string topK", async () => {
  const parsed = await parseSimilarityImageRequest(
    new Request(
      "http://127.0.0.1:4173/api/v1/similarity-search?topK=5",
      {
        method: "POST",
        headers: {
          "content-type": "image/png; charset=binary",
        },
        body: demoQuery,
      },
    ),
  );

  assert.equal(parsed.mimeType, "image/png");
  assert.equal(parsed.topK, 5);
  assert.deepEqual(Buffer.from(parsed.bytes), demoQuery);
});

test("parses a JSON data URL similarity request and body topK", async () => {
  const parsed = await parseSimilarityImageRequest(
    new Request("http://127.0.0.1:4173/api/v1/similarity-search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        topK: 3,
        imageDataUrl: `data:image/png;base64,${demoQuery.toString("base64")}`,
      }),
    }),
  );

  assert.equal(parsed.mimeType, "image/png");
  assert.equal(parsed.topK, 3);
  assert.deepEqual(Buffer.from(parsed.bytes), demoQuery);
});

test("parses a multipart image and form topK", async () => {
  const form = new FormData();
  form.append(
    "image",
    new Blob([demoQuery], { type: "image/png" }),
    "query.png",
  );
  form.append("topK", "4");
  const parsed = await parseSimilarityImageRequest(
    new Request("http://127.0.0.1:4173/api/v1/similarity-search", {
      method: "POST",
      body: form,
    }),
  );

  assert.equal(parsed.mimeType, "image/png");
  assert.equal(parsed.topK, 4);
  assert.deepEqual(Buffer.from(parsed.bytes), demoQuery);
});

test("rejects unsupported content types and invalid topK values", async () => {
  await assert.rejects(
    () =>
      parseSimilarityImageRequest(
        new Request("http://127.0.0.1:4173/api/v1/similarity-search", {
          method: "POST",
          headers: {
            "content-type": "image/gif",
          },
          body: new Uint8Array([0x47, 0x49, 0x46]),
        }),
      ),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 415);
      assert.equal(error.code, "unsupported_content_type");
      return true;
    },
  );

  await assert.rejects(
    () =>
      parseSimilarityImageRequest(
        new Request(
          "http://127.0.0.1:4173/api/v1/similarity-search?topK=11",
          {
            method: "POST",
            headers: {
              "content-type": "image/png",
            },
            body: demoQuery,
          },
        ),
      ),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_top_k");
      return true;
    },
  );
});

test("searches the public corpus and returns ordered absolute-URL results", async () => {
  const response = await searchSimilarityImage({
    bytes: demoQuery,
    mimeType: "image/png",
    topK: 5,
    corpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.equal(response.query.mimeType, "image/png");
  assert.equal(response.query.stateCount, 8);
  assert.equal(response.panelCount, 1);
  assert.deepEqual(response.panelLayout, { rows: 1, columns: 1 });
  assert.equal(response.panelDetection.detectedPanelCount, 0);
  assert.ok(response.panelDetection.rejectedNonChartCount >= 1);
  assert.equal(response.panelDetection.analyzedPanelCount, 1);
  assert.equal(response.panelDetection.maxPanels, 30);
  assert.equal(response.panelDetection.truncated, false);
  assert.equal(response.panels.length, 1);
  assert.deepEqual(response.trainingSelection, {
    panelIndex: 0,
    panelCount: 1,
    seriesIndex: 0,
    seriesCount: 1,
  });
  assert.deepEqual(
    response.panels[0].trainingSelection,
    response.trainingSelection,
  );
  assert.deepEqual(
    response.panels[0].series[0].trainingSelection,
    response.trainingSelection,
  );
  assertTrainingWaveform(response.profile, response.descriptor);
  assert.deepEqual(response.panels[0].profile, response.profile);
  assert.deepEqual(response.panels[0].descriptor, response.descriptor);
  assert.deepEqual(
    response.panels[0].series[0].profile,
    response.profile,
  );
  assert.deepEqual(
    response.panels[0].series[0].descriptor,
    response.descriptor,
  );
  assert.deepEqual(response.panels[0].query, response.query);
  assert.deepEqual(response.panels[0].results, response.results);
  assert.equal(response.candidateCount, corpus.candidates.length);
  assert.ok(response.matchedCandidateCount >= response.results.length);
  assert.equal(response.results.length, 5);
  assert.deepEqual(
    response.results.map((result) => result.rank),
    [1, 2, 3, 4, 5],
  );
  assert.equal(new Set(response.results.map((result) => result.id)).size, 5);

  for (let index = 0; index < response.results.length; index += 1) {
    const result = response.results[index];
    assert.ok(result.score >= 0 && result.score <= 1);
    assert.equal(result.stateCount, response.query.stateCount);
    assert.match(
      result.imageUrl,
      /^http:\/\/127\.0\.0\.1:4173\/(?:corpus|api)\//,
    );
    assert.doesNotThrow(() => new URL(result.imageUrl));
    assert.ok(Array.isArray(result.reasons));
    assert.ok(result.reasons.length >= 1);
    if (index > 0) {
      assert.ok(
        response.results[index - 1].score >= result.score,
        "results must be sorted by descending score",
      );
    }
  }
});

test("rejects tables, empty axes, text-like rows, and diagram boxes without a distribution waveform", async () => {
  await assert.rejects(
    () =>
      searchSimilarityImage({
        bytes: nonDistributionCompositePng(),
        mimeType: "image/png",
        topK: 3,
        corpus,
        origin: "http://127.0.0.1:4173",
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "distribution_waveform_not_found");
      assert.match(error.message, /분포 파형/);
      return true;
    },
  );
});

test("rejects a shared-cell table even when one row contains a two-peak sparkline", async () => {
  await assert.rejects(
    () =>
      searchSimilarityImage({
        bytes: sparklineTablePng(),
        mimeType: "image/png",
        topK: 3,
        corpus,
        origin: "http://127.0.0.1:4173",
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "distribution_waveform_not_found");
      return true;
    },
  );
});

test("rejects a shaded numeric table without inventing a whole-image Curve", async () => {
  await assert.rejects(
    () =>
      searchSimilarityImage({
        bytes: shadedNumericTablePng(),
        mimeType: "image/png",
        topK: 3,
        corpus,
        origin: "http://127.0.0.1:4173",
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "distribution_waveform_not_found");
      return true;
    },
  );
});

test("crops one valid distribution away from surrounding table and explanation content", async () => {
  const response = await searchSimilarityImage({
    bytes: singleDistributionWithDistractorsPng(),
    mimeType: "image/png",
    topK: 1,
    corpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.equal(response.panelCount, 1);
  assert.equal(response.panelDetection.fallbackUsed, false);
  assert.ok(response.panelDetection.rejectedNonChartCount >= 1);
  assert.notEqual(
    response.panels[0].detectionReason,
    "whole-image-fallback",
  );
  assert.ok(response.panels[0].bounds.normalized.width < 0.6);
  assert.ok(response.panels[0].bounds.normalized.x < 0.1);
  assert.equal(response.panels[0].results.length, 1);
});

test("separates a multi-chart image and ranks every chart independently", async () => {
  const image = twoPanelPng();
  const response = await searchSimilarityImage({
    bytes: image,
    mimeType: "image/png",
    topK: 3,
    corpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.equal(response.panelCount, 2);
  assert.deepEqual(response.panelLayout, { rows: 1, columns: 2 });
  assert.equal(response.panelDetection.detectedPanelCount, 2);
  assert.equal(response.panelDetection.rejectedNonChartCount, 0);
  assert.equal(response.panelDetection.analyzedPanelCount, 2);
  assert.equal(response.panelDetection.maxPanels, 30);
  assert.equal(response.panelDetection.truncated, false);
  assert.equal(response.panels.length, 2);
  assert.deepEqual(response.query, response.panels[0].query);
  assert.deepEqual(response.results, response.panels[0].results);
  assert.ok(
    response.panels[0].bounds.processed.x <
      response.panels[1].bounds.processed.x,
    "panels must be returned in reading order",
  );

  for (const [index, panel] of response.panels.entries()) {
    assert.equal(panel.panelIndex, index);
    assert.deepEqual(panel.trainingSelection, {
      panelIndex: index,
      panelCount: 2,
      seriesIndex: panel.selectedSeriesIndex,
      seriesCount: panel.seriesCount,
    });
    for (const [seriesIndex, series] of panel.series.entries()) {
      assert.deepEqual(series.trainingSelection, {
        panelIndex: index,
        panelCount: 2,
        seriesIndex,
        seriesCount: panel.seriesCount,
      });
      assertTrainingWaveform(series.profile, series.descriptor);
    }
    const representative = panel.series[panel.selectedSeriesIndex];
    assert.deepEqual(panel.profile, representative.profile);
    assert.deepEqual(panel.descriptor, representative.descriptor);
    assert.ok(panel.confidence > 0.8);
    assert.equal(panel.detectionReason, "closed-plot-frame");
    assert.ok(panel.bounds.processed.width > 200);
    assert.ok(panel.bounds.source.width > 200);
    assert.ok(panel.bounds.normalized.width > 0);
    assert.ok(panel.bounds.normalized.width < 1);
    assert.ok(panel.matchedCandidateCount >= panel.results.length);
    assert.equal(panel.results.length, 3);
    assert.deepEqual(
      panel.results.map((result) => result.rank),
      [1, 2, 3],
    );
  }
});

test("upscales and separates low-resolution charts at scattered coordinates", async () => {
  const response = await searchSimilarityImage({
    bytes: lowResolutionScatteredPanelPng(),
    mimeType: "image/png",
    topK: 1,
    corpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.equal(response.panelCount, 6);
  assert.equal(response.panelDetection.detectedPanelCount, 6);
  assert.equal(response.panelDetection.rejectedNonChartCount, 0);
  assert.equal(response.panelDetection.truncated, false);
  assert.ok(response.panelLayout.rows >= 2);
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.bounds.processed.width >=
          panel.bounds.source.width * 3 &&
        panel.query.processedWidth >=
          panel.bounds.source.width * 3 &&
        panel.results.length === 1,
    ),
    "low-resolution chart detection and Curve analysis should use an enlarged working raster",
  );
});

test("API excludes table, diagram, and photo content from a mixed slide", async () => {
  const response = await searchSimilarityImage({
    bytes: mixedRandomSample,
    mimeType: "image/png",
    topK: 1,
    corpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.equal(response.panelCount, 8);
  assert.equal(response.panelDetection.detectedPanelCount, 8);
  assert.equal(response.panelDetection.analyzedPanelCount, 8);
  assert.ok(response.panelDetection.rejectedNonChartCount >= 1);
  assert.equal(response.panelDetection.truncated, false);
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.query.stateCount >= 4 &&
        panel.results.length === 1,
    ),
  );
});

test("API separates all variable-size charts including a compact single peak", async () => {
  const response = await searchSimilarityImage({
    bytes: variableSizeRandomSample,
    mimeType: "image/png",
    topK: 1,
    corpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.equal(response.panelCount, 8);
  assert.equal(response.panelDetection.detectedPanelCount, 8);
  assert.equal(response.panelDetection.analyzedPanelCount, 8);
  assert.equal(response.panels.length, 8);
  assert.ok(response.panelDetection.rejectedNonChartCount >= 1);
  assert.equal(response.panelDetection.truncated, false);
  assert.ok(
    response.panels.every((panel) => panel.results.length === 1),
  );

  const panelAreas = response.panels.map(
    (panel) =>
      panel.bounds.processed.width *
      panel.bounds.processed.height,
  );
  assert.ok(
    Math.max(...panelAreas) / Math.min(...panelAreas) >= 6,
    "the public sample must exercise substantially different chart sizes",
  );
  assert.ok(
    response.panels.some(
      (panel) =>
        panel.bounds.processed.width <= 150 &&
        panel.bounds.processed.height <= 100,
    ),
    "the compact single-peak chart must survive panel separation",
  );
});

test("API independently ranks chart-only curves without visible panel boundaries", async () => {
  const response = await searchSimilarityImage({
    bytes: framelessRandomSample,
    mimeType: "image/png",
    topK: 1,
    corpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.equal(response.panelCount, 8);
  assert.equal(response.panelDetection.detectedPanelCount, 8);
  assert.equal(response.panelDetection.analyzedPanelCount, 8);
  assert.equal(response.panels.length, 8);
  assert.equal(response.panelDetection.truncated, false);
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.results.length === 1 &&
        panel.bounds.processed.width > 100 &&
        panel.bounds.processed.height > 70,
    ),
    "each frameless Curve must retain an independent crop and ranking",
  );
});

test("returns independent rankings for twelve charts on one PPT slide", async () => {
  const response = await searchSimilarityImage({
    bytes: twelvePanelPng(),
    mimeType: "image/png",
    topK: 1,
    corpus,
    origin: "http://127.0.0.1:4173",
  });

  assert.equal(response.panelCount, 12);
  assert.deepEqual(response.panelLayout, { rows: 3, columns: 4 });
  assert.equal(response.panelDetection.detectedPanelCount, 12);
  assert.equal(response.panelDetection.rejectedNonChartCount, 0);
  assert.equal(response.panelDetection.analyzedPanelCount, 12);
  assert.equal(response.panelDetection.maxPanels, 30);
  assert.equal(response.panelDetection.truncated, false);
  assert.equal(response.panels.length, 12);
  assert.deepEqual(
    response.panels.map((panel) => panel.panelIndex),
    Array.from({ length: 12 }, (_, index) => index),
  );
  for (let row = 0; row < 3; row += 1) {
    const panels = response.panels.slice(row * 4, row * 4 + 4);
    for (let column = 1; column < panels.length; column += 1) {
      assert.ok(
        panels[column - 1].bounds.processed.x <
          panels[column].bounds.processed.x,
      );
    }
    if (row > 0) {
      assert.ok(
        response.panels[(row - 1) * 4].bounds.processed.y <
          response.panels[row * 4].bounds.processed.y,
      );
    }
  }
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.detectionReason === "closed-plot-frame" &&
        panel.results.length === 1,
    ),
  );
});

test("extracts the intended 4/8-State interiors from the public PPT sample", async () => {
  const response = await searchSimilarityImage({
    bytes: pptSample,
    mimeType: "image/png",
    topK: 1,
    corpus,
    origin: "http://127.0.0.1:4173",
  });
  const expectedStateCounts = [
    4, 8, 8, 8,
    4, 8, 8, 8,
    4, 8, 8, 8,
  ];

  assert.equal(response.panelCount, 12);
  assert.deepEqual(response.panelLayout, { rows: 3, columns: 4 });
  assert.deepEqual(
    response.panels.map((panel) => panel.query.stateCount),
    expectedStateCounts,
  );
  assert.deepEqual(
    response.panels.map((panel) => panel.query.observedStateCount),
    expectedStateCounts,
  );
  assert.ok(
    response.panels.every(
      (panel) =>
        panel.query.axisMode === "rectangle" &&
        panel.query.processedWidth >= 300 &&
        panel.query.processedHeight >= 155,
    ),
    "each Curve must be re-analyzed from the source-resolution plot crop",
  );
});
