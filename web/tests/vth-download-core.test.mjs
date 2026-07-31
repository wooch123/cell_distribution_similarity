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
  platform,
  architectures,
}) {
  const bytes = Uint8Array.from([
    31, 139, 8, 0, 86, 84, 72, 45,
    115, 105, 109, 105, 108, 97, 114, 105,
    116, 121,
  ]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schemaVersion: 1,
    version: "1.47.0",
    fileName,
    delivery: "browser-assembled",
    ...(platform ? { platform } : {}),
    ...(architectures ? { architectures } : {}),
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
    const url = new URL(String(input), "http://127.0.0.1:4173");
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

test("assembles the Windows v1.47.0 ZIP from its default manifest", async () => {
  const sample = fixture({
    fileName: "vth-similarity-windows-x64.zip",
    manifestPath: "/downloads/windows-package-v1.47.0.json",
    partPath:
      "/downloads/chunks/vth-similarity-windows-x64-v1.47.0.zip.part-000",
  });

  const result = await assembleWindowsPackage({
    fetchImpl: sample.fetchImpl,
  });

  assert.equal(
    result.fileName,
    "vth-similarity-windows-x64-v1.47.0.zip",
  );
  assert.equal(result.blob.type, "application/zip");
  assert.deepEqual(
    new Uint8Array(await result.blob.arrayBuffer()),
    sample.bytes,
  );
  assert.deepEqual(sample.requests, [
    "/downloads/windows-package-v1.47.0.json",
    sample.manifest.parts[0].path,
  ]);
});

test("assembles the Ubuntu Universal x64 + ARM64 v1.47.0 tar.gz", async () => {
  const sample = fixture({
    fileName: "vth-similarity-ubuntu-universal.tar.gz",
    manifestPath: "/downloads/ubuntu-package-v1.47.0.json",
    partPath:
      "/downloads/chunks/vth-similarity-ubuntu-universal-v1.47.0.tar.gz.part-000",
    platform: "ubuntu-linux-universal",
    architectures: ["x64", "arm64"],
  });

  const result = await assembleUbuntuPackage({
    fetchImpl: sample.fetchImpl,
  });

  assert.equal(
    result.fileName,
    "vth-similarity-ubuntu-universal-v1.47.0.tar.gz",
  );
  assert.equal(result.blob.type, "application/gzip");
  assert.deepEqual(
    new Uint8Array(await result.blob.arrayBuffer()),
    sample.bytes,
  );
  assert.deepEqual(sample.requests, [
    "/downloads/ubuntu-package-v1.47.0.json",
    sample.manifest.parts[0].path,
  ]);
});

test("rejects an Ubuntu manifest that names another platform package", async () => {
  const sample = fixture({
    fileName: "vth-similarity-windows-x64.zip",
    manifestPath: "/downloads/ubuntu-package-v1.47.0.json",
    partPath:
      "/downloads/chunks/vth-similarity-windows-x64-v1.47.0.zip.part-000",
    platform: "ubuntu-linux-universal",
    architectures: ["x64", "arm64"],
  });

  await assert.rejects(
    () =>
      assembleUbuntuPackage({
        fetchImpl: sample.fetchImpl,
      }),
    /패키지 파일 이름이 올바르지 않습니다/,
  );
});

test("rejects an Ubuntu Universal manifest with an x64-only platform", async () => {
  const sample = fixture({
    fileName: "vth-similarity-ubuntu-universal.tar.gz",
    manifestPath: "/downloads/ubuntu-package-v1.47.0.json",
    partPath:
      "/downloads/chunks/vth-similarity-ubuntu-universal-v1.47.0.tar.gz.part-000",
    platform: "ubuntu-linux-x64",
    architectures: ["x64", "arm64"],
  });

  await assert.rejects(
    () =>
      assembleUbuntuPackage({
        fetchImpl: sample.fetchImpl,
      }),
    /패키지 플랫폼이 올바르지 않습니다/,
  );
});

test("rejects an Ubuntu Universal manifest without ARM64", async () => {
  const sample = fixture({
    fileName: "vth-similarity-ubuntu-universal.tar.gz",
    manifestPath: "/downloads/ubuntu-package-v1.47.0.json",
    partPath:
      "/downloads/chunks/vth-similarity-ubuntu-universal-v1.47.0.tar.gz.part-000",
    platform: "ubuntu-linux-universal",
    architectures: ["x64"],
  });

  await assert.rejects(
    () =>
      assembleUbuntuPackage({
        fetchImpl: sample.fetchImpl,
      }),
    /패키지 CPU 아키텍처 구성이 올바르지 않습니다/,
  );
});
