export const WINDOWS_PACKAGE_VERSION = "1.32.0";
export const UBUNTU_PACKAGE_VERSION = "1.32.0";

const DEFAULT_WINDOWS_MANIFEST_URL =
  `/downloads/windows-package-v${WINDOWS_PACKAGE_VERSION}.json`;
const DEFAULT_UBUNTU_MANIFEST_URL =
  `/downloads/ubuntu-package-v${UBUNTU_PACKAGE_VERSION}.json`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function validateManifest(
  manifest,
  fileNamePattern,
  expectedVersion,
) {
  assert(manifest?.schemaVersion === 1, "패키지 메타데이터 버전이 올바르지 않습니다.");
  assert(
    manifest.delivery === "browser-assembled",
    "지원하지 않는 패키지 전달 방식입니다.",
  );
  assert(
    typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version),
    "패키지 버전이 올바르지 않습니다.",
  );
  assert(
    manifest.version === expectedVersion,
    "요청한 패키지 버전과 메타데이터 버전이 일치하지 않습니다.",
  );
  assert(
    typeof manifest.fileName === "string" &&
      fileNamePattern.test(manifest.fileName),
    "패키지 파일 이름이 올바르지 않습니다.",
  );
  assert(
    Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0,
    "패키지 크기가 올바르지 않습니다.",
  );
  assert(
    typeof manifest.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(manifest.sha256),
    "패키지 체크섬이 올바르지 않습니다.",
  );
  assert(
    Array.isArray(manifest.parts) && manifest.parts.length > 0,
    "패키지 조각 목록이 없습니다.",
  );

  const paths = new Set();
  manifest.parts.forEach((part, index) => {
    assert(part?.index === index, "패키지 조각 순서가 올바르지 않습니다.");
    assert(
      typeof part.path === "string" &&
        /^\/downloads\/chunks\/[a-zA-Z0-9._-]+$/.test(part.path),
      "패키지 조각 경로가 올바르지 않습니다.",
    );
    assert(!paths.has(part.path), "중복된 패키지 조각이 있습니다.");
    paths.add(part.path);
    assert(
      Number.isSafeInteger(part.bytes) && part.bytes > 0,
      "패키지 조각 크기가 올바르지 않습니다.",
    );
    assert(
      typeof part.sha256 === "string" && /^[a-f0-9]{64}$/.test(part.sha256),
      "패키지 조각 체크섬이 올바르지 않습니다.",
    );
  });
  assert(
    manifest.parts.reduce((total, part) => total + part.bytes, 0) ===
      manifest.bytes,
    "패키지 조각의 전체 크기가 일치하지 않습니다.",
  );
  return manifest;
}

function versionedPackageFileName(fileName, version) {
  const extension = fileName.endsWith(".tar.gz")
    ? ".tar.gz"
    : fileName.slice(fileName.lastIndexOf("."));
  const baseName = fileName.slice(0, -extension.length);
  return `${baseName}-v${version}${extension}`;
}

/**
 * @param {{
 *   fetchImpl?: typeof globalThis.fetch;
 *   manifestUrl?: string;
 *   onProgress?: (progress: {
 *     phase: string;
 *     completed: number;
 *     total: number;
 *   }) => void;
 * }} options
 * @param {{
 *   defaultManifestUrl: string;
 *   expectedVersion: string;
 *   fileNamePattern: RegExp;
 * }} packageDefinition
 */
async function assemblePackage(
  {
    fetchImpl = globalThis.fetch,
    manifestUrl,
    onProgress = () => {},
  },
  packageDefinition,
) {
  const resolvedManifestUrl =
    manifestUrl ?? packageDefinition.defaultManifestUrl;
  assert(typeof fetchImpl === "function", "다운로드 기능을 사용할 수 없습니다.");
  const manifestResponse = await fetchImpl(resolvedManifestUrl, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  assert(manifestResponse.ok, "패키지 정보를 불러오지 못했습니다.");
  const manifest = validateManifest(
    await manifestResponse.json(),
    packageDefinition.fileNamePattern,
    packageDefinition.expectedVersion,
  );
  const parts = [];

  for (const [index, part] of manifest.parts.entries()) {
    onProgress({
      phase: "parts",
      completed: index,
      total: manifest.parts.length,
    });
    const separator = part.path.includes("?") ? "&" : "?";
    const response = await fetchImpl(
      `${part.path}${separator}standalone-download=${encodeURIComponent(
        manifest.version,
      )}`,
      { cache: "force-cache" },
    );
    assert(response.ok, `패키지 조각 ${index + 1}을 받지 못했습니다.`);
    const bytes = await response.arrayBuffer();
    assert(bytes.byteLength === part.bytes, `패키지 조각 ${index + 1}의 크기가 다릅니다.`);
    assert(
      (await sha256Hex(bytes)) === part.sha256,
      `패키지 조각 ${index + 1}의 무결성 검증에 실패했습니다.`,
    );
    parts.push(bytes);
  }

  onProgress({
    phase: "verify",
    completed: manifest.parts.length,
    total: manifest.parts.length,
  });
  const blob = new Blob(parts, {
    type: manifest.fileName.endsWith(".tar.gz")
      ? "application/gzip"
      : "application/zip",
  });
  assert(blob.size === manifest.bytes, "완성된 패키지 크기가 일치하지 않습니다.");
  assert(
    (await sha256Hex(await blob.arrayBuffer())) === manifest.sha256,
    "완성된 패키지의 무결성 검증에 실패했습니다.",
  );
  return {
    blob,
    fileName: versionedPackageFileName(
      manifest.fileName,
      manifest.version,
    ),
    manifest,
  };
}

/**
 * Assemble the complete offline Windows x64 package from verified browser
 * download chunks.
 *
 * @param {{
 *   fetchImpl?: typeof globalThis.fetch;
 *   manifestUrl?: string;
 *   onProgress?: (progress: {
 *     phase: string;
 *     completed: number;
 *     total: number;
 *   }) => void;
 * }} [options]
 */
export function assembleWindowsPackage(options = {}) {
  return assemblePackage(options, {
    defaultManifestUrl: DEFAULT_WINDOWS_MANIFEST_URL,
    expectedVersion: WINDOWS_PACKAGE_VERSION,
    fileNamePattern: /^vth-similarity-windows-x64\.zip$/,
  });
}

/**
 * Assemble the Ubuntu x64 external Web server package from the same verified
 * browser chunk delivery contract used by the Windows download.
 *
 * @param {{
 *   fetchImpl?: typeof globalThis.fetch;
 *   manifestUrl?: string;
 *   onProgress?: (progress: {
 *     phase: string;
 *     completed: number;
 *     total: number;
 *   }) => void;
 * }} [options]
 */
export function assembleUbuntuPackage(options = {}) {
  return assemblePackage(options, {
    defaultManifestUrl: DEFAULT_UBUNTU_MANIFEST_URL,
    expectedVersion: UBUNTU_PACKAGE_VERSION,
    fileNamePattern:
      /^vth-similarity-ubuntu-x64\.(?:zip|tar\.gz)$/,
  });
}
