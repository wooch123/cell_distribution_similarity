const GLYPHS = Object.freeze({
  " ": [
    "00000",
    "00000",
    "00000",
    "00000",
    "00000",
    "00000",
    "00000",
  ],
  "0": [
    "01110",
    "10001",
    "10011",
    "10101",
    "11001",
    "10001",
    "01110",
  ],
  "1": [
    "00100",
    "01100",
    "00100",
    "00100",
    "00100",
    "00100",
    "01110",
  ],
  "2": [
    "01110",
    "10001",
    "00001",
    "00010",
    "00100",
    "01000",
    "11111",
  ],
  "3": [
    "11110",
    "00001",
    "00001",
    "01110",
    "00001",
    "00001",
    "11110",
  ],
  "4": [
    "00010",
    "00110",
    "01010",
    "10010",
    "11111",
    "00010",
    "00010",
  ],
  "5": [
    "11111",
    "10000",
    "10000",
    "11110",
    "00001",
    "00001",
    "11110",
  ],
  "6": [
    "01110",
    "10000",
    "10000",
    "11110",
    "10001",
    "10001",
    "01110",
  ],
  "7": [
    "11111",
    "00001",
    "00010",
    "00100",
    "01000",
    "01000",
    "01000",
  ],
  "8": [
    "01110",
    "10001",
    "10001",
    "01110",
    "10001",
    "10001",
    "01110",
  ],
  "9": [
    "01110",
    "10001",
    "10001",
    "01111",
    "00001",
    "00001",
    "01110",
  ],
  A: [
    "01110",
    "10001",
    "10001",
    "11111",
    "10001",
    "10001",
    "10001",
  ],
  B: [
    "11110",
    "10001",
    "10001",
    "11110",
    "10001",
    "10001",
    "11110",
  ],
  C: [
    "01111",
    "10000",
    "10000",
    "10000",
    "10000",
    "10000",
    "01111",
  ],
  D: [
    "11110",
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "11110",
  ],
  E: [
    "11111",
    "10000",
    "10000",
    "11110",
    "10000",
    "10000",
    "11111",
  ],
  G: [
    "01111",
    "10000",
    "10000",
    "10111",
    "10001",
    "10001",
    "01111",
  ],
  I: [
    "11111",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
    "11111",
  ],
  L: [
    "10000",
    "10000",
    "10000",
    "10000",
    "10000",
    "10000",
    "11111",
  ],
  M: [
    "10001",
    "11011",
    "10101",
    "10101",
    "10001",
    "10001",
    "10001",
  ],
  N: [
    "10001",
    "11001",
    "11001",
    "10101",
    "10011",
    "10011",
    "10001",
  ],
  O: [
    "01110",
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "01110",
  ],
  R: [
    "11110",
    "10001",
    "10001",
    "11110",
    "10100",
    "10010",
    "10001",
  ],
  S: [
    "01111",
    "10000",
    "10000",
    "01110",
    "00001",
    "00001",
    "11110",
  ],
  T: [
    "11111",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
  ],
  U: [
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "01110",
  ],
  V: [
    "10001",
    "10001",
    "10001",
    "10001",
    "10001",
    "01010",
    "00100",
  ],
  W: [
    "10001",
    "10001",
    "10001",
    "10101",
    "10101",
    "11011",
    "10001",
  ],
});

function setPixel(mask, width, height, x, y) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  mask[y * width + x] = 1;
}

function drawLine(
  mask,
  width,
  height,
  x1,
  y1,
  x2,
  y2,
  thickness = 1,
) {
  const steps = Math.max(
    1,
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
  );
  const radius = Math.max(0, Math.floor((thickness - 1) / 2));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        setPixel(mask, width, height, x + offsetX, y + offsetY);
      }
    }
  }
}

