/**
 * Backend adapter: REAL (WebSocket) with automatic fallback to MOCK when
 * backend is unreachable. All topic/path/field assumptions live here and in backendConfig.
 */

import { REST_BASE_URL, WS_BASE_URL, TOPICS, EVENTS } from "./backendConfig.js";

const MAX_TICK_HZ = 10;
const TICK_MS = 1000 / MAX_TICK_HZ;

let mode = "mock"; // "mock" | "connecting" | "live" | "offline"
let ws = null;
const topicHandlers = new Map(); // topicKey -> Set(handler)
let statusCallback = null;

// TODO(BACKEND-CONTRACT): REPLACE_ME — message envelope / field names may differ
function safeAgent(msg) {
  if (msg == null || typeof msg !== "object") return null;
  const id = msg.id ?? msg.agentId;
  const x = typeof msg.x === "number" ? msg.x : msg.position?.x;
  const y = typeof msg.y === "number" ? msg.y : msg.position?.y;
  if (id == null || x == null || y == null) {
    console.warn("[backendClient] unexpected agent shape", msg);
    return null;
  }
  // TODO(BACKEND-CONTRACT): confirm timestamp field name + units (ms vs s)
  const ts = msg.ts ?? msg.timestamp ?? msg.last_seen ?? msg.lastSeenAt;
  const timestamp = ts != null && (typeof ts === "number" || !isNaN(Number(ts)))
    ? (ts > 1e12 ? Number(ts) : Number(ts) * 1000) // assume s if < ~year 2001 in ms
    : undefined;
  // TODO(BACKEND-CONTRACT): mode/currentTargetId field names for live mode
  const mode = msg.mode ?? msg.state ?? "idle";
  const currentTargetId = msg.currentTargetId ?? msg.current_target_id ?? msg.targetId ?? null;
  return { id: String(id), x: Number(x), y: Number(y), label: msg.label ?? `A${id}`, timestamp, mode, currentTargetId };
}

// TODO(BACKEND-CONTRACT): REPLACE_ME
function safeTarget(msg) {
  if (msg == null || typeof msg !== "object") return null;
  const id = msg.id ?? msg.targetId;
  const x = typeof msg.x === "number" ? msg.x : msg.position?.x;
  const y = typeof msg.y === "number" ? msg.y : msg.position?.y;
  if (id == null || x == null || y == null) {
    console.warn("[backendClient] unexpected target shape", msg);
    return null;
  }
  // TODO(BACKEND-CONTRACT): confirm timestamp field name + units (ms vs s)
  const ts = msg.ts ?? msg.timestamp ?? msg.last_seen ?? msg.lastSeenAt;
  const timestamp = ts != null && (typeof ts === "number" || !isNaN(Number(ts)))
    ? (ts > 1e12 ? Number(ts) : Number(ts) * 1000)
    : undefined;
  // TODO(BACKEND-CONTRACT): confirm type/confidence field names
  const type = msg.type ?? msg.targetType ?? msg.class ?? "target";
  const confidence = typeof msg.confidence === "number" ? msg.confidence : undefined;
  // TODO(BACKEND-CONTRACT): status/assignedAgentId field names for live mode
  const status = msg.status ?? msg.task_status ?? "unassigned";
  const assignedAgentId = msg.assignedAgentId ?? msg.assigned_agent_id ?? null;
  return { id: String(id), x: Number(x), y: Number(y), label: msg.label ?? `T${id}`, timestamp, type, confidence, status, assignedAgentId };
}

// TODO(BACKEND-CONTRACT): REPLACE_ME
function safeAssignment(msg) {
  if (msg == null || typeof msg !== "object") return null;
  const agentId = msg.agentId ?? msg.agent_id;
  const targetId = msg.targetId ?? msg.target_id;
  const priority = msg.priority ?? msg.priorityLevel ?? 1;
  if (agentId == null || targetId == null) {
    console.warn("[backendClient] unexpected assignment shape", msg);
    return null;
  }
  return {
    agentId: String(agentId),
    targetId: String(targetId),
    priority: Number(priority),
    distance: typeof msg.distance === "number" ? msg.distance : undefined,
  };
}

