import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..");
const version = "1.32.0";
const packageName = `vth-similarity-windows-x64-v${version}`;
const artifactsDirectory = path.join(projectRoot, "artifacts", "windows");
const cacheDirectory = path.join(artifactsDirectory, "cache");
const stagingDirectory = path.join(artifactsDirectory, packageName);
const zipPath = path.join(artifactsDirectory, `${packageName}.zip`);
const publicDownloadsDirectory = path.join(
  projectRoot,
  "web",
  "public",
  "downloads",
);
const publicChunksDirectory = path.join(publicDownloadsDirectory, "chunks");
const publicZipName = "vth-similarity-windows-x64.zip";
const publicMetadataPath = path.join(
  publicDownloadsDirectory,
  "windows-package.json",
);
const publicVersionedMetadataPath = path.join(
  publicDownloadsDirectory,
  `windows-package-v${version}.json`,
);
const publicChecksumPath = path.join(
  publicDownloadsDirectory,
  "vth-similarity-windows-x64.sha256",
);
const publicChunkSize = 4 * 1024 * 1024;
const nodeVersion = "24.14.0";
const nodeArchiveName = `node-v${nodeVersion}-win-x64.zip`;
const nodeArchivePath = path.join(cacheDirectory, nodeArchiveName);
const nodeArchiveUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`;
const nodeArchiveSha256 =
  "313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66";
const pythonExecutable = path.join(projectRoot, ".venv", "bin", "python");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function ensureNodeArchive() {
  await mkdir(cacheDirectory, { recursive: true });
  let shouldDownload = true;
  try {
    shouldDownload = (await sha256(nodeArchivePath)) !== nodeArchiveSha256;
  } catch {
    shouldDownload = true;
  }
  if (shouldDownload) {
    const response = await fetch(nodeArchiveUrl, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(
        `Node.js Windows runtime download failed (${response.status}).`,
      );
    }
    await writeFile(nodeArchivePath, Buffer.from(await response.arrayBuffer()));
  }
  const actualChecksum = await sha256(nodeArchivePath);
  if (actualChecksum !== nodeArchiveSha256) {
    throw new Error(
      `Node.js archive checksum mismatch: ${actualChecksum}`,
    );
  }
}

async function walkFiles(directory, prefix = "") {
  const files = [];
  const currentDirectory = path.join(directory, prefix);
  for (const entry of await readdir(currentDirectory, {
    withFileTypes: true,
  })) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(directory, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function cleanPreviousWindowsDownloads() {
  await mkdir(publicChunksDirectory, { recursive: true });
  const chunkEntries = await readdir(publicChunksDirectory);
  await Promise.all(
    chunkEntries
      .filter((entry) =>
        entry.startsWith("vth-similarity-windows-x64-v"),
      )
      .map((entry) =>
        rm(path.join(publicChunksDirectory, entry), { force: true }),
      ),
  );
  const downloadEntries = await readdir(publicDownloadsDirectory);
  await Promise.all(
    downloadEntries
      .filter(
        (entry) =>
          /^windows-package(?:-v\d+\.\d+\.\d+)?\.json$/.test(entry) ||
          entry === "vth-similarity-windows-x64.sha256",
      )
      .map((entry) =>
        rm(path.join(publicDownloadsDirectory, entry), { force: true }),
      ),
  );
}

async function writeChecksums() {
  const files = (await walkFiles(stagingDirectory))
    .filter((file) => file !== "checksums-sha256.txt")
    .sort((left, right) => left.localeCompare(right, "en"));
  const lines = [];
  for (const relativePath of files) {
    const digest = await sha256(path.join(stagingDirectory, relativePath));
    lines.push(`${digest} *${relativePath.replaceAll(path.sep, "/")}`);
  }
  await writeFile(
    path.join(stagingDirectory, "checksums-sha256.txt"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

async function packageWindows() {
  const webDistDirectory = path.join(projectRoot, "web", "dist");
  await Promise.all([
    access(path.join(webDistDirectory, "client", "corpus-index.json")),
    access(
      path.join(
        webDistDirectory,
        "client",
        "samples",
        "vnand-ppt-12-chart-sample.png",
      ),
    ),
    ...[
      "vnand-random-multichart-mixed-01.png",
      "vnand-random-multichart-mixed-02.png",
      "vnand-random-multichart-lowres-03.png",
      "vnand-random-multichart-frameless-04.png",
      "random-multichart-samples.json",
    ].map((fileName) =>
      access(
        path.join(
          webDistDirectory,
          "client",
          "samples",
          fileName,
        ),
      ),
    ),
    access(path.join(webDistDirectory, "server", "index.js")),
    access(path.join(moduleDirectory, "server.mjs")),
    access(path.join(moduleDirectory, "training-store.mjs")),
    access(path.join(moduleDirectory, "openapi.json")),
    access(
      path.join(
        projectRoot,
        "web",
        "lib",
        "vth-similarity-api-core.mjs",
      ),
    ),
    access(path.join(projectRoot, "web", "node_modules", ".bin", "esbuild")),
  ]);
  await ensureNodeArchive();

  await rm(stagingDirectory, { recursive: true, force: true });
  await rm(zipPath, { force: true });
  await Promise.all([
    mkdir(path.join(stagingDirectory, "runtime"), { recursive: true }),
    mkdir(path.join(stagingDirectory, "server"), { recursive: true }),
    mkdir(path.join(stagingDirectory, "site"), { recursive: true }),
    mkdir(path.join(stagingDirectory, "data", "images"), {
      recursive: true,
    }),
  ]);

  const archiveRoot = `node-v${nodeVersion}-win-x64`;
  await run("unzip", [
    "-q",
    "-j",
    nodeArchivePath,
    `${archiveRoot}/node.exe`,
    `${archiveRoot}/LICENSE`,
    "-d",
    path.join(stagingDirectory, "runtime"),
  ]);
  await Promise.all([
    cp(
      path.join(webDistDirectory, "client"),
      path.join(stagingDirectory, "site", "client"),
      { recursive: true },
    ),
    cp(
      path.join(webDistDirectory, "server"),
      path.join(stagingDirectory, "site", "server"),
      { recursive: true },
    ),
    cp(
      path.join(moduleDirectory, "server.mjs"),
      path.join(stagingDirectory, "server", "server.mjs"),
    ),
    cp(
      path.join(moduleDirectory, "training-store.mjs"),
      path.join(stagingDirectory, "server", "training-store.mjs"),
    ),
    cp(
      path.join(moduleDirectory, "openapi.json"),
      path.join(stagingDirectory, "server", "openapi.json"),
    ),
  ]);
  await run(process.execPath, [
    path.join(projectRoot, "web", "node_modules", "esbuild", "bin", "esbuild"),
    path.join(projectRoot, "web", "lib", "vth-similarity-api-core.mjs"),
    "--bundle",
    "--platform=node",
    "--target=node24",
    "--format=esm",
    `--outfile=${path.join(stagingDirectory, "server", "similarity-engine.mjs")}`,
  ]);
  const runtimeTarPath = path.join(
    stagingDirectory,
    "runtime",
    "node-runtime.tar",
  );
  const compressedRuntimePath = `${runtimeTarPath}.xz`;
  await run("tar", [
    "-cf",
    runtimeTarPath,
    "-C",
    path.join(stagingDirectory, "runtime"),
    "node.exe",
  ]);
  await run(pythonExecutable, [
    "-c",
    [
      "import lzma, pathlib, sys",
      "source = pathlib.Path(sys.argv[1])",
      "target = pathlib.Path(sys.argv[2])",
      "target.write_bytes(lzma.compress(source.read_bytes(), format=lzma.FORMAT_XZ, preset=9))",
    ].join("; "),
    runtimeTarPath,
    compressedRuntimePath,
  ]);
  await Promise.all([
    rm(runtimeTarPath, { force: true }),
    rm(path.join(stagingDirectory, "runtime", "node.exe"), { force: true }),
  ]);
  // A hosted build can already contain the previous downloadable ZIP. Never
  // nest that ZIP inside the standalone package itself.
  await rm(path.join(stagingDirectory, "site", "client", "downloads"), {
    recursive: true,
    force: true,
  });

  const startScript = `@echo off\r
