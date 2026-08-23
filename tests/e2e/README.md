# e2e tests

Browser tests that run the production build against local Firebase emulators, never prod.

## Setup (once)

- JDK 11+ for the Firestore emulator, e.g. `brew install openjdk` (keg-only; `run.sh` adds it to `PATH`).
- `npm install` (installs `@playwright/test` and `@firebase/rules-unit-testing`), then
  `npx playwright install chromium`.

## Running

```sh
npx sapper build     # production build served by the tests (stop `sapper dev` first, see below)
npm run test:e2e     # = tests/e2e/run.sh: emulators + seed + node __sapper__/build + playwright
npm run test:e2e:update   # re-create snapshots after an intentional rendering change
npx playwright show-report   # inspect failures (html report, traces retained on failure)
npm run test:e2e:serve       # serve the seeded stack interactively, see below
```

To see items rendered: `npm run test:e2e:serve` brings up the emulators, seeds them, and serves the
production build until Ctrl-C; open <http://localhost:3100/> in a browser to browse the
seeded anonymous account, or in another terminal run `npx playwright test --ui` (step through the
tests with a live browser view) or `npx playwright test --headed`; both reuse the running server.

`run.sh` runs everything under `firebase emulators:exec --only auth,firestore`, so the emulators
start fresh and shut down after the run. Do not run `sapper build` while `sapper dev` is running:
both regenerate `src/node_modules/@sapper`, and a dev rebuild mid-build can leave the production
bundle pointing at `__sapper__/dev`.

## How it works

- `seed.mjs` writes `fixtures/anonymous_items.json` (the anonymous account, copied from the vault's
  `external/mindbox.io/items.json` as fetched by `fetch_mind_page.py`) into the Firestore emulator.
- The app connects to the emulators whenever it is served on localhost port 3100 (`client.ts`),
  the port dedicated to this stack: a separate origin from `sapper dev` on 3000, so storage, the
  Firestore cache and sign-in state never mix, and no flag is needed.
- `playwright.config.ts` serves `node __sapper__/build` on port 3100 with `NO_HTTPS=1` (no 443
  listener, so the tests can run while `sapper dev` is up, given a production build) and with
  `FIREBASE_CONFIG` removed
  from the environment (set by `emulators:exec`, it would make `server.ts` skip listening).

## Tests

Tests run as two projects (see `playwright.config.ts`): `chromium` (read-only) first, then `admin`,
which writes to the seeded account. Use `--project admin --no-deps` to iterate on the admin tests.

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

Each item's golden is reviewed like any diff: if a change is intended, run `test:e2e:update` and
commit the updated snapshot files.
