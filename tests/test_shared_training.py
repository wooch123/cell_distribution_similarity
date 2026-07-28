import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import numpy as np
import pytest

from vnand_similarity.pipeline import build_vector_index, generate_corpus
from vnand_similarity.shared_training import (
    SHARED_SOURCE,
    fetch_all_shared_candidates,
    index_shared_training_corpus,
    sync_shared_training_corpus,
)
from vnand_similarity.store import SQLiteVectorStore


def _candidate(index: int, *, state_count: int = 4) -> dict:
    positions = np.linspace(0.12, 0.88, state_count)
    x = np.linspace(0.0, 1.0, 256)
    profile = np.max(
        [np.exp(-0.5 * ((x - center) / (0.035 + index * 0.001)) ** 2) for center in positions],
        axis=0,
    )
    valleys = state_count - 1
    return {
        "id": f"shared-{index:08x}-1234-4abc-8def-{index:012x}",
        "label": f"Shared candidate {index}",
        "profile": profile.round(8).tolist(),
        "stateCount": state_count,
        "peakLocations": positions.tolist(),
        "peakWidths": [0.07] * state_count,
        "valleyHeights": [0.02] * valleys,
        "valleyLocations": [
            float((left + right) / 2) for left, right in zip(positions[:-1], positions[1:])
        ],
        "valleyDepths": [0.98] * valleys,
        "valleyPositionRatios": [0.5] * valleys,
        "peakValleyDistances": [0.5] * (valleys * 2),
        "tailSlopes": [0.2] * (valleys * 2),
        "area": float(np.mean(profile)),
        "learnedAt": "2026-07-27 12:00:00",
    }


def _paged_fetch(candidates: list[dict]):
    def fetch(url: str, _timeout: float) -> dict:
        query = parse_qs(urlsplit(url).query)
        limit = int(query["limit"][0])
        offset = int(query.get("cursor", ["0"])[0])
        page = candidates[offset : offset + limit]
        next_offset = offset + len(page)
        return {
            "schemaVersion": 3,
            "candidateCount": len(candidates),
            "returned": len(page),
            "candidates": page,
            "nextCursor": (str(next_offset) if next_offset < len(candidates) else None),
        }

    return fetch


def test_shared_curves_materialize_without_downloading_raw_images(
    tmp_path: Path,
) -> None:
    candidates = [_candidate(index) for index in range(3)]
    corpus = tmp_path / "shared"
    result = sync_shared_training_corpus(
        corpus,
        endpoint="https://example.test/api/shared",
        page_size=2,
        fetch_json=_paged_fetch(candidates),
    )
    manifest = [json.loads(line) for line in (corpus / "manifest.jsonl").read_text().splitlines()]
    snapshot = json.loads((corpus / "shared-training-snapshot.json").read_text())

    assert result["candidate_count"] == 3
    assert result["vector_count"] == 9
    assert result["pages"] == 2
    assert result["raw_images_downloaded"] == 0
    assert len(manifest) == 9
    assert {record["variant_id"] for record in manifest} == {
        "base",
        "variant-01",
        "variant-02",
    }
    assert all(Path(record["image_path"]).exists() for record in manifest)
    assert all(Path(record["raw_path"]).exists() for record in manifest)
    assert all(record["metadata"]["source"] == SHARED_SOURCE for record in manifest)
    assert snapshot["privacy"] == {
        "raw_images_included": False,
        "original_filenames_included": False,
        "canonical_curves_included": True,
    }


def test_shared_sync_upserts_and_prunes_only_shared_vectors(tmp_path: Path) -> None:
    synthetic = tmp_path / "synthetic"
    shared = tmp_path / "shared"
    index = tmp_path / "vectors.sqlite"
    generate_corpus(synthetic, samples=1, variants=1, state_count=4, seed=12)
    build_vector_index(synthetic, index)

    first = [_candidate(value) for value in range(3)]
    sync_shared_training_corpus(
        shared,
        fetch_json=_paged_fetch(first),
        page_size=2,
    )
    indexed_first = index_shared_training_corpus(shared, index)
    assert indexed_first["shared_vectors"] == 9
    assert indexed_first["total_vectors"] == 11

    second = first[1:]
    sync_shared_training_corpus(
        shared,
        fetch_json=_paged_fetch(second),
        page_size=1,
    )
    indexed_second = index_shared_training_corpus(shared, index)
    with SQLiteVectorStore(index) as store:
        records = store.all_records()

    assert indexed_second["shared_vectors"] == 6
    assert indexed_second["pruned_shared_vectors"] == 3
    assert indexed_second["total_vectors"] == 8
    assert sum(record.metadata.get("source") != SHARED_SOURCE for record in records) == 2
    assert all(first[0]["id"] not in record.vector_id for record in records)


def test_shared_fetch_rejects_repeated_cursors_duplicates_and_bad_profiles() -> None:
    calls = 0

    def repeated(_url: str, _timeout: float) -> dict:
        nonlocal calls
        candidate = _candidate(calls)
        calls += 1
        return {
            "candidateCount": 3,
            "candidates": [candidate],
            "nextCursor": "repeat",
        }

    with pytest.raises(ValueError, match="cursor repeated"):
        fetch_all_shared_candidates(
            "https://example.test/shared",
            page_size=1,
            fetch_json=repeated,
            retries=0,
        )

    duplicate = _candidate(1)

    def duplicated(url: str, _timeout: float) -> dict:
        cursor = parse_qs(urlsplit(url).query).get("cursor")
        return {
            "candidateCount": 2,
            "candidates": [duplicate],
            "nextCursor": None if cursor else "next",
        }

    with pytest.raises(ValueError, match="duplicate ID"):
        fetch_all_shared_candidates(
            "https://example.test/shared",
            page_size=1,
            fetch_json=duplicated,
            retries=0,
        )

    malformed = _candidate(2)
    malformed["profile"] = malformed["profile"][:-1]
    with pytest.raises(ValueError, match="256"):
        fetch_all_shared_candidates(
            "https://example.test/shared",
            fetch_json=_paged_fetch([malformed]),
            retries=0,
        )
