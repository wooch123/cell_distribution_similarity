import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRandomUuid } from "../lib/vth-random-core.mjs";
import {
  detectStandaloneRuntime,
  isStandaloneRuntimePayload,
} from "../lib/vth-runtime-core.mjs";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uses native randomUUID when the browser exposes it", () => {
  const expected = "39da8aac-9867-4a31-82db-61c8dc8215fb";
  const cryptoApi = {
    randomUUID() {
      assert.equal(this, cryptoApi);
      return expected;
    },
  };

  assert.equal(createRandomUuid(cryptoApi), expected);
});

test("creates an RFC 4122 UUID v4 with getRandomValues on LAN HTTP", () => {
  const cryptoApi = {
    randomUUID: undefined,
    getRandomValues(bytes) {
      assert.equal(this, cryptoApi);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index;
      }
      return bytes;
    },
  };

  const uuid = createRandomUuid(cryptoApi);
  assert.equal(uuid, "00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.match(uuid, UUID_V4_PATTERN);
});

test("generates independent fallback UUIDs without Math.random", () => {
  let seed = 0;
  const cryptoApi = {
    getRandomValues(bytes) {
      seed += 1;
      bytes.fill(seed);
      return bytes;
    },
  };

  const first = createRandomUuid(cryptoApi);
  const second = createRandomUuid(cryptoApi);
  assert.match(first, UUID_V4_PATTERN);
  assert.match(second, UUID_V4_PATTERN);
  assert.notEqual(first, second);
});

test("falls back when an embedded WebView exposes but rejects randomUUID", () => {
  const cryptoApi = {
    randomUUID() {
      throw new DOMException("insecure context", "SecurityError");
    },
    getRandomValues(bytes) {
      bytes.fill(0xaa);
      return bytes;
    },
  };

  assert.equal(
    createRandomUuid(cryptoApi),
    "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  );
});

test("fails explicitly rather than using an insecure random fallback", () => {
  assert.throws(
    () => createRandomUuid({ randomUUID: undefined }),
    (error) =>
      error instanceof Error &&
      error.code === "secure_random_unavailable" &&
      /안전한 난수/.test(error.message),
  );
});

test("uses the runtime contract even on loopback origins", async () => {
  let requested = 0;
  assert.equal(
    await detectStandaloneRuntime({
      fetchImpl: async () => {
        requested += 1;
        return Response.json({
          service: "vth-standalone-runtime",
          mode: "standalone-offline",
          externalNetworkAllowed: false,
        });
      },
    }),
    true,
  );
  assert.equal(requested, 1);
});

test("detects the Ubuntu server from a LAN IP or private DNS name", async () => {
  const runtime = {
    service: "vth-standalone-runtime",
    mode: "standalone-offline",
    externalNetworkAllowed: false,
  };
  assert.equal(isStandaloneRuntimePayload(runtime), true);

  const requests = [];
  const detected = await detectStandaloneRuntime({
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      return Response.json(runtime);
    },
  });
  assert.equal(detected, true);
  assert.deepEqual(requests, [
    {
      input: "/api/v1/runtime",
      init: {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      },
    },
  ]);
});

test("does not misclassify hosted responses as standalone", async () => {
  for (const fetchImpl of [
    async () => new Response("Not found", { status: 404 }),
    async () =>
      Response.json({
        service: "another-service",
        mode: "standalone-offline",
        externalNetworkAllowed: false,
      }),
  ]) {
    assert.equal(
      await detectStandaloneRuntime({
        fetchImpl,
      }),
      false,
    );
  }
});

test("retries transient runtime failures without declaring hosted mode", async () => {
  let requests = 0;
  let delays = 0;
  const recovered = await detectStandaloneRuntime({
    attempts: 2,
    retryDelayMs: 0,
    delayImpl: async () => {
      delays += 1;
    },
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) throw new Error("temporary network failure");
      return Response.json({
        service: "vth-standalone-runtime",
        mode: "standalone-offline",
        externalNetworkAllowed: false,
      });
    },
  });
  assert.equal(recovered, true);
  assert.equal(requests, 2);
  assert.equal(delays, 1);

  for (const fetchImpl of [
    async () => new Response("<html>not json</html>"),
    async () => {
      throw new Error("network unavailable");
    },
  ]) {
    assert.equal(
      await detectStandaloneRuntime({
        fetchImpl,
        attempts: 1,
      }),
      null,
    );
  }
});

test("the browser app has no direct secure-context-only UUID calls", async () => {
  const source = await readFile(
    new URL("../app/VthSearchApp.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /\bcrypto\.randomUUID\s*\(/);
  assert.match(source, /createRandomUuid\(\)/);
  assert.match(source, /detectStandaloneRuntime\(\)/);
  assert.match(source, /runtimeMode === "probing"/);
  assert.match(source, /candidateStoreSettled/);
  assert.doesNotMatch(
    source,
    /standaloneMode\s*&&\s*!sharedTrainingAvailable/,
  );
});
