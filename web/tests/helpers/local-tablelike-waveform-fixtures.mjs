import { encode as encodePng } from "fast-png";

import {
  sharedBoundaryHalfCanvasLatticeFixture,
  singleRowSharedBoundaryHalfCanvasLatticeFixture,
} from "./half-canvas-tablelike-waveform-fixtures.mjs";

function bilinearSample(
  source,
  sourceWidth,
  sourceHeight,
  sourceChannels,
  sourceBounds,
  targetWidth,
  targetHeight,
) {
  const sourceRegionWidth =
    sourceBounds.right - sourceBounds.left + 1;
  const sourceRegionHeight =
    sourceBounds.bottom - sourceBounds.top + 1;
  const output = new Uint8Array(targetWidth * targetHeight * 3);

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY =
      (y + 0.5) * (sourceRegionHeight / targetHeight) - 0.5;
    const top = Math.max(0, Math.floor(sourceY));
    const bottom = Math.min(sourceRegionHeight - 1, top + 1);
    const yWeight = Math.max(0, sourceY - top);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX =
        (x + 0.5) * (sourceRegionWidth / targetWidth) - 0.5;
      const left = Math.max(0, Math.floor(sourceX));
      const right = Math.min(sourceRegionWidth - 1, left + 1);
      const xWeight = Math.max(0, sourceX - left);
      const outputOffset = (y * targetWidth + x) * 3;
      const sourceOffset = (localX, localY, channel) =>
        ((sourceBounds.top + localY) * sourceWidth +
          sourceBounds.left +
          localX) *
          sourceChannels +
        channel;

      for (let channel = 0; channel < 3; channel += 1) {
        const topValue =
          source[sourceOffset(left, top, channel)] *
            (1 - xWeight) +
          source[sourceOffset(right, top, channel)] * xWeight;
        const bottomValue =
          source[sourceOffset(left, bottom, channel)] *
            (1 - xWeight) +
          source[sourceOffset(right, bottom, channel)] *
            xWeight;
        output[outputOffset + channel] = Math.round(
          topValue * (1 - yWeight) + bottomValue * yWeight,
        );
      }
    }
  }
  return output;
}

function transformedBounds(
  sourceBounds,
  chartBounds,
  placement,
) {
  const sourceWidth =
    sourceBounds.right - sourceBounds.left + 1;
  const sourceHeight =
    sourceBounds.bottom - sourceBounds.top + 1;
  return Object.freeze({
    left:
      placement.left +
      Math.round(
        ((chartBounds.left - sourceBounds.left) *
          placement.width) /
          sourceWidth,
      ),
    top:
      placement.top +
      Math.round(
        ((chartBounds.top - sourceBounds.top) *
          placement.height) /
          sourceHeight,
      ),
    right:
      placement.left +
      Math.round(
        ((chartBounds.right - sourceBounds.left + 1) *
          placement.width) /
          sourceWidth,
      ) -
      1,
    bottom:
      placement.top +
      Math.round(
        ((chartBounds.bottom - sourceBounds.top + 1) *
          placement.height) /
          sourceHeight,
      ) -
      1,
  });
}

function placeFixture({
  name,
  source,
  canvasWidth,
  canvasHeight,
  left,
  top,
  width,
  height,
}) {
  const placement = { left, top, width, height };
  const scaled = bilinearSample(
    source.pixels,
    source.width,
    source.height,
    source.channels,
    source.chartRegion,
    width,
    height,
  );
  const pixels = new Uint8Array(
    canvasWidth * canvasHeight * 3,
  ).fill(255);
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = y * width * 3;
    const targetOffset =
      ((top + y) * canvasWidth + left) * 3;
    pixels.set(
      scaled.subarray(
        sourceOffset,
        sourceOffset + width * 3,
      ),
      targetOffset,
    );
  }
  const charts = source.charts.map((chart) =>
    Object.freeze({
      index: chart.index,
      expectedPeakCount: chart.peakCount,
      expectedValleyCount: chart.peakCount - 1,
      bounds: transformedBounds(
        source.chartRegion,
        chart.bounds,
        placement,
      ),
    }),
  );
  return Object.freeze({
    name,
    width: canvasWidth,
    height: canvasHeight,
    channels: 3,
    pixels,
    bytes: encodePng({
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      depth: 8,
      data: pixels,
    }),
    mimeType: "image/png",
    placement: Object.freeze(placement),
    charts: Object.freeze(charts),
    expectedChartCount: charts.length,
  });
}

export function localTablelikeWaveformFixtures() {
  const grid = sharedBoundaryHalfCanvasLatticeFixture();
  const singleRow =
    singleRowSharedBoundaryHalfCanvasLatticeFixture();
  return Object.freeze([
    placeFixture({
      name: "half-canvas-4x4-control",
      source: grid,
      canvasWidth: 640,
      canvasHeight: 360,
      left: 8,
      top: 24,
      width: 308,
      height: 310,
    }),
    placeFixture({
      name: "center-small-4x4",
      source: grid,
      canvasWidth: 1280,
      canvasHeight: 720,
      left: 440,
      top: 220,
      width: 400,
      height: 300,
    }),
    placeFixture({
      name: "center-small-single-row-1x4",
      source: singleRow,
      canvasWidth: 1280,
      canvasHeight: 720,
      left: 440,
      top: 220,
      width: 400,
      height: 83,
    }),
  ]);
}
