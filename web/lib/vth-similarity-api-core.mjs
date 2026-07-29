import jpeg from "jpeg-js";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";

import {
  MAXIMUM_CHART_PANELS,
  cropInterleavedPixels,
  detectChartPanels,
} from "./vth-chart-panel-core.mjs";
import { analyzeForegroundMasks } from "./vth-image-analysis-core.mjs";
import { buildForegroundMasks } from "./vth-image-core.mjs";
import { mergeCandidateSets } from "./vth-learning-core.mjs";
import { clamp, searchCorpus } from "./vth-shape-core.mjs";

export const MAX_SIMILARITY_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_SIMILARITY_IMAGE_PIXELS = 8_000_000;
export const MAX_SIMILARITY_RESULTS = 10;
export const DEFAULT_SIMILARITY_RESULTS = 8;
export { MAXIMUM_CHART_PANELS };
export const SUPPORTED_SIMILARITY_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
];

export class SimilarityApiError extends Error {
  constructor(message, status = 400, code = "invalid_request") {
    super(message);
    this.name = "SimilarityApiError";
    this.status = status;
    this.code = code;
  }
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new SimilarityApiError(
    "이미지 바이트가 필요합니다.",
    400,
    "image_required",
  );
}

function contentTypeOnly(value) {
  return String(value || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function parseTopK(value) {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_SIMILARITY_RESULTS;
  }
  if (!/^\d+$/.test(String(value))) {
    throw new SimilarityApiError(
      `topK는 1~${MAX_SIMILARITY_RESULTS} 정수여야 합니다.`,
      400,
      "invalid_top_k",
    );
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > MAX_SIMILARITY_RESULTS) {
    throw new SimilarityApiError(
      `topK는 1~${MAX_SIMILARITY_RESULTS} 범위여야 합니다.`,
      400,
      "invalid_top_k",
    );
  }
  return parsed;
}

function decodeBase64(value) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (
    !normalized ||
    normalized.length > Math.ceil((MAX_SIMILARITY_IMAGE_BYTES * 4) / 3) + 8 ||
    !/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new SimilarityApiError(
      "Base64 이미지 데이터가 올바르지 않습니다.",
      400,
      "invalid_image_data",
    );
  }
  try {
    const decoded = atob(normalized);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new SimilarityApiError(
      "Base64 이미지 데이터가 올바르지 않습니다.",
      400,
      "invalid_image_data",
    );
  }
}

function decodeImageDataUrl(value) {
  const match =
    /^data:(image\/(?:png|jpeg));base64,([a-zA-Z0-9+/=\s]+)$/i.exec(
      String(value || ""),
    );
  if (!match) {
    throw new SimilarityApiError(
      "imageDataUrl에는 PNG 또는 JPEG Base64 이미지가 필요합니다.",
      415,
      "unsupported_image_type",
    );
  }
  return {
    mimeType: match[1].toLowerCase(),
    bytes: decodeBase64(match[2]),
  };
}

function validateImagePayload(bytes, mimeType) {
  const normalizedBytes = asUint8Array(bytes);
  const normalizedMimeType = contentTypeOnly(mimeType);
  if (!SUPPORTED_SIMILARITY_IMAGE_TYPES.includes(normalizedMimeType)) {
    throw new SimilarityApiError(
      "검색 API는 PNG 또는 JPEG 이미지를 지원합니다.",
      415,
      "unsupported_image_type",
    );
  }
  if (!normalizedBytes.length) {
    throw new SimilarityApiError(
      "빈 이미지는 분석할 수 없습니다.",
      400,
      "image_required",
    );
  }
  if (normalizedBytes.length > MAX_SIMILARITY_IMAGE_BYTES) {
    throw new SimilarityApiError(
      "검색 이미지는 12MB 이하여야 합니다.",
      413,
      "payload_too_large",
    );
  }
  const isPng =
    normalizedBytes.length >= 24 &&
    normalizedBytes[0] === 0x89 &&
    normalizedBytes[1] === 0x50 &&
    normalizedBytes[2] === 0x4e &&
    normalizedBytes[3] === 0x47 &&
    normalizedBytes[4] === 0x0d &&
    normalizedBytes[5] === 0x0a &&
    normalizedBytes[6] === 0x1a &&
    normalizedBytes[7] === 0x0a;
  const isJpeg =
    normalizedBytes.length >= 4 &&
    normalizedBytes[0] === 0xff &&
    normalizedBytes[1] === 0xd8 &&
    normalizedBytes[2] === 0xff;
  if (
    (normalizedMimeType === "image/png" && !isPng) ||
    (normalizedMimeType === "image/jpeg" && !isJpeg)
  ) {
    throw new SimilarityApiError(
      "Content-Type과 실제 이미지 형식이 일치하지 않습니다.",
      422,
      "invalid_image",
    );
  }
  if (isPng) {
    const view = new DataView(
      normalizedBytes.buffer,
      normalizedBytes.byteOffset,
      normalizedBytes.byteLength,
    );
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    validateImageDimensions(width, height);
  }
  return { bytes: normalizedBytes, mimeType: normalizedMimeType };
}

