import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MAX_IMAGE_BYTES, TrainingStore } from "./training-store.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(moduleDirectory, "..");
const JSON_BODY_LIMIT = 20 * 1024 * 1024;
const SIMILARITY_IMAGE_BODY_LIMIT = 12 * 1024 * 1024;
const MAXIMUM_CHART_PANELS = 30;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const ACCESS_TOKEN_QUERY = "access_token";
const ACCESS_COOKIE_NAME = "vth_access";
const ACCESS_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const STANDALONE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self' blob:",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

function normalizeBindHost(value) {
  let host = String(value ?? "").trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (!host) {
    throw new Error("--host에는 IP 주소 또는 호스트 이름이 필요합니다.");
  }
  if (
    !isIP(host) &&
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      host,
    )
  ) {
    throw new Error("--host에는 유효한 IP 주소 또는 호스트 이름이 필요합니다.");
  }
  if (!isIP(host) && /^[\d.]+$/.test(host)) {
    throw new Error("--host에는 유효한 IP 주소 또는 호스트 이름이 필요합니다.");
  }
  return host;
}

function isLoopbackHost(host) {
  const normalized = normalizeBindHost(host).toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) {
    const firstOctet = Number(normalized.split(".")[0]);
    return firstOctet === 127;
  }
  return false;
}

function isWildcardHost(host) {
  const normalized = normalizeBindHost(host);
  return normalized === "0.0.0.0" || normalized === "::";
}

function hostForUrl(host) {
  const normalized = normalizeBindHost(host);
  return isIP(normalized) === 6 ? `[${normalized}]` : normalized;
}

