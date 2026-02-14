#!/usr/bin/env python3
"""
Camera Perspective Visualization Server.
Shows the map from each camera's point of view — camera centred,
heading pointing up, with all tracked people and other cameras around it.

Run:  python -m fusion.cam_view.app
"""

import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from flask import Flask, send_from_directory, jsonify

# Reuse the data-generation logic from the main viz
from fusion.viz.app import get_fusion_data

app = Flask(__name__, static_folder="static", static_url_path="")


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/map")
def api_map():
    return jsonify(get_fusion_data())


def main():
    port = int(os.environ.get("CAM_VIEW_PORT", 5051))
    print(f"Camera Perspective Viz → http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False)


if __name__ == "__main__":
    main()
