import { expect, test, type Locator } from '@playwright/test'
import { asUser, mindbox, focusMindbox, savedId, itemText, userSet, visible, SOURCE_TEXT, scrollTop, headerTop, entries, scrollDown, nearTop, asSet, expand, focusMindboxInPlace, blur, noWritePending, settled } from './editor_helpers.js'
import { firestore, loadAdmin, waitForApp } from './helpers.js'

// editor flows driven by keyboard and mouse, as admin on the anonymous account: creating items from
// the mindbox, searching and url state, tag navigation and history, editing items in place, undelete
// (the suite's self-contained long rows run on the editor2 lane, its later rows on the editor3 and editor4 lanes:
// editor2.spec.ts, editor3.spec.ts, editor4.spec.ts)
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
  // the error border does not inset the menu: the number stands where a plain item's does
  const numberPlace = () =>
    page.evaluate(root => {
      const box = document.querySelector(`.column:not(.hidden) .container[data-item-id="${window._item(root, true)!.id}"]`) as HTMLElement
      const index = box.querySelector('.item-menu > .index') as HTMLElement
      const digits = document.createRange()
      digits.selectNodeContents(index.firstChild!)
      const [whole, num] = [box.getBoundingClientRect(), digits.getBoundingClientRect()]
      return {
        bordered: box.classList.contains('bordered'),
        border: getComputedStyle(box).borderTopColor,
        top: Math.round((num.top - whole.top) * 100) / 100,
        right: Math.round((whole.right - num.right) * 100) / 100,
      }
    }, root)
  const errored = await numberPlace()
  expect([errored.bordered, errored.border], 'premise: the item carries the red error border').toEqual([true, 'rgb(102, 51, 51)'])
  // the missing dependency arrives: the root re-expands, the border clears, nothing is logged
  await page.evaluate(text => void window._create(text), '#e2e_dep_absent\nnow present')
  await expect.poll(bordered, { timeout: 30_000 }).toBe(false)
  const cleared = await numberPlace()
  expect([cleared.bordered, cleared.border], 'premise: the error border cleared').toEqual([false, 'rgba(0, 0, 0, 0)'])
  expect([errored.top, errored.right], `an error item's number stands where a plain item's does (${JSON.stringify({ errored, cleared })})`).toEqual([cleared.top, cleared.right])
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
      .poll(
        () =>
          page.evaluate(
            () =>
              !(window as any)._history_update_pending &&
              !(window as any)._popstate_scroll_pending &&
              (window as any)._history[(window as any)._history_index].scrollPosition === document.body.scrollTop
          ),
        { message: "the entry holds the page's position" }
      )
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
    const { scrolled, beforeSelect, afterSelect } = await asUser(
      page,
      ([id, left]) => {
        const w = window as any
        const beforeSelect = {
          key: (w.navigation?.currentEntry?.key ?? null) as string | null,
          index: (history.state?.index ?? null) as number | null,
          popPending: !!w._popstate_scroll_pending,
          scrollTop: document.body.scrollTop,
          scrollHeight: document.body.scrollHeight,
        }
        const max = document.body.scrollHeight - innerHeight
        document.body.scrollTo(0, left + 48 <= max ? left + 48 : left - 48)
        const scrolled = document.body.scrollTop
        ;(window._item(id as string) as any).select()
        const afterSelect = {
          storedOnDeparted: beforeSelect.index != null ? ((w._history[beforeSelect.index]?.scrollPosition ?? null) as number | null) : null,
          index: (history.state?.index ?? null) as number | null,
          key: (w.navigation?.currentEntry?.key ?? null) as string | null,
          popPending: !!w._popstate_scroll_pending,
        }
        return { scrolled, beforeSelect, afterSelect }
      },
      [plain, left] as const,
    )
    expect(Math.abs(scrolled - left), 'the page was scrolled away from the place recorded').toBeGreaterThan(40)
    await expect(mindbox(page)).toHaveValue(`id:${savedPlain}`)
    await page.goBack()
    await expect(mindbox(page)).toHaveValue('')
    await expect
      .poll(
        async () => {
          const at = await page.evaluate(() => ({
            key: ((window as any).navigation?.currentEntry?.key ?? null) as string | null,
            index: (history.state?.index ?? null) as number | null,
            scrollTop: document.body.scrollTop,
            scrollHeight: document.body.scrollHeight,
            popPending: !!(window as any)._popstate_scroll_pending,
            stored: ((window as any)._history[(window as any)._history_index]?.scrollPosition ?? null) as number | null,
          }))
          if (
            !at.popPending &&
            at.key === beforeSelect.key &&
            at.index === beforeSelect.index &&
            Math.abs(at.scrollTop - scrolled) <= 2
          )
            return 'arrived'
          return { ...at, expected: scrolled, left, beforeSelect, afterSelect }
        },
        { message: 'Back returns to the place the page was scrolled to right before the select' },
      )
      .toEqual('arrived')
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
    await userSet(page, `id:${savedPlain}`)
    await expect.poll(async () => (await read(plain)).target).toBe(true)
    const [index, , final] = await entry()
    expect(final, "A's entry is a typed query's: not final").toBe(false)
    await focusMindboxInPlace(page)
    await expect(mindbox(page)).toBeFocused()
    // B's exact name typed (the input event a key or a paste makes) and B selected, in one turn of the page
    const turn = await asUser(
      page,
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
    await userSet(page, '')
    await expect(mindbox(page)).toHaveValue('')
  })

  await test.step("a tag's view: a green number moves its item up and keeps the query; shift+click selects, in an entry of its own", async () => {
    await userSet(page, TAG)
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
    await userSet(page, NAMED + ' ')
    await expect(number(named)).toHaveClass(/matching/)
    const [index] = await entry()
    await number(named).click({ modifiers: ['Shift'] })
    await settled(page)
    expect([await mindbox(page).inputValue(), (await entry())[0]], 'the box and the entry as they were').toEqual([NAMED + ' ', index])
    // an id reference in the tab's own spelling is the same selection as the saved one: no entry either
    await userSet(page, `id:${plain}`)
    await expect(number(plain)).toHaveClass(/matching/)
    const [tabIndex] = await entry()
    await number(plain).click({ modifiers: ['Shift'] })
    await settled(page)
    expect([await mindbox(page).inputValue(), (await entry())[0]], "the tab's own spelling of the id is left as it is").toEqual([`id:${plain}`, tabIndex])
    // a labeled item's id reference is another view (no children under it): a select gives the label's, in a new entry
    await userSet(page, `id:${savedNamed}`)
    await expect(number(named)).toHaveClass(/matching/)
    const [idIndex] = await entry()
    await number(named).click({ modifiers: ['Shift'] })
    await expect(mindbox(page), "a labeled item's id view is not its selection").toHaveValue(NAMED)
    expect(await entry()).toEqual([idIndex + 1, NAMED, true])
  })

  await test.step('the first view again: option and cmd move a plain number as before, and select nothing', async () => {
    await userSet(page, '')
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
    await userSet(page, '')
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
    await userSet(page, SPELLED)
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
  await userSet(page, '')
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
  // A TEXT SELECTION IS NO EDIT TAP, read at the click and at the PRESS (Item.svelte, onMouseDown): a drag
  // that selects a word opens no editor (its click finds the selection in its target), and neither does
  // the click elsewhere in the item that only ends that selection (the browser collapses a selection at the
  // press, so the click finds none: the item noted at the press that one stood in it). The click after
  // that is a tap. The window's box of a word of an item's text:
  const word = (of: string, text: string) =>
    page.evaluate(
      ([of, text]) => {
        const walker = document.createTreeWalker(document.querySelector(`#item-${of}`)!, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const at = walker.currentNode.nodeValue!.indexOf(text)
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(walker.currentNode, at)
          range.setEnd(walker.currentNode, at + text.length)
          const r = range.getBoundingClientRect()
          return { x: r.x, y: r.y + r.height / 2, width: r.width }
        }
        return null
      },
      [of, text] as const
    )
  // the selection as [its type, its text, the item its anchor is in]: now, and as the next press finds it (a
  // capture listener on the window, which hears the press before the browser acts on it), with the item pressed
  const reading = () => [getSelection()!.type, getSelection()!.toString(), getSelection()!.anchorNode?.parentElement?.closest('.item')?.id ?? null]
  const selection = () => page.evaluate(reading)
  const press = () => page.evaluate(`addEventListener('mousedown', e => (window.__e2e_press = [...(${reading})(), e.target.closest('.item')?.id ?? null]), { capture: true, once: true })`)
  const pressed = () => page.evaluate(() => (window as unknown as { __e2e_press: unknown }).__e2e_press)
  // whether the item's editor is open, once the page has had the time to act on a click
  const editing = async () => {
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
    return page.evaluate(id => !!document.querySelector(`#super-container-${id} .container.editing`), id)
  }
  await paragraph.scrollIntoViewIfNeeded()
  const created = (await word(id, 'created'))!
  await page.mouse.move(created.x + 1, created.y)
  await page.mouse.down()
  await page.mouse.move(created.x + created.width - 1, created.y, { steps: 4 })
  await page.mouse.up()
  expect([await editing(), await selection()], "a drag over a word of the item's text opens no editor, and selects the word").toEqual([false, ['Range', 'created', `item-${id}`]])
  const keyboard = (await word(id, 'keyboard'))!
  await press()
  await page.mouse.click(keyboard.x + keyboard.width / 2, keyboard.y)
  const ended = [await editing(), await pressed(), (await selection())[0] == 'Range']
  expect(ended, 'a click elsewhere in the item, pressed with that selection standing in it, opens no editor: it only ends the selection').toEqual([false, ['Range', 'created', `item-${id}`, `item-${id}`], false])
  await page.mouse.click(keyboard.x + keyboard.width / 2, keyboard.y)
  await expect.poll(async () => [ended[0], await editing()], 'the next click is a tap: the editor opens at it, and not before').toEqual([false, true])
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
  // THE SCOPE IS THE ITEM: a selection that stands in ANOTHER item at the press does not stop this item's tap
  // (the first shown text of another item on the page, selected by a script)
  const other = await page.evaluate(id => {
    const shown = (node: Node) => (node.nodeValue!.trim() && !node.parentElement!.closest('a, mark, style, script') && node.parentElement!.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)
    for (const item of document.querySelectorAll(`.column:not(.hidden) .super-container:not(.hidden) .item:not(#item-${id})`)) {
      const text = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, shown).nextNode()
      if (!text) continue
      getSelection()!.setBaseAndExtent(text, 0, text, text.nodeValue!.length)
      return [getSelection()!.type, getSelection()!.toString(), item.id]
    }
    return null
  }, id)
  expect([other?.[0], !!other?.[1].trim(), other?.[2] != `item-${id}`], "the premise: text is selected in another item's text").toEqual(['Range', true, true])
  await press()
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  await expect(textarea, 'a click on the item, pressed with a selection standing in another item, opens its editor').toBeVisible()
  expect(await pressed(), 'and its press found that selection').toEqual([...other!, `item-${id}`])
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
    await userSet(page, name, { scroll: true })
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
    await userSet(page, '/_undelete', {})
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
  // Run from the item's EDITOR runs the input the editor shows, also after an edit was kept (Close, then
  // Cancel at the discard question, which leaves the draft in the editor alone): the run item gets the
  // changed input, the installed item keeps its text, its editor the draft and its stored document the old input
  const tab = await page.evaluate(() => window._item('#e2e_hidden_input', true)!.id)
  await page.evaluate(() => void ((window._item('#e2e_hidden_input', true) as any).editable = true)) // as /_edit does
  await page.evaluate(() => void (location.hash = '#e2e_hidden_input'))
  await page.locator(`#item-${tab} p`).first().click()
  const editor = page.locator(`#textarea-${tab}`)
  await expect(editor).toBeVisible({ timeout: 10_000 })
  await editor.fill((await editor.inputValue()).replace('1 + 1', '2 + 1'))
  const menu = page.locator(`#super-container-${tab} .edit-menu`)
  await menu.locator('.button.cancel').click()
  await expect(page.getByText('Discard unsaved changes to #e2e_hidden_input?')).toBeVisible({ timeout: 10_000 })
  await page.locator('.modal .button.cancel').click()
  await expect(page.locator('.modal')).toBeHidden({ timeout: 10_000 })
  await menu.locator('.button.run').click()
  await expect.poll(() => page.evaluate(() => window._item('#e2e_hidden_input/run', true)?.text ?? ''), { message: 'the run item got the input the editor shows', timeout: 15_000 }).toContain('2 + 1')
  const kept = () => page.evaluate(id => ((item: any) => [!!item.editing, (item.text as string).includes('1 + 1'), (item.editorText as string).includes('2 + 1')])((window as any).__items.find((item: any) => item.id == id)), tab)
  expect(await kept(), 'the installed item keeps its text, and its open editor the draft').toEqual([true, true, true])
  expect((await firestore().collection('items').doc(id!).get()).data()?.text, 'its stored document keeps the old input').toContain('1 + 1')
  // an INDIRECT run of the installed item, its editor still open with the draft: the Option-run of an item
  // that depends on it runs its runnable dependencies first (an autorun enters the same way). It was not
  // asked for from THAT editor (it is asked for from the other item's own editor here, whose mark must not
  // reach its dependencies), so it runs the SAVED input: the run item's input goes back to `1 + 1` (which
  // also shows that the run happened), and the draft stays in the editor
  const inputs = () => page.evaluate(() => ((text: string) => [text.includes('1 + 1'), text.includes('2 + 1')])(window._item('#e2e_hidden_input/run', true)?.text ?? ''))
  expect(await inputs(), 'premise: the run item holds the changed input alone').toEqual([false, true])
  await page.evaluate(() => void window._create(['#e2e_hidden_user #_e2e_hidden_input', '```js_input', '0', '```'].join('\n')))
  await expect.poll(() => savedId(page, '#e2e_hidden_user'), { timeout: 30_000 }).toBeTruthy()
  const user = await page.evaluate(() => window._item('#e2e_hidden_user', true)!.id)
  await page.evaluate(() => void (location.hash = '#e2e_hidden_user'))
  await page.locator(`#item-${user} p`).first().click()
  await expect(page.locator(`#textarea-${user}`)).toBeVisible({ timeout: 10_000 })
  await page.locator(`#super-container-${user} .edit-menu .button.run`).click({ modifiers: ['Alt'] })
  await expect.poll(inputs, { message: 'the indirect run gave the run item the saved input again', timeout: 15_000 }).toEqual([true, false])
  expect(await kept(), "the draft is still in the installed item's open editor").toEqual([true, true, true])
  // a Run that WAITS is the run of the edit it was asked on, or no run at all. A second installed item
  // with a dependency whose run waits for the row: Option-run from its editor on the draft `2 + 1`; while
  // the dependency waits, that edit is discarded and a new one typed (`3 + 1`); released, the Option-run
  // ends WITHOUT running the installed item: no run item is made, neither with the input nobody ran
  // (`3 + 1`) nor with the discarded one
  type Held = { __hidden_ran?: string[]; __hidden_hold: Promise<void>; __hidden_release: () => void }
  await page.evaluate(async () => {
    await window._create(['#e2e_hidden_wait a dependency whose run waits for the row', '```js_input', ';(window.__hidden_ran ??= []).push(_this.name)', 'return window.__hidden_hold', '```'].join('\n'))
    await window._create(['#e2e_hidden_held #_e2e_hidden_wait an installed item run from its editor', '```js_input_removed', '1 + 1', '```'].join('\n'))
  })
  await expect.poll(async () => [!!(await savedId(page, '#e2e_hidden_wait')), !!(await savedId(page, '#e2e_hidden_held'))], { timeout: 30_000 }).toEqual([true, true])
  await firestore()
    .collection('items')
    .doc((await savedId(page, '#e2e_hidden_held'))!)
    .update({ attr: { source: 'https://github.com/olcan/mind.items/blob/master/e2e_held.md' } })
  await page.reload()
  await waitForApp(page)
  const held = await page.evaluate(() => window._item('#e2e_hidden_held', true)!.id)
  await page.evaluate(() => {
    const w = window as unknown as Held
    w.__hidden_ran = []
    w.__hidden_hold = new Promise(resolve => (w.__hidden_release = resolve))
    ;(window._item('#e2e_hidden_held', true) as any).editable = true // as /_edit does
    location.hash = '#e2e_hidden_held'
  })
  const heldEditor = page.locator(`#textarea-${held}`)
  const heldMenu = page.locator(`#super-container-${held} .edit-menu`)
  const typedInput = async (input: string) => {
    await page.locator(`#item-${held} p`).first().click()
    await expect(heldEditor).toBeVisible({ timeout: 10_000 })
    await heldEditor.fill((await heldEditor.inputValue()).replace('1 + 1', input))
  }
  await typedInput('2 + 1')
  await heldMenu.locator('.button.run').click({ modifiers: ['Alt'] })
  await expect.poll(() => page.evaluate(() => (window as unknown as Held).__hidden_ran), { message: "the dependency's run has begun and waits", timeout: 15_000 }).toEqual(['#e2e_hidden_wait'])
  await heldMenu.locator('.button.cancel').click()
  await expect(page.getByText('Discard unsaved changes to #e2e_hidden_held?')).toBeVisible({ timeout: 10_000 })
  await page.locator('.modal .button.confirm').click()
  await expect(heldEditor).toBeHidden({ timeout: 10_000 })
  await typedInput('3 + 1')
  await page.evaluate(() => (window as unknown as Held).__hidden_release())
  await expect.poll(() => page.evaluate(id => !!(window as any).__items.find((item: any) => item.id == id).running, held), { message: 'the Option-run is over', timeout: 15_000 }).toBe(false)
  expect(
    await page.evaluate(id => ((item: any) => [window._exists('#e2e_hidden_held/run'), !!item.editing, (item.text as string).includes('1 + 1'), (item.editorText as string).includes('3 + 1')])((window as any).__items.find((item: any) => item.id == id)), held),
    'no run item was made: the edit the run was asked on is gone, and the new one was not run; it stays in its editor'
  ).toEqual([false, true, true, true])
  expect(errors.filter(e => e.includes('TypeError'))).toEqual([])
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
    await userSet(page, name, { scroll: true })
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
    await userSet(page, query, { scroll: true })
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
  await userSet(page, '#e2e_jump', { scroll: true })
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
  await userSet(page, '#e2e_select/a', { scroll: true })
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
  await userSet(page, '#e2e_image_key', { scroll: true })
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
    await userSet(page, name, { scroll: true })
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
  await page.locator(`#item-${id} mark[title="#e2e_esc/sub"]:not(.child-tag)`).click() // written tag, not hidden repeated drawn mark
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
  // (within a key press of the row's, as every typed step here: text typed from the page's script alone is no
  // input of the user's, and its query would be written over the entry instead of following it)
  const pending = await asUser(page, dispatchArrow => {
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
  const far = await asUser(
    page,
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
  await userSet(page, ROOT, { scroll: true })
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
  await userSet(page, ROOT, { scroll: true })
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
  // `#/0` makes ROOT match ITEM so the final plain click on ROOT's index button is an explicit touch (since 2026-11-18 a
  // non-matching number selects instead, which passed only while 1-line ROOT stayed in view; drawn #/0 made ROOT taller)
  for (const text of [`${ROOT} root #/0`, `${ITEM} the item being read`, `${CHILD} its child`]) await page.evaluate(text => void window._create(text), text)
  await userSet(page, ROOT, { scroll: true })
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
  await userSet(page, ROOT, { scroll: true })
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
  await userSet(page, ROOT, { scroll: true })
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

test('Option+Down selects the newest descendant at any depth, walks consecutive presses to the end without wrapping, handles the global case including unnamed items, and yields inside an item editor', async ({ page }) => {
  // the owner (2026-11-24): Option+Down (Alt+ArrowDown alone) selects the newest item below the selected one
  // at any depth by item.time, walks consecutive presses to the next newest from the same start without going
  // back up, ends quietly with no wrap, handles the empty-box global case (non-pinned, unnamed included by
  // id:<savedId>), leaves plain Down and two-modifier scroll shortcuts intact, and stays text navigation
  // inside an item's open editor
  await loadAdmin(page)
  const PARENT = '#e2e_od'
  const CHILD_A = `${PARENT}/a`
  const DEEP = `${CHILD_A}/deep`
  const CHILD_B = `${PARENT}/b`
  const PIN = '#e2e_od_pin'
  const UNNAMED_TEXT = 'e2e_od_unnamed_body without label'
  const fixtures = [
    `${PARENT} parent\n\nsecond line`,
    `${CHILD_A} child a`,
    `${DEEP} grandchild deep`,
    `${CHILD_B} child b`,
    `${PIN} #_pin pinned newer than everything`,
    UNNAMED_TEXT,
  ]
  await page.evaluate(texts => texts.forEach(text => void window._create(text)), fixtures)
  // wait for all six creates to finish saving so no onSaveDone overwrites our deterministic times
  await expect
    .poll(
      () =>
        page.evaluate(
          ([labels, unnamed]) => {
            const list = (window as any).__items as any[]
            const found = [...labels.map(l => list.find(i => i.label == l)), list.find(i => i.text == unnamed)]
            return found.every(i => i && i.savedId && !i.saving && !i.saveTask && !(i.unackedWrites?.length))
          },
          [[PARENT, CHILD_A, DEEP, CHILD_B, PIN], UNNAMED_TEXT] as const
        ),
      { message: 'fixture items saved and idle', timeout: 30_000 }
    )
    .toBe(true)

  const setFixtureTimes = () =>
    page.evaluate(
      ([labels, unnamed]) => {
        const list = (window as any).__items as any[]
        const maxTime = Math.max(Date.now(), ...list.map(i => (Number.isFinite(i.time) ? i.time : 0)))
        const base = maxTime + 60_000
        const byLabel = (l: string) => list.find(i => i.label == l)
        const unnamedItem = list.find(i => i.text == unnamed)
        const plan: [any, number][] = [
          [byLabel(labels[4]), base + 5000], // pinned: newest overall, must be skipped globally
          [unnamedItem, base + 4000], // unnamed: newest non-pinned item of all
          [byLabel(labels[2]), base + 3000], // grandchild (2 levels down): newest descendant of PARENT
          [byLabel(labels[1]), base + 2000], // child a: 2nd newest descendant of PARENT
          [byLabel(labels[3]), base + 1000], // child b (leaf): 3rd newest descendant of PARENT
          [byLabel(labels[0]), base + 500], // parent
        ]
        for (const [it, t] of plan) it.time = it.savedTime = t
        return {
          parentId: byLabel(labels[0]).id as string,
          parentSavedId: byLabel(labels[0]).savedId as string,
          unnamedSavedId: unnamedItem.savedId as string,
          times: [byLabel(labels[2]).time, byLabel(labels[1]).time, byLabel(labels[3]).time] as number[],
        }
      },
      [[PARENT, CHILD_A, DEEP, CHILD_B, PIN], UNNAMED_TEXT] as const
    )
  const { parentId, parentSavedId, unnamedSavedId, times } = await setFixtureTimes()

  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  const descTimes = () =>
    page.evaluate(
      labels => labels.map(l => (window as any).__items.find((i: any) => i.label == l)?.time),
      [DEEP, CHILD_A, CHILD_B]
    )

  // 1. From selected parent: lands 2 levels down on newest descendant, walks to end, no wrap, times kept, Back steps 1 by 1
  await userSet(page, PARENT, { scroll: true })
  await expect.poll(query).toMatch(/^#e2e_od ?$/)
  await blur(page)
  const [len0, idx0] = await entries(page)

  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query, { message: '1st Option+Down lands on newest descendant two levels down' }).toBe(`${DEEP} `)
  expect(await entries(page), '1st Option+Down pushes a history entry').toEqual([len0 + 1, idx0 + 1])
  expect(await descTimes(), 'Option+Down keeps item times').toEqual(times)

  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query, { message: '2nd Option+Down walks to next newest below the same parent' }).toBe(`${CHILD_A} `)
  expect(await entries(page), '2nd Option+Down pushes a history entry').toEqual([len0 + 2, idx0 + 2])

  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query, { message: '3rd Option+Down walks to oldest descendant below the same parent' }).toBe(`${CHILD_B} `)
  expect(await entries(page), '3rd Option+Down pushes a history entry').toEqual([len0 + 3, idx0 + 3])

  // at the walk's end: default prevented, no box change, no history entry, no scroll, no wrap
  const scrollBeforeEnd = await scrollTop(page)
  await page.evaluate(() => {
    ;(window as any).__odEndPrevented = null
    const onEndKey = (e: KeyboardEvent) => {
      if (e.code == 'ArrowDown' && e.altKey) {
        ;(window as any).__odEndPrevented = e.defaultPrevented
        window.removeEventListener('keydown', onEndKey)
      }
    }
    window.addEventListener('keydown', onEndKey)
  })
  await page.keyboard.press('Alt+ArrowDown')
  expect(await page.evaluate(() => (window as any).__odEndPrevented), 'default prevented at walk end').toBe(true)
  expect(await query(), 'walk end changes nothing').toBe(`${CHILD_B} `)
  expect(await entries(page), 'walk end adds no history entry').toEqual([len0 + 3, idx0 + 3])
  expect(await scrollTop(page), 'walk end does not scroll').toBe(scrollBeforeEnd)
  // a second press at the end still does not wrap
  await page.keyboard.press('Alt+ArrowDown')
  expect(await query(), 'repeated press at walk end does not wrap').toBe(`${CHILD_B} `)
  expect(await entries(page), 'repeated press at walk end adds no history entry').toEqual([len0 + 3, idx0 + 3])

  // Back steps back through the walk one entry at a time
  await page.goBack()
  await expect.poll(query, { message: 'Back 1 returns to child a' }).toBe(`${CHILD_A} `)
  await page.goBack()
  await expect.poll(query, { message: 'Back 2 returns to grandchild deep' }).toBe(`${DEEP} `)
  await page.goBack()
  await expect.poll(query, { message: 'Back 3 returns to parent' }).toMatch(/^#e2e_od ?$/)

  // 2. Plain Down is as before, and a plain Down or a click in between starts the walk anew
  await blur(page)
  await page.keyboard.press('ArrowDown')
  await expect.poll(query, { message: 'plain Down from parent still selects first direct child' }).toBe(`${CHILD_A} `)

  // plain Down in between: start walk from parent -> deep -> child a, then plain Down to deep (leaf), then Option+Down must do nothing (not continue to child b)
  await userSet(page, PARENT, { scroll: true })
  await expect.poll(query).toMatch(/^#e2e_od ?$/)
  await blur(page)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query).toBe(`${DEEP} `)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query).toBe(`${CHILD_A} `)
  await page.keyboard.press('ArrowDown')
  await expect.poll(query, { message: 'plain Down enters direct child of child a' }).toBe(`${DEEP} `)
  await page.keyboard.press('Alt+ArrowDown')
  expect(await query(), 'Option+Down after plain Down starts anew on leaf and does nothing').toBe(`${DEEP} `)

  // click in between: start walk from parent -> deep, then click child a on parent context, then Option+Down starts anew from child a (-> deep, not child b)
  await userSet(page, PARENT, { scroll: true })
  await expect.poll(query).toMatch(/^#e2e_od ?$/)
  await blur(page)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query).toBe(`${DEEP} `)
  await expect.poll(() => page.locator(`#item-${parentId} mark[title="${CHILD_A}"]`).count()).toBeGreaterThan(0)
  await page.locator(`#item-${parentId} mark[title="${CHILD_A}"]`).first().click()
  await expect.poll(query, { message: 'click on child a selects child a' }).toBe(`${CHILD_A} `)
  await blur(page)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query, { message: 'Option+Down after click starts anew from child a' }).toBe(`${DEEP} `)

  // 3. MindBox context (at end edge) and second-modifier rejection
  await userSet(page, PARENT, { scroll: true })
  await expect.poll(query).toMatch(/^#e2e_od ?$/)
  // two-modifier scroll shortcut stays intact
  await expand(page)
  const scrolled = await scrollDown(page)
  await blur(page)
  await page.keyboard.press('Control+Alt+ArrowUp')
  await nearTop(page, 'Control+Alt+ArrowUp scrolls to top')
  await page.keyboard.press('Control+Alt+ArrowDown')
  await expect.poll(() => scrollTop(page), { message: 'Control+Alt+ArrowDown keeps scroll-back shortcut' }).toBeGreaterThan(scrolled - 100)
  expect(await query(), 'Control+Alt+ArrowDown does not trigger Option+Down navigation').toMatch(/^#e2e_od ?$/)

  // Shift+Alt+ArrowDown in MindBox (at end edge) must NOT propagate or trigger Option+Down
  const boxTextNow = await query()
  await focusMindboxInPlace(page, boxTextNow.length)
  await page.evaluate(() => {
    ;(window as any).__odShiftAltReachedWindow = false
    const onShiftAlt = (e: KeyboardEvent) => {
      if (e.code == 'ArrowDown' && e.altKey && e.shiftKey) (window as any).__odShiftAltReachedWindow = true
    }
    ;(window as any).__odShiftAltCleanup = () => window.removeEventListener('keydown', onShiftAlt)
    window.addEventListener('keydown', onShiftAlt)
  })
  await page.keyboard.press('Shift+Alt+ArrowDown')
  const shiftAltReached = await page.evaluate(() => {
    ;(window as any).__odShiftAltCleanup?.()
    delete (window as any).__odShiftAltCleanup
    return (window as any).__odShiftAltReachedWindow as boolean
  })
  expect(shiftAltReached, 'Shift+Alt+ArrowDown in MindBox does not propagate to window').toBe(false)
  expect(await query(), 'Shift+Alt+ArrowDown in MindBox keeps query').toBe(boxTextNow)
  await expect(mindbox(page), 'Shift+Alt+ArrowDown keeps MindBox focused').toBeFocused()

  // Alt+ArrowDown alone in MindBox (at end edge) IS taken
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query, { message: 'Option+Down from MindBox at end selects newest descendant' }).toBe(`${DEEP} `)
  await expect(mindbox(page), 'Option+Down blurs MindBox after navigating').not.toBeFocused()

  // Alt+ArrowDown on a leaf in MindBox (at end edge; fresh start on the leaf): does nothing, keeps focus and caret
  await userSet(page, DEEP, { scroll: true })
  await expect.poll(query).toBe(DEEP)
  await focusMindboxInPlace(page, DEEP.length)
  await page.keyboard.press('Alt+ArrowDown')
  expect(await query(), 'Option+Down on leaf in MindBox changes nothing').toBe(DEEP)
  await expect(mindbox(page), 'Option+Down on leaf keeps MindBox focused').toBeFocused()
  expect(await page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).selectionStart)).toBe(DEEP.length)

  // 4. Empty box (global case): plain Down still picks newest uniquely labeled; Option+Down skips pinned and picks unnamed by id:<savedId>, then walks on; start by id does nothing
  await setFixtureTimes() // restore deterministic times after Part 2-3 soft-touches
  await userSet(page, '')
  await expect.poll(query).toBe('')
  await blur(page)
  await page.keyboard.press('ArrowDown')
  await expect.poll(query, { message: 'plain Down on empty box still selects newest uniquely labeled item' }).toBe(`${DEEP} `)

  await userSet(page, '')
  await expect.poll(query).toBe('')
  await blur(page)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query, { message: 'Option+Down on empty box skips pinned and selects newest unnamed item by id' }).toBe(`id:${unnamedSavedId}`)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query, { message: '2nd global Option+Down walks on to next newest item' }).toBe(`${DEEP} `)

  // a fresh Option+Down on an item selected by id has nothing below it (even if uniquely labeled with descendants)
  await userSet(page, `id:${parentSavedId}`)
  await expect.poll(query).toBe(`id:${parentSavedId}`)
  await blur(page)
  await page.keyboard.press('Alt+ArrowDown')
  expect(await query(), 'Option+Down from id reference does nothing').toBe(`id:${parentSavedId}`)

  // 5. Inside an item's open editor, Option+Down is NOT taken and keeps its meaning for the text
  await userSet(page, PARENT, { scroll: true })
  await expect.poll(query).toMatch(/^#e2e_od ?$/)
  const secondLine = page.locator(`#item-${parentId} p`).nth(1)
  await expect(secondLine).toBeVisible()
  await secondLine.click()
  const itemTextarea = page.locator(`#textarea-${parentId}`)
  await expect(itemTextarea).toBeFocused()
  await page.evaluate(id => {
    const t = document.getElementById('textarea-' + id) as HTMLTextAreaElement
    t.setSelectionRange(0, 0)
    ;(window as any).__odEditorProbe = { windowSaw: false, prevented: null as boolean | null }
    const onTaKey = (e: KeyboardEvent) => {
      if (e.code == 'ArrowDown' && e.altKey) (window as any).__odEditorProbe.prevented = e.defaultPrevented
    }
    const onWinKey = (e: KeyboardEvent) => {
      if (e.code == 'ArrowDown' && e.altKey) (window as any).__odEditorProbe.windowSaw = true
    }
    t.addEventListener('keydown', onTaKey)
    window.addEventListener('keydown', onWinKey)
    ;(window as any).__odEditorCleanup = () => {
      t.removeEventListener('keydown', onTaKey)
      window.removeEventListener('keydown', onWinKey)
    }
  }, parentId)
  await page.keyboard.press('Alt+ArrowDown')
  const probe = await page.evaluate(id => {
    ;(window as any).__odEditorCleanup?.()
    delete (window as any).__odEditorCleanup
    const t = document.getElementById('textarea-' + id) as HTMLTextAreaElement
    return { ...(window as any).__odEditorProbe, caret: t.selectionStart }
  }, parentId)
  expect(probe.windowSaw, 'item editor stops Option+Down propagation').toBe(false)
  expect(probe.prevented, 'item editor leaves Option+Down default action intact').toBe(false)
  expect(probe.caret, 'Option+Down moved the caret inside the item editor').toBeGreaterThan(0)
  expect(await query(), 'Option+Down inside item editor does not navigate').toMatch(/^#e2e_od ?$/)
  await expect(itemTextarea, 'item editor keeps focus').toBeFocused()
  await page.keyboard.press('Escape')
  await expect(itemTextarea).toBeHidden()

  // 6. The parent TYPED into the box and the key pressed before the query's debounce ends (review 0 of
  // option_down): the pending query is settled first, as typing is, so the jump is a final entry of its own
  // after the parent's: Back returns to the parent, Forward to the child. Applied alone, the jump's query
  // cancelled the typed one's, and on a box that had shown that very child it wrote no entry at all
  await setFixtureTimes()
  await userSet(page, PARENT, { scroll: true })
  await expect.poll(query).toMatch(/^#e2e_od ?$/)
  await blur(page)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(query, { message: 'the newest child, by the key: the box and the history show it' }).toBe(`${DEEP} `)
  const [len6, idx6] = await entries(page)
  await focusMindboxInPlace(page)
  await expect(mindbox(page)).toBeFocused()
  // the parent's name typed (the input event a key or a paste makes) and the key, in one turn of the page
  const turn = await asUser(
    page,
    parent => {
      const w = window as any
      const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      box.value = parent
      box.setSelectionRange(parent.length, parent.length)
      box.dispatchEvent(new Event('input'))
      const pending = w._editor_change_pending as boolean
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }))
      return { pending, still: w._editor_change_pending as boolean, focused: document.activeElement == box, entry: [history.state.editorText, history.state.final] }
    },
    PARENT,
  )
  expect(turn, 'the typed parent was pending; the key settled it and selected the child at once, in a final entry, the box blurred').toEqual({ pending: true, still: false, focused: false, entry: [`${DEEP} `, true] })
  expect(await entries(page), 'two entries: the typed parent, then the child').toEqual([len6 + 2, idx6 + 2])
  await page.goBack()
  await expect.poll(query, { message: 'Back restores the parent as typed' }).toBe(PARENT)
  await page.goForward()
  await expect.poll(query, { message: 'Forward restores the child' }).toBe(`${DEEP} `)
  // a press on the restored child (a leaf) stays there, though the walk that selected it had a sibling left
  // to visit: the history's restore ended that walk
  await blur(page)
  const restored = await entries(page)
  await page.keyboard.press('Alt+ArrowDown')
  expect(await query(), 'a press on the restored leaf changes nothing').toBe(`${DEEP} `)
  expect(await entries(page), 'and writes no entry').toEqual(restored)

  // clean up fixtures so later runs see a tidy account
  await page.evaluate(
    ([labels, unnamed]) => {
      for (const label of labels) window._item(label, true)?.delete(false)
      const u = (window as any).__items.find((i: any) => i.text == unnamed)
      if (u) window._item(u.id, true)?.delete(false)
    },
    [[DEEP, CHILD_A, CHILD_B, PARENT, PIN], UNNAMED_TEXT] as const
  )
  await userSet(page, '')
  await expect
    .poll(
      () =>
        page.evaluate(
          ([labels, unnamed]) => {
            const list = (window as any).__items as any[]
            return !list.some(i => labels.includes(i.label) || i.text == unnamed)
          },
          [[PARENT, CHILD_A, DEEP, CHILD_B, PIN], UNNAMED_TEXT] as const
        ),
      { message: 'fixture items removed', timeout: 15_000 }
    )
    .toBe(true)
})

