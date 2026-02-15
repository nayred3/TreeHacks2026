"""
DXF Floor Plan Pipeline
========================
Parses a real .dxf building file into a navigable grid, then plugs
that grid directly into the Assignment Engine's A* pathfinder so that
agent↔target distances respect walls instead of flying straight through them.

Usage
-----
  # Generate a sample DXF (if you don't have a real one yet):
  python dxf_pipeline.py --generate sample_floor.dxf

  # Parse a real DXF and export the walkable grid as JSON:
  python dxf_pipeline.py --parse your_building.dxf --out grid.json

  # Run a full demo with pathfinding distances:
  python dxf_pipeline.py --demo sample_floor.dxf

Where to get sample DXF files
------------------------------
  1. Autodesk sample files (free):
       https://knowledge.autodesk.com/support/autocad/downloads
       → Search "sample DXF" → download "architectural_example.dxf"

  2. FreeCAD sample buildings:
       https://wiki.freecad.org/Samples  (several .dxf floor plans)

  3. Generate one with this script (--generate flag) — produces a realistic
       single-floor office layout with rooms, corridors, doors and labels
       that matches a typical Nerf-demo building floor.

Install
-------
  pip install ezdxf numpy

  ezdxf docs:  https://ezdxf.readthedocs.io
  The key entity types for floor plans are:
    LINE       — individual wall segments
    LWPOLYLINE — lightweight polyline (most modern DXF walls use this)
    POLYLINE   — older polyline format
    ARC        — curved walls (rare in floor plans)

Coordinate mapping
------------------
  DXF files store coordinates in their own "DXF world space" (usually millimetres
  or metres depending on the file).  We convert to your operational coordinate
  system (metres, origin = building SW corner) using two anchor points:

    anchor_dxf  = (x_dxf, y_dxf)   — a known point in the DXF file
    anchor_real = (x_m,   y_m  )   — where that point is in the real world (metres)
    scale       = metres_per_dxf_unit  (e.g. 0.001 if DXF is in mm)

  This lets you place agents/targets in real-world metres (from GPS/AirTag) and
  have them correctly located on the floor plan grid.
"""

import math
import json
import heapq
import struct
import zlib
import os
import sys
import argparse
from dataclasses import dataclass, field, asdict
from typing import Optional

# ─── Try to import ezdxf; fall back to a minimal built-in DXF reader ─────────
try:
    import ezdxf
    from ezdxf.math import Vec2
    HAS_EZDXF = True
    print("[INFO] ezdxf found — full DXF parsing enabled.")
except ImportError:
    HAS_EZDXF = False
    print("[WARN] ezdxf not installed.  Install with:  pip install ezdxf")
    print("       Using built-in minimal DXF reader (LINE + LWPOLYLINE only).")

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False
    print("[WARN] numpy not installed — using pure Python grid (slower).")


# ─────────────────────────────────────────────────────────────────────────────
# DATA MODELS
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class WallSegment:
    """A single straight wall segment in world space (metres)."""
    x1: float; y1: float
    x2: float; y2: float
    layer: str = "WALLS"


@dataclass
class DoorSegment:
    """A walkable doorway segment in world space (metres)."""
    x1: float; y1: float
    x2: float; y2: float
    layer: str = "DOORS"


@dataclass
class CoordTransform:
    """
    Converts between DXF file units and operational metres.

    Parameters
    ----------
    scale : float
        metres per DXF unit  (e.g. 0.001 if DXF is in millimetres)
    anchor_dxf : (float, float)
        A known reference point in DXF coordinates.
        Tip: use the building's SW corner — it's usually (0, 0) in the DXF.
    anchor_real : (float, float)
        Where anchor_dxf maps to in real-world metres (from GPS/survey).
        E.g. if the SW corner of the building is at (0, 0) in your system, use (0, 0).
    """
    scale: float = 1.0           # metres per DXF unit
    anchor_dxf:  tuple = (0.0, 0.0)
    anchor_real: tuple = (0.0, 0.0)

    def to_real(self, x_dxf: float, y_dxf: float) -> tuple:
        """Convert DXF coordinates → real-world metres."""
        rx = (x_dxf - self.anchor_dxf[0]) * self.scale + self.anchor_real[0]
        ry = (y_dxf - self.anchor_dxf[1]) * self.scale + self.anchor_real[1]
        return (rx, ry)

    def to_dxf(self, x_real: float, y_real: float) -> tuple:
        """Convert real-world metres → DXF coordinates."""
        xd = (x_real - self.anchor_real[0]) / self.scale + self.anchor_dxf[0]
        yd = (y_real - self.anchor_real[1]) / self.scale + self.anchor_dxf[1]
        return (xd, yd)


