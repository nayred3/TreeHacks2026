"""
Assignment & Coordination Engine
=================================

Owns: Deciding which agent responds to which target.

Responsibilities:
  1. Agent state table
  2. Distance matrix computation
  3. Assignment algorithm (v1 greedy, v2 anti-thrash)
  4. Output API (JSON assignments)

Usage:
  Run standalone:   python assignment_engine.py
  Import as module: from assignment_engine import AssignmentEngine
"""

import math
import time
import json
import asyncio
import logging
from dataclasses import dataclass, field, asdict
from typing import Optional
from collections import defaultdict

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("AssignmentEngine")


# ──────────────────────────────────────────────────────────────────────────────
# Data Models
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class Position:
    x: float
    y: float

    def distance_to(self, other: "Position") -> float:
        return math.sqrt((self.x - other.x) ** 2 + (self.y - other.y) ** 2)


@dataclass
class Agent:
    id: str
    position: Position
    current_assignment: Optional[int] = None   # target_id or None
    max_assignments: int = 1                   # cap: how many targets per agent
    last_updated: float = field(default_factory=time.time)


@dataclass
class Target:
    id: int
    position: Position
    confidence: float = 1.0
    last_seen: float = field(default_factory=time.time)


@dataclass
class Assignment:
    target_id: int
    agent_id: str
    distance: float
    timestamp: float = field(default_factory=time.time)


# ──────────────────────────────────────────────────────────────────────────────
# Core Engine
# ──────────────────────────────────────────────────────────────────────────────

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


# ──────────────────────────────────────────────────────────────────────────────
# WebSocket / HTTP Server (FastAPI)
# ──────────────────────────────────────────────────────────────────────────────

