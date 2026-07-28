from pathlib import Path

import cv2
import numpy as np

from vnand_similarity.features import (
    FeatureBundle,
    _curve_descriptor,
    _curve_embedding,
    _regularize_state_count,
    cosine_similarity,
    explain_similarity,
    extract_features,
    extract_log_curve_features,
    similarity_components,
)
from vnand_similarity.imaging import (
    _detect_frame_from_image,
    _hough_l_axis_box,
    _remove_straight_lines,
    _should_extract_filled_edges,
    render_vth_graph,
    standardize_graph_image,
)
from vnand_similarity.synthetic import generate_vth_sample


def _render(path: Path, seed: int, axes: bool) -> None:
    rng = np.random.default_rng(seed)
    sample = generate_vth_sample(rng, sample_id=f"sample-{seed}")
    render_vth_graph(
        sample,
        path,
        rng=rng,
        axes=axes,
        colored=axes,
        filled=axes,
        grid=axes,
    )


def test_preprocessing_normalizes_axes_and_resolution(tmp_path: Path) -> None:
    image_path = tmp_path / "graph.png"
    preview_path = tmp_path / "standard.png"
    _render(image_path, seed=3, axes=True)

    result = standardize_graph_image(image_path, preview_path=preview_path)

    assert result.mask.shape == (128, 256)
    assert 0 < float(result.mask.mean()) < 0.5
    assert result.diagnostics["plot_box_source"] == "image-frame"
    assert result.diagnostics["plot_coordinates_preserved"]
    assert not result.diagnostics["detached_label_filter_applied"]
    assert preview_path.exists()


def test_feature_extraction_adapts_coordinate_mode_to_state_complexity(
    tmp_path: Path,
) -> None:
    for state_count, expected_mode in (
        (4, "content-normalized-low-state"),
        (8, "plot-frame-high-state"),
    ):
        rng = np.random.default_rng(40 + state_count)
        sample = generate_vth_sample(
            rng,
            sample_id=f"coordinate-{state_count}",
            state_count=state_count,
        )
        image_path = tmp_path / f"coordinate-{state_count}.png"
        render_vth_graph(
            sample,
            image_path,
            rng=rng,
            axes=True,
            colored=True,
            filled=True,
            grid=True,
        )

        bundle = extract_features(image_path)

        assert bundle.preprocessing["coordinate_mode_selection"] == expected_mode
        assert len(bundle.preprocessing["alternative_curve_hypotheses"]) == 1
        assert len(bundle.alternative_curve_embeddings) == 1
        assert bundle.descriptor["peak_count"] == state_count


def test_feature_dimensions_and_self_similarity(tmp_path: Path) -> None:
    image_path = tmp_path / "graph.png"
    _render(image_path, seed=4, axes=False)

    bundle = extract_features(image_path)

    assert bundle.image_embedding.shape == (3200,)
    assert bundle.curve_embedding.shape == (384,)
    assert bundle.descriptor["peak_count"] >= 2
    assert cosine_similarity(bundle.image_embedding, bundle.image_embedding) > 0.999
    assert cosine_similarity(bundle.curve_embedding, bundle.curve_embedding) > 0.999


def test_raw_log_curve_features_use_original_vth_values() -> None:
    sample = generate_vth_sample(np.random.default_rng(8), sample_id="raw-log")

    bundle = extract_log_curve_features(sample)

    assert bundle.curve_embedding.shape == (384,)
    assert bundle.descriptor["peak_count"] == 8
    assert len(bundle.descriptor["valley_heights"]) == 7


def _eight_state_profile(
    valley_height: float,
    *,
    weak_last_three: bool = False,
) -> np.ndarray:
    profile = np.full(256, valley_height, dtype=np.float32)
    for peak_number, center in enumerate(range(20, 231, 30)):
        amplitude = (
            0.035
            if weak_last_three and peak_number >= 5
            else 1.0 - valley_height
        )
        for offset in range(-10, 11):
            index = center + offset
            profile[index] = max(
                float(profile[index]),
                valley_height
                + amplitude * (1.0 - abs(offset) / 11.0),
            )
    return profile


def test_uniform_shallow_valleys_preserve_eight_state_layout() -> None:
    profile = _eight_state_profile(0.86, weak_last_three=True)

    descriptor = _curve_descriptor(profile)

    assert descriptor["observed_peak_count"] == 5
    assert descriptor["candidate_peak_count"] == 8
    assert descriptor["peak_count"] == 8
    assert len(descriptor["valley_depths"]) == 7
    assert len(descriptor["peak_valley_distances"]) == 14
    assert max(descriptor["valley_depths"]) < 0.15


