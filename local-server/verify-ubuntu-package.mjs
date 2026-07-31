import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
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

async function verifyPlainHttpBrowserClient(packageDirectory) {
  const clientDirectory = path.join(packageDirectory, "site", "client");
  const viteManifest = JSON.parse(
    await readFile(
      path.join(clientDirectory, ".vite", "manifest.json"),
      "utf8",
    ),
  );
  const browserEntry = viteManifest["app/VthSearchApp.tsx"]?.file;
  assert(
    typeof browserEntry === "string" && browserEntry.startsWith("assets/"),
    "Ubuntu package does not expose the VTH browser entry.",
  );
  const browserSource = await readFile(
    path.join(clientDirectory, browserEntry),
    "utf8",
  );
  assert(
    browserSource.includes("/api/v1/runtime") &&
      browserSource.includes("getRandomValues") &&
      !browserSource.includes(".randomUUID("),
    "Ubuntu browser client is not compatible with plain-HTTP LAN origins.",
  );
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

async function verifyLinuxExecutable(
  nodePath,
  {
    expectedSha256,
    expectedElfMachine,
    architecture,
  },
) {
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
      header.readUInt16LE(18) === expectedElfMachine,
      `Embedded Node executable is not Linux ${architecture}.`,
    );
  } finally {
    await file.close();
  }
  assert(
    (await sha256(nodePath)) === expectedSha256,
    `Embedded Linux ${architecture} Node checksum does not match the package manifest.`,
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

    const similarityCapabilityResponse = await fetch(
      `${baseUrl}/api/v1/similarity-search`,
      { headers },
    );
    const similarityCapability = await similarityCapabilityResponse.json();
    assert(
      similarityCapabilityResponse.status === 200 &&
        similarityCapability.multiChart?.colorSeries
          ?.maxIndependentSeries === 2 &&
        similarityCapability.multiChart?.colorSeries?.overflowPolicy ===
          "most-irregular-only",
      "Ubuntu color-series capability policy is invalid.",
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
    for (const seriesCount of [2, 3]) {
      const colorSeriesResponse = await fetch(
        `${baseUrl}/api/v1/similarity-search?topK=2`,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "image/png",
          },
          body: colorSeriesVerificationPng(seriesCount),
        },
      );
      assert(
        colorSeriesResponse.status === 200,
        `Ubuntu ${seriesCount}-color-series search did not return 200.`,
      );
      verifyColorSeriesSearch(
        await colorSeriesResponse.json(),
        2,
        seriesCount,
      );
    }

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

async function webdriverRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: options.body
      ? { "content-type": "application/json" }
      : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.value?.error) {
    throw new Error(
      payload?.value?.message ||
        `WebDriver ${options.method || "GET"} ${pathname} failed (${response.status}).`,
    );
  }
  return payload.value;
}

