import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { analyzeGraphImageFile } from "../lib/vth-node-image-analysis.mjs";
import {
  alignedCurveSimilarity,
  searchCorpus,
} from "../lib/vth-shape-core.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "../..");
const outputRoot = path.resolve(
  process.argv[2] ??
    path.join(projectRoot, "artifacts/artifact-robustness-validation"),
);
const queryRoot = path.join(outputRoot, "queries");
await mkdir(queryRoot, { recursive: true });

const corpus = JSON.parse(
  await readFile(
    path.join(scriptDirectory, "../public/corpus-index.json"),
    "utf8",
  ),
);
const candidateById = new Map(
  corpus.candidates.map((candidate) => [candidate.id, candidate]),
);

const fixtures = [
  {
    group: "measured-4-state",
    source: path.join(
      projectRoot,
      "artifacts/real-measured-multisource-validation/queries/luo-jsac-2016-fig4-10k-original.png",
    ),
    stateCount: 4,
  },
  {
    group: "measured-8-state",
    source: path.join(
      projectRoot,
      "artifacts/real-measured-multisource-validation/queries/freudenberger-2023-fig3-2-original.png",
    ),
    stateCount: 8,
  },
  {
    group: "close-valley-8-state",
    source: path.join(
      projectRoot,
      "artifacts/user-peak-valley-validation/queries/user-peak-valley-original.png",
    ),
    stateCount: 8,
  },
  {
    group: "measured-16-state",
    source: path.join(
      projectRoot,
      "artifacts/real-measured-multisource-validation/queries/ibm-irps-2020-fig8-original.png",
    ),
    stateCount: 16,
  },
];

function linePositions(start, end, count) {
  return Array.from({ length: count }, (_, index) =>
    Math.round(start + ((end - start) * (index + 1)) / (count + 1)),
  );
}

