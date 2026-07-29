import {
  buildAggressiveEdgeCurveMask,
  buildCurveMask,
  cropCurveMaskToContent,
  deskewForegroundMasks,
  detectPlotBounds,
  rotateBinaryMask,
} from "./vth-image-core.mjs";
import {
  alignedCurveSimilarity,
  canonicalProfileFromCurveMask,
  clamp,
  descriptorFromProfile,
  movingAverage,
  resample,
} from "./vth-shape-core.mjs";

const VALID_STATE_COUNTS = new Set([2, 4, 8, 16]);
const MAX_DISTRIBUTIONS_PER_IMAGE = 6;

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function coefficientOfVariation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  if (average <= 1e-9) return 0;
  const variance = mean(
    values.map((value) => (value - average) ** 2),
  );
  return Math.sqrt(variance) / average;
}

function interpolateTrack(values) {
  const output = [...values];
  const valid = output
    .map((value, index) => (Number.isFinite(value) ? index : -1))
    .filter((index) => index >= 0);
  if (!valid.length) return output.map(() => 0);
  for (let index = 0; index < output.length; index += 1) {
    if (Number.isFinite(output[index])) continue;
    let left = index - 1;
    let right = index + 1;
    while (left >= 0 && !Number.isFinite(output[left])) left -= 1;
    while (right < output.length && !Number.isFinite(output[right])) {
      right += 1;
    }
    if (left >= 0 && right < output.length) {
      const fraction = (index - left) / (right - left);
      output[index] =
        output[left] * (1 - fraction) + output[right] * fraction;
    } else if (left >= 0) {
      output[index] = output[left];
    } else {
      output[index] = output[right];
    }
  }
  return output;
}

function profileSymmetryDeviation(profile, peakLocations) {
  if (!peakLocations.length) return 0;
  const peakIndices = peakLocations.map((location) =>
    Math.round(location * (profile.length - 1)),
  );
  const deviations = peakIndices.map((peak, peakIndex) => {
    const leftLimit = peakIndex
      ? Math.floor((peakIndices[peakIndex - 1] + peak) / 2)
      : 0;
    const rightLimit =
      peakIndex + 1 < peakIndices.length
        ? Math.ceil((peak + peakIndices[peakIndex + 1]) / 2)
        : profile.length - 1;
    const radius = Math.min(peak - leftLimit, rightLimit - peak);
    if (radius < 2) return 0;
    let difference = 0;
    let samples = 0;
    for (let offset = 1; offset <= radius; offset += 1) {
      difference += Math.abs(
        profile[peak - offset] - profile[peak + offset],
      );
      samples += 1;
    }
    return samples ? difference / samples : 0;
  });
  return mean(deviations);
}

/**
 * Score how far a Curve is from a regular, symmetric multi-State
 * distribution. The score deliberately combines State-count regularization,
 * uneven peak placement/width, asymmetric valleys/tails and local roughness.
 * It is used only to choose one representative when multiple full
 * distributions are robustly detected in the same plot.
 *
 * @param {number[]} profile
 * @param {ReturnType<typeof descriptorFromProfile>} [descriptor]
 */
export function distributionIrregularityScore(
  profile,
  descriptor = descriptorFromProfile(profile),
) {
  const peakSpacings = descriptor.peakLocations
    .slice(1)
    .map(
      (location, index) =>
        location - descriptor.peakLocations[index],
    );
  const stateMismatch = descriptor.regularized
    ? clamp(
        0.25 +
          Math.abs(
            descriptor.observedStateCount - descriptor.stateCount,
          ) /
            Math.max(
              1,
              descriptor.observedStateCount,
              descriptor.stateCount,
            ),
      )
    : 0;
  const spacingIrregularity = clamp(
    coefficientOfVariation(peakSpacings) / 0.55,
  );
  const widthIrregularity = clamp(
    coefficientOfVariation(descriptor.peakWidths) / 0.75,
  );
  const valleyAsymmetry = clamp(
    mean(
      descriptor.valleyPositionRatios.map(
        (ratio) => Math.abs(ratio - 0.5) * 2,
      ),
    ) / 0.75,
  );
  const slopeImbalance = clamp(
    mean(
      Array.from(
        { length: Math.floor(descriptor.tailSlopes.length / 2) },
        (_, index) => {
          const left = descriptor.tailSlopes[index * 2] ?? 0;
          const right = descriptor.tailSlopes[index * 2 + 1] ?? 0;
          return Math.abs(left - right) / Math.max(1e-6, left + right);
        },
      ),
    ),
  );
  const overlap = clamp(mean(descriptor.valleyHeights));
  const symmetry = clamp(
    profileSymmetryDeviation(profile, descriptor.peakLocations) / 0.35,
  );
  const baseline = movingAverage(profile, 6);
  const roughness = clamp(
    mean(
      profile.map((value, index) =>
        Math.abs(value - baseline[index]),
      ),
    ) / 0.08,
  );
  const invalidStatePenalty = VALID_STATE_COUNTS.has(
    descriptor.stateCount,
  )
    ? 0
    : 1;
  return clamp(
    0.3 * Math.max(stateMismatch, invalidStatePenalty) +
      0.17 * spacingIrregularity +
      0.13 * widthIrregularity +
      0.13 * valleyAsymmetry +
      0.11 * symmetry +
      0.07 * slopeImbalance +
      0.05 * overlap +
      0.04 * roughness,
  );
}

