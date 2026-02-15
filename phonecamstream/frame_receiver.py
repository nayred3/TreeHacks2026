#!/usr/bin/env python3
"""
Frame Receiver — runs on Logan's Mac (10.35.2.131)

Receives JPEG frames from iPhone cameras via HTTP POST.
Saves the latest frame per camera to disk so YOLO (or any other pipeline)
can pick them up.

Usage:
    pip install flask
    python frame_receiver.py

The iPhones POST to:
    POST http://<this-mac-ip>:5050/frame
    Headers:
        Content-Type: image/jpeg
        X-Camera-Id:  phone_1
        X-Timestamp:  <unix seconds>
    Body: raw JPEG bytes
"""

from flask import Flask, request, jsonify
import os
import time
import threading

app = Flask(__name__)

SAVE_DIR = "received_frames"
os.makedirs(SAVE_DIR, exist_ok=True)

# Stats per camera
stats = {}
stats_lock = threading.Lock()


@app.route("/frame", methods=["POST"])
def receive_frame():
    camera_id = request.headers.get("X-Camera-Id", "unknown")
    timestamp = request.headers.get("X-Timestamp", str(time.time()))

    jpeg_data = request.data
    if not jpeg_data:
        return jsonify({"error": "no data"}), 400

    # Save latest frame (overwrite) for each camera
    filepath = os.path.join(SAVE_DIR, f"{camera_id}_latest.jpg")
    with open(filepath, "wb") as f:
        f.write(jpeg_data)

    # Also keep a numbered copy for debugging (optional, comment out to save disk)
    # with stats_lock:
    #     count = stats.get(camera_id, {}).get("frames", 0)
    #     numbered = os.path.join(SAVE_DIR, f"{camera_id}_{count:06d}.jpg")
    #     with open(numbered, "wb") as f:
    #         f.write(jpeg_data)

    with stats_lock:
        if camera_id not in stats:
            stats[camera_id] = {"frames": 0, "bytes": 0, "first_seen": time.time()}
        stats[camera_id]["frames"] += 1
        stats[camera_id]["bytes"] += len(jpeg_data)
        stats[camera_id]["last_seen"] = float(timestamp)
        count = stats[camera_id]["frames"]

    print(
        f"[{camera_id}] frame #{count:5d}  "
        f"{len(jpeg_data):6d} bytes  "
        f"ts={timestamp}"
    )

    return jsonify({"status": "ok", "frame": count}), 200


@app.route("/status", methods=["GET"])
def status():
    """Quick health-check / stats endpoint."""
    with stats_lock:
        return jsonify(stats)


@app.route("/latest/<camera_id>", methods=["GET"])
def latest_frame(camera_id):
    """Serve the latest JPEG for a given camera (useful for debugging)."""
    filepath = os.path.join(SAVE_DIR, f"{camera_id}_latest.jpg")
    if not os.path.exists(filepath):
        return jsonify({"error": "no frame yet"}), 404
    return open(filepath, "rb").read(), 200, {"Content-Type": "image/jpeg"}


if __name__ == "__main__":
    print("=" * 60)
    print("  FRAME RECEIVER")
    print("=" * 60)
    print(f"  Listening on  : 0.0.0.0:5050")
    print(f"  POST endpoint : /frame")
    print(f"  Saving to     : {os.path.abspath(SAVE_DIR)}/")
    print()
    print("  iPhone app should POST JPEG frames to:")
    print("    http://<this-ip>:5050/frame")
    print("=" * 60)
    app.run(host="0.0.0.0", port=5050, debug=False, threaded=True)
