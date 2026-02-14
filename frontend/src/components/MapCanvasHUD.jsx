import { useRef, useEffect, useCallback } from "react";

const LOGICAL_W = 800;
const LOGICAL_H = 520;
const NEON_CYAN = "#00ffff";
const NEON_MAGENTA = "#ff00ff";
const NEON_YELLOW = "#ffff00";
const NEON_PURPLE = "#bf5fff";
const TARGET_COLOR = "#ff6600";
const AGENT_COLORS = [NEON_CYAN, NEON_MAGENTA, NEON_YELLOW, NEON_PURPLE];

export default function MapCanvasHUD({
  agents = [],
  targets = [],
  assignments = [],
  debug = {},
  isRunning,
  resetNonce,
  onCreatePin,
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const scaleRef = useRef({ scaleX: 1, scaleY: 1 });

  const showLabels = debug.showLabels !== false;
  const showAssignments = debug.showAssignments !== false;
  const showDetections = debug.showDetections === true;

  const draw = useCallback(
    (ctx, width, height) => {
      const scaleX = width / LOGICAL_W;
      const scaleY = height / LOGICAL_H;
      scaleRef.current = { scaleX, scaleY };

      ctx.clearRect(0, 0, width, height);

      // Grid
      ctx.strokeStyle = "rgba(0, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      const gridStep = 40;
      for (let x = 0; x <= LOGICAL_W; x += gridStep) {
        ctx.beginPath();
        ctx.moveTo(x * scaleX, 0);
        ctx.lineTo(x * scaleX, height);
        ctx.stroke();
      }
      for (let y = 0; y <= LOGICAL_H; y += gridStep) {
        ctx.beginPath();
        ctx.moveTo(0, y * scaleY);
        ctx.lineTo(width, y * scaleY);
        ctx.stroke();
      }

      const sx = (x) => x * scaleX;
      const sy = (y) => y * scaleY;

      // Assignment lines (before dots so they render under)
      if (showAssignments && assignments.length > 0) {
        const agentMap = new Map(agents.map((a) => [a.id, a]));
        const targetMap = new Map(targets.map((t) => [t.id, t]));
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
        ctx.shadowColor = TARGET_COLOR;
        ctx.shadowBlur = 12;
        ctx.fillStyle = TARGET_COLOR;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        if (showDetections) {
          ctx.strokeStyle = "rgba(255, 102, 0, 0.6)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 14, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        if (showLabels && t.label) {
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.font = "11px monospace";
          ctx.fillText(t.label, x + 8, y + 4);
        }
      });

      // Agents
      agents.forEach((a, i) => {
        const x = sx(a.x);
        const y = sy(a.y);
        const color = AGENT_COLORS[i % AGENT_COLORS.length];
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (showLabels && a.label) {
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.font = "12px monospace";
          ctx.fillText(a.label, x + 10, y + 4);
        }
      });
    },
    [agents, targets, assignments, showLabels, showAssignments, showDetections]
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
      if (!onCreatePin) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * LOGICAL_W;
      const y = ((e.clientY - rect.top) / rect.height) * LOGICAL_H;
      if (x >= 0 && x <= LOGICAL_W && y >= 0 && y <= LOGICAL_H) {
        onCreatePin(x, y);
      }
    },
    [onCreatePin]
  );

  return (
    <canvas
      ref={canvasRef}
      className="map-canvas-hud"
      onClick={handleClick}
      style={{ display: "block", width: "100%", height: "100%", borderRadius: 16, cursor: onCreatePin ? "crosshair" : "default" }}
    />
  );
}
