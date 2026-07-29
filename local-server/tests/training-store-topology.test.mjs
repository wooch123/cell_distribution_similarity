import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TrainingStore } from "../training-store.mjs";
import { descriptorFromProfile } from "../../web/lib/vth-shape-core.mjs";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2QAAAAASUVORK5CYII=",
  "base64",
);
const tinyPngDataUrl =
  `data:image/png;base64,${tinyPng.toString("base64")}`;

function visibleStateProfile(stateCount) {
  const profile = Array(256).fill(0.02);
  const spacing = 235 / (stateCount - 1);
  const width = Math.max(4, spacing * 0.38);
  for (let state = 0; state < stateCount; state += 1) {
    const center = 10 + state * spacing;
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

test("standalone training store accepts strict 20-peak topology and rejects mismatches", async () => {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "vth-training-topology-"),
  );
  const profile = visibleStateProfile(20);
  const descriptor = descriptorFromProfile(profile);
  const store = await new TrainingStore(dataDirectory, {
    validateReadyImage: async () => ({
      authoritativeProfile: profile,
      authoritativeDescriptor: descriptor,
      profileSimilarity: 1,
    }),
  }).initialize();
  const payload = {
    schemaVersion: 2,
    id: "twenty-state",
    label: "20-State",
    imageDataUrl: tinyPngDataUrl,
    sourceImageDataUrl: tinyPngDataUrl,
    profile,
    descriptor,
  };

  try {
    const created = await store.upsertReady(payload);
    assert.equal(created.stateCount, 20);
    assert.equal(created.peakLocations.length, 20);
    assert.equal(created.valleyLocations.length, 19);
    assert.equal(created.peakValleyDistances.length, 38);
    assert.equal(created.tailSlopes.length, 2);

    await assert.rejects(
      store.upsertReady({
        ...payload,
        id: "missing-valley",
        descriptor: {
          ...descriptor,
          valleyLocations: descriptor.valleyLocations.slice(1),
        },
      }),
      /descriptor/,
    );
    await assert.rejects(
      store.upsertReady({
        ...payload,
        id: "unordered-peak",
        descriptor: {
          ...descriptor,
          peakLocations: descriptor.peakLocations.with(
            1,
            descriptor.peakLocations[0],
          ),
        },
      }),
      /descriptor/,
    );
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