@dataclass
class FloorPlan:
    """
    Parsed floor plan ready for pathfinding.

    Attributes
    ----------
    walls       : list of WallSegment in real-world metres
    width_m     : floor plan width in metres
    height_m    : floor plan height in metres
    grid        : 2D list[list[int]]  0=wall  1=walkable  (row-major)
    resolution  : metres per grid cell (e.g. 0.2 = 20 cm per cell)
    transform   : CoordTransform used to build this plan
    layers      : all layer names found in the DXF
    """
    walls:      list = field(default_factory=list)
    doors:      list = field(default_factory=list)
    width_m:    float = 0.0
    height_m:   float = 0.0
    grid:       list  = field(default_factory=list)
    resolution: float = 0.2   # metres per cell
    transform:  CoordTransform = field(default_factory=CoordTransform)
    layers:     list  = field(default_factory=list)
    origin_x:   float = 0.0   # real-world X of grid cell (0,0)
    origin_y:   float = 0.0   # real-world Y of grid cell (0,0)

    def world_to_grid(self, x_m: float, y_m: float) -> tuple:
        """Convert real-world metres → (row, col) grid indices."""
        col = int((x_m - self.origin_x) / self.resolution)
        row = int((y_m - self.origin_y) / self.resolution)
        rows = len(self.grid)
        cols = len(self.grid[0]) if rows else 0
        col = max(0, min(cols - 1, col))
        row = max(0, min(rows - 1, row))
        return (row, col)

    def grid_to_world(self, row: int, col: int) -> tuple:
        """Convert (row, col) → real-world metres (cell centre)."""
        x = self.origin_x + (col + 0.5) * self.resolution
        y = self.origin_y + (row + 0.5) * self.resolution
        return (x, y)

    def is_walkable(self, row: int, col: int) -> bool:
        rows = len(self.grid)
        cols = len(self.grid[0]) if rows else 0
        if row < 0 or row >= rows or col < 0 or col >= cols:
            return False
        return self.grid[row][col] == 1

    def to_json(self) -> dict:
        """Serialise for sending to frontend / caching."""
        return {
            "width_m":    self.width_m,
            "height_m":   self.height_m,
            "resolution": self.resolution,
            "origin_x":   self.origin_x,
            "origin_y":   self.origin_y,
            "layers":     self.layers,
            "grid":       self.grid,          # list[list[int]]  0/1
            "walls": [
                {"x1": w.x1, "y1": w.y1, "x2": w.x2, "y2": w.y2, "layer": w.layer}
                for w in self.walls
            ],
            "doors": [
                {"x1": d.x1, "y1": d.y1, "x2": d.x2, "y2": d.y2, "layer": d.layer}
                for d in self.doors
            ],
        }


# ─────────────────────────────────────────────────────────────────────────────
# MINIMAL BUILT-IN DXF READER  (no ezdxf dependency)
# ─────────────────────────────────────────────────────────────────────────────

def _parse_dxf_minimal(filepath: str) -> list[WallSegment]:
    """
    Pure-Python DXF reader that extracts LINE and LWPOLYLINE entities.
    Handles ASCII DXF files (the most common format).
    Sufficient for basic floor plans if ezdxf is not available.
    """
    walls = []

    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        lines = [l.rstrip("\n") for l in f]

    i = 0
    current_entity = None
    current_layer  = "0"
    pts = []

    def flush_lwpoly():
        for j in range(len(pts) - 1):
            walls.append(WallSegment(pts[j][0], pts[j][1], pts[j+1][0], pts[j+1][1], current_layer))

    while i < len(lines) - 1:
        code = lines[i].strip()
        value = lines[i + 1].strip() if i + 1 < len(lines) else ""
        i += 2

        if code == "0":
            # Flush previous polyline
            if current_entity == "LWPOLYLINE" and len(pts) > 1:
                flush_lwpoly()
            current_entity = value
            pts = []
            current_layer = "0"

        if current_entity == "LINE":
            if code == "8":   current_layer = value
            if code == "10":  x1 = float(value)
            if code == "20":  y1 = float(value)
            if code == "11":  x2 = float(value)
            if code == "21":
                y2 = float(value)
                walls.append(WallSegment(x1, y1, x2, y2, current_layer))

        elif current_entity == "LWPOLYLINE":
            if code == "8":  current_layer = value
            if code == "10": pts.append([float(value), 0.0])
            if code == "20" and pts: pts[-1][1] = float(value)

    return walls


# ─────────────────────────────────────────────────────────────────────────────
# EZDXF-BASED FULL PARSER
# ─────────────────────────────────────────────────────────────────────────────

def _parse_dxf_ezdxf(filepath: str, wall_layers: list[str] = None) -> tuple[list, list]:
    """
    Parse a DXF file using ezdxf.
    Returns (wall_segments, layer_names).

    wall_layers: if provided, only extract walls from these layers.
                 Common layer names in architectural DXFs:
                   'WALLS', 'Wall', 'A-WALL', 'A_WALL', 'AR_ME_AW', '墙'
                 If None, extract ALL line entities.
    """
    doc = ezdxf.readfile(filepath)
    msp = doc.modelspace()
    layers = [layer.dxf.name for layer in doc.layers]
    walls  = []

    def _accept_layer(layer_name: str) -> bool:
        if wall_layers is None:
            return True   # accept everything
        return any(wl.lower() in layer_name.lower() for wl in wall_layers)

    # ── LINE entities ──────────────────────────────────────────────────────
    for e in msp.query("LINE"):
        if not _accept_layer(e.dxf.layer): continue
        walls.append(WallSegment(
            e.dxf.start.x, e.dxf.start.y,
            e.dxf.end.x,   e.dxf.end.y,
            e.dxf.layer,
        ))

    # ── LWPOLYLINE entities ────────────────────────────────────────────────
    for e in msp.query("LWPOLYLINE"):
        if not _accept_layer(e.dxf.layer): continue
        pts = list(e.vertices())     # list of Vec2
        closed = e.closed
        for j in range(len(pts) - 1):
            walls.append(WallSegment(pts[j].x, pts[j].y, pts[j+1].x, pts[j+1].y, e.dxf.layer))
        if closed and len(pts) > 1:
            walls.append(WallSegment(pts[-1].x, pts[-1].y, pts[0].x, pts[0].y, e.dxf.layer))

    # ── POLYLINE entities ──────────────────────────────────────────────────
    for e in msp.query("POLYLINE"):
        if not _accept_layer(e.dxf.layer): continue
        verts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
        for j in range(len(verts) - 1):
            walls.append(WallSegment(verts[j][0], verts[j][1], verts[j+1][0], verts[j+1][1], e.dxf.layer))

    # ── ARC entities (approximated as line segments) ───────────────────────
    for e in msp.query("ARC"):
        if not _accept_layer(e.dxf.layer): continue
        cx, cy = e.dxf.center.x, e.dxf.center.y
        r = e.dxf.radius
        a_start = math.radians(e.dxf.start_angle)
        a_end   = math.radians(e.dxf.end_angle)
        if a_end < a_start: a_end += 2 * math.pi
        n_segs = max(8, int((a_end - a_start) / (math.pi / 16)))
        prev = None
        for k in range(n_segs + 1):
            a = a_start + (a_end - a_start) * k / n_segs
            pt = (cx + r * math.cos(a), cy + r * math.sin(a))
            if prev:
                walls.append(WallSegment(prev[0], prev[1], pt[0], pt[1], e.dxf.layer))
            prev = pt

    print(f"[INFO] ezdxf: extracted {len(walls)} wall segments from {len(layers)} layers.")
    print(f"[INFO] Layers found: {layers}")
    return walls, layers