function validateImageDimensions(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_SIMILARITY_IMAGE_PIXELS
  ) {
    throw new SimilarityApiError(
      "이미지 해상도는 최대 800만 픽셀까지 지원합니다.",
      413,
      "image_dimensions_too_large",
    );
  }
}

export async function parseSimilarityImageRequest(request) {
  const url = new URL(request.url);
  const requestContentType = contentTypeOnly(
    request.headers.get("content-type"),
  );
  let topKValue = url.searchParams.get("topK");
  let image;

  if (SUPPORTED_SIMILARITY_IMAGE_TYPES.includes(requestContentType)) {
    image = {
      mimeType: requestContentType,
      bytes: new Uint8Array(await request.arrayBuffer()),
    };
  } else if (requestContentType === "multipart/form-data") {
    const form = await request.formData();
    const file = form.get("image");
    if (
      !file ||
      typeof file === "string" ||
      typeof file.arrayBuffer !== "function"
    ) {
      throw new SimilarityApiError(
        "multipart/form-data의 image 파일이 필요합니다.",
        400,
        "image_required",
      );
    }
    topKValue ??= typeof form.get("topK") === "string"
      ? form.get("topK")
      : null;
    image = {
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    };
  } else if (requestContentType === "application/json") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      throw new SimilarityApiError(
        "JSON 요청 본문이 올바르지 않습니다.",
        400,
        "invalid_json",
      );
    }
    topKValue ??= payload?.topK;
    image = decodeImageDataUrl(payload?.imageDataUrl);
  } else {
    throw new SimilarityApiError(
      "Content-Type은 image/png, image/jpeg, multipart/form-data 또는 application/json이어야 합니다.",
      415,
      "unsupported_content_type",
    );
  }

  return {
    ...validateImagePayload(image.bytes, image.mimeType),
    topK: parseTopK(topKValue),
  };
}

function pngRgb(decoded) {
  let channels = decoded.channels;
  let source = decoded.data;
  if (decoded.palette) {
    source = convertIndexedToRgb(decoded);
    channels = decoded.palette[0]?.length ?? 3;
  } else if (decoded.depth < 8) {
    throw new SimilarityApiError(
      "1/2/4-bit 비팔레트 PNG는 지원하지 않습니다.",
      415,
      "unsupported_png_depth",
    );
  }

  const pixels = decoded.width * decoded.height;
  const output = new Uint8Array(pixels * 3);
  const maximum = decoded.depth === 16 ? 65535 : 255;
  const normalize = (value) => Math.round((Number(value) / maximum) * 255);
  for (let index = 0; index < pixels; index += 1) {
    const sourceOffset = index * channels;
    const outputOffset = index * 3;
    const alpha =
      channels === 2 || channels === 4
        ? normalize(source[sourceOffset + channels - 1])
        : 255;
    const red = normalize(source[sourceOffset]);
    const green =
      channels <= 2
        ? red
        : normalize(source[sourceOffset + 1]);
    const blue =
      channels <= 2
        ? red
        : normalize(source[sourceOffset + 2]);
    output[outputOffset] = Math.round(
      (red * alpha + 255 * (255 - alpha)) / 255,
    );
    output[outputOffset + 1] = Math.round(
      (green * alpha + 255 * (255 - alpha)) / 255,
    );
    output[outputOffset + 2] = Math.round(
      (blue * alpha + 255 * (255 - alpha)) / 255,
    );
  }
  return output;
}