async function verifyLanBrowserSmoke({
  externalAddress,
  port,
  apiKey,
  headers,
}) {
  const required = process.env.VTH_REQUIRE_LAN_BROWSER_SMOKE === "1";
  if (!required) {
    return { executed: false, reason: "not-required-on-this-job" };
  }
  if (!externalAddress) {
    assert(!required, "A non-loopback IPv4 address is required for browser smoke.");
    return { executed: false, reason: "no-non-loopback-ipv4" };
  }

  const driverPort = await reserveTcpPort();
  const driverUrl = `http://127.0.0.1:${driverPort}`;
  const configuredChromeDriver =
    process.env.CHROMEWEBDRIVER || "";
  const chromeDriverExecutable = configuredChromeDriver
    ? configuredChromeDriver.endsWith("chromedriver")
      ? configuredChromeDriver
      : path.join(configuredChromeDriver, "chromedriver")
    : "chromedriver";
  const driver = spawn(
    chromeDriverExecutable,
    [`--port=${driverPort}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    },
  );
  const driverStdout = [];
  const driverStderr = [];
  driver.stdout.on("data", (chunk) => driverStdout.push(chunk));
  driver.stderr.on("data", (chunk) => driverStderr.push(chunk));
  let driverError;
  driver.once("error", (error) => {
    driverError = error;
  });
  let sessionId = "";

  try {
    let driverReady = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (driverError) break;
      if (driver.exitCode !== null) break;
      try {
        const status = await webdriverRequest(driverUrl, "/status");
        if (status?.ready) {
          driverReady = true;
          break;
        }
      } catch {
        // ChromeDriver may still be starting.
      }
      await delay(100);
    }
    if (!driverReady) {
      const reason =
        driverError?.code === "ENOENT"
          ? "chromedriver-not-installed"
          : `chromedriver-unavailable: ${Buffer.concat(driverStderr).toString("utf8")}`;
      assert(!required, reason);
      return { executed: false, reason };
    }

    let session;
    try {
      session = await webdriverRequest(driverUrl, "/session", {
        method: "POST",
        body: {
          capabilities: {
            alwaysMatch: {
              browserName: "chrome",
              pageLoadStrategy: "eager",
              timeouts: {
                pageLoad: 60_000,
                script: 30_000,
              },
              "goog:chromeOptions": {
                args: [
                  "--headless=new",
                  "--no-sandbox",
                  "--disable-dev-shm-usage",
                  "--disable-background-networking",
                  "--disable-component-update",
                  "--disable-default-apps",
                  "--disable-extensions",
                  "--disable-features=Translate",
                  "--disable-sync",
                  "--metrics-recording-only",
                  "--no-first-run",
                  "--no-proxy-server",
                ],
              },
            },
          },
        },
        timeoutMs: 90_000,
      });
    } catch (error) {
      assert(!required, `Chrome session unavailable: ${error.message}`);
      return {
        executed: false,
        reason: `chrome-session-unavailable: ${error.message}`,
      };
    }
    sessionId = session?.sessionId || "";
    assert(sessionId, "ChromeDriver did not return a session id.");

    const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
    await webdriverRequest(driverUrl, `${sessionPath}/goog/cdp/execute`, {
      method: "POST",
      body: {
        cmd: "Page.addScriptToEvaluateOnNewDocument",
        params: {
          source: `
            window.__vthNativeRandomUuidType = typeof crypto.randomUUID;
            Math.random = () => 0;
            try {
              Object.defineProperty(Crypto.prototype, "randomUUID", {
                configurable: true,
                value: undefined
              });
            } catch {}
          `,
        },
      },
    });
    await webdriverRequest(driverUrl, `${sessionPath}/url`, {
      method: "POST",
      body: {
        url:
          `http://${externalAddress}:${port}/` +
          `?access_token=${encodeURIComponent(apiKey)}`,
      },
      timeoutMs: 90_000,
    });

    const execute = (script) =>
      webdriverRequest(driverUrl, `${sessionPath}/execute/sync`, {
        method: "POST",
        body: { script, args: [] },
      });
    let readyState;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      readyState = await execute(`
        const demo = document.querySelector('[data-testid="demo-button"]');
        return {
          hostname: location.hostname,
          secure: isSecureContext,
          nativeRandomUuid: window.__vthNativeRandomUuidType,
          randomUUID: typeof crypto.randomUUID,
          getRandomValues: typeof crypto.getRandomValues,
          offline: document.body.innerText.includes('OFFLINE · LOCAL ONLY'),
          downloads: Boolean(document.querySelector('[data-testid="ubuntu-download"]')),
          demoReady: Boolean(demo && !demo.disabled),
          alert: document.querySelector('[role="alert"]')?.textContent || ''
        };
      `);
      if (
        readyState?.offline &&
        !readyState.downloads &&
        readyState.demoReady
      ) {
        break;
      }
      await delay(100);
    }
    assert(
      readyState?.hostname === externalAddress &&
        readyState?.secure === false &&
        readyState?.randomUUID === "undefined" &&
        readyState?.getRandomValues === "function" &&
        readyState?.offline === true &&
        readyState?.downloads === false &&
        readyState?.demoReady === true &&
        !readyState?.alert,
      `LAN browser runtime did not become ready: ${JSON.stringify(readyState)}`,
    );

    await execute(
      `document.querySelector('[data-testid="demo-button"]').click(); return true;`,
    );
    let analysisState;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      analysisState = await execute(`
        return {
          cards: document.querySelectorAll('[data-testid="results"] .result-card').length,
          alert: document.querySelector('[role="alert"]')?.textContent || '',
          analyzing: document.body.innerText.includes('형상 분석 중')
        };
      `);
      if (analysisState?.cards >= 5 || analysisState?.alert) break;
      await delay(100);
    }
    assert(
      analysisState?.cards >= 5 && !analysisState?.alert,
      `LAN browser demo analysis failed: ${JSON.stringify(analysisState)}`,
    );

    await execute(`
      const drawer = document.querySelector('details.learning-drawer');
      if (drawer) drawer.open = true;
      const consent = document.querySelector('[data-testid="shared-training-consent"]');
      if (consent && !consent.checked) consent.click();
      return true;
    `);
    let learningReady = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      learningReady = await execute(`
        const button = document.querySelector('[data-testid="learn-current-image"]');
        return Boolean(button && !button.disabled);
      `);
      if (learningReady) break;
      await delay(100);
    }
    assert(learningReady, "LAN browser local-learning action did not become ready.");
    await execute(`
      document.querySelector('[data-testid="learn-current-image"]').click();
      return true;
    `);

    let learnedSamples = [];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const response = await fetch(
        `http://${externalAddress}:${port}/api/v1/training-samples`,
        {
          headers,
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (response.ok) {
        learnedSamples = (await response.json()).samples ?? [];
        if (learnedSamples.length > 0) break;
      }
      await delay(100);
    }
    assert(
      learnedSamples.length > 0 &&
        learnedSamples.every((sample) => sample.id.startsWith("local-")),
      "LAN browser analysis succeeded but local learning did not persist.",
    );

    return {
      executed: true,
      origin: `http://${externalAddress}:${port}`,
      secureContext: false,
      nativeRandomUuidType: readyState?.nativeRandomUuid,
      forcedRandomUuidType: readyState.randomUUID,
      resultCards: analysisState.cards,
      learnedSamples: learnedSamples.length,
    };
  } finally {
    if (sessionId) {
      await webdriverRequest(
        driverUrl,
        `/session/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", timeoutMs: 5_000 },
      ).catch(() => {});
    }
    if (driver.exitCode === null) driver.kill("SIGTERM");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (driver.exitCode !== null) break;
      await delay(100);
    }
    if (driver.exitCode === null) driver.kill("SIGKILL");
  }
}

async function verifyUnsupportedArchitectureRejection(
  packageDirectory,
  temporaryDirectory,
) {
  const fakeBinDirectory = path.join(
    temporaryDirectory,
    "unsupported-architecture-bin",
  );
  const fakeUnamePath = path.join(fakeBinDirectory, "uname");
  await mkdir(fakeBinDirectory, { recursive: true });
  await writeFile(
    fakeUnamePath,
    `#!/usr/bin/env sh
case "\${1:-}" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'riscv64\\n' ;;
  *) exit 2 ;;
esac
`,
    "utf8",
  );
  await chmod(fakeUnamePath, 0o755);

  const child = spawn(path.join(packageDirectory, "start.sh"), [], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      PATH: `${fakeBinDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      VTH_API_KEY: "unsupported-architecture-check",
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const output = `${Buffer.concat(stdout)}\n${Buffer.concat(stderr)}`;
  assert(
    exitCode === 126 &&
      output.includes("Unsupported Ubuntu CPU architecture: riscv64") &&
      output.includes("x86_64") &&
      output.includes("ARM64") &&
      !output.includes("exec format error"),
    "start.sh did not reject an unsupported CPU before executing Node.",
  );
  return {
    architecture: "riscv64",
    exitCode,
    rejectedBeforeExec: true,
  };
}

async function verifyPackagedRuntimeService(packageDirectory) {
  if (
    process.platform !== "linux" ||
    !["x64", "arm64"].includes(process.arch)
  ) {
    return {
      executed: false,
      reason: `host-is-${process.platform}-${process.arch}`,
    };
  }
  const runtimeRelativePath =
    process.arch === "arm64"
      ? "runtime/linux-arm64/node"
      : "runtime/linux-x64/node";

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
    let browserSmoke = {
      executed: false,
      reason: "no-non-loopback-ipv4",
    };
    if (externalAddress) {
      const externalResponse = await fetch(
        `http://${externalAddress}:${port}/api/v1/health`,
        { headers },
      );
      assert(
        externalResponse.ok,
        `Packaged runtime is not reachable through ${externalAddress}.`,
      );
      browserSmoke = await verifyLanBrowserSmoke({
        externalAddress,
        port,
        apiKey,
        headers,
      });
    } else {
      assert(
        process.env.VTH_REQUIRE_LAN_BROWSER_SMOKE !== "1",
        "A non-loopback IPv4 address is required for browser smoke.",
      );
    }
    const output = `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(
      stderr,
    ).toString("utf8")}`;
    assert(
      (output.includes("0.0.0.0") || externalAddress) &&
        output.includes(
          process.arch === "arm64"
            ? "Selected embedded Node.js runtime: linux-arm64"
            : "Selected embedded Node.js runtime: linux-x64",
        ),
      "Packaged runtime did not select the native runtime or expose the LAN binding.",
    );
    return {
      executed: true,
      runtime: runtimeRelativePath,
      listenHost: "0.0.0.0",
      externalAddressVerified: externalAddress || null,
      browserSmoke,
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
    await verifyPlainHttpBrowserClient(packageDirectory);
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
      bundledServerSource.includes("v1.47.0") &&
        !bundledServerSource.includes("v1.43.0"),
      "Ubuntu package contains a stale hosted download release.",
    );
    assert(
      manifest.version === "1.47.0" &&
        manifest.platform === "ubuntu-linux-universal" &&
        JSON.stringify(manifest.architectures) ===
          JSON.stringify(["x64", "arm64"]) &&
        manifest.architecture === undefined &&
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
      manifest.bundled?.plainHttpLanSupported === true &&
        manifest.bundled?.standaloneModeDetection ===
          "same-origin-runtime-api" &&
        manifest.bundled?.randomIdFallback ===
          "webcrypto-get-random-values-rfc4122-v4",
      "Ubuntu plain-HTTP browser compatibility contract is missing.",
    );
    const expectedNodeRuntimes = [
      {
        architecture: "x64",
        unameMachines: ["x86_64", "amd64"],
        elfMachine: 62,
        archiveName: "node-v24.14.0-linux-x64.tar.xz",
        archiveSha256:
          "41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df",
        executable: "runtime/linux-x64/node",
      },
      {
        architecture: "arm64",
        unameMachines: ["aarch64", "arm64"],
        elfMachine: 183,
        archiveName: "node-v24.14.0-linux-arm64.tar.xz",
        archiveSha256:
          "e7adfca03d9173276114a6f2219df1a7d25e1bfd6bbd771d3f839118a2053094",
        executable: "runtime/linux-arm64/node",
      },
    ];
    assert(
      manifest.node?.version === "24.14.0" &&
        manifest.node?.selection === "uname-m" &&
        Array.isArray(manifest.node?.runtimes) &&
        manifest.node.runtimes.length ===
          expectedNodeRuntimes.length &&
        manifest.node?.firstRunExtraction === false,
      "Ubuntu Node runtime declaration is invalid.",
    );
    for (const [index, expectedRuntime] of
      expectedNodeRuntimes.entries()) {
      const runtime = manifest.node.runtimes[index];
      assert(
        runtime?.architecture === expectedRuntime.architecture &&
          JSON.stringify(runtime.unameMachines) ===
            JSON.stringify(expectedRuntime.unameMachines) &&
          runtime.elfMachine === expectedRuntime.elfMachine &&
          runtime.officialArchive?.endsWith(
            expectedRuntime.archiveName,
          ) &&
          runtime.archiveSha256 ===
            expectedRuntime.archiveSha256 &&
          runtime.executable === expectedRuntime.executable &&
          /^[a-f0-9]{64}$/.test(
            runtime.executableSha256 ?? "",
          ),
        `Ubuntu ${expectedRuntime.architecture} Node declaration is invalid.`,
      );
    }
    assert(
      manifest.bundled?.corpus === true &&
        manifest.bundled?.model === true &&
        manifest.bundled?.similaritySearchApi === true &&
        manifest.bundled?.multiChartPanelSplitting === true &&
        manifest.bundled?.multiChartMaximumPanels === 30 &&
        manifest.bundled?.selectiveMultiChartTraining === true &&
        manifest.bundled?.arbitraryPositionWaveformDetection ===
          true &&
        manifest.bundled?.borderSafeDocumentBackground === true &&
        manifest.bundled?.largeDocumentTextRejection === true &&
        manifest.bundled?.repeatedWaveformGridRecovery === true &&
        manifest.bundled?.denseGuideWaveformPreservation === true &&
        manifest.bundled?.colorSeriesSeparation === true &&
        manifest.bundled?.colorSeriesPolicy
          ?.maxIndependentSeries === 2 &&
        manifest.bundled?.colorSeriesPolicy?.overflowPolicy ===
          "most-irregular-only" &&
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

    for (const [index, expectedRuntime] of
      expectedNodeRuntimes.entries()) {
      await verifyLinuxExecutable(
        path.join(packageDirectory, expectedRuntime.executable),
        {
          expectedSha256:
            manifest.node.runtimes[index].executableSha256,
          expectedElfMachine: expectedRuntime.elfMachine,
          architecture: expectedRuntime.architecture,
        },
      );
    }
    await assertMissing(
      path.join(packageDirectory, "runtime", "node"),
      "Universal package must not retain the legacy x64-only runtime/node.",
    );
    await stat(path.join(packageDirectory, "runtime", "LICENSE"));
    const startPath = path.join(packageDirectory, "start.sh");
    await access(startPath, fsConstants.X_OK);
    await run("sh", ["-n", startPath]);
    const startScript = await readFile(startPath, "utf8");
    assert(
      startScript.startsWith("#!/usr/bin/env sh\n") &&
        startScript.includes("VTH_HOST:-0.0.0.0") &&
        startScript.includes('VTH_KERNEL=$(uname -s') &&
        startScript.includes('VTH_MACHINE=$(uname -m') &&
        startScript.includes("x86_64|amd64)") &&
        startScript.includes("VTH_RUNTIME=linux-x64") &&
        startScript.includes("aarch64|arm64)") &&
        startScript.includes("VTH_RUNTIME=linux-arm64") &&
        startScript.includes("Unsupported Ubuntu CPU architecture") &&
        startScript.includes(
          'VTH_NODE="$PACKAGE_DIR/runtime/$VTH_RUNTIME/node"',
        ) &&
        startScript.includes('exec "$VTH_NODE"') &&
        startScript.includes("--host \"$VTH_LISTEN_HOST\"") &&
        startScript.includes("--public-url \"$VTH_PUBLIC_URL\"") &&
        !startScript.includes('"$PACKAGE_DIR/runtime/node"') &&
        !startScript.includes("command -v node") &&
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
      readme.includes("x64 + ARM64 Universal") &&
        readme.includes("uname -m") &&
        readme.includes("ubuntu-universal-v1.47.0") &&
        readme.includes('"exec format error"') &&
        readme.includes("crypto.randomUUID") &&
        readme.includes("일반 HTTP") &&
        readme.includes("서버판을 자동 인식") &&
        readme.includes('"LAN 접속:"') &&
        readme.includes("access_token 포함 URL") &&
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
        readme.includes("색상 시리즈") &&
        readme.includes("최대 2개") &&
        readme.includes("3개 이상의 색상 분포") &&
        readme.includes("가장 비정규적인 산포 하나만") &&
        readme.includes("큰 글자 제목과 문서 본문") &&
        readme.includes("가이드 교차 연속성") &&
        readme.includes("학습 포함") &&
        readme.includes("전체 선택/해제") &&
        readme.includes("선택하지 않은") &&
        readme.includes("학습 저장소로 보내지 않습니다"),
      "Ubuntu LAN and standalone instructions are incomplete.",
    );
    await assertMissing(
      path.join(packageDirectory, "site", "client", "downloads"),
      "Ubuntu package must not recursively contain hosted downloads.",
    );
    const checkedFiles = await verifyChecksums(packageDirectory);
    const unsupportedArchitecture =
      await verifyUnsupportedArchitectureRejection(
        packageDirectory,
        temporaryDirectory,
      );
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
          unsupportedArchitecture,
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
