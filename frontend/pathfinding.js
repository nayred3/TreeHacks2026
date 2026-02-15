/**
 * Pathfinding utilities — A* algorithm and wall grid extraction from floor plan images.
 * Used when a building schematic is uploaded to compute wall-aware distances.
 */

const GRID_SIZE = 8; // pixels per grid cell

export { GRID_SIZE };

/** Preset wall layout options for dropdown. */
export const WALL_LAYOUT_OPTIONS = [
  { id: "schematic-47x37", label: "47.17' × 37.5' schematic" },
  { id: "corridor", label: "7 rooms" },
  { id: "simple", label: "1 room" },
  { id: "two-room", label: "2 rooms" },
  { id: "grid", label: "4 rooms" },
];

/**
 * Create a preset wall layout by type.
 * @param {number} ww - world width
 * @param {number} wh - world height
 * @param {string} layoutType - one of: corridor, simple, two-room, grid, dual-vertical
 */
export function createPresetWallLayout(ww, wh, layoutType = "corridor") {
  const walls = [];
  const doors = [];

  const addHWall = (y, x0, x1) => walls.push({ x1: x0, y1: y, x2: x1, y2: y });
  const addVWall = (x, y0, y1) => walls.push({ x1: x, y1: y0, x2: x, y2: y1 });
  const addHDoor = (y, x0, x1) => doors.push({ x1: x0, y1: y, x2: x1, y2: y });
  const addVDoor = (x, y0, y1) => doors.push({ x1: x, y1: y0, x2: x, y2: y1 });

  const doorSize = 56;
  const doorHalf = doorSize / 2;

  const addHSegDoor = (y, x0, x1) => {
    addHWall(y, x0, x1);
    const mid = (x0 + x1) / 2;
    addHDoor(y, mid - doorHalf, mid + doorHalf);
  };
  const addVSegDoor = (x, y0, y1) => {
    addVWall(x, y0, y1);
    const mid = (y0 + y1) / 2;
    addVDoor(x, mid - doorHalf, mid + doorHalf);
  };

  const L = 12, R = ww - 12, T = 12, B = wh - 12;
  const midX = ww / 2, midY = wh / 2;

  if (layoutType === "simple") {
    addVSegDoor(L, T, midY); addVSegDoor(L, midY, B);
    addVSegDoor(R, T, midY); addVSegDoor(R, midY, B);
    addHSegDoor(T, L, R);
    addHSegDoor(B, L, R);
    return { walls, doors };
  }

  if (layoutType === "two-room") {
    addVSegDoor(L, T, midY); addVSegDoor(L, midY, B);
    addVSegDoor(R, T, midY); addVSegDoor(R, midY, B);
    addHSegDoor(T, L, R);
    addHSegDoor(B, L, R);
    addVSegDoor(midX, T, B);
    return { walls, doors };
  }

  if (layoutType === "grid") {
    const vx = ww / 2, hy = wh / 2;
    addVSegDoor(L, T, midY); addVSegDoor(L, midY, B);
    addVSegDoor(R, T, midY); addVSegDoor(R, midY, B);
    addHSegDoor(T, L, R);
    addHSegDoor(B, L, R);
    addVSegDoor(vx, T, B);
    addHSegDoor(hy, L, R);
    return { walls, doors };
  }

  // schematic-47x37: 47.17' × 37.5' room from blueprint
  // Top-left: L-shaped three walls (6.3' horizontal, 9.0833' vertical, bottom horizontal).
  // Right side: two vertical walls stacked with a gap (upper 11.8333', lower 3.75').
  if (layoutType === "schematic-47x37") {
    const W_FT = 47.17, H_FT = 37.5;
    const sx = ww / W_FT, sy = wh / H_FT;

    // ── Top-left L-shape: three walls carving out rectangular inset ──                                            // Horizontal: 6.3 ft
    addVWall(6.3 * sx, 0, sy * 9.0833);                                    // Vertical: 9.0833 ft
    addHWall(9.0833 * sy, 6.3 * sx, (47-6.3)*sx);      
    addVWall(40.87*sy, 0, sy * 9.0833);                                // Bottom horizontal (closes box)

    // ── Right side: two vertical walls, stacked one above the other with gap ──
    const xUpper = (W_FT - 6.3) * sx;                                      // 6.3 ft from right edge
    const xLower = (W_FT - 12.5) * sx;                                     // 12.5 ft from right edge
    const yLowerTop = (H_FT - 5.0833 - 3.75) * sy;                         // Top of lower wall
    const yLowerBot = (H_FT - 5.0833) * sy;                                      // Upper wall: 11.8333 ft
    addVWall(xLower, yLowerTop, yLowerBot);        
    addVWall(xLower, 20.9163*sy, 24.6663*sy);                             // Lower wall: 3.75 ft

    // ── Dimension indicators (dotted lines) ──
    const pad = 14;
    const dimensions = [
      { x1: pad, y1: pad, x2: ww - pad, y2: pad, label: "47.17 ft" },
      { x1: pad, y1: pad, x2: pad, y2: wh - pad, label: "37.5 ft" },
      { x1: pad, y1: pad, x2: 6.3 * sx + pad, y2: pad, label: "6.3 ft" },
      { x1: 6.3 * sx + pad, y1: pad, x2: 6.3 * sx + pad, y2: 9.0833 * sy + pad, label: "9.0833 ft" },
      { x1: ww - pad, y1: pad, x2: ww - pad, y2: 11.8333 * sy + pad, label: "11.8333 ft" },
      { x1: ww - 6.3 * sx - pad, y1: pad, x2: ww - pad, y2: pad, label: "6.3 ft" },
      { x1: ww - pad, y1: yLowerTop + pad, x2: ww - pad, y2: yLowerBot - pad, label: "3.75 ft" },
      { x1: ww - pad, y1: yLowerBot + pad, x2: ww - pad, y2: wh - pad, label: "5.0833 ft" },
      { x1: xLower + pad, y1: yLowerBot + pad, x2: ww - pad, y2: yLowerBot + pad, label: "12.5 ft" },
    ];

    return { walls, doors, dimensions };
  }

  // dual-vertical: two vertical pillars, 886 cm × 688 cm (1 px = 1 cm)
  if (layoutType === "dual-vertical") {
    // Perimeter with doors
    addVSegDoor(L, T, midY); addVSegDoor(L, midY, B);
    addVSegDoor(R, T, midY); addVSegDoor(R, midY, B);
    addHSegDoor(T, L, R);
    addHSegDoor(B, L, R);

    // Left wall: X = 297.18 cm, Y = 154.94 cm to 533.4 cm
    const leftX = 297.18;
    const wallY0 = 154.94, wallY1 = 533.4;
    addVSegDoor(leftX, wallY0, wallY1);

    // Right wall: X = 604.52 cm, same vertical span
    const rightX = 604.52;
    addVSegDoor(rightX, wallY0, wallY1);

    return { walls, doors };
  }

  // corridor (default)
  const cy = wh * 0.46, vx1 = ww * 0.28, vx2 = ww * 0.5, vx3 = ww * 0.72;
  const bx1 = ww * 0.38, bx2 = ww * 0.62;

  addHSegDoor(T, L, bx1); addHSegDoor(T, bx1, bx2); addHSegDoor(T, bx2, R);
  addHSegDoor(B, L, vx1); addHSegDoor(B, vx1, vx2); addHSegDoor(B, vx2, vx3); addHSegDoor(B, vx3, R);
  addVSegDoor(L, T, cy); addVSegDoor(L, cy, B);
  addVSegDoor(R, T, cy); addVSegDoor(R, cy, B);
  addHSegDoor(cy, L, vx1); addHSegDoor(cy, vx1, vx2); addHSegDoor(cy, vx2, vx3); addHSegDoor(cy, vx3, R);
  addVSegDoor(vx1, cy, B); addVSegDoor(vx2, cy, B); addVSegDoor(vx3, cy, B);
  addVWall(bx1, T, wh * 0.22); addVWall(bx2, T, wh * 0.24);

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

  const DOOR_BUFFER = 20; // pixels of buffer on each side so paths stay centered in the gap
  for (const d of layout.doors || []) {
    const dx = d.x2 - d.x1;
    const dy = d.y2 - d.y1;
    const len = Math.hypot(dx, dy);
    // Shrink carving region by buffer on each end so paths can't hug gap edges
    const ux = len > 0 ? dx / len : 0;
    const uy = len > 0 ? dy / len : 0;
    const cx1 = d.x1 + ux * DOOR_BUFFER;
    const cy1 = d.y1 + uy * DOOR_BUFFER;
    const cx2 = d.x2 - ux * DOOR_BUFFER;
    const cy2 = d.y2 - uy * DOOR_BUFFER;
    const cdx = cx2 - cx1;
    const cdy = cy2 - cy1;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(cdx), Math.abs(cdy)) / (GRID_SIZE / 2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      carveDoorPoint(cx1 + cdx * t, cy1 + cdy * t);
    }
  }

  return grid;
}

