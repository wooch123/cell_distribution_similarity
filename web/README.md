# VTH Match Web

로그 스케일 V-NAND VTH 그래프를 업로드하면 축과 표현 스타일을 제거하고
형상이 유사한 분포 5~10개와 유사 이유를 보여주는 웹 애플리케이션입니다.

## 외부 시스템 검색 API

`POST /api/v1/similarity-search`에 PNG/JPEG 한 장을 보내면 현재 웹 검색과
같은 전처리·Curve 추출·재정렬기를 실행하고 순위별 종합 점수, 세부 형상
점수, 유사 이유, 표준 추천 이미지 URL과 학습 원본 이미지 URL을 JSON으로
반환합니다. 기본 8개, `topK=1~10`을 지원하며 종합 점수는 확률이 아니라
0~1 범위로 보정한 형상 유사도입니다. 검색 입력은 일회성으로 메모리에서만
분석하며 학습 후보로 저장하지 않습니다.
한 이미지에 서로 다른 좌표의 차트가 여러 개 있으면 행·열 정렬을 가정하지
않고 각 직사각형 프레임과 열린 L축을 독립적으로 찾아 `panels[]`마다
별도 Query와 Top-K를 반환합니다. 입력 가로·세로 픽셀 수를 차트 판정의
고정 최소·최대로 사용하지 않으며, 저해상도 입력은 제한된 작업 메모리
안에서 최대 16배로 적응 확대해 끊어진 축선의 짧은 간격을 복원합니다.
검출 좌표는 다시 원본 좌표로 환산해 크롭·검색·학습합니다. 기존 연동을
위해 최상위 `query`와
`results`는 첫 번째 패널을 그대로 가리킵니다. FHD 한 이미지당 최대
30개를 분석하며, 초과 시 신뢰도가 높은 30개를 선택하고
`panelDetection.truncated`로 알립니다.
각 Query는 `stateCount`, `peakCount`, `valleyCount`,
`topologyConsistent`를 함께 반환해 `peak=State`,
`valley=peak-1` 계약을 외부 연동에서도 확인할 수 있습니다.
한 물리 패널 안에 검정·회색을 포함해 서로 다른 색의 full-width 파형이
여러 개 있으면
`seriesCount`, `selectedSeriesIndex`, `series[]`로 분리하고 각 시리즈에
독립 Query와 Top-K를 반환하며 학습에서도 별도 후보로 저장합니다. 색과
선 스타일은 분리를 위한 임시 신호일 뿐 정규화된 유사도에는 포함하지
않습니다. 패널 및 최상위 legacy `query/results`는 가장 비정규적인
시리즈를 대표값으로 유지합니다. 프레임 후보 안에서 연속 경로, 직선으로
설명되지 않는 곡률, 충분한 y 변화량과 rounded peak/tail 근거를 함께
검사합니다. 설명 텍스트, 표·격자, 빈 좌표계, 사각형과 순서도 같은
설명 도형은 검색·학습 패널에서 제외하며 제외 수는
`panelDetection.rejectedNonChartCount`로 반환합니다. 이미지 전체에
유효한 분포 파형이 없으면 API는
`422 distribution_waveform_not_found`를 반환합니다. 호환용 `error.code`는
유지하고 `reasonCode`와 `details`에 전경 부족, 저해상도 증거 부족,
표·격자 우세, 연속 파형 부족, 후보 탈락·충돌을 구분하는
`VTH-DETECT-*` 코드와 조치·검출 통계를 제공합니다. 웹 화면도 기존 오류
영역에 같은 코드, 판정 원인, 권장 조치, 입력/분석 해상도를 표시합니다.
각 `panels[].series[]`는 외부 학습 API의 `sourceSelection`, `profile`,
`descriptor`로 그대로 사용할 `trainingSelection`, 256-point `profile`,
canonical `descriptor`를 반환합니다. 검색에 사용한 동일한 전체 이미지를
함께 보내면 별도 Curve 추출기 없이 서버가 패널 수·인덱스를 다시 확인하고 선택
패널 안에서 제출 Curve와 일치하는 원본 시리즈를 찾아
profile·descriptor·State를 재생성합니다. 패널/시리즈 배치나 형상이
원본과 다르면
`422 source_selection_image_mismatch`를 반환합니다.

