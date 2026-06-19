from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    send_from_directory,
    url_for,
    abort,
    redirect,
    send_file,
)
from werkzeug.utils import secure_filename
import os, sqlite3, json, datetime, random, string, logging, time, io
import tempfile
import urllib.request, urllib.error

# -------------------------
# PATHS & INITIALIZATION
# -------------------------
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
DB_PATH = os.path.join(BASE_DIR, "app.db")

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024

# basic logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("airpulse")


# -------------------------
# DB CONNECT & INIT
# -------------------------
def get_db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = get_db()
    # base recordings table
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS recordings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            created_at TEXT NOT NULL,
            duration_sec REAL,
            device_label TEXT,
            notes TEXT
        )
    """
    )
    # shares table for expiring share tokens
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS shares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            record_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            expires_at TEXT
        )
    """
    )
    # ensure 'title' column exists for recordings (migration for older DBs)
    try:
        cols = [r[1] for r in con.execute("PRAGMA table_info(recordings)").fetchall()]
        if "title" not in cols:
            con.execute("ALTER TABLE recordings ADD COLUMN title TEXT")
    except Exception:
        # if pragma fails (very old sqlite), ignore
        pass
    con.commit()
    con.close()


with app.app_context():
    init_db()


# -------------------------
# FILTER
# -------------------------
@app.template_filter("dt")
def dt(value):
    if not value:
        return ""
    try:
        s = value
        if isinstance(s, str) and s.endswith("Z"):
            s = s[:-1]
        dtobj = datetime.datetime.fromisoformat(s)
        return dtobj.strftime("%b %d, %Y %H:%M")
    except Exception:
        return value


# -------------------------
# BASIC PAGES
# -------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/diagnose")
def diagnose():
    return render_template("diagnose.html")


@app.route("/upload_wav")
def upload_wav():
    return render_template("upload_manual.html")


@app.route("/recordings")
def recordings():
    con = get_db()
    rows = con.execute("SELECT * FROM recordings ORDER BY id DESC").fetchall()
    con.close()
    return render_template("recordings.html", recordings=rows)


@app.route("/recordings/<int:rec_id>")
def recording_detail(rec_id):
    con = get_db()
    row = con.execute("SELECT * FROM recordings WHERE id=?", (rec_id,)).fetchone()
    con.close()
    if not row:
        abort(404)
    return render_template("recording_detail.html", rec=row)


@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(app.config["UPLOAD_FOLDER"], filename)


# -------------------------
# CHATBOT PAGE + API FOR CHAT CONTEXT
# -------------------------
@app.route("/chatbot")
def chatbot():
    """Render the standalone AI ChatBot page."""
    return render_template("chatbot.html")


@app.route("/api/recordings_for_chat")
def api_recordings_for_chat():
    """
    Return a list of recordings with lightweight analysis summaries,
    so the chatbot page can display context for each recording.
    """
    con = get_db()
    rows = con.execute(
        "SELECT id, filename, title, created_at FROM recordings ORDER BY id DESC LIMIT 50"
    ).fetchall()
    con.close()

    result = []
    for row in rows:
        audio_path = os.path.join(UPLOAD_FOLDER, row["filename"])
        summary = None
        try:
            from ml_inference import run_inference

            res = run_inference(audio_path)
            summary = {
                "decision": res.get("decision"),
                "predicted_class": res.get("predicted_class"),
                "confidence": res.get("confidence"),
                "class_probabilities": res.get("all_class_probabilities"),
            }
        except Exception:
            summary = None

        result.append(
            {
                "id": row["id"],
                "filename": row["filename"],
                "title": row["title"],
                "created_at": row["created_at"],
                "summary": summary,
            }
        )

    return jsonify({"ok": True, "recordings": result})


# -------------------------
# UPLOAD AUDIO (MIC OR MANUAL)
# -------------------------
@app.post("/api/upload")
def api_upload():
    if "audio" not in request.files:
        return jsonify({"ok": False, "error": "No audio provided"}), 400

    f = request.files["audio"]

    # metadata
    meta_raw = request.form.get("meta", "{}")
    try:
        meta = json.loads(meta_raw)
    except Exception:
        meta = {}

    # filename
    ext = os.path.splitext(f.filename or "")[1].lower() or ".webm"
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=4))
    filename = secure_filename(f"rec-{ts}-{rand}{ext}")

    save_path = os.path.join(UPLOAD_FOLDER, filename)
    f.save(save_path)

    # save to db
    con = get_db()
    title = meta.get("title") if isinstance(meta, dict) else None
    con.execute(
        "INSERT INTO recordings(filename, created_at, duration_sec, device_label, notes, title) VALUES(?,?,?,?,?,?)",
        (
            filename,
            datetime.datetime.now().isoformat(),
            float(meta.get("durationSec") or 0),
            meta.get("deviceLabel"),
            meta.get("notes"),
            title,
        ),
    )
    con.commit()
    rec_id = con.execute("SELECT last_insert_rowid() as id").fetchone()["id"]
    con.close()

    return jsonify({"ok": True, "id": rec_id, "filename": filename})


