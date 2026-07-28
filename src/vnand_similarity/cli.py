"""Command line interface for the V-NAND similarity workflow."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .dual_encoder import (
    audit_dual_curve_encoder,
    train_dual_curve_encoder,
)
from .evaluation import (
    RANKING_STRATEGIES,
    evaluate_heldout_queries,
    evaluate_real_image_manifest,
)
from .feedback import ingest_feedback_reports
from .imaging import augment_graph_image, render_vth_graph
from .model_selection import compare_rerankers_on_feedback
from .pipeline import build_vector_index, generate_corpus, search_similar
from .real_data import validate_real_image_manifest
from .shared_retraining import (
    DEFAULT_SHARED_RELEVANCE_ENDPOINT,
    run_shared_retraining_cycle,
)
from .shared_training import (
    DEFAULT_SHARED_TRAINING_ENDPOINT,
    index_shared_training_corpus,
    sync_shared_training_corpus,
)
from .source_registry import audit_source_registry
from .synthetic import SyntheticVthSample
from .training import NEGATIVE_SAMPLING_STRATEGIES, train_pairwise_reranker


def _print(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _paths(root: Path) -> dict[str, Path]:
    return {
        "corpus": root / "data" / "processed" / "corpus",
        "index": root / "artifacts" / "vectors.sqlite",
        "model": root / "artifacts" / "pairwise-reranker.joblib",
        "dual_encoder": root / "artifacts" / "dual-curve-encoder.joblib",
        "dual_encoder_browser": (
            root / "artifacts" / "dual-curve-encoder.browser.json"
        ),
        "search": root / "artifacts" / "search",
        "evaluation": root / "artifacts" / "evaluation",
        "real_evaluation": root / "artifacts" / "real-evaluation",
        "real_validation": root / "artifacts" / "real-intake",
        "feedback": root / "artifacts" / "expert-feedback",
        "shared_training": root / "data" / "processed" / "shared-training",
        "shared_retraining": root / "artifacts" / "shared-retraining",
        "model_comparison": root / "artifacts" / "model-comparison",
        "source_audit": root / "artifacts" / "source-audit.json",
    }


def _state_counts(value: str) -> tuple[int, ...]:
    try:
        counts = tuple(dict.fromkeys(int(part.strip()) for part in value.split(",") if part.strip()))
    except ValueError as error:
        raise argparse.ArgumentTypeError("--states must be comma-separated integers") from error
    if not counts or any(count not in (2, 4, 8, 16) for count in counts):
        raise argparse.ArgumentTypeError("--states supports 2, 4, 8, and 16")
    return counts


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vnand-similarity",
        description="V-NAND VTH graph shape similarity workflow",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path.cwd(),
        help="Project root (default: current directory)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate = subparsers.add_parser("generate", help="Generate a synthetic VTH corpus")
    generate.add_argument("--samples", type=int, default=40)
    generate.add_argument("--variants", type=int, default=3)
    generate.add_argument(
        "--states",
        type=_state_counts,
        default=(8,),
        help="Comma-separated state counts, for example 2,4,8,16",
    )
    generate.add_argument("--seed", type=int, default=42)
    generate.add_argument("--corpus", type=Path)
    generate.add_argument(
        "--append",
        action="store_true",
        help="Keep the existing manifest instead of replacing generated corpus files",
    )

    index = subparsers.add_parser("index", help="Extract features and build the vector index")
    index.add_argument("--corpus", type=Path)
    index.add_argument("--index", type=Path)

    train = subparsers.add_parser("train", help="Train the pairwise candidate reranker")
    train.add_argument("--index", type=Path)
    train.add_argument("--model", type=Path)
    train.add_argument("--seed", type=int, default=42)
    train.add_argument(
        "--feedback",
        type=Path,
        nargs="+",
        help="Schema-v2 expert feedback JSON reports to weight during training",
    )
    train.add_argument("--feedback-weight", type=float, default=4.0)
    train.add_argument("--min-feedback-pairs", type=int, default=20)
    train.add_argument(
        "--negative-sampling",
        choices=NEGATIVE_SAMPLING_STRATEGIES,
        default="random-stratified",
        help="Negative pair strategy for reranker training",
    )

    train_embedding = subparsers.add_parser(
        "train-embedding",
        help="Train the image-trace/Curve dual encoder with sample-ID validation",
    )
    train_embedding.add_argument("--index", type=Path)
    train_embedding.add_argument("--model", type=Path)
    train_embedding.add_argument("--browser-model", type=Path)
    train_embedding.add_argument("--browser-pairs", type=Path)
    train_embedding.add_argument("--domain-reports", type=Path, nargs="+")
    train_embedding.add_argument("--domain-weight", type=int, default=4)
    train_embedding.add_argument("--reranker", type=Path)
    train_embedding.add_argument("--validation-queries", type=Path)
    train_embedding.add_argument(
        "--encoder-kind",
        choices=("linear", "nonlinear"),
        default="nonlinear",
    )
    train_embedding.add_argument(
        "--feature-kind",
        choices=("curve", "image-curve"),
        default="image-curve",
        help="Use Curve-only or fused 3,200-D image + 384-D Curve features",
    )
    train_embedding.add_argument("--dimensions", type=int, default=8)
    train_embedding.add_argument("--ridge-alpha", type=float, default=10.0)
    train_embedding.add_argument("--hidden-dimensions", type=int, default=8)
    train_embedding.add_argument("--mlp-alpha", type=float, default=0.01)
    train_embedding.add_argument("--mlp-max-iter", type=int, default=1000)
    train_embedding.add_argument("--validation-fraction", type=float, default=0.25)
    train_embedding.add_argument("--seed", type=int, default=20260727)
    train_embedding.add_argument("--rerank-limit", type=int, default=10)

    audit_embedding = subparsers.add_parser(
        "audit-embedding",
        help="Promote a dual encoder only after public, measured, and user gates",
    )
    audit_embedding.add_argument("model", type=Path)
    audit_embedding.add_argument("reports", type=Path, nargs="+")
    audit_embedding.add_argument("--output-model", type=Path)
    audit_embedding.add_argument("--browser-model", type=Path)

    ingest_feedback = subparsers.add_parser(
        "ingest-feedback",
        help=(
            "Validate browser reports or a shared relevance export, then "
            "aggregate expert consensus"
        ),
    )
    ingest_feedback.add_argument("reports", type=Path, nargs="+")
    ingest_feedback.add_argument("--output", type=Path)

    sync_shared = subparsers.add_parser(
        "sync-shared-training",
        help=(
            "Download every consented canonical Curve, materialize safe "
            "variants, and upsert them into the vector index"
        ),
    )
    sync_shared.add_argument(
        "--endpoint",
        default=DEFAULT_SHARED_TRAINING_ENDPOINT,
    )
    sync_shared.add_argument("--output", type=Path)
    sync_shared.add_argument("--index", type=Path)
    sync_shared.add_argument("--page-size", type=int, default=500)
    sync_shared.add_argument("--timeout", type=float, default=30.0)
    sync_shared.add_argument(
        "--no-index",
        action="store_true",
        help="Materialize the corpus without updating SQLite",
    )

    retrain_shared = subparsers.add_parser(
        "retrain-shared",
        help=(
            "Train from independent shared consensus labels and promote only "
            "after expert and synthetic regression gates"
        ),
    )
    retrain_shared.add_argument(
        "--endpoint",
        default=DEFAULT_SHARED_RELEVANCE_ENDPOINT,
    )
    retrain_shared.add_argument("--index", type=Path)
    retrain_shared.add_argument("--baseline-model", type=Path)
    retrain_shared.add_argument("--candidate-model", type=Path)
    retrain_shared.add_argument("--corpus", type=Path)
    retrain_shared.add_argument("--output", type=Path)
    retrain_shared.add_argument("--timeout", type=float, default=30.0)
    retrain_shared.add_argument("--minimum-pairs", type=int, default=40)
    retrain_shared.add_argument("--feedback-weight", type=float, default=4.0)
    retrain_shared.add_argument("--seed", type=int, default=20260727)
    retrain_shared.add_argument("--promote", action="store_true")

    search = subparsers.add_parser("search", help="Search with one VTH graph image")
    search.add_argument("query", type=Path)
    search.add_argument("--index", type=Path)
    search.add_argument("--model", type=Path)
    search.add_argument("--embedding-model", type=Path)
    search.add_argument("--output", type=Path)
    search.add_argument("--top-k", type=int, default=8)

    evaluate = subparsers.add_parser(
        "evaluate",
        help="Evaluate unseen renderings from every raw VTH sample",
    )
    evaluate.add_argument("--corpus", type=Path)
    evaluate.add_argument("--index", type=Path)
    evaluate.add_argument("--model", type=Path)
    evaluate.add_argument("--output", type=Path)
    evaluate.add_argument("--seed", type=int, default=2026)
    evaluate.add_argument("--limit", type=int)
    evaluate.add_argument(
        "--ranking-strategy",
        choices=RANKING_STRATEGIES,
        default="reranked",
    )

    real_evaluate = subparsers.add_parser(
        "evaluate-real",
        help="Evaluate anonymized real images from the intake CSV",
    )
    real_evaluate.add_argument("manifest", type=Path)
    real_evaluate.add_argument("--index", type=Path)
    real_evaluate.add_argument("--model", type=Path)
    real_evaluate.add_argument("--output", type=Path)
    real_evaluate.add_argument("--top-k", type=int, default=10)

    real_validate = subparsers.add_parser(
        "validate-real",
        help="Validate and normalize a real-image intake CSV before evaluation",
    )
    real_validate.add_argument("manifest", type=Path)
    real_validate.add_argument("--output", type=Path)

    source_audit = subparsers.add_parser(
        "audit-sources",
        help="Audit public source candidates for native-log calibration eligibility",
    )
    source_audit.add_argument("registry", type=Path)
    source_audit.add_argument("--output", type=Path)

    compare_models = subparsers.add_parser(
        "compare-models",
        help="Compare baseline and candidate rerankers on held-out expert labels",
    )
    compare_models.add_argument("baseline", type=Path)
    compare_models.add_argument("candidate", type=Path)
    compare_models.add_argument("feedback", type=Path, nargs="+")
    compare_models.add_argument("--output", type=Path)

    demo = subparsers.add_parser("demo", help="Run a small end-to-end demonstration")
    demo.add_argument("--samples", type=int, default=12)
    demo.add_argument("--variants", type=int, default=2)
    demo.add_argument(
        "--states",
        type=_state_counts,
        default=(8,),
        help="Comma-separated state counts, for example 2,4,8,16",
    )
    demo.add_argument("--seed", type=int, default=42)
    demo.add_argument("--top-k", type=int, default=5)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> None:
    args = build_parser().parse_args(argv)
    root = args.root.resolve()
    defaults = _paths(root)

    if args.command == "generate":
        _print(
            generate_corpus(
                (args.corpus or defaults["corpus"]).resolve(),
                samples=args.samples,
                variants=args.variants,
                state_counts=args.states,
                seed=args.seed,
                replace=not args.append,
            )
        )
        return

    if args.command == "index":
        _print(
            build_vector_index(
                (args.corpus or defaults["corpus"]).resolve(),
                (args.index or defaults["index"]).resolve(),
            )
        )
        return

    if args.command == "train":
        summary = train_pairwise_reranker(
            (args.index or defaults["index"]).resolve(),
            (args.model or defaults["model"]).resolve(),
            seed=args.seed,
            feedback_paths=tuple(
                path.resolve() for path in (args.feedback or ())
            ),
            feedback_weight=args.feedback_weight,
            min_feedback_pairs=args.min_feedback_pairs,
            negative_sampling=args.negative_sampling,
        )
        _print(summary.as_dict())
        return

    if args.command == "train-embedding":
        summary = train_dual_curve_encoder(
            (args.index or defaults["index"]).resolve(),
            (args.model or defaults["dual_encoder"]).resolve(),
            browser_model_path=(
                args.browser_model or defaults["dual_encoder_browser"]
            ).resolve(),
            browser_pairs_path=(
                args.browser_pairs.resolve()
                if args.browser_pairs
                else None
            ),
            domain_report_paths=tuple(
                path.resolve() for path in (args.domain_reports or ())
            ),
            domain_weight=args.domain_weight,
            reranker_model_path=(
                args.reranker or defaults["model"]
            ).resolve(),
            validation_query_dir=(
                args.validation_queries.resolve()
                if args.validation_queries
                else None
            ),
            encoder_kind=args.encoder_kind,
            feature_kind=args.feature_kind,
            embedding_dimensions=args.dimensions,
            ridge_alpha=args.ridge_alpha,
            hidden_dimensions=args.hidden_dimensions,
            mlp_alpha=args.mlp_alpha,
            mlp_max_iter=args.mlp_max_iter,
            validation_fraction=args.validation_fraction,
            seed=args.seed,
            rerank_limit=args.rerank_limit,
        )
        _print(summary.as_dict())
        return

    if args.command == "audit-embedding":
        _print(
            audit_dual_curve_encoder(
                args.model.resolve(),
                tuple(path.resolve() for path in args.reports),
                output_model_path=(
                    args.output_model.resolve()
                    if args.output_model
                    else None
                ),
                browser_model_path=(
                    args.browser_model.resolve()
                    if args.browser_model
                    else defaults["dual_encoder_browser"].resolve()
                ),
            )
        )
        return

    if args.command == "ingest-feedback":
        _print(
            ingest_feedback_reports(
                tuple(path.resolve() for path in args.reports),
                (args.output or defaults["feedback"]).resolve(),
            )
        )
        return

    if args.command == "sync-shared-training":
        output_dir = (args.output or defaults["shared_training"]).resolve()
        result = sync_shared_training_corpus(
            output_dir,
            endpoint=args.endpoint,
            page_size=args.page_size,
            timeout=args.timeout,
        )
        if not args.no_index:
            result["index"] = index_shared_training_corpus(
                output_dir,
                (args.index or defaults["index"]).resolve(),
            )
        _print(result)
        return

    if args.command == "retrain-shared":
        _print(
            run_shared_retraining_cycle(
                index_path=(args.index or defaults["index"]).resolve(),
                baseline_model_path=(
                    args.baseline_model or defaults["model"]
                ).resolve(),
                candidate_model_path=(
                    args.candidate_model
                    or root
                    / "artifacts"
                    / "pairwise-reranker-shared-candidate.joblib"
                ).resolve(),
                corpus_dir=(args.corpus or defaults["corpus"]).resolve(),
                output_dir=(
                    args.output or defaults["shared_retraining"]
                ).resolve(),
                endpoint=args.endpoint,
                timeout=args.timeout,
                minimum_pairs=args.minimum_pairs,
                feedback_weight=args.feedback_weight,
                seed=args.seed,
                promote=args.promote,
            )
        )
        return

    if args.command == "search":
        _print(
            search_similar(
                args.query.resolve(),
                (args.index or defaults["index"]).resolve(),
                (args.output or defaults["search"]).resolve(),
                top_k=args.top_k,
                model_path=(args.model or defaults["model"]).resolve(),
                dual_encoder_path=(
                    args.embedding_model or defaults["dual_encoder"]
                ).resolve(),
            )
        )
        return

    if args.command == "evaluate":
        _print(
            evaluate_heldout_queries(
                (args.corpus or defaults["corpus"]).resolve(),
                (args.index or defaults["index"]).resolve(),
                (args.model or defaults["model"]).resolve(),
                (args.output or defaults["evaluation"]).resolve(),
                seed=args.seed,
                limit=args.limit,
                ranking_strategy=args.ranking_strategy,
            )
        )
        return

    if args.command == "evaluate-real":
        _print(
            evaluate_real_image_manifest(
                args.manifest.resolve(),
                (args.output or defaults["real_evaluation"]).resolve(),
                index_path=(args.index or defaults["index"]).resolve(),
                model_path=(args.model or defaults["model"]).resolve(),
                top_k=args.top_k,
            )
        )
        return

    if args.command == "validate-real":
        _print(
            validate_real_image_manifest(
                args.manifest.resolve(),
                (args.output or defaults["real_validation"]).resolve(),
            )
        )
        return

    if args.command == "audit-sources":
        _print(
            audit_source_registry(
                args.registry.resolve(),
                (args.output or defaults["source_audit"]).resolve(),
            )
        )
        return

    if args.command == "compare-models":
        _print(
            compare_rerankers_on_feedback(
                args.baseline.resolve(),
                args.candidate.resolve(),
                tuple(path.resolve() for path in args.feedback),
                (args.output or defaults["model_comparison"]).resolve(),
            )
        )
        return

    if args.command == "demo":
        corpus = defaults["corpus"]
        _print(
            generate_corpus(
                corpus,
                samples=args.samples,
                variants=args.variants,
                state_counts=args.states,
                seed=args.seed,
            )
        )
        _print(build_vector_index(corpus, defaults["index"]))
        summary = train_pairwise_reranker(defaults["index"], defaults["model"], seed=args.seed)
        _print(summary.as_dict())
        query = defaults["search"] / "demo-external-query.png"
        query_rng = np.random.default_rng(args.seed + 10_000)
        source_sample = SyntheticVthSample.load(
            corpus
            / "raw"
            / f"vth-{args.states[0]:02d}s-s{args.seed:04d}-00000.npz"
        )
        render_vth_graph(
            source_sample,
            query,
            rng=query_rng,
            axes=True,
            colored=True,
            filled=True,
            grid=True,
            dpi=155,
        )
        augment_graph_image(query, query, rng=query_rng)
        _print(
            search_similar(
                query,
                defaults["index"],
                defaults["search"],
                top_k=args.top_k,
                model_path=defaults["model"],
                dual_encoder_path=defaults["dual_encoder"],
            )
        )
        _print(
            evaluate_heldout_queries(
                corpus,
                defaults["index"],
                defaults["model"],
                defaults["evaluation"],
                seed=args.seed + 20_000,
            )
        )


if __name__ == "__main__":
    main()
