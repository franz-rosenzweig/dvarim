#!/bin/zsh
# A signed release APK, without typing a password.
#
#   ./shell/release.sh
#
# `bubblewrap build` asks for the keystore password every time and, if signing
# fails, prints the whole apksigner command — password included — into the
# terminal. This signs from android/keystore.properties instead, which git
# ignores and nothing echoes. Copy keystore.properties.example to start.
#
# Without that file the build still runs and leaves the APK unsigned, which is
# enough to check that something compiles.
#
# Use `bubblewrap build` when twa-manifest.json changes and you want its version
# bump and its .aab; use this for everything else.
set -euo pipefail
cd "${0:A:h}/.."

./shell/apply.sh

# Bubblewrap already worked out where the JDK and SDK live. Borrow its answers
# rather than making everyone set JAVA_HOME by hand.
CONFIG=~/.bubblewrap/config.json
if [[ -f $CONFIG ]]; then
    jdk=$(python3 -c "import json;print(json.load(open('$CONFIG')).get('jdkPath',''))")
    sdk=$(python3 -c "import json;print(json.load(open('$CONFIG')).get('androidSdkPath',''))")
    [[ -d $jdk/Contents/Home ]] && jdk=$jdk/Contents/Home
    [[ -n $jdk ]] && export JAVA_HOME=$jdk
    [[ -n $sdk ]] && export ANDROID_HOME=$sdk
fi
[[ -n ${JAVA_HOME:-} ]] || { echo "set JAVA_HOME, or run bubblewrap doctor" >&2; exit 1 }
[[ -n ${ANDROID_HOME:-} ]] || { echo "set ANDROID_HOME, or run bubblewrap doctor" >&2; exit 1 }

./gradlew --quiet assembleRelease

OUT=app/build/outputs/apk/release
if [[ -f $OUT/app-release.apk ]]; then
    cp $OUT/app-release.apk app-release-signed.apk
    echo "signed: android/app-release-signed.apk"
    echo "install it with: adb install -r app-release-signed.apk"
else
    echo "built, unsigned: $OUT/app-release-unsigned.apk" >&2
    echo "add android/keystore.properties (see keystore.properties.example) to sign it" >&2
fi
