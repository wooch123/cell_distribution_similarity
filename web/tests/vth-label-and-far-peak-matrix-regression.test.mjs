import assert from "node:assert/strict";
import test from "node:test";

import jpeg from "jpeg-js";

import {
  analyzeForegroundMasks,
  applyVerifiedWaveformEvidence,
  extractCurveDistributionCandidates,
} from "../lib/vth-image-analysis-core.mjs";
import {
  buildForegroundMasks,
  buildCurveMask,
} from "../lib/vth-image-core.mjs";
import {
  analyzeSimilarityImage,
  searchSimilarityImage,
  validateTrainingWaveformImage,
} from "../lib/vth-similarity-api-core.mjs";
import {
  canonicalProfileFromCurveMask,
  descriptorFromProfile,
} from "../lib/vth-shape-core.mjs";
import {
  cleanFourStateMaskFixture,
  edgeOverlappingLabelMaskFixtures,
  encodedLabelApiSentinelFixture,
  encodedLabelPlacementApiFixtures,
  farSeparatedPeakFixtures,
  labelArtifactMaskFixtures,
  labeledNonuniformSixStateBoundaryFixture,
  labeledStateCountMaskFixtures,
  lowResolutionMulticolorFarSeparatedPeakFixtures,
  lowResolutionLabelApiFixtures,
  lowResolutionLabeledSixStateApiFixture,
  lowResolutionPersistentTopologyFixtures,
  lowResolutionSameRowFramelessChartsFixture,
  lowResolutionScatteredFramelessChartsFixture,
  multicolorFarSeparatedPeakFixtures,
} from "./helpers/label-and-far-peak-fixtures.mjs";

const EMPTY_CORPUS = Object.freeze({
  version: "label-and-far-peak-regression",
  yScale: "log",
  candidates: Object.freeze([]),
});

function descriptorTopology(descriptor) {
  return {
    stateCount: descriptor.stateCount,
    peakCount: descriptor.peakLocations.length,
    peakWidthCount: descriptor.peakWidths.length,
    valleyCount: descriptor.valleyLocations.length,
    valleyHeightCount: descriptor.valleyHeights.length,
    valleyDepthCount: descriptor.valleyDepths.length,
    valleyRatioCount:
      descriptor.valleyPositionRatios.length,
    peakValleyDistanceCount:
      descriptor.peakValleyDistances.length,
  };
}

function expectedDescriptorTopology(peakCount) {
  const valleyCount = Math.max(0, peakCount - 1);
  return {
    stateCount: peakCount,
    peakCount,
    peakWidthCount: peakCount,
    valleyCount,
    valleyHeightCount: valleyCount,
    valleyDepthCount: valleyCount,
    valleyRatioCount: valleyCount,
    peakValleyDistanceCount: valleyCount * 2,
  };
}

function assertMeasuredDescriptor(
  descriptor,
  peakCount,
  context,
) {
  assert.equal(
    descriptor.observedStateCount,
    peakCount,
    `${context}: every State must be measured from source pixels`,
  );
  assert.equal(
    descriptor.regularized,
    false,
    `${context}: a State-count prior must not manufacture topology`,
  );
}

function jpegBytes(fixture, quality = 46) {
  const rgba = new Uint8Array(
    fixture.width * fixture.height * 4,
  );
  for (
    let sourceOffset = 0, targetOffset = 0;
    sourceOffset < fixture.pixels.length;
    sourceOffset += 3, targetOffset += 4
  ) {
    rgba[targetOffset] = fixture.pixels[sourceOffset];
    rgba[targetOffset + 1] =
      fixture.pixels[sourceOffset + 1];
    rgba[targetOffset + 2] =
      fixture.pixels[sourceOffset + 2];
    rgba[targetOffset + 3] = 255;
  }
  return jpeg.encode(
    {
      data: rgba,
      width: fixture.width,
      height: fixture.height,
    },
    quality,
  ).data;
}

function assertExactFarSeparatedApiResponse(
  fixture,
  response,
) {
  assert.equal(
    response.panelCount,
    fixture.expected.panelCount,
    `${fixture.name}: all State segments belong to one chart`,
  );
  assert.equal(response.panels.length, 1);
  assert.equal(
    response.panels[0].seriesCount,
    fixture.expected.seriesCount,
    `${fixture.name}: State hue styling must not create independent series`,
  );
  assert.equal(
    response.panels[0].query.distributionCount,
    fixture.expected.distributionCount,
    `${fixture.name}: State hue styling must remain one distribution`,
  );
  assert.deepEqual(
    descriptorTopology(response.panels[0].descriptor),
    expectedDescriptorTopology(fixture.expected.peakCount),
    `${fixture.name}: every colored State needs one peak and every adjacent pair one valley`,
  );
  assertMeasuredDescriptor(
    response.panels[0].descriptor,
    fixture.expected.peakCount,
    fixture.name,
  );
}

