#!/usr/bin/env bash
# Serves the e2e stack interactively: firebase emulators seeded with the anonymous items (every
# lane's project, see src/e2e_lanes.js) plus the production build on http://localhost:3100 (the
# first lane's origin and project; its own origin, so storage, cache and sign-in state
# stay apart from sapper dev on 3000; requires a prior `sapper build`), until Ctrl-C.
# Open http://localhost:3100/ to browse the seeded account, or run playwright against it
# NOTE this server is for LOOKING at the seeded accounts, not for running the suite against. The
# tests do NOT reuse it: playwright.config.ts sets reuseExistingServer:false (a stale bundle once
# passed a whole round that way), and a second shell is outside this emulator environment anyway.
set -euo pipefail
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" # resolved before the cd (the lock re-exec)
cd "$(dirname "$0")/../.."
[ -d /opt/homebrew/opt/openjdk/bin ] && export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" # see deploy_mind_page.sh
# ONE emulator stack per machine (vault design mind_task_agents 9.7): the fixed ports (the
# emulators 8080/9099/4400/9150, the lane servers 3100-3110) are shared by every session and
# every worker sandbox on this host, so the whole run holds a kernel advisory lock (held by
# this process and by any child that inherits the descriptor: an orphaned child keeps it, and
# the next run waits until it is gone or the wait runs out) for a bounded wait on a running one; an
# occupied port after the lock belongs to a process the lock does not govern (an orphan from a
# killed run, or something else): refuse with the diagnosis rather than kill
VAULT_PORTS_LOCK="${VAULT_PORTS_LOCK:-/tmp/vault_e2e_ports.lock}"
if [ -z "${VAULT_PORTS_LOCKED:-}" ]; then
  export VAULT_PORTS_LOCKED=1
  exec flock -w "${VAULT_PORTS_WAIT:-1800}" "$VAULT_PORTS_LOCK" "$self" "$@"
fi
if lsof -nP -iTCP:8080 -iTCP:9099 -iTCP:4400 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "the emulator ports are in use by a process this lock does not govern (an orphan of a killed run?):" >&2
  lsof -nP -iTCP:8080 -iTCP:9099 -iTCP:4400 -sTCP:LISTEN >&2 || true
  echo "stop it first (see docs/mind_page.md, Testing); nothing was started" >&2
  exit 75
fi
[ -f build/handler.js ] || { echo "missing production build; run: npm run build" >&2; exit 1; }
# the seeder keeps watching fixtures/markdown/*.md and re-seeds on save, so edits appear live at
# http://localhost:3100/?shared=markdown_e2e/markdown (the app applies them as remote updates)
# seeding completes before the server starts (a visit during seeding would find an empty account);
# the watcher then re-seeds (idempotently, once more at startup) as fixture files change
firebase emulators:exec --only auth,firestore \
    'node tests/e2e/seed.mjs && { node tests/e2e/seed.mjs --watch > /dev/null 2>&1 & SEED=$!; } && echo "serving seeded accounts (Ctrl-C to stop):" && echo "  http://localhost:3100/" && echo "  http://localhost:3100/?shared=markdown_e2e/markdown  (markdown corpus)" && env -u FIREBASE_CONFIG NO_HTTPS=1 HOST=127.0.0.1 PORT=3100 NODE_ENV=production CONTENT_CACHE_MS=3000 node server.mjs; kill $SEED 2>/dev/null'
