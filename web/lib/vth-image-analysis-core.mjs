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
  isValidStateCount,
  movingAverage,
  resample,
  tryDescriptorFromPeakHints,
} from "./vth-shape-core.mjs";

const MAX_DISTRIBUTIONS_PER_IMAGE = 6;
const MAX_INDEPENDENT_COLOR_SERIES = 2;

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

function repeatedArchMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort(
    (left, right) => left - right,
  );
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function repeatedArchLongestHorizontalRun(
  mask,
  width,
  row,
  maximumGap = 1,
) {
  let best = null;
  let start = -1;
  let last = -1;
  for (let x = 0; x < width; x += 1) {
    if (mask[row * width + x]) {
      if (start < 0) start = x;
      last = x;
    } else if (start >= 0 && x - last > maximumGap) {
      if (!best || last - start > best[1] - best[0]) {
        best = [start, last];
      }
      start = -1;
    }
  }
  if (
    start >= 0 &&
    (!best || last - start > best[1] - best[0])
  ) {
    best = [start, last];
  }
  return best;
}

function repeatedArchVerticalLineEvidence(
  mask,
  width,
  height,
  x,
  top,
  bottom,
) {
  let longestRun = 0;
  let run = 0;
  let count = 0;
  for (
    let y = Math.max(0, top);
    y <= Math.min(height - 1, bottom);
    y += 1
  ) {
    if (mask[y * width + x]) {
      run += 1;
      count += 1;
      longestRun = Math.max(longestRun, run);
    } else {
      run = 0;
    }
  }
  return { longestRun, count };
}

function recoverRepeatedArchFrame(
  broadMask,
  width,
  height,
  bounds,
) {
  let topLine = null;
  for (
    let y = Math.max(0, Math.round(bounds.top) - 7);
    y <= Math.min(height - 1, Math.round(bounds.top) + 2);
    y += 1
  ) {
    const run = repeatedArchLongestHorizontalRun(
      broadMask,
      width,
      y,
    );
    if (
      run &&
      run[1] - run[0] >= width * 0.55 &&
      (!topLine ||
        run[1] - run[0] >
          topLine.run[1] - topLine.run[0])
    ) {
      topLine = { y, run };
    }
  }
  if (!topLine) return null;

  let bottomLine = null;
  for (
    let y = Math.max(0, Math.round(bounds.bottom) - 3);
    y <= Math.min(height - 1, Math.round(bounds.bottom) + 7);
    y += 1
  ) {
    const run = repeatedArchLongestHorizontalRun(
      broadMask,
      width,
      y,
    );
    if (
      run &&
      run[1] - run[0] >= width * 0.55 &&
      (!bottomLine ||
        run[1] - run[0] >
          bottomLine.run[1] - bottomLine.run[0])
    ) {
      bottomLine = { y, run };
    }
  }

  const frameBottom = bottomLine?.y ?? Math.round(bounds.bottom);
  const chooseVerticalEdge = (
    rangeStart,
    rangeEnd,
    preferRight,
  ) => {
    let best = null;
    for (
      let x = Math.max(0, rangeStart);
      x <= Math.min(width - 1, rangeEnd);
      x += 1
    ) {
      const evidence = repeatedArchVerticalLineEvidence(
        broadMask,
        width,
        height,
        x,
        topLine.y,
        frameBottom,
      );
      const score =
        evidence.longestRun * 2 + evidence.count;
      if (
        !best ||
        score > best.score ||
        (score === best.score &&
          (preferRight ? x > best.x : x < best.x))
      ) {
        best = { x, score, ...evidence };
      }
    }
    return best;
  };
  const leftEdge = chooseVerticalEdge(
    topLine.run[0] - 2,
    topLine.run[0] + 14,
    false,
  );
  const rightEdge = chooseVerticalEdge(
    topLine.run[1] - 14,
    topLine.run[1] + 2,
    true,
  );
  if (
    !leftEdge ||
    !rightEdge ||
    rightEdge.x - leftEdge.x < width * 0.5
  ) {
    return null;
  }

  const frame = {
    left: leftEdge.x + 2,
    right: rightEdge.x - 2,
    top: topLine.y + 2,
    bottom: frameBottom - 2,
    topFrameRow: topLine.y,
    bottomFrameRow: bottomLine?.y ?? null,
    leftEdge: leftEdge.x,
    rightEdge: rightEdge.x,
  };
  return (
    frame.right - frame.left >= 24 &&
    frame.bottom - frame.top >= 20
  )
    ? frame
    : null;
}

function buildRepeatedArchWorkingMask(
  curveSalientMask,
  colorMasks,
  width,
  height,
  frame,
) {
  const frameWidth = frame.right - frame.left + 1;
  const frameHeight = frame.bottom - frame.top + 1;
  const mask = new Uint8Array(frameWidth * frameHeight);
  const rowCounts = new Uint32Array(frameHeight);
  const columnCounts = new Uint32Array(frameWidth);
  const outsideColorCounts = new Uint32Array(frameWidth);
  const colorUnion = new Uint8Array(width * height);
  for (const colorMask of colorMasks) {
    if (!colorMask || colorMask.length !== colorUnion.length) {
      continue;
    }
    for (let index = 0; index < colorMask.length; index += 1) {
      if (colorMask[index]) colorUnion[index] = 1;
    }
  }

  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const sourceIndex =
        (frame.top + y) * width + frame.left + x;
      if (!curveSalientMask[sourceIndex]) continue;
      mask[y * frameWidth + x] = 1;
      rowCounts[y] += 1;
      columnCounts[x] += 1;
      if (!colorUnion[sourceIndex]) {
        outsideColorCounts[x] += 1;
      }
    }
  }

  let removedStraightRowCount = 0;
  for (let y = 0; y < frameHeight; y += 1) {
    if (rowCounts[y] < frameWidth * 0.55) continue;
    removedStraightRowCount += 1;
    for (let x = 0; x < frameWidth; x += 1) {
      mask[y * frameWidth + x] = 0;
    }
  }

  let removedNeutralColumnCount = 0;
  for (let x = 0; x < frameWidth; x += 1) {
    let longestRun = 0;
    let run = 0;
    for (let y = 0; y < frameHeight; y += 1) {
      if (mask[y * frameWidth + x]) {
        run += 1;
        longestRun = Math.max(longestRun, run);
      } else {
        run = 0;
      }
    }
    // Original RGB is deliberately unnecessary here. Pixels outside the
    // chromatic union are the mask-only proxy for a neutral axis/guide. A
    // neutral State Curve is retained unless it also forms a nearly straight
    // full-height column.
    const outsideColorRatio =
      outsideColorCounts[x] /
      Math.max(1, columnCounts[x]);
    if (
      longestRun < frameHeight * 0.62 ||
      outsideColorRatio < 0.82
    ) {
      continue;
    }
    removedNeutralColumnCount += 1;
    for (let y = 0; y < frameHeight; y += 1) {
      mask[y * frameWidth + x] = 0;
    }
  }

  return {
    mask,
    width: frameWidth,
    height: frameHeight,
    removedStraightRowCount,
    removedNeutralColumnCount,
  };
}

