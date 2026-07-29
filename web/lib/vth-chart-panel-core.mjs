import { buildForegroundMasks } from "./vth-image-core.mjs";

// A 4 × 4 PPT grid leaves roughly 2.5–4% of the slide for each plot once
// titles and gutters are excluded. Keep enough headroom for 5 × 4 layouts and
// low-resolution screenshots without admitting ordinary label boxes.
const DEFAULT_MINIMUM_PANEL_AREA_RATIO = 0.008;
const DEFAULT_MINIMUM_PANEL_WIDTH_RATIO = 0.065;
const DEFAULT_MINIMUM_PANEL_HEIGHT_RATIO = 0.07;
const MINIMUM_OPEN_AXIS_PANEL_AREA_RATIO = 0.018;
const COMPACT_MINIMUM_PANEL_AREA_RATIO = 0.0015;
const COMPACT_MINIMUM_PANEL_WIDTH_RATIO = 0.025;
const COMPACT_MINIMUM_PANEL_HEIGHT_RATIO = 0.03;
const COMPACT_MINIMUM_OPEN_AXIS_PANEL_AREA_RATIO = 0.003;
const MAXIMUM_COMPOSITE_CONTAINER_CHECKS = 24;
const MAXIMUM_COMPOSITE_CHILDREN = 40;
const MAXIMUM_SHARED_FRAME_CELL_CHECKS = 720;
const MAXIMUM_SHARED_FRAME_HORIZONTAL_PAIR_CHECKS = 4_096;
const MAXIMUM_SHARED_FRAME_LINE_RELATION_CHECKS = 200_000;
const MAXIMUM_RECTANGLE_HORIZONTAL_PAIR_CHECKS = 4_096;
const MAXIMUM_RECTANGLE_LINE_RELATION_CHECKS = 250_000;
const MINIMUM_DENSE_SEPARATION_CANDIDATES = 6;
export const MAXIMUM_CHART_PANELS = 30;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function overlapLength(firstStart, firstEnd, secondStart, secondEnd) {
  return Math.max(
    0,
    Math.min(firstEnd, secondEnd) -
      Math.max(firstStart, secondStart) +
      1,
  );
}

function intervalOverlapRatio(
  firstStart,
  firstEnd,
  secondStart,
  secondEnd,
) {
  const overlap = overlapLength(
    firstStart,
    firstEnd,
    secondStart,
    secondEnd,
  );
  return (
    overlap /
    Math.max(
      1,
      Math.min(
        firstEnd - firstStart + 1,
        secondEnd - secondStart + 1,
      ),
    )
  );
}

function scanRuns(length, activeAt, maximumGap, minimumSpan) {
  const runs = [];
  let start = -1;
  let lastActive = -1;
  let activeCount = 0;
  const finish = () => {
    if (start < 0) return;
    const span = lastActive - start + 1;
    if (
      span >= minimumSpan &&
      activeCount / Math.max(1, span) >= 0.34
    ) {
      runs.push({
        start,
        end: lastActive,
        span,
        coverage: activeCount / span,
      });
    }
    start = -1;
    lastActive = -1;
    activeCount = 0;
  };

  for (let position = 0; position < length; position += 1) {
    if (activeAt(position)) {
      if (start < 0) start = position;
      lastActive = position;
      activeCount += 1;
    } else if (
      start >= 0 &&
      position - lastActive > maximumGap
    ) {
      finish();
    }
  }
  finish();
  return runs;
}

/**
 * Repair only short horizontal/vertical gaps in a foreground mask.
 *
 * Low-resolution screenshots and JPEG thumbnails frequently turn a one-pixel
 * chart frame into several short collinear runs. Closing only gaps bounded by
 * foreground pixels preserves the original chart coordinates and avoids the
 * broad dilation that would merge nearby, randomly positioned panels.
 */
export function repairLowResolutionLineMask(
  mask,
  width,
  height,
  options = {},
) {
  const maximumGap = clamp(
    Math.round(
      options.maximumGap ??
        Math.min(width, height) * 0.012,
    ),
    2,
    5,
  );
  const repaired = mask.slice();
  let repairedPixelCount = 0;

  const fillBoundedGaps = (length, indexAt) => {
    let previousActive = -1;
    for (let position = 0; position < length; position += 1) {
      const index = indexAt(position);
      if (!mask[index]) continue;
      const gap = position - previousActive - 1;
      if (
        previousActive >= 0 &&
        gap > 0 &&
        gap <= maximumGap
      ) {
        for (
          let fillPosition = previousActive + 1;
          fillPosition < position;
          fillPosition += 1
        ) {
          const fillIndex = indexAt(fillPosition);
          if (!repaired[fillIndex]) {
            repaired[fillIndex] = 1;
            repairedPixelCount += 1;
          }
        }
      }
      previousActive = position;
    }
  };

  for (let y = 0; y < height; y += 1) {
    fillBoundedGaps(width, (x) => y * width + x);
  }
  for (let x = 0; x < width; x += 1) {
    fillBoundedGaps(height, (y) => y * width + x);
  }

  return {
    mask: repaired,
    maximumGap,
    repairedPixelCount,
  };
}

function extractLineBands(
  mask,
  width,
  height,
  orientation,
  minimumSpan,
  maximumGapOverride,
) {
  const horizontal = orientation === "horizontal";
  const primaryLength = horizontal ? height : width;
  const secondaryLength = horizontal ? width : height;
  const safeMinimumSpan = Math.max(14, Math.round(minimumSpan));
  const maximumGap = Number.isFinite(maximumGapOverride)
    ? clamp(
        Math.round(maximumGapOverride),
        0,
        Math.max(0, secondaryLength - 1),
      )
    : Math.max(
        2,
        Math.round(secondaryLength * 0.006),
      );
  const raw = [];

  for (let primary = 0; primary < primaryLength; primary += 1) {
    const runs = scanRuns(
      secondaryLength,
      (secondary) =>
        horizontal
          ? mask[primary * width + secondary]
          : mask[secondary * width + primary],
      maximumGap,
      safeMinimumSpan,
    );
    for (const run of runs) {
      raw.push({
        coordinate: primary,
        start: run.start,
        end: run.end,
        coverage: run.coverage,
      });
    }
  }

  const bands = [];
  for (const segment of raw) {
    let best = null;
    let bestOverlap = 0;
    for (const band of bands) {
      if (
        segment.coordinate - band.lastCoordinate > 3 ||
        segment.coordinate < band.lastCoordinate
      ) {
        continue;
      }
      const overlap = intervalOverlapRatio(
        segment.start,
        segment.end,
        band.start,
        band.end,
      );
      if (overlap > 0.72 && overlap > bestOverlap) {
        best = band;
        bestOverlap = overlap;
      }
    }
    if (!best) {
      bands.push({
        coordinates: [segment.coordinate],
        starts: [segment.start],
        ends: [segment.end],
        coverages: [segment.coverage],
        start: segment.start,
        end: segment.end,
        lastCoordinate: segment.coordinate,
      });
      continue;
    }
    best.coordinates.push(segment.coordinate);
    best.starts.push(segment.start);
    best.ends.push(segment.end);
    best.coverages.push(segment.coverage);
    best.start = Math.round(
      best.starts.reduce((sum, value) => sum + value, 0) /
        best.starts.length,
    );
    best.end = Math.round(
      best.ends.reduce((sum, value) => sum + value, 0) /
        best.ends.length,
    );
    best.lastCoordinate = segment.coordinate;
  }

  return bands
    .map((band) => ({
      coordinate: Math.round(
        band.coordinates.reduce((sum, value) => sum + value, 0) /
          band.coordinates.length,
      ),
      start: band.start,
      end: band.end,
      thickness:
        Math.max(...band.coordinates) -
        Math.min(...band.coordinates) +
        1,
      coverage:
        band.coverages.reduce((sum, value) => sum + value, 0) /
        band.coverages.length,
    }))
    .filter(
      (band) =>
        band.end - band.start + 1 >= safeMinimumSpan &&
        // A broad filled block is normally a legend swatch or label, not an
        // axis. Real plot lines remain thin even after anti-aliasing.
        band.thickness <= Math.max(7, primaryLength * 0.025),
    );
}

function edgeSupport(
  mask,
  width,
  height,
  orientation,
  coordinate,
  start,
  end,
) {
  const radius = 2;
  let supported = 0;
  const span = Math.max(1, end - start + 1);
  for (let along = start; along <= end; along += 1) {
    let active = false;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const x =
        orientation === "horizontal"
          ? along
          : coordinate + offset;
      const y =
        orientation === "horizontal"
          ? coordinate + offset
          : along;
      if (
        x >= 0 &&
        x < width &&
        y >= 0 &&
        y < height &&
        mask[y * width + x]
      ) {
        active = true;
        break;
      }
    }
    if (active) supported += 1;
  }
  return supported / span;
}

function cornerActive(mask, width, height, x, y, radius) {
  for (
    let localY = Math.max(0, y - radius);
    localY <= Math.min(height - 1, y + radius);
    localY += 1
  ) {
    for (
      let localX = Math.max(0, x - radius);
      localX <= Math.min(width - 1, x + radius);
      localX += 1
    ) {
      if (mask[localY * width + localX]) return true;
    }
  }
  return false;
}

