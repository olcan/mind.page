import { expect, test } from '@playwright/test'
import { waitForApp } from './helpers.js'
import { normalize, renderedHtml } from './rendering.js'
import { readdirSync } from 'fs'
import { resolve, basename } from 'path'
import { fileURLToPath } from 'url'

// markdown rendering conformance corpus: fixtures/markdown/*.md (one item per file, source of
// truth in this repo) are seeded as items shared by markdown_e2e (see seed.mjs) and rendered on
// the shared page as a signed-out visitor; goldens live in __snapshots__/markdown.spec.ts/. To
// view and edit the corpus locally, run `npm run test:e2e:serve` and open
// /?shared=markdown_e2e/markdown: saving a fixture file re-seeds it and the app updates live.
const FIXTURES = readdirSync(resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/markdown'))
  .filter(file => file.endsWith('.md'))
  .map(file => basename(file, '.md'))
  .sort()

test('the markdown corpus renders as before', async ({ page }, testInfo) => {
  // this test took 3.7s in a healthy run and once timed out at the 120s default, whose trace was
  // then overwritten by later runs — so its cause could not be established. a FOCUSED timeout
  // fails it fast and near the step that hung, and the diagnostics below are attached to the
  // report either way. deliberately NOT a retry and NOT a longer timeout: both hide the fault
  test.setTimeout(45_000)
  const diagnostics: string[] = []
  page.on('pageerror', error => diagnostics.push(`pageerror ${error}`))
  // only OUR OWN server's failures: the external aborts below are deliberate and expected
  page.on('requestfailed', request => {
    if (/localhost|127\.0\.0\.1/.test(request.url()))
      diagnostics.push(`requestfailed ${request.url()} ${request.failure()?.errorText ?? ''}`)
  })
  // external content references (e.g. images) stay deterministic offline; scripts and styles from
  // the app shell (mathjax, c3, ... from cdns, see app.html) are still allowed
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, route =>
    ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()
  )
  await test.step('open the shared page', async () => {
    await page.goto('/?shared=markdown_e2e/markdown')
    await page.getByText('View Shared Page', { exact: true }).click({ timeout: 30_000 })
  })
  await test.step('the app becomes ready', () => waitForApp(page))
  expect(await page.evaluate(() => window.__items[0].id)).toBe('md-markdown') // the root item heads the page
  await expect(page.locator('mark.label[title="#markdown/extended"]')).toBeVisible() // labels shown (shared.labels)
  await expect(page.locator('mark.label[title="#markdown"]')).toBeHidden() // except the root item, whose label heads the page
  // items follow the tag order in the root item's text
  expect(await page.evaluate(() => window.__items.slice(0, 3).map(item => item.id))).toEqual([
    'md-markdown',
    'md-markdown-headings',
    'md-markdown-paragraphs',
  ])
  // ##fragment links scroll to the heading without navigating (no history entry, url unchanged)
  const scrollY = () => page.evaluate(() => Math.round(window.scrollY + document.body.scrollTop))
  const before = await scrollY()
  await page.locator('#item-md-markdown-extended a[href="#heading-2"]').click()
  await expect.poll(scrollY).not.toBe(before)
  expect(await page.evaluate(() => location.hash)).toBe('')
  const ids = await page.evaluate(() =>
    window
      ._items()
      .map(item => item.id)
      .sort()
  )
  expect(ids).toEqual(FIXTURES.map(slug => `md-${slug}`).sort()) // seeded ids are md-<file slug>
  // focusing an item (e.g. clicking its label) shows it alone; navigating to the root item is the
  // main page again, not a lone-item view (there is no mindbox on shared pages, so navigate by hash)
  await page.evaluate(() => void (location.hash = '#markdown/extended'))
  await expect.poll(() => page.evaluate(() => window.__hideIndex), { timeout: 10_000 }).toBe(1)
  // only the focused item's first heading is hidden (the header shows it as the page title);
  // further headings render, including the first of other levels (:first-of-type would hide them)
  await page.evaluate(() => void (location.hash = '#markdown/headings'))
  await expect.poll(() => page.evaluate(() => window.__hideIndex), { timeout: 10_000 }).toBe(1)
  await expect(page.locator('#item-md-markdown-headings h1')).toBeHidden()
  for (const h of ['h2', 'h3', 'h4', 'h5', 'h6'])
    await expect(page.locator(`#item-md-markdown-headings ${h}`)).toBeVisible()
  await page.evaluate(() => void (location.hash = '#markdown'))
  await expect.poll(() => page.evaluate(() => window.__hideIndex), { timeout: 10_000 }).toBe(FIXTURES.length)
  for (const slug of FIXTURES)
    await test.step(`render ${slug}`, async () => {
      const html = await renderedHtml(page, `md-${slug}`)
      expect.soft(html, slug).not.toBeNull()
      if (html != null) expect.soft(normalize(html), slug).toMatchSnapshot(`${slug}.html`)
    })
  // attached unconditionally: when this test next hangs, the report carries what the page saw
  await testInfo.attach('page diagnostics', {
    body: diagnostics.join('\n') || '(no page errors or local request failures)',
    contentType: 'text/plain',
  })
})
