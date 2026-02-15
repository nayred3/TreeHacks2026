# Fusion map viz

Interactive map of camera positions and fused global tracks on localhost.

## Run

From repo root:

```bash
pip install -r fusion/viz/requirements.txt
python -m fusion.viz.app
```

Then open **http://127.0.0.1:5050** in your browser. To use another port: `PORT=8080 python -m fusion.viz.app`.

## What you get

- **Map**: 2D floor view (world coordinates in meters). Grid every 2 m.
- **Purple triangles**: Cameras/agents; tip = heading direction.
- **Colored circles**: Global tracks (fused people).
  - **Green**: just seen
  - **Yellow**: a moment ago
  - **Red**: last seen > ~1 s (stale)
- **Labels**: T1, T2, … on tracks; cam_1, cam_2, … under cameras.
- **Timeline**: Use the slider or **◀** / **▶** to advance timesteps. Tracks move over time. **Play** runs through steps automatically; **Pause** stops it.
- **Interactivity**: Hover any circle or camera for a tooltip. **Refresh data** re-runs fusion with new mock data.
