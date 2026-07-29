export function boundedUiRasterScale(
  width,
  height,
  {
    maximumWidth = 1920,
    maximumHeight = 1200,
    maximumPixels = 2_100_000,
    maximumScale = 4,
    upscaleBelowDimension = 360,
  } = {},
) {
  const allowedScale =
    Math.min(width, height) < upscaleBelowDimension
      ? maximumScale
      : 1;
  return Math.min(
    allowedScale,
    maximumWidth / Math.max(1, width),
    maximumHeight / Math.max(1, height),
    Math.sqrt(
      maximumPixels / Math.max(1, width * height),
    ),
  );
}

function sourceRgb(pixels, channels, index) {
  const offset = index * channels;
  const alpha =
    channels === 2 || channels === 4
      ? pixels[offset + channels - 1]
      : 255;
  const red = pixels[offset];
  const green =
    channels <= 2 ? red : pixels[offset + 1];
  const blue =
    channels <= 2 ? red : pixels[offset + 2];
  return [
    Math.round((red * alpha + 255 * (255 - alpha)) / 255),
    Math.round((green * alpha + 255 * (255 - alpha)) / 255),
    Math.round((blue * alpha + 255 * (255 - alpha)) / 255),
  ];
}

/**
 * Reproduce the browser's bounded, smoothed white-canvas raster used before
 * chart-panel detection. The returned RGBA buffer can be passed directly to
 * detectChartPanels with sourceScale.
 */
export function uiScaledRgba(
  pixels,
  width,
  height,
  channels,
  options,
) {
  const scale = boundedUiRasterScale(
    width,
    height,
    options,
  );
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const output = new Uint8Array(
    targetWidth * targetHeight * 4,
  );
  const xRatio = width / targetWidth;
  const yRatio = height / targetHeight;

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = (y + 0.5) * yRatio - 0.5;
    const top = Math.max(0, Math.floor(sourceY));
    const bottom = Math.min(height - 1, top + 1);
    const yWeight = Math.max(0, sourceY - top);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = (x + 0.5) * xRatio - 0.5;
      const left = Math.max(0, Math.floor(sourceX));
      const right = Math.min(width - 1, left + 1);
      const xWeight = Math.max(0, sourceX - left);
      const topLeft = sourceRgb(
        pixels,
        channels,
        top * width + left,
      );
      const topRight = sourceRgb(
        pixels,
        channels,
        top * width + right,
      );
      const bottomLeft = sourceRgb(
        pixels,
        channels,
        bottom * width + left,
      );
      const bottomRight = sourceRgb(
        pixels,
        channels,
        bottom * width + right,
      );
      const outputOffset = (y * targetWidth + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const topValue =
          topLeft[channel] * (1 - xWeight) +
          topRight[channel] * xWeight;
        const bottomValue =
          bottomLeft[channel] * (1 - xWeight) +
          bottomRight[channel] * xWeight;
        output[outputOffset + channel] = Math.round(
          topValue * (1 - yWeight) +
            bottomValue * yWeight,
        );
      }
      output[outputOffset + 3] = 255;
    }
  }

  return {
    pixels: output,
    width: targetWidth,
    height: targetHeight,
    channels: 4,
    scale,
  };
}
