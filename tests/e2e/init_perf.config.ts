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
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    // DIRECT browser requests are OFFLINE by default (see the spec header, "how this harness differs
    // from production", item 5): every host fails to resolve except loopback (the rule applies to ip
    // literals too: the emulators live at 127.0.0.1) and the hosts app.html loads its libraries and
    // fonts from — a resolver rule, so the http cache is untouched (playwright routing would disable
    // it). the served server's local proxy (/proxy/<backend>/…, server.mjs) resolves on its own and
    // is NOT covered. PERF_ONLINE=1 lifts the browser rule: real direct requests with the credentials
    // the corpus carries
    launchOptions: {
      args:
        process.env.PERF_ONLINE == '1'
          ? []
          : [
              '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1, EXCLUDE cdn.jsdelivr.net, EXCLUDE cdnjs.cloudflare.com, EXCLUDE unpkg.com, EXCLUDE fonts.googleapis.com, EXCLUDE fonts.gstatic.com',
            ],
    },
  },
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
