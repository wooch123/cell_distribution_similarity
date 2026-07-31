import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decode as decodePng } from "fast-png";

import { detectChartPanels } from "../lib/vth-chart-panel-core.mjs";
import { searchSimilarityImage } from "../lib/vth-similarity-api-core.mjs";
import {
  realisticCaptureWaveformFixture,
} from "./helpers/realistic-capture-waveform-fixtures.mjs";

const execFileAsync = promisify(execFile);
const webDirectory = fileURLToPath(
  new URL("../", import.meta.url),
);

const sourceSlideBytes = await readFile(
  new URL(
    "./fixtures/qlc-read-disturb-20-chart-slide.png",
    import.meta.url,
  ),
);
const sourceSlide = decodePng(sourceSlideBytes);
const publicCorpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);

const EXPECTED_FIXTURES = Object.freeze({
  1: {
    bytes: 73_719,
    sha256:
      "15924d05bd5c66843af7294ac669e9210e1c840403457fea4a7760f9edef9c25",
  },
  3: {
    bytes: 89_009,
    sha256:
      "417b0bcad1c09302b63f27b6d6e6c7022d8e5d44af5c1b0a0f6828eb6684dacd",
  },
  7: {
    bytes: 127_185,
    sha256:
      "5e1e0743be80b4158c94607cd2f199a866a380e92b1c676f4fa44a80c4511ba3",
  },
  11: {
    bytes: 149_121,
    sha256:
      "a1973f490dd7a94bc09c2abea04b19652621f2ca4cdb7a7808f18c40537bc31a",
  },
  "4k": {
    bytes: 403_086,
    sha256:
      "896060defdac231831856e81d252fa69c9fc2229bfc8895bd8db568de8b8484b",
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

function centerOf(bounds) {
  const normalized = normalizedBounds(bounds);
  return {
    x: (normalized.left + normalized.right) / 2,
    y: (normalized.top + normalized.bottom) / 2,
  };
}

function intersectionArea(first, second) {
  const a = normalizedBounds(first);
  const b = normalizedBounds(second);
  return (
    Math.max(
      0,
      Math.min(a.right, b.right) - Math.max(a.left, b.left) + 1,
    ) *
    Math.max(
      0,
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + 1,
    )
  );
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

function matchMetrics(actual, expected) {
  const intersection = intersectionArea(actual, expected);
  const expectedCoverage =
    intersection / Math.max(1, boundsArea(expected));
  const actualCoverage =
    intersection / Math.max(1, boundsArea(actual));
  const union =
    boundsArea(actual) + boundsArea(expected) - intersection;
  const intersectionOverUnion = intersection / Math.max(1, union);
  const actualCenter = centerOf(actual);
  const expectedCenter = centerOf(expected);
  const centerDistance = Math.hypot(
    actualCenter.x - expectedCenter.x,
    actualCenter.y - expectedCenter.y,
  );
  const minimumDimension = Math.min(
    boundsWidth(expected),
    boundsHeight(expected),
  );
  const minimumIntersectionOverUnion =
    minimumDimension < 49 ? 0.58 : 0.68;

  return {
    valid:
      centerDistance <= Math.max(5, minimumDimension * 0.18) &&
      expectedCoverage >= 0.7 &&
      actualCoverage >= 0.66 &&
      intersectionOverUnion >= minimumIntersectionOverUnion,
    expectedCoverage,
    actualCoverage,
    intersectionOverUnion,
    centerDistance,
  };
}

function maximumGroundTruthMatching(actualBounds, expectedCharts) {
  const adjacency = expectedCharts.map(({ bounds }) =>
    actualBounds
      .map((actual, actualIndex) => ({
        actualIndex,
        ...matchMetrics(actual, bounds),
      }))
      .filter(({ valid }) => valid)
      .sort(
        (first, second) =>
          second.intersectionOverUnion -
            first.intersectionOverUnion ||
          first.centerDistance - second.centerDistance,
      ),
  );
  const expectedForActual = new Array(actualBounds.length).fill(-1);

  function assign(expectedIndex, visitedActual) {
    for (const { actualIndex } of adjacency[expectedIndex]) {
      if (visitedActual.has(actualIndex)) continue;
      visitedActual.add(actualIndex);
      if (
        expectedForActual[actualIndex] === -1 ||
        assign(expectedForActual[actualIndex], visitedActual)
      ) {
        expectedForActual[actualIndex] = expectedIndex;
        return true;
      }
    }
    return false;
  }

  const matchedExpected = new Set();
  for (
    let expectedIndex = 0;
    expectedIndex < expectedCharts.length;
    expectedIndex += 1
  ) {
    if (assign(expectedIndex, new Set())) {
      matchedExpected.add(expectedIndex);
    }
  }

  return {
    matchedCount: matchedExpected.size,
    missedExpectedIndexes: expectedCharts
      .map((_chart, index) => index)
      .filter((index) => !matchedExpected.has(index)),
    unmatchedActualIndexes: expectedForActual
      .map((expectedIndex, index) => ({ expectedIndex, index }))
      .filter(({ expectedIndex }) => expectedIndex === -1)
      .map(({ index }) => index),
    expectedForActual,
  };
}

function assertOnlyExpectedWaveforms(
  actualBounds,
  fixture,
  label,
) {
  const matching = maximumGroundTruthMatching(
    actualBounds,
    fixture.charts,
  );
  assert.equal(
    matching.matchedCount,
    fixture.expectedChartCount,
    `${label}: matched ${matching.matchedCount}/${fixture.expectedChartCount}; missed GT [${matching.missedExpectedIndexes.join(", ")}], unmatched detections [${matching.unmatchedActualIndexes.join(", ")}]`,
  );
  assert.equal(
    actualBounds.length,
    fixture.expectedChartCount,
    `${label}: false split, merge, or distractor changed the exact panel count`,
  );
  for (const distractor of fixture.distractors) {
    const center = centerOf(distractor.bounds);
    assert.ok(
      actualBounds.every((bounds) => !containsPoint(bounds, center)),
      `${label}: ${distractor.type} center must be excluded`,
    );
    assert.ok(
      actualBounds.every(
        (bounds) =>
          intersectionArea(bounds, distractor.bounds) /
            Math.max(
              1,
              Math.min(
                boundsArea(bounds),
                boundsArea(distractor.bounds),
              ),
            ) <
          0.3,
      ),
      `${label}: ${distractor.type} must not substantially overlap a returned panel`,
    );
  }
  return matching;
}

function minimumBlankHorizontalGutter(charts) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let firstIndex = 0; firstIndex < charts.length; firstIndex += 1) {
    const first = charts[firstIndex].bounds;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < charts.length;
      secondIndex += 1
    ) {
      const second = charts[secondIndex].bounds;
      const verticalOverlap =
        Math.min(first.bottom, second.bottom) -
        Math.max(first.top, second.top) +
        1;
      if (verticalOverlap <= 0) continue;
      if (first.right < second.left) {
        minimum = Math.min(
          minimum,
          second.left - first.right - 1,
        );
      } else if (second.right < first.left) {
        minimum = Math.min(
          minimum,
          first.left - second.right - 1,
        );
      }
    }
  }
  return minimum;
}

function assertFixtureContract(fixture, expected) {
  assert.equal(fixture.bytes.length, expected.bytes);
  assert.equal(
    createHash("sha256").update(fixture.bytes).digest("hex"),
    expected.sha256,
  );
  assert.equal(fixture.mimeType, "image/jpeg");
  assert.equal(fixture.resampling, "bilinear");
  assert.equal(fixture.channels, 4);
  assert.equal(fixture.bytes[0], 0xff);
  assert.equal(fixture.bytes[1], 0xd8);
  assert.equal(fixture.bytes.at(-2), 0xff);
  assert.equal(fixture.bytes.at(-1), 0xd9);
  assert.equal(
    new Set(
      fixture.charts.map(({ bounds }) => bounds.left),
    ).size,
    fixture.charts.length,
  );
  assert.equal(
    new Set(
      fixture.charts.map(({ bounds }) => bounds.top),
    ).size,
    fixture.charts.length,
  );

  for (
    let firstIndex = 0;
    firstIndex < fixture.charts.length;
    firstIndex += 1
  ) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < fixture.charts.length;
      secondIndex += 1
    ) {
      assert.equal(
        intersectionArea(
          fixture.charts[firstIndex].bounds,
          fixture.charts[secondIndex].bounds,
        ),
        0,
        `charts ${firstIndex} and ${secondIndex} must not overlap`,
      );
    }
    for (const distractor of fixture.distractors) {
      assert.equal(
        intersectionArea(
          fixture.charts[firstIndex].bounds,
          distractor.bounds,
        ),
        0,
        `chart ${firstIndex} must not overlap ${distractor.type}`,
      );
    }
  }

  assert.deepEqual(
    fixture.distractors.map(({ type }) => type),
    [
      "text-card",
      "table",
      "process-diagram",
      "rectangle-card",
    ],
  );
  assert.ok(
    fixture.charts.some(
      ({ bounds }) =>
        bounds.left === 0 ||
        bounds.top === 0 ||
        bounds.right === fixture.width - 1 ||
        bounds.bottom === fixture.height - 1,
    ),
    "at least one real chart must touch an image edge",
  );
}

