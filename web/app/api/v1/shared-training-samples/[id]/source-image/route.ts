import { getSharedCandidateSourceImage } from "../../../../../../db/shared-candidates";
import {
  requireSharedCandidateId,
  sharedApiError,
  sharedApiHeaders,
  sharedApiOptions,
} from "../../../../../../lib/vth-shared-api";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export function OPTIONS(request: Request) {
  return sharedApiOptions(request);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const candidateId = requireSharedCandidateId((await context.params).id);
    const object = await getSharedCandidateSourceImage(candidateId);
    if (!object) {
      return new Response("Not found", {
        status: 404,
        headers: sharedApiHeaders(request),
      });
    }
    const headers = sharedApiHeaders(request, {
      "cache-control": "public, max-age=86400",
      "content-type": object.httpMetadata?.contentType || "image/jpeg",
      etag: object.httpEtag,
    });
    return new Response(object.body, { headers });
  } catch (error) {
    return sharedApiError(request, error);
  }
}
