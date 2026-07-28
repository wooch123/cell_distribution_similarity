import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  descriptorFromProfile,
  searchCorpus,
} from "../lib/vth-shape-core.mjs";

const corpus = JSON.parse(
  await readFile(new URL("../public/corpus-index.json", import.meta.url), "utf8"),
);

test("detects the expected State count for every deployed corpus profile", () => {
  const mismatches = corpus.candidates
    .map((candidate) => ({
      id: candidate.id,
      expected: candidate.stateCount,
      detected: descriptorFromProfile(candidate.profile).stateCount,
    }))
    .filter((result) => result.expected !== result.detected);

  assert.deepEqual(mismatches, []);
});

test("retrieves exact profiles within Top-5 or their exact-shape tie group", () => {
  let topOneMatches = 0;
  let baselineCount = 0;
  let exactShapeMatches = 0;
  for (const candidate of corpus.candidates) {
    const descriptor = descriptorFromProfile(candidate.profile);
    const ranked = searchCorpus(
      candidate.profile,
      descriptor,
      corpus.candidates,
      corpus.reranker,
    );

    assert.equal(
      ranked.length,
      corpus.candidates.filter(
        (result) => result.stateCount === candidate.stateCount,
      ).length,
    );
    const candidateProfile = JSON.stringify(candidate.profile);
    const identicalProfileCount = corpus.candidates.filter(
      (result) => JSON.stringify(result.profile) === candidateProfile,
    ).length;
    if (JSON.stringify(ranked[0].profile) === candidateProfile) {
      exactShapeMatches += 1;
    }
    if (!candidate.id.startsWith("vnand-fault-")) {
      baselineCount += 1;
      if (ranked[0].id === candidate.id) topOneMatches += 1;
    }
    assert.ok(
      ranked.find((result) => result.id === candidate.id).rank <=
        Math.max(5, identicalProfileCount),
    );
    assert.ok(ranked.slice(0, 10).every((result) => result.reasons.length >= 1));
    assert.ok(
      ranked.every((result) => result.stateCount === candidate.stateCount),
    );
  }
  assert.ok(topOneMatches / baselineCount >= 0.98);
  assert.ok(exactShapeMatches / corpus.candidateCount >= 0.98);
});

test("applies the validated reranker and retrieval score calibration", () => {
  const candidate = corpus.candidates[0];
  const ranked = searchCorpus(
    candidate.profile,
    descriptorFromProfile(candidate.profile),
    [candidate],
    corpus.reranker,
  );

  assert.deepEqual(corpus.reranker.scoreCalibration, {
    reranked: 0.7,
    retrieval: 0.3,
  });
  assert.ok(
    Math.abs(
      ranked[0].score -
        (0.7 * ranked[0].rerankedScore + 0.3 * ranked[0].retrievalScore),
    ) < 1e-12,
  );
});

test("keeps one full-corpus browser search within the local latency budget", () => {
  const candidate = corpus.candidates[Math.floor(corpus.candidates.length / 2)];
  const descriptor = descriptorFromProfile(candidate.profile);
  const durations = [];
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const start = performance.now();
    searchCorpus(
      candidate.profile,
      descriptor,
      corpus.candidates,
      corpus.reranker,
    );
    durations.push(performance.now() - start);
  }
  durations.sort((left, right) => left - right);
  const median = durations[Math.floor(durations.length / 2)];
  assert.ok(median < 250, `median search latency was ${median.toFixed(1)} ms`);
});

test("collapses dense measured marker subpeaks into four physical States", () => {
  const profile = Array(256).fill(0.08);
  const markerSubpeaks = [10, 20, 67, 84, 94, 172, 181, 252];
  for (const center of markerSubpeaks) {
    for (let offset = -5; offset <= 5; offset += 1) {
      const index = center + offset;
      if (index < 0 || index >= profile.length) continue;
      profile[index] = Math.max(profile[index], 0.85 - Math.abs(offset) * 0.11);
    }
  }

  assert.equal(descriptorFromProfile(profile).stateCount, 4);
});

test("uses the best Curve hypothesis for candidate reranking", () => {
  const candidate = corpus.candidates.find(
    (item) => item.stateCount === 4,
  );
  assert.ok(candidate);
  const descriptor = descriptorFromProfile(candidate.profile);
  const ranked = searchCorpus(
    Array(256).fill(0),
    descriptor,
    corpus.candidates,
    corpus.reranker,
    [{ profile: candidate.profile, descriptor }],
  );

  assert.equal(ranked[0].id, candidate.id);
  assert.equal(ranked[0].curveHypothesisIndex, 1);
});

test("uses one coherent artifact-rescue hypothesis for the whole ranking", () => {
  const candidate = corpus.candidates.find(
    (item) => item.stateCount === 8,
  );
  assert.ok(candidate);
  const descriptor = descriptorFromProfile(candidate.profile);
  const ranked = searchCorpus(
    Array(256).fill(0),
    descriptor,
    corpus.candidates,
    corpus.reranker,
    [
      {
        profile: candidate.profile,
        descriptor,
        artifactRescue: true,
      },
    ],
    corpus.dualEncoder,
  );

  assert.equal(ranked[0].id, candidate.id);
  assert.equal(ranked[0].curveHypothesisIndex, 1);
  assert.equal(ranked[0].artifactRescueReranked, true);
  assert.ok(
    ranked.every((result) => result.curveHypothesisIndex === 1),
  );
});

