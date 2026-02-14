import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// WORLD CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const WW = 620, WH = 400;
const AGENT_COLORS = {
  Alice: "#00f5d4", Bob: "#fee440", Charlie: "#f15bb5", Diana: "#9b5de5",
};
const TARGET_COLOR = "#ff4d4d";
const REASSIGN_THRESHOLD = 2.5;
const STALE_TTL = 10000;

// ─────────────────────────────────────────────────────────────────────────────
// MATH — mirrors assignment_engine.py exactly
// ─────────────────────────────────────────────────────────────────────────────
const euclidean = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * computeDistanceMatrix()
 * Mirrors Python backend: returns both agent-centric and target-centric views,
 * each sorted nearest-first. This is the single source of truth for all distances.
 */
function computeDistanceMatrix(agents, targets) {
  const byAgent = {};
  for (const a of agents) {
    const row = {};
    for (const t of targets) row[t.id] = euclidean(a.position, t.position);
    byAgent[a.id] = Object.fromEntries(Object.entries(row).sort((x, y) => x[1] - y[1]));
  }
  const byTarget = {};
  for (const t of targets) {
    const row = {};
    for (const a of agents) row[a.id] = euclidean(t.position, a.position);
    byTarget[t.id] = Object.fromEntries(Object.entries(row).sort((x, y) => x[1] - y[1]));
  }
  return { byAgent, byTarget };
}

/**
 * runPriorityAssignment()
 * ─────────────────────────────────────────────────────────────────────────────
 * PRIORITY LOGIC:
 *   Each agent ranks all targets by distance → their personal priority list.
 *
 *   Phase 1 — PRIMARY claims:
 *     Every agent stakes a claim on their #1 (closest) target.
 *     Conflicts resolved by distance: closer agent wins.
 *     Losing agent's #1 target goes to the winner; loser falls to their #2.
 *     Anti-thrash: only reassign existing P1 if improvement > REASSIGN_THRESHOLD.
 *
 *   Phase 2 — SECONDARY coverage:
 *     Any target still without a primary gets assigned to the nearest available agent.
 *     Agents who lost a P1 conflict may cover a second target as secondary.
 *     One agent CAN hold both a primary AND a secondary simultaneously.
 *
 *   Proximity — ALWAYS drawn:
 *     For every target, record the geometrically closest agent regardless of
 *     assignment status. A proximity line is drawn even when that agent is
 *     already assigned to someone else.
 *
 * Returns:
 *   primary     { targetId → agentId }   solid line
 *   secondary   { targetId → agentId }   dashed line
 *   proximity   { targetId → agentId }   dotted line (always drawn)
 *   agentPriorities  { agentId → [{ targetId, distance, priority, role }] }
 *   matrix      { byAgent, byTarget }
 */