test('Option+Up steps back through an Option+Down walk to its start, stops there, does nothing outside a walk, and keeps plain Up and editors intact', async ({ page }) => {
  // the owner (2026-11-26): Option+Down starts a walk from a uniquely labeled item or the empty
  // box and goes on in it; Option+Up steps back through the active walk to its start and stops
  // there; neither does anything else (no parent nav, no box/history/scroll change, default
  // prevented). Plain Up keeps its existing behaviour; MindBox propagates Option+Up only at
  // the start edge (selectionEnd == 0), and an item editor keeps it for text movement
  await loadAdmin(page)
  const GRAND = '#e2e_ou'
  const START = `${GRAND}/p`
  const CHILD_A = `${START}/a`
  const DEEP = `${CHILD_A}/deep`
  const CHILD_B = `${START}/b`
  const PIN = '#e2e_ou_pin'
  const DUP = '#e2e_ou_dup'
  const DUP_CHILD = `${DUP}/child`
  const UNNAMED_TEXT = 'e2e_ou_unnamed_body without label'
  const filler = Array.from({ length: 40 }, (_, i) => `ou filler line ${i + 1}`).join('\n\n')
  const labels = [GRAND, START, CHILD_A, DEEP, CHILD_B, PIN, DUP, DUP_CHILD]
  const fixtures = [
    `${GRAND} grandparent`,
    `${START} start parent\n\nsecond line`,
    `${CHILD_A} child a`,
    `${DEEP} grandchild deep`,
    `${CHILD_B} child b`,
    `${PIN} #_pin pinned newer than everything\n\n${filler}`,
    `${DUP} duplicate one`,
    `${DUP} duplicate two`,
    `${DUP_CHILD} duplicate child`,
    UNNAMED_TEXT,
  ]
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  const targetId = () =>
    page.evaluate(() => document.querySelector('.super-container.target')?.getAttribute('id')?.replace(/^super-container-/, '') ?? null)
  const targetInBand = () =>
    page.evaluate(() => {
      const elem = document.querySelector('.super-container.target') as HTMLElement | null
      if (!elem) return false
      return elem.offsetTop >= document.body.scrollTop && elem.offsetTop <= document.body.scrollTop + visualViewport!.height - 200
    })

  try {
    await page.evaluate(texts => texts.forEach(text => void window._create(text)), fixtures)
    await expect
      .poll(
        () =>
          page.evaluate(
            ([ls, unnamed, count]) => {
              const list = (window as any).__items as any[]
              const found = list.filter(i => ls.includes(i.label) || i.text == unnamed)
              return found.length == count && found.every(i => i.savedId && !i.saving && !i.saveTask && !(i.unackedWrites?.length))
            },
            [labels, UNNAMED_TEXT, fixtures.length] as const
          ),
        { message: 'fixture items saved and idle', timeout: 30_000 }
      )
      .toBe(true)

    const setFixtureTimes = () =>
      page.evaluate(
        ([ls, unnamed]) => {
          const list = (window as any).__items as any[]
          const maxTime = Math.max(Date.now(), ...list.map(i => (Number.isFinite(i.time) ? i.time : 0)))
          const base = maxTime + 60_000
          const byLabel = (l: string) => list.find(i => i.label == l)
          const unnamedItem = list.find(i => i.text == unnamed)
          const plan: [any, number][] = [
            [byLabel(ls[5]), base + 5000], // pinned: newest overall, skipped globally
            [unnamedItem, base + 4000], // unnamed: newest non-pinned item of all
            [byLabel(ls[3]), base + 3000], // deep: newest descendant of START
            [byLabel(ls[2]), base + 2000], // child a: 2nd newest descendant of START
            [byLabel(ls[4]), base + 1000], // child b: 3rd newest descendant of START
            [byLabel(ls[1]), base + 500], // start parent (itself has parent GRAND)
            [byLabel(ls[0]), base + 200], // grandparent
          ]
          for (const [it, t] of plan) it.time = it.savedTime = t
          return {
            grandId: byLabel(ls[0]).id as string,
            startId: byLabel(ls[1]).id as string,
            startSavedId: byLabel(ls[1]).savedId as string,
            childAId: byLabel(ls[2]).id as string,
            deepId: byLabel(ls[3]).id as string,
            childBId: byLabel(ls[4]).id as string,
            unnamedId: unnamedItem.id as string,
            unnamedSavedId: unnamedItem.savedId as string,
            times: [byLabel(ls[3]).time, byLabel(ls[2]).time, byLabel(ls[4]).time] as number[],
          }
        },
        [labels, UNNAMED_TEXT] as const
      )
    const { grandId, startId, startSavedId, childAId, deepId, childBId, unnamedId, unnamedSavedId, times } = await setFixtureTimes()
    const descTimes = () =>
      page.evaluate(ls => ls.map(l => (window as any).__items.find((i: any) => i.label == l)?.time), [DEEP, CHILD_A, CHILD_B])

    // 1. Labelled walk: Down x3 -> Up x3 back to START -> Up stops at START (does NOT climb to GRAND) -> Down to 1st -> Back through every step
    await userSet(page, START, { scroll: true })
    await expect.poll(query).toMatch(/^#e2e_ou\/p ?$/)
    await expect.poll(targetId).toBe(startId)
    await blur(page)
    const [len0, idx0] = await entries(page)

    const expectStep = async (wantQuery: string, wantTarget: string | null, step: number, msg: string) => {
      await expect.poll(query, { message: `${msg}: box` }).toBe(wantQuery)
      await expect.poll(targetId, { message: `${msg}: target` }).toBe(wantTarget)
      expect(await entries(page), `${msg}: history`).toEqual([len0 + step, idx0 + step])
      await expect(mindbox(page), `${msg}: blurred`).not.toBeFocused()
      if (wantTarget) await expect.poll(targetInBand, { message: `${msg}: scrolled to target` }).toBe(true)
    }

    const expectAltNoOp = async (code: 'ArrowUp' | 'ArrowDown', msg: string) => {
      await expect
        .poll(() => page.evaluate(() => !(window as any)._editor_change_pending), { message: `${msg}: query settled` })
        .toBe(true)
      const before = await page.evaluate(async wanted => {
        await Promise.resolve((window as any)._update_dom?.())
        await new Promise(r => requestAnimationFrame(() => r(undefined)))
        ;(window as any).__ouNoOpProbe = { seen: false, prevented: null as boolean | null }
        const onKey = (e: KeyboardEvent) => {
          if (e.code == wanted && e.altKey) {
            ;(window as any).__ouNoOpProbe = { seen: true, prevented: e.defaultPrevented }
            window.removeEventListener('keydown', onKey)
          }
        }
        window.addEventListener('keydown', onKey)
        return {
          box: (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value,
          target: document.querySelector('.super-container.target')?.getAttribute('id')?.replace(/^super-container-/, '') ?? null,
          entries: [(window as any)._history.length, (window as any)._history_index] as [number, number],
          scroll: document.body.scrollTop,
          focused: document.activeElement?.id === 'textarea-mindbox',
        }
      }, code)
      await page.keyboard.press(`Alt+${code}`)
      const after = await page.evaluate(() => ({
        probe: (window as any).__ouNoOpProbe as { seen: boolean; prevented: boolean | null },
        view: {
          box: (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value,
          target: document.querySelector('.super-container.target')?.getAttribute('id')?.replace(/^super-container-/, '') ?? null,
          entries: [(window as any)._history.length, (window as any)._history_index] as [number, number],
          scroll: document.body.scrollTop,
          focused: document.activeElement?.id === 'textarea-mindbox',
        },
      }))
      expect(after.probe, `${msg}: key reached window and default prevented`).toEqual({ seen: true, prevented: true })
      expect(after.view, `${msg}: view unchanged`).toEqual(before)
    }

    await page.keyboard.press('Alt+ArrowDown')
    await expectStep(`${DEEP} `, deepId, 1, '1st Option+Down')
    await page.keyboard.press('Alt+ArrowDown')
    await expectStep(`${CHILD_A} `, childAId, 2, '2nd Option+Down')
    await page.keyboard.press('Alt+ArrowDown')
    await expectStep(`${CHILD_B} `, childBId, 3, '3rd Option+Down')

    // scroll away so the first Option+Up must visibly scroll back to its target
    const top = await headerTop(page)
    const scrollAwayTo = await page.evaluate(header => {
      const target = document.querySelector('.super-container.target') as HTMLElement
      return target.offsetTop < header + 300 ? header + 600 : header
    }, top)
    await expect
      .poll(
        async () => {
          await page.evaluate(y => document.body.scrollTo(0, y), scrollAwayTo)
          await page.waitForTimeout(100)
          return targetInBand()
        },
        { message: 'scrolled away from target before stepping back' }
      )
      .toBe(false)
    const scrolledBeforeUp = await scrollTop(page)

    await page.keyboard.press('Alt+ArrowUp')
    await expectStep(`${CHILD_A} `, childAId, 4, '1st Option+Up back to child a')
    await expect.poll(async () => Math.abs((await scrollTop(page)) - scrolledBeforeUp), { message: 'Option+Up scrolled to target' }).toBeGreaterThan(100)

    await page.keyboard.press('Alt+ArrowUp')
    await expectStep(`${DEEP} `, deepId, 5, '2nd Option+Up back to deep')

    await page.keyboard.press('Alt+ArrowUp')
    await expectStep(`${START} `, startId, 6, '3rd Option+Up back to start')

    // at the start: stops quietly (does NOT climb to GRAND), default prevented, no history entry, no scroll, stays blurred
    await expectAltNoOp('ArrowUp', 'Option+Up at walk start (does not climb to grandparent)')

    // walk is still on at the start: Option+Down goes forward again to the 1st item, times kept
    await page.keyboard.press('Alt+ArrowDown')
    await expectStep(`${DEEP} `, deepId, 7, 'Option+Down from start goes forward to 1st again')
    expect(await descTimes(), 'walk down and back up keeps item times').toEqual(times)

    // Back returns step by step through the walk
    const backSteps: [string, string][] = [
      [`${START} `, startId],
      [`${DEEP} `, deepId],
      [`${CHILD_A} `, childAId],
      [`${CHILD_B} `, childBId],
      [`${CHILD_A} `, childAId],
      [`${DEEP} `, deepId],
    ]
    for (const [i, [wantQuery, wantTarget]] of backSteps.entries()) {
      await page.goBack()
      await expect.poll(query, { message: `Back ${i + 1}: box` }).toBe(wantQuery)
      await expect.poll(targetId, { message: `Back ${i + 1}: target` }).toBe(wantTarget)
    }
    await page.goBack()
    await expect.poll(query, { message: 'Back 7 returns to initial start entry' }).toMatch(/^#e2e_ou\/p ?$/)
    await expect.poll(targetId, { message: 'Back 7 target' }).toBe(startId)

    // 2. Plain Up in a walk goes to parent and ends the walk; Option+Up outside a walk does nothing (and plain Up from the same place still goes to parent); Option+Down does nothing where box names no starting point
    await blur(page)
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(query).toBe(`${DEEP} `)
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(query).toBe(`${CHILD_A} `)
    await expect.poll(targetId).toBe(childAId)
    // in walk at CHILD_A: walk-previous is DEEP, while parent is START
    await page.keyboard.press('ArrowUp')
    await expect.poll(query, { message: 'plain Up in walk goes to parent START, not walk-previous DEEP' }).toBe(`${START} `)
    await expect.poll(targetId).toBe(startId)
    // plain Up ended the walk, so Option+Up on START now does nothing (does NOT climb to GRAND)
    await expectAltNoOp('ArrowUp', 'Option+Up after plain Up ended walk')
    // plain Up from the same place still goes to parent GRAND
    await page.keyboard.press('ArrowUp')
    await expect.poll(query, { message: 'plain Up from START goes to parent GRAND' }).toBe(`${GRAND} `)
    await expect.poll(targetId).toBe(grandId)

    // Option+Up outside any walk does nothing (box, target, history, scroll unchanged, default prevented); plain Up from the same place goes to parent
    await userSet(page, CHILD_A, { scroll: true })
    await expect.poll(targetId).toBe(childAId)
    await blur(page)
    await expectAltNoOp('ArrowUp', 'Option+Up outside a walk on labelled item')
    await page.keyboard.press('ArrowUp')
    await expect.poll(query, { message: 'plain Up from same labelled item still goes to parent START' }).toBe(`${START} `)
    await expect.poll(targetId).toBe(startId)

    // Option+Down does nothing where the box names no starting point (search, id ref, duplicate label, #log); Option+Up also does nothing on a search
    for (const [label, box] of [
      ['search query', 'ou filler'],
      ['id reference', `id:${startSavedId}`],
      ['duplicate label', DUP],
      ['log query', '#log'],
    ] as const) {
      await userSet(page, box)
      await expect.poll(query).toBe(box)
      await blur(page)
      await expectAltNoOp('ArrowDown', `Option+Down on ${label}`)
      if (label == 'search query') await expectAltNoOp('ArrowUp', 'Option+Up outside a walk on search query')
    }

    // 3. Global walk from empty box: Option+Up with no walk does nothing (even scrolled down); Option+Down walks globally, Option+Up steps back to empty box and stops, Option+Down goes forward again
    await setFixtureTimes()
    await userSet(page, '')
    await expect.poll(query).toBe('')
    await expect.poll(targetId).toBeNull()
    await blur(page)
    await page.evaluate(header => document.body.scrollTo(0, header + 250), top)
    await expectAltNoOp('ArrowUp', 'Option+Up with no walk on empty box (no focus, no header scroll)')
    const [gLen, gIdx] = await entries(page)

    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(query, { message: '1st global Option+Down' }).toBe(`id:${unnamedSavedId}`)
    await expect.poll(targetId).toBe(unnamedId)
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(query, { message: '2nd global Option+Down' }).toBe(`${DEEP} `)
    await expect.poll(targetId).toBe(deepId)

    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(query, { message: '1st global Option+Up returns to unnamed item' }).toBe(`id:${unnamedSavedId}`)
    await expect.poll(targetId).toBe(unnamedId)
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(query, { message: '2nd global Option+Up returns to empty box' }).toBe('')
    await expect.poll(targetId, { message: 'empty box has no target' }).toBeNull()
    expect(await entries(page), 'global walk down x2 + up x2 pushed 4 entries').toEqual([gLen + 4, gIdx + 4])
    await expect(mindbox(page), 'step back to empty box blurs MindBox').not.toBeFocused()

    // further Option+Up at global start stops quietly (default prevented, no history entry, no scroll, no MindBox focus)
    await expectAltNoOp('ArrowUp', 'Option+Up at global start')

    // forward again from global start returns to 1st item
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(query, { message: 'Option+Down from global start returns to 1st item' }).toBe(`id:${unnamedSavedId}`)
    await expect.poll(targetId).toBe(unnamedId)
    expect(await entries(page)).toEqual([gLen + 5, gIdx + 5])

    // 4. MindBox editor (start edge only, Shift+Alt rejected, pending debounce settled) and item editor
    await setFixtureTimes()
    await userSet(page, START, { scroll: true })
    await expect.poll(targetId).toBe(startId)
    await blur(page)
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(query).toBe(`${DEEP} `)
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(query).toBe(`${CHILD_A} `)

    // caret at end of MindBox text: Option+Up does NOT propagate or step back
    await focusMindboxInPlace(page, `${CHILD_A} `.length)
    await page.evaluate(() => {
      ;(window as any).__ouMidReachedWindow = false
      const onKey = (e: KeyboardEvent) => {
        if (e.code == 'ArrowUp' && e.altKey) (window as any).__ouMidReachedWindow = true
      }
      ;(window as any).__ouMidCleanup = () => window.removeEventListener('keydown', onKey)
      window.addEventListener('keydown', onKey)
    })
    await page.keyboard.press('Alt+ArrowUp')
    const midReached = await page.evaluate(() => {
      ;(window as any).__ouMidCleanup?.()
      delete (window as any).__ouMidCleanup
      return (window as any).__ouMidReachedWindow as boolean
    })
    expect(midReached, 'Option+Up away from MindBox start edge does not propagate').toBe(false)
    expect(await query(), 'Option+Up away from start edge does not step back').toBe(`${CHILD_A} `)
    await expect(mindbox(page), 'MindBox stays focused').toBeFocused()

    // Shift+Alt+ArrowUp at start edge (0) does NOT propagate
    await focusMindboxInPlace(page, 0)
    await page.evaluate(() => {
      ;(window as any).__ouShiftAltReachedWindow = false
      const onKey = (e: KeyboardEvent) => {
        if (e.code == 'ArrowUp' && e.altKey && e.shiftKey) (window as any).__ouShiftAltReachedWindow = true
      }
      ;(window as any).__ouShiftAltCleanup = () => window.removeEventListener('keydown', onKey)
      window.addEventListener('keydown', onKey)
    })
    await page.keyboard.press('Shift+Alt+ArrowUp')
    const shiftAltReached = await page.evaluate(() => {
      ;(window as any).__ouShiftAltCleanup?.()
      delete (window as any).__ouShiftAltCleanup
      return (window as any).__ouShiftAltReachedWindow as boolean
    })
    expect(shiftAltReached, 'Shift+Alt+ArrowUp at MindBox start edge does not propagate').toBe(false)
    expect(await query()).toBe(`${CHILD_A} `)
    await expect(mindbox(page)).toBeFocused()

    // Alt+ArrowUp alone at start edge (0) DOES propagate, steps back, and blurs MindBox
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(query, { message: 'Option+Up from MindBox at start edge steps back to deep' }).toBe(`${DEEP} `)
    await expect.poll(targetId).toBe(deepId)
    await expect(mindbox(page), 'Option+Up from MindBox blurs MindBox after stepping back').not.toBeFocused()

    // pending debounce in MindBox while walk is active: settled before the step back, final entry, blurred
    await focusMindboxInPlace(page, 0)
    await expect(mindbox(page)).toBeFocused()
    const debouncedTurn = await asUser(page, () => {
      const w = window as any
      const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      box.setSelectionRange(0, 0)
      box.dispatchEvent(new Event('input'))
      const pending = w._editor_change_pending as boolean
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
      return { pending, still: w._editor_change_pending as boolean, focused: document.activeElement == box, entry: [history.state.editorText, history.state.final] }
    })
    expect(debouncedTurn, 'Option+Up settles a pending debounce and steps back to start in a final entry, blurred').toEqual({
      pending: true,
      still: false,
      focused: false,
      entry: [`${START} `, true],
    })
    await expect.poll(targetId).toBe(startId)

    // inside an item's open editor, Option+Up is NOT taken and keeps its text-movement meaning
    const secondLine = page.locator(`#item-${startId} p`).nth(1)
    await expect(secondLine).toBeVisible()
    await secondLine.click()
    const itemTextarea = page.locator(`#textarea-${startId}`)
    await expect(itemTextarea).toBeFocused()
    const endOffset = await page.evaluate(id => {
      const t = document.getElementById('textarea-' + id) as HTMLTextAreaElement
      t.setSelectionRange(t.value.length, t.value.length)
      ;(window as any).__ouEditorProbe = { windowSaw: false, prevented: null as boolean | null }
      const onTaKey = (e: KeyboardEvent) => {
        if (e.code == 'ArrowUp' && e.altKey) (window as any).__ouEditorProbe.prevented = e.defaultPrevented
      }
      const onWinKey = (e: KeyboardEvent) => {
        if (e.code == 'ArrowUp' && e.altKey) (window as any).__ouEditorProbe.windowSaw = true
      }
      t.addEventListener('keydown', onTaKey)
      window.addEventListener('keydown', onWinKey)
      ;(window as any).__ouEditorCleanup = () => {
        t.removeEventListener('keydown', onTaKey)
        window.removeEventListener('keydown', onWinKey)
      }
      return t.value.length
    }, startId)
    await page.keyboard.press('Alt+ArrowUp')
    const editorProbe = await page.evaluate(id => {
      const t = document.getElementById('textarea-' + id) as HTMLTextAreaElement
      const res = { ...(window as any).__ouEditorProbe, caret: t.selectionStart }
      // also test caret at 0 (the edge where MindBox propagates Option+Up): an item editor must still stop it
      t.setSelectionRange(0, 0)
      ;(window as any).__ouEditorProbe = { windowSaw: false, prevented: null as boolean | null }
      return res
    }, startId)
    expect(editorProbe.windowSaw, 'item editor stops Option+Up propagation').toBe(false)
    expect(editorProbe.prevented, 'item editor leaves Option+Up default action intact').toBe(false)
    expect(editorProbe.caret, 'Option+Up moved the caret up inside the item editor').toBeLessThan(endOffset)
    await page.keyboard.press('Alt+ArrowUp')
    const editorZeroProbe = await page.evaluate(id => {
      ;(window as any).__ouEditorCleanup?.()
      delete (window as any).__ouEditorCleanup
      const t = document.getElementById('textarea-' + id) as HTMLTextAreaElement
      return { ...(window as any).__ouEditorProbe, caret: t.selectionStart }
    }, startId)
    expect(editorZeroProbe.windowSaw, 'item editor at caret 0 stops Option+Up propagation').toBe(false)
    expect(editorZeroProbe.prevented, 'item editor at caret 0 leaves Option+Up default action intact').toBe(false)
    expect(editorZeroProbe.caret, 'Option+Up at caret 0 keeps caret at 0').toBe(0)
    expect(await query(), 'Option+Up inside item editor does not navigate').toBe(`${START} `)
    await expect(itemTextarea, 'item editor keeps focus').toBeFocused()
    await page.keyboard.press('Escape')
    await expect(itemTextarea).toBeHidden()

    // MindBox at start edge (selectionEnd == 0) with NO walk on: reaches window, default prevented, changes nothing, keeps focus and caret at 0
    await userSet(page, CHILD_A, { scroll: true })
    await expect.poll(targetId).toBe(childAId)
    await focusMindboxInPlace(page, 0)
    await expectAltNoOp('ArrowUp', 'Option+Up in MindBox at start edge with no walk')
    expect(
      await page.evaluate(() => {
        const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
        return [box.selectionStart, box.selectionEnd]
      }),
      'Option+Up in MindBox with no walk keeps caret at 0'
    ).toEqual([0, 0])
  } finally {
    const deletedSavedIds = await page.evaluate(
      ([ls, unnamed]) => {
        const list = (window as any).__items as any[]
        const matches = list.filter(i => ls.includes(i.label) || i.text == unnamed)
        const sids = matches.map(i => i.savedId).filter((s): s is string => !!s)
        for (const item of matches) window._item(item.id, true)?.delete(false)
        return sids
      },
      [labels, UNNAMED_TEXT] as const
    )
    await userSet(page, '')
    await expect
      .poll(
        async () => {
          const localGone = await page.evaluate(
            ([ls, unnamed]) => {
              const list = (window as any).__items as any[]
              return !list.some(i => ls.includes(i.label) || i.text == unnamed)
            },
            [labels, UNNAMED_TEXT] as const
          )
          if (!localGone) return false
          const snaps = await Promise.all(deletedSavedIds.map(id => firestore().collection('items').doc(id).get()))
          return snaps.every(s => !s.exists)
        },
        { message: 'fixture items removed locally and on server', timeout: 15_000 }
      )
      .toBe(true)
  }
})

test('a stale Back scroll restore is cancelled by a later select or a second Back, and narration Back onto a query matching entry 0 scrolls to the header', async ({ page, browser }) => {
  await loadAdmin(page)
  const A = '#e2e_stale_pop_a'
  const A_CHILD = `${A}/child`
  const B = '#e2e_stale_pop_b'
  const body = Array.from({ length: 40 }, (_, i) => `filler line ${i + 1}`).join('\n\n')
  const labels = [A, A_CHILD, B]
  const settledRecorded = (p = page) =>
    expect
      .poll(
        () =>
          p.evaluate(
            () =>
              !(window as any)._history_update_pending &&
              !(window as any)._popstate_scroll_pending &&
              (window as any)._history[(window as any)._history_index].scrollPosition === document.body.scrollTop
          ),
        { message: 'entry settled and scroll recorded' }
      )
      .toBe(true)
  try {
    for (const label of [A, B]) await page.evaluate(([l, b]) => void window._create(`${l} ${b}`), [label, body] as const)
    await expect.poll(() => savedId(page, A), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => savedId(page, B), { timeout: 30_000 }).toBeTruthy()
    const [idA, idB] = await page.evaluate(([a, b]) => [window._item(a, true)!.id, window._item(b, true)!.id] as const, [A, B] as const)
    const top = await headerTop(page)

    // 1. Stale Back restore cancelled by pushState (selectItem): Back onto entry 0 (at pos0) is held before its
    //    2-rAF update_dom() resolves; selecting B at pos1 (where B stands in view, so selectItem's own
    //    scrollToTarget is a no-op) supersedes it so releasing the held frames must not yank B back to pos0.
    await asUser(page, id => void (window._item(id) as any).select(), idB)
    await expect(mindbox(page)).toHaveValue(B)
    await settled(page)
    await settledRecorded()
    const pos1 = await scrollTop(page)
    await userSet(page, '')
    await expect(mindbox(page)).toHaveValue('')
    // keep pos0 within ~60 px of pos1 so B stays in scroll band at BOTH positions (as in wr12: 1297 vs 1345);
    // otherwise selectItem(B)'s own scrollToTarget would scroll back from a stale pos0 jump and mask the bug
    const pos0 = pos1 - 60 > top ? pos1 - 60 : pos1 + 60
    await page.evaluate(y => document.body.scrollTo(0, y), pos0)
    await settledRecorded()
    await asUser(page, id => void (window._item(id) as any).select(), idA)
    await expect(mindbox(page)).toHaveValue(A)
    await settledRecorded()

    await page.evaluate(() => {
      window.addEventListener(
        'popstate',
        () => {
          const orig = window.requestAnimationFrame.bind(window)
          const held: FrameRequestCallback[] = []
          ;(window as any).__releaseHeldRaf = () => {
            window.requestAnimationFrame = orig
            for (const cb of held.splice(0)) orig(cb)
          }
          window.requestAnimationFrame = (cb => {
            held.push(cb)
            return held.length
          }) as typeof requestAnimationFrame
        },
        { capture: true, once: true }
      )
    })
    await page.goBack()
    await expect(mindbox(page)).toHaveValue('')
    expect(await page.evaluate(() => !!(window as any)._popstate_scroll_pending), 'Back armed _popstate_scroll_pending while its frames are held').toBe(true)

    await asUser(
      page,
      ([id, y]) => {
        document.body.scrollTo(0, y)
        ;(window._item(id) as any).select()
      },
      [idB, pos1] as const
    )
    await expect(mindbox(page)).toHaveValue(B)
    expect(await page.evaluate(() => !!(window as any)._popstate_scroll_pending), 'pushState cleared _popstate_scroll_pending immediately').toBe(false)
    await page.evaluate(() => {
      ;(window as any).__releaseHeldRaf?.()
      return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    })
    expect(Math.abs((await scrollTop(page)) - pos1) <= 2, `stale Back restore must not yank B from ${pos1} back to ${pos0} (got ${await scrollTop(page)})`).toBe(true)

    // 2. Rapid double-Back: Back #1's stale 2nd rAF firing after Back #2 starts must neither jump to Back #1's
    //    position nor clear _popstate_scroll_pending before Back #2's restore finishes.
    await userSet(page, '')
    await expect(mindbox(page)).toHaveValue('')
    const posA = top + 300
    const posB = top + 60
    const posC = top + 180
    await page.evaluate(y => document.body.scrollTo(0, y), posA)
    await settledRecorded()
    await asUser(page, id => void (window._item(id) as any).select(), idA)
    await expect(mindbox(page)).toHaveValue(A)
    await settled(page)
    await page.evaluate(y => document.body.scrollTo(0, y), posB)
    await settledRecorded()
    await asUser(page, id => void (window._item(id) as any).select(), idB)
    await expect(mindbox(page)).toHaveValue(B)
    await settled(page)
    await page.evaluate(y => document.body.scrollTo(0, y), posC)
    await settledRecorded()

    await page.evaluate(() => {
      const w = window as any
      const orig = window.requestAnimationFrame.bind(window)
      w.__origRaf = orig
      w.__q1 = [] as FrameRequestCallback[]
      w.__q2 = [] as FrameRequestCallback[]
      w.__activeQ = w.__q1
      window.requestAnimationFrame = (cb => {
        if (w.__activeQ) {
          w.__activeQ.push(cb)
          return w.__activeQ.length
        }
        return orig(cb)
      }) as typeof requestAnimationFrame
    })
    await page.goBack() // Back #1: B -> A (posB)
    await expect(mindbox(page)).toHaveValue(A)
    // wait one macrotask so tick().then(() => rAF(...)) has queued Back #1's 1st rAF in __q1, fire it so
    // Back #1's 2nd (final) rAF lands in __q1, then switch capture to __q2 before Back #2
    const stepped = await page.evaluate(
      () =>
        new Promise<{ first: number; queuedSecond: number }>(resolve =>
          setTimeout(() => {
            const w = window as any
            const first = w.__q1.splice(0)
            for (const cb of first) cb(performance.now())
            const queuedSecond = w.__q1.length as number
            w.__activeQ = w.__q2
            resolve({ first: first.length, queuedSecond })
          }, 0)
        )
    )
    expect(stepped.queuedSecond, `premise: Back #1 queued its 2nd rAF (stepped=${JSON.stringify(stepped)})`).toBeGreaterThan(0)
    await page.goBack() // Back #2: A -> '' (posA)
    await expect(mindbox(page)).toHaveValue('')
    // fire Back #1's stale final callback BEFORE Back #2's frames run
    const midDoubleBack = await page.evaluate(async () => {
      const w = window as any
      await Promise.resolve()
      await Promise.resolve()
      const stale = w.__q1.splice(0)
      for (const cb of stale) cb(performance.now())
      await Promise.resolve()
      await Promise.resolve()
      return {
        staleFired: stale.length,
        pendingAfterStale: !!w._popstate_scroll_pending,
        scrollAfterStale: document.body.scrollTop,
      }
    })
    expect(midDoubleBack.staleFired, 'premise: Back #1 had a queued final rAF callback').toBeGreaterThan(0)
    expect(midDoubleBack.pendingAfterStale, 'stale Back #1 callback must not clear _popstate_scroll_pending while Back #2 is pending').toBe(true)
    expect(Math.abs(midDoubleBack.scrollAfterStale - posB) > 20, `stale Back #1 callback must not scroll to posB (${posB})`).toBe(true)
    // now flush Back #2's frames and restore real rAF
    await page.evaluate(() => {
      const w = window as any
      const orig = w.__origRaf as typeof requestAnimationFrame
      window.requestAnimationFrame = orig
      w.__activeQ = null
      for (const cb of w.__q2.splice(0)) orig(cb)
    })
    await expect
      .poll(
        () =>
          page.evaluate(
            target => !(window as any)._popstate_scroll_pending && Math.abs(document.body.scrollTop - target) <= 2,
            posA
          ),
        { message: 'Back #2 finishes restoring posA' }
      )
      .toBe(true)

    // 3. Narration mode: Back onto a nonzero entry whose query matches entry 0 queues history.go(-index)
    //    with scrollToTopOnPopState = true. Capturing and clearing that flag at the START of onPopState
    //    (before onEditorChange) keeps the intermediate entry from consuming it, so entry 0 lands at the
    //    header instead of its older saved scroll position. An explicit Option+Up back to entry 0's
    //    label still pushes its own history entry rather than hopping to entry 0, so Back returns to
    //    the child.
    await page.evaluate(l => void window._create(`${l} child`), A_CHILD)
    await expect.poll(() => savedId(page, A_CHILD), { timeout: 30_000 }).toBeTruthy()
    const nCtx = await browser.newContext()
    try {
      await nCtx.addInitScript(() => {
        if (window !== window.top || !location.protocol.startsWith('http')) return
        localStorage.setItem('mindpage_narrating', '{}')
        Object.defineProperty(navigator, 'mediaDevices', {
          value: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => new Promise(() => {}) },
          configurable: true,
        })
      })
      const nPage = await nCtx.newPage()
      await loadAdmin(nPage)
      const nErrors: string[] = []
      nPage.on('pageerror', err => nErrors.push(String(err)))
      const nTop = await headerTop(nPage)
      // passive MindBox.set replaces entry 0 with non-empty query A, then scroll entry 0 well below the header
      await nPage.evaluate(q => void (window as any).MindBox.set(q), A)
      await expect(mindbox(nPage)).toHaveValue(A)
      await settled(nPage)
      const savedPos = nTop + 250
      await nPage.evaluate(y => document.body.scrollTo(0, y), savedPos)
      await settledRecorded(nPage)
      // Up shortcut saves savedPos on entry 0 and pushes entry 1 with the same query A at the header
      await nPage.keyboard.press('Control+Alt+ArrowUp')
      await expect.poll(() => nPage.evaluate(() => (window as any)._history_index), { message: 'Up pushed entry 1' }).toBe(1)
      await settledRecorded(nPage)
      const beforeBack = await nPage.evaluate(() => ({
        h0: (window as any)._history[0],
        h1: (window as any)._history[1],
      }))
      expect(beforeBack.h0.editorText, 'premise: entry 0 holds query A').toBe(A)
      expect(beforeBack.h1.editorText, 'premise: entry 1 holds the same query A').toBe(A)
      expect(Math.abs(beforeBack.h0.scrollPosition - savedPos) <= 2, 'premise: entry 0 saved below header').toBe(true)
      // push entry 2 with a different query B, scrolled to a third position distinct from both nTop and savedPos
      await asUser(nPage, name => void (window._item(name, true) as any).select(), B)
      await expect(mindbox(nPage)).toHaveValue(B)
      await expect.poll(() => nPage.evaluate(() => (window as any)._history_index)).toBe(2)
      await settled(nPage)
      await nPage.evaluate(y => document.body.scrollTo(0, y), nTop + 120)
      await settledRecorded(nPage)
      // Back lands on entry 1 (same query as entry 0) -> onEditorChange arms scrollToTopOnPopState + history.go(-1)
      await nPage.goBack()
      await expect
        .poll(
          () => nPage.evaluate(() => (window as any)._history_index === 0 && !(window as any)._popstate_scroll_pending),
          { message: 'narration Back hops from entry 1 back to entry 0 and settles' }
        )
        .toBe(true)
      const landed = await scrollTop(nPage)
      expect(
        Math.abs(landed - nTop) <= 2,
        `narration Back onto a query matching entry 0 scrolls to header ${nTop}, not entry 0 saved position ${savedPos} (got ${landed})`
      ).toBe(true)

      // Option+Down/Option+Up walk from entry 0 (query A): Option+Up returning to A must push
      // entry 2 rather than firing narration's history.go(-1) hop back to entry 0, so Back returns
      // to the child instead of losing the step
      await blur(nPage)
      await nPage.keyboard.press('Alt+ArrowDown')
      await expect(mindbox(nPage)).toHaveValue(`${A_CHILD} `)
      await expect
        .poll(() => nPage.evaluate(() => (window as any)._history_index), { message: 'narration Option+Down pushes entry 1' })
        .toBe(1)
      await nPage.keyboard.press('Alt+ArrowUp')
      await expect
        .poll(() => nPage.evaluate(() => (window as any)._history_index), { message: 'narration Option+Up pushes entry 2' })
        .toBe(2)
      await expect(mindbox(nPage)).toHaveValue(`${A} `)
      await settled(nPage)
      expect(await nPage.evaluate(() => (window as any)._history_index), 'entry 2 stays settled after Option+Up').toBe(2)
      await nPage.goBack()
      await expect(mindbox(nPage)).toHaveValue(`${A_CHILD} `)
      await expect
        .poll(() => nPage.evaluate(() => (window as any)._history_index), { message: 'Back after narration Option+Up returns to child at entry 1' })
        .toBe(1)

      expect(nErrors, 'no pageerror in narration mode').toEqual([])
    } finally {
      await nCtx.close()
    }
  } finally {
    const deletedSavedIds = await page.evaluate(ls => {
      const matches = ((window as any).__items as any[]).filter(i => ls.includes(i.label))
      const sids = matches.map(i => i.savedId).filter((s): s is string => !!s)
      for (const item of matches) window._item(item.id, true)?.delete(false)
      return sids
    }, labels)
    await userSet(page, '')
    await expect
      .poll(
        async () => {
          const localGone = await page.evaluate(ls => !((window as any).__items as any[]).some(i => ls.includes(i.label)), labels)
          if (!localGone) return false
          const snaps = await Promise.all(deletedSavedIds.map(id => firestore().collection('items').doc(id).get()))
          return snaps.every(s => !s.exists)
        },
        { message: 'stale-pop fixtures removed locally and on server', timeout: 15_000 }
      )
      .toBe(true)
  }
})

test('window._mindboxApplied records the applied query in its typed case across debounced typing, undo, MindBox.set, and incomplete regex', async ({ page }) => {
  await loadAdmin(page)
  const pageErrors: string[] = []
  page.on('pageerror', err => pageErrors.push(err.message))
  const applied = 'id:AbC_123 MixedCase'
  await focusMindbox(page)
  await mindbox(page).pressSequentially(applied)
  await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 }).toBe(true)
  expect(await page.evaluate(() => (window as any)._mindboxApplied)).toBe(applied)
  // typing one more character debounces the draft while _mindboxApplied stays at the applied query
  await mindbox(page).press('KeyX')
  const duringDraft = await page.evaluate(() => ({
    debounced: (window as any)._mindboxDebounced,
    applied: (window as any)._mindboxApplied,
    box: (window as any).MindBox.get(),
  }))
  expect(duringDraft).toEqual({ debounced: true, applied, box: `${applied}x` })
  // taking the character back and letting the debounce end leaves _mindboxApplied unchanged
  await mindbox(page).press('Backspace')
  await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 }).toBe(true)
  expect(await page.evaluate(() => ({ applied: (window as any)._mindboxApplied, box: (window as any).MindBox.get() }))).toEqual({
    applied,
    box: applied,
  })
  // item code setting the box via MindBox.set updates _mindboxApplied by the time the debounce flag clears
  const fromCode = 'id:XyZ_789 NextQuery'
  await page.evaluate(q => void (window as any).MindBox.set(q), fromCode)
  await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 }).toBe(true)
  expect(await page.evaluate(() => (window as any)._mindboxApplied)).toBe(fromCode)

  // incomplete regex term: typing `#new regex:[x`, pausing for debounce, then typing `]` must not throw
  // and must keep _mindboxApplied and the page's actual target container in agreement
  const oldLabel = '#e2e_applied_old'
  const newLabel = '#e2e_applied_new'
  const labels = [oldLabel, newLabel]
  try {
    await page.evaluate(
      ([oldL, newL]) => {
        window._create(`${oldL} prior target`)
        window._create(`${newL} target with x`)
      },
      [oldLabel, newLabel] as const
    )
    for (const label of labels) {
      await expect.poll(() => savedId(page, label), { message: `${label} saved`, timeout: 15_000 }).toBeTruthy()
    }
    const [oldId, newId] = await page.evaluate(ls => ls.map(l => window._item(l, true)!.id), labels)
    const readAgreement = async (itemId: string) => ({
      ...(await page.evaluate(id => {
        const item = ((window as any).__items as any[]).find(i => i.id === id)
        return {
          applied: (window as any)._mindboxApplied,
          targetId: document.querySelector('.container.target')?.getAttribute('data-item-id') ?? null,
          regexMatched: (item?.matchingTerms ?? []).some((t: unknown) => t instanceof RegExp && t.source === '[x]'),
        }
      }, itemId)),
      errors: [...pageErrors],
    })

    // start with the page showing #e2e_applied_old
    await blur(page)
    await page.evaluate(q => void (window as any).MindBox.set(q), oldLabel)
    await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 }).toBe(true)
    await expect
      .poll(() => readAgreement(oldId), { message: 'premise: page starts on old target', timeout: 5_000 })
      .toEqual({ applied: oldLabel, targetId: oldId, regexMatched: false, errors: [] })

    // replace box with incomplete regex query and let debounce settle
    const incomplete = `${newLabel} regex:[x`
    await focusMindboxInPlace(page)
    await expect(mindbox(page)).toBeFocused()
    await mindbox(page).fill(incomplete)
    expect(
      await page.evaluate(() => ({
        debounced: (window as any)._mindboxDebounced,
        applied: (window as any)._mindboxApplied,
      }))
    ).toEqual({ debounced: true, applied: oldLabel })
    await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 }).toBe(true)
    await expect
      .poll(() => readAgreement(newId), {
        message: 'incomplete regex: no pageerror and _mindboxApplied agrees with .container.target',
        timeout: 5_000,
      })
      .toEqual({ applied: incomplete, targetId: newId, regexMatched: false, errors: [] })

    // type closing bracket: debounced draft keeps incomplete query, then settles with regex matching and agreement
    const complete = `${incomplete}]`
    await mindbox(page).pressSequentially(']')
    expect(
      await page.evaluate(() => ({
        debounced: (window as any)._mindboxDebounced,
        applied: (window as any)._mindboxApplied,
        box: (window as any).MindBox.get(),
      }))
    ).toEqual({ debounced: true, applied: incomplete, box: complete })
    await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 }).toBe(true)
    await expect
      .poll(() => readAgreement(newId), {
        message: 'closed regex: no pageerror, regex compiles and matches, and _mindboxApplied agrees with .container.target',
        timeout: 5_000,
      })
      .toEqual({ applied: complete, targetId: newId, regexMatched: true, errors: [] })

    // recovery: another query applies as usual
    await mindbox(page).fill(oldLabel)
    await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 }).toBe(true)
    await expect
      .poll(() => readAgreement(oldId), {
        message: 'recovery: subsequent query applies as usual',
        timeout: 5_000,
      })
      .toEqual({ applied: oldLabel, targetId: oldId, regexMatched: false, errors: [] })
  } finally {
    await blur(page)
    await page.evaluate(() => void (window as any).MindBox.set(''))
    await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 }).toBe(true)
    await page.evaluate(ls => {
      for (const l of ls) window._item(l, true)?.delete(false)
    }, labels)
    await expect
      .poll(() => page.evaluate(ls => ls.every(l => !window._item(l, true)), labels), {
        message: 'applied-query fixtures removed',
        timeout: 15_000,
      })
      .toBe(true)
  }
  expect(pageErrors).toEqual([])
})

