import { defineConfig, devices } from '@playwright/test'

// e2e tests run against local firebase emulators (see tests/e2e/run.sh) and the production build
// served by node __sapper__/build; tests share one app instance and one emulator dataset, so they
// run serially
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
  // unit tests (tests/unit) run in the playwright node process, no browser or app instance; then
  // read-only tests (server, rules, rendering goldens); then the write lanes, which change the
  // seeded accounts.
  // the write lanes are SPLIT by what they actually share: admin installs items that the editor
  // then edits, so that stays an explicit dependency chain, while `personal` touches only its own
  // account (alice_e2e) and runs BESIDE it. each lane is capped to one worker of its own, so the
  // read lane stays serial (server tests mutate anonymous/prerender data the render tests inspect)
  projects: [
    { name: 'unit', testDir: 'tests/unit' },
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
      dependencies: ['admin'], // the editor acts on what admin installed
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'personal',
      testDir: 'tests/e2e',
      testMatch: /personal\.spec\.ts/,
      dependencies: ['chromium'], // independent of the admin/editor chain
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
