#!/usr/bin/env bash
# Serves the e2e stack interactively: firebase emulators seeded with the anonymous items plus the
# production build on http://localhost:3100 (its own origin, so storage, cache and sign-in state
# stay apart from sapper dev on 3000; requires a prior `sapper build`), until Ctrl-C.
# Open http://localhost:3100/ to browse the seeded account, or run playwright against it
# NOTE this server is for LOOKING at the seeded accounts, not for running the suite against. The
# tests do NOT reuse it: playwright.config.ts sets reuseExistingServer:false (a stale bundle once
# passed a whole round that way), and a second shell is outside this emulator environment anyway.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -d /opt/homebrew/opt/openjdk/bin ] && export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" # see deploy_mind_page.sh
[ -f build/handler.js ] || { echo "missing production build; run: npm run build" >&2; exit 1; }
# the seeder keeps watching fixtures/markdown/*.md and re-seeds on save, so edits appear live at
# http://localhost:3100/?shared=markdown_e2e/markdown (the app applies them as remote updates)
# seeding completes before the server starts (a visit during seeding would find an empty account);
# the watcher then re-seeds (idempotently, once more at startup) as fixture files change
firebase emulators:exec --only auth,firestore \
    'node tests/e2e/seed.mjs && { node tests/e2e/seed.mjs --watch > /dev/null 2>&1 & SEED=$!; } && echo "serving seeded accounts (Ctrl-C to stop):" && echo "  http://localhost:3100/" && echo "  http://localhost:3100/?shared=markdown_e2e/markdown  (markdown corpus)" && env -u FIREBASE_CONFIG NO_HTTPS=1 PORT=3100 NODE_ENV=production CONTENT_CACHE_MS=3000 node server.mjs; kill $SEED 2>/dev/null'
