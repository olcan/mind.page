import { defineConfig } from '@playwright/test'

// unit tests alone, with no web server or emulators: the fast loop (`npm run test:unit`); the
// full config (playwright.config.ts) also runs these as its `unit` project inside the e2e stack
export default defineConfig({
  testDir: 'tests/unit',
  // WITH fullyParallel a focused run of one large file uses all four workers (round 39: the
  // hidden-persistence file alone drops ~40%); these tests share no state. the full e2e config
  // keeps its serialized lanes unchanged
  fullyParallel: true,
  // these tests finish in milliseconds; a deadlock (e.g. a mutation that strands a tail) should
  // fail in seconds, not wait out playwright's 30s default (round 45). the browser config's
  // timeouts are unchanged
  timeout: 5_000,
  // a FIXED small cap, not undefined: these tests share no state, so four workers cut the fast
  // loop ~25-30% (round 37). above four the returns diminish and oversubscription risk grows
  // (round 40 measured a further 6-14% at eight on a 32-thread host, plateauing beyond), so the
  // portable cap stays. the full e2e config keeps its serialized `unit` project unchanged
  workers: 4,
  reporter: [['list']],
})
