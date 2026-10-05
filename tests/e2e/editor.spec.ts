import { expect, test, type Locator, type Page } from '@playwright/test'
import { mindbox, focusMindbox, savedId, itemText, visible } from './editor_helpers.js'
import { firestore, loadAdmin, waitForApp } from './helpers.js'

// editor flows driven by keyboard and mouse, as admin on the anonymous account: creating items from
// the mindbox, searching and url state, tag navigation and history, editing items in place, undelete
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

test('typing in the mindbox and pressing shift+enter creates an item', async ({ page }) => {
  await loadAdmin(page)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_typed created via keyboard')
  await page.keyboard.press('Shift+Enter') // create, once the modifier is released (see Editor.svelte)
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_typed'))).toBe(true)
  await expect(mindbox(page)).toHaveValue('#e2e_typed ') // the new item's label stays as the search
  await expect.poll(() => savedId(page, '#e2e_typed'), { timeout: 30_000 }).toBeTruthy()
  expect(await itemText(page, '#e2e_typed')).toBe('#e2e_typed created via keyboard')
})

test('a transitive missing dependency logs one diagnostic at the red border; clears and relogs', async ({ page }) => {
  // src/item_errors.ts at Item.svelte's dom inspection seam: the macro expansion deliberately
  // keeps `eval missing dependencies` out of the console (a DIRECT missing dependency is marked
  // visibly), so a dependency's OWN missing dependency left the root red with no render-time
  // diagnostic, only the background reader's later line (the #chat/fable install, 2026-09-05). Now the rendered causes are read where the border is
  // decided and logged once per item; recovery forgets the item so a recurrence logs again.
  await loadAdmin(page)
  const root = '#e2e_dep_root'
  const diagnostics: string[] = []
  page.on('console', msg => {
    if (msg.type() == 'error' && msg.text().includes(`[${root}] error indication`)) diagnostics.push(msg.text())
  })
  // the dependency exists and is unique; ITS hidden dependency does not exist
  await page.evaluate(text => void window._create(text), '#e2e_dep_dep #_e2e_dep_absent\nthe dependency')
  await page.evaluate(text => void window._create(text), `${root} #_e2e_dep_dep\nroot with a macro <<1+1>>`)
  const bordered = () =>
    page.evaluate(root => !!window._item(root, true)?.elem?.querySelector('.container.error.bordered'), root)
  await expect.poll(bordered, { timeout: 30_000 }).toBe(true)
  await expect.poll(() => diagnostics.length).toBe(1)
  expect(diagnostics[0]).toContain('macro error: eval missing dependencies: e2e_dep_absent')
  expect(diagnostics[0]).toContain('dependencies can be transitive')
  // repeated mindbox passes re-rank and re-inspect but do NOT re-log
  await focusMindbox(page)
  await mindbox(page).fill('root with a macro')
  await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false)).toBe(true)
  expect(diagnostics.length).toBe(1)
  // the missing dependency arrives: the root re-expands, the border clears, nothing is logged
  await page.evaluate(text => void window._create(text), '#e2e_dep_absent\nnow present')
  await expect.poll(bordered, { timeout: 30_000 }).toBe(false)
  expect(diagnostics.length).toBe(1)
  // it disappears again: the SAME failure logs again (the item was forgotten on recovery)
  await page.evaluate(() => void window._item('#e2e_dep_absent', true)?.delete(false))
  await expect.poll(bordered, { timeout: 30_000 }).toBe(true)
  await expect.poll(() => diagnostics.length).toBe(2)
  expect(diagnostics[1]).toContain('eval missing dependencies: e2e_dep_absent')
  // leave no red-bordered items behind: error-ranked items pop on every mindbox change and
  // would shift the layout under later rows of this shared account
  for (const name of [root, '#e2e_dep_dep']) {
    await page.evaluate(name => void window._item(name, true)?.delete(false), name)
  }
  await expect.poll(() => page.evaluate(root => !!window._item(root, true), root)).toBe(false)
})

test('failed _tests rank, border, and log with dedup; relog after a healthy interval', async ({ page }) => {
  // issues/MindPage Failed Tests Pop Items Up With No Error Indication (reviews 192):
  // failed _tests in an item's global store rank it as an error on every mindbox
  // change but rendered no border and logged nothing. Now the dedicated failedTests
  // flag drives the red border AND exactly one deduped console.error summary per item
  // (base + alias entries normalized to ONE canonical stripped identity) plus one
  // captured-log replay -- cleared on all-pass so the SAME set failing again relogs.
  await loadAdmin(page)
  const name = '#e2e_failed_tests'
  const errors: string[] = []
  page.on('console', msg => {
    if (msg.type() == 'error' && msg.text().includes(name)) errors.push(msg.text())
  })
  await page.evaluate(text => void window._create(text), `${name}\nan item with stale failed tests`)
  // the PRODUCTION shape (tester.js): base result under the STRIPPED name, a
  // per-function alias entry carrying test:'_test_thing', both sharing get_log's
  // FORMATTED-STRING array
  const setTests = (ok: boolean, line: string) =>
    page.evaluate(([name, ok, line]) => {
      const gs = (window._item(name as string, true) as any).global_store
      gs._tests = {
        thing: { ms: 5, ok, log: [line] },
        thing_helper: { ms: 5, ok, log: [line], test: '_test_thing' },
      }
    }, [name, ok, line] as const)
  await setTests(false, "ERROR: test 'thing' FAILED in 5ms")
  await focusMindbox(page)
  const settle = async () => {
    await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false)).toBe(true)
  }
  await mindbox(page).fill('stale failed tests')
  await settle()
  await expect
    .poll(() => page.evaluate(name => {
      const item = (window.__items as any[]).find(i => i.labelText == name)
      return item && { failedTests: !!item.failedTests, hasError: !!item.hasError }
    }, name))
    .toMatchObject({ failedTests: true, hasError: true })
  // the red border: the container carries both error and bordered classes
  await expect
    .poll(() => page.evaluate(name => !!window._item(name, true)?.elem?.querySelector('.container.error.bordered'), name), { message: 'container carries the error class' })
    .toBe(true)
  // EXACTLY one summary + one replay: base and alias collapse to ONE canonical
  // identity, and the shared log is replayed once
  await expect.poll(() => errors.length).toBe(2)
  expect(errors[0]).toContain('1 failed test')
  expect(errors[0]).toContain('thing')
  expect(errors[0]).not.toContain('thing_helper')
  expect(errors[0]).not.toContain('_test_thing')
  expect(errors[1]).toContain("test 'thing' captured log")
  expect(errors[1]).toContain("ERROR: test 'thing' FAILED in 5ms")
  // dedup: further mindbox passes re-rank but do NOT re-log
  await mindbox(page).fill('stale failed')
  await settle()
  expect(errors.length).toBe(2)
  // tests pass -> the ranking input and border clear, error count unchanged
  await setTests(true, "ERROR: test 'thing' FAILED in 5ms")
  await mindbox(page).fill('stale failed tests')
  await settle()
  await expect
    .poll(() => page.evaluate(name => {
      const item = (window.__items as any[]).find(i => i.labelText == name)
      return item && { failedTests: !!item.failedTests, hasError: !!item.hasError }
    }, name))
    .toMatchObject({ failedTests: false, hasError: false })
  await expect
    .poll(() => page.evaluate(name => !!window._item(name, true)?.elem?.querySelector('.container.error'), name))
    .toBe(false)
  expect(errors.length).toBe(2)
  // the SAME canonical set fails again after the healthy interval: the memo was
  // cleared, so the second run logs again with the new captured line (review 192 §2.2)
  await setTests(false, "ERROR: test 'thing' FAILED in 7ms (second run)")
  await mindbox(page).fill('stale failed')
  await settle()
  await expect.poll(() => errors.length).toBe(4)
  expect(errors[3]).toContain('FAILED in 7ms (second run)')
  await mindbox(page).fill('')
  await page.keyboard.press('Escape')
})

test('dictated text types into the mindbox: a character on a remapped keycode is not Escape', async ({
  page,
}) => {
  // A virtual keyboard (dictation through `wtype`) types each character on a spare PHYSICAL
  // keycode, starting at 9, which is Escape: the first character of every transcription arrives
  // with `code: 'Escape'`, the next with `Digit1`, `Digit2`, ... Reading `code` first made the
  // editor cancel that keystroke and blur itself after two or three characters, losing the rest
  // of the transcription (issues/Dictated Text Triggers Escape And Blurs The Editor). Chromium's
  // raw key dispatch sets `code` and `key` independently, which is exactly that shape.
  await loadAdmin(page)
  await focusMindbox(page)
  await mindbox(page).fill('')
  const session = await page.context().newCDPSession(page)
  // the codes wtype climbs through, compressed: the point is that `code` and `key` disagree
  const codes = ['Escape', 'Digit1', 'Digit2', 'Digit3', 'Backspace', 'Tab', 'Enter', 'ArrowUp']
  // the FIRST character is a surrogate pair on the Escape keycode: the shape a code-unit count
  // would miss, taking the cancel branch again (review 0)
  const text = '😀Testing'
  for (const [index, character] of [...text].entries()) {
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown', // carries the text, as a virtual keyboard's keystroke does
      code: codes[index], // the remapped PHYSICAL key, unrelated to the character
      key: character,
      text: character,
      unmodifiedText: character,
    })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', code: codes[index], key: character })
  }
  await expect(mindbox(page)).toHaveValue(text) // every character, none cancelled
  await expect(mindbox(page)).toBeFocused() // and the editor never blurred
  await page.keyboard.press('Escape') // a REAL escape still cancels and blurs
  await expect(mindbox(page)).not.toBeFocused()
})

test('a focus Chrome dispatches no event for leaves the mindbox painted as it is', async ({ page }) => {
  // The textarea is hidden behind its backdrop until focused, so the Editor's focus wrapper makes it
  // visible before the native focus and the focus event then sets the state behind every
  // class:focused binding (the root's, the backdrop's, the buttons'). While the page has no system
  // focus Chrome moves document.activeElement for a programmatic focus or blur without an event (the
  // element's focus event waits for the page's own focus), and a focus that does not take dispatches
  // nothing, so the wrapper's old way, the ROOT's `focused` class added ahead of the event, outlived
  // the state after such a focus: an unfocused mindbox painted as focused, its backdrop in the
  // header's own background with the unfocused transparent border, an empty box invisible (the
  // owner's report of 2026-09-27). A minimized headless window with Playwright's focus emulation off
  // reproduces Chrome's silent moves, the window focus on restore, the deferred element focus, and
  // the blur a focused box gets when the page loses its system focus.
  await loadAdmin(page)
  const painted = () =>
    page.evaluate(() => {
      const has = (selector: string) => document.querySelector(selector)!.classList.contains('focused')
      const textarea = document.getElementById('textarea-mindbox')!
      return {
        root: has('.header .editor .editor'),
        backdrop: has('.header .backdrop'),
        buttons: has('.header .buttons'),
        textarea: getComputedStyle(textarea).visibility,
        active: document.activeElement === textarea,
      }
    })
  // the wrapped focus, counting the textarea's focus and blur events it dispatches
  const wrappedFocus = () =>
    page.evaluate(() => {
      const textarea = document.getElementById('textarea-mindbox')!
      let events = 0
      const count = () => events++
      textarea.addEventListener('focus', count)
      textarea.addEventListener('blur', count)
      textarea.focus()
      textarea.removeEventListener('focus', count)
      textarea.removeEventListener('blur', count)
      return { events, active: document.activeElement === textarea }
    })
  const unfocused = { root: false, backdrop: false, buttons: false, textarea: 'hidden', active: false }
  const focused = { root: true, backdrop: true, buttons: true, textarea: 'visible', active: true }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await painted(), 'the box before').toEqual(unfocused)
  const cdp = await page.context().newCDPSession(page)
  const { windowId } = await cdp.send('Browser.getWindowForTarget')
  const away = async () => {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    await expect.poll(() => page.evaluate(() => document.hasFocus()), { message: 'no system focus' }).toBe(false)
  }
  const back = async () => {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await expect.poll(() => page.evaluate(() => document.hasFocus()), { message: 'system focus back' }).toBe(true)
  }
  try {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    // the app's own moves while away: the wrapped focus (activeElement set, no event) then a blur
    await away()
    expect(await wrappedFocus(), 'the premise: a focus without an event').toEqual({ events: 0, active: true })
    // painted unfocused, the textarea visible (transparent) for the focus the page has yet to deliver
    expect(await painted(), 'the box while away, the textarea silently focused').toEqual({ ...unfocused, textarea: 'visible', active: true })
    const silentBlur = await page.evaluate(() => {
      const textarea = document.getElementById('textarea-mindbox')!
      let events = 0
      const count = () => events++
      textarea.addEventListener('blur', count)
      textarea.blur()
      textarea.removeEventListener('blur', count)
      return { events, after: document.activeElement?.tagName }
    })
    expect(silentBlur, 'the premise: a blur without an event').toEqual({ events: 0, after: 'BODY' })
    // the residue: the textarea stays visible (transparent) until the page's focus, the paint unfocused
    expect(await painted(), 'the box while away, silently blurred').toEqual({ ...unfocused, textarea: 'visible' })
    await back() // the window focus, no element focus: the residue cleared
    expect(await painted(), 'the box once the page regains focus').toEqual(unfocused)
    // a focus that does not take (here a disabled textarea) dispatches nothing either: reconciled at once
    const refused = await page.evaluate(() => {
      const textarea = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      textarea.disabled = true
      textarea.focus()
      const active = document.activeElement === textarea
      textarea.disabled = false
      return active
    })
    expect(refused, 'the premise: the focus refused').toBe(false)
    expect(await painted(), 'the box after a refused focus').toEqual(unfocused)
    // a textarea still active when the page regains focus gets the deferred focus event: focused for real
    await away()
    expect(await wrappedFocus(), 'the premise again: a focus without an event').toEqual({ events: 0, active: true })
    await back()
    await expect.poll(painted, { message: 'the box after the deferred focus' }).toEqual(focused)
    await page.keyboard.press('Escape') // the editor's own cancel blurs it
    await expect(mindbox(page)).not.toBeFocused()
    expect(await painted(), 'the box blurred after the deferred focus').toEqual(unfocused)
    // a focused box losing the system focus (a window switch, browser find): the blur is dispatched with
    // the element still active, and the textarea must hide (a visible one is matched by find-in-page)
    await focusMindbox(page)
    expect(await painted(), 'the box focused before the system blur').toEqual(focused)
    await away()
    await expect.poll(painted, { message: 'the box after the system blur' }).toEqual(unfocused)
    await back() // the app restores its last focused element 250 ms after the window's focus
    await expect.poll(painted, { message: 'the box restored by the app after the system blur' }).toEqual(focused)
    await page.keyboard.press('Escape')
    await expect(mindbox(page)).not.toBeFocused()
    expect(await painted(), 'the box blurred after the restore').toEqual(unfocused)
  } finally {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  // the real path: a click focuses the box, escape blurs it, every class following
  await focusMindbox(page)
  expect(await painted(), 'the box focused').toEqual(focused)
  await page.keyboard.press('Escape')
  await expect(mindbox(page)).not.toBeFocused()
  expect(await painted(), 'the box blurred').toEqual(unfocused)
})

