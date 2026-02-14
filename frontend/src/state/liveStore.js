import { useState, useEffect, useRef, useMemo } from "react";
import * as backendClient from "../api/backendClient.js";
import { TOPICS, EVENTS } from "../api/backendConfig.js";

// —— Temporal layer config ——
const TRAIL_MAX_POINTS = 25;
const TRAIL_MIN_DT_MS = 100;
const TRAIL_MIN_DIST_PX = 4;
const TTL_MS = 20000;
const FADE_START_MS = 3000;  // >3s start fading
const FADE_END_MS = 10000;   // >10s very dim
const STALE_BADGE_MS = 8000; // show STALE badge after this

function dist(a, b) {
  return Math.hypot((b.x ?? 0) - (a.x ?? 0), (b.y ?? 0) - (a.y ?? 0));
}

function ensureEntity(map, id, now) {
  let ent = map.get(id);
  if (!ent) {
    ent = { history: [], lastSeenAtMs: now };
    map.set(id, ent);
  }
  return ent;
}

function appendToHistory(ent, x, y, t) {
  const prev = ent.history[ent.history.length - 1];
  const dt = prev ? t - prev.t : TRAIL_MIN_DT_MS;
  const d = prev ? dist(prev, { x, y }) : TRAIL_MIN_DIST_PX;
  if (!prev || dt >= TRAIL_MIN_DT_MS || d >= TRAIL_MIN_DIST_PX) {
    ent.history.push({ x, y, t });
    if (ent.history.length > TRAIL_MAX_POINTS) ent.history.shift();
  }
}

/**
 * Unified live store: connectStatus, agents/targets/assignments/observations,
 * demo controls. Stays backwards compatible with DemoControlPanel:
 * store has { isRunning, debug, startDemo, resetDemo, toggle }.
 */