# ─────────────────────────────────────────────────────────────────────────────
# GRID BUILDER  (rasterise wall segments onto a 2D grid)
# ─────────────────────────────────────────────────────────────────────────────

def _rasterise_segment(grid, rows, cols, x1, y1, x2, y2, ox, oy, res):
    """
    Draw a wall segment onto the grid using Bresenham's line algorithm.
    Marks cells as WALL (0) by thickening by 1 cell in each direction.
    """
    c1 = int((x1 - ox) / res)
    r1 = int((y1 - oy) / res)
    c2 = int((x2 - ox) / res)
    r2 = int((y2 - oy) / res)

    # Bresenham
    dc, dr = abs(c2 - c1), abs(r2 - r1)
    sc = 1 if c1 < c2 else -1
    sr = 1 if r1 < r2 else -1
    err = dc - dr

    c, r = c1, r1
    cells = []
    while True:
        cells.append((r, c))
        if c == c2 and r == r2: break
        e2 = 2 * err
        if e2 > -dr: err -= dr; c += sc
        if e2 <  dc: err += dc; r += sr

    # Mark wall + 1-cell thickness
    for (rr, cc) in cells:
        for dr_ in [-1, 0, 1]:
            for dc_ in [-1, 0, 1]:
                nr, nc = rr + dr_, cc + dc_
                if 0 <= nr < rows and 0 <= nc < cols:
                    grid[nr][nc] = 0


def build_grid(walls: list[WallSegment], transform: CoordTransform,
               resolution: float = 0.2,
               padding_m: float = 1.0) -> FloorPlan:
    """
    Rasterise wall segments into a 2D walkable grid.

    Parameters
    ----------
    walls       : wall segments in DXF units
    transform   : coordinate transform to real-world metres
    resolution  : metres per grid cell (default 0.2 = 20 cm)
    padding_m   : extra margin around the building (metres)

    Returns a FloorPlan with a walkable grid ready for A*.
    """
    if not walls:
        raise ValueError("No wall segments provided — check DXF layer names.")

    # Convert all walls to real-world metres
    real_walls = []
    for w in walls:
        x1, y1 = transform.to_real(w.x1, w.y1)
        x2, y2 = transform.to_real(w.x2, w.y2)
        real_walls.append(WallSegment(x1, y1, x2, y2, w.layer))

    # Find bounding box
    all_x = [w.x1 for w in real_walls] + [w.x2 for w in real_walls]
    all_y = [w.y1 for w in real_walls] + [w.y2 for w in real_walls]
    min_x = min(all_x) - padding_m
    min_y = min(all_y) - padding_m
    max_x = max(all_x) + padding_m
    max_y = max(all_y) + padding_m

    width_m  = max_x - min_x
    height_m = max_y - min_y
    cols = math.ceil(width_m  / resolution)
    rows = math.ceil(height_m / resolution)

    print(f"[INFO] Grid: {rows}×{cols} cells, {width_m:.1f}m × {height_m:.1f}m, res={resolution}m/cell")

    # Start fully walkable, then stamp walls
    grid = [[1] * cols for _ in range(rows)]

    for w in real_walls:
        _rasterise_segment(grid, rows, cols, w.x1, w.y1, w.x2, w.y2,
                           min_x, min_y, resolution)

    # Border is always wall
    for c in range(cols):
        grid[0][c] = 0
        grid[rows-1][c] = 0
    for r in range(rows):
        grid[r][0] = 0
        grid[r][cols-1] = 0

    # Count walkable cells
    walkable = sum(grid[r][c] for r in range(rows) for c in range(cols))
    total    = rows * cols
    print(f"[INFO] Walkable: {walkable}/{total} cells ({100*walkable/total:.1f}%)")

    layers = list({w.layer for w in walls})

    return FloorPlan(
        walls      = real_walls,
        width_m    = width_m,
        height_m   = height_m,
        grid       = grid,
        resolution = resolution,
        transform  = transform,
        layers     = layers,
        origin_x   = min_x,
        origin_y   = min_y,
    )


def _carve_doors(fp: FloorPlan, doors: list[DoorSegment]):
    """Open walkable door cells on top of already-rasterised walls."""
    if not fp.grid:
        return
    rows = len(fp.grid)
    cols = len(fp.grid[0])

    def carve_point(x: float, y: float):
        r, c = fp.world_to_grid(x, y)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                rr = r + dr
                cc = c + dc
                if 0 <= rr < rows and 0 <= cc < cols:
                    fp.grid[rr][cc] = 1

    for d in doors:
        dx = d.x2 - d.x1
        dy = d.y2 - d.y1
        steps = max(1, int(max(abs(dx), abs(dy)) / max(fp.resolution / 2.0, 1e-6)))
        for i in range(steps + 1):
            t = i / steps
            carve_point(d.x1 + dx * t, d.y1 + dy * t)


