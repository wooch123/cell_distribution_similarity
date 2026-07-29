import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
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
const version = "1.39.0";
const packageName = `vth-similarity-ubuntu-x64-v${version}`;
const artifactsDirectory = path.join(projectRoot, "artifacts", "ubuntu");
const cacheDirectory = path.join(artifactsDirectory, "cache");
const stagingDirectory = path.join(artifactsDirectory, packageName);
const archivePath = path.join(artifactsDirectory, `${packageName}.tar.gz`);
const archiveChecksumPath = `${archivePath}.sha256`;
const publicDownloadsDirectory = path.join(
  projectRoot,
  "web",
  "public",
  "downloads",
);
const publicChunksDirectory = path.join(publicDownloadsDirectory, "chunks");
const publicArchiveName = "vth-similarity-ubuntu-x64.tar.gz";
const publicMetadataPath = path.join(
  publicDownloadsDirectory,
  "ubuntu-package.json",
);
const publicVersionedMetadataPath = path.join(
  publicDownloadsDirectory,
  `ubuntu-package-v${version}.json`,
);
const publicChecksumPath = path.join(
  publicDownloadsDirectory,
  "vth-similarity-ubuntu-x64.sha256",
);
const publicChunkSize = 4 * 1024 * 1024;
const nodeVersion = "24.14.0";
const nodeArchiveRoot = `node-v${nodeVersion}-linux-x64`;
const nodeArchiveName = `${nodeArchiveRoot}.tar.xz`;
const nodeArchivePath = path.join(cacheDirectory, nodeArchiveName);
const nodeArchiveUrl =
  `https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`;
const nodeArchiveSha256 =
  "41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df";
const sampleFiles = [
  "vnand-ppt-12-chart-sample.png",
  "vnand-random-multichart-mixed-01.png",
  "vnand-random-multichart-mixed-02.png",
  "vnand-random-multichart-lowres-03.png",
  "vnand-random-multichart-frameless-04.png",
  "vnand-fhd-dense-30-chart-sample.png",
  "vnand-fhd-dense-30-chart-sample.json",
  "random-multichart-samples.json",
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        COPYFILE_DISABLE: "1",
        ...options.env,
      },
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

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.once("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("end", () => resolve(hash.digest("hex")));
  });
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
        `Node.js Ubuntu runtime download failed (${response.status}).`,
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

async function cleanPreviousUbuntuDownloads() {
  await mkdir(publicChunksDirectory, { recursive: true });
  const chunkEntries = await readdir(publicChunksDirectory);
  await Promise.all(
    chunkEntries
      .filter((entry) =>
        entry.startsWith("vth-similarity-ubuntu-x64-v"),
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
          /^ubuntu-package(?:-v\d+\.\d+\.\d+)?\.json$/.test(entry) ||
          entry === "vth-similarity-ubuntu-x64.sha256",
      )
      .map((entry) =>
        rm(path.join(publicDownloadsDirectory, entry), { force: true }),
      ),
  );
}

