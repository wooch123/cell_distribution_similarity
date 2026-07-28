/**
 * Group nearby row or column indices into a single line center.
 *
 * @param {number[]} indices
 * @returns {number[]}
 */
export function groupCenters(indices) {
  if (!indices.length) return [];
  const groups = [[indices[0]]];
  for (const index of indices.slice(1)) {
    const current = groups[groups.length - 1];
    if (index - current[current.length - 1] <= 2) current.push(index);
    else groups.push([index]);
  }
  return groups.map((group) =>
    Math.round(group.reduce((sum, value) => sum + value, 0) / group.length),
  );
}

function medianValue(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function otsuThreshold(values) {
  const histogram = new Uint32Array(256);
  for (const value of values) histogram[value] += 1;
  let totalSum = 0;
  for (let index = 0; index < 256; index += 1) {
    totalSum += index * histogram[index];
  }
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 18;
  for (let index = 0; index < 256; index += 1) {
    backgroundWeight += histogram[index];
    if (!backgroundWeight) continue;
    const foregroundWeight = values.length - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += index * histogram[index];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (totalSum - backgroundSum) / foregroundWeight;
    const variance =
      backgroundWeight *
      foregroundWeight *
      (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = index;
    }
  }
  return threshold;
}

function rgbHue(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const range = maximum - minimum;
  if (range <= 1e-9) return 0;
  let sector;
  if (maximum === r) sector = ((g - b) / range) % 6;
  else if (maximum === g) sector = (b - r) / range + 2;
  else sector = (r - g) / range + 4;
  return (sector * 60 + 360) % 360;
}

/**
 * Convert RGB/RGBA pixels into a broad foreground mask plus strict and
 * retrieval-oriented salience alternatives. Keeping this here makes browser,
 * standalone and evaluation extraction use exactly the same threshold,
 * background and noise rules.
 *
 * @param {Uint8Array | Uint8ClampedArray | Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {{sourceScale?: number}} [options]
 */
export function buildForegroundMasks(
  pixels,
  width,
  height,
  channels,
  options = {},
) {
  if (![3, 4].includes(channels)) {
    throw new Error("RGB 또는 RGBA 픽셀만 분석할 수 있습니다.");
  }
  if (pixels.length < width * height * channels) {
    throw new Error("이미지 픽셀 버퍼가 올바르지 않습니다.");
  }
  const borderR = [];
  const borderG = [];
  const borderB = [];
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 120));
  for (let x = 0; x < width; x += stride) {
    for (const y of [0, height - 1]) {
      const offset = (y * width + x) * channels;
      borderR.push(pixels[offset]);
      borderG.push(pixels[offset + 1]);
      borderB.push(pixels[offset + 2]);
    }
  }
  for (let y = 0; y < height; y += stride) {
    for (const x of [0, width - 1]) {
      const offset = (y * width + x) * channels;
      borderR.push(pixels[offset]);
      borderG.push(pixels[offset + 1]);
      borderB.push(pixels[offset + 2]);
    }
  }
  const background = [
    medianValue(borderR),
    medianValue(borderG),
    medianValue(borderB),
  ];
  const distances = new Uint8Array(width * height);
  for (let index = 0; index < distances.length; index += 1) {
    const offset = index * channels;
    distances[index] = Math.min(
      255,
      Math.round(
        Math.sqrt(
          (pixels[offset] - background[0]) ** 2 +
            (pixels[offset + 1] - background[1]) ** 2 +
            (pixels[offset + 2] - background[2]) ** 2,
        ),
      ),
    );
  }
  const threshold = Math.max(8, otsuThreshold(distances) * 0.42);
  const broadMask = new Uint8Array(width * height);
  const salientMask = new Uint8Array(width * height);
  const curveSalientMask = new Uint8Array(width * height);
  const colorBins = Array(12).fill(null);
  const sourceScale = Math.max(
    1,
    Math.min(4, Number(options.sourceScale) || 1),
  );
  const lowResolutionRecoveryStrength =
    (sourceScale - 1) / 3;
  const strictLuminanceMinimum = Math.round(
    145 - 27 * lowResolutionRecoveryStrength,
  );
  const retrievalLuminanceMinimum = Math.round(
    120 - 20 * lowResolutionRecoveryStrength,
  );
  const strictThresholdMultiplier =
    2.4 - 0.22 * lowResolutionRecoveryStrength;
  const retrievalThresholdMultiplier =
    2.1 - 0.18 * lowResolutionRecoveryStrength;
  const backgroundLuminance =
    background[0] * 0.2126 +
    background[1] * 0.7152 +
    background[2] * 0.0722;
  for (let index = 0; index < broadMask.length; index += 1) {
    if (distances[index] < threshold) continue;
    broadMask[index] = 1;
    const offset = index * channels;
    const deltaR = pixels[offset] - background[0];
    const deltaG = pixels[offset + 1] - background[1];
    const deltaB = pixels[offset + 2] - background[2];
    const chromaticContrast =
      Math.max(deltaR, deltaG, deltaB) - Math.min(deltaR, deltaG, deltaB);
    const luminance =
      pixels[offset] * 0.2126 +
      pixels[offset + 1] * 0.7152 +
      pixels[offset + 2] * 0.0722;
    const luminanceContrast = Math.abs(
      luminance - backgroundLuminance,
    );
    const chromaticCurve = chromaticContrast >= 18;
    if (chromaticCurve) {
      // Color is used only to separate overlapping traces. It is discarded
      // before normalization and never becomes a similarity feature.
      const hue = rgbHue(
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
      );
      const binIndex = Math.round(hue / 30) % colorBins.length;
      if (!colorBins[binIndex]) {
        colorBins[binIndex] = new Uint8Array(width * height);
      }
      colorBins[binIndex][index] = 1;
    }
    if (
      // Keep the established State-count decision stable by rejecting
      // medium-gray grids and guides. When the caller enlarged a genuinely
      // low-resolution source, keep antialiased neutral Curve pixels that
      // would otherwise disappear at the fixed high-resolution threshold.
      chromaticCurve ||
      luminanceContrast >=
        Math.max(
          strictLuminanceMinimum,
          threshold * strictThresholdMultiplier,
        )
    ) {
      salientMask[index] = 1;
    }
    if (
      // Retrieval also keeps a more inclusive high-contrast Curve hypothesis
      // so a neutral-gray last State survives JPEG, rotation and dense grids.
      chromaticCurve ||
      luminanceContrast >=
        Math.max(
          retrievalLuminanceMinimum,
          threshold * retrievalThresholdMultiplier,
        )
    ) {
      curveSalientMask[index] = 1;
    }
  }
  return {
    broadMask: suppressMaskNoise(broadMask, width, height),
    salientMask: suppressMaskNoise(salientMask, width, height),
    curveSalientMask: suppressMaskNoise(
      curveSalientMask,
      width,
      height,
    ),
    curveColorMasks: colorBins
      .filter(Boolean)
      .filter(
        (mask) =>
          mask.reduce((sum, value) => sum + value, 0) >=
          Math.max(
            Math.round(
              18 - 10 * lowResolutionRecoveryStrength,
            ),
            width * height * 0.00004,
          ),
      )
      .map((mask) => suppressMaskNoise(mask, width, height)),
    background,
    threshold,
  };
}

