import { encode as encodePng } from "fast-png";

const LABEL_GLYPHS = Object.freeze({
  A: Object.freeze([
    "01110",
    "10001",
    "10001",
    "11111",
    "10001",
    "10001",
    "10001",
  ]),
  E: Object.freeze([
    "11111",
    "10000",
    "10000",
    "11110",
    "10000",
    "10000",
    "11111",
  ]),
  S: Object.freeze([
    "01111",
    "10000",
    "10000",
    "01110",
    "00001",
    "00001",
    "11110",
  ]),
  T: Object.freeze([
    "11111",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
  ]),
});

const LABEL_WIDTH = 697;
const LABEL_HEIGHT = 347;
const LABEL_BOUNDS = Object.freeze({
  left: 0,
  top: 0,
  right: LABEL_WIDTH - 1,
  bottom: LABEL_HEIGHT - 1,
  axesDetected: true,
  axisMode: "rectangle",
});
const LABEL_PLACEMENTS = Object.freeze({
  above: Object.freeze({ centerX: 349, centerY: 30 }),
  below: Object.freeze({ centerX: 349, centerY: 322 }),
  valley: Object.freeze({ centerX: 356, centerY: 221 }),
  tail: Object.freeze({ centerX: 79, centerY: 183 }),
});

function setMaskPixel(mask, width, height, x, y) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  mask[y * width + x] = 1;
}

function paintMask(mask, width, height, x, y, radius = 1) {
  for (let localY = y - radius; localY <= y + radius; localY += 1) {
    for (let localX = x - radius; localX <= x + radius; localX += 1) {
      setMaskPixel(mask, width, height, localX, localY);
    }
  }
}

function drawMaskLine(
  mask,
  width,
  height,
  startX,
  startY,
  endX,
  endY,
  radius = 1,
) {
  const steps = Math.max(
    1,
    Math.abs(endX - startX),
    Math.abs(endY - startY),
  );
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    paintMask(
      mask,
      width,
      height,
      Math.round(startX + (endX - startX) * progress),
      Math.round(startY + (endY - startY) * progress),
      radius,
    );
  }
}

function fourStateCurveMask(radius = 1, options = {}) {
  const mask = new Uint8Array(LABEL_WIDTH * LABEL_HEIGHT);
  const centers =
    options.centers ?? [0.13, 0.37, 0.64, 0.87];
  const widths =
    options.widths ?? [0.052, 0.064, 0.048, 0.059];
  const amplitudes =
    options.amplitudes ?? [0.86, 0.72, 1, 0.8];
  let previousY = null;
  for (let x = 8; x < LABEL_WIDTH - 8; x += 1) {
    const progress = (x - 8) / (LABEL_WIDTH - 17);
    const density = Math.max(
      ...centers.map(
        (center, index) =>
          amplitudes[index] *
          Math.exp(
            -(((progress - center) / widths[index]) ** 2),
          ),
      ),
    );
    const y = Math.round(273 - density * 186);
    if (previousY === null) {
      paintMask(mask, LABEL_WIDTH, LABEL_HEIGHT, x, y, radius);
    } else {
      drawMaskLine(
        mask,
        LABEL_WIDTH,
        LABEL_HEIGHT,
        x - 1,
        previousY,
        x,
        y,
        radius,
      );
    }
    previousY = y;
  }
  return mask;
}

function repeatedStateCurveMask(stateCount) {
  const mask = new Uint8Array(LABEL_WIDTH * LABEL_HEIGHT);
  const margin =
    stateCount <= 4
      ? 0.08
        : stateCount >= 12
          ? 0.045
          : 0.08;
  const centers =
    stateCount === 1
      ? [0.5]
      : Array.from(
          { length: stateCount },
          (_value, index) =>
            margin +
            ((1 - margin * 2) * index) /
              (stateCount - 1),
        );
  const peakWidth = Math.max(
    0.012,
    Math.min(
      stateCount === 1 ? 0.07 : 0.075,
      0.235 / Math.max(1, stateCount),
    ),
  );
  let previousY = null;
  for (let x = 8; x < LABEL_WIDTH - 8; x += 1) {
    const progress = (x - 8) / (LABEL_WIDTH - 17);
    const density = Math.max(
      ...centers.map((center) => {
        const amplitude = 0.93;
        return (
          amplitude *
          Math.exp(
            -0.5 *
              ((progress - center) / peakWidth) ** 2,
          )
        );
      }),
    );
    const y = Math.round(276 - density * 190);
    if (previousY === null) {
      paintMask(mask, LABEL_WIDTH, LABEL_HEIGHT, x, y);
    } else {
      drawMaskLine(
        mask,
        LABEL_WIDTH,
        LABEL_HEIGHT,
        x - 1,
        previousY,
        x,
        y,
      );
    }
    previousY = y;
  }
  return mask;
}

function labelInk(scale) {
  const text = "STATE";
  const characterAdvance = 7 * scale;
  const width = (text.length - 1) * characterAdvance + 5 * scale;
  const height = 7 * scale;
  const pixels = [];
  const mask = new Uint8Array(width * height);
  let cursorX = 0;
  for (const character of text) {
    const glyph = LABEL_GLYPHS[character];
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((value, columnIndex) => {
        if (value !== "1") return;
        for (let localY = 0; localY < scale; localY += 1) {
          for (let localX = 0; localX < scale; localX += 1) {
            const x = cursorX + columnIndex * scale + localX;
            const y = rowIndex * scale + localY;
            pixels.push({ x, y });
            mask[y * width + x] = 1;
          }
        }
      });
    });
    cursorX += characterAdvance;
  }
  return { width, height, pixels, mask };
}