def test_peak_valley_relation_prefers_similarly_shallow_overlap() -> None:
    query_profile = _eight_state_profile(0.88)
    shallow_profile = _eight_state_profile(0.84)
    deep_profile = _eight_state_profile(0.20)

    def bundle(profile: np.ndarray) -> FeatureBundle:
        return FeatureBundle(
            image_embedding=np.asarray([1.0, 0.0], dtype=np.float32),
            curve_embedding=_curve_embedding(profile),
            descriptor=_curve_descriptor(profile),
            preprocessing={},
        )

    query = bundle(query_profile)
    shallow = similarity_components(query, bundle(shallow_profile))
    deep = similarity_components(query, bundle(deep_profile))

    assert shallow["peak_valley_similarity"] > deep["peak_valley_similarity"] + 0.2
    assert shallow["peak_valley_weight"] == 0.18
    assert shallow["candidate_median_valley_depth"] <= 0.18
    assert shallow["shallow_peak_valley_overlap"]
    assert "peak에 가까운 얕은 valley 패턴이 유사합니다." in explain_similarity(
        query,
        bundle(shallow_profile),
    )


def test_state_count_regularization_uses_strong_candidate_evidence() -> None:
    assert _regularize_state_count(observed_count=12, candidate_count=15) == 16
    assert _regularize_state_count(observed_count=11, candidate_count=16) == 16
    assert _regularize_state_count(observed_count=5, candidate_count=7) == 4
    assert _regularize_state_count(observed_count=5, candidate_count=8) == 4
    assert _regularize_state_count(observed_count=3, candidate_count=3) == 2
    assert _regularize_state_count(observed_count=3, candidate_count=6) == 4
    assert _regularize_state_count(observed_count=7, candidate_count=15) == 8
    assert _regularize_state_count(observed_count=7, candidate_count=16) == 16


def test_open_l_axis_and_internal_reference_line_cleanup() -> None:
    mask = np.zeros((600, 1000), dtype=np.uint8)
    cv2.line(mask, (100, 50), (100, 520), color=1, thickness=3)
    cv2.line(mask, (100, 520), (950, 520), color=1, thickness=3)
    cv2.polylines(
        mask,
        [
            np.asarray(
                [(140, 500), (250, 180), (360, 500), (540, 140), (700, 500)],
                dtype=np.int32,
            )
        ],
        isClosed=False,
        color=1,
        thickness=3,
    )
    cv2.line(mask, (460, 80), (460, 500), color=1, thickness=2)

    box = _hough_l_axis_box(mask)
    assert box is not None
    left, top, right, bottom = box
    assert 95 <= left <= 110
    assert top <= 60
    assert right >= 900
    assert 510 <= bottom <= 530

    cleaned = _remove_straight_lines(mask[50:520, 101:950])
    assert int(cleaned[:, 359].sum()) < 8
    assert int(cleaned.sum()) > 100


def test_closed_frame_ignores_aligned_log_tick_label_strokes() -> None:
    image = np.full((640, 1280, 3), 255, dtype=np.uint8)
    frame_color = (20, 20, 20)
    cv2.rectangle(image, (160, 78), (1152, 570), frame_color, thickness=3)
    # A broken vertical stroke plus an extended bottom line approximates
    # aligned 10^n tick labels. It touches only one plot boundary and must not
    # replace the true left spine.
    cv2.line(image, (101, 165), (101, 578), frame_color, thickness=2)
    cv2.line(image, (99, 570), (1152, 570), frame_color, thickness=2)

    box = _detect_frame_from_image(image, deskew_angle=0.0)

    assert box is not None
    left, top, right, bottom = box
    assert 155 <= left <= 165
    assert 74 <= top <= 82
    assert 1148 <= right <= 1155
    assert 566 <= bottom <= 573


def test_dense_markers_are_not_misclassified_as_a_filled_distribution() -> None:
    measured_marker_plot = _should_extract_filled_edges(
        foreground_density=0.1503,
        edge_density=0.0895,
        edge_pixel_count=9000,
        edge_x_coverage=0.98,
    )
    dense_filled_plot = _should_extract_filled_edges(
        foreground_density=0.1656,
        edge_density=0.0751,
        edge_pixel_count=7500,
        edge_x_coverage=0.97,
    )

    assert not measured_marker_plot
    assert dense_filled_plot