# ─────────────────────────────────────────────────────────────────────────────
# A* PATHFINDER
# ─────────────────────────────────────────────────────────────────────────────

def astar_distance(floor_plan: FloorPlan,
                   start_m: tuple, goal_m: tuple) -> float:
    """
    Find the shortest walkable path between two real-world points (metres).

    Returns the path length in metres, or math.inf if no path exists
    (e.g. one point is behind a sealed wall with no door).

    The heuristic is Euclidean distance (admissible → optimal path guaranteed).
    8-directional movement: cardinal cost 1·res, diagonal cost √2·res.
    """
    fp = floor_plan
    start_rc = fp.world_to_grid(*start_m)
    goal_rc  = fp.world_to_grid(*goal_m)

    if not fp.is_walkable(*start_rc):
        # Snap start to nearest walkable cell
        start_rc = _nearest_walkable(fp, start_rc)
    if not fp.is_walkable(*goal_rc):
        goal_rc = _nearest_walkable(fp, goal_rc)

    if start_rc == goal_rc:
        return 0.0

    def h(r, c):
        gr, gc = goal_rc
        return math.hypot(r - gr, c - gc) * fp.resolution

    open_set = [(h(*start_rc), 0.0, start_rc)]
    g_score  = {start_rc: 0.0}
    DIRS = [(-1,0,fp.resolution),(1,0,fp.resolution),(0,-1,fp.resolution),(0,1,fp.resolution),
            (-1,-1,fp.resolution*1.4142),(-1,1,fp.resolution*1.4142),(1,-1,fp.resolution*1.4142),(1,1,fp.resolution*1.4142)]

    while open_set:
        _, g, (r, c) = heapq.heappop(open_set)
        if (r, c) == goal_rc:
            return g
        if g > g_score.get((r, c), math.inf):
            continue
        for dr, dc, cost in DIRS:
            nr, nc = r + dr, c + dc
            if not fp.is_walkable(nr, nc):
                continue
            ng = g + cost
            if ng < g_score.get((nr, nc), math.inf):
                g_score[(nr, nc)] = ng
                heapq.heappush(open_set, (ng + h(nr, nc), ng, (nr, nc)))

    return math.inf   # no path found


def _nearest_walkable(fp: FloorPlan, rc: tuple, max_radius: int = 10) -> tuple:
    """Snap a grid cell to the nearest walkable cell within max_radius."""
    r0, c0 = rc
    for radius in range(1, max_radius + 1):
        for dr in range(-radius, radius + 1):
            for dc in range(-radius, radius + 1):
                nr, nc = r0 + dr, c0 + dc
                if fp.is_walkable(nr, nc):
                    return (nr, nc)
    return rc   # give up


def compute_pathfinding_matrix(floor_plan: FloorPlan,
                               agents: list[dict],
                               targets: list[dict]) -> dict:
    """
    Compute full A* distance matrix: every agent × every target.

    agents  : [{"id": "Alice", "position": {"x": 5.0, "y": 3.0}}, ...]
    targets : [{"id": 1,       "position": {"x": 12.0,"y": 7.0}}, ...]

    Returns {
        "by_target": { target_id: { agent_id: astar_dist, ... } },
        "by_agent":  { agent_id:  { target_id: astar_dist, ... } },
    }
    Distances are in metres (∞ if unreachable).
    """
    by_target = {}
    by_agent  = {a["id"]: {} for a in agents}

    for t in targets:
        row = {}
        for a in agents:
            d = astar_distance(
                floor_plan,
                (a["position"]["x"], a["position"]["y"]),
                (t["position"]["x"], t["position"]["y"]),
            )
            row[a["id"]] = round(d, 3)
            by_agent[a["id"]][str(t["id"])] = round(d, 3)
        # Sort nearest first (mirrors assignment_engine.py)
        by_target[str(t["id"])] = dict(sorted(row.items(), key=lambda kv: kv[1]))

    return {"by_target": by_target, "by_agent": by_agent}


def build_arbitrary_single_floor(resolution: float = 0.4) -> FloorPlan:
    """
    Build an arbitrary single-floor layout with explicit walls and doors.
    Doors are openings in walls (walkable) and are also tracked for map rendering.
    """
    W, H = 38.0, 24.0
    walls: list[WallSegment] = []
    doors: list[DoorSegment] = []

    # Outer shell walls (continuous) + door segments on those walls.
    walls += [
        WallSegment(0, 0, W, 0),
        WallSegment(0, H, W, H),
        WallSegment(0, 0, 0, H),
        WallSegment(W, 0, W, H),
    ]
    doors += [
        DoorSegment(5, 0, 8, 0),
        DoorSegment(17, H, 20, H),
        DoorSegment(0, 9, 0, 12),
    ]

    # Corridor wall with doors on the wall.
    walls += [WallSegment(0, 10, W, 10)]
    doors += [DoorSegment(7, 10, 10, 10), DoorSegment(18, 10, 21, 10), DoorSegment(29, 10, 32, 10)]

    # Vertical room dividers with doors on the wall.
    walls += [WallSegment(10, 10, 10, H), WallSegment(20, 10, 20, H), WallSegment(30, 10, 30, H)]
    doors += [DoorSegment(10, 14, 10, 17), DoorSegment(20, 12, 20, 15), DoorSegment(30, 16, 30, 19)]

    # Lower area partial barriers.
    walls += [WallSegment(14, 0, 14, 5), WallSegment(24, 0, 24, 6)]

    fp = build_grid(walls, CoordTransform(scale=1.0), resolution=resolution)
    # Carve door openings directly into wall raster.
    _carve_doors(fp, doors)
    fp.doors = doors
    return fp


