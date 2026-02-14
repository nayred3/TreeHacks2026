#!/usr/bin/env python3
"""
Run the full Person 2 pipeline:
  Mock Person 1 data -> Fusion -> Output for Person 3

Usage:
  python -m fusion.run_fusion [--frames N] [--out file.json]
  Or from repo root: python -m fusion.run_fusion
"""

import argparse
import json
import sys
import os

# Run from repo root or from fusion/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fusion.schemas import CameraFrame, CameraState, global_tracks_output
from fusion.fusion_engine import FusionEngine
from fusion.mock_person1 import generate_frames_finite


def main():
    ap = argparse.ArgumentParser(description="Person 2: Spatial Projection & Fusion (mock in -> fused tracks out)")
    ap.add_argument("--frames", type=int, default=30, help="Number of simulated frames")
    ap.add_argument("--fps", type=float, default=5.0, help="Frames per second (simulated)")
    ap.add_argument("--out", type=str, default=None, help="Write Person 3 JSON to this file (default: stdout)")
    ap.add_argument("--cameras", type=str, default="cam_1,cam_2,cam_3", help="Comma-separated camera IDs")
    ap.add_argument("--tracks-per-cam", type=int, default=2, help="Mock tracks per camera per frame")
    ap.add_argument("--person1-json", type=str, default=None, help="Read Person 1 frames from JSON file (array of CameraFrame) instead of mock")
    ap.add_argument("--camera-state-json", type=str, default=None, help="Optional: camera states from JSON file (array of {agent_id, position, heading, timestamp})")
    args = ap.parse_args()

    camera_ids = [s.strip() for s in args.cameras.split(",")]
    engine = FusionEngine(match_radius_m=3.0, track_ttl_sec=5.0)

    # Mock camera states: fixed positions and headings (e.g. three corners of a room)
    # World: x right, y up. Headings in degrees: 0 = +x, 90 = +y.
    mock_states = [
        CameraState(agent_id="cam_1", position=[0.0, 0.0], heading=45.0, timestamp=0.0),
        CameraState(agent_id="cam_2", position=[10.0, 0.0], heading=135.0, timestamp=0.0),
        CameraState(agent_id="cam_3", position=[5.0, 8.0], heading=270.0, timestamp=0.0),
    ]
    for cs in mock_states:
        if cs.agent_id in camera_ids:
            engine.update_camera_state(cs)

    # Optional: load camera states from file
    if args.camera_state_json and os.path.isfile(args.camera_state_json):
        with open(args.camera_state_json) as f:
            for item in json.load(f):
                engine.update_camera_state(CameraState.from_dict(item))

    # Ensure we have state for every camera_id we'll see
    for cid in camera_ids:
        if engine.get_camera_state(cid) is None:
            engine.update_camera_state(
                CameraState(agent_id=cid, position=[5.0, 5.0], heading=0.0, timestamp=0.0)
            )

    # Person 1 input: from file or mock
    if args.person1_json and os.path.isfile(args.person1_json):
        with open(args.person1_json) as f:
            frame_list = json.load(f)
        for fd in frame_list:
            frame = CameraFrame.from_dict(fd)
            if engine.get_camera_state(frame.camera_id):
                engine.process_frame(frame)
    else:
        # Generate mock Person 1 frames and run fusion
        frames = generate_frames_finite(
            camera_ids=camera_ids,
            num_tracks_per_camera=args.tracks_per_cam,
            num_frames=args.frames,
            fps=args.fps,
        )
        for fd in frames:
            frame = CameraFrame.from_dict(fd)
            engine.process_frame(frame)

    # Output for Person 3
    global_tracks = engine.get_global_tracks()
    payload = global_tracks_output(global_tracks)

    if args.out:
        with open(args.out, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"Wrote {len(global_tracks)} global tracks to {args.out}", file=sys.stderr)
    else:
        print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