function interiorInkRatio(mask, width, bounds) {
  const insetX = Math.max(2, Math.round((bounds.right - bounds.left) * 0.03));
  const insetY = Math.max(2, Math.round((bounds.bottom - bounds.top) * 0.03));
  const left = bounds.left + insetX;
  const right = bounds.right - insetX;
  const top = bounds.top + insetY;
  const bottom = bounds.bottom - insetY;
  if (right <= left || bottom <= top) return 0;
  let active = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      active += mask[y * width + x] ? 1 : 0;
    }
  }
  return (
    active /
    Math.max(1, (right - left + 1) * (bottom - top + 1))
  );
}

function lineFitsInterval(line, start, end, tolerance) {
  const span = end - start + 1;
  return (
    overlapLength(line.start, line.end, start, end) /
      Math.max(1, span) >=
      0.82 &&
    line.start <= start + tolerance &&
    line.end >= end - tolerance
  );
}

function detectRectangleCandidates(
  mask,
  width,
  height,
  horizontalLines,
  verticalLines,
  minimumWidth,
  minimumHeight,
) {
  const candidates = [];
  const tolerance = Math.max(
    4,
    Math.round(Math.min(width, height) * 0.014),
  );
  let horizontalPairCheckCount = 0;
  let lineRelationCheckCount = 0;
  for (
    let topIndex = 0;
    topIndex < horizontalLines.length - 1;
    topIndex += 1
  ) {
    const topLine = horizontalLines[topIndex];
    for (
      let bottomIndex = topIndex + 1;
      bottomIndex < horizontalLines.length;
      bottomIndex += 1
    ) {
      horizontalPairCheckCount += 1;
      if (
        horizontalPairCheckCount >
        MAXIMUM_RECTANGLE_HORIZONTAL_PAIR_CHECKS
      ) {
        return candidates;
      }
      const bottomLine = horizontalLines[bottomIndex];
      const top = topLine.coordinate;
      const bottom = bottomLine.coordinate;
      if (bottom - top + 1 < minimumHeight) continue;
      const sharedLeft = Math.max(
        topLine.start,
        bottomLine.start,
      );
      const sharedRight = Math.min(
        topLine.end,
        bottomLine.end,
      );
      if (sharedRight - sharedLeft + 1 < minimumWidth) {
        continue;
      }
      const spanningVerticalLines = [];
      for (const line of verticalLines) {
        lineRelationCheckCount += 1;
        if (
          lineRelationCheckCount >
          MAXIMUM_RECTANGLE_LINE_RELATION_CHECKS
        ) {
          return candidates;
        }
        if (
          line.coordinate >= sharedLeft - tolerance &&
          line.coordinate <= sharedRight + tolerance &&
          lineFitsInterval(
            line,
            top,
            bottom,
            tolerance,
          )
        ) {
          spanningVerticalLines.push(line);
        }
      }
      for (
        let leftIndex = 0;
        leftIndex < spanningVerticalLines.length - 1;
        leftIndex += 1
      ) {
        const leftLine = spanningVerticalLines[leftIndex];
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < spanningVerticalLines.length;
          rightIndex += 1
        ) {
          lineRelationCheckCount += 1;
          if (
            lineRelationCheckCount >
            MAXIMUM_RECTANGLE_LINE_RELATION_CHECKS
          ) {
            return candidates;
          }
          const rightLine = spanningVerticalLines[rightIndex];
          const left = leftLine.coordinate;
          const right = rightLine.coordinate;
          if (right - left + 1 < minimumWidth) continue;
          if (
            !lineFitsInterval(topLine, left, right, tolerance) ||
            !lineFitsInterval(bottomLine, left, right, tolerance) ||
            !lineFitsInterval(leftLine, top, bottom, tolerance) ||
            !lineFitsInterval(rightLine, top, bottom, tolerance)
          ) {
            continue;
          }
          const endpointAlignedEdgeCount = [
            Math.abs(topLine.start - left) <= tolerance &&
              Math.abs(topLine.end - right) <= tolerance,
            Math.abs(bottomLine.start - left) <= tolerance &&
              Math.abs(bottomLine.end - right) <= tolerance,
            Math.abs(leftLine.start - top) <= tolerance &&
              Math.abs(leftLine.end - bottom) <= tolerance,
            Math.abs(rightLine.start - top) <= tolerance &&
              Math.abs(rightLine.end - bottom) <= tolerance,
          ].filter(Boolean).length;
          // Full-span table/grid lines satisfy lineFitsInterval for every cell
          // combination. A genuine frame, however, has at least three strokes
          // terminating near its corners. Rejecting candidates whose boundary
          // lines merely pass through them avoids materializing O(r²c²)
          // sub-rectangles while retaining broken/anti-aliased plot frames.
          if (endpointAlignedEdgeCount < 3) continue;

          const supports = [
            edgeSupport(
              mask,
              width,
              height,
              "horizontal",
              top,
              left,
              right,
            ),
            edgeSupport(
              mask,
              width,
              height,
              "horizontal",
              bottom,
              left,
              right,
            ),
            edgeSupport(
              mask,
              width,
              height,
              "vertical",
              left,
              top,
              bottom,
            ),
            edgeSupport(
              mask,
              width,
              height,
              "vertical",
              right,
              top,
              bottom,
            ),
          ];
          if (Math.min(...supports) < 0.58) continue;
          const cornerCount = [
            [left, top],
            [right, top],
            [left, bottom],
            [right, bottom],
          ].filter(([x, y]) =>
            cornerActive(mask, width, height, x, y, tolerance),
          ).length;
          if (cornerCount < 3) continue;
          const bounds = { left, top, right, bottom };
          const inkRatio = interiorInkRatio(mask, width, bounds);
          if (inkRatio < 0.0012) continue;
          candidates.push({
            ...bounds,
            confidence: clamp(
              0.48 +
                supports.reduce((sum, value) => sum + value, 0) *
                  0.09 +
                cornerCount * 0.025 +
                Math.min(0.08, inkRatio * 3),
              0,
              0.99,
            ),
            axisMode: "rectangle",
            detectionReason: "closed-plot-frame",
          });
        }
      }
    }
  }
  return candidates;
}

function detectLAxisCandidates(
  mask,
  width,
  height,
  horizontalLines,
  verticalLines,
  minimumWidth,
  minimumHeight,
) {
  const candidates = [];
  const tolerance = Math.max(
    4,
    Math.round(Math.min(width, height) * 0.018),
  );
  for (const horizontal of horizontalLines) {
    for (const vertical of verticalLines) {
      const left = vertical.coordinate;
      const bottom = horizontal.coordinate;
      const top = vertical.start;
      const right = horizontal.end;
      if (
        right - left + 1 < minimumWidth ||
        bottom - top + 1 < minimumHeight
      ) {
        continue;
      }
      // The two strokes must terminate at the lower-left corner. This rules
      // out most text baselines and State edges crossing a grid row.
      if (
        Math.abs(horizontal.start - left) > tolerance ||
        Math.abs(vertical.end - bottom) > tolerance
      ) {
        continue;
      }
      const horizontalSupport = edgeSupport(
        mask,
        width,
        height,
        "horizontal",
        bottom,
        left,
        right,
      );
      const verticalSupport = edgeSupport(
        mask,
        width,
        height,
        "vertical",
        left,
        top,
        bottom,
      );
      if (
        horizontalSupport < 0.58 ||
        verticalSupport < 0.58 ||
        !cornerActive(
          mask,
          width,
          height,
          left,
          bottom,
          tolerance,
        )
      ) {
        continue;
      }
      const bounds = { left, top, right, bottom };
      const inkRatio = interiorInkRatio(mask, width, bounds);
      if (inkRatio < 0.0012) continue;
      candidates.push({
        ...bounds,
        confidence: clamp(
          0.4 +
            horizontalSupport * 0.18 +
            verticalSupport * 0.18 +
            Math.min(0.09, inkRatio * 3),
          0,
          0.94,
        ),
        axisMode: "l-axis",
        detectionReason: "open-l-axis",
      });
    }
  }
  return candidates;
}

/**
 * Recover a plot whose top/bottom strokes continue through an immediately
 * adjacent plot. This occurs after a 1–3 px PPT gutter is resized: two
 * anti-aliased frame strokes can become a continuous line, so the normal
 * endpoint rule deliberately rejects the middle cell as table-like.
 *
 * Only adjacent, visibly thick vertical boundaries are considered. A
 * Curve-shaped interior is required before the candidate enters general
 * deduplication, which keeps ordinary table cells and diagram boxes out. The
 * number of evidence measurements is capped for adversarial grid-heavy input.
 */
