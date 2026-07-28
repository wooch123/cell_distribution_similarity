import {
  createSharedTrainingCandidate,
  listSharedTrainingCandidates,
  sharedTrainingStats,
} from "../../../../db/shared-candidates";
import {
  sharedApiError,
  sharedApiJson,
  sharedApiOptions,
} from "../../../../lib/vth-shared-api";
import { MAX_SHARED_SOURCE_IMAGE_BYTES } from "../../../../lib/vth-shared-training-core.mjs";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

function validateSourceImage(part: FormDataEntryValue | null) {
  if (!(part instanceof File)) {
    throw new Error("메타데이터를 제거한 원본 JPEG 미리보기가 필요합니다.");
  }
  if (
    part.type !== "image/jpeg" ||
    part.size < 4 ||
    part.size > MAX_SHARED_SOURCE_IMAGE_BYTES
  ) {
    throw new Error("원본 미리보기는 3MB 이하 JPEG여야 합니다.");
  }
  return part;
}

export function OPTIONS(request: Request) {
  return sharedApiOptions(request);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") || 500);
    const cursor = url.searchParams.get("cursor") || "";
    const [page, stats] = await Promise.all([
      listSharedTrainingCandidates(url.origin, limit, cursor),
      sharedTrainingStats(),
    ]);
    return sharedApiJson(request, {
      schemaVersion: 3,
      shared: true,
      candidateCount: stats.active,
      returned: page.candidates.length,
      candidates: page.candidates,
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    return sharedApiError(request, error);
  }
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
            message: "공용 학습 요청은 4MB 이하여야 합니다.",
          },
        },
        413,
      );
    }
    if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      throw new Error(
        "공용 학습 요청은 payload와 sourceImage를 포함한 multipart/form-data여야 합니다.",
      );
    }
    const form = await request.formData();
    const payloadPart = form.get("payload");
    if (typeof payloadPart !== "string") {
      throw new Error("공용 학습 payload가 필요합니다.");
    }
    const sourceImagePart = validateSourceImage(form.get("sourceImage"));
    const sourceBytes = new Uint8Array(await sourceImagePart.arrayBuffer());
    if (
      sourceBytes[0] !== 0xff ||
      sourceBytes[1] !== 0xd8 ||
      sourceBytes[2] !== 0xff
    ) {
      throw new Error("원본 미리보기의 JPEG 데이터가 올바르지 않습니다.");
    }
    const url = new URL(request.url);
    const result = await createSharedTrainingCandidate(
      JSON.parse(payloadPart),
      url.origin,
      request.headers.get("cf-connecting-ip") || "",
      { bytes: sourceBytes, mimeType: "image/jpeg" },
    );
    return sharedApiJson(
      request,
      {
        schemaVersion: 2,
        shared: true,
        ...result,
      },
      result.deduplicated ? 200 : 201,
    );
  } catch (error) {
    return sharedApiError(request, error);
  }
}
