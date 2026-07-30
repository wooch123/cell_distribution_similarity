import {
  buildForegroundMasks,
  detectPlotBounds,
  deskewForegroundMasks,
  estimateDeskewAngle,
  removeGridLinesPreservingCurves,
  rotateBinaryMask,
} from "./vth-image-core.mjs";
import {
  analyzeForegroundMasks,
  extractUpperArcPeakEvidence,
} from "./vth-image-analysis-core.mjs";

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
const LINE_BAND_SPATIAL_DIVISIONS = 4;
const LINE_BAND_SPAN_BUCKETS = 4;
const MAXIMUM_LINE_BANDS_PER_SPATIAL_SPAN_BUCKET = 16;
const MAXIMUM_L_AXIS_LINE_RELATION_CHECKS = 100_000;
const MAXIMUM_L_AXIS_CANDIDATES_PER_TILE = 32;
const MAXIMUM_FRAMELESS_COMPONENTS_PER_TILE = 64;
const MAXIMUM_FRAMELESS_MEASUREMENTS_PER_SOURCE = 192;
const PRE_NMS_SPATIAL_DIVISIONS = 4;
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

export function extractLineBands(
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
  const maximumThickness = Math.max(
    7,
    primaryLength * 0.025,
  );
  const spatialBucketCount =
    LINE_BAND_SPATIAL_DIVISIONS *
    LINE_BAND_SPATIAL_DIVISIONS;
  const retainedBuckets = Array.from(
    {
      length:
        spatialBucketCount * LINE_BAND_SPAN_BUCKETS,
    },
    () => [],
  );
  const bandQuality = (band) =>
    band.coverage * 2 +
    Math.min(
      1,
      (band.end - band.start + 1) /
        Math.max(safeMinimumSpan, secondaryLength * 0.2),
    ) -
    Math.min(0.3, (band.thickness - 1) * 0.04);
  const retainFinalizedBand = (activeBand) => {
    const band = {
      coordinate: Math.round(
        activeBand.coordinateSum / activeBand.count,
      ),
      start: Math.round(
        activeBand.startSum / activeBand.count,
      ),
      end: Math.round(
        activeBand.endSum / activeBand.count,
      ),
      thickness:
        activeBand.maximumCoordinate -
        activeBand.minimumCoordinate +
        1,
      coverage:
        activeBand.coverageSum / activeBand.count,
    };
    const span = band.end - band.start + 1;
    if (
      span < safeMinimumSpan ||
      // A broad filled block is normally a legend swatch or label, not an
      // axis. Real plot lines remain thin even after anti-aliasing.
      band.thickness > maximumThickness
    ) {
      return;
    }
    const primaryBucket = clamp(
      Math.floor(
        (band.coordinate * LINE_BAND_SPATIAL_DIVISIONS) /
          Math.max(1, primaryLength),
      ),
      0,
      LINE_BAND_SPATIAL_DIVISIONS - 1,
    );
    const midpoint = (band.start + band.end) / 2;
    const secondaryBucket = clamp(
      Math.floor(
        (midpoint * LINE_BAND_SPATIAL_DIVISIONS) /
          Math.max(1, secondaryLength),
      ),
      0,
      LINE_BAND_SPATIAL_DIVISIONS - 1,
    );
    const spanBucket = clamp(
      Math.floor(
        Math.log2(
          Math.max(1, span / safeMinimumSpan),
        ),
      ),
      0,
      LINE_BAND_SPAN_BUCKETS - 1,
    );
    const bucketIndex =
      (primaryBucket * LINE_BAND_SPATIAL_DIVISIONS +
        secondaryBucket) *
        LINE_BAND_SPAN_BUCKETS +
      spanBucket;
    const bucket = retainedBuckets[bucketIndex];
    bucket.push(band);
    bucket.sort(
      (left, right) =>
        bandQuality(right) - bandQuality(left) ||
        right.coverage - left.coverage ||
        right.end - right.start - (left.end - left.start) ||
        left.coordinate - right.coordinate ||
        left.start - right.start,
    );
    if (
      bucket.length >
      MAXIMUM_LINE_BANDS_PER_SPATIAL_SPAN_BUCKET
    ) {
      bucket.length =
        MAXIMUM_LINE_BANDS_PER_SPATIAL_SPAN_BUCKET;
    }
  };

  // Only bands seen in the preceding three primary coordinates can accept a
  // new segment. Streaming that active window avoids both the unbounded raw
  // segment array and the previous scan over every historical band.
  let activeBands = [];
  for (
    let primary = 0;
    primary < primaryLength;
    primary += 1
  ) {
    const stillActive = [];
    for (const band of activeBands) {
      if (primary - band.lastCoordinate > 3) {
        retainFinalizedBand(band);
      } else {
        stillActive.push(band);
      }
    }
    activeBands = stillActive;
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
      let best = null;
      let bestOverlap = 0;
      for (const band of activeBands) {
        const runSpan = run.end - run.start + 1;
        const bandSpan = band.end - band.start + 1;
        const spanSimilarity =
          Math.min(runSpan, bandSpan) /
          Math.max(1, Math.max(runSpan, bandSpan));
        if (spanSimilarity < 0.08) continue;
        const overlap = intervalOverlapRatio(
          run.start,
          run.end,
          band.start,
          band.end,
        );
        if (overlap > 0.72 && overlap > bestOverlap) {
          best = band;
          bestOverlap = overlap;
        }
      }
      if (!best) {
        activeBands.push({
          count: 1,
          coordinateSum: primary,
          startSum: run.start,
          endSum: run.end,
          coverageSum: run.coverage,
          minimumCoordinate: primary,
          maximumCoordinate: primary,
          start: run.start,
          end: run.end,
          lastCoordinate: primary,
        });
        continue;
      }
      best.count += 1;
      best.coordinateSum += primary;
      best.startSum += run.start;
      best.endSum += run.end;
      best.coverageSum += run.coverage;
      best.maximumCoordinate = primary;
      best.start = Math.round(best.startSum / best.count);
      best.end = Math.round(best.endSum / best.count);
      best.lastCoordinate = primary;
    }
  }
  for (const band of activeBands) {
    retainFinalizedBand(band);
  }

  return retainedBuckets
    .flat()
    .sort(
      (left, right) =>
        left.coordinate - right.coordinate ||
        left.start - right.start ||
        left.end - right.end,
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

/**
 * Recover a closed frame without enumerating every horizontal-line pair.
 *
 * A document containing tables, labels and many independent charts can
 * produce enough unrelated horizontal bands to exhaust the ordinary bounded
 * pair search before it reaches a physically tiny frame near the bottom of
 * the slide. A real frame exposes a much cheaper local invariant: the top
 * stroke ends where two vertical strokes begin, and those vertical strokes
 * end at the same bottom stroke. Join those endpoints directly so every image
 * location receives the same opportunity independent of preceding content.
 */
function detectEndpointAnchoredRectangleCandidates(
  mask,
  width,
  height,
  horizontalLines,
  verticalLines,
  minimumWidth,
  minimumHeight,
) {
  const tolerance = Math.max(
    3,
    Math.round(Math.min(width, height) * 0.006),
  );
  const verticalsByCoordinate = new Map();
  for (const line of verticalLines) {
    const bucket =
      verticalsByCoordinate.get(line.coordinate) ?? [];
    // A line extractor can emit a few overlapping hypotheses at one
    // coordinate. Retaining the strongest four bounds the endpoint join on
    // adversarial documents without biasing it toward any page location.
    bucket.push(line);
    bucket.sort(
      (left, right) =>
        right.coverage - left.coverage ||
        right.end - right.start - (left.end - left.start),
    );
    if (bucket.length > 4) bucket.length = 4;
    verticalsByCoordinate.set(line.coordinate, bucket);
  }
  const horizontalsByCoordinate = new Map();
  for (const line of horizontalLines) {
    const bucket =
      horizontalsByCoordinate.get(line.coordinate) ?? [];
    bucket.push(line);
    bucket.sort(
      (left, right) =>
        right.coverage - left.coverage ||
        right.end - right.start - (left.end - left.start),
    );
    if (bucket.length > 4) bucket.length = 4;
    horizontalsByCoordinate.set(line.coordinate, bucket);
  }
  const nearbyLines = (buckets, coordinate) => {
    const result = [];
    for (
      let localCoordinate = coordinate - tolerance;
      localCoordinate <= coordinate + tolerance;
      localCoordinate += 1
    ) {
      const bucket = buckets.get(localCoordinate);
      if (bucket) result.push(...bucket);
    }
    return result;
  };
  const candidates = [];
  const candidateKeys = new Set();
  for (const topLine of horizontalLines) {
    const top = topLine.coordinate;
    const leftVerticals = nearbyLines(
      verticalsByCoordinate,
      topLine.start,
    )
      .filter(
        (line) =>
          Math.abs(line.start - top) <= tolerance &&
          line.end - top + 1 >= minimumHeight,
      )
      .sort(
        (left, right) =>
          Math.abs(left.coordinate - topLine.start) -
            Math.abs(right.coordinate - topLine.start) ||
          Math.abs(left.start - top) -
            Math.abs(right.start - top) ||
          right.coverage - left.coverage,
      )
      .slice(0, 4);
    const rightVerticals = nearbyLines(
      verticalsByCoordinate,
      topLine.end,
    )
      .filter(
        (line) =>
          Math.abs(line.start - top) <= tolerance &&
          line.end - top + 1 >= minimumHeight,
      )
      .sort(
        (left, right) =>
          Math.abs(left.coordinate - topLine.end) -
            Math.abs(right.coordinate - topLine.end) ||
          Math.abs(left.start - top) -
            Math.abs(right.start - top) ||
          right.coverage - left.coverage,
      )
      .slice(0, 4);
    for (const leftLine of leftVerticals) {
      for (const rightLine of rightVerticals) {
        const left = leftLine.coordinate;
        const right = rightLine.coordinate;
        if (
          right - left + 1 < minimumWidth ||
          Math.abs(leftLine.end - rightLine.end) > tolerance
        ) {
          continue;
        }
        const expectedBottom = Math.round(
          (leftLine.end + rightLine.end) / 2,
        );
        const bottomLine = nearbyLines(
          horizontalsByCoordinate,
          expectedBottom,
        )
          .filter(
            (line) =>
              line.coordinate > top &&
              line.coordinate - top + 1 >= minimumHeight &&
              lineFitsInterval(
                line,
                left,
                right,
                tolerance,
              ),
          )
          .sort(
            (first, second) =>
              Math.abs(first.coordinate - expectedBottom) -
                Math.abs(second.coordinate - expectedBottom) ||
              Math.abs(first.start - left) +
                Math.abs(first.end - right) -
                (Math.abs(second.start - left) +
                  Math.abs(second.end - right)) ||
              second.coverage - first.coverage,
          )[0];
        if (
          !bottomLine ||
          !lineFitsInterval(
            topLine,
            left,
            right,
            tolerance,
          )
        ) {
          continue;
        }
        const bottom = bottomLine.coordinate;
        // This endpoint pass exists only for physically tiny frames that can
        // be starved by the document-level pair budget. Larger plots already
        // use the stricter rectangle search; admitting their internal grid
        // rectangles here would split one distribution into State-sized
        // panels.
        if (
          right - left + 1 > 52 ||
          bottom - top + 1 > 40
        ) {
          continue;
        }
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
        const key = `${left}:${top}:${right}:${bottom}`;
        if (candidateKeys.has(key)) continue;
        candidateKeys.add(key);
        candidates.push({
          ...bounds,
          confidence: clamp(
            0.5 +
              supports.reduce(
                (sum, value) => sum + value,
                0,
              ) *
                0.09 +
              cornerCount * 0.025 +
              Math.min(0.08, inkRatio * 3),
            0,
            0.99,
          ),
          axisMode: "rectangle",
          detectionReason: "closed-plot-frame",
          endpointAnchored: true,
        });
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
  const tolerance = Math.max(
    4,
    Math.round(Math.min(width, height) * 0.018),
  );
  const verticalsByCoordinate = new Map();
  for (const vertical of verticalLines) {
    const bucket =
      verticalsByCoordinate.get(vertical.coordinate) ?? [];
    bucket.push(vertical);
    verticalsByCoordinate.set(vertical.coordinate, bucket);
  }
  // Visit page regions round-robin. If a malformed document reaches the hard
  // relation budget, a dense title/table at the top-left cannot consume the
  // opportunity of every later chart.
  const horizontalTiles = Array.from(
    {
      length:
        LINE_BAND_SPATIAL_DIVISIONS *
        LINE_BAND_SPATIAL_DIVISIONS,
    },
    () => [],
  );
  for (const horizontal of horizontalLines) {
    const row = clamp(
      Math.floor(
        (horizontal.coordinate *
          LINE_BAND_SPATIAL_DIVISIONS) /
          Math.max(1, height),
      ),
      0,
      LINE_BAND_SPATIAL_DIVISIONS - 1,
    );
    const midpoint =
      (horizontal.start + horizontal.end) / 2;
    const column = clamp(
      Math.floor(
        (midpoint * LINE_BAND_SPATIAL_DIVISIONS) /
          Math.max(1, width),
      ),
      0,
      LINE_BAND_SPATIAL_DIVISIONS - 1,
    );
    horizontalTiles[
      row * LINE_BAND_SPATIAL_DIVISIONS + column
    ].push(horizontal);
  }
  const fairHorizontalLines = [];
  const maximumTileLength = Math.max(
    0,
    ...horizontalTiles.map((tile) => tile.length),
  );
  for (
    let itemIndex = 0;
    itemIndex < maximumTileLength;
    itemIndex += 1
  ) {
    for (const tile of horizontalTiles) {
      if (tile[itemIndex]) {
        fairHorizontalLines.push(tile[itemIndex]);
      }
    }
  }
  const retainedCandidateTiles = Array.from(
    { length: horizontalTiles.length },
    () => [],
  );
  const candidateKeys = new Set();
  let relationCheckCount = 0;
  let relationBudgetExhausted = false;
  for (const horizontal of fairHorizontalLines) {
    if (relationBudgetExhausted) break;
    const nearbyVerticals = [];
    for (
      let coordinate = horizontal.start - tolerance;
      coordinate <= horizontal.start + tolerance;
      coordinate += 1
    ) {
      const bucket =
        verticalsByCoordinate.get(coordinate);
      if (bucket) nearbyVerticals.push(...bucket);
    }
    for (const vertical of nearbyVerticals) {
      relationCheckCount += 1;
      if (
        relationCheckCount >
        MAXIMUM_L_AXIS_LINE_RELATION_CHECKS
      ) {
        relationBudgetExhausted = true;
        break;
      }
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
      const candidate = {
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
      };
      const key = `${left}:${top}:${right}:${bottom}`;
      if (candidateKeys.has(key)) continue;
      candidateKeys.add(key);
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;
      const row = clamp(
        Math.floor(
          (centerY * LINE_BAND_SPATIAL_DIVISIONS) /
            Math.max(1, height),
        ),
        0,
        LINE_BAND_SPATIAL_DIVISIONS - 1,
      );
      const column = clamp(
        Math.floor(
          (centerX * LINE_BAND_SPATIAL_DIVISIONS) /
            Math.max(1, width),
        ),
        0,
        LINE_BAND_SPATIAL_DIVISIONS - 1,
      );
      const tile =
        retainedCandidateTiles[
          row * LINE_BAND_SPATIAL_DIVISIONS + column
        ];
      tile.push(candidate);
      tile.sort(
        (first, second) =>
          second.confidence - first.confidence ||
          area(second) - area(first) ||
          first.top - second.top ||
          first.left - second.left,
      );
      if (
        tile.length >
        MAXIMUM_L_AXIS_CANDIDATES_PER_TILE
      ) {
        tile.length =
          MAXIMUM_L_AXIS_CANDIDATES_PER_TILE;
      }
    }
  }
  return retainedCandidateTiles
    .flat()
    .sort(
      (first, second) =>
        first.top - second.top ||
        first.left - second.left,
    );
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
  minimumLineThickness = 2,
) {
  if (!curveEvidenceMask) return [];
  const horizontalLines = extractLineBands(
    mask,
    width,
    height,
    "horizontal",
    minimumWidth,
    0,
  ).filter(
    (line) => line.thickness >= minimumLineThickness,
  );
  const verticalLines = extractLineBands(
    mask,
    width,
    height,
    "vertical",
    minimumHeight,
    0,
  ).filter(
    (line) => line.thickness >= minimumLineThickness,
  );
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

/**
 * A short one-row or one-column chart strip is local to a slide region, so its
 * divider strokes are intentionally too short for the document-wide lattice
 * detector. Recover only a contiguous cohort of three-or-more already
 * waveform-validated shared-frame cells. The later table-grid proof still
 * requires exact peak/valley topology in every physical cell.
 */
function measureLocalOneDimensionalSharedLattice(
  sharedFrameCellCandidates,
  width,
  height,
) {
  if (
    !Array.isArray(sharedFrameCellCandidates) ||
    sharedFrameCellCandidates.length < 3
  ) {
    return null;
  }
  const unique = [
    ...new Map(
      sharedFrameCellCandidates.map((candidate) => [
        [
          candidate.left,
          candidate.top,
          candidate.right,
          candidate.bottom,
        ].join(":"),
        candidate,
      ]),
    ).values(),
  ];
  const tolerance = Math.max(
    3,
    Math.round(Math.min(width, height) * 0.006),
  );
  const groups = (keyForCandidate) => {
    const grouped = new Map();
    for (const candidate of unique) {
      const key = keyForCandidate(candidate);
      const group = grouped.get(key) ?? [];
      group.push(candidate);
      grouped.set(key, group);
    }
    return [...grouped.values()];
  };
  const lineBand = (coordinate) => ({
    start: coordinate,
    end: coordinate,
    coordinate,
    strength: 1,
  });
  const contiguousCohort = (
    candidates,
    startField,
    endField,
    documentSpan,
  ) => {
    const ordered = [...candidates].sort(
      (left, right) =>
        left[startField] - right[startField] ||
        left[endField] - right[endField],
    );
    if (
      ordered.length < 3 ||
      ordered.length > MAXIMUM_CHART_PANELS
    ) {
      return null;
    }
    for (let index = 1; index < ordered.length; index += 1) {
      if (
        Math.abs(
          ordered[index][startField] -
            ordered[index - 1][endField],
        ) > tolerance
      ) {
        return null;
      }
    }
    const span =
      ordered.at(-1)[endField] -
      ordered[0][startField] +
      1;
    if (
      span <
      Math.max(48, Math.round(documentSpan * 0.08))
    ) {
      return null;
    }
    return ordered;
  };
  const hypotheses = [];
  for (const group of groups(
    (candidate) => `${candidate.top}:${candidate.bottom}`,
  )) {
    const cohort = contiguousCohort(
      group,
      "left",
      "right",
      width,
    );
    if (!cohort) continue;
    hypotheses.push({
      rows: 1,
      columns: cohort.length,
      horizontalBands: [
        lineBand(cohort[0].top),
        lineBand(cohort[0].bottom),
      ],
      verticalBands: [
        lineBand(cohort[0].left),
        ...cohort.map((candidate) =>
          lineBand(candidate.right),
        ),
      ],
      candidates: cohort,
    });
  }
  for (const group of groups(
    (candidate) => `${candidate.left}:${candidate.right}`,
  )) {
    const cohort = contiguousCohort(
      group,
      "top",
      "bottom",
      height,
    );
    if (!cohort) continue;
    hypotheses.push({
      rows: cohort.length,
      columns: 1,
      horizontalBands: [
        lineBand(cohort[0].top),
        ...cohort.map((candidate) =>
          lineBand(candidate.bottom),
        ),
      ],
      verticalBands: [
        lineBand(cohort[0].left),
        lineBand(cohort[0].right),
      ],
      candidates: cohort,
    });
  }
  const selected = hypotheses.sort(
    (left, right) =>
      right.candidates.length - left.candidates.length ||
      right.candidates.reduce(
        (sum, candidate) =>
          sum + (candidate.confidence ?? 0),
        0,
      ) -
        left.candidates.reduce(
          (sum, candidate) =>
            sum + (candidate.confidence ?? 0),
          0,
        ),
  )[0];
  if (!selected) return null;
  return {
    dominant: true,
    localOneDimensionalSharedLattice: true,
    rows: selected.rows,
    columns: selected.columns,
    horizontalBandCount:
      selected.horizontalBands.length,
    verticalBandCount: selected.verticalBands.length,
    horizontalBands: selected.horizontalBands,
    verticalBands: selected.verticalBands,
    bounds: {
      left: Math.min(
        ...selected.candidates.map(
          (candidate) => candidate.left,
        ),
      ),
      top: Math.min(
        ...selected.candidates.map(
          (candidate) => candidate.top,
        ),
      ),
      right: Math.max(
        ...selected.candidates.map(
          (candidate) => candidate.right,
        ),
      ),
      bottom: Math.max(
        ...selected.candidates.map(
          (candidate) => candidate.bottom,
        ),
      ),
    },
  };
}

/**
 * Recover the physical dividers of a local one-row/one-column strip before
 * deciding whether its cells are charts or table content.
 *
 * The waveform-validated shared-frame path above intentionally cannot see a
 * real table: its cells fail Curve validation. That left a dangerous gap
 * where four guided sparkline cells could survive as one large framed chart.
 * This path uses only exact, shared boundary strokes. The later repeated-grid
 * proof must still validate an independent plot grid and exact peak topology
 * inside every cell, so boundary geometry alone can never promote table data.
 */
function measurePhysicalOneDimensionalSharedLattice(
  mask,
  width,
  height,
  minimumWidth,
  minimumHeight,
) {
  if (!mask || width < 32 || height < 32) return null;
  const tolerance = Math.max(
    2,
    Math.round(Math.min(width, height) * 0.006),
  );
  const minimumSharedWidth = Math.max(
    minimumWidth * 4,
    Math.round(width * 0.12),
  );
  const minimumSharedHeight = Math.max(
    minimumHeight * 4,
    Math.round(height * 0.12),
  );
  const horizontalLines = extractLineBands(
    mask,
    width,
    height,
    "horizontal",
    Math.max(14, minimumWidth),
    0,
  );
  const verticalLines = extractLineBands(
    mask,
    width,
    height,
    "vertical",
    Math.max(14, minimumHeight),
    0,
  );
  const projectionLine = (line) => {
    const halfBefore = Math.floor(
      Math.max(0, line.thickness - 1) / 2,
    );
    const halfAfter = Math.max(
      0,
      line.thickness - 1 - halfBefore,
    );
    return {
      start: line.coordinate - halfBefore,
      end: line.coordinate + halfAfter,
      coordinate: line.coordinate,
      strength: line.coverage ?? 1,
    };
  };
  const uniqueSpanningLines = (
    lines,
    intervalStart,
    intervalEnd,
    sharedStart,
    sharedEnd,
  ) => {
    const selected = lines
      .filter(
        (line) =>
          line.coordinate >= sharedStart - tolerance &&
          line.coordinate <= sharedEnd + tolerance &&
          lineFitsInterval(
            line,
            intervalStart,
            intervalEnd,
            tolerance,
          ),
      )
      .sort(
        (left, right) =>
          left.coordinate - right.coordinate ||
          right.coverage - left.coverage,
      );
    const unique = [];
    for (const line of selected) {
      const previous = unique.at(-1);
      if (
        previous &&
        Math.abs(previous.coordinate - line.coordinate) <=
          Math.max(
            1,
            Math.ceil(
              Math.max(previous.thickness, line.thickness) /
                2,
            ),
          )
      ) {
        if (
          (line.coverage ?? 0) >
          (previous.coverage ?? 0)
        ) {
          unique[unique.length - 1] = line;
        }
      } else {
        unique.push(line);
      }
    }
    return unique;
  };
  const validBoundarySequence = (
    lines,
    sharedStart,
    sharedEnd,
    minimumCellSpan,
  ) => {
    if (
      lines.length < 5 ||
      lines.length > MAXIMUM_CHART_PANELS + 1
    ) {
      return false;
    }
    if (
      Math.abs(lines[0].coordinate - sharedStart) >
        tolerance * 2 ||
      Math.abs(lines.at(-1).coordinate - sharedEnd) >
        tolerance * 2
    ) {
      return false;
    }
    const spans = lines
      .slice(1)
      .map(
        (line, index) =>
          line.coordinate - lines[index].coordinate,
      );
    const typicalSpan = medianNumber(spans);
    return (
      spans.every(
        (span) =>
          span >= Math.max(8, minimumCellSpan) &&
          span >= typicalSpan * 0.35 &&
          span <= typicalSpan * 2.8,
      ) &&
      lines.length - 1 <= MAXIMUM_CHART_PANELS
    );
  };
  const hypotheses = [];
  let pairChecks = 0;

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
      pairChecks += 1;
      if (
        pairChecks >
        MAXIMUM_SHARED_FRAME_HORIZONTAL_PAIR_CHECKS
      ) {
        break;
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
      if (
        sharedRight - sharedLeft + 1 <
        minimumSharedWidth
      ) {
        continue;
      }
      const hasInternalSharedBoundary =
        horizontalLines.some(
          (line) =>
            line !== topLine &&
            line !== bottomLine &&
            line.coordinate > top + tolerance &&
            line.coordinate < bottom - tolerance &&
            lineFitsInterval(
              line,
              sharedLeft,
              sharedRight,
              tolerance,
            ),
        );
      if (hasInternalSharedBoundary) continue;
      const boundaries = uniqueSpanningLines(
        verticalLines,
        top,
        bottom,
        sharedLeft,
        sharedRight,
      );
      if (
        !validBoundarySequence(
          boundaries,
          sharedLeft,
          sharedRight,
          minimumWidth,
        )
      ) {
        continue;
      }
      hypotheses.push({
        rows: 1,
        columns: boundaries.length - 1,
        horizontalBands: [
          projectionLine(topLine),
          projectionLine(bottomLine),
        ],
        verticalBands: boundaries.map(projectionLine),
        bounds: {
          left: boundaries[0].coordinate,
          top,
          right: boundaries.at(-1).coordinate,
          bottom,
        },
      });
    }
  }

  pairChecks = 0;
  for (
    let leftIndex = 0;
    leftIndex < verticalLines.length - 1;
    leftIndex += 1
  ) {
    const leftLine = verticalLines[leftIndex];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < verticalLines.length;
      rightIndex += 1
    ) {
      pairChecks += 1;
      if (
        pairChecks >
        MAXIMUM_SHARED_FRAME_HORIZONTAL_PAIR_CHECKS
      ) {
        break;
      }
      const rightLine = verticalLines[rightIndex];
      const left = leftLine.coordinate;
      const right = rightLine.coordinate;
      if (right - left + 1 < minimumWidth) continue;
      const sharedTop = Math.max(
        leftLine.start,
        rightLine.start,
      );
      const sharedBottom = Math.min(
        leftLine.end,
        rightLine.end,
      );
      if (
        sharedBottom - sharedTop + 1 <
        minimumSharedHeight
      ) {
        continue;
      }
      const hasInternalSharedBoundary =
        verticalLines.some(
          (line) =>
            line !== leftLine &&
            line !== rightLine &&
            line.coordinate > left + tolerance &&
            line.coordinate < right - tolerance &&
            lineFitsInterval(
              line,
              sharedTop,
              sharedBottom,
              tolerance,
            ),
        );
      if (hasInternalSharedBoundary) continue;
      const boundaries = uniqueSpanningLines(
        horizontalLines,
        left,
        right,
        sharedTop,
        sharedBottom,
      );
      if (
        !validBoundarySequence(
          boundaries,
          sharedTop,
          sharedBottom,
          minimumHeight,
        )
      ) {
        continue;
      }
      hypotheses.push({
        rows: boundaries.length - 1,
        columns: 1,
        horizontalBands: boundaries.map(projectionLine),
        verticalBands: [
          projectionLine(leftLine),
          projectionLine(rightLine),
        ],
        bounds: {
          left,
          top: boundaries[0].coordinate,
          right,
          bottom: boundaries.at(-1).coordinate,
        },
      });
    }
  }

  const selected = hypotheses.sort(
    (left, right) =>
      right.rows * right.columns -
        left.rows * left.columns ||
      area(right.bounds) - area(left.bounds),
  )[0];
  if (!selected) return null;
  return {
    dominant: true,
    localOneDimensionalSharedLattice: true,
    physicalBoundaryOnly: true,
    rows: selected.rows,
    columns: selected.columns,
    horizontalBandCount:
      selected.horizontalBands.length,
    verticalBandCount: selected.verticalBands.length,
    horizontalBands: selected.horizontalBands,
    verticalBands: selected.verticalBands,
    bounds: selected.bounds,
  };
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

function medianMeasurement(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort(
    (left, right) => left - right,
  );
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function measureSimpleInvertedArch(
  componentPixels,
  pixelCount,
  sourceWidth,
  component,
) {
  const columnRows = Array.from(
    { length: component.componentWidth },
    () => [],
  );
  for (let index = 0; index < pixelCount; index += 1) {
    const pixel = componentPixels[index];
    const x = pixel % sourceWidth;
    const y = Math.floor(pixel / sourceWidth);
    columnRows[x - component.left].push(y);
  }
  const centerline = [];
  let singleRunColumnCount = 0;
  for (
    let localX = 0;
    localX < columnRows.length;
    localX += 1
  ) {
    const rows = columnRows[localX];
    if (!rows.length) continue;
    rows.sort((left, right) => left - right);
    let runCount = 1;
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      if (rows[rowIndex] > rows[rowIndex - 1] + 1) {
        runCount += 1;
      }
    }
    if (runCount === 1) singleRunColumnCount += 1;
    centerline.push({
      x: localX,
      y: (rows[0] + rows.at(-1)) / 2,
    });
  }
  if (centerline.length < 5) {
    return {
      valid: false,
      singleRunFraction: 0,
      apexPosition: 0,
      leftRelief: 0,
      rightRelief: 0,
      leftMonotonicity: 0,
      rightMonotonicity: 0,
    };
  }
  const smoothed = centerline.map((point, index) => {
    const from = Math.max(0, index - 1);
    const to = Math.min(centerline.length - 1, index + 1);
    let sum = 0;
    for (let neighbor = from; neighbor <= to; neighbor += 1) {
      sum += centerline[neighbor].y;
    }
    return {
      x: point.x,
      y: sum / (to - from + 1),
    };
  });
  const minimumY = Math.min(
    ...smoothed.map(({ y }) => y),
  );
  const apexTolerance = Math.max(
    0.5,
    component.componentHeight * 0.025,
  );
  const apexIndexes = smoothed
    .map(({ y }, index) => ({ y, index }))
    .filter(({ y }) => y <= minimumY + apexTolerance)
    .map(({ index }) => index);
  const apexIndex = Math.round(
    (apexIndexes[0] + apexIndexes.at(-1)) / 2,
  );
  const endpointWindow = Math.max(
    1,
    Math.floor(smoothed.length * 0.15),
  );
  const leftEndpointY = medianMeasurement(
    smoothed
      .slice(0, endpointWindow)
      .map(({ y }) => y),
  );
  const rightEndpointY = medianMeasurement(
    smoothed
      .slice(-endpointWindow)
      .map(({ y }) => y),
  );
  const apexY = medianMeasurement(
    smoothed
      .slice(
        Math.max(0, apexIndex - 1),
        Math.min(smoothed.length, apexIndex + 2),
      )
      .map(({ y }) => y),
  );
  const monotonicTolerance = Math.max(
    0.75,
    component.componentHeight * 0.04,
  );
  let leftExpectedSteps = 0;
  for (let index = 1; index <= apexIndex; index += 1) {
    if (
      smoothed[index].y <=
      smoothed[index - 1].y + monotonicTolerance
    ) {
      leftExpectedSteps += 1;
    }
  }
  let rightExpectedSteps = 0;
  for (
    let index = apexIndex + 1;
    index < smoothed.length;
    index += 1
  ) {
    if (
      smoothed[index].y >=
      smoothed[index - 1].y - monotonicTolerance
    ) {
      rightExpectedSteps += 1;
    }
  }
  const singleRunFraction =
    singleRunColumnCount / centerline.length;
  const apexPosition =
    apexIndex / Math.max(1, smoothed.length - 1);
  const leftRelief =
    (leftEndpointY - apexY) /
    Math.max(1, component.componentHeight);
  const rightRelief =
    (rightEndpointY - apexY) /
    Math.max(1, component.componentHeight);
  const leftMonotonicity =
    leftExpectedSteps / Math.max(1, apexIndex);
  const rightMonotonicity =
    rightExpectedSteps /
    Math.max(1, smoothed.length - apexIndex - 1);
  return {
    valid:
      centerline.length >= component.componentWidth * 0.8 &&
      singleRunFraction >= 0.82 &&
      apexPosition >= 0.1 &&
      apexPosition <= 0.9 &&
      leftRelief >= 0.16 &&
      rightRelief >= 0.16 &&
      leftMonotonicity >= 0.68 &&
      rightMonotonicity >= 0.68 &&
      component.density <= 0.34 &&
      component.columnInkRatio <= 0.34,
    singleRunFraction,
    apexPosition,
    leftRelief,
    rightRelief,
    leftMonotonicity,
    rightMonotonicity,
  };
}

function measureBoundaryFurniture(
  componentPixels,
  pixelCount,
  sourceWidth,
  sourceHeight,
  component,
) {
  if (
    component.componentWidth < sourceWidth * 0.45 ||
    component.componentHeight < sourceHeight * 0.4
  ) {
    return {
      valid: false,
      closedFrame: false,
      openLAxis: false,
      topCoverage: 0,
      bottomCoverage: 0,
      leftCoverage: 0,
      rightCoverage: 0,
    };
  }
  const edgeTolerance = clamp(
    Math.round(
      Math.min(
        component.componentWidth,
        component.componentHeight,
      ) * 0.025,
    ),
    1,
    3,
  );
  const topColumns = new Uint8Array(
    component.componentWidth,
  );
  const bottomColumns = new Uint8Array(
    component.componentWidth,
  );
  const leftRows = new Uint8Array(
    component.componentHeight,
  );
  const rightRows = new Uint8Array(
    component.componentHeight,
  );
  for (let index = 0; index < pixelCount; index += 1) {
    const pixel = componentPixels[index];
    const x = pixel % sourceWidth;
    const y = Math.floor(pixel / sourceWidth);
    if (y <= component.top + edgeTolerance) {
      topColumns[x - component.left] = 1;
    }
    if (y >= component.bottom - edgeTolerance) {
      bottomColumns[x - component.left] = 1;
    }
    if (x <= component.left + edgeTolerance) {
      leftRows[y - component.top] = 1;
    }
    if (x >= component.right - edgeTolerance) {
      rightRows[y - component.top] = 1;
    }
  }
  const coverage = (values) =>
    values.reduce((sum, value) => sum + value, 0) /
    Math.max(1, values.length);
  const topCoverage = coverage(topColumns);
  const bottomCoverage = coverage(bottomColumns);
  const leftCoverage = coverage(leftRows);
  const rightCoverage = coverage(rightRows);
  const closedFrame =
    topCoverage >= 0.72 &&
    bottomCoverage >= 0.72 &&
    leftCoverage >= 0.72 &&
    rightCoverage >= 0.72;
  const openLAxis =
    bottomCoverage >= 0.76 &&
    leftCoverage >= 0.76 &&
    (topCoverage < 0.62 || rightCoverage < 0.62);
  return {
    valid: closedFrame || openLAxis,
    closedFrame,
    openLAxis,
    topCoverage,
    bottomCoverage,
    leftCoverage,
    rightCoverage,
  };
}

/**
 * Measure repeated glyph-shaped connected components in a Curve residual.
 *
 * A large document title can occupy the same horizontal span as a VTH trace.
 * The greedy y=f(x) path then hops between letters and can mistake their
 * curved strokes for disconnected State arcs. Font pixels themselves are not
 * a stable threshold: the same title can arrive as a thumbnail, FHD slide or
 * rotated screenshot. Instead, this gate measures scale-free component shape.
 *
 * Real distribution arcs are sparse ribbons. Text is dominated by several
 * compact, comparatively dense components whose ink-per-column is a material
 * fraction of their own height. Requiring those components to account for
 * most residual ink keeps a genuine Curve with large surrounding labels: its
 * long sparse waveform remains the dominant component.
 */
function measureRepeatedGlyphTopology(
  columnPixels,
  interiorWidth,
  interiorHeight,
  options = {},
) {
  const cellCount = interiorWidth * interiorHeight;
  const active = new Uint8Array(cellCount);
  let totalInk = 0;
  for (
    let localX = 0;
    localX < columnPixels.length;
    localX += 1
  ) {
    for (const localY of columnPixels[localX]) {
      active[localY * interiorWidth + localX] = 1;
      totalInk += 1;
    }
  }
  if (!totalInk) {
    return {
      componentCount: 0,
      glyphLikeComponentCount: 0,
      glyphInkFraction: 0,
      horizontalSpan: 0,
      medianDensity: 0,
      medianColumnInkRatio: 0,
      medianHeightRatio: 0,
      medianAspectRatio: 0,
      sparseRibbonComponentCount: 0,
      sparseRibbonHorizontalCoverage: 0,
      dominantSparseRibbonWidth: 0,
      simpleArchComponentCount: 0,
      simpleArchComponentFraction: 0,
      simpleArchInkFraction: 0,
      simpleArchHorizontalCoverage: 0,
      textGlyphArtifact: false,
    };
  }

  const visited = new Uint8Array(cellCount);
  const queue = new Int32Array(cellCount);
  const componentColumnStamp = new Uint32Array(interiorWidth);
  const components = [];
  let componentStamp = 0;
  for (let start = 0; start < cellCount; start += 1) {
    if (!active[start] || visited[start]) continue;
    componentStamp += 1;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    let left = start % interiorWidth;
    let right = left;
    let top = Math.floor(start / interiorWidth);
    let bottom = top;
    let pixelCount = 0;
    let occupiedColumnCount = 0;
    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % interiorWidth;
      const y = Math.floor(index / interiorWidth);
      pixelCount += 1;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      if (componentColumnStamp[x] !== componentStamp) {
        componentColumnStamp[x] = componentStamp;
        occupiedColumnCount += 1;
      }
      for (
        let neighborY = Math.max(0, y - 1);
        neighborY <= Math.min(interiorHeight - 1, y + 1);
        neighborY += 1
      ) {
        for (
          let neighborX = Math.max(0, x - 1);
          neighborX <= Math.min(interiorWidth - 1, x + 1);
          neighborX += 1
        ) {
          const neighbor =
            neighborY * interiorWidth + neighborX;
          if (
            neighbor === index ||
            !active[neighbor] ||
            visited[neighbor]
          ) {
            continue;
          }
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }
    const componentWidth = right - left + 1;
    const componentHeight = bottom - top + 1;
    const component = {
      left,
      right,
      top,
      bottom,
      componentWidth,
      componentHeight,
      pixelCount,
      density:
        pixelCount /
        Math.max(1, componentWidth * componentHeight),
      columnInkRatio:
        pixelCount /
        Math.max(1, occupiedColumnCount * componentHeight),
    };
    const componentAspectRatio =
      component.componentWidth /
      Math.max(1, component.componentHeight);
    component.glyphLike =
      component.pixelCount >= 8 &&
      component.componentWidth >= 3 &&
      component.componentHeight >= 5 &&
      component.componentHeight >=
        interiorHeight * 0.035 &&
      componentAspectRatio >= 0.08 &&
      componentAspectRatio <= 2.8 &&
      component.density >= 0.085 &&
      component.columnInkRatio >= 0.09;
    component.boundaryFurniture =
      measureBoundaryFurniture(
        queue,
        tail,
        interiorWidth,
        interiorHeight,
        component,
      );
    if (component.boundaryFurniture.valid) {
      component.glyphLike = false;
    }
    component.simpleInvertedArch = component.glyphLike
      ? measureSimpleInvertedArch(
          queue,
          tail,
          interiorWidth,
          component,
        )
      : { valid: false };
    components.push(component);
  }

  const glyphLike = components.filter(
    (component) => component.glyphLike,
  );
  const sparseRibbons = components.filter(
    (component) => {
      const boundaryContainer =
        options.ignoreBoundaryContainers === true &&
        component.componentWidth >= interiorWidth * 0.8 &&
        component.componentHeight >= interiorHeight * 0.68;
      return (
        !boundaryContainer &&
        !component.boundaryFurniture.valid &&
        component.componentWidth >= interiorWidth * 0.16 &&
        component.componentHeight >= interiorHeight * 0.05 &&
        component.density <= 0.085 &&
        component.columnInkRatio <= 0.095
      );
    },
  );
  const glyphInk = glyphLike.reduce(
    (sum, component) => sum + component.pixelCount,
    0,
  );
  const horizontalSpan = glyphLike.length
    ? (Math.max(
        ...glyphLike.map((component) => component.right),
      ) -
        Math.min(
          ...glyphLike.map((component) => component.left),
        ) +
        1) /
      Math.max(1, interiorWidth)
    : 0;
  const medianDensity = medianMeasurement(
    glyphLike.map((component) => component.density),
  );
  const medianColumnInkRatio = medianMeasurement(
    glyphLike.map(
      (component) => component.columnInkRatio,
    ),
  );
  const medianHeightRatio = medianMeasurement(
    glyphLike.map(
      (component) =>
        component.componentHeight /
        Math.max(1, interiorHeight),
    ),
  );
  const medianAspectRatio = medianMeasurement(
    glyphLike.map(
      (component) =>
        component.componentWidth /
        Math.max(1, component.componentHeight),
    ),
  );
  const sparseRibbonHorizontalCoverage = clamp(
    sparseRibbons.reduce(
      (sum, component) => sum + component.componentWidth,
      0,
    ) / Math.max(1, interiorWidth),
    0,
    1,
  );
  const dominantSparseRibbonWidth = sparseRibbons.reduce(
    (maximum, component) =>
      Math.max(
        maximum,
        component.componentWidth /
          Math.max(1, interiorWidth),
      ),
    0,
  );
  const glyphInkFraction =
    glyphInk /
    Math.max(
      1,
      totalInk -
        components
          .filter(
            (component) =>
              component.boundaryFurniture.valid,
          )
          .reduce(
            (sum, component) =>
              sum + component.pixelCount,
            0,
          ),
    );
  const simpleArchComponents = glyphLike.filter(
    (component) =>
      component.simpleInvertedArch.valid,
  );
  const simpleArchInk = simpleArchComponents.reduce(
    (sum, component) => sum + component.pixelCount,
    0,
  );
  const simpleArchHorizontalCoverage = clamp(
    simpleArchComponents.reduce(
      (sum, component) => sum + component.componentWidth,
      0,
    ) / Math.max(1, interiorWidth),
    0,
    1,
  );
  const simpleArchComponentFraction =
    simpleArchComponents.length /
    Math.max(1, glyphLike.length);
  const hasDominantSparseRibbon =
    dominantSparseRibbonWidth >= 0.3 ||
    (sparseRibbons.length >= 2 &&
      sparseRibbonHorizontalCoverage >= 0.5);
  const textGlyphArtifact =
    glyphLike.length >= 2 &&
    horizontalSpan >= 0.18 &&
    glyphInkFraction >= 0.55 &&
    medianDensity >= 0.1 &&
    medianColumnInkRatio >= 0.1 &&
    !hasDominantSparseRibbon;
  return {
    componentCount: components.length,
    glyphLikeComponentCount: glyphLike.length,
    glyphInkFraction,
    horizontalSpan,
    medianDensity,
    medianColumnInkRatio,
    medianHeightRatio,
    medianAspectRatio,
    sparseRibbonComponentCount: sparseRibbons.length,
    sparseRibbonHorizontalCoverage,
    dominantSparseRibbonWidth,
    simpleArchComponentCount:
      simpleArchComponents.length,
    simpleArchComponentFraction,
    simpleArchInkFraction:
      simpleArchInk /
      Math.max(
        1,
        totalInk -
          components
            .filter(
              (component) =>
                component.boundaryFurniture.valid,
            )
            .reduce(
              (sum, component) =>
                sum + component.pixelCount,
              0,
            ),
      ),
    simpleArchHorizontalCoverage,
    boundaryFurnitureComponentCount:
      components.filter(
        (component) =>
          component.boundaryFurniture.valid,
      ).length,
    textGlyphArtifact,
  };
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
      linearDeviation: 0,
      directionChangeCount: 0,
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
      linearDeviation: 0,
      directionChangeCount: 0,
    };
  }

  let topBoundaryActiveColumns = 0;
  for (
    let x = candidate.left;
    x <= candidate.right;
    x += 1
  ) {
    let active = false;
    for (
      let y = candidate.top;
      y < top && !active;
      y += 1
    ) {
      active = Boolean(mask[y * width + x]);
    }
    if (active) topBoundaryActiveColumns += 1;
  }
  const topBoundaryCoverage =
    topBoundaryActiveColumns /
    Math.max(1, candidateWidth);
  const rowCounts = new Uint32Array(interiorHeight);
  const columnCounts = new Uint32Array(interiorWidth);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const localY = y - top;
      const localX = x - left;
      if (!mask[y * width + x]) continue;
      rowCounts[localY] += 1;
      columnCounts[localX] += 1;
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
  const ignoredRowCount = ignoredRows.reduce(
    (sum, value) => sum + value,
    0,
  );
  const ignoredColumnCount = ignoredColumns.reduce(
    (sum, value) => sum + value,
    0,
  );
  const countActiveBands = (values) => {
    let bands = 0;
    let active = false;
    for (const value of values) {
      if (value && !active) bands += 1;
      active = Boolean(value);
    }
    return bands;
  };
  const ignoredRowBandCount = countActiveBands(ignoredRows);
  const ignoredColumnBandCount =
    countActiveBands(ignoredColumns);

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
  const separatedRunsByColumn = columnPixels.map((values) => {
    if (!values.length) return [];
    const runs = [];
    let start = values[0];
    let end = values[0];
    for (const value of values.slice(1)) {
      if (value <= end + 1) {
        end = value;
        continue;
      }
      runs.push((start + end) / 2);
      start = value;
      end = value;
    }
    runs.push((start + end) / 2);
    return runs;
  });
  let currentTwoBranchGaps = [];
  let longestTwoBranchGaps = [];
  const finishTwoBranchSpan = () => {
    if (
      currentTwoBranchGaps.length >
      longestTwoBranchGaps.length
    ) {
      longestTwoBranchGaps = currentTwoBranchGaps;
    }
    currentTwoBranchGaps = [];
  };
  const minimumBranchGap = Math.max(
    3,
    interiorHeight * 0.012,
  );
  for (const runs of separatedRunsByColumn) {
    if (
      runs.length === 2 &&
      runs[1] - runs[0] >= minimumBranchGap
    ) {
      currentTwoBranchGaps.push(runs[1] - runs[0]);
    } else {
      finishTwoBranchSpan();
    }
  }
  finishTwoBranchSpan();
  const twoBranchCoverage =
    longestTwoBranchGaps.length /
    Math.max(1, interiorWidth);
  const maximumBranchGap = longestTwoBranchGaps.length
    ? Math.max(...longestTwoBranchGaps)
    : 0;
  const branchGapVariation = longestTwoBranchGaps
    .slice(1)
    .reduce(
      (sum, value, index) =>
        sum +
        Math.abs(
          value - longestTwoBranchGaps[index],
        ),
      0,
    );
  const firstBranchGap =
    longestTwoBranchGaps[0] ?? 0;
  const lastBranchGap =
    longestTwoBranchGaps.at(-1) ?? 0;
  const expectedBranchGapVariation =
    Math.max(0, maximumBranchGap - firstBranchGap) +
    Math.max(0, maximumBranchGap - lastBranchGap);
  const branchGapSmoothness = clamp(
    expectedBranchGapVariation /
      Math.max(1, branchGapVariation),
    0,
    1,
  );
  const closedTwoBranchArtifact =
    twoBranchCoverage >= 0.18 &&
    maximumBranchGap >= interiorHeight * 0.08 &&
    firstBranchGap <= maximumBranchGap * 0.35 &&
    lastBranchGap <= maximumBranchGap * 0.35 &&
    branchGapSmoothness >= 0.72;
  let enclosedHoleCoverage = 0;
  if (twoBranchCoverage >= 0.04) {
    const cellCount = interiorWidth * interiorHeight;
    const visitedBackground = new Uint8Array(cellCount);
    const queue = new Int32Array(cellCount);
    const residualActiveAt = (localX, localY) =>
      !ignoredColumns[localX] &&
      !ignoredRows[localY] &&
      mask[(top + localY) * width + left + localX];
    let queueHead = 0;
    let queueTail = 0;
    const enqueueBackground = (localX, localY) => {
      const index = localY * interiorWidth + localX;
      if (
        visitedBackground[index] ||
        residualActiveAt(localX, localY)
      ) {
        return;
      }
      visitedBackground[index] = 1;
      queue[queueTail] = index;
      queueTail += 1;
    };
    for (let x = 0; x < interiorWidth; x += 1) {
      enqueueBackground(x, 0);
      enqueueBackground(x, interiorHeight - 1);
    }
    for (let y = 1; y + 1 < interiorHeight; y += 1) {
      enqueueBackground(0, y);
      enqueueBackground(interiorWidth - 1, y);
    }
    while (queueHead < queueTail) {
      const index = queue[queueHead];
      queueHead += 1;
      const x = index % interiorWidth;
      const y = Math.floor(index / interiorWidth);
      if (x > 0) enqueueBackground(x - 1, y);
      if (x + 1 < interiorWidth) enqueueBackground(x + 1, y);
      if (y > 0) enqueueBackground(x, y - 1);
      if (y + 1 < interiorHeight) {
        enqueueBackground(x, y + 1);
      }
    }

    let largestHoleArea = 0;
    for (let start = 0; start < cellCount; start += 1) {
      if (
        visitedBackground[start] ||
        residualActiveAt(
          start % interiorWidth,
          Math.floor(start / interiorWidth),
        )
      ) {
        continue;
      }
      let holeArea = 0;
      queueHead = 0;
      queueTail = 1;
      queue[0] = start;
      visitedBackground[start] = 1;
      while (queueHead < queueTail) {
        const index = queue[queueHead];
        queueHead += 1;
        holeArea += 1;
        const x = index % interiorWidth;
        const y = Math.floor(index / interiorWidth);
        const visitHoleNeighbor = (localX, localY) => {
          const neighbor =
            localY * interiorWidth + localX;
          if (
            visitedBackground[neighbor] ||
            residualActiveAt(localX, localY)
          ) {
            return;
          }
          visitedBackground[neighbor] = 1;
          queue[queueTail] = neighbor;
          queueTail += 1;
        };
        if (x > 0) visitHoleNeighbor(x - 1, y);
        if (x + 1 < interiorWidth) {
          visitHoleNeighbor(x + 1, y);
        }
        if (y > 0) visitHoleNeighbor(x, y - 1);
        if (y + 1 < interiorHeight) {
          visitHoleNeighbor(x, y + 1);
        }
      }
      largestHoleArea = Math.max(
        largestHoleArea,
        holeArea,
      );
    }
    enclosedHoleCoverage =
      largestHoleArea / Math.max(1, cellCount);
  }
  const closedLoopArtifact =
    twoBranchCoverage >= 0.04 &&
    enclosedHoleCoverage >= 0.008;
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
  const traceSegments = [];
  const finishCurrentPath = () => {
    if (!currentPath.length) return;
    traceSegments.push(currentPath);
    if (currentPath.length > longestPath.length) {
      longestPath = currentPath;
    }
    currentPath = [];
  };
  for (const values of columnPixels) {
    if (!values.length) {
      gap += 1;
      if (gap > maximumGap) {
        previousY = null;
        finishCurrentPath();
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
      finishCurrentPath();
    }
    currentPath.push(selectedY);
    previousY = selectedY;
    gap = 0;
  }
  finishCurrentPath();

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
  const traceMeanX =
    (longestPath.length - 1) / 2;
  const traceMeanY = average(longestPath);
  let traceLinearNumerator = 0;
  let traceLinearDenominator = 0;
  for (let index = 0; index < longestPath.length; index += 1) {
    const centeredX = index - traceMeanX;
    traceLinearNumerator +=
      centeredX * (longestPath[index] - traceMeanY);
    traceLinearDenominator += centeredX * centeredX;
  }
  const traceLinearSlope =
    traceLinearNumerator /
    Math.max(1, traceLinearDenominator);
  const traceLinearIntercept =
    traceMeanY - traceLinearSlope * traceMeanX;
  const linearDeviation = longestPath.length
    ? Math.sqrt(
        average(
          longestPath.map((value, index) => {
            const residual =
              value -
              (traceLinearIntercept +
                traceLinearSlope * index);
            return residual * residual;
          }),
        ),
      ) / interiorHeight
    : 0;
  const armLinearDeviation = (values) => {
    if (values.length < 4) return 1;
    const meanX = (values.length - 1) / 2;
    const meanY = average(values);
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < values.length; index += 1) {
      const centeredX = index - meanX;
      numerator +=
        centeredX * (values[index] - meanY);
      denominator += centeredX * centeredX;
    }
    const slope = numerator / Math.max(1, denominator);
    const intercept = meanY - slope * meanX;
    return (
      Math.sqrt(
        average(
          values.map((value, index) => {
            const residual =
              value - (intercept + slope * index);
            return residual * residual;
          }),
        ),
      ) / interiorHeight
    );
  };
  const leftArmLinearDeviation = armLinearDeviation(
    longestPath.slice(0, peakIndex + 1),
  );
  const rightArmLinearDeviation = armLinearDeviation(
    longestPath.slice(peakIndex),
  );
  const turnLag = clamp(
    Math.round(longestPath.length * 0.035),
    2,
    8,
  );
  const turnTolerance = Math.max(
    1,
    interiorHeight * 0.012,
  );
  const turnDirections = [];
  for (
    let index = turnLag;
    index + turnLag < longestPath.length;
    index += turnLag
  ) {
    const delta =
      longestPath[index + turnLag] -
      longestPath[index - turnLag];
    if (Math.abs(delta) < turnTolerance) continue;
    const direction = Math.sign(delta);
    if (
      direction !==
      turnDirections[turnDirections.length - 1]
    ) {
      turnDirections.push(direction);
    }
  }
  const directionChangeCount = Math.max(
    0,
    turnDirections.length - 1,
  );
  const minimumCurvedSegmentLength = Math.max(
    5,
    Math.round(interiorWidth * 0.012),
  );
  let curvedSegmentCount = 0;
  let curvedSegmentColumns = 0;
  for (const segment of traceSegments) {
    if (segment.length < minimumCurvedSegmentLength) {
      continue;
    }
    const segmentMeanX = (segment.length - 1) / 2;
    const segmentMeanY = average(segment);
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < segment.length; index += 1) {
      const centeredX = index - segmentMeanX;
      numerator +=
        centeredX * (segment[index] - segmentMeanY);
      denominator += centeredX * centeredX;
    }
    const slope = numerator / Math.max(1, denominator);
    const intercept = segmentMeanY - slope * segmentMeanX;
    const deviation =
      Math.sqrt(
        average(
          segment.map((value, index) => {
            const residual =
              value - (intercept + slope * index);
            return residual * residual;
          }),
        ),
      ) / interiorHeight;
    const segmentVariation =
      (Math.max(...segment) - Math.min(...segment)) /
      interiorHeight;
    if (
      deviation >= 0.006 &&
      segmentVariation >= 0.025
    ) {
      curvedSegmentCount += 1;
      curvedSegmentColumns += segment.length;
    }
  }
  const curvedSegmentCoverage =
    curvedSegmentColumns /
    Math.max(1, interiorWidth);
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
    continuousCoverage >= 0.18 &&
    linearDeviation >= 0.012;
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
  const lowResolutionRoundedApexLoss =
    baseSinglePeakShape &&
    singlePeakMonotonicity >= 0.97 &&
    traceSmoothness >= 0.95 &&
    linearDeviation >= 0.12 &&
    leftArmLinearDeviation >= 0.04 &&
    rightArmLinearDeviation >= 0.04;
  const smoothSinglePeakShape =
    baseSinglePeakShape &&
    ((singlePeakMonotonicity >= 0.82 &&
      traceSmoothness >= 0.92 &&
      roundedApexScore >= 0.1) ||
      logScaleParabolicPeak ||
      lowResolutionRoundedApexLoss);
  const straightSidedApex =
    baseSinglePeakShape &&
    leftArmSpan >= 5 &&
    rightArmSpan >= 5 &&
    leftArmLinearDeviation <= 0.012 &&
    rightArmLinearDeviation <= 0.012;
  // A single-state plot can occupy only the middle of a wide axis. Requiring
  // the same full-width coverage as a multi-State chain drops these otherwise
  // valid charts, especially on PPT slides. Keep a localized trace only when
  // it has a clear rounded apex, stable falling tails on both sides and little
  // excess vertical motion. Sharp chevrons/checkmarks can have the same span
  // and prominence but do not flatten around their apex.
  const localizedSinglePeak = smoothSinglePeakShape;
  const sharpSinglePeakArtifact =
    baseSinglePeakShape &&
    ((singlePeakMonotonicity >= 0.9 &&
      traceSmoothness >= 0.75 &&
      !smoothSinglePeakShape) ||
      straightSidedApex);
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
    linearDeviation >= 0.02 &&
    (residualDensity <= 0.1 ||
      (residualDensity <= 0.17 &&
        horizontalCoverage >= 0.8 &&
        curvedSegmentCoverage >= 0.75 &&
        verticalVariation >= 0.2 &&
        linearDeviation >= 0.045)) &&
    thinEnough &&
    !sharpSinglePeakArtifact;
  const segmentedWaveformTrace =
    candidate.axisMode === "content" &&
    horizontalCoverage >= 0.3 &&
    curvedSegmentCount >= 2 &&
    curvedSegmentCoverage >= 0.16 &&
    verticalVariation >= 0.045 &&
    linearDeviation >= 0.012 &&
    thinEnough &&
    !sharpSinglePeakArtifact;
  const shouldMeasureRepeatedGlyphTopology =
    horizontalCoverage >= 0.28 &&
    verticalVariation >= 0.04 &&
    thinEnough &&
    (coherentTrace ||
      segmentedShallowTrace ||
      segmentedWaveformTrace);
  const flattenedTitleBand =
    horizontalCoverage >= 0.25 &&
    continuousCoverage <= 0.12 &&
    verticalVariation <= 0.04 &&
    ignoredRowCount >= interiorHeight * 0.08 &&
    ignoredRowBandCount <= 2;
  const shouldMeasureRawRepeatedGlyphTopology =
    shouldMeasureRepeatedGlyphTopology ||
    flattenedTitleBand;
  const repeatedGlyphTopology =
    shouldMeasureRepeatedGlyphTopology
      ? measureRepeatedGlyphTopology(
          columnPixels,
          interiorWidth,
          interiorHeight,
        )
      : {
          componentCount: 0,
          glyphLikeComponentCount: 0,
          glyphInkFraction: 0,
          horizontalSpan: 0,
          medianDensity: 0,
          medianColumnInkRatio: 0,
          medianHeightRatio: 0,
          medianAspectRatio: 0,
          sparseRibbonComponentCount: 0,
          sparseRibbonHorizontalCoverage: 0,
          dominantSparseRibbonWidth: 0,
          simpleArchComponentCount: 0,
          simpleArchComponentFraction: 0,
          simpleArchInkFraction: 0,
          simpleArchHorizontalCoverage: 0,
          textGlyphArtifact: false,
        };
  // Glyph topology must retain the complete candidate bounds. The inset used
  // by Curve tracing intentionally removes axes and frame edges, but it can
  // also clip boundary-touching log-scale peaks into many dense islands that
  // look exactly like letters. On the original mask those State arcs remain
  // one connected waveform (often through a clipped top or physical axis).
  const rawColumnPixels = shouldMeasureRawRepeatedGlyphTopology
    ? Array.from({ length: candidateWidth }, () => [])
    : null;
  if (rawColumnPixels) {
    for (
      let localX = 0;
      localX < candidateWidth;
      localX += 1
    ) {
      const x = candidate.left + localX;
      for (
        let localY = 0;
        localY < candidateHeight;
        localY += 1
      ) {
        if (
          mask[
            (candidate.top + localY) * width + x
          ]
        ) {
          rawColumnPixels[localX].push(localY);
        }
      }
    }
  }
  const rawRepeatedGlyphTopology = rawColumnPixels
    ? measureRepeatedGlyphTopology(
        rawColumnPixels,
        candidateWidth,
        candidateHeight,
        { ignoreBoundaryContainers: true },
      )
    : {
        componentCount: 0,
        glyphLikeComponentCount: 0,
        glyphInkFraction: 0,
        horizontalSpan: 0,
        medianDensity: 0,
        medianColumnInkRatio: 0,
        medianHeightRatio: 0,
        medianAspectRatio: 0,
        sparseRibbonComponentCount: 0,
        sparseRibbonHorizontalCoverage: 0,
        dominantSparseRibbonWidth: 0,
        simpleArchComponentCount: 0,
        simpleArchComponentFraction: 0,
        simpleArchInkFraction: 0,
        simpleArchHorizontalCoverage: 0,
        textGlyphArtifact: false,
      };
  // At thumbnail scale, a framed multi-State Curve can split into several
  // dense anti-aliased islands. It still differs from a title card by keeping
  // one almost panel-wide, continuously curved trajectory. Preserve that
  // physical waveform proof; unframed glyph proposals and framed prose cards
  // retain the repeated-component veto.
  const physicallyFramedCoherentWaveform =
    candidate.axisMode !== "content" &&
    horizontalCoverage >= 0.75 &&
    continuousCoverage >= 0.75 &&
    verticalVariation >= 0.08 &&
    directionChangeCount >= 2;
  const physicallyFramedSegmentedPeaks =
    candidate.axisMode !== "content" &&
    horizontalCoverage >= 0.7 &&
    continuousCoverage >= 0.08 &&
    continuousCoverage <= 0.18 &&
    verticalVariation >= 0.28 &&
    directionChangeCount === 1;
  const physicallyFramedCompactMultiTurnWaveform =
    candidate.axisMode !== "content" &&
    horizontalCoverage >= 0.55 &&
    continuousCoverage >= 0.45 &&
    verticalVariation >= 0.2 &&
    directionChangeCount >= 4 &&
    rawRepeatedGlyphTopology.glyphLikeComponentCount <= 4 &&
    rawRepeatedGlyphTopology.simpleArchComponentCount >= 1;
  const physicallyFramedCompactArchWaveform =
    candidate.axisMode !== "content" &&
    horizontalCoverage >= 0.7 &&
    continuousCoverage >= 0.2 &&
    verticalVariation >= 0.17 &&
    directionChangeCount >= 2 &&
    rawRepeatedGlyphTopology.glyphLikeComponentCount <= 4 &&
    rawRepeatedGlyphTopology.simpleArchComponentCount >= 1;
  const repeatedSimpleArchWaveform =
    candidate.axisMode === "content" &&
    horizontalCoverage >= 0.45 &&
    curvedSegmentCoverage >= 0.45 &&
    rawRepeatedGlyphTopology.glyphLikeComponentCount >= 3 &&
    rawRepeatedGlyphTopology.simpleArchComponentCount >=
      Math.max(
        2,
        Math.ceil(
          rawRepeatedGlyphTopology.glyphLikeComponentCount *
            0.5,
        ),
      ) &&
    rawRepeatedGlyphTopology.simpleArchHorizontalCoverage >=
      0.28;
  // At thumbnail resolution, many narrow V-NAND States can become separate,
  // dense components and trip the repeated-glyph veto. They remain much
  // taller and narrower than document glyphs and occupy nearly the complete
  // x span. Preserve that repeated physical State array without weakening the
  // general title/body-text rejection.
  const repeatedIndependentStateArray =
    candidate.axisMode === "content" &&
    rawRepeatedGlyphTopology.glyphLikeComponentCount >= 9 &&
    rawRepeatedGlyphTopology.glyphInkFraction >= 0.9 &&
    rawRepeatedGlyphTopology.horizontalSpan >= 0.85 &&
    rawRepeatedGlyphTopology.medianHeightRatio >= 0.28 &&
    (rawRepeatedGlyphTopology.medianAspectRatio <= 0.35 ||
      (rawRepeatedGlyphTopology.medianAspectRatio <= 0.7 &&
        horizontalCoverage >= 0.75 &&
        verticalVariation >= 0.24 &&
        directionChangeCount >= 8));
  // A deeply clipped high-State Curve can split into only two very tall
  // components at the image boundary. That topology resembles two large
  // glyphs, but the surviving trace still crosses almost the entire image
  // with many alternating turns and near-full vertical excursion.
  const highTurnFullWidthWaveform =
    candidate.axisMode === "content" &&
    horizontalCoverage >= 0.8 &&
    continuousCoverage >= 0.2 &&
    verticalVariation >= 0.8 &&
    curvedSegmentCoverage >= 0.75 &&
    directionChangeCount >= 8 &&
    thinEnough &&
    rawRepeatedGlyphTopology.componentCount <= 2 &&
    rawRepeatedGlyphTopology.glyphLikeComponentCount >= 1 &&
    rawRepeatedGlyphTopology.glyphLikeComponentCount <= 2 &&
    rawRepeatedGlyphTopology.horizontalSpan >= 0.9;
  // A very small multi-State panel may retain only two dense colour islands
  // after downsampling, so component topology alone resembles a two-glyph
  // heading. Its traced centreline still alternates through many physical
  // peaks and valleys across almost the complete proposal, unlike an
  // individual document glyph.
  const compactHighTurnWaveform =
    candidate.axisMode === "content" &&
    horizontalCoverage >= 0.8 &&
    continuousCoverage >= 0.45 &&
    verticalVariation >= 0.25 &&
    directionChangeCount >= 5 &&
    curvedSegmentCoverage >= 0.75 &&
    thinEnough &&
    rawRepeatedGlyphTopology.glyphLikeComponentCount <= 2;
  // Connected display/script lettering can form one broad wavy component,
  // so repeated-glyph topology alone cannot identify it. A real connected
  // multi-State VTH trace remains a panel-wide sparse ribbon; the dense
  // lettering below has no such ribbon and only a shallow, fragmented path.
  const wideSingleComponentScriptArtifact =
    candidate.axisMode === "content" &&
    rawRepeatedGlyphTopology.componentCount === 1 &&
    rawRepeatedGlyphTopology.glyphLikeComponentCount === 0 &&
    rawRepeatedGlyphTopology.sparseRibbonComponentCount === 0 &&
    rawRepeatedGlyphTopology.dominantSparseRibbonWidth < 0.1 &&
    horizontalCoverage >= 0.35 &&
    continuousCoverage <= 0.5 &&
    verticalVariation >= 0.04 &&
    verticalVariation <= 0.2 &&
    meanPixelsPerActiveColumn >= 10 &&
    directionChangeCount >= 2;
  const textGlyphArtifact =
    !localizedSinglePeak &&
    !physicallyFramedCoherentWaveform &&
    !physicallyFramedSegmentedPeaks &&
    !physicallyFramedCompactMultiTurnWaveform &&
    !physicallyFramedCompactArchWaveform &&
    !repeatedSimpleArchWaveform &&
    !repeatedIndependentStateArray &&
    !highTurnFullWidthWaveform &&
    !compactHighTurnWaveform &&
    (rawRepeatedGlyphTopology.textGlyphArtifact ||
      wideSingleComponentScriptArtifact);
  const minimumFullWidthCoverage =
    candidate.axisMode === "content" ? 0.35 : 0.42;
  const contentHasWaveformTurn =
    candidate.axisMode !== "content" ||
    directionChangeCount >= 1;
  const clippedPlateauWaveform =
    candidate.axisMode === "content" &&
    ignoredRowCount >= 1 &&
    horizontalCoverage >= 0.33 &&
    continuousCoverage >= 0.3 &&
    verticalVariation >= 0.04 &&
    verticalVariation <= 0.2 &&
    linearDeviation >= 0.015 &&
    curvedSegmentCoverage >= 0.3 &&
    thinEnough;
  const boundaryClippedShallowWaveform =
    candidate.axisMode === "content" &&
    topBoundaryCoverage >= 0.22 &&
    horizontalCoverage >= 0.3 &&
    continuousCoverage >= 0.3 &&
    verticalVariation >= 0.035 &&
    verticalVariation <= 0.2 &&
    linearDeviation >= 0.012 &&
    curvedSegmentCoverage >= 0.3 &&
    thinEnough;
  // In a two-State log plot both maxima can be clipped above the image,
  // leaving only one broad valley. Browser upscaling thickens the visible
  // arms and may split the turn at the valley, so the longest greedy path
  // becomes monotone even though the combined trace is a real distribution.
  // Require substantial top clipping, curvature, span, and exactly one
  // y-run per column to keep this rescue distinct from closed explanation
  // shapes.
  const boundaryClippedValleyWaveform =
    candidate.axisMode === "content" &&
    topBoundaryCoverage >= 0.28 &&
    horizontalCoverage >= 0.6 &&
    continuousCoverage >= 0.58 &&
    verticalVariation >= 0.2 &&
    verticalVariation <= 0.42 &&
    linearDeviation >= 0.045 &&
    curvedSegmentCoverage >= 0.58 &&
    directionChangeCount === 0 &&
    twoBranchCoverage < 0.003 &&
    thinEnough;
  const simpleTwoBranchOutlineArtifact =
    twoBranchCoverage >= 0.12 &&
    maximumBranchGap >= interiorHeight * 0.06 &&
    branchGapSmoothness >= 0.62 &&
    directionChangeCount <= 1 &&
    curvedSegmentCount <= 4;
  // A steep or partially clipped ellipse may expose only two monotone arcs,
  // so neither the enclosed-hole test nor the longer parallel-branch test
  // sees a complete loop. A true Curve can also split at a sharp apex, but it
  // still contributes only one connected y-run per x column. Reject the
  // double-run monotone outline without penalizing that real single peak.
  const clippedClosedOutlineArtifact =
    candidate.axisMode === "content" &&
    directionChangeCount === 0 &&
    curvedSegmentCount >= 2 &&
    twoBranchCoverage >= 0.003 &&
    maximumBranchGap >= interiorHeight * 0.035;
  const repeatedGridStructure =
    ignoredRowCount >= 4 &&
    ignoredColumnCount >= 2 &&
    ignoredRowBandCount >= 2 &&
    ignoredColumnBandCount >= 1;
  const compactGridStructure =
    ignoredRowCount >= 2 &&
    ignoredColumnCount >= 2 &&
    ignoredRowBandCount >= 1 &&
    ignoredColumnBandCount >= 1;
  // Tables can contain numbers, glyphs, check marks or even real sparklines.
  // After the long cell borders are suppressed those repeated fragments can
  // look like several Curve segments. A plot grid may have the same straight
  // lines, but its distribution remains one dominant trace; reject only when
  // the repeated grid surrounds a fragmented or implausibly shallow trace.
  const tableGridArtifact =
    (repeatedGridStructure &&
      ((verticalVariation < 0.46 &&
        ((continuousCoverage < 0.45 &&
          (curvedSegmentCount >= 3 ||
            directionChangeCount >= 3)) ||
          (verticalVariation < 0.075 &&
            directionChangeCount >= 3))) ||
        // Deskewing a rotated table can make the greedy path jump between
        // distant cells and exaggerate its apparent y-range. The residual is
        // still unmistakably a highly fragmented lattice, unlike a true
        // multi-State Curve or the public demo's broad clipped valleys.
        (continuousCoverage < 0.16 &&
          curvedSegmentCount >= 10 &&
          directionChangeCount >= 4))) ||
    // A compact 2 × N table has only one internal row band, so it does not
    // satisfy the repeated-grid threshold above. If a seemingly multi-peak
    // trace stays inside that one shallow row while both row and column
    // separators cross the frame, the shared cell lattice is the primary
    // structure and must not become distribution data.
    (compactGridStructure &&
      continuousCoverage >= 0.72 &&
      verticalVariation < 0.22 &&
      directionChangeCount >= 3);
  const fullWidthTrace =
    (horizontalCoverage >= minimumFullWidthCoverage &&
      coherentTrace &&
      verticalVariation >= 0.045 &&
      contentHasWaveformTurn &&
      thinEnough &&
      !sharpSinglePeakArtifact) ||
    segmentedShallowTrace ||
    segmentedWaveformTrace ||
    clippedPlateauWaveform ||
    boundaryClippedShallowWaveform ||
    boundaryClippedValleyWaveform;
  const valid =
    !closedTwoBranchArtifact &&
    !closedLoopArtifact &&
    !simpleTwoBranchOutlineArtifact &&
    !clippedClosedOutlineArtifact &&
    !tableGridArtifact &&
    !textGlyphArtifact &&
    (fullWidthTrace ||
      (localizedSinglePeak && !straightSidedApex) ||
      repeatedIndependentStateArray);
  const score = clamp(
    horizontalCoverage * 0.34 +
      continuousCoverage * 0.38 +
      Math.min(0.18, curvedSegmentCoverage * 0.24) +
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
    lowResolutionRoundedApexLoss,
    fullWidthTrace,
    segmentedShallowTrace,
    segmentedWaveformTrace,
    physicallyFramedCompactMultiTurnWaveform,
    physicallyFramedCompactArchWaveform,
    repeatedSimpleArchWaveform,
    repeatedIndependentStateArray,
    highTurnFullWidthWaveform,
    compactHighTurnWaveform,
    wideSingleComponentScriptArtifact,
    clippedPlateauWaveform,
    boundaryClippedShallowWaveform,
    boundaryClippedValleyWaveform,
    peakPosition,
    peakProminence,
    singlePeakMonotonicity,
    traceSmoothness,
    roundedApexScore,
    linearDeviation,
    leftArmLinearDeviation,
    rightArmLinearDeviation,
    straightSidedApex,
    directionChangeCount,
    curvedSegmentCount,
    curvedSegmentCoverage,
    twoBranchCoverage,
    branchGapSmoothness,
    closedTwoBranchArtifact,
    enclosedHoleCoverage,
    closedLoopArtifact,
    simpleTwoBranchOutlineArtifact,
    clippedClosedOutlineArtifact,
    tableGridArtifact,
    textGlyphArtifact,
    repeatedGlyphComponentCount:
      repeatedGlyphTopology.componentCount,
    repeatedGlyphLikeComponentCount:
      repeatedGlyphTopology.glyphLikeComponentCount,
    repeatedGlyphInkFraction:
      repeatedGlyphTopology.glyphInkFraction,
    repeatedGlyphHorizontalSpan:
      repeatedGlyphTopology.horizontalSpan,
    repeatedGlyphMedianDensity:
      repeatedGlyphTopology.medianDensity,
    repeatedGlyphMedianColumnInkRatio:
      repeatedGlyphTopology.medianColumnInkRatio,
    repeatedGlyphMedianHeightRatio:
      repeatedGlyphTopology.medianHeightRatio,
    repeatedGlyphMedianAspectRatio:
      repeatedGlyphTopology.medianAspectRatio,
    repeatedGlyphSparseRibbonComponentCount:
      repeatedGlyphTopology.sparseRibbonComponentCount,
    repeatedGlyphSparseRibbonHorizontalCoverage:
      repeatedGlyphTopology.sparseRibbonHorizontalCoverage,
    repeatedGlyphDominantSparseRibbonWidth:
      repeatedGlyphTopology.dominantSparseRibbonWidth,
    rawRepeatedGlyphComponentCount:
      rawRepeatedGlyphTopology.componentCount,
    rawRepeatedGlyphLikeComponentCount:
      rawRepeatedGlyphTopology.glyphLikeComponentCount,
    rawRepeatedGlyphInkFraction:
      rawRepeatedGlyphTopology.glyphInkFraction,
    rawRepeatedGlyphHorizontalSpan:
      rawRepeatedGlyphTopology.horizontalSpan,
    rawRepeatedGlyphMedianDensity:
      rawRepeatedGlyphTopology.medianDensity,
    rawRepeatedGlyphMedianColumnInkRatio:
      rawRepeatedGlyphTopology.medianColumnInkRatio,
    rawRepeatedGlyphMedianHeightRatio:
      rawRepeatedGlyphTopology.medianHeightRatio,
    rawRepeatedGlyphMedianAspectRatio:
      rawRepeatedGlyphTopology.medianAspectRatio,
    rawRepeatedGlyphSparseRibbonComponentCount:
      rawRepeatedGlyphTopology.sparseRibbonComponentCount,
    rawRepeatedGlyphSparseRibbonHorizontalCoverage:
      rawRepeatedGlyphTopology.sparseRibbonHorizontalCoverage,
    rawRepeatedGlyphDominantSparseRibbonWidth:
      rawRepeatedGlyphTopology.dominantSparseRibbonWidth,
    rawRepeatedGlyphSimpleArchComponentCount:
      rawRepeatedGlyphTopology.simpleArchComponentCount,
    rawRepeatedGlyphSimpleArchComponentFraction:
      rawRepeatedGlyphTopology.simpleArchComponentFraction,
    rawRepeatedGlyphSimpleArchInkFraction:
      rawRepeatedGlyphTopology.simpleArchInkFraction,
    rawRepeatedGlyphSimpleArchHorizontalCoverage:
      rawRepeatedGlyphTopology.simpleArchHorizontalCoverage,
    ignoredRowCount,
    ignoredColumnCount,
    ignoredRowBandCount,
    ignoredColumnBandCount,
    topBoundaryCoverage,
    thinEnough,
    residualDensity,
    meanPixelsPerActiveColumn,
  };
}

function isAngularApexArtifact(evidence) {
  return (
    evidence.directionChangeCount <= 1 &&
    evidence.singlePeakMonotonicity >= 0.97 &&
    evidence.traceSmoothness < 0.91 &&
    evidence.leftArmLinearDeviation < 0.026 &&
    evidence.rightArmLinearDeviation < 0.026 &&
    !evidence.lowResolutionRoundedApexLoss
  );
}

/**
 * A union of two or more overlapping colored traces can look vertically dense
 * or fragmented to the single-path waveform gate. Measure each chromatic mask
 * independently and admit the physical plot frame when at least two colors
 * each form a coherent, near-full-width distribution. Short legend swatches,
 * differently colored State segments and colored table cells do not satisfy
 * the full-width continuity constraints.
 */
function buildAchromaticCurveResidual(
  curveEvidenceMask,
  curveColorMasks,
  width,
) {
  if (
    !curveEvidenceMask ||
    !Array.isArray(curveColorMasks) ||
    !curveColorMasks.length
  ) {
    return null;
  }
  const height = Math.floor(
    curveEvidenceMask.length / Math.max(1, width),
  );
  const chromaticExclusion = new Uint8Array(
    curveEvidenceMask.length,
  );
  for (const colorMask of curveColorMasks) {
    if (colorMask.length !== curveEvidenceMask.length) continue;
    for (let index = 0; index < colorMask.length; index += 1) {
      if (!colorMask[index]) continue;
      const x = index % width;
      const y = Math.floor(index / width);
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
          chromaticExclusion[localY * width + localX] = 1;
        }
      }
    }
  }
  const residual = new Uint8Array(curveEvidenceMask.length);
  for (let index = 0; index < residual.length; index += 1) {
    if (
      curveEvidenceMask[index] &&
      !chromaticExclusion[index]
    ) {
      residual[index] = 1;
    }
  }
  return residual;
}

