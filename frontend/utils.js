/**
 * Math utilities — mirrors assignment_engine.py
 * Positions are in cm with room center = (0, 0).
 */

import { ROOM_BOUNDS } from "./config.js";

export const euclidean = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const MARGIN = 14;  // cm from edge

export function randomWalk(pos, vel, speed) {
  let nx = pos.x + vel.vx;
  let ny = pos.y + vel.vy;
  let nvx = vel.vx + (Math.random() - 0.5) * speed * 0.5;
  let nvy = vel.vy + (Math.random() - 0.5) * speed * 0.5;
  const spd = Math.hypot(nvx, nvy);
  if (spd > speed) {
    nvx = (nvx / spd) * speed;
    nvy = (nvy / spd) * speed;
  }
  const { xMin, xMax, yMin, yMax } = ROOM_BOUNDS;
  if (nx < xMin + MARGIN || nx > xMax - MARGIN) nvx *= -1;
  if (ny < yMin + MARGIN || ny > yMax - MARGIN) nvy *= -1;
  return {
    pos: {
      x: clamp(nx, xMin + MARGIN, xMax - MARGIN),
      y: clamp(ny, yMin + MARGIN, yMax - MARGIN),
    },
    vel: { vx: nvx, vy: nvy },
  };
}
