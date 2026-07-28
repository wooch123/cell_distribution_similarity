"""Validation and aggregation for browser-exported expert relevance reports."""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

PAIR_FEATURE_NAMES = (
    "image_cosine",
    "curve_cosine",
    "peak_count_similarity",
    "peak_location_similarity",
    "peak_width_similarity",
    "area_similarity",
    "valley_similarity",
    "tail_slope_similarity",
)

_REPORT_FIELDS = {
    "image_cosine": "image_score",
    "curve_cosine": "curve_score",
    "peak_count_similarity": "peak_count_score",
    "peak_location_similarity": "location_score",
    "peak_width_similarity": "width_score",
    "area_similarity": "area_score",
    "valley_similarity": "valley_score",
    "tail_slope_similarity": "tail_score",
}


@dataclass(frozen=True)
class FeedbackDataset:
    """Consensus pair labels and their auditable anonymous source ratings."""

    features: np.ndarray
    labels: np.ndarray
    query_groups: np.ndarray
    records: tuple[dict[str, Any], ...]
    ratings: tuple[dict[str, Any], ...]
    summary: dict[str, Any]


def _require_mapping(value: Any, field: str, report_path: Path) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"{report_path}: {field} must be an object")
    return value


def _require_string(value: Any, field: str, report_path: Path) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{report_path}: {field} must be a non-empty string")
    return value.strip()


def _unit_score(value: Any, field: str, report_path: Path) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{report_path}: {field} must be numeric")
    score = float(value)
    if not np.isfinite(score) or score < 0.0 or score > 1.0:
        raise ValueError(f"{report_path}: {field} must be between 0 and 1")
    return score


def _validate_profile(query: dict[str, Any], report_path: Path) -> list[float]:
    profile = query.get("profile")
    if not isinstance(profile, list) or len(profile) != 256:
        raise ValueError(f"{report_path}: query.profile must contain 256 points")
    values = []
    for index, value in enumerate(profile):
        values.append(_unit_score(value, f"query.profile[{index}]", report_path))
    return values


def _validate_privacy(payload: dict[str, Any], report_path: Path) -> None:
    privacy = _require_mapping(payload.get("privacy"), "privacy", report_path)
    for field in (
        "query_image_included",
        "original_filename_included",
        "external_upload_performed",
    ):
        if privacy.get(field) is not False:
            raise ValueError(f"{report_path}: privacy.{field} must be false")
    if privacy.get("normalized_shape_features_included") is not True:
        raise ValueError(
            f"{report_path}: privacy.normalized_shape_features_included must be true"
        )