function emit(topicKey, data) {
  const handlers = topicHandlers.get(topicKey);
  if (handlers) handlers.forEach((h) => { try { h(data); } catch (e) { console.warn("[backendClient] handler error", e); } });
}

// —— MOCK: generate agents, targets, assignments at <=10Hz ——
let mockTickId = null;
let mockDemoRunning = false;
let mockTargetsMove = false;
const MOCK_BOUNDS = { w: 800, h: 520 };
const AGENT_COLORS = ["#00ffff", "#ff00ff", "#ffff00", "#bf5fff"];
let mockAgents = [];
let mockTargets = [];
let mockAssignments = [];
let mockTime = 0;

// Mission / rescue loop (mock only)
const ARRIVAL_RADIUS = 16;
let missionAutoRun = false;
let missionSpeed = 12;
const MISSION_SPEED_MIN = 4;
const MISSION_SPEED_MAX = 40;

// Simulate LOS dropouts: periodically occlude random targets so last-seen increases
let simulateLOSDropouts = false;
let losDropoutIntervalId = null;
const LOS_DROPOUT_INTERVAL_MS = 4000;

export function setSimulateLOSDropouts(enabled) {
  simulateLOSDropouts = Boolean(enabled);
  if (losDropoutIntervalId) {
    clearInterval(losDropoutIntervalId);
    losDropoutIntervalId = null;
  }
  if (simulateLOSDropouts) {
    losDropoutIntervalId = setInterval(() => {
      const active = mockTargets.filter((t) => t.status !== "rescued");
      if (active.length > 0) {
        const t = active[Math.floor(Math.random() * active.length)];
        occludedTargets.set(t.id, Date.now() + 3000);
      }
    }, LOS_DROPOUT_INTERVAL_MS);
  }
}

// Vision model (mock only)
let VISION_RADIUS = 180;
const occludedTargets = new Map(); // id -> expiryMs
const targetLastSeenAtMs = new Map(); // id -> ms

export function setDemoRunning(running) {
  mockDemoRunning = Boolean(running);
  if (mockDemoRunning && mode === "mock" && !mockTickId && !mockFrozen) {
    mockTickId = setInterval(tickMock, TICK_MS);
  }
  if (!mockDemoRunning && mockTickId) {
    clearInterval(mockTickId);
    mockTickId = null;
  }
}

let mockFrozen = false;
export function setFrozen(frozen) {
  mockFrozen = Boolean(frozen);
  if (mockFrozen && mockTickId) {
    clearInterval(mockTickId);
    mockTickId = null;
  } else if (!mockFrozen && mockDemoRunning && mode === "mock") {
    if (!mockTickId) mockTickId = setInterval(tickMock, TICK_MS);
  }
}

function initMockState() {
  mockAgents = [
    { id: "a1", x: 120, y: 200, label: "A1", hue: 0, mode: "idle", currentTargetId: null },
    { id: "a2", x: 400, y: 260, label: "A2", hue: 1, mode: "idle", currentTargetId: null },
    { id: "a3", x: 680, y: 180, label: "A3", hue: 2, mode: "idle", currentTargetId: null },
  ];
  mockTargets = [
    { id: "t1", x: 300, y: 150, label: "T1", type: "victim", status: "unassigned", assignedAgentId: null },
    { id: "t2", x: 500, y: 380, label: "T2", type: "hazard", status: "unassigned", assignedAgentId: null },
    { id: "t3", x: 200, y: 400, label: "T3", type: "target", status: "unassigned", assignedAgentId: null },
  ];
  mockAssignments = [];
  mockTime = 0;
}

export function setMissionAutoRun(run) {
  missionAutoRun = Boolean(run);
}

