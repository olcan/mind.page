#!/usr/bin/env bash
# Runs the e2e tests (tests/e2e) against local firebase emulators: BUILDS the app, seeds the
# anonymous items, starts the production server and runs playwright. Extra arguments are passed to
# `playwright test` (e.g. --update-snapshots).
# The build is not optional: this is the authoritative gate, and without it browser tests exercise
# whatever `build/` happened to contain — a stale bundle silently "passed" a round of client-side
# changes it never contained. Use `npx playwright test` directly for a quick loop against an
# existing build.
# The firestore emulator needs a JDK; homebrew's keg-only openjdk is added to PATH if present.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -d /opt/homebrew/opt/openjdk/bin ] && export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" # see deploy_mind_page.sh
npm run build # always: browser tests must exercise the sources in this working tree
firebase emulators:exec --only auth,firestore "node tests/e2e/seed.mjs && npx playwright test $*"
