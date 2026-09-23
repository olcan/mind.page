import { expect, test, type Page } from '@playwright/test'
import { focusMindbox, mindbox } from './editor_helpers.js'
import { firestore, loadAdmin, loadAnonymous, waitForApp } from './helpers.js'

// the PAGE-CACHE RESTORE (see src/page_lifecycle.ts and onPageShow in index.svelte): the browser
// fires pagehide when it parks a page in its back/forward cache (a back navigation; on iOS every
// background tab Safari suspends), the Firestore SDK's own pagehide handler runs on its client
// there (on iPhone WebKit and Safari 14-16 a restricted queue where every later operation hangs;
// elsewhere a shutdown() that takes the tab out of the multi-tab protocol), and nothing restarts
// it at pageshow — so the app reloads a restored page, or asks first when an edit is unsaved.
// playwright's chromium runs with the back/forward cache disabled, so the first three rows
// dispatch the restore's own event (a persisted pageshow) on the loaded page: the browser's part
// is the SDK's contract, the app's handler is what they pin; the last row dispatches the pagehide
// itself and witnesses the dead client

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

// an item's save state by its label: an item exists client-side before its write completes, with
// saving set and savedText empty until the emulator acknowledged the write (onSaveDone)
const saveState = (page: Page, name: string) =>
  page.evaluate(name => {
    const id = window._item(name, true)?.id
    const item = window.__items.find(item => item.id == id)
    return item && { saving: item.saving, savedText: item.savedText }
  }, name)

// deletes a row's item (delete(false) skips the confirm prompt, the suite's convention) and waits
// for the deletion to reach the emulator, since the app's deleteDoc is fire-and-forget
async function deleteSettled(page: Page, name: string) {
  const id = await page.evaluate(name => {
    const item = window._item(name, true)
    const id = item?.saved_id // read first: the handle's getters throw once the item is gone
    item?.delete(false)
    return id
  }, name)
  expect(id, `${name} had been saved`).toBeTruthy()
  await expect.poll(async () => (await firestore().doc(`items/${id}`).get()).exists, { timeout: 30_000 }).toBe(false)
}

// the browser's own dialogs, by type, as they open (a beforeunload discard prompt would be one):
// playwright accepts an unhandled beforeunload dialog itself, which is why no row ever saw one,
// and handles nothing once a listener is attached, so this one accepts them
function dialogs(page: Page): string[] {
  const seen: string[] = []
  page.on('dialog', dialog => {
    seen.push(dialog.type())
    void dialog.accept()
  })
  return seen
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
  const seen = dialogs(page) // the modal's Reload confirmed the discard: the browser must not ask again
  await reload.click().catch(() => {}) // the confirm reloads on mousedown; the click's tail may find the page gone
  await load
  expect(seen, 'no browser discard prompt after the modal').toEqual([])
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
  // the row's item, deleted with its editor open (deleteItem takes the item whatever its state)
  await deleteSettled(page, '#e2e_restore_typed')
})

// the DEAD CLIENT itself, under an iPhone UA (the rows above dispatch only the restore's own
// event): playwright's chromium dispatches the pagehide, the handler that runs on it is the SDK's
// real one, and the UA is what selects its restricted branch — isSafari(), `Safari` without
// `Chrome`, plus /(?:Version|Mobile)\/1[456]/, which every iPhone WebKit UA matches through the
// frozen `Mobile/15E148` token. what the row proves: after the pagehide a write never settles and
// nothing says so (no error, no modal), and the reload the restore makes brings a live client
// back at the price the modal names — the write the dead client never sent is gone. what it does
// not prove: that the iPhone fires the pagehide when it suspends a tab (WebKit's side, see
// src/page_lifecycle.ts). the app's own UA switch (isIOS in index.svelte: navigator.platform, or
// `Mac` in the UA plus a touch document) stays off in this touchless desktop chromium, asserted
// in the row, so the steps run the desktop code paths
test.describe('under an iPhone UA', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  })

  test('a pagehide leaves the client dead — a write never settles, silently — and the restore brings a live one', async ({
    page,
  }) => {
    const CONTROL = '#e2e_dead_client/control a write that settles on the live client'
    const DEAD = '#e2e_dead_client/dead a write the dead client never sends'
    const AFTER = '#e2e_dead_client/after a write that settles on the reloaded client'
    await loadAdmin(page)
    const before = await page.evaluate(() => window._init_time)
    // the app's own UA switch stays off: the steps run the desktop code paths (isIOS's inputs as the
    // app reads them; the UA override leaves navigator.platform and the touchless document the host's)
    expect(
      await page.evaluate(
        () =>
          ['iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod'].includes(navigator.platform) ||
          (navigator.userAgent.includes('Mac') && 'ontouchend' in document)
      ),
      'isIOS off'
    ).toBe(false)
    // the CONTROL: a write that settles first, timed, so the "never settles" below is not a slow
    // emulator: the dead write's wait is derived from what the control needed
    const started = Date.now()
    await page.evaluate(text => void window._create(text), CONTROL)
    await expect.poll(() => saveState(page, '#e2e_dead_client/control'), { timeout: 30_000 }).toEqual({
      saving: false,
      savedText: CONTROL,
    })
    const controlMs = Date.now() - started
    // listening before the pagehide: an error thrown inside the SDK's handler counts too
    const errors: string[] = []
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', msg => void (msg.type() == 'error' && errors.push(msg.text())))
    // the SDK's own pagehide handler runs here: the zombie mark, then (this UA) the restricted queue
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    await page.evaluate(text => void window._create(text), DEAD)
    const waitMs = Math.max(5_000, 5 * controlMs) // at least five times what the control needed, by construction
    await page.waitForTimeout(waitMs)
    expect(
      await saveState(page, '#e2e_dead_client/dead'),
      `the write never settles (control settled in ${controlMs} ms, waited ${waitMs} ms)`
    ).toEqual({ saving: true, savedText: '' })
    await expect(page.locator('.background.visible'), 'no modal').toBeHidden()
    expect(errors, 'no error').toEqual([])
    // the restore: the hung write is an unsaved edit, so the app asks first; Reload reloads
    await restore(page)
    const reload = page.locator('.button.confirm', { hasText: /^Reload$/ })
    await expect(reload).toBeVisible()
    const load = page.waitForEvent('load')
    const seen = dialogs(page) // the modal's Reload confirmed the discard: the browser must not ask again
    await reload.click().catch(() => {}) // the confirm reloads on mousedown; the click's tail may find the page gone
    await load
    expect(seen, 'no browser discard prompt after the modal').toEqual([])
    await waitForApp(page) // signed in, the reload asks no anonymous choice
    expect(await page.evaluate(() => window._init_time), 'a new initialization').toBeGreaterThan(before)
    // the live client: the write the dead client never sent is gone, the control is there, and a
    // new write settles
    expect(await page.evaluate(() => window._item('#e2e_dead_client/dead', true)), 'the lost write').toBeNull()
    expect(await page.evaluate(() => !!window._item('#e2e_dead_client/control', true)), 'the control').toBe(true)
    await page.evaluate(text => void window._create(text), AFTER)
    await expect.poll(() => saveState(page, '#e2e_dead_client/after'), { timeout: 30_000 }).toEqual({
      saving: false,
      savedText: AFTER,
    })
    for (const name of ['#e2e_dead_client/control', '#e2e_dead_client/after']) await deleteSettled(page, name)
  })
})
