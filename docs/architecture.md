# 아키텍처 및 반복 개발 기준

## 검색에서 보존할 정보

- State 봉우리 개수
- 봉우리의 상대적 x 위치와 State 간 간격
- 각 봉우리의 상대 높이, FWHM 폭, 비대칭, shoulder, tail
- log10 y축에서 State 사이 valley 깊이와 양쪽 tail 기울기
- 전체 분포의 정규화 면적과 중심

## 검색에서 제거할 정보

- x/y축 숫자와 절대 단위
- 축 제목, 범례, 보고서 텍스트
- 색상, 배경, 격자, 선 굵기, 이미지 해상도
- 1~2도 수준의 캡처 기울기
- Line plot과 Filled plot의 표현 차이

입력 y축은 `log10`으로 가정합니다. 기본 동적 범위는 `10^-6 ~ 10^0`이고
축 숫자는 제거하되 로그 축에 나타난 상대적인 세로 형상은 보존합니다.
선형 y축 그림은 별도 변환 없이 현재 인덱스와 혼합하지 않습니다.

## 표준화 규약

입력 이미지는 다음 순서로 `256×128` Curve 마스크가 됩니다.

1. 이미지 테두리 색의 중앙값을 배경색으로 추정합니다.
2. 배경과의 RGB 거리를 이용해 그래프 foreground를 분리합니다.
3. 긴 수평선을 검출해 캡처 기울기를 보정합니다.
4. 그래프 프레임의 수평·수직선을 이용해 plot 내부를 자릅니다.
5. 긴 축·격자선과 작은 텍스트 컴포넌트를 제거합니다.
6. 채움 그래프와 선 그래프 모두 상단 envelope Curve로 변환합니다.
7. x 절대 범위와 y축 숫자를 버리고 로그 형상을 표준 해상도로 정규화합니다.

이 규약 덕분에 온라인 입력에는 실제 x/y 수치가 없어도 됩니다. 반대로 절대
VTH shift가 중요한 사용 사례에는 현재 표준화가 적합하지 않으므로, 추후
OCR/축 복원 경로를 별도 feature channel로 추가해야 합니다.

## 현재 특징

### 이미지 특징

- 표준 마스크 64×32 축소 표현
- 8×16 cell, 9방향 gradient histogram
- 총 3,200차원, L2 정규화

### Curve 특징

- 오프라인: NPZ `composite_curve`를 `log10(y)`로 변환한 원본 수치 Curve
- 온라인: 이미지에서 복원한 로그 축 envelope Curve
- 128-point 재표본화와 ±10-point x 이동 정렬
- 1차·2차 미분
- 총 384차원, L2 정규화

### 학습 Curve 임베딩

- 브라우저 전처리로 복원한 384차원 query Curve와 같은 `sample_id`의
  원본 수치 384차원 Curve를 positive pair로 사용
- 모든 렌더링 변형을 실제 브라우저 전처리 경로로 통과시켜 학습 입력 생성
- 공개 도식과 독립 실측 스타일 그룹을 domain calibration pair로 추가
- candidate는 PCA, query는 표준화된 8-unit tanh MLP projection을 학습
- 공통 4차원 단위 벡터에서 cosine 계산
- 기존 검색 상위 2개 안에서만 8% 가중치로 적용해 Top-5/10 후보 집합 보존
- Curve cosine 0.995 이상의 사실상 동일 형상은 학습 tie-break보다 우선

### 설명 특징

- State peak count
- 원시 peak count와 2/4/8/16-State 도메인 보정 여부·신뢰도
- peak location, height, prominence, FWHM
- State 사이 valley height와 양쪽 tail slope
- normalized area, center of mass, roughness

## 검색과 재정렬

1차 검색은 이미지 cosine `0.18`, Curve cosine `0.82` 가중 exact
search입니다.
후보는 같은 `sample_id`가 여러 변형 이미지로 반복되지 않도록 하나로
합칩니다.

재정렬기는 다음 pair 특징을 입력받는 가중치 비음수 제약 Logistic
Regression입니다.

- image cosine
- curve cosine
- peak count similarity
- peak location similarity
- peak width similarity
- area similarity
- valley similarity
- tail slope similarity

이미지에서 복원한 query 특징과 같은 원본 수치 Curve는 positive로
학습합니다. 다른 원본 Curve는 기본 학습에서 negative 후보가 되지만,
sample ID가 다르더라도 형상이 사실상 같은 경우가 있어 원본 Curve
상위-5 근접 이웃을 graded relevance로 별도 평가합니다.

