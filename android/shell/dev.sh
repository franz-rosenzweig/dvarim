#!/bin/zsh
# Open a development server in the test build on a phone plugged in over USB.
#
#   ./shell/dev.sh [http://localhost:8421]
#
# Builds and installs the debug variant (it sits beside the real app, under
# <applicationId>.debug), tunnels the port to the phone, opens DevActivity on
# it, and forwards the WebView's DevTools to http://localhost:9222 — open
# chrome://inspect, or talk CDP to it. Real touches reach a real WebView, which
# is the only honest test of a touch gesture: see DevBuild.java.
set -euo pipefail
cd "${0:A:h}/.."
URL=${1:-http://localhost:8421}
PORT=${${URL##*:}%%/*}
CFG=~/.bubblewrap/config.json
export JAVA_HOME=${JAVA_HOME:-$(python3 -c "import json;print(json.load(open('$CFG'))['jdkPath'])")}
export ANDROID_HOME=${ANDROID_HOME:-$(python3 -c "import json;print(json.load(open('$CFG'))['androidSdkPath'])")}
[[ -x $JAVA_HOME/bin/java ]] || export JAVA_HOME=$JAVA_HOME/Contents/Home
PKG=$(python3 -c "import json;print(json.load(open('twa-manifest.json'))['packageId'])").debug

./shell/apply.sh >/dev/null
./gradlew assembleDebug -q
adb install -r app/build/outputs/apk/debug/app-debug.apk >/dev/null
adb reverse tcp:$PORT tcp:$PORT >/dev/null
adb shell am force-stop $PKG
adb shell am start -n $PKG/xyz.tiresia.dvarim.DevActivity --es url "$URL/" >/dev/null
for i in {1..30}; do
    SOCK=$(adb shell cat /proc/net/unix | grep -a -o 'webview_devtools_remote_[0-9]*' | tail -1) && [[ -n $SOCK ]] && break
    sleep 0.3
done
adb forward tcp:9222 localabstract:$SOCK >/dev/null
echo "$URL is open on the phone; DevTools at http://localhost:9222/json"
