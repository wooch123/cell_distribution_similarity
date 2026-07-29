import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import {
  cropInterleavedPixels,
  detectChartPanels,
} from "../lib/vth-chart-panel-core.mjs";
import {
  analyzeForegroundMasks,
  extractUpperArcPeakEvidence,
} from "../lib/vth-image-analysis-core.mjs";
import { buildForegroundMasks } from "../lib/vth-image-core.mjs";

const FIXTURES = [
  {
    file: "clean-open-axes-1672.png",
    expected: [
      1, 2, 3, 4,
      5, 5, 7, 8,
      8, 8, 10, 12,
      13, 14, 15, 16,
    ],
  },
  {
    file: "annotated-framed-1672.png",
    expected: [
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 10, 12,
      13, 15, 17, 18,
    ],
  },
  {
    file: "annotated-open-1280.png",
    expected: [
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 10, 12,
      13, 15, 17, 18,
    ],
  },
];

async function loadFixture(file) {
  const bytes = await readFile(
    new URL(
      `./fixtures/state-count-sweep/${file}`,
      import.meta.url,
    ),
  );
  return decodePng(bytes);
}

function foregroundForCrop(image, bounds) {
  const crop = cropInterleavedPixels(
    image.data,
    image.width,
    image.height,
    image.channels,
    bounds,
  );
  return {
    crop,
    foreground: buildForegroundMasks(
      crop.pixels,
      crop.width,
      crop.height,
      crop.channels,
    ),
  };
}

function evidenceForCrop(image, bounds) {
  const { crop, foreground } = foregroundForCrop(
    image,
    bounds,
  );
  return extractUpperArcPeakEvidence(
    foreground.broadMask,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
    crop.width,
    crop.height,
  );
}

for (const fixture of FIXTURES) {
  test(`${fixture.file}: upper-arc evidence measures every visible two-or-more peak lattice`, async () => {
    const image = await loadFixture(fixture.file);
    const detected = detectChartPanels(
      image.data,
      image.width,
      image.height,
      image.channels,
      { adaptiveUpscale: false },
    );
    assert.equal(detected.panels.length, 16);

    for (
      let panelIndex = 0;
      panelIndex < detected.panels.length;
      panelIndex += 1
    ) {
      const expected = fixture.expected[panelIndex];
      const { crop, foreground } = foregroundForCrop(
        image,
        detected.panels[panelIndex],
      );
      const evidence = extractUpperArcPeakEvidence(
        foreground.broadMask,
        foreground.curveSalientMask,
        foreground.curveColorMasks,
        crop.width,
        crop.height,
      );
      if (expected === 1) {
        assert.equal(evidence.accepted, false);
        assert.equal(evidence.reason, "PEAK_COUNT_REJECTED");
        assert.equal(evidence.measuredPeakCount, 1);
        continue;
      }
      assert.equal(
        evidence.accepted,
        true,
        `${fixture.file}/panel-${panelIndex + 1}: ${evidence.reason}`,
      );
      assert.equal(evidence.peakCount, expected);
      assert.equal(evidence.descriptor.stateCount, expected);
      assert.equal(
        evidence.descriptor.observedStateCount,
        expected,
      );
      assert.equal(evidence.descriptor.regularized, false);
      assert.equal(
        evidence.descriptor.peakLocations.length,
        expected,
      );
      assert.equal(
        evidence.descriptor.valleyLocations.length,
        expected - 1,
      );
      assert.ok(
        evidence.descriptor.valleyDepths.every(
          (depth) => depth > 0,
        ),
      );
      assert.ok(
        evidence.gapCoefficientOfVariation <= 0.24,
      );

      const analysis = analyzeForegroundMasks(
        foreground.broadMask,
        foreground.salientMask,
        crop.width,
        crop.height,
        foreground.curveSalientMask,
        foreground.curveColorMasks,
      );
      assert.equal(analysis.descriptor.stateCount, expected);
      assert.equal(
        analysis.descriptor.valleyLocations.length,
        expected - 1,
      );
    }
  });
}

test("upper-arc evidence rejects slide prose, a table, and a monotone trend panel", async () => {
  const image = await loadFixture(
    "annotated-framed-1672.png",
  );
  const distractors = [
    {
      name: "prose",
      left: 1280,
      top: 80,
      width: 365,
      height: 220,
    },
    {
      name: "table",
      left: 1280,
      top: 315,
      width: 365,
      height: 210,
    },
    {
      name: "trend",
      left: 1280,
      top: 535,
      width: 365,
      height: 300,
    },
  ];
  for (const distractor of distractors) {
    const evidence = evidenceForCrop(image, distractor);
    assert.equal(
      evidence.accepted,
      false,
      `${distractor.name} must not become a waveform`,
    );
    assert.equal(evidence.peakCount, 0);
  }
});