function runPriorityAssignment(agents, targets, prevPrimary, prevSecondary) {
  if (!agents.length || !targets.length) {
    return { primary: {}, secondary: {}, proximity: {}, agentPriorities: {}, matrix: { byAgent: {}, byTarget: {} } };
  }

  const matrix = computeDistanceMatrix(agents, targets);
  const { byAgent, byTarget } = matrix;

  // Build per-agent priority lists (sorted by distance)
  const priorityLists = {};
  for (const a of agents) {
    priorityLists[a.id] = Object.entries(byAgent[a.id] || {}).map(([tid, d], idx) => ({
      targetId: +tid, distance: d, priority: idx + 1,
    }));
  }

  // Proximity: geometrically closest agent per target (unconditional)
  const proximity = {};
  for (const t of targets) {
    const sorted = Object.entries(byTarget[t.id]);
    if (sorted.length) proximity[t.id] = sorted[0][0];
  }

  // ── Phase 1: P1 claims ────────────────────────────────────────────────────
  // Each agent claims their closest target. Conflicts → closer agent wins.
  const claims = {}; // targetId → [{ agentId, distance }]
  for (const a of agents) {
    const p1 = priorityLists[a.id]?.[0];
    if (!p1) continue;
    if (!claims[p1.targetId]) claims[p1.targetId] = [];
    claims[p1.targetId].push({ agentId: a.id, distance: p1.distance });
  }

  const primary = {};
  const agentPrimaryTarget = {}; // agentId → targetId they won

  for (const [tidStr, claimList] of Object.entries(claims)) {
    const tid = +tidStr;
    claimList.sort((a, b) => a.distance - b.distance);
    const winner = claimList[0];

    // Anti-thrash: keep old assignment unless new agent is significantly closer
    const prevAgentId = prevPrimary[tid];
    if (prevAgentId && prevAgentId !== winner.agentId) {
      const prevDist = byTarget[tid]?.[prevAgentId] ?? Infinity;
      const improvement = prevDist - winner.distance;
      if (improvement <= REASSIGN_THRESHOLD) {
        primary[tid] = prevAgentId;
        agentPrimaryTarget[prevAgentId] = tid;
        continue;
      }
    }
    primary[tid] = winner.agentId;
    agentPrimaryTarget[winner.agentId] = tid;
  }

  // Unclaimed targets (no agent chose them as #1) → give to nearest free agent
  for (const t of targets) {
    if (primary[t.id] !== undefined) continue;
    for (const [aid] of Object.entries(byTarget[t.id])) {
      if (!agentPrimaryTarget[aid]) {
        primary[t.id] = aid;
        agentPrimaryTarget[aid] = t.id;
        break;
      }
    }
  }

  // ── Phase 2: Secondary coverage ───────────────────────────────────────────
  // Targets still without any primary → secondary from nearest available agent.
  // Agents without a primary → they cover their nearest unowned target as secondary.
  const secondary = {};

  // Still-unassigned targets
  for (const t of targets) {
    if (primary[t.id] !== undefined) continue;
    for (const [aid] of Object.entries(byTarget[t.id])) {
      if (aid !== primary[t.id]) { secondary[t.id] = aid; break; }
    }
  }

  // Agents without a primary → try to cover a secondary
  for (const a of agents) {
    if (agentPrimaryTarget[a.id]) continue;
    for (const { targetId } of priorityLists[a.id] || []) {
      if (primary[targetId] !== undefined && !secondary[targetId] && primary[targetId] !== a.id) {
        secondary[targetId] = a.id;
        break;
      }
      if (primary[targetId] === undefined && !secondary[targetId]) {
        secondary[targetId] = a.id;
        break;
      }
    }
  }

  // Annotate priority lists with role
  const agentPriorities = {};
  for (const a of agents) {
    agentPriorities[a.id] = (priorityLists[a.id] || []).map(entry => {
      let role = "none";
      if (primary[entry.targetId] === a.id)    role = "primary";
      else if (secondary[entry.targetId] === a.id) role = "secondary";
      return { ...entry, role };
    });
  }

  return { primary, secondary, proximity, agentPriorities, matrix };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATION
// ─────────────────────────────────────────────────────────────────────────────
function randomWalk(pos, vel, speed) {
  let nx = pos.x + vel.vx, ny = pos.y + vel.vy;
  let nvx = vel.vx + (Math.random() - 0.5) * speed * 0.5;
  let nvy = vel.vy + (Math.random() - 0.5) * speed * 0.5;
  const spd = Math.hypot(nvx, nvy);
  if (spd > speed) { nvx = nvx / spd * speed; nvy = nvy / spd * speed; }
  if (nx < 14 || nx > WW - 14) nvx *= -1;
  if (ny < 14 || ny > WH - 14) nvy *= -1;
  return { pos: { x: clamp(nx, 14, WW - 14), y: clamp(ny, 14, WH - 14) }, vel: { vx: nvx, vy: nvy } };
}

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS RENDERER
// ─────────────────────────────────────────────────────────────────────────────
function drawScene(canvas, agents, targets, result, highlighted, now, showZones) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, WW, WH);
  ctx.fillStyle = "#05080e";
  ctx.fillRect(0, 0, WW, WH);
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 1;
  for (let x = 0; x < WW; x += 38) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WH); ctx.stroke(); }
  for (let y = 0; y < WH; y += 38) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WW, y); ctx.stroke(); }

  const { primary, secondary, proximity } = result;

  // Coverage zones
  if (showZones) {
    agents.forEach(a => {
      const c = AGENT_COLORS[a.id] || "#888888";
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      const grad = ctx.createRadialGradient(a.position.x, a.position.y, 0, a.position.x, a.position.y, 95);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.07)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(a.position.x, a.position.y, 95, 0, Math.PI * 2); ctx.fill();
    });
  }

  // ── 1. Proximity lines (dotted, faintest) — ALWAYS drawn ─────────────────
  for (const t of targets) {
    const proxId = proximity[t.id];
    if (!proxId) continue;
    // Skip if this agent is already drawing a primary or secondary line to this target
    if (primary[t.id] === proxId || secondary[t.id] === proxId) continue;
    const a = agents.find(x => x.id === proxId);
    if (!a) continue;
    const isHl = highlighted === proxId || highlighted === `t${t.id}`;
    const color = AGENT_COLORS[proxId] || "#888";
    ctx.save();
    ctx.globalAlpha = isHl ? 0.40 : 0.13;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 9]);
    ctx.beginPath(); ctx.moveTo(t.position.x, t.position.y); ctx.lineTo(a.position.x, a.position.y); ctx.stroke();
    ctx.setLineDash([]);
    if (isHl) {
      const mx = (t.position.x + a.position.x) / 2, my = (t.position.y + a.position.y) / 2;
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = color;
      ctx.font = "8px 'JetBrains Mono',monospace";
      ctx.fillText(`near · ${euclidean(t.position, a.position).toFixed(0)}m`, mx + 3, my + 14);
    }
    ctx.restore();
  }

  // ── 2. Secondary lines (dashed, medium weight) ───────────────────────────
  for (const [tidStr, aId] of Object.entries(secondary)) {
    const t = targets.find(x => x.id === +tidStr);
    const a = agents.find(x => x.id === aId);
    if (!t || !a) continue;
    const isHl = highlighted === aId || highlighted === `t${t.id}`;
    const color = AGENT_COLORS[aId] || "#888";
    const d = euclidean(t.position, a.position);
    ctx.save();
    ctx.globalAlpha = isHl ? 0.80 : 0.30;
    ctx.strokeStyle = color;
    ctx.lineWidth = isHl ? 2 : 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(t.position.x, t.position.y); ctx.lineTo(a.position.x, a.position.y); ctx.stroke();
    ctx.setLineDash([]);
    const mx = (t.position.x + a.position.x) / 2, my = (t.position.y + a.position.y) / 2;
    ctx.globalAlpha = isHl ? 0.95 : 0.45;
    ctx.fillStyle = color;
    ctx.font = "8px 'JetBrains Mono',monospace";
    ctx.fillText(`P2·${d.toFixed(0)}m`, mx + 3, my + 10);
    ctx.restore();
  }

  // ── 3. Primary lines (solid, bold, glowing) ───────────────────────────────
  for (const [tidStr, aId] of Object.entries(primary)) {
    const t = targets.find(x => x.id === +tidStr);
    const a = agents.find(x => x.id === aId);
    if (!t || !a) continue;
    const isHl = highlighted === aId || highlighted === `t${t.id}`;
    const color = AGENT_COLORS[aId] || "#888";
    const d = euclidean(t.position, a.position);
    ctx.save();
    ctx.globalAlpha = isHl ? 1.0 : 0.68;
    ctx.strokeStyle = color;
    ctx.lineWidth = isHl ? 3 : 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = isHl ? 12 : 5;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(t.position.x, t.position.y); ctx.lineTo(a.position.x, a.position.y); ctx.stroke();
    ctx.shadowBlur = 0;
    const mx = (t.position.x + a.position.x) / 2, my = (t.position.y + a.position.y) / 2;
    ctx.globalAlpha = isHl ? 1.0 : 0.85;
    ctx.fillStyle = color;
    ctx.font = "bold 9px 'JetBrains Mono',monospace";
    ctx.fillText(`P1·${d.toFixed(0)}m`, mx + 3, my - 4);
    ctx.restore();
  }

  // ── Targets ───────────────────────────────────────────────────────────────
  for (const t of targets) {
    const isHl = highlighted === `t${t.id}`;
    const hasPrim = primary[t.id] !== undefined;
    const hasSec  = secondary[t.id] !== undefined;
    const age = (now - t.lastSeen) / STALE_TTL;
    const alpha = Math.max(0.2, 1 - age * 0.8);
    const pulse = 0.5 + 0.5 * Math.sin(now / 380 + t.id * 1.4);
    const r = 7 + pulse * 2;

    ctx.save();
    ctx.globalAlpha = alpha * 0.2 * pulse;
    ctx.beginPath(); ctx.arc(t.position.x, t.position.y, r + 10 * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = isHl ? "#fff" : TARGET_COLOR;
    ctx.lineWidth = isHl ? 2 : 1;
    ctx.stroke();

    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(t.position.x, t.position.y, r, 0, Math.PI * 2);
    ctx.fillStyle = hasPrim ? TARGET_COLOR : hasSec ? "#e07030" : "#601818";
    ctx.fill();
    ctx.strokeStyle = isHl ? "#fff" : "rgba(255,255,255,0.55)";
    ctx.lineWidth = isHl ? 2 : 1.2;
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1.5;
    [-1, 1].forEach(s => {
      ctx.beginPath(); ctx.moveTo(t.position.x + s * 13, t.position.y); ctx.lineTo(t.position.x + s * (r + 1), t.position.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(t.position.x, t.position.y + s * 13); ctx.lineTo(t.position.x, t.position.y + s * (r + 1)); ctx.stroke();
    });

    ctx.fillStyle = "#fff";
    ctx.font = `bold ${isHl ? 12 : 10}px 'JetBrains Mono',monospace`;
    ctx.fillText(`T${t.id}`, t.position.x + r + 4, t.position.y - 3);

    // Status badge: P1 | P2 | !!
    const badge = hasPrim ? "P1" : hasSec ? "P2" : "!!";
    const badgeCol = hasPrim ? "#4ade80" : hasSec ? "#fee440" : "#ff4d4d";
    ctx.fillStyle = "rgba(0,0,0,0.75)"; ctx.fillRect(t.position.x + r + 2, t.position.y + 4, 18, 11);
    ctx.fillStyle = badgeCol; ctx.font = "bold 8px 'JetBrains Mono',monospace";
    ctx.fillText(badge, t.position.x + r + 4, t.position.y + 13);

    // Confidence bar
    const bw = 24;
    ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.fillRect(t.position.x - bw / 2, t.position.y + r + 3, bw, 3);
    ctx.fillStyle = `hsl(${120 * t.confidence},85%,55%)`; ctx.fillRect(t.position.x - bw / 2, t.position.y + r + 3, bw * t.confidence, 3);
    ctx.restore();
  }

  // ── Agents ────────────────────────────────────────────────────────────────
  for (const a of agents) {
    const color = AGENT_COLORS[a.id] || "#888";
    const isHl = highlighted === a.id;
    const r = isHl ? 13 : 10;
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = isHl ? 28 : 12;
    ctx.beginPath(); ctx.arc(a.position.x, a.position.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    if (isHl) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#000"; ctx.font = `bold ${isHl ? 11 : 9}px 'JetBrains Mono',monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(a.id[0], a.position.x, a.position.y);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = color; ctx.font = `bold ${isHl ? 12 : 10}px 'JetBrains Mono',monospace`;
    ctx.fillText(a.id, a.position.x + r + 4, a.position.y - 4);
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
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
                        {/* Show their active roles */}
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
                            {/* Distance bar */}
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