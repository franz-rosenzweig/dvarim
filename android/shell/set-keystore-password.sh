#!/bin/zsh
# Put the keystore's password into keystore.properties, safely.
#
#   ./shell/set-keystore-password.sh
#
# It asks with the echo off, checks the password against the keystore BEFORE
# writing anything, and writes it escaped the way java.util.Properties reads it
# back (a backslash is an escape there, and a trailing space is part of the
# value). Nothing is echoed, nothing reaches the shell's history, and the
# password is never passed as a command argument, where `ps` could see it.
#
# The password is the one typed when the keystore was made — `bubblewrap init`
# asked for it. It cannot be changed without knowing it, and it cannot be
# recovered: see the end of this file if it is gone for good.
set -euo pipefail
cd "${0:A:h}/.."

STORE=${1:-android.keystore}
ALIAS=dvarim
[[ -f $STORE ]] || { echo "no $STORE here" >&2; exit 1 }

jdk=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.bubblewrap/config.json'))).get('jdkPath',''))" 2>/dev/null || true)
[[ -d $jdk/Contents/Home ]] && jdk=$jdk/Contents/Home
KEYTOOL=${jdk:+$jdk/bin/keytool}; [[ -x ${KEYTOOL:-} ]] || KEYTOOL=keytool

ask() {   # ask "prompt" -> $REPLY_PW, never echoed
    local prompt=$1 pw
    printf '%s' "$prompt" >&2
    IFS= read -rs pw
    printf '\n' >&2
    REPLY_PW=$pw
}

opens() {  # opens <password> — through stdin, so it is not visible to `ps`
    printf '%s\n' "$1" | $KEYTOOL -list -keystore "$STORE" -alias "$ALIAS" >/dev/null 2>&1
}

for attempt in 1 2 3; do
    ask "The keystore password (nothing will appear as you type): "
    if opens "$REPLY_PW"; then break; fi
    echo "That one does not open $STORE." >&2
    (( attempt == 3 )) && { echo "Giving up. Read the note at the end of this script." >&2; exit 1 }
done

STORE_PW=$REPLY_PW

PW=$STORE_PW STORE=$STORE ALIAS=$ALIAS python3 - <<'PY'
import os
esc = lambda v: v.replace('\\', '\\\\')
open('keystore.properties', 'w').write(
    "# Written by shell/set-keystore-password.sh. Git ignores this file.\n"
    f"storeFile={os.environ['STORE']}\n"
    f"keyAlias={os.environ['ALIAS']}\n"
    f"storePassword={esc(os.environ['PW'])}\n"
    # No keyPassword line at all. Gradle reads it as
    # getProperty('keyPassword', getProperty('storePassword')) — and that default
    # applies only when the line is ABSENT. Present but empty is an empty
    # password, and signing fails exactly as it does with the wrong one.
    "# The key was made with the store's password. Leave this line out entirely\n"
    "# to let Gradle fall back to it: an empty keyPassword= is an empty password.\n")
os.chmod('keystore.properties', 0o600)
PY
unset STORE_PW REPLY_PW

echo
./shell/check-keystore.sh
echo
echo "If that says both are right:  ./shell/release.sh && adb install -r app-release-signed.apk"

# ---------------------------------------------------------------------------
# If the password is gone for good: it cannot be recovered, and this keystore
# can never sign again. The app can still be rebuilt with a NEW keystore, but
# Android will not install it over the old one — its signature differs. On a
# phone you control that costs one uninstall and one sign-in; nothing else is
# lost, because every to-do lives on the server, not in the app.
#
#   keytool -genkeypair -v -keystore android.keystore.new -alias dvarim \
#           -keyalg RSA -keysize 2048 -validity 10000
#   mv android.keystore.new android.keystore   # keep the old one until it works
#   ./shell/set-keystore-password.sh
#   adb uninstall xyz.tiresia.dvarim && ./shell/release.sh \
#     && adb install app-release-signed.apk
