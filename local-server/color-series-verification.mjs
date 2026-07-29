import {
  colorSeriesChartFixture,
} from "../web/tests/helpers/color-series-fixtures.mjs";

export function colorSeriesVerificationPng() {
  return colorSeriesChartFixture({
    width: 600,
    height: 360,
    seriesCount: 3,
    crossingMode: "near",
  }).bytes;
}

export function verifyColorSeriesSearch(payload, topK = 2) {
  const panel = payload?.panels?.[0];
  const selected = panel?.series?.[panel.selectedSeriesIndex];
  const serialized = (value) => JSON.stringify(value);
  if (
    payload?.panelCount !== 1 ||
    payload?.panels?.length !== 1 ||
    panel?.seriesCount !== 3 ||
    panel?.series?.length !== 3 ||
    !Number.isInteger(panel.selectedSeriesIndex) ||
    panel.selectedSeriesIndex < 0 ||
    panel.selectedSeriesIndex >= 3 ||
    panel.series.some(
      (series, index) =>
        series.seriesIndex !== index ||
        series.selected !== (index === panel.selectedSeriesIndex) ||
        series.separationMode !== "color" ||
        series.results?.length !== topK ||
        series.results.some(
          (result, resultIndex) =>
            result.rank !== resultIndex + 1 ||
            !Number.isFinite(result.score),
        ),
    ) ||
    serialized(panel.query) !== serialized(selected?.query) ||
    serialized(panel.results) !== serialized(selected?.results) ||
    serialized(payload.query) !== serialized(panel.query) ||
    serialized(payload.results) !== serialized(panel.results)
  ) {
    throw new Error(
      "Packaged search did not preserve per-panel color-series ranking and representative compatibility fields.",
    );
  }
}
