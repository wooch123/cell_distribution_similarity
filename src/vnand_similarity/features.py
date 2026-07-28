"""Image and curve embeddings for axis-free VTH graph matching."""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np
from scipy.integrate import trapezoid
from scipy.signal import find_peaks, savgol_filter

from .imaging import PreprocessResult, standardize_graph_image
from .synthetic import DEFAULT_LOG_Y_FLOOR, SyntheticVthSample

CURVE_EMBEDDING_DIMENSIONS = 384
CANONICAL_IMAGE_EMBEDDING_DIMENSIONS = 3200
FUSED_SHAPE_EMBEDDING_DIMENSIONS = (
    CURVE_EMBEDDING_DIMENSIONS + CANONICAL_IMAGE_EMBEDDING_DIMENSIONS
)


@dataclass(frozen=True)
class FeatureBundle:
    image_embedding: np.ndarray
    curve_embedding: np.ndarray
    descriptor: dict[str, Any]
    preprocessing: dict[str, Any]
    alternative_curve_embeddings: tuple[np.ndarray, ...] = ()
    alternative_descriptors: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class CurveFeatureBundle:
    curve_embedding: np.ndarray
    descriptor: dict[str, Any]


def _unit(vector: np.ndarray) -> np.ndarray:
    vector = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if norm <= np.finfo(np.float32).eps:
        return vector
    return vector / norm


def cosine_similarity(left: np.ndarray, right: np.ndarray) -> float:
    left_unit = _unit(left)
    right_unit = _unit(right)
    if left_unit.size != right_unit.size:
        raise ValueError("Embedding dimensions do not match")
    return float(np.clip(np.dot(left_unit, right_unit), -1.0, 1.0))