function columnInkCenters(mask, width, height, x) {
  const centers = [];
  let start = -1;
  for (let y = 0; y <= height; y += 1) {
    const active = y < height && mask[y * width + x];
    if (active && start < 0) {
      start = y;
      continue;
    }
    if (active || start < 0) continue;
    const end = y - 1;
    const runHeight = end - start + 1;
    // The upper edge is the stable y=f(x) representative for steep VTH
    // tails. A median would drift down a nearly vertical tail.
    centers.push(start + Math.min(runHeight - 1, runHeight * 0.1));
    start = -1;
  }
  return centers;
}

function canonicalTrackProfile(track, height) {
  const filled = interpolateTrack(track);
  const vertical = filled.map(
    (value) => 1 - value / Math.max(1, height - 1),
  );
  const minimum = Math.min(...vertical);
  const maximum = Math.max(...vertical);
  if (maximum - minimum < 0.035) return null;
  return movingAverage(
    resample(
      vertical.map(
        (value) => (value - minimum) / (maximum - minimum),
      ),
    ),
    3,
  ).map((value) => clamp(value));
}

function predictiveTrackY(track, x) {
  if (!Number.isFinite(track.lastY)) return Number.NaN;
  if (
    !Number.isFinite(track.previousY) ||
    track.lastX === track.previousX
  ) {
    return track.lastY;
  }
  const slope =
    (track.lastY - track.previousY) /
    (track.lastX - track.previousX);
  return track.lastY + slope * Math.min(4, x - track.lastX);
}

function observeTrack(track, x, y) {
  track.values[x] = y;
  track.previousX = track.lastX;
  track.previousY = track.lastY;
  track.lastX = x;
  track.lastY = y;
  track.observedColumns += 1;
}

function trackColumnCenters(centersByColumn, width, height, trackCount) {
  const tracks = Array.from({ length: trackCount }, () => ({
    values: Array(width).fill(Number.NaN),
    previousX: Number.NaN,
    previousY: Number.NaN,
    lastX: Number.NaN,
    lastY: Number.NaN,
    observedColumns: 0,
  }));
  const firstMultiColumn = centersByColumn.findIndex(
    (centers) => centers.length >= trackCount,
  );
  if (firstMultiColumn < 0) return tracks;

  const firstCenters = centersByColumn[firstMultiColumn];
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const fraction =
      trackCount === 1 ? 0 : trackIndex / (trackCount - 1);
    observeTrack(
      tracks[trackIndex],
      firstMultiColumn,
      firstCenters[
        Math.round(fraction * (firstCenters.length - 1))
      ],
    );
  }

  const maximumJump = Math.max(8, height * 0.16);
  for (let x = firstMultiColumn + 1; x < width; x += 1) {
    const centers = centersByColumn[x];
    if (!centers.length) continue;
    const predictions = tracks.map((track) => predictiveTrackY(track, x));

    if (centers.length === 1) {
      // At a real Curve crossing several traces temporarily become one ink
      // run. Let every nearby predicted track pass through the same point;
      // their pre-crossing slopes preserve identity on the next columns.
      predictions.forEach((prediction, trackIndex) => {
        if (
          Number.isFinite(prediction) &&
          Math.abs(prediction - centers[0]) <= maximumJump * 0.45
        ) {
          observeTrack(tracks[trackIndex], x, centers[0]);
        }
      });
      continue;
    }

    const proposals = [];
    predictions.forEach((prediction, trackIndex) => {
      if (!Number.isFinite(prediction)) return;
      centers.forEach((center, centerIndex) => {
        proposals.push({
          trackIndex,
          centerIndex,
          distance: Math.abs(prediction - center),
        });
      });
    });
    proposals.sort(
      (left, right) =>
        left.distance - right.distance ||
        left.trackIndex - right.trackIndex ||
        left.centerIndex - right.centerIndex,
    );
    const assignedTracks = new Set();
    const assignedCenters = new Set();
    for (const proposal of proposals) {
      if (proposal.distance > maximumJump) break;
      if (
        assignedTracks.has(proposal.trackIndex) ||
        assignedCenters.has(proposal.centerIndex)
      ) {
        continue;
      }
      observeTrack(
        tracks[proposal.trackIndex],
        x,
        centers[proposal.centerIndex],
      );
      assignedTracks.add(proposal.trackIndex);
      assignedCenters.add(proposal.centerIndex);
    }
  }
  return tracks;
}

/**
 * Separate full-plot Curve tracks with continuity-aware assignment. Multiple
 * distributions are accepted only when at least two independent traces coexist
 * over a meaningful x span; disconnected State peaks from one distribution
 * therefore stay a single Curve. Prediction through crossings avoids silently
 * splicing the upper half of one distribution to the lower half of another.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 */
