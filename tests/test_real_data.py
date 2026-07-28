import csv
from pathlib import Path

import pytest
from PIL import Image

from vnand_similarity.real_data import (
    require_valid_real_image_manifest,
    validate_real_image_manifest,
)


def _write_image(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (120, 80), "white").save(path)


def test_real_manifest_validation_normalizes_and_reports_quality_gates(
    tmp_path: Path,
) -> None:
    images = tmp_path / "images"
    rows = []
    for index in range(12):
        image_path = images / f"graph-{index:02d}.png"
        _write_image(image_path)
        rows.append(
            {
                "image_path": image_path.relative_to(tmp_path),
                "image_id": f"Q-{index:02d}",
                "state_count": 4,
                "observed_state_count": 4,
                "state_coverage": "full",
                "y_scale": "log10",
                "y_min": "1e-6",
                "y_max": "1",
                "similarity_group": f"shape-{index // 4}",
                "product_group": "anonymous-product",
                "notes": "",
                "source_id": f"source-{index // 4}",
                "source_url": "",
                "figure_id": f"figure-{index}",
                "source_kind": "equipment-export",
                "independence_group": f"independent-{index // 4}",
                "is_measured": "true",
            }
        )

    manifest_path = tmp_path / "manifest.csv"
    with manifest_path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    result = validate_real_image_manifest(
        manifest_path,
        tmp_path / "validation",
    )
    manifest = require_valid_real_image_manifest(manifest_path)

    assert result["error_count"] == 0
    assert result["valid_images"] == 12
    assert result["evaluable_similarity_group_count"] == 3
    assert result["relevance_queries"] == 12
    assert result["independence_group_count"] == 3
    assert result["observed_state_labelled_images"] == 12
    assert result["partial_state_coverage_images"] == 0
    assert result["quality_gates"]["first_validation_minimum_10"] is True
    assert result["ready_for_domain_calibration"] is True
    assert len(manifest.rows) == 12
    assert Path(result["normalized_manifest_path"]).exists()
    assert Path(result["report_path"]).exists()


def test_real_manifest_reports_duplicates_linear_scale_and_missing_files(
    tmp_path: Path,
) -> None:
    existing = tmp_path / "graph.png"
    _write_image(existing)
    manifest_path = tmp_path / "invalid.csv"
    manifest_path.write_text(
        "image_path,image_id,state_count,y_scale,y_min,y_max\n"
        "graph.png,Q-1,4,linear,1e-6,1\n"
        "graph.png,Q-1,not-a-number,log10,1,1e-6\n"
        "missing.png,Q-3,4,log10,1e-6,\n",
        encoding="utf-8",
    )

    result = validate_real_image_manifest(
        manifest_path,
        tmp_path / "validation",
    )

    assert result["error_count"] >= 6
    assert result["quality_gates"]["manifest_valid"] is False
    assert result["ready_for_domain_calibration"] is False
    with pytest.raises(ValueError, match="validation failed"):
        require_valid_real_image_manifest(manifest_path)


def test_real_manifest_tracks_partial_state_coverage(tmp_path: Path) -> None:
    image_path = tmp_path / "tlc.png"
    _write_image(image_path)
    manifest_path = tmp_path / "partial.csv"
    manifest_path.write_text(
        "image_path,state_count,observed_state_count,state_coverage,y_scale\n"
        "tlc.png,8,7,partial,log10\n",
        encoding="utf-8",
    )

    manifest = require_valid_real_image_manifest(manifest_path)

    assert manifest.rows[0]["state_count"] == 8
    assert manifest.rows[0]["observed_state_count"] == 7
    assert manifest.rows[0]["state_coverage"] == "partial"
    assert manifest.summary["partial_state_coverage_images"] == 1


def test_real_manifest_rejects_inconsistent_full_state_coverage(
    tmp_path: Path,
) -> None:
    image_path = tmp_path / "tlc.png"
    _write_image(image_path)
    manifest_path = tmp_path / "invalid-coverage.csv"
    manifest_path.write_text(
        "image_path,state_count,observed_state_count,state_coverage,y_scale\n"
        "tlc.png,8,7,full,log10\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="full state coverage"):
        require_valid_real_image_manifest(manifest_path)
