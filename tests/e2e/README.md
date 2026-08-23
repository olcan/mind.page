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

- `rules.spec.ts` - `firestore.rules` via `@firebase/rules-unit-testing` (no browser): anonymous and
  shared reads, owner-only writes, admin writes to anonymous items, blocked users.
- `render.spec.ts` - loads the anonymous account as a read-only visitor (120 of 121 items; the
  welcome template is dropped from read-only views) and renders every item through the app's
  `_render_item`, comparing normalized html against `__snapshots__/render.spec.ts/<id>.html`.
  Normalization drops volatile attributes (MathJax ids and counters, element cache timestamps, c3
  clip-path ids, empty styles) and puts one tag per line for readable diffs; `DYNAMIC_ITEMS` lists
  items that are only checked to render (e.g. the live clock widget). Capture waits for each item's
  html to settle, since charts draw after the render promise resolves.

Each item's golden is reviewed like any diff: if a change is intended, run `test:e2e:update` and
commit the updated snapshot files.