def _solve_top_assignments(agents: list[dict], targets: list[dict], by_agent: dict, top_k: int = 2) -> list[dict]:
    """
    Return up to top_k minimal-cost assignments of agent->target.
    Coverage rules:
      - agents >= targets: target coverage is mandatory.
      - targets > agents: one primary target per agent (target uniqueness enforced).
    """
    agent_ids = [a["id"] for a in agents]
    target_ids = [int(t["id"]) for t in targets]
    more_agents_than_targets = len(agent_ids) >= len(target_ids)

    rankings: dict[str, list[int]] = {}
    for aid in agent_ids:
        pairs = []
        row = by_agent.get(aid, {})
        for tid in target_ids:
            d = row.get(str(tid), math.inf)
            if math.isfinite(d):
                pairs.append((tid, d))
        rankings[aid] = [tid for tid, _ in sorted(pairs, key=lambda x: x[1])]

    if not target_ids or not agent_ids:
        return []

    # Avoid bit-shift overflow; fallback to greedy.
    if len(target_ids) > 30:
        greedy = {}
        for aid in agent_ids:
            if rankings[aid]:
                greedy[aid] = rankings[aid][0]
        return [{"cost": 0.0, "map": greedy}]

    target_index = {tid: i for i, tid in enumerate(target_ids)}
    best: list[dict] = []
    used_targets = set()
    current: dict[str, int] = {}

    def consider(cost: float):
        key = tuple((aid, current.get(aid)) for aid in agent_ids)
        if any(b["key"] == key for b in best):
            return
        best.append({"key": key, "cost": cost, "map": dict(current)})
        best.sort(key=lambda x: x["cost"])
        if len(best) > top_k:
            best.pop()

    def dfs(agent_pos: int, cost: float, coverage_mask: int):
        if best and len(best) >= top_k and cost >= best[-1]["cost"]:
            return
        if agent_pos == len(agent_ids):
            if more_agents_than_targets:
                full_mask = (1 << len(target_ids)) - 1
                if coverage_mask != full_mask:
                    return
            consider(cost)
            return

        aid = agent_ids[agent_pos]
        for tid in rankings[aid]:
            if not more_agents_than_targets and tid in used_targets:
                continue
            dist = by_agent.get(aid, {}).get(str(tid), math.inf)
            if not math.isfinite(dist):
                continue
            current[aid] = tid
            next_mask = coverage_mask | (1 << target_index[tid])
            if not more_agents_than_targets:
                used_targets.add(tid)
            dfs(agent_pos + 1, cost + dist, next_mask)
            if not more_agents_than_targets:
                used_targets.remove(tid)
            del current[aid]

    dfs(0, 0.0, 0)
    return best


def compute_astar_assignments(floor_plan: FloorPlan, agents: list[dict], targets: list[dict]) -> dict:
    """
    A* distance-based assignment with primary/secondary rules.
    """
    matrix = compute_pathfinding_matrix(floor_plan, agents, targets)
    by_agent = matrix["by_agent"]

    solutions = _solve_top_assignments(agents, targets, by_agent, top_k=2)
    agent_ids = [a["id"] for a in agents]
    target_ids = [int(t["id"]) for t in targets]

    # Primary mapping (agent -> target), fallback to nearest if solver is empty.
    primary_agent_to_target: dict[str, int] = {}
    if solutions:
        primary_agent_to_target = dict(solutions[0]["map"])
    else:
        for aid in agent_ids:
            row = by_agent.get(aid, {})
            best_tid = None
            best_dist = math.inf
            for tid in target_ids:
                d = row.get(str(tid), math.inf)
                if d < best_dist:
                    best_dist = d
                    best_tid = tid
            if best_tid is not None:
                primary_agent_to_target[aid] = best_tid

    # Target -> primary agent (choose closest if many agents share target).
    primary: dict[int, str] = {}
    for aid, tid in primary_agent_to_target.items():
        d = by_agent.get(aid, {}).get(str(tid), math.inf)
        prev = primary.get(tid)
        if prev is None or d < by_agent.get(prev, {}).get(str(tid), math.inf):
            primary[tid] = aid

    # Secondary only when targets exceed agents.
    secondary: dict[int, str] = {}
    if len(target_ids) > len(agent_ids) and len(solutions) > 1:
        second_map = dict(solutions[1]["map"])
        for aid, tid in second_map.items():
            if tid == primary_agent_to_target.get(aid):
                continue
            d = by_agent.get(aid, {}).get(str(tid), math.inf)
            prev = secondary.get(tid)
            if prev is None or d < by_agent.get(prev, {}).get(str(tid), math.inf):
                secondary[tid] = aid

    if len(target_ids) > len(agent_ids):
        # Coverage completion for extra targets:
        # choose closest agent; tie-break by earliest completion of primary+queued secondaries.
        agent_load = {
            aid: by_agent.get(aid, {}).get(str(primary_agent_to_target.get(aid, -1)), math.inf)
            for aid in agent_ids
        }
        for aid, load in list(agent_load.items()):
            if not math.isfinite(load):
                agent_load[aid] = 0.0
        for tid, aid in secondary.items():
            d = by_agent.get(aid, {}).get(str(tid), math.inf)
            if math.isfinite(d):
                agent_load[aid] += d

        covered = set(primary.keys()) | set(secondary.keys())
        for tid in target_ids:
            if tid in covered:
                continue
            best_aid = None
            best_dist = math.inf
            best_load = math.inf
            for aid in agent_ids:
                d = by_agent.get(aid, {}).get(str(tid), math.inf)
                if not math.isfinite(d):
                    continue
                load = agent_load.get(aid, 0.0)
                if d < best_dist or (d == best_dist and load < best_load):
                    best_aid = aid
                    best_dist = d
                    best_load = load
            if best_aid is not None:
                secondary[tid] = best_aid
                agent_load[best_aid] = agent_load.get(best_aid, 0.0) + best_dist

    # Per-agent secondary list (can include multiple targets if targets > agents).
    agent_secondary: dict[str, list[int]] = {aid: [] for aid in agent_ids}
    for tid, aid in secondary.items():
        agent_secondary[aid].append(tid)
    for aid in agent_ids:
        agent_secondary[aid].sort(key=lambda tid: by_agent.get(aid, {}).get(str(tid), math.inf))

    unassigned = [tid for tid in target_ids if tid not in primary and tid not in secondary]
    return {
        "matrix": matrix,
        "primary": {str(tid): aid for tid, aid in primary.items()},
        "secondary": {str(tid): aid for tid, aid in secondary.items()},
        "agent_primary": {aid: int(tid) for aid, tid in primary_agent_to_target.items()},
        "agent_secondary": {aid: tids for aid, tids in agent_secondary.items()},
        "unassigned_targets": unassigned,
    }