/**
 * Extract a wall grid from an uploaded floor plan image.
 * Samples each grid cell with multiple pixels. Considers alpha, brightness,
 * and contrast to detect walls from a variety of floor plan styles.
 * @param {HTMLImageElement} image
 * @param {number} ww - world width in pixels
 * @param {number} wh - world height in pixels
 * @returns {boolean[][]} 2D grid, grid[row][col] = true means wall
 */
export function extractWallGrid(image, ww, wh) {
  const cols = Math.ceil(ww / GRID_SIZE);
  const rows = Math.ceil(wh / GRID_SIZE);

  // Draw image onto a white background so transparency becomes white (walkable)
  const offscreen = document.createElement("canvas");
  offscreen.width = ww;
  offscreen.height = wh;
  const ctx = offscreen.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, ww, wh);
  ctx.drawImage(image, 0, 0, ww, wh);
  const imageData = ctx.getImageData(0, 0, ww, wh);
  const pixels = imageData.data;

  // First pass: compute per-cell average brightness to find adaptive threshold
  const cellBrightness = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Sample a few points within the cell for robustness
      let total = 0, count = 0;
      for (let dy = 0; dy < GRID_SIZE; dy += 2) {
        for (let dx = 0; dx < GRID_SIZE; dx += 2) {
          const px = Math.min(col * GRID_SIZE + dx, ww - 1);
          const py = Math.min(row * GRID_SIZE + dy, wh - 1);
          const idx = (py * ww + px) * 4;
          total += (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
          count++;
        }
      }
      cellBrightness.push(total / count);
    }
  }

  // Compute Otsu's threshold to adaptively separate walls from background
  const histogram = new Float64Array(256);
  for (const b of cellBrightness) histogram[Math.min(255, Math.max(0, Math.round(b)))]++;
  const totalCells = cellBrightness.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * histogram[i];

  let bestThreshold = 128, bestVariance = 0;
  let wB = 0, sumB = 0;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    const wF = totalCells - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > bestVariance) { bestVariance = variance; bestThreshold = t; }
  }

  // Light pixels = walls, dark pixels = empty space
  const threshold = Math.max(bestThreshold, 80);

  // Second pass: classify cells — bright cells are walls
  const raw = [];
  let idx = 0;
  for (let row = 0; row < rows; row++) {
    const gridRow = [];
    for (let col = 0; col < cols; col++) {
      gridRow.push(cellBrightness[idx++] >= threshold);
    }
    raw.push(gridRow);
  }

  // Dilate wall cells by 1 cell in each direction so thin image lines
  // become solid barriers that A* cannot slip through.
  const grid = Array.from({ length: rows }, () => Array(cols).fill(false));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!raw[r][c]) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) grid[rr][cc] = true;
        }
      }
    }
  }
  return grid;
}

