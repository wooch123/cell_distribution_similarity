const WIDTH = 900;
const HEIGHT = 540;

function paintPixel(state, x, y, options = {}) {
  if (
    x < 0 ||
    x >= state.width ||
    y < 0 ||
    y >= state.height
  ) {
    return;
  }
  const index = y * state.width + x;
  if (options.broad !== false) state.broadMask[index] = 1;
  if (options.salient !== false) {
    state.salientMask[index] = 1;
  }
  if (options.curve === true) state.curveMask[index] = 1;
  if (Number.isInteger(options.colorIndex)) {
    state.curveColorMasks[options.colorIndex][index] = 1;
  }
}

function drawLine(
  state,
  x1,
  y1,
  x2,
  y2,
  options = {},
  radius = 0,
) {
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
    for (
      let localY = y - radius;
      localY <= y + radius;
      localY += 1
    ) {
      for (
        let localX = x - radius;
        localX <= x + radius;
        localX += 1
      ) {
        paintPixel(
          state,
          localX,
          localY,
          options,
        );
      }
    }
  }
}

/**
 * Six boxed dashboard/KPI plots that deliberately satisfy the former
 * cohort's frame, grid, colour, coverage and turn-count gates. Their
 * sinusoidal traces float into and out of each plot instead of terminating
 * at both log-density floors, so they are not VTH distributions.
 */
export function closedFrameKpiSineCohortFixture() {
  const pixelCount = WIDTH * HEIGHT;
  const state = {
    width: WIDTH,
    height: HEIGHT,
    broadMask: new Uint8Array(pixelCount),
    salientMask: new Uint8Array(pixelCount),
    curveMask: new Uint8Array(pixelCount),
    curveColorMasks: Array.from(
      { length: 3 },
      () => new Uint8Array(pixelCount),
    ),
  };
  const charts = [];
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const left = 20 + column * 292;
      const top = 20 + row * 250;
      const right = left + 270;
      const bottom = top + 225;
      const bounds = { left, top, right, bottom };
      charts.push(bounds);
      for (const [x1, y1, x2, y2] of [
        [left, top, right, top],
        [left, bottom, right, bottom],
        [left, top, left, bottom],
        [right, top, right, bottom],
      ]) {
        drawLine(state, x1, y1, x2, y2, {}, 1);
      }
      for (const ratio of [0.25, 0.5, 0.75]) {
        const guideY = Math.round(
          top + (bottom - top) * ratio,
        );
        const guideX = Math.round(
          left + (right - left) * ratio,
        );
        drawLine(
          state,
          left,
          guideY,
          right,
          guideY,
        );
        drawLine(
          state,
          guideX,
          top,
          guideX,
          bottom,
        );
      }

      const colorIndex = (row * 3 + column) % 3;
      let previous = null;
      for (let sample = 0; sample <= 230; sample += 1) {
        const progress = sample / 230;
        const current = {
          x: Math.round(
            left + 20 + progress * (right - left - 40),
          ),
          y: Math.round(
            (top + bottom) / 2 +
              Math.sin(progress * Math.PI * 6) *
                (bottom - top) *
                0.28,
          ),
        };
        if (previous) {
          drawLine(
            state,
            previous.x,
            previous.y,
            current.x,
            current.y,
            {
              curve: true,
              colorIndex,
            },
            1,
          );
        }
        previous = current;
      }
    }
  }
  return {
    name: "closed-frame-grid-coloured-kpi-sine-2x3",
    ...state,
    charts,
    expectedChartCount: 0,
  };
}

/**
 * A one-sided 2.5-cycle cosine KPI cohort. Every trace begins high at the
 * physical left frame and terminates at the right-side floor, so mere frame
 * contact must not reinterpret its two interior oscillation peaks as a VTH
 * distribution.
 */
