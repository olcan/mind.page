#!/usr/bin/env bash
# Serves the e2e stack interactively: firebase emulators seeded with the anonymous items plus the
# production build on http://localhost:3100 (its own origin, so storage, cache and sign-in state
# stay apart from sapper dev on 3000; requires a prior `sapper build`), until Ctrl-C.
# Open http://localhost:3100/ to browse the seeded account, or run playwright against it
# with `npx playwright test --ui` (or --headed) in another terminal; the tests reuse the server.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -d /opt/homebrew/opt/openjdk/bin ] && export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" # see deploy_mind_page.sh
[ -f build/handler.js ] || { echo "missing production build; run: npm run build" >&2; exit 1; }
# the seeder keeps watching fixtures/markdown/*.md and re-seeds on save, so edits appear live at
# http://localhost:3100/?shared=markdown_e2e/markdown (the app applies them as remote updates)
firebase emulators:exec --only auth,firestore \
    'node tests/e2e/seed.mjs --watch & SEED=$!; sleep 2 && echo "serving seeded accounts at http://localhost:3100/ (markdown corpus at /?shared=markdown_e2e/markdown; Ctrl-C to stop)" && env -u FIREBASE_CONFIG NO_HTTPS=1 PORT=3100 NODE_ENV=production node server.mjs; kill $SEED 2>/dev/null'
