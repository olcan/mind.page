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
    // a focus and a blur within the restore's delay (the full gate of 2026-10-28: the steps between a
    // restore and the next minimize took less than 250 ms): the restore the focus armed must not fire
    // into the page without the system focus, where a focus is silent and left the textarea active and
    // visible behind the unfocused paint for good; the box is restored at the next focus instead. The
    // interval is HELD, not timed (lane_races review 0): the restore's timer, the one 250 ms timer the
    // window focus arms, is captured, so the blur finds it pending whatever the run's pace and must drop
    // it (the app without the drop keeps it, and released it would focus the box silently), and with
    // nothing else focused at that blur the element recorded at the first blur is kept for the next focus.
    // The focus may arm another 250 ms timer (a listener item's _on_focus, the instance update; one run
    // captured two) and the page's own periodic work (expandMacros, rescheduled every 250 ms) may add a held
    // timer at any moment, so the assertion is the count of held timers a clearTimeout REMOVED (lane_races
    // review 2 B1: a queue length read twice is not that count), and the release shows the box unfocused
    const holdRestore = () =>
      page.evaluate(() => {
        const w = window as any
        const held: { id: number; cb: () => void }[] = (w.__heldRestore = [])
        w.__droppedRestore = 0
        const setTimeout_ = (w.__setTimeout = window.setTimeout)
        const clearTimeout_ = (w.__clearTimeout = window.clearTimeout)
        w.__fakeTimerId ??= 1 << 30 // unique across the row's holds (a stale id cleared later must match nothing held)
        ;(window as any).setTimeout = (cb: () => void, ms?: number, ...args: unknown[]) =>
          ms == 250 ? (held.push({ id: ++w.__fakeTimerId, cb }), w.__fakeTimerId) : setTimeout_(cb, ms, ...args)
        ;(window as any).clearTimeout = (id?: number) => {
          const i = held.findIndex(h => h.id == id)
          if (i >= 0) {
            held.splice(i, 1)
            w.__droppedRestore++
          } else clearTimeout_(id)
        }
      })
    const heldRestores = () => page.evaluate(() => (window as any).__heldRestore.length as number)
    const droppedRestores = () => page.evaluate(() => (window as any).__droppedRestore as number)
    const activeIs = (selector: string) => page.evaluate(selector => (document.activeElement as HTMLElement | null)?.matches(selector) ?? false, selector)
    // the hold ends: the wrappers removed, whatever is still captured fires
    const releaseRestore = () =>
      page.evaluate(() => {
        const w = window as any
        window.setTimeout = w.__setTimeout
        window.clearTimeout = w.__clearTimeout
        const late = w.__heldRestore.splice(0) as { cb: () => void }[]
        late.forEach(h => h.cb())
        return late.length
      })
    await focusMindbox(page)
    await away() // the box recorded at this blur
    await expect.poll(painted, { message: 'the box after the blur before the quick switch' }).toEqual(unfocused)
    // a pre-existing timer may add another held timer (expandMacros reschedules itself every 250 ms); the
    // removal count below is independent of that growth. The planted callback is an opportunistic
    // perturbation of that kind: this row does not assert when it fires (before the wrapper, between the
    // readings or after the release), only that the count stays right whenever it does
    await page.evaluate(() => setTimeout(() => setTimeout(() => {}, 250), 30))
    await holdRestore()
    await back() // the window focus arms the restore: captured
    const armed = await heldRestores()
    await away() // within the delay by construction
    expect([armed >= 1, await droppedRestores()], 'the focus armed the restore and the blur within the delay removed one held timer').toEqual([true, 1])
    await releaseRestore() // anything else held fires now: not the restore, or the box would be focused silently
    expect(await painted(), 'the box after a focus and a blur within the restore delay').toEqual(unfocused)
    await back() // the recorded box, kept through the quick switch, restored at this focus
    await expect.poll(painted, { message: 'the box restored at the focus after the quick switch' }).toEqual(focused)
    await page.keyboard.press('Escape')
    await expect(mindbox(page)).not.toBeFocused()
    expect(await painted(), 'the box blurred after the quick switch').toEqual(unfocused)
    // another element focused before the quick blur replaces the recorded box: the next focus restores it,
    // not the box. The button keeps its native active state through the system blur (a visible focusable
    // element, unlike the box, which the component hides), so it is blurred while the page is away and the
    // next focus's restore is held and released: the button active afterwards is the restore's doing, not a
    // state that never left (review 2 B2); the app without the replacing branch restores the box here
    await focusMindbox(page)
    await away()
    await expect.poll(painted, { message: 'the box after the blur before the replacing switch' }).toEqual(unfocused)
    await holdRestore()
    await back()
    const other = await page.evaluate(() => {
      const button = document.querySelector('.header .button') as HTMLElement
      button.tabIndex = -1
      button.focus() // a real focus: the page has the system focus
      return document.activeElement === button
    })
    expect(other, 'the premise: another element focused').toBe(true)
    await away() // the blur records the button in the box's place and drops the pending restore
    expect(await droppedRestores(), 'the restore dropped at this blur too').toBe(1)
    await releaseRestore()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()) // silent while away: the recorded element stays
    expect(await activeIs('body'), 'the premise: nothing active while away').toBe(true)
    await holdRestore()
    await back() // the restore armed: held
    expect(await activeIs('body'), 'nothing focused before the restore').toBe(true)
    await releaseRestore() // the restore fires now
    expect(await activeIs('.header .button'), 'the restore brought the button back, not the box').toBe(true)
    expect(await painted(), 'the box not restored: the other element replaced it').toEqual(unfocused)
    await page.evaluate(() => {
      const button = document.activeElement as HTMLElement
      button.blur()
      button.removeAttribute('tabindex')
    })
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

