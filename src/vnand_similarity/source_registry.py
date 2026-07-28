"""Audit public VTH source candidates before using them for calibration."""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SOURCE_STATUSES = {"calibration", "stress-only", "excluded"}
REQUIRED_FIELDS = (
    "source_id",
    "title",
    "source_url",
    "year",
    "source_kind",
    "is_measured",
    "native_log_y",
    "multi_state_vth",
    "public_fulltext",
    "independence_group",
    "duplicate_of",
    "status",
    "disposition_reason",
    "evidence",
)


@dataclass(frozen=True)
class SourceRegistry:
    """Typed source rows plus an auditable calibration-gate summary."""

    rows: tuple[dict[str, Any], ...]
    summary: dict[str, Any]
    errors: tuple[str, ...]
    warnings: tuple[str, ...]


def _boolean(
    value: Any,
    *,
    field: str,
    row_number: int,
    errors: list[str],
) -> bool:
    text = str(value or "").strip().lower()
    if text in {"true", "1", "yes", "y"}:
        return True
    if text in {"false", "0", "no", "n"}:
        return False
    errors.append(f"row {row_number}: {field} must be true/false, yes/no, or 1/0")
    return False


def _year(
    value: Any,
    *,
    row_number: int,
    errors: list[str],
) -> int:
    text = str(value or "").strip()
    try:
        parsed = int(text)
    except ValueError:
        errors.append(f"row {row_number}: year must be a four-digit integer")
        return 0
    if parsed < 1900 or parsed > 2100:
        errors.append(f"row {row_number}: year must be between 1900 and 2100")
    return parsed