export function setMissionSpeed(speed) {
  missionSpeed = Math.max(MISSION_SPEED_MIN, Math.min(MISSION_SPEED_MAX, Number(speed) || 12));
}

export function getMissionSpeed() {
  return missionSpeed;
}

export function resetMission() {
  mockAgents = mockAgents.map((a) => ({ ...a, mode: "idle", currentTargetId: null }));
  mockTargets = mockTargets.map((t) => ({ ...t, status: "unassigned", assignedAgentId: null }));
  mockAssignments = computeMockAssignments();
  emit(TOPICS.agents, mockAgents);
  emit(TOPICS.tracks, enrichTargetsWithVisibility());
  emit(TOPICS.assignments, mockAssignments);
}

function runMissionStep() {
  const speed = missionSpeed;
  const arrived = new Set();

  // 1) Assign idle agents to nearest non-rescued, unassigned target
  mockAgents = mockAgents.map((a) => {
    if (a.mode === "enroute" && a.currentTargetId) return a;
    const available = mockTargets.filter((t) => t.status !== "rescued" && t.assignedAgentId == null);
    if (available.length === 0) return a;
    const withDist = available.map((t) => ({ target: t, d: Math.hypot(t.x - a.x, t.y - a.y) }));
    withDist.sort((x, y) => x.d - y.d);
    const pick = withDist[0].target;
    return { ...a, mode: "enroute", currentTargetId: pick.id };
  });

  // 2) Update targets: mark assigned
  const assignedByAgent = new Map(mockAgents.filter((a) => a.currentTargetId).map((a) => [a.currentTargetId, a.id]));
  mockTargets = mockTargets.map((t) => {
    const aid = assignedByAgent.get(t.id);
    if (aid && t.status !== "rescued") {
      return { ...t, status: "assigned", assignedAgentId: aid };
    }
    return t;
  });

  // 3) Move agents toward target; check arrival
  mockAgents = mockAgents.map((a) => {
    if (a.mode !== "enroute" || !a.currentTargetId) return a;
    const target = mockTargets.find((t) => t.id === a.currentTargetId);
    if (!target || target.status === "rescued") {
      return { ...a, mode: "idle", currentTargetId: null };
    }
    const ax = Number(a.x) || 0, ay = Number(a.y) || 0;
    const tx = Number(target.x) || 0, ty = Number(target.y) || 0;
    const dx = tx - ax, dy = ty - ay;
    const d = Math.hypot(dx, dy);
    if (d <= ARRIVAL_RADIUS || !Number.isFinite(d)) {
      arrived.add(a.currentTargetId);
      return { ...a, x: tx, y: ty, mode: "idle", currentTargetId: null };
    }
    const step = Math.min(speed, Math.max(0, d - ARRIVAL_RADIUS));
    const nx = ax + (dx / d) * step;
    const ny = ay + (dy / d) * step;
    const cx = Math.max(20, Math.min(MOCK_BOUNDS.w - 20, nx));
    const cy = Math.max(20, Math.min(MOCK_BOUNDS.h - 20, ny));
    return { ...a, x: cx, y: cy };
  });

  // 4) Mark arrived targets as rescued
  mockTargets = mockTargets.map((t) =>
    arrived.has(t.id) ? { ...t, status: "rescued", assignedAgentId: null } : t
  );

  // 5) Immediately assign next for idle agents (one more pass)
  mockAgents = mockAgents.map((a) => {
    if (a.mode === "enroute" || a.currentTargetId) return a;
    const available = mockTargets.filter((t) => t.status !== "rescued" && t.assignedAgentId == null);
    if (available.length === 0) return a;
    const withDist = available.map((t) => ({ target: t, d: Math.hypot(t.x - a.x, t.y - a.y) }));
    withDist.sort((x, y) => x.d - y.d);
    const pick = withDist[0].target;
    return { ...a, mode: "enroute", currentTargetId: pick.id };
  });
  const assigned2 = new Map(mockAgents.filter((a) => a.currentTargetId).map((a) => [a.currentTargetId, a.id]));
  mockTargets = mockTargets.map((t) => {
    const aid = assigned2.get(t.id);
    if (aid && t.status !== "rescued") return { ...t, status: "assigned", assignedAgentId: aid };
    return t;
  });

  mockAssignments = computeMockAssignments();
  emit(TOPICS.agents, mockAgents);
  emit(TOPICS.tracks, enrichTargetsWithVisibility());
  emit(TOPICS.assignments, mockAssignments);
}

