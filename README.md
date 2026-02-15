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

1. **Start the fusion cam_view server** (provides `/api/map`):
   ```bash
   python -m fusion.cam_view.app
   ```
   Runs on port 5051 by default.

2. **Start the frontend** (`npm run dev`) and click **LIVE DEMO**.

The frontend proxies `/api/fusion/map` → `http://127.0.0.1:5051/api/map`. Cameras become agents; fused_tracks become targets. Coordinates are converted from the fusion room (0–12 m × 0–10 m) to the frontend canvas.

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