function drawRotatedLabel(
  mask,
  { centerX, centerY, scale, rotation },
) {
  const ink = labelInk(scale);
  const radians = (rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const sourceCenterX = (ink.width - 1) / 2;
  const sourceCenterY = (ink.height - 1) / 2;
  const radius = Math.ceil(
    Math.hypot(ink.width, ink.height) / 2,
  );
  for (
    let targetY = Math.floor(centerY - radius);
    targetY <= Math.ceil(centerY + radius);
    targetY += 1
  ) {
    for (
      let targetX = Math.floor(centerX - radius);
      targetX <= Math.ceil(centerX + radius);
      targetX += 1
    ) {
      const relativeX = targetX - centerX;
      const relativeY = targetY - centerY;
      const sourceX = Math.round(
        sourceCenterX +
          relativeX * cosine +
          relativeY * sine,
      );
      const sourceY = Math.round(
        sourceCenterY -
          relativeX * sine +
          relativeY * cosine,
      );
      if (
        sourceX >= 0 &&
        sourceX < ink.width &&
        sourceY >= 0 &&
        sourceY < ink.height &&
        ink.mask[sourceY * ink.width + sourceX]
      ) {
        setMaskPixel(
          mask,
          LABEL_WIDTH,
          LABEL_HEIGHT,
          targetX,
          targetY,
        );
      }
    }
  }
}

function labelArtifactMaskFixture({
  placement,
  scale,
  rotation,
}) {
  const mask = fourStateCurveMask();
  drawRotatedLabel(mask, {
    ...LABEL_PLACEMENTS[placement],
    scale,
    rotation,
  });
  return Object.freeze({
    name: `label-${placement}-s${scale}-r${rotation}`,
    width: LABEL_WIDTH,
    height: LABEL_HEIGHT,
    mask,
    bounds: LABEL_BOUNDS,
    expected: Object.freeze({
      distributionCount: 1,
      seriesCount: 1,
      peakCount: 4,
      valleyCount: 3,
    }),
    parameters: Object.freeze({ placement, scale, rotation }),
  });
}

export function labelArtifactMaskFixtures() {
  return Object.freeze(
    Object.keys(LABEL_PLACEMENTS).flatMap((placement) =>
      [2, 3, 4].flatMap((scale) =>
        [-8, 0, 8].map((rotation) =>
          labelArtifactMaskFixture({
            placement,
            scale,
            rotation,
          }),
        ),
      ),
    ),
  );
}

/**
 * Labels close to a crop boundary exercise the shortened continuation scan in
 * suppressPlotLabels. The label's padded removal box starts (or ends) only
 * four, six, or nine pixels from the image edge while the label overlaps the
 * low-density tail of the physical four-State Curve.
 */
export function createEdgeOverlappingLabelMaskFixture({
  edge,
  edgeDistance,
  centerY = 273,
  scale = 1,
  rotation = -8,
}) {
  const ink = labelInk(scale);
  const horizontalPadding = Math.round(
    Math.min(ink.height, 5 * scale * 1.4),
  );
  const cleanMask = fourStateCurveMask(0, {
    centers: [0.22, 0.41, 0.61, 0.79],
    widths: [0.04, 0.046, 0.042, 0.044],
    amplitudes: [0.86, 0.72, 1, 0.8],
  });
  // Extend the low-density tails to the tight crop boundary. This guarantees
  // that a label whose removal box starts only 4–9 px from the edge still has
  // a real, but necessarily shortened, continuation segment on that side.
  drawMaskLine(
    cleanMask,
    LABEL_WIDTH,
    LABEL_HEIGHT,
    0,
    273,
    8,
    273,
    0,
  );
  drawMaskLine(
    cleanMask,
    LABEL_WIDTH,
    LABEL_HEIGHT,
    LABEL_WIDTH - 9,
    273,
    LABEL_WIDTH - 1,
    273,
    0,
  );
  const labelMask = new Uint8Array(
    LABEL_WIDTH * LABEL_HEIGHT,
  );
  const inkLeft =
    edge === "left"
      ? edgeDistance + horizontalPadding
      : LABEL_WIDTH -
        edgeDistance -
        horizontalPadding -
        ink.width;
  const centerX = inkLeft + (ink.width - 1) / 2;
  drawRotatedLabel(labelMask, {
    centerX,
    centerY,
    scale,
    rotation,
  });
  let labelLeft = LABEL_WIDTH;
  let labelRight = -1;
  for (let index = 0; index < labelMask.length; index += 1) {
    if (!labelMask[index]) continue;
    const x = index % LABEL_WIDTH;
    labelLeft = Math.min(labelLeft, x);
    labelRight = Math.max(labelRight, x);
  }
  const mask = cleanMask.slice();
  let overlapPixelCount = 0;
  // Model an opaque label background: the Curve is absent under the complete
  // text box and resumes on both sides. The cleanup must therefore remove the
  // glyphs and interpolate the physical trace across that occluded interval.
  const inkTop = Math.round(centerY - (ink.height - 1) / 2);
  for (let y = inkTop; y < inkTop + ink.height; y += 1) {
    for (
      let x = inkLeft - 1;
      x <= inkLeft + ink.width;
      x += 1
    ) {
      const index = y * LABEL_WIDTH + x;
      if (cleanMask[index]) overlapPixelCount += 1;
      mask[index] = 0;
    }
  }
  for (let index = 0; index < mask.length; index += 1) {
    if (!labelMask[index]) continue;
    mask[index] = 1;
  }
  return Object.freeze({
    name:
      `label-edge-${edge}-d${edgeDistance}-` +
      `y${centerY}-s${scale}-r${rotation}`,
    width: LABEL_WIDTH,
    height: LABEL_HEIGHT,
    cleanMask,
    labelMask,
    mask,
    bounds: LABEL_BOUNDS,
    expected: Object.freeze({
      distributionCount: 1,
      seriesCount: 1,
      peakCount: 4,
      valleyCount: 3,
    }),
    parameters: Object.freeze({
      edge,
      edgeDistance,
      centerY,
      scale,
      rotation,
      horizontalPadding,
      overlapPixelCount,
      labelBounds: Object.freeze({
        left: labelLeft,
        right: labelRight,
      }),
    }),
  });
}

export function edgeOverlappingLabelMaskFixtures() {
  return Object.freeze(
    ["left", "right"].flatMap((edge) =>
      [4, 6, 9].map((edgeDistance) =>
        createEdgeOverlappingLabelMaskFixture({
          edge,
          edgeDistance,
          scale: 1,
          rotation: -8,
        }),
      ),
    ),
  );
}

export function labeledStateCountMaskFixtures() {
  return Object.freeze(
    [1, 2, 4, 6, 8, 16].flatMap((stateCount) =>
      ["above", "valley"].flatMap((placement) =>
        [-8, 8].map((rotation) => {
          const cleanMask =
            repeatedStateCurveMask(stateCount);
          const mask = cleanMask.slice();
          drawRotatedLabel(mask, {
            ...LABEL_PLACEMENTS[placement],
            scale: 3,
            rotation,
          });
          return Object.freeze({
            name:
              `label-state-${stateCount}-${placement}-` +
              `s3-r${rotation}`,
            width: LABEL_WIDTH,
            height: LABEL_HEIGHT,
            cleanMask,
            mask,
            bounds: LABEL_BOUNDS,
            expected: Object.freeze({
              distributionCount: 1,
              seriesCount: 1,
              peakCount: stateCount,
              valleyCount: Math.max(0, stateCount - 1),
            }),
            parameters: Object.freeze({
              stateCount,
              placement,
              scale: 3,
              rotation,
            }),
          });
        }),
      ),
    ),
  );
}

/**
 * A physically valid, deliberately non-uniform six-State distribution. The
 * two outer States are lower and closer to their neighbours than the four
 * interior States, but they remain independently visible peaks. This is the
 * exact shape that must not be confused with low-resolution plot-frame
 * shoulders merely because a detached label is also present.
 */
export function labeledNonuniformSixStateBoundaryFixture() {
  const curveMask = new Uint8Array(
    LABEL_WIDTH * LABEL_HEIGHT,
  );
  const broadMask = new Uint8Array(
    LABEL_WIDTH * LABEL_HEIGHT,
  );
  const salientMask = new Uint8Array(
    LABEL_WIDTH * LABEL_HEIGHT,
  );
  const centers = [0.094, 0.125, 0.35, 0.575, 0.785, 0.906];
  const widths = [0.023, 0.023, 0.027, 0.027, 0.027, 0.023];
  const amplitudes = [0.7, 1, 0.93, 0.98, 0.95, 0.7];
  let previousY = null;
  for (let x = 10; x < LABEL_WIDTH - 10; x += 1) {
    const progress = (x - 10) / (LABEL_WIDTH - 21);
    const density = Math.max(
      ...centers.map(
        (center, index) =>
          amplitudes[index] *
          Math.exp(
            -0.5 *
              ((progress - center) / widths[index]) ** 2,
          ),
      ),
    );
    const y = Math.round(280 - density * 190);
    if (previousY === null) {
      paintMask(
        curveMask,
        LABEL_WIDTH,
        LABEL_HEIGHT,
        x,
        y,
      );
    } else {
      drawMaskLine(
        curveMask,
        LABEL_WIDTH,
        LABEL_HEIGHT,
        x - 1,
        previousY,
        x,
        y,
      );
    }
    previousY = y;
  }
  drawRotatedLabel(curveMask, {
    ...LABEL_PLACEMENTS.above,
    scale: 3,
    rotation: 0,
  });
  broadMask.set(curveMask);
  salientMask.set(curveMask);
  for (const targetMask of [broadMask, salientMask]) {
    for (const [startX, startY, endX, endY] of [
      [4, 4, LABEL_WIDTH - 5, 4],
      [
        4,
        LABEL_HEIGHT - 5,
        LABEL_WIDTH - 5,
        LABEL_HEIGHT - 5,
      ],
      [4, 4, 4, LABEL_HEIGHT - 5],
      [
        LABEL_WIDTH - 5,
        4,
        LABEL_WIDTH - 5,
        LABEL_HEIGHT - 5,
      ],
    ]) {
      drawMaskLine(
        targetMask,
        LABEL_WIDTH,
        LABEL_HEIGHT,
        startX,
        startY,
        endX,
        endY,
      );
    }
  }
  return Object.freeze({
    name: "label-nonuniform-six-state-boundary-peaks",
    width: LABEL_WIDTH,
    height: LABEL_HEIGHT,
    broadMask,
    salientMask,
    curveMask,
    expected: Object.freeze({
      peakCount: 6,
      valleyCount: 5,
    }),
    parameters: Object.freeze({
      centers: Object.freeze(centers),
      widths: Object.freeze(widths),
      amplitudes: Object.freeze(amplitudes),
      labelPlacement: "above",
      labelScale: 3,
    }),
  });
}

export function cleanFourStateMaskFixture() {
  return Object.freeze({
    name: "clean-four-state-reference",
    width: LABEL_WIDTH,
    height: LABEL_HEIGHT,
    mask: fourStateCurveMask(),
    bounds: LABEL_BOUNDS,
  });
}

function setRgbPixel(pixels, width, height, x, y, color) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const offset = (y * width + x) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function drawRgbLine(
  pixels,
  width,
  height,
  startX,
  startY,
  endX,
  endY,
  color,
  thickness = 1,
) {
  const steps = Math.max(
    1,
    Math.abs(endX - startX),
    Math.abs(endY - startY),
  );
  const radius = Math.max(0, Math.floor((thickness - 1) / 2));
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    const x = Math.round(
      startX + (endX - startX) * progress,
    );
    const y = Math.round(
      startY + (endY - startY) * progress,
    );
    for (let localY = y - radius; localY <= y + radius; localY += 1) {
      for (let localX = x - radius; localX <= x + radius; localX += 1) {
        setRgbPixel(
          pixels,
          width,
          height,
          localX,
          localY,
          color,
        );
      }
    }
  }
}