export function stepMissionOnce() {
  if (mode === "mock") runMissionStep();
}

function isTargetVisible(target) {
  const now = Date.now();
  if (occludedTargets.has(target.id) && occludedTargets.get(target.id) > now) return false;
  return mockAgents.some((a) => Math.hypot(a.x - target.x, a.y - target.y) <= VISION_RADIUS);
}

function enrichTargetsWithVisibility() {
  const now = Date.now();
  occludedTargets.forEach((expiry, id) => {
    if (expiry <= now) occludedTargets.delete(id);
  });
  return mockTargets.map((t) => {
    const visibleNow = isTargetVisible(t);
    if (visibleNow) targetLastSeenAtMs.set(t.id, now);
    const lastSeen = targetLastSeenAtMs.get(t.id) ?? (visibleNow ? now : 0);
    return { ...t, visibleNow, lastSeenAtMs: lastSeen, secondsSinceSeen: (now - lastSeen) / 1000 };
  });
}

export function getVisionRadius() {
  return VISION_RADIUS;
}

export function setVisionRadius(r) {
  VISION_RADIUS = Math.max(50, Math.min(400, r));
}

export function occludeRandomTarget(seconds = 5) {
  if (mockTargets.length === 0) return;
  const t = mockTargets[Math.floor(Math.random() * mockTargets.length)];
  occludedTargets.set(t.id, Date.now() + seconds * 1000);
}

export function occludeTargetById(id, seconds = 5) {
  if (!id) return;
  occludedTargets.set(String(id), Date.now() + seconds * 1000);
}

export function setMockTargetsMove(move) {
  mockTargetsMove = Boolean(move);
}

export function getMockTargetsMove() {
  return mockTargetsMove;
}

function computeMockAssignments() {
  const out = [];
  const activeTargets = mockTargets.filter((t) => t.status !== "rescued");
  mockAgents.forEach((agent) => {
    const ax = Number(agent.x);
    const ay = Number(agent.y);
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return;
    const withDist = activeTargets.map((t) => {
      const tx = Number(t.x);
      const ty = Number(t.y);
      const d = Number.isFinite(tx) && Number.isFinite(ty) ? Math.hypot(tx - ax, ty - ay) : Infinity;
      return { targetId: t.id, distance: d };
    });
    withDist.sort((a, b) => a.distance - b.distance);
    const filtered = withDist.filter((w) => w.distance < Infinity);
    if (filtered[0]) out.push({ agentId: agent.id, targetId: filtered[0].targetId, priority: 1, distance: filtered[0].distance });
    if (filtered[1]) out.push({ agentId: agent.id, targetId: filtered[1].targetId, priority: 2, distance: filtered[1].distance });
  });
  return out;
}

