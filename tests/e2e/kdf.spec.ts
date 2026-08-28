import { expect, test } from '@playwright/test'

// the KDF WORKER smoke (see the design's Stage 1B): proves that Vite bundles src/kdf_worker.ts,
// the hash-wasm WASM loads inside it in a REAL browser, and the page-side deriver round-trips —
// none of which a Node unit test can show. It runs the CHEAP test parameters (this is a bundling
// smoke, not the resolver; the production resolver maps versions only through the code-owned
// table). The production-cost fleet benchmark is DONE and documented in the design, and its
// temporary hook is gone; wall-clock is never a correctness assertion (reviews 79/80/84).

test('the kdf worker bundles, loads its wasm, and derives in a real browser', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(() => (window as any).__kdfSmoke())
  expect(result.length, 'a 32-byte key came back through the worker').toBe(32)
  // the SAME input as the Node known-answer row, compared in FULL: "matches the Node vector" is a
  // literal statement (password 'test phrase', salt 16x0x07, t=1, 8 MiB — see KAT in
  // tests/unit/kdf.spec.ts)
  expect(result.hex).toBe('e18399378b0a69373a4802509400ba9b281fa706bc645d79a7ed0fe338aedca2')
})