공용 API에서는 메타데이터를 제거한 3MB 이하 JPEG를 먼저 검색한 뒤 정확히
같은 JPEG를 multipart 학습 요청에 사용합니다.

```bash
curl -sS -X POST \
  'https://dove9999.com/api/v1/similarity-search?topK=5' \
  -H 'Content-Type: image/jpeg' --data-binary '@document.jpg' > search.json
CONTRIBUTOR_TOKEN=$(openssl rand -hex 32)
DELETION_TOKEN=$(openssl rand -hex 32)
jq -c --arg contributor "$CONTRIBUTOR_TOKEN" --arg deletion "$DELETION_TOKEN" \
  '.panels[0].series[0] |
   {schemaVersion:2,label:"API selected series",profile,descriptor,
    sourceSelection:.trainingSelection,sharingConsent:true,
    consentVersion:"2026-07-30-v3",contributorToken:$contributor,
    deletionToken:$deletion}' search.json > shared-payload.json
curl -sS -X POST \
  'https://dove9999.com/api/v1/shared-training-samples' \
  -F "payload=$(cat shared-payload.json)" \
  -F 'sourceImage=@document.jpg;type=image/jpeg'
```
1920×1080 FHD 입력은 1600×900으로 축소하지 않고 원본 분석 크기를
보존해 3–4px의 좁은 차트 간격과 가는 프레임을 유지합니다.

```bash
curl -X POST \
  "https://dove9999.com/api/v1/similarity-search?topK=5" \
  -H "Content-Type: image/png" \
  --data-binary "@vth-graph.png"
```

Raw 이미지 외에도 `multipart/form-data`의 `image` 파일과
`application/json`의 Base64 `imageDataUrl`을 받을 수 있습니다. 전체
계약과 오류 코드는 `/similarity-search-openapi.json`에서 확인합니다.
동일 엔드포인트와 계약은 Windows 패키지의 로컬 서버와 Ubuntu Universal
(x64 + ARM64) 외부 Web 서버 패키지에도 포함됩니다.

## 개인정보 처리

