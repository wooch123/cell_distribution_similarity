export const VTH_DIAGNOSTIC_CODES = Object.freeze({
  imageRequired: "VTH-IN-IMAGE-REQUIRED",
  unsupported: "VTH-IN-UNSUPPORTED",
  decodeFailed: "VTH-IN-DECODE",
  resourceLimit: "VTH-IN-RESOURCE-LIMIT",
  noForeground: "VTH-DETECT-NO-FOREGROUND",
  lowResolution: "VTH-DETECT-LOW-RESOLUTION",
  tableLattice: "VTH-DETECT-TABLE-LATTICE",
  noWaveform: "VTH-DETECT-NO-WAVEFORM",
  candidatesRejected:
    "VTH-DETECT-CANDIDATES-REJECTED",
  candidatesAmbiguous:
    "VTH-DETECT-CANDIDATES-AMBIGUOUS",
});

const WAVEFORM_FAILURES = Object.freeze({
  no_foreground: {
    diagnosticCode: VTH_DIAGNOSTIC_CODES.noForeground,
    message:
      "분포 파형을 찾지 못했습니다. 그래프 전경이 없거나 배경과 파형의 대비가 부족합니다.",
    action:
      "파형이 보이도록 대비를 높이거나 원본 슬라이드에서 다시 내보낸 이미지를 사용해 주세요.",
  },
  low_resolution_insufficient: {
    diagnosticCode: VTH_DIAGNOSTIC_CODES.lowResolution,
    message:
      "분포 파형을 찾지 못했습니다. 저해상도 복원 뒤에도 연속 형상을 확인할 증거가 부족합니다.",
    action:
      "차트를 확대해 다시 캡처하거나 원본 PPT에서 더 높은 품질로 내보내 주세요.",
  },
  table_lattice_dominant: {
    diagnosticCode: VTH_DIAGNOSTIC_CODES.tableLattice,
    message:
      "분포 파형을 찾지 못했습니다. 반복 행·열과 교차점이 지배적인 표/격자 이미지로 판정했습니다.",
    action:
      "표가 아니라 peak·valley·tail이 이어진 분포 차트 영역만 입력해 주세요.",
  },
  no_coherent_waveform: {
    diagnosticCode: VTH_DIAGNOSTIC_CODES.noWaveform,
    message:
      "분포 파형을 찾지 못했습니다. 전경은 있지만 peak·valley·tail의 연속성을 확인하지 못했습니다.",
    action:
      "설명 텍스트·도형·빈 좌표계를 제외하고 실제 분포 Curve가 포함된 영역을 입력해 주세요.",
  },
  candidates_rejected: {
    diagnosticCode: VTH_DIAGNOSTIC_CODES.candidatesRejected,
    message:
      "분포 파형을 찾지 못했습니다. 차트 후보가 연속성·곡률·State 증거 검증을 통과하지 못했습니다.",
    action:
      "차트 경계를 조금 넓게 포함해 다시 캡처하고 선이 끊기거나 가려지지 않았는지 확인해 주세요.",
  },
  candidates_ambiguous: {
    diagnosticCode: VTH_DIAGNOSTIC_CODES.candidatesAmbiguous,
    message:
      "분포 파형을 찾지 못했습니다. 서로 충돌하거나 겹치는 차트 후보 때문에 하나로 확정하지 못했습니다.",
    action:
      "겹친 표·도형을 제외하거나 차트 사이에 여백이 보이도록 다시 캡처해 주세요.",
  },
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function compactDiagnostics(value = {}) {
  const diagnostics = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "boolean" ||
      typeof entry === "string"
    ) {
      diagnostics[key] = entry;
      continue;
    }
    const number = finiteNumber(entry);
    if (number !== undefined) diagnostics[key] = number;
  }
  return diagnostics;
}

export function inputDiagnostic(
  kind,
  diagnostics = {},
  overrides = {},
) {
  const definitions = {
    image_required: {
      diagnosticCode: VTH_DIAGNOSTIC_CODES.imageRequired,
      action:
        "PNG 또는 JPEG 이미지 한 장을 첨부해 주세요. 브라우저 화면에서는 WEBP도 사용할 수 있습니다.",
    },
    unsupported: {
      diagnosticCode: VTH_DIAGNOSTIC_CODES.unsupported,
      action:
        "PNG 또는 JPEG로 변환해 주세요. 브라우저 화면에 직접 넣을 때는 WEBP도 사용할 수 있습니다.",
    },
    decode_failed: {
      diagnosticCode: VTH_DIAGNOSTIC_CODES.decodeFailed,
      action:
        "손상되지 않은 PNG/JPEG로 다시 저장해 주세요. 브라우저 화면에서는 WEBP도 사용할 수 있습니다.",
    },
    resource_limit: {
      diagnosticCode: VTH_DIAGNOSTIC_CODES.resourceLimit,
      action:
        "기능상 차트 크기 제한은 없지만 안전한 디코딩을 위해 12MB·800만 픽셀 이하로 내보내 주세요.",
    },
  };
  const definition =
    definitions[kind] ?? definitions.decode_failed;
  return {
    category: "input",
    diagnosticCode: definition.diagnosticCode,
    reason: kind,
    action: overrides.action ?? definition.action,
    diagnostics: compactDiagnostics(diagnostics),
  };
}

