"""
Assignment & Coordination Engine — WebSocket / HTTP Server
==========================================================

Owns: FastAPI app exposing REST and WebSocket endpoints.

Endpoints:
  POST /agents         — update agent position
  POST /targets        — update target position
  DELETE /targets/{id} — remove a target
  GET  /assignments    — get current assignments
  GET  /matrix         — get distance matrix (debug)
  WS   /ws             — real-time push of assignments at 10 Hz

Install: pip install fastapi uvicorn websockets
Run:     uvicorn backend.assignment:app --reload --port 8001
"""

import asyncio
import logging

from .engine import AssignmentEngine

log = logging.getLogger("AssignmentEngine")


def create_app(engine: AssignmentEngine):
    """Creates a FastAPI app wired to the given AssignmentEngine."""
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
        engine.run()
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
        engine.run()
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