function drawGlyph(
  mask,
  width,
  height,
  glyph,
  left,
  top,
  scale,
  weight,
) {
  const pattern = GLYPHS[glyph] ?? GLYPHS[" "];
  const point = (column, row) => ({
    x: left + Math.round((column + 0.5) * scale),
    y: top + Math.round((row + 0.5) * scale),
  });
  for (let row = 0; row < pattern.length; row += 1) {
    for (let column = 0; column < pattern[row].length; column += 1) {
      if (pattern[row][column] !== "1") continue;
      const current = point(column, row);
      setPixel(mask, width, height, current.x, current.y);
      for (const [nextColumn, nextRow] of [
        [column + 1, row],
        [column, row + 1],
        [column + 1, row + 1],
        [column - 1, row + 1],
      ]) {
        if (
          pattern[nextRow]?.[nextColumn] !== "1"
        ) {
          continue;
        }
        const next = point(nextColumn, nextRow);
        drawLine(
          mask,
          width,
          height,
          current.x,
          current.y,
          next.x,
          next.y,
          weight,
        );
      }
    }
  }
}

function drawText(
  mask,
  width,
  height,
  text,
  {
    left,
    top,
    scale,
    weight,
    tracking = 1.35,
  },
) {
  let cursor = left;
  for (const glyph of text.toUpperCase()) {
    drawGlyph(
      mask,
      width,
      height,
      glyph,
      cursor,
      top,
      scale,
      weight,
    );
    cursor += Math.round(scale * (5 + tracking));
  }
}

function drawVectorWGlyph(
  mask,
  width,
  height,
  { left, top, right, bottom, thickness },
) {
  const centerX = Math.round((left + right) / 2);
  const centerY = Math.round(top + (bottom - top) * 0.47);
  const leftValleyX = Math.round(
    left + (right - left) * 0.25,
  );
  const rightValleyX = Math.round(
    left + (right - left) * 0.75,
  );
  drawLine(
    mask,
    width,
    height,
    left,
    top,
    leftValleyX,
    bottom,
    thickness,
  );
  drawLine(
    mask,
    width,
    height,
    leftValleyX,
    bottom,
    centerX,
    centerY,
    thickness,
  );
  drawLine(
    mask,
    width,
    height,
    centerX,
    centerY,
    rightValleyX,
    bottom,
    thickness,
  );
  drawLine(
    mask,
    width,
    height,
    rightValleyX,
    bottom,
    right,
    top,
    thickness,
  );
}

function rotateMaskNearest(mask, width, height, degrees) {
  if (!degrees) return mask.slice();
  const output = new Uint8Array(mask.length);
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const localX = x - centerX;
      const localY = y - centerY;
      const sourceX = Math.round(
        centerX + localX * cosine + localY * sine,
      );
      const sourceY = Math.round(
        centerY - localX * sine + localY * cosine,
      );
      if (
        sourceX >= 0 &&
        sourceX < width &&
        sourceY >= 0 &&
        sourceY < height
      ) {
        output[y * width + x] =
          mask[sourceY * width + sourceX];
      }
    }
  }
  return output;
}

function maskToRgb(mask, foreground = [20, 25, 32]) {
  const pixels = new Uint8Array(mask.length * 3).fill(255);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const offset = index * 3;
    pixels[offset] = foreground[0];
    pixels[offset + 1] = foreground[1];
    pixels[offset + 2] = foreground[2];
  }
  return pixels;
}

function drawDistribution(
  mask,
  width,
  height,
  bounds,
  peakCenters,
  thickness,
) {
  let previous = null;
  const usableHeight = bounds.bottom - bounds.top;
  for (let x = bounds.left; x <= bounds.right; x += 1) {
    const progress =
      (x - bounds.left) /
      Math.max(1, bounds.right - bounds.left);
    let response = 0;
    for (const center of peakCenters) {
      const distance = (progress - center) / 0.09;
      response = Math.max(
        response,
        Math.exp(-0.5 * distance * distance),
      );
    }
    const y = Math.round(
      bounds.bottom - response * usableHeight * 0.86,
    );
    if (previous) {
      drawLine(
        mask,
        width,
        height,
        previous.x,
        previous.y,
        x,
        y,
        thickness,
      );
    }
    previous = { x, y };
  }
}

