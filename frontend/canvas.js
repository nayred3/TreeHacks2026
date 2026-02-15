/**
 * Canvas renderer — P1 (solid), P2 (dashed), P3 (dotted), Proximity (faint dotted)
 * Supports HiDPI/Retina displays via devicePixelRatio scaling.
 */

import { euclidean } from "./utils.js";
import { WW, WH, AGENT_COLORS, TARGET_COLOR, STALE_TTL } from "./config.js";

/**
 * Check if the A* path requires a polyline (i.e. it deviates from a straight line).
 * If A* produced >2 waypoints after simplification, it had to route around a wall.
 */
function shouldUsePolyline(waypoints) {
  return waypoints && waypoints.length > 2;
}

/** Draw a polyline path (if obstructed) or a straight line between two positions. */
function drawPath(ctx, fromPos, toPos, paths, agentId, targetId) {
  const pathKey = `${agentId}->${targetId}`;
  const waypoints = paths?.[pathKey];
  ctx.beginPath();
  if (shouldUsePolyline(waypoints)) {
    ctx.moveTo(waypoints[0].x, waypoints[0].y);
    for (let i = 1; i < waypoints.length; i++) {
      ctx.lineTo(waypoints[i].x, waypoints[i].y);
    }
  } else {
    ctx.moveTo(fromPos.x, fromPos.y);
    ctx.lineTo(toPos.x, toPos.y);
  }
  ctx.stroke();
}

/** Get the midpoint of a path (for label placement). */
function pathMidpoint(fromPos, toPos, paths, agentId, targetId) {
  const pathKey = `${agentId}->${targetId}`;
  const waypoints = paths?.[pathKey];
  if (shouldUsePolyline(waypoints)) {
    // Walk along path to find the midpoint by accumulated length
    let totalLen = 0;
    for (let i = 1; i < waypoints.length; i++) {
      totalLen += Math.hypot(waypoints[i].x - waypoints[i - 1].x, waypoints[i].y - waypoints[i - 1].y);
    }
    let half = totalLen / 2, acc = 0;
    for (let i = 1; i < waypoints.length; i++) {
      const seg = Math.hypot(waypoints[i].x - waypoints[i - 1].x, waypoints[i].y - waypoints[i - 1].y);
      if (acc + seg >= half) {
        const t = (half - acc) / seg;
        return {
          x: waypoints[i - 1].x + (waypoints[i].x - waypoints[i - 1].x) * t,
          y: waypoints[i - 1].y + (waypoints[i].y - waypoints[i - 1].y) * t,
        };
      }
      acc += seg;
    }
  }
  return { x: (fromPos.x + toPos.x) / 2, y: (fromPos.y + toPos.y) / 2 };
}

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

