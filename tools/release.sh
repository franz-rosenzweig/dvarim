#!/bin/bash
# Cut a release: a signed APK and a zipped Mac app on GitHub, and the cask in the
# Homebrew tap pointed at the new zip.
#
#   tools/release.sh 0.2.1                 build, check, publish
#   tools/release.sh 0.2.1 --dry-run       build and check only; nothing leaves the Mac
#   tools/release.sh 0.2.1 --notes FILE    the release notes (default: a short line)
#
# Runs on the server, from any checkout: it builds the commit origin/master is at
# (or --ref), so what it ships is what is merged. The web app is built here; the
# APK and the Mac app are built on the Mac over SSH, in a folder of their own,
# so a working copy there is never touched. What the script needs to know about
# the Mac lives outside the repository, in ~/.config/dvarim-release.env:
#
#   MAC=user@host                  where to build
#   MAC_KEY=~/.ssh/key             the SSH key for it
#   MAC_DIR=Documents/…/dvarim-release        the build folder, relative to ~ there
#   MAC_ANDROID=Documents/…/dvarim/android    a checkout whose generated Android
#                                  project (bubblewrap's app/, gradle files) and
#                                  keystore.properties are borrowed, not copied
#   SIGN_HASH=…                    the SHA-1 of the Mac signing identity
#   SIGN_KEYCHAIN=Library/Keychains/….keychain-db   where that identity lives
#   SIGN_PASSWORD_FILE=.config/…   the file that unlocks it, on the Mac
#   TAP=git@github.com:owner/homebrew-tap.git
#
# Version numbers come from the tag. X.Y.Z is the Android versionName and the
# Mac's CFBundleShortVersionString; 10000·X + 100·Y + Z is the Android
# versionCode and the Mac's CFBundleVersion, so every release outranks the last
# and Obtainium and Homebrew both see it as newer. Nothing is committed for it.
set -euo pipefail

