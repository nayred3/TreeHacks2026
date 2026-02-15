/**
 * Simulation Clock + Playback.
 * Play/pause, step, speed (0.5x/1x/2x/4x), reset.
 * Sim time and last update time. Pause toggles correctly (no one-way bugs).
 */

const SPEEDS = [0.5, 1, 2, 4];
const BASE_TICK_MS = 100;

/**
 * @typedef {Object} SimClockState
 * @property {boolean} isPlaying
 * @property {number} simTimeMs - Elapsed simulation time (ms)
 * @property {number} lastUpdateMs - Wall-clock time of last advance
 * @property {number} speedIndex - 0..3 for 0.5x/1x/2x/4x
 * @property {number} realTimeAtPauseMs - Wall time when paused (for resume sync)
 */

/**
 * @param {Object} opts
 * @param {(state: SimClockState) => void} opts.onTick - Called each tick
 * @param {number} [opts.tickMs] - Base tick interval
 * @returns {{
 *   getState: () => SimClockState,
 *   play: () => void,
 *   pause: () => void,
 *   togglePlayPause: () => boolean,
 *   step: () => void,
 *   setSpeed: (index: number) => void,
 *   reset: () => void,
 *   destroy: () => void
 * }}
 */
export function createSimClock({ onTick, tickMs = BASE_TICK_MS }) {
  let state = {
    isPlaying: false,
    simTimeMs: 0,
    lastUpdateMs: Date.now(),
    speedIndex: 1, // 1x
    realTimeAtPauseMs: null,
  };
  let intervalId = null;
  let lastTickWall = Date.now();

  function getMultiplier() {
    return SPEEDS[Math.max(0, Math.min(state.speedIndex, SPEEDS.length - 1))] ?? 1;
  }

  function tick() {
    const now = Date.now();
    const dt = (now - lastTickWall) * getMultiplier();
    lastTickWall = now;
    state.simTimeMs += dt;
    state.lastUpdateMs = now;
    onTick(state);
  }

  function startInterval() {
    if (intervalId) return;
    lastTickWall = Date.now();
    intervalId = setInterval(tick, tickMs);
  }

  function stopInterval() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function play() {
    if (state.isPlaying) return;
    state.isPlaying = true;
    state.realTimeAtPauseMs = null;
    startInterval();
  }

  function pause() {
    if (!state.isPlaying) return;
    state.isPlaying = false;
    state.realTimeAtPauseMs = Date.now();
    stopInterval();
  }

  function togglePlayPause() {
    state.isPlaying = !state.isPlaying;
    if (state.isPlaying) {
      state.realTimeAtPauseMs = null;
      startInterval();
    } else {
      state.realTimeAtPauseMs = Date.now();
      stopInterval();
    }
    return state.isPlaying;
  }

  function step() {
    stopInterval();
    state.isPlaying = false;
    const stepDt = tickMs * getMultiplier();
    state.simTimeMs += stepDt;
    state.lastUpdateMs = Date.now();
    onTick(state);
  }

  function setSpeed(index) {
    state.speedIndex = Math.max(0, Math.min(index, SPEEDS.length - 1));
  }

  function reset() {
    stopInterval();
    state.isPlaying = false;
    state.simTimeMs = 0;
    state.lastUpdateMs = Date.now();
    state.realTimeAtPauseMs = null;
    lastTickWall = Date.now();
    onTick(state);
  }

  function destroy() {
    stopInterval();
  }

  return {
    getState: () => ({ ...state }),
    getSpeedOptions: () => [...SPEEDS],
    play,
    pause,
    togglePlayPause,
    step,
    setSpeed,
    reset,
    destroy,
  };
}