/**
 * Remove isolated foreground islands before plot-bound detection. The
 * threshold scales with the image area, while long/thin structures are kept so
 * axes and real Curve fragments survive. This prevents salt-and-pepper noise
 * near an image edge from expanding a content-only crop.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {{
 *   minimumVerticalEdgeCoverage?: number;
 *   cornerRadius?: number;
 * }} [options]
 * @param {{minimumArea?: number}} [options]
 * @returns {Uint8Array}
 */
export function suppressMaskNoise(mask, width, height, options = {}) {
  const minimumArea =
    options.minimumArea ??
    // Preserve tiny measured marker dots after resize/JPEG conversion. Salt
    // noise is normally one or two pixels; larger repeated dots may be the
    // actual sampled Curve and must survive.
    Math.max(3, Math.floor(width * height * 0.000006));
  if (minimumArea <= 1) return mask.slice();

  const visited = new Uint8Array(mask.length);
  const cleaned = new Uint8Array(mask.length);
  const minimumLongSpan = Math.max(
    5,
    Math.floor(Math.min(width, height) * 0.022),
  );

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const component = [start];
    visited[start] = 1;
    let cursor = 0;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;

    while (cursor < component.length) {
      const index = component[cursor];
      cursor += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
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
            neighborIndex !== index &&
            mask[neighborIndex] &&
            !visited[neighborIndex]
          ) {
            visited[neighborIndex] = 1;
            component.push(neighborIndex);
          }
        }
      }
    }

    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    if (
      component.length < minimumArea &&
      componentWidth < minimumLongSpan &&
      componentHeight < minimumLongSpan
    ) {
      continue;
    }
    for (const index of component) cleaned[index] = 1;
  }

  return cleaned;
}

function strongestProjectionBand(projection, radius = 1) {
  let strongest = 0;
  let rolling = 0;
  const span = radius * 2 + 1;
  for (let index = 0; index < projection.length; index += 1) {
    rolling += projection[index];
    if (index >= span) rolling -= projection[index - span];
    if (rolling > strongest) strongest = rolling;
  }
  return strongest;
}

/**
 * Estimate the correction angle that makes the strongest plot-frame lines
 * horizontal and vertical. Projection scoring uses both orientations so a
 * Curve shoulder or a text baseline cannot win on its own.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {{maximumAngle?: number; step?: number}} [options]
 */
export function estimateDeskewAngle(mask, width, height, options = {}) {
  const maximumAngle = options.maximumAngle ?? 5;
  const step = options.step ?? 0.25;
  const activeCount = mask.reduce((sum, value) => sum + value, 0);
  if (
    activeCount < Math.max(40, Math.floor(width * height * 0.0002)) ||
    maximumAngle <= 0 ||
    step <= 0
  ) {
    return {
      angle: 0,
      applied: false,
      score: 0,
      zeroScore: 0,
      improvement: 0,
    };
  }

  const sampleEvery = Math.max(1, Math.ceil(activeCount / 120000));
  const points = [];
  let activeIndex = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    if (activeIndex % sampleEvery === 0) {
      points.push([index % width, Math.floor(index / width)]);
    }
    activeIndex += 1;
  }

  const diagonal = Math.ceil(Math.hypot(width, height)) + 8;
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const projectionCenter = (diagonal - 1) / 2;
  const evaluate = (angle) => {
    const radians = (angle * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const rows = new Uint32Array(diagonal);
    const columns = new Uint32Array(diagonal);
    for (const [x, y] of points) {
      const localX = x - centerX;
      const localY = y - centerY;
      const rotatedX =
        cosine * localX - sine * localY + projectionCenter;
      const rotatedY =
        sine * localX + cosine * localY + projectionCenter;
      const projectedX = Math.round(rotatedX);
      const projectedY = Math.round(rotatedY);
      if (
        projectedX >= 0 &&
        projectedX < diagonal &&
        projectedY >= 0 &&
        projectedY < diagonal
      ) {
        columns[projectedX] += 1;
        rows[projectedY] += 1;
      }
    }
    const rowStrength =
      (strongestProjectionBand(rows) * sampleEvery) / width;
    const columnStrength =
      (strongestProjectionBand(columns) * sampleEvery) / height;
    return rowStrength + columnStrength;
  };

  const zeroScore = evaluate(0);
  let bestAngle = 0;
  let bestScore = zeroScore;
  const steps = Math.round((maximumAngle * 2) / step);
  for (let index = 0; index <= steps; index += 1) {
    const angle = -maximumAngle + index * step;
    if (Math.abs(angle) < step / 2) continue;
    const score = evaluate(angle);
    const adjusted = score - Math.abs(angle) * 0.0005;
    const bestAdjusted =
      bestScore - Math.abs(bestAngle) * 0.0005;
    if (adjusted > bestAdjusted) {
      bestAngle = angle;
      bestScore = score;
    }
  }

  const improvement = bestScore - zeroScore;
  const frameEvidence = bestScore >= 0.62;
  const applied =
    frameEvidence &&
    Math.abs(bestAngle) >= step &&
    Math.abs(bestAngle) <= maximumAngle - step &&
    improvement >= Math.max(0.018, zeroScore * 0.018);
  return {
    angle: applied ? Number(bestAngle.toFixed(3)) : 0,
    applied,
    score: bestScore,
    zeroScore,
    improvement,
  };
}

/**
 * Rotate a binary mask around its center without resizing the canvas.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} angle
 */
export function rotateBinaryMask(mask, width, height, angle) {
  if (Math.abs(angle) < 1e-9) return mask.slice();
  const rotated = new Uint8Array(mask.length);
  const radians = (angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  for (let sourceY = 0; sourceY < height; sourceY += 1) {
    for (let sourceX = 0; sourceX < width; sourceX += 1) {
      if (!mask[sourceY * width + sourceX]) continue;
      const localX = sourceX - centerX;
      const localY = sourceY - centerY;
      const x = Math.round(
        cosine * localX - sine * localY + centerX,
      );
      const y = Math.round(
        sine * localX + cosine * localY + centerY,
      );
      if (
        x >= 0 &&
        x < width &&
        y >= 0 &&
        y < height
      ) {
        rotated[y * width + x] = 1;
      }
    }
  }
  return rotated;
}

function stabilizeRotatedMask(mask, width, height) {
  const stabilized = mask.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x > 0) stabilized[y * width + x - 1] = 1;
      if (x + 1 < width) stabilized[y * width + x + 1] = 1;
      if (y > 0) stabilized[(y - 1) * width + x] = 1;
      if (y + 1 < height) stabilized[(y + 1) * width + x] = 1;
    }
  }
  return stabilized;
}

