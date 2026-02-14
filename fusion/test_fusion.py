#!/usr/bin/env python3
"""Smoke test: run fusion on mock data and assert output shape for Person 3.

Run from repo root:  python -m fusion.test_fusion
Or from fusion dir:  python test_fusion.py
"""

import json
import sys
import os

# Ensure repo root is on path so "fusion" package is found
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fusion.schemas import CameraFrame, CameraState, global_tracks_output
from fusion.fusion_engine import FusionEngine
from fusion.mock_person1 import generate_frames_finite


def test_fusion_pipeline():
    engine = FusionEngine(match_radius_m=3.0, track_ttl_sec=5.0)
    for cs in [
        CameraState(agent_id="cam_1", position=[0.0, 0.0], heading=45.0, timestamp=0.0),
        CameraState(agent_id="cam_2", position=[10.0, 0.0], heading=135.0, timestamp=0.0),
        CameraState(agent_id="cam_3", position=[5.0, 8.0], heading=270.0, timestamp=0.0),
    ]:
        engine.update_camera_state(cs)

    frames = generate_frames_finite(
        camera_ids=["cam_1", "cam_2", "cam_3"],
        num_tracks_per_camera=2,
        num_frames=20,
        fps=5.0,
    )
    for fd in frames:
        engine.process_frame(CameraFrame.from_dict(fd))

    tracks = engine.get_global_tracks()
    payload = global_tracks_output(tracks)

    assert "global_tracks" in payload
    assert "timestamp" in payload
    assert len(tracks) >= 1
    for t in tracks:
        assert hasattr(t, "id") and isinstance(t.id, int)
        assert hasattr(t, "position") and len(t.position) == 2
        assert hasattr(t, "confidence") and 0 <= t.confidence <= 1
        assert hasattr(t, "last_seen") and isinstance(t.last_seen, (int, float))
        assert hasattr(t, "source_cameras") and isinstance(t.source_cameras, list)

    # Person 3 contract: each element has id, position, confidence, last_seen, source_cameras
    for raw in payload["global_tracks"]:
        assert "id" in raw and "position" in raw and "confidence" in raw
        assert "last_seen" in raw and "source_cameras" in raw
        assert len(raw["position"]) == 2

    print("OK: fusion pipeline and Person 3 output schema verified.")
    return 0


if __name__ == "__main__":
    sys.exit(test_fusion_pipeline())
