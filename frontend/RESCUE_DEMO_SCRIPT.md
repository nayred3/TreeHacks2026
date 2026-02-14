# Rescue Mission Demo Script

## Quick demo: Spawn → Run mission → Watch rescues → Reset

1. **Start the app**
   ```bash
   cd frontend && npm run dev
   ```
   Open http://localhost:5173.

2. **Start the demo**
   - Click **Start demo** in Demo Controls (starts the simulation tick).

3. **Spawn more targets**
   - Click **SPAWN** in the top bar several times to add targets.
   - Or click on the map to add pins (targets).

4. **Run the rescue mission**
   - In the **Rescue mission** section, turn **Run mission (auto)** ON.
   - Agents will assign to nearest unassigned targets and move toward them.
   - Watch the thick cyan lines (enroute) and ETA labels as agents travel.

5. **Watch rescues**
   - When an agent reaches a target (within ~16 units), the target turns green with ✓ and "RESCUED".
   - The agent immediately picks the next nearest target.
   - PriorityPanel shows: each agent (idle | enroute) and current target, remaining count.

6. **Step once** (manual control)
   - Turn **Run mission (auto)** OFF.
   - Click **Step once** to advance one tick (assign + move).
   - Use this to step through the mission manually.

7. **Adjust speed**
   - Use the **Speed** +/- buttons (4–40 units/tick).
   - Higher = faster movement.

8. **Reset mission**
   - Click **Reset mission** to set all targets back to unassigned and clear agent tasks.
   - Agents and targets stay in place; only mission state resets.
