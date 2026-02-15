# How to Demo – Priority Assignment Engine

## Quick start
```bash
cd frontend
npm run dev
```
Open http://localhost:5173/

---

## Demo flow (30–60 seconds)

### 1. Start the demo
- Click **Start demo** in the right panel.
- Responders (cyan/magenta/yellow) begin moving; targets (orange) appear on the map.
- Say: *"This is our live view of responders and targets. We assign the nearest target to each responder."*

### 2. Enable the rescue loop
- In **Rescue mission**, turn **Run mission (auto)** **ON**.
- Responders move toward their assigned targets (bright cyan lines).
- Say: *"Responders automatically move to their assigned targets. When they reach one, we mark it rescued and assign the next nearest."*

### 3. Show last-seen / LOS dropouts
- Turn **Simulate LOS dropouts** **ON**.
- Some targets are temporarily hidden (e.g. behind obstacles).
- Their **Last seen** timer increases and the badge switches to **LOST**.
- Say: *"Targets can leave line-of-sight. When that happens, last-seen time increases and we show a LOST badge until we see them again."*
- Turn **Simulate LOS dropouts** **OFF** to show them reappear.

### 4. Pause / unpause
- Click **PAUSE** in the header.
- Time and movement freeze.
- Click **UNPAUSE** to resume.
- Say: *"We can pause at any time to inspect the current state."*

### 5. Manual occlusion
- Click a target on the map (orange dot).
- In the inspector, click **Occlude (5s)**.
- That target is hidden for 5 seconds; last-seen increases and it shows LOST.
- Say: *"We can manually occlude targets to test staleness handling."*

### 6. Reset and demo script
- Click **Reset state** to start over.
- Or click **Demo Script (30s)** to run an automated sequence:
  - Starts the demo
  - Enables the rescue mission
  - Turns LOS dropouts on for ~12 seconds
  - Resets after 30 seconds

---

## Buttons cheat sheet

| Button | Action |
|--------|--------|
| **PAUSE / UNPAUSE** | Freeze / resume simulation time |
| **Start demo** | Start mock backend / movement |
| **Reset state** | Stop and reset world state |
| **Run mission (auto)** | Auto-assign and rescue loop |
| **Simulate LOS dropouts** | Periodically hide targets to drive last-seen |
| **Occlude random target (5s)** | Hide a random target for 5 seconds |
| **Step once** | Single mission step (when mission running) |
| **Reset mission** | Clear assignments and resume mission logic |
| **Demo Script (30s)** | Automated 30-second demo run |
| **SPAWN** | Add a new target |
| **NEUTRALISE** | Remove selected or last target |
| **SCATTER** | Randomize target positions (often out of LOS) |
| **CENTER** | Reset map offset |

---

## What to narrate

1. **Assignment**: *"Responders are assigned to the nearest unassigned target. Solid lines are primary (P1), dashed are secondary (P2)."*
2. **Rescue loop**: *"On arrival, we mark the target rescued and reassign the responder to the next nearest target."*
3. **Last-seen**: *"When a target leaves line-of-sight, last-seen increases and we show LOST. This drives uncertainty and reacquisition."*
4. **Future backend**: *"This runs on fixtures and mocks. We have a WorldStateAdapter so we can swap to live WebSocket/API streams later."*
