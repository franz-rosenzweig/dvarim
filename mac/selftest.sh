#!/bin/zsh
# Tests the shell from inside: builds Dvarim with SelfTest/ linked in, runs it
# against a Dvarim server and checks what a person would press and see. ⌘N reaches
# the web app as New To-Do; ⌃⌘N opens a window whatever the page is doing; Quick
# Entry saves and hands the keyboard back; the Dock badge counts; and so on.
#
#   ./selftest.sh http://127.0.0.1:8420                 # every section
#   ./selftest.sh http://127.0.0.1:8420 keys,quick      # some: keys menus slim quick badge reminders menubar intents offline hotkey settings layout notes folder sync calendars local copy
#   ./selftest.sh http://127.0.0.1:8420 auth --session VALUE
#
# It writes to-dos, so point it at a dev server on a copy of sample-vault, never at
# the real vault: tools/phone/devserver.sh --fresh starts one on :8421. For `auth` the server needs a password; VALUE is a session it
# issued, e.g. node --input-type=module -e "const { Auth } = await import('./server/src/auth.js'); console.log(Auth.load('ROOT').issueSession())"
# run with the server's DVARIM_AUTH_FILE. The run takes the keyboard for about a
# minute and brings Finder forward once, so leave the Mac alone meanwhile. It runs
# as Dvarim (same bundle id), so quit Dvarim first. Pictures land in build/selftest/out.
# The sections run on the server's page (-vaultMode server); copy sets its own mode.
set -euo pipefail
cd "${0:A:h}"

URL=${1:?usage: selftest.sh URL [sections] [--session VALUE]}; shift
ARGS=(); SECTIONS=()
while (( $# )); do
    case $1 in
        --session) ARGS+=(-SelfTestSession "$2"); shift 2 ;;
        *) SECTIONS+=("$1"); shift ;;
    esac
done
(( ${#SECTIONS} )) && ARGS+=(-SelfTestOnly "${(j:,:)SECTIONS}")
host=${${URL#*://}%%[:/]*}
if [[ $host != (127.0.0.1|localhost) && -z ${DVARIM_SELFTEST_ANY_SERVER:-} ]]; then
    echo "refusing $URL: the self-test writes to-dos. Use a dev server on this Mac," >&2
    echo "or set DVARIM_SELFTEST_ANY_SERVER=1 if that server holds nothing you care about." >&2
    exit 2
fi
if pgrep -x Dvarim >/dev/null; then echo "quit Dvarim first: the self-test runs as Dvarim" >&2; exit 2; fi

OUT=build/selftest
mkdir -p $OUT && rm -rf $OUT/out && mkdir -p $OUT/out
clang -c -target "$(uname -m)-apple-macos14.0" SelfTest/hook.c -o $OUT/hook.o
# quiet unless it fails: the harness's one warning is CGWindowListCreateImage, deprecated but
# the only way to picture the app's own windows without the Screen Recording permission
DVARIM_OUT=$OUT DVARIM_EXTRA="SelfTest/SelfTest.swift SelfTest/FolderSync.swift $OUT/hook.o" ./build.sh >$OUT/build.log 2>&1 || { cat $OUT/build.log; exit 1; }

BIN=$PWD/$OUT/Dvarim.app/Contents/MacOS/Dvarim
( sleep 300; pkill -f "$BIN" ) 2>/dev/null &           # a stuck run ends after five minutes
watchdog=$!
open -W -n --stdout $OUT/out/log.txt --stderr $OUT/out/log.txt $OUT/Dvarim.app \
    --args -serverURL "$URL" -vaultMode server -SelfTestOut "$PWD/$OUT/out" -OutboxFile "$PWD/$OUT/out/outbox.json" \
    -SelfTestSample "${PWD:h}/sample-vault" -SelfTestRepo "${PWD:h}" -SelfTestNode "$(command -v node || true)" "${ARGS[@]}"
kill $watchdog 2>/dev/null || true
grep -E "^(SELFTEST|PASS|FAIL|SKIP|INFO|MENU)" $OUT/out/log.txt
grep -q "SELFTEST passed" $OUT/out/log.txt
