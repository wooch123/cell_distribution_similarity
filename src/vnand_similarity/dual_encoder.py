"""Learned image-trace/Curve encoder for VTH shape retrieval.

The query encoder learns to denoise the Curve recovered from rendered graph
images.  The candidate encoder projects the original numeric log Curve into
the same compact space.  Training pairs are grouped and split by ``sample_id``
so a rendered variant can never leak its source distribution into validation.
"""

from __future__ import annotations

import json
import warnings
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import joblib
import numpy as np
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.neural_network import MLPRegressor

from .features import (
    CURVE_EMBEDDING_DIMENSIONS,
    FUSED_SHAPE_EMBEDDING_DIMENSIONS,
    curve_embedding_from_profile,
    extract_features,
    fused_shape_embedding_from_curve_embedding,
    fused_shape_embedding_from_profile,
    similarity_components,
)
from .store import SQLiteVectorStore, VectorRecord
from .training import PairwiseReranker

DEFAULT_EMBEDDING_DIMENSIONS = 8
DEFAULT_RIDGE_ALPHA = 10.0
DEFAULT_ENCODER_KIND = "nonlinear"
DEFAULT_HIDDEN_DIMENSIONS = 8
DEFAULT_MLP_ALPHA = 0.01
DEFAULT_MLP_MAX_ITER = 1000
DEFAULT_RERANK_LIMIT = 10
DEFAULT_BLEND_CANDIDATES = (0.0, 0.02, 0.05, 0.08, 0.10, 0.15, 0.20)
LINEAR_MODEL_VERSION = 1
NONLINEAR_MODEL_VERSION = 2
FUSED_NONLINEAR_MODEL_VERSION = 3
MODEL_VERSION = FUSED_NONLINEAR_MODEL_VERSION
SUPPORTED_MODEL_VERSIONS = {
    LINEAR_MODEL_VERSION,
    NONLINEAR_MODEL_VERSION,
    FUSED_NONLINEAR_MODEL_VERSION,
}
SUPPORTED_ENCODER_KINDS = {"linear", "nonlinear"}
SUPPORTED_FEATURE_KINDS = {"curve", "image-curve"}


def _unit(vector: np.ndarray) -> np.ndarray:
    values = np.asarray(vector, dtype=np.float64).reshape(-1)
    norm = float(np.linalg.norm(values))
    return values / max(norm, np.finfo(float).eps)


def _matrix_product(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    # Some Accelerate/NumPy combinations emit spurious overflow warnings for
    # finite small matrices while returning a finite result.  Validate the
    # result explicitly instead of surfacing those platform warnings.
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        result = np.asarray(left, dtype=np.float64) @ np.asarray(
            right,
            dtype=np.float64,
        )
    if not np.all(np.isfinite(result)):
        raise ValueError("Dual encoder produced a non-finite matrix product")
    return result


@dataclass(frozen=True)
class RankingMetrics:
    evaluated_queries: int
    top_1_accuracy: float
    recall_at_5: float
    recall_at_10: float
    mean_reciprocal_rank: float

    @classmethod
    def from_ranks(cls, ranks: Sequence[int]) -> RankingMetrics:
        values = np.asarray(ranks, dtype=np.int64)
        if not len(values):
            return cls(0, 0.0, 0.0, 0.0, 0.0)
        return cls(
            evaluated_queries=len(values),
            top_1_accuracy=float(np.mean(values == 1)),
            recall_at_5=float(np.mean(values <= 5)),
            recall_at_10=float(np.mean(values <= 10)),
            mean_reciprocal_rank=float(np.mean(1.0 / values)),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "evaluated_queries": self.evaluated_queries,
            "top_1_accuracy": self.top_1_accuracy,
            "recall_at_5": self.recall_at_5,
            "recall_at_10": self.recall_at_10,
            "mean_reciprocal_rank": self.mean_reciprocal_rank,
        }


@dataclass(frozen=True)
class DualEncoderTrainingSummary:
    model_path: str
    browser_model_path: Optional[str]
    encoder_kind: str
    feature_kind: str
    embedding_dimensions: int
    hidden_dimensions: int
    ridge_alpha: float
    mlp_alpha: float
    rerank_limit: int
    blend_weight: float
    training_sample_groups: int
    validation_sample_groups: int
    training_pairs: int
    domain_calibration_groups: int
    domain_calibration_pairs: int
    baseline_metrics: RankingMetrics
    candidate_metrics: RankingMetrics
    promotion_passed: bool
    validation_seed: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "model_path": self.model_path,
            "browser_model_path": self.browser_model_path,
            "encoder_kind": self.encoder_kind,
            "feature_kind": self.feature_kind,
            "embedding_dimensions": self.embedding_dimensions,
            "hidden_dimensions": self.hidden_dimensions,
            "ridge_alpha": self.ridge_alpha,
            "mlp_alpha": self.mlp_alpha,
            "rerank_limit": self.rerank_limit,
            "blend_weight": self.blend_weight,
            "training_sample_groups": self.training_sample_groups,
            "validation_sample_groups": self.validation_sample_groups,
            "training_pairs": self.training_pairs,
            "domain_calibration_groups": self.domain_calibration_groups,
            "domain_calibration_pairs": self.domain_calibration_pairs,
            "baseline_metrics": self.baseline_metrics.as_dict(),
            "candidate_metrics": self.candidate_metrics.as_dict(),
            "promotion_passed": self.promotion_passed,
            "validation_seed": self.validation_seed,
        }


