#!/usr/bin/env python3
"""
Demo: show sample Person 1 (mock) input and the resulting Person 3 output.
Run from repo root:  python -m fusion.demo_results
Or from fusion dir:  python demo_results.py
"""

import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fusion.schemas import CameraFrame, CameraState, global_tracks_output
from fusion.fusion_engine import FusionEngine
from fusion.mock_person1 import generate_frames_finite


def main():
    # Same setup as run_fusion
    camera_ids = ["cam_1", "cam_2", "cam_3"]
    engine = FusionEngine(match_radius_m=3.0, track_ttl_sec=5.0)
    for cs in [
        CameraState(agent_id="cam_1", position=[0.0, 0.0], heading=45.0, timestamp=0.0),
        CameraState(agent_id="cam_2", position=[10.0, 0.0], heading=135.0, timestamp=0.0),
        CameraState(agent_id="cam_3", position=[5.0, 8.0], heading=270.0, timestamp=0.0),
    ]:
        engine.update_camera_state(cs)

    # Generate mock Person 1 data (small batch for readable demo)
    num_frames = 12
    frames = generate_frames_finite(
        camera_ids=camera_ids,
        num_tracks_per_camera=2,
        num_frames=num_frames,
        fps=5.0,
    )

    # ---- Show INPUT: first 3 Person 1 frames (one per camera at t=0) ----
    print("=" * 60)
    print("PERSON 1 INPUT (mock) — sample frames (first 3)")
    print("=" * 60)
    for i, fd in enumerate(frames[:3]):
        print(json.dumps(fd, indent=2))
        print()

    # Run fusion on all frames
    for fd in frames:
        engine.process_frame(CameraFrame.from_dict(fd))

    # ---- Show OUTPUT: what Person 3 receives ----
    global_tracks = engine.get_global_tracks()
    payload = global_tracks_output(global_tracks)

    print("=" * 60)
    print("PERSON 3 OUTPUT (global tracks after fusion)")
    print("=" * 60)
    print(json.dumps(payload, indent=2))

    print()
    print("Summary: {} frames from {} cameras -> {} global tracks".format(
        len(frames), len(camera_ids), len(global_tracks)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
