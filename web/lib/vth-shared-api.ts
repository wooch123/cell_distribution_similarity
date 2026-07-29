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
  const typedError =
    error && typeof error === "object"
      ? (error as {
          status?: unknown;
          code?: unknown;
          details?: unknown;
        })
      : {};
  const explicitStatus = Number(typedError.status);
  const status =
    Number.isInteger(explicitStatus) &&
    explicitStatus >= 400 &&
    explicitStatus <= 599
      ? explicitStatus
      : message.includes("하루에") || message.includes("저장 한도")
        ? 429
        : message.includes("준비되지 않았") ||
            message.includes("no such table")
          ? 503
          : 400;
  const explicitCode =
    typeof typedError.code === "string" &&
    /^[a-z0-9_]{3,64}$/.test(typedError.code)
      ? typedError.code
      : "";
  const details =
    typedError.details &&
    typeof typedError.details === "object" &&
    !Array.isArray(typedError.details)
      ? (typedError.details as Record<string, unknown>)
      : undefined;
  return sharedApiJson(
    request,
    {
      error: {
        code:
          explicitCode ||
          (status === 429
            ? "rate_limited"
            : status === 503
              ? "storage_unavailable"
              : "invalid_request"),
        message,
        ...(typeof details?.reason === "string"
          ? { reasonCode: details.reason }
          : {}),
        ...(details ? { details } : {}),
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
