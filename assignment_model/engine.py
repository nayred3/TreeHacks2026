"""
Assignment & Coordination Engine
================================

Owns: Deciding which agent responds to which target based on proximity/distance.

Responsibilities:
  1. Agent state table
  2. Distance matrix computation
  3. Assignment algorithm (v1 greedy, v2 anti-thrash)
  4. Output API (JSON assignments)

Usage:
  from engine import AssignmentEngine
"""

import math
import time
import logging
from dataclasses import asdict
from typing import Optional
from collections import defaultdict

from .models import Position, Agent, Target, Assignment

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("AssignmentEngine")


class AssignmentEngine:
    """
    Computes and maintains stable agent ↔ target assignments.

    Algorithm versions:
      v1 — Greedy nearest-agent (simple, may thrash)
      v2 — Anti-thrash: only reassign if improvement > threshold;
           caps assignments per agent; ignores stale targets
    """

    def __init__(
        self,
        algorithm: str = "v2",              # "v1" or "v2"
        reassign_threshold: float = 1.5,    # v2: must be >threshold metres closer to swap
        max_assignments_per_agent: int = 1, # v2: cap on how many targets one agent handles
        stale_target_ttl: float = 5.0,      # seconds before a target is considered lost
    ):
        self.algorithm = algorithm
        self.reassign_threshold = reassign_threshold
        self.max_assignments_per_agent = max_assignments_per_agent
        self.stale_target_ttl = stale_target_ttl

        # State tables
        self.agents: dict[str, Agent] = {}
        self.targets: dict[int, Target] = {}
        self.assignments: dict[int, Assignment] = {}   # target_id → Assignment

        # History for diagnostics
        self._assignment_history: list[dict] = []

    # ── State Update API ──────────────────────────────────────────────────────

    def update_agent(self, agent_id: str, x: float, y: float, max_assignments: int = 1):
        """Upsert an agent's position."""
        if agent_id in self.agents:
            self.agents[agent_id].position = Position(x, y)
            self.agents[agent_id].last_updated = time.time()
            self.agents[agent_id].max_assignments = max_assignments
        else:
            self.agents[agent_id] = Agent(
                id=agent_id,
                position=Position(x, y),
                max_assignments=max_assignments,
            )
        log.debug(f"Agent '{agent_id}' updated → ({x:.1f}, {y:.1f})")

    def update_target(self, target_id: int, x: float, y: float, confidence: float = 1.0):
        """Upsert a detected target's position."""
        if target_id in self.targets:
            self.targets[target_id].position = Position(x, y)
            self.targets[target_id].confidence = confidence
            self.targets[target_id].last_seen = time.time()
        else:
            self.targets[target_id] = Target(
                id=target_id,
                position=Position(x, y),
                confidence=confidence,
            )
        log.debug(f"Target {target_id} updated → ({x:.1f}, {y:.1f}), conf={confidence:.2f}")

    def remove_target(self, target_id: int):
        """Remove a target and its assignment."""
        self.targets.pop(target_id, None)
        self.assignments.pop(target_id, None)
        # Clear agent assignment pointer
        for agent in self.agents.values():
            if agent.current_assignment == target_id:
                agent.current_assignment = None

    def remove_agent(self, agent_id: str):
        """Remove an agent and free its assignments."""
        self.agents.pop(agent_id, None)
        for t_id, assignment in list(self.assignments.items()):
            if assignment.agent_id == agent_id:
                del self.assignments[t_id]

    # ── Distance Matrix ───────────────────────────────────────────────────────

    def compute_distance_matrix(self) -> dict[int, dict[str, float]]:
        """
        Returns:
          {
            target_id: {
              agent_id: distance_metres,
              ...
            },
            ...
          }
        """
        matrix: dict[int, dict[str, float]] = {}
        for t_id, target in self.active_targets().items():
            row: dict[str, float] = {}
            for a_id, agent in self.agents.items():
                row[a_id] = target.position.distance_to(agent.position)
            # Sort by distance (closest first)
            matrix[t_id] = dict(sorted(row.items(), key=lambda kv: kv[1]))
        return matrix

    def active_targets(self) -> dict[int, Target]:
        """Return only targets seen within stale_target_ttl seconds."""
        now = time.time()
        return {
            t_id: t
            for t_id, t in self.targets.items()
            if (now - t.last_seen) < self.stale_target_ttl
        }

    # ── Assignment Algorithms ─────────────────────────────────────────────────

    def run(self) -> list[Assignment]:
        """
        Execute the selected assignment algorithm and return the current
        list of assignments.
        """
        if not self.agents or not self.active_targets():
            return []

        if self.algorithm == "v1":
            return self._assign_v1_greedy()
        else:
            return self._assign_v2_antithrash()

    def _assign_v1_greedy(self) -> list[Assignment]:
        """
        V1 — Greedy nearest-agent assignment.

        For each target (sorted by confidence desc), assign the closest
        unoccupied agent. Simple but may thrash on movement.
        """
        distance_matrix = self.compute_distance_matrix()
        active = self.active_targets()

        # Reset current assignments
        new_assignments: dict[int, Assignment] = {}
        agent_load: dict[str, int] = defaultdict(int)   # how many targets each agent has

        # Process highest-confidence targets first
        sorted_targets = sorted(active.values(), key=lambda t: -t.confidence)

        for target in sorted_targets:
            t_id = target.id
            distances = distance_matrix.get(t_id, {})

            # Find closest agent with capacity
            for agent_id, dist in distances.items():
                if agent_load[agent_id] < self.agents[agent_id].max_assignments:
                    new_assignments[t_id] = Assignment(
                        target_id=t_id,
                        agent_id=agent_id,
                        distance=dist,
                    )
                    agent_load[agent_id] += 1
                    break

        self._apply_assignments(new_assignments)
        return list(self.assignments.values())

    def _assign_v2_antithrash(self) -> list[Assignment]:
        """
        V2 — Anti-thrash assignment.

        Rules:
          • Keep existing assignment unless a better agent is >threshold closer.
          • Cap assignments per agent at max_assignments_per_agent.
          • High-confidence targets are processed first.
          • Stale targets (not updated recently) are ignored.
        """
        distance_matrix = self.compute_distance_matrix()
        active = self.active_targets()

        new_assignments: dict[int, Assignment] = {}
        agent_load: dict[str, int] = defaultdict(int)

        # Count existing agent load to respect caps
        for assignment in self.assignments.values():
            if assignment.target_id in active:
                agent_load[assignment.agent_id] += 1

        # Process highest-confidence targets first
        sorted_targets = sorted(active.values(), key=lambda t: -t.confidence)

        for target in sorted_targets:
            t_id = target.id
            distances = distance_matrix.get(t_id, {})
            current = self.assignments.get(t_id)

            # Try to keep existing assignment
            if current and current.agent_id in self.agents:
                existing_dist = distances.get(current.agent_id, math.inf)
                current_agent_id = current.agent_id

                # Find best available agent
                best_agent_id, best_dist = self._best_available_agent(
                    distances, agent_load, current_agent_id
                )

                improvement = existing_dist - best_dist

                if best_agent_id and improvement > self.reassign_threshold:
                    # Reassign — clear load of old agent
                    agent_load[current_agent_id] = max(0, agent_load[current_agent_id] - 1)
                    new_assignments[t_id] = Assignment(
                        target_id=t_id,
                        agent_id=best_agent_id,
                        distance=best_dist,
                    )
                    agent_load[best_agent_id] += 1
                    log.info(
                        f"Target {t_id}: reassigned {current_agent_id}→{best_agent_id} "
                        f"(Δ={improvement:.2f}m > threshold={self.reassign_threshold}m)"
                    )
                else:
                    # Keep existing
                    new_assignments[t_id] = Assignment(
                        target_id=t_id,
                        agent_id=current_agent_id,
                        distance=existing_dist,
                    )
                    agent_load[current_agent_id] += 1

            else:
                # No existing assignment — assign best available
                best_agent_id, best_dist = self._best_available_agent(
                    distances, agent_load, exclude=None
                )
                if best_agent_id:
                    new_assignments[t_id] = Assignment(
                        target_id=t_id,
                        agent_id=best_agent_id,
                        distance=best_dist,
                    )
                    agent_load[best_agent_id] += 1

        self._apply_assignments(new_assignments)
        return list(self.assignments.values())

    def _best_available_agent(
        self,
        distances: dict[str, float],
        agent_load: dict[str, int],
        exclude: Optional[str] = None,
    ) -> tuple[Optional[str], float]:
        """Return (agent_id, distance) for the closest agent with capacity."""
        for agent_id, dist in distances.items():
            if agent_id == exclude:
                continue
            cap = self.agents[agent_id].max_assignments
            if agent_load[agent_id] < cap:
                return agent_id, dist
        return None, math.inf

    def _apply_assignments(self, new_assignments: dict[int, Assignment]):
        """Commit new assignments and update agent state."""
        # Clear old agent pointers
        for agent in self.agents.values():
            agent.current_assignment = None

        self.assignments = new_assignments

        for t_id, assignment in new_assignments.items():
            if assignment.agent_id in self.agents:
                self.agents[assignment.agent_id].current_assignment = t_id

        self._assignment_history.append({
            "timestamp": time.time(),
            "assignments": {t_id: a.agent_id for t_id, a in new_assignments.items()},
        })

    # ── Output API ────────────────────────────────────────────────────────────

    def get_output(self) -> dict:
        """
        Returns the standardised JSON output payload:

        {
          "assignments": [
            {"target_id": 12, "agent_id": "A", "distance": 3.2, "timestamp": ...}
          ],
          "agents": { ... },
          "unassigned_targets": [ ... ],
          "algorithm": "v2",
          "timestamp": ...
        }
        """
        active = self.active_targets()
        assigned_targets = set(self.assignments.keys())
        unassigned = [t_id for t_id in active if t_id not in assigned_targets]

        return {
            "assignments": [
                {
                    "target_id": a.target_id,
                    "agent_id": a.agent_id,
                    "distance": round(a.distance, 3),
                    "timestamp": a.timestamp,
                }
                for a in self.assignments.values()
            ],
            "agents": {
                a_id: {
                    "position": asdict(agent.position),
                    "current_assignment": agent.current_assignment,
                }
                for a_id, agent in self.agents.items()
            },
            "unassigned_targets": unassigned,
            "algorithm": self.algorithm,
            "timestamp": time.time(),
        }

    def get_distance_matrix_output(self) -> dict:
        """Return full distance matrix for debugging."""
        return {
            str(t_id): {
                a_id: round(dist, 3)
                for a_id, dist in row.items()
            }
            for t_id, row in self.compute_distance_matrix().items()
        }
