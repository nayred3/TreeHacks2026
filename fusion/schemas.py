"""
JSON schemas and types for Person 2 (Spatial Projection & Fusion).

Contracts:
- INPUT from Person 1: per-camera tracks (bbox, track_id, confidence)
- INPUT: camera/agent state (position, heading, timestamp)
- OUTPUT for Person 3: global_tracks (id, position, confidence, last_seen)
"""

from dataclasses import dataclass, field
from typing import List, Optional
import json
import time


# --- Person 1 output (what we consume) ---

@dataclass
class TrackDetection:
    """Single track from one camera frame."""
    track_id: int
    bbox: List[float]  # [x1, y1, x2, y2] in image pixels
    confidence: float


@dataclass
class CameraFrame:
    """One frame of detections from one camera (Person 1 output)."""
    camera_id: str
    timestamp: float  # Unix ms or seconds
    tracks: List[TrackDetection]

    def to_dict(self):
        return {
            "camera_id": self.camera_id,
            "timestamp": self.timestamp,
            "tracks": [
                {"track_id": t.track_id, "bbox": t.bbox, "confidence": t.confidence}
                for t in self.tracks
            ],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "CameraFrame":
        return cls(
            camera_id=d["camera_id"],
            timestamp=float(d["timestamp"]),
            tracks=[
                TrackDetection(
                    track_id=tr["track_id"],
                    bbox=list(tr["bbox"]),
                    confidence=float(tr["confidence"]),
                )
                for tr in d["tracks"]
            ],
        )


# --- Camera/agent state (position + heading) ---

@dataclass
class CameraState:
    """Position and orientation of a camera/agent in world coordinates."""
    agent_id: str  # same as camera_id in frames
    position: List[float]  # [x, y] in meters (world)
    heading: float  # degrees, 0 = +x, 90 = +y (or your convention)
    timestamp: float

    def to_dict(self):
        return {
            "agent_id": self.agent_id,
            "position": self.position,
            "heading": self.heading,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "CameraState":
        return cls(
            agent_id=d["agent_id"],
            position=list(d["position"]),
            heading=float(d["heading"]),
            timestamp=float(d["timestamp"]),
        )


# --- Output for Person 3 (Assignment engine) ---

@dataclass
class GlobalTrack:
    """Fused track in world space."""
    id: int
    position: List[float]  # [x, y] meters
    confidence: float
    last_seen: float  # timestamp
    source_cameras: List[str] = field(default_factory=list)
    history: List[dict] = field(default_factory=list)  # optional for debugging

    def to_dict(self):
        return {
            "id": self.id,
            "position": self.position,
            "confidence": self.confidence,
            "last_seen": self.last_seen,
            "source_cameras": self.source_cameras,
        }


def global_tracks_output(global_tracks: List[GlobalTrack]) -> dict:
    """Exact format Person 3 consumes."""
    return {
        "global_tracks": [t.to_dict() for t in global_tracks],
        "timestamp": time.time(),
    }


def write_person3_format(global_tracks: List[GlobalTrack], path: str) -> None:
    with open(path, "w") as f:
        json.dump(global_tracks_output(global_tracks), f, indent=2)
