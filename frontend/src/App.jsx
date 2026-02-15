import { useEffect } from "react";
import DemoControlPanel from "./components/DemoControlPanel";
import MinimapSim from "./components/MinimapSim";
import CameraViewMini from "./components/CameraViewMini";
import PriorityPanel from "./components/PriorityPanel";
import { useLiveStore } from "./state/liveStore";
import "./App.css";

export default function App() {
  const store = useLiveStore();
  const {
    isRunning,
    debug,
    resetNonce,
    agents,
    targets,
    assignments,
    addPin,
    toggleFreeze,
    isFrozen,
    spawn,
    neutralise,
    scatter,
    toggleZones,
    selectedEntity,
    selectEntity,
    mapOffset,
    zonesEnabled,
    focusEntity,
    clearSelection,
    occludeSelectedTarget,
    clearMapOffset,
    fadeStartMs,
    fadeEndMs,
    staleBadgeMs,
    missionSpeed,
    cameraViewShowAll,
    setCameraViewShowAll,
  } = store;

  const worldState = { responders: agents, targets, assignments };
  const selectedResponderId = selectedEntity?.type === "agent" ? selectedEntity.id : null;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection]);

  return (
    <div className="app-hud">
      <header className="hud-header">
        <h1 className="hud-title">PRIORITY ASSIGNMENT ENGINE</h1>
        <p className="hud-subtitle">
          Minimap + Camera View • Rescue loop • Last-seen tracking (mock-safe, TODO: swap backend)
        </p>
        <div className="hud-action-bar">
          <button type="button" className="hud-action-btn" onClick={toggleFreeze}>
            {isFrozen ? "UNPAUSE" : "PAUSE"}
          </button>
          <button
            type="button"
            className={`hud-action-btn ${zonesEnabled ? "hud-action-btn-active" : ""}`}
            onClick={toggleZones}
          >
            ZONES
          </button>
          <button type="button" className="hud-action-btn" onClick={spawn}>
            SPAWN
          </button>
          <button type="button" className="hud-action-btn" onClick={neutralise}>
            NEUTRALISE
          </button>
          <button type="button" className="hud-action-btn" onClick={scatter}>
            SCATTER
          </button>
          <button type="button" className="hud-action-btn" onClick={clearMapOffset}>
            CENTER
          </button>
        </div>
      </header>

      <div className="app-body">
        <div className="map-column">
          <div className="map-container sim-map-container">
            <div className="minimap-area" style={{ flex: 1, minHeight: 0 }}>
              <MinimapSim
                worldState={worldState}
                selectedResponderId={selectedResponderId}
                onSelectResponder={(id) => selectEntity("agent", id)}
                onSelectTarget={(id) => selectEntity("target", id)}
                onCreatePin={addPin}
                mapOffset={mapOffset}
              />
            </div>
            <div className="camera-view-area">
              <CameraViewMini
                worldState={worldState}
                selectedResponderId={selectedResponderId}
                showAll={cameraViewShowAll}
              />
              <label className="camera-view-toggle" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: "10px" }}>
                <input
                  type="checkbox"
                  checked={cameraViewShowAll}
                  onChange={(e) => setCameraViewShowAll(e.target.checked)}
                />
                Show all targets (including out of view)
              </label>
            </div>
          </div>
          <div className="sim-legend">
            <div className="legend-title">Legend</div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: "#00ffff" }} />
              Responders (R1, R2, …)
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: "#ff6600" }} />
              Targets (T1 Victim, T2 Hazard, …)
            </div>
            <div className="legend-row">
              <span className="legend-line" style={{ borderColor: "#00ffff" }} />
              P1 assignment (solid)
            </div>
            <div className="legend-row">
              <span className="legend-line dashed" style={{ borderColor: "#ff00ff" }} />
              P2 assignment (dashed)
            </div>
            <div className="legend-row">
              <span className="legend-cone" />
              Camera frustum (selected responder)
            </div>
          </div>
        </div>

        <div className="right-column">
          <PriorityPanel
            agents={agents}
            targets={targets}
            assignments={assignments}
            selectedEntity={selectedEntity}
            onFocus={focusEntity}
            onOccludeTarget={occludeSelectedTarget}
          />
          <DemoControlPanel store={store} backendStatus={store.connectStatus} />
        </div>
      </div>
    </div>
  );
}
