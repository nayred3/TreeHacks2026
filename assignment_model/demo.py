"""
Assignment & Coordination Engine — Demo / Standalone Test
=========================================================

Owns: Simulated Nerf fight scenario for demos.
"""

import json

from .engine import AssignmentEngine


def run_demo():
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
