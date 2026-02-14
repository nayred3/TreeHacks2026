export default function DemoControlPanel({ store, backendStatus = "offline" }) {
    const { isRunning, debug, startDemo, resetDemo, toggle } = store;
  
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
        </div>
      </div>
    );
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
  