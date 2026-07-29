import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import {
  cropInterleavedPixels,
  detectChartPanels,
} from "../lib/vth-chart-panel-core.mjs";
import { analyzeForegroundMasks } from "../lib/vth-image-analysis-core.mjs";
import { buildForegroundMasks } from "../lib/vth-image-core.mjs";
import {
  movingAverage,
  resample,
} from "../lib/vth-shape-core.mjs";

const FIXTURES = [
  {
    file: "scatter-outliers-1672.png",
    sha256:
      "55fd995b425a15f3a5038c1f1abcc6c50f6bf7c52f4bbf32bc6b22bf1ac3862d",
    width: 1672,
    height: 941,
    columns: [
      [40, 300],
      [320, 585],
      [605, 870],
      [880, 1145],
    ],
    rows: [
      [105, 255],
      [275, 435],
      [455, 610],
      [625, 835],
    ],
    // Count the arches that are actually drawn. Several captions in these
    // synthetic office slides disagree with their visible Curve topology.
    visiblePeakCounts: [
      1, 2, 3, 4,
      5, 6, 7, 8,
      10, 10, 11, 12,
      14, 15, 16, 17,
    ],
  },
  {
    file: "clean-open-axes-1672.png",
    sha256:
      "6c7705d460f0afc169c9f736cc9b2d53339640cfc7ee3fa55e3dec3a24f8fbc1",
    width: 1672,
    height: 941,
    columns: [
      [40, 295],
      [325, 580],
      [605, 855],
      [880, 1135],
    ],
    rows: [
      [105, 260],
      [280, 440],
      [455, 615],
      [630, 835],
    ],
    visiblePeakCounts: [
      1, 2, 3, 4,
      5, 5, 7, 8,
      8, 8, 10, 12,
      13, 14, 15, 16,
    ],
  },
  {
    file: "annotated-framed-1672.png",
    sha256:
      "5da97d8d264448b530fe55dda3398cc57266ab4ee493cfad8248a147efa0c31e",
    width: 1672,
    height: 941,
    columns: [
      [0, 315],
      [310, 625],
      [610, 940],
      [930, 1280],
    ],
    rows: [
      [70, 270],
      [255, 440],
      [435, 625],
      [620, 835],
    ],
    visiblePeakCounts: [
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 10, 12,
      13, 15, 17, 18,
    ],
  },
  {
    file: "annotated-open-1280.png",
    sha256:
      "cf07a67d95b46789d24b97565aeea79dd1f01d40e0be2f73f6691410ed6bd54c",
    width: 1280,
    height: 720,
    columns: [
      [25, 245],
      [270, 495],
      [510, 745],
      [755, 990],
    ],
    rows: [
      [65, 210],
      [210, 350],
      [350, 495],
      [495, 655],
    ],
    visiblePeakCounts: [
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 10, 12,
      13, 15, 17, 18,
    ],
  },
];

function centerOf(panel) {
  return {
    x: panel.left + panel.width / 2,
    y: panel.top + panel.height / 2,
  };
}

function matchingCellIndex(panel, fixture) {
  const center = centerOf(panel);
  const column = fixture.columns.findIndex(
    ([left, right]) => center.x >= left && center.x <= right,
  );
  const row = fixture.rows.findIndex(
    ([top, bottom]) => center.y >= top && center.y <= bottom,
  );
  return row >= 0 && column >= 0 ? row * 4 + column : -1;
}

function plateauMaximumRange(profile, index) {
  if (index <= 0 || index >= profile.length - 1) return null;
  let left = index;
  let right = index;
  while (
    left > 0 &&
    Math.abs(profile[left - 1] - profile[index]) <= 1e-6
  ) {
    left -= 1;
  }
  while (
    right + 1 < profile.length &&
    Math.abs(profile[right + 1] - profile[index]) <= 1e-6
  ) {
    right += 1;
  }
  if (
    left === 0 ||
    right === profile.length - 1 ||
    profile[index] < 0.04 ||
    profile[index] <= profile[left - 1] + 1e-6 ||
    profile[index] <= profile[right + 1] + 1e-6
  ) {
    return null;
  }
  return [left, right];
}

