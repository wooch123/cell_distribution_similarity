import jpeg from "jpeg-js";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";

import {
  MAXIMUM_CHART_PANELS,
  cropInterleavedPixels,
  detectChartPanels,
} from "./vth-chart-panel-core.mjs";
import {
  analyzeForegroundMasks,
  applyVerifiedWaveformEvidence,
} from "./vth-image-analysis-core.mjs";
import { buildForegroundMasks } from "./vth-image-core.mjs";
import {
  mergeCandidateSets,
  normalizeTrainingSourceSelection,
  trainingSourceSelection,
} from "./vth-learning-core.mjs";
import {
  inputDiagnostic,
  waveformFailureDiagnostic,
} from "./vth-diagnostics-core.mjs";
import {
  alignedCurveSimilarity,
  clamp,
  descriptorFromProfile,
  isValidStateCount,
  resample,
  searchCorpus,
} from "./vth-shape-core.mjs";

export const MAX_SIMILARITY_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_SIMILARITY_IMAGE_PIXELS = 8_000_000;
export const MAX_SIMILARITY_RESULTS = 10;
export const DEFAULT_SIMILARITY_RESULTS = 8;
export const MIN_TRAINING_PROVENANCE_STATE_SIMILARITY = 0.985;
export const MIN_TRAINING_CODEC_STABLE_SIMILARITY = 0.95;
const MIN_TRAINING_STANDARD_CODEC_SIMILARITY = 0.97;
const MIN_SOURCE_SELECTION_MATCH_MARGIN = 0.015;
export { MAXIMUM_CHART_PANELS };
export const SUPPORTED_SIMILARITY_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
];

