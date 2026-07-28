import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_IMAGE_FEATURE_DIMENSIONS,
  FUSED_SHAPE_FEATURE_DIMENSIONS,
  canonicalImageFeatureFromProfile,
  curveFeatureFromProfile,
  dualCurveSimilarity,
  fusedShapeFeatureFromProfile,
  rerankWithDualEncoder,
  validateDualEncoder,
} from "../lib/vth-dual-encoder-core.mjs";

function peakProfile(center) {
  return Array.from({ length: 256 }, (_, index) => {
    const x = index / 255;
    return 0.04 + 0.96 * Math.exp(-0.5 * ((x - center) / 0.08) ** 2);
  });
}

function identityLikeModel() {
  const positions = [8, 32, 64, 96, 160, 224, 280, 344];
  const rows = positions.map((position) =>
    Array.from({ length: 384 }, (_, index) => (index === position ? 1 : 0)),
  );
  return {
    version: 1,
    kind: "vth-dual-curve-linear",
    inputDimensions: 384,
    embeddingDimensions: rows.length,
    queryWeights: rows,
    queryIntercept: Array(rows.length).fill(0),
    candidateMean: Array(384).fill(0),
    candidateComponents: rows,
    blendWeight: 0.5,
    rerankLimit: 2,
  };
}

function nonlinearIdentityLikeModel() {
  const linear = identityLikeModel();
  return {
    version: 2,
    kind: "vth-dual-curve-mlp",
    inputDimensions: 384,
    embeddingDimensions: linear.embeddingDimensions,
    hiddenDimensions: linear.embeddingDimensions,
    activation: "tanh",
    queryInputMean: Array(384).fill(0),
    queryInputScale: Array(384).fill(1),
    queryHiddenWeights: linear.queryWeights,
    queryHiddenIntercept: Array(linear.embeddingDimensions).fill(0),
    queryOutputWeights: Array.from(
      { length: linear.embeddingDimensions },
      (_, row) =>
        Array.from(
          { length: linear.embeddingDimensions },
          (_, column) => (row === column ? 1 : 0),
        ),
    ),
    queryOutputIntercept: Array(linear.embeddingDimensions).fill(0),
    candidateMean: linear.candidateMean,
    candidateComponents: linear.candidateComponents,
    blendWeight: 0.5,
    rerankLimit: 2,
  };
}

function fusedNonlinearIdentityLikeModel() {
  const positions = [32, 260, 720, 1240, 1840, 2420, 3220, 3500];
  const rows = positions.map((position) =>
    Array.from(
      { length: FUSED_SHAPE_FEATURE_DIMENSIONS },
      (_, index) => (index === position ? 1 : 0),
    ),
  );
  return {
    version: 3,
    kind: "vth-dual-image-curve-mlp",
    inputDimensions: FUSED_SHAPE_FEATURE_DIMENSIONS,
    embeddingDimensions: rows.length,
    hiddenDimensions: rows.length,
    activation: "tanh",
    queryInputMean: Array(FUSED_SHAPE_FEATURE_DIMENSIONS).fill(0),
    queryInputScale: Array(FUSED_SHAPE_FEATURE_DIMENSIONS).fill(1),
    queryHiddenWeights: rows,
    queryHiddenIntercept: Array(rows.length).fill(0),
    queryOutputWeights: Array.from({ length: rows.length }, (_, row) =>
      Array.from(
        { length: rows.length },
        (_, column) => (row === column ? 1 : 0),
      )),
    queryOutputIntercept: Array(rows.length).fill(0),
    candidateMean: Array(FUSED_SHAPE_FEATURE_DIMENSIONS).fill(0),
    candidateComponents: rows,
    blendWeight: 0.5,
    rerankLimit: 2,
  };
}

test("builds the same finite 384-value Curve feature used by Python", () => {
  const feature = curveFeatureFromProfile(peakProfile(0.34));
  const norm = Math.sqrt(
    feature.reduce((sum, value) => sum + value * value, 0),
  );

  assert.equal(feature.length, 384);
  assert.ok(feature.every(Number.isFinite));
  assert.ok(Math.abs(norm - 1) < 1e-10);
});

test("builds a normalized 3,200-D canonical image and fused feature", () => {
  const image = canonicalImageFeatureFromProfile(peakProfile(0.34));
  const fused = fusedShapeFeatureFromProfile(peakProfile(0.34));

  assert.equal(image.length, CANONICAL_IMAGE_FEATURE_DIMENSIONS);
  assert.equal(fused.length, FUSED_SHAPE_FEATURE_DIMENSIONS);
  assert.ok(image.every(Number.isFinite));
  assert.ok(fused.every(Number.isFinite));
  assert.ok(
    Math.abs(Math.hypot(...image) - 1) < 1e-10,
  );
  assert.ok(
    Math.abs(Math.hypot(...fused) - 1) < 1e-10,
  );
});

test("scores a matching profile above a shifted learned embedding", () => {
  const model = validateDualEncoder(identityLikeModel());
  const query = peakProfile(0.32);
  const exact = dualCurveSimilarity(query, query, model);
  const shifted = dualCurveSimilarity(query, peakProfile(0.72), model);

  assert.ok(exact > shifted);
  assert.ok(exact > 0.99);
});

test("runs the nonlinear browser encoder and preserves shape ordering", () => {
  const model = validateDualEncoder(nonlinearIdentityLikeModel());
  const query = peakProfile(0.32);
  const exact = dualCurveSimilarity(query, query, model);
  const shifted = dualCurveSimilarity(query, peakProfile(0.72), model);

  assert.ok(exact > shifted);
  assert.ok(Number.isFinite(exact));
});

test("runs the fused image–Curve encoder and preserves shape ordering", () => {
  const model = validateDualEncoder(fusedNonlinearIdentityLikeModel());
  const query = peakProfile(0.32);
  const exact = dualCurveSimilarity(query, query, model);
  const shifted = dualCurveSimilarity(query, peakProfile(0.72), model);

  assert.ok(exact > shifted);
  assert.ok(Number.isFinite(exact));
});

test("learned reranking preserves the baseline top-N candidate set", () => {
  const model = identityLikeModel();
  const query = peakProfile(0.32);
  const baseline = [
    { id: "shifted", profile: peakProfile(0.72), score: 0.91 },
    { id: "exact", profile: query, score: 0.9 },
    { id: "tail", profile: peakProfile(0.5), score: 0.7 },
  ];
  const reranked = rerankWithDualEncoder(baseline, [query], model);

  assert.deepEqual(
    new Set(reranked.slice(0, 2).map((candidate) => candidate.id)),
    new Set(["shifted", "exact"]),
  );
  assert.equal(reranked[0].id, "exact");
  assert.equal(reranked[2].id, "tail");
  assert.ok(Number.isFinite(reranked[0].dualEncoderScore));
  assert.ok(Number.isFinite(reranked[0].dualRerankedScore));
  assert.ok(
    reranked.every(
      (candidate, index) =>
        index === 0 || reranked[index - 1].score >= candidate.score,
    ),
  );
});

test("does not displace an exact Curve match with a learned tie-break", () => {
  const model = identityLikeModel();
  const query = peakProfile(0.32);
  const reranked = rerankWithDualEncoder(
    [
      {
        id: "exact",
        profile: query,
        score: 0.91,
        curveScore: 0.999,
      },
      {
        id: "learned",
        profile: peakProfile(0.32),
        score: 0.9,
        curveScore: 0.92,
      },
    ],
    [peakProfile(0.72)],
    model,
  );

  assert.equal(reranked[0].id, "exact");
});
