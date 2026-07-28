import { resetSharedTrainingCandidates } from "../../../../../db/shared-candidates";

const RESET_CONFIRMATION = "RESET_SHARED_TRAINING_DATA";

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function tokensMatch(provided: string, expected: string) {
  if (expected.length < 32 || provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export async function POST(request: Request) {
  const { env } = await import("cloudflare:workers");
  const expectedToken = String(
    (env as typeof env & { VTH_ADMIN_RESET_TOKEN?: string })
      .VTH_ADMIN_RESET_TOKEN ?? "",
  );
  const providedToken = request.headers.get("x-vth-admin-reset-token") ?? "";
  if (!tokensMatch(providedToken, expectedToken)) {
    return json(
      {
        error: {
          code: "not_found",
          message: "요청한 경로를 찾을 수 없습니다.",
        },
      },
      404,
    );
  }

  let body: { confirmation?: unknown };
  try {
    body = (await request.json()) as { confirmation?: unknown };
  } catch {
    return json(
      {
        error: {
          code: "invalid_request",
          message: "초기화 확인 값이 필요합니다.",
        },
      },
      400,
    );
  }
  if (body.confirmation !== RESET_CONFIRMATION) {
    return json(
      {
        error: {
          code: "confirmation_required",
          message: "초기화 확인 값이 일치하지 않습니다.",
        },
      },
      400,
    );
  }

  try {
    const result = await resetSharedTrainingCandidates();
    return json({
      reset: true,
      scope: "shared_training_samples",
      ...result,
    });
  } catch {
    return json(
      {
        error: {
          code: "reset_failed",
          message: "공용 학습 데이터를 초기화하지 못했습니다.",
        },
      },
      500,
    );
  }
}
