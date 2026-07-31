"""Synchronize privacy-preserving shared Curves into the offline corpus."""

from __future__ import annotations

import json
import math
import re
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image, ImageDraw

from .pipeline import build_vector_index
from .store import SQLiteVectorStore
from .synthetic import DEFAULT_LOG_Y_FLOOR, SyntheticVthSample

DEFAULT_SHARED_TRAINING_ENDPOINT = "http://127.0.0.1:4173/api/v1/shared-training-samples"
MAX_SHARED_CANDIDATES = 2000
MAX_SHARED_PAGE_SIZE = 500
SHARED_SOURCE = "shared-training-api"
_CANDIDATE_ID = re.compile(
    r"^shared-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
    r"[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_RENDER_VARIANTS = (
    ("base", 512, 256, 4, "#101715"),
    ("variant-01", 640, 288, 5, "#155d7a"),
    ("variant-02", 448, 288, 6, "#6b3d78"),
)

FetchJson = Callable[[str, float], dict[str, Any]]


def _http_fetch_json(url: str, timeout: float) -> dict[str, Any]:
    request = Request(
        url,
        headers={
            "accept": "application/json",
            "user-agent": "vnand-similarity-shared-sync/1",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        if int(response.status) != 200:
            raise ValueError(f"Shared training API returned HTTP {response.status}")
        body = response.read(16 * 1024 * 1024 + 1)
    if len(body) > 16 * 1024 * 1024:
        raise ValueError("Shared training API page exceeds 16 MiB")
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Shared training API returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise TypeError("Shared training API response must be an object")
    return payload


def _page_url(endpoint: str, page_size: int, cursor: Optional[str]) -> str:
    parts = urlsplit(endpoint)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("Shared training endpoint must be an HTTP(S) URL")
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["limit"] = str(page_size)
    if cursor:
        query["cursor"] = cursor
    else:
        query.pop("cursor", None)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


def _number_array(
    value: Any,
    *,
    field: str,
    exact: Optional[int] = None,
    minimum: Optional[int] = None,
    maximum: Optional[int] = None,
) -> list[float]:
    if not isinstance(value, list):
        raise TypeError(f"{field} must be an array")
    if exact is not None and len(value) != exact:
        raise ValueError(f"{field} must contain {exact} values")
    if minimum is not None and len(value) < minimum:
        raise ValueError(f"{field} is too short")
    if maximum is not None and len(value) > maximum:
        raise ValueError(f"{field} is too long")
    numbers = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise TypeError(f"{field} contains a non-number")
        number = float(item)
        if not math.isfinite(number) or number < 0.0 or number > 1.5:
            raise ValueError(f"{field} contains an out-of-range value")
        numbers.append(number)
    return numbers


def _validate_candidate(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise TypeError("Shared candidate must be an object")
    candidate_id = str(raw.get("id", ""))
    if not _CANDIDATE_ID.fullmatch(candidate_id):
        raise ValueError("Shared candidate ID is invalid")
    state_count = raw.get("stateCount")
    if isinstance(state_count, bool) or state_count not in {2, 4, 8, 16}:
        raise ValueError(f"{candidate_id}: stateCount is invalid")
    profile = _number_array(raw.get("profile"), field="profile", exact=256)
    if max(profile) - min(profile) < 0.05:
        raise ValueError(f"{candidate_id}: profile has insufficient variation")
    peak_locations = _number_array(
        raw.get("peakLocations"),
        field="peakLocations",
        minimum=2,
        maximum=int(state_count),
    )
    peak_count = len(peak_locations)
    valley_count = peak_count - 1
    descriptor = {
        "peakLocations": peak_locations,
        "peakWidths": _number_array(
            raw.get("peakWidths"),
            field="peakWidths",
            exact=peak_count,
        ),
        "valleyHeights": _number_array(
            raw.get("valleyHeights"),
            field="valleyHeights",
            exact=valley_count,
        ),
        "valleyLocations": _number_array(
            raw.get("valleyLocations"),
            field="valleyLocations",
            exact=valley_count,
        ),
        "valleyDepths": _number_array(
            raw.get("valleyDepths"),
            field="valleyDepths",
            exact=valley_count,
        ),
        "valleyPositionRatios": _number_array(
            raw.get("valleyPositionRatios"),
            field="valleyPositionRatios",
            exact=valley_count,
        ),
        "peakValleyDistances": _number_array(
            raw.get("peakValleyDistances"),
            field="peakValleyDistances",
            exact=valley_count * 2,
        ),
        "tailSlopes": _number_array(
            raw.get("tailSlopes"),
            field="tailSlopes",
            exact=valley_count * 2,
        ),
    }
    area = raw.get("area")
    if (
        isinstance(area, bool)
        or not isinstance(area, (int, float))
        or not math.isfinite(float(area))
        or not 0.0 <= float(area) <= 1.5
    ):
        raise ValueError(f"{candidate_id}: area is invalid")
    descriptor["area"] = float(area)
    label = re.sub(r"[\x00-\x1f\x7f]", " ", str(raw.get("label", ""))).strip()
    return {
        "id": candidate_id,
        "label": label[:80] or "공용 VTH 분포",
        "profile": profile,
        "state_count": int(state_count),
        "descriptor": descriptor,
        "learned_at": str(raw.get("learnedAt", ""))[:64],
    }


def fetch_all_shared_candidates(
    endpoint: str = DEFAULT_SHARED_TRAINING_ENDPOINT,
    *,
    page_size: int = MAX_SHARED_PAGE_SIZE,
    max_candidates: int = MAX_SHARED_CANDIDATES,
    timeout: float = 30.0,
    fetch_json: Optional[FetchJson] = None,
    retries: int = 1,
) -> dict[str, Any]:
    """Fetch a complete keyset snapshot and reject gaps or duplicates."""

    if not 1 <= page_size <= MAX_SHARED_PAGE_SIZE:
        raise ValueError("page_size must be in [1, 500]")
    if not 1 <= max_candidates <= MAX_SHARED_CANDIDATES:
        raise ValueError("max_candidates must be in [1, 2000]")
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    loader = fetch_json or _http_fetch_json
    last_error: Optional[Exception] = None
    for _attempt in range(max(0, min(int(retries), 2)) + 1):
        try:
            candidates: list[dict[str, Any]] = []
            identifiers: set[str] = set()
            cursors: set[str] = set()
            cursor: Optional[str] = None
            expected_count: Optional[int] = None
            pages = 0
            while True:
                payload = loader(_page_url(endpoint, page_size, cursor), timeout)
                raw_candidates = payload.get("candidates")
                if not isinstance(raw_candidates, list) or len(raw_candidates) > page_size:
                    raise ValueError("Shared candidate page is invalid")
                if pages == 0:
                    candidate_count = payload.get("candidateCount")
                    if (
                        isinstance(candidate_count, bool)
                        or not isinstance(candidate_count, int)
                        or not 0 <= candidate_count <= max_candidates
                    ):
                        raise ValueError("Shared candidateCount is invalid")
                    expected_count = candidate_count
                for raw_candidate in raw_candidates:
                    candidate = _validate_candidate(raw_candidate)
                    if candidate["id"] in identifiers:
                        raise ValueError("Shared candidate pages contain a duplicate ID")
                    identifiers.add(candidate["id"])
                    candidates.append(candidate)
                    if len(candidates) > max_candidates:
                        raise ValueError("Shared candidate count exceeds the sync limit")
                pages += 1
                next_cursor = payload.get("nextCursor")
                if next_cursor is None:
                    break
                if not isinstance(next_cursor, str) or not next_cursor:
                    raise ValueError("Shared nextCursor is invalid")
                if next_cursor in cursors:
                    raise ValueError("Shared candidate cursor repeated")
                cursors.add(next_cursor)
                cursor = next_cursor
            if expected_count is None or len(candidates) != expected_count:
                raise ValueError("Shared candidate snapshot is incomplete")
            return {
                "candidates": candidates,
                "candidate_count": expected_count,
                "pages": pages,
            }
        except (OSError, TypeError, ValueError) as error:
            last_error = error
    assert last_error is not None
    raise last_error


def _render_profile(
    profile: list[float],
    path: Path,
    *,
    width: int,
    height: int,
    line_width: int,
    color: str,
) -> None:
    scale = 2
    canvas = Image.new("RGB", (width * scale, height * scale), "white")
    draw = ImageDraw.Draw(canvas)
    padding_x = 12 * scale
    padding_y = 12 * scale
    points = [
        (
            padding_x + index / 255 * (width * scale - 2 * padding_x),
            padding_y + (1.0 - min(1.0, max(0.0, value))) * (height * scale - 2 * padding_y),
        )
        for index, value in enumerate(profile)
    ]
    draw.line(points, fill=color, width=line_width * scale, joint="curve")
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.resize((width, height), Image.Resampling.LANCZOS).save(path)


def _write_materialized_corpus(
    candidates: list[dict[str, Any]],
    staging_dir: Path,
    final_dir: Path,
    endpoint: str,
    pages: int,
) -> list[str]:
    manifest = []
    vector_ids = []
    for candidate in candidates:
        candidate_id = candidate["id"]
        profile = candidate["profile"]
        clipped = np.clip(np.asarray(profile, dtype=np.float64), 0.0, 1.0)
        physical = np.power(
            10.0,
            np.log10(DEFAULT_LOG_Y_FLOOR) + clipped * -np.log10(DEFAULT_LOG_Y_FLOOR),
        )
        metadata = {
            "state_count": candidate["state_count"],
            "family": "user-shared",
            "source": SHARED_SOURCE,
            "remote_id": candidate_id,
            "label": candidate["label"],
            "learned_at": candidate["learned_at"],
            "y_scale": "log10",
            "y_floor": DEFAULT_LOG_Y_FLOOR,
            "dynamic_range_decades": 6.0,
            "overlap_policy": "browser-canonical-profile",
            "canonical_profile": profile,
            "shared_descriptor": candidate["descriptor"],
            "raw_image_included": False,
            "original_filename_included": False,
        }
        raw_relative = Path("raw") / f"{candidate_id}.npz"
        SyntheticVthSample(
            sample_id=candidate_id,
            x=np.linspace(0.0, 1.0, 256),
            state_curves=physical.reshape(1, -1),
            exclusive_curves=physical.reshape(1, -1),
            metadata=metadata,
        ).save(staging_dir / raw_relative)
        for variant_id, width, height, line_width, color in _RENDER_VARIANTS:
            vector_id = f"{candidate_id}--{variant_id}"
            image_relative = Path("images") / f"{vector_id}.png"
            _render_profile(
                profile,
                staging_dir / image_relative,
                width=width,
                height=height,
                line_width=line_width,
                color=color,
            )
            vector_ids.append(vector_id)
            manifest.append(
                {
                    "vector_id": vector_id,
                    "sample_id": candidate_id,
                    "variant_id": variant_id,
                    "image_path": str((final_dir / image_relative).resolve()),
                    "svg_path": None,
                    "raw_path": str((final_dir / raw_relative).resolve()),
                    "metadata": metadata,
                }
            )
    (staging_dir / "manifest.jsonl").write_text(
        "".join(
            json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
            for record in manifest
        ),
        encoding="utf-8",
    )
    (staging_dir / "shared-training-snapshot.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "source": SHARED_SOURCE,
                "endpoint": endpoint,
                "candidate_count": len(candidates),
                "vector_count": len(vector_ids),
                "pages": pages,
                "privacy": {
                    "raw_images_included": False,
                    "original_filenames_included": False,
                    "canonical_curves_included": True,
                },
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return vector_ids


def sync_shared_training_corpus(
    output_dir: Path,
    *,
    endpoint: str = DEFAULT_SHARED_TRAINING_ENDPOINT,
    page_size: int = MAX_SHARED_PAGE_SIZE,
    timeout: float = 30.0,
    fetch_json: Optional[FetchJson] = None,
) -> dict[str, Any]:
    """Replace one derived local corpus with a complete server snapshot."""

    output_dir = output_dir.resolve()
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    snapshot = fetch_all_shared_candidates(
        endpoint,
        page_size=page_size,
        timeout=timeout,
        fetch_json=fetch_json,
    )
    staging_dir = Path(
        tempfile.mkdtemp(
            prefix=f".{output_dir.name}-sync-",
            dir=output_dir.parent,
        )
    )
    backup_dir = output_dir.with_name(f".{output_dir.name}-previous")
    try:
        vector_ids = _write_materialized_corpus(
            snapshot["candidates"],
            staging_dir,
            output_dir,
            endpoint,
            snapshot["pages"],
        )
        if backup_dir.exists():
            shutil.rmtree(backup_dir)
        if output_dir.exists():
            output_dir.rename(backup_dir)
        staging_dir.rename(output_dir)
        if backup_dir.exists():
            shutil.rmtree(backup_dir)
    except Exception:
        if staging_dir.exists():
            shutil.rmtree(staging_dir)
        if not output_dir.exists() and backup_dir.exists():
            backup_dir.rename(output_dir)
        raise
    return {
        "output_dir": str(output_dir),
        "manifest_path": str(output_dir / "manifest.jsonl"),
        "snapshot_path": str(output_dir / "shared-training-snapshot.json"),
        "candidate_count": snapshot["candidate_count"],
        "vector_count": len(vector_ids),
        "pages": snapshot["pages"],
        "raw_images_downloaded": 0,
        "original_filenames_stored": 0,
    }


def index_shared_training_corpus(
    corpus_dir: Path,
    index_path: Path,
) -> dict[str, Any]:
    """Upsert active shared vectors, then prune remotely deleted shared rows."""

    corpus_dir = corpus_dir.resolve()
    manifest_path = corpus_dir / "manifest.jsonl"
    retained_ids = {
        json.loads(line)["vector_id"]
        for line in manifest_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
    indexing = build_vector_index(corpus_dir, index_path.resolve(), clear=False)
    with SQLiteVectorStore(index_path.resolve()) as store:
        pruned = store.delete_source_except(SHARED_SOURCE, retained_ids)
        shared_vectors = sum(
            record.metadata.get("source") == SHARED_SOURCE for record in store.all_records()
        )
        total_vectors = store.count()
    return {
        **indexing,
        "shared_vectors": shared_vectors,
        "pruned_shared_vectors": pruned,
        "total_vectors": total_vectors,
    }
