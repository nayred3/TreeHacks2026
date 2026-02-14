"""
Mock data generator that simulates Person 1 (Vision & Tracking) output.

Produces CameraFrame messages: camera_id, timestamp, tracks with bbox and confidence.
Simulates 2–3 cameras and a few moving "people" (bboxes) over time.
Optional: walls + LOS so not all cameras see all people.
"""

import math
import time
import json
from typing import Callable, Iterator, List, Optional

from fusion.schemas import CameraFrame, CameraState, TrackDetection
from fusion.projection import world_position_to_bbox

# Simulated image size (same as fusion defaults)
IMG_W = 640
IMG_H = 480


def get_ground_truth_positions(t: float, num_people: int) -> List[dict]:
    """Return ground truth positions for debugging: [{"id": 1, "position": [x, y]}, ...]."""
    return [
        {"id": i + 1, "position": list(_person_position(t, i))}
        for i in range(num_people)
    ]


import random as _random

# ---------------------------------------------------------------------------
# Wall-aware random walk — precomputed once, then looked up by time.
# ---------------------------------------------------------------------------

# Walls (duplicated here so mock_person1 has no dependency on viz.walls)
_WALLS = [
    [[4.0, 2.0], [4.0, 6.0]],
    [[2.0, 5.0], [7.0, 5.0]],
    [[6.0, 6.5], [6.0, 8.0]],
    [[7.5, 0.5], [7.5, 4.0]],
]
_ROOM_X = (0.4, 11.6)
_ROOM_Y = (0.4, 9.6)


def _seg_cross(ox, oy, tx, ty, cx, cy, dx, dy):
    """True if segment (o→t) strictly crosses segment (c→d)."""
    def _cross2(ax, ay, bx, by, px, py):
        return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    d1 = _cross2(ox, oy, tx, ty, cx, cy)
    d2 = _cross2(ox, oy, tx, ty, dx, dy)
    d3 = _cross2(cx, cy, dx, dy, ox, oy)
    d4 = _cross2(cx, cy, dx, dy, tx, ty)
    return (d1 * d2 < 0) and (d3 * d4 < 0)


def _move_crosses_wall(ox, oy, tx, ty):
    for w in _WALLS:
        if _seg_cross(ox, oy, tx, ty, w[0][0], w[0][1], w[1][0], w[1][1]):
            return True
    return False


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _precompute_walk(seed, start, num_steps, dt, speed=1.3, wander=0.8):
    """
    Random walk: at each step pick a random direction perturbation,
    move forward, reject if it crosses a wall or exits room bounds.
    Returns list of (x, y) positions, one per step.
    """
    rng = _random.Random(seed)
    positions = [start]
    x, y = start
    heading = rng.uniform(0, 2 * math.pi)
    step_dist = speed * dt

    for _ in range(num_steps - 1):
        # Try up to 8 random directions before standing still
        moved = False
        for _attempt in range(8):
            heading += rng.gauss(0, wander)
            nx = x + step_dist * math.cos(heading)
            ny = y + step_dist * math.sin(heading)
            nx = _clamp(nx, _ROOM_X[0], _ROOM_X[1])
            ny = _clamp(ny, _ROOM_Y[0], _ROOM_Y[1])
            if not _move_crosses_wall(x, y, nx, ny):
                x, y = nx, ny
                moved = True
                break
            heading += rng.uniform(0.5, 1.5)  # bounce off in new direction
        positions.append((x, y))

    return positions


def _smooth_positions(positions, window=5):
    """Rolling average to smooth out jitter."""
    smoothed = []
    n = len(positions)
    hw = window // 2
    for i in range(n):
        lo = max(0, i - hw)
        hi = min(n, i + hw + 1)
        sx = sum(p[0] for p in positions[lo:hi]) / (hi - lo)
        sy = sum(p[1] for p in positions[lo:hi]) / (hi - lo)
        smoothed.append((sx, sy))
    return smoothed


# --- Precomputed walks (generated once at import time) ---
_SIM_FPS = 30.0
_SIM_DURATION = 20.0  # seconds
_SIM_STEPS = int(_SIM_FPS * _SIM_DURATION)
_SIM_DT = 1.0 / _SIM_FPS

_START_POSITIONS = [
    (2.0, 1.5),   # P0: bottom-left area
    (1.0, 3.0),   # P1: left side
    (9.0, 2.0),   # P2: right side
]

