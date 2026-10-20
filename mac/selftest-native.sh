#!/bin/zsh
# Tests Dvarim Native from inside: a throwaway server of our own on a dated copy
# of sample-vault, with a password, on 127.0.0.1 (no Local Network prompt, and
# never your vault or your server); the real app, built ad hoc, signs in
# to it, keeps a copy, and goes through every list, ticking, ⌘Z, a change made
# by someone else, Remote mode and signing out. PASS/FAIL lines and a picture of
# each step land in build-native/selftest/. It takes over the screen for about
# a minute. Afterwards the app has removed its own settings, folder, token and
# cookies, and this script stops the server and deletes its copy.
#   ./selftest-native.sh
set -euo pipefail
cd "${0:A:h}"
REPO=${PWD:h}
# a free port of our own: something else (an ssh -R tunnel, another sandbox) may hold any fixed one
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1])")
PASSWORD=selftest-only-password
OUT=$PWD/build-native/selftest
NODE=$(command -v node) || { echo "no node" >&2; exit 1; }

rm -rf $OUT && mkdir -p $OUT
DVARIM_SIGN=- DVARIM_OUT=$OUT ./build-native.sh >$OUT/build.log 2>&1 || { cat $OUT/build.log; exit 1; }
APP="$OUT/Dvarim Native.app"

ROOT=$(mktemp -d -t dvarim-native-selftest)
python3 $REPO/tools/phone/sample_vault.py $ROOT/vault >/dev/null
$NODE --input-type=module -e "const { Auth } = await import(process.argv[1]); Auth.load(process.argv[2]).setPassword(process.argv[3]);" \
    "file://$REPO/server/src/auth.js" $ROOT/vault $PASSWORD
PORT=$PORT HOST=127.0.0.1 DVARIM_ROOT=$ROOT/vault DVARIM_STATIC=$REPO/frontend/dist $NODE $REPO/server/src/main.js >$OUT/server.log 2>&1 &
SERVER=$!
cleanup() { kill $SERVER 2>/dev/null || true; rm -rf $ROOT; }
trap cleanup EXIT
for i in {1..50}; do curl -sf http://127.0.0.1:$PORT/api/health >/dev/null && break; sleep 0.2; done
# and the server answering there must be this one
lsof -nP -iTCP:$PORT -sTCP:LISTEN -t | grep -qx $SERVER || { echo "the throwaway server did not start on :$PORT" >&2; cat $OUT/server.log >&2; exit 1; }

BIN="$APP/Contents/MacOS/Dvarim Native"
( sleep 300; pkill -f "$BIN" ) 2>/dev/null &
watchdog=$!
open -W -n "$APP" --args -SelfTest YES -SelfTestServer http://127.0.0.1:$PORT -SelfTestPassword $PASSWORD \
    -SelfTestOut $OUT -ApplePersistenceIgnoreState YES
kill $watchdog 2>/dev/null || true
grep -E "^(SELFTEST|PASS|FAIL)" $OUT/log.txt
grep -q "SELFTEST passed" $OUT/log.txt
