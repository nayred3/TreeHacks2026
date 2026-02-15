/**
 * Unified live store: deterministic sim clock, canonical state, backend adapter.
 * State: responders[], targets[], assignments[]. Updates via tick(), setPaused(), etc.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as backendClient from "../api/backendClient.js";
import { TOPICS, EVENTS } from "../api/backendConfig.js";
import { adaptResponders, adaptTargets, adaptAssignments } from "../adapters/WorldStateAdapter.js";

const TRAIL_MAX_POINTS = 25;
const TRAIL_MIN_DT_MS = 100;
const TRAIL_MIN_DIST_PX = 4;
const TTL_MS = 20000;
const FADE_START_MS = 3000;
const FADE_END_MS = 10000;
const STALE_BADGE_MS = 8000;
const TICK_INTERVAL_MS = 100;
const MAX_DT_MS = 100;
const SPEEDS = [1, 2];

function dist(a, b) {
  const ax = a?.x ?? 0, ay = a?.y ?? 0;
  const bx = b?.x ?? 0, by = b?.y ?? 0;
  return Math.hypot(bx - ax, by - ay);
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
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const prev = ent.history[ent.history.length - 1];
  const dt = prev ? t - prev.t : TRAIL_MIN_DT_MS;
  const d = prev ? dist(prev, { x, y }) : TRAIL_MIN_DIST_PX;
  if (!prev || dt >= TRAIL_MIN_DT_MS || d >= TRAIL_MIN_DIST_PX) {
    ent.history.push({ x, y, t });
    if (ent.history.length > TRAIL_MAX_POINTS) ent.history.shift();
  }
}

export function useLiveStore() {
  const [connectStatus, setConnectStatus] = useState("mock");
  const [rawAgents, setRawAgents] = useState([]);
  const [rawTargets, setRawTargets] = useState([]);
  const [rawAssignments, setRawAssignments] = useState([]);
  const [observations, setObservations] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [resetNonce, setResetNonce] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [lastTickMs, setLastTickMs] = useState(() => Date.now());
  const [zonesEnabled, setZonesEnabled] = useState(false);
  const [debug, setDebug] = useState({
    showLabels: true,
    showAssignments: true,
    showDetections: false,
    showTrails: true,
    showLastSeenTimers: true,
  });
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [mapOffset, setMapOffset] = useState({ x: 0, y: 0 });
  const [mockTargetsMove, setMockTargetsMoveState] = useState(false);
  const [missionAutoRun, setMissionAutoRunState] = useState(false);
  const [missionSpeed, setMissionSpeedState] = useState(12);
  const [simulateLOSDropouts, setSimulateLOSDropoutsState] = useState(false);
  const [cameraViewShowAll, setCameraViewShowAll] = useState(false);
  const startedRef = useRef(false);
  const agentEntityMapRef = useRef(new Map());
  const targetEntityMapRef = useRef(new Map());
  const lastTickTimeRef = useRef(Date.now());
  const [frozenSimTimeMs, setFrozenSimTimeMs] = useState(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    backendClient.start((status) => setConnectStatus(status ?? backendClient.getStatus()));
  }, []);

  // Deterministic sim clock: when paused, sim time freezes; otherwise advances by dt
  useEffect(() => {
    if (paused) {
      setFrozenSimTimeMs((prev) => prev ?? nowMs);
      return;
    }
    setFrozenSimTimeMs(null);
    const tick = () => {
      const t = Date.now();
      const dt = Math.min(MAX_DT_MS, t - lastTickTimeRef.current);
      lastTickTimeRef.current = t;
      setNowMs(t);
      setLastTickMs(t);
    };
    const interval = setInterval(tick, TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [paused]);

  useEffect(() => {
    const unsubA = backendClient.subscribe(TOPICS.agents, (data) => {
      setRawAgents(Array.isArray(data) ? data : [data].filter(Boolean));
    });
    const unsubT = backendClient.subscribe(TOPICS.tracks, (data) => {
      setRawTargets(Array.isArray(data) ? data : [data].filter(Boolean));
    });
    const unsubAsn = backendClient.subscribe(TOPICS.assignments, (data) => {
      setRawAssignments(Array.isArray(data) ? data : [data].filter(Boolean));
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

  const effectiveNowMs = paused && frozenSimTimeMs != null ? frozenSimTimeMs : nowMs;

  const { agents: agentsVM, targets: targetsVM, assignments: assignmentsVM } = useMemo(() => {
    const agents = adaptResponders(rawAgents);
    const targets = adaptTargets(rawTargets);
    const activeTargetIds = new Set(targets.filter((t) => t.status !== "rescued").map((t) => t.id));
    const assignments = adaptAssignments(rawAssignments, activeTargetIds);

    const agentMap = agentEntityMapRef.current;
    const targetMap = targetEntityMapRef.current;

    agents.forEach((a) => {
      const ent = ensureEntity(agentMap, a.id, effectiveNowMs);
      const ts = a.timestamp ?? effectiveNowMs;
      ent.lastSeenAtMs = typeof ts === "number" && Number.isFinite(ts) ? ts : effectiveNowMs;
      appendToHistory(ent, a.x, a.y, ent.lastSeenAtMs);
      agentMap.set(a.id, ent);
    });
    targets.forEach((t) => {
      const ent = ensureEntity(targetMap, t.id, effectiveNowMs);
      const ts = t.lastSeenAtMs ?? t.timestamp ?? effectiveNowMs;
      ent.lastSeenAtMs = typeof ts === "number" && Number.isFinite(ts) ? ts : effectiveNowMs;
      appendToHistory(ent, t.x, t.y, ent.lastSeenAtMs);
      targetMap.set(t.id, ent);
    });

    const pruneMap = (map, currentIds) => {
      for (const id of map.keys()) {
        const ent = map.get(id);
        const ageMs = effectiveNowMs - ent.lastSeenAtMs;
        if (!currentIds.has(id) || ageMs > TTL_MS) map.delete(id);
      }
    };
    pruneMap(agentMap, new Set(agents.map((a) => a.id)));
    pruneMap(targetMap, new Set(targets.map((t) => t.id)));

    const targetById = new Map(targets.map((t) => [t.id, t]));
    const buildAgentVM = (list, map) =>
      list
        .map((e) => {
          const ent = map.get(e.id);
          if (!ent) return null;
          const ageMs = effectiveNowMs - ent.lastSeenAtMs;
          if (ageMs > TTL_MS) return null;
          // Compute yaw for camera frustum when moving toward target
          let yaw = e.yaw;
          if (yaw == null && e.currentTargetId) {
            const tgt = targetById.get(e.currentTargetId);
            if (tgt && Number.isFinite(tgt.x) && Number.isFinite(tgt.y) && Number.isFinite(e.x) && Number.isFinite(e.y)) {
              yaw = Math.atan2(tgt.y - e.y, tgt.x - e.x);
            }
          }
          if (yaw == null) yaw = 0;
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
            yaw,
            fovDeg: e.fovDeg ?? 60,
          };
        })
        .filter(Boolean);
    const buildTargetVM = (list, map) =>
      list
        .map((e) => {
          const ent = map.get(e.id);
          if (!ent) return null;
          const ageMs = effectiveNowMs - ent.lastSeenAtMs;
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
          };
        })
        .filter(Boolean);

    return {
      agents: buildAgentVM(agents, agentMap),
      targets: buildTargetVM(targets, targetMap),
      assignments,
    };
  }, [rawAgents, rawTargets, rawAssignments, effectiveNowMs, nowMs]);

  const setPausedFn = useCallback((p) => {
    setPaused(p);
    backendClient.setFrozen(p);
  }, []);

  const togglePause = useCallback(() => {
    setPaused((prev) => {
      const next = !prev;
      backendClient.setFrozen(next);
      return next;
    });
  }, []);

  function startDemo() {
    setIsRunning(true);
    setPaused(false);
    backendClient.setFrozen(false);
    backendClient.send(EVENTS.demo_start, {});
  }

  function resetDemo() {
    setIsRunning(false);
    setPaused(false);
    backendClient.setFrozen(false);
    agentEntityMapRef.current.clear();
    targetEntityMapRef.current.clear();
    setResetNonce((n) => n + 1);
    backendClient.send(EVENTS.demo_reset, {});
  }

  function addPin(x, y) {
    backendClient.send(EVENTS.pin_create, { x, y });
  }

  function spawn() {
    if (backendClient.getStatus() === "mock") {
      backendClient.spawnMockTarget();
    } else {
      backendClient.send(EVENTS.spawn_target, {});
    }
  }

  function neutralise() {
    if (backendClient.getStatus() === "mock") {
      const id = selectedEntity?.type === "target" ? selectedEntity.id : undefined;
      backendClient.neutraliseMockTarget(id);
      if (id) setSelectedEntity(null);
    } else {
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

  function setMissionAutoRunEnabled(enabled) {
    if (missionAutoRun !== enabled) {
      setMissionAutoRunState(enabled);
      backendClient.setMissionAutoRun?.(enabled);
    }
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

  function toggleSimulateLOSDropouts() {
    const next = !simulateLOSDropouts;
    setSimulateLOSDropoutsState(next);
    backendClient.setSimulateLOSDropouts?.(next);
  }

  return {
    connectStatus,
    agents: agentsVM,
    targets: targetsVM,
    assignments: assignmentsVM,
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
    toggle: (key) => setDebug((d) => ({ ...d, [key]: !d[key] })),
    addPin,
    isFrozen: paused,
    toggleFreeze: togglePause,
    setPaused: setPausedFn,
    speedIndex,
    speedOptions: SPEEDS,
    setSpeedIndex,
    nowMs,
    lastTickMs,
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
    setMissionAutoRunEnabled,
    stepMissionOnce,
    missionSpeed,
    setMissionSpeed,
    resetMission,
    simulateLOSDropouts,
    toggleSimulateLOSDropouts,
    cameraViewShowAll,
    setCameraViewShowAll,
    fadeStartMs: FADE_START_MS,
    fadeEndMs: FADE_END_MS,
    staleBadgeMs: STALE_BADGE_MS,
  };
}
