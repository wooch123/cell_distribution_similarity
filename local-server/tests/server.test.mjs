import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildAccessUrls,
  createVthServer,
  parseArguments,
  startVthServer,
} from "../server.mjs";

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
  const { server, access } = await createVthServer({
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
    access,
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

function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "GET",
        headers: { host },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
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
    assert.equal(
      similarityCapability.multiChart.placement,
      "arbitrary-non-overlapping",
    );
    assert.equal(
      similarityCapability.multiChart.lowResolutionRecovery,
      true,
    );
    assert.equal(
      similarityCapability.multiChart.nonChartRejection,
      true,
    );
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
    assert.equal(similarity.panelDetection.detectedPanelCount, 0);
    assert.ok(similarity.panelDetection.rejectedNonChartCount >= 1);
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

test("parses safe Ubuntu bind and public URL arguments", () => {
  const options = parseArguments([
    "--host",
    "0.0.0.0",
    "--port",
    "8080",
    "--public-url",
    "https://vth.example.test/",
    "--api-key",
    "fixed-key",
  ]);
  assert.equal(options.host, "0.0.0.0");
  assert.equal(options.port, 8080);
  assert.equal(options.publicUrl, "https://vth.example.test");
  assert.equal(options.apiKey, "fixed-key");

  assert.throws(
    () => parseArguments(["--host", "https://example.test"]),
    /유효한 IP 주소 또는 호스트 이름/,
  );
  assert.throws(
    () => parseArguments(["--public-url", "ftp://example.test"]),
    /http 또는 https/,
  );
  assert.throws(
    () => parseArguments(["--public-url"]),
    /뒤에 값/,
  );
});

test("builds concrete LAN and explicit public URLs for a wildcard bind", () => {
  const urls = buildAccessUrls(
    "0.0.0.0",
    4173,
    "https://vth.example.test",
    {
      lo: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
        },
      ],
      eth0: [
        {
          address: "192.168.10.24",
          family: "IPv4",
          internal: false,
        },
        {
          address: "2001:db8::24",
          family: "IPv6",
          internal: false,
        },
      ],
    },
  );

  assert.deepEqual(urls.local, ["http://127.0.0.1:4173"]);
  assert.deepEqual(urls.lan, [
    "http://192.168.10.24:4173",
    "http://[2001:db8::24]:4173",
  ]);
  assert.deepEqual(urls.public, ["https://vth.example.test"]);

  const specificInterfaceUrls = buildAccessUrls(
    "192.168.10.24",
    4173,
    "",
    {},
  );
  assert.deepEqual(specificInterfaceUrls.local, []);
  assert.deepEqual(specificInterfaceUrls.lan, [
    "http://192.168.10.24:4173",
  ]);
});