function assertDescriptorTopology(
  descriptor,
  profileInput,
  expectedPeakCount,
  context,
) {
  const profile = movingAverage(resample(profileInput), 2);
  const peakCount = descriptor.peakLocations.length;
  const valleyCount = descriptor.valleyLocations.length;

  assert.equal(
    peakCount,
    expectedPeakCount,
    `${context}: count visible arches from pixels, not the State Count caption`,
  );
  assert.equal(
    descriptor.stateCount,
    peakCount,
    `${context}: State count and materialized peaks must match`,
  );
  assert.equal(
    descriptor.peakWidths.length,
    peakCount,
    `${context}: every peak needs exactly one width`,
  );
  assert.equal(
    valleyCount,
    peakCount - 1,
    `${context}: ${peakCount} peaks require ${peakCount - 1} adjacent valleys`,
  );
  for (const [field, values] of [
    ["valleyHeights", descriptor.valleyHeights],
    ["valleyDepths", descriptor.valleyDepths],
    ["valleyPositionRatios", descriptor.valleyPositionRatios],
  ]) {
    assert.equal(
      values.length,
      valleyCount,
      `${context}: ${field} must have one value per adjacent valley`,
    );
  }
  assert.equal(
    descriptor.peakValleyDistances.length,
    valleyCount * 2,
    `${context}: every valley needs a distance to both neighbouring peaks`,
  );
  assert.equal(
    descriptor.tailSlopes.length,
    2,
    `${context}: both outer tails must be described`,
  );
  assert.equal(
    descriptor.observedStateCount,
    expectedPeakCount,
    `${context}: every returned peak must be independently observed`,
  );
  assert.equal(
    descriptor.regularized,
    false,
    `${context}: physical topology must not contain a regularized or invented peak`,
  );
  assert.ok(
    descriptor.peakWidths.every((width) => width > 0),
    `${context}: every materialized peak must have positive width`,
  );
  assert.ok(
    descriptor.peakLocations.every(
      (location, index, locations) =>
        location > 0 &&
        location < 1 &&
        (index === 0 || location > locations[index - 1]),
    ),
    `${context}: peak positions must be strictly increasing and interior`,
  );

  const measuredPeakRanges = descriptor.peakLocations.map(
    (location, index) => {
      const sample = Math.round(
        location * (profile.length - 1),
      );
      const range = plateauMaximumRange(profile, sample);
      assert.ok(
        range,
        `${context}: peak ${index + 1} at sample ${sample} must be a measured local maximum`,
      );
      return range;
    },
  );
  for (
    let index = 1;
    index < measuredPeakRanges.length;
    index += 1
  ) {
    assert.ok(
      measuredPeakRanges[index - 1][1] <
        measuredPeakRanges[index][0],
      `${context}: peaks ${index} and ${index + 1} must anchor to distinct measured maxima`,
    );
  }

  for (let index = 0; index < valleyCount; index += 1) {
    assert.ok(
      descriptor.peakLocations[index] <
        descriptor.valleyLocations[index] &&
        descriptor.valleyLocations[index] <
          descriptor.peakLocations[index + 1],
      `${context}: valley ${index + 1} must lie strictly between its adjacent peaks`,
    );
    assert.ok(
      descriptor.valleyPositionRatios[index] > 0 &&
        descriptor.valleyPositionRatios[index] < 1,
      `${context}: valley ${index + 1} must have a strict interior position ratio`,
    );
    assert.ok(
      descriptor.valleyDepths[index] > 1e-6,
      `${context}: valley ${index + 1} must have positive measured depth`,
    );

    const leftPeak = Math.round(
      descriptor.peakLocations[index] *
        (profile.length - 1),
    );
    const rightPeak = Math.round(
      descriptor.peakLocations[index + 1] *
        (profile.length - 1),
    );
    const valley = Math.round(
      descriptor.valleyLocations[index] *
        (profile.length - 1),
    );
    const measuredMinimum = Math.min(
      ...profile.slice(leftPeak + 1, rightPeak),
    );
    assert.ok(
      Math.abs(profile[valley] - measuredMinimum) <= 1e-6,
      `${context}: valley ${index + 1} must be the measured minimum between its adjacent peaks`,
    );
  }
}

for (const fixture of FIXTURES) {
  test(`${fixture.file}: preserves strict physical peak/valley topology for every row-major waveform panel`, async () => {
    const bytes = await readFile(
      new URL(
        `./fixtures/state-count-sweep/${fixture.file}`,
        import.meta.url,
      ),
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    const decoded = decodePng(bytes);

    assert.equal(digest, fixture.sha256);
    assert.equal(decoded.width, fixture.width);
    assert.equal(decoded.height, fixture.height);

    const detection = detectChartPanels(
      decoded.data,
      decoded.width,
      decoded.height,
      decoded.channels,
    );
    assert.equal(detection.fallbackUsed, false);
    assert.equal(detection.truncated, false);
    assert.equal(
      detection.panels.length,
      16,
      `${fixture.file}: expected 16 distribution charts, received ${detection.panels.length}`,
    );
    assert.deepEqual(detection.layout, {
      rows: 4,
      columns: 4,
    });

    const matchedCells = detection.panels.map((panel) =>
      matchingCellIndex(panel, fixture),
    );
    const analyzedPeakCounts = Array(16).fill(null);
    assert.deepEqual(
      [...matchedCells].sort((left, right) => left - right),
      Array.from({ length: 16 }, (_value, index) => index),
      `${fixture.file}: every 4 × 4 waveform cell must be detected once and right-side prose/table/trend content must be excluded`,
    );

    for (const [panelIndex, panel] of detection.panels.entries()) {
      const cropped = cropInterleavedPixels(
        decoded.data,
        decoded.width,
        decoded.height,
        decoded.channels,
        panel,
      );
      const foreground = buildForegroundMasks(
        cropped.pixels,
        cropped.width,
        cropped.height,
        cropped.channels,
      );
      const analysis = analyzeForegroundMasks(
        foreground.broadMask,
        foreground.salientMask,
        cropped.width,
        cropped.height,
        foreground.curveSalientMask,
        foreground.curveColorMasks,
      );
      const matchedCell = matchedCells[panelIndex];
      const expectedPeakCount =
        fixture.visiblePeakCounts[matchedCell];
      analyzedPeakCounts[matchedCell] =
        analysis.descriptor.peakLocations.length;
      assertDescriptorTopology(
        analysis.descriptor,
        analysis.profile,
        expectedPeakCount,
        `${fixture.file}/cell-${matchedCell + 1}`,
      );
    }
    assert.deepEqual(
      analyzedPeakCounts,
      fixture.visiblePeakCounts,
      `${fixture.file}: all 16 row-major physical peak counts must match the drawn arches`,
    );
  });
}