function rgbFromMask(mask, width, height) {
  const pixels = new Uint8Array(width * height * 3).fill(255);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const offset = index * 3;
    pixels[offset] = 27;
    pixels[offset + 1] = 31;
    pixels[offset + 2] = 36;
  }
  return pixels;
}

function encodeFixture(pixels, width, height) {
  return encodePng({
    width,
    height,
    data: pixels,
    channels: 3,
    depth: 8,
  });
}

function encodedLabelApiFixture({
  placement,
  scale,
  rotation,
  name,
  measured = false,
}) {
  const base = measured
    ? (() => {
        const mask = repeatedStateCurveMask(4);
        drawRotatedLabel(mask, {
          ...LABEL_PLACEMENTS[placement],
          scale,
          rotation,
        });
        return Object.freeze({
          name,
          width: LABEL_WIDTH,
          height: LABEL_HEIGHT,
          mask,
          bounds: LABEL_BOUNDS,
          expected: Object.freeze({
            distributionCount: 1,
            seriesCount: 1,
            peakCount: 4,
            valleyCount: 3,
          }),
          parameters: Object.freeze({
            placement,
            scale,
            rotation,
            measured,
          }),
        });
      })()
    : labelArtifactMaskFixture({
        placement,
        scale,
        rotation,
      });
  const pixels = rgbFromMask(
    base.mask,
    base.width,
    base.height,
  );
  const frame = [42, 46, 52];
  drawRgbLine(
    pixels,
    base.width,
    base.height,
    3,
    3,
    base.width - 4,
    3,
    frame,
    2,
  );
  drawRgbLine(
    pixels,
    base.width,
    base.height,
    3,
    base.height - 4,
    base.width - 4,
    base.height - 4,
    frame,
    2,
  );
  drawRgbLine(
    pixels,
    base.width,
    base.height,
    3,
    3,
    3,
    base.height - 4,
    frame,
    2,
  );
  drawRgbLine(
    pixels,
    base.width,
    base.height,
    base.width - 4,
    3,
    base.width - 4,
    base.height - 4,
    frame,
    2,
  );
  return Object.freeze({
    ...base,
    name,
    channels: 3,
    pixels,
    bytes: encodeFixture(pixels, base.width, base.height),
    mimeType: "image/png",
    expected: Object.freeze({
      ...base.expected,
      panelCount: 1,
    }),
  });
}

