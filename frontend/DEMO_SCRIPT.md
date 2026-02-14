# Demo Script – Priority Assignment Engine

## Quick demo: labels clarity + staleness + inspector

### 1. Start the app
```bash
cd frontend && npm run dev
```
Open the app in browser (usually http://localhost:5173).

### 2. Labels clarity
- **Start demo** – Click "Start demo" in Demo Controls.
- **Legend** – Top-left legend shows: agents (Responders), targets (pins), P1 solid / P2 dashed, fade/staleness meaning.
- **Badges** – Each dot has a short badge (A1, A2, A3 for agents; T1, T2, T3 for targets).
- **Priority panel** – Right panel shows Responder Alpha/Bravo/Charlie and target names (Victim T1, Hazard T2, etc.).

### 3. Staleness demo
- **Occlude random target** – In "Mock controls", click "Occlude random target (5s)". One target stops updating visibility; its "last seen" count increases and it fades. After ~8s it shows a STALE badge.
- **Scatter** – Click "SCATTER" in the top bar. Targets teleport to random positions; some move outside agents' vision radius (180 units). Those targets start fading as their "last seen" grows.
- **Move targets** – Turn ON "Move targets" in Mock controls. Targets drift randomly; they often leave vision range and become stale.

### 4. Inspector + interaction
- **Click a dot** – Click an agent or target dot on the map.
- **Inspector** – Selected entity details appear in the right panel: displayName, id, type, last seen, visibleNow, confidence, assigned agent.
- **Actions** – For targets: "Focus" (center map on it), "Occlude (5s)" (mock-only, makes it stale).
- **Escape** – Press Esc to clear selection.
- **NEUTRALISE** – With a target selected, click "NEUTRALISE" to remove it. Without selection, removes the last target.

### 5. Top bar controls
- **PAUSE** – Stops simulation clock; last-seen timers freeze.
- **ZONES** – Toggle zone overlay (dashed rectangles on map).
- **SPAWN** – Add a new target at a random position.
- **SCATTER** – Randomize all target positions.

### 6. Focus
- Select a target or agent.
- Click "Focus" in the inspector.
- Map pans so the selected entity is centered.
