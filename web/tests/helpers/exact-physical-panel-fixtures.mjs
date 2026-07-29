import { encode as encodePng } from "fast-png";

import {
  colorSeriesChartFixture,
} from "./color-series-fixtures.mjs";

function whiteCanvas(width, height) {
  return new Uint8Array(width * height * 3).fill(255);
}

function sourceRgb(source, x, y) {
  const offset = (y * source.width + x) * source.channels;
  const red = source.data[offset];
  const green =
    source.channels >= 3 ? source.data[offset + 1] : red;
  const blue =
    source.channels >= 3 ? source.data[offset + 2] : red;
  const alpha =
    source.channels === 2 || source.channels === 4
      ? source.data[offset + source.channels - 1] / 255
      : 1;
  return [
    Math.round(red * alpha + 255 * (1 - alpha)),
    Math.round(green * alpha + 255 * (1 - alpha)),
    Math.round(blue * alpha + 255 * (1 - alpha)),
  ];
}

function setPixel(pixels, width, height, x, y, color) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const offset = (y * width + x) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function blitDecoded(
  target,
  targetWidth,
  targetHeight,
  source,
  offsetX,
  offsetY,
) {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      setPixel(
        target,
        targetWidth,
        targetHeight,
        offsetX + x,
        offsetY + y,
        sourceRgb(source, x, y),
      );
    }
  }
}

function blitRgb(
  target,
  targetWidth,
  targetHeight,
  source,
  sourceWidth,
  sourceHeight,
  offsetX,
  offsetY,
) {
  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < sourceWidth; x += 1) {
      const sourceOffset = (y * sourceWidth + x) * 3;
      setPixel(
        target,
        targetWidth,
        targetHeight,
        offsetX + x,
        offsetY + y,
        [
          source[sourceOffset],
          source[sourceOffset + 1],
          source[sourceOffset + 2],
        ],
      );
    }
  }
}

function bilinearSourceChannel(source, x, y, channel) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(source.width - 1, x0 + 1);
  const y1 = Math.min(source.height - 1, y0 + 1);
  const dx = x - x0;
  const dy = y - y0;
  const top =
    sourceRgb(source, x0, y0)[channel] * (1 - dx) +
    sourceRgb(source, x1, y0)[channel] * dx;
  const bottom =
    sourceRgb(source, x0, y1)[channel] * (1 - dx) +
    sourceRgb(source, x1, y1)[channel] * dx;
  return Math.round(top * (1 - dy) + bottom * dy);
}

function blitDecodedBilinear(
  target,
  targetWidth,
  targetHeight,
  source,
  bounds,
) {
  const outputWidth = bounds.right - bounds.left + 1;
  const outputHeight = bounds.bottom - bounds.top + 1;
  for (let localY = 0; localY < outputHeight; localY += 1) {
    const sourceY =
      (localY / Math.max(1, outputHeight - 1)) *
      (source.height - 1);
    for (let localX = 0; localX < outputWidth; localX += 1) {
      const sourceX =
        (localX / Math.max(1, outputWidth - 1)) *
        (source.width - 1);
      setPixel(
        target,
        targetWidth,
        targetHeight,
        bounds.left + localX,
        bounds.top + localY,
        [
          bilinearSourceChannel(source, sourceX, sourceY, 0),
          bilinearSourceChannel(source, sourceX, sourceY, 1),
          bilinearSourceChannel(source, sourceX, sourceY, 2),
        ],
      );
    }
  }
}

function darkContentBounds(source, threshold = 248) {
  let left = source.width;
  let top = source.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const [red, green, blue] = sourceRgb(source, x, y);
      if (
        red >= threshold &&
        green >= threshold &&
        blue >= threshold
      ) {
        continue;
      }
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) {
    throw new Error("Corpus source has no dark waveform content.");
  }
  return { left, top, right, bottom };
}

function translated(bounds, offsetX, offsetY) {
  return {
    left: bounds.left + offsetX,
    top: bounds.top + offsetY,
    right: bounds.right + offsetX,
    bottom: bounds.bottom + offsetY,
  };
}

function scaledBounds(sourceBounds, source, targetBounds) {
  const targetWidth = targetBounds.right - targetBounds.left;
  const targetHeight = targetBounds.bottom - targetBounds.top;
  return {
    left:
      targetBounds.left +
      Math.round(
        (sourceBounds.left / Math.max(1, source.width - 1)) *
          targetWidth,
      ),
    top:
      targetBounds.top +
      Math.round(
        (sourceBounds.top / Math.max(1, source.height - 1)) *
          targetHeight,
      ),
    right:
      targetBounds.left +
      Math.round(
        (sourceBounds.right / Math.max(1, source.width - 1)) *
          targetWidth,
      ),
    bottom:
      targetBounds.top +
      Math.round(
        (sourceBounds.bottom / Math.max(1, source.height - 1)) *
          targetHeight,
      ),
  };
}

function encodedFixture({
  name,
  width,
  height,
  pixels,
  expectedPanels,
  sourcePlacements,
  blankGutter,
  variant,
}) {
  return {
    name,
    width,
    height,
    channels: 3,
    pixels,
    bytes: encodePng({
      width,
      height,
      data: pixels,
      channels: 3,
      depth: 8,
    }),
    mimeType: "image/png",
    expectedPanels,
    sourcePlacements,
    expectedPanelCount: expectedPanels.length,
    blankGutter,
    variant,
  };
}

