import argparse
import time
import os
import json
import socket
from dataclasses import dataclass
from typing import Optional, Dict, Any, List, Tuple

import cv2
import numpy as np
from ultralytics import YOLO
import torch


def pick_device() -> str:
    # Priority: CUDA (NVIDIA) → MPS (Apple Silicon) → CPU
    if torch.cuda.is_available():
        return "0"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def resolve_tracker_path(tracker_name_or_path: str) -> str:
    """
    Resolve tracker config: path to yaml, or name (e.g. botsort.yaml, botsort_reid.yaml).
    Looks in script dir first, then Ultralytics cfg/trackers.
    """
    if os.path.exists(tracker_name_or_path):
        return os.path.abspath(tracker_name_or_path)
    name = tracker_name_or_path
    try:
        _script_dir = os.path.dirname(os.path.abspath(__file__))
        candidate = os.path.join(_script_dir, name)
        if os.path.exists(candidate):
            return candidate
    except Exception:
        pass
    try:
        from ultralytics.utils import ROOT  # type: ignore
        candidate = os.path.join(str(ROOT), "cfg", "trackers", name)
        if os.path.exists(candidate):
            return candidate
    except Exception:
        pass
    return tracker_name_or_path


@dataclass
class FramePacket:
    camera_id: str
    frame_bgr: "cv2.Mat"
    timestamp_s: float
    frame_index: int
    width: int
    height: int


