/**
 * Distance matrix — mirrors Python backend.
 * Returns both agent-centric and target-centric views, sorted nearest-first.
 * When a wallGrid is provided, uses A* pathfinding instead of euclidean distance.
 */

import { euclidean } from "./utils.js";
import { astarDistance } from "./pathfinding.js";

export function computeDistanceMatrix(agents, targets, wallGrid) {
  const distFn = wallGrid
    ? (a, b) => astarDistance(wallGrid, a, b)
    : (a, b) => euclidean(a, b);

  const byAgent = {};
  for (const a of agents) {
    const row = {};
    for (const t of targets) row[t.id] = distFn(a.position, t.position);
    byAgent[a.id] = Object.fromEntries(Object.entries(row).sort((x, y) => x[1] - y[1]));
  }
  const byTarget = {};
  for (const t of targets) {
    const row = {};
    for (const a of agents) row[a.id] = distFn(t.position, a.position);
    byTarget[t.id] = Object.fromEntries(Object.entries(row).sort((x, y) => x[1] - y[1]));
  }
  return { byAgent, byTarget };
}
