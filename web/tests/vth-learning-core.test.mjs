import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLearnedCandidate,
  buildSharedTrainingApiPayload,
  buildTrainingApiPayload,
  chooseRandomDemoCandidate,
  deleteLearnedCandidateSelection,
  deletableLearnedCandidateIds,
  filterSelectedTrainingUnits,
  mergeCandidateSets,
  normalizeTrainingSourceSelection,
  trainingSourceSelection,
} from "../lib/vth-learning-core.mjs";
import {
  canonicalShapeFingerprintInput,
  decodeSharedCandidateCursor,
  encodeSharedCandidateCursor,
  fetchAllSharedTrainingCandidates,
  isAllowedSharedTrainingOrigin,
  MAX_SHARED_CANDIDATES,
  renderStandardizedCurveSvg,
  SHARED_TRAINING_CONSENT_VERSION,
  validateSharedTrainingPayload,
} from "../lib/vth-shared-training-core.mjs";
import { descriptorFromProfile } from "../lib/vth-shape-core.mjs";

const profile = Array(256).fill(0.2);
for (let center = 20; center <= 230; center += 30) {
  for (let offset = -10; offset <= 10; offset += 1) {
    const index = center + offset;
    profile[index] = Math.max(
      profile[index],
      0.2 + 0.8 * (1 - Math.abs(offset) / 11),
    );
  }
}
const descriptor = descriptorFromProfile(profile);
assert.equal(descriptor.stateCount, 8);

test("chooses a different random demo when alternatives exist", () => {
  const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const selected = chooseRandomDemoCandidate(candidates, "a", 0);
  assert.equal(selected.id, "b");
  assert.equal(chooseRandomDemoCandidate([{ id: "a" }], "a", 0).id, "a");
});

test("builds a validated learned candidate and API payload", () => {
  const sourceSelection = {
    panelIndex: 1,
    panelCount: 3,
    seriesIndex: 0,
    seriesCount: 2,
  };
  const candidate = buildLearnedCandidate({
    id: "user-123",
    label: "Retention sample",
    image: "blob:test",
    sourceImage: "blob:source",
    profile,
    descriptor,
    learnedAt: "2026-07-27T00:00:00.000Z",
    sourceSelection,
  });
  const payload = buildTrainingApiPayload(
    candidate,
    "data:image/png;base64,AA==",
    "data:image/jpeg;base64,/9j/2Q==",
  );

  assert.equal(candidate.learned, true);
  assert.equal(candidate.family, "learned");
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.profile.length, 256);
  assert.equal(payload.descriptor.stateCount, 8);
  assert.equal(payload.imageDataUrl, "data:image/png;base64,AA==");
  assert.equal(payload.sourceImageDataUrl, "data:image/jpeg;base64,/9j/2Q==");
  assert.equal(candidate.sourceImage, "blob:source");
  assert.deepEqual(candidate.sourceSelection, sourceSelection);
  assert.deepEqual(payload.sourceSelection, sourceSelection);
});

