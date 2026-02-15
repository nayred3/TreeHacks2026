/**
 * WorldAdapter: ingest WorldState from fixtures or future backend.
 * Preserves unknown fields as meta. Single source for normalized WorldState.
 */

import {
  emptyWorldState,
  normalizeResponder,
  normalizeTarget,
  normalizeAssignment,
} from "./worldState.js";
import * as backendClientStub from "./backendClientStub.js";

/**
 * Normalize raw JSON into WorldState. Unknown fields -> meta.
 * @param {unknown} raw - From fixture or backend payload
 * @returns {import('./worldState.js').WorldState}
 */
export function ingestRaw(raw) {
  const out = emptyWorldState();
  if (raw == null || typeof raw !== "object") return out;
  const r = /** @type {Record<string, unknown>} */ (raw);

  const responders = r.responders ?? r.agents ?? r.agents_list;
  if (Array.isArray(responders)) {
    out.responders = responders.map(normalizeResponder).filter(Boolean);
  }

  const targets = r.targets ?? r.tracks ?? r.targets_list;
  if (Array.isArray(targets)) {
    out.targets = targets.map(normalizeTarget).filter(Boolean);
  }

  const hazards = r.hazards ?? r.pins ?? r.hazards_list;
  if (Array.isArray(hazards)) {
    out.hazards = hazards.map((h) => {
      const t = normalizeTarget(h);
      if (t) return { id: t.id, x: t.x, y: t.y, type: t.type ?? "hazard", meta: t.meta };
      return null;
    }).filter(Boolean);
  }

  const assignments = r.assignments ?? r.assignments_list;
  if (Array.isArray(assignments)) {
    out.assignments = assignments.map(normalizeAssignment).filter(Boolean);
  }

  if (typeof r.timestamp === "number") out.timestamp = r.timestamp;

  const knownKeys = new Set([
    "responders", "agents", "agents_list", "targets", "tracks", "targets_list",
    "hazards", "pins", "hazards_list", "assignments", "assignments_list", "timestamp"
  ]);
  for (const [k, v] of Object.entries(r)) {
    if (!knownKeys.has(k) && v !== undefined) {
      out.meta[k] = v;
    }
  }
  return out;
}

/**
 * Load WorldState from fixture JSON. Path is relative to public/.
 * TODO(BACKEND-CONTRACT): Fixtures are temporary; real data comes via backendClientStub.
 * @param {string} path - e.g. "/fixtures/world_state_demo.json"
 * @returns {Promise<import('./worldState.js').WorldState>}
 */
export async function loadFixture(path) {
  const base = import.meta.env?.BASE_URL ?? "/";
  const url = path.startsWith("/") ? `${base}${path.slice(1)}` : `${base}fixtures/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fixture fetch failed: ${res.status} ${path}`);
  const raw = await res.json();
  return ingestRaw(raw);
}

/**
 * Initialize adapter: load fixture and optionally wire backend.
 * Backend stub will call emitWorldState when messages arrive.
 * @param {string} [fixturePath] - e.g. "/fixtures/world_state_demo.json"
 * @param {import('./worldState.js').WorldStateCallback} onWorldState
 * @returns {Promise<() => void>} Cleanup / unsubscribe
 */
export async function initWorldAdapter(fixturePath, onWorldState) {
  let initialState = emptyWorldState();
  if (fixturePath) {
    try {
      initialState = await loadFixture(fixturePath);
    } catch (e) {
      console.warn("[worldAdapter] fixture load failed, using empty", e);
    }
  }
  onWorldState(initialState);

  const unsub = backendClientStub.subscribeWorldState((ws) => {
    const merged = ingestRaw(ws);
    onWorldState(merged);
  });

  return () => {
    unsub();
  };
}