export function drawScene(canvas, agents, targets, result, highlighted, now, showZones, _unused, wallLayout, paths) {
  const ctx = prepareHiDPI(canvas);
  ctx.clearRect(0, 0, WW, WH);
  ctx.fillStyle = "#05080e";
  ctx.fillRect(0, 0, WW, WH);

  // Wall overlay with door openings cut out (works for both preset and schematic-derived layouts)
  if (wallLayout) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2.4;

    const doors = wallLayout.doors || [];
    for (const w of wallLayout.walls || []) {
      const wdx = w.x2 - w.x1, wdy = w.y2 - w.y1;
      const wLen = Math.hypot(wdx, wdy);
      if (wLen < 0.1) continue;

      // Collect door overlap ranges as [t0, t1] along this wall segment
      const cuts = [];
      for (const d of doors) {
        // Check if door is collinear with this wall (same axis, overlapping)
        const isH = Math.abs(wdy) < 1 && Math.abs(d.y1 - w.y1) < 2 && Math.abs(d.y2 - w.y1) < 2;
        const isV = Math.abs(wdx) < 1 && Math.abs(d.x1 - w.x1) < 2 && Math.abs(d.x2 - w.x1) < 2;
        if (!isH && !isV) continue;

        // Project door endpoints onto wall parameterised as t in [0,1]
        let t0, t1;
        if (isH) {
          t0 = (d.x1 - w.x1) / wdx;
          t1 = (d.x2 - w.x1) / wdx;
        } else {
          t0 = (d.y1 - w.y1) / wdy;
          t1 = (d.y2 - w.y1) / wdy;
        }
        if (t0 > t1) [t0, t1] = [t1, t0];
        t0 = Math.max(0, t0);
        t1 = Math.min(1, t1);
        if (t0 < t1) cuts.push([t0, t1]);
      }

      if (cuts.length === 0) {
        ctx.beginPath();
        ctx.moveTo(w.x1, w.y1);
        ctx.lineTo(w.x2, w.y2);
        ctx.stroke();
      } else {
        // Sort cuts and merge overlapping ranges, then draw wall segments between them
        cuts.sort((a, b) => a[0] - b[0]);
        const merged = [cuts[0]];
        for (let i = 1; i < cuts.length; i++) {
          const last = merged[merged.length - 1];
          if (cuts[i][0] <= last[1]) last[1] = Math.max(last[1], cuts[i][1]);
          else merged.push(cuts[i]);
        }

        let prev = 0;
        for (const [ct0, ct1] of merged) {
          if (ct0 > prev + 0.001) {
            ctx.beginPath();
            ctx.moveTo(w.x1 + wdx * prev, w.y1 + wdy * prev);
            ctx.lineTo(w.x1 + wdx * ct0, w.y1 + wdy * ct0);
            ctx.stroke();
          }
          prev = ct1;
        }
        if (prev < 0.999) {
          ctx.beginPath();
          ctx.moveTo(w.x1 + wdx * prev, w.y1 + wdy * prev);
          ctx.lineTo(w.x2, w.y2);
          ctx.stroke();
        }
      }
    }
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

  const { primary, secondary, tertiary, agentSecondary, proximity } = result;

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
    if (primary[t.id] === proxId || secondary[t.id] === proxId || tertiary[t.id] === proxId || agentSecondary[proxId] === t.id) continue;
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
    drawPath(ctx, t.position, a.position, paths, proxId, t.id);
    ctx.setLineDash([]);
    const mp = pathMidpoint(t.position, a.position, paths, proxId, t.id);
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = color;
    ctx.font = "9px 'JetBrains Mono',monospace";
    ctx.fillText(`near · ${euclidean(t.position, a.position).toFixed(0)}m`, mp.x + 3, mp.y + 14);
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
    drawPath(ctx, t.position, a.position, paths, aId, t.id);
    ctx.setLineDash([]);
    const mp2 = pathMidpoint(t.position, a.position, paths, aId, t.id);
    ctx.globalAlpha = isHl ? 0.95 : 0.45;
    ctx.fillStyle = color;
    ctx.font = "9px 'JetBrains Mono',monospace";
    ctx.fillText(`P2·${d.toFixed(0)}m`, mp2.x + 3, mp2.y + 10);
    ctx.restore();
  }

  // Tertiary lines (light dotted) — one per target from tertiary map
  for (const [tidStr, aId] of Object.entries(tertiary || {})) {
    const t = targets.find((x) => x.id === +tidStr);
    const a = agents.find((x) => x.id === aId);
    if (!t || !a) continue;
    const isHl = highlighted === aId || highlighted === `t${t.id}`;
    const color = AGENT_COLORS[aId] || "#888";
    const d = euclidean(t.position, a.position);
    ctx.save();
    ctx.globalAlpha = isHl ? 0.75 : 0.25;
    ctx.strokeStyle = color;
    ctx.lineWidth = isHl ? 1.8 : 1.1;
    ctx.setLineDash([2, 4]);
    drawPath(ctx, t.position, a.position, paths, aId, t.id);
    ctx.setLineDash([]);
    const mp3 = pathMidpoint(t.position, a.position, paths, aId, t.id);
    ctx.globalAlpha = isHl ? 0.8 : 0.35;
    ctx.fillStyle = color;
    ctx.font = "9px 'JetBrains Mono',monospace";
    ctx.fillText(`P3·${d.toFixed(0)}m`, mp3.x + 3, mp3.y + 18);
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
    drawPath(ctx, t.position, a.position, paths, aId, t.id);
    ctx.shadowBlur = 0;
    const mp1 = pathMidpoint(t.position, a.position, paths, aId, t.id);
    ctx.globalAlpha = isHl ? 1 : 0.85;
    ctx.fillStyle = color;
    ctx.font = "bold 10px 'JetBrains Mono',monospace";
    ctx.fillText(`P1·${d.toFixed(0)}m`, mp1.x + 3, mp1.y - 4);
    ctx.restore();
  }

  // Targets
  for (const t of targets) {
    const isHl = highlighted === `t${t.id}`;
    const hasPrim = primary[t.id] !== undefined;
    const hasSec = secondary?.[t.id] !== undefined || Object.values(agentSecondary).includes(t.id);
    const hasTer = tertiary?.[t.id] !== undefined;
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
    ctx.fillStyle = hasPrim ? TARGET_COLOR : hasSec ? "#e07030" : hasTer ? "#b8783a" : "#601818";
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
    const badge = hasPrim ? "P1" : hasSec ? "P2" : hasTer ? "P3" : "!!";
    const badgeCol = hasPrim ? "#4ade80" : hasSec ? "#fee440" : hasTer ? "#ff9f43" : "#ff4d4d";
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
