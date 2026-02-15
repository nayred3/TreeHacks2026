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

/** Demo duration in seconds for camera movement data. */
const DEMO_DURATION_SEC = 120;
const ROOM_MARGIN = 1;

/**
 * Convert fusion position (meters, 0–12 x 0–10) to frontend (cm, center origin).
 */
export function fusionToFrontendPos(mx, my) {
  const x_cm = (mx - FUSION_CENTER_X) * (FRONTEND_WIDTH_CM / (FUSION_ROOM_X[1] - FUSION_ROOM_X[0]));
  const y_cm = (my - FUSION_CENTER_Y) * (FRONTEND_HEIGHT_CM / (FUSION_ROOM_Y[1] - FUSION_ROOM_Y[0]));
  return { x: x_cm, y: y_cm };
}

/**
 * Seeded pseudo-random for reproducible target positions.
 */
function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

/**
 * Get camera/phone position and heading at time t (0–120 sec). 2 minutes of sample data.
 * Coordinates in meters; heading = direction phone is facing, degrees from perfect north (0°=north, 90°=east).
 */
function getCameraStateAtTime(camId, t) {
  const T = DEMO_DURATION_SEC;
  const roomW = 12;
  const roomH = 10;
  const margin = 1;
  const pi = Math.PI;

  switch (camId) {
    case "cam_1": {
      const phase = (t / T) * 2 * pi;
      const mx = 2 + 2 * Math.sin(phase * 0.7);
      const my = 2 + 1.5 * Math.cos(phase * 0.5);
      const heading = (90 + 40 * Math.sin(phase * 0.3)) % 360;
      return { position: [mx, my], headingFromNorth: heading };
    }
    case "cam_2": {
      const phase = (t / T) * 2 * pi;
      const mx = roomW - 2 - 1.5 * Math.cos(phase * 0.6);
      const my = 2 + 2 * Math.sin(phase * 0.4);
      const heading = (180 + 35 * Math.cos(phase * 0.25)) % 360;
      return { position: [mx, my], headingFromNorth: heading };
    }
    case "cam_3": {
      const phase = (t / T) * 2 * pi;
      const mx = roomW - 2 - 2 * Math.sin(phase * 0.55);
      const my = roomH - 2 - 1.5 * Math.cos(phase * 0.45);
      const heading = (270 + 30 * Math.sin(phase * 0.35)) % 360;
      return { position: [mx, my], headingFromNorth: heading };
    }
    case "cam_4": {
      const phase = (t / T) * 2 * pi;
      const mx = 2 + 1.5 * Math.cos(phase * 0.5);
      const my = roomH - 2 - 2 * Math.sin(phase * 0.6);
      const heading = (0 + 40 * Math.cos(phase * 0.3)) % 360;
      return { position: [mx, my], headingFromNorth: heading };
    }
    default:
      return { position: [6, 5], headingFromNorth: 90 };
  }
}

/**
 * One target: appears at random, stays stationary, then teleports every ~18 sec.
 */
function getTargetPositionAtTime(t) {
  const teleportInterval = 18;
  const slot = Math.floor(t / teleportInterval);
  const seed = slot * 12345.6789;
  const mx = ROOM_MARGIN + seededRandom(seed) * (12 - 2 * ROOM_MARGIN);
  const my = ROOM_MARGIN + seededRandom(seed + 111) * (10 - 2 * ROOM_MARGIN);
  return [mx, my];
}

/**
 * Generate mock fusion data for Live Demo when fusion server is unavailable.
 * 4 cameras move over 2 minutes (coords + heading from north). One target appears,
 * stays stationary, then teleports to random locations periodically.
 */
function getMockFusionData(now = Date.now()) {
  const t = (now / 1000) % DEMO_DURATION_SEC;
  const camIds = ["cam_1", "cam_2", "cam_3", "cam_4"];

  const cameras = camIds.map((id) => {
    const s = getCameraStateAtTime(id, t);
    return {
      id,
      position: s.position,
      heading: s.headingFromNorth,
      headingFromNorth: s.headingFromNorth,
    };
  });

  const targetPos = getTargetPositionAtTime(t);
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
        cameras.map((c) => [c.id, { position: c.position, heading: c.headingFromNorth }])
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
