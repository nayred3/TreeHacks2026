/**
 * Live Demo: fetches camera/target data from fusion/cam_view and maps to frontend format.
 *
 * Fusion data format (from get_fusion_data / fusion/viz/app.py):
 *   cameras: [{ id, position: [x,y], heading, image_width, image_height, hfov_deg, mobile }]
 *   timesteps: [{ t, persons, fused_tracks, camera_feeds, camera_positions }]
 *
 * Fusion room: x [0,12] m, y [0,10] m. Frontend: 886×688 cm, center origin.
 */

const FUSION_ROOM_X = [0, 12];  // meters
const FUSION_ROOM_Y = [0, 10];
const FUSION_CENTER_X = 6;
const FUSION_CENTER_Y = 5;
const FRONTEND_WIDTH_CM = 886;
const FRONTEND_HEIGHT_CM = 688;

/**
 * Convert fusion position (meters, 0–12 x 0–10) to frontend (cm, center origin).
 */
export function fusionToFrontendPos(mx, my) {
  const x_cm = (mx - FUSION_CENTER_X) * (FRONTEND_WIDTH_CM / (FUSION_ROOM_X[1] - FUSION_ROOM_X[0]));
  const y_cm = (my - FUSION_CENTER_Y) * (FRONTEND_HEIGHT_CM / (FUSION_ROOM_Y[1] - FUSION_ROOM_Y[0]));
  return { x: x_cm, y: y_cm };
}

/**
 * Parse fusion /api/map response into agents and targets for the frontend.
 * Agents = cameras (position from cameras or camera_positions for mobile).
 * Targets = fused_tracks from the latest timestep.
 */
export function parseFusionData(d) {
  const cameras = d.cameras || [];
  const ts = d.timesteps || [];
  const frame = ts[ts.length - 1] || {};
  const fusedTracks = frame.fused_tracks || [];
  const cameraPositions = frame.camera_positions || {};

  const agents = cameras.map((c) => {
    const cp = cameraPositions[c.id];
    const mx = cp ? cp.position[0] : c.position[0];
    const my = cp ? cp.position[1] : c.position[1];
    const pos = fusionToFrontendPos(mx, my);
    return {
      id: c.id,
      position: pos,
      heading: cp ? cp.heading : c.heading,
      vel: { vx: 0, vy: 0 },
    };
  });

  const now = Date.now();
  const targets = fusedTracks.map((t) => {
    const pos = fusionToFrontendPos(t.position[0], t.position[1]);
    let lastSeen = t.last_seen ?? d.timestamp ?? now / 1000;
    if (lastSeen < 1e12) lastSeen *= 1000; // Unix seconds -> ms
    return {
      id: t.id,
      position: pos,
      confidence: t.confidence ?? 0.8,
      lastSeen,
      source_cameras: t.source_cameras || [],
      vel: { vx: 0, vy: 0 },
    };
  });

  return { agents, targets };
}

/**
 * Fetch fusion data from the proxy endpoint.
 * Expects Vite proxy: /api/fusion -> http://127.0.0.1:5051
 */
export async function fetchFusionData() {
  const res = await fetch("/api/fusion/map");
  if (!res.ok) throw new Error(`Fusion API ${res.status}`);
  const d = await res.json();
  return parseFusionData(d);
}
