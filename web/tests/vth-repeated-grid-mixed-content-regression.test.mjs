import assert from "node:assert/strict";
import test from "node:test";

import { detectChartPanels } from "../lib/vth-chart-panel-core.mjs";

function mixedOfficeTileGrid(tileMode = "rectangle") {
  const width = 900;
  const height = 540;
  const rows = 4;
  const columns = 5;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const color = [20, 100, 185];

  function put(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 3;
    rgb[offset] = color[0];
    rgb[offset + 1] = color[1];
    rgb[offset + 2] = color[2];
  }

  function line(x1, y1, x2, y2, thickness = 2) {
    const steps = Math.max(
      Math.abs(x2 - x1),
      Math.abs(y2 - y1),
      1,
    );
    for (let step = 0; step <= steps; step += 1) {
      const x = Math.round(
        x1 + ((x2 - x1) * step) / steps,
      );
      const y = Math.round(
        y1 + ((y2 - y1) * step) / steps,
      );
      for (let dy = 0; dy < thickness; dy += 1) {
        for (let dx = 0; dx < thickness; dx += 1) {
          put(x + dx, y + dy);
        }
      }
    }
  }

  const left = 65;
  const right = 835;
  const top = 55;
  const bottom = 485;
  const cellWidth = (right - left) / columns;
  const cellHeight = (bottom - top) / rows;
  const rectangleCenters = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const insetLeft =
        left + column * cellWidth + 12;
      const insetRight =
        left + (column + 1) * cellWidth - 12;
      const baseline =
        top + (row + 1) * cellHeight - 15;
      if (index % 2 === 0) {
        let previous = null;
        for (
          let x = Math.round(insetLeft);
          x <= Math.round(insetRight);
          x += 1
        ) {
          const progress =
            (x - insetLeft) / (insetRight - insetLeft);
          const response = Math.exp(
            -0.5 * ((progress - 0.48) / 0.14) ** 2,
          );
          const y = Math.round(
            baseline - response * cellHeight * 0.62,
          );
          if (previous) {
            line(previous.x, previous.y, x, y);
          }
          previous = { x, y };
        }
      } else {
        const badgeTop =
          baseline - cellHeight * 0.58;
        const badgeBottom =
          baseline - cellHeight * 0.18;
        if (tileMode === "diagonal") {
          line(
            Math.round(insetLeft),
            Math.round(badgeBottom),
            Math.round(insetRight),
            Math.round(badgeTop),
            3,
          );
        } else {
          for (
            let y = Math.round(badgeTop);
            y <= Math.round(badgeBottom);
            y += 1
          ) {
            for (
              let x = Math.round(insetLeft);
              x <= Math.round(insetRight);
              x += 1
            ) {
              put(x, y);
            }
          }
        }
        rectangleCenters.push({
          x: (insetLeft + insetRight) / 2,
          y: (badgeTop + badgeBottom) / 2,
        });
      }
    }
  }
  return { rgb, width, height, rectangleCenters };
}

for (const tileMode of ["rectangle", "diagonal"]) {
test(`does not promote a regular matrix of coloured ${tileMode} office tiles into waveform panels`, () => {
  const sample = mixedOfficeTileGrid(tileMode);
  const detected = detectChartPanels(
    sample.rgb,
    sample.width,
    sample.height,
    3,
  );

  assert.equal(
    detected.diagnostics.repeatedGridRecovery.applied,
    false,
  );
  assert.ok(
    detected.panels.length <= 10,
    `only the ten Gaussian traces may remain, received ${detected.panels.length}`,
  );
  assert.equal(
    detected.panels.some(
      (panel) =>
        panel.detectionReason === "repeated-waveform-grid",
    ),
    false,
  );
  for (const center of sample.rectangleCenters) {
    assert.equal(
      detected.panels.some(
        (panel) =>
          center.x >= panel.left &&
          center.x <= panel.right &&
          center.y >= panel.top &&
          center.y <= panel.bottom,
      ),
      false,
      `${tileMode} guide at (${center.x}, ${center.y}) must not be returned as a waveform panel`,
    );
  }
});
}