function detectSharedFrameCellCandidates(
  mask,
  curveEvidenceMask,
  width,
  height,
  minimumWidth,
  minimumHeight,
) {
  if (!curveEvidenceMask) return [];
  const horizontalLines = extractLineBands(
    mask,
    width,
    height,
    "horizontal",
    minimumWidth,
    0,
  ).filter((line) => line.thickness >= 2);
  const verticalLines = extractLineBands(
    mask,
    width,
    height,
    "vertical",
    minimumHeight,
    0,
  ).filter((line) => line.thickness >= 2);
  const tolerance = Math.max(
    3,
    Math.round(Math.min(width, height) * 0.006),
  );
  const candidates = [];
  let checkedCandidateCount = 0;
  let horizontalPairCheckCount = 0;
  let lineRelationCheckCount = 0;

  for (
    let topIndex = 0;
    topIndex < horizontalLines.length - 1;
    topIndex += 1
  ) {
    const topLine = horizontalLines[topIndex];
    for (
      let bottomIndex = topIndex + 1;
      bottomIndex < horizontalLines.length;
      bottomIndex += 1
    ) {
      horizontalPairCheckCount += 1;
      if (
        horizontalPairCheckCount >
        MAXIMUM_SHARED_FRAME_HORIZONTAL_PAIR_CHECKS
      ) {
        return candidates;
      }
      const bottomLine = horizontalLines[bottomIndex];
      const top = topLine.coordinate;
      const bottom = bottomLine.coordinate;
      if (bottom - top + 1 < minimumHeight) continue;
      const sharedLeft = Math.max(topLine.start, bottomLine.start);
      const sharedRight = Math.min(topLine.end, bottomLine.end);
      if (sharedRight - sharedLeft + 1 < minimumWidth) continue;

      const spanningVerticalLines = [];
      for (const line of verticalLines) {
        lineRelationCheckCount += 1;
        if (
          lineRelationCheckCount >
          MAXIMUM_SHARED_FRAME_LINE_RELATION_CHECKS
        ) {
          return candidates;
        }
        if (
          line.coordinate >= sharedLeft - tolerance &&
          line.coordinate <= sharedRight + tolerance &&
          lineFitsInterval(line, top, bottom, tolerance)
        ) {
          spanningVerticalLines.push(line);
        }
      }
      spanningVerticalLines.sort(
        (left, right) => left.coordinate - right.coordinate,
      );
      for (
        let boundaryIndex = 0;
        boundaryIndex < spanningVerticalLines.length - 1;
        boundaryIndex += 1
      ) {
        lineRelationCheckCount += 1;
        if (
          lineRelationCheckCount >
          MAXIMUM_SHARED_FRAME_LINE_RELATION_CHECKS
        ) {
          return candidates;
        }
        const leftLine = spanningVerticalLines[boundaryIndex];
        const rightLine =
          spanningVerticalLines[boundaryIndex + 1];
        const left = leftLine.coordinate;
        const right = rightLine.coordinate;
        const candidateWidth = right - left + 1;
        const candidateHeight = bottom - top + 1;
        const aspectRatio =
          candidateWidth / Math.max(1, candidateHeight);
        if (
          candidateWidth < minimumWidth ||
          aspectRatio < 0.65 ||
          aspectRatio > 4.8 ||
          !lineFitsInterval(
            topLine,
            left,
            right,
            tolerance,
          ) ||
          !lineFitsInterval(
            bottomLine,
            left,
            right,
            tolerance,
          )
        ) {
          continue;
        }

        const endpointAlignedEdgeCount = [
          Math.abs(topLine.start - left) <= tolerance &&
            Math.abs(topLine.end - right) <= tolerance,
          Math.abs(bottomLine.start - left) <= tolerance &&
            Math.abs(bottomLine.end - right) <= tolerance,
          Math.abs(leftLine.start - top) <= tolerance &&
            Math.abs(leftLine.end - bottom) <= tolerance,
          Math.abs(rightLine.start - top) <= tolerance &&
            Math.abs(rightLine.end - bottom) <= tolerance,
        ].filter(Boolean).length;
        if (endpointAlignedEdgeCount >= 3) continue;

        // Do not combine multiple table rows or vertically stacked plots.
        // Thin grid/guide strokes are ignored; a genuine frame boundary is
        // at least two pixels thick at the processed scale.
        let hasInternalFrameBoundary = false;
        for (const line of horizontalLines) {
          lineRelationCheckCount += 1;
          if (
            lineRelationCheckCount >
            MAXIMUM_SHARED_FRAME_LINE_RELATION_CHECKS
          ) {
            return candidates;
          }
          if (
            line !== topLine &&
            line !== bottomLine &&
            line.coordinate > top + tolerance &&
            line.coordinate < bottom - tolerance &&
            lineFitsInterval(
              line,
              left,
              right,
              tolerance,
            )
          ) {
            hasInternalFrameBoundary = true;
            break;
          }
        }
        if (hasInternalFrameBoundary) continue;
        checkedCandidateCount += 1;
        if (
          checkedCandidateCount >
          MAXIMUM_SHARED_FRAME_CELL_CHECKS
        ) {
          return candidates;
        }

        const bounds = {
          left,
          top,
          right,
          bottom,
          axisMode: "rectangle",
        };
        const curveEvidence = measureChartCurveEvidence(
          bounds,
          curveEvidenceMask,
          width,
        );
        if (!curveEvidence.valid) continue;
        candidates.push({
          ...bounds,
          confidence: clamp(
            0.48 + curveEvidence.score * 0.45,
            0,
            0.94,
          ),
          detectionScale: "separation",
          detectionReason: "shared-frame-cell",
          curveEvidence,
        });
      }
    }
  }
  return candidates;
}

function area(bounds) {
  return (
    Math.max(0, bounds.right - bounds.left + 1) *
    Math.max(0, bounds.bottom - bounds.top + 1)
  );
}

function intersectionArea(first, second) {
  return (
    overlapLength(first.left, first.right, second.left, second.right) *
    overlapLength(first.top, first.bottom, second.top, second.bottom)
  );
}

function intersectionOverUnion(first, second) {
  const intersection = intersectionArea(first, second);
  return intersection / Math.max(1, area(first) + area(second) - intersection);
}

function contains(outer, inner, tolerance = 2) {
  return (
    inner.left >= outer.left - tolerance &&
    inner.top >= outer.top - tolerance &&
    inner.right <= outer.right + tolerance &&
    inner.bottom <= outer.bottom + tolerance
  );
}

function candidateEdgeEvidence(candidate, mask, width, height) {
  if (!mask) return 0;
  const supports =
    candidate.axisMode === "rectangle"
      ? [
          edgeSupport(
            mask,
            width,
            height,
            "horizontal",
            candidate.top,
            candidate.left,
            candidate.right,
          ),
          edgeSupport(
            mask,
            width,
            height,
            "horizontal",
            candidate.bottom,
            candidate.left,
            candidate.right,
          ),
          edgeSupport(
            mask,
            width,
            height,
            "vertical",
            candidate.left,
            candidate.top,
            candidate.bottom,
          ),
          edgeSupport(
            mask,
            width,
            height,
            "vertical",
            candidate.right,
            candidate.top,
            candidate.bottom,
          ),
        ]
      : [
          edgeSupport(
            mask,
            width,
            height,
            "horizontal",
            candidate.bottom,
            candidate.left,
            candidate.right,
          ),
          edgeSupport(
            mask,
            width,
            height,
            "vertical",
            candidate.left,
            candidate.top,
            candidate.bottom,
          ),
        ];
  return supports.reduce((sum, value) => sum + value, 0) / supports.length;
}