test("builds and validates a consented shared training payload", () => {
  const selectedSeries = {
    profile,
    descriptor,
    trainingSelection: {
      panelIndex: 2,
      panelCount: 4,
      seriesIndex: 1,
      seriesCount: 3,
    },
  };
  const candidate = buildLearnedCandidate({
    id: "shared-pending-test",
    label: "공용 Retention 분포",
    image: "",
    profile: selectedSeries.profile,
    descriptor: selectedSeries.descriptor,
    storage: "shared",
    sourceSelection: selectedSeries.trainingSelection,
  });
  const token = "a".repeat(43);
  const payload = buildSharedTrainingApiPayload(
    candidate,
    selectedSeries.descriptor,
    {
      contributorToken: token,
      deletionToken: "b".repeat(43),
      consentVersion: SHARED_TRAINING_CONSENT_VERSION,
    },
  );
  const validated = validateSharedTrainingPayload(payload);

  assert.equal(validated.schemaVersion, 2);
  assert.equal(validated.label, "공용 Retention 분포");
  assert.equal(validated.profile.length, 256);
  assert.equal(validated.descriptor.peakLocations.length, 8);
  assert.equal(validated.descriptor.valleyDepths.length, 7);
  assert.deepEqual(payload.profile, selectedSeries.profile);
  assert.deepEqual(payload.descriptor, selectedSeries.descriptor);
  assert.deepEqual(
    payload.sourceSelection,
    selectedSeries.trainingSelection,
  );
  assert.deepEqual(
    validated.sourceSelection,
    selectedSeries.trainingSelection,
  );
  assert.equal(payload.consentVersion, SHARED_TRAINING_CONSENT_VERSION);
  assert.equal(candidate.shared, true);
  assert.equal(
    canonicalShapeFingerprintInput(profile, 8),
    canonicalShapeFingerprintInput([...profile], 8),
  );
  const svg = renderStandardizedCurveSvg(validated.profile);
  assert.match(svg, /^<\?xml/);
  assert.match(svg, /<polyline points="/);
  assert.doesNotMatch(svg, /Retention|script|foreignObject/);
});

test("normalizes strict source selections and filters flattened training units", () => {
  const selection = trainingSourceSelection({
    panelIndex: 1,
    panelCount: 3,
    seriesIndex: 2,
    seriesCount: 4,
  });
  assert.deepEqual(selection, {
    panelIndex: 1,
    panelCount: 3,
    seriesIndex: 2,
    seriesCount: 4,
  });
  assert.deepEqual(
    filterSelectedTrainingUnits(
      [
        { analysis: { id: "first" } },
        { analysis: { id: "second" } },
        { analysis: { id: "third" } },
      ],
      new Set(["third", "first"]),
    ).map((unit) => unit.analysis.id),
    ["first", "third"],
  );
  assert.deepEqual(filterSelectedTrainingUnits([], new Set(["first"])), []);
  assert.deepEqual(
    filterSelectedTrainingUnits(
      [{ analysis: { id: "first" } }],
      new Set(),
    ),
    [],
  );

  for (const invalid of [
    null,
    {
      panelIndex: "0",
      panelCount: 1,
      seriesIndex: 0,
      seriesCount: 1,
    },
    {
      panelIndex: 1,
      panelCount: 1,
      seriesIndex: 0,
      seriesCount: 1,
    },
    {
      panelIndex: 0,
      panelCount: 31,
      seriesIndex: 0,
      seriesCount: 1,
    },
    {
      panelIndex: 0,
      panelCount: 1,
      seriesIndex: 1,
      seriesCount: 1,
    },
    {
      panelIndex: 0,
      panelCount: 1,
      seriesIndex: 0,
      seriesCount: 1,
      panelId: "unsupported",
    },
  ]) {
    assert.throws(
      () => normalizeTrainingSourceSelection(invalid),
      (error) => {
        assert.equal(error.code, "invalid_source_selection");
        assert.equal(error.status, 400);
        assert.ok(error.details.field.startsWith("sourceSelection"));
        return true;
      },
    );
  }
  assert.equal(normalizeTrainingSourceSelection(undefined), undefined);
});

test("shared training rejects unconsented or malformed profiles", () => {
  const base = {
    sharingConsent: true,
    consentVersion: SHARED_TRAINING_CONSENT_VERSION,
    contributorToken: "a".repeat(43),
    deletionToken: "b".repeat(43),
    profile,
    descriptor,
  };
  assert.throws(
    () => validateSharedTrainingPayload({ ...base, sharingConsent: false }),
    /공유 동의/,
  );
  assert.throws(
    () =>
      validateSharedTrainingPayload({
        ...base,
        profile: Array(255).fill(0.5),
      }),
    /profile 길이/,
  );
  const legacy = validateSharedTrainingPayload({
    ...base,
    consentVersion: "2026-07-28-v2",
  });
  assert.equal(legacy.consentVersion, "2026-07-28-v2");
  assert.equal(legacy.sourceSelection, undefined);
  assert.throws(
    () =>
      validateSharedTrainingPayload({
        ...base,
        consentVersion: "2026-07-28-v2",
        sourceSelection: {
          panelIndex: 0,
          panelCount: 1,
          seriesIndex: 0,
          seriesCount: 1,
        },
      }),
    /동의 버전/,
  );
});

test("shared training CORS allowlist is restricted to local origins", () => {
  assert.equal(
    isAllowedSharedTrainingOrigin("http://127.0.0.1:4173"),
    true,
  );
  assert.equal(isAllowedSharedTrainingOrigin("http://localhost:4173"), true);
  assert.equal(isAllowedSharedTrainingOrigin("https://attacker.test"), false);
});

test("shared candidate cursor round-trips and rejects tampering", () => {
  const createdAt = "2026-07-27 12:34:56";
  const candidateId = "shared-12345678-1234-4abc-8def-123456789abc";
  const cursor = encodeSharedCandidateCursor(createdAt, candidateId);

  assert.doesNotMatch(cursor, /[+/=]/);
  assert.deepEqual(decodeSharedCandidateCursor(cursor), {
    createdAt,
    candidateId,
  });
  assert.throws(
    () => decodeSharedCandidateCursor(`${cursor.slice(0, -1)}!`),
    /cursor/,
  );
  assert.throws(
    () =>
      decodeSharedCandidateCursor(
        btoa(JSON.stringify(["v1", createdAt, "shared-not-a-uuid"])),
      ),
    /cursor/,
  );
});

test("loads all 2,000 shared candidates across keyset pages", async () => {
  const candidates = Array.from(
    { length: MAX_SHARED_CANDIDATES },
    (_, index) => ({ id: `candidate-${String(index).padStart(4, "0")}` }),
  );
  let calls = 0;
  const collection = await fetchAllSharedTrainingCandidates({
    endpoint: "http://127.0.0.1:4173/api/v1/shared-training-samples",
    fetchImpl: async (input) => {
      calls += 1;
      const url = new URL(input);
      const offset = Number(url.searchParams.get("cursor") || 0);
      const limit = Number(url.searchParams.get("limit"));
      const page = candidates.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        ok: true,
        json: async () => ({
          candidateCount: candidates.length,
          candidates: page,
          nextCursor:
            nextOffset < candidates.length ? String(nextOffset) : null,
        }),
      };
    },
  });

  assert.equal(calls, 4);
  assert.equal(collection.pages, 4);
  assert.equal(collection.candidateCount, MAX_SHARED_CANDIDATES);
  assert.deepEqual(collection.candidates, candidates);
});