export function useLiveStore() {
  const [connectStatus, setConnectStatus] = useState("mock");
  const [agents, setAgents] = useState([]);
  const [targets, setTargets] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [observations, setObservations] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [resetNonce, setResetNonce] = useState(0);
  const [isFrozen, setIsFrozen] = useState(false);
  const [zonesEnabled, setZonesEnabled] = useState(false);
  const [debug, setDebug] = useState({
    showLabels: true,
    showAssignments: true,
    showDetections: false,
    showTrails: true,
    showLastSeenTimers: true,
  });
  const [tick, setTick] = useState(0);
  const [selectedEntity, setSelectedEntity] = useState(null); // { type: 'agent'|'target', id }
  const [mapOffset, setMapOffset] = useState({ x: 0, y: 0 }); // for Focus
  const [mockTargetsMove, setMockTargetsMoveState] = useState(false);
  const [missionAutoRun, setMissionAutoRunState] = useState(false);
  const [missionSpeed, setMissionSpeedState] = useState(12);
  const startedRef = useRef(false);
  const agentEntityMapRef = useRef(new Map());
  const targetEntityMapRef = useRef(new Map());
  const frozenAtMsRef = useRef(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    backendClient.start((status) => setConnectStatus(status ?? backendClient.getStatus()));
  }, []);

  // Freeze clock: when frozen, age stops increasing
  useEffect(() => {
    if (isFrozen) frozenAtMsRef.current = Date.now();
  }, [isFrozen]);

  // 10Hz tick for age updates when not frozen
  useEffect(() => {
    if (isFrozen) return;
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [isFrozen]);

  useEffect(() => {
    const unsubA = backendClient.subscribe(TOPICS.agents, (data) => {
      setAgents(Array.isArray(data) ? data : [data].filter(Boolean));
    });
    const unsubT = backendClient.subscribe(TOPICS.tracks, (data) => {
      setTargets(Array.isArray(data) ? data : [data].filter(Boolean));
    });
    const unsubAsn = backendClient.subscribe(TOPICS.assignments, (data) => {
      setAssignments(Array.isArray(data) ? data : [data].filter(Boolean));
    });
    const unsubO = backendClient.subscribe(TOPICS.observations, (data) => {
      setObservations(Array.isArray(data) ? data : [data].filter(Boolean));
    });
    return () => {
      unsubA();
      unsubT();
      unsubAsn();
      unsubO();
    };
  }, []);

  const { agentsVM, targetsVM } = useMemo(() => {
    const now = Date.now();
    const effectiveNow = isFrozen && frozenAtMsRef.current != null ? frozenAtMsRef.current : now;
    const agentMap = agentEntityMapRef.current;
    const targetMap = targetEntityMapRef.current;

    agents.forEach((a) => {
      const ent = ensureEntity(agentMap, a.id, now);
      // TODO(BACKEND-CONTRACT): if backend provides timestamp, use it
      const ts = a.timestamp ?? a.lastSeenAtMs ?? now;
      ent.lastSeenAtMs = typeof ts === "number" ? ts : now;
      appendToHistory(ent, a.x, a.y, ent.lastSeenAtMs);
      agentMap.set(a.id, ent);
    });
    targets.forEach((t) => {
      const ent = ensureEntity(targetMap, t.id, now);
      const ts = t.timestamp ?? t.lastSeenAtMs ?? now;
      ent.lastSeenAtMs = typeof ts === "number" ? ts : now;
      appendToHistory(ent, t.x, t.y, ent.lastSeenAtMs);
      targetMap.set(t.id, ent);
    });

    // TTL cleanup: remove stale entities from maps
    const pruneMap = (map, currentIds) => {
      for (const id of map.keys()) {
        const ent = map.get(id);
        const ageMs = effectiveNow - ent.lastSeenAtMs;
        if (!currentIds.has(id) || ageMs > TTL_MS) map.delete(id);
      }
    };
    pruneMap(agentMap, new Set(agents.map((a) => a.id)));
    pruneMap(targetMap, new Set(targets.map((t) => t.id)));

    const buildVM = (list, map) =>
      list
        .map((e) => {
          const ent = map.get(e.id);
          if (!ent) return null;
          const ageMs = effectiveNow - ent.lastSeenAtMs;
          if (ageMs > TTL_MS) return null;
          return {
            ...e,
            lastSeenAtMs: ent.lastSeenAtMs,
          ageMs,
          lastSeenSeconds: ageMs / 1000,
          trail: [...ent.history],
          visibleNow: e.visibleNow,
          secondsSinceSeen: e.secondsSinceSeen ?? ageMs / 1000,
          type: e.type,
          confidence: e.confidence,
          status: e.status,
          assignedAgentId: e.assignedAgentId,
          mode: e.mode,
          currentTargetId: e.currentTargetId,
        };
        })
        .filter(Boolean);

    return {
      agentsVM: buildVM(agents, agentMap),
      targetsVM: buildVM(targets, targetMap),
    };
  }, [agents, targets, tick, isFrozen]);

  function startDemo() {
    setIsRunning(true);
    setIsFrozen(false);
    backendClient.setFrozen(false);
    // TODO(BACKEND-CONTRACT): REPLACE_ME — payload shape may differ
    backendClient.send(EVENTS.demo_start, {});
  }

  function resetDemo() {
    setIsRunning(false);
    setIsFrozen(false);
    backendClient.setFrozen(false);
    agentEntityMapRef.current.clear();
    targetEntityMapRef.current.clear();
    setResetNonce((n) => n + 1);
    // TODO(BACKEND-CONTRACT): REPLACE_ME — payload shape may differ
    backendClient.send(EVENTS.demo_reset, {});
  }

  function toggleFreeze() {
    setIsFrozen((prev) => {
      const next = !prev;
      backendClient.setFrozen(next);
      return next;
    });
  }

  function toggle(key) {
    setDebug((d) => ({ ...d, [key]: !d[key] }));
  }

  function addPin(x, y) {
    // TODO(BACKEND-CONTRACT): REPLACE_ME — payload shape may differ
    backendClient.send(EVENTS.pin_create, { x, y });
  }

  function spawn() {
    if (backendClient.getStatus() === "mock") {
      backendClient.spawnMockTarget();
    } else {
      // TODO(BACKEND-CONTRACT): REPLACE_ME — payload shape may differ
      backendClient.send(EVENTS.spawn_target, {});
    }
  }

  function neutralise() {
    if (backendClient.getStatus() === "mock") {
      const id = selectedEntity?.type === "target" ? selectedEntity.id : undefined;
      backendClient.neutraliseMockTarget(id);
      if (id) setSelectedEntity(null);
    } else {
      // TODO(BACKEND-CONTRACT): REPLACE_ME — payload shape may differ
      backendClient.send(EVENTS.neutralise_target, selectedEntity?.type === "target" ? { targetId: selectedEntity.id } : {});
    }
  }

  function selectEntity(type, id) {
    setSelectedEntity(id ? { type, id } : null);
  }

  function clearSelection() {
    setSelectedEntity(null);
  }

  function focusEntity(entity) {
    if (!entity) return;
    const x = entity.x ?? 0;
    const y = entity.y ?? 0;
    const cx = 400;
    const cy = 260;
    setMapOffset({ x: cx - x, y: cy - y });
  }

  function clearMapOffset() {
    setMapOffset({ x: 0, y: 0 });
  }

  function occludeSelectedTarget(seconds = 5) {
    if (selectedEntity?.type === "target" && backendClient.getStatus() === "mock") {
      backendClient.occludeTargetById(selectedEntity.id, seconds);
    }
  }

  function toggleMockTargetsMove() {
    const next = !mockTargetsMove;
    setMockTargetsMoveState(next);
    backendClient.setMockTargetsMove?.(next);
  }

  function toggleMissionAutoRun() {
    const next = !missionAutoRun;
    setMissionAutoRunState(next);
    backendClient.setMissionAutoRun?.(next);
  }

  function stepMissionOnce() {
    backendClient.stepMissionOnce?.();
  }

  function setMissionSpeed(speed) {
    const v = Math.max(4, Math.min(40, Number(speed) || 12));
    setMissionSpeedState(v);
    backendClient.setMissionSpeed?.(v);
  }

  function resetMission() {
    backendClient.resetMission?.();
  }

  function scatter() {
    if (backendClient.getStatus() === "mock") {
      backendClient.scatterMockTargets();
    } else {
      // TODO(BACKEND-CONTRACT): REPLACE_ME — payload shape may differ
      backendClient.send(EVENTS.scatter_targets, {});
    }
  }

  function toggleZones() {
    setZonesEnabled((prev) => {
      const next = !prev;
      if (backendClient.getStatus() !== "mock") {
        backendClient.send(EVENTS.zones_toggle, { enabled: next });
      }
      return next;
    });
  }

  return {
    connectStatus,
    agents: agentsVM,
    targets: targetsVM,
    assignments,
    selectedEntity,
    mapOffset,
    observations,
    isRunning,
    debug,
    fadeStartMs: FADE_START_MS,
    fadeEndMs: FADE_END_MS,
    resetNonce,
    startDemo,
    resetDemo,
    toggle,
    addPin,
    isFrozen,
    toggleFreeze,
    spawn,
    neutralise,
    scatter,
    zonesEnabled,
    toggleZones,
    selectEntity,
    clearSelection,
    focusEntity,
    clearMapOffset,
    occludeSelectedTarget,
    mockTargetsMove,
    toggleMockTargetsMove,
    missionAutoRun,
    toggleMissionAutoRun,
    stepMissionOnce,
    missionSpeed,
    setMissionSpeed,
    resetMission,
    fadeStartMs: FADE_START_MS,
    fadeEndMs: FADE_END_MS,
    staleBadgeMs: STALE_BADGE_MS,
  };
}