test('searching filters items and puts the tag in the url; escape and shift+backspace clear', async ({ page }) => {
  await loadAdmin(page)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_typed')
  // the search is debounced while the editor is focused; a tag that exists becomes the url hash
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_typed')
  expect(await visible(page)).toContain('#e2e_typed') // shown with the pinned items, which rank first
  expect(await page.evaluate(() => window.__items.filter(item => item.matching).map(item => item.labelText))).toEqual([
    '#e2e_typed',
  ])
  // a command is cleared by escape (plain text is only blurred)
  await mindbox(page).fill('/e2e_not_a_command')
  await page.keyboard.press('Escape')
  await expect(mindbox(page)).toHaveValue('')
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('')
  // shift+backspace clears the search text
  await focusMindbox(page)
  await mindbox(page).pressSequentially('zzz no such item')
  await expect.poll(() => page.evaluate(() => window.__items.filter(item => item.matching).length)).toBe(0)
  await page.keyboard.press('Shift+Backspace')
  await expect(mindbox(page)).toHaveValue('')
})

// the source item of the navigation row; the /_undelete row below deletes and restores it
const SOURCE_TEXT =
  '#e2e_source refers to #e2e_target, [**e2e_target**/sub](#e2e_target/sub), [e2e_target/***sub***](#e2e_target/sub), ' +
  '[e2e_target&#39;s/sub](#e2e_target/sub) and [`&amp;`/sub](#e2e_target/sub)'
// lodash's five html escapes, the form in which a tag mark's handler receives its label
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

test('clicking a tag navigates to it, and the browser back button returns', async ({ page }) => {
  await loadAdmin(page)
  await page.evaluate(source => {
    void window._create('#e2e_target the target')
    void window._create('#e2e_target/sub the sub target')
    void window._create(source)
  }, SOURCE_TEXT)
  await expect.poll(() => savedId(page, '#e2e_source'), { timeout: 30_000 }).toBeTruthy()
  // items past hideIndex are not rendered, so search for the source item first
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_source')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  // a markdown tag link renders its label's markup, and a click maps to a tag component through
  // the DISPLAYED text (review link_labels 0: the raw label sent every trailing-component click
  // of `[**foo**/bar](#foo/bar)` to `#foo`): the trailing component selects the full tag, the
  // leading one its parent, also inside nested emphasis (the third click), and the browser back
  // button returns to the source each time
  const links = page.locator(`#item-${sourceId} mark[title="#e2e_target/sub"]`)
  await expect(links).toHaveCount(4)
  await expect(links.nth(0).locator('strong')).toHaveText('e2e_target')
  await expect(links.nth(1).locator('em strong')).toHaveText('sub')
  await expect(links.nth(2)).toHaveText("e2e_target's/sub") // an entity apostrophe, decoded by the browser
  await expect(links.nth(3).locator('code')).toHaveText('&amp;') // a code span's literal entity text
  // the label reaches the handler as a JavaScript literal inside the mark's onmousedown attribute,
  // html-escaped for the callback's unescape (review link_labels 1: a decoded apostrophe made the
  // handler a syntax error, and a literal `&amp;` was decoded twice): record what the handler gets
  await page.evaluate(() => {
    const handler = (window as any)._handleTagClick
    ;(window as any)._handleTagClick = (id: string, tag: string, reltag: string, e: MouseEvent) => {
      ;((window as any).__reltags ??= []).push(reltag)
      return handler(id, tag, reltag, e)
    }
  })
  const received = () => page.evaluate(() => (window as any).__reltags.at(-1))
  const clickEnd = async (mark: Locator) => {
    const box = (await mark.boundingBox())!
    await mark.click({ position: { x: box.width - 3, y: box.height / 2 } })
  }
  const back = async () => {
    await page.goBack()
    await expect(mindbox(page)).toHaveValue('#e2e_source')
    await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  }
  const quick = { timeout: 5_000 } // a wrong value is already there; no need to wait the default out
  await clickEnd(links.nth(0)) // the plain trailing component, at the mark's right edge
  await expect(mindbox(page), 'trailing component').toHaveValue('#e2e_target/sub ', quick)
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#e2e_target/sub')
  expect(await received()).toBe(escapeHtml('e2e_target/sub'))
  await back()
  await links.nth(0).locator('strong').click() // on the bold leading component's own glyphs
  await expect(mindbox(page), 'leading component').toHaveValue('#e2e_target ', quick)
  await back()
  // on the nested component's own glyphs (the event target is the inner element, not the mark)
  await links.nth(1).locator('em strong').click()
  await expect(mindbox(page), 'nested component').toHaveValue('#e2e_target/sub ', quick)
  await back()
  await clickEnd(links.nth(2)) // the handler compiles with the decoded apostrophe in the label
  await expect(mindbox(page), 'entity apostrophe').toHaveValue('#e2e_target/sub ', quick)
  expect(await received()).toBe(escapeHtml("e2e_target's/sub"))
  await back()
  await clickEnd(links.nth(3)) // the code label's literal entity text survives the callback boundary
  await expect(mindbox(page), 'code label').toHaveValue('#e2e_target/sub ', quick)
  expect(await received()).toBe(escapeHtml('&amp;/sub'))
  await back()
  // tags render as <mark title="#tag"> with a mousedown handler (see _handleTagClick in Item.svelte)
  await page.locator(`#item-${sourceId} mark[title="#e2e_target"]`).click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ') // tag searches get a trailing space
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#e2e_target')
  await expect.poll(() => visible(page)).toContain('#e2e_target')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#e2e_source')
})

