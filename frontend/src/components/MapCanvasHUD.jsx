import { useRef, useEffect, useCallback } from "react";
import { agentShortBadge, targetShortBadge } from "../utils/displayNames.js";

const LOGICAL_W = 800;
const LOGICAL_H = 520;
const NEON_CYAN = "#00ffff";
const NEON_MAGENTA = "#ff00ff";
const NEON_YELLOW = "#ffff00";
const NEON_PURPLE = "#bf5fff";
const TARGET_COLOR = "#ff6600";
const AGENT_COLORS = [NEON_CYAN, NEON_MAGENTA, NEON_YELLOW, NEON_PURPLE];

function alphaFromAge(ageMs, fadeStartMs, fadeEndMs) {
  if (ageMs <= fadeStartMs) return 1;
  if (ageMs >= fadeEndMs) return 0.2;
  return 1 - (0.8 * (ageMs - fadeStartMs)) / (fadeEndMs - fadeStartMs);
}

export default function MapCanvasHUD({
  agents = [],
  targets = [],
  assignments = [],
  debug = {},
  isRunning,
  resetNonce,
  onCreatePin,
  onSelectEntity,
  selectedEntity,
  mapOffset = { x: 0, y: 0 },
  zonesEnabled,
  missionSpeed = 12,
  fadeStartMs = 3000,
  fadeEndMs = 10000,
  staleBadgeMs = 8000,
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const scaleRef = useRef({ scaleX: 1, scaleY: 1 });

  const showLabels = debug.showLabels !== false;
  const showAssignments = debug.showAssignments !== false;
  const showDetections = debug.showDetections === true;
  const showTrails = debug.showTrails !== false;
  const showLastSeenTimers = debug.showLastSeenTimers !== false;

  const draw = useCallback(
    (ctx, width, height) => {
      const scaleX = width / LOGICAL_W;
      const scaleY = height / LOGICAL_H;
      scaleRef.current = { scaleX, scaleY };
      const ox = mapOffset.x ?? 0;
      const oy = mapOffset.y ?? 0;
      const sx = (x) => (x + ox) * scaleX;
      const sy = (y) => (y + oy) * scaleY;

      ctx.clearRect(0, 0, width, height);

      // Grid
      ctx.strokeStyle = "rgba(0, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      const gridStep = 40;
      for (let x = 0; x <= LOGICAL_W; x += gridStep) {
        ctx.beginPath();
        ctx.moveTo(sx(x), 0);
        ctx.lineTo(sx(x), height);
        ctx.stroke();
      }
      for (let y = 0; y <= LOGICAL_H; y += gridStep) {
        ctx.beginPath();
        ctx.moveTo(0, sy(y));
        ctx.lineTo(width, sy(y));
        ctx.stroke();
      }

      // Zones overlay (simple rectangles)
      if (zonesEnabled) {
        ctx.strokeStyle = "rgba(0, 255, 255, 0.25)";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        [[100, 80, 200, 120], [500, 300, 150, 100]].forEach(([x, y, w, h]) => {
          ctx.strokeRect(sx(x), sy(y), w * scaleX, h * scaleY);
        });
        ctx.setLineDash([]);
      }

      // Trails (before dots)
      if (showTrails) {
        targets.forEach((t) => {
          const trail = t.trail ?? [];
          if (trail.length < 2) return;
          const alpha = alphaFromAge(t.ageMs ?? 0, fadeStartMs, fadeEndMs);
          ctx.strokeStyle = `rgba(255, 102, 0, ${alpha * 0.5})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sx(trail[0].x), sy(trail[0].y));
          for (let i = 1; i < trail.length; i++) {
            ctx.lineTo(sx(trail[i].x), sy(trail[i].y));
          }
          ctx.stroke();
        });
        agents.forEach((a, i) => {
          const trail = a.trail ?? [];
          if (trail.length < 2) return;
          const hex = AGENT_COLORS[i % AGENT_COLORS.length];
          const r = parseInt(hex.slice(1, 3), 16);
          const g = parseInt(hex.slice(3, 5), 16);
          const b = parseInt(hex.slice(5, 7), 16);
          const alpha = alphaFromAge(a.ageMs ?? 0, fadeStartMs, fadeEndMs);
          ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * 0.6})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sx(trail[0].x), sy(trail[0].y));
          for (let j = 1; j < trail.length; j++) {
            ctx.lineTo(sx(trail[j].x), sy(trail[j].y));
          }
          ctx.stroke();
        });
      }

      // Enroute lines (agent -> assigned target, thicker, brighter)
      const agentMap = new Map(agents.map((a) => [a.id, a]));
      const targetMap = new Map(targets.map((t) => [t.id, t]));
      agents.forEach((a) => {
        if (a.mode === "enroute" && a.currentTargetId) {
          const target = targetMap.get(a.currentTargetId);
          if (target && target.status !== "rescued") {
            const d = Math.hypot(target.x - a.x, target.y - a.y);
            const eta = missionSpeed > 0 ? (d / missionSpeed).toFixed(1) : "—";
            ctx.strokeStyle = "#00ffff";
            ctx.lineWidth = 4;
            ctx.globalAlpha = 0.95;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(sx(a.x), sy(a.y));
            ctx.lineTo(sx(target.x), sy(target.y));
            ctx.stroke();
            const mx = (a.x + target.x) / 2;
            const my = (a.y + target.y) / 2;
            ctx.fillStyle = "rgba(0,0,0,0.8)";
            ctx.font = "10px monospace";
            ctx.fillText(`ETA ${eta}s`, sx(mx) + 4, sy(my));
            ctx.globalAlpha = 1;
          }
        }
      });

      // Assignment lines (before dots so they render under)
      if (showAssignments && assignments.length > 0) {
        assignments.forEach((a) => {
          const agent = agentMap.get(a.agentId);
          const target = targetMap.get(a.targetId);
          if (!agent || !target) return;
          const isPrimary = a.priority === 1;
          ctx.strokeStyle = isPrimary ? NEON_CYAN : NEON_MAGENTA;
          ctx.setLineDash(isPrimary ? [] : [8, 6]);
          ctx.lineWidth = isPrimary ? 2 : 1;
          ctx.globalAlpha = isPrimary ? 0.9 : 0.5;
          ctx.beginPath();
          ctx.moveTo(sx(agent.x), sy(agent.y));
          ctx.lineTo(sx(target.x), sy(target.y));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        });
      }

      // Targets/pins
      targets.forEach((t) => {
        const x = sx(t.x);
        const y = sy(t.y);
        const isRescued = t.status === "rescued";
        const ageMs = t.ageMs ?? (t.secondsSinceSeen ?? 0) * 1000;
        const alpha = isRescued ? 0.35 : alphaFromAge(ageMs, fadeStartMs, fadeEndMs);
        const isSelected = selectedEntity?.type === "target" && selectedEntity?.id === t.id;
        const secondsSinceSeen = t.secondsSinceSeen ?? t.ageMs / 1000 ?? 0;
        const showStale = secondsSinceSeen * 1000 > staleBadgeMs;
        ctx.globalAlpha = alpha;
        ctx.shadowColor = TARGET_COLOR;
        ctx.shadowBlur = 12;
        ctx.fillStyle = isRescued ? "rgba(80, 200, 80, 0.9)" : TARGET_COLOR;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        if (isRescued) {
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.font = "bold 9px monospace";
          ctx.fillText("✓", x - 3, y + 4);
        }
        if (showDetections) {
          ctx.strokeStyle = "rgba(255, 102, 0, 0.6)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 14, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (isSelected) {
          ctx.strokeStyle = "#00ffff";
          ctx.lineWidth = 3;
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(x, y, 14, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        const badge = targetShortBadge(targets, t.id);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = "11px monospace";
        ctx.fillText(badge, x + 8, y + 4);
        if (showLastSeenTimers) {
          ctx.fillStyle = "rgba(255,255,255,0.7)";
          ctx.font = "10px monospace";
          ctx.fillText(`${secondsSinceSeen.toFixed(1)}s ago`, x + 8, y + 18);
        }
        if (showStale && !isRescued) {
          ctx.fillStyle = "rgba(255,100,100,0.9)";
          ctx.font = "9px monospace";
          ctx.fillText("STALE", x + 8, y + 30);
        }
        if (isRescued) {
          ctx.fillStyle = "rgba(80, 255, 80, 0.9)";
          ctx.font = "10px monospace";
          ctx.fillText("RESCUED", x + 8, y + 18);
        }
      });

      // Agents
      agents.forEach((a, i) => {
        const x = sx(a.x);
        const y = sy(a.y);
        const alpha = alphaFromAge(a.ageMs ?? 0, fadeStartMs, fadeEndMs);
        const isSelected = selectedEntity?.type === "agent" && selectedEntity?.id === a.id;
        ctx.globalAlpha = alpha;
        const color = AGENT_COLORS[i % AGENT_COLORS.length];
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fill();
        if (isSelected) {
          ctx.strokeStyle = "#00ffff";
          ctx.lineWidth = 3;
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(x, y, 16, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        const badge = agentShortBadge(agents, a.id);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = "12px monospace";
        ctx.fillText(badge, x + 10, y + 4);
        if (showLastSeenTimers) {
          ctx.fillStyle = "rgba(255,255,255,0.7)";
          ctx.font = "10px monospace";
          ctx.fillText(`${(a.lastSeenSeconds ?? a.ageMs / 1000 ?? 0).toFixed(1)}s`, x + 10, y + 18);
        }
      });

      // Legend (top-left)
      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      ctx.fillRect(8, 8, 180, 100);
      ctx.strokeStyle = "rgba(0, 255, 255, 0.4)";
      ctx.lineWidth = 1;
      ctx.strokeRect(8, 8, 180, 100);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.font = "10px monospace";
      ctx.fillText("■ Agents (Responders)", 16, 26);
      ctx.fillStyle = TARGET_COLOR;
      ctx.fillRect(16, 36, 8, 8);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillText("■ Targets (Pins/Hazards)", 28, 44);
      ctx.fillStyle = "rgba(0,255,255,0.8)";
      ctx.fillText("— P1 solid | - - P2 dashed", 16, 58);
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText("Fade = staleness (not visible)", 16, 72);
      ctx.fillText("STALE = unseen >8s", 16, 86);
    },
    [agents, targets, assignments, showLabels, showAssignments, showDetections, showTrails, showLastSeenTimers, fadeStartMs, fadeEndMs, mapOffset, zonesEnabled, selectedEntity, staleBadgeMs, missionSpeed]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.floor(rect.width * dpr);
      const h = Math.floor(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);
        draw(ctx, rect.width, rect.height);
      }
    };

    let ticking = false;
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      if (!ticking && canvasRef.current) {
        ticking = true;
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        const ctx = canvas.getContext("2d");
        draw(ctx, rect.width, rect.height);
        requestAnimationFrame(() => { ticking = false; });
      }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [draw, resetNonce]);

  const handleClick = useCallback(
    (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width / LOGICAL_W;
      const scaleY = rect.height / LOGICAL_H;
      const ox = mapOffset.x ?? 0;
      const oy = mapOffset.y ?? 0;
      const px = (e.clientX - rect.left) / scaleX - ox;
      const py = (e.clientY - rect.top) / scaleY - oy;
      const hitRadius = 20;
      let hit = null;
      agents.forEach((a) => {
        if (Math.hypot(px - a.x, py - a.y) <= hitRadius) hit = { type: "agent", id: a.id };
      });
      if (!hit) {
        targets.forEach((t) => {
          if (Math.hypot(px - t.x, py - t.y) <= hitRadius) hit = { type: "target", id: t.id };
        });
      }
      if (hit && onSelectEntity) {
        onSelectEntity(hit.type, hit.id);
      } else if (onCreatePin && px >= 0 && px <= LOGICAL_W && py >= 0 && py <= LOGICAL_H) {
        onCreatePin(px, py);
      }
    },
    [onCreatePin, onSelectEntity, agents, targets, mapOffset]
  );

  return (
    <canvas
      ref={canvasRef}
      className="map-canvas-hud"
      onClick={handleClick}
      style={{ display: "block", width: "100%", height: "100%", borderRadius: 16, cursor: onCreatePin || onSelectEntity ? "pointer" : "default" }}
    />
  );
}
