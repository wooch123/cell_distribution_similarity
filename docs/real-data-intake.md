# 실제 VTH 그래프 검증 데이터 투입 규격

합성 데이터 성능은 실제 장비·보고서·스크린샷 성능을 보장하지 않습니다.
다음 반복은 익명화한 실제 그래프를 이용해 전처리와 검색 품질을 측정합니다.

## 최소 파일

첫 검증에는 PNG/JPEG 그래프 10장 이상을 권장합니다. 빠른 전처리 점검만
할 때는 서로 다른 스타일의 3장으로도 시작할 수 있습니다.

- y축이 `log10`인 VTH Cell 분포 그래프
- 축과 숫자가 포함된 스크린샷
- Curve만 잘라낸 이미지
- Line/Fill/서로 다른 색상 표현
- 밝거나 어두운 배경
- 가능하면 동일 분포를 다른 스타일로 그린 이미지 pair

원본 VTH 수치 CSV/NPZ가 있다면 함께 제공하는 것이 좋지만 필수는 아닙니다.
현재 온라인 경로는 이미지 한 장만으로 작동합니다.

현재 합성 인덱스의 y 범위는 `10^-6 ~ 10^0`입니다. 실제 그래프도 이 범위면
그대로 투입할 수 있습니다. 범위가 다르면 축 숫자를 지워도 괜찮지만,
`10^-N ~ 10^M` 범위를 메타데이터로 알려주어 합성 데이터와 정규화 규약을
같이 맞춰야 합니다. 선형 y축 이미지는 로그 이미지와 분리해 주세요.

## 선택 메타데이터

파일명 또는 별도 CSV로 다음 정보를 주면 평가가 정확해집니다.

```text
image_path,image_id,state_count,observed_state_count,state_coverage,y_scale,y_min,y_max,similarity_group,product_group,notes
graph_001.png,Q-001,8,8,full,log10,1e-6,1,A,anonymous-product-1,line plot
graph_002.png,Q-002,8,8,full,log10,1e-6,1,A,anonymous-product-1,filled plot
graph_003.png,Q-003,8,7,partial,log10,1e-6,1,B,anonymous-product-1,erase State excluded
```

같은 형식의 시작 파일은
[real-image-manifest.example.csv](real-image-manifest.example.csv)에 있습니다.
이미지 경로는 CSV 파일이 있는 폴더를 기준으로 한 상대 경로나 절대 경로를
사용할 수 있습니다.

- `state_count`: 2/4/8/16 또는 실제 State 수
- `observed_state_count`: 그림에 실제로 보이는 State 수. 예를 들어 TLC에서
  erase State를 제외한 그림은 `state_count=8`, `observed_state_count=7`
- `state_coverage`: `full`, `partial`, `unknown`. 열을 생략하면 State 수가
  같을 때 `full`, 다를 때 `partial`로 추론
- `image_id`: 제품·lot 정보가 없는 익명 Query ID
- `y_scale`, `y_min`, `y_max`: 로그 종류와 표시 동적 범위
- `similarity_group`: 같은 분포/유사 분포를 묶는 익명 ID
- `product_group`: 서로 검색되면 안 되는 제품군의 익명 ID
- `notes`: tail, shift, width, 비대칭 등 전문가 판단

공개 자료처럼 provenance를 추적해야 할 때는 `source_id`, `source_url`,
`figure_id`, `source_kind`, `independence_group`, `is_measured` 열을 추가할
수 있습니다. 평가 보고서는 독립 출처 수와 실제 측정 여부를 보존합니다.

## 익명화

- 제품명, lot, wafer, die, 장비, 작업자 정보는 제거하거나 익명 ID로 바꿉니다.
- 보고서 전체가 아니라 그래프 영역만 제공해도 됩니다.
- 이 프로젝트의 `data/raw/`, `data/processed/`, `artifacts/`는 Git 추적에서
  제외되어 있습니다.
- 절대 VTH 값이 민감하면 축 숫자를 지워도 현재 형상 검색에는 영향이 없습니다.

## 실제 데이터 품질 게이트

1. 그래프 영역 추출 성공률
2. 축·문자 잔존율
3. 보정 전/후 State count 정확도
4. 전문가 relevance 기준 Recall@5와 Recall@10
5. 동일 분포의 다른 스타일 Top-1 정확도
6. 오추천 hard negative의 폭·tail·State 위치 차이 분석

10장 검증에서 전처리 실패 유형을 먼저 고친 뒤, 100장 이상에서 임베딩과
재정렬 모델을 다시 학습합니다.

## 평가 실행

먼저 파일 존재 여부, 중복 ID/경로, 로그 축·범위, State 라벨,
유사도 그룹, 독립 출처와 실측 여부를 한 번에 점검합니다.

```bash
.venv/bin/vnand-similarity --root . validate-real \
  /absolute/path/to/real-images.csv
```

`artifacts/real-intake/`에 정규화 CSV와 품질 게이트 JSON이 생성됩니다.
첫 검증 10장, 유사도 그룹 3개, 독립 출처 3개, 완전한 State/로그 범위,
실측 이미지 존재 여부를 각각 분리해 표시하므로 빠진 라벨을 검색 전에
보완할 수 있습니다. 오류가 있는 매니페스트는 실제 평가에서 거부됩니다.

```bash
.venv/bin/vnand-similarity --root . evaluate-real \
  /absolute/path/to/real-images.csv \
  --index artifacts/vectors.sqlite \
  --model artifacts/pairwise-reranker.joblib \
  --top-k 10
```

결과는 기본적으로 `artifacts/real-evaluation/`에 저장됩니다.