/**
 * Convert a raw wall grid into a wallLayout { walls, doors } with clean
 * horizontal/vertical wall segments and door gaps.
 * This allows schematic-derived walls to use the same rendering pipeline as preset walls.
 */
export function gridToWallLayout(rawGrid) {
  const rows = rawGrid.length;
  const cols = rawGrid[0].length;
  const walls = [];
  const doors = [];
  const MIN_WALL = 5;  // min wall length in grid cells
  const MIN_DOOR = 2;  // min gap to count as a door

  // --- Horizontal walls ---
  // For each row find long horizontal runs of wall cells
  const hRunsByRow = [];
  for (let r = 0; r < rows; r++) {
    const rowRuns = [];
    let c = 0;
    while (c < cols) {
      if (!rawGrid[r][c]) { c++; continue; }
      let end = c;
      while (end < cols && rawGrid[r][end]) end++;
      if (end - c >= MIN_WALL) rowRuns.push([c, end - 1]);
      c = end;
    }
    hRunsByRow.push(rowRuns);
  }

  // Group vertically adjacent runs with similar x-range into wall bands
  const hProcessed = Array.from({ length: rows }, (_, r) =>
    Array(hRunsByRow[r].length).fill(false)
  );

  for (let r = 0; r < rows; r++) {
    for (let ri = 0; ri < hRunsByRow[r].length; ri++) {
      if (hProcessed[r][ri]) continue;
      const [c0, c1] = hRunsByRow[r][ri];
      hProcessed[r][ri] = true;

      let top = r, bot = r;
      let bandC0 = c0, bandC1 = c1;

      // Grow band downward through adjacent rows with overlapping runs
      for (let nr = r + 1; nr < Math.min(rows, r + 10); nr++) {
        let found = false;
        for (let nri = 0; nri < hRunsByRow[nr].length; nri++) {
          if (hProcessed[nr][nri]) continue;
          const [nc0, nc1] = hRunsByRow[nr][nri];
          const overlap = Math.min(bandC1, nc1) - Math.max(bandC0, nc0);
          if (overlap > (bandC1 - bandC0) * 0.4) {
            hProcessed[nr][nri] = true;
            bot = nr;
            bandC0 = Math.min(bandC0, nc0);
            bandC1 = Math.max(bandC1, nc1);
            found = true;
          }
        }
        if (!found) break;
      }

      // Skip blocks that aren't clearly horizontal
      if ((bandC1 - bandC0 + 1) < (bot - top + 1) * 2) continue;

      const centerY = ((top + bot) / 2) * GRID_SIZE + GRID_SIZE / 2;
      const centerR = Math.round((top + bot) / 2);

      // Scan center row for gaps (doors)
      const segs = [];
      let ws = -1;
      for (let c = bandC0; c <= bandC1 + 1; c++) {
        const isW = c <= bandC1 && rawGrid[centerR]?.[c];
        if (isW && ws < 0) ws = c;
        if (!isW && ws >= 0) { segs.push([ws, c - 1]); ws = -1; }
      }
      if (segs.length === 0) continue;

      walls.push({
        x1: segs[0][0] * GRID_SIZE,
        y1: centerY,
        x2: (segs[segs.length - 1][1] + 1) * GRID_SIZE,
        y2: centerY,
      });

      for (let i = 1; i < segs.length; i++) {
        const gStart = segs[i - 1][1] + 1;
        const gEnd = segs[i][0] - 1;
        if (gEnd - gStart + 1 >= MIN_DOOR) {
          doors.push({
            x1: gStart * GRID_SIZE,
            y1: centerY,
            x2: (gEnd + 1) * GRID_SIZE,
            y2: centerY,
          });
        }
      }
    }
  }

  // --- Vertical walls ---
  const vRunsByCol = [];
  for (let c = 0; c < cols; c++) {
    const colRuns = [];
    let r = 0;
    while (r < rows) {
      if (!rawGrid[r][c]) { r++; continue; }
      let end = r;
      while (end < rows && rawGrid[end][c]) end++;
      if (end - r >= MIN_WALL) colRuns.push([r, end - 1]);
      r = end;
    }
    vRunsByCol.push(colRuns);
  }

  const vProcessed = Array.from({ length: cols }, (_, c) =>
    Array(vRunsByCol[c].length).fill(false)
  );

  for (let c = 0; c < cols; c++) {
    for (let ci = 0; ci < vRunsByCol[c].length; ci++) {
      if (vProcessed[c][ci]) continue;
      const [r0, r1] = vRunsByCol[c][ci];
      vProcessed[c][ci] = true;

      let left = c, right = c;
      let bandR0 = r0, bandR1 = r1;

      for (let nc = c + 1; nc < Math.min(cols, c + 10); nc++) {
        let found = false;
        for (let nci = 0; nci < vRunsByCol[nc].length; nci++) {
          if (vProcessed[nc][nci]) continue;
          const [nr0, nr1] = vRunsByCol[nc][nci];
          const overlap = Math.min(bandR1, nr1) - Math.max(bandR0, nr0);
          if (overlap > (bandR1 - bandR0) * 0.4) {
            vProcessed[nc][nci] = true;
            right = nc;
            bandR0 = Math.min(bandR0, nr0);
            bandR1 = Math.max(bandR1, nr1);
            found = true;
          }
        }
        if (!found) break;
      }

      if ((bandR1 - bandR0 + 1) < (right - left + 1) * 2) continue;

      const centerX = ((left + right) / 2) * GRID_SIZE + GRID_SIZE / 2;
      const centerC = Math.round((left + right) / 2);

      const segs = [];
      let ws = -1;
      for (let r = bandR0; r <= bandR1 + 1; r++) {
        const isW = r <= bandR1 && rawGrid[r]?.[centerC];
        if (isW && ws < 0) ws = r;
        if (!isW && ws >= 0) { segs.push([ws, r - 1]); ws = -1; }
      }
      if (segs.length === 0) continue;

      walls.push({
        x1: centerX,
        y1: segs[0][0] * GRID_SIZE,
        x2: centerX,
        y2: (segs[segs.length - 1][1] + 1) * GRID_SIZE,
      });

      for (let i = 1; i < segs.length; i++) {
        const gStart = segs[i - 1][1] + 1;
        const gEnd = segs[i][0] - 1;
        if (gEnd - gStart + 1 >= MIN_DOOR) {
          doors.push({
            x1: centerX,
            y1: gStart * GRID_SIZE,
            x2: centerX,
            y2: (gEnd + 1) * GRID_SIZE,
          });
        }
      }
    }
  }

  return { walls, doors };
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
  return astarPath(grid, from, to).distance;
}

