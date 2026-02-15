/**
 * Deterministic rescue loop demo.
 * Spawn N targets, assign closest to each responder, move toward target,
 * mark rescued when within radius, auto-assign next nearest.
 * Targets sometimes leave line-of-sight so "last seen" is meaningful.
 *
 * All logic here; can be deleted when swapping to live backend without touching rendering.
 */

import { DEFAULT_FOV_DEG } from "./worldState.js";

const BOUNDS = { w: 800, h: 520 };
const ARRIVAL_RADIUS = 16;
const TRAIL_TRAIL_SEC = 8;
const TRAIL_POINTS = 50;

// Vision: responder can "see" target if within radius and in FOV
// Periodically "occlude" by moving target outside view so last-seen matters
const VISION_RADIUS = 180;

/** @param {number} deg */
function deg2rad(deg) {
  return (deg * Math.PI) / 180;
}

/** Bearing from a to b (rad), -π..π */
function bearing(ax, ay, bx, by) {
  return Math.atan2(by - ay, bx - ax);
}

/** Normalize angle to -π..π */
function normAngle(a) {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

/** Is point (bx,by) within FOV of (ax,ay) with yaw and fovDeg? */
function inFOV(ax, ay, yaw, fovDeg, bx, by) {
  const d = Math.hypot(bx - ax, by - ay);
  if (d > VISION_RADIUS) return false;
  const b = bearing(ax, ay, bx, by);
  const halfFov = deg2rad(fovDeg) / 2;
  return Math.abs(normAngle(b - yaw)) <= halfFov;
}

/** Distance between two points */
function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

/**
 * Clamp position to bounds
 */
function clamp(x, y) {
  return {
    x: Math.max(20, Math.min(BOUNDS.w - 20, x)),
    y: Math.max(20, Math.min(BOUNDS.h - 20, y)),
  };
}

/**
 * Run one rescue step. Mutates state in place.
 * @param {Object} state - { responders, targets, assignments, timestamp }
 * @param {number} speed - px per step
 */
export function runRescueStep(state, speed = 12) {
  const { responders, targets } = state;
  const arrived = new Set();

  // Ensure yaw/fov on responders
  responders.forEach((r) => {
    if (r.yaw == null) r.yaw = 0;
    if (r.fovDeg == null) r.fovDeg = DEFAULT_FOV_DEG;
  });

  // 1) Assign idle agents to nearest non-rescued, unassigned target
  responders.forEach((r) => {
    if (r.mode === "enroute" && r.currentTargetId) return;
    const available = targets.filter(
      (t) => t.status !== "rescued" && t.assignedAgentId == null
    );
    if (available.length === 0) return;
    const withDist = available.map((t) => ({
      target: t,
      d: dist(r.x, r.y, t.x, t.y),
    }));
    withDist.sort((a, b) => a.d - b.d);
    r.mode = "enroute";
    r.currentTargetId = withDist[0].target.id;
  });

  // 2) Update targets: mark assigned
  const assignedByAgent = new Map(
    responders.filter((r) => r.currentTargetId).map((r) => [r.currentTargetId, r.id])
  );
  targets.forEach((t) => {
    const aid = assignedByAgent.get(t.id);
    if (aid && t.status !== "rescued") {
      t.status = "assigned";
      t.assignedAgentId = aid;
    }
  });

  // 3) Update responder yaw to face current target
  responders.forEach((r) => {
    if (!r.currentTargetId) return;
    const target = targets.find((t) => t.id === r.currentTargetId);
    if (!target || target.status === "rescued") return;
    r.yaw = bearing(r.x, r.y, target.x, target.y);
  });

  // 4) Move agents toward target; check arrival
  responders.forEach((r) => {
    if (r.mode !== "enroute" || !r.currentTargetId) return;
    const target = targets.find((t) => t.id === r.currentTargetId);
    if (!target || target.status === "rescued") {
      r.mode = "idle";
      r.currentTargetId = null;
      return;
    }
    const dx = target.x - r.x;
    const dy = target.y - r.y;
    const d = Math.hypot(dx, dy);
    if (d <= ARRIVAL_RADIUS) {
      arrived.add(r.currentTargetId);
      r.x = target.x;
      r.y = target.y;
      r.mode = "idle";
      r.currentTargetId = null;
      return;
    }
    const step = Math.min(speed, Math.max(0, d - ARRIVAL_RADIUS));
    const { x, y } = clamp(r.x + (dx / d) * step, r.y + (dy / d) * step);
    r.x = x;
    r.y = y;
  });

  // 5) Mark arrived targets as rescued
  targets.forEach((t) => {
    if (arrived.has(t.id)) {
      t.status = "rescued";
      t.assignedAgentId = null;
    }
  });

  // 6) Second pass: assign next for newly idle
  responders.forEach((r) => {
    if (r.mode === "enroute" || r.currentTargetId) return;
    const available = targets.filter(
      (t) => t.status !== "rescued" && t.assignedAgentId == null
    );
    if (available.length === 0) return;
    const withDist = available.map((t) => ({
      target: t,
      d: dist(r.x, r.y, t.x, t.y),
    }));
    withDist.sort((a, b) => a.d - b.d);
    r.mode = "enroute";
    r.currentTargetId = withDist[0].target.id;
  });
  const assigned2 = new Map(
    responders.filter((r) => r.currentTargetId).map((r) => [r.currentTargetId, r.id])
  );
  targets.forEach((t) => {
    const aid = assigned2.get(t.id);
    if (aid && t.status !== "rescued") {
      t.status = "assigned";
      t.assignedAgentId = aid;
    }
  });

  // 6b) Slight drift for unassigned targets so they leave LOS and last-seen is meaningful
  const t0 = (state.timestamp ?? 0) / 1000;
  targets.forEach((t) => {
    if (t.status === "rescued" || t.assignedAgentId) return;
    const phase = t.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    const dx = Math.sin(t0 * 0.3 + phase) * 1.5;
    const dy = Math.cos(t0 * 0.25 + phase * 0.7) * 1.2;
    const { x, y } = clamp(t.x + dx, t.y + dy);
    t.x = x;
    t.y = y;
  });

  // 7) Visibility & lastSeenAtMs
  const now = state.timestamp ?? Date.now();
  responders.forEach((r) => {
    targets.forEach((t) => {
      const visible = inFOV(r.x, r.y, r.yaw, r.fovDeg ?? DEFAULT_FOV_DEG, t.x, t.y);
      const d = dist(r.x, r.y, t.x, t.y);
      if (visible && d <= VISION_RADIUS) {
        t.visibleNow = true;
        t.lastSeenAtMs = now;
        t.lastSeenBy = r.id;
      }
    });
  });
  // Targets not seen by any responder this tick
  targets.forEach((t) => {
    const seen = responders.some((r) => {
      const d = dist(r.x, r.y, t.x, t.y);
      return d <= VISION_RADIUS && inFOV(r.x, r.y, r.yaw, r.fovDeg ?? DEFAULT_FOV_DEG, t.x, t.y);
    });
    if (!seen) t.visibleNow = false;
    if (!t.lastSeenAtMs) t.lastSeenAtMs = now;
  });

  // 8) Rebuild assignments
  state.assignments = [];
  responders.forEach((r) => {
    const ranked = targets
      .filter((t) => t.status !== "rescued")
      .map((t) => ({ target: t, d: dist(r.x, r.y, t.x, t.y) }))
      .sort((a, b) => a.d - b.d);
    ranked.slice(0, 2).forEach(({ target, d }, i) => {
      state.assignments.push({
        agentId: r.id,
        targetId: target.id,
        priority: i + 1,
        distance: d,
      });
    });
  });

  return state;
}

/**
 * Append trail point for entity. Mutates entity.
 * @param {Object} entity - { x, y, trail?, ... }
 * @param {number} now
 */
export function appendTrail(entity, now) {
  if (!entity.trail) entity.trail = [];
  const prev = entity.trail[entity.trail.length - 1];
  const dt = prev ? now - prev.t : 150;
  const d = prev ? dist(prev.x, prev.y, entity.x, entity.y) : 100;
  if (!prev || dt >= 150 || d >= 5) {
    entity.trail.push({ x: entity.x, y: entity.y, t: now });
    const maxPoints = Math.ceil((TRAIL_TRAIL_SEC * 1000) / 150);
    if (entity.trail.length > Math.min(maxPoints, TRAIL_POINTS)) {
      entity.trail.shift();
    }
  }
}

/**
 * Create initial demo state from seed (fixture or default)
 * @param {import('./worldState.js').WorldState} [seed]
 * @returns {Object} Mutable state for rescue loop
 */
export function createDemoState(seed) {
  const responders = (seed?.responders ?? []).map((r) => ({
    ...r,
    id: String(r.id),
    x: Number(r.x),
    y: Number(r.y),
    yaw: r.yaw ?? 0,
    fovDeg: r.fovDeg ?? DEFAULT_FOV_DEG,
    mode: "idle",
    currentTargetId: null,
    trail: [],
  }));
  const targets = (seed?.targets ?? []).map((t) => ({
    ...t,
    id: String(t.id),
    x: Number(t.x),
    y: Number(t.y),
    status: "unassigned",
    assignedAgentId: null,
    visibleNow: true,
    lastSeenAtMs: Date.now(),
    trail: [],
  }));
  return {
    responders,
    targets,
    assignments: [],
    timestamp: 0,
  };
}
