import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import { detectChartPanels } from "../lib/vth-chart-panel-core.mjs";
import { searchSimilarityImage } from "../lib/vth-similarity-api-core.mjs";
import {
  centeredCorpusMarginFixture,
  dominantColorAndSmallRealFixture,
  sideBySideCorpusGutterFixture,
} from "./helpers/exact-physical-panel-fixtures.mjs";

const firstCorpusBytes = await readFile(
  new URL(
    "../public/corpus/vth-08s-s0042-00010--base.png",
    import.meta.url,
  ),
);
const secondCorpusBytes = await readFile(
  new URL(
    "../public/corpus/vth-08s-s0043-00011--base.png",
    import.meta.url,
  ),
);
const firstCorpus = decodePng(firstCorpusBytes);
const secondCorpus = decodePng(secondCorpusBytes);
const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

const centeredFixture =
  centeredCorpusMarginFixture(firstCorpus);
const PAIR_GAPS = Object.freeze([2, 5, 10, 20, 40, 100]);
const gutterFixtures = PAIR_GAPS.map((gap) =>
  sideBySideCorpusGutterFixture(
    firstCorpus,
    secondCorpus,
    gap,
  ),
);
const dominantFixtures = [0, 1].map((variant) =>
  dominantColorAndSmallRealFixture(secondCorpus, variant),
);

const EXPECTED_FIXTURE_BYTES = Object.freeze({
  "centered-corpus-margin": {
    length: 21_277,
    sha256:
      "b03cf7ed69da83812c9ae8ac308c9c78c8af2edf1709767725a006ba7ca8a4ad",
  },
  "side-by-side-corpus-gutter": {
    length: 36_145,
    sha256:
      "937c81080537d59dcd210669b4a0233d200d90c6bab84913109ee3e55efbbc40",
  },
  "side-by-side-corpus-gutter-2": {
    length: 34_463,
    sha256:
      "669691f677cda4672217b4fae70f40e7a6cf05cf0b99a84b8a65f7233c0c0fe6",
  },
  "side-by-side-corpus-gutter-5": {
    length: 34_469,
    sha256:
      "56691d593f5213c545677e4034a05668535407635388995fe446558cfe5cbe06",
  },
  "side-by-side-corpus-gutter-10": {
    length: 35_755,
    sha256:
      "9d5fa3eca63ba9c62961f5eeaec7e833e603438b3cd05f82dd2824db4b3f44cb",
  },
  "side-by-side-corpus-gutter-20": {
    length: 35_883,
    sha256:
      "2b93ae7cf359103a4f1d9d5f290527aba6f58c2c34cd5ffba1c53deff49bb03b",
  },
  "side-by-side-corpus-gutter-40": {
    length: 35_968,
    sha256:
      "ce5405009b978b8c1735ca5d6497e0307d8a95b3ac8d4e933684621ee632811f",
  },
  "dominant-color-small-real-0": {
    length: 38_063,
    sha256:
      "1a15303cb9506b498506d13722571227d0f8834c23544c62b3764ad8f9386b05",
  },
  "dominant-color-small-real-1": {
    length: 38_060,
    sha256:
      "6dcf783fd686fe310e57b329475518dc8ac5c46597887cec6d38696e20cd576a",
  },
});

function normalizedBounds(bounds) {
  return "x" in bounds
    ? {
        left: bounds.x,
        top: bounds.y,
        right: bounds.x + bounds.width - 1,
        bottom: bounds.y + bounds.height - 1,
      }
    : bounds;
}

function boundsWidth(bounds) {
  const normalized = normalizedBounds(bounds);
  return normalized.right - normalized.left + 1;
}

function boundsHeight(bounds) {
  const normalized = normalizedBounds(bounds);
  return normalized.bottom - normalized.top + 1;
}

function boundsArea(bounds) {
  return boundsWidth(bounds) * boundsHeight(bounds);
}

function intersectionArea(first, second) {
  const a = normalizedBounds(first);
  const b = normalizedBounds(second);
  return (
    Math.max(
      0,
      Math.min(a.right, b.right) -
        Math.max(a.left, b.left) +
        1,
    ) *
    Math.max(
      0,
      Math.min(a.bottom, b.bottom) -
        Math.max(a.top, b.top) +
        1,
    )
  );
}

