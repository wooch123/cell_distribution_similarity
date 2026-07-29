import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  colorSeriesVerificationPng,
  verifyColorSeriesSearch,
} from "./color-series-verification.mjs";
import { nonDistributionPng } from "./non-distribution-fixture.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertMissing(filePath, message) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function verifyChecksums(packageDirectory) {
  const checksumText = await readFile(
    path.join(packageDirectory, "checksums-sha256.txt"),
    "utf8",
  );
  let checked = 0;
  for (const line of checksumText.trim().split("\n")) {
    const match = /^([a-f0-9]{64}) \*(.+)$/.exec(line);
    assert(match, `Invalid checksum line: ${line}`);
    const filePath = path.resolve(packageDirectory, match[2]);
    assert(
      filePath.startsWith(`${packageDirectory}${path.sep}`),
      `Checksum path escapes package: ${match[2]}`,
    );
    assert(
      (await sha256(filePath)) === match[1],
      `Checksum mismatch: ${match[2]}`,
    );
    checked += 1;
  }
  return checked;
}

async function verifyService(packageDirectory, validationDirectory) {
  const serverUrl = pathToFileURL(
    path.join(packageDirectory, "server", "server.mjs"),
  );
  serverUrl.searchParams.set("verify", `${process.pid}-${Date.now()}`);
  const { createVthServer } = await import(serverUrl.href);
  const { server } = await createVthServer({
    rootDirectory: packageDirectory,
    dataDirectory: validationDirectory,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(typeof address === "object" && address, "Server did not bind.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const homeResponse = await fetch(`${baseUrl}/`);
    const home = await homeResponse.text();
    assert(homeResponse.status === 200, "Home page did not return 200.");
    assert(home.includes("유사 산포 검색"), "Home title is missing.");
    assert(home.includes("랜덤 데모 그래프"), "Random demo UI is missing.");
    assert(
      homeResponse.headers.get("x-vth-network-mode") ===
        "offline-loopback-only",
      "Standalone network-mode header is missing.",
    );
    assert(
      homeResponse.headers
        .get("content-security-policy")
        ?.includes("connect-src 'self'"),
      "Standalone CSP does not limit browser connections to self.",
    );
    const clientAssetsDirectory = path.join(
      packageDirectory,
      "site",
      "client",
      "assets",
    );
    const clientScripts = await Promise.all(
      (await readdir(clientAssetsDirectory))
        .filter((entry) => entry.endsWith(".js"))
        .map((entry) =>
          readFile(path.join(clientAssetsDirectory, entry), "utf8"),
        ),
    );
    assert(
      clientScripts.some((script) => script.includes("현재 그림 학습")) &&
        clientScripts.some((script) => script.includes("폴더 전체 학습")),
      "Local-only learning UI is missing.",
    );
    for (const evidenceLabel of [
      "랜덤 멀티 차트 분석",
      "선택 원본 패널",
      "정규화 추출 Curve",
      "검출 State",
      "관측 State",
      "Curve 검증",
    ]) {
      assert(
        clientScripts.some((script) => script.includes(evidenceLabel)),
        `Intra-panel analysis evidence UI is missing: ${evidenceLabel}`,
      );
    }
    assert(
      clientScripts.every(
        (script) => !script.includes("https://dove9999.com"),
      ),
      "Standalone client contains a direct dove9999.com endpoint.",
    );

    const runtimeResponse = await fetch(`${baseUrl}/api/v1/runtime`);
    const runtime = await runtimeResponse.json();
    assert(
      runtime.mode === "standalone-offline" &&
        runtime.externalNetworkAllowed === false &&
        runtime.corpusBundled === true &&
        runtime.modelBundled === true &&
        runtime.sharedApiEnabled === false,
      "Standalone runtime policy is invalid.",
    );

    const healthResponse = await fetch(`${baseUrl}/api/v1/health`);
    const health = await healthResponse.json();
    assert(health.service === "vth-training-api", "Health API is invalid.");

    const corpus = JSON.parse(
      await readFile(
        path.join(packageDirectory, "site", "client", "corpus-index.json"),
        "utf8",
      ),
    );
    assert(corpus.candidateCount === 196, "Packaged corpus is incomplete.");
    assert(
      corpus.faultDistributionImport?.imported === 100,
      "The 100 fault distributions are missing.",
    );
    assert(
      corpus.dualEncoder?.validation?.fullyPromoted === true,
      "Promoted dual Curve encoder is missing.",
    );
    assert(
      corpus.dualEncoder?.version === 2 &&
        corpus.dualEncoder?.kind === "vth-dual-curve-mlp" &&
        corpus.dualEncoder?.embeddingDimensions === 4 &&
        corpus.dualEncoder?.hiddenDimensions === 8 &&
        corpus.dualEncoder?.blendWeight === 0.08 &&
        corpus.dualEncoder?.rerankLimit === 2,
      "Packaged dual Curve encoder configuration is invalid.",
    );
    assert(
      corpus.imageEncoder?.version === 1 &&
        corpus.imageEncoder?.kind === "canonical-curve-raster-hog" &&
        corpus.imageEncoder?.dimensions === 3200,
      "Packaged canonical image encoder configuration is invalid.",
    );
    const candidate = corpus.candidates[0];
    const imageBytes = await readFile(
      path.join(
        packageDirectory,
        "site",
        "client",
        candidate.image.replace(/^\/+/, ""),
      ),
    );
    const packagedEngine = await import(
      `${pathToFileURL(
        path.join(
          packageDirectory,
          "server",
          "similarity-engine.mjs",
        ),
      ).href}?package-verification=${Date.now()}`
    );
    const authoritativeAnalysis =
      await packagedEngine.analyzeSimilarityImage(
        imageBytes,
        "image/png",
      );

    const similarityResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=3`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: imageBytes,
      },
    );
    assert(
      similarityResponse.status === 200,
      "Packaged similarity-search API did not return 200.",
    );
    const similarity = await similarityResponse.json();
    assert(
      similarity.inputHandling?.stored === false &&
        similarity.inputHandling?.usedForTraining === false,
      "Similarity query input-handling policy is invalid.",
    );
    assert(
      similarity.results?.length === 3 &&
        similarity.results.every(
          (result, index) =>
            result.rank === index + 1 &&
            result.score >= 0 &&
            result.score <= 1 &&
            result.imageUrl.startsWith(baseUrl),
        ),
      "Packaged similarity ranking or image URLs are invalid.",
    );
    const nonDistributionResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=1`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: nonDistributionPng(),
      },
    );
    const nonDistribution = await nonDistributionResponse.json();
    assert(
      nonDistributionResponse.status === 422 &&
        nonDistribution.error?.code ===
          "distribution_waveform_not_found" &&
        nonDistribution.error?.reasonCode ===
          "table_lattice_dominant" &&
        nonDistribution.error?.details?.diagnosticCode ===
          "VTH-DETECT-TABLE-LATTICE" &&
        nonDistribution.error?.details?.diagnostics
          ?.tableLatticeDominant === true,
      "Packaged API did not reject table and diagram-only content.",
    );
    assert(
      similarity.results[0].score >= similarity.results[1].score &&
        similarity.results[1].score >= similarity.results[2].score,
      "Packaged similarity results are not score-sorted.",
    );
    const colorSeriesResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=2`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: colorSeriesVerificationPng(),
      },
    );
    assert(
      colorSeriesResponse.status === 200,
      "Packaged color-series search did not return 200.",
    );
    verifyColorSeriesSearch(await colorSeriesResponse.json(), 2);

    const repeatedGridSample = await readFile(
      path.join(
        projectRoot,
        "web",
        "tests",
        "fixtures",
        "qlc-read-disturb-20-chart-slide.png",
      ),
    );
    const repeatedGridResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=1`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: repeatedGridSample,
      },
    );
    const repeatedGrid = await repeatedGridResponse.json();
    assert(
      repeatedGridResponse.status === 200 &&
        repeatedGrid.panelCount === 20 &&
        repeatedGrid.panelLayout?.rows === 4 &&
        repeatedGrid.panelLayout?.columns === 5 &&
        repeatedGrid.panels?.every(
          (panel) =>
            panel.bounds?.source?.x +
              panel.bounds?.source?.width <=
              1150 &&
            panel.seriesCount === 1 &&
            panel.query?.stateCount === 8,
        ),
      "Packaged search did not isolate the 4x5 VTH waveform grid.",
    );

    const bundledMultiChartSamplePath = path.join(
      packageDirectory,
      "site",
      "client",
      "samples",
      "vnand-ppt-12-chart-sample.png",
    );
    const bundledMultiChartSample = await readFile(
      bundledMultiChartSamplePath,
    );
    assert(
      bundledMultiChartSample.length > 50_000,
      "Bundled 12-chart PPT sample is missing or incomplete.",
    );
    const multiChartResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=3`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: bundledMultiChartSample,
      },
    );
    assert(
      multiChartResponse.status === 200,
      "Packaged multi-chart search did not return 200.",
    );
    const multiChart = await multiChartResponse.json();
    assert(
      multiChart.panelCount === 12 &&
        multiChart.panelLayout?.rows === 3 &&
        multiChart.panelLayout?.columns === 4 &&
        multiChart.panels?.length === 12,
      "Packaged search did not split the bundled 3x4 PPT sample.",
    );
    assert(
      multiChart.panelDetection?.detectedPanelCount === 12 &&
        multiChart.panelDetection?.analyzedPanelCount === 12 &&
        multiChart.panelDetection?.maxPanels === 30 &&
        multiChart.panelDetection?.truncated === false,
      "Packaged dense-panel metadata is invalid or truncated.",
    );
    const expectedStateCounts = [
      4, 8, 8, 8,
      4, 8, 8, 8,
      4, 8, 8, 8,
    ];
    assert(
      multiChart.panels.every(
        (panel, index) =>
          panel.query?.stateCount === expectedStateCounts[index] &&
          panel.query?.observedStateCount === expectedStateCounts[index] &&
          panel.query?.axisMode === "rectangle" &&
          panel.query?.processedWidth >= 300 &&
          panel.query?.processedHeight >= 155,
      ),
      "A bundled PPT panel was not re-analyzed as the intended 4/8-State source-resolution inner plot.",
    );
    assert(
      multiChart.panels.every(
        (panel, index) =>
          panel.panelIndex === index &&
          panel.results?.length === 3 &&
          panel.results.every(
            (result, resultIndex) =>
              result.rank === resultIndex + 1 &&
              result.score >= 0 &&
              result.score <= 1 &&
              result.imageUrl.startsWith(baseUrl),
          ) &&
          panel.results[0].score >= panel.results[1].score &&
          panel.results[1].score >= panel.results[2].score,
      ),
      "A bundled PPT panel ranking is incomplete or incorrectly ordered.",
    );
    assert(
      multiChart.results?.[0]?.id ===
        multiChart.panels[0].results?.[0]?.id,
      "Legacy top-level results do not mirror panel 0.",
    );

    const denseFhdMetadata = JSON.parse(
      await readFile(
        path.join(
          packageDirectory,
          "site",
          "client",
          "samples",
          "vnand-fhd-dense-30-chart-sample.json",
        ),
        "utf8",
      ),
    );
    assert(
      denseFhdMetadata.expectedChartCount === 30 &&
        denseFhdMetadata.layout?.rows === 5 &&
        denseFhdMetadata.layout?.columns === 6 &&
        denseFhdMetadata.charts?.length === 30 &&
        denseFhdMetadata.charts.every(
          (chart, index) => chart.index === index,
        ),
      "Bundled FHD dense 30-chart metadata is incomplete.",
    );

    for (const sample of [
      {
        fileName: "vnand-random-multichart-mixed-01.png",
        panelCount: 8,
        hasDistractors: true,
        minimumStateCount: 4,
      },
      {
        fileName: "vnand-random-multichart-mixed-02.png",
        panelCount: 8,
        hasDistractors: true,
      },
      {
        fileName: "vnand-random-multichart-lowres-03.png",
        panelCount: 7,
        hasDistractors: true,
        minimumStateCount: 4,
      },
      {
        fileName: "vnand-random-multichart-frameless-04.png",
        panelCount: 8,
        hasDistractors: false,
      },
      {
        fileName: "vnand-fhd-dense-30-chart-sample.png",
        panelCount: 30,
        hasDistractors: true,
      },
    ]) {
      const sampleBytes = await readFile(
        path.join(
          packageDirectory,
          "site",
          "client",
          "samples",
          sample.fileName,
        ),
      );
      const response = await fetch(
        `${baseUrl}/api/v1/similarity-search?topK=1`,
        {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: sampleBytes,
        },
      );
      assert(
        response.status === 200,
        `Packaged random sample search failed: ${sample.fileName}`,
      );
      const result = await response.json();
      assert(
        result.panelCount === sample.panelCount &&
          result.panelDetection?.detectedPanelCount ===
            sample.panelCount &&
          result.panelDetection?.analyzedPanelCount ===
            sample.panelCount &&
          (!sample.hasDistractors ||
            result.panelDetection?.rejectedNonChartCount >= 1) &&
          result.panelDetection?.truncated === false &&
          result.panels?.every(
            (panel) =>
              panel.results?.length === 1 &&
              (!sample.minimumStateCount ||
                panel.query?.stateCount >=
                  sample.minimumStateCount),
          ),
        `Packaged random sample panel verification failed: ${sample.fileName}`,
      );
    }

    const pendingResponse = await fetch(
      `${baseUrl}/api/v1/training-images?id=package-pending`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: imageBytes,
      },
    );
    assert(pendingResponse.status === 202, "Raw image API did not return 202.");

    const readyResponse = await fetch(
      `${baseUrl}/api/v1/training-samples`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 2,
          id: "package-ready",
          label: "Package verification",
          imageDataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
          sourceImageDataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
          profile: authoritativeAnalysis.profile,
          descriptor: {
            ...authoritativeAnalysis.descriptor,
          },
        }),
      },
    );
    const readyPayload = await readyResponse.json();
    assert(
      readyResponse.status === 201,
      `Ready sample API did not return 201: ${
        readyPayload?.error?.message || readyResponse.status
      }`,
    );

    const listResponse = await fetch(`${baseUrl}/api/v1/training-samples`);
    const list = await listResponse.json();
    assert(
      list.samples.some((sample) => sample.id === "package-ready"),
      "Ready sample is not searchable.",
    );
    const readySample = list.samples.find(
      (sample) => sample.id === "package-ready",
    );
    assert(readySample?.sourceImage, "Ready sample source image is missing.");
    assert(
      readySample?.mimeType === "image/svg+xml" &&
        readySample?.metadata?.authoritativeSourceProfile === true,
      "Ready sample did not persist its source-derived standardized Curve.",
    );
    assert(
      readySample.profile.length ===
        authoritativeAnalysis.profile.length &&
        readySample.profile.every(
          (value, index) =>
            Math.abs(
              value - authoritativeAnalysis.profile[index],
            ) < 1e-9,
        ),
      "Ready sample profile is not authoritative to its source image.",
    );
    const standardizedImageResponse = await fetch(
      `${baseUrl}${readySample.image}`,
    );
    assert(
      standardizedImageResponse.status === 200 &&
        standardizedImageResponse.headers
          .get("content-type")
          ?.startsWith("image/svg+xml"),
      "Ready sample standardized SVG is not served.",
    );
    const sourceImageResponse = await fetch(`${baseUrl}${readySample.sourceImage}`);
    assert(
      sourceImageResponse.status === 200,
      "Ready sample source image is not served.",
    );
    assert(
      !list.samples.some((sample) => sample.id === "package-pending"),
      "Pending sample leaked into search-ready candidates.",
    );

    const allResponse = await fetch(
      `${baseUrl}/api/v1/training-samples?includePending=1`,
    );
    const all = await allResponse.json();
    assert(all.samples.length === 2, "Pending/ready persistence is incomplete.");
    return {
      url: baseUrl,
      corpusCandidates: corpus.candidateCount,
      ready: list.samples.length,
      total: all.samples.length,
      bundledSamplePanels: multiChart.panelCount,
      multiChartMaximumPanels: multiChart.panelDetection.maxPanels,
    };
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function main() {
  const zipPath = path.resolve(process.argv[2] || "");
  await stat(zipPath);
  const expectedZipSha256 = await sha256(zipPath);
  assert(
    (await readFile(`${zipPath}.sha256`, "utf8")) ===
      `${expectedZipSha256} *${path.basename(zipPath)}\n`,
    "Windows release checksum sidecar is missing or invalid.",
  );
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "vth-windows-package-"),
  );
  try {
    await run("unzip", ["-q", zipPath, "-d", temporaryDirectory]);
    const packageEntries = await readdir(temporaryDirectory, {
      withFileTypes: true,
    });
    const packageEntry = packageEntries.find((entry) => entry.isDirectory());
    assert(packageEntry, "ZIP does not contain a package directory.");
    const packageDirectory = path.join(
      temporaryDirectory,
      packageEntry.name,
    );
    await Promise.all([
      stat(
        path.join(
          packageDirectory,
          "runtime",
          "node-runtime.tar.xz",
        ),
      ),
      stat(path.join(packageDirectory, "runtime", "LICENSE")),
      stat(path.join(packageDirectory, "start.bat")),
      stat(path.join(packageDirectory, "README-WINDOWS.txt")),
    ]);
    await assertMissing(
      path.join(packageDirectory, "runtime", "node.exe"),
      "Node runtime should stay compressed until first launch.",
    );
    await run("tar", [
      "-tf",
      path.join(
        packageDirectory,
        "runtime",
        "node-runtime.tar.xz",
      ),
    ]);
    await assertMissing(
      path.join(packageDirectory, "site", "client", "downloads"),
      "Standalone package must not recursively contain the hosted ZIP.",
    );
    const startScript = await readFile(
      path.join(packageDirectory, "start.bat"),
      "utf8",
    );
    assert(
      startScript.includes('tar -xf "runtime\\node-runtime.tar.xz"') &&
        startScript.includes('"runtime\\node.exe"'),
      "start.bat does not unpack and use the embedded runtime.",
    );
    const readme = await readFile(
      path.join(packageDirectory, "README-WINDOWS.txt"),
      "utf8",
    );
    assert(
      readme.includes("완전 오프라인 동작") &&
        readme.includes("외부 서버에 연결하지 않으며") &&
        readme.includes("최대 30개") &&
        readme.includes("FHD 밀집 30차트") &&
        readme.includes("12차트 PPT 샘플") &&
        readme.includes("4/8-State 분포") &&
        readme.includes("랜덤 멀티 차트 분석") &&
        readme.includes("선택 원본 패널") &&
        readme.includes("정규화 추출 Curve") &&
        readme.includes("색상 시리즈"),
      "Offline operation is not documented.",
    );
    assert(
      !readme.includes("dove9999.com") && !readme.includes("https://"),
      "Standalone README contains an external service URL.",
    );
    const manifest = JSON.parse(
      await readFile(
        path.join(packageDirectory, "package-manifest.json"),
        "utf8",
      ),
    );
    const bundledServerSource = await readFile(
      path.join(packageDirectory, "site", "server", "index.js"),
      "utf8",
    );
    assert(
      bundledServerSource.includes("v1.37.0") &&
        !bundledServerSource.includes("v1.36.0"),
      "Windows package contains a stale hosted download release.",
    );
    assert(
      manifest.version === "1.37.0" &&
        manifest.platform === "windows-x64" &&
        manifest.network?.mode === "offline-loopback-only" &&
        manifest.network?.externalNetworkAllowed === false &&
        manifest.bundled?.corpus === true &&
        manifest.bundled?.model === true &&
        manifest.bundled?.multiChartPanelSplitting === true &&
        manifest.bundled?.multiChartMaximumPanels === 30 &&
        manifest.bundled?.borderSafeDocumentBackground === true &&
        manifest.bundled?.repeatedWaveformGridRecovery === true &&
        manifest.bundled?.colorSeriesSeparation === true &&
        manifest.bundled?.similarityRanking ===
          "per-panel-per-series" &&
        manifest.bundled?.multiChartSample?.path ===
          "site/client/samples/vnand-ppt-12-chart-sample.png" &&
        manifest.bundled?.multiChartSample?.panelCount === 12 &&
        JSON.stringify(
          manifest.bundled?.multiChartSample?.expectedStateCounts,
        ) ===
          JSON.stringify([
            4, 8, 8, 8,
            4, 8, 8, 8,
            4, 8, 8, 8,
          ]) &&
        manifest.bundled?.multiChartSample?.layout?.rows === 3 &&
        manifest.bundled?.multiChartSample?.layout?.columns === 4 &&
        manifest.bundled?.randomMultiChartSamples?.length === 5 &&
        manifest.bundled.randomMultiChartSamples.some(
          (sample) =>
            sample.path.endsWith(
              "vnand-fhd-dense-30-chart-sample.png",
            ) &&
            sample.metadataPath?.endsWith(
              "vnand-fhd-dense-30-chart-sample.json",
            ) &&
            sample.panelCount === 30 &&
            sample.layout?.rows === 5 &&
            sample.layout?.columns === 6,
        ) &&
        manifest.bundled.randomMultiChartSamples.every(
          (sample) =>
            sample.panelCount >= 7 &&
            (sample.distractors?.length === 0
              ? sample.path.endsWith(
                  "vnand-random-multichart-frameless-04.png",
                )
              : sample.distractors?.includes("table") &&
                sample.distractors?.includes("diagram") &&
                sample.distractors?.includes("photo")),
        ) &&
        manifest.node?.packagedArchive ===
          "runtime/node-runtime.tar.xz",
      "Package manifest does not declare a fully bundled offline runtime.",
    );
    const checkedFiles = await verifyChecksums(packageDirectory);
    const service = await verifyService(
      packageDirectory,
      path.join(temporaryDirectory, "validation-data"),
    );
    console.log(
      JSON.stringify(
        {
          zipPath,
          zipSha256: expectedZipSha256,
          checkedFiles,
          service,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
