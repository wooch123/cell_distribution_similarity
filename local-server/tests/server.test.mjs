import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createVthServer } from "../server.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "../..");
const siteDirectory = path.join(projectRoot, "web", "dist");
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2QAAAAASUVORK5CYII=",
  "base64",
);
const demoQuery = await readFile(
  path.join(projectRoot, "web", "public", "demo-query.png"),
);

function trainingPayload(id = "sample-1") {
  return {
    schemaVersion: 2,
    id,
    label: "Retention sample",
    imageDataUrl: `data:image/png;base64,${tinyPng.toString("base64")}`,
    sourceImageDataUrl: `data:image/png;base64,${tinyPng.toString("base64")}`,
    profile: Array.from({ length: 256 }, (_, index) => index / 255),
    descriptor: {
      stateCount: 8,
      observedStateCount: 8,
      regularized: false,
      peakLocations: [0.1, 0.2],
      peakWidths: [0.04, 0.05],
      valleyHeights: [0.8],
      valleyLocations: [0.15],
      valleyDepths: [0.12],
      valleyPositionRatios: [0.5],
      peakValleyDistances: [0.05, 0.05],
      tailSlopes: [0.02, 0.02],
      area: 0.73,
    },
    metadata: {
      learnedAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

async function startServer(options = {}) {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "vth-training-api-"),
  );
  const { server } = await createVthServer({
    rootDirectory: projectRoot,
    siteDirectory,
    dataDirectory,
    ...options,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    dataDirectory,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
}

function postChunkedOversize(url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    request.once("error", reject);
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    for (let index = 0; index < 21; index += 1) request.write(chunk);
    request.end();
  });
}

test("serves the web app and persists ready and pending training images", async () => {
  const running = await startServer();
  try {
    const page = await fetch(`${running.baseUrl}/`);
    assert.equal(page.status, 200);
    assert.equal(
      page.headers.get("x-vth-network-mode"),
      "offline-loopback-only",
    );
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /connect-src 'self' blob:/,
    );
    assert.match(await page.text(), /<title>유사 산포 검색<\/title>/);

    const runtime = await fetch(
      `${running.baseUrl}/api/v1/runtime`,
    ).then((response) => response.json());
    assert.equal(runtime.mode, "standalone-offline");
    assert.equal(runtime.externalNetworkAllowed, false);
    assert.equal(runtime.corpusBundled, true);
    assert.equal(runtime.modelBundled, true);
    assert.equal(runtime.sharedApiEnabled, false);

    const similarityCapability = await fetch(
      `${running.baseUrl}/api/v1/similarity-search`,
    ).then((response) => response.json());
    assert.equal(similarityCapability.multiChart.supported, true);
    assert.equal(similarityCapability.multiChart.ranking, "per-panel");
    assert.equal(similarityCapability.multiChart.maxPanels, 24);
    assert.equal(
      similarityCapability.multiChart.overflowPolicy,
      "highest-confidence-then-reading-order",
    );

    const initialHealth = await fetch(
      `${running.baseUrl}/api/v1/health`,
    ).then((response) => response.json());
    assert.equal(initialHealth.service, "vth-training-api");
    assert.equal(initialHealth.ready, 0);

    const similarityResponse = await fetch(
      `${running.baseUrl}/api/v1/similarity-search?topK=3`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: demoQuery,
      },
    );
    assert.equal(similarityResponse.status, 200);
    assert.equal(
      similarityResponse.headers.get("access-control-allow-origin"),
      "*",
    );
    const similarity = await similarityResponse.json();
    assert.equal(similarity.privacy.inputStored, false);
    assert.equal(similarity.privacy.inputUsedForTraining, false);
    assert.equal(similarity.query.stateCount, 8);
    assert.equal(similarity.panelDetection.detectedPanelCount, 1);
    assert.equal(similarity.panelDetection.analyzedPanelCount, 1);
    assert.equal(similarity.panelDetection.maxPanels, 24);
    assert.equal(similarity.panelDetection.truncated, false);
    assert.deepEqual(
      similarity.results.map((result) => result.rank),
      [1, 2, 3],
    );
    assert.ok(
      similarity.results.every(
        (result) =>
          result.score >= 0 &&
          result.score <= 1 &&
          result.imageUrl.startsWith(running.baseUrl),
      ),
    );
    assert.ok(
      similarity.results[0].score >= similarity.results[1].score &&
        similarity.results[1].score >= similarity.results[2].score,
    );

    const created = await fetch(
      `${running.baseUrl}/api/v1/training-samples`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trainingPayload()),
      },
    );
    assert.equal(created.status, 201);
    const createdPayload = await created.json();
    assert.equal(createdPayload.sample.status, "ready");
    assert.equal(createdPayload.sample.profile.length, 256);
    assert.equal(
      createdPayload.sample.sourceImage,
      "/api/v1/training-samples/sample-1/source-image",
    );

    const image = await fetch(
      `${running.baseUrl}/api/v1/training-samples/sample-1/image`,
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), tinyPng);
    const sourceImage = await fetch(
      `${running.baseUrl}/api/v1/training-samples/sample-1/source-image`,
    );
    assert.equal(sourceImage.status, 200);
    assert.equal(sourceImage.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await sourceImage.arrayBuffer()), tinyPng);

    const pending = await fetch(
      `${running.baseUrl}/api/v1/training-images?id=pending-1&label=Raw`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: tinyPng,
      },
    );
    assert.equal(pending.status, 202);

    const readyList = await fetch(
      `${running.baseUrl}/api/v1/training-samples`,
    ).then((response) => response.json());
    assert.deepEqual(
      readyList.samples.map((sample) => sample.id),
      ["sample-1"],
    );

    const completeList = await fetch(
      `${running.baseUrl}/api/v1/training-samples?includePending=1`,
    ).then((response) => response.json());
    assert.equal(completeList.samples.length, 2);

    const finalHealth = await fetch(
      `${running.baseUrl}/api/v1/health`,
    ).then((response) => response.json());
    assert.equal(finalHealth.ready, 1);
    assert.equal(finalHealth.pending, 1);

    const removed = await fetch(
      `${running.baseUrl}/api/v1/training-samples/sample-1`,
      { method: "DELETE" },
    );
    assert.equal(removed.status, 200);
  } finally {
    await running.close();
  }
});

