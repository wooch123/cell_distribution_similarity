import assert from "node:assert/strict";
import test from "node:test";

import {
  detectChartPanelsFromMask,
} from "../lib/vth-chart-panel-core.mjs";
import {
  halfCanvasTablelikeWaveformFixtures,
} from "./helpers/half-canvas-tablelike-waveform-fixtures.mjs";
import {
  closedFrameClippedTailVthCohortFixture,
  closedFrameOneSidedKpiCosineCohortFixture,
  closedFrameKpiSineCohortFixture,
} from "./helpers/physical-waveform-frame-cohort-fixtures.mjs";

function detectFixture(fixture) {
  return detectChartPanelsFromMask(
    fixture.broadMask,
    fixture.width,
    fixture.height,
    {
      edgeEvidenceMask: fixture.salientMask,
      curveEvidenceMask: fixture.curveMask,
      curveColorMasks: fixture.curveColorMasks,
      fallbackToWholeImage: false,
      sourceScale: 1,
    },
  );
}

function rowWideClippedTailVthTableFixture() {
  const source = closedFrameClippedTailVthCohortFixture();
  const width = 1000;
  const height = 800;
  const pixelCount = width * height;
  const target = {
    width,
    height,
    broadMask: new Uint8Array(pixelCount),
    salientMask: new Uint8Array(pixelCount),
    curveMask: new Uint8Array(pixelCount),
    curveColorMasks: Array.from(
      { length: source.curveColorMasks.length },
      () => new Uint8Array(pixelCount),
    ),
  };
  const targetBounds = [
    { left: 60, top: 55, right: 940, bottom: 199 },
    { left: 60, top: 270, right: 940, bottom: 414 },
    { left: 60, top: 485, right: 940, bottom: 629 },
  ];
  const copyScaledCrop = (
    sourceMask,
    targetMask,
    sourceBounds,
    bounds,
  ) => {
    const sourceWidth =
      sourceBounds.right - sourceBounds.left + 1;
    const sourceHeight =
      sourceBounds.bottom - sourceBounds.top + 1;
    const targetWidth = bounds.right - bounds.left + 1;
    const targetHeight = bounds.bottom - bounds.top + 1;
    for (let y = bounds.top; y <= bounds.bottom; y += 1) {
      const sourceY =
        sourceBounds.top +
        Math.round(
          ((y - bounds.top) * (sourceHeight - 1)) /
            Math.max(1, targetHeight - 1),
        );
      for (let x = bounds.left; x <= bounds.right; x += 1) {
        const sourceX =
          sourceBounds.left +
          Math.round(
            ((x - bounds.left) * (sourceWidth - 1)) /
              Math.max(1, targetWidth - 1),
          );
        if (sourceMask[sourceY * source.width + sourceX]) {
          targetMask[y * width + x] = 1;
        }
      }
    }
  };
  for (let index = 0; index < targetBounds.length; index += 1) {
    const sourceBounds = source.charts[index];
    const bounds = targetBounds[index];
    copyScaledCrop(
      source.broadMask,
      target.broadMask,
      sourceBounds,
      bounds,
    );
    copyScaledCrop(
      source.salientMask,
      target.salientMask,
      sourceBounds,
      bounds,
    );
    copyScaledCrop(
      source.curveMask,
      target.curveMask,
      sourceBounds,
      bounds,
    );
    for (
      let colorIndex = 0;
      colorIndex < target.curveColorMasks.length;
      colorIndex += 1
    ) {
      copyScaledCrop(
        source.curveColorMasks[colorIndex],
        target.curveColorMasks[colorIndex],
        sourceBounds,
        bounds,
      );
    }
  }
  for (const ratio of [0.25, 0.5, 0.75]) {
    const x = Math.round(
      targetBounds[0].left +
        (targetBounds[0].right -
          targetBounds[0].left) *
          ratio,
    );
    for (
      let y = targetBounds[0].top;
      y <= targetBounds.at(-1).bottom;
      y += 1
    ) {
      target.broadMask[y * width + x] = 1;
      target.salientMask[y * width + x] = 1;
    }
  }
  return {
    ...target,
    expectedChartCount: targetBounds.length,
    expectedStateCount: source.expectedStateCount,
  };
}

