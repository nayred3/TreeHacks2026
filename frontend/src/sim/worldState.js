/**
 * WorldState data contract.
 * Canonical shape for responders, targets, hazards/pins, assignments, timestamps, confidence.
 * All unknown fields preserved as meta when ingesting from fixtures/backend.
 */

/** @typedef {Object} Responder
 *  @property {string} id - Unique identifier
 *  @property {number} x - World X
 *  @property {number} y - World Y
 *  @property {number} [yaw] - Heading in radians (0 = +X, π/2 = +Y)
 *  @property {number} [fovDeg] - Horizontal FOV in degrees (default 60)
 *  @property {number} [timestamp] - Last update time (ms)
 *  @property {number} [confidence] - 0..1
 *  @property {string} [mode] - idle | enroute
 *  @property {string|null} [currentTargetId] - Assigned target id
 *  @property {Object} [meta] - Preserved unknown fields
 */

/** @typedef {Object} Target
 *  @property {string} id - Unique identifier
 *  @property {number} x - World X
 *  @property {number} y - World Y
 *  @property {string} [type] - victim | hazard | target | landmark
 *  @property {number} [timestamp] - Last seen time (ms)
 *  @property {number} [confidence] - 0..1
 *  @property {string} [status] - unassigned | assigned | rescued
 *  @property {string|null} [assignedAgentId]
 *  @property {boolean} [visibleNow] - Currently in view of any responder
 *  @property {Object} [meta] - Preserved unknown fields
 */

/** @typedef {Object} HazardPin
 *  @property {string} id
 *  @property {number} x
 *  @property {number} y
 *  @property {string} [type]
 *  @property {Object} [meta]
 */

/** @typedef {Object} Assignment
 *  @property {string} agentId
 *  @property {string} targetId
 *  @property {number} [priority] - 1=primary, 2=secondary
 *  @property {number} [distance]
 *  @property {Object} [meta]
 */

/** @typedef {Object} WorldState
 *  @property {Responder[]} responders
 *  @property {Target[]} targets
 *  @property {HazardPin[]} [hazards]
 *  @property {Assignment[]} assignments
 *  @property {number} [timestamp] - Sim / fused timestamp (ms)
 *  @property {Object} [meta] - Preserved unknown fields
 */

export const DEFAULT_FOV_DEG = 60;

/**
 * Create empty WorldState
 * @returns {WorldState}
 */
export function emptyWorldState() {
  return { responders: [], targets: [], hazards: [], assignments: [], meta: {} };
}

/**
 * Normalize responder from raw input; preserve unknown as meta
 * @param {unknown} raw
 * @returns {Responder|null}
 */
export function normalizeResponder(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const id = r.id ?? r.agentId ?? r.agent_id;
  const x = typeof r.x === "number" ? r.x : r.position?.x ?? r.pos?.x;
  const y = typeof r.y === "number" ? r.y : r.position?.y ?? r.pos?.y;
  if (id == null || typeof x !== "number" || typeof y !== "number") return null;
  const known = {
    id: String(id),
    x: Number(x),
    y: Number(y),
    yaw: typeof r.yaw === "number" ? r.yaw : undefined,
    fovDeg: typeof r.fovDeg === "number" ? r.fovDeg : undefined,
    timestamp: typeof r.timestamp === "number" ? r.timestamp : undefined,
    confidence: typeof r.confidence === "number" ? r.confidence : undefined,
    mode: r.mode ?? r.state,
    currentTargetId: r.currentTargetId ?? r.current_target_id ?? r.targetId ?? null,
    label: r.label ?? r.name,
  };
  const meta = {};
  for (const [k, v] of Object.entries(r)) {
    if (["id", "agentId", "agent_id", "x", "y", "position", "pos", "yaw", "fovDeg", "timestamp", "confidence", "mode", "currentTargetId", "label", "state", "current_target_id", "targetId", "name"].includes(k)) continue;
    if (v !== undefined) meta[k] = v;
  }
  return { ...known, meta: Object.keys(meta).length ? meta : undefined };
}

/**
 * Normalize target from raw input; preserve unknown as meta
 * @param {unknown} raw
 * @returns {Target|null}
 */
export function normalizeTarget(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const t = /** @type {Record<string, unknown>} */ (raw);
  const id = t.id ?? t.targetId ?? t.target_id;
  const x = typeof t.x === "number" ? t.x : t.position?.x ?? t.pos?.x;
  const y = typeof t.y === "number" ? t.y : t.position?.y ?? t.pos?.y;
  if (id == null || typeof x !== "number" || typeof y !== "number") return null;
  const known = {
    id: String(id),
    x: Number(x),
    y: Number(y),
    type: t.type ?? t.targetType ?? t.class ?? "target",
    timestamp: typeof t.timestamp === "number" ? t.timestamp : undefined,
    confidence: typeof t.confidence === "number" ? t.confidence : undefined,
    status: t.status ?? t.task_status ?? "unassigned",
    assignedAgentId: t.assignedAgentId ?? t.assigned_agent_id ?? null,
    visibleNow: t.visibleNow,
    label: t.label ?? t.name,
    lastSeenAtMs: typeof t.lastSeenAtMs === "number" ? t.lastSeenAtMs : undefined,
  };
  const meta = {};
  for (const [k, v] of Object.entries(t)) {
    if (["id", "targetId", "target_id", "x", "y", "position", "pos", "type", "targetType", "class", "timestamp", "confidence", "status", "task_status", "assignedAgentId", "assigned_agent_id", "visibleNow", "label", "name", "lastSeenAtMs"].includes(k)) continue;
    if (v !== undefined) meta[k] = v;
  }
  return { ...known, meta: Object.keys(meta).length ? meta : undefined };
}

/**
 * Normalize assignment from raw input
 * @param {unknown} raw
 * @returns {Assignment|null}
 */
export function normalizeAssignment(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const a = /** @type {Record<string, unknown>} */ (raw);
  const agentId = a.agentId ?? a.agent_id;
  const targetId = a.targetId ?? a.target_id;
  if (agentId == null || targetId == null) return null;
  const known = { agentId: String(agentId), targetId: String(targetId) };
  const meta = {};
  for (const [k, v] of Object.entries(a)) {
    if (k === "agentId" || k === "agent_id" || k === "targetId" || k === "target_id") continue;
    if (["priority", "distance"].includes(k)) known[k] = v;
    else meta[k] = v;
  }
  return { ...known, meta: Object.keys(meta).length ? meta : undefined };
}