test('deleting a targeted child scrolls its parent into view as ArrowUp does, from the window, from its editor, and across a subtree', async ({
  page,
}) => {
  await loadAdmin(page)
  const pageErrors: string[] = []
  page.on('pageerror', err => pageErrors.push(err.message))
  const PREFIX = '#e2e_del_scroll'
  const PARENT = `${PREFIX}_p`
  const CHILD = `${PARENT}/0`
  const GRANDCHILD = `${CHILD}/0`
  const SHORT_PARENT = `${PREFIX}_sp`
  const SHORT_CHILD = `${SHORT_PARENT}/0`
  const OTHER = `${PREFIX}_other`
  const UNSELECTED = `${OTHER}/unsel`
  const fillers = Array.from({ length: 12 }, (_, i) => {
    const label = `${PREFIX}_f${String(i + 1).padStart(2, '0')}`
    const body = Array.from({ length: 5 }, (_, j) => `- filler ${i + 1} line ${j + 1}`).join('\n')
    return [label, `${label} #_pin\n${body}`] as const
  })
  const parentText = `${PARENT}\n` + Array.from({ length: 15 }, (_, i) => `- parent line ${i + 1}`).join('\n')
  const fixtures: ReadonlyArray<readonly [string, string]> = [
    ...fillers,
    [PARENT, parentText],
    [SHORT_PARENT, `${SHORT_PARENT} short parent`],
    [OTHER, `${OTHER} unrelated target`],
    [UNSELECTED, `${UNSELECTED} item not selected`],
  ]
  const createdIds = new Set<string>()

  const targetLabel = () =>
    page.evaluate(
      () => (document.querySelector('.container.target mark.label') as HTMLElement | null)?.title?.toLowerCase() ?? null
    )
  const itemRectTop = (label: string) =>
    page.evaluate(l => {
      const id = window._item(l, true)?.id
      const sc = id && document.getElementById('super-container-' + id)
      return sc ? Math.round(sc.getBoundingClientRect().top) : null
    }, label)
  const viewportHeight = () => page.evaluate(() => visualViewport!.height)

  const waitSaved = async (label: string) => {
    await expect.poll(() => savedId(page, label), { message: `${label} savedId`, timeout: 30_000 }).toBeTruthy()
    const id = (await savedId(page, label))!
    createdIds.add(id)
    await expect
      .poll(
        () =>
          page.evaluate(l => {
            const item = window.__items.find(i => i.id == window._item(l, true)?.id)
            return !!item && !item.saving && !!item.savedText
          }, label),
        { message: `${label} save settled`, timeout: 30_000 }
      )
      .toBe(true)
    return id
  }

  const waitGone = async (label: string, id: string) => {
    await expect
      .poll(() => page.evaluate(l => window._item(l, true)?.id ?? null, label), {
        message: `${label} removed locally`,
        timeout: 10_000,
      })
      .toBeNull()
    await expect
      .poll(async () => (await firestore().collection('items').doc(id).get()).exists, {
        message: `${label} removed on server`,
        timeout: 30_000,
      })
      .toBe(false)
  }

  const makeChild = async (parent: string, child: string, word?: string) => {
    await userSet(page, parent, { scroll: true })
    await expect.poll(targetLabel, { message: `target ${parent}`, timeout: 10_000 }).toBe(parent)
    await blur(page)
    await settled(page)
    await page.keyboard.press('Control+Enter')
    await expect
      .poll(
        () =>
          page.evaluate(c => {
            const ae = document.activeElement as HTMLTextAreaElement | null
            return !!window._item(c, true) && ae?.tagName == 'TEXTAREA' && ae.value.startsWith(c)
          }, child),
        { message: `${child} editor open and focused`, timeout: 10_000 }
      )
      .toBe(true)
    const id = await waitSaved(child)
    if (word !== undefined) {
      await page.keyboard.type(word)
      await page.keyboard.press('Shift+Enter')
      await expect
        .poll(
          () =>
            page.evaluate(
              ([c, w]) => {
                const handle = window._item(c, true) as { id: string; editing?: boolean } | null
                const item = handle && window.__items.find(i => i.id == handle.id)
                return !!item && !handle.editing && !item.saving && !!item.savedText?.includes(w)
              },
              [child, word] as const
            ),
          { message: `${child} saved with word`, timeout: 30_000 }
        )
        .toBe(true)
      await expect.poll(targetLabel, { message: `${child} targeted`, timeout: 10_000 }).toBe(child)
      await blur(page)
    }
    await settled(page)
    return id
  }

  try {
    await page.evaluate(items => {
      for (const [, text] of items) void window._create(text)
    }, fixtures)
    for (const [label] of fixtures) await waitSaved(label)
    await settled(page)
    const vh = await viewportHeight()

    // 1. saved targeted child deleted by window's key: parent becomes target and stands where ArrowUp puts it
    const id1 = await makeChild(PARENT, CHILD, 'step1')
    expect((await itemRectTop(PARENT))!, 'premise step 1: parent above viewport while child targeted').toBeLessThan(0)
    const histBefore1 = await entries(page)
    await page.keyboard.press('Control+Backspace')
    await expect
      .poll(() => page.evaluate(c => window._item(c, true)?.id ?? null, CHILD), {
        message: 'step 1: child removed locally',
        timeout: 10_000,
      })
      .toBeNull()
    await expect.poll(targetLabel, { message: 'step 1: parent targeted after delete', timeout: 10_000 }).toBe(PARENT)
    await settled(page)
    const afterDeleteTop1 = (await itemRectTop(PARENT))!
    const afterDeleteScroll1 = await scrollTop(page)
    expect(await entries(page), 'step 1: delete replaces current history entry without pushing').toEqual(histBefore1)
    await waitGone(CHILD, id1)

    // measure ArrowUp's place from the same state (never hard-code a number)
    const idUp = await makeChild(PARENT, CHILD, 'step1')
    expect((await itemRectTop(PARENT))!, 'premise up: parent above viewport before ArrowUp').toBeLessThan(0)
    await page.keyboard.press('ArrowUp')
    await expect.poll(targetLabel, { message: 'ArrowUp targeted parent', timeout: 10_000 }).toBe(PARENT)
    await settled(page)
    const upTop = (await itemRectTop(PARENT))!
    const upScroll = await scrollTop(page)
    expect(upTop, 'premise up: ArrowUp placed parent inside scroll band').toBeGreaterThanOrEqual(0)
    expect(upTop, 'premise up: ArrowUp placed parent inside scroll band').toBeLessThanOrEqual(vh - 200)
    await page.evaluate(c => void window._item(c, true)?.delete(false), CHILD)
    await waitGone(CHILD, idUp)

    expect
      .soft(
        Math.abs(afterDeleteTop1 - upTop),
        `step 1: window delete parent top (${afterDeleteTop1}) matches ArrowUp (${upTop})`
      )
      .toBeLessThanOrEqual(2)
    expect
      .soft(
        Math.abs(afterDeleteScroll1 - upScroll),
        `step 1: window delete scrollTop (${afterDeleteScroll1}) matches ArrowUp (${upScroll})`
      )
      .toBeLessThanOrEqual(2)

    // 2. the same with the view scrolled away by the wheel before the delete
    const id2 = await makeChild(PARENT, CHILD, 'step2')
    await page.mouse.move(640, 360)
    await page.mouse.wheel(0, -1200)
    await expect
      .poll(() => itemRectTop(PARENT), { message: 'premise step 2: parent scrolled below band by wheel', timeout: 10_000 })
      .toBeGreaterThan(vh - 200)
    await settled(page)
    await page.keyboard.press('Control+Backspace')
    await expect
      .poll(() => page.evaluate(c => window._item(c, true)?.id ?? null, CHILD), {
        message: 'step 2: child removed locally',
        timeout: 10_000,
      })
      .toBeNull()
    await expect.poll(targetLabel, { message: 'step 2: parent targeted after delete', timeout: 10_000 }).toBe(PARENT)
    await settled(page)
    const afterDeleteTop2 = (await itemRectTop(PARENT))!
    await waitGone(CHILD, id2)
    expect
      .soft(
        Math.abs(afterDeleteTop2 - upTop),
        `step 2: wheeled-away delete parent top (${afterDeleteTop2}) matches ArrowUp (${upTop})`
      )
      .toBeLessThanOrEqual(2)

    // 3. delete from the child's own editor, right after its creation
    const id3 = await makeChild(PARENT, CHILD)
    expect(
      await page.evaluate(c => {
        const id = window._item(c, true)?.id
        return !!id && document.activeElement === document.getElementById('textarea-' + id)
      }, CHILD),
      'premise step 3: child editor is focused'
    ).toBe(true)
    expect((await itemRectTop(PARENT))!, 'premise step 3: parent above viewport while child editor open').toBeLessThan(0)
    await page.keyboard.press('Control+Backspace')
    await expect
      .poll(() => page.evaluate(c => window._item(c, true)?.id ?? null, CHILD), {
        message: 'step 3: child removed from its editor',
        timeout: 10_000,
      })
      .toBeNull()
    await expect.poll(targetLabel, { message: 'step 3: parent targeted after editor delete', timeout: 10_000 }).toBe(PARENT)
    await settled(page)
    const afterDeleteTop3 = (await itemRectTop(PARENT))!
    await waitGone(CHILD, id3)
    expect
      .soft(
        Math.abs(afterDeleteTop3 - upTop),
        `step 3: editor delete parent top (${afterDeleteTop3}) matches ArrowUp (${upTop})`
      )
      .toBeLessThanOrEqual(2)

    // 4. parent already in the scroll band (short child under short parent): scroll position does not change
    const id4 = await makeChild(SHORT_PARENT, SHORT_CHILD, 'short')
    const beforeTop4 = (await itemRectTop(SHORT_PARENT))!
    expect(beforeTop4, 'premise step 4: short parent inside scroll band').toBeGreaterThanOrEqual(0)
    expect(beforeTop4, 'premise step 4: short parent inside scroll band').toBeLessThanOrEqual(vh - 200)
    const beforeScroll4 = await scrollTop(page)
    await page.keyboard.press('Control+Backspace')
    await expect
      .poll(() => page.evaluate(c => window._item(c, true)?.id ?? null, SHORT_CHILD), {
        message: 'step 4: short child removed locally',
        timeout: 10_000,
      })
      .toBeNull()
    await expect.poll(targetLabel, { message: 'step 4: short parent targeted', timeout: 10_000 }).toBe(SHORT_PARENT)
    await settled(page)
    expect(Math.abs((await scrollTop(page)) - beforeScroll4), 'step 4: scrollTop unchanged when parent in band').toBeLessThanOrEqual(1)
    expect(Math.abs((await itemRectTop(SHORT_PARENT))! - beforeTop4), 'step 4: parent top unchanged').toBeLessThanOrEqual(2)
    await waitGone(SHORT_CHILD, id4)

    // 5. deleting an item the query does not select (another item targeted and scrolled out of band): scroll position does not change
    await userSet(page, OTHER, { scroll: true })
    await expect.poll(targetLabel, { message: 'step 5: unrelated item targeted', timeout: 10_000 }).toBe(OTHER)
    await blur(page)
    await settled(page)
    await page.mouse.move(640, 360)
    await page.mouse.wheel(0, -1200)
    await expect
      .poll(() => itemRectTop(OTHER), { message: 'premise step 5: targeted item scrolled below band', timeout: 10_000 })
      .toBeGreaterThan(vh - 200)
    await settled(page)
    const beforeScroll5 = await scrollTop(page)
    const unselId = (await savedId(page, UNSELECTED))!
    expect(await page.evaluate(l => window._item(l)!.delete(false), UNSELECTED), 'step 5: unselected item deleted').toBe(true)
    await expect
      .poll(() => page.evaluate(l => window._item(l, true)?.id ?? null, UNSELECTED), {
        message: 'step 5: unselected item removed locally',
        timeout: 10_000,
      })
      .toBeNull()
    await settled(page)
    expect(await targetLabel(), 'step 5: target unchanged').toBe(OTHER)
    expect(Math.abs((await scrollTop(page)) - beforeScroll5), 'step 5: scrollTop unchanged for unselected delete').toBeLessThanOrEqual(1)
    await waitGone(UNSELECTED, unselId)

    // 6. subtree delete from a child with a child of its own (Shift+Ctrl+Backspace, confirmed): parent ends where Up puts it, one scroll
    const id6Child = await makeChild(PARENT, CHILD, 'subtree-root')
    await page.keyboard.press('Control+Enter')
    await expect
      .poll(
        () =>
          page.evaluate(gc => {
            const ae = document.activeElement as HTMLTextAreaElement | null
            return !!window._item(gc, true) && ae?.tagName == 'TEXTAREA' && ae.value.startsWith(gc)
          }, GRANDCHILD),
        { message: 'step 6: grandchild editor open and focused', timeout: 10_000 }
      )
      .toBe(true)
    const id6Grand = await waitSaved(GRANDCHILD)
    await page.keyboard.type('gc')
    await page.keyboard.press('Shift+Enter')
    await expect
      .poll(
        () =>
          page.evaluate(gc => {
            const handle = window._item(gc, true) as { id: string; editing?: boolean } | null
            const item = handle && window.__items.find(i => i.id == handle.id)
            return !!item && !handle.editing && !item.saving && !!item.savedText?.includes('gc')
          }, GRANDCHILD),
        { message: 'step 6: grandchild saved', timeout: 30_000 }
      )
      .toBe(true)
    await userSet(page, CHILD, { scroll: true })
    await expect.poll(targetLabel, { message: 'step 6: child targeted before subtree delete', timeout: 10_000 }).toBe(CHILD)
    await blur(page)
    await settled(page)
    expect((await itemRectTop(PARENT))!, 'premise step 6: parent above viewport before subtree delete').toBeLessThan(0)
    await page.evaluate(() => {
      const w = window as any
      w.__delScrollCalls = 0
      w.__origBodyScrollTo = document.body.scrollTo
      document.body.scrollTo = function (...args: any[]) {
        w.__delScrollCalls++
        return w.__origBodyScrollTo.apply(this, args)
      }
    })
    const seenDialogs: string[] = []
    page.once('dialog', d => {
      seenDialogs.push(d.message())
      void d.accept()
    })
    await page.keyboard.press('Control+Shift+Backspace')
    await expect
      .poll(
        () => page.evaluate(([c, gc]) => !window._exists(c) && !window._exists(gc), [CHILD, GRANDCHILD] as const),
        { message: 'step 6: child and grandchild removed locally', timeout: 10_000 }
      )
      .toBe(true)
    await expect.poll(targetLabel, { message: 'step 6: parent targeted after subtree delete', timeout: 10_000 }).toBe(PARENT)
    await settled(page)
    const afterDeleteTop6 = (await itemRectTop(PARENT))!
    const scrollCalls6 = await page.evaluate(() => (window as any).__delScrollCalls as number)
    expect(seenDialogs, 'step 6: one subtree confirmation dialog').toEqual([
      `Delete ${CHILD} and 1 item under it?\n\n${GRANDCHILD}`,
    ])
    await waitGone(CHILD, id6Child)
    await waitGone(GRANDCHILD, id6Grand)
    expect
      .soft(
        Math.abs(afterDeleteTop6 - upTop),
        `step 6: subtree delete parent top (${afterDeleteTop6}) matches ArrowUp (${upTop})`
      )
      .toBeLessThanOrEqual(2)
    expect.soft(scrollCalls6, 'step 6: subtree delete performs exactly one scroll').toBe(1)
  } finally {
    await page
      .evaluate(() => {
        const w = window as any
        if (w.__origBodyScrollTo) {
          document.body.scrollTo = w.__origBodyScrollTo
          delete w.__origBodyScrollTo
        }
        delete w.__delScrollCalls
      })
      .catch(() => {})
    await blur(page).catch(() => {})
    await page.evaluate(() => void (window as any).MindBox.set('')).catch(() => {})
    await expect
      .poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 })
      .toBe(true)
      .catch(() => {})
    await page
      .evaluate(prefix => {
        const remaining = window.__items.filter(i => i.labelText?.toLowerCase().startsWith(prefix)).map(i => i.id)
        for (const id of remaining) window._item(id, true)?.delete(false)
      }, PREFIX)
      .catch(() => {})
    for (const id of createdIds) {
      const ref = firestore().collection('items').doc(id)
      if ((await ref.get()).exists) await ref.delete().catch(() => {})
    }
  }
  expect(pageErrors, 'no page errors').toEqual([])
})

