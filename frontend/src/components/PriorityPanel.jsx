import { useMemo } from "react";

function distance(ax, ay, tx, ty) {
  return Math.hypot(tx - ax, ty - ay);
}

export default function PriorityPanel({ agents = [], targets = [], assignments = [] }) {
  const stats = useMemo(() => {
    const assigned = new Set(assignments.filter((a) => a.priority === 1).map((a) => a.targetId));
    const unassigned = targets.filter((t) => !assigned.has(t.id)).length;
    return {
      assigned: assigned.size,
      unassigned,
      totalTargets: targets.length,
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

  return (
    <div className="priority-panel">
      <div className="priority-panel-header">Priorities</div>
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
        <div className="priority-section-title">Priorities</div>
        <div className="priority-list">
          {prioritiesByAgent.map(({ agent, ranked }) => (
            <div key={agent.id} className="agent-priority-block">
              <div className="agent-priority-name">{agent.label ?? agent.id}</div>
              <ul className="agent-target-list">
                {ranked.map(({ target, distance: d, isP1, isP2 }) => (
                  <li
                    key={target.id}
                    className={`agent-target-item ${isP1 ? "p1" : ""} ${isP2 ? "p2" : ""}`}
                  >
                    <span className="target-label">{target.label ?? target.id}</span>
                    <span className="target-distance">{d}m</span>
                    {isP1 && <span className="priority-badge p1">P1</span>}
                    {isP2 && !isP1 && <span className="priority-badge p2">P2</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