검색만 할 때 업로드 원본 이미지는 서버에 저장하거나 전송하지 않습니다.
브라우저의 Canvas에서 사각 프레임 또는 특허 도면의 열린 L자 축을 검출하고,
축·격자·내부 수직 기준선·분리된 텍스트 라벨을 제거한 뒤 Curve를 추출합니다.
서로 떨어진 프레임/L축이 두 개 이상이면 먼저 좌표별 차트로 크롭하고 화면의
차트 탭에서 각각의 검색 결과를 전환합니다. 현재 그림을 학습할 때는
`학습 포함` 체크박스와 전체 선택/해제로 원하는 차트와 색상 시리즈만
별도 후보로 저장합니다. 메타데이터를 제거한 전체 입력 JPEG는 선택 좌표
검증에만 사용하고, 서버가 다시 자른 선택 패널 미리보기만 저장합니다.
선택하지 않은 항목과 주변 표·설명 텍스트는 학습 저장소에 남지 않습니다.
입력 영역의 `랜덤 멀티 차트 분석`은 매번 서로 다른 임의 배치 샘플을
선택합니다. 고해상도 2장과 저해상도 1장은 차트 외에 표·플로우차트·사진성
블록을 함께 포함합니다. 네 번째 `경계 없는 Curve` 샘플은 프레임과 축 없이
크기·위치가 다른 Curve 8개만 배치하며 단일 봉우리와 좁은 빈 간격도
포함합니다. 다섯 번째 `FHD 밀집 30차트` 샘플은 1920×1080 안에
5행×6열 차트 30개를 오밀조밀하게 배치하고 표·도형·사진성 방해 요소도
함께 넣습니다. `샘플 1`, `가변 크기`, `저해상도`, `경계 없는 Curve`,
`FHD 밀집 30차트` 링크로 각 원본을 내려받을 수 있습니다. `가변 크기`
샘플은 면적 차이가 큰 차트와 소형 단일 봉우리 차트를 함께 배치합니다.
기존 3행×4열 12차트 검증 PNG도
`/samples/vnand-ppt-12-chart-sample.png`에 유지합니다. 바깥 PPT 카드와 실제 차트가
겹쳐 보일 때는 내부 플롯의 경계 증거를 우선하고, 위치 검출 후 원본 해상도
크롭에서 Curve를 다시 분석합니다. 차트 탭에는 `선택 원본 패널`과
`정규화 추출 Curve`를 나란히 표시하고 검출/관측 State, peak·valley,
축 방식과 Curve 검증 근거를 함께 제공합니다. 샘플은
기존 12차트 샘플은 `node scripts/generate-ppt-multichart-sample.mjs`,
임의 배치 혼합 샘플은
`node scripts/generate-random-multichart-samples.mjs`, FHD 밀집 샘플은
`node scripts/generate-fhd-30-chart-sample.mjs`로 재생성합니다.
같은 샘플과 무작위 배치·저해상도 복원을 포함한 최대 30차트 분리기는
Windows x64 및 Ubuntu Universal v1.47.0 독립판에도 함께 포함됩니다.
v1.40.0 화면은 분석된 차트·색상 시리즈별 선택 학습을 지원합니다.
160×90의 4차트, 240×135의 12차트, 조밀한 표형 격자 위 색상/검정
유효 파형과 실제 색상 표를 짝지은 회귀로 초저해상도 분리와 표 오판정을
동시에 검증합니다.
v1.47.0의 Ubuntu Universal 패키지는 공식 Linux x64와 ARM64 Node
런타임을 하나의 `.tar.gz`에 포함합니다. `start.sh`가 `uname -m`의
`x86_64`/`amd64` 또는 `aarch64`/`arm64` 값을 판별해 맞는 런타임을
자동 선택하며, 매니페스트 플랫폼은 `ubuntu-linux-universal`입니다.
LAN IP·사내 DNS의 일반 HTTP에서도 same-origin `/api/v1/runtime`
응답으로 로컬 서버판을 판별합니다. `crypto.randomUUID()`를 사용할 수
없는 비보안 origin은 `crypto.getRandomValues()` 기반 RFC 4122 UUID
v4로 안전하게 대체해 검색, 데모, 업로드·붙여넣기, 로컬/일괄 학습과
데이터 관리 기능을 유지합니다.
v1.43.0은 큰 글자 제목·문서 본문·숫자 행·회전 텍스트의 반복 글자 형상과
잉크 배치를 분석해 분포 차트로 오인하지 않도록 합니다. 실선·점선 격자가
조밀한 실제 차트는 가이드 교차부의 파형 연속성과 물리 프레임 증거를
검증해 표로 제외하지 않고 유효한 분포 Curve를 보존합니다.
v1.42.0은 단일 차트 안의 가이드선이 조밀한 격자를 만들어 표처럼 보이는
경우에도 후보별 물리 격자와 직선 제거 잔여 파형의 연속성을 증명해 실제
분포를 유지합니다. 독립적인 전체 폭 색상 분포가 1~2개이면 각각 별도
Curve로 반환하고, 3개 이상이면 단일 봉우리 색상을 포함한 모든 후보의
비정규성 점수를 비교해 가장 비정규적인 하나만 검색·학습·API 대상으로
반환합니다.
v1.41.0은 800×450 이미지의 절반에 표처럼 밀집한 분포 차트와 공유 경계
4×4 차트 격자를 셀별로 재분석합니다. 여러 셀에서 실제 peak와 인접
valley가 함께 측정되고 복구 행·열 수가 물리 격자와 일치할 때만 전역
표 판정을 해제합니다. 같은 크기의 텍스트 표, 단일 Gaussian 스파크라인
표, 저품질 JPEG 및 회전 표는 계속 제외합니다.
1672×941 진단 슬라이드에서는 회색 외곽선을 배경으로 오인하지 않고,
좌측 4행×5열의 8-State VTH 파형 20개만 반복 격자로 복원합니다.
우측 설명문·수치 표·단조 RBER 추세선 차트는 비분포 콘텐츠로 제외합니다.
추가 4종 State Count Sweep 회귀는 프레임 유무, 점 형태 outlier,
주석·화살표·강조 원, 1280/1672px 해상도 차이에도 좌측 4×4 분포
패널 16개만 모두 복원합니다. 패널 안에서는 캡션 숫자를 답으로 사용하지
않고 물리적으로 보이는 peak를 1~20 State로 세며, 모든 검색·학습·API
경로에서 `peak=State`, `valley=peak-1`, 좌·우 tail 2개를 강제합니다.
행·열 정렬을 전제로 하지 않는 전역 공간 탐색과 다중 스케일 후보,
원본 ROI 재분석 및 저해상도 색상 State 복구를 결합합니다. 별도 FHD
회귀는 1920×1080 안에 48×35부터 315×205까지 실제 QLC 차트 28개를
임의 위치·크기·간격으로 배치하고 텍스트·표·도형·단조 추세선을 섞어,
파형 28개만 모두 분리되는지 검증합니다. 하나의 물리 차트에 포함된 여러
색상 시리즈는 패널을 중복 생성하지 않고 시리즈별 Curve로 분리합니다.
추출 결과는 함께 배포된 읽기 전용 코퍼스와 로컬로 비교합니다.
격자는 실선과 점선의 긴 수평·수직 run을 함께 검출하며, 삭제 후 Curve가
양쪽에서 이어지는 교차 픽셀만 복원해 peak·valley 단절을 줄입니다.

