import { defineConfig, devices } from '@playwright/test'
import { E2E_LANES, lanePort } from './src/e2e_lanes.js'

// a browser lane: the e2e test dir, one worker, Desktop Chrome, the lane's own baseURL
const lane = (name: string, extra: object) => ({
  name,
  testDir: 'tests/e2e',
  workers: 1,
  use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${lanePort(name)}` },
  ...extra,
})

// e2e tests run against local firebase emulators (see tests/e2e/run.sh) and the production build
// served by `node server.mjs`, one server per LANE (src/e2e_lanes.js): every browser project is a
// lane with its own port and its own project id on the shared emulators, so the lanes overlap
// freely and only the rows inside a lane are serial (a one-worker cap per project)
const WRITE_SPECS = /(admin|admin_live|editor|editor2|personal|bridge|store_propagation|vault_renderer|renderer_contract)\.spec\.ts/

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
  ],
  // one server per lane, started by playwright (see the lane note above). FIREBASE_CONFIG (set by
  // firebase emulators:exec) must be removed, since server.ts takes it to mean running on cloud
  // functions and then does not listen. CONTENT_CACHE_MS pins the crawler-content ttl (see
  // $lib/server/content.js). the production default is 60s, so the frozen-render test polled
  // through a cache whose age depended on what ran before it: 9.6s in one run, but up to ~60s if
  // earlier tests get faster or reorder. never reuse: a server started against an older build
  // would serve it to the whole run, which is how a stale bundle passed a round of client-side
  // changes (see tests/e2e/run.sh)
  webServer: E2E_LANES.map(name => ({
    command: `env -u FIREBASE_CONFIG NO_HTTPS=1 PORT=${lanePort(name)} CONTENT_CACHE_MS=100 NODE_ENV=production node server.mjs`,
    url: `http://localhost:${lanePort(name)}/server_id`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  })),
})
