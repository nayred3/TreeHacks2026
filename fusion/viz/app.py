#!/usr/bin/env python3
"""
Local server for the fusion map viz.
Serves API with camera positions + global tracks, and static frontend.

Run from repo root:  python -m fusion.viz.app
Or:  cd fusion/viz && python app.py
"""

import sys
import os

# Ensure repo root on path
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from flask import Flask, send_from_directory, jsonify

from fusion.schemas import CameraState
from fusion.mock_person1 import get_ground_truth_positions
from fusion.camera_estimator import CameraConfig, estimate_position, world_to_bbox

from fusion.viz.walls import WALLS, has_los

app = Flask(__name__, static_folder="static", static_url_path="")

# Fixed camera layout (same as demo)
CAMERA_IDS = ["cam_1", "cam_2", "cam_3"]
CAMERA_STATES = [
    CameraState(agent_id="cam_1", position=[0.0, 0.0], heading=45.0, timestamp=0.0),
    CameraState(agent_id="cam_2", position=[10.0, 0.0], heading=135.0, timestamp=0.0),
    CameraState(agent_id="cam_3", position=[5.0, 8.0], heading=270.0, timestamp=0.0),
]

NUM_PEOPLE = 3
NUM_FRAMES = 600   # 20 seconds at 30 fps
FPS = 30.0

IMAGE_WIDTH = 640
IMAGE_HEIGHT = 480

import math

HFOV_DEG = 60.0   # must match the cone drawn in app.js
CONE_RANGE = 8.0   # meters — must match coneRadius in app.js

# ── Mobile camera: walks a patrol path through the room ───────────────
MOBILE_CAM_ID = "cam_mobile"

from fusion.mock_person1 import _precompute_walk, _smooth_positions

# Precompute a patrol walk for the mobile camera.
# Different seed / starting position from the people, slower speed.
_MOBILE_RAW = _precompute_walk(
    seed=999,
    start=(8.0, 8.0),          # starts top-right
    num_steps=int(FPS * (NUM_FRAMES / FPS)),
    dt=1.0 / FPS,
    speed=1.0,                  # walking speed (m/s) — a bit slower than the people
    wander=0.5,                 # less random than people (more purposeful patrol)
)
_MOBILE_PATH = _smooth_positions(_MOBILE_RAW, window=11)  # extra smooth


def _mobile_camera_state(frame_idx: int) -> tuple:
    """
    Return (x, y, heading_deg) for the mobile camera at the given frame.
    Heading follows the direction of movement.
    """
    n = len(_MOBILE_PATH)
    idx = min(frame_idx, n - 1)
    x, y = _MOBILE_PATH[idx]

    # Heading = direction of travel (look-ahead by 3 frames for smooth heading)
    look = min(idx + 3, n - 1)
    if look > idx:
        dx = _MOBILE_PATH[look][0] - x
        dy = _MOBILE_PATH[look][1] - y
        heading_deg = math.degrees(math.atan2(dy, dx)) % 360
    else:
        heading_deg = 0.0  # default if at end

    return (x, y, heading_deg)


# Add mobile camera to lists
ALL_CAMERA_IDS = CAMERA_IDS + [MOBILE_CAM_ID]

# Build CameraConfig objects for the STATIC estimator cameras
CAMERA_CONFIGS = [
    CameraConfig(
        camera_id=cs.agent_id,
        x=cs.position[0],
        y=cs.position[1],
        heading_deg=cs.heading,
        hfov_deg=HFOV_DEG,
        image_width=IMAGE_WIDTH,
        image_height=IMAGE_HEIGHT,
    )
    for cs in CAMERA_STATES
]
_CAM_CONFIG_BY_ID = {cc.camera_id: cc for cc in CAMERA_CONFIGS}

def _cameras_that_see(position, camera_states, walls):
    """Return list of camera IDs that have LOS, are within FOV, and within range."""
    half_fov = math.radians(HFOV_DEG / 2.0)
    out = []
    for cs in camera_states:
        cam_pos = (cs.position[0], cs.position[1])
        dx = position[0] - cam_pos[0]
        dy = position[1] - cam_pos[1]
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < 1e-6:
            out.append(cs.agent_id)
            continue
        # Range check — must be within cone radius
        if dist > CONE_RANGE:
            continue
        # Angle from camera to target
        angle_to_target = math.atan2(dy, dx)
        heading_rad = math.radians(cs.heading)
        # Signed angular difference, wrapped to [-pi, pi]
        diff = angle_to_target - heading_rad
        diff = (diff + math.pi) % (2 * math.pi) - math.pi
        if abs(diff) > half_fov:
            continue  # outside FOV cone
        if not has_los(cam_pos, (position[0], position[1]), walls):
            continue  # wall blocks
        out.append(cs.agent_id)
    return out