function centerOf(bounds) {
  const normalized = normalizedBounds(bounds);
  return {
    x: (normalized.left + normalized.right) / 2,
    y: (normalized.top + normalized.bottom) / 2,
  };
}

function containsPoint(bounds, point) {
  const normalized = normalizedBounds(bounds);
  return (
    point.x >= normalized.left &&
    point.x <= normalized.right &&
    point.y >= normalized.top &&
    point.y <= normalized.bottom
  );
}

function matchThresholds(expectedPanel) {
  if (expectedPanel.kind === "large-color-series") {
    return {
      expectedCoverage: 0.75,
      actualCoverage: 0.65,
      intersectionOverUnion: 0.65,
      centerFraction: 0.25,
    };
  }
  if (expectedPanel.kind === "small-real-corpus") {
    return {
      expectedCoverage: 0.75,
      actualCoverage: 0.5,
      intersectionOverUnion: 0.5,
      centerFraction: 0.35,
    };
  }
  return {
    expectedCoverage: 0.75,
    actualCoverage: 0.62,
    intersectionOverUnion: 0.62,
    centerFraction: 0.3,
  };
}

function matchMetrics(actual, expectedPanel) {
  const intersection = intersectionArea(
    actual,
    expectedPanel.bounds,
  );
  const actualArea = boundsArea(actual);
  const expectedArea = boundsArea(expectedPanel.bounds);
  const actualCoverage =
    intersection / Math.max(1, actualArea);
  const expectedCoverage =
    intersection / Math.max(1, expectedArea);
  const intersectionOverUnion =
    intersection /
    Math.max(1, actualArea + expectedArea - intersection);
  const actualCenter = centerOf(actual);
  const expectedCenter = centerOf(expectedPanel.bounds);
  const centerDistance = Math.hypot(
    actualCenter.x - expectedCenter.x,
    actualCenter.y - expectedCenter.y,
  );
  const minimumDimension = Math.min(
    boundsWidth(expectedPanel.bounds),
    boundsHeight(expectedPanel.bounds),
  );
  const thresholds = matchThresholds(expectedPanel);
  const maximumCenterDistance = Math.max(
    20,
    minimumDimension * thresholds.centerFraction,
  );
  return {
    valid:
      expectedCoverage >= thresholds.expectedCoverage &&
      actualCoverage >= thresholds.actualCoverage &&
      intersectionOverUnion >=
        thresholds.intersectionOverUnion &&
      centerDistance <= maximumCenterDistance,
    actualCoverage,
    expectedCoverage,
    intersectionOverUnion,
    centerDistance,
    maximumCenterDistance,
  };
}

function exactOneToOneMatching(actualBounds, expectedPanels) {
  let best = {
    matchedCount: -1,
    totalIntersectionOverUnion: -1,
    expectedToActual: new Array(expectedPanels.length).fill(-1),
  };

  function visit(
    expectedIndex,
    usedActual,
    expectedToActual,
    matchedCount,
    totalIntersectionOverUnion,
  ) {
    if (expectedIndex === expectedPanels.length) {
      if (
        matchedCount > best.matchedCount ||
        (matchedCount === best.matchedCount &&
          totalIntersectionOverUnion >
            best.totalIntersectionOverUnion)
      ) {
        best = {
          matchedCount,
          totalIntersectionOverUnion,
          expectedToActual: [...expectedToActual],
        };
      }
      return;
    }

    expectedToActual[expectedIndex] = -1;
    visit(
      expectedIndex + 1,
      usedActual,
      expectedToActual,
      matchedCount,
      totalIntersectionOverUnion,
    );

    for (
      let actualIndex = 0;
      actualIndex < actualBounds.length;
      actualIndex += 1
    ) {
      if (usedActual.has(actualIndex)) continue;
      const metrics = matchMetrics(
        actualBounds[actualIndex],
        expectedPanels[expectedIndex],
      );
      if (!metrics.valid) continue;
      usedActual.add(actualIndex);
      expectedToActual[expectedIndex] = actualIndex;
      visit(
        expectedIndex + 1,
        usedActual,
        expectedToActual,
        matchedCount + 1,
        totalIntersectionOverUnion +
          metrics.intersectionOverUnion,
      );
      usedActual.delete(actualIndex);
      expectedToActual[expectedIndex] = -1;
    }
  }

  visit(
    0,
    new Set(),
    new Array(expectedPanels.length).fill(-1),
    0,
    0,
  );
  return best;
}

