#!/usr/bin/env python3
"""
Final pipeline: Camera Feed → Overhead Map Positions.

Takes ONLY camera-observable data as input:
  - Camera location (x, y) in world metres
  - Camera heading (degrees)
  - Bounding boxes [x1, y1, x2, y2] detected in each camera frame

Produces:
  - Fused world positions for every tracked person
  - "Last seen" positions for people no longer visible to any camera

Validates by comparing fused estimates against hidden ground truth.

Usage:
    python -m fusion.camera_feed_pipeline            # default 10s demo
    python -m fusion.camera_feed_pipeline --seconds 5 --fps 10
"""

import math
import sys
import os
import argparse
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# Ensure repo root on path
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from fusion.schemas import CameraState, CameraFrame, TrackDetection
from fusion.camera_estimator import CameraConfig, estimate_position, world_to_bbox
from fusion.fusion_engine import FusionEngine
from fusion.mock_person1 import get_ground_truth_positions
from fusion.viz.walls import WALLS, has_los


# ──────────────────────────────────────────────────────────────
#  Configuration
# ──────────────────────────────────────────────────────────────

IMAGE_WIDTH = 640
IMAGE_HEIGHT = 480
HFOV_DEG = 60.0
CONE_RANGE = 8.0       # metres — max detection range per camera
NUM_PEOPLE = 3

# 3 fixed cameras + 1 mobile patrol camera
STATIC_CAMERAS = [
    CameraConfig(camera_id="cam_1", x=0.0,  y=0.0, heading_deg=45.0,
                 hfov_deg=HFOV_DEG, image_width=IMAGE_WIDTH, image_height=IMAGE_HEIGHT),
    CameraConfig(camera_id="cam_2", x=10.0, y=0.0, heading_deg=135.0,
                 hfov_deg=HFOV_DEG, image_width=IMAGE_WIDTH, image_height=IMAGE_HEIGHT),
    CameraConfig(camera_id="cam_3", x=5.0,  y=8.0, heading_deg=270.0,
                 hfov_deg=HFOV_DEG, image_width=IMAGE_WIDTH, image_height=IMAGE_HEIGHT),
]


# ──────────────────────────────────────────────────────────────
#  Last-seen tracker (sits on top of FusionEngine)
# ──────────────────────────────────────────────────────────────

@dataclass
class TrackedPerson:
    """A person as seen by the pipeline — current or last-known state."""
    track_id: int
    position: List[float]           # [x, y] metres (fused estimate)
    confidence: float
    last_seen_time: float           # timestamp when last actively detected
    source_cameras: List[str]       # cameras that contributed
    visible: bool = True            # True if seen this frame

@dataclass
class LastSeen:
    """Snapshot of a track when it was last visible."""
    position: List[float]
    time: float
    source_cameras: List[str]


