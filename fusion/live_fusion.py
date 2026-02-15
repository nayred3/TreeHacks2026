#!/usr/bin/env python3
"""
Live fusion server: receives detection data from camera.py via UDP,
projects detections to world coordinates, fuses across cameras,
and serves a real-time overhead-map visualization.

Usage:
    python -m fusion.live_fusion [--udp-port 5055] [--http-port 5050]

Then run one or more camera.py instances:
    python computervision/camera.py \
        --camera-id cam1 --source 0 --show \
        --emit camera+tracks \
        --cam-x 0 --cam-y 0 --yaw-deg 0 --hfov-deg 70 \
        --udp-port 5055
"""

import argparse
import json
import math
import os
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# Ensure repo root on path
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from flask import Flask, send_from_directory, jsonify
from fusion.camera_estimator import CameraConfig, estimate_position


# ──────────────────────────────────────────────────────────────
#  Live Track
# ──────────────────────────────────────────────────────────────

@dataclass
class LiveTrack:
    """A fused person track in world coordinates."""
    id: int
    position: List[float]       # [x, y] metres
    confidence: float
    last_seen: float            # epoch timestamp
    source_cameras: List[str]


# ──────────────────────────────────────────────────────────────
#  Fusion Tracker
# ──────────────────────────────────────────────────────────────

class LiveFusionTracker:
    """
    Projects per-camera detections to world coordinates using the
    camera estimator (pinhole model), then fuses across cameras
    with radius-gated nearest-neighbour matching.
    """

    def __init__(
        self,
        match_radius_m: float = 3.0,
        track_ttl_sec: float = 5.0,
        memory_ttl_sec: float = 30.0,
    ):
        self.match_radius_m = match_radius_m
        self.track_ttl_sec = track_ttl_sec
        self.memory_ttl_sec = memory_ttl_sec
        self._tracks: Dict[int, LiveTrack] = {}
        self._next_id = 1
        self._memory: Dict[int, LiveTrack] = {}

    def process_detections(
        self,
        camera: CameraConfig,
        detections: List[dict],
        timestamp: float,
    ) -> None:
        """
        Project one camera frame's detections to world space and fuse.

        Each detection dict must have:
            track_id  (int)
            bbox_xyxy (list of 4 numbers)
            conf      (float)
        """
        world_points: List[Tuple[float, float, float]] = []
        for det in detections:
            bbox = [float(x) for x in det["bbox_xyxy"]]
            try:
                est = estimate_position(camera, bbox)
                world_points.append((est.world_x, est.world_y, float(det["conf"])))
            except Exception:
                continue

        if not world_points:
            self._cleanup(timestamp)
            return

        # Nearest-neighbour matching
        used: set = set()
        for wx, wy, conf in world_points:
            best_id: Optional[int] = None
            best_dist = self.match_radius_m

            for gid, gt in self._tracks.items():
                if gid in used:
                    continue
                d = math.hypot(gt.position[0] - wx, gt.position[1] - wy)
                if d < best_dist:
                    best_dist = d
                    best_id = gid

            if best_id is not None:
                # Merge into existing track (weighted average by confidence)
                gt = self._tracks[best_id]
                w_old = gt.confidence
                w_new = conf
                total = w_old + w_new + 1e-9
                gt.position = [
                    (gt.position[0] * w_old + wx * w_new) / total,
                    (gt.position[1] * w_old + wy * w_new) / total,
                ]
                gt.confidence = min(1.0, (gt.confidence + conf) / 2.0)
                gt.last_seen = timestamp
                if camera.camera_id not in gt.source_cameras:
                    gt.source_cameras.append(camera.camera_id)
                used.add(best_id)
            else:
                # Create new track
                new_id = self._next_id
                self._next_id += 1
                self._tracks[new_id] = LiveTrack(
                    id=new_id,
                    position=[wx, wy],
                    confidence=conf,
                    last_seen=timestamp,
                    source_cameras=[camera.camera_id],
                )

        self._cleanup(timestamp)

    def _cleanup(self, now: float) -> None:
        """Move expired active tracks to memory; purge old memory."""
        expired = [
            gid for gid, gt in self._tracks.items()
            if (now - gt.last_seen) > self.track_ttl_sec
        ]
        for gid in expired:
            self._memory[gid] = self._tracks.pop(gid)

        mem_expired = [
            gid for gid, gt in self._memory.items()
            if (now - gt.last_seen) > self.memory_ttl_sec
        ]
        for gid in mem_expired:
            del self._memory[gid]

    def get_all_tracks(self, now: float) -> List[dict]:
        """Return active tracks + last-seen memory entries."""
        result = []
        for gt in self._tracks.values():
            result.append({
                "id": gt.id,
                "position": [round(gt.position[0], 3), round(gt.position[1], 3)],
                "confidence": round(gt.confidence, 3),
                "last_seen": gt.last_seen,
                "source_cameras": list(gt.source_cameras),
                "visible": True,
            })
        for gt in self._memory.values():
            if (now - gt.last_seen) <= self.memory_ttl_sec:
                result.append({
                    "id": gt.id,
                    "position": [round(gt.position[0], 3), round(gt.position[1], 3)],
                    "confidence": 0.0,
                    "last_seen": gt.last_seen,
                    "source_cameras": list(gt.source_cameras),
                    "visible": False,
                })
        return result


