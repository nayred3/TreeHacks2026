/**
 * Pathfinding utilities — A* algorithm and wall grid extraction from floor plan images.
 * Used when a building schematic is uploaded to compute wall-aware distances.
 */

const GRID_SIZE = 8; // pixels per grid cell

export { GRID_SIZE };

export function createPresetWallLayout(ww, wh) {
  const walls = [];
  const doors = [];

  const addHWall = (y, x0, x1) => walls.push({ x1: x0, y1: y, x2: x1, y2: y });
  const addVWall = (x, y0, y1) => walls.push({ x1: x, y1: y0, x2: x, y2: y1 });
  const addHDoor = (y, x0, x1) => doors.push({ x1: x0, y1: y, x2: x1, y2: y });
  const addVDoor = (x, y0, y1) => doors.push({ x1: x, y1: y0, x2: x, y2: y1 });

  // Outer shell walls.
  addHWall(12, 12, ww - 12);
  addHWall(wh - 12, 12, ww - 12);
  addVWall(12, 12, wh - 12);
  addVWall(ww - 12, 12, wh - 12);
  // Doors are explicitly on these walls.
  addHDoor(12, ww * 0.15, ww * 0.2);
  addHDoor(wh - 12, ww * 0.45, ww * 0.5);
  addVDoor(12, wh * 0.4, wh * 0.48);

  // Interior corridor wall + doors.
  const cy = wh * 0.46;
  addHWall(cy, 12, ww - 12);
  addHDoor(cy, ww * 0.26, ww * 0.31);
  addHDoor(cy, ww * 0.49, ww * 0.54);
  addHDoor(cy, ww * 0.71, ww * 0.76);

  // Vertical room dividers + doors.
  addVWall(ww * 0.28, cy, wh - 12);
  addVWall(ww * 0.5, cy, wh - 12);
  addVWall(ww * 0.72, cy, wh - 12);
  addVDoor(ww * 0.28, wh * 0.66, wh * 0.72);
  addVDoor(ww * 0.5, wh * 0.56, wh * 0.62);
  addVDoor(ww * 0.72, wh * 0.66, wh * 0.73);

  // Lower partial barriers.
  addVWall(ww * 0.38, 12, wh * 0.22);
  addVWall(ww * 0.62, 12, wh * 0.24);

  return { walls, doors };
}

export function wallLayoutToGrid(layout, ww, wh) {
  const cols = Math.ceil(ww / GRID_SIZE);
  const rows = Math.ceil(wh / GRID_SIZE);
  const grid = Array.from({ length: rows }, () => Array(cols).fill(false));

  const stampWallPoint = (x, y) => {
    const c = Math.max(0, Math.min(cols - 1, Math.floor(x / GRID_SIZE)));
    const r = Math.max(0, Math.min(rows - 1, Math.floor(y / GRID_SIZE)));
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) grid[rr][cc] = true;
      }
    }
  };

  for (const w of layout.walls) {
    const dx = w.x2 - w.x1;
    const dy = w.y2 - w.y1;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (GRID_SIZE / 2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      stampWallPoint(w.x1 + dx * t, w.y1 + dy * t);
    }
  }

  // Carve doorway openings out of walls so doors are passable.
  const carveDoorPoint = (x, y) => {
    const c = Math.max(0, Math.min(cols - 1, Math.floor(x / GRID_SIZE)));
    const r = Math.max(0, Math.min(rows - 1, Math.floor(y / GRID_SIZE)));
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) grid[rr][cc] = false;
      }
    }
  };

  for (const d of layout.doors || []) {
    const dx = d.x2 - d.x1;
    const dy = d.y2 - d.y1;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (GRID_SIZE / 2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      carveDoorPoint(d.x1 + dx * t, d.y1 + dy * t);
    }
  }

  return grid;
}