def load_feedback_dataset(report_paths: Sequence[Path]) -> FeedbackDataset:
    """Load browser reports and form one majority label per query/candidate pair.

    Schema v3 preserves ratings from independent anonymous annotators. Repeated
    ratings by the same annotator use the latest report, while cross-annotator
    ties are excluded from training instead of being resolved arbitrarily.
    Schema v2 remains readable and follows its historical latest-report rule.
    """

    if not report_paths:
        raise ValueError("At least one feedback report is required")

    deduplicated_ratings: dict[tuple[str, str, str], dict[str, Any]] = {}
    report_count = 0
    raw_judgment_count = 0
    duplicate_count = 0
    conflicting_duplicate_count = 0
    report_schema_versions: set[int] = set()
    for report_order, raw_path in enumerate(report_paths):
        report_path = Path(raw_path).resolve()
        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"Unable to read feedback report {report_path}: {error}") from error
        payload = _require_mapping(payload, "report", report_path)
        schema_version = payload.get("schema_version")
        if schema_version not in {2, 3}:
            raise ValueError(
                f"{report_path}: schema_version 2 or 3 is required for reranker training"
            )
        report_schema_versions.add(schema_version)
        if payload.get("report_type") != "vth-expert-relevance":
            raise ValueError(f"{report_path}: unsupported report_type")
        _validate_privacy(payload, report_path)

        query = _require_mapping(payload.get("query"), "query", report_path)
        query_id = _require_string(query.get("id"), "query.id", report_path)
        profile = _validate_profile(query, report_path)
        detected_state_count = query.get("detected_state_count")
        if (
            isinstance(detected_state_count, bool)
            or not isinstance(detected_state_count, int)
            or detected_state_count <= 0
        ):
            raise ValueError(f"{report_path}: query.detected_state_count must be positive")

        if schema_version == 3:
            annotator = _require_mapping(
                payload.get("annotator"),
                "annotator",
                report_path,
            )
            annotator_id = _require_string(
                annotator.get("id"),
                "annotator.id",
                report_path,
            )
            if annotator.get("anonymous") is not True:
                raise ValueError(f"{report_path}: annotator.anonymous must be true")
        else:
            annotator_id = "legacy"

        created_at = _require_string(
            payload.get("created_at"),
            "created_at",
            report_path,
        )
        judgments = payload.get("judgments")
        if not isinstance(judgments, list) or not judgments:
            raise ValueError(f"{report_path}: judgments must be a non-empty array")
        seen_in_report: set[str] = set()
        for judgment_index, raw_judgment in enumerate(judgments):
            judgment = _require_mapping(
                raw_judgment,
                f"judgments[{judgment_index}]",
                report_path,
            )
            candidate_id = _require_string(
                judgment.get("candidate_id"),
                f"judgments[{judgment_index}].candidate_id",
                report_path,
            )
            if candidate_id in seen_in_report:
                raise ValueError(
                    f"{report_path}: candidate {candidate_id} is duplicated in one report"
                )
            seen_in_report.add(candidate_id)
            relevance = judgment.get("relevance")
            if relevance not in {"similar", "dissimilar"}:
                raise ValueError(
                    f"{report_path}: judgments[{judgment_index}].relevance is invalid"
                )
            features = {
                feature_name: _unit_score(
                    judgment.get(report_field),
                    f"judgments[{judgment_index}].{report_field}",
                    report_path,
                )
                for feature_name, report_field in _REPORT_FIELDS.items()
            }
            rank = judgment.get("rank")
            if isinstance(rank, bool) or not isinstance(rank, int) or rank <= 0:
                raise ValueError(
                    f"{report_path}: judgments[{judgment_index}].rank must be positive"
                )

            raw_judgment_count += 1
            key = (query_id, candidate_id, annotator_id)
            previous = deduplicated_ratings.get(key)
            if previous is not None:
                duplicate_count += 1
                if previous["relevance"] != relevance:
                    conflicting_duplicate_count += 1
            record = {
                "query_id": query_id,
                "candidate_id": candidate_id,
                "annotator_id": annotator_id,
                "relevance": relevance,
                "label": int(relevance == "similar"),
                "rank": rank,
                "detected_state_count": detected_state_count,
                "query_profile": profile,
                "features": features,
                "created_at": created_at,
                "source_report": report_path.name,
                "schema_version": schema_version,
                "_order": (created_at, report_order),
            }
            if previous is None or record["_order"] >= previous["_order"]:
                deduplicated_ratings[key] = record
        report_count += 1

    ratings = sorted(
        deduplicated_ratings.values(),
        key=lambda item: (
            item["query_id"],
            item["candidate_id"],
            item["annotator_id"],
        ),
    )
    if not ratings:
        raise ValueError("No valid expert judgments were found")

    grouped_ratings: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for rating in ratings:
        grouped_ratings.setdefault(
            (rating["query_id"], rating["candidate_id"]),
            [],
        ).append(rating)

    records: list[dict[str, Any]] = []
    excluded_tie_pair_count = 0
    multi_annotator_pair_count = 0
    unanimous_pair_count = 0
    majority_pair_count = 0
    cross_annotator_conflict_pair_count = 0
    pairwise_comparisons = 0
    pairwise_agreements = 0
    for (query_id, candidate_id), pair_ratings in grouped_ratings.items():
        positive_votes = sum(rating["label"] == 1 for rating in pair_ratings)
        negative_votes = len(pair_ratings) - positive_votes
        annotator_count = len(pair_ratings)
        if annotator_count >= 2:
            multi_annotator_pair_count += 1
            comparisons = annotator_count * (annotator_count - 1) // 2
            agreements = (
                positive_votes * (positive_votes - 1) // 2
                + negative_votes * (negative_votes - 1) // 2
            )
            pairwise_comparisons += comparisons
            pairwise_agreements += agreements
            if positive_votes and negative_votes:
                cross_annotator_conflict_pair_count += 1
            if positive_votes == annotator_count or negative_votes == annotator_count:
                unanimous_pair_count += 1
            elif positive_votes != negative_votes:
                majority_pair_count += 1
        if positive_votes == negative_votes:
            excluded_tie_pair_count += 1
            continue

        latest = max(pair_ratings, key=lambda item: item["_order"])
        label = int(positive_votes > negative_votes)
        features = {
            feature_name: float(
                np.mean(
                    [
                        rating["features"][feature_name]
                        for rating in pair_ratings
                    ]
                )
            )
            for feature_name in PAIR_FEATURE_NAMES
        }
        records.append(
            {
                "query_id": query_id,
                "candidate_id": candidate_id,
                "relevance": "similar" if label else "dissimilar",
                "label": label,
                "rank": latest["rank"],
                "detected_state_count": latest["detected_state_count"],
                "query_profile": latest["query_profile"],
                "features": features,
                "created_at": max(
                    rating["created_at"] for rating in pair_ratings
                ),
                "source_reports": sorted(
                    {rating["source_report"] for rating in pair_ratings}
                ),
                "annotator_count": annotator_count,
                "annotator_ids": sorted(
                    rating["annotator_id"] for rating in pair_ratings
                ),
                "votes": {
                    "similar": positive_votes,
                    "dissimilar": negative_votes,
                },
                "agreement": max(positive_votes, negative_votes) / annotator_count,
                "schema_versions": sorted(
                    {rating["schema_version"] for rating in pair_ratings}
                ),
            }
        )

    records.sort(
        key=lambda item: (item["query_id"], item["rank"], item["candidate_id"])
    )
    for rating in ratings:
        rating.pop("_order", None)
    if not records:
        raise ValueError(
            "No consensus expert judgments remain after excluding tied pairs"
        )

    features = np.asarray(
        [
            [record["features"][feature_name] for feature_name in PAIR_FEATURE_NAMES]
            for record in records
        ],
        dtype=np.float64,
    )
    labels = np.asarray([record["label"] for record in records], dtype=np.float64)
    query_groups = np.asarray([record["query_id"] for record in records], dtype=str)
    label_counts = Counter(record["relevance"] for record in records)
    state_counts = Counter(str(record["detected_state_count"]) for record in records)
    summary = {
        "schema_version": 3,
        "accepted_report_schema_versions": sorted(report_schema_versions),
        "report_count": report_count,
        "raw_judgment_count": raw_judgment_count,
        "deduplicated_rating_count": len(ratings),
        "deduplicated_judgment_count": len(records),
        "consensus_pair_count": len(records),
        "duplicate_count": duplicate_count,
        "conflicting_duplicate_count": conflicting_duplicate_count,
        "same_annotator_duplicate_count": duplicate_count,
        "same_annotator_conflict_count": conflicting_duplicate_count,
        "annotator_count": len(
            {rating["annotator_id"] for rating in ratings}
        ),
        "multi_annotator_pair_count": multi_annotator_pair_count,
        "unanimous_pair_count": unanimous_pair_count,
        "majority_pair_count": majority_pair_count,
        "cross_annotator_conflict_pair_count": (
            cross_annotator_conflict_pair_count
        ),
        "excluded_tie_pair_count": excluded_tie_pair_count,
        "inter_annotator_agreement": (
            pairwise_agreements / pairwise_comparisons
            if pairwise_comparisons
            else None
        ),
        "query_group_count": len(set(query_groups.tolist())),
        "label_counts": {
            "similar": int(label_counts["similar"]),
            "dissimilar": int(label_counts["dissimilar"]),
        },
        "state_counts": dict(sorted(state_counts.items())),
        "feature_names": list(PAIR_FEATURE_NAMES),
    }
    return FeedbackDataset(
        features=features,
        labels=labels,
        query_groups=query_groups,
        records=tuple(records),
        ratings=tuple(ratings),
        summary=summary,
    )


