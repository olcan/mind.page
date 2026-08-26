# e2e tests

Browser tests that run the production build against local Firebase emulators, never prod.

## Setup (once)

- JDK 11+ for the Firestore emulator, e.g. `brew install openjdk` (keg-only; `run.sh` adds it to `PATH`).
- `npm install` (installs `@playwright/test` and `@firebase/rules-unit-testing`), then
  `npx playwright install chromium`.

## Running

```sh
npm run build        # production build served by the tests (vite build)
npm run test:e2e     # = tests/e2e/run.sh: build + emulators + seed + node server.mjs + playwright
npm run test:e2e:update   # re-create snapshots after an intentional rendering change
npx playwright show-report   # inspect failures (html report, traces retained on failure)
npm run test:e2e:serve       # serve the seeded stack interactively, see below
```

To see items rendered: `npm run test:e2e:serve` brings up the emulators, seeds them, and serves the
production build until Ctrl-C; open <http://localhost:3100/> in a browser to browse the seeded
anonymous account. That server is for LOOKING, not for running the suite against: the tests do not
reuse it (`reuseExistingServer: false`, after a stale bundle once passed a whole round), and a
second shell is outside the emulator environment anyway. To iterate, use `run.sh` with the build
skipped: `SKIP_BUILD=1 tests/e2e/run.sh tests/e2e/personal.spec.ts --no-deps` — non-authoritative,
since it serves whatever `build/` already holds.

`run.sh` runs everything under `firebase emulators:exec --only auth,firestore`, so the emulators
start fresh and shut down after the run. The production build (`build/`, served by `server.mjs`)
and the dev server (`npm run dev`) are independent and can run concurrently.

## How it works

- `seed.mjs` writes `fixtures/anonymous_items.json` (the anonymous account, copied from the vault's
  `external/mindbox.io/items.json` as fetched by `fetch_mind_page.py`) into the Firestore emulator.
- The app connects to the emulators whenever it is served on localhost port 3100 (`client.ts`),
  the port dedicated to this stack: a separate origin from the dev server, so storage, the
  Firestore cache and sign-in state never mix, and no flag is needed.
- `playwright.config.ts` serves `node server.mjs` on port 3100 with `NO_HTTPS=1` (no 443 listener,
  so the tests can run while `npm run dev` is up, given a production build), `CONTENT_CACHE_MS=100`
  (the production 60s crawler-content ttl would otherwise make one test poll through a cache whose
  age depends on what ran before it) and with `FIREBASE_CONFIG` removed from the environment (set
  by `emulators:exec`, it would make the server skip listening).

## Tests

Tests run as five projects (see `playwright.config.ts`), each capped to one worker with two
workers overall: `unit` (no browser), `chromium` (read-only), then the write lanes, which change
the seeded accounts. `admin` installs items that `editor` then edits, so `editor` depends on
`admin`; `personal` touches only its own account and runs BESIDE that chain. Add `--no-deps` to
iterate on one spec without dragging its dependency closure along (naming `editor.spec.ts` selects
55 tests otherwise, rather than its own 10).

- `server.spec.ts` - `server.mjs` over http (no browser): the ssr shell and the session fields it
  embeds (`client_ip` honors the proxy-forwarded address), the numbered pwa scopes and their
  manifests, host-dependent icons and titles, `/server_id`, `/user/<uid>`, the webhook endpoints
  (stored documents checked through firebase-admin), the cors proxy against a local backend, and the
  localhost-only dev routes. The server-side item preload is disabled in `server.ts` and items were
  never rendered server-side, so the ssr contract is the shell plus these fields; two `fixme` cases
  pin the crawlability target (public and shared pages readable without javascript).
- `rules.spec.ts` - `firestore.rules` via `@firebase/rules-unit-testing` (no browser): anonymous and
  shared reads, owner-only writes, admin writes to anonymous items, blocked users. These run against
  their own emulator project (`rules-test`) so their documents stay invisible to the app.