function repeatedArchHorizontalGroups(
  mask,
  width,
  height,
  endFraction,
  maximumGap = 2,
) {
  const end = Math.min(
    height - 1,
    Math.max(3, Math.floor(height * endFraction)),
  );
  const occupiedColumns = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) {
    for (let y = 1; y <= end; y += 1) {
      if (mask[y * width + x]) {
        occupiedColumns[x] = 1;
        break;
      }
    }
  }

  const rawGroups = [];
  let start = -1;
  let last = -1;
  for (let x = 0; x < width; x += 1) {
    if (occupiedColumns[x]) {
      if (start < 0) start = x;
      last = x;
    } else if (start >= 0 && x - last > maximumGap) {
      rawGroups.push([start, last]);
      start = -1;
    }
  }
  if (start >= 0) rawGroups.push([start, last]);
  if (!rawGroups.length) return [];

  const typicalWidth = repeatedArchMedian(
    rawGroups
      .map(([groupStart, groupEnd]) =>
        groupEnd - groupStart + 1,
      )
      .filter((groupWidth) => groupWidth >= 2),
  );
  const minimumWidth = Math.max(
    2,
    Math.floor(typicalWidth * 0.42),
  );
  return rawGroups
    .filter(([groupStart, groupEnd]) => {
      const groupWidth = groupEnd - groupStart + 1;
      return (
        groupWidth >= minimumWidth &&
        (groupStart > 1 ||
          groupWidth >= typicalWidth * 0.7) &&
        (groupEnd < width - 2 ||
          groupWidth >= typicalWidth * 0.7)
      );
    })
    .map(([groupStart, groupEnd]) => ({
      start: groupStart,
      end: groupEnd,
      width: groupEnd - groupStart + 1,
      center: (groupStart + groupEnd) / 2,
    }));
}

function evaluateRepeatedArchGroups(
  groups,
  working,
  fraction,
) {
  if (!groups.length) {
    return { valid: false, score: -99 };
  }
  const gaps = groups
    .slice(1)
    .map(
      (group, index) =>
        group.center - groups[index].center,
    );
  const medianGap = repeatedArchMedian(gaps);
  const gapCoefficientOfVariation =
    gaps.length >= 2 ? coefficientOfVariation(gaps) : 0;
  const shallowGroups = repeatedArchHorizontalGroups(
    working.mask,
    working.width,
    working.height,
    Math.max(0.1, fraction - 0.04),
  );
  const deepGroups = repeatedArchHorizontalGroups(
    working.mask,
    working.width,
    working.height,
    Math.min(0.29, fraction + 0.05),
  );
  const nearestWidth = (
    candidates,
    center,
    maximumDistance,
  ) => {
    const nearby = candidates
      .filter(
        (candidate) =>
          Math.abs(candidate.center - center) <=
          maximumDistance,
      )
      .sort(
        (left, right) =>
          Math.abs(left.center - center) -
          Math.abs(right.center - center),
      );
    return nearby[0]?.width ?? 0;
  };
  const growth = groups.map((group) => {
    const shallowWidth = nearestWidth(
      shallowGroups,
      group.center,
      Math.max(4, medianGap * 0.35),
    );
    const deepWidth = nearestWidth(
      deepGroups,
      group.center,
      Math.max(5, medianGap * 0.38),
    );
    return {
      shallowWidth,
      baseWidth: group.width,
      deepWidth,
      ratio: deepWidth / Math.max(1, shallowWidth),
    };
  });
  const expandingRatio =
    growth.filter(
      (candidate) =>
        candidate.deepWidth >= candidate.baseWidth &&
        candidate.baseWidth >= candidate.shallowWidth &&
        candidate.deepWidth >=
          candidate.shallowWidth + 2,
    ).length / groups.length;
  const medianGrowth = repeatedArchMedian(
    growth.map((candidate) => candidate.ratio),
  );
  const regular =
    gaps.length < 2 ||
    gapCoefficientOfVariation <= 0.2;

  const archShapes = groups.map((group, groupIndex) => {
    const localGap =
      medianGap ||
      Math.max(group.width * 2.5, working.width * 0.45);
    const leftBoundary =
      groupIndex === 0
        ? Math.max(0, group.center - localGap * 0.48)
        : (groups[groupIndex - 1].center +
            group.center) /
          2;
    const rightBoundary =
      groupIndex === groups.length - 1
        ? Math.min(
            working.width - 1,
            group.center + localGap * 0.48,
          )
        : (group.center +
            groups[groupIndex + 1].center) /
          2;
    const samples = [];
    const maximumY = Math.floor(working.height * 0.58);
    for (
      let x = Math.ceil(leftBoundary);
      x <= Math.floor(rightBoundary);
      x += 1
    ) {
      let topY = -1;
      for (let y = 1; y <= maximumY; y += 1) {
        if (working.mask[y * working.width + x]) {
          topY = y;
          break;
        }
      }
      if (topY >= 0) {
        samples.push({
          distance: Math.abs(x - group.center),
          y: topY,
          side:
            x < group.center
              ? -1
              : x > group.center
                ? 1
                : 0,
        });
      }
    }
    const leftSamples = samples.filter(
      (sample) => sample.side < 0,
    );
    const rightSamples = samples.filter(
      (sample) => sample.side > 0,
    );
    const distanceMean = mean(
      samples.map((sample) => sample.distance),
    );
    const yMean = mean(
      samples.map((sample) => sample.y),
    );
    const covariance = samples.reduce(
      (sum, sample) =>
        sum +
        (sample.distance - distanceMean) *
          (sample.y - yMean),
      0,
    );
    const denominator = Math.sqrt(
      samples.reduce(
        (sum, sample) =>
          sum + (sample.distance - distanceMean) ** 2,
        0,
      ) *
        samples.reduce(
          (sum, sample) =>
            sum + (sample.y - yMean) ** 2,
          0,
        ),
    );
    const correlation =
      samples.length >= 5 && denominator > 0
        ? covariance / denominator
        : 0;
    const apex = repeatedArchMedian(
      samples
        .filter(
          (sample) =>
            sample.distance <=
            Math.max(1, localGap * 0.12),
        )
        .map((sample) => sample.y),
    );
    const shoulder = repeatedArchMedian(
      samples
        .filter(
          (sample) =>
            sample.distance >= localGap * 0.28,
        )
        .map((sample) => sample.y),
    );
    return {
      bilateral:
        leftSamples.length >= 2 &&
        rightSamples.length >= 2,
      correlation,
      apexRise: shoulder - apex,
    };
  });
  const concaveRatio =
    archShapes.filter(
      (shape) =>
        shape.bilateral &&
        shape.correlation >= 0.55 &&
        shape.apexRise >= working.height * 0.055,
    ).length / groups.length;
  const medianEnvelopeCorrelation = repeatedArchMedian(
    archShapes.map((shape) => shape.correlation),
  );
  const valid =
    groups.length <= 20 &&
    regular &&
    expandingRatio >= 0.75 &&
    medianGrowth >= 1.18 &&
    concaveRatio >= 0.75 &&
    medianEnvelopeCorrelation >= 0.62;
  const score =
    (valid ? 5 : 0) +
    groups.length * 0.015 -
    gapCoefficientOfVariation * 3 +
    expandingRatio +
    Math.min(2, medianGrowth) * 0.4 +
    concaveRatio -
    Math.abs(fraction - 0.18) * 0.5;
  return {
    valid,
    score,
    medianGap,
    gapCoefficientOfVariation,
    expandingRatio,
    medianGrowth,
    concaveRatio,
    medianEnvelopeCorrelation,
  };
}

function emptyRepeatedArchEvidence(reason, metadata = {}) {
  return {
    accepted: false,
    reason,
    peakCount: 0,
    peakCenters: [],
    normalizedPeakCenters: [],
    ...metadata,
  };
}

/**
 * Count a repeated lattice of physical Gaussian-like arch caps without using
 * labels, OCR, panel order or original RGB values. This is intentionally an
 * evidence-only helper: callers decide whether and how the measured peaks may
 * influence a Curve descriptor.
 *
 * @param {Uint8Array} broadMask
 * @param {Uint8Array} curveSalientMask
 * @param {Uint8Array[]} colorMasks
 * @param {number} width
 * @param {number} height
 * @param {{left:number,top:number,right:number,bottom:number,axisMode?:string}} bounds
 */
