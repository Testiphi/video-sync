"""
Video Indexer — Frame↔Timer mapping via calibration points + linear interpolation
"""
import cv2
import numpy as np
from scipy.interpolate import interp1d
import re
import os
import json
import threading


def parse_timer_str(text):
    """Parse timer string like '00:16.681' to seconds (float).
    Handles various OCR noise like ; . , and extra chars.
    """
    # Clean: keep digits, colon, dot
    cleaned = re.sub(r'[^\d:.;,]', '', text)
    # Try MM:SS.mmm or MM:SS,mmm
    m = re.match(r'(\d+)\s*[:;.]\s*(\d{2})\s*[:;,.]\s*(\d{2,3})', cleaned)
    if m:
        minutes = int(m.group(1))
        seconds = int(m.group(2))
        millis_str = m.group(3).ljust(3, '0')[:3]
        millis = int(millis_str)
        return minutes * 60 + seconds + millis / 1000
    # Try MMSSmmm without separators
    m = re.match(r'(\d+)(\d{2})(\d{2,3})', cleaned)
    if m:
        minutes = int(m.group(1))
        seconds = int(m.group(2))
        millis_str = m.group(3).ljust(3, '0')[:3]
        millis = int(millis_str)
        return minutes * 60 + seconds + millis / 1000
    # Try SS.mmm
    m = re.match(r'(\d+)\s*[:;,.]\s*(\d{2,3})', cleaned)
    if m:
        sec_part = int(m.group(1))
        sub = m.group(2).ljust(3, '0')[:3]
        return sec_part + int(sub) / 1000
    return None


def format_timer(seconds):
    """Convert seconds to MM:SS.mmm string"""
    mins = int(seconds // 60)
    secs = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 1000)
    return f"{mins:02d}:{secs:02d}.{millis:03d}"


