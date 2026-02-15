/**
 * Canvas renderer — P1 (solid), P2 (dashed), P3 (dotted), Proximity (faint dotted)
 * Supports HiDPI/Retina displays via devicePixelRatio scaling.
 */

import { euclidean } from "./utils.js";
import { WW, WH, AGENT_COLORS, TARGET_COLOR, STALE_TTL, toPx, formatDistanceFeet } from "./config.js";
import { MAP_TOP_BEARING } from "./liveDemo.js";
import { GRID_SIZE } from "./pathfinding.js";

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

export function drawScene(canvas, agents, targets, result, highlighted, now, showZones, _unused, wallLayout, paths, wallGrid, hideCameraCone = false, extraDistanceLines = [], brightenTargets = false) {
  const ctx = prepareHiDPI(canvas);
  ctx.clearRect(0, 0, WW, WH);
  ctx.fillStyle = "#0a0c18";
  ctx.fillRect(0, 0, WW, WH);

  // Wall overlay: preset uses wallLayout (segments + doors), schematic uses raw wallGrid (light=wall, black=empty)
  if (wallLayout) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(94,129,172,0.55)";
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

    // Dimension indicators (dotted measurement lines)
    if (wallLayout.dimensions?.length) {
      ctx.save();
      ctx.strokeStyle = "rgba(79,124,255,0.35)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 6]);
      ctx.font = "10px DM Sans, system-ui, sans-serif";
      ctx.fillStyle = "rgba(139,163,212,0.8)";
      for (const d of wallLayout.dimensions) {
        ctx.beginPath();
        ctx.moveTo(d.x1, d.y1);
        ctx.lineTo(d.x2, d.y2);
        ctx.stroke();
        const mx = (d.x1 + d.x2) / 2;
        const my = (d.y1 + d.y2) / 2;
        ctx.save();
        ctx.translate(mx, my);
        const isVertical = Math.abs(d.x2 - d.x1) < Math.abs(d.y2 - d.y1);
        if (isVertical) ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText(d.label, 0, -4);
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.restore();
  } else if (wallGrid?.length) {
    // Schematic: draw each wall cell as a filled rect (light pixels = walls)
    ctx.save();
    ctx.fillStyle = "rgba(94,129,172,0.55)";
    const rows = wallGrid.length;
    const cols = wallGrid[0]?.length ?? 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (wallGrid[r][c]) {
          ctx.fillRect(c * GRID_SIZE, r * GRID_SIZE, GRID_SIZE, GRID_SIZE);
        }
      }
    }
    ctx.restore();
  }

  // Grid
  ctx.strokeStyle = "rgba(79,124,255,0.12)";
  ctx.lineWidth = 1;
  for (let x = 0; x < WW; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WH); ctx.stroke();
  }
  for (let y = 0; y < WH; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WW, y); ctx.stroke();
  }

  const { primary, secondary, tertiary, agentSecondary, proximity, matrix } = result;
  const pathDist = (tid, aid) => matrix?.byTarget?.[tid]?.[aid] ?? euclidean(
    targets.find(x => x.id === tid)?.position ?? { x: 0, y: 0 },
    agents.find(x => x.id === aid)?.position ?? { x: 0, y: 0 }
  );

  // Coverage zones (positions in meters; convert to px for drawing)
  if (showZones) {
    agents.forEach((a) => {
      const ap = toPx(a.position);
      const c = AGENT_COLORS[a.id] || "#888888";
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      const grad = ctx.createRadialGradient(ap.x, ap.y, 0, ap.x, ap.y, 120);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.07)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(ap.x, ap.y, 120, 0, Math.PI * 2); ctx.fill();
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
    const tp = toPx(t.position), ap = toPx(a.position);
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 9]);
    drawPath(ctx, tp, ap, paths, proxId, t.id);
    ctx.setLineDash([]);
    const mp = pathMidpoint(tp, ap, paths, proxId, t.id);
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = color;
    ctx.font = "9px 'Inter','Segoe UI',system-ui,sans-serif";
    ctx.fillText(`near · ${formatDistanceFeet(pathDist(t.id, proxId))} ft`, mp.x + 3, mp.y + 14);
    ctx.restore();
  }

  // Secondary lines (dashed) — one per agent from agentSecondary
  for (const [aId, tid] of Object.entries(agentSecondary)) {
    const a = agents.find((x) => x.id === aId);
    const t = targets.find((x) => x.id === tid);
    if (!t || !a) continue;
    const isHl = highlighted === aId || highlighted === `t${t.id}`;
    const color = AGENT_COLORS[aId] || "#888";
    const d = pathDist(tid, aId);
    const tp = toPx(t.position), ap = toPx(a.position);
    ctx.save();
    ctx.globalAlpha = isHl ? 0.8 : 0.3;
    ctx.strokeStyle = color;
    ctx.lineWidth = isHl ? 2.5 : 1.5;
    ctx.setLineDash([7, 5]);
    drawPath(ctx, tp, ap, paths, aId, t.id);
    ctx.setLineDash([]);
    const mp2 = pathMidpoint(tp, ap, paths, aId, t.id);
    ctx.globalAlpha = isHl ? 0.95 : 0.45;
    ctx.fillStyle = color;
    ctx.font = "9px 'Inter','Segoe UI',system-ui,sans-serif";
    ctx.fillText(`P2·${formatDistanceFeet(d)} ft`, mp2.x + 3, mp2.y + 10);
    ctx.restore();
  }

  // Tertiary lines (light dotted) — one per target from tertiary map
  for (const [tidStr, aId] of Object.entries(tertiary || {})) {
    const t = targets.find((x) => x.id === +tidStr);
    const a = agents.find((x) => x.id === aId);
    if (!t || !a) continue;
    const isHl = highlighted === aId || highlighted === `t${t.id}`;
    const color = AGENT_COLORS[aId] || "#888";
    const d = pathDist(+tidStr, aId);
    const tp = toPx(t.position), ap = toPx(a.position);
    ctx.save();
    ctx.globalAlpha = isHl ? 0.75 : 0.25;
    ctx.strokeStyle = color;
    ctx.lineWidth = isHl ? 1.8 : 1.1;
    ctx.setLineDash([2, 4]);
    drawPath(ctx, tp, ap, paths, aId, t.id);
    ctx.setLineDash([]);
    const mp3 = pathMidpoint(tp, ap, paths, aId, t.id);
    ctx.globalAlpha = isHl ? 0.8 : 0.35;
    ctx.fillStyle = color;
    ctx.font = "9px 'Inter','Segoe UI',system-ui,sans-serif";
    ctx.fillText(`P3·${formatDistanceFeet(d)} ft`, mp3.x + 3, mp3.y + 18);
    ctx.restore();
  }

  // Extra distance lines (e.g. Logan–target in Live Demo 1)
  for (const { agentId, targetId } of extraDistanceLines) {
    const a = agents.find((x) => x.id === agentId);
    const t = targets.find((x) => x.id === targetId);
    if (!a || !t) continue;
    const d = pathDist(targetId, agentId);
    const color = AGENT_COLORS[agentId] || "#fbbf24";
    const tp = toPx(t.position), ap = toPx(a.position);
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    drawPath(ctx, tp, ap, paths, agentId, targetId);
    ctx.setLineDash([]);
    const mp = pathMidpoint(tp, ap, paths, agentId, targetId);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    ctx.font = "10px 'Inter','Segoe UI',system-ui,sans-serif";
    ctx.fillText(`${agentId}→T${targetId} ${formatDistanceFeet(d)} ft`, mp.x + 3, mp.y - 2);
    ctx.restore();
  }

  // Primary lines (solid, bold, glowing)
  for (const [tidStr, aId] of Object.entries(primary)) {
    const t = targets.find((x) => x.id === +tidStr);
    const a = agents.find((x) => x.id === aId);
    if (!t || !a) continue;
    const isHl = highlighted === aId || highlighted === `t${t.id}`;
    const color = AGENT_COLORS[aId] || "#888";
    const d = pathDist(+tidStr, aId);
    const tp = toPx(t.position), ap = toPx(a.position);
    ctx.save();
    ctx.globalAlpha = isHl ? 1 : 0.68;
    ctx.strokeStyle = color;
    ctx.lineWidth = isHl ? 3 : 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = isHl ? 14 : 6;
    ctx.setLineDash([]);
    drawPath(ctx, tp, ap, paths, aId, t.id);
    ctx.shadowBlur = 0;
    const mp1 = pathMidpoint(tp, ap, paths, aId, t.id);
    ctx.globalAlpha = isHl ? 1 : 0.85;
    ctx.fillStyle = color;
    ctx.font = "bold 10px 'Inter','Segoe UI',system-ui,sans-serif";
    ctx.fillText(`P1·${formatDistanceFeet(d)} ft`, mp1.x + 3, mp1.y - 4);
    ctx.restore();
  }

  // Targets
  const targetColor = brightenTargets ? "#ff6b6b" : TARGET_COLOR;
  for (const t of targets) {
    const tp = toPx(t.position);
    const isHl = highlighted === `t${t.id}`;
    const hasPrim = primary[t.id] !== undefined;
    const hasSec = secondary?.[t.id] !== undefined || Object.values(agentSecondary).includes(t.id);
    const hasTer = tertiary?.[t.id] !== undefined;
    const age = (now - t.lastSeen) / STALE_TTL;
    const alpha = brightenTargets ? 1 : Math.max(0.2, 1 - age * 0.8);
    const pulse = 0.5 + 0.5 * Math.sin(now / 380 + t.id * 1.4);
    const r = brightenTargets ? 10 + pulse * 2 : 8 + pulse * 2;

    ctx.save();
    // Dim red glow (brighter in Live Demo 1)
    ctx.shadowColor = targetColor;
    ctx.shadowBlur = brightenTargets ? (isHl ? 24 : 18) : (isHl ? 16 : 10);
    // Pulse ring
    ctx.globalAlpha = alpha * (brightenTargets ? 0.4 : 0.2) * pulse;
    ctx.beginPath(); ctx.arc(tp.x, tp.y, r + 12 * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = isHl ? "#fff" : targetColor;
    ctx.lineWidth = isHl ? 2 : 1;
    ctx.stroke();

    // Main dot — all red (brighter in Live Demo 1)
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(tp.x, tp.y, r, 0, Math.PI * 2);
    ctx.fillStyle = targetColor;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = isHl ? "#f1f5f9" : "rgba(148,163,184,0.5)";
    ctx.lineWidth = isHl ? 2 : 1.2;
    ctx.stroke();

    // Crosshair
    ctx.strokeStyle = "rgba(148,163,184,0.7)";
    ctx.lineWidth = 1.5;
    [-1, 1].forEach((s) => {
      ctx.beginPath(); ctx.moveTo(tp.x + s * 15, tp.y); ctx.lineTo(tp.x + s * (r + 1), tp.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tp.x, tp.y + s * 15); ctx.lineTo(tp.x, tp.y + s * (r + 1)); ctx.stroke();
    });

    // Label
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${isHl ? 13 : 11}px 'Inter','Segoe UI',system-ui,sans-serif`;
    ctx.fillText(`T${t.id}`, tp.x + r + 5, tp.y - 3);

    // Status badge
    const badge = hasPrim ? "P1" : hasSec ? "P2" : hasTer ? "P3" : "!!";
    const badgeCol = hasPrim ? "#4ade80" : hasSec ? "#fee440" : hasTer ? "#ff9f43" : "#ff4d4d";
    ctx.fillStyle = "rgba(0,0,0,0.75)"; ctx.fillRect(tp.x + r + 3, tp.y + 5, 20, 12);
    ctx.fillStyle = badgeCol; ctx.font = "bold 9px 'Inter','Segoe UI',system-ui,sans-serif";
    ctx.fillText(badge, tp.x + r + 5, tp.y + 15);

    // Confidence bar
    const bw = 28;
    ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.fillRect(tp.x - bw / 2, tp.y + r + 4, bw, 3);
    ctx.fillStyle = `hsl(${120 * t.confidence},85%,55%)`; ctx.fillRect(tp.x - bw / 2, tp.y + r + 4, bw * t.confidence, 3);
    ctx.restore();
  }

  // Agents: 60° facing-direction wedge (unless hideCameraCone) then dot + label
  const FOV_WEDGE_RADIUS = 80;  // px — cone emerging from agent showing facing direction
  const FOV_WEDGE_SPAN = Math.PI / 3;  // 60° cone

  for (const a of agents) {
    const ap = toPx(a.position);
    const color = AGENT_COLORS[a.id] || "#888";
    const isHl = highlighted === a.id;
    const r = isHl ? 14 : 11;

    if (!hideCameraCone) {
      // Heading: a.facing (rad) > headingFromNorth (deg from north) > fusion heading > velocity
      let angleRad;
      if (a.facing != null && typeof a.facing === "number") {
        angleRad = a.facing;
      } else if (a.headingFromNorth != null && typeof a.headingFromNorth === "number") {
        // Heading = degrees from geographic north. Map top = 174° (south).
        angleRad = ((a.headingFromNorth - MAP_TOP_BEARING - 90) * Math.PI) / 180;
      } else if (a.heading != null && typeof a.heading === "number") {
        angleRad = (a.heading * Math.PI) / 180;
      } else if (a.vel && (a.vel.vx !== 0 || a.vel.vy !== 0)) {
        angleRad = Math.atan2(a.vel.vy, a.vel.vx);
      } else {
        angleRad = 0;
      }
      const startAngle = angleRad - FOV_WEDGE_SPAN / 2;
      const endAngle = angleRad + FOV_WEDGE_SPAN / 2;

      // 60° facing cone — ombre fill (darker at agent, lighter at edge), no outline
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ap.x, ap.y);
      ctx.arc(ap.x, ap.y, FOV_WEDGE_RADIUS, startAngle, endAngle);
      ctx.closePath();
      if (color.startsWith("#")) {
        const hex = color.slice(1);
        const R = parseInt(hex.slice(0, 2), 16), G = parseInt(hex.slice(2, 4), 16), B = parseInt(hex.slice(4, 6), 16);
        const grad = ctx.createRadialGradient(ap.x, ap.y, 0, ap.x, ap.y, FOV_WEDGE_RADIUS);
        grad.addColorStop(0, `rgba(${R},${G},${B},0.55)`);
        grad.addColorStop(0.5, `rgba(${R},${G},${B},0.3)`);
        grad.addColorStop(1, `rgba(${R},${G},${B},0.08)`);
        ctx.fillStyle = grad;
      } else {
        const grad = ctx.createRadialGradient(ap.x, ap.y, 0, ap.x, ap.y, FOV_WEDGE_RADIUS);
        grad.addColorStop(0, "rgba(136,136,136,0.5)");
        grad.addColorStop(1, "rgba(136,136,136,0.06)");
        ctx.fillStyle = grad;
      }
      ctx.fill();
      ctx.restore();

      // Radius markers: concentric arcs at intervals within the wedge
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      const markerRadii = [FOV_WEDGE_RADIUS / 3, (2 * FOV_WEDGE_RADIUS) / 3, FOV_WEDGE_RADIUS];
      for (const mr of markerRadii) {
        ctx.beginPath();
        ctx.arc(ap.x, ap.y, mr, startAngle, endAngle);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Agent dot + label
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = isHl ? 30 : 14;
    ctx.beginPath(); ctx.arc(ap.x, ap.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    if (isHl) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#000"; ctx.font = `bold ${isHl ? 12 : 10}px 'Inter','Segoe UI',system-ui,sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(a.id[0], ap.x, ap.y);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = color; ctx.font = `bold ${isHl ? 13 : 11}px 'Inter','Segoe UI',system-ui,sans-serif`;
    ctx.fillText(a.id, ap.x + r + 5, ap.y - 4);
    ctx.restore();
  }
}