export function closedFrameOneSidedKpiCosineCohortFixture() {
  const state = closedFrameKpiSineCohortFixture();
  for (let index = 0; index < state.curveMask.length; index += 1) {
    if (!state.curveMask[index]) continue;
    state.broadMask[index] = 0;
    state.salientMask[index] = 0;
    state.curveMask[index] = 0;
    for (const colorMask of state.curveColorMasks) {
      colorMask[index] = 0;
    }
  }

  for (
    let chartIndex = 0;
    chartIndex < state.charts.length;
    chartIndex += 1
  ) {
    const bounds = state.charts[chartIndex];
    const colorIndex = chartIndex % state.curveColorMasks.length;
    let previous = null;
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const progress =
        (x - bounds.left) /
        Math.max(1, bounds.right - bounds.left);
      const response =
        0.5 + 0.5 * Math.cos(5 * Math.PI * progress);
      const current = {
        x,
        y: Math.round(
          bounds.top +
            (bounds.bottom - bounds.top) *
              (0.09 + 0.69 * (1 - response)),
        ),
      };
      if (previous) {
        drawLine(
          state,
          previous.x,
          previous.y,
          current.x,
          current.y,
          {
            curve: true,
            colorIndex,
          },
          1,
        );
      }
      previous = current;
    }
  }
  return {
    ...state,
    name: "closed-frame-one-sided-kpi-cosine-2x3",
    expectedChartCount: 0,
  };
}

/**
 * Six real three-State max-Gaussian distributions whose visible x-range
 * clips exactly one outer tail at the physical plot boundary. Left and right
 * clipping alternate across the board and minor width/height changes avoid a
 * single hard-coded trace signature.
 */
export function closedFrameClippedTailVthCohortFixture() {
  const pixelCount = WIDTH * HEIGHT;
  const state = {
    width: WIDTH,
    height: HEIGHT,
    broadMask: new Uint8Array(pixelCount),
    salientMask: new Uint8Array(pixelCount),
    curveMask: new Uint8Array(pixelCount),
    curveColorMasks: Array.from(
      { length: 3 },
      () => new Uint8Array(pixelCount),
    ),
  };
  const charts = [];
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const chartIndex = row * 3 + column;
      const left = 20 + column * 292;
      const top = 20 + row * 250;
      const right = left + 270;
      const bottom = top + 225;
      const clipSide =
        chartIndex % 2 === 0 ? "left" : "right";
      const bounds = {
        left,
        top,
        right,
        bottom,
      };
      charts.push({
        ...bounds,
        clipSide,
        peakCount: 3,
      });
      for (const [x1, y1, x2, y2] of [
        [left, top, right, top],
        [left, bottom, right, bottom],
        [left, top, left, bottom],
        [right, top, right, bottom],
      ]) {
        drawLine(state, x1, y1, x2, y2, {}, 1);
      }
      for (const ratio of [0.25, 0.5, 0.75]) {
        const guideY = Math.round(
          top + (bottom - top) * ratio,
        );
        const guideX = Math.round(
          left + (right - left) * ratio,
        );
        drawLine(
          state,
          left,
          guideY,
          right,
          guideY,
        );
        drawLine(
          state,
          guideX,
          top,
          guideX,
          bottom,
        );
      }

      const centers =
        clipSide === "left"
          ? [0.03, 0.4, 0.74]
          : [0.26, 0.6, 0.97];
      const sigma = 0.066 + (chartIndex % 3) * 0.004;
      const baseline =
        top + (bottom - top) * (0.755 + (chartIndex % 2) * 0.012);
      const amplitude = (bottom - top) * 0.61;
      const colorIndex = chartIndex % 3;
      let previous = null;
      for (let x = left; x <= right; x += 1) {
        const progress =
          (x - left) / Math.max(1, right - left);
        const response = Math.max(
          ...centers.map((center, peakIndex) => {
            const localAmplitude =
              0.92 + ((peakIndex + chartIndex) % 3) * 0.04;
            return (
              localAmplitude *
              Math.exp(
                -0.5 *
                  ((progress - center) / sigma) ** 2,
              )
            );
          }),
        );
        const current = {
          x,
          y: Math.round(
            baseline - Math.min(1, response) * amplitude,
          ),
        };
        if (previous) {
          drawLine(
            state,
            previous.x,
            previous.y,
            current.x,
            current.y,
            {
              curve: true,
              colorIndex,
            },
            1,
          );
        }
        previous = current;
      }
    }
  }
  return {
    name: "closed-frame-grid-one-sided-clipped-vth-2x3",
    ...state,
    charts,
    expectedChartCount: 6,
    expectedStateCount: 3,
  };
}
