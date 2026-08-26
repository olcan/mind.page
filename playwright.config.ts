import { defineConfig, devices } from '@playwright/test'

// e2e tests run against local firebase emulators (see tests/e2e/run.sh) and the production build
// served by `node server.mjs`. lanes that share mutable state are serialized by dependency and by
// a one-worker cap per project; independent lanes overlap (see the projects below)
const WRITE_SPECS = /(admin|editor|personal)\.spec\.ts/

export default defineConfig({
  testDir: 'tests',
  // two workers TOTAL, with every project capped to one of its own (testProject.workers). the
  // lanes below are what may overlap; nothing inside a lane ever does. an earlier round claimed
  // playwright had no per-project cap — it does, and that claim was simply wrong
  workers: 2,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // platform-independent snapshot paths (text snapshots only, see tests/e2e/render.spec.ts)
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFileName}/{arg}{ext}',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3100', // the emulator port: own origin, and client.ts keys on it
    trace: 'retain-on-failure',
  },
  // `unit` (no browser or app instance), `chromium` (read-only) and `personal` are all eligible
  // immediately; with two workers, unit runs beside chromium and personal takes the worker unit
  // releases. `admin` and `editor` mutate the shared anonymous account, so they are an explicit
  // chain behind the read lane. each project is capped to one worker of its own, so nothing inside
  // a lane overlaps — the read lane in particular stays serial, since its server tests mutate
  // anonymous/prerender data the render tests inspect
  projects: [
    { name: 'unit', testDir: 'tests/unit', workers: 1 }, // capped like the rest: the comment above says every project is
    {
      name: 'chromium',
      testDir: 'tests/e2e',
      testIgnore: WRITE_SPECS,
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'admin',
      testDir: 'tests/e2e',
      testMatch: /admin\.spec\.ts/,
      dependencies: ['chromium'],
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'editor',
      testDir: 'tests/e2e',
      testMatch: /editor\.spec\.ts/,
      dependencies: ['admin'], // ORDERING: both mutate the shared anonymous account
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'personal',
      testDir: 'tests/e2e',
      testMatch: /personal\.spec\.ts/,
      // NO dependency: it does not mutate any fixture the read lane inspects (see the fixture
      // boundary note in tests/e2e/seed.mjs). it starts as soon as a worker frees up
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // note FIREBASE_CONFIG (set by firebase emulators:exec) must be removed, since server.ts takes it
    // to mean running on cloud functions and then does not listen
    // CONTENT_CACHE_MS pins the crawler-content ttl (see $lib/server/content.js). the production
    // default is 60s, so the frozen-render test polled through a cache whose age depended on what
    // ran before it: 9.6s in one run, but up to ~60s if earlier tests get faster or reorder
    command: 'env -u FIREBASE_CONFIG NO_HTTPS=1 PORT=3100 CONTENT_CACHE_MS=100 NODE_ENV=production node server.mjs',
    url: 'http://localhost:3100/server_id',
    // never reuse: a server started against an older build would serve it to the whole run,
    // which is how a stale bundle passed a round of client-side changes (see tests/e2e/run.sh)
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