test("label placement, size, and rotation matrix preserves one exact four-State distribution", async (context) => {
  const fixtures = labelArtifactMaskFixtures();
  assert.equal(fixtures.length, 36);
  const cleanReference = cleanFourStateMaskFixture();
  const cleanedReference = buildCurveMask(
    cleanReference.mask,
    cleanReference.width,
    cleanReference.height,
    cleanReference.bounds,
  );
  const reference = canonicalProfileFromCurveMask(
    cleanedReference.mask,
    cleanedReference.width,
    cleanedReference.height,
  );
  assert.deepEqual(
    descriptorTopology(descriptorFromProfile(reference.profile)),
    expectedDescriptorTopology(4),
    "the unannotated reference itself must contain exactly four peaks and three valleys",
  );

  for (const fixture of fixtures) {
    await context.test(fixture.name, () => {
      const cleaned = buildCurveMask(
        fixture.mask,
        fixture.width,
        fixture.height,
        fixture.bounds,
      );
      const distributions =
        extractCurveDistributionCandidates(
          cleaned.mask,
          cleaned.width,
          cleaned.height,
        );
      const canonical = canonicalProfileFromCurveMask(
        cleaned.mask,
        cleaned.width,
        cleaned.height,
      );
      const descriptor = descriptorFromProfile(
        canonical.profile,
      );

      assert.equal(
        distributions.distributionCount,
        fixture.expected.distributionCount,
        `${fixture.name}: label ink must not become another distribution`,
      );
      assert.deepEqual(
        descriptorTopology(descriptor),
        expectedDescriptorTopology(
          fixture.expected.peakCount,
        ),
        `${fixture.name}: only the four physical arches may define topology`,
      );
    });
  }
});

test("labels within four to nine pixels of either crop edge restore exact four-State topology", async (context) => {
  const fixtures = edgeOverlappingLabelMaskFixtures();
  assert.equal(fixtures.length, 6);
  assert.deepEqual(
    fixtures.map(
      ({ parameters }) =>
        `${parameters.edge}:${parameters.edgeDistance}`,
    ),
    [
      "left:4",
      "left:6",
      "left:9",
      "right:4",
      "right:6",
      "right:9",
    ],
  );

  for (const fixture of fixtures) {
    await context.test(fixture.name, () => {
      const measuredPaddedEdgeDistance =
        fixture.parameters.edge === "left"
          ? fixture.parameters.labelBounds.left -
            fixture.parameters.horizontalPadding
          : fixture.width -
            1 -
            fixture.parameters.labelBounds.right -
            fixture.parameters.horizontalPadding;
      assert.equal(
        measuredPaddedEdgeDistance,
        fixture.parameters.edgeDistance,
        `${fixture.name}: the padded label cleanup box must exercise the declared crop-edge distance`,
      );
      assert.ok(
        fixture.parameters.overlapPixelCount > 0,
        `${fixture.name}: the label must physically overlap the Curve`,
      );
      const cleaned = buildCurveMask(
        fixture.mask,
        fixture.width,
        fixture.height,
        fixture.bounds,
      );
      const canonical = canonicalProfileFromCurveMask(
        cleaned.mask,
        cleaned.width,
        cleaned.height,
      );
      const descriptor = descriptorFromProfile(
        canonical.profile,
      );

      assert.equal(
        cleaned.labelFilterApplied,
        true,
        `${fixture.name}: the edge label must exercise label suppression`,
      );
      assert.ok(
        cleaned.restoredLabelCrossingPixels > 0,
        `${fixture.name}: the shortened edge continuation must restore Curve pixels`,
      );
      assert.deepEqual(
        descriptorTopology(descriptor),
        expectedDescriptorTopology(
          fixture.expected.peakCount,
        ),
        `${fixture.name}: edge-label cleanup must preserve four peaks and three valleys`,
      );
      assert.equal(
        descriptor.observedStateCount,
        fixture.expected.peakCount,
        `${fixture.name}: all four peaks must be directly observed`,
      );
      assert.equal(
        descriptor.regularized,
        false,
        `${fixture.name}: edge-label cleanup must not infer topology from a State prior`,
      );
    });
  }
});

test("labels do not change exact topology across 1, 2, 4, 6, 8, and 16 States", async (context) => {
  const fixtures = labeledStateCountMaskFixtures();
  assert.equal(fixtures.length, 24);
  for (const fixture of fixtures) {
    await context.test(fixture.name, () => {
      const analysis = analyzeForegroundMasks(
        fixture.mask,
        fixture.mask,
        fixture.width,
        fixture.height,
        fixture.mask,
        [],
      );

      assert.equal(
        analysis.distributionSelection.distributionCount,
        fixture.expected.distributionCount,
      );
      assert.deepEqual(
        descriptorTopology(analysis.descriptor),
        expectedDescriptorTopology(
          fixture.expected.peakCount,
        ),
        `${fixture.name}: label cleanup must preserve every physical State`,
      );
      assert.equal(
        analysis.descriptor.observedStateCount,
        fixture.expected.peakCount,
      );
      assert.equal(
        analysis.descriptor.regularized,
        false,
      );
    });
  }
});