class CameraFeedPipeline:
    """
    Complete pipeline: camera feeds in → tracked positions out.

    Each tick:
      1. Accept per-camera detections (camera config + bboxes).
      2. Estimate world position from each (camera_location, bbox).
      3. Fuse across cameras with FusionEngine.
      4. Maintain last-seen memory for disappeared tracks.
    """

    def __init__(
        self,
        match_radius_m: float = 3.0,
        track_ttl_sec: float = 5.0,
        last_seen_ttl_sec: float = 30.0,
    ):
        self._engine = FusionEngine(
            match_radius_m=match_radius_m,
            track_ttl_sec=track_ttl_sec,
        )
        self._last_seen: Dict[int, LastSeen] = {}
        self._last_seen_ttl = last_seen_ttl_sec

        # Register camera states so the engine's internal projection works
        # (we also do our own estimation — the engine uses projection.py)
        for cc in STATIC_CAMERAS:
            self._engine.update_camera_state(CameraState(
                agent_id=cc.camera_id,
                position=[cc.x, cc.y],
                heading=cc.heading_deg,
                timestamp=0.0,
            ))

    # ── public API ────────────────────────────────────────────

    def process_camera_frame(
        self,
        camera: CameraConfig,
        bboxes: List[dict],
        timestamp: float,
    ) -> None:
        """
        Feed one camera's detections into the pipeline.

        Parameters
        ----------
        camera : CameraConfig
            Camera location, heading, FOV, image size.
        bboxes : list of dict
            Each dict has at minimum:
              ``track_id``  (int)  — person identifier from detector
              ``bbox``      (list) — [x1, y1, x2, y2] in pixels
              ``confidence`` (float)
        timestamp : float
            Current simulation / real time in seconds.
        """
        # Make sure engine knows about this camera's current state
        self._engine.update_camera_state(CameraState(
            agent_id=camera.camera_id,
            position=[camera.x, camera.y],
            heading=camera.heading_deg,
            timestamp=timestamp,
        ))

        tracks = [
            TrackDetection(
                track_id=b["track_id"],
                bbox=b["bbox"],
                confidence=b["confidence"],
            )
            for b in bboxes
        ]
        frame = CameraFrame(
            camera_id=camera.camera_id,
            timestamp=timestamp,
            tracks=tracks,
        )
        self._engine.process_frame(frame)

    def get_tracked_persons(self, now: float) -> List[TrackedPerson]:
        """
        Return every person the system knows about:
          - Currently visible tracks (from FusionEngine)
          - Last-seen-only tracks (dropped by FusionEngine but within memory TTL)
        """
        active = self._engine.get_global_tracks()
        active_ids = set()
        result: List[TrackedPerson] = []

        # Currently visible
        for gt in active:
            active_ids.add(gt.id)
            result.append(TrackedPerson(
                track_id=gt.id,
                position=list(gt.position),
                confidence=gt.confidence,
                last_seen_time=gt.last_seen,
                source_cameras=list(gt.source_cameras),
                visible=True,
            ))
            # Update last-seen snapshot
            self._last_seen[gt.id] = LastSeen(
                position=list(gt.position),
                time=gt.last_seen,
                source_cameras=list(gt.source_cameras),
            )

        # Last-seen only (no longer actively tracked)
        expired = []
        for tid, ls in self._last_seen.items():
            if tid in active_ids:
                continue
            age = now - ls.time
            if age > self._last_seen_ttl:
                expired.append(tid)
                continue
            result.append(TrackedPerson(
                track_id=tid,
                position=list(ls.position),
                confidence=0.0,
                last_seen_time=ls.time,
                source_cameras=list(ls.source_cameras),
                visible=False,
            ))
        for tid in expired:
            del self._last_seen[tid]

        return result

    def get_per_camera_estimates(
        self,
        camera: CameraConfig,
        bboxes: List[dict],
    ) -> List[dict]:
        """
        Run the estimator for a single camera — useful for debugging.
        Returns one dict per detection with estimated world position,
        distance, bearing, bbox dimensions.
        """
        results = []
        for b in bboxes:
            est = estimate_position(camera, b["bbox"])
            results.append({
                "track_id": b["track_id"],
                "bbox": b["bbox"],
                "bbox_width": round(b["bbox"][2] - b["bbox"][0], 1),
                "bbox_height": round(b["bbox"][3] - b["bbox"][1], 1),
                "estimated_position": [round(est.world_x, 3), round(est.world_y, 3)],
                "distance_m": round(est.distance_m, 3),
                "bearing_deg": round(est.bearing_deg, 1),
                "uncertainty_m": round(est.uncertainty_m, 3),
                "camera_id": camera.camera_id,
                "camera_position": [camera.x, camera.y],
            })
        return results


# ──────────────────────────────────────────────────────────────
#  Simulated camera feed generator
# ──────────────────────────────────────────────────────────────

