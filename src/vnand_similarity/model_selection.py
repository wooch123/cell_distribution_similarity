"""Held-out expert-label comparison and production promotion gates."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import joblib
import numpy as np
from scipy.special import expit
from sklearn.metrics import accuracy_score, log_loss, roc_auc_score

from .feedback import PAIR_FEATURE_NAMES, load_feedback_dataset


def _load_model(path: Path) -> dict[str, Any]:
    path = path.resolve()
    if not path.exists():
        raise FileNotFoundError(f"Reranker model does not exist: {path}")
    payload = joblib.load(path)
    if not isinstance(payload, dict) or int(payload.get("version", 0)) != 2:
        raise ValueError(f"Unsupported reranker model: {path}")
    feature_names = tuple(payload.get("feature_names", ()))
    if feature_names != PAIR_FEATURE_NAMES:
        raise ValueError(
            f"{path}: feature_names do not match the expert feedback schema"
        )
    weights = np.asarray(payload.get("weights"), dtype=np.float64)
    if weights.shape != (len(PAIR_FEATURE_NAMES),):
        raise ValueError(f"{path}: invalid weight vector")
    intercept = float(payload.get("intercept"))
    if np.any(~np.isfinite(weights)) or not np.isfinite(intercept):
        raise ValueError(f"{path}: weights and intercept must be finite")
    return {
        "path": str(path),
        "weights": weights,
        "intercept": intercept,
        "version": 2,
    }


def _probabilities(model: dict[str, Any], features: np.ndarray) -> np.ndarray:
    return expit(features @ model["weights"] + model["intercept"])


def _optional_auc(labels: np.ndarray, probabilities: np.ndarray) -> Optional[float]:
    if len(np.unique(labels)) < 2:
        return None
    return float(roc_auc_score(labels, probabilities))


def _metrics(
    labels: np.ndarray,
    probabilities: np.ndarray,
    query_groups: np.ndarray,
) -> dict[str, Any]:
    clipped = np.clip(probabilities, 1e-7, 1 - 1e-7)
    query_accuracies = []
    query_aucs = []
    for group in sorted(set(query_groups.tolist())):
        mask = query_groups == group
        query_labels = labels[mask]
        query_probabilities = probabilities[mask]
        query_accuracies.append(
            float(accuracy_score(query_labels, query_probabilities >= 0.5))
        )
        query_auc = _optional_auc(query_labels, query_probabilities)
        if query_auc is not None:
            query_aucs.append(query_auc)
    return {
        "pair_count": len(labels),
        "accuracy": float(accuracy_score(labels, probabilities >= 0.5)),
        "auc": _optional_auc(labels, probabilities),
        "log_loss": float(log_loss(labels, clipped, labels=[0, 1])),
        "brier_score": float(np.mean((probabilities - labels) ** 2)),
        "query_macro_accuracy": float(np.mean(query_accuracies)),
        "query_macro_auc": (
            float(np.mean(query_aucs)) if query_aucs else None
        ),
        "query_auc_group_count": len(query_aucs),
    }


def _delta(
    candidate: Optional[float],
    baseline: Optional[float],
) -> Optional[float]:
    if candidate is None or baseline is None:
        return None
    return float(candidate - baseline)


def compare_rerankers_on_feedback(
    baseline_model_path: Path,
    candidate_model_path: Path,
    feedback_paths: tuple[Path, ...],
    output_dir: Path,
) -> dict[str, Any]:
    """Compare two rerankers on held-out consensus expert labels.

    The caller must supply reports whose query IDs were not used to train the
    candidate. The promotion recommendation remains conservative when data
    volume, class coverage, or inter-annotator agreement is insufficient.
    """

    dataset = load_feedback_dataset(feedback_paths)
    baseline = _load_model(baseline_model_path)
    candidate = _load_model(candidate_model_path)
    baseline_metrics = _metrics(
        dataset.labels,
        _probabilities(baseline, dataset.features),
        dataset.query_groups,
    )
    candidate_metrics = _metrics(
        dataset.labels,
        _probabilities(candidate, dataset.features),
        dataset.query_groups,
    )
    deltas = {
        metric: _delta(candidate_metrics[metric], baseline_metrics[metric])
        for metric in (
            "accuracy",
            "auc",
            "log_loss",
            "brier_score",
            "query_macro_accuracy",
            "query_macro_auc",
        )
    }

    agreement = dataset.summary["inter_annotator_agreement"]
    evidence_gates = {
        "minimum_consensus_pairs_20": len(dataset.labels) >= 20,
        "minimum_query_groups_3": dataset.summary["query_group_count"] >= 3,
        "both_relevance_classes": len(np.unique(dataset.labels)) == 2,
        "independent_annotations_present": (
            dataset.summary["multi_annotator_pair_count"] > 0
        ),
        "inter_annotator_agreement_at_least_0_75": (
            agreement is not None and agreement >= 0.75
        ),
        "no_tied_pairs": dataset.summary["excluded_tie_pair_count"] == 0,
    }
    evidence_ready = all(evidence_gates.values())
    auc_delta = deltas["auc"]
    guardrails = {
        "auc_not_worse_than_minus_0_01": (
            auc_delta is not None and auc_delta >= -0.01
        ),
        "accuracy_not_worse_than_minus_0_02": deltas["accuracy"] >= -0.02,
        "log_loss_not_worse_than_plus_0_02": deltas["log_loss"] <= 0.02,
        "query_macro_accuracy_not_worse_than_minus_0_02": (
            deltas["query_macro_accuracy"] >= -0.02
        ),
    }
    meaningful_improvement = bool(
        (auc_delta is not None and auc_delta >= 0.005)
        or deltas["log_loss"] <= -0.01
        or deltas["query_macro_accuracy"] >= 0.02
    )
    if not evidence_ready:
        recommendation = "insufficient-evidence"
    elif all(guardrails.values()) and meaningful_improvement:
        recommendation = "promote-candidate"
    else:
        recommendation = "keep-baseline"

    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / "expert-model-comparison.json"
    payload = {
        "schema_version": 1,
        "evaluation_protocol": (
            "held-out-query expert consensus; evaluation query IDs must not "
            "appear in candidate training"
        ),
        "feedback_summary": dataset.summary,
        "baseline": {
            "model_path": baseline["path"],
            "metrics": baseline_metrics,
        },
        "candidate": {
            "model_path": candidate["path"],
            "metrics": candidate_metrics,
        },
        "candidate_minus_baseline": deltas,
        "evidence_gates": evidence_gates,
        "guardrails": guardrails,
        "meaningful_improvement": meaningful_improvement,
        "recommendation": recommendation,
    }
    report_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "report_path": str(report_path),
        "recommendation": recommendation,
        "evidence_ready": evidence_ready,
        "baseline": baseline_metrics,
        "candidate": candidate_metrics,
        "candidate_minus_baseline": deltas,
    }
