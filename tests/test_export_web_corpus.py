from __future__ import annotations

import importlib
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_MODULE = importlib.import_module("scripts.export_web_corpus")
_select_diverse_candidates = _MODULE._select_diverse_candidates


def _candidate(state_count: int, seed: int, index: int) -> dict[str, object]:
    x = np.linspace(0.0, 1.0, 256)
    phase = 0.025 * index
    frequency = state_count + (index % 3) * 0.35
    profile = 0.55 + 0.35 * np.cos((x + phase) * np.pi * frequency)
    return {
        "id": f"vth-{state_count:02d}s-s{seed:04d}-{index:05d}",
        "stateCount": state_count,
        "family": ("balanced", "wide-tail", "compressed", "asymmetric")[index % 4],
        "profile": profile.tolist(),
    }


def test_diverse_export_preserves_baseline_and_improves_coverage() -> None:
    candidates = []
    for state_count in (2, 4):
        candidates.extend(_candidate(state_count, 42, index) for index in range(4))
        candidates.extend(_candidate(state_count, 43, index) for index in range(12))

    selected, summary = _select_diverse_candidates(
        candidates,
        max_per_state=10,
        baseline_seed=42,
    )

    assert len(selected) == 20
    assert summary["sourceCandidateCount"] == 32
    assert summary["selectedCandidateCount"] == 20
    for state_count in ("2", "4"):
        state_summary = summary["byState"][state_count]
        assert state_summary["source"] == 16
        assert state_summary["selected"] == 10
        assert state_summary["baselinePreserved"] == 4
        assert (
            state_summary["selectedCoverage"]["mean"]
            >= state_summary["baselineCoverage"]["mean"]
        )
        assert (
            state_summary["selectedCoverage"]["minimum"]
            >= state_summary["baselineCoverage"]["minimum"]
        )
