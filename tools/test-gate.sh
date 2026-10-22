#!/bin/bash
# The tests a deploy must pass (tools/autodeploy.sh): the engine's and the
# server's, in Node, with no Python. The parity suites hold the engine to the
# Python's answers recorded in engine/test/golden/ (engine/test/oracle.js);
# only the live-only auth check skips. autodeploy.sh reads the "# fail N" lines.
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e TZ=UTC \
  -v "$PWD":/repo -w /repo node:22-alpine sh -c \
  'cd engine && node --test test/*.test.js 2>&1 | tail -8 && cd ../server && node --test test/*.test.js 2>&1 | tail -8'
