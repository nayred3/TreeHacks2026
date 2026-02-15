"""
Assignment & Coordination Engine — Data Models
===============================================

Owns: Position, Agent, Target, Assignment dataclasses.
"""

import math
import time
from dataclasses import dataclass, field
from typing import Optional


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
