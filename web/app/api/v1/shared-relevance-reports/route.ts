import { createSharedRelevanceReport } from "../../../../db/shared-relevance";
import {
  sharedApiError,
  sharedApiJson,
  sharedApiOptions,
} from "../../../../lib/vth-shared-api";

const MAX_REQUEST_BYTES = 256 * 1024;

export function OPTIONS(request: Request) {
  return sharedApiOptions(request);
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_REQUEST_BYTES) {
      return sharedApiJson(
        request,
        {
          error: {
            code: "payload_too_large",
            message: "공용 relevance report는 256KB 이하여야 합니다.",
          },
        },
        413,
      );
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      return sharedApiJson(
        request,
        {
          error: {
            code: "payload_too_large",
            message: "공용 relevance report는 256KB 이하여야 합니다.",
          },
        },
        413,
      );
    }
    const result = await createSharedRelevanceReport(
      JSON.parse(body),
      request.headers.get("cf-connecting-ip") || "",
    );
    return sharedApiJson(
      request,
      {
        schemaVersion: 1,
        shared: true,
        ...result,
      },
      result.updated ? 200 : 201,
    );
  } catch (error) {
    return sharedApiError(request, error);
  }
}
