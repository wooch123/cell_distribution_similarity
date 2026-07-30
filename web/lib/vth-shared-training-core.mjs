import {
  descriptorFromProfile,
  isValidStateCount,
  tryDescriptorFromPeakHints,
} from "./vth-shape-core.mjs";
import { normalizeTrainingSourceSelection } from "./vth-learning-core.mjs";

export const SHARED_TRAINING_CONSENT_VERSION = "2026-07-30-v3";
const LEGACY_SHARED_TRAINING_CONSENT_VERSION = "2026-07-28-v2";
export const MAX_SHARED_SOURCE_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_SHARED_CANDIDATES = 2000;
export const MAX_SHARED_CANDIDATES_PER_DAY = 200;
export const MAX_SHARED_CANDIDATE_PAGE_SIZE = 500;

const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,128}$/;
const SHARED_CANDIDATE_ID_PATTERN =
  /^shared-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function numberArray(value, expectedLength, field) {
  const lengthMatches =
    typeof expectedLength === "number"
      ? value?.length === expectedLength
      : value?.length >= expectedLength.min &&
        value?.length <= expectedLength.max;
  if (!Array.isArray(value) || !lengthMatches) {
    throw new Error(`${field} 길이가 올바르지 않습니다.`);
  }
  const result = value.map(Number);
  if (
    result.some(
      (item) => !Number.isFinite(item) || item < 0 || item > 1.5,
    )
  ) {
    throw new Error(`${field}에 유효하지 않은 수치가 있습니다.`);
  }
  return result;
}

