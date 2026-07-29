# V-NAND 산포 유사도 검색

V-NAND VTH별 Cell 분포 그래프에서 축 숫자, 색, 해상도, 선 굵기 같은 표현
차이를 제거하고 **State 분포 형상**을 중심으로 유사 그래프를 추천하는
프로젝트입니다.

Cell 분포의 y축은 `log10` 스케일을 전제로 합니다. 현재 합성 기준 범위는
`10^-6 ~ 10^0`이며, 검색은 절대 y값이 아니라 로그 축에서 보이는 peak,
valley, tail 형상을 비교합니다.

현재 1차 MVP는 합성 데이터 생성부터 외부 이미지 Top-K 추천까지 한 번에
실행할 수 있습니다.

## 웹 데모

배포 주소: [https://dove9999.com](https://dove9999.com)

PNG/JPEG/WEBP 로그 스케일 VTH 그래프를 파일 선택, 끌어놓기 또는
클립보드 붙여넣기로 넣으면 브라우저 안에서 그래프 영역과 Curve를 추출하고
합성 코퍼스의 유사 분포 5~10개를 추천합니다. 실선·점선 격자, 짧은 눈금,
부분 가이드선, 배경 잡음 군집을 단계별로 제거하고, Curve가 선을 지나는
교차부만 양쪽 연속성을 확인해 복원합니다. 고대비 Curve 가설을 별도로
분석하며, 주 가설이 State 수를 오인해도 보조 가설을 같은 저-State
좌표계로 강제하지 않습니다. 얇은 수직 가이드가 만드는 가짜 peak도
양옆 Curve 연속성으로 보정합니다. 스캔·촬영 이미지가 약 ±4° 기울어진
경우에는 프레임의 수평·수직 투영을 함께 사용해 자동으로 바로잡습니다.
복합 격자·노이즈가 검출되면 여러 마스크의 일부를 후보마다 섞지 않고,
한 개의 완전한 Curve 가설이 상위 이미지 형상과 충분히 강하게 합의할 때만
구제 전처리를 채택합니다.
한 이미지에 서로 다른 좌표의 차트가 여러 개 있으면 행·열 정렬을 가정하지
않고 직사각형 프레임과 열린 L축을 좌표별로 독립 검출해 겹치지 않는
패널로 분리합니다. 저해상도 입력은 최대 4배의 분석용 래스터에서 끊어진
축선의 짧은 간격만 복원하고 원본 좌표로 되돌려 크롭합니다. 각 패널은 기존
축·격자·라벨 제거와 비정규 Curve 선택을 독립 실행하고 화면 탭에서 별도
검색 결과를 보여줍니다. 화면·여러 파일·폴더 학습에서도 분리된 차트마다
독립 후보와 크롭 원본 미리보기를 저장합니다. 축 모양의 사각형이 있더라도
내부에 연속된 분포 Curve가 없으면 표·플로우차트·사진 영역으로 판정해
제외하고, API는 제외 건수를 `rejectedNonChartCount`로 반환합니다.
PPT 카드 안에 플롯이 들어 있는 경우에는 실제 내부 플롯의 경계 증거를
우선하며, 패널 위치 검출 후 원본 해상도 크롭에서 Curve를 다시 분석합니다.
FHD 1920×1080 입력은 축소하지 않아 3–4px의 좁은 차트 간격과 가는
프레임을 원본 해상도에서 보존합니다.
각 차트 탭은 `선택 원본 패널`과 `정규화 추출 Curve`를 나란히 보여주고,
검출/관측 State, peak·valley, 축 방식과 Curve 검증 근거를 함께 표시합니다.
호스팅 버전은 분석만 할 때 입력 원본 이미지를 서버로 전송하지 않습니다.
공유 동의 후 `공용 학습에 등록` 버튼을 누르면 추출한 256-point Curve,
descriptor, 파일명·메타데이터를 제거하고 JPEG로 다시 만든 원본 미리보기를
공용 학습 저장소에 등록합니다. 서버가 축 없는 표준 그래프를 별도로
생성하며, 등록 후보는 다른 사용자의 검색에도 즉시 포함되고 추천 시
표준 Curve와 학습 원본 미리보기가 함께 표시됩니다.
공용 후보는 500개씩 cursor page로 조회하며 전체 2,000개까지 모두 합쳐
검색하므로 오래된 등록 그림도 다른 사용자의 결과에서 누락되지 않습니다.
추천 결과의 `유사/비유사` 판정도 별도 동의 후 익명 공용 라벨로 제출할 수
있습니다. Query와 평가자 코드는 서버에서 해시하고, 복수 평가자의 합의
판정만 재학습 데이터로 집계합니다.

## Windows 무설치판과 Ubuntu 외부 Web 서버판

`artifacts/windows/vth-similarity-windows-x64-v1.33.0.zip`은 공식
Windows x64 Node 런타임, 웹 빌드, 로컬 학습 API를 함께 담습니다. 다른
Windows PC에서 압축을 푼 뒤 `start.bat`을 실행하면 설치 없이
`http://127.0.0.1:4173`에서 동작합니다. 코퍼스, 모델, 웹 화면, 런타임이
모두 포함된 완전 독립판이며 외부 서버와 통신하지 않습니다. 브라우저 CSP도
`connect-src 'self' blob:`로 제한해 같은 PC의 API와 브라우저 내부 원본
읽기만 허용합니다. 화면에서 학습한 표준 Curve와
파일명·메타데이터를 제거한 원본 미리보기, 로컬 API로 적재한 사내 전용
이미지는 패키지의 `data/`에만 영속 저장되고 해당 PC의 다음 검색부터
후보로 포함됩니다. 학습 후보가 추천되면 표준 Curve와 원본 미리보기를
함께 표시합니다. 화면에서 여러 파일 또는 폴더를 선택하면 폴더 안의 지원
이미지를 개수 제한 없이 순차 분석해 학습합니다. 포함된 Node 런타임은 첫
실행 때 Windows 기본 `tar.exe`로 패키지 내부에 자동 해제됩니다.
학습 패널의 `데이터 관리` 탭에서는 저장된 전체 후보를 검색·미리보기하고,
체크박스로 여러 항목을 선택해 한 번에 삭제할 수 있습니다.
FHD 한 이미지에서 오밀조밀하게 배치된 차트를 최대 30개까지 좌표별로
분리하며, 30개를 초과하면 신뢰도가 높은 30개를 선택한 뒤 행 우선 순서로
반환합니다. 패키지에는
기존 3행×4열 12차트 PPT 샘플과 함께, 좌표가 불규칙한 차트에 표·도형·
사진성 블록을 섞은 고해상도 2장과 저해상도 1장, 프레임과 축 없이 Curve만
불규칙하게 놓인 차트 전용 1장, 1920×1080 안에 5행×6열 차트 30개와
비차트 방해 요소를 함께 배치한 FHD 밀집 샘플을 포함합니다. 화면의
`랜덤 멀티 차트 분석`은 이 다섯 샘플 중 직전과 다른 이미지를 골라
실행하며, 다섯 다운로드 링크로 각 원본을 받을 수 있습니다. 패키지 검증기는
혼합 샘플에서는 차트만 남고
비차트 후보가 제외되는지, 차트 전용 샘플에서는 경계 없는 Curve 8개가
각각 분리되는지, FHD 밀집 샘플에서는 30개가 모두 분리되는지 확인합니다.
`가변 크기` 샘플에는 면적 차이가 큰 차트와 소형 단일 봉우리 차트를 함께
넣어 동일 이미지에서도 크기나 봉우리 수와 무관하게 패널을 분리합니다.

Ubuntu x64는 여러 사용자가 접속하는 외부 Web 서버용 독립 배포본입니다.
운영 페이지 상단에서 Windows의 `WINDOWS X64 · FULL OFFLINE` 버튼과
Ubuntu의 `UBUNTU X64 · WEB SERVER` 버튼을 구분해 제공합니다.
Node.js나 npm을 설치하지 않고 `.tar.gz`를 풀어 `./start.sh`를 실행하면
기본적으로 `0.0.0.0:4173`에서 수신합니다. 서버가 표시한
`http://<Ubuntu 서버 IP>:4173/?access_token=...` URL을 다른 PC에서
처음 한 번 열면 접근 키를 HttpOnly·SameSite 쿠키로 전환하고 주소창에서는
즉시 제거합니다. `VTH_API_KEY`로 고정 키를 지정한 API 클라이언트는
`x-api-key` 또는 Bearer 헤더를 사용할 수 있습니다.

패키지에는 `vth.env.example`과 선택형 `install-systemd.sh`도 포함합니다.
인터넷에 공개할 때는 4173 포트를 직접 노출하지 말고 UFW와 TLS 리버스
프록시를 사용하며, 실제 브라우저 주소는
`VTH_PUBLIC_URL=https://...`로 지정합니다. 접속한 사용자는 같은
`data/` 학습 저장소와 추천 후보를 공유하지만 외부 공용 서버로 원본이나
학습 데이터를 전송하지 않습니다.

v1.33.0 웹 배포는
`/downloads/windows-package-v1.33.0.json`과
`/downloads/ubuntu-package-v1.33.0.json`을 고정 매니페스트 경로로
사용합니다. 두 매니페스트 모두 schema-v1 `browser-assembled` 계약과
SHA-256 조각 목록을 제공하며 브라우저는 각 조각과 완성 파일을 검증한 뒤
저장합니다. Windows 결과물은 ZIP이고 Ubuntu는
`vth-similarity-ubuntu-x64.tar.gz`를 우선 사용합니다. 매니페스트가 검증된
Ubuntu ZIP을 선언하는 경우에도 같은 공통 조립기가 확장자를 보존합니다.
Windows 패키지 내부에는 다운로드 자산을 다시 넣지 않아 재귀 패키징을
방지합니다.

주요 API는 다음과 같습니다.

- `GET /api/v1/health`: 서비스와 ready/pending 개수 확인
- `GET /api/v1/runtime`: 완전 오프라인 정책과 번들 포함 상태 확인
- `POST /api/v1/similarity-search?topK=5`: PNG/JPEG를 받아 순위별 유사
  그림 URL, 종합 점수, 세부 형상 점수와 유사 이유를 차트 패널별로 반환
- `POST /api/v1/training-images`: 원본 PNG/JPEG/WEBP 적재
- `POST /api/v1/training-samples`: 이미지와 256-point Curve/descriptor를
  함께 넣어 즉시 검색 가능한 후보로 등록
- `GET /api/v1/training-samples`: 검색 가능한 학습 후보 조회
- `GET /api/v1/training-export`: ready/pending 메타데이터 내보내기
- `GET /api/v1/openapi.json`: OpenAPI 3.1 문서

호스팅 공용 학습 API 문서는
`https://dove9999.com/shared-training-openapi.json`에서 제공합니다.
외부 시스템용 검색 API는 호스팅과 로컬 패키지에서 같은
`POST /api/v1/similarity-search` 계약을 사용합니다. 호스팅 계약은
`https://dove9999.com/similarity-search-openapi.json`에서 확인할 수
있습니다. PNG/JPEG 원본 바이트, multipart 파일 또는 Base64 data URL을
받고 기본 8개(최대 10개)를 반환합니다. 점수는 0~1 범위의 형상 유사도이며
확률을 뜻하지 않습니다. 검색 입력은 학습 데이터로 저장되지 않습니다.
다중 차트 응답의 `panelCount`, `panelLayout`, `panels[]`에는 행 우선 순서의
좌표·검출 신뢰도·패널별 Query와 결과가 들어가며, 최상위 `query/results`는
기존 클라이언트 호환을 위해 첫 번째 패널을 유지합니다.
공용 API는 Curve와 descriptor를 검증해 D1에 저장하고, 서버가 생성한 축
없는 표준 그래프와 브라우저가 파일명·메타데이터를 제거해 다시 만든 JPEG
원본 미리보기를 R2에 분리 저장합니다.
동일 Curve fingerprint는 하나로 합치고, 하루 등록 제한과 업로더 전용 삭제
토큰을 적용합니다.

공용 relevance API는 schema-v3 판정을 D1에 영구 저장합니다.
`GET /api/v1/shared-relevance-health`에서 report·판정·합의 준비 Query 수를
확인하고, `POST /api/v1/shared-relevance-reports`로 익명 판정을 제출하며,
`GET /api/v1/shared-relevance-export`로 재학습용 report를 내보냅니다.
원본 이미지·파일명·사용자가 입력한 Query/평가자 코드는 저장하지 않습니다.

원본 이미지만 로컬 API로 넣으면 `pending` 상태로 안전하게 쌓입니다.
Curve/descriptor를 로컬 API에 함께 전달하면 `ready`가 되어 해당 PC의
검색 후보에 포함됩니다. `VTH_API_KEY` 환경 변수를 설정하면 변경 API에
`x-api-key` 또는 Bearer 인증을 적용할 수 있습니다.

## 현재 구현 범위

### 오프라인

```text
비대칭·폭·꼬리가 다른 임의 VTH 분포 생성
  → State별 원본/중복 제거 Curve를 NPZ로 저장
  → log10 y축의 무축 PNG·SVG와 축/색/채움/노이즈 변형 PNG 생성
  → 256×128 표준 Curve 이미지로 정규화
  → 이미지 3,200차원 + 로그 Curve 384차원 특징 생성
  → 변형 이미지 query와 원본 수치 Curve를 같은 분포 positive pair로 학습
  → 브라우저 추출 Curve와 원본 수치 Curve를 공통 4차원 dual 공간으로 학습
  → SQLite 벡터 인덱스에 이미지·Curve·설명 특징 저장
```

### 온라인

```text
사용자 PNG/JPEG 입력
  → 기울기 보정 및 그래프 프레임 검출
  → 축·눈금·격자·텍스트 제거
  → 색/채움 여부와 무관한 표준 Curve로 변환
  → State 수·위치·폭·valley·tail 분석 및 2/4/8/16-State 보정
  → 3,200차원 표준 이미지 + 384차원 Curve 벡터 1차 검색
  → 샘플 중복 제거 및 pairwise + dual Curve + 이미지 합의 재정렬
  → Top 5~10 이미지·점수·유사 이유 출력
  → 사용자 동의 시 표준 Curve와 원본 미리보기를 공용 서버에 등록
  → 다른 사용자의 후보로 노출하고 추천 카드에 두 이미지를 함께 표시
```

State 중복 제거는 각 x 위치에서 가장 큰 State만 유지하는
`dominant-state-only` 정책을 사용합니다. 원본 Curve는 손실 없이 함께
보관합니다.

## 설치

현재 Mac의 Python 3.9.6에서도 실행되도록 구성되어 있습니다.

```bash
cd v-nand-distribution-similarity-search
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
```

## 전체 데모

2/4/8/16-State별 분포와 변형 이미지를 생성한 뒤 인덱싱, 학습, 외부
쿼리 검색을 수행합니다.

```bash
.venv/bin/vnand-similarity --root . demo \
  --samples 12 \
  --variants 3 \
  --states 2,4,8,16 \
  --top-k 5
```

주요 결과:

- `data/processed/corpus/raw/`: 원본 VTH 수치와 State Curve
- `data/processed/corpus/images/`: PNG 원본·변형
- `data/processed/corpus/svg/`: SVG 원본
- `data/processed/corpus/standardized/`: 축을 제거한 표준 Curve
- `artifacts/vectors.sqlite`: 로컬 벡터 인덱스
- `artifacts/pairwise-reranker.joblib`: 재정렬 모델
- `artifacts/search/results.json`: 추천 점수와 유사 이유
- `artifacts/search/recommendations.png`: Top-K 비교 이미지

## 단계별 실행

```bash
# 1. 합성 코퍼스 생성
.venv/bin/vnand-similarity --root . generate \
  --samples 100 --variants 4 --states 2,4,8,16 --seed 42

# 2. 이미지/Curve 특징 추출 및 인덱싱
.venv/bin/vnand-similarity --root . index

# 3. 동일 분포 변형 pair 기반 재정렬 모델 학습
.venv/bin/vnand-similarity --root . train

# 4. 실제 그래프 검색
.venv/bin/vnand-similarity --root . search \
  /absolute/path/to/query.png --top-k 8

# 5. DB에 넣지 않은 새 변형으로 Top-K 평가
.venv/bin/vnand-similarity --root . evaluate

# 6. 익명화한 실제 이미지 CSV의 중복·로그 범위·라벨 사전 검증
.venv/bin/vnand-similarity --root . validate-real \
  /absolute/path/to/real-images.csv

# 7. 검증된 실제 이미지로 전처리·relevance 평가
.venv/bin/vnand-similarity --root . evaluate-real \
  /absolute/path/to/real-images.csv --top-k 10

# 8. 웹에서 내려받은 schema-v3 복수 전문가 판정 검증·합의 집계
.venv/bin/vnand-similarity --root . ingest-feedback \
  /absolute/path/to/vth-feedback-*.json

# 공용 서버 export도 같은 명령에서 report별로 안전하게 분리·집계
curl -o /absolute/path/to/shared-relevance-export.json \
  https://dove9999.com/api/v1/shared-relevance-export
.venv/bin/vnand-similarity --root . ingest-feedback \
  /absolute/path/to/shared-relevance-export.json

# 9. 동의받아 서버에 저장된 모든 공용 Curve를 3개 안전 변형으로 만들고
#    원본 이미지를 내려받지 않은 채 기존 SQLite 벡터 DB에 증분 반영
.venv/bin/vnand-similarity --root . sync-shared-training \
  --index artifacts/vectors.sqlite

# 10. 합성 pair와 실제 전문가 합의 pair를 함께 사용해 재정렬기 학습
.venv/bin/vnand-similarity --root . train \
  --feedback /absolute/path/to/vth-feedback-*.json \
  --feedback-weight 4 \
  --min-feedback-pairs 20

# 11. 운영 합의 라벨을 Query 단위 train/heldout으로 자동 분리하고,
#     전문가·합성 회귀 게이트를 모두 통과할 때만 모델 승격
.venv/bin/vnand-similarity --root . retrain-shared \
  --index artifacts/vectors.sqlite \
  --baseline-model artifacts/pairwise-reranker.joblib \
  --candidate-model artifacts/pairwise-reranker-shared-candidate.joblib \
  --corpus data/processed/corpus

# 충분한 합의가 쌓이고 모든 게이트가 통과한 실행에서만 --promote 사용
.venv/bin/vnand-similarity --root . retrain-shared --promote

# 12. 수동 held-out Query로 기존/후보 모델 승격 판정
.venv/bin/vnand-similarity --root . compare-models \
  artifacts/pairwise-reranker.joblib \
  artifacts/pairwise-reranker-candidate.joblib \
  /absolute/path/to/heldout/vth-feedback-*.json

# 13. 브라우저가 실제로 복원한 Curve와 원본 수치 Curve의 학습 pair 생성
NODE_BIN=/absolute/path/to/node
$NODE_BIN web/scripts/export-dual-training-pairs.mjs \
  data/processed/corpus-expanded/manifest.jsonl \
  artifacts/evaluation-expanded-retrieval-calibrated-v2/queries \
  artifacts/dual-browser-training-pairs.json

# 14. 공통 Curve 공간 학습 및 외부 이미지 품질 게이트 감사
.venv/bin/vnand-similarity --root . train-embedding \
  --index artifacts/vectors-expanded.sqlite \
  --model artifacts/dual-curve-encoder.joblib \
  --browser-model artifacts/dual-curve-encoder.browser.json \
  --browser-pairs artifacts/dual-browser-training-pairs.json \
  --domain-reports artifacts/dual-domain-calibration/public.json \
    artifacts/dual-domain-calibration/measured.json \
  --domain-weight 4 \
  --reranker artifacts/pairwise-reranker-expanded.joblib \
  --validation-queries artifacts/evaluation-expanded-retrieval-calibrated-v2/queries \
  --encoder-kind nonlinear --dimensions 4 \
  --hidden-dimensions 8 --mlp-alpha 0.01 --rerank-limit 2

.venv/bin/vnand-similarity --root . audit-embedding \
  artifacts/dual-curve-encoder.joblib \
  artifacts/dual-encoder-validation/public.json \
  artifacts/dual-encoder-validation/measured.json \
  artifacts/dual-encoder-validation/user.json \
  --browser-model artifacts/dual-curve-encoder.browser.json
```

## 원본 데이터 포맷

각 `.npz` 파일은 다음 배열과 메타데이터를 포함합니다.

- `x`: 정규화 전압 축
- `state_curves`: 중복 제거 전 State별 분포
- `exclusive_curves`: State간 중복 제거 후 분포
- `composite_curve`: 검색용 전체 윤곽
- `metadata`: 중심, 폭, 높이, skew, shoulder, 중복량, 로그 축 범위

원본/전처리 데이터와 모델 산출물은 기본적으로 Git에서 제외됩니다.

## 검증

```bash
.venv/bin/ruff check src tests
.venv/bin/pytest -q
```

현재 자동 테스트는 합성 재현성, State 중복 제거, 축 포함 이미지 정규화,
특징 차원, 벡터 검색, 전체 파이프라인을 검증합니다.

State 수 분석은 원시 peak count와 V-NAND 도메인 규칙으로 보정한
2/4/8/16-State count를 모두 기록합니다. 따라서 자동 보정 성능과 순수
영상 검출 성능을 분리해 평가할 수 있습니다.

현재 2/4/8/16-State 혼합 코퍼스의 인덱스에 없는 미등록 로그 그래프
192장을 고정 seed로 검증한 결과는 Top-1 `146/192`(76.0%),
Recall@5 `172/192`(89.6%), Recall@10 `181/192`(94.3%), 보정 State
count `181/192`(94.3%)입니다. sample ID가 다르더라도 원본 수치 Curve가
사실상 같은 분포일 수 있으므로, 같은 State의 원본 Curve cosine
상위 5개를 graded relevance로 삼는 형상 평가도 함께 기록합니다. 형상
Top-1 neighbor accuracy는 `82.8%`, neighbor Recall@5/10은
`55.5%`/`75.3%`, nDCG@5/10은 `86.5%`/`87.0%`입니다. 이는 합성 검증
결과이며 실제 장비 이미지 성능을 의미하지는 않습니다.

공개 로그 그래프 회귀 세트는 서로 독립적인 논문·특허 4개 출처의
2/4/16-State 패널과 렌더링 변형을 합친 16장입니다. 전처리 `16/16`,
State label이 있는 이미지 `15/15`, 같은 패널 변형 Top-1 `13/15`,
Recall@5 `13/15`, Recall@10 `14/15`를 기록했습니다. 운영 인덱스 검색은
State가 검출된 15개 질의 모두에서 Top-10 후보의 State가 일치했고 유사 이유가
모두 생성됐습니다. 출처는 전부 시뮬레이션 또는 특허 도식이며 실제 장비
데이터가 아닙니다. 출처와 로그 축 근거는
[공개 검증 출처](docs/public-validation-sources.md)에 정리했습니다.

실측 로그 회귀 세트는 실제 1X-nm MLC NAND 칩 측정 marker와 모델 선이
함께 있는 논문 4개 패널, 상용 TLC의 fresh/열화 측정 histogram을 겹쳐
표시한 기술 보고서 1개 패널, 3D QLC의 16-State cell-count를 측정한 IBM
IRPS 2020 논문 1개 패널로 구성됩니다. 원본/리사이즈/흑백 JPEG 변형을
합쳐 총 18장입니다. 전처리와 물리 State 판별은 `18/18`, 같은 패널 변형
Top-1은 `17/18`(94.4%), Recall@5/10은 모두 `18/18`입니다. 운영
인덱스 Top-1과 Precision@5/10의 State 및 유사 이유도 전부 일치합니다.

브라우저 전체 경로 역시 `18/18`을 통과했습니다. TLC 패널은 물리적으로
8-State지만 원문에서 erase S0를 제외해 S1~S7만 보이므로
`state_count=8`, `observed_state_count=7`, `state_coverage=partial`로
보존합니다. 새 IBM 16-State 패널은 변형 간 최소 프로필 유사도 `0.988`,
동일한 Top-1 후보, Top-5/10 후보 집합 최소 중복률 `0.6`/`0.8`을
기록했습니다. 독립 실측 출처가 3개가 되어 출처 등록부와 이미지 매니페스트의
도메인 보정 품질 게이트는 `ready_for_domain_calibration=true`입니다.
이는 공개 실측 논문 이미지 보정 기준 통과이며 사용자 장비 일반화 완료를
뜻하지 않습니다.

공개 후보의 실측 여부·native-log y축·multi-State 분포·공개 원문·데이터
독립성은
[출처 판정 레지스트리](docs/source-disposition-registry.csv)로 별도
감사합니다. 선형 y축 실측 자료는 stress-only로 활용할 수 있지만 보정
출처 수를 늘리지 않으며, 같은 측정 데이터의 재출판도 독립 출처로 세지
않습니다.

운영 브라우저 코퍼스는 192개 고유 합성 형상 중 State별 24개씩 96개를
선별하고, `vnand_fault_distributions_100` 폴더의 fault 분포 100장을
같은 이미지 전처리기로 추출해 더한 총 196개입니다. 합성 후보는 기존
48개를 보존하고 나머지는 Curve와 1·2차 기울기의
farthest-shape coverage로 선택합니다. 48개 기준 대비 96개 선택셋의
최악 nearest-shape cosine은 2/4/8/16-State에서 각각
`0.516→0.975`, `0.606→0.863`, `0.526→0.740`, `0.646→0.799`로
개선됐습니다. 확장 1,280쌍 교차 검증에서는 기존 재정렬기가 새 모델보다
AUC가 근소하게 높아(`0.8323` 대 `0.8318`) 기존 가중치를 유지했습니다.
근접 Curve를 무조건 negative로 취급하지 않는 graded hard-negative
후보도 별도로 검증했지만 exact Top-1과 형상 nDCG가 함께 낮아져 승격하지
않았습니다. 대신 기존 재정렬 점수 `70%`와 원시 이미지/Curve 검색 점수
`30%`를 결합한 보정을 채택했습니다. 보정 전 대비 exact Top-1은
`75.0%→76.0%`, Recall@10은 `93.2%→94.3%`, 형상 Top-1은
`81.3%→82.8%`, 형상 nDCG@10은 `86.6%→87.0%`로 개선되고
Recall@5와 형상 Recall@10은 유지됐습니다.

브라우저에서 복원한 Curve와 원본 수치 Curve를 같은 공간으로 맞추는
4차원 PCA + 8-unit tanh 비선형 dual Curve encoder도 추가했습니다.
`sample_id` 기준 144개 학습/48개 검증 분리에서 Top-1은
`66.7%→70.8%`, MRR은 `0.768→0.789`로 개선됐고 Recall@5/10은
`93.8%`/`97.9%`로 유지됐습니다. 기존 Top-K 후보 집합을 훼손하지
않도록 1차 결과의 상위 2개 안에서만 8% 가중치로 순서를 조정하고,
Curve cosine 0.995 이상의 사실상 동일 형상은 고정합니다. 공개 도식 15장, 독립 실측
18장, 도메인 보정에 넣지 않은 사용자 peak–valley 3장까지 브라우저 전체
경로 품질 게이트를 모두 통과한 모델만 웹 인덱스로 승격합니다.

실이미지 매니페스트는 평가 전에 파일·ID 중복, 로그 축과 동적 범위,
물리/관측 State 범위, 유사도 그룹, 독립 출처와 실측 여부를 검증합니다.
웹 schema-v3
전문가 보고서는 원본 이미지·파일명 없이 8개 pair similarity 특징과
`similar`/`dissimilar` 라벨, 익명 Query/평가자 코드만 저장합니다. 같은
query/candidate에 대한 복수 평가자의 판정은 보존되고, 다수결 합의를 학습
라벨로 사용하며 동률은 제외합니다.

재학습 시 실제 합의 pair는 기본 4배 가중치로 합성 pair와 결합되고 query ID
단위로 train/validation을 분리합니다. 최소 20 pair, 두 라벨, 독립 query
3개가 필요합니다. 운영 승격은 별도 held-out Query에서 복수 평가자 합의율
75% 이상과 AUC·정확도·log-loss 비열화 가드를 통과한 후보만 허용합니다.

## 다음 반복

1. 실제 장비/보고서/스크린샷 이미지를 익명화해 전처리 실패 유형을 수집합니다.
2. TLC 8-State 외에 MLC 4-State, QLC 16-State를 분리 평가합니다.
3. 실제 장비 pair가 확보되면 현재 소형 비선형 query encoder를
   end-to-end contrastive image/Curve two-tower와 비교합니다.
4. Recall@K, 같은 원본 변형 Top-1, 전문가 relevance 평가셋을 만듭니다.
5. 코퍼스가 커지면 SQLite exact search를 FAISS/Qdrant ANN으로 교체합니다.
6. 실제 장비 Query를 두 명 이상이 독립 평가해 schema-v3 합의셋을 채웁니다.

세부 설계와 교체 지점은 [docs/architecture.md](docs/architecture.md)에 정리되어
있습니다. 실제 그래프의 권장 형식과 익명화 기준은
[docs/real-data-intake.md](docs/real-data-intake.md)를 참고하세요.
