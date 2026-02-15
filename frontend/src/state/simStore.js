/**
 * Simulation store: clock + rescue demo + world state.
 * Feeds Minimap and Camera View. Uses fixtures; structured for backend swap.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { loadFixture, ingestRaw } from "../sim/worldAdapter.js";
import { createSimClock } from "../sim/simClock.js";
import {
  createDemoState,
  runRescueStep,
  appendTrail,
} from "../sim/rescueDemo.js";

// TODO(BACKEND-CONTRACT): Swap fixture path for live stream; use worldAdapter.initWorldAdapter + backendClientStub
const FIXTURE_PATH = "/fixtures/world_state_demo.json";
const MISSION_SPEED = 12;
const TICK_MS = 100;

export function useSimStore() {
  const [worldState, setWorldState] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [simTimeMs, setSimTimeMs] = useState(0);
  const [lastUpdateMs, setLastUpdateMs] = useState(null);
  const [speedIndex, setSpeedIndex] = useState(1); // 1x
  const [selectedResponderId, setSelectedResponderId] = useState(null);
  const [cameraViewShowAll, setCameraViewShowAll] = useState(false);
  const [mapOffset, setMapOffset] = useState({ x: 0, y: 0 });
  const demoStateRef = useRef(null);
  const clockRef = useRef(null);
  const initializedRef = useRef(false);

  function toOutputState(demo) {
    if (!demo) return null;
    const now = Date.now();
    const responders = demo.responders.map((r) => {
      const lastSeen = r.lastSeenAtMs ?? now;
      const ageMs = now - lastSeen;
      return { ...r, lastSeenAtMs: lastSeen, ageMs, lastSeenSeconds: ageMs / 1000 };
    });
    const targets = demo.targets.map((t) => {
      const lastSeen = t.lastSeenAtMs ?? now;
      const ageMs = now - lastSeen;
      return { ...t, lastSeenAtMs: lastSeen, ageMs, secondsSinceSeen: ageMs / 1000 };
    });
    return { responders, targets, assignments: demo.assignments, hazards: demo.hazards ?? [], timestamp: demo.timestamp ?? now };
  }

  const onTick = useCallback(() => {
    const demo = demoStateRef.current;
    if (!demo) return;
    const t = (demo.timestamp ?? 0) + TICK_MS;
    demo.timestamp = t;
    runRescueStep(demo, MISSION_SPEED);
    demo.responders.forEach((r) => appendTrail(r, t));
    demo.targets.forEach((tgt) => appendTrail(tgt, t));
    setWorldState(toOutputState(demo));
    setSimTimeMs(t);
    setLastUpdateMs(Date.now());
  }, []);

  // Create clock first so it exists before we try to play
  useEffect(() => {
    if (!clockRef.current) {
      clockRef.current = createSimClock({ onTick, tickMs: TICK_MS });
    }
    const clock = clockRef.current;
    return () => clock.destroy();
  }, [onTick]);

  // Load fixture and init demo state
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    loadFixture(FIXTURE_PATH)
      .then((ws) => {
        const seed = ingestRaw(ws);
        demoStateRef.current = createDemoState(seed);
        setWorldState(toOutputState(demoStateRef.current));
        // Auto-start demo so it's obvious on load
        clockRef.current?.play();
        setIsPlaying(true);
      })
      .catch(() => {
        demoStateRef.current = createDemoState({ responders: [], targets: [] });
        setWorldState(toOutputState(demoStateRef.current));
      });
  }, []);

  const play = useCallback(() => {
    clockRef.current?.play();
    setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    clockRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const togglePlayPause = useCallback(() => {
    const playing = clockRef.current?.togglePlayPause() ?? false;
    setIsPlaying(playing);
    return playing;
  }, []);

  const step = useCallback(() => {
    clockRef.current?.step();
    // onTick will update simTimeMs and lastUpdateMs
  }, []);

  const setSpeed = useCallback((idx) => {
    const i = Math.max(0, Math.min(3, idx));
    setSpeedIndex(i);
    clockRef.current?.setSpeed(i);
  }, []);

  const reset = useCallback(() => {
    loadFixture(FIXTURE_PATH)
      .then((ws) => {
        const seed = ingestRaw(ws);
        demoStateRef.current = createDemoState(seed);
        setWorldState(toOutputState(demoStateRef.current));
      })
      .catch(() => {
        demoStateRef.current = createDemoState(
          demoStateRef.current
            ? { responders: demoStateRef.current.responders.map((r) => ({ ...r, mode: "idle", currentTargetId: null, trail: [] })), targets: demoStateRef.current.targets.map((t) => ({ ...t, status: "unassigned", assignedAgentId: null, trail: [] })) }
            : {}
        );
        setWorldState(toOutputState(demoStateRef.current));
      });
    clockRef.current?.reset();
    setIsPlaying(false);
    setSimTimeMs(0);
    setLastUpdateMs(Date.now());
  }, []);

  const selectResponder = useCallback((id) => {
    setSelectedResponderId(id);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedResponderId(null);
  }, []);

  const focusEntity = useCallback((entity) => {
    if (entity?.x == null || entity?.y == null) return;
    const cx = 400;
    const cy = 260;
    setMapOffset({ x: cx - entity.x, y: cy - entity.y });
  }, []);

  const clearMapOffset = useCallback(() => {
    setMapOffset({ x: 0, y: 0 });
  }, []);

  return {
    worldState,
    isPlaying,
    simTimeMs,
    lastUpdateMs,
    speedIndex,
    speedOptions: [0.5, 1, 2, 4],
    selectedResponderId,
    cameraViewShowAll,
    setCameraViewShowAll,
    play,
    pause,
    togglePlayPause,
    step,
    setSpeed,
    reset,
    selectResponder,
    clearSelection,
    mapOffset,
    focusEntity,
    clearMapOffset,
  };
}
