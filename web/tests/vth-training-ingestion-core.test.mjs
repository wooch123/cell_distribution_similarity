import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";

import {
  MIN_TRAINING_CODEC_STABLE_SIMILARITY,
  SimilarityApiError,
  validateTrainingWaveformImage,
} from "../lib/vth-similarity-api-core.mjs";
import {
  buildLearnedCandidate,
  buildSharedTrainingApiPayload,
} from "../lib/vth-learning-core.mjs";
import {
  cropInterleavedPixels,
  detectChartPanels,
} from "../lib/vth-chart-panel-core.mjs";
import { analyzeForegroundMasks } from "../lib/vth-image-analysis-core.mjs";
import { buildForegroundMasks } from "../lib/vth-image-core.mjs";
import {
  SHARED_TRAINING_CONSENT_VERSION,
  validateSharedTrainingPayload,
} from "../lib/vth-shared-training-core.mjs";
import {
  alignedCurveSimilarity,
  descriptorFromProfile,
} from "../lib/vth-shape-core.mjs";
import {
  shadedNumericTablePng,
  sparklineTablePng,
} from "./helpers/table-fixtures.mjs";

const corpus = JSON.parse(
  await readFile(
    new URL("../public/corpus-index.json", import.meta.url),
    "utf8",
  ),
);
const eightState = corpus.candidates.find(
  (candidate) => candidate.id === "vth-08s-s0042-00000",
);
const fourState = corpus.candidates.find(
  (candidate) => candidate.id === "vth-04s-s0042-00000",
);
const labeledFault = corpus.candidates.find(
  (candidate) => candidate.id === "vnand-fault-001",
);
assert.ok(eightState);
assert.ok(fourState);
assert.ok(labeledFault);
const eightStatePng = await readFile(
  new URL(`../public${eightState.image}`, import.meta.url),
);
const labeledFaultPng = await readFile(
  new URL(`../public${labeledFault.image}`, import.meta.url),
);

function jpegFromPixels(
  data,
  width,
  height,
  channels,
  detachedGlyphCount = 0,
  quality = 86,
) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const inputOffset = index * channels;
    const outputOffset = index * 4;
    rgba[outputOffset] = data[inputOffset];
    rgba[outputOffset + 1] = data[inputOffset + 1];
    rgba[outputOffset + 2] = data[inputOffset + 2];
    rgba[outputOffset + 3] =
      channels === 4
        ? data[inputOffset + 3]
        : 255;
  }
  const paint = (x, y) => {
    if (
      x < 0 ||
      x >= width ||
      y < 0 ||
      y >= height
    ) {
      return;
    }
    const offset = (y * width + x) * 4;
    rgba[offset] = 20;
    rgba[offset + 1] = 20;
    rgba[offset + 2] = 20;
    rgba[offset + 3] = 255;
  };
  for (let glyph = 0; glyph < detachedGlyphCount; glyph += 1) {
    const left = 260 + glyph * 13;
    const top = 255;
    for (let y = top; y <= top + 10; y += 1) {
      paint(left, y);
    }
    for (const y of [top, top + 5, top + 10]) {
      for (let x = left; x <= left + 7; x += 1) {
        paint(x, y);
      }
    }
  }
  return jpeg.encode(
    {
      data: rgba,
      width,
      height,
    },
    quality,
  ).data;
}

function boundedRasterScale(
  width,
  height,
  maximumWidth,
  maximumHeight,
  maximumPixels,
  maximumScale = 4,
) {
  const allowedScale =
    Math.min(width, height) < 360 ? maximumScale : 1;
  return Math.min(
    allowedScale,
    maximumWidth / Math.max(1, width),
    maximumHeight / Math.max(1, height),
    Math.sqrt(maximumPixels / Math.max(1, width * height)),
  );
}