setlocal\r
cd /d "%~dp0"\r
if not exist "runtime\\node.exe" (\r
  if not exist "runtime\\node-runtime.tar.xz" (\r
    echo Embedded Node.js runtime archive is missing.\r
    pause\r
    exit /b 1\r
  )\r
  where tar >nul 2>nul\r
  if errorlevel 1 (\r
    echo Windows tar.exe is required to unpack the embedded runtime.\r
    pause\r
    exit /b 1\r
  )\r
  echo Preparing the embedded offline runtime for first use...\r
  tar -xf "runtime\\node-runtime.tar.xz" -C "runtime"\r
  if errorlevel 1 (\r
    echo Failed to unpack the embedded Node.js runtime.\r
    pause\r
    exit /b 1\r
  )\r
)\r
"runtime\\node.exe" "server\\server.mjs" --root "%~dp0." --open\r
if errorlevel 1 pause\r
`;
  const readme = `유사 산포 검색 - Windows x64 완전 독립 패키지
=================================================

실행
1. ZIP 파일을 원하는 폴더에 완전히 압축 해제합니다.
2. start.bat을 더블 클릭합니다.
3. 브라우저가 http://127.0.0.1:4173 을 엽니다.
4. 종료할 때 검은 명령 창에서 Ctrl+C를 누릅니다.