export function validateSharedTrainingPayload(payload) {
  if (payload?.sharingConsent !== true) {
    throw new Error("공용 학습 후보 공유 동의가 필요합니다.");
  }
  const requestedConsentVersion = String(
    payload?.consentVersion || "",
  );
  const requestsSourceSelection =
    payload?.sourceSelection !== undefined;
  const legacySelectorFreeConsent =
    !requestsSourceSelection &&
    requestedConsentVersion ===
      LEGACY_SHARED_TRAINING_CONSENT_VERSION;
  if (
    requestedConsentVersion !==
      SHARED_TRAINING_CONSENT_VERSION &&
    !legacySelectorFreeConsent
  ) {
    throw new Error("지원하지 않는 공유 동의 버전입니다.");
  }
  if (!TOKEN_PATTERN.test(String(payload?.contributorToken || ""))) {
    throw new Error("기여자 토큰이 올바르지 않습니다.");
  }
  if (!TOKEN_PATTERN.test(String(payload?.deletionToken || ""))) {
    throw new Error("삭제 토큰이 올바르지 않습니다.");
  }

  const profile = numberArray(payload?.profile, 256, "profile");
  if (Math.max(...profile) - Math.min(...profile) < 0.05) {
    throw new Error("학습 Curve의 형상 변화가 너무 작습니다.");
  }
  const stateCount = Number(payload?.descriptor?.stateCount);
  if (!isValidStateCount(stateCount)) {
    throw new Error("State는 1~20 정수여야 합니다.");
  }
  const suppliedPeakLocations = numberArray(
    payload?.descriptor?.peakLocations,
    stateCount,
    "peakLocations",
  );
  const suppliedPeakCount = suppliedPeakLocations.length;
  const valleyCount = suppliedPeakCount - 1;
  const suppliedDescriptor = {
    stateCount,
    observedStateCount: Number(
      payload?.descriptor?.observedStateCount ?? stateCount,
    ),
    regularized: Boolean(payload?.descriptor?.regularized),
    peakLocations: suppliedPeakLocations,
    peakWidths: numberArray(
      payload?.descriptor?.peakWidths,
      suppliedPeakCount,
      "peakWidths",
    ),
    valleyHeights: numberArray(
      payload?.descriptor?.valleyHeights,
      valleyCount,
      "valleyHeights",
    ),
    valleyLocations: numberArray(
      payload?.descriptor?.valleyLocations,
      valleyCount,
      "valleyLocations",
    ),
    valleyDepths: numberArray(
      payload?.descriptor?.valleyDepths,
      valleyCount,
      "valleyDepths",
    ),
    valleyPositionRatios: numberArray(
      payload?.descriptor?.valleyPositionRatios,
      valleyCount,
      "valleyPositionRatios",
    ),
    peakValleyDistances: numberArray(
      payload?.descriptor?.peakValleyDistances,
      valleyCount * 2,
      "peakValleyDistances",
    ),
    tailSlopes: numberArray(
      payload?.descriptor?.tailSlopes,
      2,
      "tailSlopes",
    ),
    area: Number(payload?.descriptor?.area),
  };
  if (
    !isValidStateCount(suppliedDescriptor.observedStateCount) ||
    !Number.isFinite(suppliedDescriptor.area) ||
    suppliedDescriptor.area < 0 ||
    suppliedDescriptor.area > 1.5
  ) {
    throw new Error("Curve descriptor가 올바르지 않습니다.");
  }
  const rebuiltDescriptor = descriptorFromProfile(profile);
  const rebuiltDiffers =
    rebuiltDescriptor.stateCount !== suppliedDescriptor.stateCount ||
    rebuiltDescriptor.peakLocations.length !==
      suppliedDescriptor.peakLocations.length ||
    Math.abs(rebuiltDescriptor.area - suppliedDescriptor.area) > 0.03 ||
    rebuiltDescriptor.peakLocations.some(
      (value, index) =>
        Math.abs(value - suppliedDescriptor.peakLocations[index]) > 0.03,
    );
  const guided = tryDescriptorFromPeakHints(
    profile,
    suppliedDescriptor.peakLocations,
  );
  const guidedMatches =
    guided.ok &&
    guided.descriptor.stateCount ===
      suppliedDescriptor.stateCount &&
    Math.abs(
      guided.descriptor.area - suppliedDescriptor.area,
    ) <= 0.03 &&
    guided.descriptor.peakLocations.every(
      (value, index) =>
        Math.abs(
          value - suppliedDescriptor.peakLocations[index],
        ) <= 0.03,
    );
  if (rebuiltDiffers && !guidedMatches) {
    throw new Error(
      "Curve와 descriptor가 일치하지 않습니다. 그래프를 다시 분석해 주세요.",
    );
  }
  const authoritativeDescriptor = rebuiltDiffers
    ? guided.descriptor
    : rebuiltDescriptor;

  const sourceSelection = normalizeTrainingSourceSelection(
    payload?.sourceSelection,
  );
  return {
    schemaVersion: 2,
    label: String(payload?.label || "공용 VTH 분포")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 80) || "공용 VTH 분포",
    profile,
    descriptor: authoritativeDescriptor,
    contributorToken: String(payload.contributorToken),
    deletionToken: String(payload.deletionToken),
    consentVersion: requestedConsentVersion,
    ...(sourceSelection ? { sourceSelection } : {}),
  };
}