# -------------------------
# ML ANALYSIS
# -------------------------
@app.post("/api/analyze/<int:rec_id>")
def api_analyze(rec_id):
    from ml_inference import run_inference  # lazy import

    con = get_db()
    row = con.execute("SELECT * FROM recordings WHERE id=?", (rec_id,)).fetchone()
    con.close()

    if not row:
        return jsonify({"ok": False, "error": "Recording not found"}), 404

    audio_path = os.path.join(UPLOAD_FOLDER, row["filename"])

    if not os.path.exists(audio_path):
        return jsonify({"ok": False, "error": "Audio file missing"}), 404

    start = time.time()
    try:
        results = run_inference(audio_path)
        took_ms = int((time.time() - start) * 1000)
        logger.info(
            "Analyzed %s -> %s (%.2f%%) in %dms",
            row["filename"],
            results.get("predicted_class"),
            results.get("confidence"),
            took_ms,
        )

        return jsonify(
            {
                "ok": True,
                "took_ms": took_ms,
                "results": {
                    "overall_decision": results["decision"],
                    "predicted_class": results["predicted_class"],
                    "confidence_percent": results["confidence"],
                    "class_probabilities": results["all_class_probabilities"],
                },
            }
        )

    except Exception as e:
        logger.exception("ML inference error for %s", audio_path)
        err_msg = str(e)
        payload = {"ok": False, "error": "ML Error", "detail": err_msg}

        if isinstance(e, FileNotFoundError) or "Model file not found" in err_msg:
            payload.update(
                {
                    "error_type": "model_missing",
                    "hint": "Model file not found on server. Set MODEL_PATH or place the model file in the configured path.",
                }
            )
        elif isinstance(e, RuntimeError) and "Failed to load model" in err_msg:
            payload.update(
                {
                    "error_type": "model_load_failed",
                    "hint": "Failed to load model. The model file may be corrupted or incompatible with the expected architecture.",
                }
            )
        elif (
            "librosa" in err_msg.lower()
            or "audioread" in err_msg.lower()
            or "ffmpeg" in err_msg.lower()
        ):
            payload.update(
                {
                    "error_type": "audio_processing_error",
                    "hint": "Audio decode/processing failed. Try uploading a WAV (PCM) file or ensure ffmpeg is installed on the server.",
                }
            )
        else:
            payload.update(
                {
                    "error_type": "internal_error",
                    "hint": "An internal error occurred during analysis. Check server logs for details.",
                }
            )

        return jsonify(payload), 500


# -------------------------
# HEALTH & MODEL INFO
# -------------------------
@app.route("/health")
def health():
    return jsonify(
        {
            "ok": True,
            "time": datetime.datetime.utcnow().isoformat() + "Z",
            "db_exists": os.path.exists(DB_PATH),
            "uploads_writable": os.access(UPLOAD_FOLDER, os.W_OK),
        }
    )


@app.route("/model-info")
def model_info():
    try:
        from ml_inference import get_model_info

        info = get_model_info()
        return jsonify({"ok": True, "model": info})
    except Exception as e:
        logger.exception("Failed to read model info")
        return jsonify({"ok": False, "error": str(e)}), 500


# -------------------------
# SHARING & DELETION
# -------------------------
@app.route("/share/<int:rec_id>")
def share_redirect(rec_id):
    con = get_db()
    row = con.execute("SELECT * FROM recordings WHERE id=?", (rec_id,)).fetchone()
    con.close()
    if not row:
        abort(404)
    return redirect(url_for("uploaded_file", filename=row["filename"]))


@app.route("/api/recordings/<int:rec_id>", methods=["DELETE"])
def api_delete_recording(rec_id):
    con = get_db()
    row = con.execute("SELECT * FROM recordings WHERE id=?", (rec_id,)).fetchone()
    if not row:
        con.close()
        return jsonify({"ok": False, "error": "Recording not found"}), 404

    filename = row["filename"]
    file_path = os.path.join(UPLOAD_FOLDER, filename)
    try:
        if os.path.exists(file_path):
            os.remove(file_path)
            logger.info("Deleted file %s", file_path)
    except Exception as e:
        logger.warning("Failed to delete file %s: %s", file_path, e)

    try:
        con.execute("DELETE FROM shares WHERE record_id=?", (rec_id,))
    except Exception:
        pass

    con.execute("DELETE FROM recordings WHERE id=?", (rec_id,))
    con.commit()
    con.close()

    return jsonify({"ok": True})


def _generate_token(n=28):
    import secrets

    return secrets.token_urlsafe(n)


@app.route("/api/share/<int:rec_id>")
def api_share(rec_id):
    con = get_db()
    row = con.execute("SELECT * FROM recordings WHERE id=?", (rec_id,)).fetchone()
    con.close()
    if not row:
        return jsonify({"ok": False, "error": "Recording not found"}), 404
    url = url_for("uploaded_file", filename=row["filename"], _external=True)
    return jsonify({"ok": True, "url": url})