Node.js 설치나 npm install은 필요하지 않습니다. 이 패키지에는 공식
Node.js v${nodeVersion} Windows x64 런타임이 압축된 상태로 포함되어
있으며 첫 실행 때 Windows 기본 tar.exe로 패키지 내부에 자동 해제됩니다.

완전 오프라인 동작
- 96개 합성 분포와 vnand_fault_distributions_100의 100개 fault 분포,
  Curve 모델, 12차트 PPT 샘플, 웹 화면, Node.js 런타임이 모두 들어 있습니다.
- 인터넷 연결이 없어도 검색, 랜덤 데모, 12차트 PPT 샘플 분석, 업로드 분석,
  학습, 삭제가 동작합니다.
- 프로그램은 외부 서버에 연결하지 않으며 브라우저 통신도 이 PC의
  http://127.0.0.1 주소로 제한됩니다.
- 원본 그림, 파일명, 표준 Curve, 평가 결과는 이 PC 밖으로 전송되지 않습니다.
- Windows 방화벽이 표시되면 공용/사설 네트워크 접근을 허용할 필요가 없습니다.

형상 검색
- 한 그림에 서로 다른 좌표의 차트가 여러 개 있으면 사각 프레임과 열린
  L축을 찾아 행 우선 순서로 분리하고, 각 차트를 독립적으로 분석·검색합니다.
- 한 이미지에서 최대 24개 차트를 분석합니다. 24개를 초과하면 신뢰도가 높은
  24개를 행 우선 순서로 반환하고 API 경고와 truncated 상태를 표시합니다.
- 화면의 "랜덤 멀티 차트 분석"은 임의 좌표의 차트와 표·플로우차트·
  사진성 블록이 섞인 샘플 또는 경계 없는 Curve 전용 샘플 중 직전과
  다른 이미지를 골라 실행합니다.
- "샘플 1", "가변 크기", "저해상도", "경계 없는 Curve" 링크로 네 원본을
  각각 저장할 수 있습니다. "가변 크기" 샘플은 크기가 서로 다른 차트와
  소형 단일 봉우리 차트를 함께 포함합니다. "경계 없는 Curve"는 프레임과
  축 없이 Curve만 놓인 차트 전용 이미지입니다. 혼합 샘플의 비차트 내용은
  Curve 증거가 없어 제외됩니다.
- 기존 12차트 PPT 검증 파일의 4/8-State 분포도 패키지에 유지됩니다.
- 분리된 차트는 바깥쪽 PPT 카드가 아니라 실제 내부 플롯을 선택하고,
  원본 해상도 크롭에서 Curve를 다시 분석합니다.
- 차트 탭마다 "선택 원본 패널"과 "정규화 추출 Curve"를 나란히 보여주며
  검출/관측 State, peak·valley, 축 방식과 Curve 검증 근거를 확인할 수
  있습니다. 각 차트의 추천 결과와 점수도 따로 표시됩니다.
- 그래프 안의 실선·점선 격자, 짧은 눈금, 부분 가이드선, 배경 잡음 군집을
  단계별로 제거하고 Curve가 선을 가로지르는 교차부만 연속성에 따라
  복원합니다.
