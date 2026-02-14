/**
 * Math utilities — mirrors assignment_engine.py
 */

import { WW, WH } from "./config.js";

export const euclidean = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  if (nx < 14 || nx > WW - 14) nvx *= -1;
  if (ny < 14 || ny > WH - 14) nvy *= -1;
  return {
    pos: { x: clamp(nx, 14, WW - 14), y: clamp(ny, 14, WH - 14) },
    vel: { vx: nvx, vy: nvy },
  };
}