_PRECOMPUTED_WALKS = []
for _i, _start in enumerate(_START_POSITIONS):
    _raw = _precompute_walk(
        seed=42 + _i * 17,
        start=_start,
        num_steps=_SIM_STEPS,
        dt=_SIM_DT,
        speed=1.3 + 0.2 * _i,   # slightly different speeds
        wander=0.7 + 0.15 * _i,  # slightly different wander
    )
    _PRECOMPUTED_WALKS.append(_smooth_positions(_raw, window=7))


def _person_position(t: float, person_index: int) -> tuple:
    """
    World (x, y) for one person at time t.
    Uses precomputed wall-safe random walks with smooth interpolation.
    """
    walk = _PRECOMPUTED_WALKS[person_index % len(_PRECOMPUTED_WALKS)]
    # Map t to a fractional step index and interpolate
    step_f = t * _SIM_FPS
    idx = int(step_f)
    frac = step_f - idx
    n = len(walk)
    if idx >= n - 1:
        return walk[-1]
    ax, ay = walk[idx]
    bx, by = walk[idx + 1]
    return (ax + frac * (bx - ax), ay + frac * (by - ay))


def make_track(track_id: int, t: float, phase: float = 0) -> TrackDetection:
    """One moving bbox: oscillates in image space (simulates person walking)."""
    # Center moves in a band
    cx = IMG_W / 2 + 80 * math.sin(t * 0.5 + phase)
    cy = IMG_H / 2 + 60 * math.cos(t * 0.3 + phase * 1.1)
    h = 120 + 20 * math.sin(t * 0.2)  # height in px (affects distance)
    w = 50
    x1 = cx - w / 2
    y1 = cy - h / 2
    x2 = cx + w / 2
    y2 = cy + h / 2
    confidence = 0.85 + 0.1 * math.sin(t * 0.7)
    return TrackDetection(track_id=track_id, bbox=[x1, y1, x2, y2], confidence=min(1.0, confidence))


def generate_frames(
    camera_ids: List[str],
    num_tracks_per_camera: int,
    duration_sec: float,
    fps: float = 5.0,
) -> Iterator[CameraFrame]:
    """
    Yield CameraFrame dicts (as from Person 1) for each camera at each time step.
    """
    start = time.time()
    frame_idx = 0
    while (time.time() - start) < duration_sec:
        t = time.time()
        ts = t
        for cam_id in camera_ids:
            tracks = [
                make_track(i + 1, t, phase=(hash(cam_id) % 100) / 100.0 + i * 0.5)
                for i in range(num_tracks_per_camera)
            ]
            yield CameraFrame(camera_id=cam_id, timestamp=ts, tracks=tracks)
        frame_idx += 1
        time.sleep(1.0 / fps)


def generate_frames_finite(
    camera_ids: List[str],
    num_tracks_per_camera: int,
    num_frames: int,
    fps: float = 5.0,
) -> List[dict]:
    """Generate a fixed number of frames (for testing without real-time)."""
    out = []
    dt = 1.0 / fps
    for fi in range(num_frames):
        t = fi * dt
        ts = t
        for cam_id in camera_ids:
            tracks = [
                make_track(i + 1, t, phase=(hash(cam_id) % 100) / 100.0 + i * 0.5)
                for i in range(num_tracks_per_camera)
            ]
            out.append(CameraFrame(camera_id=cam_id, timestamp=ts, tracks=tracks).to_dict())
    return out


def generate_frames_finite_with_walls(
    camera_ids: List[str],
    camera_states: List[CameraState],
    walls: List[List[List[float]]],
    has_los: Callable[[tuple, tuple, list], bool],
    num_people: int,
    num_frames: int,
    fps: float = 5.0,
) -> List[dict]:
    """
    Generate frames from moving people in world space. Only emit a detection
    for (camera, person) when the person has line-of-sight from that camera (no wall in between).
    """
    cam_by_id = {cs.agent_id: cs for cs in camera_states}
    out = []
    dt = 1.0 / fps
    for fi in range(num_frames):
        t = fi * dt
        ts = t
        for cam_id in camera_ids:
            camera = cam_by_id.get(cam_id)
            if not camera:
                continue
            cam_pos = (camera.position[0], camera.position[1])
            tracks = []
            for i in range(num_people):
                wx, wy = _person_position(t, i)
                target = (wx, wy)
                if not has_los(cam_pos, target, walls):
                    continue
                bbox = world_position_to_bbox(wx, wy, camera)
                conf = 0.85 + 0.1 * math.sin(t * 0.7 + i)
                tracks.append(TrackDetection(track_id=i + 1, bbox=bbox, confidence=min(1.0, conf)))
            out.append(CameraFrame(camera_id=cam_id, timestamp=ts, tracks=tracks).to_dict())
    return out