/**
 * Extract a wall grid from an uploaded floor plan image.
 * Dark pixels (low brightness) → wall (true). Light pixels → walkable (false).
 * @param {HTMLImageElement} image
 * @param {number} ww - world width in pixels
 * @param {number} wh - world height in pixels
 * @returns {boolean[][]} 2D grid, grid[row][col] = true means wall
 */
export function extractWallGrid(image, ww, wh) {
  const cols = Math.ceil(ww / GRID_SIZE);
  const rows = Math.ceil(wh / GRID_SIZE);

  // Draw image to offscreen canvas at world resolution
  const offscreen = document.createElement("canvas");
  offscreen.width = ww;
  offscreen.height = wh;
  const ctx = offscreen.getContext("2d");
  ctx.drawImage(image, 0, 0, ww, wh);
  const imageData = ctx.getImageData(0, 0, ww, wh);
  const pixels = imageData.data;

  const grid = [];
  for (let row = 0; row < rows; row++) {
    const gridRow = [];
    for (let col = 0; col < cols; col++) {
      // Sample the center pixel of this grid cell
      const px = Math.min(Math.floor(col * GRID_SIZE + GRID_SIZE / 2), ww - 1);
      const py = Math.min(Math.floor(row * GRID_SIZE + GRID_SIZE / 2), wh - 1);
      const idx = (py * ww + px) * 4;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      // Brightness: simple average. Below threshold = wall.
      const brightness = (r + g + b) / 3;
      gridRow.push(brightness < 80);
    }
    grid.push(gridRow);
  }
  return grid;
}

/**
 * A* pathfinding on the wall grid.
 * Returns the path distance in world pixels, or Infinity if unreachable.
 * @param {boolean[][]} grid - wall grid
 * @param {{x:number,y:number}} from - world position
 * @param {{x:number,y:number}} to - world position
 * @returns {number} distance in pixels
 */
export function astarDistance(grid, from, to) {
  const rows = grid.length;
  const cols = grid[0].length;

  const startCol = Math.floor(from.x / GRID_SIZE);
  const startRow = Math.floor(from.y / GRID_SIZE);
  const endCol = Math.floor(to.x / GRID_SIZE);
  const endRow = Math.floor(to.y / GRID_SIZE);

  // Clamp to grid bounds
  const sc = Math.max(0, Math.min(cols - 1, startCol));
  const sr = Math.max(0, Math.min(rows - 1, startRow));
  const ec = Math.max(0, Math.min(cols - 1, endCol));
  const er = Math.max(0, Math.min(rows - 1, endRow));

  // If start/end are inside walls, snap to nearest walkable cells.
  const start = grid[sr][sc] ? findNearestWalkable(grid, sr, sc) : [sr, sc];
  const goal = grid[er][ec] ? findNearestWalkable(grid, er, ec) : [er, ec];
  if (!start || !goal) return Infinity;
  const [sRow, sCol] = start;
  const [gRow, gCol] = goal;

  // Same cell
  if (sRow === gRow && sCol === gCol) {
    return Math.hypot(from.x - to.x, from.y - to.y);
  }

  // Obstacle-aware heuristic:
  // exact shortest-cost-to-go map from every cell -> goal, computed on this wall grid.
  // Because doors are gaps in walls (walkable cells), this naturally includes doors.
  const potential = getGoalPotential(grid, gRow, gCol);

  const startIdx = sRow * cols + sCol;
  if (!Number.isFinite(potential[startIdx])) return Infinity;

  // A* with 8-directional movement and corner-cut prevention.
  const gScore = new Float64Array(rows * cols).fill(Infinity);
  const key = (r, c) => r * cols + c;
  gScore[key(sRow, sCol)] = 0;

  const open = [{ r: sRow, c: sCol, f: potential[startIdx] }];
  const closed = new Uint8Array(rows * cols);
  const dirs = [
    [-1, 0, GRID_SIZE], [1, 0, GRID_SIZE], [0, -1, GRID_SIZE], [0, 1, GRID_SIZE],
    [-1, -1, GRID_SIZE * Math.SQRT2], [-1, 1, GRID_SIZE * Math.SQRT2],
    [1, -1, GRID_SIZE * Math.SQRT2], [1, 1, GRID_SIZE * Math.SQRT2],
  ];

  while (open.length > 0) {
    // Find lowest f-score
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const curr = open[bestIdx];
    open[bestIdx] = open[open.length - 1];
    open.pop();

    const ck = key(curr.r, curr.c);
    if (closed[ck]) continue;
    closed[ck] = 1;

    // Reached goal
    if (curr.r === gRow && curr.c === gCol) {
      return gScore[ck];
    }

    for (const [dr, dc, cost] of dirs) {
      const nr = curr.r + dr;
      const nc = curr.c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (!canStep(grid, curr.r, curr.c, nr, nc)) continue;
      const nk = key(nr, nc);
      if (closed[nk]) continue;

      const tentG = gScore[ck] + cost;
      if (tentG < gScore[nk]) {
        gScore[nk] = tentG;
        const h = potential[nk];
        if (!Number.isFinite(h)) continue;
        open.push({ r: nr, c: nc, f: tentG + h });
      }
    }
  }

  // No path found
  return Infinity;
}