def render_ascii_map(floor_plan: FloorPlan, agents: list[dict], targets: list[dict], assignments: Optional[dict] = None):
    """Render a compact text map with walls (#), doors (D), agents, and targets."""
    rows = len(floor_plan.grid)
    cols = len(floor_plan.grid[0]) if rows else 0
    canvas = [["." if floor_plan.grid[r][c] == 1 else "#" for c in range(cols)] for r in range(rows)]

    # Mark doors as walkable doorway cells.
    for d in floor_plan.doors:
        x_mid = (d.x1 + d.x2) / 2.0
        y_mid = (d.y1 + d.y2) / 2.0
        r, c = floor_plan.world_to_grid(x_mid, y_mid)
        if 0 <= r < rows and 0 <= c < cols:
            canvas[r][c] = "D"

    # Mark targets
    for t in targets:
        r, c = floor_plan.world_to_grid(t["position"]["x"], t["position"]["y"])
        mark = str(t["id"])[-1]
        if 0 <= r < rows and 0 <= c < cols:
            canvas[r][c] = mark

    # Mark agents
    for a in agents:
        r, c = floor_plan.world_to_grid(a["position"]["x"], a["position"]["y"])
        mark = a["id"][0].upper()
        if 0 <= r < rows and 0 <= c < cols:
            canvas[r][c] = mark

    print("\n[Map Demo — single floor]")
    print("Legend: # wall, . walkable, D door, A/B/C/D agents, 1..9 targets")
    for r in range(rows - 1, -1, -1):
        print("".join(canvas[r]))

    if assignments:
        print("\n[Assignments]")
        for tid, aid in sorted(assignments["primary"].items(), key=lambda kv: int(kv[0])):
            print(f"  Target {tid} -> Primary {aid}")
        for tid, aid in sorted(assignments["secondary"].items(), key=lambda kv: int(kv[0])):
            print(f"  Target {tid} -> Secondary {aid}")


# ─────────────────────────────────────────────────────────────────────────────
# SAMPLE DXF GENERATOR
# Creates a realistic single-floor office/building layout
# ─────────────────────────────────────────────────────────────────────────────

