import * as backendClient from "../api/backendClient.js";

export default function DemoControlPanel({ store, backendStatus = "offline" }) {
    const {
      isRunning,
      debug,
      startDemo,
      resetDemo,
      toggle,
      mockTargetsMove,
      toggleMockTargetsMove,
      missionAutoRun,
      toggleMissionAutoRun,
      stepMissionOnce,
      missionSpeed,
      setMissionSpeed,
      resetMission,
      simulateLOSDropouts,
      toggleSimulateLOSDropouts,
      setMissionAutoRunEnabled,
    } = store;
    const isMock = backendStatus === "mock";
  
    return (
      <div style={panel}>
        <div style={headerRow}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Demo Controls</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Backend: <b>{backendStatus}</b> • Mode:{" "}
              <b>{isRunning ? "LIVE" : "IDLE"}</b>
            </div>
          </div>
        </div>
  
        <div style={section}>
          <button style={primaryBtn} onClick={startDemo} disabled={isRunning}>
            Start demo
          </button>
          <button style={secondaryBtn} onClick={resetDemo}>
            Reset state
          </button>
        </div>
  
        <div style={section}>
          <div style={sectionTitle}>Debug layers</div>
  
          <ToggleRow
            label="Show labels"
            checked={debug.showLabels}
            onClick={() => toggle("showLabels")}
          />
          <ToggleRow
            label="Show assignment lines"
            checked={debug.showAssignments}
            onClick={() => toggle("showAssignments")}
          />
          <ToggleRow
            label="Show raw detections"
            checked={debug.showDetections}
            onClick={() => toggle("showDetections")}
          />
          <ToggleRow
            label="Show trails"
            checked={debug.showTrails}
            onClick={() => toggle("showTrails")}
          />
          <ToggleRow
            label="Show last-seen timers"
            checked={debug.showLastSeenTimers}
            onClick={() => toggle("showLastSeenTimers")}
          />
        </div>

        {isMock && (
          <div style={section}>
            <div style={sectionTitle}>Mock controls</div>
            <button style={secondaryBtn} onClick={() => backendClient.occludeRandomTarget(5)}>
              Occlude random target (5s)
            </button>
            <ToggleRow
              label="Simulate LOS dropouts"
              checked={simulateLOSDropouts ?? false}
              onClick={toggleSimulateLOSDropouts}
            />
            <ToggleRow
              label="Move targets"
              checked={mockTargetsMove ?? false}
              onClick={toggleMockTargetsMove}
            />
          </div>
        )}

        {isMock && (
          <div style={section}>
            <div style={sectionTitle}>Rescue mission</div>
            <ToggleRow
              label="Run mission (auto)"
              checked={missionAutoRun ?? false}
              onClick={toggleMissionAutoRun}
            />
            <button style={secondaryBtn} onClick={stepMissionOnce}>
              Step once
            </button>
            <div style={row}>
              <span>Speed</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button style={smallBtn} onClick={() => setMissionSpeed((missionSpeed ?? 12) - 4)}>-</button>
                <span style={{ minWidth: 28, fontVariantNumeric: "tabular-nums" }}>{missionSpeed ?? 12}</span>
                <button style={smallBtn} onClick={() => setMissionSpeed((missionSpeed ?? 12) + 4)}>+</button>
              </div>
            </div>
            <button style={secondaryBtn} onClick={resetMission}>
              Reset mission
            </button>
            <button style={primaryBtn} onClick={runDemoScript} disabled={isRunning}>
              Demo Script (30s)
            </button>
          </div>
        )}
      </div>
    );
  }

  function runDemoScript() {
    if (isRunning) return;
    resetDemo();
    setTimeout(() => {
      startDemo();
      setMissionAutoRunEnabled?.(true);
    }, 100);
    setTimeout(() => {
      toggleSimulateLOSDropouts?.();
    }, 6000);
    setTimeout(() => {
      toggleSimulateLOSDropouts?.();
    }, 18000);
    setTimeout(() => {
      resetDemo();
    }, 30000);
  }
  
  function ToggleRow({ label, checked, onClick }) {
    return (
      <div style={row}>
        <span>{label}</span>
        <button style={toggleBtn(checked)} onClick={onClick}>
          {checked ? "ON" : "OFF"}
        </button>
      </div>
    );
  }
  
  const panel = {
    width: "100%",
    maxWidth: 340,
    padding: 16,
    borderLeft: "1px solid rgba(255,255,255,0.12)",
    boxSizing: "border-box",
  };
  
  const headerRow = { display: "flex", justifyContent: "space-between" };
  const section = { marginTop: 16, display: "grid", gap: 10 };
  
  const sectionTitle = {
    fontSize: 12,
    fontWeight: 800,
    opacity: 0.75,
    textTransform: "uppercase",
  };
  
  const row = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };
  
  const primaryBtn = {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.18)",
    fontWeight: 800,
    cursor: "pointer",
  };
  
  const smallBtn = {
    padding: "4px 10px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.2)",
    cursor: "pointer",
    fontWeight: 800,
  };

  const secondaryBtn = {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.18)",
    opacity: 0.9,
    cursor: "pointer",
  };
  
  const toggleBtn = (on) => ({
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    minWidth: 60,
    cursor: "pointer",
    fontWeight: 800,
    opacity: on ? 1 : 0.6,
  });
  