/**
 * Deskew the broad and salient masks with one shared correction angle.
 *
 * @param {Uint8Array} broadMask
 * @param {Uint8Array} salientMask
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} [curveSalientMask]
 */
export function deskewForegroundMasks(
  broadMask,
  salientMask,
  width,
  height,
  curveSalientMask = salientMask,
) {
  const estimate = estimateDeskewAngle(broadMask, width, height);
  if (!estimate.applied) {
    return {
      boundsMask: broadMask,
      broadMask,
      salientMask,
      curveSalientMask,
      rawBroadMask: broadMask,
      rawSalientMask: salientMask,
      rawCurveSalientMask: curveSalientMask,
      ...estimate,
    };
  }
  const rotatedBroad = rotateBinaryMask(
    broadMask,
    width,
    height,
    estimate.angle,
  );
  const rotatedSalient = rotateBinaryMask(
    salientMask,
    width,
    height,
    estimate.angle,
  );
  const rotatedCurveSalient = rotateBinaryMask(
    curveSalientMask,
    width,
    height,
    estimate.angle,
  );
  return {
    boundsMask: rotatedBroad,
    rawBroadMask: rotatedBroad,
    rawSalientMask: rotatedSalient,
    rawCurveSalientMask: rotatedCurveSalient,
    broadMask: stabilizeRotatedMask(
      rotatedBroad,
      width,
      height,
    ),
    salientMask: stabilizeRotatedMask(
      rotatedSalient,
      width,
      height,
    ),
    curveSalientMask: stabilizeRotatedMask(
      rotatedCurveSalient,
      width,
      height,
    ),
    ...estimate,
  };
}

/**
 * Detect a closed plot frame or an open L-shaped patent-figure axis.
 *
 * Bounds are inclusive so the result can be consumed without copying the
 * source mask first.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @returns {{
 *   left: number;
 *   top: number;
 *   right: number;
 *   bottom: number;
 *   axesDetected: boolean;
 *   axisMode: "rectangle" | "l-axis" | "content";
 *   horizontalLineCenters: number[];
 *   verticalLineCenters: number[];
 * }}
 */
export function detectPlotBounds(mask, width, height, options = {}) {
  const minimumVerticalEdgeCoverage =
    options.minimumVerticalEdgeCoverage ?? 0.44;
  const rowCoverage = Array(height).fill(0);
  const columnCoverage = Array(width).fill(0);
  let contentLeft = width - 1;
  let contentTop = height - 1;
  let contentRight = 0;
  let contentBottom = 0;
  let activeCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      activeCount += 1;
      rowCoverage[y] += 1;
      columnCoverage[x] += 1;
      contentLeft = Math.min(contentLeft, x);
      contentTop = Math.min(contentTop, y);
      contentRight = Math.max(contentRight, x);
      contentBottom = Math.max(contentBottom, y);
    }
  }

  // Patent figures often render dotted log-grid rows with ~20 px gaps after
  // downscaling. Use the same reachability gap as the L-axis tracer, while
  // still requiring meaningful row density so text fragments cannot qualify.
  const toleratedRowGap = Math.max(3, Math.round(width * 0.028));
  const toleratedColumnGap = Math.max(3, Math.round(height * 0.018));
  const rowLineStrength = rowCoverage.map((count, y) => {
    const longestRun = longestRunWithSmallGaps(
      width,
      (x) => mask[y * width + x],
      toleratedRowGap,
    );
    return Math.max(count / width, longestRun / width);
  });
  const columnLineStrength = columnCoverage.map((count, x) => {
    const longestRun = longestRunWithSmallGaps(
      height,
      (y) => mask[y * width + x],
      toleratedColumnGap,
    );
    return Math.max(count / height, longestRun / height);
  });
  const horizontal = groupCenters(
    rowCoverage
      .map((count, index) =>
        count / width > 0.32 ||
        (count / width > 0.08 && rowLineStrength[index] > 0.32)
          ? index
          : -1,
      )
      .filter((index) => index >= 0),
  );
  const vertical = groupCenters(
    columnCoverage
      .map((count, index) =>
        count / height > 0.32 ||
        (count / height > 0.08 && columnLineStrength[index] > 0.32)
          ? index
          : -1,
      )
      .filter((index) => index >= 0),
  );

  let bestRectangle = null;
  const cornerRadius = options.cornerRadius ?? 3;
  const intersectionActive = (x, y) => {
    for (
      let localY = Math.max(0, y - cornerRadius);
      localY <= Math.min(height - 1, y + cornerRadius);
      localY += 1
    ) {
      for (
        let localX = Math.max(0, x - cornerRadius);
        localX <= Math.min(width - 1, x + cornerRadius);
        localX += 1
      ) {
        if (mask[localY * width + localX]) return true;
      }
    }
    return false;
  };
  for (let topIndex = 0; topIndex < horizontal.length - 1; topIndex += 1) {
    const top = horizontal[topIndex];
    for (
      let bottomIndex = topIndex + 1;
      bottomIndex < horizontal.length;
      bottomIndex += 1
    ) {
      const bottom = horizontal[bottomIndex];
      if (bottom - top <= height * 0.3) continue;
      for (let leftIndex = 0; leftIndex < vertical.length - 1; leftIndex += 1) {
        const left = vertical[leftIndex];
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < vertical.length;
          rightIndex += 1
        ) {
          const right = vertical[rightIndex];
          if (right - left <= width * 0.35) continue;
          const verticalEdgeCoverages = [
            columnLineStrength[left],
            columnLineStrength[right],
          ];
          const horizontalEdgeCoverages = [
            rowLineStrength[top],
            rowLineStrength[bottom],
          ];
          // A text stroke or a steep State edge can exceed the loose line
          // detector threshold, but it does not span enough of the full image
          // to be a plot-frame edge. Rejecting it here prevents a dense QLC
          // trace from becoming a smaller, false rectangle.
          if (
            Math.min(...verticalEdgeCoverages) <
              minimumVerticalEdgeCoverage ||
            Math.min(...horizontalEdgeCoverages) < 0.32
          ) {
            continue;
          }
          const cornerScore = [
            [left, top],
            [right, top],
            [left, bottom],
            [right, bottom],
          ].filter(([x, y]) => intersectionActive(x, y)).length;
          if (cornerScore < 3) continue;
          const candidate = {
            cornerScore,
            edgeCoverage:
              columnLineStrength[left] +
              columnLineStrength[right] +
              rowLineStrength[top] +
              rowLineStrength[bottom],
            area: (right - left) * (bottom - top),
            left,
            top,
            right,
            bottom,
          };
          if (
            !bestRectangle ||
            candidate.cornerScore > bestRectangle.cornerScore ||
            (candidate.cornerScore === bestRectangle.cornerScore &&
              candidate.area > bestRectangle.area) ||
            (candidate.cornerScore === bestRectangle.cornerScore &&
              candidate.area === bestRectangle.area &&
              candidate.edgeCoverage > bestRectangle.edgeCoverage)
          ) {
            bestRectangle = candidate;
          }
        }
      }
    }
  }

  if (bestRectangle) {
    return {
      left: bestRectangle.left + 2,
      top: bestRectangle.top + 2,
      right: bestRectangle.right - 2,
      bottom: bestRectangle.bottom - 2,
      axesDetected: true,
      axisMode: "rectangle",
      horizontalLineCenters: horizontal,
      verticalLineCenters: vertical,
    };
  }

  const leftAxes = vertical.filter(
    (position) => position >= width * 0.015 && position <= width * 0.48,
  );
  let bestLShape = null;

  for (const leftAxis of leftAxes) {
    let axisTop = height - 1;
    let axisBottom = 0;
    for (let y = 0; y < height; y += 1) {
      for (
        let x = Math.max(0, leftAxis - 2);
        x <= Math.min(width - 1, leftAxis + 2);
        x += 1
      ) {
        if (!mask[y * width + x]) continue;
        axisTop = Math.min(axisTop, y);
        axisBottom = Math.max(axisBottom, y);
      }
    }
    if (axisBottom - axisTop <= height * 0.28) continue;

    let axisRight = leftAxis;
    let intersectingHorizontal = false;
    for (const horizontalAxis of horizontal) {
      if (
        horizontalAxis < axisTop - 2 ||
        horizontalAxis > axisBottom + 2
      ) {
        continue;
      }
      intersectingHorizontal = true;
      const activeColumns = new Uint8Array(width);
      for (
        let y = Math.max(0, horizontalAxis - 2);
        y <= Math.min(height - 1, horizontalAxis + 2);
        y += 1
      ) {
        for (let x = Math.max(0, leftAxis - 2); x < width; x += 1) {
          if (mask[y * width + x]) activeColumns[x] = 1;
        }
      }
      const maximumGap = Math.max(10, Math.floor(width * 0.028));
      let reachableRight = leftAxis;
      let previousActive = leftAxis;
      for (let x = leftAxis; x < width; x += 1) {
        if (!activeColumns[x]) continue;
        if (x - previousActive > maximumGap) break;
        reachableRight = x;
        previousActive = x;
      }
      axisRight = Math.max(axisRight, reachableRight);
    }
    if (!intersectingHorizontal) continue;

    const plotWidth = axisRight - leftAxis;
    const plotHeight = axisBottom - axisTop;
    if (plotWidth <= width * 0.35) continue;
    const candidate = {
      area: plotWidth * plotHeight,
      left: leftAxis + 2,
      top: axisTop + 2,
      right: axisRight - 2,
      bottom: axisBottom - 2,
    };
    if (!bestLShape || candidate.area > bestLShape.area) bestLShape = candidate;
  }

  if (bestLShape) {
    return {
      left: bestLShape.left,
      top: bestLShape.top,
      right: bestLShape.right,
      bottom: bestLShape.bottom,
      axesDetected: true,
      axisMode: "l-axis",
      horizontalLineCenters: horizontal,
      verticalLineCenters: vertical,
    };
  }

  return {
    left: activeCount ? contentLeft : 0,
    top: activeCount ? contentTop : 0,
    right: activeCount ? contentRight : width - 1,
    bottom: activeCount ? contentBottom : height - 1,
    axesDetected: false,
    axisMode: "content",
    horizontalLineCenters: horizontal,
    verticalLineCenters: vertical,
  };
}

