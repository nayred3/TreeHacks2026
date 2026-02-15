/**
 * Top-down Minimap: responders, targets, trails, assignments, camera frustum.
 * Hover tooltips: id, type, confidence, distance to selected, time since last seen.
 */

import { useRef, useEffect, useCallback, useState } from "react";
import {
  responderDisplayName,
  targetDisplayName,
  responderShortBadge,
  targetShortBadge,
} from "../utils/friendlyNames.js";
import { DEFAULT_FOV_DEG } from "../sim/worldState.js";

const LOGICAL_W = 800;
const LOGICAL_H = 520;
const NEON_CYAN = "#00ffff";
const NEON_MAGENTA = "#ff00ff";
const NEON_YELLOW = "#ffff00";
const NEON_PURPLE = "#bf5fff";
const AGENT_COLORS = [NEON_CYAN, NEON_MAGENTA, NEON_YELLOW, NEON_PURPLE];
const TARGET_COLOR = "#ff6600";
const TRAIL_SEC = 8;

function alphaFromAge(ageMs) {
  if (ageMs <= 3000) return 1;
  if (ageMs >= 10000) return 0.2;
  return 1 - (0.8 * (ageMs - 3000)) / 7000;
}

function deg2rad(deg) {
  return (deg * Math.PI) / 180;
}

