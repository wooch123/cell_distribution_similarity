"""Synthetic VTH distribution generation and overlap removal."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np

DEFAULT_LOG_Y_FLOOR = 1e-6


@dataclass(frozen=True)
class SyntheticVthSample:
    """One synthetic multi-state VTH distribution."""

    sample_id: str
    x: np.ndarray
    state_curves: np.ndarray
    exclusive_curves: np.ndarray
    metadata: dict[str, Any]

    @property
    def composite_curve(self) -> np.ndarray:
        return np.max(self.exclusive_curves, axis=0)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            path,
            sample_id=np.asarray(self.sample_id),
            x=self.x.astype(np.float32),
            state_curves=self.state_curves.astype(np.float32),
            exclusive_curves=self.exclusive_curves.astype(np.float32),
            composite_curve=self.composite_curve.astype(np.float32),
            metadata=np.asarray(json.dumps(self.metadata, ensure_ascii=False)),
        )

    @classmethod
    def load(cls, path: Path) -> SyntheticVthSample:
        with np.load(path, allow_pickle=False) as data:
            return cls(
                sample_id=str(data["sample_id"]),
                x=data["x"].astype(np.float64),
                state_curves=data["state_curves"].astype(np.float64),
                exclusive_curves=data["exclusive_curves"].astype(np.float64),
                metadata=json.loads(str(data["metadata"])),
            )


def remove_state_overlap(
    curves: np.ndarray,
    *,
    relative_floor: float = DEFAULT_LOG_Y_FLOOR,
) -> np.ndarray:
    """Keep only the dominant state at each x coordinate.

    The result retains each state's dominant shape while ensuring that no two
    state curves occupy the same x coordinate. The default floor preserves six
    decades of tail information for log-scale VTH plots.
    """

    if curves.ndim != 2:
        raise ValueError("curves must have shape (states, points)")
    if not 0 <= relative_floor < 1:
        raise ValueError("relative_floor must be in [0, 1)")

    peaks = np.max(curves, axis=1, keepdims=True)
    active = curves >= np.maximum(peaks * relative_floor, np.finfo(float).eps)
    owners = np.argmax(curves, axis=0)
    exclusive = np.zeros_like(curves)
    for state_index in range(curves.shape[0]):
        keep = (owners == state_index) & active[state_index]
        exclusive[state_index, keep] = curves[state_index, keep]
    return exclusive


def _asymmetric_peak(
    x: np.ndarray,
    center: float,
    sigma: float,
    skew: float,
    shoulder: float,
    shoulder_offset: float,
) -> np.ndarray:
    left_sigma = sigma * np.clip(1.0 - 0.35 * skew, 0.55, 1.65)
    right_sigma = sigma * np.clip(1.0 + 0.35 * skew, 0.55, 1.65)
    local_sigma = np.where(x < center, left_sigma, right_sigma)
    main = np.exp(-0.5 * ((x - center) / local_sigma) ** 2)

    secondary_center = center + shoulder_offset * sigma
    secondary_sigma = sigma * (0.55 + 0.25 * abs(skew))
    secondary = np.exp(-0.5 * ((x - secondary_center) / secondary_sigma) ** 2)
    return main + shoulder * secondary


def generate_vth_sample(
    rng: np.random.Generator,
    *,
    sample_id: str,
    state_count: int = 8,
    points: int = 512,
    family: Optional[str] = None,
) -> SyntheticVthSample:
    """Generate a realistic-looking, configurable VTH state distribution."""

    if state_count < 2:
        raise ValueError("state_count must be at least 2")
    if points < 128:
        raise ValueError("points must be at least 128")

    x = np.linspace(0.0, 1.0, points)
    edge = rng.uniform(0.045, 0.075)
    nominal = np.linspace(edge, 1.0 - edge, state_count)
    spacing = float(np.mean(np.diff(nominal)))
    jitter = rng.normal(0.0, spacing * 0.055, state_count)
    centers = np.maximum.accumulate(nominal + jitter)

    family_name = family or str(rng.choice(["balanced", "wide-tail", "compressed", "asymmetric"]))
    width_scale = {
        "balanced": 0.16,
        "wide-tail": 0.22,
        "compressed": 0.12,
        "asymmetric": 0.18,
    }[family_name]

    curves = []
    widths = []
    heights = []
    skews = []
    shoulders = []
    for state_index, center in enumerate(centers):
        state_scale = 1.15 if state_index in (0, state_count - 1) else 1.0
        sigma = spacing * width_scale * state_scale * rng.uniform(0.82, 1.22)
        skew = rng.uniform(-1.0, 1.0)
        if family_name == "asymmetric":
            skew = float(np.clip(skew + rng.choice([-0.75, 0.75]), -1.5, 1.5))
        shoulder = rng.uniform(0.0, 0.22 if family_name == "wide-tail" else 0.12)
        shoulder_offset = rng.choice([-1.0, 1.0]) * rng.uniform(0.65, 1.45)
        height = rng.uniform(0.78, 1.0)

        curve = _asymmetric_peak(x, center, sigma, skew, shoulder, shoulder_offset)
        curve = height * curve / max(float(np.max(curve)), np.finfo(float).eps)
        curves.append(curve)
        widths.append(float(sigma))
        heights.append(float(height))
        skews.append(float(skew))
        shoulders.append(float(shoulder))

    state_curves = np.asarray(curves, dtype=np.float64)
    exclusive_curves = remove_state_overlap(state_curves)
    overlap_mass = float(np.sum(state_curves) - np.sum(np.max(state_curves, axis=0))) / max(
        float(np.sum(state_curves)), np.finfo(float).eps
    )

    metadata: dict[str, Any] = {
        "state_count": state_count,
        "family": family_name,
        "centers": [float(value) for value in centers],
        "widths": widths,
        "heights": heights,
        "skews": skews,
        "shoulders": shoulders,
        "overlap_mass": overlap_mass,
        "x_domain": [0.0, 1.0],
        "y_scale": "log10",
        "y_floor": DEFAULT_LOG_Y_FLOOR,
        "dynamic_range_decades": float(-np.log10(DEFAULT_LOG_Y_FLOOR)),
        "overlap_policy": "dominant-state-only",
    }
    return SyntheticVthSample(
        sample_id=sample_id,
        x=x,
        state_curves=state_curves,
        exclusive_curves=exclusive_curves,
        metadata=metadata,
    )
