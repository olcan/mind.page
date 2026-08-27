import { expect, test } from '@playwright/test'

// the KDF WORKER smoke (see the design's Stage 1B): proves that Vite bundles src/kdf_worker.ts,
// the hash-wasm WASM loads inside it in a REAL browser, and the page-side deriver round-trips —
// none of which a Node unit test can show. It runs the CHEAP test parameters (this is a bundling
// smoke, not the resolver; the production resolver maps versions only through the code-owned
// table). The production-cost benchmark stays behind __kdfBenchmark as a manual, reported-only
// run — wall-clock is never a correctness assertion (review 79/80).

test('the kdf worker bundles, loads its wasm, and derives in a real browser', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(() => (window as any).__kdfSmoke())
  expect(result.length, 'a 32-byte key came back through the worker').toBe(32)
  // the same input through the same pinned dependency: the head must match the Node-side vector
  // for these parameters (password 'smoke', salt 16x0x07, t=1, 8 MiB)
  expect(result.head).toEqual([76, 8, 39, 46])
})