/**
 * A* pathfinding returning both distance and the actual path as world-coordinate waypoints.
 * @param {boolean[][]} grid - wall grid
 * @param {{x:number,y:number}} from - world position
 * @param {{x:number,y:number}} to - world position
 * @returns {{ distance: number, path: {x:number,y:number}[] }}
 */
export function astarPath(grid, from, to) {
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
  if (!start || !goal) return { distance: Infinity, path: [] };
  const [sRow, sCol] = start;
  const [gRow, gCol] = goal;

  // Same cell
  if (sRow === gRow && sCol === gCol) {
    return { distance: Math.hypot(from.x - to.x, from.y - to.y), path: [from, to] };
  }

  // Obstacle-aware heuristic:
  const potential = getGoalPotential(grid, gRow, gCol);

  const startIdx = sRow * cols + sCol;
  if (!Number.isFinite(potential[startIdx])) return { distance: Infinity, path: [] };

  // A* with 8-directional movement, corner-cut prevention, and turn penalty.
  const TURN_PENALTY = GRID_SIZE * 1.5; // penalise direction changes to produce straighter paths
  const gScore = new Float64Array(rows * cols).fill(Infinity);
  const cameFrom = new Int32Array(rows * cols).fill(-1);
  const dirFrom = new Int8Array(rows * cols).fill(-1); // direction index used to reach each cell
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

    // Reached goal — reconstruct path
    if (curr.r === gRow && curr.c === gCol) {
      // If straight line is clear of walls, return 2-point path (draws as straight line)
      if (gridLineOfSight(grid, sRow, sCol, gRow, gCol)) {
        return { distance: gScore[ck], path: [from, to] };
      }
      const path = [to];
      let idx = ck;
      while (idx !== -1) {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        path.push({ x: c * GRID_SIZE + GRID_SIZE / 2, y: r * GRID_SIZE + GRID_SIZE / 2 });
        idx = cameFrom[idx];
      }
      path.push(from);
      path.reverse();
      return { distance: gScore[ck], path: simplifyPath(path) };
    }

    const currDir = dirFrom[ck];
    for (let di = 0; di < dirs.length; di++) {
      const [dr, dc, cost] = dirs[di];
      const nr = curr.r + dr;
      const nc = curr.c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (!canStep(grid, curr.r, curr.c, nr, nc)) continue;
      const nk = key(nr, nc);
      if (closed[nk]) continue;

      // Add turn penalty when direction changes from parent
      const turnCost = (currDir >= 0 && di !== currDir) ? TURN_PENALTY : 0;
      const tentG = gScore[ck] + cost + turnCost;
      if (tentG < gScore[nk]) {
        gScore[nk] = tentG;
        cameFrom[nk] = ck;
        dirFrom[nk] = di;
        const h = potential[nk];
        if (!Number.isFinite(h)) continue;
        open.push({ r: nr, c: nc, f: tentG + h });
      }
    }
  }

  // No path found
  return { distance: Infinity, path: [] };
}

/** Remove collinear intermediate points to reduce path complexity. */
function simplifyPath(path) {
  if (path.length <= 2) return path;
  const result = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = path[i];
    const next = path[i + 1];
    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;
    // Keep point if direction changes
    if (Math.abs(dx1 * dy2 - dy1 * dx2) > 0.01) {
      result.push(curr);
    }
  }
  result.push(path[path.length - 1]);
  return result;
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

/** Bresenham line-of-sight check: returns true if no wall cell lies on the straight line. */
function gridLineOfSight(grid, r0, c0, r1, c1) {
  let dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
  let r = r0, c = c0;
  const sr = r0 < r1 ? 1 : -1;
  const sc = c0 < c1 ? 1 : -1;
  let err = dr - dc;
  const rows = grid.length, cols = grid[0].length;
  while (true) {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
    if (grid[r][c]) return false;
    if (r === r1 && c === c1) return true;
    const e2 = 2 * err;
    if (e2 > -dc) { err -= dc; r += sr; }
    if (e2 < dr)  { err += dr; c += sc; }
  }
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