export class SimilarityApiError extends Error {
  constructor(
    message,
    status = 400,
    code = "invalid_request",
    details = undefined,
  ) {
    super(message);
    this.name = "SimilarityApiError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
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
    inputDiagnostic("image_required"),
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
      inputDiagnostic("decode_failed"),
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
      inputDiagnostic("decode_failed"),
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
      inputDiagnostic("unsupported"),
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
      inputDiagnostic("unsupported", {
        mimeType: normalizedMimeType,
      }),
    );
  }
  if (!normalizedBytes.length) {
    throw new SimilarityApiError(
      "빈 이미지는 분석할 수 없습니다.",
      400,
      "image_required",
      inputDiagnostic("image_required"),
    );
  }
  if (normalizedBytes.length > MAX_SIMILARITY_IMAGE_BYTES) {
    throw new SimilarityApiError(
      "검색 이미지는 12MB 이하여야 합니다.",
      413,
      "payload_too_large",
      inputDiagnostic("resource_limit", {
        byteLength: normalizedBytes.length,
        maximumBytes: MAX_SIMILARITY_IMAGE_BYTES,
      }),
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
      inputDiagnostic("decode_failed", {
        mimeType: normalizedMimeType,
      }),
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
      "기능상 차트 크기 제한과 별개로 안전한 디코딩은 800만 픽셀까지 지원합니다.",
      413,
      "image_dimensions_too_large",
      inputDiagnostic("resource_limit", {
        width,
        height,
        pixelCount:
          Number.isFinite(width * height)
            ? width * height
            : undefined,
        maximumPixels: MAX_SIMILARITY_IMAGE_PIXELS,
      }),
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
        inputDiagnostic("image_required"),
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
    if (
      typeof payload?.imageDataUrl !== "string" ||
      !payload.imageDataUrl.trim()
    ) {
      throw new SimilarityApiError(
        "JSON 요청에 imageDataUrl 이미지가 필요합니다.",
        400,
        "image_required",
        inputDiagnostic("image_required"),
      );
    }
    image = decodeImageDataUrl(payload?.imageDataUrl);
  } else {
    throw new SimilarityApiError(
      "Content-Type은 image/png, image/jpeg, multipart/form-data 또는 application/json이어야 합니다.",
      415,
      "unsupported_content_type",
      inputDiagnostic("unsupported", {
        contentType: requestContentType,
      }),
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
      inputDiagnostic("unsupported", {
        pngDepth: decoded.depth,
      }),
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
      inputDiagnostic("decode_failed"),
    );
  }

  const resized = resizeRgb(
    decoded.data,
    decoded.width,
    decoded.height,
    1920,
    1200,
    {
      maximumScale: 16,
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
    { sourceScale },
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

function distributionWaveformNotFound({
  message,
  detected,
  decoded,
  reason,
} = {}) {
  const details = waveformFailureDiagnostic(detected, {
    reason,
    message,
    sourceWidth: decoded?.sourceWidth,
    sourceHeight: decoded?.sourceHeight,
    processedWidth: decoded?.width,
    processedHeight: decoded?.height,
    sourceScale: decoded?.scale,
  });
  throw new SimilarityApiError(
    details.message,
    422,
    "distribution_waveform_not_found",
    details,
  );
}

function waveformOnlySource(detected, panel, width, height) {
  if (panel.detectionReason === "whole-image-fallback") {
    // The detector only emits this fallback after verifying the complete
    // source as a waveform. Deep valleys can fragment into several rejected
    // geometric regions, so that diagnostic count is not a purity signal.
    return true;
  }
  const widthRatio = panel.width / Math.max(1, width);
  const heightRatio = panel.height / Math.max(1, height);
  const areaRatio =
    (panel.width * panel.height) / Math.max(1, width * height);
  const leftMargin = panel.x / Math.max(1, width);
  const topMargin = panel.y / Math.max(1, height);
  const rightMargin =
    (width - panel.x - panel.width) / Math.max(1, width);
  const bottomMargin =
    (height - panel.y - panel.height) / Math.max(1, height);
  return (
    widthRatio >= 0.7 &&
    heightRatio >= 0.58 &&
    areaRatio >= 0.48 &&
    leftMargin <= 0.2 &&
    rightMargin <= 0.2 &&
    topMargin <= 0.24 &&
    bottomMargin <= 0.24
  );
}

const LOW_RESOLUTION_FRAGMENT_REASONS = new Set([
  "arbitrary-waveform-region",
  "frameless-curve-region",
]);

function lowResolutionFragmentationDetected(
  detected,
  decoded,
) {
  if (
    Number(decoded?.scale) < 8 ||
    decoded?.sourceWidth > 180 ||
    decoded?.sourceHeight > 180 ||
    detected?.panels?.length < 2 ||
    detected.panels.length > 6 ||
    !detected.panels.every(
      (panel) =>
        panel.axisMode === "content" &&
        LOW_RESOLUTION_FRAGMENT_REASONS.has(
          panel.detectionReason,
        ),
    )
  ) {
    return false;
  }
  const sourceArea = Math.max(
    1,
    decoded.width * decoded.height,
  );
  const areaRatios = detected.panels.map(
    (panel) =>
      (panel.width * panel.height) / sourceArea,
  );
  const commonTop = Math.max(
    ...detected.panels.map((panel) => panel.y),
  );
  const commonBottom = Math.min(
    ...detected.panels.map(
      (panel) => panel.y + panel.height - 1,
    ),
  );
  const minimumPanelHeight = Math.min(
    ...detected.panels.map((panel) => panel.height),
  );
  const commonVerticalOverlapRatio =
    Math.max(0, commonBottom - commonTop + 1) /
    Math.max(1, minimumPanelHeight);
  // Upscaled fragments of one source Curve occupy one shared vertical band.
  // Real tiny frameless charts may also have small individual bounds, but
  // charts scattered into separate rows have no common vertical overlap and
  // must remain independent panels.
  const oneHorizontalFragmentBand =
    commonVerticalOverlapRatio >= 0.45;
  return (
    Math.max(...areaRatios) <= 0.12 &&
    areaRatios.reduce((sum, ratio) => sum + ratio, 0) <=
      0.2 &&
    oneHorizontalFragmentBand
  );
}

function lowResolutionStandaloneTopologyMismatch(
  decoded,
  detected,
  extractedDescriptor,
) {
  const extractedStateCount = Number(
    extractedDescriptor?.stateCount ??
      extractedDescriptor,
  );
  if (
    Number(decoded?.scale) < 4 ||
    Math.max(
      decoded?.sourceWidth ?? Number.POSITIVE_INFINITY,
      decoded?.sourceHeight ?? Number.POSITIVE_INFINITY,
    ) > 180 ||
    detected?.panels?.length !== 1 ||
    !isValidStateCount(extractedStateCount)
  ) {
    return false;
  }
  const independentlyDenseSixteenState =
    extractedStateCount === 16 &&
    Number(extractedDescriptor?.observedStateCount) === 16 &&
    extractedDescriptor?.regularized === false &&
    Math.min(
      decoded.sourceWidth,
      decoded.sourceHeight,
    ) >= 160;
  if (independentlyDenseSixteenState) return false;
  const peakWidths = Array.isArray(
    extractedDescriptor?.peakWidths,
  )
    ? extractedDescriptor.peakWidths.filter(Number.isFinite)
    : [];
  const orderedPeakWidths = [...peakWidths].sort(
    (left, right) => left - right,
  );
  const medianPeakWidth =
    orderedPeakWidths.length > 0
      ? orderedPeakWidths[
          Math.floor(orderedPeakWidths.length / 2)
        ]
      : 0;
  const collapsedBoundaryValley =
    Array.isArray(extractedDescriptor?.valleyDepths) &&
    extractedDescriptor.valleyDepths.some(
      (depth) => Number(depth) <= 0.002,
    );
  const degenerateBoundaryTopology =
    extractedStateCount >= 2 &&
    ((medianPeakWidth > 0 &&
      Math.min(...peakWidths) <= medianPeakWidth * 0.12) ||
      (Array.isArray(extractedDescriptor?.valleyDepths) &&
        extractedDescriptor.valleyDepths.some(
          (depth) => Number(depth) <= 0.025,
        )));
  const panel = detected.panels[0];
  const sourceArea = Math.max(
    1,
    decoded.width * decoded.height,
  );
  const panelAreaRatio =
    (panel.width * panel.height) / sourceArea;
  const isolatedWaveform =
    waveformOnlySource(
      detected,
      panel,
      decoded.width,
      decoded.height,
    ) ||
    (Math.max(
      decoded.sourceWidth,
      decoded.sourceHeight,
    ) <= 400 &&
      panelAreaRatio <= 0.12);
  if (!isolatedWaveform) return false;
  const rawAnalysis = analyzeSimilarityPixels(
    decoded.sourceData,
    decoded.sourceWidth,
    decoded.sourceHeight,
  );
  const rawStateCount = Number(
    rawAnalysis?.descriptor?.stateCount,
  );
  const extractedPeakLocations = Array.isArray(
    extractedDescriptor?.peakLocations,
  )
    ? extractedDescriptor.peakLocations
    : [];
  const rawPeakLocations = Array.isArray(
    rawAnalysis?.descriptor?.peakLocations,
  )
    ? rawAnalysis.descriptor.peakLocations
    : [];
  const peakLocationTolerance = Math.max(
    0.035,
    3 /
      Math.max(
        1,
        decoded.sourceWidth,
        decoded.sourceHeight,
      ),
  );
  const exactPhysicalDescriptor = (descriptor, stateCount) => {
    const valleyCount = Math.max(0, stateCount - 1);
    return (
      isValidStateCount(stateCount) &&
      descriptor?.regularized === false &&
      Number(descriptor?.observedStateCount) === stateCount &&
      descriptor?.peakLocations?.length === stateCount &&
      descriptor?.peakWidths?.length === stateCount &&
      descriptor?.valleyLocations?.length === valleyCount &&
      descriptor?.valleyHeights?.length === valleyCount &&
      descriptor?.valleyDepths?.length === valleyCount &&
      descriptor?.valleyPositionRatios?.length === valleyCount &&
      descriptor?.peakValleyDistances?.length ===
        valleyCount * 2 &&
      descriptor?.tailSlopes?.length === 2
    );
  };
  const exactTopologyPersistsAcrossScales =
    exactPhysicalDescriptor(
      extractedDescriptor,
      extractedStateCount,
    ) &&
    exactPhysicalDescriptor(
      rawAnalysis?.descriptor,
      rawStateCount,
    ) &&
    rawStateCount === extractedStateCount &&
    rawPeakLocations.length ===
      extractedPeakLocations.length &&
    rawPeakLocations.every(
      (location, index) =>
        Math.abs(
          location - extractedPeakLocations[index],
        ) <= peakLocationTolerance,
    );
  // A sub-pixel boundary turn can survive enlargement as an apparently exact
  // State, but a real narrow tail or close peak/valley can have the same width
  // signature. Reject that ambiguous geometry only when the State count and
  // normalized peak locations do not persist at the original raster scale.
  // This keeps genuine asymmetric VTH shapes while still failing closed when
  // interpolation invents a boundary State.
  if (degenerateBoundaryTopology) {
    // Identical-scale persistence alone cannot legitimize a one-pixel label
    // spur when the alleged separating valley has no measurable depth. Such
    // a zero-depth turn is not a physical peak/valley pair at either scale.
    if (collapsedBoundaryValley) return true;
    return !exactTopologyPersistsAcrossScales;
  }
  return (
    !isValidStateCount(rawStateCount) ||
    rawStateCount !== extractedStateCount
  );
}

function recoverDeskewedWholeImageDistribution(
  detected,
  decoded,
) {
  if (
    Number(decoded?.scale) < 2 ||
    Math.max(
      decoded?.sourceWidth ?? Number.POSITIVE_INFINITY,
      decoded?.sourceHeight ?? Number.POSITIVE_INFINITY,
    ) > 400 ||
    (detected?.panels?.length ?? 0) > 6
  ) {
    return detected;
  }
  const processedArea = Math.max(
    1,
    decoded.width * decoded.height,
  );
  const largestDetectedAreaRatio =
    detected.panels.length > 0
      ? Math.max(
          ...detected.panels.map(
            (panel) =>
              (panel.width * panel.height) / processedArea,
          ),
        )
      : 0;
  if (largestDetectedAreaRatio > 0.2) return detected;

  const analysis = analyzeSimilarityPixels(
    decoded.data,
    decoded.width,
    decoded.height,
    decoded.scale,
  );
  const descriptor = analysis.descriptor;
  const peakCount = descriptor?.peakLocations?.length ?? 0;
  const valleyCount =
    descriptor?.valleyLocations?.length ?? 0;
  const plotBounds = analysis.preprocessing?.bounds;
  const plotAreaRatio = plotBounds
    ? ((plotBounds.right - plotBounds.left + 1) *
        (plotBounds.bottom - plotBounds.top + 1)) /
      processedArea
    : 0;
  const exactPhysicalTopology =
    analysis.preprocessing?.deskewApplied === true &&
    plotBounds?.axesDetected === true &&
    ["rectangle", "l-axis"].includes(plotBounds.axisMode) &&
    plotAreaRatio >= 0.45 &&
    analysis.distributionSelection?.targetDistributionCount ===
      1 &&
    peakCount >= 2 &&
    descriptor.stateCount === peakCount &&
    descriptor.observedStateCount === peakCount &&
    descriptor.regularized !== true &&
    descriptor.peakWidths?.length === peakCount &&
    valleyCount === peakCount - 1 &&
    descriptor.valleyHeights?.length === valleyCount &&
    descriptor.valleyDepths?.length === valleyCount &&
    descriptor.valleyPositionRatios?.length === valleyCount &&
    descriptor.peakValleyDistances?.length ===
      valleyCount * 2;
  if (!exactPhysicalTopology) return detected;

  const panel = {
    index: 0,
    left: 0,
    top: 0,
    right: decoded.width - 1,
    bottom: decoded.height - 1,
    x: 0,
    y: 0,
    width: decoded.width,
    height: decoded.height,
    confidence: 0.96,
    axisMode: plotBounds.axisMode,
    detectionReason: "whole-image-fallback",
    verifiedWaveform: {
      profile: [...analysis.profile],
      descriptor,
      source: "low-resolution-deskewed-whole-image",
    },
  };
  return {
    ...detected,
    panels: [panel],
    layout: { rows: 1, columns: 1 },
    fallbackUsed: true,
    detectedPanelCount: 1,
    diagnostics: {
      ...detected.diagnostics,
      lowResolutionDeskewedWholeImageRecovery: {
        applied: true,
        deskewAngle:
          analysis.preprocessing?.deskewAngle ?? 0,
        peakCount,
        valleyCount,
        rejectedFragmentCount:
          detected.panels.length,
      },
    },
  };
}

function trainingProvenanceHypotheses(
  analysis,
  candidateKind,
) {
  const extractedSeries =
    Array.isArray(analysis.series) && analysis.series.length
      ? analysis.series
      : [
          {
            seriesIndex: 0,
            profile: analysis.profile,
            descriptor: analysis.descriptor,
            selected: true,
          },
        ];
  const analysisHypotheses = [
    ...extractedSeries.map((series, seriesIndex) => ({
      profile: series.profile,
      descriptor: series.descriptor,
      candidateKind,
      seriesIndex:
        Number.isInteger(series.seriesIndex)
          ? series.seriesIndex
          : seriesIndex,
    })),
    ...(analysis.alternatives ?? []).map(
      (alternative) => ({
        ...alternative,
        candidateKind: `${candidateKind}-alternative`,
        seriesIndex:
          Number.isInteger(analysis.selectedSeriesIndex)
            ? analysis.selectedSeriesIndex
            : 0,
      }),
    ),
  ];
  const profileTopologyHypotheses =
    analysisHypotheses.flatMap((hypothesis) => {
      const rebuiltDescriptor = descriptorFromProfile(
        hypothesis.profile,
      );
      if (
        rebuiltDescriptor.stateCount ===
        hypothesis.descriptor?.stateCount
      ) {
        return [];
      }
      return [
        {
          ...hypothesis,
          descriptor: rebuiltDescriptor,
          candidateKind:
            `${hypothesis.candidateKind}-profile-topology`,
        },
      ];
    });
  return {
    extractedSeries,
    hypotheses: [
      ...analysisHypotheses,
      ...profileTopologyHypotheses,
    ],
  };
}

function appendDistinctProvenanceHypotheses(
  target,
  candidates,
) {
  for (const candidate of candidates) {
    if (
      target.some(
        (existing) =>
          existing.descriptor?.stateCount ===
            candidate.descriptor?.stateCount &&
          alignedCurveSimilarity(
            existing.profile,
            candidate.profile,
          ) >= 0.9999,
      )
    ) {
      continue;
    }
    target.push(candidate);
  }
}

function summarizeTrainingProvenanceMatch(
  hypotheses,
  normalizedProfile,
  normalizedStateCount,
) {
  const scoredHypotheses = hypotheses.map((hypothesis) => ({
    hypothesis,
    similarity: alignedCurveSimilarity(
      hypothesis.profile,
      normalizedProfile,
    ),
  }));
  const matchingStateSimilarity = Math.max(
    0,
    ...scoredHypotheses
      .filter(
        ({ hypothesis }) =>
          hypothesis.descriptor?.stateCount ===
          normalizedStateCount,
      )
      .map(({ similarity }) => similarity),
  );
  const acceptedHypotheses = scoredHypotheses.filter(
    ({ hypothesis, similarity }) => {
      const codecStateCount = Number(
        hypothesis.descriptor?.stateCount,
      );
      const standardCodecStableMatch =
        similarity >=
          MIN_TRAINING_STANDARD_CODEC_SIMILARITY &&
        isValidStateCount(codecStateCount) &&
        Math.abs(
          codecStateCount - normalizedStateCount,
        ) <= 1;
      const sevenNineCodecAliasMatch =
        similarity >=
          MIN_TRAINING_CODEC_STABLE_SIMILARITY &&
        ((normalizedStateCount === 7 &&
          codecStateCount === 9) ||
          (normalizedStateCount === 9 &&
            codecStateCount === 7));
      return (
        (codecStateCount === normalizedStateCount &&
          similarity >=
            MIN_TRAINING_PROVENANCE_STATE_SIMILARITY) ||
        standardCodecStableMatch ||
        sevenNineCodecAliasMatch
      );
    },
  );
  const authoritativeScoredHypothesis =
    acceptedHypotheses.reduce(
      (best, current) =>
        !best || current.similarity > best.similarity
          ? current
          : best,
      null,
    );
  return {
    accepted: authoritativeScoredHypothesis !== null,
    authoritativeScoredHypothesis,
    matchingStateSimilarity,
    profileSimilarity:
      authoritativeScoredHypothesis?.similarity ?? 0,
  };
}

function sourceSelectionImageMismatch(message, details) {
  throw new SimilarityApiError(
    message,
    422,
    "source_selection_image_mismatch",
    details,
  );
}

function sourceSelectionSeriesThreshold(
  sourceStateCount,
  submittedStateCount,
) {
  if (sourceStateCount === submittedStateCount) {
    // Browser Canvas, jpeg-js and the search endpoint use bounded rasters
    // with slightly different interpolation. Reuse the existing strict
    // standard-codec floor so the same physical series remains selectable
    // without permitting nearby unrelated same-State shapes.
    return MIN_TRAINING_STANDARD_CODEC_SIMILARITY;
  }
  if (
    isValidStateCount(sourceStateCount) &&
    Math.abs(sourceStateCount - submittedStateCount) <= 1
  ) {
    return MIN_TRAINING_STANDARD_CODEC_SIMILARITY;
  }
  if (
    (sourceStateCount === 7 && submittedStateCount === 9) ||
    (sourceStateCount === 9 && submittedStateCount === 7)
  ) {
    return MIN_TRAINING_CODEC_STABLE_SIMILARITY;
  }
  return Number.POSITIVE_INFINITY;
}

function matchSourceSelectionSeries(
  extractedSeries,
  normalizedProfile,
  normalizedStateCount,
) {
  const scored = extractedSeries
    .map((series, seriesIndex) => {
      const sourceStateCount = Number(
        series.descriptor?.stateCount ??
          descriptorFromProfile(series.profile).stateCount,
      );
      const profileSimilarity = alignedCurveSimilarity(
        series.profile,
        normalizedProfile,
      );
      const threshold = sourceSelectionSeriesThreshold(
        sourceStateCount,
        normalizedStateCount,
      );
      return {
        series,
        seriesIndex,
        sourceStateCount,
        profileSimilarity,
        threshold,
        accepted: profileSimilarity >= threshold,
      };
    })
    .sort(
      (left, right) =>
        Number(right.accepted) - Number(left.accepted) ||
        right.profileSimilarity - left.profileSimilarity ||
        left.seriesIndex - right.seriesIndex,
    );
  const accepted = scored.filter((candidate) => candidate.accepted);
  if (!accepted.length) {
    sourceSelectionImageMismatch(
      "선택한 색상 시리즈와 제출한 profile/State를 학습 원본에서 강하게 일치시키지 못했습니다.",
      {
        submittedStateCount: normalizedStateCount,
        bestProfileSimilarity:
          scored[0]?.profileSimilarity ?? 0,
        sourceSeriesStateCounts: scored.map(
          (candidate) => candidate.sourceStateCount,
        ),
      },
    );
  }
  const best = accepted[0];
  const competitor = accepted[1];
  if (
    competitor &&
    best.profileSimilarity - competitor.profileSimilarity <
      MIN_SOURCE_SELECTION_MATCH_MARGIN
  ) {
    sourceSelectionImageMismatch(
      "제출한 profile/State와 강하게 일치하는 색상 시리즈가 둘 이상이라 선택 결과가 모호합니다.",
      {
        submittedStateCount: normalizedStateCount,
        bestProfileSimilarity: best.profileSimilarity,
        competingProfileSimilarity:
          competitor.profileSimilarity,
        matchedSeriesIndexes: [
          best.seriesIndex,
          competitor.seriesIndex,
        ],
      },
    );
  }
  return best;
}

function encodeAuthoritativeSourceJpeg(sourceCrop) {
  const pixelCount = sourceCrop.width * sourceCrop.height;
  const rgba = new Uint8Array(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    const sourceOffset = index * 3;
    const outputOffset = index * 4;
    rgba[outputOffset] = sourceCrop.pixels[sourceOffset];
    rgba[outputOffset + 1] =
      sourceCrop.pixels[sourceOffset + 1];
    rgba[outputOffset + 2] =
      sourceCrop.pixels[sourceOffset + 2];
    rgba[outputOffset + 3] = 255;
  }
  const encoded = jpeg.encode(
    {
      data: rgba,
      width: sourceCrop.width,
      height: sourceCrop.height,
    },
    92,
  ).data;
  return {
    bytes: Uint8Array.from(encoded),
    mimeType: "image/jpeg",
    width: sourceCrop.width,
    height: sourceCrop.height,
  };
}

function cloneAuthoritativeDescriptor(descriptor) {
  return {
    ...descriptor,
    peakLocations: [...descriptor.peakLocations],
    peakWidths: [...descriptor.peakWidths],
    valleyHeights: [...descriptor.valleyHeights],
    valleyLocations: [...descriptor.valleyLocations],
    valleyDepths: [...descriptor.valleyDepths],
    valleyPositionRatios: [
      ...descriptor.valleyPositionRatios,
    ],
    peakValleyDistances: [
      ...descriptor.peakValleyDistances,
    ],
    tailSlopes: [...descriptor.tailSlopes],
  };
}

function hasStrictPhysicalTopology(descriptor) {
  const stateCount = Number(descriptor?.stateCount);
  const valleyCount = Math.max(0, stateCount - 1);
  return (
    isValidStateCount(stateCount) &&
    descriptor.peakLocations?.length === stateCount &&
    descriptor.peakLocations.every(
      (location, index, locations) =>
        Number.isFinite(location) &&
        (index === 0 || locations[index - 1] < location),
    ) &&
    descriptor.peakWidths?.length === stateCount &&
    descriptor.peakWidths.every(
      (width) => Number.isFinite(width) && width > 0,
    ) &&
    descriptor.valleyLocations?.length === valleyCount &&
    descriptor.valleyLocations.every(
      (location, index) =>
        Number.isFinite(location) &&
        descriptor.peakLocations[index] < location &&
        location < descriptor.peakLocations[index + 1],
    ) &&
    descriptor.valleyHeights?.length === valleyCount &&
    descriptor.valleyHeights.every(Number.isFinite) &&
    descriptor.valleyDepths?.length === valleyCount &&
    descriptor.valleyDepths.every(Number.isFinite) &&
    descriptor.valleyPositionRatios?.length === valleyCount &&
    descriptor.valleyPositionRatios.every(
      (ratio) =>
        Number.isFinite(ratio) && ratio > 0 && ratio < 1,
    ) &&
    descriptor.peakValleyDistances?.length ===
      valleyCount * 2 &&
    descriptor.peakValleyDistances.every(Number.isFinite) &&
    descriptor.tailSlopes?.length === 2 &&
    descriptor.tailSlopes.every(Number.isFinite)
  );
}

function authoritativeDescriptorForProfile(
  profile,
  descriptor,
) {
  const authoritative =
    hasStrictPhysicalTopology(descriptor)
      ? descriptor
      : descriptorFromProfile(profile);
  return cloneAuthoritativeDescriptor(authoritative);
}

function readingOrderPanels(detected, decoded) {
  const detectedPanels =
    detected.panels.length === 1 &&
    detected.panels[0].detectionReason ===
      "whole-image-fallback"
      ? [
          wholeImagePanel(
            decoded.width,
            decoded.height,
            detected.panels[0],
          ),
        ]
      : detected.panels;
  return detectedPanels
    .map((panel, originalIndex) => ({
      panel,
      originalIndex,
      readingOrderIndex: Number.isInteger(panel.index)
        ? panel.index
        : originalIndex,
    }))
    .sort(
      (left, right) =>
        left.readingOrderIndex - right.readingOrderIndex ||
        left.originalIndex - right.originalIndex,
    )
    .map(({ panel }, index) => ({
      ...panel,
      index,
    }));
}

function validateSelectedFullDocumentWaveform({
  decoded,
  detected,
  normalizedSourceSelection,
  normalizedProfile,
  normalizedStateCount,
}) {
  const panels = readingOrderPanels(detected, decoded);
  if (
    detected.truncated ||
    panels.length > MAXIMUM_CHART_PANELS ||
    panels.length !== normalizedSourceSelection.panelCount
  ) {
    sourceSelectionImageMismatch(
      `선택 정보의 차트 수(${normalizedSourceSelection.panelCount})와 학습 원본에서 읽기 순서로 검출한 차트 수(${panels.length})가 일치하지 않습니다.`,
      {
        submittedPanelCount:
          normalizedSourceSelection.panelCount,
        detectedPanelCount: panels.length,
        maximumPanelCount: MAXIMUM_CHART_PANELS,
        truncated: Boolean(detected.truncated),
      },
    );
  }
  const matchedPanelIndex =
    normalizedSourceSelection.panelIndex;
  const panel = panels[matchedPanelIndex];
  if (!panel) {
    sourceSelectionImageMismatch(
      "선택한 차트를 학습 원본의 읽기 순서에서 찾지 못했습니다.",
      {
        submittedPanelIndex: matchedPanelIndex,
        detectedPanelCount: panels.length,
      },
    );
  }
  const sourceBounds = sourcePanelBounds(
    panel,
    decoded.width,
    decoded.height,
    decoded.sourceWidth,
    decoded.sourceHeight,
  );
  const sourceCrop = cropInterleavedPixels(
    decoded.sourceData,
    decoded.sourceWidth,
    decoded.sourceHeight,
    3,
    sourceBounds,
  );
  const analysisRaster = resizeRgb(
    sourceCrop.pixels,
    sourceCrop.width,
    sourceCrop.height,
    900,
    600,
    {
      maximumScale: 16,
      maximumPixels: 540_000,
    },
  );
  const analysis = applyVerifiedWaveformEvidence(
    analyzeSimilarityPixels(
      analysisRaster.data,
      analysisRaster.width,
      analysisRaster.height,
      analysisRaster.scale ?? decoded.scale,
    ),
    panel.verifiedWaveform,
  );
  const selectedDecoded = {
    data: analysisRaster.data,
    width: analysisRaster.width,
    height: analysisRaster.height,
    scale: analysisRaster.scale,
    sourceData: sourceCrop.pixels,
    sourceWidth: sourceCrop.width,
    sourceHeight: sourceCrop.height,
  };
  const selectedDetected = {
    panels: [
      wholeImagePanel(
        analysisRaster.width,
        analysisRaster.height,
      ),
    ],
    fallbackUsed: true,
  };
  if (
    Number(analysisRaster.scale) >= 4 &&
    lowResolutionStandaloneTopologyMismatch(
      selectedDecoded,
      selectedDetected,
      analysis.descriptor,
    )
  ) {
    distributionWaveformNotFound({
      detected,
      decoded,
      reason: "low_resolution_insufficient",
    });
  }
  const { series: extractedSeries } =
    normalizedAnalysisSeries(analysis);
  if (
    extractedSeries.length !==
    normalizedSourceSelection.seriesCount
  ) {
    sourceSelectionImageMismatch(
      `선택 정보의 색상 시리즈 수(${normalizedSourceSelection.seriesCount})와 선택한 차트에서 검증한 시리즈 수(${extractedSeries.length})가 일치하지 않습니다.`,
      {
        submittedSeriesCount:
          normalizedSourceSelection.seriesCount,
        detectedSeriesCount: extractedSeries.length,
        matchedPanelIndex,
      },
    );
  }
  const matched = matchSourceSelectionSeries(
    extractedSeries,
    normalizedProfile,
    normalizedStateCount,
  );
  const authoritativeProfile = resample(
    matched.series.profile,
    256,
  );
  const authoritativeDescriptor =
    authoritativeDescriptorForProfile(
      authoritativeProfile,
      analysis.preprocessing?.verifiedWaveformEvidence
        ?.applied === true
        ? matched.series.descriptor
        : null,
    );
  return {
    panelCount: panels.length,
    matchedPanelIndex,
    seriesCount: extractedSeries.length,
    matchedSeriesIndex: matched.seriesIndex,
    fallbackUsed: Boolean(detected.fallbackUsed),
    detectionReason: panel.detectionReason,
    sourceBounds,
    stateCount: authoritativeDescriptor.stateCount,
    profileSimilarity: matched.profileSimilarity,
    stateHypothesisMatched:
      matched.sourceStateCount === normalizedStateCount &&
      matched.profileSimilarity >=
        MIN_TRAINING_PROVENANCE_STATE_SIMILARITY,
    authoritativeProfile,
    authoritativeDescriptor,
    authoritativeSourceImage:
      encodeAuthoritativeSourceJpeg(sourceCrop),
  };
}

/**
 * Verify that a ready-to-search training payload is backed by the submitted
 * source image rather than by caller-controlled Curve JSON alone.
 *
 * Raw `/training-images` uploads deliberately bypass this gate while pending.
 * Legacy selector-free requests retain the isolated-waveform contract.
 * Selector-bearing requests provide the complete document: the server
 * re-detects up to 30 charts, chooses the reading-order panel, and binds the
 * submitted shape to one unambiguous source-derived color series.
 */
export async function validateTrainingWaveformImage({
  bytes,
  mimeType,
  profile,
  stateCount,
  sourceSelection,
}) {
  if (
    !Array.isArray(profile) ||
    profile.length !== 256 ||
    profile.some((value) => !Number.isFinite(Number(value)))
  ) {
    throw new SimilarityApiError(
      "학습 provenance 검증에는 256-point profile이 필요합니다.",
      400,
      "invalid_training_profile",
    );
  }
  const normalizedProfile = profile.map(Number);
  const normalizedSourceSelection =
    normalizeTrainingSourceSelection(sourceSelection);
  const suppliedDescriptor = descriptorFromProfile(normalizedProfile);
  const normalizedStateCount = Number(
    stateCount ?? suppliedDescriptor.stateCount,
  );
  if (!isValidStateCount(normalizedStateCount)) {
    throw new SimilarityApiError(
      "학습 provenance의 State는 1~20 정수여야 합니다.",
      400,
      "invalid_training_profile",
    );
  }

  const decoded = await decodeSimilarityImage(bytes, mimeType);
  let detected = detectChartPanels(
    decoded.data,
    decoded.width,
    decoded.height,
    3,
    { sourceScale: decoded.scale },
  );
  detected = recoverDeskewedWholeImageDistribution(
    detected,
    decoded,
  );
  if (!detected.panels.length) {
    distributionWaveformNotFound({
      detected,
      decoded,
    });
  }
  if (lowResolutionFragmentationDetected(detected, decoded)) {
    distributionWaveformNotFound({
      detected,
      decoded,
      reason: "low_resolution_insufficient",
    });
  }
  if (normalizedSourceSelection) {
    return validateSelectedFullDocumentWaveform({
      decoded,
      detected,
      normalizedSourceSelection,
      normalizedProfile,
      normalizedStateCount,
    });
  }
  if (
    Number(decoded.scale) >= 4 &&
    detected.panels.length === 1
  ) {
    const standaloneAnalysis = analyzeSimilarityPixels(
      decoded.data,
      decoded.width,
      decoded.height,
      decoded.scale,
    );
    if (
      lowResolutionStandaloneTopologyMismatch(
        decoded,
        detected,
        standaloneAnalysis.descriptor,
      )
    ) {
      distributionWaveformNotFound({
        detected,
        decoded,
        reason: "low_resolution_insufficient",
      });
    }
  }
  if (
    detected.panels.length !== 1 ||
    !waveformOnlySource(
      detected,
      detected.panels[0],
      decoded.width,
      decoded.height,
    )
  ) {
    distributionWaveformNotFound({
      message:
        "학습 원본에는 다른 텍스트·표·도형 없이 분포 파형 하나만 있어야 합니다.",
      detected,
      decoded,
      reason: "candidates_ambiguous",
    });
  }
  const panel = detected.panels[0];
  const sourceBounds = sourcePanelBounds(
    panel,
    decoded.width,
    decoded.height,
    decoded.sourceWidth,
    decoded.sourceHeight,
  );
  // The browser has already isolated `sourceImageDataUrl` to this chart.
  // Detection here is a provenance purity gate; cropping its accepted panel
  // again would trim the same chart twice. Re-rasterize the accepted preview
  // with the browser analysis limits so PNG/JPEG encoding cannot select a
  // different hypothesis merely because the server used a larger raster.
  const provenanceRaster = resizeRgb(
    decoded.sourceData,
    decoded.sourceWidth,
    decoded.sourceHeight,
    1100,
    720,
    {
      maximumScale: 16,
      maximumPixels: 800_000,
    },
  );
  const cropped = {
    pixels: provenanceRaster.data,
    width: provenanceRaster.width,
    height: provenanceRaster.height,
    scale: provenanceRaster.scale,
  };
  const analysis = analyzeSimilarityPixels(
    cropped.pixels,
    cropped.width,
    cropped.height,
    cropped.scale ?? decoded.scale,
  );
  const initial = trainingProvenanceHypotheses(
    analysis,
    "browser-raster",
  );
  const extractedSeries = initial.extractedSeries;
  const hypotheses = [...initial.hypotheses];
  let match = summarizeTrainingProvenanceMatch(
    hypotheses,
    normalizedProfile,
    normalizedStateCount,
  );

  // JPEG antialiasing can move a shallow shoulder across a binary-mask
  // threshold at one exact raster width. Only after the browser-sized fast
  // path fails, retry the same already-isolated source at native resolution
  // and one bounded high-resolution raster. These are independent
  // source-derived Curve hypotheses; no similarity threshold is relaxed.
  if (!match.accepted) {
    const fallbackRasters = [
      resizeRgb(
        decoded.sourceData,
        decoded.sourceWidth,
        decoded.sourceHeight,
        decoded.sourceWidth,
        decoded.sourceHeight,
        {
          maximumScale: 1,
          maximumPixels:
            decoded.sourceWidth * decoded.sourceHeight,
        },
      ),
      resizeRgb(
        decoded.sourceData,
        decoded.sourceWidth,
        decoded.sourceHeight,
        1700,
        1200,
        {
          maximumScale: 16,
          maximumPixels: 2_100_000,
        },
      ),
    ];
    const seenRasterSizes = new Set([
      `${cropped.width}x${cropped.height}`,
    ]);
    for (
      let index = 0;
      index < fallbackRasters.length && !match.accepted;
      index += 1
    ) {
      const raster = fallbackRasters[index];
      const rasterKey = `${raster.width}x${raster.height}`;
      if (seenRasterSizes.has(rasterKey)) continue;
      seenRasterSizes.add(rasterKey);
      const fallbackAnalysis = analyzeSimilarityPixels(
        raster.data,
        raster.width,
        raster.height,
        raster.scale ?? decoded.scale,
      );
      const fallback =
        trainingProvenanceHypotheses(
          fallbackAnalysis,
          index === 0
            ? "native-raster"
            : "bounded-high-raster",
        );
      appendDistinctProvenanceHypotheses(
        hypotheses,
        fallback.hypotheses,
      );
      match = summarizeTrainingProvenanceMatch(
        hypotheses,
        normalizedProfile,
        normalizedStateCount,
      );
    }
  }

  if (!match.accepted) {
    const closestHypotheses = hypotheses
      .map((hypothesis) => ({
        candidateKind: hypothesis.candidateKind,
        stateCount: Number(
          hypothesis.descriptor?.stateCount,
        ),
        similarity: rounded(
          alignedCurveSimilarity(
            hypothesis.profile,
            normalizedProfile,
          ),
        ),
      }))
      .sort(
        (left, right) =>
          right.similarity - left.similarity,
      )
      .slice(0, 6);
    throw new SimilarityApiError(
      "학습 원본의 파형과 제출한 profile이 일치하지 않습니다.",
      422,
      "training_profile_image_mismatch",
      {
        submittedStateCount: normalizedStateCount,
        matchingStateSimilarity: rounded(
          match.matchingStateSimilarity,
        ),
        closestHypotheses,
      },
    );
  }
  const {
    authoritativeScoredHypothesis,
    matchingStateSimilarity,
    profileSimilarity,
  } = match;
  const authoritativeHypothesis =
    authoritativeScoredHypothesis.hypothesis;
  const authoritativeProfile = resample(
    authoritativeHypothesis.profile,
    256,
  );
  const authoritativeDescriptor =
    authoritativeDescriptorForProfile(
      authoritativeProfile,
      null,
    );

  return {
    panelCount: 1,
    seriesCount: extractedSeries.length,
    matchedSeriesIndex:
      authoritativeHypothesis.seriesIndex ?? 0,
    fallbackUsed: Boolean(detected.fallbackUsed),
    detectionReason: panel.detectionReason,
    sourceBounds,
    stateCount: authoritativeDescriptor.stateCount,
    profileSimilarity,
    stateHypothesisMatched:
      matchingStateSimilarity >=
      MIN_TRAINING_PROVENANCE_STATE_SIMILARITY,
    authoritativeProfile,
    authoritativeDescriptor,
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
      maximumScale: 16,
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

function credibleStructureDescriptor(analysis) {
  const primaryDescriptor = analysis?.descriptor;
  const primaryProfile = analysis?.profile;
  if (
    !primaryDescriptor ||
    !Array.isArray(primaryProfile) ||
    primaryDescriptor.regularized !== true
  ) {
    return primaryDescriptor;
  }
  const supportedStateCounts = new Set([2, 4, 8, 16]);
  const primaryObserved = Number(
    primaryDescriptor.observedStateCount,
  );
  const candidates = (analysis.alternatives ?? [])
    .map((alternative) => {
      const descriptor = alternative?.descriptor;
      const peakLocations = descriptor?.peakLocations;
      const stateCount = Number(descriptor?.stateCount);
      const observedStateCount = Number(
        descriptor?.observedStateCount,
      );
      if (
        !supportedStateCounts.has(stateCount) ||
        stateCount < primaryDescriptor.stateCount ||
        stateCount > primaryDescriptor.stateCount * 2 ||
        observedStateCount < stateCount - 1 ||
        observedStateCount <= primaryObserved ||
        !Array.isArray(peakLocations) ||
        peakLocations.length !== stateCount ||
        !Array.isArray(alternative.profile)
      ) {
        return null;
      }
      const orderedLocations = [...peakLocations].sort(
        (left, right) => left - right,
      );
      const peakSpan =
        orderedLocations.at(-1) - orderedLocations[0];
      const spacings = orderedLocations
        .slice(1)
        .map(
          (location, index) =>
            location - orderedLocations[index],
        )
        .sort((left, right) => left - right);
      const medianSpacing =
        spacings[Math.floor(spacings.length / 2)] ?? 0;
      const spacingRegular =
        medianSpacing > 0 &&
        spacings[0] >= medianSpacing * 0.28 &&
        spacings.at(-1) <= medianSpacing * 2;
      const meaningfulValleyCount = (
        descriptor.valleyDepths ?? []
      ).reduce(
        (count, depth) => count + Number(depth >= 0.02),
        0,
      );
      const curveSimilarity = alignedCurveSimilarity(
        primaryProfile,
        alternative.profile,
      );
      if (
        peakSpan < 0.72 ||
        !spacingRegular ||
        meaningfulValleyCount <
          Math.ceil((stateCount - 1) * 0.55) ||
        curveSimilarity < 0.82
      ) {
        return null;
      }
      return {
        descriptor,
        curveSimilarity,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.descriptor.observedStateCount -
          left.descriptor.observedStateCount ||
        right.descriptor.stateCount -
          left.descriptor.stateCount ||
        right.curveSimilarity - left.curveSimilarity,
    );
  return candidates[0]?.descriptor ?? primaryDescriptor;
}

function queryForApi(
  analysis,
  mimeType,
  sourceWidth,
  sourceHeight,
  processedWidth,
  processedHeight,
) {
  const structureDescriptor =
    credibleStructureDescriptor(analysis);
  const peakCount =
    structureDescriptor.peakLocations?.length ?? 0;
  const valleyCount =
    structureDescriptor.valleyLocations?.length ?? 0;
  const expectedValleyCount = Math.max(0, peakCount - 1);
  const orderedPeakValleyTopology =
    structureDescriptor.peakWidths?.every(
      (width) => Number.isFinite(width) && width > 0,
    ) &&
    structureDescriptor.peakLocations?.every(
      (location, index, locations) =>
        Number.isFinite(location) &&
        (index === 0 || locations[index - 1] < location),
    ) &&
    structureDescriptor.valleyLocations?.every(
      (location, index) =>
        Number.isFinite(location) &&
        structureDescriptor.peakLocations[index] < location &&
        location <
          structureDescriptor.peakLocations[index + 1],
    ) &&
    structureDescriptor.valleyPositionRatios?.every(
      (ratio) =>
        Number.isFinite(ratio) && ratio > 0 && ratio < 1,
    );
  const topologyConsistent =
    structureDescriptor.stateCount === peakCount &&
    structureDescriptor.peakWidths?.length === peakCount &&
    valleyCount === expectedValleyCount &&
    structureDescriptor.valleyHeights?.length ===
      expectedValleyCount &&
    structureDescriptor.valleyDepths?.length ===
      expectedValleyCount &&
    structureDescriptor.valleyPositionRatios?.length ===
      expectedValleyCount &&
    structureDescriptor.peakValleyDistances?.length ===
      expectedValleyCount * 2 &&
    structureDescriptor.tailSlopes?.length === 2 &&
    orderedPeakValleyTopology === true;
  return {
    mimeType: contentTypeOnly(mimeType),
    sourceWidth,
    sourceHeight,
    processedWidth,
    processedHeight,
    stateCount: structureDescriptor.stateCount,
    observedStateCount:
      structureDescriptor.observedStateCount,
    peakCount,
    valleyCount,
    topologyConsistent,
    regularized: Boolean(structureDescriptor.regularized),
    axesDetected: analysis.axesDetected,
    axisMode: analysis.axisMode,
    curveHypothesisCount: 1 + analysis.alternatives.length,
    distributionCount:
      analysis.distributionSelection.distributionCount,
    targetDistributionCount:
      analysis.distributionSelection
        .targetDistributionCount ??
      analysis.series?.length ??
      1,
    distributionSelectionMode:
      analysis.distributionSelection.mode,
    colorSeriesPolicy:
      analysis.preprocessing.colorSeriesPolicy
        ? {
            maximumIndependentSeries:
              analysis.preprocessing.colorSeriesPolicy
                .maximumIndependentSeries,
            collapsedToMostIrregular:
              analysis.preprocessing.colorSeriesPolicy
                .collapsedToMostIrregular,
            detectedSeriesCount:
              analysis.preprocessing.colorSeriesPolicy
                .detectedSeriesCount,
            targetSeriesCount:
              analysis.preprocessing.colorSeriesPolicy
                .targetSeriesCount,
          }
        : null,
    selectedDistributionIndex:
      analysis.distributionSelection.selectedIndex,
    irregularityScore: rounded(
      analysis.distributionSelection.irregularityScore,
    ),
    removedLabelCount:
      analysis.preprocessing.primaryMask.removedLabelComponents ?? 0,
  };
}

function trainingWaveformForApi(profile, descriptor) {
  const normalizedProfile = resample(profile, 256).map(Number);
  return {
    profile: normalizedProfile,
    descriptor: authoritativeDescriptorForProfile(
      normalizedProfile,
      descriptor,
    ),
  };
}

function normalizedAnalysisSeries(analysis) {
  const declared =
    Array.isArray(analysis.series) && analysis.series.length
      ? analysis.series
      : [
          {
            seriesIndex: 0,
            sourceIndex: 0,
            profile: analysis.profile,
            descriptor: analysis.descriptor,
            irregularityScore:
              analysis.distributionSelection.irregularityScore,
            separationMode:
              analysis.preprocessing.distributionSeparationMode ??
              "single",
            selected: true,
          },
        ];
  const selectedByFlag = declared.findIndex(
    (series) => series.selected === true,
  );
  const selectedSeriesIndex =
    Number.isInteger(analysis.selectedSeriesIndex) &&
    analysis.selectedSeriesIndex >= 0 &&
    analysis.selectedSeriesIndex < declared.length
      ? analysis.selectedSeriesIndex
      : selectedByFlag >= 0
        ? selectedByFlag
        : 0;
  return {
    series: declared,
    selectedSeriesIndex,
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
    verifiedWaveform: detectedPanel?.verifiedWaveform,
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
  let detected = detectChartPanels(
    decoded.data,
    decoded.width,
    decoded.height,
    3,
    { sourceScale: decoded.scale },
  );
  detected = recoverDeskewedWholeImageDistribution(
    detected,
    decoded,
  );
  if (!detected.panels.length) {
    distributionWaveformNotFound({
      detected,
      decoded,
    });
  }
  if (lowResolutionFragmentationDetected(detected, decoded)) {
    distributionWaveformNotFound({
      detected,
      decoded,
      reason: "low_resolution_insufficient",
    });
  }
  // Only the verified whole-image fallback keeps the complete input. A
  // geometric or frameless singleton is cropped as well, so nearby prose,
  // tables and explanation shapes cannot leak into Curve extraction merely
  // because the document contains one valid distribution.
  const panels =
    detected.panels.length === 1 &&
    detected.panels[0].detectionReason === "whole-image-fallback"
      ? [
          wholeImagePanel(
            decoded.width,
            decoded.height,
            detected.panels[0],
          ),
        ]
      : detected.panels;
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
      panel.detectionReason === "whole-image-fallback"
        ? {
            pixels: decoded.data,
            width: decoded.width,
            height: decoded.height,
          }
        : sourceResolutionPanelPixels(decoded, sourceBounds);
    const analysis = applyVerifiedWaveformEvidence(
      analyzeSimilarityPixels(
        cropped.pixels,
        cropped.width,
        cropped.height,
        cropped.scale ?? decoded.scale,
      ),
      panel.verifiedWaveform,
    );
    const {
      series,
      selectedSeriesIndex,
    } = normalizedAnalysisSeries(analysis);
    const seriesResults = series.map((seriesAnalysis, seriesIndex) => {
      const selected = seriesIndex === selectedSeriesIndex;
      const alternatives = selected
        ? analysis.alternatives
        : [];
      const ranked = searchCorpus(
        seriesAnalysis.profile,
        seriesAnalysis.descriptor,
        candidates,
        corpus.reranker,
        alternatives,
        corpus.dualEncoder,
      );
      const query = queryForApi(
        {
          ...analysis,
          profile: seriesAnalysis.profile,
          descriptor: seriesAnalysis.descriptor,
          alternatives,
          distributionSelection: {
            ...analysis.distributionSelection,
            selectedIndex:
              seriesAnalysis.sourceIndex ?? seriesIndex,
            irregularityScore:
              seriesAnalysis.irregularityScore ??
              analysis.distributionSelection.irregularityScore,
          },
        },
        mimeType,
        sourceBounds.width,
        sourceBounds.height,
        cropped.width,
        cropped.height,
      );
      const trainingSelection = trainingSourceSelection({
        panelIndex,
        panelCount: panels.length,
        seriesIndex,
        seriesCount: series.length,
      });
      const pixelMeasuredPhysicalTopology =
        analysis.preprocessing?.verifiedWaveformEvidence
          ?.applied === true ||
        analysis.preprocessing?.repeatedArchEvidence
          ?.applied === true ||
        analysis.preprocessing?.upperArcEvidence
          ?.applied === true ||
        seriesAnalysis.descriptor
          ?.labelBoundaryFramePairRemoved === true;
      const exactMeasuredSeriesDescriptor =
        pixelMeasuredPhysicalTopology &&
        seriesAnalysis.descriptor?.regularized !== true &&
        seriesAnalysis.descriptor?.observedStateCount ===
          seriesAnalysis.descriptor?.stateCount
          ? seriesAnalysis.descriptor
          : null;
      const trainingWaveform = trainingWaveformForApi(
        seriesAnalysis.profile,
        exactMeasuredSeriesDescriptor,
      );
      return {
        seriesIndex,
        sourceIndex:
          seriesAnalysis.sourceIndex ?? seriesIndex,
        selected,
        separationMode:
          seriesAnalysis.separationMode ?? "single",
        irregularityScore: rounded(
          seriesAnalysis.irregularityScore ??
            analysis.distributionSelection.irregularityScore,
        ),
        trainingSelection,
        ...trainingWaveform,
        query,
        matchedCandidateCount: ranked.length,
        results: ranked
          .slice(0, safeTopK)
          .map((result) => resultForApi(result, origin)),
      };
    });
    const selectedSeries =
      seriesResults[selectedSeriesIndex] ?? seriesResults[0];
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
      seriesCount: seriesResults.length,
      selectedSeriesIndex,
      series: seriesResults,
      trainingSelection: selectedSeries.trainingSelection,
      profile: selectedSeries.profile,
      descriptor: selectedSeries.descriptor,
      // Compatibility fields continue to mirror the representative (the
      // most-irregular distribution when several color traces coexist).
      query: selectedSeries.query,
      matchedCandidateCount:
        selectedSeries.matchedCandidateCount,
      results: selectedSeries.results,
    };
  });
  const primary = panelResults[0];
  if (
    lowResolutionStandaloneTopologyMismatch(
      decoded,
      detected,
      primary.descriptor,
    )
  ) {
    distributionWaveformNotFound({
      detected,
      decoded,
      reason: "low_resolution_insufficient",
    });
  }
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
    trainingSelection: primary.trainingSelection,
    profile: primary.profile,
    descriptor: primary.descriptor,
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
