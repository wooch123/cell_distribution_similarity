"""Monotonic pairwise reranker training for VTH graph similarities."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import joblib
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit
from sklearn.metrics import accuracy_score, roc_auc_score

from .features import (
    FeatureBundle,
    aligned_curve_similarity,
    extract_features,
    pair_feature_vector,
    pair_feature_vector_from_components,
)
from .feedback import PAIR_FEATURE_NAMES, FeedbackDataset, load_feedback_dataset
from .store import SQLiteVectorStore, VectorRecord

FEATURE_NAMES = list(PAIR_FEATURE_NAMES)
NEGATIVE_SAMPLING_STRATEGIES = (
    "random-stratified",
    "mixed-hard",
    "graded-mixed-hard",
)
HARD_NEGATIVE_FRACTION = 0.75
GRADED_HARD_NEGATIVE_FRACTION = 0.50
GRADED_ORACLE_NEIGHBOR_COUNT = 5
GRADED_POSITIVE_NEIGHBOR_COUNT = 2
HARDNESS_WEIGHTS = np.asarray(
    [0.12, 0.38, 0.02, 0.14, 0.12, 0.04, 0.10, 0.08],
    dtype=np.float64,
)


@dataclass(frozen=True)
class TrainingSummary:
    positive_pairs: int
    negative_pairs: int
    mined_negative_pairs: int
    negative_sampling: str
    graded_positive_pairs: int
    oracle_neighbor_count: int
    feedback_pairs: int
    feedback_positive_pairs: int
    feedback_negative_pairs: int
    training_accuracy: float
    training_auc: float
    validation_accuracy: Optional[float]
    validation_auc: Optional[float]
    feedback_training_accuracy: Optional[float]
    feedback_training_auc: Optional[float]
    feedback_validation_accuracy: Optional[float]
    feedback_validation_auc: Optional[float]
    feedback_query_groups: int
    feedback_weight: float
    training_sample_groups: int
    validation_sample_groups: int
    model_path: str
    feature_weights: dict[str, float]

    def as_dict(self) -> dict[str, Any]:
        return {
            "positive_pairs": self.positive_pairs,
            "negative_pairs": self.negative_pairs,
            "mined_negative_pairs": self.mined_negative_pairs,
            "negative_sampling": self.negative_sampling,
            "graded_positive_pairs": self.graded_positive_pairs,
            "oracle_neighbor_count": self.oracle_neighbor_count,
            "feedback_pairs": self.feedback_pairs,
            "feedback_positive_pairs": self.feedback_positive_pairs,
            "feedback_negative_pairs": self.feedback_negative_pairs,
            "training_accuracy": self.training_accuracy,
            "training_auc": self.training_auc,
            "validation_accuracy": self.validation_accuracy,
            "validation_auc": self.validation_auc,
            "feedback_training_accuracy": self.feedback_training_accuracy,
            "feedback_training_auc": self.feedback_training_auc,
            "feedback_validation_accuracy": self.feedback_validation_accuracy,
            "feedback_validation_auc": self.feedback_validation_auc,
            "feedback_query_groups": self.feedback_query_groups,
            "feedback_weight": self.feedback_weight,
            "training_sample_groups": self.training_sample_groups,
            "validation_sample_groups": self.validation_sample_groups,
            "model_path": self.model_path,
            "feature_weights": self.feature_weights,
        }


def _bundle(record: VectorRecord) -> FeatureBundle:
    return record.feature_bundle()


def _pair_examples(
    records: Sequence[VectorRecord],
    *,
    seed: int,
    negative_sampling: str = "random-stratified",
) -> tuple[np.ndarray, np.ndarray, int, int, int, int]:
    if negative_sampling not in NEGATIVE_SAMPLING_STRATEGIES:
        raise ValueError(
            "negative_sampling must be one of "
            f"{', '.join(NEGATIVE_SAMPLING_STRATEGIES)}"
        )
    grouped: dict[str, list[VectorRecord]] = {}
    for record in records:
        grouped.setdefault(record.sample_id, []).append(record)
    if len(grouped) < 2:
        raise ValueError("At least two distinct samples are needed to train the reranker")

    image_queries = {
        record.vector_id: extract_features(Path(record.image_path)) for record in records
    }
    positive_features: list[np.ndarray] = []
    for variants in grouped.values():
        for query_record in variants:
            for candidate_record in variants:
                positive_features.append(
                    pair_feature_vector(
                        image_queries[query_record.vector_id],
                        _bundle(candidate_record),
                    )
                )

    rng = np.random.default_rng(seed)
    sample_ids = list(grouped)
    state_count_by_sample = {
        sample_id: int(variants[0].descriptor.get("peak_count", 0))
        for sample_id, variants in grouped.items()
    }
    family_by_sample = {
        sample_id: str(variants[0].metadata.get("family", ""))
        for sample_id, variants in grouped.items()
    }
    representative_by_sample = {
        sample_id: next(
            (
                record
                for record in variants
                if record.variant_id == "base"
            ),
            variants[0],
        )
        for sample_id, variants in grouped.items()
    }
    oracle_neighbors_by_sample: dict[str, tuple[str, ...]] = {}
    if negative_sampling == "graded-mixed-hard":
        for sample_id, representative in representative_by_sample.items():
            same_state_scores = [
                (
                    candidate_id,
                    aligned_curve_similarity(
                        representative.curve_embedding,
                        candidate.curve_embedding,
                    ),
                )
                for candidate_id, candidate in representative_by_sample.items()
                if state_count_by_sample[candidate_id]
                == state_count_by_sample[sample_id]
            ]
            same_state_scores.sort(key=lambda item: (-item[1], item[0]))
            neighborhood_size = min(
                GRADED_ORACLE_NEIGHBOR_COUNT,
                max(1, len(same_state_scores) - 1),
            )
            oracle_neighbors_by_sample[sample_id] = tuple(
                candidate_id
                for candidate_id, _ in same_state_scores[
                    :neighborhood_size
                ]
            )

    graded_positive_count = 0
    if negative_sampling == "graded-mixed-hard":
        for query_record in records:
            query = image_queries[query_record.vector_id]
            positive_neighbor_ids = [
                sample_id
                for sample_id in oracle_neighbors_by_sample[
                    query_record.sample_id
                ]
                if sample_id != query_record.sample_id
            ][:GRADED_POSITIVE_NEIGHBOR_COUNT]
            for neighbor_id in positive_neighbor_ids:
                positive_features.append(
                    pair_feature_vector(
                        query,
                        _bundle(representative_by_sample[neighbor_id]),
                    )
                )
                graded_positive_count += 1

    target_negatives = max(len(positive_features), 24)
    negative_features: list[np.ndarray] = []
    mined_negative_count = 0
    if negative_sampling in {"mixed-hard", "graded-mixed-hard"}:
        hard_candidates_by_query: list[list[np.ndarray]] = []
        for query_record in records:
            query = image_queries[query_record.vector_id]
            query_state_count = state_count_by_sample[query_record.sample_id]
            best_by_wrong_sample: dict[str, tuple[float, np.ndarray]] = {}
            for wrong_sample_id, variants in grouped.items():
                if wrong_sample_id == query_record.sample_id:
                    continue
                if state_count_by_sample[wrong_sample_id] != query_state_count:
                    continue
                if (
                    negative_sampling == "graded-mixed-hard"
                    and wrong_sample_id
                    in oracle_neighbors_by_sample[query_record.sample_id]
                ):
                    continue
                for candidate_record in variants:
                    vector = pair_feature_vector(query, _bundle(candidate_record))
                    hardness = float(
                        np.dot(vector.astype(np.float64), HARDNESS_WEIGHTS)
                    )
                    current = best_by_wrong_sample.get(wrong_sample_id)
                    if current is None or hardness > current[0]:
                        best_by_wrong_sample[wrong_sample_id] = (
                            hardness,
                            vector,
                        )
            hard_candidates_by_query.append(
                [
                    vector
                    for _, vector in sorted(
                        best_by_wrong_sample.values(),
                        key=lambda item: item[0],
                        reverse=True,
                    )
                ]
            )

        hard_fraction = (
            GRADED_HARD_NEGATIVE_FRACTION
            if negative_sampling == "graded-mixed-hard"
            else HARD_NEGATIVE_FRACTION
        )
        hard_target = min(
            round(target_negatives * hard_fraction),
            sum(len(candidates) for candidates in hard_candidates_by_query),
        )
        depth = 0
        while len(negative_features) < hard_target:
            added_at_depth = 0
            for candidates in hard_candidates_by_query:
                if depth >= len(candidates):
                    continue
                negative_features.append(candidates[depth])
                added_at_depth += 1
                if len(negative_features) >= hard_target:
                    break
            if not added_at_depth:
                break
            depth += 1
        mined_negative_count = len(negative_features)

    while len(negative_features) < target_negatives:
        left_id = str(rng.choice(sample_ids))
        excluded_ids = set(oracle_neighbors_by_sample.get(left_id, ()))
        same_state = [
            sample_id
            for sample_id in sample_ids
            if sample_id != left_id
            and state_count_by_sample[sample_id] == state_count_by_sample[left_id]
            and sample_id not in excluded_ids
        ]
        same_family = [
            sample_id
            for sample_id in same_state
            if family_by_sample[sample_id] == family_by_sample[left_id]
        ]
        if same_family and rng.random() < 0.55:
            choices = same_family
        elif same_state and rng.random() < 0.85:
            choices = same_state
        else:
            choices = [
                sample_id
                for sample_id in sample_ids
                if sample_id != left_id and sample_id not in excluded_ids
            ]
        if not choices:
            choices = [
                sample_id for sample_id in sample_ids if sample_id != left_id
            ]
        right_id = str(rng.choice(choices))
        query_record = grouped[left_id][int(rng.integers(0, len(grouped[left_id])))]
        candidate_record = grouped[right_id][int(rng.integers(0, len(grouped[right_id])))]
        negative_features.append(
            pair_feature_vector(
                image_queries[query_record.vector_id],
                _bundle(candidate_record),
            )
        )

    features = [*positive_features, *negative_features]
    labels = [1] * len(positive_features) + [0] * len(negative_features)
    return (
        np.asarray(features, dtype=np.float64),
        np.asarray(labels, dtype=np.float64),
        len(positive_features),
        len(negative_features),
        mined_negative_count,
        graded_positive_count,
    )


def _sample_group_split(
    records: Sequence[VectorRecord],
    *,
    seed: int,
) -> tuple[list[VectorRecord], list[VectorRecord]]:
    sample_records: dict[str, list[VectorRecord]] = {}
    for record in records:
        sample_records.setdefault(record.sample_id, []).append(record)
    if len(sample_records) < 8:
        return list(records), []

    by_state: dict[int, list[str]] = {}
    for sample_id, variants in sample_records.items():
        state_count = int(variants[0].descriptor.get("peak_count", 0))
        by_state.setdefault(state_count, []).append(sample_id)
    rng = np.random.default_rng(seed)
    validation_ids = set()
    for sample_ids in by_state.values():
        shuffled = list(sample_ids)
        rng.shuffle(shuffled)
        validation_count = max(1, round(len(shuffled) * 0.2))
        validation_count = min(validation_count, max(len(shuffled) - 2, 0))
        validation_ids.update(shuffled[:validation_count])
    training = [record for record in records if record.sample_id not in validation_ids]
    validation = [record for record in records if record.sample_id in validation_ids]
    if len({record.sample_id for record in validation}) < 2:
        return list(records), []
    return training, validation


def _feedback_group_split(
    dataset: FeedbackDataset,
    *,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Split expert examples by query ID so one graph never crosses the boundary."""

    group_ids = sorted(set(dataset.query_groups.tolist()))
    if len(group_ids) < 4:
        return np.arange(len(dataset.labels), dtype=int), np.asarray([], dtype=int)
    rng = np.random.default_rng(seed)
    rng.shuffle(group_ids)
    validation_count = max(1, round(len(group_ids) * 0.2))
    validation_count = min(validation_count, len(group_ids) - 3)
    validation_groups = set(group_ids[:validation_count])
    validation_mask = np.asarray(
        [group in validation_groups for group in dataset.query_groups],
        dtype=bool,
    )
    return np.flatnonzero(~validation_mask), np.flatnonzero(validation_mask)