test('an item is edited in place with shift+enter, and escape discards an edit', async ({ page }) => {
  await loadAdmin(page)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_typed') // bring the item into view
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_typed')!.elem), { timeout: 10_000 }).toBe(true)
  const id = await page.evaluate(() => window._item('#e2e_typed')!.id)
  const textarea = page.locator(`#textarea-${id}`)
  // a click on the item text opens its editor: mid-paragraph, past the label (a tag) and clear of the
  // item menu widget in the top-right corner
  const paragraph = page.locator(`#item-${id} p`).first()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  await expect(textarea).toBeVisible()
  await expect(textarea).toHaveValue('#e2e_typed created via keyboard')
  await textarea.press('ControlOrMeta+a')
  await textarea.pressSequentially('#e2e_typed edited via keyboard')
  await page.keyboard.press('Shift+Enter') // save
  await expect(textarea).toBeHidden()
  await expect.poll(() => itemText(page, '#e2e_typed')).toBe('#e2e_typed edited via keyboard')
  await expect
    .poll(async () => (await firestore().collection('items').doc(id).get()).data()?.text, { timeout: 30_000 })
    .toBe('#e2e_typed edited via keyboard')
  // escape asks before discarding unsaved changes, once the item is no longer saving (a save in
  // progress discards silently), so wait for the client to have processed the save
  await expect
    .poll(
      () =>
        page.evaluate(id => {
          const item = window.__items.find(item => item.id == id)!
          return !item.saving && item.savedText
        }, id),
      { timeout: 30_000 }
    )
    .toBe('#e2e_typed edited via keyboard')
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  await expect(textarea).toBeVisible()
  await textarea.press('End')
  await textarea.pressSequentially(' DISCARDED')
  await page.keyboard.press('Escape')
  await expect(page.getByText(/Discard unsaved changes to #e2e_typed/)).toBeVisible()
  await page.locator('.modal .button.confirm', { hasText: 'Discard' }).click()
  await expect(textarea).toBeHidden()
  expect(await itemText(page, '#e2e_typed')).toBe('#e2e_typed edited via keyboard')
})

test('/_undelete restores the last deleted item', async ({ page }) => {
  await loadAdmin(page)
  await page.evaluate(() => window._item('#e2e_source')!.delete(false))
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_source'))).toBe(false)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('/_undelete')
  await page.keyboard.press('Shift+Enter')
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_source'))).toBe(true)
  await expect.poll(() => savedId(page, '#e2e_source'), { timeout: 30_000 }).toBeTruthy()
  expect(await itemText(page, '#e2e_source')).toBe(SOURCE_TEXT)
})

test('Shift with the delete shortcut deletes the target item and its subtree after one confirmation', async ({ page }) => {
  // the owner's ask (2026-10-02): a chat subtree in one go. The Window shortcut with Shift
  // deletes the item named by the MindBox and every item under it in the TREE (the derived
  // ancestry the arrow keys walk: a renamed node moved under the target by its hidden parent tag
  // belongs with its tag-free children, a nested item moved out by its own does not; a hidden
  // dependency from another root is no tree edge; a look-alike sibling is no descendant) after ONE
  // confirm naming the count and the items deepest first; a dismissed confirm deletes nothing;
  // the deletions are ordinary ones, the target's last, so the MindBox backs up to its context
  // and /_undelete restores the target first (the vault's subtree_delete reviews 0-1)
  await loadAdmin(page)
  // the chat root the parent-tag rule needs (a tag parent must be a chat item: src/lineage.ts), the
  // unit corpus's stubs; removed at the end
  for (const text of ['#chat #_autodep', '#chat/vault']) await page.evaluate(t => void window._create(t), text)
  const T = '#e2e_tree'
  const texts: Record<string, string> = {
    [T]: `${T} root`,
    [`${T}/a`]: `${T}/a #_chat/vault #_autodep\n<<user>> a`, // the target: a chat branch
    [`${T}/a/x`]: `${T}/a/x\n<<user>> x`,
    [`${T}/b`]: `${T}/b #_chat/vault #_autodep\n<<user>> b`,
    [`${T}/in`]: `${T}/in #_${T.slice(1)}/a\n<<user>> moved in`, // under /a by its tag parent
    [`${T}/in/leaf`]: `${T}/in/leaf\n<<user>> under the moved node`,
    [`${T}/a/out`]: `${T}/a/out #_${T.slice(1)}/b\n<<user>> moved out`, // under /b by its tag parent
    [`${T}/a/out/leaf`]: `${T}/a/out/leaf\n<<user>> under the moved-out node`,
    [`${T}/ab`]: `${T}/ab a look-alike sibling`,
    ['#e2e_dep']: `#e2e_dep #_${T.slice(1)}/a\na dependency from another root`,
  }
  for (const text of Object.values(texts)) await page.evaluate(t => void window._create(t), text)
  const labels = Object.keys(texts)
  const state = () =>
    page.evaluate(
      labels => labels.map(l => [l, window._exists(l) ? (window._item(l, true) as any).text : null] as [string, string | null]),
      labels
    )
  const view = (name: string) =>
    page.evaluate(name => {
      const i = window._item(name, true) as any
      return { ancestors: i.ancestors, tag_parent: i.tag_parent, deps: i.dependencies.map((id: string) => (window._item(id, true) as any).label) }
    }, name)
  await expect.poll(() => state().then(s => s.every(([, text]) => text !== null))).toBe(true)
  // the fixture's saved ids, for the persisted cleanup at the end of the row
  const fixture = [...labels, '#chat', '#chat/vault']
  const savedIds = () => page.evaluate(ls => ls.map(l => window._item(l, true)?.saved_id).filter(Boolean) as string[], fixture)
  await expect.poll(async () => (await savedIds()).length, { timeout: 30_000 }).toBe(fixture.length)
  const ids = new Set(await savedIds())
  // the fixture's shape, proved before any deletion
  expect(await view(`${T}/in`)).toMatchObject({ tag_parent: `${T}/a`, ancestors: [`${T}/a`, T] })
  expect((await view(`${T}/in/leaf`)).ancestors).toEqual([`${T}/in`, `${T}/a`, T])
  expect(await view(`${T}/a/out`)).toMatchObject({ tag_parent: `${T}/b`, ancestors: [`${T}/b`, T] })
  expect((await view(`${T}/a/out/leaf`)).ancestors).toEqual([`${T}/a/out`, `${T}/b`, T])
  const dep = await view('#e2e_dep')
  expect(dep.tag_parent).toBeNull()
  expect(dep.ancestors).toEqual([])
  expect(dep.deps).toContain(`${T}/a`) // a dependency, not a tree edge
  const target = async (name: string) => {
    await page.evaluate(name => (window as any).MindBox.set(name, { scroll: true }), name)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  }
  const dialogs: string[] = []
  // dismissed: the whole fixture as it was
  const before = await state()
  await target(`${T}/a`)
  page.once('dialog', dialog => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  await page.keyboard.press('Control+Shift+Backspace')
  await expect.poll(() => dialogs.length).toBe(1)
  expect(dialogs[0]).toBe(`Delete ${T}/a and 3 items under it?\n\n${T}/in/leaf\n${T}/a/x\n${T}/in`)
  expect(await state()).toEqual(before)
  // accepted: the target, its nested child and the moved-in node with its child are gone; the
  // moved-out node and its child, the sibling, the look-alike and the dependent stay; the MindBox
  // backs up to the target's context
  await target(`${T}/a`)
  page.once('dialog', dialog => void dialog.accept())
  await page.keyboard.press('Control+Shift+Backspace')
  const gone = [`${T}/a`, `${T}/a/x`, `${T}/in`, `${T}/in/leaf`]
  await expect.poll(() => state().then(s => s.filter(([, text]) => text === null).map(([l]) => l))).toEqual(gone)
  expect(await mindbox(page).inputValue()).toBe(T)
  // a lone target under Shift still confirms
  await target(`${T}/ab`)
  page.once('dialog', dialog => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  await page.keyboard.press('Control+Shift+Backspace')
  await expect.poll(() => dialogs.length).toBe(2)
  expect(dialogs[1]).toBe(`Delete ${T}/ab?`)
  // /_undelete restores the target (deleted last) first, then the moved-in node (the MindBox,
  // focused by the shortcut's key and still naming the lone target, is cleared first)
  const undelete = async () => {
    await page.evaluate(() => (window as any).MindBox.set('/_undelete', {}))
    await mindbox(page).focus()
    await expect(mindbox(page)).toHaveValue('/_undelete')
    await page.keyboard.press('Shift+Enter')
  }
  await undelete()
  await expect.poll(() => page.evaluate(l => window._exists(l), `${T}/a`)).toBe(true)
  expect(await itemText(page, `${T}/a`)).toBe(texts[`${T}/a`])
  await undelete()
  await expect.poll(() => page.evaluate(l => window._exists(l), `${T}/in`)).toBe(true)
  // the API without a confirmation: the other branch with its moved-in node and that node's child
  expect(await page.evaluate(l => window._item(l)!.delete_subtree(false), `${T}/b`)).toBe(true)
  await expect.poll(() => state().then(s => s.filter(([, text]) => text === null).map(([l]) => l))).toEqual([`${T}/a/x`, `${T}/b`, `${T}/in/leaf`, `${T}/a/out`, `${T}/a/out/leaf`])
  expect(await page.evaluate(l => window._exists(l), T)).toBe(true)
  // the stubs and the rest of the fixture removed through the API (a root's subtree)
  // the undeleted items carry new ids and may still be saving: every existing fixture item has its saved
  // id first, else a save completing after the local delete queues a delete this row's wait would miss
  await expect
    .poll(() => page.evaluate(ls => ls.filter(l => window._exists(l)).every(l => !!window._item(l, true)?.saved_id), fixture), {
      timeout: 30_000,
    })
    .toBe(true)
  for (const id of await savedIds()) ids.add(id) // the undeleted items, whatever ids they carry now
  for (const root of ['#chat', T, '#e2e_dep']) expect(await page.evaluate(l => window._item(l)!.delete_subtree(false), root)).toBe(true)
  await expect.poll(() => page.evaluate(() => ['#chat', '#chat/vault', '#e2e_tree', '#e2e_tree/ab', '#e2e_dep'].some(l => window._exists(l)))).toBe(false)
  // the deletions PERSISTED before the row ends: deleteDoc is fire-and-forget, and a page closed on
  // pending deletes revived the fixture in the rows after (the ctrl+arrows row's jump landed on
  // `#e2e_tree/a/out/leaf`, erroring on its `<<user>>` macro, 2026-10-03)
  for (const id of ids)
    await expect.poll(async () => (await firestore().collection('items').doc(id).get()).exists, { timeout: 30_000 }).toBe(false)
})

test('attr changes reach the changed item and #_listen listeners, never bystanders', async ({ page }) => {
  // regression for itemAttrChanged (index.svelte): its guard compared item.id to itself, so every
  // item defining _on_attr_change ran on any attr change, and each received its OWN id instead of
  // the changed item's id
  await loadAdmin(page)
  const block = (kind: string) =>
    '```js\nfunction _on_attr_change(id, remote) { (window.__attr_calls ??= []).push([' +
    `'${kind}'` +
    ", id]) }\n```"
  await page.evaluate(
    ([target, listener, other]) => {
      void window._create('#e2e_attr_target\n' + target)
      void window._create('#e2e_attr_listener #_listen\n' + listener)
      void window._create('#e2e_attr_other\n' + other)
    },
    [block('self'), block('listener'), block('other')] as const
  )
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_attr_other'))).toBe(true)
  const target_id = await page.evaluate(() => {
    const item = window._item('#e2e_attr_target')!
    item.share('e2e_attr') // updates attr.shared via _update_attr_async -> itemAttrChanged
    return item.id as string
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).__attr_calls ?? []), { timeout: 15_000 })
    .toEqual(
      expect.arrayContaining([
        ['self', target_id],
        ['listener', target_id],
      ])
    )
  const calls: [string, string][] = await page.evaluate(() => (window as any).__attr_calls)
  expect(calls.filter(call => call[0] == 'other'), 'bystanders must not run').toEqual([])
  expect(calls.every(call => call[1] == target_id), 'all calls receive the changed id').toBe(true)
})

test('an expired live element is torn down exactly once when its replacement renders', async ({ page }) => {
  // pins the retired-node lifecycle (see invalidateElemCache/reapRetiredElems in util.js): cache
  // invalidation on a LIVE element must not destroy it in place (it stays functional), and the
  // re-render that replaces it must run its _destroy teardown exactly once per generation
  await loadAdmin(page)
  const text = [
    '#e2e_lifecycle',
    '```_html',
    '<div id="lc-$id" _cache_key="lc-$id"><script>',
    "const elem = document.getElementById('lc-$id')",
    "elem.setAttribute('_destroy', '')",
    'elem._destroy = () => { window.__destroys = (window.__destroys ?? 0) + 1 }',
    '</script>ok</div>',
    '```',
  ].join('\n')
  await page.evaluate(text => void window._create(text), text)
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_lifecycle'))).toBe(true)
  await page.evaluate(() => void (location.hash = '#e2e_lifecycle')) // render it (creates open in the editor)
  await expect
    .poll(() => page.evaluate(() => !!window._item('#e2e_lifecycle')?.elem?.querySelector('[_cache_key]')), {
      timeout: 15_000,
    })
    .toBe(true)
  expect(await page.evaluate(() => (window as any).__destroys ?? 0)).toBe(0)
  // invalidate with a forced render: the live element is retired, stays in place until the
  // replacement renders, then is destroyed exactly once
  await page.evaluate(() => (window._item('#e2e_lifecycle') as any).invalidate_elem_cache({ force_render: true, render_delay: 0 }))
  await expect.poll(() => page.evaluate(() => (window as any).__destroys ?? 0), { timeout: 15_000 }).toBe(1)
  // the next generation tears down once more — once per element, never double
  await page.evaluate(() => (window._item('#e2e_lifecycle') as any).invalidate_elem_cache({ force_render: true, render_delay: 0 }))
  await expect.poll(() => page.evaluate(() => (window as any).__destroys ?? 0), { timeout: 15_000 }).toBe(2)
  await page.waitForTimeout(2_000)
  expect(await page.evaluate(() => (window as any).__destroys)).toBe(2) // and stays there
})

test('images loading in small steps still trigger a layout within seconds', async ({ page }) => {
  // regression: item heights grow as each image loads, but each step stays under the 300px
  // relayout threshold — with only per-event deltas checked, no layout ran until an unrelated
  // pass (the periodic time-string update) 10+ seconds later, which is how a shared page could
  // take that long to wrap into its second column. the trigger now also fires on cumulative
  // drift from the height the LAST layout used (see onItemResized/updateItemLayout)
  const svg = (n: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160"><rect width="400" height="160" fill="#8cf"/><text x="10" y="80">${n}</text></svg>`
  await page.route(/\/e2e-grow-(\d)\.svg/, async route => {
    const n = route.request().url().match(/e2e-grow-(\d)/)![1]
    await new Promise(resolve => setTimeout(resolve, 1000 + 400 * Number(n))) // staggered loads
    await route.fulfill({ contentType: 'image/svg+xml', body: svg(n) })
  })
  await loadAdmin(page)
  await page.evaluate(() =>
    window._create('#e2e_growth staggered images\n![](/e2e-grow-1.svg)\n![](/e2e-grow-2.svg)\n![](/e2e-grow-3.svg)')
  )
  await page.evaluate(() => void (location.hash = '#e2e_growth')) // navigate to it so it renders
  // the item renders at its image-less height first (each image adds 160px only when it loads)
  await expect.poll(() => page.evaluate(() => window._item('#e2e_growth')?.elem?.offsetHeight ?? 0)).toBeGreaterThan(0)
  const before = await page.evaluate(() => (window as any).__layoutCount as number)
  // all three images load between ~1.4s and ~2.2s after creation, each step under the per-event
  // threshold; a layout pass must still follow within a few seconds, not after the 10s fallback
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_growth')?.elem?.offsetHeight ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(3 * 160)
  const heightSettledAt = Date.now()
  await expect
    .poll(() => page.evaluate(() => (window as any).__layoutCount as number), { timeout: 5_000 })
    .toBeGreaterThan(before)
  expect(Date.now() - heightSettledAt).toBeLessThan(5_000)
  // ... and the DOM must agree with what that layout computed: the layout mutates item.column
  // without assigning items, so without an explicit invalidation the columns it assigns are only
  // rendered when something else happens to invalidate them (up to 10s later, at the periodic
  // time-string pass) — the delayed column wrap seen on shared pages
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const items = (window as any).__items as { id: string; column: number; index: number }[]
          const hideIndex = (window as any).__hideIndex as number
          return items
            .filter(item => item.index < hideIndex)
            .every(item => {
              const div = document.querySelector('#super-container-' + item.id)
              const column = div ? [...document.querySelectorAll('.column')].indexOf(div.parentElement!) : -1
              return !div || column == item.column
            })
        }),
      { timeout: 3_000 } // well under the 10s periodic pass
    )
    .toBe(true)
})

test('the run button works on an installed item whose input blocks are all hidden', async ({ page }) => {
  // reported bug (issues/MindPage Run Button Crash on Installed Agent Items.md): the `runnable`
  // flag that SHOWS the button accepts hidden/removed input blocks, but the installed-item run
  // path extracted inputs with a stricter regex — so `match` returned null and `.join` threw an
  // uncaught TypeError. every installed #agent/chat/* provider is exactly this shape: its only
  // block is js_input_removed
  await loadAdmin(page)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.evaluate(() =>
    window._create(['#e2e_hidden_input hidden-only input', '```js_input_removed', '1 + 1', '```'].join('\n'))
  )
  await expect.poll(() => savedId(page, '#e2e_hidden_input'), { timeout: 30_000 }).toBeTruthy()
  // mark it INSTALLED the way /_install does — in the stored document — then reload so the app
  // loads it as an installed item (attr.source is what selects the run path under test)
  const id = await savedId(page, '#e2e_hidden_input')
  await firestore()
    .collection('items')
    .doc(id!)
    .update({ attr: { source: 'https://github.com/olcan/mind.items/blob/master/e2e.md' } })
  await page.reload()
  await waitForApp(page)
  await page.evaluate(() => void (location.hash = '#e2e_hidden_input')) // bring it up so it renders
  // NOTE: .button.run lives in .item-menu, a SIBLING of .item — not inside it
  const run = page.locator('.button.run')
  await expect(run).toHaveCount(1, { timeout: 30_000 }) // only this item is runnable
  await run.click()
  // the run item is created from the hidden input, and nothing throws
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_hidden_input/run')), { timeout: 30_000 }).toBe(true)
  expect(errors.filter(e => e.includes('TypeError'))).toEqual([])
  // the copied block keeps ONE suffix: normalizing an already-hidden block must not produce
  // js_input_removed_removed
  const runText = await page.evaluate(() => window._item('#e2e_hidden_input/run', true)?.text ?? '')
  expect(runText).toContain('js_input_removed')
  expect(runText).not.toContain('_removed_removed')
})

test('a code comment link reaches the app handler with its url as written', async ({ page }) => {
  // the comment linkifier's anchors carry the url as escaped html and hand the DOM attribute to
  // _handleLinkClick, which unescapes it once: a url whose text carries a literal `&amp;` used
  // to arrive decoded once too many (2026-09-21, issues/Escaped Url Entity Backfills)
  await loadAdmin(page)
  const plain = 'https://example.com/q?a=1&b=2'
  const literal = 'https://example.com/lit?x=1&amp;y=2'
  await page.evaluate(
    ([plain, literal]) =>
      window._create(['#e2e_comment_link', '```js', `// see ${plain} and ${literal}`, 'const x = 1', '```'].join('\n')),
    [plain, literal]
  )
  await expect.poll(() => savedId(page, '#e2e_comment_link'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(() => void (location.hash = '#e2e_comment_link')) // bring it up so it renders
  const anchors = page.locator('.hljs-comment a[data-link-click]')
  await expect(anchors).toHaveCount(2, { timeout: 30_000 })
  expect(await anchors.evaluateAll(as => as.map(a => a.getAttribute('href')))).toEqual([plain, literal])
  // the handler's contract: it unescapes the href it is handed once, then calls the app's
  // onLinkClick with it; the interception applies that same unescape, so the assertion is on
  // what the app receives
  const received = await page.evaluate(() => {
    const w = window as any
    const calls: string[] = []
    const original = w._handleLinkClick
    w._handleLinkClick = (_id: string, href: string, e: MouseEvent) => {
      calls.push(w._.unescape(href))
      e.stopPropagation()
      e.preventDefault()
    }
    for (const a of document.querySelectorAll('.hljs-comment a[data-link-click]'))
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    w._handleLinkClick = original
    return calls
  })
  expect(received, 'each url as the app receives it, the literal entity included').toEqual([plain, literal])
})

test('a chain of continuations shortens to its last segment; a branch keeps its deviation', async ({ page }) => {
  // the label shortening against the context keeps short numeric suffixes to disambiguate
  // (.../99/9/9) and, since 2026-09-28, collapses the leading run of /0 segments (the main branch
  // of a chain) to the last one: a chain of any depth reads #…/0, a branch keeps its deviation
  await loadAdmin(page)
  const labels = [
    '#e2e_deep', '#e2e_deep/0', '#e2e_deep/0/0', '#e2e_deep/0/0/0', '#e2e_deep/0/0/0/0',
    '#e2e_deep/0/0/1', '#e2e_deep/0/0/1/0', '#e2e_deep/0/0/1/0/0',
    '#e2e_deep/99', '#e2e_deep/99/9', '#e2e_deep/99/9/9', '#e2e_deep/98', '#e2e_deep/98/9', '#e2e_deep/98/9/9',
  ]
  await page.evaluate(labels => { for (const label of labels) void window._create(label + ' item') }, labels)
  await expect.poll(() => savedId(page, '#e2e_deep/98/9/9'), { timeout: 30_000 }).toBeTruthy()
  // the rendered labels of the listed items, by their full label (the mark's text carries the
  // ellipsis and the suffix; the leading # is rendered outside it)
  const shown = () =>
    page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.container mark.label')].map((m: any) => [m.title, m.textContent])))
  const navigate = async (name: string) => {
    await page.evaluate(name => (window as any).MindBox.set(name, { scroll: true }), name)
    await expect.poll(async () => (await shown())[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    return shown()
  }
  const chain = await navigate('#e2e_deep/0/0/0/0')
  expect(chain['#e2e_deep/0/0/0/0'], 'the target: the last segment only').toBe('…/0')
  expect([chain['#e2e_deep/0'], chain['#e2e_deep/0/0'], chain['#e2e_deep/0/0/0']], 'the chain above it: the same').toEqual(['…/0', '…/0', '…/0'])
  const branch = await navigate('#e2e_deep/0/0/1/0/0')
  expect(branch['#e2e_deep/0/0/1/0/0'], 'a branch keeps its deviation and what follows').toBe('…/1/0/0')
  expect([branch['#e2e_deep/0/0/1'], branch['#e2e_deep/0/0/1/0']]).toEqual(['…/1', '…/1/0'])
  const nines = await navigate('#e2e_deep/99/9/9')
  expect(nines['#e2e_deep/99/9/9'], 'the disambiguating short suffixes are kept as before').toBe('…/99/9/9')
  expect((await navigate('#e2e_deep/98/9/9'))['#e2e_deep/98/9/9']).toBe('…/98/9/9')
  // the other shortening site: a query for an ancestor lists its descendants shortened against
  // the query (the prefix match; a narrow query, so the listing is not cut at the hide index);
  // the same collapse there, and both nines distinct
  const listed = async (query: string, key: string) => {
    await page.evaluate(name => (window as any).MindBox.set(name, { scroll: true }), query)
    // the listing is cut at the hide index: show more until the descendant is rendered
    await expect
      .poll(
        async () => {
          const found = (await shown())[key] ?? null
          if (found == null) await page.evaluate(() => document.querySelector('.toggle.show')?.dispatchEvent(new Event('click')))
          return found
        },
        { timeout: 15_000 }
      )
      .not.toBeNull()
    return shown()
  }
  const under = await listed('#e2e_deep/0/0', '#e2e_deep/0/0/1/0/0')
  expect([under['#e2e_deep/0/0/0/0'], under['#e2e_deep/0/0/1/0/0']]).toEqual(['…/0', '…/1/0/0'])
  expect((await listed('#e2e_deep/99', '#e2e_deep/99/9/9'))['#e2e_deep/99/9/9']).toBe('…/99/9/9')
  expect((await listed('#e2e_deep/98', '#e2e_deep/98/9/9'))['#e2e_deep/98/9/9']).toBe('…/98/9/9')
})

test('ctrl+arrows at the edges of an item editor jump to the neighboring items, like cmd+arrows; away from the edge they move the caret there', async ({
  page,
}) => {
  // Cmd+↑ at the start and Cmd+↓ at the end of an item's text open the previous/next item's
  // editor; Ctrl does the same since 2026-09-28 (Super+arrows belong to the window manager on
  // Linux, where the browser reports Super as Meta). Away from the edge, Ctrl+↑/↓ move the caret
  // to the start/end first (2026-10-03: Ctrl maps explicitly to the item's edges for the owner's Linux
  // workflow; Cmd+arrows do this natively on a Mac and are left to the browser)
  await loadAdmin(page)
  for (const label of ['#e2e_jump/a', '#e2e_jump/b']) await page.evaluate(label => void window._create(label + ' item'), label)
  await expect.poll(() => savedId(page, '#e2e_jump/b'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(() => (window as any).MindBox.set('#e2e_jump', { scroll: true }))
  const ids = () => page.evaluate(() => [...document.querySelectorAll('.container[data-item-id]')].map(c => c.getAttribute('data-item-id')!))
  const [aId, bId] = await Promise.all(['#e2e_jump/a', '#e2e_jump/b'].map(name => page.evaluate(n => window._item(n, true)!.id, name)))
  await expect.poll(async () => (await ids()).filter(id => id == aId || id == bId).length, { timeout: 15_000 }).toBe(2)
  // the jumps follow the RANK order (the item view's position), whichever it is; the listing lays the
  // ranked items out in columns, so the DOM order is not it
  const ranked = await page.evaluate(ids => ids.map(id => [id, (window._item(id, true) as any).position as number] as const), [aId, bId])
  const [first, second] = ranked.sort((x, y) => x[1] - y[1]).map(([id]) => id)
  // a click on the first item's text opens its editor; End moves the caret to the end of its one line
  const paragraph = page.locator(`#item-${first} p`).first()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  await expect(page.locator(`#textarea-${first}`)).toBeFocused()
  const caret = (id: string, at: 'start' | 'end' | number) =>
    page.evaluate(([id, at]) => {
      const t = document.getElementById('textarea-' + id) as HTMLTextAreaElement
      const pos = at == 'end' ? t.value.length : at == 'start' ? 0 : at
      t.setSelectionRange(pos, pos)
    }, [id, at] as const)
  const selection = (id: string) =>
    page.evaluate(id => {
      const t = document.getElementById('textarea-' + id) as HTMLTextAreaElement
      return [t.selectionStart, t.selectionEnd, t.value.length]
    }, id)
  await caret(first, 3)
  await page.keyboard.press('Control+ArrowDown')
  await expect(page.locator(`#textarea-${first}`), 'away from the edge: the same editor keeps the focus').toBeFocused()
  const [s1, e1, l1] = await selection(first)
  expect([s1, e1], 'the caret moved to the end').toEqual([l1, l1])
  await page.keyboard.press('Control+ArrowDown')
  await expect(page.locator(`#textarea-${second}`), 'the next item opened for editing and focused').toBeFocused()
  await caret(second, 3)
  await page.keyboard.press('Control+ArrowUp')
  await expect(page.locator(`#textarea-${second}`), 'away from the edge: the same editor keeps the focus').toBeFocused()
  expect((await selection(second)).slice(0, 2), 'the caret moved to the start').toEqual([0, 0])
  await page.keyboard.press('Control+ArrowUp')
  await expect(page.locator(`#textarea-${first}`), 'and back to the previous one').toBeFocused()
  await page.keyboard.press('Escape') // nothing edited: the editors close
  await expect(page.locator(`#textarea-${first}`)).toBeHidden()
})

test('ctrl+alt+i opens the image dialog like shift+cmd+i, in an item editor and from the window', async ({ page }) => {
  // the image shortcut's Ctrl form (2026-09-28): Ctrl+Shift+I is the browsers' devtools, so Ctrl+Alt+I
  await loadAdmin(page)
  await page.evaluate(() => void window._create('#e2e_image_key item'))
  await expect.poll(() => savedId(page, '#e2e_image_key'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(() => (window as any).MindBox.set('#e2e_image_key', { scroll: true }))
  const id = await page.evaluate(() => window._item('#e2e_image_key', true)!.id)
  await expect.poll(() => page.evaluate(id => !!document.querySelector(`#item-${id} p`), id), { timeout: 15_000 }).toBe(true)
  const paragraph = page.locator(`#item-${id} p`).first()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  await expect(page.locator(`#textarea-${id}`)).toBeFocused()
  // the modal component stays mounted with its last content: visibility is the signal, and its
  // Cancel button the way out (the dialog's own; the editor keeps the focus)
  const modal = page.locator('.modal')
  const cancel = modal.getByText('Cancel', { exact: true })
  await page.keyboard.press('Control+Alt+KeyI')
  await expect(modal, 'the image dialog from the editor').toBeVisible()
  await expect(modal).toContainText('Select images')
  await cancel.click()
  await expect(modal).toBeHidden()
  await expect(page.locator(`#textarea-${id}`)).toBeFocused()
  await page.keyboard.press('Escape') // nothing edited: the editor closes
  await expect(page.locator(`#textarea-${id}`)).toBeHidden()
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('Control+Alt+KeyI') // from the window: a new image item's dialog
  await expect(modal, 'the image dialog from the window').toBeVisible()
  await expect(modal).toContainText('Select images')
  await cancel.click()
  await expect(modal).toBeHidden()
})

test("the MindBox's focus wrapper forwards preventScroll: a restore keeps the page's scroll position", async ({ page }) => {
  // the window's focus restore (after a workspace switch) focuses the last focused element with
  // { preventScroll: true }; the Editor's own focus wrapper (visibility first, then the native focus)
  // must pass the option on, else the native focus scrolls the MindBox into view (2026-09-28)
  await loadAdmin(page)
  const scrollTop = () => page.evaluate(() => document.body.scrollTop)
  await page.evaluate(() => document.body.scrollTo(0, 600))
  await expect.poll(scrollTop, { message: 'the body scrolled down (the page is long enough)' }).toBeGreaterThan(300)
  const before = await scrollTop()
  await page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).focus({ preventScroll: true }))
  await expect(page.locator('#textarea-mindbox')).toBeFocused()
  expect(await scrollTop(), 'no scroll with preventScroll').toBe(before)
})

test('escape in the MindBox keeps a query set by a tag click: the editor passed its last TYPED text', async ({ page }) => {
  // a tag click (or MindBox.set) changes the MindBox's text without an input event, so the Editor's
  // typed copy went stale, and Escape (like Cmd+Backspace) handed that copy to the done handler,
  // which takes it as the text: with `#e2e_esc` typed and its `#e2e_esc/sub` tag clicked, Escape
  // turned the query back into `#e2e_esc` (the owner's report, 2026-10-03)
  await loadAdmin(page)
  await page.evaluate(() => {
    void window._create('#e2e_esc the parent, see #e2e_esc/sub')
    void window._create('#e2e_esc/sub the sub')
  })
  await expect.poll(() => savedId(page, '#e2e_esc/sub'), { timeout: 30_000 }).toBeTruthy()
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_esc')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_esc')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_esc')!.elem)).toBe(true)
  const id = await page.evaluate(() => window._item('#e2e_esc')!.id)
  await page.locator(`#item-${id} mark[title="#e2e_esc/sub"]`).click()
  await expect(mindbox(page)).toHaveValue('#e2e_esc/sub ') // tag searches get a trailing space
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#e2e_esc/sub')
  // the owner's position: the MindBox focused on the clicked query (focused here whatever the click left)
  await page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).focus())
  await expect(mindbox(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(mindbox(page), 'plain text: Escape only blurs').not.toBeFocused()
  await expect(mindbox(page)).toHaveValue('#e2e_esc/sub ')
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#e2e_esc/sub')
})

// the scroll-to-top rows (2026-10-03): the page's TOP is the header's offset (an area sits above the
// header, 600 px or so, and the page loads scrolled to the header; scrollTo lands within 2 px of it)
const scrollTop = (page: Page) => page.evaluate(() => document.body.scrollTop)
const headerTop = (page: Page) => page.evaluate(() => (document.querySelector('.header') as HTMLElement).offsetTop)
// the page's history entries: the session state history's length and the current index
const entries = (page: Page) => page.evaluate(() => [(window as any)._history.length, (window as any)._history_index] as const)
// scrolls 600 px below the header and returns the position
const scrollDown = async (page: Page) => {
  const top = await headerTop(page)
  await page.evaluate(y => document.body.scrollTo(0, y), top + 600)
  await expect.poll(() => scrollTop(page), { message: 'the body scrolled below the header (the page is long enough)' }).toBeGreaterThan(top + 300)
  return scrollTop(page)
}
const nearTop = async (page: Page, message: string) =>
  expect.poll(async () => Math.abs((await scrollTop(page)) - (await headerTop(page))) <= 2, { message }).toBe(true)
// the shown names as a SET (sorted): the rank of an unrelated item can shift under a row (the
// dependency row's items relog on a timer), and these assertions guard against a collapse, not an order
const asSet = (names: string[]) => [...names].sort()
// shows more items (the set a visibility reset would collapse) and returns the shown names
const expand = async (page: Page) => {
  const shown = await visible(page)
  await page.locator('.toggle.show').first().click()
  await expect.poll(() => visible(page).then(v => v.length)).toBeGreaterThan(shown.length)
  return visible(page)
}
const focusMindboxInPlace = (page: Page, caret?: number) =>
  page.evaluate(caret => {
    const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
    t.focus({ preventScroll: true }) // see the focus wrapper row above
    if (caret !== undefined) t.setSelectionRange(caret, caret)
  }, caret)
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
// the scroll listener's 250 ms write idle, so the next turn's scroll event arms it (a row that needs
// the write pending across its own steps waits for this first)
const noWritePending = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window as any)._history_update_pending), { message: 'no scroll write pending' }).toBe(false)
// a modified arrow dispatched to the MindBox from inside the page, for the steps whose precondition
// must hold in the same browser turn as the key (a real press is a separate round trip)
const dispatchArrow = (key: 'ArrowUp' | 'ArrowDown') =>
  document
    .getElementById('textarea-mindbox')!
    .dispatchEvent(new KeyboardEvent('keydown', { key, code: key, metaKey: true, bubbles: true, cancelable: true }))

test('cmd/ctrl+arrows in the MindBox scroll a scrolled page to the top with a history entry; the shown items and the focus stay', async ({
  page,
}) => {
  // the owner's ask (2026-10-03): with the page scrolled down, ⌘↑/⌃↑/⌘↓/⌃↓ in the MindBox only bring
  // the top back into view (the query history and the edge jumps make sense with the MindBox in sight),
  // with a history entry so Back (button, shortcut or gesture) returns to the position
  await loadAdmin(page)
  // the listener's write survives a replace of the SAME entry (review 2 B2): a scroll and Show more
  // (toggleItems replaces the entry's hideIndex, keeping its stored position) in one turn, inside the
  // listener's 250 ms; the entry's stored position must end at the live one (an identity check on
  // history.state dropped the write, and nothing wrote it later)
  const shown = await visible(page)
  const stored0 = await page.evaluate(() => history.state.scrollPosition as number)
  await noWritePending(page)
  await page.evaluate(top => {
    document.body.dispatchEvent(new Event('scroll')) // the write armed now, for this entry (a scrollTo's own event comes a frame later)
    document.body.scrollTo(0, top + 600)
    ;(document.querySelector('.toggle.show') as HTMLElement).click()
  }, await headerTop(page))
  await expect.poll(() => visible(page).then(v => v.length)).toBeGreaterThan(shown.length)
  await expect
    .poll(() => page.evaluate(() => history.state.scrollPosition === document.body.scrollTop && document.body.scrollTop > 0), {
      message: 'the stored position caught up with the live one',
    })
    .toBe(true)
  expect(await page.evaluate(() => [history.state.scrollPosition, (window as any)._history[(window as any)._history_index].scrollPosition])).not.toContain(stored0)
  const expanded = await visible(page)
  const before = await scrollDown(page)
  await focusMindboxInPlace(page)
  await expect(mindbox(page)).toBeFocused()
  expect(await scrollTop(page)).toBe(before)
  const [length, index] = await entries(page)
  // a stale stored position planted and the key dispatched in the same turn (no listener write between):
  // the entry left must record the LIVE position; the caret at the end of the empty text is the edge
  // jump's position
  await page.evaluate(dispatchArrow => {
    history.replaceState({ ...history.state, scrollPosition: 1 }, '')
    eval(dispatchArrow)('ArrowDown')
  }, dispatchArrow.toString())
  await nearTop(page, 'scrolled to the top')
  await expect(mindbox(page), 'the MindBox keeps the focus: no item editor opened').toBeFocused()
  expect(asSet(await visible(page)), 'the expanded items stay').toEqual(asSet(expanded))
  expect(await entries(page), 'one history entry pushed').toEqual([length + 1, index + 1])
  expect(await page.evaluate(() => [history.state.scrollPosition, history.state.hideIndex])).toEqual([await headerTop(page), expanded.length])
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index), 'the live position on the entry left').toBe(before)
  // Back under a controlled overlap (review 1 B2): a scroll event schedules the listener's 250 ms write
  // and Back follows in the same turn while the animation frames the restore awaits are HELD for 400 ms,
  // so the write fires with the destination entry current and the body still at the header. The
  // destination keeps its position and the restore lands there (the write used to take the departed
  // view's position, and Back stayed at the header)
  await page.evaluate(() => {
    const raf = window.requestAnimationFrame
    const held: FrameRequestCallback[] = []
    window.requestAnimationFrame = cb => held.push(cb)
    document.body.dispatchEvent(new Event('scroll'))
    history.back()
    setTimeout(() => {
      window.requestAnimationFrame = raf
      held.forEach(cb => cb(performance.now()))
    }, 400)
  })
  await expect.poll(async () => Math.abs((await scrollTop(page)) - before) <= 2, { message: 'Back returns to the position' }).toBe(true)
  expect(await entries(page)).toEqual([length + 1, index])
  expect(await page.evaluate(i => (window as any)._history.slice(i).map((s: any) => s.scrollPosition), index), 'both positions intact').toEqual([
    before,
    await headerTop(page),
  ])
  expect(asSet(await visible(page))).toEqual(asSet(expanded))
  await page.goForward()
  await nearTop(page, 'Forward returns to the top')
  expect(await entries(page)).toEqual([length + 1, index + 1])
  expect(asSet(await visible(page))).toEqual(asSet(expanded))
  // a fresh scroll on the destination while the departed view's write is pending (review 2 B2): one turn
  // arms a write for the top entry (a scroll event), goes Back, and scrolls the destination further
  // 120 ms later, while that write is still pending (it fires at 250 ms); the restore, two frames,
  // is normally long done by then. The destination must record the fresh position (the identity
  // check dropped the write, and the fresh scroll could not re-arm while one was pending)
  await noWritePending(page)
  await page.evaluate(y => {
    document.body.dispatchEvent(new Event('scroll'))
    history.back()
    setTimeout(() => document.body.scrollTo(0, y), 120)
  }, before + 100)
  await expect
    .poll(() => page.evaluate(i => (window as any)._history[i].scrollPosition, index), { message: 'the destination recorded the fresh position' })
    .toBe(before + 100)
  expect(await page.evaluate(() => [history.state.scrollPosition, document.body.scrollTop])).toEqual([before + 100, before + 100])
  expect(await entries(page)).toEqual([length + 1, index])
})

test("cmd/ctrl+arrows in the MindBox on a query: the text and caret stay, typing afterwards pushes, a new scroll truncates Forward, a pending query settles first, and at the top the edge jump remains", async ({
  page,
}) => {
  await loadAdmin(page)
  // three tall items, so the query's page scrolls well below the header, and a tall item under another
  // tag for the unrevealed-target step
  const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n\n')
  for (const n of ['a', 'b', 'c']) await page.evaluate(([n, body]) => void window._create(`#e2e_scroll/${n} ${body}`), [n, body] as const)
  await page.evaluate(body => void window._create(`#e2e_ctx ${body}`), body) // a tall context item ...
  await page.evaluate(() => void window._create('#e2e_ctx/leaf the nested target')) // ... above its nested child
  await expect.poll(() => savedId(page, '#e2e_ctx/leaf'), { timeout: 30_000 }).toBeTruthy()
  await expect.poll(() => savedId(page, '#e2e_scroll/c'), { timeout: 30_000 }).toBeTruthy()
  const leafId = await page.evaluate(() => window._item('#e2e_ctx/leaf', true)!.id)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_scroll') // a parent tag no item carries: no hash, the three children match
  await expect.poll(() => page.evaluate(() => window.__items.filter(item => item.matching).length), { timeout: 10_000 }).toBe(3)
  const ids = await Promise.all(['a', 'b', 'c'].map(n => page.evaluate(n => window._item(`#e2e_scroll/${n}`, true)!.id, n)))
  await expect.poll(() => page.evaluate(ids => ids.every(id => !!document.querySelector(`#item-${id}`)), ids), { timeout: 15_000 }).toBe(true)
  const selection = () =>
    page.evaluate(() => {
      const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      return [t.value, t.selectionStart, t.selectionEnd]
    })
  const texts = (from: number) => page.evaluate(from => (window as any)._history.slice(from).map((s: any) => s.editorText), from)
  const before = await scrollDown(page)
  await focusMindboxInPlace(page, 4) // the caret inside the text: neither edge
  const [length, index] = await entries(page)
  await page.keyboard.press('Meta+ArrowUp')
  await nearTop(page, 'scrolled to the top')
  await expect(mindbox(page)).toBeFocused()
  expect(await selection(), 'the text and caret stay').toEqual(['#e2e_scroll', 4, 4])
  expect(await entries(page)).toEqual([length + 1, index + 1])
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index)).toBe(before)
  // typing after the scroll's entry pushes (the entry is final, like a tag click's), so Back reaches the top
  // entry; a term all three items carry, since a unique tag would also scroll the page to its item
  await focusMindboxInPlace(page, 11)
  await page.keyboard.type(' line')
  await expect.poll(() => entries(page), { timeout: 10_000 }).toEqual([length + 2, index + 2])
  expect(await page.evaluate(() => history.state.editorText)).toBe('#e2e_scroll line')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_scroll')
  await nearTop(page, 'Back: the top entry')
  // a new scroll from the top entry truncates the forward entry, as a tag click would
  await scrollDown(page)
  await focusMindboxInPlace(page, 4)
  await page.keyboard.press('Control+ArrowUp')
  await nearTop(page, 'scrolled to the top again')
  expect(await entries(page), 'the forward entry replaced').toEqual([length + 2, index + 2])
  expect(await texts(index)).toEqual(['#e2e_scroll', '#e2e_scroll', '#e2e_scroll'])
  // a query still debouncing when the key arrives is settled before the scroll's entry: two entries for
  // the new query, at the position and at the top, never the old query at the top in between. The typed
  // text and the key go in one browser turn with the pending debounce asserted between them, so this is
  // the pending branch. The query names a UNIQUE item that MOVES (review 1 B3; the oldest of the three
  // ranks last under the parent query and first under its own, and only a moved target is scrolled to):
  // the layout the flush runs would scroll to that item a few frames later, and the explicit scroll to
  // the top must win, so the position is checked again once the layout has had its time
  await scrollDown(page)
  const pending = await page.evaluate(dispatchArrow => {
    const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
    t.focus({ preventScroll: true })
    t.setRangeText('/a', t.value.length, t.value.length, 'end')
    t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '/a' }))
    const pending = (window as any)._mindboxDebounced === true
    eval(dispatchArrow)('ArrowUp')
    return pending
  }, dispatchArrow.toString())
  expect(pending, 'the query was still debouncing when the key arrived').toBe(true)
  await nearTop(page, 'scrolled to the top with the new query')
  expect(await entries(page)).toEqual([length + 4, index + 4])
  expect(await texts(index + 2)).toEqual(['#e2e_scroll', '#e2e_scroll/a', '#e2e_scroll/a'])
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition > (document.querySelector('.header') as HTMLElement).offsetTop + 2, index + 3), 'the new query at the position').toBe(true)
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index + 4)).toBe(await headerTop(page))
  await page.waitForTimeout(700) // time for the layout's queued scroll, not a sync point: the assertion below is the check
  await nearTop(page, 'still at the top once the layout settled: the explicit scroll won over the target scroll')
  expect(await page.evaluate(() => history.state.scrollPosition)).toBe(await headerTop(page))
  // at the top, Ctrl+↓ away from the end moves the caret there (no jump, no entry), and at the end keeps
  // its edge jump (the query's item opens for editing) with no entry
  await focusMindboxInPlace(page, 4)
  await page.keyboard.press('Control+ArrowDown')
  await expect(mindbox(page)).toBeFocused()
  expect(await selection(), 'the caret moved to the end').toEqual(['#e2e_scroll/a', 13, 13])
  expect(await entries(page), 'no entry for the caret move').toEqual([length + 4, index + 4])
  await page.keyboard.press('Control+ArrowDown')
  await expect(page.locator(`#textarea-${ids[0]}`), "the query's item opened for editing and focused").toBeFocused()
  expect(await entries(page), 'no entry at the top').toEqual([length + 4, index + 4])
  await page.keyboard.press('Escape') // nothing edited: the editor closes
  await expect(page.locator(`#textarea-${ids[0]}`)).toBeHidden()
  // the pending query names a nested item NOT RENDERED under the current view (review 2 B3: beyond the
  // old hideIndex), listed below its tall context item once revealed, so it lands past the first viewport:
  // the flush's own layout sees no mover for it, the reveal renders it, and that layout would queue the
  // target scroll. The precedence holds for the settled query's layouts: the body's scrollTo is called
  // once (the explicit scroll) and the page is still at the top once the reveal has rendered
  await scrollDown(page)
  const far = await page.evaluate(
    ([dispatchArrow, leafId]) => {
      const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      t.focus({ preventScroll: true })
      t.setRangeText('ctx/leaf', 5, t.value.length, 'end') // '#e2e_scroll/a' -> '#e2e_ctx/leaf'
      t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'ctx/leaf' }))
      const pending = (window as any)._mindboxDebounced === true
      const rendered = !!document.querySelector(`#item-${leafId}`)
      const scrolls: number[] = ((window as any).__scrolls = [])
      const scrollTo = document.body.scrollTo.bind(document.body)
      document.body.scrollTo = ((x: number, y: number) => {
        scrolls.push(y)
        scrollTo(x, y)
      }) as typeof document.body.scrollTo
      eval(dispatchArrow)('ArrowUp')
      return { pending, rendered, value: t.value }
    },
    [dispatchArrow.toString(), leafId] as const
  )
  expect(far, 'the query was pending and its item not yet rendered when the key arrived').toEqual({ pending: true, rendered: false, value: '#e2e_ctx/leaf' })
  await nearTop(page, 'scrolled to the top with the nested query')
  expect(await entries(page)).toEqual([length + 6, index + 6])
  expect(await texts(index + 4)).toEqual(['#e2e_scroll/a', '#e2e_ctx/leaf', '#e2e_ctx/leaf'])
  await expect(page.locator(`#item-${leafId}`), 'the item revealed and rendered').toBeAttached()
  expect(
    await page.evaluate(([id, top]) => (document.getElementById(`super-container-${id}`) as HTMLElement).offsetTop > top + 700, [leafId, await headerTop(page)] as const),
    'the target sits past the first viewport, below its context item'
  ).toBe(true)
  await page.waitForTimeout(700) // time for the reveal's layout and its queued scroll; the assertions below are the check
  expect(await page.evaluate(() => (window as any).__scrolls.length), 'one body scroll: the explicit one').toBe(1)
  await nearTop(page, 'still at the top once the revealed item rendered')
  expect(await page.evaluate(() => history.state.scrollPosition)).toBe(await headerTop(page))
  await page.evaluate(() => delete (document.body as any).scrollTo) // the spy off: the prototype's method again
  // the next ORDINARY search is not suppressed: from the bottom of the far page, a typed unique query
  // whose item ranks first ends with the viewport moved up (the layout's target scroll; typing into the
  // offscreen MindBox and the page's new height can move it too, so this is a smoke check, not a
  // proof of the target scroll alone)
  await page.evaluate(() => document.body.scrollTo(0, document.body.scrollHeight))
  const bottom = await scrollTop(page)
  expect(bottom).toBeGreaterThan((await headerTop(page)) + 300)
  await focusMindboxInPlace(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('#e2e_scroll/c')
  await expect.poll(() => page.evaluate(() => history.state.editorText), { timeout: 10_000 }).toBe('#e2e_scroll/c')
  await expect.poll(() => scrollTop(page), { message: "the ordinary search's target scroll", timeout: 10_000 }).toBeLessThan(bottom - 100)
})

