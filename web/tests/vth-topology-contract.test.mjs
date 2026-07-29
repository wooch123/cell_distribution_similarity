import assert from "node:assert/strict";
import test from "node:test";

import { buildLearnedCandidate } from "../lib/vth-learning-core.mjs";
import {
  SHARED_TRAINING_CONSENT_VERSION,
  validateSharedTrainingPayload,
} from "../lib/vth-shared-training-core.mjs";
import {
  MAX_STATE_COUNT,
  descriptorFromProfile,
  isValidStateCount,
  tryDescriptorFromPeakHints,
} from "../lib/vth-shape-core.mjs";

function visibleStateProfile(stateCount) {
  const profile = Array(256).fill(0.02);
  const left = 10;
  const right = 245;
  const spacing =
    stateCount === 1 ? 0 : (right - left) / (stateCount - 1);
  const width =
    stateCount === 1 ? 45 : Math.max(4, spacing * 0.38);
  for (let state = 0; state < stateCount; state += 1) {
    const center =
      stateCount === 1 ? 128 : left + state * spacing;
    for (let index = 0; index < profile.length; index += 1) {
      profile[index] = Math.max(
        profile[index],
        0.02 +
          0.98 *
            Math.exp(-0.5 * ((index - center) / width) ** 2),
      );
    }
  }
  return profile;
}

function assertTopology(descriptor, stateCount) {
  const valleyCount = Math.max(0, stateCount - 1);
  assert.equal(descriptor.stateCount, stateCount);
  assert.equal(descriptor.peakLocations.length, stateCount);
  assert.equal(descriptor.peakWidths.length, stateCount);
  assert.equal(descriptor.valleyHeights.length, valleyCount);
  assert.equal(descriptor.valleyLocations.length, valleyCount);
  assert.equal(descriptor.valleyDepths.length, valleyCount);
  assert.equal(descriptor.valleyPositionRatios.length, valleyCount);
  assert.equal(descriptor.peakValleyDistances.length, valleyCount * 2);
  assert.equal(descriptor.tailSlopes.length, 2);
  assert.ok(descriptor.peakWidths.every((width) => width > 0));
  for (let index = 0; index < valleyCount; index += 1) {
    assert.ok(
      descriptor.peakLocations[index] <
        descriptor.peakLocations[index + 1],
    );
    assert.ok(
      descriptor.valleyLocations[index] >
        descriptor.peakLocations[index],
    );
    assert.ok(
      descriptor.valleyLocations[index] <
        descriptor.peakLocations[index + 1],
    );
    assert.ok(
      descriptor.valleyPositionRatios[index] > 0 &&
        descriptor.valleyPositionRatios[index] < 1,
    );
  }
}

test("preserves every visible physical State count from 1 through 20", () => {
  assert.equal(MAX_STATE_COUNT, 20);
  for (
    let stateCount = 1;
    stateCount <= MAX_STATE_COUNT;
    stateCount += 1
  ) {
    assert.equal(isValidStateCount(stateCount), true);
    assertTopology(
      descriptorFromProfile(visibleStateProfile(stateCount)),
      stateCount,
    );
  }
  assert.equal(isValidStateCount(0), false);
  assert.equal(isValidStateCount(21), false);
  assert.equal(isValidStateCount(4.5), false);
});

test("keeps a close interior peak-valley pair as a separate State", () => {
  const centers = [12, 45, 77, 109, 120, 153, 186, 218, 244];
  const profile = Array(256).fill(0.015);
  for (const center of centers) {
    for (let index = 0; index < profile.length; index += 1) {
      profile[index] = Math.max(
        profile[index],
        0.015 +
          0.985 * Math.exp(-0.5 * ((index - center) / 3.2) ** 2),
      );
    }
  }

  const descriptor = descriptorFromProfile(profile);
  assertTopology(descriptor, centers.length);
  assert.ok(
    descriptor.peakLocations[4] - descriptor.peakLocations[3] <
      0.05,
  );
});

test("snaps independent pixel peak hints without replacing the measured profile", () => {
  const profile = visibleStateProfile(7);
  const before = [...profile];
  const expected = descriptorFromProfile(profile);
  const hints = expected.peakLocations.map(
    (location, index) =>
      location + (index % 2 ? -0.004 : 0.004),
  );

  const guided = tryDescriptorFromPeakHints(profile, hints);
  assert.equal(guided.ok, true);
  assert.deepEqual(profile, before);
  assertTopology(guided.descriptor, 7);
  assert.ok(
    guided.snappedLocations.every(
      (location, index) =>
        Math.abs(location - expected.peakLocations[index]) <=
        1 / 255,
    ),
  );
});

