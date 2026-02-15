#!/usr/bin/env python3
"""
Local server for the fusion map viz.

Runs the CameraFeedPipeline automatically and serves both:
  - Ground truth (circles) for validation
  - Pipeline output (diamonds) from camera feeds only

Single command:  python -m fusion.viz.app
"""

import sys
import os
import math

# Ensure repo root on path
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from flask import Flask, send_from_directory, jsonify

from fusion.schemas import CameraState
from fusion.mock_person1 import get_ground_truth_positions
from fusion.camera_estimator import CameraConfig, estimate_position, world_to_bbox
from fusion.camera_feed_pipeline import (
    CameraFeedPipeline,
    simulate_camera_detections,
    STATIC_CAMERAS,
    CONE_RANGE,
    IMAGE_WIDTH,
    IMAGE_HEIGHT,
    HFOV_DEG,
    NUM_PEOPLE,
)
from fusion.viz.walls import WALLS, has_los

app = Flask(__name__, static_folder="static", static_url_path="")

# ── Camera layout ─────────────────────────────────────────────
CAMERA_IDS = ["cam_1", "cam_2", "cam_3"]
CAMERA_STATES = [
    CameraState(agent_id=cc.camera_id, position=[cc.x, cc.y],
                heading=cc.heading_deg, timestamp=0.0)
    for cc in STATIC_CAMERAS
]

NUM_FRAMES = 600   # 20 seconds at 30 fps
FPS = 30.0

# Build CameraConfig objects (re-use from pipeline)
CAMERA_CONFIGS = list(STATIC_CAMERAS)
_CAM_CONFIG_BY_ID = {cc.camera_id: cc for cc in CAMERA_CONFIGS}

# ── Mobile camera: walks a patrol path through the room ───────
MOBILE_CAM_ID = "cam_mobile"

from fusion.mock_person1 import _precompute_walk, _smooth_positions

_MOBILE_RAW = _precompute_walk(
    seed=999,
    start=(8.0, 8.0),
    num_steps=int(FPS * (NUM_FRAMES / FPS)),
    dt=1.0 / FPS,
    speed=1.0,
    wander=0.5,
)
_MOBILE_PATH = _smooth_positions(_MOBILE_RAW, window=11)


def _mobile_camera_state(frame_idx: int) -> tuple:
    n = len(_MOBILE_PATH)
    idx = min(frame_idx, n - 1)
    x, y = _MOBILE_PATH[idx]
    look = min(idx + 3, n - 1)
    if look > idx:
        dx = _MOBILE_PATH[look][0] - x
        dy = _MOBILE_PATH[look][1] - y
        heading_deg = math.degrees(math.atan2(dy, dx)) % 360
    else:
        heading_deg = 0.0
    return (x, y, heading_deg)


ALL_CAMERA_IDS = CAMERA_IDS + [MOBILE_CAM_ID]


# ── Helpers ───────────────────────────────────────────────────

def _cameras_that_see(position, camera_states, walls):
    """Return list of camera IDs that have LOS + FOV + range."""
    half_fov = math.radians(HFOV_DEG / 2.0)
    out = []
    for cs in camera_states:
        cam_pos = (cs.position[0], cs.position[1])
        dx = position[0] - cam_pos[0]
        dy = position[1] - cam_pos[1]
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < 1e-6:
            out.append(cs.agent_id); continue
        if dist > CONE_RANGE:
            continue
        angle_to_target = math.atan2(dy, dx)
        heading_rad = math.radians(cs.heading)
        diff = angle_to_target - heading_rad
        diff = (diff + math.pi) % (2 * math.pi) - math.pi
        if abs(diff) > half_fov:
            continue
        if not has_los(cam_pos, (position[0], position[1]), walls):
            continue
        out.append(cs.agent_id)
    return out


def _build_camera_feeds(ground_truth, camera_configs, walls):
    """
    For each camera, compute bboxes it would see + run estimator.
    Returns dict: camera_id -> { image_width, image_height, detections: [...] }
    """
    feeds = {}
    for cc in camera_configs:
        detections = []
        cam_pos = (cc.x, cc.y)
        for gt in ground_truth:
            pid = gt["id"]
            pos = gt["position"]
            dx = pos[0] - cc.x
            dy = pos[1] - cc.y
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > CONE_RANGE:
                continue
            if not has_los(cam_pos, (pos[0], pos[1]), walls):
                continue
            bbox = world_to_bbox(cc, pos[0], pos[1])
            if bbox is None:
                continue
            bbox = [
                max(0, min(cc.image_width, bbox[0])),
                max(0, min(cc.image_height, bbox[1])),
                max(0, min(cc.image_width, bbox[2])),
                max(0, min(cc.image_height, bbox[3])),
            ]
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