test("non-uniform boundary States remain six physical peaks at native and enlarged source scales", () => {
  const fixture =
    labeledNonuniformSixStateBoundaryFixture();
  for (const sourceScale of [1, 3]) {
    const analysis = analyzeForegroundMasks(
      fixture.broadMask,
      fixture.salientMask,
      fixture.width,
      fixture.height,
      fixture.curveMask,
      [],
      { sourceScale },
    );

    assert.ok(
      analysis.preprocessing.primaryMask
        .removedLabelComponents >= 2,
      `sourceScale=${sourceScale}: the detached label must exercise label suppression`,
    );
    assert.deepEqual(
      descriptorTopology(analysis.descriptor),
      expectedDescriptorTopology(
        fixture.expected.peakCount,
      ),
      `sourceScale=${sourceScale}: lower, closely spaced boundary States are physical peaks`,
    );
    assert.equal(
      analysis.descriptor.observedStateCount,
      fixture.expected.peakCount,
    );
    assert.equal(analysis.descriptor.regularized, false);
    assert.notEqual(
      analysis.descriptor.labelBoundaryFramePairRemoved,
      true,
      `sourceScale=${sourceScale}: physical edge States must not be removed as frame shoulders`,
    );
  }
});

test("encoded API path removes a rotated valley label without changing panel, series, or topology", async () => {
  const fixture = encodedLabelApiSentinelFixture();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: EMPTY_CORPUS,
    origin: "http://127.0.0.1:4173",
  });

  assert.equal(response.panelCount, fixture.expected.panelCount);
  assert.equal(response.panels.length, 1);
  assert.equal(
    response.panels[0].seriesCount,
    fixture.expected.seriesCount,
  );
  assert.deepEqual(
    descriptorTopology(response.panels[0].descriptor),
    expectedDescriptorTopology(fixture.expected.peakCount),
  );
});

test("encoded API removes above, below, valley, and tail labels without inferred topology", async (context) => {
  const fixtures = encodedLabelPlacementApiFixtures();
  assert.deepEqual(
    fixtures.map(
      (fixture) => fixture.parameters.placement,
    ),
    ["above", "below", "valley", "tail"],
  );

  for (const fixture of fixtures) {
    await context.test(fixture.name, async () => {
      const analysis = await analyzeSimilarityImage(
        fixture.bytes,
        fixture.mimeType,
      );
      assert.ok(
        analysis.preprocessing.primaryMask
          .removedLabelComponents > 0,
        `${fixture.name}: the RGB path must actually suppress label components`,
      );
      assert.equal(
        analysis.distributionSelection.distributionCount,
        fixture.expected.distributionCount,
      );
      assert.deepEqual(
        descriptorTopology(analysis.descriptor),
        expectedDescriptorTopology(
          fixture.expected.peakCount,
        ),
      );
      assert.equal(
        analysis.descriptor.observedStateCount,
        fixture.expected.peakCount,
      );
      assert.equal(analysis.descriptor.regularized, false);

      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: EMPTY_CORPUS,
        origin: "http://127.0.0.1:4173",
      });
      assert.equal(
        response.panelCount,
        fixture.expected.panelCount,
      );
      assert.equal(
        response.panels[0].seriesCount,
        fixture.expected.seriesCount,
      );
      assert.equal(
        response.panels[0].query.distributionCount,
        fixture.expected.distributionCount,
      );
      assert.deepEqual(
        descriptorTopology(response.descriptor),
        expectedDescriptorTopology(
          fixture.expected.peakCount,
        ),
      );
      assert.equal(
        response.descriptor.observedStateCount,
        fixture.expected.peakCount,
      );
      assert.equal(response.descriptor.regularized, false);
    });
  }
});

test("low-resolution label API matrix returns exact topology or an explicit diagnostic", async (context) => {
  const fixtures = lowResolutionLabelApiFixtures();
  assert.equal(fixtures.length, 20);
  assert.equal(
    fixtures.filter(
      (fixture) =>
        fixture.expected.requiresExactApiTopology,
    ).length,
    6,
  );

  for (const fixture of fixtures) {
    await context.test(fixture.name, async () => {
      let response;
      let failure;
      try {
        response = await searchSimilarityImage({
          bytes: fixture.bytes,
          mimeType: fixture.mimeType,
          topK: 1,
          corpus: EMPTY_CORPUS,
          origin: "http://127.0.0.1:4173",
        });
      } catch (error) {
        failure = error;
      }
      if (failure) {
        if (fixture.expected.requiresExactApiTopology) {
          assert.fail(
            `${fixture.name}: ${failure?.code ?? failure?.name ?? "unknown_error"} ` +
              `${failure?.details?.reason ?? failure?.message ?? ""}`,
          );
        }
        assert.equal(
          failure.code,
          "distribution_waveform_not_found",
        );
        assert.equal(
          failure.details?.reason,
          "low_resolution_insufficient",
        );
        assert.equal(
          failure.details?.diagnosticCode,
          "VTH-DETECT-LOW-RESOLUTION",
        );
        assert.equal(
          failure.details?.diagnostics?.sourceWidth,
          fixture.width,
        );
        assert.equal(
          failure.details?.diagnostics?.sourceHeight,
          fixture.height,
        );
        assert.ok(
          failure.details?.diagnostics?.sourceScale > 1,
        );
        return;
      }
      assert.equal(
        response.panelCount,
        fixture.expected.panelCount,
        `${fixture.name}: one physical chart must remain detectable`,
      );
      assert.equal(response.panels.length, 1);
      assert.equal(
        response.panels[0].seriesCount,
        fixture.expected.seriesCount,
        `${fixture.name}: label fragments must not become a series`,
      );
      assert.equal(
        response.panels[0].query.distributionCount,
        fixture.expected.distributionCount,
        `${fixture.name}: label fragments must not become a distribution`,
      );
      assert.deepEqual(
        descriptorTopology(response.panels[0].descriptor),
        expectedDescriptorTopology(
          fixture.expected.peakCount,
        ),
        `${fixture.name}: resized label ink must not alter four peaks and three valleys`,
      );
      if (fixture.expected.requiresExactApiTopology) {
        assert.equal(
          response.panels[0].descriptor.observedStateCount,
          fixture.expected.peakCount,
          `${fixture.name}: every retained State must come from a measured peak`,
        );
        assert.equal(
          response.panels[0].descriptor.regularized,
          false,
          `${fixture.name}: exact controls must not synthesize topology`,
        );
      }
    });
  }
});

