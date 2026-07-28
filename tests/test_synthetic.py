import numpy as np

from vnand_similarity.synthetic import generate_vth_sample, remove_state_overlap


def test_overlap_removal_keeps_at_most_one_state_per_x() -> None:
    curves = np.asarray(
        [
            [0.0, 0.5, 1.0, 0.5, 0.1],
            [0.1, 0.4, 0.8, 1.0, 0.5],
        ]
    )
    exclusive = remove_state_overlap(curves, relative_floor=0.0)

    assert exclusive.shape == curves.shape
    assert np.all(np.count_nonzero(exclusive, axis=0) <= 1)
    assert exclusive[0, 2] == curves[0, 2]
    assert exclusive[1, 3] == curves[1, 3]


def test_generator_is_deterministic_and_preserves_raw_curves() -> None:
    first = generate_vth_sample(
        np.random.default_rng(7),
        sample_id="sample",
        state_count=8,
    )
    second = generate_vth_sample(
        np.random.default_rng(7),
        sample_id="sample",
        state_count=8,
    )

    np.testing.assert_allclose(first.state_curves, second.state_curves)
    assert first.state_curves.shape == (8, 512)
    assert np.all(np.count_nonzero(first.exclusive_curves, axis=0) <= 1)
    assert first.metadata["overlap_policy"] == "dominant-state-only"
    assert first.metadata["y_scale"] == "log10"
    assert first.metadata["y_floor"] == 1e-6
    assert first.metadata["dynamic_range_decades"] == 6.0
