#!/bin/zsh
# Builds Dvarim.app with the Command Line Tools alone, no Xcode needed:
#   ./build.sh && open build/Dvarim.app
# The settings and Info.plist keys come from project.yml, the same spec the Xcode
# project is generated from, so the two builds cannot drift apart.
set -euo pipefail
cd "${0:A:h}"

command -v swiftc >/dev/null || { echo "no swiftc: run xcode-select --install" >&2; exit 1; }
command -v xcodegen >/dev/null || { echo "no xcodegen: run brew install xcodegen" >&2; exit 1; }

setting() { sed -n "s/^ *$1: *\"*\([^\"]*\)\"*$/\1/p" project.yml | head -1; }
BUNDLE_ID=$(setting PRODUCT_BUNDLE_IDENTIFIER)
VERSION=$(setting MARKETING_VERSION)
BUILD=$(setting CURRENT_PROJECT_VERSION)
MACOS=$(setting macOS)

OUT=${DVARIM_OUT:-build}               # selftest.sh builds its variant into build/selftest
APP=$OUT/Dvarim.app

xcodegen generate --quiet               # writes Dvarim/Info.plist (and the Xcode project)
rm -rf $APP && mkdir -p $APP/Contents/MacOS $APP/Contents/Resources
# The const values are what the App Intents processor reads further down.
cat > $OUT/appintents-protocols.json <<'PROTOCOLS'
["AppEntity","AppEnum","AppIntent","AppShortcutsProvider","DynamicOptionsProvider","EntityQuery","Resolver"]
PROTOCOLS
swiftc -O -wmo -sdk "$(xcrun --show-sdk-path)" -target "$(uname -m)-apple-macos$MACOS" -swift-version 5 \
    -parse-as-library -module-name Dvarim Dvarim/*.swift ${=DVARIM_EXTRA:-} \
    -emit-const-values-path $OUT/Dvarim.swiftconstvalues \
    -Xfrontend -const-gather-protocols-file -Xfrontend $OUT/appintents-protocols.json \
    -o $APP/Contents/MacOS/Dvarim
sed -e "s/\$(DEVELOPMENT_LANGUAGE)/en/" -e "s/\$(EXECUTABLE_NAME)/Dvarim/" \
    -e "s/\$(PRODUCT_BUNDLE_IDENTIFIER)/$BUNDLE_ID/" -e "s/\$(MARKETING_VERSION)/$VERSION/" \
    -e "s/\$(CURRENT_PROJECT_VERSION)/$BUILD/" Dvarim/Info.plist > $APP/Contents/Info.plist
plutil -lint -s $APP/Contents/Info.plist

# The web app, served from inside the app when the to-dos are in a folder on this
# Mac (AppScheme.swift). Without it the app is exactly the server's window.
WEB=../frontend/dist
if [[ -f $WEB/index.html ]]; then
    rm -rf $APP/Contents/Resources/web && cp -R $WEB $APP/Contents/Resources/web
else
    echo "no web build: folder mode will be unavailable (cd ../frontend && npm ci && npm run build)" >&2
fi

# The app icon, drawn on the macOS icon grid already: margin, shape and shadow.
SRC=AppIcon-1024.png
if [[ -f $SRC ]]; then
    SET=$OUT/AppIcon.iconset && rm -rf $SET && mkdir -p $SET
    for s in 16 32 128 256 512; do
        sips -z $s $s $SRC --out $SET/icon_${s}x${s}.png >/dev/null
        sips -z $((s * 2)) $((s * 2)) $SRC --out $SET/icon_${s}x${s}@2x.png >/dev/null
    done
    iconutil -c icns $SET -o $APP/Contents/Resources/AppIcon.icns
    plutil -replace CFBundleIconFile -string AppIcon $APP/Contents/Info.plist
    rm -rf $SET
fi

# Shortcuts, Spotlight and Siri read a metadata bundle beside the binary, and only
# Xcode's processor writes one. Without Xcode the app still builds and runs; it
# just does not appear in Shortcuts.
PROCESSOR=$(xcrun -f appintentsmetadataprocessor 2>/dev/null || true)
if [[ -n $PROCESSOR ]]; then
    printf '%s\n' $PWD/Dvarim/*.swift > $OUT/appintents-sources.txt
    echo "${OUT:A}/Dvarim.swiftconstvalues" > $OUT/appintents-constvals.txt
    $PROCESSOR --toolchain-dir "$(dirname "$(dirname "$(xcrun -f swiftc)")")" --module-name Dvarim \
        --sdk-root "$(xcrun --show-sdk-path)" --xcode-version "$(xcodebuild -version | tail -1 | awk '{print $3}')" \
        --platform-family macOS --deployment-target $MACOS --bundle-identifier $BUNDLE_ID \
        --output $APP/Contents/Resources --target-triple "$(uname -m)-apple-macos$MACOS" \
        --binary-file $APP/Contents/MacOS/Dvarim --source-file-list $OUT/appintents-sources.txt \
        --swift-const-vals-list $OUT/appintents-constvals.txt --compile-time-extraction \
        --deployment-aware-processing --quiet-warnings >/dev/null 2>$OUT/appintents.log \
        || { cat $OUT/appintents.log; exit 1; }
else
    echo "note: no Xcode, so no App Intents metadata; Shortcuts will not see Dvarim"
fi

# An Apple Development identity if there is one (Xcode makes it from your Apple ID),
# ad-hoc otherwise, which is enough to run it locally.
IDENTITY=${DVARIM_SIGN:-$(security find-identity -v -p codesigning | sed -n 's/^ *[0-9]*) \([0-9A-F]*\) "Apple Development.*/\1/p' | head -1)}
codesign --force --options runtime --entitlements Dvarim/Dvarim.entitlements --sign "${IDENTITY:--}" $APP
[[ -n $IDENTITY ]] || echo "note: signed ad-hoc; fine locally, but see the README on signing"
echo "built $APP"
if [[ $OUT == build ]]; then
    echo "install it with: cp -R $APP /Applications/   (notifications only work from there)"
fi