function bestMetricSummary(actualBounds, expectedPanel) {
  return actualBounds
    .map((actual, actualIndex) => ({
      actualIndex,
      ...matchMetrics(actual, expectedPanel),
    }))
    .sort(
      (first, second) =>
        second.intersectionOverUnion -
        first.intersectionOverUnion,
    )
    .slice(0, 1)
    .map(
      ({
        actualIndex,
        expectedCoverage,
        actualCoverage,
        intersectionOverUnion,
        centerDistance,
      }) =>
        `${expectedPanel.kind}->actual${actualIndex}` +
        ` expected=${expectedCoverage.toFixed(3)}` +
        ` actual=${actualCoverage.toFixed(3)}` +
        ` IoU=${intersectionOverUnion.toFixed(3)}` +
        ` center=${centerDistance.toFixed(1)}`,
    )[0];
}

function assertExactPhysicalPanels(
  actualBounds,
  fixture,
  label,
) {
  assert.equal(
    actualBounds.length,
    fixture.expectedPanelCount,
    `${label}: expected exactly ${fixture.expectedPanelCount} physical panels; a split, merge, miss, or distractor changed the count`,
  );
  const matching = exactOneToOneMatching(
    actualBounds,
    fixture.expectedPanels,
  );
  assert.equal(
    matching.matchedCount,
    fixture.expectedPanelCount,
    `${label}: only ${matching.matchedCount}/${fixture.expectedPanelCount} detections matched physical chart ground truth; ${fixture.expectedPanels
      .filter(
        (_panel, expectedIndex) =>
          matching.expectedToActual[expectedIndex] < 0,
      )
      .map((panel) =>
        bestMetricSummary(actualBounds, panel),
      )
      .join("; ")}`,
  );
  return matching;
}

function assertNoOverlap(boundsList, label) {
  for (
    let firstIndex = 0;
    firstIndex < boundsList.length;
    firstIndex += 1
  ) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < boundsList.length;
      secondIndex += 1
    ) {
      assert.equal(
        intersectionArea(
          boundsList[firstIndex],
          boundsList[secondIndex],
        ),
        0,
        `${label} ${firstIndex} and ${secondIndex} must not overlap`,
      );
    }
  }
}

function assertReturnedPairSeparation(
  actualBounds,
  fixture,
  label,
) {
  assertNoOverlap(
    actualBounds,
    `${label} returned physical panels`,
  );
  const [firstPlacement, secondPlacement] =
    fixture.sourcePlacements;
  const sharedContentTop = Math.max(
    ...fixture.expectedPanels.map(
      ({ bounds }) => normalizedBounds(bounds).top,
    ),
  );
  const sharedContentBottom = Math.min(
    ...fixture.expectedPanels.map(
      ({ bounds }) => normalizedBounds(bounds).bottom,
    ),
  );
  const gutterCenter = {
    x: (firstPlacement.right + secondPlacement.left) / 2,
    y: (sharedContentTop + sharedContentBottom) / 2,
  };
  assert.ok(
    actualBounds.every(
      (bounds) => !containsPoint(bounds, gutterCenter),
    ),
    `${label}: no returned panel may contain the blank gutter center (${gutterCenter.x}, ${gutterCenter.y})`,
  );
}

function assertContained(inner, outer, label) {
  const inside = normalizedBounds(inner);
  const outside = normalizedBounds(outer);
  assert.ok(
    inside.left >= outside.left &&
      inside.top >= outside.top &&
      inside.right <= outside.right &&
      inside.bottom <= outside.bottom,
    `${label} must remain inside its physical source placement`,
  );
}

