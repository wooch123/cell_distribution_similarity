import {
  descriptorFromProfile,
  isValidStateCount,
} from "./vth-shape-core.mjs";

const MAXIMUM_TRAINING_PANEL_COUNT = 30;
const SOURCE_SELECTION_FIELDS = [
  "panelIndex",
  "panelCount",
  "seriesIndex",
  "seriesCount",
];

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

function invalidSourceSelection(field, reason, message) {
  return Object.assign(new Error(message), {
    status: 400,
    code: "invalid_source_selection",
    details: {
      field: field
        ? `sourceSelection.${field}`
        : "sourceSelection",
      reason,
    },
  });
}

export function normalizeTrainingSourceSelection(value) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw invalidSourceSelection(
      "",
      "object_required",
      "sourceSelection은 객체여야 합니다.",
    );
  }
  const extraField = Object.keys(value).find(
    (field) => !SOURCE_SELECTION_FIELDS.includes(field),
  );
  if (extraField) {
    throw invalidSourceSelection(
      extraField,
      "unknown_field",
      `sourceSelection.${extraField} 필드는 지원하지 않습니다.`,
    );
  }
  const normalized = {};
  for (const field of SOURCE_SELECTION_FIELDS) {
    if (
      typeof value[field] !== "number" ||
      !Number.isSafeInteger(value[field])
    ) {
      throw invalidSourceSelection(
        field,
        "integer_required",
        `sourceSelection.${field}는 정수여야 합니다.`,
      );
    }
    normalized[field] = value[field];
  }
  if (
    normalized.panelCount < 1 ||
    normalized.panelCount > MAXIMUM_TRAINING_PANEL_COUNT
  ) {
    throw invalidSourceSelection(
      "panelCount",
      "out_of_range",
      `sourceSelection.panelCount는 1~${MAXIMUM_TRAINING_PANEL_COUNT}이어야 합니다.`,
    );
  }
  if (
    normalized.panelIndex < 0 ||
    normalized.panelIndex >= normalized.panelCount
  ) {
    throw invalidSourceSelection(
      "panelIndex",
      "out_of_range",
      "sourceSelection.panelIndex는 panelCount 범위 안이어야 합니다.",
    );
  }
  if (normalized.seriesCount < 1) {
    throw invalidSourceSelection(
      "seriesCount",
      "out_of_range",
      "sourceSelection.seriesCount는 1 이상이어야 합니다.",
    );
  }
  if (
    normalized.seriesIndex < 0 ||
    normalized.seriesIndex >= normalized.seriesCount
  ) {
    throw invalidSourceSelection(
      "seriesIndex",
      "out_of_range",
      "sourceSelection.seriesIndex는 seriesCount 범위 안이어야 합니다.",
    );
  }
  return normalized;
}

export function trainingSourceSelection(analysis) {
  return normalizeTrainingSourceSelection({
    panelIndex: analysis?.panelIndex,
    panelCount: analysis?.panelCount,
    seriesIndex: analysis?.seriesIndex,
    seriesCount: analysis?.seriesCount,
  });
}

export function filterSelectedTrainingUnits(units, selectedIds) {
  if (!Array.isArray(units)) return [];
  const ids = new Set(
    selectedIds && typeof selectedIds[Symbol.iterator] === "function"
      ? [...selectedIds].map(String)
      : [],
  );
  if (!ids.size) return [];
  return units.filter((unit) => {
    const id = unit?.analysis?.id ?? unit?.id;
    return typeof id === "string" && ids.has(id);
  });
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
  const sourceSelection = normalizeTrainingSourceSelection(
    input.sourceSelection,
  );
  const descriptor = input.descriptor ?? input;
  const safeProfile = copyNumberArray(profile, 256);
  const stateCount = Number(descriptor?.stateCount);
  if (!id || !safeProfile || !isValidStateCount(stateCount)) {
    throw new Error("학습 후보의 ID, 256-point Curve 또는 State가 올바르지 않습니다.");
  }

  const valleyCount = stateCount - 1;
  const peakLocations = copyNumberArray(
    descriptor.peakLocations,
    stateCount,
  );
  const peakWidths = copyNumberArray(descriptor.peakWidths, stateCount);
  const valleyHeights = copyNumberArray(
    descriptor.valleyHeights,
    valleyCount,
  );
  const valleyLocations = copyNumberArray(
    descriptor.valleyLocations,
    valleyCount,
  );
  const valleyDepths = copyNumberArray(
    descriptor.valleyDepths,
    valleyCount,
  );
  const valleyPositionRatios = copyNumberArray(
    descriptor.valleyPositionRatios,
    valleyCount,
  );
  const peakValleyDistances = copyNumberArray(
    descriptor.peakValleyDistances,
    valleyCount * 2,
  );
  const tailSlopes = copyNumberArray(
    descriptor.tailSlopes,
    2,
  );
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
    ...(sourceSelection ? { sourceSelection } : {}),
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
  const sourceSelection = normalizeTrainingSourceSelection(
    candidate.sourceSelection,
  );
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
    ...(sourceSelection ? { sourceSelection } : {}),
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
  // Shared records use one canonical descriptor derived from the exact
  // persisted profile. The UI may choose a regularized alternative State
  // hypothesis for local search, which is valid locally but must not make the
  // public payload internally contradictory.
  const canonicalDescriptor = descriptorFromProfile(candidate.profile);
  const sourceSelection = normalizeTrainingSourceSelection(
    candidate.sourceSelection,
  );
  return {
    schemaVersion: 2,
    label: candidate.label,
    profile: [...candidate.profile],
    descriptor: {
      stateCount: canonicalDescriptor.stateCount,
      observedStateCount:
        descriptor?.observedStateCount ??
        canonicalDescriptor.observedStateCount ??
        canonicalDescriptor.stateCount,
      regularized: Boolean(canonicalDescriptor.regularized),
      peakLocations: [...canonicalDescriptor.peakLocations],
      peakWidths: [...canonicalDescriptor.peakWidths],
      valleyHeights: [...canonicalDescriptor.valleyHeights],
      valleyLocations: [...canonicalDescriptor.valleyLocations],
      valleyDepths: [...canonicalDescriptor.valleyDepths],
      valleyPositionRatios: [
        ...canonicalDescriptor.valleyPositionRatios,
      ],
      peakValleyDistances: [
        ...canonicalDescriptor.peakValleyDistances,
      ],
      tailSlopes: [...canonicalDescriptor.tailSlopes],
      area: canonicalDescriptor.area,
    },
    sharingConsent: true,
    consentVersion,
    contributorToken,
    deletionToken,
    ...(sourceSelection ? { sourceSelection } : {}),
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
