import assert from "node:assert/strict";
import test from "node:test";

import { fairlyBoundPreNmsCandidates } from "../lib/vth-chart-panel-core.mjs";

test("pre-NMS Curve measurement stays spatially fair when 600 strong frames occupy one tile", () => {
  const width = 1600;
  const height = 900;
  const denseStrongCandidates = Array.from(
    { length: 600 },
    (_, index) => {
      const left = 5 + (index % 30) * 12;
      const top =
        5 + (Math.floor(index / 30) % 20) * 10;
      return {
        id: `dense-${index}`,
        left,
        top,
        right: left + 8,
        bottom: top + 6,
        axisMode: "rectangle",
        detectionReason: "shared-frame-cell",
        detectionScale: "strict",
        confidence: 0.99,
        edgeEvidence: 0.99,
        curveEvidence: { valid: false },
      };
    },
  );
  const remoteWeakSinglePeak = {
    id: "remote-weak-single-peak",
    left: 1240,
    top: 690,
    right: 1460,
    bottom: 840,
    axisMode: "rectangle",
    detectionReason: "closed-plot-frame",
    detectionScale: "compact",
    confidence: 0.2,
    edgeEvidence: 0.1,
  };
  const allCandidates = [
    ...denseStrongCandidates,
    remoteWeakSinglePeak,
  ];

  // This is the former global score-sort behavior: every measured slot is
  // consumed by the dense top-left tile before the remote chart is validated.
  const legacyGlobalSelection = [...allCandidates]
    .sort(
      (left, right) =>
        Number(Boolean(right.curveEvidence)) -
          Number(Boolean(left.curveEvidence)) ||
        (right.detectionReason === "shared-frame-cell") -
          (left.detectionReason === "shared-frame-cell") ||
        (right.detectionScale === "strict") -
          (left.detectionScale === "strict") ||
        right.edgeEvidence - left.edgeEvidence ||
        right.confidence - left.confidence,
    )
    .slice(0, 512);
  assert.ok(
    !legacyGlobalSelection.includes(remoteWeakSinglePeak),
    "fixture must reproduce the former global-sort starvation",
  );

  const selection = fairlyBoundPreNmsCandidates(
    allCandidates,
    width,
    height,
    512,
  );

  assert.equal(selection.candidates.length, 512);
  assert.ok(
    selection.candidates.includes(remoteWeakSinglePeak),
    "a remote weak chart must reach Curve validation",
  );
  assert.equal(
    selection.diagnostics.droppedCandidateCount,
    89,
  );
  assert.equal(
    selection.diagnostics.measurementBudgetHit,
    true,
  );
  assert.deepEqual(
    selection.diagnostics.tiles[0],
    {
      row: 0,
      column: 0,
      generatedCount: 600,
      retainedCount: 511,
      droppedCount: 89,
    },
  );
  assert.deepEqual(
    selection.diagnostics.tiles[15],
    {
      row: 3,
      column: 3,
      generatedCount: 1,
      retainedCount: 1,
      droppedCount: 0,
    },
  );
});
