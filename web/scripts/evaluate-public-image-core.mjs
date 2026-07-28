import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeGraphImageFile } from "../lib/vth-node-image-analysis.mjs";
import {
  alignedCurveSimilarity,
  detectPeaks,
  searchCorpus,
} from "../lib/vth-shape-core.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(
  process.argv[2] ??
    path.join(
      scriptDirectory,
      "../../artifacts/real-multisource-validation/queries",
    ),
);
const suiteName = process.argv[3] ?? "public";
const corpus = JSON.parse(
  await readFile(
    path.join(scriptDirectory, "../public/corpus-index.json"),
    "utf8",
  ),
);
if (process.env.VTH_EVAL_DUAL_MODEL) {
  corpus.dualEncoder = JSON.parse(
    await readFile(path.resolve(process.env.VTH_EVAL_DUAL_MODEL), "utf8"),
  );
}
if (
  corpus.dualEncoder &&
  process.env.VTH_EVAL_DUAL_BLEND !== undefined
) {
  const override = Number(process.env.VTH_EVAL_DUAL_BLEND);
  assert.ok(
    Number.isFinite(override) && override >= 0 && override <= 1,
    "VTH_EVAL_DUAL_BLEND must be in [0, 1]",
  );
  corpus.dualEncoder.blendWeight = override;
}
if (
  corpus.dualEncoder &&
  process.env.VTH_EVAL_DUAL_RERANK_LIMIT !== undefined
) {
  const override = Number(process.env.VTH_EVAL_DUAL_RERANK_LIMIT);
  assert.ok(
    Number.isInteger(override) && override >= 1 && override <= 10,
    "VTH_EVAL_DUAL_RERANK_LIMIT must be an integer in [1, 10]",
  );
  corpus.dualEncoder.rerankLimit = override;
}

const fixtureSuites = {
  public: [
    {
      group: "springer-coarse",
      filePrefix: "springer-coarse",
      stateCount: 16,
      expectedMode: "rectangle",
    },
    {
      group: "springer-fine",
      filePrefix: "springer-fine",
      stateCount: 16,
      expectedMode: "rectangle",
    },
    {
      group: "us20130163342-fig1",
      filePrefix: "us20130163342-fig1",
      stateCount: 4,
      expectedMode: "l-axis",
    },
    {
      group: "us20150085588-fig26",
      filePrefix: "us20150085588-fig26",
      stateCount: 4,
      expectedMode: "l-axis",
    },
    {
      group: "wo2024148459-fig8",
      filePrefix: "wo2024148459-fig8",
      stateCount: 2,
      expectedMode: "l-axis",
    },
  ],
  measured: ["2k5", "5k", "10k", "20k"].map((condition) => ({
    group: `luo-jsac-fig4-${condition}`,
    filePrefix: `luo-jsac-2016-fig4-${condition}`,
    stateCount: 4,
    expectedMode: "rectangle",
  })),
};
fixtureSuites["measured-multisource"] = [
  ...fixtureSuites.measured,
  {
    group: "freudenberger-2023-fig3-2",
    filePrefix: "freudenberger-2023-fig3-2",
    stateCount: 8,
    expectedMode: "rectangle",
  },
  {
    group: "ibm-irps-2020-fig8",
    filePrefix: "ibm-irps-2020-fig8",
    stateCount: 16,
    expectedMode: "rectangle",
  },
];
fixtureSuites["user-peak-valley"] = [
  {
    group: "user-peak-valley",
    filePrefix: "user-peak-valley",
    stateCount: 8,
    expectedMode: "rectangle",
  },
];
const selectedSuite = fixtureSuites[suiteName];
assert.ok(selectedSuite, `Unknown fixture suite: ${suiteName}`);
const fixtures = selectedSuite.flatMap((fixture) =>
  ["original.png", "resized.png", "jpeg.jpg"].map((variant) => ({
    ...fixture,
    fileName: `${fixture.filePrefix}-${variant}`,
  })),
);