function drawIndependentStateArches(
  mask,
  width,
  height,
  {
    stateCount = 16,
    gap = 4,
    thickness = 3,
  } = {},
) {
  const margin = Math.max(4, Math.round(width * 0.035));
  const top = Math.round(height * 0.16);
  const bottom = Math.round(height * 0.78);
  const available =
    width - margin * 2 - gap * (stateCount - 1);
  const archWidth = available / stateCount;
  for (let state = 0; state < stateCount; state += 1) {
    const startX =
      margin + state * (archWidth + gap);
    const sampleCount = Math.max(
      6,
      Math.ceil(archWidth * 3),
    );
    let previous = null;
    for (let sample = 0; sample <= sampleCount; sample += 1) {
      const progress = sample / sampleCount;
      const normalizedX = progress * 2 - 1;
      const point = {
        x: Math.round(startX + progress * archWidth),
        y: Math.round(
          top +
            normalizedX * normalizedX * (bottom - top),
        ),
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
          thickness,
        );
      }
      previous = point;
    }
  }
}

function drawConnectedScriptTitle(
  mask,
  width,
  height,
) {
  const humpCount = 8;
  const humpWidth = Math.round(width * 0.05);
  const totalWidth = humpCount * humpWidth;
  const left = Math.round((width - totalWidth) / 2);
  const top = Math.round(height * 0.467);
  const bottom = Math.round(height * 0.622);
  const thickness = Math.max(9, Math.round(height * 0.029));
  for (let hump = 0; hump < humpCount; hump += 1) {
    let previous = null;
    for (let sample = 0; sample <= humpWidth; sample += 1) {
      const progress = sample / humpWidth;
      const normalizedX = progress * 2 - 1;
      const point = {
        x: left + hump * humpWidth + sample,
        y: Math.round(
          top +
            normalizedX * normalizedX * (bottom - top),
        ),
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
          thickness,
        );
      }
      previous = point;
    }
  }
}

function drawChartFrame(mask, width, height, bounds) {
  drawLine(
    mask,
    width,
    height,
    bounds.left,
    bounds.top,
    bounds.right,
    bounds.top,
    2,
  );
  drawLine(
    mask,
    width,
    height,
    bounds.left,
    bounds.bottom,
    bounds.right,
    bounds.bottom,
    2,
  );
  drawLine(
    mask,
    width,
    height,
    bounds.left,
    bounds.top,
    bounds.left,
    bounds.bottom,
    2,
  );
  drawLine(
    mask,
    width,
    height,
    bounds.right,
    bounds.top,
    bounds.right,
    bounds.bottom,
    2,
  );
}

