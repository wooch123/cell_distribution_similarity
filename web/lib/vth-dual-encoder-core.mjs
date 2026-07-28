/**
 * Browser inference for sample-ID validated Curve and fused image–Curve
 * encoders. The deterministic feature construction mirrors Python exactly.
 */

export const CURVE_FEATURE_DIMENSIONS = 384;
export const CANONICAL_IMAGE_FEATURE_DIMENSIONS = 3200;
export const FUSED_SHAPE_FEATURE_DIMENSIONS =
  CURVE_FEATURE_DIMENSIONS + CANONICAL_IMAGE_FEATURE_DIMENSIONS;

function unit(values) {
  const norm = Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0),
  );
  if (!norm) return values.map(() => 0);
  return values.map((value) => value / norm);
}

function resample(values, size) {
  if (values.length === size) return [...values];
  if (values.length <= 1) return Array(size).fill(values[0] ?? 0);
  return Array.from({ length: size }, (_, index) => {
    const position = (index / (size - 1)) * (values.length - 1);
    const left = Math.floor(position);
    const right = Math.min(values.length - 1, left + 1);
    const fraction = position - left;
    return values[left] * (1 - fraction) + values[right] * fraction;
  });
}

function gradient(values) {
  return values.map((value, index) => {
    if (index === 0) return values[1] - value;
    if (index === values.length - 1) return value - values[index - 1];
    return (values[index + 1] - values[index - 1]) / 2;
  });
}

/**
 * @param {number[]} profile
 */
export function curveFeatureFromProfile(profile) {
  const sampled = resample(profile, 128);
  const first = gradient(sampled);
  const second = gradient(first);
  return unit([
    ...unit(sampled),
    ...unit(first),
    ...unit(second),
  ]);
}

/**
 * Render an axis-free normalized Curve into a soft 64×32 image and append an
 * 8×16×9 spatial orientation histogram.  Color, stroke, grid, and source
 * resolution cannot enter this representation.
 *
 * @param {number[]} profile
 */
export function canonicalImageFeatureFromProfile(profile) {
  if (
    !Array.isArray(profile) ||
    profile.length < 2 ||
    profile.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("표준 이미지 profile이 올바르지 않습니다.");
  }
  const clipped = profile.map((value) => Math.max(0, value));
  const peak = Math.max(...clipped);
  const normalized = peak > Number.EPSILON
    ? clipped.map((value) => value / peak)
    : clipped.map(() => 0);

  const rasterProfile = resample(normalized, 64);
  const raster = [];
  for (let row = 0; row < 32; row += 1) {
    for (let column = 0; column < 64; column += 1) {
      const curveY = (1 - rasterProfile[column]) * 31;
      const distance = (row - curveY) / 0.8;
      raster.push(Math.exp(-0.5 * distance * distance));
    }
  }

  const hogProfile = resample(normalized, 256);
  const curveY = hogProfile.map((value) => (1 - value) * 127);
  const histograms = Array.from(
    { length: 8 * 16 },
    () => Array(9).fill(0),
  );
  for (let index = 0; index < 255; index += 1) {
    const deltaY = curveY[index + 1] - curveY[index];
    const midpointY = (curveY[index + 1] + curveY[index]) * 0.5;
    const row = Math.min(7, Math.max(0, Math.floor(midpointY / 16)));
    const column = Math.min(15, Math.floor(index / 16));
    const angle =
      (Math.atan2(deltaY, 1) + Math.PI * 0.5) % Math.PI;
    const binPosition = (angle / Math.PI) * 9;
    const lowerFloor = Math.floor(binPosition);
    const lower = lowerFloor % 9;
    const upper = (lower + 1) % 9;
    const fraction = binPosition - lowerFloor;
    const magnitude = Math.hypot(deltaY, 1);
    const histogram = histograms[row * 16 + column];
    histogram[lower] += magnitude * (1 - fraction);
    histogram[upper] += magnitude * fraction;
  }
  const hog = histograms.flatMap((histogram) => unit(histogram));
  const embedding = unit([
    ...raster,
    ...hog.map((value) => value * 0.25),
  ]);
  if (embedding.length !== CANONICAL_IMAGE_FEATURE_DIMENSIONS) {
    throw new Error("표준 이미지 임베딩 차원이 변경되었습니다.");
  }
  return embedding;
}

