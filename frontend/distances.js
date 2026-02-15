/**
 * Distance matrix — mirrors Python backend.
 * Returns both agent-centric and target-centric views, sorted nearest-first.
 * When a wallGrid is provided, uses A* pathfinding instead of euclidean distance.
 * Also returns a paths map keyed by "agentId->targetId" for wall-aware path rendering.
 */

import { euclidean } from "./utils.js";
import { astarPath } from "./pathfinding.js";

export function computeDistanceMatrix(agents, targets, wallGrid) {
  const paths = {};  // "agentId->targetId" => [{x,y}, ...]

  const distFn = wallGrid
    ? (a, b, aId, tId) => {
        const result = astarPath(wallGrid, a, b);
        if (result.path.length > 0) paths[`${aId}->${tId}`] = result.path;
        return result.distance;
      }
    : (a, b) => euclidean(a, b);

  const byAgent = {};
  for (const a of agents) {
    const row = {};
    for (const t of targets) row[t.id] = distFn(a.position, t.position, a.id, t.id);
    byAgent[a.id] = Object.fromEntries(Object.entries(row).sort((x, y) => x[1] - y[1]));
  }
  const byTarget = {};
  for (const t of targets) {
    const row = {};
    for (const a of agents) row[a.id] = byAgent[a.id]?.[t.id] ?? euclidean(t.position, a.position);
    byTarget[t.id] = Object.fromEntries(Object.entries(row).sort((x, y) => x[1] - y[1]));
  }
  return { byAgent, byTarget, paths };
}