const results = [];
for (const fixture of fixtures) {
  const imagePath = path.join(fixtureRoot, fixture.fileName);
  await access(imagePath);
  const analysis = await analyzeGraphImageFile(imagePath);
  const {
    bounds,
    primaryMask: cleaned,
    primaryCanonical: canonical,
    useContentCoordinates,
    sourceSize,
  } = analysis.preprocessing;
  const retainedPixels = cleaned.mask.reduce(
    (sum, value) => sum + value,
    0,
  );
  const descriptor = analysis.descriptor;
  const alternatives = analysis.alternatives;
  const detectedPeaks = detectPeaks(analysis.profile);
  const ranked = searchCorpus(
    analysis.profile,
    descriptor,
    corpus.candidates,
    corpus.reranker,
    alternatives,
    corpus.dualEncoder,
  ).slice(0, 10);

  const preprocessingPassed =
    bounds.axisMode === fixture.expectedMode &&
    bounds.axesDetected &&
    retainedPixels >= 12;
  const stateCountPassed = descriptor.stateCount === fixture.stateCount;
  const searchPassed =
    ranked.length === 10 &&
    ranked.every((candidate) => candidate.stateCount === fixture.stateCount) &&
    ranked.every((candidate) => candidate.reasons.length >= 1);
  results.push({
    file: fixture.fileName,
    group: fixture.group,
    stateCount: fixture.stateCount,
    detectedStateCount: descriptor.stateCount,
    observedStateCount: descriptor.observedStateCount,
    candidatePeakCount: detectedPeaks.length,
    candidatePeaks: detectedPeaks.map((peak) => ({
      location: Number((peak.index / 255).toFixed(4)),
      prominence: Number(peak.prominence.toFixed(5)),
    })),
    regularizedStateCount: descriptor.regularized,
    descriptor: {
      peakLocations: descriptor.peakLocations,
      peakWidths: descriptor.peakWidths,
      valleyHeights: descriptor.valleyHeights,
      valleyLocations: descriptor.valleyLocations,
      valleyDepths: descriptor.valleyDepths,
      valleyPositionRatios: descriptor.valleyPositionRatios,
      peakValleyDistances: descriptor.peakValleyDistances,
      tailSlopes: descriptor.tailSlopes,
      area: descriptor.area,
    },
    expectedMode: fixture.expectedMode,
    axisMode: bounds.axisMode,
    preprocessingPassed,
    stateCountPassed,
    searchPassed,
    endToEndPassed: preprocessingPassed && stateCountPassed && searchPassed,
    horizontalLineCenters: bounds.horizontalLineCenters,
    verticalLineCenters: bounds.verticalLineCenters,
    sourceSize,
    cropSize: [cleaned.width, cleaned.height],
    coordinateMode: useContentCoordinates ? "content" : "plot",
    deskewApplied: analysis.preprocessing.deskewApplied,
    deskewAngle: analysis.preprocessing.deskewAngle,
    curveHypothesisCount: 1 + alternatives.length,
    density: Number(cleaned.density.toFixed(5)),
    componentFilterApplied: cleaned.componentFilterApplied,
    removedStraightRows: cleaned.removedStraightRows,
    removedStraightColumns: cleaned.removedStraightColumns,
    retainedPixels,
    boundaryFraction: canonical.boundaryFraction,
    topCandidateId: ranked[0]?.id ?? null,
    topCandidateScore: Number((ranked[0]?.score ?? 0).toFixed(6)),
    topFiveCandidates: ranked.slice(0, 5).map((candidate) => ({
      id: candidate.id,
      score: Number(candidate.score.toFixed(6)),
      curveScore: Number(candidate.curveScore.toFixed(6)),
      locationScore: Number(candidate.locationScore.toFixed(6)),
      widthScore: Number(candidate.widthScore.toFixed(6)),
      valleyScore: Number(candidate.valleyScore.toFixed(6)),
      tailScore: Number(candidate.tailScore.toFixed(6)),
      peakValleyScore: Number(candidate.peakValleyScore.toFixed(6)),
      valleyDepthScore: Number(candidate.valleyDepthScore.toFixed(6)),
      peakValleyDistanceScore: Number(
        candidate.peakValleyDistanceScore.toFixed(6),
      ),
      dualEncoderScore:
        candidate.dualEncoderScore === undefined
          ? null
          : Number(candidate.dualEncoderScore.toFixed(6)),
    })),
    topFiveCandidateIds: ranked.slice(0, 5).map((candidate) => candidate.id),
    topTenCandidateIds: ranked.slice(0, 10).map((candidate) => candidate.id),
    profile: analysis.profile,
  });
}