export function largeTextOnlyFixtures() {
  const definitions = [
    {
      name: "large-heavy-title",
      width: 960,
      height: 300,
      lines: [
        {
          text: "MARGIN WINDOW",
          left: 34,
          top: 92,
          scale: 11,
          weight: 7,
        },
      ],
      rotation: 0,
    },
    {
      name: "large-normal-title-rotated-positive",
      width: 960,
      height: 360,
      lines: [
        {
          text: "READ DISTURB",
          left: 55,
          top: 116,
          scale: 10,
          weight: 3,
        },
      ],
      rotation: 9,
    },
    {
      name: "large-heavy-title-rotated-negative",
      width: 900,
      height: 360,
      lines: [
        {
          text: "V NAND MARGIN",
          left: 45,
          top: 118,
          scale: 10,
          weight: 7,
        },
      ],
      rotation: -11,
    },
    {
      name: "large-numeric-body-row",
      width: 1100,
      height: 340,
      lines: [
        {
          text: "1234567890",
          left: 140,
          top: 105,
          scale: 13,
          weight: 5,
        },
      ],
      rotation: 0,
    },
    {
      name: "large-two-glyph-heading",
      width: 800,
      height: 450,
      lines: [
        {
          text: "WW",
          left: 275,
          top: 120,
          scale: 24,
          weight: 5,
        },
      ],
      rotation: 0,
    },
    ...["S", "W", "M", "U", "V"].map((glyph) => ({
      name: `large-single-glyph-${glyph.toLowerCase()}`,
      width: 800,
      height: 450,
      lines: [
        {
          text: glyph,
          left: 292,
          top: 72,
          scale: 42,
          weight: 7,
        },
      ],
      rotation: 0,
    })),
    {
      name: "large-single-vector-glyph-w",
      width: 800,
      height: 450,
      lines: [],
      vectorW: {
        left: 256,
        top: 90,
        right: 544,
        bottom: 360,
        thickness: 6,
      },
      rotation: 0,
    },
    {
      name: "low-resolution-single-glyph-s-rotated",
      width: 240,
      height: 135,
      lines: [
        {
          text: "S",
          left: 88,
          top: 21,
          scale: 13,
          weight: 3,
        },
      ],
      rotation: 11,
    },
    {
      name: "low-resolution-single-vector-glyph-w-rotated",
      width: 240,
      height: 135,
      lines: [],
      vectorW: {
        left: 77,
        top: 27,
        right: 163,
        bottom: 108,
        thickness: 2,
      },
      rotation: 7,
    },
    {
      name: "single-glyph-w-inside-outline-card",
      width: 800,
      height: 450,
      frameMode: "rectangle",
      frameBounds: {
        left: 48,
        top: 42,
        right: 751,
        bottom: 407,
      },
      lines: [
        {
          text: "W",
          left: 291,
          top: 74,
          scale: 42,
          weight: 7,
        },
      ],
      rotation: 0,
    },
    {
      name: "low-resolution-single-glyph-m-in-open-axis-rotated",
      width: 240,
      height: 135,
      frameMode: "l-axis",
      frameBounds: {
        left: 10,
        top: 9,
        right: 229,
        bottom: 124,
      },
      lines: [
        {
          text: "M",
          left: 88,
          top: 21,
          scale: 13,
          weight: 3,
        },
      ],
      rotation: -7,
    },
    {
      name: "small-two-glyph-caption",
      width: 800,
      height: 450,
      lines: [
        {
          text: "VV",
          left: 340,
          top: 190,
          scale: 8,
          weight: 2,
        },
      ],
      rotation: 0,
    },
    {
      name: "large-underlined-title",
      width: 980,
      height: 380,
      lines: [
        {
          text: "QLC V NAND",
          left: 120,
          top: 95,
          scale: 11,
          weight: 4,
        },
      ],
      underlines: [
        {
          left: 112,
          right: 860,
          y: 195,
          thickness: 4,
        },
      ],
      rotation: 0,
    },
    {
      name: "large-multiline-document-copy",
      width: 1200,
      height: 520,
      lines: [
        {
          text: "CELL DISTRIBUTION",
          left: 55,
          top: 56,
          scale: 10,
          weight: 5,
        },
        {
          text: "READ MARGIN 1000",
          left: 110,
          top: 230,
          scale: 8,
          weight: 3,
        },
        {
          text: "RETENTION LOSS",
          left: 280,
          top: 355,
          scale: 7,
          weight: 3,
        },
      ],
      rotation: 4,
    },
    {
      name: "dense-borderless-text-card-matrix",
      width: 1200,
      height: 700,
      lines: Array.from(
        { length: 20 },
        (_unused, index) => {
          const column = index % 4;
          const row = Math.floor(index / 4);
          const left = 72 + column * 292;
          const top = 55 + row * 130;
          return [
            {
              text: "READ MARGIN",
              left,
              top,
              scale: 2,
              weight: 2,
            },
            {
              text: "CELL DATA",
              left,
              top: top + 34,
              scale: 2,
              weight: 2,
            },
            {
              text: "V NAND",
              left,
              top: top + 68,
              scale: 2,
              weight: 2,
            },
          ];
        },
      ).flat(),
      rotation: 0,
    },
    {
      name: "large-text-inside-outline-card",
      width: 800,
      height: 450,
      frameMode: "rectangle",
      frameBounds: {
        left: 50,
        top: 70,
        right: 749,
        bottom: 369,
      },
      lines: [
        {
          text: "SIMILAR SEARCH",
          left: 72,
          top: 158,
          scale: 9,
          weight: 7,
        },
      ],
      rotation: 0,
    },
    {
      name: "large-text-inside-open-axis-card",
      width: 900,
      height: 500,
      frameMode: "l-axis",
      frameBounds: {
        left: 65,
        top: 75,
        right: 835,
        bottom: 420,
      },
      lines: [
        {
          text: "QUALITY VISION",
          left: 82,
          top: 170,
          scale: 9,
          weight: 5,
        },
      ],
      rotation: 0,
    },
    {
      name: "large-connected-script-mmmm-title",
      width: 800,
      height: 450,
      lines: [],
      connectedScript: true,
      rotation: 0,
    },
  ];

  return definitions.map((definition) => {
    const sourceMask = new Uint8Array(
      definition.width * definition.height,
    );
    if (definition.frameMode === "rectangle") {
      drawChartFrame(
        sourceMask,
        definition.width,
        definition.height,
        definition.frameBounds,
      );
    } else if (definition.frameMode === "l-axis") {
      drawLine(
        sourceMask,
        definition.width,
        definition.height,
        definition.frameBounds.left,
        definition.frameBounds.top,
        definition.frameBounds.left,
        definition.frameBounds.bottom,
        3,
      );
      drawLine(
        sourceMask,
        definition.width,
        definition.height,
        definition.frameBounds.left,
        definition.frameBounds.bottom,
        definition.frameBounds.right,
        definition.frameBounds.bottom,
        3,
      );
    }
    for (const line of definition.lines) {
      drawText(
        sourceMask,
        definition.width,
        definition.height,
        line.text,
        line,
      );
    }
    if (definition.vectorW) {
      drawVectorWGlyph(
        sourceMask,
        definition.width,
        definition.height,
        definition.vectorW,
      );
    }
    if (definition.connectedScript) {
      drawConnectedScriptTitle(
        sourceMask,
        definition.width,
        definition.height,
      );
    }
    for (const underline of definition.underlines ?? []) {
      drawLine(
        sourceMask,
        definition.width,
        definition.height,
        underline.left,
        underline.y,
        underline.right,
        underline.y,
        underline.thickness,
      );
    }
    const mask = rotateMaskNearest(
      sourceMask,
      definition.width,
      definition.height,
      definition.rotation,
    );
    return {
      ...definition,
      mask,
      pixels: maskToRgb(mask),
      channels: 3,
    };
  });
}

