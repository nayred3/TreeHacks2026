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
  return { id: String(id), x: Number(x), y: Number(y), label: msg.label ?? `A${id}` };
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
  return { id: String(id), x: Number(x), y: Number(y), label: msg.label ?? `T${id}` };
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
const MOCK_BOUNDS = { w: 800, h: 520 };
const AGENT_COLORS = ["#00ffff", "#ff00ff", "#ffff00", "#bf5fff"];
let mockAgents = [];
let mockTargets = [];
let mockAssignments = [];
let mockTime = 0;

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
    { id: "a1", x: 120, y: 200, label: "A1", hue: 0 },
    { id: "a2", x: 400, y: 260, label: "A2", hue: 1 },
    { id: "a3", x: 680, y: 180, label: "A3", hue: 2 },
  ];
  mockTargets = [
    { id: "t1", x: 300, y: 150, label: "T1" },
    { id: "t2", x: 500, y: 380, label: "T2" },
    { id: "t3", x: 200, y: 400, label: "T3" },
  ];
  mockAssignments = [];
  mockTime = 0;
}

function computeMockAssignments() {
  const out = [];
  mockAgents.forEach((agent, ai) => {
    const withDist = mockTargets.map((t) => ({
      targetId: t.id,
      distance: Math.hypot(t.x - agent.x, t.y - agent.y),
    }));
    withDist.sort((a, b) => a.distance - b.distance);
    if (withDist[0]) out.push({ agentId: agent.id, targetId: withDist[0].targetId, priority: 1, distance: withDist[0].distance });
    if (withDist[1]) out.push({ agentId: agent.id, targetId: withDist[1].targetId, priority: 2, distance: withDist[1].distance });
  });
  return out;
}

function tickMock() {
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
  mockAssignments = computeMockAssignments();
  emit(TOPICS.agents, mockAgents);
  emit(TOPICS.tracks, mockTargets);
  emit(TOPICS.assignments, mockAssignments);
}

function startMock() {
  initMockState();
  if (mockTickId != null) clearInterval(mockTickId);
  mockTickId = null;
  if (mockDemoRunning) mockTickId = setInterval(tickMock, TICK_MS);
  mode = "mock";
  if (statusCallback) statusCallback("mock");
  emit(TOPICS.agents, mockAgents);
  emit(TOPICS.tracks, mockTargets);
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
    mockTargets = [...mockTargets, { id: String(id), x, y, label: `T${id}` }];
    emit(TOPICS.tracks, mockTargets);
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
  mockTargets = [...mockTargets, { id, x, y, label: id }];
  emit(TOPICS.tracks, mockTargets);
  send(EVENTS.pin_create, { id, x, y });
}

/** Add one target at random position in bounds. Works with or without tick running. */
export function spawnMockTarget() {
  const id = `t${Date.now()}`;
  const x = 80 + Math.random() * (MOCK_BOUNDS.w - 160);
  const y = 60 + Math.random() * (MOCK_BOUNDS.h - 120);
  mockTargets = [...mockTargets, { id, x, y, label: id }];
  mockAssignments = computeMockAssignments();
  emit(TOPICS.tracks, mockTargets);
  emit(TOPICS.assignments, mockAssignments);
}

/** Remove one target (most recently added, or last in list). Works with or without tick. */
export function neutraliseMockTarget() {
  if (mockTargets.length === 0) return;
  mockTargets = mockTargets.slice(0, -1);
  mockAssignments = computeMockAssignments();
  emit(TOPICS.tracks, mockTargets);
  emit(TOPICS.assignments, mockAssignments);
}

/** Randomize all target positions in bounds. Works with or without tick. */
export function scatterMockTargets() {
  mockTargets = mockTargets.map((t) => {
    const x = 80 + Math.random() * (MOCK_BOUNDS.w - 160);
    const y = 60 + Math.random() * (MOCK_BOUNDS.h - 120);
    return { ...t, x, y };
  });
  mockAssignments = computeMockAssignments();
  emit(TOPICS.tracks, mockTargets);
  emit(TOPICS.assignments, mockAssignments);
}
