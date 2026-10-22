#!/bin/zsh
# Builds Dvarim Native.app, the native app (Native/), with the Command Line
# Tools and XcodeGen, the way build.sh builds the web-view one:
#   ./build-native.sh && open "build-native/Dvarim Native.app"
# The engine (../engine/src) goes inside it as one script, bundled by esbuild
# with Native/Engine/host.js; Native/Engine/prelude.js goes beside it.
#   DVARIM_SIGN=-        ad hoc signing (tests, and anywhere the keychain is locked)
#   DVARIM_OUT=dir       somewhere other than build-native/
set -euo pipefail
cd "${0:A:h}"

command -v swiftc >/dev/null || { echo "no swiftc: run xcode-select --install" >&2; exit 1; }
command -v xcodegen >/dev/null || { echo "no xcodegen: run brew install xcodegen" >&2; exit 1; }
ESBUILD=../frontend/node_modules/.bin/esbuild
[[ -x $ESBUILD ]] || { echo "no esbuild: cd ../frontend && npm ci" >&2; exit 1; }

# this target's settings, from its block of project.yml
block() { awk '/^  DvarimNative:/{on=1} on' project.yml; }
setting() { block | sed -n "s/^ *$1: *\"*\([^\"]*\)\"*$/\1/p" | head -1; }
BUNDLE_ID=$(setting PRODUCT_BUNDLE_IDENTIFIER)
VERSION=$(setting MARKETING_VERSION)
BUILD=$(setting CURRENT_PROJECT_VERSION)
MACOS=$(setting deploymentTarget)
NAME="Dvarim Native"

OUT=${DVARIM_OUT:-build-native}
APP="$OUT/$NAME.app"

xcodegen generate --quiet               # writes Native/Info.plist and the entitlements
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

$ESBUILD Native/Engine/host.js --bundle --format=iife --target=es2022 --log-level=warning \
    --outfile="$APP/Contents/Resources/engine.js"
cp Native/Engine/prelude.js "$APP/Contents/Resources/prelude.js"

# the const values are what the App Intents processor reads, further down
cat > $OUT/appintents-protocols.json <<'PROTOCOLS'
["AppEntity","AppEnum","AppIntent","AppShortcutsProvider","DynamicOptionsProvider","EntityQuery","Resolver"]
PROTOCOLS
SOURCES=(Native/*.swift Native/Shell/*.swift Shared/*.swift)
swiftc -O -wmo -sdk "$(xcrun --show-sdk-path)" -target "$(uname -m)-apple-macos$MACOS" -swift-version 5 \
    -parse-as-library -module-name DvarimNative $SOURCES \
    -emit-const-values-path $OUT/DvarimNative.swiftconstvalues \
    -Xfrontend -const-gather-protocols-file -Xfrontend $OUT/appintents-protocols.json \
    -o "$APP/Contents/MacOS/$NAME"
sed -e "s/\$(DEVELOPMENT_LANGUAGE)/en/" -e "s/\$(EXECUTABLE_NAME)/$NAME/" \
    -e "s/\$(PRODUCT_BUNDLE_IDENTIFIER)/$BUNDLE_ID/" -e "s/\$(MARKETING_VERSION)/$VERSION/" \
    -e "s/\$(CURRENT_PROJECT_VERSION)/$BUILD/" -e "s/\$(PRODUCT_NAME)/$NAME/" Native/Info.plist > "$APP/Contents/Info.plist"
plutil -lint -s "$APP/Contents/Info.plist"

# the app's icon, the same paper slips as build.sh's, already on Apple's grid
SRC=AppIcon-1024.png
if [[ -f $SRC ]]; then
    SET=$OUT/AppIcon.iconset && rm -rf $SET && mkdir -p $SET
    for s in 16 32 128 256 512; do
        sips -z $s $s $SRC --out $SET/icon_${s}x${s}.png >/dev/null
        sips -z $((s * 2)) $((s * 2)) $SRC --out $SET/icon_${s}x${s}@2x.png >/dev/null
    done
    iconutil -c icns $SET -o "$APP/Contents/Resources/AppIcon.icns"
    plutil -replace CFBundleIconFile -string AppIcon "$APP/Contents/Info.plist"
    rm -rf $SET
fi

# Shortcuts, Spotlight and Siri read a metadata bundle beside the binary, which
# only Xcode's processor writes. Without Xcode the app still builds and runs; it
# just isn't in Shortcuts.
PROCESSOR=$(xcrun -f appintentsmetadataprocessor 2>/dev/null || true)
if [[ -n $PROCESSOR ]]; then
    printf '%s\n' ${SOURCES:A} > $OUT/appintents-sources.txt
    echo "${OUT:A}/DvarimNative.swiftconstvalues" > $OUT/appintents-constvals.txt
    $PROCESSOR --toolchain-dir "$(dirname "$(dirname "$(xcrun -f swiftc)")")" --module-name DvarimNative \
        --sdk-root "$(xcrun --show-sdk-path)" --xcode-version "$(xcodebuild -version | tail -1 | awk '{print $3}')" \
        --platform-family macOS --deployment-target $MACOS --bundle-identifier $BUNDLE_ID \
        --output "$APP/Contents/Resources" --target-triple "$(uname -m)-apple-macos$MACOS" \
        --binary-file "$APP/Contents/MacOS/$NAME" --source-file-list $OUT/appintents-sources.txt \
        --swift-const-vals-list $OUT/appintents-constvals.txt --compile-time-extraction \
        --deployment-aware-processing --quiet-warnings >/dev/null 2>$OUT/appintents.log \
        || { cat $OUT/appintents.log; exit 1; }
else
    echo "note: no Xcode, so no App Intents metadata; Shortcuts won't see Dvarim Native"
fi

IDENTITY=${DVARIM_SIGN:-$(security find-identity -v -p codesigning | sed -n 's/^ *[0-9]*) \([0-9A-F]*\) "Apple Development.*/\1/p' | head -1)}
codesign --force --options runtime --entitlements Native/DvarimNative.entitlements --sign "${IDENTITY:--}" "$APP"
echo "built $APP"
