"""Validation and normalization for anonymized real VTH image manifests."""

from __future__ import annotations

import csv
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

SUPPORTED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
NORMALIZED_FIELDS = (
    "image_path",
    "image_id",
    "state_count",
    "observed_state_count",
    "state_coverage",
    "y_scale",
    "y_min",
    "y_max",
    "similarity_group",
    "product_group",
    "notes",
    "source_id",
    "source_url",
    "figure_id",
    "source_kind",
    "independence_group",
    "is_measured",
)


@dataclass(frozen=True)
class RealImageManifest:
    """Typed, validated rows plus an auditable intake summary."""

    rows: tuple[dict[str, Any], ...]
    summary: dict[str, Any]
    errors: tuple[str, ...]
    warnings: tuple[str, ...]


def _optional_float(
    value: Any,
    *,
    field: str,
    row_number: int,
    errors: list[str],
) -> Optional[float]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = float(text)
    except ValueError:
        errors.append(f"row {row_number}: {field} must be numeric")
        return None
    if not 0 < parsed < float("inf"):
        errors.append(f"row {row_number}: {field} must be finite and positive")
        return None
    return parsed


def _optional_positive_int(
    value: Any,
    *,
    field: str,
    row_number: int,
    errors: list[str],
) -> Optional[int]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = int(text)
    except ValueError:
        errors.append(f"row {row_number}: {field} must be a positive integer")
        return None
    if parsed <= 0:
        errors.append(f"row {row_number}: {field} must be a positive integer")
        return None
    return parsed


def _optional_boolean(
    value: Any,
    *,
    field: str,
    row_number: int,
    errors: list[str],
) -> Optional[bool]:
    text = str(value or "").strip().lower()
    if not text:
        return None
    if text in {"true", "1", "yes", "y", "measured"}:
        return True
    if text in {"false", "0", "no", "n", "illustrative"}:
        return False
    errors.append(
        f"row {row_number}: {field} must be true/false, yes/no, or 1/0"
    )
    return None


