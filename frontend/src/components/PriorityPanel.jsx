import { useMemo } from "react";
import { agentDisplayName, targetDisplayName } from "../utils/displayNames.js";

function distance(ax, ay, tx, ty) {
  return Math.hypot(tx - ax, ty - ay);
}

const STALE_THRESHOLD_MS = 5000; // targets older than this are dimmed

export default function PriorityPanel({
  agents = [],
  targets = [],
  assignments = [],
  selectedEntity,
  onFocus,
  onOccludeTarget,
}) {
  const stats = useMemo(() => {
    const assigned = new Set(assignments.filter((a) => a.priority === 1).map((a) => a.targetId));
    const unassigned = targets.filter((t) => !assigned.has(t.id)).length;
    const remaining = targets.filter((t) => t.status !== "rescued").length;
    const rescued = targets.filter((t) => t.status === "rescued").length;
    return {
      assigned: assigned.size,
      unassigned,
      totalTargets: targets.length,
      remaining,
      rescued,
      reassignments: 0, // mocked; TODO(BACKEND-CONTRACT): REPLACE_ME if backend provides
    };
  }, [targets, assignments]);

  const prioritiesByAgent = useMemo(() => {
    const targetMap = new Map(targets.map((t) => [t.id, t]));
    return agents.map((agent) => {
      const withDist = targets.map((t) => ({
        target: t,
        distance: distance(agent.x, agent.y, t.x, t.y),
      }));
      withDist.sort((a, b) => a.distance - b.distance);
      const primary = assignments.find((a) => a.agentId === agent.id && a.priority === 1);
      const secondary = assignments.find((a) => a.agentId === agent.id && a.priority === 2);
      return {
        agent,
        ranked: withDist.map(({ target, distance: d }) => ({
          target,
          distance: Math.round(d),
          isP1: primary?.targetId === target.id,
          isP2: secondary?.targetId === target.id,
        })),
      };
    });
  }, [agents, targets, assignments]);

  const selectedAgent = selectedEntity?.type === "agent"
    ? agents.find((a) => a.id === selectedEntity.id)
    : null;
  const selectedTarget = selectedEntity?.type === "target"
    ? targets.find((t) => t.id === selectedEntity.id)
    : null;
  const assignedAgent = selectedTarget
    ? assignments.find((a) => a.targetId === selectedTarget.id && a.priority === 1)?.agentId
    : null;
  const assignedAgentObj = assignedAgent ? agents.find((a) => a.id === assignedAgent) : null;

  return (
    <div className="priority-panel">
      {selectedEntity && (selectedAgent || selectedTarget) && (
        <div className="inspector-card">
          <div className="inspector-header">Selected</div>
          {selectedAgent && (
            <>
              <div className="inspector-row">
                <span className="inspector-label">Name</span>
                <span>{agentDisplayName(agents, selectedAgent.id)}</span>
              </div>
              <div className="inspector-row">
                <span className="inspector-label">ID</span>
                <span>{selectedAgent.id}</span>
              </div>
              <div className="inspector-row">
                <span className="inspector-label">Last seen</span>
                <span>{(selectedAgent.lastSeenSeconds ?? selectedAgent.ageMs / 1000 ?? 0).toFixed(1)}s</span>
              </div>
              <button className="inspector-btn" onClick={() => onFocus?.(selectedAgent)}>
                Focus
              </button>
            </>
          )}
          {selectedTarget && (
            <>
              <div className="inspector-row">
                <span className="inspector-label">Name</span>
                <span>{targetDisplayName(targets, selectedTarget.id, selectedTarget.type)}</span>
              </div>
              <div className="inspector-row">
                <span className="inspector-label">ID</span>
                <span>{selectedTarget.id}</span>
              </div>
              <div className="inspector-row">
                <span className="inspector-label">Type</span>
                <span>{selectedTarget.type ?? "—"}</span>
              </div>
              <div className="inspector-row">
                <span className="inspector-label">Last seen</span>
                <span>{(selectedTarget.secondsSinceSeen ?? selectedTarget.lastSeenSeconds ?? selectedTarget.ageMs / 1000 ?? 0).toFixed(1)}s</span>
              </div>
              <div className="inspector-row">
                <span className="inspector-label">Visible now</span>
                <span>{selectedTarget.visibleNow ? "Yes" : "No"}</span>
              </div>
              <div className="inspector-row">
                <span className="inspector-label">Confidence</span>
                <span>{selectedTarget.confidence != null ? `${(selectedTarget.confidence * 100).toFixed(0)}%` : "—"}</span>
              </div>
              <div className="inspector-row">
                <span className="inspector-label">Assigned</span>
                <span>{assignedAgentObj ? agentDisplayName(agents, assignedAgentObj.id) : "—"}</span>
              </div>
              <div className="inspector-actions">
                <button className="inspector-btn" onClick={() => onFocus?.(selectedTarget)}>
                  Focus
                </button>
                <button className="inspector-btn" onClick={() => onOccludeTarget?.(5)}>
                  Occlude (5s)
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <div className="priority-panel-header">Priorities</div>
      {stats.remaining !== undefined && (
        <div className="priority-remaining">Remaining: {stats.remaining}</div>
      )}
      <div className="priority-counters">
        <div className="priority-counter">
          <span className="counter-value">{stats.assigned}</span>
          <span className="counter-label">Assigned</span>
        </div>
        <div className="priority-counter">
          <span className="counter-value">{stats.unassigned}</span>
          <span className="counter-label">Unassigned</span>
        </div>
        <div className="priority-counter">
          <span className="counter-value">{stats.totalTargets}</span>
          <span className="counter-label">Total targets</span>
        </div>
        <div className="priority-counter">
          <span className="counter-value">{stats.reassignments}</span>
          <span className="counter-label">Reassignments</span>
        </div>
      </div>
      <div className="priority-section">
        <div className="priority-section-title">Agents & targets</div>
        <div className="priority-list">
          {prioritiesByAgent.map(({ agent, ranked }) => {
            const currentTarget = agent.currentTargetId
              ? targets.find((t) => t.id === agent.currentTargetId)
              : null;
            const modeLabel = agent.mode === "enroute" ? "enroute" : "idle";
            return (
            <div key={agent.id} className="agent-priority-block">
              <div className="agent-priority-name">
                {agentDisplayName(agents, agent.id)}
                <span className="agent-mode"> ({modeLabel})</span>
                {currentTarget && (
                  <span className="agent-current-target"> → {targetDisplayName(targets, currentTarget.id, currentTarget.type)}</span>
                )}
              </div>
              <ul className="agent-target-list">
                {ranked.map(({ target, distance: d, isP1, isP2 }) => {
                  const ageMs = target.ageMs ?? 0;
                  const isStale = ageMs > STALE_THRESHOLD_MS;
                  const lastSeenSec = (target.lastSeenSeconds ?? ageMs / 1000) ?? 0;
                  const targetStatus = target.status ?? "unassigned";
                  return (
                    <li
                      key={target.id}
                      className={`agent-target-item ${isP1 ? "p1" : ""} ${isP2 ? "p2" : ""} ${isStale ? "stale" : ""} ${targetStatus === "rescued" ? "rescued" : ""}`}
                    >
                      <span className="target-label">{targetDisplayName(targets, target.id, target.type)}</span>
                      <span className="target-status">{targetStatus}</span>
                      <span className="target-distance">{d}m</span>
                      <span className="target-last-seen">{lastSeenSec.toFixed(1)}s</span>
                      {isP1 && <span className="priority-badge p1">P1</span>}
                      {isP2 && !isP1 && <span className="priority-badge p2">P2</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
          })}
        </div>
      </div>
    </div>
  );
}