class DualCurveEncoder:
    """Compact browser-portable shape encoders with a shared cosine space.

    Version 1 keeps the original linear Ridge query projection. Version 2
    adds one tanh hidden layer so image-recovered Curves can learn nonlinear
    corrections. Version 3 joins a canonical 3,200-D image representation and
    the 384-D Curve representation before learning the nonlinear projection.
    Candidate shapes remain in a deterministic PCA space.
    """

    def __init__(self, model_path: Optional[Path] = None) -> None:
        self.version = MODEL_VERSION
        self.query_weights = np.empty((0, 0), dtype=np.float64)
        self.query_intercept = np.empty(0, dtype=np.float64)
        self.query_input_mean = np.empty(0, dtype=np.float64)
        self.query_input_scale = np.empty(0, dtype=np.float64)
        self.query_hidden_weights = np.empty((0, 0), dtype=np.float64)
        self.query_hidden_intercept = np.empty(0, dtype=np.float64)
        self.query_output_weights = np.empty((0, 0), dtype=np.float64)
        self.query_output_intercept = np.empty(0, dtype=np.float64)
        self.candidate_mean = np.empty(0, dtype=np.float64)
        self.candidate_components = np.empty((0, 0), dtype=np.float64)
        self.blend_weight = 0.0
        self.rerank_limit = DEFAULT_RERANK_LIMIT
        self.validation: dict[str, Any] = {}
        if model_path is not None:
            self.load(model_path)

    @property
    def input_dimensions(self) -> int:
        if self.version == LINEAR_MODEL_VERSION:
            return int(self.query_weights.shape[1])
        return int(self.query_hidden_weights.shape[1])

    @property
    def embedding_dimensions(self) -> int:
        if self.version == LINEAR_MODEL_VERSION:
            return int(self.query_weights.shape[0])
        return int(self.query_output_weights.shape[0])

    @property
    def hidden_dimensions(self) -> int:
        if self.version == LINEAR_MODEL_VERSION:
            return 0
        return int(self.query_hidden_weights.shape[0])

    @property
    def kind(self) -> str:
        return "linear" if self.version == LINEAR_MODEL_VERSION else "nonlinear"

    @property
    def feature_kind(self) -> str:
        return (
            "image-curve"
            if self.version == FUSED_NONLINEAR_MODEL_VERSION
            else "curve"
        )

    def load(self, model_path: Path) -> None:
        payload = joblib.load(model_path)
        version = int(payload.get("version", 0))
        if version not in SUPPORTED_MODEL_VERSIONS:
            raise ValueError("Unsupported dual encoder version")
        self.version = version
        if self.version == LINEAR_MODEL_VERSION:
            self.query_weights = np.asarray(
                payload["query_weights"],
                dtype=np.float64,
            )
            self.query_intercept = np.asarray(
                payload["query_intercept"],
                dtype=np.float64,
            )
        else:
            self.query_input_mean = np.asarray(
                payload["query_input_mean"],
                dtype=np.float64,
            )
            self.query_input_scale = np.asarray(
                payload["query_input_scale"],
                dtype=np.float64,
            )
            self.query_hidden_weights = np.asarray(
                payload["query_hidden_weights"],
                dtype=np.float64,
            )
            self.query_hidden_intercept = np.asarray(
                payload["query_hidden_intercept"],
                dtype=np.float64,
            )
            self.query_output_weights = np.asarray(
                payload["query_output_weights"],
                dtype=np.float64,
            )
            self.query_output_intercept = np.asarray(
                payload["query_output_intercept"],
                dtype=np.float64,
            )
        self.candidate_mean = np.asarray(
            payload["candidate_mean"],
            dtype=np.float64,
        )
        self.candidate_components = np.asarray(
            payload["candidate_components"],
            dtype=np.float64,
        )
        self.blend_weight = float(payload["blend_weight"])
        self.rerank_limit = int(payload["rerank_limit"])
        self.validation = dict(payload.get("validation", {}))
        self._validate()

    def _validate(self) -> None:
        if self.version == LINEAR_MODEL_VERSION:
            if self.query_weights.ndim != 2 or not self.query_weights.size:
                raise ValueError("Dual encoder query weights are empty")
            embedding_dimensions, input_dimensions = self.query_weights.shape
            if self.query_intercept.shape != (embedding_dimensions,):
                raise ValueError("Dual encoder query intercept is misaligned")
            query_arrays = (
                self.query_weights,
                self.query_intercept,
            )
        elif self.version in {
            NONLINEAR_MODEL_VERSION,
            FUSED_NONLINEAR_MODEL_VERSION,
        }:
            if (
                self.query_hidden_weights.ndim != 2
                or not self.query_hidden_weights.size
                or self.query_output_weights.ndim != 2
                or not self.query_output_weights.size
            ):
                raise ValueError("Nonlinear dual encoder query weights are empty")
            hidden_dimensions, input_dimensions = self.query_hidden_weights.shape
            embedding_dimensions, output_hidden_dimensions = (
                self.query_output_weights.shape
            )
            if output_hidden_dimensions != hidden_dimensions:
                raise ValueError("Nonlinear dual encoder hidden layers are misaligned")
            if self.query_input_mean.shape != (input_dimensions,):
                raise ValueError("Nonlinear dual encoder query mean is misaligned")
            if self.query_input_scale.shape != (input_dimensions,):
                raise ValueError("Nonlinear dual encoder query scale is misaligned")
            if np.any(self.query_input_scale <= 0):
                raise ValueError("Nonlinear dual encoder query scale must be positive")
            if self.query_hidden_intercept.shape != (hidden_dimensions,):
                raise ValueError("Nonlinear dual encoder hidden intercept is misaligned")
            if self.query_output_intercept.shape != (embedding_dimensions,):
                raise ValueError("Nonlinear dual encoder output intercept is misaligned")
            query_arrays = (
                self.query_input_mean,
                self.query_input_scale,
                self.query_hidden_weights,
                self.query_hidden_intercept,
                self.query_output_weights,
                self.query_output_intercept,
            )
        else:
            raise ValueError("Unsupported dual encoder version")
        expected_input_dimensions = (
            FUSED_SHAPE_EMBEDDING_DIMENSIONS
            if self.version == FUSED_NONLINEAR_MODEL_VERSION
            else CURVE_EMBEDDING_DIMENSIONS
        )
        if input_dimensions != expected_input_dimensions:
            raise ValueError("Dual encoder input dimensions do not match its feature kind")
        if self.candidate_mean.shape != (input_dimensions,):
            raise ValueError("Dual encoder candidate mean is misaligned")
        if self.candidate_components.shape != (
            embedding_dimensions,
            input_dimensions,
        ):
            raise ValueError("Dual encoder candidate components are misaligned")
        arrays = (
            *query_arrays,
            self.candidate_mean,
            self.candidate_components,
        )
        if any(not np.all(np.isfinite(values)) for values in arrays):
            raise ValueError("Dual encoder contains non-finite values")
        if not 0.0 <= self.blend_weight <= 1.0:
            raise ValueError("Dual encoder blend weight is outside [0, 1]")
        if self.rerank_limit < 1:
            raise ValueError("Dual encoder rerank limit must be positive")

    def encode_query(self, curve_embedding: np.ndarray) -> np.ndarray:
        values = np.asarray(curve_embedding, dtype=np.float64).reshape(-1)
        if (
            self.version == FUSED_NONLINEAR_MODEL_VERSION
            and values.shape == (CURVE_EMBEDDING_DIMENSIONS,)
        ):
            values = fused_shape_embedding_from_curve_embedding(values)
        if values.shape != (self.input_dimensions,):
            raise ValueError("Query shape embedding dimension does not match the model")
        if self.version == LINEAR_MODEL_VERSION:
            encoded = (
                _matrix_product(self.query_weights, values)
                + self.query_intercept
            )
        else:
            standardized = (
                values - self.query_input_mean
            ) / self.query_input_scale
            hidden = np.tanh(
                _matrix_product(self.query_hidden_weights, standardized)
                + self.query_hidden_intercept
            )
            encoded = (
                _matrix_product(self.query_output_weights, hidden)
                + self.query_output_intercept
            )
        return _unit(encoded)

    def encode_candidate(self, curve_embedding: np.ndarray) -> np.ndarray:
        values = np.asarray(curve_embedding, dtype=np.float64).reshape(-1)
        if (
            self.version == FUSED_NONLINEAR_MODEL_VERSION
            and values.shape == (CURVE_EMBEDDING_DIMENSIONS,)
        ):
            values = fused_shape_embedding_from_curve_embedding(values)
        if values.shape != (self.input_dimensions,):
            raise ValueError("Candidate shape embedding dimension does not match the model")
        encoded = _matrix_product(
            self.candidate_components,
            values - self.candidate_mean,
        )
        return _unit(encoded)

    def similarity(
        self,
        query_curve_embedding: np.ndarray,
        candidate_curve_embedding: np.ndarray,
    ) -> float:
        cosine = float(
            np.dot(
                self.encode_query(query_curve_embedding),
                self.encode_candidate(candidate_curve_embedding),
            )
        )
        return float(np.clip((cosine + 1.0) / 2.0, 0.0, 1.0))

    def export_browser_payload(self) -> dict[str, Any]:
        self._validate()

        def rounded(values: np.ndarray) -> Any:
            return np.round(values.astype(np.float64), 9).tolist()

        payload = {
            "version": self.version,
            "kind": (
                "vth-dual-curve-linear"
                if self.version == LINEAR_MODEL_VERSION
                else (
                    "vth-dual-image-curve-mlp"
                    if self.version == FUSED_NONLINEAR_MODEL_VERSION
                    else "vth-dual-curve-mlp"
                )
            ),
            "inputDimensions": self.input_dimensions,
            "embeddingDimensions": self.embedding_dimensions,
            "candidateMean": rounded(self.candidate_mean),
            "candidateComponents": rounded(self.candidate_components),
            "blendWeight": self.blend_weight,
            "rerankLimit": self.rerank_limit,
            "validation": self.validation,
        }
        if self.version == LINEAR_MODEL_VERSION:
            payload.update(
                {
                    "queryWeights": rounded(self.query_weights),
                    "queryIntercept": rounded(self.query_intercept),
                }
            )
        else:
            payload.update(
                {
                    "hiddenDimensions": self.hidden_dimensions,
                    "activation": "tanh",
                    "queryInputMean": rounded(self.query_input_mean),
                    "queryInputScale": rounded(self.query_input_scale),
                    "queryHiddenWeights": rounded(self.query_hidden_weights),
                    "queryHiddenIntercept": rounded(
                        self.query_hidden_intercept
                    ),
                    "queryOutputWeights": rounded(self.query_output_weights),
                    "queryOutputIntercept": rounded(
                        self.query_output_intercept
                    ),
                }
            )
        return payload