test("rejects incomplete or colliding peak hints instead of inventing topology", () => {
  const profile = visibleStateProfile(4);
  assert.deepEqual(
    tryDescriptorFromPeakHints(profile, [0.2, 0.2]),
    { ok: false, reason: "hint_order_invalid" },
  );
  assert.equal(
    tryDescriptorFromPeakHints(profile, [0.47, 0.53]).ok,
    false,
  );
  assert.equal(
    tryDescriptorFromPeakHints(
      Array(256).fill(0.5),
      [0.2, 0.8],
    ).ok,
    false,
  );
});

test("preserves 17 and 18 actual peaks instead of clamping them to a device mode", () => {
  for (const stateCount of [17, 18]) {
    assertTopology(
      descriptorFromProfile(visibleStateProfile(stateCount)),
      stateCount,
    );
  }
});

test("accepts 20 independent actual-pixel peak hints without synthesizing peaks", () => {
  const profile = visibleStateProfile(MAX_STATE_COUNT);
  const measured = descriptorFromProfile(profile);
  const guided = tryDescriptorFromPeakHints(
    profile,
    measured.peakLocations,
  );

  assert.equal(guided.ok, true);
  assertTopology(guided.descriptor, MAX_STATE_COUNT);
  assert.equal(
    tryDescriptorFromPeakHints(
      profile,
      Array.from({ length: MAX_STATE_COUNT + 1 }, (_, index) =>
        index / MAX_STATE_COUNT,
      ),
    ).ok,
    false,
  );
});

test("caps an out-of-contract 21-peak profile to the 20-State physical limit", () => {
  const profile = Array(256).fill(0.01);
  for (let peak = 0; peak < 21; peak += 1) {
    const center = 7 + peak * 12;
    for (let offset = -3; offset <= 3; offset += 1) {
      const index = center + offset;
      if (index < 0 || index >= profile.length) continue;
      profile[index] = Math.max(
        profile[index],
        0.01 + 0.99 * (1 - Math.abs(offset) / 4),
      );
    }
  }

  assertTopology(descriptorFromProfile(profile), MAX_STATE_COUNT);
});

test("learning boundaries accept arbitrary counts and reject topology mismatch", () => {
  const profile = visibleStateProfile(3);
  const descriptor = descriptorFromProfile(profile);
  const candidate = buildLearnedCandidate({
    id: "three-state-visible",
    label: "3-State",
    image: "",
    profile,
    descriptor,
  });
  assert.equal(candidate.stateCount, 3);
  assert.equal(candidate.peakLocations.length, 3);
  assert.equal(candidate.valleyLocations.length, 2);

  assert.throws(
    () =>
      buildLearnedCandidate({
        id: "broken-topology",
        profile,
        descriptor: {
          ...descriptor,
          peakLocations: descriptor.peakLocations.slice(0, 2),
        },
      }),
    /descriptor/,
  );
});

test("shared training validates a 1-State descriptor with zero valleys", () => {
  const profile = visibleStateProfile(1);
  const descriptor = descriptorFromProfile(profile);
  const payload = {
    sharingConsent: true,
    consentVersion: SHARED_TRAINING_CONSENT_VERSION,
    contributorToken: "a".repeat(43),
    deletionToken: "b".repeat(43),
    label: "1-State",
    profile,
    descriptor,
  };

  const validated = validateSharedTrainingPayload(payload);
  assertTopology(validated.descriptor, 1);
  assert.throws(
    () =>
      validateSharedTrainingPayload({
        ...payload,
        descriptor: {
          ...descriptor,
          valleyLocations: [0.5],
        },
      }),
    /valleyLocations 길이/,
  );
});

test("shared training preserves a strict 20-State descriptor", () => {
  const profile = visibleStateProfile(MAX_STATE_COUNT);
  const descriptor = descriptorFromProfile(profile);
  const validated = validateSharedTrainingPayload({
    sharingConsent: true,
    consentVersion: SHARED_TRAINING_CONSENT_VERSION,
    contributorToken: "c".repeat(43),
    deletionToken: "d".repeat(43),
    label: "20-State",
    profile,
    descriptor,
  });

  assertTopology(validated.descriptor, MAX_STATE_COUNT);
});
