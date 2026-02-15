/**
 * World and engine configuration.
 * Room: 886 cm × 688 cm. Coordinate system: center of room = (0, 0).
 * x in [-443, 443] cm, y in [-344, 344] cm. 1 pixel = 1 cm.
 */

export const ROOM_WIDTH_CM = 886;
export const ROOM_LENGTH_CM = 688;
export const PX_PER_CM = 1;

export const WW = ROOM_WIDTH_CM;
export const WH = ROOM_LENGTH_CM;

/** Convert world position (cm, center origin) to canvas pixels (top-left origin). */
export function toPx(pos) {
  const x = pos.x + ROOM_WIDTH_CM / 2;
  const y = pos.y + ROOM_LENGTH_CM / 2;
  return { x, y };
}

/** Convert canvas pixel (top-left origin) to world position (cm, center origin). */
export function toWorld(xPx, yPx) {
  const x = xPx - ROOM_WIDTH_CM / 2;
  const y = yPx - ROOM_LENGTH_CM / 2;
  return { x, y };
}

/** Room bounds in cm (center origin). */
export const ROOM_BOUNDS = {
  xMin: -ROOM_WIDTH_CM / 2,
  xMax: ROOM_WIDTH_CM / 2,
  yMin: -ROOM_LENGTH_CM / 2,
  yMax: ROOM_LENGTH_CM / 2,
};

export const AGENT_COLORS = {
  Alice: "#38bdf8",
  Bob: "#fbbf24",
  Charlie: "#a78bfa",
  Diana: "#f472b6",
  cam_1: "#38bdf8",
  cam_2: "#fbbf24",
  cam_3: "#a78bfa",
  cam_mobile: "#f472b6",
};

export const TARGET_COLOR = "#f87171";
export const REASSIGN_THRESHOLD = 250;  // cm
export const STALE_TTL = 10000;

/** Movement: 50 cm/s. Loop runs every 50 ms → 2.5 cm per tick. */
export const TICK_MS = 50;
export const CM_PER_SEC = 50;
export const CM_PER_TICK = CM_PER_SEC * (TICK_MS / 1000);