def _state_count(record: VectorRecord) -> int:
    return int(
        record.metadata.get(
            "state_count",
            record.descriptor.get("peak_count", 0),
        )
    )


def _group_records(records: Sequence[VectorRecord]) -> dict[str, list[VectorRecord]]:
    grouped: dict[str, list[VectorRecord]] = {}
    for record in records:
        grouped.setdefault(record.sample_id, []).append(record)
    return grouped


def _stratified_sample_split(
    grouped: dict[str, list[VectorRecord]],
    *,
    validation_fraction: float,
    seed: int,
) -> tuple[list[str], list[str]]:
    if not 0.1 <= validation_fraction <= 0.5:
        raise ValueError("validation_fraction must be between 0.1 and 0.5")
    rng = np.random.default_rng(seed)
    training: list[str] = []
    validation: list[str] = []
    by_state: dict[int, list[str]] = {}
    for sample_id, records in grouped.items():
        by_state.setdefault(_state_count(records[0]), []).append(sample_id)
    for state_count in sorted(by_state):
        sample_ids = np.asarray(sorted(by_state[state_count]), dtype=object)
        if len(sample_ids) < 4:
            raise ValueError(
                "Each State needs at least four sample groups for dual encoder validation"
            )
        rng.shuffle(sample_ids)
        validation_count = max(1, round(len(sample_ids) * validation_fraction))
        validation.extend(str(value) for value in sample_ids[:validation_count])
        training.extend(str(value) for value in sample_ids[validation_count:])
    return sorted(training), sorted(validation)