test("a cross-scale-stable zero-depth label spur is still rejected as low-resolution ambiguity", async () => {
  const fixture = lowResolutionLabelApiFixtures().find(
    (candidate) =>
      candidate.parameters.longestEdge === 180 &&
      candidate.parameters.interpolation === "bilinear" &&
      candidate.parameters.rotation === -5,
  );
  assert.ok(fixture);
  const foreground = buildForegroundMasks(
    fixture.pixels,
    fixture.width,
    fixture.height,
    fixture.channels,
  );
  const sourceAnalysis = analyzeForegroundMasks(
    foreground.broadMask,
    foreground.salientMask,
    fixture.width,
    fixture.height,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
  );
  const enlargedAnalysis = await analyzeSimilarityImage(
    fixture.bytes,
    fixture.mimeType,
  );
  assert.equal(sourceAnalysis.descriptor.stateCount, 5);
  assert.equal(enlargedAnalysis.descriptor.stateCount, 5);
  assert.ok(
    enlargedAnalysis.descriptor.valleyDepths.some(
      (depth) => depth <= 0.002,
    ),
    "the fifth turn must be a zero-depth label spur, not a physical valley",
  );
  const tolerance = Math.max(
    0.035,
    3 / Math.max(fixture.width, fixture.height),
  );
  sourceAnalysis.descriptor.peakLocations.forEach(
    (location, index) => {
      assert.ok(
        Math.abs(
          location -
            enlargedAnalysis.descriptor.peakLocations[index],
        ) <= tolerance,
        "the negative must remain deceptively stable across scale",
      );
    },
  );
  await assert.rejects(
    searchSimilarityImage({
      bytes: fixture.bytes,
      mimeType: fixture.mimeType,
      topK: 1,
      corpus: EMPTY_CORPUS,
      origin: "http://127.0.0.1:4173",
    }),
    (error) => {
      assert.equal(
        error.code,
        "distribution_waveform_not_found",
      );
      assert.equal(
        error.details?.reason,
        "low_resolution_insufficient",
      );
      assert.equal(
        error.details?.diagnosticCode,
        "VTH-DETECT-LOW-RESOLUTION",
      );
      return true;
    },
  );
});

test("training provenance rejects fragmented and cross-scale-inconsistent low-resolution charts", async () => {
  const reference = encodedLabelApiSentinelFixture();
  const referenceResponse = await searchSimilarityImage({
    bytes: reference.bytes,
    mimeType: reference.mimeType,
    topK: 1,
    corpus: EMPTY_CORPUS,
    origin: "http://127.0.0.1:4173",
  });
  const fragmented = lowResolutionLabelApiFixtures().find(
    (fixture) =>
      fixture.parameters.longestEdge === 180 &&
      fixture.parameters.interpolation === "bilinear" &&
      fixture.parameters.rotation === 0,
  );
  assert.ok(fragmented);
  const topologyMismatch = lowResolutionLabelApiFixtures().find(
    (fixture) =>
      fixture.parameters.longestEdge === 100 &&
      fixture.parameters.interpolation === "bilinear" &&
      fixture.parameters.rotation === 5,
  );
  assert.ok(topologyMismatch);

  for (const input of [
    {
      bytes: fragmented.bytes,
      mimeType: fragmented.mimeType,
      profile: referenceResponse.profile,
      stateCount: referenceResponse.descriptor.stateCount,
    },
    {
      bytes: topologyMismatch.bytes,
      mimeType: topologyMismatch.mimeType,
      profile: referenceResponse.profile,
      stateCount: referenceResponse.descriptor.stateCount,
      sourceSelection: {
        panelIndex: 0,
        panelCount: 1,
        seriesIndex: 0,
        seriesCount: 1,
      },
    },
  ]) {
    await assert.rejects(
      validateTrainingWaveformImage(input),
      (error) => {
        assert.equal(
          error.code,
          "distribution_waveform_not_found",
        );
        assert.equal(
          error.details?.reason,
          "low_resolution_insufficient",
        );
        assert.equal(
          error.details?.diagnosticCode,
          "VTH-DETECT-LOW-RESOLUTION",
        );
        return true;
      },
    );
  }
});