test("a 2x3 closed-frame coloured KPI sine cohort is not accepted as VTH distributions", () => {
  const fixture = closedFrameKpiSineCohortFixture();
  const result = detectFixture(fixture);

  assert.equal(
    result.diagnostics.physicalWaveformFrameCohortProof
      .applied,
    false,
  );
  assert.equal(
    result.diagnostics.physicalWaveformFrameCohortProof
      .candidateCount,
    0,
  );
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.detectedPanelCount, 0);
  assert.deepEqual(result.panels, []);
  assert.ok(
    result.diagnostics.measuredCandidateSummaries.some(
      ({ finalFilterDiagnostics }) =>
        finalFilterDiagnostics
          ?.rejectedByPhysicalWaveformFrameCohort === true,
    ),
    "the rejected physical frames must also suppress duplicate spatial Curve candidates",
  );
});

test("one-sided physical frame contact does not promote a KPI cosine cohort to VTH", () => {
  const fixture =
    closedFrameOneSidedKpiCosineCohortFixture();
  const result = detectFixture(fixture);

  assert.equal(
    result.diagnostics.physicalWaveformFrameCohortProof
      .applied,
    false,
  );
  assert.equal(result.fallbackUsed, false);
  assert.equal(
    result.detectedPanelCount,
    fixture.expectedChartCount,
  );
  assert.deepEqual(result.panels, []);
});

test("the real 4x3 VTH cohort retains exact physical-frame proof and topology", () => {
  const fixture = halfCanvasTablelikeWaveformFixtures().find(
    ({ name }) => name === "left-half-12",
  );
  const result = detectFixture(fixture);
  const proof =
    result.diagnostics.physicalWaveformFrameCohortProof;

  assert.deepEqual(proof, {
    applied: true,
    rows: 4,
    columns: 3,
    candidateCount: 12,
  });
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.panels.length, 12);
  for (const panel of result.panels) {
    const descriptor = panel.verifiedWaveform?.descriptor;
    assert.ok(
      descriptor,
      "every proved VTH frame must preserve measured topology",
    );
    assert.equal(
      descriptor.peakLocations.length,
      descriptor.stateCount,
    );
    assert.equal(
      descriptor.valleyLocations.length,
      descriptor.stateCount - 1,
    );
  }
});

test("one-sided physically clipped VTH tails are not rejected as floating KPI traces", () => {
  const fixture =
    closedFrameClippedTailVthCohortFixture();
  const result = detectFixture(fixture);
  const proof =
    result.diagnostics.physicalWaveformFrameCohortProof;

  assert.deepEqual(proof, {
    applied: true,
    rows: 2,
    columns: 3,
    candidateCount: fixture.expectedChartCount,
  });
  assert.equal(result.fallbackUsed, false);
  assert.equal(
    result.panels.length,
    fixture.expectedChartCount,
  );
  for (const panel of result.panels) {
    const descriptor = panel.verifiedWaveform?.descriptor;
    assert.ok(descriptor);
    assert.equal(
      descriptor.stateCount,
      fixture.expectedStateCount,
    );
    assert.equal(
      descriptor.peakLocations.length,
      fixture.expectedStateCount,
    );
    assert.equal(
      descriptor.valleyLocations.length,
      fixture.expectedStateCount - 1,
    );
    assert.equal(descriptor.regularized, false);
  }
  assert.ok(
    result.diagnostics.measuredCandidateSummaries.every(
      ({ finalFilterDiagnostics }) =>
        finalFilterDiagnostics
          ?.rejectedByPhysicalWaveformFrameCohort !== true,
    ),
  );
});

test("row-wide one-sided clipped VTH plots inside a table lattice remain distributions", () => {
  const fixture = rowWideClippedTailVthTableFixture();
  const result = detectFixture(fixture);

  assert.equal(result.fallbackUsed, false);
  assert.equal(
    result.panels.length,
    fixture.expectedChartCount,
    JSON.stringify(
      result.diagnostics.measuredCandidateSummaries.map(
        (candidate) => ({
          bounds: [
            candidate.left,
            candidate.top,
            candidate.right,
            candidate.bottom,
          ],
          reason: candidate.detectionReason,
          curveValid: candidate.curveValid,
          localizedVthContract:
            candidate.localizedVthContract,
          final: candidate.finalFilterDiagnostics,
        }),
      ),
    ),
  );
  for (const panel of result.panels) {
    const descriptor = panel.verifiedWaveform?.descriptor;
    assert.ok(descriptor);
    assert.equal(
      descriptor.stateCount,
      fixture.expectedStateCount,
    );
    assert.equal(
      descriptor.observedStateCount,
      fixture.expectedStateCount,
    );
    assert.equal(
      descriptor.peakLocations.length,
      fixture.expectedStateCount,
    );
    assert.equal(
      descriptor.valleyLocations.length,
      fixture.expectedStateCount - 1,
    );
    assert.equal(descriptor.regularized, false);
  }
});
