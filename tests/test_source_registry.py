import csv
from pathlib import Path

from vnand_similarity.source_registry import inspect_source_registry

FIELDS = (
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


def _write_registry(path: Path, rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def _row(source_id: str, group: str) -> dict[str, object]:
    return {
        "source_id": source_id,
        "title": f"Measured source {source_id}",
        "source_url": f"https://example.com/{source_id}.pdf",
        "year": 2024,
        "source_kind": "paper",
        "is_measured": "true",
        "native_log_y": "true",
        "multi_state_vth": "true",
        "public_fulltext": "true",
        "independence_group": group,
        "duplicate_of": "",
        "status": "calibration",
        "disposition_reason": "Measured multi-State VTH with native log y-axis",
        "evidence": "Figure 3 and methods section",
    }


def test_source_registry_requires_three_independent_calibration_sources(
    tmp_path: Path,
) -> None:
    path = tmp_path / "sources.csv"
    rows = [_row("source-a", "group-a"), _row("source-b", "group-b")]
    _write_registry(path, rows)

    registry = inspect_source_registry(path)

    assert not registry.errors
    assert registry.summary["calibration_source_count"] == 2
    assert registry.summary["calibration_independence_group_count"] == 2
    assert registry.summary["ready_for_domain_calibration"] is False

    rows.append(_row("source-c", "group-c"))
    _write_registry(path, rows)
    registry = inspect_source_registry(path)

    assert registry.summary["ready_for_domain_calibration"] is True


def test_source_registry_rejects_linear_or_duplicate_calibration_source(
    tmp_path: Path,
) -> None:
    path = tmp_path / "sources.csv"
    linear = _row("linear", "group-linear")
    linear["native_log_y"] = "false"
    duplicate = _row("duplicate", "group-duplicate")
    duplicate["duplicate_of"] = "linear"
    _write_registry(path, [linear, duplicate])

    registry = inspect_source_registry(path)

    assert any("native_log_y" in error for error in registry.errors)
    assert any("not_duplicate" in error for error in registry.errors)
    assert registry.summary["ready_for_domain_calibration"] is False


def test_source_registry_accepts_public_linear_measurement_as_stress_only(
    tmp_path: Path,
) -> None:
    path = tmp_path / "sources.csv"
    row = _row("linear", "group-linear")
    row.update(
        {
            "native_log_y": "false",
            "status": "stress-only",
            "disposition_reason": "Measured distribution uses a linear y-axis",
        }
    )
    _write_registry(path, [row])

    registry = inspect_source_registry(path)

    assert not registry.errors
    assert registry.summary["status_counts"]["stress-only"] == 1
    assert registry.summary["calibration_source_count"] == 0