// A CLICK ON AN ITEM'S NUMBER (the owner, 2026-11-18; the decisions' own table is tests/unit/number_click.spec.ts).
// The number is green while its item matches the query, and that state says what a plain click does: on a
// green number it moves the item (its time set to now and saved), as every plain click did before; on a
// plain one it SELECTS the item, which an unnamed item had no good way to be: the query becomes the item's
// label when that is unique, else its id reference by its SAVED id (the one an address resolves after a
// reload or in another tab), in a history entry of its own, final like a tag's click, with the place the
// page is left at, and no save is asked for. Shift+click selects whatever the number shows; Option and Cmd
// move as before, under both views; a #log item's question comes before a move and before no select. The
// fixtures are deleted at the end
test("a click on an item's number selects the item while the number is plain and moves it up while it is green; shift+click always selects, option and cmd move as before, and a log item asks only before a move", async ({ page, browser }) => {
  await loadAdmin(page)
  const QUESTION = 'confirm: Modify time for #log item?\ncreation time/ordering will be lost'
  const dialogs: string[] = []
  page.on('dialog', dialog => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`)
    void dialog.dismiss() // the question declined: nothing moves
  })
  const TAG = '#e2e_number_tag'
  const NAMED = '#e2e_number_named'
  // two items that share a label, as the owner's todos share `#todo`: neither is named by it, and under the
  // label's view both match and rank by their times alone
  const texts = [
    'e2e_number_plain an unnamed item',
    `${NAMED} a named item`,
    `${TAG} e2e_number_shared one of two items that share a label`,
    `${TAG} e2e_number_shared the other of the two`,
    '#log e2e_number_log an entry',
  ]
  for (const text of texts) await page.evaluate(text => void window._create(text), text)
  const fixtures = () => page.evaluate(() => (window as any).__items.filter((item: any) => item.text.includes('e2e_number_')).map((item: any) => !!item.savedId && !item.saving))
  await expect.poll(fixtures, { message: 'the five fixtures are saved', timeout: 30_000 }).toEqual([true, true, true, true, true])
  const idOf = (start: string) => page.evaluate(start => window._items().find(item => item.text.startsWith(start))!.id, start)
  const [plain, named, taggedA, taggedB, log] = [await idOf(texts[0]), await idOf(texts[1]), await idOf(texts[2]), await idOf(texts[3]), await idOf(texts[4])]
  // the id an address can name is the document's: an item created in this tab has one of its own beside it
  const savedOf = (id: string) => page.evaluate(id => (window as any).__items.find((item: any) => item.id == id).savedId as string, id)
  const [savedPlain, savedNamed, savedLog] = [await savedOf(plain), await savedOf(named), await savedOf(log)]
  expect(savedPlain, "the tab's own id of an item created in it is not its saved id").not.toBe(plain)
  // an item as the row reads it: its rank, its times, the saves asked of it so far, and what the query makes of it
  const read = (id: string) =>
    page.evaluate(id => {
      const item = (window as any).__items.find((item: any) => item.id == id)
      return { index: item.index as number, time: item.time as number, savedTime: item.savedTime as number, saves: (item.saveSeq ?? 0) as number, saving: !!item.saving, target: !!item.target, matching: !!item.matching }
    }, id)
  const timeAt = (index: number) => page.evaluate(index => (window as any).__items[index].time as number, index)
  const number = (id: string) => page.locator(`.container[data-item-id="${id}"] .item-menu > .index`)
  // the first view shows the items above its fold and offers the session's own under its first toggle,
  // which is opened where a fixture's number is not on the page
  const reveal = async (id: string) => {
    if (!(await number(id).count())) await page.locator('.toggle.show').first().click()
    await expect(number(id)).toBeVisible()
  }
  const entry = () => page.evaluate(() => [history.state.index, history.state.editorText, history.state.final])
  const recorded = () =>
    expect
      .poll(() => page.evaluate(() => !(window as any)._history_update_pending && (window as any)._history[(window as any)._history_index].scrollPosition === document.body.scrollTop), { message: "the entry holds the page's position" })
      .toBe(true)
  // a move, once its save is done: the item's time, saved by one more save
  const moved = (id: string, before: { saves: number }) =>
    expect.poll(async () => (({ time, savedTime, saves, saving }) => (savedTime == time && !saving && saves == before.saves + 1 ? time : 'not saved'))(await read(id)), { timeout: 30_000 })

  await test.step('the first view: a plain number selects its item, by its saved id, which another tab resolves; Back returns to the view at its place, also when the page was scrolled right before the select', async () => {
    await expect(mindbox(page)).toHaveValue('')
    // the view left below the header with the number in sight, its place recorded on the entry
    await reveal(plain)
    await number(plain).scrollIntoViewIfNeeded()
    // where the mouse will press the number, once the page is still around it (the items the toggle
    // revealed render in steps): the same place twice, 250 ms apart, with nothing over it
    const point = async () => (box => (box ? [box.x + box.width / 2, box.y + box.height / 2] : null))(await number(plain).boundingBox())
    let last = ''
    await expect
      .poll(
        async () => {
          const at = await point()
          const hit = !!at && (await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.item-menu > .index'), at))
          const now = JSON.stringify([at, await scrollTop(page)])
          const still = hit && now == last
          last = now
          return still
        },
        { message: 'the number is in sight, with nothing over it, and the page is still', intervals: [250] },
      )
      .toBe(true)
    await recorded()
    const left = await scrollTop(page)
    expect(left, 'the first view is left below the header').toBeGreaterThan(await headerTop(page))
    await expect(number(plain), 'no query: the number is plain').not.toHaveClass(/matching/)
    const before = await read(plain)
    const [index] = await entry()
    // the press is the mouse's, where the number is: the driver's own click() scrolls its target first when
    // it finds it covered or moving, and that scroll is recorded on the entry the click is about to leave
    const [x, y] = (await point())!
    await page.mouse.click(x, y)
    await expect(mindbox(page), 'the box holds the id reference of an unnamed item, by its saved id').toHaveValue(`id:${savedPlain}`)
    expect(await read(plain), 'the item is the target, and no save was asked of it').toMatchObject({ target: true, savedTime: before.savedTime, saves: before.saves, saving: false })
    expect(await entry(), "an entry of its own, final like a tag's click").toEqual([index + 1, `id:${savedPlain}`, true])
    await expect(number(plain), 'the selected item matches the query: its number is green').toHaveClass(/matching/)
    // the address names the item for another tab of another profile, as for a reload: both read the documents' ids
    expect(await page.evaluate(() => location.hash)).toBe('#' + savedPlain)
    const other = await (await browser.newContext()).newPage()
    await loadAdmin(other)
    await other.goto(page.url())
    await other.reload()
    await waitForApp(other)
    await expect.poll(() => other.evaluate(() => (window as any).__items.find((item: any) => item.target)?.text ?? null), { message: 'the address resolves to the item', timeout: 30_000 }).toBe(texts[0])
    await other.context().close()
    await recorded()
    await page.goBack()
    await expect(mindbox(page), 'Back returns to the first view').toHaveValue('')
    await expect.poll(async () => Math.abs((await scrollTop(page)) - left) <= 2, { message: 'at the place it was left' }).toBe(true)
    expect([(await entry())[0], (await read(plain)).time], "the entry before, and the select's soft touch undone").toEqual([index, before.time])
    // scrolled and selected in one turn of the page, inside the 250 ms the scroll listener waits before it
    // writes: the entry being left holds the place from before the scroll, and the select writes the live one
    await recorded()
    const scrolled = await page.evaluate(
      ([id, left]) => {
        const max = document.body.scrollHeight - innerHeight
        document.body.scrollTo(0, left + 48 <= max ? left + 48 : left - 48)
        const top = document.body.scrollTop
        ;(window._item(id as string) as any).select()
        return top
      },
      [plain, left] as const,
    )
    expect(Math.abs(scrolled - left), 'the page was scrolled away from the place recorded').toBeGreaterThan(40)
    await expect(mindbox(page)).toHaveValue(`id:${savedPlain}`)
    await page.goBack()
    await expect(mindbox(page)).toHaveValue('')
    await expect.poll(async () => Math.abs((await scrollTop(page)) - scrolled) <= 2, { message: 'Back returns to the place the page was scrolled to right before the select' }).toBe(true)
    expect(dialogs).toEqual([])
  })

  await test.step('a named item is selected by its label', async () => {
    await reveal(named)
    const before = await read(named)
    await number(named).click()
    await expect(mindbox(page), 'the box holds the unique label').toHaveValue(NAMED)
    expect(await read(named)).toMatchObject({ target: true, savedTime: before.savedTime, saves: before.saves })
    await page.goBack()
    await expect(mindbox(page)).toHaveValue('')
  })

  await test.step("a name typed into the box and its item selected before the query applies (item code's select, as a todo's row makes it): the select applies at once, in an entry of its own, and the box gives up the focus", async () => {
    // A: the plain item's view as a typed query's entry, which is not final (a typed update of the query replaces it)
    await page.evaluate(name => void (window as any).MindBox.set(name), `id:${savedPlain}`)
    await expect.poll(async () => (await read(plain)).target).toBe(true)
    const [index, , final] = await entry()
    expect(final, "A's entry is a typed query's: not final").toBe(false)
    await focusMindboxInPlace(page)
    await expect(mindbox(page)).toBeFocused()
    // B's exact name typed (the input event a key or a paste makes) and B selected, in one turn of the page
    const turn = await page.evaluate(
      ([id, name]) => {
        const w = window as any
        const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
        box.value = name
        box.dispatchEvent(new Event('input'))
        const pending = w._editor_change_pending as boolean
        const selected = w._item(id).select() as boolean
        const target = !!w.__items.find((item: any) => item.id == id).target
        return { pending, selected, target, still: w._editor_change_pending as boolean, focused: document.activeElement == box, entry: [history.state.index, history.state.editorText, history.state.final] }
      },
      [named, NAMED],
    )
    expect(turn, 'the typed name was pending; the select applied at once: B the target, the debounce disarmed, the box blurred, an entry of its own').toEqual({ pending: true, selected: true, target: true, still: false, focused: false, entry: [index + 1, NAMED, true] })
    await page.goBack()
    await expect(mindbox(page), 'Back reaches A').toHaveValue(`id:${savedPlain}`)
    await page.evaluate(() => void (window as any).MindBox.set(''))
    await expect(mindbox(page)).toHaveValue('')
  })

  await test.step("a tag's view: a green number moves its item up and keeps the query; shift+click selects, in an entry of its own", async () => {
    await page.evaluate(tag => void (window as any).MindBox.set(tag), TAG)
    await expect(number(taggedA), 'the items under the label match the query: green').toHaveClass(/matching/)
    await expect(number(taggedB)).toHaveClass(/matching/)
    const [tagIndex, , final] = await entry()
    expect(final, "the tag's view is a typed query's entry here: not final, so a select that was not forced would replace it").toBe(false)
    // the lower of the two is moved up
    const [upper, lower] = (await read(taggedA)).index < (await read(taggedB)).index ? [taggedA, taggedB] : [taggedB, taggedA]
    const before = await read(lower)
    await number(lower).click()
    await moved(lower, before).toBeGreaterThan(before.time)
    expect((await read(lower)).index, 'the item moved above the other').toBeLessThan((await read(upper)).index)
    expect([await mindbox(page).inputValue(), (await entry())[0]], 'the query is unchanged, in the same entry').toEqual([TAG, tagIndex])
    // shift+click on the other green number
    const other = await read(upper)
    const name = `id:${await savedOf(upper)}`
    await number(upper).click({ modifiers: ['Shift'] })
    await expect(mindbox(page), 'shift+click selects under a green number').toHaveValue(name)
    expect(await read(upper), 'the item is the target, and nothing of it was saved').toMatchObject({ target: true, savedTime: other.savedTime, saves: other.saves })
    expect(await entry(), "in an entry of its own: the tag's view is kept behind it").toEqual([tagIndex + 1, name, true])
    expect(await page.evaluate(() => getSelection()!.toString()), 'shift+click selected no text on the page').toBe('')
    await page.goBack()
    await expect(mindbox(page), "Back returns to the tag's view").toHaveValue(TAG)
    await expect(number(lower)).toHaveClass(/matching/)

    // Option: one place down (the time just under the next item's); Cmd: one place up again
    const top = await read(lower)
    const next = await timeAt(top.index + 1)
    await number(lower).click({ modifiers: ['Alt'] })
    await moved(lower, top).toBe(next - 1)
    const down = await read(lower)
    expect(down.index, 'option+click moved the green item one place down').toBe(top.index + 1)
    const previous = await timeAt(down.index - 1)
    await number(lower).click({ modifiers: ['Meta'] })
    await moved(lower, down).toBe(previous + 1)
    expect([(await read(lower)).index, await mindbox(page).inputValue()], 'cmd+click moved it one place up; the query is unchanged').toEqual([top.index, TAG])
  })

  await test.step('an item the query names already: shift+click adds no entry', async () => {
    // a tag's click leaves a space after the name it sets
    await page.evaluate(name => void (window as any).MindBox.set(name + ' '), NAMED)
    await expect(number(named)).toHaveClass(/matching/)
    const [index] = await entry()
    await number(named).click({ modifiers: ['Shift'] })
    await settled(page)
    expect([await mindbox(page).inputValue(), (await entry())[0]], 'the box and the entry as they were').toEqual([NAMED + ' ', index])
    // an id reference in the tab's own spelling is the same selection as the saved one: no entry either
    await page.evaluate(name => void (window as any).MindBox.set(name), `id:${plain}`)
    await expect(number(plain)).toHaveClass(/matching/)
    const [tabIndex] = await entry()
    await number(plain).click({ modifiers: ['Shift'] })
    await settled(page)
    expect([await mindbox(page).inputValue(), (await entry())[0]], "the tab's own spelling of the id is left as it is").toEqual([`id:${plain}`, tabIndex])
    // a labeled item's id reference is another view (no children under it): a select gives the label's, in a new entry
    await page.evaluate(name => void (window as any).MindBox.set(name), `id:${savedNamed}`)
    await expect(number(named)).toHaveClass(/matching/)
    const [idIndex] = await entry()
    await number(named).click({ modifiers: ['Shift'] })
    await expect(mindbox(page), "a labeled item's id view is not its selection").toHaveValue(NAMED)
    expect(await entry()).toEqual([idIndex + 1, NAMED, true])
  })

  await test.step('the first view again: option and cmd move a plain number as before, and select nothing', async () => {
    await page.evaluate(() => void (window as any).MindBox.set(''))
    await reveal(plain)
    await expect(number(plain)).not.toHaveClass(/matching/)
    const top = await read(plain)
    const next = await timeAt(top.index + 1)
    await number(plain).click({ modifiers: ['Alt'] })
    await moved(plain, top).toBe(next - 1)
    const down = await read(plain)
    expect([down.index, down.target], 'option+click moved the plain item one place down, and selected nothing').toEqual([top.index + 1, false])
    const previous = await timeAt(down.index - 1)
    await reveal(plain)
    await number(plain).click({ modifiers: ['Meta'] })
    await moved(plain, down).toBe(previous + 1)
    expect([(await read(plain)).index, await mindbox(page).inputValue()], 'cmd+click moved it one place up; no query').toEqual([top.index, ''])
  })

  await test.step('a log item: no question on a select, the question on a move', async () => {
    await reveal(log)
    const before = await read(log)
    await expect(number(log)).not.toHaveClass(/matching/)
    await number(log).click()
    await expect(mindbox(page), 'a plain number selects the log item, by its id reference').toHaveValue(`id:${savedLog}`)
    expect(dialogs, 'a select asks nothing').toEqual([])
    expect(await read(log), "the target, its time as it was (a log item's is never touched)").toMatchObject({ target: true, time: before.time, saves: before.saves })
    // selected, its number is green: a plain click is the move, which asks first; the row declines
    await expect(number(log)).toHaveClass(/matching/)
    const [index] = await entry()
    await number(log).click()
    await expect.poll(() => dialogs, { message: 'a move asks first' }).toEqual([QUESTION])
    // shift+click on the green number is a select again: no second question, and no entry for the item already selected
    await number(log).click({ modifiers: ['Shift'] })
    await settled(page)
    expect([dialogs, (await entry())[0]], 'a select of the item already selected asks nothing and adds no entry').toEqual([[QUESTION], index])
    expect(await read(log), 'declined: nothing moved, nothing saved').toMatchObject({ time: before.time, savedTime: before.savedTime, saves: before.saves })
  })

  await test.step('the query follows a selected item: a label added in its editor, removed again, then the item deleted', async () => {
    await page.evaluate(() => void (window as any).MindBox.set(''))
    await reveal(plain)
    await number(plain).click()
    await expect(mindbox(page)).toHaveValue(`id:${savedPlain}`)
    const [index] = await entry()
    const textarea = page.locator(`#textarea-${plain}`)
    // an edit through the item's own editor: a click mid-paragraph opens it, shift+enter saves and closes it
    const edit = async (text: string) => {
      const paragraph = page.locator(`#item-${plain} p`).first()
      const box = (await paragraph.boundingBox())!
      await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
      await expect(textarea).toBeVisible()
      await textarea.fill(text)
      await page.keyboard.press('Shift+Enter')
      await expect(textarea).toBeHidden()
      await expect.poll(async () => (await read(plain)).saving, { timeout: 30_000 }).toBe(false)
    }
    const RENAMED = '#e2e_number_renamed'
    await edit(`${RENAMED} ${texts[0]}`)
    await expect(mindbox(page), 'a unique label added to the selected item: the query is the label').toHaveValue(RENAMED)
    expect((await entry()).slice(0, 2), 'in the same entry').toEqual([index, RENAMED])
    // the same view under another spelling of the label, which a query accepts (its case, a trailing space, as
    // a tag's click leaves one): the next rename is followed from the query as it is written
    const SPELLED = RENAMED.toUpperCase() + ' '
    await page.evaluate(name => void (window as any).MindBox.set(name), SPELLED)
    await expect(mindbox(page)).toHaveValue(SPELLED)
    expect([(await read(plain)).target, (await entry()).slice(0, 2)], 'the item is still the target, in the same entry').toEqual([true, [index, SPELLED]])
    await edit(texts[0])
    await expect(mindbox(page), "the label removed again: the query is the item's saved id, not the id of its tab").toHaveValue(`id:${savedPlain}`)
    expect((await entry()).slice(0, 2)).toEqual([index, `id:${savedPlain}`])
    await page.evaluate(id => void window._item(id)!.delete(false), plain)
    await expect(mindbox(page), 'the selected item deleted: no dead id is left in the box').toHaveValue('')
    expect([(await entry()).slice(0, 2), await page.evaluate(() => location.hash)], 'nor in the entry and the address').toEqual([[index, ''], ''])
  })

  await test.step("a select made by a run's own code is kept: a selected item renamed in its editor and run as the edit is finished (cmd/ctrl+enter), with code that selects another item, leaves that item selected", async () => {
    // A: a runnable item, selected by its label; its code selects B, the named fixture
    const [RUN, RERUN] = ['#e2e_number_run', '#e2e_number_rerun']
    const code = ['```js_input', `_item('${NAMED}').select()`, '```'].join('\n')
    await page.evaluate(text => void window._create(text), `${RUN} a runnable item\n${code}`)
    await expect.poll(() => page.evaluate(start => window._items().find(item => item.text.startsWith(start))?.id ?? null, RUN)).toBeTruthy()
    const run = await idOf(RUN)
    await expect.poll(async () => !!(await savedOf(run)) && !(await read(run)).saving, { message: 'the runnable item is saved', timeout: 30_000 }).toBe(true)
    await reveal(run)
    await number(run).click()
    await expect(mindbox(page), 'A is selected, by its label').toHaveValue(RUN)
    const [index] = await entry()
    // its label changed in its editor, and the edit finished with a run. At the key's release the handler
    // reads whether the query selects the item, applies the rename, executes the item's code, which selects
    // B in an entry of its own, and only then follows the rename. (Option+Enter, the run that keeps the
    // editor open, is no witness: there the handler throws on the edited item's changed rank before it
    // gets to the follow)
    const textarea = page.locator(`#textarea-${run}`)
    const paragraph = page.locator(`#item-${run} p`).first()
    const box = (await paragraph.boundingBox())!
    await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
    await expect(textarea).toBeVisible()
    await textarea.fill(`${RERUN} a runnable item\n${code}`)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect.poll(async () => (await entry())[0], { message: "the run's code navigated: an entry was added" }).toBe(index + 1)
    await expect
      .poll(() => page.evaluate(id => (item => !item.editing && !item.saving)((window as any).__items.find((item: any) => item.id == id)), run), { message: 'the editor is closed and the item saved', timeout: 30_000 })
      .toBe(true)
    await settled(page)
    // the rename took (the query that selected A would follow it to its new name), and the query is B's all
    // the same: followed on what the handler had read before the code ran, the box held A's new name and B's
    // entry was replaced with it
    const after = {
      label: await page.evaluate(id => (window as any).__items.find((item: any) => item.id == id).labelText as string, run),
      box: await mindbox(page).inputValue(),
      entry: await entry(),
      target: (await read(named)).target,
    }
    expect(after, "A is renamed, and the select its code made stays: the box and the entry that select wrote name B").toEqual({ label: RERUN, box: NAMED, entry: [index + 1, NAMED, true], target: true })
    await page.evaluate(id => void window._item(id)!.delete(false), run)
  })

  // the fixtures go: the rows after this one find the account's items as before
  await page.evaluate(() => void (window as any).MindBox.set(''))
  await page.evaluate(ids => ids.forEach(id => void window._item(id)!.delete(false)), [named, taggedA, taggedB, log])
  await expect.poll(() => page.evaluate(() => window._items().filter(item => item.text.includes('e2e_number_')).length), { timeout: 30_000 }).toBe(0)
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

test('shift with cmd/ctrl+arrows in an item editor extends the selection to the start/end of the text around its anchor', async ({
  page,
}) => {
  // the owner, 2026-10-06: Shift+⌘/⌃+↑/↓ keep the selection's anchor and move its focus to the text's
  // edge (⌘ does this natively on a Mac; ⌃ has no native move, and the editor handles both the same
  // way), never jumping to a neighboring item, even from the edge itself
  await loadAdmin(page)
  await page.evaluate(() => void window._create('#e2e_select/a item with a longer text to select in'))
  await expect.poll(() => savedId(page, '#e2e_select/a'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(() => (window as any).MindBox.set('#e2e_select/a', { scroll: true }))
  const id = await page.evaluate(() => window._item('#e2e_select/a', true)!.id)
  const paragraph = page.locator(`#item-${id} p`).first()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  const textarea = page.locator(`#textarea-${id}`)
  await expect(textarea).toBeFocused()
  const caret = (at: number) =>
    page.evaluate(([id, at]) => (document.getElementById('textarea-' + id) as HTMLTextAreaElement).setSelectionRange(at, at), [id, at] as const)
  const selection = () =>
    page.evaluate(id => {
      const t = document.getElementById('textarea-' + id) as HTMLTextAreaElement
      return [t.selectionStart, t.selectionEnd, t.selectionDirection, t.value.length] as const
    }, id)
  const length = (await selection())[3]
  await caret(5)
  await page.keyboard.press('Shift+Control+ArrowUp')
  expect(await selection(), 'the selection runs from the start to the caret, its focus at the start').toEqual([0, 5, 'backward', length])
  await page.keyboard.press('Shift+Control+ArrowDown')
  expect(await selection(), 'the anchor stays: the selection flips to run to the end').toEqual([5, length, 'forward', length])
  await page.keyboard.press('Shift+Meta+ArrowUp')
  expect(await selection(), 'Cmd the same, around the same anchor').toEqual([0, 5, 'backward', length])
  await expect(textarea, 'from the start, Shift keeps the editor (no jump to a neighbor)').toBeFocused()
  await page.keyboard.press('Shift+Control+ArrowUp')
  await expect(textarea).toBeFocused()
  expect(await selection(), 'and the selection is unchanged').toEqual([0, 5, 'backward', length])
  await caret(0)
  await page.keyboard.press('Shift+Meta+ArrowDown')
  expect(await selection(), 'from the start, the whole text').toEqual([0, length, 'forward', length])
  // a collapsed caret at an edge: the key moves nothing (the direction of a collapsed selection is
  // immaterial, and a range set with one reports it)
  await caret(0)
  await page.keyboard.press('Shift+Control+ArrowUp')
  expect((await selection()).slice(0, 2), 'a caret at the start stays a caret').toEqual([0, 0])
  await caret(length)
  await page.keyboard.press('Shift+Control+ArrowDown')
  expect((await selection()).slice(0, 2), 'a caret at the end stays a caret').toEqual([length, length])
  // a DIRECTIONLESS selection, as the mouse makes one on a Mac (review 0 B1): the first Shift+arrow
  // decides which end moves, so Up keeps the selection's far end as the anchor and Down its near end
  await page.evaluate(id => (document.getElementById('textarea-' + id) as HTMLTextAreaElement).setSelectionRange(5, 15), id)
  expect((await selection())[2], 'the platform keeps a directionless selection (else this row proves nothing)').toBe('none')
  await page.keyboard.press('Shift+Control+ArrowUp')
  expect(await selection(), 'Up extends to the start keeping the far end').toEqual([0, 15, 'backward', length])
  await page.keyboard.press('Shift+Control+ArrowDown')
  expect(await selection(), 'the reversal keeps that anchor').toEqual([15, length, 'forward', length])
  await page.evaluate(id => (document.getElementById('textarea-' + id) as HTMLTextAreaElement).setSelectionRange(5, 15), id)
  await page.keyboard.press('Shift+Meta+ArrowDown')
  expect(await selection(), 'Down from a directionless selection keeps the near end').toEqual([5, length, 'forward', length])
  await page.keyboard.press('Escape') // nothing edited: the editor closes
  await expect(textarea).toBeHidden()
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

test('cmd/ctrl+c from the window copies the name of the item the MindBox names (its label, or id:<saved id> when unlabeled); a selection, a focused input, no target or an unsaved id keeps the native copy', async ({
  page,
  context,
}) => {
  // the owner's ask (2026-10-11): Cmd/Ctrl+C with no editor focused copies the target item's name, as a
  // fallback when nothing is selected. The positive cases press the key and read the clipboard back
  // through the async clipboard API under granted permissions; the negative cases dispatch the key as a
  // synthetic event (no native copy follows one, so a kept sentinel means the app wrote nothing) and
  // assert the default was not prevented. An editor's copy is out of reach: the Editor stops the
  // propagation of modified keys. An unlabeled item copies its SAVED id (review 0 B1: the local id of an
  // item created in this tab is temporary), checked to resolve after a reload
  await loadAdmin(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const L = '#e2e_Copy_Name' // mixed case: the copy is the label as written, whatever case the query has
  await page.evaluate(l => void window._create(`${l} an item with a label\n\n<input type="text" id="e2e_copy_input" value="typed">`), L)
  await page.evaluate(() => void window._create('e2e_copy_unlabeled an item without a label'))
  await expect.poll(() => savedId(page, L), { timeout: 30_000 }).toBeTruthy()
  const unlabeled = () => page.evaluate(() => window._items().find(i => i.text.startsWith('e2e_copy_unlabeled')) ?? null)
  await expect.poll(async () => (await unlabeled())?.id, { timeout: 30_000 }).toBeTruthy()
  const id = (await unlabeled())!.id
  await expect.poll(() => savedId(page, id), { timeout: 30_000 }).toBeTruthy()
  const saved = (await savedId(page, id))!
  expect(saved, 'an item created in this tab has a temporary local id').not.toBe(id)
  expect((await unlabeled())!.name, "the app's own name of an unlabeled item is its local id").toBe(`id:${id}`)
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
  const sentinel = async () => {
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'))
    await expect.poll(clipboard).toBe('sentinel')
  }
  const target = async (name: string) => {
    await page.evaluate(name => (window as any).MindBox.set(name, { scroll: true }), name)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  }
  // the key as a synthetic event from the active element (the window handler reads the physical code)
  const synthetic = () =>
    page.evaluate(() => {
      const e = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true })
      ;(document.activeElement ?? document.body).dispatchEvent(e)
      return e.defaultPrevented
    })
  // the labeled target, by Ctrl and by Cmd, the query in lower case
  await sentinel()
  await target(L.toLowerCase())
  await page.keyboard.press('Control+KeyC')
  await expect.poll(clipboard, { message: 'Ctrl+C copied the label as written' }).toBe(L)
  await sentinel()
  await page.keyboard.press('Meta+KeyC')
  await expect.poll(clipboard, { message: 'Cmd+C copied the label' }).toBe(L)
  // the unlabeled target, named by its local id: the copy is its saved id
  await sentinel()
  await target(`id:${id}`)
  await page.keyboard.press('Control+KeyC')
  await expect.poll(clipboard, { message: 'the unlabeled item copies as id:<saved id>' }).toBe(`id:${saved}`)
  // an unlabeled item not yet saved copies nothing (the policy's witness through the internal state: the
  // saved id withheld for one synthetic press, then restored)
  await sentinel()
  expect(
    await page.evaluate(
      ([id, saved]) => {
        const item = window.__items.find(i => i.id === id)!
        item.savedId = undefined
        const e = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true })
        document.body.dispatchEvent(e)
        item.savedId = saved
        return e.defaultPrevented
      },
      [id, saved]
    ),
    'no saved id yet: not prevented'
  ).toBe(false)
  // a selection (the labeled item's text) keeps the native copy
  await target(L)
  const itemId = (await page.evaluate(l => window._item(l, true)?.id, L))!
  await expect(page.locator(`#item-${itemId} p`).first()).toBeVisible()
  await page.evaluate(id => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector(`#item-${id} p`)!)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }, itemId)
  expect(await page.evaluate(() => document.getSelection()!.toString()), 'the fixture selected text').toContain('an item with a label')
  expect(await synthetic(), 'a selection: not prevented').toBe(false)
  await page.evaluate(() => document.getSelection()!.removeAllRanges())
  // a focused input embedded in an item (typed: an untyped <input> is the app's image upload), with a caret
  // alone, keeps the native copy too
  const input = page.locator('#e2e_copy_input')
  await input.evaluate((el: HTMLInputElement) => {
    el.focus()
    el.setSelectionRange(2, 2)
  })
  await expect(input).toBeFocused()
  expect(await page.evaluate(() => document.getSelection()!.isCollapsed), 'the document selection is collapsed').toBe(true)
  expect(await synthetic(), 'a focused input: not prevented').toBe(false)
  await input.evaluate(el => el.blur())
  // no unique target: nothing
  await target('#e2e_copy_none')
  expect(await synthetic(), 'no target: not prevented').toBe(false)
  // the app wrote nothing in the negative cases (a write is a microtask away, so a settle first)
  await page.waitForTimeout(100)
  expect(await clipboard(), 'the sentinel kept').toBe('sentinel')
  // after a reload the copied queries resolve to the same items (the saved id is the item's id then)
  await loadAdmin(page)
  expect(await page.evaluate(q => window._item(q, true)?.text ?? null, `id:${saved}`)).toBe('e2e_copy_unlabeled an item without a label')
  expect(await page.evaluate(q => window._item(q, true)?.id ?? null, `id:${saved}`), 'the saved id is the id after a reload').toBe(saved)
  expect(await itemText(page, L)).toContain('an item with a label')
  // the fixture, deleted by its saved identifiers and the deletions persisted (deleteDoc is fire-and-forget)
  const labeledSaved = (await savedId(page, L))!
  await page.evaluate(names => names.forEach(name => window._item(name, true)!.delete(false)), [L, `id:${saved}`])
  for (const doc of [labeledSaved, saved])
    await expect.poll(async () => (await firestore().collection('items').doc(doc).get()).exists, { timeout: 30_000 }).toBe(false)
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
// scrolls 600 px below the header and returns the position; the scroll is repeated until it holds for
// 150 ms: one scroll before the poll stayed at the top for 30 s under the full gate, twice (2026-10-28,
// the scroll right after Control+ArrowUp: the position read 612, the header, where more than 912 was
// expected; what returned it there, a layout's scroll or a clamp on a page still short, is not identified:
// lane_races review 0 corrected the first account). the rows that call this test what the keys do from a
// scrolled page, not whether a first scroll survives, so the repeat hides nothing they assert
const scrollDown = async (page: Page) => {
  const top = await headerTop(page)
  await expect
    .poll(
      async () => {
        await page.evaluate(y => document.body.scrollTo(0, y), top + 600)
        await page.waitForTimeout(150)
        return scrollTop(page)
      },
      { message: 'the body scrolled below the header (the page is long enough)' }
    )
    .toBeGreaterThan(top + 300)
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
  // view's position, and Back stayed at the header). First the previous step's own scroll event and
  // write are let through (the scroll to the top above): the event is dispatched a frame after the
  // scroll and its write 250 ms later, and this phase once read the destination recording the header
  // (the full gate of 2026-10-29: "both positions intact" read [612, 612]), which a late event arriving
  // after Back explains, re-arming the write on the destination with the body still at the header: an
  // inference from the position recorded, no event trace; two frames, then no write pending
  const settledWrites = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await noWritePending(page)
  }
  await settledWrites()
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
  // arms a write for the top entry (a scroll event), goes Back, and scrolls the destination further once
  // the restore has landed, while that write is still pending. The destination must record the fresh
  // position (the identity check dropped the write, and the fresh scroll could not re-arm while one was
  // pending). The overlap is held, not timed (lane_races review 0 B1): the departed write's timer, the one
  // 250 ms timer the scroll event arms, is captured and released only after the fresh scroll's event has
  // been processed, so a restore slower than the delay (a loaded host; a fixed 120 ms before the fresh
  // scroll once let a late restore undo it, 2026-10-28) cannot let the write expire first and pass the
  // phase without the overlap it tests; the re-arm clears the captured timer as it would the real one.
  // the pending flag read at the fresh scroll names a history write, not its entry: the restore's own
  // scroll event may already have re-armed the write for the destination, the behaviour under test
  await settledWrites()
  const overlap = await page.evaluate(
    ({ y, at }) =>
      new Promise<{ armed: number; pendingAtFresh: boolean; releasedLate: number }>(resolve => {
        const setTimeout_ = window.setTimeout
        const clearTimeout_ = window.clearTimeout
        const held: { id: number; cb: () => void }[] = []
        const w = window as any
        w.__fakeTimerId ??= 1 << 30 // unique across every capture on this page: a stale id in an app variable (historyUpdateTimer) cleared later must match nothing held
        ;(window as any).setTimeout = (cb: () => void, ms?: number, ...args: unknown[]) =>
          ms == 250 ? (held.push({ id: ++w.__fakeTimerId, cb }), w.__fakeTimerId) : setTimeout_(cb, ms, ...args)
        ;(window as any).clearTimeout = (id?: number) => {
          const i = held.findIndex(h => h.id == id)
          i >= 0 ? held.splice(i, 1) : clearTimeout_(id)
        }
        document.body.dispatchEvent(new Event('scroll')) // arms the departed write: captured
        window.setTimeout = setTimeout_ // every later timer, the re-armed write included, is real
        const armed = held.length
        history.back()
        const fresh = () => {
          if (Math.abs(document.body.scrollTop - at) > 2) return requestAnimationFrame(fresh) // the restore landed
          const pendingAtFresh = (window as any)._history_update_pending as boolean
          document.body.scrollTo(0, y)
          // the scroll event is dispatched a frame later; the departed write is released after it
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              window.clearTimeout = clearTimeout_
              const late = held.splice(0)
              late.forEach(h => h.cb())
              resolve({ armed, pendingAtFresh, releasedLate: late.length })
            })
          )
        }
        requestAnimationFrame(fresh)
      }),
    { y: before + 100, at: before }
  )
  expect(overlap, 'the scroll event armed the one write, held until its cancellation or release; a history write pending at the fresh scroll').toMatchObject({
    armed: 1,
    pendingAtFresh: true,
  })
  await expect
    .poll(() => page.evaluate(i => (window as any)._history[i].scrollPosition, index), {
      message: `the destination recorded the fresh position (${JSON.stringify(overlap)})`,
    })
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
  await blur(page) // the Resume shortcut is the window's: nothing focused
  // the hold below catches every frame requested from now on, so the frames the close and the blur
  // requested (the layout, its scroll) must have run first, or the first release ran a held layout along
  // with the restore's first phase, and the layout's scroll cancelled the restore (lastScrollTime past its
  // dispatch), the editor never focused (the full gate, 2026-10-28). Observed, not paused for (lane_races
  // review 0): a layout the close's re-measure triggered is pending until it runs (window.__layoutPending),
  // and its flush is a tick and two frames
  await expect.poll(() => page.evaluate(() => (window as any).__layoutPending as boolean), { message: 'no layout pending after the close', timeout: 15_000 }).toBe(false)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
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

test('time rows regroup on a query change, not on every layout: a passive re-ranking inserts no row above the item being read; the next query change regroups', async ({ page }) => {
  // the owner (2026-10-05): reading an item with its children below, a time row ("now") appeared above it
  // and pushed everything down whenever a passive re-ranking (an item's running state, a remote change)
  // soft-touched the named item to now; a reload showed it at once. The geometry: the item's ancestor is
  // listed above it as context, in the same time group, so the item had no row of its own until its
  // bucket changed. The layout now regroups the time rows on a query change (the input a reader expects
  // to re-lay the page out); every other layout keeps each row as it is, its text refreshed
  await loadAdmin(page)
  const ROOT = '#e2e_tr'
  const ITEM = `${ROOT}/0`
  await page.evaluate(text => void window._create(text), `${ROOT} root`)
  await page.evaluate(text => void window._create(text), `${ITEM} the item being read`)
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), ROOT)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  await expect.poll(query).toMatch(/^#e2e_tr ?$/)
  // both an hour old (through their records: the index button's gesture cannot age the named item, every
  // re-ranking soft-touches it back to now), then Down enters the item with times kept, as the owner's
  // navigation does: the root listed above it as context, one group an hour old with the root's row
  await page.evaluate(labels => labels.forEach(label => ((window as any).__items.find((i: any) => i.label == label).time -= 3600e3)), [ROOT, ITEM])
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe(`${ITEM} `)
  // the time row above each of the two items (null: none), through the item's element
  const rows = () =>
    page.evaluate(labels =>
      labels.map(label => {
        const row = window._item(label, true)?.elem?.closest('.super-container')?.querySelector(':scope > .time')
        return row ? row.textContent!.trim() : null
      }),
      [ROOT, ITEM]
    )
  const order = () => page.evaluate(labels => labels.map(label => (window as any).__items.findIndex((i: any) => i.label == label)), [ROOT, ITEM])
  // the layout's distance from the root's top edge to the item's: a row inserted between them is 24 px of
  // it, while a scroll (the navigation's, settling late) moves both edges alike
  const gap = () => page.evaluate(labels => labels.map(label => window._item(label, true)!.elem!.getBoundingClientRect().top).reduce((a, b) => b - a), [ROOT, ITEM])
  await expect.poll(rows, { timeout: 15_000 }).toEqual(['1h', null])
  const [rootIndex, itemIndex] = await order()
  expect(rootIndex, 'the root listed above the item, as context').toBeLessThan(itemIndex)
  const before = await gap()
  // the passive re-ranking: the item soft-touched to now (as a running-state change or a remote change does
  // through onEditorChange); before the fix a "now" row appeared above it; now the rows stay, the item unmoved
  await page.evaluate(label => (window._item(label, true) as any).touch(), ITEM)
  await expect.poll(() => page.evaluate(label => Date.now() - (window as any).__items.find((i: any) => i.label == label).time < 60_000, ITEM)).toBe(true)
  expect(await rows(), 'no row above the item being read').toEqual(['1h', null])
  expect(await gap(), 'the item did not move relative to the root').toBe(before)
  // a query change regroups: up to the root (alt on its label keeps times), then Down to the item again,
  // whose group is now its own (the typed query and the fresh load have rows of their own below)
  await page.evaluate(label => window._item(label, true)!.elem!.querySelector('mark.label')!.dispatchEvent(new MouseEvent('mousedown', { altKey: true })), ROOT)
  await expect.poll(query).toMatch(/^#e2e_tr ?$/)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe(`${ITEM} `)
  await expect.poll(rows, { timeout: 15_000 }).toEqual(['1h', 'now'])
})

test('time rows: a query TYPED into the mindbox regroups when it applies, not at a layout run while it is pending', async ({ page }) => {
  // review 0 B2: a layout during the editor's debounce must not stand in for the query's own regroup.
  // A root and the item under it, both aged an hour, the root queried with times kept; the pre-query
  // display asserted; the item's query typed, then a layout pass run while it is pending (window.__layout,
  // the pass checkLayout and an item's resize run; the layout count and the pending flag read with it:
  // the premise); then the query applies, soft-touches the item to now, and its row appears
  await loadAdmin(page)
  const ROOT = '#e2e_tr2'
  const ITEM = `${ROOT}/0`
  await page.evaluate(text => void window._create(text), `${ROOT} root`)
  await page.evaluate(text => void window._create(text), `${ITEM} the item`)
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), ROOT)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  await expect.poll(query).toMatch(/^#e2e_tr2 ?$/)
  const rows = () =>
    page.evaluate(labels =>
      labels.map(label => {
        const row = window._item(label, true)?.elem?.closest('.super-container')?.querySelector(':scope > .time')
        return row ? row.textContent!.trim() : null
      }),
      [ROOT, ITEM]
    )
  await page.evaluate(labels => labels.forEach(label => ((window as any).__items.find((i: any) => i.label == label).time -= 3600e3)), [ROOT, ITEM])
  // the root queried with times kept: Down to the item (a nested child, times kept) and alt on the root's label
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe(`${ITEM} `)
  await page.evaluate(label => window._item(label, true)!.elem!.querySelector('mark.label')!.dispatchEvent(new MouseEvent('mousedown', { altKey: true })), ROOT)
  await expect.poll(query).toMatch(/^#e2e_tr2 ?$/)
  await expect.poll(rows, { timeout: 15_000 }).toEqual(['1h', null]) // the pre-query display: the root's row, the item behind the shown count
  await focusMindbox(page)
  await mindbox(page).press('ControlOrMeta+a')
  await mindbox(page).pressSequentially(ITEM)
  const witnessed = await page.evaluate(() => {
    const w = window as any
    const before = w.__layoutCount as number
    const pending = !!w._mindboxDebounced
    w.__layout()
    return { before, after: w.__layoutCount as number, pending }
  })
  expect(witnessed.after > witnessed.before && witnessed.pending, `a layout ran while the typed query was pending (the premise): ${JSON.stringify(witnessed)}`).toBe(true)
  await expect.poll(() => page.evaluate(() => !!(window as any)._mindboxDebounced), { timeout: 10_000 }).toBe(false) // the query applied
  await expect.poll(query).toMatch(/^#e2e_tr2\/0 ?$/)
  await expect.poll(rows, { timeout: 15_000 }).toEqual(['1h', 'now']) // the item, soft-touched to now, starts its group: the typed query's regroup
})

test('time rows: the arrows navigate through a query change, which regroups nothing when the regroup would move the item in view; the skip is consumed; a target out of view regroups; an explicit touch regroups whatever moves', async ({ page }) => {
  // the owner (2026-10-07): the time rows regroup on a query change, and the arrow keys navigate through
  // one, so a row the regroup inserted above the item being read pushed it down at the navigation. A root,
  // the item under it and the item's child, all an hour old; Down enters the item with the root above it
  // as context, the child shown below it; the item soft-touched to now (the passive re-ranking, as in the
  // first row); Down to the child, whose regroup would give the item a "now" row above the child and the
  // child its own "1h" row: skipped, the rows unchanged and the item's text where it was. The skip is
  // consumed, not deferred: with the page at its top (the child below the band a navigation leaves
  // stationary) a layout pass still keeps the rows. A navigation to the item there, below the band,
  // regroups: the rows catch up in the layout's state. The owner's explicit touch (the index button) then
  // regroups whatever moves: the root touched to now while the item, the target, stands in the band
  await loadAdmin(page)
  const ROOT = '#e2e_trn'
  const ITEM = `${ROOT}/0`
  const CHILD = `${ITEM}/0`
  for (const text of [`${ROOT} root`, `${ITEM} the item being read`, `${CHILD} its child`]) await page.evaluate(text => void window._create(text), text)
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), ROOT)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  await expect.poll(query).toMatch(/^#e2e_trn ?$/)
  await page.evaluate(labels => labels.forEach(label => ((window as any).__items.find((i: any) => i.label == label).time -= 3600e3)), [ROOT, ITEM, CHILD])
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe(`${ITEM} `)
  // the child shown below the item (the lanes' shown count leaves it behind the show toggle)
  const shown = (label: string) => page.evaluate(label => !!window._item(label, true)?.elem, label)
  const reveal = async (label: string) => {
    if (!(await shown(label))) await page.evaluate(() => document.querySelector('.toggle.show')!.dispatchEvent(new Event('click')))
    await expect.poll(() => shown(label)).toBe(true)
  }
  await reveal(CHILD)
  const rows = () =>
    page.evaluate(labels =>
      labels.map(label => {
        const row = window._item(label, true)?.elem?.closest('.super-container')?.querySelector(':scope > .time')
        return row ? row.textContent!.trim() : null
      }),
      [ROOT, ITEM, CHILD]
    )
  const groups = () => page.evaluate(labels => labels.map(label => (window as any).__items.find((i: any) => i.label == label).timeString || null), [ROOT, ITEM, CHILD])
  // an item's element against the band (the viewport's height less 200 px from the scroll position)
  const band = (label: string) =>
    page.evaluate(label => {
      const elem = window._item(label, true)!.elem! // the super-container
      const [top, scrollTop, height] = [elem.offsetTop, document.body.scrollTop, visualViewport!.height]
      return { top, scrollTop, height, inside: top >= scrollTop && top <= scrollTop + height - 200 }
    }, label)
  // scrolls the page to y and retries until the position is still there at a sample 200 ms later: a
  // navigation's deferred scroll to its target and a layout's scroll to a target a late height has moved
  // land a few frames late on the full lane's busier page (two full gates found the page back at the
  // child after a scroll to its top, where the row alone never did)
  const settleScroll = async (y: number) => {
    await expect
      .poll(
        async () => {
          await page.evaluate(y => document.body.scrollTo(0, y), y)
          await new Promise(resolve => setTimeout(resolve, 200))
          return page.evaluate(y => Math.abs(document.body.scrollTop - y) <= 2, y)
        },
        { timeout: 15_000 }
      )
      .toBe(true)
  }
  await expect.poll(rows, { timeout: 15_000 }).toEqual(['1h', null, null])
  // the distance from the root's text to the item's (the inner containers, below the rows): a row on the
  // item, the one the regroup would put above the child, is 24 px of it, while a scroll moves both alike;
  // the child's position is no witness, since the lanes' hide toggle above the revealed child leaves with
  // the query change
  const gap = () => page.evaluate(labels => labels.map(label => window._item(label, true)!.elem!.querySelector(':scope > .container')!.getBoundingClientRect().top).reduce((a, b) => b - a), [ROOT, ITEM])
  const before = await gap()
  // the passive re-ranking: the item soft-touched to now (as a running-state change or a remote change does
  // through onEditorChange); the rows kept, the child shown still (revealed again should the count hide it)
  await page.evaluate(label => (window._item(label, true) as any).touch(), ITEM)
  await expect.poll(() => page.evaluate(label => Date.now() - (window as any).__items.find((i: any) => i.label == label).time < 60_000, ITEM)).toBe(true)
  await reveal(CHILD)
  expect(await rows(), 'no row from the passive touch').toEqual(['1h', null, null])
  // the page scrolled to the item, as a navigation to it from below the band leaves it, so the child
  // below it stands in the band (the navigation above scrolls nothing when the item is in the band at
  // the top already, and the child then sits where the lane's heights put it: once outside, 2026-10-28)
  await settleScroll(await page.evaluate(label => window._item(label, true)!.elem!.offsetTop - 100, ITEM))
  const premise = await band(CHILD)
  expect(premise.inside, `the child in the band before the navigation: ${JSON.stringify(premise)}`).toBe(true)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe(`${CHILD} `)
  expect(await rows(), 'the regroup skipped: no row on the item or the child').toEqual(['1h', null, null])
  expect(await gap(), "the item's text did not move relative to the root's").toBe(before)
  // consumed, not deferred: at the page's top the child (the target) stands below the band, and a layout
  // pass (the test hook) still keeps the rows: a deferred regroup would run here, the target out of view
  await settleScroll(0)
  const outside = await band(CHILD)
  expect(outside.inside, `the child outside the band at the page's top: ${JSON.stringify(outside)}`).toBe(false)
  await page.evaluate(() => (window as any).__layout())
  expect(await rows(), 'the rows kept by a layout with the target out of view').toEqual(['1h', null, null])
  // the catch-up: a navigation to the item, below the band too (alt on its label keeps times), regroups: the
  // item's "now" row and the child's "1h" row, in the layout's state (the child sits behind the shown
  // count again under the item's query). The page is scrolled to its top again first: the layout pass
  // above may scroll to the target it finds moved, which changes nothing about the rows it kept
  await settleScroll(0)
  const itemOutside = await band(ITEM)
  expect(itemOutside.inside, `the item outside the band at the page's top: ${JSON.stringify(itemOutside)}`).toBe(false)
  await page.evaluate(label => window._item(label, true)!.elem!.querySelector('mark.label')!.dispatchEvent(new MouseEvent('mousedown', { altKey: true })), ITEM)
  await expect.poll(query).toBe(`${ITEM} `)
  await expect.poll(groups, { timeout: 15_000 }).toEqual(['1h', 'now', '1h'])
  // the explicit touch is forced: the root touched to now through its index button with the item, the
  // target, in the band; the regroup drops the item's row (its text lifted) and runs regardless
  await settleScroll(await page.evaluate(label => window._item(label, true)!.elem!.offsetTop - 100, ITEM))
  const inside = await band(ITEM)
  expect(inside.inside, `the item in the band before the touch: ${JSON.stringify(inside)}`).toBe(true)
  await page.evaluate(label => window._item(label, true)!.elem!.querySelector('.button.index')!.dispatchEvent(new MouseEvent('click', { bubbles: true })), ROOT)
  await expect.poll(() => page.evaluate(label => Date.now() - (window as any).__items.find((i: any) => i.label == label).time < 60_000, ROOT)).toBe(true)
  await expect.poll(groups, { timeout: 15_000 }).toEqual(['now', null, '1h'])
})

test('time rows: the side arrows swap a sibling into the place of the item being read, which takes over the row of the place: no row for a sibling grouped apart from the parent, and the regroup runs for one whose grouping agrees', async ({ page }) => {
  // the owner (2026-10-07): reloaded into a chat's child and stepping through its siblings with Left and
  // Right, the siblings touched within the hour showed a "now" row above them and the others none, so the
  // item being read shifted up and down with every step. A sibling navigation is a query change whose
  // target lands where the previous target stood, below the same parent as context: the regroup gives it
  // a row by its own bucket against the parent's, the keeping pass the row it had among the rest, and
  // neither is where the eyes are; the target now takes over the row of the place (the previous
  // target's), and the regroup runs only when its own grouping lands the text there too
  // (regroupMovesReader). A root an hour old with three integer children: /0 and /2 an hour old (the
  // root's bucket), /1 thirty minutes old (a bucket of its own in the lane, so a regroup heads its group
  // among the rest)
  await loadAdmin(page)
  const ROOT = '#e2e_trs'
  const [C0, C1, C2] = [0, 1, 2].map(i => `${ROOT}/${i}`)
  for (const text of [`${ROOT} root`, `${C0} the first child`, `${C1} the second child`, `${C2} the third child`]) await page.evaluate(text => void window._create(text), text)
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), ROOT)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  await expect.poll(query).toMatch(/^#e2e_trs ?$/)
  await page.evaluate(ages => Object.entries(ages).forEach(([label, age]) => ((window as any).__items.find((i: any) => i.label == label).time -= age)), { [ROOT]: 3600e3, [C0]: 3600e3, [C1]: 1800e3, [C2]: 3600e3 })
  const rows = (labels: string[]) =>
    page.evaluate(labels =>
      labels.map(label => {
        const row = window._item(label, true)?.elem?.closest('.super-container')?.querySelector(':scope > .time')
        return row ? row.textContent!.trim() : null
      }),
      labels
    )
  const group = (label: string) => page.evaluate(label => (window as any).__items.find((i: any) => i.label == label).timeString || null, label)
  // the distance from the root's text to the target's (the inner containers, below the rows): the target's
  // own row is 24 px of it, while a scroll moves both alike
  const gap = (label: string) => page.evaluate(labels => labels.map(label => window._item(label, true)!.elem!.querySelector(':scope > .container')!.getBoundingClientRect().top).reduce((a, b) => b - a), [ROOT, label])
  // an item's element against the band (the viewport's height less 200 px from the scroll position)
  const inBand = (label: string) =>
    page.evaluate(label => {
      const elem = window._item(label, true)!.elem!
      return elem.offsetTop >= document.body.scrollTop && elem.offsetTop <= document.body.scrollTop + visualViewport!.height - 200
    }, label)
  const navigate = async (key: 'ArrowDown' | 'ArrowLeft' | 'ArrowRight', label: string) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
    await page.keyboard.press(key)
    await expect.poll(query).toBe(`${label} `)
  }
  await navigate('ArrowDown', C0)
  await expect.poll(() => rows([ROOT, C0]), { timeout: 15_000 }).toEqual(['1h', null]) // the first child, in the root's bucket, has no row
  const place = await gap(C0)
  await expect.poll(() => inBand(C0), { message: 'the item being read in the band (the premise; the navigation scrolls it there)' }).toBe(true)
  await navigate('ArrowRight', C1)
  expect(await rows([ROOT, C1]), 'the thirty-minute sibling takes over the place without a row').toEqual(['1h', null])
  expect(await gap(C1), "its text where the first child's was").toBe(place)
  await navigate('ArrowRight', C2)
  expect(await rows([ROOT, C2]), 'the third child, in the root\'s bucket, takes over the place without a row').toEqual(['1h', null])
  expect(await gap(C2), 'its text there too').toBe(place)
  // the regroup ran for it, its own grouping agreeing with the place: the thirty-minute sibling, back among
  // the rest, heads its group again (the layout's state; it may sit behind the shown count)
  await expect.poll(() => group(C1), { timeout: 15_000 }).toMatch(/^\d+m$/)
  await navigate('ArrowLeft', C1)
  expect(await rows([ROOT, C1]), 'back on the thirty-minute sibling: the row of the place, none').toEqual(['1h', null])
  expect(await gap(C1), 'its text in place').toBe(place)
})

