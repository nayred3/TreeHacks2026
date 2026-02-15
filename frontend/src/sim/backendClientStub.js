/**
 * Stub for future backend client integration.
 * No assumptions about endpoint names, message shapes, or protocols.
 * TODO(BACKEND-CONTRACT): Swap in real WebSocket/SSE client when backend is ready.
 * - Subscribe to fused world state stream
 * - Map backend message envelope -> WorldState via worldAdapter
 * - Handle reconnection, auth if needed
 */

/** @typedef {(worldState: import('./worldState.js').WorldState) => void} WorldStateCallback */

const listeners = new Set();

/**
 * Subscribe to world state updates from backend.
 * TODO(BACKEND-CONTRACT): Replace with actual backend subscription.
 * @param {WorldStateCallback} cb
 * @returns {() => void} Unsubscribe
 */
export function subscribeWorldState(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Emit world state to subscribers. Called by adapter when backend messages arrive.
 * TODO(BACKEND-CONTRACT): Backend client will call this instead.
 * @param {import('./worldState.js').WorldState} worldState
 */
export function emitWorldState(worldState) {
  listeners.forEach((cb) => {
    try {
      cb(worldState);
    } catch (e) {
      console.warn("[backendClientStub] listener error", e);
    }
  });
}
