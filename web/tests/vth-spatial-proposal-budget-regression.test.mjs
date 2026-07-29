import assert from "node:assert/strict";
import test from "node:test";

import {
  detectChartPanelsFromMask,
} from "../lib/vth-chart-panel-core.mjs";

function setPixel(mask, width, height, x, y) {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return;
  }
  mask[y * width + x] = 1;
}

function drawLine(
  mask,
  width,
  height,
  startX,
  startY,
  endX,
  endY,
) {
  let x = startX;
  let y = startY;
  const deltaX = Math.abs(endX - startX);
  const stepX = startX < endX ? 1 : -1;
  const deltaY = -Math.abs(endY - startY);
  const stepY = startY < endY ? 1 : -1;
  let error = deltaX + deltaY;
  for (;;) {
    setPixel(mask, width, height, x, y);
    if (x === endX && y === endY) break;
    const doubledError = error * 2;
    if (doubledError >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubledError <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
}

function drawWeakDistribution(
  mask,
  width,
  height,
  bounds,
) {
  const centerY = (bounds.top + bounds.bottom) / 2;
  const amplitude = (bounds.bottom - bounds.top) * 0.4;
  let previousX = bounds.left;
  let previousY = Math.round(centerY);
  for (let x = bounds.left + 1; x <= bounds.right; x += 1) {
    const progress =
      (x - bounds.left) /
      Math.max(1, bounds.right - bounds.left);
    const y = Math.round(
      centerY -
        Math.cos(progress * Math.PI * 8) * amplitude,
    );
    drawLine(
      mask,
      width,
      height,
      previousX,
      previousY,
      x,
      y,
    );
    previousX = x;
    previousY = y;
  }
}

function intersectsWithPadding(bounds, left, top, right, bottom) {
  return !(
    right < bounds.left - 3 ||
    left > bounds.right + 3 ||
    bottom < bounds.top - 3 ||
    top > bounds.bottom + 3
  );
}

function drawTopLeftProposalStorm(
  mask,
  width,
  height,
  charts,
) {
  for (let row = 0; row < 18; row += 1) {
    for (let column = 0; column < 25; column += 1) {
      const left = 3 + column * 19;
      const top = 3 + row * 14;
      const right = left + 14;
      const bottom = top + 7;
      if (
        charts.some((chart) =>
          intersectsWithPadding(
            chart,
            left,
            top,
            right,
            bottom,
          ),
        )
      ) {
        continue;
      }
      // One-turn angular marks satisfy the cheap component-size gate but are
      // not distributions. More than 384 of them occupy the same 4 × 4 tile,
      // so largest-first truncation used to starve a weak real waveform.
      drawLine(
        mask,
        width,
        height,
        left,
        top,
        left + 7,
        bottom,
      );
      drawLine(
        mask,
        width,
        height,
        left + 7,
        bottom,
        right,
        top,
      );
    }
  }
}

function drawDashedGuideStorm(mask, width, height) {
  for (let y = 310; y < 430; y += 1) {
    const phase = (y * 17) % 47;
    for (let x = phase; x < width; x += 60) {
      drawLine(
        mask,
        width,
        height,
        x,
        y,
        Math.min(width - 1, x + 15),
        y,
      );
    }
  }
}

function drawEllipse(
  mask,
  width,
  height,
  centerX,
  centerY,
  radiusX,
  radiusY,
) {
  let previous = null;
  for (let step = 0; step <= 80; step += 1) {
    const angle = (step / 80) * Math.PI * 2;
    const point = {
      x: Math.round(centerX + Math.cos(angle) * radiusX),
      y: Math.round(centerY + Math.sin(angle) * radiusY),
    };
    if (previous) {
      drawLine(
        mask,
        width,
        height,
        previous.x,
        previous.y,
        point.x,
        point.y,
      );
    }
    previous = point;
  }
}

function assertDetectedOnce(panels, expected) {
  const matches = panels.filter(
    (panel) =>
      panel.left <= expected.left + 10 &&
      panel.right >= expected.right - 10 &&
      panel.top <= expected.top + 10 &&
      panel.bottom >= expected.bottom - 10,
  );
  assert.equal(
    matches.length,
    1,
    `waveform ${JSON.stringify(expected)} must survive exactly once`,
  );
}

test("fair online proposal budgets preserve weak waveforms across tiles under a top-left and dashed-rule storm", () => {
  const width = 1920;
  const height = 1080;
  const mask = new Uint8Array(width * height);
  const charts = [
    { left: 330, top: 205, right: 468, bottom: 262 },
    { left: 1500, top: 90, right: 1740, bottom: 195 },
    { left: 110, top: 820, right: 350, bottom: 950 },
    { left: 1510, top: 800, right: 1810, bottom: 960 },
  ];
  for (const chart of charts) {
    drawWeakDistribution(mask, width, height, chart);
  }
  drawTopLeftProposalStorm(
    mask,
    width,
    height,
    charts,
  );
  drawDashedGuideStorm(mask, width, height);

  const startedAt = performance.now();
  const result = detectChartPanelsFromMask(
    mask,
    width,
    height,
    { fallbackToWholeImage: false },
  );
  const elapsedMs = performance.now() - startedAt;
  const recovery =
    result.diagnostics.arbitraryWaveformRecovery;

  assert.equal(result.panels.length, charts.length);
  for (const chart of charts) {
    assertDetectedOnce(result.panels, chart);
  }
  assert.ok(
    recovery.generatedProposalCount > 384,
    "the fixture must exercise the global proposal budget",
  );
  assert.equal(
    recovery.proposalCount,
    recovery.generatedProposalCount,
  );
  assert.ok(recovery.boundedProposalCount <= 384);
  assert.equal(
    recovery.passDroppedProposalCount,
    recovery.generatedProposalCount -
      recovery.retainedPassProposalCount,
  );
  assert.equal(
    recovery.globalDroppedProposalCount,
    recovery.retainedPassProposalCount -
      recovery.boundedProposalCount,
  );
  assert.equal(
    recovery.droppedProposalCount,
    recovery.generatedProposalCount -
      recovery.boundedProposalCount,
  );
  assert.equal(
    recovery.proposalBudgetHit,
    recovery.droppedProposalCount > 0,
  );
  assert.equal(
    recovery.deniedProposalEvaluationCount,
    recovery.boundedProposalCount -
      recovery.evaluatedCount,
  );
  assert.equal(
    recovery.curveMeasurementBudgetHit,
    recovery.deniedCurveMeasurementCount > 0,
  );
  assert.equal(
    recovery.frameMeasurementBudgetHit,
    recovery.deniedFrameMeasurementCount > 0,
  );

  const passGeneratedCount =
    recovery.proposalPasses.reduce(
      (sum, pass) => sum + pass.generatedCount,
      0,
    );
  const passRetainedCount =
    recovery.proposalPasses.reduce(
      (sum, pass) => sum + pass.retainedCount,
      0,
    );
  const globallyRetainedCount =
    recovery.proposalPasses.reduce(
      (sum, pass) =>
        sum + pass.globallyRetainedCount,
      0,
    );
  assert.equal(
    passGeneratedCount,
    recovery.generatedProposalCount,
  );
  assert.equal(
    passRetainedCount,
    recovery.retainedPassProposalCount,
  );
  assert.equal(
    globallyRetainedCount,
    recovery.boundedProposalCount,
  );
  for (const pass of recovery.proposalPasses) {
    assert.equal(
      pass.onlineDroppedCount,
      pass.generatedCount - pass.onlineRetainedCount,
    );
    assert.equal(
      pass.passDroppedCount,
      pass.onlineRetainedCount - pass.retainedCount,
    );
    assert.equal(
      pass.droppedCount,
      pass.generatedCount - pass.retainedCount,
    );
    assert.equal(pass.budgetHit, pass.droppedCount > 0);
    assert.equal(
      pass.globalDroppedCount,
      pass.retainedCount - pass.globallyRetainedCount,
    );
    assert.equal(
      pass.globalBudgetHit,
      pass.globalDroppedCount > 0,
    );
    assert.equal(
      pass.tiles.reduce(
        (sum, tile) => sum + tile.generatedCount,
        0,
      ),
      pass.generatedCount,
    );
    assert.equal(
      pass.tiles.reduce(
        (sum, tile) => sum + tile.onlineRetainedCount,
        0,
      ),
      pass.onlineRetainedCount,
    );
    assert.equal(
      pass.tiles.reduce(
        (sum, tile) => sum + tile.retainedCount,
        0,
      ),
      pass.retainedCount,
    );
    assert.equal(
      pass.tiles.reduce(
        (sum, tile) =>
          sum + tile.globallyRetainedCount,
        0,
      ),
      pass.globallyRetainedCount,
    );
    assert.equal(
      pass.tiles.reduce(
        (sum, tile) => sum + tile.droppedCount,
        0,
      ),
      pass.droppedCount,
    );
    for (const tile of pass.tiles) {
      assert.ok(tile.onlineRetainedCount <= 32);
      assert.ok(tile.retainedCount <= tile.onlineRetainedCount);
      assert.equal(
        tile.onlineDroppedCount,
        tile.generatedCount - tile.onlineRetainedCount,
      );
      assert.equal(
        tile.passDroppedCount,
        tile.onlineRetainedCount - tile.retainedCount,
      );
      assert.equal(
        tile.droppedCount,
        tile.generatedCount - tile.retainedCount,
      );
      assert.equal(
        tile.budgetHit,
        tile.droppedCount > 0,
      );
      assert.equal(
        tile.globalDroppedCount,
        tile.retainedCount -
          tile.globallyRetainedCount,
      );
      assert.equal(
        tile.globalBudgetHit,
        tile.globalDroppedCount > 0,
      );
    }
  }
  assert.ok(
    elapsedMs < 2500,
    `bounded FHD storm detection took ${elapsedMs.toFixed(1)} ms`,
  );
});

test("cheap topology keeps a lower-ink multi-turn waveform ahead of larger closed shapes in one tile", () => {
  const width = 1920;
  const height = 1080;
  const mask = new Uint8Array(width * height);
  let previousX = 425;
  let previousY = 247;
  for (let offset = 1; offset < 42; offset += 1) {
    const x = 425 + offset;
    const y = Math.round(
      247 -
        Math.cos((offset / 41) * Math.PI * 6) * 8,
    );
    drawLine(
      mask,
      width,
      height,
      previousX,
      previousY,
      x,
      y,
    );
    previousX = x;
    previousY = y;
  }
  for (let index = 0; index < 35; index += 1) {
    drawEllipse(
      mask,
      width,
      height,
      28 + (index % 7) * 57,
      25 + Math.floor(index / 7) * 45,
      19 + (index % 3),
      12 + (index % 2),
    );
  }

  const result = detectChartPanelsFromMask(
    mask,
    width,
    height,
    { fallbackToWholeImage: false },
  );
  const recovery =
    result.diagnostics.arbitraryWaveformRecovery;
  const crowdedPasses = recovery.proposalPasses.filter(
    (pass) =>
      pass.tiles[0].generatedCount >
      pass.tiles[0].onlineRetainedCount,
  );

  assert.ok(crowdedPasses.length >= 1);
  assert.ok(
    crowdedPasses.every(
      (pass) =>
        pass.tiles[0].onlineRetainedCount === 32,
    ),
  );
  assert.ok(
    recovery.recoveredCandidateCount >= 1,
    "the real multi-turn component must reach full Curve validation",
  );
});

test("Curve measurement budget validates both stages for all 384 globally retained proposals", () => {
  const width = 1920;
  const height = 1080;
  const mask = new Uint8Array(width * height);
  for (let tileRow = 0; tileRow < 4; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < 4; tileColumn += 1) {
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 8; column += 1) {
          const left =
            tileColumn * 480 + 12 + column * 55;
          const top =
            tileRow * 270 + 20 + row * 55;
          drawWeakDistribution(mask, width, height, {
            left,
            top,
            right: left + 41,
            bottom: top + 17,
          });
        }
      }
    }
  }

  const result = detectChartPanelsFromMask(
    mask,
    width,
    height,
    { fallbackToWholeImage: false },
  );
  const recovery =
    result.diagnostics.arbitraryWaveformRecovery;

  assert.equal(recovery.boundedProposalCount, 384);
  assert.equal(
    recovery.evaluatedCount,
    recovery.boundedProposalCount,
    "strong early proposals must not starve later spatial tiles",
  );
  assert.equal(
    recovery.curveMeasurementBudget,
    recovery.boundedProposalCount * 2,
  );
  assert.equal(
    recovery.curveMeasurementCount,
    recovery.curveMeasurementBudget,
    "this fixture must exercise both validation stages for every proposal",
  );
  assert.equal(recovery.deniedProposalEvaluationCount, 0);
  assert.equal(recovery.deniedResidualMeasurementCount, 0);
  assert.equal(recovery.deniedOriginalMeasurementCount, 0);
  assert.equal(recovery.deniedCurveMeasurementCount, 0);
  assert.equal(recovery.curveMeasurementBudgetHit, false);
});