function longestRunWithSmallGaps(length, valueAt, toleratedGap = 2) {
  let best = 0;
  let runStart = -1;
  let lastActive = -1;
  let gap = 0;
  for (let position = 0; position <= length; position += 1) {
    const active = position < length && valueAt(position);
    if (active) {
      if (runStart < 0) runStart = position;
      lastActive = position;
      gap = 0;
      continue;
    }
    if (runStart < 0) continue;
    gap += 1;
    if (position < length && gap <= toleratedGap) continue;
    best = Math.max(best, lastActive - runStart + 1);
    runStart = -1;
    lastActive = -1;
    gap = 0;
  }
  return best;
}

function nearestActive(mask, width, height, x, y, dx, dy, distance, radius) {
  for (let step = 1; step <= distance; step += 1) {
    const centerX = x + dx * step;
    const centerY = y + dy * step;
    if (
      centerX < 0 ||
      centerX >= width ||
      centerY < 0 ||
      centerY >= height
    ) {
      break;
    }
    for (let offset = -radius; offset <= radius; offset += 1) {
      const sampleX = centerX + (dy ? offset : 0);
      const sampleY = centerY + (dx ? offset : 0);
      if (
        sampleX >= 0 &&
        sampleX < width &&
        sampleY >= 0 &&
        sampleY < height &&
        mask[sampleY * width + sampleX]
      ) {
        return { x: sampleX, y: sampleY, step };
      }
    }
  }
  return null;
}

/**
 * Detect solid or dashed plot-grid lines, remove their full thickness and
 * restore only pixels supported by curve continuity on both sides. Restoring
 * crossings after line suppression avoids cutting a peak, valley or tail
 * merely because it passed through a grid line.
 *
 * @param {Uint8Array} localMask
 * @param {number} width
 * @param {number} height
 * @param {{
 *   rowCoverage?: number;
 *   rowRun?: number;
 *   columnCoverage?: number;
 *   columnRun?: number;
 * }} [options]
 */