test("persistent narrow outer States and close peak-valleys survive low-resolution search and training", async (context) => {
  const fixtures =
    lowResolutionPersistentTopologyFixtures();
  assert.equal(fixtures.length, 2);

  for (const fixture of fixtures) {
    await context.test(fixture.name, async () => {
      const foreground = buildForegroundMasks(
        fixture.pixels,
        fixture.width,
        fixture.height,
        fixture.channels,
      );
      const sourceAnalysis = analyzeForegroundMasks(
        foreground.broadMask,
        foreground.salientMask,
        fixture.width,
        fixture.height,
        foreground.curveSalientMask,
        foreground.curveColorMasks,
      );
      const enlargedAnalysis =
        await analyzeSimilarityImage(
          fixture.bytes,
          fixture.mimeType,
        );
      assert.ok(
        enlargedAnalysis.processedWidth /
          enlargedAnalysis.sourceWidth >=
          4,
        `${fixture.name}: the fixture must exercise the low-resolution upscale gate`,
      );
      for (const [surface, descriptor] of [
        ["source", sourceAnalysis.descriptor],
        ["enlarged", enlargedAnalysis.descriptor],
      ]) {
        assert.deepEqual(
          descriptorTopology(descriptor),
          expectedDescriptorTopology(
            fixture.expected.peakCount,
          ),
          `${fixture.name}/${surface}: physical topology changed across scale`,
        );
        assert.equal(
          descriptor.observedStateCount,
          fixture.expected.peakCount,
          `${fixture.name}/${surface}: every State must be directly pixel-observed`,
        );
        assert.equal(
          descriptor.regularized,
          false,
          `${fixture.name}/${surface}: no synthetic State regularization is allowed`,
        );
        const physicalPeakCenters =
          fixture.parameters.lobes.map(
            ({ left, right }) => (left + right) / 2,
          );
        descriptor.peakLocations.forEach(
          (location, index) => {
            assert.ok(
              Math.abs(
                location - physicalPeakCenters[index],
              ) <=
                Math.max(
                  0.025,
                  2 / Math.max(fixture.width, fixture.height),
                ),
              `${fixture.name}/${surface}: peak ${index + 1} must bind to its rendered lobe center`,
            );
          },
        );
        descriptor.valleyLocations.forEach(
          (location, index) => {
            assert.ok(
              location > physicalPeakCenters[index] &&
                location < physicalPeakCenters[index + 1],
              `${fixture.name}/${surface}: valley ${index + 1} must remain between its rendered adjacent lobes`,
            );
          },
        );
      }
      const peakLocationTolerance = Math.max(
        0.035,
        3 / Math.max(fixture.width, fixture.height),
      );
      sourceAnalysis.descriptor.peakLocations.forEach(
        (location, index) => {
          assert.ok(
            Math.abs(
              location -
                enlargedAnalysis.descriptor
                  .peakLocations[index],
            ) <= peakLocationTolerance,
            `${fixture.name}: peak ${index + 1} must persist at the same normalized location`,
          );
        },
      );
      const orderedPeakWidths = [
        ...enlargedAnalysis.descriptor.peakWidths,
      ].sort((left, right) => left - right);
      const medianPeakWidth =
        orderedPeakWidths[
          Math.floor(orderedPeakWidths.length / 2)
        ];
      assert.ok(
        orderedPeakWidths[0] <= medianPeakWidth * 0.12,
        `${fixture.name}: the positive case must exercise the narrow-State ambiguity gate`,
      );
      assert.ok(
        enlargedAnalysis.descriptor.valleyDepths.every(
          (depth) => depth > 0.002,
        ),
        `${fixture.name}: a real valley must not be a zero-depth label or frame turn`,
      );
      if (
        fixture.parameters.kind ===
        "close-peak-valley"
      ) {
        assert.ok(
          Math.min(
            ...enlargedAnalysis.descriptor
              .peakValleyDistances,
          ) <= 0.04,
          `${fixture.name}: one physical peak-to-valley distance must remain close`,
        );
      }

      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: EMPTY_CORPUS,
        origin: "http://127.0.0.1:4173",
      });
      assert.equal(
        response.panelCount,
        fixture.expected.panelCount,
      );
      assert.equal(
        response.panels[0].seriesCount,
        fixture.expected.seriesCount,
      );
      assert.equal(
        response.panels[0].query.distributionCount,
        fixture.expected.distributionCount,
      );
      assert.deepEqual(
        descriptorTopology(response.descriptor),
        expectedDescriptorTopology(
          fixture.expected.peakCount,
        ),
        `${fixture.name}/search: exact topology changed`,
      );
      assert.equal(
        response.query.observedStateCount,
        fixture.expected.peakCount,
      );
      assert.equal(response.query.regularized, false);

      const validated =
        await validateTrainingWaveformImage({
          bytes: fixture.bytes,
          mimeType: fixture.mimeType,
          profile: response.profile,
          stateCount: response.descriptor.stateCount,
        });
      assert.equal(validated.panelCount, 1);
      assert.equal(validated.seriesCount, 1);
      assert.equal(
        validated.stateCount,
        fixture.expected.peakCount,
      );
      assert.deepEqual(
        descriptorTopology(
          validated.authoritativeDescriptor,
        ),
        expectedDescriptorTopology(
          fixture.expected.peakCount,
        ),
        `${fixture.name}/training: authoritative topology changed`,
      );
      assert.equal(
        validated.authoritativeDescriptor
          .observedStateCount,
        fixture.expected.peakCount,
      );
      assert.equal(
        validated.authoritativeDescriptor.regularized,
        false,
      );
      assert.equal(validated.stateHypothesisMatched, true);
      assert.ok(validated.profileSimilarity >= 0.98);
    });
  }
});