function resizeRgb(
  source,
  width,
  height,
  maximumWidth = 1100,
  maximumHeight = 720,
  options = {},
) {
  const maximumScale =
    Math.min(width, height) <
    (options.upscaleBelowDimension ?? 360)
      ? options.maximumScale ?? 1
      : 1;
  const scale = Math.min(
    maximumScale,
    maximumWidth / width,
    maximumHeight / height,
    Math.sqrt(
      (options.maximumPixels ??
        maximumWidth * maximumHeight) /
        Math.max(1, width * height),
    ),
  );
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  if (targetWidth === width && targetHeight === height) {
    return { data: source, width, height, scale: 1 };
  }

  const output = new Uint8Array(targetWidth * targetHeight * 3);
  const xRatio = width / targetWidth;
  const yRatio = height / targetHeight;
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = (y + 0.5) * yRatio - 0.5;
    const top = Math.max(0, Math.floor(sourceY));
    const bottom = Math.min(height - 1, top + 1);
    const yWeight = Math.max(0, sourceY - top);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = (x + 0.5) * xRatio - 0.5;
      const left = Math.max(0, Math.floor(sourceX));
      const right = Math.min(width - 1, left + 1);
      const xWeight = Math.max(0, sourceX - left);
      const outputOffset = (y * targetWidth + x) * 3;
      const topLeftOffset = (top * width + left) * 3;
      const topRightOffset = (top * width + right) * 3;
      const bottomLeftOffset = (bottom * width + left) * 3;
      const bottomRightOffset = (bottom * width + right) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const topValue =
          source[topLeftOffset + channel] * (1 - xWeight) +
          source[topRightOffset + channel] * xWeight;
        const bottomValue =
          source[bottomLeftOffset + channel] * (1 - xWeight) +
          source[bottomRightOffset + channel] * xWeight;
        output[outputOffset + channel] = Math.round(
          topValue * (1 - yWeight) + bottomValue * yWeight,
        );
      }
    }
  }
  return {
    data: output,
    width: targetWidth,
    height: targetHeight,
    scale,
  };
}

async function decodeSimilarityImage(bytes, mimeType) {
  const validated = validateImagePayload(bytes, mimeType);
  let decoded;
  try {
    if (validated.mimeType === "image/png") {
      const png = decodePng(validated.bytes, { checkCrc: true });
      validateImageDimensions(png.width, png.height);
      decoded = {
        width: png.width,
        height: png.height,
        data: pngRgb(png),
      };
    } else {
      const jpegImage = jpeg.decode(validated.bytes, {
        useTArray: true,
        formatAsRGBA: false,
        tolerantDecoding: true,
        maxResolutionInMP: MAX_SIMILARITY_IMAGE_PIXELS / 1_000_000,
        maxMemoryUsageInMB: 64,
      });
      validateImageDimensions(jpegImage.width, jpegImage.height);
      decoded = jpegImage;
    }
  } catch (error) {
    if (error instanceof SimilarityApiError) throw error;
    throw new SimilarityApiError(
      `이미지를 해석하지 못했습니다: ${
        error instanceof Error ? error.message : "손상된 이미지"
      }`,
      422,
      "invalid_image",
    );
  }

  const resized = resizeRgb(
    decoded.data,
    decoded.width,
    decoded.height,
    1920,
    1200,
    {
      maximumScale: 4,
      maximumPixels: 2_100_000,
    },
  );
  return {
    ...resized,
    sourceData: decoded.data,
    sourceWidth: decoded.width,
    sourceHeight: decoded.height,
  };
}

function analyzeSimilarityPixels(
  data,
  width,
  height,
  sourceScale = 1,
) {
  const foreground = buildForegroundMasks(
    data,
    width,
    height,
    3,
    { sourceScale },
  );
  return analyzeForegroundMasks(
    foreground.broadMask,
    foreground.salientMask,
    width,
    height,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
  );
}

export async function analyzeSimilarityImage(bytes, mimeType) {
  const decoded = await decodeSimilarityImage(bytes, mimeType);
  const analysis = analyzeSimilarityPixels(
    decoded.data,
    decoded.width,
    decoded.height,
    decoded.scale,
  );
  return {
    ...analysis,
    sourceWidth: decoded.sourceWidth,
    sourceHeight: decoded.sourceHeight,
    processedWidth: decoded.width,
    processedHeight: decoded.height,
  };
}

