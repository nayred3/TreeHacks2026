# Priority Assignment Engine

## Running the Frontend

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the dev server:**
   ```bash
   ./node_modules/.bin/vite
   ```

3. **Open in browser:**
   Visit the URL shown in the terminal (typically `http://localhost:5173/`).

## Live Demo

When **LIVE DEMO** is pressed, the frontend polls fusion camera data and plots agents (cameras) and targets (fused tracks) on the map.

### Option A: Real-time camera pipeline (camera position + target detection)

1. **Start the live fusion server** (optionally spawns camera automatically):
   ```bash
   python -m fusion.live_fusion --with-camera
   ```
   With `--with-camera`, live_fusion spawns camera.py (webcam + YOLO + MJPEG stream). Without it, start camera.py separately (see step 2).

2. **Start camera.py** (if not using `--with-camera`):
   ```bash
   python computervision/camera.py --camera-id cam1 --source 0 --show \
       --emit camera+tracks --cam-x 0 --cam-y 0 --yaw-deg 0 --hfov-deg 70 \
       --udp-port 5055 --stream-port 5056
   ```

3. **Start the frontend** (`npm run dev` or `./node_modules/.bin/vite`) and click **LIVE DEMO**.
   The Live Demo page shows camera feeds at the top and the fusion map (agents + targets) below.

### Option B: Simulated data (no camera)

1. **Start the cam_view server** (simulated fusion data):
   ```bash
   python -m fusion.cam_view.app
   ```
   Runs on port 5051 by default.

2. **Start the frontend** and click **LIVE DEMO**.

If no server is running on 5051, the frontend falls back to mock data. The frontend proxies `/api/fusion/map` → `http://127.0.0.1:5051/api/map`. Cameras become agents; fused_tracks become targets. Coordinates are converted from the fusion room (0–12 m × 0–10 m) to the frontend canvas.

## Running the Backend (optional)

```bash
python -m assignment_model.assignment              # Demo simulation
python -m assignment_model.assignment --serve      # Start HTTP + WebSocket server
uvicorn assignment_model.assignment:app --reload --port 8001   # Alternative server launch
```

## Project Structure

```
├── index.html              # HTML entry point
├── main.jsx                # React entry point
├── frontend/
│   ├── App.jsx             # Main React component (UI, controls, tabs)
│   ├── config.js           # World constants, colors, thresholds
│   ├── utils.js            # Math utilities (euclidean, randomWalk)
│   ├── assignment.js       # Priority assignment algorithm (P1/P2/proximity)
│   ├── canvas.js           # Canvas renderer
│   ├── distances.js        # Distance matrix computation
│   └── pathfinding.js      # A* pathfinding
├── assignment_model/
│   ├── assignment.py       # Python entry point
│   ├── engine.py           # Assignment engine
│   ├── server.py           # FastAPI + WebSocket server
│   ├── demo.py             # Demo simulation
│   └── models.py           # Data models
├── package.json
└── vite.config.js
```
