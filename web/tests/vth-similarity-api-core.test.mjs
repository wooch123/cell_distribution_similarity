import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { encode as encodePng } from "fast-png";

import {
  SimilarityApiError,
  parseSimilarityImageRequest,
  searchSimilarityImage,
} from "../lib/vth-similarity-api-core.mjs";

const demoQuery = await readFile(
  new URL("../public/demo-query.png", import.meta.url),
);
const pptSample = await readFile(
  new URL(
    "../public/samples/vnand-ppt-12-chart-sample.png",
    import.meta.url,
  ),
);
const corpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

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
      "https://dove9999.com/api/v1/similarity-search?topK=5",
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
    new Request("https://dove9999.com/api/v1/similarity-search", {
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
    new Request("https://dove9999.com/api/v1/similarity-search", {
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
        new Request("https://dove9999.com/api/v1/similarity-search", {
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
          "https://dove9999.com/api/v1/similarity-search?topK=11",
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
    origin: "https://dove9999.com",
  });

  assert.equal(response.query.mimeType, "image/png");
  assert.equal(response.query.stateCount, 8);
  assert.equal(response.panelCount, 1);
  assert.deepEqual(response.panelLayout, { rows: 1, columns: 1 });
  assert.equal(response.panelDetection.detectedPanelCount, 1);
  assert.equal(response.panelDetection.analyzedPanelCount, 1);
  assert.equal(response.panelDetection.maxPanels, 24);
  assert.equal(response.panelDetection.truncated, false);
  assert.equal(response.panels.length, 1);
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
      /^https:\/\/dove9999\.com\/(?:corpus|api)\//,
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

test("separates a multi-chart image and ranks every chart independently", async () => {
  const image = twoPanelPng();
  const response = await searchSimilarityImage({
    bytes: image,
    mimeType: "image/png",
    topK: 3,
    corpus,
    origin: "https://dove9999.com",
  });

  assert.equal(response.panelCount, 2);
  assert.deepEqual(response.panelLayout, { rows: 1, columns: 2 });
  assert.equal(response.panelDetection.detectedPanelCount, 2);
  assert.equal(response.panelDetection.analyzedPanelCount, 2);
  assert.equal(response.panelDetection.maxPanels, 24);
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
    origin: "https://dove9999.com",
  });

  assert.equal(response.panelCount, 6);
  assert.equal(response.panelDetection.detectedPanelCount, 6);
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

test("returns independent rankings for twelve charts on one PPT slide", async () => {
  const response = await searchSimilarityImage({
    bytes: twelvePanelPng(),
    mimeType: "image/png",
    topK: 1,
    corpus,
    origin: "https://dove9999.com",
  });

  assert.equal(response.panelCount, 12);
  assert.deepEqual(response.panelLayout, { rows: 3, columns: 4 });
  assert.equal(response.panelDetection.detectedPanelCount, 12);
  assert.equal(response.panelDetection.analyzedPanelCount, 12);
  assert.equal(response.panelDetection.maxPanels, 24);
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
    origin: "https://dove9999.com",
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
