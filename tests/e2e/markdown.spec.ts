import { expect, test } from '@playwright/test'
import { waitForApp } from './helpers'
import { normalize, renderedHtml } from './rendering'
import { readdirSync } from 'fs'
import { resolve, basename } from 'path'

// markdown rendering conformance corpus: fixtures/markdown/*.md (one item per file, source of
// truth in this repo) are seeded as items shared by markdown_e2e (see seed.mjs) and rendered on
// the shared page as a signed-out visitor; goldens live in __snapshots__/markdown.spec.ts/. To
// view and edit the corpus locally, run `npm run test:e2e:serve` and open
// /?shared=markdown_e2e/markdown: saving a fixture file re-seeds it and the app updates live.
const FIXTURES = readdirSync(resolve(__dirname, 'fixtures/markdown'))
  .filter(file => file.endsWith('.md'))
  .map(file => basename(file, '.md'))
  .sort()

test('the markdown corpus renders as before', async ({ page }) => {
  // external content references (e.g. images) stay deterministic offline; scripts and styles from
  // the app shell (mathjax, c3, ... from cdns, see app.html) are still allowed
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, route =>
    ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()
  )
  await page.goto('/?shared=markdown_e2e/markdown')
  await page.getByText('View Shared Page', { exact: true }).click({ timeout: 60_000 })
  await waitForApp(page)
  expect(await page.evaluate(() => window.__items[0].id)).toBe('md-markdown') // the root item heads the page
  await expect(page.locator('mark.label[title="#markdown/extended"]')).toBeVisible() // labels shown (shared.labels)
  const ids = await page.evaluate(() =>
    window
      ._items()
      .map(item => item.id)
      .sort()
  )
  expect(ids).toEqual(FIXTURES.map(slug => `md-${slug}`).sort()) // seeded ids are md-<file slug>
  for (const slug of FIXTURES) {
    const html = await renderedHtml(page, `md-${slug}`)
    expect.soft(html, slug).not.toBeNull()
    if (html != null) expect.soft(normalize(html), slug).toMatchSnapshot(`${slug}.html`)
  }
})