def _feature_from_curve_embedding(
    curve_embedding: np.ndarray,
    feature_kind: str,
) -> np.ndarray:
    if feature_kind == "curve":
        return np.asarray(curve_embedding, dtype=np.float64)
    if feature_kind == "image-curve":
        return fused_shape_embedding_from_curve_embedding(curve_embedding)
    raise ValueError(f"Unsupported dual encoder feature kind: {feature_kind}")


def _fit_encoder_arrays(
    grouped: dict[str, list[VectorRecord]],
    sample_ids: Sequence[str],
    *,
    encoder_kind: str,
    feature_kind: str,
    embedding_dimensions: int,
    ridge_alpha: float,
    hidden_dimensions: int,
    mlp_alpha: float,
    mlp_max_iter: int,
    seed: int,
    query_features: Optional[dict[str, list[np.ndarray]]] = None,
    domain_groups: Sequence[Sequence[np.ndarray]] = (),
    domain_weight: int = 1,
) -> tuple[dict[str, np.ndarray], int]:
    domain_prototypes = [
        _unit(np.mean(np.asarray(group, dtype=np.float64), axis=0))
        for group in domain_groups
    ]
    unique_targets = np.asarray(
        [
            _feature_from_curve_embedding(
                grouped[sample_id][0].curve_embedding,
                feature_kind,
            )
            for sample_id in sample_ids
        ],
        dtype=np.float64,
    )
    dimensions = min(
        int(embedding_dimensions),
        len(unique_targets) - 1,
        unique_targets.shape[1],
    )
    if dimensions < 2:
        raise ValueError("At least two dual encoder dimensions are required")

    query_inputs: list[np.ndarray] = []
    target_inputs: list[np.ndarray] = []
    for sample_id in sample_ids:
        target = _feature_from_curve_embedding(
            grouped[sample_id][0].curve_embedding,
            feature_kind,
        )
        sample_query_features = (
            query_features.get(sample_id, [])
            if query_features is not None
            else [
                _feature_from_curve_embedding(
                    extract_features(Path(record.image_path)).curve_embedding,
                    feature_kind,
                )
                for record in grouped[sample_id]
            ]
        )
        if not sample_query_features:
            raise ValueError(
                f"No query features are available for sample {sample_id}"
            )
        for query_feature in sample_query_features:
            query_inputs.append(np.asarray(query_feature, dtype=np.float64))
            target_inputs.append(target)
    for group, prototype in zip(domain_groups, domain_prototypes):
        for _ in range(domain_weight):
            for query_feature in group:
                query_inputs.append(
                    np.asarray(query_feature, dtype=np.float64)
                )
                target_inputs.append(prototype)
    query_matrix = np.asarray(query_inputs, dtype=np.float64)
    target_matrix = np.asarray(target_inputs, dtype=np.float64)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        pca = PCA(n_components=dimensions, svd_solver="full").fit(unique_targets)
        target_latent = pca.transform(target_matrix)
        if encoder_kind == "linear":
            ridge = Ridge(alpha=ridge_alpha).fit(query_matrix, target_latent)
            query_arrays = {
                "query_weights": np.asarray(ridge.coef_, dtype=np.float64),
                "query_intercept": np.asarray(
                    ridge.intercept_,
                    dtype=np.float64,
                ),
            }
        else:
            query_input_mean = np.mean(query_matrix, axis=0)
            query_input_scale = np.std(query_matrix, axis=0)
            query_input_scale = np.where(
                query_input_scale >= 1e-6,
                query_input_scale,
                1.0,
            )
            standardized = (
                query_matrix - query_input_mean
            ) / query_input_scale
            mlp = MLPRegressor(
                hidden_layer_sizes=(hidden_dimensions,),
                activation="tanh",
                solver="lbfgs",
                alpha=mlp_alpha,
                max_iter=mlp_max_iter,
                random_state=seed,
                tol=1e-7,
            ).fit(standardized, target_latent)
            query_arrays = {
                "query_input_mean": np.asarray(
                    query_input_mean,
                    dtype=np.float64,
                ),
                "query_input_scale": np.asarray(
                    query_input_scale,
                    dtype=np.float64,
                ),
                "query_hidden_weights": np.asarray(
                    mlp.coefs_[0].T,
                    dtype=np.float64,
                ),
                "query_hidden_intercept": np.asarray(
                    mlp.intercepts_[0],
                    dtype=np.float64,
                ),
                "query_output_weights": np.asarray(
                    mlp.coefs_[1].T,
                    dtype=np.float64,
                ),
                "query_output_intercept": np.asarray(
                    mlp.intercepts_[1],
                    dtype=np.float64,
                ),
            }
    arrays = {
        **query_arrays,
        "candidate_mean": np.asarray(pca.mean_, dtype=np.float64),
        "candidate_components": np.asarray(pca.components_, dtype=np.float64),
    }
    if any(not np.all(np.isfinite(values)) for values in arrays.values()):
        raise ValueError("Dual encoder fitting produced non-finite values")
    return arrays, len(query_inputs)


