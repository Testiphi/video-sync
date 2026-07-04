"""
FrameSync — Frame-accurate video comparison server
"""
import os
import json
import base64
import sys
sys.stdout.reconfigure(encoding='utf-8')

from flask import (
    Flask, request, jsonify, send_file, render_template,
    Response, session
)
from indexer import VideoIndexer, parse_timer_str, format_timer
import uuid
import cv2
import numpy as np

app = Flask(__name__)
app.secret_key = os.urandom(24).hex()

# ──────────────────────────────────────────
# In-memory stores (session-id → data)
# ──────────────────────────────────────────
indexers = {}          # idx_id → VideoIndexer
session_videos = {}    # session_id → {"a": idx_id, "b": idx_id}
CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache")
os.makedirs(CACHE_DIR, exist_ok=True)

# ──────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────

def get_session():
    sid = session.get("sid")
    if not sid:
        sid = uuid.uuid4().hex[:12]
        session["sid"] = sid
        session_videos[sid] = {"a": None, "b": None}
    return sid


def get_or_create_indexer(sid, label):
    """Get existing indexer for (session, label) or None."""
    vid = session_videos.get(sid, {}).get(label)
    if vid and vid in indexers:
        return indexers[vid]
    return None


# ──────────────────────────────────────────
# Routes
# ──────────────────────────────────────────

@app.route("/")
def index():
    get_session()  # ensure session created
    return render_template("index.html")


# ---- Video Loading ----

import tempfile


UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


@app.route("/api/upload", methods=["POST"])
def upload_video():
    """Upload a video file and return its saved path."""
    label = request.form.get("label", "a")
    if "file" not in request.files:
        return jsonify({"status": "error", "message": "No file provided"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"status": "error", "message": "Empty filename"}), 400

    # Save to uploads dir
    safe_name = f"{uuid.uuid4().hex[:8]}_{file.filename}"
    save_path = os.path.join(UPLOAD_DIR, safe_name)
    file.save(save_path)

    return jsonify({
        "status": "ok",
        "path": save_path,
        "idx_id": None,  # Will be set by load-video
    })

# ---- OCR (lazy reader) ----

_ocr_reader = None

def _get_ocr():
    """Lazy-init EasyOCR reader (first call takes ~30s)."""
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr
        _ocr_reader = easyocr.Reader(['en'], gpu=False)
    return _ocr_reader


@app.route("/api/video/<idx_id>/ocr-samples")
def ocr_samples(idx_id):
    """Run OCR on sample frames' timer ROI, return parsed timer values."""
    idx = indexers.get(idx_id)
    if not idx:
        return jsonify({"status": "error", "message": "Not found"}), 404
    if idx.roi is None:
        return jsonify({"status": "error", "message": "ROI not set"}), 400

    n = request.args.get("n", 6, type=int)
    frames = idx.get_sample_frames(n)

    reader = _get_ocr()
    results = []

    for frame_number in frames:
        frame_img = idx.extract_frame(frame_number)
        if frame_img is None:
            results.append({"frame": frame_number, "status": "extract_failed"})
            continue

        h, w = frame_img.shape[:2]
        x_pct, y_pct, w_pct, h_pct = idx.roi
        x = int(w * x_pct / 100)
        y = int(h * y_pct / 100)
        rw = int(w * w_pct / 100)
        rh = int(h * h_pct / 100)
        roi = frame_img[y:y+rh, x:x+rw]

        texts = reader.readtext(roi)
        entry = {"frame": frame_number}

        if texts:
            bbox, raw_text, conf = texts[0]
            entry["raw"] = raw_text
            entry["confidence"] = round(conf, 3)
            timer_sec = parse_timer_str(raw_text)
            if timer_sec is not None:
                entry["timer_seconds"] = round(timer_sec, 3)
                entry["timer_str"] = format_timer(timer_sec)
                entry["status"] = "ok"
            else:
                entry["status"] = "parse_failed"
        else:
            entry["status"] = "no_text"

        results.append(entry)

    return jsonify({"status": "ok", "reader_ready": _ocr_reader is not None, "results": results})