def create_app(engine: AssignmentEngine):
    """
    Creates a FastAPI app that exposes:

      POST /agents         — update agent position
      POST /targets        — update target position
      DELETE /targets/{id} — remove a target
      GET  /assignments    — get current assignments
      GET  /matrix         — get distance matrix (debug)
      WS   /ws             — real-time push of assignments at 10 Hz

    Install: pip install fastapi uvicorn websockets
    Run:     uvicorn assignment_engine:app --reload --port 8001
    """
    try:
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect
        from fastapi.middleware.cors import CORSMiddleware
        from pydantic import BaseModel
    except ImportError:
        log.warning("FastAPI not installed. HTTP server unavailable.")
        return None

    app = FastAPI(title="Assignment Engine API", version="1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    connected_websockets: list[WebSocket] = []

    class AgentUpdate(BaseModel):
        agent_id: str
        x: float
        y: float
        max_assignments: int = 1

    class TargetUpdate(BaseModel):
        target_id: int
        x: float
        y: float
        confidence: float = 1.0

    @app.post("/agents")
    async def update_agent(body: AgentUpdate):
        engine.update_agent(body.agent_id, body.x, body.y, body.max_assignments)
        result = engine.run()
        payload = engine.get_output()
        # Push update to all WS clients
        for ws in connected_websockets:
            try:
                await ws.send_json(payload)
            except Exception:
                pass
        return payload

    @app.post("/targets")
    async def update_target(body: TargetUpdate):
        engine.update_target(body.target_id, body.x, body.y, body.confidence)
        result = engine.run()
        payload = engine.get_output()
        for ws in connected_websockets:
            try:
                await ws.send_json(payload)
            except Exception:
                pass
        return payload

    @app.delete("/targets/{target_id}")
    async def remove_target(target_id: int):
        engine.remove_target(target_id)
        payload = engine.get_output()
        for ws in connected_websockets:
            try:
                await ws.send_json(payload)
            except Exception:
                pass
        return {"removed": target_id}

    @app.get("/assignments")
    async def get_assignments():
        engine.run()
        return engine.get_output()

    @app.get("/matrix")
    async def get_matrix():
        return engine.get_distance_matrix_output()

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        await websocket.accept()
        connected_websockets.append(websocket)
        log.info(f"WS client connected ({len(connected_websockets)} total)")
        try:
            while True:
                # Push at 10 Hz
                engine.run()
                await websocket.send_json(engine.get_output())
                await asyncio.sleep(0.1)
        except WebSocketDisconnect:
            connected_websockets.remove(websocket)
            log.info("WS client disconnected")

    return app


# ──────────────────────────────────────────────────────────────────────────────
# Demo / Standalone Test
# ──────────────────────────────────────────────────────────────────────────────

def _run_demo():
    """Simulate a Nerf fight scenario on a single floor."""
    print("\n" + "=" * 60)
    print("  ASSIGNMENT ENGINE — DEMO SIMULATION")
    print("=" * 60)

    engine = AssignmentEngine(
        algorithm="v2",
        reassign_threshold=2.0,
        max_assignments_per_agent=1,
        stale_target_ttl=10.0,
    )

    # --- Tick 0: Initial positions ---
    print("\n[Tick 0] Setup: 4 agents, 3 targets")
    engine.update_agent("Alice",   x=0,  y=0)
    engine.update_agent("Bob",     x=10, y=0)
    engine.update_agent("Charlie", x=5,  y=8)
    engine.update_agent("Diana",   x=2,  y=5)

    engine.update_target(101, x=1, y=1,  confidence=0.95)
    engine.update_target(102, x=9, y=1,  confidence=0.88)
    engine.update_target(103, x=5, y=9,  confidence=0.70)

    engine.run()
    _print_state(engine)

    # --- Tick 1: Target 102 moves slightly — should NOT cause reassignment ---
    print("\n[Tick 1] Target 102 moves slightly (should NOT reassign)")
    engine.update_target(102, x=9.3, y=1.2, confidence=0.88)
    engine.run()
    _print_state(engine)

    # --- Tick 2: Target 102 moves close to Charlie — SHOULD trigger reassignment ---
    print("\n[Tick 2] Target 102 leaps near Charlie (SHOULD reassign)")
    engine.update_target(102, x=5.5, y=7.5, confidence=0.88)
    engine.run()
    _print_state(engine)

    # --- Tick 3: New target 104 appears ---
    print("\n[Tick 3] New target 104 spotted")
    engine.update_target(104, x=2.5, y=4.5, confidence=0.60)
    engine.run()
    _print_state(engine)

    # --- Tick 4: Target 101 lost ---
    print("\n[Tick 4] Target 101 eliminated (removed)")
    engine.remove_target(101)
    engine.run()
    _print_state(engine)

    # --- Distance matrix dump ---
    print("\n[Debug] Distance Matrix (metres)")
    matrix = engine.compute_distance_matrix()
    header = f"{'':>10}" + "".join(f"{a:>10}" for a in sorted(engine.agents))
    print(header)
    for t_id, row in sorted(matrix.items()):
        row_str = f"Target {t_id:>3}" + "".join(
            f"{row.get(a, 0):>10.2f}" for a in sorted(engine.agents)
        )
        print(row_str)

    print("\n[Output JSON]")
    print(json.dumps(engine.get_output(), indent=2))
    print("\n" + "=" * 60)


def _print_state(engine: AssignmentEngine):
    assignments = engine.assignments
    active = engine.active_targets()
    print(f"  Active targets: {list(active.keys())}")
    print(f"  Assignments:")
    if not assignments:
        print("    (none)")
    for t_id, a in sorted(assignments.items()):
        print(f"    Target {t_id:>3} → Agent '{a.agent_id}' ({a.distance:.2f}m)")
    unassigned = [t for t in active if t not in assignments]
    if unassigned:
        print(f"  Unassigned targets: {unassigned}")


# ──────────────────────────────────────────────────────────────────────────────
# Entry Point
# ──────────────────────────────────────────────────────────────────────────────

engine = AssignmentEngine(algorithm="v2", reassign_threshold=2.0)

try:
    app = create_app(engine)
except Exception:
    app = None

if __name__ == "__main__":
    _run_demo()

    # Optionally launch HTTP+WS server
    import sys
    if "--serve" in sys.argv:
        try:
            import uvicorn
            print("\nStarting server on http://localhost:8001")
            print("Endpoints: POST /agents  POST /targets  GET /assignments  WS /ws")
            uvicorn.run("assignment_engine:app", host="0.0.0.0", port=8001, reload=True)
        except ImportError:
            print("Install uvicorn + fastapi to run the server: pip install fastapi uvicorn")