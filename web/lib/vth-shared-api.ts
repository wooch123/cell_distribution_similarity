import { isAllowedSharedTrainingOrigin } from "./vth-shared-training-core.mjs";

export function sharedApiHeaders(
  request: Request,
  extra: HeadersInit = {},
) {
  const origin = request.headers.get("origin");
  const headers = new Headers(extra);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }
  headers.set("vary", "Origin");
  if (origin && isAllowedSharedTrainingOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

export function sharedApiOptions(request: Request) {
  return new Response(null, {
    status: 204,
    headers: sharedApiHeaders(request, {
      "access-control-allow-headers":
        "content-type, x-vth-delete-token",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-max-age": "86400",
    }),
  });
}

export function sharedApiJson(
  request: Request,
  body: unknown,
  status = 200,
) {
  return Response.json(body, {
    status,
    headers: sharedApiHeaders(request),
  });
}

export function sharedApiError(request: Request, error: unknown) {
  const message =
    error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
  const status =
    message.includes("하루에") || message.includes("저장 한도")
      ? 429
      : message.includes("준비되지 않았") ||
          message.includes("no such table")
        ? 503
        : 400;
  return sharedApiJson(
    request,
    {
      error: {
        code:
          status === 429
            ? "rate_limited"
            : status === 503
              ? "storage_unavailable"
              : "invalid_request",
        message,
      },
    },
    status,
  );
}

export function requireSharedCandidateId(value: string) {
  if (!/^shared-[0-9a-f-]{36}$/i.test(value)) {
    throw new Error("공용 학습 후보 ID가 올바르지 않습니다.");
  }
  return value;
}

export function requireSharedRelevanceId(value: string) {
  if (!/^relevance-[0-9a-f-]{36}$/i.test(value)) {
    throw new Error("공용 relevance report ID가 올바르지 않습니다.");
  }
  return value;
}
