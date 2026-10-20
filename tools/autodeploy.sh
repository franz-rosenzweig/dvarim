#!/bin/bash
# Pull master and redeploy, if and only if that is safe.
#
# Cron runs this every few minutes. It is quiet when there is nothing to do, so
# the only lines in the log are real deploys and real problems.
#
# It refuses rather than guesses: a dirty working tree, a detached HEAD or a
# branch that has diverged from origin all stop it, because this checkout is
# also where the server's code is edited by hand. Tests run before the build,
# and a deploy that does not answer on its port is rolled back to the image it
# replaced.
#
# Everything lives inside a function so bash parses the whole file before
# running any of it — otherwise `git merge` could change this script underneath
# the interpreter mid-run.

main() {
  set -uo pipefail

  REPO=/srv/dev/dvarim
  STACK=/srv/docker/docker-compose.yml
  HEALTH=http://127.0.0.1:8420/api/auth
  LOCK=/tmp/dvarim-autodeploy.lock
  QUIET=0
  [ "${1:-}" = "--quiet" ] && QUIET=1

  say()  { echo "dvarim-deploy: $*"; }
  note() { [ "$QUIET" = 1 ] || say "$*"; }

  # One at a time. A build outlives the five-minute cron tick.
  exec 9>"$LOCK" || { say "cannot open $LOCK"; return 1; }
  flock -n 9 || { note "another run is still going"; return 0; }

  cd "$REPO" || { say "no $REPO"; return 1; }

  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$branch" != "master" ]; then
    say "on '$branch', not master — leaving it alone"; return 0
  fi
  if ! git diff --quiet || ! git diff --cached --quiet; then
    say "working tree has uncommitted changes — leaving it alone"; return 0
  fi

  git fetch --quiet origin master || { say "fetch failed"; return 1; }
  local_sha=$(git rev-parse HEAD)
  remote_sha=$(git rev-parse origin/master)
  [ "$local_sha" = "$remote_sha" ] && return 0          # nothing new: silence

  # Behind is fine; diverged is not. --ff-only decides that for us.
  if ! git merge --ff-only origin/master >/dev/null 2>&1; then
    say "master has diverged from origin — not deploying. Sort it out by hand."
    return 1
  fi
  say "$(git rev-list --count "$local_sha"..HEAD) new commit(s): $(git log --oneline -1)"

  # What to go back to if this does not come up.
  old_image=$(docker image inspect dvarim:latest --format '{{.Id}}' 2>/dev/null)
  [ -n "$old_image" ] && docker tag "$old_image" dvarim:rollback >/dev/null 2>&1

  rollback() {
    say "ROLLING BACK to $local_sha"
    git reset --hard --quiet "$local_sha"
    if [ -n "$old_image" ]; then
      docker tag dvarim:rollback dvarim:latest >/dev/null 2>&1
      docker compose -f "$STACK" up -d --force-recreate dvarim >/dev/null 2>&1
    fi
    say "rolled back. The tree and the container are back on $local_sha."
  }

  # the engine's and the server's tests; `node --test` ends with a "# fail N" line
  if ! out=$(tools/test-gate.sh 2>&1) || ! echo "$out" | grep -q "^# fail 0" || echo "$out" | grep -qE "^# fail [1-9]"; then
    say "TESTS FAILED — not deploying"
    echo "$out" | tail -15
    git reset --hard --quiet "$local_sha"
    return 1
  fi
  note "tests: $(echo "$out" | grep -E '^# (pass|fail)' | tr '\n' ' ')"

  if ! out=$(frontend/build.sh 2>&1); then
    say "FRONTEND BUILD FAILED — not deploying"
    echo "$out" | tail -15
    git reset --hard --quiet "$local_sha"
    return 1
  fi

  if ! out=$(docker compose -f "$STACK" up -d --build dvarim 2>&1); then
    say "DEPLOY FAILED"; echo "$out" | tail -15; rollback; return 1
  fi

  # It is only deployed when it answers.
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$HEALTH")" = "200" ] && {
      say "deployed $(git rev-parse --short HEAD) — $(git log --oneline -1 --format=%s)"
      return 0
    }
    sleep 2
  done
  say "HEALTH CHECK FAILED: $HEALTH never returned 200"
  docker logs --tail 20 dvarim 2>&1
  rollback
  return 1
}

main "$@"