test('time rows: Down into a child the shown count hides holds the item being read in place: the regroup that would give it a row is skipped', async ({ page }) => {
  // the owner (2026-10-07: "Up/Down is also good to fix"): the earlier guard held the target's element
  // alone, and a child behind the show toggle has none, so Down into it regrouped, and a row the regroup
  // put above the item being read (soft-touched to now by a passive re-ranking after its rows were
  // grouped) pushed it down, the child appearing below. The previous target in view keeping its place is
  // held now (regroupMovesReader). The fixture of the arrows row: a root, its item and the item's child,
  // an hour old; Down into the item; the child left behind the show toggle
  await loadAdmin(page)
  const ROOT = '#e2e_trh'
  const ITEM = `${ROOT}/0`
  const CHILD = `${ITEM}/0`
  for (const text of [`${ROOT} root`, `${ITEM} the item being read`, `${CHILD} its child`]) await page.evaluate(text => void window._create(text), text)
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), ROOT)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  await expect.poll(query).toMatch(/^#e2e_trh ?$/)
  await page.evaluate(labels => labels.forEach(label => ((window as any).__items.find((i: any) => i.label == label).time -= 3600e3)), [ROOT, ITEM, CHILD])
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe(`${ITEM} `)
  const rows = () =>
    page.evaluate(labels =>
      labels.map(label => {
        const row = window._item(label, true)?.elem?.closest('.super-container')?.querySelector(':scope > .time')
        return row ? row.textContent!.trim() : null
      }),
      [ROOT, ITEM]
    )
  const groups = () => page.evaluate(labels => labels.map(label => (window as any).__items.find((i: any) => i.label == label).timeString || null), [ROOT, ITEM, CHILD])
  const shown = (label: string) => page.evaluate(label => !!window._item(label, true)?.elem, label)
  const gap = () => page.evaluate(labels => labels.map(label => window._item(label, true)!.elem!.querySelector(':scope > .container')!.getBoundingClientRect().top).reduce((a, b) => b - a), [ROOT, ITEM])
  const inBand = (label: string) =>
    page.evaluate(label => {
      const elem = window._item(label, true)!.elem!
      return elem.offsetTop >= document.body.scrollTop && elem.offsetTop <= document.body.scrollTop + visualViewport!.height - 200
    }, label)
  await expect.poll(rows, { timeout: 15_000 }).toEqual(['1h', null])
  expect(await shown(CHILD), 'the child behind the show toggle (the premise)').toBe(false)
  const place = await gap()
  // the passive re-ranking: the item soft-touched to now; the rows kept
  await page.evaluate(label => (window._item(label, true) as any).touch(), ITEM)
  await expect.poll(() => page.evaluate(label => Date.now() - (window as any).__items.find((i: any) => i.label == label).time < 60_000, ITEM)).toBe(true)
  expect(await rows(), 'no row from the passive touch').toEqual(['1h', null])
  expect(await shown(CHILD), 'the child still behind the show toggle').toBe(false)
  await expect.poll(() => inBand(ITEM), { message: 'the item being read in the band (the premise)' }).toBe(true)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe(`${CHILD} `)
  expect(await rows(), 'the regroup skipped: no row on the item').toEqual(['1h', null])
  expect(await gap(), "the item's text where it was").toBe(place)
  expect(await groups(), 'the rows kept in the layout\'s state, the child\'s too').toEqual(['1h', null, null])
})

