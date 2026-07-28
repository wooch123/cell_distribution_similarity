import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSharedRelevanceApiPayload,
  SHARED_RELEVANCE_CONSENT_VERSION,
  sharedRelevanceDeletionStorageKey,
  validateSharedRelevancePayload,
} from "../lib/vth-shared-relevance-core.mjs";

const token = "a".repeat(43);
const profile = Array.from({ length: 256 }, (_, index) => index / 255);
const judgment = {
  candidate_id: "vth-04s-s0042-00001",
  rank: 1,
  relevance: "similar",
  state_count: 4,
  score: 0.91,
  model_score: 0.9,
  image_score: 0.8,
  curve_score: 0.93,
  peak_count_score: 1,
  location_score: 0.88,
  width_score: 0.82,
  area_score: 0.85,
  valley_score: 0.86,
  tail_score: 0.81,
  peak_valley_score: 0.89,
  reasons: ["server does not retain free-form reasons"],
};
const report = {
  schema_version: 3,
  report_type: "vth-expert-relevance",
  created_at: "2026-07-27T00:00:00Z",
  privacy: {
    query_image_included: false,
    original_filename_included: false,
    external_upload_performed: false,
    normalized_shape_features_included: true,
    normalized_shape_shared: true,
  },
  annotator: {
    id: "A-device 17",
    anonymous: true,
    id_scope: "browser-device",
  },
  query: {
    id: "Shared Query 004",
    y_scale: "log10",
    detected_state_count: 4,
    observed_state_count: 4,
    state_count_regularized: false,
    axes_detected: true,
    profile,
    descriptor: {
      peak_locations: [0.15, 0.38, 0.61, 0.84],
      peak_widths: [0.08, 0.07, 0.09, 0.08],
      valley_heights: [0.2, 0.18, 0.22],
      valley_locations: [0.27, 0.5, 0.73],
      valley_depths: [0.12, 0.1, 0.13],
      valley_position_ratios: [0.5, 0.48, 0.51],
      peak_valley_distances: [0.11, 0.12, 0.1, 0.12, 0.11, 0.12],
      tail_slopes: [0.03, 0.04, 0.03, 0.04, 0.03, 0.04],
      area: 0.52,
    },
  },
  corpus: {
    version: 4,
    candidate_count: 97,
    state_counts: [2, 4, 8, 16],
    reranker_version: 2,
  },
  judgments: [judgment],
};

function payload(overrides = {}) {
  return {
    schemaVersion: 1,
    report,
    sharingConsent: true,
    consentVersion: SHARED_RELEVANCE_CONSENT_VERSION,
    contributorToken: token,
    deletionToken: "b".repeat(43),
    ...overrides,
  };
}

test("validates and minimizes an anonymous shared relevance report", () => {
  const normalized = validateSharedRelevancePayload(payload());
  const serialized = JSON.stringify(normalized);

  assert.equal(normalized.queryId, "Shared-Query-004");
  assert.equal(normalized.annotatorId, "A-device-17");
  assert.equal(normalized.report.query.profile.length, 256);
  assert.equal(normalized.report.judgments.length, 1);
  assert.equal(normalized.report.privacy.normalized_shape_shared, true);
  assert.equal(normalized.report.privacy.external_upload_performed, false);
  assert.equal(normalized.report.judgments[0].relevance, "similar");
  assert.doesNotMatch(serialized, /server does not retain free-form reasons/);
});

test("rejects missing consent, raw-image flags, and duplicate candidates", () => {
  assert.throws(
    () => validateSharedRelevancePayload(payload({ sharingConsent: false })),
    /공유 동의/,
  );
  assert.throws(
    () =>
      validateSharedRelevancePayload(
        payload({
          report: {
            ...report,
            privacy: { ...report.privacy, query_image_included: true },
          },
        }),
      ),
    /개인정보 설정/,
  );
  assert.throws(
    () =>
      validateSharedRelevancePayload(
        payload({ report: { ...report, judgments: [judgment, judgment] } }),
      ),
    /중복 판정/,
  );
});

test("builds the public API envelope and stable deletion storage key", () => {
  const apiPayload = buildSharedRelevanceApiPayload(report, {
    contributorToken: token,
    deletionToken: "b".repeat(43),
    consentVersion: SHARED_RELEVANCE_CONSENT_VERSION,
  });
  assert.equal(apiPayload.sharingConsent, true);
  assert.equal(apiPayload.report, report);
  assert.equal(
    sharedRelevanceDeletionStorageKey("relevance-123"),
    "vth-shared-relevance-delete-token:relevance-123",
  );
});