사용자가 명시적으로 공유 동의하고 `공용 학습에 등록`을 누르면 256-point
Curve와 descriptor를 D1에, 축 없는 표준 그래프와 서버에서 좌표를
재검증해 자른 선택 패널 JPEG 미리보기를 R2에 저장합니다. 브라우저가
파일명·메타데이터를 제거한 전체 입력 JPEG는 검증에만 사용합니다.
등록 후보는 다른 사용자의 검색에도 합쳐지고, 추천 시 표준 Curve와 학습
원본 미리보기를 함께 표시합니다. 동일 형상은 fingerprint로 중복 제거하고
하루 200개 제한, 전체 2,000개 제한, 업로더 전용 삭제 토큰을 적용합니다.
현재 분석한 멀티 차트 그림은 선택한 차트와 색상 시리즈만 등록하고,
선택 수와 저장 진행률을 화면에 표시합니다.
파일 여러 장 또는 폴더 하나를 선택하면 그 안의 지원 이미지를 개수 제한
없이 순차 분석하며 각 이미지에서 검출한 모든 차트와 시리즈를 학습하고
신규·중복·실패·제외 건수를 화면에 집계합니다.
한 번에 최대 500개를 keyset cursor로 조회하며 브라우저는 모든 page를
끝까지 불러와 500개 이후 후보도 검색에 포함합니다. API 계약은
`/shared-training-openapi.json`에서 확인합니다.

추천 후보의 `유사`/`비유사` 판정은 별도 동의 후 schema-v3 공용 relevance
report로 D1에 저장됩니다. 원본·파일명은 포함하지 않고 Query/평가자 코드는
서버에서 해시합니다. 같은 Query의 서로 다른 익명 평가자 report를 보존해
합의 라벨을 만들며, 같은 평가자의 재제출은 최신 report로 갱신됩니다.
공용 export는 `/api/v1/shared-relevance-export`에서 받을 수 있습니다.

검색 후 각 후보를 `유사`/`비유사`로 판정하고 익명 평가 JSON을 저장할 수
있습니다. schema-v3 JSON에는 원본 이미지와 파일명이 포함되지 않으며
정규화된 256-point 형상, 재정렬기의 8개 pair 특징, 후보 점수, 전문가
판정만 기록됩니다. 같은 실제 그림을 평가하는 전문가들은 `공유 Query 코드`
하나를 사용합니다. 브라우저가 생성한 기기별 익명 평가자 코드로 판정을
구분하며, 한 기기를 공유할 때는 서로 다른 익명 코드를 직접 입력할 수
있습니다. 이름이나 계정 없이 합의율을 계산합니다.