export function extractCurveDistributionCandidates(mask, width, height) {
  const centersByColumn = Array.from({ length: width }, (_, x) =>
    columnInkCenters(mask, width, height, x),
  );
  const multiColumnCounts = centersByColumn
    .map((centers) => centers.length)
    .filter(
      (count) =>
        count >= 2 && count <= MAX_DISTRIBUTIONS_PER_IMAGE + 2,
    )
    .sort((left, right) => left - right);
  const minimumMultiColumns = Math.max(18, Math.floor(width * 0.16));
  if (multiColumnCounts.length < minimumMultiColumns) {
    return {
      distributionCount: 1,
      selectedIndex: 0,
      candidates: [],
    };
  }

  const trackCount = Math.min(
    MAX_DISTRIBUTIONS_PER_IMAGE,
    Math.max(
      2,
      multiColumnCounts[
        Math.floor((multiColumnCounts.length - 1) * 0.55)
      ],
    ),
  );
  const tracks = trackColumnCenters(
    centersByColumn,
    width,
    height,
    trackCount,
  );
  const candidates = [];
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
    const track = tracks[trackIndex];
    const observedColumns = track.observedColumns;
    if (observedColumns < minimumMultiColumns) continue;
    const profile = canonicalTrackProfile(track.values, height);
    if (!profile) continue;
    const descriptor = descriptorFromProfile(profile);
    if (!VALID_STATE_COUNTS.has(descriptor.stateCount)) continue;
    if (
      candidates.some(
        (candidate) =>
          alignedCurveSimilarity(candidate.profile, profile) >= 0.995,
      )
    ) {
      continue;
    }
    candidates.push({
      profile,
      descriptor,
      irregularityScore: distributionIrregularityScore(
        profile,
        descriptor,
      ),
      observedColumnRatio: observedColumns / width,
      sourceIndex: trackIndex,
      separationMode: "geometry",
    });
  }
  if (candidates.length < 2) {
    return {
      distributionCount: 1,
      selectedIndex: 0,
      candidates: [],
    };
  }
  candidates.sort(
    (left, right) =>
      right.irregularityScore - left.irregularityScore ||
      right.observedColumnRatio - left.observedColumnRatio ||
      left.sourceIndex - right.sourceIndex,
  );
  return {
    distributionCount: candidates.length,
    selectedIndex: candidates[0].sourceIndex,
    selected: candidates[0],
    candidates,
  };
}

function normalizeProfileRange(profile) {
  const minimum = Math.min(...profile);
  const maximum = Math.max(...profile);
  if (maximum - minimum < 0.035) return null;
  return profile.map((value) =>
    clamp((value - minimum) / (maximum - minimum)),
  );
}

/**
 * Recover one black/gray full-width trace that is absent from hue masks.
 * Chromatic strokes and their antialiased edge pixels are removed first, then
 * the established Curve cleaner removes axes, grids and labels. The strict
 * width, density and State gates prevent neutral chart furniture or table text
 * from becoming a distribution series.
 */
export function extractAchromaticDistributionCandidate(
  curveSalientMask,
  colorMasks,
  width,
  height,
  bounds,
  chromaticExclusionRadius = 1,
) {
  if (
    !curveSalientMask ||
    !Array.isArray(colorMasks) ||
    !colorMasks.length
  ) {
    return null;
  }
  const chromaticExclusion = new Uint8Array(width * height);
  for (const colorMask of colorMasks) {
    if (colorMask.length !== chromaticExclusion.length) continue;
    for (let index = 0; index < colorMask.length; index += 1) {
      if (!colorMask[index]) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      for (
        let localY = Math.max(
          0,
          y - chromaticExclusionRadius,
        );
        localY <=
        Math.min(
          height - 1,
          y + chromaticExclusionRadius,
        );
        localY += 1
      ) {
        for (
          let localX = Math.max(
            0,
            x - chromaticExclusionRadius,
          );
          localX <=
          Math.min(
            width - 1,
            x + chromaticExclusionRadius,
          );
          localX += 1
        ) {
          chromaticExclusion[localY * width + localX] = 1;
        }
      }
    }
  }
  const residual = new Uint8Array(width * height);
  for (let index = 0; index < residual.length; index += 1) {
    if (
      curveSalientMask[index] &&
      !chromaticExclusion[index]
    ) {
      residual[index] = 1;
    }
  }
  const curve = buildCurveMask(
    residual,
    width,
    height,
    bounds,
  );
  const occupiedColumns = [];
  let activePixelCount = 0;
  for (let x = 0; x < curve.width; x += 1) {
    let occupied = false;
    for (let y = 0; y < curve.height; y += 1) {
      if (!curve.mask[y * curve.width + x]) continue;
      occupied = true;
      activePixelCount += 1;
    }
    if (occupied) occupiedColumns.push(x);
  }
  const occupiedColumnRatio =
    occupiedColumns.length / Math.max(1, curve.width);
  const horizontalSpanRatio = occupiedColumns.length
    ? (occupiedColumns.at(-1) - occupiedColumns[0] + 1) /
      Math.max(1, curve.width)
    : 0;
  const residualDensity =
    activePixelCount /
    Math.max(1, curve.width * curve.height);
  const meanPixelsPerOccupiedColumn =
    activePixelCount / Math.max(1, occupiedColumns.length);
  if (
    occupiedColumnRatio < 0.72 ||
    horizontalSpanRatio < 0.86 ||
    residualDensity > 0.08 ||
    meanPixelsPerOccupiedColumn >
      Math.max(12, curve.height * 0.12)
  ) {
    return null;
  }
  const canonical = canonicalProfileFromCurveMask(
    curve.mask,
    curve.width,
    curve.height,
  );
  const profile = normalizeProfileRange(canonical.profile);
  if (!profile) return null;
  const descriptor = descriptorFromProfile(profile);
  if (
    !VALID_STATE_COUNTS.has(descriptor.stateCount) ||
    descriptor.observedStateCount < 2
  ) {
    return null;
  }
  return {
    profile,
    descriptor,
    irregularityScore: distributionIrregularityScore(
      profile,
      descriptor,
    ),
    observedColumnRatio: occupiedColumnRatio,
    horizontalSpanRatio,
    sourceIndex: colorMasks.length,
    separationMode: "achromatic",
  };
}

