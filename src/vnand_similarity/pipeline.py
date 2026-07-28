"""Offline corpus construction and online similarity search pipelines."""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np
from PIL import Image, ImageDraw, ImageOps

from .dual_encoder import DualCurveEncoder
from .features import (
    explain_similarity,
    extract_features,
    extract_log_curve_features,
    similarity_components,
)
from .imaging import augment_graph_image, render_vth_graph
from .store import SQLiteVectorStore, VectorRecord
from .synthetic import SyntheticVthSample, generate_vth_sample
from .training import PairwiseReranker

RETRIEVAL_CALIBRATION_WEIGHT = 0.30


def blend_peak_valley_score(
    base_score: float,
    components: dict[str, float],
) -> float:
    """Blend the general reranker with the local peak/valley relation."""

    weight = components["peak_valley_weight"]
    return float(
        (1.0 - weight) * base_score
        + weight * components["peak_valley_similarity"]
    )


def calibrate_retrieval_score(
    reranked_score: float,
    retrieval_score: float,
) -> float:
    """Correct the learned reranker with the raw embedding neighborhood."""

    return float(
        (1.0 - RETRIEVAL_CALIBRATION_WEIGHT) * reranked_score
        + RETRIEVAL_CALIBRATION_WEIGHT * retrieval_score
    )


@dataclass(frozen=True)
class SearchResult:
    rank: int
    vector_id: str
    sample_id: str
    image_path: str
    raw_path: str
    score: float
    retrieval_score: float
    model_score: Optional[float]
    components: dict[str, float]
    reasons: list[str]
    metadata: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "rank": self.rank,
            "vector_id": self.vector_id,
            "sample_id": self.sample_id,
            "image_path": self.image_path,
            "raw_path": self.raw_path,
            "score": self.score,
            "retrieval_score": self.retrieval_score,
            "model_score": self.model_score,
            "components": self.components,
            "reasons": self.reasons,
            "metadata": self.metadata,
        }