- 파일 선택과 끌어놓기 외에 화면을 클릭한 뒤 Ctrl+V로 클립보드 이미지를
  바로 분석할 수 있습니다.
- 브라우저에서 복원한 Curve와 원본 수치 Curve의 positive pair로 학습한
  4차원 PCA + 8-unit tanh 비선형 dual Curve encoder가 기존
  peak·valley·tail 재정렬을 보완합니다.
- 안전한 운영을 위해 검증된 상위 2개 후보 안에서만 순서를 조정합니다.

이 PC 전용 화면 학습
- 산포 그림을 분석한 뒤 학습 패널을 열고 저장 동의에 체크합니다.
- 한 파일에서 분리된 차트는 각각 별도의 학습 후보와 원본 크롭으로 저장됩니다.
- "여러 파일 학습" 또는 "폴더 전체 학습"으로 선택한 지원 이미지를 개수
  제한 없이 순차 분석하고 저장할 수 있습니다.
- "이 PC에 학습"을 누르면 축 없는 표준 Curve, descriptor와
  파일명·메타데이터를 제거한 원본 미리보기가 data 폴더에 저장됩니다.
- 학습 후보가 추천되면 표준 Curve와 저장한 원본 미리보기를 함께 보여줍니다.
- 저장한 후보는 이 PC의 다음 검색부터 바로 포함되며 화면에서 삭제할 수 있습니다.
- 유사/비유사 판정은 "평가 JSON 저장"으로 이 PC에 내려받을 수 있습니다.

이 PC 전용 학습 이미지 API
- 런타임 격리 확인: GET http://127.0.0.1:4173/api/v1/runtime
- 상태 확인: GET http://127.0.0.1:4173/api/v1/health
- OpenAPI: GET http://127.0.0.1:4173/api/v1/openapi.json
- 이미지 유사 검색: POST http://127.0.0.1:4173/api/v1/similarity-search
- 학습본 목록: GET http://127.0.0.1:4173/api/v1/training-samples
- 전체 내보내기: GET http://127.0.0.1:4173/api/v1/training-export