Windows 완전 독립판은 같은 웹 빌드, 검색 코퍼스, 모델, Node 런타임을
함께 포함합니다. 로컬 런타임에서는 공용 API 경로를 실행하지 않고 화면
학습을 `data/` 저장소로 전환합니다. 서버 응답의 CSP
`connect-src 'self' blob:`와 `/api/v1/runtime`의 오프라인 정책으로 외부 통신을
차단합니다.

Ubuntu Universal (x64 + ARM64) 패키지는 별도 외부 Web 서버용
배포본입니다. 상단의 `UBUNTU X64 + ARM64 · WEB SERVER` 버튼으로
내려받으며 Windows 오프라인 실행판과 용도와 버튼을 분리합니다. Node.js나
npm 설치 없이 `.tar.gz`를 풀고 `./start.sh`를 실행하면 현재 Linux
아키텍처에 맞는 번들 런타임을 선택합니다. 웹 다운로드는 두 운영체제 모두
schema-v1 매니페스트와 SHA-256 조각 검증을 거쳐 브라우저에서 원본
패키지를 재조립합니다. v1.47.0의 고정 매니페스트 경로는
`/downloads/windows-package-v1.47.0.json`과
`/downloads/ubuntu-package-v1.47.0.json`입니다. Ubuntu 매니페스트는
`platform: ubuntu-linux-universal`,
`architectures: [x64, arm64]`와
`fileName: vth-similarity-ubuntu-universal.tar.gz`를 선언해야 하며,
다운로드 코어는 이를 검증한 뒤
`vth-similarity-ubuntu-universal-v1.47.0.tar.gz`로 저장합니다.

## 로컬 실행

Node.js `>=22.13.0` 환경에서 실행합니다.

```bash
npm ci
npm run dev
```

검증:

```bash
npm run lint
npm run build
node --test tests/*.test.mjs
```

상위 프로젝트에 공개 로그 그래프 검증셋이 있으면 브라우저와 동일한
공유 전처리 코어의 마스크·축·곡선 정제, 256-point 프로필, State 추정,
코퍼스 검색·재정렬
전체 경로를 2/4/16-State 원본·리사이즈·JPEG 15개에 회귀 검증할 수
있습니다. 현재 15/15에서 State와 상위 10개 결과의 State가 일치하며,
동일 그림 변형 간 최소 프로필 유사도는 0.968, Top-5 중복률은 0.8
이상입니다.

```bash
node scripts/evaluate-public-image-core.mjs
```

실측 NAND 칩 marker와 모델 선이 함께 있는 공개 논문의 4개 P/E 조건을
원본·리사이즈·흑백 JPEG 12개로 검증할 수도 있습니다. 현재 12/12 전체
경로가 통과하며 동일 패널 변형 간 최소 프로필 유사도는 0.958, Top-5
중복률은 0.8 이상입니다.

```bash
node scripts/evaluate-public-image-core.mjs \
  ../artifacts/real-measured-validation/queries measured
```

상용 TLC의 충전 State와 세 수명 조건이 한 패널에 겹친 출처 및 3D
QLC의 16-State cell-count 측정 출처까지 합치면 총 18개 변형을 검증합니다.
전체 18/18이 전처리, 물리 State 판정, 가설별 State Top-10 검색을
통과합니다. 여섯 실측 그룹의 원본·리사이즈·JPEG 변형 간 최소 프로필
유사도는 0.958 이상이며, 각 그룹에서 동일한 Top-1 후보를 유지합니다.

```bash
node scripts/evaluate-public-image-core.mjs \
  ../artifacts/real-measured-multisource-validation/queries \
  measured-multisource
```

실측·사용자형 4/8/16-State 그래프에 실선·점선 격자, 부분 가이드와 눈금,
배경 salt/scan 노이즈, 격자+JPEG 복합 열화, ±3° 회전을 합성한 32개
강건성 변형도 검증합니다. 현재 32/32에서 물리 State 수를 유지하며,
비회전 변형의 원본 대비 최소 Curve 유사도는 0.885, 회전 변형은 0.903,
변형별 Top-10 추천의 최소 대칭 형상 coverage는 0.918, Top-1 추천
그림끼리의 최소 형상 유사도는 0.935입니다.

