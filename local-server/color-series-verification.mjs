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
        serialized(series.trainingSelection) !==
          serialized({
            panelIndex: 0,
            panelCount: 1,
            seriesIndex: index,
            seriesCount: 3,
          }) ||
        series.profile?.length !== 256 ||
        series.profile.some((value) => !Number.isFinite(value)) ||
        series.descriptor?.stateCount !==
          series.descriptor?.peakLocations?.length ||
        series.descriptor?.valleyLocations?.length !==
          series.descriptor?.stateCount - 1 ||
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
    serialized(panel.trainingSelection) !==
      serialized(selected?.trainingSelection) ||
    serialized(panel.profile) !== serialized(selected?.profile) ||
    serialized(panel.descriptor) !==
      serialized(selected?.descriptor) ||
    serialized(payload.query) !== serialized(panel.query) ||
    serialized(payload.results) !== serialized(panel.results) ||
    serialized(payload.trainingSelection) !==
      serialized(panel.trainingSelection) ||
    serialized(payload.profile) !== serialized(panel.profile) ||
    serialized(payload.descriptor) !==
      serialized(panel.descriptor)
  ) {
    throw new Error(
      "Packaged search did not preserve per-panel color-series ranking and representative compatibility fields.",
    );
  }
}
