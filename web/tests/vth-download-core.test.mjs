import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assembleUbuntuPackage,
  assembleWindowsPackage,
} from "../lib/vth-download-core.mjs";

function fixture({
  fileName,
  manifestPath,
  partPath,
}) {
  const bytes = Uint8Array.from([
    31, 139, 8, 0, 86, 84, 72, 45,
    115, 105, 109, 105, 108, 97, 114, 105,
    116, 121,
  ]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schemaVersion: 1,
    version: "1.43.0",
    fileName,
    delivery: "browser-assembled",
    bytes: bytes.length,
    sha256,
    parts: [
      {
        index: 0,
        path: partPath,
        bytes: bytes.length,
        sha256,
      },
    ],
  };
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input), "https://dove9999.com");
    requests.push(url.pathname);
    if (url.pathname === manifestPath) {
      return Response.json(manifest);
    }
    if (url.pathname === partPath) {
      return new Response(bytes);
    }
    return new Response("Not found", { status: 404 });
  };
  return { bytes, fetchImpl, manifest, requests };
}

test("assembles the Windows v1.43.0 ZIP from its default manifest", async () => {
  const sample = fixture({
    fileName: "vth-similarity-windows-x64.zip",
    manifestPath: "/downloads/windows-package-v1.43.0.json",
    partPath:
      "/downloads/chunks/vth-similarity-windows-x64-v1.43.0.zip.part-000",
  });

  const result = await assembleWindowsPackage({
    fetchImpl: sample.fetchImpl,
  });

  assert.equal(
    result.fileName,
    "vth-similarity-windows-x64-v1.43.0.zip",
  );
  assert.equal(result.blob.type, "application/zip");
  assert.deepEqual(
    new Uint8Array(await result.blob.arrayBuffer()),
    sample.bytes,
  );
  assert.deepEqual(sample.requests, [
    "/downloads/windows-package-v1.43.0.json",
    sample.manifest.parts[0].path,
  ]);
});

test("preserves the Ubuntu tar.gz format declared by its v1.43.0 manifest", async () => {
  const sample = fixture({
    fileName: "vth-similarity-ubuntu-x64.tar.gz",
    manifestPath: "/downloads/ubuntu-package-v1.43.0.json",
    partPath:
      "/downloads/chunks/vth-similarity-ubuntu-x64-v1.43.0.tar.gz.part-000",
  });

  const result = await assembleUbuntuPackage({
    fetchImpl: sample.fetchImpl,
  });

  assert.equal(
    result.fileName,
    "vth-similarity-ubuntu-x64-v1.43.0.tar.gz",
  );
  assert.equal(result.blob.type, "application/gzip");
  assert.deepEqual(
    new Uint8Array(await result.blob.arrayBuffer()),
    sample.bytes,
  );
  assert.deepEqual(sample.requests, [
    "/downloads/ubuntu-package-v1.43.0.json",
    sample.manifest.parts[0].path,
  ]);
});

test("rejects an Ubuntu manifest that names another platform package", async () => {
  const sample = fixture({
    fileName: "vth-similarity-windows-x64.zip",
    manifestPath: "/downloads/ubuntu-package-v1.43.0.json",
    partPath:
      "/downloads/chunks/vth-similarity-windows-x64-v1.43.0.zip.part-000",
  });

  await assert.rejects(
    () =>
      assembleUbuntuPackage({
        fetchImpl: sample.fetchImpl,
      }),
    /패키지 파일 이름이 올바르지 않습니다/,
  );
});