def ingest_feedback_reports(
    report_paths: Sequence[Path],
    output_dir: Path,
) -> dict[str, Any]:
    """Validate reports and write rating-level plus consensus pair datasets."""

    output_dir.mkdir(parents=True, exist_ok=True)
    expanded_report_paths: list[Path] = []
    imported_dir = output_dir / "imported-shared-reports"
    for raw_path in report_paths:
        report_path = Path(raw_path).resolve()
        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(
                f"Unable to read feedback input {report_path}: {error}"
            ) from error
        if not (
            isinstance(payload, dict)
            and payload.get("exportType") == "vth-shared-relevance-reports"
        ):
            expanded_report_paths.append(report_path)
            continue
        privacy = payload.get("privacy")
        if not isinstance(privacy, dict) or any(
            privacy.get(field) is not expected
            for field, expected in (
                ("rawImagesIncluded", False),
                ("originalFilenamesIncluded", False),
                ("queryCodesHashed", True),
                ("annotatorCodesHashed", True),
            )
        ):
            raise ValueError(
                f"{report_path}: shared export privacy metadata is invalid"
            )
        reports = payload.get("reports")
        if not isinstance(reports, list) or not reports:
            raise ValueError(f"{report_path}: shared export reports are empty")
        imported_dir.mkdir(parents=True, exist_ok=True)
        for index, report in enumerate(reports):
            if not isinstance(report, dict):
                raise TypeError(
                    f"{report_path}: reports[{index}] must be an object"
                )
            imported_path = imported_dir / (
                f"{report_path.stem}-{index:05d}.json"
            )
            imported_path.write_text(
                json.dumps(report, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            expanded_report_paths.append(imported_path)

    dataset = load_feedback_dataset(expanded_report_paths)
    ratings_path = output_dir / "expert-feedback-ratings.jsonl"
    ratings_path.write_text(
        "".join(
            json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
            for record in dataset.ratings
        ),
        encoding="utf-8",
    )
    dataset_path = output_dir / "expert-feedback-pairs.jsonl"
    dataset_path.write_text(
        "".join(
            json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
            for record in dataset.records
        ),
        encoding="utf-8",
    )
    summary_path = output_dir / "expert-feedback-summary.json"
    summary_path.write_text(
        json.dumps(dataset.summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "dataset_path": str(dataset_path.resolve()),
        "ratings_path": str(ratings_path.resolve()),
        "summary_path": str(summary_path.resolve()),
        "expanded_report_count": len(expanded_report_paths),
        "imported_shared_report_count": sum(
            path.parent == imported_dir for path in expanded_report_paths
        ),
        **dataset.summary,
    }
