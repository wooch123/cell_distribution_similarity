/**
 * @param {unknown} value
 * @param {string} fallback
 */
export function normalizeAnonymousCode(value, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

/**
 * @param {number} value
 */
function roundScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.min(1, Math.max(0, value)).toFixed(6));
}

/**
 * Build the privacy-preserving schema-v3 report consumed by the Python
 * consensus and reranker pipeline. Raw image data and filenames are omitted.
 *
 * @param {{
 *   analysis: Record<string, any>;
 *   corpus: Record<string, any>;
 *   results: Record<string, any>[];
 *   feedback: Record<string, "similar" | "dissimilar">;
 *   queryCode: string;
 *   annotatorId: string;
 *   createdAt?: string;
 *   normalizedShapeShared?: boolean;
 * }} input
 */
export function buildFeedbackPayload(input) {
  const {
    analysis,
    corpus,
    results,
    feedback,
    queryCode,
    annotatorId,
  } = input;
  const judgments = results
    .filter((result) => feedback[result.id])
    .map((result) => ({
      candidate_id: result.id,
      rank: result.rank,
      relevance: feedback[result.id],
      state_count: result.stateCount,
      score: roundScore(result.score),
      model_score:
        result.modelScore === null ? null : roundScore(result.modelScore),
      image_score: roundScore(result.imageScore),
      curve_score: roundScore(result.curveScore),
      peak_count_score: roundScore(result.countScore),
      location_score: roundScore(result.locationScore),
      width_score: roundScore(result.widthScore),
      area_score: roundScore(result.areaScore),
      valley_score: roundScore(result.valleyScore),
      tail_score: roundScore(result.tailScore),
      peak_valley_score: roundScore(result.peakValleyScore),
      reasons: [...result.reasons],
    }));
  if (!judgments.length) {
    throw new Error("At least one relevance judgment is required");
  }

  const roundVector = (values) => values.map(roundScore);
  const fallbackQueryId = `Q-${String(analysis.id).slice(0, 8)}`;
  const fallbackAnnotatorId = "A-ANONYMOUS";
  return {
    schema_version: 3,
    report_type: "vth-expert-relevance",
    created_at: input.createdAt ?? new Date().toISOString(),
    privacy: {
      query_image_included: false,
      original_filename_included: false,
      external_upload_performed: false,
      normalized_shape_features_included: true,
      normalized_shape_shared: input.normalizedShapeShared === true,
    },
    annotator: {
      id: normalizeAnonymousCode(annotatorId, fallbackAnnotatorId),
      anonymous: true,
      id_scope: "browser-device",
    },
    query: {
      id: normalizeAnonymousCode(queryCode, fallbackQueryId),
      y_scale: "log10",
      detected_state_count: analysis.descriptor.stateCount,
      observed_state_count: analysis.descriptor.observedStateCount,
      state_count_regularized: analysis.descriptor.regularized,
      axes_detected: analysis.axesDetected,
      profile: roundVector(analysis.profile),
      descriptor: {
        peak_locations: roundVector(analysis.descriptor.peakLocations),
        peak_widths: roundVector(analysis.descriptor.peakWidths),
        valley_heights: roundVector(analysis.descriptor.valleyHeights),
        valley_locations: roundVector(analysis.descriptor.valleyLocations),
        valley_depths: roundVector(analysis.descriptor.valleyDepths),
        valley_position_ratios: roundVector(
          analysis.descriptor.valleyPositionRatios,
        ),
        peak_valley_distances: roundVector(
          analysis.descriptor.peakValleyDistances,
        ),
        tail_slopes: roundVector(analysis.descriptor.tailSlopes),
        area: roundScore(analysis.descriptor.area),
      },
    },
    corpus: {
      version: corpus.version,
      candidate_count: corpus.candidateCount,
      state_counts: [...corpus.stateCounts],
      reranker_version: corpus.reranker?.version ?? null,
    },
    judgments,
  };
}
