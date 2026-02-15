"""
Multi-camera fusion: merge per-camera world projections into global tracks.

- Maintain global track table (id -> position, confidence, last_seen, source_cameras).
- Match new detections to existing tracks by radius gate.
- Weighted average position by confidence; aggregate confidence; update last_seen.
- TTL: drop tracks not seen for a while.
"""

import math
from typing import Dict, List, Optional

from fusion.schemas import CameraFrame, CameraState, GlobalTrack, TrackDetection
from fusion.projection import project_detection_to_world

# Match radius in meters: detections within this distance merge into same track
MATCH_RADIUS_M = 3.0
# Drop tracks not seen for this many seconds
TRACK_TTL_SEC = 5.0


def _dist(world_a: List[float], world_b: List[float]) -> float:
    return math.sqrt((world_a[0] - world_b[0]) ** 2 + (world_a[1] - world_b[1]) ** 2)


class FusionEngine:
    def __init__(
        self,
        match_radius_m: float = MATCH_RADIUS_M,
        track_ttl_sec: float = TRACK_TTL_SEC,
    ):
        self.match_radius_m = match_radius_m
        self.track_ttl_sec = track_ttl_sec
        self._global_tracks: Dict[int, GlobalTrack] = {}
        self._next_global_id = 1
        self._camera_states: Dict[str, CameraState] = {}

    def update_camera_state(self, state: CameraState) -> None:
        self._camera_states[state.agent_id] = state

    def get_camera_state(self, camera_id: str) -> Optional[CameraState]:
        return self._camera_states.get(camera_id)

    def process_frame(self, frame: CameraFrame) -> None:
        camera = self.get_camera_state(frame.camera_id)
        if not camera:
            return
        now = frame.timestamp
        # Project each detection to world
        candidates: List[tuple] = []
        for t in frame.tracks:
            try:
                wx, wy, conf = project_detection_to_world(t, camera)
                candidates.append((wx, wy, conf, frame.camera_id))
            except Exception:
                continue
        # Match or create global tracks
        used = set()
        for (wx, wy, conf, cam_id) in candidates:
            pos = [wx, wy]
            best_id = None
            best_dist = self.match_radius_m
            for gid, gt in self._global_tracks.items():
                if gid in used:
                    continue
                d = _dist(gt.position, pos)
                if d < best_dist:
                    best_dist = d
                    best_id = gid
            if best_id is not None:
                # Merge into existing track (weighted average by confidence)
                gt = self._global_tracks[best_id]
                w_old = gt.confidence
                w_new = conf
                total = w_old + w_new
                gt.position = [
                    (gt.position[0] * w_old + wx * w_new) / total,
                    (gt.position[1] * w_old + wy * w_new) / total,
                ]
                gt.confidence = min(1.0, (gt.confidence + conf) / 2.0)
                gt.last_seen = now
                if cam_id not in gt.source_cameras:
                    gt.source_cameras.append(cam_id)
                used.add(best_id)
            else:
                # New global track
                self._global_tracks[self._next_global_id] = GlobalTrack(
                    id=self._next_global_id,
                    position=[wx, wy],
                    confidence=conf,
                    last_seen=now,
                    source_cameras=[cam_id],
                )
                self._next_global_id += 1
        # TTL: remove stale tracks
        to_drop = [
            gid for gid, gt in self._global_tracks.items()
            if (now - gt.last_seen) > self.track_ttl_sec
        ]
        for gid in to_drop:
            del self._global_tracks[gid]

    def get_global_tracks(self) -> List[GlobalTrack]:
        return list(self._global_tracks.values())