class CameraSource:
    """
    Unified camera source: local webcam, HTTP MJPEG stream, or file-polling
    (reads the latest JPEG saved by frame_receiver.py).
    """

    def __init__(self, source: str, camera_id: str, width: int, height: int, target_fps: Optional[int] = None):
        self.camera_id = camera_id
        self.width = width
        self.height = height
        self._frame_index = 0
        self.source = source
        self.target_fps = target_fps
        self.is_http = source.startswith("http://") or source.startswith("https://")

        # Detect file-polling mode: source is an existing image file
        # (e.g. received_frames/phone_1_latest.jpg from frame_receiver.py)
        self.is_file = (
            not self.is_http
            and (os.path.isfile(source) or source.lower().endswith((".jpg", ".jpeg", ".png")))
        )

        if self.is_file:
            self.cap = None
            self._last_mtime: float = 0.0
            print(f"[INFO] File-polling source: {source}")
            if not os.path.isfile(source):
                print(f"[WARN] File does not exist yet — will wait for frame_receiver to create it")
        else:
            self.cap = self._open_capture()

            if not self.cap.isOpened():
                raise RuntimeError(f"Could not open camera/video source: {source}")

            # For local webcams only: try to set size/fps (HTTP streams ignore these)
            if not self.is_http:
                self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
                self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
                if target_fps is not None:
                    self.cap.set(cv2.CAP_PROP_FPS, int(target_fps))

    def _open_capture(self) -> cv2.VideoCapture:
        if self.is_http:
            # MJPEG stream from iPhone app
            return cv2.VideoCapture(self.source)

        # Local camera/video
        try:
            cap_source = int(self.source)
        except ValueError:
            cap_source = self.source

        # Mac webcam backend
        return cv2.VideoCapture(cap_source, cv2.CAP_AVFOUNDATION)

    def _reconnect(self) -> None:
        try:
            self.cap.release()
        except Exception:
            pass
        time.sleep(0.2)
        self.cap = self._open_capture()

    def _read_file(self) -> Optional[FramePacket]:
        """Poll a JPEG/PNG file for new frames (written by frame_receiver.py)."""
        if not os.path.isfile(self.source):
            return None
        try:
            mtime = os.path.getmtime(self.source)
        except OSError:
            return None
        # Only return a new frame when the file has actually been updated
        if mtime <= self._last_mtime:
            return None
        self._last_mtime = mtime
        try:
            frame = cv2.imread(self.source)
        except Exception:
            return None
        if frame is None:
            return None
        ts = time.time()
        frame = cv2.resize(frame, (self.width, self.height), interpolation=cv2.INTER_AREA)
        pkt = FramePacket(self.camera_id, frame, ts, self._frame_index, self.width, self.height)
        self._frame_index += 1
        return pkt

    def read(self) -> Optional[FramePacket]:
        if self.is_file:
            return self._read_file()

        ok, frame = self.cap.read()
        ts = time.time()

        if not ok or frame is None:
            # For HTTP streams, transient failures happen; try reconnect
            if self.is_http:
                self._reconnect()
                ok2, frame2 = self.cap.read()
                ts2 = time.time()
                if not ok2 or frame2 is None:
                    return None
                frame = frame2
                ts = ts2
            else:
                return None

        # Resize to your working resolution (YOLO + fusion expects consistent w/h)
        frame = cv2.resize(frame, (self.width, self.height), interpolation=cv2.INTER_AREA)

        pkt = FramePacket(self.camera_id, frame, ts, self._frame_index, self.width, self.height)
        self._frame_index += 1
        return pkt

    def release(self) -> None:
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--camera-id", required=True)
    p.add_argument("--source", default="0")
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=360)
    p.add_argument("--target-fps", type=int, default=0)
    p.add_argument("--show", action="store_true")

    p.add_argument("--model", default="yolov8n.pt")
    p.add_argument("--conf", type=float, default=0.4)
    p.add_argument("--iou", type=float, default=0.5)
    p.add_argument("--det-fps", type=float, default=12.0)
    p.add_argument("--tracker", default="botsort_reid.yaml",
                   help="Tracker config: botsort_reid.yaml (BoT-SORT with ReID), botsort.yaml, or bytetrack.yaml")

    # ---- Camera pose + FOV metadata (for fusion) ----
    p.add_argument("--cam-x", type=float, default=0.0, help="Camera x in the shared 2D map")
    p.add_argument("--cam-y", type=float, default=0.0, help="Camera y in the shared 2D map")
    p.add_argument("--yaw-deg", type=float, default=0.0, help="Camera heading in degrees in the 2D map frame")
    p.add_argument("--hfov-deg", type=float, default=70.0, help="Approx horizontal FOV (degrees)")
    p.add_argument("--vfov-deg", type=float, default=43.0, help="Approx vertical FOV (degrees)")

    # ---- NEW: output / transport ----
    p.add_argument("--emit", default="tracks",
                   choices=["tracks", "camera", "camera+tracks", "none"],
                   help="What to emit externally")
    p.add_argument("--out-mode", default="udp", choices=["udp", "stdout", "both"],
                   help="Where to send JSON messages")
    p.add_argument("--udp-host", default="127.0.0.1", help="Fusion receiver IP (or broadcast)")
    p.add_argument("--udp-port", type=int, default=5055, help="Fusion receiver UDP port")
    p.add_argument("--camera-info-period", type=float, default=1.0,
                   help="Seconds between repeating camera_info messages")

    # ---- Phone position receiver (live position from iPhone) ----
    p.add_argument("--position-udp-port", type=int, default=0,
                   help="UDP port to listen for camera_state position updates from iPhone "
                        "(0 = disabled, use static --cam-x/--cam-y/--yaw-deg). "
                        "Matches the format sent to position_receiver.py.")

    return p.parse_args()


def extract_tracks(result) -> List[Dict[str, Any]]:
    tracks: List[Dict[str, Any]] = []
    boxes = getattr(result, "boxes", None)
    if boxes is None or len(boxes) == 0:
        return tracks

    xyxy = boxes.xyxy
    conf = boxes.conf
    ids = getattr(boxes, "id", None)

    for i in range(len(boxes)):
        x1, y1, x2, y2 = xyxy[i].tolist()
        c = float(conf[i].item()) if conf is not None else 0.0
        tid = int(ids[i].item()) if ids is not None else -1
        tracks.append({"track_id": tid, "bbox": [int(x1), int(y1), int(x2), int(y2)], "conf": c})
    return tracks