function sourceResolutionPanelPixels(decoded, sourceBounds) {
  const sourceCrop = cropInterleavedPixels(
    decoded.sourceData,
    decoded.sourceWidth,
    decoded.sourceHeight,
    3,
    sourceBounds,
  );
  // Detection stays bounded to one 1100 × 720 slide, but each selected chart
  // is analyzed from the decoded source. This preserves thin Curve strokes and
  // shallow peak/valley turns in dense PPT layouts without allowing a single
  // very large panel to dominate CPU or memory.
  const resized = resizeRgb(
    sourceCrop.pixels,
    sourceCrop.width,
    sourceCrop.height,
    900,
    600,
    {
      maximumScale: 4,
      maximumPixels: 540_000,
    },
  );
  return {
    pixels: resized.data,
    width: resized.width,
    height: resized.height,
    scale: resized.scale,
  };
}

function absoluteImageUrl(value, origin) {
  if (!value) return null;
  try {
    return new URL(String(value), origin).href;
  } catch {
    return null;
  }
}

function rounded(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function resultForApi(result, origin) {
  const score = clamp(Number(result.score));
  return {
    rank: result.rank,
    id: result.id,
    label: result.label,
    score: rounded(score),
    scorePercent: rounded(score * 100, 2),
    stateCount: result.stateCount,
    family: result.family,
    learned: Boolean(result.learned),
    storage: result.storage ?? "corpus",
    imageUrl: absoluteImageUrl(result.image, origin),
    sourceImageUrl: absoluteImageUrl(result.sourceImage, origin),
    scores: {
      curve: rounded(result.curveScore),
      image: rounded(result.imageScore),
      profile: rounded(result.profileScore),
      model: rounded(result.modelScore),
      retrieval: rounded(result.retrievalScore),
      peakCount: rounded(result.countScore),
      peakLocation: rounded(result.locationScore),
      peakWidth: rounded(result.widthScore),
      valley: rounded(result.valleyScore),
      tail: rounded(result.tailScore),
      area: rounded(result.areaScore),
      peakValley: rounded(result.peakValleyScore),
      valleyDepth: rounded(result.valleyDepthScore),
      peakValleyDistance: rounded(result.peakValleyDistanceScore),
      valleyPosition: rounded(result.valleyPositionScore),
    },
    curveHypothesisIndex: result.curveHypothesisIndex,
    reasons: Array.isArray(result.reasons) ? result.reasons.slice(0, 3) : [],
  };
}

function queryForApi(
  analysis,
  mimeType,
  sourceWidth,
  sourceHeight,
  processedWidth,
  processedHeight,
) {
  return {
    mimeType: contentTypeOnly(mimeType),
    sourceWidth,
    sourceHeight,
    processedWidth,
    processedHeight,
    stateCount: analysis.descriptor.stateCount,
    observedStateCount: analysis.descriptor.observedStateCount,
    regularized: Boolean(analysis.descriptor.regularized),
    axesDetected: analysis.axesDetected,
    axisMode: analysis.axisMode,
    curveHypothesisCount: 1 + analysis.alternatives.length,
    distributionCount:
      analysis.distributionSelection.distributionCount,
    selectedDistributionIndex:
      analysis.distributionSelection.selectedIndex,
    irregularityScore: rounded(
      analysis.distributionSelection.irregularityScore,
    ),
    removedLabelCount:
      analysis.preprocessing.primaryMask.removedLabelComponents ?? 0,
  };
}

function sourcePanelBounds(
  panel,
  processedWidth,
  processedHeight,
  sourceWidth,
  sourceHeight,
) {
  const sourceLeft = Math.max(
    0,
    Math.floor((panel.x / processedWidth) * sourceWidth),
  );
  const sourceTop = Math.max(
    0,
    Math.floor((panel.y / processedHeight) * sourceHeight),
  );
  const sourceRight = Math.min(
    sourceWidth,
    Math.ceil(
      ((panel.x + panel.width) / processedWidth) * sourceWidth,
    ),
  );
  const sourceBottom = Math.min(
    sourceHeight,
    Math.ceil(
      ((panel.y + panel.height) / processedHeight) * sourceHeight,
    ),
  );
  return {
    x: sourceLeft,
    y: sourceTop,
    width: Math.max(1, sourceRight - sourceLeft),
    height: Math.max(1, sourceBottom - sourceTop),
  };
}

function normalizedPanelBounds(panel, width, height) {
  return {
    x: rounded(panel.x / width),
    y: rounded(panel.y / height),
    width: rounded(panel.width / width),
    height: rounded(panel.height / height),
  };
}

function wholeImagePanel(width, height, detectedPanel = null) {
  return {
    index: 0,
    x: 0,
    y: 0,
    width,
    height,
    confidence: detectedPanel?.confidence ?? 1,
    detectionReason:
      detectedPanel?.detectionReason ?? "whole-image-fallback",
    axisMode: detectedPanel?.axisMode ?? "content",
  };
}

export async function searchSimilarityImage({
  bytes,
  mimeType,
  topK = DEFAULT_SIMILARITY_RESULTS,
  corpus,
  learnedCandidates = [],
  origin,
}) {
  if (!corpus?.candidates || !Array.isArray(corpus.candidates)) {
    throw new SimilarityApiError(
      "검색 코퍼스가 준비되지 않았습니다.",
      503,
      "corpus_unavailable",
    );
  }
  const safeTopK = parseTopK(topK);
  const startedAt = performance.now();
  const decoded = await decodeSimilarityImage(bytes, mimeType);
  const detected = detectChartPanels(
    decoded.data,
    decoded.width,
    decoded.height,
    3,
    { sourceScale: decoded.scale },
  );
  // A single detected frame is deliberately analyzed as the complete image.
  // This preserves the established single-chart extraction, including titles
  // and outer margins, while enabling independent crops only when multiple
  // charts are confidently present.
  const panels =
    detected.panels.length > 1
      ? detected.panels
      : [
          wholeImagePanel(
            decoded.width,
            decoded.height,
            detected.panels[0],
          ),
        ];
  const candidates = mergeCandidateSets(
    corpus.candidates,
    learnedCandidates,
  );
  const panelResults = panels.map((panel, panelIndex) => {
    const sourceBounds = sourcePanelBounds(
      panel,
      decoded.width,
      decoded.height,
      decoded.sourceWidth,
      decoded.sourceHeight,
    );
    const cropped =
      panels.length === 1
        ? {
            pixels: decoded.data,
            width: decoded.width,
            height: decoded.height,
          }
        : sourceResolutionPanelPixels(decoded, sourceBounds);
    const analysis = analyzeSimilarityPixels(
      cropped.pixels,
      cropped.width,
      cropped.height,
      cropped.scale ?? decoded.scale,
    );
    const ranked = searchCorpus(
      analysis.profile,
      analysis.descriptor,
      candidates,
      corpus.reranker,
      analysis.alternatives,
      corpus.dualEncoder,
    );
    return {
      panelIndex,
      bounds: {
        processed: {
          x: panel.x,
          y: panel.y,
          width: panel.width,
          height: panel.height,
        },
        source: sourceBounds,
        normalized: normalizedPanelBounds(
          panel,
          decoded.width,
          decoded.height,
        ),
      },
      confidence: rounded(panel.confidence),
      detectionReason: panel.detectionReason,
      axisMode: panel.axisMode,
      query: queryForApi(
        analysis,
        mimeType,
        sourceBounds.width,
        sourceBounds.height,
        cropped.width,
        cropped.height,
      ),
      matchedCandidateCount: ranked.length,
      results: ranked
        .slice(0, safeTopK)
        .map((result) => resultForApi(result, origin)),
    };
  });
  const primary = panelResults[0];
  const elapsed = performance.now() - startedAt;
  return {
    model: {
      corpusVersion: corpus.version,
      yScale: corpus.yScale,
      baseCandidateCount: corpus.candidates.length,
      learnedCandidateCount: learnedCandidates.length,
    },
    // These legacy fields continue to represent the first chart in reading
    // order. Existing single-chart clients therefore require no changes.
    query: primary.query,
    candidateCount: candidates.length,
    matchedCandidateCount: primary.matchedCandidateCount,
    processingMs: rounded(elapsed, 2),
    results: primary.results,
    panelCount: panelResults.length,
    panelLayout:
      panelResults.length === 1
        ? { rows: 1, columns: 1 }
        : detected.layout,
    panelDetection: {
      fallbackUsed: Boolean(detected.fallbackUsed),
      readingOrder: "top-to-bottom-left-to-right",
      detectedPanelCount:
        detected.detectedPanelCount ?? detected.panels.length,
      rejectedNonChartCount:
        detected.rejectedNonChartCount ?? 0,
      analyzedPanelCount: panelResults.length,
      maxPanels:
        detected.maxPanels ?? MAXIMUM_CHART_PANELS,
      truncated: Boolean(detected.truncated),
    },
    panels: panelResults,
  };
}
