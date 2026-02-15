#!/usr/bin/env python3
"""
Bridge: Phone Position Receiver → Fusion Engine

Listens for camera_state UDP packets from iPhones and feeds them into
the existing FusionEngine as CameraState updates.

Also listens for detection results from Logan's Mac (track data from YOLO)
and feeds those as CameraFrame objects.

Run on Justin's Mac alongside the fusion viz server:
    python bridge_to_fusion.py

This replaces the mock data / simulation with real phone data.
"""

import socket
import json
import time
import sys
import os
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from fusion.schemas import CameraState, CameraFrame, TrackDetection
from fusion.fusion_engine import FusionEngine

# --- Config ---
POSITION_PORT = 5056       # UDP: receives camera_state from iPhones
DETECTION_PORT = 5055      # UDP: receives track detections from Logan's Mac

engine = FusionEngine(match_radius_m=3.0, track_ttl_sec=5.0)
engine_lock = threading.Lock()


def listen_positions():
    """Thread: receive camera position/heading from iPhones."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", POSITION_PORT))
    print(f"[Bridge] Listening for phone positions on UDP :{POSITION_PORT}")

    while True:
        data, addr = sock.recvfrom(65535)
        try:
            msg = json.loads(data.decode("utf-8"))
        except Exception as e:
            print(f"[Bridge] Bad position packet from {addr}: {e}")
            continue

        if msg.get("type") != "camera_state":
            continue

        state = CameraState(
            agent_id=msg["camera_id"],
            position=msg["position"],
            heading=msg["heading"],
            timestamp=msg.get("timestamp", time.time()),
        )

        with engine_lock:
            engine.update_camera_state(state)

        print(
            f"[Bridge] Camera {state.agent_id} → "
            f"pos=({state.position[0]:.2f}, {state.position[1]:.2f}) "
            f"heading={state.heading:.1f}°"
        )


def listen_detections():
    """Thread: receive YOLO detections from Logan's Mac."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", DETECTION_PORT))
    print(f"[Bridge] Listening for detections on UDP :{DETECTION_PORT}")

    while True:
        data, addr = sock.recvfrom(65535)
        try:
            msg = json.loads(data.decode("utf-8"))
        except Exception as e:
            print(f"[Bridge] Bad detection packet from {addr}: {e}")
            continue

        if msg.get("type") != "tracks":
            continue

        camera_id = msg.get("camera_id", "unknown")
        timestamp = msg.get("timestamp", time.time())
        detections = msg.get("detections", [])

        tracks = [
            TrackDetection(
                track_id=d["track_id"],
                bbox=d["bbox"],
                confidence=d.get("confidence", 0.5),
            )
            for d in detections
        ]

        frame = CameraFrame(
            camera_id=camera_id,
            timestamp=timestamp,
            tracks=tracks,
        )

        with engine_lock:
            engine.process_frame(frame)

        global_tracks = engine.get_global_tracks()
        print(
            f"[Bridge] Detections from {camera_id}: {len(tracks)} people → "
            f"{len(global_tracks)} global tracks"
        )


def print_status():
    """Thread: periodically print fusion state."""
    while True:
        time.sleep(3)
        with engine_lock:
            tracks = engine.get_global_tracks()
        if tracks:
            print(f"\n[Bridge] === Global Tracks ({len(tracks)}) ===")
            for t in tracks:
                print(
                    f"  Track {t.id:2d}  "
                    f"pos=({t.position[0]:6.2f}, {t.position[1]:6.2f})  "
                    f"conf={t.confidence:.2f}  "
                    f"src={t.source_cameras}"
                )
            print()


def main():
    print("=" * 60)
    print("  PHONE → FUSION BRIDGE")
    print("=" * 60)
    print(f"  Position port : UDP {POSITION_PORT} (from iPhones)")
    print(f"  Detection port: UDP {DETECTION_PORT} (from Logan's YOLO)")
    print("=" * 60)
    print()

    threads = [
        threading.Thread(target=listen_positions, daemon=True),
        threading.Thread(target=listen_detections, daemon=True),
        threading.Thread(target=print_status, daemon=True),
    ]

    for t in threads:
        t.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[Bridge] Shutting down.")


if __name__ == "__main__":
    main()
