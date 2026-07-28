from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np

from vnand_similarity.dual_encoder import (
    DualCurveEncoder,
    audit_dual_curve_encoder,
    train_dual_curve_encoder,
)
from vnand_similarity.features import (
    CANONICAL_IMAGE_EMBEDDING_DIMENSIONS,
    FUSED_SHAPE_EMBEDDING_DIMENSIONS,
    canonical_image_embedding_from_profile,
    curve_embedding_from_profile,
    fused_shape_embedding_from_profile,
)
from vnand_similarity.pipeline import build_vector_index, generate_corpus


def test_curve_embedding_from_profile_has_shared_browser_dimensions() -> None:
    x = np.linspace(0.0, 1.0, 256)
    profile = np.exp(-0.5 * ((x - 0.35) / 0.11) ** 2)
    embedding = curve_embedding_from_profile(profile)

    assert embedding.shape == (384,)
    assert np.all(np.isfinite(embedding))
    np.testing.assert_allclose(
        np.linalg.norm(embedding),
        1.0,
        atol=1e-6,
    )
    image_embedding = canonical_image_embedding_from_profile(profile)
    fused_embedding = fused_shape_embedding_from_profile(profile)
    assert image_embedding.shape == (CANONICAL_IMAGE_EMBEDDING_DIMENSIONS,)
    assert fused_embedding.shape == (FUSED_SHAPE_EMBEDDING_DIMENSIONS,)
    np.testing.assert_allclose(np.linalg.norm(image_embedding), 1.0, atol=1e-6)
    np.testing.assert_allclose(np.linalg.norm(fused_embedding), 1.0, atol=1e-6)


def test_dual_encoder_trains_exports_and_loads(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    index = tmp_path / "vectors.sqlite"
    model = tmp_path / "dual-encoder.joblib"
    browser_model = tmp_path / "dual-encoder.browser.json"
    generate_corpus(
        corpus,
        samples=4,
        variants=1,
        state_count=4,
        seed=37,
    )
    build_vector_index(corpus, index)

    summary = train_dual_curve_encoder(
        index,
        model,
        browser_model_path=browser_model,
        embedding_dimensions=2,
        validation_fraction=0.25,
        seed=37,
        rerank_limit=2,
    )
    loaded = DualCurveEncoder(model)
    payload = json.loads(browser_model.read_text(encoding="utf-8"))

    assert model.exists()
    assert browser_model.exists()
    assert summary.training_sample_groups == 3
    assert summary.validation_sample_groups == 1
    assert loaded.input_dimensions == FUSED_SHAPE_EMBEDDING_DIMENSIONS
    assert loaded.embedding_dimensions == 2
    assert summary.encoder_kind == "nonlinear"
    assert summary.feature_kind == "image-curve"
    assert summary.hidden_dimensions == 8
    assert loaded.version == 3
    assert payload["kind"] == "vth-dual-image-curve-mlp"
    assert payload["inputDimensions"] == FUSED_SHAPE_EMBEDDING_DIMENSIONS
    assert payload["embeddingDimensions"] == 2
    assert len(payload["queryHiddenWeights"]) == 8
    assert (
        len(payload["queryHiddenWeights"][0])
        == FUSED_SHAPE_EMBEDDING_DIMENSIONS
    )
    assert len(payload["queryOutputWeights"]) == 2
    assert len(payload["queryOutputWeights"][0]) == 8

    with np.load(next((corpus / "raw").glob("*.npz")), allow_pickle=False) as raw:
        values = np.asarray(raw["composite_curve"], dtype=float)
    normalized = np.log10(np.clip(values, 1e-6, None))
    normalized = (normalized - normalized.min()) / max(
        normalized.max() - normalized.min(),
        1e-9,
    )
    embedding = curve_embedding_from_profile(normalized)
    score = loaded.similarity(embedding, embedding)
    assert 0.0 <= score <= 1.0


def test_external_audit_requires_all_three_non_regression_suites(
    tmp_path: Path,
) -> None:
    model_path = tmp_path / "candidate.joblib"
    browser_path = tmp_path / "candidate.json"
    input_dimensions = 384
    payload = {
        "version": 1,
        "query_weights": np.eye(2, input_dimensions),
        "query_intercept": np.zeros(2),
        "candidate_mean": np.zeros(input_dimensions),
        "candidate_components": np.eye(2, input_dimensions),
        "blend_weight": 0.2,
        "rerank_limit": 2,
        "validation": {"promotionPassed": True},
    }
    joblib.dump(payload, model_path)

    reports = []
    for suite in ("public", "measured-multisource", "user-peak-valley"):
        report_path = tmp_path / f"{suite}.json"
        report_path.write_text(
            json.dumps(
                {
                    "suiteName": suite,
                    "fixtureCount": 3,
                    "preprocessingPassed": 3,
                    "stateCountPassed": 3,
                    "searchPassed": 3,
                    "endToEndPassed": 3,
                    "groupResults": [
                        {
                            "stateCountConsistent": True,
                            "topCandidateConsistent": True,
                            "topTwoSetConsistent": True,
                            "minimumProfileSimilarity": 0.99,
                            "minimumTopFiveOverlap": 1.0,
                            "minimumTopTenOverlap": 1.0,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        reports.append(report_path)

    audit = audit_dual_curve_encoder(
        model_path,
        reports,
        browser_model_path=browser_path,
    )
    promoted = DualCurveEncoder(model_path)

    assert audit["promoted"]
    assert promoted.blend_weight == 0.2
    assert promoted.validation["fullyPromoted"]
    assert promoted.validation["external"]["passed"]
    assert browser_path.exists()
