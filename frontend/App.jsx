import { useState, useEffect, useRef, useCallback } from "react";
import { WW, WH, AGENT_COLORS, TARGET_COLOR, REASSIGN_THRESHOLD, STALE_TTL } from "./config.js";
import { euclidean, randomWalk } from "./utils.js";
import { runPriorityAssignment } from "./assignment.js";
import { drawScene } from "./canvas.js";

export default function App() {
  const canvasRef = useRef(null);
  const stateRef  = useRef(null);
  const animRef   = useRef(null);

  const [ui, setUi]           = useState(null);
  const [result, setResult]   = useState({
    primary: {}, secondary: {}, proximity: {}, agentPriorities: {},
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

  const addEvent = useCallback((msg, type = "info") =>
    setEvents(prev => [{ msg, type, ts: Date.now() }, ...prev.slice(0, 59)]), []);

  // Init
  useEffect(() => {
    const now = Date.now();
    stateRef.current = {
      agents: [
        { id: "Alice",   position: { x: 80,  y: 80  }, vel: { vx:  1.1, vy:  0.6 } },
        { id: "Bob",     position: { x: 520, y: 70  }, vel: { vx: -0.9, vy:  1.0 } },
        { id: "Charlie", position: { x: 320, y: 310 }, vel: { vx:  0.4, vy: -1.1 } },
        { id: "Diana",   position: { x: 100, y: 300 }, vel: { vx:  1.0, vy: -0.5 } },
      ],
      targets: [
        { id: 1, position: { x: 190, y: 140 }, vel: { vx:  1.4, vy:  0.7  }, confidence: 0.93, lastSeen: now },
        { id: 2, position: { x: 430, y: 210 }, vel: { vx: -1.1, vy:  0.9  }, confidence: 0.81, lastSeen: now },
        { id: 3, position: { x: 300, y: 170 }, vel: { vx:  0.7, vy: -1.4  }, confidence: 0.67, lastSeen: now },
      ],
      prevPrimary: {}, prevSecondary: {}, nextId: 4,
    };
    addEvent("System online — 4 agents, 3 targets", "system");
  }, []);

  // Loop
  useEffect(() => {
    if (!stateRef.current) return;
    let lastT = performance.now(), tickN = 0;
    function loop(now) {
      animRef.current = requestAnimationFrame(loop);
      if (paused || now - lastT < 50) return;
      lastT = now; tickN++;
      const s = stateRef.current;
      if (!frozen) {
        s.agents = s.agents.map(a => { const r = randomWalk(a.position, a.vel, 1.6); return { ...a, position: r.pos, vel: r.vel }; });
      }
      s.targets = s.targets.map(t => { const r = randomWalk(t.position, t.vel, 2.0); return { ...t, position: r.pos, vel: r.vel, lastSeen: Date.now() }; });
      const res = runPriorityAssignment(s.agents, s.targets, s.prevPrimary, s.prevSecondary);
      for (const [tid, aid] of Object.entries(res.primary)) {
        if (s.prevPrimary[tid] && s.prevPrimary[tid] !== aid) {
          addEvent(`↩ P1 T${tid}: ${s.prevPrimary[tid]} → ${aid}`, "reassign");
          setRC(c => c + 1);
        }
      }
      s.prevPrimary = { ...res.primary }; s.prevSecondary = { ...res.secondary };
      const canvas = canvasRef.current;
      if (canvas) drawScene(canvas, s.agents, s.targets, res, hl, Date.now(), showZones);
      setTick(tickN); setResult(res);
      setUi({ agents: [...s.agents], targets: [...s.targets] });
    }
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [paused, frozen, hl, showZones, addEvent]);

  const onCanvasClick = e => {
    if (!stateRef.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    for (const a of stateRef.current.agents) {
      if (euclidean({ x: px, y: py }, a.position) < 18) { setHL(h => h === a.id ? null : a.id); return; }
    }
    for (const t of stateRef.current.targets) {
      if (euclidean({ x: px, y: py }, t.position) < 16) { setHL(h => h === `t${t.id}` ? null : `t${t.id}`); return; }
    }
    setHL(null);
  };

  const spawn = () => {
    const s = stateRef.current; if (!s) return;
    const id = s.nextId++;
    s.targets.push({ id, position: { x: 50 + Math.random() * 520, y: 30 + Math.random() * 340 },
      vel: { vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3 },
      confidence: 0.5 + Math.random() * 0.5, lastSeen: Date.now() });
    addEvent(`🔴 T${id} detected — priorities recomputing…`, "spawn");
  };
  const neutralise = () => {
    const s = stateRef.current; if (!s || !s.targets.length) return;
    const t = s.targets.splice(Math.floor(Math.random() * s.targets.length), 1)[0];
    delete s.prevPrimary[t.id]; delete s.prevSecondary[t.id];
    addEvent(`✅ T${t.id} neutralised`, "remove");
  };
  const scatter = () => {
    const s = stateRef.current; if (!s) return;
    s.agents  = s.agents.map(a  => ({ ...a,  position: { x: 30 + Math.random() * 560, y: 30 + Math.random() * 340 } }));
    s.targets = s.targets.map(t => ({ ...t,  position: { x: 30 + Math.random() * 560, y: 30 + Math.random() * 340 }, lastSeen: Date.now() }));
    s.prevPrimary = {}; s.prevSecondary = {};
    addEvent("⚡ Scattered — full priority recalculation!", "reassign");
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const agents   = ui?.agents  || [];
  const targets  = ui?.targets || [];
  const unassigned = targets.filter(t => result.primary[t.id] === undefined && result.secondary[t.id] === undefined);

  const C = {
    bg:"#05080e", panel:"#080c14", border:"#141e2e",
    text:"#b0c8d8", dim:"#2e4858", bright:"#e4f0f8",
    teal:"#00f5d4", yellow:"#fee440", pink:"#f15bb5",
    purple:"#9b5de5", green:"#4ade80", red:"#ff4d4d", orange:"#ff9f43",
  };

  const TabBtn = ({ id, label }) => (
    <button onClick={() => setTab(id)} style={{
      background: tab === id ? C.panel : "transparent",
      border: `1px solid ${tab === id ? C.border : "transparent"}`,
      borderBottom: tab === id ? `1px solid ${C.panel}` : `1px solid ${C.border}`,
      color: tab === id ? C.bright : C.dim, padding: "5px 12px", cursor: "pointer",
      fontSize: 9, fontFamily: "'JetBrains Mono',monospace", letterSpacing: "0.08em",
      borderRadius: "4px 4px 0 0", marginBottom: -1, transition: "all 0.15s",
    }}>{label}</button>
  );

  // Matrix rows for display
  const matrixRows = targets.map(t => ({
    targetId: t.id,
    row: agents.map(a => ({
      agentId: a.id,
      d: result.matrix.byTarget?.[t.id]?.[a.id] ?? euclidean(t.position, a.position),
      isPrim: result.primary[t.id] === a.id,
      isSec:  result.secondary[t.id] === a.id,
      isProx: result.proximity[t.id] === a.id && result.primary[t.id] !== a.id && result.secondary[t.id] !== a.id,
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
    ],
    proximity: Object.entries(result.proximity).map(([tid, aid]) => ({ target_id: +tid, closest_agent: aid })),
    unassigned_targets: unassigned.map(t => t.id),
    algorithm: "v2_priority_antithrash",
    timestamp: Date.now(),
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily:"'JetBrains Mono','Courier New',monospace", background:C.bg, minHeight:"100vh", color:C.text, padding:14, boxSizing:"border-box" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;700&display=swap');
        * { box-sizing:border-box; }
        ::-webkit-scrollbar { width:3px; height:3px; }
        ::-webkit-scrollbar-thumb { background:#1a2a3a; border-radius:2px; }
        @keyframes fadeIn { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:none} }
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:0.45} }
        button:hover { filter:brightness(1.18); }
      `}</style>

      {/* ── Header ── */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10, flexWrap:"wrap", gap:8 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:700, letterSpacing:"0.15em", color:C.teal }}>◈ PRIORITY ASSIGNMENT ENGINE</div>
          <div style={{ fontSize:9, color:C.dim, letterSpacing:"0.1em", marginTop:2 }}>DISTANCE-BASED PRIORITY · P1 SOLID · P2 DASHED · PROXIMITY DOTTED · V2 ANTI-THRASH</div>
        </div>
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
          {[
            { label: paused ? "▶ RESUME" : "⏸ PAUSE",  onClick: () => setPaused(p=>!p), active: paused, ac: C.green },
            { label: frozen ? "▶ UNFREEZE" : "⬛ FREEZE", onClick: () => { setFrozen(f=>!f); addEvent(frozen?"▶ Moving":"⬛ Frozen","system"); }, active: frozen, ac: C.purple },
            { label: "◎ ZONES", onClick: () => setZones(z=>!z), active: showZones, ac: C.purple },
          ].map(b => (
            <button key={b.label} onClick={b.onClick} style={{
              background: b.active ? "#120e1e" : "#0e1620",
              border: `1px solid ${b.active ? b.ac + "80" : C.border}`,
              color: b.active ? b.ac : C.dim,
              padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"inherit",
            }}>{b.label}</button>
          ))}
          <button onClick={spawn} style={{ background:"#180e0e", border:`1px solid #4a1010`, color:"#ff6b6b", padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"inherit" }}>⊕ SPAWN</button>
          <button onClick={neutralise} style={{ background:"#0a160e", border:`1px solid #1a4020`, color:C.green, padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"inherit" }}>⊘ NEUTRALISE</button>
          <button onClick={scatter} style={{ background:"#12100a", border:`1px solid #3a3010`, color:C.yellow, padding:"6px 12px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"inherit" }}>⚡ SCATTER</button>
          <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:4, padding:"6px 10px", fontSize:9, color:C.dim, display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ color:paused?C.orange:C.green, animation:paused?"none":"pulse 1.5s infinite" }}>●</span>
            {String(tick).padStart(4,"0")} <span style={{ color:C.dim }}>|</span> <span style={{ color:rCount?C.yellow:C.dim }}>↩{rCount}</span>
          </div>
        </div>
      </div>

      {/* ── Line Legend ── */}
      <div style={{ display:"flex", gap:14, marginBottom:10, padding:"7px 12px", background:C.panel, border:`1px solid ${C.border}`, borderRadius:6, flexWrap:"wrap", alignItems:"center" }}>
        <span style={{ fontSize:9, color:C.dim, letterSpacing:"0.08em" }}>LINE KEY:</span>
        {[
          { stroke:"#aaa", dash:"", w:2.5,  label:"P1 Primary — solid · closest agent wins" },
          { stroke:"#aaa", dash:"5,4", w:1.5, label:"P2 Secondary — dashed · next-best agent" },
          { stroke:"#aaa", dash:"2,8", w:1.0, label:"Proximity only — always drawn · not assigned" },
        ].map(({ stroke, dash, w, label }) => (
          <div key={label} style={{ display:"flex", alignItems:"center", gap:6 }}>
            <svg width="30" height="8" style={{ flexShrink:0 }}>
              <line x1="0" y1="4" x2="30" y2="4" stroke={stroke} strokeWidth={w} strokeDasharray={dash} opacity={dash==="2,8"?"0.4":"0.85"}/>
            </svg>
            <span style={{ fontSize:9, color:C.text }}>{label}</span>
          </div>
        ))}
        <div style={{ marginLeft:"auto", display:"flex", gap:10 }}>
          {[{ bg:TARGET_COLOR, label:"P1 assigned" }, { bg:"#e07030", label:"P2 only" }, { bg:"#601818", label:"Unassigned" }].map(x=>(
            <div key={x.label} style={{ display:"flex", alignItems:"center", gap:4 }}>
              <div style={{ width:9, height:9, borderRadius:"50%", background:x.bg }}/><span style={{ fontSize:9, color:C.text }}>{x.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main grid ── */}
      <div style={{ display:"grid", gridTemplateColumns:`${WW}px 1fr`, gap:12, alignItems:"start" }}>

        {/* Canvas column */}
        <div>
          <canvas ref={canvasRef} width={WW} height={WH} onClick={onCanvasClick}
            style={{ display:"block", border:`1px solid ${C.border}`, borderRadius:6, cursor:"crosshair" }}/>
          <div style={{ display:"flex", gap:10, marginTop:8, padding:"7px 10px", background:C.panel, border:`1px solid ${C.border}`, borderRadius:6, flexWrap:"wrap" }}>
            <span style={{ fontSize:9, color:C.dim }}>CLICK TO HIGHLIGHT:</span>
            {agents.map(a => (
              <div key={a.id} onClick={() => setHL(h => h === a.id ? null : a.id)}
                style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", opacity:hl && hl!==a.id?0.35:1, transition:"opacity 0.2s" }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:AGENT_COLORS[a.id], boxShadow:`0 0 6px ${AGENT_COLORS[a.id]}` }}/>
                <span style={{ fontSize:9, color:hl===a.id?AGENT_COLORS[a.id]:C.text }}>{a.id}</span>
              </div>
            ))}
            <span style={{ fontSize:9, color:C.dim, marginLeft:"auto" }}>or click target crosshair</span>
          </div>
        </div>

        {/* Right panel */}
        <div style={{ display:"flex", flexDirection:"column", gap:0 }}>

          {/* Summary row */}
          <div style={{ display:"flex", background:C.panel, border:`1px solid ${C.border}`, borderRadius:"6px 6px 0 0", borderBottom:"none" }}>
            {[
              { label:"P1 ASSIGNED",  val:Object.keys(result.primary).length,   col:C.green },
              { label:"P2 COVERAGE",  val:Object.keys(result.secondary).length,  col:C.yellow },
              { label:"UNASSIGNED",   val:unassigned.length,                     col:unassigned.length?C.red:C.dim },
              { label:"TOTAL TARGETS",val:targets.length,                        col:C.teal },
              { label:"REASSIGNS",    val:rCount,                                col:rCount?C.orange:C.dim },
            ].map(s => (
              <div key={s.label} style={{ flex:1, textAlign:"center", padding:"9px 4px", borderRight:`1px solid ${C.border}` }}>
                <div style={{ fontSize:20, fontWeight:700, color:s.col, lineHeight:1 }}>{s.val}</div>
                <div style={{ fontSize:7, color:C.dim, letterSpacing:"0.07em", marginTop:2 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div style={{ borderBottom:`1px solid ${C.border}`, display:"flex", paddingLeft:8, background:"#060a10" }}>
            <TabBtn id="priority" label="🎯 PRIORITIES"/>
            <TabBtn id="matrix"   label="📊 MATRIX"/>
            <TabBtn id="json"     label="{ } JSON"/>
            <TabBtn id="log"      label="📋 LOG"/>
          </div>

          {/* Tab body */}
          <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderTop:"none", borderRadius:"0 0 6px 6px", padding:12, minHeight:290, maxHeight:370, overflow:"auto" }}>

            {/* PRIORITY TAB */}
            {tab === "priority" && (
              <div>
                <div style={{ fontSize:9, color:C.dim, letterSpacing:"0.08em", marginBottom:10 }}>
                  Each agent's targets ranked by distance. P1 = closest (solid line). P2 = second-closest (dashed).
                  Role shown: ✓ P1 assigned · ~ P2 secondary · — not assigned.
                </div>
                {agents.map(agent => {
                  const color  = AGENT_COLORS[agent.id] || "#888";
                  const isHl   = hl === agent.id;
                  const prList = result.agentPriorities[agent.id] || [];
                  return (
                    <div key={agent.id} onClick={() => setHL(h => h === agent.id ? null : agent.id)}
                      style={{ marginBottom:8, padding:"8px 10px", borderRadius:5, cursor:"pointer",
                        border:`1px solid ${isHl?color:C.border}`,
                        background: isHl?"#0a1422":"#060a10",
                        boxShadow: isHl?`0 0 10px ${color}25`:"none", transition:"all 0.2s" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                        <div style={{ width:9, height:9, borderRadius:"50%", background:color, boxShadow:`0 0 6px ${color}` }}/>
                        <span style={{ color, fontWeight:700, fontSize:11 }}>{agent.id}</span>
                        <span style={{ fontSize:8, color:C.dim, marginLeft:4 }}>pos ({agent.position.x.toFixed(0)}, {agent.position.y.toFixed(0)})</span>
                        <span style={{ marginLeft:"auto", display:"flex", gap:4 }}>
                          {prList.find(e=>e.role==="primary") && <span style={{ fontSize:8, color:C.green, border:`1px solid ${C.green}50`, borderRadius:3, padding:"1px 5px" }}>P1 ✓</span>}
                          {prList.find(e=>e.role==="secondary") && <span style={{ fontSize:8, color:C.yellow, border:`1px solid ${C.yellow}50`, borderRadius:3, padding:"1px 5px" }}>P2 ~</span>}
                        </span>
                      </div>
                      {prList.length === 0 ? <div style={{ fontSize:9, color:C.dim }}>No targets</div>
                        : prList.map(({ targetId, distance, priority, role }) => (
                          <div key={targetId} style={{
                            display:"flex", alignItems:"center", gap:6, padding:"3px 0",
                            borderBottom:`1px solid ${C.border}`, opacity:priority > 4 ? 0.4 : 1,
                          }}>
                            <span style={{ minWidth:18, fontSize:9, fontWeight:700,
                              color:priority===1?C.green:priority===2?C.yellow:C.dim }}>P{priority}</span>
                            <span style={{ background:TARGET_COLOR, color:"#000", fontSize:8, fontWeight:700, padding:"1px 5px", borderRadius:2 }}>T{targetId}</span>
                            <div style={{ flex:1, height:4, background:"#0a1018", borderRadius:2, overflow:"hidden" }}>
                              <div style={{
                                height:"100%", borderRadius:2, transition:"width 0.15s",
                                width:`${Math.max(4, Math.min(100, 100 - distance * 0.16))}%`,
                                background: role==="primary"?C.green:role==="secondary"?C.yellow:C.dim+"80",
                              }}/>
                            </div>
                            <span style={{ fontSize:9, color:C.dim, minWidth:36, textAlign:"right" }}>{distance.toFixed(0)}m</span>
                            <span style={{ minWidth:30, fontSize:8, fontWeight:700, textAlign:"center",
                              color:role==="primary"?C.green:role==="secondary"?C.yellow:C.dim,
                              border:`1px solid ${role==="primary"?C.green+"40":role==="secondary"?C.yellow+"40":"transparent"}`,
                              borderRadius:3, padding:"1px 4px",
                            }}>
                              {role==="primary"?"✓ P1":role==="secondary"?"~ P2":"—"}
                            </span>
                          </div>
                        ))
                      }
                    </div>
                  );
                })}
              </div>
            )}

            {/* MATRIX TAB */}
            {tab === "matrix" && (
              <div>
                <div style={{ fontSize:9, color:C.dim, marginBottom:6 }}>
                  Full distance matrix (metres). <span style={{ color:C.green }}>Green✓ = P1</span> · <span style={{ color:C.yellow }}>Yellow~ = P2</span> · <span style={{ color:C.teal }}>Teal● = proximity (closest, not assigned)</span>
                </div>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10 }}>
                  <thead>
                    <tr>
                      <th style={{ color:C.dim, padding:"4px 8px", textAlign:"left", borderBottom:`1px solid ${C.border}`, fontWeight:400, fontSize:9 }}>Target</th>
                      {agents.map(a => (
                        <th key={a.id} style={{ color:AGENT_COLORS[a.id], padding:"4px 8px", textAlign:"center", borderBottom:`1px solid ${C.border}`, fontWeight:700, fontSize:9 }}>{a.id[0]}</th>
                      ))}
                      <th style={{ color:C.dim, padding:"4px 8px", textAlign:"left", borderBottom:`1px solid ${C.border}`, fontWeight:400, fontSize:9 }}>Assigned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrixRows.map(({ targetId, row }) => {
                      const primAgent = result.primary[targetId];
                      const secAgent  = result.secondary[targetId];
                      return (
                        <tr key={targetId}
                          style={{ background:hl===`t${targetId}`?"#0a1422":"transparent", cursor:"pointer" }}
                          onClick={() => setHL(h => h===`t${targetId}`?null:`t${targetId}`)}>
                          <td style={{ padding:"4px 8px", borderBottom:`1px solid ${C.border}`, color:TARGET_COLOR, fontWeight:700 }}>T{targetId}</td>
                          {agents.map(a => {
                            const cell = row.find(r => r.agentId === a.id);
                            const { d, isPrim, isSec, isProx } = cell || { d:0, isPrim:false, isSec:false, isProx:false };
                            return (
                              <td key={a.id} style={{
                                padding:"4px 8px", textAlign:"center", borderBottom:`1px solid ${C.border}`,
                                color: isPrim?C.green:isSec?C.yellow:isProx?C.teal:C.dim,
                                fontWeight: isPrim||isSec?700:400,
                                background: isPrim?"rgba(74,222,128,0.08)":isSec?"rgba(254,228,64,0.06)":"transparent",
                                fontSize:10,
                              }}>
                                {isProx?"●":""}{d.toFixed(0)}{isPrim?"✓":isSec?"~":""}
                              </td>
                            );
                          })}
                          <td style={{ padding:"4px 8px", borderBottom:`1px solid ${C.border}`, fontSize:9 }}>
                            {primAgent
                              ? <span style={{ color:AGENT_COLORS[primAgent], fontWeight:700 }}>{primAgent} <span style={{ color:C.green }}>P1</span></span>
                              : secAgent
                              ? <span style={{ color:AGENT_COLORS[secAgent] }}>{secAgent} <span style={{ color:C.yellow }}>P2</span></span>
                              : <span style={{ color:C.red }}>NONE</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop:8, fontSize:9, color:C.dim, lineHeight:1.7 }}>
                  Anti-thrash: P1 only reassigns if improvement &gt; <span style={{ color:C.yellow }}>{REASSIGN_THRESHOLD}m</span>.
                  Proximity line drawn even when closest agent is busy with another primary.
                </div>
              </div>
            )}

            {/* JSON TAB */}
            {tab === "json" && (
              <div>
                <div style={{ fontSize:9, color:C.dim, letterSpacing:"0.08em", marginBottom:8 }}>
                  Live output payload — mirrors <code style={{ color:C.teal }}>assignment_engine.get_output()</code> · sent to Person 4 via WebSocket
                </div>
                <pre style={{ margin:0, fontSize:9, color:"#7ab0c8", lineHeight:1.7, background:"#040710", padding:10, borderRadius:4, border:`1px solid ${C.border}`, overflow:"auto", maxHeight:300 }}>
                  {JSON.stringify(jsonPayload, null, 2)}
                </pre>
              </div>
            )}

            {/* LOG TAB */}
            {tab === "log" && (
              <div>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                  <div style={{ fontSize:9, color:C.dim, letterSpacing:"0.08em" }}>EVENT LOG</div>
                  <button onClick={() => setEvents([])} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.dim, padding:"2px 8px", borderRadius:3, cursor:"pointer", fontSize:9, fontFamily:"inherit" }}>CLEAR</button>
                </div>
                {events.length === 0 && <div style={{ fontSize:10, color:C.dim, animation:"pulse 2s infinite" }}>Awaiting events…</div>}
                {events.map((e, i) => (
                  <div key={e.ts + i} style={{
                    fontSize:10, padding:"3px 0", borderBottom:`1px solid ${C.border}`,
                    color:e.type==="reassign"?C.yellow:e.type==="spawn"?C.red:e.type==="remove"?C.green:C.dim,
                    opacity:Math.max(0.25, 1 - i * 0.04),
                    animation:i===0?"fadeIn 0.2s ease":"none",
                  }}>{e.msg}</div>
                ))}
              </div>
            )}
          </div>

          {/* ── Per-agent cards ── */}
          <div style={{ marginTop:10, display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
            {agents.map(agent => {
              const color  = AGENT_COLORS[agent.id] || "#888";
              const isHl   = hl === agent.id;
              const prList = result.agentPriorities[agent.id] || [];
              const p1     = prList[0];
              const p2     = prList[1];
              const myPrimRole = prList.find(e => e.role === "primary");
              const mySecRole  = prList.find(e => e.role === "secondary");
              return (
                <div key={agent.id} onClick={() => setHL(h => h === agent.id ? null : agent.id)}
                  style={{ background:isHl?"#0e1825":C.panel, border:`1px solid ${isHl?color:C.border}`,
                    borderRadius:5, padding:"8px 10px", cursor:"pointer",
                    boxShadow:isHl?`0 0 12px ${color}30`:"none", transition:"all 0.2s" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:5 }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", background:color, boxShadow:`0 0 6px ${color}` }}/>
                    <span style={{ color, fontWeight:700, fontSize:11 }}>{agent.id}</span>
                    <span style={{ marginLeft:"auto", fontSize:8, color:C.dim }}>{agent.position.x.toFixed(0)},{agent.position.y.toFixed(0)}</span>
                  </div>
                  {[
                    { rank:"P1", entry:p1, role:myPrimRole, roleCol:C.green, roleLabel:"ASSIGNED", notLabel:"lost conflict" },
                    { rank:"P2", entry:p2, role:mySecRole,  roleCol:C.yellow, roleLabel:"SECONDARY", notLabel:"—" },
                  ].map(({ rank, entry, role, roleCol, roleLabel, notLabel }) => (
                    <div key={rank} style={{ display:"flex", alignItems:"center", gap:4, marginBottom:2 }}>
                      <span style={{ fontSize:8, color:rank==="P1"?C.green:C.yellow, fontWeight:700, minWidth:16 }}>{rank}</span>
                      {entry ? (
                        <>
                          <span style={{ background:TARGET_COLOR, color:"#000", fontSize:8, fontWeight:700, padding:"1px 4px", borderRadius:2 }}>T{entry.targetId}</span>
                          <span style={{ fontSize:8, color:C.dim }}>{entry.distance.toFixed(0)}m</span>
                          <span style={{ marginLeft:"auto", fontSize:8, color:role?.targetId===entry.targetId?roleCol:C.dim }}>
                            {role?.targetId === entry.targetId ? roleLabel : notLabel}
                          </span>
                        </>
                      ) : <span style={{ fontSize:8, color:C.dim }}>—</span>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {unassigned.length > 0 && (
            <div style={{ marginTop:8, padding:"8px 12px", background:"#150808", border:`1px solid ${C.red}40`, borderRadius:5, fontSize:10, animation:"fadeIn 0.3s ease" }}>
              <span style={{ color:C.red, fontWeight:700 }}>⚠ COVERAGE GAP — </span>
              <span style={{ color:C.text }}>Targets {unassigned.map(t=>`T${t.id}`).join(", ")} unassigned. All agents at capacity.</span>
            </div>
          )}
        </div>
      </div>

      {/* Config footer */}
      <div style={{ marginTop:10, padding:"8px 14px", background:C.panel, border:`1px solid ${C.border}`, borderRadius:6, display:"flex", gap:18, flexWrap:"wrap", alignItems:"center" }}>
        <span style={{ fontSize:9, color:C.dim, letterSpacing:"0.1em" }}>ENGINE CONFIG — mirrors assignment_engine.py</span>
        {[
          { label:"Algorithm",     value:"priority_v2_antithrash",     col:C.green },
          { label:"Reassign Δ",   value:`>${REASSIGN_THRESHOLD}m`,     col:C.yellow },
          { label:"Stale TTL",    value:`${STALE_TTL/1000}s`,          col:C.purple },
          { label:"Priority",     value:"per-agent distance rank",      col:C.teal },
          { label:"Always drawn", value:"proximity line per target",    col:C.text },
        ].map(c => (
          <div key={c.label} style={{ fontSize:9 }}>
            <span style={{ color:C.dim }}>{c.label}: </span>
            <span style={{ color:c.col, fontWeight:700 }}>{c.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
