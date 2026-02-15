/**
 * WorldStateAdapter: translates raw backend/mock events into canonical frontend state.
 * TODO(BACKEND-CONTRACT): Replace field names when backend contract is finalized.
 * Canonical types: responders[], targets[], assignments[], events[].
 */

// TODO(BACKEND-CONTRACT): Field names may differ (e.g. agent_id vs agentId)
const ID_FIELDS = { agent: ["id", "agentId", "agent_id"], target: ["id", "targetId", "target_id"] };
const POS_FIELDS = ["x", "y", "position", "pos"];

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null) return typeof v === "number" ? v : v?.x ?? v?.x ?? 0;
  }
  return 0;
}

function pickId(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null) return String(v);
  }
  return null;
}

/**
 * Normalize raw agent/responder from backend. Unknown fields preserved.
 */
export function toResponder(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = pickId(raw, ID_FIELDS.agent);
  const x = typeof raw.x === "number" ? raw.x : raw.position?.x ?? raw.pos?.x ?? 0;
  const y = typeof raw.y === "number" ? raw.y : raw.position?.y ?? raw.pos?.y ?? 0;
  if (!id) return null;
  const fx = Number.isFinite(x) ? x : 0;
  const fy = Number.isFinite(y) ? y : 0;
  return {
    id,
    x: fx,
    y: fy,
    // TODO(BACKEND-CONTRACT): mode/currentTargetId field names
    mode: raw.mode ?? raw.state ?? "idle",
    currentTargetId: raw.currentTargetId ?? raw.current_target_id ?? raw.targetId ?? null,
    timestamp: normalizeTimestamp(raw.timestamp ?? raw.ts ?? raw.last_seen ?? raw.lastSeenAt),
    label: raw.label ?? raw.name ?? `R${id}`,
  };
}

/**
 * Normalize raw target from backend.
 */
export function toTarget(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = pickId(raw, ID_FIELDS.target);
  const x = typeof raw.x === "number" ? raw.x : raw.position?.x ?? raw.pos?.x ?? 0;
  const y = typeof raw.y === "number" ? raw.y : raw.position?.y ?? raw.pos?.y ?? 0;
  if (!id) return null;
  const fx = Number.isFinite(x) ? x : 0;
  const fy = Number.isFinite(y) ? y : 0;
  return {
    id,
    x: fx,
    y: fy,
    status: raw.status ?? raw.task_status ?? "unassigned",
    assignedAgentId: raw.assignedAgentId ?? raw.assigned_agent_id ?? null,
    type: raw.type ?? raw.targetType ?? raw.class ?? "target",
    confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
    visibleNow: raw.visibleNow ?? raw.visible ?? true,
    lastSeenAtMs: raw.lastSeenAtMs ?? normalizeTimestamp(raw.timestamp ?? raw.last_seen),
    secondsSinceSeen: typeof raw.secondsSinceSeen === "number" ? raw.secondsSinceSeen : undefined,
    label: raw.label ?? raw.name ?? `T${id}`,
  };
}

/**
 * Normalize raw assignment from backend.
 */
export function toAssignment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const agentId = pickId(raw, ["agentId", "agent_id"]);
  const targetId = pickId(raw, ["targetId", "target_id"]);
  if (!agentId || !targetId) return null;
  const dist = typeof raw.distance === "number" && Number.isFinite(raw.distance) ? raw.distance : undefined;
  return {
    agentId,
    targetId,
    priority: Math.max(1, Math.min(2, Number(raw.priority ?? raw.priorityLevel ?? 1) || 1)),
    distance: dist,
  };
}

function normalizeTimestamp(ts) {
  if (ts == null || ts === undefined) return undefined;
  const n = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(n)) return undefined;
  return n > 1e12 ? n : n * 1000;
}

/**
 * Convert raw backend agents array to canonical responders.
 */
export function adaptResponders(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(toResponder).filter(Boolean);
}

/**
 * Convert raw backend tracks/targets to canonical targets.
 */
export function adaptTargets(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(toTarget).filter(Boolean);
}

/**
 * Convert raw backend assignments to canonical. Drops assignments to rescued targets.
 */
export function adaptAssignments(raw, targetIdsActive) {
  if (!Array.isArray(raw)) return [];
  const active = new Set(targetIdsActive ?? []);
  return raw
    .map(toAssignment)
    .filter(Boolean)
    .filter((a) => active.has(a.targetId));
}