@app.route("/api/load-video", methods=["POST"])
def load_video():
    data = request.get_json()
    path = data.get("path", "").strip()
    label = data.get("label", "a")  # "a" or "b"

    if not os.path.exists(path):
        return jsonify({"status": "error", "message": "File not found"}), 400

    sid = get_session()

    # Create indexer
    try:
        idx = VideoIndexer(path, cache_dir=CACHE_DIR)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 400

    idx_id = uuid.uuid4().hex[:8]
    indexers[idx_id] = idx

    # Store in session
    session_videos[sid][label] = idx_id

    return jsonify({
        "status": "ok",
        "idx_id": idx_id,
        "video": idx.to_dict(),
    })


@app.route("/api/video/<idx_id>/info")
def video_info(idx_id):
    idx = indexers.get(idx_id)
    if not idx:
        return jsonify({"status": "error", "message": "Not found"}), 404
    return jsonify(idx.to_dict())


# ---- Frame extraction ----

@app.route("/api/video/<idx_id>/frame/<int:frame>")
def get_frame(idx_id, frame):
    idx = indexers.get(idx_id)
    if not idx:
        return jsonify({"status": "error", "message": "Not found"}), 404

    jpeg_bytes = idx.get_frame_as_jpeg(frame)
    if jpeg_bytes is None:
        return jsonify({"status": "error", "message": "Frame extraction failed"}), 500

    return Response(jpeg_bytes, mimetype="image/jpeg")


