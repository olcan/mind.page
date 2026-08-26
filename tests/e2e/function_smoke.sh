#!/usr/bin/env bash
# Serves the app through the REAL cloud function in the functions emulator (hosting rewrites / to
# the ssr function) and asserts the page and express routes respond: the e2e suite serves via
# server.mjs and never loads the function entry (lib/firebase/functions.js), so module discovery,
# the lazy esm imports and handler mounting are only checked here (and by a deploy).
# Requires a production build (`npm run build`) and the compiled function (`make firebase`).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -d /opt/homebrew/opt/openjdk/bin ] && export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" # see deploy_mind_page.sh
[ -f build/handler.js ] || { echo "missing production build; run: npm run build" >&2; exit 1; }
make firebase # ensure the function is compiled from the current source

firebase emulators:exec --only auth,firestore,functions,hosting '
  set -e
  node tests/e2e/seed.mjs > /dev/null
  page=$(curl -s http://127.0.0.1:5050/)
  echo "$page" | grep -q "id=\"sapper\"" || { echo "FAIL: app shell missing"; exit 1; }
  echo "$page" | grep -q "class=\"ssr-content\"" || { echo "FAIL: crawler content missing"; exit 1; }
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5050/manifest.json)
  [ "$code" = 200 ] || { echo "FAIL: manifest -> $code"; exit 1; }
  # a seeded uid exercises handler mounting, the async firestore read and display-name precedence
  # (mindpageDisplayName over displayName, see seed.mjs); status and exact body are both required
  code=$(curl -s -o /tmp/fn_smoke_user -w "%{http_code}" http://127.0.0.1:5050/user/alice_e2e)
  [ "$code" = 200 ] || { echo "FAIL: /user/alice_e2e -> $code"; exit 1; }
  [ "$(cat /tmp/fn_smoke_user)" = "Alice (custom)" ] || { echo "FAIL: /user/alice_e2e body -> $(cat /tmp/fn_smoke_user)"; exit 1; }
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5050/user/nonexistent-uid)
  case "$code" in 4??) ;; *) echo "FAIL: /user (invalid uid) -> $code (expected a client error)"; exit 1;; esac
  # the cloud stack must expose no arbitrary-target proxy at all (see proxy_canary.mjs)
  node tests/e2e/proxy_canary.mjs 5050
  echo "function smoke passed: page, crawler content, manifest, /user, and no cloud proxy"
'
