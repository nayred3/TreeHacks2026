# Person 2 — Spatial Projection & Fusion

Converts per-camera detections (from Person 1) into world coordinates and merges them into **global tracks** for Person 3 (Assignment engine).

## Quick run (mock data → Person 3 output)

```bash
# From repo root
python -m fusion.run_fusion --frames 30 --out person3_input.json
```

## Inputs

### 1. Person 1 output (per-camera tracks)

Each item is a **CameraFrame**:

```json
{
  "camera_id": "cam_1",
  "timestamp": 171234234.5,
  "tracks": [
    { "track_id": 4, "bbox": [x1, y1, x2, y2], "confidence": 0.92 }
  ]
}
```

- `bbox`: pixel coordinates in camera image (e.g. 640×480).
- Provide as a **JSON array** of such objects when using `--person1-json path.json`.

### 2. Camera/agent state (position + heading)

Each camera must have a state so we can project to world:

```json
{
  "agent_id": "cam_1",
  "position": [x, y],
  "heading": 45,
  "timestamp": 171234234.5
}
```

- `position`: world coordinates in **meters**.
- `heading`: **degrees** (0 = +x, 90 = +y). Set via UI (Person 4) or `--camera-state-json`.

## Output for Person 3

```json
{
  "global_tracks": [
    {
      "id": 12,
      "position": [x, y],
      "confidence": 0.83,
      "last_seen": 171234234.5,
      "source_cameras": ["cam_1", "cam_2"]
    }
  ],
  "timestamp": 171234235.0
}
```

- **id**: stable global track ID.
- **position**: fused world (meters).
- **last_seen**: timestamp of last detection contributing to this track (for “last seen” UI).
- **source_cameras**: which cameras have seen this track (for debugging/overlay).

## CLI

```text
python -m fusion.run_fusion [OPTIONS]

  --frames N              Number of simulated frames (default 30)
  --fps F                 Simulated FPS (default 5)
  --out FILE              Write Person 3 JSON here (default: stdout)
  --cameras A,B,C         Camera IDs (default cam_1,cam_2,cam_3)
  --tracks-per-cam N      Mock tracks per camera (default 2)
  --person1-json FILE     Read Person 1 frames from JSON file
  --camera-state-json FILE Load camera states from JSON file
```

## Generate mock Person 1 data

```bash
python -m fusion.write_mock_person1_data
# Writes fusion/sample_person1_frames.json

# Then run fusion on that file:
python -m fusion.run_fusion --person1-json fusion/sample_person1_frames.json --out person3_input.json
```

## Integration

- **Person 1** sends CameraFrame messages (WebSocket/HTTP). Persist a batch to a JSON array and pass with `--person1-json`, or plug a small adapter in `run_fusion.py` to read from your API.
- **Person 4** (or your backend) provides camera state (click-to-place); save to JSON and pass with `--camera-state-json`, or push state into `FusionEngine.update_camera_state()` in a live loop.
- **Person 3** reads the `global_tracks` payload (from file or from a queue/WebSocket that this pipeline writes to).

No extra dependencies (stdlib only).
