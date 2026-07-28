"""A compact SQLite vector store for the first offline-search iteration."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .features import (
    FeatureBundle,
    best_aligned_curve_similarity,
    cosine_similarity,
)


@dataclass(frozen=True)
class VectorRecord:
    vector_id: str
    sample_id: str
    variant_id: str
    image_path: str
    raw_path: str
    image_embedding: np.ndarray
    curve_embedding: np.ndarray
    descriptor: dict[str, Any]
    preprocessing: dict[str, Any]
    metadata: dict[str, Any]

    def feature_bundle(self) -> FeatureBundle:
        return FeatureBundle(
            image_embedding=self.image_embedding,
            curve_embedding=self.curve_embedding,
            descriptor=self.descriptor,
            preprocessing=self.preprocessing,
        )


@dataclass(frozen=True)
class ScoredRecord:
    record: VectorRecord
    retrieval_score: float
    image_score: float
    curve_score: float


def _encode(vector: np.ndarray) -> bytes:
    return np.asarray(vector, dtype=np.float32).reshape(-1).tobytes()


def _decode(value: bytes) -> np.ndarray:
    return np.frombuffer(value, dtype=np.float32).copy()


class SQLiteVectorStore:
    """SQLite-backed exact vector search.

    Exact search is intentional for the MVP: it is deterministic, easy to
    inspect, and adequate until the corpus reaches tens of thousands of images.
    The interface can later be backed by FAISS, Qdrant, or Milvus.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(str(path))
        self.connection.row_factory = sqlite3.Row
        self._create_schema()

    def _create_schema(self) -> None:
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS vectors (
                vector_id TEXT PRIMARY KEY,
                sample_id TEXT NOT NULL,
                variant_id TEXT NOT NULL,
                image_path TEXT NOT NULL,
                raw_path TEXT NOT NULL,
                image_embedding BLOB NOT NULL,
                curve_embedding BLOB NOT NULL,
                descriptor_json TEXT NOT NULL,
                preprocessing_json TEXT NOT NULL,
                metadata_json TEXT NOT NULL
            )
            """
        )
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_vectors_sample_id ON vectors(sample_id)"
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> SQLiteVectorStore:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def clear(self) -> None:
        self.connection.execute("DELETE FROM vectors")
        self.connection.commit()

    def add_many(self, records: Iterable[VectorRecord]) -> int:
        rows = [
            (
                record.vector_id,
                record.sample_id,
                record.variant_id,
                record.image_path,
                record.raw_path,
                _encode(record.image_embedding),
                _encode(record.curve_embedding),
                json.dumps(record.descriptor, ensure_ascii=False),
                json.dumps(record.preprocessing, ensure_ascii=False),
                json.dumps(record.metadata, ensure_ascii=False),
            )
            for record in records
        ]
        self.connection.executemany(
            """
            INSERT INTO vectors (
                vector_id,
                sample_id,
                variant_id,
                image_path,
                raw_path,
                image_embedding,
                curve_embedding,
                descriptor_json,
                preprocessing_json,
                metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(vector_id) DO UPDATE SET
                sample_id = excluded.sample_id,
                variant_id = excluded.variant_id,
                image_path = excluded.image_path,
                raw_path = excluded.raw_path,
                image_embedding = excluded.image_embedding,
                curve_embedding = excluded.curve_embedding,
                descriptor_json = excluded.descriptor_json,
                preprocessing_json = excluded.preprocessing_json,
                metadata_json = excluded.metadata_json
            """,
            rows,
        )
        self.connection.commit()
        return len(rows)

    @staticmethod
    def _record(row: sqlite3.Row) -> VectorRecord:
        return VectorRecord(
            vector_id=str(row["vector_id"]),
            sample_id=str(row["sample_id"]),
            variant_id=str(row["variant_id"]),
            image_path=str(row["image_path"]),
            raw_path=str(row["raw_path"]),
            image_embedding=_decode(row["image_embedding"]),
            curve_embedding=_decode(row["curve_embedding"]),
            descriptor=json.loads(row["descriptor_json"]),
            preprocessing=json.loads(row["preprocessing_json"]),
            metadata=json.loads(row["metadata_json"]),
        )

    def all_records(self) -> list[VectorRecord]:
        cursor = self.connection.execute("SELECT * FROM vectors ORDER BY vector_id")
        return [self._record(row) for row in cursor.fetchall()]

    def count(self) -> int:
        row = self.connection.execute("SELECT COUNT(*) AS count FROM vectors").fetchone()
        return int(row["count"])

    def delete_source_except(
        self,
        source: str,
        retained_vector_ids: Iterable[str],
    ) -> int:
        """Remove stale records from one derived source without touching others."""

        retained = {str(value) for value in retained_vector_ids}
        stale = []
        for record in self.all_records():
            if (
                record.metadata.get("source") == source
                and record.vector_id not in retained
            ):
                stale.append(record.vector_id)
        if stale:
            self.connection.executemany(
                "DELETE FROM vectors WHERE vector_id = ?",
                [(vector_id,) for vector_id in stale],
            )
            self.connection.commit()
        return len(stale)

    def search(
        self,
        query: FeatureBundle,
        *,
        limit: int = 50,
        image_weight: float = 0.18,
        curve_weight: float = 0.82,
        exclude_vector_id: Optional[str] = None,
        state_count: Optional[int] = None,
    ) -> list[ScoredRecord]:
        if limit < 1:
            raise ValueError("limit must be positive")
        if image_weight < 0 or curve_weight < 0 or image_weight + curve_weight <= 0:
            raise ValueError("similarity weights must be non-negative and non-zero")
        if state_count is not None and state_count < 1:
            raise ValueError("state_count must be positive")
        total_weight = image_weight + curve_weight

        results = []
        for record in self.all_records():
            if exclude_vector_id and record.vector_id == exclude_vector_id:
                continue
            record_state_count = record.metadata.get(
                "state_count",
                record.descriptor.get("peak_count"),
            )
            if (
                state_count is not None
                and (
                    record_state_count is None
                    or int(record_state_count) != state_count
                )
            ):
                continue
            image_score = cosine_similarity(query.image_embedding, record.image_embedding)
            curve_score = best_aligned_curve_similarity(
                query,
                record.feature_bundle(),
            )
            retrieval_score = (
                image_weight * image_score + curve_weight * curve_score
            ) / total_weight
            results.append(
                ScoredRecord(
                    record=record,
                    retrieval_score=float(retrieval_score),
                    image_score=float(image_score),
                    curve_score=float(curve_score),
                )
            )
        results.sort(key=lambda result: result.retrieval_score, reverse=True)
        return results[:limit]
