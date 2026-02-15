"""
Camera-based position estimator.

Given:
  - camera location  (x, y) in metres, world coordinates
  - camera heading   (degrees, 0 = +x, 90 = +y)
  - person bounding box  [x1, y1, x2, y2] in image pixels
  - (optional) camera FOV, image dims

Produces:
  - estimated world position (x, y) of that person
  - estimated distance (metres)
  - uncertainty estimate

This is the "brain" that replaces random dot movement: real camera
detections go in, map positions come out.
"""

import math
from dataclasses import dataclass
from typing import List, Optional, Tuple

from fusion.distance import (
    DEFAULT_HFOV_DEG,
    DEFAULT_IMAGE_HEIGHT,
    DEFAULT_IMAGE_WIDTH,
    DEFAULT_PERSON_HEIGHT_M,
    distance_from_bbox,
    focal_length_px,
    focal_length_px_vertical,
)


@dataclass
class CameraConfig:
    """Everything we know about a camera's extrinsics / intrinsics."""
    camera_id: str
    x: float                # world x (metres)
    y: float                # world y (metres)
    heading_deg: float      # 0 = +x, 90 = +y
    hfov_deg: float = DEFAULT_HFOV_DEG
    image_width: int = DEFAULT_IMAGE_WIDTH
    image_height: int = DEFAULT_IMAGE_HEIGHT


@dataclass
class PositionEstimate:
    """Result of estimating where a person is on the map."""
    world_x: float
    world_y: float
    distance_m: float
    uncertainty_m: float
    bearing_deg: float       # absolute bearing from camera to person
    angle_in_fov_deg: float  # offset from camera centre axis (-fov/2 .. +fov/2)
    bbox: List[float]        # the input bbox, kept for reference
    camera_id: str


def estimate_position(
    camera: CameraConfig,
    bbox: List[float],
    person_height_m: float = DEFAULT_PERSON_HEIGHT_M,
) -> PositionEstimate:
    """
    Core estimator: camera config + bounding box -> world position.

    Algorithm
    ---------
    1. Estimate distance from bbox height using pinhole model.
    2. Compute horizontal angle offset from camera optical axis.
    3. Add camera heading to get absolute world bearing.
    4. Project to (x, y) = camera_pos + distance * (cos, sin)(bearing).
    """
    # --- Step 1: distance from bbox height ---
    dist_m, uncertainty_m = distance_from_bbox(
        bbox,
        person_height_m=person_height_m,
        image_width=camera.image_width,
        image_height=camera.image_height,
        hfov_deg=camera.hfov_deg,
    )

    # --- Step 2: horizontal angle offset ---
    x1, y1, x2, y2 = bbox
    bbox_cx = (x1 + x2) / 2.0
    center_x = camera.image_width / 2.0
    offset_px = bbox_cx - center_x
    f_h = focal_length_px(camera.image_width, camera.hfov_deg)
    angle_offset_rad = math.atan2(-offset_px, f_h)

    # --- Step 3: world bearing ---
    heading_rad = math.radians(camera.heading_deg)
    world_bearing_rad = heading_rad + angle_offset_rad

    # --- Step 4: project to world ---
    world_x = camera.x + dist_m * math.cos(world_bearing_rad)
    world_y = camera.y + dist_m * math.sin(world_bearing_rad)

    return PositionEstimate(
        world_x=world_x,
        world_y=world_y,
        distance_m=dist_m,
        uncertainty_m=uncertainty_m,
        bearing_deg=math.degrees(world_bearing_rad) % 360,
        angle_in_fov_deg=math.degrees(angle_offset_rad),
        bbox=list(bbox),
        camera_id=camera.camera_id,
    )


def is_in_fov(
    camera: CameraConfig,
    world_x: float,
    world_y: float,
    max_range: float = 8.0,
) -> bool:
    """Check whether a world point falls inside the camera's field of view."""
    dx = world_x - camera.x
    dy = world_y - camera.y
    dist = math.sqrt(dx * dx + dy * dy)
    if dist > max_range:
        return False
    if dist < 1e-6:
        return True
    angle_to_target = math.atan2(dy, dx)
    heading_rad = math.radians(camera.heading_deg)
    diff = angle_to_target - heading_rad
    # wrap to [-pi, pi]
    diff = (diff + math.pi) % (2 * math.pi) - math.pi
    half_fov = math.radians(camera.hfov_deg / 2.0)
    return abs(diff) <= half_fov


def world_to_bbox(
    camera: CameraConfig,
    world_x: float,
    world_y: float,
    person_height_m: float = DEFAULT_PERSON_HEIGHT_M,
) -> Optional[List[float]]:
    """
    Inverse: given a world position, what bbox would this camera see?
    Returns [x1, y1, x2, y2] or None if outside FOV.
    """
    if not is_in_fov(camera, world_x, world_y):
        return None

    dx = world_x - camera.x
    dy = world_y - camera.y
    dist_m = math.sqrt(dx * dx + dy * dy)
    if dist_m < 0.1:
        dist_m = 0.1

    world_angle = math.atan2(dy, dx)
    heading_rad = math.radians(camera.heading_deg)
    angle_offset = world_angle - heading_rad
    # wrap
    angle_offset = (angle_offset + math.pi) % (2 * math.pi) - math.pi

    f_h = focal_length_px(camera.image_width, camera.hfov_deg)
    f_v = focal_length_px_vertical(camera.image_width, camera.image_height, camera.hfov_deg)

    offset_px = -f_h * math.tan(angle_offset)
    center_x = camera.image_width / 2.0 + offset_px
    center_y = camera.image_height / 2.0

    height_px = person_height_m * f_v / dist_m
    width_px = height_px * 0.4  # typical person aspect ratio

    x1 = center_x - width_px / 2
    y1 = center_y - height_px / 2
    x2 = center_x + width_px / 2
    y2 = center_y + height_px / 2

    return [x1, y1, x2, y2]


def estimation_error(
    estimated: PositionEstimate,
    true_x: float,
    true_y: float,
) -> float:
    """Euclidean error between estimated and true position (metres)."""
    return math.sqrt(
        (estimated.world_x - true_x) ** 2
        + (estimated.world_y - true_y) ** 2
    )
