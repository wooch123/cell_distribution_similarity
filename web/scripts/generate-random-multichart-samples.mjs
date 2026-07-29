import { mkdir, writeFile } from "node:fs/promises";

import { encode as encodePng } from "fast-png";

const OUTPUT_DIRECTORY = new URL("../public/samples/", import.meta.url);

const COLORS = {
  paper: [246, 248, 251],
  paperBlue: [239, 245, 250],
  white: [255, 255, 255],
  ink: [35, 46, 60],
  muted: [101, 116, 132],
  border: [185, 198, 211],
  grid: [219, 226, 233],
  blue: [39, 107, 179],
  orange: [221, 126, 45],
  green: [45, 145, 104],
  red: [198, 62, 68],
  violet: [122, 84, 174],
  teal: [30, 137, 145],
  gold: [205, 157, 37],
  photoDark: [57, 74, 94],
  photoMid: [104, 139, 163],
  photoLight: [181, 205, 216],
};

const SAMPLE_DEFINITIONS = [
  {
    fileName: "vnand-random-multichart-mixed-01.png",
    width: 1600,
    height: 900,
    background: COLORS.paper,
    charts: [
      [50, 84, 430, 258],
      [520, 38, 880, 238],
      [1080, 82, 1510, 280],
      [92, 372, 470, 575],
      [602, 318, 1040, 535],
      [1120, 405, 1530, 625],
      [330, 658, 760, 850],
      [1052, 690, 1518, 858],
    ],
    table: [28, 645, 270, 842],
    diagram: [800, 650, 1000, 848],
    photo: [918, 52, 1040, 250],
  },
  {
    fileName: "vnand-random-multichart-mixed-02.png",
    width: 1440,
    height: 810,
    background: COLORS.paperBlue,
    charts: [
      [34, 66, 500, 310],
      {
        bounds: [570, 40, 715, 138],
        peakCenters: [0.5],
        peakWidth: 0.115,
      },
      [990, 70, 1390, 282],
      [52, 386, 292, 522],
      [390, 330, 890, 570],
      [1035, 370, 1380, 552],
      [42, 640, 300, 786],
      [520, 618, 910, 790],
    ],
    table: [1005, 620, 1392, 790],
    diagram: [325, 630, 475, 790],
    photo: [770, 45, 930, 205],
  },
  {
    fileName: "vnand-random-multichart-lowres-03.png",
    width: 640,
    height: 360,
    background: COLORS.paper,
    charts: [
      [8, 20, 155, 95],
      [205, 7, 365, 92],
      [450, 20, 630, 105],
      [45, 150, 210, 240],
      [280, 130, 445, 220],
      [180, 265, 350, 350],
      [470, 250, 635, 345],
    ],
    table: [5, 265, 150, 350],
    diagram: [470, 130, 625, 220],
    photo: [220, 110, 262, 238],
  },
  {
    fileName: "vnand-random-multichart-frameless-04.png",
    width: 1440,
    height: 820,
    background: COLORS.white,
    frameless: true,
    charts: [
      {
        bounds: [30, 42, 392, 215],
        peakCenters: [0.16, 0.42, 0.7, 0.88],
      },
      {
        bounds: [430, 20, 680, 155],
        peakCenters: [0.5],
        peakWidth: 0.13,
      },
      {
        bounds: [735, 56, 1385, 270],
        peakCenters: [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.92],
      },
      {
        bounds: [55, 310, 250, 430],
        peakCenters: [0.49],
        peakWidth: 0.125,
      },
      {
        // A fourteen-pixel gutter is the only boundary between these curves.
        bounds: [264, 290, 570, 455],
        peakCenters: [0.15, 0.38, 0.62, 0.85],
      },
      {
        bounds: [650, 350, 915, 650],
        peakCenters: [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.92],
      },
      {
        bounds: [940, 305, 1290, 490],
        peakCenters: [0.5],
        peakWidth: 0.13,
      },
      {
        bounds: [105, 555, 500, 765],
        peakCenters: [0.16, 0.42, 0.69, 0.88],
      },
    ],
  },
];