def draw_tracks(frame_bgr, tracks: List[Dict[str, Any]]) -> None:
    for t in tracks:
        x1, y1, x2, y2 = t["bbox"]
        tid = t["track_id"]
        conf = t["conf"]
        cv2.rectangle(frame_bgr, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(frame_bgr, f"id={tid} {conf:.2f}", (x1, max(0, y1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2, cv2.LINE_AA)


# ---------------- NEW: JSON emitter ----------------
class JsonEmitter:
    def __init__(self, mode: str, udp_host: str, udp_port: int):
        self.mode = mode
        self.udp_addr = (udp_host, udp_port)
        self.sock: Optional[socket.socket] = None
        if mode in ("udp", "both"):
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            # If you want broadcast, use --udp-host 255.255.255.255 and enable:
            try:
                self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            except Exception:
                pass

    def send(self, msg: Dict[str, Any]) -> None:
        line = (json.dumps(msg, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        if self.mode in ("stdout", "both"):
            print(line.decode("utf-8"), end="")
        if self.mode in ("udp", "both") and self.sock is not None:
            # Keep packets reasonably small: don't include images
            self.sock.sendto(line, self.udp_addr)


def footpoint_px(bbox: List[int]) -> Tuple[float, float]:
    x1, y1, x2, y2 = bbox
    return (0.5 * (x1 + x2), float(y2))


def make_camera_info(args: argparse.Namespace) -> Dict[str, Any]:
    return {
        "type": "camera_info",
        "camera_id": args.camera_id,
        "cam_x": args.cam_x,
        "cam_y": args.cam_y,
        "yaw_deg": args.yaw_deg,
        "hfov_deg": args.hfov_deg,
        "vfov_deg": args.vfov_deg,
        "timestamp_s": time.time(),
        "frame_w": args.width,
        "frame_h": args.height,
    }


def make_tracks_msg(pkt: FramePacket, tracks: List[Dict[str, Any]]) -> Dict[str, Any]:
    dets = []
    for t in tracks:
        u, v = footpoint_px(t["bbox"])
        dets.append({
            "track_id": int(t["track_id"]),
            "bbox_xyxy": [int(x) for x in t["bbox"]],
            "conf": float(t["conf"]),
            "foot_px": [float(u), float(v)],
        })
    return {
        "type": "tracks",
        "camera_id": pkt.camera_id,
        "timestamp_s": float(pkt.timestamp_s),
        "frame_index": int(pkt.frame_index),
        "frame_w": int(pkt.width),
        "frame_h": int(pkt.height),
        "detections": dets,
    }
# ---------------------------------------------------


class PositionListener:
    """
    Background thread that receives live camera_state UDP packets from
    the iPhone (same format as position_receiver.py) and updates the
    camera pose on the args namespace so camera_info messages reflect
    the phone's real-time position.
    """
    def __init__(self, args: argparse.Namespace, port: int):
        self._args = args
        self._port = port
        self._lock = __import__("threading").Lock()
        self._count = 0

    def start(self) -> None:
        import threading
        t = threading.Thread(target=self._listen, daemon=True)
        t.start()
        print(f"[POS] Listening for position updates on UDP port {self._port}")

    def _listen(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # macOS supports SO_REUSEPORT — allows position_receiver.py to run too
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except (AttributeError, OSError):
            pass
        sock.bind(("0.0.0.0", self._port))
        sock.settimeout(2.0)
        while True:
            try:
                data, addr = sock.recvfrom(65536)
                msg = json.loads(data.decode("utf-8"))
                if msg.get("type") == "camera_state":
                    pos = msg.get("position", [0, 0])
                    heading = msg.get("heading", 0)
                    with self._lock:
                        self._args.cam_x = float(pos[0])
                        self._args.cam_y = float(pos[1])
                        self._args.yaw_deg = float(heading)
                        self._count += 1
                    if self._count == 1:
                        print(f"[POS] First position update: ({pos[0]:.2f}, {pos[1]:.2f}) heading={heading:.1f}°")
            except socket.timeout:
                continue
            except Exception:
                continue


def main() -> None:
    args = parse_args()
    device = pick_device()
    print(f"[INFO] Using device: {device}")

    # Start live position listener if configured
    if args.position_udp_port > 0:
        pos_listener = PositionListener(args, args.position_udp_port)
        pos_listener.start()

    emitter = JsonEmitter(args.out_mode, args.udp_host, args.udp_port)

    target_fps = args.target_fps if args.target_fps > 0 else None
    cam = CameraSource(args.source, args.camera_id, args.width, args.height, target_fps=target_fps)

    print("[INFO] Loading YOLO model...")
    model = YOLO(args.model)

    tracker_path = resolve_tracker_path(args.tracker)
    if not os.path.exists(tracker_path):
        fallback = resolve_tracker_path("botsort.yaml")
        print(f"[WARN] Could not resolve {args.tracker}. Falling back to: {fallback}")
        tracker_path = fallback
    reid_enabled = "reid" in tracker_path.lower()
    print(f"[INFO] Tracker config: {tracker_path}" + (" (BoT-SORT-ReID)" if reid_enabled else ""))
    args.tracker_reid = reid_enabled  # for overlay

    det_min_dt = 1.0 / max(0.1, args.det_fps)
    last_update_time = 0.0
    last_tracks: List[Dict[str, Any]] = []

    window_name = f"YOLO BoT-SORT: {args.camera_id}"
    if args.show:
        cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)

    # Send initial camera info once
    if args.emit in ("camera", "camera+tracks"):
        emitter.send(make_camera_info(args))
    next_caminfo_time = time.time() + max(0.1, args.camera_info_period)

    _no_frame_warned = False
    print("[INFO] Running. Quit with 'q' in the window or Ctrl+C in terminal.")
    try:
        while True:
            pkt = cam.read()
            if pkt is None:
                time.sleep(0.01)
                # Keep the window responsive while waiting for frames
                if args.show:
                    key = cv2.waitKey(1) & 0xFF
                    if key == ord("q"):
                        break
                # One-time hint for file-polling mode
                if cam.is_file and not _no_frame_warned:
                    _no_frame_warned = True
                    print("[INFO] Waiting for new frames from frame_receiver... "
                          f"(watching {cam.source})")
                continue
            _no_frame_warned = False

            now = time.time()

            # Periodic camera info refresh (helps if fusion starts late)
            if args.emit in ("camera", "camera+tracks") and now >= next_caminfo_time:
                emitter.send(make_camera_info(args))
                next_caminfo_time = now + max(0.1, args.camera_info_period)

            did_update = False
            if now - last_update_time >= det_min_dt:
                results = model.track(
                    source=pkt.frame_bgr,
                    persist=True,
                    tracker=tracker_path,
                    conf=args.conf,
                    iou=args.iou,
                    classes=[0],
                    verbose=False,
                    device=device,
                )
                r0 = results[0]
                last_tracks = extract_tracks(r0)
                last_update_time = now
                did_update = True

            # Emit tracks when YOLO updated (at det_fps)
            if did_update and args.emit in ("tracks", "camera+tracks"):
                emitter.send(make_tracks_msg(pkt, last_tracks))

            vis = pkt.frame_bgr.copy()
            draw_tracks(vis, last_tracks)
            cv2.putText(
                vis,
                ("YOLO + BoT-SORT-ReID. Press 'q' to quit." if getattr(args, "tracker_reid", False) else "YOLO + BoT-SORT. Press 'q' to quit."),
                (10, 28),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 0),
                2,
                cv2.LINE_AA,
            )

            if args.show:
                cv2.imshow(window_name, vis)
                key = cv2.waitKey(1) & 0xFF
                if key == ord("q"):
                    break

    except KeyboardInterrupt:
        print("\n[INFO] Ctrl+C received, exiting.")
    finally:
        cam.release()
        if args.show:
            cv2.destroyAllWindows()
        print("[INFO] Stopped.")


if __name__ == "__main__":
    main()