test('cmd/ctrl+arrows from the window scroll a scrolled page to the top with a history entry and focus the MindBox; the shown items stay', async ({
  page,
}) => {
  // the window's ⌘↑/⌃↑/⌘↓/⌃↓ (nothing focused) focused the MindBox and scrolled to the top with no
  // history entry, collapsing the expanded items on the way; scrolled down they now only scroll, with
  // the entry (review 0: the collapse contradicted "just scroll+focus"). At the top the reset stays,
  // and a plain ↑ keeps its own steps
  await loadAdmin(page)
  const expanded = await expand(page)
  const before = await scrollDown(page)
  const [length, index] = await entries(page)
  await blur(page)
  await page.keyboard.press('Control+ArrowUp')
  await nearTop(page, 'scrolled to the top')
  await expect(mindbox(page)).toBeFocused()
  expect(asSet(await visible(page)), 'the expanded items stay').toEqual(asSet(expanded))
  expect(await entries(page), 'one history entry pushed').toEqual([length + 1, index + 1])
  await page.goBack()
  await expect.poll(async () => Math.abs((await scrollTop(page)) - before) <= 2, { message: 'Back returns to the position' }).toBe(true)
  expect(asSet(await visible(page))).toEqual(asSet(expanded))
  await page.goForward()
  await nearTop(page, 'Forward returns to the top')
  expect(asSet(await visible(page))).toEqual(asSet(expanded))
  // a plain ↑ from the window keeps its documented steps and pushes no entry: on an expanded page it
  // hides the expanded items (no scroll), and with nothing left to hide it scrolls to the top and
  // focuses the MindBox, as before
  await scrollDown(page)
  await blur(page)
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => visible(page).then(v => v.length), { message: 'the expanded items hidden' }).toBeLessThan(expanded.length)
  expect(await entries(page), 'without an entry').toEqual([length + 1, index + 1])
  await blur(page)
  await page.keyboard.press('ArrowUp')
  await nearTop(page, 'a second plain arrow scrolls to the top')
  await expect(mindbox(page)).toBeFocused()
  expect(await entries(page), 'still without an entry').toEqual([length + 1, index + 1])
})

