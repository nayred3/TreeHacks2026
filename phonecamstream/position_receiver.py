#!/usr/bin/env python3
"""
Position Receiver — runs on Justin's Mac (10.35.6.219)

Receives camera position + heading from iPhones via UDP JSON packets.
Data matches the `CameraState` schema in fusion/schemas.py.

Usage:
    python position_receiver.py

The iPhones send UDP datagrams to port 5056:
{
    "type":       "camera_state",
    "camera_id":  "phone_1",
    "position":   [x, y],       // metres from central phone
    "heading":    123.4,         // degrees (0 = +x/East, 90 = +y/North)
    "timestamp":  1700000000.123
}
"""

import socket
import json
import time
import sys
import os

# Add repo root so we can import fusion schemas if needed
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

PORT = 5056


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", PORT))

    print("=" * 60)
    print("  POSITION RECEIVER")
    print("=" * 60)
    print(f"  Listening on : UDP 0.0.0.0:{PORT}")
    print()
    print("  Expecting JSON packets from iPhones with:")
    print("    type, camera_id, position, heading, timestamp")
    print("=" * 60)
    print()

    camera_stats = {}

    while True:
        data, addr = sock.recvfrom(65535)
        try:
            msg = json.loads(data.decode("utf-8"))
        except Exception as e:
            print(f"  Bad packet from {addr}: {e}")
            continue

        msg_type   = msg.get("type", "?")
        camera_id  = msg.get("camera_id", "?")
        position   = msg.get("position", [0, 0])
        heading    = msg.get("heading", 0)
        timestamp  = msg.get("timestamp", 0)

        # Track stats
        if camera_id not in camera_stats:
            camera_stats[camera_id] = 0
        camera_stats[camera_id] += 1
        count = camera_stats[camera_id]

        print(
            f"  [{camera_id}] #{count:5d}  "
            f"pos=({position[0]:7.2f}, {position[1]:7.2f})  "
            f"heading={heading:6.1f}°  "
            f"ts={timestamp:.3f}  "
            f"from={addr[0]}"
        )


if __name__ == "__main__":
    main()
