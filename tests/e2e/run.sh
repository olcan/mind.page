#!/usr/bin/env bash
# Runs the e2e tests (tests/e2e) against local firebase emulators: seeds the anonymous items, starts
# the production server (node __sapper__/build, requires a prior `sapper build`), and runs
# playwright. Extra arguments are passed to `playwright test` (e.g. --update-snapshots).
# The firestore emulator needs a JDK; homebrew's keg-only openjdk is added to PATH if present.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -d /opt/homebrew/opt/openjdk/bin ] && export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" # see deploy_mind_page.sh
[ -f __sapper__/build/server/server.js ] || { echo "missing production build; run: npx sapper build" >&2; exit 1; }
firebase emulators:exec --only auth,firestore "node tests/e2e/seed.mjs && npx playwright test $*"