export function encodedLabelApiSentinelFixture() {
  return encodedLabelApiFixture({
    placement: "valley",
    scale: 4,
    rotation: 8,
    name: "encoded-label-api-sentinel",
  });
}

export function encodedLabelPlacementApiFixtures() {
  return Object.freeze([
    encodedLabelApiFixture({
      placement: "above",
      scale: 4,
      rotation: -8,
      name: "encoded-label-api-above-s4-rm8",
      measured: true,
    }),
    encodedLabelApiFixture({
      placement: "below",
      scale: 3,
      rotation: 8,
      name: "encoded-label-api-below-s3-rp8",
      measured: true,
    }),
    encodedLabelApiFixture({
      placement: "valley",
      scale: 4,
      rotation: 8,
      name: "encoded-label-api-valley-s4-rp8",
      measured: true,
    }),
    encodedLabelApiFixture({
      placement: "tail",
      scale: 2,
      rotation: -8,
      name: "encoded-label-api-tail-s2-rm8",
      measured: true,
    }),
  ]);
}

function sourceRgb(pixels, width, height, x, y, channel) {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  return pixels[(clampedY * width + clampedX) * 3 + channel];
}

function resizedRgb(
  source,
  sourceWidth,
  sourceHeight,
  width,
  height,
  interpolation,
) {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const sourceY =
      (y / Math.max(1, height - 1)) * (sourceHeight - 1);
    for (let x = 0; x < width; x += 1) {
      const sourceX =
        (x / Math.max(1, width - 1)) * (sourceWidth - 1);
      const targetOffset = (y * width + x) * 3;
      if (interpolation === "nearest") {
        const nearestX = Math.round(sourceX);
        const nearestY = Math.round(sourceY);
        for (let channel = 0; channel < 3; channel += 1) {
          pixels[targetOffset + channel] = sourceRgb(
            source,
            sourceWidth,
            sourceHeight,
            nearestX,
            nearestY,
            channel,
          );
        }
        continue;
      }
      const left = Math.floor(sourceX);
      const top = Math.floor(sourceY);
      const right = Math.min(sourceWidth - 1, left + 1);
      const bottom = Math.min(sourceHeight - 1, top + 1);
      const fractionX = sourceX - left;
      const fractionY = sourceY - top;
      for (let channel = 0; channel < 3; channel += 1) {
        const topValue =
          sourceRgb(
            source,
            sourceWidth,
            sourceHeight,
            left,
            top,
            channel,
          ) *
            (1 - fractionX) +
          sourceRgb(
            source,
            sourceWidth,
            sourceHeight,
            right,
            top,
            channel,
          ) *
            fractionX;
        const bottomValue =
          sourceRgb(
            source,
            sourceWidth,
            sourceHeight,
            left,
            bottom,
            channel,
          ) *
            (1 - fractionX) +
          sourceRgb(
            source,
            sourceWidth,
            sourceHeight,
            right,
            bottom,
            channel,
          ) *
            fractionX;
        pixels[targetOffset + channel] = Math.round(
          topValue * (1 - fractionY) +
            bottomValue * fractionY,
        );
      }
    }
  }
  return pixels;
}

