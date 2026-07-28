import os from "node:os";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { analyzeGraphImageFile } from "../lib/vth-node-image-analysis.mjs";
import { descriptorFromProfile } from "../lib/vth-shape-core.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDirectory, "..");
const inputDirectory = path.resolve(
  process.argv[2] ??
    path.join(os.homedir(), "Downloads", "vnand_fault_distributions_100"),
);
const corpusDirectory = path.join(webRoot, "public", "corpus");
const indexPath = path.join(webRoot, "public", "corpus-index.json");

const faultFamilies = {
  Over_Program: ["over-program", "Over Program"],
  Program_Disturb: ["program-disturb", "Program Disturb"],
  Read_Disturb: ["read-disturb", "Read Disturb"],
  Retention_Loss: ["retention-loss", "Retention Loss"],
  Tail_Widening: ["tail-widening", "Tail Widening"],
  Vt_Shift: ["vt-shift", "Vt Shift"],
};

const files = (await readdir(inputDirectory))
  .filter((file) => /^vnand_abnormal_\d{3}_.+\.png$/i.test(file))
  .sort((left, right) => left.localeCompare(right, "en"));
if (files.length !== 100) {
  throw new Error(
    `vnand_fault_distributions_100에는 PNG 100장이 필요하지만 ${files.length}장을 찾았습니다.`,
  );
}

const index = JSON.parse(await readFile(indexPath, "utf8"));
const previousImported = index.candidates.filter((candidate) =>
  String(candidate.id).startsWith("vnand-fault-"),
);
for (const candidate of previousImported) {
  const target = path.join(
    webRoot,
    "public",
    String(candidate.image).replace(/^\/+/, ""),
  );
  await rm(target, { force: true });
}
index.candidates = index.candidates.filter(
  (candidate) => !String(candidate.id).startsWith("vnand-fault-"),
);

await mkdir(corpusDirectory, { recursive: true });
const imported = [];
for (const file of files) {
  const match =
    /^vnand_abnormal_(\d{3})_(.+)\.png$/i.exec(file);
  if (!match) throw new Error(`지원하지 않는 파일명입니다: ${file}`);
  const [, serial, faultKey] = match;
  const family = faultFamilies[faultKey];
  if (!family) throw new Error(`알 수 없는 fault 라벨입니다: ${faultKey}`);

  const id = `vnand-fault-${serial}`;
  const outputName = `${id}.png`;
  const outputPath = path.join(corpusDirectory, outputName);
  await sharp(path.join(inputDirectory, file))
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 9, palette: false })
    .toFile(outputPath);

  const analysis = await analyzeGraphImageFile(outputPath);
  const profile = analysis.profile.map((value) =>
    Number(Number(value).toFixed(6)),
  );
  const descriptor = descriptorFromProfile(profile);
  imported.push({
    id,
    label: `${family[1]} #${serial}`,
    image: `/corpus/${outputName}`,
    profile,
    stateCount: descriptor.stateCount,
    family: family[0],
    peakLocations: descriptor.peakLocations,
    peakWidths: descriptor.peakWidths,
    valleyHeights: descriptor.valleyHeights,
    valleyLocations: descriptor.valleyLocations,
    valleyDepths: descriptor.valleyDepths,
    valleyPositionRatios: descriptor.valleyPositionRatios,
    peakValleyDistances: descriptor.peakValleyDistances,
    tailSlopes: descriptor.tailSlopes,
    area: descriptor.area,
    sourceCollection: "vnand_fault_distributions_100",
  });
}

index.version = 6;
index.candidates.push(...imported);
index.candidateCount = index.candidates.length;
index.faultDistributionImport = {
  source: "vnand_fault_distributions_100",
  imported: imported.length,
  stateCounts: Object.fromEntries(
    [...new Set(imported.map((candidate) => candidate.stateCount))]
      .sort((left, right) => left - right)
      .map((stateCount) => [
        String(stateCount),
        imported.filter((candidate) => candidate.stateCount === stateCount)
          .length,
      ]),
  ),
  families: Object.fromEntries(
    Object.values(faultFamilies).map(([family]) => [
      family,
      imported.filter((candidate) => candidate.family === family).length,
    ]),
  ),
};
await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      inputDirectory,
      imported: imported.length,
      candidateCount: index.candidateCount,
      stateCounts: index.faultDistributionImport.stateCounts,
      families: index.faultDistributionImport.families,
    },
    null,
    2,
  ),
);