function createCanvas(definition) {
  const rgb = new Uint8Array(
    definition.width * definition.height * 3,
  );

  const setPixel = (x, y, color) => {
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if (
      roundedX < 0 ||
      roundedX >= definition.width ||
      roundedY < 0 ||
      roundedY >= definition.height
    ) {
      return;
    }
    const offset =
      (roundedY * definition.width + roundedX) * 3;
    rgb[offset] = color[0];
    rgb[offset + 1] = color[1];
    rgb[offset + 2] = color[2];
  };

  const fillRect = (left, top, right, bottom, color) => {
    for (
      let y = Math.max(0, Math.round(top));
      y <= Math.min(definition.height - 1, Math.round(bottom));
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.round(left));
        x <= Math.min(definition.width - 1, Math.round(right));
        x += 1
      ) {
        setPixel(x, y, color);
      }
    }
  };

  const drawLine = (
    x1,
    y1,
    x2,
    y2,
    color,
    thickness = 1,
  ) => {
    const steps = Math.max(
      Math.abs(x2 - x1),
      Math.abs(y2 - y1),
      1,
    );
    const radius = Math.max(0, Math.floor(thickness / 2));
    for (let step = 0; step <= steps; step += 1) {
      const x = Math.round(x1 + ((x2 - x1) * step) / steps);
      const y = Math.round(y1 + ((y2 - y1) * step) / steps);
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
          setPixel(localX, localY, color);
        }
      }
    }
  };

  const drawRect = (
    left,
    top,
    right,
    bottom,
    color,
    thickness = 1,
  ) => {
    for (let offset = 0; offset < thickness; offset += 1) {
      drawLine(
        left + offset,
        top + offset,
        right - offset,
        top + offset,
        color,
      );
      drawLine(
        left + offset,
        bottom - offset,
        right - offset,
        bottom - offset,
        color,
      );
      drawLine(
        left + offset,
        top + offset,
        left + offset,
        bottom - offset,
        color,
      );
      drawLine(
        right - offset,
        top + offset,
        right - offset,
        bottom - offset,
        color,
      );
    }
  };

  const drawTextBars = (
    left,
    top,
    maximumWidth,
    rows,
    color = COLORS.muted,
    scale = 1,
  ) => {
    for (let row = 0; row < rows; row += 1) {
      const width =
        maximumWidth *
        (0.56 + ((row * 17 + left + top) % 39) / 100);
      const y = top + row * 7 * scale;
      for (
        let cursor = left;
        cursor < left + width;
        cursor += 8 * scale
      ) {
        drawLine(
          cursor,
          y,
          Math.min(cursor + 5 * scale, left + width),
          y,
          color,
          scale,
        );
      }
    }
  };

  const densityAt = (progress, chartIndex, chartDefinition) => {
    const explicitPeakCenters = Array.isArray(
      chartDefinition?.peakCenters,
    )
      ? chartDefinition.peakCenters
      : null;
    const stateCount =
      explicitPeakCenters?.length ??
      (chartIndex % 3 === 0 ? 4 : 8);
    const left = 0.065;
    const right = 0.935;
    const spacing =
      stateCount > 1 ? (right - left) / (stateCount - 1) : 0;
    let density = 0;
    for (let state = 0; state < stateCount; state += 1) {
      const center =
        explicitPeakCenters?.[state] ??
        (left +
          state * spacing +
          Math.sin((chartIndex + 2) * (state + 1)) *
            spacing *
            0.018);
      const defaultPeakWidth =
        stateCount === 1
          ? 0.115
          : spacing * (stateCount === 4 ? 0.105 : 0.16);
      const asymmetricWidth =
        (chartDefinition?.peakWidth ?? defaultPeakWidth) *
        (progress < center ? 0.88 : 1.12);
      const z = (progress - center) / asymmetricWidth;
      density +=
        (0.78 + ((chartIndex + state * 3) % 5) * 0.04) *
        Math.exp(-0.5 * z * z);
    }
    return Math.max(1e-6, Math.min(1, density));
  };

  const drawChart = (chartDefinition, chartIndex) => {
    const bounds = Array.isArray(chartDefinition)
      ? chartDefinition
      : chartDefinition.bounds;
    const [left, top, right, bottom] = bounds;
    const width = right - left;
    const height = bottom - top;
    const scale = Math.max(
      1,
      Math.round(Math.min(definition.width, definition.height) / 700),
    );
    fillRect(left, top, right, bottom, COLORS.white);
    drawRect(left, top, right, bottom, COLORS.border, scale);
    drawTextBars(
      left + 7 * scale,
      top + 7 * scale,
      width * 0.42,
      1,
      COLORS.ink,
      scale,
    );

    const plotLeft = left + Math.max(8, width * 0.09);
    const plotRight = right - Math.max(5, width * 0.025);
    const plotTop = top + Math.max(15, height * 0.2);
    const plotBottom = bottom - Math.max(8, height * 0.1);
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;

    for (let grid = 1; grid < 5; grid += 1) {
      const y = plotTop + (plotHeight * grid) / 5;
      drawLine(plotLeft, y, plotRight, y, COLORS.grid);
    }
    for (let grid = 1; grid < 6; grid += 1) {
      const x = plotLeft + (plotWidth * grid) / 6;
      drawLine(x, plotTop, x, plotBottom, COLORS.grid);
    }
    drawRect(
      plotLeft,
      plotTop,
      plotRight,
      plotBottom,
      COLORS.ink,
      Math.max(1, scale),
    );

    const curveColors = [
      COLORS.blue,
      COLORS.orange,
      COLORS.green,
      COLORS.red,
      COLORS.violet,
      COLORS.teal,
      COLORS.gold,
      COLORS.blue,
    ];
    const stateCount =
      chartDefinition?.peakCenters?.length ??
      (chartIndex % 3 === 0 ? 4 : 8);
    let previous = null;
    for (
      let localX = Math.max(2, scale);
      localX <= plotWidth - Math.max(2, scale);
      localX += 1
    ) {
      const progress = localX / plotWidth;
      const density = densityAt(
        progress,
        chartIndex,
        chartDefinition,
      );
      const logDensity = Math.max(-6, Math.log10(density));
      const y =
        plotTop + ((0 - logDensity) / 6) * plotHeight;
      const stateIndex = Math.min(
        stateCount - 1,
        Math.floor(progress * stateCount),
      );
      const point = {
        x: plotLeft + localX,
        y,
      };
      if (previous) {
        drawLine(
          previous.x,
          previous.y,
          point.x,
          point.y,
          curveColors[stateIndex],
          Math.max(1, scale),
        );
      }
      previous = point;
    }
  };

  const drawFramelessChart = (chartDefinition, chartIndex) => {
    const [left, top, right, bottom] = chartDefinition.bounds;
    const plotWidth = right - left;
    const plotHeight = bottom - top;
    const stateCount = chartDefinition.peakCenters.length;
    const curveColors = [
      COLORS.blue,
      COLORS.orange,
      COLORS.green,
      COLORS.red,
      COLORS.violet,
      COLORS.teal,
      COLORS.gold,
      COLORS.blue,
    ];
    let previous = null;

    for (let localX = 0; localX <= plotWidth; localX += 1) {
      const progress = localX / Math.max(1, plotWidth);
      const density = densityAt(
        progress,
        chartIndex,
        chartDefinition,
      );
      const logDensity = Math.max(-6, Math.log10(density));
      const point = {
        x: left + localX,
        y: top + ((0 - logDensity) / 6) * plotHeight,
      };
      const stateIndex = Math.min(
        stateCount - 1,
        Math.floor(progress * stateCount),
      );
      if (previous) {
        drawLine(
          previous.x,
          previous.y,
          point.x,
          point.y,
          curveColors[stateIndex],
          2,
        );
      }
      previous = point;
    }
  };

  const drawTable = ([left, top, right, bottom]) => {
    fillRect(left, top, right, bottom, COLORS.white);
    drawRect(left, top, right, bottom, COLORS.ink, 2);
    const columns = 4;
    const rows = 5;
    for (let column = 1; column < columns; column += 1) {
      const x = left + ((right - left) * column) / columns;
      drawLine(x, top, x, bottom, COLORS.ink);
    }
    for (let row = 1; row < rows; row += 1) {
      const y = top + ((bottom - top) * row) / rows;
      drawLine(left, y, right, y, COLORS.ink);
    }
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const cellLeft =
          left + ((right - left) * column) / columns;
        const cellTop =
          top + ((bottom - top) * row) / rows;
        drawTextBars(
          cellLeft + 5,
          cellTop + 9,
          (right - left) / columns - 12,
          2,
          COLORS.muted,
        );
      }
    }
  };

  const drawDiagram = ([left, top, right, bottom]) => {
    fillRect(left, top, right, bottom, COLORS.white);
    const width = right - left;
    const height = bottom - top;
    const boxes = [
      [left + width * 0.12, top + height * 0.12, 0.32, 0.22],
      [left + width * 0.54, top + height * 0.4, 0.34, 0.22],
      [left + width * 0.12, top + height * 0.7, 0.34, 0.18],
    ];
    for (const [boxLeft, boxTop, widthRatio, heightRatio] of boxes) {
      const boxRight = boxLeft + width * widthRatio;
      const boxBottom = boxTop + height * heightRatio;
      drawRect(
        boxLeft,
        boxTop,
        boxRight,
        boxBottom,
        COLORS.ink,
        2,
      );
      drawTextBars(
        boxLeft + 5,
        boxTop + 8,
        boxRight - boxLeft - 10,
        2,
      );
    }
    drawLine(
      left + width * 0.44,
      top + height * 0.23,
      left + width * 0.54,
      top + height * 0.51,
      COLORS.ink,
      2,
    );
    drawLine(
      left + width * 0.54,
      top + height * 0.62,
      left + width * 0.45,
      top + height * 0.78,
      COLORS.ink,
      2,
    );
  };

  const drawPhoto = ([left, top, right, bottom]) => {
    fillRect(left, top, right, bottom, COLORS.photoLight);
    const width = right - left;
    const height = bottom - top;
    for (let stripe = 0; stripe < 8; stripe += 1) {
      const x = left + (width * stripe) / 8;
      drawLine(
        x,
        top,
        x + width * 0.35,
        bottom,
        stripe % 2 ? COLORS.photoDark : COLORS.photoMid,
        Math.max(3, Math.round(width / 30)),
      );
    }
    fillRect(
      left + width * 0.1,
      top + height * 0.62,
      right - width * 0.08,
      bottom - height * 0.08,
      COLORS.photoDark,
    );
    drawRect(left, top, right, bottom, COLORS.border, 2);
  };

  fillRect(
    0,
    0,
    definition.width - 1,
    definition.height - 1,
    definition.background,
  );
  if (definition.frameless) {
    definition.charts.forEach(drawFramelessChart);
  } else {
    drawTextBars(
      Math.round(definition.width * 0.025),
      Math.round(definition.height * 0.022),
      Math.round(definition.width * 0.21),
      2,
      COLORS.ink,
      definition.width < 800 ? 1 : 2,
    );
    definition.charts.forEach(drawChart);
    drawTable(definition.table);
    drawDiagram(definition.diagram);
    drawPhoto(definition.photo);
  }

  return rgb;
}

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
const manifest = [];
for (const definition of SAMPLE_DEFINITIONS) {
  const rgb = createCanvas(definition);
  const encoded = encodePng({
    width: definition.width,
    height: definition.height,
    data: rgb,
    channels: 3,
    depth: 8,
  });
  await writeFile(
    new URL(definition.fileName, OUTPUT_DIRECTORY),
    encoded,
  );
  manifest.push({
    fileName: definition.fileName,
    width: definition.width,
    height: definition.height,
    expectedChartCount: definition.charts.length,
    singlePeakChartIndexes: definition.charts.flatMap(
      (chart, index) =>
        !Array.isArray(chart) &&
        chart.peakCenters?.length === 1
          ? [index]
          : [],
    ),
    boundaryMode: definition.frameless ? "frameless" : "framed",
    chartOnly: definition.frameless === true,
    distractors: definition.frameless
      ? []
      : ["table", "diagram", "photo"],
    bytes: encoded.length,
  });
}

await writeFile(
  new URL("random-multichart-samples.json", OUTPUT_DIRECTORY),
  `${JSON.stringify({ samples: manifest }, null, 2)}\n`,
);

console.log(JSON.stringify({ samples: manifest }, null, 2));
