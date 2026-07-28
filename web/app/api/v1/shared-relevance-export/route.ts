import {
  exportSharedRelevanceReports,
  sharedRelevanceStats,
} from "../../../../db/shared-relevance";
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
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") || 10_000);
    const [reports, stats] = await Promise.all([
      exportSharedRelevanceReports(limit),
      sharedRelevanceStats(),
    ]);
    return sharedApiJson(request, {
      schemaVersion: 1,
      exportType: "vth-shared-relevance-reports",
      generatedAt: new Date().toISOString(),
      privacy: {
        rawImagesIncluded: false,
        originalFilenamesIncluded: false,
        queryCodesHashed: true,
        annotatorCodesHashed: true,
      },
      ...stats,
      exportedReports: reports.length,
      reports,
    });
  } catch (error) {
    return sharedApiError(request, error);
  }
}
