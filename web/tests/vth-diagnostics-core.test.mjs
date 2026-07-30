import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  diagnosticDisplayMessage,
  inputDiagnostic,
  VTH_DIAGNOSTIC_CODES,
  waveformFailureDiagnostic,
} from "../lib/vth-diagnostics-core.mjs";
import {
  parseSimilarityImageRequest,
  searchSimilarityImage,
  SimilarityApiError,
} from "../lib/vth-similarity-api-core.mjs";
import { nonDistributionPng } from "../../local-server/non-distribution-fixture.mjs";

const corpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

test("assigns stable VTH-IN diagnostics to input failures", () => {
  assert.equal(
    inputDiagnostic("unsupported").diagnosticCode,
    VTH_DIAGNOSTIC_CODES.unsupported,
  );
  assert.equal(
    inputDiagnostic("decode_failed").diagnosticCode,
    VTH_DIAGNOSTIC_CODES.decodeFailed,
  );
  const resource = inputDiagnostic("resource_limit", {
    width: 5000,
    height: 3000,
    pixelCount: 15_000_000,
  });
  assert.equal(
    resource.diagnosticCode,
    VTH_DIAGNOSTIC_CODES.resourceLimit,
  );
  assert.equal(resource.diagnostics.pixelCount, 15_000_000);
  assert.match(resource.action, /12MB·800만 픽셀/);
});

test("classifies waveform failures by detector evidence without fixed dimensions", () => {
  const cases = [
    {
      diagnostics: { noForeground: true, foregroundPixelCount: 0 },
      reason: "no_foreground",
      code: VTH_DIAGNOSTIC_CODES.noForeground,
    },
    {
      diagnostics: {
        tableLatticeDominant: true,
        foregroundPixelCount: 100,
      },
      reason: "table_lattice_dominant",
      code: VTH_DIAGNOSTIC_CODES.tableLattice,
    },
    {
      diagnostics: {
        foregroundPixelCount: 100,
        ambiguousCandidateCount: 2,
      },
      reason: "candidates_ambiguous",
      code: VTH_DIAGNOSTIC_CODES.candidatesAmbiguous,
    },
    {
      diagnostics: {
        foregroundPixelCount: 100,
        measuredCandidateCount: 3,
      },
      reason: "candidates_rejected",
      code: VTH_DIAGNOSTIC_CODES.candidatesRejected,
    },
    {
      diagnostics: {
        foregroundPixelCount: 100,
        lowResolutionRecoveryApplied: true,
      },
      context: { sourceScale: 3 },
      reason: "low_resolution_insufficient",
      code: VTH_DIAGNOSTIC_CODES.lowResolution,
    },
    {
      diagnostics: { foregroundPixelCount: 100 },
      reason: "no_coherent_waveform",
      code: VTH_DIAGNOSTIC_CODES.noWaveform,
    },
  ];
  for (const fixture of cases) {
    const diagnostic = waveformFailureDiagnostic(
      {
        diagnostics: fixture.diagnostics,
        rejectedNonChartCount: 0,
        lowResolutionRecovery: { applied: false },
      },
      fixture.context,
    );
    assert.equal(diagnostic.reason, fixture.reason);
    assert.equal(diagnostic.diagnosticCode, fixture.code);
    assert.equal(
      diagnostic.legacyCode,
      "distribution_waveform_not_found",
    );
    assert.ok(diagnostic.action);
  }
});

test("does not label harmless deskew inspection flags as table evidence", () => {
  const diagnostic = waveformFailureDiagnostic({
    diagnostics: {
      foregroundPixelCount: 100,
      measuredCandidateCount: 1,
      tableLatticeDominant: {
        axisAligned: false,
        sharedFrame: false,
        rotated: false,
        rotatedInspectionPerformed: true,
        rotatedCurveValid: true,
        rotatedCurveThinEnough: true,
        rotatedContinuousWaveformAcrossGuideCells: true,
        wholeImageFallbackBlocked: false,
      },
    },
    rejectedNonChartCount: 1,
    lowResolutionRecovery: { applied: false },
  });
  assert.equal(diagnostic.reason, "candidates_rejected");
  assert.equal(
    diagnostic.diagnosticCode,
    VTH_DIAGNOSTIC_CODES.candidatesRejected,
  );
  assert.equal(
    diagnostic.diagnostics.tableLatticeDominant,
    false,
  );
});

