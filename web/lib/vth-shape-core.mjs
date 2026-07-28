import {
  canonicalImageFeatureFromProfile,
  rerankWithDualEncoder,
} from "./vth-dual-encoder-core.mjs";

const SUPPORTED_STATE_COUNTS = [2, 4, 8, 16];
const CANONICAL_IMAGE_RERANK_LIMIT = 2;
const CANONICAL_IMAGE_RERANK_BLEND = 0.08;
const CANONICAL_IMAGE_NEIGHBOR_FLOOR = 0.80;
const CANONICAL_IMAGE_MARGIN = 0.02;
const PROFILE_IMAGE_MARGIN = 0.002;
const ARTIFACT_RESCUE_TOP_LIMIT = 10;
const ARTIFACT_RESCUE_PRIMARY_CEILING = 0.55;
const ARTIFACT_RESCUE_CONSENSUS_FLOOR = 0.70;
const ARTIFACT_RESCUE_MARGIN = 0.18;
const canonicalImageFeatureCache = new WeakMap();

function canonicalImageFeature(profile) {
  const cached = canonicalImageFeatureCache.get(profile);
  if (cached) return cached;
  const feature = canonicalImageFeatureFromProfile(profile);
  canonicalImageFeatureCache.set(profile, feature);
  return feature;
}

/**
 * @param {number} value
 * @param {number} [lower]
 * @param {number} [upper]
 */
export function clamp(value, lower = 0, upper = 1) {
  return Math.min(upper, Math.max(lower, value));
}

/**
 * @param {number[]} values
 * @param {number} radius
 */
export function movingAverage(values, radius) {
  return values.map((_, index) => {
    let sum = 0;
    let weight = 0;
    for (
      let offset = Math.max(0, index - radius);
      offset <= Math.min(values.length - 1, index + radius);
      offset += 1
    ) {
      const localWeight = radius + 1 - Math.abs(index - offset);
      sum += values[offset] * localWeight;
      weight += localWeight;
    }
    return weight ? sum / weight : values[index];
  });
}

/**
 * @param {number[]} values
 * @param {number} [size]
 */
export function resample(values, size = 256) {
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

/**
 * @param {number[]} values
 * @param {number} fraction
 */
function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ];
}

/**
 * @param {number[]} values
 */
function interpolateMissing(values) {
  const valid = values
    .map((value, index) => (Number.isFinite(value) ? index : -1))
    .filter((index) => index >= 0);
  if (!valid.length) return values.map(() => 0);

  const output = [...values];
  for (let index = 0; index < output.length; index += 1) {
    if (Number.isFinite(output[index])) continue;
    let left = index - 1;
    let right = index + 1;
    while (left >= 0 && !Number.isFinite(output[left])) left -= 1;
    while (right < output.length && !Number.isFinite(output[right])) right += 1;
    if (left >= 0 && right < output.length) {
      const fraction = (index - left) / (right - left);
      output[index] =
        output[left] * (1 - fraction) + output[right] * fraction;
    } else if (left >= 0) output[index] = output[left];
    else output[index] = output[right];
  }
  return output;
}

/**
 * Collapse a cleaned curve mask into the same 256-point canonical profile used
 * by the hosted application.
 *
 * @param {Uint8Array} curveMask
 * @param {number} width
 * @param {number} height
 * @returns {{
 *   profile: number[];
 *   boundaryFraction: number;
 *   denseRegion: boolean;
 *   activePixels: number;
 * }}
 */