test('time rows: a fresh load groups the corpus although layouts ran over an empty corpus before the items arrived', async ({ browser }) => {
  // review 0 B1: the layouts before the items arrive certify no query. A COLD context (the warm page's
  // Firestore cache answers the first snapshot at once), a read-only visitor of the anonymous account,
  // the first delivery held back by a route so that layouts run over an empty corpus first (the premise);
  // the first populated layout then groups the whole corpus (the seeded items span days), read off the
  // items' layout state (the empty query shows the pinned items alone, which carry no group header)
  const cold = await browser.newContext()
  const fresh = await cold.newPage()
  let heldOnce = false
  await fresh.route('**/Listen/channel**', async route => {
    if (!heldOnce) {
      heldOnce = true
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    await route.continue()
  })
  await fresh.goto('/?user=anonymous')
  await expect
    .poll(() => fresh.evaluate(() => ({ layouts: ((window as any).__layoutCount as number) ?? 0, items: ((window as any).__items?.length as number) ?? 0 })).then(s => s.layouts > 0 && s.items == 0), {
      message: 'a layout before the items arrive (the premise)',
      timeout: 10_000,
    })
    .toBe(true)
  const stay = fresh.getByText('Stay Anonymous', { exact: true })
  if (await stay.isVisible({ timeout: 3000 }).catch(() => false)) await stay.click()
  await expect.poll(() => fresh.evaluate(() => ((window as any).__items ?? []).filter((i: any) => i.timeString).length), { timeout: 30_000 }).toBeGreaterThan(1)
  await cold.close()
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
  // the query's own layout scrolls to its item a few frames after the render, later on the full gate's
  // busier page (a Down before it landed scrolled to the item itself, with an entry, 2026-10-28): the item
  // in view and the position at rest for 200 ms before the premise is read
  const inView = () =>
    page.evaluate(() => {
      const top = (document.querySelector('.super-container.target') as HTMLElement).offsetTop
      return top >= document.body.scrollTop && top <= document.body.scrollTop + visualViewport!.height - 200
    })
  await expect
    .poll(
      async () => {
        const y = await scrollTop(page)
        await page.waitForTimeout(200)
        return (await inView()) && (await scrollTop(page)) == y
      },
      { timeout: 15_000, message: 'the item in view, the position at rest' }
    )
    .toBe(true)
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

// what the reload rows read off the page: the history handler's warnings, collected from the first call on,
// and the readers below
const historyReads = (page: Page) => {
  const warnings: string[] = []
  page.on('console', msg => void (msg.type() == 'warning' && msg.text().includes('onPopState') && warnings.push(msg.text())))
  // the current entry holds the position shown, the scroll listener's write done
  const recorded = () =>
    expect
      .poll(() => page.evaluate(() => !(window as any)._history_update_pending && (window as any)._history[(window as any)._history_index].scrollPosition === document.body.scrollTop), {
        message: 'the position shown is recorded',
        timeout: 10_000,
      })
      .toBe(true)
  // a position of the entry's own: set until it holds (a navigation's own scroll can land after the first), then recorded
  const place = async (below: number) => {
    const y = (await headerTop(page)) + below
    await expect
      .poll(
        async () => {
          await page.evaluate(y => document.body.scrollTo(0, y), y)
          await page.waitForTimeout(150)
          return scrollTop(page)
        },
        { message: `the page holds ${below} px below the header` }
      )
      .toBe(y)
    await recorded()
    return y
  }
  // what the page shows (the MindBox's text, the position within 2 px) with what the handler logged, so that a failure names all three
  const shows = (text: string, y: number, message: string) =>
    expect
      .poll(
        async () => {
          const [box, now] = await page.evaluate(() => [(document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value, document.body.scrollTop] as const)
          return { box, at: Math.abs(now - y) <= 2 ? y : now, warnings }
        },
        { message, timeout: 10_000 }
      )
      .toEqual({ box: text, at: y, warnings: [] })
  return { warnings, recorded, place, shows }
}

// BACK AND FORWARD ACROSS A RELOAD (the owner, 2026-11-17: after a reload, Back and Forward onto the entries
// from before it logged the history handler's warnings, and the page did not follow). The browser keeps
// those entries across a reload, each with its state object and its index, while the page starts a new
// session: one that numbered its entries from 0 again read the kept ones as its own by their old indexes,
// warned (an out-of-bounds index, an inconsistent state, the current index), stayed where it was and
// overwrote each entry it landed on with a copy of one of its own. The session continues at the kept entry's
// index instead, and takes an entry it does not know as the browser holds it. Two reloads: on the first view
// with two entries ahead of it (a reload there writes nothing, so Forward still has them), then on an
// item's view (the reloaded page pushes its own first view and the address's query after the kept entry).
// Every entry reached shows its own query and its own scroll position, each position set by hand so that no
// two entries share one. The items are the navigation row's
test('Back and Forward across a reload reach the entries from before it, each with its query and its scroll position, and the history handler warns of nothing', async ({ page }) => {
  const { recorded, place, shows } = historyReads(page)

  await loadAdmin(page)
  const top = await headerTop(page)
  await nearTop(page, 'the page loads at the header')
  // two entries after the first view's, a query and a position each: a typed query, then a tag click from its item
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_source')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  await blur(page)
  await place(40)
  const [, index] = await entries(page) // the typed query's entry; the first view's is the one before it
  // the tag is brought into view before its click (a click's own scroll would move the page under the
  // entry being left, whose position is whatever was recorded last)
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  const tag = page.locator(`#item-${sourceId} mark[title="#e2e_target"]`)
  await tag.scrollIntoViewIfNeeded()
  await recorded()
  const atSource = await scrollTop(page)
  await tag.click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  const atTarget = await place(80)
  expect(await entries(page), 'the tag click pushed its entry').toEqual([index + 2, index + 1])
  expect(Math.min(atSource - top, Math.abs(atSource - atTarget)), 'three positions, none near another').toBeGreaterThan(30)
  await page.goBack()
  await shows('#e2e_source', atSource, 'Back within the session')
  await page.goBack()
  await shows('', top, 'Back to the first view')
  await recorded()

  // (1) a reload on the first view: the page starts on the entry the browser kept and writes nothing (the
  // same query and order), so the two entries ahead are still there
  await page.reload()
  await waitForApp(page)
  await shows('', top, 'the reloaded page is at the header')
  expect(await page.evaluate(() => history.state.index), 'the reloaded page is on the kept entry').toBe(index - 1)
  await page.goForward()
  await shows('#e2e_source', atSource, 'Forward onto an entry from before the reload')
  expect(await page.evaluate(() => location.hash)).toBe('#e2e_source')
  expect(await entries(page), 'the session continued at the kept index').toEqual([index + 1, index])
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward onto the next one')
  await page.goBack()
  await shows('#e2e_source', atSource, 'Back in the reloaded session')
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward again')
  await recorded()

  // (2) a reload on an item's view: the reloaded page pushes its own first view and the address's query
  // after the kept entry; Back passes both and reaches the entries from before the two reloads
  await page.reload()
  await waitForApp(page)
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await recorded()
  expect(await entries(page), 'the session continued at the kept index: its own two entries follow it').toEqual([index + 4, index + 3])
  await page.goBack()
  await shows('', top, "Back to the reloaded page's own first view, at the header")
  await page.goBack()
  await shows('#e2e_target ', atTarget, 'Back onto the entry the page was reloaded on')
  await page.goBack()
  await shows('#e2e_source', atSource, 'Back onto the entry before it')
  await page.goBack()
  await shows('', top, 'Back to the first view')
  expect(await entries(page), 'every entry in its place').toEqual([index + 4, index - 1])
})

// the entries of the two startup rows below, over the navigation row's items: the first view, a typed query,
// a tag click's entry left 400 px below the header, and a second typed query (it names an item and is not
// final); `index` is the first query's entry
const threeQueries = async (page: Page, { recorded, place }: ReturnType<typeof historyReads>) => {
  await loadAdmin(page)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_source')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  await blur(page)
  const [, index] = await entries(page) // the first query's entry
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  const tag = page.locator(`#item-${sourceId} mark[title="#e2e_target"]`)
  await tag.scrollIntoViewIfNeeded()
  await recorded()
  await tag.click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  const atTarget = await place(400) // far enough from the header to tell the entry's position from a return there
  // the last query is set as a todo's row sets one, from a blurred box: it applies at once (a typed query
  // waits out its debounce with the box focused, the page scrolls to it meanwhile and the scroll listener
  // records that position on the entry being left: 640 for an entry left at 672, the reading of review 1)
  await page.evaluate(() => void (window as any).MindBox.set('#e2e_target/sub'))
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_target/sub')
  await recorded()
  const atSub = await scrollTop(page)
  expect(await entries(page), "the second query's entry, pushed after the tag click's").toEqual([index + 3, index + 2])
  expect(await page.evaluate(i => [(window as any)._history[i].scrollPosition, (window as any)._history[i + 1].final], index + 1), "the tag click's entry keeps the position it was left at; the last entry is not final").toEqual([atTarget, false])
  return { index, atTarget, atSub }
}

// BACK WHILE A RELOADED PAGE IS STILL STARTING (review 1 of scroll_history, 2026-11-17). The browser moves at
// once; the page can apply nothing yet. The session took its index when the page was created and the
// handler returned before initialization, so the startup wrote the first view over the entry REACHED under
// the index of the entry LEFT, dropped the entries ahead, and pushed the departed entry's fragment: from
// then on a history link's distance was off. The session takes its place from the entry the browser is on
// when the corpus is ready, writes nothing over an entry reached this way, and applies its view once
// initialized. Four entries (the first view, a typed query, a tag click's, a typed query again), a reload
// on the last one with the index build stalled (the app's seam, `_initialize_stall_ms`), Back during the
// stall; then the entries ahead and behind, and the list above the header: its link to the first query is
// a jump of two entries
test('Back while a reloaded page is still starting shows the entry it reaches once the page is ready, keeps the entries ahead, and a history link lands on the entry it names', async ({ page }) => {
  const reads = historyReads(page)
  const { warnings, shows } = reads
  const { index, atTarget, atSub } = await threeQueries(page, reads)

  // the reload on the last entry, its index build stalled; Back while the page is still starting
  // every position the page is asked to scroll to is noted beside the app, from the reloaded page's start
  await page.addInitScript(() => {
    window._initialize_stall_ms = 3_000
    const asked: number[] = ((window as any).__asked = [])
    const scrollTo = Element.prototype.scrollTo as (...args: any[]) => void
    Element.prototype.scrollTo = function (this: Element, ...args: any[]) {
      if (this === document.body) asked.push(typeof args[0] == 'object' ? args[0].top : args[1])
      return scrollTo.apply(this, args)
    }
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => window._init_time > 0)).toBe(true)
  await page.goBack()
  await expect(page.locator('#sapper > .loading'), 'Back arrived before the page was initialized').toHaveClass(/visible/)
  await waitForApp(page)
  // where the entry was left, 400 px below the header: the page was ASKED for that position (the saved value
  // came through the wait: a scroll write built on the live state object, then not written, changes what
  // the replay reads to the starting page's own position, review 2) and stands there, not at the header and
  // not at the item the query names, where every layout of a starting page scrolls
  await shows('#e2e_target ', atTarget, 'the entry Back reached, shown once the page was ready, where it was left')
  expect(await page.evaluate(() => (window as any).__asked.map(Math.round)), 'the page was asked for the position the entry was left at').toContain(atTarget)
  expect(await page.evaluate(() => [history.state.index, location.hash]), "the browser's entry is the one reached, as it was").toEqual([index + 1, '#e2e_target'])
  expect(await entries(page), 'the session is on that entry').toEqual([index + 2, index + 1])
  // the entries ahead and behind are where they were
  await page.goForward()
  await shows('#e2e_target/sub', atSub, 'Forward: the entry the page was reloaded on, kept')
  await page.goBack()
  await shows('#e2e_target ', atTarget, 'Back')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward')
  await page.goForward()
  await shows('#e2e_target/sub', atSub, 'Forward again')
  // the list above the header names the two earlier queries; the link to the first one is two entries back
  const links = page.locator('.history-item')
  await expect(links).toHaveText(['#e2e_source', '#e2e_target'])
  await links.first().click()
  await expect(mindbox(page), 'the link lands on the entry it names').toHaveValue('#e2e_source')
  expect(await page.evaluate(() => [history.state.index, (window as any)._history_index])).toEqual([index, index])
  await page.goForward()
  await expect(mindbox(page), 'one entry ahead of it').toHaveValue('#e2e_target ')
  expect(warnings).toEqual([])
})

// BACK BETWEEN A RELOADED PAGE'S INITIALIZATION AND ITS LAUNCH FRAGMENT (review 2 of scroll_history,
// 2026-11-17). The launch's fragment is handled after the page is initialized, once the welcome is over and
// the frames after it have passed. A reload on a query that names an item, its entry not final, replaces
// that entry with the first view and keeps the address's fragment for that later step; Back in between was
// restored by the ordinary handler, and the step then pushed the departed entry's query over the entry
// reached and dropped the entry ahead. A traversal that the page follows now drops the pending fragment.
// The step and the welcome work after it wait for the row's release (the app's seam,
// `_launch_fragment_gate`; `_launch_fragment_done` marks the step). The entry reached stays WHERE IT WAS LEFT
// through the layouts that applying its query causes (review 3: restored at 1012 px, the page stood at the
// item the query names, 418 px on, a few seconds later, and the scroll listener recorded that over the
// entry's position).
// Then A NATIVE FRAGMENT NAVIGATION (review 3), as `location.hash` makes one: the browser adds a position of
// its own, and the handler added a second one after it for the query the fragment names (a link then landed
// on the position between); for a fragment that names nothing the old links stayed and the next scroll write
// copied the entry onto the position. The named query now takes the browser's position, as the first entry
// of a new run; an unnamed fragment's position holds no entry, like a rejected one
test("Back after a reloaded page is initialized and before its launch fragment is handled shows the entry reached, keeps it where it was left and keeps the entry ahead; a native fragment navigation takes the browser's own position under a new numbering, and one that names nothing is no entry's", async ({ page }) => {
  const reads = historyReads(page)
  const { warnings, shows, recorded } = reads
  const errors: string[] = [] // a fragment's decoding error, should one reach the page
  page.on('pageerror', error => void (/URI/.test(String(error)) && errors.push(String(error))))
  const { index, atTarget } = await threeQueries(page, reads)
  const top = await headerTop(page)
  const length = await page.evaluate(() => history.length)
  const links = page.locator('.history-item') // the list above the header
  // no layout for a second: the layouts that applying a query causes (its items rendering) have run
  const quiet = async () => {
    let last = -1
    await expect
      .poll(
        async () => {
          const now = await page.evaluate(() => (window as any).__layoutCount as number)
          const still = now === last
          last = now
          return still
        },
        { message: 'the layouts have run', intervals: [1_000], timeout: 30_000 }
      )
      .toBe(true)
  }
  await page.addInitScript(() => void ((window as any)._launch_fragment_gate = new Promise<void>(resolve => void ((window as any)._release_launch_fragment = resolve))))
  await page.reload()
  await waitForApp(page)
  const step = () => page.evaluate(() => (window as any)._launch_fragment_done === true)
  await shows('', top, 'the reloaded page: its first view, the fragment of its address not handled yet')
  await page.goBack()
  await shows('#e2e_target ', atTarget, 'the entry Back reached, where it was left')
  expect(await step(), "the launch's fragment had not been handled").toBe(false)
  await page.evaluate(() => (window as any)._release_launch_fragment())
  await expect.poll(step, { message: "the launch's fragment step has run" }).toBe(true)
  // settled: the layouts of the restored query have run and the scroll listener has written
  await quiet()
  await recorded()
  await shows('#e2e_target ', atTarget, "still the entry reached, where it was left: the departed entry's fragment was dropped, and no layout of its query moved the page")
  expect(
    await page.evaluate(i => [history.state.index, history.state.editorText, history.state.scrollPosition, (window as any)._history[i].scrollPosition, history.length], index + 1),
    'no entry was pushed, and the entry holds the position it was left at'
  ).toEqual([index + 1, '#e2e_target ', atTarget, atTarget, length])
  // the entry ahead is the one the page was reloaded on, as its launch left it: the first view
  await page.goForward()
  await shows('', top, 'Forward: the entry ahead, kept')
  expect(await page.evaluate(() => [history.state.index, history.length])).toEqual([index + 2, length])

  // a native fragment that names an item: ONE position more, the named query on it as entry 0 of a new run,
  // and no link back (how far the earlier entries are from it is not known)
  const run = await page.evaluate(() => history.state.run)
  await page.evaluate(() => void (location.hash = '#e2e_source'))
  await expect(mindbox(page)).toHaveValue('#e2e_source ')
  expect(await page.evaluate(() => [history.state.index, history.state.editorText, history.length]), "the browser's own position holds the entry").toEqual([0, '#e2e_source ', length + 1])
  expect(await page.evaluate(() => history.state.run), 'a new run').not.toBe(run)
  expect(await entries(page)).toEqual([1, 0])
  await expect(links).toHaveCount(0)
  // Back is the entry before it, of the earlier run; Forward from there is the fragment's entry again
  await page.goBack()
  await shows('', top, 'Back: the entry the fragment was navigated from')
  expect(await page.evaluate(() => [history.state.index, history.state.run])).toEqual([index + 2, run])
  await page.goForward()
  await expect(mindbox(page), "Forward: the fragment's entry").toHaveValue('#e2e_source ')
  expect(await page.evaluate(() => [history.state.index, history.length])).toEqual([0, length + 1])
  // the same item by its ALIAS, its id: the query and the order are the ones shown, and the browser's new
  // position is the query's entry all the same, the first of another run (left to the writer's test for a
  // change, it became a cleared position under the named item's view, and a return to it later left
  // whatever view was shown then: review 4)
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  const aliased = await page.evaluate(() => history.state.run)
  await page.evaluate(id => void (location.hash = '#' + id), sourceId)
  await expect.poll(() => page.evaluate(() => [history.length, history.state?.index, history.state?.editorText, location.hash]), { message: "the alias's position holds the entry" }).toEqual([length + 2, 0, '#e2e_source ', '#e2e_source'])
  expect(await page.evaluate(() => history.state.run), 'another run').not.toBe(aliased)
  await expect(mindbox(page)).toHaveValue('#e2e_source ')
  expect(await entries(page)).toEqual([1, 0])
  // two more entries of that run, and a real link among them: one entry ahead
  await page.locator(`#item-${sourceId} mark[title="#e2e_target"]`).click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await page.evaluate(() => void (window as any).MindBox.set('#e2e_target/sub'))
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_target/sub')
  expect(await entries(page)).toEqual([3, 2])
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source ')
  await expect(links).toHaveText(['#e2e_source', '#e2e_target'])
  await links.nth(1).click()
  await expect(mindbox(page), 'the link lands on the entry it names').toHaveValue('#e2e_target ')
  expect(await page.evaluate(() => [history.state.index, (window as any)._history_index])).toEqual([1, 1])

  // a native fragment that names nothing: its position holds no entry (cleared, no link from it, nothing
  // written by a scroll there), the page stays, and Back is the entry it was navigated from
  await recorded()
  const before = await page.evaluate(() => [(window as any)._history_index, (window as any)._history[1].scrollPosition, history.length])
  await page.evaluate(() => void (location.hash = '#e2e_no_such_item'))
  const CLEARED = JSON.stringify({ owner: 'admin|anonymous|', unknown: true, fragment: true })
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(CLEARED)
  await expect(mindbox(page), 'the page stays').toHaveValue('#e2e_target ')
  await expect(links).toHaveCount(0)
  await page.evaluate(() => document.body.scrollTo(0, document.body.scrollTop + 150))
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300))) // the scroll listener's write comes 250 ms after a scroll
  await expect.poll(() => page.evaluate(() => (window as any)._history_update_pending)).toBe(false)
  expect(await page.evaluate(() => [JSON.stringify(history.state), (window as any)._history_index, (window as any)._history[1].scrollPosition, history.length]), 'nothing written on it').toEqual([CLEARED, ...before])
  await page.goBack()
  await expect.poll(() => page.evaluate(() => history.state?.index), { timeout: 10_000 }).toBe(1)
  await shows('#e2e_target ', before[1], 'Back: the entry it was navigated from, where it was left')
  await expect(links).toHaveText(['#e2e_source', '#e2e_target'])
  // Forward onto it again: NO STOP at a native fragment's own position (the stop, below: this position lies
  // between the notebook's own entries, and the entries before it are reached through it). The browser
  // stays on it and the page as it is, without a note: no return is asked for (the calls are counted)
  await page.evaluate(() => {
    const w = window as any
    const real = w.navigation.traverseTo.bind(w.navigation)
    w.__returnsAsked = 0
    w.navigation.traverseTo = (...args: unknown[]) => (w.__returnsAsked++, real(...args))
  })
  await page.goForward()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(CLEARED)
  await settled(page)
  expect(await page.evaluate(() => [JSON.stringify(history.state), document.querySelectorAll('.stop-note.visible').length, (window as any).__returnsAsked]), "no return from a fragment's own position, and no note").toEqual([CLEARED, 0, 0])
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await page.goBack()
  await expect.poll(() => page.evaluate(() => history.state?.index), { timeout: 10_000 }).toBe(1)
  await shows('#e2e_target ', before[1], 'Back again: the entry before it')

  // a MALFORMED fragment (a `%` that is no escape: decoding it throws) names nothing either, and the leave to
  // take a fragment's position ends with its handler: Back, a new query, and Back from that is the original
  // query (the handler threw with the leave still set, and the new query's entry then replaced the entry it
  // was made from: review 4)
  await page.evaluate(() => void (location.hash = '#100%'))
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#100%')
  await page.goBack()
  await expect.poll(() => page.evaluate(() => [history.state?.index, location.hash]), { timeout: 10_000 }).toEqual([1, '#e2e_target'])
  await page.evaluate(() => void (window as any).MindBox.set('#e2e_source'))
  await expect.poll(() => page.evaluate(() => [history.state?.index, history.state?.editorText]), { timeout: 10_000 }).toEqual([2, '#e2e_source'])
  await page.goBack()
  await expect(mindbox(page), 'Back from the new query: the original query, its entry intact').toHaveValue('#e2e_target ')
  expect(await page.evaluate(() => [history.state.index, history.state.editorText])).toEqual([1, '#e2e_target '])
  // its position is cleared like any fragment's that names nothing, and a page LAUNCHED on such an address
  // starts: its first view
  await page.evaluate(() => void (location.hash = '#100%'))
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(CLEARED)
  await page.reload()
  await waitForApp(page)
  await expect(mindbox(page)).toHaveValue('')
  expect(errors, 'no decoding error reached the page').toEqual([])
  expect(warnings).toEqual([])
})

// THE STOP (the owner, 2026-11-18: "if i go back twice past the start, i have to come forward twice as well;
// i'm a bit puzzled why we don't just stop at starting point"). Back or Forward onto a position that holds
// no entry of the notebook's that the app can take (one of the app's older code here, which names no owner:
// every earlier entry of a window that was open across the release of 2026-11-17) moved the browser while
// the page stayed. The browser has moved before the app hears of it, so the app goes back at once to the
// position of the entry the page shows (by the Navigation API's key) and the page stays EXACTLY as it is; a
// note says why nothing moved. The two rows share the fixture: the three queries' entries, the first query's
// rewritten as older code wrote one and the first view's as another script's state (no index), and the page
// on the tag click's entry with one entry ahead
const asOlderCode = (page: Page) =>
  page.evaluate(() => {
    const { index, editorText, scrollPosition } = history.state
    history.replaceState({ index, editorText, scrollPosition }, '')
  })
const olderEntryBehind = async (page: Page, reads: ReturnType<typeof historyReads>) => {
  const { index, atTarget, atSub } = await threeQueries(page, reads)
  await page.goBack()
  await reads.shows('#e2e_target ', atTarget, "Back to the tag click's entry")
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await reads.recorded()
  await page.evaluate(() => history.replaceState({ custom: true }, ''))
  await page.goForward()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await reads.recorded()
  await asOlderCode(page)
  await page.goForward()
  await reads.shows('#e2e_target ', atTarget, "the tag click's entry, an entry of older code behind it and one entry ahead")
  await reads.recorded()
  return { index, atTarget, atSub }
}
// the note of a stop: passive since 2026-11-19 (noteStop in index.svelte), no longer the app's modal
const note = (page: Page) => page.locator('.stop-note.visible')
// (a restore scrolls from a later frame, and a modal is shown from a promise's callback: two frames and the
// timers due, no fixed wait)
const settled = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve)))))
// read ONCE, never polled: the note goes by itself, so a poll would pass on a note that should not have shown
// or should have gone at a key
const noNote = async (page: Page, message: string) => {
  await settled(page)
  expect(await note(page).count(), message).toBe(0)
}
// the note goes at the next key: Shift, which the page does nothing with (where a row only needs the note
// gone; a press would act on whatever is under the pointer, since the note passes it through)
const passNote = async (page: Page) => {
  await page.keyboard.press('Shift')
  await noNote(page, 'the note goes at the next key')
}
// the page hidden and shown again by its own visibility events, raised as tests/e2e/lifecycle.spec.ts raises
// them (the driver's Chromium never hides a page): the notes shown before, and a task after the hiding
const hiddenAndShown = (page: Page) =>
  page.evaluate(async () => {
    const notes = () => document.querySelectorAll('.stop-note.visible').length
    const before = notes()
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise(resolve => setTimeout(resolve))
    const after = notes()
    delete (document as any).visibilityState // the prototype's own reading again
    document.dispatchEvent(new Event('visibilitychange'))
    return [before, after]
  })