export function removeGridLinesPreservingCurves(
  localMask,
  width,
  height,
  options = {},
) {
  const rowCoverage = options.rowCoverage ?? 0.48;
  const rowRun = options.rowRun ?? 0.72;
  // Log-scale State tails can be almost vertical for well over half the plot.
  // Only suppress columns that span nearly the whole plot; shorter detached
  // reference lines are handled by the component filter below.
  const columnCoverage = options.columnCoverage ?? 0.72;
  const columnRun = options.columnRun ?? 0.82;
  const straightRows = new Uint8Array(height);
  const straightColumns = new Uint8Array(width);
  const strongRows = new Uint8Array(height);
  const strongColumns = new Uint8Array(width);
  // Screenshots and JPEG recompression can turn a regular dashed grid into
  // anti-aliased dash islands separated by 6–8 pixels. Bridge those regular
  // gaps for line detection; curve plateaus still need to span most of the
  // plot before they qualify as a removable row or column.
  const toleratedRowGap = Math.max(3, Math.round(width * 0.012));
  const toleratedColumnGap = Math.max(3, Math.round(height * 0.018));

  for (let y = 0; y < height; y += 1) {
    let active = 0;
    for (let x = 0; x < width; x += 1) {
      if (!localMask[y * width + x]) continue;
      active += 1;
    }
    const longestRun = longestRunWithSmallGaps(
      width,
      (x) => localMask[y * width + x],
      toleratedRowGap,
    );
    if (active / width > rowCoverage || longestRun / width > rowRun) {
      strongRows[y] = 1;
    }
  }

  for (let x = 0; x < width; x += 1) {
    let active = 0;
    for (let y = 0; y < height; y += 1) {
      if (!localMask[y * width + x]) continue;
      active += 1;
    }
    const longestRun = longestRunWithSmallGaps(
      height,
      (y) => localMask[y * width + x],
      toleratedColumnGap,
    );
    if (
      active / height > columnCoverage ||
      longestRun / height > columnRun
    ) {
      strongColumns[x] = 1;
    }
  }

  const expandLineThickness = (strong, target) => {
    for (let index = 0; index < strong.length; index += 1) {
      if (!strong[index]) continue;
      for (
        let neighbor = Math.max(0, index - 1);
        neighbor <= Math.min(target.length - 1, index + 1);
        neighbor += 1
      ) {
        target[neighbor] = 1;
      }
    }
  };
  // Partial guides are handled after connected-component analysis. Removing
  // every short straight run here is unsafe for log-scale VTH plots because a
  // steep State tail can occupy one vertical pixel column for a long span.
  expandLineThickness(strongRows, straightRows);
  expandLineThickness(strongColumns, straightColumns);

  const cleaned = localMask.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (straightRows[y] || straightColumns[x]) {
        cleaned[y * width + x] = 0;
      }
    }
  }

  const verticalSearch = Math.max(6, Math.round(height * 0.045));
  const horizontalSearch = Math.max(6, Math.round(width * 0.025));
  const continuityRadius = 2;
  let restoredCurvePixels = 0;

  for (let y = 0; y < height; y += 1) {
    if (!straightRows[y]) continue;
    for (let x = 0; x < width; x += 1) {
      if (!localMask[y * width + x]) continue;
      const above = nearestActive(
        cleaned,
        width,
        height,
        x,
        y,
        0,
        -1,
        verticalSearch,
        continuityRadius,
      );
      const below = nearestActive(
        cleaned,
        width,
        height,
        x,
        y,
        0,
        1,
        verticalSearch,
        continuityRadius,
      );
      if (
        !above ||
        !below ||
        Math.abs(above.x - below.x) >
          Math.max(5, Math.round((above.step + below.step) * 0.7))
      ) {
        continue;
      }
      const expectedX = Math.round(
        (above.x * below.step + below.x * above.step) /
          (above.step + below.step),
      );
      if (Math.abs(x - expectedX) > continuityRadius) continue;
      cleaned[y * width + x] = 1;
      restoredCurvePixels += 1;
    }
  }

  for (let x = 0; x < width; x += 1) {
    if (!straightColumns[x]) continue;
    for (let y = 0; y < height; y += 1) {
      if (!localMask[y * width + x] || cleaned[y * width + x]) continue;
      const left = nearestActive(
        cleaned,
        width,
        height,
        x,
        y,
        -1,
        0,
        horizontalSearch,
        continuityRadius,
      );
      const right = nearestActive(
        cleaned,
        width,
        height,
        x,
        y,
        1,
        0,
        horizontalSearch,
        continuityRadius,
      );
      if (
        !left ||
        !right ||
        Math.abs(left.y - right.y) >
          Math.max(5, Math.round((left.step + right.step) * 0.7))
      ) {
        continue;
      }
      const expectedY = Math.round(
        (left.y * right.step + right.y * left.step) /
          (left.step + right.step),
      );
      if (Math.abs(y - expectedY) > continuityRadius) continue;
      cleaned[y * width + x] = 1;
      restoredCurvePixels += 1;
    }
  }

  return {
    mask: cleaned,
    straightRows,
    straightColumns,
    removedStraightRows: straightRows.reduce(
      (sum, value) => sum + value,
      0,
    ),
    removedStraightColumns: straightColumns.reduce(
      (sum, value) => sum + value,
      0,
    ),
    restoredCurvePixels,
  };
}

function localCoefficientOfVariation(values) {
  if (values.length < 2) return 0;
  const average =
    values.reduce((sum, value) => sum + value, 0) / values.length;
  if (average <= 1e-9) return 0;
  const variance =
    values.reduce(
      (sum, value) => sum + (value - average) ** 2,
      0,
    ) / values.length;
  return Math.sqrt(variance) / average;
}

function columnRunCenters(mask, width, height, x) {
  if (x < 0 || x >= width) return [];
  const centers = [];
  let start = -1;
  for (let y = 0; y <= height; y += 1) {
    const active = y < height && mask[y * width + x];
    if (active && start < 0) {
      start = y;
      continue;
    }
    if (active || start < 0) continue;
    centers.push((start + y - 1) / 2);
    start = -1;
  }
  return centers;
}

function hasHorizontalContinuation(
  mask,
  width,
  height,
  x,
  y,
  direction,
  span,
) {
  let supportedColumns = 0;
  for (let step = 1; step <= span; step += 1) {
    const localX = x + direction * step;
    if (localX < 0 || localX >= width) break;
    const tolerance = Math.max(2, Math.ceil(step * 0.55));
    let supported = false;
    for (
      let localY = Math.max(0, Math.floor(y - tolerance));
      localY <= Math.min(height - 1, Math.ceil(y + tolerance));
      localY += 1
    ) {
      if (mask[localY * width + localX]) {
        supported = true;
        break;
      }
    }
    if (supported) supportedColumns += 1;
  }
  return supportedColumns >= Math.max(3, Math.floor(span * 0.55));
}

/**
 * Remove in-plot legends, State labels and short annotations before the Curve
 * component filter. Text is recognized as compact glyphs sharing a baseline,
 * not by OCR, so the same implementation works in the browser, Node importer
 * and fully offline package. When a label crosses a Curve, the label box is
 * cleared and horizontally continuous traces are interpolated through it.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 */
