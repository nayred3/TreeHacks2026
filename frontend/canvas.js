/**
 * Canvas renderer — P1 (solid), P2 (dashed), Proximity (dotted)
 * Supports HiDPI/Retina displays via devicePixelRatio scaling.
 */

import { euclidean } from "./utils.js";
import { WW, WH, AGENT_COLORS, TARGET_COLOR, STALE_TTL } from "./config.js";

/**
 * Prepare the canvas for HiDPI rendering.
 * Sets the internal buffer to dpr × CSS size, then scales the context.
 * Call once per frame before drawing (checks are cheap, only resizes when needed).
 */
function prepareHiDPI(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const needsResize = canvas.width !== WW * dpr || canvas.height !== WH * dpr;
  if (needsResize) {
    canvas.width = WW * dpr;
    canvas.height = WH * dpr;
    canvas.style.width = WW + "px";
    canvas.style.height = WH + "px";
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function drawScene(canvas, agents, targets, result, highlighted, now, showZones, schematicImage) {
  const ctx = prepareHiDPI(canvas);
  ctx.clearRect(0, 0, WW, WH);
  ctx.fillStyle = "#05080e";
  ctx.fillRect(0, 0, WW, WH);

  // Schematic overlay
  if (schematicImage) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.drawImage(schematicImage, 0, 0, WW, WH);
    ctx.restore();
  }

  // Grid
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 1;
  for (let x = 0; x < WW; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WH); ctx.stroke();
  }
  for (let y = 0; y < WH; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WW, y); ctx.stroke();
  }

  const { primary, agentSecondary, proximity } = result;

  // Coverage zones
  if (showZones) {
    agents.forEach((a) => {
      const c = AGENT_COLORS[a.id] || "#888888";
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      const grad = ctx.createRadialGradient(a.position.x, a.position.y, 0, a.position.x, a.position.y, 120);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.07)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(a.position.x, a.position.y, 120, 0, Math.PI * 2); ctx.fill();
    });
  }

  // Proximity lines (faint dotted — shown on hover only)
  for (const t of targets) {
    const proxId = proximity[t.id];
    if (!proxId) continue;
    if (primary[t.id] === proxId || agentSecondary[proxId] === t.id) continue;
    const a = agents.find((x) => x.id === proxId);
    if (!a) continue;
    const isHl = highlighted === proxId || highlighted === `t${t.id}`;
    if (!isHl) continue;
    const color = AGENT_COLORS[proxId] || "#888";
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 9]);
    ctx.beginPath(); ctx.moveTo(t.position.x, t.position.y); ctx.lineTo(a.position.x, a.position.y); ctx.stroke();
    ctx.setLineDash([]);
    const mx = (t.position.x + a.position.x) / 2;
    const my = (t.position.y + a.position.y) / 2;
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = color;
    ctx.font = "9px 'JetBrains Mono',monospace";
    ctx.fillText(`near · ${euclidean(t.position, a.position).toFixed(0)}m`, mx + 3, my + 14);
    ctx.restore();
  }

  // Secondary lines (dashed) — one per agent from agentSecondary
  for (const [aId, tid] of Object.entries(agentSecondary)) {
    const a = agents.find((x) => x.id === aId);
    const t = targets.find((x) => x.id === tid);
    if (!t || !a) continue;
    const isHl = highlighted === aId || highlighted === `t${t.id}`;
    const color = AGENT_COLORS[aId] || "#888";
    const d = euclidean(t.position, a.position);
    ctx.save();
    ctx.globalAlpha = isHl ? 0.8 : 0.3;
    ctx.strokeStyle = color;
    ctx.lineWidth = isHl ? 2.5 : 1.5;
    ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(t.position.x, t.position.y); ctx.lineTo(a.position.x, a.position.y); ctx.stroke();
    ctx.setLineDash([]);
    const mx = (t.position.x + a.position.x) / 2;
    const my = (t.position.y + a.position.y) / 2;
    ctx.globalAlpha = isHl ? 0.95 : 0.45;
    ctx.fillStyle = color;
    ctx.font = "9px 'JetBrains Mono',monospace";
    ctx.fillText(`P2·${d.toFixed(0)}m`, mx + 3, my + 10);
    ctx.restore();
  }

  // Primary lines (solid, bold, glowing)
  for (const [tidStr, aId] of Object.entries(primary)) {
    const t = targets.find((x) => x.id === +tidStr);
    const a = agents.find((x) => x.id === aId);
    if (!t || !a) continue;
    const isHl = highlighted === aId || highlighted === `t${t.id}`;
    const color = AGENT_COLORS[aId] || "#888";
    const d = euclidean(t.position, a.position);
    ctx.save();
    ctx.globalAlpha = isHl ? 1 : 0.68;
    ctx.strokeStyle = color;
    ctx.lineWidth = isHl ? 3 : 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = isHl ? 14 : 6;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(t.position.x, t.position.y); ctx.lineTo(a.position.x, a.position.y); ctx.stroke();
    ctx.shadowBlur = 0;
    const mx = (t.position.x + a.position.x) / 2;
    const my = (t.position.y + a.position.y) / 2;
    ctx.globalAlpha = isHl ? 1 : 0.85;
    ctx.fillStyle = color;
    ctx.font = "bold 10px 'JetBrains Mono',monospace";
    ctx.fillText(`P1·${d.toFixed(0)}m`, mx + 3, my - 4);
    ctx.restore();
  }

  // Targets
  for (const t of targets) {
    const isHl = highlighted === `t${t.id}`;
    const hasPrim = primary[t.id] !== undefined;
    const hasSec = Object.values(agentSecondary).includes(t.id);
    const age = (now - t.lastSeen) / STALE_TTL;
    const alpha = Math.max(0.2, 1 - age * 0.8);
    const pulse = 0.5 + 0.5 * Math.sin(now / 380 + t.id * 1.4);
    const r = 8 + pulse * 2;

    ctx.save();
    // Pulse ring
    ctx.globalAlpha = alpha * 0.2 * pulse;
    ctx.beginPath(); ctx.arc(t.position.x, t.position.y, r + 12 * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = isHl ? "#fff" : TARGET_COLOR;
    ctx.lineWidth = isHl ? 2 : 1;
    ctx.stroke();

    // Main dot
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(t.position.x, t.position.y, r, 0, Math.PI * 2);
    ctx.fillStyle = hasPrim ? TARGET_COLOR : hasSec ? "#e07030" : "#601818";
    ctx.fill();
    ctx.strokeStyle = isHl ? "#fff" : "rgba(255,255,255,0.55)";
    ctx.lineWidth = isHl ? 2 : 1.2;
    ctx.stroke();

    // Crosshair
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 1.5;
    [-1, 1].forEach((s) => {
      ctx.beginPath(); ctx.moveTo(t.position.x + s * 15, t.position.y); ctx.lineTo(t.position.x + s * (r + 1), t.position.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(t.position.x, t.position.y + s * 15); ctx.lineTo(t.position.x, t.position.y + s * (r + 1)); ctx.stroke();
    });

    // Label
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${isHl ? 13 : 11}px 'JetBrains Mono',monospace`;
    ctx.fillText(`T${t.id}`, t.position.x + r + 5, t.position.y - 3);

    // Status badge
    const badge = hasPrim ? "P1" : hasSec ? "P2" : "!!";
    const badgeCol = hasPrim ? "#4ade80" : hasSec ? "#fee440" : "#ff4d4d";
    ctx.fillStyle = "rgba(0,0,0,0.75)"; ctx.fillRect(t.position.x + r + 3, t.position.y + 5, 20, 12);
    ctx.fillStyle = badgeCol; ctx.font = "bold 9px 'JetBrains Mono',monospace";
    ctx.fillText(badge, t.position.x + r + 5, t.position.y + 15);

    // Confidence bar
    const bw = 28;
    ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.fillRect(t.position.x - bw / 2, t.position.y + r + 4, bw, 3);
    ctx.fillStyle = `hsl(${120 * t.confidence},85%,55%)`; ctx.fillRect(t.position.x - bw / 2, t.position.y + r + 4, bw * t.confidence, 3);
    ctx.restore();
  }

  // Agents
  for (const a of agents) {
    const color = AGENT_COLORS[a.id] || "#888";
    const isHl = highlighted === a.id;
    const r = isHl ? 14 : 11;
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = isHl ? 30 : 14;
    ctx.beginPath(); ctx.arc(a.position.x, a.position.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    if (isHl) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#000"; ctx.font = `bold ${isHl ? 12 : 10}px 'JetBrains Mono',monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(a.id[0], a.position.x, a.position.y);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = color; ctx.font = `bold ${isHl ? 13 : 11}px 'JetBrains Mono',monospace`;
    ctx.fillText(a.id, a.position.x + r + 5, a.position.y - 4);
    ctx.restore();
  }
}
