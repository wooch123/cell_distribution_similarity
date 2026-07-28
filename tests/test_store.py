from pathlib import Path

import numpy as np

from vnand_similarity.features import FeatureBundle
from vnand_similarity.store import SQLiteVectorStore, VectorRecord


def _record(
    identifier: str,
    image: list,
    curve: list,
    *,
    state_count: int = 1,
) -> VectorRecord:
    return VectorRecord(
        vector_id=identifier,
        sample_id=identifier,
        variant_id="base",
        image_path=f"{identifier}.png",
        raw_path=f"{identifier}.npz",
        image_embedding=np.asarray(image, dtype=np.float32),
        curve_embedding=np.asarray(curve, dtype=np.float32),
        descriptor={"peak_count": state_count},
        preprocessing={},
        metadata={"state_count": state_count},
    )


def test_vector_store_returns_nearest_record(tmp_path: Path) -> None:
    index_path = tmp_path / "vectors.sqlite"
    with SQLiteVectorStore(index_path) as store:
        store.add_many(
            [
                _record("near", [1.0, 0.0], [1.0, 0.0]),
                _record("far", [0.0, 1.0], [0.0, 1.0]),
            ]
        )
        query = FeatureBundle(
            image_embedding=np.asarray([0.95, 0.05], dtype=np.float32),
            curve_embedding=np.asarray([1.0, 0.0], dtype=np.float32),
            descriptor={},
            preprocessing={},
        )
        results = store.search(query, limit=2)

    assert results[0].record.vector_id == "near"
    assert results[0].retrieval_score > results[1].retrieval_score


def test_vector_store_can_restrict_retrieval_to_state_count(tmp_path: Path) -> None:
    index_path = tmp_path / "vectors.sqlite"
    with SQLiteVectorStore(index_path) as store:
        store.add_many(
            [
                _record("near-4-state", [1.0, 0.0], [1.0, 0.0], state_count=4),
                _record("far-2-state", [0.0, 1.0], [0.0, 1.0], state_count=2),
            ]
        )
        query = FeatureBundle(
            image_embedding=np.asarray([1.0, 0.0], dtype=np.float32),
            curve_embedding=np.asarray([1.0, 0.0], dtype=np.float32),
            descriptor={"peak_count": 2},
            preprocessing={},
        )
        results = store.search(query, limit=2, state_count=2)

    assert [result.record.vector_id for result in results] == ["far-2-state"]


def test_vector_store_uses_best_curve_hypothesis(tmp_path: Path) -> None:
    index_path = tmp_path / "vectors.sqlite"
    with SQLiteVectorStore(index_path) as store:
        store.add_many(
            [
                _record("near", [1.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
                _record("far", [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            ]
        )
        query = FeatureBundle(
            image_embedding=np.asarray([1.0, 0.0, 0.0], dtype=np.float32),
            curve_embedding=np.asarray([0.0, 0.0, 1.0], dtype=np.float32),
            descriptor={"peak_count": 2},
            preprocessing={},
            alternative_curve_embeddings=(
                np.asarray([1.0, 0.0, 0.0], dtype=np.float32),
            ),
            alternative_descriptors=({"peak_count": 2},),
        )
        results = store.search(
            query,
            limit=2,
            image_weight=0.0,
            curve_weight=1.0,
        )

    assert results[0].record.vector_id == "near"
    assert results[0].curve_score == 1.0