/**
 * Build one style-independent Curve from all chromatic ink inside a plot.
 * PPT exports often color every State (or consecutive Curve segment)
 * differently. Looking at each hue independently then sees only a fraction of
 * the x range; their union recovers the complete peak/valley sequence while
 * still excluding neutral axes, labels and grid lines.
 */
function extractChromaticUnionCandidate(
  colorMasks,
  width,
  height,
  bounds,
) {
  if (!colorMasks.length) return null;
  const union = new Uint8Array(width * height);
  for (const colorMask of colorMasks) {
    for (let index = 0; index < union.length; index += 1) {
      if (colorMask[index]) union[index] = 1;
    }
  }
  const curve = buildCurveMask(union, width, height, bounds);
  const occupiedColumns = [];
  for (let x = 0; x < curve.width; x += 1) {
    for (let y = 0; y < curve.height; y += 1) {
      if (!curve.mask[y * curve.width + x]) continue;
      occupiedColumns.push(x);
      break;
    }
  }
  const occupiedColumnRatio =
    occupiedColumns.length / Math.max(1, curve.width);
  const horizontalSpanRatio = occupiedColumns.length
    ? (occupiedColumns.at(-1) - occupiedColumns[0] + 1) /
      Math.max(1, curve.width)
    : 0;
  if (
    occupiedColumnRatio < 0.62 ||
    horizontalSpanRatio < 0.78
  ) {
    return null;
  }
  const canonical = canonicalProfileFromCurveMask(
    curve.mask,
    curve.width,
    curve.height,
  );
  const profile = normalizeProfileRange(canonical.profile);
  if (!profile) return null;
  const descriptor = descriptorFromProfile(profile);
  if (!VALID_STATE_COUNTS.has(descriptor.stateCount)) return null;
  return {
    profile,
    descriptor,
    occupiedColumnRatio,
    horizontalSpanRatio,
    separationMode: "chromatic-union",
  };
}

/**
 * Recover overlapping distributions by temporary hue separation. Hue is
 * discarded immediately after trace extraction, so color and line styling do
 * not influence retrieval similarity. A color trace must occupy most of the
 * plot width, which prevents differently colored States of one distribution
 * from being mistaken for separate full distributions.
 */
export function extractColorDistributionCandidates(
  colorMasks,
  width,
  height,
  bounds,
) {
  const candidates = [];
  for (let sourceIndex = 0; sourceIndex < colorMasks.length; sourceIndex += 1) {
    const curve = buildCurveMask(
      colorMasks[sourceIndex],
      width,
      height,
      bounds,
    );
    const occupiedColumns = [];
    for (let x = 0; x < curve.width; x += 1) {
      for (let y = 0; y < curve.height; y += 1) {
        if (!curve.mask[y * curve.width + x]) continue;
        occupiedColumns.push(x);
        break;
      }
    }
    const occupiedColumnRatio =
      occupiedColumns.length / Math.max(1, curve.width);
    const horizontalSpanRatio = occupiedColumns.length
      ? (occupiedColumns.at(-1) - occupiedColumns[0] + 1) /
        Math.max(1, curve.width)
      : 0;
    if (
      occupiedColumnRatio < 0.62 ||
      horizontalSpanRatio < 0.78
    ) {
      continue;
    }
    const canonical = canonicalProfileFromCurveMask(
      curve.mask,
      curve.width,
      curve.height,
    );
    const profile = normalizeProfileRange(canonical.profile);
    if (!profile) continue;
    const descriptor = descriptorFromProfile(profile);
    if (
      !VALID_STATE_COUNTS.has(descriptor.stateCount) ||
      descriptor.observedStateCount < 2
    ) {
      continue;
    }
    if (
      candidates.some(
        (candidate) =>
          alignedCurveSimilarity(candidate.profile, profile) >= 0.995,
      )
    ) {
      continue;
    }
    candidates.push({
      profile,
      descriptor,
      irregularityScore: distributionIrregularityScore(
        profile,
        descriptor,
      ),
      observedColumnRatio: occupiedColumnRatio,
      sourceIndex,
      separationMode: "color",
    });
  }
  if (candidates.length < 2) {
    return {
      distributionCount: 1,
      selectedIndex: 0,
      candidates: [],
      detectedCandidates: candidates,
    };
  }
  candidates.sort(
    (left, right) =>
      right.irregularityScore - left.irregularityScore ||
      right.observedColumnRatio - left.observedColumnRatio ||
      left.sourceIndex - right.sourceIndex,
  );
  return {
    distributionCount: candidates.length,
    selectedIndex: candidates[0].sourceIndex,
    selected: candidates[0],
    candidates,
    detectedCandidates: candidates,
  };
}

/**
 * Let an aggressive edge hypothesis repair an invalid or needlessly
 * regularized count, but never let it replace one valid physical State count
 * with a different valid count. The latter created style-dependent 4↔8 flips
 * on measured plots.
 */
export function reconcileStateDescriptor(descriptor, aggressiveDescriptor) {
  if (!VALID_STATE_COUNTS.has(aggressiveDescriptor.stateCount)) {
    return descriptor;
  }
  const primaryValid = VALID_STATE_COUNTS.has(descriptor.stateCount);
  const sameStateCount =
    descriptor.stateCount === aggressiveDescriptor.stateCount;
  if (
    !primaryValid ||
    (sameStateCount &&
      descriptor.regularized &&
      !aggressiveDescriptor.regularized)
  ) {
    return {
      ...descriptor,
      stateCount: aggressiveDescriptor.stateCount,
      observedStateCount: aggressiveDescriptor.observedStateCount,
      regularized: aggressiveDescriptor.regularized,
    };
  }
  return descriptor;
}