재정렬 기본 점수는 Curve 형상을 우선하도록
`0.70 × aligned Curve cosine + 0.25 × model score + 0.05 × retrieval score`
로 결합한 뒤 peak–valley 관계 점수와 혼합합니다. 최종 검색 순서는 고정
홀드아웃 192장에 통과한 `0.70 × peak–valley 재정렬 점수 + 0.30 × 원시
retrieval score` 보정을 적용합니다.

그 위에서 승격된 dual Curve encoder가 상위 2개의 동점에 가까운 형상을
재정렬합니다. `sample_id` 기준 홀드아웃에서 Top-1과 MRR이 개선되고
Recall@5/10이 비열화되지 않아야 하며, 공개 15장·독립 실측 18장·학습에
사용하지 않은 사용자 peak–valley 3장 브라우저 회귀 세트를 모두 통과해야
운영 인덱스에 포함됩니다.

현재 비선형 dual encoder는 브라우저와 독립판에서 동일하게 실행되는
첫 학습 임베딩입니다. 실제 장비 pair와 전문가 relevance가 더 확보되면
image encoder와 1D Curve encoder를 함께 최적화하는 end-to-end
contrastive/metric-learning 후보를 같은 승격 게이트로 비교합니다.

## 반복별 품질 게이트

### 데이터

- 원본 수치와 렌더링 이미지의 연결이 깨지지 않아야 합니다.
- train/validation/test는 `sample_id` 기준으로 분리해야 합니다.
- 실제 제품/공정/lot 정보는 익명화하고 Git에 저장하지 않습니다.
- 실이미지 매니페스트는 중복, 로그 범위, State/유사도 그룹, 독립 출처와
  실측 여부를 평가 전에 검증해야 합니다.
- 전문가 판정은 익명 평가자별 원본 rating을 보존하고 query/candidate
  다수결 합의를 학습 라벨로 사용하며 동률을 제외해야 합니다.
- 공용 relevance report는 원본·파일명을 받지 않고 Query/평가자 코드를
  서버에서 해시해 D1에 저장합니다. 같은 Query·평가자의 재제출은 갱신하고,
  서로 다른 평가자의 판정은 합의 계산을 위해 모두 보존합니다.
- 공용 후보 동기화는 서버 생성 미리보기나 원본 사진을 내려받지 않고
  검증된 256-point Curve만 사용합니다. 후보당 축 없는 안전 변형 3개를
  만들며, 원격에서 삭제된 후보는 다음 동기화에서 공용 source 벡터만
  제거하고 합성·사내 벡터는 보존합니다.

### 전처리

- State peak count 정확도
- 보정 전 observed state count 정확도와 보정 적용률
- 축/문자 잔존율
- Line/Fill/Color 변형 간 표준 Curve 일치도

### 검색

- 동일 원본의 미등록 변형 Top-1 accuracy
- 전문가 relevance 기준 Recall@5, Recall@10
- 원본 수치 Curve 이웃 기준 neighbor Recall@5/10과 nDCG@5/10
- hard negative 순위와 오추천 유형
- 학습에 사용하지 않은 Query에서 기존/후보 모델의 AUC, accuracy,
  log-loss, Query macro 성능을 비교해야 합니다.

### 운영

- 검색 지연시간
- 인덱스 크기와 증분 갱신 시간
- 사용자 선택/비선택 피드백을 재학습 데이터로 연결
- 복수 평가자 합의율 75% 이상과 비열화 가드를 통과한 모델만 승격
- 운영 합의 라벨은 Query ID 단위로 train/heldout을 완전히 분리하고,
  각 분할에 20 pair·3 Query·두 클래스가 있어야 합니다. 전문가 AUC·
  accuracy·log-loss 게이트와 합성 Top-1/Recall/MRR/형상 nDCG 회귀
  게이트를 함께 통과해야 `--promote`가 기준 모델을 교체합니다.
- 공유 동의를 받은 표준 Curve만 D1 공용 후보로 저장하고 서버 생성 표준
  그래프는 R2에 저장
- 원본 사진·원본 파일명·클라이언트가 보낸 임의 이미지 바이트는 공용
  저장소에 저장하지 않음
- Curve fingerprint 중복 제거, 등록 제한, 업로더 전용 삭제 토큰 적용

## 교체 지점

- `synthetic.py`: 실제 물리/공정 기반 VTH simulator로 교체
- `imaging.py`: segmentation/curve tracing 모델로 교체
- `features.py`: CNN/ViT image encoder + 1D curve encoder로 교체
- `store.py`: FAISS/Qdrant/Milvus adapter로 교체
- `training.py`: contrastive, triplet, listwise reranker로 교체
- `pipeline.py`: API/배치 orchestration 계층에서 그대로 호출