def _match_to_persons(fused_tracks_raw, ground_truth):
    """Greedy match each fused track to the nearest ground-truth person."""
    gt_positions = {p["id"]: p["position"] for p in ground_truth}
    used_pids = set()
    fused_tracks = []
    for ft in sorted(fused_tracks_raw, key=lambda f: min(
        (math.sqrt((f["position"][0] - gp[0])**2 + (f["position"][1] - gp[1])**2)
         for gp in gt_positions.values()), default=999,
    )):
        best_pid = None
        best_dist = float("inf")
        for pid, gp in gt_positions.items():
            if pid in used_pids:
                continue
            d = math.sqrt((ft["position"][0] - gp[0])**2 + (ft["position"][1] - gp[1])**2)
            if d < best_dist:
                best_dist = d
                best_pid = pid
        ft["matched_person"] = best_pid
        ft["match_error"] = round(best_dist, 3) if best_pid else None
        if best_pid is not None:
            used_pids.add(best_pid)
        fused_tracks.append(ft)
    fused_tracks.sort(key=lambda f: f.get("matched_person") or 999)
    return fused_tracks


# ══════════════════════════════════════════════════════════════
#  Main data builder — runs CameraFeedPipeline automatically
# ══════════════════════════════════════════════════════════════

def get_fusion_data():
    """
    Build all timestep data.  Runs the CameraFeedPipeline on simulated
    camera feeds and includes both ground truth and pipeline output so
    the frontend can overlay them for validation.
    """
    dt = 1.0 / FPS

    # ── Instantiate the pipeline (single source of truth) ──
    pipeline = CameraFeedPipeline(
        match_radius_m=3.0,
        track_ttl_sec=3.0,
        last_seen_ttl_sec=30.0,
    )

    # Ground-truth last-seen state (for the GT layer only)
    last_seen_pos = {}
    last_seen_time = {}

    timesteps = []
    for fi in range(NUM_FRAMES):
        t = fi * dt

        # --- Mobile camera ---
        mx, my, mh = _mobile_camera_state(fi)
        mobile_cs = CameraState(
            agent_id=MOBILE_CAM_ID, position=[mx, my],
            heading=mh, timestamp=t,
        )
        mobile_cc = CameraConfig(
            camera_id=MOBILE_CAM_ID, x=mx, y=my,
            heading_deg=mh, hfov_deg=HFOV_DEG,
            image_width=IMAGE_WIDTH, image_height=IMAGE_HEIGHT,
        )

        all_states = CAMERA_STATES + [mobile_cs]
        all_configs = CAMERA_CONFIGS + [mobile_cc]

        # --- Hidden ground truth (for GT layer + camera simulation) ---
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

        # --- Camera feeds (used by both viz + pipeline) ---
        camera_feeds = _build_camera_feeds(ground_truth, all_configs, WALLS)

        # ── Feed every camera into the pipeline ──
        for cc in all_configs:
            dets = simulate_camera_detections(cc, ground_truth, WALLS)
            pipeline.process_camera_frame(cc, dets, t)

        # ── Read pipeline output ──
        tracked = pipeline.get_tracked_persons(t)
        fused_tracks_raw = []
        for tp in tracked:
            fused_tracks_raw.append({
                "id": tp.track_id,
                "position": [round(tp.position[0], 3), round(tp.position[1], 3)],
                "confidence": round(tp.confidence, 3),
                "last_seen": round(tp.last_seen_time, 3),
                "source_cameras": list(tp.source_cameras),
                "visible": tp.visible,
            })

        # Match pipeline tracks to GT persons for labeling
        fused_tracks = _match_to_persons(fused_tracks_raw, ground_truth)

        # --- Camera positions (mobile) ---
        camera_positions = {
            MOBILE_CAM_ID: {
                "position": [round(mx, 3), round(my, 3)],
                "heading": round(mh, 1),
            }
        }

        timesteps.append({
            "t": t,
            "persons": persons,
            "fused_tracks": fused_tracks,
            "camera_feeds": camera_feeds,
            "camera_positions": camera_positions,
        })

    # Camera payload
    mx0, my0, mh0 = _mobile_camera_state(0)
    cameras_payload = [
        {
            "id": cc.camera_id,
            "position": [cc.x, cc.y],
            "heading": cc.heading_deg,
            "image_width": IMAGE_WIDTH,
            "image_height": IMAGE_HEIGHT,
            "hfov_deg": HFOV_DEG,
            "mobile": False,
        }
        for cc in STATIC_CAMERAS
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


# ── Routes ────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/map")
def api_map():
    return jsonify(get_fusion_data())


def main():
    port = int(os.environ.get("PORT", 5050))
    print("Fusion map viz: http://127.0.0.1:{}".format(port))
    print("  Pipeline: CameraFeedPipeline (auto-validated against ground truth)")
    app.run(host="127.0.0.1", port=port, debug=False)


if __name__ == "__main__":
    main()