def _encoder_from_arrays(
    arrays: dict[str, np.ndarray],
    *,
    encoder_kind: str,
    feature_kind: str,
    blend_weight: float,
    rerank_limit: int,
) -> DualCurveEncoder:
    encoder = DualCurveEncoder()
    encoder.version = (
        LINEAR_MODEL_VERSION
        if encoder_kind == "linear"
        else (
            FUSED_NONLINEAR_MODEL_VERSION
            if feature_kind == "image-curve"
            else NONLINEAR_MODEL_VERSION
        )
    )
    if encoder.version == LINEAR_MODEL_VERSION:
        encoder.query_weights = arrays["query_weights"]
        encoder.query_intercept = arrays["query_intercept"]
    else:
        encoder.query_input_mean = arrays["query_input_mean"]
        encoder.query_input_scale = arrays["query_input_scale"]
        encoder.query_hidden_weights = arrays["query_hidden_weights"]
        encoder.query_hidden_intercept = arrays["query_hidden_intercept"]
        encoder.query_output_weights = arrays["query_output_weights"]
        encoder.query_output_intercept = arrays["query_output_intercept"]
    encoder.candidate_mean = arrays["candidate_mean"]
    encoder.candidate_components = arrays["candidate_components"]
    encoder.blend_weight = blend_weight
    encoder.rerank_limit = rerank_limit
    encoder._validate()
    return encoder


def _baseline_score(
    query: Any,
    candidate: Any,
    reranker: Optional[PairwiseReranker],
) -> float:
    components = similarity_components(query, candidate)
    retrieval = (
        0.18 * components["image_cosine"]
        + 0.82 * components["curve_cosine"]
    )
    if reranker is None:
        base_score = (
            0.30 * components["image_cosine"]
            + 0.38 * components["curve_cosine"]
            + 0.10 * components["peak_count_similarity"]
            + 0.07 * components["peak_location_similarity"]
            + 0.05 * components["peak_width_similarity"]
            + 0.05 * components["valley_similarity"]
            + 0.05 * components["tail_slope_similarity"]
        )
    else:
        model_score = reranker.score_components(components)
        base_score = (
            0.70 * components["curve_cosine"]
            + 0.25 * model_score
            + 0.05 * retrieval
        )
    peak_valley_weight = components["peak_valley_weight"]
    reranked = (
        (1.0 - peak_valley_weight) * base_score
        + peak_valley_weight * components["peak_valley_similarity"]
    )
    return float(0.70 * reranked + 0.30 * retrieval)


def _query_path(
    sample_id: str,
    grouped: dict[str, list[VectorRecord]],
    validation_query_dir: Optional[Path],
) -> Path:
    if validation_query_dir is not None:
        heldout = validation_query_dir / f"{sample_id}--heldout.png"
        if heldout.exists():
            return heldout
    variants = grouped[sample_id]
    preferred = next(
        (record for record in variants if record.variant_id != "base"),
        variants[0],
    )
    return Path(preferred.image_path)


def _evaluate_blends(
    grouped: dict[str, list[VectorRecord]],
    validation_sample_ids: Sequence[str],
    encoder: DualCurveEncoder,
    *,
    reranker: Optional[PairwiseReranker],
    validation_query_dir: Optional[Path],
    validation_query_features: Optional[dict[str, np.ndarray]],
    blend_candidates: Sequence[float],
) -> tuple[float, RankingMetrics, RankingMetrics]:
    baseline_ranks: list[int] = []
    candidate_ranks: dict[float, list[int]] = {
        float(weight): [] for weight in blend_candidates
    }
    for sample_id in validation_sample_ids:
        query = extract_features(
            _query_path(sample_id, grouped, validation_query_dir)
        )
        learned_query_embedding = (
            validation_query_features[sample_id]
            if validation_query_features is not None
            else query.curve_embedding
        )
        state_count = _state_count(grouped[sample_id][0])
        scored: list[tuple[float, str, float]] = []
        for candidate_id in validation_sample_ids:
            candidate_records = grouped[candidate_id]
            if _state_count(candidate_records[0]) != state_count:
                continue
            baseline = max(
                _baseline_score(
                    query,
                    record.feature_bundle(),
                    reranker,
                )
                for record in candidate_records
            )
            learned = encoder.similarity(
                learned_query_embedding,
                candidate_records[0].curve_embedding,
            )
            scored.append((baseline, candidate_id, learned))
        scored.sort(key=lambda item: (-item[0], item[1]))
        baseline_order = [candidate_id for _, candidate_id, _ in scored]
        baseline_ranks.append(baseline_order.index(sample_id) + 1)
        head = scored[: encoder.rerank_limit]
        tail = [(baseline, candidate_id) for baseline, candidate_id, _ in scored[
            encoder.rerank_limit :
        ]]
        for weight, ranks in candidate_ranks.items():
            reranked_head = sorted(
                (
                    (
                        (1.0 - weight) * baseline + weight * learned,
                        candidate_id,
                    )
                    for baseline, candidate_id, learned in head
                ),
                key=lambda item: (-item[0], item[1]),
            )
            order = [
                candidate_id
                for _, candidate_id in (*reranked_head, *tail)
            ]
            ranks.append(order.index(sample_id) + 1)

    baseline_metrics = RankingMetrics.from_ranks(baseline_ranks)

    def eligible(weight: float) -> bool:
        metrics = RankingMetrics.from_ranks(candidate_ranks[weight])
        tolerance = 1e-12
        return (
            metrics.recall_at_5 + tolerance >= baseline_metrics.recall_at_5
            and metrics.recall_at_10 + tolerance >= baseline_metrics.recall_at_10
            and metrics.mean_reciprocal_rank + tolerance
            >= baseline_metrics.mean_reciprocal_rank
        )

    safe_weights = [
        weight for weight in candidate_ranks if eligible(weight)
    ]
    if not safe_weights:
        safe_weights = [0.0]
    selected_weight = max(
        safe_weights,
        key=lambda weight: (
            RankingMetrics.from_ranks(
                candidate_ranks[weight]
            ).top_1_accuracy,
            RankingMetrics.from_ranks(
                candidate_ranks[weight]
            ).mean_reciprocal_rank,
            RankingMetrics.from_ranks(
                candidate_ranks[weight]
            ).recall_at_5,
            -weight,
        ),
    )
    candidate_metrics = RankingMetrics.from_ranks(
        candidate_ranks[selected_weight]
    )
    return selected_weight, baseline_metrics, candidate_metrics


