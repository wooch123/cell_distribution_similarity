import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  colorSeriesVerificationPng,
  verifyColorSeriesSearch,
} from "./color-series-verification.mjs";
import { nonDistributionPng } from "./non-distribution-fixture.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    if (options.capture) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}` +
              (options.capture
                ? `: ${Buffer.concat(stderr).toString("utf8")}`
                : ""),
          ),
        );
      }
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.once("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("end", () => resolve(hash.digest("hex")));
  });
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

async function verifyLinuxX64Executable(nodePath, expectedSha256) {
  await access(nodePath, fsConstants.X_OK);
  const file = await open(nodePath, "r");
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    assert(bytesRead === header.length, "Embedded Node executable is truncated.");
    assert(
      header[0] === 0x7f &&
        header[1] === 0x45 &&
        header[2] === 0x4c &&
        header[3] === 0x46,
      "Embedded Node executable is not ELF.",
    );
    assert(header[4] === 2, "Embedded Node executable is not 64-bit.");
    assert(header[5] === 1, "Embedded Node executable is not little-endian.");
    assert(
      header.readUInt16LE(18) === 62,
      "Embedded Node executable is not Linux x86_64.",
    );
  } finally {
    await file.close();
  }
  assert(
    (await sha256(nodePath)) === expectedSha256,
    "Embedded Node executable checksum does not match the package manifest.",
  );
}