export function extractRepeatedArchPeakEvidence(
  broadMask,
  curveSalientMask,
  colorMasks,
  width,
  height,
  bounds,
) {
  const expectedLength = width * height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !broadMask ||
    broadMask.length !== expectedLength ||
    !curveSalientMask ||
    curveSalientMask.length !== expectedLength ||
    !Array.isArray(colorMasks) ||
    !bounds ||
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.right) ||
    !Number.isFinite(bounds.bottom)
  ) {
    return emptyRepeatedArchEvidence("INVALID_INPUT");
  }
  if (bounds.axisMode && bounds.axisMode !== "rectangle") {
    return emptyRepeatedArchEvidence(
      "UNSUPPORTED_AXIS_MODE",
    );
  }

  const frame = recoverRepeatedArchFrame(
    broadMask,
    width,
    height,
    bounds,
  );
  if (!frame) {
    return emptyRepeatedArchEvidence("FRAME_NOT_FOUND");
  }
  const working = buildRepeatedArchWorkingMask(
    curveSalientMask,
    colorMasks,
    width,
    height,
    frame,
  );
  const candidates = [
    0.14,
    0.16,
    0.18,
    0.2,
    0.22,
    0.24,
  ].map((bandFraction) => {
    const groups = repeatedArchHorizontalGroups(
      working.mask,
      working.width,
      working.height,
      bandFraction,
    );
    return {
      bandFraction,
      groups,
      ...evaluateRepeatedArchGroups(
        groups,
        working,
        bandFraction,
      ),
    };
  });
  const validCandidates = candidates.filter(
    (candidate) => candidate.valid,
  );
  const candidateSummary = candidates.map((candidate) => ({
    bandFraction: candidate.bandFraction,
    peakCount: candidate.groups.length,
    valid: candidate.valid,
    gapCoefficientOfVariation:
      candidate.gapCoefficientOfVariation ?? null,
    expandingRatio: candidate.expandingRatio ?? 0,
    medianGrowth: candidate.medianGrowth ?? 0,
    concaveRatio: candidate.concaveRatio ?? 0,
    medianEnvelopeCorrelation:
      candidate.medianEnvelopeCorrelation ?? 0,
  }));
  if (!validCandidates.length) {
    return emptyRepeatedArchEvidence(
      "ARCH_GEOMETRY_REJECTED",
      {
        frame,
        removedStraightRowCount:
          working.removedStraightRowCount,
        removedNeutralColumnCount:
          working.removedNeutralColumnCount,
        candidates: candidateSummary,
      },
    );
  }

  const votes = new Map();
  for (const candidate of validCandidates) {
    const peakCount = candidate.groups.length;
    const vote = votes.get(peakCount) ?? {
      peakCount,
      voteCount: 0,
      best: null,
    };
    vote.voteCount += 1;
    if (!vote.best || candidate.score > vote.best.score) {
      vote.best = candidate;
    }
    votes.set(peakCount, vote);
  }
  const winner = [...votes.values()].sort(
    (left, right) =>
      right.voteCount - left.voteCount ||
      right.best.score - left.best.score ||
      left.peakCount - right.peakCount,
  )[0];
  const chosen = winner.best;
  const stability = winner.voteCount / candidates.length;
  const accepted =
    stability >= 0.5 &&
    chosen.gapCoefficientOfVariation <= 0.2 &&
    chosen.expandingRatio >= 0.75 &&
    chosen.concaveRatio >= 0.75;
  if (!accepted) {
    return emptyRepeatedArchEvidence(
      "UNSTABLE_BAND_VOTE",
      {
        frame,
        stability,
        removedStraightRowCount:
          working.removedStraightRowCount,
        removedNeutralColumnCount:
          working.removedNeutralColumnCount,
        candidates: candidateSummary,
      },
    );
  }

  const peakCenters = chosen.groups.map(
    (group) => frame.left + group.center,
  );
  const canonical = canonicalProfileFromCurveMask(
    working.mask,
    working.width,
    working.height,
  );
  return {
    accepted: true,
    reason: "PASS",
    peakCount: chosen.groups.length,
    profile: canonical.profile,
    peakCenters,
    normalizedPeakCenters: chosen.groups.map(
      (group) =>
        group.center / Math.max(1, working.width - 1),
    ),
    frame,
    bandFraction: chosen.bandFraction,
    stability,
    gapCoefficientOfVariation:
      chosen.gapCoefficientOfVariation,
    medianGap: chosen.medianGap,
    expandingRatio: chosen.expandingRatio,
    medianGrowth: chosen.medianGrowth,
    concaveRatio: chosen.concaveRatio,
    medianEnvelopeCorrelation:
      chosen.medianEnvelopeCorrelation,
    removedStraightRowCount:
      working.removedStraightRowCount,
    removedNeutralColumnCount:
      working.removedNeutralColumnCount,
    candidates: candidateSummary,
  };
}

function upperArcUnionMasks(masks, length) {
  const union = new Uint8Array(length);
  for (const mask of masks) {
    if (!mask || mask.length !== length) continue;
    for (let index = 0; index < length; index += 1) {
      if (mask[index]) union[index] = 1;
    }
  }
  return union;
}

function upperArcConnectedComponents(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const components = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    const pixels = [start];
    seen[start] = 1;
    let cursor = 0;
    let left = start % width;
    let right = left;
    let top = Math.floor(start / width);
    let bottom = top;
    while (cursor < pixels.length) {
      const index = pixels[cursor];
      cursor += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (
        let localY = Math.max(0, y - 1);
        localY <= Math.min(height - 1, y + 1);
        localY += 1
      ) {
        for (
          let localX = Math.max(0, x - 1);
          localX <= Math.min(width - 1, x + 1);
          localX += 1
        ) {
          const neighbor = localY * width + localX;
          if (mask[neighbor] && !seen[neighbor]) {
            seen[neighbor] = 1;
            pixels.push(neighbor);
          }
        }
      }
    }
    components.push({
      pixels,
      area: pixels.length,
      left,
      right,
      top,
      bottom,
      width: right - left + 1,
      height: bottom - top + 1,
    });
  }
  return components;
}

function upperArcDominantTopCluster(anchors, height) {
  const tolerance = Math.max(3, Math.round(height * 0.04));
  let best = null;
  for (const anchor of anchors) {
    const members = anchors.filter(
      (other) => Math.abs(other.top - anchor.top) <= tolerance,
    );
    const score = members.reduce(
      (sum, member) =>
        sum +
        Math.min(member.width, 120) *
          Math.min(1, member.height / Math.max(1, height * 0.5)),
      0,
    );
    const weight = members.reduce(
      (sum, member) => sum + Math.min(member.width, 120),
      0,
    );
    const center = Math.round(
      members.reduce(
        (sum, member) =>
          sum + member.top * Math.min(member.width, 120),
        0,
      ) / Math.max(1, weight),
    );
    if (
      !best ||
      score > best.score ||
      (score === best.score && center < best.center)
    ) {
      best = { score, center };
    }
  }
  return best?.center ?? 0;
}

function selectUpperArcCurveComponents(mask, width, height) {
  const components = upperArcConnectedComponents(
    mask,
    width,
    height,
  ).filter(
    (component) =>
      component.area >= Math.max(4, Math.round(height * 0.025)) &&
      component.width >= 2,
  );
  const anchors = components.filter(
    (component) =>
      component.height >= Math.max(8, height * 0.28) &&
      component.width >= Math.max(3, width * 0.018),
  );
  if (!anchors.length) {
    return {
      components: [],
      anchors: [],
      top: 0,
      tolerance: 0,
    };
  }
  const top = upperArcDominantTopCluster(anchors, height);
  const tolerance = Math.max(4, Math.round(height * 0.065));
  const selected = components.filter(
    (component) =>
      Math.abs(component.top - top) <= tolerance &&
      component.bottom >= top + Math.max(4, height * 0.08),
  );
  return {
    components: selected,
    anchors,
    top,
    tolerance,
  };
}

function upperArcTopEnvelope(components, width) {
  const envelope = Array(width).fill(Number.NaN);
  for (const component of components) {
    for (const index of component.pixels) {
      const x = index % width;
      const y = Math.floor(index / width);
      if (
        !Number.isFinite(envelope[x]) ||
        y < envelope[x]
      ) {
        envelope[x] = y;
      }
    }
  }
  return envelope;
}

