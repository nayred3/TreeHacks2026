/**
 * Live Demo: fetches camera/target data from fusion/cam_view and maps to frontend format.
 *
 * Fusion data format (from get_fusion_data / fusion/viz/app.py):
 *   cameras: [{ id, position: [x,y], heading, image_width, image_height, hfov_deg, mobile }]
 *   timesteps: [{ t, persons, fused_tracks, camera_feeds, camera_positions }]
 *
 * Heading: phone/camera direction, degrees from perfect north (0°=north, 90°=east). Map top = 174° south.
 *
 * Fusion room: x [0,12] m, y [0,10] m. Frontend: 886×688 cm, center origin.
 */

const FUSION_ROOM_X = [0, 12];  // meters
const FUSION_ROOM_Y = [0, 10];
const FUSION_CENTER_X = 6;
const FUSION_CENTER_Y = 5;
const FRONTEND_WIDTH_CM = 886;
const FRONTEND_HEIGHT_CM = 688;

/** Map top (upward direction) = 174° south of geographic north. Phone/camera headings are degrees from perfect north. */
export const MAP_TOP_BEARING = 174;

/**
 * Convert fusion position (meters, 0–12 x 0–10) to frontend (cm, center origin).
 */
export function fusionToFrontendPos(mx, my) {
  const x_cm = (mx - FUSION_CENTER_X) * (FRONTEND_WIDTH_CM / (FUSION_ROOM_X[1] - FUSION_ROOM_X[0]));
  const y_cm = (my - FUSION_CENTER_Y) * (FRONTEND_HEIGHT_CM / (FUSION_ROOM_Y[1] - FUSION_ROOM_Y[0]));
  return { x: x_cm, y: y_cm };
}

/** Convert frontend position (cm, center origin) to fusion (meters, 0–12 x 0–10). */
function frontendToFusionPos(x_cm, y_cm) {
  const mx = FUSION_CENTER_X + x_cm * (FUSION_ROOM_X[1] - FUSION_ROOM_X[0]) / FRONTEND_WIDTH_CM;
  const my = FUSION_CENTER_Y + y_cm * (FUSION_ROOM_Y[1] - FUSION_ROOM_Y[0]) / FRONTEND_HEIGHT_CM;
  return [mx, my];
}

/** Live Demo: fixed agent positions (frontend cm, center origin). */
const AGENT_POSITIONS = [
  { id: "cam_1", x: 6.0833, y: 19, heading: 90 },
  { id: "cam_2", x: 50, y: 5, heading: 180 },
];

/** Live Demo: stationary target (frontend cm, center origin). */
const TARGET_POSITION = { x: 36, y: 11 };

/**
 * Generate mock fusion data for Live Demo when fusion server is unavailable.
 * 2 agents at fixed positions, 1 stationary target.
 */
function getMockFusionData(now = Date.now()) {
  const cameras = AGENT_POSITIONS.map((a) => {
    const fusionPos = frontendToFusionPos(a.x, a.y);
    return {
      id: a.id,
      position: fusionPos,
      heading: a.heading,
      headingFromNorth: a.heading,
    };
  });

  const targetPos = frontendToFusionPos(TARGET_POSITION.x, TARGET_POSITION.y);
  const targets = [
    {
      id: 1,
      position: targetPos,
      confidence: 0.88,
      last_seen: now / 1000,
      source_cameras: ["cam_1", "cam_2"],
    },
  ];

  return {
    cameras,
    timesteps: [{
      t: now,
      fused_tracks: targets,
      camera_positions: Object.fromEntries(
        cameras.map((c) => [c.id, { position: c.position, heading: c.heading }])
      ),
    }],
  };
}

/**
 * Parse fusion /api/map response into agents and targets for the frontend.
 * Agents = cameras (position from cameras or camera_positions for mobile).
 * Targets = fused_tracks from the latest timestep.
 * headingFromNorth: degrees from perfect north (0=north, 90=east).
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
    const headingFromNorth = cp?.heading ?? c.heading ?? c.headingFromNorth ?? 0;
    return {
      id: c.id,
      position: pos,
      heading: headingFromNorth,
      headingFromNorth,
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
 * Falls back to mock data when fusion server is unavailable.
 * Expects Vite proxy: /api/fusion -> http://127.0.0.1:5051
 */
export async function fetchFusionData() {
  try {
    const res = await fetch("/api/fusion/map");
    if (!res.ok) throw new Error(`Fusion API ${res.status}`);
    const d = await res.json();
    return parseFusionData(d);
  } catch (_) {
    return parseFusionData(getMockFusionData(Date.now()));
  }
}
