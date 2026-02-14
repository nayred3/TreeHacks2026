/**
 * Pathfinding utilities — A* algorithm and wall grid extraction from floor plan images.
 * Used when a building schematic is uploaded to compute wall-aware distances.
 */

const GRID_SIZE = 8; // pixels per grid cell

export { GRID_SIZE };

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

  // If start or end is inside a wall, find nearest walkable cell
  if (grid[sr][sc] || grid[er][ec]) {
    // Fallback to euclidean — can't pathfind from/to inside a wall
    return Math.hypot(from.x - to.x, from.y - to.y);
  }

  // Same cell
  if (sr === er && sc === ec) {
    return Math.hypot(from.x - to.x, from.y - to.y);
  }

  // A* with 8-directional movement
  const DIAG = Math.SQRT2;
  const dirs = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
    [-1, -1, DIAG], [-1, 1, DIAG], [1, -1, DIAG], [1, 1, DIAG],
  ];

  const heuristic = (r, c) => {
    const dr = Math.abs(r - er);
    const dc = Math.abs(c - ec);
    return Math.max(dr, dc) + (DIAG - 1) * Math.min(dr, dc);
  };

  // Open set as simple array (sufficient for grids under ~7000 cells)
  const gScore = new Float32Array(rows * cols).fill(Infinity);
  const key = (r, c) => r * cols + c;
  gScore[key(sr, sc)] = 0;

  const open = [{ r: sr, c: sc, f: heuristic(sr, sc) }];
  const closed = new Uint8Array(rows * cols);

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
    if (curr.r === er && curr.c === ec) {
      return gScore[ck] * GRID_SIZE;
    }

    for (const [dr, dc, cost] of dirs) {
      const nr = curr.r + dr;
      const nc = curr.c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (grid[nr][nc]) continue; // wall
      const nk = key(nr, nc);
      if (closed[nk]) continue;

      // For diagonal movement, also check that both adjacent cardinal cells are free
      if (dr !== 0 && dc !== 0) {
        if (grid[curr.r + dr][curr.c] || grid[curr.r][curr.c + dc]) continue;
      }

      const tentG = gScore[ck] + cost;
      if (tentG < gScore[nk]) {
        gScore[nk] = tentG;
        open.push({ r: nr, c: nc, f: tentG + heuristic(nr, nc) });
      }
    }
  }

  // No path found
  return Infinity;
}