def generate_sample_dxf(filepath: str):
    """
    Generate a sample single-floor building DXF.
    Layout (all dimensions in metres, DXF units = metres):

       ┌─────────────────────────────────────────────┐
       │  CORRIDOR (2m wide, runs E-W)               │
       │  ┌───────┐  ┌────────┐  ┌──────┐  ┌──────┐ │
       │  │ Room  │  │  Room  │  │ Room │  │ Room │ │
       │  │  A    │  │   B    │  │  C   │  │  D   │ │
       │  └───────┘  └────────┘  └──────┘  └──────┘ │
       │                                             │
       │  ┌────────────────────────────────────────┐ │
       │  │  Large open area (e.g. warehouse/gym)  │ │
       │  └────────────────────────────────────────┘ │
       └─────────────────────────────────────────────┘

    Walls are on layer "WALLS", doors are openings (gaps), text on "TEXT".
    """
    # Pure text DXF — no ezdxf needed to generate this
    W, H = 40.0, 25.0    # building footprint in metres

    def line(x1, y1, x2, y2, layer="WALLS"):
        return (
            f"  0\nLINE\n  8\n{layer}\n"
            f" 10\n{x1:.4f}\n 20\n{y1:.4f}\n 30\n0.0\n"
            f" 11\n{x2:.4f}\n 21\n{y2:.4f}\n 31\n0.0\n"
        )

    def text(x, y, txt, height=0.5, layer="TEXT"):
        return (
            f"  0\nTEXT\n  8\n{layer}\n"
            f" 10\n{x:.4f}\n 20\n{y:.4f}\n 30\n0.0\n"
            f" 40\n{height:.4f}\n  1\n{txt}\n"
        )

    entities = []

    # ── Outer walls ───────────────────────────────────────────────────────────
    # South wall (bottom), door gap at x=4-6
    entities += [line(0, 0, 3.5, 0), line(6.0, 0, W, 0)]
    # North wall (top), door gap at x=18-20
    entities += [line(0, H, 17.5, H), line(20.0, H, W, H)]
    # West wall
    entities += [line(0, 0, 0, H)]
    # East wall
    entities += [line(W, 0, W, H)]

    # ── Corridor wall (horizontal, at y=10) with door gaps ───────────────────
    #   Door gaps: x=8-10,  x=18-20,  x=28-30
    entities += [
        line(0, 10, 7.5, 10),
        line(10.5, 10, 17.5, 10),
        line(20.5, 10, 27.5, 10),
        line(30.5, 10, W, 10),
    ]

    # ── Room dividers (vertical walls in the top zone, y=10..H) ─────────────
    # Room A | Room B: x=10, door gap at y=16-18
    entities += [line(10, 10, 10, 15.5), line(10, 18.5, 10, H)]
    # Room B | Room C: x=20, door gap at y=12-14
    entities += [line(20, 10, 20, 11.5), line(20, 14.5, 20, H)]
    # Room C | Room D: x=30, door gap at y=16-18
    entities += [line(30, 10, 30, 15.5), line(30, 18.5, 30, H)]

    # ── Lower zone divider (horizontal at y=5) ────────────────────────────────
    # Large open area south of corridor, split by a partial wall
    entities += [line(15, 0, 15, 4.5)]  # stub wall — open plan otherwise

    # ── Room labels ───────────────────────────────────────────────────────────
    entities += [
        text(1, 17, "ROOM A"),
        text(11, 17, "ROOM B"),
        text(21, 17, "ROOM C"),
        text(31, 17, "ROOM D"),
        text(4, 5, "OPEN AREA (SOUTH)"),
        text(1, 11.5, "CORRIDOR"),
    ]

    # ── Assemble DXF ─────────────────────────────────────────────────────────
    header = (
        "  0\nSECTION\n  2\nHEADER\n"
        "  9\n$ACADVER\n  1\nAC1009\n"
        "  9\n$INSUNITS\n 70\n6\n"   # 6 = metres
        "  9\n$EXTMIN\n 10\n0.0\n 20\n0.0\n 30\n0.0\n"
        f"  9\n$EXTMAX\n 10\n{W}\n 20\n{H}\n 30\n0.0\n"
        "  0\nENDSEC\n"
        "  0\nSECTION\n  2\nENTITIES\n"
    )
    footer = "  0\nENDSEC\n  0\nEOF\n"

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(header)
        for e in entities:
            f.write(e)
        f.write(footer)

    print(f"[INFO] Sample DXF written to: {filepath}")
    print(f"[INFO] Building: {W}m × {H}m with rooms, corridor, and door openings.")
    print(f"[INFO] Layer 'WALLS' contains all structural elements.")


# ─────────────────────────────────────────────────────────────────────────────
# MAIN PIPELINE  (parse → grid → distance matrix)
# ─────────────────────────────────────────────────────────────────────────────

def parse_dxf(filepath: str,
              transform: CoordTransform = None,
              wall_layers: list[str] = None,
              resolution: float = 0.2) -> FloorPlan:
    """
    Full pipeline: DXF file → FloorPlan with navigable grid.

    Parameters
    ----------
    filepath    : path to .dxf file
    transform   : CoordTransform for real-world mapping.
                  If None, assumes DXF units are metres and origin = (0,0).
    wall_layers : layer names to treat as walls.
                  None = use everything (safe for simple files).
                  Common values: ['WALLS', 'Wall', 'A-WALL', 'A_WALL']
    resolution  : grid cell size in metres (smaller = more accurate but slower)
    """
    if transform is None:
        transform = CoordTransform(scale=1.0, anchor_dxf=(0,0), anchor_real=(0,0))

    if HAS_EZDXF:
        walls, layers = _parse_dxf_ezdxf(filepath, wall_layers)
    else:
        walls  = _parse_dxf_minimal(filepath)
        layers = list({w.layer for w in walls})
        print(f"[INFO] Minimal reader: extracted {len(walls)} segments from {len(layers)} layers.")

    if not walls:
        raise ValueError(
            f"No wall segments found in {filepath}.\n"
            f"If using layer filter, check layer names with --list-layers.\n"
            f"Common wall layers: WALLS, Wall, A-WALL, A_WALL, AR_ME_AW"
        )

    return build_grid(walls, transform, resolution)


def export_grid_json(floor_plan: FloorPlan, out_path: str):
    """Export floor plan to JSON for the frontend."""
    with open(out_path, "w") as f:
        json.dump(floor_plan.to_json(), f)
    size_kb = os.path.getsize(out_path) / 1024
    print(f"[INFO] Grid JSON written to {out_path} ({size_kb:.1f} KB)")


# ─────────────────────────────────────────────────────────────────────────────
# DEMO
# ─────────────────────────────────────────────────────────────────────────────