function assertWhiteRectangle(
  fixture,
  { left, top, right, bottom },
  label,
) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * fixture.width + x) * 3;
      assert.equal(
        fixture.pixels[offset],
        255,
        `${label} red channel at (${x}, ${y})`,
      );
      assert.equal(
        fixture.pixels[offset + 1],
        255,
        `${label} green channel at (${x}, ${y})`,
      );
      assert.equal(
        fixture.pixels[offset + 2],
        255,
        `${label} blue channel at (${x}, ${y})`,
      );
    }
  }
}

test("exact physical-panel PNG fixtures are deterministic, disjoint, and preserve their declared blank gutters", () => {
  const fixtures = [
    centeredFixture,
    ...gutterFixtures,
    ...dominantFixtures,
  ];
  for (const fixture of fixtures) {
    const expected = EXPECTED_FIXTURE_BYTES[fixture.name];
    assert.equal(fixture.bytes.length, expected.length);
    assert.equal(
      createHash("sha256")
        .update(fixture.bytes)
        .digest("hex"),
      expected.sha256,
    );
    assert.equal(fixture.mimeType, "image/png");
    assert.equal(fixture.channels, 3);
    assert.equal(
      fixture.expectedPanelCount,
      fixture.expectedPanels.length,
    );
    assertNoOverlap(
      fixture.expectedPanels.map(({ bounds }) => bounds),
      `${fixture.name} panel GT`,
    );
    assertNoOverlap(
      fixture.sourcePlacements,
      `${fixture.name} source placement`,
    );
    fixture.expectedPanels.forEach(
      ({ bounds }, panelIndex) =>
        assertContained(
          bounds,
          fixture.sourcePlacements[panelIndex],
          `${fixture.name} panel ${panelIndex}`,
        ),
    );
  }

  assert.deepEqual(centeredFixture.sourcePlacements[0], {
    left: 100,
    top: 100,
    right: 858,
    bottom: 469,
  });
  assert.equal(
    centeredFixture.width -
      centeredFixture.sourcePlacements[0].right -
      1,
    100,
  );
  assert.equal(
    centeredFixture.height -
      centeredFixture.sourcePlacements[0].bottom -
      1,
    100,
  );
  assertWhiteRectangle(
    centeredFixture,
    { left: 0, top: 0, right: 958, bottom: 99 },
    "centered top margin",
  );
  assertWhiteRectangle(
    centeredFixture,
    { left: 0, top: 470, right: 958, bottom: 569 },
    "centered bottom margin",
  );
  assertWhiteRectangle(
    centeredFixture,
    { left: 0, top: 100, right: 99, bottom: 469 },
    "centered left margin",
  );
  assertWhiteRectangle(
    centeredFixture,
    { left: 859, top: 100, right: 958, bottom: 469 },
    "centered right margin",
  );

  for (
    let fixtureIndex = 0;
    fixtureIndex < gutterFixtures.length;
    fixtureIndex += 1
  ) {
    const fixture = gutterFixtures[fixtureIndex];
    const gap = PAIR_GAPS[fixtureIndex];
    assert.equal(fixture.width, 1601 + gap);
    assert.equal(fixture.height, 370);
    assert.equal(fixture.blankGutter, gap);
    assert.deepEqual(fixture.sourcePlacements, [
      { left: 0, top: 0, right: 758, bottom: 369 },
      {
        left: 759 + gap,
        top: 18,
        right: 1600 + gap,
        bottom: 350,
      },
    ]);
    assertWhiteRectangle(
      fixture,
      {
        left: 759,
        top: 0,
        right: 758 + gap,
        bottom: 369,
      },
      `${gap}-pixel source gutter`,
    );
  }

  for (const fixture of dominantFixtures) {
    const largePanel = fixture.expectedPanels.find(
      ({ kind }) => kind === "large-color-series",
    );
    const smallPanel = fixture.expectedPanels.find(
      ({ kind }) => kind === "small-real-corpus",
    );
    assert.ok(largePanel);
    assert.ok(smallPanel);
    assert.ok(
      boundsArea(largePanel.bounds) /
        (fixture.width * fixture.height) >=
        0.3,
      `${fixture.name} dominant plot ROI must occupy at least 30% of the complete canvas`,
    );
    assert.equal(largePanel.expectedSeriesCount, 3);
    assert.equal(smallPanel.expectedSeriesCount, 1);
    assert.equal(
      intersectionArea(largePanel.bounds, smallPanel.bounds),
      0,
    );
  }
  assert.notDeepEqual(
    dominantFixtures[0].sourcePlacements,
    dominantFixtures[1].sourcePlacements,
    "the position-shifted variant must exercise different arbitrary coordinates",
  );
});

