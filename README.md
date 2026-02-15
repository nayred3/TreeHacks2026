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

## Project Structure

```
├── index.html              # HTML entry point
├── main.jsx                # React entry point
├── frontend/
│   ├── App.jsx             # Main React component (UI, controls, tabs)
│   ├── config.js           # World constants, colors, thresholds
│   ├── utils.js            # Math utilities (euclidean, randomWalk)
│   ├── distances.js        # Distance matrix computation
│   ├── assignment.js       # Priority assignment algorithm (P1/P2/proximity)
│   └── canvas.js           # Canvas renderer
├── server.py               # Backend server
├── engine.py               # Python engine
├── assignment.py           # Python assignment logic
└── models.py               # Data models
```