function centeredRgb(
  source,
  sourceWidth,
  sourceHeight,
  width,
  height,
) {
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const offsetX = Math.floor((width - sourceWidth) / 2);
  const offsetY = Math.floor((height - sourceHeight) / 2);
  for (let y = 0; y < sourceHeight; y += 1) {
    const sourceOffset = y * sourceWidth * 3;
    const targetOffset =
      ((offsetY + y) * width + offsetX) * 3;
    pixels.set(
      source.subarray(
        sourceOffset,
        sourceOffset + sourceWidth * 3,
      ),
      targetOffset,
    );
  }
  return pixels;
}

function rotatedRgb(
  source,
  width,
  height,
  angle,
  interpolation,
) {
  if (angle === 0) return source;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const radians = (-angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const relativeX = x - centerX;
      const relativeY = y - centerY;
      const sourceX =
        centerX + relativeX * cosine - relativeY * sine;
      const sourceY =
        centerY + relativeX * sine + relativeY * cosine;
      if (
        sourceX < 0 ||
        sourceX > width - 1 ||
        sourceY < 0 ||
        sourceY > height - 1
      ) {
        continue;
      }
      const targetOffset = (y * width + x) * 3;
      if (interpolation === "nearest") {
        for (let channel = 0; channel < 3; channel += 1) {
          pixels[targetOffset + channel] = sourceRgb(
            source,
            width,
            height,
            Math.round(sourceX),
            Math.round(sourceY),
            channel,
          );
        }
        continue;
      }
      const left = Math.floor(sourceX);
      const top = Math.floor(sourceY);
      const right = Math.min(width - 1, left + 1);
      const bottom = Math.min(height - 1, top + 1);
      const fractionX = sourceX - left;
      const fractionY = sourceY - top;
      for (let channel = 0; channel < 3; channel += 1) {
        const topValue =
          sourceRgb(
            source,
            width,
            height,
            left,
            top,
            channel,
          ) *
            (1 - fractionX) +
          sourceRgb(
            source,
            width,
            height,
            right,
            top,
            channel,
          ) *
            fractionX;
        const bottomValue =
          sourceRgb(
            source,
            width,
            height,
            left,
            bottom,
            channel,
          ) *
            (1 - fractionX) +
          sourceRgb(
            source,
            width,
            height,
            right,
            bottom,
            channel,
          ) *
            fractionX;
        pixels[targetOffset + channel] = Math.round(
          topValue * (1 - fractionY) +
            bottomValue * fractionY,
        );
      }
    }
  }
  return pixels;
}

function lowResolutionLabelApiFixture({
  longestEdge,
  interpolation,
  rotation,
}) {
  const source = encodedLabelApiSentinelFixture();
  const width = longestEdge;
  const height = Math.max(
    1,
    Math.round((source.height / source.width) * width),
  );
  const contentScale = rotation === 0 ? 1 : 0.84;
  const contentWidth = Math.max(
    1,
    Math.round(width * contentScale),
  );
  const contentHeight = Math.max(
    1,
    Math.round(height * contentScale),
  );
  const resized = resizedRgb(
    source.pixels,
    source.width,
    source.height,
    contentWidth,
    contentHeight,
    interpolation,
  );
  const centered = centeredRgb(
    resized,
    contentWidth,
    contentHeight,
    width,
    height,
  );
  const pixels = rotatedRgb(
    centered,
    width,
    height,
    rotation,
    interpolation,
  );
  const rotationLabel =
    rotation < 0 ? `m${Math.abs(rotation)}` : `p${rotation}`;
  const requiresExactApiTopology =
    (rotation === 0 && longestEdge >= 240) ||
    (Math.abs(rotation) === 5 && longestEdge === 350);
  return Object.freeze({
    name:
      `lowres-label-${longestEdge}-${interpolation}-` +
      `r${rotationLabel}`,
    width,
    height,
    channels: 3,
    pixels,
    bytes: encodeFixture(pixels, width, height),
    mimeType: "image/png",
    expected: Object.freeze({
      ...source.expected,
      requiresExactApiTopology,
    }),
    parameters: Object.freeze({
      longestEdge,
      interpolation,
      rotation,
    }),
  });
}