function measureColorSeriesCurveEvidence(
  candidate,
  curveColorMasks,
  achromaticCurveMask,
  width,
) {
  if (!Array.isArray(curveColorMasks)) {
    return {
      seriesCount: 0,
      evidences: [],
      score: 0,
    };
  }
  const colorEvidences = curveColorMasks
    .map((mask, sourceIndex) => ({
      sourceIndex,
      evidence: measureChartCurveEvidence(
        candidate,
        mask,
        width,
      ),
    }))
    .filter(
      ({ evidence }) =>
        evidence.valid &&
        !evidence.tableGridArtifact &&
        evidence.horizontalCoverage >= 0.62 &&
        evidence.continuousCoverage >= 0.5 &&
        evidence.verticalVariation >= 0.045 &&
        evidence.thinEnough,
    );
  const chromaticUnionMask = new Uint8Array(
    curveColorMasks[0]?.length ?? 0,
  );
  for (const colorMask of curveColorMasks) {
    if (colorMask.length !== chromaticUnionMask.length) continue;
    for (let index = 0; index < colorMask.length; index += 1) {
      if (colorMask[index]) chromaticUnionMask[index] = 1;
    }
  }
  const chromaticUnionEvidence =
    !colorEvidences.length && chromaticUnionMask.length
      ? measureChartCurveEvidence(
          candidate,
          chromaticUnionMask,
          width,
        )
      : null;
  const validChromaticUnionEvidence =
    chromaticUnionEvidence?.valid &&
    !chromaticUnionEvidence.tableGridArtifact &&
    chromaticUnionEvidence.horizontalCoverage >= 0.62 &&
    chromaticUnionEvidence.continuousCoverage >= 0.5 &&
    chromaticUnionEvidence.verticalVariation >= 0.045 &&
    chromaticUnionEvidence.thinEnough
      ? chromaticUnionEvidence
      : null;
  const chromaticEvidences = validChromaticUnionEvidence
    ? [
        {
          sourceIndex: 0,
          separationMode: "chromatic-union",
          evidence: validChromaticUnionEvidence,
        },
      ]
    : colorEvidences;
  const achromaticEvidence = achromaticCurveMask
    ? measureChartCurveEvidence(
        candidate,
        achromaticCurveMask,
        width,
      )
    : null;
  const validAchromaticEvidence =
    chromaticEvidences.length >= 1 &&
    achromaticEvidence?.valid &&
    !achromaticEvidence.tableGridArtifact &&
    achromaticEvidence.horizontalCoverage >= 0.62 &&
    achromaticEvidence.continuousCoverage >= 0.5 &&
    achromaticEvidence.verticalVariation >= 0.045 &&
    achromaticEvidence.thinEnough
      ? achromaticEvidence
      : null;
  const evidences = validAchromaticEvidence
    ? [
        ...chromaticEvidences,
        {
          sourceIndex: curveColorMasks.length,
          separationMode: "achromatic",
          evidence: validAchromaticEvidence,
        },
      ]
    : chromaticEvidences;
  return {
    seriesCount: evidences.length,
    evidences,
    score: evidences.length
      ? evidences.reduce(
          (sum, { evidence }) => sum + evidence.score,
          0,
        ) / evidences.length
      : 0,
  };
}

