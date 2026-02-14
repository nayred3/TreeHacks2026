/**
 * runPriorityAssignment()
 * ─────────────────────────────────────────────────────────────────────────────
 * P1 (primary) — an agent's single closest target. They stake a claim on it.
 *   If two agents both claim the same target, the closer one wins.
 *   The loser drops to their P2.
 *
 * P2 (secondary) — the agent's second-closest target (skipping their own P1).
 *   Every agent holds both a P1 and a P2 simultaneously.
 *
 * Anti-thrash — a P1 assignment only changes hands if the new candidate is
 *   more than 2.5 m closer, preventing rapid flip-flopping while everyone moves.
 *
 * Proximity — geometrically closest agent per target (shown on hover only).
 */

import { computeDistanceMatrix } from "./distances.js";
import { REASSIGN_THRESHOLD } from "./config.js";

export function runPriorityAssignment(agents, targets, prevPrimary, prevSecondary, wallGrid) {
  if (!agents.length || !targets.length) {
    return {
      primary: {},
      secondary: {},
      agentSecondary: {},
      proximity: {},
      agentPriorities: {},
      matrix: { byAgent: {}, byTarget: {} },
    };
  }

  const matrix = computeDistanceMatrix(agents, targets, wallGrid);
  const { byAgent, byTarget } = matrix;

  // Build per-agent priority lists sorted by distance
  const priorityLists = {};
  for (const a of agents) {
    priorityLists[a.id] = Object.entries(byAgent[a.id] || {}).map(([tid, d], idx) => ({
      targetId: +tid,
      distance: d,
      priority: idx + 1,
    }));
  }

  // Proximity: geometrically closest agent per target (unconditional)
  const proximity = {};
  for (const t of targets) {
    const sorted = Object.entries(byTarget[t.id]);
    if (sorted.length) proximity[t.id] = sorted[0][0];
  }

  // ── Phase 1: P1 claims ──────────────────────────────────────────────────
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

  // Unclaimed targets → give to nearest free agent
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

  // ── Phase 2: P2 — every agent's second-closest target ─────────────────
  // Agent-centric: each agent gets their own P2 (first target in their
  // priority list that isn't their own P1).
  const agentSecondary = {}; // agentId → targetId

  for (const a of agents) {
    const list = priorityLists[a.id] || [];
    const myP1 = agentPrimaryTarget[a.id];
    for (let i = 0; i < list.length; i++) {
      if (list[i].targetId !== myP1) {
        agentSecondary[a.id] = list[i].targetId;
        break;
      }
    }
  }

  // Also build target-centric secondary view (for UI stats)
  const secondary = {};
  for (const [aid, tid] of Object.entries(agentSecondary)) {
    if (secondary[tid] === undefined) {
      secondary[tid] = aid;
    }
  }

  // Annotate priority lists with role
  const agentPriorities = {};
  for (const a of agents) {
    agentPriorities[a.id] = (priorityLists[a.id] || []).map((entry) => {
      let role = "none";
      if (primary[entry.targetId] === a.id) role = "primary";
      else if (agentSecondary[a.id] === entry.targetId) role = "secondary";
      return { ...entry, role };
    });
  }

  return { primary, secondary, agentSecondary, proximity, agentPriorities, matrix };
}
