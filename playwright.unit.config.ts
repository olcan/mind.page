import { defineConfig } from '@playwright/test'

// unit tests alone, with no web server or emulators: the fast loop (`npm run test:unit`); the
// full config (playwright.config.ts) also runs these as its `unit` project inside the e2e stack
export default defineConfig({
  testDir: 'tests/unit',
  // a FIXED small cap, not undefined: these tests share no state, so four workers cut the fast
  // loop ~25-30% (round 37), while unbounded workers would let a large machine oversubscribe for
  // no gain at this suite size. the full e2e config keeps its serialized `unit` project unchanged
  workers: 4,
  reporter: [['list']],
})