export function lowResolutionLabelApiFixtures() {
  const longestEdges = [350, 240, 180, 140, 100, 80];
  const base = longestEdges.flatMap((longestEdge) =>
    ["bilinear", "nearest"].map((interpolation) =>
      lowResolutionLabelApiFixture({
        longestEdge,
        interpolation,
        rotation: 0,
      }),
    ),
  );
  const rotated = [350, 180, 100, 80].flatMap(
    (longestEdge) =>
      [-5, 5].map((rotation) =>
        lowResolutionLabelApiFixture({
          longestEdge,
          interpolation: "bilinear",
          rotation,
        }),
      ),
  );
  return Object.freeze([...base, ...rotated]);
}

function persistentTopologyVariant(kind) {
  if (kind === "narrow-outer-state") {
    return Object.freeze({
      lobes: Object.freeze([
        Object.freeze({
          left: 0.08,
          right: 0.72,
          amplitude: 0.9,
        }),
        Object.freeze({
          left: 0.9,
          right: 0.92,
          amplitude: 1,
          sharpness: 4,
          supportAmplitude: 0.28,
          supportScale: 2.5,
        }),
      ]),
    });
  }
  return Object.freeze({
    lobes: Object.freeze([
      Object.freeze({
        left: 0.15,
        right: 0.82,
        amplitude: 0.92,
      }),
      Object.freeze({
        left: 0.82,
        right: 0.84,
        amplitude: 1,
        sharpness: 4,
        supportAmplitude: 0.28,
        supportScale: 2.5,
      }),
    ]),
  });
}

function lowResolutionPersistentTopologyFixture(kind) {
  const width = 180;
  const height = 110;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const bounds = Object.freeze({
    left: 4,
    top: 4,
    right: width - 5,
    bottom: height - 5,
  });
  const variant = persistentTopologyVariant(kind);
  let previous = null;
  const curveLeft = bounds.left + 4;
  const curveRight = bounds.right - 4;
  const curveTop = bounds.top + 6;
  const curveBottom = bounds.bottom - 5;
  for (let x = curveLeft; x <= curveRight; x += 1) {
    const progress =
      (x - curveLeft) /
      Math.max(1, curveRight - curveLeft);
    const tailDensity =
      variant.tail &&
      progress >= variant.tail.start &&
      progress <= variant.tail.end
        ? variant.tail.amplitude *
          (1 -
            (progress - variant.tail.start) /
              Math.max(
                1e-6,
                variant.tail.end - variant.tail.start,
              ))
        : 0;
    const density = Math.max(
      0,
      tailDensity,
      ...[
        ...variant.lobes,
        ...(variant.supports ?? []),
      ].map((lobe) => {
        const center = (lobe.left + lobe.right) / 2;
        const halfWidth = Math.max(
          1e-6,
          (lobe.right - lobe.left) / 2,
        );
        const normalized = (progress - center) / halfWidth;
        const core =
          Math.abs(normalized) <= 1
            ? lobe.amplitude *
              Math.cos((normalized * Math.PI) / 2) **
                (2 * (lobe.sharpness ?? 1))
            : 0;
        const supportScale = lobe.supportScale ?? 1;
        const supportNormalized =
          normalized / supportScale;
        const support =
          lobe.supportAmplitude &&
          Math.abs(supportNormalized) <= 1
            ? lobe.supportAmplitude *
              Math.cos(
                (supportNormalized * Math.PI) / 2,
              ) **
                2
            : 0;
        return Math.max(core, support);
      }),
    );
    const y = Math.round(
      curveBottom -
        density * (curveBottom - curveTop),
    );
    if (previous) {
      drawRgbLine(
        pixels,
        width,
        height,
        previous.x,
        previous.y,
        x,
        y,
        [24, 100, 211],
        1,
      );
    }
    previous = { x, y };
  }
  return Object.freeze({
    name: `lowres-persistent-${kind}-180x110`,
    width,
    height,
    channels: 3,
    pixels,
    bytes: encodeFixture(pixels, width, height),
    mimeType: "image/png",
    expected: Object.freeze({
      panelCount: 1,
      seriesCount: 1,
      distributionCount: 1,
      peakCount: variant.lobes.length,
      valleyCount: variant.lobes.length - 1,
    }),
    parameters: Object.freeze({
      kind,
      lobes: variant.lobes,
      supports: variant.supports ?? Object.freeze([]),
      tail: variant.tail ?? null,
    }),
  });
}

export function lowResolutionPersistentTopologyFixtures() {
  return Object.freeze([
    lowResolutionPersistentTopologyFixture(
      "narrow-outer-state",
    ),
    lowResolutionPersistentTopologyFixture(
      "close-peak-valley",
    ),
  ]);
}