function tickMock() {
  if (missionAutoRun) {
    runMissionStep();
    return;
  }
  mockTime += TICK_MS / 1000;
  mockAgents = mockAgents.map((a, i) => {
    const dx = Math.sin(mockTime + i) * 12;
    const dy = Math.cos(mockTime * 0.7 + i) * 10;
    let x = a.x + dx;
    let y = a.y + dy;
    x = Math.max(20, Math.min(MOCK_BOUNDS.w - 20, x));
    y = Math.max(20, Math.min(MOCK_BOUNDS.h - 20, y));
    return { ...a, x, y };
  });
  if (mockTargetsMove) {
    mockTargets = mockTargets.map((t, i) => {
      const dx = Math.sin(mockTime * 0.5 + i + 10) * 8;
      const dy = Math.cos(mockTime * 0.4 + i + 5) * 6;
      let x = t.x + dx;
      let y = t.y + dy;
      x = Math.max(20, Math.min(MOCK_BOUNDS.w - 20, x));
      y = Math.max(20, Math.min(MOCK_BOUNDS.h - 20, y));
      return { ...t, x, y };
    });
  }
  mockAssignments = computeMockAssignments();
  emit(TOPICS.agents, mockAgents);
  emit(TOPICS.tracks, enrichTargetsWithVisibility());
  emit(TOPICS.assignments, mockAssignments);
}

function startMock() {
  initMockState();
  occludedTargets.clear();
  targetLastSeenAtMs.clear();
  setSimulateLOSDropouts(false);
  if (mockTickId != null) clearInterval(mockTickId);
  mockTickId = null;
  if (mockDemoRunning) mockTickId = setInterval(tickMock, TICK_MS);
  mode = "mock";
  if (statusCallback) statusCallback("mock");
  emit(TOPICS.agents, mockAgents);
  emit(TOPICS.tracks, enrichTargetsWithVisibility());
  emit(TOPICS.assignments, mockAssignments);
}

function stopMock() {
  if (mockTickId != null) {
    clearInterval(mockTickId);
    mockTickId = null;
  }
}

// —— REAL: WebSocket ——
function tryReal() {
  const base = (WS_BASE_URL || "").trim();
  if (!base) {
    startMock();
    return;
  }
  mode = "connecting";
  if (statusCallback) statusCallback("connecting");
  try {
    // TODO(BACKEND-CONTRACT): REPLACE_ME — WS path/subprotocol may differ
    const url = base.startsWith("ws") ? base : `ws://${base}`;
    ws = new WebSocket(url);
    ws.onopen = () => {
      mode = "live";
      if (statusCallback) statusCallback("live");
      stopMock();
    };
    ws.onclose = () => {
      ws = null;
      mode = "offline";
      if (statusCallback) statusCallback("offline");
      startMock();
    };
    ws.onerror = () => {
      if (mode === "connecting") {
        mode = "offline";
        if (statusCallback) statusCallback("offline");
        startMock();
      }
    };
    ws.onmessage = (ev) => {
      try {
        const raw = JSON.parse(ev.data);
        // TODO(BACKEND-CONTRACT): REPLACE_ME — envelope might be { topic, payload } or topic as key
        const topic = raw.topic ?? raw.type ?? raw.channel;
        const payload = raw.payload ?? raw.data ?? raw;
        if (topic === TOPICS.agents) {
          const list = Array.isArray(payload) ? payload : [payload];
          const agents = list.map(safeAgent).filter(Boolean);
          if (agents.length) emit(TOPICS.agents, agents);
        } else if (topic === TOPICS.tracks) {
          const list = Array.isArray(payload) ? payload : [payload];
          const targets = list.map(safeTarget).filter(Boolean);
          if (targets.length) emit(TOPICS.tracks, targets);
        } else if (topic === TOPICS.assignments) {
          const list = Array.isArray(payload) ? payload : [payload];
          const assignments = list.map(safeAssignment).filter(Boolean);
          if (assignments.length) emit(TOPICS.assignments, assignments);
        } else if (topic === TOPICS.observations) {
          emit(TOPICS.observations, payload);
        }
      } catch (e) {
        console.warn("[backendClient] unexpected message shape", ev.data, e);
      }
    };
  } catch (e) {
    console.warn("[backendClient] WS failed", e);
    mode = "offline";
    if (statusCallback) statusCallback("offline");
    startMock();
  }
}

/**
 * Start backend connection. Tries REAL first; on failure or no URL, uses MOCK.
 */