function measureWholeImageSeriesEvidence(
  broadMask,
  salientMask,
  curveEvidenceMask,
  curveColorMasks,
  width,
  height,
) {
  if (
    !curveEvidenceMask ||
    !Array.isArray(curveColorMasks) ||
    !curveColorMasks.length
  ) {
    return null;
  }
  const wholeImageCandidate = {
    left: 0,
    top: 0,
    right: width - 1,
    bottom: height - 1,
    axisMode: "content",
  };
  const originalAchromaticCurveMask =
    buildAchromaticCurveResidual(
      curveEvidenceMask,
      curveColorMasks,
      width,
    );
  const originalEvidence =
    measureColorSeriesCurveEvidence(
      wholeImageCandidate,
      curveColorMasks,
      originalAchromaticCurveMask,
      width,
    );
  const deskewed = deskewForegroundMasks(
    broadMask,
    salientMask ?? broadMask,
    width,
    height,
    curveEvidenceMask,
  );
  if (!deskewed.applied) {
    return originalEvidence.seriesCount >= 2
      ? {
          ...originalEvidence,
          angle: 0,
          applied: false,
        }
      : null;
  }
  const rotatedColorMasks = curveColorMasks.map((mask) =>
    rotateBinaryMask(
      mask,
      width,
      height,
      deskewed.angle,
    ),
  );
  const achromaticCurveMask =
    buildAchromaticCurveResidual(
      deskewed.rawCurveSalientMask,
      rotatedColorMasks,
      width,
    );
  const deskewedEvidence = {
    ...measureColorSeriesCurveEvidence(
      wholeImageCandidate,
      rotatedColorMasks,
      achromaticCurveMask,
      width,
    ),
    angle: deskewed.angle,
    applied: true,
  };
  return deskewedEvidence.seriesCount >= 2
    ? deskewedEvidence
    : originalEvidence.seriesCount >= 2
      ? {
          ...originalEvidence,
          angle: 0,
          applied: false,
        }
      : null;
}

function dominantLineBands(
  mask,
  width,
  height,
  orientation,
) {
  const lineCount =
    orientation === "horizontal" ? height : width;
  const lineLength =
    orientation === "horizontal" ? width : height;
  // Preserve every genuinely blank pixel. Even a one-pixel PPT gutter
  // separates independent frames, while rotated/JPEG table rules are repaired
  // before they enter this projection pass.
  const maximumGap = 0;
  const qualifying = new Uint8Array(lineCount);
  const strengths = new Float32Array(lineCount);

  for (let coordinate = 0; coordinate < lineCount; coordinate += 1) {
    let activeCount = 0;
    let runCount = 0;
    let substantialRunCount = 0;
    let runStart = -1;
    let lastActive = -1;
    let longestSpan = 0;
    const finishRun = () => {
      if (runStart < 0) return;
      const span = lastActive - runStart + 1;
      runCount += 1;
      if (span / Math.max(1, lineLength) >= 0.12) {
        substantialRunCount += 1;
      }
      longestSpan = Math.max(
        longestSpan,
        span,
      );
      runStart = -1;
      lastActive = -1;
    };
    for (let position = 0; position < lineLength; position += 1) {
      const index =
        orientation === "horizontal"
          ? coordinate * width + position
          : position * width + coordinate;
      if (mask[index]) {
        activeCount += 1;
        if (runStart < 0) runStart = position;
        lastActive = position;
      } else if (
        runStart >= 0 &&
        position - lastActive > maximumGap
      ) {
        finishRun();
      }
    }
    finishRun();
    const activeCoverage =
      activeCount / Math.max(1, lineLength);
    const longestCoverage =
      longestSpan / Math.max(1, lineLength);
    if (
      longestCoverage >= 0.45 ||
      (activeCoverage >= 0.58 &&
        substantialRunCount <= 2 &&
        runCount <= 3)
    ) {
      qualifying[coordinate] = 1;
      strengths[coordinate] = Math.max(
        activeCoverage,
        longestCoverage,
      );
    }
  }

  const bands = [];
  let start = -1;
  const finishBand = (end) => {
    if (start < 0) return;
    let coordinate = start;
    for (let current = start + 1; current <= end; current += 1) {
      if (strengths[current] > strengths[coordinate]) {
        coordinate = current;
      }
    }
    bands.push({
      start,
      end,
      coordinate,
      strength: strengths[coordinate],
    });
    start = -1;
  };
  for (let coordinate = 0; coordinate < lineCount; coordinate += 1) {
    if (qualifying[coordinate]) {
      if (start < 0) start = coordinate;
    } else {
      finishBand(coordinate - 1);
    }
  }
  finishBand(lineCount - 1);
  return bands;
}

function measureDominantDocumentLattice(
  mask,
  width,
  height,
) {
  const horizontalBands = dominantLineBands(
    mask,
    width,
    height,
    "horizontal",
  );
  const verticalBands = dominantLineBands(
    mask,
    width,
    height,
    "vertical",
  );
  if (
    horizontalBands.length < 3 ||
    verticalBands.length < 3
  ) {
    return {
      dominant: false,
      horizontalBandCount: horizontalBands.length,
      verticalBandCount: verticalBands.length,
      horizontalBands,
      verticalBands,
      intersectionCount: 0,
      bounds: undefined,
    };
  }

  const intersectionRadius = Math.max(
    2,
    Math.round(Math.min(width, height) * 0.004),
  );
  let intersectionCount = 0;
  for (const horizontal of horizontalBands) {
    for (const vertical of verticalBands) {
      let intersects = false;
      for (
        let y = Math.max(
          0,
          horizontal.start - intersectionRadius,
        );
        y <=
          Math.min(
            height - 1,
            horizontal.end + intersectionRadius,
          ) && !intersects;
        y += 1
      ) {
        for (
          let x = Math.max(
            0,
            vertical.start - intersectionRadius,
          );
          x <=
          Math.min(
            width - 1,
            vertical.end + intersectionRadius,
          );
          x += 1
        ) {
          if (mask[y * width + x]) {
            intersects = true;
            break;
          }
        }
      }
      if (intersects) intersectionCount += 1;
    }
  }
  const possibleIntersections =
    horizontalBands.length * verticalBands.length;
  const minimumIntersections = Math.max(
    6,
    Math.ceil(possibleIntersections * 0.28),
  );
  const dominant =
    intersectionCount >= minimumIntersections;
  const medianSpacing = (bands) => {
    const spacings = bands
      .slice(1)
      .map(
        (band, index) =>
          band.coordinate - bands[index].coordinate,
      )
      .sort((left, right) => left - right);
    return spacings.length
      ? spacings[Math.floor(spacings.length / 2)]
      : 0;
  };
  const horizontalPadding = Math.round(
    medianSpacing(verticalBands) * 0.55,
  );
  const verticalPadding = Math.round(
    medianSpacing(horizontalBands) * 0.55,
  );
  return {
    dominant,
    horizontalBandCount: horizontalBands.length,
    verticalBandCount: verticalBands.length,
    horizontalBands,
    verticalBands,
    intersectionCount,
    bounds: dominant
      ? {
          left: Math.max(
            0,
            verticalBands[0].start - horizontalPadding,
          ),
          top: Math.max(
            0,
            horizontalBands[0].start - verticalPadding,
          ),
          right: Math.min(
            width - 1,
            verticalBands.at(-1).end + horizontalPadding,
          ),
          bottom: Math.min(
            height - 1,
            horizontalBands.at(-1).end + verticalPadding,
          ),
        }
      : undefined,
  };
}

function analyzeAxisAlignedDocumentLattice(
  broadMask,
  width,
  height,
) {
  const lattice = measureDominantDocumentLattice(
    broadMask,
    width,
    height,
  );
  if (!lattice.dominant) {
    return {
      ...lattice,
      tableGridArtifact: false,
      broadEvidence: undefined,
    };
  }
  const broadEvidence = measureChartCurveEvidence(
    {
      left: 0,
      top: 0,
      right: width - 1,
      bottom: height - 1,
      axisMode: "content",
    },
    broadMask,
    width,
  );
  const confinedFragmentedLattice =
    broadEvidence.ignoredRowBandCount >= 3 &&
    broadEvidence.ignoredColumnBandCount >= 3 &&
    broadEvidence.continuousCoverage < 0.7 &&
    broadEvidence.verticalVariation < 0.3 &&
    broadEvidence.directionChangeCount >= 4;
  return {
    ...lattice,
    tableGridArtifact:
      broadEvidence.tableGridArtifact ||
      !broadEvidence.valid ||
      confinedFragmentedLattice,
    broadEvidence,
  };
}

function analyzeCandidateLocalLattice(
  candidate,
  broadMask,
  width,
  height,
  { allowDocumentScale = false } = {},
) {
  const localWidth = candidate.right - candidate.left + 1;
  const localHeight = candidate.bottom - candidate.top + 1;
  if (
    !broadMask ||
    localWidth < 48 ||
    localHeight < 36 ||
    (!allowDocumentScale &&
      localWidth * localHeight > width * height * 0.7)
  ) {
    return null;
  }
  const localMask = new Uint8Array(localWidth * localHeight);
  for (let localY = 0; localY < localHeight; localY += 1) {
    const sourceStart =
      (candidate.top + localY) * width + candidate.left;
    localMask.set(
      broadMask.subarray(sourceStart, sourceStart + localWidth),
      localY * localWidth,
    );
  }
  return analyzeAxisAlignedDocumentLattice(
    localMask,
    localWidth,
    localHeight,
  );
}

function candidateHasLocalTableLattice(
  candidate,
  broadMask,
  width,
  height,
) {
  return (
    analyzeCandidateLocalLattice(
      candidate,
      broadMask,
      width,
      height,
    )?.tableGridArtifact === true
  );
}

function measureVerticalGuideWaveformCrossings(
  candidate,
  localLattice,
  curveResidualMask,
  originalCurveMask,
  width,
  height,
) {
  const candidateWidth =
    candidate.right - candidate.left + 1;
  const candidateHeight =
    candidate.bottom - candidate.top + 1;
  const edgeInset = Math.max(
    3,
    Math.round(candidateWidth * 0.025),
  );
  const supportRadius = clamp(
    Math.round(candidateWidth * 0.009),
    4,
    10,
  );
  const yTolerance = clamp(
    Math.round(candidateHeight * 0.055),
    5,
    24,
  );
  const internalBands = localLattice.verticalBands.filter(
    (band) =>
      band.coordinate >= edgeInset &&
      band.coordinate <= candidateWidth - edgeInset - 1,
  );
  let crossingCount = 0;
  for (const band of internalBands) {
    const absoluteLeftEdge =
      candidate.left + band.start;
    const absoluteRightEdge =
      candidate.left + band.end;
    const leftRows = new Uint8Array(candidateHeight);
    const rightRows = new Uint8Array(candidateHeight);
    for (
      let x = Math.max(
        candidate.left,
        absoluteLeftEdge - supportRadius,
      );
      x < absoluteLeftEdge;
      x += 1
    ) {
      for (
        let y = Math.max(0, candidate.top);
        y <= Math.min(height - 1, candidate.bottom);
        y += 1
      ) {
        if (curveResidualMask[y * width + x]) {
          leftRows[y - candidate.top] = 1;
        }
      }
    }
    for (
      let x = absoluteRightEdge + 1;
      x <=
      Math.min(
        candidate.right,
        absoluteRightEdge + supportRadius,
      );
      x += 1
    ) {
      for (
        let y = Math.max(0, candidate.top);
        y <= Math.min(height - 1, candidate.bottom);
        y += 1
      ) {
        if (curveResidualMask[y * width + x]) {
          rightRows[y - candidate.top] = 1;
        }
      }
    }
    let aligned = false;
    for (
      let localY = 0;
      localY < candidateHeight && !aligned;
      localY += 1
    ) {
      if (!leftRows[localY]) continue;
      for (
        let nearbyY = Math.max(0, localY - yTolerance);
        nearbyY <=
        Math.min(
          candidateHeight - 1,
          localY + yTolerance,
        );
        nearbyY += 1
      ) {
        if (rightRows[nearbyY]) {
          aligned = true;
          break;
        }
      }
    }
    if (!aligned && originalCurveMask) {
      const maximumLocalBridgeSpan = Math.max(
        10,
        Math.round(candidateWidth * 0.12),
      );
      const minimumY = Math.max(
        0,
        candidate.top +
          Math.round(candidateHeight * 0.03),
      );
      const maximumY = Math.min(
        height - 1,
        candidate.bottom -
          Math.round(candidateHeight * 0.03),
      );
      for (
        let y = minimumY;
        y <= maximumY && !aligned;
        y += 1
      ) {
        let leftSpan = 0;
        for (
          let x = absoluteLeftEdge - 1;
          x >= candidate.left &&
          leftSpan <= maximumLocalBridgeSpan;
          x -= 1
        ) {
          if (!originalCurveMask[y * width + x]) break;
          leftSpan += 1;
        }
        if (leftSpan < 1) continue;
        let rightSpan = 0;
        for (
          let x = absoluteRightEdge + 1;
          x <= candidate.right &&
          rightSpan <= maximumLocalBridgeSpan;
          x += 1
        ) {
          if (!originalCurveMask[y * width + x]) break;
          rightSpan += 1;
        }
        const totalSpan =
          leftSpan +
          rightSpan +
          (absoluteRightEdge - absoluteLeftEdge + 1);
        if (
          rightSpan >= 1 &&
          totalSpan <= maximumLocalBridgeSpan
        ) {
          aligned = true;
        }
      }
    }
    if (aligned) crossingCount += 1;
  }
  const minimumCrossingCount = Math.max(
    1,
    Math.ceil(internalBands.length * 0.9),
  );
  return {
    crossingCount,
    internalBandCount: internalBands.length,
    valid:
      internalBands.length >= 1 &&
      crossingCount >= minimumCrossingCount,
  };
}

function analyzeExtendedDeskewedDocument(
  broadMask,
  curveEvidenceMask,
  width,
  height,
) {
  const estimate = estimateDeskewAngle(
    broadMask,
    width,
    height,
    {
      maximumAngle: 18,
      step: 0.5,
    },
  );
  if (!estimate.applied || Math.abs(estimate.angle) < 1.5) {
    return {
      applied: false,
      tableGridArtifact: false,
      curveEvidence: undefined,
      broadEvidence: undefined,
      lattice: undefined,
      ...estimate,
    };
  }
  const rotatedBroadMask = repairLowResolutionLineMask(
    rotateBinaryMask(
      broadMask,
      width,
      height,
      estimate.angle,
    ),
    width,
    height,
    { maximumGap: 3 },
  ).mask;
  const rotatedCurveMask = rotateBinaryMask(
    curveEvidenceMask,
    width,
    height,
    estimate.angle,
  );
  const curveEvidence = measureChartCurveEvidence(
    {
      left: 0,
      top: 0,
      right: width - 1,
      bottom: height - 1,
      axisMode: "content",
    },
    rotatedCurveMask,
    width,
  );
  const lattice = measureDominantDocumentLattice(
    rotatedBroadMask,
    width,
    height,
  );
  const broadEvidence = lattice.dominant
    ? measureChartCurveEvidence(
        {
          left: 0,
          top: 0,
          right: width - 1,
          bottom: height - 1,
          axisMode: "content",
        },
        rotatedBroadMask,
        width,
      )
    : undefined;
  const confinedFragmentedLattice =
    lattice.dominant &&
    broadEvidence.ignoredRowBandCount >= 3 &&
    broadEvidence.ignoredColumnBandCount >= 3 &&
    broadEvidence.continuousCoverage < 0.7 &&
    broadEvidence.verticalVariation < 0.3 &&
    broadEvidence.directionChangeCount >= 4;
  return {
    ...estimate,
    applied: true,
    tableGridArtifact:
      lattice.dominant &&
      (broadEvidence.tableGridArtifact ||
        !broadEvidence.valid ||
        confinedFragmentedLattice),
    curveEvidence,
    broadEvidence,
    lattice,
  };
}