const groupResults = fixtures
  .map((fixture) => fixture.group)
  .filter((group, index, groups) => groups.indexOf(group) === index)
  .map((group) => {
    const variants = results.filter((result) => result.group === group);
    const pairwiseProfileSimilarity = [];
    const pairwiseTopFiveOverlap = [];
    const pairwiseTopTenOverlap = [];
    for (let left = 0; left < variants.length; left += 1) {
      for (let right = left + 1; right < variants.length; right += 1) {
        pairwiseProfileSimilarity.push(
          alignedCurveSimilarity(
            variants[left].profile,
            variants[right].profile,
          ),
        );
        const leftIds = new Set(variants[left].topFiveCandidateIds);
        const shared = variants[right].topFiveCandidateIds.filter((id) =>
          leftIds.has(id),
        ).length;
        pairwiseTopFiveOverlap.push(shared / 5);
        const leftTopTenIds = new Set(variants[left].topTenCandidateIds);
        const sharedTopTen = variants[right].topTenCandidateIds.filter((id) =>
          leftTopTenIds.has(id),
        ).length;
        pairwiseTopTenOverlap.push(sharedTopTen / 10);
      }
    }
    return {
      group,
      expectedStateCount: variants[0].stateCount,
      detectedStateCounts: variants.map((variant) => variant.detectedStateCount),
      stateCountConsistent:
        new Set(variants.map((variant) => variant.detectedStateCount)).size ===
        1,
      topCandidateConsistent:
        new Set(variants.map((variant) => variant.topCandidateId)).size === 1,
      topTwoSetConsistent:
        new Set(
          variants.map((variant) =>
            [...variant.topTenCandidateIds.slice(0, 2)].sort().join("|"),
          ),
        ).size === 1,
      minimumProfileSimilarity: Number(
        Math.min(...pairwiseProfileSimilarity).toFixed(6),
      ),
      meanProfileSimilarity: Number(
        (
          pairwiseProfileSimilarity.reduce((sum, value) => sum + value, 0) /
          pairwiseProfileSimilarity.length
        ).toFixed(6),
      ),
      minimumTopFiveOverlap: Number(
        Math.min(...pairwiseTopFiveOverlap).toFixed(3),
      ),
      meanTopFiveOverlap: Number(
        (
          pairwiseTopFiveOverlap.reduce((sum, value) => sum + value, 0) /
          pairwiseTopFiveOverlap.length
        ).toFixed(3),
      ),
      minimumTopTenOverlap: Number(
        Math.min(...pairwiseTopTenOverlap).toFixed(3),
      ),
      meanTopTenOverlap: Number(
        (
          pairwiseTopTenOverlap.reduce((sum, value) => sum + value, 0) /
          pairwiseTopTenOverlap.length
        ).toFixed(3),
      ),
    };
  });

const publicResults = results.map((result) =>
  Object.fromEntries(
    Object.entries(result).filter(
      ([key]) =>
        key !== "profile" || process.env.VTH_EVAL_INCLUDE_PROFILE === "1",
    ),
  ),
);
const reportJson = `${JSON.stringify(
  {
    suiteName,
    fixtureRoot,
    fixtureCount: results.length,
    stateCounts: [...new Set(results.map((result) => result.stateCount))],
    axesDetected: results.filter((result) => result.axisMode !== "content")
      .length,
    preprocessingPassed: results.filter(
      (result) => result.preprocessingPassed,
    ).length,
    stateCountPassed: results.filter((result) => result.stateCountPassed)
      .length,
    searchPassed: results.filter((result) => result.searchPassed).length,
    endToEndPassed: results.filter((result) => result.endToEndPassed).length,
    groupResults,
    results: publicResults,
  },
  null,
  2,
)}\n`;
if (process.env.VTH_EVAL_OUTPUT) {
  await writeFile(path.resolve(process.env.VTH_EVAL_OUTPUT), reportJson, "utf8");
}
if (process.env.VTH_EVAL_QUIET !== "1") {
  process.stdout.write(reportJson);
}

assert.equal(
  results.filter((result) => result.preprocessingPassed).length,
  results.length,
  "One or more public preprocessing fixtures failed",
);
assert.equal(
  results.filter((result) => result.endToEndPassed).length,
  results.length,
  "One or more public end-to-end search fixtures failed",
);
assert.ok(
  groupResults.every(
    (result) => {
      if (suiteName === "user-peak-valley") {
        return (
          result.stateCountConsistent &&
          result.topCandidateConsistent &&
          result.minimumProfileSimilarity >= 0.92 &&
          result.minimumTopFiveOverlap === 1 &&
          result.minimumTopTenOverlap >= 0.8
        );
      }
      return (
        result.stateCountConsistent &&
        result.minimumProfileSimilarity >= 0.95 &&
        ((result.minimumTopFiveOverlap >= 0.8 &&
          (result.topCandidateConsistent ||
            result.minimumTopFiveOverlap === 1)) ||
          (result.minimumProfileSimilarity >= 0.98 &&
            result.topCandidateConsistent &&
            result.minimumTopFiveOverlap >= 0.6 &&
            result.minimumTopTenOverlap >= 0.8) ||
          (result.minimumProfileSimilarity >= 0.98 &&
            result.minimumTopFiveOverlap >= 0.6 &&
            result.minimumTopTenOverlap >= 0.9 &&
            result.topTwoSetConsistent) ||
          (result.minimumProfileSimilarity >= 0.96 &&
            result.minimumTopTenOverlap >= 0.7))
      );
    },
  ),
  "One or more public style-variant groups were not retrieval invariant",
);
