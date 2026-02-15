/**
 * Distance matrix — mirrors Python backend.
 * Positions in meters (center origin). A* uses pixel coords internally.
 */

import { euclidean } from "./utils.js";
import { astarPath } from "./pathfinding.js";
import { toPx } from "./config.js";

export function computeDistanceMatrix(agents, targets, wallGrid) {
  const paths = {};  // "agentId->targetId" => [{x,y}] in pixel coords for drawing

  const distFn = wallGrid
    ? (a, b, aId, tId) => {
        const aPx = toPx(a);
        const bPx = toPx(b);
        const result = astarPath(wallGrid, aPx, bPx);
        if (result.path.length > 0) paths[`${aId}->${tId}`] = result.path;
        return result.distance;  // 1 px = 1 cm
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
