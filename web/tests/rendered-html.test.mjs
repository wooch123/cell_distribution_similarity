import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";
import jpeg from "jpeg-js";
import {
  assembleUbuntuPackage,
  assembleWindowsPackage,
} from "../lib/vth-download-core.mjs";

const projectRoot = new URL("../", import.meta.url);
const distClientRoot = new URL("../dist/client/", import.meta.url);

function assetsFromDist() {
  return {
    fetch: async (request) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const relativePath = pathname.replace(/^\/+/, "");
      if (!relativePath || relativePath.split("/").includes("..")) {
        return new Response("Not found", { status: 404 });
      }
      try {
        const bytes = await readFile(new URL(relativePath, distClientRoot));
        return new Response(bytes, {
          status: 200,
          headers: { "Content-Length": String(bytes.length) },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };
}

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

function nonDistributionJpeg() {
  const width = 320;
  const height = 180;
  const rgba = new Uint8Array(width * height * 4).fill(255);
  const paint = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    rgba[offset] = 20;
    rgba[offset + 1] = 20;
    rgba[offset + 2] = 20;
  };
  for (let x = 12; x <= 308; x += 20) {
    for (let y = 10; y <= 170; y += 1) {
      paint(x, y);
      paint(x + 1, y);
    }
  }
  for (let y = 10; y <= 170; y += 20) {
    for (let x = 12; x <= 308; x += 1) {
      paint(x, y);
      paint(x, y + 1);
    }
  }
  return jpeg.encode({ data: rgba, width, height }, 84).data;
}

test("server-renders the VTH similarity product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>유사 산포 검색<\/title>/i);
  assert.doesNotMatch(html, /VTH MATCH/i);
  assert.doesNotMatch(html, /V-NAND 산포를/);
  assert.doesNotMatch(html, /형상으로 찾습니다/);
  assert.doesNotMatch(html, /로그 스케일 VTH 그래프 한 장이면 충분합니다/);
  assert.doesNotMatch(html, /LOG-SCALE SHAPE RETRIEVAL/);
  assert.doesNotMatch(html, /LOG Y RANGE/);
  assert.doesNotMatch(html, /RECOMMENDATIONS/);
  assert.doesNotMatch(html, /IMAGE PROCESSING/);
  assert.match(html, /랜덤 데모 그래프/);
  assert.match(html, /랜덤 멀티 차트 분석/);
  assert.match(html, /샘플 1/);
  assert.match(html, /가변 크기/);
  assert.match(html, /저해상도/);
  assert.match(html, /경계 없는 Curve/);
  assert.match(html, /FHD 밀집 30차트/);
  assert.match(
    html,
    /vnand-random-multichart-mixed-01\.png/,
  );
  assert.match(
    html,
    /vnand-random-multichart-mixed-02\.png/,
  );
  assert.match(
    html,
    /vnand-random-multichart-lowres-03\.png/,
  );
  assert.match(
    html,
    /vnand-random-multichart-frameless-04\.png/,
  );
  assert.match(
    html,
    /vnand-fhd-dense-30-chart-sample\.png/,
  );
  assert.match(html, /검색 API 문서/);
  assert.match(html, /완전 독립판 다운로드/);
  assert.match(html, /WINDOWS X64 · FULL OFFLINE/);
  assert.match(html, /UBUNTU X64 · WEB SERVER/);
  assert.match(html, /외부 Web 서버 다운로드/);
  assert.match(html, /ENGINE V3\.6/);
  assert.match(html, /WAVEFORM-ONLY/);
  assert.match(html, /30-PANEL MAX/);
  assert.match(
    html,
    /동의 시 표준 Curve \+ 원본 미리보기를 공용 학습/,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("public shared ready ingestion rejects a non-waveform source before storage", async () => {
  const corpus = JSON.parse(
    await readFile(
      new URL("../public/corpus-index.json", import.meta.url),
      "utf8",
    ),
  );
  const candidate = corpus.candidates.find(
    (item) => item.id === "vth-08s-s0042-00000",
  );
  assert.ok(candidate);
  const form = new FormData();
  form.append(
    "payload",
    JSON.stringify({
      schemaVersion: 2,
      label: "Rejected table",
      profile: candidate.profile,
      descriptor: {
        stateCount: candidate.stateCount,
        observedStateCount: candidate.observedStateCount,
        regularized: candidate.regularized,
        peakLocations: candidate.peakLocations,
        peakWidths: candidate.peakWidths,
        valleyHeights: candidate.valleyHeights,
        valleyLocations: candidate.valleyLocations,
        valleyDepths: candidate.valleyDepths,
        valleyPositionRatios: candidate.valleyPositionRatios,
        peakValleyDistances: candidate.peakValleyDistances,
        tailSlopes: candidate.tailSlopes,
        area: candidate.area,
      },
      sharingConsent: true,
      consentVersion: "2026-07-28-v2",
      contributorToken: "a".repeat(32),
      deletionToken: "b".repeat(32),
    }),
  );
  form.append(
    "sourceImage",
    new File([nonDistributionJpeg()], "table.jpg", {
      type: "image/jpeg",
    }),
  );

  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(
    "shared-ingestion-test",
    `${process.pid}-${Date.now()}`,
  );
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request(
      "http://localhost/api/v1/shared-training-samples",
      {
        method: "POST",
        body: form,
      },
    ),
    { ASSETS: assetsFromDist() },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(
    payload.error.code,
    "distribution_waveform_not_found",
  );
  assert.equal(
    payload.error.reasonCode,
    "table_lattice_dominant",
  );
  assert.equal(
    payload.error.details.diagnosticCode,
    "VTH-DETECT-TABLE-LATTICE",
  );
  assert.ok(payload.error.details.action);
});

test("stacks the source panel above a wide, shallow normalized Curve", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const basePreview = styles.match(
    /\.analysis-preview\s*\{([\s\S]*?)\}/,
  )?.[1];

  assert.ok(basePreview, "analysis preview styles are missing");
  assert.match(basePreview, /grid-template-columns:\s*1fr/);
  assert.match(
    basePreview,
    /grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto/,
  );
  assert.match(
    styles,
    /\.workspace\.has-analysis \.analysis-preview\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto/,
  );
  assert.match(
    styles,
    /\.normalized-curve-view\s*\{[\s\S]*?grid-template-rows:\s*auto\s+clamp\(64px,\s*8vw,\s*100px\)\s+auto/,
  );
  assert.match(
    styles,
    /\.profile-canvas\s*\{[\s\S]*?max-height:\s*100px/,
  );
  assert.match(
    styles,
    /@media \(max-width: 760px\)[\s\S]*?\.analysis-preview\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1\.08fr\)\s+minmax\(0,\s*0\.92fr\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 760px\)[\s\S]*?\.normalized-curve-view\s*\{[\s\S]*?grid-template-columns:\s*minmax\(92px,\s*0\.65fr\)\s+minmax\(0,\s*1\.35fr\)/,
  );
});

async function verifyStandalonePackageDownload({
  manifestFileName,
  checksumFileName,
  expectedVersion,
  expectedFileName,
  expectedDownloadFileName,
  assemble,
}) {
  const [metadataText, checksumText] = await Promise.all([
    readFile(
      new URL(
        `../public/downloads/${manifestFileName}`,
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        `../public/downloads/${checksumFileName}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const metadata = JSON.parse(metadataText);
  const sourceParts = await Promise.all(
    metadata.parts.map((part) =>
      readFile(new URL(`../public${part.path}`, import.meta.url)),
    ),
  );
  const deployedParts = await Promise.all(
    metadata.parts.map((part) =>
      readFile(new URL(`../dist/client${part.path}`, import.meta.url)),
    ),
  );
  const zip = Buffer.concat(sourceParts);
  const digest = createHash("sha256").update(zip).digest("hex");

  assert.deepEqual(deployedParts, sourceParts);
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.version, expectedVersion);
  assert.equal(metadata.fileName, expectedFileName);
  assert.equal(metadata.delivery, "browser-assembled");
  assert.equal(metadata.bytes, zip.length);
  assert.equal(metadata.sha256, digest);
  assert.ok(metadata.parts.length >= 1);
  assert.equal(
    metadata.parts.reduce((total, part) => total + part.bytes, 0),
    metadata.bytes,
  );
  metadata.parts.forEach((part, index) => {
    assert.equal(part.index, index);
    assert.equal(part.bytes, sourceParts[index].length);
    assert.equal(
      part.sha256,
      createHash("sha256").update(sourceParts[index]).digest("hex"),
    );
  });
  assert.equal(
    checksumText,
    `${digest} *${expectedFileName}\n`,
  );

  const progress = [];
  const assembled = await assemble({
    fetchImpl: async (input) => {
      const url = new URL(String(input), "http://localhost");
      return assetsFromDist().fetch(
        new Request(`http://localhost${url.pathname}`),
      );
    },
    onProgress: (event) => progress.push(event),
  });
  const downloaded = Buffer.from(await assembled.blob.arrayBuffer());
  assert.equal(assembled.fileName, expectedDownloadFileName);
  assert.equal(assembled.manifest.sha256, digest);
  assert.equal(downloaded.length, zip.length);
  assert.equal(
    createHash("sha256").update(downloaded).digest("hex"),
    digest,
  );
  assert.equal(
    progress.filter((event) => event.phase === "parts").length,
    metadata.parts.length,
  );
  assert.equal(progress.at(-1).phase, "verify");
}

test("ships the verified Windows standalone package as a web download", async () => {
  await verifyStandalonePackageDownload({
    manifestFileName: "windows-package-v1.36.0.json",
    checksumFileName: "vth-similarity-windows-x64.sha256",
    expectedVersion: "1.36.0",
    expectedFileName: "vth-similarity-windows-x64.zip",
    expectedDownloadFileName:
      "vth-similarity-windows-x64-v1.36.0.zip",
    assemble: assembleWindowsPackage,
  });
});

test("ships the verified Ubuntu external Web server package as a web download", async () => {
  await verifyStandalonePackageDownload({
    manifestFileName: "ubuntu-package-v1.36.0.json",
    checksumFileName: "vth-similarity-ubuntu-x64.sha256",
    expectedVersion: "1.36.0",
    expectedFileName: "vth-similarity-ubuntu-x64.tar.gz",
    expectedDownloadFileName:
      "vth-similarity-ubuntu-x64-v1.36.0.tar.gz",
    assemble: assembleUbuntuPackage,
  });
});

test("ships a complete browser search corpus and no starter preview", async () => {
  const [indexText, packageJson] = await Promise.all([
    readFile(new URL("../public/corpus-index.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const index = JSON.parse(indexText);

  assert.equal(index.yScale, "log10");
  assert.equal(index.yFloor, 1e-6);
  assert.equal(index.version, 6);
  assert.equal(index.candidateCount, 196);
  assert.equal(index.candidates.length, index.candidateCount);
  assert.equal(
    new Set(index.candidates.map((candidate) => candidate.id)).size,
    index.candidateCount,
  );
  // The promoted compact nonlinear encoder remains small enough for offline use.
  assert.ok(Buffer.byteLength(indexText, "utf8") < 1_000_000);
  assert.deepEqual(index.stateCounts, [2, 4, 8, 16]);
  assert.equal(index.imageEncoder?.version, 1);
  assert.equal(index.imageEncoder?.kind, "canonical-curve-raster-hog");
  assert.equal(index.imageEncoder?.dimensions, 3200);
  assert.equal(index.imageEncoder?.raster?.dimensions, 2048);
  assert.equal(index.imageEncoder?.hog?.dimensions, 1152);
  assert.equal(index.imageEncoder?.hog?.weight, 0.25);
  assert.ok(index.candidates.every((candidate) => candidate.profile.length === 256));
  assert.deepEqual(
    [...new Set(index.candidates.map((candidate) => candidate.stateCount))],
    [2, 4, 8, 16],
  );
  const selectedSynthetic = index.candidates.filter(
    (candidate) => !candidate.id.startsWith("vnand-fault-"),
  );
  assert.equal(selectedSynthetic.length, 96);
  for (const stateCount of index.stateCounts) {
    assert.equal(
      selectedSynthetic.filter((candidate) => candidate.stateCount === stateCount)
        .length,
      24,
    );
    const selection = index.selection.byState[String(stateCount)];
    assert.equal(selection.source, 48);
    assert.equal(selection.selected, 24);
    assert.equal(selection.baselinePreserved, 12);
    assert.ok(
      selection.selectedCoverage.mean > selection.baselineCoverage.mean,
    );
    assert.ok(
      selection.selectedCoverage.minimum >
        selection.baselineCoverage.minimum,
    );
    assert.deepEqual(Object.keys(selection.families).sort(), [
      "asymmetric",
      "balanced",
      "compressed",
      "wide-tail",
    ]);
  }
  assert.equal(index.selection.sourceCandidateCount, 192);
  assert.equal(index.selection.selectedCandidateCount, 96);
  assert.equal(index.faultDistributionImport.imported, 100);
  assert.deepEqual(index.faultDistributionImport.stateCounts, {
    4: 5,
    8: 95,
  });
  const faultCandidates = index.candidates.filter((candidate) =>
    candidate.id.startsWith("vnand-fault-"),
  );
  assert.equal(faultCandidates.length, 100);
  assert.ok(
    faultCandidates.every(
      (candidate) =>
        candidate.sourceCollection === "vnand_fault_distributions_100",
    ),
  );
  assert.equal(index.reranker.version, 2);
  assert.equal(index.reranker.featureNames.length, index.reranker.weights.length);
  assert.deepEqual(index.reranker.scoreCalibration, {
    reranked: 0.7,
    retrieval: 0.3,
  });
  assert.equal(index.dualEncoder.version, 2);
  assert.equal(index.dualEncoder.kind, "vth-dual-curve-mlp");
  assert.equal(index.dualEncoder.inputDimensions, 384);
  assert.equal(index.dualEncoder.embeddingDimensions, 4);
  assert.equal(index.dualEncoder.hiddenDimensions, 8);
  assert.equal(index.dualEncoder.activation, "tanh");
  assert.equal(index.dualEncoder.blendWeight, 0.08);
  assert.equal(index.dualEncoder.rerankLimit, 2);
  assert.equal(index.dualEncoder.validation.promotionPassed, true);
  assert.equal(index.dualEncoder.validation.external.passed, true);
  assert.equal(index.dualEncoder.validation.fullyPromoted, true);
  const corpusImages = await readdir(
    new URL("../public/corpus", import.meta.url),
  );
  assert.equal(corpusImages.length, index.candidateCount);
  await Promise.all(
    index.candidates.map((candidate) =>
      access(new URL(`../public${candidate.image}`, import.meta.url)),
    ),
  );
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/demo-query.png", import.meta.url));
  const [pptSample, deployedPptSample] = await Promise.all([
    readFile(
      new URL(
        "../public/samples/vnand-ppt-12-chart-sample.png",
        import.meta.url,
      ),
    ),
    readFile(
      new URL(
        "../dist/client/samples/vnand-ppt-12-chart-sample.png",
        import.meta.url,
      ),
    ),
  ]);
  assert.deepEqual(deployedPptSample, pptSample);
  assert.deepEqual(
    [...pptSample.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(pptSample.readUInt32BE(16), 1600);
  assert.equal(pptSample.readUInt32BE(20), 900);
  assert.ok(pptSample.length > 50_000);
  const randomSampleManifest = JSON.parse(
    await readFile(
      new URL(
        "../public/samples/random-multichart-samples.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(randomSampleManifest.samples.length, 4);
  await Promise.all(
    randomSampleManifest.samples.map(async (sample) => {
      const [source, deployed] = await Promise.all([
        readFile(
          new URL(
            `../public/samples/${sample.fileName}`,
            import.meta.url,
          ),
        ),
        readFile(
          new URL(
            `../dist/client/samples/${sample.fileName}`,
            import.meta.url,
          ),
        ),
      ]);
      assert.deepEqual(deployed, source);
      assert.deepEqual(
        [...source.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
    }),
  );
  const [
    denseFhdSource,
    denseFhdDeployed,
    denseFhdMetadataText,
    denseFhdDeployedMetadataText,
  ] = await Promise.all([
    readFile(
      new URL(
        "../public/samples/vnand-fhd-dense-30-chart-sample.png",
        import.meta.url,
      ),
    ),
    readFile(
      new URL(
        "../dist/client/samples/vnand-fhd-dense-30-chart-sample.png",
        import.meta.url,
      ),
    ),
    readFile(
      new URL(
        "../public/samples/vnand-fhd-dense-30-chart-sample.json",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../dist/client/samples/vnand-fhd-dense-30-chart-sample.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.deepEqual(denseFhdDeployed, denseFhdSource);
  assert.equal(denseFhdDeployedMetadataText, denseFhdMetadataText);
  assert.deepEqual(
    [...denseFhdSource.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(denseFhdSource.readUInt32BE(16), 1920);
  assert.equal(denseFhdSource.readUInt32BE(20), 1080);
  const denseFhdMetadata = JSON.parse(denseFhdMetadataText);
  assert.equal(denseFhdMetadata.expectedChartCount, 30);
  assert.deepEqual(denseFhdMetadata.layout, { rows: 5, columns: 6 });
  assert.equal(denseFhdMetadata.charts.length, 30);
});

test("shares standardized candidates and anonymous relevance labels centrally", async () => {
  const [
    source,
    imageCore,
    imageAnalysisCore,
    shapeCore,
    feedbackCore,
    learningCore,
    sharedCore,
    sharedRoute,
    sharedStore,
    sharedRelevanceCore,
    sharedRelevanceRoute,
    sharedRelevanceStore,
    trainingMigration,
    relevanceMigration,
  ] =
    await Promise.all([
    readFile(new URL("../app/VthSearchApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/vth-image-core.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("../lib/vth-image-analysis-core.mjs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/vth-shape-core.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/vth-feedback-core.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/vth-learning-core.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("../lib/vth-shared-training-core.mjs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/v1/shared-training-samples/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../db/shared-candidates.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../lib/vth-shared-relevance-core.mjs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/v1/shared-relevance-reports/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../db/shared-relevance.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../drizzle/0000_fat_nightmare.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../drizzle/0001_brief_madrox.sql", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(source, /createImageBitmap\(file\)/);
  assert.match(
    source,
    /buildForegroundMasks\(\s*pixels,\s*width,\s*height,\s*4,\s*\{ sourceScale: analysisScale \},\s*\)/s,
  );
  assert.match(source, /boundedRasterScale/);
  assert.match(source, /무작위 배치·저해상도/);
  assert.match(source, /비차트 자동 제외/);
  assert.match(source, /텍스트.*표.*빈 좌표계.*설명 도형/s);
  assert.match(source, /analyzeForegroundMasks/);
  assert.match(source, /detectChartPanels/);
  assert.match(source, /extractChartProfiles/);
  assert.match(source, /data-testid="chart-panel-tabs"/);
  assert.match(source, /data-testid="source-panel-crop"/);
  assert.match(source, /data-testid="normalized-curve-view"/);
  assert.match(source, /data-testid="panel-extraction-evidence"/);
  assert.match(source, /선택 원본 패널/);
  assert.match(source, /정규화 추출 Curve/);
  assert.match(source, /검출 State/);
  assert.match(source, /관측 State/);
  assert.match(source, /피크 \/ 밸리/);
  assert.match(source, /축 방식/);
  assert.match(source, /제거 라벨/);
  assert.match(source, /Curve 검증/);
  assert.match(source, /panelExtractionQuality/);
  assert.match(source, /분리 차트.*개 모두/s);
  assert.match(
    source,
    /차트 내부의 색상별 시리즈.*각각 독립\s+후보로 저장합니다/s,
  );
  assert.match(source, /seriesCount/);
  assert.match(source, /selectedSeriesIndex/);
  assert.match(source, /색상별 시리즈 분리/);
  assert.match(source, /픽셀 크기 자동 정규화/);
  assert.match(source, /VTH_DIAGNOSTIC_CODES/);
  assert.match(source, /원인별 오류 코드 안내/);
  assert.match(source, /diagnosticDisplayMessage/);
  assert.match(source, /analysisBusyRef/);
  assert.match(source, /learningBusyRef/);
  assert.match(source, /feedbackSubmissionRef/);
  assert.match(source, /panelInteractionsRef/);
  assert.match(source, /target\.isContentEditable/);
  assert.match(source, /isSupportedBatchImage\(file\)/);
  assert.match(source, /foreground\.curveColorMasks/);
  assert.match(imageCore, /suppressMaskNoise\(broadMask, width, height\)/);
  assert.match(imageCore, /suppressPlotLabels/);
  assert.match(imageCore, /restoredLabelCrossingPixels/);
  assert.match(imageCore, /chromaticContrast/);
  assert.match(imageCore, /curveColorMasks/);
  assert.match(
    imageAnalysisCore,
    /deskewForegroundMasks/,
  );
  assert.match(imageAnalysisCore, /buildCurveMask/);
  assert.match(imageAnalysisCore, /canonicalProfileFromCurveMask/);
  assert.match(imageAnalysisCore, /descriptorFromProfile/);
  assert.match(
    imageAnalysisCore,
    /extractCurveDistributionCandidates/,
  );
  assert.match(
    imageAnalysisCore,
    /extractColorDistributionCandidates/,
  );
  assert.match(imageAnalysisCore, /most-irregular/);
  assert.match(source, /coreSearchCorpus/);
  assert.match(source, /LABEL×/);
  assert.match(source, /범례·주석 라벨 제거 후 Curve 복원/);
  assert.match(
    source,
    /URL\.createObjectURL\(\s*extracted\.previewBlob,\s*\)/s,
  );
  assert.match(source, /addEventListener\("paste", handlePaste\)/);
  assert.match(source, /clipboardData\?\.items/);
  assert.match(source, /fetch\("\/corpus-index\.json"\)/);
  assert.doesNotMatch(source, /body:\s*file|XMLHttpRequest/);
  assert.match(source, /new FormData\(\)/);
  assert.match(source, /form\.append\("sourceImage"/);
  assert.match(source, /sanitizedSourceImageBlob/);
  assert.doesNotMatch(source, /https:\/\/dove9999\.com/);
  assert.match(source, /\/api\/v1\/runtime/);
  assert.match(source, /externalNetworkAllowed/);
  assert.match(source, /data-testid="windows-download"/);
  assert.match(source, /data-testid="ubuntu-download"/);
  assert.match(source, /assembleUbuntuPackage/);
  assert.match(source, /buildTrainingApiPayload/);
  assert.match(source, /standardizedProfilePngDataUrl/);
  assert.match(source, /blobToDataUrl/);
  assert.match(source, /chooseRandomDemoCandidate/);
  assert.match(source, /lastDemoIdRef/);
  assert.match(source, /runRandomMultichartSample/);
  assert.match(source, /lastMultichartSampleUrlRef/);
  assert.match(
    source,
    /data-testid="random-multichart-sample-analyze"/,
  );
  assert.match(
    source,
    /data-testid="random-multichart-sample-downloads"/,
  );
  assert.match(source, /vnand-random-multichart-mixed-01\.png/);
  assert.match(source, /vnand-random-multichart-mixed-02\.png/);
  assert.match(source, /vnand-random-multichart-lowres-03\.png/);
  assert.match(source, /vnand-random-multichart-frameless-04\.png/);
  assert.match(source, /vnand-fhd-dense-30-chart-sample\.png/);
  assert.match(source, /FHD 밀집 30차트/);
  assert.doesNotMatch(source, /standardizedImageDataUrl/);
  assert.match(source, /\/api\/v1\/shared-training-samples/);
  assert.match(source, /SHARED_TRAINING_CONSENT_VERSION/);
  assert.match(source, /data-testid="shared-training-consent"/);
  assert.match(source, /data-testid="learn-multiple-files"/);
  assert.match(source, /data-testid="learn-folder"/);
  assert.match(source, /data-testid="learning-tab-manage"/);
  assert.match(source, /data-testid="learning-data-management"/);
  assert.match(source, /data-testid="learned-data-list"/);
  assert.match(source, /data-testid="delete-selected-learned"/);
  assert.match(source, /data-testid="confirm-delete-selected-learned"/);
  assert.match(source, /이 브라우저에서 등록한 항목만 삭제할 수 있습니다/);
  assert.match(learningCore, /deleteLearnedCandidateSelection/);
  assert.match(learningCore, /deletableLearnedCandidateIds/);
  assert.match(source, /webkitdirectory/);
  assert.match(source, /지원\s+이미지를\s+빠짐없이\s+순차 학습/);
  assert.match(source, /data-testid="learn-current-image"/);
  assert.match(source, /다른 사용자의 검색에도 즉시 노출됩니다/);
  assert.match(source, /추천 시 원본도 함께 표시/);
  assert.match(source, /result\.sourceImage/);
  assert.match(source, /복수 전문가 합의와 회귀 게이트/);
  assert.match(learningCore, /eligible.*previousId/s);
  assert.match(learningCore, /profile, 256/);
  assert.match(learningCore, /buildSharedTrainingApiPayload/);
  assert.match(sharedCore, /sharingConsent !== true/);
  assert.match(sharedCore, /renderStandardizedCurveSvg/);
  assert.match(sharedCore, /canonicalShapeFingerprintInput/);
  assert.match(sharedCore, /fetchAllSharedTrainingCandidates/);
  assert.match(sharedCore, /MAX_SHARED_CANDIDATE_PAGE_SIZE = 500/);
  assert.match(sharedCore, /encodeSharedCandidateCursor/);
  assert.match(sharedRoute, /createSharedTrainingCandidate/);
  assert.match(sharedRoute, /authoritativeProfile/);
  assert.match(sharedRoute, /descriptorFromProfile/);
  assert.match(sharedRoute, /nextCursor/);
  assert.match(sharedStore, /VTH_SHARED_IMAGES/);
  assert.match(sharedStore, /source_image_key/);
  assert.match(sharedStore, /getSharedCandidateSourceImage/);
  assert.match(sharedStore, /WHERE fingerprint = \?/);
  assert.match(sharedStore, /existing\?\.status === "active"/);
  assert.match(sharedStore, /MAX_SHARED_CANDIDATES_PER_DAY/);
  assert.match(sharedCore, /MAX_SHARED_CANDIDATES_PER_DAY = 200/);
  assert.match(sharedStore, /created_at < \?/);
  assert.match(sharedStore, /id < \?/);
  assert.match(sharedStore, /safeLimit \+ 1/);
  assert.match(source, /fetchAllSharedTrainingCandidates/);
  assert.doesNotMatch(source, /shared-training-samples\?limit=500/);
  assert.match(trainingMigration, /CREATE TABLE `shared_training_samples`/);
  assert.match(trainingMigration, /shared_training_samples_fingerprint_idx/);
  assert.match(source, /\/api\/v1\/shared-relevance-health/);
  assert.match(source, /\/api\/v1\/shared-relevance-reports/);
  assert.match(source, /data-testid="shared-relevance-consent"/);
  assert.match(source, /data-testid="shared-relevance-submit"/);
  assert.match(source, /data-testid="shared-relevance-delete"/);
  assert.match(sharedRelevanceCore, /normalized_shape_shared !== true/);
  assert.match(sharedRelevanceCore, /report\.judgments\.map\(sanitizeJudgment\)/);
  assert.match(sharedRelevanceRoute, /createSharedRelevanceReport/);
  assert.match(sharedRelevanceStore, /COUNT\(DISTINCT annotator_hash\) >= 2/);
  assert.match(sharedRelevanceStore, /queryHash\.slice\(0, 16\)/);
  assert.match(sharedRelevanceStore, /annotatorHash\.slice\(0, 16\)/);
  assert.match(relevanceMigration, /CREATE TABLE `shared_relevance_reports`/);
  assert.match(relevanceMigration, /shared_relevance_query_annotator_idx/);
  assert.match(shapeCore, /hypothesisStateCounts/);
  assert.match(shapeCore, /stateSupportedCandidates\.length >= 10/);
  assert.match(feedbackCore, /query_image_included: false/);
  assert.match(feedbackCore, /original_filename_included: false/);
  assert.match(feedbackCore, /external_upload_performed: false/);
  assert.match(feedbackCore, /normalized_shape_shared:/);
  assert.match(feedbackCore, /schema_version: 3/);
  assert.match(feedbackCore, /anonymous: true/);
  assert.match(feedbackCore, /image_score: roundScore\(result\.imageScore/);
  assert.match(feedbackCore, /peak_count_score: roundScore\(result\.countScore/);
  assert.match(feedbackCore, /area_score: roundScore\(result\.areaScore/);
  assert.match(source, /new Blob\(\[JSON\.stringify\(payload/);
  assert.match(source, /data-testid="feedback-export"/);
  assert.match(source, /vth-anonymous-annotator-id/);
  assert.match(source, /feedback-query-code/);
  assert.match(source, /feedback-annotator-code/);
  assert.match(source, /MAX_FILE_SIZE = 12 \* 1024 \* 1024/);
  assert.match(source, /image\/png.*image\/jpeg.*image\/webp/s);
});

test("publishes the complete 30-panel similarity API contract", async () => {
  const openapi = JSON.parse(
    await readFile(
      new URL(
        "../public/similarity-search-openapi.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const healthMultiChart =
    openapi.components.schemas.HealthResponse.properties.multiChart
      .properties;
  const searchProperties =
    openapi.components.schemas.SearchResponse.properties;
  assert.equal(healthMultiChart.maxPanels.const, 30);
  assert.equal(searchProperties.panelCount.maximum, 30);
  assert.equal(searchProperties.panels.maxItems, 30);
  assert.equal(
    searchProperties.panelDetection.properties.maxPanels.const,
    30,
  );
});

test("hosting metadata is ready for Sites ownership", async () => {
  const hosting = JSON.parse(
    await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  );
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, "VTH_SHARED_IMAGES");
  assert.match(hosting.project_id, /^appgprj_[a-f0-9]+$/);
  await access(new URL("vite.config.ts", projectRoot));
  const openapi = JSON.parse(
    await readFile(
      new URL("../public/shared-training-openapi.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(openapi.info.version, "4.0.0");
  assert.ok(openapi.paths["/api/v1/shared-relevance-reports"]);
  assert.ok(openapi.paths["/api/v1/shared-relevance-export"]);
  assert.ok(
    openapi.paths["/api/v1/shared-training-samples"].get.parameters.some(
      (parameter) => parameter.name === "cursor",
    ),
  );
  assert.ok(
    openapi.paths["/api/v1/shared-training-samples/{id}/source-image"],
  );
  assert.ok(
    openapi.paths["/api/v1/shared-training-samples"].post.responses["422"],
  );
  assert.ok(
    openapi.paths["/api/v1/shared-training-samples"].post.responses["413"],
  );
  assert.ok(
    openapi.paths["/api/v1/shared-training-samples"].post.responses["503"],
  );
  assert.match(
    openapi.paths["/api/v1/shared-training-samples"].post.description,
    /source-derived profile.*canonical descriptor.*State/s,
  );
  assert.match(
    openapi.paths["/api/v1/shared-training-samples"].post.description,
    /differ from the input/,
  );
  assert.equal(
    openapi.components.schemas.SharedTrainingInput.properties
      .consentVersion.const,
    "2026-07-28-v2",
  );
});