async function packageUbuntu() {
  const webDistDirectory = path.join(projectRoot, "web", "dist");
  await Promise.all([
    access(path.join(webDistDirectory, "client", "corpus-index.json")),
    ...sampleFiles.map((fileName) =>
      access(
        path.join(webDistDirectory, "client", "samples", fileName),
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
  await rm(archivePath, { force: true });
  await rm(archiveChecksumPath, { force: true });
  const extractionDirectory = path.join(
    artifactsDirectory,
    `.node-extract-${process.pid}`,
  );
  await rm(extractionDirectory, { recursive: true, force: true });
  await Promise.all([
    mkdir(path.join(stagingDirectory, "runtime"), { recursive: true }),
    mkdir(path.join(stagingDirectory, "server"), { recursive: true }),
    mkdir(path.join(stagingDirectory, "site"), { recursive: true }),
    mkdir(path.join(stagingDirectory, "data", "images"), {
      recursive: true,
    }),
    mkdir(extractionDirectory, { recursive: true }),
  ]);

  try {
    await run("tar", [
      "-xJf",
      nodeArchivePath,
      "-C",
      extractionDirectory,
      `${nodeArchiveRoot}/bin/node`,
      `${nodeArchiveRoot}/LICENSE`,
    ]);
    await Promise.all([
      cp(
        path.join(extractionDirectory, nodeArchiveRoot, "bin", "node"),
        path.join(stagingDirectory, "runtime", "node"),
      ),
      cp(
        path.join(extractionDirectory, nodeArchiveRoot, "LICENSE"),
        path.join(stagingDirectory, "runtime", "LICENSE"),
      ),
    ]);
    await chmod(path.join(stagingDirectory, "runtime", "node"), 0o755);
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }

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
  await run(path.join(projectRoot, "web", "node_modules", ".bin", "esbuild"), [
    path.join(projectRoot, "web", "lib", "vth-similarity-api-core.mjs"),
    "--bundle",
    "--platform=node",
    "--target=node24",
    "--format=esm",
    `--outfile=${path.join(stagingDirectory, "server", "similarity-engine.mjs")}`,
  ]);
  await rm(path.join(stagingDirectory, "site", "client", "downloads"), {
    recursive: true,
    force: true,
  });

  const startScript = `#!/usr/bin/env sh
set -eu

PACKAGE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PACKAGE_DIR"
umask 077

if [ -f "$PACKAGE_DIR/vth.env" ]; then
  set -a
  # vth.env is an administrator-owned shell environment file.
  . "$PACKAGE_DIR/vth.env"
  set +a
fi

VTH_LISTEN_HOST=\${VTH_HOST:-0.0.0.0}
VTH_LISTEN_PORT=\${VTH_PORT:-4173}

if [ -z "\${VTH_API_KEY:-}" ]; then
  echo "A token-protected access URL will be printed when the server starts."
else
  echo "Using the fixed access key from VTH_API_KEY."
fi
echo "Starting on \${VTH_LISTEN_HOST}:\${VTH_LISTEN_PORT}."
echo "Use one of the concrete token-protected URLs printed below."

set -- \\
  --root "$PACKAGE_DIR" \\
  --host "$VTH_LISTEN_HOST" \\
  --port "$VTH_LISTEN_PORT"

if [ -n "\${VTH_PUBLIC_URL:-}" ]; then
  set -- "$@" --public-url "$VTH_PUBLIC_URL"
fi

exec "$PACKAGE_DIR/runtime/node" "$PACKAGE_DIR/server/server.mjs" "$@"
`;
  const environmentExample = `# Copy this file to vth.env and edit it.
# start.sh automatically loads vth.env from this package directory.
VTH_HOST=0.0.0.0
VTH_PORT=4173

# Set the browser-visible URL when using DNS, HTTPS, or a reverse proxy.
# VTH_PUBLIC_URL=https://vth.example.com

# Recommended for a long-running shared server. Use a long random value.
# VTH_API_KEY=replace-with-a-long-random-secret
`;
  const systemdInstaller = `#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo: sudo ./install-systemd.sh" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required." >&2
  exit 1
fi

PACKAGE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUN_USER=\${VTH_SYSTEMD_USER:-\${SUDO_USER:-root}}
RUN_GROUP=\${VTH_SYSTEMD_GROUP:-$(id -gn "$RUN_USER")}
SERVICE_NAME=vth-similarity
UNIT_PATH="/etc/systemd/system/\${SERVICE_NAME}.service"
ENV_PATH="$PACKAGE_DIR/vth.env"

case "$PACKAGE_DIR" in
  *'
'*) echo "Package path must not contain a newline." >&2; exit 1 ;;
esac
ESCAPED_PACKAGE_DIR=$(printf '%s' "$PACKAGE_DIR" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')

if [ ! -f "$ENV_PATH" ]; then
  cp "$PACKAGE_DIR/vth.env.example" "$ENV_PATH"
fi
chmod 600 "$ENV_PATH"
mkdir -p "$PACKAGE_DIR/data/images"
chown -R "$RUN_USER:$RUN_GROUP" "$PACKAGE_DIR/data"
chown "$RUN_USER:$RUN_GROUP" "$ENV_PATH"

TEMP_UNIT=$(mktemp)
trap 'rm -f "$TEMP_UNIT"' EXIT HUP INT TERM
cat >"$TEMP_UNIT" <<EOF
[Unit]
Description=V-NAND distribution similarity service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory="$ESCAPED_PACKAGE_DIR"
EnvironmentFile=-"$ESCAPED_PACKAGE_DIR/vth.env"
ExecStart="$ESCAPED_PACKAGE_DIR/start.sh"
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths="$ESCAPED_PACKAGE_DIR/data"

[Install]
WantedBy=multi-user.target
EOF

install -m 0644 "$TEMP_UNIT" "$UNIT_PATH"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
echo "Installed $UNIT_PATH for $RUN_USER:$RUN_GROUP"
echo "Check status: systemctl status $SERVICE_NAME"
echo "Follow logs:  journalctl -u $SERVICE_NAME -f"
`;
  const readme = `유사 산포 검색 - Ubuntu Linux x64 독립 패키지
=================================================

실행
1. tar -xzf ${packageName}.tar.gz
2. cd ${packageName}
3. ./start.sh
4. 같은 PC에서는 http://127.0.0.1:4173, 다른 PC에서는
   http://<Ubuntu 서버 IP>:4173 으로 접속합니다.
5. 종료할 때 터미널에서 Ctrl+C를 누릅니다.

Node.js나 npm 설치는 필요하지 않습니다. 공식 Node.js v${nodeVersion}
Linux x64 실행 파일과 검색 코퍼스, 모델, 웹 화면, 로컬 학습 API가 모두
포함되어 있습니다. tar.gz는 start.sh의 실행 권한과 Linux 파일 모드를
보존하므로 ZIP 대신 사용합니다.

네트워크와 보안
- start.sh는 기본적으로 0.0.0.0:4173에서 수신하여 같은 LAN의 다른
  컴퓨터가 접속할 수 있습니다.
- 외부 서버로 원본 이미지나 학습 데이터를 보내지 않으며 공용 학습 API는
  비활성화되어 있습니다.
- VTH_API_KEY를 설정하지 않으면 서버 콘솔에 임시 토큰이 포함된 접속 URL이
  출력됩니다. 다른 PC에서는 그 URL을 처음 한 번 그대로 여십시오. 서버는
  토큰을 HttpOnly 쿠키로 바꾸고 주소창에서 토큰을 제거합니다.
- 서버를 반복 운영하거나 고정 키가 필요하면 실행 전에 설정하십시오.
    export VTH_API_KEY='충분히-긴-임의의-키'
    ./start.sh
- 클라이언트는 x-api-key 또는 Authorization: Bearer 헤더를 사용합니다.
- 로컬 접속만 허용하려면 VTH_HOST=127.0.0.1 ./start.sh 로 실행합니다.
- 리버스 프록시 뒤에서 사용할 때는 브라우저가 실제로 접속할 주소를
  VTH_PUBLIC_URL=https://검색.example.com 으로 지정하십시오.
- Ubuntu UFW에서는 신뢰할 수 있는 사설망만 허용하는 규칙을 권장합니다.
    sudo ufw allow from 192.168.0.0/16 to any port 4173 proto tcp
- 인터넷에 직접 4173 포트를 노출하지 말고 TLS 리버스 프록시와 방화벽을
  사용하십시오.

환경 파일과 systemd (선택)
- cp vth.env.example vth.env 후 값을 수정하면 start.sh가 자동으로
  불러옵니다. vth.env에는 비밀 키가 들어갈 수 있으므로 공유하지 마십시오.
- 장기 실행 서버로 등록하려면 패키지를 최종 경로에 둔 뒤 다음을 실행합니다.
    sudo ./install-systemd.sh
- 설치기는 현재 패키지 경로와 sudo 실행 사용자를 기준으로 unit을 만들고,
  data/만 쓰기 가능하게 유지하며 실패 시 서비스를 다시 시작합니다.
- 상태와 로그:
    systemctl status vth-similarity
    journalctl -u vth-similarity -f

형상 검색
- PNG/JPEG 산포 이미지와 클립보드 이미지를 분석합니다.
- 프레임, 열린 L축, 경계 없는 Curve 군집을 분리하고 FHD 이미지당 최대
  30개 차트를 독립적으로 검색합니다.
- 얇은 회색 슬라이드 외곽선을 실제 배경과 구분하고, 반복 파형 격자의
  누락된 셀 경계를 복원한 뒤 설명문·수치 표·단조 추세선을 제외합니다.
- 한 차트 안에 여러 색상 시리즈가 있으면 색은 분리 과정에서만 사용하고,
  각 시리즈를 색·선 스타일 없는 Curve로 정규화해 독립적으로 검색합니다.
  API의 panel.series 배열에서 시리즈별 순위와 점수를 확인할 수 있습니다.
- 크기가 다른 차트, 단일 봉우리, 저해상도, 표·도형·사진성 방해 요소를
  포함한 기존 네 가지 멀티차트 샘플과 1920×1080 안의 5행×6열 차트
  30개를 검증하는 FHD 밀집 샘플이 함께 들어 있습니다.
- 1920×1080 FHD 입력은 1600×900으로 축소하지 않아 3–4px의 좁은 차트
  간격과 가는 프레임을 원본 분석 크기에서 보존합니다.
- 실선·점선 격자, 눈금선, 가이드선, 라벨과 배경 잡음을 제거한 뒤 로그
  스케일 Curve 형상을 비교합니다.

로컬 학습
- 화면에서 한 장, 여러 파일 또는 폴더 전체를 분석해 이 서버의 data/
  폴더에 학습할 수 있습니다.
- 한 차트에서 색으로 분리된 여러 시리즈도 각각 별도 후보로 검증·저장됩니다.
- 학습 후보는 서버를 다시 시작해도 유지되고 데이터 관리 탭에서 삭제할 수
  있습니다.
- LAN 사용자는 같은 서버의 학습 후보와 추천 결과를 공유합니다.

API
- GET  /api/v1/runtime
- GET  /api/v1/health
- GET  /api/v1/openapi.json
- POST /api/v1/similarity-search?topK=5
- GET  /api/v1/training-samples
- POST /api/v1/training-images
- POST /api/v1/training-samples

예시:
export VTH_API_KEY='위에서-서버에-설정한-고정-키'
curl -X POST "http://127.0.0.1:4173/api/v1/similarity-search?topK=5" \\
  -H "x-api-key: $VTH_API_KEY" \\
  -H "Content-Type: image/png" --data-binary "@graph.png"

파일 무결성
checksums-sha256.txt에는 패키지 내부 파일의 SHA-256이 기록되어 있습니다.
`;
  const dataReadme = `사용자가 학습한 이미지와 training-index.json이 저장됩니다.
서비스 실행 중에는 파일을 직접 편집하지 마세요.
`;
  const runtimePath = path.join(stagingDirectory, "runtime", "node");
  const manifest = {
    name: "유사 산포 검색",
    version,
    platform: "ubuntu-linux-x64",
    architecture: "x86_64",
    entrypoint: "start.sh",
    archiveFormat: "tar.gz",
    node: {
      version: nodeVersion,
      officialArchive: nodeArchiveUrl,
      archiveSha256: nodeArchiveSha256,
      executable: "runtime/node",
      executableSha256: await sha256(runtimePath),
      firstRunExtraction: false,
    },
    service: {
      listenHost: "0.0.0.0",
      port: 4173,
      localUrl: "http://127.0.0.1:4173",
      lanUrl: "http://<server-ip>:4173",
      publicUrlEnvironmentVariable: "VTH_PUBLIC_URL",
      openapi: "/api/v1/openapi.json",
      dataDirectory: "data",
    },
    network: {
      mode: "offline-lan-server",
      inboundLanAccess: true,
      outboundExternalNetworkAllowed: false,
      sharedApiEnabled: false,
      contentSecurityPolicy: "connect-src 'self' blob:",
      apiKeyEnvironmentVariable: "VTH_API_KEY",
      automaticAccessToken: true,
      accessTokenTransport: "query-once-then-http-only-cookie",
    },
    bundled: {
      corpus: true,
      model: true,
      similaritySearchApi: true,
      multiChartPanelSplitting: true,
      multiChartMaximumPanels: 30,
      arbitraryPositionWaveformDetection: true,
      borderSafeDocumentBackground: true,
      repeatedWaveformGridRecovery: true,
      colorSeriesSeparation: true,
      similarityRanking: "per-panel-per-series",
      samples: sampleFiles.map((fileName) => ({
        path: `site/client/samples/${fileName}`,
      })),
      webApplication: true,
      nodeRuntime: true,
      environmentExample: "vth.env.example",
      optionalSystemdInstaller: "install-systemd.sh",
    },
    generatedAt: new Date().toISOString(),
  };
  await Promise.all([
    writeFile(
      path.join(stagingDirectory, "start.sh"),
      startScript,
      "utf8",
    ),
    writeFile(
      path.join(stagingDirectory, "vth.env.example"),
      environmentExample,
      "utf8",
    ),
    writeFile(
      path.join(stagingDirectory, "install-systemd.sh"),
      systemdInstaller,
      "utf8",
    ),
    writeFile(
      path.join(stagingDirectory, "README-UBUNTU.txt"),
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
  await Promise.all([
    chmod(path.join(stagingDirectory, "start.sh"), 0o755),
    chmod(path.join(stagingDirectory, "install-systemd.sh"), 0o755),
  ]);
  await writeChecksums();

  await run("tar", [
    "-czf",
    archivePath,
    "-C",
    artifactsDirectory,
    packageName,
  ]);
  const archiveStat = await stat(archivePath);
  const archiveSha256 = await sha256(archivePath);
  const generatedAt = new Date().toISOString();
  const archiveBytes = await readFile(archivePath);
  const parts = [];
  await writeFile(
    archiveChecksumPath,
    `${archiveSha256} *${path.basename(archivePath)}\n`,
    "utf8",
  );
  await cleanPreviousUbuntuDownloads();
  for (
    let offset = 0, index = 0;
    offset < archiveBytes.length;
    index += 1
  ) {
    const bytes = archiveBytes.subarray(
      offset,
      offset + publicChunkSize,
    );
    const fileName =
      `vth-similarity-ubuntu-x64-v${version}.tar.gz.part-` +
      String(index).padStart(3, "0");
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
      name: "유사 산포 검색 Ubuntu Linux x64 독립판",
      version,
      platform: "ubuntu-linux-x64",
      fileName: publicArchiveName,
      mediaType: "application/gzip",
      delivery: "browser-assembled",
      bytes: archiveStat.size,
      sha256: archiveSha256,
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
      `${archiveSha256} *${publicArchiveName}\n`,
      "utf8",
    ),
  ]);
  console.log(
    JSON.stringify(
      {
        stagingDirectory,
        archivePath,
        archiveChecksumPath,
        publicDownloadAction: "browser-assembled",
        publicPartCount: parts.length,
        archiveBytes: archiveStat.size,
        archiveSha256,
      },
      null,
      2,
    ),
  );
}

await packageUbuntu();