export function measureChartCurveEvidence(
  candidate,
  mask,
  width,
) {
  if (!mask) {
    return {
      valid: true,
      score: 0.5,
      horizontalCoverage: 0,
      continuousCoverage: 0,
      verticalVariation: 0,
    };
  }
  const candidateWidth = candidate.right - candidate.left + 1;
  const candidateHeight = candidate.bottom - candidate.top + 1;
  const insetX = Math.max(3, Math.round(candidateWidth * 0.045));
  const insetY = Math.max(3, Math.round(candidateHeight * 0.055));
  const left = candidate.left + insetX;
  const right = candidate.right - insetX;
  const top = candidate.top + insetY;
  const bottom = candidate.bottom - insetY;
  const interiorWidth = right - left + 1;
  const interiorHeight = bottom - top + 1;
  if (interiorWidth < 12 || interiorHeight < 10) {
    return {
      valid: false,
      score: 0,
      horizontalCoverage: 0,
      continuousCoverage: 0,
      verticalVariation: 0,
    };
  }

  const rowCounts = new Uint32Array(interiorHeight);
  const columnCounts = new Uint32Array(interiorWidth);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (!mask[y * width + x]) continue;
      rowCounts[y - top] += 1;
      columnCounts[x - left] += 1;
    }
  }
  const ignoredRows = new Uint8Array(interiorHeight);
  const ignoredColumns = new Uint8Array(interiorWidth);
  for (let row = 0; row < interiorHeight; row += 1) {
    if (rowCounts[row] / interiorWidth >= 0.34) {
      ignoredRows[row] = 1;
    }
  }
  for (let column = 0; column < interiorWidth; column += 1) {
    if (columnCounts[column] / interiorHeight >= 0.48) {
      ignoredColumns[column] = 1;
    }
  }

  const columnPixels = Array.from(
    { length: interiorWidth },
    () => [],
  );
  let residualPixels = 0;
  for (let x = left; x <= right; x += 1) {
    const localX = x - left;
    if (ignoredColumns[localX]) continue;
    for (let y = top; y <= bottom; y += 1) {
      const localY = y - top;
      if (
        ignoredRows[localY] ||
        !mask[y * width + x]
      ) {
        continue;
      }
      columnPixels[localX].push(localY);
      residualPixels += 1;
    }
  }

  const activeColumns = columnPixels.reduce(
    (count, values) => count + (values.length ? 1 : 0),
    0,
  );
  const horizontalCoverage =
    activeColumns / Math.max(1, interiorWidth);
  const meanPixelsPerActiveColumn =
    residualPixels / Math.max(1, activeColumns);
  const maximumGap = Math.max(
    2,
    Math.round(interiorWidth * 0.018),
  );
  const maximumStep = Math.max(
    4,
    Math.round(interiorHeight * 0.095),
  );
  let previousY = null;
  let gap = 0;
  let currentPath = [];
  let longestPath = [];
  for (const values of columnPixels) {
    if (!values.length) {
      gap += 1;
      if (gap > maximumGap) {
        previousY = null;
        currentPath = [];
      }
      continue;
    }
    const median = values[Math.floor(values.length / 2)];
    const selectedY =
      previousY === null
        ? median
        : values.reduce(
            (best, value) =>
              Math.abs(value - previousY) <
              Math.abs(best - previousY)
                ? value
                : best,
            values[0],
          );
    if (
      previousY !== null &&
      Math.abs(selectedY - previousY) >
        maximumStep * Math.max(1, gap + 1)
    ) {
      currentPath = [];
    }
    currentPath.push(selectedY);
    if (currentPath.length > longestPath.length) {
      longestPath = [...currentPath];
    }
    previousY = selectedY;
    gap = 0;
  }

  const continuousCoverage =
    longestPath.length / Math.max(1, interiorWidth);
  const verticalVariation = longestPath.length
    ? (Math.max(...longestPath) - Math.min(...longestPath)) /
      interiorHeight
    : 0;
  const endpointWindow = Math.max(
    2,
    Math.round(longestPath.length * 0.14),
  );
  const average = (values) =>
    values.reduce((sum, value) => sum + value, 0) /
    Math.max(1, values.length);
  const peakY = longestPath.length
    ? Math.min(...longestPath)
    : 0;
  const peakIndex = longestPath.indexOf(peakY);
  const peakPosition =
    longestPath.length > 1
      ? peakIndex / (longestPath.length - 1)
      : 0.5;
  const leftEndpointY = average(
    longestPath.slice(0, endpointWindow),
  );
  const rightEndpointY = average(
    longestPath.slice(-endpointWindow),
  );
  const peakProminence =
    longestPath.length >= 5
      ? Math.min(
          leftEndpointY - peakY,
          rightEndpointY - peakY,
        ) / interiorHeight
      : 0;
  const traceSlopes = longestPath
    .slice(1)
    .map((value, index) => value - longestPath[index]);
  const directionTolerance = Math.max(
    0.5,
    interiorHeight * 0.004,
  );
  let directionMatches = 0;
  for (let index = 0; index < traceSlopes.length; index += 1) {
    const slope = traceSlopes[index];
    const beforePeak = index < peakIndex;
    if (
      (beforePeak && slope <= directionTolerance) ||
      (!beforePeak && slope >= -directionTolerance)
    ) {
      directionMatches += 1;
    }
  }
  const singlePeakMonotonicity =
    directionMatches / Math.max(1, traceSlopes.length);
  const traceVariation = traceSlopes.reduce(
    (sum, slope) => sum + Math.abs(slope),
    0,
  );
  const expectedSinglePeakVariation = Math.max(
    0,
    leftEndpointY - peakY,
  ) + Math.max(0, rightEndpointY - peakY);
  const traceSmoothness = clamp(
    expectedSinglePeakVariation /
      Math.max(1, traceVariation),
    0,
    1,
  );
  const nearApexFraction = 0.05;
  const leftArmSpan = peakIndex;
  const rightArmSpan =
    longestPath.length - peakIndex - 1;
  const normalizedNearApexRise = (
    sampleY,
    endpointY,
  ) =>
    (sampleY - peakY) /
    Math.max(1, endpointY - peakY);
  const nearApexRises = [];
  if (leftArmSpan >= 3) {
    const sampleIndex = Math.max(
      0,
      peakIndex -
        Math.max(
          2,
          Math.round(leftArmSpan * nearApexFraction),
        ),
    );
    nearApexRises.push(
      normalizedNearApexRise(
        longestPath[sampleIndex],
        leftEndpointY,
      ),
    );
  }
  if (rightArmSpan >= 3) {
    const sampleIndex = Math.min(
      longestPath.length - 1,
      peakIndex +
        Math.max(
          2,
          Math.round(rightArmSpan * nearApexFraction),
        ),
    );
    nearApexRises.push(
      normalizedNearApexRise(
        longestPath[sampleIndex],
        rightEndpointY,
      ),
    );
  }
  const nearApexRiseRatio = average(nearApexRises);
  // A rounded density maximum stays materially flatter than a straight-sided
  // chevron over the first part of each arm. Normalize by endpoint height so
  // the score remains comparable across chart sizes and log-scale ranges.
  const roundedApexScore = clamp(
    1 -
      nearApexRiseRatio /
        nearApexFraction,
    0,
    1,
  );
  const residualDensity =
    residualPixels /
    Math.max(1, interiorWidth * interiorHeight);
  const thinEnough =
    meanPixelsPerActiveColumn <=
      Math.max(9, interiorHeight * 0.2) &&
    residualDensity <= 0.24;
  const coherentTrace =
    continuousCoverage >= 0.2 ||
    (horizontalCoverage >= 0.58 &&
      verticalVariation >= 0.2);
  const baseSinglePeakShape =
    horizontalCoverage >= 0.2 &&
    continuousCoverage >= 0.18 &&
    verticalVariation >= 0.12 &&
    peakPosition >= 0.12 &&
    peakPosition <= 0.88 &&
    peakProminence >= 0.075 &&
    thinEnough;
  const logScaleParabolicPeak =
    baseSinglePeakShape &&
    singlePeakMonotonicity >= 0.97 &&
    traceSmoothness >= 0.68 &&
    roundedApexScore >= 0.45;
  const smoothSinglePeakShape =
    baseSinglePeakShape &&
    ((singlePeakMonotonicity >= 0.82 &&
      traceSmoothness >= 0.92 &&
      roundedApexScore >= 0.1) ||
      logScaleParabolicPeak);
  // A single-state plot can occupy only the middle of a wide axis. Requiring
  // the same full-width coverage as a multi-State chain drops these otherwise
  // valid charts, especially on PPT slides. Keep a localized trace only when
  // it has a clear rounded apex, stable falling tails on both sides and little
  // excess vertical motion. Sharp chevrons/checkmarks can have the same span
  // and prominence but do not flatten around their apex.
  const localizedSinglePeak = smoothSinglePeakShape;
  const sharpSinglePeakArtifact =
    baseSinglePeakShape &&
    singlePeakMonotonicity >= 0.9 &&
    traceSmoothness >= 0.75 &&
    !smoothSinglePeakShape;
  // Some dense V-NAND plots use broad, highly overlapping States. Their
  // salient-color mask contains several short peak arcs instead of one path
  // spanning 20% of the frame, even though those arcs cover most x columns
  // and vary coherently in y. Admit that segmented shallow trace only inside
  // a geometric frame/axis; frameless text, photos and connectors retain the
  // stricter continuity requirement.
  const segmentedShallowTrace =
    candidate.axisMode !== "content" &&
    horizontalCoverage >= 0.62 &&
    continuousCoverage >= 0.08 &&
    verticalVariation >= 0.08 &&
    residualDensity <= 0.1 &&
    thinEnough &&
    !sharpSinglePeakArtifact;
  const fullWidthTrace =
    (horizontalCoverage >= 0.42 &&
      coherentTrace &&
      verticalVariation >= 0.045 &&
      thinEnough &&
      !sharpSinglePeakArtifact) ||
    segmentedShallowTrace;
  const valid = fullWidthTrace || localizedSinglePeak;
  const score = clamp(
    horizontalCoverage * 0.34 +
      continuousCoverage * 0.38 +
      Math.min(1, verticalVariation * 3.2) * 0.2 +
      (thinEnough ? 0.08 : 0) +
      (localizedSinglePeak ? 0.1 : 0),
    0,
    1,
  );
  return {
    valid,
    score,
    horizontalCoverage,
    continuousCoverage,
    verticalVariation,
    localizedSinglePeak,
    logScaleParabolicPeak,
    fullWidthTrace,
    segmentedShallowTrace,
    peakPosition,
    peakProminence,
    singlePeakMonotonicity,
    traceSmoothness,
    roundedApexScore,
    thinEnough,
    residualDensity,
    meanPixelsPerActiveColumn,
  };
}

function looksLikePlotFrameInsideCard(outer, inner) {
  if (
    outer.axisMode !== "rectangle" ||
    inner.axisMode !== "rectangle" ||
    !contains(outer, inner)
  ) {
    return false;
  }
  const outerWidth = outer.right - outer.left + 1;
  const outerHeight = outer.bottom - outer.top + 1;
  const innerWidth = inner.right - inner.left + 1;
  const innerHeight = inner.bottom - inner.top + 1;
  const topInset = inner.top - outer.top;
  const bottomInset = outer.bottom - inner.bottom;

  return (
    // A real PPT plot occupies most of its surrounding card. Grid cells are
    // materially smaller in at least one dimension.
    area(inner) / Math.max(1, area(outer)) >= 0.5 &&
    innerWidth / outerWidth >= 0.78 &&
    innerHeight / outerHeight >= 0.58 &&
    // Cards reserve a title/legend band above the plot and a smaller footer
    // margin below it. Requiring that asymmetry prevents a pale plot frame
    // with dark full-span grid lines from being mistaken for a chart card.
    topInset >= outerHeight * 0.08 &&
    bottomInset >= outerHeight * 0.03 &&
    topInset - bottomInset >= outerHeight * 0.025
  );
}