test('Back onto an entry of older code stops: the browser returns at once to the entry the page shows, the page stays as it is and a note says so; Forward still reaches the entry ahead; a jump onto a state without an index stops as quietly; a second Back stops again; the note, passive, also while the MindBox or an editor has the focus, which keeps it: nothing scrolls, a key or a press goes to the page as it would, typing goes on across the stop, and the note goes by itself, at that key or press, at the next traversal and when the page is hidden; it is drawn where a reader sees it, over another dialog and the narration camera too; without the Navigation API the page stays on the position as before', async ({ page }) => {
  const reads = historyReads(page)
  const { warnings, recorded, shows } = reads
  const { index, atTarget, atSub } = await olderEntryBehind(page, reads)
  const targetId = await page.evaluate(() => window._item('#e2e_target')!.id)
  // what would show a restore, a jump or a re-render: every state a traversal brings, every position the
  // page is asked for, every scroll and every change of the list above the header (`moves`), the layout
  // passes run and the shown item's element
  // (every warning and error of the console from here on, the handler's own among them; not the browser's
  // note on a stylesheet preloaded and not used, which comes a few seconds after a load whatever the page does)
  const noise: string[] = []
  page.on('console', msg => void (['warning', 'error'].includes(msg.type()) && !msg.text().includes('was preloaded using link preload') && noise.push(msg.text())))
  await page.evaluate(id => {
    const w = window as any
    w.__moves = []
    const scrollTo = Element.prototype.scrollTo as (...args: any[]) => void
    Element.prototype.scrollTo = function (this: Element, ...args: any[]) {
      if (this === document.body) w.__moves.push('asked')
      return scrollTo.apply(this, args)
    }
    document.body.addEventListener('scroll', () => w.__moves.push('scrolled'))
    window.addEventListener('popstate', e => w.__moves.push(e.state?.unknown ? 'cleared' : e.state?.owner ? `own ${e.state.index}` : 'index' in (e.state ?? {}) ? 'older' : 'custom'), true)
    new MutationObserver(() => w.__moves.push('list')).observe(document.querySelector('.history-container')!, { childList: true, subtree: true, characterData: true, attributes: true })
    w.__shown = document.getElementById('item-' + id)
  }, targetId)
  const moves = (): Promise<string[]> => page.evaluate(() => (window as any).__moves.splice(0))
  const traversed = () => page.evaluate(() => (window as any).__moves.filter((move: string) => /^(own|cleared|older|custom)/.test(move))) // the states the traversals brought, so far
  const still = () =>
    page.evaluate(id => {
      const w = window as any
      return {
        box: (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value,
        at: document.body.scrollTop,
        layouts: w.__layoutCount,
        element: w.__shown === document.getElementById('item-' + id) && w.__shown.isConnected,
        links: [...document.querySelectorAll('.history-item')].map(e => (e.textContent ?? '').trim()),
        entry: [history.state.index, history.state.editorText, history.state.scrollPosition, location.hash],
        session: [w._history.length, w._history_index],
      }
    }, targetId)
  const HERE = { box: '#e2e_target ', at: atTarget, element: true, links: ['#e2e_source', '#e2e_target'], entry: [index + 1, '#e2e_target ', atTarget, '#e2e_target'], session: [index + 3, index + 1] }

  // (1) Back onto the entry of older code: the browser went there and came back, and nothing else happened
  const before = await still()
  expect(before).toMatchObject(HERE)
  await page.goBack()
  await expect(note(page), 'the note of a stop after Back').toHaveText('nothing to go back to')
  await settled(page)
  expect(await moves(), 'the entry of older code, then the entry the page shows again: no position asked for, no scroll, the list untouched').toEqual(['older', `own ${index + 1}`])
  expect(await still(), 'the page is exactly as it was: its view, the MindBox, the position, its entry, the list above the header').toEqual(before)
  // Back again with the note still shown: the same stop, on the position the first one cleared, and one note
  await page.goBack()
  await expect.poll(() => page.evaluate(() => (window as any).__moves), { message: 'a stop while the note shows' }).toEqual(['cleared', `own ${index + 1}`])
  await moves()
  // it has no button, and it goes at the next key, which reaches the page (Shift: nothing else happens)
  await expect(note(page).locator('.button')).toHaveCount(0)
  await passNote(page)
  await recorded()
  expect(await still(), 'after the note: the viewport and the saved position are where they were').toEqual(before)
  expect({ noise, warnings }, 'nothing warned in the console').toEqual({ noise: [], warnings: [] })
  // a JUMP of two positions, onto a state that is no entry at all (another script's: no index): the same stop,
  // back to the entry by its key, and the console as quiet (such a state was cleared with a warning)
  await page.evaluate(() => history.go(-2))
  await expect(note(page), 'the note of a stop after a jump').toHaveText('nothing to go back to')
  await settled(page)
  expect(await moves(), 'the state without an index, then the entry the page shows again').toEqual(['custom', `own ${index + 1}`])
  expect(await still()).toEqual(before)
  expect({ noise, warnings }, 'nothing warned in the console, for a state without an index either').toEqual({ noise: [], warnings: [] })

  // (2) Forward still reaches the entry ahead, pressed WHILE THE NOTE OF THE JUMP SHOWS: the browser's own
  // Forward is no key and no press of the page's, and the note goes as the entry lands (until review 0 of
  // back_note it stayed for the rest of its three seconds, and the entry ahead said "nothing to go back
  // to"). It is read a task after the landing's popstate, before the entry's layouts and its scroll are
  // waited for. Then Back from the entry ahead, and Back again THE MOMENT THAT ONE HAS LANDED
  // (from a listener of the row's, which runs after the app's: before any write on the entry reached): the
  // second one stops, and returns to the entry the first one reached, the position noted when it landed
  // (the entry ahead is given a position of its own first: its write notes ITS position, the last one noted
  // before the two Backs)
  const showing = await page.evaluate(() => {
    const w = window as any
    w.__noteAtLanding = undefined
    window.addEventListener('popstate', () => void setTimeout(() => (w.__noteAtLanding = document.querySelector('.stop-note.visible')?.textContent ?? null)), { once: true })
    return document.querySelectorAll('.stop-note.visible').length
  })
  expect(showing, 'the premise: the note still shows as Forward is pressed').toBe(1)
  await page.goForward()
  await expect.poll(() => page.evaluate(() => (window as any).__noteAtLanding), { message: 'no note once the entry ahead has landed' }).toBe(null)
  await shows('#e2e_target/sub', atSub, 'Forward: the entry ahead, kept')
  expect(await reads.place(200), 'the entry ahead, at a position of its own').not.toBe(atTarget)
  await moves()
  await page.evaluate(() => void window.addEventListener('popstate', () => history.back(), { once: true }))
  await page.goBack()
  await expect(note(page), 'Back from the entry ahead, and at once Back again: a stop').toHaveText('nothing to go back to')
  // the note goes when the page is hidden (a hidden page's timers can be held, and it would come back with the old note)
  expect(await hiddenAndShown(page), 'the note shown, and gone once the page is hidden').toEqual([1, 0])
  await shows('#e2e_target ', atTarget, 'the entry the first Back reached, restored where it was left')
  expect((await moves()).filter(move => /^(own|cleared|older)/.test(move)), 'the entry reached, the cleared position, the entry reached again').toEqual([`own ${index + 1}`, 'cleared', `own ${index + 1}`])
  await recorded()
  expect(await still()).toMatchObject(HERE)
  await noNote(page, 'no note came back with the page shown again')

  // (3) Back once more, onto the cleared position, stops the same way. The MindBox holds the focus this
  // time, out of view above the window: the note shows all the same and takes nothing (a modal blurred the
  // box and gave the focus back with a scroll to it, which the scroll listener saved; until 2026-11-19 no
  // note was shown here): the box keeps the focus, no position is asked for and nothing scrolls, the box
  // stays above the window. Then the note goes by itself, and nothing moves then either
  const boxAbove = () => page.evaluate(() => document.getElementById('textarea-mindbox')!.getBoundingClientRect().bottom < 0)
  await focusMindboxInPlace(page)
  await expect(mindbox(page)).toBeFocused()
  expect(await boxAbove(), 'the MindBox is above the window').toBe(true)
  await recorded()
  await moves()
  await page.goBack()
  await expect.poll(traversed, { message: 'a second Back stops again, with the MindBox focused' }).toEqual(['cleared', `own ${index + 1}`])
  await expect(note(page), 'the note, with the MindBox focused').toHaveText('nothing to go back to')
  // (what a reader sees, not the class and the words alone: the element is rendered, inside the window)
  await expect(note(page), 'the note is rendered visible').toBeVisible()
  await expect(note(page), 'inside the window').toBeInViewport()
  await settled(page)
  await expect(mindbox(page), 'the MindBox keeps the focus while the note shows').toBeFocused()
  expect(await moves(), 'the two traversals alone: no position asked for, no scroll').toEqual(['cleared', `own ${index + 1}`])
  expect(await still(), 'the viewport and the saved position are where they were').toMatchObject(HERE)
  expect(await boxAbove(), 'the MindBox is still above the window').toBe(true)
  await expect(note(page), 'the note goes by itself').toHaveCount(0, { timeout: 10_000 })
  await settled(page)
  await recorded()
  expect(await moves(), 'nothing moved as it went').toEqual([])
  expect(await still(), 'the viewport and the saved position, once the note has gone').toMatchObject(HERE)
  await expect(mindbox(page), 'the MindBox still has the focus').toBeFocused()
  expect(await boxAbove(), 'and is still above the window').toBe(true)
  await blur(page)

  // (4) a press while the note shows goes to the page, AT THE NOTE'S OWN PLACE: the item's text is brought
  // under the middle of the window, where the note stands, and a stop is made with nothing focused. The hit
  // test at the note's centre answers with the paragraph under it, and a press there (by the mouse, which no
  // driver check holds back) opens the item's editor, the note gone at that press. Before the press, the
  // NARRATION CAMERA is stood in for (Webcam.svelte: the camera at z-index 1000 and its title at 1001; in
  // intro mode the camera covers the middle of the window; no camera is asked for here): two opaque boxes
  // of those layers over the note, beside it in the document as the camera's are. The pointer then goes to
  // the camera, through the note, and with the note made hittable for the reading it is the note that lies
  // on top of both (at 101 it lay under the camera). Then the editor holds the focus, with typed text not
  // saved: the stop shows the note there too (none until 2026-11-19: a modal takes the focus and every key
  // until it is dismissed), the editor keeps the focus, and the typing goes on where it was, the first key
  // typed included, at which the note goes
  const paragraph = page.locator(`#item-${targetId} p`).first()
  await paragraph.evaluate(p => {
    const r = p.getBoundingClientRect()
    document.body.scrollBy(0, Math.round(r.top + r.height / 2 - innerHeight / 2))
  })
  await recorded()
  await moves()
  await page.goBack()
  await expect.poll(traversed, { message: 'the stop, nothing focused' }).toEqual(['cleared', `own ${index + 1}`])
  await expect(note(page), 'the note, nothing focused').toHaveText('nothing to go back to')
  const place = await page.evaluate(id => {
    const shown = document.querySelector('.stop-note.visible') as HTMLElement
    const r = shown.getBoundingClientRect()
    const [x, y] = [r.left + r.width / 2, r.top + r.height / 2]
    const hit = () => document.elementFromPoint(x, y)
    const under = hit()
    const [camera, title] = [1000, 1001].map(layer => {
      const box = document.createElement('div')
      box.style.cssText = `position: fixed; z-index: ${layer}; width: 68.75vw; height: 50vw; right: 15.625vw; bottom: 0; background: #246`
      return shown.parentElement!.appendChild(box)
    })
    const through = hit()
    shown.style.pointerEvents = 'auto'
    const top = hit()
    shown.style.pointerEvents = ''
    camera.remove()
    title.remove()
    const name = (e: Element | null) => (e === shown ? 'the note' : e === title ? "the camera's title" : e === camera ? 'the camera' : e === document.querySelector(`#item-${id} p`) ? 'the paragraph' : (e?.tagName ?? null))
    return { x, y, under: name(under), through: name(through), top: name(top) }
  }, targetId)
  expect(place, "at the note's centre the pointer goes to what is under the note, and the note lies on top of the camera's layers").toMatchObject({ under: 'the paragraph', through: "the camera's title", top: 'the note' })
  await page.mouse.click(place.x, place.y)
  const textarea = page.locator(`#textarea-${targetId}`)
  await expect(textarea, "the press at the note's centre went to the page: the editor is open").toBeFocused()
  await noNote(page, 'the note goes at the press')
  const saved = await textarea.inputValue()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.type(' typed')
  await expect(textarea).toHaveValue(saved + ' typed')
  await recorded()
  await moves()
  await page.goBack()
  await expect.poll(traversed, { message: 'the stop, with an editor focused' }).toEqual(['cleared', `own ${index + 1}`])
  await expect(note(page), "the note, with an item's editor focused").toHaveText('nothing to go back to')
  await expect(textarea, 'the editor keeps the focus while the note shows').toBeFocused()
  await page.keyboard.type(' on')
  await expect(textarea, 'the typing goes on in the editor, the first key included').toHaveValue(saved + ' typed on')
  await noNote(page, 'the note goes at the first key typed')
  await textarea.fill(saved)
  await page.keyboard.press('Escape')
  await expect(textarea).toBeHidden()

  // (5) another dialog is open: the note shows over it (until 2026-11-19 none was shown while a dialog was
  // open: the guard returned at once), the dialog stays as it is, the pointer at the note's centre goes to
  // the dialog under it, and a press on the dialog's button reaches the button
  const dialog = page.locator('.background.visible .modal')
  await page.evaluate(() => void (window as any)._modal('a dialog of the page', { confirm: 'OK' }))
  await expect(dialog).toContainText('a dialog of the page')
  await moves()
  await page.goBack()
  await expect.poll(traversed, { message: 'the stop, with a dialog open' }).toEqual(['cleared', `own ${index + 1}`])
  await expect(note(page), 'the note, over the dialog').toHaveText('nothing to go back to')
  await expect(dialog, 'the dialog stays').toContainText('a dialog of the page')
  expect(
    await page.evaluate(() => {
      const shown = document.querySelector('.stop-note.visible')!
      const r = shown.getBoundingClientRect()
      const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return [shown.contains(under), !!under?.closest('.background.visible')]
    }),
    "at the note's centre the pointer goes to the dialog, not to the note"
  ).toEqual([false, true])
  await dialog.locator('.button.confirm').click()
  await expect(dialog, 'the press confirmed the dialog').toHaveCount(0)
  await noNote(page, 'and the note went at it')

  // (5b) typing in the MindBox ACROSS a stop: the note shows, a character typed before it and one typed
  // while it shows are both in the box, which keeps the focus, and the note goes at that key. The typed
  // query then applies as any edit of a final entry does (a new entry), and Back from it is the entry again
  await focusMindboxInPlace(page, '#e2e_target '.length)
  await page.keyboard.type('x')
  await moves()
  await page.goBack()
  await expect.poll(traversed, { message: 'the stop, between two typed characters' }).toEqual(['cleared', `own ${index + 1}`])
  await expect(note(page), 'the note, between two typed characters').toHaveText('nothing to go back to')
  await page.keyboard.type('y')
  await expect(mindbox(page), 'both characters are in the box').toHaveValue('#e2e_target xy')
  await expect(mindbox(page)).toBeFocused()
  await noNote(page, 'the note goes at the key typed')
  await expect.poll(() => page.evaluate(() => [history.state?.index, history.state?.editorText]), { message: 'the typed query, applied as an edit of the entry', timeout: 10_000 }).toEqual([index + 2, '#e2e_target xy'])
  await blur(page)
  await page.goBack()
  await expect.poll(() => page.evaluate(() => [history.state?.index, history.state?.editorText]), { timeout: 10_000 }).toEqual([index + 1, '#e2e_target '])
  await expect(mindbox(page)).toHaveValue('#e2e_target ')

  // (6) WITHOUT THE NAVIGATION API (hidden here, as in a browser that lacks it) no return can be said: the
  // page stays on the position, as before the stop, with no note, no link from it and nothing warned;
  // Forward restores the entry
  await page.evaluate(() => void Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }))
  await page.goBack()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state)), { message: 'the position, cleared at the first Back, and the browser still on it' }).toBe(JSON.stringify({ owner: 'admin|anonymous|', unknown: true }))
  await noNote(page, 'no note without a stop')
  await expect(mindbox(page), 'the page stays as it is').toHaveValue('#e2e_target ')
  await expect(page.locator('.history-item'), 'no link from a position that holds no entry').toHaveCount(0)
  await page.goForward()
  await expect.poll(() => page.evaluate(() => history.state?.index), { timeout: 10_000 }).toBe(index + 1)
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await expect(page.locator('.history-item')).toHaveCount(2)
  expect({ noise, warnings }, 'nothing warned in the console').toEqual({ noise: [], warnings: [] })
})

// THE STOP WHILE A PAGE IS STILL STARTING. Back during a reload moves the browser before the page shows any
// entry (the early-Back row above: the position reached is applied once the page is initialized, and nothing
// is written at startup). When that position holds no entry the app can take, the browser returns to the
// entry the page was created on, one of the notebook's by the identity noted then, and that entry is shown
// as any entry reached: its query, where it was left. Nothing is written on the way, so the entry ahead is
// kept; the position reached is cleared
test('Back while a reloaded page is still starting, onto an entry of older code, stops once the page is ready: the browser returns to the entry the page was reloaded on, shown where it was left with the note, and the entry ahead is kept; a page reloaded on a cleared position makes no return to it', async ({ page }) => {
  const reads = historyReads(page)
  const { warnings, shows } = reads
  const { index, atTarget, atSub } = await olderEntryBehind(page, reads)
  await page.addInitScript(() => {
    window._initialize_stall_ms = 3_000
    window.addEventListener('popstate', e => ((window as any).__moves ??= []).push(e.state?.unknown ? 'cleared' : e.state?.owner ? `own ${e.state.index}` : 'index' in (e.state ?? {}) ? 'older' : 'custom'), true)
    // every return the page asks for
    const w = window as any
    const real = w.navigation.traverseTo.bind(w.navigation)
    w.__returnsAsked = 0
    w.navigation.traverseTo = (...args: unknown[]) => (w.__returnsAsked++, real(...args))
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => window._init_time > 0)).toBe(true)
  await page.goBack()
  await expect(page.locator('#sapper > .loading'), 'Back arrived before the page was initialized').toHaveClass(/visible/)
  expect(await page.evaluate(() => (window as any).__moves), 'the browser is on the entry of older code while the page starts').toEqual(['older'])
  // (the note is looked for while the page gets ready: it goes by itself, possibly before the page has
  // rendered all it renders at a load; the two start together, and a failure of either ends the wait)
  await Promise.all([expect(note(page), 'the note of the stop, once the page is ready').toHaveText('nothing to go back to', { timeout: 90_000 }), waitForApp(page)])
  await shows('#e2e_target ', atTarget, 'the entry the page was reloaded on, shown where it was left')
  expect(await page.evaluate(() => [(window as any).__moves, (window as any).__returnsAsked]), 'one return, to that entry').toEqual([['older', `own ${index + 1}`], 1])
  expect(await page.evaluate(() => [history.state.index, history.state.editorText, history.state.scrollPosition, location.hash]), "the browser's entry is that one, as it was").toEqual([index + 1, '#e2e_target ', atTarget, '#e2e_target'])
  expect(await entries(page), 'the session is on it').toEqual([index + 2, index + 1])
  await passNote(page)
  // nothing was lost: the entry ahead, and the entry itself on the way back
  await page.goForward()
  await shows('#e2e_target/sub', atSub, 'Forward: the entry ahead, kept')
  await page.goBack()
  await shows('#e2e_target ', atTarget, 'Back')
  // the position Back had reached was cleared before the browser left it (read where no return is made:
  // without the Navigation API, hidden here)
  await page.evaluate(() => void Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }))
  const CLEARED = JSON.stringify({ owner: 'admin|anonymous|', unknown: true })
  await page.goBack()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(CLEARED)
  await expect(mindbox(page)).toHaveValue('#e2e_target ')

  // A RELOAD ON THAT CLEARED POSITION, and Back while the page is starting, onto the state without an index
  // behind it (review 6 of scroll_history). The position the page was created on NAMES the notebook and is no
  // entry of its own, so it is no return address: no return is asked for (by the owner's name alone the
  // browser was sent back to it, a position the app could not restore either), and the page stays on the
  // position reached, cleared, as before the stop
  await page.reload()
  await expect.poll(() => page.evaluate(() => window._init_time > 0)).toBe(true)
  await page.goBack()
  await expect(page.locator('#sapper > .loading'), 'Back arrived before the page was initialized').toHaveClass(/visible/)
  await waitForApp(page)
  await noNote(page, 'no note: no stop was made')
  expect(await page.evaluate(() => [(window as any).__moves, (window as any).__returnsAsked, JSON.stringify(history.state)]), 'the state without an index, cleared, and no trip back to the position the page was reloaded on').toEqual([['custom'], 0, CLEARED])
  await expect(mindbox(page), 'the page shows its first view').toHaveValue('')
  expect(warnings).toEqual([])
})