test("shared page loader rejects repeated cursors, duplicates, and gaps", async () => {
  let repeatedCursorPage = 0;
  await assert.rejects(
    fetchAllSharedTrainingCandidates({
      endpoint: "https://example.test/candidates",
      retries: 0,
      pageSize: 1,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          candidateCount: 3,
          candidates: [{ id: `page-${repeatedCursorPage++}` }],
          nextCursor: "repeat-cursor",
        }),
      }),
    }),
    /반복/,
  );

  let duplicatePage = 0;
  await assert.rejects(
    fetchAllSharedTrainingCandidates({
      endpoint: "https://example.test/candidates",
      retries: 0,
      pageSize: 1,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          candidateCount: 2,
          candidates: [{ id: "duplicate" }],
          nextCursor: duplicatePage++ === 0 ? "second-page" : null,
        }),
      }),
    }),
    /중복 ID/,
  );

  await assert.rejects(
    fetchAllSharedTrainingCandidates({
      endpoint: "https://example.test/candidates",
      retries: 0,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          candidateCount: 2,
          candidates: [{ id: "only-one" }],
          nextCursor: null,
        }),
      }),
    }),
    /완전하지/,
  );
});

test("rejects malformed learned candidates", () => {
  assert.throws(
    () =>
      buildLearnedCandidate({
        id: "bad",
        profile: [0, 1],
        descriptor,
      }),
    /256-point/,
  );
});

test("merges learned candidates by stable id", () => {
  const merged = mergeCandidateSets(
    [{ id: "base", value: 1 }],
    [{ id: "learned", value: 2 }],
    [{ id: "learned", value: 3 }],
  );
  assert.deepEqual(merged, [
    { id: "base", value: 1 },
    { id: "learned", value: 3 },
  ]);
});

test("preserves deletion authority when a panel shape is deduplicated", () => {
  const [candidate] = mergeCandidateSets(
    [],
    [{ id: "same-shape", label: "first panel", canDelete: true }],
    [{ id: "same-shape", label: "second panel", canDelete: false }],
  );
  assert.equal(candidate.label, "second panel");
  assert.equal(candidate.canDelete, true);
});

test("selects only deletable learned candidates for data management", () => {
  assert.deepEqual(
    deletableLearnedCandidateIds([
      { id: "owned-shared", learned: true, canDelete: true },
      { id: "read-only-shared", learned: true, canDelete: false },
      { id: "base", learned: false, canDelete: true },
      { id: "local", learned: true, canDelete: true },
    ]),
    ["owned-shared", "local"],
  );
  assert.deepEqual(deletableLearnedCandidateIds(null), []);
});

test("selective learned-data deletion continues after an item fails", async () => {
  const attempted = [];
  const progress = [];
  const deletion = await deleteLearnedCandidateSelection(
    ["first", "second", "first", "third"],
    async (candidateId) => {
      attempted.push(candidateId);
      if (candidateId === "second") throw new Error("token mismatch");
    },
    (event) => progress.push(event),
  );

  assert.deepEqual(attempted, ["first", "second", "third"]);
  assert.deepEqual(deletion.successes, ["first", "third"]);
  assert.deepEqual(deletion.failures, [
    { candidateId: "second", message: "token mismatch" },
  ]);
  assert.deepEqual(progress.at(-1), {
    candidateId: "",
    completed: 3,
    total: 3,
  });
});
