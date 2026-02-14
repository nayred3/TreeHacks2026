import { useState, useEffect, useRef } from "react";
import * as backendClient from "../api/backendClient.js";
import { TOPICS, EVENTS } from "../api/backendConfig.js";

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
  });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    backendClient.start((status) => setConnectStatus(status ?? backendClient.getStatus()));
  }, []);

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
      backendClient.neutraliseMockTarget();
    } else {
      // TODO(BACKEND-CONTRACT): REPLACE_ME — payload shape may differ
      backendClient.send(EVENTS.neutralise_target, {});
    }
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
    agents,
    targets,
    assignments,
    observations,
    isRunning,
    debug,
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
  };
}
