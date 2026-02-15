import argparse
import time
import os
import json
import socket
from dataclasses import dataclass, asdict
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
    Accepts:
      - absolute/relative path to a yaml
      - a known tracker name like "botsort.yaml" or "bytetrack.yaml"
    Tries:
      1) as-given (path)
      2) ultralytics ROOT/cfg/trackers/<name>
    Returns a string path or the original string if nothing resolves (Ultralytics may still resolve it).
    """
    if os.path.exists(tracker_name_or_path):
        return tracker_name_or_path

    name = tracker_name_or_path
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
    p.add_argument("--conf", type=float, default=0.5)
    p.add_argument("--iou", type=float, default=0.5)
    p.add_argument("--det-fps", type=float, default=12.0)
    p.add_argument("--tracker", default="botsort.yaml")

    # ReID-lite knobs
    p.add_argument("--reid-history", type=int, default=40)
    p.add_argument("--reid-keep-seconds", type=float, default=6.0)
    p.add_argument("--reid-min-iou", type=float, default=0.03)
    p.add_argument("--reid-max-dist", type=float, default=0.18)
    p.add_argument("--reid-appearance-thresh", type=float, default=0.72)
    p.add_argument("--reid-tighten-crop", type=float, default=0.15)

    # ---- NEW: camera pose + FOV metadata (for fusion) ----
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


def clamp_bbox(b: List[int], w: int, h: int) -> Tuple[int, int, int, int]:
    x1, y1, x2, y2 = b
    x1 = max(0, min(w - 1, x1))
    y1 = max(0, min(h - 1, y1))
    x2 = max(0, min(w - 1, x2))
    y2 = max(0, min(h - 1, y2))
    if x2 <= x1:
        x2 = min(w - 1, x1 + 1)
    if y2 <= y1:
        y2 = min(h - 1, y1 + 1)
    return x1, y1, x2, y2


def tighten_bbox(b: List[int], tighten: float) -> List[int]:
    x1, y1, x2, y2 = b
    w = max(1, x2 - x1)
    h = max(1, y2 - y1)
    dx = int(w * tighten)
    dy = int(h * tighten)
    return [x1 + dx, y1 + dy, x2 - dx, y2 - dy]


def bbox_iou(a: List[int], b: List[int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    iw = max(0, inter_x2 - inter_x1)
    ih = max(0, inter_y2 - inter_y1)
    inter = iw * ih
    area_a = max(1, (ax2 - ax1) * (ay2 - ay1))
    area_b = max(1, (bx2 - bx1) * (by2 - by1))
    return inter / (area_a + area_b - inter + 1e-9)


def bbox_center(b: List[int]) -> Tuple[float, float]:
    x1, y1, x2, y2 = b
    return (0.5 * (x1 + x2), 0.5 * (y1 + y2))


def center_dist_norm(a: List[int], b: List[int], frame_w: int, frame_h: int) -> float:
    ax, ay = bbox_center(a)
    bx, by = bbox_center(b)
    dx = ax - bx
    dy = ay - by
    diag = (frame_w * frame_w + frame_h * frame_h) ** 0.5
    return float((dx * dx + dy * dy) ** 0.5 / (diag + 1e-9))


def appearance_hist_hsv(frame_bgr, bbox: List[int], tighten: float = 0.0) -> np.ndarray:
    h, w = frame_bgr.shape[:2]
    bb = tighten_bbox(bbox, tighten) if tighten > 0 else bbox
    x1, y1, x2, y2 = clamp_bbox(bb, w, h)
    crop = frame_bgr[y1:y2, x1:x2]
    if crop.size == 0:
        return np.zeros((180 + 256 + 256,), dtype=np.float32)

    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    hist_h = cv2.calcHist([hsv], [0], None, [180], [0, 180]).flatten()
    hist_s = cv2.calcHist([hsv], [1], None, [256], [0, 256]).flatten()
    hist_v = cv2.calcHist([hsv], [2], None, [256], [0, 256]).flatten()

    feat = np.concatenate([hist_h, hist_s, hist_v]).astype(np.float32)
    feat /= (np.linalg.norm(feat) + 1e-9)
    return feat


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


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


class ReidLiteStabilizer:
    def __init__(self, history: int, keep_seconds: float, confirm_frames: int = 3):
        self.history = history
        self.keep_seconds = keep_seconds
        self.confirm_frames = confirm_frames

        self.appearance: Dict[int, List[np.ndarray]] = {}
        self.last_bbox: Dict[int, List[int]] = {}
        self.last_seen: Dict[int, float] = {}
        self._pending: Dict[int, Tuple[int, int]] = {}

    def _avg_feat(self, feats: List[np.ndarray]) -> np.ndarray:
        if not feats:
            return np.zeros((180 + 256 + 256,), dtype=np.float32)
        m = np.mean(np.stack(feats, axis=0), axis=0)
        m /= (np.linalg.norm(m) + 1e-9)
        return m

    def _bbox_area(self, b: List[int]) -> float:
        x1, y1, x2, y2 = b
        return float(max(1, (x2 - x1)) * max(1, (y2 - y1)))

    def _bbox_ar(self, b: List[int]) -> float:
        x1, y1, x2, y2 = b
        w = max(1, (x2 - x1))
        h = max(1, (y2 - y1))
        return float(w / h)

    def update_memory(self, frame_bgr, tracks: List[Dict[str, Any]], now: float, tighten: float) -> None:
        for t in tracks:
            tid = t["track_id"]
            if tid == -1:
                continue

            feat = appearance_hist_hsv(frame_bgr, t["bbox"], tighten=tighten)
            self.appearance.setdefault(tid, []).append(feat)
            if len(self.appearance[tid]) > self.history:
                self.appearance[tid] = self.appearance[tid][-self.history:]

            self.last_bbox[tid] = t["bbox"]
            self.last_seen[tid] = now

        to_del = []
        for tid, last in self.last_seen.items():
            if now - last > self.keep_seconds:
                to_del.append(tid)
        for tid in to_del:
            self.appearance.pop(tid, None)
            self.last_bbox.pop(tid, None)
            self.last_seen.pop(tid, None)

        for cur_id, (old_id, cnt) in list(self._pending.items()):
            if cur_id not in self.last_seen and cur_id not in [t["track_id"] for t in tracks]:
                self._pending.pop(cur_id, None)
            elif old_id not in self.last_seen:
                self._pending.pop(cur_id, None)

    def stabilize(
        self,
        frame_bgr,
        tracks: List[Dict[str, Any]],
        now: float,
        frame_w: int,
        frame_h: int,
        min_iou_for_match: float,
        max_dist_norm_for_match: float,
        appearance_thresh: float,
        tighten: float,
        max_area_ratio: float = 2.2,
        max_ar_ratio: float = 1.6,
        score_margin: float = 0.10
    ) -> List[Dict[str, Any]]:

        current_ids = {t["track_id"] for t in tracks if t["track_id"] != -1}

        memory_ids = set(self.appearance.keys())
        candidate_old_ids = [oid for oid in memory_ids
                             if oid not in current_ids and (now - self.last_seen.get(oid, -1e9) <= self.keep_seconds)]

        if not candidate_old_ids:
            self._pending.clear()
            return tracks

        cur_feats = [appearance_hist_hsv(frame_bgr, t["bbox"], tighten=tighten) for t in tracks]
        used_old = set()

        for i, t in enumerate(tracks):
            cur_id = t["track_id"]
            if cur_id == -1:
                continue

            cur_bbox = t["bbox"]

            if near_border(cur_bbox, frame_w, frame_h, margin=10) or too_small(cur_bbox, frame_w, frame_h, min_frac=0.006):
                self._pending.pop(cur_id, None)
                continue

            cur_feat = cur_feats[i]
            best_old = None
            best_score_adj = -1e9
            best_raw_sim = -1.0

            cur_area = self._bbox_area(cur_bbox)
            cur_ar = self._bbox_ar(cur_bbox)

            for old_id in candidate_old_ids:
                if old_id in used_old:
                    continue

                old_bbox = self.last_bbox.get(old_id)
                if old_bbox is None:
                    continue

                old_area = self._bbox_area(old_bbox)
                old_ar = self._bbox_ar(old_bbox)

                area_ratio = max(cur_area / (old_area + 1e-9), old_area / (cur_area + 1e-9))
                ar_ratio = max(cur_ar / (old_ar + 1e-9), old_ar / (cur_ar + 1e-9))
                if area_ratio > max_area_ratio or ar_ratio > max_ar_ratio:
                    continue

                iou = bbox_iou(cur_bbox, old_bbox)
                distn = center_dist_norm(cur_bbox, old_bbox, frame_w, frame_h)
                if not (iou >= min_iou_for_match or distn <= max_dist_norm_for_match):
                    continue

                old_feat = self._avg_feat(self.appearance.get(old_id, []))
                raw_sim = cosine_sim(cur_feat, old_feat)
                if raw_sim < appearance_thresh:
                    continue

                score_adj = raw_sim - 0.25 * distn
                if score_adj > best_score_adj:
                    best_score_adj = score_adj
                    best_old = old_id
                    best_raw_sim = raw_sim

            if best_old is None:
                self._pending.pop(cur_id, None)
                continue

            cur_feat_mean = self._avg_feat(self.appearance.get(cur_id, []))
            cur_self = cosine_sim(cur_feat, cur_feat_mean) if cur_id in self.appearance else 0.0

            if best_raw_sim < cur_self + score_margin:
                self._pending.pop(cur_id, None)
                continue

            prev = self._pending.get(cur_id)
            if prev is None or prev[0] != best_old:
                self._pending[cur_id] = (best_old, 1)
                continue
            else:
                self._pending[cur_id] = (best_old, prev[1] + 1)

            if self._pending[cur_id][1] >= self.confirm_frames:
                t["track_id"] = best_old
                used_old.add(best_old)
                self._pending.pop(cur_id, None)

        return tracks


def bbox_area(b: List[int]) -> int:
    x1, y1, x2, y2 = b
    return max(1, x2 - x1) * max(1, y2 - y1)


def near_border(b: List[int], w: int, h: int, margin: int = 8) -> bool:
    x1, y1, x2, y2 = b
    return (x1 <= margin or y1 <= margin or x2 >= w - 1 - margin or y2 >= h - 1 - margin)


def too_small(b: List[int], w: int, h: int, min_frac: float = 0.006) -> bool:
    return bbox_area(b) < int(min_frac * (w * h))


def unstable_box(prev: Optional[List[int]], cur: List[int], w: int, h: int, max_jump_norm: float = 0.04) -> bool:
    if prev is None:
        return False
    return center_dist_norm(prev, cur, w, h) > max_jump_norm


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
                        # NOTE: yaw_deg is NOT overridden here — the manual
                        # --yaw-deg value is the source of truth because
                        # ARKit's indoor compass heading is unreliable and
                        # differs between devices.
                        self._count += 1
                    if self._count == 1:
                        print(f"[POS] First position update: ({pos[0]:.2f}, {pos[1]:.2f}) phone_heading={heading:.1f}° (ignored, using --yaw-deg={self._args.yaw_deg:.1f}°)")
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
    if "botsort" in args.tracker.lower() and not os.path.exists(tracker_path):
        fallback = resolve_tracker_path("bytetrack.yaml")
        print(f"[WARN] Could not resolve {args.tracker}. Falling back to: {fallback}")
        tracker_path = fallback
    print(f"[INFO] Tracker config: {tracker_path}")

    det_min_dt = 1.0 / max(0.1, args.det_fps)
    last_update_time = 0.0
    last_tracks: List[Dict[str, Any]] = []

    reid = ReidLiteStabilizer(
        history=args.reid_history,
        keep_seconds=args.reid_keep_seconds,
        confirm_frames=3,
    )

    window_name = f"YOLO+Track+Stabilize: {args.camera_id}"
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

            if not hasattr(main, "_last_bbox_by_id"):
                main._last_bbox_by_id = {}

            eligible = []
            ineligible = []

            for t in last_tracks:
                b = t["bbox"]
                tid = t["track_id"]

                prevb = main._last_bbox_by_id.get(tid)
                main._last_bbox_by_id[tid] = b

                if near_border(b, pkt.width, pkt.height, margin=10) or too_small(b, pkt.width, pkt.height, min_frac=0.006) or unstable_box(prevb, b, pkt.width, pkt.height):
                    ineligible.append(t)
                else:
                    eligible.append(t)

            eligible = reid.stabilize(
                pkt.frame_bgr,
                eligible,
                now,
                frame_w=pkt.width,
                frame_h=pkt.height,
                min_iou_for_match=args.reid_min_iou,
                max_dist_norm_for_match=args.reid_max_dist,
                appearance_thresh=args.reid_appearance_thresh,
                tighten=args.reid_tighten_crop,
            )

            last_tracks = eligible + ineligible
            reid.update_memory(pkt.frame_bgr, last_tracks, now, tighten=args.reid_tighten_crop)

            # Emit tracks only when YOLO updated (at det_fps)
            if did_update and args.emit in ("tracks", "camera+tracks"):
                emitter.send(make_tracks_msg(pkt, last_tracks))

            vis = pkt.frame_bgr.copy()
            draw_tracks(vis, last_tracks)
            cv2.putText(
                vis,
                "BoT-SORT preferred + ReID-lite stabilizer. Press 'q' to quit.",
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