PowerShell에서 유사 그림 5개와 점수 검색:
Invoke-WebRequest -Method Post \`
  -Uri "http://127.0.0.1:4173/api/v1/similarity-search?topK=5" \`
  -ContentType "image/png" -InFile ".\\graph.png"

검색 결과의 panelCount, panelLayout, panels 배열은 분리된 차트의 좌표,
검출 신뢰도, 차트별 query와 results를 포함합니다. 기존 연동을 위한 최상위
query와 results는 첫 번째 차트를 가리킵니다. 각 results 배열은 rank,
score, 세부 형상 scores, 유사 이유, 표준 추천 그림 URL과 학습 원본 그림
URL을 포함합니다. 검색 입력 그림은 저장하거나 학습에 사용하지 않습니다.

PowerShell에서 원본 그림 밀어넣기:
Invoke-WebRequest -Method Post \`
  -Uri "http://127.0.0.1:4173/api/v1/training-images?id=line-001&label=Line-001" \`
  -ContentType "image/png" -InFile ".\\graph.png"

원본 그림만 넣은 항목은 status=pending으로 안전하게 보관됩니다. 검색에 즉시
사용하려면 256-point profile과 descriptor를 포함한 JSON을
POST /api/v1/training-samples 로 보냅니다.
정확한 JSON 스키마는 OpenAPI 문서를 참고하세요.

선택 보안 설정
API 변경 요청에 키를 요구하려면 start.bat 실행 전에 환경 변수
VTH_API_KEY를 설정합니다. 클라이언트는 x-api-key 또는 Bearer 헤더를
사용할 수 있습니다.

파일 무결성
checksums-sha256.txt에는 패키지 내부 파일의 SHA-256이 기록되어 있습니다.
`;
  const dataReadme = `이 폴더에는 사용자가 학습한 이미지와 training-index.json이 저장됩니다.
서비스 실행 중에는 파일을 직접 편집하지 마세요.
`;
  const manifest = {
    name: "유사 산포 검색",
    version,
    platform: "windows-x64",
    entrypoint: "start.bat",
    node: {
      version: nodeVersion,
      officialArchive: nodeArchiveUrl,
      archiveSha256: nodeArchiveSha256,
      packagedArchive: "runtime/node-runtime.tar.xz",
      firstRunExtraction: "Windows tar.exe",
    },
    service: {
      url: "http://127.0.0.1:4173",
      openapi: "/api/v1/openapi.json",
      dataDirectory: "data",
    },
    network: {
      mode: "offline-loopback-only",
      externalNetworkAllowed: false,
      sharedApiEnabled: false,
      contentSecurityPolicy: "connect-src 'self' blob:",
    },
    bundled: {
      corpus: true,
      model: true,
      similaritySearchApi: true,
      multiChartPanelSplitting: true,
      multiChartMaximumPanels: 24,
      multiChartSample: {
        path: "site/client/samples/vnand-ppt-12-chart-sample.png",
        panelCount: 12,
        expectedStateCounts: [
          4, 8, 8, 8,
          4, 8, 8, 8,
          4, 8, 8, 8,
        ],
        layout: {
          rows: 3,
          columns: 4,
        },
      },
      randomMultiChartSamples: [
        {
          path: "site/client/samples/vnand-random-multichart-mixed-01.png",
          panelCount: 8,
          distractors: ["table", "diagram", "photo"],
        },
        {
          path: "site/client/samples/vnand-random-multichart-mixed-02.png",
          panelCount: 8,
          distractors: ["table", "diagram", "photo"],
        },
        {
          path: "site/client/samples/vnand-random-multichart-lowres-03.png",
          panelCount: 7,
          distractors: ["table", "diagram", "photo"],
        },
        {
          path: "site/client/samples/vnand-random-multichart-frameless-04.png",
          panelCount: 8,
          distractors: [],
        },
      ],
      webApplication: true,
      nodeRuntime: true,
    },
    generatedAt: new Date().toISOString(),
  };
  await Promise.all([
    writeFile(path.join(stagingDirectory, "start.bat"), startScript, "utf8"),
    writeFile(
      path.join(stagingDirectory, "README-WINDOWS.txt"),
      readme,
      "utf8",
    ),
    writeFile(
      path.join(stagingDirectory, "data", "README.txt"),
      dataReadme,
      "utf8",
    ),
    writeFile(
      path.join(stagingDirectory, "package-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
  await writeChecksums();

  await run(
    "zip",
    ["-q", "-9", "-r", "-X", path.basename(zipPath), packageName],
    { cwd: artifactsDirectory },
  );
  const zipStat = await stat(zipPath);
  const zipSha256 = await sha256(zipPath);
  const generatedAt = new Date().toISOString();
  const zipBytes = await readFile(zipPath);
  const parts = [];
  await cleanPreviousWindowsDownloads();
  for (let offset = 0, index = 0; offset < zipBytes.length; index += 1) {
    const bytes = zipBytes.subarray(offset, offset + publicChunkSize);
    const fileName = `${publicZipName.replace(
      /\.zip$/,
      `-v${version}.zip`,
    )}.part-${String(index).padStart(3, "0")}`;
    const partPath = path.join(publicChunksDirectory, fileName);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(partPath, bytes);
    parts.push({
      index,
      path: `/downloads/chunks/${fileName}`,
      bytes: bytes.length,
      sha256: digest,
    });
    offset += bytes.length;
  }
  const publicMetadata = `${JSON.stringify(
    {
      schemaVersion: 1,
      name: "유사 산포 검색 Windows x64 단독 실행판",
      version,
      fileName: publicZipName,
      delivery: "browser-assembled",
      bytes: zipStat.size,
      sha256: zipSha256,
      generatedAt,
      parts,
    },
    null,
    2,
  )}\n`;
  await Promise.all([
    writeFile(publicMetadataPath, publicMetadata, "utf8"),
    writeFile(publicVersionedMetadataPath, publicMetadata, "utf8"),
    writeFile(
      publicChecksumPath,
      `${zipSha256} *${publicZipName}\n`,
      "utf8",
    ),
  ]);
  console.log(
    JSON.stringify(
      {
        stagingDirectory,
        zipPath,
        publicDownloadAction: "browser-assembled",
        publicPartCount: parts.length,
        zipBytes: zipStat.size,
        zipSha256,
      },
      null,
      2,
    ),
  );
}

await packageWindows();