test('up with two modifiers scrolls to the top from every context, with a history entry and nothing else', async ({ page }) => {
  // the owner's global shortcut (2026-10-03): Up with two or more of Ctrl, Alt and Cmd scrolls a scrolled
  // page to the top with the history entry, from the window, the MindBox and an item editor alike, and
  // changes nothing else: no focus change, no reset of the expanded items, no edge jump (Down with two
  // modifiers is its inverse, the row below)
  await loadAdmin(page)
  const expanded = await expand(page)
  const [length, index] = await entries(page)
  // from the window: nothing focused before, nothing focused after
  await scrollDown(page)
  await blur(page)
  await page.keyboard.press('Control+Meta+ArrowUp')
  await nearTop(page, 'scrolled to the top from the window')
  await expect(mindbox(page), 'the MindBox not focused').not.toBeFocused()
  expect(asSet(await visible(page))).toEqual(asSet(expanded))
  expect(await entries(page)).toEqual([length + 1, index + 1])
  // from the MindBox, the caret at the start (the single-modifier edge jump's position): no history walk
  await scrollDown(page)
  await focusMindboxInPlace(page, 0)
  await page.keyboard.press('Control+Alt+ArrowUp')
  await nearTop(page, 'scrolled to the top from the MindBox')
  await expect(mindbox(page)).toBeFocused()
  await expect(mindbox(page)).toHaveValue('')
  expect(await entries(page)).toEqual([length + 2, index + 2])
  // from an item editor: a tall item of this row's own (newest, so first after the pinned items), its
  // editor opened by a click, closed with Escape and reopened with the Resume shortcut (⇧⌘S), which calls
  // the caret restore synchronously (restoreItemEditor: a focus and a measurement after two frames, then
  // the scroll after two more). The frames are HELD and released one at a time: the first phase runs, then
  // the explicit scroll and the press come in between, then the second phase runs and must yield (its
  // scroll undid the explicit one otherwise, pulling the page back to the editor). The editor keeps the
  // focus, no jump
  const globalText = '#e2e_global ' + Array.from({ length: 40 }, (_, i) => `global ${i + 1}`).join('\n\n')
  await page.evaluate(text => void window._create(text), globalText)
  await expect.poll(() => savedId(page, '#e2e_global'), { timeout: 30_000 }).toBeTruthy()
  const id = await page.evaluate(() => window._item('#e2e_global', true)!.id)
  await expect.poll(() => page.evaluate(id => !!document.querySelector(`#item-${id} p`), id), { timeout: 15_000 }).toBe(true)
  const paragraph = page.locator(`#item-${id} p`).first()
  await paragraph.scrollIntoViewIfNeeded()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  await expect(page.locator(`#textarea-${id}`)).toBeFocused()
  await page.keyboard.press('Escape') // nothing edited: the editor closes, the item is the last edited one
  await expect(page.locator(`#textarea-${id}`)).toBeHidden()
  await page.evaluate(() => {
    const held: FrameRequestCallback[] = ((window as any).__held = [])
    ;(window as any).__raf = window.requestAnimationFrame
    window.requestAnimationFrame = cb => held.push(cb)
  })
  // one frame: the callbacks held so far run, what they request waits for the next
  const frame = () =>
    page.evaluate(() => {
      const held: FrameRequestCallback[] = (window as any).__held
      const now = performance.now()
      for (const cb of held.splice(0)) cb(now)
    })
  await blur(page) // the Resume shortcut is the window's: nothing focused
  await page.keyboard.press('Shift+Meta+KeyS') // Resume: the editor reopens and the caret restore is dispatched
  await frame()
  await frame() // the first phase ran (the editor focused, the caret measured); the second awaits two more frames
  await expect(page.locator(`#textarea-${id}`)).toBeFocused()
  const [length3, index3] = await entries(page) // the item's creation and the resume pushed entries of their own
  await page.evaluate(
    ([id, top]) => {
      document.body.scrollTo(0, top + 600)
      const t = document.getElementById('textarea-' + id) as HTMLTextAreaElement
      t.setSelectionRange(1, 1)
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, altKey: true, bubbles: true, cancelable: true }))
    },
    [id, await headerTop(page)] as const
  )
  await nearTop(page, 'scrolled to the top from the item editor')
  // one REAL frame first: the browser dispatches the scroll event of the explicit scroll in its rendering
  // update, before frame callbacks, and the restore's cancel reads the time of that event (under a loaded
  // full gate the held frames were released before the event had been dispatched)
  await page.evaluate(() => new Promise<void>(resolve => (window as any).__raf.call(window, () => resolve())))
  await frame()
  await frame() // the second phase ran: its caret scroll must have yielded to the explicit scroll
  await page.evaluate(() => {
    window.requestAnimationFrame = (window as any).__raf
    const t = performance.now()
    for (const cb of ((window as any).__held as FrameRequestCallback[]).splice(0)) cb(t)
  })
  await page.waitForTimeout(300) // whatever the released frames scheduled; the assertions below are the check
  await nearTop(page, 'still at the top once the resume ran its deferred caret scroll')
  await expect(page.locator(`#textarea-${id}`), 'the editor keeps the focus').toBeFocused()
  expect(await entries(page)).toEqual([length3 + 1, index3 + 1])
  const after = await entries(page)
  // at the top a repeat (three modifiers) changes nothing: no entry, the focus kept
  await page.keyboard.press('Control+Alt+Meta+ArrowUp')
  await expect(page.locator(`#textarea-${id}`)).toBeFocused()
  expect(await entries(page)).toEqual(after)
  // a create/run deferred to the modifiers' release (Ctrl held through Enter) does not survive the
  // global arrow, like any other key (review 0 B2): Ctrl down, Enter, Alt down, Up, Alt up, Ctrl up
  // leaves the editor open with nothing saved or run
  const internal = (id: string) => page.evaluate(id => window.__items.find(item => item.id == id)!, id)
  expect((await internal(id)).savedText, 'the fixture saved as created').toBe(globalText)
  await page.keyboard.down('Control')
  await page.keyboard.press('Enter')
  await page.keyboard.down('Alt')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.up('Alt')
  await page.keyboard.up('Control')
  await expect(page.locator(`#textarea-${id}`), 'the editor still open and focused: nothing submitted').toBeFocused()
  expect([(await internal(id)).savedText, !!(await internal(id)).saving], 'nothing saved or running').toEqual([globalText, false])
  await page.keyboard.press('Escape') // nothing edited: the editor closes
  await expect(page.locator(`#textarea-${id}`)).toBeHidden()
})

