import { useEffect } from "react";
import DemoControlPanel from "./components/DemoControlPanel";
import MapCanvasHUD from "./components/MapCanvasHUD";
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
    fadeStartMs,
    fadeEndMs,
    selectedEntity,
    selectEntity,
    mapOffset,
    zonesEnabled,
    focusEntity,
    clearSelection,
    occludeSelectedTarget,
    clearMapOffset,
    staleBadgeMs,
    missionSpeed,
  } = store;

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
        <p className="hud-subtitle">Distance-based priority assignment • Live assignment view</p>
        <div className="hud-action-bar">
          <button type="button" className="hud-action-btn" onClick={toggleFreeze}>
            {isFrozen ? "UNPAUSE" : "PAUSE"}
          </button>
          <button
            type="button"
            className={`hud-action-btn ${store.zonesEnabled ? "hud-action-btn-active" : ""}`}
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
        </div>
      </header>

      <div className="app-body">
        <div className="map-column">
          <div className="map-container">
            <MapCanvasHUD
              agents={agents}
              targets={targets}
              assignments={assignments}
              debug={debug}
              isRunning={isRunning}
              resetNonce={resetNonce}
              onCreatePin={addPin}
              onSelectEntity={selectEntity}
              selectedEntity={selectedEntity}
              mapOffset={mapOffset}
              zonesEnabled={zonesEnabled}
              fadeStartMs={fadeStartMs}
              fadeEndMs={fadeEndMs}
              staleBadgeMs={staleBadgeMs}
              missionSpeed={missionSpeed}
            />
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
