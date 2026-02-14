"""
Distance estimation from bounding box (bbox-height heuristic).

Assumes pinhole camera: distance = (real_height * focal_length_px) / bbox_height_px.
Typical standing person height ~1.7 m.
"""

import math
from typing import List, Tuple

# Default: assume 640x480-style feed, ~60 deg horizontal FOV
DEFAULT_IMAGE_WIDTH = 640
DEFAULT_IMAGE_HEIGHT = 480
DEFAULT_HFOV_DEG = 60.0
DEFAULT_PERSON_HEIGHT_M = 1.7


def focal_length_px(image_width: int, hfov_deg: float) -> float:
    """Focal length in pixels (horizontal) from image width and horizontal FOV (degrees)."""
    hfov_rad = math.radians(hfov_deg)
    return image_width / (2.0 * math.tan(hfov_rad / 2.0))


def focal_length_px_vertical(
    image_width: int,
    image_height: int,
    hfov_deg: float = DEFAULT_HFOV_DEG,
) -> float:
    """
    Vertical focal length in pixels. Use for distance-from-bbox-height.
    Derived from horizontal FOV and aspect ratio (same physical focal length).
    """
    hfov_rad = math.radians(hfov_deg)
    tan_half_h = math.tan(hfov_rad / 2.0)
    # vfov from aspect: tan(vfov/2) = tan(hfov/2) * (height/width)
    tan_half_v = tan_half_h * (image_height / image_width)
    return image_height / (2.0 * tan_half_v)


def distance_from_bbox(
    bbox: List[float],
    person_height_m: float = DEFAULT_PERSON_HEIGHT_M,
    focal_px: float = None,
    image_width: int = DEFAULT_IMAGE_WIDTH,
    image_height: int = DEFAULT_IMAGE_HEIGHT,
    hfov_deg: float = DEFAULT_HFOV_DEG,
) -> Tuple[float, float]:
    """
    Estimate distance (meters) and uncertainty from bbox [x1,y1,x2,y2].
    Uses vertical focal length (bbox height is vertical in image).
    Returns (distance_m, uncertainty_m). Uncertainty is rough (e.g. scale with distance).
    """
    x1, y1, x2, y2 = bbox
    bbox_height_px = max(abs(y2 - y1), 1.0)
    if focal_px is None:
        focal_px = focal_length_px_vertical(image_width, image_height, hfov_deg)
    distance_m = (person_height_m * focal_px) / bbox_height_px
    # Simple uncertainty: larger at distance (e.g. 10% + 0.5m)
    uncertainty_m = distance_m * 0.15 + 0.3
    return (distance_m, uncertainty_m)