function browserRaster(
  source,
  width,
  height,
  channels,
  maximumWidth,
  maximumHeight,
  maximumPixels,
  maximumScale = 4,
) {
  const scale = boundedRasterScale(
    width,
    height,
    maximumWidth,
    maximumHeight,
    maximumPixels,
    maximumScale,
  );
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const output = new Uint8Array(targetWidth * targetHeight * 3);
  const xRatio = width / targetWidth;
  const yRatio = height / targetHeight;
  const channelValue = (pixelOffset, channel) => {
    const alpha =
      channels === 4 ? source[pixelOffset + 3] / 255 : 1;
    return source[pixelOffset + channel] * alpha + 255 * (1 - alpha);
  };

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = (y + 0.5) * yRatio - 0.5;
    const top = Math.max(0, Math.floor(sourceY));
    const bottom = Math.min(height - 1, top + 1);
    const yWeight = Math.max(0, sourceY - top);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = (x + 0.5) * xRatio - 0.5;
      const left = Math.max(0, Math.floor(sourceX));
      const right = Math.min(width - 1, left + 1);
      const xWeight = Math.max(0, sourceX - left);
      const outputOffset = (y * targetWidth + x) * 3;
      const topLeftOffset = (top * width + left) * channels;
      const topRightOffset = (top * width + right) * channels;
      const bottomLeftOffset = (bottom * width + left) * channels;
      const bottomRightOffset = (bottom * width + right) * channels;
      for (let channel = 0; channel < 3; channel += 1) {
        const topValue =
          channelValue(topLeftOffset, channel) * (1 - xWeight) +
          channelValue(topRightOffset, channel) * xWeight;
        const bottomValue =
          channelValue(bottomLeftOffset, channel) * (1 - xWeight) +
          channelValue(bottomRightOffset, channel) * xWeight;
        output[outputOffset + channel] = Math.round(
          topValue * (1 - yWeight) + bottomValue * yWeight,
        );
      }
    }
  }
  return {
    data: output,
    width: targetWidth,
    height: targetHeight,
    channels: 3,
    scale,
  };
}

function uiSourceBounds(panel, documentRaster, source) {
  if (panel.detectionReason === "whole-image-fallback") {
    return {
      x: 0,
      y: 0,
      width: source.width,
      height: source.height,
    };
  }
  const bounds = {
    x: Math.max(
      0,
      Math.floor(
        (panel.x / documentRaster.width) * source.width,
      ),
    ),
    y: Math.max(
      0,
      Math.floor(
        (panel.y / documentRaster.height) * source.height,
      ),
    ),
    width: Math.max(
      1,
      Math.min(
        source.width,
        Math.ceil(
          (panel.width / documentRaster.width) * source.width,
        ),
      ),
    ),
    height: Math.max(
      1,
      Math.min(
        source.height,
        Math.ceil(
          (panel.height / documentRaster.height) * source.height,
        ),
      ),
    ),
  };
  bounds.width = Math.min(bounds.width, source.width - bounds.x);
  bounds.height = Math.min(bounds.height, source.height - bounds.y);
  return bounds;
}

function analyzeUiCrop(crop) {
  const raster = browserRaster(
    crop.pixels,
    crop.width,
    crop.height,
    crop.channels,
    1100,
    720,
    800_000,
  );
  const foreground = buildForegroundMasks(
    raster.data,
    raster.width,
    raster.height,
    raster.channels,
    { sourceScale: raster.scale },
  );
  return analyzeForegroundMasks(
    foreground.broadMask,
    foreground.salientMask,
    raster.width,
    raster.height,
    foreground.curveSalientMask,
    foreground.curveColorMasks,
  );
}

function sanitizedUiPreviewJpeg(
  source,
  crop,
  useDetectedBounds,
) {
  let preview = useDetectedBounds
    ? jpeg.decode(
        jpegFromPixels(
          crop.pixels,
          crop.width,
          crop.height,
          crop.channels,
          0,
          90,
        ),
        {
          useTArray: true,
          formatAsRGBA: false,
          tolerantDecoding: true,
        },
      )
    : {
        data: source.data,
        width: source.width,
        height: source.height,
        channels: source.channels,
      };
  preview = {
    ...preview,
    channels:
      preview.channels ??
      Math.max(
        3,
        Math.round(
          preview.data.length /
            Math.max(1, preview.width * preview.height),
        ),
      ),
  };
  const sanitized = browserRaster(
    preview.data,
    preview.width,
    preview.height,
    preview.channels,
    1280,
    960,
    Number.MAX_SAFE_INTEGER,
    1,
  );
  return jpegFromPixels(
    sanitized.data,
    sanitized.width,
    sanitized.height,
    sanitized.channels,
  );
}

