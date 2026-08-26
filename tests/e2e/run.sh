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
#     SKIP_BUILD=1 tests/e2e/run.sh tests/e2e/personal.spec.ts --no-deps
# It still starts fresh emulators, seeds, and serves the build already in `build/`. Never report a
# SKIP_BUILD run as the gate.
#
# TARGETED ITERATION: a spec whose project has DEPENDENCIES drags their closure along. `editor`
# depends on `admin`, which depends on `chromium`, so naming editor.spec.ts selects 55 tests rather
# than its own 10; add --no-deps for just the file's own:
#     tests/e2e/run.sh tests/e2e/editor.spec.ts --no-deps
# `personal` has no dependencies, so naming it already selects only its own 14.
# This still builds and starts a fresh stack each time; it is the fast path that stays honest.
# Do NOT flip reuseExistingServer globally to avoid that (see playwright.config.ts) — a second
# shell reaching a server started elsewhere is how a run can end up against production data.
#
# AFTER A FAILURE: playwright-report/ and test-results/ are OVERWRITTEN by the next run. Preserve
# them before rerunning, or the trace of an intermittent failure is gone (that is exactly how one
# markdown-corpus timeout became unexplainable).
#
# The firestore emulator needs a JDK; homebrew's keg-only openjdk is added to PATH if present.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -d /opt/homebrew/opt/openjdk/bin ] && export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" # see deploy_mind_page.sh
# SKIP_BUILD is the quick loop above and is NOT the gate: it serves whatever `build/` holds
[ -n "${SKIP_BUILD:-}" ] || npm run build # browser tests must exercise the sources in this tree
firebase emulators:exec --only auth,firestore "node tests/e2e/seed.mjs && npx playwright test $*"
