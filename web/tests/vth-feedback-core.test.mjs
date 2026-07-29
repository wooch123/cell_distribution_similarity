import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFeedbackPayload,
  normalizeAnonymousCode,
} from "../lib/vth-feedback-core.mjs";

const profile = Array.from({ length: 256 }, (_, index) => index / 255);
const analysis = {
  id: "2e7ce573-cc83-4de6-bfbd-958601215a79",
  fileName: "confidential-lot-wafer.png",
  imageUrl: "blob:confidential-image",
  profile,
  axesDetected: true,
  descriptor: {
    stateCount: 4,
    observedStateCount: 4,
    regularized: false,
    peakLocations: [0.15, 0.38, 0.61, 0.84],
    peakWidths: [0.08, 0.07, 0.09, 0.08],
    valleyHeights: [0.2, 0.18, 0.22],
    valleyLocations: [0.27, 0.5, 0.73],
    valleyDepths: [0.12, 0.1, 0.13],
    valleyPositionRatios: [0.5, 0.48, 0.51],
    peakValleyDistances: [0.11, 0.12, 0.1, 0.12, 0.11, 0.12],
    tailSlopes: [0.03, 0.04],
    area: 0.52,
  },
};
const result = {
  id: "candidate-01",
  rank: 1,
  stateCount: 4,
  score: 0.93,
  modelScore: 0.91,
  imageScore: 0.9,
  curveScore: 0.95,
  countScore: 1,
  locationScore: 0.92,
  widthScore: 0.86,
  areaScore: 0.88,
  valleyScore: 0.87,
  tailScore: 0.84,
  peakValleyScore: 0.9,
  reasons: ["State 위치와 폭이 가깝습니다."],
};
const corpus = {
  version: 3,
  candidateCount: 96,
  stateCounts: [2, 4, 8, 16],
  reranker: { version: 2 },
};

test("builds an anonymous schema-v3 consensus-ready report", () => {
  const payload = buildFeedbackPayload({
    analysis,
    corpus,
    results: [result, { ...result, id: "candidate-02", rank: 2 }],
    feedback: { "candidate-01": "similar" },
    queryCode: "Shared Query 004",
    annotatorId: "A-device 17",
    createdAt: "2026-07-27T01:02:03Z",
  });
  const serialized = JSON.stringify(payload);

  assert.equal(payload.schema_version, 3);
  assert.equal(payload.query.id, "Shared-Query-004");
  assert.equal(payload.annotator.id, "A-device-17");
  assert.equal(payload.annotator.anonymous, true);
  assert.equal(payload.judgments.length, 1);
  assert.equal(payload.judgments[0].candidate_id, "candidate-01");
  assert.equal(payload.query.profile.length, 256);
  assert.equal(payload.query.descriptor.valley_depths.length, 3);
  assert.equal(payload.judgments[0].peak_valley_score, 0.9);
  assert.equal(payload.privacy.external_upload_performed, false);
  assert.equal(payload.privacy.normalized_shape_shared, false);
  assert.doesNotMatch(serialized, /confidential-lot-wafer|blob:confidential/);
});

test("marks only the normalized shape as shared for the central API", () => {
  const payload = buildFeedbackPayload({
    analysis,
    corpus,
    results: [result],
    feedback: { "candidate-01": "similar" },
    queryCode: "Shared Query 004",
    annotatorId: "A-device 17",
    normalizedShapeShared: true,
  });
  assert.equal(payload.privacy.external_upload_performed, false);
  assert.equal(payload.privacy.query_image_included, false);
  assert.equal(payload.privacy.normalized_shape_shared, true);
});

test("normalizes empty or unsafe anonymous codes deterministically", () => {
  assert.equal(normalizeAnonymousCode("  lot / 7  ", "fallback"), "lot-7");
  assert.equal(normalizeAnonymousCode("***", "fallback"), "fallback");
});

test("requires at least one relevance judgment", () => {
  assert.throws(
    () =>
      buildFeedbackPayload({
        analysis,
        corpus,
        results: [result],
        feedback: {},
        queryCode: "Q-1",
        annotatorId: "A-1",
      }),
    /At least one relevance judgment/,
  );
});