def _load_browser_pair_features(
    path: Path,
) -> tuple[
    dict[str, list[np.ndarray]],
    dict[str, np.ndarray],
    str,
]:
    payload = json.loads(path.resolve().read_text(encoding="utf-8"))
    representation = (
        int(payload.get("schemaVersion", 0)),
        str(payload.get("representation", "")),
    )
    if representation == (1, "browser-curve-profile-v1"):
        feature_kind = "curve"
        feature_name = "curveFeature"
        dimensions = CURVE_EMBEDDING_DIMENSIONS
    elif representation == (2, "browser-image-curve-profile-v2"):
        feature_kind = "image-curve"
        feature_name = "shapeFeature"
        dimensions = FUSED_SHAPE_EMBEDDING_DIMENSIONS
    else:
        raise ValueError("Unsupported browser dual-encoder pair dataset")

    training: dict[str, list[np.ndarray]] = {}
    for record in payload.get("records", []):
        sample_id = str(record.get("sampleId", ""))
        feature = np.asarray(record.get(feature_name), dtype=np.float64)
        if not sample_id or feature.shape != (dimensions,) or not np.all(
            np.isfinite(feature)
        ):
            raise ValueError("Browser training pair contains an invalid feature")
        training.setdefault(sample_id, []).append(feature)

    validation: dict[str, np.ndarray] = {}
    for sample_id, values in payload.get("validationQueries", {}).items():
        feature = np.asarray(values, dtype=np.float64)
        if feature.shape != (dimensions,) or not np.all(np.isfinite(feature)):
            raise ValueError("Browser validation query contains an invalid feature")
        validation[str(sample_id)] = feature
    return training, validation, feature_kind


def _load_domain_calibration_groups(
    paths: Sequence[Path],
    *,
    feature_kind: str,
) -> tuple[list[list[np.ndarray]], list[str]]:
    groups: list[list[np.ndarray]] = []
    suites: list[str] = []
    for path in paths:
        payload = json.loads(path.resolve().read_text(encoding="utf-8"))
        suite_name = str(payload.get("suiteName", path.stem))
        grouped: dict[str, list[np.ndarray]] = {}
        for result in payload.get("results", []):
            group_id = str(result.get("group", ""))
            profile = np.asarray(result.get("profile"), dtype=np.float64)
            if (
                not group_id
                or profile.shape != (256,)
                or not np.all(np.isfinite(profile))
            ):
                raise ValueError(
                    f"Domain calibration report is missing a valid profile: {path}"
                )
            grouped.setdefault(group_id, []).append(
                (
                    fused_shape_embedding_from_profile(profile)
                    if feature_kind == "image-curve"
                    else curve_embedding_from_profile(profile)
                )
            )
        valid_groups = [
            values for values in grouped.values() if len(values) >= 2
        ]
        if not valid_groups:
            raise ValueError(
                f"Domain calibration report has no style-variant groups: {path}"
            )
        groups.extend(valid_groups)
        suites.append(suite_name)
    return groups, suites


