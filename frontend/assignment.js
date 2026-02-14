/**
 * runPriorityAssignment()
 * ─────────────────────────────────────────────────────────────────────────────
 * Euclidean mode:
 * - Primary uses a globally optimal assignment that minimizes total travel cost
 *   while enforcing coverage rules (all targets covered when agents >= targets).
 * - Remaining targets are assigned in per-agent rounds (P2, then P3+), where
 *   each target chooses the closest available agent, tie-broken by earliest
 *   completion of the agent's already-assigned tasks.
 *
 * Non-euclidean (wall/path mode):
 * - Uses the legacy anti-thrash claim-based behavior.
 */

import { computeDistanceMatrix } from "./distances.js";
import { REASSIGN_THRESHOLD } from "./config.js";

export function runPriorityAssignment(agents, targets, prevPrimary, prevSecondary, wallGrid) {
  if (!agents.length || !targets.length) {
    return {
      primary: {},
      secondary: {},
      tertiary: {},
      agentSecondary: {},
      agentTertiary: {},
      proximity: {},
      agentPriorities: {},
      matrix: { byAgent: {}, byTarget: {} },
    };
  }

  const matrix = computeDistanceMatrix(agents, targets, wallGrid);
  const { byAgent, byTarget } = matrix;

  if (!wallGrid) {
    return runEuclideanOptimalAssignment(agents, targets, matrix);
  }

  return runLegacyPriorityAssignment(agents, targets, prevPrimary, matrix);
}

function runEuclideanOptimalAssignment(agents, targets, matrix) {
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

  // ── Phase 1: globally optimal primary assignment (with coverage rules)
  const primarySolutions = solveTopAssignments(agents, targets, byAgent, 1);
  const primaryAgentToTarget = primarySolutions[0]?.map || buildNearestFallback(agents, priorityLists);

  const primary = {};
  for (const [aid, tid] of Object.entries(primaryAgentToTarget)) {
    if (
      primary[tid] === undefined
      || (byAgent[aid]?.[tid] ?? Infinity) < (byAgent[primary[tid]]?.[tid] ?? Infinity)
    ) {
      primary[tid] = aid;
    }
  }

  // Estimated completion time for already queued tasks.
  const agentTaskLoad = {};
  const agentTaskSets = {};
  for (const a of agents) {
    const tid = primaryAgentToTarget[a.id];
    agentTaskLoad[a.id] = tid !== undefined ? (byAgent[a.id]?.[tid] ?? Infinity) : Infinity;
    agentTaskSets[a.id] = new Set(tid !== undefined ? [tid] : []);
  }

  const assignedTargets = new Set(Object.keys(primary).map(Number));
  let remainingTargets = targets.map((t) => t.id).filter((tid) => !assignedTargets.has(tid));

  // ── Phase 2: secondary round (one extra target max per agent)
  const secondary = assignPriorityRound(remainingTargets, agents, byAgent, agentTaskLoad, agentTaskSets);
  for (const tid of Object.keys(secondary).map(Number)) assignedTargets.add(tid);
  remainingTargets = targets.map((t) => t.id).filter((tid) => !assignedTargets.has(tid));

  // ── Phase 3+: tertiary backlog rounds until all targets are covered.
  const tertiary = {};
  while (remainingTargets.length > 0) {
    const round = assignPriorityRound(remainingTargets, agents, byAgent, agentTaskLoad, agentTaskSets);
    const assignedNow = Object.keys(round).map(Number);
    if (!assignedNow.length) {
      // Safety fallback: force remaining targets to nearest agent by the same tie-break rule.
      for (const tid of remainingTargets) {
        const fallbackAgent = pickBestAgentForTarget(tid, agents, byAgent, agentTaskLoad, null);
        if (fallbackAgent === null) continue;
        tertiary[tid] = fallbackAgent;
        agentTaskLoad[fallbackAgent] += byAgent[fallbackAgent]?.[tid] ?? Infinity;
        agentTaskSets[fallbackAgent].add(tid);
      }
      break;
    }

    for (const [tidStr, aid] of Object.entries(round)) tertiary[tidStr] = aid;
    for (const tid of assignedNow) assignedTargets.add(tid);
    remainingTargets = targets.map((t) => t.id).filter((tid) => !assignedTargets.has(tid));
  }

  // Per-agent top queued backup targets for UI badges/lines.
  const agentSecondary = {};
  for (const [tidStr, aid] of Object.entries(secondary)) {
    const tid = +tidStr;
    const prevTid = agentSecondary[aid];
    if (prevTid === undefined || (byAgent[aid]?.[tid] ?? Infinity) < (byAgent[aid]?.[prevTid] ?? Infinity)) {
      agentSecondary[aid] = tid;
    }
  }

  const agentTertiary = {};
  for (const [tidStr, aid] of Object.entries(tertiary)) {
    const tid = +tidStr;
    const prevTid = agentTertiary[aid];
    if (prevTid === undefined || (byAgent[aid]?.[tid] ?? Infinity) < (byAgent[aid]?.[prevTid] ?? Infinity)) {
      agentTertiary[aid] = tid;
    }
  }

  // Annotate priority lists with role
  const agentPriorities = {};
  for (const a of agents) {
    agentPriorities[a.id] = (priorityLists[a.id] || []).map((entry) => {
      let role = "none";
      if (primaryAgentToTarget[a.id] === entry.targetId) role = "primary";
      else if (agentSecondary[a.id] === entry.targetId) role = "secondary";
      else if (agentTertiary[a.id] === entry.targetId) role = "tertiary";
      return { ...entry, role };
    });
  }

  return { primary, secondary, tertiary, agentSecondary, agentTertiary, proximity, agentPriorities, matrix };
}