test("five-degree 350px labeled charts keep exact search and training provenance", async () => {
  for (const rotation of [-5, 5]) {
    const fixture = lowResolutionLabelApiFixtures().find(
      (candidate) =>
        candidate.parameters.longestEdge === 350 &&
        candidate.parameters.interpolation === "bilinear" &&
        candidate.parameters.rotation === rotation,
    );
    assert.ok(fixture);
    const response = await searchSimilarityImage({
      bytes: fixture.bytes,
      mimeType: fixture.mimeType,
      topK: 1,
      corpus: EMPTY_CORPUS,
      origin: "http://127.0.0.1:4173",
    });
    const validated = await validateTrainingWaveformImage({
      bytes: fixture.bytes,
      mimeType: fixture.mimeType,
      profile: response.profile,
      stateCount: response.descriptor.stateCount,
      sourceSelection: {
        panelIndex: 0,
        panelCount: 1,
        seriesIndex: 0,
        seriesCount: 1,
      },
    });
    assert.equal(validated.panelCount, 1);
    assert.equal(validated.stateCount, 4);
    assert.ok(validated.profileSimilarity >= 0.99);
  }
});

test("low-resolution frame cleanup does not collapse a real labeled six-State curve to four States", async () => {
  const fixture =
    lowResolutionLabeledSixStateApiFixture();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: EMPTY_CORPUS,
    origin: "http://127.0.0.1:4173",
  });
  assert.equal(response.panelCount, fixture.expected.panelCount);
  assert.equal(
    response.panels[0].seriesCount,
    fixture.expected.seriesCount,
  );
  assert.deepEqual(
    {
      stateCount: response.panels[0].query.stateCount,
      observedStateCount:
        response.panels[0].query.observedStateCount,
      regularized:
        response.panels[0].query.regularized,
      peakCount: response.panels[0].query.peakCount,
      valleyCount: response.panels[0].query.valleyCount,
    },
    {
      stateCount: fixture.expected.peakCount,
      observedStateCount: fixture.expected.peakCount,
      regularized: false,
      peakCount: fixture.expected.peakCount,
      valleyCount: fixture.expected.valleyCount,
    },
  );
});

test("two spatially separate low-resolution frameless charts are not collapsed into one fragmented Curve", async () => {
  const fixture =
    lowResolutionScatteredFramelessChartsFixture();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: EMPTY_CORPUS,
    origin: "http://127.0.0.1:4173",
  });
  assert.equal(response.panelCount, fixture.expected.panelCount);
  assert.deepEqual(
    response.panels.map((panel) => ({
      stateCount: panel.descriptor.stateCount,
      peakCount: panel.descriptor.peakLocations.length,
      valleyCount: panel.descriptor.valleyLocations.length,
      regularized: panel.descriptor.regularized === true,
    })),
    Array.from(
      { length: fixture.expected.panelCount },
      () => ({
        stateCount: fixture.expected.stateCount,
        peakCount: fixture.expected.stateCount,
        valleyCount: fixture.expected.valleyCount,
        regularized: false,
      }),
    ),
  );
});

test("two same-row low-resolution frameless charts remain independent panels", async () => {
  const fixture =
    lowResolutionSameRowFramelessChartsFixture();
  const response = await searchSimilarityImage({
    bytes: fixture.bytes,
    mimeType: fixture.mimeType,
    topK: 1,
    corpus: EMPTY_CORPUS,
    origin: "http://127.0.0.1:4173",
  });
  assert.equal(response.panelCount, fixture.expected.panelCount);
  assert.deepEqual(
    response.panels.map((panel) => ({
      stateCount: panel.descriptor.stateCount,
      peakCount: panel.descriptor.peakLocations.length,
      valleyCount: panel.descriptor.valleyLocations.length,
      regularized: panel.descriptor.regularized === true,
    })),
    Array.from(
      { length: fixture.expected.panelCount },
      () => ({
        stateCount: fixture.expected.stateCount,
        peakCount: fixture.expected.stateCount,
        valleyCount: fixture.expected.valleyCount,
        regularized: false,
      }),
    ),
  );
});

