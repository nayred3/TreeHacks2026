/**
 * Simulation Clock + Playback controls.
 * Play/pause, step, speed (0.5x/1x/2x/4x), reset.
 */

export default function SimControlPanel({
  isPlaying,
  simTimeMs,
  lastUpdateMs,
  speedIndex,
  speedOptions = [0.5, 1, 2, 4],
  onPlay,
  onPause,
  onTogglePlayPause,
  onStep,
  onSetSpeed,
  onReset,
}) {
  const simTimeSec = (simTimeMs / 1000).toFixed(1);
  const lastUpdate = lastUpdateMs
    ? new Date(lastUpdateMs).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";

  return (
    <div className="sim-control-panel" style={panel}>
      <div style={header}>Simulation Clock</div>
      <div style={row}>
        <span style={label}>Sim time</span>
        <span style={value}>{simTimeSec}s</span>
      </div>
      <div style={row}>
        <span style={label}>Last update</span>
        <span style={value}>{lastUpdate}</span>
      </div>

      <div style={buttonRow}>
        <button
          style={primaryBtn}
          onClick={onTogglePlayPause}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? "⏸ Pause" : "▶ Play"}
        </button>
        <button style={secondaryBtn} onClick={onStep} title="Step once">
          Step
        </button>
        <button style={secondaryBtn} onClick={onReset} title="Reset">
          Reset
        </button>
      </div>

      <div style={section}>
        <span style={label}>Speed</span>
        <div style={{ display: "flex", gap: 6 }}>
          {speedOptions.map((s, i) => (
            <button
              key={s}
              style={{
                ...smallBtn,
                ...(speedIndex === i ? activeBtn : {}),
              }}
              onClick={() => onSetSpeed(i)}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const panel = {
  padding: 12,
  borderRadius: 10,
  border: "1px solid rgba(0, 255, 255, 0.25)",
  background: "rgba(0, 15, 25, 0.4)",
};

const header = {
  fontSize: "11px",
  fontWeight: 800,
  color: "#00ffff",
  marginBottom: 10,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const row = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "4px 0",
  fontSize: "11px",
};

const label = { opacity: 0.8 };
const value = { fontVariantNumeric: "tabular-nums", fontWeight: 600 };

const buttonRow = {
  display: "flex",
  gap: 8,
  marginTop: 12,
  flexWrap: "wrap",
};

const primaryBtn = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid rgba(0, 255, 255, 0.4)",
  background: "rgba(0, 255, 255, 0.12)",
  color: "#00ffff",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: "11px",
};

const secondaryBtn = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid rgba(255, 255, 255, 0.2)",
  background: "transparent",
  color: "rgba(255,255,255,0.9)",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: "11px",
};

const section = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginTop: 12,
  gap: 10,
};

const smallBtn = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid rgba(255, 255, 255, 0.2)",
  background: "transparent",
  color: "rgba(255,255,255,0.8)",
  cursor: "pointer",
  fontSize: "10px",
  fontWeight: 600,
};

const activeBtn = {
  borderColor: "rgba(0, 255, 255, 0.6)",
  background: "rgba(0, 255, 255, 0.15)",
  color: "#00ffff",
};
