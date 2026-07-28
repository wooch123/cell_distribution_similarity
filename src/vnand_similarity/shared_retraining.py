"""Closed-loop retraining from centrally shared anonymous relevance labels."""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any, Optional
from urllib.request import Request, urlopen

import numpy as np

from .evaluation import evaluate_heldout_queries
from .feedback import ingest_feedback_reports, load_feedback_dataset
from .model_selection import compare_rerankers_on_feedback
from .training import train_pairwise_reranker

DEFAULT_SHARED_RELEVANCE_ENDPOINT = "https://dove9999.com/api/v1/shared-relevance-export"
FetchJson = Callable[[str, float], dict[str, Any]]


def _http_fetch_json(url: str, timeout: float) -> dict[str, Any]:
    request = Request(
        url,
        headers={
            "accept": "application/json",
            "user-agent": "vnand-similarity-retraining/1",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        if int(response.status) != 200:
            raise ValueError(f"Shared relevance API returned HTTP {response.status}")
        body = response.read(64 * 1024 * 1024 + 1)
    if len(body) > 64 * 1024 * 1024:
        raise ValueError("Shared relevance export exceeds 64 MiB")
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Shared relevance API returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise TypeError("Shared relevance export must be an object")
    return payload


def validate_shared_relevance_export(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise TypeError("Shared relevance export must be an object")
    if payload.get("exportType") != "vth-shared-relevance-reports":
        raise ValueError("Shared relevance exportType is invalid")
    privacy = payload.get("privacy")
    expected_privacy = {
        "rawImagesIncluded": False,
        "originalFilenamesIncluded": False,
        "queryCodesHashed": True,
        "annotatorCodesHashed": True,
    }
    if not isinstance(privacy, dict) or any(
        privacy.get(field) is not expected for field, expected in expected_privacy.items()
    ):
        raise ValueError("Shared relevance export privacy metadata is invalid")
    reports = payload.get("reports")
    if not isinstance(reports, list):
        raise TypeError("Shared relevance reports must be an array")
    query_ids = []
    for index, report in enumerate(reports):
        if not isinstance(report, dict):
            raise TypeError(f"reports[{index}] must be an object")
        query = report.get("query")
        if not isinstance(query, dict):
            raise TypeError(f"reports[{index}].query must be an object")
        query_id = query.get("id")
        if not isinstance(query_id, str) or not query_id.strip():
            raise ValueError(f"reports[{index}].query.id is invalid")
        query_ids.append(query_id)
    return {
        **payload,
        "schemaVersion": 1,
        "privacy": expected_privacy,
        "reports": reports,
        "_query_ids": query_ids,
    }


def fetch_shared_relevance_export(
    endpoint: str = DEFAULT_SHARED_RELEVANCE_ENDPOINT,
    *,
    timeout: float = 30.0,
    fetch_json: Optional[FetchJson] = None,
) -> dict[str, Any]:
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    payload = (fetch_json or _http_fetch_json)(endpoint, timeout)
    return validate_shared_relevance_export(payload)


def split_shared_relevance_export(
    payload: dict[str, Any],
    *,
    validation_fraction: float = 1 / 3,
    seed: int = 20260727,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Split complete reports by Query ID so annotators never leak across sets."""

    validated = validate_shared_relevance_export(payload)
    if not 0.1 <= validation_fraction <= 0.5:
        raise ValueError("validation_fraction must be in [0.1, 0.5]")
    query_ids = sorted(
        set(validated["_query_ids"]),
        key=lambda query_id: hashlib.sha256(f"{seed}:{query_id}".encode()).hexdigest(),
    )
    if len(query_ids) < 2:
        raise ValueError("At least two Query groups are required for splitting")
    validation_count = max(
        1,
        min(len(query_ids) - 1, round(len(query_ids) * validation_fraction)),
    )
    validation_ids = set(query_ids[:validation_count])
    train_reports = []
    validation_reports = []
    for report in validated["reports"]:
        target = validation_reports if report["query"]["id"] in validation_ids else train_reports
        target.append(report)
    base = {key: value for key, value in validated.items() if key not in {"reports", "_query_ids"}}
    return (
        {**base, "split": "training-query-groups", "reports": train_reports},
        {
            **base,
            "split": "heldout-query-groups",
            "reports": validation_reports,
        },
    )


def _feedback_gates(summary: dict[str, Any], minimum_pairs: int) -> dict[str, bool]:
    labels = summary["label_counts"]
    agreement = summary["inter_annotator_agreement"]
    return {
        "minimum_consensus_pairs": summary["consensus_pair_count"] >= minimum_pairs,
        "minimum_query_groups_6": summary["query_group_count"] >= 6,
        "both_relevance_classes": labels["similar"] > 0 and labels["dissimilar"] > 0,
        "independent_annotations_present": (summary["multi_annotator_pair_count"] > 0),
        "inter_annotator_agreement_at_least_0_75": (agreement is not None and agreement >= 0.75),
        "no_tied_pairs": summary["excluded_tie_pair_count"] == 0,
    }


def _synthetic_regression_gates(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
) -> tuple[dict[str, bool], dict[str, float]]:
    baseline_metrics = baseline["metrics"]
    candidate_metrics = candidate["metrics"]
    fields = (
        "top_1_accuracy",
        "recall_at_5",
        "recall_at_10",
        "mean_reciprocal_rank",
        "shape_top_1_neighbor_accuracy",
        "shape_neighbor_recall_at_5",
        "shape_neighbor_recall_at_10",
        "shape_ndcg_at_5",
        "shape_ndcg_at_10",
    )
    deltas = {field: float(candidate_metrics[field] - baseline_metrics[field]) for field in fields}
    gates = {
        "top_1_not_worse_than_minus_0_01": deltas["top_1_accuracy"] >= -0.01,
        "recall_at_5_not_worse_than_minus_0_01": deltas["recall_at_5"] >= -0.01,
        "recall_at_10_not_worse_than_minus_0_01": deltas["recall_at_10"] >= -0.01,
        "mrr_not_worse_than_minus_0_01": deltas["mean_reciprocal_rank"] >= -0.01,
        "shape_top_1_not_worse_than_minus_0_01": (deltas["shape_top_1_neighbor_accuracy"] >= -0.01),
        "shape_recall_at_5_not_worse_than_minus_0_01": (
            deltas["shape_neighbor_recall_at_5"] >= -0.01
        ),
        "shape_recall_at_10_not_worse_than_minus_0_01": (
            deltas["shape_neighbor_recall_at_10"] >= -0.01
        ),
        "shape_ndcg_at_5_not_worse_than_minus_0_005": (deltas["shape_ndcg_at_5"] >= -0.005),
        "shape_ndcg_at_10_not_worse_than_minus_0_005": (deltas["shape_ndcg_at_10"] >= -0.005),
    }
    return gates, deltas


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def run_shared_retraining_cycle(
    *,
    index_path: Path,
    baseline_model_path: Path,
    candidate_model_path: Path,
    corpus_dir: Path,
    output_dir: Path,
    endpoint: str = DEFAULT_SHARED_RELEVANCE_ENDPOINT,
    timeout: float = 30.0,
    minimum_pairs: int = 40,
    feedback_weight: float = 4.0,
    seed: int = 20260727,
    promote: bool = False,
    fetch_json: Optional[FetchJson] = None,
) -> dict[str, Any]:
    """Fetch, split, train, evaluate, and optionally promote one safe cycle."""

    if minimum_pairs < 40:
        raise ValueError("minimum_pairs must be at least 40 for train/heldout evidence")
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    export = fetch_shared_relevance_export(
        endpoint,
        timeout=timeout,
        fetch_json=fetch_json,
    )
    export.pop("_query_ids", None)
    export_path = output_dir / "shared-relevance-export.json"
    _write_json(export_path, export)
    status: dict[str, Any] = {
        "schema_version": 1,
        "endpoint": endpoint,
        "report_count": len(export["reports"]),
        "minimum_pairs": minimum_pairs,
        "promotion_requested": promote,
        "promoted": False,
    }
    if not export["reports"]:
        status.update(
            {
                "status": "waiting-for-feedback",
                "reason": "No shared relevance reports are available.",
            }
        )
        _write_json(output_dir / "shared-retraining-status.json", status)
        return status

    ingestion = ingest_feedback_reports((export_path,), output_dir / "ingested")
    gates = _feedback_gates(ingestion, minimum_pairs)
    status["feedback"] = ingestion
    status["feedback_gates"] = gates
    if not all(gates.values()):
        status.update(
            {
                "status": "waiting-for-consensus",
                "reason": "Shared expert evidence has not passed every quality gate.",
            }
        )
        _write_json(output_dir / "shared-retraining-status.json", status)
        return status

    train_export, heldout_export = split_shared_relevance_export(
        export,
        seed=seed,
    )
    train_path = output_dir / "shared-relevance-training.json"
    heldout_path = output_dir / "shared-relevance-heldout.json"
    _write_json(train_path, train_export)
    _write_json(heldout_path, heldout_export)
    training_data = load_feedback_dataset((train_path,))
    heldout_data = load_feedback_dataset((heldout_path,))
    split_gates = {
        "training_pairs_at_least_20": len(training_data.labels) >= 20,
        "heldout_pairs_at_least_20": len(heldout_data.labels) >= 20,
        "training_queries_at_least_3": (training_data.summary["query_group_count"] >= 3),
        "heldout_queries_at_least_3": (heldout_data.summary["query_group_count"] >= 3),
        "training_has_both_classes": len(np.unique(training_data.labels)) == 2,
        "heldout_has_both_classes": len(np.unique(heldout_data.labels)) == 2,
        "query_groups_disjoint": not (
            set(training_data.query_groups.tolist()) & set(heldout_data.query_groups.tolist())
        ),
    }
    status["split_gates"] = split_gates
    if not all(split_gates.values()):
        status.update(
            {
                "status": "waiting-for-splittable-consensus",
                "reason": "Consensus cannot yet form independent train/heldout sets.",
            }
        )
        _write_json(output_dir / "shared-retraining-status.json", status)
        return status

    training = train_pairwise_reranker(
        index_path.resolve(),
        candidate_model_path.resolve(),
        seed=seed,
        feedback_paths=(train_path,),
        feedback_weight=feedback_weight,
        min_feedback_pairs=20,
        negative_sampling="graded-mixed-hard",
    )
    expert_comparison = compare_rerankers_on_feedback(
        baseline_model_path.resolve(),
        candidate_model_path.resolve(),
        (heldout_path,),
        output_dir / "expert-comparison",
    )
    baseline_evaluation = evaluate_heldout_queries(
        corpus_dir.resolve(),
        index_path.resolve(),
        baseline_model_path.resolve(),
        output_dir / "synthetic-baseline",
        seed=seed,
    )
    candidate_evaluation = evaluate_heldout_queries(
        corpus_dir.resolve(),
        index_path.resolve(),
        candidate_model_path.resolve(),
        output_dir / "synthetic-candidate",
        seed=seed,
    )
    synthetic_gates, synthetic_deltas = _synthetic_regression_gates(
        baseline_evaluation,
        candidate_evaluation,
    )
    promotion_ready = expert_comparison["recommendation"] == "promote-candidate" and all(
        synthetic_gates.values()
    )
    status.update(
        {
            "status": "promotion-ready" if promotion_ready else "candidate-rejected",
            "training": training.as_dict(),
            "expert_comparison": expert_comparison,
            "synthetic_regression_gates": synthetic_gates,
            "synthetic_candidate_minus_baseline": synthetic_deltas,
            "promotion_ready": promotion_ready,
        }
    )
    if promote and promotion_ready:
        temporary_model = baseline_model_path.with_suffix(".promotion.tmp")
        shutil.copy2(candidate_model_path, temporary_model)
        temporary_model.replace(baseline_model_path)
        candidate_metrics = candidate_model_path.with_suffix(".metrics.json")
        if candidate_metrics.exists():
            baseline_metrics = baseline_model_path.with_suffix(".metrics.json")
            temporary_metrics = baseline_metrics.with_suffix(".promotion.tmp")
            shutil.copy2(candidate_metrics, temporary_metrics)
            temporary_metrics.replace(baseline_metrics)
        status["status"] = "promoted"
        status["promoted"] = True
    _write_json(output_dir / "shared-retraining-status.json", status)
    return status