test("selects one State count when Curve hypotheses disagree", () => {
  const fourState = corpus.candidates.find(
    (item) => item.stateCount === 4,
  );
  const eightState = corpus.candidates.find(
    (item) => item.stateCount === 8,
  );
  assert.ok(fourState);
  assert.ok(eightState);
  const ranked = searchCorpus(
    fourState.profile,
    descriptorFromProfile(fourState.profile),
    corpus.candidates,
    corpus.reranker,
    [
      {
        profile: eightState.profile,
        descriptor: descriptorFromProfile(eightState.profile),
      },
    ],
  );
  const expectedPool = corpus.candidates.filter(
    (candidate) => candidate.stateCount === 4,
  );

  assert.equal(ranked.length, expectedPool.length);
  assert.ok(!ranked.some((candidate) => candidate.id === eightState.id));
  assert.ok(ranked.every((candidate) => candidate.stateCount === 4));
});

test("does not change State count without a strong artifact-rescue margin", () => {
  const fourState = corpus.candidates.find(
    (item) => item.stateCount === 4,
  );
  const eightState = corpus.candidates.find(
    (item) => item.stateCount === 8,
  );
  assert.ok(fourState);
  assert.ok(eightState);
  const ranked = searchCorpus(
    fourState.profile,
    descriptorFromProfile(fourState.profile),
    corpus.candidates,
    corpus.reranker,
    [
      {
        profile: eightState.profile,
        descriptor: descriptorFromProfile(eightState.profile),
        artifactRescue: true,
      },
    ],
    corpus.dualEncoder,
  );

  assert.ok(ranked.every((candidate) => candidate.stateCount === 4));
  assert.ok(
    ranked.every((candidate) => candidate.artifactRescueReranked !== true),
  );
});

test("keeps seven strong peaks with fifteen candidates as partial TLC", () => {
  const profile = Array(256).fill(0.1);
  for (let peakNumber = 0; peakNumber < 15; peakNumber += 1) {
    const center = 12 + peakNumber * 16;
    const prominence = peakNumber < 7 ? 0.16 : 0.025;
    for (let offset = -3; offset <= 3; offset += 1) {
      const index = center + offset;
      profile[index] = Math.max(
        profile[index],
        0.1 + prominence * (1 - Math.abs(offset) / 4),
      );
    }
  }

  const descriptor = descriptorFromProfile(profile);
  assert.equal(descriptor.observedStateCount, 7);
  assert.equal(descriptor.stateCount, 8);
});

function eightStateProfile(valleyHeight, weakLastThree = false) {
  const profile = Array(256).fill(valleyHeight);
  let peakNumber = 0;
  for (let center = 20; center <= 230; center += 30) {
    const amplitude =
      weakLastThree && peakNumber >= 5 ? 0.035 : 1 - valleyHeight;
    for (let offset = -10; offset <= 10; offset += 1) {
      const index = center + offset;
      profile[index] = Math.max(
        profile[index],
        valleyHeight + amplitude * (1 - Math.abs(offset) / 11),
      );
    }
    peakNumber += 1;
  }
  return profile;
}

function shapeCandidate(id, profile) {
  const descriptor = descriptorFromProfile(profile);
  return {
    id,
    label: id,
    image: `/${id}.png`,
    profile,
    family: "balanced",
    ...descriptor,
  };
}

test("preserves eight evenly spaced States when valleys are shallow", () => {
  const descriptor = descriptorFromProfile(
    eightStateProfile(0.86, true),
  );

  assert.equal(descriptor.observedStateCount, 5);
  assert.equal(descriptor.stateCount, 8);
  assert.equal(descriptor.valleyDepths.length, 7);
  assert.equal(descriptor.peakValleyDistances.length, 14);
  assert.ok(Math.max(...descriptor.valleyDepths) < 0.15);
});

test("promotes candidates with matching shallow peak-valley relations", () => {
  const queryProfile = eightStateProfile(0.88);
  const queryDescriptor = descriptorFromProfile(queryProfile);
  const shallow = shapeCandidate(
    "shallow-overlap",
    eightStateProfile(0.84),
  );
  const deep = shapeCandidate("deep-valleys", eightStateProfile(0.2));

  const ranked = searchCorpus(
    queryProfile,
    queryDescriptor,
    [deep, shallow],
  );

  assert.equal(ranked[0].id, shallow.id);
  assert.ok(ranked[0].peakValleyScore > ranked[1].peakValleyScore + 0.2);
  assert.equal(ranked[0].peakValleyWeight, 0.18);
  assert.ok(
    ranked[0].reasons.some((reason) => reason.includes("얕은 valley")),
  );
});