export function suppressPlotLabels(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  const minimumGlyphArea = Math.max(
    8,
    Math.floor(width * height * 0.000025),
  );
  const maximumGlyphWidth = Math.max(9, Math.floor(width * 0.055));
  const maximumGlyphHeight = Math.max(9, Math.floor(height * 0.13));

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const pixels = [start];
    visited[start] = 1;
    let cursor = 0;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    const occupiedColumns = new Set();
    const occupiedRows = new Set();
    while (cursor < pixels.length) {
      const index = pixels[cursor];
      cursor += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      occupiedColumns.add(x);
      occupiedRows.add(y);
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
          pixels.push(neighborIndex);
        }
      }
    }
    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const boxArea = componentWidth * componentHeight;
    const averageInkPerColumn =
      pixels.length / Math.max(1, occupiedColumns.size);
    const averageInkPerRow =
      pixels.length / Math.max(1, occupiedRows.size);
    const compactGlyph =
      pixels.length >= minimumGlyphArea &&
      componentWidth >= 2 &&
      componentHeight >= 3 &&
      componentWidth <= maximumGlyphWidth &&
      componentHeight <= maximumGlyphHeight &&
      occupiedColumns.size / componentWidth >= 0.45 &&
      occupiedRows.size / componentHeight >= 0.55 &&
      averageInkPerColumn >= 1.35 &&
      averageInkPerRow >= 1.25;
    const joinedTextBlob =
      pixels.length >= minimumGlyphArea * 2 &&
      componentWidth >= 6 &&
      componentHeight >= 5 &&
      componentWidth <= width * 0.28 &&
      componentHeight <= Math.max(9, height * 0.085) &&
      componentWidth >= componentHeight * 1.65 &&
      pixels.length / boxArea >= 0.08 &&
      pixels.length / boxArea <= 0.74 &&
      averageInkPerColumn >= 2.1 &&
      occupiedRows.size / componentHeight >= 0.58;
    components.push({
      pixels,
      minX,
      maxX,
      minY,
      maxY,
      width: componentWidth,
      height: componentHeight,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      compactGlyph,
      joinedTextBlob,
    });
  }

  const glyphs = components
    .filter((component) => component.compactGlyph)
    .sort(
      (left, right) =>
        left.centerY - right.centerY || left.minX - right.minX,
    );
  const glyphGroups = [];
  for (const glyph of glyphs) {
    let matchingGroup = null;
    for (const group of glyphGroups) {
      const last = group.members.at(-1);
      const baselineTolerance = Math.max(
        2,
        Math.min(glyph.height, last.height) * 0.42,
      );
      const horizontalGap = glyph.minX - last.maxX - 1;
      if (
        Math.abs(glyph.centerY - group.centerY) <=
          baselineTolerance &&
        horizontalGap >= -Math.min(glyph.width, last.width) * 0.35 &&
        horizontalGap <= Math.max(12, width * 0.025)
      ) {
        matchingGroup = group;
        break;
      }
    }
    if (!matchingGroup) {
      glyphGroups.push({
        members: [glyph],
        centerY: glyph.centerY,
      });
      continue;
    }
    matchingGroup.members.push(glyph);
    matchingGroup.centerY =
      matchingGroup.members.reduce(
        (sum, member) => sum + member.centerY,
        0,
      ) / matchingGroup.members.length;
  }

  const labelGroups = glyphGroups.filter((group) => {
    if (group.members.length < 2) return false;
    const ordered = [...group.members].sort(
      (left, right) => left.centerX - right.centerX,
    );
    const groupWidth = ordered.at(-1).maxX - ordered[0].minX + 1;
    if (groupWidth > width * 0.38) return false;
    const centerGaps = ordered
      .slice(1)
      .map(
        (member, index) =>
          member.centerX - ordered[index].centerX,
      );
    const maximumMarkerSize = Math.max(
      6,
      Math.min(width, height) * 0.045,
    );
    const regularMarkerSequence =
      ordered.length >= 4 &&
      ordered.every(
        (member) =>
          member.width <= maximumMarkerSize &&
          member.height <= maximumMarkerSize &&
          member.width / member.height >= 0.6 &&
          member.width / member.height <= 1.65,
      ) &&
      localCoefficientOfVariation(centerGaps) <= 0.18 &&
      localCoefficientOfVariation(
        ordered.map((member) => member.width * member.height),
      ) <= 0.22;
    return !regularMarkerSequence;
  });
  const glyphLabelGroupCount = labelGroups.length;
  let joinedLabelGroupCount = 0;
  for (const component of components) {
    if (!component.joinedTextBlob || component.compactGlyph) continue;
    labelGroups.push({
      members: [component],
      centerY: component.centerY,
    });
    joinedLabelGroupCount += 1;
  }
  const excessiveGlyphNoise =
    glyphs.length > 120 || glyphLabelGroupCount > 28;
  if (excessiveGlyphNoise) {
    return {
      mask: mask.slice(),
      applied: false,
      removedLabelComponents: 0,
      removedLabelPixels: 0,
      restoredCurvePixels: 0,
      candidateGlyphCount: glyphs.length,
      glyphLabelGroupCount,
      joinedLabelGroupCount,
      rejectedAsNoise: true,
    };
  }
  if (!labelGroups.length) {
    return {
      mask: mask.slice(),
      applied: false,
      removedLabelComponents: 0,
      removedLabelPixels: 0,
      restoredCurvePixels: 0,
      candidateGlyphCount: glyphs.length,
      glyphLabelGroupCount,
      joinedLabelGroupCount,
      rejectedAsNoise: false,
    };
  }

  const cleaned = mask.slice();
  let removedLabelPixels = 0;
  let restoredCurvePixels = 0;
  const removedComponentIds = new Set();
  for (const group of labelGroups) {
    const memberHeight =
      group.members.reduce(
        (sum, member) => sum + member.height,
        0,
      ) / group.members.length;
    const memberWidth =
      group.members.reduce(
        (sum, member) => sum + member.width,
        0,
      ) / group.members.length;
    const horizontalPadding =
      group.members.length >= 2
        ? Math.max(2, Math.round(Math.min(memberHeight, memberWidth * 1.4)))
        : 1;
    const left = Math.max(
      0,
      Math.min(...group.members.map((member) => member.minX)) -
        horizontalPadding,
    );
    const right = Math.min(
      width - 1,
      Math.max(...group.members.map((member) => member.maxX)) +
        horizontalPadding,
    );
    const top = Math.max(
      0,
      Math.min(...group.members.map((member) => member.minY)) - 1,
    );
    const bottom = Math.min(
      height - 1,
      Math.max(...group.members.map((member) => member.maxY)) + 1,
    );
    components.forEach((component, componentIndex) => {
      if (
        component.maxX >= left &&
        component.minX <= right &&
        component.maxY >= top &&
        component.minY <= bottom
      ) {
        removedComponentIds.add(componentIndex);
      }
    });
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const index = y * width + x;
        if (cleaned[index]) {
          cleaned[index] = 0;
          removedLabelPixels += 1;
        }
      }
    }

    const leftColumn = left - 1;
    const rightColumn = right + 1;
    if (leftColumn < 0 || rightColumn >= width) continue;
    const continuationSpan = Math.max(
      5,
      Math.min(14, Math.round(memberHeight * 0.8)),
    );
    const leftCenters = columnRunCenters(
      mask,
      width,
      height,
      leftColumn,
    ).filter((center) =>
      hasHorizontalContinuation(
        mask,
        width,
        height,
        leftColumn,
        center,
        -1,
        continuationSpan,
      ),
    );
    const rightCenters = columnRunCenters(
      mask,
      width,
      height,
      rightColumn,
    ).filter((center) =>
      hasHorizontalContinuation(
        mask,
        width,
        height,
        rightColumn,
        center,
        1,
        continuationSpan,
      ),
    );
    const availableRight = new Set(
      rightCenters.map((_, index) => index),
    );
    for (const leftCenter of leftCenters) {
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      rightCenters.forEach((rightCenter, index) => {
        if (!availableRight.has(index)) return;
        const distance = Math.abs(rightCenter - leftCenter);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      if (
        bestIndex < 0 ||
        bestDistance > Math.max(height * 0.22, memberHeight * 2.5)
      ) {
        continue;
      }
      availableRight.delete(bestIndex);
      const rightCenter = rightCenters[bestIndex];
      let previousY = Math.round(leftCenter);
      for (let x = left; x <= right; x += 1) {
        const fraction = (x - leftColumn) / (rightColumn - leftColumn);
        const y = Math.round(
          leftCenter * (1 - fraction) + rightCenter * fraction,
        );
        for (
          let localY = Math.min(previousY, y);
          localY <= Math.max(previousY, y);
          localY += 1
        ) {
          if (localY < 0 || localY >= height) continue;
          const index = localY * width + x;
          if (!cleaned[index]) {
            cleaned[index] = 1;
            restoredCurvePixels += 1;
          }
        }
        previousY = y;
      }
    }
  }

  return {
    mask: cleaned,
    applied: removedLabelPixels > 0,
    removedLabelComponents: removedComponentIds.size,
    removedLabelPixels,
    restoredCurvePixels,
    candidateGlyphCount: glyphs.length,
    glyphLabelGroupCount,
    joinedLabelGroupCount,
    rejectedAsNoise: false,
  };
}

