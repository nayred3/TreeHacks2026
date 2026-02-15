"""
Project detections from image space to world coordinates.

Camera at (cx, cy) with heading (degrees). Detection bbox + distance
-> angle offset from optical axis -> world (x, y).
"""

import math
from typing import List, Tuple

from fusion.distance import distance_from_bbox
from fusion.schemas import CameraState, TrackDetection

DEFAULT_IMAGE_WIDTH = 640
DEFAULT_IMAGE_HEIGHT = 480


def bbox_center(bbox: List[float]) -> Tuple[float, float]:
    x1, y1, x2, y2 = bbox
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def image_offset_to_angle_rad(
    bbox: List[float],
    image_width: float = DEFAULT_IMAGE_WIDTH,
    focal_px: float = None,
) -> float:
    """
    Horizontal angle (radians) from camera optical axis to bbox center.
    Positive = target is to the right of center in image.
    """
    from fusion.distance import focal_length_px, DEFAULT_HFOV_DEG
    cx_img, _ = bbox_center(bbox)
    center_x = image_width / 2.0
    offset_px = cx_img - center_x
    if focal_px is None:
        focal_px = focal_length_px(int(image_width), DEFAULT_HFOV_DEG)
    return math.atan2(offset_px, focal_px)


def project_detection_to_world(
    detection: TrackDetection,
    camera: CameraState,
    image_width: int = DEFAULT_IMAGE_WIDTH,
    image_height: int = DEFAULT_IMAGE_HEIGHT,
) -> Tuple[float, float, float]:
    """
    Project one detection to world (x, y) in meters.
    Returns (world_x, world_y, confidence).
    """
    distance_m, _ = distance_from_bbox(
        detection.bbox,
        image_width=image_width,
        image_height=image_height,
    )
    angle_offset = image_offset_to_angle_rad(detection.bbox, float(image_width))
    heading_rad = math.radians(camera.heading)
    world_angle = heading_rad + angle_offset
    cam_x, cam_y = camera.position[0], camera.position[1]
    world_x = cam_x + distance_m * math.cos(world_angle)
    world_y = cam_y + distance_m * math.sin(world_angle)
    return (world_x, world_y, detection.confidence)


def _normalize_angle(angle_rad: float) -> float:
    """Wrap angle to [-pi, pi]."""
    while angle_rad > math.pi:
        angle_rad -= 2.0 * math.pi
    while angle_rad < -math.pi:
        angle_rad += 2.0 * math.pi
    return angle_rad


def world_position_to_bbox(
    world_x: float,
    world_y: float,
    camera: "CameraState",
    image_width: int = DEFAULT_IMAGE_WIDTH,
    image_height: int = DEFAULT_IMAGE_HEIGHT,
    person_height_m: float = 1.7,
) -> List[float]:
    """
    Inverse of project_detection_to_world: given world (x,y), compute pixel bbox
    that would be seen by the camera. Returns [x1, y1, x2, y2].
    Uses horizontal focal for x-offset, vertical focal for bbox height (consistent with distance_from_bbox).
    """
    from fusion.distance import focal_length_px, focal_length_px_vertical, DEFAULT_HFOV_DEG
    cam_x, cam_y = camera.position[0], camera.position[1]
    dx = world_x - cam_x
    dy = world_y - cam_y
    distance_m = math.sqrt(dx * dx + dy * dy)
    if distance_m < 0.1:
        distance_m = 0.1
    world_angle = math.atan2(dy, dx)
    heading_rad = math.radians(camera.heading)
    angle_offset = _normalize_angle(world_angle - heading_rad)
    focal_h = focal_length_px(image_width, DEFAULT_HFOV_DEG)
    focal_v = focal_length_px_vertical(image_width, image_height, DEFAULT_HFOV_DEG)
    offset_px = focal_h * math.tan(angle_offset)
    center_x = image_width / 2.0 + offset_px
    center_y = image_height / 2.0
    height_px = person_height_m * focal_v / distance_m
    width_px = 50.0
    x1 = center_x - width_px / 2
    y1 = center_y - height_px / 2
    x2 = center_x + width_px / 2
    y2 = center_y + height_px / 2
    return [x1, y1, x2, y2]
