import {
  colorSeriesChartFixture,
} from "../web/tests/helpers/color-series-fixtures.mjs";

export function colorSeriesVerificationPng(
  seriesCount = 3,
) {
  return colorSeriesChartFixture({
    width: 600,
    height: 360,
    seriesCount,
    crossingMode: "near",
  }).bytes;
}

export function verifyColorSeriesSearch(
  payload,
  topK = 2,
  detectedSeriesCount = 3,
) {
  const panel = payload?.panels?.[0];
  const selected = panel?.series?.[panel.selectedSeriesIndex];
  const serialized = (value) => JSON.stringify(value);
  const targetSeriesCount =
    detectedSeriesCount <= 2 ? detectedSeriesCount : 1;
  const expectedSelectionMode =
    detectedSeriesCount <= 2
      ? "most-irregular"
      : "most-irregular-only";
  if (
    payload?.panelCount !== 1 ||
    payload?.panels?.length !== 1 ||
    panel?.seriesCount !== targetSeriesCount ||
    panel?.series?.length !== targetSeriesCount ||
    !Number.isInteger(panel.selectedSeriesIndex) ||
    panel.selectedSeriesIndex < 0 ||
    panel.selectedSeriesIndex >= targetSeriesCount ||
    panel.series.some(
      (series, index) =>
        series.seriesIndex !== index ||
        serialized(series.trainingSelection) !==
          serialized({
            panelIndex: 0,
            panelCount: 1,
            seriesIndex: index,
            seriesCount: targetSeriesCount,
          }) ||
        series.profile?.length !== 256 ||
        series.profile.some((value) => !Number.isFinite(value)) ||
        series.descriptor?.stateCount !==
          series.descriptor?.peakLocations?.length ||
        series.descriptor?.valleyLocations?.length !==
          series.descriptor?.stateCount - 1 ||
        series.selected !== (index === panel.selectedSeriesIndex) ||
        series.separationMode !== "color" ||
        series.query?.distributionCount !==
          detectedSeriesCount ||
        series.query?.targetDistributionCount !==
          targetSeriesCount ||
        series.query?.distributionSelectionMode !==
          expectedSelectionMode ||
        series.query?.colorSeriesPolicy
          ?.collapsedToMostIrregular !==
          (detectedSeriesCount > 2) ||
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
      "Packaged search did not enforce the two-series color split limit and most-irregular fallback.",
    );
  }
}