- `standardized/`: 축·수치·스타일을 제거한 표준 Curve
- `real-image-evaluation.json`: 전처리 성공률, State count 정확도,
  Top-1, Recall@5/10, MRR, 스타일 불변성, 운영 인덱스의 State precision,
  이미지별 추천과 유사 이유

`observed_state_count` 라벨은 그림에 포함된 물리 State 범위를 뜻합니다.
보고서의 `raw_peak_count_matches_manifest_observed_rate`는 여러 조건의 곡선이나
마커 때문에 생기는 보정 전 peak 후보와 이 라벨이 우연히 일치한 비율이며,
최종 State 판정 정확도와 구분해서 해석해야 합니다.

`similarity_group`이 같은 다른 이미지를 positive로 평가하며,
`product_group`이 서로 다르면 후보군에서 제외합니다. 원본 VTH 수치가
없어도 실제 스크린샷끼리 leave-one-image-out 평가를 수행할 수 있습니다.

## 웹 전문가 relevance 수집

배포 페이지에서는 실제 그래프를 검색한 뒤 각 후보를 `유사` 또는 `비유사`로
표시하고 `평가 JSON 저장`을 누를 수 있습니다. 가능하면 Top-10 전체를
평가하고, 공정·제품 지식을 가진 두 명 이상이 같은 질의를 독립적으로
판정합니다.

각 실제 그래프에는 제품명 대신 공유 가능한 익명 `Query 코드`를 부여합니다.
두 명의 평가자가 같은 그림을 판정할 때 같은 Query 코드를 사용하면
독립 판정이 한 쌍으로 묶입니다. 평가자 코드는 브라우저가 기기별 임의 값으로
생성하며, 같은 기기를 공유할 때는 서로 다른 익명 코드를 직접 입력할 수
있습니다. 이름이나 계정은 사용하지 않습니다.

내려받은 schema-v3 `vth-feedback-*.json`에는 다음 정보만 포함됩니다.

- 256-point 정규화 로그 형상과 State 위치·폭·valley·tail 특징
- 검출/보정 State 수와 축 검출 여부
- 후보 ID, 순위, 구성 점수, 유사 이유
- 전문가의 `similar`/`dissimilar` 판정
- 코퍼스와 재정렬기 버전
- 익명 Query 코드와 기기 범위의 익명 평가자 코드

원본 이미지, 원본 파일명, 제품명, 절대 VTH 수치, 브라우저 경로는 포함하지
않습니다. `privacy` 필드로 이 조건을 프로그램에서도 확인할 수 있습니다.
JSON과 원본 이미지를 연결해야 할 때는 보고서의 익명 `query.id`를 별도
보안 저장소의 매핑표에서만 관리합니다.

권장 수집 단위는 State별 독립 질의 25장 이상, 질의당 Top-10 판정입니다.
모델 재학습 전에는 동일 query ID가 train/validation 양쪽에 섞이지 않도록
그룹 분할해야 합니다.

수집 파일은 먼저 검증·중복 제거합니다.

```bash
.venv/bin/vnand-similarity --root . ingest-feedback \
  /absolute/path/to/vth-feedback-*.json
```

결과는 `artifacts/expert-feedback/`의 원본 익명 rating JSONL, 합의 pair
JSONL과 요약 JSON에 저장됩니다. 같은 평가자가 같은 query/candidate를
여러 번 판정하면 최신 값만 사용하지만 다른 평가자의 판정은 보존합니다.
다수결 합의를 학습 라벨로 사용하고 동률은 학습에서 제외합니다. 요약에는
평가자 수, 만장일치/다수결/동률 pair 수와 평가자 간 pairwise 합의율이
기록됩니다. 과거 schema-v2 파일도 계속 읽을 수 있습니다.

최소 20 pair, `similar`/`dissimilar` 두 클래스, 독립 query 3개가 모이면
합성 hard-negative pair와 함께 가중 재학습할 수 있습니다.

```bash
.venv/bin/vnand-similarity --root . train \
  --feedback /absolute/path/to/vth-feedback-*.json \
  --feedback-weight 4 \
  --min-feedback-pairs 20
```

실제 pair는 query ID 그룹으로 분리 검증하며 모델 metrics에는 실제 라벨의
training/validation accuracy·AUC가 합성 지표와 별도로 기록됩니다.

새 모델을 운영에 올리기 전에는 학습에 사용하지 않은 Query 코드의 평가
파일로 기존 모델과 비교합니다.

```bash
.venv/bin/vnand-similarity --root . compare-models \
  artifacts/pairwise-reranker.joblib \
  artifacts/pairwise-reranker-candidate.joblib \
  /absolute/path/to/heldout/vth-feedback-*.json
```

20개 이상의 합의 pair, 독립 Query 3개, 두 클래스, 복수 평가자 판정,
75% 이상의 평가자 간 합의가 있어야 승격 판단을 냅니다. AUC·정확도·
log-loss와 Query별 macro 성능의 비열화 가드를 모두 통과하고 실제 개선이
있을 때만 `promote-candidate`를 기록합니다.

운영 D1에 모인 판정을 자동으로 사용할 때는 다음 명령을 실행합니다.

```bash
.venv/bin/vnand-similarity --root . retrain-shared
```

현재 report가 없거나 합의가 부족하면 모델 파일을 건드리지 않고
`waiting-for-feedback`, `waiting-for-consensus` 또는
`waiting-for-splittable-consensus` 상태를 기록합니다. 최소 40개 합의
pair와 6개 Query가 있어야 독립 train/heldout을 만들 수 있으며, 실제
승격은 같은 명령에 `--promote`를 명시한 경우에도 모든 전문가·합성
회귀 게이트를 통과했을 때만 일어납니다.
