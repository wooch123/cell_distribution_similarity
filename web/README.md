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
별도 Query와 Top-K를 반환합니다. 저해상도 입력은 최대 4배의 분석용
래스터에서 끊어진 축선의 짧은 간격만 복원하고, 검출 좌표를 다시 원본
좌표로 환산해 크롭·검색·학습합니다. 기존 연동을 위해 최상위 `query`와
`results`는 첫 번째 패널을 그대로 가리킵니다. 한 이미지당 최대 24개를
분석하며, 초과 시 신뢰도가 높은 24개를 선택하고
`panelDetection.truncated`로 알립니다. 프레임 후보 안에 긴 수평 Curve,
충분한 y 변화량과 연속 경로가 함께 있는지도 검사해 표, 플로우차트, 사진
영역은 검색 패널에서 제외하며 제외 수는
`panelDetection.rejectedNonChartCount`로 반환합니다.

```bash
curl -X POST \
  "https://dove9999.com/api/v1/similarity-search?topK=5" \
  -H "Content-Type: image/png" \
  --data-binary "@vth-graph.png"
```

Raw 이미지 외에도 `multipart/form-data`의 `image` 파일과
`application/json`의 Base64 `imageDataUrl`을 받을 수 있습니다. 전체
계약과 오류 코드는 `/similarity-search-openapi.json`에서 확인합니다.
동일 엔드포인트와 계약은 Windows 패키지의 로컬 서버에도 포함됩니다.

## 개인정보 처리

검색만 할 때 업로드 원본 이미지는 서버에 저장하거나 전송하지 않습니다.
브라우저의 Canvas에서 사각 프레임 또는 특허 도면의 열린 L자 축을 검출하고,
축·격자·내부 수직 기준선·분리된 텍스트 라벨을 제거한 뒤 Curve를 추출합니다.
서로 떨어진 프레임/L축이 두 개 이상이면 먼저 좌표별 차트로 크롭하고 화면의
차트 탭에서 각각의 검색 결과를 전환합니다. 학습 시에는 각 크롭을 별도
후보와 별도 원본 미리보기로 저장합니다.
입력 영역의 `랜덤 멀티 차트 분석`은 매번 서로 다른 임의 배치 샘플을
선택합니다. 고해상도 2장과 저해상도 1장은 차트 외에 표·플로우차트·사진성
블록을 함께 포함하며 `샘플 1`, `샘플 2`, `저해상도` 링크로 각각 내려받을
수 있습니다. 기존 3행×4열 12차트 검증 PNG도
`/samples/vnand-ppt-12-chart-sample.png`에 유지합니다. 바깥 PPT 카드와 실제 차트가
겹쳐 보일 때는 내부 플롯의 경계 증거를 우선하고, 위치 검출 후 원본 해상도
크롭에서 Curve를 다시 분석합니다. 차트 탭에는 `선택 원본 패널`과
`정규화 추출 Curve`를 나란히 표시하고 검출/관측 State, peak·valley,
축 방식과 Curve 검증 근거를 함께 제공합니다. 샘플은
기존 12차트 샘플은 `node scripts/generate-ppt-multichart-sample.mjs`,
임의 배치 혼합 샘플은
`node scripts/generate-random-multichart-samples.mjs`로 재생성합니다.
같은 샘플과 무작위 배치·저해상도 복원을 포함한 최대 24차트 분리기는
Windows v1.29.0 완전 독립판에도
함께 포함됩니다.
추출 결과는 함께 배포된 읽기 전용 코퍼스와 로컬로 비교합니다.
격자는 실선과 점선의 긴 수평·수직 run을 함께 검출하며, 삭제 후 Curve가
양쪽에서 이어지는 교차 픽셀만 복원해 peak·valley 단절을 줄입니다.

사용자가 명시적으로 공유 동의하고 `공용 학습에 등록`을 누르면 256-point
Curve와 descriptor를 D1에, 축 없는 표준 그래프와 파일명·메타데이터를
제거해 브라우저에서 다시 만든 JPEG 원본 미리보기를 R2에 저장합니다.
등록 후보는 다른 사용자의 검색에도 합쳐지고, 추천 시 표준 Curve와 학습
원본 미리보기를 함께 표시합니다. 동일 형상은 fingerprint로 중복 제거하고
하루 200개 제한, 전체 2,000개 제한, 업로더 전용 삭제 토큰을 적용합니다.
파일 여러 장 또는 폴더 하나를 선택하면 그 안의 지원 이미지를 개수 제한
없이 순차 분석·학습하고 신규·중복·실패·제외 건수를 화면에 집계합니다.
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