export function renderStandardizedCurveSvg(profile) {
  if (!Array.isArray(profile) || profile.length !== 256) {
    throw new Error("표준 그래프에는 256-point Curve가 필요합니다.");
  }
  const points = profile
    .map((value, index) => {
      const x = 12 + (index / 255) * 488;
      const y = 12 + (1 - Number(value)) * 232;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 256">',
    '<rect width="512" height="256" fill="#fff"/>',
    `<polyline points="${points}" fill="none" stroke="#101715" `,
    'stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
    "</svg>",
  ].join("");
}

export function canonicalShapeFingerprintInput(profile, stateCount) {
  return `${stateCount}:${profile
    .map((value) => Number(value).toFixed(6))
    .join(",")}`;
}

export function createSharingToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function sharedCandidateDeletionStorageKey(candidateId) {
  return `vth-shared-delete-token:${candidateId}`;
}

export function encodeSharedCandidateCursor(createdAt, candidateId) {
  const timestamp = String(createdAt ?? "");
  const id = String(candidateId ?? "");
  if (
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp) ||
    !SHARED_CANDIDATE_ID_PATTERN.test(id)
  ) {
    throw new Error("공용 학습 후보 cursor 값이 올바르지 않습니다.");
  }
  return btoa(JSON.stringify(["v1", timestamp, id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function decodeSharedCandidateCursor(value) {
  if (value === null || value === undefined || value === "") return null;
  const cursor = String(value);
  if (!/^[a-zA-Z0-9_-]{8,256}$/.test(cursor)) {
    throw new Error("공용 학습 후보 cursor가 올바르지 않습니다.");
  }
  try {
    const base64 = cursor
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(cursor.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 3 ||
      decoded[0] !== "v1" ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(decoded[1]) ||
      !SHARED_CANDIDATE_ID_PATTERN.test(decoded[2])
    ) {
      throw new Error("invalid cursor payload");
    }
    return { createdAt: decoded[1], candidateId: decoded[2] };
  } catch {
    throw new Error("공용 학습 후보 cursor가 올바르지 않습니다.");
  }
}

export async function fetchAllSharedTrainingCandidates({
  fetchImpl,
  endpoint,
  pageSize = MAX_SHARED_CANDIDATE_PAGE_SIZE,
  maxCandidates = MAX_SHARED_CANDIDATES,
  retries = 1,
}) {
  if (typeof fetchImpl !== "function" || !endpoint) {
    throw new Error("공용 후보 page loader 설정이 올바르지 않습니다.");
  }
  const safePageSize = Math.max(
    1,
    Math.min(MAX_SHARED_CANDIDATE_PAGE_SIZE, Math.trunc(pageSize)),
  );
  const safeMaximum = Math.max(
    1,
    Math.min(MAX_SHARED_CANDIDATES, Math.trunc(maxCandidates)),
  );
  const safeRetries = Math.max(0, Math.min(2, Math.trunc(retries)));
  let lastError;
  for (let attempt = 0; attempt <= safeRetries; attempt += 1) {
    try {
      const candidates = [];
      const candidateIds = new Set();
      const seenCursors = new Set();
      let nextCursor = null;
      let candidateCount = 0;
      let pages = 0;
      do {
        const separator = endpoint.includes("?") ? "&" : "?";
        const url =
          `${endpoint}${separator}limit=${safePageSize}` +
          (nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : "");
        const response = await fetchImpl(url, {
          headers: { accept: "application/json" },
        });
        const payload = await response.json();
        if (
          !response.ok ||
          !Array.isArray(payload?.candidates) ||
          payload.candidates.length > safePageSize
        ) {
          throw new Error("공용 학습 후보 page를 불러오지 못했습니다.");
        }
        if (pages === 0) {
          candidateCount = Number(payload.candidateCount ?? 0);
        }
        pages += 1;
        for (const candidate of payload.candidates) {
          if (!candidate?.id || candidateIds.has(candidate.id)) {
            throw new Error("공용 학습 후보 page에 중복 ID가 있습니다.");
          }
          candidateIds.add(candidate.id);
          candidates.push(candidate);
          if (candidates.length > safeMaximum) {
            throw new Error(
              "공용 학습 후보 수가 클라이언트 상한을 초과했습니다.",
            );
          }
        }
        nextCursor =
          typeof payload.nextCursor === "string" && payload.nextCursor
            ? payload.nextCursor
            : null;
        if (nextCursor) {
          if (seenCursors.has(nextCursor)) {
            throw new Error("공용 학습 후보 cursor가 반복되었습니다.");
          }
          seenCursors.add(nextCursor);
        }
      } while (nextCursor);

      if (
        !Number.isInteger(candidateCount) ||
        candidateCount < 0 ||
        candidateCount > safeMaximum ||
        candidates.length !== candidateCount
      ) {
        throw new Error("공용 학습 후보 전체 page가 완전하지 않습니다.");
      }
      return { candidates, candidateCount, pages };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function isAllowedSharedTrainingOrigin(value) {
  if (!value) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return (
    url.hostname === "dove9999.com" ||
    url.hostname.endsWith(".chatgpt.site") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost"
  );
}