function assertAuthoritativeVerification(
  verification,
  submittedProfile,
) {
  assert.equal(verification.authoritativeProfile.length, 256);
  assert.ok(
    alignedCurveSimilarity(
      verification.authoritativeProfile,
      submittedProfile,
    ) >= MIN_TRAINING_CODEC_STABLE_SIMILARITY,
    "stored authoritative Curve must be the accepted source hypothesis",
  );
  assert.deepEqual(
    verification.authoritativeDescriptor,
    descriptorFromProfile(
      verification.authoritativeProfile,
    ),
    "stored descriptor must be rebuilt from the authoritative Curve",
  );
}

function jpegFromPng(bytes, detachedGlyphCount = 0) {
  const decoded = decodePng(bytes);
  return jpegFromPixels(
    decoded.data,
    decoded.width,
    decoded.height,
    decoded.channels,
    detachedGlyphCount,
  );
}

function drawLine(rgb, width, height, x1, y1, x2, y2, thickness = 1) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps);
    const y = Math.round(y1 + ((y2 - y1) * step) / steps);
    for (let offsetY = 0; offsetY < thickness; offsetY += 1) {
      for (let offsetX = 0; offsetX < thickness; offsetX += 1) {
        const localX = x + offsetX;
        const localY = y + offsetY;
        if (
          localX < 0 ||
          localX >= width ||
          localY < 0 ||
          localY >= height
        ) {
          continue;
        }
        const offset = (localY * width + localX) * 3;
        rgb[offset] = 20;
        rgb[offset + 1] = 20;
        rgb[offset + 2] = 20;
      }
    }
  }
}

function mixedWaveformAndTablePng() {
  const width = 760;
  const height = 420;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  let previous;
  for (let x = 25; x <= 365; x += 1) {
    const progress = (x - 25) / 340;
    const response = Math.max(
      Math.exp(-0.5 * ((progress - 0.25) / 0.04) ** 2),
      Math.exp(-0.5 * ((progress - 0.75) / 0.04) ** 2),
    );
    const y = Math.round(355 - response * 120);
    if (previous) {
      drawLine(
        rgb,
        width,
        height,
        previous.x,
        previous.y,
        x,
        y,
        3,
      );
    }
    previous = { x, y };
  }

  const table = {
    left: 430,
    top: 48,
    right: 720,
    bottom: 228,
  };
  for (let cell = 0; cell <= 5; cell += 1) {
    const x = Math.round(
      table.left +
        ((table.right - table.left) * cell) / 5,
    );
    const y = Math.round(
      table.top +
        ((table.bottom - table.top) * cell) / 5,
    );
    drawLine(
      rgb,
      width,
      height,
      x,
      table.top,
      x,
      table.bottom,
      2,
    );
    drawLine(
      rgb,
      width,
      height,
      table.left,
      y,
      table.right,
      y,
      2,
    );
  }
  return encodePng({
    width,
    height,
    data: rgb,
    channels: 3,
  });
}

test("accepts matching PNG and browser-style JPEG waveform provenance", async () => {
  for (const [mimeType, bytes] of [
    ["image/png", eightStatePng],
    ["image/jpeg", jpegFromPng(eightStatePng)],
  ]) {
    const result = await validateTrainingWaveformImage({
      bytes,
      mimeType,
      profile: eightState.profile,
      stateCount: eightState.stateCount,
    });
    assert.equal(result.panelCount, 1);
    assert.equal(result.stateCount, 8);
    assert.ok(result.profileSimilarity >= 0.9);
  }
});

test("keeps small detached labels out of provenance without rejecting the source preview", async () => {
  const clean = await validateTrainingWaveformImage({
    bytes: jpegFromPng(eightStatePng),
    mimeType: "image/jpeg",
    profile: eightState.profile,
    stateCount: eightState.stateCount,
  });

  for (let glyphCount = 1; glyphCount <= 4; glyphCount += 1) {
    const result = await validateTrainingWaveformImage({
      bytes: jpegFromPng(eightStatePng, glyphCount),
      mimeType: "image/jpeg",
      profile: eightState.profile,
      stateCount: eightState.stateCount,
    });
    assert.equal(result.panelCount, 1);
    assert.equal(result.stateCount, 8);
    assert.ok(
      result.profileSimilarity >= clean.profileSimilarity - 0.01,
      `${glyphCount} detached label glyphs changed the verified Curve profile`,
    );
    assert.ok(result.profileSimilarity >= 0.98);
  }
});