test("bilinear JPEG fixtures deterministically model 1, 3, 7, and 11 fully scattered QLC charts", () => {
  for (const count of [1, 3, 7, 11]) {
    const fixture = realisticCaptureWaveformFixture(
      sourceSlide,
      count,
    );
    assert.equal(fixture.expectedChartCount, count);
    assertFixtureContract(fixture, EXPECTED_FIXTURES[count]);
    if (count === 3) {
      assert.deepEqual(fixture.labelChartIndexes, [0, 1, 2]);
      assert.ok(
        fixture.charts.some(
          ({ width, height }) => width === 67 && height === 49,
        ),
        "the labeled low-anchor case must retain a physical 67 × 49 plot frame",
      );
    }
    if (count >= 7) {
      assert.ok(minimumBlankHorizontalGutter(fixture.charts) <= 8);
      const areas = fixture.charts.map(({ bounds }) =>
        boundsArea(bounds),
      );
      assert.ok(Math.max(...areas) / Math.min(...areas) >= 5);
    }
  }
});

test("detector returns exactly the 1, 3, 7, and 11 realistic JPEG waveforms without office distractors", async (context) => {
  for (const count of [1, 3, 7, 11]) {
    await context.test(`${count} scattered charts`, () => {
      const fixture = realisticCaptureWaveformFixture(
        sourceSlide,
        count,
      );
      const result = detectChartPanels(
        fixture.pixels,
        fixture.width,
        fixture.height,
        fixture.channels,
      );

      assert.equal(result.fallbackUsed, false);
      assert.equal(result.truncated, false);
      assert.equal(
        result.diagnostics.repeatedGridRecovery.applied,
        false,
        `${count} scattered plots must not depend on repeated row/column anchors`,
      );
      assertOnlyExpectedWaveforms(
        result.panels,
        fixture,
        `${count}-chart JPEG detector`,
      );
    });
  }
});