export function waveformFailureDiagnostic(
  detected,
  context = {},
) {
  const detector = detected?.diagnostics ?? {};
  const tableLatticeEvidence =
    detector.tableLatticeDominant;
  const tableLatticeDominant =
    tableLatticeEvidence === true ||
    (tableLatticeEvidence &&
      typeof tableLatticeEvidence === "object" &&
      Object.values(tableLatticeEvidence).some(
        (value) => value === true,
      ));
  const geometricCandidateCount =
    detector.geometricCandidateCount ??
    detector.measuredCandidateCount;
  const diagnostics = compactDiagnostics({
    sourceWidth: context.sourceWidth,
    sourceHeight: context.sourceHeight,
    processedWidth: context.processedWidth,
    processedHeight: context.processedHeight,
    sourceScale: context.sourceScale,
    foregroundPixelCount: detector.foregroundPixelCount,
    foregroundRatio: detector.foregroundRatio,
    geometricCandidateCount,
    measuredCandidateCount: geometricCandidateCount,
    validCandidateCount: detector.validCandidateCount,
    rejectedCandidateCount:
      detector.rejectedCandidateCount ??
      detected?.rejectedNonChartCount,
    ambiguousCandidateCount:
      detector.ambiguousCandidateCount,
    tableLatticeDominant,
    axisAlignedTableLattice:
      tableLatticeEvidence?.axisAligned === true,
    sharedFrameTableLattice:
      tableLatticeEvidence?.sharedFrame === true,
    rotatedTableLattice:
      tableLatticeEvidence?.rotated === true,
    lowResolutionRecoveryApplied:
      detector.lowResolutionRecoveryApplied ??
      detected?.lowResolutionRecovery?.applied,
    repairedPixelCount:
      detector.repairedPixelCount ??
      detected?.lowResolutionRecovery?.repairedPixelCount,
  });

  let reason = context.reason;
  if (!reason) {
    if (
      detector.noForeground === true ||
      diagnostics.foregroundPixelCount === 0
    ) {
      reason = "no_foreground";
    } else if (tableLatticeDominant) {
      reason = "table_lattice_dominant";
    } else if (
      Number(detector.ambiguousCandidateCount) > 0
    ) {
      reason = "candidates_ambiguous";
    } else if (
      Number(context.sourceScale) > 1 &&
      (detector.lowResolutionRecoveryApplied === true ||
        detected?.lowResolutionRecovery?.applied === true)
    ) {
      reason = "low_resolution_insufficient";
    } else if (
      Number(geometricCandidateCount) > 0 ||
      Number(detected?.rejectedNonChartCount) > 0
    ) {
      reason = "candidates_rejected";
    } else {
      reason = "no_coherent_waveform";
    }
  }
  const definition =
    WAVEFORM_FAILURES[reason] ??
    WAVEFORM_FAILURES.no_coherent_waveform;
  return {
    category: "waveform_detection",
    legacyCode: "distribution_waveform_not_found",
    reason,
    diagnosticCode: definition.diagnosticCode,
    message: context.message ?? definition.message,
    action: definition.action,
    diagnostics,
  };
}

export function diagnosticDisplayMessage(error) {
  const details = error?.details ?? error ?? {};
  const diagnosticCode =
    details.diagnosticCode ??
    error?.diagnosticCode ??
    "";
  const message =
    error?.message ?? "이미지를 분석하지 못했습니다.";
  const action = details.action ?? error?.action ?? "";
  if (!diagnosticCode) return message;
  const title =
    details.category === "waveform_detection"
      ? "분포 파형을 찾지 못했습니다."
      : "이미지를 분석하지 못했습니다.";
  const cause =
    details.category === "waveform_detection"
      ? message.replace(
          /^분포 파형을 찾지 못했습니다\.\s*/,
          "",
        )
      : message;
  const diagnostics = details.diagnostics ?? {};
  const candidateSummary = [
    Number.isFinite(diagnostics.measuredCandidateCount)
      ? `후보 ${diagnostics.measuredCandidateCount}`
      : "",
    Number.isFinite(diagnostics.validCandidateCount)
      ? `유효 ${diagnostics.validCandidateCount}`
      : "",
    Number.isFinite(diagnostics.rejectedCandidateCount)
      ? `제외 ${diagnostics.rejectedCandidateCount}`
      : "",
  ].filter(Boolean);
  const resolutionSummary =
    Number.isFinite(diagnostics.sourceWidth) &&
    Number.isFinite(diagnostics.sourceHeight)
      ? `입력 ${diagnostics.sourceWidth}×${diagnostics.sourceHeight}`
      : "";
  const processedSummary =
    Number.isFinite(diagnostics.processedWidth) &&
    Number.isFinite(diagnostics.processedHeight)
      ? `분석 ${diagnostics.processedWidth}×${diagnostics.processedHeight}`
      : "";
  const diagnosticSummary = [
    resolutionSummary,
    processedSummary,
    ...candidateSummary,
  ].filter(Boolean);
  return [
    `[${diagnosticCode}] ${title}`,
    `판정 원인: ${cause}`,
    action ? `권장 조치: ${action}` : "",
    diagnosticSummary.length
      ? `검출 정보: ${diagnosticSummary.join(" · ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
