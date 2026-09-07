import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// the init-perf harness config (see init_perf.perf.ts; the .perf.ts name keeps it out of the gate's projects): one browser, no retries, the production
// server under the emulators exactly as the gate starts it (see playwright.config.ts)
export default defineConfig({
  testDir: '.',
  testMatch: /init_perf\.perf\.ts/,
  timeout: 45 * 60_000,
  workers: 1,
  retries: 0,
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://localhost:3100', trace: 'off', screenshot: 'off', video: 'off' },
  webServer: {
    command: 'env -u FIREBASE_CONFIG NO_HTTPS=1 PORT=3100 CONTENT_CACHE_MS=100 NODE_ENV=production node server.mjs',
    cwd: root,
    url: 'http://localhost:3100/server_id',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