test("similarity API independently ranks every realistic 1, 3, 7, and 11 chart JPEG crop", async (context) => {
  const sourceBaselineResponse = await searchSimilarityImage({
    bytes: sourceSlideBytes,
    mimeType: "image/png",
    topK: 1,
    corpus: publicCorpus,
    origin: "http://127.0.0.1:4173",
  });
  assert.equal(sourceBaselineResponse.panelCount, 20);
  const sourceObservedStateBaselines =
    sourceBaselineResponse.panels.map(
      (panel) => panel.query.observedStateCount,
    );

  for (const count of [1, 3, 7, 11]) {
    await context.test(`${count} scattered charts`, async () => {
      const fixture = realisticCaptureWaveformFixture(
        sourceSlide,
        count,
      );
      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: publicCorpus,
        origin: "http://127.0.0.1:4173",
      });
      const sourceBounds = response.panels.map(
        ({ bounds }) => bounds.source,
      );
      const matching = assertOnlyExpectedWaveforms(
        sourceBounds,
        fixture,
        `${count}-chart JPEG API`,
      );

      assert.equal(response.panelCount, count);
      assert.equal(response.panelDetection.detectedPanelCount, count);
      assert.equal(response.panelDetection.analyzedPanelCount, count);
      assert.equal(response.panelDetection.fallbackUsed, false);
      assert.equal(response.panelDetection.truncated, false);
      for (
        let actualIndex = 0;
        actualIndex < response.panels.length;
        actualIndex += 1
      ) {
        const panel = response.panels[actualIndex];
        const expectedIndex =
          matching.expectedForActual[actualIndex];
        const expected = fixture.charts[expectedIndex];
        const sourceObservedStateBaseline =
          sourceObservedStateBaselines[
            expected.sourcePanelIndex
          ];
        const minimumObservedStates = Math.max(
          5,
          sourceObservedStateBaseline - 1,
        );
        const assertionContext =
          `${count}-chart API GT ${expectedIndex} ` +
          `(source ${expected.sourcePanelIndex}, ` +
          `${expected.width}×${expected.height})`;
        assert.equal(
          panel.results.length,
          1,
          `${assertionContext} must receive one ranking`,
        );
        assert.equal(
          panel.seriesCount,
          1,
          `${assertionContext} State-segment colors must remain one distribution`,
        );
        assert.ok(
          [4, 8].includes(panel.query.stateCount),
          `${assertionContext} regularized stateCount ${panel.query.stateCount} must remain a supported QLC hypothesis`,
        );
        assert.ok(
          panel.query.observedStateCount >= minimumObservedStates,
          `${assertionContext} observed ${panel.query.observedStateCount} States; source baseline ${sourceObservedStateBaseline} requires at least ${minimumObservedStates}`,
        );
      }
    });
  }
});