function clearSeparationGutter(
  first,
  second,
  mask,
  width,
  height,
) {
  const minimumGutter = Math.max(
    1,
    Math.round(Math.min(width, height) * 0.001),
  );
  const measureRegion = (left, top, right, bottom) => {
    if (right < left || bottom < top) return 1;
    const regionWidth = right - left + 1;
    const regionHeight = bottom - top + 1;
    const step = Math.max(
      1,
      Math.ceil(
        Math.sqrt(
          (regionWidth * regionHeight) / 4_000,
        ),
      ),
    );
    let active = 0;
    let pixels = 0;
    for (let y = top; y <= bottom; y += step) {
      for (let x = left; x <= right; x += step) {
        active += mask[y * width + x] ? 1 : 0;
        pixels += 1;
      }
    }
    return active / Math.max(1, pixels);
  };
  const verticalOverlap = overlapLength(
    first.top,
    first.bottom,
    second.top,
    second.bottom,
  );
  const horizontalOverlap = overlapLength(
    first.left,
    first.right,
    second.left,
    second.right,
  );
  if (
    first.right + minimumGutter < second.left &&
    verticalOverlap >=
      Math.min(
        first.bottom - first.top + 1,
        second.bottom - second.top + 1,
      ) *
        0.35
  ) {
    return (
      measureRegion(
        first.right + 1,
        Math.max(first.top, second.top),
        second.left - 1,
        Math.min(first.bottom, second.bottom),
      ) <= 0.025
    );
  }
  if (
    second.right + minimumGutter < first.left &&
    verticalOverlap >=
      Math.min(
        first.bottom - first.top + 1,
        second.bottom - second.top + 1,
      ) *
        0.35
  ) {
    return clearSeparationGutter(
      second,
      first,
      mask,
      width,
      height,
    );
  }
  if (
    first.bottom + minimumGutter < second.top &&
    horizontalOverlap >=
      Math.min(
        first.right - first.left + 1,
        second.right - second.left + 1,
      ) *
        0.35
  ) {
    return (
      measureRegion(
        Math.max(first.left, second.left),
        first.bottom + 1,
        Math.min(first.right, second.right),
        second.top - 1,
      ) <= 0.025
    );
  }
  if (
    second.bottom + minimumGutter < first.top &&
    horizontalOverlap >=
      Math.min(
        first.right - first.left + 1,
        second.right - second.left + 1,
      ) *
        0.35
  ) {
    return clearSeparationGutter(
      second,
      first,
      mask,
      width,
      height,
    );
  }
  return false;
}

function removeCompositeContainers(
  candidates,
  curveEvidenceMask,
  separationEvidenceMask,
  width,
  height,
  compactMinimumAreaRatio,
) {
  if (!curveEvidenceMask || candidates.length < 3) {
    return candidates;
  }
  const compositeContainers = new Set();
  // A dense table can generate tens of thousands of valid geometric
  // sub-rectangles. Scanning that entire set once for every possible outer
  // rectangle is quadratic and can stall both the browser and API worker.
  // Composite chart cards are necessarily among the largest strict frames, so
  // sort once and bound only the set of possible containers. Every selected
  // container can still inspect the complete candidate set for its children.
  const candidatesByArea = [...candidates].sort(
    (left, right) => area(right) - area(left),
  );
  const possibleContainers = candidatesByArea
    .filter(
      (candidate) =>
        candidate.detectionScale === "strict" &&
        area(candidate) >= width * height * 0.035,
    )
    .slice(0, MAXIMUM_COMPOSITE_CONTAINER_CHECKS);
  const isStrongIndependentChild = (candidate, evidence) => {
    const minimumAreaRatio =
      candidate.axisMode === "l-axis"
        ? Math.max(
            compactMinimumAreaRatio,
            COMPACT_MINIMUM_OPEN_AXIS_PANEL_AREA_RATIO,
          )
        : compactMinimumAreaRatio;
    return (
      evidence.valid &&
      candidate.edgeEvidence >= 0.68 &&
      area(candidate) >= width * height * minimumAreaRatio &&
      (!evidence.localizedSinglePeak ||
        (evidence.singlePeakMonotonicity >= 0.82 &&
          evidence.traceSmoothness >= 0.92 &&
          evidence.roundedApexScore >= 0.1))
    );
  };
  for (const outer of possibleContainers) {
    const outerArea = area(outer);
    const inset = Math.max(
      4,
      Math.round(
        Math.min(
          outer.right - outer.left + 1,
          outer.bottom - outer.top + 1,
        ) * 0.012,
      ),
    );
    const children = [];
    for (const inner of candidatesByArea) {
      if (children.length >= MAXIMUM_COMPOSITE_CHILDREN) {
        break;
      }
      if (
        inner === outer ||
        !contains(outer, inner, 1) ||
        inner.left - outer.left < inset ||
        inner.top - outer.top < inset ||
        outer.right - inner.right < inset ||
        outer.bottom - inner.bottom < inset
      ) {
        continue;
      }
      const areaRatio = area(inner) / Math.max(1, outerArea);
      if (areaRatio >= 0.025 && areaRatio <= 0.72) {
        children.push(inner);
      }
    }
    const strongChildCount = children.reduce(
      (count, child) => {
        const evidence =
          child.curveEvidence ??
          measureChartCurveEvidence(
            child,
            curveEvidenceMask,
            width,
          );
        child.curveEvidence = evidence;
        return (
          count +
          (isStrongIndependentChild(child, evidence) ? 1 : 0)
        );
      },
      0,
    );
    for (
      let firstIndex = 0;
      firstIndex < children.length - 1;
      firstIndex += 1
    ) {
      const first = children[firstIndex];
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < children.length;
        secondIndex += 1
      ) {
        const second = children[secondIndex];
        if (
          intersectionArea(first, second) > 0 ||
          !clearSeparationGutter(
            first,
            second,
            separationEvidenceMask ?? curveEvidenceMask,
            width,
            height,
          )
        ) {
          continue;
        }
        const firstEvidence =
          first.curveEvidence ??
          measureChartCurveEvidence(
            first,
            curveEvidenceMask,
            width,
        );
        first.curveEvidence = firstEvidence;
        if (!isStrongIndependentChild(first, firstEvidence)) {
          continue;
        }
        const secondEvidence =
          second.curveEvidence ??
          measureChartCurveEvidence(
            second,
            curveEvidenceMask,
            width,
          );
        second.curveEvidence = secondEvidence;
        if (
          isStrongIndependentChild(second, secondEvidence) &&
          ((area(first) + area(second)) / outerArea >= 0.12 ||
            (strongChildCount >= 4 &&
              (area(first) + area(second)) / outerArea >=
                0.04))
        ) {
          compositeContainers.add(outer);
          break;
        }
      }
      if (compositeContainers.has(outer)) break;
    }
  }
  return candidates.filter(
    (candidate) => !compositeContainers.has(candidate),
  );
}