def _build_camera_feeds(ground_truth, camera_configs, walls):
    """
    For each camera, compute the bounding box it would see for each visible
    person, then run the estimator to get the predicted world position.
    Returns dict: camera_id -> { image_width, image_height, detections: [...] }
    """
    feeds = {}
    for cc in camera_configs:
        detections = []
        cam_pos = (cc.x, cc.y)
        for gt in ground_truth:
            pid = gt["id"]
            pos = gt["position"]
            target = (pos[0], pos[1])

            # Check LOS + range + FOV
            dx = pos[0] - cc.x
            dy = pos[1] - cc.y
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > CONE_RANGE:
                continue
            if not has_los(cam_pos, target, walls):
                continue

            # Compute the bbox the camera would see (ground truth -> image)
            bbox = world_to_bbox(cc, pos[0], pos[1])
            if bbox is None:
                continue

            # Clamp bbox to image bounds
            bbox = [
                max(0, min(cc.image_width, bbox[0])),
                max(0, min(cc.image_height, bbox[1])),
                max(0, min(cc.image_width, bbox[2])),
                max(0, min(cc.image_height, bbox[3])),
            ]

            # Now run the estimator on the bbox (this is what happens in prod)
            est = estimate_position(cc, bbox)

            detections.append({
                "person_id": pid,
                "bbox": [round(b, 1) for b in bbox],
                "estimated_distance": round(est.distance_m, 2),
                "estimated_position": [round(est.world_x, 2), round(est.world_y, 2)],
                "actual_position": [round(pos[0], 2), round(pos[1], 2)],
                "bearing_deg": round(est.bearing_deg, 1),
                "angle_in_fov_deg": round(est.angle_in_fov_deg, 1),
                "uncertainty_m": round(est.uncertainty_m, 2),
                "error_m": round(
                    math.sqrt((est.world_x - pos[0])**2 + (est.world_y - pos[1])**2), 3
                ),
            })

        feeds[cc.camera_id] = {
            "image_width": cc.image_width,
            "image_height": cc.image_height,
            "detections": detections,
        }
    return feeds


def get_fusion_data():
    """
    Build per-person tracking data at each timestep.
    Each person entry has:
      id, position (real), visible, seen_by,
      last_seen_position, last_seen_time

    Also includes per-camera "feeds": what each camera sees (bboxes,
    estimated positions, errors) at each timestep.

    The mobile camera moves each frame — its position and heading are
    stored in ``camera_positions`` per timestep.
    """
    dt = 1.0 / FPS

    # Persistent last-seen state per person across timesteps
    last_seen_pos = {}   # person_id -> [x, y]
    last_seen_time = {}  # person_id -> float

    timesteps = []
    for fi in range(NUM_FRAMES):
        t = fi * dt

        # --- Mobile camera state for this frame ---
        mx, my, mh = _mobile_camera_state(fi)
        mobile_cs = CameraState(
            agent_id=MOBILE_CAM_ID,
            position=[mx, my],
            heading=mh,
            timestamp=t,
        )
        mobile_cc = CameraConfig(
            camera_id=MOBILE_CAM_ID,
            x=mx, y=my,
            heading_deg=mh,
            hfov_deg=HFOV_DEG,
            image_width=IMAGE_WIDTH,
            image_height=IMAGE_HEIGHT,
        )

        # All camera states this frame (fixed + mobile)
        all_states = CAMERA_STATES + [mobile_cs]
        all_configs = CAMERA_CONFIGS + [mobile_cc]

        ground_truth = get_ground_truth_positions(t, NUM_PEOPLE)
        persons = []
        for gt in ground_truth:
            pid = gt["id"]
            pos = gt["position"]
            seen_by = _cameras_that_see(pos, all_states, WALLS)
            visible = len(seen_by) > 0

            if visible:
                last_seen_pos[pid] = list(pos)
                last_seen_time[pid] = t

            persons.append({
                "id": pid,
                "position": pos,
                "visible": visible,
                "seen_by": seen_by,
                "last_seen_position": list(last_seen_pos[pid]) if pid in last_seen_pos else None,
                "last_seen_time": last_seen_time.get(pid),
            })

        # Build camera feeds for this timestep (all cameras including mobile)
        camera_feeds = _build_camera_feeds(ground_truth, all_configs, WALLS)

        # Per-timestep camera positions (for cameras that move)
        camera_positions = {
            MOBILE_CAM_ID: {
                "position": [round(mx, 3), round(my, 3)],
                "heading": round(mh, 1),
            }
        }

        timesteps.append({
            "t": t,
            "persons": persons,
            "camera_feeds": camera_feeds,
            "camera_positions": camera_positions,
        })

    # Camera list: fixed cameras + mobile camera (initial position)
    mx0, my0, mh0 = _mobile_camera_state(0)
    cameras_payload = [
        {
            "id": cs.agent_id,
            "position": cs.position,
            "heading": cs.heading,
            "image_width": IMAGE_WIDTH,
            "image_height": IMAGE_HEIGHT,
            "hfov_deg": HFOV_DEG,
            "mobile": False,
        }
        for cs in CAMERA_STATES
    ] + [
        {
            "id": MOBILE_CAM_ID,
            "position": [mx0, my0],
            "heading": mh0,
            "image_width": IMAGE_WIDTH,
            "image_height": IMAGE_HEIGHT,
            "hfov_deg": HFOV_DEG,
            "mobile": True,
        }
    ]
    return {
        "cameras": cameras_payload,
        "walls": WALLS,
        "timesteps": timesteps,
        "timestamp": __import__("time").time(),
    }


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/map")
def api_map():
    return jsonify(get_fusion_data())


def main():
    port = int(os.environ.get("PORT", 5050))
    print("Fusion map viz: http://127.0.0.1:{}".format(port))
    app.run(host="127.0.0.1", port=port, debug=False)


if __name__ == "__main__":
    main()
