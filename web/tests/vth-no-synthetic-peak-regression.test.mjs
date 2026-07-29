import assert from "node:assert/strict";
import test from "node:test";

import {
  descriptorFromProfile,
  movingAverage,
  resample,
} from "../lib/vth-shape-core.mjs";

function gaussianProfile(centers, sigma = 4, amplitudes = []) {
  const profile = Array(256).fill(0.01);
  for (
    let centerIndex = 0;
    centerIndex < centers.length;
    centerIndex += 1
  ) {
    const center = centers[centerIndex];
    const amplitude = amplitudes[centerIndex] ?? 1;
    for (let index = 0; index < profile.length; index += 1) {
      profile[index] = Math.max(
        profile[index],
        0.01 +
          0.99 * amplitude *
            Math.exp(-0.5 * ((index - center) / sigma) ** 2),
      );
    }
  }
  return profile;
}

test("does not extrapolate an eighth peak beyond seven genuine local maxima", () => {
  const profile = gaussianProfile([
    25,
    45,
    65,
    85,
    105,
    125,
    145,
  ]);
  const canonical = movingAverage(resample(profile), 2);
  const descriptor = descriptorFromProfile(profile);

  assert.equal(descriptor.stateCount, 7);
  assert.equal(descriptor.observedStateCount, 7);
  assert.equal(descriptor.peakLocations.length, 7);
  assert.ok(descriptor.peakWidths.every((width) => width > 0));

  for (const location of descriptor.peakLocations) {
    const index = Math.round(
      location * (canonical.length - 1),
    );
    assert.ok(index > 0 && index < canonical.length - 1);
    assert.ok(canonical[index] >= canonical[index - 1]);
    assert.ok(canonical[index] > canonical[index + 1]);
  }

  assert.equal(descriptor.valleyLocations.length, 6);
  for (
    let index = 0;
    index < descriptor.valleyLocations.length;
    index += 1
  ) {
    assert.ok(
      descriptor.valleyLocations[index] >
        descriptor.peakLocations[index],
    );
    assert.ok(
      descriptor.valleyLocations[index] <
        descriptor.peakLocations[index + 1],
    );
    assert.ok(descriptor.valleyPositionRatios[index] > 0);
    assert.ok(descriptor.valleyPositionRatios[index] < 1);
    assert.ok(descriptor.peakValleyDistances[index * 2] > 0);
    assert.ok(
      descriptor.peakValleyDistances[index * 2 + 1] > 0,
    );
  }
});

test("does not promote one low-amplitude noise maximum to an eighth State", () => {
  const descriptor = descriptorFromProfile(
    gaussianProfile(
      [25, 45, 65, 85, 105, 125, 145, 190],
      4,
      [1, 1, 1, 1, 1, 1, 1, 0.06],
    ),
  );
  const peakIndices = descriptor.peakLocations.map((location) =>
    Math.round(location * 255),
  );

  assert.equal(descriptor.stateCount, 7);
  assert.equal(descriptor.observedStateCount, 7);
  assert.equal(peakIndices.length, 7);
  assert.ok(peakIndices.every((index) => index < 170));
});

test("preserves six strong peaks separated by material valleys", () => {
  const centers = [10, 22, 50, 78, 106, 206];
  const descriptor = descriptorFromProfile(
    gaussianProfile(centers, 2.5),
  );

  assert.equal(descriptor.stateCount, centers.length);
  assert.equal(descriptor.observedStateCount, centers.length);
  assert.deepEqual(
    descriptor.peakLocations.map((location) =>
      Math.round(location * 255),
    ),
    centers,
  );
  assert.equal(descriptor.valleyLocations.length, centers.length - 1);
  assert.ok(descriptor.peakWidths.every((width) => width > 0));
});

function outerTurnProfile(valleyHeight) {
  const anchors = [
    [0, 0.05],
    [7, 1],
    [13, valleyHeight],
    [20, 1],
    [32, 0.01],
  ];
  const profile = Array(256).fill(0.01);
  for (let segment = 0; segment < anchors.length - 1; segment += 1) {
    const [leftIndex, leftValue] = anchors[segment];
    const [rightIndex, rightValue] = anchors[segment + 1];
    for (let index = leftIndex; index <= rightIndex; index += 1) {
      const fraction =
        (index - leftIndex) / Math.max(1, rightIndex - leftIndex);
      profile[index] =
        leftValue * (1 - fraction) + rightValue * fraction;
    }
  }
  for (const center of [60, 100, 140, 180, 220]) {
    for (let index = 0; index < profile.length; index += 1) {
      profile[index] = Math.max(
        profile[index],
        0.01 +
          0.99 * Math.exp(-0.5 * ((index - center) / 3) ** 2),
      );
    }
  }
  return profile;
}

test("removes a shallow close turn only at the outer tail", () => {
  const descriptor = descriptorFromProfile(
    outerTurnProfile(0.88),
  );
  const peakIndices = descriptor.peakLocations.map((location) =>
    Math.round(location * 255),
  );

  assert.equal(descriptor.observedStateCount, 7);
  assert.equal(descriptor.stateCount, 6);
  assert.equal(peakIndices.length, 6);
  assert.ok(peakIndices.some((index) => Math.abs(index - 20) <= 1));
  assert.ok(peakIndices.every((index) => Math.abs(index - 7) > 1));
  assert.equal(descriptor.valleyLocations.length, 5);
});

test("preserves a close outer physical State when its valley is material", () => {
  const descriptor = descriptorFromProfile(
    outerTurnProfile(0.42),
  );
  const peakIndices = descriptor.peakLocations.map((location) =>
    Math.round(location * 255),
  );

  assert.equal(descriptor.observedStateCount, 7);
  assert.equal(descriptor.stateCount, 7);
  assert.ok(peakIndices.some((index) => Math.abs(index - 7) <= 1));
  assert.ok(peakIndices.some((index) => Math.abs(index - 20) <= 1));
  assert.equal(descriptor.valleyLocations.length, 6);
});

test("removes the proven boundary turn instead of a weak interior peak", () => {
  const descriptor = descriptorFromProfile(
    gaussianProfile(
      [7, 22, 51, 80, 109, 138, 167, 196, 225],
      2.4,
      [1, 0.95, 1, 1, 0.6, 1, 1, 1, 1],
    ),
  );
  const peakIndices = descriptor.peakLocations.map((location) =>
    Math.round(location * 255),
  );

  assert.equal(descriptor.stateCount, 8);
  assert.equal(descriptor.observedStateCount, 9);
  assert.equal(
    peakIndices.filter((index) => index === 7 || index === 22)
      .length,
    1,
  );
  assert.ok(peakIndices.includes(109));
  assert.equal(descriptor.valleyLocations.length, 7);
});