function svgOverlay(width, height, bounds, variant) {
  const left = Math.max(0, bounds.left);
  const right = Math.min(width - 1, bounds.right);
  const top = Math.max(0, bounds.top);
  const bottom = Math.min(height - 1, bounds.bottom);
  const horizontal = linePositions(top, bottom, 9);
  const vertical = linePositions(left, right, 11);
  const lines = [];

  if (variant === "solid-grid" || variant === "combined") {
    for (const y of horizontal) {
      lines.push(
        `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" />`,
      );
    }
    for (const x of vertical) {
      lines.push(
        `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" />`,
      );
    }
  } else if (variant === "dashed-grid") {
    for (const y of horizontal) {
      lines.push(
        `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" />`,
      );
    }
    for (const x of vertical) {
      lines.push(
        `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" />`,
      );
    }
  } else if (variant === "guides-ticks") {
    const guideXs = linePositions(left, right, 5);
    const guideYs = linePositions(top, bottom, 4);
    for (let index = 0; index < guideXs.length; index += 1) {
      const x = guideXs[index];
      const guideTop =
        index % 2 ? top + (bottom - top) * 0.12 : top + (bottom - top) * 0.36;
      lines.push(
        `<line x1="${x}" y1="${guideTop}" x2="${x}" y2="${bottom}" />`,
      );
    }
    for (let index = 0; index < guideYs.length; index += 1) {
      const y = guideYs[index];
      const guideRight =
        index % 2
          ? left + (right - left) * 0.68
          : left + (right - left) * 0.43;
      lines.push(
        `<line x1="${left}" y1="${y}" x2="${guideRight}" y2="${y}" />`,
      );
    }
    for (const x of linePositions(left, right, 17)) {
      lines.push(
        `<line x1="${x}" y1="${bottom - 8}" x2="${x}" y2="${bottom + 8}" />`,
      );
    }
    for (const y of linePositions(top, bottom, 13)) {
      lines.push(
        `<line x1="${left - 8}" y1="${y}" x2="${left + 8}" y2="${y}" />`,
      );
    }
  }

  const dashed = variant === "dashed-grid" ? `stroke-dasharray="9 7"` : "";
  const color =
    variant === "guides-ticks"
      ? "#747474"
      : variant === "combined"
        ? "#9a9a9a"
        : "#aaaaaa";
  const opacity = variant === "guides-ticks" ? 0.9 : 0.78;
  const strokeWidth = variant === "combined" ? 2 : 1.5;
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="${color}" stroke-width="${strokeWidth}" opacity="${opacity}" ${dashed}>
        ${lines.join("\n")}
      </g>
    </svg>`,
  );
}

function deterministicNoise(data, width, height, channels, bounds, strength) {
  const output = Buffer.from(data);
  let seed = (width * 73856093) ^ (height * 19349663);
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const saltCount = Math.floor(width * height * strength);
  for (let index = 0; index < saltCount; index += 1) {
    const x = Math.floor(next() * width);
    const y = Math.floor(next() * height);
    const offset = (y * width + x) * channels;
    const value = next() > 0.7 ? 42 : 136;
    output[offset] = value;
    output[offset + 1] = value;
    output[offset + 2] = value;
  }
  for (let y = Math.max(0, bounds.top); y <= bounds.bottom; y += 17) {
    const shade = 226 + Math.floor(next() * 14);
    for (
      let x = Math.max(0, bounds.left);
      x <= Math.min(width - 1, bounds.right);
      x += 1
    ) {
      const offset = (y * width + x) * channels;
      output[offset] = Math.min(output[offset], shade);
      output[offset + 1] = Math.min(output[offset + 1], shade);
      output[offset + 2] = Math.min(output[offset + 2], shade);
    }
  }
  return output;
}

async function createVariants(fixture) {
  const sourceAnalysis = await analyzeGraphImageFile(fixture.source);
  const [width, height] = sourceAnalysis.preprocessing.sourceSize;
  const bounds = sourceAnalysis.preprocessing.bounds;
  const base = await sharp(fixture.source)
    .resize(width, height, { fit: "fill" })
    .toColourspace("srgb")
    .removeAlpha()
    .png()
    .toBuffer();
  const variants = [];
  const writeVariant = async (name, pipeline) => {
    const extension = name === "combined" ? "jpg" : "png";
    const filePath = path.join(
      queryRoot,
      `${fixture.group}-${name}.${extension}`,
    );
    await pipeline.toFile(filePath);
    variants.push({ name, filePath });
  };

  await writeVariant("baseline", sharp(base));
  await writeVariant(
    "solid-grid",
    sharp(base).composite([
      { input: svgOverlay(width, height, bounds, "solid-grid") },
    ]),
  );
  await writeVariant(
    "dashed-grid",
    sharp(base).composite([
      { input: svgOverlay(width, height, bounds, "dashed-grid") },
    ]),
  );
  await writeVariant(
    "guides-ticks",
    sharp(base).composite([
      { input: svgOverlay(width, height, bounds, "guides-ticks") },
    ]),
  );

  const { data, info } = await sharp(base)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const noisyPixels = deterministicNoise(
    data,
    width,
    height,
    info.channels,
    bounds,
    0.012,
  );
  await writeVariant(
    "background-noise",
    sharp(noisyPixels, {
      raw: { width, height, channels: info.channels },
    }),
  );

  const combinedPixels = deterministicNoise(
    data,
    width,
    height,
    info.channels,
    bounds,
    0.002,
  );
  await writeVariant(
    "combined",
    sharp(combinedPixels, {
      raw: { width, height, channels: info.channels },
    })
      .composite([{ input: svgOverlay(width, height, bounds, "combined") }])
      .jpeg({ quality: 82, chromaSubsampling: "4:2:0" }),
  );
  await writeVariant(
    "rotated-clockwise",
    sharp(base).rotate(3, { background: "#ffffff" }),
  );
  await writeVariant(
    "rotated-counterclockwise",
    sharp(base).rotate(-3, { background: "#ffffff" }),
  );

  return variants;
}

function overlap(left, right, size) {
  const leftSet = new Set(left.slice(0, size));
  return right.slice(0, size).filter((id) => leftSet.has(id)).length / size;
}

function directionalShapeCoverage(sourceIds, targetIds, size) {
  const source = sourceIds
    .slice(0, size)
    .map((id) => candidateById.get(id))
    .filter(Boolean);
  const target = targetIds
    .slice(0, size)
    .map((id) => candidateById.get(id))
    .filter(Boolean);
  if (!source.length || !target.length) return 0;
  return (
    source.reduce(
      (sum, candidate) =>
        sum +
        Math.max(
          ...target.map((other) =>
            alignedCurveSimilarity(candidate.profile, other.profile),
          ),
        ),
      0,
    ) / source.length
  );
}

function symmetricShapeCoverage(leftIds, rightIds, size) {
  return Math.min(
    directionalShapeCoverage(leftIds, rightIds, size),
    directionalShapeCoverage(rightIds, leftIds, size),
  );
}

const groupResults = [];
for (const fixture of fixtures) {
  const variants = await createVariants(fixture);
  const analyzed = [];
  for (const variant of variants) {
    const analysis = await analyzeGraphImageFile(variant.filePath);
    const ranked = searchCorpus(
      analysis.profile,
      analysis.descriptor,
      corpus.candidates,
      corpus.reranker,
      analysis.alternatives,
      corpus.dualEncoder,
    ).slice(0, 10);
    analyzed.push({
      name: variant.name,
      stateCount: analysis.descriptor.stateCount,
      axisMode: analysis.axisMode,
      profile: analysis.profile,
      candidateIds: ranked.map((candidate) => candidate.id),
      topCandidateId: ranked[0]?.id ?? null,
      removedStraightRows:
        analysis.preprocessing.primaryMask.removedStraightRows,
      removedStraightColumns:
        analysis.preprocessing.primaryMask.removedStraightColumns,
      deskewAngle: analysis.preprocessing.deskewAngle,
      deskewApplied: analysis.preprocessing.deskewApplied,
    });
  }

  const baseline = analyzed[0];
  const comparisons = analyzed.slice(1).map((variant) => {
    const baselineCandidate = candidateById.get(baseline.topCandidateId);
    const variantCandidate = candidateById.get(variant.topCandidateId);
    return {
      variant: variant.name,
      stateCount: variant.stateCount,
      profileSimilarity: Number(
        alignedCurveSimilarity(baseline.profile, variant.profile).toFixed(6),
      ),
      topCandidateConsistent:
        baseline.topCandidateId === variant.topCandidateId,
      topCandidateShapeSimilarity:
        baselineCandidate && variantCandidate
          ? Number(
              alignedCurveSimilarity(
                baselineCandidate.profile,
                variantCandidate.profile,
              ).toFixed(6),
            )
          : 0,
      topFiveOverlap: Number(
        overlap(baseline.candidateIds, variant.candidateIds, 5).toFixed(3),
      ),
      topTenOverlap: Number(
        overlap(baseline.candidateIds, variant.candidateIds, 10).toFixed(3),
      ),
      topTenShapeCoverage: Number(
        symmetricShapeCoverage(
          baseline.candidateIds,
          variant.candidateIds,
          10,
        ).toFixed(3),
      ),
      axisMode: variant.axisMode,
      removedStraightRows: variant.removedStraightRows,
      removedStraightColumns: variant.removedStraightColumns,
      deskewAngle: variant.deskewAngle,
      deskewApplied: variant.deskewApplied,
    };
  });
  groupResults.push({
    group: fixture.group,
    expectedStateCount: fixture.stateCount,
    detectedStateCounts: analyzed.map((variant) => variant.stateCount),
    stateCountPassed: analyzed.every(
      (variant) => variant.stateCount === fixture.stateCount,
    ),
    topCandidateConsistencyRate: Number(
      (
        comparisons.filter((result) => result.topCandidateConsistent).length /
        comparisons.length
      ).toFixed(3),
    ),
    minimumProfileSimilarity: Math.min(
      ...comparisons.map((result) => result.profileSimilarity),
    ),
    minimumTopFiveOverlap: Math.min(
      ...comparisons.map((result) => result.topFiveOverlap),
    ),
    minimumTopTenOverlap: Math.min(
      ...comparisons.map((result) => result.topTenOverlap),
    ),
    minimumTopTenShapeCoverage: Math.min(
      ...comparisons.map((result) => result.topTenShapeCoverage),
    ),
    minimumTopCandidateShapeSimilarity: Math.min(
      ...comparisons.map((result) => result.topCandidateShapeSimilarity),
    ),
    comparisons,
  });
}

const summary = {
  fixtureCount: fixtures.length,
  variantCount: groupResults.length * 8,
  stateCountPassed: groupResults.filter((group) => group.stateCountPassed)
    .length,
  minimumProfileSimilarity: Math.min(
    ...groupResults.map((group) => group.minimumProfileSimilarity),
  ),
  minimumTopFiveOverlap: Math.min(
    ...groupResults.map((group) => group.minimumTopFiveOverlap),
  ),
  minimumTopTenOverlap: Math.min(
    ...groupResults.map((group) => group.minimumTopTenOverlap),
  ),
  minimumTopTenShapeCoverage: Math.min(
    ...groupResults.map((group) => group.minimumTopTenShapeCoverage),
  ),
  minimumTopCandidateShapeSimilarity: Math.min(
    ...groupResults.map(
      (group) => group.minimumTopCandidateShapeSimilarity,
    ),
  ),
  groups: groupResults,
};
const reportJson = `${JSON.stringify(summary, null, 2)}\n`;
await writeFile(path.join(outputRoot, "report.json"), reportJson, "utf8");
process.stdout.write(reportJson);

assert.equal(
  summary.stateCountPassed,
  fixtures.length,
  "Artifact variants changed one or more physical State counts",
);
assert.ok(
  groupResults.every((group) =>
    group.comparisons.every(
      (result) =>
        result.profileSimilarity >=
        (result.variant.startsWith("rotated-") ? 0.84 : 0.86),
    ),
  ),
  "Artifact variants changed the extracted Curve too much",
);
assert.ok(
  groupResults.every(
    (group) =>
      group.minimumTopFiveOverlap >= 0.2 &&
      (group.minimumTopTenOverlap >= 0.5 ||
        group.minimumTopTenShapeCoverage >= 0.9) &&
      group.minimumTopCandidateShapeSimilarity >= 0.84,
  ),
  "Artifact variants changed retrieval rankings too much",
);
assert.ok(
  groupResults.every((group) =>
    group.comparisons
      .filter((result) => result.variant.startsWith("rotated-"))
      .every(
        (result) =>
          result.deskewApplied &&
          Math.abs(result.deskewAngle) >= 2.5 &&
          Math.abs(result.deskewAngle) <= 3.5,
      ),
  ),
  "One or more rotated fixtures were not deskewed",
);