const goalPotentialCache = new WeakMap(); // grid -> Map("r,c", Float64Array)

function getGoalPotential(grid, goalR, goalC) {
  let gridCache = goalPotentialCache.get(grid);
  if (!gridCache) {
    gridCache = new Map();
    goalPotentialCache.set(grid, gridCache);
  }
  const cacheKey = `${goalR},${goalC}`;
  const hit = gridCache.get(cacheKey);
  if (hit) return hit;

  const rows = grid.length;
  const cols = grid[0].length;
  const key = (r, c) => r * cols + c;
  const dist = new Float64Array(rows * cols).fill(Infinity);
  const dirs = [
    [-1, 0, GRID_SIZE], [1, 0, GRID_SIZE], [0, -1, GRID_SIZE], [0, 1, GRID_SIZE],
    [-1, -1, GRID_SIZE * Math.SQRT2], [-1, 1, GRID_SIZE * Math.SQRT2],
    [1, -1, GRID_SIZE * Math.SQRT2], [1, 1, GRID_SIZE * Math.SQRT2],
  ];

  const goalIdx = key(goalR, goalC);
  dist[goalIdx] = 0;
  const open = [{ r: goalR, c: goalC, d: 0 }];

  // Reverse Dijkstra from goal across the actual walkable map.
  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].d < open[best].d) best = i;
    }
    const curr = open[best];
    open[best] = open[open.length - 1];
    open.pop();
    const ck = key(curr.r, curr.c);
    if (curr.d > dist[ck]) continue;

    for (const [dr, dc, cost] of dirs) {
      const nr = curr.r + dr;
      const nc = curr.c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (!canStep(grid, curr.r, curr.c, nr, nc)) continue;
      const nk = key(nr, nc);
      const nd = curr.d + cost;
      if (nd < dist[nk]) {
        dist[nk] = nd;
        open.push({ r: nr, c: nc, d: nd });
      }
    }
  }

  gridCache.set(cacheKey, dist);
  return dist;
}

function canStep(grid, r, c, nr, nc) {
  if (grid[nr][nc]) return false; // wall
  const dr = nr - r;
  const dc = nc - c;
  if (dr !== 0 && dc !== 0) {
    // Prevent diagonal corner cutting through wall corners.
    if (grid[r + dr][c] || grid[r][c + dc]) return false;
  }
  return true;
}

function findNearestWalkable(grid, row, col, maxRadius = 30) {
  const rows = grid.length;
  const cols = grid[0].length;
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const rr = row + dr;
        const cc = col + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        if (!grid[rr][cc]) return [rr, cc];
      }
    }
  }
  return null;
}
