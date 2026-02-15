import { useState, useEffect, useRef, useCallback } from "react";
import { WW, WH, AGENT_COLORS, TARGET_COLOR, REASSIGN_THRESHOLD, STALE_TTL, toPx, toWorld, ROOM_BOUNDS, CM_PER_TICK } from "./config.js";
import { euclidean, randomWalk } from "./utils.js";
import { runPriorityAssignment } from "./assignment.js";
import { drawScene } from "./canvas.js";
import { extractWallGrid, createPresetWallLayout, wallLayoutToGrid, gridToWallLayout, WALL_LAYOUT_OPTIONS, GRID_SIZE } from "./pathfinding.js";
import { fetchFusionData } from "./liveDemo.js";

export default function App() {
  const canvasRef = useRef(null);
  const stateRef  = useRef(null);
  const animRef   = useRef(null);

  const [ui, setUi]           = useState(null);
  const [result, setResult]   = useState({
    primary: {}, secondary: {}, tertiary: {}, proximity: {}, agentPriorities: {},
    matrix: { byAgent: {}, byTarget: {} },
  });
  const [paused, setPaused]   = useState(false);
  const [frozen, setFrozen]   = useState(false);
  const [showZones, setZones] = useState(false);
  const [hl, setHL]           = useState(null);
  const [events, setEvents]   = useState([]);
  const [tick, setTick]       = useState(0);
  const [rCount, setRC]       = useState(0);
  const [tab, setTab]         = useState("priority");
  const [matrixFocus, setMatrixFocus] = useState("all");
  const [jsonView, setJsonView] = useState("full");
  const [jsonPretty, setJsonPretty] = useState(true);
  const [logFilter, setLogFilter] = useState("all");
  const [wallGrid, setWallGrid]         = useState(null);
  const [wallLayout, setWallLayout]     = useState(null);
  const [isLiveDemo, setIsLiveDemo]     = useState(false);
  const [wallsDropdownOpen, setWallsDropdownOpen] = useState(false);
  const wallsDropdownRef = useRef(null);
  const fileInputRef = useRef(null);
  const liveAgentsRef = useRef([]);
  const liveTargetsRef = useRef([]);

  useEffect(() => {
    const close = (e) => { if (wallsDropdownRef.current && !wallsDropdownRef.current.contains(e.target)) setWallsDropdownOpen(false); };
    if (wallsDropdownOpen) { document.addEventListener("click", close); return () => document.removeEventListener("click", close); }
  }, [wallsDropdownOpen]);

  // Live Demo: poll fusion /api/map, map cameras -> agents, fused_tracks -> targets
  useEffect(() => {
    if (!isLiveDemo) {
      liveAgentsRef.current = [];
      liveTargetsRef.current = [];
      return;
    }
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const { agents, targets } = await fetchFusionData();
        if (cancelled) return;
        liveAgentsRef.current = agents;
        liveTargetsRef.current = targets;
        setTick(t => t + 1);
      } catch (_) {
        // Fusion server not running; leave refs empty
      }
    };
    poll();
    const iv = setInterval(poll, 200);
    addEvent("Live Demo — polling fusion cam_view data…", "system");
    return () => { cancelled = true; clearInterval(iv); };
  }, [isLiveDemo, addEvent]);

  const addEvent = useCallback((msg, type = "info") =>
    setEvents(prev => [{ msg, type, ts: Date.now() }, ...prev.slice(0, 59)]), []);

  // Init
  useEffect(() => {
    const now = Date.now();
    stateRef.current = {
      agents: [
        { id: "Alice",   position: { x: -250, y: -150 }, vel: { vx:  1.5, vy:  1.0 } },
        { id: "Bob",     position: { x:  250, y: -120 }, vel: { vx: -1.2, vy:  1.5 } },
        { id: "Charlie", position: { x:   50, y:  150 }, vel: { vx:  0.8, vy: -1.8 } },
        { id: "Diana",   position: { x: -220, y:  120 }, vel: { vx:  1.6, vy: -0.9 } },
      ],
      targets: [
        { id: 1, position: { x: -120, y: -50 }, vel: { vx:  2.0, vy:  1.0  }, confidence: 0.93, lastSeen: now },
        { id: 2, position: { x:  180, y:  60 }, vel: { vx: -1.6, vy:  1.2 }, confidence: 0.81, lastSeen: now },
        { id: 3, position: { x:   20, y:  40 }, vel: { vx:  1.0, vy: -2.0  }, confidence: 0.67, lastSeen: now },
      ],
      prevPrimary: {}, prevSecondary: {}, nextId: 4,
    };
    addEvent("System online — 4 agents, 3 targets", "system");
  }, []);

  // Load default wall layout on mount so map displays immediately
  useEffect(() => {
    const layout = createPresetWallLayout(WW, WH, "corridor");
    setWallLayout(layout);
    setWallGrid(wallLayoutToGrid(layout, WW, WH));
    if (stateRef.current) {
      stateRef.current.prevPrimary = {};
      stateRef.current.prevSecondary = {};
    }
  }, []);

  // Loop
  useEffect(() => {
    if (!stateRef.current) return;
    let lastT = performance.now(), tickN = 0;
    const nearestWalkablePos = (p, maxRadius = 20) => {
      if (!wallGrid?.length) return p;
      const pPx = toPx(p);
      const rows = wallGrid.length;
      const cols = wallGrid[0].length;
      const c0 = Math.max(0, Math.min(cols - 1, Math.floor(pPx.x / GRID_SIZE)));
      const r0 = Math.max(0, Math.min(rows - 1, Math.floor(pPx.y / GRID_SIZE)));
      if (!wallGrid[r0][c0]) return p;

      for (let radius = 1; radius <= maxRadius; radius++) {
        for (let dr = -radius; dr <= radius; dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            const rr = r0 + dr;
            const cc = c0 + dc;
            if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
            if (!wallGrid[rr][cc]) {
              const pxX = cc * GRID_SIZE + GRID_SIZE / 2;
              const pxY = rr * GRID_SIZE + GRID_SIZE / 2;
              return toWorld(pxX, pxY);
            }
          }
        }
      }
      return p;
    };

    const isWalkable = (p) => {
      if (!wallGrid?.length) return true;
      const pPx = toPx(p);
      const rows = wallGrid.length;
      const cols = wallGrid[0].length;
      const c = Math.max(0, Math.min(cols - 1, Math.floor(pPx.x / GRID_SIZE)));
      const r = Math.max(0, Math.min(rows - 1, Math.floor(pPx.y / GRID_SIZE)));
      return !wallGrid[r][c];
    };

    const constrainedWalk = (position, vel, wander = 0.5) => {
      const basePos = wallGrid ? nearestWalkablePos(position) : position;
      const r = randomWalk(basePos, vel, wander);
      if (!wallGrid) return r;
      if (isWalkable(r.pos)) return r;
      const bounce = { pos: { ...basePos }, vel: { vx: -vel.vx, vy: -vel.vy } };
      const next = randomWalk(bounce.pos, bounce.vel, CM_PER_TICK);
      if (isWalkable(next.pos)) return next;
      const parked = nearestWalkablePos(basePos);
      return { pos: { ...parked }, vel: { vx: -vel.vx * 0.6, vy: -vel.vy * 0.6 } };
    };

    function loop(now) {
      animRef.current = requestAnimationFrame(loop);
      const s = stateRef.current;
      let agents, targets;
      if (isLiveDemo) {
        agents = [...liveAgentsRef.current];
        targets = [...liveTargetsRef.current];
      } else {
        if (paused || now - lastT < 50) return;
        lastT = now; tickN++;
        s.agents = s.agents.map(a => { const r = constrainedWalk(a.position, a.vel, CM_PER_TICK); return { ...a, position: r.pos, vel: r.vel }; });
        if (!frozen) {
          s.targets = s.targets.map(t => { const r = constrainedWalk(t.position, t.vel, CM_PER_TICK); return { ...t, position: r.pos, vel: r.vel, lastSeen: Date.now() }; });
        }
        agents = s.agents;
        targets = s.targets;
      }
      const res = runPriorityAssignment(agents, targets, s.prevPrimary, s.prevSecondary, wallGrid);
      for (const [tid, aid] of Object.entries(res.primary)) {
        if (s.prevPrimary[tid] && s.prevPrimary[tid] !== aid) {
          addEvent(`↩ P1 T${tid}: ${s.prevPrimary[tid]} → ${aid}`, "reassign");
          setRC(c => c + 1);
        }
      }
      s.prevPrimary = { ...res.primary }; s.prevSecondary = { ...res.secondary };
      const canvas = canvasRef.current;
      if (canvas) drawScene(canvas, agents, targets, res, hl, Date.now(), showZones, null, wallLayout, res.matrix.paths);
      setTick(tickN); setResult(res);
      setUi({ agents: [...agents], targets: [...targets] });
    }
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [paused, frozen, hl, showZones, addEvent, wallGrid, wallLayout, isLiveDemo]);

  const onCanvasClick = e => {
    if (!stateRef.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // Map displayed coords to canvas logical coords (canvas may be scaled)
    const canvasX = (px / rect.width) * WW;
    const canvasY = (py / rect.height) * WH;
    const clickWorld = toWorld(canvasX, canvasY);
    const hitRadius = 25;  // cm
    for (const a of stateRef.current.agents) {
      if (euclidean(clickWorld, a.position) < hitRadius) { setHL(h => h === a.id ? null : a.id); return; }
    }
    for (const t of stateRef.current.targets) {
      if (euclidean(clickWorld, t.position) < hitRadius) { setHL(h => h === `t${t.id}` ? null : `t${t.id}`); return; }
    }
    setHL(null);
  };

  const spawn = () => {
    const s = stateRef.current; if (!s) return;
    const id = s.nextId++;
    const { xMin, xMax, yMin, yMax } = ROOM_BOUNDS;
    s.targets.push({ id, position: { x: xMin + Math.random() * (xMax - xMin - 50), y: yMin + Math.random() * (yMax - yMin - 50) },
      vel: { vx: (Math.random() - 0.5) * 5, vy: (Math.random() - 0.5) * 5 },
      confidence: 0.5 + Math.random() * 0.5, lastSeen: Date.now() });
    addEvent(`🔴 T${id} detected — priorities recomputing…`, "spawn");
  };
  const neutralise = () => {
    const s = stateRef.current; if (!s || !s.targets.length) return;
    const res = runPriorityAssignment(s.agents, s.targets, s.prevPrimary, s.prevSecondary, wallGrid);
    const { primary } = res;
    const agentById = Object.fromEntries(s.agents.map(a => [a.id, a]));

    // Neutralise the target in the primary-target–agent pair with smallest distance
    let toNeutralise = null;
    let minD = Infinity;
    for (const t of s.targets) {
      const aid = primary[t.id];
      if (!aid) continue;
      const a = agentById[aid];
      if (!a) continue;
      const d = euclidean(t.position, a.position);
      if (d < minD) { minD = d; toNeutralise = t; }
    }
    if (!toNeutralise) return;
    const idx = s.targets.findIndex(t => t.id === toNeutralise.id);
    const t = s.targets.splice(idx, 1)[0];
    delete s.prevPrimary[t.id]; delete s.prevSecondary[t.id];
    addEvent(`✅ T${t.id} neutralised`, "remove");
  };
  const scatter = () => {
    const s = stateRef.current; if (!s) return;
    const { xMin, xMax, yMin, yMax } = ROOM_BOUNDS;
    const rnd = () => ({ x: xMin + Math.random() * (xMax - xMin - 50), y: yMin + Math.random() * (yMax - yMin - 50) });
    s.agents  = s.agents.map(a  => ({ ...a,  position: rnd() }));
    s.targets = s.targets.map(t => ({ ...t,  position: rnd(), lastSeen: Date.now() }));
    s.prevPrimary = {}; s.prevSecondary = {};
    addEvent("⚡ Scattered — full priority recalculation!", "reassign");
  };

  const handleSchematicUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const rawGrid = extractWallGrid(img, WW, WH);
      const layout = gridToWallLayout(rawGrid);
      setWallLayout(layout);
      setWallGrid(wallLayoutToGrid(layout, WW, WH));
      setIsLiveDemo(false);
      if (stateRef.current) { stateRef.current.prevPrimary = {}; stateRef.current.prevSecondary = {}; }
      addEvent("🏗 Schematic loaded — wall-aware pathfinding active", "system");
    };
    img.src = URL.createObjectURL(file);
    e.target.value = "";
  };
  const clearSchematic = () => {
    setWallLayout(null);
    setWallGrid(null);
    setIsLiveDemo(false);
    if (stateRef.current) { stateRef.current.prevPrimary = {}; stateRef.current.prevSecondary = {}; }
    addEvent("🏗 Schematic cleared — euclidean distances restored", "system");
  };

  const addPresetWalls = (layoutType = "corridor") => {
    const layout = createPresetWallLayout(WW, WH, layoutType);
    setWallLayout(layout);
    setWallGrid(wallLayoutToGrid(layout, WW, WH));
    setIsLiveDemo(layoutType === "dual-vertical");
    if (stateRef.current) {
      stateRef.current.prevPrimary = {};
      stateRef.current.prevSecondary = {};
    }
    setWallsDropdownOpen(false);
    const label = WALL_LAYOUT_OPTIONS.find(o => o.id === layoutType)?.label || layoutType;
    addEvent(`🧱 ${label} — A* pathfinding enabled`, "system");
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const agents   = ui?.agents  || [];
  const targets  = ui?.targets || [];
  const unassigned = targets.filter((t) =>
    result.primary[t.id] === undefined
    && result.secondary[t.id] === undefined
    && result.tertiary[t.id] === undefined
  );

  const C = {
    bg:"#080a12", panel:"#0f1420", border:"#2a2d45",
    text:"#e8ecf4", dim:"#94a3b8", bright:"#f1f5f9",
    cyan:"#38bdf8", gold:"#fbbf24", teal:"#2dd4bf",
    green:"#34d399", red:"#f87171", orange:"#fb923c", yellow:"#fbbf24", purple:"#a78bfa", magenta:"#f472b6",
    gradientBg:"linear-gradient(135deg, #0a0d18 0%, #12162a 40%, #0d1018 100%)",
    gradientPanel:"linear-gradient(165deg, rgba(26,30,55,0.95) 0%, rgba(15,18,35,0.98) 50%, rgba(10,12,25,0.99) 100%)",
    gradientOmbre:"linear-gradient(180deg, rgba(184,90,40,0.25) 0%, rgba(251,191,36,0.12) 50%, rgba(56,189,248,0.08) 100%)",
    gradientPurple:"linear-gradient(135deg, rgba(99,102,241,0.25) 0%, rgba(139,92,246,0.12) 100%)",
  };

  const TabBtn = ({ id, label }) => (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setTab(id); }}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTab(id); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          setTab(id);
        }
      }}
      style={{
      background: tab === id ? C.gradientPurple : "transparent",
      border: `1px solid ${tab === id ? C.border : "transparent"}`,
      borderBottom: tab === id ? `1px solid transparent` : `1px solid ${C.border}`,
      color: tab === id ? C.bright : C.dim, padding: "5px 12px", cursor: "pointer",
      fontSize: 11, fontFamily: "inherit", letterSpacing: "0.04em",
      borderRadius: "4px 4px 0 0", marginBottom: -1, transition: "all 0.15s",
      position: "relative", zIndex: 8, pointerEvents: "auto",
      boxShadow: tab === id ? "0 -2px 8px rgba(99,102,241,0.15)" : "none",
    }}
    >{label}</button>
  );

  // Matrix rows for display
  const matrixRows = targets.map(t => ({
    targetId: t.id,
    row: agents.map(a => ({
      agentId: a.id,
      d: result.matrix.byTarget?.[t.id]?.[a.id] ?? euclidean(t.position, a.position),
      isPrim: result.primary[t.id] === a.id,
      isSec:  result.secondary[t.id] === a.id,
      isTer:  result.tertiary[t.id] === a.id,
      isProx: result.proximity[t.id] === a.id && result.primary[t.id] !== a.id && result.secondary[t.id] !== a.id && result.tertiary[t.id] !== a.id,
    })).sort((a, b) => a.d - b.d),
  }));

  const jsonPayload = {
    assignments: [
      ...Object.entries(result.primary).map(([tid, aid]) => ({
        target_id: +tid, agent_id: aid, role: "primary",
        distance: +(result.matrix.byTarget?.[+tid]?.[aid] ?? 0).toFixed(2),
      })),
      ...Object.entries(result.secondary).map(([tid, aid]) => ({
        target_id: +tid, agent_id: aid, role: "secondary",
        distance: +(result.matrix.byTarget?.[+tid]?.[aid] ?? 0).toFixed(2),
      })),
      ...Object.entries(result.tertiary).map(([tid, aid]) => ({
        target_id: +tid, agent_id: aid, role: "tertiary",
        distance: +(result.matrix.byTarget?.[+tid]?.[aid] ?? 0).toFixed(2),
      })),
    ],
    proximity: Object.entries(result.proximity).map(([tid, aid]) => ({ target_id: +tid, closest_agent: aid })),
    unassigned_targets: unassigned.map(t => t.id),
    algorithm: "v2_priority_antithrash",
    timestamp: Date.now(),
  };
  const jsonPayloadView = jsonView === "assignments"
    ? { assignments: jsonPayload.assignments }
    : jsonView === "proximity"
    ? { proximity: jsonPayload.proximity }
    : jsonView === "coverage"
    ? { unassigned_targets: jsonPayload.unassigned_targets }
    : jsonPayload;

  const visibleEvents = events.filter((e) => logFilter === "all" || e.type === logFilter);
  const logCounts = {
    all: events.length,
    reassign: events.filter((e) => e.type === "reassign").length,
    spawn: events.filter((e) => e.type === "spawn").length,
    remove: events.filter((e) => e.type === "remove").length,
    system: events.filter((e) => e.type === "system").length,
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily:"'Inter','Segoe UI',system-ui,-apple-system,sans-serif", background:C.gradientBg, minHeight:"100vh", display:"flex", flexDirection:"column", color:C.text, padding:14, boxSizing:"border-box" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        * { box-sizing:border-box; }
        ::-webkit-scrollbar { width:6px; height:6px; }
        ::-webkit-scrollbar-track { background: linear-gradient(180deg, #0d1018, #12162a); }
        ::-webkit-scrollbar-thumb { background: linear-gradient(180deg, #4b4b6b 0%, #6366f1 50%, #3b3d5c 100%); border-radius:4px; }
        ::-webkit-scrollbar-thumb:hover { background: linear-gradient(180deg, #6366f1 0%, #818cf8 100%); }
        @keyframes fadeIn { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:none} }
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:0.45} }
        button:hover { filter:brightness(1.12); }
      `}</style>

      {/* ── Header ── */}
      <div style={{ flexShrink:0, display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10, flexWrap:"wrap", gap:8 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:600, letterSpacing:"0.05em", background:"linear-gradient(90deg, #38bdf8 0%, #818cf8 50%, #a78bfa 100%)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", backgroundClip:"text" }}>PRIORITY ASSIGNMENT ENGINE</div>
          <div style={{ fontSize:12, color:C.dim, letterSpacing:"0.04em", marginTop:2 }}>DISTANCE-BASED PRIORITY</div>
        </div>
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
          {(wallLayout || wallGrid) && !isLiveDemo && (
            <>
              {[
                { label: paused ? "RESUME" : "PAUSE",  onClick: () => setPaused(p=>!p), active: paused, ac: C.green },
                { label: frozen ? "MOVING TARGETS" : "FREEZE TARGETS", onClick: () => { setFrozen(f=>!f); addEvent(frozen?"▶ Moving":"⬛ Frozen","system"); }, active: frozen, ac: C.cyan },
                { label: "◎ ZONES", onClick: () => setZones(z=>!z), active: showZones, ac: C.cyan },
              ].map(b => (
                <button key={b.label} onClick={b.onClick} style={{
                  background: b.active ? "linear-gradient(135deg, rgba(56,189,248,0.22) 0%, rgba(99,102,241,0.12) 100%)" : C.panel,
                  border: `1px solid ${b.active ? b.ac : C.border}`,
                  color: b.active ? b.ac : C.dim,
                  padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", boxShadow: b.active ? "0 0 8px rgba(56,189,248,0.2)" : "none",
                }}>{b.label}</button>
              ))}
              <button onClick={spawn} style={{ background:"#2d0a0a", border:`1px solid ${C.red}60`, color:C.red, padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>⊕ SPAWN</button>
              <button onClick={neutralise} style={{ background:"#0d2d14", border:`1px solid ${C.green}60`, color:C.green, padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>⊘ NEUTRALISE</button>
              <button onClick={scatter} style={{ background:"#2d2608", border:`1px solid ${C.gold}60`, color:C.gold, padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>⚡ SCATTER</button>
            </>
          )}
          <button onClick={() => { setIsLiveDemo(prev => !prev); if (!isLiveDemo) addPresetWalls("dual-vertical"); }} style={{
            background: isLiveDemo ? "linear-gradient(135deg, rgba(56,189,248,0.3) 0%, rgba(99,102,241,0.2) 100%)" : C.panel, border:`1px solid ${isLiveDemo ? "#38bdf8" : C.border}`, color:C.cyan,
            padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", boxShadow: isLiveDemo ? "0 0 12px rgba(56,189,248,0.25)" : "none",
          }}>{isLiveDemo ? "LIVE DEMO ON" : "LIVE DEMO"}</button>
          <div ref={wallsDropdownRef} style={{ position:"relative" }}>
            <button onClick={() => setWallsDropdownOpen(o => !o)} style={{
              background: wallsDropdownOpen ? "rgba(251,191,36,0.12)" : C.panel, border:`1px solid ${C.gold}`, color:C.gold,
              padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit",
              display:"flex", alignItems:"center", gap:6,
            }}>
              SAMPLE SIMULATIONS ▾
            </button>
            {wallsDropdownOpen && (
              <div style={{
                position:"absolute", top:"100%", left:0, marginTop:4, background:C.gradientPanel, border:`1px solid ${C.border}`,
                borderRadius:6, boxShadow:"0 4px 16px rgba(0,0,0,0.4)", minWidth:160, zIndex:20,
              }}>
                {WALL_LAYOUT_OPTIONS.map(({ id, label }) => (
                  <button key={id} onClick={() => addPresetWalls(id)} style={{
                    display:"block", width:"100%", textAlign:"left", padding:"8px 12px", border:"none",
                    background:"transparent", color:C.text, cursor:"pointer", fontSize:11, fontFamily:"inherit",
                  }} onMouseEnter={e => { e.target.style.background = C.border; }} onMouseLeave={e => { e.target.style.background = "transparent"; }}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleSchematicUpload} style={{ display:"none" }}/>
          <button onClick={() => fileInputRef.current?.click()} style={{
            background:"linear-gradient(135deg, rgba(56,189,248,0.2) 0%, rgba(99,102,241,0.15) 50%, rgba(45,212,191,0.12) 100%)",
            border:"1px solid rgba(99,102,241,0.5)",
            color:C.cyan,
            padding:"8px 16px",
            borderRadius:8,
            cursor:"pointer",
            fontSize:11,
            fontWeight:600,
            letterSpacing:"0.05em",
            boxShadow:"0 0 16px rgba(99,102,241,0.2)",
            fontFamily:"inherit",
          }}> LOAD SCHEMATIC</button>
          {(wallLayout || wallGrid) && <button onClick={clearSchematic} style={{ background:"#2d0a0a", border:`1px solid ${C.red}60`, color:C.red, padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>✕ CLEAR MAP</button>}
        </div>
      </div>

      {/* ── Line Legend ── */}
      <div style={{ flexShrink:0, display:"flex", gap:14, marginBottom:10, padding:"10px 14px", background:C.gradientPanel, border:`1px solid ${C.border}`, borderRadius:8, flexWrap:"wrap", alignItems:"center", boxShadow:"0 2px 8px rgba(0,0,0,0.3)" }}>
        <span style={{ fontSize:11, color:C.dim, letterSpacing:"0.05em" }}>LINE KEY:</span>
          {[
            { stroke:C.text, dash:"", w:2.5,  label:"P1 Primary Target" },
            { stroke:C.text, dash:"5,4", w:1.5, label:"P2 Secondary Target" },
            { stroke:C.text, dash:"2,4", w:1.2, label:"P3 Tertiary Target" },
            { stroke:C.dim, dash:"2,8", w:1.0, label:"Proximity - shown on hover" },
          ].map(({ stroke, dash, w, label }) => (
          <div key={label} style={{ display:"flex", alignItems:"center", gap:6 }}>
            <svg width="30" height="8" style={{ flexShrink:0 }}>
              <line x1="0" y1="4" x2="30" y2="4" stroke={stroke} strokeWidth={w} strokeDasharray={dash} opacity={dash==="2,8"?"0.4":"0.85"}/>
            </svg>
            <span style={{ fontSize:11, color:C.text }}>{label}</span>
          </div>
        ))}
        <div style={{ marginLeft:"auto", display:"flex", gap:10 }}>
          {[{ bg:C.green, label:"P1 assigned" }, { bg:C.gold, label:"P2 assigned" }, { bg:C.orange, label:"P3 assigned" }, { bg:C.red+"88", label:"Unassigned" }].map(x=>(
            <div key={x.label} style={{ display:"flex", alignItems:"center", gap:4 }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:x.bg }}/><span style={{ fontSize:11, color:C.text }}>{x.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main layout: center (map + recap) leftmost | right cameras | left cameras ── */}
      <div style={{ flex:1, minHeight:0, display:"flex", flexDirection:"column", maxWidth:"100%", overflow:"auto" }}>
      <div style={{ flex:1, minHeight:0, display:"flex", gap:0, justifyContent:"flex-start", alignItems:"stretch", minWidth:"min-content" }}>

        {/* Center column: Live map + Recap (leftmost edge) */}
        <div style={{ width: Math.round((WW + 24) * 0.78), flexShrink:0, overflow:"hidden" }}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12, transform:"scale(0.78)", transformOrigin:"top left", width: WW + 24 }}>
          {/* Live map */}
          <div>
            <canvas ref={canvasRef} onClick={onCanvasClick}
              style={{ display:"block", width:WW, height:WH, border:`1px solid ${C.border}`, borderRadius:6, cursor:"crosshair", boxShadow:"0 0 24px rgba(99,102,241,0.1)" }}/>
            <div style={{ display:"flex", gap:10, marginTop:8, padding:"10px 12px", background:C.gradientPanel, border:`1px solid ${C.border}`, borderRadius:8, flexWrap:"wrap", boxShadow:"0 2px 8px rgba(0,0,0,0.2)" }}>
              <span style={{ fontSize:11, color:C.dim }}>CLICK TO HIGHLIGHT:</span>
              {agents.map(a => (
                <div key={a.id} onClick={() => setHL(h => h === a.id ? null : a.id)}
                  style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", opacity:hl && hl!==a.id?0.35:1, transition:"opacity 0.2s" }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:AGENT_COLORS[a.id], boxShadow:`0 0 6px ${AGENT_COLORS[a.id]}` }}/>
                  <span style={{ fontSize:11, fontWeight:hl===a.id?600:400, color:hl===a.id?AGENT_COLORS[a.id]:C.text }}>{a.id}</span>
                </div>
              ))}
              <span style={{ fontSize:11, color:C.dim, marginLeft:"auto" }}>or click agent/target on map</span>
            </div>
          </div>

          {/* Recap section */}
          <div style={{ width:WW + 24, display:"flex", flexDirection:"column", gap:0 }}>

          {/* Summary row */}
          <div style={{ display:"flex", background:C.gradientPanel, border:`1px solid ${C.border}`, borderRadius:"8px 8px 0 0", borderBottom:"none", boxShadow:"inset 0 1px 0 rgba(255,255,255,0.04)" }}>
            {[
              { label:"P1 ASSIGNED",  val:Object.keys(result.primary).length,   col:C.green },
              { label:"P2 COVERAGE",  val:Object.keys(result.secondary).length,  col:C.gold },
              { label:"P3 COVERAGE",  val:Object.keys(result.tertiary).length,  col:C.orange },
              { label:"UNASSIGNED",   val:unassigned.length,                     col:unassigned.length?C.red:C.dim },
              { label:"TOTAL TARGETS",val:targets.length,                        col:C.teal },
            ].map(s => (
              <div key={s.label} style={{ flex:1, textAlign:"center", padding:"9px 4px", borderRight:`1px solid ${C.border}` }}>
                <div style={{ fontSize:18, fontWeight:700, color:s.col, lineHeight:1 }}>{s.val}</div>
                <div style={{ fontSize:10, color:C.dim, letterSpacing:"0.05em", marginTop:2 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div style={{ borderBottom:`1px solid ${C.border}`, display:"flex", paddingLeft:8, background:C.bg, position:"relative", zIndex:7, pointerEvents:"auto" }}>
            <TabBtn id="priority" label="PRIORITIES"/>
            <TabBtn id="matrix"   label="MATRIX"/>
            <TabBtn id="json"     label="JSON"/>
            <TabBtn id="log"      label="LOG"/>
          </div>

          {/* Tab body */}
          <div style={{ background:C.gradientPanel, border:`1px solid ${C.border}`, borderTop:"none", borderRadius:"0 0 8px 8px", padding:12, minHeight:200, maxHeight:260, overflow:"auto", position:"relative", zIndex:1, boxShadow:"0 4px 12px rgba(0,0,0,0.25)" }}>

            {/* PRIORITY TAB */}
            {tab === "priority" && (
              <div>
                <div style={{ fontSize:11, color:C.dim, letterSpacing:"0.04em", marginBottom:10 }}>
                  P1 = primary target. P2 = next target. P3 = overflow target.
                  </div>
                {agents.map(agent => {
                  const color  = AGENT_COLORS[agent.id] || "#888";
                  const isHl   = hl === agent.id;
                  const prList = result.agentPriorities[agent.id] || [];
                  return (
                    <div key={agent.id} onClick={() => setHL(h => h === agent.id ? null : agent.id)}
                      style={{ marginBottom:8, padding:"8px 10px", borderRadius:5, cursor:"pointer",
                        border:`1px solid ${isHl?color:C.border}`,
                        background: isHl ? C.gradientPurple : C.bg,
                        boxShadow: isHl?`0 0 12px ${color}30`:"none", transition:"all 0.2s" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                        <div style={{ width:9, height:9, borderRadius:"50%", background:color, boxShadow:`0 0 6px ${color}` }}/>
                        <span style={{ color, fontWeight:600, fontSize:12 }}>{agent.id}</span>
                        <span style={{ fontSize:11, color:C.dim, marginLeft:4 }}>pos ({agent.position.x.toFixed(0)}, {agent.position.y.toFixed(0)}) cm</span>
                        <span style={{ marginLeft:"auto", display:"flex", gap:4 }}>
                          {prList.find(e=>e.role==="primary") && <span style={{ fontSize:10, fontWeight:600, color:C.green, border:`1px solid ${C.green}50`, borderRadius:3, padding:"2px 6px" }}>P1 ✓</span>}
                          {prList.find(e=>e.role==="secondary") && <span style={{ fontSize:10, fontWeight:600, color:C.gold, border:`1px solid ${C.gold}50`, borderRadius:3, padding:"2px 6px" }}>P2 ~</span>}
                          {prList.find(e=>e.role==="tertiary") && <span style={{ fontSize:10, fontWeight:600, color:C.orange, border:`1px solid ${C.orange}50`, borderRadius:3, padding:"2px 6px" }}>P3 ·</span>}
                        </span>
                      </div>
                      {prList.length === 0 ? <div style={{ fontSize:11, color:C.dim }}>No targets</div>
                        : prList.map(({ targetId, distance, role }) => {
                          const isAssigned = role === "primary" || role === "secondary" || role === "tertiary";
                          return (
                          <div key={targetId} style={{
                            display:"flex", alignItems:"center", gap:6, padding:"3px 0",
                            borderBottom:`1px solid ${C.border}`,
                            opacity: isAssigned ? 1 : 0.35,
                          }}>
                            <span style={{ background: isAssigned ? TARGET_COLOR : C.dim, color: isAssigned ? "#fff" : C.text, fontSize:10, fontWeight:600, padding:"2px 5px", borderRadius:2 }}>T{targetId}</span>
                            <div style={{ flex:1, height:4, background:C.bg, borderRadius:2, overflow:"hidden" }}>
                              <div style={{
                                height:"100%", borderRadius:2, transition:"width 0.15s",
                                width:`${Math.max(4, Math.min(100, 100 - distance * 0.16))}%`,
                                background: role==="primary"?C.green:role==="secondary"?C.gold:role==="tertiary"?C.orange:C.dim+"40",
                              }}/>
                            </div>
                            <span style={{ fontSize:11, color:C.dim, minWidth:36, textAlign:"right" }}>{distance.toFixed(0)}cm</span>
                            {isAssigned ? (
                              <span style={{ minWidth:30, fontSize:10, fontWeight:600, textAlign:"center",
                                color:role==="primary"?C.green:role==="secondary"?C.gold:C.orange,
                                border:`1px solid ${role==="primary"?C.green+"40":role==="secondary"?C.gold+"40":C.orange+"40"}`,
                                borderRadius:3, padding:"1px 4px",
                              }}>
                                {role==="primary"?"P1":role==="secondary"?"P2":"P3"}
                              </span>
                            ) : (
                              <span style={{ minWidth:30, fontSize:10, textAlign:"center", color:C.dim }}>—</span>
                            )}
                          </div>
                          );
                        })
                      }
                    </div>
                  );
                })}
              </div>
            )}

            {/* MATRIX TAB */}
            {tab === "matrix" && (
              <div>
                <div style={{ fontSize:11, color:C.dim, marginBottom:8, lineHeight:1.6 }}>
                  Distance matrix = raw assignment computation. Rows are targets, columns are agents, and every cell is the live metre distance recomputed each tick.
                  <span style={{ color:C.green }}> Green✓</span> = P1, <span style={{ color:C.gold }}>Gold~</span> = P2, <span style={{ color:C.orange }}>Orange·</span> = P3, <span style={{ color:C.cyan }}>Cyan●</span> = closest-but-not-assigned.
                </div>
                <div style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
                  {[
                    { id:"all", lbl:"ALL" },
                    { id:"p1", lbl:"P1 ONLY" },
                    { id:"p2", lbl:"P2 ONLY" },
                    { id:"p3", lbl:"P3 ONLY" },
                    { id:"prox", lbl:"PROX ONLY" },
                  ].map((b) => (
                    <button key={b.id} onClick={() => setMatrixFocus(b.id)} style={{
                      background: matrixFocus === b.id ? "rgba(56,189,248,0.12)" : C.bg,
                      border:`1px solid ${matrixFocus === b.id ? C.cyan : C.border}`,
                      color: matrixFocus === b.id ? C.cyan : C.dim,
                      padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit",
                    }}>{b.lbl}</button>
                  ))}
                </div>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                  <thead>
                    <tr>
                      <th style={{ color:C.dim, padding:"4px 8px", textAlign:"left", borderBottom:`1px solid ${C.border}`, fontWeight:400, fontSize:11 }}>Target</th>
                      {agents.map(a => (
                        <th key={a.id} style={{ color:AGENT_COLORS[a.id], padding:"4px 8px", textAlign:"center", borderBottom:`1px solid ${C.border}`, fontWeight:600, fontSize:11 }}>{a.id[0]}</th>
                      ))}
                      <th style={{ color:C.dim, padding:"4px 8px", textAlign:"left", borderBottom:`1px solid ${C.border}`, fontWeight:400, fontSize:11 }}>Assigned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrixRows.map(({ targetId, row }) => {
                      const primAgent = result.primary[targetId];
                      const secAgent  = result.secondary[targetId];
                      const terAgent  = result.tertiary[targetId];
                      return (
                        <tr key={targetId}
                          style={{ background:hl===`t${targetId}`?"rgba(56,189,248,0.08)":"transparent", cursor:"pointer" }}
                          onClick={() => setHL(h => h===`t${targetId}`?null:`t${targetId}`)}>
                          <td style={{ padding:"4px 8px", borderBottom:`1px solid ${C.border}`, color:TARGET_COLOR, fontWeight:600 }}>T{targetId}</td>
                          {agents.map(a => {
                            const cell = row.find(r => r.agentId === a.id);
                            const { d, isPrim, isSec, isTer, isProx } = cell || { d:0, isPrim:false, isSec:false, isTer:false, isProx:false };
                            const focusMatch = matrixFocus === "all"
                              || (matrixFocus === "p1" && isPrim)
                              || (matrixFocus === "p2" && isSec)
                              || (matrixFocus === "p3" && isTer)
                              || (matrixFocus === "prox" && isProx);
                            return (
                              <td key={a.id} style={{
                                padding:"4px 8px", textAlign:"center", borderBottom:`1px solid ${C.border}`,
                                color: isPrim?C.green:isSec?C.gold:isTer?C.orange:isProx?C.cyan:C.dim,
                                fontWeight: isPrim||isSec||isTer?600:400,
                                background: isPrim?"rgba(63,185,80,0.12)":isSec?"rgba(210,152,75,0.1)":isTer?"rgba(210,152,75,0.08)":"transparent",
                                fontSize:11,
                                opacity: focusMatch ? 1 : 0.28,
                              }}>
                                {isProx?"●":""}{d.toFixed(0)}{isPrim?"✓":isSec?"~":isTer?"·":""}
                              </td>
                            );
                          })}
                          <td style={{ padding:"4px 8px", borderBottom:`1px solid ${C.border}`, fontSize:11 }}>
                            {primAgent
                              ? <span style={{ color:AGENT_COLORS[primAgent], fontWeight:600 }}>{primAgent} <span style={{ color:C.green, fontWeight:600 }}>P1</span></span>
                              : secAgent
                              ? <span style={{ color:AGENT_COLORS[secAgent] }}>{secAgent} <span style={{ color:C.gold }}>P2</span></span>
                              : terAgent
                              ? <span style={{ color:AGENT_COLORS[terAgent] }}>{terAgent} <span style={{ color:C.orange }}>P3</span></span>
                              : <span style={{ color:C.red }}>NONE</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop:8, fontSize:11, color:C.dim, lineHeight:1.7 }}>
                  Euclidean mode queues extra targets into P2 then P3 tiers. Selection favors closest agent, then earliest completion.
                  Pathfinding mode still uses anti-thrash threshold of <span style={{ color:C.gold }}>{REASSIGN_THRESHOLD}cm</span>.
                </div>
              </div>
            )}

            {/* JSON TAB */}
            {tab === "json" && (
              <div>
                <div style={{ fontSize:11, color:C.dim, letterSpacing:"0.04em", marginBottom:8 }}>
                  Live payload mirrored to Person 4 map integration. Use these controls to verify schema segments before wiring WebSocket consumers.
                </div>
                <div style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
                  {[
                    { id:"full", lbl:"FULL" },
                    { id:"assignments", lbl:"ASSIGNMENTS[]" },
                    { id:"proximity", lbl:"PROXIMITY[]" },
                    { id:"coverage", lbl:"UNASSIGNED[]" },
                  ].map((b) => (
                    <button key={b.id} onClick={() => setJsonView(b.id)} style={{
                      background: jsonView === b.id ? "rgba(56,189,248,0.12)" : C.bg,
                      border:`1px solid ${jsonView === b.id ? C.cyan : C.border}`,
                      color: jsonView === b.id ? C.cyan : C.dim,
                      padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit",
                    }}>{b.lbl}</button>
                  ))}
                  <button onClick={() => setJsonPretty((v) => !v)} style={{
                    background: jsonPretty ? "rgba(52,211,153,0.1)" : C.bg,
                    border:`1px solid ${jsonPretty ? C.green : C.border}`,
                    color: jsonPretty ? C.green : C.dim,
                    padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit",
                  }}>{jsonPretty ? "PRETTY" : "MINIFIED"}</button>
                  <button onClick={() => {
                    navigator.clipboard?.writeText(JSON.stringify(jsonPayloadView, null, jsonPretty ? 2 : 0));
                    addEvent("📋 JSON copied to clipboard", "system");
                  }} style={{
                    background:"rgba(52,211,153,0.1)", border:`1px solid ${C.green}80`, color:C.green,
                    padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit",
                  }}>COPY JSON</button>
                </div>
                <pre style={{ margin:0, fontSize:11, color:C.cyan, lineHeight:1.7, background:C.bg, padding:10, borderRadius:4, border:`1px solid ${C.border}`, overflow:"auto", maxHeight:300 }}>
                  {JSON.stringify(jsonPayloadView, null, jsonPretty ? 2 : 0)}
                </pre>
              </div>
            )}

            {/* LOG TAB */}
            {tab === "log" && (
              <div>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                  <div style={{ fontSize:11, color:C.dim, letterSpacing:"0.04em" }}>EVENT LOG · newest first</div>
                  <button onClick={() => setEvents([])} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.dim, padding:"4px 10px", borderRadius:3, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>CLEAR</button>
                </div>
                <div style={{ fontSize:11, color:C.dim, marginBottom:8, lineHeight:1.6 }}>
                  Audit stream of assignment behavior: <span style={{ color:C.gold }}>↩ reassign</span>, <span style={{ color:C.red }}>🔴 spawn</span>, <span style={{ color:C.green }}>✅ neutralise</span>, and system status.
                </div>
                <div style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
                  {[
                    { id:"all", lbl:`ALL ${logCounts.all}` },
                    { id:"reassign", lbl:`↩ ${logCounts.reassign}` },
                    { id:"spawn", lbl:`🔴 ${logCounts.spawn}` },
                    { id:"remove", lbl:`✅ ${logCounts.remove}` },
                    { id:"system", lbl:`SYS ${logCounts.system}` },
                  ].map((b) => (
                    <button key={b.id} onClick={() => setLogFilter(b.id)} style={{
                      background: logFilter === b.id ? "rgba(56,189,248,0.12)" : C.bg,
                      border:`1px solid ${logFilter === b.id ? C.cyan : C.border}`,
                      color: logFilter === b.id ? C.cyan : C.dim,
                      padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit",
                    }}>{b.lbl}</button>
                  ))}
                </div>
                {visibleEvents.length === 0 && <div style={{ fontSize:11, color:C.dim, animation:"pulse 2s infinite" }}>No events for this filter…</div>}
                {visibleEvents.map((e, i) => (
                  <div key={e.ts + i} style={{
                    fontSize:11, padding:"4px 0", borderBottom:`1px solid ${C.border}`,
                    color:e.type==="reassign"?C.yellow:e.type==="spawn"?C.red:e.type==="remove"?C.green:C.dim,
                    opacity:Math.max(0.25, 1 - i * 0.04),
                    animation:i===0?"fadeIn 0.2s ease":"none",
                  }}>{e.msg}</div>
                ))}
              </div>
            )}
          </div>

          {unassigned.length > 0 && (
            <div style={{ marginTop:8, padding:"8px 12px", background:"rgba(248,113,113,0.12)", border:`1px solid ${C.red}60`, borderRadius:8, fontSize:11, animation:"fadeIn 0.3s ease" }}>
              <span style={{ color:C.red, fontWeight:700 }}>⚠ COVERAGE GAP — </span>
              <span style={{ color:C.text }}>Targets {unassigned.map(t=>`T${t.id}`).join(", ")} unassigned. All agents at capacity.</span>
            </div>
          )}
          </div>
          </div>
        </div>

        {/* Agent panels: top row Alice & Bob, bottom row Charlie & Diana */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gridTemplateRows:"1fr 1fr", gap:8, flex:1, minWidth:320 }}>
          {agents.map(agent => {
            const color = AGENT_COLORS[agent.id] || "#888";
            const isHl = hl === agent.id;
            const prList = result.agentPriorities[agent.id] || [];
            const primEntry = prList.find(e => e.role === "primary");
            const secEntry = prList.find(e => e.role === "secondary");
            return (
                    <div key={agent.id} style={{ flex:1, minHeight:0, display:"flex", flexDirection:"column" }}>
                <div style={{ background:C.gradientOmbre, border:`1px solid ${isHl ? color + "99" : C.border}`, borderRadius:8, height:240, display:"flex", alignItems:"center", justifyContent:"center", color:C.dim, fontSize:11, boxShadow: isHl ? `0 0 16px ${color}30` : "0 2px 8px rgba(0,0,0,0.2)" }}>
                  {agent.id} Live Camera View
                </div>
                <div onClick={() => setHL(h => h === agent.id ? null : agent.id)}
                  style={{ marginTop:6, padding:12, background:C.gradientPanel, border:`1px solid ${isHl?color:C.border}`, borderRadius:8, cursor:"pointer", boxShadow: isHl ? `0 0 12px ${color}25` : "none" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", gap:16 }}>
                    <div>
                      <div style={{ fontSize:11, color:C.text, marginBottom:2 }}>{agent.id}</div>
                      <div style={{ fontSize:10, color:C.dim, marginBottom:2 }}>Position</div>
                      <div style={{ fontSize:11, color:C.green, fontWeight:600 }}>({agent.position.x.toFixed(0)}, {agent.position.y.toFixed(0)})</div>
                    </div>
                    <div>
                      <div style={{ fontSize:10, color:C.dim, marginBottom:2 }}>Primary</div>
                      <div style={{ fontSize:10, color:C.dim, marginBottom:2 }}>Assignment</div>
                      <div style={{ fontSize:11, color:C.green, fontWeight:600 }}>{primEntry ? `Target T${primEntry.targetId}` : "—"}</div>
                      <div style={{ fontSize:11, color:C.green, fontWeight:600 }}>{primEntry ? `Distance: ${primEntry.distance.toFixed(0)} cm` : ""}</div>
                    </div>
                    <div>
                      <div style={{ fontSize:10, color:C.dim, marginBottom:2 }}>Secondary</div>
                      <div style={{ fontSize:10, color:C.dim, marginBottom:2 }}>Assignment</div>
                      <div style={{ fontSize:11, color:C.green, fontWeight:600 }}>{secEntry ? `Target T${secEntry.targetId}` : "—"}</div>
                      <div style={{ fontSize:11, color:C.green, fontWeight:600 }}>{secEntry ? `Distance: ${secEntry.distance.toFixed(0)} cm` : ""}</div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      </div>

      {/* Config footer */}
      <div style={{ flexShrink:0, marginTop:10, padding:"10px 16px", background:C.gradientPanel, border:`1px solid ${C.border}`, borderRadius:8, display:"flex", gap:18, flexWrap:"wrap", alignItems:"center", boxShadow:"0 2px 8px rgba(0,0,0,0.25)" }}>
        <span style={{ fontSize:11, color:C.dim, letterSpacing:"0.05em" }}>ENGINE CONFIG — mirrors assignment_engine.py</span>
        {[
          { label:"Algorithm",     value:"priority_v2_antithrash",     col:C.green },
          { label:"Reassign Δ",   value:`>${REASSIGN_THRESHOLD}cm`,    col:C.gold },
          { label:"Stale TTL",    value:`${STALE_TTL/1000}s`,          col:C.purple },
          { label:"Priority",     value:"global P1 + queued P2/P3",     col:C.teal },
          { label:"Always drawn", value:"proximity line per target",    col:C.cyan },
        ].map(c => (
          <div key={c.label} style={{ fontSize:11 }}>
            <span style={{ color:C.dim }}>{c.label}: </span>
            <span style={{ color:c.col, fontWeight:600 }}>{c.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
