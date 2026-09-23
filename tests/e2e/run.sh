#!/usr/bin/env bash
# Runs the e2e tests (tests/e2e) against local firebase emulators: BUILDS the app, seeds the
# anonymous items, starts the production server and runs playwright. Extra arguments are passed to
# `playwright test` (e.g. --update-snapshots).
# The build is not optional: this is the authoritative gate, and without it browser tests exercise
# whatever `build/` happened to contain — a stale bundle silently "passed" a round of client-side
# changes it never contained.
#
# QUICK LOOP: there is no way to reuse a server or a build and stay honest — reuseExistingServer is
# false and a bare `npx playwright test` is outside the emulator environment. The smallest
# NON-AUTHORITATIVE loop is this script with the build skipped:
#     SKIP_BUILD=1 tests/e2e/run.sh tests/e2e/personal.spec.ts
# It still starts fresh emulators, seeds, and serves the build already in `build/`. Never report a
# SKIP_BUILD run as the gate.
#
# TARGETED ITERATION: naming a spec runs only its rows (every browser project is an independent
# LANE, see src/e2e_lanes.js — there is no dependency chain, so nothing to skip with --no-deps):
#     tests/e2e/run.sh tests/e2e/editor.spec.ts
# The stack is the same either way: every lane's server starts and every lane's project is
# seeded (a few seconds). This still builds and starts a fresh stack each time; it is the fast
# path that stays honest.
# Do NOT flip reuseExistingServer globally to avoid that (see playwright.config.ts) — a second
# shell reaching a server started elsewhere is how a run can end up against production data.
#
# AFTER A FAILURE: playwright-report/ and test-results/ are OVERWRITTEN by the next run. Preserve
# them before rerunning, or the trace of an intermittent failure is gone (that is exactly how one
# markdown-corpus timeout became unexplainable).
#
# The firestore emulator needs a JDK; homebrew's keg-only openjdk is added to PATH if present.
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
# the vendored cdn assets (vault design mind_task_agents 9.7; src/server/vendor.mjs): a lane
# server serves the shell with its cdn origins pointed at its own `/vendor/<host>` route and
# serves the assets from the cache under the real home, online or not, while the gate's browsers
# refuse every remote host (playwright.config.ts); the manifest's assets are fetched into the
# cache when online and required complete when not, and a vendor request outside the manifest
# fails the run below with the url to record (`node tests/e2e/vendor.mjs add <url>`, host-side)
export VENDOR_DIR="${VENDOR_DIR:-$HOME/.cache/mindpage/vendor}"
# the browsers the gate starts outside the lanes (prerender.mjs) resolve loopback only too
export E2E_OFFLINE=1
node tests/e2e/vendor.mjs fill
mkdir -p test-results
export VENDOR_UNLISTED="$PWD/test-results/vendor_unlisted.txt"
rm -f "$VENDOR_UNLISTED"
# SKIP_BUILD is the quick loop above and is NOT the gate: it serves whatever `build/` holds
if [ -n "${SKIP_BUILD:-}" ]; then
  echo "WARNING: SKIP_BUILD=1 — serving the EXISTING build/; any src/ change is invisible to this run" >&2
else
  npm run build # browser tests must exercise the sources in this tree
fi
# the inner command is parsed by ANOTHER shell, so each argument is %q-quoted: bare $* loses
# argument boundaries and quoting (a --grep 'a|b' would become a shell pipeline there)
playwright_args=''
[ $# -gt 0 ] && printf -v playwright_args ' %q' "$@"
status=0
firebase emulators:exec --only auth,firestore "node tests/e2e/seed.mjs && npx playwright test$playwright_args" || status=$?
if [ -s "$VENDOR_UNLISTED" ]; then
  echo "cdn assets outside the vendored manifest were requested (reason, url, referer; record each with \`node tests/e2e/vendor.mjs add <url>\`):" >&2
  sort -u "$VENDOR_UNLISTED" >&2
  exit 1
fi
exit $status
