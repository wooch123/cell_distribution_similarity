import { buildForegroundMasks } from "./vth-image-core.mjs";

// A 4 × 4 PPT grid leaves roughly 2.5–4% of the slide for each plot once
// titles and gutters are excluded. Keep enough headroom for 5 × 4 layouts and
// low-resolution screenshots without admitting ordinary label boxes.
const DEFAULT_MINIMUM_PANEL_AREA_RATIO = 0.008;
const DEFAULT_MINIMUM_PANEL_WIDTH_RATIO = 0.065;
const DEFAULT_MINIMUM_PANEL_HEIGHT_RATIO = 0.07;
const MINIMUM_OPEN_AXIS_PANEL_AREA_RATIO = 0.018;
export const MAXIMUM_CHART_PANELS = 24;

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

function extractLineBands(
  mask,
  width,
  height,
  orientation,
  minimumSpan,
) {
  const horizontal = orientation === "horizontal";
  const primaryLength = horizontal ? height : width;
  const secondaryLength = horizontal ? width : height;
  const safeMinimumSpan = Math.max(18, Math.round(minimumSpan));
  const maximumGap = Math.max(
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
      const bottomLine = horizontalLines[bottomIndex];
      const top = topLine.coordinate;
      const bottom = bottomLine.coordinate;
      if (bottom - top + 1 < minimumHeight) continue;
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
          const rightLine = verticalLines[rightIndex];
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

function removeDuplicateAndGridCandidates(
  candidates,
  edgeEvidenceMask,
  width,
  height,
) {
  const withEdgeEvidence = candidates.map((candidate) => ({
    ...candidate,
    edgeEvidence: candidateEdgeEvidence(
      candidate,
      edgeEvidenceMask,
      width,
      height,
    ),
  }));
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
    (left, right) =>
      area(right) - area(left) ||
      (right.axisMode === "rectangle") -
        (left.axisMode === "rectangle") ||
      right.confidence - left.confidence ||
      left.top - right.top ||
      left.left - right.left,
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
 *   fallbackToWholeImage?: boolean;
 *   edgeEvidenceMask?: Uint8Array;
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
  const minimumWidth = Math.max(
    26,
    Math.round(
      width *
        (options.minimumPanelWidthRatio ??
          DEFAULT_MINIMUM_PANEL_WIDTH_RATIO),
    ),
  );
  const minimumHeight = Math.max(
    22,
    Math.round(
      height *
        (options.minimumPanelHeightRatio ??
          DEFAULT_MINIMUM_PANEL_HEIGHT_RATIO),
    ),
  );
  const horizontalLines = extractLineBands(
    mask,
    width,
    height,
    "horizontal",
    minimumWidth,
  );
  const verticalLines = extractLineBands(
    mask,
    width,
    height,
    "vertical",
    minimumHeight,
  );
  const rectangleCandidates = detectRectangleCandidates(
    mask,
    width,
    height,
    horizontalLines,
    verticalLines,
    minimumWidth,
    minimumHeight,
  );
  const lAxisCandidates = detectLAxisCandidates(
    mask,
    width,
    height,
    horizontalLines,
    verticalLines,
    minimumWidth,
    minimumHeight,
  );
  const candidates = removeDuplicateAndGridCandidates(
    [...rectangleCandidates, ...lAxisCandidates],
    options.edgeEvidenceMask,
    width,
    height,
  ).filter(
    (candidate) =>
      area(candidate) >=
      width *
        height *
        (candidate.axisMode === "l-axis"
          ? Math.max(
              minimumAreaRatio,
              MINIMUM_OPEN_AXIS_PANEL_AREA_RATIO,
            )
          : minimumAreaRatio),
  );

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
      truncated: false,
      maxPanels: MAXIMUM_CHART_PANELS,
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
    truncated: candidates.length > selected.length,
    maxPanels: MAXIMUM_CHART_PANELS,
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
 *   truncated: boolean;
 *   maxPanels: number;
 * }}
 */
export function detectChartPanels(rgb, width, height, channels = 4) {
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
  const { broadMask, salientMask } = buildForegroundMasks(
    rgb,
    width,
    height,
    inferredChannels,
  );
  return detectChartPanelsFromMask(broadMask, width, height, {
    edgeEvidenceMask: salientMask,
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