@app.route("/api/share/create/<int:rec_id>")
def api_share_create(rec_id):
    try:
        minutes = int(request.args.get("minutes") or 60)
    except Exception:
        minutes = 60
    con = get_db()
    row = con.execute("SELECT * FROM recordings WHERE id=?", (rec_id,)).fetchone()
    if not row:
        con.close()
        return jsonify({"ok": False, "error": "Recording not found"}), 404

    token = _generate_token(32)
    now = datetime.datetime.utcnow()
    created_at = now.isoformat() + "Z"
    expires_at = None
    if minutes > 0:
        expires = now + datetime.timedelta(minutes=minutes)
        expires_at = expires.isoformat() + "Z"

    con.execute(
        "INSERT INTO shares(record_id, token, created_at, expires_at) VALUES(?,?,?,?)",
        (rec_id, token, created_at, expires_at),
    )
    con.commit()
    con.close()

    short = url_for("share_token", token=token, _external=True)
    return jsonify({"ok": True, "token": token, "url": short, "expires_at": expires_at})


@app.route("/s/<token>")
def share_token(token):
    con = get_db()
    s = con.execute("SELECT * FROM shares WHERE token=?", (token,)).fetchone()
    if not s:
        con.close()
        abort(404)
    if s["expires_at"]:
        try:
            exp = datetime.datetime.fromisoformat(s["expires_at"].replace("Z", ""))
        except Exception:
            exp = None
        if exp and datetime.datetime.utcnow() > exp:
            con.close()
            return ("Share link expired", 410)
    row = con.execute(
        "SELECT * FROM recordings WHERE id=?", (s["record_id"],)
    ).fetchone()
    con.close()
    if not row:
        abort(404)
    return redirect(url_for("uploaded_file", filename=row["filename"]))


# -------------------------
# CHAT PROXY TO OPENAI
# -------------------------
@app.route("/api/chat", methods=["POST"])
def api_chat():
    payload = request.get_json(silent=True) or {}
    messages = payload.get("messages")
    if not messages or not isinstance(messages, list):
        return jsonify({"ok": False, "error": "No messages provided"}), 400

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return jsonify(
            {
                "ok": False,
                "error": "OpenAI API key not configured on server. Set OPENAI_API_KEY environment variable.",
            }
        ), 500

    body = {
        "model": "gpt-3.5-turbo",
        "messages": messages,
        "max_tokens": 512,
        "temperature": 0.7,
    }

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp_body = resp.read().decode("utf-8")
            j = json.loads(resp_body)
            try:
                reply = j["choices"][0]["message"]["content"]
            except Exception:
                reply = json.dumps(j)
            return jsonify({"ok": True, "reply": reply})
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8")
        except Exception:
            detail = str(e)
        logger.exception("OpenAI HTTP error")
        return (
            jsonify({"ok": False, "error": "OpenAI API error", "detail": detail}),
            500,
        )
    except Exception as e:
        logger.exception("OpenAI proxy failed")
        return (
            jsonify({"ok": False, "error": "Chat proxy failed", "detail": str(e)}),
            500,
        )


# -------------------------
# SPECTROGRAM ENDPOINTS
# -------------------------
@app.route("/api/spectrogram/<int:rec_id>")
def api_spectrogram(rec_id):
    try:
        chunk = int(request.args.get("chunk", "0"))
    except Exception:
        chunk = 0

    con = get_db()
    row = con.execute("SELECT * FROM recordings WHERE id=?", (rec_id,)).fetchone()
    con.close()
    if not row:
        return ("Recording not found", 404)

    audio_path = os.path.join(UPLOAD_FOLDER, row["filename"])
    if not os.path.exists(audio_path):
        return ("Audio file missing", 404)

    try:
        from ml_inference import audio_to_png_spectrograms

        specs = audio_to_png_spectrograms(audio_path)
        if not specs:
            return ("No spectrograms generated", 500)
        if chunk < 0 or chunk >= len(specs):
            return ("Chunk index out of range", 404)

        img = specs[chunk]
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return send_file(buf, mimetype="image/png")
    except Exception as e:
        logger.exception("Failed to generate spectrogram for %s", audio_path)
        return (f"Spectrogram generation error: {e}", 500)


@app.post("/api/spectrogram_preview")
def api_spectrogram_preview():
    if "audio" not in request.files:
        return jsonify({"ok": False, "error": "No audio provided"}), 400

    f = request.files["audio"]
    try:
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        tmp.write(f.read())
        tmp.flush()
        tmp.close()

        from ml_inference import audio_to_png_spectrograms

        specs = audio_to_png_spectrograms(tmp.name)
        try:
            os.unlink(tmp.name)
        except Exception:
            pass

        if not specs:
            return jsonify({"ok": False, "error": "No spectrogram generated"}), 500

        buf = io.BytesIO()
        specs[0].save(buf, format="PNG")
        buf.seek(0)
        return send_file(buf, mimetype="image/png")
    except Exception as e:
        logger.exception("Spectrogram preview generation failed")
        return jsonify({"ok": False, "error": str(e)}), 500


# -------------------------
# RUN SERVER
# -------------------------
if __name__ == "__main__":
    app.run(debug=True)