def simulate_camera_detections(
    camera: CameraConfig,
    ground_truth: List[dict],
    walls: list,
) -> List[dict]:
    """
    Simulate what a camera would detect given hidden ground truth.
    Checks LOS, range, FOV; generates a bbox from the pinhole model.

    Returns list of {track_id, bbox, confidence} — the ONLY data
    the pipeline is allowed to see.
    """
    detections = []
    cam_pos = (camera.x, camera.y)
    for gt in ground_truth:
        pid = gt["id"]
        pos = gt["position"]
        target = (pos[0], pos[1])

        # Range gate
        dx = pos[0] - camera.x
        dy = pos[1] - camera.y
        dist = math.sqrt(dx * dx + dy * dy)
        if dist > CONE_RANGE:
            continue

        # Wall occlusion
        if not has_los(cam_pos, target, walls):
            continue

        # Compute bbox (returns None if outside FOV)
        bbox = world_to_bbox(camera, pos[0], pos[1])
        if bbox is None:
            continue

        # Clamp to image bounds
        bbox = [
            max(0.0, min(float(camera.image_width), bbox[0])),
            max(0.0, min(float(camera.image_height), bbox[1])),
            max(0.0, min(float(camera.image_width), bbox[2])),
            max(0.0, min(float(camera.image_height), bbox[3])),
        ]

        conf = 0.85 + 0.1 * math.sin(dist * 0.7)
        detections.append({
            "track_id": pid,
            "bbox": bbox,
            "confidence": min(1.0, conf),
        })

    return detections


# ──────────────────────────────────────────────────────────────
#  Demo / validation runner
# ──────────────────────────────────────────────────────────────

def _dist(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)