/**
 * @param {number[]} profile
 */
export function fusedShapeFeatureFromProfile(profile) {
  return unit([
    ...canonicalImageFeatureFromProfile(profile),
    ...curveFeatureFromProfile(profile),
  ]);
}

function modelFeatureFromProfile(profile, model) {
  return model.kind === "vth-dual-image-curve-mlp"
    ? fusedShapeFeatureFromProfile(profile)
    : curveFeatureFromProfile(profile);
}

function matrixVector(rows, values) {
  return rows.map((row) =>
    row.reduce(
      (sum, coefficient, index) =>
        sum + coefficient * values[index],
      0,
    ),
  );
}

/**
 * @param {Record<string, any>} model
 */
export function validateDualEncoder(model) {
  const linear = model?.kind === "vth-dual-curve-linear";
  const curveNonlinear = model?.kind === "vth-dual-curve-mlp";
  const fusedNonlinear = model?.kind === "vth-dual-image-curve-mlp";
  const nonlinear = curveNonlinear || fusedNonlinear;
  if (!model || (!linear && !nonlinear)) {
    throw new Error("지원하지 않는 dual encoder입니다.");
  }
  const inputDimensions = Number(model.inputDimensions);
  const embeddingDimensions = Number(model.embeddingDimensions);
  const expectedInputDimensions = fusedNonlinear
    ? FUSED_SHAPE_FEATURE_DIMENSIONS
    : CURVE_FEATURE_DIMENSIONS;
  const commonDimensionsInvalid =
    inputDimensions !== expectedInputDimensions ||
    !Number.isInteger(embeddingDimensions) ||
    embeddingDimensions < 2 ||
    model.candidateMean?.length !== inputDimensions ||
    model.candidateComponents?.length !== embeddingDimensions ||
    model.candidateComponents.some((row) => row.length !== inputDimensions);
  const linearDimensionsInvalid =
    linear &&
    (model.queryWeights?.length !== embeddingDimensions ||
      model.queryIntercept?.length !== embeddingDimensions ||
      model.queryWeights.some((row) => row.length !== inputDimensions));
  const hiddenDimensions = Number(model.hiddenDimensions);
  const nonlinearDimensionsInvalid =
    nonlinear &&
    (!Number.isInteger(hiddenDimensions) ||
      hiddenDimensions < 2 ||
      model.activation !== "tanh" ||
      model.queryInputMean?.length !== inputDimensions ||
      model.queryInputScale?.length !== inputDimensions ||
      model.queryInputScale.some(
        (value) => !Number.isFinite(value) || value <= 0,
      ) ||
      model.queryHiddenWeights?.length !== hiddenDimensions ||
      model.queryHiddenIntercept?.length !== hiddenDimensions ||
      model.queryOutputWeights?.length !== embeddingDimensions ||
      model.queryOutputIntercept?.length !== embeddingDimensions ||
      model.queryHiddenWeights.some(
        (row) => row.length !== inputDimensions,
      ) ||
      model.queryOutputWeights.some(
        (row) => row.length !== hiddenDimensions,
      ));
  if (
    commonDimensionsInvalid ||
    linearDimensionsInvalid ||
    nonlinearDimensionsInvalid
  ) {
    throw new Error("dual encoder 차원이 올바르지 않습니다.");
  }
  if (
    !Number.isFinite(model.blendWeight) ||
    model.blendWeight < 0 ||
    model.blendWeight > 1 ||
    !Number.isInteger(model.rerankLimit) ||
    model.rerankLimit < 1
  ) {
    throw new Error("dual encoder 재정렬 설정이 올바르지 않습니다.");
  }
  return model;
}

/**
 * @param {number[]} profile
 * @param {Record<string, any>} model
 */
