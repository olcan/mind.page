#!/usr/bin/env bash
# Runs the e2e tests (tests/e2e) against local firebase emulators: BUILDS the app, seeds the
# anonymous items, starts the production server and runs playwright. Extra arguments are passed to
# `playwright test` (e.g. --update-snapshots).
# The build is not optional: this is the authoritative gate, and without it browser tests exercise
# whatever `build/` happened to contain — a stale bundle silently "passed" a round of client-side
# changes it never contained. Use `npx playwright test` directly for a quick loop against an
# existing build.
#
# TARGETED ITERATION: naming a write spec still runs the whole chromium project first, because the
# write project DEPENDS on it — `run.sh tests/e2e/personal.spec.ts` selects 55 tests, not the 14 in
# that file (editor: 51 rather than 10). Add --no-deps to select only the file's own tests:
#     tests/e2e/run.sh tests/e2e/personal.spec.ts --no-deps
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
npm run build # always: browser tests must exercise the sources in this working tree
firebase emulators:exec --only auth,firestore "node tests/e2e/seed.mjs && npx playwright test $*"
