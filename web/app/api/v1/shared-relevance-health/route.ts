import { sharedRelevanceStats } from "../../../../db/shared-relevance";
import {
  sharedApiError,
  sharedApiJson,
  sharedApiOptions,
} from "../../../../lib/vth-shared-api";

export function OPTIONS(request: Request) {
  return sharedApiOptions(request);
}

export async function GET(request: Request) {
  try {
    return sharedApiJson(request, {
      service: "vth-shared-relevance-api",
      version: 1,
      status: "ok",
      writable: true,
      sharedAcrossUsers: true,
      rawImageStored: false,
      rawFilenameStored: false,
      anonymousCodesHashed: true,
      export: "/api/v1/shared-relevance-export",
      ...(await sharedRelevanceStats()),
    });
  } catch (error) {
    return sharedApiError(request, error);
  }
}