export default function MinimapSim({
  worldState,
  selectedResponderId,
  onSelectResponder,
  onSelectTarget,
  onCreatePin,
  mapOffset = { x: 0, y: 0 },
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const [hoverInfo, setHoverInfo] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const responders = worldState?.responders ?? [];
  const targets = worldState?.targets ?? [];
  const assignments = worldState?.assignments ?? [];
  const selectedResponder = responders.find((r) => r.id === selectedResponderId);

  const draw = useCallback(
    (ctx, width, height) => {
      const scaleX = width / LOGICAL_W;
      const scaleY = height / LOGICAL_H;
      const ox = mapOffset.x ?? 0;
      const oy = mapOffset.y ?? 0;
      const sx = (x) => (x + ox) * scaleX;
      const sy = (y) => (y + oy) * scaleY;

      ctx.clearRect(0, 0, width, height);

      // Grid
      ctx.strokeStyle = "rgba(0, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      for (let x = 0; x <= LOGICAL_W; x += 40) {
        ctx.beginPath();
        ctx.moveTo(sx(x), 0);
        ctx.lineTo(sx(x), height);
        ctx.stroke();
      }
      for (let y = 0; y <= LOGICAL_H; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, sy(y));
        ctx.lineTo(width, sy(y));
        ctx.stroke();
      }

      const now = Date.now();

      // Trails (fading opacity - older segments dimmer)
      responders.forEach((r, i) => {
        const trail = r.trail ?? [];
        if (trail.length < 2) return;
        const color = AGENT_COLORS[i % AGENT_COLORS.length];
        const [r0, g0, b0] = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
        for (let j = 1; j < trail.length; j++) {
          const prev = trail[j - 1];
          const curr = trail[j];
          const ageMs = now - (curr.t ?? now);
          const alpha = Math.max(0.1, 1 - ageMs / (TRAIL_SEC * 1000)) * 0.6;
          ctx.strokeStyle = `rgba(${r0},${g0},${b0},${alpha})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sx(prev.x), sy(prev.y));
          ctx.lineTo(sx(curr.x), sy(curr.y));
          ctx.stroke();
        }
      });
      targets.forEach((t) => {
        const trail = t.trail ?? [];
        if (trail.length < 2) return;
        const ageMs = t.ageMs ?? 0;
        const alpha = alphaFromAge(ageMs) * 0.5;
        ctx.strokeStyle = `rgba(255, 102, 0, ${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx(trail[0].x), sy(trail[0].y));
        for (let j = 1; j < trail.length; j++) {
          ctx.lineTo(sx(trail[j].x), sy(trail[j].y));
        }
        ctx.stroke();
      });

      // Assignment lines (primary solid, secondary dashed)
      const agentMap = new Map(responders.map((r) => [r.id, r]));
      const targetMap = new Map(targets.map((t) => [t.id, t]));
      assignments.forEach((a) => {
        const agent = agentMap.get(a.agentId);
        const target = targetMap.get(a.targetId);
        if (!agent || !target || target.status === "rescued") return;
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

      // Enroute line (thicker)
      responders.forEach((r) => {
        if (r.mode === "enroute" && r.currentTargetId) {
          const target = targetMap.get(r.currentTargetId);
          if (target && target.status !== "rescued") {
            ctx.strokeStyle = NEON_CYAN;
            ctx.lineWidth = 4;
            ctx.globalAlpha = 0.95;
            ctx.beginPath();
            ctx.moveTo(sx(r.x), sy(r.y));
            ctx.lineTo(sx(target.x), sy(target.y));
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      });

      // Camera frustum for selected responder
      if (selectedResponder) {
        const yaw = selectedResponder.yaw ?? 0;
        const fovDeg = selectedResponder.fovDeg ?? DEFAULT_FOV_DEG;
        const halfFov = deg2rad(fovDeg) / 2;
        const coneLen = 120;
        const x1 = selectedResponder.x + Math.cos(yaw - halfFov) * coneLen;
        const y1 = selectedResponder.y + Math.sin(yaw - halfFov) * coneLen;
        const x2 = selectedResponder.x + Math.cos(yaw + halfFov) * coneLen;
        const y2 = selectedResponder.y + Math.sin(yaw + halfFov) * coneLen;
        ctx.fillStyle = "rgba(0, 255, 255, 0.12)";
        ctx.beginPath();
        ctx.moveTo(sx(selectedResponder.x), sy(selectedResponder.y));
        ctx.lineTo(sx(x1), sy(y1));
        ctx.lineTo(sx(x2), sy(y2));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(0, 255, 255, 0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Targets
      targets.forEach((t) => {
        const x = sx(t.x);
        const y = sy(t.y);
        const isRescued = t.status === "rescued";
        const ageMs = t.ageMs ?? (t.secondsSinceSeen ?? 0) * 1000;
        const alpha = isRescued ? 0.35 : alphaFromAge(ageMs);
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
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        const badge = targetShortBadge(targets, t.id);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = "11px monospace";
        ctx.fillText(badge, x + 8, y + 4);
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.font = "10px monospace";
        ctx.fillText(`${(t.secondsSinceSeen ?? ageMs / 1000 ?? 0).toFixed(1)}s ago`, x + 8, y + 18);
      });

      // Responders
      responders.forEach((r, i) => {
        const x = sx(r.x);
        const y = sy(r.y);
        const alpha = alphaFromAge(r.ageMs ?? 0);
        const isSelected = r.id === selectedResponderId;
        const color = AGENT_COLORS[i % AGENT_COLORS.length];
        ctx.globalAlpha = alpha;
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fill();
        if (isSelected) {
          ctx.strokeStyle = NEON_CYAN;
          ctx.lineWidth = 3;
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(x, y, 16, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        const badge = responderShortBadge(responders, r.id);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = "12px monospace";
        ctx.fillText(badge, x + 10, y + 4);
      });
    },
    [worldState, selectedResponderId, mapOffset, responders, targets, assignments]
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
      }
      draw(canvas.getContext("2d"), rect.width, rect.height);
    };
    let ticking = false;
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      if (!ticking && canvasRef.current) {
        ticking = true;
        const c = canvasRef.current;
        const rect = c.getBoundingClientRect();
        draw(c.getContext("2d"), rect.width, rect.height);
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
  }, [draw]);

  const hitTest = useCallback(
    (px, py) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const scaleX = rect.width / LOGICAL_W;
      const scaleY = rect.height / LOGICAL_H;
      const ox = mapOffset.x ?? 0;
      const oy = mapOffset.y ?? 0;
      const wx = (px - rect.left) / scaleX - ox;
      const wy = (py - rect.top) / scaleY - oy;
      const hitRadius = 20;
      for (const r of responders) {
        if (Math.hypot(wx - r.x, wy - r.y) <= hitRadius) {
          const distToSel = selectedResponder
            ? Math.hypot(r.x - selectedResponder.x, r.y - selectedResponder.y)
            : null;
          return {
            type: "responder",
            id: r.id,
            label: responderDisplayName(responders, r.id),
            confidence: r.confidence,
            distance: distToSel,
            lastSeen: r.lastSeenSeconds ?? r.ageMs / 1000,
          };
        }
      }
      for (const t of targets) {
        if (Math.hypot(wx - t.x, wy - t.y) <= hitRadius) {
          const distToSel = selectedResponder
            ? Math.hypot(t.x - selectedResponder.x, t.y - selectedResponder.y)
            : null;
          return {
            type: "target",
            id: t.id,
            label: targetDisplayName(targets, t.id, t.type),
            typeKind: t.type,
            confidence: t.confidence,
            distance: distToSel,
            lastSeen: t.secondsSinceSeen ?? t.ageMs / 1000,
          };
        }
      }
      return null;
    },
    [responders, targets, selectedResponder, mapOffset]
  );

  const handleMouseMove = useCallback(
    (e) => {
      const hit = hitTest(e.clientX, e.clientY);
      setHoverInfo(hit);
      setMousePos({ x: e.clientX, y: e.clientY });
    },
    [hitTest]
  );

  const handleMouseLeave = useCallback(() => {
    setHoverInfo(null);
  }, []);

  const handleClick = useCallback(
    (e) => {
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        if (hit.type === "responder") onSelectResponder?.(hit.id);
        if (hit.type === "target") onSelectTarget?.(hit.id);
      } else {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect && onCreatePin) {
          const scaleX = rect.width / LOGICAL_W;
          const scaleY = rect.height / LOGICAL_H;
          const ox = mapOffset?.x ?? 0;
          const oy = mapOffset?.y ?? 0;
          const wx = (e.clientX - rect.left) / scaleX - ox;
          const wy = (e.clientY - rect.top) / scaleY - oy;
          if (wx >= 0 && wx <= LOGICAL_W && wy >= 0 && wy <= LOGICAL_H) {
            onCreatePin(wx, wy);
          } else {
            onSelectResponder?.(null);
          }
        } else {
          onSelectResponder?.(null);
        }
      }
    },
    [hitTest, onSelectResponder, onSelectTarget, onCreatePin, mapOffset]
  );

  return (
    <div className="minimap-sim-wrapper" style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        className="minimap-sim"
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ display: "block", width: "100%", height: "100%", borderRadius: 16, cursor: "pointer" }}
      />
      {hoverInfo && (
        <div
          className="minimap-tooltip"
          style={{
            position: "fixed",
            left: mousePos.x + 12,
            top: mousePos.y + 12,
            pointerEvents: "none",
            zIndex: 100,
            padding: "8px 12px",
            background: "rgba(0,10,20,0.95)",
            border: "1px solid rgba(0,255,255,0.4)",
            borderRadius: 8,
            fontSize: "11px",
            fontFamily: "monospace",
            color: "rgba(255,255,255,0.95)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{hoverInfo.label}</div>
          <div>Type: {hoverInfo.typeKind ?? hoverInfo.type ?? "—"}</div>
          {hoverInfo.confidence != null && (
            <div>Confidence: {(hoverInfo.confidence * 100).toFixed(0)}%</div>
          )}
          {hoverInfo.distance != null && (
            <div>Dist to selected: {hoverInfo.distance.toFixed(0)}m</div>
          )}
          <div>Last seen: {(hoverInfo.lastSeen ?? 0).toFixed(1)}s ago</div>
        </div>
      )}
    </div>
  );
}