export function lowResolutionLabeledSixStateApiFixture() {
  const sourceMask = repeatedStateCurveMask(6);
  drawRotatedLabel(sourceMask, {
    ...LABEL_PLACEMENTS.valley,
    scale: 3,
    rotation: 8,
  });
  const sourcePixels = rgbFromMask(
    sourceMask,
    LABEL_WIDTH,
    LABEL_HEIGHT,
  );
  const frame = [42, 46, 52];
  for (const [x1, y1, x2, y2] of [
    [3, 3, LABEL_WIDTH - 4, 3],
    [3, LABEL_HEIGHT - 4, LABEL_WIDTH - 4, LABEL_HEIGHT - 4],
    [3, 3, 3, LABEL_HEIGHT - 4],
    [LABEL_WIDTH - 4, 3, LABEL_WIDTH - 4, LABEL_HEIGHT - 4],
  ]) {
    drawRgbLine(
      sourcePixels,
      LABEL_WIDTH,
      LABEL_HEIGHT,
      x1,
      y1,
      x2,
      y2,
      frame,
      2,
    );
  }
  const width = 240;
  const height = Math.round(
    (LABEL_HEIGHT / LABEL_WIDTH) * width,
  );
  const pixels = resizedRgb(
    sourcePixels,
    LABEL_WIDTH,
    LABEL_HEIGHT,
    width,
    height,
    "bilinear",
  );
  return Object.freeze({
    name: "low-resolution-labeled-six-state-framed",
    width,
    height,
    channels: 3,
    pixels,
    bytes: encodeFixture(pixels, width, height),
    mimeType: "image/png",
    expected: Object.freeze({
      panelCount: 1,
      seriesCount: 1,
      distributionCount: 1,
      peakCount: 6,
      valleyCount: 5,
    }),
  });
}

function drawFramelessThreePeakChart(
  pixels,
  width,
  height,
  bounds,
) {
  const centers = [0.25, 0.5, 0.75];
  const sigma = 0.065;
  let previous;
  for (let x = bounds.left; x <= bounds.right; x += 1) {
    const progress =
      (x - bounds.left) /
      Math.max(1, bounds.right - bounds.left);
    const response = Math.max(
      ...centers.map((center) =>
        Math.exp(
          -0.5 * ((progress - center) / sigma) ** 2,
        ),
      ),
    );
    const y = Math.round(
      bounds.bottom -
        response * (bounds.bottom - bounds.top),
    );
    if (previous) {
      drawRgbLine(
        pixels,
        width,
        height,
        previous.x,
        previous.y,
        x,
        y,
        [24, 102, 210],
        2,
      );
    }
    previous = { x, y };
  }
}

export function lowResolutionScatteredFramelessChartsFixture() {
  const width = 180;
  const height = 180;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const charts = [
    Object.freeze({
      left: 8,
      top: 18,
      right: 76,
      bottom: 70,
    }),
    Object.freeze({
      left: 109,
      top: 119,
      right: 171,
      bottom: 171,
    }),
  ];
  for (const bounds of charts) {
    drawFramelessThreePeakChart(
      pixels,
      width,
      height,
      bounds,
    );
  }
  return Object.freeze({
    name: "low-resolution-two-row-frameless-charts",
    width,
    height,
    channels: 3,
    pixels,
    bytes: encodeFixture(pixels, width, height),
    mimeType: "image/png",
    charts: Object.freeze(charts),
    expected: Object.freeze({
      panelCount: 2,
      stateCount: 3,
      valleyCount: 2,
    }),
  });
}

export function lowResolutionSameRowFramelessChartsFixture() {
  const width = 180;
  const height = 100;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const charts = [
    Object.freeze({
      left: 15,
      top: 32,
      right: 65,
      bottom: 62,
    }),
    Object.freeze({
      left: 114,
      top: 28,
      right: 164,
      bottom: 58,
    }),
  ];
  for (const bounds of charts) {
    drawFramelessThreePeakChart(
      pixels,
      width,
      height,
      bounds,
    );
  }
  return Object.freeze({
    name: "low-resolution-same-row-frameless-charts",
    width,
    height,
    channels: 3,
    pixels,
    bytes: encodeFixture(pixels, width, height),
    mimeType: "image/png",
    charts: Object.freeze(charts),
    expected: Object.freeze({
      panelCount: 2,
      stateCount: 3,
      valleyCount: 2,
    }),
  });
}

