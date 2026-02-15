"""
Assignment & Coordination Engine
================================

Owns: Deciding which agent responds to which target based on proximity/distance.

This module is the main entry point. Submodules:
  models   — Position, Agent, Target, Assignment
  engine   — AssignmentEngine (distance matrix, assignment algorithms)
  server   — FastAPI app (REST + WebSocket)
  demo     — Demo simulation

Usage:
  Run standalone:   python -m backend.assignment
  Run with server:  python -m backend.assignment --serve
  Import as module: from backend.assignment import AssignmentEngine
"""

import sys

from .engine import AssignmentEngine
from .server import create_app
from .demo import run_demo

# Re-export for backward compatibility
__all__ = ["AssignmentEngine", "create_app", "run_demo"]

# Shared engine instance
engine = AssignmentEngine(algorithm="v2", reassign_threshold=2.0)

try:
    app = create_app(engine)
except Exception:
    app = None

if __name__ == "__main__":
    run_demo()

    # Optionally launch HTTP+WS server
    if "--serve" in sys.argv:
        try:
            import uvicorn
            print("\nStarting server on http://localhost:8001")
            print("Endpoints: POST /agents  POST /targets  GET /assignments  WS /ws")
            uvicorn.run("backend.assignment:app", host="0.0.0.0", port=8001, reload=True)
        except ImportError:
            print("Install uvicorn + fastapi to run the server: pip install fastapi uvicorn")
