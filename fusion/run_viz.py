#!/usr/bin/env python3
"""
Launch both visualization servers with one command.

  python -m fusion.run_viz

- Fusion Map (global view)      → http://127.0.0.1:5050
- Camera Perspective View       → http://127.0.0.1:5051
"""

import sys
import os
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def start_global_viz():
    from fusion.viz.app import app as global_app
    global_app.run(host="127.0.0.1", port=5050, debug=False, use_reloader=False)


def start_cam_viz():
    from fusion.cam_view.app import app as cam_app
    cam_app.run(host="127.0.0.1", port=5051, debug=False, use_reloader=False)


def main():
    print("Starting both visualization servers…")
    print("  Fusion Map (global)      → http://127.0.0.1:5050")
    print("  Camera Perspective View  → http://127.0.0.1:5051")
    print()

    t1 = threading.Thread(target=start_global_viz, daemon=True)
    t2 = threading.Thread(target=start_cam_viz, daemon=True)
    t1.start()
    t2.start()

    try:
        t1.join()
        t2.join()
    except KeyboardInterrupt:
        print("\nShutting down both servers.")
        sys.exit(0)


if __name__ == "__main__":
    main()
