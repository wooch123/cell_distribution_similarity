import {
  canonicalImageFeatureFromProfile,
  rerankWithDualEncoder,
} from "./vth-dual-encoder-core.mjs";

export const MIN_STATE_COUNT = 1;
export const MAX_STATE_COUNT = 20;
const MAX_AUTOMATIC_REGULARIZED_STATE_COUNT = 16;
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

/**
 * A visible waveform may contain any physical State count from 1 through 20.
 * The generated corpus currently concentrates on 2/4/8/16 NAND modes, but
 * uploaded and slide-extracted charts must not be snapped to those four
 * values merely because they are the common product configurations.
 *
 * @param {unknown} value
 */
export function isValidStateCount(value) {
  const count = Number(value);
  return (
    Number.isInteger(count) &&
    count >= MIN_STATE_COUNT &&
    count <= MAX_STATE_COUNT
  );
}

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
 * @returns {{
 *   index: number;
 *   prominence: number;
 *   localProminence?: number;
 *   edgeProminence?: number;
 *   edgeRescued?: boolean;
 *   edgeRescueEligible?: boolean;
 * }[]}
 */
export function detectPeaks(profile) {
  const minimumDistance = Math.max(5, Math.floor(profile.length / 28));
  const candidates = [];
  const window = Math.max(8, Math.floor(profile.length / 18));

  for (let index = 2; index < profile.length - 2; index += 1) {
    if (profile[index] < 0.115) continue;
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
    if (prominence >= 0.006) {
      candidates.push({
        index,
        prominence,
        localProminence: prominence,
        edgeProminence: 0,
        edgeRescued: false,
      });
    }
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
    const exactCandidate = candidates.find(
      (candidate) => candidate.index === index,
    );
    const halfProminenceHeight =
      edgeValues[localIndex] - prominence * 0.5;
    let inwardSupportWidth = 1;
    for (
      let supportIndex = localIndex + 1;
      supportIndex < edgeValues.length &&
      edgeValues[supportIndex] >= halfProminenceHeight;
      supportIndex += 1
    ) {
      inwardSupportWidth += 1;
    }
    const touchesOuterEdge =
      localIndex < edgeSpan;
    const localProminence =
      exactCandidate?.localProminence ?? 0;
    const canRescueBroadBoundaryState =
      touchesOuterEdge &&
      localProminence < 0.05 &&
      inwardSupportWidth >= minimumDistance;
    const orderedInteriorCandidates = [...candidates].sort(
      (left, right) => left.index - right.index,
    );
    const interiorSpacings = orderedInteriorCandidates
      .slice(1)
      .map(
        (candidate, candidateIndex) =>
          candidate.index -
          orderedInteriorCandidates[candidateIndex].index,
      );
    const sortedInteriorSpacings = [...interiorSpacings].sort(
      (left, right) => left - right,
    );
    const medianInteriorSpacing =
      sortedInteriorSpacings[
        Math.floor(sortedInteriorSpacings.length / 2)
      ] ?? 0;
    const sortedInteriorHeights = orderedInteriorCandidates
      .map((candidate) => profile[candidate.index])
      .sort((left, right) => left - right);
    const medianInteriorHeight =
      sortedInteriorHeights[
        Math.floor(sortedInteriorHeights.length / 2)
      ] ?? 0;
    const nearestInteriorCandidate = mirrored
      ? orderedInteriorCandidates.at(-1)
      : orderedInteriorCandidates[0];
    const boundarySpacing = nearestInteriorCandidate
      ? Math.abs(nearestInteriorCandidate.index - index)
      : 0;
    const completesDenseRegularLattice =
      touchesOuterEdge &&
      exactCandidate == null &&
      orderedInteriorCandidates.length >= 7 &&
      orderedInteriorCandidates.length <= 19 &&
      medianInteriorSpacing > 0 &&
      sortedInteriorSpacings.at(-1) /
        Math.max(1, sortedInteriorSpacings[0]) <=
        1.5 &&
      boundarySpacing >= minimumDistance &&
      boundarySpacing >= medianInteriorSpacing * 0.72 &&
      boundarySpacing <= medianInteriorSpacing * 1.28 &&
      inwardSupportWidth >=
        Math.max(4, Math.ceil(minimumDistance * 0.55)) &&
      edgeValues[localIndex] >=
        medianInteriorHeight * 0.72;
    if (
      edgeValues[localIndex] >= 0.12 &&
      prominence >= 0.006
    ) {
      if (exactCandidate) {
        exactCandidate.edgeProminence = prominence;
        if (canRescueBroadBoundaryState) {
          exactCandidate.edgeRescueEligible = true;
        }
      } else if (
        (canRescueBroadBoundaryState ||
          completesDenseRegularLattice) &&
        candidates.every(
          (candidate) =>
            Math.abs(candidate.index - index) >= minimumDistance,
        )
      ) {
        candidates.push({
          index,
          prominence,
          localProminence: 0,
          edgeProminence: prominence,
          edgeRescued: true,
        });
      }
    }
  }

  // Preserve the established prominence balance for larger State lattices.
  // The one-sided rescue is only needed to disambiguate a two-State curve or
  // an exact three-candidate boundary/shoulder case. Applying it to larger
  // lattices can over-weight both outer States relative to measured interior
  // maxima.
  if (candidates.length <= 3) {
    for (const candidate of candidates) {
      if (candidate.edgeRescueEligible !== true) continue;
      candidate.prominence = Math.max(
        candidate.prominence,
        candidate.edgeProminence ?? 0,
      );
      candidate.edgeRescued = true;
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
 * Eight-State fault profiles in the deployed corpus occasionally contain one
 * strong tail turn at the outer boundary. It appears as a ninth peak, but the
 * remaining eight peaks form a coherent lattice after removing that one
 * boundary turn. Keep this narrow, evidence-based regularization so a genuine
 * 9-State waveform (including one with close interior peaks) remains 9-State.
 *
 * @param {{index: number; prominence: number}[]} observed
 * @param {number} profileLength
 * @returns {number | null}
 */
function eightStateBoundaryArtifactIndex(observed, profileLength) {
  if (observed.length !== 9) return null;
  const spacings = observed
    .slice(1)
    .map((peak, index) => peak.index - observed[index].index);
  const sorted = [...spacings].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (median <= 0) return null;

  const firstIsBoundaryTurn =
    observed[1].index <= profileLength * 0.18 &&
    spacings[0] <= median * 0.62;
  const lastIsBoundaryTurn =
    observed[observed.length - 2].index >= profileLength * 0.82 &&
    spacings[spacings.length - 1] <= median * 0.62;
  if (!firstIsBoundaryTurn && !lastIsBoundaryTurn) return null;

  const remainingSpacings = firstIsBoundaryTurn
    ? spacings.slice(1)
    : spacings.slice(0, -1);
  // A content crop can turn the opposite outer tail into one abnormally long
  // terminal interval. It is not part of the repeated State lattice used to
  // decide whether the close boundary turn is an extra peak.
  if (
    firstIsBoundaryTurn &&
    remainingSpacings.at(-1) >= median * 1.8
  ) {
    remainingSpacings.pop();
  } else if (
    lastIsBoundaryTurn &&
    remainingSpacings[0] >= median * 1.8
  ) {
    remainingSpacings.shift();
  }
  const average =
    remainingSpacings.reduce((sum, value) => sum + value, 0) /
    Math.max(1, remainingSpacings.length);
  const variance =
    remainingSpacings.reduce(
      (sum, value) => sum + (value - average) ** 2,
      0,
    ) / Math.max(1, remainingSpacings.length);
  if (Math.sqrt(variance) / Math.max(1, average) > 0.36) {
    return null;
  }
  return firstIsBoundaryTurn
    ? observed[0].index
    : observed.at(-1).index;
}

/**
 * A crop or antialiased outer tail can turn once before it reaches the first
 * or last physical State. Treat that turn as an artifact only when all of the
 * following independent signals agree:
 *
 * - no lower-prominence supplemental maxima make the topology ambiguous;
 * - the suspect maximum lies in the outermost 8% of the profile, or within
 *   10% when the post-removal lattice is especially regular (CV <= 0.08);
 * - the outer interval is at most 55% of the robust State pitch;
 * - the intervening valley loses at most 20% of the lower peak height;
 * - removing that outer maximum leaves a regular lattice (CV <= 0.22);
 * - the remaining lattice still spans at least 55% of the profile.
 *
 * The shallow-valley requirement is important: two close physical States with
 * a material valley must remain separate.
 *
 * @param {number[]} profile
 * @param {{index: number; prominence: number}[]} observed
 * @param {number} profileLength
 * @returns {number | null}
 */
function shallowOuterTailArtifactIndex(
  profile,
  observed,
  profileLength,
) {
  if (
    observed.length < 4 ||
    observed.length > MAX_AUTOMATIC_REGULARIZED_STATE_COUNT
  ) {
    return null;
  }
  const spacings = observed
    .slice(1)
    .map((peak, index) => peak.index - observed[index].index);
  const orderedSpacings = [...spacings].sort(
    (left, right) => left - right,
  );
  const median =
    orderedSpacings[Math.floor(orderedSpacings.length / 2)] ?? 0;
  if (median <= 0) return null;

  const hypotheses = [
    {
      artifact: observed[0],
      neighbor: observed[1],
      spacing: spacings[0],
      remaining: observed.slice(1),
      touchesBoundary:
        observed[0].index <= profileLength * 0.1,
      requiresTightLattice:
        observed[0].index > profileLength * 0.08,
    },
    {
      artifact: observed.at(-1),
      neighbor: observed.at(-2),
      spacing: spacings.at(-1),
      remaining: observed.slice(0, -1),
      touchesBoundary:
        observed.at(-1).index >= profileLength * 0.9,
      requiresTightLattice:
        observed.at(-1).index < profileLength * 0.92,
    },
  ];
  const accepted = [];
  for (const hypothesis of hypotheses) {
    if (
      !hypothesis.touchesBoundary ||
      hypothesis.spacing > median * 0.55
    ) {
      continue;
    }
    const left = Math.min(
      hypothesis.artifact.index,
      hypothesis.neighbor.index,
    );
    const right = Math.max(
      hypothesis.artifact.index,
      hypothesis.neighbor.index,
    );
    const valley = Math.min(...profile.slice(left + 1, right));
    const lowerPeak = Math.min(
      profile[hypothesis.artifact.index],
      profile[hypothesis.neighbor.index],
    );
    const valleyDepth = clamp(
      (lowerPeak - valley) / Math.max(0.05, lowerPeak),
    );
    if (valleyDepth > 0.2) continue;

    const remainingSpacings = hypothesis.remaining
      .slice(1)
      .map(
        (peak, index) =>
          peak.index - hypothesis.remaining[index].index,
      );
    const average =
      remainingSpacings.reduce((sum, value) => sum + value, 0) /
      Math.max(1, remainingSpacings.length);
    const variance =
      remainingSpacings.reduce(
        (sum, value) => sum + (value - average) ** 2,
        0,
      ) / Math.max(1, remainingSpacings.length);
    const spacingCv =
      Math.sqrt(variance) / Math.max(1, average);
    const remainingSpan =
      (hypothesis.remaining.at(-1).index -
        hypothesis.remaining[0].index) /
      Math.max(1, profileLength - 1);
    const maximumSpacingCv = hypothesis.requiresTightLattice
      ? 0.08
      : 0.22;
    if (
      spacingCv > maximumSpacingCv ||
      remainingSpan < 0.55
    ) {
      continue;
    }
    accepted.push({
      index: hypothesis.artifact.index,
      spacingRatio: hypothesis.spacing / median,
      valleyDepth,
      spacingCv,
    });
  }
  if (!accepted.length) return null;
  accepted.sort(
    (left, right) =>
      left.valleyDepth - right.valleyDepth ||
      left.spacingCv - right.spacingCv ||
      left.spacingRatio - right.spacingRatio,
  );
  return accepted[0].index;
}

/**
 * Recover a faint but still visible maximum only when a domain regularization
 * rule has already established a larger physical topology. This is deliberately
 * separate from `detectPeaks`: supplemental maxima must not increase an
 * otherwise exact arbitrary State count.
 *
 * @param {number[]} profile
 * @param {{index: number; prominence: number}[]} candidates
 * @param {number} targetCount
 * @param {{ allowSaturatedPlateauExpansion?: boolean }} [options]
 */
function materializeRegularizedPeaks(
  profile,
  candidates,
  targetCount,
  options = {},
) {
  if (candidates.length >= targetCount) return [...candidates];
  const minimumDistance = Math.max(5, Math.floor(profile.length / 28));
  const window = Math.max(8, Math.floor(profile.length / 18));
  const supplemental = [];
  for (let index = 2; index < profile.length - 2; index += 1) {
    if (
      profile[index] < 0.06 ||
      profile[index] < profile[index - 1] ||
      profile[index] <= profile[index + 1] ||
      candidates.some(
        (candidate) =>
          Math.abs(candidate.index - index) < minimumDistance,
      )
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
    const prominence =
      profile[index] - Math.max(leftFloor, rightFloor);
    if (prominence >= 0.002) {
      supplemental.push({ index, prominence });
    }
  }

  const materialized = [...candidates];
  for (const peak of supplemental.sort(
    (left, right) => right.prominence - left.prominence,
  )) {
    if (
      materialized.every(
        (candidate) =>
          Math.abs(candidate.index - peak.index) >= minimumDistance,
      )
    ) {
      materialized.push(peak);
      if (materialized.length >= targetCount) break;
    }
  }
  materialized.sort((left, right) => left.index - right.index);

  // A rasterized high-density 16-State plot can clip several adjacent maxima
  // to one flat 1.0 plateau. Every inserted sample here is therefore still a
  // pixel-observed, non-strict local maximum; this never extrapolates into a
  // sloped tail or an empty outer margin.
  if (
    options.allowSaturatedPlateauExpansion &&
    targetCount === 16 &&
    materialized.length < targetCount
  ) {
    const plateauCandidates = [];
    for (let index = 2; index < profile.length - 2; index += 1) {
      if (
        profile[index] >= 0.995 &&
        Math.abs(profile[index] - profile[index - 1]) <= 1e-9 &&
        Math.abs(profile[index] - profile[index + 1]) <= 1e-9
      ) {
        plateauCandidates.push(index);
      }
    }
    while (
      plateauCandidates.length &&
      materialized.length < targetCount
    ) {
      let bestPosition = -1;
      let bestDistance = -1;
      for (
        let position = 0;
        position < plateauCandidates.length;
        position += 1
      ) {
        const index = plateauCandidates[position];
        const distance = Math.min(
          ...materialized.map((peak) =>
            Math.abs(peak.index - index),
          ),
        );
        if (distance >= 2 && distance > bestDistance) {
          bestPosition = position;
          bestDistance = distance;
        }
      }
      if (bestPosition < 0) break;
      const [index] = plateauCandidates.splice(bestPosition, 1);
      materialized.push({ index, prominence: 0.002 });
      materialized.sort((left, right) => left.index - right.index);
    }
  }
  return materialized;
}

function descriptorFromResolvedPeaks(
  profile,
  peaks,
  observedCount = peaks.length,
) {
  const peakWidths = peaks.map(({ index }, peakNumber) => {
    const leftBoundary = peakNumber ? peaks[peakNumber - 1].index : 0;
    const rightBoundary =
      peakNumber + 1 < peaks.length
        ? peaks[peakNumber + 1].index
        : profile.length - 1;
    const leftFloor = Math.min(
      ...profile.slice(leftBoundary, index + 1),
    );
    const rightFloor = Math.min(
      ...profile.slice(index, rightBoundary + 1),
    );
    const localFloor =
      index === 0
        ? rightFloor
        : index === profile.length - 1
          ? leftFloor
          : Math.max(leftFloor, rightFloor);
    const halfHeight =
      localFloor + (profile[index] - localFloor) * 0.5;
    let left = index;
    let right = index;
    while (left > leftBoundary && profile[left] > halfHeight) {
      left -= 1;
    }
    while (right < rightBoundary && profile[right] > halfHeight) {
      right += 1;
    }
    return Math.max(1, right - left) / profile.length;
  });

  const valleyHeights = [];
  const valleyLocations = [];
  const valleyDepths = [];
  const valleyPositionRatios = [];
  const peakValleyDistances = [];
  for (let peakIndex = 0; peakIndex < peaks.length - 1; peakIndex += 1) {
    const leftPeak = peaks[peakIndex].index;
    const rightPeak = peaks[peakIndex + 1].index;
    let valley = leftPeak + 1;
    for (let index = leftPeak + 2; index < rightPeak; index += 1) {
      if (profile[index] < profile[valley]) valley = index;
    }
    const valleyHeight = profile[valley];
    valleyHeights.push(valleyHeight);
    const leftDistance = Math.max(1, valley - leftPeak);
    const rightDistance = Math.max(1, rightPeak - valley);
    const peakGap = Math.max(1, rightPeak - leftPeak);
    valleyLocations.push(
      valley / Math.max(1, profile.length - 1),
    );
    valleyDepths.push(
      Math.max(
        0,
        Math.min(profile[leftPeak], profile[rightPeak]) -
          valleyHeight,
      ),
    );
    valleyPositionRatios.push(leftDistance / peakGap);
    peakValleyDistances.push(
      leftDistance / Math.max(1, profile.length - 1),
      rightDistance / Math.max(1, profile.length - 1),
    );
  }

  const resolvedStateCount = peaks.length;
  const tailSlopes = peaks.length
    ? [
        (profile[peaks[0].index] - profile[0]) /
          Math.max(1, peaks[0].index),
        (profile[peaks[peaks.length - 1].index] -
          profile[profile.length - 1]) /
          Math.max(
            1,
            profile.length - 1 - peaks[peaks.length - 1].index,
          ),
      ].map((value) => Math.max(0, value))
    : [];

  return {
    stateCount: resolvedStateCount,
    observedStateCount: observedCount,
    regularized: observedCount !== resolvedStateCount,
    peakLocations: peaks.map(
      ({ index }) => index / (profile.length - 1),
    ),
    peakWidths,
    valleyHeights,
    valleyLocations,
    valleyDepths,
    valleyPositionRatios,
    peakValleyDistances,
    tailSlopes,
    area:
      profile.reduce((sum, value) => sum + value, 0) /
      profile.length,
  };
}

/**
 * Resolve independently measured peak x-coordinates against the actual Curve
 * profile. This helper is deliberately fail-closed: every hint must snap to a
 * distinct local maximum and every adjacent pair must contain a measured
 * interior valley. The input profile is never replaced or synthesized.
 *
 * @param {number[]} profileInput
 * @param {number[]} normalizedHints
 * @returns {{
 *   ok: true;
 *   descriptor: ReturnType<typeof descriptorFromProfile>;
 *   snappedLocations: number[];
 * } | {
 *   ok: false;
 *   reason: string;
 * }}
 */
export function tryDescriptorFromPeakHints(
  profileInput,
  normalizedHints,
) {
  if (
    !Array.isArray(profileInput) ||
    profileInput.length < 3 ||
    profileInput.some((value) => !Number.isFinite(value))
  ) {
    return { ok: false, reason: "profile_invalid" };
  }
  if (
    !Array.isArray(normalizedHints) ||
    !isValidStateCount(normalizedHints.length) ||
    normalizedHints.some(
      (value) =>
        !Number.isFinite(value) || value < 0 || value > 1,
    ) ||
    normalizedHints.some(
      (value, index) =>
        index > 0 && value <= normalizedHints[index - 1],
    )
  ) {
    return { ok: false, reason: "hint_order_invalid" };
  }

  const profile = movingAverage(resample(profileInput), 2);
  const plateauMaxima = [];
  for (let start = 1; start < profile.length - 1; start += 1) {
    let end = start;
    while (
      end + 1 < profile.length - 1 &&
      Math.abs(profile[end + 1] - profile[start]) <= 1e-6
    ) {
      end += 1;
    }
    const value = profile[start];
    const left = profile[start - 1];
    const right = profile[end + 1];
    if (
      value >= 0.04 &&
      value > left + 1e-6 &&
      value > right + 1e-6
    ) {
      plateauMaxima.push(Math.round((start + end) / 2));
    }
    start = end;
  }

  const targets = normalizedHints.map((location) =>
    Math.round(location * (profile.length - 1)),
  );
  const snapped = [];
  for (let position = 0; position < targets.length; position += 1) {
    const leftPitch =
      position > 0
        ? targets[position] - targets[position - 1]
        : Number.POSITIVE_INFINITY;
    const rightPitch =
      position + 1 < targets.length
        ? targets[position + 1] - targets[position]
        : Number.POSITIVE_INFINITY;
    const pitch = Math.min(leftPitch, rightPitch);
    const radius = Math.max(
      2,
      Math.min(
        Math.round(profile.length * 0.04),
        Number.isFinite(pitch)
          ? Math.round(pitch * 0.4)
          : Math.round(profile.length * 0.04),
      ),
    );
    const previous = snapped.at(-1) ?? -2;
    const candidates = plateauMaxima
      .filter(
        (index) =>
          index >= targets[position] - radius &&
          index <= targets[position] + radius &&
          index >= previous + 2,
      )
      .sort(
        (left, right) =>
          Math.abs(left - targets[position]) -
            Math.abs(right - targets[position]) ||
          profile[right] - profile[left],
      );
    if (!candidates.length) {
      return { ok: false, reason: "peak_snap_missing" };
    }
    snapped.push(candidates[0]);
  }

  for (let index = 0; index < snapped.length - 1; index += 1) {
    const left = snapped[index];
    const right = snapped[index + 1];
    if (right - left < 2) {
      return { ok: false, reason: "peak_snap_collision" };
    }
    const interior = profile.slice(left + 1, right);
    if (
      !interior.length ||
      Math.min(profile[left], profile[right]) -
        Math.min(...interior) <=
        1e-6
    ) {
      return { ok: false, reason: "valley_not_observed" };
    }
  }

  const descriptor = descriptorFromResolvedPeaks(
    profile,
    snapped.map((index) => ({ index, prominence: 1 })),
    snapped.length,
  );
  return {
    ok: true,
    descriptor,
    snappedLocations: descriptor.peakLocations,
  };
}

/**
 * @param {number[]} profileInput
 * @param {{ stateCountHint?: number }} [options]
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
export function descriptorFromProfile(profileInput, options = {}) {
  const profile = movingAverage(resample(profileInput), 2);
  const candidates = detectPeaks(profile);
  const locallyObservedCandidates = materializeRegularizedPeaks(
    profile,
    candidates,
    MAX_AUTOMATIC_REGULARIZED_STATE_COUNT,
  );
  const observed = candidates.filter((peak) => peak.prominence >= 0.05);
  const observedCount = observed.length || candidates.length;
  const shallowOuterArtifactIndex =
    candidates.length === observed.length
      ? shallowOuterTailArtifactIndex(
          profile,
          observed,
          profile.length,
        )
      : null;
  const boundaryArtifactIndex =
    shallowOuterArtifactIndex ??
    eightStateBoundaryArtifactIndex(observed, profile.length);
  const candidateSpacings = candidates
    .slice(1)
    .map((peak, index) => peak.index - candidates[index].index);
  const candidateValleyDepths = candidates
    .slice(0, -1)
    .map((peak, index) => {
      const rightPeak = candidates[index + 1];
      const valley = Math.min(
        ...profile.slice(peak.index + 1, rightPeak.index),
      );
      const lowerPeak = Math.min(
        profile[peak.index],
        profile[rightPeak.index],
      );
      return clamp(
        (lowerPeak - valley) / Math.max(0.05, lowerPeak),
      );
    });
  // A broad two-State curve clipped at both x-boundaries can contain one
  // low interior shoulder. Once the boundary maxima receive their measured
  // one-sided prominence, that shoulder can look like a third State. Resolve
  // only this exact three-candidate ambiguity from the two measured valleys:
  // a genuine low State must descend materially on both sides, in absolute
  // and relative terms. No peak is synthesized or moved.
  let materialBoundaryTriplet = false;
  let boundaryShoulderTriplet = false;
  if (
    candidates.length === 3 &&
    candidates[0].index <= profile.length * 0.08 &&
    candidates[2].index >= (profile.length - 1) * 0.92 &&
    candidates[0].edgeRescued === true &&
    candidates[2].edgeRescued === true &&
    Number(candidates[0].edgeProminence) >= 0.05 &&
    Number(candidates[2].edgeProminence) >= 0.05 &&
    profile[candidates[0].index] >= 0.72 &&
    profile[candidates[2].index] >= 0.72
  ) {
    const middle = candidates[1];
    let leftValleyIndex = candidates[0].index + 1;
    for (
      let index = leftValleyIndex + 1;
      index < middle.index;
      index += 1
    ) {
      if (profile[index] < profile[leftValleyIndex]) {
        leftValleyIndex = index;
      }
    }
    let rightValleyIndex = middle.index + 1;
    for (
      let index = rightValleyIndex + 1;
      index < candidates[2].index;
      index += 1
    ) {
      if (profile[index] < profile[rightValleyIndex]) {
        rightValleyIndex = index;
      }
    }
    const middleHeight = profile[middle.index];
    const leftDrop =
      middleHeight - profile[leftValleyIndex];
    const rightDrop =
      middleHeight - profile[rightValleyIndex];
    materialBoundaryTriplet =
      leftDrop >= 0.08 &&
      rightDrop >= 0.08 &&
      leftDrop / Math.max(0.05, middleHeight) >= 0.35 &&
      rightDrop / Math.max(0.05, middleHeight) >= 0.35 &&
      middle.index - leftValleyIndex >= 2 &&
      rightValleyIndex - middle.index >= 2;
    boundaryShoulderTriplet =
      middleHeight <= 0.25 && !materialBoundaryTriplet;
  }
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
  const edgeSplitFourStateLayout =
    candidates.length === 6 &&
    candidates[5].index - candidates[0].index >=
      profile.length * 0.75 &&
    spacingMedian > 0 &&
    ((candidateSpacings[0] <= spacingMedian * 0.6 &&
      candidateValleyDepths[0] <= 0.2) ||
      (candidateSpacings.at(-1) <= spacingMedian * 0.6 &&
        candidateValleyDepths.at(-1) <= 0.2)) &&
    orderedSpacings[2] >= profile.length * 0.105 &&
    orderedSpacings[3] <= profile.length * 0.12;
  const boundaryClippedFourStateLayout =
    observedCount === 4 &&
    candidates.length === 9 &&
    spacingMedian > 0 &&
    candidateSpacings[0] <= spacingMedian * 0.65 &&
    candidateSpacings.at(-1) >= spacingMedian * 2;
  const denseEightStateLayout =
    observedCount >= 4 &&
    observedCount <= 7 &&
    candidates.length >= 8 &&
    candidates.length <= 10 &&
    candidates[candidates.length - 1].index - candidates[0].index >=
      profile.length * 0.62 &&
    spacingMedian > 0 &&
    Math.max(...candidateSpacings) <= spacingMedian * 1.8 &&
    Math.min(...candidateSpacings) >= spacingMedian * 0.3;
  const trimmedEightSpacings = candidateSpacings.filter(
    (spacing, index) =>
      !(
        (index === 0 && spacing <= spacingMedian * 0.65) ||
        (index === candidateSpacings.length - 1 &&
          spacing >= spacingMedian * 1.8)
      ),
  );
  const trimmedDenseEightStateLayout =
    observedCount >= 4 &&
    observedCount <= 7 &&
    candidates.length >= 8 &&
    candidates.length <= 10 &&
    candidates[candidates.length - 1].index - candidates[0].index >=
      profile.length * 0.62 &&
    trimmedEightSpacings.length >= 5 &&
    Math.max(...trimmedEightSpacings) <= spacingMedian * 1.8 &&
    Math.min(...trimmedEightSpacings) >= spacingMedian * 0.3;
  const partialEightStateLayout =
    observedCount === 7 &&
    candidates.length > 7;
  const denseSixteenStateLayout =
    candidates.length >= 12 &&
    candidates.length < 16 &&
    candidateSpacings.length >= 11 &&
    spacingMedian > 0 &&
    candidates[candidates.length - 1].index - candidates[0].index >=
      profile.length * 0.86 &&
    candidateSpacings.reduce(
      (count, spacing) =>
        count +
        Math.max(0, Math.round(spacing / spacingMedian) - 1),
      candidates.length,
    ) >= 16 &&
    candidateSpacings.filter(
      (spacing) =>
        spacing >= spacingMedian * 0.55 &&
        spacing <= spacingMedian * 1.65,
    ).length >=
      candidateSpacings.length - 2;
  let stateCount;
  if (boundaryShoulderTriplet) {
    stateCount = 2;
  } else if (materialBoundaryTriplet) {
    stateCount = 3;
  } else if (shallowOuterArtifactIndex !== null) {
    stateCount = Math.max(
      MIN_STATE_COUNT,
      observedCount - 1,
    );
  } else if (
    structuredFourStateLayout ||
    clusteredFourStateLayout ||
    edgeSplitFourStateLayout ||
    boundaryClippedFourStateLayout
  ) {
    stateCount = 4;
  } else if (
    denseEightStateLayout ||
    trimmedDenseEightStateLayout
  ) {
    stateCount = 8;
  } else if (partialEightStateLayout) {
    stateCount = 8;
  } else if (denseSixteenStateLayout) {
    stateCount = 16;
  } else if (
    observedCount === 3 &&
    candidates.length >= 4 &&
    candidates.length <= 9
  ) {
    stateCount = 4;
  } else if (candidates.length === 2 && observedCount === 1) {
    stateCount = 2;
  } else if (boundaryArtifactIndex !== null) {
    stateCount = 8;
  } else {
    stateCount = observedCount;
  }
  if (observedCount === 7 && candidates.length === 15) {
    stateCount = 8;
  } else if (
    stateCount < MAX_AUTOMATIC_REGULARIZED_STATE_COUNT &&
    candidates.length >= MAX_AUTOMATIC_REGULARIZED_STATE_COUNT
  ) {
    stateCount = MAX_AUTOMATIC_REGULARIZED_STATE_COUNT;
  } else if (stateCount > MAX_STATE_COUNT) {
    stateCount = MAX_STATE_COUNT;
  }
  const hintedStateCount = Number(options.stateCountHint);
  if (
    isValidStateCount(hintedStateCount) &&
    hintedStateCount > stateCount &&
    hintedStateCount - stateCount <= 3 &&
    candidates.length >= hintedStateCount - 2
  ) {
    stateCount = hintedStateCount;
  }
  const shallowBoundarySplitCount =
    Number(
      candidateSpacings[0] <= spacingMedian * 0.65 &&
        candidateValleyDepths[0] <= 0.02,
    ) +
    Number(
      candidateSpacings.at(-1) <= spacingMedian * 0.65 &&
        candidateValleyDepths.at(-1) <= 0.02,
    );
  const hintedEightStateLayout =
    hintedStateCount === 8 &&
    stateCount === 8 &&
    candidates.length >= 6 &&
    candidates.length <= 10 &&
    candidates.at(-1).index - candidates[0].index >=
      profile.length * 0.62 &&
    spacingMedian > 0 &&
    trimmedEightSpacings.length >= candidates.length - 2 &&
    Math.max(...trimmedEightSpacings) <= spacingMedian * 2 &&
    Math.min(...trimmedEightSpacings) >= spacingMedian * 0.28;
  const resolvedObservedCount = hintedEightStateLayout
    ? Math.max(
        observedCount,
        Math.min(
          stateCount,
          candidates.length -
            (candidates.length >= stateCount
              ? shallowBoundarySplitCount
              : 0),
        ),
      )
    : observedCount;

  const materializedCandidates = materializeRegularizedPeaks(
    profile,
    locallyObservedCandidates,
    stateCount,
    {
      allowSaturatedPlateauExpansion:
        denseSixteenStateLayout,
    },
  );
  const topologyCandidates =
    boundaryArtifactIndex === null
      ? materializedCandidates
      : materializedCandidates.filter(
          (candidate) =>
            candidate.index !== boundaryArtifactIndex,
        );
  const selectedPeakCount = Math.min(
    isValidStateCount(stateCount)
      ? stateCount
      : topologyCandidates.length,
    topologyCandidates.length,
  );
  const peaks =
    boundaryShoulderTriplet
      ? [candidates[0], candidates[2]]
      : denseEightStateLayout || trimmedDenseEightStateLayout
      ? selectStructuredPeaks(
          topologyCandidates,
          selectedPeakCount,
          profile.length,
        )
      : [...topologyCandidates]
          .sort(
            (left, right) =>
              right.prominence - left.prominence,
          )
          .slice(0, selectedPeakCount)
          .sort((left, right) => left.index - right.index);

  // `stateCount` is the physical topology contract: every returned descriptor
  // has exactly one location/width per State and exactly one valley between
  // adjacent States. A regularization hypothesis may never claim more States
  // than the peaks it can actually materialize.
  return descriptorFromResolvedPeaks(
    profile,
    peaks,
    boundaryShoulderTriplet
      ? 2
      : materialBoundaryTriplet
        ? 3
        : resolvedObservedCount,
  );
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
      .filter((stateCount) => isValidStateCount(stateCount)),
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
      const candidateDescriptor = descriptorFromProfile(
        candidate.profile,
      );
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
            candidateDescriptor.tailSlopes,
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
        peakValleyRelations(candidateDescriptor),
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
