import { expect, test, type Page } from '@playwright/test'
import { focusMindbox, mindbox } from './editor_helpers.js'
import { loadAdmin, loadAnonymous, waitForApp } from './helpers.js'

// the PAGE-CACHE RESTORE (see src/page_lifecycle.ts and onPageShow in index.svelte): the browser
// fires pagehide when it parks a page in its back/forward cache (a back navigation; on iOS every
// background tab Safari suspends), the Firestore SDK's own pagehide handler leaves its client dead
// there (zombied, then shut down — or, on iPhone WebKit, stuck in a restricted queue), and nothing
// restarts it at pageshow — so the app reloads a restored page, or asks first when an edit is
// unsaved. playwright's chromium runs with the back/forward cache disabled, so these rows dispatch
// the restore's own event (a persisted pageshow) on the loaded page: the browser's part is the
// SDK's contract, the app's handler is what they pin

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
  // the stamp the restored page wrote before reloading, readable on the reloaded page
  expect(await page.evaluate(() => window._restored_reload_at), 'the restore stamp').toBeGreaterThan(0)
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

test('with an open editor holding typed text the restore asks first, and Later keeps the text without a reload', async ({
  page,
}) => {
  await loadAdmin(page)
  const before = await page.evaluate(() => window._init_time)
  // an item of this row's own, brought into view and opened for editing the way a user does (a
  // click on its text), so the typed text lives where the editor puts it — item.editorText, while
  // item.text stays as saved until editing ends — which the restore's unsaved predicate must read
  // (the everyday phone case: type, switch apps, come back)
  const TEXT = '#e2e_restore_typed a note under edit while the tab is away'
  await page.evaluate(text => void window._create(text), TEXT)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_restore_typed')
  await expect
    .poll(() => page.evaluate(() => !!window._item('#e2e_restore_typed', true)?.elem), { timeout: 10_000 })
    .toBe(true)
  const id = await page.evaluate(() => window._item('#e2e_restore_typed')!.id)
  // saved before the edit begins, so the only unsaved thing on the page is the typed text (an
  // in-flight save would make the item's text differ from its saved text and mask the editor case)
  await expect
    .poll(
      () =>
        page.evaluate(id => {
          const item = window.__items.find(item => item.id == id)!
          return !item.saving && item.savedText
        }, id),
      { timeout: 30_000 }
    )
    .toBe(TEXT)
  const paragraph = page.locator(`#item-${id} p`).first()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  const textarea = page.locator(`#textarea-${id}`)
  await expect(textarea).toBeVisible()
  // typed at the caret (its position is the editor's business; the text's presence is the witness)
  await textarea.pressSequentially(' typed, not yet saved ')
  await expect(textarea).toHaveValue(/typed, not yet saved/)
  await restore(page)
  const later = page.locator('.button.cancel', { hasText: /^Later$/ })
  await expect(later).toBeVisible()
  await expect(page.locator('.button.confirm', { hasText: /^Reload$/ })).toBeVisible()
  expect(await page.evaluate(() => window._init_time), 'no reload while asking').toBe(before)
  await later.click()
  await expect(later).toBeHidden()
  await expect(textarea, 'the editor is still open').toBeVisible()
  await expect(textarea, 'with the typed text').toHaveValue(/typed, not yet saved/)
  expect(await page.evaluate(() => window._init_time), 'no reload after Later').toBe(before)
})
