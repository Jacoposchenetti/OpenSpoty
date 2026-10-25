#!/usr/bin/env bash
# Builds OpenSpoty for Windows: dist-win/OpenSpoty-Windows.zip, the folder a
# friend unpacks and starts with OpenSpoty.exe (attach it to the GitHub release
# next to the APK: the app finds it there for "Aggiornamento disponibile").
#
# Inside: app/python (Python 3.12, from python.org's NuGet package), app/java
# (a Java 21 runtime cut with jlink), app/engine (pc-engine), app/bridge,
# app/dist (the web app), app/models, app/resources (ffmpeg, separate.py).
# Python and Java are kept in tools/pc/cache between builds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CACHE="$ROOT/tools/pc/cache"
OUT="${OPENSPOTY_PACKAGE_OUT:-$ROOT/dist-win}"
PKG="$OUT/OpenSpoty"
PY_VERSION=3.12.7
FFMPEG="${FFMPEG:-$LOCALAPPDATA/Programs/stemkit/resources/ffmpeg/ffmpeg.exe}"
ENGINE_LIB="$ROOT/pc-engine/build/install/pc-engine/lib"
mkdir -p "$CACHE" "$OUT"

[ -f "$ROOT/app/dist/index.html" ] || { echo "manca app/dist: esegui prima la build dell'app"; exit 1; }
[ -d "$ENGINE_LIB" ] || (cd "$ROOT/pc-engine" && ./gradlew.bat -q installDist)

if [ ! -x "$CACHE/python/python.exe" ]; then
  echo "· Python $PY_VERSION"
  curl -sSL -o "$CACHE/python.nupkg" "https://www.nuget.org/api/v2/package/python/$PY_VERSION"
  python - "$CACHE" <<'EOF'
import sys, zipfile, shutil, pathlib
cache = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(cache / "python.nupkg") as z:
    for n in z.namelist():
        if n.startswith("tools/") and not n.endswith("/"):
            dst = cache / "python" / n[len("tools/"):]
            dst.parent.mkdir(parents=True, exist_ok=True)
            with z.open(n) as src, open(dst, "wb") as out:
                shutil.copyfileobj(src, out)
EOF
  rm -f "$CACHE/python.nupkg"
fi

if [ ! -x "$CACHE/java/bin/java.exe" ]; then
  echo "· Java (jlink)"
  MODS=$(jdeps --ignore-missing-deps --print-module-deps --multi-release 21 "$ENGINE_LIB"/*.jar)
  jlink --add-modules "$MODS,jdk.crypto.ec,jdk.localedata" --strip-debug --no-man-pages --no-header-files \
    --compress=zip-6 --output "$CACHE/java"
fi

echo "· cartella"
rm -rf "$PKG"
mkdir -p "$PKG/app/bridge" "$PKG/app/models" "$PKG/app/resources/python" "$PKG/app/resources/ffmpeg" "$PKG/app/engine"
cp -r "$CACHE/python" "$PKG/app/python"
echo "· cryptography (TLS del Bridge)"
WHEELS="$CACHE/bridge-wheels"
mkdir -p "$WHEELS" "$PKG/app/python/Lib/site-packages"
python -m pip download --only-binary=:all: --dest "$WHEELS" --platform win_amd64 \
  --python-version 3.12 --implementation cp --abi cp312 cryptography==49.0.0
python - "$WHEELS" "$PKG/app/python" <<'EOF'
import pathlib, sys, zipfile
wheels, runtime = map(pathlib.Path, sys.argv[1:])
site = runtime / "Lib" / "site-packages"
for wheel in wheels.glob("*.whl"):
    with zipfile.ZipFile(wheel) as archive:
        archive.extractall(site)
pth = runtime / "python312._pth"
if pth.exists():
    lines = pth.read_text(encoding="utf8").splitlines()
    if "Lib/site-packages" not in lines:
        pth.write_text("\n".join(lines + ["Lib/site-packages", ""]), encoding="utf8")
EOF
cp -r "$CACHE/java" "$PKG/app/java"
cp -r "$ENGINE_LIB" "$PKG/app/engine/lib"
cp "$ROOT"/bridge/{stemkit_bridge.py,pc_app.py,portable.py} "$PKG/app/bridge/"
cp "$ROOT/tools/pc/separate.py" "$PKG/app/resources/python/"
cp "$FFMPEG" "$PKG/app/resources/ffmpeg/ffmpeg.exe"
cp "$ROOT/app/android/app/src/main/assets/models/btc_voca.onnx" "$PKG/app/models/"
cp -r "$ROOT/app/dist" "$PKG/app/dist"
cp "$ROOT/LICENSE" "$PKG/LICENSE.txt"
cp "$ROOT/tools/pc/LEGGIMI.txt" "$PKG/LEGGIMI.txt"

echo "· OpenSpoty.exe"
/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe -nologo -target:winexe -optimize \
  -win32icon:"$(cygpath -w "$ROOT/tools/pc/stemkit.ico")" -r:System.Windows.Forms.dll \
  -out:"$(cygpath -w "$PKG/OpenSpoty.exe")" "$(cygpath -w "$ROOT/tools/pc/Launcher.cs")" >/dev/null

echo "· zip"
rm -f "$OUT/OpenSpoty-Windows.zip"
python - "$OUT" <<'EOF'
import sys, zipfile, os, pathlib
out = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(out / "OpenSpoty-Windows.zip", "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for dirpath, _, files in os.walk(out / "OpenSpoty"):
        for f in files:
            p = pathlib.Path(dirpath) / f
            if "__pycache__" in p.parts:
                continue
            z.write(p, p.relative_to(out))
EOF
ls -la "$OUT/OpenSpoty-Windows.zip"
