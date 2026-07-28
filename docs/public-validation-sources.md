# 공개 VTH 그래프 검증 출처

`artifacts/real-multisource-validation`은 축·수치·선 스타일이 서로 다른 공개
로그 스케일 VTH 그래프에서 전처리와 검색 동작을 회귀 검증하기 위한 세트다.
원본 수치나 실제 장비 로그가 아니라 공개 논문·특허의 시뮬레이션 또는
도식이므로 실제 장비 일반화 성능으로 해석하지 않는다.

## 핵심 로그 스케일 세트

| Source | Figure | State label | Evidence | Kind |
| --- | --- | ---: | --- | --- |
| [Springer DOI 10.1007/s10825-025-02459-3](https://link.springer.com/article/10.1007/s10825-025-02459-3/figures/14) | Fig. 14 top/bottom | 16 | QLC coarse/fine simulator result | Simulator publication |
| [US20130163342A1](https://patents.google.com/patent/US20130163342A1/en) | Fig. 1 | 4 | Erase/A/B/C distributions and a log cell-count y-axis | Patent schematic |
| [US20150085588A1](https://patents.google.com/patent/US20150085588A1/en) | Fig. 26 | 4 | Simulated test array; patent paragraph 0058 identifies the vertical axis as log scale | Patent simulation |
| [WO2024148459A1](https://patents.google.com/patent/WO2024148459A1/en) | Fig. 8 | 2 | L1/L2 distributions; description identifies cell count as log scale | Patent schematic |

원본 그림 URL:

- US20130163342A1 Fig. 1:
  `https://patentimages.storage.googleapis.com/2d/06/99/bdfab6d37a2954/US20130163342A1-20130627-D00001.png`
- US20150085588A1 Fig. 26:
  `https://patentimages.storage.googleapis.com/17/38/b7/fa85a01a42fc26/US20150085588A1-20150326-D00009.png`
- WO2024148459A1 Fig. 8:
  `https://patentimages.storage.googleapis.com/2c/91/c0/88dbad7d1027db/PCTCN2023071275-appb-300009.png`

각 단일 패널은 원본, 축소 PNG, 손실 JPEG로 변형해 같은
`similarity_group`으로 묶었다. Springer Fig. 14의 coarse/fine 패널은 서로
다른 형상이므로 별도 그룹으로 유지한다. 모든 출처는
`is_measured=false`로 표시한다.

## State-count 스트레스 세트

`artifacts/state-count-stress`에는
[KR20170031195A Fig. 9b](https://patents.google.com/patent/KR20170031195A/en)
8-State 도식과
[US12307090B2 Fig. 4a](https://patents.google.com/patent/US12307090)
16-State 도식을 둔다. 두 도면은 출처에서 로그 y축을 확인하지 못했으므로
로그 스케일 검색 점수에 포함하지 않는다.

공개 문서는 재현 가능한 출처 확인과 내부 회귀 평가를 위한 것이다. 원문과
그림의 권리는 각 출처의 조건을 따른다.

## 실측 NAND 칩 로그 스케일 세트

`artifacts/real-measured-multisource-validation`은 서로 독립적인 실측
로그 출처 세 개를 합친 회귀 세트다.

첫 번째 출처인
[Luo et al., JSAC 2016](https://ghose.cs.illinois.edu/papers/16jsac_mlc.pdf)
Fig. 4의 2.5K/5K/10K/20K P/E 패널을 둔다. 논문은 marker를 실제
1X-nm MLC NAND 칩의 측정 데이터, 선을 Gaussian 모델로 설명하며 y축은
로그 스케일 probability density다. 따라서 각 이미지는 실측 marker와 모델
선이 함께 있는 `measured-real-chip-plus-model` 자료로 표시한다.

네 패널은 각각 원본 PNG, 리사이즈 PNG, 흑백 손실 JPEG로 변형했다. 총
12장 모두 4-State와 `10^-7 ~ 10^0` 로그 범위를 명시한다.

두 번째 출처인
[Freudenberger, Thiers, Bailon 기술 보고서(2023)](https://edocs.tib.eu/files/e01fb24/1896013392.pdf)
Fig. 3.2는 상용 TLC flash의 fresh, 1500 P/E + 13 h bake, 3000 P/E +
80 h bake 측정 histogram을 한 패널에 겹쳐 보여준다. 본문은 y축이
logarithmic임을 명시하며 표시 범위는 frequency `10^0 ~ 10^7`이다.
상용 칩에서 erase State S0를 정확히 측정할 수 없어 충전 State S1~S7만
보이므로, 물리 State는 `state_count=8`, 그림에 보이는 State는
`observed_state_count=7`, 범위는 `state_coverage=partial`로 기록한다.
원본, 리사이즈·패딩 PNG, 흑백 손실 JPEG의 3개 변형을 사용한다.

세 번째 출처인
[IBM Research IRPS 2020 논문 메타데이터](https://research.ibm.com/publications/open-block-characterization-and-read-voltage-calibration-of-3d-qlc-nand-flash)의
[공개 보존 원문](https://web.archive.org/web/20240418014340id_/http://borecraft.com/files/Read_Voltage_Calibration_QLC.pdf)
Fig. 8은 2X P/E cycle과 4시간 retention 뒤의 3D QLC word-line
`VTH` 분포를 보여준다. 캡션은 이를 `Measured VTH distributions`로
명시하며, 그림에는 QLC의 16개 State와 number-of-cells
`10^0 ~ 10^5` 로그축이 표시된다. 서로 다른 retention 이력을 가진 두
page subset의 blue/red trace가 겹친 원본, 패딩 리사이즈 PNG, 흑백 손실
JPEG를 같은 유사도 그룹으로 묶었다.

통합 세트는 총 18장, 6개 유사도 그룹, 3개 독립 실측 출처다. Python
평가에서 전처리와 물리 State 판정은 `18/18`, 같은 패널 변형 Top-1은
`17/18`, Recall@5/10은 모두 `18/18`다. 합성 Vector DB 검색의
State-filtered Top-1/Precision@5/10도 모두 `18/18`이다. 브라우저에서는
전체 18장이 축 검출·전처리·State 판정·Top-10 검색을 통과했다. 새 IBM
16-State 패널의 변형 간 최소 표준 프로필 유사도는 `0.988`, Top-1 후보는
세 변형 모두 같고, Top-5/10 후보 집합의 최소 중복률은 각각 `0.6`,
`0.8`이다.

출처 및 이미지 매니페스트 품질 게이트는 모두 독립 실측 출처 3개를
확보해 `ready_for_domain_calibration=true`다. 이는 공개 실측 논문
이미지로 보정 실험을 시작할 수 있다는 뜻이며, 사용자 장비 이미지에 대한
일반화 완료를 의미하지 않는다.

## 출처 판정 레지스트리

[source-disposition-registry.csv](source-disposition-registry.csv)는 검토한
후보를 `calibration`, `stress-only`, `excluded`로 구분한다. 실측 여부,
원문 그대로의 로그 y축, multi-State VTH 분포, 공개 원문, 독립 데이터
그룹을 모두 만족하고 중복 출처가 아닐 때만 `calibration`으로 인정한다.

DATE 2013, retention/read-disturb 2018, 3D NAND SIGMETRICS 2018,
DATE 2019 및 GDUT 2025 자료는 실제 칩 측정이지만 분포 그림의 y축이
선형이거나 선형 강도 열지도이므로 `stress-only`다. 로그 y축이 있더라도
RTN 단일 분포, 시뮬레이션, 도식, 같은 데이터의 재출판, 원문 비공개 자료는
도메인 보정 출처 수에 포함하지 않는다.

[Zheng et al.의 UCSD commercial 1X-nm TLC 실측 자료](https://cmrr-star.ucsd.edu/static/pubs/Spatio-Temporal_Modeling_for_Flash_Memory_Channels_Using_Conditional_Generative_Nets.pdf)는
Fig. 4에서 측정 marker와 모델 curve를 함께 제공하지만, 캡션이 native
패널을 linear scale이라고 명시하므로 독립 실측 출처이면서도
`stress-only`로 분류한다.

Bailon et al. IEEE Access 2023 Fig. 4의 S6/S7 실측 패널은
`10^0 ~ 10^3` native-log frequency 축을 사용하지만, 같은 상용 TLC
측정군을 위 기술 보고서가 이미 포함하므로 별도 독립 출처로 세지 않는다.

레지스트리와 독립 출처 게이트는 다음 명령으로 재검증한다.

```bash
.venv/bin/vnand-similarity --root . audit-sources \
  docs/source-disposition-registry.csv
```