test("far-separated peak matrix stays one chart and one distribution with exact adjacent valleys", async (context) => {
  const fixtures = farSeparatedPeakFixtures();
  assert.equal(fixtures.length, 120);

  for (const fixture of fixtures) {
    await context.test(fixture.name, async () => {
      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: EMPTY_CORPUS,
        origin: "http://127.0.0.1:4173",
      });
      assert.equal(
        response.panelCount,
        fixture.expected.panelCount,
        `${fixture.name}: disconnected lobes belong to one physical chart frame`,
      );
      assert.equal(
        response.panels[0].seriesCount,
        fixture.expected.seriesCount,
        `${fixture.name}: monochrome lobes must remain one series`,
      );
      assert.equal(
        response.panels[0].query.distributionCount,
        fixture.expected.distributionCount,
        `${fixture.name}: empty gaps must not be interpreted as independent distributions`,
      );
      assert.deepEqual(
        descriptorTopology(response.panels[0].descriptor),
        expectedDescriptorTopology(
          fixture.expected.peakCount,
        ),
        `${fixture.name}: every physical peak needs exactly one adjacent-valley topology`,
      );
      assertMeasuredDescriptor(
        response.panels[0].descriptor,
        fixture.expected.peakCount,
        fixture.name,
      );

    });
  }
});

test("strict source edge States outrank a lower-count repeated-grid projection without disabling source-local evidence", () => {
  const fixtures = farSeparatedPeakFixtures();
  const analyzeFixture = (name) => {
    const fixture = fixtures.find(
      (candidate) => candidate.name === name,
    );
    assert.ok(fixture, `${name}: fixture must exist`);
    const foreground = buildForegroundMasks(
      fixture.pixels,
      fixture.width,
      fixture.height,
      fixture.channels,
    );
    return analyzeForegroundMasks(
      foreground.broadMask,
      foreground.salientMask,
      fixture.width,
      fixture.height,
      foreground.curveSalientMask,
      foreground.curveColorMasks,
    );
  };
  const sourceAnalysis = analyzeFixture(
    "far-3-uniform-above-rectangle",
  );
  const projectedAnalysis = analyzeFixture(
    "far-2-uniform-above-rectangle",
  );

  assert.deepEqual(
    {
      stateCount: sourceAnalysis.descriptor.stateCount,
      observedStateCount:
        sourceAnalysis.descriptor.observedStateCount,
      regularized: sourceAnalysis.descriptor.regularized,
      peakCount:
        sourceAnalysis.descriptor.peakLocations.length,
      valleyCount:
        sourceAnalysis.descriptor.valleyLocations.length,
      upperArcApplied:
        sourceAnalysis.preprocessing.upperArcEvidence
          .applied,
    },
    {
      stateCount: 3,
      observedStateCount: 3,
      regularized: false,
      peakCount: 3,
      valleyCount: 2,
      upperArcApplied: true,
    },
  );
  assert.ok(
    sourceAnalysis.descriptor.peakLocations[0] < 0.025 &&
      sourceAnalysis.descriptor.peakLocations.at(-1) >
        0.975,
    "the source fixture must exercise the one-resample-bin edge tolerance",
  );
  assert.deepEqual(
    {
      stateCount: projectedAnalysis.descriptor.stateCount,
      observedStateCount:
        projectedAnalysis.descriptor.observedStateCount,
      regularized:
        projectedAnalysis.descriptor.regularized,
      peakCount:
        projectedAnalysis.descriptor.peakLocations.length,
      valleyCount:
        projectedAnalysis.descriptor.valleyLocations.length,
    },
    {
      stateCount: 2,
      observedStateCount: 2,
      regularized: false,
      peakCount: 2,
      valleyCount: 1,
    },
  );

  const evidenceFor = (source) => ({
    profile: projectedAnalysis.profile,
    descriptor: projectedAnalysis.descriptor,
    source,
  });
  const preserved = applyVerifiedWaveformEvidence(
    sourceAnalysis,
    evidenceFor("repeated-grid-measured-topology"),
  );
  assert.strictEqual(
    preserved,
    sourceAnalysis,
    "a lower-resolution board projection must not replace strict source-local topology",
  );
  assert.deepEqual(
    {
      stateCount: preserved.descriptor.stateCount,
      peakCount: preserved.descriptor.peakLocations.length,
      valleyCount:
        preserved.descriptor.valleyLocations.length,
    },
    {
      stateCount: 3,
      peakCount: 3,
      valleyCount: 2,
    },
  );

  for (const source of [
    "table-grid-measured-topology",
    "mixed-table-physical-frame-topology",
    "repeated-grid-native-physical-topology",
  ]) {
    const applied = applyVerifiedWaveformEvidence(
      sourceAnalysis,
      evidenceFor(source),
    );
    assert.notStrictEqual(
      applied,
      sourceAnalysis,
      `${source}: source-local/table evidence must remain eligible`,
    );
    assert.deepEqual(
      {
        stateCount: applied.descriptor.stateCount,
        peakCount: applied.descriptor.peakLocations.length,
        valleyCount:
          applied.descriptor.valleyLocations.length,
        source:
          applied.preprocessing.verifiedWaveformEvidence
            .source,
      },
      {
        stateCount: 2,
        peakCount: 2,
        valleyCount: 1,
        source,
      },
    );
  }
});

