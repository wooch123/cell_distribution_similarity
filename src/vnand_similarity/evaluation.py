"""Held-out rendering evaluation for the VTH similarity pipeline."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .features import (
    FeatureBundle,
    aligned_curve_similarity,
    explain_similarity,
    extract_features,
    similarity_components,
)
from .imaging import augment_graph_image, render_vth_graph
from .pipeline import (
    blend_peak_valley_score,
    calibrate_retrieval_score,
    search_similar,
)
from .real_data import require_valid_real_image_manifest
from .store import SQLiteVectorStore
from .synthetic import SyntheticVthSample
from .training import PairwiseReranker

RANKING_STRATEGIES = ("reranked", "retrieval", "retrieval-calibrated")


def _deduplicate_and_rerank(
    query: Any,
    retrieved: list,
    reranker: PairwiseReranker,
    *,
    ranking_strategy: str = "reranked",
) -> list:
    if ranking_strategy not in RANKING_STRATEGIES:
        raise ValueError(
            "ranking_strategy must be one of "
            f"{', '.join(RANKING_STRATEGIES)}"
        )
    best_by_sample = {}
    for candidate in retrieved:
        bundle = candidate.record.feature_bundle()
        components = similarity_components(query, bundle)
        model_score = reranker.score_components(components)
        base_score = (
            0.70 * components["curve_cosine"]
            + 0.25 * model_score
            + 0.05 * candidate.retrieval_score
        )
        reranked_score = blend_peak_valley_score(base_score, components)
        if ranking_strategy == "retrieval":
            final_score = candidate.retrieval_score
        elif ranking_strategy == "retrieval-calibrated":
            final_score = calibrate_retrieval_score(
                reranked_score,
                candidate.retrieval_score,
            )
        else:
            final_score = reranked_score
        current = best_by_sample.get(candidate.record.sample_id)
        if current is None or final_score > current[0]:
            best_by_sample[candidate.record.sample_id] = (
                final_score,
                candidate.record.vector_id,
                candidate.retrieval_score,
                model_score,
            )
    return sorted(
        (
            {
                "sample_id": sample_id,
                "score": float(values[0]),
                "vector_id": values[1],
                "retrieval_score": float(values[2]),
                "model_score": float(values[3]),
            }
            for sample_id, values in best_by_sample.items()
        ),
        key=lambda item: item["score"],
        reverse=True,
    )


def _discounted_cumulative_gain(relevances: list[float], limit: int) -> float:
    return float(
        sum(
            (2.0 ** float(relevance) - 1.0) / np.log2(rank + 1.0)
            for rank, relevance in enumerate(relevances[:limit], start=1)
        )
    )


def _graded_shape_metrics(
    ranked_sample_ids: list[str],
    raw_curve_similarities: dict[str, float],
    *,
    neighbor_count: int = 5,
) -> dict[str, Any]:
    """Measure retrieval against the numeric source Curve neighborhood.

    A different synthetic sample ID is not automatically an error: two samples
    can be effectively identical after axis removal. The source numeric Curves
    therefore define a graded oracle, while exact-source rank remains a
    stricter invariance metric.
    """

    if neighbor_count < 1:
        raise ValueError("neighbor_count must be positive")
    if not raw_curve_similarities:
        return {
            "oracle_neighbor_count": 0,
            "oracle_neighbors": [],
            "top_1_neighbor_hit": False,
            "neighbor_recall_at_5": 0.0,
            "neighbor_recall_at_10": 0.0,
            "ndcg_at_5": 0.0,
            "ndcg_at_10": 0.0,
        }

    oracle = sorted(
        raw_curve_similarities.items(),
        key=lambda item: (-item[1], item[0]),
    )
    oracle_neighbors = oracle[: min(neighbor_count, len(oracle))]
    oracle_neighbor_ids = {sample_id for sample_id, _ in oracle_neighbors}
    oracle_neighbor_count = len(oracle_neighbor_ids)

    raw_values = np.asarray([score for _, score in oracle], dtype=np.float64)
    relevance_floor = float(np.quantile(raw_values, 0.25))
    denominator = max(1.0 - relevance_floor, np.finfo(float).eps)
    gains = {
        sample_id: float(
            np.clip((score - relevance_floor) / denominator, 0.0, 1.0) ** 2
        )
        for sample_id, score in oracle
    }
    ranked_relevances = [gains.get(sample_id, 0.0) for sample_id in ranked_sample_ids]
    ideal_relevances = sorted(gains.values(), reverse=True)

    def ndcg(limit: int) -> float:
        ideal = _discounted_cumulative_gain(ideal_relevances, limit)
        if ideal <= np.finfo(float).eps:
            return 0.0
        return _discounted_cumulative_gain(ranked_relevances, limit) / ideal

    def neighbor_recall(limit: int) -> float:
        if not oracle_neighbor_count:
            return 0.0
        return (
            len(oracle_neighbor_ids.intersection(ranked_sample_ids[:limit]))
            / oracle_neighbor_count
        )

    return {
        "oracle_neighbor_count": oracle_neighbor_count,
        "oracle_neighbors": [
            {
                "sample_id": sample_id,
                "raw_curve_similarity": float(score),
            }
            for sample_id, score in oracle_neighbors
        ],
        "top_1_neighbor_hit": bool(
            ranked_sample_ids and ranked_sample_ids[0] in oracle_neighbor_ids
        ),
        "neighbor_recall_at_5": neighbor_recall(5),
        "neighbor_recall_at_10": neighbor_recall(10),
        "ndcg_at_5": ndcg(5),
        "ndcg_at_10": ndcg(10),
    }


def _metric_block(results: list[dict[str, Any]]) -> dict[str, Any]:
    evaluated = len(results)
    if not evaluated:
        return {
            "evaluated_queries": 0,
            "top_1_accuracy": 0.0,
            "recall_at_5": 0.0,
            "recall_at_10": 0.0,
            "mean_reciprocal_rank": 0.0,
            "state_count_accuracy": 0.0,
            "observed_state_count_accuracy": 0.0,
            "state_count_regularization_rate": 0.0,
            "missing_source_count": 0,
            "shape_top_1_neighbor_accuracy": 0.0,
            "shape_neighbor_recall_at_5": 0.0,
            "shape_neighbor_recall_at_10": 0.0,
            "shape_ndcg_at_5": 0.0,
            "shape_ndcg_at_10": 0.0,
        }
    ranks = [int(result["source_rank"]) for result in results if result["source_rank"]]
    reciprocal_ranks = [1.0 / rank for rank in ranks]
    shape_results = [
        result["shape_retrieval"]
        for result in results
        if result.get("shape_retrieval")
    ]
    return {
        "evaluated_queries": evaluated,
        "top_1_accuracy": sum(rank <= 1 for rank in ranks) / evaluated,
        "recall_at_5": sum(rank <= 5 for rank in ranks) / evaluated,
        "recall_at_10": sum(rank <= 10 for rank in ranks) / evaluated,
        "mean_reciprocal_rank": float(np.mean(reciprocal_ranks)) if reciprocal_ranks else 0.0,
        "state_count_accuracy": sum(
            result["detected_peak_count"] == result["expected_state_count"]
            for result in results
        )
        / evaluated,
        "observed_state_count_accuracy": sum(
            result["observed_peak_count"] == result["expected_state_count"]
            for result in results
        )
        / evaluated,
        "state_count_regularization_rate": sum(
            result["state_count_regularized"] for result in results
        )
        / evaluated,
        "missing_source_count": evaluated - len(ranks),
        "shape_top_1_neighbor_accuracy": (
            float(
                np.mean(
                    [result["top_1_neighbor_hit"] for result in shape_results]
                )
            )
            if shape_results
            else 0.0
        ),
        "shape_neighbor_recall_at_5": (
            float(
                np.mean(
                    [result["neighbor_recall_at_5"] for result in shape_results]
                )
            )
            if shape_results
            else 0.0
        ),
        "shape_neighbor_recall_at_10": (
            float(
                np.mean(
                    [result["neighbor_recall_at_10"] for result in shape_results]
                )
            )
            if shape_results
            else 0.0
        ),
        "shape_ndcg_at_5": (
            float(np.mean([result["ndcg_at_5"] for result in shape_results]))
            if shape_results
            else 0.0
        ),
        "shape_ndcg_at_10": (
            float(np.mean([result["ndcg_at_10"] for result in shape_results]))
            if shape_results
            else 0.0
        ),
    }


def _grouped_metrics(
    results: list[dict[str, Any]],
    value_getter: Any,
) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for result in results:
        value = value_getter(result)
        if isinstance(value, bool):
            key = str(value).lower()
        elif value is None:
            key = "none"
        else:
            key = str(value)
        grouped.setdefault(key, []).append(result)
    return {
        key: _metric_block(grouped[key])
        for key in sorted(grouped)
    }


def _pair_score(
    query: FeatureBundle,
    candidate: FeatureBundle,
    reranker: Optional[PairwiseReranker],
) -> tuple[float, dict[str, float], Optional[float]]:
    components = similarity_components(query, candidate)
    retrieval_score = 0.18 * components["image_cosine"] + 0.82 * components["curve_cosine"]
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
        return blend_peak_valley_score(base_score, components), components, None
    model_score = reranker.score_components(components)
    base_score = (
        0.70 * components["curve_cosine"]
        + 0.25 * model_score
        + 0.05 * retrieval_score
    )
    return (
        blend_peak_valley_score(base_score, components),
        components,
        float(model_score),
    )


def evaluate_real_image_manifest(
    manifest_path: Path,
    output_dir: Path,
    *,
    index_path: Optional[Path] = None,
    model_path: Optional[Path] = None,
    top_k: int = 10,
) -> dict[str, Any]:
    """Evaluate anonymized real VTH images with leave-one-image-out retrieval.

    The CSV follows ``docs/real-data-intake.md``. Images sharing a
    ``similarity_group`` are positives; ``product_group`` keeps unrelated
    products out of the same candidate pool. This path needs no raw VTH values
    and therefore provides the first objective evidence for real screenshots.
    """

    if top_k < 1:
        raise ValueError("top_k must be positive")
    manifest_path = manifest_path.resolve()
    if index_path is not None:
        index_path = index_path.resolve()
        if not index_path.exists():
            raise FileNotFoundError(f"Vector index does not exist: {index_path}")
    intake = require_valid_real_image_manifest(manifest_path)
    rows = list(intake.rows)

    output_dir = output_dir.resolve()
    standardized_dir = output_dir / "standardized"
    standardized_dir.mkdir(parents=True, exist_ok=True)
    loaded: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for row in rows:
        image_path = Path(row["image_path"])
        image_id = str(row["image_id"])
        preview_path = standardized_dir / f"{image_id}.png"
        try:
            bundle = extract_features(image_path, preview_path=preview_path)
        except (OSError, ValueError) as error:
            failures.append({"image_path": str(image_path), "error": str(error)})
            continue
        loaded.append(
            {
                "image_id": image_id,
                "image_path": image_path,
                "standardized_path": preview_path,
                "similarity_group": row["similarity_group"],
                "product_group": row["product_group"],
                "expected_state_count": row["state_count"],
                "expected_observed_state_count": row["observed_state_count"],
                "state_coverage": row["state_coverage"],
                "notes": row["notes"],
                "provenance": {
                    field: row[field]
                    for field in (
                        "source_id",
                        "source_url",
                        "figure_id",
                        "source_kind",
                        "independence_group",
                        "is_measured",
                    )
                    if row[field] not in {"", None}
                },
                "bundle": bundle,
            }
        )

    reranker = (
        PairwiseReranker(model_path)
        if model_path is not None and model_path.exists()
        else None
    )
    query_results = []
    reciprocal_ranks = []
    recalls_at_5 = []
    recalls_at_10 = []
    top_1_hits = []
    for query in loaded:
        candidates = []
        for candidate in loaded:
            if candidate["image_id"] == query["image_id"]:
                continue
            if (
                query["product_group"]
                and candidate["product_group"]
                and candidate["product_group"] != query["product_group"]
            ):
                continue
            score, components, model_score = _pair_score(
                query["bundle"],
                candidate["bundle"],
                reranker,
            )
            candidates.append(
                {
                    "image_id": candidate["image_id"],
                    "image_path": str(candidate["image_path"]),
                    "similarity_group": candidate["similarity_group"],
                    "score": score,
                    "model_score": model_score,
                    "components": components,
                    "reasons": explain_similarity(query["bundle"], candidate["bundle"]),
                }
            )
        candidates.sort(key=lambda item: item["score"], reverse=True)
        relevant_count = sum(
            bool(query["similarity_group"])
            and candidate["similarity_group"] == query["similarity_group"]
            for candidate in candidates
        )
        relevant_ranks = [
            rank
            for rank, candidate in enumerate(candidates, start=1)
            if query["similarity_group"]
            and candidate["similarity_group"] == query["similarity_group"]
        ]
        if relevant_count:
            reciprocal_ranks.append(1.0 / relevant_ranks[0])
            recalls_at_5.append(sum(rank <= 5 for rank in relevant_ranks) / relevant_count)
            recalls_at_10.append(sum(rank <= 10 for rank in relevant_ranks) / relevant_count)
            top_1_hits.append(bool(relevant_ranks[0] == 1))
        query_results.append(
            {
                "image_id": query["image_id"],
                "image_path": str(query["image_path"]),
                "standardized_path": str(query["standardized_path"]),
                "similarity_group": query["similarity_group"],
                "product_group": query["product_group"],
                "notes": query["notes"],
                "provenance": query["provenance"],
                "expected_state_count": query["expected_state_count"],
                "expected_observed_state_count": query[
                    "expected_observed_state_count"
                ],
                "state_coverage": query["state_coverage"],
                "detected_state_count": int(query["bundle"].descriptor["peak_count"]),
                "observed_state_count": int(
                    query["bundle"].descriptor["observed_peak_count"]
                ),
                "preprocessing": query["bundle"].preprocessing,
                "relevant_candidate_count": relevant_count,
                "relevant_ranks": relevant_ranks,
                "top_results": candidates[:top_k],
            }
        )

    invariance_pairs = []
    for left_index, left in enumerate(loaded):
        if not left["similarity_group"]:
            continue
        for right in loaded[left_index + 1 :]:
            if right["similarity_group"] != left["similarity_group"]:
                continue
            invariance_pairs.append(
                {
                    "left_image_id": left["image_id"],
                    "right_image_id": right["image_id"],
                    "similarity_group": left["similarity_group"],
                    "curve_similarity": aligned_curve_similarity(
                        left["bundle"].curve_embedding,
                        right["bundle"].curve_embedding,
                    ),
                    "state_count_consistent": (
                        left["bundle"].descriptor["peak_count"]
                        == right["bundle"].descriptor["peak_count"]
                    ),
                }
            )

    index_failures: list[dict[str, str]] = []
    index_results = []
    if index_path is not None:
        index_output_dir = output_dir / "index-search"
        for query in loaded:
            try:
                search = search_similar(
                    query["image_path"],
                    index_path,
                    index_output_dir / query["image_id"],
                    top_k=top_k,
                    model_path=model_path,
                )
            except (OSError, ValueError) as error:
                index_failures.append(
                    {"image_id": query["image_id"], "error": str(error)}
                )
                continue
            result_states = [
                int(
                    result["metadata"].get(
                        "state_count",
                        result.get("components", {}).get("peak_count", 0),
                    )
                )
                for result in search["results"]
            ]
            expected_state = query["expected_state_count"]
            state_hits = (
                [state == expected_state for state in result_states]
                if expected_state is not None
                else []
            )
            index_results.append(
                {
                    "image_id": query["image_id"],
                    "expected_state_count": expected_state,
                    "detected_state_count": int(
                        search["query_descriptor"]["peak_count"]
                    ),
                    "result_count": len(search["results"]),
                    "result_state_counts": result_states,
                    "state_precision_at_5": (
                        float(np.mean(state_hits[:5])) if state_hits else None
                    ),
                    "state_precision_at_10": (
                        float(np.mean(state_hits[:10])) if state_hits else None
                    ),
                    "top_1_state_match": state_hits[0] if state_hits else None,
                    "all_returned_states_match": (
                        all(state_hits) if state_hits else None
                    ),
                    "reason_coverage": (
                        float(
                            np.mean(
                                [
                                    bool(result.get("reasons"))
                                    for result in search["results"]
                                ]
                            )
                        )
                        if search["results"]
                        else 0.0
                    ),
                    "top_1_score": (
                        float(search["results"][0]["score"])
                        if search["results"]
                        else None
                    ),
                    "candidate_pool": search["candidate_pool"],
                    "results": search["results"],
                }
            )

    state_labelled = [
        result for result in query_results if result["expected_state_count"] is not None
    ]
    observed_state_labelled = [
        result
        for result in query_results
        if result["expected_observed_state_count"] is not None
    ]
    indexed_state_labelled = [
        result
        for result in index_results
        if result["expected_state_count"] is not None
    ]
    source_ids = {
        query["provenance"].get("source_id")
        for query in loaded
        if query["provenance"].get("source_id")
    }
    independence_groups = {
        query["provenance"].get("independence_group")
        for query in loaded
        if query["provenance"].get("independence_group")
    }
    metrics = {
        "manifest_images": len(rows),
        "processed_images": len(loaded),
        "preprocessing_success_rate": len(loaded) / len(rows),
        "failed_images": len(failures),
        "state_labelled_queries": len(state_labelled),
        "state_count_accuracy": (
            sum(
                result["detected_state_count"] == result["expected_state_count"]
                for result in state_labelled
            )
            / len(state_labelled)
            if state_labelled
            else None
        ),
        "observed_state_labelled_queries": len(observed_state_labelled),
        "raw_peak_count_matches_manifest_observed_rate": (
            sum(
                result["observed_state_count"]
                == result["expected_observed_state_count"]
                for result in observed_state_labelled
            )
            / len(observed_state_labelled)
            if observed_state_labelled
            else None
        ),
        "partial_state_coverage_queries": sum(
            result["state_coverage"] == "partial" for result in query_results
        ),
        "partial_coverage_state_count_accuracy": (
            float(
                np.mean(
                    [
                        result["detected_state_count"]
                        == result["expected_state_count"]
                        for result in query_results
                        if result["state_coverage"] == "partial"
                        and result["expected_state_count"] is not None
                    ]
                )
            )
            if any(
                result["state_coverage"] == "partial"
                and result["expected_state_count"] is not None
                for result in query_results
            )
            else None
        ),
        "relevance_queries": len(reciprocal_ranks),
        "top_1_accuracy": float(np.mean(top_1_hits)) if top_1_hits else None,
        "recall_at_5": float(np.mean(recalls_at_5)) if recalls_at_5 else None,
        "recall_at_10": float(np.mean(recalls_at_10)) if recalls_at_10 else None,
        "mean_reciprocal_rank": (
            float(np.mean(reciprocal_ranks)) if reciprocal_ranks else None
        ),
        "source_count": len(source_ids),
        "independence_group_count": len(independence_groups),
        "style_invariance_pairs": len(invariance_pairs),
        "mean_style_curve_similarity": (
            float(
                np.mean(
                    [pair["curve_similarity"] for pair in invariance_pairs]
                )
            )
            if invariance_pairs
            else None
        ),
        "style_state_count_consistency": (
            float(
                np.mean(
                    [pair["state_count_consistent"] for pair in invariance_pairs]
                )
            )
            if invariance_pairs
            else None
        ),
        "index_evaluated_queries": len(index_results),
        "index_failed_queries": len(index_failures),
        "index_state_labelled_queries": len(indexed_state_labelled),
        "index_top_1_state_accuracy": (
            float(
                np.mean(
                    [
                        result["top_1_state_match"]
                        for result in indexed_state_labelled
                    ]
                )
            )
            if indexed_state_labelled
            else None
        ),
        "index_state_precision_at_5": (
            float(
                np.mean(
                    [
                        result["state_precision_at_5"]
                        for result in indexed_state_labelled
                    ]
                )
            )
            if indexed_state_labelled
            else None
        ),
        "index_state_precision_at_10": (
            float(
                np.mean(
                    [
                        result["state_precision_at_10"]
                        for result in indexed_state_labelled
                    ]
                )
            )
            if indexed_state_labelled
            else None
        ),
        "index_all_returned_states_match_rate": (
            float(
                np.mean(
                    [
                        result["all_returned_states_match"]
                        for result in indexed_state_labelled
                    ]
                )
            )
            if indexed_state_labelled
            else None
        ),
        "index_full_result_rate": (
            float(
                np.mean(
                    [result["result_count"] == top_k for result in index_results]
                )
            )
            if index_results
            else None
        ),
        "index_reason_coverage": (
            float(np.mean([result["reason_coverage"] for result in index_results]))
            if index_results
            else None
        ),
        "index_mean_top_1_score": (
            float(
                np.mean(
                    [
                        result["top_1_score"]
                        for result in index_results
                        if result["top_1_score"] is not None
                    ]
                )
            )
            if any(result["top_1_score"] is not None for result in index_results)
            else None
        ),
    }
    payload = {
        "metrics": metrics,
        "intake_validation": intake.summary,
        "manifest_path": str(manifest_path),
        "index_path": str(index_path) if index_path else None,
        "model_path": str(model_path.resolve()) if reranker and model_path else None,
        "top_k": top_k,
        "failures": failures,
        "index_failures": index_failures,
        "invariance_pairs": invariance_pairs,
        "index_results": index_results,
        "results": query_results,
    }
    report_path = output_dir / "real-image-evaluation.json"
    report_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"report_path": str(report_path), "metrics": metrics}


def evaluate_heldout_queries(
    corpus_dir: Path,
    index_path: Path,
    model_path: Path,
    output_dir: Path,
    *,
    seed: int = 2026,
    limit: Optional[int] = None,
    ranking_strategy: str = "reranked",
) -> dict[str, Any]:
    """Evaluate new renderings that were never inserted into the vector index."""

    raw_paths = sorted((corpus_dir / "raw").glob("*.npz"))
    if limit is not None:
        raw_paths = raw_paths[:limit]
    if not raw_paths:
        raise ValueError(f"No raw samples found under {corpus_dir / 'raw'}")
    if not model_path.exists():
        raise FileNotFoundError(f"Reranker model does not exist: {model_path}")

    query_dir = output_dir / "queries"
    standardized_dir = output_dir / "standardized"
    query_dir.mkdir(parents=True, exist_ok=True)
    reranker = PairwiseReranker(model_path)
    results = []

    with SQLiteVectorStore(index_path) as store:
        candidate_limit = max(1, store.count())
        representative_records: dict[str, Any] = {}
        for record in store.all_records():
            representative_records.setdefault(record.sample_id, record)
        for sample_index, raw_path in enumerate(raw_paths):
            sample = SyntheticVthSample.load(raw_path)
            rng = np.random.default_rng(seed + sample_index * 997)
            query_path = query_dir / f"{sample.sample_id}--heldout.png"
            filled = bool(sample_index % 2 == 0)
            grid = bool(sample_index % 3 != 0)
            dpi = int(rng.integers(100, 180))
            render_vth_graph(
                sample,
                query_path,
                rng=rng,
                axes=True,
                colored=True,
                filled=filled,
                grid=grid,
                dpi=dpi,
            )
            augmentation = augment_graph_image(query_path, query_path, rng=rng)
            query = extract_features(
                query_path,
                preview_path=standardized_dir / f"{sample.sample_id}.png",
            )
            retrieved = store.search(query, limit=candidate_limit)
            ranked = _deduplicate_and_rerank(
                query,
                retrieved,
                reranker,
                ranking_strategy=ranking_strategy,
            )
            source_oracle_record = representative_records.get(sample.sample_id)
            raw_curve_similarities = {}
            if source_oracle_record is not None:
                expected_state_count = int(sample.metadata["state_count"])
                raw_curve_similarities = {
                    candidate_sample_id: aligned_curve_similarity(
                        source_oracle_record.curve_embedding,
                        candidate_record.curve_embedding,
                    )
                    for candidate_sample_id, candidate_record in (
                        representative_records.items()
                    )
                    if int(
                        candidate_record.metadata.get(
                            "state_count",
                            candidate_record.descriptor.get("peak_count", 0),
                        )
                    )
                    == expected_state_count
                }
            shape_retrieval = _graded_shape_metrics(
                [candidate["sample_id"] for candidate in ranked],
                raw_curve_similarities,
            )
            source_rank = next(
                (
                    rank
                    for rank, candidate in enumerate(ranked, start=1)
                    if candidate["sample_id"] == sample.sample_id
                ),
                None,
            )
            source_result = next(
                (
                    candidate
                    for candidate in ranked
                    if candidate["sample_id"] == sample.sample_id
                ),
                None,
            )
            source_components = None
            if source_result is not None:
                source_record = next(
                    candidate.record
                    for candidate in retrieved
                    if candidate.record.vector_id == source_result["vector_id"]
                )
                source_components = similarity_components(
                    query,
                    source_record.feature_bundle(),
                )
            results.append(
                {
                    "sample_id": sample.sample_id,
                    "query_path": str(query_path.resolve()),
                    "detected_peak_count": int(query.descriptor["peak_count"]),
                    "observed_peak_count": int(query.descriptor["observed_peak_count"]),
                    "state_count_regularized": bool(query.descriptor["state_count_regularized"]),
                    "expected_state_count": int(sample.metadata["state_count"]),
                    "source_rank": source_rank,
                    "source_components": source_components,
                    "shape_retrieval": shape_retrieval,
                    "rendering": {
                        "axes": True,
                        "colored": True,
                        "filled": filled,
                        "grid": grid,
                        "dpi": dpi,
                    },
                    "augmentation": augmentation,
                    "preprocessing": query.preprocessing,
                    "top_5": ranked[:5],
                    "top_10": ranked[:10],
                }
            )

    metrics = _metric_block(results)
    state_counts = sorted({int(result["expected_state_count"]) for result in results})
    metrics_by_state = {
        str(state_count): _metric_block(
            [
                result
                for result in results
                if int(result["expected_state_count"]) == state_count
            ]
        )
        for state_count in state_counts
    }
    metrics_by_condition = {
        "filled": _grouped_metrics(
            results,
            lambda result: result["rendering"]["filled"],
        ),
        "grid": _grouped_metrics(
            results,
            lambda result: result["rendering"]["grid"],
        ),
        "jpeg": _grouped_metrics(
            results,
            lambda result: result["augmentation"]["jpeg_quality"] is not None,
        ),
        "blur": _grouped_metrics(
            results,
            lambda result: result["augmentation"]["blur_sigma"] is not None,
        ),
        "noise": _grouped_metrics(
            results,
            lambda result: result["augmentation"]["noise_sigma"] is not None,
        ),
        "curve_extraction_mode": _grouped_metrics(
            results,
            lambda result: result["preprocessing"]["curve_extraction_mode"],
        ),
        "plot_box_source": _grouped_metrics(
            results,
            lambda result: result["preprocessing"]["plot_box_source"],
        ),
        "coordinate_mode_selection": _grouped_metrics(
            results,
            lambda result: result["preprocessing"]["coordinate_mode_selection"],
        ),
        "state_count_hypothesis_source": _grouped_metrics(
            results,
            lambda result: result["preprocessing"][
                "state_count_hypothesis_source"
            ],
        ),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / "heldout-evaluation.json"
    payload = {
        "metrics": metrics,
        "seed": seed,
        "corpus_dir": str(corpus_dir.resolve()),
        "index_path": str(index_path.resolve()),
        "model_path": str(model_path.resolve()),
        "ranking_strategy": ranking_strategy,
        "metrics_by_state": metrics_by_state,
        "metrics_by_condition": metrics_by_condition,
        "results": results,
    }
    report_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "report_path": str(report_path.resolve()),
        "metrics": metrics,
        "metrics_by_state": metrics_by_state,
    }
