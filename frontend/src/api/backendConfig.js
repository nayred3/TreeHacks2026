/**
 * Single source of truth for backend contract. All URLs, topic names, and
 * event keys live here. UI must not reference these directly; use backendClient.
 */

// TODO(BACKEND-CONTRACT): REPLACE_ME — ensure env vars match your backend
export const REST_BASE_URL =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_REST_BASE_URL != null
    ? import.meta.env.VITE_REST_BASE_URL
    : "";

export const WS_BASE_URL =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_WS_BASE_URL != null
    ? import.meta.env.VITE_WS_BASE_URL
    : "";

// TODO(BACKEND-CONTRACT): REPLACE_ME — topic names for websocket subscriptions
export const TOPICS = {
  agents: "agents",
  tracks: "tracks",
  assignments: "assignments",
  observations: "observations",
};

// TODO(BACKEND-CONTRACT): REPLACE_ME — event names for send()
export const EVENTS = {
  agent_update: "agent_update",
  demo_start: "demo_start",
  demo_reset: "demo_reset",
  pin_create: "pin_create",
  spawn_target: "spawn_target",
  neutralise_target: "neutralise_target",
  scatter_targets: "scatter_targets",
  zones_toggle: "zones_toggle",
};