test("detector preserves a physical FHD-size QLC group on a 4K JPEG canvas in an isolated process", async () => {
  const childScript = `
    import { readFile } from "node:fs/promises";
    import { decode as decodePng } from "fast-png";
    import { detectChartPanels } from "./lib/vth-chart-panel-core.mjs";
    import { realisticFourKSmallWaveformFixture } from "./tests/helpers/realistic-capture-waveform-fixtures.mjs";

    const source = decodePng(
      await readFile("./tests/fixtures/qlc-read-disturb-20-chart-slide.png"),
    );
    const fixture = realisticFourKSmallWaveformFixture(source);
    const result = detectChartPanels(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
    );
    process.stdout.write(JSON.stringify({
      fixture: {
        name: fixture.name,
        width: fixture.width,
        height: fixture.height,
        channels: fixture.channels,
        mimeType: fixture.mimeType,
        resampling: fixture.resampling,
        expectedChartCount: fixture.expectedChartCount,
        charts: fixture.charts,
        distractors: fixture.distractors,
        bytesBase64: Buffer.from(fixture.bytes).toString("base64"),
      },
      result: {
        fallbackUsed: result.fallbackUsed,
        truncated: result.truncated,
        panels: result.panels.map(
          ({ left, top, right, bottom }) => ({
            left,
            top,
            right,
            bottom,
          }),
        ),
      },
      rssBytes: process.memoryUsage().rss,
    }));
  `;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", childScript],
    {
      cwd: webDirectory,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  assert.equal(stderr, "");
  const reported = JSON.parse(stdout);
  const fixture = {
    ...reported.fixture,
    bytes: Buffer.from(
      reported.fixture.bytesBase64,
      "base64",
    ),
  };
  assert.equal(fixture.width, 3840);
  assert.equal(fixture.height, 2160);
  assert.equal(fixture.expectedChartCount, 6);
  assertFixtureContract(fixture, EXPECTED_FIXTURES["4k"]);
  assert.ok(minimumBlankHorizontalGutter(fixture.charts) <= 8);
  assert.ok(
    fixture.charts.some(
      ({ width, height }) => width === 48 && height === 35,
    ),
  );

  assert.ok(
    reported.rssBytes > 0,
    "the isolated child must report its own memory usage",
  );
  assert.equal(reported.result.fallbackUsed, false);
  assert.equal(reported.result.truncated, false);
  assertOnlyExpectedWaveforms(
    reported.result.panels,
    fixture,
    "4K physical-small-chart detector",
  );
});
