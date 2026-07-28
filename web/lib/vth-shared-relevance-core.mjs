import { normalizeAnonymousCode } from "./vth-feedback-core.mjs";

export const SHARED_RELEVANCE_CONSENT_VERSION = "2026-07-27-v1";
export const MAX_SHARED_RELEVANCE_REPORTS = 10_000;
export const MAX_SHARED_RELEVANCE_REPORTS_PER_DAY = 50;

const VALID_STATE_COUNTS = new Set([2, 4, 8, 16]);
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,128}$/;
const CANDIDATE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/;
const SCORE_FIELDS = [
  "score",
  "image_score",
  "curve_score",
  "peak_count_score",
  "location_score",
  "width_score",
  "area_score",
  "valley_score",
  "tail_score",
  "peak_valley_score",
];

function unitScore(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${field}는 0과 1 사이의 수치여야 합니다.`);
  }
  return Number(number.toFixed(6));
}

function numberArray(value, expectedLength, field) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`${field} 길이가 올바르지 않습니다.`);
  }
  return value.map((item, index) => unitScore(item, `${field}[${index}]`));
}

function optionalScore(value, field) {
  return value === null || value === undefined ? null : unitScore(value, field);
}

function requireToken(value, field) {
  const token = String(value ?? "");
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`${field}이 올바르지 않습니다.`);
  }
  return token;
}

function sanitizeJudgment(value, index) {
  if (!value || typeof value !== "object") {
    throw new Error(`judgments[${index}]가 올바르지 않습니다.`);
  }
  const candidateId = String(value.candidate_id ?? "");
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error(`judgments[${index}].candidate_id가 올바르지 않습니다.`);
  }
  if (!["similar", "dissimilar"].includes(value.relevance)) {
    throw new Error(`judgments[${index}].relevance가 올바르지 않습니다.`);
  }
  const rank = Number(value.rank);
  if (!Number.isInteger(rank) || rank < 1 || rank > 100) {
    throw new Error(`judgments[${index}].rank가 올바르지 않습니다.`);
  }
  const stateCount = Number(value.state_count);
  if (!VALID_STATE_COUNTS.has(stateCount)) {
    throw new Error(`judgments[${index}].state_count가 올바르지 않습니다.`);
  }
  const scores = Object.fromEntries(
    SCORE_FIELDS.map((field) => [
      field,
      unitScore(value[field], `judgments[${index}].${field}`),
    ]),
  );
  return {
    candidate_id: candidateId,
    rank,
    relevance: value.relevance,
    state_count: stateCount,
    ...scores,
    model_score: optionalScore(
      value.model_score,
      `judgments[${index}].model_score`,
    ),
  };
}

export function validateSharedRelevancePayload(payload) {
  if (payload?.sharingConsent !== true) {
    throw new Error("공용 relevance 학습 공유 동의가 필요합니다.");
  }
  if (payload?.consentVersion !== SHARED_RELEVANCE_CONSENT_VERSION) {
    throw new Error("지원하지 않는 relevance 공유 동의 버전입니다.");
  }
  const contributorToken = requireToken(
    payload?.contributorToken,
    "기여자 토큰",
  );
  const deletionToken = requireToken(payload?.deletionToken, "삭제 토큰");
  const report = payload?.report;
  if (!report || typeof report !== "object") {
    throw new Error("relevance report가 필요합니다.");
  }
  if (
    report.schema_version !== 3 ||
    report.report_type !== "vth-expert-relevance"
  ) {
    throw new Error("schema-v3 VTH relevance report만 지원합니다.");
  }
  if (
    report.privacy?.query_image_included !== false ||
    report.privacy?.original_filename_included !== false ||
    report.privacy?.external_upload_performed !== false ||
    report.privacy?.normalized_shape_features_included !== true ||
    report.privacy?.normalized_shape_shared !== true
  ) {
    throw new Error("공용 relevance report의 개인정보 설정이 올바르지 않습니다.");
  }
  if (
    report.annotator?.anonymous !== true ||
    report.annotator?.id_scope !== "browser-device"
  ) {
    throw new Error("익명 평가자 report만 지원합니다.");
  }
  const queryId = normalizeAnonymousCode(report.query?.id, "");
  const annotatorId = normalizeAnonymousCode(report.annotator?.id, "");
  if (queryId.length < 3 || annotatorId.length < 3) {
    throw new Error("Query와 익명 평가자 코드가 필요합니다.");
  }
  const profile = numberArray(report.query?.profile, 256, "query.profile");
  if (Math.max(...profile) - Math.min(...profile) < 0.05) {
    throw new Error("Query Curve의 형상 변화가 너무 작습니다.");
  }
  const detectedStateCount = Number(report.query?.detected_state_count);
  const observedStateCount = Number(report.query?.observed_state_count);
  if (
    report.query?.y_scale !== "log10" ||
    !VALID_STATE_COUNTS.has(detectedStateCount) ||
    !Number.isInteger(observedStateCount) ||
    observedStateCount < 1 ||
    observedStateCount > 16
  ) {
    throw new Error("Query의 로그 축 또는 State 정보가 올바르지 않습니다.");
  }
  const descriptor = report.query?.descriptor;
  const peakCount = descriptor?.peak_locations?.length;
  if (
    !Number.isInteger(peakCount) ||
    peakCount < 2 ||
    peakCount > detectedStateCount
  ) {
    throw new Error("Query peak descriptor가 올바르지 않습니다.");
  }
  const valleyCount = peakCount - 1;
  const sanitizedDescriptor = {
    peak_locations: numberArray(
      descriptor.peak_locations,
      peakCount,
      "query.descriptor.peak_locations",
    ),
    peak_widths: numberArray(
      descriptor.peak_widths,
      peakCount,
      "query.descriptor.peak_widths",
    ),
    valley_heights: numberArray(
      descriptor.valley_heights,
      valleyCount,
      "query.descriptor.valley_heights",
    ),
    valley_locations: numberArray(
      descriptor.valley_locations,
      valleyCount,
      "query.descriptor.valley_locations",
    ),
    valley_depths: numberArray(
      descriptor.valley_depths,
      valleyCount,
      "query.descriptor.valley_depths",
    ),
    valley_position_ratios: numberArray(
      descriptor.valley_position_ratios,
      valleyCount,
      "query.descriptor.valley_position_ratios",
    ),
    peak_valley_distances: numberArray(
      descriptor.peak_valley_distances,
      valleyCount * 2,
      "query.descriptor.peak_valley_distances",
    ),
    tail_slopes: numberArray(
      descriptor.tail_slopes,
      valleyCount * 2,
      "query.descriptor.tail_slopes",
    ),
    area: unitScore(descriptor.area, "query.descriptor.area"),
  };
  if (
    !Array.isArray(report.judgments) ||
    report.judgments.length < 1 ||
    report.judgments.length > 10
  ) {
    throw new Error("1~10개의 relevance 판정이 필요합니다.");
  }
  const judgments = report.judgments.map(sanitizeJudgment);
  if (new Set(judgments.map((item) => item.candidate_id)).size !== judgments.length) {
    throw new Error("한 report 안에 같은 후보를 중복 판정할 수 없습니다.");
  }
  const corpusVersion = Number(report.corpus?.version);
  const candidateCount = Number(report.corpus?.candidate_count);
  const stateCounts = Array.isArray(report.corpus?.state_counts)
    ? [...new Set(report.corpus.state_counts.map(Number))]
    : [];
  if (
    !Number.isInteger(corpusVersion) ||
    corpusVersion < 1 ||
    !Number.isInteger(candidateCount) ||
    candidateCount < 1 ||
    candidateCount > 12_000 ||
    !stateCounts.length ||
    stateCounts.some((value) => !VALID_STATE_COUNTS.has(value))
  ) {
    throw new Error("검색 corpus 정보가 올바르지 않습니다.");
  }

  return {
    contributorToken,
    deletionToken,
    consentVersion: SHARED_RELEVANCE_CONSENT_VERSION,
    queryId,
    annotatorId,
    report: {
      schema_version: 3,
      report_type: "vth-expert-relevance",
      created_at: new Date().toISOString(),
      privacy: {
        query_image_included: false,
        original_filename_included: false,
        external_upload_performed: false,
        normalized_shape_features_included: true,
        normalized_shape_shared: true,
      },
      annotator: {
        id: annotatorId,
        anonymous: true,
        id_scope: "browser-device",
      },
      query: {
        id: queryId,
        y_scale: "log10",
        detected_state_count: detectedStateCount,
        observed_state_count: observedStateCount,
        state_count_regularized: Boolean(
          report.query?.state_count_regularized,
        ),
        axes_detected: Boolean(report.query?.axes_detected),
        profile,
        descriptor: sanitizedDescriptor,
      },
      corpus: {
        version: corpusVersion,
        candidate_count: candidateCount,
        state_counts: stateCounts.sort((left, right) => left - right),
        reranker_version:
          report.corpus?.reranker_version === null
            ? null
            : Number(report.corpus?.reranker_version),
      },
      judgments,
    },
  };
}

export function buildSharedRelevanceApiPayload(report, options) {
  return {
    schemaVersion: 1,
    report,
    sharingConsent: true,
    consentVersion: options.consentVersion,
    contributorToken: options.contributorToken,
    deletionToken: options.deletionToken,
  };
}

export function sharedRelevanceDeletionStorageKey(reportId) {
  return `vth-shared-relevance-delete-token:${reportId}`;
}