test("accepts a labeled source preview while verifying only its Curve provenance", async () => {
  const result = await validateTrainingWaveformImage({
    bytes: jpegFromPng(labeledFaultPng),
    mimeType: "image/jpeg",
    profile: labeledFault.profile,
    stateCount: labeledFault.stateCount,
  });
  assert.equal(result.panelCount, 1);
  assert.equal(result.fallbackUsed, false);
  assert.notEqual(result.detectionReason, "whole-image-fallback");
  assert.ok(result.profileSimilarity >= 0.95);
});

test("rejects a ready source that mixes one waveform with a table", async () => {
  await assert.rejects(
    () =>
      validateTrainingWaveformImage({
        bytes: mixedWaveformAndTablePng(),
        mimeType: "image/png",
        profile: eightState.profile,
        stateCount: eightState.stateCount,
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "distribution_waveform_not_found");
      return true;
    },
  );
});

test("rejects a shared-cell sparkline table before it can enter ready training", async () => {
  await assert.rejects(
    () =>
      validateTrainingWaveformImage({
        bytes: sparklineTablePng(),
        mimeType: "image/png",
        profile: eightState.profile,
        stateCount: eightState.stateCount,
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "distribution_waveform_not_found");
      return true;
    },
  );
});

test("rejects a shaded numeric table before ready training provenance", async () => {
  await assert.rejects(
    () =>
      validateTrainingWaveformImage({
        bytes: shadedNumericTablePng(),
        mimeType: "image/png",
        profile: eightState.profile,
        stateCount: eightState.stateCount,
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "distribution_waveform_not_found");
      return true;
    },
  );
});

test("rejects a valid waveform paired with an unrelated profile", async () => {
  await assert.rejects(
    () =>
      validateTrainingWaveformImage({
        bytes: eightStatePng,
        mimeType: "image/png",
        profile: fourState.profile,
        stateCount: fourState.stateCount,
      }),
    (error) => {
      assert.ok(error instanceof SimilarityApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "training_profile_image_mismatch");
      return true;
    },
  );
});

test("rejects nearby same-State profiles that do not come from the submitted image", async () => {
  for (const id of [
    "vth-08s-s0042-00003",
    "vth-08s-s0043-00009",
    "vth-08s-s0042-00006",
  ]) {
    const unrelated = corpus.candidates.find(
      (candidate) => candidate.id === id,
    );
    assert.ok(unrelated);
    await assert.rejects(
      () =>
        validateTrainingWaveformImage({
          bytes: eightStatePng,
          mimeType: "image/png",
          profile: unrelated.profile,
          stateCount: unrelated.stateCount,
        }),
      (error) => {
        assert.ok(error instanceof SimilarityApiError);
        assert.equal(error.status, 422);
        assert.equal(
          error.code,
          "training_profile_image_mismatch",
        );
        return true;
      },
      `${id} must not be accepted for ${eightState.id}`,
    );
  }
});

