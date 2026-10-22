"""OpenSpoty on the PC: the same app as the phone, served by the bridge.

- serves the app (app/dist) to a browser window on this PC (127.0.0.1 only)
- keeps the library in %APPDATA%\\StemKitMobile with the phone's layout
  (library.json, playlists.json, songs/<id>/...), so syncing is a plain merge
  of the lists plus copying the files that are missing on either side
- runs the phone's YouTube / Spotify code (pc-engine, Java) and splits songs
  with StemKit's own engine, straight into that library
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.request
from pathlib import Path

import stemkit_bridge as sb

ROOT = Path(__file__).resolve().parent.parent
APP_DIST = ROOT / "app" / "dist"
ENGINE_LIB = ROOT / "pc-engine" / "build" / "install" / "pc-engine" / "lib"
CHORD_MODEL = ROOT / "app" / "android" / "app" / "src" / "main" / "assets" / "models" / "btc_voca.onnx"
LIB = Path(os.environ.get("STEMKIT_MOBILE_DIR", "").strip()
           or Path(os.environ.get("APPDATA", Path.home())) / "StemKitMobile")
SONGS = LIB / "songs"
STATE_FILES = {"songs": LIB / "library.json", "playlists": LIB / "playlists.json", "deleted": LIB / "deleted.json"}
PATH_RE = re.compile(r"^(songs|lyrics|chords)/[\w\-. ()]+(/[\w\-. ()]+)*$")
SIX = ["vocals", "drums", "bass", "guitar", "piano", "other"]
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".ico": "image/x-icon", ".woff2": "font/woff2", ".flac": "audio/flac", ".m4a": "audio/mp4", ".webm": "audio/webm",
    ".opus": "audio/ogg", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
}

state_lock = threading.Lock()
rev = int(time.time() * 1000)
last_phone_sync: dict = {}


def bump() -> int:
    global rev
    rev = max(rev + 1, int(time.time() * 1000))
    return rev


# ---------------------------------------------------------------- state + merge


def read_state(name: str):
    try:
        return json.loads(STATE_FILES[name].read_text("utf8"))
    except Exception:
        return {"songs": {}, "playlists": {}} if name == "deleted" else []


def write_state(name: str, value) -> None:
    LIB.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILES[name].with_suffix(".json.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False), "utf8")
    os.replace(tmp, STATE_FILES[name])


def merge_items(base: list, incoming: list, tomb: dict) -> list:
    """Union by id; the newer copy (updatedAt) wins, keeping fields only the other has."""
    by = {x["id"]: x for x in base if isinstance(x, dict) and "id" in x}
    order = list(by)
    for x in incoming:
        if not isinstance(x, dict) or "id" not in x:
            continue
        cur = by.get(x["id"])
        if cur is None:
            by[x["id"]] = x
            order.append(x["id"])
        elif (x.get("updatedAt") or 0) >= (cur.get("updatedAt") or 0):
            by[x["id"]] = {**cur, **x}
        else:
            by[x["id"]] = {**x, **cur}
    return [by[i] for i in order if (tomb.get(i) or 0) < (by[i].get("updatedAt") or 0) or i not in tomb]


def merge_tombs(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in (b or {}).items():
        if isinstance(v, (int, float)):
            out[k] = max(out.get(k, 0), v)
    cutoff = time.time() * 1000 - 180 * 86400_000
    return {k: v for k, v in out.items() if v > cutoff}


def merge_in(body: dict) -> dict:
    """Merge what a device sent into the PC's library; returns the merged state."""
    with state_lock:
        old = read_state("deleted")
        sent = body.get("deleted") or {}
        deleted = {"songs": merge_tombs(old.get("songs", {}), sent.get("songs", {})),
                   "playlists": merge_tombs(old.get("playlists", {}), sent.get("playlists", {}))}
        base = read_state("songs")
        incoming = body.get("songs") or []
        if body.get("device") == "phone":
            # the PC keeps only songs split into stems (plus the ones it got itself):
            # the phone's listen-only songs stay on the phone
            known = {x.get("id") for x in base}
            incoming = [x for x in incoming if isinstance(x, dict) and (x.get("stems") or x.get("id") in known)]
        songs = merge_items(base, incoming, deleted["songs"])
        playlists = merge_items(read_state("playlists"), body.get("playlists") or [], deleted["playlists"])
        # a song that is back (downloaded again) is no longer deleted
        for s in songs:
            deleted["songs"].pop(s["id"], None)
        for p in playlists:
            deleted["playlists"].pop(p["id"], None)
        write_state("songs", songs)
        write_state("playlists", playlists)
        write_state("deleted", deleted)
        # files go only for songs this merge removed: a song downloaded again
        # after being deleted keeps its fresh files
        present = {x["id"] for x in songs}
        for x in base:
            sid = str(x.get("id"))
            if sid not in present and sid in deleted["songs"] and sb.ID_RE.match(sid):
                shutil.rmtree(SONGS / sid, ignore_errors=True)
        bump()
    return full_state()


