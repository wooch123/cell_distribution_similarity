import { deleteSharedTrainingCandidate } from "../../../../../db/shared-candidates";
import {
  requireSharedCandidateId,
  sharedApiError,
  sharedApiJson,
  sharedApiOptions,
} from "../../../../../lib/vth-shared-api";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export function OPTIONS(request: Request) {
  return sharedApiOptions(request);
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const candidateId = requireSharedCandidateId((await context.params).id);
    const deletionToken = request.headers.get("x-vth-delete-token") || "";
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(deletionToken)) {
      return sharedApiJson(
        request,
        {
          error: {
            code: "deletion_token_required",
            message: "업로더의 삭제 토큰이 필요합니다.",
          },
        },
        403,
      );
    }
    const deleted = await deleteSharedTrainingCandidate(
      candidateId,
      deletionToken,
    );
    if (!deleted) {
      return sharedApiJson(
        request,
        {
          error: {
            code: "not_found_or_forbidden",
            message: "삭제할 후보가 없거나 삭제 권한이 없습니다.",
          },
        },
        404,
      );
    }
    return sharedApiJson(request, { id: candidateId, deleted: true });
  } catch (error) {
    return sharedApiError(request, error);
  }
}