function upperArcFiniteGroups(values, maximumGap = 2) {
  const finite = values
    .map((value, index) =>
      Number.isFinite(value) ? index : -1,
    )
    .filter((index) => index >= 0);
  if (!finite.length) return [];
  const groups = [];
  let start = finite[0];
  let previous = finite[0];
  for (const index of finite.slice(1)) {
    if (index - previous > maximumGap + 1) {
      groups.push([start, previous]);
      start = index;
    }
    previous = index;
  }
  groups.push([start, previous]);
  return groups;
}

function upperArcInterpolate(values, start, end) {
  const output = values.slice(start, end + 1);
  for (let index = 0; index < output.length; index += 1) {
    if (Number.isFinite(output[index])) continue;
    let left = index - 1;
    let right = index + 1;
    while (
      left >= 0 &&
      !Number.isFinite(output[left])
    ) {
      left -= 1;
    }
    while (
      right < output.length &&
      !Number.isFinite(output[right])
    ) {
      right += 1;
    }
    if (left >= 0 && right < output.length) {
      const fraction = (index - left) / (right - left);
      output[index] =
        output[left] * (1 - fraction) +
        output[right] * fraction;
    } else if (left >= 0) {
      output[index] = output[left];
    } else if (right < output.length) {
      output[index] = output[right];
    }
  }
  return output;
}

function upperArcSmooth(values, radius = 1) {
  return values.map((_value, index) => {
    let sum = 0;
    let weight = 0;
    for (
      let sample = Math.max(0, index - radius);
      sample <= Math.min(values.length - 1, index + radius);
      sample += 1
    ) {
      const sampleWeight =
        radius + 1 - Math.abs(sample - index);
      sum += values[sample] * sampleWeight;
      weight += sampleWeight;
    }
    return sum / Math.max(1, weight);
  });
}

function upperArcLocalMinima(values, globalStart, width) {
  if (values.length < 5) return [];
  const smoothed = upperArcSmooth(values, 1);
  const candidates = [];
  let index = 1;
  while (index < smoothed.length - 1) {
    if (
      smoothed[index] > smoothed[index - 1] ||
      smoothed[index] > smoothed[index + 1]
    ) {
      index += 1;
      continue;
    }
    let plateauStart = index;
    let plateauEnd = index;
    while (
      plateauStart > 0 &&
      Math.abs(
        smoothed[plateauStart - 1] - smoothed[index],
      ) < 0.15
    ) {
      plateauStart -= 1;
    }
    while (
      plateauEnd + 1 < smoothed.length &&
      Math.abs(
        smoothed[plateauEnd + 1] - smoothed[index],
      ) < 0.15
    ) {
      plateauEnd += 1;
    }
    const center = Math.round(
      (plateauStart + plateauEnd) / 2,
    );
    if (center >= 2 && center <= smoothed.length - 3) {
      const radius = Math.max(
        5,
        Math.min(18, Math.round(smoothed.length * 0.08)),
      );
      const leftFloor = Math.max(
        ...smoothed.slice(
          Math.max(0, center - radius),
          center,
        ),
      );
      const rightFloor = Math.max(
        ...smoothed.slice(
          center + 1,
          Math.min(
            smoothed.length,
            center + radius + 1,
          ),
        ),
      );
      const prominence =
        Math.min(leftFloor, rightFloor) - smoothed[center];
      if (prominence >= 0.8) {
        candidates.push({
          x: globalStart + center,
          y: smoothed[center],
          prominence,
        });
      }
    }
    index = Math.max(index + 1, plateauEnd + 1);
  }
  const selected = [];
  const minimumDistance = Math.max(
    3,
    Math.round(width * 0.012),
  );
  for (const candidate of candidates.sort(
    (left, right) =>
      right.prominence - left.prominence ||
      left.y - right.y,
  )) {
    if (
      selected.every(
        (other) =>
          Math.abs(other.x - candidate.x) >=
          minimumDistance,
      )
    ) {
      selected.push(candidate);
    }
  }
  return selected.sort((left, right) => left.x - right.x);
}

function estimateUpperArcEnvelope(
  mask,
  width,
  height,
  lower,
  upper,
) {
  const envelope = Array(width).fill(Number.NaN);
  for (let x = 0; x < width; x += 1) {
    for (let y = lower; y <= upper; y += 1) {
      if (!mask[y * width + x]) continue;
      envelope[x] = y;
      break;
    }
  }
  const groups = upperArcFiniteGroups(envelope, 2);
  const peaks = [];
  for (const [start, end] of groups) {
    if (end - start + 1 < 5) continue;
    peaks.push(
      ...upperArcLocalMinima(
        upperArcInterpolate(envelope, start, end),
        start,
        width,
      ),
    );
  }
  return { envelope, groups, peaks };
}

function upperArcSpacingStats(peaks) {
  if (peaks.length < 2) {
    return { median: 0, coefficientOfVariation: 0, gaps: [] };
  }
  const gaps = peaks
    .slice(1)
    .map((peak, index) => peak.x - peaks[index].x);
  return {
    median: repeatedArchMedian(gaps),
    coefficientOfVariation: coefficientOfVariation(gaps),
    gaps,
  };
}

function regularizeUpperArcShortGaps(inputPeaks) {
  let peaks = [...inputPeaks].sort(
    (left, right) => left.x - right.x,
  );
  while (peaks.length >= 3) {
    const stats = upperArcSpacingStats(peaks);
    let shortestIndex = 0;
    for (let index = 1; index < stats.gaps.length; index += 1) {
      if (stats.gaps[index] < stats.gaps[shortestIndex]) {
        shortestIndex = index;
      }
    }
    if (
      stats.gaps[shortestIndex] >=
      stats.median * 0.45
    ) {
      break;
    }
    const leftIndex = shortestIndex;
    const rightIndex = shortestIndex + 1;
    const withoutLeft = peaks.filter(
      (_peak, index) => index !== leftIndex,
    );
    const withoutRight = peaks.filter(
      (_peak, index) => index !== rightIndex,
    );
    const leftCost =
      upperArcSpacingStats(withoutLeft)
        .coefficientOfVariation;
    const rightCost =
      upperArcSpacingStats(withoutRight)
        .coefficientOfVariation;
    const removeIndex =
      Math.abs(leftCost - rightCost) >= 0.01
        ? leftCost < rightCost
          ? leftIndex
          : rightIndex
        : peaks[leftIndex].prominence <
            peaks[rightIndex].prominence
          ? leftIndex
          : rightIndex;
    peaks = peaks.filter(
      (_peak, index) => index !== removeIndex,
    );
  }
  return peaks;
}