class VideoIndexer:
    """Handles one video's frame extraction and timer calibration."""

    def __init__(self, video_path, cache_dir="cache"):
        self.video_path = video_path
        self.video_name = os.path.splitext(os.path.basename(video_path))[0]

        self.cap = cv2.VideoCapture(video_path)
        if not self.cap.isOpened():
            raise ValueError(f"Cannot open video: {video_path}")

        self.fps = self.cap.get(cv2.CAP_PROP_FPS)
        raw_fc = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # Sanity-check frame count: OpenCV sometimes returns garbage (>100k)
        if raw_fc > 50000 or (self.fps > 0 and raw_fc > self.fps * 120):
            self.frame_count = self._find_real_frame_count()
        else:
            self.frame_count = raw_fc

        self.duration = self.frame_count / self.fps if self.fps > 0 else 0

        # Calibration: list of (frame_number, timer_seconds)
        self.calibration_points = []

        # Timer ROI as percentages: (x_pct, y_pct, w_pct, h_pct)
        self.roi = None

        # Interpolation function
        self._mapping_fn = None

        # Cache directory for extracted frames
        self.cache_dir = os.path.join(cache_dir, self.video_name)
        os.makedirs(self.cache_dir, exist_ok=True)

        # Thread safety
        self._lock = threading.Lock()

    def _find_real_frame_count(self):
        """Binary-search for the actual last readable frame (OpenCV can lie about count)."""
        cap = cv2.VideoCapture(self.video_path)
        lo, hi = 0, 200000
        while lo < hi:
            mid = (lo + hi + 1) // 2
            cap.set(cv2.CAP_PROP_POS_FRAMES, mid)
            ret, _ = cap.read()
            if ret:
                lo = mid
            else:
                hi = mid - 1
        cap.release()
        print(f"[indexer] Corrected frame count: raw->{lo}")
        return lo

    def close(self):
        with self._lock:
            if hasattr(self, 'cap') and self.cap:
                self.cap.release()
                self.cap = None

    def __del__(self):
        self.close()

    # ---- ROI ----

    def set_roi(self, x_pct, y_pct, w_pct, h_pct):
        """Set timer bounding box as percentage of frame dimensions."""
        self.roi = (x_pct, y_pct, w_pct, h_pct)

    def get_roi_pixels(self):
        """Get ROI in pixel coordinates: (x, y, w, h)."""
        if self.roi is None:
            return None
        x_pct, y_pct, w_pct, h_pct = self.roi
        x = int(self.width * x_pct / 100)
        y = int(self.height * y_pct / 100)
        w = int(self.width * w_pct / 100)
        h = int(self.height * h_pct / 100)
        return (x, y, w, h)

    # ---- Frame extraction ----

    def extract_frame(self, frame_number):
        """Extract a specific frame, returns BGR numpy array or None.
        Thread-safe: creates a fresh VideoCapture per call to avoid
        OpenCV's internal state corruption with concurrent reads.
        """
        frame_number = max(0, min(frame_number, self.frame_count - 1))
        cap = cv2.VideoCapture(self.video_path)
        if not cap.isOpened():
            return None
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number)
        ret, frame = cap.read()
        cap.release()
        if ret:
            return frame
        return None

    def get_frame_as_jpeg(self, frame_number):
        """Get frame as JPEG bytes (for serving via HTTP)."""
        frame = self.extract_frame(frame_number)
        if frame is None:
            return None
        success, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if success:
            return jpeg.tobytes()
        return None

    # ---- Calibration ----

    def add_calibration_point(self, frame_number, timer_seconds):
        """Add a manual (frame, timer) calibration point."""
        # Remove existing point at same frame if any
        self.calibration_points = [
            p for p in self.calibration_points if p[0] != frame_number
        ]
        self.calibration_points.append((frame_number, timer_seconds))
        self.calibration_points.sort(key=lambda p: p[0])
        self._mapping_fn = None  # invalidate

    def remove_calibration_point(self, frame_number):
        self.calibration_points = [
            p for p in self.calibration_points if p[0] != frame_number
        ]
        self._mapping_fn = None

    def build_index(self):
        """Build linear interpolation from calibration points.
        Returns dict with status info.
        """
        if len(self.calibration_points) < 2:
            return {
                "status": "error",
                "message": "Need at least 2 calibration points",
                "points": len(self.calibration_points),
            }

        frames = np.array([p[0] for p in self.calibration_points])
        timers = np.array([p[1] for p in self.calibration_points])

        # Linear interpolation: timer → frame
        self._mapping_fn = interp1d(
            timers, frames, kind='linear',
            bounds_error=False, fill_value='extrapolate'
        )

        # Also build inverse: frame → timer (for display)
        self._inv_fn = interp1d(
            frames, timers, kind='linear',
            bounds_error=False, fill_value='extrapolate'
        )

        return {
            "status": "ok",
            "points": len(self.calibration_points),
            "timer_min": float(np.min(timers)),
            "timer_max": float(np.max(timers)),
            "frame_min": int(np.min(frames)),
            "frame_max": int(np.max(frames)),
        }

    def timer_to_frame(self, timer_seconds):
        """Given timer value, return the matching frame number (int)."""
        if self._mapping_fn is None:
            return None
        frame = float(self._mapping_fn(timer_seconds))
        return int(round(frame))

    def frame_to_timer(self, frame_number):
        """Given frame number, return estimated timer value."""
        if self._inv_fn is None:
            return None
        return float(self._inv_fn(frame_number))

    # ---- Sampling ----

    def get_sample_frames(self, n_samples=6):
        """Get evenly-spaced frame numbers for calibration sampling."""
        if self.frame_count == 0:
            return []
        # Skip first few frames (loading screen) and last few (end screen)
        start = int(self.frame_count * 0.05)
        end = int(self.frame_count * 0.95)
        span = end - start
        if span <= 0:
            return list(range(0, self.frame_count, max(1, self.frame_count // n_samples)))
        step = span // (n_samples - 1) if n_samples > 1 else span
        return [start + i * step for i in range(min(n_samples, n_samples))]

    # ---- State serialization ----

    def to_dict(self):
        return {
            "video_name": self.video_name,
            "video_path": self.video_path,
            "fps": self.fps,
            "frame_count": self.frame_count,
            "width": self.width,
            "height": self.height,
            "duration": self.duration,
            "roi": self.roi,
            "calibration_points": [(int(f), float(t)) for f, t in self.calibration_points],
            "indexed": self._mapping_fn is not None,
        }

    def to_json(self):
        return json.dumps(self.to_dict(), indent=2)
