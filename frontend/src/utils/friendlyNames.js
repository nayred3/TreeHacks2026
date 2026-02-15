/**
 * Map raw IDs to friendly display names. Never show UUIDs in UI.
 */

const RESPONDER_NAMES = ["Alice", "Bob", "Charlie", "Delta", "Echo", "Foxtrot"];
const TARGET_TYPE_PREFIX = {
  victim: "Victim",
  hazard: "Hazard",
  landmark: "Landmark",
};

/** Responder: "R1 Alice", "R2 Bob", etc. */
export function responderDisplayName(responders, id) {
  const sorted = [...(responders ?? [])].sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  );
  const idx = sorted.findIndex((r) => r.id === id);
  const name = RESPONDER_NAMES[idx % RESPONDER_NAMES.length] ?? `R${idx + 1}`;
  return `R${idx >= 0 ? idx + 1 : "?"} ${name}`;
}

/** Target: "T1 Victim", "T2 Hazard", etc. */
export function targetDisplayName(targets, id, type) {
  const sorted = [...(targets ?? [])].sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  );
  const idx = sorted.findIndex((t) => t.id === id);
  const num = idx >= 0 ? idx + 1 : "?";
  const prefix =
    TARGET_TYPE_PREFIX[String(type ?? "").toLowerCase()] ?? "Target";
  return `T${num} ${prefix}`;
}

/** Short badge: "R1", "T3" */
export function responderShortBadge(responders, id) {
  const sorted = [...(responders ?? [])].sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  );
  const idx = sorted.findIndex((r) => r.id === id);
  return `R${idx >= 0 ? idx + 1 : "?"}`;
}

export function targetShortBadge(targets, id) {
  const sorted = [...(targets ?? [])].sort((a, b) =>
    String(a.id).localeCompare(String(b.id))
  );
  const idx = sorted.findIndex((t) => t.id === id);
  return `T${idx >= 0 ? idx + 1 : "?"}`;
}