function spacedCenters(left, right, count, spacingMode) {
  if (count === 1) return [(left + right) / 2];
  if (spacingMode === "uniform") {
    return Array.from(
      { length: count },
      (_value, index) =>
        left + ((right - left) * index) / (count - 1),
    );
  }
  const weights = Array.from(
    { length: count - 1 },
    (_value, index) => [0.84, 1.16, 0.94, 1.1, 0.88][index % 5],
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const centers = [left];
  let accumulated = 0;
  for (const weight of weights) {
    accumulated += weight;
    centers.push(left + ((right - left) * accumulated) / total);
  }
  return centers;
}

function drawFarSeparatedLobes(
  pixels,
  width,
  height,
  bounds,
  {
    stateCount,
    spacingMode,
    floorTouch,
    colorMode = "monochrome",
  },
) {
  const stateColors = [
    [24, 100, 211],
    [232, 118, 19],
    [32, 148, 74],
    [211, 48, 54],
    [132, 79, 184],
    [150, 92, 48],
    [218, 73, 148],
    [65, 144, 168],
  ];
  const centers = spacedCenters(
    bounds.left + 38,
    bounds.right - 38,
    stateCount,
    spacingMode,
  );
  const endpointY = floorTouch
    ? bounds.bottom
    : bounds.bottom - 17;
  for (let index = 0; index < centers.length; index += 1) {
    const curveColor =
      colorMode === "state-hue-cycle"
        ? stateColors[index % stateColors.length]
        : stateColors[0];
    const leftGap =
      index === 0
        ? centers[Math.min(1, centers.length - 1)] - centers[0]
        : centers[index] - centers[index - 1];
    const rightGap =
      index === centers.length - 1
        ? centers[index] - centers[Math.max(0, index - 1)]
        : centers[index + 1] - centers[index];
    const halfWidth = Math.max(
      10,
      Math.min(leftGap, rightGap) * 0.29,
    );
    const peakY =
      bounds.top +
      27 +
      ((index * 11 + stateCount * 3) % 4) * 7;
    let previous = null;
    const left = Math.round(centers[index] - halfWidth);
    const right = Math.round(centers[index] + halfWidth);
    for (let x = left; x <= right; x += 1) {
      const normalized =
        (x - centers[index]) / Math.max(1, halfWidth);
      const response =
        Math.abs(normalized) > 1
          ? 0
          : Math.cos((normalized * Math.PI) / 2) ** 2;
      const y = Math.round(
        endpointY - response * (endpointY - peakY),
      );
      if (previous) {
        drawRgbLine(
          pixels,
          width,
          height,
          previous.x,
          previous.y,
          x,
          y,
          curveColor,
          2,
        );
      }
      previous = { x, y };
    }
  }
}

function farSeparatedPeakFixture({
  stateCount,
  spacingMode,
  floorTouch,
  axisMode,
  colorMode = "monochrome",
}) {
  const width = 1500;
  const height = 500;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const bounds = Object.freeze({
    left: 25,
    top: 18,
    right: width - 26,
    bottom: height - 25,
  });
  const axisColor = [39, 43, 49];
  drawRgbLine(
    pixels,
    width,
    height,
    bounds.left,
    bounds.bottom,
    bounds.right,
    bounds.bottom,
    axisColor,
    2,
  );
  drawRgbLine(
    pixels,
    width,
    height,
    bounds.left,
    bounds.top,
    bounds.left,
    bounds.bottom,
    axisColor,
    2,
  );
  if (axisMode === "rectangle") {
    drawRgbLine(
      pixels,
      width,
      height,
      bounds.left,
      bounds.top,
      bounds.right,
      bounds.top,
      axisColor,
      2,
    );
    drawRgbLine(
      pixels,
      width,
      height,
      bounds.right,
      bounds.top,
      bounds.right,
      bounds.bottom,
      axisColor,
      2,
    );
  }
  drawFarSeparatedLobes(pixels, width, height, bounds, {
    stateCount,
    spacingMode,
    floorTouch,
    colorMode,
  });
  const name = [
    `far-${stateCount}`,
    spacingMode,
    floorTouch ? "floor" : "above",
    axisMode,
    ...(colorMode === "monochrome"
      ? []
      : ["state-hue-cycle"]),
  ].join("-");
  return Object.freeze({
    name,
    width,
    height,
    channels: 3,
    pixels,
    bytes: encodeFixture(pixels, width, height),
    mimeType: "image/png",
    bounds,
    expected: Object.freeze({
      panelCount: 1,
      distributionCount: 1,
      seriesCount: 1,
      peakCount: stateCount,
      valleyCount: stateCount - 1,
    }),
    parameters: Object.freeze({
      stateCount,
      spacingMode,
      floorTouch,
      axisMode,
      colorMode,
    }),
  });
}

function farSeparatedPeakMatrix(colorMode) {
  return Object.freeze(
    Array.from(
      { length: 15 },
      (_value, index) => index + 2,
    ).flatMap((stateCount) =>
      ["uniform", "irregular"].flatMap((spacingMode) =>
        [false, true].flatMap((floorTouch) =>
          ["rectangle", "l-axis"].map((axisMode) =>
            farSeparatedPeakFixture({
              stateCount,
              spacingMode,
              floorTouch,
              axisMode,
              colorMode,
            }),
          ),
        ),
      ),
    ),
  );
}

export function farSeparatedPeakFixtures() {
  return farSeparatedPeakMatrix("monochrome");
}

export function multicolorFarSeparatedPeakFixtures() {
  return farSeparatedPeakMatrix("state-hue-cycle");
}

export function lowResolutionMulticolorFarSeparatedPeakFixtures() {
  const representativeKeys = new Set([
    "2-uniform-above-rectangle",
    "4-irregular-floor-l-axis",
    "8-uniform-floor-rectangle",
    "16-irregular-above-l-axis",
  ]);
  return Object.freeze(
    multicolorFarSeparatedPeakFixtures()
      .filter((fixture) =>
        representativeKeys.has(
          [
            fixture.parameters.stateCount,
            fixture.parameters.spacingMode,
            fixture.parameters.floorTouch
              ? "floor"
              : "above",
            fixture.parameters.axisMode,
          ].join("-"),
        ),
      )
      .map((fixture) => {
        const width =
          fixture.parameters.stateCount === 16
            ? 960
            : 480;
        const height = Math.round(
          (fixture.height / fixture.width) * width,
        );
        const pixels = resizedRgb(
          fixture.pixels,
          fixture.width,
          fixture.height,
          width,
          height,
          "bilinear",
        );
        return Object.freeze({
          ...fixture,
          name: `${fixture.name}-lowres-${width}x${height}`,
          width,
          height,
          pixels,
          bytes: encodeFixture(pixels, width, height),
          expected: Object.freeze({
            ...fixture.expected,
          }),
        });
      }),
  );
}
