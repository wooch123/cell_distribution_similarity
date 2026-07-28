import json
from pathlib import Path

import joblib
import numpy as np
import pytest

from vnand_similarity.feedback import (
    PAIR_FEATURE_NAMES,
    ingest_feedback_reports,
    load_feedback_dataset,
)
from vnand_similarity.model_selection import compare_rerankers_on_feedback
from vnand_similarity.pipeline import build_vector_index, generate_corpus
from vnand_similarity.training import FEATURE_NAMES, train_pairwise_reranker


def _write_feedback_report(
    path: Path,
    query_index: int,
    *,
    schema_version: int = 2,
    annotator_id: str = "A-TEST",
) -> None:
    judgments = []
    for candidate_index in range(6):
        similar = candidate_index < 3
        high = 0.93 - candidate_index * 0.01
        low = 0.38 + candidate_index * 0.01
        score = high if similar else low
        judgments.append(
            {
                "candidate_id": f"candidate-{candidate_index:02d}",
                "rank": candidate_index + 1,
                "relevance": "similar" if similar else "dissimilar",
                "state_count": 4,
                "score": score,
                "model_score": score,
                "image_score": score,
                "curve_score": score,
                "peak_count_score": 1.0,
                "location_score": score,
                "width_score": score,
                "area_score": score,
                "valley_score": score,
                "tail_score": score,
                "reasons": ["test"],
            }
        )
    payload = {
        "schema_version": schema_version,
        "report_type": "vth-expert-relevance",
        "created_at": f"2026-07-27T00:00:0{query_index}Z",
        "privacy": {
            "query_image_included": False,
            "original_filename_included": False,
            "external_upload_performed": False,
            "normalized_shape_features_included": True,
        },
        "query": {
            "id": f"query-{query_index:02d}",
            "y_scale": "log10",
            "detected_state_count": 4,
            "observed_state_count": 4,
            "state_count_regularized": False,
            "axes_detected": True,
            "profile": [round(index / 255, 6) for index in range(256)],
            "descriptor": {
                "peak_locations": [0.2, 0.4, 0.6, 0.8],
                "peak_widths": [0.08] * 4,
                "valley_heights": [0.1] * 3,
                "tail_slopes": [0.03] * 6,
                "area": 0.5,
            },
        },
        "corpus": {
            "version": 2,
            "candidate_count": 48,
            "state_counts": [2, 4, 8, 16],
            "reranker_version": 2,
        },
        "judgments": judgments,
    }
    if schema_version == 3:
        payload["annotator"] = {
            "id": annotator_id,
            "anonymous": True,
            "id_scope": "test",
        }
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_feedback_reports_are_validated_and_ingested(tmp_path: Path) -> None:
    reports = []
    for query_index in range(4):
        report_path = tmp_path / f"feedback-{query_index}.json"
        _write_feedback_report(report_path, query_index)
        reports.append(report_path)

    dataset = load_feedback_dataset(reports)
    result = ingest_feedback_reports(reports, tmp_path / "ingested")

    assert dataset.features.shape == (24, len(FEATURE_NAMES))
    assert dataset.summary["query_group_count"] == 4
    assert dataset.summary["label_counts"] == {"similar": 12, "dissimilar": 12}
    assert result["deduplicated_judgment_count"] == 24
    assert Path(result["dataset_path"]).read_text().count("\n") == 24
    assert Path(result["summary_path"]).exists()


def test_schema_v3_preserves_annotators_and_forms_majority_consensus(
    tmp_path: Path,
) -> None:
    reports = []
    for annotator_id in ("A-ONE", "A-TWO", "A-THREE"):
        report_path = tmp_path / f"feedback-{annotator_id}.json"
        _write_feedback_report(
            report_path,
            0,
            schema_version=3,
            annotator_id=annotator_id,
        )
        reports.append(report_path)

    payload = json.loads(reports[-1].read_text())
    payload["judgments"][0]["relevance"] = "dissimilar"
    reports[-1].write_text(json.dumps(payload), encoding="utf-8")

    dataset = load_feedback_dataset(reports)
    result = ingest_feedback_reports(reports, tmp_path / "ingested")
    first_pair = next(
        record
        for record in dataset.records
        if record["candidate_id"] == "candidate-00"
    )

    assert dataset.summary["annotator_count"] == 3
    assert dataset.summary["multi_annotator_pair_count"] == 6
    assert dataset.summary["cross_annotator_conflict_pair_count"] == 1
    assert dataset.summary["excluded_tie_pair_count"] == 0
    assert dataset.summary["inter_annotator_agreement"] == pytest.approx(16 / 18)
    assert first_pair["relevance"] == "similar"
    assert first_pair["votes"] == {"similar": 2, "dissimilar": 1}
    assert first_pair["agreement"] == pytest.approx(2 / 3)
    assert Path(result["ratings_path"]).read_text().count("\n") == 18