test('down with two modifiers undoes a scroll to the top: Back to the position when the previous entry shows the same query below, nothing otherwise', async ({ page }) => {
  // the owner's inverse (2026-10-03): Up with two modifiers pushes the top entry (the row above); Down goes
  // Back when Back would scroll DOWN within the same query: the cursor returns to the previous entry without
  // adding one (the top entry stays reachable by Forward). Nothing when no entry sits below the position,
  // when the page scrolled past the position since the Up, or when the previous entry shows another query
  // (an arrow never changes the query, a typed query still debouncing included: review 0 B1); a second
  // press before the popstate lands is ignored; Up and Down in one turn work
  await loadAdmin(page)
  const expanded = await expand(page)
  const [length, index] = await entries(page)
  const up = () => page.keyboard.press('Control+Meta+ArrowUp')
  const down = () => page.keyboard.press('Control+Meta+ArrowDown')
  const atPosition = (y: number, message: string) =>
    expect.poll(async () => Math.abs((await scrollTop(page)) - y) <= 2, { message }).toBe(true)
  // from the window: Up then Down lands back at the position without a new entry (the length kept, Forward
  // still holding the top entry; the index back), nothing focused, the expanded items kept
  const pos = await scrollDown(page)
  await blur(page)
  await up()
  await nearTop(page, 'scrolled to the top')
  expect(await entries(page)).toEqual([length + 1, index + 1])
  await down()
  await atPosition(pos, 'back at the position')
  expect(await entries(page)).toEqual([length + 1, index])
  await expect(mindbox(page), 'the MindBox not focused').not.toBeFocused()
  expect(asSet(await visible(page))).toEqual(asSet(expanded))
  // no entry below the position: another Down changes nothing
  await down()
  await page.waitForTimeout(300)
  expect(await entries(page)).toEqual([length + 1, index])
  await atPosition(pos, 'still at the position')
  // the page scrolled past the position since the Up: Back would scroll up, so nothing
  await up()
  await nearTop(page, 'at the top again')
  expect(await entries(page)).toEqual([length + 1, index + 1])
  await page.evaluate(y => document.body.scrollTo(0, y), pos + 100)
  await expect.poll(() => scrollTop(page), { message: 'scrolled past the position' }).toBeGreaterThan(pos + 50)
  const past = await scrollTop(page)
  await down()
  await page.waitForTimeout(300)
  expect(await entries(page)).toEqual([length + 1, index + 1])
  await atPosition(past, 'still past the position')
  // another query since: the previous entry (the top entry, its position written below the new query's)
  // shows a different text, so nothing: the query and the entries stay
  await noWritePending(page)
  expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index].scrollPosition), 'the top entry holds the position scrolled to').toBeGreaterThan(pos + 50)
  await focusMindboxInPlace(page)
  await page.keyboard.type('#e2e')
  await expect.poll(() => entries(page), { message: 'the typed query pushed its entry' }).toEqual([length + 2, index + 2])
  // at the top of the new query: its entry is no Up's (and its text another), so Down does nothing
  await page.evaluate(y => document.body.scrollTo(0, y), await headerTop(page))
  await nearTop(page, 'at the top of the typed query')
  await down()
  await page.waitForTimeout(300)
  await expect(mindbox(page)).toHaveValue('#e2e')
  expect(await entries(page)).toEqual([length + 2, index + 2])
  // in the MindBox, on that query: Up then Down, the focus and the text kept
  const pos2 = await scrollDown(page)
  await focusMindboxInPlace(page, 4)
  await up()
  await nearTop(page, 'scrolled to the top from the MindBox')
  expect(await entries(page)).toEqual([length + 3, index + 3])
  await down()
  await atPosition(pos2, 'back at the position from the MindBox')
  expect(await entries(page)).toEqual([length + 3, index + 2])
  await expect(mindbox(page)).toBeFocused()
  await expect(mindbox(page)).toHaveValue('#e2e')
  // two Downs in one browser turn go back ONCE: the second lands before the popstate of the first and is
  // ignored (the pending guard), so the history walks one entry, not two
  await blur(page)
  await up()
  await nearTop(page, 'at the top before the double press')
  const before = await entries(page)
  await page.evaluate(() => {
    const press = () => new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(press())
    document.body.dispatchEvent(press())
  })
  await atPosition(pos2, 'back at the position once')
  await page.waitForTimeout(300)
  expect(await entries(page)).toEqual([before[0], before[1] - 1])
  await expect(mindbox(page)).toHaveValue('#e2e')
  // from an item editor: the editor keeps the focus through Up and Down, the page back at the position.
  // (The query is cleared at the top with the MindBox focused first: Playwright will not fill the
  // unfocused MindBox, whose textarea it reports as not visible)
  await up()
  await nearTop(page, 'at the top to clear the query')
  await focusMindboxInPlace(page)
  await mindbox(page).fill('')
  await expect.poll(() => mindbox(page).inputValue()).toBe('')
  // the Backs restored the entries' smaller show-more cut (onPopState keeps the larger of the query's default
  // and the entry's hideIndex): expand again so the newest item renders below the pinned ones
  await expand(page)
  const backText = '#e2e_back ' + Array.from({ length: 40 }, (_, i) => `back ${i + 1}`).join('\n\n')
  await page.evaluate(text => void window._create(text), backText)
  await expect.poll(() => savedId(page, '#e2e_back'), { timeout: 30_000 }).toBeTruthy()
  const id = await page.evaluate(() => window._item('#e2e_back', true)!.id)
  await expect.poll(() => page.evaluate(id => !!document.querySelector(`#item-${id} p`), id), { timeout: 15_000, message: 'the fixture renders among the expanded items' }).toBe(true)
  const paragraph = page.locator(`#item-${id} p`).first()
  await paragraph.scrollIntoViewIfNeeded()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  await expect(page.locator(`#textarea-${id}`)).toBeFocused()
  await page.evaluate(y => document.body.scrollTo(0, y), (await headerTop(page)) + 600)
  await expect.poll(() => scrollTop(page), { message: 'scrolled with the editor open' }).toBeGreaterThan((await headerTop(page)) + 300)
  const pos3 = await scrollTop(page)
  const [length4, index4] = await entries(page)
  await page.keyboard.press('Control+Alt+ArrowUp')
  await nearTop(page, 'scrolled to the top from the editor')
  expect(await entries(page)).toEqual([length4 + 1, index4 + 1])
  await expect(page.locator(`#textarea-${id}`)).toBeFocused()
  await page.keyboard.press('Control+Alt+ArrowDown')
  await atPosition(pos3, 'back at the position from the editor')
  await page.waitForTimeout(300) // whatever the restore scheduled; the assertions below are the check
  await atPosition(pos3, 'still at the position once the restore settled')
  expect(await entries(page)).toEqual([length4 + 1, index4])
  await expect(page.locator(`#textarea-${id}`), 'the editor keeps the focus').toBeFocused()
  await page.keyboard.press('Escape') // nothing edited: the editor closes
  await expect(page.locator(`#textarea-${id}`)).toBeHidden()
  // the quick combo: Up and Down dispatched in ONE browser turn (the owner: "a quick up-down combo should
  // work"): Up writes its predecessor and pushes the top entry synchronously, so the Down right after it
  // finds the pair; the page ends back at the position with the index where it started
  const pos4 = await scrollDown(page)
  await blur(page)
  const [, index5] = await entries(page)
  await page.evaluate(() => {
    const press = (key: string) => new KeyboardEvent('keydown', { key, code: key, metaKey: true, altKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(press('ArrowUp'))
    document.body.dispatchEvent(press('ArrowDown'))
  })
  await atPosition(pos4, 'back at the position after Up and Down in one turn')
  await page.waitForTimeout(300)
  // the Up truncated the Forward entry the editor part's Back had left, then pushed: the length is the
  // index plus two whatever it was before
  expect(await entries(page)).toEqual([index5 + 2, index5])
  // a query typed and still debouncing (review 0 B1): its live text is not in the entry yet, so a Down in the
  // same turn, with the entries still a qualifying pair (the top entry over the same query below), must NOT
  // go Back (Back would have restored the old query and discarded the typing); the typed text survives and
  // the debounce then records it in an entry of its own
  await up()
  await nearTop(page, 'at the top before typing')
  await focusMindboxInPlace(page)
  const [, index6] = await entries(page)
  const typed = await page.evaluate(() => {
    const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
    t.value = '#e2e pending'
    t.dispatchEvent(new Event('input', { bubbles: true }))
    const w = window as any
    const before = { pending: w._editor_change_pending as boolean, recorded: w._history[w._history_index].editorText as string, index: w._history_index as number }
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true }))
    return before
  })
  expect(typed, 'the precondition held in the turn: the query debouncing, the entry still the old text').toEqual({ pending: true, recorded: '', index: index6 })
  await page.waitForTimeout(300)
  // no Back: the index never drops below the top entry's (the debounce, 500 ms with the MindBox focused,
  // may already have pushed the typed query's own entry above it)
  expect((await entries(page))[1], 'no Back').toBeGreaterThanOrEqual(index6)
  await expect(mindbox(page), 'the typed text survives').toHaveValue('#e2e pending')
  await expect.poll(() => page.evaluate(() => (window as any)._history[(window as any)._history_index].editorText), { message: 'the debounce recorded the typed query' }).toBe('#e2e pending')
  await expect(mindbox(page)).toHaveValue('#e2e pending')
})

