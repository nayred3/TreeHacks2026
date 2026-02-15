/**
 * Right-side inspector: selected responder info, assigned target,
 * distances list, last update times.
 */

import {
  responderDisplayName,
  targetDisplayName,
} from "../utils/friendlyNames.js";

function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

export default function SimInspector({
  worldState,
  selectedResponderId,
  simTimeMs,
  lastUpdateMs,
  onFocus,
}) {
  const responders = worldState?.responders ?? [];
  const targets = worldState?.targets ?? [];
  const assignments = worldState?.assignments ?? [];
  const selected = responders.find((r) => r.id === selectedResponderId);

  if (!selected) {
    return (
      <div className="sim-inspector" style={panel}>
        <div style={header}>Inspector</div>
        <div style={{ fontSize: "11px", opacity: 0.6 }}>
          Select a responder on the map
        </div>
      </div>
    );
  }

  const primaryAssignment = assignments.find(
    (a) => a.agentId === selected.id && a.priority === 1
  );
  const assignedTarget = primaryAssignment
    ? targets.find((t) => t.id === primaryAssignment.targetId)
    : null;
  const currentTarget = selected.currentTargetId
    ? targets.find((t) => t.id === selected.currentTargetId)
    : null;

  const distances = targets
    .filter((t) => t.status !== "rescued")
    .map((t) => ({
      target: t,
      d: dist(selected.x, selected.y, t.x, t.y),
    }))
    .sort((a, b) => a.d - b.d);

  return (
    <div className="sim-inspector" style={panel}>
      <div style={header}>Inspector</div>

      <div style={section}>
        <div style={row}>
          <span style={label}>Responder</span>
          <span>{responderDisplayName(responders, selected.id)}</span>
        </div>
        <div style={row}>
          <span style={label}>Position</span>
          <span>({selected.x.toFixed(0)}, {selected.y.toFixed(0)})</span>
        </div>
        <div style={row}>
          <span style={label}>Mode</span>
          <span>{selected.mode ?? "idle"}</span>
        </div>
        <div style={row}>
          <span style={label}>Last update</span>
          <span>{(selected.lastSeenSeconds ?? 0).toFixed(1)}s ago</span>
        </div>
      </div>

      {assignedTarget && (
        <div style={section}>
          <div style={sectionTitle}>Assigned target</div>
          <div style={row}>
            <span style={label}>Target</span>
            <span>{targetDisplayName(targets, assignedTarget.id, assignedTarget.type)}</span>
          </div>
          <div style={row}>
            <span style={label}>Distance</span>
            <span>{primaryAssignment?.distance?.toFixed(0) ?? dist(selected.x, selected.y, assignedTarget.x, assignedTarget.y).toFixed(0)}m</span>
          </div>
          <div style={row}>
            <span style={label}>Status</span>
            <span>{assignedTarget.status}</span>
          </div>
          {onFocus && (
            <button
              style={focusBtn}
              onClick={() => onFocus(assignedTarget)}
            >
              Focus on map
            </button>
          )}
        </div>
      )}

      <div style={section}>
        <div style={sectionTitle}>Distances</div>
        <div style={list}>
          {distances.slice(0, 6).map(({ target, d }) => (
            <div key={target.id} style={listRow}>
              <span>{targetDisplayName(targets, target.id, target.type)}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{d.toFixed(0)}m</span>
            </div>
          ))}
        </div>
      </div>

      <div style={section}>
        <div style={row}>
          <span style={label}>Sim time</span>
          <span>{(simTimeMs / 1000).toFixed(1)}s</span>
        </div>
        <div style={row}>
          <span style={label}>Last tick</span>
          <span>
            {lastUpdateMs
              ? new Date(lastUpdateMs).toLocaleTimeString("en-US", {
                  hour12: false,
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })
              : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

const panel = {
  padding: 12,
  borderRadius: 10,
  border: "1px solid rgba(0, 255, 255, 0.25)",
  background: "rgba(0, 15, 25, 0.4)",
  fontSize: "11px",
};

const header = {
  fontSize: "11px",
  fontWeight: 800,
  color: "#00ffff",
  marginBottom: 10,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const section = { marginTop: 12 };
const sectionTitle = {
  fontSize: "10px",
  fontWeight: 700,
  opacity: 0.9,
  marginBottom: 6,
};
const row = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  padding: "3px 0",
};
const label = { opacity: 0.75, flexShrink: 0 };
const list = { marginTop: 4 };
const listRow = {
  display: "flex",
  justifyContent: "space-between",
  padding: "2px 0",
};
const focusBtn = {
  marginTop: 8,
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid rgba(0, 255, 255, 0.4)",
  background: "rgba(0, 255, 255, 0.1)",
  color: "#00ffff",
  fontSize: "10px",
  fontWeight: 600,
  cursor: "pointer",
};