async function verifyService(packageDirectory, validationDirectory) {
  const apiKey = "ubuntu-host-verification-key";
  const headers = { "x-api-key": apiKey };
  const serverUrl = pathToFileURL(
    path.join(packageDirectory, "server", "server.mjs"),
  );
  serverUrl.searchParams.set("ubuntu-verify", `${process.pid}-${Date.now()}`);
  const { createVthServer } = await import(serverUrl.href);
  const { server, access: accessPolicy } = await createVthServer({
    rootDirectory: packageDirectory,
    dataDirectory: validationDirectory,
    host: "0.0.0.0",
    apiKey,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  assert(
    typeof address === "object" && address,
    "Ubuntu service did not bind.",
  );
  assert(
    address.address === "0.0.0.0",
    `Ubuntu service did not listen on every IPv4 interface: ${address.address}`,
  );
  assert(
    accessPolicy.accessMode === "offline-network-accessible" &&
      accessPolicy.apiKeyRequired === true &&
      accessPolicy.apiKeyGenerated === false,
    "Ubuntu service does not apply the network-access protection policy.",
  );
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const homeResponse = await fetch(`${baseUrl}/`, { headers });
    assert(homeResponse.status === 200, "Home page did not return 200.");
    assert(
      (await homeResponse.text()).includes("유사 산포 검색"),
      "Home title is missing.",
    );
    assert(
      homeResponse.headers
        .get("content-security-policy")
        ?.includes("connect-src 'self'"),
      "Standalone CSP does not constrain browser connections to self.",
    );
    assert(
      homeResponse.headers.get("x-vth-network-mode") ===
        "offline-network-accessible" &&
        homeResponse.headers.get("x-vth-access-mode") ===
          "network-accessible",
      "Ubuntu response does not declare network-accessible offline mode.",
    );

    const runtime = await fetch(`${baseUrl}/api/v1/runtime`, {
      headers,
    }).then(
      (response) => response.json(),
    );
    assert(
      runtime.externalNetworkAllowed === false &&
        runtime.corpusBundled === true &&
        runtime.modelBundled === true &&
        runtime.sharedApiEnabled === false,
      "Ubuntu runtime policy is invalid.",
    );

    const health = await fetch(`${baseUrl}/api/v1/health`, {
      headers,
    }).then(
      (response) => response.json(),
    );
    assert(
      health.service === "vth-training-api" && health.writable === true,
      "Ubuntu health API is invalid.",
    );

    const corpus = JSON.parse(
      await readFile(
        path.join(
          packageDirectory,
          "site",
          "client",
          "corpus-index.json",
        ),
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

    const candidate = corpus.candidates[0];
    const imageBytes = await readFile(
      path.join(
        packageDirectory,
        "site",
        "client",
        candidate.image.replace(/^\/+/, ""),
      ),
    );
    const searchResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=3`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "image/png",
        },
        body: imageBytes,
      },
    );
    assert(
      searchResponse.status === 200,
      "Ubuntu similarity-search API did not return 200.",
    );
    const search = await searchResponse.json();
    assert(
      search.results?.length === 3 &&
        search.results.every(
          (result, index) =>
            result.rank === index + 1 &&
            result.score >= 0 &&
            result.score <= 1 &&
            result.imageUrl.startsWith(baseUrl),
        ),
      "Ubuntu similarity results are incomplete.",
    );
    assert(
      search.inputHandling?.stored === false &&
        search.inputHandling?.usedForTraining === false,
      "Similarity query must remain transient.",
    );
    const nonDistributionResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=1`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "image/png",
        },
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
      "Ubuntu API did not reject table and diagram-only content.",
    );
    const colorSeriesResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=2`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "image/png",
        },
        body: colorSeriesVerificationPng(),
      },
    );
    assert(
      colorSeriesResponse.status === 200,
      "Ubuntu color-series search did not return 200.",
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
        headers: {
          ...headers,
          "content-type": "image/png",
        },
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
      "Ubuntu search did not isolate the 4x5 VTH waveform grid.",
    );

    const framelessBytes = await readFile(
      path.join(
        packageDirectory,
        "site",
        "client",
        "samples",
        "vnand-random-multichart-frameless-04.png",
      ),
    );
    const framelessResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=1`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "image/png",
        },
        body: framelessBytes,
      },
    );
    const frameless = await framelessResponse.json();
    assert(
      framelessResponse.status === 200 &&
        frameless.panelCount === 8 &&
        frameless.panelDetection?.detectedPanelCount === 8 &&
        frameless.panels?.every((panel) => panel.results?.length === 1),
      "Ubuntu package did not preserve frameless multi-chart analysis.",
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
      "Ubuntu package FHD dense sample metadata is incomplete.",
    );
    const denseFhdBytes = await readFile(
      path.join(
        packageDirectory,
        "site",
        "client",
        "samples",
        "vnand-fhd-dense-30-chart-sample.png",
      ),
    );
    const denseFhdResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=1`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "image/png",
        },
        body: denseFhdBytes,
      },
    );
    const denseFhd = await denseFhdResponse.json();
    assert(
      denseFhdResponse.status === 200 &&
        denseFhd.panelCount === 30 &&
        denseFhd.panelLayout?.rows === 5 &&
        denseFhd.panelLayout?.columns === 6 &&
        denseFhd.panelDetection?.detectedPanelCount === 30 &&
        denseFhd.panelDetection?.analyzedPanelCount === 30 &&
        denseFhd.panelDetection?.maxPanels === 30 &&
        denseFhd.panelDetection?.truncated === false &&
        denseFhd.panelDetection?.rejectedNonChartCount >= 1 &&
        denseFhd.panels?.every(
          (panel, index) =>
            panel.panelIndex === index &&
            panel.results?.length === 1,
        ),
      "Ubuntu package did not preserve FHD dense 30-chart analysis.",
    );

    return {
      listenAddress: address.address,
      port: address.port,
      corpusCandidates: corpus.candidateCount,
      framelessPanels: frameless.panelCount,
      denseFhdPanels: denseFhd.panelCount,
    };
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reserveTcpPort() {
  const server = createHttpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(typeof address === "object" && address, "Could not reserve a port.");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function firstExternalIpv4Address() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (
        address.family === "IPv4" &&
        !address.internal &&
        address.address !== "0.0.0.0"
      ) {
        return address.address;
      }
    }
  }
  return "";
}

async function verifyPackagedRuntimeService(packageDirectory) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    return {
      executed: false,
      reason: `host-is-${process.platform}-${process.arch}`,
    };
  }

  const port = await reserveTcpPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiKey = "ubuntu-package-verification-key";
  const child = spawn(path.join(packageDirectory, "start.sh"), [], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      VTH_HOST: "0.0.0.0",
      VTH_PORT: String(port),
      VTH_PUBLIC_URL: baseUrl,
      VTH_API_KEY: apiKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let childError;
  child.once("error", (error) => {
    childError = error;
  });
  const headers = { "x-api-key": apiKey };

  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (childError) throw childError;
      if (child.exitCode !== null) {
        throw new Error(
          `Packaged runtime exited before verification (${child.exitCode}): ` +
            Buffer.concat(stderr).toString("utf8"),
        );
      }
      try {
        const response = await fetch(`${baseUrl}/api/v1/health`, {
          headers,
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // The embedded runtime may still be loading the bundled worker.
      }
      await delay(100);
    }
    assert(ready, "Packaged Linux runtime did not become ready.");

    const runtime = await fetch(`${baseUrl}/api/v1/runtime`, {
      headers,
    }).then((response) => response.json());
    assert(
      runtime.corpusBundled === true &&
        runtime.modelBundled === true &&
        runtime.sharedApiEnabled === false,
      "Packaged Linux runtime policy is invalid.",
    );

    const corpus = JSON.parse(
      await readFile(
        path.join(
          packageDirectory,
          "site",
          "client",
          "corpus-index.json",
        ),
        "utf8",
      ),
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
    const searchResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search?topK=1`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "image/png",
        },
        body: imageBytes,
      },
    );
    const search = await searchResponse.json();
    assert(
      searchResponse.status === 200 &&
        search.results?.length === 1 &&
        search.results[0].rank === 1,
      "Packaged Linux runtime similarity API failed.",
    );

    const externalAddress = firstExternalIpv4Address();
    if (externalAddress) {
      const externalResponse = await fetch(
        `http://${externalAddress}:${port}/api/v1/health`,
        { headers },
      );
      assert(
        externalResponse.ok,
        `Packaged runtime is not reachable through ${externalAddress}.`,
      );
    }
    const output = `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(
      stderr,
    ).toString("utf8")}`;
    assert(
      output.includes("0.0.0.0") || externalAddress,
      "Packaged runtime did not expose evidence of the 0.0.0.0 binding.",
    );
    return {
      executed: true,
      runtime: "runtime/node",
      listenHost: "0.0.0.0",
      externalAddressVerified: externalAddress || null,
      similarityResults: search.results.length,
    };
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (child.exitCode !== null) break;
      await delay(100);
    }
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function main() {
  const archivePath = path.resolve(process.argv[2] || "");
  await stat(archivePath);
  const expectedArchiveSha256 = await sha256(archivePath);
  assert(
    (await readFile(`${archivePath}.sha256`, "utf8")) ===
      `${expectedArchiveSha256} *${path.basename(archivePath)}\n`,
    "Ubuntu release checksum sidecar is missing or invalid.",
  );
  assert(
    archivePath.endsWith(".tar.gz"),
    "Ubuntu package must use the .tar.gz format.",
  );
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "vth-ubuntu-package-"),
  );
  try {
    const listing = await run("tar", ["-tzf", archivePath], {
      capture: true,
    });
    const entries = listing.stdout.trim().split("\n").filter(Boolean);
    assert(entries.length > 0, "Ubuntu archive is empty.");
    assert(
      entries.every(
        (entry) =>
          !entry.startsWith("/") &&
          !entry.split("/").includes("..") &&
          !entry.startsWith("./"),
      ),
      "Ubuntu archive contains an unsafe path.",
    );
    const roots = new Set(entries.map((entry) => entry.split("/")[0]));
    assert(roots.size === 1, "Ubuntu archive must contain one package root.");

    await run("tar", ["-xzf", archivePath, "-C", temporaryDirectory]);
    const packageEntries = await readdir(temporaryDirectory, {
      withFileTypes: true,
    });
    const packageEntry = packageEntries.find((entry) => entry.isDirectory());
    assert(packageEntry, "Archive does not contain a package directory.");
    const packageDirectory = path.join(
      temporaryDirectory,
      packageEntry.name,
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
      bundledServerSource.includes("v1.38.0") &&
        !bundledServerSource.includes("v1.37.0"),
      "Ubuntu package contains a stale hosted download release.",
    );
    assert(
      manifest.version === "1.38.0" &&
        manifest.platform === "ubuntu-linux-x64" &&
        manifest.architecture === "x86_64" &&
        manifest.entrypoint === "start.sh" &&
        manifest.archiveFormat === "tar.gz",
      "Ubuntu package identity is invalid.",
    );
    assert(
        manifest.service?.listenHost === "0.0.0.0" &&
        manifest.service?.port === 4173 &&
        manifest.service?.publicUrlEnvironmentVariable ===
          "VTH_PUBLIC_URL" &&
        manifest.network?.mode === "offline-lan-server" &&
        manifest.network?.inboundLanAccess === true &&
        manifest.network?.outboundExternalNetworkAllowed === false &&
        manifest.network?.sharedApiEnabled === false &&
        manifest.network?.automaticAccessToken === true &&
        manifest.network?.accessTokenTransport ===
          "query-once-then-http-only-cookie",
      "Ubuntu LAN/offline network policy is invalid.",
    );
    assert(
      manifest.node?.version === "24.14.0" &&
        manifest.node?.officialArchive?.endsWith(
          "node-v24.14.0-linux-x64.tar.xz",
        ) &&
        manifest.node?.archiveSha256 ===
          "41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df" &&
        manifest.node?.executable === "runtime/node" &&
        manifest.node?.firstRunExtraction === false,
      "Ubuntu Node runtime declaration is invalid.",
    );
    assert(
      manifest.bundled?.corpus === true &&
        manifest.bundled?.model === true &&
        manifest.bundled?.similaritySearchApi === true &&
        manifest.bundled?.multiChartPanelSplitting === true &&
        manifest.bundled?.multiChartMaximumPanels === 30 &&
        manifest.bundled?.arbitraryPositionWaveformDetection ===
          true &&
        manifest.bundled?.borderSafeDocumentBackground === true &&
        manifest.bundled?.repeatedWaveformGridRecovery === true &&
        manifest.bundled?.colorSeriesSeparation === true &&
        manifest.bundled?.similarityRanking ===
          "per-panel-per-series" &&
        manifest.bundled?.samples?.length === 8 &&
        manifest.bundled.samples.some(
          (sample) =>
            sample.path ===
            "site/client/samples/vnand-fhd-dense-30-chart-sample.png",
        ) &&
        manifest.bundled.samples.some(
          (sample) =>
            sample.path ===
            "site/client/samples/vnand-fhd-dense-30-chart-sample.json",
        ) &&
        manifest.bundled?.environmentExample === "vth.env.example" &&
        manifest.bundled?.optionalSystemdInstaller ===
          "install-systemd.sh",
      "Ubuntu package contents are incomplete.",
    );

    const nodePath = path.join(packageDirectory, "runtime", "node");
    await verifyLinuxX64Executable(
      nodePath,
      manifest.node.executableSha256,
    );
    await stat(path.join(packageDirectory, "runtime", "LICENSE"));
    const startPath = path.join(packageDirectory, "start.sh");
    await access(startPath, fsConstants.X_OK);
    await run("sh", ["-n", startPath]);
    const startScript = await readFile(startPath, "utf8");
    assert(
      startScript.startsWith("#!/usr/bin/env sh\n") &&
        startScript.includes("VTH_HOST:-0.0.0.0") &&
        startScript.includes('"$PACKAGE_DIR/runtime/node"') &&
        startScript.includes("--host \"$VTH_LISTEN_HOST\"") &&
        startScript.includes("--public-url \"$VTH_PUBLIC_URL\"") &&
        !startScript.includes("npm install") &&
        !startScript.includes("curl ") &&
        !startScript.includes("wget "),
      "start.sh does not use the bundled runtime or LAN binding.",
    );
    assert(
      !startScript.includes("\r"),
      "start.sh contains Windows line endings.",
    );
    assert(
      startScript.includes('. "$PACKAGE_DIR/vth.env"'),
      "start.sh does not load the optional vth.env file.",
    );

    const environmentExample = await readFile(
      path.join(packageDirectory, "vth.env.example"),
      "utf8",
    );
    assert(
      environmentExample.includes("VTH_HOST=0.0.0.0") &&
        environmentExample.includes("VTH_PORT=4173") &&
        environmentExample.includes("# VTH_PUBLIC_URL=") &&
        environmentExample.includes("# VTH_API_KEY="),
      "vth.env.example is incomplete.",
    );
    const installerPath = path.join(
      packageDirectory,
      "install-systemd.sh",
    );
    await access(installerPath, fsConstants.X_OK);
    await run("sh", ["-n", installerPath]);
    const systemdInstaller = await readFile(installerPath, "utf8");
    for (const evidence of [
      "SUDO_USER",
      "/etc/systemd/system/",
      "EnvironmentFile=",
      "Restart=on-failure",
      "ReadWritePaths=",
      'chown -R "$RUN_USER:$RUN_GROUP" "$PACKAGE_DIR/data"',
      "systemctl enable --now",
    ]) {
      assert(
        systemdInstaller.includes(evidence),
        `systemd installer is missing: ${evidence}`,
      );
    }

    const readme = await readFile(
      path.join(packageDirectory, "README-UBUNTU.txt"),
      "utf8",
    );
    assert(
      readme.includes("0.0.0.0:4173") &&
        readme.includes("다른 PC") &&
        readme.includes("VTH_API_KEY") &&
        readme.includes("HttpOnly 쿠키") &&
        readme.includes("VTH_PUBLIC_URL") &&
        readme.includes("리버스 프록시") &&
        readme.includes("sudo ufw allow") &&
        readme.includes('-H "x-api-key: $VTH_API_KEY"') &&
        readme.includes("sudo ./install-systemd.sh") &&
        readme.includes("data/만 쓰기 가능") &&
        readme.includes("Node.js나 npm 설치는 필요하지 않습니다") &&
        readme.includes("tar.gz는 start.sh의 실행 권한") &&
        readme.includes("최대") &&
        readme.includes("30개 차트") &&
        readme.includes("FHD 밀집 샘플") &&
        readme.includes("색상 시리즈"),
      "Ubuntu LAN and standalone instructions are incomplete.",
    );
    await assertMissing(
      path.join(packageDirectory, "site", "client", "downloads"),
      "Ubuntu package must not recursively contain hosted downloads.",
    );
    const checkedFiles = await verifyChecksums(packageDirectory);
    const service = await verifyService(
      packageDirectory,
      path.join(temporaryDirectory, "validation-data"),
    );
    const packagedRuntimeService =
      await verifyPackagedRuntimeService(packageDirectory);
    console.log(
      JSON.stringify(
        {
          archivePath,
          archiveSha256: expectedArchiveSha256,
          checkedFiles,
          service,
          packagedRuntimeService,
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
