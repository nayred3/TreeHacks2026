#!/usr/bin/env bash
#
# TreeHacks2026 Live Demo
# Starts live_fusion, camera.py (webcam + YOLO + MJPEG stream), and the frontend.
# Press Ctrl+C to stop all services.
#
# Usage: ./scripts/demo.sh [--no-browser]
#   --no-browser  Do not open the browser automatically
#

set -e
cd "$(dirname "$0")/.."

NO_BROWSER=false
for arg in "$@"; do
  case "$arg" in
    --no-browser) NO_BROWSER=true ;;
  esac
done

# PIDs for cleanup
PIDS=()
cleanup() {
  echo ""
  echo "[DEMO] Stopping services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait "${PIDS[@]}" 2>/dev/null || true
  echo "[DEMO] Done."
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "========================================"
echo "  TreeHacks2026 Live Demo"
echo "========================================"
echo ""

# 1. Start live_fusion with camera (spawns camera.py, UDP 5055, HTTP 5051, stream 5056)
echo "[1/2] Starting live_fusion with camera (port 5051, stream 5056)..."
python -m fusion.live_fusion --with-camera &
PIDS+=($!)
sleep 5

# 2. Start frontend
echo "[2/2] Starting frontend (Vite on port 5175)..."
if ! [ -d node_modules ]; then
  echo "  Running npm install..."
  npm install
fi
npm run dev &
PIDS+=($!)
sleep 3

echo ""
echo "========================================"
echo "  Demo running!"
echo "========================================"
echo "  Frontend:  http://localhost:5175"
echo "  Live Demo: Click 'LIVE DEMO' in the UI"
echo "  Stream:    http://localhost:5056/stream"
echo ""
echo "  Press Ctrl+C to stop all services."
echo "========================================"

if [ "$NO_BROWSER" = false ]; then
  sleep 1
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:5175"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:5175"
  fi
fi

wait
