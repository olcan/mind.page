import { defineConfig } from '@playwright/test'

// unit tests alone, with no web server or emulators: the fast loop (`npm run test:unit`); the
// full config (playwright.config.ts) also runs these as its `unit` project inside the e2e stack
export default defineConfig({
  testDir: 'tests/unit',
  workers: 1,
  reporter: [['list']],
})
