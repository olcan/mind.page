import { defineConfig, devices } from '@playwright/test'

// e2e tests run against local firebase emulators (see tests/e2e/run.sh) and the production build
// served by node __sapper__/build; tests share one app instance and one emulator dataset, so they
// run serially
const WRITE_SPECS = /(admin|editor|personal)\.spec\.ts/

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
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
  // read-only tests (server, rules, rendering goldens) run first; write tests (admin installs, the
  // editor, a personal account) change the seeded accounts and run after them
  projects: [
    { name: 'chromium', testIgnore: WRITE_SPECS, use: { ...devices['Desktop Chrome'] } },
    { name: 'write', testMatch: WRITE_SPECS, dependencies: ['chromium'], use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // note FIREBASE_CONFIG (set by firebase emulators:exec) must be removed, since server.ts takes it
    // to mean running on cloud functions and then does not listen
    command: 'env -u FIREBASE_CONFIG NO_HTTPS=1 PORT=3100 NODE_ENV=production node server.mjs',
    url: 'http://localhost:3100/server_id',
    reuseExistingServer: true,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