function removeDuplicateAndGridCandidates(
  candidates,
  edgeEvidenceMask,
  curveEvidenceMask,
  separationEvidenceMask,
  width,
  height,
  compactMinimumAreaRatio,
) {
  const uniqueCandidates = new Map();
  for (const candidate of candidates) {
    const key = [
      candidate.axisMode,
      candidate.left,
      candidate.top,
      candidate.right,
      candidate.bottom,
    ].join(":");
    const existing = uniqueCandidates.get(key);
    if (
      !existing ||
      (candidate.detectionReason === "shared-frame-cell" &&
        existing.detectionReason !== "shared-frame-cell") ||
      (candidate.detectionScale === "strict" &&
        existing.detectionScale !== "strict" &&
        existing.detectionReason !== "shared-frame-cell")
    ) {
      uniqueCandidates.set(key, candidate);
    }
  }
  const withEdgeEvidence = removeCompositeContainers(
    [...uniqueCandidates.values()].map((candidate) => ({
      ...candidate,
      edgeEvidence: candidateEdgeEvidence(
        candidate,
        edgeEvidenceMask,
        width,
        height,
      ),
    })),
    curveEvidenceMask,
    separationEvidenceMask,
    width,
    height,
    compactMinimumAreaRatio,
  );
  const rectangles = withEdgeEvidence.filter(
    (candidate) => candidate.axisMode === "rectangle",
  );
  const withoutRectangleDerivedLAxes = withEdgeEvidence.filter(
    (candidate) =>
      candidate.axisMode !== "l-axis" ||
      !rectangles.some(
        (rectangle) =>
          intersectionOverUnion(rectangle, candidate) >= 0.68,
      ),
  );
  const ranked = [...withoutRectangleDerivedLAxes].sort(
    (left, right) => {
      // Exact-gutter candidates must win over a tolerant full-row/full-slide
      // frame synthesized by proportional line-gap bridging. Exact duplicate
      // bounds have already preferred the strict hypothesis above, so this
      // priority affects only genuinely different dense-panel boundaries.
      const leftSeparation =
        left.detectionScale === "separation";
      const rightSeparation =
        right.detectionScale === "separation";
      const leftPriority =
        (left.detectionReason === "shared-frame-cell" ? 3 : 0) +
        (leftSeparation ? 2 : 0) +
        (left.detectionScale === "strict" ? 1 : 0);
      const rightPriority =
        (right.detectionReason === "shared-frame-cell" ? 3 : 0) +
        (rightSeparation ? 2 : 0) +
        (right.detectionScale === "strict" ? 1 : 0);
      return (
        rightPriority - leftPriority ||
        (leftSeparation && rightSeparation
          ? area(left) - area(right)
          : area(right) - area(left)) ||
        (right.axisMode === "rectangle") -
          (left.axisMode === "rectangle") ||
        right.confidence - left.confidence ||
        left.top - right.top ||
        left.left - right.left
      );
    },
  );
  const kept = [];
  const suppressionEnvelopes = [];
  for (const candidate of ranked) {
    // Once a decorative card is replaced by its actual plot frame, retain the
    // card only as a duplicate-suppression envelope. Otherwise grid cells and
    // legend boxes that were contained by the discarded card can leak out as
    // additional chart panels.
    if (
      suppressionEnvelopes.some((envelope) =>
        contains(envelope, candidate),
      )
    ) {
      continue;
    }
    const duplicateIndex = kept.findIndex(
      (existing) =>
        intersectionOverUnion(existing, candidate) >= 0.72 ||
        contains(existing, candidate) ||
        contains(candidate, existing),
    );
    if (duplicateIndex >= 0) {
      const existing = kept[duplicateIndex];
      const nested =
        contains(existing, candidate) || contains(candidate, existing);
      const candidateIsInner = contains(existing, candidate);
      const substantiallyMoreSalient =
        candidate.edgeEvidence >= existing.edgeEvidence + 0.22 &&
        candidate.edgeEvidence >= 0.62;
      // PPT chart cards frequently have a pale decorative rectangle around a
      // much darker plot frame. The broad foreground mask sees both, while the
      // salience mask strongly supports only the actual axes. In that narrow
      // nested-frame case retain the inner plot so downstream Curve extraction
      // does not ingest the title, legend and tick labels.
      if (
        nested &&
        candidateIsInner &&
        substantiallyMoreSalient &&
        looksLikePlotFrameInsideCard(existing, candidate)
      ) {
        suppressionEnvelopes.push(existing);
        kept[duplicateIndex] = candidate;
      }
      continue;
    }
    // The public contract deliberately returns non-overlapping panels. Inset
    // charts are ambiguous without semantic OCR, so the stronger outer plot is
    // retained instead of emitting two crops containing the same pixels.
    if (
      kept.some(
        (existing) =>
          intersectionArea(existing, candidate) >
          Math.min(area(existing), area(candidate)) * 0.02,
      )
    ) {
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}

function paddedNonOverlappingCandidates(candidates, width, height) {
  const expanded = candidates.map((candidate) => {
    const padding = clamp(
      Math.round(
        Math.min(
          candidate.right - candidate.left + 1,
          candidate.bottom - candidate.top + 1,
        ) * 0.018,
      ),
      2,
      8,
    );
    return {
      ...candidate,
      originalLeft: candidate.left,
      originalTop: candidate.top,
      originalRight: candidate.right,
      originalBottom: candidate.bottom,
      left: Math.max(0, candidate.left - padding),
      top: Math.max(0, candidate.top - padding),
      right: Math.min(width - 1, candidate.right + padding),
      bottom: Math.min(height - 1, candidate.bottom + padding),
    };
  });

  for (let firstIndex = 0; firstIndex < expanded.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < expanded.length;
      secondIndex += 1
    ) {
      const first = expanded[firstIndex];
      const second = expanded[secondIndex];
      if (!intersectionArea(first, second)) continue;
      if (first.originalRight < second.originalLeft) {
        const divide = Math.floor(
          (first.originalRight + second.originalLeft) / 2,
        );
        first.right = Math.min(first.right, divide);
        second.left = Math.max(second.left, divide + 1);
      } else if (second.originalRight < first.originalLeft) {
        const divide = Math.floor(
          (second.originalRight + first.originalLeft) / 2,
        );
        second.right = Math.min(second.right, divide);
        first.left = Math.max(first.left, divide + 1);
      } else if (first.originalBottom < second.originalTop) {
        const divide = Math.floor(
          (first.originalBottom + second.originalTop) / 2,
        );
        first.bottom = Math.min(first.bottom, divide);
        second.top = Math.max(second.top, divide + 1);
      } else if (second.originalBottom < first.originalTop) {
        const divide = Math.floor(
          (second.originalBottom + first.originalTop) / 2,
        );
        second.bottom = Math.min(second.bottom, divide);
        first.top = Math.max(first.top, divide + 1);
      }
    }
  }
  return expanded;
}

function orderAndDescribePanels(candidates, width, height) {
  const pending = paddedNonOverlappingCandidates(
    candidates,
    width,
    height,
  ).sort(
    (left, right) => left.top - right.top || left.left - right.left,
  );
  const rows = [];
  for (const candidate of pending) {
    const candidateCenter = (candidate.top + candidate.bottom) / 2;
    let bestRow = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const rowCenter =
        row.items.reduce(
          (sum, item) => sum + (item.top + item.bottom) / 2,
          0,
        ) / row.items.length;
      const typicalHeight =
        row.items.reduce(
          (sum, item) => sum + item.bottom - item.top + 1,
          0,
        ) / row.items.length;
      const distance = Math.abs(candidateCenter - rowCenter);
      if (
        distance <=
          Math.max(
            typicalHeight,
            candidate.bottom - candidate.top + 1,
          ) *
            0.38 &&
        distance < bestDistance
      ) {
        bestRow = row;
        bestDistance = distance;
      }
    }
    if (bestRow) bestRow.items.push(candidate);
    else rows.push({ items: [candidate] });
  }
  rows.sort(
    (left, right) =>
      Math.min(...left.items.map((item) => item.top)) -
      Math.min(...right.items.map((item) => item.top)),
  );
  const ordered = rows.flatMap((row) =>
    row.items.sort(
      (left, right) => left.left - right.left || left.top - right.top,
    ),
  );
  const panels = ordered.map((candidate, index) => {
    const x = clamp(Math.round(candidate.left), 0, width - 1);
    const y = clamp(Math.round(candidate.top), 0, height - 1);
    const right = clamp(Math.round(candidate.right), x, width - 1);
    const bottom = clamp(Math.round(candidate.bottom), y, height - 1);
    return {
      index,
      left: x,
      top: y,
      right,
      bottom,
      x,
      y,
      width: right - x + 1,
      height: bottom - y + 1,
      confidence: Number(candidate.confidence.toFixed(4)),
      detectionReason: candidate.detectionReason,
      mode: candidate.axisMode,
      axisMode: candidate.axisMode,
    };
  });
  return {
    panels,
    layout: {
      rows: rows.length,
      columns: Math.max(1, ...rows.map((row) => row.items.length)),
    },
  };
}

function selectHighestQualityPanels(candidates, width, height) {
  if (candidates.length <= MAXIMUM_CHART_PANELS) {
    return candidates;
  }
  // The detector can see many credible rectangles in a diagram-heavy slide.
  // Bound downstream crop/embedding work while retaining the strongest plot
  // frames; orderAndDescribePanels restores reading order after this ranking.
  return [...candidates]
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        area(right) / (width * height) -
          area(left) / (width * height) ||
        left.top - right.top ||
        left.left - right.left,
    )
    .slice(0, MAXIMUM_CHART_PANELS);
}

function detectGeometricCandidatesAtScale(
  mask,
  width,
  height,
  minimumWidth,
  minimumHeight,
  detectionScale,
  maximumLineScanGap,
) {
  const horizontalLines = extractLineBands(
    mask,
    width,
    height,
    "horizontal",
    minimumWidth,
    maximumLineScanGap,
  );
  const verticalLines = extractLineBands(
    mask,
    width,
    height,
    "vertical",
    minimumHeight,
    maximumLineScanGap,
  );
  return [
    ...detectRectangleCandidates(
      mask,
      width,
      height,
      horizontalLines,
      verticalLines,
      minimumWidth,
      minimumHeight,
    ),
    ...detectLAxisCandidates(
      mask,
      width,
      height,
      horizontalLines,
      verticalLines,
      minimumWidth,
      minimumHeight,
    ),
  ].map((candidate) => ({
    ...candidate,
    detectionScale,
  }));
}

function mergeCurveColorMasks(curveColorMasks, width, height) {
  if (!Array.isArray(curveColorMasks) || !curveColorMasks.length) {
    return null;
  }
  const merged = new Uint8Array(width * height);
  let active = 0;
  for (const colorMask of curveColorMasks) {
    if (!colorMask || colorMask.length < merged.length) continue;
    for (let index = 0; index < merged.length; index += 1) {
      if (!colorMask[index] || merged[index]) continue;
      merged[index] = 1;
      active += 1;
    }
  }
  return active >= Math.max(24, width * height * 0.000025)
    ? merged
    : null;
}