@app.route("/api/video/<idx_id>/frame-timer/<int:frame>")
def get_frame_timer_roi(idx_id, frame):
    """Return the timer ROI region cropped and scaled up (~3x) for preview."""
    idx = indexers.get(idx_id)
    if not idx:
        return jsonify({"status": "error", "message": "Not found"}), 404
    if idx.roi is None:
        # Fall back to full frame
        return get_frame(idx_id, frame)

    frame_img = idx.extract_frame(frame)
    if frame_img is None:
        return jsonify({"status": "error", "message": "Frame extraction failed"}), 500

    h, w = frame_img.shape[:2]
    x_pct, y_pct, w_pct, h_pct = idx.roi
    x = int(w * x_pct / 100)
    y = int(h * y_pct / 100)
    rw = int(w * w_pct / 100)
    rh = int(h * h_pct / 100)

    # Crop and scale up 3x
    roi = frame_img[y:y+rh, x:x+rw]
    scaled = cv2.resize(roi, (rw * 3, rh * 3), interpolation=cv2.INTER_NEAREST)

    success, jpeg = cv2.imencode('.jpg', scaled, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if success:
        return Response(jpeg.tobytes(), mimetype="image/jpeg")
    return jsonify({"status": "error", "message": "Encoding failed"}), 500


# ---- ROI ----

@app.route("/api/video/<idx_id>/roi", methods=["POST"])
def set_roi(idx_id):
    idx = indexers.get(idx_id)
    if not idx:
        return jsonify({"status": "error", "message": "Not found"}), 404

    data = request.get_json()
    idx.set_roi(data["x"], data["y"], data["w"], data["h"])
    return jsonify({"status": "ok", "roi": idx.roi})


# ---- Calibration ----

@app.route("/api/video/<idx_id>/samples")
def get_samples(idx_id):
    idx = indexers.get(idx_id)
    if not idx:
        return jsonify({"status": "error", "message": "Not found"}), 404

    n = request.args.get("n", 6, type=int)
    frames = idx.get_sample_frames(n)
    return jsonify({
        "status": "ok",
        "frame_count": idx.frame_count,
        "fps": idx.fps,
        "samples": frames,
    })


@app.route("/api/video/<idx_id>/calibrate", methods=["POST"])
def add_calibration(idx_id):
    idx = indexers.get(idx_id)
    if not idx:
        return jsonify({"status": "error", "message": "Not found"}), 404

    data = request.get_json()
    frame = data.get("frame")
    timer_str = data.get("timer", "").strip()
    timer_sec = data.get("timer_seconds")

    if timer_sec is None and timer_str:
        timer_sec = parse_timer_str(timer_str)

    if timer_sec is None:
        return jsonify({"status": "error", "message": "Invalid timer value"}), 400

    idx.add_calibration_point(frame, timer_sec)

    return jsonify({
        "status": "ok",
        "points": len(idx.calibration_points),
    })


@app.route("/api/video/<idx_id>/calibration-points")
def get_calibration_points(idx_id):
    idx = indexers.get(idx_id)
    if not idx:
        return jsonify({"status": "error", "message": "Not found"}), 404

    points = [
        {"frame": int(f), "timer_seconds": float(t), "timer_str": format_timer(t)}
        for f, t in idx.calibration_points
    ]
    return jsonify({"status": "ok", "points": points})


# ---- Index (build mapping) ----

@app.route("/api/video/<idx_id>/build-index", methods=["POST"])
def build_index(idx_id):
    idx = indexers.get(idx_id)
    if not idx:
        return jsonify({"status": "error", "message": "Not found"}), 404

    result = idx.build_index()
    return jsonify(result)


# ---- Sync (takes explicit idx ids) ----

@app.route("/api/sync")
def sync():
    idx_a_id = request.args.get("a")
    idx_b_id = request.args.get("b")
    idx_a = indexers.get(idx_a_id)
    idx_b = indexers.get(idx_b_id)

    if not idx_a or not idx_b:
        return jsonify({"status": "error", "message": "Both videos required. Pass ?a=<id>&b=<id>"}), 400
    if not idx_a._mapping_fn or not idx_b._mapping_fn:
        return jsonify({"status": "error", "message": "Both videos must be indexed"}), 400

    timer = request.args.get("timer", type=float)
    if timer is None:
        return jsonify({"status": "error", "message": "timer parameter required"}), 400

    fa = idx_a.timer_to_frame(timer)
    fb = idx_b.timer_to_frame(timer)
    ta = idx_a.frame_to_timer(fa)
    tb = idx_b.frame_to_timer(fb)

    return jsonify({
        "status": "ok",
        "timer": timer,
        "a": {
            "frame": fa if fa else None,
            "timer": round(ta, 3) if ta else None,
            "timer_str": format_timer(ta) if ta else None,
            "video_name": idx_a.video_name,
        },
        "b": {
            "frame": fb if fb else None,
            "timer": round(tb, 3) if tb else None,
            "timer_str": format_timer(tb) if tb else None,
            "video_name": idx_b.video_name,
        },
    })


@app.route("/api/sync-range")
def sync_range():
    idx_a_id = request.args.get("a")
    idx_b_id = request.args.get("b")
    idx_a = indexers.get(idx_a_id)
    idx_b = indexers.get(idx_b_id)

    if not idx_a or not idx_b:
        return jsonify({"status": "error", "message": "Pass ?a=<id>&b=<id>"}), 400
    if not idx_a.calibration_points or not idx_b.calibration_points:
        return jsonify({"status": "error", "message": "Not indexed"}), 400

    t_min = max(idx_a.calibration_points[0][1], idx_b.calibration_points[0][1])
    t_max = min(idx_a.calibration_points[-1][1], idx_b.calibration_points[-1][1])

    return jsonify({
        "status": "ok",
        "timer_min": t_min,
        "timer_max": t_max,
        "timer_count": max(100, int((t_max - t_min) * 100)),
        "fps_a": idx_a.fps,
        "fps_b": idx_b.fps,
    })


# ---- Cleanup ----

@app.route("/api/unload-video/<label>", methods=["POST"])
def unload_video(label):
    """Unload a single video by its label (a or b)."""
    if label not in ("a", "b"):
        return jsonify({"status": "error", "message": "Invalid label"}), 400

    sid = get_session()
    vids = session_videos.get(sid, {})
    vid = vids.get(label)
    if vid and vid in indexers:
        idx = indexers.pop(vid)
        idx.close()
    vids[label] = None
    return jsonify({"status": "ok"})


@app.route("/api/reset", methods=["POST"])
def reset():
    sid = get_session()
    vids = session_videos.get(sid, {})
    for label in ("a", "b"):
        vid = vids.get(label)
        if vid and vid in indexers:
            idx = indexers.pop(vid)
            idx.close()
        vids[label] = None
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"[*] FrameSync running at http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=True)