test('a child delete yields to a pending Back restore and mid-wait wheel input, and a subtree delete with a tag-child selected scrolls its surviving ancestor into view', async ({
  page,
}) => {
  await loadAdmin(page)
  const pageErrors: string[] = []
  page.on('pageerror', err => pageErrors.push(err.message))
  const PREFIX = '#e2e_del_edge'
  const PARENT = `${PREFIX}_p`
  const CHILD = `${PARENT}/0`
  const T = '#e2e_tree'
  const fillers = Array.from({ length: 12 }, (_, i) => {
    const label = `${PREFIX}_f${String(i + 1).padStart(2, '0')}`
    const body = Array.from({ length: 5 }, (_, j) => `- filler ${i + 1} line ${j + 1}`).join('\n')
    return [label, `${label} #_pin\n${body}`] as const
  })
  const tallBody = (label: string) =>
    `${label}\n` + Array.from({ length: 15 }, (_, i) => `- ${label.slice(1)} line ${i + 1}`).join('\n')
  const baseFixtures: ReadonlyArray<readonly [string, string]> = [
    ...fillers,
    [PARENT, tallBody(PARENT)],
    [CHILD, `${CHILD} step1 child`],
    ['#chat', '#chat #_autodep'],
    ['#chat/vault', '#chat/vault'],
    [T, tallBody(T)],
    [`${T}/a`, `${T}/a #_chat/vault #_autodep\nbranch a`],
    [`${T}/a/x`, `${T}/a/x\nnested under a`],
    [`${T}/in`, `${T}/in #_${T.slice(1)}/a\nmoved in`],
    [`${T}/in/leaf`, `${T}/in/leaf\nunder moved in`],
  ]
  const createdIds = new Set<string>()

  const targetLabel = () =>
    page.evaluate(
      () => (document.querySelector('.container.target mark.label') as HTMLElement | null)?.title?.toLowerCase() ?? null
    )
  const itemRectTop = (label: string) =>
    page.evaluate(l => {
      const id = window._item(l, true)?.id
      const sc = id && document.getElementById('super-container-' + id)
      return sc ? Math.round(sc.getBoundingClientRect().top) : null
    }, label)
  const viewportHeight = () => page.evaluate(() => visualViewport!.height)
  const settledRecorded = () =>
    expect
      .poll(
        () =>
          page.evaluate(
            () =>
              !(window as any)._history_update_pending &&
              !(window as any)._popstate_scroll_pending &&
              (window as any)._history[(window as any)._history_index].scrollPosition === document.body.scrollTop
          ),
        { message: 'entry settled and scroll recorded' }
      )
      .toBe(true)

  const waitSaved = async (label: string) => {
    await expect.poll(() => savedId(page, label), { message: `${label} savedId`, timeout: 30_000 }).toBeTruthy()
    const id = (await savedId(page, label))!
    createdIds.add(id)
    await expect
      .poll(
        () =>
          page.evaluate(l => {
            const item = window.__items.find(i => i.id == window._item(l, true)?.id)
            return !!item && !item.saving && !!item.savedText
          }, label),
        { message: `${label} save settled`, timeout: 30_000 }
      )
      .toBe(true)
    return id
  }

  const waitGone = async (label: string, id: string) => {
    await expect
      .poll(() => page.evaluate(l => window._item(l, true)?.id ?? null, label), {
        message: `${label} removed locally`,
        timeout: 10_000,
      })
      .toBeNull()
    await expect
      .poll(async () => (await firestore().collection('items').doc(id).get()).exists, {
        message: `${label} removed on server`,
        timeout: 30_000,
      })
      .toBe(false)
  }

  try {
    await page.evaluate(items => {
      for (const [, text] of items) void window._create(text)
    }, baseFixtures)
    const ids = new Map<string, string>()
    for (const [label] of baseFixtures) ids.set(label, await waitSaved(label))
    await settled(page)
    const vh = await viewportHeight()
    const top = await headerTop(page)

    // 1. Pending Back restore onto a child deleted via item API while Back's frames are held:
    //    query backs up to the parent, and the Back entry's saved scroll position is preserved.
    const childId = await page.evaluate(c => window._item(c, true)!.id, CHILD)
    await asUser(page, id => void (window._item(id) as any).select(), childId)
    await expect(mindbox(page)).toHaveValue(CHILD)
    await settled(page)
    const savedChildScroll = top + 100
    await page.evaluate(y => document.body.scrollTo(0, y), savedChildScroll)
    await settledRecorded()
    expect(
      (await itemRectTop(PARENT))!,
      'premise step 1: saved Back position leaves parent below the scroll band'
    ).toBeGreaterThan(vh - 200)
    const childIdx = (await entries(page))[1]

    await userSet(page, '')
    await expect(mindbox(page)).toHaveValue('')
    expect((await entries(page))[1], 'premise step 1: leaving child pushed a new entry').toBe(childIdx + 1)
    const awayScroll = top + 500
    await page.evaluate(y => document.body.scrollTo(0, y), awayScroll)
    await settledRecorded()

    // hold Back's 2-rAF update_dom() restore (same pattern as the existing Back row)
    await page.evaluate(() => {
      window.addEventListener(
        'popstate',
        () => {
          const w = window as any
          const orig = window.requestAnimationFrame.bind(window)
          const held: FrameRequestCallback[] = []
          w.__origRaf = orig
          w.__releaseHeldRaf = () => {
            window.requestAnimationFrame = orig
            delete w.__origRaf
            delete w.__releaseHeldRaf
            for (const cb of held.splice(0)) orig(cb)
          }
          window.requestAnimationFrame = (cb => {
            held.push(cb)
            return held.length
          }) as typeof requestAnimationFrame
        },
        { capture: true, once: true }
      )
    })
    await page.goBack()
    await expect(mindbox(page)).toHaveValue(CHILD)
    expect(
      await page.evaluate(() => !!(window as any)._popstate_scroll_pending),
      'step 1: Back armed _popstate_scroll_pending while its frames are held'
    ).toBe(true)

    expect(
      await page.evaluate(c => window._item(c)!.delete(false), CHILD),
      'step 1: item API deletes child while Back restore is pending'
    ).toBe(true)
    await expect(mindbox(page)).toHaveValue(PARENT)

    await page.evaluate(() => {
      ;(window as any).__releaseHeldRaf?.()
      return new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
    })
    await settled(page)
    await expect
      .poll(() => page.evaluate(() => !!(window as any)._popstate_scroll_pending), {
        message: 'step 1: Back restore finished',
        timeout: 10_000,
      })
      .toBe(false)
    const afterBackDeleteScroll = await scrollTop(page)
    expect(await mindbox(page).inputValue(), 'step 1: query backed up to parent').toBe(PARENT)
    expect(await targetLabel(), 'step 1: parent is target after pending-Back delete').toBe(PARENT)
    expect
      .soft(
        Math.abs(afterBackDeleteScroll - savedChildScroll),
        `step 1: pending Back restore kept its saved position ${savedChildScroll} (got ${afterBackDeleteScroll}, away was ${awayScroll})`
      )
      .toBeLessThanOrEqual(2)
    await waitGone(CHILD, ids.get(CHILD)!)

    // 2. API delete_subtree(false) on #e2e_tree/a while tag-child #e2e_tree/in is selected:
    //    deleting #e2e_tree/in backs up to surviving textual ancestor #e2e_tree, which must scroll
    //    into view with exactly one scroll (subtree suppression applies only when root is selected).
    expect(
      await page.evaluate(l => {
        const i = window._item(l, true) as any
        return { tag_parent: i.tag_parent, ancestors: i.ancestors }
      }, `${T}/in`),
      'premise step 2: #e2e_tree/in is a tag-child of #e2e_tree/a under #e2e_tree'
    ).toEqual({ tag_parent: `${T}/a`, ancestors: [`${T}/a`, T] })

    await asUser(page, l => void (window._item(l) as any).select(), `${T}/in`)
    await expect.poll(targetLabel, { message: 'step 2: tag-child targeted', timeout: 10_000 }).toBe(`${T}/in`)
    await blur(page)
    await expect
      .poll(() => itemRectTop(T), { message: 'premise step 2: surviving ancestor above viewport before subtree delete', timeout: 10_000 })
      .toBeLessThan(0)
    await settled(page)

    await page.evaluate(() => {
      const w = window as any
      w.__delScrollCalls = 0
      w.__origBodyScrollTo = document.body.scrollTo
      document.body.scrollTo = function (...args: any[]) {
        w.__delScrollCalls++
        return w.__origBodyScrollTo.apply(this, args)
      }
    })
    expect(
      await page.evaluate(l => window._item(l)!.delete_subtree(false), `${T}/a`),
      'step 2: delete_subtree(false) on #e2e_tree/a succeeds'
    ).toBe(true)
    await expect
      .poll(
        () =>
          page.evaluate(
            ls => ls.every(l => !window._exists(l)),
            [`${T}/a`, `${T}/a/x`, `${T}/in`, `${T}/in/leaf`]
          ),
        { message: 'step 2: subtree items removed locally', timeout: 10_000 }
      )
      .toBe(true)
    await expect.poll(targetLabel, { message: 'step 2: surviving ancestor targeted', timeout: 10_000 }).toBe(T)
    await settled(page)
    const afterSubtreeTop = (await itemRectTop(T))!
    const subtreeScrollCalls = await page.evaluate(() => {
      const w = window as any
      const calls = w.__delScrollCalls as number
      if (w.__origBodyScrollTo) {
        document.body.scrollTo = w.__origBodyScrollTo
        delete w.__origBodyScrollTo
      }
      delete w.__delScrollCalls
      return calls
    })
    expect(await mindbox(page).inputValue(), 'step 2: query backed up to surviving ancestor').toBe(T)
    expect(await page.evaluate(l => window._exists(l), T), 'step 2: surviving ancestor kept').toBe(true)
    expect
      .soft(afterSubtreeTop, `step 2: surviving ancestor top (${afterSubtreeTop}) brought into view (>= 0)`)
      .toBeGreaterThanOrEqual(0)
    expect
      .soft(afterSubtreeTop, `step 2: surviving ancestor top (${afterSubtreeTop}) inside scroll band (<= ${vh - 200})`)
      .toBeLessThanOrEqual(vh - 200)
    expect
      .soft(subtreeScrollCalls, `step 2: API subtree delete with tag-child selected performs 1 scroll (got ${subtreeScrollCalls})`)
      .toBe(1)
    for (const label of [`${T}/a`, `${T}/a/x`, `${T}/in`, `${T}/in/leaf`]) await waitGone(label, ids.get(label)!)

    // 3. Mid-wait wheel input after a stationary-parent delete cancels deleteItem's deferred scroll
    //    and leaves the reader at their wheeled position.
    await page.evaluate(c => void window._create(`${c} step3 child`), CHILD)
    const idChild3 = await waitSaved(CHILD)
    await asUser(page, c => void (window._item(c) as any).select(), CHILD)
    await expect.poll(targetLabel, { message: 'step 3: child targeted', timeout: 10_000 }).toBe(CHILD)
    await blur(page)
    await expect
      .poll(() => itemRectTop(PARENT), { message: 'premise step 3: parent above viewport before delete', timeout: 10_000 })
      .toBeLessThan(0)
    await settled(page)

    await page.evaluate(() => {
      const w = window as any
      const orig = window.requestAnimationFrame.bind(window)
      const held: FrameRequestCallback[] = []
      w.__origRaf = orig
      w.__heldRaf = held
      w.__releaseHeldRaf = () => {
        window.requestAnimationFrame = orig
        delete w.__origRaf
        delete w.__heldRaf
        delete w.__releaseHeldRaf
        for (const cb of held.splice(0)) orig(cb)
      }
      window.requestAnimationFrame = (cb => {
        held.push(cb)
        return held.length
      }) as typeof requestAnimationFrame
    })
    await page.keyboard.press('Control+Backspace')
    await expect
      .poll(() => page.evaluate(c => window._item(c, true)?.id ?? null, CHILD), {
        message: 'step 3: child removed locally',
        timeout: 10_000,
      })
      .toBeNull()
    await expect(mindbox(page)).toHaveValue(PARENT)
    await expect
      .poll(() => page.evaluate(() => ((window as any).__heldRaf?.length ?? 0) > 0), {
        message: 'step 3: delete scroll callback queued onto held rAF',
        timeout: 10_000,
      })
      .toBe(true)

    const beforeWheelScroll = await scrollTop(page)
    await page.mouse.move(640, 360)
    await page.mouse.wheel(0, -200)
    await expect
      .poll(() => scrollTop(page), { message: 'step 3: wheel scrolled while frames were held', timeout: 10_000 })
      .toBeLessThan(beforeWheelScroll - 50)
    const afterWheelScroll = await scrollTop(page)
    expect(
      (await itemRectTop(PARENT))!,
      'premise step 3: parent still above viewport after wheel (so an uncancelled scrollToTarget would move it)'
    ).toBeLessThan(0)

    await page.evaluate(() => {
      ;(window as any).__releaseHeldRaf?.()
      return new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      )
    })
    await settled(page)
    const finalWheelScroll = await scrollTop(page)
    expect(await targetLabel(), 'step 3: parent is target after wheel-cancelled delete').toBe(PARENT)
    expect
      .soft(
        Math.abs(finalWheelScroll - afterWheelScroll),
        `step 3: mid-wait wheel kept reader position ${afterWheelScroll} (got ${finalWheelScroll})`
      )
      .toBeLessThanOrEqual(2)
    await waitGone(CHILD, idChild3)
  } finally {
    await page
      .evaluate(() => {
        const w = window as any
        if (w.__origRaf) {
          window.requestAnimationFrame = w.__origRaf
          delete w.__origRaf
          delete w.__heldRaf
          delete w.__releaseHeldRaf
        }
        if (w.__origBodyScrollTo) {
          document.body.scrollTo = w.__origBodyScrollTo
          delete w.__origBodyScrollTo
        }
        delete w.__delScrollCalls
      })
      .catch(() => {})
    await blur(page).catch(() => {})
    await page.evaluate(() => void (window as any).MindBox.set('')).catch(() => {})
    await expect
      .poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 })
      .toBe(true)
      .catch(() => {})
    await page
      .evaluate(
        ([prefix, tree]) => {
          const remaining = window.__items
            .filter(i => {
              const l = i.labelText?.toLowerCase() ?? ''
              return l.startsWith(prefix) || l == tree || l.startsWith(tree + '/') || l == '#chat' || l == '#chat/vault'
            })
            .map(i => i.id)
          for (const id of remaining) window._item(id, true)?.delete(false)
        },
        [PREFIX, T] as const
      )
      .catch(() => {})
    for (const id of createdIds) {
      const ref = firestore().collection('items').doc(id)
      if ((await ref.get()).exists) await ref.delete().catch(() => {})
    }
  }
  expect(pageErrors, 'no page errors').toEqual([])
})

