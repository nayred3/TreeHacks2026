/**
 * Distance matrix — mirrors Python backend.
 * Returns both agent-centric and target-centric views, sorted nearest-first.
 */

import { euclidean } from "./utils.js";

export function computeDistanceMatrix(agents, targets) {
  const byAgent = {};
  for (const a of agents) {
    const row = {};
    for (const t of targets) row[t.id] = euclidean(a.position, t.position);
    byAgent[a.id] = Object.fromEntries(Object.entries(row).sort((x, y) => x[1] - y[1]));
  }
  const byTarget = {};
  for (const t of targets) {
    const row = {};
    for (const a of agents) row[a.id] = euclidean(t.position, a.position);
    byTarget[t.id] = Object.fromEntries(Object.entries(row).sort((x, y) => x[1] - y[1]));
  }
  return { byAgent, byTarget };
}