function recoverDeskewedPhysicalFrame(
  broadMask,
  salientMask,
  curveEvidenceMask,
  spatialCandidates,
  width,
  height,
) {
  if (
    !broadMask ||
    !salientMask ||
    !curveEvidenceMask ||
    spatialCandidates.length < 2
  ) {
    return null;
  }
  const deskewed = deskewForegroundMasks(
    broadMask,
    salientMask,
    width,
    height,
    curveEvidenceMask,
  );
  if (!deskewed.applied) return null;
  const deskewedBounds = detectPlotBounds(
    deskewed.salientMask,
    width,
    height,
  );
  if (
    !deskewedBounds.axesDetected ||
    !["rectangle", "l-axis"].includes(
      deskewedBounds.axisMode,
    ) ||
    area(deskewedBounds) < width * height * 0.28
  ) {
    return null;
  }
  const deskewedBroadEvidence = measureChartCurveEvidence(
    {
      left: 0,
      top: 0,
      right: width - 1,
      bottom: height - 1,
      axisMode: "content",
    },
    deskewed.broadMask,
    width,
  );
  const deskewedCurveEvidence =
    deskewedBroadEvidence.valid &&
    !deskewedBroadEvidence.textGlyphArtifact
      ? null
      : measureChartCurveEvidence(
          {
            left: 0,
            top: 0,
            right: width - 1,
            bottom: height - 1,
            axisMode: "content",
          },
          deskewed.curveSalientMask,
          width,
        );
  // Broad ink is authoritative for ordinary slides because it exposes text
  // cards and diagram furniture. A real rotated plot may nevertheless make
  // that broad mask text-like through labels and grid intersections. Permit
  // the Curve-only hypothesis only when one independently connected sparse
  // ribbon dominates the raw salience mask.
  const deskewedWholeEvidence =
    deskewedCurveEvidence?.valid &&
    !deskewedCurveEvidence.textGlyphArtifact &&
    !deskewedCurveEvidence.tableGridArtifact &&
    deskewedCurveEvidence
      .rawRepeatedGlyphDominantSparseRibbonWidth >= 0.5
      ? deskewedCurveEvidence
      : deskewedBroadEvidence;
  if (
    !deskewedWholeEvidence.valid ||
    deskewedWholeEvidence.tableGridArtifact ||
    deskewedWholeEvidence.textGlyphArtifact
  ) {
    return null;
  }
  const radians = (-deskewed.angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const inverseRotate = (x, y) => {
    const localX = x - centerX;
    const localY = y - centerY;
    return {
      x: cosine * localX - sine * localY + centerX,
      y: sine * localX + cosine * localY + centerY,
    };
  };
  const sourceCorners = [
    [deskewedBounds.left, deskewedBounds.top],
    [deskewedBounds.right, deskewedBounds.top],
    [deskewedBounds.left, deskewedBounds.bottom],
    [deskewedBounds.right, deskewedBounds.bottom],
  ].map(([x, y]) => inverseRotate(x, y));
  const sourceBounds = {
    left: clamp(
      Math.floor(
        Math.min(...sourceCorners.map(({ x }) => x)),
      ),
      0,
      width - 1,
    ),
    top: clamp(
      Math.floor(
        Math.min(...sourceCorners.map(({ y }) => y)),
      ),
      0,
      height - 1,
    ),
    right: clamp(
      Math.ceil(
        Math.max(...sourceCorners.map(({ x }) => x)),
      ),
      0,
      width - 1,
    ),
    bottom: clamp(
      Math.ceil(
        Math.max(...sourceCorners.map(({ y }) => y)),
      ),
      0,
      height - 1,
    ),
    axisMode: deskewedBounds.axisMode,
  };
  const insideCandidates = spatialCandidates.filter(
    (candidate) =>
      intersectionArea(sourceBounds, candidate) /
        Math.max(1, area(candidate)) >=
      0.55,
  );
  if (insideCandidates.length < 2) return null;
  const outsideCandidates = spatialCandidates.filter(
    (candidate) =>
      intersectionArea(sourceBounds, candidate) /
        Math.max(1, area(candidate)) <
      0.35,
  );
  return {
    candidate: {
      ...sourceBounds,
      confidence: clamp(
        0.72 + deskewedWholeEvidence.score * 0.24,
        0,
        0.97,
      ),
      detectionScale: "deskewed-physical",
      detectionReason: "deskewed-salient-frame",
      curveEvidence: {
        ...deskewedWholeEvidence,
        valid: true,
        deskewedPhysicalFrame: true,
        deskewAngle: deskewed.angle,
      },
    },
    insideCandidateCount: insideCandidates.length,
    outsideCandidateCount: outsideCandidates.length,
    angle: deskewed.angle,
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
  options = {},
) {
  const minimumGutter = Math.max(
    1,
    Math.round(Math.min(width, height) * 0.001),
  );
  const measureRegion = (left, top, right, bottom) => {
    if (right < left || bottom < top) {
      return {
        density: 1,
        activeColumnCoverage: 1,
        activeRowCoverage: 1,
      };
    }
    const regionWidth = right - left + 1;
    const regionHeight = bottom - top + 1;
    const step = Math.max(
      1,
      regionWidth <= 64 || regionHeight <= 64
        ? 1
        : Math.ceil(
            Math.sqrt(
              (regionWidth * regionHeight) / 4_000,
            ),
          ),
    );
    let active = 0;
    let pixels = 0;
    const activeColumns = new Uint8Array(
      Math.ceil(regionWidth / step),
    );
    const activeRows = new Uint8Array(
      Math.ceil(regionHeight / step),
    );
    let sampledY = 0;
    for (let y = top; y <= bottom; y += step) {
      let sampledX = 0;
      for (let x = left; x <= right; x += step) {
        if (mask[y * width + x]) {
          active += 1;
          activeColumns[sampledX] = 1;
          activeRows[sampledY] = 1;
        }
        pixels += 1;
        sampledX += 1;
      }
      sampledY += 1;
    }
    return {
      density: active / Math.max(1, pixels),
      activeColumnCoverage:
        activeColumns.reduce((sum, value) => sum + value, 0) /
        Math.max(1, activeColumns.length),
      activeRowCoverage:
        activeRows.reduce((sum, value) => sum + value, 0) /
        Math.max(1, activeRows.length),
    };
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
    const separation = measureRegion(
      first.right + 1,
      Math.max(first.top, second.top),
      second.left - 1,
      Math.min(first.bottom, second.bottom),
    );
    const typicalHeight = Math.max(
      first.bottom - first.top + 1,
      second.bottom - second.top + 1,
    );
    const extendedSeparation = measureRegion(
      first.right + 1,
      Math.max(
        0,
        Math.min(first.top, second.top) -
          Math.round(typicalHeight * 0.2),
      ),
      second.left - 1,
      Math.min(
        height - 1,
        Math.max(first.bottom, second.bottom) +
          Math.round(typicalHeight * 0.8),
      ),
    );
    // A thin Curve can contribute only one or two pixels per column, making
    // its area density look like a blank gutter. Column continuity preserves
    // those State-to-State bridges while a true inter-chart gutter remains
    // empty even when it is only a few pixels wide.
    return (
      separation.density <= 0.025 &&
      separation.activeColumnCoverage <= 0.2 &&
      (options.localOnly === true ||
        extendedSeparation.activeColumnCoverage <= 0.65)
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
      options,
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
    const separation = measureRegion(
      Math.max(first.left, second.left),
      first.bottom + 1,
      Math.min(first.right, second.right),
      second.top - 1,
    );
    return (
      separation.density <= 0.025 &&
      separation.activeRowCoverage <= 0.2
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
      options,
    );
  }
  return false;
}

function findClearVerticalCurveCorridor(
  first,
  second,
  mask,
  width,
  height,
) {
  if (!mask) return null;
  const firstCenter = (first.left + first.right) / 2;
  const secondCenter = (second.left + second.right) / 2;
  if (Math.abs(firstCenter - secondCenter) < 2) return null;
  const leftCandidate =
    firstCenter < secondCenter ? first : second;
  const rightCandidate =
    leftCandidate === first ? second : first;
  const verticalOverlap = overlapLength(
    leftCandidate.top,
    leftCandidate.bottom,
    rightCandidate.top,
    rightCandidate.bottom,
  );
  if (
    verticalOverlap <
    Math.min(
      leftCandidate.bottom - leftCandidate.top + 1,
      rightCandidate.bottom - rightCandidate.top + 1,
    ) *
      0.35
  ) {
    return null;
  }
  const typicalWidth = Math.min(
    leftCandidate.right - leftCandidate.left + 1,
    rightCandidate.right - rightCandidate.left + 1,
  );
  const typicalHeight = Math.max(
    leftCandidate.bottom - leftCandidate.top + 1,
    rightCandidate.bottom - rightCandidate.top + 1,
  );
  const boundaryCenter =
    (leftCandidate.right + rightCandidate.left) / 2;
  const searchRadius = clamp(
    Math.round(typicalWidth * 0.08),
    10,
    36,
  );
  const searchLeft = clamp(
    Math.floor(boundaryCenter - searchRadius),
    0,
    width - 1,
  );
  const searchRight = clamp(
    Math.ceil(boundaryCenter + searchRadius),
    searchLeft,
    width - 1,
  );
  const searchTop = clamp(
    Math.min(leftCandidate.top, rightCandidate.top) -
      Math.round(typicalHeight * 0.2),
    0,
    height - 1,
  );
  const searchBottom = clamp(
    Math.max(leftCandidate.bottom, rightCandidate.bottom) +
      Math.round(typicalHeight * 0.8),
    searchTop,
    height - 1,
  );
  const activeColumns = new Uint8Array(
    searchRight - searchLeft + 1,
  );
  for (let x = searchLeft; x <= searchRight; x += 1) {
    for (let y = searchTop; y <= searchBottom; y += 1) {
      if (mask[y * width + x]) {
        activeColumns[x - searchLeft] = 1;
        break;
      }
    }
  }
  const corridors = [];
  for (let index = 0; index < activeColumns.length; index += 1) {
    if (activeColumns[index]) continue;
    const start = index;
    while (
      index + 1 < activeColumns.length &&
      !activeColumns[index + 1]
    ) {
      index += 1;
    }
    const end = index;
    if (end - start + 1 < 2) continue;
    const hasLeftSupport = activeColumns
      .subarray(Math.max(0, start - 8), start)
      .some(Boolean);
    const hasRightSupport = activeColumns
      .subarray(
        end + 1,
        Math.min(activeColumns.length, end + 9),
      )
      .some(Boolean);
    if (!hasLeftSupport || !hasRightSupport) continue;
    const left = searchLeft + start;
    const right = searchLeft + end;
    let globallyBlank = true;
    for (let x = left; x <= right && globallyBlank; x += 1) {
      for (let y = 0; y < height; y += 1) {
        if (mask[y * width + x]) {
          globallyBlank = false;
          break;
        }
      }
    }
    // A deep log-scale valley can leave a temporary hole inside the local
    // candidate band while continuing farther down the same columns. Only a
    // genuinely blank document corridor may separate physical charts.
    if (!globallyBlank) continue;
    corridors.push({
      left,
      right,
      distance: Math.abs((left + right) / 2 - boundaryCenter),
    });
  }
  return (
    corridors.sort(
      (left, right) =>
        left.distance - right.distance ||
        right.right -
          right.left -
          (left.right - left.left),
    )[0] ?? null
  );
}

function clipCandidatesAtClearVerticalCorridors(
  candidates,
  curveEvidenceMask,
  width,
  height,
) {
  const clipped = candidates.map((candidate) => ({
    ...candidate,
  }));
  for (let firstIndex = 0; firstIndex < clipped.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < clipped.length;
      secondIndex += 1
    ) {
      const first = clipped[firstIndex];
      const second = clipped[secondIndex];
      const corridor = findClearVerticalCurveCorridor(
        first,
        second,
        curveEvidenceMask,
        width,
        height,
      );
      if (!corridor) continue;
      const firstCenter = (first.left + first.right) / 2;
      const secondCenter = (second.left + second.right) / 2;
      const leftCandidate =
        firstCenter < secondCenter ? first : second;
      const rightCandidate =
        leftCandidate === first ? second : first;
      if (
        corridor.left - leftCandidate.left < 4 ||
        rightCandidate.right - corridor.right < 4
      ) {
        continue;
      }
      leftCandidate.right = Math.min(
        leftCandidate.right,
        corridor.left - 1,
      );
      rightCandidate.left = Math.max(
        rightCandidate.left,
        corridor.right + 1,
      );
    }
  }
  return clipped;
}

function clipSpatialCandidateAtInternalEdgeGutter(
  candidate,
  curveEvidenceMask,
  width,
  height,
) {
  if (
    candidate.axisMode !== "content" ||
    !curveEvidenceMask
  ) {
    return candidate;
  }
  const candidateWidth =
    candidate.right - candidate.left + 1;
  const candidateHeight =
    candidate.bottom - candidate.top + 1;
  if (candidateWidth < 32 || candidateHeight < 16) {
    return candidate;
  }
  const searchTop = clamp(
    candidate.top - Math.round(candidateHeight * 0.2),
    0,
    height - 1,
  );
  const searchBottom = clamp(
    candidate.bottom + Math.round(candidateHeight * 0.8),
    searchTop,
    height - 1,
  );
  const activeColumns = new Uint8Array(candidateWidth);
  for (let localX = 0; localX < candidateWidth; localX += 1) {
    const x = candidate.left + localX;
    for (let y = searchTop; y <= searchBottom; y += 1) {
      if (curveEvidenceMask[y * width + x]) {
        activeColumns[localX] = 1;
        break;
      }
    }
  }
  const edgeLimit = clamp(
    Math.round(candidateWidth * 0.08),
    12,
    36,
  );
  const corridors = [];
  for (let index = 0; index < activeColumns.length; index += 1) {
    if (activeColumns[index]) continue;
    const start = index;
    while (
      index + 1 < activeColumns.length &&
      !activeColumns[index + 1]
    ) {
      index += 1;
    }
    const end = index;
    if (end - start + 1 < 2) continue;
    const hasLeftSupport = activeColumns
      .subarray(Math.max(0, start - 8), start)
      .some(Boolean);
    const hasRightSupport = activeColumns
      .subarray(
        end + 1,
        Math.min(activeColumns.length, end + 9),
      )
      .some(Boolean);
    if (!hasLeftSupport || !hasRightSupport) continue;
    if (
      start <= edgeLimit ||
      activeColumns.length - end - 1 <= edgeLimit
    ) {
      corridors.push({ start, end });
    }
  }
  if (!corridors.length) return candidate;
  const corridor = corridors.sort(
    (left, right) =>
      Math.min(
        left.start,
        activeColumns.length - left.end - 1,
      ) -
      Math.min(
        right.start,
        activeColumns.length - right.end - 1,
      ),
  )[0];
  const leftSpan = corridor.start;
  const rightSpan =
    activeColumns.length - corridor.end - 1;
  if (leftSpan <= rightSpan) {
    return {
      ...candidate,
      left: candidate.left + corridor.end + 1,
      internalGutterClipped: true,
    };
  }
  return {
    ...candidate,
    right: candidate.left + corridor.start - 1,
    internalGutterClipped: true,
  };
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
    // Dense guide lines inside one physical plot can synthesize many
    // rectangle "children". When the line-suppressed residual independently
    // proves one Curve crossing those guide cells, the outer frame is the
    // chart itself rather than a composite card around separate panels.
    if (outer.curveEvidence?.guideGridWaveformRescue === true) {
      continue;
    }
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
            { localOnly: true },
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

export function fairlyBoundPreNmsCandidates(
  candidates,
  width,
  height,
  maximumCandidateCount = 512,
) {
  const safeMaximumCandidateCount = Math.max(
    1,
    Math.round(maximumCandidateCount),
  );
  const tileCount =
    PRE_NMS_SPATIAL_DIVISIONS *
    PRE_NMS_SPATIAL_DIVISIONS;
  const candidateTiles = Array.from(
    { length: tileCount },
    () => [],
  );
  const rankCandidates = (left, right) =>
    Number(Boolean(right.curveEvidence)) -
      Number(Boolean(left.curveEvidence)) ||
    (right.detectionReason === "shared-frame-cell") -
      (left.detectionReason === "shared-frame-cell") ||
    (right.detectionScale === "separation") -
      (left.detectionScale === "separation") ||
    (right.detectionScale === "strict") -
      (left.detectionScale === "strict") ||
    (right.edgeEvidence ?? 0) -
      (left.edgeEvidence ?? 0) ||
    (right.confidence ?? 0) -
      (left.confidence ?? 0) ||
    left.top - right.top ||
    left.left - right.left ||
    left.bottom - right.bottom ||
    left.right - right.right;

  for (const candidate of candidates) {
    const centerX = (candidate.left + candidate.right) / 2;
    const centerY = (candidate.top + candidate.bottom) / 2;
    const column = clamp(
      Math.floor(
        (centerX * PRE_NMS_SPATIAL_DIVISIONS) /
          Math.max(1, width),
      ),
      0,
      PRE_NMS_SPATIAL_DIVISIONS - 1,
    );
    const row = clamp(
      Math.floor(
        (centerY * PRE_NMS_SPATIAL_DIVISIONS) /
          Math.max(1, height),
      ),
      0,
      PRE_NMS_SPATIAL_DIVISIONS - 1,
    );
    candidateTiles[
      row * PRE_NMS_SPATIAL_DIVISIONS + column
    ].push(candidate);
  }
  if (candidates.length <= safeMaximumCandidateCount) {
    return {
      candidates: [...candidates],
      diagnostics: {
        rawCandidateCount: candidates.length,
        boundedCandidateCount: candidates.length,
        measurementBudget: safeMaximumCandidateCount,
        measurementBudgetHit: false,
        droppedCandidateCount: 0,
        tiles: candidateTiles.map((tile, tileIndex) => ({
          row: Math.floor(
            tileIndex / PRE_NMS_SPATIAL_DIVISIONS,
          ),
          column:
            tileIndex % PRE_NMS_SPATIAL_DIVISIONS,
          generatedCount: tile.length,
          retainedCount: tile.length,
          droppedCount: 0,
        })),
      },
    };
  }
  for (const tile of candidateTiles) {
    tile.sort(rankCandidates);
  }

  const boundedCandidates = [];
  const retainedTileCounts = new Uint16Array(tileCount);
  const maximumTileLength = Math.max(
    0,
    ...candidateTiles.map((tile) => tile.length),
  );
  for (
    let rankIndex = 0;
    rankIndex < maximumTileLength &&
    boundedCandidates.length < safeMaximumCandidateCount;
    rankIndex += 1
  ) {
    for (
      let tileIndex = 0;
      tileIndex < candidateTiles.length &&
      boundedCandidates.length < safeMaximumCandidateCount;
      tileIndex += 1
    ) {
      const candidate = candidateTiles[tileIndex][rankIndex];
      if (!candidate) continue;
      boundedCandidates.push(candidate);
      retainedTileCounts[tileIndex] += 1;
    }
  }

  return {
    candidates: boundedCandidates,
    diagnostics: {
      rawCandidateCount: candidates.length,
      boundedCandidateCount: boundedCandidates.length,
      measurementBudget: safeMaximumCandidateCount,
      measurementBudgetHit:
        candidates.length > boundedCandidates.length,
      droppedCandidateCount: Math.max(
        0,
        candidates.length - boundedCandidates.length,
      ),
      tiles: candidateTiles.map((tile, tileIndex) => {
        const retainedCount =
          retainedTileCounts[tileIndex];
        return {
          row: Math.floor(
            tileIndex / PRE_NMS_SPATIAL_DIVISIONS,
          ),
          column:
            tileIndex % PRE_NMS_SPATIAL_DIVISIONS,
          generatedCount: tile.length,
          retainedCount,
          droppedCount: Math.max(
            0,
            tile.length - retainedCount,
          ),
        };
      }),
    },
  };
}

function removeDuplicateAndGridCandidates(
  candidates,
  edgeEvidenceMask,
  curveEvidenceMask,
  separationEvidenceMask,
  width,
  height,
  compactMinimumAreaRatio,
  guideStructureMask = edgeEvidenceMask,
) {
  let straightRunResidual;
  const getStraightRunResidual = () => {
    if (!straightRunResidual) {
      straightRunResidual =
        suppressStraightRunsForSpatialRecovery(
          curveEvidenceMask,
          width,
          height,
        ).mask;
    }
    return straightRunResidual;
  };
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
  const maximumPreNmsMeasurementCount = 512;
  const candidatesWithEdgeEvidence = [
    ...uniqueCandidates.values(),
  ].map((candidate) => ({
      ...candidate,
      edgeEvidence: candidateEdgeEvidence(
        candidate,
        edgeEvidenceMask,
        width,
        height,
      ),
    }));
  const preNmsSelection = fairlyBoundPreNmsCandidates(
    candidatesWithEdgeEvidence,
    width,
    height,
    maximumPreNmsMeasurementCount,
  );
  const boundedCandidates = preNmsSelection.candidates;
  const withEdgeEvidence = removeCompositeContainers(
    boundedCandidates.map((candidate) => {
      const measuredEvidence =
        candidate.curveEvidence ??
        measureChartCurveEvidence(
          candidate,
          curveEvidenceMask,
          width,
        );
      let guideGridWaveformEvidence;
      let guideGridResidualEvidence;
      const canContainGuideGridWaveform =
        candidate.axisMode !== "content" &&
        candidate.detectionScale === "strict" &&
        !measuredEvidence.textGlyphArtifact &&
        area(candidate) >= width * height * 0.01 &&
        measuredEvidence.horizontalCoverage >= 0.62 &&
        measuredEvidence.continuousCoverage >= 0.55 &&
        measuredEvidence.verticalVariation >= 0.04 &&
        (measuredEvidence.directionChangeCount >= 1 ||
          measuredEvidence.localizedSinglePeak);
      const candidateLocalLattice =
        canContainGuideGridWaveform
          ? analyzeCandidateLocalLattice(
              candidate,
              guideStructureMask,
              width,
              height,
              { allowDocumentScale: true },
            )
          : null;
      const guideGridStructure =
        candidateLocalLattice != null &&
        candidateLocalLattice.horizontalBandCount >= 3 &&
        candidateLocalLattice.verticalBandCount >= 3;
      if (guideGridStructure) {
        const straightRunResidualMask =
          getStraightRunResidual();
        const residualEvidence = measureChartCurveEvidence(
          candidate,
          straightRunResidualMask,
          width,
        );
        guideGridResidualEvidence = residualEvidence;
        const guideCrossingEvidence =
          measureVerticalGuideWaveformCrossings(
            candidate,
            candidateLocalLattice,
            straightRunResidualMask,
            curveEvidenceMask,
            width,
            height,
          );
        const structurallyVerifiedTextLikeResidual =
          residualEvidence.textGlyphArtifact &&
          !measuredEvidence.textGlyphArtifact &&
          residualEvidence.fullWidthTrace &&
          residualEvidence.thinEnough &&
          guideCrossingEvidence.internalBandCount >= 3 &&
          guideCrossingEvidence.crossingCount ===
            guideCrossingEvidence.internalBandCount;
        const residualWaveformAdmissible =
          (residualEvidence.valid &&
            !residualEvidence.textGlyphArtifact) ||
          structurallyVerifiedTextLikeResidual;
        const crossesGuideCells =
          guideCrossingEvidence.valid &&
          residualWaveformAdmissible &&
          !measuredEvidence.textGlyphArtifact &&
          !residualEvidence.tableGridArtifact &&
          !residualEvidence.closedLoopArtifact &&
          !residualEvidence.closedTwoBranchArtifact &&
          residualEvidence.horizontalCoverage >= 0.68 &&
          Math.max(
            residualEvidence.continuousCoverage,
            measuredEvidence.continuousCoverage,
          ) >= 0.6 &&
          Math.max(
            residualEvidence.verticalVariation,
            measuredEvidence.verticalVariation,
          ) >= 0.045 &&
          residualEvidence.thinEnough &&
          (Math.max(
            residualEvidence.directionChangeCount,
            measuredEvidence.directionChangeCount,
          ) >= 1 ||
            residualEvidence.localizedSinglePeak);
        if (crossesGuideCells) {
          guideGridWaveformEvidence = {
            ...residualEvidence,
            valid: true,
            score: Math.max(
              residualEvidence.score,
              measuredEvidence.score,
            ),
            horizontalCoverage: Math.max(
              residualEvidence.horizontalCoverage,
              measuredEvidence.horizontalCoverage,
            ),
            continuousCoverage: Math.max(
              residualEvidence.continuousCoverage,
              measuredEvidence.continuousCoverage,
            ),
            verticalVariation: Math.max(
              residualEvidence.verticalVariation,
              measuredEvidence.verticalVariation,
            ),
            directionChangeCount: Math.max(
              residualEvidence.directionChangeCount,
              measuredEvidence.directionChangeCount,
            ),
            textGlyphArtifact: false,
            tableGridArtifact: false,
            guideGridWaveformRescue: true,
            guideGridResidualTextGlyphArtifact:
              residualEvidence.textGlyphArtifact === true,
            guideGridOriginalTableArtifact:
              measuredEvidence.tableGridArtifact === true,
            guideGridStructuralProof: true,
            guideGridCrossingCount:
              guideCrossingEvidence.crossingCount,
            guideGridInternalBandCount:
              guideCrossingEvidence.internalBandCount,
            guideGridIgnoredRowBandCount:
              measuredEvidence.ignoredRowBandCount,
            guideGridIgnoredColumnBandCount:
              measuredEvidence.ignoredColumnBandCount,
          };
        }
      }
      const microFrameSignal = measureMicroFrameSignal(
        candidate,
        curveEvidenceMask,
        separationEvidenceMask,
        width,
      );
      const fallbackCurveEvidence =
        !measuredEvidence.valid &&
        !measuredEvidence.textGlyphArtifact &&
        microFrameSignal?.valid
          ? {
              ...measuredEvidence,
              valid: true,
              score: Math.max(
                measuredEvidence.score,
                microFrameSignal.score,
              ),
              horizontalCoverage: Math.max(
                measuredEvidence.horizontalCoverage,
                0.4,
              ),
              continuousCoverage: Math.max(
                measuredEvidence.continuousCoverage,
                0.25,
              ),
              verticalVariation: Math.max(
                measuredEvidence.verticalVariation,
                0.12,
              ),
              microFrameSignalRescue: true,
              microFrameCurvePixelCount:
                microFrameSignal.curvePixelCount,
              microFrameBroadResidualPixelCount:
                microFrameSignal.broadResidualPixelCount,
            }
          : {
              ...measuredEvidence,
              guideGridResidualTextGlyphArtifact:
                guideGridResidualEvidence
                  ?.textGlyphArtifact === true,
              guideGridResidualRawGlyphLikeComponentCount:
                guideGridResidualEvidence
                  ?.rawRepeatedGlyphLikeComponentCount ?? 0,
              guideGridResidualRawGlyphInkFraction:
                guideGridResidualEvidence
                  ?.rawRepeatedGlyphInkFraction ?? 0,
              guideGridResidualRawGlyphMedianDensity:
                guideGridResidualEvidence
                  ?.rawRepeatedGlyphMedianDensity ?? 0,
              guideGridResidualRawGlyphMedianColumnInkRatio:
                guideGridResidualEvidence
                  ?.rawRepeatedGlyphMedianColumnInkRatio ?? 0,
              guideGridResidualHorizontalCoverage:
                guideGridResidualEvidence
                  ?.horizontalCoverage ?? 0,
              guideGridResidualContinuousCoverage:
                guideGridResidualEvidence
                  ?.continuousCoverage ?? 0,
              guideGridResidualVerticalVariation:
                guideGridResidualEvidence
                  ?.verticalVariation ?? 0,
              guideGridResidualDirectionChangeCount:
                guideGridResidualEvidence
                  ?.directionChangeCount ?? 0,
            };
      const curveEvidence =
        guideGridWaveformEvidence ?? fallbackCurveEvidence;
      return {
        ...candidate,
        // Validate before overlap suppression. Broken geometry must not
        // discard a lower-priority region whose Curve is more complete.
        curveEvidence,
      };
    }),
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
  const curveCompleteness = (candidate) => {
    const evidence = candidate.curveEvidence;
    if (
      !evidence?.valid ||
      evidence.textGlyphArtifact ||
      evidence.tableGridArtifact ||
      evidence.closedLoopArtifact ||
      evidence.closedTwoBranchArtifact ||
      (candidate.detectionReason ===
        "frameless-curve-region" &&
        evidence.continuousCoverage < 0.3 &&
        !evidence.segmentedWaveformTrace)
    ) {
      return 0;
    }
    return (
      1 +
      evidence.score * 0.35 +
      evidence.horizontalCoverage * 0.3 +
      evidence.continuousCoverage * 0.2 +
      Math.min(1, evidence.verticalVariation * 2) * 0.15
    );
  };
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
        (left.curveEvidence?.guideGridWaveformRescue === true
          ? 6
          : 0) +
        (left.detectionReason === "shared-frame-cell" ? 3 : 0) +
        (leftSeparation ? 2 : 0) +
        (left.detectionScale === "strict" ? 1 : 0);
      const rightPriority =
        (right.curveEvidence?.guideGridWaveformRescue === true
          ? 6
          : 0) +
        (right.detectionReason === "shared-frame-cell" ? 3 : 0) +
        (rightSeparation ? 2 : 0) +
        (right.detectionScale === "strict" ? 1 : 0);
      return (
        Number(curveCompleteness(right) > 0) -
          Number(curveCompleteness(left) > 0) ||
        rightPriority - leftPriority ||
        (leftSeparation && rightSeparation
          ? area(left) - area(right)
          : area(right) - area(left)) ||
        (right.axisMode === "rectangle") -
          (left.axisMode === "rectangle") ||
        curveCompleteness(right) -
          curveCompleteness(left) ||
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
      const candidateCompleteness =
        curveCompleteness(candidate);
      const existingCompleteness =
        curveCompleteness(existing);
      const candidateHasCurve = candidateCompleteness > 0;
      const existingHasCurve = existingCompleteness > 0;
      if (
        candidateHasCurve &&
        !existingHasCurve
      ) {
        kept[duplicateIndex] = candidate;
        continue;
      }
      const nested =
        contains(existing, candidate) || contains(candidate, existing);
      const candidateIsInner = contains(existing, candidate);
      const smallerNestedCandidate =
        area(candidate) <= area(existing)
          ? candidate
          : existing;
      const largerNestedCandidate =
        smallerNestedCandidate === candidate
          ? existing
          : candidate;
      const nestedAreaRatio =
        area(smallerNestedCandidate) /
        Math.max(1, area(largerNestedCandidate));
      const nestedWidthRatio =
        (smallerNestedCandidate.right -
          smallerNestedCandidate.left +
          1) /
        Math.max(
          1,
          largerNestedCandidate.right -
            largerNestedCandidate.left +
            1,
        );
      const nestedHeightRatio =
        (smallerNestedCandidate.bottom -
          smallerNestedCandidate.top +
          1) /
        Math.max(
          1,
          largerNestedCandidate.bottom -
            largerNestedCandidate.top +
            1,
        );
      const comparableNestedPlots =
        nested &&
        candidate.axisMode === "rectangle" &&
        existing.axisMode === "rectangle" &&
        candidateHasCurve &&
        existingHasCurve &&
        nestedAreaRatio >= 0.22 &&
        nestedWidthRatio >= 0.45 &&
        nestedHeightRatio >= 0.4;
      // Detection scale and area are useful tie-breakers, but they must not
      // make a broad card/frame discard a materially more complete Curve.
      // Keep this replacement local to substantial nested plots so a tiny
      // legend sparkline cannot displace the surrounding distribution.
      if (
        comparableNestedPlots &&
        candidateCompleteness >=
          existingCompleteness + 0.08
      ) {
        if (candidateIsInner) {
          suppressionEnvelopes.push(existing);
        }
        kept[duplicateIndex] = candidate;
        continue;
      }
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
    const overlappingIndex = kept.findIndex((existing) => {
      const intersection = intersectionArea(
        existing,
        candidate,
      );
      const smallerArea = Math.min(
        area(existing),
        area(candidate),
      );
      const largerArea = Math.max(
        area(existing),
        area(candidate),
      );
      const marginalMicroFrameContact =
        (existing.curveEvidence?.microFrameSignalRescue ===
          true ||
          candidate.curveEvidence?.microFrameSignalRescue ===
            true) &&
        largerArea >= smallerArea * 10 &&
        intersection <= smallerArea * 0.08;
      // A legend/label-sized rectangle can share one antialiased edge row
      // with a real plot. Keep the large hypothesis until colour-series
      // validation runs; the tiny micro-frame must not delete it here.
      return (
        intersection > smallerArea * 0.02 &&
        !marginalMicroFrameContact
      );
    });
    if (overlappingIndex >= 0) {
      const existing = kept[overlappingIndex];
      const candidateHasCurve =
        curveCompleteness(candidate) > 0;
      const existingHasCurve =
        curveCompleteness(existing) > 0;
      if (
        candidateHasCurve &&
        !existingHasCurve
      ) {
        kept[overlappingIndex] = candidate;
      }
      continue;
    }
    kept.push(candidate);
  }
  kept.preNmsDiagnostics = {
    ...preNmsSelection.diagnostics,
    rawCandidateCount: candidates.length,
    uniqueCandidateCount: uniqueCandidates.size,
  };
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
    // Frameless candidates are separated by actual blank gutters. Expanding
    // them sideways would re-introduce pixels from a neighbouring waveform
    // into the crop, which is especially harmful for tightly packed PPT
    // charts. Keep vertical breathing room, but preserve the detected x
    // boundary exactly.
    const horizontalPadding =
      candidate.axisMode === "content" ? 0 : padding;
    return {
      ...candidate,
      originalLeft: candidate.left,
      originalTop: candidate.top,
      originalRight: candidate.right,
      originalBottom: candidate.bottom,
      left: Math.max(0, candidate.left - horizontalPadding),
      top: Math.max(0, candidate.top - padding),
      right: Math.min(
        width - 1,
        candidate.right + horizontalPadding,
      ),
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
      ...(candidate.verifiedWaveform
        ? {
            verifiedWaveform:
              candidate.verifiedWaveform,
          }
        : {}),
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
    ...(detectionScale === "micro"
      ? detectEndpointAnchoredRectangleCandidates(
          mask,
          width,
          height,
          horizontalLines,
          verticalLines,
          minimumWidth,
          minimumHeight,
        )
      : []),
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

/**
 * Remove only long, perfectly straight runs before spatial Curve grouping.
 *
 * A plot frame, guide or table rule can connect otherwise independent
 * waveform components into one document-sized island. Conversely, removing
 * every row/column with above-average ink would also erase broad peak apices
 * in tiny screenshots. Long contiguous runs give us the useful middle ground:
 * axes and rules disappear, while curved/antialiased State traces survive.
 */
function suppressStraightRunsForSpatialRecovery(
  mask,
  width,
  height,
) {
  const suppressed = mask.slice();
  const remove = new Uint8Array(mask.length);
  const minimumHorizontalRun = clamp(
    Math.round(width * 0.018),
    16,
    48,
  );
  const minimumVerticalRun = clamp(
    Math.round(height * 0.025),
    14,
    40,
  );
  let removedPixelCount = 0;

  const markRun = (start, end, indexAt) => {
    if (end < start) return;
    for (let position = start; position <= end; position += 1) {
      remove[indexAt(position)] = 1;
    }
  };
  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const active =
        x < width && mask[y * width + x];
      if (active && start < 0) {
        start = x;
      } else if (!active && start >= 0) {
        if (x - start >= minimumHorizontalRun) {
          markRun(start, x - 1, (localX) => y * width + localX);
        }
        start = -1;
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    let start = -1;
    for (let y = 0; y <= height; y += 1) {
      const active =
        y < height && mask[y * width + x];
      if (active && start < 0) {
        start = y;
      } else if (!active && start >= 0) {
        if (y - start >= minimumVerticalRun) {
          markRun(start, y - 1, (localY) => localY * width + x);
        }
        start = -1;
      }
    }
  }
  for (let index = 0; index < suppressed.length; index += 1) {
    if (!remove[index]) continue;
    suppressed[index] = 0;
    removedPixelCount += 1;
  }
  return {
    mask: suppressed,
    removedPixelCount,
    minimumHorizontalRun,
    minimumVerticalRun,
  };
}

function dilateBinaryMaskAnisotropic(
  mask,
  width,
  height,
  radiusX,
  radiusY,
) {
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    let active = 0;
    for (
      let seedX = 0;
      seedX <= Math.min(width - 1, radiusX);
      seedX += 1
    ) {
      if (mask[y * width + seedX]) {
        active += 1;
      }
    }
    for (let x = 0; x < width; x += 1) {
      if (active > 0) horizontal[y * width + x] = 1;
      const entering = x + radiusX + 1;
      const leaving = x - radiusX;
      if (
        entering < width &&
        mask[y * width + entering]
      ) {
        active += 1;
      }
      if (
        leaving >= 0 &&
        mask[y * width + leaving]
      ) {
        active -= 1;
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    let active = 0;
    for (
      let seedY = 0;
      seedY <= Math.min(height - 1, radiusY);
      seedY += 1
    ) {
      if (horizontal[seedY * width + x]) {
        active += 1;
      }
    }
    for (let y = 0; y < height; y += 1) {
      if (active > 0) output[y * width + x] = 1;
      const entering = y + radiusY + 1;
      const leaving = y - radiusY;
      if (
        entering < height &&
        horizontal[entering * width + x]
      ) {
        active += 1;
      }
      if (
        leaving >= 0 &&
        horizontal[leaving * width + x]
      ) {
        active -= 1;
      }
    }
  }
  return output;
}

function spatialWaveformRegionsAtScale(
  sourceMask,
  groupingMask,
  width,
  height,
  radiusX,
  radiusY,
  maximumPerTile = 32,
) {
  const connectedMask = dilateBinaryMaskAnisotropic(
    groupingMask,
    width,
    height,
    radiusX,
    radiusY,
  );
  const visited = new Uint8Array(connectedMask.length);
  const queue = new Int32Array(connectedMask.length);
  const tileColumns = 4;
  const tileRows = 4;
  const tiles = Array.from(
    { length: tileColumns * tileRows },
    (_value, tileIndex) => ({
      tileIndex,
      row: Math.floor(tileIndex / tileColumns),
      column: tileIndex % tileColumns,
      generatedCount: 0,
      retained: [],
    }),
  );
  const columnStamp = new Uint32Array(width);
  const columnMinimumY = new Int32Array(width);
  const columnMaximumY = new Int32Array(width);
  let componentStamp = 0;
  let generatedCount = 0;
  const minimumPixelCount = Math.max(
    8,
    Math.round(width * height * 0.000006),
  );
  const minimumWidth = Math.max(
    12,
    Math.round(width * 0.008),
  );
  const minimumHeight = Math.max(
    6,
    Math.round(height * 0.007),
  );
  const comparePriority = (leftRegion, rightRegion) =>
    rightRegion.cheapWaveformPriority -
      leftRegion.cheapWaveformPriority ||
    rightRegion.cheapDirectionChangeCount -
      leftRegion.cheapDirectionChangeCount ||
    rightRegion.cheapHorizontalCoverage -
      leftRegion.cheapHorizontalCoverage ||
    rightRegion.sourcePixelCount -
      leftRegion.sourcePixelCount ||
    area(rightRegion) - area(leftRegion) ||
    leftRegion.top - rightRegion.top ||
    leftRegion.left - rightRegion.left;

  for (
    let start = 0;
    start < connectedMask.length;
    start += 1
  ) {
    if (!connectedMask[start] || visited[start]) continue;
    componentStamp += 1;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    let sourcePixelCount = 0;
    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      if (sourceMask[index]) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
        sourcePixelCount += 1;
        if (columnStamp[x] !== componentStamp) {
          columnStamp[x] = componentStamp;
          columnMinimumY[x] = y;
          columnMaximumY[x] = y;
        } else {
          columnMinimumY[x] = Math.min(
            columnMinimumY[x],
            y,
          );
          columnMaximumY[x] = Math.max(
            columnMaximumY[x],
            y,
          );
        }
      }
      const visit = (neighbor) => {
        if (
          neighbor < 0 ||
          neighbor >= connectedMask.length ||
          visited[neighbor] ||
          !connectedMask[neighbor]
        ) {
          return;
        }
        visited[neighbor] = 1;
        queue[tail] = neighbor;
        tail += 1;
      };
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }
    if (
      sourcePixelCount < minimumPixelCount ||
      right - left + 1 < minimumWidth ||
      bottom - top + 1 < minimumHeight
    ) {
      continue;
    }
    const regionWidth = right - left + 1;
    const regionHeight = bottom - top + 1;
    const density =
      sourcePixelCount / Math.max(1, regionWidth * regionHeight);
    if (
      regionWidth / regionHeight < 0.52 ||
      regionWidth / regionHeight > 14 ||
      density > 0.32
    ) {
      continue;
    }
    let occupiedColumnCount = 0;
    let thinColumnCount = 0;
    let separatedBranchColumnCount = 0;
    let trajectoryMinimumY = Number.POSITIVE_INFINITY;
    let trajectoryMaximumY = Number.NEGATIVE_INFINITY;
    let previousTrajectoryY = null;
    let previousDirection = 0;
    let directionChangeCount = 0;
    const separatedBranchThreshold = Math.max(
      3,
      regionHeight * 0.28,
    );
    const thinColumnThreshold = Math.max(
      2,
      regionHeight * 0.18,
    );
    for (let x = left; x <= right; x += 1) {
      if (columnStamp[x] !== componentStamp) continue;
      occupiedColumnCount += 1;
      const columnSpan =
        columnMaximumY[x] - columnMinimumY[x];
      if (columnSpan <= thinColumnThreshold) {
        thinColumnCount += 1;
      }
      if (columnSpan >= separatedBranchThreshold) {
        separatedBranchColumnCount += 1;
      }
      const trajectoryY =
        (columnMinimumY[x] + columnMaximumY[x]) / 2;
      trajectoryMinimumY = Math.min(
        trajectoryMinimumY,
        trajectoryY,
      );
      trajectoryMaximumY = Math.max(
        trajectoryMaximumY,
        trajectoryY,
      );
      if (previousTrajectoryY !== null) {
        const delta = trajectoryY - previousTrajectoryY;
        const direction =
          Math.abs(delta) < 0.35 ? 0 : Math.sign(delta);
        if (
          direction &&
          previousDirection &&
          direction !== previousDirection
        ) {
          directionChangeCount += 1;
        }
        if (direction) previousDirection = direction;
      }
      previousTrajectoryY = trajectoryY;
    }
    const horizontalCoverage =
      occupiedColumnCount / Math.max(1, regionWidth);
    const thinColumnRatio =
      thinColumnCount / Math.max(1, occupiedColumnCount);
    const separatedBranchRatio =
      separatedBranchColumnCount /
      Math.max(1, occupiedColumnCount);
    const trajectoryVariation =
      (trajectoryMaximumY - trajectoryMinimumY) /
      Math.max(1, regionHeight);
    const cheapWaveformPriority =
      horizontalCoverage * 0.34 +
      clamp(trajectoryVariation / 0.32, 0, 1) * 0.34 +
      clamp(directionChangeCount / 5, 0, 1) * 0.34 +
      thinColumnRatio * 0.12 -
      separatedBranchRatio * 0.58;
    const region = {
      left,
      top,
      right,
      bottom,
      sourcePixelCount,
      density,
      radiusX,
      radiusY,
      cheapWaveformPriority,
      cheapHorizontalCoverage: horizontalCoverage,
      cheapTrajectoryVariation: trajectoryVariation,
      cheapDirectionChangeCount: directionChangeCount,
      cheapSeparatedBranchRatio: separatedBranchRatio,
    };
    generatedCount += 1;
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    const tileX = clamp(
      Math.floor((centerX / Math.max(1, width)) * tileColumns),
      0,
      tileColumns - 1,
    );
    const tileY = clamp(
      Math.floor((centerY / Math.max(1, height)) * tileRows),
      0,
      tileRows - 1,
    );
    const tile = tiles[tileY * tileColumns + tileX];
    region.spatialTileIndex = tile.tileIndex;
    tile.generatedCount += 1;
    tile.retained.push(region);
    tile.retained.sort(comparePriority);
    if (tile.retained.length > maximumPerTile) {
      tile.retained.length = maximumPerTile;
    }
  }
  const regions = tiles.flatMap((tile) => tile.retained);
  return {
    regions,
    generatedCount,
    retainedCount: regions.length,
    droppedCount: generatedCount - regions.length,
    budgetHit: generatedCount > regions.length,
    tiles: tiles.map(
      ({
        tileIndex,
        row,
        column,
        generatedCount: tileGeneratedCount,
        retained,
      }) => ({
        tileIndex,
        row,
        column,
        generatedCount: tileGeneratedCount,
        retainedCount: retained.length,
        droppedCount:
          tileGeneratedCount - retained.length,
        budgetHit:
          tileGeneratedCount > retained.length,
      }),
    ),
  };
}

function isStrongSpatialWaveformEvidence(evidence) {
  if (
    !evidence.valid ||
    evidence.textGlyphArtifact ||
    evidence.tableGridArtifact ||
    evidence.closedLoopArtifact ||
    evidence.closedTwoBranchArtifact ||
    evidence.simpleTwoBranchOutlineArtifact ||
    evidence.clippedClosedOutlineArtifact ||
    evidence.thinEnough === false ||
    evidence.horizontalCoverage < 0.3 ||
    evidence.verticalVariation < 0.055 ||
    evidence.score < 0.46
  ) {
    return false;
  }
  const coherent =
    evidence.continuousCoverage >= 0.28 ||
    evidence.segmentedWaveformTrace ||
    evidence.clippedPlateauWaveform ||
    evidence.boundaryClippedShallowWaveform ||
    evidence.boundaryClippedValleyWaveform;
  const shaped =
    evidence.localizedSinglePeak ||
    evidence.directionChangeCount >= 1 ||
    evidence.segmentedWaveformTrace;
  return coherent && shaped;
}

function fairlyBoundSpatialRegions(
  regions,
  width,
  height,
  maximumCount = 192,
  maximumPerTile = 32,
) {
  const tileColumns = 4;
  const tileRows = 4;
  const tiles = Array.from(
    { length: tileColumns * tileRows },
    (_value, tileIndex) => ({
      tileIndex,
      row: Math.floor(tileIndex / tileColumns),
      column: tileIndex % tileColumns,
      generatedCount: 0,
      uniqueCount: 0,
      proposals: [],
      retainedCount: 0,
    }),
  );
  const unique = new Set();
  for (const region of regions) {
    const centerX = (region.left + region.right) / 2;
    const centerY = (region.top + region.bottom) / 2;
    const tileX = clamp(
      Math.floor((centerX / Math.max(1, width)) * tileColumns),
      0,
      tileColumns - 1,
    );
    const tileY = clamp(
      Math.floor((centerY / Math.max(1, height)) * tileRows),
      0,
      tileRows - 1,
    );
    const tile = tiles[tileY * tileColumns + tileX];
    tile.generatedCount += 1;
    const key = [
      region.left,
      region.top,
      region.right,
      region.bottom,
    ].join(":");
    if (unique.has(key)) continue;
    unique.add(key);
    tile.uniqueCount += 1;
    tile.proposals.push(region);
  }
  for (const tile of tiles) {
    tile.proposals.sort(
      (left, right) =>
        (right.cheapWaveformPriority ?? 0) -
          (left.cheapWaveformPriority ?? 0) ||
        (right.cheapDirectionChangeCount ?? 0) -
          (left.cheapDirectionChangeCount ?? 0) ||
        (right.cheapHorizontalCoverage ?? 0) -
          (left.cheapHorizontalCoverage ?? 0) ||
        right.sourcePixelCount - left.sourcePixelCount ||
        area(right) - area(left) ||
        left.top - right.top ||
        left.left - right.left,
    );
    if (tile.proposals.length > maximumPerTile) {
      tile.proposals.length = maximumPerTile;
    }
  }
  const retained = [];
  for (
    let rank = 0;
    retained.length < maximumCount;
    rank += 1
  ) {
    let added = false;
    for (const tile of tiles) {
      if (rank >= tile.proposals.length) continue;
      retained.push(tile.proposals[rank]);
      tile.retainedCount += 1;
      added = true;
      if (retained.length >= maximumCount) break;
    }
    if (!added) break;
  }
  const generatedCount = regions.length;
  const uniqueCount = unique.size;
  const retainedCount = retained.length;
  return {
    regions: retained,
    generatedCount,
    uniqueCount,
    retainedCount,
    droppedCount: generatedCount - retainedCount,
    duplicateDroppedCount: generatedCount - uniqueCount,
    budgetHit: generatedCount > retainedCount,
    tiles: tiles.map(
      ({
        tileIndex,
        row,
        column,
        generatedCount: tileGeneratedCount,
        uniqueCount: tileUniqueCount,
        retainedCount: tileRetainedCount,
      }) => ({
        tileIndex,
        row,
        column,
        generatedCount: tileGeneratedCount,
        uniqueCount: tileUniqueCount,
        retainedCount: tileRetainedCount,
        droppedCount:
          tileGeneratedCount - tileRetainedCount,
        duplicateDroppedCount:
          tileGeneratedCount - tileUniqueCount,
        budgetHit:
          tileGeneratedCount > tileRetainedCount,
      }),
    ),
  };
}

function roundRobinProposalPasses(
  proposalPasses,
  maximumCount,
) {
  const retained = [];
  for (
    let rank = 0;
    retained.length < maximumCount;
    rank += 1
  ) {
    let added = false;
    for (const pass of proposalPasses) {
      if (rank >= pass.proposals.length) continue;
      retained.push(pass.proposals[rank]);
      added = true;
      if (retained.length >= maximumCount) break;
    }
    if (!added) break;
  }
  return retained;
}

function isSafeSpatialRecoveryCandidate(candidate) {
  const evidence = candidate.curveEvidence;
  if (
    !evidence?.valid ||
    evidence.textGlyphArtifact ||
    evidence.tableGridArtifact ||
    evidence.closedLoopArtifact ||
    evidence.closedTwoBranchArtifact ||
    evidence.simpleTwoBranchOutlineArtifact ||
    evidence.clippedClosedOutlineArtifact
  ) {
    return false;
  }
  if (
    candidate.spatialFrameRecovered &&
    candidate.spatialFrameSupport >= 0.62
  ) {
    return true;
  }
  if (candidate.spatialChromaticTopology?.valid) {
    return true;
  }
  // Without a physical frame, require a complete multi-turn waveform. A
  // single Gaussian component is already handled by the connected frameless
  // detector; accepting it here would split the States of one chart into
  // separate panels.
  return (
    evidence.score >= 0.62 &&
    evidence.horizontalCoverage >= 0.58 &&
    (evidence.continuousCoverage >= 0.42 ||
      evidence.segmentedWaveformTrace) &&
    evidence.verticalVariation >= 0.08 &&
    ((evidence.directionChangeCount ?? 0) >= 2 ||
      (evidence.segmentedWaveformTrace &&
        evidence.curvedSegmentCount >= 3))
  );
}

function expandSpatialWaveformToFrame(
  candidate,
  horizontalLines,
  verticalLines,
  frameSupportMask,
  frameSearchMask,
  curveEvidenceMask,
  width,
  height,
  measurementBudget,
) {
  const candidateWidth = candidate.right - candidate.left + 1;
  const candidateHeight = candidate.bottom - candidate.top + 1;
  const horizontalTolerance = Math.max(
    4,
    candidateWidth * 0.16,
  );
  const verticalTolerance = Math.max(
    4,
    candidateHeight * 0.2,
  );
  const maximumFrameHeight = Math.min(
    height,
    Math.max(
      candidateHeight * 4.2,
      candidateWidth * 1.35,
    ),
  );
  const horizontalCandidates = horizontalLines.filter(
    (line) =>
      line.end >= candidate.right - horizontalTolerance &&
      line.start <= candidate.left + horizontalTolerance &&
      line.coordinate >=
        candidate.top - maximumFrameHeight * 0.45 &&
      line.coordinate <=
        candidate.bottom + maximumFrameHeight,
  );
  const topFrameLines = horizontalCandidates
    .filter(
      (line) =>
        line.coordinate <=
        candidate.top + verticalTolerance,
    )
    .sort(
      (left, right) =>
        Math.abs(left.coordinate - candidate.top) -
        Math.abs(right.coordinate - candidate.top),
    )
    .slice(0, 12);
  const bottomFrameLines = horizontalCandidates
    .filter(
      (line) =>
        line.coordinate >=
        candidate.bottom - verticalTolerance,
    )
    .sort(
      (left, right) =>
        Math.abs(left.coordinate - candidate.bottom) -
        Math.abs(right.coordinate - candidate.bottom),
    )
    .slice(0, 12);
  const leftFrameLines = verticalLines
    .filter(
      (line) =>
        line.coordinate >=
          candidate.left - horizontalTolerance &&
        line.coordinate <=
          candidate.left + horizontalTolerance &&
        line.start <= candidate.top + verticalTolerance &&
        line.end >= candidate.bottom - verticalTolerance,
    )
    .sort(
      (left, right) =>
        Math.abs(left.coordinate - candidate.left) -
        Math.abs(right.coordinate - candidate.left),
    )
    .slice(0, 12);
  const hypotheses = [];
  let measuredHypothesisCount = 0;
  const supportedEdge = (
    orientation,
    coordinate,
    start,
    end,
  ) => {
    const primary = edgeSupport(
      frameSupportMask,
      width,
      height,
      orientation,
      coordinate,
      start,
      end,
    );
    if (frameSupportMask === frameSearchMask) return primary;
    return Math.max(
      primary,
      edgeSupport(
        frameSearchMask,
        width,
        height,
        orientation,
        coordinate,
        start,
        end,
      ) * 0.94,
    );
  };
  const validate = (bounds, axisMode) => {
    if (measuredHypothesisCount >= 6) {
      return;
    }
    const frameWidth = bounds.right - bounds.left + 1;
    const frameHeight = bounds.bottom - bounds.top + 1;
    if (
      bounds.left > candidate.left + horizontalTolerance ||
      bounds.right < candidate.right - horizontalTolerance ||
      bounds.top > candidate.top + verticalTolerance ||
      bounds.bottom < candidate.bottom - verticalTolerance ||
      frameWidth / frameHeight < 0.62 ||
      frameWidth / frameHeight > 8 ||
      area(bounds) > area(candidate) * 5.5
    ) {
      return;
    }
    const supports =
      axisMode === "rectangle"
        ? [
            supportedEdge(
              "horizontal",
              bounds.top,
              bounds.left,
              bounds.right,
            ),
            supportedEdge(
              "horizontal",
              bounds.bottom,
              bounds.left,
              bounds.right,
            ),
            supportedEdge(
              "vertical",
              bounds.left,
              bounds.top,
              bounds.bottom,
            ),
            supportedEdge(
              "vertical",
              bounds.right,
              bounds.top,
              bounds.bottom,
            ),
          ]
        : [
            supportedEdge(
              "horizontal",
              bounds.bottom,
              bounds.left,
              bounds.right,
            ),
            supportedEdge(
              "vertical",
              bounds.left,
              bounds.top,
              bounds.bottom,
            ),
          ];
    const minimumSupport = Math.min(...supports);
    const meanSupport =
      supports.reduce((sum, value) => sum + value, 0) /
      supports.length;
    if (
      minimumSupport <
        (axisMode === "rectangle" ? 0.42 : 0.52) ||
      meanSupport < 0.62
    ) {
      return;
    }
    if (
      measurementBudget &&
      measurementBudget.remaining <= 0
    ) {
      measurementBudget.denied =
        (measurementBudget.denied ?? 0) + 1;
      return;
    }
    measuredHypothesisCount += 1;
    if (measurementBudget) {
      measurementBudget.remaining -= 1;
      measurementBudget.used += 1;
    }
    const curveEvidence = measureChartCurveEvidence(
      {
        ...bounds,
        axisMode,
      },
      curveEvidenceMask,
      width,
    );
    if (
      !curveEvidence.valid ||
      curveEvidence.tableGridArtifact
    ) {
      return;
    }
    const clippedWaveformRatio =
      (Math.max(0, bounds.left - candidate.left) +
        Math.max(0, candidate.right - bounds.right)) /
        Math.max(1, candidateWidth) +
      (Math.max(0, bounds.top - candidate.top) +
        Math.max(0, candidate.bottom - bounds.bottom)) /
        Math.max(1, candidateHeight);
    hypotheses.push({
      ...bounds,
      axisMode,
      curveEvidence,
      frameSupport: meanSupport,
      frameMinimumSupport: minimumSupport,
      frameHypothesisMeasurements: measuredHypothesisCount,
      score:
        meanSupport * 0.62 +
        curveEvidence.score * 0.28 -
        clippedWaveformRatio * 0.9 -
        (area(bounds) / Math.max(1, area(candidate)) - 1) *
          0.006 +
        (axisMode === "rectangle" ? 0.05 : 0),
    });
  };

  for (const top of topFrameLines) {
    for (const bottom of bottomFrameLines) {
      if (
        bottom.coordinate <
          candidate.bottom - verticalTolerance ||
        bottom.coordinate <= top.coordinate ||
        bottom.coordinate - top.coordinate >
          maximumFrameHeight
      ) {
        continue;
      }
      const left = Math.round(
        (top.start + bottom.start) / 2,
      );
      const right = Math.round(
        (top.end + bottom.end) / 2,
      );
      validate(
        {
          left: clamp(left, 0, width - 1),
          top: clamp(top.coordinate, 0, height - 1),
          right: clamp(right, left, width - 1),
          bottom: clamp(
            bottom.coordinate,
            top.coordinate,
            height - 1,
          ),
        },
        "rectangle",
      );
    }
  }

  // Open-axis plots have no top/right frame. The bottom band and a vertical
  // line terminating at its left endpoint still recover the full panel crop.
  for (const bottom of bottomFrameLines) {
    if (
      bottom.coordinate <
        candidate.bottom - verticalTolerance ||
      bottom.coordinate >
        candidate.bottom + maximumFrameHeight
    ) {
      continue;
    }
    for (const vertical of leftFrameLines) {
      if (
        Math.abs(vertical.coordinate - bottom.start) >
          Math.max(5, candidateWidth * 0.1) ||
        vertical.start > candidate.top + verticalTolerance ||
        vertical.end <
          bottom.coordinate - verticalTolerance
      ) {
        continue;
      }
      validate(
        {
          left: clamp(vertical.coordinate, 0, width - 1),
          top: clamp(vertical.start, 0, height - 1),
          right: clamp(
            bottom.end,
            vertical.coordinate,
            width - 1,
          ),
          bottom: clamp(
            Math.max(bottom.coordinate, vertical.end),
            vertical.start,
            height - 1,
          ),
        },
        "l-axis",
      );
    }
  }
  if (!hypotheses.length) return null;
  return hypotheses.sort(
    (left, right) =>
      right.score - left.score ||
      area(left) - area(right),
  )[0];
}

/**
 * Recover waveform regions without assuming shared rows, columns or sizes.
 *
 * The detector evaluates two topology scales on both the neutral Curve
 * residual and the chromatic union. Anisotropic horizontal dilation reconnects
 * State segments and short low-resolution breaks; the much smaller vertical
 * radius avoids joining charts that merely happen to be close on a slide.
 * Every proposal is remeasured on the original Curve mask, so tables, prose,
 * closed shapes and monotonic trend plots still pass through the established
 * waveform gates.
 */
function recoverArbitraryWaveformCandidates(
  curveEvidenceMask,
  curveColorMasks,
  frameSearchMask,
  frameSupportMask,
  width,
  height,
) {
  if (!curveEvidenceMask) {
    return {
      candidates: [],
      proposalCount: 0,
      generatedProposalCount: 0,
      retainedPassProposalCount: 0,
      boundedProposalCount: 0,
      passDroppedProposalCount: 0,
      globalDroppedProposalCount: 0,
      droppedProposalCount: 0,
      evaluatedCount: 0,
      evidenceAcceptedCount: 0,
      deniedProposalEvaluationCount: 0,
      curveMeasurementCount: 0,
      curveMeasurementBudget: 0,
      deniedResidualMeasurementCount: 0,
      deniedOriginalMeasurementCount: 0,
      deniedCurveMeasurementCount: 0,
      frameMeasurementCount: 0,
      deniedFrameMeasurementCount: 0,
      attempted: false,
      applied: false,
      removedStraightPixelCount: 0,
      scales: [],
      proposalPasses: [],
    };
  }
  const residual = suppressStraightRunsForSpatialRecovery(
    curveEvidenceMask,
    width,
    height,
  );
  const colorUnion = mergeCurveColorMasks(
    curveColorMasks,
    width,
    height,
  );
  const sources = [
    {
      name: "salience-residual",
      mask: residual.mask,
    },
    ...(colorUnion
      ? [{ name: "chromatic-union", mask: colorUnion }]
      : []),
  ];
  const scales = [
    {
      radiusX: 1,
      radiusY: 1,
    },
    {
      radiusX: clamp(Math.round(width * 0.0015), 1, 4),
      radiusY: clamp(Math.round(height * 0.001), 1, 2),
    },
    {
      radiusX: clamp(Math.round(width * 0.004), 3, 10),
      radiusY: clamp(Math.round(height * 0.0025), 1, 4),
    },
  ].filter(
    (scale, index, values) =>
      values.findIndex(
        (candidate) =>
          candidate.radiusX === scale.radiusX &&
          candidate.radiusY === scale.radiusY,
      ) === index,
  );
  const proposalPasses = [];
  let generatedProposalCount = 0;
  const minimumFrameLineWidth = Math.max(
    14,
    Math.round(width * 0.008),
  );
  const minimumFrameLineHeight = Math.max(
    12,
    Math.round(height * 0.008),
  );
  const horizontalFrameLines = extractLineBands(
    frameSearchMask,
    width,
    height,
    "horizontal",
    minimumFrameLineWidth,
    2,
  );
  const verticalFrameLines = extractLineBands(
    frameSearchMask,
    width,
    height,
    "vertical",
    minimumFrameLineHeight,
    2,
  );
  for (const source of sources) {
    for (const scale of scales) {
      const spatialRegions = spatialWaveformRegionsAtScale(
        source.mask,
        source.mask,
        width,
        height,
        scale.radiusX,
        scale.radiusY,
      );
      generatedProposalCount +=
        spatialRegions.generatedCount;
      const boundedRegions = fairlyBoundSpatialRegions(
        spatialRegions.regions,
        width,
        height,
      );
      const tiles = spatialRegions.tiles.map(
        (spatialTile) => {
          const boundedTile =
            boundedRegions.tiles[spatialTile.tileIndex];
          const retainedCount =
            boundedTile?.retainedCount ?? 0;
          return {
            tileIndex: spatialTile.tileIndex,
            row: spatialTile.row,
            column: spatialTile.column,
            generatedCount:
              spatialTile.generatedCount,
            uniqueCount: spatialTile.generatedCount,
            onlineRetainedCount:
              spatialTile.retainedCount,
            retainedCount,
            droppedCount:
              spatialTile.generatedCount - retainedCount,
            onlineDroppedCount:
              spatialTile.droppedCount,
            passDroppedCount:
              spatialTile.retainedCount - retainedCount,
            duplicateDroppedCount: 0,
            budgetHit:
              spatialTile.generatedCount > retainedCount,
          };
        },
      );
      proposalPasses.push({
        source: source.name,
        radiusX: scale.radiusX,
        radiusY: scale.radiusY,
        generatedCount: spatialRegions.generatedCount,
        uniqueCount: spatialRegions.generatedCount,
        onlineRetainedCount:
          spatialRegions.retainedCount,
        retainedCount: boundedRegions.retainedCount,
        droppedCount:
          spatialRegions.generatedCount -
          boundedRegions.retainedCount,
        onlineDroppedCount: spatialRegions.droppedCount,
        passDroppedCount:
          spatialRegions.retainedCount -
          boundedRegions.retainedCount,
        duplicateDroppedCount: 0,
        budgetHit:
          spatialRegions.generatedCount >
          boundedRegions.retainedCount,
        tiles,
        proposals: boundedRegions.regions.map((region) => ({
          ...region,
          spatialPassIndex: proposalPasses.length,
          source: source.name,
          evidenceMask: source.mask,
        })),
      });
    }
  }

  const maximumProposalCount = 384;
  // Every retained proposal always receives one residual-mask measurement
  // and, when that passes, one original-mask measurement. Budget both stages
  // independently so a run of strong early proposals cannot starve later
  // spatial tiles while preserving a deterministic upper bound.
  const maximumCurveMeasurementCount =
    maximumProposalCount * 2;
  const retainedPassProposalCount = proposalPasses.reduce(
    (sum, pass) => sum + pass.proposals.length,
    0,
  );
  const boundedProposals = roundRobinProposalPasses(
    proposalPasses,
    maximumProposalCount,
  );
  for (const pass of proposalPasses) {
    pass.globallyRetainedCount = 0;
    for (const tile of pass.tiles) {
      tile.globallyRetainedCount = 0;
    }
  }
  for (const proposal of boundedProposals) {
    const pass =
      proposalPasses[proposal.spatialPassIndex];
    if (!pass) continue;
    pass.globallyRetainedCount += 1;
    const tile =
      pass.tiles[proposal.spatialTileIndex];
    if (tile) tile.globallyRetainedCount += 1;
  }
  for (const pass of proposalPasses) {
    pass.globalDroppedCount =
      pass.retainedCount - pass.globallyRetainedCount;
    pass.globalBudgetHit = pass.globalDroppedCount > 0;
    for (const tile of pass.tiles) {
      tile.globalDroppedCount =
        tile.retainedCount -
        tile.globallyRetainedCount;
      tile.globalBudgetHit =
        tile.globalDroppedCount > 0;
    }
  }
  const passDroppedProposalCount =
    generatedProposalCount - retainedPassProposalCount;
  const globalDroppedProposalCount =
    retainedPassProposalCount - boundedProposals.length;
  const droppedProposalCount =
    generatedProposalCount - boundedProposals.length;
  const frameMeasurementBudget = {
    remaining: 1024,
    used: 0,
    denied: 0,
  };
  let curveMeasurementCount = 0;
  let evaluationAttemptCount = 0;
  let interruptedOriginalMeasurementCount = 0;
  const evaluated = [];
  for (const proposal of boundedProposals) {
    if (
      curveMeasurementCount >=
      maximumCurveMeasurementCount
    ) {
      break;
    }
    evaluationAttemptCount += 1;
    const proposalWidth =
      proposal.right - proposal.left + 1;
    const proposalHeight =
      proposal.bottom - proposal.top + 1;
    const horizontalPadding = clamp(
      Math.round(proposalWidth * 0.035),
      3,
      Math.max(3, Math.round(width * 0.01)),
    );
    const verticalPadding = clamp(
      Math.round(proposalHeight * 0.16),
      4,
      Math.max(4, Math.round(height * 0.035)),
    );
    const bottomPadding = clamp(
      Math.round(proposalHeight * 0.48),
      6,
      Math.max(6, Math.round(height * 0.06)),
    );
    const candidate = {
      left: Math.max(0, proposal.left - horizontalPadding),
      top: Math.max(0, proposal.top - verticalPadding),
      right: Math.min(
        width - 1,
        proposal.right + horizontalPadding,
      ),
      bottom: Math.min(
        height - 1,
        proposal.bottom + bottomPadding,
      ),
      axisMode: "content",
    };
    curveMeasurementCount += 1;
    const residualEvidence = measureChartCurveEvidence(
      candidate,
      proposal.evidenceMask,
      width,
    );
    const residualEvidenceStrong =
      isStrongSpatialWaveformEvidence(residualEvidence);
    // Straight-line removal can sever one connected multi-State Curve into
    // a few dense islands. Those residual islands resemble large glyphs even
    // though the untouched salience mask still contains a coherent physical
    // waveform. Permit only an exceptionally curved, multi-turn residual to
    // reach the authoritative original-mask/frame validation below; document
    // glyph fragments are normally monotone or single-turn.
    const provisionalResidualTextWaveform =
      !residualEvidenceStrong &&
      residualEvidence.textGlyphArtifact &&
      !residualEvidence.tableGridArtifact &&
      !residualEvidence.closedLoopArtifact &&
      !residualEvidence.closedTwoBranchArtifact &&
      residualEvidence.score >= 0.85 &&
      residualEvidence.horizontalCoverage >= 0.8 &&
      residualEvidence.continuousCoverage >= 0.5 &&
      residualEvidence.verticalVariation >= 0.25 &&
      residualEvidence.directionChangeCount >= 2 &&
      residualEvidence.curvedSegmentCoverage >= 0.75 &&
      residualEvidence.thinEnough;
    if (
      !residualEvidenceStrong &&
      !provisionalResidualTextWaveform
    ) {
      continue;
    }
    if (
      curveMeasurementCount >=
      maximumCurveMeasurementCount
    ) {
      interruptedOriginalMeasurementCount += 1;
      break;
    }
    curveMeasurementCount += 1;
    const originalEvidence = measureChartCurveEvidence(
      candidate,
      curveEvidenceMask,
      width,
    );
    const originalValid =
      isStrongSpatialWaveformEvidence(originalEvidence);
    // Original-mask validation is normally authoritative. A plot frame can
    // still dominate a tiny low-resolution crop, so permit the line-suppressed
    // evidence only when it is exceptionally coherent and the original mask
    // contains no table/closed-shape signal.
    const residualRescueShape =
      !originalEvidence.tableGridArtifact &&
      !originalEvidence.closedLoopArtifact &&
      !originalEvidence.closedTwoBranchArtifact &&
      residualEvidence.score >= 0.62 &&
      residualEvidence.horizontalCoverage >= 0.48 &&
      (residualEvidence.continuousCoverage >= 0.42 ||
        residualEvidence.segmentedWaveformTrace);
    const residualRescue =
      !originalEvidence.textGlyphArtifact &&
      !residualEvidence.textGlyphArtifact &&
      residualRescueShape;
    // A tiny physical frame can fragment its Curve into a handful of dense
    // islands before the frame bounds are known. Let that proposal reach the
    // frame expansion stage provisionally, but never retain the unframed
    // text-like region itself. The expanded physical plot must independently
    // remeasure as a non-text waveform with very strong edge support.
    const provisionalTextFrameRecovery =
      !originalValid &&
      !residualRescue &&
      residualRescueShape &&
      (originalEvidence.textGlyphArtifact ||
        residualEvidence.textGlyphArtifact);
    if (
      !originalValid &&
      !residualRescue &&
      !provisionalTextFrameRecovery
    ) {
      continue;
    }
    const curveEvidence = originalValid
      ? originalEvidence
      : {
          ...originalEvidence,
          valid: true,
          score: Math.max(
            originalEvidence.score,
            residualEvidence.score,
          ),
          spatialResidualRescue: true,
        };
    const frame = expandSpatialWaveformToFrame(
      candidate,
      horizontalFrameLines,
      verticalFrameLines,
      frameSupportMask,
      frameSearchMask,
      curveEvidenceMask,
      width,
      height,
      frameMeasurementBudget,
    );
    if (
      provisionalTextFrameRecovery &&
      (!frame ||
        frame.frameSupport < 0.85 ||
        frame.curveEvidence.textGlyphArtifact)
    ) {
      continue;
    }
    const selectedCurveEvidence =
      frame?.curveEvidence ?? curveEvidence;
    const selectedBounds = frame ?? candidate;
    const spatialChromaticTopology =
      measureTinyChromaticWaveformSignature(
        selectedBounds,
        curveColorMasks,
        width,
        height,
        { ignoreRelativeAreaLimit: true },
      );
    evaluated.push({
      ...selectedBounds,
      confidence: clamp(
        0.54 +
          Math.max(
            selectedCurveEvidence.score,
            residualEvidence.score,
          ) *
            0.38 +
          (proposal.source === "chromatic-union"
            ? 0.025
            : 0),
        0,
        0.97,
      ),
      detectionScale: "spatial",
      detectionReason: "arbitrary-waveform-region",
      curveEvidence: selectedCurveEvidence,
      spatialEvidence: residualEvidence,
      curveSource: proposal.source,
      groupingRadiusX: proposal.radiusX,
      groupingRadiusY: proposal.radiusY,
      spatialFrameRecovered: Boolean(frame),
      spatialFrameSupport: frame?.frameSupport ?? 0,
      spatialChromaticTopology,
    });
  }

  // Prefer the tightest valid region. A larger dilation pass is only a rescue
  // for fragmented States and must never merge two already recovered charts.
  const candidates = [];
  for (const candidate of evaluated
    .filter(isSafeSpatialRecoveryCandidate)
    .sort(
    (left, right) => {
      const bothCompactHighTurn =
        left.curveEvidence?.compactHighTurnWaveform === true &&
        right.curveEvidence?.compactHighTurnWaveform === true &&
        !left.spatialFrameRecovered &&
        !right.spatialFrameRecovered;
      const compactAspectDifference = (candidate) => {
        const candidateWidth =
          candidate.right - candidate.left + 1;
        const candidateHeight =
          candidate.bottom - candidate.top + 1;
        return Math.abs(
          candidateWidth / Math.max(1, candidateHeight) -
            1.85,
        );
      };
      return (
        Number(right.spatialFrameRecovered) -
          Number(left.spatialFrameRecovered) ||
        right.spatialFrameSupport -
          left.spatialFrameSupport ||
        (bothCompactHighTurn
          ? compactAspectDifference(left) -
            compactAspectDifference(right)
          : 0) ||
        (right.curveEvidence?.directionChangeCount ?? 0) -
          (left.curveEvidence?.directionChangeCount ?? 0) ||
        (right.curveEvidence?.horizontalCoverage ?? 0) -
          (left.curveEvidence?.horizontalCoverage ?? 0) ||
        right.confidence - left.confidence
      );
    },
  )) {
    if (candidates.length >= MAXIMUM_CHART_PANELS * 4) {
      break;
    }
    if (
      candidates.some(
        (existing) =>
          intersectionOverUnion(existing, candidate) >= 0.56 ||
          contains(candidate, existing, 3) ||
          contains(existing, candidate, 3),
      )
    ) {
      continue;
    }
    candidates.push(candidate);
  }
  const deniedProposalEvaluationCount =
    boundedProposals.length - evaluationAttemptCount;
  // An unevaluated proposal was definitely denied its first (residual)
  // measurement. Its conditional original-mask measurement is unknowable
  // without that first result, so count only measurement calls that were
  // certainly denied plus an original measurement interrupted after a
  // successful residual measurement.
  const deniedResidualMeasurementCount =
    deniedProposalEvaluationCount;
  const deniedOriginalMeasurementCount =
    interruptedOriginalMeasurementCount;
  const deniedCurveMeasurementCount =
    deniedResidualMeasurementCount +
    deniedOriginalMeasurementCount;
  return {
    candidates,
    proposalCount: generatedProposalCount,
    generatedProposalCount,
    retainedPassProposalCount,
    boundedProposalCount: boundedProposals.length,
    passDroppedProposalCount,
    globalDroppedProposalCount,
    droppedProposalCount,
    evaluatedCount: evaluationAttemptCount,
    evidenceAcceptedCount: evaluated.length,
    deniedProposalEvaluationCount,
    curveMeasurementCount,
    curveMeasurementBudget:
      maximumCurveMeasurementCount,
    deniedResidualMeasurementCount,
    deniedOriginalMeasurementCount,
    deniedCurveMeasurementCount,
    frameMeasurementCount: frameMeasurementBudget.used,
    deniedFrameMeasurementCount:
      frameMeasurementBudget.denied,
    attempted: generatedProposalCount > 0,
    applied: evaluationAttemptCount > 0,
    proposalBudgetHit:
      droppedProposalCount > 0,
    curveMeasurementBudgetHit:
      deniedCurveMeasurementCount > 0,
    frameMeasurementBudgetHit:
      frameMeasurementBudget.denied > 0,
    removedStraightPixelCount: residual.removedPixelCount,
    scales,
    proposalPasses: proposalPasses.map(
      ({
        source,
        radiusX,
        radiusY,
        generatedCount,
        uniqueCount,
        onlineRetainedCount,
        retainedCount,
        globallyRetainedCount,
        droppedCount,
        onlineDroppedCount,
        passDroppedCount,
        globalDroppedCount,
        duplicateDroppedCount,
        budgetHit,
        globalBudgetHit,
        tiles,
      }) => ({
        source,
        radiusX,
        radiusY,
        generatedCount,
        uniqueCount,
        onlineRetainedCount,
        retainedCount,
        globallyRetainedCount,
        droppedCount,
        onlineDroppedCount,
        passDroppedCount,
        globalDroppedCount,
        duplicateDroppedCount,
        budgetHit,
        globalBudgetHit,
        tiles,
      }),
    ),
  };
}

function measureLocallyUpscaledCurveEvidence(
  candidate,
  curveEvidenceMask,
  curveColorUnionMask,
  broadEvidenceMask,
  width,
  height,
) {
  const candidateWidth = candidate.right - candidate.left + 1;
  const candidateHeight = candidate.bottom - candidate.top + 1;
  const candidateAreaRatio =
    area(candidate) / Math.max(1, width * height);
  if (
    candidateAreaRatio >= COMPACT_MINIMUM_PANEL_AREA_RATIO ||
    candidateWidth < 28 ||
    candidateHeight < 22 ||
    candidateWidth > 150 ||
    candidateHeight > 110
  ) {
    return null;
  }
  const scale = clamp(
    Math.ceil(
      Math.max(
        2,
        180 / Math.max(1, candidateWidth),
        120 / Math.max(1, candidateHeight),
      ),
    ),
    2,
    5,
  );
  const scaledWidth = candidateWidth * scale;
  const scaledHeight = candidateHeight * scale;
  const upscaleSourceMask = (sourceMask) => {
    if (!sourceMask) return null;
    const scaledMask = new Uint8Array(
      scaledWidth * scaledHeight,
    );
    let active = 0;
    for (
      let sourceY = 0;
      sourceY < candidateHeight;
      sourceY += 1
    ) {
      for (
        let sourceX = 0;
        sourceX < candidateWidth;
        sourceX += 1
      ) {
        if (
          !sourceMask[
            (candidate.top + sourceY) * width +
              candidate.left +
              sourceX
          ]
        ) {
          continue;
        }
        active += 1;
        const targetLeft = sourceX * scale;
        const targetTop = sourceY * scale;
        for (
          let offsetY = 0;
          offsetY < scale;
          offsetY += 1
        ) {
          scaledMask.fill(
            1,
            (targetTop + offsetY) * scaledWidth +
              targetLeft,
            (targetTop + offsetY) * scaledWidth +
              targetLeft +
              scale,
          );
        }
      }
    }
    return active >= 8 ? scaledMask : null;
  };
  const scaledMask = upscaleSourceMask(curveEvidenceMask);
  const scaledColorMask = upscaleSourceMask(
    curveColorUnionMask,
  );
  const scaledBroadMask = upscaleSourceMask(
    broadEvidenceMask,
  );
  if (!scaledMask && !scaledBroadMask) return null;
  const localCandidate = {
    left: 0,
    top: 0,
    right: scaledWidth - 1,
    bottom: scaledHeight - 1,
    axisMode: candidate.axisMode,
  };
  const contentCandidate = {
    ...localCandidate,
    axisMode: "content",
  };
  const sourceEvidence = scaledMask
    ? measureChartCurveEvidence(
        localCandidate,
        scaledMask,
        scaledWidth,
      )
    : null;
  const residualEvidence = scaledMask
    ? measureChartCurveEvidence(
        contentCandidate,
        suppressStraightRunsForSpatialRecovery(
          scaledMask,
          scaledWidth,
          scaledHeight,
        ).mask,
        scaledWidth,
      )
    : null;
  const broadResidualEvidence = scaledBroadMask
    ? measureChartCurveEvidence(
        contentCandidate,
        suppressStraightRunsForSpatialRecovery(
          scaledBroadMask,
          scaledWidth,
          scaledHeight,
        ).mask,
        scaledWidth,
      )
    : null;
  const colorEvidence = scaledColorMask
    ? measureChartCurveEvidence(
        contentCandidate,
        scaledColorMask,
        scaledWidth,
      )
    : null;
  const evidence = [
    sourceEvidence,
    residualEvidence,
    broadResidualEvidence,
    colorEvidence,
  ]
    .filter(Boolean)
    .sort(
      (left, right) =>
        Number(right.valid) - Number(left.valid) ||
        right.score - left.score,
    )[0];
  if (
    !evidence.valid ||
    evidence.textGlyphArtifact ||
    evidence.tableGridArtifact ||
    evidence.closedLoopArtifact ||
    evidence.closedTwoBranchArtifact ||
    evidence.simpleTwoBranchOutlineArtifact ||
    evidence.clippedClosedOutlineArtifact
  ) {
    return null;
  }
  return {
    ...evidence,
    localUpscaleApplied: true,
    localUpscaleScale: scale,
    localSourceWidth: candidateWidth,
    localSourceHeight: candidateHeight,
  };
}

function measureTinyChromaticWaveformSignature(
  candidate,
  curveColorMasks,
  width,
  height,
  options = {},
) {
  if (
    !Array.isArray(curveColorMasks) ||
    curveColorMasks.length < 4
  ) {
    return null;
  }
  const candidateWidth = candidate.right - candidate.left + 1;
  const candidateHeight = candidate.bottom - candidate.top + 1;
  const isTinyPixelRoi =
    candidateWidth <= 80 && candidateHeight <= 60;
  if (
    (!options.ignoreRelativeAreaLimit &&
      !isTinyPixelRoi &&
      area(candidate) / Math.max(1, width * height) >=
        COMPACT_MINIMUM_PANEL_AREA_RATIO) ||
    candidateWidth < 28 ||
    candidateHeight < 22 ||
    candidateWidth > 150 ||
    candidateHeight > 110
  ) {
    return null;
  }
  const activeColumns = new Uint8Array(candidateWidth);
  let unionPixelCount = 0;
  let unionTop = candidateHeight;
  let unionBottom = -1;
  const colorSummaries = [];
  for (const colorMask of curveColorMasks) {
    if (!colorMask || colorMask.length < width * height) continue;
    let pixelCount = 0;
    let left = candidateWidth;
    let right = -1;
    let top = candidateHeight;
    let bottom = -1;
    const trajectory = [];
    for (
      let localX = 0;
      localX < candidateWidth;
      localX += 1
    ) {
      let columnTop = candidateHeight;
      let columnBottom = -1;
      for (
        let localY = 0;
        localY < candidateHeight;
        localY += 1
      ) {
        if (
          !colorMask[
            (candidate.top + localY) * width +
              candidate.left +
              localX
          ]
        ) {
          continue;
        }
        pixelCount += 1;
        left = Math.min(left, localX);
        right = Math.max(right, localX);
        top = Math.min(top, localY);
        bottom = Math.max(bottom, localY);
        columnTop = Math.min(columnTop, localY);
        columnBottom = Math.max(columnBottom, localY);
        activeColumns[localX] = 1;
      }
      if (columnBottom >= columnTop) {
        trajectory.push({
          x: localX,
          y: (columnTop + columnBottom) / 2,
        });
      }
    }
    if (pixelCount < 4) continue;
    const spanWidth = right - left + 1;
    const spanHeight = bottom - top + 1;
    const meanInkPerColumn =
      pixelCount / Math.max(1, trajectory.length);
    let trajectoryMinimum = Number.POSITIVE_INFINITY;
    let trajectoryMaximum = Number.NEGATIVE_INFINITY;
    let previousDirection = 0;
    let directionChangeCount = 0;
    let longestObservedRun = 0;
    let currentObservedRun = 0;
    for (
      let index = 0;
      index < trajectory.length;
      index += 1
    ) {
      const point = trajectory[index];
      trajectoryMinimum = Math.min(
        trajectoryMinimum,
        point.y,
      );
      trajectoryMaximum = Math.max(
        trajectoryMaximum,
        point.y,
      );
      const previous = trajectory[index - 1];
      if (!previous || point.x - previous.x <= 2) {
        currentObservedRun += 1;
      } else {
        currentObservedRun = 1;
        previousDirection = 0;
      }
      longestObservedRun = Math.max(
        longestObservedRun,
        currentObservedRun,
      );
      if (!previous || point.x - previous.x > 2) continue;
      const delta = point.y - previous.y;
      const direction =
        delta > 0.35 ? 1 : delta < -0.35 ? -1 : 0;
      if (!direction) continue;
      if (
        previousDirection &&
        direction !== previousDirection
      ) {
        directionChangeCount += 1;
      }
      previousDirection = direction;
    }
    const trajectoryRange =
      trajectory.length > 0
        ? trajectoryMaximum - trajectoryMinimum
        : 0;
    const trajectoryContinuity =
      longestObservedRun / Math.max(1, spanWidth);
    const waveformTrajectory =
      trajectory.length >= 4 &&
      trajectoryContinuity >= 0.52 &&
      trajectoryRange >=
        Math.max(2.5, candidateHeight * 0.07) &&
      directionChangeCount >= 1;
    if (
      spanWidth < Math.max(3, candidateWidth * 0.055) ||
      spanHeight < Math.max(3, candidateHeight * 0.12) ||
      meanInkPerColumn >
        Math.max(7.5, candidateHeight * 0.26)
    ) {
      continue;
    }
    colorSummaries.push({
      pixelCount,
      spanWidth,
      spanHeight,
      waveformTrajectory,
      directionChangeCount,
      trajectoryRange,
    });
    unionPixelCount += pixelCount;
    unionTop = Math.min(unionTop, top);
    unionBottom = Math.max(unionBottom, bottom);
  }
  const activeColumnCount = activeColumns.reduce(
    (sum, value) => sum + value,
    0,
  );
  const horizontalCoverage =
    activeColumnCount / Math.max(1, candidateWidth);
  const verticalVariation =
    unionBottom >= unionTop
      ? (unionBottom - unionTop + 1) /
        Math.max(1, candidateHeight)
      : 0;
  const density =
    unionPixelCount /
    Math.max(1, candidateWidth * candidateHeight);
  const trajectoryColorCount = colorSummaries.reduce(
    (count, summary) =>
      count + Number(summary.waveformTrajectory),
    0,
  );
  const trajectoryTurnCount = colorSummaries.reduce(
    (count, summary) =>
      count + summary.directionChangeCount,
    0,
  );
  const valid =
    colorSummaries.length >= 4 &&
    trajectoryColorCount >= 3 &&
    trajectoryColorCount >=
      Math.ceil(colorSummaries.length * 0.5) &&
    trajectoryTurnCount >= 3 &&
    horizontalCoverage >= 0.48 &&
    verticalVariation >= 0.24 &&
    density >= 0.025 &&
    density <= 0.32;
  return {
    valid,
    colorCount: colorSummaries.length,
    trajectoryColorCount,
    trajectoryTurnCount,
    horizontalCoverage,
    verticalVariation,
    density,
    score: clamp(
      colorSummaries.length / 8 * 0.35 +
        horizontalCoverage * 0.35 +
        Math.min(1, verticalVariation * 1.8) * 0.3,
      0,
      1,
    ),
  };
}

function measureMicroFrameSignal(
  candidate,
  curveEvidenceMask,
  broadMask,
  width,
) {
  const candidateWidth = candidate.right - candidate.left + 1;
  const candidateHeight = candidate.bottom - candidate.top + 1;
  if (
    candidate.axisMode !== "rectangle" ||
    candidateWidth < 28 ||
    candidateHeight < 22 ||
    candidateWidth > 52 ||
    candidateHeight > 40
  ) {
    return null;
  }
  let curvePixelCount = 0;
  const rowCounts = new Uint16Array(candidateHeight);
  const columnCounts = new Uint16Array(candidateWidth);
  for (
    let localY = 0;
    localY < candidateHeight;
    localY += 1
  ) {
    for (
      let localX = 0;
      localX < candidateWidth;
      localX += 1
    ) {
      const index =
        (candidate.top + localY) * width +
        candidate.left +
        localX;
      if (curveEvidenceMask?.[index]) {
        curvePixelCount += 1;
      }
      if (!broadMask?.[index]) continue;
      rowCounts[localY] += 1;
      columnCounts[localX] += 1;
    }
  }
  let broadResidualPixelCount = 0;
  for (
    let localY = 0;
    localY < candidateHeight;
    localY += 1
  ) {
    if (
      rowCounts[localY] / Math.max(1, candidateWidth) >=
      0.72
    ) {
      continue;
    }
    for (
      let localX = 0;
      localX < candidateWidth;
      localX += 1
    ) {
      if (
        columnCounts[localX] /
          Math.max(1, candidateHeight) >=
          0.72 ||
        !broadMask[
          (candidate.top + localY) * width +
            candidate.left +
            localX
        ]
      ) {
        continue;
      }
      broadResidualPixelCount += 1;
    }
  }
  // A table cell can contain hundreds of foreground pixels while almost all
  // of them belong to its frame/grid. A real micro chart keeps a material
  // residual trajectory after full-span rows and columns are removed.
  const valid =
    broadResidualPixelCount >= 8 &&
    (curvePixelCount < 8 ||
      broadResidualPixelCount >= curvePixelCount * 0.3);
  return {
    valid,
    curvePixelCount,
    broadResidualPixelCount,
    score: clamp(
      0.52 +
        Math.min(0.18, curvePixelCount / 120) +
        Math.min(0.12, broadResidualPixelCount / 100),
      0,
      0.78,
    ),
  };
}

function measureFramelessCurveComponent(
  component,
  mask,
  width,
  height,
  source,
) {
  const {
    left,
    top,
    right,
    bottom,
    componentWidth,
    componentHeight,
  } = component;
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
  // A V-shaped connector/chevron can be a perfectly continuous one-turn
  // trace, but both of its arms are almost exact straight lines. Real VTH
  // distributions retain measurable curvature around the peak (including
  // the low-resolution rounded-apex rescue). Keep this veto local to the
  // frameless component path so physical framed charts are unaffected.
  const straightChevronArtifact =
    isAngularApexArtifact(curveEvidence);
  const splitSteepPeak =
    curveEvidence.segmentedWaveformTrace &&
    curveEvidence.curvedSegmentCount === 2 &&
    curveEvidence.curvedSegmentCoverage >= 0.55 &&
    curveEvidence.verticalVariation >= 0.4 &&
    curveEvidence.linearDeviation >= 0.04 &&
    curveEvidence.traceSmoothness >= 0.85 &&
    curveEvidence.roundedApexScore >= 0.2;
  const standardPeakShape =
    curveEvidence.verticalVariation >= 0.08 &&
    curveEvidence.peakPosition >= 0.06 &&
    curveEvidence.peakPosition <= 0.94 &&
    curveEvidence.peakProminence >= 0.055 &&
    roundedPeak;
  const validShape =
    curveEvidence.valid &&
    curveEvidence.horizontalCoverage >= 0.35 &&
    (curveEvidence.continuousCoverage >= 0.3 ||
      curveEvidence.segmentedWaveformTrace) &&
    curveEvidence.score >= 0.48 &&
    !straightChevronArtifact &&
    (standardPeakShape || splitSteepPeak);
  if (!validShape) return null;
  return {
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
  };
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
  const componentTiles = Array.from(
    {
      length:
        LINE_BAND_SPATIAL_DIVISIONS *
        LINE_BAND_SPATIAL_DIVISIONS,
    },
    () => [],
  );
  let rejectedComponentCount = 0;
  let eligibleComponentCount = 0;
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

    eligibleComponentCount += 1;
    const component = {
      left,
      top,
      right,
      bottom,
      componentWidth,
      componentHeight,
      pixelCount,
      columnContinuity,
      averageInkPerColumn,
      density,
      cheapWaveformScore:
        columnContinuity * 1.8 +
        Math.min(
          0.45,
          (componentWidth / componentHeight) * 0.09,
        ) -
        Math.min(
          0.5,
          averageInkPerColumn /
            Math.max(9, componentHeight * 0.22) *
            0.5,
        ) -
        density * 0.8,
    };
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    const row = clamp(
      Math.floor(
        (centerY * LINE_BAND_SPATIAL_DIVISIONS) /
          Math.max(1, height),
      ),
      0,
      LINE_BAND_SPATIAL_DIVISIONS - 1,
    );
    const column = clamp(
      Math.floor(
        (centerX * LINE_BAND_SPATIAL_DIVISIONS) /
          Math.max(1, width),
      ),
      0,
      LINE_BAND_SPATIAL_DIVISIONS - 1,
    );
    const tile =
      componentTiles[
        row * LINE_BAND_SPATIAL_DIVISIONS + column
      ];
    tile.push(component);
    tile.sort(
      (first, second) =>
        second.cheapWaveformScore -
          first.cheapWaveformScore ||
        second.columnContinuity -
          first.columnContinuity ||
        first.density - second.density ||
        first.top - second.top ||
        first.left - second.left,
    );
    if (
      tile.length >
      MAXIMUM_FRAMELESS_COMPONENTS_PER_TILE
    ) {
      tile.length =
        MAXIMUM_FRAMELESS_COMPONENTS_PER_TILE;
    }
  }

  const fairComponents = [];
  const maximumTileLength = Math.max(
    0,
    ...componentTiles.map((tile) => tile.length),
  );
  for (
    let itemIndex = 0;
    itemIndex < maximumTileLength;
    itemIndex += 1
  ) {
    for (const tile of componentTiles) {
      if (tile[itemIndex]) {
        fairComponents.push(tile[itemIndex]);
      }
    }
  }
  const measuredComponents = fairComponents.slice(
    0,
    MAXIMUM_FRAMELESS_MEASUREMENTS_PER_SOURCE,
  );
  const candidates = [];
  for (const component of measuredComponents) {
    const candidate = measureFramelessCurveComponent(
      component,
      mask,
      width,
      height,
      source,
    );
    if (candidate) {
      candidates.push(candidate);
    } else {
      rejectedComponentCount += 1;
    }
  }
  const droppedComponentCount = Math.max(
    0,
    eligibleComponentCount - measuredComponents.length,
  );
  rejectedComponentCount += droppedComponentCount;
  return {
    candidates,
    rejectedComponentCount,
    eligibleComponentCount,
    measuredComponentCount: measuredComponents.length,
    droppedComponentCount,
    measurementBudgetHit: droppedComponentCount > 0,
  };
}

function detectFramelessCurveCandidates(
  curveEvidenceMask,
  curveColorMasks,
  width,
  height,
  sourceScale = 1,
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
  let candidates = [];
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
  if (candidates.length >= 2) {
    const ordered = [...candidates].sort(
      (left, right) =>
        left.left - right.left ||
        left.top - right.top,
    );
    const merged = [];
    const clippedBottomY = (
      candidate,
      edgeX,
    ) => {
      let maximumY = -1;
      for (
        let x = Math.max(
          candidate.left,
          edgeX - 3,
        );
        x <= Math.min(candidate.right, edgeX + 3);
        x += 1
      ) {
        for (let y = 0; y < height; y += 1) {
          if (curveEvidenceMask[y * width + x]) {
            maximumY = Math.max(maximumY, y);
          }
        }
      }
      return maximumY;
    };
    const localColumnCenterY = (
      candidate,
      targetX,
    ) => {
      const values = [];
      for (
        let x = Math.max(
          candidate.left,
          targetX - 1,
        );
        x <= Math.min(candidate.right, targetX + 1);
        x += 1
      ) {
        for (let y = 0; y < height; y += 1) {
          if (curveEvidenceMask[y * width + x]) {
            values.push(y);
          }
        }
      }
      if (!values.length) return Number.NaN;
      values.sort((left, right) => left - right);
      return values[Math.floor(values.length / 2)];
    };
    for (let index = 0; index < ordered.length; index += 1) {
      const first = ordered[index];
      const second = ordered[index + 1];
      const horizontalGap = second
        ? second.left - first.right - 1
        : Number.POSITIVE_INFINITY;
      const verticalOverlap = second
        ? intervalOverlapRatio(
            first.top,
            first.bottom,
            second.top,
            second.bottom,
          )
        : 0;
      const firstInnerBottom = second
        ? clippedBottomY(first, first.right)
        : -1;
      const secondInnerBottom = second
        ? clippedBottomY(second, second.left)
        : -1;
      const firstProbe = second
        ? clamp(
            Math.round(
              (first.right - first.left + 1) * 0.025,
            ),
            6,
            14,
          )
        : 0;
      const secondProbe = second
        ? clamp(
            Math.round(
              (second.right - second.left + 1) * 0.025,
            ),
            6,
            14,
          )
        : 0;
      const firstInnerCenter = second
        ? localColumnCenterY(first, first.right)
        : Number.NaN;
      const firstOuterCenter = second
        ? localColumnCenterY(
            first,
            first.right - firstProbe,
          )
        : Number.NaN;
      const secondInnerCenter = second
        ? localColumnCenterY(second, second.left)
        : Number.NaN;
      const secondOuterCenter = second
        ? localColumnCenterY(
            second,
            second.left + secondProbe,
          )
        : Number.NaN;
      const overlappingTraceContinuation =
        second &&
        horizontalGap >= -4 &&
        horizontalGap <= 0 &&
        verticalOverlap >= 0.45;
      const bottomClippedValleyContinuation =
        second &&
        horizontalGap >= -1 &&
        horizontalGap <= Math.ceil(3 * sourceScale) &&
        verticalOverlap >= 0.55 &&
        firstInnerBottom >= height * 0.85 &&
        secondInnerBottom >= height * 0.85 &&
        Math.abs(firstInnerBottom - secondInnerBottom) <=
          height * 0.08 &&
        firstInnerCenter - firstOuterCenter >=
          height * 0.1 &&
        secondInnerCenter - secondOuterCenter >=
          height * 0.1;
      if (
        overlappingTraceContinuation ||
        bottomClippedValleyContinuation
      ) {
        const combined = {
          left: Math.min(first.left, second.left),
          top: Math.min(first.top, second.top),
          right: Math.max(first.right, second.right),
          bottom: Math.max(first.bottom, second.bottom),
          axisMode: "content",
        };
        const curveEvidence = measureChartCurveEvidence(
          combined,
          curveEvidenceMask,
          width,
        );
        if (curveEvidence.valid) {
          merged.push({
            ...combined,
            confidence: clamp(
              Math.max(
                first.confidence,
                second.confidence,
              ) +
                0.015,
              0,
              0.97,
            ),
            detectionScale: "content",
            detectionReason: "frameless-curve-region",
            curveEvidence,
            curveSource:
              first.curveSource === "salience" ||
              second.curveSource === "salience"
                ? "salience"
                : first.curveSource,
          });
          index += 1;
          continue;
        }
      }
      merged.push(first);
    }
    candidates = merged;
  }

  // A lone frameless Curve normally stays on the established whole-image
  // path. When substantial unrelated foreground also exists, however, that
  // fallback would ingest the surrounding prose/table/diagram. In that case
  // retain one exceptionally strong Curve component so downstream analysis
  // can crop away the non-waveform content.
  if (candidates.length < 2) {
    const candidate = candidates[0];
    if (candidate) {
      let totalInk = 0;
      let candidateInk = 0;
      const outsideRowInk = new Uint32Array(height);
      const outsideColumnInk = new Uint32Array(width);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (!curveEvidenceMask[y * width + x]) continue;
          totalInk += 1;
          if (
            x >= candidate.left &&
            x <= candidate.right &&
            y >= candidate.top &&
            y <= candidate.bottom
          ) {
            candidateInk += 1;
          } else {
            outsideRowInk[y] += 1;
            outsideColumnInk[x] += 1;
          }
        }
      }
      const outsideInk = totalInk - candidateInk;
      let boundaryContinuationColumns = 0;
      const continuationRadius = clamp(
        Math.ceil(6 * sourceScale),
        6,
        24,
      );
      const continuationVerticalMargin = clamp(
        Math.ceil(4 * sourceScale),
        4,
        16,
      );
      for (const [startX, endX] of [
        [
          Math.max(
            0,
            candidate.left - continuationRadius,
          ),
          candidate.left - 1,
        ],
        [
          candidate.right + 1,
          Math.min(
            width - 1,
            candidate.right + continuationRadius,
          ),
        ],
      ]) {
        for (let x = startX; x <= endX; x += 1) {
          let hasContinuationInk = false;
          for (
            let y = Math.max(
              0,
              candidate.top - continuationVerticalMargin,
            );
            y <=
            Math.min(
              height - 1,
              candidate.bottom +
                continuationVerticalMargin,
            );
            y += 1
          ) {
            if (curveEvidenceMask[y * width + x]) {
              hasContinuationInk = true;
              break;
            }
          }
          if (hasContinuationInk) {
            boundaryContinuationColumns += 1;
          }
        }
      }
      const outsideArtifactLineCount =
        outsideRowInk.reduce(
          (count, value) =>
            count +
            (value >= Math.max(12, width * 0.025)
              ? 1
              : 0),
          0,
        ) +
        outsideColumnInk.reduce(
          (count, value) =>
            count +
            (value >= Math.max(10, height * 0.035)
              ? 1
              : 0),
          0,
        );
      const evidence = candidate.curveEvidence;
      const strongSingleton =
        evidence.valid &&
        evidence.score >= 0.58 &&
        (evidence.continuousCoverage >= 0.42 ||
          evidence.segmentedWaveformTrace) &&
        evidence.linearDeviation >= 0.025 &&
        evidence.thinEnough &&
        (evidence.localizedSinglePeak ||
          evidence.directionChangeCount >= 1);
      const substantialNonCurveContent =
        outsideInk >= Math.max(24, totalInk * 0.035) &&
        outsideArtifactLineCount >= 2 &&
        // Even one occupied neighbour column is evidence that the selected
        // component is only a fragment of a deeper multi-State waveform.
        // Tables, prose blocks and diagrams normally have a real gutter.
        boundaryContinuationColumns === 0;
      if (strongSingleton && substantialNonCurveContent) {
        return {
          candidates: [candidate],
          rejectedComponentCount: Math.min(
            99,
            Math.max(
              1,
              ...hypotheses.map(
                (hypothesis) =>
                  hypothesis.rejectedComponentCount,
              ),
            ),
          ),
        };
      }
    }
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

function medianNumber(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort(
    (left, right) => left - right,
  );
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function clusterRepeatedCoordinates(
  candidates,
  coordinate,
  tolerance,
) {
  const ordered = candidates
    .map((candidate) => coordinate(candidate))
    .sort((left, right) => left - right);
  const clusters = [];
  for (const value of ordered) {
    const current = clusters.at(-1);
    if (
      current &&
      value - current.center <= tolerance
    ) {
      current.values.push(value);
      current.center =
        current.values.reduce(
          (sum, item) => sum + item,
          0,
        ) / current.values.length;
      continue;
    }
    clusters.push({ values: [value], center: value });
  }
  return clusters;
}

function fitRepeatedCoordinateSequence(
  clusters,
  typicalSpan,
) {
  if (clusters.length < 2) return null;
  const count = clusters.length;
  const meanIndex = (count - 1) / 2;
  const meanPosition =
    clusters.reduce(
      (sum, cluster) => sum + cluster.center,
      0,
    ) / count;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    const centeredIndex = index - meanIndex;
    numerator +=
      centeredIndex *
      (clusters[index].center - meanPosition);
    denominator += centeredIndex ** 2;
  }
  const step = numerator / Math.max(1e-9, denominator);
  const origin = meanPosition - step * meanIndex;
  const maximumResidual = clusters.reduce(
    (maximum, cluster, index) =>
      Math.max(
        maximum,
        Math.abs(cluster.center - (origin + step * index)),
      ),
    0,
  );
  if (
    step < Math.max(6, typicalSpan * 1.05) ||
    step > typicalSpan * 3.5 ||
    maximumResidual > Math.max(6, typicalSpan * 0.16)
  ) {
    return null;
  }
  return {
    origin,
    step,
    positions: Array.from(
      { length: count },
      (_, index) => origin + step * index,
    ),
    maximumResidual,
  };
}

function isRepeatedGridAnchor(candidate, width, height) {
  const evidence = candidate.curveEvidence;
  const candidateAreaRatio =
    area(candidate) / Math.max(1, width * height);
  return (
    evidence?.valid &&
    !evidence.tableGridArtifact &&
    candidateAreaRatio >=
      COMPACT_MINIMUM_PANEL_AREA_RATIO &&
    candidateAreaRatio <= 0.04 &&
    evidence.horizontalCoverage >= 0.58 &&
    evidence.continuousCoverage >= 0.42 &&
    evidence.verticalVariation >= 0.07 &&
    evidence.thinEnough !== false &&
    (evidence.directionChangeCount >= 2 ||
      evidence.localizedSinglePeak ||
      (evidence.colorSeriesCount ?? 0) >= 1)
  );
}

function isRepeatedGridCellEvidence(evidence) {
  return (
    evidence.valid &&
    !evidence.tableGridArtifact &&
    evidence.horizontalCoverage >= 0.58 &&
    evidence.continuousCoverage >= 0.42 &&
    evidence.verticalVariation >= 0.07 &&
    evidence.thinEnough !== false &&
    (evidence.directionChangeCount >= 1 ||
      evidence.localizedSinglePeak ||
      (evidence.colorSeriesCount ?? 0) >= 1)
  );
}

function recoverStrictRepeatedWaveformGridCandidates(
  measuredCandidates,
  curveEvidenceMask,
  width,
  height,
) {
  const anchors = measuredCandidates.filter((candidate) =>
    isRepeatedGridAnchor(candidate, width, height),
  );
  const frameAnchors = anchors.filter(
    (candidate) => candidate.axisMode === "rectangle",
  );
  if (anchors.length < 8 || frameAnchors.length < 3) {
    return null;
  }
  const frameWidth = Math.round(
    medianNumber(
      frameAnchors.map(
        (candidate) => candidate.right - candidate.left + 1,
      ),
    ),
  );
  const frameHeight = Math.round(
    medianNumber(
      frameAnchors.map(
        (candidate) => candidate.bottom - candidate.top + 1,
      ),
    ),
  );
  if (frameWidth < 24 || frameHeight < 18) return null;

  const columnClusters = clusterRepeatedCoordinates(
    anchors,
    (candidate) => candidate.left,
    Math.max(6, frameWidth * 0.32),
  );
  const rowClusters = clusterRepeatedCoordinates(
    anchors,
    (candidate) => candidate.top,
    Math.max(6, frameHeight * 0.32),
  );
  const expectedCellCount =
    columnClusters.length * rowClusters.length;
  if (
    columnClusters.length < 2 ||
    rowClusters.length < 2 ||
    expectedCellCount < 6 ||
    expectedCellCount > MAXIMUM_CHART_PANELS
  ) {
    return null;
  }
  const columnFit = fitRepeatedCoordinateSequence(
    columnClusters,
    frameWidth,
  );
  const rowFit = fitRepeatedCoordinateSequence(
    rowClusters,
    frameHeight,
  );
  if (!columnFit || !rowFit) return null;

  const occupiedCells = new Set();
  for (const anchor of anchors) {
    let bestColumn = -1;
    let bestColumnDistance = Number.POSITIVE_INFINITY;
    for (
      let column = 0;
      column < columnFit.positions.length;
      column += 1
    ) {
      const distance = Math.abs(
        anchor.left - columnFit.positions[column],
      );
      if (distance < bestColumnDistance) {
        bestColumn = column;
        bestColumnDistance = distance;
      }
    }
    let bestRow = -1;
    let bestRowDistance = Number.POSITIVE_INFINITY;
    for (
      let row = 0;
      row < rowFit.positions.length;
      row += 1
    ) {
      const distance = Math.abs(
        anchor.top - rowFit.positions[row],
      );
      if (distance < bestRowDistance) {
        bestRow = row;
        bestRowDistance = distance;
      }
    }
    if (
      bestColumnDistance <= frameWidth * 0.24 &&
      bestRowDistance <= frameHeight * 0.24
    ) {
      occupiedCells.add(`${bestRow}:${bestColumn}`);
    }
  }
  if (
    occupiedCells.size <
    Math.max(8, Math.ceil(expectedCellCount * 0.45))
  ) {
    return null;
  }

  const candidates = [];
  for (
    let row = 0;
    row < rowFit.positions.length;
    row += 1
  ) {
    for (
      let column = 0;
      column < columnFit.positions.length;
      column += 1
    ) {
      const left = clamp(
        Math.round(columnFit.positions[column]),
        0,
        width - 1,
      );
      const top = clamp(
        Math.round(rowFit.positions[row]),
        0,
        height - 1,
      );
      const candidate = {
        left,
        top,
        right: Math.min(width - 1, left + frameWidth - 1),
        bottom: Math.min(
          height - 1,
          top + frameHeight - 1,
        ),
        axisMode: "rectangle",
        detectionScale: "repeated-grid",
        detectionReason: "repeated-waveform-grid",
      };
      const curveEvidence = measureChartCurveEvidence(
        candidate,
        curveEvidenceMask,
        width,
      );
      if (!isRepeatedGridCellEvidence(curveEvidence)) {
        continue;
      }
      candidates.push({
        ...candidate,
        confidence: clamp(
          0.62 + curveEvidence.score * 0.34,
          0,
          0.98,
        ),
        curveEvidence,
      });
    }
  }
  if (
    candidates.length <
    Math.ceil(expectedCellCount * 0.85)
  ) {
    return null;
  }
  return {
    candidates,
    anchorCount: anchors.length,
    occupiedCellCount: occupiedCells.size,
    expectedCellCount,
    rows: rowFit.positions.length,
    columns: columnFit.positions.length,
    frameWidth,
    frameHeight,
    columnStep: columnFit.step,
    rowStep: rowFit.step,
  };
}

function collectProjectionBands(
  active,
  maximumGap,
  minimumSpan,
) {
  const bands = [];
  let start = -1;
  let last = -1;
  for (let index = 0; index < active.length; index += 1) {
    if (!active[index]) continue;
    if (start < 0) {
      start = index;
      last = index;
      continue;
    }
    if (index - last <= maximumGap + 1) {
      last = index;
      continue;
    }
    if (last - start + 1 >= minimumSpan) {
      bands.push({ start, end: last });
    }
    start = index;
    last = index;
  }
  if (start >= 0 && last - start + 1 >= minimumSpan) {
    bands.push({ start, end: last });
  }
  return bands;
}

function selectRegularProjectionBands(
  bands,
  maximumCount,
) {
  if (bands.length < 2) return null;
  let best = null;
  for (let start = 0; start < bands.length - 1; start += 1) {
    for (
      let count = 2;
      count <= Math.min(maximumCount, bands.length - start);
      count += 1
    ) {
      const selected = bands.slice(start, start + count);
      const centers = selected.map(
        (band) => (band.start + band.end) / 2,
      );
      const spans = selected.map(
        (band) => band.end - band.start + 1,
      );
      const meanIndex = (count - 1) / 2;
      const meanCenter =
        centers.reduce((sum, value) => sum + value, 0) /
        count;
      let numerator = 0;
      let denominator = 0;
      for (let index = 0; index < count; index += 1) {
        numerator +=
          (index - meanIndex) *
          (centers[index] - meanCenter);
        denominator += (index - meanIndex) ** 2;
      }
      const step =
        numerator / Math.max(1e-9, denominator);
      const origin = meanCenter - step * meanIndex;
      const maximumResidual = Math.max(
        ...centers.map((center, index) =>
          Math.abs(center - (origin + step * index)),
        ),
      );
      const typicalSpan = medianNumber(spans);
      const maximumSpanDeviation = Math.max(
        ...spans.map((span) =>
          Math.abs(span - typicalSpan),
        ),
      );
      const minimumRepeatedBandStep =
        typicalSpan +
        Math.max(3, typicalSpan * 0.02);
      if (
        step < Math.max(8, minimumRepeatedBandStep) ||
        maximumResidual > Math.max(5, step * 0.11) ||
        maximumSpanDeviation >
          Math.max(12, typicalSpan * 0.48)
      ) {
        continue;
      }
      const regularity =
        maximumResidual / Math.max(1, step) +
        maximumSpanDeviation /
          Math.max(1, typicalSpan) *
          0.35;
      const score = count * 10 - regularity * 12;
      if (
        !best ||
        score > best.score ||
        (score === best.score && count > best.bands.length)
      ) {
        best = {
          bands: selected,
          step,
          origin,
          maximumResidual,
          typicalSpan,
          score,
        };
      }
    }
  }
  return best;
}

function projectionFitFromLatticeLines(lineBands) {
  if (!Array.isArray(lineBands) || lineBands.length < 2) {
    return null;
  }
  const bands = lineBands
    .slice(0, -1)
    .map((line, index) => ({
      start: line.end + 1,
      end: lineBands[index + 1].start - 1,
    }))
    .filter((band) => band.end - band.start + 1 >= 8);
  if (bands.length !== lineBands.length - 1) {
    return null;
  }
  const centers = bands.map(
    (band) => (band.start + band.end) / 2,
  );
  const steps = centers
    .slice(1)
    .map((center, index) => center - centers[index]);
  return {
    bands,
    step:
      steps.length
        ? medianNumber(steps)
        : medianNumber(
            bands.map(
              (band) => band.end - band.start + 1,
            ),
          ),
    origin: centers[0],
    maximumResidual: 0,
    typicalSpan: medianNumber(
      bands.map((band) => band.end - band.start + 1),
    ),
    score: bands.length * 10,
    latticeDerived: true,
  };
}

function projectionFitFromSingleBand(
  bands,
  latticeBand,
) {
  if (!Array.isArray(bands) || !latticeBand) return null;
  const latticeSpan =
    latticeBand.end - latticeBand.start + 1;
  const selected = bands
    .filter(
      (band) =>
        band.end - band.start + 1 >= 8 &&
        overlapLength(
          band.start,
          band.end,
          latticeBand.start,
          latticeBand.end,
        ) > 0,
    )
    .sort((left, right) => {
      const score = (band) =>
        overlapLength(
          band.start,
          band.end,
          latticeBand.start,
          latticeBand.end,
        ) /
          Math.max(1, latticeSpan) +
        Math.min(
          1,
          (band.end - band.start + 1) /
            Math.max(1, latticeSpan),
        ) *
          0.2;
      return score(right) - score(left);
    })[0];
  if (!selected) return null;
  const span = selected.end - selected.start + 1;
  return {
    bands: [selected],
    step: latticeSpan,
    origin: (selected.start + selected.end) / 2,
    maximumResidual: 0,
    typicalSpan: span,
    score: 10 + span / Math.max(1, latticeSpan),
    singleBandDerived: true,
  };
}

function recoverChromaticRepeatedWaveformGridCandidates(
  measuredCandidates,
  broadEvidenceMask,
  curveEvidenceMask,
  curveColorMasks,
  width,
  height,
  requireTableWaveformGridProof = false,
  tableLatticeShape = null,
  forceAchromaticProjection = false,
) {
  const rawChromaticMask = mergeCurveColorMasks(
    curveColorMasks,
    width,
    height,
  );
  const usesChromaticProjection =
    Boolean(rawChromaticMask) &&
    !forceAchromaticProjection;
  const rawProjectionMask =
    (usesChromaticProjection
      ? rawChromaticMask
      : null) ??
    (requireTableWaveformGridProof
      ? curveEvidenceMask
      : null);
  if (!rawProjectionMask) {
    return null;
  }
  const chromaticMask = removeGridLinesPreservingCurves(
    rawProjectionMask,
    width,
    height,
  ).mask;
  const retryWithAchromaticProjection = () =>
    requireTableWaveformGridProof &&
    usesChromaticProjection
      ? recoverChromaticRepeatedWaveformGridCandidates(
          measuredCandidates,
          broadEvidenceMask,
          curveEvidenceMask,
          curveColorMasks,
          width,
          height,
          requireTableWaveformGridProof,
          tableLatticeShape,
          true,
        )
      : null;

  const activeRows = new Uint8Array(height);
  const minimumRowInk = Math.max(
    7,
    Math.round(width * 0.004),
  );
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      count += chromaticMask[y * width + x] ? 1 : 0;
    }
    activeRows[y] = count >= minimumRowInk ? 1 : 0;
  }
  const minimumRowBandSpan = Math.max(
    12,
    Math.round(height * 0.055),
  );
  const physicalTableRowFit =
    requireTableWaveformGridProof
      ? projectionFitFromLatticeLines(
          tableLatticeShape?.horizontalBands,
        )
      : null;
  const minimumRowBandCount =
    tableLatticeShape?.rows === 1 ? 1 : 2;
  const latticeRowFit =
    requireTableWaveformGridProof &&
    !usesChromaticProjection
      ? physicalTableRowFit
      : null;
  let rawRows = collectProjectionBands(
    activeRows,
    3,
    minimumRowBandSpan,
  );
  let rowFit =
    latticeRowFit ??
    (minimumRowBandCount === 1
      ? projectionFitFromSingleBand(
          rawRows,
          physicalTableRowFit?.bands[0],
        )
      : selectRegularProjectionBands(rawRows, 8));
  if (
    !rowFit ||
    rowFit.bands.length < minimumRowBandCount
  ) {
    for (const maximumGap of [2, 1, 0]) {
      rawRows = collectProjectionBands(
        activeRows,
        maximumGap,
        minimumRowBandSpan,
      );
      rowFit =
        minimumRowBandCount === 1
          ? projectionFitFromSingleBand(
              rawRows,
              physicalTableRowFit?.bands[0],
            )
          : selectRegularProjectionBands(rawRows, 8);
      if (
        rowFit?.bands.length >= minimumRowBandCount
      ) {
        break;
      }
    }
  }
  if (
    !rowFit ||
    rowFit.bands.length < minimumRowBandCount
  ) {
    return retryWithAchromaticProjection();
  }

  const activeColumns = new Uint8Array(width);
  const columnCounts = new Uint16Array(width);
  for (const row of rowFit.bands) {
    for (let y = row.start; y <= row.end; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (chromaticMask[y * width + x]) {
          columnCounts[x] += 1;
        }
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    activeColumns[x] = columnCounts[x] >= 2 ? 1 : 0;
  }
  const minimumColumnBandSpan = Math.max(
    12,
    Math.round(width * 0.025),
  );
  const physicalTableColumnFit =
    requireTableWaveformGridProof
      ? projectionFitFromLatticeLines(
          tableLatticeShape?.verticalBands,
        )
      : null;
  const minimumColumnBandCount =
    tableLatticeShape?.columns === 1 ? 1 : 2;
  const latticeColumnFit =
    requireTableWaveformGridProof &&
    !usesChromaticProjection
      ? physicalTableColumnFit
      : null;
  let rawColumns = collectProjectionBands(
    activeColumns,
    6,
    minimumColumnBandSpan,
  );
  let columnFit =
    latticeColumnFit ??
    (minimumColumnBandCount === 1
      ? projectionFitFromSingleBand(
          rawColumns,
          physicalTableColumnFit?.bands[0],
        )
      : selectRegularProjectionBands(
          rawColumns,
          Math.floor(
            MAXIMUM_CHART_PANELS / rowFit.bands.length,
          ),
        ));
  // Five-to-seven blank pixels are common between tightly packed 800×450
  // PPT plots. The tolerant six-pixel projection gap is still useful for a
  // broken Curve inside one plot, but it can merge every plot column into one
  // band. Retry with strict gutters only when the tolerant pass cannot form a
  // repeated grid; this leaves established wider layouts unchanged.
  const hasMergedProjectionBand = () =>
    Boolean(
      columnFit &&
        rawColumns.some(
          (band) =>
            band.end - band.start + 1 >
            columnFit.typicalSpan * 1.5,
        ),
    );
  if (
    !latticeColumnFit &&
    (!columnFit ||
      columnFit.bands.length < minimumColumnBandCount ||
      hasMergedProjectionBand())
  ) {
    for (const maximumGap of [3, 1, 0]) {
      const strictColumns = collectProjectionBands(
        activeColumns,
        maximumGap,
        minimumColumnBandSpan,
      );
      const strictFit =
        minimumColumnBandCount === 1
          ? projectionFitFromSingleBand(
              strictColumns,
              physicalTableColumnFit?.bands[0],
            )
          : selectRegularProjectionBands(
              strictColumns,
              Math.floor(
                MAXIMUM_CHART_PANELS /
                  rowFit.bands.length,
              ),
            );
      if (
        strictFit &&
        (!columnFit ||
          strictFit.bands.length >
            columnFit.bands.length ||
          (strictFit.bands.length ===
            columnFit.bands.length &&
            strictFit.score > columnFit.score))
      ) {
        rawColumns = strictColumns;
        columnFit = strictFit;
      }
      if (
        columnFit?.bands.length >=
          minimumColumnBandCount &&
        !hasMergedProjectionBand()
      ) {
        break;
      }
    }
  }
  if (
    !columnFit ||
    columnFit.bands.length < minimumColumnBandCount
  ) {
    return retryWithAchromaticProjection();
  }
  // A right-hand explanation/table/trend pane can contribute coloured ink in
  // every sweep row and, by coincidence, sit at almost exactly one more grid
  // interval. Unlike a VTH column, however, it does not contain a turning,
  // vertically varying waveform in most rows. Trim only a weak edge column
  // when all interior columns have strong row-by-row waveform support.
  if (columnFit.bands.length >= 5) {
    const edgeProbePaddingX = clamp(
      Math.round(columnFit.step * 0.055),
      4,
      24,
    );
    const edgeProbePaddingY = clamp(
      Math.round(rowFit.step * 0.055),
      3,
      16,
    );
    const supports = columnFit.bands.map((columnBand) =>
      rowFit.bands.reduce((count, rowBand) => {
        const evidence = measureChartCurveEvidence(
          {
            left: Math.max(
              0,
              columnBand.start - edgeProbePaddingX,
            ),
            top: Math.max(
              0,
              rowBand.start - edgeProbePaddingY,
            ),
            right: Math.min(
              width - 1,
              columnBand.end + edgeProbePaddingX,
            ),
            bottom: Math.min(
              height - 1,
              rowBand.end + edgeProbePaddingY,
            ),
            axisMode: "content",
          },
          curveEvidenceMask,
          width,
        );
        return (
          count +
          (evidence.horizontalCoverage >= 0.25 &&
          evidence.verticalVariation >= 0.1 &&
          evidence.thinEnough !== false &&
          (evidence.directionChangeCount >= 1 ||
            evidence.localizedSinglePeak ||
            evidence.segmentedWaveformTrace)
            ? 1
            : 0)
        );
      }, 0),
    );
    const strongSupport = Math.ceil(
      rowFit.bands.length * 0.75,
    );
    const weakSupport = Math.floor(
      rowFit.bands.length * 0.35,
    );
    const firstIsWeak =
      supports[0] <= weakSupport &&
      supports.slice(1).every(
        (support) => support >= strongSupport,
      );
    const lastIsWeak =
      supports.at(-1) <= weakSupport &&
      supports.slice(0, -1).every(
        (support) => support >= strongSupport,
      );
    const trimmedBands = firstIsWeak
      ? columnFit.bands.slice(1)
      : lastIsWeak
        ? columnFit.bands.slice(0, -1)
        : null;
    if (trimmedBands) {
      columnFit =
        selectRegularProjectionBands(
          trimmedBands,
          trimmedBands.length,
        ) ?? columnFit;
    }
  }

  const expectedCellCount =
    rowFit.bands.length * columnFit.bands.length;
  const tableLatticeShapeConsistent =
    !requireTableWaveformGridProof ||
    Boolean(
      tableLatticeShape &&
        rowFit.bands.length === tableLatticeShape.rows &&
        columnFit.bands.length ===
          tableLatticeShape.columns,
    );
  const minimumExpectedCellCount =
    requireTableWaveformGridProof ? 4 : 8;
  if (
    expectedCellCount < minimumExpectedCellCount ||
    expectedCellCount > MAXIMUM_CHART_PANELS
  ) {
    return null;
  }

  const occupiedCells = new Set();
  const measuredCandidateByCell = new Map();
  for (const candidate of measuredCandidates) {
    const candidateWidth =
      candidate.right - candidate.left + 1;
    const candidateHeight =
      candidate.bottom - candidate.top + 1;
    if (
      candidateWidth > columnFit.step * 1.35 ||
      candidateHeight > rowFit.step * 1.35
    ) {
      continue;
    }
    const centerX =
      (candidate.left + candidate.right) / 2;
    const centerY =
      (candidate.top + candidate.bottom) / 2;
    const column = Math.round(
      (centerX - columnFit.origin) / columnFit.step,
    );
    const row = Math.round(
      (centerY - rowFit.origin) / rowFit.step,
    );
    if (
      row < 0 ||
      row >= rowFit.bands.length ||
      column < 0 ||
      column >= columnFit.bands.length ||
      Math.abs(
        centerX -
          (columnFit.origin + columnFit.step * column),
      ) >
        columnFit.step * 0.43 ||
      Math.abs(
        centerY - (rowFit.origin + rowFit.step * row),
      ) >
        rowFit.step * 0.43
    ) {
      continue;
    }
    const cellKey = `${row}:${column}`;
    occupiedCells.add(cellKey);
    const completeMeasuredCandidate =
      candidate.curveEvidence.valid &&
      candidateWidth >= columnFit.typicalSpan * 0.55 &&
      candidateHeight >= rowFit.typicalSpan * 0.5;
    if (completeMeasuredCandidate) {
      const existing = measuredCandidateByCell.get(cellKey);
      const frameScore =
        (candidate.detectionReason === "closed-plot-frame"
          ? 5
          : 0) +
        (candidate.axisMode === "rectangle" ? 3 : 0) +
        (candidate.confidence ?? 0) -
        Math.abs(
          candidateWidth - columnFit.typicalSpan,
        ) /
          Math.max(1, columnFit.typicalSpan) -
        Math.abs(candidateHeight - rowFit.typicalSpan) /
          Math.max(1, rowFit.typicalSpan);
      if (!existing || frameScore > existing.frameScore) {
        measuredCandidateByCell.set(cellKey, {
          candidate,
          frameScore,
        });
      }
    }
  }
  const minimumOccupiedCellCount = Math.max(
    4,
    Math.ceil(expectedCellCount * 0.5),
  );
  if (
    !requireTableWaveformGridProof &&
    occupiedCells.size < minimumOccupiedCellCount
  ) {
    return null;
  }
  // Complete geometric crops normally remain preferable, but a dense slide
  // can still lose one of those crops during overlap reconciliation. Continue
  // through the cell-level proof and let the repeated-grid reconciliation
  // choose one physical crop per cell. This remains gated by a measured
  // candidate cohort plus pixel-derived multi-peak topology outside table
  // mode, and by the stronger lattice-shape proof inside table mode.

  const paddingX = columnFit.latticeDerived
    ? 0
    : clamp(
        Math.round(columnFit.step * 0.055),
        4,
        24,
      );
  const paddingY = rowFit.latticeDerived
    ? 0
    : clamp(
        Math.round(rowFit.step * 0.055),
        3,
        16,
      );
  const physicalRowFit =
    requireTableWaveformGridProof
      ? projectionFitFromLatticeLines(
          tableLatticeShape?.horizontalBands,
        )
      : null;
  const projectedRowCoverages =
    usesChromaticProjection &&
    physicalRowFit?.bands.length === rowFit.bands.length
      ? rowFit.bands.map((band, index) => {
          const projectedStart = Math.max(
            0,
            band.start - paddingY,
          );
          const projectedEnd = Math.min(
            height - 1,
            band.end + paddingY,
          );
          const physicalBand = physicalRowFit.bands[index];
          return (
            overlapLength(
              projectedStart,
              projectedEnd,
              physicalBand.start,
              physicalBand.end,
            ) /
            Math.max(
              1,
              physicalBand.end - physicalBand.start + 1,
            )
          );
        })
      : [];
  const medianProjectedRowCoverage =
    projectedRowCoverages.length
      ? medianNumber(projectedRowCoverages)
      : null;
  const tableProjectionBoundsAligned =
    !requireTableWaveformGridProof ||
    !usesChromaticProjection ||
    !physicalRowFit ||
    medianProjectedRowCoverage >= 0.68;
  // A sparkline in the top half of every table cell can produce the same
  // repeated colour projection as a real chart grid, especially when the
  // lower half contains text. A genuine plot crop occupies most of its
  // physical lattice cell; a short table sparkline does not. Fail closed
  // before the achromatic retry, otherwise the surrounding table rules would
  // expand every bad crop back to a full cell and erase this distinction.
  if (!tableProjectionBoundsAligned) {
    return null;
  }
  const candidates = [];
  let chromaticCellCount = 0;
  let waveformCellCount = 0;
  let turningCellCount = 0;
  let measuredTopologyCellCount = 0;
  let measuredMultiPeakCellCount = 0;
  let plotGridCellCount = 0;
  for (let row = 0; row < rowFit.bands.length; row += 1) {
    for (
      let column = 0;
      column < columnFit.bands.length;
      column += 1
    ) {
      const rowBand = rowFit.bands[row];
      const columnBand = columnFit.bands[column];
      const cellKey = `${row}:${column}`;
      const projectedCandidate = {
        left: Math.max(0, columnBand.start - paddingX),
        top: Math.max(0, rowBand.start - paddingY),
        right: Math.min(
          width - 1,
          columnBand.end + paddingX,
        ),
        bottom: Math.min(
          height - 1,
          rowBand.end + paddingY,
        ),
        axisMode: "content",
        detectionScale: "repeated-grid",
        detectionReason: "repeated-waveform-grid",
        repeatedGridStructuralRescue: true,
      };
      const preserveMeasuredFrames =
        !requireTableWaveformGridProof &&
        measuredCandidateByCell.size === expectedCellCount;
      const measuredCellCandidate =
        preserveMeasuredFrames
          ? measuredCandidateByCell.get(cellKey)?.candidate
          : null;
      // Preserve a source-measured plot frame when one exists. Projection
      // crops are intentionally broader so they can recover a missing cell,
      // but that extra title/label ink can introduce a false peak. A real
      // closed frame gives the downstream peak/valley analyzer the exact
      // plot interior while the structural-rescue marker still lets it join
      // recovered neighbouring cells.
      const candidate = measuredCellCandidate
        ? {
            ...measuredCellCandidate,
            repeatedGridStructuralRescue: true,
          }
        : projectedCandidate;
      let cellInk = 0;
      for (let y = rowBand.start; y <= rowBand.end; y += 1) {
        for (
          let x = columnBand.start;
          x <= columnBand.end;
          x += 1
        ) {
          cellInk += chromaticMask[y * width + x] ? 1 : 0;
        }
      }
      if (cellInk >= 8) chromaticCellCount += 1;
      const curveEvidence = measureChartCurveEvidence(
        candidate,
        curveEvidenceMask,
        width,
      );
      const broadCellEvidence =
        requireTableWaveformGridProof &&
        broadEvidenceMask
          ? measureChartCurveEvidence(
              candidate,
              broadEvidenceMask,
              width,
            )
          : null;
      if (
        broadCellEvidence &&
        broadCellEvidence.ignoredRowBandCount >= 2 &&
        broadCellEvidence.ignoredColumnBandCount >= 2
      ) {
        plotGridCellCount += 1;
      }
      let hasWaveformVariation =
        curveEvidence.horizontalCoverage >= 0.18 &&
        curveEvidence.verticalVariation >= 0.075;
      let hasTurningWaveform =
        curveEvidence.directionChangeCount >= 1 ||
        curveEvidence.localizedSinglePeak ||
        curveEvidence.segmentedWaveformTrace;
      let measuredPeakCount = 0;
      let measuredPeakTopologyAccepted = false;
      let measuredPeakTopologyReason = "NOT_MEASURED";
      let measuredWaveformEvidence = null;
      if (cellInk >= 8) {
        const localWidth =
          candidate.right - candidate.left + 1;
        const localHeight =
          candidate.bottom - candidate.top + 1;
        const cropMask = (sourceMask) => {
          const cropped = new Uint8Array(
            localWidth * localHeight,
          );
          for (
            let localY = 0;
            localY < localHeight;
            localY += 1
          ) {
            const sourceStart =
              (candidate.top + localY) * width +
              candidate.left;
            cropped.set(
              sourceMask.subarray(
                sourceStart,
                sourceStart + localWidth,
              ),
              localY * localWidth,
            );
          }
          return cropped;
        };
        const rawLocalCurveMask = cropMask(
          curveEvidenceMask,
        );
        const localCurveMask =
          removeGridLinesPreservingCurves(
            rawLocalCurveMask,
            localWidth,
            localHeight,
          ).mask;
        const measuredColorMasks =
          Array.isArray(curveColorMasks) &&
          curveColorMasks.length
            ? curveColorMasks
            : [curveEvidenceMask];
        const localCurveColorMasks =
          measuredColorMasks.map((sourceMask) =>
            removeGridLinesPreservingCurves(
              cropMask(sourceMask),
              localWidth,
              localHeight,
            ).mask,
          );
        const achromaticUpperArc =
          !usesChromaticProjection
            ? extractUpperArcPeakEvidence(
                rawLocalCurveMask,
                rawLocalCurveMask,
                [rawLocalCurveMask],
                localWidth,
                localHeight,
                { minimumPeakCount: 1 },
              )
            : null;
        const measuredPeakTopology = usesChromaticProjection
          ? extractUpperArcPeakEvidence(
              localCurveMask,
              localCurveMask,
              localCurveColorMasks,
              localWidth,
              localHeight,
              {
                minimumPeakCount:
                  requireTableWaveformGridProof ? 1 : 2,
              },
            )
          : achromaticUpperArc?.accepted
            ? achromaticUpperArc
          : (() => {
              const localBroadMask = cropMask(
                broadEvidenceMask ??
                  curveEvidenceMask,
              );
              const achromaticAnalysis =
                analyzeForegroundMasks(
                  localBroadMask,
                  localCurveMask,
                  localWidth,
                  localHeight,
                  localCurveMask,
                  [],
                );
              const achromaticDescriptor =
                achromaticAnalysis.descriptor;
              const achromaticPeakCount =
                achromaticDescriptor.peakLocations?.length ??
                0;
              const achromaticValleyCount =
                achromaticDescriptor.valleyLocations?.length ??
                0;
              const accepted =
                achromaticPeakCount >= 1 &&
                achromaticValleyCount ===
                  achromaticPeakCount - 1 &&
                achromaticDescriptor.regularized !== true &&
                achromaticDescriptor.observedStateCount ===
                  achromaticDescriptor.stateCount;
              return {
                accepted,
                reason: accepted
                  ? "ACHROMATIC_PASS"
                  : "ACHROMATIC_TOPOLOGY_REJECTED",
                peakCount: achromaticPeakCount,
                profile: achromaticAnalysis.profile,
                descriptor: achromaticDescriptor,
              };
            })();
        measuredPeakCount =
          measuredPeakTopology.peakCount ?? 0;
        measuredPeakTopologyReason =
          measuredPeakTopology.reason ?? "UNKNOWN";
        measuredPeakTopologyAccepted =
          measuredPeakTopology.accepted === true &&
          measuredPeakCount >= 1 &&
          measuredPeakTopology.descriptor
            ?.valleyLocations?.length ===
            measuredPeakCount - 1;
        if (measuredPeakTopologyAccepted) {
          measuredTopologyCellCount += 1;
          if (measuredPeakCount >= 2) {
            measuredMultiPeakCellCount += 1;
          }
          measuredWaveformEvidence = {
            profile: [...measuredPeakTopology.profile],
            descriptor: {
              ...measuredPeakTopology.descriptor,
              peakLocations: [
                ...measuredPeakTopology.descriptor
                  .peakLocations,
              ],
              peakWidths: [
                ...measuredPeakTopology.descriptor.peakWidths,
              ],
              valleyHeights: [
                ...measuredPeakTopology.descriptor
                  .valleyHeights,
              ],
              valleyLocations: [
                ...measuredPeakTopology.descriptor
                  .valleyLocations,
              ],
              valleyDepths: [
                ...measuredPeakTopology.descriptor
                  .valleyDepths,
              ],
              valleyPositionRatios: [
                ...measuredPeakTopology.descriptor
                  .valleyPositionRatios,
              ],
              peakValleyDistances: [
                ...measuredPeakTopology.descriptor
                  .peakValleyDistances,
              ],
              tailSlopes: [
                ...measuredPeakTopology.descriptor.tailSlopes,
              ],
            },
            source: "table-grid-measured-topology",
          };
          // Deep log-scale valleys split a dense six-or-more-State trace into
          // short segments, so the generic single-path metric can look weak
          // even though the measured upper envelope contains every peak and
          // adjacent valley. An accepted pixel-derived topology is stronger
          // evidence than that path heuristic.
          hasWaveformVariation = true;
          hasTurningWaveform = true;
        }
      }
      if (hasWaveformVariation) waveformCellCount += 1;
      if (hasTurningWaveform) turningCellCount += 1;
      candidates.push({
        ...candidate,
        confidence: clamp(
          0.7 + curveEvidence.score * 0.25,
          0,
          0.98,
        ),
        curveEvidence: {
          ...(measuredCellCandidate
            ? measuredCellCandidate.curveEvidence
            : curveEvidence),
          repeatedGridStructuralRescue: true,
          repeatedGridChromaticPixelCount: cellInk,
          measuredPeakCount,
          measuredPeakTopologyAccepted,
          measuredPeakTopologyReason,
        },
        measuredWaveformEvidence,
      });
    }
  }
  const minimumMeasuredMultiPeakCells =
    requireTableWaveformGridProof
      ? 0
      : Math.max(4, Math.ceil(expectedCellCount * 0.5));
  const minimumMeasuredTopologyCells =
    requireTableWaveformGridProof
      ? expectedCellCount
      : 0;
  const minimumPlotGridCells =
    requireTableWaveformGridProof
      ? Math.max(3, Math.ceil(expectedCellCount * 0.75))
      : 0;
  const measuredWaveformGridProof =
    requireTableWaveformGridProof
      ? measuredTopologyCellCount >=
        minimumMeasuredTopologyCells
      : measuredMultiPeakCellCount >=
        minimumMeasuredMultiPeakCells;
  const tableEmbeddedWaveformGridProof =
    requireTableWaveformGridProof &&
    measuredWaveformGridProof &&
    tableLatticeShapeConsistent &&
    plotGridCellCount >= minimumPlotGridCells;
  if (
    chromaticCellCount <
      Math.ceil(expectedCellCount * 0.9) ||
    waveformCellCount !== expectedCellCount ||
    turningCellCount <
      Math.ceil(expectedCellCount * 0.75) ||
    !measuredWaveformGridProof ||
    (requireTableWaveformGridProof &&
      (!tableLatticeShapeConsistent ||
        plotGridCellCount < minimumPlotGridCells))
  ) {
    return retryWithAchromaticProjection();
  }
  if (tableEmbeddedWaveformGridProof) {
    for (const candidate of candidates) {
      candidate.tableEmbeddedWaveformGridProof = true;
      candidate.curveEvidence.tableEmbeddedWaveformGridProof =
        true;
      if (candidate.measuredWaveformEvidence) {
        candidate.verifiedWaveform =
          candidate.measuredWaveformEvidence;
      }
    }
  }
  for (const candidate of candidates) {
    delete candidate.measuredWaveformEvidence;
  }
  return {
    candidates,
    anchorCount: measuredCandidates.length,
    occupiedCellCount: occupiedCells.size,
    minimumOccupiedCellCount:
      requireTableWaveformGridProof
        ? 0
        : minimumOccupiedCellCount,
    waveformCellCount,
    turningCellCount,
    measuredTopologyCellCount,
    minimumMeasuredTopologyCells,
    measuredMultiPeakCellCount,
    minimumMeasuredMultiPeakCells,
    plotGridCellCount,
    minimumPlotGridCells,
    measuredWaveformGridProof,
    tableEmbeddedWaveformGridProof,
    tableLatticeShapeConsistent,
    tableProjectionBoundsAligned,
    medianProjectedRowCoverage,
    expectedCellCount,
    rows: rowFit.bands.length,
    columns: columnFit.bands.length,
    frameWidth: Math.round(columnFit.typicalSpan),
    frameHeight: Math.round(rowFit.typicalSpan),
    columnStep: columnFit.step,
    rowStep: rowFit.step,
    recoveryMode: "chromatic-repeated-lattice",
    projectionMode: usesChromaticProjection
      ? "chromatic"
      : "achromatic-curve",
    requireTurningTopologyOutsideGrid: true,
  };
}

function recoverRepeatedWaveformGridCandidates(
  measuredCandidates,
  broadEvidenceMask,
  curveEvidenceMask,
  curveColorMasks,
  width,
  height,
  allowChromaticRecovery = true,
  requireTableWaveformGridProof = false,
  tableLatticeShape = null,
) {
  return (
    (requireTableWaveformGridProof
      ? null
      : recoverStrictRepeatedWaveformGridCandidates(
          measuredCandidates,
          curveEvidenceMask,
          width,
          height,
        )) ??
    (allowChromaticRecovery
      ? recoverChromaticRepeatedWaveformGridCandidates(
          measuredCandidates,
          broadEvidenceMask,
          curveEvidenceMask,
          curveColorMasks,
          width,
          height,
          requireTableWaveformGridProof,
          tableLatticeShape,
        )
      : null)
  );
}

function isCredibleCandidateOutsideRepeatedGrid(
  candidate,
  requireTurningTopology = false,
  repeatedGridRecovery = null,
) {
  const evidence = candidate.curveEvidence;
  const candidateWidth =
    candidate.right - candidate.left + 1;
  const candidateHeight =
    candidate.bottom - candidate.top + 1;
  const plausibleIndependentPanelSize =
    !requireTurningTopology ||
    !repeatedGridRecovery ||
    (candidateWidth >= repeatedGridRecovery.frameWidth * 0.45 &&
      candidateHeight >=
        repeatedGridRecovery.frameHeight * 0.5);
  const turningWaveformTopology =
    evidence.localizedSinglePeak ||
    evidence.segmentedWaveformTrace ||
    (evidence.continuousCoverage >= 0.28 &&
      evidence.directionChangeCount >= 2 &&
      evidence.verticalVariation >= 0.075);
  return (
    evidence.valid &&
    !evidence.tableGridArtifact &&
    evidence.horizontalCoverage >= 0.42 &&
    evidence.verticalVariation >= 0.045 &&
    evidence.thinEnough !== false &&
    plausibleIndependentPanelSize &&
    (requireTurningTopology
      ? turningWaveformTopology
      : evidence.colorSeriesCount >= 1 ||
        turningWaveformTopology ||
        (evidence.continuousCoverage >= 0.3 &&
          evidence.directionChangeCount >= 1))
  );
}

function reconcileArbitraryWaveformCandidates(
  candidates,
  width,
  height,
  separationEvidenceMask,
) {
  let established = candidates.filter(
    (candidate) =>
      candidate.detectionReason !==
      "arbitrary-waveform-region",
  );
  const recovered = candidates
    .filter(
      (candidate) =>
        candidate.detectionReason ===
        "arbitrary-waveform-region",
    )
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        area(left) - area(right),
    );
  established = established.filter((existing) => {
    if (existing.axisMode !== "l-axis") return true;
    const physicalChildren = recovered.filter(
      (candidate) =>
        candidate.spatialFrameRecovered === true &&
        candidate.spatialFrameSupport >= 0.8 &&
        area(candidate) <= area(existing) * 0.8 &&
        intersectionArea(existing, candidate) >=
          area(candidate) * 0.45,
    );
    if (physicalChildren.length < 2) return true;
    const independentlySeparated = physicalChildren.every(
      (candidate, candidateIndex) =>
        physicalChildren.every(
          (other, otherIndex) =>
            candidateIndex === otherIndex ||
            (intersectionArea(candidate, other) === 0 &&
              clearSeparationGutter(
                candidate,
                other,
                separationEvidenceMask,
                width,
                height,
                { localOnly: true },
              )),
        ),
    );
    // A broad open-axis hypothesis can bridge two nearby physical plot
    // frames. Split only when every child has strong four-side frame support
    // and a real blank gutter; unframed State pieces cannot trigger this.
    return !independentlySeparated;
  });
  if (
    established.length === 0 &&
    recovered.length === 1 &&
    recovered[0].axisMode === "content" &&
    !recovered[0].spatialFrameRecovered &&
    area(recovered[0]) >= width * height * 0.25
  ) {
    // A single broad frameless region is normally the primary graph occupying
    // the input, not an independently cropped PPT panel. Let the verified
    // whole-image fallback preserve its full context. Spatial recovery remains
    // active for every smaller/off-centre chart and for physical frames.
    return [];
  }
  for (const candidate of recovered) {
    const overlappingIndexes = [];
    for (
      let index = 0;
      index < established.length;
      index += 1
    ) {
      const existing = established[index];
      if (
        intersectionArea(existing, candidate) >
        Math.min(area(existing), area(candidate)) * 0.08
      ) {
        overlappingIndexes.push(index);
      }
    }
    if (!overlappingIndexes.length) {
      established.push(candidate);
      continue;
    }
    if (overlappingIndexes.length > 1) {
      // A broad spatial component covering multiple independently validated
      // frames/axes is a dilation bridge, not evidence that those physical
      // panels should be deleted or merged. Spatial recovery may complete one
      // partial candidate, but it must never override several established
      // chart hypotheses at once.
      continue;
    }
    const existingIndex = overlappingIndexes[0];
    const existing = established[existingIndex];
    const physicalFrameCorroboration =
      existing.axisMode === "rectangle" &&
      candidate.spatialFrameRecovered === true &&
      candidate.spatialFrameSupport >= 0.85 &&
      intersectionArea(existing, candidate) >=
        Math.min(area(existing), area(candidate)) * 0.65 &&
      area(candidate) <= area(existing) * 2.5 &&
      area(existing) <= area(candidate) * 2.5;
    if (physicalFrameCorroboration) {
      // Preserve the tighter geometric crop, while carrying forward the
      // independent spatial proof that this local frame encloses a waveform.
      // This is especially useful for low-resolution plots whose legitimate
      // grid lines look locally table-like.
      established[existingIndex] = {
        ...existing,
        spatialFrameRecovered: true,
        spatialFrameSupport: Math.max(
          existing.spatialFrameSupport ?? 0,
          candidate.spatialFrameSupport,
        ),
        spatialChromaticTopology:
          candidate.spatialChromaticTopology,
      };
      continue;
    }
    const existingWidth = existing.right - existing.left + 1;
    const candidateWidth = candidate.right - candidate.left + 1;
    const existingHeight = existing.bottom - existing.top + 1;
    const combinedHeight =
      Math.max(existing.bottom, candidate.bottom) -
      Math.min(existing.top, candidate.top) +
      1;
    const existingCoverage =
      existing.curveEvidence?.horizontalCoverage ?? 0;
    const candidateCoverage =
      candidate.curveEvidence?.horizontalCoverage ?? 0;
    const existingAbsoluteTraceSpan =
      existingWidth * existingCoverage;
    const candidateAbsoluteTraceSpan =
      candidateWidth * candidateCoverage;
    const partialLAxis =
      existing.axisMode === "l-axis" &&
      candidateWidth >= existingWidth * 0.8 &&
      (candidate.spatialFrameRecovered ||
        candidateWidth >= existingWidth * 1.18 ||
        combinedHeight >= existingHeight * 1.08 ||
        candidateCoverage >= existingCoverage + 0.04 ||
        (candidate.curveEvidence?.directionChangeCount ?? 0) >
          (existing.curveEvidence?.directionChangeCount ?? 0)) &&
      area(candidate) <= area(existing) * 6;
    const spatiallyCompletesFramelessCurve =
      candidate.spatialChromaticTopology?.valid === true &&
      candidateAbsoluteTraceSpan >=
        existingAbsoluteTraceSpan * 1.15 &&
      area(candidate) <= area(existing) * 3;
    const partialFramelessCurve =
      existing.detectionReason ===
        "frameless-curve-region" &&
      candidateWidth >= existingWidth * 0.9 &&
      (spatiallyCompletesFramelessCurve ||
        (candidate.axisMode === "content" &&
          combinedHeight >= existingHeight * 1.12 &&
          candidateCoverage >= existingCoverage * 0.9 &&
          area(candidate) <= area(existing) * 2.5 &&
          (candidate.spatialChromaticTopology?.valid ||
            (candidate.curveEvidence?.directionChangeCount ??
              0) >= 2 ||
            (candidate.curveEvidence
              ?.segmentedWaveformTrace === true &&
              (candidate.curveEvidence?.curvedSegmentCount ??
                0) >= 3))));
    if (partialLAxis || partialFramelessCurve) {
      established[existingIndex] =
        candidate.spatialFrameRecovered
          ? candidate
          : {
              ...candidate,
              left: Math.min(existing.left, candidate.left),
              // A physical L-axis gives the reliable top/bottom extent while
              // the spatial Curve supplies the missing right-hand span.
              top: Math.min(existing.top, candidate.top),
              right: Math.max(existing.right, candidate.right),
              bottom: Math.max(
                existing.bottom,
                candidate.bottom,
              ),
            };
    }
  }
  return established;
}

function mergeLocalSpatialWaveformFragments(
  candidates,
  curveEvidenceMask,
  width,
  height,
) {
  const normalizedCandidates = candidates.map((candidate) =>
    candidate.detectionReason ===
      "arbitrary-waveform-region"
      ? clipSpatialCandidateAtInternalEdgeGutter(
          candidate,
          curveEvidenceMask,
          width,
          height,
        )
      : candidate,
  );
  const fragments = normalizedCandidates.filter(
    (candidate) =>
      candidate.detectionReason ===
        "arbitrary-waveform-region" &&
      candidate.axisMode === "content" &&
      !candidate.spatialFrameRecovered,
  );
  if (fragments.length < 2) return normalizedCandidates;

  const unvisited = new Set(
    fragments.map((_candidate, index) => index),
  );
  const groups = [];
  while (unvisited.size) {
    const seed = unvisited.values().next().value;
    unvisited.delete(seed);
    const indexes = [seed];
    for (let cursor = 0; cursor < indexes.length; cursor += 1) {
      const current = fragments[indexes[cursor]];
      for (const otherIndex of [...unvisited]) {
        const other = fragments[otherIndex];
        const verticalOverlap = overlapLength(
          current.top,
          current.bottom,
          other.top,
          other.bottom,
        );
        const verticallyAligned =
          verticalOverlap >=
          Math.min(
            current.bottom - current.top + 1,
            other.bottom - other.top + 1,
          ) *
            0.35;
        const first =
          current.left <= other.left ? current : other;
        const second =
          first === current ? other : current;
        const clearGutter = clearSeparationGutter(
          current,
          other,
          curveEvidenceMask,
          width,
          height,
        ) || findClearVerticalCurveCorridor(
          current,
          other,
          curveEvidenceMask,
          width,
          height,
        );
        const hasInterveningFragment = normalizedCandidates.some(
          (intervening) =>
            intervening !== current &&
            intervening !== other &&
            intervening.left > first.right &&
            intervening.right < second.left &&
            overlapLength(
              intervening.top,
              intervening.bottom,
              Math.max(current.top, other.top),
              Math.min(current.bottom, other.bottom),
            ) > 0,
        );
        if (
          !verticallyAligned ||
          hasInterveningFragment ||
          clearGutter
        ) {
          continue;
        }
        unvisited.delete(otherIndex);
        indexes.push(otherIndex);
      }
    }
    groups.push(indexes.map((index) => fragments[index]));
  }

  const mergedFragments = groups.flatMap((group) => {
    if (group.length < 2) return group;
    const union = {
      left: Math.min(...group.map((candidate) => candidate.left)),
      top: Math.min(...group.map((candidate) => candidate.top)),
      right: Math.max(...group.map((candidate) => candidate.right)),
      bottom: Math.max(...group.map((candidate) => candidate.bottom)),
      axisMode: "content",
    };
    const groupWidth = union.right - union.left + 1;
    const groupHeight = union.bottom - union.top + 1;
    const paddingX = clamp(
      Math.round(groupWidth * 0.025),
      4,
      Math.max(4, Math.round(width * 0.025)),
    );
    const paddingY = clamp(
      Math.round(groupHeight * 0.08),
      4,
      Math.max(4, Math.round(height * 0.03)),
    );
    const bounds = {
      left: Math.max(0, union.left - paddingX),
      top: Math.max(0, union.top - paddingY),
      right: Math.min(width - 1, union.right + paddingX),
      bottom: Math.min(height - 1, union.bottom + paddingY),
      axisMode: "content",
    };
    const curveEvidence = measureChartCurveEvidence(
      bounds,
      curveEvidenceMask,
      width,
    );
    if (
      !curveEvidence.valid ||
      curveEvidence.tableGridArtifact
    ) {
      return group;
    }
    return [
      {
        ...bounds,
        confidence: clamp(
          Math.max(
            ...group.map(
              (candidate) => candidate.confidence,
            ),
          ) * 0.97,
          0,
          0.97,
        ),
        detectionScale: "spatial",
        detectionReason: "grouped-waveform-region",
        curveEvidence,
        groupedFragmentCount: group.length,
      },
    ];
  });
  const fragmentSet = new Set(fragments);
  return clipCandidatesAtClearVerticalCorridors([
    ...normalizedCandidates.filter(
      (candidate) => !fragmentSet.has(candidate),
    ),
    ...mergedFragments,
  ], curveEvidenceMask, width, height);
}

function candidateCoveredByRotatedLattice(
  candidate,
  analysis,
  width,
  height,
) {
  const latticeBounds = analysis?.lattice?.bounds;
  if (
    !analysis?.tableGridArtifact ||
    !latticeBounds ||
    !Number.isFinite(analysis.angle)
  ) {
    return false;
  }
  const radians = (analysis.angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const rotatePoint = (x, y) => {
    const localX = x - centerX;
    const localY = y - centerY;
    return {
      x: cosine * localX - sine * localY + centerX,
      y: sine * localX + cosine * localY + centerY,
    };
  };
  const candidateCenter = rotatePoint(
    (candidate.left + candidate.right) / 2,
    (candidate.top + candidate.bottom) / 2,
  );
  const paddingX = Math.max(
    3,
    (latticeBounds.right - latticeBounds.left + 1) *
      0.025,
  );
  const paddingY = Math.max(
    3,
    (latticeBounds.bottom - latticeBounds.top + 1) *
      0.025,
  );
  return (
    candidateCenter.x >= latticeBounds.left - paddingX &&
    candidateCenter.x <= latticeBounds.right + paddingX &&
    candidateCenter.y >= latticeBounds.top - paddingY &&
    candidateCenter.y <= latticeBounds.bottom + paddingY
  );
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
 *   sourceScale?: number;
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
  let foregroundPixelCount = 0;
  for (let index = 0; index < width * height; index += 1) {
    if (mask[index]) foregroundPixelCount += 1;
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
    4,
    Math.round(width * minimumWidthRatio),
  );
  const minimumHeight = Math.max(
    4,
    Math.round(height * minimumHeightRatio),
  );
  const compactMinimumAreaRatio =
    options.compactMinimumPanelAreaRatio ??
    Math.min(
      minimumAreaRatio,
      COMPACT_MINIMUM_PANEL_AREA_RATIO,
    );
  const compactMinimumWidth = Math.max(
    3,
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
    3,
    Math.round(
      height *
        (options.compactMinimumPanelHeightRatio ??
          Math.min(
            minimumHeightRatio,
            COMPACT_MINIMUM_PANEL_HEIGHT_RATIO,
      )),
    ),
  );
  const axisAlignedDocumentLattice =
    analyzeAxisAlignedDocumentLattice(
      mask,
      width,
      height,
    );
  const excessiveDenseDocumentGrid =
    axisAlignedDocumentLattice.tableGridArtifact &&
    (axisAlignedDocumentLattice.horizontalBandCount ?? 0) >=
      64 &&
    (axisAlignedDocumentLattice.verticalBandCount ?? 0) >=
      64;
  if (excessiveDenseDocumentGrid) {
    return {
      panels: [],
      layout: { rows: 0, columns: 0 },
      fallbackUsed: false,
      detectedPanelCount: 0,
      rejectedNonChartCount: 1,
      truncated: false,
      maxPanels: MAXIMUM_CHART_PANELS,
      diagnostics: {
        foregroundPixelCount,
        foregroundRatio:
          foregroundPixelCount /
          Math.max(1, width * height),
        geometricCandidateCount: 0,
        validCandidateCount: 0,
        rejectedCandidateCount: 1,
        ambiguousCandidateCount: 0,
        candidateSummaries: [],
        measuredCandidateSummaries: [],
        repeatedGridRecovery: { applied: false },
        arbitraryWaveformRecovery: {
          attempted: false,
          applied: false,
          recovered: 0,
        },
        tableLatticeDominant: {
          axisAligned: true,
          axisAlignedHorizontalBandCount:
            axisAlignedDocumentLattice.horizontalBandCount,
          axisAlignedVerticalBandCount:
            axisAlignedDocumentLattice.verticalBandCount,
          axisAlignedBounds:
            axisAlignedDocumentLattice.bounds ?? null,
          sharedFrame: true,
          rotated: false,
        },
        excessiveDenseDocumentGrid: true,
        lowResolutionRecoveryApplied: false,
        sourceScale: Math.max(
          1,
          Number(options.sourceScale) || 1,
        ),
      },
      lowResolutionRecovery: {
        applied: false,
        maximumGap: 0,
        repairedPixelCount: 0,
      },
    };
  }
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
  const microCandidates =
    compactMinimumWidth > 32 ||
    compactMinimumHeight > 24
      ? detectGeometricCandidatesAtScale(
          workingMask,
          width,
          height,
          Math.min(compactMinimumWidth, 28),
          Math.min(compactMinimumHeight, 22),
          "micro",
          2,
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
    // Line-gap repair is useful for geometric axes, but applying it to the
    // Curve source can join two independent frameless charts across a real
    // 1–3 px gutter. Preserve the original topology when the caller provides
    // only one mask.
    mask;
  const sharedFrameCellCandidates =
    detectSharedFrameCellCandidates(
      mask,
      curveEvidenceMask,
      width,
      height,
      compactMinimumWidth,
      compactMinimumHeight,
    );
  const localSharedFrameCellCandidates =
    !axisAlignedDocumentLattice.tableGridArtifact &&
    sharedFrameCellCandidates.length < 3
      ? detectSharedFrameCellCandidates(
          mask,
          curveEvidenceMask,
          width,
          height,
          compactMinimumWidth,
          compactMinimumHeight,
          1,
        )
      : sharedFrameCellCandidates;
  const localSingleStripDocumentSignal =
    ((axisAlignedDocumentLattice.horizontalBandCount ?? 0) ===
      2 &&
      (axisAlignedDocumentLattice.verticalBandCount ?? 0) <
        3) ||
    ((axisAlignedDocumentLattice.verticalBandCount ?? 0) ===
      2 &&
      (axisAlignedDocumentLattice.horizontalBandCount ?? 0) <
        3);
  const waveformValidatedOneDimensionalSharedLattice =
    localSingleStripDocumentSignal
      ? measureLocalOneDimensionalSharedLattice(
          localSharedFrameCellCandidates,
          width,
          height,
        )
      : null;
  const physicalOneDimensionalSharedLattice =
    !axisAlignedDocumentLattice.tableGridArtifact &&
    localSingleStripDocumentSignal
      ? measurePhysicalOneDimensionalSharedLattice(
          mask,
          width,
          height,
          compactMinimumWidth,
          compactMinimumHeight,
        )
      : null;
  const localOneDimensionalSharedLattice =
    waveformValidatedOneDimensionalSharedLattice ??
    physicalOneDimensionalSharedLattice;
  const sharedFrameDocumentEvidence =
    sharedFrameCellCandidates.length >=
    MINIMUM_DENSE_SEPARATION_CANDIDATES
      ? measureChartCurveEvidence(
          {
            left: 0,
            top: 0,
            right: width - 1,
            bottom: height - 1,
            axisMode: "content",
          },
          curveEvidenceMask,
          width,
        )
      : undefined;
  const sharedFrameGridArtifact =
    axisAlignedDocumentLattice.tableGridArtifact ||
    sharedFrameDocumentEvidence?.tableGridArtifact === true;
  const eligibleSharedFrameCellCandidates =
    sharedFrameGridArtifact
      ? []
      : sharedFrameCellCandidates;
  // Exact-gap and shared-frame hypotheses are intentionally permissive
  // because their job is to split dense slide layouts. Activating them for a
  // lone card would also promote a chevron or a few dark grid cells. Require
  // repeated panel structure; ordinary one-to-five chart uploads continue to
  // use the stricter geometric and frameless paths above.
  const denseSeparationDetected =
    separationCandidates.length >=
      MINIMUM_DENSE_SEPARATION_CANDIDATES ||
    eligibleSharedFrameCellCandidates.length >=
      MINIMUM_DENSE_SEPARATION_CANDIDATES;
  const retainedSeparationCandidates =
    denseSeparationDetected ? separationCandidates : [];
  const retainedSharedFrameCellCandidates =
    eligibleSharedFrameCellCandidates.length >=
    MINIMUM_DENSE_SEPARATION_CANDIDATES
      ? eligibleSharedFrameCellCandidates
      : [];
  const framelessDetection = detectFramelessCurveCandidates(
    curveEvidenceMask,
    options.curveColorMasks,
    width,
    height,
    options.sourceScale,
  );
  const geometricCandidates = removeDuplicateAndGridCandidates(
    [
      ...strictCandidates,
      ...compactCandidates,
      ...microCandidates,
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
    workingMask,
  );
  const achromaticCurveMask =
    buildAchromaticCurveResidual(
      curveEvidenceMask,
      options.curveColorMasks,
      width,
    );
  const curveColorUnionMask = mergeCurveColorMasks(
    options.curveColorMasks,
    width,
    height,
  );
  const measuredCandidates = geometricCandidates.map((candidate) => {
    const sourceCurveEvidence =
      candidate.curveEvidence ??
      measureChartCurveEvidence(
        candidate,
        curveEvidenceMask,
        width,
      );
    const locallyUpscaledEvidence =
      !sourceCurveEvidence.valid
        ? measureLocallyUpscaledCurveEvidence(
            candidate,
            curveEvidenceMask,
            curveColorUnionMask,
            workingMask,
            width,
            height,
          )
        : null;
    const tinyChromaticSignature =
      measureTinyChromaticWaveformSignature(
        candidate,
        options.curveColorMasks,
        width,
        height,
        {
          // A physical plot frame is already a bounded local ROI. Preserve
          // the same chromatic-trajectory proof for a 90 × 66 thumbnail even
          // when its area narrowly exceeds the generic frameless threshold.
          ignoreRelativeAreaLimit:
            candidate.axisMode !== "content",
        },
      );
    const microFrameSignal = measureMicroFrameSignal(
      candidate,
      curveEvidenceMask,
      workingMask,
      width,
    );
    const sourceTextGlyphArtifact =
      sourceCurveEvidence.textGlyphArtifact === true ||
      locallyUpscaledEvidence?.textGlyphArtifact === true;
    const physicalChromaticWaveformProof =
      sourceTextGlyphArtifact &&
      candidate.axisMode !== "content" &&
      tinyChromaticSignature?.valid === true &&
      sourceCurveEvidence
        .rawRepeatedGlyphLikeComponentCount === 2 &&
      sourceCurveEvidence
        .rawRepeatedGlyphMedianHeightRatio >= 0.3 &&
      sourceCurveEvidence
        .rawRepeatedGlyphMedianAspectRatio >= 1.05 &&
      sourceCurveEvidence
        .rawRepeatedGlyphMedianAspectRatio <= 1.35 &&
      !axisAlignedDocumentLattice.tableGridArtifact &&
      !sharedFrameGridArtifact;
    let broadCurveEvidence =
      tinyChromaticSignature?.valid &&
      (!sourceTextGlyphArtifact ||
        physicalChromaticWaveformProof)
        ? {
            ...(locallyUpscaledEvidence ??
              sourceCurveEvidence),
            valid: true,
            textGlyphArtifact: false,
            score: Math.max(
              locallyUpscaledEvidence?.score ?? 0,
              sourceCurveEvidence.score,
              tinyChromaticSignature.score,
            ),
            horizontalCoverage: Math.max(
              locallyUpscaledEvidence?.horizontalCoverage ??
                0,
              sourceCurveEvidence.horizontalCoverage,
              tinyChromaticSignature.horizontalCoverage,
            ),
            verticalVariation: Math.max(
              locallyUpscaledEvidence?.verticalVariation ??
                0,
              sourceCurveEvidence.verticalVariation,
              tinyChromaticSignature.verticalVariation,
            ),
            localUpscaleApplied:
              locallyUpscaledEvidence?.localUpscaleApplied ===
              true,
            tinyChromaticRescue: true,
            tinyChromaticColorCount:
              tinyChromaticSignature.colorCount,
            tinyChromaticTrajectoryCount:
              tinyChromaticSignature.trajectoryColorCount,
            tinyChromaticDensity:
              tinyChromaticSignature.density,
            physicalChromaticTextVetoOverride:
              physicalChromaticWaveformProof,
          }
        : locallyUpscaledEvidence ?? sourceCurveEvidence;
    if (
      !broadCurveEvidence.valid &&
      !broadCurveEvidence.textGlyphArtifact &&
      !sourceTextGlyphArtifact &&
      microFrameSignal?.valid
    ) {
      broadCurveEvidence = {
        ...broadCurveEvidence,
        valid: true,
        score: Math.max(
          broadCurveEvidence.score,
          microFrameSignal.score,
        ),
        horizontalCoverage: Math.max(
          broadCurveEvidence.horizontalCoverage,
          0.4,
        ),
        continuousCoverage: Math.max(
          broadCurveEvidence.continuousCoverage,
          0.25,
        ),
        verticalVariation: Math.max(
          broadCurveEvidence.verticalVariation,
          0.12,
        ),
        microFrameSignalRescue: true,
        microFrameCurvePixelCount:
          microFrameSignal.curvePixelCount,
        microFrameBroadResidualPixelCount:
          microFrameSignal.broadResidualPixelCount,
      };
    }
    const colorSeriesEvidence =
      measureColorSeriesCurveEvidence(
        candidate,
        options.curveColorMasks,
        achromaticCurveMask,
        width,
      );
    const colorSeriesRescue =
      !sourceTextGlyphArtifact &&
      !broadCurveEvidence.textGlyphArtifact &&
      (colorSeriesEvidence.seriesCount >= 2 ||
        (colorSeriesEvidence.seriesCount >= 1 &&
          candidate.axisMode !== "content" &&
          !axisAlignedDocumentLattice.tableGridArtifact &&
          !sharedFrameGridArtifact));
    const rescuedCurveEvidence = colorSeriesRescue
      ? {
          ...broadCurveEvidence,
          valid: true,
          score: Math.max(
            broadCurveEvidence.score,
            colorSeriesEvidence.score,
          ),
          colorSeriesCount:
            colorSeriesEvidence.seriesCount,
          colorSeriesEvidence:
            colorSeriesEvidence.evidences,
        }
      : broadCurveEvidence;
    // Frame support, local upscaling, or a coloured series must not turn an
    // annotation chevron into a density chart. Inspect the physical source
    // trace before any low-resolution rescue mutates `valid`.
    const curveEvidence =
      isAngularApexArtifact(sourceCurveEvidence)
        ? {
            ...rescuedCurveEvidence,
            valid: false,
            angularApexArtifact: true,
          }
        : rescuedCurveEvidence;
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
  const dominantMultiSeriesWaveform =
    measuredCandidates.find(
      (candidate) =>
        candidate.curveEvidence.valid &&
        !candidate.curveEvidence.tableGridArtifact &&
        (candidate.curveEvidence.colorSeriesCount ?? 0) >=
          2 &&
        area(candidate) / Math.max(1, width * height) >=
          0.3,
    ) ?? null;
  // Run the bounded spatial pass independently of an expected chart count.
  // Its own topology/frame guards reject isolated State arcs, so one, three or
  // eleven arbitrarily placed plots receive the same recovery opportunity as
  // a dense thirty-panel slide.
  const rawArbitraryWaveformRecovery =
    recoverArbitraryWaveformCandidates(
      curveEvidenceMask,
      options.curveColorMasks,
      workingMask,
      edgeEvidenceMask ?? workingMask,
      width,
      height,
    );
  const largestMeasuredCandidateAreaRatio =
    measuredCandidates.reduce(
      (maximum, candidate) =>
        Math.max(
          maximum,
          area(candidate) / Math.max(1, width * height),
        ),
      0,
    );
  const deskewedPhysicalFrameRecovery =
    largestMeasuredCandidateAreaRatio < 0.22
      ? recoverDeskewedPhysicalFrame(
          mask,
          options.edgeEvidenceMask ?? mask,
          curveEvidenceMask,
          rawArbitraryWaveformRecovery.candidates,
          width,
          height,
        )
      : null;
  const arbitraryWaveformRecovery =
    dominantMultiSeriesWaveform
      ? {
          ...rawArbitraryWaveformRecovery,
          candidates:
            rawArbitraryWaveformRecovery.candidates.filter(
              (candidate) =>
                intersectionArea(
                  candidate,
                  dominantMultiSeriesWaveform,
                ) /
                  Math.max(1, area(candidate)) <
                0.5,
            ),
          suppressedInsideDominantCount:
            rawArbitraryWaveformRecovery.candidates.filter(
              (candidate) =>
                intersectionArea(
                  candidate,
                  dominantMultiSeriesWaveform,
                ) /
                  Math.max(1, area(candidate)) >=
                0.5,
            ).length,
        }
      : rawArbitraryWaveformRecovery;
  let extendedDeskewedDocument;
  const getExtendedDeskewedDocument = () => {
    if (!extendedDeskewedDocument) {
      extendedDeskewedDocument =
        analyzeExtendedDeskewedDocument(
          mask,
          curveEvidenceMask,
          width,
          height,
        );
    }
    return extendedDeskewedDocument;
  };
  const rotatedDocumentTableGridArtifact =
    (measuredCandidates.some(
      (candidate) =>
        candidate.curveEvidence.valid &&
        (candidate.axisMode === "l-axis" ||
          candidate.detectionReason ===
            "frameless-curve-region"),
    ) ||
      arbitraryWaveformRecovery.candidates.some(
        (candidate) =>
          candidate.axisMode === "content" &&
          !candidate.spatialFrameRecovered,
      )) &&
    getExtendedDeskewedDocument().tableGridArtifact;
  const proofLattice =
    axisAlignedDocumentLattice.tableGridArtifact
      ? axisAlignedDocumentLattice
      : localOneDimensionalSharedLattice
        ? localOneDimensionalSharedLattice
      : rotatedDocumentTableGridArtifact
        ? getExtendedDeskewedDocument().lattice
        : null;
  const tableLatticeShape =
    proofLattice &&
    proofLattice.horizontalBandCount >= 2 &&
    proofLattice.verticalBandCount >= 2 &&
    (proofLattice.horizontalBandCount >= 3 ||
      proofLattice.verticalBandCount >= 3)
      ? {
          rows: proofLattice.horizontalBandCount - 1,
          columns: proofLattice.verticalBandCount - 1,
          horizontalBands:
            proofLattice === axisAlignedDocumentLattice ||
            proofLattice.localOneDimensionalSharedLattice ===
              true
              ? proofLattice.horizontalBands
              : null,
          verticalBands:
            proofLattice === axisAlignedDocumentLattice ||
            proofLattice.localOneDimensionalSharedLattice ===
              true
              ? proofLattice.verticalBands
              : null,
        }
      : null;
  const repeatedGridRecovery =
    recoverRepeatedWaveformGridCandidates(
      measuredCandidates,
      mask,
      curveEvidenceMask,
      options.curveColorMasks,
      width,
      height,
      true,
      axisAlignedDocumentLattice.tableGridArtifact ||
        Boolean(localOneDimensionalSharedLattice) ||
        rotatedDocumentTableGridArtifact,
      tableLatticeShape,
    );
  const candidatePool = repeatedGridRecovery
    ? [
        ...measuredCandidates,
        ...arbitraryWaveformRecovery.candidates,
        ...(deskewedPhysicalFrameRecovery
          ? [deskewedPhysicalFrameRecovery.candidate]
          : []),
        ...repeatedGridRecovery.candidates,
      ]
    : [
        ...measuredCandidates,
        ...arbitraryWaveformRecovery.candidates,
        ...(deskewedPhysicalFrameRecovery
          ? [deskewedPhysicalFrameRecovery.candidate]
          : []),
      ];
  const geometricRejectedNonChartCount = measuredCandidates.reduce(
    (count, candidate) =>
      count + (candidate.curveEvidence.valid ? 0 : 1),
    0,
  );
  let candidates = candidatePool.filter(
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
      const locallyVerifiedTinyWaveform =
        (candidate.curveEvidence.localUpscaleApplied === true ||
          candidate.curveEvidence.tinyChromaticRescue ===
            true ||
          (candidate.spatialFrameRecovered === true &&
            candidate.spatialFrameSupport >= 0.62) ||
          candidate.curveEvidence.microFrameSignalRescue ===
            true ||
          (candidate.axisMode !== "content" &&
            candidate.right - candidate.left + 1 <= 100 &&
            candidate.bottom - candidate.top + 1 <= 75 &&
            candidate.curveEvidence.score >=
              (candidate.detectionScale === "micro"
                ? 0.6
                : 0.68) &&
            candidate.curveEvidence.horizontalCoverage >=
              (candidate.detectionScale === "micro"
                ? 0.4
                : 0.5) &&
            candidate.curveEvidence.continuousCoverage >=
              (candidate.detectionScale === "micro"
                ? 0.35
                : 0.38) &&
            candidate.curveEvidence.verticalVariation >=
              0.12)) &&
        candidate.right - candidate.left + 1 >= 28 &&
        candidate.bottom - candidate.top + 1 >= 22;
      const effectiveMinimumCandidateAreaRatio =
        locallyVerifiedTinyWaveform
          ? 0
          : minimumCandidateAreaRatio;
      const latticeBounds =
        axisAlignedDocumentLattice.bounds;
      const centerX =
        (candidate.left + candidate.right) / 2;
      const centerY =
        (candidate.top + candidate.bottom) / 2;
      const coveredByAxisAlignedTable =
        axisAlignedDocumentLattice.tableGridArtifact &&
        candidate.curveEvidence.guideGridWaveformRescue !==
          true &&
        (candidate.curveEvidence.colorSeriesCount ?? 0) < 2 &&
        latticeBounds &&
        ((centerX >= latticeBounds.left &&
          centerX <= latticeBounds.right &&
          centerY >= latticeBounds.top &&
          centerY <= latticeBounds.bottom) ||
          intersectionArea(candidate, latticeBounds) /
            Math.max(1, area(candidate)) >=
            0.35);
      const coveredByRotatedTable =
        rotatedDocumentTableGridArtifact &&
        candidate.curveEvidence.guideGridWaveformRescue !==
          true &&
        (candidate.curveEvidence.colorSeriesCount ?? 0) < 2 &&
        candidateCoveredByRotatedLattice(
          candidate,
          getExtendedDeskewedDocument(),
          width,
          height,
        );
      const coveredByLocalTable =
        candidate.axisMode !== "content" &&
        candidate.curveEvidence.guideGridWaveformRescue !==
          true &&
        candidate.curveEvidence
          .physicallyFramedCompactMultiTurnWaveform !== true &&
        candidate.curveEvidence
          .physicallyFramedCompactArchWaveform !== true &&
        !(
          candidate.spatialFrameRecovered === true &&
          candidate.spatialFrameSupport >= 0.85
        ) &&
        // A locally regular frame/grid is still a real plot when one
        // independently coherent coloured Curve spans it. Local office
        // tables that prompted this veto have no panel-wide series; requiring
        // two would wrongly delete ordinary single-series charts.
        (candidate.curveEvidence.colorSeriesCount ?? 0) < 1 &&
        candidateHasLocalTableLattice(
          candidate,
          workingMask,
          width,
          height,
        );
      const localOneDimensionalBounds =
        localOneDimensionalSharedLattice?.bounds;
      const coveredByLocalOneDimensionalLattice =
        Boolean(localOneDimensionalBounds) &&
        !repeatedGridRecovery &&
        candidate.curveEvidence.guideGridWaveformRescue !==
          true &&
        ((centerX >= localOneDimensionalBounds.left &&
          centerX <= localOneDimensionalBounds.right &&
          centerY >= localOneDimensionalBounds.top &&
          centerY <= localOneDimensionalBounds.bottom) ||
          intersectionArea(
            candidate,
            localOneDimensionalBounds,
          ) /
            Math.max(1, area(candidate)) >=
            0.35);
      const weakFramelessArtifact =
        candidate.detectionReason ===
          "frameless-curve-region" &&
        candidate.curveEvidence.continuousCoverage < 0.3 &&
        (!candidate.curveEvidence.segmentedWaveformTrace ||
          (candidate.curveEvidence.score < 0.78 &&
            (candidate.curveEvidence.colorSeriesCount ?? 0) <
              1));
      const weakUnframedSpatialOutline =
        candidate.detectionReason ===
          "arbitrary-waveform-region" &&
        candidate.axisMode === "content" &&
        !candidate.spatialFrameRecovered &&
        !candidate.spatialChromaticTopology?.valid &&
        !candidate.curveEvidence.segmentedWaveformTrace &&
        candidate.curveEvidence.curvedSegmentCount <= 1 &&
        candidate.curveEvidence.twoBranchCoverage >= 0.1;
      const microCandidateWidth =
        candidate.right - candidate.left + 1;
      const microCandidateHeight =
        candidate.bottom - candidate.top + 1;
      const horizontalDominantOverlap =
        dominantMultiSeriesWaveform
          ? overlapLength(
              candidate.left,
              candidate.right,
              dominantMultiSeriesWaveform.left,
              dominantMultiSeriesWaveform.right,
            )
          : 0;
      const verticalDominantGap = dominantMultiSeriesWaveform
        ? Math.max(
            0,
            dominantMultiSeriesWaveform.top -
              candidate.bottom -
              1,
            candidate.top -
              dominantMultiSeriesWaveform.bottom -
              1,
          )
        : Number.POSITIVE_INFINITY;
      const weakMicroNearDominant =
        candidate !== dominantMultiSeriesWaveform &&
        candidate.curveEvidence.microFrameSignalRescue ===
          true &&
        dominantMultiSeriesWaveform &&
        area(dominantMultiSeriesWaveform) >=
          area(candidate) * 10 &&
        horizontalDominantOverlap >=
          microCandidateWidth * 0.5 &&
        verticalDominantGap <=
          Math.max(3, microCandidateHeight * 0.2);
      const deskewedPhysicalCandidate =
        deskewedPhysicalFrameRecovery?.candidate;
      const weakMicroInsideDeskewedFrame =
        candidate !== deskewedPhysicalCandidate &&
        candidate.curveEvidence.microFrameSignalRescue ===
          true &&
        deskewedPhysicalCandidate &&
        area(deskewedPhysicalCandidate) >=
          area(candidate) * 10 &&
        intersectionArea(deskewedPhysicalCandidate, candidate) /
          Math.max(1, area(candidate)) >=
          0.35;
      const repeatedGridStructuralRescue =
        candidate.repeatedGridStructuralRescue === true &&
        candidate.curveEvidence
          .repeatedGridStructuralRescue === true;
      const acceptedByFinalFilter =
        (candidate.curveEvidence.valid ||
          repeatedGridStructuralRescue) &&
        (!candidate.curveEvidence.textGlyphArtifact ||
          repeatedGridStructuralRescue) &&
        !weakFramelessArtifact &&
        !weakUnframedSpatialOutline &&
        !weakMicroNearDominant &&
        !weakMicroInsideDeskewedFrame &&
        (repeatedGridStructuralRescue ||
          (!coveredByAxisAlignedTable &&
            !coveredByRotatedTable &&
            !coveredByLocalTable &&
            !coveredByLocalOneDimensionalLattice)) &&
        area(candidate) >=
          width * height *
            effectiveMinimumCandidateAreaRatio;
      candidate.finalFilterDiagnostics = {
        accepted: acceptedByFinalFilter,
        locallyVerifiedTinyWaveform,
        coveredByAxisAlignedTable,
        coveredByRotatedTable,
        coveredByLocalTable,
        coveredByLocalOneDimensionalLattice,
        weakFramelessArtifact,
        weakUnframedSpatialOutline,
        weakMicroNearDominant,
        weakMicroInsideDeskewedFrame,
        effectiveMinimumCandidateAreaRatio,
      };
      return acceptedByFinalFilter;
    },
  );
  if (repeatedGridRecovery) {
    const recoveredCandidates = candidates.filter(
      (candidate) =>
        candidate.repeatedGridStructuralRescue === true ||
        candidate.detectionReason ===
          "repeated-waveform-grid",
    );
    const independentCandidates = candidates.filter(
      (candidate) =>
        candidate.repeatedGridStructuralRescue !== true &&
        candidate.detectionReason !==
          "repeated-waveform-grid" &&
        !recoveredCandidates.some(
          (recovered) =>
            intersectionArea(recovered, candidate) >
            Math.min(area(recovered), area(candidate)) * 0.08,
        ) &&
        isCredibleCandidateOutsideRepeatedGrid(
          candidate,
          repeatedGridRecovery
            .requireTurningTopologyOutsideGrid === true,
          repeatedGridRecovery,
        ),
    );
    candidates = [
      ...recoveredCandidates,
      ...independentCandidates,
    ];
  } else {
    candidates =
      reconcileArbitraryWaveformCandidates(
        candidates,
        width,
        height,
        curveEvidenceMask ?? workingMask,
      );
  }
  // Merge only State fragments whose intervening region still contains Curve
  // ink. A genuinely blank gutter keeps adjacent frameless charts independent,
  // regardless of whether either chart touches the document boundary.
  candidates = mergeLocalSpatialWaveformFragments(
    candidates,
    curveEvidenceMask,
    width,
    height,
  );
  if (deskewedPhysicalFrameRecovery) {
    const physicalFrame =
      deskewedPhysicalFrameRecovery.candidate;
    const independentCandidateOutsideFrame =
      candidates.some(
        (candidate) =>
          candidate !== physicalFrame &&
          intersectionArea(candidate, physicalFrame) /
            Math.max(1, area(candidate)) <
            0.35,
      );
    if (!independentCandidateOutsideFrame) {
      // One deskewed physical frame containing every strong spatial fragment
      // is one uploaded chart, not a set of State-level panels. Preserve the
      // full source so axis/label removal and Curve normalization run once.
      candidates = [];
    }
  }
  const loneBoundaryClippedWaveform =
    candidates.length === 1 &&
    candidates[0].axisMode === "content" &&
    (candidates[0].detectionReason ===
      "grouped-waveform-region" ||
      candidates[0].detectionReason ===
        "arbitrary-waveform-region") &&
    (candidates[0].left <= 1 ||
      candidates[0].right >= width - 2 ||
      candidates[0].top <= 1 ||
      candidates[0].bottom >= height - 2) &&
    !axisAlignedDocumentLattice.tableGridArtifact &&
    measureChartCurveEvidence(
      {
        left: 0,
        top: 0,
        right: width - 1,
        bottom: height - 1,
        axisMode: "content",
      },
      curveEvidenceMask,
      width,
    ).valid;
  if (loneBoundaryClippedWaveform) {
    // When one Curve fragment is clipped by a source edge, its unseen chart
    // boundary cannot be reconstructed reliably. Preserve the complete upload
    // only after an independent whole-image waveform gate verifies it; this
    // keeps standalone corpus provenance intact without expanding an inset
    // chart pasted onto an office slide.
    candidates = [];
  }
  const framelessUsed = candidates.some(
    (candidate) =>
      candidate.detectionReason === "frameless-curve-region",
  );
  let rejectedNonChartCount =
    geometricRejectedNonChartCount +
    (framelessUsed
      ? framelessDetection.rejectedComponentCount
      : 0);
  const detectionDiagnostics = () => {
    const validMeasuredCandidates = measuredCandidates.filter(
      (candidate) => candidate.curveEvidence.valid,
    );
    const ambiguousCandidateCount =
      validMeasuredCandidates.filter(
        (candidate) =>
          !candidates.some(
            (selected) =>
              selected === candidate ||
              intersectionArea(selected, candidate) >
                Math.min(area(selected), area(candidate)) *
                  0.5,
          ),
      ).length;
    return {
      foregroundPixelCount,
      foregroundRatio:
        foregroundPixelCount / Math.max(1, width * height),
      geometricCandidateCount: measuredCandidates.length,
      preNmsValidation:
        geometricCandidates.preNmsDiagnostics ?? {
          rawCandidateCount: 0,
          uniqueCandidateCount: 0,
          boundedCandidateCount: 0,
          measurementBudget: 512,
          measurementBudgetHit: false,
        },
      validCandidateCount: candidates.length,
      rejectedCandidateCount:
        geometricRejectedNonChartCount +
        ambiguousCandidateCount,
      ambiguousCandidateCount,
      candidateSummaries: candidates
        .slice(0, MAXIMUM_CHART_PANELS)
        .map((candidate) => ({
          areaRatio:
            area(candidate) / Math.max(1, width * height),
          confidence: candidate.confidence,
          axisMode: candidate.axisMode,
          detectionReason: candidate.detectionReason,
        })),
      measuredCandidateSummaries: candidatePool
        .slice(0, 64)
        .map((candidate) => ({
          left: candidate.left,
          top: candidate.top,
          right: candidate.right,
          bottom: candidate.bottom,
          axisMode: candidate.axisMode,
          detectionReason: candidate.detectionReason,
          detectionScale: candidate.detectionScale,
          curveValid: candidate.curveEvidence.valid,
          curveScore: candidate.curveEvidence.score,
          horizontalCoverage:
            candidate.curveEvidence.horizontalCoverage,
          continuousCoverage:
            candidate.curveEvidence.continuousCoverage,
          verticalVariation:
            candidate.curveEvidence.verticalVariation,
          directionChangeCount:
            candidate.curveEvidence.directionChangeCount ?? 0,
          localizedSinglePeak:
            candidate.curveEvidence.localizedSinglePeak === true,
          segmentedWaveformTrace:
            candidate.curveEvidence.segmentedWaveformTrace === true,
          thinEnough:
            candidate.curveEvidence.thinEnough !== false,
          colorSeriesCount:
            candidate.curveEvidence.colorSeriesCount ?? 0,
          tableGridArtifact:
            candidate.curveEvidence.tableGridArtifact === true,
          textGlyphArtifact:
            candidate.curveEvidence.textGlyphArtifact === true,
          repeatedIndependentStateArray:
            candidate.curveEvidence
              .repeatedIndependentStateArray === true,
          wideSingleComponentScriptArtifact:
            candidate.curveEvidence
              .wideSingleComponentScriptArtifact === true,
          repeatedGlyphLikeComponentCount:
            candidate.curveEvidence
              .repeatedGlyphLikeComponentCount ?? 0,
          repeatedGlyphInkFraction:
            candidate.curveEvidence
              .repeatedGlyphInkFraction ?? 0,
          repeatedGlyphDominantSparseRibbonWidth:
            candidate.curveEvidence
              .repeatedGlyphDominantSparseRibbonWidth ?? 0,
          rawRepeatedGlyphLikeComponentCount:
            candidate.curveEvidence
              .rawRepeatedGlyphLikeComponentCount ?? 0,
          rawRepeatedGlyphInkFraction:
            candidate.curveEvidence
              .rawRepeatedGlyphInkFraction ?? 0,
          rawRepeatedGlyphMedianDensity:
            candidate.curveEvidence
              .rawRepeatedGlyphMedianDensity ?? 0,
          rawRepeatedGlyphMedianColumnInkRatio:
            candidate.curveEvidence
              .rawRepeatedGlyphMedianColumnInkRatio ?? 0,
          rawRepeatedGlyphMedianHeightRatio:
            candidate.curveEvidence
              .rawRepeatedGlyphMedianHeightRatio ?? 0,
          rawRepeatedGlyphMedianAspectRatio:
            candidate.curveEvidence
              .rawRepeatedGlyphMedianAspectRatio ?? 0,
          rawRepeatedGlyphDominantSparseRibbonWidth:
            candidate.curveEvidence
              .rawRepeatedGlyphDominantSparseRibbonWidth ?? 0,
          rawRepeatedGlyphSimpleArchComponentCount:
            candidate.curveEvidence
              .rawRepeatedGlyphSimpleArchComponentCount ?? 0,
          rawRepeatedGlyphSimpleArchComponentFraction:
            candidate.curveEvidence
              .rawRepeatedGlyphSimpleArchComponentFraction ?? 0,
          rawRepeatedGlyphSimpleArchInkFraction:
            candidate.curveEvidence
              .rawRepeatedGlyphSimpleArchInkFraction ?? 0,
          rawRepeatedGlyphSimpleArchHorizontalCoverage:
            candidate.curveEvidence
              .rawRepeatedGlyphSimpleArchHorizontalCoverage ??
            0,
          guideGridWaveformRescue:
            candidate.curveEvidence
              .guideGridWaveformRescue === true,
          guideGridCrossingCount:
            candidate.curveEvidence
              .guideGridCrossingCount ?? 0,
          guideGridInternalBandCount:
            candidate.curveEvidence
              .guideGridInternalBandCount ?? 0,
          guideGridResidualTextGlyphArtifact:
            candidate.curveEvidence
              .guideGridResidualTextGlyphArtifact === true,
          guideGridResidualRawGlyphLikeComponentCount:
            candidate.curveEvidence
              .guideGridResidualRawGlyphLikeComponentCount ?? 0,
          guideGridResidualRawGlyphInkFraction:
            candidate.curveEvidence
              .guideGridResidualRawGlyphInkFraction ?? 0,
          guideGridResidualRawGlyphMedianDensity:
            candidate.curveEvidence
              .guideGridResidualRawGlyphMedianDensity ?? 0,
          guideGridResidualRawGlyphMedianColumnInkRatio:
            candidate.curveEvidence
              .guideGridResidualRawGlyphMedianColumnInkRatio ?? 0,
          guideGridResidualHorizontalCoverage:
            candidate.curveEvidence
              .guideGridResidualHorizontalCoverage ?? 0,
          guideGridResidualContinuousCoverage:
            candidate.curveEvidence
              .guideGridResidualContinuousCoverage ?? 0,
          guideGridResidualVerticalVariation:
            candidate.curveEvidence
              .guideGridResidualVerticalVariation ?? 0,
          guideGridResidualDirectionChangeCount:
            candidate.curveEvidence
              .guideGridResidualDirectionChangeCount ?? 0,
          measuredPeakCount:
            candidate.curveEvidence.measuredPeakCount ?? 0,
          measuredPeakTopologyAccepted:
            candidate.curveEvidence
              .measuredPeakTopologyAccepted === true,
          tableEmbeddedWaveformGridProof:
            candidate.curveEvidence
              .tableEmbeddedWaveformGridProof === true,
          spatialFrameRecovered:
            candidate.spatialFrameRecovered === true,
          spatialFrameSupport:
            candidate.spatialFrameSupport ?? 0,
          localUpscaleApplied:
            candidate.curveEvidence.localUpscaleApplied === true,
          tinyChromaticRescue:
            candidate.curveEvidence.tinyChromaticRescue === true,
          tinyChromaticColorCount:
            candidate.curveEvidence.tinyChromaticColorCount ?? 0,
          tinyChromaticTrajectoryCount:
            candidate.curveEvidence
              .tinyChromaticTrajectoryCount ?? 0,
          microFrameSignalRescue:
            candidate.curveEvidence
              .microFrameSignalRescue === true,
          microFrameCurvePixelCount:
            candidate.curveEvidence
              .microFrameCurvePixelCount ?? 0,
          microFrameBroadResidualPixelCount:
            candidate.curveEvidence
              .microFrameBroadResidualPixelCount ?? 0,
          finalFilterDiagnostics:
            candidate.finalFilterDiagnostics ?? null,
        })),
      repeatedGridRecovery: repeatedGridRecovery
        ? {
            applied: true,
            anchorCount: repeatedGridRecovery.anchorCount,
            occupiedCellCount:
              repeatedGridRecovery.occupiedCellCount,
            waveformCellCount:
              repeatedGridRecovery.waveformCellCount ??
              repeatedGridRecovery.expectedCellCount,
            turningCellCount:
              repeatedGridRecovery.turningCellCount ??
              repeatedGridRecovery.expectedCellCount,
            measuredTopologyCellCount:
              repeatedGridRecovery
                .measuredTopologyCellCount ?? 0,
            minimumMeasuredTopologyCells:
              repeatedGridRecovery
                .minimumMeasuredTopologyCells ?? 0,
            measuredMultiPeakCellCount:
              repeatedGridRecovery
                .measuredMultiPeakCellCount ?? 0,
            minimumMeasuredMultiPeakCells:
              repeatedGridRecovery
                .minimumMeasuredMultiPeakCells ?? 0,
            plotGridCellCount:
              repeatedGridRecovery.plotGridCellCount ?? 0,
            minimumPlotGridCells:
              repeatedGridRecovery.minimumPlotGridCells ?? 0,
            measuredWaveformGridProof:
              repeatedGridRecovery
                .measuredWaveformGridProof === true,
            tableEmbeddedWaveformGridProof:
              repeatedGridRecovery
                .tableEmbeddedWaveformGridProof === true,
            tableLatticeShapeConsistent:
              repeatedGridRecovery
                .tableLatticeShapeConsistent !== false,
            tableProjectionBoundsAligned:
              repeatedGridRecovery
                .tableProjectionBoundsAligned !== false,
            medianProjectedRowCoverage:
              repeatedGridRecovery
                .medianProjectedRowCoverage ?? null,
            recoveredCellCount:
              repeatedGridRecovery.candidates.length,
            expectedCellCount:
              repeatedGridRecovery.expectedCellCount,
            rows: repeatedGridRecovery.rows,
            columns: repeatedGridRecovery.columns,
            frameWidth: repeatedGridRecovery.frameWidth,
            frameHeight: repeatedGridRecovery.frameHeight,
            columnStep: repeatedGridRecovery.columnStep,
            rowStep: repeatedGridRecovery.rowStep,
            recoveryMode:
              repeatedGridRecovery.recoveryMode ?? "strict",
            projectionMode:
              repeatedGridRecovery.projectionMode ?? null,
            requireTurningTopologyOutsideGrid:
              repeatedGridRecovery
                .requireTurningTopologyOutsideGrid === true,
          }
        : { applied: false },
      arbitraryWaveformRecovery: {
        attempted:
          arbitraryWaveformRecovery.attempted === true,
        applied:
          arbitraryWaveformRecovery.applied === true,
        recovered:
          arbitraryWaveformRecovery.candidates.length > 0,
        proposalCount:
          arbitraryWaveformRecovery.proposalCount,
        generatedProposalCount:
          arbitraryWaveformRecovery.generatedProposalCount ??
          arbitraryWaveformRecovery.proposalCount,
        boundedProposalCount:
          arbitraryWaveformRecovery.boundedProposalCount ?? 0,
        retainedPassProposalCount:
          arbitraryWaveformRecovery.retainedPassProposalCount ??
          0,
        passDroppedProposalCount:
          arbitraryWaveformRecovery.passDroppedProposalCount ??
          0,
        globalDroppedProposalCount:
          arbitraryWaveformRecovery.globalDroppedProposalCount ??
          0,
        droppedProposalCount:
          arbitraryWaveformRecovery.droppedProposalCount ?? 0,
        evaluatedCount:
          arbitraryWaveformRecovery.evaluatedCount,
        evidenceAcceptedCount:
          arbitraryWaveformRecovery.evidenceAcceptedCount ??
          0,
        deniedProposalEvaluationCount:
          arbitraryWaveformRecovery
            .deniedProposalEvaluationCount ?? 0,
        recoveredCandidateCount:
          arbitraryWaveformRecovery.candidates.length,
        selectedCandidateCount: candidates.filter(
          (candidate) =>
            candidate.detectionReason ===
            "arbitrary-waveform-region",
        ).length,
        removedStraightPixelCount:
          arbitraryWaveformRecovery.removedStraightPixelCount,
        curveMeasurementCount:
          arbitraryWaveformRecovery.curveMeasurementCount ?? 0,
        curveMeasurementBudget:
          arbitraryWaveformRecovery.curveMeasurementBudget ??
          0,
        deniedResidualMeasurementCount:
          arbitraryWaveformRecovery
            .deniedResidualMeasurementCount ?? 0,
        deniedOriginalMeasurementCount:
          arbitraryWaveformRecovery
            .deniedOriginalMeasurementCount ?? 0,
        deniedCurveMeasurementCount:
          arbitraryWaveformRecovery
            .deniedCurveMeasurementCount ?? 0,
        frameMeasurementCount:
          arbitraryWaveformRecovery.frameMeasurementCount ?? 0,
        deniedFrameMeasurementCount:
          arbitraryWaveformRecovery
            .deniedFrameMeasurementCount ?? 0,
        proposalBudgetHit:
          arbitraryWaveformRecovery.proposalBudgetHit === true,
        curveMeasurementBudgetHit:
          arbitraryWaveformRecovery
            .curveMeasurementBudgetHit === true,
        frameMeasurementBudgetHit:
          arbitraryWaveformRecovery
            .frameMeasurementBudgetHit === true,
        scales: arbitraryWaveformRecovery.scales,
        proposalPasses:
          arbitraryWaveformRecovery.proposalPasses ?? [],
      },
      tableLatticeDominant: {
        axisAligned:
          axisAlignedDocumentLattice.tableGridArtifact,
        axisAlignedHorizontalBandCount:
          axisAlignedDocumentLattice.horizontalBandCount ?? 0,
        axisAlignedVerticalBandCount:
          axisAlignedDocumentLattice.verticalBandCount ?? 0,
        axisAlignedBounds:
          axisAlignedDocumentLattice.bounds ?? null,
        sharedFrame: sharedFrameGridArtifact,
        rotated: Boolean(
          rotatedDocumentTableGridArtifact,
        ),
      },
      lowResolutionRecoveryApplied:
        recovered.repairedPixelCount > 0,
      sourceScale: Math.max(
        1,
        Number(options.sourceScale) || 1,
      ),
    };
  };
  const maximumCandidateAreaRatio = candidates.reduce(
    (maximum, candidate) =>
      Math.max(
        maximum,
        area(candidate) / Math.max(1, width * height),
      ),
    0,
  );
  const fragmentedWholeImageEvidence =
    candidates.length >= 2 &&
    candidates.length <= 4 &&
    candidates.every(
      (candidate) =>
        candidate.axisMode === "content" &&
        [
          "arbitrary-waveform-region",
          "frameless-curve-region",
        ].includes(candidate.detectionReason),
    )
      ? measureChartCurveEvidence(
          {
            left: 0,
            top: 0,
            right: width - 1,
            bottom: height - 1,
            axisMode: "content",
          },
          curveEvidenceMask,
          width,
        )
      : null;
  const boundaryClippedWholeImageWaveform =
    fragmentedWholeImageEvidence?.valid === true &&
    !fragmentedWholeImageEvidence.textGlyphArtifact &&
    !fragmentedWholeImageEvidence.tableGridArtifact &&
    !fragmentedWholeImageEvidence.closedLoopArtifact &&
    !fragmentedWholeImageEvidence.closedTwoBranchArtifact &&
    fragmentedWholeImageEvidence.fullWidthTrace &&
    fragmentedWholeImageEvidence.thinEnough &&
    fragmentedWholeImageEvidence.topBoundaryCoverage >= 0.3 &&
    fragmentedWholeImageEvidence
      .rawRepeatedGlyphComponentCount <= 2 &&
    (fragmentedWholeImageEvidence
      .highTurnFullWidthWaveform === true ||
      (fragmentedWholeImageEvidence.segmentedWaveformTrace &&
        fragmentedWholeImageEvidence.curvedSegmentCount >= 8 &&
        fragmentedWholeImageEvidence.horizontalCoverage >= 0.5 &&
        fragmentedWholeImageEvidence
          .rawRepeatedGlyphDominantSparseRibbonWidth >= 0.9));
  const independentCandidateOutsideDominant =
    dominantMultiSeriesWaveform &&
    candidates.some(
      (candidate) =>
        candidate !== dominantMultiSeriesWaveform &&
        intersectionArea(
          candidate,
          dominantMultiSeriesWaveform,
        ) /
          Math.max(1, area(candidate)) <
          0.5,
    );
  const wholeImageSeriesEvidence =
    (maximumCandidateAreaRatio < 0.22 ||
      dominantMultiSeriesWaveform) &&
    !independentCandidateOutsideDominant
      ? measureWholeImageSeriesEvidence(
          mask,
          edgeEvidenceMask ?? mask,
          curveEvidenceMask,
          options.curveColorMasks,
          width,
          height,
        )
      : null;
  if (
    (wholeImageSeriesEvidence &&
      wholeImageSeriesEvidence.seriesCount >= 2) ||
    boundaryClippedWholeImageWaveform
  ) {
    // Rotation or segmented State colours can fragment a full plot frame into
    // tiny geometric candidates. Multiple independently coherent full-width
    // series are stronger evidence for one physical chart, so retain the
    // source image and let the shared analysis core separate its traces.
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
          confidence: clamp(
            0.24 +
              Math.max(
                wholeImageSeriesEvidence?.score ?? 0,
                fragmentedWholeImageEvidence?.score ?? 0,
              ) *
                0.3,
            0.24,
            0.55,
          ),
          detectionReason: "whole-image-fallback",
          mode: "content",
          axisMode: "content",
        },
      ],
      layout: { rows: 1, columns: 1 },
      fallbackUsed: true,
      detectedPanelCount: candidates.length,
      rejectedNonChartCount,
      truncated: false,
      maxPanels: MAXIMUM_CHART_PANELS,
      diagnostics: detectionDiagnostics(),
      lowResolutionRecovery: {
        applied: recovered.repairedPixelCount > 0,
        maximumGap: recovered.maximumGap,
        repairedPixelCount: recovered.repairedPixelCount,
      },
    };
  }

  if (!candidates.length && options.fallbackToWholeImage !== false) {
    // A slightly rotated plot can hide its waveform behind a long diagonal
    // frame stroke: the greedy trace follows that straight border instead of
    // the peaks. Deskew only this rare fallback path, using the same bounded
    // projection routine as normal Curve extraction, then apply the exact
    // same waveform gate to the corrected salience mask.
    const rawWholeImageCurveEvidence = measureChartCurveEvidence(
      {
        left: 0,
        top: 0,
        right: width - 1,
        bottom: height - 1,
        axisMode: "content",
      },
      curveEvidenceMask,
      width,
    );
    let wholeImageCurveEvidence =
      rawWholeImageCurveEvidence;
    if (
      !rawWholeImageCurveEvidence.valid &&
      !rawWholeImageCurveEvidence.textGlyphArtifact
    ) {
      const fallbackMasks = deskewForegroundMasks(
        mask,
        edgeEvidenceMask ?? mask,
        width,
        height,
        curveEvidenceMask,
      );
      wholeImageCurveEvidence = measureChartCurveEvidence(
        {
          left: 0,
          top: 0,
          right: width - 1,
          bottom: height - 1,
          axisMode: "content",
        },
        fallbackMasks.curveSalientMask,
        width,
      );
    }
    const fallbackTableGridArtifact =
      axisAlignedDocumentLattice.tableGridArtifact ||
      sharedFrameGridArtifact ||
      Boolean(localOneDimensionalSharedLattice) ||
      getExtendedDeskewedDocument().tableGridArtifact;
    if (
      wholeImageCurveEvidence.valid &&
      !rawWholeImageCurveEvidence.textGlyphArtifact &&
      !fallbackTableGridArtifact
    ) {
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
        diagnostics: detectionDiagnostics(),
        lowResolutionRecovery: {
          applied: recovered.repairedPixelCount > 0,
          maximumGap: recovered.maximumGap,
          repairedPixelCount: recovered.repairedPixelCount,
        },
      };
    }
    // A fallback is safe only when the whole image itself contains a coherent,
    // curved trace. Text, tables, empty coordinates, boxes and connector
    // diagrams must not silently become a synthetic Curve and enter training
    // or retrieval.
    rejectedNonChartCount += 1;
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
    diagnostics: detectionDiagnostics(),
    lowResolutionRecovery: {
      applied: recovered.repairedPixelCount > 0,
      maximumGap: recovered.maximumGap,
      repairedPixelCount: recovered.repairedPixelCount,
    },
  };
}

function adaptivePanelDetectionScale(width, height) {
  // Preserve native topology for ordinary screenshots: enlarging an already
  // readable 600–900 px document can thicken two-pixel gutters until adjacent
  // plots merge. Multiscale enlargement is reserved for true thumbnails.
  if (width >= 480 || height >= 270) return 1;
  const requestedScale = Math.max(
    1,
    960 / Math.max(1, width),
    540 / Math.max(1, height),
  );
  const pixelSafeScale = Math.sqrt(
    2_100_000 / Math.max(1, width * height),
  );
  return Math.max(
    1,
    Math.min(16, requestedScale, pixelSafeScale),
  );
}

function upscaleInterleavedNearest(
  pixels,
  width,
  height,
  channels,
  scale,
) {
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const output = new Uint8Array(
    targetWidth * targetHeight * channels,
  );
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(
      height - 1,
      Math.floor(y / scale),
    );
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(
        width - 1,
        Math.floor(x / scale),
      );
      const sourceOffset =
        (sourceY * width + sourceX) * channels;
      const targetOffset =
        (y * targetWidth + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        output[targetOffset + channel] =
          pixels[sourceOffset + channel];
      }
    }
  }
  return {
    pixels: output,
    width: targetWidth,
    height: targetHeight,
  };
}