function fuseUpperArcEvidence(
  colorPeaks,
  salientPeaks,
  broadPeaks,
  width,
) {
  const baseline = regularizeUpperArcShortGaps(colorPeaks);
  if (baseline.length < 2) return baseline;
  const nominalSpacing =
    upperArcSpacingStats(baseline).median;
  const mergeTolerance = Math.max(
    3,
    Math.min(5, nominalSpacing * 0.28),
  );
  const fused = baseline.map((peak) => ({
    ...peak,
    source: "color",
  }));
  const additions = [];
  const candidates = [
    ...salientPeaks.map((peak) => ({
      ...peak,
      source: "salient",
    })),
    ...broadPeaks.map((peak) => ({
      ...peak,
      source: "broad",
    })),
  ];
  for (const candidate of candidates) {
    if (
      fused.some(
        (peak) =>
          Math.abs(peak.x - candidate.x) <= mergeTolerance,
      ) ||
      additions.some(
        (peak) =>
          Math.abs(peak.x - candidate.x) <= mergeTolerance,
      )
    ) {
      continue;
    }
    const ordered = [...fused, ...additions].sort(
      (left, right) => left.x - right.x,
    );
    const left = [...ordered]
      .reverse()
      .find((peak) => peak.x < candidate.x);
    const right = ordered.find(
      (peak) => peak.x > candidate.x,
    );
    let accepted = false;
    let latticeError = Number.POSITIVE_INFINITY;
    if (left && right) {
      const leftGap = candidate.x - left.x;
      const rightGap = right.x - candidate.x;
      const fullGap = right.x - left.x;
      accepted =
        fullGap >= nominalSpacing * 1.55 &&
        leftGap >= nominalSpacing * 0.55 &&
        leftGap <= nominalSpacing * 1.45 &&
        rightGap >= nominalSpacing * 0.55 &&
        rightGap <= nominalSpacing * 1.45;
      latticeError =
        Math.abs(leftGap - nominalSpacing) +
        Math.abs(rightGap - nominalSpacing);
    } else if (left) {
      const gap = candidate.x - left.x;
      accepted =
        gap >= nominalSpacing * 0.55 &&
        gap <= nominalSpacing * 1.45;
      latticeError = Math.abs(gap - nominalSpacing);
    } else if (right) {
      const gap = right.x - candidate.x;
      accepted =
        candidate.x >= width * 0.08 &&
        gap >= nominalSpacing * 0.55 &&
        gap <= nominalSpacing * 1.45;
      latticeError = Math.abs(gap - nominalSpacing);
    }
    if (accepted) {
      additions.push({ ...candidate, latticeError });
    }
  }
  for (const candidate of additions.sort(
    (left, right) =>
      left.latticeError - right.latticeError ||
      right.prominence - left.prominence,
  )) {
    if (
      fused.every(
        (peak) =>
          Math.abs(peak.x - candidate.x) > mergeTolerance,
      )
    ) {
      fused.push(candidate);
    }
  }
  return regularizeUpperArcShortGaps(fused).sort(
    (left, right) => left.x - right.x,
  );
}