// WHILE THE RETURN OF A STOP IS ON ITS WAY (review 6 of scroll_history, 2026-11-18). Between the landing and
// the return the browser is on a position that holds no entry, for a few milliseconds in a browser and for as
// long as the row holds it here: `navigation.traverseTo` is the row's (it keeps the app's call, then makes the
// real one, or refuses it). What happened there was decided by that position's rules: a typed update of a
// query was a push, which dropped the entry the reader was on and the entry ahead; a re-ranking and a scroll
// write that came due were dropped. They are kept for the entry and made when the browser is on it again.
// The fixture is four positions over the navigation row's items: the first view rewritten as older code
// wrote one, a typed query (NOT final: an update of it is a replacement, which keeps what is ahead; a final
// entry's may rightly drop it), the tag click's entry, and the last query rewritten as older code, AHEAD
test("while a stop's return is on its way an edit, a re-ranking and a due scroll write are kept for the entry and made on arrival, with the entry ahead kept; a refused return leaves the position as before the stop; another navigation retires the return, and no note follows a later visit; a history link is not followed meanwhile, nor when its click ends an overdue return; a second Back onto a fragment's own position drops the kept edit and keeps every position; an update of the view a kept edit shows is saved on the entry the edit gets", async ({ page }) => {
  const reads = historyReads(page)
  const { warnings, recorded, shows } = reads
  const { index, atTarget } = await threeQueries(page, reads)
  // [the first view, '#e2e_source' typed (index), the tag click's '#e2e_target ' (index + 1), '#e2e_target/sub' (index + 2)], on the last
  await recorded()
  await asOlderCode(page)
  await page.goBack()
  await shows('#e2e_target ', atTarget, "Back to the tag click's entry")
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  await asOlderCode(page)
  await page.goForward()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await recorded()
  const CLEARED = JSON.stringify({ owner: 'admin|anonymous|', unknown: true })
  const links = page.locator('.history-item')
  const browser = () => page.evaluate(() => [(window as any).navigation.currentEntry.key, history.length, (window as any).navigation.entries().length] as [string, number, number])
  const entry = (i = index) => page.evaluate(i => ({ at: JSON.stringify(history.state) == JSON.stringify((window as any)._history[i]) ? i : JSON.stringify(history.state), ...(window as any)._history[i] }), i)
  const on = (i: number) => expect.poll(() => page.evaluate(() => history.state?.index), { message: `the browser is on entry ${i}`, timeout: 10_000 }).toBe(i)
  const [keyS, length, positions] = await browser()
  expect(await entry(), 'the held entry is the typed query, NOT final, with two entries ahead').toMatchObject({ at: index, editorText: '#e2e_source', final: false })
  expect(await entries(page)).toEqual([index + 3, index])

  // the row's hold on the return: the app's call is kept until the row lets it go (the real method) or refuses it
  await page.evaluate(() => {
    const w = window as any
    const real = w.navigation.traverseTo.bind(w.navigation)
    w.__returns = []
    w.navigation.traverseTo = (key: string, options?: unknown) => {
      let release!: (mode: string) => void
      const gate = new Promise<string>(resolve => (release = resolve))
      w.__returns.push(release)
      const result = gate.then(mode => {
        if (mode == 'refuse') throw new DOMException('refused by the row', 'AbortError')
        return real(key, options)
      })
      return { committed: result.then((r: any) => r.committed), finished: result.then((r: any) => r.finished) }
    }
    // every traversal the page asks for by a distance (a history link's)
    w.__gone = []
    const go = history.go.bind(history)
    history.go = (delta?: number) => (w.__gone.push(delta), go(delta))
  })
  const held = (message: string) => expect.poll(() => page.evaluate(() => [(window as any).__returns.length, JSON.stringify(history.state)]), { message }).toEqual([1, CLEARED])
  const release = (mode: 'go' | 'refuse') => page.evaluate(mode => (window as any).__returns.shift()(mode), mode)
  const arrived = async (words: string, message: string) => {
    await expect(note(page), message).toHaveText(words)
    await passNote(page)
  }

  // (1) A QUERY UPDATE while the return is held: nothing is decided on the cleared position (no push there:
  // the browser's positions are what they were), the box shows the update, and the session's entry waits
  await page.goBack()
  await held('Back onto the entry of older code: cleared, and the return held')
  await page.evaluate(() => void (window as any).MindBox.set('#e2e_target/sub'))
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')
  expect([await browser(), await entry(), await page.evaluate(() => (window as any)._history_update_pending)], 'nothing written yet: the position cleared, the positions as they were, the entry as it was, a write kept').toMatchObject([[expect.not.stringMatching(keyS), length, positions], { at: CLEARED, editorText: '#e2e_source' }, true])
  // on arrival the update is the entry's own: a REPLACEMENT of a query that is not final, and the entry ahead is kept
  await release('go')
  await arrived('nothing to go back to', 'the return arrives')
  expect([await browser(), await entry()], 'the update replaced the held entry, at its own position').toMatchObject([[keyS, length, positions], { at: index, editorText: '#e2e_target/sub', final: false }])
  expect(await entries(page)).toEqual([index + 3, index])
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward: the entry ahead, kept')
  const keyT = (await browser())[0]
  await page.goBack()
  await on(index)
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')
  await recorded()

  // (2) A RE-RANKING with the query unchanged (an item touched), while the return is held: kept too, and
  // written on arrival (on the cleared position it took the replacing path, which writes nothing there)
  // (the item ranked last: touched, it is ranked ahead of the others, so the order changes)
  const [touched, order] = await page.evaluate(() => [window.__items[window.__items.length - 1].id, history.state.orderHash] as [string, string])
  expect((await entry()).unsavedTimes.some((time: { id: string }) => time.id == touched), 'the item is not among the times of the entry yet').toBe(false)
  await page.goBack()
  await held('Back again: the return held')
  await page.evaluate(id => void (window._item(id) as any).touch(), touched)
  await expect.poll(() => page.evaluate(() => (window as any)._history_update_pending), { message: "the re-ranking's write is kept" }).toBe(true)
  expect(await entry()).toMatchObject({ at: CLEARED, orderHash: order })
  await release('go')
  await arrived('nothing to go back to', 'the return arrives')
  const ranked = await entry()
  expect([ranked.at, ranked.editorText, ranked.orderHash == order, ranked.unsavedTimes.some((time: { id: string }) => time.id == touched)], 'the entry holds the order and the times shown').toEqual([index, '#e2e_target/sub', false, true])
  await recorded()

  // (3) A SCROLL WRITE THAT COMES DUE while the return is held. The scroll listener's 250 ms timer is the
  // row's for this step: armed by a scroll before Back, and run by the row during the return (every timer of
  // 250 ms set meanwhile is kept and run then: a scroll can also arm the app's focus restore, of the same delay)
  await page.evaluate(() => {
    const w = window as any
    const real = window.setTimeout
    w.__due = []
    ;(window as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => (ms === 250 ? (w.__due.push(() => cb(...args)), 0) : real(cb, ms, ...args))
    w.__timers = () => void ((window as any).setTimeout = real)
  })
  const saved = (await entry()).scrollPosition
  const scrolled = saved + 60
  await page.evaluate(y => document.body.scrollTo(0, y), scrolled)
  await expect.poll(() => page.evaluate(() => [(window as any).__due.length > 0, (window as any)._history_update_pending, document.body.scrollTop]), { message: "the scroll's write is armed" }).toEqual([true, true, scrolled])
  await page.evaluate(() => (window as any).__timers())
  await page.goBack()
  await held('Back within the 250 ms: the return held')
  await page.evaluate(() => (window as any).__due.splice(0).forEach((due: () => void) => due()))
  expect([await entry(), await page.evaluate(() => (window as any)._history_update_pending)], 'the write came due on the cleared position: kept, not dropped').toMatchObject([{ at: CLEARED, scrollPosition: saved }, true])
  await release('go')
  await arrived('nothing to go back to', 'the return arrives')
  expect([await entry(), await scrollTop(page)], 'the position the reader left is the one saved').toMatchObject([{ at: index, scrollPosition: scrolled }, scrolled])

  // (4) A REFUSED RETURN: the page is on the cleared position as before the stop (its marker, no link from
  // it, no note), and the next navigation works
  await page.goBack()
  await held('Back again: the return held')
  await expect(links, 'the list stays while the return is on its way').toHaveCount(2)
  await release('refuse')
  await expect(links, 'no link from a position that holds no entry').toHaveCount(0)
  await noNote(page, 'no note for a return that did not happen')
  expect((await entry()).at).toBe(CLEARED)
  await page.goForward()
  await on(index)
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')
  await expect(links).toHaveCount(2)

  // (5) ANOTHER NAVIGATION TAKES OVER: a traversal to another entry of the notebook's while the return is
  // held is followed and retires it; a later, ordinary visit to the entry the return was going to shows no note
  await page.goBack()
  await held('Back again: the return held')
  await page.evaluate(() => history.go(2))
  await shows('#e2e_target ', atTarget, "a jump to the tag click's entry, with the return still held")
  await page.goBack()
  await on(index)
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')
  await noNote(page, 'no note at an ordinary visit to the entry the retired return was going to')
  await release('refuse') // the held call ends; nothing of it is left to refuse
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward')
  await recorded()

  // (6) FORWARD onto the entry of older code AHEAD, the return held: A HISTORY LINK IS NOT FOLLOWED meanwhile
  // (its distance is from the entry, and the browser is not on it), and the return then arrives
  await page.evaluate(() => void ((window as any).__gone.length = 0))
  await page.goForward()
  await held('Forward onto the entry of older code: cleared, and the return held')
  await expect(links).toHaveCount(2)
  await links.first().click()
  expect(await page.evaluate(() => (window as any).__gone), 'no traversal by a distance while the return is on its way').toEqual([])
  // (a click in the header leaves the focus in the MindBox; blurred, as when a stop showed no note there)
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('textarea-mindbox')
  await blur(page)
  await release('go')
  await arrived('nothing to go forward to', 'the return arrives, from the other side')
  expect([(await browser())[0], (await entry(index + 1)).at]).toEqual([keyT, index + 1])

  // (7) A NATIVE FRAGMENT NAVIGATION takes over as well: the return is retired, and a later visit to the
  // entry it was going to shows no note
  await page.goForward()
  await held('Forward again: the return held')
  await page.evaluate(() => void (location.hash = '#e2e_no_such_item'))
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(JSON.stringify({ owner: 'admin|anonymous|', unknown: true, fragment: true }))
  await page.evaluate(() => history.go(-2))
  await on(index + 1)
  await noNote(page, 'no note at a visit to the entry the retired return was going to')
  await release('refuse')

  // (8) A RETURN THAT NEVER SETTLES does not keep the page waiting. An edit is kept while the return is held
  // (within the limit: two seconds, the app's seam here); once the return is overdue, whatever asks next ends
  // it as refused, and the kept edit is the edit of a position that holds no entry, as before the stop: a new
  // entry there, under a new numbering. Here A CLICK ON A HISTORY LINK asks (review 7 of scroll_history): it
  // BEGAN on a position that holds no entry, so it is consumed, though the kept edit's entry is the browser's
  // by the time the handler goes on (followed, its distance was from the old list: one back from the new entry)
  await recorded()
  await page.goForward()
  await held('Forward again: the return held, for good')
  await page.evaluate(() => void (window as any).MindBox.set('#e2e_source'))
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  expect([(await entry(index + 1)).at, await page.evaluate(() => (window as any)._history_update_pending)], 'the edit is kept').toEqual([CLEARED, true])
  await expect(links).toHaveCount(2)
  // (the press is dispatched on the link, the first one: not the current entry's. A click of the driver's
  // scrolls its target into view first, and a scroll asks too: the overdue return then ends before the press)
  const pressed = await page.evaluate(() => {
    const w = window as any
    w._stop_return_limit_ms = -1
    w.__gone.length = 0
    document.querySelector('.history-item')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    return [w.__gone.slice(), history.state?.index, history.state?.editorText]
  })
  expect(pressed, 'the kept edit is recorded, a new entry from the cleared position, and the press asked for no traversal').toEqual([[], 0, '#e2e_source'])
  expect(await entries(page)).toEqual([1, 0])
  await page.evaluate(() => void delete (window as any)._stop_return_limit_ms)
  await noNote(page, 'no note')
  await release('refuse')

  // (9) BACK TWICE, THE SECOND ONTO A FRAGMENT'S OWN POSITION THAT IS ALREADY THERE (review 7). The positions,
  // made by native fragments from here: one that names nothing (its marker), then three that name items, the
  // first of them rewritten as older code wrote one; the page on the second, with the third ahead
  const FRAGMENT = JSON.stringify({ owner: 'admin|anonymous|', unknown: true, fragment: true })
  const shown = (text: string) => expect.poll(() => page.evaluate(() => [history.state?.index, history.state?.editorText]), { message: `the browser is on the entry of ${text}`, timeout: 10_000 }).toEqual([0, text])
  await page.evaluate(() => void (location.hash = '#e2e_no_such_item'))
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(FRAGMENT)
  for (const name of ['#e2e_source', '#e2e_target', '#e2e_target/sub']) {
    await page.evaluate(name => void (location.hash = name), name)
    await shown(name + ' ')
    await recorded()
    if (name == '#e2e_source') await asOlderCode(page)
  }
  await page.goBack()
  await shown('#e2e_target ')
  await recorded()
  const keys = () => page.evaluate(() => (window as any).navigation.entries().map((position: { key: string }) => position.key) as string[])
  const [positionsBefore, keyHeld] = [await keys(), (await browser())[0]]
  // Back onto the entry of older code, the return held, and an edit kept; then Back AGAIN, onto the marker
  await page.goBack()
  await held('Back onto the entry of older code: the return held')
  await page.evaluate(() => void (window as any).MindBox.set('#e2e_source'))
  await expect.poll(() => page.evaluate(() => (window as any)._history_update_pending), { message: 'the edit is kept' }).toBe(true)
  await page.goBack()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state)), { message: "the fragment's own position, its marker" }).toBe(FRAGMENT)
  await settled(page)
  expect([await keys(), await page.evaluate(() => [JSON.stringify(history.state), (window as any)._history_update_pending])], "nothing is written from the fragment's position: every position is still the browser's, the marker is intact, and the kept edit went with the retired return").toEqual([positionsBefore, [FRAGMENT, false]])
  // ORDINARY FORWARD PRESSES from the marker (review 8 of scroll_history). The kept edit went with the retired
  // return, but the box still SHOWS it: the page is no longer the held entry's view. So the first press, onto
  // the cleared position, makes NO return to that entry (taken back there without a restore, the box held the
  // dropped query over the entry's own, and the next re-ranking took the difference for an edit: a push from
  // a final entry, and the entry ahead was gone). The browser stays on the cleared position, as before the
  // stop, and the second press restores the held entry as any entry reached
  const asked = await page.evaluate(() => (window as any).__returns.length)
  await page.goForward()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state)), { message: 'Forward: the cleared position' }).toBe(CLEARED)
  await settled(page)
  expect(await page.evaluate(() => [JSON.stringify(history.state), (window as any).__returns.length]), 'no return is asked for from there: the page does not show the held entry').toEqual([CLEARED, asked])
  await page.goForward()
  await shown('#e2e_target ')
  expect(
    [(await browser())[0], await mindbox(page).inputValue(), await page.evaluate(() => [history.state.editorText, (window as any)._history[0].editorText])],
    'Forward again: the held entry at its own position, and the box shows the query that both stored copies hold'
  ).toEqual([keyHeld, '#e2e_target ', ['#e2e_target ', '#e2e_target ']])
  await noNote(page, 'no note at an ordinary visit to the entry the retired return was going to')
  // a re-ranking there that changes no order (the item ranked first, touched) is no edit: nothing is written,
  // and the entry ahead is still the browser's
  await recorded()
  const ranking = () => page.evaluate(() => window.__items.map(item => item.id).join())
  const rankingBefore = await ranking()
  await page.evaluate(() => void (window._item(window.__items[0].id) as any).touch())
  await settled(page)
  expect([await ranking(), await keys(), await page.evaluate(() => [history.state.index, history.state.editorText])], 'a re-ranking that changes no order writes nothing: every position is still there').toEqual([rankingBefore, positionsBefore, [0, '#e2e_target ']])
  await page.goForward()
  await shown('#e2e_target/sub ')
  expect(await keys(), 'the entry ahead, and every position').toEqual(positionsBefore)
  await release('refuse')

  // (10) AN UPDATE OF THE VIEW A KEPT EDIT SHOWS (review 7). The held entry is FINAL (a fragment's), so the
  // edit kept during the return is a PUSH on arrival, rightly. In the same hold the new view is scrolled and
  // its write comes due; then a timer armed BEFORE the edit, in the held view, comes due too. On arrival the
  // entry the edit got holds the position of ITS view's write: not the position at the edit (the update was
  // kept for the held entry's index, and dropped once the push had moved it), and not the older timer's
  await page.goBack()
  await shown('#e2e_target ')
  await recorded()
  await page.evaluate(() => {
    const w = window as any
    const real = window.setTimeout
    w.__due = []
    ;(window as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => (ms === 250 ? (w.__due.push(() => cb(...args)), 0) : real(cb, ms, ...args))
    w.__timers = () => void ((window as any).setTimeout = real)
    w.__run = (due: (() => void)[]) => (due.splice(0).forEach(run => run()), document.body.scrollTop) // the timers run, and the position they read
  })
  const base = await scrollTop(page)
  await page.evaluate(y => document.body.scrollTo(0, y), base + 40)
  await expect.poll(() => page.evaluate(() => (window as any).__due.length > 0 && (window as any)._history_update_pending), { message: "a scroll in the held view: its write is armed" }).toBe(true)
  await page.goBack()
  await held('Back onto the cleared position: the return held')
  const atEdit = await page.evaluate(() => {
    const w = window as any
    w.__old = w.__due.splice(0) // the timers armed in the held view
    w.MindBox.set('#e2e_source')
    return document.body.scrollTop
  })
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await page.evaluate(y => document.body.scrollTo(0, y), base + 140)
  await expect.poll(() => page.evaluate(() => (window as any).__due.length > 0), { message: "a scroll in the new view: its write is armed" }).toBe(true)
  const atNew = await page.evaluate(() => (window as any).__run((window as any).__due))
  const atOld = await page.evaluate(y => (document.body.scrollTo(0, y), (window as any).__run((window as any).__old)), base + 90)
  expect(new Set([atEdit, atNew, atOld]).size, 'three positions: at the edit, at the write of the new view, at the older timer').toBe(3)
  await release('go')
  await arrived('nothing to go back to', 'the return arrives')
  expect(await page.evaluate(() => [history.state.index, history.state.editorText, history.state.scrollPosition, (window as any)._history[1].scrollPosition]), "the kept edit pushed its entry, which holds the position of its own view's write").toEqual([1, '#e2e_source', atNew, atNew])
  expect((await keys()).slice(0, -1), 'a push from the held entry: its position and those before it').toEqual(positionsBefore.slice(0, -1))
  // a later timer of the new view, due after the arrival, writes that entry as well
  await expect.poll(() => page.evaluate(() => (window as any).__due.length > 0), { message: "the new view's later scroll: its write is armed" }).toBe(true)
  const atLast = await page.evaluate(() => (window as any).__run((window as any).__due))
  expect(await page.evaluate(() => [history.state.index, history.state.scrollPosition]), 'due after the arrival: the same entry').toEqual([1, atLast])
  expect(atLast).not.toBe(atNew)
  await page.evaluate(() => (window as any).__timers())
  expect(warnings).toEqual([])
})