export function shouldPreferSalientDescriptor(
  primaryDescriptor,
  salientDescriptor,
  artifactLineCount = 0,
  profileSimilarity = 1,
) {
  return (
    VALID_STATE_COUNTS.has(salientDescriptor.stateCount) &&
    primaryDescriptor.regularized === true &&
    (salientDescriptor.regularized === false ||
      (artifactLineCount >= 12 &&
        (primaryDescriptor.stateCount !== salientDescriptor.stateCount ||
          profileSimilarity < 0.9)))
  );
}

export function shouldPreferRetrievalSalientDescriptor(
  primaryDescriptor,
  retrievalDescriptor,
  artifactLineCount = 0,
  profileSimilarity = 0,
) {
  return (
    artifactLineCount >= 6 &&
    primaryDescriptor.regularized === false &&
    retrievalDescriptor.regularized === false &&
    VALID_STATE_COUNTS.has(retrievalDescriptor.stateCount) &&
    retrievalDescriptor.stateCount < primaryDescriptor.stateCount &&
    profileSimilarity >= 0.985
  );
}

/**
 * Extract the canonical Curve and alternate hypotheses from the shared broad
 * and salient foreground masks.
 *
 * @param {Uint8Array} broadMask
 * @param {Uint8Array} salientMask
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} [curveSalientMask]
 * @param {Uint8Array[]} [curveColorMasks]
 */