/**
 * Keep Curve-like connected components while discarding speckles, tick marks,
 * detached annotations and short partial guide lines. Real VTH State traces
 * occupy consecutive x columns with only a few ink pixels per column; text
 * blobs are denser, while guide/tick strokes are nearly one-dimensional.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {{
 *   preserveDisconnectedTraces?: boolean;
 *   preserveAllNonGuides?: boolean;
 * }} [options]
 * @returns {{
 *   mask: Uint8Array;
 *   applied: boolean;
 *   removedComponents: number;
 *   removedGuideComponents: number;
 * }}
 */
export function filterCurveComponents(mask, width, height, options = {}) {
  const activeCount = mask.reduce((sum, value) => sum + value, 0);
  if (activeCount < 12) {
    return {
      mask: mask.slice(),
      applied: false,
      removedComponents: 0,
      removedGuideComponents: 0,
    };
  }

  const visited = new Uint8Array(mask.length);
  const filtered = new Uint8Array(mask.length);
  const minimumArea = Math.max(6, Math.floor(width * height * 0.00004));
  const minimumStateWidth = Math.max(8, Math.floor(width * 0.025));
  const maximumHorizontalGuideThickness = Math.max(
    2,
    Math.floor(height * 0.005),
  );
  const maximumVerticalGuideThickness = Math.max(
    2,
    Math.floor(width * 0.0035),
  );
  let filteredActive = 0;
  let removedComponents = 0;
  let removedGuideComponents = 0;
  const pendingDashes = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const component = [start];
    visited[start] = 1;
    let cursor = 0;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    const occupiedColumns = new Set();

    while (cursor < component.length) {
      const index = component[cursor];
      cursor += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      occupiedColumns.add(x);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

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
            neighborIndex !== index &&
            mask[neighborIndex] &&
            !visited[neighborIndex]
          ) {
            visited[neighborIndex] = 1;
            component.push(neighborIndex);
          }
        }
      }
    }

    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    const horizontalGuide =
      componentHeight <= maximumHorizontalGuideThickness &&
      componentWidth >= width * 0.12;
    const verticalGuide =
      componentWidth <= maximumVerticalGuideThickness &&
      componentHeight >= height * 0.12;
    const touchesBoundary =
      minX <= 1 || minY <= 1 || maxX + 2 >= width || maxY + 2 >= height;
    const edgeTick =
      touchesBoundary &&
      ((componentWidth >= componentHeight * 3 &&
        componentWidth <= width * 0.08) ||
        (componentHeight >= componentWidth * 3 &&
          componentHeight <= height * 0.08));
    const shortDash =
      ((componentWidth >= componentHeight * 3 &&
        componentHeight <= maximumHorizontalGuideThickness &&
        componentWidth <= width * 0.06) ||
        (componentHeight >= componentWidth * 3 &&
          componentWidth <= maximumVerticalGuideThickness &&
          componentHeight <= height * 0.06));
    if (
      horizontalGuide ||
      verticalGuide ||
      (edgeTick && !options.preserveAllNonGuides)
    ) {
      removedComponents += 1;
      if (horizontalGuide || verticalGuide) {
        removedGuideComponents += 1;
      }
      continue;
    }

    const denseEnough = component.length >= minimumArea;
    const columnContinuity = occupiedColumns.size / componentWidth;
    const averageInkPerColumn = component.length / occupiedColumns.size;
    const stateTrace =
      componentWidth >= minimumStateWidth &&
      columnContinuity >= 0.68 &&
      averageInkPerColumn <= 7.5;
    const broadTrace =
      componentWidth >= width * 0.18 &&
      columnContinuity >= 0.48;
    const tailLike =
      componentHeight >= height * 0.14 &&
      maxY + 1 >= height * 0.58 &&
      componentWidth >= minimumStateWidth;
    const keepIfNotGuide =
      options.preserveAllNonGuides ||
      (denseEnough &&
        (options.preserveDisconnectedTraces ||
          stateTrace ||
          broadTrace ||
          tailLike));
    if (shortDash) {
      pendingDashes.push({
        component,
        orientation:
          componentWidth >= componentHeight * 3
            ? "horizontal"
            : "vertical",
        center:
          componentWidth >= componentHeight * 3
            ? (minY + maxY) / 2
            : (minX + maxX) / 2,
        start:
          componentWidth >= componentHeight * 3 ? minX : minY,
        end:
          componentWidth >= componentHeight * 3 ? maxX : maxY,
        keepIfNotGuide,
      });
      continue;
    }
    if (
      !options.preserveAllNonGuides &&
      (!denseEnough ||
        (!options.preserveDisconnectedTraces &&
          !stateTrace &&
          !broadTrace &&
          !tailLike))
    ) {
      removedComponents += 1;
      continue;
    }

    for (const index of component) filtered[index] = 1;
    filteredActive += component.length;
  }

  for (const dash of pendingDashes) {
    const dimension =
      dash.orientation === "horizontal" ? width : height;
    const aligned = pendingDashes.filter(
      (candidate) =>
        candidate.orientation === dash.orientation &&
        Math.abs(candidate.center - dash.center) <= 1.5,
    );
    const alignedInk = aligned.reduce(
      (sum, candidate) => sum + candidate.end - candidate.start + 1,
      0,
    );
    const alignedStart = Math.min(
      ...aligned.map((candidate) => candidate.start),
    );
    const alignedEnd = Math.max(
      ...aligned.map((candidate) => candidate.end),
    );
    const repeatedDashedGuide =
      aligned.length >= 3 &&
      alignedInk / dimension >= 0.22 &&
      (alignedEnd - alignedStart + 1) / dimension >= 0.35;
    if (repeatedDashedGuide || !dash.keepIfNotGuide) {
      removedComponents += 1;
      if (repeatedDashedGuide) removedGuideComponents += 1;
      continue;
    }
    for (const index of dash.component) filtered[index] = 1;
    filteredActive += dash.component.length;
  }

  return {
    mask: filteredActive >= 12 ? filtered : mask.slice(),
    applied: filteredActive >= 12,
    removedComponents,
    removedGuideComponents,
  };
}