VERSION=${1:?usage: tools/release.sh X.Y.Z [--dry-run] [--notes FILE] [--ref REF]}
shift
DRY=0; NOTES=""; REF=origin/master
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --notes) NOTES=$2; shift ;;
    --ref) REF=$2; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[[ $VERSION =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "X.Y.Z, please" >&2; exit 2; }
CODE=$(( BASH_REMATCH[1] * 10000 + BASH_REMATCH[2] * 100 + BASH_REMATCH[3] ))

CONF=${DVARIM_RELEASE_ENV:-$HOME/.config/dvarim-release.env}
[ -f "$CONF" ] || { echo "no $CONF (see the top of this script)" >&2; exit 2; }
# shellcheck source=/dev/null
. "$CONF"
: "${MAC:?}" "${MAC_KEY:?}" "${MAC_DIR:?}" "${MAC_ANDROID:?}" "${SIGN_HASH:?}" "${SIGN_KEYCHAIN:?}" "${SIGN_PASSWORD_FILE:?}" "${TAP:?}"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 -i $MAC_KEY"
mac() { $SSH "$MAC" "$@"; }
say() { echo "release: $*"; }

REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'git -C "$REPO" worktree remove --force "$WORK/src" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# ---- what ships, and the web app inside both
git -C "$REPO" fetch -q origin
SHA=$(git -C "$REPO" rev-parse "$REF")
if [ "$DRY" = 0 ] && gh release view "v$VERSION" >/dev/null 2>&1; then
  echo "v$VERSION is already released" >&2; exit 1
fi
git -C "$REPO" worktree add -q --detach "$WORK/src" "$SHA"
say "v$VERSION (code $CODE) from $(git -C "$REPO" log --oneline -1 "$SHA")"
"$WORK/src/frontend/build.sh" >/dev/null

# ---- onto the Mac: the source, then the generated Android project beside it
mac "mkdir -p $MAC_DIR"
rsync -a --delete -e "$SSH" --exclude .git --exclude node_modules \
  --exclude 'android/app' --exclude 'android/build' --exclude 'android/*.keystore' --exclude 'android/keystore.properties' \
  --exclude 'mac/build-native' "$WORK/src/" "$MAC:$MAC_DIR/"
mac bash -s -- "$MAC_DIR" "$MAC_ANDROID" "$VERSION" "$CODE" <<'MAC'
set -euo pipefail
DIR=$HOME/$1; SRC=$HOME/$2; VERSION=$3; CODE=$4
cd "$DIR/android"
rsync -a --delete --exclude build --exclude .gradle "$SRC/app" ./
for f in build.gradle settings.gradle gradle.properties gradlew gradle manifest-checksum.txt; do
  [ -e "$SRC/$f" ] && rsync -a "$SRC/$f" ./
done
ln -sfn "$SRC/android.keystore" android.keystore
ln -sfn "$SRC/keystore.properties" keystore.properties
# the generated project carries a release's own numbers, and so does project.yml
sed -i '' -E "s/^( *)versionCode [0-9]+/\1versionCode $CODE/; s/^( *)versionName \"[^\"]*\"/\1versionName \"$VERSION\"/" app/build.gradle
sed -i '' -E "s/MARKETING_VERSION: \"[^\"]*\"/MARKETING_VERSION: \"$VERSION\"/; s/CURRENT_PROJECT_VERSION: \"[^\"]*\"/CURRENT_PROJECT_VERSION: \"$CODE\"/" ../mac/project.yml
# esbuild for the Mac app's engine is a native binary: the Mac's own, from the
# same checkout, which must be on the same lockfile
cmp -s "$SRC/../frontend/package-lock.json" ../frontend/package-lock.json || { echo "the borrowed node_modules are on another lockfile: npm ci there first" >&2; exit 1; }
ln -sfn "$SRC/../frontend/node_modules" ../frontend/node_modules
MAC

# ---- the APK
say "building the APK"
mac bash -s -- "$MAC_DIR" <<'MAC'
set -euo pipefail
cd "$HOME/$1/android"
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ANDROID_HOME=$HOME/android-sdk
zsh shell/apply.sh >/dev/null
./gradlew --quiet assembleRelease 2>&1 | grep -v -i -E "warning|deprecat" || true
MAC

# ---- the Mac app, signed with the shared identity in its own keychain
say "building the Mac app"
mac bash -s -- "$MAC_DIR" "$SIGN_HASH" "$SIGN_KEYCHAIN" "$SIGN_PASSWORD_FILE" "$VERSION" <<'MAC'
set -euo pipefail
export PATH=/opt/homebrew/bin:$PATH
cd "$HOME/$1/mac"
security unlock-keychain -p "$(cat "$HOME/$4")" "$HOME/$3"
rm -rf build-native
DVARIM_SIGN=$2 ./build-native.sh >/dev/null 2>&1 || DVARIM_SIGN=$2 ./build-native.sh
cd build-native
rm -f "Dvarim-$5-mac.zip"
ditto -c -k --keepParent Dvarim.app "Dvarim-$5-mac.zip"
MAC

# ---- what both say about themselves, before anything leaves the Mac
say "checking"
mac bash -s -- "$MAC_DIR" "$VERSION" "$CODE" <<'MAC'
set -euo pipefail
cd "$HOME/$1"
APK=android/app/build/outputs/apk/release/app-release.apk; APP=mac/build-native/Dvarim.app
BT=$(ls -d "$HOME"/android-sdk/build-tools/* | tail -1)
fail() { echo "CHECK FAILED: $*" >&2; exit 1; }
# Each tool's answer is kept, then searched: grep -q in a pipe stops reading at
# its first match, and with pipefail the tool it cut off counts as a failure.
"$BT/apksigner" verify "$APK" >/dev/null 2>&1 || fail "the APK's signature"
badging=$("$BT/aapt" dump badging "$APK" 2>/dev/null)
[[ $badging == *"versionCode='$3' versionName='$2'"* ]] || fail "the APK's version"
listing=$(unzip -l "$APK")
[[ $listing == *assets/web/index.html* ]] || fail "the web app is not in the APK"
codesign --verify --deep --strict "$APP" || fail "the Mac app's signature"
sig=$(codesign -dvv "$APP" 2>&1)
auth=$(sed -n 's/^Authority=//p' <<<"$sig" | sort -u)
[ "$auth" = "Dvarim" ] || fail "the Mac app is signed by '$auth', not only by Dvarim"
[[ $sig == *$'\n'"TeamIdentifier=not set"* ]] || fail "the Mac app carries a team"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$2" ] || fail "the Mac app's version"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")" = "$3" ] || fail "the Mac app's build"
[ -z "$(grep -r -l -a '/Users/' "$APP" || true)" ] || fail "a home folder's path is in the Mac app"
apkstrings=$(unzip -p "$APK" | LC_ALL=C strings)
[[ $apkstrings != */Users/* ]] || fail "a home folder's path is in the APK"
echo "checks pass"
MAC

OUT="$WORK/out"; mkdir -p "$OUT"
scp -q -o BatchMode=yes -i "$MAC_KEY" "$MAC:$MAC_DIR/android/app/build/outputs/apk/release/app-release.apk" "$OUT/Dvarim-$VERSION.apk"
scp -q -o BatchMode=yes -i "$MAC_KEY" "$MAC:$MAC_DIR/mac/build-native/Dvarim-$VERSION-mac.zip" "$OUT/"
ZIPSUM=$(sha256sum "$OUT/Dvarim-$VERSION-mac.zip" | cut -d' ' -f1)
say "APK $(du -h "$OUT/Dvarim-$VERSION.apk" | cut -f1), Mac zip $(du -h "$OUT/Dvarim-$VERSION-mac.zip" | cut -f1), zip sha256 $ZIPSUM"
if [ "$DRY" = 1 ]; then
  say "dry run: nothing published"; exit 0
fi

# ---- publish: the release, then the cask
NOTESFILE="$WORK/notes.md"
if [ -n "$NOTES" ]; then cp "$NOTES" "$NOTESFILE"; else printf 'Dvarim %s.\n' "$VERSION" > "$NOTESFILE"; fi
gh release create "v$VERSION" "$OUT/Dvarim-$VERSION.apk" "$OUT/Dvarim-$VERSION-mac.zip" \
  --target "$SHA" --title "Dvarim $VERSION" --notes-file "$NOTESFILE"
git clone -q "$TAP" "$WORK/tap"
sed -i -E "s/^  version \"[^\"]*\"/  version \"$VERSION\"/; s/^  sha256 \"[^\"]*\"/  sha256 \"$ZIPSUM\"/" "$WORK/tap/Casks/dvarim.rb"
git -C "$WORK/tap" commit -q -am "Dvarim $VERSION"
git -C "$WORK/tap" pull -q --rebase
git -C "$WORK/tap" push -q
say "released: $(gh release view "v$VERSION" --json url -q .url)"