function extractFramelessCurveCandidates(
  mask,
  width,
  height,
  source,
) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const columnStamp = new Uint32Array(width);
  const minimumWidth = Math.max(18, Math.round(width * 0.018));
  const minimumHeight = Math.max(8, Math.round(height * 0.015));
  const minimumInk = Math.max(
    18,
    Math.round(width * height * 0.000018),
  );
  const candidates = [];
  let rejectedComponentCount = 0;
  let componentId = 0;

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    componentId += 1;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    let left = start % width;
    let right = left;
    let top = Math.floor(start / width);
    let bottom = top;
    let pixelCount = 0;
    let occupiedColumnCount = 0;

    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      pixelCount += 1;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      if (columnStamp[x] !== componentId) {
        columnStamp[x] = componentId;
        occupiedColumnCount += 1;
      }

      for (
        let neighborY = Math.max(0, y - 1);
        neighborY <= Math.min(height - 1, y + 1);
        neighborY += 1
      ) {
        for (
          let neighborX = Math.max(0, x - 1);
          neighborX <= Math.min(width - 1, x + 1);
          neighborX += 1
        ) {
          const neighborIndex = neighborY * width + neighborX;
          if (
            neighborIndex === index ||
            !mask[neighborIndex] ||
            visited[neighborIndex]
          ) {
            continue;
          }
          visited[neighborIndex] = 1;
          queue[tail] = neighborIndex;
          tail += 1;
        }
      }
    }

    const componentWidth = right - left + 1;
    const componentHeight = bottom - top + 1;
    if (
      componentWidth < minimumWidth ||
      componentHeight < minimumHeight ||
      pixelCount < minimumInk
    ) {
      continue;
    }
    const columnContinuity =
      occupiedColumnCount / Math.max(1, componentWidth);
    const averageInkPerColumn =
      pixelCount / Math.max(1, occupiedColumnCount);
    const density =
      pixelCount /
      Math.max(1, componentWidth * componentHeight);
    if (
      columnContinuity < 0.45 ||
      averageInkPerColumn >
        Math.max(9, componentHeight * 0.22) ||
      density > 0.24 ||
      componentWidth / componentHeight < 0.65
    ) {
      rejectedComponentCount += 1;
      continue;
    }

    // Measure with vertical breathing room so the log-scale tails are not
    // removed by the normal interior inset. Keep horizontal padding narrow:
    // two unrelated PPT charts can have only a few blank pixels between them.
    const horizontalPadding = clamp(
      Math.round(componentWidth * 0.02),
      3,
      8,
    );
    const verticalPadding = clamp(
      Math.round(componentHeight * 0.12),
      4,
      Math.max(4, Math.round(height * 0.025)),
    );
    const measurementBounds = {
      left: Math.max(0, left - horizontalPadding),
      top: Math.max(0, top - verticalPadding),
      right: Math.min(width - 1, right + horizontalPadding),
      bottom: Math.min(height - 1, bottom + verticalPadding),
      axisMode: "content",
    };
    const curveEvidence = measureChartCurveEvidence(
      measurementBounds,
      mask,
      width,
    );
    const roundedPeak =
      !curveEvidence.localizedSinglePeak ||
      curveEvidence.logScaleParabolicPeak ||
      (curveEvidence.singlePeakMonotonicity >= 0.82 &&
        curveEvidence.traceSmoothness >= 0.92 &&
        curveEvidence.roundedApexScore >= 0.1);
    const validShape =
      curveEvidence.valid &&
      curveEvidence.horizontalCoverage >= 0.35 &&
      curveEvidence.continuousCoverage >= 0.3 &&
      curveEvidence.verticalVariation >= 0.08 &&
      curveEvidence.peakPosition >= 0.06 &&
      curveEvidence.peakPosition <= 0.94 &&
      curveEvidence.peakProminence >= 0.055 &&
      curveEvidence.score >= 0.48 &&
      roundedPeak;
    if (!validShape) {
      rejectedComponentCount += 1;
      continue;
    }
    candidates.push({
      left,
      top,
      right,
      bottom,
      confidence: clamp(
        0.45 +
          curveEvidence.score * 0.46 +
          (source === "color" ? 0.04 : 0),
        0,
        0.96,
      ),
      axisMode: "content",
      detectionScale: "content",
      detectionReason: "frameless-curve-region",
      curveEvidence,
      curveSource: source,
    });
  }

  return { candidates, rejectedComponentCount };
}

function detectFramelessCurveCandidates(
  curveEvidenceMask,
  curveColorMasks,
  width,
  height,
) {
  if (!curveEvidenceMask) {
    return { candidates: [], rejectedComponentCount: 0 };
  }
  const hypotheses = [
    extractFramelessCurveCandidates(
      curveEvidenceMask,
      width,
      height,
      "salience",
    ),
  ];
  const colorMask = mergeCurveColorMasks(
    curveColorMasks,
    width,
    height,
  );
  if (colorMask) {
    hypotheses.push(
      extractFramelessCurveCandidates(
        colorMask,
        width,
        height,
        "color",
      ),
    );
  }

  // The broader salience hypothesis comes first. It normally joins adjacent
  // coloured State segments into one distribution, while the colour-only
  // hypothesis can still recover a Curve that was connected to a dark axis,
  // label or guide in the broad mask.
  const ranked = hypotheses
    .flatMap((hypothesis) => hypothesis.candidates)
    .sort(
      (left, right) =>
        (right.curveSource === "salience") -
          (left.curveSource === "salience") ||
        area(right) - area(left) ||
        right.confidence - left.confidence,
    );
  const candidates = [];
  for (const candidate of ranked) {
    if (
      candidates.some(
        (existing) =>
          intersectionOverUnion(existing, candidate) >= 0.58 ||
          contains(existing, candidate, 4) ||
          contains(candidate, existing, 4),
      )
    ) {
      continue;
    }
    candidates.push(candidate);
  }

  // One unframed Curve is already handled correctly by whole-image fallback.
  // Requiring two independent regions prevents a logo, arrow or formula from
  // turning an ordinary single-chart upload into multiple panels.
  if (candidates.length < 2) {
    return { candidates: [], rejectedComponentCount: 0 };
  }
  return {
    candidates,
    rejectedComponentCount: Math.min(
      99,
      Math.max(
        ...hypotheses.map(
          (hypothesis) => hypothesis.rejectedComponentCount,
        ),
      ),
    ),
  };
}

/**
 * Detect independent chart panels from a precomputed foreground mask.
 *
 * The mask-level API is useful when the caller already shares preprocessing
 * with the VTH analysis pipeline. Bounds include the detected axes/frame so a
 * subsequent per-panel analysis can perform its usual axis removal.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {{
 *   minimumPanelAreaRatio?: number;
 *   minimumPanelWidthRatio?: number;
 *   minimumPanelHeightRatio?: number;
 *   compactMinimumPanelAreaRatio?: number;
 *   compactMinimumPanelWidthRatio?: number;
 *   compactMinimumPanelHeightRatio?: number;
 *   fallbackToWholeImage?: boolean;
 *   edgeEvidenceMask?: Uint8Array;
 *   curveEvidenceMask?: Uint8Array;
 *   curveColorMasks?: Uint8Array[];
 *   recoverLowResolution?: boolean;
 *   maximumLineGap?: number;
 * }} [options]
 */
