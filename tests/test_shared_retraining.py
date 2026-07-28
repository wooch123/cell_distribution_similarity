import json
from pathlib import Path

import pytest

from vnand_similarity.shared_retraining import (
    _synthetic_regression_gates,
    run_shared_retraining_cycle,
    split_shared_relevance_export,
    validate_shared_relevance_export,
)


def _export(query_count: int) -> dict:
    return {
        "schemaVersion": 1,
        "exportType": "vth-shared-relevance-reports",
        "privacy": {
            "rawImagesIncluded": False,
            "originalFilenamesIncluded": False,
            "queryCodesHashed": True,
            "annotatorCodesHashed": True,
        },
        "reports": [
            {
                "query": {"id": f"query-{query_index:02d}"},
                "annotator": {"id": f"annotator-{annotator_index:02d}"},
            }
            for query_index in range(query_count)
            for annotator_index in range(2)
        ],
    }


def test_shared_relevance_split_keeps_query_groups_disjoint() -> None:
    training, heldout = split_shared_relevance_export(
        _export(9),
        validation_fraction=1 / 3,
        seed=17,
    )
    training_queries = {report["query"]["id"] for report in training["reports"]}
    heldout_queries = {report["query"]["id"] for report in heldout["reports"]}

    assert len(training_queries) == 6
    assert len(heldout_queries) == 3
    assert training_queries.isdisjoint(heldout_queries)
    assert len(training["reports"]) == 12
    assert len(heldout["reports"]) == 6
    assert training["privacy"]["rawImagesIncluded"] is False


def test_empty_shared_export_writes_a_non_destructive_waiting_status(
    tmp_path: Path,
) -> None:
    payload = _export(0)
    output = tmp_path / "cycle"
    result = run_shared_retraining_cycle(
        index_path=tmp_path / "missing.sqlite",
        baseline_model_path=tmp_path / "baseline.joblib",
        candidate_model_path=tmp_path / "candidate.joblib",
        corpus_dir=tmp_path / "missing-corpus",
        output_dir=output,
        fetch_json=lambda _url, _timeout: payload,
    )
    persisted = json.loads((output / "shared-retraining-status.json").read_text())

    assert result["status"] == "waiting-for-feedback"
    assert result["report_count"] == 0
    assert result["promoted"] is False
    assert persisted == result
    assert not (tmp_path / "candidate.joblib").exists()


def test_shared_export_rejects_privacy_regressions() -> None:
    payload = _export(1)
    payload["privacy"]["rawImagesIncluded"] = True

    with pytest.raises(ValueError, match="privacy"):
        validate_shared_relevance_export(payload)


def test_synthetic_regression_gate_rejects_a_shape_top1_drop() -> None:
    baseline_metrics = {
        "top_1_accuracy": 0.81,
        "recall_at_5": 0.95,
        "recall_at_10": 0.98,
        "mean_reciprocal_rank": 0.85,
        "shape_top_1_neighbor_accuracy": 0.9375,
        "shape_neighbor_recall_at_5": 0.75,
        "shape_neighbor_recall_at_10": 0.94,
        "shape_ndcg_at_5": 0.88,
        "shape_ndcg_at_10": 0.91,
    }
    candidate_metrics = {
        **baseline_metrics,
        "shape_top_1_neighbor_accuracy": 0.9167,
        "shape_neighbor_recall_at_5": 0.79,
        "shape_ndcg_at_10": 0.92,
    }
    gates, deltas = _synthetic_regression_gates(
        {"metrics": baseline_metrics},
        {"metrics": candidate_metrics},
    )

    assert gates["shape_top_1_not_worse_than_minus_0_01"] is False
    assert gates["shape_recall_at_5_not_worse_than_minus_0_01"] is True
    assert deltas["shape_top_1_neighbor_accuracy"] == pytest.approx(-0.0208)