def test_schema_v3_excludes_cross_annotator_ties(tmp_path: Path) -> None:
    left = tmp_path / "left.json"
    right = tmp_path / "right.json"
    _write_feedback_report(left, 0, schema_version=3, annotator_id="A-LEFT")
    _write_feedback_report(right, 0, schema_version=3, annotator_id="A-RIGHT")
    payload = json.loads(right.read_text())
    payload["judgments"][0]["relevance"] = "dissimilar"
    right.write_text(json.dumps(payload), encoding="utf-8")

    dataset = load_feedback_dataset([left, right])

    assert dataset.summary["excluded_tie_pair_count"] == 1
    assert dataset.summary["consensus_pair_count"] == 5
    assert all(
        record["candidate_id"] != "candidate-00" for record in dataset.records
    )


def test_ingests_central_shared_relevance_export(tmp_path: Path) -> None:
    reports = []
    for annotator_id in ("A-HASH-ONE", "A-HASH-TWO", "A-HASH-THREE"):
        report_path = tmp_path / f"{annotator_id}.json"
        _write_feedback_report(
            report_path,
            0,
            schema_version=3,
            annotator_id=annotator_id,
        )
        report = json.loads(report_path.read_text())
        report["privacy"]["normalized_shape_shared"] = True
        reports.append(report)

    export_path = tmp_path / "shared-relevance-export.json"
    export_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "exportType": "vth-shared-relevance-reports",
                "privacy": {
                    "rawImagesIncluded": False,
                    "originalFilenamesIncluded": False,
                    "queryCodesHashed": True,
                    "annotatorCodesHashed": True,
                },
                "reports": reports,
            }
        ),
        encoding="utf-8",
    )

    result = ingest_feedback_reports([export_path], tmp_path / "ingested")

    assert result["report_count"] == 3
    assert result["expanded_report_count"] == 3
    assert result["imported_shared_report_count"] == 3
    assert result["annotator_count"] == 3
    assert result["consensus_pair_count"] == 6


def test_schema_v1_feedback_is_not_used_for_retraining(tmp_path: Path) -> None:
    report_path = tmp_path / "legacy-feedback.json"
    _write_feedback_report(report_path, 0, schema_version=1)

    with pytest.raises(ValueError, match="schema_version 2"):
        load_feedback_dataset([report_path])


def test_expert_feedback_is_weighted_into_reranker_training(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    index = tmp_path / "vectors.sqlite"
    model = tmp_path / "reranker.joblib"
    generate_corpus(corpus, samples=3, variants=1, state_count=4, seed=71)
    build_vector_index(corpus, index)

    reports = []
    for query_index in range(4):
        report_path = tmp_path / f"feedback-{query_index}.json"
        _write_feedback_report(report_path, query_index)
        reports.append(report_path)

    summary = train_pairwise_reranker(
        index,
        model,
        seed=71,
        feedback_paths=reports,
        feedback_weight=4.0,
        min_feedback_pairs=20,
    )
    payload = joblib.load(model)

    assert summary.feedback_pairs == 24
    assert summary.feedback_positive_pairs == 12
    assert summary.feedback_negative_pairs == 12
    assert summary.feedback_query_groups == 4
    assert summary.feedback_training_auc is not None
    assert summary.feedback_training_auc > 0.95
    assert summary.feedback_validation_auc is not None
    assert payload["expert_feedback"]["pairs"] == 24
    assert payload["expert_feedback"]["validation_split"] == "query-id-grouped"


def test_heldout_expert_comparison_promotes_only_a_better_candidate(
    tmp_path: Path,
) -> None:
    reports = []
    for query_index in range(4):
        for annotator_id in ("A-ONE", "A-TWO"):
            report_path = (
                tmp_path / f"feedback-{query_index}-{annotator_id}.json"
            )
            _write_feedback_report(
                report_path,
                query_index,
                schema_version=3,
                annotator_id=annotator_id,
            )
            reports.append(report_path)

    baseline = tmp_path / "baseline.joblib"
    candidate = tmp_path / "candidate.joblib"
    common = {
        "version": 2,
        "feature_names": list(PAIR_FEATURE_NAMES),
    }
    joblib.dump(
        {
            **common,
            "weights": np.zeros(len(PAIR_FEATURE_NAMES)),
            "intercept": 0.0,
        },
        baseline,
    )
    candidate_weights = np.ones(len(PAIR_FEATURE_NAMES))
    candidate_weights[2] = 0
    joblib.dump(
        {
            **common,
            "weights": candidate_weights,
            "intercept": -4.0,
        },
        candidate,
    )

    result = compare_rerankers_on_feedback(
        baseline,
        candidate,
        tuple(reports),
        tmp_path / "comparison",
    )

    assert result["evidence_ready"] is True
    assert result["recommendation"] == "promote-candidate"
    assert result["candidate"]["auc"] == 1.0
    assert result["candidate"]["accuracy"] == 1.0
    assert result["candidate_minus_baseline"]["auc"] > 0
    assert Path(result["report_path"]).exists()