test('deleting a parent with items under it asks in the app modal, lists them, offers subtree deletion, and leaves childless and code deletes unchanged', async ({
  page,
}) => {
  await loadAdmin(page)
  const pageErrors: string[] = []
  page.on('pageerror', err => pageErrors.push(err.message))
  const nativeDialogs: string[] = []
  page.on('dialog', dialog => {
    nativeDialogs.push(dialog.message())
    void dialog.dismiss()
  })

  const PREFIX = '#e2e_del_ask'
  const P1 = `${PREFIX}_p1`
  const P2 = `${PREFIX}_p2`
  const P3 = `${PREFIX}_p3`
  const P4 = `${PREFIX}_long`
  const P5 = `${PREFIX}_fresh`
  const createdIds = new Set<string>()
  const origViewport = page.viewportSize()

  const modal = page.locator('.background.visible .modal')

  const waitSaved = async (label: string) => {
    await expect.poll(() => savedId(page, label), { message: `${label} savedId`, timeout: 30_000 }).toBeTruthy()
    const id = (await savedId(page, label))!
    createdIds.add(id)
    await expect
      .poll(
        () =>
          page.evaluate(l => {
            const item = window.__items.find(i => i.id == window._item(l, true)?.id)
            return !!item && !item.saving && !!item.savedText
          }, label),
        { message: `${label} save settled`, timeout: 30_000 }
      )
      .toBe(true)
    return id
  }

  const waitGone = async (label: string, id: string) => {
    await expect
      .poll(() => page.evaluate(l => window._exists(l), label), {
        message: `${label} removed locally`,
        timeout: 10_000,
      })
      .toBe(false)
    await expect
      .poll(async () => (await firestore().collection('items').doc(id).get()).exists, {
        message: `${label} removed on server`,
        timeout: 30_000,
      })
      .toBe(false)
  }

  const createTree = async (root: string) => {
    const entries: readonly [string, string][] = [
      [root, `${root}\nparent body`],
      [`${root}/a`, `${root}/a\nchild a body`],
      [`${root}/b`, `${root}/b\nchild b body`],
      [`${root}/a/c`, `${root}/a/c\ngrandchild c body`],
    ]
    for (const [, text] of entries) await page.evaluate(t => void window._create(t), text)
    const ids: Record<string, string> = {}
    for (const [label] of entries) ids[label] = await waitSaved(label)
    return ids
  }

  const existing = (labels: string[]) =>
    page.evaluate(ls => ls.filter(l => window._exists(l)), labels)

  const target = async (name: string) => {
    await userSet(page, name, { scroll: true })
    await blur(page)
  }

  // count every time the modal backdrop transitions to visible (catches transient flashes too)
  await page.evaluate(() => {
    const w = window as any
    w.__modalOpens = 0
    const bg = document.querySelector('.background')!
    let wasVisible = bg.classList.contains('visible')
    const obs = new MutationObserver(() => {
      const nowVisible = bg.classList.contains('visible')
      if (nowVisible && !wasVisible) w.__modalOpens++
      wasVisible = nowVisible
    })
    obs.observe(bg, { attributes: true, attributeFilter: ['class'] })
    w.__modalObs = obs
  })
  const modalOpens = () => page.evaluate(() => (window as any).__modalOpens as number)
  const resetModalOpens = () => page.evaluate(() => { (window as any).__modalOpens = 0 })

  try {
    // 1. window delete key on parent: two dispatches in one turn open ONE modal (pending guard),
    //    listing descendants deepest-first, deleting nothing
    const ids1 = await createTree(P1)
    const tree1 = [P1, `${P1}/a`, `${P1}/b`, `${P1}/a/c`]
    await target(P1)
    await resetModalOpens()
    await page.evaluate(() => {
      for (let n = 0; n < 2; n++) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', ctrlKey: true, bubbles: true, cancelable: true })
        )
      }
    })
    await expect(modal, 'step 1: delete modal visible on parent with children').toBeVisible({ timeout: 10_000 })
    const modalText1 = await modal.innerText()
    expect(modalText1, 'step 1: names parent and descendant count').toContain(
      `${P1} has 3 items under it that would be left behind:`
    )
    expect(modalText1, 'step 1: lists descendants deepest first').toContain(`${P1}/a/c\n${P1}/a\n${P1}/b`)
    expect(await existing(tree1), 'step 1: nothing deleted while modal is open').toEqual(tree1)

    // 2. one cancellation closes the question with no second dialog behind it (then Escape too)
    await modal.locator('.button.cancel', { hasText: /^Cancel$/ }).click()
    await expect(modal, 'step 2: one cancel closes dialog with none stacked behind').toBeHidden({ timeout: 5_000 })
    expect(await modalOpens(), 'step 2: same-turn double delete opened only one dialog').toBe(1)
    expect(await existing(tree1), 'step 2: cancel button leaves all items').toEqual(tree1)

    await target(P1)
    await page.keyboard.press('Control+Backspace')
    await expect(modal, 'step 2: modal reopens on delete key').toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(modal, 'step 2: Escape closes dialog').toBeHidden({ timeout: 5_000 })
    expect(await existing(tree1), 'step 2: Escape leaves all items').toEqual(tree1)

    // 3. delete alone: parent is gone, children stay and are listed where items without a parent appear today
    await target(P1)
    await page.keyboard.press('Control+Backspace')
    await expect(modal, 'step 3: modal opens').toBeVisible({ timeout: 10_000 })
    await modal.locator('.button.confirm', { hasText: /^Delete item$/ }).click()
    await expect(modal, 'step 3: confirm closes dialog').toBeHidden({ timeout: 5_000 })
    await waitGone(P1, ids1[P1])
    expect(await mindbox(page).inputValue(), 'step 3: box clears after deleting top-level parent').toBe('')
    expect(await existing(tree1), 'step 3: children and grandchild remain').toEqual([`${P1}/a`, `${P1}/b`, `${P1}/a/c`])
    // direct children now have no parent item and remain listed in the page's main list and under a query for P1
    await expect
      .poll(
        () =>
          page.evaluate(
            labels =>
              labels.every(l => {
                const it = window._item(l, true) as any
                return !!it && !!document.querySelector(`.column:not(.hidden) .super-container:not(.hidden)#super-container-${it.id}`)
              }),
            [`${P1}/a`, `${P1}/b`, `${P1}/a/c`]
          ),
        { message: 'step 3: orphaned descendants remain listed visibly on the page', timeout: 10_000 }
      )
      .toBe(true)
    const directParents = await page.evaluate(
      ls => ls.map(l => (window.__items.find(i => i.labelText?.toLowerCase() == l) as any)?.parentId ?? null),
      [`${P1}/a`, `${P1}/b`]
    )
    expect(directParents, 'step 3: direct children have no parent item').toEqual([null, null])
    await target(P1)
    const matchingUnderP1 = await page.evaluate(
      ls => ls.filter(l => window.__items.find(i => i.labelText?.toLowerCase() == l)?.matching),
      [`${P1}/a`, `${P1}/b`, `${P1}/a/c`]
    )
    expect(matchingUnderP1, 'step 3: querying deleted parent still lists its left-behind descendants').toEqual([
      `${P1}/a`,
      `${P1}/b`,
      `${P1}/a/c`,
    ])

    // 4. secondary button on destructive controls does not confirm; replacing a listed child while
    //    the question is open refreshes the list without deleting; then Delete subtree removes all
    const ids2 = await createTree(P2)
    const tree2 = [P2, `${P2}/a`, `${P2}/b`, `${P2}/a/c`]
    await target(P2)
    await resetModalOpens()
    await page.keyboard.press('Control+Backspace')
    await expect(modal, 'step 4: modal opens for parent').toBeVisible({ timeout: 10_000 })

    // right-click on Delete subtree and on Delete item must leave the same question open and every item intact
    await modal.locator('.button.extra', { hasText: /^Delete subtree$/ }).click({ button: 'right' })
    await expect(modal, 'step 4: right-click on Delete subtree keeps modal open').toBeVisible()
    expect(await existing(tree2), 'step 4: right-click on Delete subtree deletes nothing').toEqual(tree2)
    expect(await modalOpens(), 'step 4: right-click on Delete subtree kept same dialog').toBe(1)
    await modal.locator('.button.confirm', { hasText: /^Delete item$/ }).click({ button: 'right' })
    await expect(modal, 'step 4: right-click on Delete item keeps modal open').toBeVisible()
    expect(await existing(tree2), 'step 4: right-click on Delete item deletes nothing').toEqual(tree2)
    expect(await modalOpens(), 'step 4: right-click on Delete item kept same dialog').toBe(1)

    // Control-click (macOS context-menu gesture: button === 0 with ctrlKey === true) on either destructive
    // button must also leave the same question open and every item intact
    await modal.locator('.button.extra', { hasText: /^Delete subtree$/ }).click({ modifiers: ['Control'] })
    await expect(modal, 'step 4: Control-click on Delete subtree keeps modal open').toBeVisible()
    expect(await existing(tree2), 'step 4: Control-click on Delete subtree deletes nothing').toEqual(tree2)
    expect(await modalOpens(), 'step 4: Control-click on Delete subtree kept same dialog').toBe(1)
    await modal.locator('.button.confirm', { hasText: /^Delete item$/ }).click({ modifiers: ['Control'] })
    await expect(modal, 'step 4: Control-click on Delete item keeps modal open').toBeVisible()
    expect(await existing(tree2), 'step 4: Control-click on Delete item deletes nothing').toEqual(tree2)
    expect(await modalOpens(), 'step 4: Control-click on Delete item kept same dialog').toBe(1)

    // while the question is open, replace a listed child with a new one (same count, different membership)
    await page.evaluate(
      ([gone, added]) => {
        window._item(gone, true)!.delete(false)
        void window._create(`${added}\nreplacement child body`)
      },
      [`${P2}/b`, `${P2}/d`]
    )
    ids2[`${P2}/d`] = await waitSaved(`${P2}/d`)
    await waitGone(`${P2}/b`, ids2[`${P2}/b`])
    const tree2Updated = [P2, `${P2}/a`, `${P2}/a/c`, `${P2}/d`]
    await modal.locator('.button.extra', { hasText: /^Delete subtree$/ }).click()
    await expect(modal, 'step 4: replaced child refreshes question instead of deleting').toBeVisible({ timeout: 5_000 })
    await expect(modal, 'step 4: refreshed question lists the replacement child').toContainText(`${P2}/d`, {
      timeout: 5_000,
    })
    const refreshedText = await modal.innerText()
    expect(refreshedText, 'step 4: refreshed question drops the removed child').not.toContain(`${P2}/b`)
    expect(refreshedText, 'step 4: refreshed question lists current descendants deepest first').toContain(
      `${P2}/a/c\n${P2}/a\n${P2}/d`
    )
    expect(await existing(tree2Updated), 'step 4: nothing deleted when membership changed').toEqual(tree2Updated)

    // now confirm the intended Delete subtree against the current list
    await modal.locator('.button.extra', { hasText: /^Delete subtree$/ }).click()
    await expect(modal, 'step 4: subtree button closes refreshed dialog').toBeHidden({ timeout: 5_000 })
    for (const label of tree2Updated) await waitGone(label, ids2[label])
    expect(nativeDialogs, 'step 4: no second browser confirm dialog').toEqual([])
    expect(await mindbox(page).inputValue(), 'step 4: box clears after subtree delete').toBe('')

    // 5. an item with nothing under it: no dialog, deleted immediately as today
    await target(`${P1}/b`)
    await resetModalOpens()
    await page.keyboard.press('Control+Backspace')
    await waitGone(`${P1}/b`, ids1[`${P1}/b`])
    await expect(modal, 'step 5: no modal for childless item').toBeHidden()
    expect(await modalOpens(), 'step 5: zero modals opened for childless item').toBe(0)
    expect(nativeDialogs, 'step 5: no browser confirm for childless item').toEqual([])

    // 6. from the parent's own editor (the key, plus edit-menu delete and emptied-item save):
    //    same dialog; cancel keeps editor open with text intact; Enter confirms single-item delete
    const ids3 = await createTree(P3)
    const tree3 = [P3, `${P3}/a`, `${P3}/b`, `${P3}/a/c`]
    await target(P3)
    const p3TabId = await page.evaluate(l => window._item(l, true)!.id as string, P3)
    await page.locator(`#item-${p3TabId} p`, { hasText: 'parent body' }).click()
    const p3Editor = page.locator(`#textarea-${p3TabId}`)
    await expect(p3Editor, 'step 6: parent editor opened').toBeVisible({ timeout: 10_000 })
    await expect(p3Editor, 'step 6: parent editor focused').toBeFocused()
    await resetModalOpens()
    await page.evaluate(id => {
      const ta = document.querySelector(`#textarea-${id}`)!
      for (let n = 0; n < 2; n++) {
        ta.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', ctrlKey: true, bubbles: true, cancelable: true })
        )
      }
    }, p3TabId)
    await expect(modal, 'step 6: editor delete key opens modal on parent').toBeVisible({ timeout: 10_000 })
    expect(await modal.innerText(), 'step 6: editor modal lists descendants').toContain(
      `${P3} has 3 items under it that would be left behind:`
    )
    expect(await modal.innerText(), 'step 6: editor modal lists names deepest first').toContain(
      `${P3}/a/c\n${P3}/a\n${P3}/b`
    )
    expect(await existing(tree3), 'step 6: nothing deleted while editor modal is open').toEqual(tree3)
    await expect(p3Editor, 'step 6: editor remains open with text while modal is open').toHaveValue(`${P3}\nparent body`)
    await page.keyboard.press('Escape')
    await expect(modal, 'step 6: one Escape closes editor delete modal with none stacked behind').toBeHidden({
      timeout: 5_000,
    })
    expect(await modalOpens(), 'step 6: same-turn double delete in editor opened only one dialog').toBe(1)
    await expect(p3Editor, 'step 6: Escape keeps editor open and focused').toBeFocused()
    expect(await existing(tree3), 'step 6: Escape from editor modal deletes nothing').toEqual(tree3)

    // window focus restore timer must not refocus the parent's editor behind the open delete question,
    // while still restoring focus to a control inside an active dialog (uses the system-blur row's timer hold)
    const p3Draft = `${P3}\nparent body edited`
    await p3Editor.fill(p3Draft)
    await expect(p3Editor, 'step 6: editor holds modified draft').toBeFocused()
    const cdp = await page.context().newCDPSession(page)
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    const away = async () => {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
      await expect.poll(() => page.evaluate(() => document.hasFocus()), { message: 'step 6: no system focus' }).toBe(false)
    }
    const back = async () => {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await expect.poll(() => page.evaluate(() => document.hasFocus()), { message: 'step 6: system focus back' }).toBe(true)
    }
    const holdRestore = () =>
      page.evaluate(() => {
        const w = window as any
        const held: { id: number; cb: () => void }[] = (w.__heldRestore = [])
        const setTimeout_ = (w.__setTimeout = window.setTimeout)
        const clearTimeout_ = (w.__clearTimeout = window.clearTimeout)
        w.__fakeTimerId ??= 1 << 30
        ;(window as any).setTimeout = (cb: () => void, ms?: number, ...args: unknown[]) =>
          ms == 250 ? (held.push({ id: ++w.__fakeTimerId, cb }), w.__fakeTimerId) : setTimeout_(cb, ms, ...args)
        ;(window as any).clearTimeout = (id?: number) => {
          const i = held.findIndex(h => h.id == id)
          if (i >= 0) held.splice(i, 1)
          else clearTimeout_(id)
        }
      })
    const releaseRestore = () =>
      page.evaluate(() => {
        const w = window as any
        if (w.__setTimeout) window.setTimeout = w.__setTimeout
        if (w.__clearTimeout) window.clearTimeout = w.__clearTimeout
        delete w.__setTimeout
        delete w.__clearTimeout
        const late = (w.__heldRestore?.splice(0) ?? []) as { cb: () => void }[]
        late.forEach(h => h.cb())
        return late.length
      })
    try {
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
      await away() // records p3Editor in lastFocusedElem
      await holdRestore()
      await back() // arms the 250 ms focus restore timer (held)
      // focus the parent editor inside the 250 ms window (as clicking back into the window's editor does)
      await page.locator(`#super-container-${p3TabId} .editor .backdrop`).click()
      await expect(p3Editor, 'step 6: editor active on window return').toBeFocused()
      await resetModalOpens()
      await page.keyboard.press('Control+Backspace')
      await expect(modal, 'step 6: delete modal opens while focus restore is pending').toBeVisible({ timeout: 10_000 })
      await expect(p3Editor, 'step 6: modal blurred editor before restore timer fires').not.toBeFocused()
      expect(await releaseRestore(), 'step 6: window focus armed at least one 250 ms timer').toBeGreaterThanOrEqual(1)
      // one real Escape closes the delete question (not captured by the editor behind it), keeps the draft,
      // and queues no Discard question
      await page.keyboard.press('Escape')
      await expect(modal, 'step 6: one Escape after focus restore closes delete question').toBeHidden({
        timeout: 5_000,
      })
      expect(await modalOpens(), 'step 6: no Discard question shown after Escape').toBe(1)
      await expect(p3Editor, 'step 6: editor keeps modified draft after focus-restore Escape').toHaveValue(p3Draft)
      await expect(p3Editor, 'step 6: editor regains focus after focus-restore Escape').toBeFocused()
      await expect(modal, 'step 6: no Discard question opened behind delete question').toBeHidden()
      expect(await existing(tree3), 'step 6: nothing deleted after focus-restore Escape').toEqual(tree3)

      // a control inside an active dialog is still restored by the same timer
      await page.evaluate(
        () =>
          void (window as any)._modal('focus restore inside active dialog', {
            input: 'keep',
            confirm: 'OK',
            cancel: 'Cancel',
          })
      )
      const modalInput = page.locator('#modal-input')
      await expect(modalInput, 'step 6: active dialog input focused').toBeFocused({ timeout: 5_000 })
      await away() // records #modal-input in lastFocusedElem
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()) // silent while away
      expect(
        await page.evaluate(() => document.activeElement?.tagName),
        'step 6: premise — active dialog input blurred while away'
      ).toBe('BODY')
      await holdRestore()
      await back()
      await expect(modalInput, 'step 6: dialog input not focused before restore timer fires').not.toBeFocused()
      expect(await releaseRestore(), 'step 6: dialog return armed at least one 250 ms timer').toBeGreaterThanOrEqual(1)
      await expect(
        modalInput,
        'step 6: restore timer still restores focus to control inside active dialog'
      ).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(modal, 'step 6: active dialog closed after restore check').toBeHidden({ timeout: 5_000 })
      await expect(p3Editor, 'step 6: editor regains focus after active dialog closes').toBeFocused()
      await expect(p3Editor, 'step 6: editor still holds modified draft').toHaveValue(p3Draft)
    } finally {
      await page
        .evaluate(() => {
          const w = window as any
          if (w.__setTimeout) window.setTimeout = w.__setTimeout
          if (w.__clearTimeout) window.clearTimeout = w.__clearTimeout
          delete w.__setTimeout
          delete w.__clearTimeout
          delete w.__heldRestore
        })
        .catch(() => {})
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      await cdp.detach().catch(() => {})
    }

    // confirm via Enter from the editor's delete dialog: deletes parent alone
    await page.keyboard.press('Control+Backspace')
    await expect(modal, 'step 6: modal reopens from editor').toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Enter')
    await expect(modal, 'step 6: Enter confirms and closes dialog').toBeHidden({ timeout: 5_000 })
    await waitGone(P3, ids3[P3])
    expect(await existing(tree3), 'step 6: Enter deletes parent alone, children stay').toEqual([
      `${P3}/a`,
      `${P3}/b`,
      `${P3}/a/c`,
    ])

    // edit menu's delete button and emptied-item save on P3/a (which still has grandchild P3/a/c under it)
    await target(`${P3}/a`)
    const p3aTabId = await page.evaluate(l => window._item(l, true)!.id as string, `${P3}/a`)
    await page.locator(`#item-${p3aTabId} p`, { hasText: 'child a body' }).click()
    const p3aEditor = page.locator(`#textarea-${p3aTabId}`)
    await expect(p3aEditor).toBeVisible({ timeout: 10_000 })
    await page.locator(`#super-container-${p3aTabId} .edit-menu .button.delete`).click()
    await expect(modal, 'step 6: edit menu delete opens modal').toBeVisible({ timeout: 10_000 })
    expect(await modal.innerText(), 'step 6: edit menu modal names grandchild').toContain(
      `${P3}/a has 1 item under it that would be left behind:`
    )
    expect(await modal.innerText()).toContain(`${P3}/a/c`)
    await modal.locator('.button.cancel').click()
    await expect(modal).toBeHidden({ timeout: 5_000 })
    await expect(p3aEditor, 'step 6: cancelling edit-menu delete keeps editor text intact').toHaveValue(
      `${P3}/a\nchild a body`
    )
    await p3aEditor.fill('')
    await page.keyboard.press('Shift+Enter')
    await expect(modal, 'step 6: saving emptied parent opens modal').toBeVisible({ timeout: 10_000 })
    await expect(p3aEditor, 'step 6: emptied editor stays open empty while asking').toHaveValue('')
    await modal.locator('.button.cancel').click()
    await expect(modal).toBeHidden({ timeout: 5_000 })
    await expect(p3aEditor, 'step 6: cancelling emptied-parent modal keeps empty editor focused').toBeFocused()
    expect(await itemText(page, `${P3}/a`), 'step 6: item text stayed intact on cancel').toBe(`${P3}/a\nchild a body`)
    await page.keyboard.press('Escape')
    await expect(modal, 'step 6: Escape after empty draft asks to discard').toBeVisible({ timeout: 10_000 })
    await modal.locator('.button.confirm', { hasText: /^Discard$/ }).click()
    await expect(p3aEditor).toBeHidden({ timeout: 5_000 })

    // 7. delete by code on a parent with children: synchronous, no dialog, parent gone, child stays
    await resetModalOpens()
    const codeResult = await page.evaluate(l => window._item(l)!.delete(false) === true, `${P3}/a`)
    expect(codeResult, 'step 7: code delete returns true synchronously').toBe(true)
    await waitGone(`${P3}/a`, ids3[`${P3}/a`])
    expect(await page.evaluate(l => window._exists(l), `${P3}/a/c`), 'step 7: child stays').toBe(true)
    await expect(modal, 'step 7: code delete opens no modal').toBeHidden()
    expect(await modalOpens(), 'step 7: zero modals opened for code delete').toBe(0)
    expect(nativeDialogs, 'step 7: no browser confirm for code delete').toEqual([])

    // 8. short landscape window (740x360) with 12 long-named children that wrap:
    //    all three buttons stay inside the window, Cancel is clickable, list shows 10 names and "… and 2 more"
    const longChildren = Array.from(
      { length: 12 },
      (_, idx) => `${P4}/child_${String(idx + 1).padStart(2, '0')}_with_a_name_long_enough_to_wrap_across_two_lines`
    )
    await page.evaluate(
      labels => {
        for (const l of labels) void window._create(`${l}\nbody`)
      },
      [P4, ...longChildren]
    )
    await waitSaved(P4)
    for (const c of longChildren) await waitSaved(c)
    await page.setViewportSize({ width: 740, height: 360 })
    try {
      await target(P4)
      await page.keyboard.press('Control+Backspace')
      await expect(modal, 'step 8: modal opens on 740x360 viewport').toBeVisible({ timeout: 10_000 })
      const longModalText = await modal.innerText()
      expect(longModalText, 'step 8: names parent and 12 children').toContain(
        `${P4} has 12 items under it that would be left behind:`
      )
      for (const c of longChildren.slice(0, 10)) {
        expect(longModalText, `step 8: lists ${c}`).toContain(c)
      }
      expect(longModalText, 'step 8: shows "… and 2 more"').toContain('… and 2 more')
      expect(longModalText, 'step 8: omits 11th child').not.toContain(longChildren[10])
      expect(longModalText, 'step 8: omits 12th child').not.toContain(longChildren[11])
      const layout = await page.evaluate(() => {
        const vh = window.innerHeight
        const vw = window.innerWidth
        const modalEl = document.querySelector('.background.visible .modal') as HTMLElement
        const list = modalEl.querySelector('.delete-list') as HTMLElement | null
        const buttons = ['.button.cancel', '.button.extra', '.button.confirm'].map(sel => {
          const rect = modalEl.querySelector(sel)!.getBoundingClientRect()
          return { sel, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
        })
        return {
          vh,
          vw,
          listScrollHeight: list?.scrollHeight ?? 0,
          listClientHeight: list?.clientHeight ?? 0,
          buttons,
        }
      })
      expect(layout.vh, 'step 8: viewport height is 360').toBe(360)
      for (const b of layout.buttons) {
        expect(b.top, `step 8: ${b.sel} top inside viewport`).toBeGreaterThanOrEqual(0)
        expect(b.bottom, `step 8: ${b.sel} bottom inside viewport`).toBeLessThanOrEqual(layout.vh)
        expect(b.left, `step 8: ${b.sel} left inside viewport`).toBeGreaterThanOrEqual(0)
        expect(b.right, `step 8: ${b.sel} right inside viewport`).toBeLessThanOrEqual(layout.vw)
      }
      expect(layout.listScrollHeight, 'step 8: premise — 10 wrapped names exceed 10 single lines').toBeGreaterThan(400)
      expect(layout.listScrollHeight, 'step 8: list scrolls vertically inside bounded height').toBeGreaterThan(
        layout.listClientHeight
      )
      await modal.locator('.button.cancel', { hasText: /^Cancel$/ }).click()
      await expect(modal, 'step 8: Cancel closes long-list dialog').toBeHidden({ timeout: 5_000 })
    } finally {
      if (origViewport) await page.setViewportSize(origViewport)
    }

    // 9. fresh parent (save: false, edit: true) over an existing child:
    //    Escape -> Discard -> Cancel keeps editor open with typed draft, item text and label intact, child intact;
    //    Escape -> Discard -> Delete item deletes the fresh parent and leaves the child
    const P5Child = `${P5}/child`
    await page.evaluate(t => void window._create(t), `${P5Child}\nexisting child body`)
    await waitSaved(P5Child)
    const freshTabId = await page.evaluate(
      l => (window._create(l, { save: false, edit: true }) as any).id as string,
      P5
    )
    await expect.poll(() => savedId(page, P5), { message: `${P5} fresh savedId`, timeout: 30_000 }).toBeTruthy()
    const freshSavedId = (await savedId(page, P5))!
    createdIds.add(freshSavedId)
    const freshEditor = page.locator(`#textarea-${freshTabId}`)
    await expect(freshEditor, 'step 9: fresh parent editor opened').toBeVisible({ timeout: 10_000 })
    const typedDraft = `${P5}\ntyped draft text`
    await freshEditor.fill(typedDraft)
    await expect(freshEditor, 'step 9: fresh parent editor focused').toBeFocused()
    const beforeEscape = await page.evaluate(id => {
      const it = window.__items.find(i => i.id == id) as any
      return { text: it.text, label: it.label, savedText: it.savedText, saving: it.saving }
    }, freshTabId)
    expect(beforeEscape, 'step 9: premise — fresh unsaved parent before Escape').toEqual({
      text: P5,
      label: P5,
      savedText: '',
      saving: false,
    })

    await page.keyboard.press('Escape')
    await expect(modal, 'step 9: Escape asks Discard').toContainText(`Discard unsaved changes to ${P5}?`, {
      timeout: 10_000,
    })
    await modal.locator('.button.confirm', { hasText: /^Discard$/ }).click()
    await expect(modal, 'step 9: Discard leads to delete-with-descendants question').toContainText(
      `${P5} has 1 item under it that would be left behind:`,
      { timeout: 10_000 }
    )
    expect(await modal.innerText(), 'step 9: delete question lists existing child').toContain(P5Child)
    await modal.locator('.button.cancel', { hasText: /^Cancel$/ }).click()
    await expect(modal, 'step 9: Cancel closes delete question').toBeHidden({ timeout: 5_000 })
    await expect(freshEditor, 'step 9: editor stays open after Discard -> Cancel').toBeVisible()
    await expect(freshEditor, 'step 9: editor keeps typed draft after Discard -> Cancel').toHaveValue(typedDraft)
    await expect(freshEditor, 'step 9: editor regains focus after Cancel').toBeFocused()
    const afterCancel = await page.evaluate(id => {
      const it = window.__items.find(i => i.id == id) as any
      return {
        editing: it.editing,
        text: it.text,
        label: it.label,
        savedText: it.savedText,
        saving: it.saving,
        editorText: (it.editorText ?? '').replace(/\u200B/g, ''),
      }
    }, freshTabId)
    expect(afterCancel, 'step 9: item text, label, draft, and unsaved state preserved after Discard -> Cancel').toEqual({
      editing: true,
      text: P5,
      label: P5,
      savedText: '',
      saving: false,
      editorText: typedDraft,
    })
    expect(await page.evaluate(l => window._exists(l), P5Child), 'step 9: child stays after Cancel').toBe(true)

    await page.keyboard.press('Escape')
    await expect(modal, 'step 9: Escape asks Discard again').toContainText(`Discard unsaved changes to ${P5}?`, {
      timeout: 10_000,
    })
    await modal.locator('.button.confirm', { hasText: /^Discard$/ }).click()
    await expect(modal, 'step 9: Discard opens delete question again').toContainText(
      `${P5} has 1 item under it that would be left behind:`,
      { timeout: 10_000 }
    )
    await modal.locator('.button.confirm', { hasText: /^Delete item$/ }).click()
    await expect(modal, 'step 9: Delete item closes dialog').toBeHidden({ timeout: 5_000 })
    await waitGone(P5, freshSavedId)
    expect(await page.evaluate(l => window._exists(l), P5Child), 'step 9: child stays after deleting fresh parent').toBe(
      true
    )
  } finally {
    if (origViewport) await page.setViewportSize(origViewport).catch(() => {})
    await page
      .evaluate(() => {
        const w = window as any
        w.__modalObs?.disconnect?.()
        delete w.__modalObs
        delete w.__modalOpens
        w._modal_close?.()
      })
      .catch(() => {})
    await blur(page).catch(() => {})
    await page.evaluate(() => void (window as any).MindBox.set('')).catch(() => {})
    await expect
      .poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false), { timeout: 10_000 })
      .toBe(true)
      .catch(() => {})
    await page
      .evaluate(prefix => {
        const remaining = window.__items
          .filter(i => (i.labelText?.toLowerCase() ?? '').startsWith(prefix))
          .map(i => i.id)
        for (const id of remaining) window._item(id, true)?.delete(false)
      }, PREFIX)
      .catch(() => {})
    for (const id of createdIds) {
      const ref = firestore().collection('items').doc(id)
      if ((await ref.get()).exists) await ref.delete().catch(() => {})
    }
  }
  expect(nativeDialogs, 'no browser confirm dialog').toEqual([])
  expect(pageErrors, 'no page errors').toEqual([])
})
