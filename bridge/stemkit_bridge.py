"""OpenSpoty Bridge: lets the OpenSpoty app on your phone use this PC.

- lists the songs already split by the StemKit desktop app (same library)
- sends their stems to the phone (AAC .m4a, transcoded once and cached)
- splits new songs on the PC: files uploaded from the phone, YouTube links,
  YouTube searches and Spotify links (resolved to a YouTube search)

Runs with StemKit's own private Python (no extra packages) and reuses its
separation scripts, its ffmpeg and its yt-dlp. API requests need the phone PIN
or the per-process token injected into the desktop UI; /api/ping is public.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid
import wave
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0.0"
PORT = int(os.environ.get("STEMKIT_BRIDGE_PORT", "8777"))
TLS_PORT = int(os.environ.get("STEMKIT_BRIDGE_TLS_PORT", str(PORT + 1)))

IS_WIN = sys.platform == "win32"
DATA_DIR = Path(
    os.environ.get("STEMKIT_DATA_DIR", "").strip()
    or (Path(os.environ.get("APPDATA", Path.home())) / "StemKit")
)
APP_DIR = Path(
    os.environ.get("STEMKIT_APP_DIR", "").strip()
    or (Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Programs" / "stemkit")
)
VENV_BIN = DATA_DIR / "venv" / ("Scripts" if IS_WIN else "bin")
EXE = ".exe" if IS_WIN else ""
VENV_PY = VENV_BIN / f"python{EXE}"
YTDLP = VENV_BIN / f"yt-dlp{EXE}"
SEPARATE_PY = APP_DIR / "resources" / "python" / "separate.py"
LIBRARY = DATA_DIR / "library.json"
SONGS = DATA_DIR / "songs"
UPLOADS = DATA_DIR / "bridge-uploads"
CONFIG = DATA_DIR / "bridge.json"

AUDIO_EXTENSIONS = {
    "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma", "aiff", "aif", "alac", "webm",
}
ALL_STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]
FOUR_STEMS = ["vocals", "drums", "bass", "other"]
ID_RE = re.compile(r"^[\w-]{1,64}$")
STEM_RE = re.compile(r"^(vocals|drums|bass|guitar|piano|other)$")

library_lock = threading.Lock()
separation_slot = threading.Semaphore(1)  # CPU-only PC: one split at a time
transcode_locks: dict[str, threading.Lock] = {}
transcode_guard = threading.Lock()


def find_ffmpeg() -> str:
    bundled = APP_DIR / "resources" / "ffmpeg" / f"ffmpeg{EXE}"
    if bundled.exists():
        return str(bundled)
    found = shutil.which("ffmpeg")
    if found:
        return found
    raise RuntimeError("ffmpeg non trovato: reinstalla StemKit")


def js_runtime_args() -> list[str]:
    # yt-dlp needs a JS runtime for YouTube's challenges, like StemKit does
    for kind in ("deno", "node"):
        path = shutil.which(kind)
        if path:
            return ["--js-runtimes", f"{kind}:{path}"]
    return []


# ---------------------------------------------------------------- config / PIN


def load_config() -> dict:
    try:
        cfg = json.loads(CONFIG.read_text("utf8"))
    except Exception:
        cfg = {}
    if not re.fullmatch(r"[0-9]{12}", str(cfg.get("pin", ""))):
        cfg["pin"] = f"{secrets.randbelow(1_000_000_000_000):012d}"
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        CONFIG.write_text(json.dumps(cfg, indent=2), "utf8")
    return cfg


CFG = load_config()
# A per-process credential used only by the desktop UI served on loopback.
# Unlike the phone PIN, this token is never displayed or persisted.
LOCAL_UI_TOKEN = secrets.token_urlsafe(32)
TLS_CERT_PATH: Path | None = None
TLS_KEY_PATH: Path | None = None
TLS_FINGERPRINT = ""

failed_auth: dict[str, list[float]] = {}
failed_auth_lock = threading.Lock()
MAX_FAILS = 20
LOCKOUT_S = 600


def auth_locked(ip: str) -> bool:
    now = time.time()
    with failed_auth_lock:
        hits = [t for t in failed_auth.get(ip, []) if now - t < LOCKOUT_S]
        failed_auth[ip] = hits
        return len(hits) >= MAX_FAILS


def note_failed_auth(ip: str) -> None:
    with failed_auth_lock:
        failed_auth.setdefault(ip, []).append(time.time())


# ---------------------------------------------------------------- library


def load_songs() -> list[dict]:
    try:
        data = json.loads(LIBRARY.read_text("utf8"))
        return data["songs"] if isinstance(data.get("songs"), list) else []
    except Exception:
        return []


def upsert_song(song: dict) -> None:
    # read-modify-write right away: the desktop app reads this same file
    with library_lock:
        songs = [s for s in load_songs() if s.get("videoId") != song["videoId"]]
        songs.insert(0, song)
        LIBRARY.parent.mkdir(parents=True, exist_ok=True)
        tmp = LIBRARY.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"songs": songs}, indent=2), "utf8")
        os.replace(tmp, LIBRARY)


def stems_dir(song_id: str) -> Path:
    return SONGS / song_id / "stems"


def song_stems(song: dict) -> list[str]:
    return song.get("stems") or FOUR_STEMS


def song_ready(song: dict) -> bool:
    d = stems_dir(song["videoId"])
    return all((d / f"{s}.wav").exists() for s in song_stems(song))


def public_song(song: dict) -> dict:
    return {
        "id": song["videoId"],
        "title": song.get("title") or "Senza titolo",
        "duration": song.get("duration") or 0,
        "addedAt": song.get("addedAt") or 0,
        "model": song.get("model"),
        "stems": song_stems(song),
        "source": "local" if song.get("source") == "local" else "youtube",
        "ready": song_ready(song),
        "hasOriginal": (SONGS / song["videoId"] / "mix.wav").exists(),
    }


def local_song_id(file_path: str) -> str:
    # same FNV-1a hash StemKit uses for local files (src/shared/local.ts),
    # so the desktop app treats bridge uploads exactly like its own imports
    h = 0x811C9DC5
    for ch in file_path:
        h ^= ord(ch) & 0xFFFF
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"local-{h:08x}"


def wav_duration(path: Path) -> int:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / w.getframerate())
    except Exception:
        return 0


def parse_youtube_id(url: str) -> str | None:
    url = url.strip()
    if re.fullmatch(r"[\w-]{11}", url):
        return url
    m = re.search(r"(?:v=|youtu\.be/|/shorts/|/embed/|/live/)([\w-]{11})", url)
    return m.group(1) if m else None


def stemkit_settings() -> dict:
    try:
        return json.loads((DATA_DIR / "settings.json").read_text("utf8"))
    except Exception:
        return {}


# ---------------------------------------------------------------- transcoding


def _transcode(src: Path, out: Path, fmt: str) -> Path:
    """Cached phone copy of src: FLAC (lossless) or AAC 256 kbps."""
    if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
        return out
    with transcode_guard:
        lock = transcode_locks.setdefault(str(out), threading.Lock())
    with lock:
        if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
            return out
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.stem + ".tmp" + out.suffix)
        codec = (["-c:a", "flac", "-sample_fmt", "s16"] if fmt == "flac"
                 else ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"])
        subprocess.run(
            [find_ffmpeg(), "-y", "-v", "error", "-i", str(src), *codec, "-ar", "44100", "-ac", "2", str(tmp)],
            check=True, capture_output=True, **no_window(),
        )
        os.replace(tmp, out)
    return out


def mobile_stem(song_id: str, stem: str, fmt: str = "m4a") -> Path:
    """Phone copy of a stem (FLAC ~13 MB or AAC ~6 MB instead of ~70 MB of float WAV)."""
    src = stems_dir(song_id) / f"{stem}.wav"
    if not src.exists():
        raise FileNotFoundError(stem)
    return _transcode(src, SONGS / song_id / "mobile" / f"{stem}.{fmt}", fmt)


def mobile_original(song_id: str, fmt: str = "m4a") -> Path:
    """The whole song, unseparated, for listening (from StemKit's mix.wav)."""
    src = SONGS / song_id / "mix.wav"
    if not src.exists():
        raise FileNotFoundError("original")
    return _transcode(src, SONGS / song_id / "mobile" / f"original.{fmt}", fmt)


def no_window() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WIN else {}


# ---------------------------------------------------------------- jobs


class Job:
    def __init__(self, kind: str, title: str, stems: list[str]):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.title = title
        self.stems = stems
        self.stage = "queued"
        self.pct = 0
        self.message = "In coda"
        self.state = "running"
        self.error: str | None = None
        self.song_id: str | None = None
        self.created = time.time()
        self.cancelled = False
        self.proc: subprocess.Popen | None = None

    def public(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "title": self.title, "stage": self.stage,
            "pct": self.pct, "message": self.message, "state": self.state,
            "error": self.error, "songId": self.song_id, "created": self.created,
        }


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()


class Cancelled(Exception):
    pass


def set_progress(job: Job, stage: str, pct: float, message: str | None = None) -> None:
    if job.cancelled:
        raise Cancelled()
    job.stage = stage
    job.pct = max(0, min(100, int(pct)))
    if message:
        job.message = message


def run_tool(job: Job, args: list[str], on_line=None) -> str:
    if job.cancelled:
        raise Cancelled()
    proc = subprocess.Popen(
        args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace", bufsize=1, **no_window(),
    )
    job.proc = proc
    err_tail: list[str] = []

    def drain_err():
        for line in proc.stderr:  # type: ignore[union-attr]
            err_tail.append(line.rstrip())
            del err_tail[:-5]

    t = threading.Thread(target=drain_err, daemon=True)
    t.start()
    out: list[str] = []
    for line in proc.stdout:  # type: ignore[union-attr]
        out.append(line)
        if on_line:
            on_line(line.rstrip("\n"))
    proc.wait()
    t.join(timeout=2)
    job.proc = None
    if job.cancelled:
        raise Cancelled()
    if proc.returncode != 0:
        detail = " — ".join(x for x in err_tail[-2:] if x) or f"codice {proc.returncode}"
        raise RuntimeError(f"{Path(args[0]).stem}: {detail}")
    return "".join(out)


def convert_to_wav(job: Job, src: Path, song_id: str) -> Path:
    set_progress(job, "convert", 0, "Conversione in WAV")
    mix = SONGS / song_id / "mix.wav"
    mix.parent.mkdir(parents=True, exist_ok=True)
    run_tool(job, [find_ffmpeg(), "-y", "-v", "error", "-i", str(src), "-af",
                   "aresample=44100:resampler=soxr", "-ar", "44100", "-ac", "2",
                   "-c:a", "pcm_s16le", str(mix)])
    set_progress(job, "convert", 100)
    return mix


def separate(job: Job, song_id: str, mix: Path) -> tuple[list[str], str]:
    six = any(s in ("guitar", "piano") for s in job.stems)
    model = "htdemucs_6s" if six else "htdemucs"
    shifts = 2 if stemkit_settings().get("shifts") == 2 else 1
    out = stems_dir(song_id)
    out.mkdir(parents=True, exist_ok=True)
    set_progress(job, "separate", 0, "In attesa del motore…")
    with separation_slot:
        set_progress(job, "separate", 0, f"Separazione ({'6' if six else '4'} tracce)")
        produced: list[str] = []
        errors: list[str] = []

        def on_line(line: str):
            try:
                ev = json.loads(line)
            except Exception:
                return
            if ev.get("type") == "progress" and ev.get("pct"):
                set_progress(job, "separate", max(job.pct, int(ev["pct"])))
            elif ev.get("type") == "error":
                errors.append(str(ev.get("message")))
            elif ev.get("type") == "done":
                produced.extend(str(s) for s in ev.get("stems", []))

        run_tool(job, [str(VENV_PY), str(SEPARATE_PY), "--input", str(mix), "--out", str(out),
                       "--model", model, "--device", "cpu", "--shifts", str(shifts),
                       "--only", ",".join(s for s in job.stems)], on_line)
        if errors:
            raise RuntimeError(errors[0])
    tag = model + ("@s2" if shifts == 2 else "")
    return produced, tag


def finish(job: Job, song_id: str, title: str, duration: int, model: str,
           stems: list[str], started: float, source: str | None) -> None:
    existing = next((s for s in load_songs() if s.get("videoId") == song_id), None)
    song = {
        "videoId": song_id, "title": title, "duration": duration,
        "addedAt": (existing or {}).get("addedAt") or int(time.time() * 1000),
        "model": model, "stems": stems, "took": round(time.time() - started),
    }
    if source:
        song["source"] = source
    upsert_song(song)
    job.song_id = song_id
    job.stage, job.pct, job.state, job.message = "done", 100, "done", "Pronta"


def run_job(job: Job, work) -> None:
    try:
        work()
    except Cancelled:
        job.state, job.message = "failed", "Annullata"
        job.error = "Annullata"
    except Exception as e:  # report every failure to the phone
        traceback.print_exc()
        job.state, job.error = "failed", str(e)[:400]
        job.message = "Errore"


def start_job(job: Job, work) -> Job:
    with jobs_lock:
        # keep the list short: drop finished jobs older than a day
        for jid in [j.id for j in jobs.values() if j.state != "running" and time.time() - j.created > 86400]:
            jobs.pop(jid, None)
        jobs[job.id] = job
    threading.Thread(target=run_job, args=(job, work), daemon=True).start()
    return job


def start_upload_job(src: Path, title: str, stems: list[str]) -> Job:
    job = Job("upload", title, stems)
    song_id = local_song_id(str(src))

    def work():
        started = time.time()
        mix = convert_to_wav(job, src, song_id)
        produced, model = separate(job, song_id, mix)
        finish(job, song_id, title, wav_duration(mix), model, produced, started, "local")

    return start_job(job, work)


def start_youtube_job(url: str, stems: list[str]) -> Job:
    video_id = parse_youtube_id(url)
    if not video_id:
        raise ValueError("Link YouTube non valido")
    job = Job("youtube", "YouTube", stems)

    def work():
        started = time.time()
        set_progress(job, "metadata", 0, "Lettura informazioni video")
        raw = run_tool(job, [str(YTDLP), *js_runtime_args(), "-J", "--no-playlist",
                             "--skip-download", f"https://www.youtube.com/watch?v={video_id}"])
        meta = json.loads(raw)
        job.title = meta.get("title") or "Senza titolo"
        duration = round(meta.get("duration") or 0)
        song_dir = SONGS / video_id
        if song_dir.exists():
            shutil.rmtree(song_dir, ignore_errors=True)
        song_dir.mkdir(parents=True, exist_ok=True)
        set_progress(job, "download", 0, "Download audio")

        def on_line(line: str):
            m = re.search(r"(\d+(?:\.\d+)?)%", line)
            if m:
                set_progress(job, "download", float(m.group(1)))

        run_tool(job, [str(YTDLP), *js_runtime_args(), "-f", "bestaudio/best", "--no-playlist",
                       "--newline", "-o", str(song_dir / "raw.%(ext)s"),
                       f"https://www.youtube.com/watch?v={video_id}"], on_line)
        raw_file = next((p for p in song_dir.iterdir() if p.name.startswith("raw.")), None)
        if not raw_file:
            raise RuntimeError("Il download non ha prodotto nessun file")
        mix = convert_to_wav(job, raw_file, video_id)
        raw_file.unlink(missing_ok=True)
        produced, model = separate(job, video_id, mix)
        finish(job, video_id, job.title, duration, model, produced, started, None)

    return start_job(job, work)


def cancel_job(job: Job) -> None:
    job.cancelled = True
    proc = job.proc
    if proc and proc.poll() is None:
        if IS_WIN:
            subprocess.run(["taskkill", "/pid", str(proc.pid), "/T", "/F"],
                           capture_output=True, **no_window())
        else:
            proc.kill()


# ---------------------------------------------------------------- search / spotify


def _flat_entries(target: str) -> list[dict]:
    res = subprocess.run(
        [str(YTDLP), *js_runtime_args(), "--no-warnings", "-J", "--flat-playlist",
         "--playlist-end", "15", target],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45, **no_window(),
    )
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip().splitlines()[-1] if res.stderr.strip() else "ricerca fallita")
    data = json.loads(res.stdout)
    return [e for e in data.get("entries") or []
            if isinstance(e.get("id"), str) and isinstance(e.get("title"), str)]


