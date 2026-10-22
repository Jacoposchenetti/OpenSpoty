#!/usr/bin/env bash
# Rebuild StemKit Mobile for both devices: the phone (install on the
# USB-connected phone, relaunch, re-arm the WebView debugger 9222 + bridge
# tunnel 8777) and the PC (app/dist served by the bridge, pc-engine jars).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADB=~/Android/Sdk/platform-tools/adb.exe
export ANDROID_HOME="$HOME/Android/Sdk"
cd "$ROOT/app"
npx tsc --noEmit
npx vite build >/dev/null
npx cap sync android >/dev/null
# PC: the bridge serves app/dist as it is; the engine runs the phone's YouTubeSource.java
curl -s -m 5 -X POST http://127.0.0.1:8777/api/pc/stop-engine -d '{}' >/dev/null || true
(cd "$ROOT/pc-engine" && ./gradlew.bat -q installDist 2>&1 | grep -iE "error|FAIL" || true)
# a failed build must not install the previous APK
(cd android && ./gradlew.bat assembleDebug -q) || { echo "BUILD FAILED"; exit 1; }
cp android/app/build/outputs/apk/debug/app-debug.apk ~/Desktop/StemKitMobile.apk
$ADB install -r "$(cygpath -w ~/Desktop/StemKitMobile.apk)" | tail -1
$ADB shell am force-stop app.stemkitmobile
$ADB shell am start -n app.stemkitmobile/.MainActivity >/dev/null
sleep 5
SOCK=$($ADB shell cat /proc/net/unix | grep -o "webview_devtools_remote_[0-9]*" | tail -1)
$ADB forward --remove-all
$ADB forward tcp:9222 localabstract:$SOCK >/dev/null
$ADB reverse tcp:8777 tcp:8777 >/dev/null
echo "deployed ($SOCK)"
