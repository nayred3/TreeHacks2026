/**
 * Justin-style Camera View Mini: schematic forward view.
 * x = bearing (left/right), y = distance (closer = lower on screen).
 * Only shows targets in FOV unless "show all" toggle is on.
 * Last-seen timer when target leaves view.
 */

import { useRef, useEffect, useCallback } from "react";
import { targetDisplayName, targetShortBadge } from "../utils/friendlyNames.js";
import { DEFAULT_FOV_DEG } from "../sim/worldState.js";

const W = 200;
const H = 160;
const MAX_DIST = 250;

function deg2rad(deg) {
  return (deg * Math.PI) / 180;
}

function bearing(ax, ay, bx, by) {
  return Math.atan2(by - ay, bx - ax);
}

function normAngle(a) {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

function inFOV(ax, ay, yaw, fovDeg, bx, by) {
  const halfFov = deg2rad(fovDeg) / 2;
  const b = bearing(ax, ay, bx, by);
  return Math.abs(normAngle(b - yaw)) <= halfFov;
}

export default function CameraViewMini({
  worldState,
  selectedResponderId,
  showAll = false,
}) {
  const canvasRef = useRef(null);

  const responders = worldState?.responders ?? [];
  const targets = worldState?.targets ?? [];
  const selectedResponder = responders.find((r) => r.id === selectedResponderId);

  const draw = useCallback(
    (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "rgba(0, 8, 16, 0.9)";
      ctx.fillRect(0, 0, width, height);

      if (!selectedResponder) {
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = "12px monospace";
        ctx.textAlign = "center";
        ctx.fillText("Select a responder", width / 2, height / 2);
        return;
      }

      const yaw = selectedResponder.yaw ?? 0;
      const fovDeg = selectedResponder.fovDeg ?? DEFAULT_FOV_DEG;
      const ax = selectedResponder.x;
      const ay = selectedResponder.y;

      // Center line (forward)
      ctx.strokeStyle = "rgba(0, 255, 255, 0.3)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(width / 2, height);
      ctx.lineTo(width / 2, 0);
      ctx.stroke();

      // FOV edges
      const halfFov = deg2rad(fovDeg) / 2;
      ctx.strokeStyle = "rgba(0, 255, 255, 0.2)";
      ctx.setLineDash([4, 4]);
      const leftAng = yaw - halfFov;
      const rightAng = yaw + halfFov;
      const edgeLen = 80;
      const leftX = width / 2 + Math.sin(-leftAng) * (width / 2);
      const rightX = width / 2 + Math.sin(-rightAng) * (width / 2);
      ctx.beginPath();
      ctx.moveTo(width / 2, height);
      ctx.lineTo(width / 2 + (leftX - width / 2) * 0.3, height * 0.7);
      ctx.moveTo(width / 2, height);
      ctx.lineTo(width / 2 + (rightX - width / 2) * 0.3, height * 0.7);
      ctx.stroke();
      ctx.setLineDash([]);

      // Targets: x = bearing (left/right), y = distance (closer = lower)
      targets.forEach((t) => {
        if (t.status === "rescued") return;
        const d = Math.hypot(t.x - ax, t.y - ay);
        const b = bearing(ax, ay, t.x, t.y);
        const relAng = normAngle(b - yaw);
        const inView = inFOV(ax, ay, yaw, fovDeg, t.x, t.y);

        if (!showAll && !inView) return; // Only in-FOV unless show all

        const angNorm = relAng / halfFov; // -1..1
        const screenX = width / 2 + angNorm * (width / 2);
        const screenY = height - (d / MAX_DIST) * height;
        const clampedY = Math.max(4, Math.min(height - 4, screenY));

        const isInView = inView;
        const lastSeen = t.secondsSinceSeen ?? (t.ageMs ?? 0) / 1000;
        const alpha = isInView ? 1 : Math.max(0.3, 1 - lastSeen / 10);

        ctx.globalAlpha = alpha;
        ctx.fillStyle = isInView ? "#ff6600" : "rgba(255, 102, 0, 0.5)";
        ctx.beginPath();
        ctx.arc(screenX, clampedY, 5, 0, Math.PI * 2);
        ctx.fill();

        const badge = targetShortBadge(targets, t.id);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = "10px monospace";
        ctx.textAlign = "left";
        ctx.fillText(badge, screenX + 6, clampedY + 4);
        if (!isInView) {
          ctx.fillStyle = "rgba(255,150,150,0.9)";
          ctx.font = "9px monospace";
          ctx.fillText(`${lastSeen.toFixed(1)}s`, screenX + 6, clampedY + 16);
        }
        ctx.globalAlpha = 1;
      });

      // "Camera" position (bottom center)
      ctx.fillStyle = "#00ffff";
      ctx.beginPath();
      ctx.arc(width / 2, height - 4, 4, 0, Math.PI * 2);
      ctx.fill();
    },
    [worldState, selectedResponderId, showAll]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = { width: W, height: H };
    const w = Math.floor(W * dpr);
    const h = Math.floor(H * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
    }
    let rafId;
    const loop = () => {
      rafId = requestAnimationFrame(loop);
      if (canvasRef.current) {
        draw(canvasRef.current.getContext("2d"), W, H);
      }
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [draw]);

  return (
    <div className="camera-view-mini" style={{ marginTop: 8 }}>
      <div
        style={{
          fontSize: "10px",
          fontWeight: 700,
          opacity: 0.8,
          marginBottom: 4,
          color: "#00ffff",
        }}
      >
        CAMERA VIEW {selectedResponder ? `(${selectedResponder.label ?? selectedResponder.id})` : ""}
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: W,
          height: H,
          borderRadius: 8,
          border: "1px solid rgba(0,255,255,0.3)",
          display: "block",
        }}
      />
      <div style={{ fontSize: "9px", opacity: 0.7, marginTop: 4 }}>
        x=bearing • y=distance (closer=lower)
      </div>
    </div>
  );
}