test("formats the same diagnostic contract for the UI error area", () => {
  const message = diagnosticDisplayMessage({
    message: "표 이미지입니다.",
    details: {
      diagnosticCode: VTH_DIAGNOSTIC_CODES.tableLattice,
      action: "차트만 입력해 주세요.",
    },
  });
  assert.equal(
    message,
    [
      "[VTH-DETECT-TABLE-LATTICE] 이미지를 분석하지 못했습니다.",
      "판정 원인: 표 이미지입니다.",
      "권장 조치: 차트만 입력해 주세요.",
    ].join("\n"),
  );
});

test("does not repeat the legacy waveform title inside the diagnostic cause", () => {
  const message = diagnosticDisplayMessage({
    message:
      "분포 파형을 찾지 못했습니다. 반복 행·열이 지배적인 표입니다.",
    details: {
      category: "waveform_detection",
      diagnosticCode: VTH_DIAGNOSTIC_CODES.tableLattice,
      action: "차트만 입력해 주세요.",
    },
  });
  assert.equal(
    message,
    [
      "[VTH-DETECT-TABLE-LATTICE] 분포 파형을 찾지 못했습니다.",
      "판정 원인: 반복 행·열이 지배적인 표입니다.",
      "권장 조치: 차트만 입력해 주세요.",
    ].join("\n"),
  );
});

test("keeps legacy input codes while attaching VTH-IN diagnostics", async () => {
  await assert.rejects(
    () =>
      parseSimilarityImageRequest(
        new Request("https://example.test/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "image_required");
      assert.equal(
        error.details.diagnosticCode,
        VTH_DIAGNOSTIC_CODES.imageRequired,
      );
      return true;
    },
  );

  await assert.rejects(
    () =>
      parseSimilarityImageRequest(
        new Request("https://example.test/api", {
          method: "POST",
          headers: { "content-type": "image/gif" },
          body: new Uint8Array([0x47, 0x49, 0x46]),
        }),
      ),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.code, "unsupported_content_type");
      assert.equal(
        error.details.diagnosticCode,
        VTH_DIAGNOSTIC_CODES.unsupported,
      );
      return true;
    },
  );

  const oversizedHeader = new Uint8Array(24);
  oversizedHeader.set(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  new DataView(oversizedHeader.buffer).setUint32(16, 4000);
  new DataView(oversizedHeader.buffer).setUint32(20, 3000);
  await assert.rejects(
    () =>
      parseSimilarityImageRequest(
        new Request("https://example.test/api", {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: oversizedHeader,
        }),
      ),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.code, "image_dimensions_too_large");
      assert.equal(
        error.details.diagnosticCode,
        VTH_DIAGNOSTIC_CODES.resourceLimit,
      );
      assert.equal(error.details.diagnostics.pixelCount, 12_000_000);
      return true;
    },
  );
});

test("reports a tiny table as lattice evidence instead of a generic rejection", async () => {
  await assert.rejects(
    () =>
      searchSimilarityImage({
        bytes: nonDistributionPng(),
        mimeType: "image/png",
        topK: 1,
        corpus,
        origin: "https://example.test",
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(
        error.code,
        "distribution_waveform_not_found",
      );
      assert.equal(
        error.details.reason,
        "table_lattice_dominant",
      );
      assert.equal(
        error.details.diagnosticCode,
        VTH_DIAGNOSTIC_CODES.tableLattice,
      );
      assert.equal(
        error.details.diagnostics.tableLatticeDominant,
        true,
      );
      assert.equal(error.details.diagnostics.sourceWidth, 320);
      assert.equal(error.details.diagnostics.sourceHeight, 180);
      assert.ok(error.details.diagnostics.sourceScale > 1);
      assert.ok(error.details.action);
      return true;
    },
  );
});