test('down with two modifiers, when Back does not apply, scrolls to the item the query names as a tag click does, with a history entry; nothing otherwise', async ({ page }) => {
  // the owner's fallback (2026-10-04): the query names an item (the listing item, the one a tag click
  // lands on) out of view, below or above: Down brings it to the upper middle of the view, as the tag
  // click's last step does, with an entry so Back returns to the position; the query, the caret, the
  // focus and the entries' texts stay. In view: nothing. The jump's entry is no Back candidate (Down undoes
  // an Up alone, the Back row), so a further Down does nothing and a scroll by hand brings the fallback again.
  // A short view, where the destination can equal the position: no entry (review 0 B1). A typed query not
  // yet applied: nothing (review 0 B2). A query naming no item: nothing. Each fallback press asserts its
  // premise, that Back does not apply (the previous entry another text, or a position not below)
  await loadAdmin(page)
  const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n\n')
  // the named item, tall, with two tall children under its tag, so the query's page scrolls well past it
  await page.evaluate(body => void window._create(`#e2e_named ${body}`), body)
  for (const n of ['p', 'q']) await page.evaluate(([n, body]) => void window._create(`#e2e_named/${n} ${body}`), [n, body] as const)
  await expect.poll(() => savedId(page, '#e2e_named/q'), { timeout: 30_000 }).toBeTruthy()
  const id = await page.evaluate(() => window._item('#e2e_named', true)!.id)
  const targeted = () =>
    expect.poll(() => page.evaluate(id => !!document.querySelector(`.super-container.target #item-${id}`), id), { timeout: 15_000 }).toBe(true)
  const down = () => page.keyboard.press('Control+Meta+ArrowDown')
  const up = () => page.keyboard.press('Control+Meta+ArrowUp')
  const atPosition = (y: number, message: string) =>
    expect.poll(async () => Math.abs((await scrollTop(page)) - y) <= 2, { message }).toBe(true)
  // the tag click's destination: the item's top less a quarter of the view, no higher than the header
  const destination = () =>
    page.evaluate(() => {
      const target = document.querySelector('.super-container.target') as HTMLElement
      return Math.max((document.querySelector('.header') as HTMLElement).offsetTop, target.offsetTop - visualViewport!.height / 4)
    })
  const targetTop = () => page.evaluate(() => (document.querySelector('.super-container.target') as HTMLElement).offsetTop)
  // the item below the view's lower band (the tag click's rule)
  const below = () => page.evaluate(() => (document.querySelector('.super-container.target') as HTMLElement).offsetTop > document.body.scrollTop + visualViewport!.height - 200)
  // the premise of a fallback press: Back does not apply (scrollBackWithHistory's test: the current entry an
  // Up's, the page still at its top)
  const noBack = () =>
    page.evaluate(() => {
      const w = window as any
      const current = w._history[w._history_index]
      const header = (document.querySelector('.header') as HTMLElement).offsetTop
      return !current?.scrolledToTop || document.body.scrollTop > header + 2
    })
  const selection = () =>
    page.evaluate(() => {
      const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      return [t.value, t.selectionStart, t.selectionEnd]
    })
  // the query from a fresh history: another query, Up (a final entry), then the query, pushed after it, so
  // the previous entry is another text and Back cannot apply whatever the positions
  // the app's bottom padding (0.85 of the view's height) follows a view change only while nothing is focused
  // (updateVerticalPadding under the resize handler, two unfocused passes), and shifts the position when it
  // does: settle it after a view change, before any position is measured
  const settleView = async (height: number) => {
    await blur(page)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            window.dispatchEvent(new Event('resize'))
            return parseFloat((document.querySelector('.items') as HTMLElement).style.paddingBottom || '0')
          }),
        { message: 'the padding follows the view', timeout: 10_000 }
      )
      .toBeCloseTo(0.85 * height, 0)
    await noWritePending(page)
  }
  const freshQuery = async () => {
    await focusMindboxInPlace(page)
    await mindbox(page).fill('#e2e_named/q')
    await expect.poll(() => page.evaluate(() => (window as any)._history[(window as any)._history_index].editorText), { timeout: 10_000 }).toBe('#e2e_named/q')
    await scrollDown(page)
    await up()
    await nearTop(page, 'a final entry at the top of the other query')
    await focusMindboxInPlace(page)
    await mindbox(page).fill('#e2e_named')
    await targeted()
    await expect.poll(() => page.evaluate(() => (window as any)._history[(window as any)._history_index].editorText), { timeout: 10_000 }).toBe('#e2e_named')
    expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index - 1].editorText), 'the previous entry is the other query').toBe('#e2e_named/q')
  }
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_named')
  await targeted()
  await noWritePending(page)
  const [length, index] = await entries(page)
  // in view (the query's own layout scrolled to its item; the item sits below the pinned items), the previous
  // entry another query: Down changes nothing
  const settled = await scrollTop(page)
  await focusMindboxInPlace(page, 4)
  expect(await noBack()).toBe(true)
  await down()
  await page.waitForTimeout(300)
  expect(await entries(page)).toEqual([length, index])
  await atPosition(settled, 'still where the query settled')
  // the item BELOW the view: from the top of the query's page, Down brings it to the upper middle with one
  // entry whose predecessor holds the top; the previous entry sits above, so the next Down is no Back
  // (the alternation holds after an upward jump alone) and, the item in view, nothing
  await page.evaluate(y => document.body.scrollTo(0, y), await headerTop(page))
  await nearTop(page, 'at the top of the query')
  await noWritePending(page)
  expect([await below(), await noBack()], 'the item below the view, no Back').toEqual([true, true])
  const dest = await destination()
  await down()
  await atPosition(dest, 'at the item, from above')
  expect(await entries(page)).toEqual([length + 1, index + 1])
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index), 'the top, kept in the previous entry').toBe(await headerTop(page))
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index + 1), 'the destination in the new entry').toBe(dest)
  expect(await page.evaluate(i => (window as any)._history[i].editorText, index + 1)).toBe('#e2e_named')
  expect(await selection(), 'the text and caret stay').toEqual(['#e2e_named', 4, 4])
  await expect(mindbox(page)).toBeFocused()
  expect(await noBack(), 'no Back after a downward jump').toBe(true)
  await down()
  await page.waitForTimeout(300)
  await atPosition(dest, 'still at the item: the item in view')
  expect(await entries(page)).toEqual([length + 1, index + 1])
  // scrolled PAST the item: Down brings it back up with an entry (the browser's Back returns to the position);
  // the entry is no Up's, so the next Down does nothing with the item in view (no toggle: the owner,
  // 2026-10-04); scrolled up by hand past the item, Down brings it back down, again with an entry
  const top = await targetTop()
  await page.evaluate(y => document.body.scrollTo(0, y), top + 400)
  await expect.poll(() => scrollTop(page), { message: 'scrolled past the item' }).toBeGreaterThan(top + 300)
  await noWritePending(page)
  const pos = await scrollTop(page)
  expect(await noBack(), 'no Back from past the item').toBe(true)
  await down()
  await atPosition(dest, 'at the item, as a tag click lands')
  expect(await entries(page)).toEqual([length + 2, index + 2])
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index + 1), 'the position left, kept in the previous entry').toBe(pos)
  expect(await noBack(), 'no Back after the jump: its entry is no Up\'s').toBe(true)
  await down()
  await page.waitForTimeout(300)
  await atPosition(dest, 'still at the item: no toggle')
  expect(await entries(page)).toEqual([length + 2, index + 2])
  await page.evaluate(y => document.body.scrollTo(0, y), await headerTop(page))
  await nearTop(page, 'scrolled up by hand, past the item')
  await noWritePending(page)
  expect([await below(), await noBack()], 'the item below the view, no Back').toEqual([true, true])
  await down()
  await atPosition(dest, 'at the item again, from above')
  expect(await entries(page)).toEqual([length + 3, index + 3])
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index + 2), 'the top, kept in the previous entry').toBe(await headerTop(page))
  // Back comes first: after Up, Down returns to the position Up left, not to the item; scrolled away from
  // that top by hand, the undo is gone and Down follows the fallback (the item below: to it, with an entry)
  await noWritePending(page)
  const pos2 = await scrollDown(page)
  expect(Math.abs(pos2 - dest), 'the position differs from the destination').toBeGreaterThan(50)
  await up()
  await nearTop(page, 'scrolled to the top')
  expect(await entries(page)).toEqual([length + 4, index + 4])
  expect(await noBack(), 'Back applies at the top of an Up').toBe(false)
  await down()
  await atPosition(pos2, 'Back to the position, not to the item')
  expect(await entries(page)).toEqual([length + 4, index + 3])
  await up()
  await nearTop(page, 'scrolled to the top again')
  await page.evaluate(y => document.body.scrollTo(0, y), (await headerTop(page)) + 60)
  await expect.poll(() => scrollTop(page), { message: 'scrolled away from the top by hand' }).toBeGreaterThan((await headerTop(page)) + 40)
  await noWritePending(page)
  expect([await below(), await noBack()], 'the item below the view, the undo gone').toEqual([true, true])
  await down()
  await atPosition(dest, 'at the item: the fallback, not Back')
  expect(await entries(page)).toEqual([length + 5, index + 5])
  // the jump's entry is never an Up's (review 0 B1): Up, then a 60 px scroll by hand and Down in ONE turn
  // (before the listener's write), so the fallback clones the still-marked Up entry; its entry carries no
  // mark, and back at the top by hand Down jumps to the item again instead of going Back to header + 60
  await up()
  await nearTop(page, 'at the top once more')
  const marked = await page.evaluate(() => (window as any)._history[(window as any)._history_index].scrolledToTop === true)
  expect(marked, "the Up's entry carries its mark").toBe(true)
  const marks = await page.evaluate(header => {
    const w = window as any
    document.body.scrollTo(0, header + 60)
    const before = w._history[w._history_index].scrolledToTop
    document
      .getElementById('textarea-mindbox')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true }))
    return { before, after: w._history[w._history_index].scrolledToTop, index: w._history_index }
  }, await headerTop(page))
  await atPosition(dest, 'at the item, from 60 px below the top in the same turn')
  expect(await entries(page), "the Up's entry and the jump's").toEqual([length + 7, index + 7])
  expect([marks.before, marks.after, marks.index], "the Up's entry marked, the jump's entry unmarked, in the key's turn").toEqual([true, false, index + 7])
  await noWritePending(page)
  await page.evaluate(y => document.body.scrollTo(0, y), await headerTop(page))
  await nearTop(page, 'back at the top by hand')
  await noWritePending(page)
  await down()
  await atPosition(dest, 'the item again, not Back to header + 60')
  expect(await entries(page)).toEqual([length + 8, index + 8])
  // a departure by hand ENDS the undo (review 0 B2): Up, a 60 px scroll by hand, the listener's write (the
  // mark cleared), back to the top by hand: Down is no Back to the position Up left but the fallback
  await up()
  await nearTop(page, 'at the top for the departure')
  await page.evaluate(header => document.body.scrollTo(0, header + 60), await headerTop(page))
  await expect.poll(() => scrollTop(page), { message: 'departed by hand' }).toBeGreaterThan((await headerTop(page)) + 40)
  await noWritePending(page)
  expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index].scrolledToTop), "the Up's mark cleared by the departure").toBe(false)
  await page.evaluate(y => document.body.scrollTo(0, y), await headerTop(page))
  await nearTop(page, 'back at the top by hand after the departure')
  await noWritePending(page)
  expect(await noBack(), 'the undo is gone').toBe(true)
  const [lengthD, indexD] = await entries(page)
  await down()
  await atPosition(dest, 'the fallback, not the position Up left')
  expect(await entries(page)).toEqual([lengthD + 1, indexD + 1])
  // a departure and a return both seen by the listener BEFORE its position write (review 1 B2 of
  // scroll_target2): the scroll events dispatched in one turn; the entry's mark is cleared at the departure
  // event itself, and Down in that turn is the fallback, its entry pushed, never a Back
  await up()
  await nearTop(page, 'at the top for the quick departure')
  const indexA = (await entries(page))[1] // the Up's entry, revisited below
  const quick = await page.evaluate(header => {
    const w = window as any
    const scroll = (y: number) => {
      document.body.scrollTo(0, y)
      document.body.dispatchEvent(new Event('scroll'))
    }
    scroll(header + 60)
    scroll(header)
    const mark = w._history[w._history_index].scrolledToTop
    const before = [w._history.length, w._history_index, document.body.scrollTop]
    document
      .getElementById('textarea-mindbox')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true }))
    return { mark, before, after: [w._history.length, w._history_index] }
  }, await headerTop(page))
  expect(quick.mark, 'the mark cleared at the departure event, before any position write').toBe(false)
  expect(quick.before[2], 'back at the top when the key arrived').toBeLessThanOrEqual((await headerTop(page)) + 2)
  expect(quick.after, 'the fallback pushed its entry, no Back').toEqual([quick.before[0] + 1, quick.before[1] + 1])
  await atPosition(dest, 'the fallback, from the top, after a departure and return in one turn')
  // the cleared mark belongs to the entry (review 2 B2 of scroll_target2): a later Up, then the browser's Back
  // twice, through the jump's entry back to the departed Up entry at its top: Down is the fallback, its entry
  // pushed (the cursor advances; a Back would have moved it down), not a return to the position that Up left
  await noWritePending(page)
  await up()
  await nearTop(page, 'a later Up')
  await page.goBack()
  await atPosition(dest, "Back to the jump's entry")
  await page.goBack()
  await nearTop(page, 'Back to the departed Up entry at its top')
  await noWritePending(page)
  expect(await page.evaluate(() => [(window as any)._history_index, (window as any)._history[(window as any)._history_index].scrolledToTop]), 'the departed entry revisited, its mark cleared').toEqual([indexA, false])
  await down()
  await atPosition(dest, 'the fallback from the revisited entry')
  expect(await entries(page), 'its entry pushed over the forward entries').toEqual([indexA + 2, indexA + 1])
  // the same departure and return, then the position write: the mark stays cleared, Down the fallback
  await noWritePending(page)
  await up()
  await nearTop(page, 'at the top for the persisted departure')
  await page.evaluate(header => {
    const scroll = (y: number) => {
      document.body.scrollTo(0, y)
      document.body.dispatchEvent(new Event('scroll'))
    }
    scroll(header + 60)
    scroll(header)
  }, await headerTop(page))
  await noWritePending(page)
  expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index].scrolledToTop), 'the mark cleared, through the write').toBe(false)
  const [lengthQ, indexQ] = await entries(page)
  await down()
  await atPosition(dest, 'the fallback after the persisted departure')
  expect(await entries(page)).toEqual([lengthQ + 1, indexQ + 1])
  // a query naming no item (a term the tall items carry): a long page, no target, so Down changes nothing
  await focusMindboxInPlace(page)
  await mindbox(page).fill('line')
  await expect.poll(() => page.evaluate(() => window.__items.filter(item => item.matching).length), { timeout: 10_000 }).toBeGreaterThan(2)
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.super-container.target')), { message: 'no target under the term', timeout: 10_000 }).toBe(false)
  await noWritePending(page)
  const pos3 = await scrollDown(page)
  const before = await entries(page)
  await down()
  await page.waitForTimeout(300)
  await atPosition(pos3, 'still at the position')
  expect(await entries(page)).toEqual(before)
  await expect(mindbox(page)).toHaveValue('line')
  // a SHORT view (review 0 B1): the in-view rule's lower band and the destination's quarter disagree there,
  // so at the destination the item still counts as below the view and the destination is the position: Down
  // moves nothing and pushes nothing (the precondition asserted, so an ordinary in-view no-op cannot stand in)
  await freshQuery()
  const size = page.viewportSize()!
  await page.setViewportSize({ width: size.width, height: 240 })
  await settleView(240)
  await focusMindboxInPlace(page)
  const top2 = await targetTop()
  await page.evaluate(y => document.body.scrollTo(0, y), top2 - 300)
  await expect.poll(() => scrollTop(page), { message: 'above the item in the short view' }).toBeLessThan(top2 - 200)
  await noWritePending(page)
  expect([await below(), await noBack()], 'the item below the short view, no Back').toEqual([true, true])
  const [length3, index3] = await entries(page)
  const dest3 = await destination()
  await down()
  await atPosition(dest3, 'at the item in the short view')
  expect(await entries(page)).toEqual([length3 + 1, index3 + 1])
  expect(await below(), 'the item still counts as below the short view at the destination').toBe(true)
  expect(Math.abs((await destination()) - (await scrollTop(page))), 'the destination is the position').toBeLessThanOrEqual(2)
  expect(await noBack(), 'no Back (the position left lies above)').toBe(true)
  await down()
  await page.waitForTimeout(300)
  await atPosition(dest3, 'unmoved')
  expect(await entries(page), 'no entry for a destination that is the position').toEqual([length3 + 1, index3 + 1])
  await page.setViewportSize(size)
  await settleView(size.height)
  // a typed query not yet applied (review 0 B2), the old target off screen: the input and Down in one browser
  // turn; the shortcut neither scrolls nor touches the history (the text guard), and the typed query then
  // settles with its own entry. The target is measured AFTER the view's restore (the padding's 408 px moved
  // it: review 1 B2, the row's third cut scrolled past a stale top and left the item in view), and the
  // premises are read in the same turn as the key: the target still the old item, above the position, its
  // destination well away from it, so the guard alone keeps the page
  const top3 = await targetTop()
  await page.evaluate(y => document.body.scrollTo(0, y), top3 + 400)
  await expect.poll(() => scrollTop(page), { message: 'past the item' }).toBeGreaterThan(top3 + 300)
  await noWritePending(page)
  const posP = await scrollTop(page)
  const [lengthP, indexP] = await entries(page)
  const typed = await page.evaluate(id => {
    const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
    t.focus({ preventScroll: true })
    t.setRangeText('/p', t.value.length, t.value.length, 'end')
    t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '/p' }))
    const w = window as any
    const pending = w._mindboxDebounced === true
    const recorded = w._history[w._history_index].editorText
    const target = document.querySelector('.super-container.target') as HTMLElement
    const scrollTop = document.body.scrollTop
    const destination = Math.max((document.querySelector('.header') as HTMLElement).offsetTop, target.offsetTop - visualViewport!.height / 4)
    const premises = {
      oldTarget: !!target.querySelector(`#item-${id}`),
      above: target.offsetTop < scrollTop,
      destinationAway: Math.abs(destination - scrollTop) > 50,
    }
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true }))
    return { pending, recorded, premises, live: t.value, scrollTop: document.body.scrollTop, length: w._history.length, index: w._history_index }
  }, id)
  expect(typed.premises, 'the old target, above the position, its destination away from it').toEqual({ oldTarget: true, above: true, destinationAway: true })
  expect(typed.pending, 'the query was still debouncing when the key arrived').toBe(true)
  expect([typed.recorded, typed.live], 'the entry holds the old text, the MindBox the new').toEqual(['#e2e_named', '#e2e_named/p'])
  expect([typed.scrollTop, typed.length, typed.index], 'the shortcut scrolled nothing and touched no entry').toEqual([posP, lengthP, indexP])
  await expect.poll(() => page.evaluate(() => (window as any)._history[(window as any)._history_index].editorText), { message: 'the typed query settled', timeout: 10_000 }).toBe('#e2e_named/p')
  await expect(mindbox(page)).toHaveValue('#e2e_named/p')
})