/**
 * Remove plot spines, grid/reference lines and detached text-like components.
 *
 * @param {Uint8Array} sourceMask
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {{
 *   left: number;
 *   top: number;
 *   right: number;
 *   bottom: number;
 *   axesDetected: boolean;
 *   axisMode?: "rectangle" | "l-axis" | "content";
 * }} bounds
 */
export function buildCurveMask(
  sourceMask,
  sourceWidth,
  sourceHeight,
  bounds,
) {
  const left = Math.max(0, Math.min(sourceWidth - 1, bounds.left));
  const top = Math.max(0, Math.min(sourceHeight - 1, bounds.top));
  const right = Math.max(left, Math.min(sourceWidth - 1, bounds.right));
  const bottom = Math.max(top, Math.min(sourceHeight - 1, bounds.bottom));
  const width = Math.max(2, right - left + 1);
  const height = Math.max(2, bottom - top + 1);
  const local = new Uint8Array(width * height);
  for (let localY = 0; localY < height; localY += 1) {
    for (let localX = 0; localX < width; localX += 1) {
      local[localY * width + localX] =
        sourceMask[(top + localY) * sourceWidth + left + localX] ? 1 : 0;
    }
  }
  const gridCleaned = removeGridLinesPreservingCurves(local, width, height);
  const labelCleaned = suppressPlotLabels(
    gridCleaned.mask,
    width,
    height,
  );
  const lineCleaned = labelCleaned.mask;
  const activeCount = lineCleaned.reduce((sum, value) => sum + value, 0);

  const density = activeCount / (width * height);
  // Apply component validation to rectangular and content-only plots too.
  // Disconnected 8/16-State curves are protected by minimum width and
  // x-continuity, while salt noise, tick marks and short guide segments are
  // removed. Very dense masks are left intact for the edge hypothesis.
  const shouldFilterComponents = density <= 0.18;
  if (!shouldFilterComponents || activeCount < 12) {
    return {
      mask: lineCleaned,
      width,
      height,
      density,
      componentFilterApplied: false,
      removedStraightRows: gridCleaned.removedStraightRows,
      removedStraightColumns: gridCleaned.removedStraightColumns,
      restoredCurvePixels: gridCleaned.restoredCurvePixels,
      removedComponents: 0,
      removedGuideComponents: 0,
      labelFilterApplied: labelCleaned.applied,
      removedLabelComponents: labelCleaned.removedLabelComponents,
      removedLabelPixels: labelCleaned.removedLabelPixels,
      restoredLabelCrossingPixels: labelCleaned.restoredCurvePixels,
    };
  }

  const componentCleaned = filterCurveComponents(
    lineCleaned,
    width,
    height,
    {
      // A framed multi-State plot has already excluded surrounding labels.
      // Keep measured marker points and disconnected traces even when
      // compression breaks their continuity; the pre-boundary noise pass has
      // already removed tiny islands, so only exact guides and edge ticks are
      // discarded here.
      preserveDisconnectedTraces: bounds.axisMode === "rectangle",
      preserveAllNonGuides: bounds.axisMode === "rectangle",
    },
  );

  return {
    mask: componentCleaned.mask,
    width,
    height,
    density,
    componentFilterApplied: componentCleaned.applied,
    removedStraightRows: gridCleaned.removedStraightRows,
    removedStraightColumns: gridCleaned.removedStraightColumns,
    restoredCurvePixels: gridCleaned.restoredCurvePixels,
    removedComponents: componentCleaned.removedComponents,
    removedGuideComponents: componentCleaned.removedGuideComponents,
    labelFilterApplied: labelCleaned.applied,
    removedLabelComponents: labelCleaned.removedLabelComponents,
    removedLabelPixels: labelCleaned.removedLabelPixels,
    restoredLabelCrossingPixels: labelCleaned.restoredCurvePixels,
  };
}

/**
 * Crop a curve mask to its active ink bounds. This is the low-State
 * coordinate view; broad 2/4-State shapes benefit from removing unused plot
 * margins, while dense 8/16-State shapes retain the full rectangle elsewhere.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 */
export function cropCurveMaskToContent(mask, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return { mask, width, height };

  const croppedWidth = Math.max(2, right - left + 1);
  const croppedHeight = Math.max(2, bottom - top + 1);
  const cropped = new Uint8Array(croppedWidth * croppedHeight);
  for (let y = 0; y < croppedHeight; y += 1) {
    for (let x = 0; x < croppedWidth; x += 1) {
      cropped[y * croppedWidth + x] =
        mask[(top + y) * width + left + x];
    }
  }
  return {
    mask: cropped,
    width: croppedWidth,
    height: croppedHeight,
  };
}

/**
 * Build a second Curve hypothesis from the foreground boundary. Long straight
 * runs are removed aggressively so pale fills and grid-heavy screenshots do
 * not bridge physical valleys.
 *
 * @param {Uint8Array} sourceMask
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {{left: number; top: number; right: number; bottom: number}} bounds
 */
export function buildAggressiveEdgeCurveMask(
  sourceMask,
  sourceWidth,
  sourceHeight,
  bounds,
) {
  const left = Math.max(0, Math.min(sourceWidth - 1, bounds.left));
  const top = Math.max(0, Math.min(sourceHeight - 1, bounds.top));
  const right = Math.max(left, Math.min(sourceWidth - 1, bounds.right));
  const bottom = Math.max(top, Math.min(sourceHeight - 1, bounds.bottom));
  const width = Math.max(2, right - left + 1);
  const height = Math.max(2, bottom - top + 1);
  const local = new Uint8Array(width * height);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const sourceX = left + x;
      const sourceY = top + y;
      if (!sourceMask[sourceY * sourceWidth + sourceX]) continue;
      const touchesBackground =
        !sourceMask[sourceY * sourceWidth + sourceX - 1] ||
        !sourceMask[sourceY * sourceWidth + sourceX + 1] ||
        !sourceMask[(sourceY - 1) * sourceWidth + sourceX] ||
        !sourceMask[(sourceY + 1) * sourceWidth + sourceX];
      if (touchesBackground) local[y * width + x] = 1;
    }
  }

  const gridCleaned = removeGridLinesPreservingCurves(local, width, height, {
    rowCoverage: 0.48,
    rowRun: 0.72,
    columnCoverage: 0.72,
    columnRun: 0.82,
  });
  const cleaned = gridCleaned.mask;
  const activePixels = cleaned.reduce((sum, value) => sum + value, 0);
  return {
    mask: activePixels >= 12 ? cleaned : local,
    width,
    height,
    activePixels,
    removedStraightRows: gridCleaned.removedStraightRows,
    removedStraightColumns: gridCleaned.removedStraightColumns,
    restoredCurvePixels: gridCleaned.restoredCurvePixels,
  };
}