def _run_demo(dxf_path: str):
    print("\n" + "="*65)
    print("  DXF PIPELINE DEMO — Pathfinding-Aware Assignment")
    print("="*65)

    # Parse the DXF
    # For this demo, DXF units = metres, no transform needed
    fp = parse_dxf(dxf_path, resolution=0.3)

    # Agents and targets in real-world metres
    agents = [
        {"id": "Alice",   "position": {"x":  2.0, "y":  2.0}},
        {"id": "Bob",     "position": {"x": 35.0, "y":  2.0}},
        {"id": "Charlie", "position": {"x":  2.0, "y": 18.0}},
        {"id": "Diana",   "position": {"x": 25.0, "y": 18.0}},
    ]
    targets = [
        {"id": 1, "position": {"x":  5.0, "y": 18.0}},
        {"id": 2, "position": {"x": 35.0, "y": 18.0}},
        {"id": 3, "position": {"x": 20.0, "y":  2.0}},
    ]

    print("\n[A*] Computing pathfinding distance matrix…")
    matrix = compute_pathfinding_matrix(fp, agents, targets)

    print("\n[Distance Matrix — A* walkable metres]")
    agent_ids = [a["id"] for a in agents]
    header = f"{'':>10}" + "".join(f"{a:>10}" for a in agent_ids)
    print(header)
    for tid, row in sorted(matrix["by_target"].items()):
        dists = "".join(
            f"{'∞':>10}" if v == float("inf") else f"{v:>10.1f}"
            for v in [row.get(a, float("inf")) for a in agent_ids]
        )
        print(f"Target  {tid:>2}{dists}")

    print("\n[Note] Compare with Euclidean (straight-line) distances:")
    import math
    for t in targets:
        for a in agents:
            ed = math.hypot(t["position"]["x"]-a["position"]["x"],
                            t["position"]["y"]-a["position"]["y"])
            ad = matrix["by_target"][str(t["id"])].get(a["id"], float("inf"))
            ratio = ad/ed if ed > 0 else 1
            print(f"  T{t['id']} ↔ {a['id']:8s}  Euclidean={ed:5.1f}m  A*={ad:5.1f}m  ratio={ratio:.2f}×")

    print("\n[Export] Saving grid to sample_grid.json…")
    export_grid_json(fp, "sample_grid.json")
    print("\n" + "="*65)


def _run_map_demo():
    """Arbitrary single-floor map demo with walls, doors, A* assignment rules."""
    print("\n" + "=" * 70)
    print("  MAP DEMO — Arbitrary Walls/Doors + A* Primary/Secondary Assignment")
    print("=" * 70)

    fp = build_arbitrary_single_floor(resolution=0.4)
    agents = [
        {"id": "Alice",   "position": {"x": 2.0,  "y": 2.0}},
        {"id": "Bob",     "position": {"x": 34.0, "y": 2.0}},
        {"id": "Charlie", "position": {"x": 3.0,  "y": 19.0}},
        {"id": "Diana",   "position": {"x": 27.0, "y": 19.0}},
    ]
    targets = [
        {"id": 1, "position": {"x": 7.0,  "y": 18.0}},
        {"id": 2, "position": {"x": 18.0, "y": 18.0}},
        {"id": 3, "position": {"x": 32.0, "y": 18.0}},
        {"id": 4, "position": {"x": 12.0, "y": 5.0}},
        {"id": 5, "position": {"x": 22.0, "y": 4.0}},
        {"id": 6, "position": {"x": 4.0,  "y": 11.0}},
    ]

    assignments = compute_astar_assignments(fp, agents, targets)
    render_ascii_map(fp, agents, targets, assignments)

    print("\n[Distance Matrix — A* walkable metres]")
    matrix = assignments["matrix"]["by_target"]
    agent_ids = [a["id"] for a in agents]
    print(f"{'':>10}" + "".join(f"{a:>10}" for a in agent_ids))
    for tid in sorted(matrix.keys(), key=int):
        row = matrix[tid]
        cells = "".join(
            f"{'∞':>10}" if row.get(a, math.inf) == math.inf else f"{row.get(a, math.inf):>10.1f}"
            for a in agent_ids
        )
        print(f"Target  {tid:>2}{cells}")

    print("\n[Per-agent task queue]")
    for aid in agent_ids:
        p1 = assignments["agent_primary"].get(aid)
        p2s = assignments["agent_secondary"].get(aid, [])
        print(f"  {aid:8s} P1={p1}  P2={p2s if p2s else '[]'}")

    print("\n[JSON payload]")
    print(json.dumps(assignments, indent=2))
    print("=" * 70 + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="DXF Floor Plan Pipeline")
    parser.add_argument("--generate", metavar="OUTPUT.dxf",
                        help="Generate a sample office floor plan DXF")
    parser.add_argument("--parse",    metavar="INPUT.dxf",
                        help="Parse a DXF file and export walkable grid")
    parser.add_argument("--out",      metavar="OUTPUT.json", default="grid.json",
                        help="Output path for grid JSON (default: grid.json)")
    parser.add_argument("--demo",     metavar="INPUT.dxf",
                        help="Run full demo: parse DXF + compute pathfinding matrix")
    parser.add_argument("--map-demo", action="store_true",
                        help="Run arbitrary map demo with walls/doors + A* assignment")
    parser.add_argument("--layers",   metavar="LAYER1,LAYER2",
                        help="Comma-separated wall layer names to extract")
    parser.add_argument("--scale",    type=float, default=1.0,
                        help="metres per DXF unit (e.g. 0.001 for mm files)")
    parser.add_argument("--resolution", type=float, default=0.2,
                        help="Grid resolution in metres (default 0.2)")
    args = parser.parse_args()

    wall_layers = args.layers.split(",") if args.layers else None
    transform   = CoordTransform(scale=args.scale)

    if args.generate:
        generate_sample_dxf(args.generate)

    if args.parse:
        fp = parse_dxf(args.parse, transform, wall_layers, args.resolution)
        export_grid_json(fp, args.out)

    if args.demo:
        _run_demo(args.demo)

    if args.map_demo:
        _run_map_demo()

    if not any([args.generate, args.parse, args.demo, args.map_demo]):
        print("Running arbitrary map demo (walls + doors + A* assignment)…")
        _run_map_demo()