function normalizePublicUrl(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("--public-url에는 유효한 http(s) URL이 필요합니다.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("--public-url은 http 또는 https URL이어야 합니다.");
  }
  if (url.username || url.password) {
    throw new Error("--public-url에는 사용자 정보를 포함할 수 없습니다.");
  }
  if (url.search || url.hash) {
    throw new Error("--public-url에는 query 또는 fragment를 포함할 수 없습니다.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("--public-url은 경로 없이 origin만 지정해야 합니다.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function appendAccessToken(url, accessToken) {
  if (!accessToken) return url;
  const tokenUrl = new URL(url);
  tokenUrl.searchParams.set(ACCESS_TOKEN_QUERY, accessToken);
  return tokenUrl.toString();
}

function uniqueUrls(urls) {
  return [...new Set(urls.filter(Boolean))];
}

/**
 * Resolve browser-friendly URLs for a listening socket. Wildcard addresses
 * are valid bind targets but cannot be opened in another browser, so expose
 * loopback and concrete NIC addresses instead. A public URL is never guessed:
 * NAT, reverse proxies and TLS termination make external discovery unsafe.
 */
export function buildAccessUrls(
  host,
  port,
  publicUrl = "",
  interfaces = networkInterfaces(),
) {
  const normalizedHost = normalizeBindHost(host);
  const normalizedPublicUrl = normalizePublicUrl(publicUrl);
  const localUrls = isLoopbackHost(normalizedHost)
    ? [`http://${hostForUrl(normalizedHost)}:${port}`]
    : normalizedHost === "0.0.0.0"
      ? [`http://127.0.0.1:${port}`]
      : normalizedHost === "::"
        ? [`http://[::1]:${port}`]
        : [];
  const lanUrls = [];
  if (isWildcardHost(normalizedHost)) {
    for (const addresses of Object.values(interfaces ?? {})) {
      for (const address of addresses ?? []) {
        if (
          address.internal ||
          ![4, 6, "IPv4", "IPv6"].includes(address.family)
        ) {
          continue;
        }
        const cleanAddress = String(address.address).split("%")[0];
        if (
          !cleanAddress ||
          isLoopbackHost(cleanAddress) ||
          cleanAddress.toLowerCase().startsWith("fe80:")
        ) {
          continue;
        }
        lanUrls.push(`http://${hostForUrl(cleanAddress)}:${port}`);
      }
    }
  } else if (!isLoopbackHost(normalizedHost)) {
    lanUrls.push(`http://${hostForUrl(normalizedHost)}:${port}`);
  }
  return {
    local: uniqueUrls(localUrls),
    lan: uniqueUrls(lanUrls),
    public: normalizedPublicUrl ? [normalizedPublicUrl] : [],
  };
}

function accessModeForHost(host) {
  return isLoopbackHost(host)
    ? "offline-loopback-only"
    : "offline-network-accessible";
}

function encodedCookieToken(apiKey) {
  return Buffer.from(apiKey, "utf8").toString("base64url");
}

function usesConfiguredHttpsOrigin(requestUrl, publicUrl) {
  if (!publicUrl) return false;
  const configured = new URL(publicUrl);
  return (
    configured.protocol === "https:" &&
    configured.host.toLowerCase() === requestUrl.host.toLowerCase()
  );
}

function secureEqual(first, second) {
  const firstBuffer = Buffer.from(String(first ?? ""), "utf8");
  const secondBuffer = Buffer.from(String(second ?? ""), "utf8");
  return (
    firstBuffer.length === secondBuffer.length &&
    timingSafeEqual(firstBuffer, secondBuffer)
  );
}

function cookieValue(request, name) {
  const cookie = String(request.headers.cookie ?? "");
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function errorResponse(error, status = 400) {
  return jsonResponse(
    {
      error: {
        code:
          error?.code ??
          (status === 404
            ? "not_found"
            : status === 413
              ? "payload_too_large"
              : "invalid_request"),
        message: error?.message ?? String(error),
        ...(error?.details?.reason
          ? { reasonCode: error.details.reason }
          : {}),
        ...(error?.details
          ? { details: error.details }
          : {}),
      },
    },
    status,
  );
}

const SIMILARITY_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-api-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "86400",
  vary: "origin",
};

function similarityJsonResponse(value, status = 200) {
  return jsonResponse(value, status, SIMILARITY_CORS_HEADERS);
}

function similarityErrorResponse(error) {
  const expected = Number.isInteger(error?.status);
  const status = expected ? error.status : 500;
  const code = expected
    ? error?.code ?? "invalid_request"
    : "internal_error";
  return similarityJsonResponse(
    {
      requestId: crypto.randomUUID(),
      error: {
        code,
        message: expected
          ? error?.message ?? String(error)
          : "유사 산포 검색을 처리하지 못했습니다.",
        ...(expected && error?.details?.reason
          ? { reasonCode: error.details.reason }
          : {}),
        ...(expected && error?.details
          ? { details: error.details }
          : {}),
      },
    },
    status,
  );
}

function readNodeBody(request, limit, details = undefined) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on("data", (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (exceeded) {
        reject(
          Object.assign(
            new Error(
              `요청 본문은 ${Math.round(limit / 1024 / 1024)}MB 이하여야 합니다.`,
            ),
            {
              status: 413,
              code: "payload_too_large",
              ...(details ? { details } : {}),
            },
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function similarityRequestResourceDiagnostic(diagnostics = {}) {
  return {
    category: "input",
    diagnosticCode: "VTH-IN-RESOURCE-LIMIT",
    reason: "resource_limit",
    action:
      "검색 요청 본문은 20MB 이하, 실제 이미지 데이터는 12MB·800만 픽셀 이하로 입력해 주세요.",
    diagnostics,
  };
}

function requestHeaders(nodeRequest) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

let similarityEnginePromise;

async function loadSimilarityEngine() {
  if (!similarityEnginePromise) {
    const packagedEnginePath = path.join(
      moduleDirectory,
      "similarity-engine.mjs",
    );
    similarityEnginePromise = stat(packagedEnginePath)
      .then(() => import(pathToFileURL(packagedEnginePath).href))
      .catch(async (error) => {
        if (error?.code !== "ENOENT") throw error;
        return import(
          pathToFileURL(
            path.join(
              moduleDirectory,
              "..",
              "web",
              "lib",
              "vth-similarity-api-core.mjs",
            ),
          ).href,
        );
      });
  }
  return similarityEnginePromise;
}

function mutationAuthorized(request, apiKey) {
  if (!apiKey) return true;
  const direct = request.headers["x-api-key"];
  const authorization = request.headers.authorization;
  return (
    secureEqual(direct, apiKey) ||
    secureEqual(authorization, `Bearer ${apiKey}`) ||
    secureEqual(
      cookieValue(request, ACCESS_COOKIE_NAME),
      encodedCookieToken(apiKey),
    )
  );
}

function parseArguments(argv) {
  const values = {
    host: process.env.VTH_HOST || DEFAULT_HOST,
    port: Number(process.env.VTH_PORT || DEFAULT_PORT),
    rootDirectory: DEFAULT_ROOT,
    dataDirectory: "",
    siteDirectory: "",
    apiKey: process.env.VTH_API_KEY || "",
    publicUrl: process.env.VTH_PUBLIC_URL || "",
    open: false,
  };
  const nextValue = (argument, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} 뒤에 값이 필요합니다.`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--open") values.open = true;
    else if (argument === "--host") {
      values.host = nextValue(argument, index);
      index += 1;
    } else if (argument === "--port") {
      values.port = Number(nextValue(argument, index));
      index += 1;
    } else if (argument === "--root") {
      values.rootDirectory = path.resolve(nextValue(argument, index));
      index += 1;
    } else if (argument === "--data-dir") {
      values.dataDirectory = path.resolve(nextValue(argument, index));
      index += 1;
    } else if (argument === "--site-dir") {
      values.siteDirectory = path.resolve(nextValue(argument, index));
      index += 1;
    } else if (argument === "--api-key") {
      values.apiKey = nextValue(argument, index);
      index += 1;
    } else if (argument === "--public-url") {
      values.publicUrl = nextValue(argument, index);
      index += 1;
    } else {
      throw new Error(`알 수 없는 인수: ${argument}`);
    }
  }
  values.host = normalizeBindHost(values.host);
  values.publicUrl = normalizePublicUrl(values.publicUrl);
  values.dataDirectory ||= path.join(values.rootDirectory, "data");
  values.siteDirectory ||= path.join(values.rootDirectory, "site");
  if (!Number.isInteger(values.port) || values.port < 0 || values.port > 65535) {
    throw new Error("--port는 0~65535 정수여야 합니다.");
  }
  return values;
}

async function createAssetFetcher(clientDirectory) {
  const resolvedClient = path.resolve(clientDirectory);
  return async (request) => {
    const url = new URL(request.url);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const relativePath = pathname.replace(/^\/+/, "");
    const candidatePath = path.resolve(resolvedClient, relativePath);
    if (
      !relativePath ||
      (candidatePath !== resolvedClient &&
        !candidatePath.startsWith(`${resolvedClient}${path.sep}`))
    ) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const fileStat = await stat(candidatePath);
      if (!fileStat.isFile()) return new Response("Not found", { status: 404 });
      const extension = path.extname(candidatePath).toLowerCase();
      return new Response(await readFile(candidatePath), {
        status: 200,
        headers: {
          "content-type":
            MIME_TYPES.get(extension) ?? "application/octet-stream",
          "cache-control":
            pathname.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "no-cache",
        },
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return new Response("Not found", { status: 404 });
      }
      throw error;
    }
  };
}

async function createWorker(siteDirectory, assetFetcher) {
  const serverEntry = path.join(siteDirectory, "server", "index.js");
  await stat(serverEntry);
  const module = await import(pathToFileURL(serverEntry).href);
  if (!module.default?.fetch) {
    throw new Error("vinext 서버 entrypoint를 찾지 못했습니다.");
  }
  return {
    fetch(request) {
      return module.default.fetch(
        request,
        {
          ASSETS: { fetch: assetFetcher },
        },
        {
          waitUntil() {},
          passThroughOnException() {},
        },
      );
    },
  };
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export async function createVthServer(options = {}) {
  const bindHost = normalizeBindHost(options.host ?? DEFAULT_HOST);
  const accessMode = accessModeForHost(bindHost);
  const networkAccessible = accessMode !== "offline-loopback-only";
  const configuredApiKey = String(options.apiKey ?? "");
  const apiKey =
    configuredApiKey ||
    (networkAccessible ? randomBytes(24).toString("base64url") : "");
  const publicUrl = normalizePublicUrl(options.publicUrl ?? "");
  const access = {
    bindHost,
    accessMode,
    networkAccessible,
    apiKey,
    apiKeyRequired: Boolean(apiKey),
    apiKeyGenerated: Boolean(apiKey && !configuredApiKey),
    publicUrl,
  };
  const rootDirectory = path.resolve(options.rootDirectory ?? DEFAULT_ROOT);
  const dataDirectory = path.resolve(
    options.dataDirectory ?? path.join(rootDirectory, "data"),
  );
  const siteDirectory = path.resolve(
    options.siteDirectory ?? path.join(rootDirectory, "site"),
  );
  const store = await new TrainingStore(dataDirectory, {
    validateReadyImage: async (input) => {
      const engine = await loadSimilarityEngine();
      if (typeof engine.validateTrainingWaveformImage !== "function") {
        throw Object.assign(
          new Error("학습 원본 파형 검증기가 준비되지 않았습니다."),
          {
            status: 503,
            code: "waveform_validator_unavailable",
          },
        );
      }
      return engine.validateTrainingWaveformImage(input);
    },
  }).initialize();
  const corpus = JSON.parse(
    await readFile(path.join(siteDirectory, "client", "corpus-index.json"), "utf8"),
  );
  if (!Array.isArray(corpus?.candidates)) {
    throw new Error("번들된 검색 코퍼스를 읽을 수 없습니다.");
  }
  const assetFetcher = await createAssetFetcher(
    path.join(siteDirectory, "client"),
  );
  const worker = await createWorker(siteDirectory, assetFetcher);

  async function handleApi(nodeRequest, requestUrl) {
    const pathName = requestUrl.pathname;
    const method = nodeRequest.method ?? "GET";
    const isSimilaritySearch = pathName === "/api/v1/similarity-search";
    const isPrivateTrainingResource =
      networkAccessible &&
      pathName.startsWith("/api/v1/training-");
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...(isSimilaritySearch
            ? SIMILARITY_CORS_HEADERS
            : {
                "access-control-allow-headers": "authorization, content-type, x-api-key",
                "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
              }),
        },
      });
    }
    if (
      isPrivateTrainingResource &&
      !mutationAuthorized(nodeRequest, apiKey)
    ) {
      return errorResponse(
        Object.assign(new Error("API key가 필요합니다."), {
          code: "unauthorized",
        }),
        401,
      );
    }
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
      !mutationAuthorized(nodeRequest, apiKey)
    ) {
      return isSimilaritySearch
        ? similarityErrorResponse({
            status: 401,
            code: "unauthorized",
            message: "API key가 필요합니다.",
          })
        : errorResponse(new Error("API key가 필요합니다."), 401);
    }

    if (isSimilaritySearch) {
      try {
        if (method === "GET") {
          return similarityJsonResponse({
            service: "vth-similarity-search-api",
            version: 1,
            schemaVersion: 1,
            status: "ok",
            method: "POST",
            mode: "standalone-offline",
            endpoint: "/api/v1/similarity-search",
            openapi: "/api/v1/openapi.json",
            supportedImageTypes: ["image/png", "image/jpeg"],
            maxImageBytes: SIMILARITY_IMAGE_BODY_LIMIT,
            maxRequestBodyBytes: JSON_BODY_LIMIT,
            maxResults: 10,
            multiChart: {
              supported: true,
              ranking: "per-panel-per-series",
              placement: "arbitrary-non-overlapping",
              readingOrder: "top-to-bottom-left-to-right",
              lowResolutionRecovery: true,
              nonChartRejection: true,
              maxPanels: MAXIMUM_CHART_PANELS,
              overflowPolicy: "highest-confidence-then-reading-order",
              colorSeries: {
                supported: true,
                ranking: "per-series",
                styleInvariant: true,
                representative: "most-irregular",
                maxIndependentSeries: 2,
                overflowPolicy: "most-irregular-only",
              },
            },
            inputHandling: {
              stored: false,
              usedForTraining: false,
              processing: "transient-memory-only",
            },
            limits: {
              maxImageBytes: SIMILARITY_IMAGE_BODY_LIMIT,
              maxResults: 10,
              defaultResults: 8,
            },
            privacy: {
              inputStored: false,
              inputUsedForTraining: false,
              externalNetworkAllowed: false,
            },
            corpus: {
              baseCandidateCount: corpus.candidates.length,
              learnedCandidateCount: store.stats().ready,
            },
          });
        }
        if (method !== "POST") {
          return similarityErrorResponse({
            status: 405,
            code: "method_not_allowed",
            message: "GET 또는 POST 요청만 지원합니다.",
          });
        }

        const declaredLength = Number(nodeRequest.headers["content-length"]);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > JSON_BODY_LIMIT
        ) {
          return similarityErrorResponse({
            status: 413,
            code: "payload_too_large",
            message: "검색 요청 본문은 20MB 이하여야 합니다.",
            details: similarityRequestResourceDiagnostic({
              contentLength: declaredLength,
              maximumRequestBytes: JSON_BODY_LIMIT,
            }),
          });
        }
        const bytes = await readNodeBody(
          nodeRequest,
          JSON_BODY_LIMIT,
          similarityRequestResourceDiagnostic({
            maximumRequestBytes: JSON_BODY_LIMIT,
          }),
        );
        const engine = await loadSimilarityEngine();
        const apiRequest = new Request(requestUrl, {
          method: "POST",
          headers: requestHeaders(nodeRequest),
          body: bytes,
        });
        const input = await engine.parseSimilarityImageRequest(apiRequest);
        const result = await engine.searchSimilarityImage({
          ...input,
          corpus,
          learnedCandidates: store.list(),
          origin: requestUrl.origin,
        });
        const warnings = result.panelDetection?.truncated
          ? [
              {
                code: "panel_limit_applied",
                message: `${result.panelDetection.detectedPanelCount}개 차트를 감지해 품질이 높은 ${result.panelDetection.analyzedPanelCount}개를 분석했습니다.`,
              },
            ]
          : [];
        return similarityJsonResponse({
          schemaVersion: 1,
          requestId: crypto.randomUUID(),
          service: "vth-similarity-search-api",
          inputHandling: {
            stored: false,
            usedForTraining: false,
            processing: "transient-memory-only",
          },
          warnings,
          privacy: {
            inputStored: false,
            inputUsedForTraining: false,
            externalNetworkAllowed: false,
          },
          ...result,
        });
      } catch (error) {
        return similarityErrorResponse(error);
      }
    }

    if (method === "GET" && pathName === "/api/v1/health") {
      return jsonResponse({
        service: "vth-training-api",
        version: 1,
        status: "ok",
        writable: true,
        ...store.stats(),
      });
    }
    if (method === "GET" && pathName === "/api/v1/runtime") {
      return jsonResponse({
        service: "vth-standalone-runtime",
        version: 1,
        mode: "standalone-offline",
        accessMode,
        bindHost,
        inboundNetworkAccess: networkAccessible,
        apiKeyRequired: Boolean(apiKey),
        publicUrl: publicUrl || null,
        externalNetworkAllowed: false,
        corpusBundled: true,
        modelBundled: true,
        sharedApiEnabled: false,
        learningStorage: "local-data-directory",
      });
    }
    if (method === "GET" && pathName === "/api/v1/training-samples") {
      return jsonResponse({
        samples: store.list({
          includePending:
            requestUrl.searchParams.get("includePending") === "1",
        }),
      });
    }
    if (method === "GET" && pathName === "/api/v1/training-export") {
      return jsonResponse({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        samples: store.list({ includePending: true }),
      });
    }
    if (method === "GET" && pathName === "/api/v1/openapi.json") {
      const document = JSON.parse(
        await readFile(
          path.join(moduleDirectory, "openapi.json"),
          "utf8",
        ),
      );
      const currentUrl = publicUrl || requestUrl.origin;
      document.servers = [
        {
          url: currentUrl,
          description: publicUrl
            ? "Configured public service URL"
            : "Current service URL",
        },
        ...(document.servers ?? []).filter(
          (serverDefinition) =>
            serverDefinition.url !== currentUrl,
        ),
      ];
      return jsonResponse(document, 200, {
        "cache-control": "no-cache",
      });
    }
    if (method === "POST" && pathName === "/api/v1/training-samples") {
      const contentType = String(
        nodeRequest.headers["content-type"] || "",
      )
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        throw Object.assign(
          new Error(
            "Content-Type은 application/json이어야 합니다.",
          ),
          {
            status: 415,
            code: "unsupported_media_type",
          },
        );
      }
      const body = await readNodeBody(nodeRequest, JSON_BODY_LIMIT);
      const record = await store.upsertReady(JSON.parse(body.toString("utf8")));
      return jsonResponse({ sample: record }, 201);
    }
    if (method === "POST" && pathName === "/api/v1/training-images") {
      const contentType = String(nodeRequest.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (contentType === "application/json") {
        const body = await readNodeBody(nodeRequest, JSON_BODY_LIMIT);
        const payload = JSON.parse(body.toString("utf8"));
        if (payload.profile && payload.descriptor) {
          const record = await store.upsertReady(payload);
          return jsonResponse({ sample: record }, 201);
        }
        const dataUrl = String(payload.imageDataUrl || "");
        const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(dataUrl);
        if (!match) throw new Error("imageDataUrl이 필요합니다.");
        const record = await store.ingestPending({
          bytes: Buffer.from(match[2].replace(/\s+/g, ""), "base64"),
          mimeType: match[1],
          id: payload.id,
          label: payload.label,
          metadata: payload.metadata,
        });
        return jsonResponse({ sample: record }, 202);
      }
      if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
        throw Object.assign(
          new Error(
            "Content-Type은 image/png, image/jpeg, image/webp 또는 application/json이어야 합니다.",
          ),
          {
            status: 415,
            code: "unsupported_media_type",
          },
        );
      }
      const bytes = await readNodeBody(nodeRequest, MAX_IMAGE_BYTES);
      const record = await store.ingestPending({
        bytes,
        mimeType: contentType,
        id: requestUrl.searchParams.get("id"),
        label: requestUrl.searchParams.get("label"),
        metadata: {
          source: "raw-image-api",
        },
      });
      return jsonResponse({ sample: record }, 202);
    }

    const imageMatch = /^\/api\/v1\/training-samples\/([^/]+)\/image$/.exec(
      pathName,
    );
    if (method === "GET" && imageMatch) {
      const image = store.imagePath(decodeURIComponent(imageMatch[1]));
      if (!image) return errorResponse(new Error("이미지가 없습니다."), 404);
      return new Response(await readFile(image.path), {
        headers: {
          "content-type": image.mimeType,
          "cache-control": "no-cache",
        },
      });
    }
    const sourceImageMatch =
      /^\/api\/v1\/training-samples\/([^/]+)\/source-image$/.exec(pathName);
    if (method === "GET" && sourceImageMatch) {
      const image = store.imagePath(
        decodeURIComponent(sourceImageMatch[1]),
        "source",
      );
      if (!image) return errorResponse(new Error("원본 이미지가 없습니다."), 404);
      return new Response(await readFile(image.path), {
        headers: {
          "content-type": image.mimeType,
          "cache-control": "no-store",
        },
      });
    }
    const sampleMatch = /^\/api\/v1\/training-samples\/([^/]+)$/.exec(
      pathName,
    );
    if (method === "GET" && sampleMatch) {
      const record = store.get(decodeURIComponent(sampleMatch[1]));
      return record
        ? jsonResponse({ sample: record })
        : errorResponse(new Error("학습 후보를 찾지 못했습니다."), 404);
    }
    if (method === "DELETE" && sampleMatch) {
      const removed = await store.delete(decodeURIComponent(sampleMatch[1]));
      return removed
        ? jsonResponse({ deleted: true })
        : errorResponse(new Error("학습 후보를 찾지 못했습니다."), 404);
    }
    return errorResponse(new Error("API 경로를 찾지 못했습니다."), 404);
  }

  const server = createServer(async (nodeRequest, nodeResponse) => {
    try {
      const host = nodeRequest.headers.host || "127.0.0.1";
      const requestUrl = new URL(nodeRequest.url || "/", `http://${host}`);
      let response;
      const suppliedAccessToken =
        requestUrl.searchParams.get(ACCESS_TOKEN_QUERY);
      if (
        apiKey &&
        !requestUrl.pathname.startsWith("/api/") &&
        suppliedAccessToken !== null
      ) {
        if (!secureEqual(suppliedAccessToken, apiKey)) {
          response = errorResponse(
            Object.assign(new Error("유효하지 않은 접근 토큰입니다."), {
              code: "unauthorized",
            }),
            401,
          );
        } else {
          requestUrl.searchParams.delete(ACCESS_TOKEN_QUERY);
          const cookie = [
            `${ACCESS_COOKIE_NAME}=${encodedCookieToken(apiKey)}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Strict",
            `Max-Age=${ACCESS_COOKIE_MAX_AGE_SECONDS}`,
            ...(usesConfiguredHttpsOrigin(requestUrl, publicUrl)
              ? ["Secure"]
              : []),
          ].join("; ");
          response = new Response(null, {
            status: 303,
            headers: {
              location:
                `${requestUrl.pathname}${requestUrl.search}` || "/",
              "set-cookie": cookie,
              "cache-control": "no-store",
            },
          });
        }
      } else if (requestUrl.pathname.startsWith("/api/")) {
        response = await handleApi(nodeRequest, requestUrl);
      } else {
        const webRequest = new Request(requestUrl, {
          method: nodeRequest.method,
          headers: nodeRequest.headers,
        });
        const staticResponse = await assetFetcher(webRequest);
        response =
          staticResponse.status === 404
            ? await worker.fetch(webRequest)
            : staticResponse;
      }
      nodeResponse.statusCode = response.status;
      for (const [key, value] of response.headers) {
        nodeResponse.setHeader(key, value);
      }
      nodeResponse.setHeader("x-content-type-options", "nosniff");
      nodeResponse.setHeader("referrer-policy", "same-origin");
      nodeResponse.setHeader(
        "content-security-policy",
        STANDALONE_CONTENT_SECURITY_POLICY,
      );
      nodeResponse.setHeader("x-vth-network-mode", accessMode);
      nodeResponse.setHeader(
        "x-vth-access-mode",
        networkAccessible ? "network-accessible" : "loopback-only",
      );
      nodeResponse.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      const response = errorResponse(error, status);
      nodeResponse.statusCode = response.status;
      for (const [key, value] of response.headers) {
        nodeResponse.setHeader(key, value);
      }
      nodeResponse.setHeader(
        "content-security-policy",
        STANDALONE_CONTENT_SECURITY_POLICY,
      );
      nodeResponse.setHeader("x-vth-network-mode", accessMode);
      nodeResponse.setHeader(
        "x-vth-access-mode",
        networkAccessible ? "network-accessible" : "loopback-only",
      );
      nodeResponse.end(Buffer.from(await response.arrayBuffer()));
    }
  });
  return { server, store, access };
}

export async function startVthServer(options = {}) {
  const host = normalizeBindHost(options.host ?? DEFAULT_HOST);
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port는 0~65535 정수여야 합니다.");
  }
  const { server, store, access } = await createVthServer({
    ...options,
    host,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  const baseAccessUrls = buildAccessUrls(
    host,
    actualPort,
    access.publicUrl,
  );
  const accessUrls = Object.fromEntries(
    Object.entries(baseAccessUrls).map(([kind, urls]) => [
      kind,
      urls.map((url) => appendAccessToken(url, access.apiKey)),
    ]),
  );
  const url =
    accessUrls.local[0] ??
    accessUrls.lan[0] ??
    accessUrls.public[0];
  console.log(`유사 산포 검색 (${access.accessMode})`);
  for (const localUrl of accessUrls.local) {
    console.log(`로컬 접속: ${localUrl}`);
  }
  for (const lanUrl of accessUrls.lan) {
    console.log(`LAN 접속: ${lanUrl}`);
  }
  for (const externalUrl of accessUrls.public) {
    console.log(`공인 접속: ${externalUrl}`);
  }
  if (access.networkAccessible && !accessUrls.public.length) {
    console.log(
      "공인 접속 URL은 --public-url https://도메인 형식으로 지정하세요.",
    );
  }
  if (access.apiKeyGenerated) {
    console.log(
      `외부 접속 보호용 API key를 자동 생성했습니다: ${access.apiKey}`,
    );
  } else if (access.apiKeyRequired) {
    console.log("외부 접속 API key 보호가 활성화되었습니다.");
  }
  console.log(
    `학습 API: ${store.stats().ready} ready / ${store.stats().pending} pending`,
  );
  console.log("종료하려면 Ctrl+C를 누르세요.");
  if (options.open) openBrowser(url);
  return {
    server,
    store,
    url,
    accessUrls,
    accessMode: access.accessMode,
    access,
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  startVthServer(options).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { parseArguments };