test('a change of the document width scrolls the item the query names back into view: at the layout at the new width and at the one its re-measured heights trigger; a scroll by hand or an Up after the first correction supersedes it; the window expires', async ({ page }) => {
  // the owner (2026-10-11): going full-screen and back lost the position, the reflow moving the items under
  // a scroll position that stays. A layout at a new document width opens a 2 s window in which every layout
  // brings the target back into view (updateItemLayout's scroll, through scrollToTarget: a no-op for a target
  // in view) unless the page was scrolled away from the position the last target scroll left (reflowCorrecting).
  // A page without a target is deferred.
  // THE FIXTURE: a root whose block is four viewport widths high (8000 px at 2000, 6000 at 1500, 4000 at
  // 1000), a middle item of a fixed height, and a short leaf, the query naming the leaf (the pinned items,
  // the root and the middle item list above it). The layout's balancing walk (layoutItems) puts the middle
  // item in the column the root is not in, and the leaf after it stays in that column only while it is at
  // most 450 px above the root's, or fits within 810 px of it (670 px for a short leaf). The middle item's
  // height is 7260 px plus the SPLIT, the root's column base less the other column's height, measured with
  // the root laid out (the seed's pinned items are not balanced: one is tall): at 2000 (the root 8000) the
  // leaf follows the middle item, 7260 < 8670; at 1500 (the root 6000) it goes to the root's column,
  // 7260 > 6670. The layout at a new width still uses the root's height of the old width, so the leaf changes
  // column only at the layout its re-measured height triggers (the reflow re-renders the items, their
  // afterUpdate re-measures, tryLayout runs 250 ms later, held 500 ms past a scroll): at 2000 the second
  // layout takes it from below the 8000 px root to below the middle item, 820 px up; at 1500 from below the
  // middle item to below the 6000 px root, 1180 px up. The root's block is read at every width (the
  // premise), and so is each layout (window.__layoutCount)
  const S = 2000 // two columns of 1000 px (the column's maximum width)
  const N = 1500 // two columns of 750 px (the minimum)
  await page.setViewportSize({ width: S, height: 900 })
  await loadAdmin(page)
  const names = ['#e2e_reflow', '#e2e_reflow/mid', '#e2e_reflow/mid/leaf'] as const
  const columns = () => page.evaluate(() => document.querySelectorAll('.column:not(.hidden)').length)
  const layouts = () => page.evaluate(() => (window as any).__layoutCount as number)
  const targetTop = () => page.evaluate(() => (document.querySelector('.super-container.target') as HTMLElement).offsetTop)
  // the target in the band a target scroll leaves alone (inScrollBand)
  const inBand = () =>
    page.evaluate(() => {
      const top = (document.querySelector('.super-container.target') as HTMLElement).offsetTop
      return top >= document.body.scrollTop && top <= document.body.scrollTop + visualViewport!.height - 200
    })
  const rootHeight = () =>
    page.evaluate(() => (document.getElementById('super-container-' + window._item('#e2e_reflow', true)!.id) as HTMLElement).offsetHeight)
  // no layout for `ms` (tryLayout's retry is 250 ms, its hold past a scroll 500 ms)
  const quiet = async (ms = 800) => {
    let last = await layouts()
    let since = Date.now()
    await expect
      .poll(
        async () => {
          const count = await layouts()
          if (count != last) [last, since] = [count, Date.now()]
          return Date.now() - since >= ms
        },
        { message: `no layout for ${ms} ms`, timeout: 20_000 }
      )
      .toBe(true)
  }
  // the view resized: the layout at the new width awaited, the root's block following the width (the premise)
  const resize = async (width: number) => {
    const before = await layouts()
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(layouts, { message: `the layout at ${width}`, timeout: 15_000 }).toBeGreaterThan(before)
    const height = await rootHeight()
    expect(height >= 4 * width && height < 4 * width + 300, `the root's block follows the width (${height} at ${width})`).toBe(true)
  }
  // a correction observed: the position at the tag click's destination (the target's top less a quarter of the
  // view, no higher than the header)
  const corrected = (message: string) =>
    expect
      .poll(
        () =>
          page.evaluate(() => {
            const target = document.querySelector('.super-container.target') as HTMLElement
            const destination = Math.max((document.querySelector('.header') as HTMLElement).offsetTop, target.offsetTop - visualViewport!.height / 4)
            return Math.abs(document.body.scrollTop - destination) <= 2
          }),
        { message, timeout: 10_000 }
      )
      .toBe(true)
  // the view resized for the phases that watch the layouts: the count before the resize anchors them (the
  // first layout is before + 1, the second before + 2, whenever each is observed)
  const reflowTo = async (width: number) => {
    const before = await layouts()
    // the 250 ms timers armed from the resize to the watcher's action are HELD (lane_races review 0): the
    // second layout is tryLayout's 250 ms timer, armed by the re-measure right after the first layout, and
    // on a loaded host it fired inside the four frames the watcher waits, so the premise "the second layout
    // not yet run" read one past (three of seven full gates, then twice alone); held, it runs after the
    // action (firstLayout releases it a frame later, the action's scroll event dispatched), where the app's
    // own rule, a layout waits 500 ms past a scroll, orders it as in production. A write the correction's
    // scroll arms is held and released the same way; clearTimeout on a held id drops it, as the real one
    await page.evaluate(() => {
      const w = window as any
      const held: { id: number; cb: (...args: unknown[]) => void; args: unknown[] }[] = (w.__heldTimers = [])
      const setTimeout_ = (w.__setTimeout = window.setTimeout)
      const clearTimeout_ = (w.__clearTimeout = window.clearTimeout)
      // the ids are unique across the row's four holds: a hold that restarted them handed a previous hold's
      // write id to tryLayout, and the next scroll's clearTimeout(historyUpdateTimer), the app's stale id,
      // dropped the held layout for good (layoutPending stuck; the editor lane once, "the second layout after
      // the Up" never came)
      w.__fakeTimerId ??= 1 << 30
      ;(window as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        ms == 250 ? (held.push({ id: ++w.__fakeTimerId, cb, args }), w.__fakeTimerId) : setTimeout_(cb, ms, ...args)
      ;(window as any).clearTimeout = (id?: number) => {
        const i = held.findIndex(h => h.id == id)
        i >= 0 ? held.splice(i, 1) : clearTimeout_(id)
      }
    })
    await page.setViewportSize({ width, height: 900 })
    return before
  }
  // THE FIRST LAYOUT, WATCHED FRAME BY FRAME IN THE PAGE: the frame the first layout's correction landed (the
  // position at the destination) or, with the target in the band, the frame of the layout itself; then
  // FOUR FRAMES LATER, once that layout's correction has flushed (a tick and two frames; a scroll inside
  // that gap is still overridden by the first correction, which is admitted whatever position the resize
  // left: a known limit of about 50 ms), the action: a scroll by hand to the top, or an Up (two modifiers,
  // the window handler) with its entry checked. Resolves with the count at the action (the second layout
  // comes about 270 ms after a first layout that scrolled nothing, 500 ms past a correction's scroll: a
  // poll from the test could read the count after it), the target's top at the first layout, and whether
  // the position held across the four frames (the first correction scrolled nothing more)
  const firstLayout = (before: number, action: 'none' | 'hand' | 'up' = 'none') =>
    page.evaluate(
      ({ before, action }) =>
        new Promise<{ count: number; top: number; at: boolean; inBand: boolean; held: boolean; pushed: boolean | null; heldTimers: number }>((resolve, reject) => {
          const w = window as any
          const started = Date.now()
          const tick = () => {
            const target = document.querySelector('.super-container.target') as HTMLElement | null
            if ((w.__layoutCount as number) > before && target) {
              const header = (document.querySelector('.header') as HTMLElement).offsetTop
              const top = target.offsetTop
              const position = document.body.scrollTop
              const at = Math.abs(position - Math.max(header, top - visualViewport!.height / 4)) <= 2
              const inBand = top >= position && top <= position + visualViewport!.height - 200
              if (at || inBand) {
                let frames = 4
                const act = () => {
                  if (--frames > 0) return requestAnimationFrame(act)
                  const held = Math.abs(document.body.scrollTop - position) <= 2
                  const count = w.__layoutCount as number
                  let pushed: boolean | null = null
                  if (action == 'hand') document.body.scrollTo(0, header)
                  if (action == 'up') {
                    const index = w._history_index as number // the Up's entry is the next index (the entry the row's Back left ahead goes)
                    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }))
                    pushed = w._history_index == index + 1 && w._history[w._history_index].scrolledToTop === true
                  }
                  // the hold of reflowTo ends a frame later, the action's scroll event dispatched: the wrappers
                  // removed, the held timers run (tryLayout's among them, which re-arms itself past the scroll)
                  requestAnimationFrame(() => {
                    window.setTimeout = w.__setTimeout
                    window.clearTimeout = w.__clearTimeout
                    const late = w.__heldTimers.splice(0) as { cb: (...args: unknown[]) => void; args: unknown[] }[]
                    late.forEach(h => h.cb(...h.args))
                    resolve({ count, top, at, inBand, held, pushed, heldTimers: late.length })
                  })
                }
                requestAnimationFrame(act)
                return
              }
            }
            if (Date.now() - started > 15_000) reject(new Error('no first layout with the target placed'))
            else requestAnimationFrame(tick)
          }
          tick()
        }),
      { before, action }
    )
  // the second layout, the one the re-measured root triggers, awaited inside the window
  const second = async (before: number, message: string) => {
    const t = Date.now()
    await expect.poll(layouts, { message, timeout: 5_000 }).toBeGreaterThanOrEqual(before + 2)
    expect(Date.now() - t, 'the second layout came inside the window').toBeLessThan(2000)
  }
  const rootFollows = async (width: number) => {
    const height = await rootHeight()
    expect(height >= 4 * width && height < 4 * width + 300, `the root's block follows the width (${height} at ${width})`).toBe(true)
  }
  const targeted = (id: string) =>
    expect.poll(() => page.evaluate(id => !!document.querySelector(`.super-container.target #item-${id}`), id), { timeout: 15_000 }).toBe(true)
  await expect.poll(columns, { timeout: 15_000 }).toBe(2)
  // the root first, laid out under its own query to measure the split (its pos is its column's height at its
  // placement, the header's included; the other column's height is its items' pos plus outerHeight)
  await page.evaluate(() => void window._create('#e2e_reflow\n\n<div style="height: 400vw"></div>'))
  await expect.poll(() => savedId(page, '#e2e_reflow'), { timeout: 30_000 }).toBeTruthy()
  const rootId = await page.evaluate(() => window._item('#e2e_reflow', true)!.id)
  await focusMindboxInPlace(page)
  await mindbox(page).fill('#e2e_reflow')
  await targeted(rootId)
  await quiet()
  const split = await page.evaluate(id => {
    const w = window as any
    const root = w.__items.find((item: any) => item.id == id)
    const others = w.__items.slice(0, w.__hideIndex).filter((item: any) => item.column != root.column)
    return root.pos - Math.max(0, ...others.map((item: any) => item.pos + item.outerHeight))
  }, rootId)
  const middle = Math.round(7260 + split)
  await page.evaluate(h => void window._create(`#e2e_reflow/mid\n\n<div style="height: ${h}px"></div>`), middle)
  await page.evaluate(() => void window._create('#e2e_reflow/mid/leaf the leaf'))
  for (const name of names) await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
  const id = await page.evaluate(() => window._item('#e2e_reflow/mid/leaf', true)!.id)
  await focusMindboxInPlace(page)
  await mindbox(page).fill('#e2e_reflow/mid/leaf')
  await targeted(id)
  await quiet()
  expect(await inBand(), "the query's own scroll put the leaf in view").toBe(true)
  await blur(page)
  // the leaf is then REACHED THROUGH BACK (review 4 of scroll_history): its view left for the first one (a
  // new entry: the query is cleared with a target selected) and restored. A restore holds its entry's
  // position through the layouts it causes and no longer, so every correction below is of a restored view
  // (marked as an explicit scroll, which lasts until the query changes, the restore suppressed them all)
  await page.evaluate(() => void (window as any).MindBox.clear())
  await expect(mindbox(page)).toHaveValue('')
  await quiet()
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_reflow/mid/leaf')
  await targeted(id)
  await quiet()
  expect(await inBand(), 'Back restored the leaf in view').toBe(true)
  // 1. the owner's case, one column: the leaf lies far below the position left (the premise) and the layout
  // at the new width scrolls to its upper middle; the re-measured root moves nothing in one column
  const left1 = await scrollTop(page)
  await resize(1000)
  expect((await targetTop()) - left1, 'the premise: at the position left the leaf would lie below the view').toBeGreaterThan(700)
  await corrected('scrolled to the leaf at one column')
  await quiet()
  expect(await inBand(), 'the leaf in view at one column').toBe(true)
  // 2. two columns of 750: the leaf lands in the root's column at the layout at the new width and stays there
  await resize(N)
  await expect.poll(inBand, { message: 'the leaf in view at two columns of 750' }).toBe(true)
  await quiet()
  // 3. the layout the re-measure triggers: at 2000 the root grows by 2000 px above the leaf, which the layout at
  // the new width keeps in the root's column (the first correction); the re-measured root then sends the
  // leaf to the middle item's column, 820 px up and out of the band at the position the first correction
  // left (the premise); the second layout corrects again, inside the window
  const left3 = await scrollTop(page)
  const before3 = await reflowTo(S)
  const first3 = await firstLayout(before3)
  await rootFollows(S)
  expect([first3.count, first3.at, first3.held], 'the first correction, the second layout not yet run').toEqual([before3 + 1, true, true])
  expect(first3.top - left3, 'the premise: the leaf below the view at the position left').toBeGreaterThan(700)
  await second(before3, 'the layout the re-measured root triggers')
  await expect.poll(targetTop, { message: 'the second layout moved the leaf up, out of the band' }).toBeLessThan(first3.top - 225)
  await expect.poll(inBand, { message: 'the second correction brought the leaf back' }).toBe(true)
  await quiet()
  // 4. a scroll by hand after the layout at the new width supersedes the correction of the second layout: at
  // 1500 the leaf keeps its place at the first layout (the middle item's column, in view, nothing to
  // correct), the page is scrolled to the top four frames after that layout (its correction flushed, a
  // no-op), and the second layout, which moves the leaf to the root's column, leaves the page at the top
  const before4 = await reflowTo(N)
  const first4 = await firstLayout(before4, 'hand')
  await rootFollows(N)
  expect([first4.count, first4.inBand, first4.held], 'the premise: the leaf in view after the first layout, its correction a no-op, the second layout not yet run').toEqual([before4 + 1, true, true])
  await nearTop(page, 'scrolled to the top by hand')
  await second(before4, 'the second layout after the scroll by hand')
  await page.waitForTimeout(300) // the correction's flush (two frames) would have scrolled by now
  await nearTop(page, 'the scroll by hand survives the second layout')
  expect(await inBand(), 'the leaf out of view at the top: the second layout had something to correct').toBe(false)
  // 5. an Up (the scroll to the top with a history entry) after the first correction supersedes the second:
  // at 2000 the first layout corrects (the leaf back in the root's column, 2000 px lower), the Up follows four
  // frames after the correction landed, and the second layout leaves the page at the top with the entry Down
  // undoes intact (a settled query sets no explicitScrollQuery, so the Up relies on this)
  const before5 = await reflowTo(S)
  const first5 = await firstLayout(before5, 'up')
  await rootFollows(S)
  expect([first5.count, first5.at, first5.held, first5.pushed], 'the first correction, the second layout not yet run, the Up pushed its entry').toEqual([before5 + 1, true, true, true])
  await nearTop(page, 'the Up scrolled to the top')
  await second(before5, 'the second layout after the Up')
  await page.waitForTimeout(300)
  await nearTop(page, 'the Up survives the second layout')
  expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index].scrolledToTop), 'the entry Down undoes is intact').toBe(true)
  expect(await inBand(), 'the leaf out of view at the top').toBe(false)
  // 6. the window expires: at 1500 both corrections run from the top (the leaf out of view at the first layout,
  // moved up at the second); then, 2 s after the second with no scroll, the middle item's block shrinks to
  // 1000 px (selected inside its .content: the .item's first styled child is the menu placeholder) and its
  // model takes the container's measurement, the one onItemResized reads, so the measurement callback the
  // re-render triggers finds no change and no further layout follows; the layout on demand sends the leaf
  // to the middle item's column, above the position kept: nothing scrolls
  const before6 = await reflowTo(N)
  const first6 = await firstLayout(before6)
  await rootFollows(N)
  expect([first6.count, first6.at, first6.held], 'the first correction at 1500, from the top').toEqual([before6 + 1, true, true])
  await second(before6, 'the second layout at 1500')
  await expect.poll(inBand, { message: 'the second correction at 1500' }).toBe(true)
  const t6 = Date.now()
  await quiet(2200)
  expect(Date.now() - t6, 'the window expired').toBeGreaterThanOrEqual(2000)
  const position6 = await scrollTop(page)
  const shrunk = await page.evaluate(() => {
    const w = window as any
    const mid = w.__items.find((item: any) => item.label == '#e2e_reflow/mid')
    const container = document.getElementById('super-container-' + mid.id)!.querySelector('.container') as HTMLElement
    const block = container.querySelector('.item > .content div[style]') as HTMLElement
    block.style.height = '1000px'
    const measured = container.offsetHeight
    mid.height = measured
    const count = w.__layoutCount as number
    w.__layout()
    return { block: block.offsetHeight, measured, layouts: (w.__layoutCount as number) - count, count: w.__layoutCount as number }
  })
  expect(shrunk.block, 'the middle block shrunk').toBe(1000)
  expect(shrunk.measured >= 1000 && shrunk.measured < 1300, `the container measured with the block (${shrunk.measured})`).toBe(true)
  expect(shrunk.layouts, 'one layout ran').toBe(1)
  await expect.poll(targetTop, { message: 'the layout moved the leaf above the position kept (the premise)' }).toBeLessThan(position6)
  await page.waitForTimeout(300)
  expect(Math.abs((await scrollTop(page)) - position6), 'no correction after the window').toBeLessThanOrEqual(2)
  expect(await layouts(), 'no further layout: the measurement callback found the model consistent').toBe(shrunk.count)
  // the fixture, deleted by its saved ids and the deletions persisted (deleteDoc is fire-and-forget)
  const ids = await Promise.all(names.map(name => savedId(page, name)))
  await page.evaluate(names => names.forEach(name => window._item(name, true)!.delete(false)), [...names])
  for (const doc of ids) await expect.poll(async () => (await firestore().collection('items').doc(doc!).get()).exists, { timeout: 30_000 }).toBe(false)
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

test('a <style> after the label keeps the header minimal and applies as item-specific css; visible html after the label does not', async ({ page }) => {
  // item-specific css lives in a <style> whose #item the renderer rewrites to the element's id
  // (Item.svelte); html BEFORE the label is moved off the label line into its own block, so the
  // place for it is after the label on the first line, where it has no box and must not unset
  // headerMinimal, which the #chat styles float a chat's role header beside (the owner,
  // 2026-10-10: the header dropped a line whenever a chat carried such a style)
  await loadAdmin(page)
  await page.evaluate(() =>
    window._create(
      ['#e2e_hdr_style <style> #item .e2e_hdr_probe { color: rgb(1, 2, 3) } </style>', 'body <span class="e2e_hdr_probe">probe</span>'].join('\n')
    )
  )
  await page.evaluate(() => void window._create('#e2e_hdr_span <span>after</span>'))
  await expect.poll(() => savedId(page, '#e2e_hdr_style'), { timeout: 30_000 }).toBeTruthy()
  await expect.poll(() => savedId(page, '#e2e_hdr_span'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(() => void (location.hash = '#e2e_hdr_style')) // bring it up so it renders
  const probe = page.locator('.e2e_hdr_probe')
  await expect(probe).toBeVisible({ timeout: 30_000 })
  await expect(probe, 'the style applies to the item').toHaveCSS('color', 'rgb(1, 2, 3)')
  const elemId = (name: string) => page.evaluate(name => window._item(name, true)?.id ?? null, name) // the element id is the item's id
  await expect(page.locator(`#item-${await elemId('#e2e_hdr_style')}`)).toHaveClass(/\bheaderMinimal\b/)
  await page.evaluate(() => void (location.hash = '#e2e_hdr_span'))
  const span = page.locator(`#item-${await elemId('#e2e_hdr_span')}`)
  await expect(span).toBeVisible({ timeout: 30_000 })
  await expect(span, 'visible html after the label is not minimal').not.toHaveClass(/\bheaderMinimal\b/)
})

test('an item being edited keeps its unsaved text, its selection and its focus through a layout that moves it to another column, in both directions; the save carries the text', async ({ page }) => {
  // the owner (2026-10-13): "sometimes when i'm editing an item and haven't saved yet and there is a layout
  // event and items move around, the text in the item gets reverted to the saved text as if the unsaved
  // edits were lost. i can recover the unsaved edits by hitting close button and then choosing cancel when
  // prompted about unsaved edits". The items render per column (index.svelte: a keyed each over the items
  // inside a block per column), and a keyed each cannot move a component between two blocks: an item a
  // layout moves to another column is destroyed in one block and created in the other, its Item and
  // Editor with it, and the new textarea seeded from the SAVED text prop (the draft lived on in
  // item.editorText, bound to the model, which the close button's Cancel assigned back to item.text: the
  // recovery). Now the Editor stashes its textarea's state at its destroy (editorStates in Editor.svelte)
  // and the Editor created in its place resumes it (the Item created while editing asks for it, and the
  // entry's draft is the model's): the value and the selection with its direction, read at the destroy
  // from the DETACHED element (which keeps them), and the focus, the destroyed editor's own, which its
  // removal blur (fired while the element is still connected in Chromium) settles a microtask later.
  // THE FIXTURE: a root with a 1200 px block and a short leaf, the query naming the leaf (the root lists
  // above it): at two columns the root fills column 0 past the balancing threshold (layoutItems: half a
  // screen height over the other column), so the leaf opens column 1; at one column every item is in
  // column 0. The viewport crosses the two-column threshold (750 px a column) both ways.
  await page.setViewportSize({ width: 1600, height: 900 }) // floor(1600 / 750) = 2 columns
  await loadAdmin(page)
  await page.evaluate(() => void window._create('#e2e_remount\n\n<div style="height: 1200px"></div>'))
  await page.evaluate(() => void window._create('#e2e_remount/leaf draft survives'))
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_remount/leaf')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_remount/leaf', true)?.elem), { timeout: 10_000 }).toBe(true)
  const id = await page.evaluate(() => window._item('#e2e_remount/leaf')!.id)
  const textarea = page.locator(`#textarea-${id}`)
  const column = () => page.evaluate(id => window.__items.find(item => item.id == id)!.column as number, id)
  const columns = () => page.evaluate(() => document.querySelectorAll('.column:not(.hidden)').length)
  // the textarea's state, the value ZWSP-insensitive as the suite compares; `fresh` tells an element a
  // remount created from the one stamped before (the locator resolves to whichever is in the document)
  const state = () =>
    textarea.evaluate((t: HTMLTextAreaElement) => ({
      value: t.value.replaceAll('​', ''),
      start: t.selectionStart,
      end: t.selectionEnd,
      direction: t.selectionDirection,
      focused: document.activeElement === t,
      fresh: !(t as any).__stamped,
    }))
  const stamp = () => textarea.evaluate((t: HTMLTextAreaElement) => void ((t as any).__stamped = true))
  expect(await columns()).toBe(2)
  expect(await column(), 'the leaf opens column 1 at two columns (the premise)').toBe(1)
  // the live item's paragraph (the measuring column is hidden), clicked at its center, past its label tag
  // (a tag navigates); the click auto-waits, since the item re-renders after the save below and an explicit
  // box read null for a moment in the lane
  const paragraph = page.locator(`.column:not(.hidden) #item-${id} p`).first()
  const clickParagraph = () => paragraph.click()
  await clickParagraph()
  await expect(textarea).toBeFocused()
  await stamp()
  await textarea.press('ControlOrMeta+a')
  await textarea.pressSequentially('#e2e_remount/leaf draft survives typed')
  for (let i = 0; i < 3; i++) await textarea.press('Shift+ArrowLeft') // a backward selection over "ped"
  const typed = await state()
  expect(typed).toEqual({ value: '#e2e_remount/leaf draft survives typed', start: 35, end: 38, direction: 'backward', focused: true, fresh: false })
  for (const [width, count, target] of [
    [900, 1, 0],
    [1600, 2, 1],
  ] as const) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(columns, { message: `${count} column(s) at ${width}`, timeout: 15_000 }).toBe(count)
    await expect.poll(column, { message: `the leaf moved to column ${target} at ${width}`, timeout: 15_000 }).toBe(target)
    await expect.poll(state, { message: `the editor's state at ${width}`, timeout: 5_000 }).toEqual({ ...typed, fresh: true })
    await stamp()
  }
  await page.keyboard.press('Shift+Enter') // save
  await expect(textarea).toBeHidden()
  const saved = '#e2e_remount/leaf draft survives typed'
  await expect.poll(() => itemText(page, '#e2e_remount/leaf')).toBe(saved)
  // the save persisted before the discard below: a cancel while the item is still saving discards without
  // the prompt (onItemEditing), which the lane's load made ordinary
  await expect
    .poll(
      () =>
        page.evaluate(id => {
          const item = window.__items.find(item => item.id == id)!
          return !item.saving && item.savedText
        }, id),
      { timeout: 30_000 }
    )
    .toBe(saved)
  // a later session of the Item the remount created does not resume the entry the saved session's end
  // wrote (the Item withdraws the resume at that end; review 1: kept for the Item's life, it brought the
  // entry back at every later edit): a re-edit opens on a fresh element at the Item's retained selection
  // (pre-existing: a click sets no caret), a suffix is typed from a collapsed caret and discarded, and the
  // next re-edit shows the SAVED text with a collapsed caret, not the entry's draft and backward range
  await clickParagraph()
  await expect(textarea).toBeFocused()
  await expect.poll(state).toEqual({ value: saved, start: 35, end: 38, direction: expect.any(String), focused: true, fresh: true })
  await stamp()
  await textarea.press('ArrowRight') // collapses the selection to its end (End scrolls on a Mac)
  await textarea.pressSequentially(' discarded')
  await page.keyboard.press('Escape')
  await expect(page.getByText(/Discard unsaved changes to #e2e_remount\/leaf/)).toBeVisible()
  await page.locator('.modal .button.confirm', { hasText: 'Discard' }).click()
  await expect(textarea).toBeHidden()
  await expect.poll(() => itemText(page, '#e2e_remount/leaf')).toBe(saved)
  await clickParagraph()
  await expect(textarea).toBeFocused()
  await expect.poll(state, { message: 'the re-edit after the discard' }).toEqual({ value: saved, start: 38, end: 38, direction: expect.any(String), focused: true, fresh: true })
  expect((await state()).direction, 'not the entry\'s backward range').not.toBe('backward')
  await page.keyboard.press('Escape') // nothing to discard
  await expect(textarea).toBeHidden()
  // the fixture, deleted by its saved ids and the deletions persisted (deleteDoc is fire-and-forget)
  const names = ['#e2e_remount', '#e2e_remount/leaf']
  for (const name of names) await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
  const ids = await Promise.all(names.map(name => savedId(page, name)))
  await page.evaluate(names => names.forEach(name => window._item(name, true)!.delete(false)), names)
  for (const doc of ids) await expect.poll(async () => (await firestore().collection('items').doc(doc!).get()).exists, { timeout: 30_000 }).toBe(false)
})