function runLegacyPriorityAssignment(agents, targets, prevPrimary, matrix) {
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

  const agentSecondary = {};
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

  const secondary = {};
  for (const [aid, tid] of Object.entries(agentSecondary)) {
    if (secondary[tid] === undefined) secondary[tid] = aid;
  }

  const agentPriorities = {};
  for (const a of agents) {
    agentPriorities[a.id] = (priorityLists[a.id] || []).map((entry) => {
      let role = "none";
      if (primary[entry.targetId] === a.id) role = "primary";
      else if (agentSecondary[a.id] === entry.targetId) role = "secondary";
      return { ...entry, role };
    });
  }

  return {
    primary,
    secondary,
    tertiary: {},
    agentSecondary,
    agentTertiary: {},
    proximity,
    agentPriorities,
    matrix,
  };
}

function solveTopAssignments(agents, targets, byAgent, topK = 2) {
  const agentIds = agents.map((a) => a.id);
  const targetIds = targets.map((t) => t.id);
  const targetIndex = new Map(targetIds.map((id, idx) => [id, idx]));
  const moreAgentsThanTargets = agentIds.length >= targetIds.length;
  const rankings = {};

  for (const aid of agentIds) {
    rankings[aid] = targetIds.slice().sort((t1, t2) => (byAgent[aid]?.[t1] ?? Infinity) - (byAgent[aid]?.[t2] ?? Infinity));
  }

  const best = [];
  const current = {};
  const usedTargets = new Set();

  function consider(map, cost) {
    const serialized = JSON.stringify(agentIds.map((aid) => [aid, map[aid]]));
    if (best.some((x) => x.key === serialized)) return;
    best.push({ key: serialized, cost, map: { ...map } });
    best.sort((a, b) => a.cost - b.cost);
    if (best.length > topK) best.pop();
  }

  function dfs(agentPos, cost, coverageMask) {
    if (best.length === topK && cost >= best[best.length - 1].cost) return;

    if (agentPos === agentIds.length) {
      if (moreAgentsThanTargets) {
        const fullMask = (1 << targetIds.length) - 1;
        if (coverageMask !== fullMask) return;
      }
      consider(current, cost);
      return;
    }

    const aid = agentIds[agentPos];
    for (const tid of rankings[aid]) {
      if (!moreAgentsThanTargets && usedTargets.has(tid)) continue;
      const dist = byAgent[aid]?.[tid] ?? Infinity;
      if (!Number.isFinite(dist)) continue;

      current[aid] = tid;
      let addedMask = coverageMask;
      const bit = 1 << targetIndex.get(tid);
      addedMask |= bit;

      if (!moreAgentsThanTargets) usedTargets.add(tid);
      dfs(agentPos + 1, cost + dist, addedMask);
      if (!moreAgentsThanTargets) usedTargets.delete(tid);
      delete current[aid];
    }
  }

  // Guard: avoid bitmask overflow for large target counts.
  if (targetIds.length > 30) {
    const greedy = buildNearestFallback(agents, Object.fromEntries(agentIds.map((aid) => [
      aid,
      rankings[aid].map((tid, idx) => ({ targetId: tid, distance: byAgent[aid]?.[tid] ?? Infinity, priority: idx + 1 })),
    ])));
    return [{ cost: 0, map: greedy }];
  }

  dfs(0, 0, 0);
  return best;
}

function buildNearestFallback(agents, priorityLists) {
  const out = {};
  for (const a of agents) {
    const first = (priorityLists[a.id] || [])[0];
    if (first) out[a.id] = first.targetId;
  }
  return out;
}

function assignPriorityRound(remainingTargetIds, agents, byAgent, agentTaskLoad, agentTaskSets) {
  const assignments = {};
  const unassigned = new Set(remainingTargetIds);
  const usedAgents = new Set();

  while (unassigned.size > 0 && usedAgents.size < agents.length) {
    let bestChoice = null;

    for (const tid of unassigned) {
      const aid = pickBestAgentForTarget(tid, agents, byAgent, agentTaskLoad, usedAgents, agentTaskSets);
      if (aid === null) continue;
      const dist = byAgent[aid]?.[tid] ?? Infinity;
      const load = agentTaskLoad[aid] ?? Infinity;
      if (
        !bestChoice
        || dist < bestChoice.dist
        || (dist === bestChoice.dist && load < bestChoice.load)
      ) {
        bestChoice = { tid, aid, dist, load };
      }
    }

    if (!bestChoice) break;

    assignments[bestChoice.tid] = bestChoice.aid;
    unassigned.delete(bestChoice.tid);
    usedAgents.add(bestChoice.aid);
    agentTaskLoad[bestChoice.aid] += bestChoice.dist;
    agentTaskSets[bestChoice.aid].add(bestChoice.tid);
  }

  return assignments;
}

function pickBestAgentForTarget(tid, agents, byAgent, agentTaskLoad, usedAgents = null, agentTaskSets = null) {
  let bestAid = null;
  let bestDist = Infinity;
  let bestLoad = Infinity;

  for (const a of agents) {
    if (usedAgents && usedAgents.has(a.id)) continue;
    if (agentTaskSets?.[a.id]?.has(tid)) continue;

    const dist = byAgent[a.id]?.[tid] ?? Infinity;
    const load = agentTaskLoad[a.id] ?? Infinity;
    if (
      dist < bestDist
      || (dist === bestDist && load < bestLoad)
    ) {
      bestAid = a.id;
      bestDist = dist;
      bestLoad = load;
    }
  }

  return bestAid;
}
