import { defineConfig, devices } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { E2E_LANES, OFFLINE_BROWSER_ARGS, lanePort } from './src/e2e_lanes.js'
import { loadProxySecret } from './src/server/proxy_secret.mjs'

// the lane servers run under a THROWAWAY home (vault design mind_task_agents 9.9): the local
// proxy's per-host secret they create there is the run's own, never the owner's, so the tests
// may send it and a retained failure trace may hold it. that credential lives where a worker
// can read it (the system temp directory), so the lane servers run SCOPED (LOCAL_ROUTES_SCOPE:
// the file and static routes serve this checkout and the sibling mind.items checkout only, the
// proxy forwards to loopback backends only); the tests find the secret through E2E_HOME, and the
// global teardown removes the directory after the run
// created ONCE per run, by the runner process; the worker processes evaluate this config again
// and inherit the runner's E2E_HOME (and E2E_HOME_OWNED, set only by the creator, so the
// teardown removes exactly the directory this run created and never a supplied one)
const E2E_HOME = process.env.E2E_HOME ?? mkdtempSync(join(tmpdir(), 'mindpage-e2e-home-'))
if (!process.env.E2E_HOME) process.env.E2E_HOME_OWNED = E2E_HOME
process.env.E2E_HOME = E2E_HOME
const REPO = dirname(fileURLToPath(import.meta.url))
// the sibling mind.items checkout: the gate's install and preview seam (tests/e2e/helpers.ts,
// MIND_ITEMS_DIR), the second root of the lane servers' scope (the app fetches its previews of
// installed items through /file/mind.items/...)
const MIND_ITEMS = resolve(process.env.MIND_ITEMS_DIR ?? join(REPO, '../mind.items'))
// the lane secret: created under the throwaway home now (the servers find it there; every
// worker process reads the same file) and provisioned to each lane's browser origin through
// the storage state, so the app's own fetches of the file routes and the proxy carry it, as
// the owner's browser does after /_proxy_secret
const laneSecret = (() => {
  const home = process.env.HOME
  process.env.HOME = E2E_HOME
  try {
    return loadProxySecret({ create: true })
  } finally {
    process.env.HOME = home
  }
})()

// a browser lane: the e2e test dir, one worker, Desktop Chrome, the lane's own baseURL
const lane = (name: string, extra: object) => ({
  name,
  testDir: 'tests/e2e',
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${lanePort(name)}`,
    // the gate's browsers reach loopback only (src/e2e_lanes.js OFFLINE_BROWSER_ARGS): every cdn
    // asset comes from the lane server's vendored route (src/server/vendor.mjs) and a remote
    // dependency fails the same way online or not
    launchOptions: { args: OFFLINE_BROWSER_ARGS },
    // the lane's origin carries the run's proxy secret (see laneSecret above); playwright copies
    // this storage state into the contexts a test creates itself too (browser.newContext()),
    // so those carry it as well, signed out of firebase as before
    storageState: {
      cookies: [],
      origins: [{ origin: `http://localhost:${lanePort(name)}`, localStorage: [{ name: 'mindpage_proxy_secret', value: laneSecret }] }],
    },
  },
  ...extra,
})

// e2e tests run against local firebase emulators (see tests/e2e/run.sh) and the production build
// served by `node server.mjs`, one server per LANE (src/e2e_lanes.js): every browser project is a
// lane with its own port and its own project id on the shared emulators, so the lanes overlap
// freely and only the rows inside a lane are serial (a one-worker cap per project)
const WRITE_SPECS =
  /(admin|admin_live|editor|editor2|personal|bridge|store_propagation|vault_renderer|renderer_contract|tasks|lifecycle)\.spec\.ts/

export default defineConfig({
  testDir: 'tests',
  // one worker per lane plus the unit project, every project capped to one of its own
  // (testProject.workers): the lanes overlap, nothing inside a lane ever does
  workers: 1 + E2E_LANES.length, // the unit project plus one worker per lane, all at once
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // platform-independent snapshot paths (text snapshots only, see tests/e2e/render.spec.ts)
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFileName}/{arg}{ext}',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${lanePort('chromium')}`, // the first lane's origin (each lane sets its own)
    trace: 'retain-on-failure',
  },
  projects: [
    // timeout 5s as in the standalone unit config: these tests finish in milliseconds, and a
    // deadlock should fail fast inside the full gate too; browser projects keep the long default
    { name: 'unit', testDir: 'tests/unit', workers: 1, timeout: 5_000 },
    lane('chromium', { testIgnore: WRITE_SPECS }),
    lane('admin', { testMatch: /admin(_live)?\.spec\.ts/ }),
    lane('editor', { testMatch: /editor\.spec\.ts/ }),
    lane('bridge', { testMatch: /bridge\.spec\.ts/ }),
    lane('renderer', { testMatch: /vault_renderer\.spec\.ts/ }),
    lane('propagation', { testMatch: /store_propagation\.spec\.ts/ }),
    lane('personal', { testMatch: /personal\.spec\.ts/ }),
    // the two longest lanes split in two (see tests/e2e/README.md): the editor's self-contained long rows
    // and the admin lane's renderer contract row run beside the rest of their suites
    lane('editor2', { testMatch: /editor2\.spec\.ts/ }),
    lane('contract', { testMatch: /renderer_contract\.spec\.ts/ }),
    lane('tasks', { testMatch: /tasks\.spec\.ts/ }), // the task-agents todoer rows over a dedicated account
    // the page-cache restore rows: they write as admin, reload the page, and one of them kills the
    // page's Firestore client with a real pagehide
    lane('lifecycle', { testMatch: /lifecycle\.spec\.ts/ }),
  ],
  // one server per lane, started by playwright (see the lane note above). FIREBASE_CONFIG (set by
  // firebase emulators:exec) must be removed, since server.ts takes it to mean running on cloud
  // functions and then does not listen. CONTENT_CACHE_MS pins the crawler-content ttl (see
  // $lib/server/content.js). the production default is 60s, so the frozen-render test polled
  // through a cache whose age depended on what ran before it: 9.6s in one run, but up to ~60s if
  // earlier tests get faster or reorder. never reuse: a server started against an older build
  // would serve it to the whole run, which is how a stale bundle passed a round of client-side
  // changes (see tests/e2e/run.sh)
  globalTeardown: './tests/e2e/global_teardown.ts',
  webServer: E2E_LANES.map(name => ({
    command: 'env -u FIREBASE_CONFIG node server.mjs', // FIREBASE_CONFIG: see the note above
    env: {
      HOME: E2E_HOME,
      LOCAL_ROUTES_SCOPE: [REPO, MIND_ITEMS].join(delimiter),
      NO_HTTPS: '1',
      HOST: '127.0.0.1',
      PORT: String(lanePort(name)),
      CONTENT_CACHE_MS: '100',
      NODE_ENV: 'production',
    },
    url: `http://localhost:${lanePort(name)}/server_id`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  })),
})