def inspect_real_image_manifest(
    manifest_path: Path,
    *,
    check_files: bool = True,
) -> RealImageManifest:
    """Inspect a CSV without discarding its full set of validation findings."""

    manifest_path = manifest_path.resolve()
    if not manifest_path.exists():
        raise FileNotFoundError(f"Real-image manifest does not exist: {manifest_path}")

    errors: list[str] = []
    warnings: list[str] = []
    with manifest_path.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        fieldnames = tuple(reader.fieldnames or ())
        raw_rows = list(reader)

    if "image_path" not in fieldnames:
        errors.append("header: image_path column is required")
    if not raw_rows:
        errors.append("manifest: at least one image row is required")

    rows: list[dict[str, Any]] = []
    seen_image_ids: dict[str, int] = {}
    seen_paths: dict[Path, int] = {}
    for row_index, raw_row in enumerate(raw_rows):
        row_number = row_index + 2
        row_errors_before = len(errors)
        raw_image_path = str(raw_row.get("image_path", "") or "").strip()
        if not raw_image_path:
            errors.append(f"row {row_number}: image_path is required")
            continue
        image_path = Path(raw_image_path)
        if not image_path.is_absolute():
            image_path = manifest_path.parent / image_path
        image_path = image_path.resolve()
        if image_path.suffix.lower() not in SUPPORTED_IMAGE_SUFFIXES:
            errors.append(
                f"row {row_number}: image_path must be PNG, JPEG, or WEBP"
            )
        if check_files and (not image_path.exists() or not image_path.is_file()):
            errors.append(f"row {row_number}: image file does not exist: {image_path}")

        image_id = str(raw_row.get("image_id", "") or "").strip()
        if not image_id:
            image_id = f"image-{row_index + 1:04d}"
        if image_id in seen_image_ids:
            errors.append(
                f"row {row_number}: image_id {image_id!r} duplicates "
                f"row {seen_image_ids[image_id]}"
            )
        else:
            seen_image_ids[image_id] = row_number
        if image_path in seen_paths:
            errors.append(
                f"row {row_number}: image_path duplicates row {seen_paths[image_path]}"
            )
        else:
            seen_paths[image_path] = row_number

        state_count = _optional_positive_int(
            raw_row.get("state_count"),
            field="state_count",
            row_number=row_number,
            errors=errors,
        )
        observed_state_count = _optional_positive_int(
            raw_row.get("observed_state_count"),
            field="observed_state_count",
            row_number=row_number,
            errors=errors,
        )
        state_coverage = str(
            raw_row.get("state_coverage", "") or ""
        ).strip().lower()
        if state_coverage and state_coverage not in {"full", "partial", "unknown"}:
            errors.append(
                f"row {row_number}: state_coverage must be full, partial, or unknown"
            )
        if not state_coverage:
            if state_count is not None and observed_state_count is not None:
                state_coverage = (
                    "full" if state_count == observed_state_count else "partial"
                )
            elif state_count is not None:
                observed_state_count = state_count
                state_coverage = "full"
            else:
                state_coverage = "unknown"
        if (
            state_count is not None
            and observed_state_count is not None
            and observed_state_count > state_count
        ):
            errors.append(
                f"row {row_number}: observed_state_count cannot exceed state_count"
            )
        if (
            state_coverage == "full"
            and state_count is not None
            and observed_state_count is not None
            and observed_state_count != state_count
        ):
            errors.append(
                f"row {row_number}: full state coverage requires "
                "observed_state_count to equal state_count"
            )
        y_scale = str(raw_row.get("y_scale", "log10") or "log10").strip().lower()
        if y_scale not in {"log", "log10"}:
            errors.append(
                f"row {row_number}: y_scale must be log or log10, got {y_scale!r}"
            )
        y_scale = "log10"
        y_min = _optional_float(
            raw_row.get("y_min"),
            field="y_min",
            row_number=row_number,
            errors=errors,
        )
        y_max = _optional_float(
            raw_row.get("y_max"),
            field="y_max",
            row_number=row_number,
            errors=errors,
        )
        if (y_min is None) != (y_max is None):
            errors.append(
                f"row {row_number}: y_min and y_max must be supplied together"
            )
        elif y_min is not None and y_max is not None and y_min >= y_max:
            errors.append(f"row {row_number}: y_min must be smaller than y_max")

        is_measured = _optional_boolean(
            raw_row.get("is_measured"),
            field="is_measured",
            row_number=row_number,
            errors=errors,
        )
        row = {
            "image_path": image_path,
            "image_path_input": raw_image_path,
            "image_id": image_id,
            "state_count": state_count,
            "observed_state_count": observed_state_count,
            "state_coverage": state_coverage,
            "y_scale": y_scale,
            "y_min": y_min,
            "y_max": y_max,
            "similarity_group": str(
                raw_row.get("similarity_group", "") or ""
            ).strip(),
            "product_group": str(raw_row.get("product_group", "") or "").strip(),
            "notes": str(raw_row.get("notes", "") or "").strip(),
            "source_id": str(raw_row.get("source_id", "") or "").strip(),
            "source_url": str(raw_row.get("source_url", "") or "").strip(),
            "figure_id": str(raw_row.get("figure_id", "") or "").strip(),
            "source_kind": str(raw_row.get("source_kind", "") or "").strip(),
            "independence_group": str(
                raw_row.get("independence_group", "") or ""
            ).strip(),
            "is_measured": is_measured,
            "row_number": row_number,
        }
        if len(errors) == row_errors_before:
            rows.append(row)

    group_counts = Counter(
        row["similarity_group"] for row in rows if row["similarity_group"]
    )
    evaluable_groups = {
        group: count for group, count in group_counts.items() if count >= 2
    }
    relevance_queries = sum(evaluable_groups.values())
    directed_positive_pairs = sum(count * (count - 1) for count in evaluable_groups.values())
    source_ids = {row["source_id"] for row in rows if row["source_id"]}
    independence_groups = {
        row["independence_group"] for row in rows if row["independence_group"]
    }
    missing_state_count = sum(row["state_count"] is None for row in rows)
    missing_observed_state_count = sum(
        row["observed_state_count"] is None for row in rows
    )
    partial_state_coverage = sum(
        row["state_coverage"] == "partial" for row in rows
    )
    missing_log_range = sum(
        row["y_min"] is None or row["y_max"] is None for row in rows
    )
    missing_similarity_group = sum(not row["similarity_group"] for row in rows)
    missing_independence_group = sum(not row["independence_group"] for row in rows)
    measured_images = sum(row["is_measured"] is True for row in rows)

    if rows and missing_state_count:
        warnings.append(f"{missing_state_count} image(s) have no state_count label")
    if rows and missing_observed_state_count:
        warnings.append(
            f"{missing_observed_state_count} image(s) have no observed_state_count label"
        )
    if rows and missing_log_range:
        warnings.append(f"{missing_log_range} image(s) have no y_min/y_max log range")
    if rows and missing_similarity_group:
        warnings.append(
            f"{missing_similarity_group} image(s) have no similarity_group label"
        )
    if rows and missing_independence_group:
        warnings.append(
            f"{missing_independence_group} image(s) have no independence_group"
        )
    singleton_groups = sum(count == 1 for count in group_counts.values())
    if singleton_groups:
        warnings.append(
            f"{singleton_groups} similarity_group(s) contain only one image"
        )

    manifest_valid = not errors and len(rows) == len(raw_rows)
    summary = {
        "schema_version": 2,
        "manifest_path": str(manifest_path),
        "manifest_images": len(raw_rows),
        "valid_images": len(rows),
        "error_count": len(errors),
        "warning_count": len(warnings),
        "state_labelled_images": len(rows) - missing_state_count,
        "observed_state_labelled_images": len(rows) - missing_observed_state_count,
        "partial_state_coverage_images": partial_state_coverage,
        "log_range_labelled_images": len(rows) - missing_log_range,
        "similarity_group_count": len(group_counts),
        "evaluable_similarity_group_count": len(evaluable_groups),
        "relevance_queries": relevance_queries,
        "directed_positive_pairs": directed_positive_pairs,
        "product_group_count": len(
            {row["product_group"] for row in rows if row["product_group"]}
        ),
        "source_count": len(source_ids),
        "independence_group_count": len(independence_groups),
        "measured_images": measured_images,
        "quality_gates": {
            "manifest_valid": manifest_valid,
            "preprocessing_audit_minimum_3": manifest_valid and len(rows) >= 3,
            "first_validation_minimum_10": manifest_valid and len(rows) >= 10,
            "state_labels_complete": manifest_valid and missing_state_count == 0,
            "observed_state_labels_complete": (
                manifest_valid and missing_observed_state_count == 0
            ),
            "log_ranges_complete": manifest_valid and missing_log_range == 0,
            "relevance_groups_minimum_3": (
                manifest_valid and len(evaluable_groups) >= 3
            ),
            "independence_groups_minimum_3": (
                manifest_valid and len(independence_groups) >= 3
            ),
            "measured_images_present": manifest_valid and measured_images > 0,
        },
    }
    summary["ready_for_relevance_evaluation"] = bool(
        summary["quality_gates"]["preprocessing_audit_minimum_3"]
        and summary["quality_gates"]["relevance_groups_minimum_3"]
    )
    summary["ready_for_domain_calibration"] = bool(
        summary["quality_gates"]["first_validation_minimum_10"]
        and summary["quality_gates"]["state_labels_complete"]
        and summary["quality_gates"]["log_ranges_complete"]
        and summary["quality_gates"]["relevance_groups_minimum_3"]
        and summary["quality_gates"]["independence_groups_minimum_3"]
        and summary["quality_gates"]["measured_images_present"]
    )
    return RealImageManifest(
        rows=tuple(rows),
        summary=summary,
        errors=tuple(errors),
        warnings=tuple(warnings),
    )