```bash
node scripts/evaluate-artifact-robustness.mjs \
  ../artifacts/artifact-robustness-validation
```

`vnand_fault_distributions_100` 전체를 원본·리사이즈·JPEG·실선 격자·
±3° 회전·격자+노이즈+회전+JPEG의 7가지 형태, 총 700 query로 검증합니다.
State 판정용 고대비 마스크와 검색용 중간 명암 마스크를 분리하고, 오염
증거가 강할 때만 보조 Curve 가설과 그 가설이 지지하는 State 후보군을
함께 검색하되 후보마다 서로 다른 마스크 조각을 섞지 않습니다. 한 개의
완전한 구제 Curve 가설이 상위 이미지 형상과 충분히 강하게 합의할 때만
그 가설 전체로 재검색합니다. 현재 exact-shape Top-10은 전체 653/700,
exact-ID Top-10은 625/700, 실선 격자 95/100, 복합 열화 88/100이며
복합 열화 fault 계열 Top-1은 95/100입니다.
원본 100장은 모두 exact-shape Top-10과 fault 계열 Top-1을 유지합니다.

```bash
npm run evaluate:fault-corpus
```

## 검색 코퍼스 갱신

상위 Python 프로젝트의 로그 코퍼스를 다시 생성하거나 인덱싱한 뒤 다음
명령으로 웹용 원본 Curve와 후보 이미지를 갱신합니다.

```bash
cd ..
.venv/bin/python scripts/export_web_corpus.py \
  --corpus data/processed/corpus-expanded \
  --model artifacts/pairwise-reranker.joblib \
  --dual-encoder artifacts/dual-curve-encoder.browser.json \
  --max-per-state 24 --baseline-seed 42
```

현재 웹 코퍼스는 `log10`, `10^-6 ~ 10^0`이며 2/4/8/16-State별 합성
합성 분포는 State별 24개씩 총 96개입니다. 192개 고유 형상에서 기존
48개를 보존한 뒤 Curve·1차·2차 기울기의 farthest-shape 방식으로 48개를
추가했습니다. 여기에 `vnand_fault_distributions_100`의 fault 분포
100장을 같은 브라우저 이미지 분석기로 학습해 운영 코퍼스는 총
196개입니다.
모든 State에서 네 형상 family가 유지되며, 브라우저 인덱스에는 오프라인에서
학습한 monotonic pairwise reranker의 가중치도 포함됩니다. 최종 순서는
홀드아웃 192장에서 검증한 재정렬 점수 70%와 원시 retrieval 점수 30%
보정을 사용합니다. 여기에 브라우저 복원 Curve와 원본 수치 Curve를
positive pair로 학습한 4차원 PCA + 8-unit tanh 비선형 dual Curve
encoder가 상위 2개만 8% 가중치로 재정렬합니다.
축·색·격자를 다시 넣을 수 없는 3,200차원 표준 Curve raster+HOG 이미지
임베딩도 상위 2개에서 기존 profile 판단과 함께 일치할 때만 순서를
조정합니다. sample-ID 홀드아웃과
공개 15장·실측 18장·사용자
peak–valley 3장 회귀 게이트를 모두 통과한 모델만 내보냅니다. 실제 제품
데이터는 익명화와 전문가 relevance 검증 후 별도 버전으로 추가해야 합니다.

## 배포

Cloudflare Worker 호환 vinext 빌드를 사용하며 Sites 프로젝트와
`dove9999.com` 커스텀 도메인에 연결됩니다. 호스팅 식별자는
`.openai/hosting.json`에서 관리합니다.
공용 후보 메타데이터와 형상은 각각 `DB` D1 binding과
`VTH_SHARED_IMAGES` R2 binding에 영속 저장됩니다.
익명 relevance report도 `DB`에 저장되며 두 명 이상의 평가자가 참여한
Query 수를 별도 품질 지표로 집계합니다.