def train_dual_curve_encoder(
    index_path: Path,
    model_path: Path,
    *,
    browser_model_path: Optional[Path] = None,
    browser_pairs_path: Optional[Path] = None,
    domain_report_paths: Sequence[Path] = (),
    domain_weight: int = 4,
    reranker_model_path: Optional[Path] = None,
    validation_query_dir: Optional[Path] = None,
    encoder_kind: str = DEFAULT_ENCODER_KIND,
    feature_kind: str = "image-curve",
    embedding_dimensions: int = DEFAULT_EMBEDDING_DIMENSIONS,
    ridge_alpha: float = DEFAULT_RIDGE_ALPHA,
    hidden_dimensions: int = DEFAULT_HIDDEN_DIMENSIONS,
    mlp_alpha: float = DEFAULT_MLP_ALPHA,
    mlp_max_iter: int = DEFAULT_MLP_MAX_ITER,
    validation_fraction: float = 0.25,
    seed: int = 20260727,
    rerank_limit: int = DEFAULT_RERANK_LIMIT,
    blend_candidates: Sequence[float] = DEFAULT_BLEND_CANDIDATES,
) -> DualEncoderTrainingSummary:
    """Train, validate, and refit a dual encoder on all sample groups."""

    if encoder_kind not in SUPPORTED_ENCODER_KINDS:
        raise ValueError(
            f"encoder_kind must be one of {sorted(SUPPORTED_ENCODER_KINDS)}"
        )
    if feature_kind not in SUPPORTED_FEATURE_KINDS:
        raise ValueError(
            f"feature_kind must be one of {sorted(SUPPORTED_FEATURE_KINDS)}"
        )
    if feature_kind == "image-curve" and encoder_kind != "nonlinear":
        raise ValueError("The fused image–Curve encoder requires nonlinear mode")
    if ridge_alpha <= 0:
        raise ValueError("ridge_alpha must be positive")
    if embedding_dimensions < 2:
        raise ValueError("embedding_dimensions must be at least two")
    if rerank_limit < 1:
        raise ValueError("rerank_limit must be positive")
    if hidden_dimensions < 2:
        raise ValueError("hidden_dimensions must be at least two")
    if mlp_alpha <= 0:
        raise ValueError("mlp_alpha must be positive")
    if mlp_max_iter < 1:
        raise ValueError("mlp_max_iter must be positive")
    if domain_weight < 1:
        raise ValueError("domain_weight must be positive")
    weights = tuple(float(value) for value in blend_candidates)
    if not weights or any(value < 0.0 or value > 1.0 for value in weights):
        raise ValueError("blend_candidates must contain values in [0, 1]")
    if 0.0 not in weights:
        weights = (0.0, *weights)

    index_path = index_path.resolve()
    with SQLiteVectorStore(index_path) as store:
        grouped = _group_records(store.all_records())
    browser_training_features: Optional[dict[str, list[np.ndarray]]] = None
    browser_validation_features: Optional[dict[str, np.ndarray]] = None
    if browser_pairs_path is not None:
        (
            browser_training_features,
            browser_validation_features,
            browser_feature_kind,
        ) = _load_browser_pair_features(browser_pairs_path)
        if browser_feature_kind != feature_kind:
            raise ValueError(
                "Browser pair feature kind does not match the requested encoder"
            )
        missing_training = sorted(set(grouped) - set(browser_training_features))
        if missing_training:
            raise ValueError(
                "Browser pair dataset is missing indexed samples: "
                + ", ".join(missing_training[:3])
            )
    domain_groups, domain_suites = _load_domain_calibration_groups(
        tuple(path.resolve() for path in domain_report_paths),
        feature_kind=feature_kind,
    )
    training_ids, validation_ids = _stratified_sample_split(
        grouped,
        validation_fraction=validation_fraction,
        seed=seed,
    )
    validation_arrays, _validation_training_pairs = _fit_encoder_arrays(
        grouped,
        training_ids,
        encoder_kind=encoder_kind,
        feature_kind=feature_kind,
        embedding_dimensions=embedding_dimensions,
        ridge_alpha=ridge_alpha,
        hidden_dimensions=hidden_dimensions,
        mlp_alpha=mlp_alpha,
        mlp_max_iter=mlp_max_iter,
        seed=seed,
        query_features=browser_training_features,
        domain_groups=domain_groups,
        domain_weight=domain_weight,
    )
    validation_encoder = _encoder_from_arrays(
        validation_arrays,
        encoder_kind=encoder_kind,
        feature_kind=feature_kind,
        blend_weight=0.0,
        rerank_limit=rerank_limit,
    )
    reranker = (
        PairwiseReranker(reranker_model_path.resolve())
        if reranker_model_path is not None and reranker_model_path.exists()
        else None
    )
    selected_weight, baseline_metrics, candidate_metrics = _evaluate_blends(
        grouped,
        validation_ids,
        validation_encoder,
        reranker=reranker,
        validation_query_dir=(
            validation_query_dir.resolve()
            if validation_query_dir is not None
            else None
        ),
        validation_query_features=browser_validation_features,
        blend_candidates=weights,
    )
    tolerance = 1e-12
    promotion_passed = (
        selected_weight > 0.0
        and candidate_metrics.top_1_accuracy + tolerance
        >= baseline_metrics.top_1_accuracy
        and candidate_metrics.recall_at_5 + tolerance
        >= baseline_metrics.recall_at_5
        and candidate_metrics.recall_at_10 + tolerance
        >= baseline_metrics.recall_at_10
        and candidate_metrics.mean_reciprocal_rank + tolerance
        >= baseline_metrics.mean_reciprocal_rank
    )
    if not promotion_passed:
        selected_weight = 0.0

    all_sample_ids = sorted(grouped)
    final_arrays, final_training_pairs = _fit_encoder_arrays(
        grouped,
        all_sample_ids,
        encoder_kind=encoder_kind,
        feature_kind=feature_kind,
        embedding_dimensions=embedding_dimensions,
        ridge_alpha=ridge_alpha,
        hidden_dimensions=hidden_dimensions,
        mlp_alpha=mlp_alpha,
        mlp_max_iter=mlp_max_iter,
        seed=seed,
        query_features=browser_training_features,
        domain_groups=domain_groups,
        domain_weight=domain_weight,
    )
    validation_payload = {
        "sampleSplit": "state-stratified-sample-id",
        "seed": seed,
        "baseline": baseline_metrics.as_dict(),
        "candidate": candidate_metrics.as_dict(),
        "promotionPassed": promotion_passed,
        "domainCalibration": {
            "suites": domain_suites,
            "groups": len(domain_groups),
            "weight": domain_weight,
        },
        "architecture": {
            "kind": encoder_kind,
            "featureKind": feature_kind,
            "hiddenDimensions": (
                hidden_dimensions if encoder_kind == "nonlinear" else 0
            ),
            "activation": "tanh" if encoder_kind == "nonlinear" else None,
            "mlpAlpha": mlp_alpha if encoder_kind == "nonlinear" else None,
        },
    }
    model_payload = {
        "version": (
            LINEAR_MODEL_VERSION
            if encoder_kind == "linear"
            else (
                FUSED_NONLINEAR_MODEL_VERSION
                if feature_kind == "image-curve"
                else NONLINEAR_MODEL_VERSION
            )
        ),
        **final_arrays,
        "blend_weight": selected_weight,
        "rerank_limit": rerank_limit,
        "validation": validation_payload,
    }
    model_path = model_path.resolve()
    model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model_payload, model_path)

    final_encoder = DualCurveEncoder(model_path)
    if browser_model_path is not None:
        browser_model_path = browser_model_path.resolve()
        browser_model_path.parent.mkdir(parents=True, exist_ok=True)
        browser_model_path.write_text(
            json.dumps(
                final_encoder.export_browser_payload(),
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )

    return DualEncoderTrainingSummary(
        model_path=str(model_path),
        browser_model_path=(
            str(browser_model_path)
            if browser_model_path is not None
            else None
        ),
        encoder_kind=final_encoder.kind,
        feature_kind=final_encoder.feature_kind,
        embedding_dimensions=final_encoder.embedding_dimensions,
        hidden_dimensions=final_encoder.hidden_dimensions,
        ridge_alpha=ridge_alpha,
        mlp_alpha=mlp_alpha,
        rerank_limit=rerank_limit,
        blend_weight=selected_weight,
        training_sample_groups=len(training_ids),
        validation_sample_groups=len(validation_ids),
        training_pairs=final_training_pairs,
        domain_calibration_groups=len(domain_groups),
        domain_calibration_pairs=sum(
            len(group) for group in domain_groups
        )
        * domain_weight,
        baseline_metrics=baseline_metrics,
        candidate_metrics=candidate_metrics,
        promotion_passed=promotion_passed,
        validation_seed=seed,
    )


def _style_group_passed(
    suite_name: str,
    group: dict[str, Any],
) -> bool:
    state_consistent = bool(group.get("stateCountConsistent"))
    top_consistent = bool(group.get("topCandidateConsistent"))
    minimum_profile = float(group.get("minimumProfileSimilarity", 0.0))
    minimum_top_five = float(group.get("minimumTopFiveOverlap", 0.0))
    minimum_top_ten = float(group.get("minimumTopTenOverlap", 0.0))
    if suite_name == "user-peak-valley":
        return (
            state_consistent
            and top_consistent
            and minimum_profile >= 0.92
            and minimum_top_five >= 1.0
            and minimum_top_ten >= 0.8
        )
    top_two_consistent = bool(group.get("topTwoSetConsistent"))
    return (
        state_consistent
        and minimum_profile >= 0.95
        and (
            (
                minimum_top_five >= 0.8
                and (top_consistent or minimum_top_five >= 1.0)
            )
            or (
                minimum_profile >= 0.98
                and top_consistent
                and minimum_top_five >= 0.6
                and minimum_top_ten >= 0.8
            )
            or (
                minimum_profile >= 0.98
                and minimum_top_five >= 0.6
                and minimum_top_ten >= 0.9
                and top_two_consistent
            )
            or (
                minimum_profile >= 0.96
                and minimum_top_ten >= 0.7
            )
        )
        )


def audit_dual_curve_encoder(
    candidate_model_path: Path,
    report_paths: Sequence[Path],
    *,
    output_model_path: Optional[Path] = None,
    browser_model_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Apply the public/measured/user non-regression gate to a candidate model."""

    required_suites = {
        "public",
        "measured-multisource",
        "user-peak-valley",
    }
    reports = []
    for path in report_paths:
        payload = json.loads(path.resolve().read_text(encoding="utf-8"))
        suite_name = str(payload.get("suiteName", ""))
        fixture_count = int(payload.get("fixtureCount", 0))
        groups = list(payload.get("groupResults", []))
        counts_passed = bool(
            fixture_count > 0
            and int(payload.get("preprocessingPassed", -1)) == fixture_count
            and int(payload.get("stateCountPassed", -1)) == fixture_count
            and int(payload.get("searchPassed", -1)) == fixture_count
            and int(payload.get("endToEndPassed", -1)) == fixture_count
        )
        groups_passed = bool(
            groups
            and all(
                _style_group_passed(suite_name, group)
                for group in groups
            )
        )
        reports.append(
            {
                "suite": suite_name,
                "fixtureCount": fixture_count,
                "countsPassed": counts_passed,
                "groupsPassed": groups_passed,
                "passed": counts_passed and groups_passed,
            }
        )
    observed_suites = {report["suite"] for report in reports}
    all_passed = bool(
        required_suites.issubset(observed_suites)
        and all(report["passed"] for report in reports)
    )

    candidate_model_path = candidate_model_path.resolve()
    model_payload = joblib.load(candidate_model_path)
    synthetic_passed = bool(
        model_payload.get("validation", {}).get("promotionPassed")
    )
    promoted = bool(
        synthetic_passed
        and all_passed
        and float(model_payload.get("blend_weight", 0.0)) > 0.0
    )
    if not promoted:
        model_payload["blend_weight"] = 0.0
    model_payload.setdefault("validation", {})["external"] = {
        "requiredSuites": sorted(required_suites),
        "observedSuites": sorted(observed_suites),
        "reports": reports,
        "passed": all_passed,
    }
    model_payload["validation"]["fullyPromoted"] = promoted

    destination = (output_model_path or candidate_model_path).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model_payload, destination)
    encoder = DualCurveEncoder(destination)
    if browser_model_path is not None:
        browser_model_path = browser_model_path.resolve()
        browser_model_path.parent.mkdir(parents=True, exist_ok=True)
        browser_model_path.write_text(
            json.dumps(
                encoder.export_browser_payload(),
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
    return {
        "candidate_model_path": str(candidate_model_path),
        "model_path": str(destination),
        "browser_model_path": (
            str(browser_model_path)
            if browser_model_path is not None
            else None
        ),
        "synthetic_validation_passed": synthetic_passed,
        "external_validation_passed": all_passed,
        "promoted": promoted,
        "blend_weight": encoder.blend_weight,
        "reports": reports,
    }


def rerank_top_candidates(
    scored_candidates: Sequence[tuple[float, Any]],
    query_curve_embedding: np.ndarray,
    encoder: DualCurveEncoder,
) -> list[tuple[float, Any, float]]:
    """Reorder only the existing top-N set with the promoted learned score."""

    enriched = [
        (
            float(score),
            candidate,
            encoder.similarity(
                query_curve_embedding,
                candidate.record.curve_embedding,
            ),
        )
        for score, candidate in scored_candidates
    ]
    limit = min(encoder.rerank_limit, len(enriched))
    head = [
        (
            (1.0 - encoder.blend_weight) * baseline
            + encoder.blend_weight * learned,
            candidate,
            learned,
        )
        for baseline, candidate, learned in enriched[:limit]
    ]
    head.sort(key=lambda item: item[0], reverse=True)
    tail = [
        (baseline, candidate, learned)
        for baseline, candidate, learned in enriched[limit:]
    ]
    return [*head, *tail]
