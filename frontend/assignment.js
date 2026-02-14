/**
 * runPriorityAssignment()
 * Phase 1: P1 claims (closest agent wins). Phase 2: Secondary coverage.
 * Proximity: geometrically closest agent per target, always drawn.
 */

import { computeDistanceMatrix } from "./distances.js";
import { REASSIGN_THRESHOLD } from "./config.js";

export function runPriorityAssignment(agents, targets, prevPrimary, prevSecondary) {
  if (!agents.length || !targets.length) {
    return {
      primary: {},
      secondary: {},
      proximity: {},
      agentPriorities: {},
      matrix: { byAgent: {}, byTarget: {} },
    };
  }

  const matrix = computeDistanceMatrix(agents, targets);
  const { byAgent, byTarget } = matrix;

  const priorityLists = {};
  for (const a of agents) {
    priorityLists[a.id] = Object.entries(byAgent[a.id] || {}).map(([tid, d], idx) => ({
      targetId: +tid,
      distance: d,
      priority: idx + 1,
    }));
  }

  const proximity = {};
  for (const t of targets) {
    const sorted = Object.entries(byTarget[t.id]);
    if (sorted.length) proximity[t.id] = sorted[0][0];
  }

  const claims = {};
  for (const a of agents) {
    const p1 = priorityLists[a.id]?.[0];
    if (!p1) continue;
    if (!claims[p1.targetId]) claims[p1.targetId] = [];
    claims[p1.targetId].push({ agentId: a.id, distance: p1.distance });
  }

  const primary = {};
  const agentPrimaryTarget = {};

  for (const [tidStr, claimList] of Object.entries(claims)) {
    const tid = +tidStr;
    claimList.sort((a, b) => a.distance - b.distance);
    const winner = claimList[0];
    const prevAgentId = prevPrimary[tid];
    if (prevAgentId && prevAgentId !== winner.agentId) {
      const prevDist = byTarget[tid]?.[prevAgentId] ?? Infinity;
      const improvement = prevDist - winner.distance;
      if (improvement <= REASSIGN_THRESHOLD) {
        primary[tid] = prevAgentId;
        agentPrimaryTarget[prevAgentId] = tid;
        continue;
      }
    }
    primary[tid] = winner.agentId;
    agentPrimaryTarget[winner.agentId] = tid;
  }

  for (const t of targets) {
    if (primary[t.id] !== undefined) continue;
    for (const [aid] of Object.entries(byTarget[t.id])) {
      if (!agentPrimaryTarget[aid]) {
        primary[t.id] = aid;
        agentPrimaryTarget[aid] = t.id;
        break;
      }
    }
  }

  const secondary = {};
  for (const t of targets) {
    if (primary[t.id] !== undefined) continue;
    for (const [aid] of Object.entries(byTarget[t.id])) {
      if (aid !== primary[t.id]) {
        secondary[t.id] = aid;
        break;
      }
    }
  }

  for (const a of agents) {
    if (agentPrimaryTarget[a.id]) continue;
    for (const { targetId } of priorityLists[a.id] || []) {
      if (primary[targetId] !== undefined && !secondary[targetId] && primary[targetId] !== a.id) {
        secondary[targetId] = a.id;
        break;
      }
      if (primary[targetId] === undefined && !secondary[targetId]) {
        secondary[targetId] = a.id;
        break;
      }
    }
  }

  const agentPriorities = {};
  for (const a of agents) {
    agentPriorities[a.id] = (priorityLists[a.id] || []).map((entry) => {
      let role = "none";
      if (primary[entry.targetId] === a.id) role = "primary";
      else if (secondary[entry.targetId] === a.id) role = "secondary";
      return { ...entry, role };
    });
  }

  return { primary, secondary, proximity, agentPriorities, matrix };
}
