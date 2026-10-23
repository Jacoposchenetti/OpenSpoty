"""OpenSpoty for Windows (the zip a friend unpacks): what only that package does.

The launcher (OpenSpoty.exe) sets OPENSPOTY_HOME to the folder with the app,
Python, Java, ffmpeg and the engine. Here:
- the separator (PyTorch + Demucs, ~1.5 GB) is installed the first time a song
  is split, into %LOCALAPPDATA%\\OpenSpoty\\venv
- updates: the newest OpenSpoty-Windows.zip from GitHub is downloaded and
  unpacked, then a small script swaps the folder and starts the app again
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
import zipfile
from pathlib import Path

import stemkit_bridge as sb

HOME = Path(os.environ["OPENSPOTY_HOME"]) if os.environ.get("OPENSPOTY_HOME") else None

# ---------------------------------------------------------------- separator

TORCH = ["torch==2.5.1", "torchaudio==2.5.1", "--index-url", "https://download.pytorch.org/whl/cpu"]
DEMUCS = ["demucs==4.0.1", "numpy==1.26.4"]
install_lock = threading.Lock()


def separator_ready() -> bool:
    return (sb.VENV_PY.parent.parent / "openspoty-ok").exists()


def ensure_separator(say) -> None:
    """Installs the separator once (a few minutes, ~1.5 GB); say(text) shows where it is."""
    if HOME is None or separator_ready():
        return
    with install_lock:
        if separator_ready():
            return
        venv = sb.VENV_PY.parent.parent
        say("Preparo il separatore (solo la prima volta)")
        shutil.rmtree(venv, ignore_errors=True)
        _run([sys.executable, "-m", "venv", str(venv)])
        pip = [str(sb.VENV_PY), "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--progress-bar", "off"]
        say("Scarico il separatore: PyTorch, circa 200 MB (solo la prima volta)")
        _run(pip + TORCH)
        say("Scarico il separatore: Demucs (solo la prima volta)")
        _run(pip + DEMUCS)
        (venv / "openspoty-ok").write_text("1")
        say("Separatore pronto: scarico il modello")


def _run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **sb.no_window())
    if r.returncode != 0:
        tail = (r.stderr or r.stdout).strip().splitlines()[-3:]
        raise RuntimeError("Installazione del separatore non riuscita: " + " ".join(tail)[:300])


# ---------------------------------------------------------------- updates

update = {"state": "idle", "pct": 0, "error": ""}


def start_update(url: str) -> dict:
    if HOME is None:
        raise RuntimeError("Aggiornamento solo per OpenSpoty per Windows")
    if not url.startswith("https://github.com/Jacoposchenetti/OpenSpoty/releases/"):
        raise ValueError("indirizzo non valido")
    if update["state"] in ("downloading", "installing"):
        return update
    update.update(state="downloading", pct=0, error="")
    threading.Thread(target=_update, args=(url,), daemon=True).start()
    return update


def _update(url: str) -> None:
    try:
        work = Path(tempfile.gettempdir()) / "OpenSpoty-update"
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        z = work / "OpenSpoty-Windows.zip"
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "OpenSpoty"}), timeout=60) as r, open(z, "wb") as out:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if total:
                    update["pct"] = int(done * 95 / total)
        update.update(state="installing", pct=96)
        with zipfile.ZipFile(z) as zf:
            zf.extractall(work / "new")
        new = work / "new" / "OpenSpoty"
        if not (new / "OpenSpoty.exe").is_file():
            raise RuntimeError("pacchetto non valido")
        install = HOME.parent  # the folder with OpenSpoty.exe
        script = work / "update.ps1"
        script.write_text(UPDATER, "utf-8")
        subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", str(script),
             "-New", str(new), "-Install", str(install), "-Bridge", str(os.getpid())],
            creationflags=0x00000008 | 0x00000200,  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: outlives us
        )
        update.update(state="restarting", pct=100)
    except Exception as e:
        update.update(state="failed", error=str(e)[:300])


# runs on its own once the bridge is gone: swaps the folder, starts the app again
UPDATER = r"""
param([string]$New, [string]$Install, [int]$Bridge)
Start-Sleep -Seconds 2
$app = Join-Path $Install 'app'
# the app's own window (its Edge profile), the launcher, the bridge and its Java engine
Get-CimInstance Win32_Process | Where-Object {
  ($_.CommandLine -like '*OpenSpoty\edge*') -or ($_.ExecutablePath -like "$Install\*")
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $Bridge -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
for ($i = 0; $i -lt 10; $i++) {
  try { Remove-Item -Recurse -Force $app -ErrorAction Stop; break } catch { Start-Sleep -Seconds 1 }
}
Copy-Item -Recurse -Force (Join-Path $New 'app') $app
Copy-Item -Force (Join-Path $New 'OpenSpoty.exe') (Join-Path $Install 'OpenSpoty.exe')
Start-Process (Join-Path $Install 'OpenSpoty.exe')
"""