export function centeredCorpusMarginFixture(source) {
  if (source.width !== 759 || source.height !== 370) {
    throw new Error("Expected the 759 × 370 corpus chart.");
  }
  const width = 959;
  const height = 570;
  const offsetX = 100;
  const offsetY = 100;
  const pixels = whiteCanvas(width, height);
  blitDecoded(
    pixels,
    width,
    height,
    source,
    offsetX,
    offsetY,
  );
  const sourceBounds = {
    left: offsetX,
    top: offsetY,
    right: offsetX + source.width - 1,
    bottom: offsetY + source.height - 1,
  };
  return encodedFixture({
    name: "centered-corpus-margin",
    width,
    height,
    pixels,
    expectedPanels: [
      {
        kind: "real-corpus",
        bounds: translated(
          darkContentBounds(source),
          offsetX,
          offsetY,
        ),
      },
    ],
    sourcePlacements: [sourceBounds],
    blankGutter: undefined,
  });
}

export function sideBySideCorpusGutterFixture(
  firstSource,
  secondSource,
  requestedBlankGutter = 100,
) {
  if (
    firstSource.width !== 759 ||
    firstSource.height !== 370 ||
    secondSource.width !== 842 ||
    secondSource.height !== 333
  ) {
    throw new Error("Unexpected corpus chart dimensions.");
  }
  if (
    !Number.isInteger(requestedBlankGutter) ||
    requestedBlankGutter < 0
  ) {
    throw new Error(
      "The requested blank gutter must be a non-negative integer.",
    );
  }
  const width =
    firstSource.width +
    requestedBlankGutter +
    secondSource.width;
  const height = 370;
  const secondX =
    firstSource.width + requestedBlankGutter;
  const secondY = Math.floor(
    (height - secondSource.height) / 2,
  );
  const pixels = whiteCanvas(width, height);
  blitDecoded(pixels, width, height, firstSource, 0, 0);
  blitDecoded(
    pixels,
    width,
    height,
    secondSource,
    secondX,
    secondY,
  );
  const sourcePlacements = [
    {
      left: 0,
      top: 0,
      right: firstSource.width - 1,
      bottom: firstSource.height - 1,
    },
    {
      left: secondX,
      top: secondY,
      right: secondX + secondSource.width - 1,
      bottom: secondY + secondSource.height - 1,
    },
  ];
  return encodedFixture({
    name:
      requestedBlankGutter === 100
        ? "side-by-side-corpus-gutter"
        : `side-by-side-corpus-gutter-${requestedBlankGutter}`,
    width,
    height,
    pixels,
    expectedPanels: [
      {
        kind: "real-corpus-a",
        bounds: darkContentBounds(firstSource),
      },
      {
        kind: "real-corpus-b",
        bounds: translated(
          darkContentBounds(secondSource),
          secondX,
          secondY,
        ),
      },
    ],
    sourcePlacements,
    blankGutter:
      sourcePlacements[1].left -
      sourcePlacements[0].right -
      1,
  });
}

export function dominantColorAndSmallRealFixture(
  smallSource,
  variant = 0,
) {
  if (![0, 1].includes(variant)) {
    throw new Error("Supported dominant ROI variants are 0 and 1.");
  }
  const width = 1500;
  const height = 850;
  const pixels = whiteCanvas(width, height);
  const large = colorSeriesChartFixture({
    width: 920,
    height: 600,
    seriesCount: 3,
    crossingMode: "near",
  });
  const largeOffset =
    variant === 0 ? { x: 20, y: 60 } : { x: 550, y: 200 };
  const smallBounds =
    variant === 0
      ? { left: 1120, top: 680, right: 1439, bottom: 806 }
      : { left: 20, top: 20, right: 339, bottom: 146 };
  blitRgb(
    pixels,
    width,
    height,
    large.pixels,
    large.width,
    large.height,
    largeOffset.x,
    largeOffset.y,
  );
  blitDecodedBilinear(
    pixels,
    width,
    height,
    smallSource,
    smallBounds,
  );

  const largePlotBounds = translated(
    large.bounds,
    largeOffset.x,
    largeOffset.y,
  );
  const smallContentBounds = scaledBounds(
    darkContentBounds(smallSource),
    smallSource,
    smallBounds,
  );
  return encodedFixture({
    name: `dominant-color-small-real-${variant}`,
    width,
    height,
    pixels,
    expectedPanels: [
      {
        kind: "large-color-series",
        bounds: largePlotBounds,
        expectedSeriesCount: 3,
      },
      {
        kind: "small-real-corpus",
        bounds: smallContentBounds,
        expectedSeriesCount: 1,
      },
    ],
    sourcePlacements: [
      {
        left: largeOffset.x,
        top: largeOffset.y,
        right: largeOffset.x + large.width - 1,
        bottom: largeOffset.y + large.height - 1,
      },
      smallBounds,
    ],
    blankGutter: undefined,
    variant,
  });
}