def list_files() -> dict:
    out = {}
    if SONGS.is_dir():
        for p in SONGS.rglob("*"):
            if p.is_file() and not p.name.endswith((".part", ".tmp")):
                out[p.relative_to(LIB).as_posix()] = p.stat().st_size
    return out


def full_state() -> dict:
    return {"rev": rev, "songs": read_state("songs"), "playlists": read_state("playlists"),
            "deleted": read_state("deleted"), "files": list_files(), "phoneSync": last_phone_sync}


def lib_path(rel: str) -> Path:
    if not PATH_RE.match(rel) or ".." in rel:
        raise ValueError("percorso non valido")
    return LIB / rel


# ---------------------------------------------------------------- pc-engine (Java)


class Engine:
    """One long-lived JVM running YouTubeSource (the phone's code)."""

    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()
        self.next_id = 0
        self.waiting: dict[int, dict] = {}

    def _start(self):
        java = shutil.which("java")
        if not java:
            raise RuntimeError("Java non trovato sul PC")
        if not ENGINE_LIB.is_dir():
            raise RuntimeError("pc-engine non compilato")
        self.proc = subprocess.Popen(
            [java, "-cp", str(ENGINE_LIB / "*"), "app.stemkitmobile.PcEngine"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, **sb.no_window(),
        )
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()

    def _read(self, proc):
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except Exception:
                continue
            w = self.waiting.get(msg.get("id"))
            if not w:
                continue
            if "progress" in msg:
                if w.get("on_progress"):
                    w["on_progress"](msg["progress"])
                continue
            w["msg"] = msg
            w["done"].set()
        for w in list(self.waiting.values()):  # the JVM died: fail everything pending
            w["msg"] = {"ok": False, "error": "motore interrotto"}
            w["done"].set()

    def stop(self):
        """Lets tools/deploy.sh replace the engine's jars; the next call starts it again."""
        with self.lock:
            if self.proc and self.proc.poll() is None:
                self.proc.kill()
                self.proc.wait(10)
            self.proc = None

    def call(self, op: str, timeout: float = 120, on_progress=None, **args):
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                self._start()
            self.next_id += 1
            rid = self.next_id
            w = {"done": threading.Event(), "on_progress": on_progress}
            self.waiting[rid] = w
            self.proc.stdin.write(json.dumps({"id": rid, "op": op, **args}) + "\n")
            self.proc.stdin.flush()
        try:
            if not w["done"].wait(timeout):
                raise RuntimeError("il motore non risponde")
            msg = w["msg"]
            if not msg.get("ok"):
                raise RuntimeError(msg.get("error") or "errore")
            return msg.get("result")
        finally:
            self.waiting.pop(rid, None)


engine = Engine()


# ---------------------------------------------------------------- downloads


def write_meta(song_id: str, patch: dict) -> dict:
    f = SONGS / song_id / "meta.json"
    try:
        meta = json.loads(f.read_text("utf8"))
    except Exception:
        meta = {"songId": song_id, "stems": [], "files": {}}
    meta.update(patch)
    meta.setdefault("finishedAt", int(time.time() * 1000))
    tmp = f.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf8")
    os.replace(tmp, f)
    return meta


def find_original(song_id: str) -> Path | None:
    d = SONGS / song_id
    return next((p for p in sorted(d.glob("original.*")) if not p.name.endswith((".part", ".tmp"))), None) if d.is_dir() else None


progress: dict[str, int] = {}


def download_youtube(video_id: str, song_id: str, title: str) -> dict:
    if not re.fullmatch(r"[\w-]{11}", video_id) or not sb.ID_RE.match(song_id):
        raise ValueError("parametri non validi")
    d = SONGS / song_id
    existed = d.is_dir()
    d.mkdir(parents=True, exist_ok=True)
    try:
        progress[song_id] = 0
        r = engine.call("download", timeout=900, on_progress=lambda p: progress.__setitem__(song_id, p),
                        videoId=video_id, dir=str(d), baseName="original")
    except Exception:
        if not existed:
            shutil.rmtree(d, ignore_errors=True)
        raise
    finally:
        progress.pop(song_id, None)
    rel = Path(r["file"]).relative_to(LIB).as_posix()
    write_meta(song_id, {"title": title, "duration": r.get("duration") or 0, "original": rel,
                         "finishedAt": int(time.time() * 1000)})
    bump()
    return {"original": rel, "duration": r.get("duration") or 0}


CACHE = LIB / "cache"
CACHE_MAX = 2 << 30
stream_locks: dict[str, threading.Lock] = {}


def stream_file(video_id: str) -> Path:
    """A song heard without downloading it: kept in a size-capped cache, like Spotify."""
    if not re.fullmatch(r"[\w-]{11}", video_id):
        raise ValueError("video non valido")
    CACHE.mkdir(parents=True, exist_ok=True)
    with state_lock:
        lock = stream_locks.setdefault(video_id, threading.Lock())
    with lock:
        hit = next((p for p in CACHE.glob(f"{video_id}.*") if not p.name.endswith((".part", ".tmp"))), None)
        if hit:
            os.utime(hit)
            return hit
        r = engine.call("download", timeout=600, videoId=video_id, dir=str(CACHE), baseName=video_id)
        files = sorted((p for p in CACHE.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
        total = 0
        for f in files:  # oldest first out
            total += f.stat().st_size
            if total > CACHE_MAX:
                f.unlink(missing_ok=True)
        return Path(r["file"])


def chords(paths: list[str]) -> dict:
    """Chords of a song (its original, or its stems summed) with the phone's recognizer."""
    files = [stream_file(p[7:]) if p.startswith("stream:") else lib_path(p) for p in paths]
    if not files:
        raise ValueError("nessun audio")
    if len(files) == 1:
        return engine.call("chords", timeout=600, path=str(files[0]), ffmpeg=sb.find_ffmpeg(), model=str(CHORD_MODEL))
    with tempfile.TemporaryDirectory(prefix="stemkit-chords-") as tmp:
        mix = Path(tmp) / "mix.wav"
        args = [sb.find_ffmpeg(), "-y", "-v", "error"]
        for f in files:
            args += ["-i", str(f)]
        args += ["-filter_complex", f"amix=inputs={len(files)}:normalize=0", "-ac", "1", "-ar", "22050", str(mix)]
        subprocess.run(args, check=True, capture_output=True, **sb.no_window())
        return engine.call("chords", timeout=600, path=str(mix), ffmpeg=sb.find_ffmpeg(), model=str(CHORD_MODEL))


def _quiet(fn, *args) -> None:
    try:
        fn(*args)
    except Exception:
        pass


def fetch_cover(song_id: str, video_id: str) -> str:
    if not re.fullmatch(r"[\w-]{11}", video_id) or not sb.ID_RE.match(song_id):
        raise ValueError("parametri non validi")
    req = urllib.request.Request(f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read(2_000_000)
    out = SONGS / song_id / "cover.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return out.relative_to(LIB).as_posix()


def loudness(paths: list[str]) -> float | None:
    """Integrated loudness (EBU R128) of the original, or of the stems summed."""
    files = [str(stream_file(p[7:]) if p.startswith("stream:") else lib_path(p)) for p in paths]
    if not files:
        return None
    args = [sb.find_ffmpeg(), "-hide_banner", "-nostats"]
    for f in files:
        args += ["-i", f]
    mix = f"amix=inputs={len(files)}:normalize=0," if len(files) > 1 else ""
    args += ["-filter_complex", f"{mix}ebur128", "-f", "null", "-"]
    res = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", **sb.no_window())
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", res.stderr)
    return float(m[-1]) if m else None


# ---------------------------------------------------------------- separation queue


class Split:
    def __init__(self, song_id: str, title: str, video_id: str | None):
        self.song_id, self.title, self.video_id = song_id, title, video_id
        self.state, self.pct, self.message, self.error = "running", 0, "In coda", None
        self.cancelled = False
        self.proc: subprocess.Popen | None = None

    def event(self) -> dict:
        return {"songId": self.song_id, "title": self.title, "state": self.state, "pct": self.pct,
                "message": self.message, "error": self.error, "queue": [s.title for s in split_queue]}


split_queue: list[Split] = []
split_current: Split | None = None
split_last: Split | None = None
split_cv = threading.Condition()


def queue_split(song_id: str, title: str, video_id: str | None) -> None:
    if not sb.ID_RE.match(song_id) or (video_id and not re.fullmatch(r"[\w-]{11}", video_id)):
        raise ValueError("parametri non validi")
    with split_cv:
        if (split_current and split_current.song_id == song_id) or any(s.song_id == song_id for s in split_queue):
            raise ValueError("Questa canzone è già in preparazione")
        split_queue.append(Split(song_id, title, video_id))
        split_cv.notify()


def split_status() -> dict:
    s = split_current or split_last
    if not s:
        return {"state": "idle"}
    return s.event()


def cancel_split(all_: bool) -> None:
    with split_cv:
        if all_:
            split_queue.clear()
        s = split_current
    if s:
        s.cancelled = True
        if s.proc and s.proc.poll() is None:
            subprocess.run(["taskkill", "/pid", str(s.proc.pid), "/T", "/F"], capture_output=True, **sb.no_window())


def split_worker() -> None:
    global split_current, split_last
    while True:
        with split_cv:
            while not split_queue:
                split_cv.wait()
            split_current = split_queue.pop(0)
        s = split_current
        try:
            run_split(s)
            s.state, s.pct, s.message = "done", 100, "Pronta"
        except Exception as e:
            if not s.cancelled:
                traceback.print_exc()
            s.state = "failed"
            s.error = "Annullata" if s.cancelled else str(e)[:300]
            s.message = s.error
        with split_cv:
            split_last, split_current = s, None
        bump()


def run_split(s: Split) -> None:
    d = SONGS / s.song_id
    original = find_original(s.song_id)
    if not original:
        if not s.video_id:
            raise RuntimeError("Manca l'audio originale")
        s.message = "Scarico l'audio"
        download_youtube(s.video_id, s.song_id, s.title)
        original = find_original(s.song_id)
    with tempfile.TemporaryDirectory(prefix="stemkit-split-") as tmp:
        tmpd = Path(tmp)
        s.message = "Preparo l'audio"
        mix = tmpd / "mix.wav"
        subprocess.run([sb.find_ffmpeg(), "-y", "-v", "error", "-i", str(original), "-af", "aresample=44100:resampler=soxr",
                        "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(mix)], check=True, capture_output=True, **sb.no_window())
        if s.cancelled:
            raise RuntimeError("Annullata")
        s.message = "Separo le tracce"
        out = tmpd / "stems"
        out.mkdir()
        shifts = 2 if sb.stemkit_settings().get("shifts") == 2 else 1
        with sb.separation_slot:  # shared with the bridge's own jobs: one split at a time
            s.proc = subprocess.Popen(
                [str(sb.VENV_PY), str(sb.SEPARATE_PY), "--input", str(mix), "--out", str(out), "--model", "htdemucs_6s",
                 "--device", "cpu", "--shifts", str(shifts), "--only", ",".join(SIX)],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace", **sb.no_window())
            errors = []
            for line in s.proc.stdout:
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if ev.get("type") == "progress" and ev.get("pct"):
                    s.pct = max(s.pct, min(95, int(ev["pct"] * 0.95)))
                elif ev.get("type") == "error":
                    errors.append(str(ev.get("message")))
            s.proc.wait()
        if s.cancelled:
            raise RuntimeError("Annullata")
        if s.proc.returncode != 0 or errors:
            raise RuntimeError(errors[0] if errors else "separazione non riuscita")
        s.message = "Salvo le tracce"
        files = {}
        for stem in SIX:
            src = out / f"{stem}.wav"
            if not src.exists():
                continue
            dst = d / f"{stem}.flac"
            tmpf = d / f"{stem}.tmp.flac"
            subprocess.run([sb.find_ffmpeg(), "-y", "-v", "error", "-i", str(src), "-c:a", "flac", "-sample_fmt", "s16",
                            "-ar", "44100", "-ac", "2", str(tmpf)], check=True, capture_output=True, **sb.no_window())
            os.replace(tmpf, dst)
            files[stem] = dst.relative_to(LIB).as_posix()
        if not files:
            raise RuntimeError("nessuna traccia prodotta")
        write_meta(s.song_id, {"title": s.title, "stems": list(files), "files": files,
                               "original": original.relative_to(LIB).as_posix(), "finishedAt": int(time.time() * 1000)})


# ---------------------------------------------------------------- StemKit desktop songs


def import_stemkit_songs() -> None:
    """Songs split earlier with the StemKit desktop app join the library (once)."""
    for song in sb.load_songs():
        vid = song.get("videoId")
        if not vid or not sb.ID_RE.match(vid) or not sb.song_ready(song):
            continue
        sid = f"pc-{vid}"
        with state_lock:
            known = any(x.get("id") == sid for x in read_state("songs")) or sid in read_state("deleted").get("songs", {})
        if known:
            continue
        d = SONGS / sid
        d.mkdir(parents=True, exist_ok=True)
        files = {}
        try:
            for stem in sb.song_stems(song):
                files[stem] = (d / f"{stem}.flac").relative_to(LIB).as_posix()
                sb._transcode(sb.stems_dir(vid) / f"{stem}.wav", d / f"{stem}.flac", "flac")
            original = None
            if (sb.SONGS / vid / "mix.wav").exists():
                sb._transcode(sb.SONGS / vid / "mix.wav", d / "original.flac", "flac")
                original = (d / "original.flac").relative_to(LIB).as_posix()
        except Exception:
            traceback.print_exc()
            continue
        now = int(time.time() * 1000)
        entry = {"id": sid, "title": song.get("title") or "Senza titolo", "duration": song.get("duration") or 0,
                 "stems": [s for s in SIX if s in files], "files": files, "source": "pc", "pcId": vid,
                 "addedAt": song.get("addedAt") or now, "updatedAt": now}
        if original:
            entry["original"] = original
        merge_in({"songs": [entry]})
        print(f"[pc] importata dalla libreria di StemKit: {entry['title']}", flush=True)


def stemkit_watch() -> None:
    while True:
        try:
            import_stemkit_songs()
        except Exception:
            traceback.print_exc()
        time.sleep(300)


def prune_listen_only() -> None:
    """Listen-only songs that came from the phone don't belong on the PC (no tombstone:
    the phone keeps them). Songs downloaded on the PC itself have a meta.json."""
    with state_lock:
        keep, drop = [], []
        for x in read_state("songs"):
            mine = (SONGS / str(x.get("id")) / "meta.json").exists() or str(x.get("id", "")).startswith("pc-")
            (keep if x.get("stems") or mine else drop).append(x)
        if not drop:
            return
        write_state("songs", keep)
        for x in drop:
            sid = str(x.get("id"))
            if sb.ID_RE.match(sid):
                shutil.rmtree(SONGS / sid, ignore_errors=True)
        bump()
    print(f"[pc] tolti {len(drop)} brani solo-ascolto arrivati dal telefono", flush=True)


def start() -> None:
    SONGS.mkdir(parents=True, exist_ok=True)
    prune_listen_only()
    threading.Thread(target=split_worker, daemon=True).start()
    threading.Thread(target=stemkit_watch, daemon=True).start()


# ---------------------------------------------------------------- HTTP routes


def serve_app(h, path: str) -> None:
    rel = path.lstrip("/") or "index.html"
    f = (APP_DIST / rel).resolve()
    if not str(f).startswith(str(APP_DIST.resolve())) or not f.is_file():
        f = APP_DIST / "index.html"  # client-side routes
    if not f.is_file():
        return h.error(503, "App non compilata: esegui tools/deploy.sh")
    data = f.read_bytes()
    if f.name == "index.html":
        data = data.replace(b"<head>", b"<head><script>window.__STEMKIT_DESKTOP__=1</script>", 1)
    h.send_response(200)
    h.send_header("Content-Type", CONTENT_TYPES.get(f.suffix, "application/octet-stream"))
    h.send_header("Content-Length", str(len(data)))
    h.send_header("Cache-Control", "no-cache" if f.name == "index.html" else "max-age=31536000, immutable")
    h.end_headers()
    h.wfile.write(data)


def route(h, method: str, p: list[str], q: dict) -> bool:
    """Handles the PC-app and sync endpoints; False if the path is not ours."""
    path = "/".join(p)
    if method == "GET" and (not p or p[0] not in ("api", "bridge")):
        if not h.is_local():
            h.error(403, "L'app si apre solo da questo PC")
            return True
        serve_app(h, "/" + path)
        return True
    if p[:2] == ["api", "sync"]:
        if not h.authed():
            return True
        if p == ["api", "sync", "rev"]:
            h.send_json({"rev": rev})
        elif method == "GET":
            h.send_json(full_state())
        elif method == "POST":
            body = read_body_json(h)
            if body.get("device") == "phone":
                last_phone_sync.update({"at": int(time.time() * 1000)})
            h.send_json(merge_in(body))
        else:
            h.error(405, "metodo non valido")
        return True
    if p[:3] == ["api", "lib", "file"] and len(p) > 3:
        if not h.authed():
            return True
        f = lib_path("/".join(p[3:]))
        if method == "GET":
            if not f.is_file():
                h.error(404, "File non trovato")
            else:
                h.send_file(f, CONTENT_TYPES.get(f.suffix.lower(), "application/octet-stream"))
        elif method == "POST":
            length = int(h.headers.get("Content-Length") or 0)
            if length < 0 or length > 2_000_000_000:
                raise ValueError("File troppo grande")
            f.parent.mkdir(parents=True, exist_ok=True)
            tmp = f.with_name(f.name + ".part")
            remaining = length
            with open(tmp, "wb") as out:
                while remaining > 0:
                    chunk = h.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    out.write(chunk)
                    remaining -= len(chunk)
            if remaining:
                tmp.unlink(missing_ok=True)
                raise ValueError("Invio interrotto")
            os.replace(tmp, f)
            bump()
            h.send_json({"ok": True, "size": length})
        elif method == "DELETE":
            if f.is_file():
                f.unlink()
            h.send_json({"ok": True})
        return True
    if p[:3] == ["api", "pc", "capture"] and method == "POST":
        # "Cattura" on the PC: the browser sends the microphone as 16 kHz mono float32
        if not h.authed():
            return True
        n = int(h.headers.get("Content-Length") or 0)
        if n <= 0 or n > 16000 * 4 * 20:
            raise ValueError("audio non valido")
        raw = h.rfile.read(n)
        with tempfile.TemporaryDirectory(prefix="openspoty-capture-") as tmp:
            f = Path(tmp) / "mic.wav"
            import array, wave
            samples = array.array("f")
            samples.frombytes(raw[: len(raw) // 4 * 4])
            pcm = array.array("h", (max(-32768, min(32767, int(v * 32767))) for v in samples))
            with wave.open(str(f), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(16000)
                w.writeframes(pcm.tobytes())
            h.send_json(engine.call("shazam", timeout=60, path=str(f), ffmpeg=sb.find_ffmpeg(), send=True, middle=False))
        return True
    if p[:2] == ["api", "pc"]:
        if not h.authed():
            return True
        op = p[2] if len(p) > 2 else ""
        if method == "GET" and op == "stream" and len(p) == 4:
            f = stream_file(p[3])
            h.send_file(f, CONTENT_TYPES.get(f.suffix.lower(), "application/octet-stream"))
        elif method == "GET" and op == "separation":
            h.send_json(split_status())
        elif method == "GET" and op == "progress":
            h.send_json(progress)
        elif method == "GET" and op == "pairing":
            if not h.is_local():
                h.error(403, "solo da questo PC")
            else:
                h.send_json({"addresses": [f"{a}:{sb.PORT}" for a in sb.lan_addresses()], "pin": sb.CFG["pin"],
                             "name": sb.socket.gethostname(), "phoneSync": last_phone_sync})
        elif method == "POST":
            b = read_body_json(h)
            if op == "search":
                h.send_json({"results": engine.call("search", timeout=60, query=str(b.get("query") or ""))})
            elif op == "match":
                h.send_json(engine.call("match", timeout=60, title=str(b.get("title") or ""),
                                        artist=str(b.get("artist") or ""), duration=int(b.get("duration") or 0)))
            elif op == "spotifyList":
                h.send_json(engine.call("spotifyList", timeout=120, url=str(b.get("url") or "")))
            elif op == "chords":
                h.send_json(chords([str(x) for x in (b.get("paths") or [])]))
            elif op == "warm":
                # songs likely to be played next: fetched into the stream cache in the background
                ids = [str(x) for x in (b.get("videoIds") or [])][: max(0, min(3, int(b.get("prefetch") or 0)))]
                for vid in ids:
                    threading.Thread(target=lambda v=vid: _quiet(stream_file, v), daemon=True).start()
                h.send_json({"ok": True})
            elif op == "suggest":
                h.send_json({"suggestions": engine.call("suggest", timeout=20, query=str(b.get("query") or ""))})
            elif op in ("spSearch", "spArtist", "spAlbum"):
                key = "query" if op == "spSearch" else "uri"
                h.send_json(engine.call(op, timeout=60, **{key: str(b.get(key) or "")}))
            elif op == "spotifyQuery":
                h.send_json({"query": engine.call("spotifyQuery", timeout=60, url=str(b.get("url") or ""))})
            elif op == "download":
                h.send_json(download_youtube(str(b.get("videoId") or ""), str(b.get("songId") or ""), str(b.get("title") or "Canzone")))
            elif op == "separate":
                queue_split(str(b.get("songId") or ""), str(b.get("title") or "Canzone"), b.get("youtubeId") or None)
                h.send_json({"ok": True})
            elif op == "cancel":
                cancel_split(bool(b.get("all")))
                h.send_json({"ok": True})
            elif op == "loudness":
                h.send_json({"lufs": loudness([str(x) for x in b.get("paths") or []])})
            elif op == "stop-engine" and h.is_local():
                engine.stop()
                h.send_json({"ok": True})
            elif op == "cover":
                h.send_json({"path": fetch_cover(str(b.get("songId") or ""), str(b.get("videoId") or ""))})
            else:
                h.error(404, "Non trovato")
        else:
            h.error(404, "Non trovato")
        return True
    return False


def read_body_json(h) -> dict:
    n = int(h.headers.get("Content-Length") or 0)
    if n > 50_000_000:
        raise ValueError("richiesta troppo grande")
    return json.loads(h.rfile.read(n) or b"{}")
