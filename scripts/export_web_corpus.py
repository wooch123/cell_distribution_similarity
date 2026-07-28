"""Export the local log-scale VTH corpus for the browser search app."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any, Optional

import joblib
import numpy as np

from vnand_similarity.dual_encoder import DualCurveEncoder
from vnand_similarity.features import extract_log_curve_features
from vnand_similarity.synthetic import SyntheticVthSample


def _resample(values: np.ndarray, size: int = 256) -> list[float]:
    positions = np.linspace(0, len(values) - 1, size)
    resampled = np.interp(positions, np.arange(len(values)), values)
    return [round(float(value), 6) for value in resampled]


def _unit(values: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(values))
    return values / max(norm, 1e-12)


def _shape_embedding(profile: list[float]) -> np.ndarray:
    values = np.asarray(profile, dtype=np.float64)
    centered = _unit(values - float(values.mean()))
    first = _unit(np.gradient(values))
    second = _unit(np.gradient(np.gradient(values)))
    return _unit(np.concatenate([0.72 * centered, 0.20 * first, 0.08 * second]))


def _cosine_matrix(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    similarities = np.sum(left[:, np.newaxis, :] * right[np.newaxis, :, :], axis=2)
    return np.clip(similarities, -1.0, 1.0)


def _nearest_coverage(
    embeddings: np.ndarray,
    selected_indices: list[int],
) -> dict[str, float]:
    if not len(embeddings) or not selected_indices:
        return {"mean": 0.0, "minimum": 0.0}
    similarities = _cosine_matrix(embeddings, embeddings[selected_indices])
    nearest = np.max(similarities, axis=1)
    return {
        "mean": round(float(np.mean(nearest)), 6),
        "minimum": round(float(np.min(nearest)), 6),
    }


def _select_diverse_candidates(
    candidates: list[dict[str, Any]],
    *,
    max_per_state: Optional[int],
    baseline_seed: Optional[int],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if max_per_state is None:
        return candidates, {
            "method": "all-unique-shapes",
            "sourceCandidateCount": len(candidates),
            "selectedCandidateCount": len(candidates),
        }
    if max_per_state < 10:
        raise ValueError("max_per_state must be at least 10")

    selected_candidates: list[dict[str, Any]] = []
    state_selection: dict[str, Any] = {}
    seed_token = f"-s{baseline_seed:04d}-" if baseline_seed is not None else None
    for state_count in sorted({int(item["stateCount"]) for item in candidates}):
        state_candidates = sorted(
            (item for item in candidates if int(item["stateCount"]) == state_count),
            key=lambda item: str(item["id"]),
        )
        embeddings = np.stack(
            [_shape_embedding(item["profile"]) for item in state_candidates]
        )
        baseline_indices = [
            index
            for index, item in enumerate(state_candidates)
            if seed_token is not None and seed_token in str(item["id"])
        ][:max_per_state]
        selected_indices = list(baseline_indices)
        if not selected_indices:
            centroid = _unit(np.mean(embeddings, axis=0))
            selected_indices.append(
                min(
                    range(len(state_candidates)),
                    key=lambda index: (
                        float(embeddings[index] @ centroid),
                        str(state_candidates[index]["id"]),
                    ),
                )
            )

        while len(selected_indices) < min(max_per_state, len(state_candidates)):
            similarities = _cosine_matrix(embeddings, embeddings[selected_indices])
            nearest = np.max(similarities, axis=1)
            remaining = [
                index
                for index in range(len(state_candidates))
                if index not in selected_indices
            ]
            selected_indices.append(
                min(
                    remaining,
                    key=lambda index: (
                        float(nearest[index]),
                        str(state_candidates[index]["id"]),
                    ),
                )
            )

        selected_indices.sort()
        selected_candidates.extend(state_candidates[index] for index in selected_indices)
        state_selection[str(state_count)] = {
            "source": len(state_candidates),
            "selected": len(selected_indices),
            "baselinePreserved": len(baseline_indices),
            "baselineCoverage": _nearest_coverage(embeddings, baseline_indices),
            "selectedCoverage": _nearest_coverage(embeddings, selected_indices),
            "families": dict(
                sorted(
                    {
                        family: sum(
                            str(state_candidates[index]["family"]) == family
                            for index in selected_indices
                        )
                        for family in {
                            str(state_candidates[index]["family"])
                            for index in selected_indices
                        }
                    }.items()
                )
            ),
        }

    selected_candidates.sort(key=lambda item: str(item["id"]))
    return selected_candidates, {
        "method": "baseline-preserving-farthest-shape-v1",
        "sourceCandidateCount": len(candidates),
        "selectedCandidateCount": len(selected_candidates),
        "maxPerState": max_per_state,
        "baselineSeed": baseline_seed,
        "byState": state_selection,
    }


def export_corpus(
    root: Path,
    *,
    corpus_dir: Optional[Path] = None,
    model_path: Optional[Path] = None,
    dual_encoder_path: Optional[Path] = None,
    max_per_state: Optional[int] = None,
    baseline_seed: Optional[int] = None,
) -> None:
    corpus_dir = (corpus_dir or root / "data" / "processed" / "corpus").resolve()
    web_public = (root / "web" / "public").resolve()
    output_images = web_public / "corpus"
    output_images.mkdir(parents=True, exist_ok=True)

    candidates = []
    for raw_path in sorted((corpus_dir / "raw").glob("*.npz")):
        sample = SyntheticVthSample.load(raw_path)
        bundle = extract_log_curve_features(sample)
        y_floor = float(sample.metadata["y_floor"])
        composite = np.clip(
            np.asarray(sample.composite_curve, dtype=np.float64),
            y_floor,
            None,
        )
        log_floor = float(np.log10(y_floor))
        log_peak = float(np.log10(max(float(composite.max()), y_floor * 10)))
        profile = (np.log10(composite) - log_floor) / max(log_peak - log_floor, 1e-9)
        profile = np.clip(profile, 0.0, 1.0)

        image_name = f"{sample.sample_id}--base.png"
        source_image = corpus_dir / "images" / image_name

        candidates.append(
            {
                "id": sample.sample_id,
                "label": f"VTH {sample.sample_id.rsplit('-', 1)[-1]}",
                "image": f"/corpus/{image_name}",
                "profile": _resample(profile),
                "stateCount": int(sample.metadata["state_count"]),
                "family": str(sample.metadata["family"]),
                "peakLocations": bundle.descriptor["peak_locations"],
                "peakWidths": bundle.descriptor["peak_widths"],
                "valleyHeights": bundle.descriptor["valley_heights"],
                "valleyLocations": bundle.descriptor["valley_locations"],
                "valleyDepths": bundle.descriptor["valley_depths"],
                "valleyPositionRatios": bundle.descriptor[
                    "valley_position_ratios"
                ],
                "peakValleyDistances": bundle.descriptor[
                    "peak_valley_distances"
                ],
                "tailSlopes": bundle.descriptor["tail_slopes"],
                "area": bundle.descriptor["area"],
                "_sourceImage": str(source_image),
            }
        )

    candidates, selection = _select_diverse_candidates(
        candidates,
        max_per_state=max_per_state,
        baseline_seed=baseline_seed,
    )
    for stale_image in output_images.glob("*.png"):
        stale_image.unlink()
    for candidate in candidates:
        source_image = Path(str(candidate.pop("_sourceImage")))
        shutil.copy2(source_image, output_images / source_image.name)

    state_counts = sorted({int(candidate["stateCount"]) for candidate in candidates})
    payload = {
        "version": 5,
        "yScale": "log10",
        "yFloor": 1e-6,
        "yCeiling": 1.0,
        "candidateCount": len(candidates),
        "stateCounts": state_counts,
        "selection": selection,
        "imageEncoder": {
            "version": 1,
            "kind": "canonical-curve-raster-hog",
            "dimensions": 3200,
            "raster": {
                "width": 64,
                "height": 32,
                "dimensions": 2048,
            },
            "hog": {
                "rows": 8,
                "columns": 16,
                "bins": 9,
                "dimensions": 1152,
                "weight": 0.25,
            },
            "rerank": {
                "limit": 2,
                "blendWeight": 0.08,
                "candidateShapeFloor": 0.8,
                "imageMargin": 0.02,
                "profileMargin": 0.002,
                "requiresProfileConsensus": True,
                "exactCurveGuard": 0.995,
            },
            "validation": {
                "artifactVariants": 32,
                "minimumTop10ShapeCoverage": 0.918,
                "minimumTopCandidateShapeSimilarity": 0.935085,
                "faultQueries": 700,
                "faultExactShapeTop10": 645,
                "externalFixtures": 36,
            },
        },
        "candidates": candidates,
    }
    model_path = (model_path or root / "artifacts" / "pairwise-reranker.joblib").resolve()
    if model_path.exists():
        model = joblib.load(model_path)
        payload["reranker"] = {
            "version": int(model["version"]),
            "featureNames": list(model["feature_names"]),
            "weights": [round(float(value), 8) for value in model["weights"]],
            "intercept": round(float(model["intercept"]), 8),
            "finalBlend": {
                "curve": 0.70,
                "model": 0.25,
                "retrieval": 0.05,
            },
            "scoreCalibration": {
                "reranked": 0.70,
                "retrieval": 0.30,
            },
        }
    dual_encoder_path = (
        dual_encoder_path or root / "artifacts" / "dual-curve-encoder.joblib"
    ).resolve()
    if dual_encoder_path.exists():
        dual_encoder = DualCurveEncoder(dual_encoder_path)
        if (
            dual_encoder.validation.get("fullyPromoted") is True
            and dual_encoder.validation.get("external", {}).get("passed")
            is True
        ):
            payload["dualEncoder"] = dual_encoder.export_browser_payload()
    (web_public / "corpus-index.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    demo_source = root / "artifacts" / "search" / "demo-external-query.png"
    shutil.copy2(demo_source, web_public / "demo-query.png")
    print(f"Exported {len(candidates)} candidates to {web_public}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Export a diverse log-scale VTH corpus for the browser app"
    )
    parser.add_argument("--corpus", type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--dual-encoder", type=Path)
    parser.add_argument("--max-per-state", type=int)
    parser.add_argument("--baseline-seed", type=int)
    arguments = parser.parse_args()
    export_corpus(
        Path(__file__).resolve().parents[1],
        corpus_dir=arguments.corpus,
        model_path=arguments.model,
        dual_encoder_path=arguments.dual_encoder,
        max_per_state=arguments.max_per_state,
        baseline_seed=arguments.baseline_seed,
    )
