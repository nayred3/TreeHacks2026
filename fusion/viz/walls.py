"""
Walls as line segments in world coordinates.
Used for line-of-sight: a camera cannot see a point if the segment intersects a wall.
"""

from typing import List, Tuple

# Each wall is [[x1, y1], [x2, y2]] in meters. Room: x in [0, 12], y in [0, 10].
# These walls create corners and corridors so some cameras can't see all points.
WALLS: List[List[List[float]]] = [
    # Vertical wall left of center (blocks cam_1 from seeing far right)
    [[4.0, 2.0], [4.0, 6.0]],
    # Horizontal wall (blocks cam_3 from seeing bottom area)
    [[2.0, 5.0], [7.0, 5.0]],
    # Short vertical segment (creates a gap)
    [[6.0, 6.5], [6.0, 8.0]],
    # Another barrier
    [[7.5, 0.5], [7.5, 4.0]],
]


def _cross(o: Tuple[float, float], a: Tuple[float, float], b: Tuple[float, float]) -> float:
    """2D cross product of (a-o) and (b-o)."""
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def segment_intersect(
    a: Tuple[float, float],
    b: Tuple[float, float],
    c: Tuple[float, float],
    d: Tuple[float, float],
) -> bool:
    """
    True if segment ab intersects segment cd (excluding endpoints that touch only).
    Uses cross-product test: segments intersect iff they straddle each other.
    """
    def straddle(p, q, r, s):
        return _cross(p, q, r) * _cross(p, q, s) < 0

    if straddle(a, b, c, d) and straddle(c, d, a, b):
        return True
    return False


def has_los(
    origin: Tuple[float, float],
    target: Tuple[float, float],
    walls: List[List[List[float]]],
) -> bool:
    """True if the line from origin to target does not cross any wall."""
    o = (float(origin[0]), float(origin[1]))
    t = (float(target[0]), float(target[1]))
    for wall in walls:
        c = (wall[0][0], wall[0][1])
        d = (wall[1][0], wall[1][1])
        if segment_intersect(o, t, c, d):
            return False
    return True