# ──────────────────────────────────────────────────────────────
#  Live Fusion Server
# ──────────────────────────────────────────────────────────────

class LiveFusionServer:
    """UDP listener + Flask server for real-time fusion visualisation."""

    def __init__(self, udp_port: int = 5055, http_port: int = 5050):
        self.udp_port = udp_port
        self.http_port = http_port

        self._lock = threading.Lock()
        self._tracker = LiveFusionTracker()
        self._cameras: Dict[str, CameraConfig] = {}
        self._stats = {"msgs": 0, "tracks_msgs": 0, "last_track_time": 0.0}

        static_dir = os.path.join(os.path.dirname(__file__), "viz", "static")
        self.app = Flask(__name__, static_folder=static_dir, static_url_path="")
        self._setup_routes()

    # ── Flask routes ──────────────────────────────────────────

    def _setup_routes(self):
        @self.app.route("/")
        def index():
            return send_from_directory(self.app.static_folder, "index.html")

        @self.app.route("/api/live")
        def api_live():
            return jsonify(self._build_state())

    def _build_state(self) -> dict:
        now = time.time()
        with self._lock:
            cameras = []
            for cam_id, cc in self._cameras.items():
                cameras.append({
                    "id": cam_id,
                    "position": [cc.x, cc.y],
                    "heading": cc.heading_deg,
                    "hfov_deg": cc.hfov_deg,
                    "image_width": cc.image_width,
                    "image_height": cc.image_height,
                    "mobile": False,
                })
            fused = self._tracker.get_all_tracks(now)

        return {
            "mode": "live",
            "cameras": cameras,
            "walls": [],
            "fused_tracks": fused,
            "timestamp": now,
        }

    # ── UDP handling ──────────────────────────────────────────

    def _handle_message(self, data: bytes) -> None:
        try:
            msg = json.loads(data.decode("utf-8").strip())
        except (json.JSONDecodeError, UnicodeDecodeError):
            return

        msg_type = msg.get("type")
        with self._lock:
            self._stats["msgs"] += 1
            if msg_type == "camera_info":
                self._on_camera_info(msg)
            elif msg_type == "tracks":
                self._on_tracks(msg)
            elif msg_type == "camera_state":
                # Position update from iPhone (same format as position_receiver.py)
                self._on_camera_state(msg)

    def _on_camera_info(self, msg: dict) -> None:
        cam_id = msg["camera_id"]
        cc = CameraConfig(
            camera_id=cam_id,
            x=msg["cam_x"],
            y=msg["cam_y"],
            heading_deg=msg["yaw_deg"],
            hfov_deg=msg.get("hfov_deg", 70.0),
            image_width=msg.get("frame_w", 640),
            image_height=msg.get("frame_h", 360),
        )
        is_new = cam_id not in self._cameras
        self._cameras[cam_id] = cc
        if is_new:
            print(
                f"[CAMERA] Registered '{cam_id}' at ({cc.x:.1f}, {cc.y:.1f}) "
                f"heading={cc.heading_deg:.0f}\u00b0 hfov={cc.hfov_deg:.0f}\u00b0 "
                f"{cc.image_width}x{cc.image_height}"
            )

    def _on_camera_state(self, msg: dict) -> None:
        """Handle camera_state message from iPhone (position_receiver format).
        Updates position of an existing camera without overwriting heading,
        image dimensions, or HFOV.  Heading from the phone's compass is
        unreliable indoors; the authoritative heading comes from camera_info
        (which uses the manual --yaw-deg value set in camera.py)."""
        cam_id = msg.get("camera_id", "")
        if not cam_id:
            return
        position = msg.get("position", [0, 0])
        cc = self._cameras.get(cam_id)
        if cc is not None:
            # Update position only — keep heading from camera_info
            self._cameras[cam_id] = CameraConfig(
                camera_id=cam_id,
                x=float(position[0]),
                y=float(position[1]),
                heading_deg=cc.heading_deg,       # preserve manual heading
                hfov_deg=cc.hfov_deg,
                image_width=cc.image_width,
                image_height=cc.image_height,
            )
        else:
            # Camera not yet registered via camera_info — create with defaults.
            # Use 0 heading as placeholder; real heading arrives with camera_info.
            self._cameras[cam_id] = CameraConfig(
                camera_id=cam_id,
                x=float(position[0]),
                y=float(position[1]),
                heading_deg=0.0,                  # placeholder until camera_info arrives
                hfov_deg=70.0,
                image_width=640,
                image_height=360,
            )
            print(
                f"[CAMERA] Registered '{cam_id}' from position update at "
                f"({position[0]:.1f}, {position[1]:.1f}) (heading pending camera_info)"
            )

    def _on_tracks(self, msg: dict) -> None:
        cam_id = msg["camera_id"]
        cc = self._cameras.get(cam_id)
        if cc is None:
            return  # camera_info not yet received

        timestamp = msg.get("timestamp_s", time.time())
        detections = msg.get("detections", [])
        self._stats["tracks_msgs"] += 1
        self._stats["last_track_time"] = time.time()

        if detections:
            self._tracker.process_detections(cc, detections, timestamp)

    def _udp_listener(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", self.udp_port))
        sock.settimeout(1.0)
        print(f"[UDP] Listening on 0.0.0.0:{self.udp_port}")

        while True:
            try:
                data, addr = sock.recvfrom(65536)
                self._handle_message(data)
            except socket.timeout:
                continue
            except Exception as e:
                print(f"[UDP] Error: {e}")

    # ── Periodic status ───────────────────────────────────────

    def _status_printer(self) -> None:
        while True:
            time.sleep(10.0)
            with self._lock:
                n_cams = len(self._cameras)
                n_msgs = self._stats["msgs"]
                n_tracks_msgs = self._stats["tracks_msgs"]
                n_active = len(self._tracker._tracks)
                n_memory = len(self._tracker._memory)
            if n_msgs > 0:
                print(
                    f"[STATUS] cameras={n_cams}  msgs={n_msgs}  "
                    f"track_frames={n_tracks_msgs}  "
                    f"active_tracks={n_active}  memory={n_memory}"
                )

    # ── Run ───────────────────────────────────────────────────

    def run(self) -> None:
        print("=" * 60)
        print("  LIVE FUSION SERVER")
        print("=" * 60)
        print(f"  UDP port:  {self.udp_port}")
        print(f"  HTTP port: {self.http_port}")
        print()
        print("  Start camera.py with:")
        print(f"    python computervision/camera.py \\")
        print(f"        --camera-id cam1 --source 0 --show \\")
        print(f"        --emit camera+tracks \\")
        print(f"        --cam-x 0 --cam-y 0 --yaw-deg 0 --hfov-deg 70 \\")
        print(f"        --udp-port {self.udp_port}")
        print()
        print(f"  Visualisation: http://127.0.0.1:{self.http_port}")
        print("=" * 60)

        threading.Thread(target=self._udp_listener, daemon=True).start()
        threading.Thread(target=self._status_printer, daemon=True).start()

        self.app.run(host="127.0.0.1", port=self.http_port, debug=False)


# ──────────────────────────────────────────────────────────────
#  CLI
# ──────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(
        description="Live fusion server — camera.py → world map"
    )
    p.add_argument(
        "--udp-port", type=int, default=5055,
        help="UDP port to receive camera.py messages (default: 5055)",
    )
    p.add_argument(
        "--http-port", type=int, default=5050,
        help="HTTP port for the visualisation (default: 5050)",
    )
    args = p.parse_args()

    server = LiveFusionServer(udp_port=args.udp_port, http_port=args.http_port)
    server.run()


if __name__ == "__main__":
    main()