test("centered real corpus chart with 100-pixel margins remains exactly one substantial physical crop", () => {
  const result = detectChartPanels(
    centeredFixture.pixels,
    centeredFixture.width,
    centeredFixture.height,
    centeredFixture.channels,
  );

  assert.equal(result.fallbackUsed, false);
  assert.equal(result.truncated, false);
  assertExactPhysicalPanels(
    result.panels,
    centeredFixture,
    "centered detector",
  );
});

test("detector keeps real corpus A+B as two strict, disjoint one-to-one crops across 2-100 pixel gaps", async (context) => {
  for (const fixture of gutterFixtures) {
    await context.test(
      `${fixture.blankGutter}-pixel gap`,
      () => {
        const detected = detectChartPanels(
          fixture.pixels,
          fixture.width,
          fixture.height,
          fixture.channels,
        );
        assert.equal(detected.fallbackUsed, false);
        assert.equal(detected.truncated, false);
        assertExactPhysicalPanels(
          detected.panels,
          fixture,
          `${fixture.blankGutter}px gutter detector`,
        );
        assertReturnedPairSeparation(
          detected.panels,
          fixture,
          `${fixture.blankGutter}px gutter detector`,
        );
      },
    );
  }
});

test("similarity API preserves strict disjoint A+B crops at representative 2, 10, and 40 pixel gaps", async (context) => {
  for (const gap of [2, 10, 40]) {
    const fixture = gutterFixtures.find(
      (candidate) => candidate.blankGutter === gap,
    );
    await context.test(`${gap}-pixel gap`, async () => {
      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: publicCorpus,
        origin: "http://127.0.0.1:4173",
      });
      assert.equal(response.panelCount, 2);
      assert.equal(response.panelDetection.detectedPanelCount, 2);
      assert.equal(
        response.panelDetection.analyzedPanelCount,
        2,
      );
      const sourceBounds = response.panels.map(
        ({ bounds }) => bounds.source,
      );
      assertExactPhysicalPanels(
        sourceBounds,
        fixture,
        `${gap}px gutter API`,
      );
      assertReturnedPairSeparation(
        sourceBounds,
        fixture,
        `${gap}px gutter API`,
      );
      assert.ok(
        response.panels.every(
          ({ results }) => results.length === 1,
        ),
      );
    });
  }
});

test("detector keeps a dominant multi-series plot and remote small real QLC chart as two physical panels after relocation", async (context) => {
  for (const fixture of dominantFixtures) {
    await context.test(`position variant ${fixture.variant}`, () => {
      const detected = detectChartPanels(
        fixture.pixels,
        fixture.width,
        fixture.height,
        fixture.channels,
      );
      assert.equal(detected.fallbackUsed, false);
      assert.equal(detected.truncated, false);
      assertExactPhysicalPanels(
        detected.panels,
        fixture,
        `${fixture.name} detector`,
      );
    });
  }
});

test("similarity API keeps a dominant multi-series plot and remote small real QLC chart as two physical panels after relocation", async (context) => {
  for (const fixture of dominantFixtures) {
    await context.test(`position variant ${fixture.variant}`, async () => {
      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: publicCorpus,
        origin: "http://127.0.0.1:4173",
      });
      assert.equal(response.panelCount, 2);
      assert.equal(response.panelDetection.detectedPanelCount, 2);
      assert.equal(
        response.panelDetection.analyzedPanelCount,
        2,
      );
      assertExactPhysicalPanels(
        response.panels.map(({ bounds }) => bounds.source),
        fixture,
        `${fixture.name} API`,
      );
      assert.ok(
        response.panels.every(
          ({ results }) => results.length === 1,
        ),
      );
    });
  }
});
