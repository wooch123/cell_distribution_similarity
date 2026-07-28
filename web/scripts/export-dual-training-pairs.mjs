import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fusedShapeFeatureFromProfile } from "../lib/vth-dual-encoder-core.mjs";
import { analyzeGraphImageFile } from "../lib/vth-node-image-analysis.mjs";

const manifestPath = path.resolve(process.argv[2]);
const validationQueryDirectory = process.argv[3]
  ? path.resolve(process.argv[3])
  : null;
const outputPath = path.resolve(process.argv[4]);

const manifest = (await readFile(manifestPath, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const records = [];
for (const [index, record] of manifest.entries()) {
  const analysis = await analyzeGraphImageFile(record.image_path);
  records.push({
    sampleId: record.sample_id,
    variantId: record.variant_id,
    shapeFeature: fusedShapeFeatureFromProfile(analysis.profile),
  });
  if ((index + 1) % 96 === 0) {
    process.stderr.write(`browser training pairs ${index + 1}/${manifest.length}\n`);
  }
}

const validationQueries = {};
if (validationQueryDirectory) {
  const sampleIds = [...new Set(manifest.map((record) => record.sample_id))];
  for (const [index, sampleId] of sampleIds.entries()) {
    const imagePath = path.join(
      validationQueryDirectory,
      `${sampleId}--heldout.png`,
    );
    await access(imagePath);
    const analysis = await analyzeGraphImageFile(imagePath);
    validationQueries[sampleId] = fusedShapeFeatureFromProfile(
      analysis.profile,
    );
    if ((index + 1) % 48 === 0) {
      process.stderr.write(
        `browser validation queries ${index + 1}/${sampleIds.length}\n`,
      );
    }
  }
}

await writeFile(
  outputPath,
  JSON.stringify({
    schemaVersion: 2,
    representation: "browser-image-curve-profile-v2",
    records,
    validationQueries,
  }),
  "utf8",
);
process.stdout.write(
  `${JSON.stringify({
    outputPath,
    records: records.length,
    sampleGroups: new Set(records.map((record) => record.sampleId)).size,
    validationQueries: Object.keys(validationQueries).length,
  })}\n`,
);
