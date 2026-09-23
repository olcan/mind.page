import { expect, test, type Page } from '@playwright/test'
import { loadAnonymous, waitForApp } from './helpers.js'

// the PAGE-CACHE RESTORE (see src/page_lifecycle.ts and onPageShow in index.svelte): the browser
// fires pagehide when it parks a page in its back/forward cache (a back navigation; on iOS every
// background tab Safari suspends), the Firestore SDK's own pagehide handler shuts its client down
// there, and nothing restarts it at pageshow — so the app reloads a restored page, or asks first
// when an edit is unsaved. playwright's chromium runs with the back/forward cache disabled, so
// these rows dispatch the restore's own event (a persisted pageshow) on the loaded page: the
// browser's part is the SDK's contract, the app's handler is what they pin

// the restore's event, dispatched in-page; the handler's reload destroys the evaluation context
// mid-call, which is expected
const restore = (page: Page) =>
  page
    .evaluate(() => void window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    .catch(() => {})

// a reload is a new visit: the anonymous choice is asked again (see loadAnonymous)
async function reloaded(page: Page) {
  await page.getByText('Stay Anonymous', { exact: true }).click({ timeout: 60_000 })
  await waitForApp(page)
}

test('a restored page reloads itself, and the reload notes the restore in its init log', async ({ page }) => {
  await loadAnonymous(page)
  const before = await page.evaluate(() => window._init_time)
  const logs: string[] = []
  page.on('console', msg => logs.push(msg.text()))
  const load = page.waitForEvent('load')
  await restore(page)
  await load
  await reloaded(page)
  expect(await page.evaluate(() => window._init_time), 'a new initialization').toBeGreaterThan(before)
  expect(logs.join('\n')).toMatch(/restored from the page cache/)
  expect(logs.join('\n')).toMatch(/reloaded after a page-cache restore/)
})

test('with an unsaved edit the restore asks first, and Reload then reloads', async ({ page }) => {
  await loadAnonymous(page)
  const before = await page.evaluate(() => window._init_time)
  await page.evaluate(() => {
    const item = window.__items[0] as unknown as { text: string }
    item.text += ' (unsaved)'
  })
  await restore(page)
  // the modal's own buttons (the seeded account has an item with a `Reload` link of its own)
  const reload = page.locator('.button.confirm', { hasText: /^Reload$/ })
  await expect(reload).toBeVisible()
  await expect(page.locator('.button.cancel', { hasText: /^Later$/ })).toBeVisible()
  expect(await page.evaluate(() => window._init_time), 'no reload while asking').toBe(before)
  const load = page.waitForEvent('load')
  await reload.click().catch(() => {}) // the confirm reloads on mousedown; the click's tail may find the page gone
  await load
  await reloaded(page)
  expect(await page.evaluate(() => window._init_time), 'a new initialization').toBeGreaterThan(before)
})
