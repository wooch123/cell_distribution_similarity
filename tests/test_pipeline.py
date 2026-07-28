from pathlib import Path

from vnand_similarity.evaluation import (
    _graded_shape_metrics,
    evaluate_heldout_queries,
    evaluate_real_image_manifest,
)
from vnand_similarity.pipeline import build_vector_index, generate_corpus, search_similar
from vnand_similarity.training import train_pairwise_reranker


def test_small_end_to_end_workflow(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    index = tmp_path / "vectors.sqlite"
    model = tmp_path / "reranker.joblib"
    output = tmp_path / "search"

    generation = generate_corpus(corpus, samples=3, variants=1, state_count=4, seed=11)
    indexing = build_vector_index(corpus, index)
    training = train_pairwise_reranker(
        index,
        model,
        seed=11,
        negative_sampling="graded-mixed-hard",
    )
    query = corpus / "images" / "vth-04s-s0011-00000--variant-00.png"
    search = search_similar(query, index, output, top_k=2, model_path=model)
    evaluation = evaluate_heldout_queries(
        corpus,
        index,
        model,
        tmp_path / "evaluation",
        seed=11,
        ranking_strategy="retrieval",
    )

    assert generation["total_manifest_images"] == 6
    assert indexing["total_vectors"] == 6
    assert training.negative_sampling == "graded-mixed-hard"
    assert training.mined_negative_pairs > 0
    assert training.graded_positive_pairs > 0
    assert training.positive_pairs == 12 + training.graded_positive_pairs
    assert training.oracle_neighbor_count == 5
    assert len(search["results"]) == 2
    assert Path(search["results_path"]).exists()
    assert Path(search["contact_sheet_path"]).exists()
    assert evaluation["metrics"]["evaluated_queries"] == 3
    assert 0.0 <= evaluation["metrics"]["shape_ndcg_at_10"] <= 1.0
    assert Path(evaluation["report_path"]).exists()


def test_graded_shape_metrics_treat_nearby_sample_ids_as_relevant() -> None:
    metrics = _graded_shape_metrics(
        ["near", "source", "distant", "mid"],
        {
            "source": 1.0,
            "near": 0.98,
            "mid": 0.90,
            "distant": 0.72,
        },
        neighbor_count=2,
    )

    assert metrics["top_1_neighbor_hit"]
    assert metrics["neighbor_recall_at_5"] == 1.0
    assert metrics["neighbor_recall_at_10"] == 1.0
    assert metrics["ndcg_at_5"] > 0.9
    assert [item["sample_id"] for item in metrics["oracle_neighbors"]] == [
        "source",
        "near",
    ]


def test_mixed_state_corpus_uses_collision_free_ids(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"

    generation = generate_corpus(
        corpus,
        samples=2,
        variants=1,
        state_counts=(2, 4, 8, 16),
        seed=17,
    )

    raw_names = sorted(path.name for path in (corpus / "raw").glob("*.npz"))
    assert generation["generated_samples"] == 8
    assert generation["state_counts"] == [2, 4, 8, 16]
    assert generation["total_manifest_images"] == 16
    assert len(raw_names) == len(set(raw_names)) == 8
    assert {name.split("-")[1] for name in raw_names} == {"02s", "04s", "08s", "16s"}


def test_real_image_manifest_evaluation_reports_group_retrieval(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus"
    index = tmp_path / "vectors.sqlite"
    model = tmp_path / "reranker.joblib"
    generate_corpus(corpus, samples=2, variants=1, state_count=4, seed=23)
    build_vector_index(corpus, index)
    train_pairwise_reranker(index, model, seed=23)

    manifest = tmp_path / "real-images.csv"
    rows = ["image_path,state_count,y_scale,similarity_group,product_group,notes"]
    for sample_index in range(2):
        prefix = f"vth-04s-s0023-{sample_index:05d}"
        for variant in ("base", "variant-00"):
            rows.append(
                f"corpus/images/{prefix}--{variant}.png,4,log10,"
                f"group-{sample_index},product-a,{variant}"
            )
    manifest.write_text("\n".join(rows) + "\n", encoding="utf-8")

    report = evaluate_real_image_manifest(
        manifest,
        tmp_path / "real-evaluation",
        index_path=index,
        model_path=model,
        top_k=2,
    )

    assert report["metrics"]["processed_images"] == 4
    assert report["metrics"]["relevance_queries"] == 4
    assert report["metrics"]["recall_at_5"] == 1.0
    assert report["metrics"]["index_evaluated_queries"] == 4
    assert report["metrics"]["index_top_1_state_accuracy"] == 1.0
    assert report["metrics"]["index_reason_coverage"] == 1.0
    assert report["metrics"]["style_invariance_pairs"] == 2
    assert Path(report["report_path"]).exists()
