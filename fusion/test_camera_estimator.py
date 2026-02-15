#!/usr/bin/env python3
"""
Test & demo for the camera-based position estimator.

Generates fictitious camera data (known ground truth positions), runs them
through the estimator, and reports accuracy.  Also writes a JSON file of
test results that the camera-feed visualization can consume.

Run:  python -m fusion.test_camera_estimator
"""

import json
import math
import os
import sys
from typing import List

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from fusion.camera_estimator import (
    CameraConfig,
    PositionEstimate,
    estimate_position,
    estimation_error,
    is_in_fov,
    world_to_bbox,
)

# ── Camera setup ────────────────────────────────────────
CAMERAS = [
    CameraConfig(camera_id="cam_1", x=0.0,  y=0.0,  heading_deg=45.0),
    CameraConfig(camera_id="cam_2", x=10.0, y=0.0,  heading_deg=135.0),
    CameraConfig(camera_id="cam_3", x=5.0,  y=8.0,  heading_deg=270.0),
]

# ── Fictitious person positions (ground truth) ─────────
TEST_POSITIONS = [
    {"id": 1, "x": 3.0, "y": 3.0, "label": "centre-left"},
    {"id": 2, "x": 7.0, "y": 2.5, "label": "centre-right"},
    {"id": 3, "x": 5.0, "y": 6.0, "label": "upper-centre"},
    {"id": 4, "x": 1.5, "y": 1.0, "label": "near cam_1"},
    {"id": 5, "x": 9.5, "y": 1.0, "label": "near cam_2"},
    {"id": 6, "x": 5.0, "y": 7.5, "label": "near cam_3"},
    {"id": 7, "x": 6.0, "y": 4.0, "label": "mid-room"},
    {"id": 8, "x": 2.0, "y": 8.0, "label": "top-left corner"},
]


def add_bbox_noise(bbox: List[float], noise_px: float = 8.0, seed: int = 0) -> List[float]:
    """
    Add realistic noise to a bounding box (simulates imperfect detection).
    - Shifts centre by up to noise_px
    - Varies height by ±10%
    """
    import random
    rng = random.Random(seed)
    x1, y1, x2, y2 = bbox
    cx = (x1 + x2) / 2 + rng.gauss(0, noise_px * 0.5)
    cy = (y1 + y2) / 2 + rng.gauss(0, noise_px * 0.3)
    bw = (x2 - x1) * (1 + rng.gauss(0, 0.05))
    bh = (y2 - y1) * (1 + rng.gauss(0, 0.08))
    return [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2]