test("State-hue far-separated matrix remains one distribution with exact topology", async (context) => {
  const fixtures = multicolorFarSeparatedPeakFixtures();
  assert.equal(fixtures.length, 120);

  for (const fixture of fixtures) {
    await context.test(fixture.name, () => {
      assert.equal(
        fixture.parameters.colorMode,
        "state-hue-cycle",
      );
      const foreground = buildForegroundMasks(
        fixture.pixels,
        fixture.width,
        fixture.height,
        fixture.channels,
      );
      const analysis = analyzeForegroundMasks(
        foreground.broadMask,
        foreground.salientMask,
        fixture.width,
        fixture.height,
        foreground.curveSalientMask,
        foreground.curveColorMasks,
      );

      assert.equal(
        analysis.distributionSelection.distributionCount,
        fixture.expected.distributionCount,
        `${fixture.name}: hue-separated States must remain one physical distribution`,
      );
      assert.equal(
        analysis.series.length,
        fixture.expected.seriesCount,
        `${fixture.name}: repeated hue bins must not become full-width series`,
      );
      assert.deepEqual(
        descriptorTopology(analysis.descriptor),
        expectedDescriptorTopology(
          fixture.expected.peakCount,
        ),
        `${fixture.name}: color must not change peak/valley topology`,
      );
      assertMeasuredDescriptor(
        analysis.descriptor,
        fixture.expected.peakCount,
        fixture.name,
      );
    });
  }
});

test("representative State-hue far-separated PNGs preserve exact API topology", async (context) => {
  const representativeKeys = new Set([
    "2-uniform-above-rectangle",
    "3-irregular-floor-l-axis",
    "4-irregular-above-l-axis",
    "5-uniform-floor-rectangle",
    "8-uniform-above-l-axis",
    "10-irregular-floor-rectangle",
    "12-irregular-above-rectangle",
    "16-uniform-floor-l-axis",
  ]);
  const fixtures = multicolorFarSeparatedPeakFixtures().filter(
    (fixture) =>
      representativeKeys.has(
        [
          fixture.parameters.stateCount,
          fixture.parameters.spacingMode,
          fixture.parameters.floorTouch
            ? "floor"
            : "above",
          fixture.parameters.axisMode,
        ].join("-"),
      ),
  );
  assert.equal(fixtures.length, representativeKeys.size);

  for (const fixture of fixtures) {
    await context.test(fixture.name, async () => {
      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: EMPTY_CORPUS,
        origin: "http://127.0.0.1:4173",
      });
      assertExactFarSeparatedApiResponse(fixture, response);
    });
  }
});

test("representative JPEG State-hue segments remain one exact distribution", async (context) => {
  const representativeKeys = new Set([
    "4-uniform-above-rectangle",
    "8-irregular-floor-l-axis",
    "12-uniform-floor-rectangle",
    "16-irregular-above-l-axis",
  ]);
  const fixtures = multicolorFarSeparatedPeakFixtures().filter(
    (fixture) =>
      representativeKeys.has(
        [
          fixture.parameters.stateCount,
          fixture.parameters.spacingMode,
          fixture.parameters.floorTouch
            ? "floor"
            : "above",
          fixture.parameters.axisMode,
        ].join("-"),
      ),
  );
  assert.equal(fixtures.length, representativeKeys.size);

  for (const fixture of fixtures) {
    await context.test(`${fixture.name}-jpeg-q46`, async () => {
      const response = await searchSimilarityImage({
        bytes: jpegBytes(fixture),
        mimeType: "image/jpeg",
        topK: 1,
        corpus: EMPTY_CORPUS,
        origin: "http://127.0.0.1:4173",
      });
      assertExactFarSeparatedApiResponse(fixture, response);
    });
  }
});

test("low-resolution State-hue segments remain one exact distribution", async (context) => {
  const fixtures =
    lowResolutionMulticolorFarSeparatedPeakFixtures();
  assert.equal(fixtures.length, 4);

  for (const fixture of fixtures) {
    await context.test(fixture.name, async () => {
      const expectedWidth =
        fixture.parameters.stateCount === 16
          ? 960
          : 480;
      assert.equal(fixture.width, expectedWidth);
      assert.equal(
        fixture.height,
        Math.round(expectedWidth / 3),
      );
      const response = await searchSimilarityImage({
        bytes: fixture.bytes,
        mimeType: fixture.mimeType,
        topK: 1,
        corpus: EMPTY_CORPUS,
        origin: "http://127.0.0.1:4173",
      });
      assertExactFarSeparatedApiResponse(fixture, response);
    });
  }
});
