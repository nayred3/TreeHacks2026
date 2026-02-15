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

## Running the Backend (optional)

```bash
python -m backend.assignment              # Demo simulation
python -m backend.assignment --serve      # Start HTTP + WebSocket server
uvicorn backend.assignment:app --reload --port 8001   # Alternative server launch
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
├── backend/
│   ├── assignment.py       # Python entry point
│   ├── engine.py           # Assignment engine
│   ├── server.py           # FastAPI + WebSocket server
│   ├── demo.py             # Demo simulation
│   └── models.py           # Data models
├── package.json
└── vite.config.js
```