test("protects network-bound training data with a bootstrap cookie", async () => {
  const running = await startServer({
    host: "0.0.0.0",
    apiKey: "lan-secret",
    publicUrl: "https://vth.example.test",
  });
  try {
    assert.equal(running.access.accessMode, "offline-network-accessible");
    assert.equal(running.access.networkAccessible, true);
    assert.equal(running.access.apiKeyRequired, true);
    assert.equal(running.access.apiKeyGenerated, false);

    const runtimeResponse = await fetch(
      `${running.baseUrl}/api/v1/runtime`,
    );
    assert.equal(
      runtimeResponse.headers.get("x-vth-network-mode"),
      "offline-network-accessible",
    );
    assert.equal(
      runtimeResponse.headers.get("x-vth-access-mode"),
      "network-accessible",
    );
    const runtime = await runtimeResponse.json();
    assert.equal(runtime.mode, "standalone-offline");
    assert.equal(runtime.externalNetworkAllowed, false);
    assert.equal(runtime.accessMode, "offline-network-accessible");
    assert.equal(runtime.bindHost, "0.0.0.0");
    assert.equal(runtime.inboundNetworkAccess, true);
    assert.equal(runtime.apiKeyRequired, true);
    assert.equal(runtime.publicUrl, "https://vth.example.test");

    const openApi = await fetch(
      `${running.baseUrl}/api/v1/openapi.json`,
    ).then((response) => response.json());
    assert.equal(openApi.servers[0].url, "https://vth.example.test");
    assert.equal(
      openApi.components.securitySchemes.apiKeyHeader.name,
      "x-api-key",
    );
    assert.equal(
      openApi.components.securitySchemes.bearerAuth.scheme,
      "bearer",
    );
    assert.equal(
      openApi.components.securitySchemes.browserCookie.name,
      "vth_access",
    );
    assert.ok(
      openApi.paths["/api/v1/similarity-search"].post.responses["401"],
    );
    assert.ok(
      openApi.paths["/api/v1/training-samples"].get.responses["401"],
    );

    const unauthorizedList = await fetch(
      `${running.baseUrl}/api/v1/training-samples`,
    );
    assert.equal(unauthorizedList.status, 401);
    assert.equal(
      (await unauthorizedList.json()).error.code,
      "unauthorized",
    );

    const invalidBootstrap = await fetch(
      `${running.baseUrl}/?access_token=incorrect`,
      { redirect: "manual" },
    );
    assert.equal(invalidBootstrap.status, 401);
    assert.equal(invalidBootstrap.headers.get("set-cookie"), null);

    const bootstrap = await fetch(
      `${running.baseUrl}/?view=search&access_token=lan-secret`,
      { redirect: "manual" },
    );
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.get("location"), "/?view=search");
    const setCookie = bootstrap.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^vth_access=[^;]+;/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, /Secure/);
    assert.doesNotMatch(
      bootstrap.headers.get("location") ?? "",
      /access_token/,
    );
    const cookie = setCookie.split(";")[0];

    const publicBootstrap = await getWithHost(
      `${running.baseUrl}/?access_token=lan-secret`,
      "vth.example.test",
    );
    assert.equal(publicBootstrap.status, 303);
    assert.match(
      String(publicBootstrap.headers["set-cookie"] ?? ""),
      /Secure/,
    );

    const authorizedList = await fetch(
      `${running.baseUrl}/api/v1/training-samples`,
      { headers: { cookie } },
    );
    assert.equal(authorizedList.status, 200);
    assert.deepEqual((await authorizedList.json()).samples, []);

    const created = await fetch(
      `${running.baseUrl}/api/v1/training-samples`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify(trainingPayload("lan-protected")),
      },
    );
    assert.equal(created.status, 201);

    const unauthorizedImage = await fetch(
      `${running.baseUrl}/api/v1/training-samples/lan-protected/source-image`,
    );
    assert.equal(unauthorizedImage.status, 401);
    const authorizedImage = await fetch(
      `${running.baseUrl}/api/v1/training-samples/lan-protected/source-image`,
      { headers: { cookie } },
    );
    assert.equal(authorizedImage.status, 200);
  } finally {
    await running.close();
  }
});

test("automatically generates an access key only for network binds", async () => {
  const networkRunning = await startServer({ host: "0.0.0.0" });
  try {
    assert.equal(networkRunning.access.apiKeyGenerated, true);
    assert.equal(networkRunning.access.apiKeyRequired, true);
    assert.match(networkRunning.access.apiKey, /^[A-Za-z0-9_-]{32}$/);
  } finally {
    await networkRunning.close();
  }

  const loopbackRunning = await startServer();
  try {
    assert.equal(loopbackRunning.access.accessMode, "offline-loopback-only");
    assert.equal(loopbackRunning.access.apiKeyGenerated, false);
    assert.equal(loopbackRunning.access.apiKeyRequired, false);
    assert.equal(loopbackRunning.access.apiKey, "");
  } finally {
    await loopbackRunning.close();
  }
});

test("startVthServer returns browser-safe URLs instead of a wildcard URL", async () => {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "vth-network-start-"),
  );
  const running = await startVthServer({
    host: "127.0.0.1",
    port: 0,
    rootDirectory: projectRoot,
    siteDirectory,
    dataDirectory,
  });
  try {
    assert.equal(running.accessMode, "offline-loopback-only");
    assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(running.accessUrls.lan, []);
    assert.deepEqual(running.accessUrls.public, []);
    assert.deepEqual(running.accessUrls.local, [running.url]);
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("startVthServer bootstraps a fixed API key for browser UI requests", async () => {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "vth-fixed-key-start-"),
  );
  const running = await startVthServer({
    host: "127.0.0.1",
    port: 0,
    apiKey: "fixed-browser-key",
    rootDirectory: projectRoot,
    siteDirectory,
    dataDirectory,
  });
  try {
    const browserUrl = new URL(running.url);
    assert.equal(
      browserUrl.searchParams.get("access_token"),
      "fixed-browser-key",
    );
    assert.equal(
      running.accessUrls.local[0],
      running.url,
    );

    const bootstrap = await fetch(running.url, {
      redirect: "manual",
    });
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.get("location"), "/");
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^vth_access=/);

    const uiTrainingRequest = await fetch(
      `${browserUrl.origin}/api/v1/training-samples`,
      { headers: { cookie } },
    );
    assert.equal(uiTrainingRequest.status, 200);
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
