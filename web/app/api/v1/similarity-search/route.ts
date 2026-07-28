import corpus from "../../../../public/corpus-index.json";
import { listSharedTrainingCandidates } from "../../../../db/shared-candidates";
import {
  SimilarityApiError,
  MAXIMUM_CHART_PANELS,
  MAX_SIMILARITY_IMAGE_BYTES,
  MAX_SIMILARITY_RESULTS,
  SUPPORTED_SIMILARITY_IMAGE_TYPES,
  parseSimilarityImageRequest,
  searchSimilarityImage,
} from "../../../../lib/vth-similarity-api-core.mjs";
import {
  MAX_SHARED_CANDIDATE_PAGE_SIZE,
  MAX_SHARED_CANDIDATES,
} from "../../../../lib/vth-shared-training-core.mjs";

const API_NAME = "vth-similarity-search-api";
const API_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;

function apiHeaders(extra: HeadersInit = {}) {
  const headers = new Headers(extra);
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "access-control-allow-headers",
    "content-type, authorization, x-api-key",
  );
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-max-age", "86400");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function apiJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: apiHeaders() });
}

function errorResponse(error: unknown) {
  const requestId = crypto.randomUUID();
  if (error instanceof SimilarityApiError) {
    return apiJson(
      {
        requestId,
        error: {
          code: error.code,
          message: error.message,
        },
      },
      error.status,
    );
  }
  console.error(`[similarity-search:${requestId}]`, error);
  return apiJson(
    {
      requestId,
      error: {
        code: "internal_error",
        message: "유사 산포 검색을 처리하지 못했습니다.",
      },
    },
    500,
  );
}

async function configuredApiKey() {
  const nodeValue =
    typeof process !== "undefined"
      ? String(process.env.VTH_SEARCH_API_KEY || "").trim()
      : "";
  if (nodeValue) return nodeValue;
  try {
    const { env } = await import("cloudflare:workers");
    return String(
      (env as typeof env & { VTH_SEARCH_API_KEY?: string })
        .VTH_SEARCH_API_KEY || "",
    ).trim();
  } catch {
    // Local production previews do not implement the cloudflare: URL scheme.
    return "";
  }
}

async function requireConfiguredApiKey(request: Request) {
  const expected = await configuredApiKey();
  if (!expected) return;
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const supplied = request.headers.get("x-api-key") || bearer;
  if (supplied !== expected) {
    throw new SimilarityApiError(
      "유효한 API 키가 필요합니다.",
      401,
      "unauthorized",
    );
  }
}

async function loadSharedCandidates(origin: string) {
  const candidates: unknown[] = [];
  let cursor = "";
  do {
    const page = await listSharedTrainingCandidates(
      origin,
      MAX_SHARED_CANDIDATE_PAGE_SIZE,
      cursor,
    );
    candidates.push(...page.candidates);
    cursor = page.nextCursor || "";
  } while (cursor && candidates.length < MAX_SHARED_CANDIDATES);
  return candidates;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: apiHeaders() });
}

export async function GET() {
  return apiJson({
    service: API_NAME,
    version: API_VERSION,
    status: "ok",
    method: "POST",
    openapi: "/similarity-search-openapi.json",
    supportedImageTypes: SUPPORTED_SIMILARITY_IMAGE_TYPES,
    maxImageBytes: MAX_SIMILARITY_IMAGE_BYTES,
    maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
    maxResults: MAX_SIMILARITY_RESULTS,
    multiChart: {
      supported: true,
      ranking: "per-panel",
      readingOrder: "top-to-bottom-left-to-right",
      maxPanels: MAXIMUM_CHART_PANELS,
      overflowPolicy: "highest-confidence-then-reading-order",
    },
    inputHandling: {
      stored: false,
      usedForTraining: false,
      processing: "transient-memory-only",
    },
  });
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
      throw new SimilarityApiError(
        "검색 요청 본문은 20MB 이하여야 합니다.",
        413,
        "payload_too_large",
      );
    }

    await requireConfiguredApiKey(request);
    const requestBody = await request.arrayBuffer();
    if (requestBody.byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new SimilarityApiError(
        "검색 요청 본문은 20MB 이하여야 합니다.",
        413,
        "payload_too_large",
      );
    }
    const parsed = await parseSimilarityImageRequest(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: requestBody,
      }),
    );
    const origin = new URL(request.url).origin;
    let learnedCandidates: unknown[] = [];
    const warnings: Array<{ code: string; message: string }> = [];
    try {
      learnedCandidates = await loadSharedCandidates(origin);
    } catch {
      // Base corpus search remains available if optional shared storage is offline.
      warnings.push({
        code: "shared_candidates_unavailable",
        message: "공용 학습 후보를 이번 검색에 반영하지 못했습니다.",
      });
    }

    const result = await searchSimilarityImage({
      ...parsed,
      corpus,
      // The shared candidate schema is validated at ingestion; the JS search
      // core intentionally remains framework-agnostic and exposes no TS type.
      learnedCandidates: learnedCandidates as never[],
      origin,
    });
    if (result.panelDetection.truncated) {
      warnings.push({
        code: "panel_limit_applied",
        message: `${result.panelDetection.detectedPanelCount}개 차트를 감지해 품질이 높은 ${result.panelDetection.analyzedPanelCount}개를 분석했습니다.`,
      });
    }
    return apiJson({
      schemaVersion: API_VERSION,
      requestId: crypto.randomUUID(),
      service: API_NAME,
      inputHandling: {
        stored: false,
        usedForTraining: false,
        processing: "transient-memory-only",
      },
      warnings,
      ...result,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