export function canonicalProfileFromCurveMask(curveMask, width, height) {
  const bandHeight = Math.max(1, Math.floor(height / 6));
  let activePixels = 0;
  let topActive = 0;
  let bottomActive = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!curveMask[y * width + x]) continue;
      activePixels += 1;
      if (y < bandHeight) topActive += 1;
      if (y >= height - bandHeight) bottomActive += 1;
    }
  }

  const denseRegion = activePixels / (width * height) > 0.12;
  const topOccupancy = topActive / (width * bandHeight);
  const bottomOccupancy = bottomActive / (width * bandHeight);
  const boundaryFraction =
    denseRegion &&
    topOccupancy > 0.55 &&
    topOccupancy > bottomOccupancy * 1.12
      ? 0.92
      : 0.08;

  const rawProfile = Array(width).fill(Number.NaN);
  const verticalLineColumns = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) {
    const active = [];
    for (let y = 0; y < height; y += 1) {
      if (curveMask[y * width + x]) active.push(y);
    }
    if (active.length) {
      const curveEdge = quantile(active, boundaryFraction);
      rawProfile[x] = 1 - curveEdge / Math.max(1, height - 1);
      let longestRun = 1;
      let run = 1;
      for (let index = 1; index < active.length; index += 1) {
        if (active[index] - active[index - 1] <= 2) {
          run += active[index] - active[index - 1];
          longestRun = Math.max(longestRun, run);
        } else {
          run = 1;
        }
      }
      if (
        longestRun / height >= 0.22 &&
        active.length / longestRun >= 0.72
      ) {
        verticalLineColumns[x] = 1;
      }
    }
  }

  // A partial vertical guide can be shorter than the grid-line threshold yet
  // still create a false narrow peak in the top-edge profile. Replace only
  // thin, line-dense column groups whose extracted height is discontinuous
  // from both neighboring Curve samples. Steep VTH tails remain because their
  // top edge is locally continuous even when the ink below is nearly vertical.
  const maximumArtifactWidth = Math.max(3, Math.floor(width * 0.012));
  const neighborSearch = Math.max(8, Math.floor(width * 0.035));
  for (let start = 0; start < width; start += 1) {
    if (!verticalLineColumns[start]) continue;
    let end = start;
    while (end + 1 < width && verticalLineColumns[end + 1]) end += 1;
    if (end - start + 1 <= maximumArtifactWidth) {
      let left = start - 1;
      let right = end + 1;
      while (
        left >= Math.max(0, start - neighborSearch) &&
        (!Number.isFinite(rawProfile[left]) || verticalLineColumns[left])
      ) {
        left -= 1;
      }
      while (
        right <= Math.min(width - 1, end + neighborSearch) &&
        (!Number.isFinite(rawProfile[right]) || verticalLineColumns[right])
      ) {
        right += 1;
      }
      if (
        left >= 0 &&
        right < width &&
        Number.isFinite(rawProfile[left]) &&
        Number.isFinite(rawProfile[right])
      ) {
        for (let x = start; x <= end; x += 1) {
          const fraction = (x - left) / (right - left);
          const expected =
            rawProfile[left] * (1 - fraction) +
            rawProfile[right] * fraction;
          if (Math.abs(rawProfile[x] - expected) >= 0.065) {
            rawProfile[x] = expected;
          }
        }
      }
    }
    start = end;
  }

  const filled = interpolateMissing(rawProfile);
  const smoothed = movingAverage(resample(filled), 3).map((value) =>
    clamp(value),
  );
  const peak = Math.max(...smoothed, 1e-9);
  return {
    profile: smoothed.map((value) => value / peak),
    boundaryFraction,
    denseRegion,
    activePixels,
  };
}

/**
 * @param {number[]} profile
 * @returns {{ index: number; prominence: number }[]}
 */
export function detectPeaks(profile) {
  const minimumDistance = Math.max(5, Math.floor(profile.length / 28));
  const candidates = [];
  const window = Math.max(8, Math.floor(profile.length / 18));

  for (let index = 2; index < profile.length - 2; index += 1) {
    if (profile[index] < 0.12) continue;
    if (
      profile[index] < profile[index - 1] ||
      profile[index] <= profile[index + 1]
    ) {
      continue;
    }
    const leftFloor = Math.min(
      ...profile.slice(Math.max(0, index - window), index),
    );
    const rightFloor = Math.min(
      ...profile.slice(
        index + 1,
        Math.min(profile.length, index + window + 1),
      ),
    );
    const prominence = profile[index] - Math.max(leftFloor, rightFloor);
    if (prominence >= 0.006) candidates.push({ index, prominence });
  }

  const edgeSpan = Math.max(
    minimumDistance * 2,
    Math.floor(profile.length / 10),
  );
  for (const mirrored of [false, true]) {
    const edgeValues = mirrored ? [...profile].reverse() : profile;
    let localIndex = 0;
    for (let index = 1; index < edgeSpan; index += 1) {
      if (edgeValues[index] > edgeValues[localIndex]) localIndex = index;
    }
    const index = mirrored ? profile.length - 1 - localIndex : localIndex;
    const floor = Math.min(
      ...edgeValues.slice(
        localIndex,
        Math.min(
          profile.length,
          localIndex + Math.max(edgeSpan * 2, Math.floor(profile.length / 2)),
        ),
      ),
    );
    const prominence = edgeValues[localIndex] - floor;
    if (
      edgeValues[localIndex] >= 0.12 &&
      prominence >= 0.006 &&
      candidates.every(
        (candidate) => Math.abs(candidate.index - index) >= minimumDistance,
      )
    ) {
      candidates.push({ index, prominence });
    }
  }

  const selected = [];
  for (const candidate of [...candidates].sort(
    (left, right) => right.prominence - left.prominence,
  )) {
    if (
      selected.every(
        (existing) =>
          Math.abs(existing.index - candidate.index) >= minimumDistance,
      )
    ) {
      selected.push(candidate);
    }
  }
  selected.sort((left, right) => left.index - right.index);
  return selected;
}

