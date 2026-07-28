const VALID_STATE_COUNTS = new Set([2, 4, 8, 16]);

function copyNumberArray(value, expectedLength = null) {
  if (!Array.isArray(value)) return null;
  const copied = value.map(Number);
  if (
    copied.some((item) => !Number.isFinite(item)) ||
    (expectedLength !== null && copied.length !== expectedLength)
  ) {
    return null;
  }
  return copied;
}

export function chooseRandomDemoCandidate(
  candidates,
  previousId = "",
  randomValue = Math.random(),
) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const eligible =
    candidates.length > 1
      ? candidates.filter((candidate) => candidate.id !== previousId)
      : candidates;
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(0.999999999, Math.max(0, randomValue))
    : 0;
  return eligible[Math.floor(normalizedRandom * eligible.length)];
}

export function buildLearnedCandidate(input) {
  const {
    id,
    label,
    image,
    sourceImage,
    profile,
    learnedAt = new Date().toISOString(),
    storage = "browser",
    canDelete = false,
  } = input;
  const descriptor = input.descriptor ?? input;
  const safeProfile = copyNumberArray(profile, 256);
  const stateCount = Number(descriptor?.stateCount);
  if (!id || !safeProfile || !VALID_STATE_COUNTS.has(stateCount)) {
    throw new Error("학습 후보의 ID, 256-point Curve 또는 State가 올바르지 않습니다.");
  }

  const peakLocations = copyNumberArray(descriptor.peakLocations);
  const peakWidths = copyNumberArray(descriptor.peakWidths);
  const valleyHeights = copyNumberArray(descriptor.valleyHeights);
  const valleyLocations = copyNumberArray(descriptor.valleyLocations);
  const valleyDepths = copyNumberArray(descriptor.valleyDepths);
  const valleyPositionRatios = copyNumberArray(
    descriptor.valleyPositionRatios,
  );
  const peakValleyDistances = copyNumberArray(
    descriptor.peakValleyDistances,
  );
  const tailSlopes = copyNumberArray(descriptor.tailSlopes);
  const area = Number(descriptor.area);
  if (
    [
      peakLocations,
      peakWidths,
      valleyHeights,
      valleyLocations,
      valleyDepths,
      valleyPositionRatios,
      peakValleyDistances,
      tailSlopes,
    ].some((value) => value === null) ||
    !Number.isFinite(area)
  ) {
    throw new Error("학습 후보의 Curve descriptor가 올바르지 않습니다.");
  }

  return {
    id: String(id),
    label: String(label || id).slice(0, 120),
    image: String(image || ""),
    sourceImage: sourceImage ? String(sourceImage) : undefined,
    profile: safeProfile,
    stateCount,
    family: "learned",
    peakLocations,
    peakWidths,
    valleyHeights,
    valleyLocations,
    valleyDepths,
    valleyPositionRatios,
    peakValleyDistances,
    tailSlopes,
    area,
    learned: true,
    learnedAt,
    storage,
    shared: storage === "shared",
    canDelete: Boolean(canDelete),
  };
}

export function buildTrainingApiPayload(
  candidate,
  imageDataUrl,
  sourceImageDataUrl,
) {
  if (!candidate?.learned) {
    throw new Error("학습 후보만 API payload로 변환할 수 있습니다.");
  }
  return {
    schemaVersion: 2,
    id: candidate.id,
    label: candidate.label,
    imageDataUrl,
    sourceImageDataUrl: String(sourceImageDataUrl || ""),
    profile: [...candidate.profile],
    descriptor: {
      stateCount: candidate.stateCount,
      observedStateCount: candidate.stateCount,
      regularized: false,
      peakLocations: [...candidate.peakLocations],
      peakWidths: [...candidate.peakWidths],
      valleyHeights: [...candidate.valleyHeights],
      valleyLocations: [...candidate.valleyLocations],
      valleyDepths: [...candidate.valleyDepths],
      valleyPositionRatios: [...candidate.valleyPositionRatios],
      peakValleyDistances: [...candidate.peakValleyDistances],
      tailSlopes: [...candidate.tailSlopes],
      area: candidate.area,
    },
    metadata: {
      learnedAt: candidate.learnedAt,
      source: "vth-browser-ui",
    },
  };
}

export function buildSharedTrainingApiPayload(
  candidate,
  descriptor,
  {
    contributorToken,
    deletionToken,
    consentVersion,
  },
) {
  if (!candidate?.learned || candidate.profile.length !== 256) {
    throw new Error("검증된 학습 후보가 필요합니다.");
  }
  return {
    schemaVersion: 2,
    label: candidate.label,
    profile: [...candidate.profile],
    descriptor: {
      stateCount: candidate.stateCount,
      observedStateCount:
        descriptor?.observedStateCount ?? candidate.stateCount,
      regularized: Boolean(descriptor?.regularized),
      peakLocations: [...candidate.peakLocations],
      peakWidths: [...candidate.peakWidths],
      valleyHeights: [...candidate.valleyHeights],
      valleyLocations: [...candidate.valleyLocations],
      valleyDepths: [...candidate.valleyDepths],
      valleyPositionRatios: [...candidate.valleyPositionRatios],
      peakValleyDistances: [...candidate.peakValleyDistances],
      tailSlopes: [...candidate.tailSlopes],
      area: candidate.area,
    },
    sharingConsent: true,
    consentVersion,
    contributorToken,
    deletionToken,
  };
}

export function mergeCandidateSets(baseCandidates, ...candidateSets) {
  const merged = new Map();
  const mergeOne = (candidate) => {
    if (!candidate?.id) return;
    const existing = merged.get(candidate.id);
    const combined = existing
      ? {
          ...existing,
          ...candidate,
        }
      : candidate;
    if (
      existing &&
      ("canDelete" in existing || "canDelete" in candidate)
    ) {
      // A shape-deduplicated response must not erase the deletion authority
      // already held by this browser for the same candidate.
      combined.canDelete = Boolean(
        existing.canDelete || candidate.canDelete,
      );
    }
    merged.set(
      candidate.id,
      combined,
    );
  };
  for (const candidate of baseCandidates ?? []) {
    mergeOne(candidate);
  }
  for (const candidates of candidateSets) {
    for (const candidate of candidates ?? []) {
      mergeOne(candidate);
    }
  }
  return [...merged.values()];
}

export function deletableLearnedCandidateIds(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter(
      (candidate) =>
        candidate?.learned &&
        candidate?.canDelete &&
        typeof candidate.id === "string" &&
        candidate.id,
    )
    .map((candidate) => candidate.id);
}

export async function deleteLearnedCandidateSelection(
  candidateIds,
  deleteOne,
  onProgress = () => {},
) {
  if (typeof deleteOne !== "function") {
    throw new Error("학습 후보 삭제 함수가 필요합니다.");
  }
  const ids = [
    ...new Set(
      (Array.isArray(candidateIds) ? candidateIds : [])
        .map((candidateId) => String(candidateId || ""))
        .filter(Boolean),
    ),
  ];
  const successes = [];
  const failures = [];

  for (const [index, candidateId] of ids.entries()) {
    onProgress({
      candidateId,
      completed: index,
      total: ids.length,
    });
    try {
      await deleteOne(candidateId);
      successes.push(candidateId);
    } catch (caught) {
      failures.push({
        candidateId,
        message:
          caught instanceof Error
            ? caught.message
            : "학습 후보를 삭제하지 못했습니다.",
      });
    }
  }
  onProgress({
    candidateId: "",
    completed: ids.length,
    total: ids.length,
  });
  return { successes, failures };
}