def _append_weighted_feedback(
    synthetic_features: np.ndarray,
    synthetic_labels: np.ndarray,
    feedback_features: np.ndarray,
    feedback_labels: np.ndarray,
    *,
    feedback_weight: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    features = np.concatenate([synthetic_features, feedback_features], axis=0)
    labels = np.concatenate([synthetic_labels, feedback_labels], axis=0)
    sample_weights = np.concatenate(
        [
            np.ones(len(synthetic_labels), dtype=np.float64),
            np.full(len(feedback_labels), feedback_weight, dtype=np.float64),
        ]
    )
    return features, labels, sample_weights


def _fit_monotonic_logistic(
    features: np.ndarray,
    labels: np.ndarray,
    sample_weights: Optional[np.ndarray] = None,
) -> tuple[np.ndarray, float]:
    """Fit logistic weights constrained to be non-negative.

    Every input is a similarity where a larger value must never reduce the
    final score. This constraint prevents small synthetic corpora from learning
    physically contradictory negative feature weights.
    """

    feature_count = features.shape[1]
    initial = np.concatenate([np.full(feature_count, 0.6), np.asarray([-3.0])])
    if sample_weights is None:
        sample_weights = np.ones(len(labels), dtype=np.float64)
    else:
        sample_weights = np.asarray(sample_weights, dtype=np.float64)
    if sample_weights.shape != labels.shape:
        raise ValueError("sample_weights must match labels")
    if np.any(~np.isfinite(sample_weights)) or np.any(sample_weights <= 0):
        raise ValueError("sample_weights must contain finite positive values")
    total_weight = float(np.sum(sample_weights))

    def objective(parameters: np.ndarray) -> tuple[float, np.ndarray]:
        weights = parameters[:-1]
        intercept = parameters[-1]
        logits = np.sum(features * weights, axis=1) + intercept
        per_example_loss = np.logaddexp(0.0, logits) - labels * logits
        loss = float(np.sum(sample_weights * per_example_loss) / total_weight)
        regularization = 0.025 * float(np.dot(weights, weights))
        residual = sample_weights * (expit(logits) - labels)
        weight_gradient = (
            np.sum(features * residual[:, np.newaxis], axis=0) / total_weight + 0.05 * weights
        )
        intercept_gradient = float(np.sum(residual) / total_weight)
        gradient = np.concatenate([weight_gradient, np.asarray([intercept_gradient])])
        return loss + regularization, gradient

    result = minimize(
        objective,
        initial,
        method="L-BFGS-B",
        jac=True,
        bounds=[(0.0, 8.0)] * feature_count + [(None, None)],
        options={"maxiter": 1000, "ftol": 1e-12},
    )
    if not result.success:
        raise RuntimeError(f"Monotonic reranker training failed: {result.message}")
    return result.x[:-1].astype(np.float64), float(result.x[-1])


def _predict_probabilities(
    weights: np.ndarray,
    intercept: float,
    features: np.ndarray,
) -> np.ndarray:
    logits = np.sum(np.asarray(features, dtype=np.float64) * weights, axis=1) + intercept
    return expit(logits)


def _optional_auc(labels: np.ndarray, probabilities: np.ndarray) -> Optional[float]:
    if len(np.unique(labels)) < 2:
        return None
    return float(roc_auc_score(labels, probabilities))


def train_pairwise_reranker(
    index_path: Path,
    model_path: Path,
    *,
    seed: int = 42,
    feedback_paths: Sequence[Path] = (),
    feedback_weight: float = 4.0,
    min_feedback_pairs: int = 20,
    negative_sampling: str = "random-stratified",
) -> TrainingSummary:
    if feedback_weight <= 0:
        raise ValueError("feedback_weight must be positive")
    if min_feedback_pairs < 2:
        raise ValueError("min_feedback_pairs must be at least 2")

    feedback_dataset: Optional[FeedbackDataset] = None
    if feedback_paths:
        feedback_dataset = load_feedback_dataset(feedback_paths)
        if len(feedback_dataset.labels) < min_feedback_pairs:
            raise ValueError(
                "Expert feedback quality gate failed: "
                f"{len(feedback_dataset.labels)} pairs found, "
                f"at least {min_feedback_pairs} are required"
            )
        if len(np.unique(feedback_dataset.labels)) < 2:
            raise ValueError(
                "Expert feedback quality gate failed: both similar and dissimilar "
                "labels are required"
            )
        feedback_group_count = len(set(feedback_dataset.query_groups.tolist()))
        if feedback_group_count < 3:
            raise ValueError(
                "Expert feedback quality gate failed: at least 3 independent query "
                "groups are required"
            )

    with SQLiteVectorStore(index_path) as store:
        records = store.all_records()
    training_records, validation_records = _sample_group_split(records, seed=seed)
    (
        features,
        labels,
        positive_count,
        negative_count,
        mined_negative_count,
        graded_positive_count,
    ) = (
        _pair_examples(
            records,
            seed=seed,
            negative_sampling=negative_sampling,
        )
    )

    validation_accuracy: Optional[float] = None
    validation_auc: Optional[float] = None
    if validation_records:
        split_features, split_labels, _, _, _, _ = _pair_examples(
            training_records,
            seed=seed,
            negative_sampling=negative_sampling,
        )
        if feedback_dataset is not None:
            split_features, split_labels, split_sample_weights = _append_weighted_feedback(
                split_features,
                split_labels,
                feedback_dataset.features,
                feedback_dataset.labels,
                feedback_weight=feedback_weight,
            )
        else:
            split_sample_weights = np.ones(len(split_labels), dtype=np.float64)
        split_weights, split_intercept = _fit_monotonic_logistic(
            split_features,
            split_labels,
            split_sample_weights,
        )
        validation_features, validation_labels, _, _, _, _ = _pair_examples(
            validation_records,
            seed=seed + 1,
            negative_sampling=negative_sampling,
        )
        validation_probabilities = _predict_probabilities(
            split_weights,
            split_intercept,
            validation_features,
        )
        validation_accuracy = float(
            accuracy_score(validation_labels, validation_probabilities >= 0.5)
        )
        validation_auc = _optional_auc(validation_labels, validation_probabilities)

    feedback_validation_accuracy: Optional[float] = None
    feedback_validation_auc: Optional[float] = None
    if feedback_dataset is not None:
        feedback_training_indices, feedback_validation_indices = _feedback_group_split(
            feedback_dataset,
            seed=seed,
        )
        if len(feedback_validation_indices):
            feedback_split_features = feedback_dataset.features[feedback_training_indices]
            feedback_split_labels = feedback_dataset.labels[feedback_training_indices]
            combined_features, combined_labels, combined_sample_weights = (
                _append_weighted_feedback(
                    features,
                    labels,
                    feedback_split_features,
                    feedback_split_labels,
                    feedback_weight=feedback_weight,
                )
            )
            feedback_split_weights, feedback_split_intercept = _fit_monotonic_logistic(
                combined_features,
                combined_labels,
                combined_sample_weights,
            )
            heldout_feedback_labels = feedback_dataset.labels[feedback_validation_indices]
            heldout_feedback_probabilities = _predict_probabilities(
                feedback_split_weights,
                feedback_split_intercept,
                feedback_dataset.features[feedback_validation_indices],
            )
            feedback_validation_accuracy = float(
                accuracy_score(
                    heldout_feedback_labels,
                    heldout_feedback_probabilities >= 0.5,
                )
            )
            feedback_validation_auc = _optional_auc(
                heldout_feedback_labels,
                heldout_feedback_probabilities,
            )

        fit_features, fit_labels, fit_sample_weights = _append_weighted_feedback(
            features,
            labels,
            feedback_dataset.features,
            feedback_dataset.labels,
            feedback_weight=feedback_weight,
        )
    else:
        fit_features = features
        fit_labels = labels
        fit_sample_weights = np.ones(len(labels), dtype=np.float64)

    weights, intercept = _fit_monotonic_logistic(
        fit_features,
        fit_labels,
        fit_sample_weights,
    )
    probabilities = _predict_probabilities(weights, intercept, features)
    predictions = (probabilities >= 0.5).astype(int)
    feedback_training_accuracy: Optional[float] = None
    feedback_training_auc: Optional[float] = None
    if feedback_dataset is not None:
        feedback_probabilities = _predict_probabilities(
            weights,
            intercept,
            feedback_dataset.features,
        )
        feedback_training_accuracy = float(
            accuracy_score(
                feedback_dataset.labels,
                feedback_probabilities >= 0.5,
            )
        )
        feedback_training_auc = _optional_auc(
            feedback_dataset.labels,
            feedback_probabilities,
        )

    payload = {
        "weights": weights,
        "intercept": intercept,
        "feature_names": FEATURE_NAMES,
        "version": 2,
        "constraint": "non-negative-monotonic",
        "negative_sampling": negative_sampling,
        "mined_negative_fraction": (
            mined_negative_count / max(negative_count, 1)
        ),
        "hardness_weights": (
            dict(zip(FEATURE_NAMES, HARDNESS_WEIGHTS.tolist()))
            if negative_sampling in {"mixed-hard", "graded-mixed-hard"}
            else None
        ),
        "oracle_neighbor_count": (
            GRADED_ORACLE_NEIGHBOR_COUNT
            if negative_sampling == "graded-mixed-hard"
            else 0
        ),
        "graded_positive_neighbor_count": (
            GRADED_POSITIVE_NEIGHBOR_COUNT
            if negative_sampling == "graded-mixed-hard"
            else 0
        ),
        "validation_split": "sample-id-stratified",
        "expert_feedback": {
            "pairs": len(feedback_dataset.labels) if feedback_dataset else 0,
            "query_groups": (
                len(set(feedback_dataset.query_groups.tolist()))
                if feedback_dataset
                else 0
            ),
            "sample_weight": feedback_weight if feedback_dataset else 0.0,
            "validation_split": "query-id-grouped",
            "minimum_pair_gate": min_feedback_pairs,
            "aggregation": (
                "anonymous-annotator-majority-with-ties-excluded"
                if feedback_dataset
                else None
            ),
            "summary": feedback_dataset.summary if feedback_dataset else None,
        },
    }
    model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(payload, model_path)

    feature_weights = {name: float(weight) for name, weight in zip(FEATURE_NAMES, weights)}
    summary = TrainingSummary(
        positive_pairs=positive_count,
        negative_pairs=negative_count,
        mined_negative_pairs=mined_negative_count,
        negative_sampling=negative_sampling,
        graded_positive_pairs=graded_positive_count,
        oracle_neighbor_count=(
            GRADED_ORACLE_NEIGHBOR_COUNT
            if negative_sampling == "graded-mixed-hard"
            else 0
        ),
        feedback_pairs=len(feedback_dataset.labels) if feedback_dataset else 0,
        feedback_positive_pairs=(
            int(np.sum(feedback_dataset.labels == 1)) if feedback_dataset else 0
        ),
        feedback_negative_pairs=(
            int(np.sum(feedback_dataset.labels == 0)) if feedback_dataset else 0
        ),
        training_accuracy=float(accuracy_score(labels, predictions)),
        training_auc=float(roc_auc_score(labels, probabilities)),
        validation_accuracy=validation_accuracy,
        validation_auc=validation_auc,
        feedback_training_accuracy=feedback_training_accuracy,
        feedback_training_auc=feedback_training_auc,
        feedback_validation_accuracy=feedback_validation_accuracy,
        feedback_validation_auc=feedback_validation_auc,
        feedback_query_groups=(
            len(set(feedback_dataset.query_groups.tolist())) if feedback_dataset else 0
        ),
        feedback_weight=feedback_weight if feedback_dataset else 0.0,
        training_sample_groups=len({record.sample_id for record in training_records}),
        validation_sample_groups=len({record.sample_id for record in validation_records}),
        model_path=str(model_path.resolve()),
        feature_weights=feature_weights,
    )
    summary_path = model_path.with_suffix(".metrics.json")
    summary_path.write_text(
        json.dumps(summary.as_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


class PairwiseReranker:
    def __init__(self, model_path: Path) -> None:
        payload = joblib.load(model_path)
        version = int(payload.get("version", 0))
        if version != 2:
            raise ValueError("Reranker model is outdated; run the train command again")
        self.weights = np.asarray(payload["weights"], dtype=np.float64)
        self.intercept = float(payload["intercept"])
        self.version = version

    def score(self, query: FeatureBundle, candidate: FeatureBundle) -> float:
        vector = pair_feature_vector(query, candidate).astype(np.float64).reshape(1, -1)
        return float(_predict_probabilities(self.weights, self.intercept, vector)[0])

    def score_components(self, components: dict[str, float]) -> float:
        vector = (
            pair_feature_vector_from_components(components)
            .astype(np.float64)
            .reshape(1, -1)
        )
        return float(_predict_probabilities(self.weights, self.intercept, vector)[0])
