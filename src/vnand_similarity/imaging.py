"""Rendering, augmentation, and graph-region standardization."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import cv2
import matplotlib

matplotlib.use("Agg")

import numpy as np
from matplotlib import pyplot as plt
from PIL import Image

from .synthetic import DEFAULT_LOG_Y_FLOOR, SyntheticVthSample

STANDARD_WIDTH = 256
STANDARD_HEIGHT = 128


@dataclass(frozen=True)
class PreprocessResult:
    mask: np.ndarray
    crop_box: tuple[int, int, int, int]
    diagnostics: dict[str, Any]


def _palette(rng: np.random.Generator, colored: bool) -> list:
    if not colored:
        shade = float(rng.uniform(0.02, 0.18))
        return [(shade, shade, shade)]
    palettes = [
        ["#175cd3", "#0e9384", "#dc6803", "#d92d20", "#6938ef"],
        ["#111827", "#374151", "#6b7280", "#9ca3af"],
        ["#004e98", "#3a6ea5", "#ff6700", "#c0c0c0"],
    ]
    return list(palettes[int(rng.integers(0, len(palettes)))])


def render_vth_graph(
    sample: SyntheticVthSample,
    output_path: Path,
    *,
    rng: np.random.Generator,
    svg_path: Optional[Path] = None,
    axes: bool = False,
    colored: bool = False,
    filled: bool = False,
    grid: bool = False,
    dpi: int = 120,
) -> None:
    """Render overlap-free state curves on the production log10 y scale."""

    output_path.parent.mkdir(parents=True, exist_ok=True)
    width = float(rng.uniform(5.2, 7.2))
    height = float(rng.uniform(2.4, 3.7))
    fig, axis = plt.subplots(figsize=(width, height), dpi=dpi)
    background = float(rng.uniform(0.96, 1.0))
    fig.patch.set_facecolor((background, background, background))
    axis.set_facecolor((background, background, background))

    colors = _palette(rng, colored)
    linewidth = float(rng.uniform(1.5, 3.2))
    y_floor = float(sample.metadata.get("y_floor", DEFAULT_LOG_Y_FLOOR))
    for state_index, curve in enumerate(sample.exclusive_curves):
        visible = curve >= y_floor
        if not np.any(visible):
            continue
        color = colors[state_index % len(colors)]
        plotted_curve = np.where(visible, curve, np.nan)
        axis.plot(
            sample.x,
            plotted_curve,
            color=color,
            linewidth=linewidth,
            solid_capstyle="round",
        )
        if filled:
            fill_curve = np.maximum(curve, y_floor)
            axis.fill_between(
                sample.x,
                y_floor,
                fill_curve,
                where=visible,
                color=color,
                alpha=float(rng.uniform(0.12, 0.28)),
            )

    axis.set_xlim(0.0, 1.0)
    axis.set_yscale("log", base=10)
    axis.set_ylim(y_floor, 1.08)
    if axes:
        axis.set_xlabel("Vth")
        axis.set_ylabel("Cell count (log)")
        if grid:
            axis.grid(True, which="both", alpha=0.18, linewidth=0.65)
    else:
        axis.axis("off")
        fig.subplots_adjust(left=0, right=1, bottom=0, top=1)

    save_kwargs = {"facecolor": fig.get_facecolor()}
    fig.savefig(output_path, **save_kwargs)
    if svg_path is not None:
        svg_path.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(svg_path, format="svg", **save_kwargs)
    plt.close(fig)


def augment_graph_image(
    source_path: Path,
    destination_path: Path,
    *,
    rng: np.random.Generator,
) -> dict[str, Any]:
    """Apply mild screenshot/scan-like transformations without changing semantics."""

    image = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Unable to read image: {source_path}")
    height, width = image.shape[:2]

    angle = float(rng.uniform(-1.2, 1.2))
    scale = float(rng.uniform(0.94, 1.04))
    transform = cv2.getRotationMatrix2D((width / 2, height / 2), angle, scale)
    border = tuple(int(value) for value in np.median(image.reshape(-1, 3), axis=0))
    image = cv2.warpAffine(
        image,
        transform,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=border,
    )

    blur_sigma: Optional[float] = None
    if rng.random() < 0.55:
        blur_sigma = float(rng.uniform(0.2, 0.9))
        image = cv2.GaussianBlur(image, (0, 0), blur_sigma)
    noise_sigma: Optional[float] = None
    if rng.random() < 0.65:
        noise_sigma = float(rng.uniform(0.8, 3.0))
        noise = rng.normal(0.0, noise_sigma, image.shape)
        image = np.clip(image.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    jpeg_quality: Optional[int] = None
    if rng.random() < 0.5:
        jpeg_quality = int(rng.integers(62, 93))
        success, encoded = cv2.imencode(
            ".jpg",
            image,
            [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality],
        )
        if success:
            image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)

    destination_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(destination_path), image):
        raise ValueError(f"Unable to write image: {destination_path}")
    return {
        "rotation_degrees": angle,
        "scale": scale,
        "blur_sigma": blur_sigma,
        "noise_sigma": noise_sigma,
        "jpeg_quality": jpeg_quality,
    }


def _foreground_from_border(image: np.ndarray) -> np.ndarray:
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB).astype(np.float32)
    border = np.concatenate(
        [rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]],
        axis=0,
    )
    background = np.median(border, axis=0)
    distance = np.linalg.norm(rgb - background, axis=2)
    scaled = np.clip(distance, 0, 255).astype(np.uint8)
    threshold, _ = cv2.threshold(scaled, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Log-scale plots often use very light gray state curves and translucent
    # fills. A conservative fraction of Otsu keeps those tails while the later
    # frame/grid/component filters remove the additional low-contrast ink.
    threshold = max(7.0, float(threshold) * 0.42)
    return (distance >= threshold).astype(np.uint8)


def _content_box(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    height, width = mask.shape
    if len(xs) == 0:
        return (0, 0, width, height)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def _deskew_mask(mask: np.ndarray) -> tuple[np.ndarray, float]:
    height, width = mask.shape
    edges = cv2.Canny((mask * 255).astype(np.uint8), 40, 120)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 720,
        threshold=max(24, width // 10),
        minLineLength=max(30, int(width * 0.28)),
        maxLineGap=max(8, int(width * 0.04)),
    )
    if lines is None:
        return mask, 0.0

    angles = []
    for line in lines[:, 0]:
        x1, y1, x2, y2 = (int(value) for value in line)
        angle = float(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
        if abs(angle) <= 5.0:
            angles.append(angle)
    if not angles:
        return mask, 0.0

    angle = float(np.median(angles))
    if abs(angle) < 0.08:
        return mask, angle
    transform = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
    deskewed = cv2.warpAffine(
        mask,
        transform,
        (width, height),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    return deskewed, angle


def _line_centers(indices: np.ndarray) -> list[int]:
    if len(indices) == 0:
        return []
    groups = np.split(indices, np.flatnonzero(np.diff(indices) > 1) + 1)
    return [int(np.round(np.mean(group))) for group in groups if len(group)]


def _hough_frame_box(mask: np.ndarray) -> Optional[tuple[int, int, int, int]]:
    height, width = mask.shape
    edges = cv2.Canny((mask * 255).astype(np.uint8), 40, 120)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 720,
        threshold=max(30, min(height, width) // 6),
        minLineLength=max(30, int(min(height, width) * 0.34)),
        maxLineGap=max(10, int(min(height, width) * 0.05)),
    )
    if lines is None:
        return None

    horizontal_positions = []
    vertical_positions = []
    for line in lines[:, 0]:
        x1, y1, x2, y2 = (int(value) for value in line)
        dx = abs(x2 - x1)
        dy = abs(y2 - y1)
        if dx >= width * 0.38 and dy <= height * 0.025:
            horizontal_positions.append(round((y1 + y2) / 2))
        if dy >= height * 0.52 and dx <= width * 0.025:
            vertical_positions.append(round((x1 + x2) / 2))

    if len(horizontal_positions) < 2 or len(vertical_positions) < 2:
        return None
    top, bottom = min(horizontal_positions), max(horizontal_positions)
    left, right = min(vertical_positions), max(vertical_positions)
    if right - left <= width * 0.35 or bottom - top <= height * 0.3:
        return None
    return (left + 1, top + 1, right, bottom)


def _hough_l_axis_box(mask: np.ndarray) -> Optional[tuple[int, int, int, int]]:
    """Detect an open L-shaped plot frame common in patent drawings.

    Publication figures frequently omit the top and right spines, so a
    rectangle-only detector falls back to the full ink bounding box and keeps
    titles, legends, and State labels.  A long left y-axis intersecting one or
    more horizontal grid/baseline lines is sufficient to recover the plot
    interior.
    """

    height, width = mask.shape
    if max(height, width) < 800:
        return None
    edges = cv2.Canny((mask * 255).astype(np.uint8), 40, 120)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 720,
        threshold=max(24, min(height, width) // 8),
        minLineLength=max(28, int(min(height, width) * 0.28)),
        maxLineGap=max(10, int(min(height, width) * 0.06)),
    )
    if lines is None:
        return None

    horizontal_lines = []
    vertical_lines = []
    for line in lines[:, 0]:
        x1, y1, x2, y2 = (int(value) for value in line)
        dx = abs(x2 - x1)
        dy = abs(y2 - y1)
        if dx >= width * 0.42 and dy <= height * 0.025:
            horizontal_lines.append((min(x1, x2), round((y1 + y2) / 2), max(x1, x2)))
        if dy >= height * 0.42 and dx <= width * 0.025:
            vertical_lines.append((round((x1 + x2) / 2), min(y1, y2), max(y1, y2)))
    if not horizontal_lines or not vertical_lines:
        return None

    tolerance_x = max(8, int(width * 0.035))
    tolerance_y = max(8, int(height * 0.035))
    candidates = []
    for x_position, y_start, y_stop in vertical_lines:
        if not (width * 0.015 <= x_position <= width * 0.48):
            continue
        intersecting = [
            horizontal
            for horizontal in horizontal_lines
            if horizontal[0] - tolerance_x <= x_position <= horizontal[2] + tolerance_x
            and y_start - tolerance_y <= horizontal[1] <= y_stop + tolerance_y
        ]
        if not intersecting:
            continue
        top = y_start
        bottom = max(horizontal[1] for horizontal in intersecting)
        right = max(horizontal[2] for horizontal in intersecting)
        plot_width = right - x_position
        plot_height = bottom - top
        if plot_width <= width * 0.35 or plot_height <= height * 0.28:
            continue
        candidates.append(
            (
                plot_width * plot_height,
                (x_position + 1, max(0, top), min(width, right), min(height, bottom)),
            )
        )
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[0])[1]


def _detect_frame_from_image(
    image: np.ndarray,
    *,
    deskew_angle: float,
) -> Optional[tuple[int, int, int, int]]:
    """Detect the plot rectangle from dark axis spines in the source image."""

    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if abs(deskew_angle) >= 0.08:
        transform = cv2.getRotationMatrix2D(
            (width / 2, height / 2),
            deskew_angle,
            1.0,
        )
        gray = cv2.warpAffine(
            gray,
            transform,
            (width, height),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=int(np.median(gray)),
        )
    edges = cv2.Canny(gray, 40, 140)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 720,
        threshold=max(30, min(height, width) // 6),
        minLineLength=max(30, int(min(height, width) * 0.3)),
        maxLineGap=max(10, int(min(height, width) * 0.08)),
    )
    if lines is None:
        return None

    horizontal_lines = []
    vertical_lines = []
    for line in lines[:, 0]:
        x1, y1, x2, y2 = (int(value) for value in line)
        dx = abs(x2 - x1)
        dy = abs(y2 - y1)
        if dx >= width * 0.35 and dy <= height * 0.035:
            horizontal_lines.append((x1, y1, x2, y2))
        if dy >= height * 0.38 and dx <= width * 0.04:
            vertical_lines.append((x1, y1, x2, y2))
    if len(horizontal_lines) < 2 or len(vertical_lines) < 2:
        return None

    horizontal_margin = max(4, int(height * 0.04))
    horizontal_positions = [
        round((line[1] + line[3]) / 2)
        for line in horizontal_lines
        if horizontal_margin
        <= round((line[1] + line[3]) / 2)
        <= height - horizontal_margin
    ]
    if len(horizontal_positions) < 2:
        return None
    top, bottom = min(horizontal_positions), max(horizontal_positions)
    plot_height = bottom - top
    if plot_height <= height * 0.3:
        return None

    tolerance = max(5, int(plot_height * 0.09))
    # Rotation/deskew can introduce long vertical border edges a few pixels
    # inside the canvas. They are not plot spines and would otherwise expand
    # the crop to include tick labels and create false peaks.
    side_margin = max(4, int(width * 0.03))
    full_boundary_verticals = []
    partial_boundary_verticals = []
    for x1, y1, x2, y2 in vertical_lines:
        line_top, line_bottom = min(y1, y2), max(y1, y2)
        x_position = round((x1 + x2) / 2)
        spans_plot_boundaries = (
            line_top <= top + tolerance
            and line_bottom >= bottom - tolerance
        )
        touches_plot_boundary = (
            line_top <= top + tolerance
            or line_bottom >= bottom - tolerance
        )
        inside_canvas_border = side_margin <= x_position <= width - side_margin
        if not inside_canvas_border:
            continue
        if spans_plot_boundaries:
            full_boundary_verticals.append(x_position)
        elif touches_plot_boundary:
            partial_boundary_verticals.append(x_position)
    # Repeated log tick labels can align into a long Hough segment that touches
    # only the bottom of the plot. Prefer spines that reach both horizontal
    # frame boundaries; fall back to partial lines only for genuinely broken
    # publication frames.
    boundary_verticals = (
        full_boundary_verticals + partial_boundary_verticals
    )
    # Keep broken spines at the true outer edge, but reject an isolated partial
    # segment that sits a modest distance outside a repeatedly detected full
    # spine. Aligned log tick labels have exactly this geometry. A 1–2 px
    # companion edge remains part of the frame and must not be discarded.
    if full_boundary_verticals and partial_boundary_verticals:
        cluster_radius = max(2, int(width * 0.004))
        minimum_outlier_gap = width * 0.025
        maximum_outlier_gap = width * 0.08

        left_edge = min(boundary_verticals)
        left_full = min(
            (
                x_position
                for x_position in full_boundary_verticals
                if x_position > left_edge
            ),
            default=left_edge,
        )
        left_support = sum(
            abs(x_position - left_full) <= cluster_radius
            for x_position in full_boundary_verticals
        )
        left_gap = left_full - left_edge
        if (
            left_edge in partial_boundary_verticals
            and minimum_outlier_gap <= left_gap <= maximum_outlier_gap
            and left_support >= 2
        ):
            boundary_verticals = [
                x_position
                for x_position in boundary_verticals
                if x_position >= left_full
            ]

        right_edge = max(boundary_verticals)
        right_full = max(
            (
                x_position
                for x_position in full_boundary_verticals
                if x_position < right_edge
            ),
            default=right_edge,
        )
        right_support = sum(
            abs(x_position - right_full) <= cluster_radius
            for x_position in full_boundary_verticals
        )
        right_gap = right_edge - right_full
        if (
            right_edge in partial_boundary_verticals
            and minimum_outlier_gap <= right_gap <= maximum_outlier_gap
            and right_support >= 2
        ):
            boundary_verticals = [
                x_position
                for x_position in boundary_verticals
                if x_position <= right_full
            ]
    if len(boundary_verticals) < 2:
        return None

    left, right = min(boundary_verticals), max(boundary_verticals)
    if right - left <= width * 0.35:
        return None
    return (left + 1, top + 1, right, bottom)


def _detect_plot_box(mask: np.ndarray) -> tuple[tuple[int, int, int, int], bool]:
    height, width = mask.shape
    bbox = _content_box(mask)
    hough_box = _hough_frame_box(mask)
    if hough_box is not None:
        return hough_box, True
    l_axis_box = _hough_l_axis_box(mask)
    if l_axis_box is not None:
        return l_axis_box, True

    row_coverage = mask.mean(axis=1)
    col_coverage = mask.mean(axis=0)

    horizontal = np.flatnonzero(row_coverage > 0.32)
    vertical = np.flatnonzero(col_coverage > 0.32)
    horizontal_centers = _line_centers(horizontal)
    vertical_centers = _line_centers(vertical)

    if len(horizontal_centers) >= 2 and len(vertical_centers) >= 2:
        top, bottom = horizontal_centers[0], horizontal_centers[-1]
        left, right = vertical_centers[0], vertical_centers[-1]
        if right - left > width * 0.35 and bottom - top > height * 0.3:
            return (left + 1, top + 1, right, bottom), True

    lower_rows = horizontal[horizontal > int(height * 0.48)]
    left_cols = vertical[vertical < int(width * 0.48)]

    if len(lower_rows) and len(left_cols):
        bottom = int(lower_rows[-1])
        left = int(left_cols[0])
        right = max(bbox[2], left + 16)
        top = min(bbox[1], bottom - 16)
        candidate = (left + 1, max(0, top), min(width, right), max(top + 1, bottom))
        candidate_width = candidate[2] - candidate[0]
        candidate_height = candidate[3] - candidate[1]
        if candidate_width > width * 0.35 and candidate_height > height * 0.3:
            return candidate, True
    return bbox, False


def _remove_straight_lines(mask: np.ndarray) -> np.ndarray:
    height, width = mask.shape
    cleaned = mask.copy()
    # A long-kernel morphological opening also classifies every scanline of a
    # filled distribution as a grid line. Remove only thin, high-coverage row
    # and column bands; broad contiguous bands are data fills and must survive.
    row_indices = np.flatnonzero(mask.mean(axis=1) > 0.52)
    row_groups = (
        np.split(row_indices, np.flatnonzero(np.diff(row_indices) > 1) + 1)
        if len(row_indices)
        else []
    )
    for group in row_groups:
        if len(group) <= max(4, int(height * 0.018)):
            start = max(0, int(group[0]) - 1)
            stop = min(height, int(group[-1]) + 2)
            cleaned[start:stop] = 0

    column_indices = np.flatnonzero(mask.mean(axis=0) > 0.58)
    column_groups = (
        np.split(column_indices, np.flatnonzero(np.diff(column_indices) > 1) + 1)
        if len(column_indices)
        else []
    )
    for group in column_groups:
        if len(group) <= max(4, int(width * 0.012)):
            start = max(0, int(group[0]) - 1)
            stop = min(width, int(group[-1]) + 2)
            cleaned[:, start:stop] = 0

    edges = cv2.Canny((cleaned * 255).astype(np.uint8), 40, 120)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 360,
        threshold=max(18, min(height, width) // 8),
        minLineLength=max(20, int(min(height, width) * 0.35)),
        maxLineGap=max(6, int(min(height, width) * 0.03)),
    )
    if lines is None:
        return cleaned

    thickness = max(2, round(min(height, width) * 0.009))
    for line in lines[:, 0]:
        x1, y1, x2, y2 = (int(value) for value in line)
        dx = abs(x2 - x1)
        dy = abs(y2 - y1)
        is_horizontal = dx >= width * 0.72 and dy <= height * 0.025
        is_vertical = (
            dy >= height * 0.58
            and dx <= width * 0.014
        )
        if is_horizontal or is_vertical:
            cv2.line(cleaned, (x1, y1), (x2, y2), color=0, thickness=thickness)
    return cleaned


def _remove_small_components(mask: np.ndarray) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    minimum_area = max(5, int(mask.size * 0.00008))
    cleaned = np.zeros_like(mask)
    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        component_width = int(stats[label, cv2.CC_STAT_WIDTH])
        if area >= minimum_area or component_width >= max(8, mask.shape[1] // 35):
            cleaned[labels == label] = 1
    return cleaned


def _remove_text_like_components(mask: np.ndarray) -> np.ndarray:
    """Discard detached labels while preserving State curves and long tails."""

    height, width = mask.shape
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    cleaned = np.zeros_like(mask)
    for label in range(1, count):
        y = int(stats[label, cv2.CC_STAT_TOP])
        component_width = int(stats[label, cv2.CC_STAT_WIDTH])
        component_height = int(stats[label, cv2.CC_STAT_HEIGHT])
        area = int(stats[label, cv2.CC_STAT_AREA])
        bottom = y + component_height

        spans_curve_height = component_height >= height * 0.14
        reaches_tail_region = bottom >= height * 0.58
        spans_state_width = component_width >= max(8, int(width * 0.025))
        long_trace = component_width >= width * 0.18
        dense_enough = area >= max(6, int(mask.size * 0.00008))
        if dense_enough and (
            long_trace
            or (spans_curve_height and reaches_tail_region and spans_state_width)
        ):
            cleaned[labels == label] = 1
    return cleaned


def _canonical_curve_mask(mask: np.ndarray) -> np.ndarray:
    """Convert line or filled plots into one style-independent upper envelope."""

    height, width = mask.shape
    band_height = max(1, height // 6)
    top_occupancy = float(mask[:band_height].mean())
    bottom_occupancy = float(mask[-band_height:].mean())
    dense_region = float(mask.mean()) > 0.12
    # If foreground estimation selected a light unfilled region above a
    # colored fill, the physical curve is its lower boundary. If it selected
    # the fill itself, or a sparse line plot, the curve is the upper boundary.
    boundary_quantile = (
        0.94
        if (
            dense_region
            and top_occupancy > 0.55
            and top_occupancy > bottom_occupancy * 1.12
        )
        else 0.06
    )
    y_positions = np.full(width, height - 1, dtype=np.float32)
    for column in range(width):
        values = mask[:, column]
        active = np.flatnonzero(values >= max(0.12, float(values.max()) * 0.28))
        if len(active):
            y_positions[column] = float(np.quantile(active, boundary_quantile))

    y_positions = cv2.medianBlur(y_positions.reshape(1, -1), 5).reshape(-1)
    points = np.column_stack(
        [
            np.arange(width, dtype=np.int32),
            np.clip(np.round(y_positions), 0, height - 1).astype(np.int32),
        ]
    )
    canonical = np.zeros((height, width), dtype=np.uint8)
    cv2.polylines(canonical, [points], isClosed=False, color=1, thickness=2)
    return cv2.GaussianBlur(canonical.astype(np.float32), (3, 3), 0.45)


def _should_extract_filled_edges(
    *,
    foreground_density: float,
    edge_density: float,
    edge_pixel_count: int,
    edge_x_coverage: float,
) -> bool:
    """Distinguish filled regions from dense marker-and-line plots."""

    edge_to_foreground_ratio = edge_density / max(
        foreground_density,
        np.finfo(float).eps,
    )
    return (
        foreground_density >= 0.12
        and edge_to_foreground_ratio <= 0.54
        and edge_pixel_count >= 12
        and edge_x_coverage >= 0.45
    )


def standardize_graph_image(
    image_path: Path,
    *,
    preview_path: Optional[Path] = None,
    preserve_plot_coordinates: bool = True,
    extraction_preference: str = "auto",
) -> PreprocessResult:
    """Extract graph ink, remove axes, and normalize scale and resolution."""

    if extraction_preference not in {"auto", "aggressive-edge"}:
        raise ValueError(f"Unsupported extraction preference: {extraction_preference}")
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Unable to read image: {image_path}")
    foreground = _foreground_from_border(image)
    foreground, deskew_angle = _deskew_mask(foreground)
    image_frame_box = _detect_frame_from_image(
        image,
        deskew_angle=deskew_angle,
    )
    if image_frame_box is not None:
        plot_box, axes_detected = image_frame_box, True
        plot_box_source = "image-frame"
    else:
        plot_box, axes_detected = _detect_plot_box(foreground)
        plot_box_source = "foreground-frame" if axes_detected else "content-bounds"
    left, top, right, bottom = plot_box
    cropped = foreground[top:bottom, left:right]
    if cropped.size == 0:
        raise ValueError(f"No graph region found in: {image_path}")

    aligned_image = image
    if abs(deskew_angle) >= 0.08:
        height, width = image.shape[:2]
        transform = cv2.getRotationMatrix2D(
            (width / 2, height / 2),
            deskew_angle,
            1.0,
        )
        border_color = tuple(
            int(value) for value in np.median(image.reshape(-1, 3), axis=0)
        )
        aligned_image = cv2.warpAffine(
            image,
            transform,
            (width, height),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=border_color,
        )
    source_crop = aligned_image[top:bottom, left:right]
    gray_crop = cv2.cvtColor(source_crop, cv2.COLOR_BGR2GRAY)
    edge_mask = (cv2.Canny(gray_crop, 20, 90) > 0).astype(np.uint8)
    border_rows = 0
    border_columns = 0
    if plot_box_source == "image-frame":
        # Hough lines describe the spine center, and antialiasing can leave a
        # few spine pixels just inside the returned rectangle.  Those pixels
        # are especially destructive when broad low-State curves peak near
        # the top frame: the residual horizontal line bridges every valley.
        border_rows = max(2, round(cropped.shape[0] * 0.008))
        border_columns = max(2, round(cropped.shape[1] * 0.004))
        cropped[:border_rows, :] = 0
        cropped[-border_rows:, :] = 0
        cropped[:, :border_columns] = 0
        cropped[:, -border_columns:] = 0
        edge_mask[:border_rows, :] = 0
        edge_mask[-border_rows:, :] = 0
        edge_mask[:, :border_columns] = 0
        edge_mask[:, -border_columns:] = 0
    aggressive_horizontal_pixels = 0
    if extraction_preference == "aggressive-edge":
        horizontal_kernel = np.ones(
            (1, max(9, round(edge_mask.shape[1] * 0.25))),
            dtype=np.uint8,
        )
        horizontal_lines = cv2.morphologyEx(
            edge_mask,
            cv2.MORPH_OPEN,
            horizontal_kernel,
        )
        aggressive_horizontal_pixels = int(horizontal_lines.sum())
        edge_mask[horizontal_lines > 0] = 0
    edge_cleaned = _remove_small_components(_remove_straight_lines(edge_mask))
    foreground_cleaned = _remove_small_components(_remove_straight_lines(cropped))
    # Sparse patent line drawings leave labels as detached components. Dense
    # scanned/hatch plots fragment the real curves into many components, so
    # applying the same label filter there would erase valid State traces.
    # A reliable four-sided image frame has already excluded tick labels and
    # titles.  Running the detached-label filter inside that frame is harmful:
    # overlap-free VTH states are intentionally disconnected components and
    # narrow states can look exactly like text fragments.  Keep the filter for
    # weaker foreground/content crops where labels may still be present.
    remove_detached_labels = (
        plot_box_source != "image-frame"
        and axes_detected
        and float(foreground_cleaned.mean()) <= 0.032
    )
    if remove_detached_labels:
        edge_cleaned = _remove_text_like_components(edge_cleaned)
        foreground_cleaned = _remove_text_like_components(foreground_cleaned)
    edge_x_coverage = float(np.mean(np.any(edge_cleaned > 0, axis=0)))
    foreground_density = float(foreground_cleaned.mean())
    edge_density = float(edge_cleaned.mean())
    edge_to_foreground_ratio = edge_density / max(
        foreground_density,
        np.finfo(float).eps,
    )
    # Dense fills contain much more foreground area than edge ink. Publication
    # plots with many line markers can be similarly dense, but their
    # edge/foreground ratio stays high. Use both signals so PNG, resized, and
    # grayscale JPEG variants of the same line plot follow one extraction path.
    if extraction_preference == "aggressive-edge":
        cleaned = edge_cleaned
        extraction_mode = "aggressive-edge-grid-clean"
    elif _should_extract_filled_edges(
        foreground_density=foreground_density,
        edge_density=edge_density,
        edge_pixel_count=int(edge_cleaned.sum()),
        edge_x_coverage=edge_x_coverage,
    ):
        cleaned = edge_cleaned
        extraction_mode = "source-edge-filled"
    elif int(foreground_cleaned.sum()) >= 12:
        cleaned = foreground_cleaned
        extraction_mode = "foreground-region"
    else:
        cleaned = cropped
        extraction_mode = "foreground-fallback"

    # The detected image frame is the authoritative plot coordinate system.
    # Cropping once more to the ink bounds would translate edge states and
    # stretch valley depth to the deepest visible tail, discarding the fixed
    # log-y range that the frame already preserves.
    if plot_box_source == "image-frame" and preserve_plot_coordinates:
        content_left, content_top = 0, 0
        content_right, content_bottom = cleaned.shape[1], cleaned.shape[0]
        plot_coordinates_preserved = True
    else:
        content_left, content_top, content_right, content_bottom = _content_box(cleaned)
        plot_coordinates_preserved = False
    cleaned = cleaned[content_top:content_bottom, content_left:content_right]
    if cleaned.size == 0:
        raise ValueError(f"No curve pixels found in: {image_path}")

    normalized = cv2.resize(
        cleaned.astype(np.float32),
        (STANDARD_WIDTH, STANDARD_HEIGHT),
        interpolation=cv2.INTER_AREA,
    )
    normalized = np.clip(normalized, 0.0, 1.0)
    normalized = _canonical_curve_mask(normalized)

    if preview_path is not None:
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        preview = (255.0 * (1.0 - normalized)).astype(np.uint8)
        Image.fromarray(preview).save(preview_path)

    diagnostics: dict[str, Any] = {
        "source_width": int(image.shape[1]),
        "source_height": int(image.shape[0]),
        "axes_detected": axes_detected,
        "plot_box_source": plot_box_source,
        "plot_coordinates_preserved": plot_coordinates_preserved,
        "plot_coordinate_preservation_requested": preserve_plot_coordinates,
        "detached_label_filter_applied": remove_detached_labels,
        "frame_border_rows_removed": border_rows,
        "frame_border_columns_removed": border_columns,
        "extraction_preference": extraction_preference,
        "aggressive_horizontal_pixels_removed": aggressive_horizontal_pixels,
        "deskew_angle_degrees": deskew_angle,
        "y_scale_assumption": "log10",
        "foreground_ratio": float(normalized.mean()),
        "curve_extraction_mode": extraction_mode,
        "edge_x_coverage": edge_x_coverage,
        "edge_density": edge_density,
        "foreground_density": foreground_density,
        "edge_to_foreground_ratio": edge_to_foreground_ratio,
        "standard_width": STANDARD_WIDTH,
        "standard_height": STANDARD_HEIGHT,
    }
    return PreprocessResult(
        mask=normalized,
        crop_box=(
            left + content_left,
            top + content_top,
            left + content_right,
            top + content_bottom,
        ),
        diagnostics=diagnostics,
    )