export function start(onStatusChange) {
  statusCallback = onStatusChange ?? null;
  tryReal();
  if (mode === "connecting") {
    const t = setTimeout(() => {
      if (mode === "connecting") {
        mode = "offline";
        if (statusCallback) statusCallback("offline");
        startMock();
      }
    }, 3000);
    if (ws) ws.addEventListener("open", () => clearTimeout(t), { once: true });
  }
}

/**
 * Subscribe to a topic. topicKey must be one of TOPICS (e.g. TOPICS.agents).
 */
export function subscribe(topicKey, handler) {
  if (!topicHandlers.has(topicKey)) topicHandlers.set(topicKey, new Set());
  topicHandlers.get(topicKey).add(handler);
  return () => topicHandlers.get(topicKey)?.delete(handler);
}

/**
 * Send event to backend. eventKey from EVENTS; payload shape is backend-specific.
 * TODO(BACKEND-CONTRACT): REPLACE_ME — payload field names may differ
 */
export function send(eventKey, payload = {}) {
  if (mode === "live" && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ event: eventKey, ...payload }));
    } catch (e) {
      console.warn("[backendClient] send failed", e);
    }
  }
  if (eventKey === EVENTS.demo_start) {
    setDemoRunning(true);
  } else if (eventKey === EVENTS.demo_reset) {
    setDemoRunning(false);
  }
  if (eventKey === EVENTS.pin_create && mode === "mock") {
    const id = payload.id ?? `t${Date.now()}`;
    const x = typeof payload.x === "number" ? payload.x : payload.position?.x ?? 0;
    const y = typeof payload.y === "number" ? payload.y : payload.position?.y ?? 0;
    mockTargets = [...mockTargets, { id: String(id), x, y, label: id, type: "target", status: "unassigned", assignedAgentId: null }];
    emit(TOPICS.tracks, enrichTargetsWithVisibility());
  }
}

export function getStatus() {
  return mode;
}

export function getMockTargets() {
  return mockTargets;
}

export function addMockPin(x, y) {
  const id = `pin_${Date.now()}`;
  mockTargets = [...mockTargets, { id, x, y, label: id, type: "target", status: "unassigned", assignedAgentId: null }];
  emit(TOPICS.tracks, enrichTargetsWithVisibility());
  send(EVENTS.pin_create, { id, x, y });
}

/** Add one target at random position in bounds. Works with or without tick running. */
export function spawnMockTarget() {
  const id = `t${Date.now()}`;
  const x = 80 + Math.random() * (MOCK_BOUNDS.w - 160);
  const y = 60 + Math.random() * (MOCK_BOUNDS.h - 120);
  mockTargets = [...mockTargets, { id, x, y, label: id, type: "target", status: "unassigned", assignedAgentId: null }];
  mockAssignments = computeMockAssignments();
  emit(TOPICS.tracks, enrichTargetsWithVisibility());
  emit(TOPICS.assignments, mockAssignments);
}

/** Remove one target by id, or most recently added if no id. Works with or without tick. */
export function neutraliseMockTarget(targetId) {
  if (mockTargets.length === 0) return;
  if (targetId != null) {
    mockTargets = mockTargets.filter((t) => t.id !== String(targetId));
  } else {
    mockTargets = mockTargets.slice(0, -1);
  }
  mockAssignments = computeMockAssignments();
  emit(TOPICS.tracks, enrichTargetsWithVisibility());
  emit(TOPICS.assignments, mockAssignments);
}

/** Randomize all target positions in bounds. Often moves outside VISION_RADIUS so staleness appears. */
export function scatterMockTargets() {
  mockTargets = mockTargets.map((t) => {
    const x = 80 + Math.random() * (MOCK_BOUNDS.w - 160);
    const y = 60 + Math.random() * (MOCK_BOUNDS.h - 120);
    return { ...t, x, y };
  });
  mockAssignments = computeMockAssignments();
  emit(TOPICS.tracks, enrichTargetsWithVisibility());
  emit(TOPICS.assignments, mockAssignments);
}