def inspect_source_registry(registry_path: Path) -> SourceRegistry:
    """Validate candidate dispositions and compute the native-log source gate."""

    registry_path = registry_path.resolve()
    if not registry_path.exists():
        raise FileNotFoundError(f"Source registry does not exist: {registry_path}")

    errors: list[str] = []
    warnings: list[str] = []
    with registry_path.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        fieldnames = tuple(reader.fieldnames or ())
        raw_rows = list(reader)

    missing_fields = [field for field in REQUIRED_FIELDS if field not in fieldnames]
    if missing_fields:
        errors.append(f"header: missing required columns: {', '.join(missing_fields)}")
    if not raw_rows:
        errors.append("registry: at least one source row is required")

    rows: list[dict[str, Any]] = []
    source_ids: dict[str, int] = {}
    for row_index, raw_row in enumerate(raw_rows):
        row_number = row_index + 2
        row_errors_before = len(errors)
        source_id = str(raw_row.get("source_id", "") or "").strip()
        if not source_id:
            errors.append(f"row {row_number}: source_id is required")
        elif source_id in source_ids:
            errors.append(
                f"row {row_number}: source_id {source_id!r} duplicates "
                f"row {source_ids[source_id]}"
            )
        else:
            source_ids[source_id] = row_number

        title = str(raw_row.get("title", "") or "").strip()
        source_url = str(raw_row.get("source_url", "") or "").strip()
        source_kind = str(raw_row.get("source_kind", "") or "").strip()
        status = str(raw_row.get("status", "") or "").strip().lower()
        independence_group = str(
            raw_row.get("independence_group", "") or ""
        ).strip()
        duplicate_of = str(raw_row.get("duplicate_of", "") or "").strip()
        disposition_reason = str(
            raw_row.get("disposition_reason", "") or ""
        ).strip()
        evidence = str(raw_row.get("evidence", "") or "").strip()

        if not title:
            errors.append(f"row {row_number}: title is required")
        if not source_url.startswith(("https://", "http://")):
            errors.append(f"row {row_number}: source_url must be HTTP(S)")
        if not source_kind:
            errors.append(f"row {row_number}: source_kind is required")
        if status not in SOURCE_STATUSES:
            errors.append(
                f"row {row_number}: status must be calibration, stress-only, "
                "or excluded"
            )
        if not disposition_reason:
            errors.append(f"row {row_number}: disposition_reason is required")
        if not evidence:
            errors.append(f"row {row_number}: evidence is required")

        is_measured = _boolean(
            raw_row.get("is_measured"),
            field="is_measured",
            row_number=row_number,
            errors=errors,
        )
        native_log_y = _boolean(
            raw_row.get("native_log_y"),
            field="native_log_y",
            row_number=row_number,
            errors=errors,
        )
        multi_state_vth = _boolean(
            raw_row.get("multi_state_vth"),
            field="multi_state_vth",
            row_number=row_number,
            errors=errors,
        )
        public_fulltext = _boolean(
            raw_row.get("public_fulltext"),
            field="public_fulltext",
            row_number=row_number,
            errors=errors,
        )

        if status == "calibration":
            unmet = [
                name
                for name, met in (
                    ("is_measured", is_measured),
                    ("native_log_y", native_log_y),
                    ("multi_state_vth", multi_state_vth),
                    ("public_fulltext", public_fulltext),
                    ("independence_group", bool(independence_group)),
                    ("not_duplicate", not duplicate_of),
                )
                if not met
            ]
            if unmet:
                errors.append(
                    f"row {row_number}: calibration source fails: "
                    f"{', '.join(unmet)}"
                )
        if status == "stress-only" and not public_fulltext:
            errors.append(
                f"row {row_number}: stress-only source requires public_fulltext"
            )
        if duplicate_of and duplicate_of == source_id:
            errors.append(f"row {row_number}: duplicate_of cannot reference itself")

        row = {
            "source_id": source_id,
            "title": title,
            "source_url": source_url,
            "year": _year(
                raw_row.get("year"),
                row_number=row_number,
                errors=errors,
            ),
            "source_kind": source_kind,
            "is_measured": is_measured,
            "native_log_y": native_log_y,
            "multi_state_vth": multi_state_vth,
            "public_fulltext": public_fulltext,
            "independence_group": independence_group,
            "duplicate_of": duplicate_of,
            "status": status,
            "disposition_reason": disposition_reason,
            "evidence": evidence,
            "row_number": row_number,
        }
        if len(errors) == row_errors_before:
            rows.append(row)

    known_ids = {row["source_id"] for row in rows}
    for row in rows:
        if row["duplicate_of"] and row["duplicate_of"] not in known_ids:
            errors.append(
                f"row {row['row_number']}: duplicate_of "
                f"{row['duplicate_of']!r} is not a registry source_id"
            )

    calibration_rows = [row for row in rows if row["status"] == "calibration"]
    calibration_groups = {
        row["independence_group"]
        for row in calibration_rows
        if row["independence_group"]
    }
    duplicate_groups = len(calibration_rows) - len(calibration_groups)
    if duplicate_groups:
        warnings.append(
            f"{duplicate_groups} calibration source(s) reuse an independence_group"
        )
    status_counts = {
        status: sum(row["status"] == status for row in rows)
        for status in sorted(SOURCE_STATUSES)
    }
    registry_valid = not errors and len(rows) == len(raw_rows)
    summary = {
        "schema_version": 1,
        "registry_path": str(registry_path),
        "source_count": len(raw_rows),
        "valid_source_count": len(rows),
        "error_count": len(errors),
        "warning_count": len(warnings),
        "status_counts": status_counts,
        "measured_source_count": sum(row["is_measured"] for row in rows),
        "native_log_source_count": sum(row["native_log_y"] for row in rows),
        "calibration_source_count": len(calibration_rows),
        "calibration_independence_group_count": len(calibration_groups),
        "quality_gates": {
            "registry_valid": registry_valid,
            "calibration_sources_minimum_3": (
                registry_valid and len(calibration_rows) >= 3
            ),
            "calibration_independence_groups_minimum_3": (
                registry_valid and len(calibration_groups) >= 3
            ),
        },
    }
    summary["ready_for_domain_calibration"] = bool(
        summary["quality_gates"]["calibration_sources_minimum_3"]
        and summary["quality_gates"][
            "calibration_independence_groups_minimum_3"
        ]
    )
    return SourceRegistry(
        rows=tuple(rows),
        summary=summary,
        errors=tuple(errors),
        warnings=tuple(warnings),
    )


def audit_source_registry(
    registry_path: Path,
    output_path: Path,
) -> dict[str, Any]:
    """Write a machine-readable audit report for a source registry."""

    registry = inspect_source_registry(registry_path)
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "summary": registry.summary,
        "errors": list(registry.errors),
        "warnings": list(registry.warnings),
        "sources": [
            {key: value for key, value in row.items() if key != "row_number"}
            for row in registry.rows
        ],
    }
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "report_path": str(output_path),
        **registry.summary,
        "errors": list(registry.errors),
        "warnings": list(registry.warnings),
    }