function panelBoundsAtSourceScale(
  panel,
  scale,
  width,
  height,
) {
  const left = Math.max(
    0,
    Math.floor(panel.left / scale),
  );
  const top = Math.max(
    0,
    Math.floor(panel.top / scale),
  );
  const right = Math.min(
    width - 1,
    Math.ceil((panel.right + 1) / scale) - 1,
  );
  const bottom = Math.min(
    height - 1,
    Math.ceil((panel.bottom + 1) / scale) - 1,
  );
  return {
    ...panel,
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

/**
 * Detect independent charts in an RGB/RGBA image.
 *
 * This is deliberately framework-agnostic: callers provide decoded pixels,
 * and receive deterministic, reading-order crop rectangles in the same pixel
 * coordinate system. A waveform-only whole-image fallback is returned for a
 * credible unframed distribution; non-distribution-only input returns no
 * panels so callers cannot accidentally train on prose, tables or diagrams.
 *
 * @param {Uint8Array | Uint8ClampedArray | Buffer} rgb
 * @param {number} width
 * @param {number} height
 * @param {3 | 4} [channels]
 * @param {{sourceScale?: number; maximumLineGap?: number; adaptiveUpscale?: boolean}} [options]
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
  const adaptiveScale =
    options.adaptiveUpscale === false
      ? 1
      : adaptivePanelDetectionScale(width, height);
  if (adaptiveScale > 1.05) {
    const sourceScaleResult = detectChartPanels(
      rgb,
      width,
      height,
      inferredChannels,
      {
        ...options,
        adaptiveUpscale: false,
        sourceScale:
          Math.max(
            1,
            Number(options.sourceScale) || 1,
          ) * adaptiveScale,
      },
    );
    const enlarged = upscaleInterleavedNearest(
      rgb,
      width,
      height,
      inferredChannels,
      adaptiveScale,
    );
    const enlargedResult = detectChartPanels(
      enlarged.pixels,
      enlarged.width,
      enlarged.height,
      inferredChannels,
      {
        ...options,
        adaptiveUpscale: false,
        sourceScale:
          Math.max(
            1,
            Number(options.sourceScale) || 1,
          ) * adaptiveScale,
      },
    );
    const mappedEnlargedResult = {
      ...enlargedResult,
      panels: enlargedResult.panels.map((panel) =>
        panelBoundsAtSourceScale(
          panel,
          adaptiveScale,
          width,
          height,
        ),
      ),
      diagnostics: {
        ...(enlargedResult.diagnostics ?? {}),
        adaptiveUpscaleApplied: true,
        adaptiveScale,
        sourceSize: [width, height],
        analysisSize: [
          enlarged.width,
          enlarged.height,
        ],
      },
    };
    const sourceIndependentPanelCount =
      sourceScaleResult.panels.filter(
        (panel) =>
          panel.detectionReason !== "whole-image-fallback",
      ).length;
    const enlargedIndependentPanelCount =
      mappedEnlargedResult.panels.filter(
        (panel) =>
          panel.detectionReason !== "whole-image-fallback",
      ).length;
    const selectedResult =
      sourceIndependentPanelCount >= 2 &&
      sourceIndependentPanelCount >
        enlargedIndependentPanelCount
        ? sourceScaleResult
        : mappedEnlargedResult;
    return {
      ...selectedResult,
      diagnostics: {
        ...(selectedResult.diagnostics ?? {}),
        adaptiveUpscaleApplied:
          selectedResult === mappedEnlargedResult,
        adaptiveScale,
        sourceSize: [width, height],
        analysisSize:
          selectedResult === mappedEnlargedResult
            ? [enlarged.width, enlarged.height]
            : [width, height],
        multiScaleSelection:
          selectedResult === mappedEnlargedResult
            ? "adaptive"
            : "source",
        sourceScalePanelCount:
          sourceScaleResult.panels.length,
        adaptiveScalePanelCount:
          mappedEnlargedResult.panels.length,
      },
    };
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
  const detected = detectChartPanelsFromMask(
    broadMask,
    width,
    height,
    {
      edgeEvidenceMask: salientMask,
      curveEvidenceMask: curveSalientMask,
      curveColorMasks,
      maximumLineGap: options.maximumLineGap,
      sourceScale: options.sourceScale,
    },
  );
  const detectorDiagnostics = detected.diagnostics ?? {};
  return {
    ...detected,
    diagnostics: {
      ...detectorDiagnostics,
      noForeground:
        detectorDiagnostics.foregroundPixelCount === 0,
      measuredCandidateCount:
        detectorDiagnostics.geometricCandidateCount ??
        detectorDiagnostics.measuredCandidateCount ??
        (detected.detectedPanelCount ?? 0) +
          (detected.rejectedNonChartCount ?? 0),
      lowResolutionRecoveryApplied:
        detectorDiagnostics.lowResolutionRecoveryApplied ??
        detected.lowResolutionRecovery?.applied ??
        false,
      repairedPixelCount:
        detectorDiagnostics.repairedPixelCount ??
        detected.lowResolutionRecovery?.repairedPixelCount ??
        0,
      adaptiveUpscaleApplied: false,
      adaptiveScale: 1,
      sourceSize: [width, height],
      analysisSize: [width, height],
    },
  };
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