// A RELOAD ON A FINAL KEPT ENTRY OF THE FULL LIST ADDS NO HISTORY ENTRY (the owner, 2026-11-18: "a reload w/o a
// query seems to add a (duplicate, no-op) step"). A launch on the entry the browser kept for it compares the
// order it loads with the one the entry recorded, and after most sessions the two differ: the session's soft
// touches are gone after a reload, and an item changed since ranks by its new time. On a FINAL entry of the
// empty query (a launch's first view, a click on the tag the query names) the launch pushed its first view after
// it, a second entry of the same list, and dropped the entries ahead. It takes that entry over now, replaced
// where it is by the view it loads (`launch` in index.svelte's onEditorChange); a re-ranking within the session
// is a new entry as before, except on the launch's own first view, whose entry it is written over (`first`).
// the browser's list of positions by key, the one it is on and what the entry there holds
const places = (page: Page) =>
  page.evaluate(() => {
    const nav = (window as any).navigation
    const { index, run, editorText, final, orderHash } = history.state
    return { keys: nav.entries().map((e: any) => e.key) as string[], at: nav.currentEntry.key as string, state: { index, run, editorText, final, orderHash } }
  })
// the order of the items as the page ranks them now, as an entry records it
const orderShown = (page: Page) => page.evaluate(() => (window as any)._hash((window as any).__items.map((item: any) => item.id).join()) as string)
// a typed query's entry, then a tag click's from its item (final), over the navigation row's items, each at a position of its own
const typedThenTag = async (page: Page, { recorded, place }: ReturnType<typeof historyReads>) => {
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_source')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  await blur(page)
  await place(40)
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  const tag = page.locator(`#item-${sourceId} mark[title="#e2e_target"]`)
  await tag.scrollIntoViewIfNeeded()
  await recorded()
  await tag.click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  return place(80)
}

// The kept entry is a real one in the middle of the browser's list: a final entry of the empty query (a click
// on the tag the query names), a tag's entry behind it and a query's ahead. What the reload finds different is
// installed by the row, a STALE ORDER on that entry (what any change of the notebook since the entry was
// written leaves), in the same browser turn as the reload, so that nothing of the page's can write the entry in
// between; the row's listener notes at `pagehide` that the entry still held it, and the baseline is read in
// that turn. (From the dropped change of 2026-11-18, run noop_entries, whose first shape of the row rewrote an
// item behind an offline page: the page took the change before the reload in one run of six, review 9 of
// scroll_history. A change that arrives from another client is the next row's.)
test('a reload on a kept first view whose order differs adds no history entry: the entry is taken over where it is by the view loaded, the entry ahead is kept and Back goes where it went before the reload', async ({ page }) => {
  const reads = historyReads(page)
  const { recorded, place, shows } = reads

  await loadAdmin(page)
  const top = await headerTop(page)
  await typedThenTag(page, reads)
  // the first view again, in a final entry of its own: a click on the tag the query names, on its own item
  const targetId = await page.evaluate(() => window._item('#e2e_target')!.id)
  const label = page.locator(`#item-${targetId} mark[title="#e2e_target"]`).first()
  await label.scrollIntoViewIfNeeded()
  await recorded()
  const atTag = await scrollTop(page)
  await label.click()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  // an entry ahead of it, left at a position of its own: a query set from a blurred box; then Back
  await blur(page)
  await page.evaluate(() => void (window as any).MindBox.set('#e2e_source'))
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  const atAhead = await place(60)
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  await settled(page)

  // the stale order and the reload in ONE turn, the baseline read in it (kept across the reload with the
  // order the entry held when the page went away)
  const read = () => {
    const nav = (window as any).navigation
    const { index, run, editorText, final, orderHash } = history.state
    return { keys: nav.entries().map((e: any) => e.key) as string[], at: nav.currentEntry.key as string, state: { index, run, editorText, final }, orderHash: orderHash as string }
  }
  await page
    .evaluate(read => {
      sessionStorage.setItem('e2e_kept_before', JSON.stringify(new Function(`return (${read})()`)()))
      window.addEventListener('pagehide', () => sessionStorage.setItem('e2e_kept_order', String(history.state?.orderHash)))
      history.replaceState({ ...history.state, orderHash: 'stale' }, '')
      location.reload()
    }, read.toString())
    .catch(() => undefined) // (the turn's result can be lost to the navigation it starts: the two notes below say that it ran)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('e2e_kept_order')).catch(() => null), { message: 'premise: the page went away with the stale order on its entry', timeout: 30_000 }).toBe('stale')
  await waitForApp(page)
  const before = JSON.parse((await page.evaluate(() => sessionStorage.getItem('e2e_kept_before')))!) as ReturnType<typeof read>
  expect(before.state, 'premise: a final entry of the empty query').toMatchObject({ editorText: '', final: true })
  expect(before.keys.indexOf(before.at), 'premise: one entry ahead of it').toBe(before.keys.length - 2)
  expect(before.keys.length, 'premise: and entries behind it').toBeGreaterThan(3)

  // THE RELOAD ADDED NOTHING: the same positions, the browser on the same one, the entry its own (index, run,
  // query, final), and its order the one loaded
  await shows('', top, 'the reloaded page shows the first view at the header')
  await settled(page)
  const after = await page.evaluate(read => new Function(`return (${read})()`)() as any, read.toString())
  expect({ keys: after.keys, at: after.at, state: after.state }, 'a reload on a kept first view of another order: no entry added, the entry where and what it was').toEqual({ keys: before.keys, at: before.at, state: before.state })
  expect([after.orderHash, before.orderHash == 'stale'], 'the entry holds the order loaded (the baseline held its own)').toEqual([await orderShown(page), false])

  // both neighbours as before the reload: Forward onto the entry ahead (a push would have dropped it), Back
  // from the first view onto the tag's entry, at its position
  await recorded()
  await page.goForward()
  await shows('#e2e_source', atAhead, 'Forward onto the entry ahead of the first view')
  await page.goBack()
  await shows('', top, 'Back to the first view')
  await page.goBack()
  await shows('#e2e_target ', atTag, 'Back from the first view, as before the reload')
})

// A CHANGE FROM ANOTHER CLIENT changes the list's order, a re-ranking within the session. On a final first
// view that is NOT the launch's (the full list reached by a click on the tag the query names) it is a new entry
// of the same query, as before. On the LAUNCH'S OWN first view (the entry the launch wrote or took over) it is
// written over that entry, which stays final, since 2026-11-19 (`first` in index.svelte's onEditorChange): until
// then it pushed an entry there too, and an order change as a page started left a second entry of the same
// query after that reload (the next row). And the owner's case of 2026-11-18 without an installed order: Back
// onto the first view, whose entry holds the order from before the change, and a reload there, which loads the
// change's order: no entry added, the change's entry stays ahead (the launch takes the entry over), and it
// still does after a further change, which the reloaded page writes over its own entry (a push dropped it).
// The item changed is the one ranked last among the unpinned (a new time, its text as it was): it moves up, so
// the order changes wherever it is shown
test("a change from another client adds an entry on a final first view that is not the launch's and is written over the launch's own, which stays final and keeps its mark of Up and its narration's choice; a reload on the first view that Back left it on adds none, and the change's entry stays ahead of it, through a change after the reload too; a list opened again at the launch entry's index is not the launch's", async ({ page }) => {
  const reads = historyReads(page)
  const { recorded, shows } = reads
  await loadAdmin(page)
  const top = await headerTop(page)
  await shows('', top, 'the first view at the header')
  await recorded()
  const change = async () => {
    const saved = await page.evaluate(() => [...(window as any).__items].reverse().find((item: any) => !item.pinned && !item.log && item.savedId).savedId as string)
    await firestore().collection('items').doc(saved).update({ time: Date.now() })
  }
  // on the launch's own first view: the entry where it was, final, of the order the change gave
  const changedInPlace = async (message: string) => {
    const before = await places(page)
    await change()
    await expect.poll(async () => (await places(page)).state.orderHash, { message: `${message}: the change re-ranked the page`, timeout: 30_000 }).not.toBe(before.state.orderHash)
    await settled(page)
    expect(await places(page), `${message}: no entry added, the launch's entry updated where it is and still final`).toEqual({ ...before, state: { ...before.state, orderHash: await orderShown(page) } })
  }
  // on any other final first view: a new entry of the same query, right after it
  const changedElsewhere = async (message: string) => {
    const before = await places(page)
    await change()
    await expect.poll(async () => (await places(page)).state, { message: `${message}: a new entry of the first view`, timeout: 30_000 }).toMatchObject({ index: before.state.index + 1, editorText: '', final: false })
    const after = await places(page)
    expect([after.keys.indexOf(after.at), before.keys.includes(after.at)], `${message}: a new position, right after the first view's`).toEqual([before.keys.indexOf(before.at) + 1, false])
    return after
  }

  // THE LAUNCH'S ENTRY WITH WHAT IS ITS OWN TO KEEP (review 0 of reload_rerank, B3): an entry that Up made,
  // whose mark is what lets Down undo the Up, and which holds a narration's choice that is not the page's
  // live one (`intro`: the lane's page does not narrate, so its live value is false, and the row installs
  // `true` on the entry in the turn of the reload; entry 0 always holds true, this one is entry 1), reloaded
  // on with its order unchanged: the launch writes nothing and leaves both. A re-ranking written over the
  // entry wrote the page's whole view until that review: the mark gone, the live choice saved over the entry's
  const below = await scrollDown(page)
  await recorded()
  await blur(page)
  await page.keyboard.press('Control+Meta+ArrowUp')
  await nearTop(page, 'Up: the top of the page, in an entry of its own')
  await recorded()
  await page
    .evaluate(() => {
      window.addEventListener('pagehide', () => sessionStorage.setItem('e2e_up_left', String(history.state?.scrolledToTop)))
      history.replaceState({ ...history.state, intro: true }, '')
      location.reload()
    })
    .catch(() => undefined) // (the turn's result can be lost to the navigation it starts)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('e2e_up_left')).catch(() => null), { message: "premise: the page went away on Up's entry", timeout: 30_000 }).toBe('true')
  await waitForApp(page)
  await shows('', top, 'the reloaded page shows the first view at the header')
  await settled(page)
  await recorded()
  const own = () => page.evaluate(() => (({ scrolledToTop, intro, final, editorText }) => ({ scrolledToTop, intro, final, editorText }))(history.state))
  const marked = await own()
  expect(marked, "premise: a reload that changes nothing leaves Up's entry as it was: its mark, its narration's choice, final").toEqual({ scrolledToTop: true, intro: true, final: true, editorText: '' })
  expect((await places(page)).state.index, 'premise: and it is not entry 0, which always holds the intro').toBeGreaterThan(0)

  // a change on the launch's first view is written over its entry, which keeps what is its own
  await changedInPlace("a change from another client on the launch's first view")
  expect(await own(), "the launch's entry keeps its mark of Up and its narration's choice through the re-ranking written over it").toEqual(marked)
  // so Down still undoes the Up, once the session knows the entry below (a reloaded session holds the entry
  // it was reloaded on alone): a visit, then Down from the top is Back to the position Up left
  await page.goBack()
  await shows('', below, 'Back onto the view Up left, where it was left')
  await page.goForward()
  await shows('', top, "Forward onto Up's entry")
  await recorded()
  await blur(page)
  await page.keyboard.press('Control+Meta+ArrowDown')
  await shows('', below, 'Down undoes the Up: Back to the position it left')
  await recorded()

  // a first view that is not the launch's, final too (a click on the tag the query names): a change there is
  // a new entry; Back onto the first view
  await typedThenTag(page, reads)
  const targetId = await page.evaluate(() => window._item('#e2e_target')!.id)
  const label = page.locator(`#item-${targetId} mark[title="#e2e_target"]`).first()
  await label.scrollIntoViewIfNeeded()
  await recorded()
  await label.click()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  const atList = await scrollTop(page)
  const list = await places(page)
  expect(list.state, "premise: a first view that is not the launch's, final").toMatchObject({ editorText: '', final: true })
  const ahead = await changedElsewhere("a change from another client on a first view that is not the launch's")
  await page.goBack()
  await shows('', atList, 'Back onto the first view')
  await recorded()
  const kept = await places(page)
  expect(kept, "premise: the first view as it was, the change's entry ahead of it").toEqual({ ...list, keys: ahead.keys })
  expect(kept.state.orderHash, 'premise: the entry holds the order from before the change').not.toBe(await orderShown(page))

  // the reload: no entry added, the entry where and what it was, of the order loaded; the change's entry ahead
  await page.reload()
  await waitForApp(page)
  await shows('', top, 'the reloaded page shows the first view at the header')
  await settled(page)
  const reloaded = await places(page)
  expect({ ...reloaded, state: { ...reloaded.state, orderHash: kept.state.orderHash } }, 'a reload on the first view: no entry added, the entry where and what it was').toEqual(kept)
  expect(reloaded.state.orderHash, 'the entry holds the order loaded').toBe(await orderShown(page))
  await recorded()

  // the entry is the reloaded page's own first view now: a change is written over it, and the entry ahead stays
  await changedInPlace('a change from another client after the reload')
  await recorded()
  await page.goForward()
  await shows('', atList, "Forward onto the change's entry from before the reload")
  expect((await places(page)).at, "the change's entry, kept").toBe(ahead.at)
  await page.goBack()
  await shows('', top, 'Back onto the first view again')

  // A NEW BRANCH IS NOT THE LAUNCH'S ENTRY (review 0 of reload_rerank, B1): Back onto the tag's view and a
  // click on the tag's own label open the full list again, in a new final entry at the launch entry's index
  // and in its run (another position of the browser's: its key). A change there is that entry's own, a new
  // entry after it; taken for the launch's by its run and index, it was written over the list just opened,
  // which stayed final, and Back skipped the list as it had been opened
  await recorded()
  const launched = await places(page)
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await label.scrollIntoViewIfNeeded()
  await recorded()
  await label.click()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  const reopened = await places(page)
  expect(
    [reopened.state.run, reopened.state.index, reopened.state.editorText, reopened.state.final, reopened.at == launched.at],
    "the list opened again: the launch entry's run and index, the empty query, final, at another position of the browser's"
  ).toEqual([launched.state.run, launched.state.index, '', true, false])
  await changedElsewhere('a change from another client on the list opened again')
})

// A RE-RANKING AS THE PAGE STARTS (the owner on the release of 2026-11-18: "i'm still seeing a reload on empty
// mindbox, with #vault in back, adds another empty step, so i have to hit back twice on reload to get to
// #vault"). The launch writes or takes over a FINAL entry, and the first ranking after it whose order differed
// pushed one more entry of the same query (history compares the ordered item ids): item code that touches an
// item or marks one as the page starts, a change from another client, a ranking that counts a missing tag
// which the launch ranked without, where the count moves the item. The fixture is an item whose `_init`
// touches itself (a soft touch, gone with every reload, and the item's saved time is old: every launch of a
// page that holds it changes the order while the page is still initializing), written behind the app before
// the page loads. The re-ranking is written
// over the launch's entry, which STAYS FINAL: written as a re-ranking's own view is, not final, the next typed
// query would replace the full list instead of following it
test("a re-ranking as a reloaded page starts adds no history entry on the full list: the entry is updated where it is, the entry ahead is kept and Back reaches the tag's view behind in one step; the entry stays final, so a query typed on it is a new entry and Back from that returns to the full list; a re-ranking while that Back is restoring the entry leaves it its own position", async ({ page }) => {
  const reads = historyReads(page)
  const { recorded, place, shows } = reads
  const fixture = await firestore()
    .collection('items')
    .add({ user: 'anonymous', time: Date.UTC(2021, 0, 1), attr: null, text: '#e2e_startup_touch #_init\n```js\nfunction _init() { _this.touch() }\n```' })
  const touched = () =>
    page.evaluate(() => {
      const item = (window as any).__items.find((item: any) => item.label == '#e2e_startup_touch')
      return item.time > item.savedTime
    })

  await loadAdmin(page)
  const top = await headerTop(page)
  expect(await touched(), 'premise: the item code touched its item as the page started').toBe(true)
  await typedThenTag(page, reads)
  // the full list in a final entry of its own (a click on the tag the query names), an entry ahead of it left
  // at a position of its own (a query set from a blurred box), then Back onto the full list
  const targetId = await page.evaluate(() => window._item('#e2e_target')!.id)
  const label = page.locator(`#item-${targetId} mark[title="#e2e_target"]`).first()
  await label.scrollIntoViewIfNeeded()
  await recorded()
  const atTag = await scrollTop(page)
  await label.click()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  await blur(page)
  await page.evaluate(() => void (window as any).MindBox.set('#e2e_source'))
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  const atAhead = await place(60)
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  await settled(page)
  const before = await places(page)
  expect(before.state, 'premise: a final entry of the empty query').toMatchObject({ editorText: '', final: true })
  expect(before.keys.indexOf(before.at), 'premise: one entry ahead of it').toBe(before.keys.length - 2)

  // THE RELOAD, WITH ITS RE-RANKING, ADDED NOTHING: the same positions, the browser on the same one, the entry
  // its own (index, run, query, final), of the order shown, which is the touched one
  await page.reload()
  await waitForApp(page)
  await shows('', top, 'the reloaded page shows the first view at the header')
  await settled(page)
  await recorded()
  expect(await touched(), 'premise: the item code touched its item again as the reloaded page started').toBe(true)
  const after = await places(page)
  expect(after, 'a reload whose start re-ranks the list: no entry added, the entry where it was, final, of the order shown').toEqual({ ...before, state: { ...before.state, orderHash: await orderShown(page) } })

  // Back from the full list reaches the tag's view in ONE step, and the entry ahead is still there (a push
  // would have dropped it)
  await page.goBack()
  await shows('#e2e_target ', atTag, "Back from the reloaded full list reaches the tag's view in one step")
  await page.goForward()
  await shows('', top, 'Forward onto the full list')
  await recorded()
  await page.goForward()
  await shows('#e2e_source', atAhead, 'Forward onto the entry ahead of the full list')

  // the entry is still final: a query typed on it is a new entry right after it, and Back returns to the list
  await page.goBack()
  await shows('', top, 'Back onto the full list')
  await recorded()
  const atList = await page.evaluate(() => history.state.scrollPosition as number)
  await blur(page)
  await page.evaluate(() => void (window as any).MindBox.set('#e2e_source'))
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await recorded()
  const typed = await places(page)
  expect([typed.keys.indexOf(after.at), typed.keys.indexOf(typed.at)], 'a query typed on the full list is a new entry right after it').toEqual([after.keys.indexOf(after.at), after.keys.indexOf(after.at) + 1])
  // A RE-RANKING WHILE BACK IS RESTORING THE ENTRY (review 0 of reload_rerank, B2): the route reads the
  // position of the entry reached and scrolls to it frames later; a re-ranking in between (an item's listener
  // that touches an item; here a one-shot listener of the row's, registered after the route's, which touches
  // the item ranked last) is written over the launch's entry while the viewport is still the departed view's,
  // and saved that position on it. The typed view is left at a position of its own, 60 px from the list's
  const atTyped = await place(60)
  await page.evaluate(() => {
    const w = window as any
    window.addEventListener(
      'popstate',
      () => {
        const order = history.state.orderHash
        const last = [...w.__items].reverse().find((item: any) => !item.pinned && !item.log && item.savedId)
        w._item(last.id).touch()
        w.__restoring = { rewritten: history.state.orderHash != order, viewport: document.body.scrollTop, stored: history.state.scrollPosition, held: w._history[w._history_index].scrollPosition }
      },
      { once: true }
    )
  })
  await page.goBack()
  await shows('', top, 'Back from the typed query returns to the full list')
  expect((await places(page)).at, "on the full list's entry").toBe(after.at)
  expect(await page.evaluate(() => (window as any).__restoring), "a re-ranking before the restore has scrolled is written over the entry reached, the viewport still the typed view's, and the entry keeps its own position").toEqual({
    rewritten: true,
    viewport: atTyped,
    stored: atList,
    held: atList,
  })
  await fixture.delete()
})