function upperArcProfileFromEnvelopes(
  envelopes,
  peaks,
  width,
) {
  if (!peaks.length) return null;
  const finiteColumns = Array.from(
    { length: width },
    (_value, x) => x,
  ).filter((x) =>
    envelopes.some((envelope) =>
      Number.isFinite(envelope[x]),
    ),
  );
  if (!finiteColumns.length) return null;
  const spacing = upperArcSpacingStats(peaks).median;
  const padding =
    peaks.length >= 2
      ? Math.max(3, Math.round(spacing * 0.55))
      : 0;
  const leftLimit =
    peaks.length >= 2
      ? Math.max(
          0,
          Math.floor(peaks[0].x - padding),
        )
      : finiteColumns[0];
  const rightLimit =
    peaks.length >= 2
      ? Math.min(
          width - 1,
          Math.ceil(peaks.at(-1).x + padding),
        )
      : finiteColumns.at(-1);
  const combined = Array(width).fill(Number.NaN);
  for (let x = leftLimit; x <= rightLimit; x += 1) {
    const values = envelopes
      .map((envelope) => envelope[x])
      .filter(Number.isFinite);
    if (values.length) combined[x] = Math.min(...values);
  }
  let start = leftLimit;
  let end = rightLimit;
  while (start < end && !Number.isFinite(combined[start])) {
    start += 1;
  }
  while (end > start && !Number.isFinite(combined[end])) {
    end -= 1;
  }
  if (
    end - start < 8 ||
    peaks[0].x <= start ||
    peaks.at(-1).x >= end
  ) {
    return null;
  }
  const interpolated = upperArcInterpolate(
    combined,
    start,
    end,
  );
  if (interpolated.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const minimumY = Math.min(...interpolated);
  const maximumY = Math.max(...interpolated);
  if (maximumY - minimumY < 2) return null;
  const profile = interpolated.map((value) =>
    clamp(
      (maximumY - value) /
        Math.max(1e-6, maximumY - minimumY),
    ),
  );
  return {
    profile,
    normalizedPeakCenters: peaks.map(
      (peak) => (peak.x - start) / (end - start),
    ),
    profileBounds: {
      left: start,
      right: end,
    },
  };
}

function emptyUpperArcEvidence(reason, metadata = {}) {
  return {
    accepted: false,
    reason,
    peakCount: 0,
    peakCenters: [],
    normalizedPeakCenters: [],
    ...metadata,
  };
}

/**
 * Measure a repeated upper-arc lattice from the real chromatic/salient pixel
 * envelopes. Unlike State-count priors, this helper never inserts a nominal
 * peak: every returned hint must snap to a distinct maximum in the measured
 * envelope and every adjacent pair must contain a measured valley.
 *
 * Tall, apex-aligned color components provide the waveform gate. Tables,
 * labels, callouts and monotone diagrams fail before topology can be applied.
 *
 * @param {Uint8Array} broadMask
 * @param {Uint8Array} curveSalientMask
 * @param {Uint8Array[]} colorMasks
 * @param {number} width
 * @param {number} height
 * @param {{minimumPeakCount?: 1 | 2}} [options]
 */
export function extractUpperArcPeakEvidence(
  broadMask,
  curveSalientMask,
  colorMasks,
  width,
  height,
  options = {},
) {
  const expectedLength = width * height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !broadMask ||
    broadMask.length !== expectedLength ||
    !curveSalientMask ||
    curveSalientMask.length !== expectedLength ||
    !Array.isArray(colorMasks) ||
    !colorMasks.length
  ) {
    return emptyUpperArcEvidence("INVALID_INPUT");
  }
  const colorUnion = upperArcUnionMasks(
    colorMasks,
    expectedLength,
  );
  const selection = selectUpperArcCurveComponents(
    colorUnion,
    width,
    height,
  );
  if (
    !selection.anchors.length ||
    !selection.components.length
  ) {
    return emptyUpperArcEvidence(
      "CURVE_COMPONENTS_NOT_FOUND",
      {
        anchorComponentCount: selection.anchors.length,
        selectedColorComponentCount:
          selection.components.length,
        apexRow: selection.top,
      },
    );
  }
  if (
    selection.top < 1 ||
    selection.top > height * 0.68
  ) {
    return emptyUpperArcEvidence("APEX_BAND_REJECTED", {
      apexRow: selection.top,
    });
  }

  const colorEnvelope = upperArcTopEnvelope(
    selection.components,
    width,
  );
  const colorGroups = upperArcFiniteGroups(colorEnvelope, 2);
  const colorPeaks = [];
  for (const [start, end] of colorGroups) {
    if (end - start + 1 < 5) continue;
    colorPeaks.push(
      ...upperArcLocalMinima(
        upperArcInterpolate(
          colorEnvelope,
          start,
          end,
        ),
        start,
        width,
      ),
    );
  }
  const lower = Math.max(
    0,
    selection.top - Math.max(2, Math.round(height * 0.015)),
  );
  const upper = Math.min(
    height - 1,
    selection.top + Math.max(10, Math.round(height * 0.24)),
  );
  const salient = estimateUpperArcEnvelope(
    curveSalientMask,
    width,
    height,
    lower,
    upper,
  );
  const broad = estimateUpperArcEnvelope(
    broadMask,
    width,
    height,
    lower,
    upper,
  );
  const peaks = fuseUpperArcEvidence(
    colorPeaks,
    salient.peaks,
    broad.peaks,
    width,
  );
  const minimumPeakCount =
    options.minimumPeakCount === 1 ? 1 : 2;
  if (
    peaks.length < minimumPeakCount ||
    !isValidStateCount(peaks.length)
  ) {
    return emptyUpperArcEvidence("PEAK_COUNT_REJECTED", {
      colorPeakCount: colorPeaks.length,
      salientPeakCount: salient.peaks.length,
      broadPeakCount: broad.peaks.length,
      measuredPeakCount: peaks.length,
    });
  }
  const spacing = upperArcSpacingStats(peaks);
  const spanRatio =
    (peaks.at(-1).x - peaks[0].x) / Math.max(1, width);
  const apexRows = peaks.map((peak) => peak.y);
  const apexMedian = repeatedArchMedian(apexRows);
  const apexMedianDeviation = repeatedArchMedian(
    apexRows.map((row) => Math.abs(row - apexMedian)),
  );
  if (
    (peaks.length >= 2 &&
      (spacing.coefficientOfVariation > 0.24 ||
        spanRatio < 0.22)) ||
    apexMedianDeviation > Math.max(4, height * 0.07)
  ) {
    return emptyUpperArcEvidence("LATTICE_GEOMETRY_REJECTED", {
      measuredPeakCount: peaks.length,
      gapCoefficientOfVariation:
        spacing.coefficientOfVariation,
      spanRatio,
      apexMedianDeviation,
    });
  }
  const resolvedProfile = upperArcProfileFromEnvelopes(
    [
      colorEnvelope,
      salient.envelope,
      broad.envelope,
    ],
    peaks,
    width,
  );
  if (!resolvedProfile) {
    return emptyUpperArcEvidence(
      "MEASURED_PROFILE_NOT_FOUND",
      {
        measuredPeakCount: peaks.length,
      },
    );
  }
  const guided = tryDescriptorFromPeakHints(
    resolvedProfile.profile,
    resolvedProfile.normalizedPeakCenters,
  );
  if (!guided.ok) {
    return emptyUpperArcEvidence(
      "PROFILE_TOPOLOGY_REJECTED",
      {
        measuredPeakCount: peaks.length,
        topologyReason: guided.reason,
      },
    );
  }
  return {
    accepted: true,
    reason: "PASS",
    peakCount: peaks.length,
    peakCenters: peaks.map((peak) => peak.x),
    normalizedPeakCenters:
      resolvedProfile.normalizedPeakCenters,
    // Keep the public/training contract at 256 raw samples. Consumers and
    // tryDescriptorFromPeakHints apply the same canonical smoothing exactly
    // once, so the descriptor remains anchored to this measured envelope.
    profile: resample(resolvedProfile.profile),
    descriptor: guided.descriptor,
    snappedPeakLocations: guided.snappedLocations,
    profileBounds: resolvedProfile.profileBounds,
    gapCoefficientOfVariation:
      spacing.coefficientOfVariation,
    medianGap: spacing.median,
    spanRatio,
    apexRow: selection.top,
    apexMedianDeviation,
    colorPeakCount: colorPeaks.length,
    salientPeakCount: salient.peaks.length,
    broadPeakCount: broad.peaks.length,
    selectedColorComponentCount:
      selection.components.length,
    anchorComponentCount: selection.anchors.length,
  };
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
  const invalidStatePenalty = isValidStateCount(
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

function isEligibleIndependentDistributionProfile(
  profile,
  descriptor,
) {
  if (!isValidStateCount(descriptor.stateCount)) return false;
  if (descriptor.observedStateCount >= 2) return true;
  if (
    descriptor.stateCount !== 1 ||
    descriptor.observedStateCount !== 1 ||
    descriptor.peakLocations.length !== 1
  ) {
    return false;
  }

  // A full-width diagonal or horizontal guide can otherwise look like a
  // one-State trace after hue/achromatic separation. A genuine one-State VTH
  // distribution has an interior rounded summit and independently descending
  // left/right tails. Keep the gate intentionally shape-only: axis values,
  // color and line style do not participate.
  const smoothed = movingAverage(profile, 7);
  const peakLocation = descriptor.peakLocations[0];
  const peakIndex = Math.round(
    peakLocation * Math.max(0, smoothed.length - 1),
  );
  const edgeWidth = Math.max(
    4,
    Math.round(smoothed.length * 0.08),
  );
  const apex = smoothed[peakIndex];
  const leftTail = mean(smoothed.slice(0, edgeWidth));
  const rightTail = mean(smoothed.slice(-edgeWidth));
  const shoulderOffset = Math.max(
    3,
    Math.round(smoothed.length * 0.025),
  );
  const leftShoulder =
    smoothed[Math.max(0, peakIndex - shoulderOffset)];
  const rightShoulder =
    smoothed[
      Math.min(smoothed.length - 1, peakIndex + shoulderOffset)
    ];

  return (
    peakLocation >= 0.08 &&
    peakLocation <= 0.92 &&
    apex - leftTail >= 0.3 &&
    apex - rightTail >= 0.3 &&
    leftShoulder >= apex - 0.22 &&
    rightShoulder >= apex - 0.22
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
    if (!isValidStateCount(descriptor.stateCount)) continue;
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
    !isEligibleIndependentDistributionProfile(
      profile,
      descriptor,
    )
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
  if (!isValidStateCount(descriptor.stateCount)) return null;
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
      !isEligibleIndependentDistributionProfile(
        profile,
        descriptor,
      )
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
  if (!isValidStateCount(aggressiveDescriptor.stateCount)) {
    return descriptor;
  }
  const primaryValid = isValidStateCount(descriptor.stateCount);
  const sameStateCount =
    descriptor.stateCount === aggressiveDescriptor.stateCount;
  if (
    !primaryValid ||
    (sameStateCount &&
      descriptor.regularized &&
      !aggressiveDescriptor.regularized)
  ) {
    return aggressiveDescriptor;
  }
  return descriptor;
}

export function shouldPreferSalientDescriptor(
  primaryDescriptor,
  salientDescriptor,
  artifactLineCount = 0,
  profileSimilarity = 1,
) {
  const primaryHasOneFaintStandardState =
    primaryDescriptor.regularized === true &&
    [4, 8, 16].includes(primaryDescriptor.stateCount) &&
    primaryDescriptor.observedStateCount ===
      primaryDescriptor.stateCount - 1 &&
    salientDescriptor.stateCount <=
      primaryDescriptor.stateCount - 3;
  if (primaryHasOneFaintStandardState) return false;
  return (
    isValidStateCount(salientDescriptor.stateCount) &&
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
    isValidStateCount(retrievalDescriptor.stateCount) &&
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
  const repeatedArchEvidence =
    bounds.axisMode === "rectangle"
      ? extractRepeatedArchPeakEvidence(
          analysisBroadMask,
          deskewed.curveSalientMask,
          analysisCurveColorMasks,
          width,
          height,
          bounds,
        )
      : emptyRepeatedArchEvidence("UNSUPPORTED_AXIS_MODE");
  const repeatedArchGuidedDescriptor =
    repeatedArchEvidence.accepted &&
    isValidStateCount(repeatedArchEvidence.peakCount)
      ? tryDescriptorFromPeakHints(
          repeatedArchEvidence.profile,
          repeatedArchEvidence.normalizedPeakCenters,
        )
      : { ok: false, reason: "state_limit_exceeded" };
  const repeatedArchCandidate =
    repeatedArchGuidedDescriptor.ok
      ? {
          profile: repeatedArchEvidence.profile,
          descriptor:
            repeatedArchGuidedDescriptor.descriptor,
          peakEvidence: repeatedArchEvidence,
        }
      : null;
  const upperArcEvidence = extractUpperArcPeakEvidence(
    analysisBroadMask,
    deskewed.curveSalientMask,
    analysisCurveColorMasks,
    width,
    height,
  );
  const upperArcCandidate =
    upperArcEvidence.accepted &&
    isValidStateCount(upperArcEvidence.peakCount)
      ? {
          profile: upperArcEvidence.profile,
          descriptor: upperArcEvidence.descriptor,
          peakEvidence: upperArcEvidence,
        }
      : null;
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
  // Cropping to content changes the materialized Curve topology. Never carry
  // only the pre-crop State count onto post-crop peak/valley arrays: the
  // descriptor and selected profile must be derived from the same pixels.
  const primaryDescriptor = primaryShapeDescriptor;
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
  const primaryAggressiveSimilarity = alignedCurveSimilarity(
    primaryCanonical.profile,
    aggressiveCanonical.profile,
  );
  const aggressiveRestoresArtifactSplitState =
    selectedProfile === primaryCanonical.profile &&
    artifactLineCount >= 20 &&
    primaryDescriptor.regularized === false &&
    aggressiveDescriptor.regularized === false &&
    aggressiveDescriptor.stateCount ===
      primaryDescriptor.stateCount + 1 &&
    primaryAggressiveSimilarity >= 0.985;
  if (aggressiveRestoresArtifactSplitState) {
    // Filled/shaded plots can make State boundaries look like dozens of
    // straight guide columns. The normal grid suppressor may then erase one
    // physical peak. Accept the edge-only reconstruction only when it restores
    // exactly one independently observed peak and keeps virtually the same
    // Curve; this is pixel evidence rather than a 2/4/8/16 prior.
    selectedProfile = aggressiveCanonical.profile;
    descriptor = aggressiveDescriptor;
  }
  const primarySalientSimilarity = alignedCurveSimilarity(
    selectedProfile,
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
    !isValidStateCount(descriptor.stateCount) &&
    isValidStateCount(salientDescriptor.stateCount)
  ) {
    selectedProfile = salientCanonical.profile;
    descriptor = salientDescriptor;
  }
  if (
    useContentCoordinates ||
    !isValidStateCount(descriptor.stateCount)
  ) {
    const reconciledDescriptor = reconcileStateDescriptor(
      descriptor,
      aggressiveDescriptor,
    );
    if (reconciledDescriptor === aggressiveDescriptor) {
      selectedProfile = aggressiveCanonical.profile;
    }
    descriptor = reconciledDescriptor;
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
  const upperArcColorSupport =
    (upperArcEvidence.colorPeakCount ?? 0) /
    Math.max(1, upperArcEvidence.peakCount ?? 0);
  const repeatedArchConflictsWithColorSupportedArc =
    repeatedArchCandidate &&
    upperArcCandidate &&
    repeatedArchCandidate.descriptor.stateCount !==
      upperArcCandidate.descriptor.stateCount &&
    upperArcColorSupport >= 0.75;
  const primaryHasStrictSupportedTopology =
    [4, 8, 16].includes(primaryDescriptor.stateCount) &&
    primaryDescriptor.peakLocations.length ===
      primaryDescriptor.stateCount &&
    primaryDescriptor.peakWidths.length ===
      primaryDescriptor.stateCount &&
    primaryDescriptor.valleyLocations.length ===
      primaryDescriptor.stateCount - 1 &&
    primaryDescriptor.valleyHeights.length ===
      primaryDescriptor.stateCount - 1 &&
    primaryDescriptor.valleyDepths.length ===
      primaryDescriptor.stateCount - 1;
  const repeatedArchUnstableUndercountsPrimary =
    repeatedArchCandidate &&
    primaryHasStrictSupportedTopology &&
    repeatedArchCandidate.descriptor.stateCount <
      primaryDescriptor.stateCount &&
    primaryDescriptor.observedStateCount >=
      repeatedArchCandidate.descriptor.stateCount &&
    (repeatedArchEvidence.stability ?? 0) < 0.75;
  const applicableRepeatedArchCandidate =
    repeatedArchCandidate &&
    !detectedColorCandidates.length &&
    !repeatedArchConflictsWithColorSupportedArc &&
    !repeatedArchUnstableUndercountsPrimary
      ? repeatedArchCandidate
      : null;
  const upperArcUndercountsSupportedPrior =
    upperArcCandidate &&
    primaryDescriptor.regularized === true &&
    [4, 8, 16].includes(primaryDescriptor.stateCount) &&
    upperArcCandidate.descriptor.stateCount <
      primaryDescriptor.stateCount &&
    upperArcColorSupport < 0.75;
  const upperArcHasWeakColorSupport =
    upperArcCandidate && upperArcColorSupport < 0.75;
  const upperArcOvercountsEightStatePrior =
    upperArcCandidate &&
    primaryDescriptor.stateCount === 8 &&
    upperArcCandidate.descriptor.stateCount === 9 &&
    (upperArcEvidence.colorPeakCount ?? 0) <= 8;
  const applicableUpperArcCandidate =
    upperArcCandidate &&
    !applicableRepeatedArchCandidate &&
    !detectedColorCandidates.length &&
    !upperArcUndercountsSupportedPrior &&
    !upperArcHasWeakColorSupport &&
    !upperArcOvercountsEightStatePrior
      ? upperArcCandidate
      : null;
  const applicablePhysicalPeakCandidate =
    applicableRepeatedArchCandidate ??
    applicableUpperArcCandidate;
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
    applicablePhysicalPeakCandidate
      ? {
          distributionCount: 1,
          selectedIndex: 0,
          candidates: [],
        }
      : mixedDistributionCandidates.selected
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
    const primarySupportsMissingColorStates =
      primaryDescriptor.regularized === true &&
      [4, 8, 16].includes(primaryDescriptor.stateCount) &&
      primaryDescriptor.observedStateCount >= 4 &&
      primaryDescriptor.stateCount >
        chromaticUnionCandidate.descriptor.stateCount &&
      primaryDescriptor.stateCount -
        chromaticUnionCandidate.descriptor.stateCount <=
        3 &&
      alignedCurveSimilarity(
        primaryCanonical.profile,
        chromaticUnionCandidate.profile,
      ) >= 0.93;
    descriptor = primarySupportsMissingColorStates
      ? descriptorFromProfile(selectedProfile, {
          stateCountHint: primaryDescriptor.stateCount,
        })
      : chromaticUnionCandidate.descriptor;
  }
  if (applicableRepeatedArchCandidate) {
    // Repeated arch evidence is measured from the cleaned salient mask at six
    // independent depth bands. It is allowed to replace a geometric split only
    // when no hue forms an independent full-width distribution. The profile
    // remains the real pixel envelope; peak hints only resolve its topology.
    selectedProfile = applicableRepeatedArchCandidate.profile;
    descriptor = applicableRepeatedArchCandidate.descriptor;
    displacedPrimary = null;
  } else if (applicableUpperArcCandidate) {
    // Open axes and low-resolution PPT panels do not always expose a complete
    // rectangle frame. In that case the apex-aligned color components provide
    // the chart gate and the descriptor is still resolved exclusively from
    // maxima and valleys in the measured upper envelope.
    const plotWidth = Math.max(
      1,
      bounds.right - bounds.left,
    );
    const plotNormalizedPeakCenters =
      applicableUpperArcCandidate.peakEvidence.peakCenters.map(
        (center) => (center - bounds.left) / plotWidth,
      );
    const selectedHintSets = [
      plotNormalizedPeakCenters,
      applicableUpperArcCandidate.peakEvidence
        .normalizedPeakCenters,
    ].filter(
      (hints) =>
        hints.every(
          (location, index) =>
            Number.isFinite(location) &&
            location >= 0 &&
            location <= 1 &&
            (index === 0 || location > hints[index - 1]),
        ),
    );
    const guidedSelectedProfile =
      selectedHintSets
        .map((hints) =>
          tryDescriptorFromPeakHints(
            selectedProfile,
            hints,
          ),
        )
        .find((candidate) => candidate.ok) ?? {
        ok: false,
      };
    if (guidedSelectedProfile.ok) {
      // Preserve the established chromatic-union Curve when the independently
      // measured arches snap to its real maxima. Only topology is tightened;
      // training provenance and retrieval shape remain stable.
      descriptor = guidedSelectedProfile.descriptor;
    } else {
      selectedProfile = applicableUpperArcCandidate.profile;
      descriptor = applicableUpperArcCandidate.descriptor;
    }
    displacedPrimary = null;
  }
  const alternatives = [];
  const addAlternative = (
    alternativeProfile,
    alternativeDescriptor,
    metadata = {},
  ) => {
    if (selectedDistribution) return;
    if (!isValidStateCount(alternativeDescriptor.stateCount)) return;
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
      !isValidStateCount(descriptor.stateCount))
  ) {
    addAlternative(
      aggressiveCanonical.profile,
      aggressiveDescriptor,
    );
  }

  // At most two independently measured color traces are materialized as
  // separate search/training records. Three or more traces make hue an
  // unreliable proxy for user intent (legends and State-segment styling are
  // common in PPT exports), so only the already selected most-irregular
  // distribution remains a target. Geometry-only separation keeps its
  // established behavior because this policy is specifically about color.
  const colorDerivedDistributionSelection =
    Boolean(selectedDistribution) &&
    distributionCandidates.candidates.some((candidate) =>
      ["color", "achromatic", "chromatic-union"].includes(
        candidate.separationMode,
      ),
    );
  const collapseColorSeriesToMostIrregular =
    colorDerivedDistributionSelection &&
    distributionCandidates.candidates.length >
      MAX_INDEPENDENT_COLOR_SERIES;
  const targetDistributionCandidates = selectedDistribution
    ? collapseColorSeriesToMostIrregular
      ? [selectedDistribution]
      : distributionCandidates.candidates
    : [];
  const orderedDistributionCandidates = selectedDistribution
    ? [...targetDistributionCandidates].sort(
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
            applicableRepeatedArchCandidate
              ? "repeated-arch-evidence"
              : applicableUpperArcCandidate
                ? chromaticUnionCandidate?.separationMode ??
                  "upper-arc-evidence"
              : chromaticUnionCandidate?.separationMode ??
                "single",
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
          mode: collapseColorSeriesToMostIrregular
            ? "most-irregular-only"
            : "most-irregular",
          distributionCount:
            distributionCandidates.distributionCount,
          targetDistributionCount:
            orderedDistributionCandidates.length,
          selectedIndex: distributionCandidates.selectedIndex,
          selectedSeriesIndex,
          irregularityScore:
            selectedDistribution.irregularityScore,
        }
      : {
          mode: "single",
          distributionCount: 1,
          targetDistributionCount: 1,
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
        (applicableRepeatedArchCandidate
          ? "repeated-arch-evidence"
          : applicableUpperArcCandidate
            ? chromaticUnionCandidate?.separationMode ??
              "upper-arc-evidence"
          : chromaticUnionCandidate?.separationMode) ??
        "geometry",
      colorSeriesPolicy: {
        maximumIndependentSeries:
          MAX_INDEPENDENT_COLOR_SERIES,
        applied: colorDerivedDistributionSelection,
        collapsedToMostIrregular:
          collapseColorSeriesToMostIrregular,
        detectedSeriesCount:
          colorDerivedDistributionSelection
            ? distributionCandidates.candidates.length
            : 0,
        targetSeriesCount:
          orderedDistributionCandidates.length || 1,
        selectedSourceIndex:
          selectedDistribution?.sourceIndex ?? 0,
      },
      repeatedArchEvidence: {
        accepted:
          repeatedArchEvidence.accepted === true,
        applied:
          Boolean(applicableRepeatedArchCandidate),
        reason:
          repeatedArchEvidence.accepted === true &&
          !applicableRepeatedArchCandidate
            ? repeatedArchGuidedDescriptor.ok !== true
              ? repeatedArchGuidedDescriptor.reason
              : detectedColorCandidates.length
                ? "independent_color_series"
                : repeatedArchConflictsWithColorSupportedArc
                  ? "color_supported_upper_arc_preferred"
                  : repeatedArchUnstableUndercountsPrimary
                    ? "unstable_undercount_against_primary_topology"
                    : "not_applied"
            : repeatedArchEvidence.reason,
        measuredPeakCount:
          repeatedArchEvidence.peakCount ?? 0,
        stability:
          repeatedArchEvidence.stability ?? 0,
        gapCoefficientOfVariation:
          repeatedArchEvidence.gapCoefficientOfVariation ??
          null,
      },
      upperArcEvidence: {
        accepted: upperArcEvidence.accepted === true,
        applied: Boolean(applicableUpperArcCandidate),
        reason:
          upperArcEvidence.accepted === true &&
          !applicableUpperArcCandidate
            ? applicableRepeatedArchCandidate
              ? "repeated_arch_preferred"
              : detectedColorCandidates.length
                ? "independent_color_series"
                : upperArcUndercountsSupportedPrior
                  ? "insufficient_color_peak_support"
                  : upperArcHasWeakColorSupport
                    ? "weak_color_peak_support"
                  : upperArcOvercountsEightStatePrior
                    ? "unsupported_ninth_peak"
                : "not_applied"
            : upperArcEvidence.reason,
        measuredPeakCount:
          upperArcEvidence.peakCount ??
          upperArcEvidence.measuredPeakCount ??
          0,
        gapCoefficientOfVariation:
          upperArcEvidence.gapCoefficientOfVariation ??
          null,
        spanRatio: upperArcEvidence.spanRatio ?? 0,
      },
    },
  };
}

/**
 * Reuse a full-document, cell-local peak/valley measurement when cropping a
 * shared table-like chart grid changes the foreground/color quantization.
 * The override is deliberately narrow: only a single extracted distribution
 * may be replaced, and the supplied descriptor must already satisfy the
 * strict physical topology contract. Independent full-width color series keep
 * their normal per-series analysis.
 *
 * @param {ReturnType<typeof analyzeForegroundMasks>} analysis
 * @param {{profile?: number[]; descriptor?: object; source?: string} | null | undefined} evidence
 */
export function applyVerifiedWaveformEvidence(
  analysis,
  evidence,
) {
  const profile = Array.isArray(evidence?.profile)
    ? resample(evidence.profile)
    : null;
  const descriptor = evidence?.descriptor;
  const stateCount = Number(descriptor?.stateCount);
  const valleyCount = Math.max(0, stateCount - 1);
  const topologyConsistent =
    profile?.length === 256 &&
    profile.every(Number.isFinite) &&
    isValidStateCount(stateCount) &&
    descriptor.regularized !== true &&
    descriptor.observedStateCount === stateCount &&
    descriptor.peakLocations?.length === stateCount &&
    descriptor.peakWidths?.length === stateCount &&
    descriptor.valleyLocations?.length === valleyCount &&
    descriptor.valleyHeights?.length === valleyCount &&
    descriptor.valleyDepths?.length === valleyCount &&
    descriptor.valleyPositionRatios?.length === valleyCount &&
    descriptor.peakValleyDistances?.length ===
      valleyCount * 2 &&
    descriptor.tailSlopes?.length === 2;
  const declaredSeries =
    Array.isArray(analysis?.series) &&
    analysis.series.length
      ? analysis.series
      : [];
  // A collapsed 3+ color chart also exposes one series, but that series is an
  // intentional most-irregular choice rather than a single-distribution
  // chart. Panel-level grid evidence describes the combined chart topology
  // and must never replace that selected color trace.
  const preservesCollapsedColorPolicy =
    analysis?.preprocessing?.colorSeriesPolicy
      ?.collapsedToMostIrregular === true;
  if (
    !analysis ||
    !topologyConsistent ||
    declaredSeries.length !== 1 ||
    preservesCollapsedColorPolicy
  ) {
    return analysis;
  }

  const irregularityScore =
    distributionIrregularityScore(profile, descriptor);
  const originalSeries = declaredSeries[0];
  return {
    ...analysis,
    profile,
    descriptor,
    alternatives: [],
    series: [
      {
        ...originalSeries,
        seriesIndex: 0,
        sourceIndex: 0,
        profile,
        descriptor,
        irregularityScore,
        observedColumnRatio: 1,
        separationMode:
          evidence.source ??
          "table-grid-measured-topology",
        selected: true,
      },
    ],
    selectedSeriesIndex: 0,
    distributionSelection: {
      mode: "single",
      distributionCount: 1,
      selectedIndex: 0,
      selectedSeriesIndex: 0,
      irregularityScore,
    },
    preprocessing: {
      ...analysis.preprocessing,
      verifiedWaveformEvidence: {
        applied: true,
        source:
          evidence.source ??
          "table-grid-measured-topology",
        stateCount,
        valleyCount,
      },
    },
  };
}