export function detectChartPanelsFromMask(
  mask,
  width,
  height,
  options = {},
) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    mask.length < width * height
  ) {
    throw new Error("패널 검출용 이미지 크기 또는 마스크가 올바르지 않습니다.");
  }
  const minimumAreaRatio =
    options.minimumPanelAreaRatio ??
    DEFAULT_MINIMUM_PANEL_AREA_RATIO;
  const minimumWidthRatio =
    options.minimumPanelWidthRatio ??
    DEFAULT_MINIMUM_PANEL_WIDTH_RATIO;
  const minimumHeightRatio =
    options.minimumPanelHeightRatio ??
    DEFAULT_MINIMUM_PANEL_HEIGHT_RATIO;
  const minimumWidth = Math.max(
    20,
    Math.round(width * minimumWidthRatio),
  );
  const minimumHeight = Math.max(
    16,
    Math.round(height * minimumHeightRatio),
  );
  const compactMinimumAreaRatio =
    options.compactMinimumPanelAreaRatio ??
    Math.min(
      minimumAreaRatio,
      COMPACT_MINIMUM_PANEL_AREA_RATIO,
    );
  const compactMinimumWidth = Math.max(
    16,
    Math.round(
      width *
        (options.compactMinimumPanelWidthRatio ??
          Math.min(
            minimumWidthRatio,
            COMPACT_MINIMUM_PANEL_WIDTH_RATIO,
          )),
    ),
  );
  const compactMinimumHeight = Math.max(
    12,
    Math.round(
      height *
        (options.compactMinimumPanelHeightRatio ??
          Math.min(
            minimumHeightRatio,
            COMPACT_MINIMUM_PANEL_HEIGHT_RATIO,
          )),
    ),
  );
  const recovered =
    options.recoverLowResolution === false
      ? {
          mask,
          maximumGap: 0,
          repairedPixelCount: 0,
        }
      : repairLowResolutionLineMask(mask, width, height, {
          maximumGap: options.maximumLineGap,
        });
  const workingMask = recovered.mask;
  const edgeEvidenceMask = options.edgeEvidenceMask
    ? repairLowResolutionLineMask(
        options.edgeEvidenceMask,
        width,
        height,
        {
          maximumGap: Math.max(2, recovered.maximumGap - 1),
        },
      ).mask
    : undefined;
  const strictCandidates = detectGeometricCandidatesAtScale(
    workingMask,
    width,
    height,
    minimumWidth,
    minimumHeight,
    "strict",
  );
  const compactCandidates =
    compactMinimumWidth < minimumWidth ||
    compactMinimumHeight < minimumHeight
      ? detectGeometricCandidatesAtScale(
          workingMask,
          width,
          height,
          compactMinimumWidth,
          compactMinimumHeight,
          "compact",
        )
      : [];
  // A repaired or anti-aliased line hypothesis is intentionally tolerant of
  // short gaps within an axis. At FHD, however, its proportional scan gap can
  // also bridge the 1–12 px gutters between aligned plots in a dense 6 × 5
  // slide. Scan the original mask once more at the compact size with no gap
  // bridging. These candidates preserve true panel boundaries while the
  // tolerant hypotheses above continue to recover broken low-resolution axes.
  const separationCandidates =
    detectGeometricCandidatesAtScale(
      mask,
      width,
      height,
      compactMinimumWidth,
      compactMinimumHeight,
      "separation",
      0,
    );
  const curveEvidenceMask =
    options.curveEvidenceMask ??
    edgeEvidenceMask ??
    workingMask;
  const sharedFrameCellCandidates =
    detectSharedFrameCellCandidates(
      mask,
      curveEvidenceMask,
      width,
      height,
      compactMinimumWidth,
      compactMinimumHeight,
    );
  // Exact-gap and shared-frame hypotheses are intentionally permissive
  // because their job is to split dense slide layouts. Activating them for a
  // lone card would also promote a chevron or a few dark grid cells. Require
  // repeated panel structure; ordinary one-to-five chart uploads continue to
  // use the stricter geometric and frameless paths above.
  const denseSeparationDetected =
    separationCandidates.length >=
      MINIMUM_DENSE_SEPARATION_CANDIDATES ||
    sharedFrameCellCandidates.length >=
      MINIMUM_DENSE_SEPARATION_CANDIDATES;
  const retainedSeparationCandidates =
    denseSeparationDetected ? separationCandidates : [];
  const retainedSharedFrameCellCandidates =
    sharedFrameCellCandidates.length >=
    MINIMUM_DENSE_SEPARATION_CANDIDATES
      ? sharedFrameCellCandidates
      : [];
  const framelessDetection = detectFramelessCurveCandidates(
    curveEvidenceMask,
    options.curveColorMasks,
    width,
    height,
  );
  const geometricCandidates = removeDuplicateAndGridCandidates(
    [
      ...strictCandidates,
      ...compactCandidates,
      ...retainedSeparationCandidates,
      ...retainedSharedFrameCellCandidates,
      ...framelessDetection.candidates,
    ],
    edgeEvidenceMask ?? workingMask,
    curveEvidenceMask,
    options.curveEvidenceMask ??
      options.edgeEvidenceMask ??
      mask,
    width,
    height,
    compactMinimumAreaRatio,
  );
  const measuredCandidates = geometricCandidates.map((candidate) => {
    const curveEvidence =
      candidate.curveEvidence ??
      measureChartCurveEvidence(
        candidate,
        curveEvidenceMask,
        width,
      );
    return {
      ...candidate,
      confidence: clamp(
        candidate.confidence * 0.82 +
          curveEvidence.score * 0.18,
        0,
        0.99,
      ),
      curveEvidence,
    };
  });
  const geometricRejectedNonChartCount = measuredCandidates.reduce(
    (count, candidate) =>
      count + (candidate.curveEvidence.valid ? 0 : 1),
    0,
  );
  const candidates = measuredCandidates.filter(
    (candidate) => {
      const candidateAreaRatio =
        area(candidate) / Math.max(1, width * height);
      const strictMinimumCandidateAreaRatio =
        candidate.axisMode === "l-axis"
          ? Math.max(
              minimumAreaRatio,
              MINIMUM_OPEN_AXIS_PANEL_AREA_RATIO,
            )
          : minimumAreaRatio;
      const compact =
        candidate.detectionScale === "compact" ||
        (candidate.detectionScale === "separation" &&
          (candidate.right - candidate.left + 1 <
            minimumWidth ||
            candidate.bottom - candidate.top + 1 <
              minimumHeight)) ||
        candidateAreaRatio <
          strictMinimumCandidateAreaRatio;
      const areaRatio = compact
        ? compactMinimumAreaRatio
        : minimumAreaRatio;
      const minimumCandidateAreaRatio =
        candidate.axisMode === "l-axis"
          ? Math.max(
              areaRatio,
              compact
                ? COMPACT_MINIMUM_OPEN_AXIS_PANEL_AREA_RATIO
                : MINIMUM_OPEN_AXIS_PANEL_AREA_RATIO,
            )
          : areaRatio;
      return (
        candidate.curveEvidence.valid &&
        area(candidate) >=
          width * height * minimumCandidateAreaRatio
      );
    },
  );
  const framelessUsed = candidates.some(
    (candidate) =>
      candidate.detectionReason === "frameless-curve-region",
  );
  const rejectedNonChartCount =
    geometricRejectedNonChartCount +
    (framelessUsed
      ? framelessDetection.rejectedComponentCount
      : 0);

  if (!candidates.length && options.fallbackToWholeImage !== false) {
    return {
      panels: [
        {
          index: 0,
          left: 0,
          top: 0,
          right: width - 1,
          bottom: height - 1,
          x: 0,
          y: 0,
          width,
          height,
          confidence: 0.2,
          detectionReason: "whole-image-fallback",
          mode: "content",
          axisMode: "content",
        },
      ],
      layout: { rows: 1, columns: 1 },
      fallbackUsed: true,
      detectedPanelCount: 0,
      rejectedNonChartCount,
      truncated: false,
      maxPanels: MAXIMUM_CHART_PANELS,
      lowResolutionRecovery: {
        applied: recovered.repairedPixelCount > 0,
        maximumGap: recovered.maximumGap,
        repairedPixelCount: recovered.repairedPixelCount,
      },
    };
  }
  const selected = selectHighestQualityPanels(
    candidates,
    width,
    height,
  );
  const ordered = orderAndDescribePanels(selected, width, height);
  return {
    ...ordered,
    fallbackUsed: false,
    detectedPanelCount: candidates.length,
    rejectedNonChartCount,
    truncated: candidates.length > selected.length,
    maxPanels: MAXIMUM_CHART_PANELS,
    lowResolutionRecovery: {
      applied: recovered.repairedPixelCount > 0,
      maximumGap: recovered.maximumGap,
      repairedPixelCount: recovered.repairedPixelCount,
    },
  };
}

/**
 * Detect independent charts in an RGB/RGBA image.
 *
 * This is deliberately framework-agnostic: callers provide decoded pixels,
 * and receive deterministic, reading-order crop rectangles in the same pixel
 * coordinate system. At least one panel is always returned.
 *
 * @param {Uint8Array | Uint8ClampedArray | Buffer} rgb
 * @param {number} width
 * @param {number} height
 * @param {3 | 4} [channels]
 * @param {{sourceScale?: number; maximumLineGap?: number}} [options]
 * @returns {{
 *   panels: Array<{
 *     index: number;
 *     x: number;
 *     y: number;
 *     width: number;
 *     height: number;
 *     confidence: number;
 *     detectionReason: string;
 *     axisMode: "rectangle" | "l-axis" | "content";
 *   }>;
 *   layout: {rows: number; columns: number};
 *   fallbackUsed: boolean;
 *   detectedPanelCount: number;
 *   rejectedNonChartCount: number;
 *   truncated: boolean;
 *   maxPanels: number;
 * }}
 */
export function detectChartPanels(
  rgb,
  width,
  height,
  channels = 4,
  options = {},
) {
  const pixelCount = width * height;
  const inferredChannels =
    rgb.length === pixelCount * channels
      ? channels
      : rgb.length === pixelCount * 4
        ? 4
        : rgb.length === pixelCount * 3
          ? 3
          : 0;
  if (![3, 4].includes(inferredChannels)) {
    throw new Error("패널 검출에는 RGB 또는 RGBA 픽셀이 필요합니다.");
  }
  const {
    broadMask,
    salientMask,
    curveSalientMask,
    curveColorMasks,
  } = buildForegroundMasks(
    rgb,
    width,
    height,
    inferredChannels,
    {
      sourceScale: options.sourceScale,
    },
  );
  return detectChartPanelsFromMask(broadMask, width, height, {
    edgeEvidenceMask: salientMask,
    curveEvidenceMask: curveSalientMask,
    curveColorMasks,
    maximumLineGap: options.maximumLineGap,
  });
}

/**
 * Crop an interleaved RGB/RGBA buffer using an inclusive panel rectangle.
 *
 * @param {Uint8Array | Uint8ClampedArray | Buffer} pixels
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {3 | 4} channels
 * @param {{left?: number; top?: number; x?: number; y?: number; width: number; height: number}} panel
 */
export function cropInterleavedPixels(
  pixels,
  sourceWidth,
  sourceHeight,
  channels,
  panel,
) {
  if (
    ![3, 4].includes(channels) ||
    pixels.length < sourceWidth * sourceHeight * channels
  ) {
    throw new Error("크롭할 RGB/RGBA 픽셀 버퍼가 올바르지 않습니다.");
  }
  const left = Math.round(panel.left ?? panel.x ?? 0);
  const top = Math.round(panel.top ?? panel.y ?? 0);
  const cropWidth = Math.round(panel.width);
  const cropHeight = Math.round(panel.height);
  if (
    left < 0 ||
    top < 0 ||
    cropWidth <= 0 ||
    cropHeight <= 0 ||
    left + cropWidth > sourceWidth ||
    top + cropHeight > sourceHeight
  ) {
    throw new Error("패널 크롭 영역이 이미지 경계를 벗어났습니다.");
  }
  const Ctor =
    typeof Buffer !== "undefined" && Buffer.isBuffer?.(pixels)
      ? Buffer
      : pixels.constructor;
  const cropped = new Ctor(cropWidth * cropHeight * channels);
  for (let row = 0; row < cropHeight; row += 1) {
    const sourceOffset =
      ((top + row) * sourceWidth + left) * channels;
    const targetOffset = row * cropWidth * channels;
    cropped.set(
      pixels.subarray(
        sourceOffset,
        sourceOffset + cropWidth * channels,
      ),
      targetOffset,
    );
  }
  return {
    pixels: cropped,
    width: cropWidth,
    height: cropHeight,
    channels,
  };
}
