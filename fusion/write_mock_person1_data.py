#!/usr/bin/env python3
"""
Write mock Person 1 output to a JSON file.
Person 1 (Vision) can replace this file with real API output; Person 2 reads via --person1-json.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fusion.mock_person1 import generate_frames_finite

def main():
    camera_ids = ["cam_1", "cam_2", "cam_3"]
    frames = generate_frames_finite(
        camera_ids=camera_ids,
        num_tracks_per_camera=2,
        num_frames=50,
        fps=5.0,
    )
    out_path = os.path.join(os.path.dirname(__file__), "sample_person1_frames.json")
    with open(out_path, "w") as f:
        json.dump(frames, f, indent=2)
    print(f"Wrote {len(frames)} frames to {out_path}", file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())