- `render.spec.ts` - loads the anonymous account as a read-only visitor (120 of 121 items; the
  welcome template is dropped from read-only views) and renders every item through the app's
  `_render_item`, comparing normalized html against `__snapshots__/render.spec.ts/<id>.html`.
  Normalization drops volatile attributes (MathJax ids and counters, element cache timestamps, c3
  clip-path ids, empty styles) and puts one tag per line for readable diffs; `DYNAMIC_ITEMS` lists
  items that are only checked to render (e.g. the live clock widget). Capture waits for each item's
  html to settle, since charts draw after the render promise resolves.

- `admin.spec.ts` - signs in with a custom token as the admin uid (`helpers.ts`; the user record
  needs a display name or the app's sign-in handler throws before entering admin mode) and loads
  `?user=anonymous`, which puts the app in the admin-acting-as-anonymous mode it uses on mindbox.io:
  write access to the anonymous account, no encryption. It then installs the `mind.items` items that
  define `_test_*` functions, runs `/test` and asserts every test passed, and checks that an item
  created by the admin syncs to a read-only visitor in a second browser context, and likewise its
  deletion.
- `editor.spec.ts` - the editor driven like a user, as admin on the anonymous account: typing in the
  mindbox and creating with shift+enter, search (debounced, ranked after the pinned items, the tag
  in the url hash), escape and shift+backspace, clicking a tag and going back, editing an item in
  place (click, shift+enter to save, escape with a discard prompt), and `/_undelete`. The mindbox
  textarea is hidden behind a backdrop until focused, so tests click the backdrop.
- `personal.spec.ts` - a regular account (`alice_e2e`): the first sign-in copies the welcome item
  and prompts for a new secret phrase, items are then stored as `cipher` with `text` and `attr`
  nulled, reloading decrypts silently, a new device is prompted for the phrase and a wrong one can
  only sign out, shared items are stored in the clear and visible by key to anonymous visitors (with
  the sharer named in the header), unsharing re-encrypts, and signing out clears the secret, the
  session and the local cache. `secretFor` in `helpers.ts` reproduces the stored secret (sha-256 of
  uid + phrase) so later tests can skip the prompts.

Notes on driving the app from tests:

- Commands run via `_create(text, { command: true, return_alerts: true })`, which returns the
  command's promise (an alert message on failure). Root `/_install` and `/test` end with modals
  ("Installed #x [OK]", then "recommends reloading ... [Reload] [Skip]" for new init/welcome items;
  "Completed N tests ...") and resolve once those are dismissed, so tests click through them.
- Items exist client-side before their Firestore saves complete. Users are protected by the
  "Discard unsaved changes?" prompt, which headless navigation bypasses, so tests wait for every
  item's `savedId` before loading the account again.
- `/_install` prompts for a GitHub token unless one is stored, and installs are served from the local
  `../mind.items` checkout by `interceptMindItems` (set `MIND_ITEMS_DIR` to override), so tests can
  cover uncommitted item changes and never hit rate limits.
- `_Item.delete()` confirms via `window.confirm`, which headless browsers auto-dismiss; pass `false`.
- `signIn` in `helpers.ts` marks the sign-in as pending (`mindpage_signin_pending`, the
  `__session=signin_pending` cookie) like the app's own `signIn()`, so that the reload after the
  auth change does not start as an anonymous visitor, whose welcome prompt would stay open and
  queue every later modal behind it.

- `markdown.spec.ts` - the markdown rendering conformance corpus: `fixtures/markdown/*.md` (one
  item per file, first `#label` in the file is the item label; source of truth in this repo) is
  seeded as items shared by `markdown_e2e` and rendered on `/?shared=markdown_e2e/markdown` as a
  signed-out visitor, each compared to `__snapshots__/markdown.spec.ts/<slug>.html`. To view and
  edit the corpus, run `npm run test:e2e:serve` and open that url: saving a fixture file re-seeds
  it and the app applies it live. Add a case by adding a file.

Each item's golden is reviewed like any diff: if a change is intended, run `test:e2e:update` and
commit the updated snapshot files.
