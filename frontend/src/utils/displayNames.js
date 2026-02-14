/**
 * Deterministic display names for agents and targets.
 * Same id => same displayName across ticks. No backend field assumptions.
 */

const AGENT_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
const TARGET_TYPE_PREFIX = {
  victim: "Victim",
  hazard: "Hazard",
  landmark: "Landmark",
};

/** Agent display: Responder Alpha, Responder Bravo, etc. */
export function agentDisplayName(agents, id) {
  const sorted = [...agents].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const idx = sorted.findIndex((a) => a.id === id);
  const name = AGENT_NAMES[idx % AGENT_NAMES.length] ?? `Agent ${idx + 1}`;
  return `Responder ${name}`;
}

/** Agent short badge: A1, A2, ... (index in stable sort) */
export function agentShortBadge(agents, id) {
  const sorted = [...agents].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const idx = sorted.findIndex((a) => a.id === id);
  return `A${idx >= 0 ? idx + 1 : "?"}`;
}

/** Target display: "Victim T1", "Hazard T2", "Target T3" */
export function targetDisplayName(targets, id, type) {
  const sorted = [...targets].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const idx = sorted.findIndex((t) => t.id === id);
  const num = idx >= 0 ? idx + 1 : "?";
  const prefix = TARGET_TYPE_PREFIX[String(type ?? "").toLowerCase()] ?? "Target";
  return `${prefix} T${num}`;
}

/** Target short badge: T1, T2, ... */
export function targetShortBadge(targets, id) {
  const sorted = [...targets].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const idx = sorted.findIndex((t) => t.id === id);
  return `T${idx >= 0 ? idx + 1 : "?"}`;
}