def run_test():
    """Generate bboxes from ground truth, estimate back, measure error."""
    print("=" * 70)
    print("  Camera-Based Position Estimator — Test Suite")
    print("=" * 70)
    print()

    # Print camera setup
    for cam in CAMERAS:
        print(f"  {cam.camera_id:8s}  pos=({cam.x:.1f}, {cam.y:.1f})  heading={cam.heading_deg:.0f}°  FOV={cam.hfov_deg:.0f}°")
    print()

    results = []
    total_errors_clean = []
    total_errors_noisy = []

    for person in TEST_POSITIONS:
        pid = person["id"]
        true_x, true_y = person["x"], person["y"]
        label = person["label"]

        print(f"─── Person {pid} ({label}) at ({true_x:.1f}, {true_y:.1f}) ───")

        for cam in CAMERAS:
            # Step 1: compute what bbox the camera would see (ground truth → image)
            bbox = world_to_bbox(cam, true_x, true_y)
            if bbox is None:
                print(f"  {cam.camera_id}: outside FOV")
                continue

            # Step 2a: estimate from clean bbox
            est_clean = estimate_position(cam, bbox)
            err_clean = estimation_error(est_clean, true_x, true_y)
            total_errors_clean.append(err_clean)

            # Step 2b: estimate from noisy bbox (simulates real detection)
            noisy_bbox = add_bbox_noise(bbox, noise_px=10.0, seed=pid * 100 + hash(cam.camera_id))
            est_noisy = estimate_position(cam, noisy_bbox)
            err_noisy = estimation_error(est_noisy, true_x, true_y)
            total_errors_noisy.append(err_noisy)

            # Bbox dimensions
            bw = bbox[2] - bbox[0]
            bh = bbox[3] - bbox[1]

            quality = "GOOD" if err_noisy < 0.5 else "OK" if err_noisy < 1.5 else "POOR"
            print(
                f"  {cam.camera_id}: bbox={bw:.0f}x{bh:.0f}px  "
                f"dist={est_noisy.distance_m:.2f}m  "
                f"est=({est_noisy.world_x:.2f}, {est_noisy.world_y:.2f})  "
                f"clean_err={err_clean:.3f}m  noisy_err={err_noisy:.3f}m  [{quality}]"
            )

            results.append({
                "person_id": pid,
                "label": label,
                "true_position": [true_x, true_y],
                "camera_id": cam.camera_id,
                "clean_bbox": [round(b, 1) for b in bbox],
                "noisy_bbox": [round(b, 1) for b in noisy_bbox],
                "bbox_size": [round(bw, 1), round(bh, 1)],
                "estimated_position_clean": [round(est_clean.world_x, 3), round(est_clean.world_y, 3)],
                "estimated_position_noisy": [round(est_noisy.world_x, 3), round(est_noisy.world_y, 3)],
                "estimated_distance": round(est_noisy.distance_m, 3),
                "bearing_deg": round(est_noisy.bearing_deg, 1),
                "angle_in_fov_deg": round(est_noisy.angle_in_fov_deg, 1),
                "uncertainty_m": round(est_noisy.uncertainty_m, 3),
                "error_clean_m": round(err_clean, 4),
                "error_noisy_m": round(err_noisy, 4),
            })
        print()

    # Summary stats
    print("=" * 70)
    print("  Summary")
    print("=" * 70)
    if total_errors_noisy:
        n = len(total_errors_noisy)
        avg_c = sum(total_errors_clean) / n
        avg_n = sum(total_errors_noisy) / n
        med_n = sorted(total_errors_noisy)[n // 2]
        mx_n = max(total_errors_noisy)
        good = sum(1 for e in total_errors_noisy if e < 0.5)
        ok = sum(1 for e in total_errors_noisy if 0.5 <= e < 1.5)
        poor = sum(1 for e in total_errors_noisy if e >= 1.5)
        print(f"  Total estimates:     {n}")
        print(f"  Clean mean error:    {avg_c:.3f} m  (perfect bboxes)")
        print(f"  Noisy mean error:    {avg_n:.3f} m  (simulated detection noise)")
        print(f"  Noisy median error:  {med_n:.3f} m")
        print(f"  Noisy max error:     {mx_n:.3f} m")
        print(f"  Quality:  {good} GOOD (<0.5m)  |  {ok} OK (0.5-1.5m)  |  {poor} POOR (>1.5m)")
    else:
        print("  No estimates produced — check camera/position setup.")
    print()

    # Write results JSON
    out_path = os.path.join(os.path.dirname(__file__), "test_estimator_results.json")
    payload = {
        "cameras": [
            {"id": c.camera_id, "x": c.x, "y": c.y, "heading_deg": c.heading_deg,
             "hfov_deg": c.hfov_deg, "image_width": c.image_width, "image_height": c.image_height}
            for c in CAMERAS
        ],
        "test_positions": TEST_POSITIONS,
        "results": results,
        "summary": {
            "count": len(total_errors_noisy),
            "mean_error_clean_m": round(avg_c, 4) if total_errors_noisy else None,
            "mean_error_noisy_m": round(avg_n, 4) if total_errors_noisy else None,
            "median_error_noisy_m": round(med_n, 4) if total_errors_noisy else None,
            "max_error_noisy_m": round(mx_n, 4) if total_errors_noisy else None,
        },
    }
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"  Results written to {out_path}")
    print()


if __name__ == "__main__":
    run_test()