test('a dangling relative tag neither ranks an item up nor counts as missing; an absolute missing tag still does both', async ({ page }) => {
  // the owner's report (2026-10-04): a chat child carrying `#//why_each_row`, a sibling no item has, kept
  // surfacing at the top of the list, as if its time were updated: the dangling tag sat in missingTags,
  // which ranks items by their count just before the time and gives them show-more prominence. The split
  // (index.svelte updateMissingTags): a resolved tag no item carries is DANGLING when every occurrence is
  // a relative token (danglingTags: the faded mark and nothing else) and MISSING when an absolute token
  // names it (missingTags: the red mark, the error border, the rank)
  await loadAdmin(page)
  const create = async (text: string, name: string) => {
    await page.evaluate(t => void window._create(t), text)
    await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
  }
  await create('#e2e_rank_c absolute #e2e_missing_rank', '#e2e_rank_c') // the oldest of the three: a missing absolute tag
  await create('#e2e_rank_a sibling #//nowhere_rank and #///nope', '#e2e_rank_a') // older than b: a dangling relative tag (a root's sibling: `#nowhere_rank`) and a token no label resolves
  await create('#e2e_rank_b plain', '#e2e_rank_b') // the newest, nothing missing
  const state = (name: string) =>
    page.evaluate(name => {
      const item = ((window as any).__items as any[]).find(item => item.label == name)!
      return { missing: item.missingTags, dangling: item.danglingTags }
    }, name)
  await expect.poll(() => state('#e2e_rank_a'), { message: 'a: dangling, not missing' }).toEqual({ missing: [], dangling: ['#nowhere_rank'] })
  expect(await state('#e2e_rank_c'), 'c: missing').toEqual({ missing: ['#e2e_missing_rank'], dangling: [] })
  expect(await state('#e2e_rank_b')).toEqual({ missing: [], dangling: [] })
  // the shown order: the missing one first (promoted over newer items), then by time, b before a (the old
  // state promoted a too, above c by time). The newest items sit behind the show-more cut while prominent
  // items fill it (c is pulled in by its prominence): expand until all three show
  const names = ['#e2e_rank_c', '#e2e_rank_b', '#e2e_rank_a']
  const showAll = async () => {
    for (let i = 0; i < 4; i++) {
      const shown = await visible(page)
      if (names.every(n => shown.includes(n)) || !(await page.locator('.toggle.show').count())) return shown
      await expand(page)
    }
    return visible(page)
  }
  const order = await showAll()
  const at = (name: string) => order.indexOf(name)
  expect(names.every(n => at(n) >= 0), `all three shown: ${order.join(' ')}`).toBe(true)
  expect(at('#e2e_rank_c'), 'the missing tag promotes c').toBeLessThan(at('#e2e_rank_b'))
  expect(at('#e2e_rank_b'), 'the dangling tag does not promote a over the newer b').toBeLessThan(at('#e2e_rank_a'))
  // the marks and borders: a's faded dangling marks with the tokens as written (the sibling resolved by the
  // shared resolver to `#nowhere_rank`, as the item's tags are, not to a child of a; the unresolvable `#///nope`
  // dangling too) and no error border; c's red missing mark with the border
  const marks = (name: string) =>
    page.evaluate(name => {
      const elem = window._item(name, true)!.elem!
      return {
        marks: [...elem.querySelectorAll('.content mark:not(.label)')].map(m => [m.textContent, m.className]),
        error: !!elem.querySelector('.container.error'),
      }
    }, name)
  await expect.poll(() => marks('#e2e_rank_a'), { message: "a's marks" }).toEqual({ marks: [['#//nowhere_rank', 'dangling'], ['#///nope', 'dangling']], error: false })
  await expect.poll(() => marks('#e2e_rank_c'), { message: "c's marks" }).toEqual({ marks: [['e2e_missing_rank', 'missing']], error: true })
  // once a sibling named #nowhere_rank exists, a's tag is carried: the mark goes live, nothing dangling
  await create('#nowhere_rank now here', '#nowhere_rank')
  await expect.poll(() => state('#e2e_rank_a')).toEqual({ missing: [], dangling: [] })
  await showAll() // the layout re-ran: a may sit behind the cut again
  await expect.poll(() => marks('#e2e_rank_a').then(m => m.marks)).toEqual([['nowhere_rank', ''], ['#///nope', 'dangling']])
})

test("ctrl+arrows in a tall item bring the caret's edge into view", async ({ page }) => {
  // the textarea is as tall as its text, so the caret moved to the start or end sits at its top or
  // bottom edge, possibly far outside the viewport: the Ctrl move brings that edge into view (review 0
  // B1 of arrow_edges: a plain scroll, no history entry; the next press is still the edge jump)
  await loadAdmin(page)
  const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n\n')
  await page.evaluate(body => void window._create(`#e2e_tall/pad ${body}`), body) // a child of the item, for the page to continue below the editor
  await expect.poll(() => savedId(page, '#e2e_tall/pad'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(body => void window._create(`#e2e_tall ${body}`), body)
  await expect.poll(() => savedId(page, '#e2e_tall'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(() => (window as any).MindBox.set('#e2e_tall', { scroll: true }))
  const id = await page.evaluate(() => window._item('#e2e_tall', true)!.id)
  await expect.poll(() => page.evaluate(id => !!document.querySelector(`#item-${id} p`), id), { timeout: 15_000 }).toBe(true)
  const paragraph = page.locator(`#item-${id} p`).nth(30)
  await paragraph.scrollIntoViewIfNeeded()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  const textarea = page.locator(`#textarea-${id}`)
  await expect(textarea).toBeFocused()
  // the caret in the middle of the text, the textarea's edges both outside the viewport
  const rect = () => page.evaluate(id => {
    const r = document.getElementById(`textarea-${id}`)!.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, height: innerHeight }
  }, id)
  await page.evaluate(id => {
    const t = document.getElementById(`textarea-${id}`) as HTMLTextAreaElement
    t.setSelectionRange(Math.floor(t.value.length / 2), Math.floor(t.value.length / 2))
    const r = t.getBoundingClientRect()
    document.body.scrollBy(0, r.top + r.height / 2 - innerHeight / 2) // the middle of the textarea mid-viewport
  }, id)
  const before = await rect()
  expect(before.top < 0 && before.bottom > before.height, 'both edges outside the viewport').toBe(true)
  const [length] = await entries(page)
  await page.keyboard.press('Control+ArrowUp')
  await expect(textarea).toBeFocused()
  // within a pixel: scrollIntoView lands on a fractional scroll position (-0.44 px seen)
  await expect.poll(async () => (await rect()).top, { message: 'the top edge in view' }).toBeGreaterThanOrEqual(-1)
  expect((await rect()).top).toBeLessThan(before.height)
  expect(await page.evaluate(id => (document.getElementById(`textarea-${id}`) as HTMLTextAreaElement).selectionEnd, id)).toBe(0)
  await page.keyboard.press('Control+ArrowDown')
  await expect(textarea).toBeFocused()
  await expect.poll(async () => (await rect()).bottom, { message: 'the bottom edge in view' }).toBeLessThanOrEqual(before.height + 1)
  expect((await rect()).bottom).toBeGreaterThan(0)
  expect(await page.evaluate(id => {
    const t = document.getElementById(`textarea-${id}`) as HTMLTextAreaElement
    return t.selectionStart == t.value.length
  }, id)).toBe(true)
  expect((await entries(page))[0], 'plain scrolls: no history entry').toBe(length)
  // the editor left ENTIRELY past a boundary (review 1): below the viewport after a scroll to the top,
  // ⌃↑ brings its top edge back; above the viewport after a scroll to the bottom, ⌃↓ brings its bottom
  // edge back. The child is hidden past hideIndex while editing, so it is shown through the toggle first
  // (the click leaves the editor open; it is refocused in place), which keeps the page scrollable past the editor
  await page.evaluate(top => document.body.scrollTo(0, top), await headerTop(page))
  expect((await rect()).top, 'the editor entirely below the viewport').toBeGreaterThan(before.height)
  await expect(textarea).toBeFocused()
  await page.keyboard.press('Control+ArrowUp')
  await expect.poll(async () => (await rect()).top, { message: 'the top edge back in view' }).toBeLessThan(before.height)
  expect((await rect()).top).toBeGreaterThanOrEqual(-1)
  await page.locator('.toggle.show').first().click()
  await expect
    .poll(() => page.evaluate(() => !!document.querySelector(`#super-container-${window._item('#e2e_tall/pad', true)!.id}`)), { timeout: 15_000 })
    .toBe(true)
  await page.evaluate(id => (document.getElementById(`textarea-${id}`) as HTMLTextAreaElement).focus({ preventScroll: true }), id)
  await expect(textarea).toBeFocused()
  await page.evaluate(() => document.body.scrollTo(0, document.body.scrollHeight))
  expect((await rect()).bottom, 'the editor entirely above the viewport').toBeLessThan(0)
  await page.keyboard.press('Control+ArrowDown')
  await expect.poll(async () => (await rect()).bottom, { message: 'the bottom edge back in view' }).toBeGreaterThan(0)
  expect((await rect()).bottom).toBeLessThanOrEqual(before.height + 1)
  expect((await entries(page))[0], 'still no history entry').toBe(length)
  await page.keyboard.press('Escape') // nothing edited: the editor closes
  await expect(textarea).toBeHidden()
})

test('no link on the page shows a focus ring', async ({ page }) => {
  // the ring showed on a link after the window returned from another app (the owner, 2026-09-29);
  // the rule is the page's, so an ordinary link of an item and one outside every item lose it alike
  await loadAdmin(page)
  await page.evaluate(() => void window._create('#e2e_link_ring see [the proposal](https://example.com/proposal)'))
  await expect.poll(() => savedId(page, '#e2e_link_ring'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(() => (window as any).MindBox.set('#e2e_link_ring', { scroll: true }))
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_link_ring', true)?.elem?.querySelector('a[href*="example.com"]')), { timeout: 15_000 }).toBe(true)
  const rings = await page.evaluate(() => {
    const ring = (a: HTMLAnchorElement) => {
      a.focus()
      return [document.activeElement === a, getComputedStyle(a).outlineStyle]
    }
    const inItem = window._item('#e2e_link_ring', true)!.elem!.querySelector('a[href*="example.com"]') as HTMLAnchorElement
    const outside = document.body.appendChild(Object.assign(document.createElement('a'), { href: 'https://example.com/outside', textContent: 'outside' }))
    const result = { inItem: ring(inItem), outside: ring(outside) }
    outside.remove()
    return result
  })
  expect(rings).toEqual({ inItem: [true, 'none'], outside: [true, 'none'] })
})
