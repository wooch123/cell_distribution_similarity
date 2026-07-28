import { sharedTrainingStats } from "../../../../db/shared-candidates";
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
    const stats = await sharedTrainingStats();
    return sharedApiJson(request, {
      service: "vth-shared-training-api",
      version: 3,
      status: "ok",
      writable: true,
      sharedAcrossUsers: true,
      originalImageStored: true,
      originalImageSanitizedByBrowser: true,
      standardizedImageGenerated: true,
      openapi: "/shared-training-openapi.json",
      ...stats,
    });
  } catch (error) {
    return sharedApiError(request, error);
  }
}