/**
 * Select the subset whose inter-peak spacing is most regular. This removes a
 * weak shoulder or tail turning point without dropping a real shallow State.
 *
 * @param {{index: number; prominence: number}[]} candidates
 * @param {number} stateCount
 * @param {number} profileLength
 */
function selectStructuredPeaks(candidates, stateCount, profileLength) {
  if (candidates.length <= stateCount) return [...candidates];
  const fullSpan = Math.max(
    1,
    candidates[candidates.length - 1].index - candidates[0].index,
  );
  let best = null;
  let bestCost = Number.POSITIVE_INFINITY;

  const visit = (start, selected) => {
    if (selected.length === stateCount) {
      const spacings = selected
        .slice(1)
        .map(
          (candidate, index) =>
            candidate.index - selected[index].index,
        );
      const mean =
        spacings.reduce((sum, value) => sum + value, 0) /
        Math.max(1, spacings.length);
      const variance =
        spacings.reduce(
          (sum, value) => sum + (value - mean) ** 2,
          0,
        ) / Math.max(1, spacings.length);
      const lostSpan =
        (fullSpan -
          (selected[selected.length - 1].index - selected[0].index)) /
        Math.max(1, profileLength - 1);
      const cost = Math.sqrt(variance) / Math.max(1, mean) + 0.15 * lostSpan;
      if (cost < bestCost) {
        bestCost = cost;
        best = [...selected];
      }
      return;
    }
    const remaining = stateCount - selected.length;
    for (
      let index = start;
      index <= candidates.length - remaining;
      index += 1
    ) {
      selected.push(candidates[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return best ?? candidates.slice(0, stateCount);
}

/**
 * @param {number[]} profileInput
 * @returns {{
 *   stateCount: number;
 *   observedStateCount: number;
 *   regularized: boolean;
 *   peakLocations: number[];
 *   peakWidths: number[];
 *   valleyHeights: number[];
 *   valleyLocations: number[];
 *   valleyDepths: number[];
 *   valleyPositionRatios: number[];
 *   peakValleyDistances: number[];
 *   tailSlopes: number[];
 *   area: number;
 * }}
 */
export function descriptorFromProfile(profileInput) {
  const profile = movingAverage(resample(profileInput), 2);
  const candidates = detectPeaks(profile);
  const observed = candidates.filter((peak) => peak.prominence >= 0.05);
  const observedCount = observed.length || candidates.length;
  const candidateSpacings = candidates
    .slice(1)
    .map((peak, index) => peak.index - candidates[index].index);
  const ascendingSpacings = [...candidateSpacings].sort(
    (left, right) => left - right,
  );
  const spacingMedian = ascendingSpacings.length
    ? ascendingSpacings[Math.floor(ascendingSpacings.length / 2)]
    : 0;
  const orderedSpacings = [...candidateSpacings].sort(
    (left, right) => right - left,
  );
  const structuredFourStateLayout =
    candidates.length === 4 &&
    candidates[3].index - candidates[0].index >= profile.length * 0.65 &&
    Math.min(...candidates.map((peak) => peak.prominence)) >= 0.009 &&
    Math.max(...candidateSpacings) / Math.max(1, Math.min(...candidateSpacings)) <=
      2;
  // Dense measured markers can split each physical State maximum into two or
  // three local peaks. Four broad groups remain visible as three large gaps,
  // while genuine 8-State profiles have much more uniform spacing.
  const clusteredFourStateLayout =
    candidates.length >= 5 &&
    candidates.length <= 9 &&
    candidates[candidates.length - 1].index - candidates[0].index >=
      profile.length * 0.78 &&
    orderedSpacings[2] >= profile.length * 0.16 &&
    (orderedSpacings[3] ?? 0) <= profile.length * 0.12;
  const denseEightStateLayout =
    observedCount >= 4 &&
    observedCount <= 7 &&
    candidates.length >= 8 &&
    candidates.length <= 10 &&
    candidates[candidates.length - 1].index - candidates[0].index >=
      profile.length * 0.62 &&
    spacingMedian > 0 &&
    Math.max(...candidateSpacings) <= spacingMedian * 1.8 &&
    Math.min(...candidateSpacings) >= spacingMedian * 0.4;
  let stateCount;
  if (structuredFourStateLayout || clusteredFourStateLayout) {
    stateCount = 4;
  } else if (denseEightStateLayout) {
    stateCount = 8;
  } else if (
    observedCount === 3 &&
    candidates.length >= 4 &&
    candidates.length <= 9
  ) {
    stateCount = 4;
  } else if (candidates.length === 2 && observedCount === 1) {
    stateCount = 2;
  } else {
    stateCount =
      observedCount >= 2
        ? SUPPORTED_STATE_COUNTS.reduce((best, count) =>
            Math.abs(count - observedCount) < Math.abs(best - observedCount)
              ? count
              : best,
          )
        : observedCount;
  }
  if (observedCount === 7 && candidates.length === 15) {
    stateCount = 8;
  } else if (stateCount < 16 && candidates.length >= 15) {
    stateCount = 16;
  }

  const selectedPeakCount = Math.min(
    stateCount || candidates.length,
    candidates.length,
  );
  const peaks = denseEightStateLayout
    ? selectStructuredPeaks(candidates, selectedPeakCount, profile.length)
    : [...candidates]
        .sort((left, right) => right.prominence - left.prominence)
        .slice(0, selectedPeakCount)
        .sort((left, right) => left.index - right.index);

  const peakWidths = peaks.map(({ index }, peakNumber) => {
    const leftBoundary = peakNumber ? peaks[peakNumber - 1].index : 0;
    const rightBoundary =
      peakNumber + 1 < peaks.length
        ? peaks[peakNumber + 1].index
        : profile.length - 1;
    const leftFloor = Math.min(...profile.slice(leftBoundary, index + 1));
    const rightFloor = Math.min(...profile.slice(index, rightBoundary + 1));
    const localFloor =
      index === 0
        ? rightFloor
        : index === profile.length - 1
          ? leftFloor
          : Math.max(leftFloor, rightFloor);
    const halfHeight = localFloor + (profile[index] - localFloor) * 0.5;
    let left = index;
    let right = index;
    while (left > leftBoundary && profile[left] > halfHeight) left -= 1;
    while (right < rightBoundary && profile[right] > halfHeight) right += 1;
    return (right - left) / profile.length;
  });

  const valleyHeights = [];
  const valleyLocations = [];
  const valleyDepths = [];
  const valleyPositionRatios = [];
  const peakValleyDistances = [];
  const tailSlopes = [];
  for (let peakIndex = 0; peakIndex < peaks.length - 1; peakIndex += 1) {
    const leftPeak = peaks[peakIndex].index;
    const rightPeak = peaks[peakIndex + 1].index;
    let valley = leftPeak;
    for (let index = leftPeak; index <= rightPeak; index += 1) {
      if (profile[index] < profile[valley]) valley = index;
    }
    const valleyHeight = profile[valley];
    valleyHeights.push(valleyHeight);
    const leftDistance = Math.max(1, valley - leftPeak);
    const rightDistance = Math.max(1, rightPeak - valley);
    const peakGap = Math.max(1, rightPeak - leftPeak);
    valleyLocations.push(valley / Math.max(1, profile.length - 1));
    valleyDepths.push(
      Math.max(
        0,
        Math.min(profile[leftPeak], profile[rightPeak]) - valleyHeight,
      ),
    );
    valleyPositionRatios.push(leftDistance / peakGap);
    peakValleyDistances.push(
      leftDistance / Math.max(1, profile.length - 1),
      rightDistance / Math.max(1, profile.length - 1),
    );
    tailSlopes.push(
      (profile[leftPeak] - valleyHeight) / leftDistance,
      (profile[rightPeak] - valleyHeight) / rightDistance,
    );
  }

  return {
    stateCount,
    observedStateCount: observedCount,
    regularized: observedCount !== stateCount,
    peakLocations: peaks.map(({ index }) => index / (profile.length - 1)),
    peakWidths,
    valleyHeights,
    valleyLocations,
    valleyDepths,
    valleyPositionRatios,
    peakValleyDistances,
    tailSlopes,
    area: profile.reduce((sum, value) => sum + value, 0) / profile.length,
  };
}

/**
 * @param {number[]} left
 * @param {number[]} right
 */
function dot(left, right) {
  return left.reduce(
    (sum, value, index) => sum + value * right[index],
    0,
  );
}

/**
 * @param {number[]} left
 * @param {number[]} right
 */
export function cosine(left, right) {
  const leftNorm = Math.sqrt(dot(left, left));
  const rightNorm = Math.sqrt(dot(right, right));
  if (!leftNorm || !rightNorm) return 0;
  return clamp(dot(left, right) / (leftNorm * rightNorm), -1, 1);
}

function rerankWithCanonicalImageEmbedding(results) {
  const limit = Math.min(CANONICAL_IMAGE_RERANK_LIMIT, results.length);
  if (limit < 2) return results;
  const leader = results[0];
  const challenger = results[1];
  if (
    (leader.curveScore ?? 0) >= 0.995 ||
    alignedCurveSimilarity(leader.profile, challenger.profile) <
      CANONICAL_IMAGE_NEIGHBOR_FLOOR ||
    challenger.imageScore <
      leader.imageScore + CANONICAL_IMAGE_MARGIN ||
    challenger.profileScore <
      leader.profileScore + PROFILE_IMAGE_MARGIN
  ) {
    return results;
  }
  const leaderScore =
    (1 - CANONICAL_IMAGE_RERANK_BLEND) * leader.score +
    CANONICAL_IMAGE_RERANK_BLEND * leader.imageScore;
  const challengerScore =
    (1 - CANONICAL_IMAGE_RERANK_BLEND) * challenger.score +
    CANONICAL_IMAGE_RERANK_BLEND * challenger.imageScore;
  if (challengerScore <= leaderScore) return results;
  const promotedScore = Math.max(leader.score, challenger.score);
  const demotedScore = Math.min(leader.score, challenger.score);
  return [
    {
      ...challenger,
      score: promotedScore,
      imageEmbeddingReranked: true,
    },
    {
      ...leader,
      score: demotedScore,
      imageEmbeddingReranked: true,
    },
    ...results.slice(limit),
  ];
}

/**
 * Summarize whether one complete preprocessing hypothesis has a coherent
 * image-shape match in the corpus. The leader keeps most of the weight, while
 * the best canonical-image neighbor in Top-10 can recover an exact shape that
 * the Curve reranker placed a few positions lower.
 *
 * @param {Record<string, any>[]} results
 */
function artifactHypothesisConfidence(results) {
  if (!results.length) {
    return { consensus: 0, maximumImage: 0 };
  }
  const maximumImage = Math.max(
    ...results
      .slice(0, ARTIFACT_RESCUE_TOP_LIMIT)
      .map((result) => result.imageScore ?? 0),
  );
  return {
    consensus:
      0.65 * (results[0].imageScore ?? 0) + 0.35 * maximumImage,
    maximumImage,
  };
}

/**
 * Candidate-specific maximization across several masks can create a
 * "Franken-query": every unrelated candidate is allowed to match a different
 * fragment. Only replace it when one complete artifact-removal hypothesis has
 * substantially stronger canonical-image support.
 *
 * @param {{
 *   descriptor: ReturnType<typeof descriptorFromProfile>;
 *   artifactRescue?: boolean;
 * }[]} hypotheses
 * @param {Record<string, any>[][]} rankings
 */
function selectCoherentArtifactHypothesis(hypotheses, rankings) {
  const primary = artifactHypothesisConfidence(rankings[0]);
  let selectedIndex = 0;
  let selectedAdvantage = 0;

  for (let index = 1; index < hypotheses.length; index += 1) {
    const hypothesis = hypotheses[index];
    if (hypothesis.artifactRescue !== true) continue;
    const confidence = artifactHypothesisConfidence(rankings[index]);
    const sameState =
      hypothesis.descriptor.stateCount ===
      hypotheses[0].descriptor.stateCount;
    const restoresEightStateTlc =
      hypotheses[0].descriptor.stateCount === 4 &&
      hypothesis.descriptor.stateCount === 8;
    const advantage = sameState
      ? confidence.consensus - primary.consensus
      : confidence.maximumImage - primary.maximumImage;
    const eligible =
      (sameState &&
        primary.consensus < ARTIFACT_RESCUE_PRIMARY_CEILING &&
        confidence.consensus >= ARTIFACT_RESCUE_CONSENSUS_FLOOR &&
        advantage >= ARTIFACT_RESCUE_MARGIN) ||
      (restoresEightStateTlc && advantage >= ARTIFACT_RESCUE_MARGIN);
    if (eligible && advantage > selectedAdvantage) {
      selectedIndex = index;
      selectedAdvantage = advantage;
    }
  }

  return {
    selectedIndex,
    selectedAdvantage,
  };
}

/**
 * @param {number[]} values
 */
function gradient(values) {
  return values.map((value, index) => {
    if (index === 0) return values[1] - value;
    if (index === values.length - 1) return value - values[index - 1];
    return (values[index + 1] - values[index - 1]) / 2;
  });
}

/**
 * @param {number[]} leftInput
 * @param {number[]} rightInput
 */
export function alignedCurveSimilarity(leftInput, rightInput) {
  const left = resample(leftInput, 128);
  const right = resample(rightInput, 128);
  const leftFirst = gradient(left);
  const rightFirst = gradient(right);
  const leftSecond = gradient(leftFirst);
  const rightSecond = gradient(rightFirst);
  let best = -1;
  for (let shift = -10; shift <= 10; shift += 1) {
    const startLeft = Math.max(0, -shift);
    const endLeft = Math.min(128, 128 - shift);
    const startRight = Math.max(0, shift);
    const endRight = startRight + (endLeft - startLeft);
    const slices = [
      [left.slice(startLeft, endLeft), right.slice(startRight, endRight), 0.72],
      [
        leftFirst.slice(startLeft, endLeft),
        rightFirst.slice(startRight, endRight),
        0.2,
      ],
      [
        leftSecond.slice(startLeft, endLeft),
        rightSecond.slice(startRight, endRight),
        0.08,
      ],
    ];
    const score = slices.reduce(
      (sum, [leftSlice, rightSlice, weight]) =>
        sum + weight * cosine(leftSlice, rightSlice),
      0,
    );
    best = Math.max(best, score);
  }
  return clamp(best);
}

/**
 * @param {number[]} left
 * @param {number[]} right
 */
function sequenceDistance(left, right) {
  if (!left.length || !right.length) return left.length === right.length ? 0 : 1;
  const size = Math.max(left.length, right.length);
  const leftValues = resample(left, size);
  const rightValues = resample(right, size);
  return (
    leftValues.reduce(
      (sum, value, index) => sum + Math.abs(value - rightValues[index]),
      0,
    ) / size
  );
}

/**
 * @param {Record<string, any>} descriptor
 * @param {number[] | undefined} profile
 */
function peakValleyRelations(descriptor, profile) {
  if (
    Array.isArray(descriptor.valleyDepths) &&
    Array.isArray(descriptor.peakValleyDistances) &&
    Array.isArray(descriptor.valleyPositionRatios)
  ) {
    return {
      depths: descriptor.valleyDepths,
      distances: descriptor.peakValleyDistances,
      ratios: descriptor.valleyPositionRatios,
    };
  }
  if (Array.isArray(profile)) {
    const rebuilt = descriptorFromProfile(profile);
    return {
      depths: rebuilt.valleyDepths,
      distances: rebuilt.peakValleyDistances,
      ratios: rebuilt.valleyPositionRatios,
    };
  }
  return { depths: [], distances: [], ratios: [] };
}

/**
 * @param {ReturnType<typeof peakValleyRelations>} query
 * @param {ReturnType<typeof peakValleyRelations>} candidate
 */
function peakValleyComponents(query, candidate) {
  const depth = Math.exp(
    -10 * sequenceDistance(query.depths, candidate.depths),
  );
  const distance = Math.exp(
    -18 * sequenceDistance(query.distances, candidate.distances),
  );
  const position = Math.exp(
    -4 * sequenceDistance(query.ratios, candidate.ratios),
  );
  const queryMedianDepth = quantile(query.depths, 0.5);
  const candidateMedianDepth = quantile(candidate.depths, 0.5);
  const isDenseShallowQuery =
    query.depths.length === 7 &&
    queryMedianDepth <= 0.16 &&
    Math.max(...query.depths) <= 0.2;
  return {
    depth,
    distance,
    position,
    combined: 0.55 * depth + 0.3 * distance + 0.15 * position,
    queryMedianDepth,
    candidateMedianDepth,
    weight: isDenseShallowQuery ? 0.18 : 0,
    shallowOverlap:
      query.depths.length > 0 &&
      candidate.depths.length > 0 &&
      queryMedianDepth <= 0.18 &&
      candidateMedianDepth <= 0.18,
  };
}

/**
 * @param {ReturnType<typeof descriptorFromProfile>} query
 * @param {Record<string, any>} candidate
 * @param {{
 *   curve: number;
 *   location: number;
 *   width: number;
 *   valley: number;
 *   tail: number;
 *   peakValley: number;
 *   shallowOverlap: boolean;
 * }} components
 */
function explain(query, candidate, components) {
  const reasons = [];
  if (query.stateCount === candidate.stateCount) {
    reasons.push(`검출된 State 봉우리 수가 ${query.stateCount}개로 같습니다.`);
  }
  if (components.shallowOverlap) {
    reasons.push("peak에 가까운 얕은 valley 패턴이 유사합니다.");
  } else if (components.peakValley >= 0.82) {
    reasons.push("peak와 valley의 상대 깊이·간격이 가깝습니다.");
  }
  if (components.location >= 0.86) {
    reasons.push("봉우리의 상대적인 Vth 위치 배열이 가깝습니다.");
  }
  if (components.width >= 0.82) {
    reasons.push("각 State 분포의 폭과 퍼짐 정도가 가깝습니다.");
  }
  if (components.curve >= 0.9) {
    reasons.push("축을 제거한 전체 로그 Curve 윤곽이 매우 유사합니다.");
  } else if (components.curve >= 0.82) {
    reasons.push("축을 제거한 전체 로그 Curve 윤곽이 유사합니다.");
  }
  if (components.valley >= 0.86 && components.tail >= 0.8) {
    reasons.push("State 사이 valley 깊이와 tail 기울기가 가깝습니다.");
  }
  return reasons.slice(0, 3).length
    ? reasons.slice(0, 3)
    : ["로그 축에서 정규화한 전체 분포 형상의 종합 거리가 가깝습니다."];
}

/**
 * @param {number[]} profile
 * @param {ReturnType<typeof descriptorFromProfile>} descriptor
 * @param {Record<string, any>[]} candidates
 * @param {{
 *   featureNames: string[];
 *   weights: number[];
 *   intercept: number;
 *   finalBlend: {curve: number; model: number; retrieval: number};
 *   scoreCalibration?: {reranked: number; retrieval: number};
 * } | undefined} reranker
 * @param {{
 *   profile: number[];
 *   descriptor: ReturnType<typeof descriptorFromProfile>;
 * }[]} [alternativeHypotheses]
 * @param {Record<string, any> | undefined} [dualEncoder]
 */
export function searchCorpus(
  profile,
  descriptor,
  candidates,
  reranker,
  alternativeHypotheses = [],
  dualEncoder,
) {
  const hypotheses = [
    { profile, descriptor, hypothesisIndex: 0 },
    ...alternativeHypotheses.map((hypothesis, index) => ({
      ...hypothesis,
      hypothesisIndex: index + 1,
    })),
  ].map((hypothesis) => ({
    ...hypothesis,
    imageFeature: canonicalImageFeature(hypothesis.profile),
  }));

  if (
    alternativeHypotheses.some(
      (hypothesis) => hypothesis.artifactRescue === true,
    )
  ) {
    const coherentRankings = hypotheses.map((hypothesis) =>
      searchCorpus(
        hypothesis.profile,
        hypothesis.descriptor,
        candidates,
        reranker,
        [],
        dualEncoder,
      ),
    );
    const rescue = selectCoherentArtifactHypothesis(
      hypotheses,
      coherentRankings,
    );
    if (rescue.selectedIndex > 0) {
      return coherentRankings[rescue.selectedIndex].map(
        (result, index) => ({
          ...result,
          rank: index + 1,
          curveHypothesisIndex: rescue.selectedIndex,
          artifactRescueReranked: true,
          artifactRescueAdvantage: rescue.selectedAdvantage,
          reasons: [
            "격자·가이드선을 제거한 한 개의 일관된 Curve 형상이 더 강하게 일치합니다.",
            ...(result.reasons ?? []),
          ].slice(0, 3),
        }),
      );
    }
  }

  const hypothesisStateCounts = new Set(
    hypotheses
      .map((hypothesis) => hypothesis.descriptor.stateCount)
      .filter((stateCount) => [2, 4, 8, 16].includes(stateCount)),
  );
  const stateSupportedCandidates = candidates.filter((candidate) =>
    hypothesisStateCounts.has(candidate.stateCount),
  );
  const searchPool =
    stateSupportedCandidates.length >= 10
      ? stateSupportedCandidates
      : candidates;

  const baselineResults = searchPool
    .map((candidate) => {
      const stateCompatibleHypotheses = hypotheses.filter(
        (hypothesis) =>
          hypothesis.descriptor.stateCount === candidate.stateCount,
      );
      const candidateHypotheses = stateCompatibleHypotheses.length
        ? stateCompatibleHypotheses
        : hypotheses;
      const bestHypothesis = candidateHypotheses
        .map((hypothesis) => {
          const curve = alignedCurveSimilarity(
            hypothesis.profile,
            candidate.profile,
          );
          const primaryAgreement =
            hypothesis.hypothesisIndex === 0
              ? 1
              : alignedCurveSimilarity(hypothesis.profile, profile);
          return {
          ...hypothesis,
            curve,
            selectionScore:
              curve -
              (hypothesis.hypothesisIndex === 0
                ? 0
                : 0.01 +
                  (hypothesis.artifactRescue ? 0.08 : 0.5) *
                    (1 - primaryAgreement)),
          };
        })
        .sort(
          (left, right) =>
            right.selectionScore - left.selectionScore,
        )[0];
      const curve = bestHypothesis.curve;
      const shapeDescriptor = bestHypothesis.descriptor;
      const location = Math.exp(
        -5 *
          sequenceDistance(
            shapeDescriptor.peakLocations,
            candidate.peakLocations,
          ),
      );
      const width = Math.exp(
        -8 *
          sequenceDistance(
            shapeDescriptor.peakWidths,
            candidate.peakWidths,
          ),
      );
      const valley = Math.exp(
        -5 *
          sequenceDistance(
            shapeDescriptor.valleyHeights,
            candidate.valleyHeights,
          ),
      );
      const tail = Math.exp(
        -18 *
          sequenceDistance(
            shapeDescriptor.tailSlopes,
            candidate.tailSlopes,
          ),
      );
      const count = Math.exp(
        -0.6 *
          Math.abs(shapeDescriptor.stateCount - candidate.stateCount),
      );
      const profileImage = cosine(profile, candidate.profile);
      const canonicalImage = cosine(
        bestHypothesis.imageFeature,
        canonicalImageFeature(candidate.profile),
      );
      const area = Math.exp(
        -5 * Math.abs(shapeDescriptor.area - candidate.area),
      );
      const relation = peakValleyComponents(
        peakValleyRelations(shapeDescriptor),
        peakValleyRelations(descriptorFromProfile(candidate.profile)),
      );
      const featureValues = {
        // Preserve the pairwise model's historical 256-point profile input.
        // The independent 3,200-D canonical image vector enters retrieval
        // below and is surfaced separately in result diagnostics.
        image_cosine: profileImage,
        curve_cosine: curve,
        peak_count_similarity: count,
        peak_location_similarity: location,
        peak_width_similarity: width,
        area_similarity: area,
        valley_similarity: valley,
        tail_slope_similarity: tail,
      };
      const modelScore = reranker
        ? 1 /
          (1 +
            Math.exp(
              -(
                reranker.intercept +
                reranker.featureNames.reduce(
                  (sum, name, index) =>
                    sum +
                    (reranker.weights[index] ?? 0) *
                      (featureValues[name] ?? 0),
                  0,
                )
              ),
            ))
        : null;
      const retrieval = 0.18 * profileImage + 0.82 * curve;
      const baseScore =
        modelScore === null
          ? 0.3 * profileImage +
            0.38 * curve +
            0.1 * count +
            0.07 * location +
            0.05 * width +
            0.05 * valley +
            0.05 * tail
          : reranker.finalBlend.curve * curve +
            reranker.finalBlend.model * modelScore +
            reranker.finalBlend.retrieval * retrieval;
      const rerankedScore =
        (1 - relation.weight) * baseScore +
        relation.weight * relation.combined;
      const scoreCalibration = reranker?.scoreCalibration ?? {
        reranked: 1,
        retrieval: 0,
      };
      const score =
        scoreCalibration.reranked * rerankedScore +
        scoreCalibration.retrieval * retrieval;
      return {
        ...candidate,
        rank: 0,
        score,
        rerankedScore,
        retrievalScore: retrieval,
        modelScore,
        imageScore: canonicalImage,
        profileScore: profileImage,
        curveScore: curve,
        countScore: count,
        locationScore: location,
        widthScore: width,
        valleyScore: valley,
        tailScore: tail,
        areaScore: area,
        peakValleyScore: relation.combined,
        valleyDepthScore: relation.depth,
        peakValleyDistanceScore: relation.distance,
        valleyPositionScore: relation.position,
        peakValleyWeight: relation.weight,
        queryMedianValleyDepth: relation.queryMedianDepth,
        candidateMedianValleyDepth: relation.candidateMedianDepth,
        curveHypothesisIndex: bestHypothesis.hypothesisIndex,
        reasons: explain(shapeDescriptor, candidate, {
          curve,
          location,
          width,
          valley,
          tail,
          peakValley: relation.combined,
          shallowOverlap: relation.shallowOverlap,
        }),
      };
    })
    .sort((left, right) => right.score - left.score);

  // Multiple Curve masks may infer different State counts on artifact-heavy
  // screenshots. Pick one count for the result set instead of mixing physical
  // modes. The primary analysis receives a small confidence prior; a fallback
  // wins only when its best corpus match is materially stronger.
  const bestScoreByState = new Map();
  for (const result of baselineResults) {
    bestScoreByState.set(
      result.stateCount,
      Math.max(
        bestScoreByState.get(result.stateCount) ?? -Infinity,
        result.score,
      ),
    );
  }
  const selectedStateCount = [...bestScoreByState.entries()]
    .map(([stateCount, score]) => {
      const hasArtifactRescue = hypotheses.some(
        (hypothesis) =>
          hypothesis.artifactRescue === true &&
          hypothesis.descriptor.stateCount !== descriptor.stateCount,
      );
      return [
        stateCount,
        score +
          (stateCount === descriptor.stateCount
            ? hasArtifactRescue
              ? 0.015
              : 0.03
            : 0),
      ];
    })
    .sort(
      ([leftState, leftScore], [rightState, rightScore]) =>
        rightScore - leftScore ||
        leftState - rightState,
    )[0]?.[0];
  const stateConsistentResults =
    selectedStateCount === undefined
      ? baselineResults
      : baselineResults.filter(
          (result) => result.stateCount === selectedStateCount,
        );
  const dualRerankedResults = rerankWithDualEncoder(
    stateConsistentResults,
    hypotheses
      .filter(
        (hypothesis) =>
          hypothesis.descriptor.stateCount === selectedStateCount,
      )
      .map((hypothesis) => hypothesis.profile),
    dualEncoder,
  );
  return rerankWithCanonicalImageEmbedding(dualRerankedResults)
    .map((result, index) => ({ ...result, rank: index + 1 }));
}