def run_demo(seconds: float = 10.0, fps: float = 5.0, verbose: bool = True):
    """
    Run the full pipeline on simulated data and validate against ground truth.
    """
    dt = 1.0 / fps
    num_frames = int(seconds * fps)
    pipeline = CameraFeedPipeline(
        match_radius_m=3.0,
        track_ttl_sec=3.0,
        last_seen_ttl_sec=30.0,
    )

    cameras = list(STATIC_CAMERAS)

    total_errors = []
    frames_with_all_visible = 0
    frames_with_last_seen = 0

    print("=" * 72)
    print("  CAMERA FEED → OVERHEAD MAP PIPELINE")
    print("=" * 72)
    print(f"  Cameras:     {len(cameras)}")
    print(f"  People:      {NUM_PEOPLE}")
    print(f"  Duration:    {seconds}s @ {fps} fps ({num_frames} frames)")
    print(f"  Image size:  {IMAGE_WIDTH}x{IMAGE_HEIGHT}  HFOV: {HFOV_DEG}°")
    print(f"  Walls:       {len(WALLS)}")
    print()
    print("  Pipeline: camera_location + bbox → estimate_position → FusionEngine")
    print("            (no ground truth is visible to the pipeline)")
    print("=" * 72)
    print()

    for cam in cameras:
        print(f"  [{cam.camera_id}]  pos=({cam.x}, {cam.y})  heading={cam.heading_deg}°")
    print()

    # Header for per-frame output
    if verbose:
        print("-" * 72)

    for fi in range(num_frames):
        t = fi * dt

        # ── Step 1: Hidden ground truth (only used by the camera simulator) ──
        ground_truth = get_ground_truth_positions(t, NUM_PEOPLE)

        # ── Step 2: Each camera produces bboxes (the only data we feed in) ──
        all_detections: Dict[str, List[dict]] = {}
        for cam in cameras:
            dets = simulate_camera_detections(cam, ground_truth, WALLS)
            all_detections[cam.camera_id] = dets
            pipeline.process_camera_frame(cam, dets, t)

        # ── Step 3: Read fused tracks + last-seen positions ──
        tracked = pipeline.get_tracked_persons(t)
        visible = [p for p in tracked if p.visible]
        last_seen_only = [p for p in tracked if not p.visible]

        if len(visible) == NUM_PEOPLE:
            frames_with_all_visible += 1
        if last_seen_only:
            frames_with_last_seen += 1

        # ── Step 4: Validate against ground truth ──
        frame_errors = []
        for gt in ground_truth:
            true_pos = gt["position"]
            # Find the closest visible track
            best_err = None
            for v in visible:
                err = _dist(v.position, true_pos)
                if best_err is None or err < best_err:
                    best_err = err
            if best_err is not None:
                frame_errors.append(best_err)
                total_errors.append(best_err)

        # ── Print frame summary (sampled) ──
        if verbose and (fi % max(1, num_frames // 20) == 0 or fi == num_frames - 1):
            total_dets = sum(len(d) for d in all_detections.values())
            det_summary = "  ".join(
                f"{cid}: {len(dets)}" for cid, dets in all_detections.items()
            )
            avg_err = (sum(frame_errors) / len(frame_errors)) if frame_errors else float("nan")

            print(f"  t={t:6.2f}s  |  detections: [{det_summary}]")
            print(f"           |  visible tracks: {len(visible)}  "
                  f"last-seen: {len(last_seen_only)}  "
                  f"avg error: {avg_err:.3f}m")

            for v in visible:
                src = ",".join(v.source_cameras)
                print(f"           |    Track {v.track_id:2d}  "
                      f"pos=({v.position[0]:6.2f}, {v.position[1]:6.2f})  "
                      f"conf={v.confidence:.2f}  src=[{src}]")

            for ls in last_seen_only:
                age = t - ls.last_seen_time
                print(f"           |    Track {ls.track_id:2d}  "
                      f"LAST SEEN ({age:.1f}s ago)  "
                      f"pos=({ls.position[0]:6.2f}, {ls.position[1]:6.2f})")
            print()

    # ── Summary ──
    print("=" * 72)
    print("  VALIDATION SUMMARY")
    print("=" * 72)
    if total_errors:
        avg = sum(total_errors) / len(total_errors)
        med = sorted(total_errors)[len(total_errors) // 2]
        p90 = sorted(total_errors)[int(len(total_errors) * 0.9)]
        worst = max(total_errors)
        print(f"  Estimation error (fused position vs ground truth):")
        print(f"    Mean:   {avg:.3f} m")
        print(f"    Median: {med:.3f} m")
        print(f"    P90:    {p90:.3f} m")
        print(f"    Worst:  {worst:.3f} m")
    else:
        print("  No matched detections (check camera coverage).")
    print()
    print(f"  Frames with all {NUM_PEOPLE} people visible: "
          f"{frames_with_all_visible}/{num_frames} "
          f"({100*frames_with_all_visible/num_frames:.0f}%)")
    print(f"  Frames using last-seen memory:       "
          f"{frames_with_last_seen}/{num_frames} "
          f"({100*frames_with_last_seen/num_frames:.0f}%)")
    print()

    # ── Per-camera estimate example (last frame) ──
    print("-" * 72)
    print("  PER-CAMERA ESTIMATES (final frame)")
    print("-" * 72)
    for cam in cameras:
        dets = all_detections[cam.camera_id]
        if not dets:
            print(f"  [{cam.camera_id}]  no detections")
            continue
        ests = pipeline.get_per_camera_estimates(cam, dets)
        for e in ests:
            print(f"  [{cam.camera_id}]  Track {e['track_id']}  "
                  f"bbox={e['bbox_width']:.0f}x{e['bbox_height']:.0f}px  "
                  f"dist={e['distance_m']:.2f}m  "
                  f"bearing={e['bearing_deg']:.0f}°  "
                  f"→ est=({e['estimated_position'][0]:.2f}, {e['estimated_position'][1]:.2f})  "
                  f"±{e['uncertainty_m']:.2f}m")
    print()

    # ── Final tracked state ──
    print("-" * 72)
    print("  FINAL MAP STATE")
    print("-" * 72)
    final = pipeline.get_tracked_persons(num_frames * dt)
    for p in sorted(final, key=lambda x: x.track_id):
        status = "VISIBLE" if p.visible else f"LAST SEEN {num_frames*dt - p.last_seen_time:.1f}s ago"
        src = ",".join(p.source_cameras)
        print(f"  Track {p.track_id:2d}  {status:30s}  "
              f"pos=({p.position[0]:6.2f}, {p.position[1]:6.2f})  "
              f"src=[{src}]")
    print()

    return total_errors


# ──────────────────────────────────────────────────────────────
#  Entrypoint
# ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Camera Feed → Overhead Map pipeline demo"
    )
    parser.add_argument("--seconds", type=float, default=10.0,
                        help="Simulation duration in seconds (default: 10)")
    parser.add_argument("--fps", type=float, default=5.0,
                        help="Frames per second (default: 5)")
    parser.add_argument("-q", "--quiet", action="store_true",
                        help="Suppress per-frame output")
    args = parser.parse_args()
    run_demo(seconds=args.seconds, fps=args.fps, verbose=not args.quiet)