test("enforces optional API keys for mutations", async () => {
  const running = await startServer({ apiKey: "secret-test-key" });
  try {
    const unauthorized = await fetch(
      `${running.baseUrl}/api/v1/training-samples`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trainingPayload("secured")),
      },
    );
    assert.equal(unauthorized.status, 401);

    const unauthorizedSearch = await fetch(
      `${running.baseUrl}/api/v1/similarity-search`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: demoQuery,
      },
    );
    assert.equal(unauthorizedSearch.status, 401);
    const unauthorizedSearchPayload = await unauthorizedSearch.json();
    assert.equal(unauthorizedSearchPayload.error.code, "unauthorized");
    assert.equal(
      unauthorizedSearchPayload.error.message,
      "API key가 필요합니다.",
    );

    const authorized = await fetch(
      `${running.baseUrl}/api/v1/training-samples`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "secret-test-key",
        },
        body: JSON.stringify(trainingPayload("secured")),
      },
    );
    assert.equal(authorized.status, 201);
  } finally {
    await running.close();
  }
});

test("returns a typed 413 for a chunked oversized similarity body", async () => {
  const running = await startServer();
  try {
    const response = await postChunkedOversize(
      `${running.baseUrl}/api/v1/similarity-search`,
    );
    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, "payload_too_large");
    assert.match(response.body.error.message, /20MB/);
  } finally {
    await running.close();
  }
});
