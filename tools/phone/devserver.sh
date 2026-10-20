#!/bin/zsh
# A Dvarim server for the phone to talk to: the backend on 127.0.0.1:8421 over a
# copy of sample-vault, serving frontend/dist. Never the real vault — the checks
# here make to-dos, complete them and empty the Trash.
#
#   tools/phone/devserver.sh --fresh   # a new copy of sample-vault, dated to today, then start
#   tools/phone/devserver.sh           # (re)start on the copy there is
#   tools/phone/devserver.sh --stop
#
# The offline checks call it themselves: --stop is the plane, a plain start is
# landing, on the same copy, so what the phone kept arrives on the data it was
# made against. The phone reaches it through `adb reverse`, which touch.py does.
#
# It needs Node (the server has no dependencies: server/src/main.js) and python3
# for the sample vault.
set -euo pipefail
ROOT=${0:A:h:h:h}
WORK=${DVARIM_PHONE_WORK:-${TMPDIR:-/tmp}/dvarim-phone}
PORT=8421
PY=${DVARIM_PYTHON:-python3}

if [[ -f $WORK/server.pid ]]; then
    kill $(cat $WORK/server.pid) 2>/dev/null || true
    rm -f $WORK/server.pid
    for _ in {1..20}; do curl -s -m 1 http://127.0.0.1:$PORT/api/health >/dev/null || break; sleep 0.1; done
fi
[[ ${1:-} == --stop ]] && exit 0

[[ -f $ROOT/frontend/dist/index.html ]] || { echo "no frontend/dist: npm run build in frontend/ first" >&2; exit 1; }
mkdir -p $WORK
if [[ ${1:-} == --fresh || ! -d $WORK/vault ]]; then
    rm -rf $WORK/vault
    $PY ${0:A:h}/sample_vault.py $WORK/vault      # its dates moved up to today
fi

DVARIM_ROOT=$WORK/vault DVARIM_STATIC=$ROOT/frontend/dist DVARIM_AUTH_FILE=$WORK/auth.json \
    PORT=$PORT HOST=127.0.0.1 nohup node $ROOT/server/src/main.js >$WORK/server.log 2>&1 &!
echo $! > $WORK/server.pid
for _ in {1..40}; do
    curl -s -m 1 http://127.0.0.1:$PORT/api/health >/dev/null && exit 0
    sleep 0.25
done
echo "the server did not come up; see $WORK/server.log" >&2
exit 1