export function analyzeForegroundMasks(
  broadMask,
  salientMask,
  width,
  height,
  curveSalientMask = salientMask,
  curveColorMasks = [],
) {
  const deskewed = deskewForegroundMasks(
    broadMask,
    salientMask,
    width,
    height,
    curveSalientMask,
  );
  const analysisBroadMask = deskewed.broadMask;
  const analysisSalientMask = deskewed.salientMask;
  const analysisCurveColorMasks = deskewed.applied
    ? curveColorMasks.map((mask) =>
        rotateBinaryMask(
          mask,
          width,
          height,
          deskewed.angle,
        ),
      )
    : curveColorMasks;
  const bounds = detectPlotBounds(
    deskewed.boundsMask,
    width,
    height,
    {
      // A nearest-neighbor deskew can leave the outer vertical spine a little
      // more fragmented than a native frame. Relax only for corrected masks;
      // unrotated measured plots keep the stricter false-tail guard.
      minimumVerticalEdgeCoverage: deskewed.applied ? 0.4 : 0.44,
      cornerRadius: deskewed.applied
        ? Math.max(3, Math.round(Math.min(width, height) * 0.012))
        : 3,
    },
  );
  const primaryMask = buildCurveMask(
    analysisBroadMask,
    width,
    height,
    bounds,
  );
  const plotCanonical = canonicalProfileFromCurveMask(
    primaryMask.mask,
    primaryMask.width,
    primaryMask.height,
  );
  const plotDescriptor = descriptorFromProfile(plotCanonical.profile);
  const useContentCoordinates =
    bounds.axisMode === "rectangle" &&
    plotDescriptor.stateCount > 0 &&
    plotDescriptor.stateCount <= 4;
  const selectedPrimaryMask = useContentCoordinates
    ? cropCurveMaskToContent(
        primaryMask.mask,
        primaryMask.width,
        primaryMask.height,
      )
    : primaryMask;
  const primaryCanonical = canonicalProfileFromCurveMask(
    selectedPrimaryMask.mask,
    selectedPrimaryMask.width,
    selectedPrimaryMask.height,
  );
  const primaryShapeDescriptor = descriptorFromProfile(
    primaryCanonical.profile,
  );
  const primaryDescriptor = useContentCoordinates
    ? {
        ...primaryShapeDescriptor,
        stateCount: plotDescriptor.stateCount,
        observedStateCount: plotDescriptor.observedStateCount,
        regularized: plotDescriptor.regularized,
      }
    : primaryShapeDescriptor;
  let descriptor = primaryDescriptor;
  let selectedProfile = primaryCanonical.profile;

  const aggressiveMask = buildAggressiveEdgeCurveMask(
    analysisBroadMask,
    width,
    height,
    bounds,
  );
  const aggressivePlotCanonical = canonicalProfileFromCurveMask(
    aggressiveMask.mask,
    aggressiveMask.width,
    aggressiveMask.height,
  );
  const aggressivePlotDescriptor = descriptorFromProfile(
    aggressivePlotCanonical.profile,
  );
  const aggressiveUseContentCoordinates =
    useContentCoordinates &&
    aggressivePlotDescriptor.stateCount > 0 &&
    aggressivePlotDescriptor.stateCount <= 4;
  const selectedAggressiveMask = aggressiveUseContentCoordinates
    ? cropCurveMaskToContent(
        aggressiveMask.mask,
        aggressiveMask.width,
        aggressiveMask.height,
      )
    : aggressiveMask;
  const aggressiveCanonical = canonicalProfileFromCurveMask(
    selectedAggressiveMask.mask,
    selectedAggressiveMask.width,
    selectedAggressiveMask.height,
  );
  const aggressiveDescriptor = descriptorFromProfile(
    aggressiveCanonical.profile,
  );

  const salientCurveMask = buildCurveMask(
    analysisSalientMask,
    width,
    height,
    bounds,
  );
  const salientPlotCanonical = canonicalProfileFromCurveMask(
    salientCurveMask.mask,
    salientCurveMask.width,
    salientCurveMask.height,
  );
  const salientPlotDescriptor = descriptorFromProfile(
    salientPlotCanonical.profile,
  );
  const salientUseContentCoordinates =
    useContentCoordinates &&
    salientPlotDescriptor.stateCount > 0 &&
    salientPlotDescriptor.stateCount <= 4;
  const selectedSalientMask = salientUseContentCoordinates
    ? cropCurveMaskToContent(
        salientCurveMask.mask,
        salientCurveMask.width,
        salientCurveMask.height,
      )
    : salientCurveMask;
  const salientCanonical = canonicalProfileFromCurveMask(
    selectedSalientMask.mask,
    selectedSalientMask.width,
    selectedSalientMask.height,
  );
  const salientDescriptor = descriptorFromProfile(salientCanonical.profile);
  const retrievalSalientCurveMask = buildCurveMask(
    deskewed.curveSalientMask,
    width,
    height,
    bounds,
  );
  const retrievalSalientPlotCanonical = canonicalProfileFromCurveMask(
    retrievalSalientCurveMask.mask,
    retrievalSalientCurveMask.width,
    retrievalSalientCurveMask.height,
  );
  const retrievalSalientPlotDescriptor = descriptorFromProfile(
    retrievalSalientPlotCanonical.profile,
  );
  const retrievalSalientUseContentCoordinates =
    useContentCoordinates &&
    retrievalSalientPlotDescriptor.stateCount > 0 &&
    retrievalSalientPlotDescriptor.stateCount <= 4;
  const selectedRetrievalSalientMask =
    retrievalSalientUseContentCoordinates
      ? cropCurveMaskToContent(
          retrievalSalientCurveMask.mask,
          retrievalSalientCurveMask.width,
          retrievalSalientCurveMask.height,
        )
      : retrievalSalientCurveMask;
  const retrievalSalientCanonical = canonicalProfileFromCurveMask(
    selectedRetrievalSalientMask.mask,
    selectedRetrievalSalientMask.width,
    selectedRetrievalSalientMask.height,
  );
  const retrievalSalientDescriptor = descriptorFromProfile(
    retrievalSalientCanonical.profile,
  );
  const artifactLineCount =
    primaryMask.removedStraightRows +
    primaryMask.removedStraightColumns;
  const primarySalientSimilarity = alignedCurveSimilarity(
    primaryCanonical.profile,
    salientCanonical.profile,
  );
  const primaryInk = primaryMask.mask.reduce(
    (sum, value) => sum + value,
    0,
  );
  const strictSalientInk = salientCurveMask.mask.reduce(
    (sum, value) => sum + value,
    0,
  );
  const retrievalSalientInk = retrievalSalientCurveMask.mask.reduce(
    (sum, value) => sum + value,
    0,
  );
  const strictSalientInkRatio =
    strictSalientInk / Math.max(1, primaryInk);
  const salientInkRatio =
    retrievalSalientInk / Math.max(1, primaryInk);
  const heavyArtifactEvidence =
    artifactLineCount >= 6 || salientInkRatio < 0.55;
  if (
    strictSalientInkRatio >= 0.25 &&
    shouldPreferSalientDescriptor(
      descriptor,
      salientDescriptor,
      artifactLineCount,
      primarySalientSimilarity,
    )
  ) {
    if (
      descriptor.stateCount === salientDescriptor.stateCount &&
      strictSalientInkRatio < 0.8
    ) {
      descriptor = {
        ...descriptor,
        observedStateCount: salientDescriptor.observedStateCount,
        regularized: salientDescriptor.regularized,
      };
    } else {
      selectedProfile = salientCanonical.profile;
      descriptor = salientDescriptor;
    }
  } else if (
    !VALID_STATE_COUNTS.has(descriptor.stateCount) &&
    VALID_STATE_COUNTS.has(salientDescriptor.stateCount)
  ) {
    selectedProfile = salientCanonical.profile;
    descriptor = salientDescriptor;
  }
  if (
    useContentCoordinates ||
    !VALID_STATE_COUNTS.has(descriptor.stateCount)
  ) {
    descriptor = reconcileStateDescriptor(descriptor, aggressiveDescriptor);
  }
  let displacedPrimary = null;
  const retrievalSimilarity = alignedCurveSimilarity(
    selectedProfile,
    retrievalSalientCanonical.profile,
  );
  if (
    heavyArtifactEvidence &&
    shouldPreferRetrievalSalientDescriptor(
      descriptor,
      retrievalSalientDescriptor,
      artifactLineCount,
      retrievalSimilarity,
    )
  ) {
    // When line artifacts split a physical peak into several tiny maxima, the
    // broad and high-salience profiles remain nearly identical but disagree
    // on State count. In that narrow case, trust the smaller salient count
    // and keep the broad trace as a retrieval fallback.
    displacedPrimary = {
      profile: selectedProfile,
      descriptor,
    };
    selectedProfile = retrievalSalientCanonical.profile;
    descriptor = retrievalSalientDescriptor;
  }
  const colorDistributionCandidates =
    extractColorDistributionCandidates(
      analysisCurveColorMasks,
      width,
      height,
      bounds,
    );
  const detectedColorCandidates =
    colorDistributionCandidates.detectedCandidates ?? [];
  const achromaticCandidates = [
    extractAchromaticDistributionCandidate(
      deskewed.rawSalientMask,
      analysisCurveColorMasks,
      width,
      height,
      bounds,
      deskewed.applied ? 2 : 1,
    ),
  ].filter(Boolean);
  const nearestHalfDegree =
    Math.round(deskewed.angle * 2) / 2;
  if (
    deskewed.applied &&
    Math.abs(deskewed.angle - nearestHalfDegree) >= 0.2
  ) {
    for (const angle of [
      deskewed.angle - 0.25,
      deskewed.angle + 0.25,
    ]) {
      const rotatedColorMasks = curveColorMasks.map((mask) =>
        rotateBinaryMask(mask, width, height, angle),
      );
      const candidate =
        extractAchromaticDistributionCandidate(
          rotateBinaryMask(
            salientMask,
            width,
            height,
            angle,
          ),
          rotatedColorMasks,
          width,
          height,
          bounds,
          2,
        );
      if (candidate) achromaticCandidates.push(candidate);
    }
  }
  const dominantColorStateCount =
    detectedColorCandidates.length
      ? detectedColorCandidates
          .map((candidate) => candidate.descriptor.stateCount)
          .sort(
            (left, right) =>
              detectedColorCandidates.filter(
                (candidate) =>
                  candidate.descriptor.stateCount === right,
              ).length -
                detectedColorCandidates.filter(
                  (candidate) =>
                    candidate.descriptor.stateCount === left,
                ).length ||
              left - right,
          )[0]
      : null;
  const achromaticCandidateQuality = (candidate) => {
    const maximumColorSimilarity = Math.max(
      0,
      ...detectedColorCandidates.map((colorCandidate) =>
        alignedCurveSimilarity(
          colorCandidate.profile,
          candidate.profile,
        ),
      ),
    );
    return (
      (dominantColorStateCount === null ||
      candidate.descriptor.stateCount === dominantColorStateCount
        ? 2
        : 0) +
      (1 - maximumColorSimilarity) +
      candidate.observedColumnRatio * 0.1
    );
  };
  const achromaticDistributionCandidate =
    achromaticCandidates.reduce(
      (best, candidate) =>
        !best ||
        achromaticCandidateQuality(candidate) >
          achromaticCandidateQuality(best)
          ? candidate
          : best,
      null,
    );
  const chromaticUnionCandidate =
    extractChromaticUnionCandidate(
      analysisCurveColorMasks,
      width,
      height,
      bounds,
    );
  const segmentedChromaticCandidate =
    !detectedColorCandidates.length &&
    chromaticUnionCandidate
      ? {
          ...chromaticUnionCandidate,
          irregularityScore:
            distributionIrregularityScore(
              chromaticUnionCandidate.profile,
              chromaticUnionCandidate.descriptor,
            ),
          observedColumnRatio:
            chromaticUnionCandidate.occupiedColumnRatio,
          sourceIndex: 0,
        }
      : null;
  const independentChromaticCandidates =
    detectedColorCandidates.length
      ? detectedColorCandidates
      : segmentedChromaticCandidate
        ? [segmentedChromaticCandidate]
        : [];
  const includeAchromaticCandidate =
    achromaticDistributionCandidate &&
    independentChromaticCandidates.length >= 1 &&
    !independentChromaticCandidates.some(
      (candidate) =>
        alignedCurveSimilarity(
          candidate.profile,
          achromaticDistributionCandidate.profile,
        ) >= 0.995,
    );
  const colorAndAchromaticCandidates =
    includeAchromaticCandidate
      ? [
          ...independentChromaticCandidates,
          achromaticDistributionCandidate,
        ]
      : independentChromaticCandidates;
  const mixedDistributionCandidates =
    includeAchromaticCandidate &&
    colorAndAchromaticCandidates.length >= 2
      ? (() => {
          const candidates = [
            ...colorAndAchromaticCandidates,
          ].sort(
            (left, right) =>
              right.irregularityScore -
                left.irregularityScore ||
              right.observedColumnRatio -
                left.observedColumnRatio ||
              left.sourceIndex - right.sourceIndex,
          );
          return {
            distributionCount: candidates.length,
            selectedIndex: candidates[0].sourceIndex,
            selected: candidates[0],
            candidates,
          };
        })()
      : colorDistributionCandidates;
  const geometricDistributionCandidates = heavyArtifactEvidence
    ? {
        // Residual grids can look like several vertically ordered traces.
        // Under strong line/noise evidence, require color-consistent full
        // traces instead of letting geometry alone create a false split.
        distributionCount: 1,
        selectedIndex: 0,
        candidates: [],
      }
    : extractCurveDistributionCandidates(
        primaryMask.mask,
        primaryMask.width,
        primaryMask.height,
      );
  const distributionCandidates =
    mixedDistributionCandidates.selected
      ? mixedDistributionCandidates
      : geometricDistributionCandidates;
  const selectedDistribution = distributionCandidates.selected;
  if (selectedDistribution) {
    // Search and training intentionally share this exact override. Other
    // distributions are not added as retrieval alternatives, otherwise a
    // candidate could silently match the more regular trace instead of the
    // requested most-irregular representative.
    selectedProfile = selectedDistribution.profile;
    descriptor = selectedDistribution.descriptor;
    displacedPrimary = null;
  } else if (chromaticUnionCandidate) {
    // Segmented State colors are styling, not multiple distributions. Their
    // neutral-grid-free union is a stronger source for shallow valleys on
    // small PPT panels than the broad grayscale foreground.
    selectedProfile = chromaticUnionCandidate.profile;
    descriptor = chromaticUnionCandidate.descriptor;
  }
  const alternatives = [];
  const addAlternative = (
    alternativeProfile,
    alternativeDescriptor,
    metadata = {},
  ) => {
    if (selectedDistribution) return;
    if (!VALID_STATE_COUNTS.has(alternativeDescriptor.stateCount)) return;
    if (
      alignedCurveSimilarity(alternativeProfile, selectedProfile) >= 0.999
    ) {
      return;
    }
    if (
      alternatives.some(
        (alternative) =>
          alignedCurveSimilarity(
            alternative.profile,
            alternativeProfile,
          ) >= 0.999,
      )
    ) {
      return;
    }
    alternatives.push({
      profile: alternativeProfile,
      descriptor: alternativeDescriptor,
      ...metadata,
    });
  };

  if (displacedPrimary) {
    addAlternative(
      displacedPrimary.profile,
      displacedPrimary.descriptor,
      { artifactRescue: false },
    );
  }
  if (heavyArtifactEvidence) {
    // A low salience-to-foreground ratio means pale grids, guides or noise
    // dominate the broad mask. Keep the high-contrast/color-only Curve as an
    // explicit retrieval hypothesis even when its State count differs.
    addAlternative(
      retrievalSalientCanonical.profile,
      retrievalSalientDescriptor,
      {
        artifactRescue:
          artifactLineCount >= 6 || deskewed.applied,
      },
    );
  }
  if (deskewed.applied && heavyArtifactEvidence) {
    // Binary-mask dilation repairs thin curves after deskew, but on a dense
    // dashed grid it can also thicken residual artifacts. Preserve the raw
    // deskewed mask only when artifact evidence is strong; clean rotated plots
    // stay on the stabilized primary hypothesis.
    const rawDeskewMask = buildCurveMask(
      deskewed.rawBroadMask,
      width,
      height,
      bounds,
    );
    const rawDeskewCanonical = canonicalProfileFromCurveMask(
      rawDeskewMask.mask,
      rawDeskewMask.width,
      rawDeskewMask.height,
    );
    addAlternative(
      rawDeskewCanonical.profile,
      descriptorFromProfile(rawDeskewCanonical.profile),
      { artifactRescue: true },
    );
  }
  if (
    aggressiveDescriptor.stateCount === descriptor.stateCount &&
    (useContentCoordinates ||
      !VALID_STATE_COUNTS.has(descriptor.stateCount))
  ) {
    addAlternative(
      aggressiveCanonical.profile,
      aggressiveDescriptor,
    );
  }

  // Keep every independently detected full-width distribution available to
  // downstream search and training. The legacy profile/descriptor pair above
  // remains the most-irregular representative, while series[] preserves a
  // stable source order so one colored chart can be expanded into independent
  // retrieval records without changing physical panel coordinates.
  const orderedDistributionCandidates = selectedDistribution
    ? [...distributionCandidates.candidates].sort(
        (left, right) => left.sourceIndex - right.sourceIndex,
      )
    : [];
  const selectedSeriesIndex = selectedDistribution
    ? orderedDistributionCandidates.findIndex(
        (candidate) => candidate === selectedDistribution,
      )
    : 0;
  const series = selectedDistribution
    ? orderedDistributionCandidates.map((candidate, seriesIndex) => ({
        seriesIndex,
        sourceIndex: candidate.sourceIndex,
        profile: candidate.profile,
        descriptor: candidate.descriptor,
        irregularityScore: candidate.irregularityScore,
        observedColumnRatio: candidate.observedColumnRatio,
        separationMode:
          candidate.separationMode ?? "geometry",
        selected: seriesIndex === selectedSeriesIndex,
      }))
    : [
        {
          seriesIndex: 0,
          sourceIndex: 0,
          profile: selectedProfile,
          descriptor,
          irregularityScore: distributionIrregularityScore(
            selectedProfile,
            descriptor,
          ),
          observedColumnRatio: 1,
          separationMode:
            chromaticUnionCandidate?.separationMode ?? "single",
          selected: true,
        },
      ];

  return {
    profile: selectedProfile,
    descriptor,
    alternatives,
    series,
    selectedSeriesIndex,
    distributionSelection: selectedDistribution
      ? {
          mode: "most-irregular",
          distributionCount:
            distributionCandidates.distributionCount,
          selectedIndex: distributionCandidates.selectedIndex,
          selectedSeriesIndex,
          irregularityScore:
            selectedDistribution.irregularityScore,
        }
      : {
          mode: "single",
          distributionCount: 1,
          selectedIndex: 0,
          selectedSeriesIndex: 0,
          irregularityScore: distributionIrregularityScore(
            selectedProfile,
            descriptor,
          ),
        },
    axesDetected: bounds.axesDetected,
    axisMode: bounds.axisMode,
    preprocessing: {
      sourceSize: [width, height],
      bounds,
      primaryMask,
      aggressiveMask,
      salientCurveMask,
      retrievalSalientCurveMask,
      primaryCanonical,
      useContentCoordinates,
      salientUseContentCoordinates,
      retrievalSalientUseContentCoordinates,
      aggressiveUseContentCoordinates,
      salientInkRatio,
      strictSalientInkRatio,
      heavyArtifactEvidence,
      deskewAngle: deskewed.angle,
      deskewApplied: deskewed.applied,
      deskewScore: deskewed.score,
      deskewImprovement: deskewed.improvement,
      distributionCandidateCount:
        distributionCandidates.distributionCount,
      distributionSeparationMode:
        selectedDistribution?.separationMode ??
        chromaticUnionCandidate?.separationMode ??
        "geometry",
    },
  };
}
