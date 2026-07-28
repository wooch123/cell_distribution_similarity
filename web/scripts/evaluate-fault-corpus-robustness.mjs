import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    path.join(projectRoot, "artifacts/fault-corpus-robustness"),
);
const queryRoot = path.join(outputRoot, "queries");
await rm(queryRoot, { recursive: true, force: true });
await mkdir(queryRoot, { recursive: true });

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
const faultCandidates = corpus.candidates.filter(
  (candidate) => candidate.sourceCollection === "vnand_fault_distributions_100",
);
assert.equal(faultCandidates.length, 100);

function svgArtifacts(width, height, bounds, kind, serial) {
  const left = Math.max(0, bounds.left);
  const right = Math.min(width - 1, bounds.right);
  const top = Math.max(0, bounds.top);
  const bottom = Math.min(height - 1, bounds.bottom);
  const lines = [];
  const dash = kind === "combined" ? 'stroke-dasharray="7 6"' : "";
  for (let index = 1; index <= 8; index += 1) {
    const y = top + ((bottom - top) * index) / 9;
    lines.push(
      `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" ${dash}/>`
    );
  }
  for (let index = 1; index <= 10; index += 1) {
    const x = left + ((right - left) * index) / 11;
    lines.push(
      `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" ${dash}/>`
    );
  }
  const speckles = [];
  if (kind === "combined") {
    let state = Number(serial);
    for (let index = 0; index < 90; index += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const x = state % width;
      state = (state * 1664525 + 1013904223) >>> 0;
      const y = state % height;
      const radius = 0.45 + ((state >>> 9) % 3) * 0.35;
      speckles.push(
        `<circle cx="${x}" cy="${y}" r="${radius.toFixed(2)}" fill="#68716f" opacity="0.42"/>`,
      );
    }
  }
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="#6f7775" stroke-width="1.15" opacity="0.48">
        ${lines.join("")}
      </g>
      ${speckles.join("")}
    </svg>`,
  );
}

async function createVariants(candidate) {
  const sourcePath = path.join(
    scriptDirectory,
    "../public",
    candidate.image.replace(/^\/+/, ""),
  );
  const baselineAnalysis = await analyzeGraphImageFile(sourcePath);
  const [width, height] = baselineAnalysis.preprocessing.sourceSize;
  const bounds = baselineAnalysis.preprocessing.bounds;
  const serial = candidate.id.split("-").at(-1);
  const base = await sharp(sourcePath)
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .png()
    .toBuffer();
  const variants = [{ name: "baseline", filePath: sourcePath }];
  const writeVariant = async (name, pipeline, extension = "png") => {
    const filePath = path.join(queryRoot, `${candidate.id}-${name}.${extension}`);
    await pipeline.toFile(filePath);
    variants.push({ name, filePath });
  };
  await writeVariant(
    "resized",
    sharp(base).resize(Math.round(width * 0.62), Math.round(height * 0.62)),
  );
  await writeVariant("jpeg-72", sharp(base).jpeg({ quality: 72 }), "jpg");
  await writeVariant(
    "solid-grid",
    sharp(base).composite([
      { input: svgArtifacts(width, height, bounds, "solid-grid", serial) },
    ]),
  );
  await writeVariant(
    "rotated-clockwise",
    sharp(base).rotate(3, { background: "#ffffff" }),
  );
  await writeVariant(
    "rotated-counterclockwise",
    sharp(base).rotate(-3, { background: "#ffffff" }),
  );
  await writeVariant(
    "combined",
    sharp(base)
      .composite([
        { input: svgArtifacts(width, height, bounds, "combined", serial) },
      ])
      .rotate(2, { background: "#ffffff" })
      .jpeg({ quality: 78, chromaSubsampling: "4:2:0" }),
    "jpg",
  );
  return { baselineAnalysis, variants };
}

function topKOverlap(left, right, limit = 10) {
  const leftSet = new Set(left.slice(0, limit));
  return right.slice(0, limit).filter((id) => leftSet.has(id)).length / limit;
}

const records = [];
for (const candidate of faultCandidates) {
  const { baselineAnalysis, variants } = await createVariants(candidate);
  const exactShapeIds = new Set(
    faultCandidates
      .filter(
        (item) =>
          JSON.stringify(item.profile) === JSON.stringify(candidate.profile),
      )
      .map((item) => item.id),
  );
  const baselineRanked = searchCorpus(
    baselineAnalysis.profile,
    baselineAnalysis.descriptor,
    corpus.candidates,
    corpus.reranker,
    baselineAnalysis.alternatives,
    corpus.dualEncoder,
  );
  const baselineIds = baselineRanked.slice(0, 10).map((item) => item.id);

  for (const variant of variants) {
    const analysis =
      variant.name === "baseline"
        ? baselineAnalysis
        : await analyzeGraphImageFile(variant.filePath);
    const ranked = searchCorpus(
      analysis.profile,
      analysis.descriptor,
      corpus.candidates,
      corpus.reranker,
      analysis.alternatives,
      corpus.dualEncoder,
    );
    const candidateRank =
      ranked.find((item) => item.id === candidate.id)?.rank ?? null;
    const exactShapeRank =
      ranked.find((item) => exactShapeIds.has(item.id))?.rank ?? null;
    const topIds = ranked.slice(0, 10).map((item) => item.id);
    records.push({
      candidateId: candidate.id,
      family: candidate.family,
      variant: variant.name,
      expectedStateCount: candidate.stateCount,
      detectedStateCount: analysis.descriptor.stateCount,
      statePreserved: analysis.descriptor.stateCount === candidate.stateCount,
      candidateRank,
      exactShapeRank,
      exactShapeTop10: exactShapeRank !== null && exactShapeRank <= 10,
      profileSimilarity: alignedCurveSimilarity(
        candidate.profile,
        analysis.profile,
      ),
      baselineTop10Overlap: topKOverlap(baselineIds, topIds),
      topCandidateId: ranked[0]?.id ?? null,
      topCandidateFamily: ranked[0]?.family ?? null,
      deskewAngle: analysis.preprocessing.deskewAngle,
    });
  }
}

const variantNames = [...new Set(records.map((record) => record.variant))];
const summarize = (selection) => ({
  queries: selection.length,
  statePreserved: selection.filter((record) => record.statePreserved).length,
  exactShapeTop10: selection.filter((record) => record.exactShapeTop10).length,
  exactIdTop10: selection.filter(
    (record) => record.candidateRank !== null && record.candidateRank <= 10,
  ).length,
  familyTop1: selection.filter(
    (record) => record.topCandidateFamily === record.family,
  ).length,
  minimumProfileSimilarity: Math.min(
    ...selection.map((record) => record.profileSimilarity),
  ),
  meanProfileSimilarity:
    selection.reduce((sum, record) => sum + record.profileSimilarity, 0) /
    selection.length,
  minimumTop10Overlap: Math.min(
    ...selection.map((record) => record.baselineTop10Overlap),
  ),
  meanTop10Overlap:
    selection.reduce((sum, record) => sum + record.baselineTop10Overlap, 0) /
    selection.length,
});
const byVariant = Object.fromEntries(
  variantNames.map((variant) => [
    variant,
    summarize(records.filter((record) => record.variant === variant)),
  ]),
);
const report = {
  schemaVersion: 1,
  corpusVersion: corpus.version,
  corpusCandidates: corpus.candidateCount,
  sourceCandidates: faultCandidates.length,
  variantsPerCandidate: variantNames.length,
  totalQueries: records.length,
  summary: summarize(records),
  byVariant,
  failures: records.filter(
    (record) => !record.statePreserved || !record.exactShapeTop10,
  ),
  records,
};
await writeFile(
  path.join(outputRoot, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
assert.equal(
  report.byVariant.baseline.exactShapeTop10,
  100,
  "원본 100장은 모두 exact-shape Top-10에 포함되어야 합니다.",
);
assert.ok(
  report.byVariant["solid-grid"].exactShapeTop10 >= 95,
  "격자 변형 exact-shape Top-10이 95% 미만입니다.",
);
assert.ok(
  report.byVariant.combined.exactShapeTop10 >= 80,
  "격자+노이즈+회전+JPEG 복합 변형 exact-shape Top-10이 80% 미만입니다.",
);
assert.ok(
  report.byVariant.combined.familyTop1 >= 85,
  "복합 변형의 fault 계열 Top-1이 85% 미만입니다.",
);
assert.ok(
  report.summary.exactShapeTop10 >= 640,
  "전체 700-query exact-shape Top-10이 640건 미만입니다.",
);

console.log(
  JSON.stringify(
    {
      outputRoot,
      totalQueries: report.totalQueries,
      summary: report.summary,
      byVariant: report.byVariant,
      failures: report.failures.length,
    },
    null,
    2,
  ),
);