async function auditUiTrainingPath(candidates) {
  const failures = [];
  for (const candidate of candidates) {
    try {
      const sourceBytes = await readFile(
        new URL(`../public${candidate.image}`, import.meta.url),
      );
      const decoded = decodePng(sourceBytes);
      const source = {
        data: decoded.data,
        width: decoded.width,
        height: decoded.height,
        channels: decoded.channels,
      };
      const documentRaster = browserRaster(
        decoded.data,
        decoded.width,
        decoded.height,
        decoded.channels,
        1920,
        1200,
        2_100_000,
      );
      const detected = detectChartPanels(
        documentRaster.data,
        documentRaster.width,
        documentRaster.height,
        documentRaster.channels,
        { sourceScale: documentRaster.scale },
      );
      if (detected.panels.length !== 1) {
        failures.push({
          id: candidate.id,
          stage: "panel-count",
          actual: detected.panels.length,
        });
        continue;
      }
      const panel = detected.panels[0];
      const sourceBounds = uiSourceBounds(
        panel,
        documentRaster,
        source,
      );
      if (
        candidate.sourceCollection !==
          "vnand_fault_distributions_100" &&
        panel.detectionReason !== "whole-image-fallback" &&
        (sourceBounds.width / decoded.width < 0.9 ||
          sourceBounds.height / decoded.height < 0.9)
      ) {
        failures.push({
          id: candidate.id,
          stage: "partial-base-crop",
          widthCoverage: sourceBounds.width / decoded.width,
          heightCoverage: sourceBounds.height / decoded.height,
        });
        continue;
      }
      const useDetectedBounds =
        detected.panels.length > 1 ||
        panel.detectionReason !== "whole-image-fallback";
      const crop =
        !useDetectedBounds
          ? {
              pixels: decoded.data,
              width: decoded.width,
              height: decoded.height,
              channels: decoded.channels,
            }
          : {
              ...cropInterleavedPixels(
                decoded.data,
                decoded.width,
                decoded.height,
                decoded.channels,
                sourceBounds,
              ),
              channels: decoded.channels,
            };
      const analysis = analyzeUiCrop(crop);
      const sourceJpeg = sanitizedUiPreviewJpeg(
        source,
        crop,
        useDetectedBounds,
      );
      const localVerification =
        await validateTrainingWaveformImage({
          bytes: sourceJpeg,
          mimeType: "image/jpeg",
          profile: analysis.profile,
          stateCount: analysis.descriptor.stateCount,
        });
      assertAuthoritativeVerification(
        localVerification,
        analysis.profile,
      );
      const learnedCandidate = buildLearnedCandidate({
        id: `shared-audit-${candidate.id}`,
        label: candidate.label,
        image: "",
        profile: analysis.profile,
        descriptor: analysis.descriptor,
        storage: "shared",
      });
      const sharedPayload = buildSharedTrainingApiPayload(
        learnedCandidate,
        analysis.descriptor,
        {
          contributorToken: "a".repeat(43),
          deletionToken: "b".repeat(43),
          consentVersion: SHARED_TRAINING_CONSENT_VERSION,
        },
      );
      const normalizedSharedPayload =
        validateSharedTrainingPayload(sharedPayload);
      const sharedVerification =
        await validateTrainingWaveformImage({
          bytes: sourceJpeg,
          mimeType: "image/jpeg",
          profile: normalizedSharedPayload.profile,
          stateCount:
            normalizedSharedPayload.descriptor.stateCount,
        });
      assertAuthoritativeVerification(
        sharedVerification,
        normalizedSharedPayload.profile,
      );
    } catch (error) {
      failures.push({
        id: candidate.id,
        stage: "ready-validator",
        code:
          error instanceof SimilarityApiError
            ? error.code
            : "unexpected_error",
        message:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }
  return failures;
}

const generatedCandidates = corpus.candidates.filter(
  (candidate) =>
    candidate.sourceCollection !==
    "vnand_fault_distributions_100",
);
const faultCandidates = corpus.candidates.filter(
  (candidate) =>
    candidate.sourceCollection ===
    "vnand_fault_distributions_100",
);
assert.equal(generatedCandidates.length, 96);
assert.equal(faultCandidates.length, 100);

test("keeps scale-sensitive generated charts intact through the actual UI raster path", async () => {
  const regressionIds = new Set([
    "vth-02s-s0042-00003",
    "vth-02s-s0043-00017",
    "vth-16s-s0042-00006",
  ]);
  const regressions = generatedCandidates.filter((candidate) =>
    regressionIds.has(candidate.id),
  );
  assert.equal(regressions.length, regressionIds.size);
  assert.deepEqual(await auditUiTrainingPath(regressions), []);
});

test("accepts fault 096 through UI analysis and its sanitized JPEG provenance", async () => {
  const regression = faultCandidates.find(
    (candidate) => candidate.id === "vnand-fault-096",
  );
  assert.ok(regression);
  assert.deepEqual(await auditUiTrainingPath([regression]), []);
});

for (const [label, candidates] of [
  ["generated", generatedCandidates],
  ["labeled fault", faultCandidates],
]) {
  for (let start = 0; start < candidates.length; start += 24) {
    const batch = candidates.slice(start, start + 24);
    test(`accepts ${label} corpus charts ${start + 1}-${start + batch.length} through the UI crop-to-JPEG ready path`, async () => {
      assert.deepEqual(
        await auditUiTrainingPath(batch),
        [],
      );
    });
  }
}
