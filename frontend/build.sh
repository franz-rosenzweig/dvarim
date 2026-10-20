#!/usr/bin/env bash
# Build the Dvarim frontend without node on the host: everything runs in node:22 via Docker.
# Output lands in ./dist, which the backend serves at /.
set -euo pipefail
cd "$(dirname "$0")"
# The whole repository goes in, not just frontend/: the page imports the engine
# from ../engine (vite.config.js, '@engine').
REPO=$(cd .. && pwd)
run() {
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$REPO":/repo -w /repo/frontend node:22 npm "$@"
}
# Install when there is nothing installed, when asked, or when the lockfile
# has changed since the last install: a checkout that already had
# node_modules once built without a package a later commit added
# (CodeMirror), and the auto-deploy refused the build.
STAMP=node_modules/.dvarim-lock
LOCK=$(sha1sum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "${1:-}" = "--install" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$LOCK" ]; then
  run ci --no-audit --no-fund
  echo "$LOCK" > "$STAMP"
fi
run run build
echo "built: $(du -sh dist | cut -f1) in $PWD/dist"