def aligned_curve_similarity(
    left: np.ndarray,
    right: np.ndarray,
    *,
    max_shift: int = 10,
) -> float:
    """Compare curve/profile derivatives while tolerating small x translations."""

    left = np.asarray(left, dtype=np.float32).reshape(-1)
    right = np.asarray(right, dtype=np.float32).reshape(-1)
    if left.size != right.size:
        raise ValueError("Curve embeddings must have equal dimensions")
    if left.size % 3 or left.size < 12:
        return cosine_similarity(left, right)
    segment_size = left.size // 3
    if max_shift < 0:
        raise ValueError("max_shift is outside the supported range")
    max_shift = min(max_shift, max(segment_size // 2 - 1, 0))

    left_segments = np.split(left, 3)
    right_segments = np.split(right, 3)
    segment_weights = (0.72, 0.20, 0.08)
    best = -1.0
    for shift in range(-max_shift, max_shift + 1):
        if shift < 0:
            left_slice = slice(-shift, segment_size)
            right_slice = slice(0, segment_size + shift)
        elif shift > 0:
            left_slice = slice(0, segment_size - shift)
            right_slice = slice(shift, segment_size)
        else:
            left_slice = slice(0, segment_size)
            right_slice = slice(0, segment_size)
        score = sum(
            weight * cosine_similarity(left_segment[left_slice], right_segment[right_slice])
            for weight, left_segment, right_segment in zip(
                segment_weights,
                left_segments,
                right_segments,
            )
        )
        best = max(best, float(score))
    return float(np.clip(best, -1.0, 1.0))


def _curve_hypotheses(
    bundle: FeatureBundle,
) -> tuple[tuple[np.ndarray, dict[str, Any]], ...]:
    if len(bundle.alternative_curve_embeddings) != len(bundle.alternative_descriptors):
        raise ValueError("Alternative curve embeddings and descriptors must align")
    return (
        (bundle.curve_embedding, bundle.descriptor),
        *tuple(
            zip(
                bundle.alternative_curve_embeddings,
                bundle.alternative_descriptors,
            )
        ),
    )


def _best_curve_hypothesis_pair(
    query: FeatureBundle,
    candidate: FeatureBundle,
) -> tuple[float, dict[str, Any], dict[str, Any]]:
    best_score = -1.0
    best_query_descriptor = query.descriptor
    best_candidate_descriptor = candidate.descriptor
    for query_embedding, query_descriptor in _curve_hypotheses(query):
        for candidate_embedding, candidate_descriptor in _curve_hypotheses(candidate):
            score = aligned_curve_similarity(
                query_embedding,
                candidate_embedding,
            )
            if score > best_score:
                best_score = score
                best_query_descriptor = query_descriptor
                best_candidate_descriptor = candidate_descriptor
    return best_score, best_query_descriptor, best_candidate_descriptor


def best_aligned_curve_similarity(
    query: FeatureBundle,
    candidate: FeatureBundle,
) -> float:
    score, _, _ = _best_curve_hypothesis_pair(query, candidate)
    return score


def _image_embedding(mask: np.ndarray) -> np.ndarray:
    small = cv2.resize(mask, (64, 32), interpolation=cv2.INTER_AREA)
    blurred = cv2.GaussianBlur(mask.astype(np.float32), (5, 5), 0.8)
    gradient_x = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3)
    magnitude, angle = cv2.cartToPolar(gradient_x, gradient_y, angleInDegrees=False)

    cell_rows, cell_columns, bins = 8, 16, 9
    row_edges = np.linspace(0, mask.shape[0], cell_rows + 1, dtype=int)
    column_edges = np.linspace(0, mask.shape[1], cell_columns + 1, dtype=int)
    histograms = []
    bin_ids = np.floor((angle % np.pi) / np.pi * bins).astype(int)
    bin_ids = np.clip(bin_ids, 0, bins - 1)
    for row in range(cell_rows):
        for column in range(cell_columns):
            row_slice = slice(row_edges[row], row_edges[row + 1])
            column_slice = slice(column_edges[column], column_edges[column + 1])
            histogram = np.bincount(
                bin_ids[row_slice, column_slice].reshape(-1),
                weights=magnitude[row_slice, column_slice].reshape(-1),
                minlength=bins,
            ).astype(np.float32)
            histograms.append(_unit(histogram))
    hog = np.concatenate(histograms)
    return _unit(np.concatenate([small.reshape(-1), hog]))


def _curve_profile(mask: np.ndarray) -> np.ndarray:
    height, width = mask.shape
    profile = np.full(width, np.nan, dtype=np.float64)
    for column in range(width):
        values = mask[:, column]
        active = np.flatnonzero(values >= max(0.12, float(values.max()) * 0.28))
        if len(active):
            top_edge = float(np.quantile(active, 0.08))
            profile[column] = 1.0 - top_edge / max(height - 1, 1)

    valid = np.flatnonzero(np.isfinite(profile))
    if len(valid) == 0:
        return np.zeros(width, dtype=np.float32)
    profile = np.interp(np.arange(width), valid, profile[valid], left=0.0, right=0.0)
    # Keep the window narrower than the ~16 px State spacing of a 16-State
    # profile after 256-point normalization.
    window = min(9, width if width % 2 else width - 1)
    if window >= 5:
        profile = savgol_filter(profile, window_length=window, polyorder=2, mode="interp")
    profile = np.clip(profile, 0.0, None)
    peak = float(profile.max())
    if peak > 0:
        profile /= peak
    return profile.astype(np.float32)


def _find_peaks_with_edges(
    profile: np.ndarray,
    *,
    prominence: float,
    distance: int,
    height: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Find internal and plot-boundary peaks.

    Low-state-count VTH plots often place erase/P-state maxima very close to
    the left or right plot frame. ``scipy.signal.find_peaks`` intentionally
    excludes endpoints, so the physical edge State needs an explicit check.
    """

    internal, properties = find_peaks(
        profile,
        prominence=prominence,
        distance=distance,
        height=height,
    )
    candidates = {
        int(index): float(value)
        for index, value in zip(internal, properties["prominences"])
    }
    edge_span = max(distance * 2, len(profile) // 10)
    for mirrored in (False, True):
        values = profile[::-1] if mirrored else profile
        local_index = int(np.argmax(values[:edge_span]))
        peak_index = len(profile) - 1 - local_index if mirrored else local_index
        if any(abs(peak_index - existing) < distance for existing in candidates):
            continue
        inner_stop = min(
            len(values),
            local_index + max(edge_span * 2, len(profile) // 2),
        )
        floor = float(np.min(values[local_index:inner_stop]))
        edge_prominence = float(values[local_index] - floor)
        if float(values[local_index]) >= height and edge_prominence >= prominence:
            candidates[peak_index] = edge_prominence
    ordered = sorted(candidates)
    return (
        np.asarray(ordered, dtype=int),
        np.asarray([candidates[index] for index in ordered], dtype=float),
    )


def _regularize_state_count(observed_count: int, candidate_count: int) -> int:
    """Map noisy peak evidence to supported NAND state counts.

    Publication screenshots often weaken several peaks through resampling or
    JPEG compression.  The stricter observed count remains the primary signal,
    while the permissive candidate count may rescue QLC only when at least 15
    of its 16 peaks are still visible.  Lower-state plots are more vulnerable
    to axes and text being mistaken for one extra peak, so they are not
    promoted from permissive evidence alone.
    """

    supported_state_counts = [2, 4, 8, 16]
    if observed_count < 2:
        return observed_count
    if observed_count == 3 and 5 <= candidate_count <= 7:
        return 4
    # Seven strong peaks are a common partial-TLC signature when S0 is
    # omitted. Fifteen permissive candidates alone are too ambiguous to call
    # QLC; require all sixteen candidates for that special promotion.
    if observed_count == 7 and candidate_count == 15:
        return 8
    state_count = min(
        supported_state_counts,
        key=lambda count: (abs(count - observed_count), count),
    )
    if state_count < 16 and candidate_count >= 15:
        state_count = 16
    return state_count


def _curve_descriptor(profile: np.ndarray) -> dict[str, Any]:
    observed_peaks, _ = _find_peaks_with_edges(
        profile,
        prominence=0.05,
        distance=max(5, len(profile) // 24),
        height=0.18,
    )
    candidate_peaks, candidate_prominences = _find_peaks_with_edges(
        profile,
        prominence=0.006,
        distance=max(5, len(profile) // 28),
        height=0.12,
    )
    observed_count = len(observed_peaks)
    candidate_count = len(candidate_peaks)
    state_count = _regularize_state_count(observed_count, candidate_count)
    candidate_spacings = np.diff(candidate_peaks)
    spacing_median = (
        float(np.median(candidate_spacings))
        if len(candidate_spacings)
        else 0.0
    )
    dense_eight_state_layout = bool(
        4 <= observed_count <= 7
        and 8 <= candidate_count <= 10
        and int(candidate_peaks[-1] - candidate_peaks[0])
        >= len(profile) * 0.62
        and spacing_median > 0
        and float(np.max(candidate_spacings)) <= spacing_median * 1.8
        and float(np.min(candidate_spacings)) >= spacing_median * 0.4
    )
    # Strongly overlapping TLC states can leave only four to seven peaks above
    # the strict prominence threshold even though eight evenly spaced maxima
    # remain in the permissive trace. Marker clusters have a few very large
    # inter-cluster gaps instead, so the spacing gate keeps those as four-State.
    if dense_eight_state_layout:
        state_count = 8

    if state_count and len(candidate_peaks) >= state_count:
        if dense_eight_state_layout and len(candidate_peaks) > state_count:
            full_span = max(
                int(candidate_peaks[-1] - candidate_peaks[0]),
                1,
            )

            def layout_cost(indices: tuple[int, ...]) -> float:
                selected = candidate_peaks[np.asarray(indices, dtype=int)]
                spacings = np.diff(selected).astype(float)
                mean_spacing = max(float(np.mean(spacings)), 1.0)
                lost_span = (
                    full_span - int(selected[-1] - selected[0])
                ) / max(len(profile) - 1, 1)
                return float(np.std(spacings) / mean_spacing + 0.15 * lost_span)

            structured = min(
                combinations(range(len(candidate_peaks)), state_count),
                key=layout_cost,
            )
            peaks = candidate_peaks[np.asarray(structured, dtype=int)]
        else:
            strongest = np.argsort(candidate_prominences)[-state_count:]
            peaks = np.sort(candidate_peaks[strongest])
    else:
        peaks = observed_peaks

    if len(peaks):
        widths = []
        prominences = []
        for peak_index, peak in enumerate(peaks):
            left_boundary = int(peaks[peak_index - 1]) if peak_index else 0
            right_boundary = (
                int(peaks[peak_index + 1])
                if peak_index + 1 < len(peaks)
                else len(profile) - 1
            )
            left_floor = float(np.min(profile[left_boundary : int(peak) + 1]))
            right_floor = float(np.min(profile[int(peak) : right_boundary + 1]))
            if int(peak) == 0:
                local_floor = right_floor
            elif int(peak) == len(profile) - 1:
                local_floor = left_floor
            else:
                local_floor = max(left_floor, right_floor)
            local_prominence = max(0.0, float(profile[peak]) - local_floor)
            prominences.append(local_prominence)

            half_height = local_floor + local_prominence * 0.5
            left = int(peak)
            right = int(peak)
            while left > left_boundary and float(profile[left]) > half_height:
                left -= 1
            while right < right_boundary and float(profile[right]) > half_height:
                right += 1
            widths.append((right - left) / len(profile))
        widths = np.asarray(widths, dtype=float)
        prominences = np.asarray(prominences, dtype=float)
        locations = peaks / max(len(profile) - 1, 1)
        heights = profile[peaks]
    else:
        widths = np.asarray([], dtype=float)
        prominences = np.asarray([], dtype=float)
        locations = np.asarray([], dtype=float)
        heights = np.asarray([], dtype=float)

    valley_heights = []
    valley_locations = []
    valley_depths = []
    valley_position_ratios = []
    peak_valley_distances = []
    tail_slopes = []
    for left_peak, right_peak in zip(peaks[:-1], peaks[1:]):
        segment = profile[left_peak : right_peak + 1]
        valley_index = int(left_peak + np.argmin(segment))
        valley_height = float(profile[valley_index])
        valley_heights.append(valley_height)
        left_distance = max(valley_index - int(left_peak), 1)
        right_distance = max(int(right_peak) - valley_index, 1)
        peak_gap = max(int(right_peak) - int(left_peak), 1)
        adjacent_peak_floor = min(
            float(profile[left_peak]),
            float(profile[right_peak]),
        )
        valley_locations.append(
            float(valley_index / max(len(profile) - 1, 1))
        )
        valley_depths.append(max(0.0, adjacent_peak_floor - valley_height))
        valley_position_ratios.append(float(left_distance / peak_gap))
        peak_valley_distances.extend(
            [
                float(left_distance / max(len(profile) - 1, 1)),
                float(right_distance / max(len(profile) - 1, 1)),
            ]
        )
        tail_slopes.extend(
            [
                float((profile[left_peak] - valley_height) / left_distance),
                float((profile[right_peak] - valley_height) / right_distance),
            ]
        )

    derivative = np.diff(profile)
    center_of_mass = float(
        np.dot(np.linspace(0.0, 1.0, len(profile)), profile)
        / max(float(profile.sum()), np.finfo(float).eps)
    )
    return {
        "peak_count": int(state_count),
        "observed_peak_count": observed_count,
        "candidate_peak_count": candidate_count,
        "state_count_regularized": bool(state_count != observed_count),
        "state_count_confidence": float(
            np.exp(-abs(state_count - observed_count) / max(state_count, 1))
        ),
        "peak_locations": [float(value) for value in locations],
        "peak_heights": [float(value) for value in heights],
        "peak_widths": [float(value) for value in widths],
        "peak_prominences": [float(value) for value in prominences],
        "valley_heights": valley_heights,
        "valley_locations": valley_locations,
        "valley_depths": valley_depths,
        "valley_position_ratios": valley_position_ratios,
        "peak_valley_distances": peak_valley_distances,
        "tail_slopes": tail_slopes,
        "area": float(trapezoid(profile) / max(len(profile) - 1, 1)),
        "center_of_mass": center_of_mass,
        "roughness": float(np.mean(np.abs(derivative))),
    }


def curve_embedding_from_profile(profile: np.ndarray) -> np.ndarray:
    """Encode a normalized log-scale profile as Curve, slope, and curvature.

    This is intentionally public because the learned dual encoder and the
    browser runtime must use the exact same 384-value input representation.
    """

    positions = np.linspace(0, len(profile) - 1, 128)
    resampled = np.interp(positions, np.arange(len(profile)), profile)
    first = np.gradient(resampled)
    second = np.gradient(first)
    return _unit(
        np.concatenate(
            [
                _unit(resampled),
                _unit(first),
                _unit(second),
            ]
        )
    )


def canonical_image_embedding_from_profile(profile: np.ndarray) -> np.ndarray:
    """Encode an axis-free Curve as a canonical 2D image and spatial HOG.

    The browser uses the same deterministic construction.  A soft 64×32
    raster contributes 2,048 values and an 8×16×9 spatial orientation
    histogram contributes 1,152 values.  Rendering from the normalized Curve
    deliberately removes source color, stroke, grid, and resolution while
    retaining the visual peak/valley/tail geometry.
    """

    values = np.asarray(profile, dtype=np.float64).reshape(-1)
    if values.size < 2 or np.any(~np.isfinite(values)):
        raise ValueError("Canonical image profiles must contain finite values")
    values = np.clip(values, 0.0, None)
    peak = float(np.max(values))
    if peak > np.finfo(float).eps:
        values = values / peak

    raster_profile = np.interp(
        np.linspace(0, values.size - 1, 64),
        np.arange(values.size),
        values,
    )
    raster_y = (1.0 - raster_profile) * 31.0
    rows = np.arange(32, dtype=np.float64)[:, None]
    raster = np.exp(-0.5 * ((rows - raster_y[None, :]) / 0.8) ** 2)

    hog_profile = np.interp(
        np.linspace(0, values.size - 1, 256),
        np.arange(values.size),
        values,
    )
    hog_y = (1.0 - hog_profile) * 127.0
    histograms = np.zeros((8, 16, 9), dtype=np.float64)
    for index in range(255):
        delta_y = float(hog_y[index + 1] - hog_y[index])
        midpoint_y = float((hog_y[index + 1] + hog_y[index]) * 0.5)
        row = min(7, max(0, int(midpoint_y // 16)))
        column = min(15, index // 16)
        # Image gradients are perpendicular to the Curve tangent.  Use an
        # unsigned 0..pi orientation exactly like a conventional HOG channel.
        angle = (np.arctan2(delta_y, 1.0) + np.pi * 0.5) % np.pi
        bin_position = float(angle / np.pi * 9.0)
        lower = int(np.floor(bin_position)) % 9
        fraction = bin_position - np.floor(bin_position)
        upper = (lower + 1) % 9
        magnitude = float(np.hypot(delta_y, 1.0))
        histograms[row, column, lower] += magnitude * (1.0 - fraction)
        histograms[row, column, upper] += magnitude * fraction

    flat_histograms = []
    for histogram in histograms.reshape(-1, 9):
        flat_histograms.append(_unit(histogram))
    embedding = _unit(
        np.concatenate(
            [
                raster.astype(np.float32).reshape(-1),
                0.25 * np.concatenate(flat_histograms),
            ]
        )
    )
    if embedding.shape != (CANONICAL_IMAGE_EMBEDDING_DIMENSIONS,):
        raise AssertionError("Canonical image embedding dimensions changed")
    return embedding


def fused_shape_embedding_from_profile(profile: np.ndarray) -> np.ndarray:
    """Join canonical image and Curve views with equal unit-norm weighting."""

    return _unit(
        np.concatenate(
            [
                canonical_image_embedding_from_profile(profile),
                curve_embedding_from_profile(profile),
            ]
        )
    )


def fused_shape_embedding_from_curve_embedding(
    curve_embedding: np.ndarray,
) -> np.ndarray:
    """Recover the normalized profile view from a stored 384-D Curve vector."""

    curve = np.asarray(curve_embedding, dtype=np.float64).reshape(-1)
    if curve.shape != (CURVE_EMBEDDING_DIMENSIONS,) or np.any(
        ~np.isfinite(curve)
    ):
        raise ValueError("Stored Curve embedding must contain 384 finite values")
    profile = np.clip(curve[:128], 0.0, None)
    peak = float(np.max(profile))
    if peak <= np.finfo(float).eps:
        raise ValueError("Stored Curve embedding has no recoverable profile")
    profile = profile / peak
    return _unit(
        np.concatenate(
            [
                canonical_image_embedding_from_profile(profile),
                curve,
            ]
        )
    )


# Preserve compatibility with existing callers while new code adopts the
# explicit public API above.
_curve_embedding = curve_embedding_from_profile


def curve_features_from_profile(profile: np.ndarray) -> CurveFeatureBundle:
    """Build the exact offline feature bundle for one canonical browser Curve."""

    canonical = np.asarray(profile, dtype=np.float64).reshape(-1)
    if canonical.size != 256:
        raise ValueError("Canonical Curve profiles must contain 256 points")
    if np.any(~np.isfinite(canonical)):
        raise ValueError("Canonical Curve profiles must contain finite values")
    if float(np.min(canonical)) < 0.0 or float(np.max(canonical)) > 1.5:
        raise ValueError("Canonical Curve profile values are outside [0, 1.5]")
    if float(np.max(canonical) - np.min(canonical)) < 0.05:
        raise ValueError("Canonical Curve profile has insufficient shape variation")
    canonical = canonical.astype(np.float32)
    return CurveFeatureBundle(
        curve_embedding=curve_embedding_from_profile(canonical),
        descriptor=_curve_descriptor(canonical),
    )


def extract_log_curve_features(sample: SyntheticVthSample) -> CurveFeatureBundle:
    """Create the offline Curve embedding directly from raw VTH values."""

    canonical_profile = sample.metadata.get("canonical_profile")
    if canonical_profile is not None:
        return curve_features_from_profile(
            np.asarray(canonical_profile, dtype=np.float64)
        )

    y_floor = float(sample.metadata.get("y_floor", DEFAULT_LOG_Y_FLOOR))
    composite = np.asarray(sample.composite_curve, dtype=np.float64)
    clipped = np.clip(composite, y_floor, None)
    log_floor = float(np.log10(y_floor))
    log_peak = float(np.log10(max(float(np.max(clipped)), y_floor * 10)))
    denominator = max(log_peak - log_floor, np.finfo(float).eps)
    normalized = (np.log10(clipped) - log_floor) / denominator
    normalized = np.clip(normalized, 0.0, 1.0)
    positions = np.linspace(0, len(normalized) - 1, 256)
    profile = np.interp(positions, np.arange(len(normalized)), normalized).astype(np.float32)
    return curve_features_from_profile(profile)


def extract_features_from_preprocessed(result: PreprocessResult) -> FeatureBundle:
    profile = _curve_profile(result.mask)
    return FeatureBundle(
        image_embedding=_image_embedding(result.mask),
        curve_embedding=curve_embedding_from_profile(profile),
        descriptor=_curve_descriptor(profile),
        preprocessing=result.diagnostics,
    )


def extract_features(
    image_path: Path,
    *,
    preview_path: Optional[Path] = None,
) -> FeatureBundle:
    result = standardize_graph_image(
        image_path,
        preview_path=preview_path,
        preserve_plot_coordinates=True,
    )
    plot_bundle = extract_features_from_preprocessed(result)
    bundle = plot_bundle
    probe_state_count = int(plot_bundle.descriptor.get("peak_count", 0))
    use_content_coordinates = (
        result.diagnostics.get("plot_box_source") == "image-frame"
        and bool(result.diagnostics.get("plot_coordinates_preserved"))
        and 0 < probe_state_count <= 4
    )
    if use_content_coordinates:
        result = standardize_graph_image(
            image_path,
            preview_path=preview_path,
            preserve_plot_coordinates=False,
        )
        content_bundle = extract_features_from_preprocessed(result)
        state_fields = (
            "peak_count",
            "observed_peak_count",
            "candidate_peak_count",
            "state_count_regularized",
            "state_count_confidence",
        )
        bundle = FeatureBundle(
            image_embedding=content_bundle.image_embedding,
            curve_embedding=content_bundle.curve_embedding,
            descriptor={
                **content_bundle.descriptor,
                **{
                    field: plot_bundle.descriptor[field]
                    for field in state_fields
                },
            },
            preprocessing=content_bundle.preprocessing,
        )
        selection = "content-normalized-low-state"
    else:
        selection = "plot-frame-high-state"

    alternative_curve_embeddings: tuple[np.ndarray, ...] = ()
    alternative_descriptors: tuple[dict[str, Any], ...] = ()
    alternative_summary: list[dict[str, Any]] = []
    selected_descriptor = bundle.descriptor
    state_count_hypothesis_source = "primary"
    if result.diagnostics.get("plot_box_source") == "image-frame":
        alternative_result = standardize_graph_image(
            image_path,
            preserve_plot_coordinates=not use_content_coordinates,
            extraction_preference="aggressive-edge",
        )
        alternative_bundle = extract_features_from_preprocessed(alternative_result)
        alternative_state_count = int(
            alternative_bundle.descriptor.get("peak_count", 0)
        )
        primary_state_count = int(bundle.descriptor.get("peak_count", 0))
        primary_valley_depths = [
            float(value)
            for value in bundle.descriptor.get("valley_depths", [])
        ]
        primary_is_dense_shallow_eight = bool(
            primary_state_count == 8
            and len(primary_valley_depths) == 7
            and max(primary_valley_depths, default=1.0) <= 0.20
        )
        alternative_is_compatible = (
            primary_state_count not in {2, 4, 8, 16}
            or alternative_state_count == primary_state_count
            or not primary_is_dense_shallow_eight
        )
        if (
            alternative_state_count in {2, 4, 8, 16}
            and alternative_is_compatible
        ):
            alternative_curve_embeddings = (alternative_bundle.curve_embedding,)
            alternative_descriptors = (alternative_bundle.descriptor,)
            alternative_summary.append(
                {
                    "curve_extraction_mode": alternative_bundle.preprocessing[
                        "curve_extraction_mode"
                    ],
                    "peak_count": int(
                        alternative_bundle.descriptor["peak_count"]
                    ),
                    "observed_peak_count": int(
                        alternative_bundle.descriptor["observed_peak_count"]
                    ),
                }
            )
            primary_regularized = bool(
                bundle.descriptor.get("state_count_regularized")
            )
            alternative_regularized = bool(
                alternative_bundle.descriptor.get("state_count_regularized")
            )
            if (
                primary_state_count not in {2, 4, 8, 16}
                or (primary_regularized and not alternative_regularized)
            ):
                state_fields = (
                    "peak_count",
                    "observed_peak_count",
                    "candidate_peak_count",
                    "state_count_regularized",
                    "state_count_confidence",
                )
                selected_descriptor = {
                    **bundle.descriptor,
                    **{
                        field: alternative_bundle.descriptor[field]
                        for field in state_fields
                    },
                }
                state_count_hypothesis_source = "aggressive-edge"

    return FeatureBundle(
        image_embedding=bundle.image_embedding,
        curve_embedding=bundle.curve_embedding,
        descriptor=selected_descriptor,
        preprocessing={
            **bundle.preprocessing,
            "coordinate_mode_selection": selection,
            "plot_frame_probe_state_count": probe_state_count,
            "alternative_curve_hypotheses": alternative_summary,
            "state_count_hypothesis_source": state_count_hypothesis_source,
        },
        alternative_curve_embeddings=alternative_curve_embeddings,
        alternative_descriptors=alternative_descriptors,
    )


def _sequence_distance(left: list, right: list, fallback: float = 1.0) -> float:
    if not left or not right:
        return 0.0 if not left and not right else fallback
    left_array = np.asarray(left, dtype=float)
    right_array = np.asarray(right, dtype=float)
    sample_count = max(len(left_array), len(right_array))
    positions = np.linspace(0.0, 1.0, sample_count)
    left_resampled = np.interp(positions, np.linspace(0.0, 1.0, len(left_array)), left_array)
    right_resampled = np.interp(positions, np.linspace(0.0, 1.0, len(right_array)), right_array)
    return float(np.mean(np.abs(left_resampled - right_resampled)))


def _peak_valley_relations(
    descriptor: dict[str, Any],
) -> tuple[list[float], list[float], list[float]]:
    """Return depth, horizontal distance and valley-position relations.

    Existing SQLite indexes predate the explicit relation fields. Derive a
    compatible approximation from their peak heights, valley heights and tail
    slopes so retrieval remains usable before an index refresh.
    """

    explicit_depths = descriptor.get("valley_depths")
    explicit_distances = descriptor.get("peak_valley_distances")
    explicit_ratios = descriptor.get("valley_position_ratios")
    if (
        isinstance(explicit_depths, list)
        and isinstance(explicit_distances, list)
        and isinstance(explicit_ratios, list)
    ):
        return explicit_depths, explicit_distances, explicit_ratios

    valleys = [float(value) for value in descriptor.get("valley_heights", [])]
    peak_heights = [
        float(value) for value in descriptor.get("peak_heights", [])
    ]
    slopes = [float(value) for value in descriptor.get("tail_slopes", [])]
    depths = []
    distances = []
    ratios = []
    for index, valley_height in enumerate(valleys):
        if index + 1 < len(peak_heights):
            left_depth = max(0.0, peak_heights[index] - valley_height)
            right_depth = max(
                0.0,
                peak_heights[index + 1] - valley_height,
            )
            depths.append(min(left_depth, right_depth))
        else:
            left_depth = right_depth = max(0.0, 1.0 - valley_height)
            depths.append(left_depth)
        left_slope = slopes[index * 2] if index * 2 < len(slopes) else 0.0
        right_slope = (
            slopes[index * 2 + 1]
            if index * 2 + 1 < len(slopes)
            else 0.0
        )
        left_distance = (
            left_depth / left_slope / 256.0
            if left_slope > np.finfo(float).eps
            else 0.0
        )
        right_distance = (
            right_depth / right_slope / 256.0
            if right_slope > np.finfo(float).eps
            else 0.0
        )
        distances.extend([left_distance, right_distance])
        total_distance = left_distance + right_distance
        ratios.append(
            left_distance / total_distance
            if total_distance > np.finfo(float).eps
            else 0.5
        )
    return depths, distances, ratios


def similarity_components(query: FeatureBundle, candidate: FeatureBundle) -> dict[str, float]:
    (
        curve_similarity,
        query_descriptor,
        candidate_descriptor,
    ) = _best_curve_hypothesis_pair(query, candidate)
    peak_count_gap = abs(
        int(query_descriptor["peak_count"]) - int(candidate_descriptor["peak_count"])
    )
    query_depths, query_distances, query_ratios = _peak_valley_relations(
        query_descriptor
    )
    candidate_depths, candidate_distances, candidate_ratios = (
        _peak_valley_relations(candidate_descriptor)
    )
    valley_depth_similarity = float(
        np.exp(
            -10.0
            * _sequence_distance(
                query_depths,
                candidate_depths,
            )
        )
    )
    peak_valley_distance_similarity = float(
        np.exp(
            -18.0
            * _sequence_distance(
                query_distances,
                candidate_distances,
            )
        )
    )
    valley_position_similarity = float(
        np.exp(
            -4.0
            * _sequence_distance(
                query_ratios,
                candidate_ratios,
            )
        )
    )
    query_median_valley_depth = (
        float(np.median(query_depths))
        if query_depths
        else 1.0
    )
    candidate_median_valley_depth = (
        float(np.median(candidate_depths))
        if candidate_depths
        else 1.0
    )
    peak_valley_weight = (
        0.18
        if len(query_depths) == 7
        and query_median_valley_depth <= 0.16
        and max(query_depths, default=1.0) <= 0.20
        else 0.0
    )
    return {
        "image_cosine": cosine_similarity(
            query.image_embedding,
            candidate.image_embedding,
        ),
        "curve_cosine": curve_similarity,
        "peak_count_similarity": float(np.exp(-0.6 * peak_count_gap)),
        "peak_location_similarity": float(
            np.exp(
                -5.0
                * _sequence_distance(
                    query_descriptor["peak_locations"],
                    candidate_descriptor["peak_locations"],
                )
            )
        ),
        "peak_width_similarity": float(
            np.exp(
                -8.0
                * _sequence_distance(
                    query_descriptor["peak_widths"],
                    candidate_descriptor["peak_widths"],
                )
            )
        ),
        "area_similarity": float(
            np.exp(-5.0 * abs(query_descriptor["area"] - candidate_descriptor["area"]))
        ),
        "valley_similarity": float(
            np.exp(
                -5.0
                * _sequence_distance(
                    query_descriptor["valley_heights"],
                    candidate_descriptor["valley_heights"],
                )
            )
        ),
        "tail_slope_similarity": float(
            np.exp(
                -18.0
                * _sequence_distance(
                    query_descriptor["tail_slopes"],
                    candidate_descriptor["tail_slopes"],
                )
            )
        ),
        "valley_depth_similarity": valley_depth_similarity,
        "peak_valley_distance_similarity": peak_valley_distance_similarity,
        "valley_position_similarity": valley_position_similarity,
        "peak_valley_similarity": float(
            0.55 * valley_depth_similarity
            + 0.30 * peak_valley_distance_similarity
            + 0.15 * valley_position_similarity
        ),
        "query_median_valley_depth": query_median_valley_depth,
        "candidate_median_valley_depth": candidate_median_valley_depth,
        "shallow_peak_valley_overlap": bool(
            query_depths
            and candidate_depths
            and query_median_valley_depth <= 0.18
            and candidate_median_valley_depth <= 0.18
        ),
        "peak_valley_weight": peak_valley_weight,
    }


def pair_feature_vector(query: FeatureBundle, candidate: FeatureBundle) -> np.ndarray:
    components = similarity_components(query, candidate)
    return pair_feature_vector_from_components(components)


def pair_feature_vector_from_components(
    components: dict[str, float],
) -> np.ndarray:
    return np.asarray(
        [
            components["image_cosine"],
            components["curve_cosine"],
            components["peak_count_similarity"],
            components["peak_location_similarity"],
            components["peak_width_similarity"],
            components["area_similarity"],
            components["valley_similarity"],
            components["tail_slope_similarity"],
        ],
        dtype=np.float32,
    )


def explain_similarity(query: FeatureBundle, candidate: FeatureBundle) -> list:
    components = similarity_components(query, candidate)
    reasons = []
    query_peaks = int(query.descriptor["peak_count"])
    candidate_peaks = int(candidate.descriptor["peak_count"])
    if query_peaks == candidate_peaks:
        reasons.append(f"검출된 State 봉우리 수가 {query_peaks}개로 같습니다.")
    elif abs(query_peaks - candidate_peaks) <= 1:
        reasons.append(f"검출된 봉우리 수가 {query_peaks}개와 {candidate_peaks}개로 유사합니다.")
    if components["shallow_peak_valley_overlap"]:
        reasons.append("peak에 가까운 얕은 valley 패턴이 유사합니다.")
    elif components["peak_valley_similarity"] >= 0.86:
        reasons.append("peak와 valley의 상대 깊이·간격이 가깝습니다.")
    if components["peak_location_similarity"] >= 0.82:
        reasons.append("봉우리의 상대적인 x 위치 배열이 가깝습니다.")
    if components["peak_width_similarity"] >= 0.82:
        reasons.append("각 분포의 상대 폭과 퍼짐 정도가 가깝습니다.")
    if components["curve_cosine"] >= 0.9:
        reasons.append("축을 제거한 전체 Curve 윤곽이 매우 유사합니다.")
    elif components["curve_cosine"] >= 0.8:
        reasons.append("축을 제거한 전체 Curve 윤곽이 유사합니다.")
    if components["area_similarity"] >= 0.9:
        reasons.append("정규화된 분포 면적과 꼬리 비중이 가깝습니다.")
    if components["valley_similarity"] >= 0.88 and components["tail_slope_similarity"] >= 0.82:
        reasons.append("로그 스케일의 State 사이 valley 깊이와 tail 기울기가 가깝습니다.")
    if not reasons:
        reasons.append("이미지 질감과 정규화된 Curve 특징의 종합 거리가 가깝습니다.")
    return reasons[:3]