def _oembed_author(video_id: str) -> str | None:
    try:
        url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(
            f"https://www.youtube.com/watch?v={video_id}", safe="")
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=8) as r:
            return json.load(r).get("author_name")
    except Exception:
        return None


def youtube_search(query: str) -> list[dict]:
    entries = _flat_entries(f"ytsearch15:{query}")
    out = [{
        "videoId": e["id"], "title": e["title"],
        "channel": e.get("uploader") or e.get("channel"),
        "duration": round(e["duration"]) if isinstance(e.get("duration"), (int, float)) else None,
    } for e in entries]
    if out:
        return out
    # YouTube returns nothing for some "sensitive" words (e.g. "erotico"):
    # YouTube Music search is not filtered and only lists songs
    entries = _flat_entries("https://music.youtube.com/search?q=" + urllib.parse.quote(query) + "#songs")[:12]
    authors: dict[str, str | None] = {}
    threads = [threading.Thread(target=lambda i=e["id"]: authors.__setitem__(i, _oembed_author(i))) for e in entries]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    return [{
        "videoId": e["id"], "title": e["title"],
        "channel": (authors.get(e["id"]) or "").removesuffix(" - Topic") or "YouTube Music",
        "duration": None,
    } for e in entries]


def spotify_query(url: str) -> str:
    """Spotify audio is DRM-protected: only the track name/artist are used, to search YouTube."""
    if not re.match(r"^https?://(open\.)?spotify\.com/", url.strip()) and not url.startswith("spotify:"):
        raise ValueError("Non è un link Spotify")
    req = urllib.request.Request(
        "https://open.spotify.com/oembed?url=" + urllib.parse.quote(url.strip(), safe=""),
        headers={"User-Agent": "Mozilla/5.0 StemKitBridge"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        title = json.load(r).get("title") or ""
    artist = ""
    try:
        page_req = urllib.request.Request(url.strip(), headers={"User-Agent": "Mozilla/5.0 StemKitBridge"})
        with urllib.request.urlopen(page_req, timeout=15) as r:
            html = r.read(400_000).decode("utf8", "replace")
        m = re.search(r'<meta property="og:description" content="([^"]+)"', html)
        if m:
            # "Artist · Song · Song · 2020"
            artist = m.group(1).split("·")[0].strip()
    except Exception:
        pass
    q = f"{artist} {title}".strip()
    if not q:
        raise RuntimeError("Non riesco a leggere il titolo dal link Spotify")
    return q


# ---------------------------------------------------------------- HTTP


def lan_addresses() -> list[str]:
    addrs: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # no packet is sent; picks the LAN route
        addrs.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for a in socket.gethostbyname_ex(socket.gethostname())[2]:
            if a not in addrs and not a.startswith("127."):
                addrs.append(a)
    except Exception:
        pass
    return addrs


def ensure_tls_certificate() -> tuple[Path, Path, str]:
    """Create a stable, self-signed server certificate; the phone pins its SHA-256."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    directory = DATA_DIR / "bridge-tls"
    cert_path, key_path = directory / "server.pem", directory / "server-key.pem"
    directory.mkdir(parents=True, exist_ok=True)
    reusable = False
    if cert_path.is_file() and key_path.is_file():
        try:
            existing_cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
            existing_key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
            reusable = existing_cert.public_key().public_numbers() == existing_key.public_key().public_numbers()
        except Exception:
            reusable = False
    if not reusable:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "OpenSpoty PC Bridge")])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
                .public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before_utc(now - timedelta(minutes=1))
                .not_valid_after_utc(now + timedelta(days=3650))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                .sign(key, hashes.SHA256()))
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        try:
            key_path.chmod(0o600)
        except OSError:
            pass
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    return cert_path, key_path, cert.fingerprint(hashes.SHA256()).hex()


STATUS_PAGE = """<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenSpoty Bridge</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0d14;color:#eee;max-width:640px;margin:40px auto;padding:0 16px}
.pin{font-size:48px;letter-spacing:8px;font-weight:700;color:#a78bfa}code{background:#1d1d2b;padding:2px 6px;border-radius:4px}
li{margin:4px 0}.muted{color:#999}</style></head><body>
<h1>OpenSpoty Bridge</h1>
<p>Nell'app <b>OpenSpoty</b> → <i>PC</i>, inserisci uno di questi indirizzi, il PIN e l'impronta.</p>
<ul>%ADDRS%</ul><p>PIN</p><div class="pin">%PIN%</div>
<p>Impronta certificato SHA-256</p><code>%FINGERPRINT%</code>
<p class="muted">Via USB: <code>adb reverse tcp:%TLS_PORT% tcp:%TLS_PORT%</code> e poi indirizzo <code>https://127.0.0.1:%TLS_PORT%</code>.</p>
<h2>Lavori</h2><ul id="jobs">%JOBS%</ul>
<script>setTimeout(()=>location.reload(),5000)</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = f"StemKitBridge/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter console
        quiet = ("/api/jobs", "/api/sync/rev", "/api/pc/separation", "/api/pc/progress", "/assets/")
        if self.command != "GET" or not self.path.startswith(quiet):
            sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}\n")

    # -- helpers
    def cors(self):
        origin = self.headers.get("Origin", "")
        desktop_origins = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
        app_origins = {"http://localhost", "https://localhost", "capacitor://localhost"}
        if origin in desktop_origins | app_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "X-StemKit-Pin, X-StemKit-Local-Token, Content-Type, X-Filename")
            self.send_header("Access-Control-Max-Age", "600")

    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error(self, status: int, message: str):
        self.send_json({"error": message}, status)

    def is_local(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1")

    def is_trusted_local_ui(self) -> bool:
        host = self.headers.get("Host", "").lower()
        hosts = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
        origin = self.headers.get("Origin", "")
        origins = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
        return self.is_local() and host in hosts and (not origin or origin in origins)

    def authed(self) -> bool:
        ip = self.client_address[0]
        if auth_locked(ip):
            self.error(429, "Troppi PIN sbagliati: riprova tra 10 minuti")
            return False
        if self.is_trusted_local_ui() and secrets.compare_digest(
            self.headers.get("X-StemKit-Local-Token", ""), LOCAL_UI_TOKEN
        ):
            return True  # desktop UI served on loopback; never trust loopback alone
        pin = self.headers.get("X-StemKit-Pin", "")
        if pin.isascii() and secrets.compare_digest(pin, CFG["pin"]):
            return True
        note_failed_auth(ip)
        self.error(401, "PIN sbagliato")
        return False

    def read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise ValueError("richiesta troppo grande")
        return json.loads(self.rfile.read(n) or b"{}")

    def parts(self) -> tuple[list[str], dict]:
        u = urllib.parse.urlsplit(self.path)
        return [p for p in u.path.split("/") if p], dict(urllib.parse.parse_qsl(u.query))

    # -- verbs
    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        try:
            p, q = self.parts()
            if pc_app.route(self, "GET", p, q):
                return
            self.route_get()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            traceback.print_exc()
            self.error(500, str(e)[:300])

    def do_POST(self):
        try:
            p, q = self.parts()
            if pc_app.route(self, "POST", p, q):
                return
            self.route_post()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ValueError as e:
            self.error(400, str(e))
        except Exception as e:
            traceback.print_exc()
            self.error(500, str(e)[:300])

    def do_DELETE(self):
        p, q = self.parts()
        try:
            if pc_app.route(self, "DELETE", p, q):
                return
        except Exception as e:
            return self.error(400, str(e)[:300])
        if p[:2] == ["api", "jobs"] and len(p) == 3:
            if not self.authed():
                return
            job = jobs.get(p[2])
            if not job:
                return self.error(404, "Lavoro non trovato")
            cancel_job(job)
            return self.send_json({"ok": True})
        self.error(404, "Non trovato")

    def route_get(self):
        p, q = self.parts()
        if p == ["bridge"]:
            if not self.is_trusted_local_ui():
                return self.error(403, "Apri questa pagina dal PC")
            addrs = "".join(f"<li><code>https://{a}:{TLS_PORT}</code></li>" for a in lan_addresses()) or "<li>nessuna rete</li>"
            jl = "".join(
                f"<li>{j.title} — {j.message} {j.pct}% ({j.state})</li>"
                for j in sorted(jobs.values(), key=lambda j: -j.created)
            ) or "<li class='muted'>nessuno</li>"
            html = (STATUS_PAGE.replace("%ADDRS%", addrs).replace("%PIN%", CFG["pin"])
                    .replace("%FINGERPRINT%", TLS_FINGERPRINT).replace("%PORT%", str(PORT))
                    .replace("%TLS_PORT%", str(TLS_PORT))
                    .replace("%JOBS%", jl)).encode("utf8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        if p == ["api", "ping"]:
            return self.send_json({"app": "stemkit-bridge", "version": VERSION, "name": socket.gethostname()})
        if not self.authed():
            return
        if p == ["api", "auth"]:
            return self.send_json({"ok": True, "name": socket.gethostname()})
        if p == ["api", "songs"]:
            return self.send_json({"songs": [public_song(s) for s in load_songs()]})
        if len(p) == 5 and p[:2] == ["api", "songs"] and p[3] == "stems":
            song_id = p[2]
            stem, _, fmt = p[4].partition(".")
            if not ID_RE.match(song_id) or not STEM_RE.match(stem) or fmt not in ("m4a", "flac"):
                return self.error(400, "Richiesta non valida")
            try:
                path = mobile_stem(song_id, stem, fmt)
            except FileNotFoundError:
                return self.error(404, "Traccia non trovata")
            return self.send_file(path, "audio/flac" if fmt == "flac" else "audio/mp4")
        if len(p) == 4 and p[:2] == ["api", "songs"] and p[3] in ("original.m4a", "original.flac"):
            song_id, fmt = p[2], p[3].split(".")[1]
            if not ID_RE.match(song_id):
                return self.error(400, "Richiesta non valida")
            try:
                path = mobile_original(song_id, fmt)
            except FileNotFoundError:
                return self.error(404, "Originale non disponibile")
            return self.send_file(path, "audio/flac" if fmt == "flac" else "audio/mp4")
        if p == ["api", "jobs"]:
            return self.send_json({"jobs": [j.public() for j in sorted(jobs.values(), key=lambda j: -j.created)]})
        if p == ["api", "search"]:
            query = (q.get("q") or "").strip()
            if not query:
                return self.send_json({"results": []})
            return self.send_json({"results": youtube_search(query)})
        self.error(404, "Non trovato")

    def route_post(self):
        p, q = self.parts()
        if not self.authed():
            return
        if p == ["api", "jobs", "upload"]:
            name = urllib.parse.unquote(self.headers.get("X-Filename") or "canzone.mp3")
            name = Path(name).name
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            if ext not in AUDIO_EXTENSIONS:
                raise ValueError(f"Formato non supportato: {ext or '?'}")
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 1_500_000_000:
                raise ValueError("File vuoto o troppo grande")
            stems = parse_stems(q.get("stems"))
            UPLOADS.mkdir(parents=True, exist_ok=True)
            tmp = UPLOADS / f"upload-{uuid.uuid4().hex}.part"
            digest = hashlib.sha1()
            remaining = length
            with open(tmp, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            if remaining:
                tmp.unlink(missing_ok=True)
                raise ValueError("Upload interrotto")
            # content hash in the name: re-uploading the same song reuses its id
            dest = UPLOADS / f"{digest.hexdigest()[:16]}.{ext}"
            os.replace(tmp, dest)
            title = name.rsplit(".", 1)[0] or "Canzone"
            job = start_upload_job(dest, title, stems)
            return self.send_json({"job": job.public()})
        if p == ["api", "jobs", "youtube"]:
            body = self.read_json()
            job = start_youtube_job(str(body.get("url") or ""), parse_stems(body.get("stems")))
            return self.send_json({"job": job.public()})
        if p == ["api", "resolve"]:
            body = self.read_json()
            url = str(body.get("url") or "").strip()
            if parse_youtube_id(url) and "spotify" not in url:
                return self.send_json({"kind": "youtube", "url": url})
            return self.send_json({"kind": "search", "query": spotify_query(url)})
        self.error(404, "Non trovato")

    def send_file(self, path: Path, ctype: str):
        size = path.stat().st_size
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1 << 20)


def parse_stems(raw) -> list[str]:
    if isinstance(raw, list):
        items = [str(s) for s in raw]
    else:
        items = [s for s in str(raw or "").split(",") if s]
    stems = [s for s in items if s in ALL_STEMS]
    return stems or ALL_STEMS


def main():
    # OpenSpoty for Windows installs its separator when first needed (portable.py)
    missing = [] if os.environ.get("OPENSPOTY_HOME") else [str(p) for p in (VENV_PY, SEPARATE_PY) if not p.exists()]
    if missing:
        print("StemKit non sembra installato o configurato. Mancano:\n  " + "\n  ".join(missing))
        print("Apri StemKit sul PC almeno una volta e completa la configurazione.")
        input("Premi Invio per chiudere…")
        sys.exit(1)
    global TLS_CERT_PATH, TLS_KEY_PATH, TLS_FINGERPRINT
    TLS_CERT_PATH, TLS_KEY_PATH, TLS_FINGERPRINT = ensure_tls_certificate()
    pc_app.start()
    # Plain HTTP stays on loopback for the PC UI and USB adb-reverse only.
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    lan_server = ThreadingHTTPServer(("0.0.0.0", TLS_PORT), Handler)
    lan_server.daemon_threads = True
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(str(TLS_CERT_PATH), str(TLS_KEY_PATH))
    lan_server.socket = tls.wrap_socket(lan_server.socket, server_side=True)
    threading.Thread(target=lan_server.serve_forever, name="openspoty-tls", daemon=True).start()
    print("=" * 56)
    print(f"  OpenSpoty Bridge {VERSION} — pronto")
    print("  Nell'app OpenSpoty → PC, inserisci:")
    for a in lan_addresses():
        print(f"     indirizzo  https://{a}:{TLS_PORT}")
    print(f"     PIN        {CFG['pin']}")
    print(f"     impronta   {TLS_FINGERPRINT}")
    print(f"  App sul PC: http://127.0.0.1:{PORT}/")
    print(f"  Libreria: {pc_app.LIB}")
    print("  Lascia aperta questa finestra. Ctrl+C per chiudere.")
    print("=" * 56, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        lan_server.shutdown()
        lan_server.server_close()


if __name__ == "__main__":
    sys.modules["stemkit_bridge"] = sys.modules["__main__"]  # pc_app shares this module's state
    import pc_app
    main()