def require_valid_real_image_manifest(manifest_path: Path) -> RealImageManifest:
    """Return typed rows or fail with all intake errors in one message."""

    manifest = inspect_real_image_manifest(manifest_path)
    if manifest.errors:
        details = "\n".join(f"- {error}" for error in manifest.errors)
        raise ValueError(f"Real-image manifest validation failed:\n{details}")
    return manifest


def validate_real_image_manifest(
    manifest_path: Path,
    output_dir: Path,
) -> dict[str, Any]:
    """Write an intake report and a portable, normalized CSV for valid rows."""

    manifest = inspect_real_image_manifest(manifest_path)
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    normalized_path = output_dir / "real-image-manifest.normalized.csv"
    with normalized_path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=NORMALIZED_FIELDS)
        writer.writeheader()
        for row in manifest.rows:
            writer.writerow(
                {
                    "image_path": str(row["image_path"]),
                    "image_id": row["image_id"],
                    "state_count": row["state_count"] or "",
                    "observed_state_count": row["observed_state_count"] or "",
                    "state_coverage": row["state_coverage"],
                    "y_scale": row["y_scale"],
                    "y_min": row["y_min"] if row["y_min"] is not None else "",
                    "y_max": row["y_max"] if row["y_max"] is not None else "",
                    "similarity_group": row["similarity_group"],
                    "product_group": row["product_group"],
                    "notes": row["notes"],
                    "source_id": row["source_id"],
                    "source_url": row["source_url"],
                    "figure_id": row["figure_id"],
                    "source_kind": row["source_kind"],
                    "independence_group": row["independence_group"],
                    "is_measured": (
                        str(row["is_measured"]).lower()
                        if row["is_measured"] is not None
                        else ""
                    ),
                }
            )

    report_path = output_dir / "real-image-manifest-validation.json"
    report_payload = {
        "summary": manifest.summary,
        "errors": list(manifest.errors),
        "warnings": list(manifest.warnings),
        "normalized_manifest_path": str(normalized_path),
    }
    report_path.write_text(
        json.dumps(report_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "report_path": str(report_path),
        "normalized_manifest_path": str(normalized_path),
        **manifest.summary,
        "errors": list(manifest.errors),
        "warnings": list(manifest.warnings),
    }