export function chartsWithLargeLabelsFixtures() {
  return [
    {
      name: "single-peak-chart-with-heavy-title",
      width: 960,
      height: 540,
      bounds: {
        left: 95,
        top: 155,
        right: 865,
        bottom: 485,
      },
      peaks: [0.5],
      label: {
        text: "V NAND RETENTION",
        left: 85,
        top: 35,
        scale: 9,
        weight: 7,
      },
    },
    {
      name: "multi-peak-chart-with-large-axis-copy",
      width: 1120,
      height: 620,
      bounds: {
        left: 115,
        top: 100,
        right: 1035,
        bottom: 515,
      },
      peaks: [0.14, 0.31, 0.49, 0.68, 0.86],
      label: {
        text: "READ MARGIN",
        left: 270,
        top: 525,
        scale: 7,
        weight: 5,
      },
    },
  ].map((definition) => {
    const mask = new Uint8Array(
      definition.width * definition.height,
    );
    drawChartFrame(
      mask,
      definition.width,
      definition.height,
      definition.bounds,
    );
    drawDistribution(
      mask,
      definition.width,
      definition.height,
      {
        left: definition.bounds.left + 24,
        top: definition.bounds.top + 22,
        right: definition.bounds.right - 24,
        bottom: definition.bounds.bottom - 20,
      },
      definition.peaks,
      3,
    );
    drawText(
      mask,
      definition.width,
      definition.height,
      definition.label.text,
      definition.label,
    );
    return {
      ...definition,
      mask,
      pixels: maskToRgb(mask),
      channels: 3,
    };
  });
}

export function denseIndependentStateArrayFixtures() {
  return [
    {
      name: "dense-independent-states-320",
      width: 320,
      height: 180,
      gap: 4,
      thickness: 3,
    },
  ].map((definition) => {
    const mask = new Uint8Array(
      definition.width * definition.height,
    );
    drawIndependentStateArches(
      mask,
      definition.width,
      definition.height,
      {
        stateCount: 16,
        gap: definition.gap,
        thickness: definition.thickness,
      },
    );
    return {
      ...definition,
      expectedStateCount: 16,
      mask,
      pixels: maskToRgb(mask),
      channels: 3,
    };
  });
}