def _write_manifest(path: Path, records: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        for record in records:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")


def _read_manifest(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Manifest does not exist: {path}")
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            records.append(json.loads(line))
    return records


def generate_corpus(
    corpus_dir: Path,
    *,
    samples: int = 40,
    variants: int = 3,
    state_count: int = 8,
    state_counts: Optional[Sequence[int]] = None,
    seed: int = 42,
    replace: bool = True,
) -> dict[str, Any]:
    if samples < 1:
        raise ValueError("samples must be positive")
    if variants < 1:
        raise ValueError("variants must be positive")
    requested_state_counts = tuple(
        dict.fromkeys(int(count) for count in (state_counts or (state_count,)))
    )
    if not requested_state_counts or any(count < 2 for count in requested_state_counts):
        raise ValueError("state_counts must contain values of at least 2")

    corpus_dir = corpus_dir.resolve()
    rng = np.random.default_rng(seed)
    raw_dir = corpus_dir / "raw"
    image_dir = corpus_dir / "images"
    svg_dir = corpus_dir / "svg"
    manifest_path = corpus_dir / "manifest.jsonl"
    if replace:
        for generated_dir in (raw_dir, image_dir, svg_dir, corpus_dir / "standardized"):
            if generated_dir.exists():
                shutil.rmtree(generated_dir)
        existing: dict[str, dict[str, Any]] = {}
    else:
        existing = (
            {record["vector_id"]: record for record in _read_manifest(manifest_path)}
            if manifest_path.exists()
            else {}
        )

    created: list[dict[str, Any]] = []
    for requested_state_count in requested_state_counts:
        for sample_index in range(samples):
            sample_id = (
                f"vth-{requested_state_count:02d}s-s{seed:04d}-{sample_index:05d}"
            )
            sample = generate_vth_sample(
                rng,
                sample_id=sample_id,
                state_count=requested_state_count,
            )
            raw_path = raw_dir / f"{sample_id}.npz"
            sample.save(raw_path)

            base_path = image_dir / f"{sample_id}--base.png"
            svg_path = svg_dir / f"{sample_id}.svg"
            render_vth_graph(
                sample,
                base_path,
                svg_path=svg_path,
                rng=rng,
                axes=False,
                colored=False,
                filled=False,
            )
            created.append(
                {
                    "vector_id": f"{sample_id}--base",
                    "sample_id": sample_id,
                    "variant_id": "base",
                    "image_path": str(base_path),
                    "svg_path": str(svg_path),
                    "raw_path": str(raw_path),
                    "metadata": sample.metadata,
                }
            )

            for variant_index in range(variants):
                variant_id = f"variant-{variant_index:02d}"
                variant_path = image_dir / f"{sample_id}--{variant_id}.png"
                render_vth_graph(
                    sample,
                    variant_path,
                    rng=rng,
                    axes=bool(rng.random() < 0.72),
                    colored=bool(rng.random() < 0.7),
                    filled=bool(rng.random() < 0.35),
                    grid=bool(rng.random() < 0.45),
                    dpi=int(rng.integers(90, 165)),
                )
                augment_graph_image(variant_path, variant_path, rng=rng)
                created.append(
                    {
                        "vector_id": f"{sample_id}--{variant_id}",
                        "sample_id": sample_id,
                        "variant_id": variant_id,
                        "image_path": str(variant_path),
                        "svg_path": None,
                        "raw_path": str(raw_path),
                        "metadata": sample.metadata,
                    }
                )

    for record in created:
        existing[record["vector_id"]] = record
    merged = [existing[key] for key in sorted(existing)]
    _write_manifest(manifest_path, merged)
    return {
        "corpus_dir": str(corpus_dir),
        "manifest_path": str(manifest_path),
        "generated_samples": samples * len(requested_state_counts),
        "samples_per_state": samples,
        "state_counts": list(requested_state_counts),
        "images_per_sample": variants + 1,
        "total_manifest_images": len(merged),
        "replace": replace,
    }


def build_vector_index(
    corpus_dir: Path,
    index_path: Path,
    *,
    clear: bool = True,
) -> dict[str, Any]:
    corpus_dir = corpus_dir.resolve()
    records = _read_manifest(corpus_dir / "manifest.jsonl")
    standardized_dir = corpus_dir / "standardized"
    vector_records = []
    raw_curve_cache = {}
    for record in records:
        preview_path = standardized_dir / f"{record['vector_id']}.png"
        image_bundle = extract_features(
            Path(record["image_path"]),
            preview_path=preview_path,
        )
        raw_path = Path(record["raw_path"])
        if record["sample_id"] not in raw_curve_cache:
            raw_sample = SyntheticVthSample.load(raw_path)
            raw_curve_cache[record["sample_id"]] = extract_log_curve_features(raw_sample)
        curve_bundle = raw_curve_cache[record["sample_id"]]
        vector_records.append(
            VectorRecord(
                vector_id=record["vector_id"],
                sample_id=record["sample_id"],
                variant_id=record["variant_id"],
                image_path=record["image_path"],
                raw_path=record["raw_path"],
                image_embedding=image_bundle.image_embedding,
                curve_embedding=curve_bundle.curve_embedding,
                descriptor=curve_bundle.descriptor,
                preprocessing={
                    **image_bundle.preprocessing,
                    "curve_source": "raw-vth-log10",
                },
                metadata=record["metadata"],
            )
        )

    with SQLiteVectorStore(index_path) as store:
        if clear:
            store.clear()
        inserted = store.add_many(vector_records)
        total = store.count()
    return {
        "index_path": str(index_path.resolve()),
        "indexed_now": inserted,
        "total_vectors": total,
        "standardized_dir": str(standardized_dir),
    }


def _unique_samples(scored_records: list, limit: int) -> list:
    selected = []
    seen = set()
    for scored in scored_records:
        if scored.record.sample_id in seen:
            continue
        selected.append(scored)
        seen.add(scored.record.sample_id)
        if len(selected) >= limit:
            break
    return selected


def _candidate_state_count(candidate: Any) -> int:
    metadata_count = candidate.record.metadata.get("state_count")
    if metadata_count is not None:
        return int(metadata_count)
    return int(candidate.record.descriptor.get("peak_count", 0))


def _render_contact_sheet(
    query_path: Path,
    results: list[SearchResult],
    output_path: Path,
) -> None:
    tile_width, tile_height = 360, 210
    columns = 2
    rows = 1 + int(np.ceil(len(results) / columns))
    sheet = Image.new("RGB", (columns * tile_width, rows * tile_height), "white")
    draw = ImageDraw.Draw(sheet)

    query = Image.open(query_path).convert("RGB")
    query_thumb = ImageOps.contain(query, (tile_width - 20, tile_height - 38))
    sheet.paste(query_thumb, (10, 24))
    draw.text((10, 6), "QUERY", fill="black")

    for index, result in enumerate(results):
        row = 1 + index // columns
        column = index % columns
        left = column * tile_width
        top = row * tile_height
        candidate = Image.open(result.image_path).convert("RGB")
        thumbnail = ImageOps.contain(candidate, (tile_width - 20, tile_height - 42))
        sheet.paste(thumbnail, (left + 10, top + 30))
        draw.text(
            (left + 10, top + 7),
            f"#{result.rank}  score={result.score:.3f}  {result.sample_id}",
            fill="black",
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


def search_similar(
    query_path: Path,
    index_path: Path,
    output_dir: Path,
    *,
    top_k: int = 8,
    candidate_pool: int = 80,
    model_path: Optional[Path] = None,
    dual_encoder_path: Optional[Path] = None,
) -> dict[str, Any]:
    if top_k < 1:
        raise ValueError("top_k must be positive")
    output_dir.mkdir(parents=True, exist_ok=True)
    standardized_query = output_dir / "query-standardized.png"
    query = extract_features(query_path, preview_path=standardized_query)
    query_state_count = int(query.descriptor.get("peak_count", 0))
    minimum_state_pool = max(10, top_k)

    with SQLiteVectorStore(index_path) as store:
        total_vectors = max(store.count(), 1)
        candidate_count = min(max(candidate_pool, top_k * 4), total_vectors)
        retrieved = store.search(query, limit=candidate_count)
        unique = _unique_samples(retrieved, max(top_k * 3, top_k))
        state_matched = [
            candidate
            for candidate in unique
            if _candidate_state_count(candidate) == query_state_count
        ]
        retrieval_expanded = False
        state_filtered_vectors = 0
        if len(state_matched) < minimum_state_pool:
            state_filtered_limit = min(
                total_vectors,
                max(candidate_count * 2, top_k * 16, 160),
            )
            state_filtered = store.search(
                query,
                limit=state_filtered_limit,
                state_count=query_state_count,
            )
            state_filtered_vectors = len(state_filtered)
            state_matched = _unique_samples(
                state_filtered,
                max(minimum_state_pool, top_k * 3),
            )
            retrieval_expanded = True
    search_pool = state_matched if len(state_matched) >= minimum_state_pool else unique

    reranker = PairwiseReranker(model_path) if model_path and model_path.exists() else None
    dual_encoder = (
        DualCurveEncoder(dual_encoder_path)
        if dual_encoder_path and dual_encoder_path.exists()
        else None
    )
    scored_candidates = []
    for candidate in search_pool:
        candidate_bundle = candidate.record.feature_bundle()
        components = similarity_components(query, candidate_bundle)
        model_score = reranker.score_components(components) if reranker else None
        if model_score is None:
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
            base_score = (
                0.70 * components["curve_cosine"]
                + 0.25 * model_score
                + 0.05 * candidate.retrieval_score
            )
        # Preserve the trained pairwise model while explicitly rewarding the
        # local relation that distinguishes heavily overlapping states:
        # shallow valley depth and short peak-to-valley travel.
        reranked_score = blend_peak_valley_score(base_score, components)
        final_score = calibrate_retrieval_score(
            reranked_score,
            candidate.retrieval_score,
        )
        scored_candidates.append((final_score, model_score, candidate, components))
    scored_candidates.sort(key=lambda item: item[0], reverse=True)
    if dual_encoder is not None and dual_encoder.blend_weight > 0.0:
        rerank_limit = min(
            dual_encoder.rerank_limit,
            len(scored_candidates),
        )
        reranked_head = []
        for score, model_score, candidate, components in scored_candidates[
            :rerank_limit
        ]:
            candidate_embedding = candidate.record.curve_embedding
            learned_score = max(
                [
                    dual_encoder.similarity(
                        query.curve_embedding,
                        candidate_embedding,
                    ),
                    *(
                    dual_encoder.similarity(
                        alternative,
                        candidate_embedding,
                    )
                    for alternative in query.alternative_curve_embeddings
                ),
                ]
            )
            combined_score = (
                (1.0 - dual_encoder.blend_weight) * score
                + dual_encoder.blend_weight * learned_score
            )
            reranked_head.append(
                (
                    combined_score,
                    model_score,
                    candidate,
                    {
                        **components,
                        "dual_encoder_similarity": learned_score,
                    },
                )
            )
        reranked_head.sort(key=lambda item: item[0], reverse=True)
        scored_candidates = [
            *reranked_head,
            *scored_candidates[rerank_limit:],
        ]

    results = []
    for rank, (score, model_score, candidate, components) in enumerate(
        scored_candidates[:top_k],
        start=1,
    ):
        candidate_bundle = candidate.record.feature_bundle()
        results.append(
            SearchResult(
                rank=rank,
                vector_id=candidate.record.vector_id,
                sample_id=candidate.record.sample_id,
                image_path=candidate.record.image_path,
                raw_path=candidate.record.raw_path,
                score=float(score),
                retrieval_score=candidate.retrieval_score,
                model_score=model_score,
                components=components,
                reasons=explain_similarity(query, candidate_bundle),
                metadata=candidate.record.metadata,
            )
        )

    payload = {
        "query_path": str(query_path.resolve()),
        "standardized_query_path": str(standardized_query.resolve()),
        "index_path": str(index_path.resolve()),
        "model_path": str(model_path.resolve()) if reranker and model_path else None,
        "dual_encoder_path": (
            str(dual_encoder_path.resolve())
            if dual_encoder is not None and dual_encoder_path
            else None
        ),
        "dual_encoder": (
            {
                "embedding_dimensions": dual_encoder.embedding_dimensions,
                "blend_weight": dual_encoder.blend_weight,
                "rerank_limit": dual_encoder.rerank_limit,
                "validation": dual_encoder.validation,
            }
            if dual_encoder is not None
            else None
        ),
        "top_k": top_k,
        "query_descriptor": query.descriptor,
        "candidate_pool": {
            "retrieved_vectors": len(retrieved),
            "unique_samples": len(unique),
            "state_matched_samples": len(state_matched),
            "state_filter_applied": search_pool is state_matched,
            "state_filtered_vectors": state_filtered_vectors,
            "retrieval_expanded": retrieval_expanded,
        },
        "results": [result.as_dict() for result in results],
    }
    results_path = output_dir / "results.json"
    results_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    contact_sheet = output_dir / "recommendations.png"
    _render_contact_sheet(query_path, results, contact_sheet)
    payload["results_path"] = str(results_path.resolve())
    payload["contact_sheet_path"] = str(contact_sheet.resolve())
    return payload