export function encodeQueryProfile(profile, model) {
  validateDualEncoder(model);
  const feature = modelFeatureFromProfile(profile, model);
  if (
    model.kind === "vth-dual-curve-mlp" ||
    model.kind === "vth-dual-image-curve-mlp"
  ) {
    const standardized = feature.map(
      (value, index) =>
        (value - model.queryInputMean[index]) /
        model.queryInputScale[index],
    );
    const hidden = matrixVector(
      model.queryHiddenWeights,
      standardized,
    ).map((value, index) =>
      Math.tanh(value + model.queryHiddenIntercept[index]),
    );
    return unit(
      matrixVector(model.queryOutputWeights, hidden).map(
        (value, index) => value + model.queryOutputIntercept[index],
      ),
    );
  }
  return unit(
    matrixVector(model.queryWeights, feature).map(
      (value, index) => value + model.queryIntercept[index],
    ),
  );
}

/**
 * @param {number[]} profile
 * @param {Record<string, any>} model
 */
export function encodeCandidateProfile(profile, model) {
  validateDualEncoder(model);
  const feature = modelFeatureFromProfile(profile, model);
  const centered = feature.map(
    (value, index) => value - model.candidateMean[index],
  );
  return unit(matrixVector(model.candidateComponents, centered));
}

/**
 * @param {number[]} queryProfile
 * @param {number[]} candidateProfile
 * @param {Record<string, any>} model
 */
export function dualCurveSimilarity(
  queryProfile,
  candidateProfile,
  model,
) {
  const query = encodeQueryProfile(queryProfile, model);
  const candidate = encodeCandidateProfile(candidateProfile, model);
  const cosine = query.reduce(
    (sum, value, index) => sum + value * candidate[index],
    0,
  );
  return Math.max(0, Math.min(1, (cosine + 1) / 2));
}

/**
 * Reorder only the baseline top-N set. This keeps Recall@N from regressing
 * while allowing the learned embedding to break close shape ties.
 *
 * @param {Record<string, any>[]} baselineResults
 * @param {number[][]} queryProfiles
 * @param {Record<string, any> | undefined} model
 */
export function rerankWithDualEncoder(
  baselineResults,
  queryProfiles,
  model,
) {
  if (!model || !baselineResults.length) return baselineResults;
  validateDualEncoder(model);
  if (!model.blendWeight) return baselineResults;
  const limit = Math.min(model.rerankLimit, baselineResults.length);
  const head = baselineResults.slice(0, limit).map((result) => {
    const learned = Math.max(
      ...queryProfiles.map((profile) =>
        dualCurveSimilarity(profile, result.profile, model),
      ),
    );
    const dualRerankedScore =
      (1 - model.blendWeight) * result.score +
      model.blendWeight * learned;
    return {
      ...result,
      score: dualRerankedScore,
      dualRerankedScore,
      dualEncoderScore: learned,
      reasons:
        learned >= 0.82
          ? [
              "학습 임베딩에서도 같은 Curve 형상 군으로 판정됩니다.",
              ...(result.reasons ?? []),
            ].slice(0, 3)
          : result.reasons,
    };
  });
  head.sort((left, right) => {
    const exactDifference =
      Number((right.curveScore ?? 0) >= 0.995) -
      Number((left.curveScore ?? 0) >= 0.995);
    return exactDifference || right.score - left.score;
  });
  // The learned score decides the order, while the displayed calibrated match
  // score keeps the descending baseline score slots. Without this projection,
  // recalculating only Top-N could show Rank 3 with a larger "% MATCH" than
  // Rank 1 even though the learned reranker intentionally promoted Rank 1.
  const calibratedScoreSlots = baselineResults
    .slice(0, limit)
    .map((result) => result.score)
    .sort((left, right) => right - left);
  const calibratedHead = head.map((result, index) => ({
    ...result,
    score: calibratedScoreSlots[index],
  }));
  return [...calibratedHead, ...baselineResults.slice(limit)];
}
