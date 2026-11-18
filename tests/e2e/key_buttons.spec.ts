import { expect, test, type Page } from '@playwright/test'
import { firestore, install, loadAdmin, waitForApp } from './helpers.js'

// the #key_buttons item (mind.items key_buttons.js; the vault's todo of 2026-11-17): the keys
// that navigate items as buttons on the page, for a device without a keyboard. The item sends
// the key (keyboard events dispatched on the page) and copies nothing of the app's navigation,
// so this row is where a press is seen to do what the key does: every walk below is made once
// with the real keys and once with a finger's taps on the buttons, and the two must agree.
// phases: (a) on a desktop, an install after the page's welcome draws the row hidden, and a
// desktop never shows it; (b) a phone shows it: seven round buttons along the window's bottom
// edge, left of the sparkle's place, each one hit by a tap at its centre, none over the header;
// (c) the arrows: Down to the first child, Right and Left through the siblings (and around),
// Up to the parent; (d) the create button is Shift+Enter: from the window a child of the named
// item with its editor focused, and in that focused editor the editor's own save, which waits
// for the modifier's release; (e) the scroll buttons are Ctrl+Alt+Up and Ctrl+Alt+Down: to the
// top with a history entry, and back to the position; (f) the on-screen keyboard (SIMULATED: a
// desktop lane has none) comes up under an editor whose caret is low in the window: the main
// row hides and a short row shows just above the keyboard, placed from the visual viewport,
// and nothing scrolls (the caret's scroll is switched off); its Tab and Shift+Tab indent and
// outdent a bulleted line as the real keys do and leave the editor its focus, Shift+Space is
// that Tab too (and a plain space on a desktop), and its Shift+Enter saves the item; with no
// field focused there is no keyboard, whatever the view says; where the window's own height
// follows the keyboard, the view against the tallest seen still reads it; a tap is asked again
// whom it is for: the focus gone from the MindBox and the row still showing, Done sends
// nothing; and the keyboard of a field that is no editor of the app (an input embedded in an
// item, and a textarea of an item's own markup in a box of class `editor`) hides the main row
// and the reload button and is offered no row: the field keeps its focus and what was typed (a
// Shift+Space there is the field's own key), the MindBox its contents, and no item is made; (g) the reload
// button, on the desktop page and on the phone: at the lower left, the mirror of the #vault
// item's sparkle (no sparkle is drawn in this lane), clear of the main row, hidden while the
// keyboard is up; a tap reloads the page at once while nothing would be lost; with text typed
// into an item's editor it asks first, in the app's dialog: cancelled, the page and the typed
// text stay, and confirmed, the page reloads once with no question of the browser's on top; on
// an app without a reload of its own (the released one) the item asks before EVERY reload, the
// one after its owner kept a draft included (the item's close button, then Cancel: a state that
// reads as clean through an item's handles), and a clean page's; with a save that is not finished (a write held
// at the network, a second save waiting behind it, the item's texts all agreeing) the app asks
// as well: cancelled, the page stays until the waiting write has gone out; (h) more than one period
// of the task after the install the desktop page has a live controller, and the item's deletion
// removes the rows and the button at its task's next look
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

// a phone, as far as a desktop lane can play one: a narrow touch window whose primary pointer
// is coarse (Chromium's touch emulation)
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const ROOT = '#e2e_keys'
const LIST = '#e2e_keys_list' // an item with a bulleted line, for the Tab
const FIELD = '#e2e_keys_field' // an item with a field of its own, which is no editor of the app
const QUESTION = 'Reload and discard unsaved changes?' // the app's, where something would be lost
const ASKS = 'Reload and discard any unsaved changes?' // the item's own, on an app without a reload of its own
const WRITES = /Firestore\/Write\/channel/ // the requests of the Firestore client's writes (its Listen stream is another)
const TEXT = `${LIST}\n- one\n- two`
const BAR = '[data-key-buttons="bar"]'
const ABOVE = '[data-key-buttons="keyboard"]'
const RELOAD = '[data-key-buttons="reload"]'
const KEYBOARD_PX = 336 // what the simulated keyboard takes of the window's height
// the two rows' keys, in the rows' order, named here outright: a key of the item's table that
// is changed is then a walk, a save or a row below that fails, and nothing here reads how the
// item's code is spelled
const NAMES = ['top', 'back', 'create', 'left', 'up', 'down', 'right']
const ABOVE_NAMES = ['outdent', 'indent', 'done']
// the #vault item's sparkle: 14 px from the right edge, 10 px from the bottom, 24 px wide and
// high (the reload button is its mirror at the left). The numbers are its rule's in vault.md;
// the items' own table (mind.items tests/key_buttons_test.js) holds the button's to that rule
const SPARKLE = [14, 10, 24, 24]
// the item's table of the look (sizes, places, a color), read from the installed item on the
// page: a number changed there is what (b) expects, with none repeated here
type Look = { size: number; gap: number; right: number; bottom: number; color: string; above: number; edge: number }
const KEYS: Record<string, string> = { top: 'Control+Alt+ArrowUp', back: 'Control+Alt+ArrowDown', create: 'Shift+Enter', left: 'ArrowLeft', up: 'ArrowUp', down: 'ArrowDown', right: 'ArrowRight' }

const query = (page: Page) => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
const scrollTop = (page: Page) => page.evaluate(() => document.body.scrollTop)
const headerTop = (page: Page) => page.evaluate(() => (document.querySelector('.header') as HTMLElement).offsetTop)
const entries = (page: Page) => page.evaluate(() => [(window as any)._history.length, (window as any)._history_index] as const)
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
// the two ways of pressing: the real key, and a finger's tap at the centre of the key's button
const key = (page: Page) => (name: string) => page.keyboard.press(KEYS[name])
const tap = (page: Page, row = BAR) => async (name: string) => {
  const box = (await page.locator(`${row} > button[data-key="${name}"]`).boundingBox())!
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
}
// the on-screen keyboard, SIMULATED: `up`, the visual viewport is made to report a height shorter
// than the window's by the keyboard's, as a phone's does while its keyboard is up (the window's
// own height stays), and its resize is announced; `follows`, the window's own height reports
// the short height too (a window that is resized with the keyboard); `down`, both report their own
const keyboard = (page: Page, state: 'up' | 'follows' | 'down') =>
  page.evaluate(([state, px]) => {
    const view = window.visualViewport!
    const kept = ((window as any).__kept ??= { tall: window.innerHeight, inner: Object.getOwnPropertyDescriptor(window, 'innerHeight')! })
    const short = () => kept.tall - (px as number)
    if (state == 'down') delete (view as any).height
    else Object.defineProperty(view, 'height', { configurable: true, get: short })
    Object.defineProperty(window, 'innerHeight', state == 'follows' ? { configurable: true, get: short } : kept.inner)
    view.dispatchEvent(new Event('resize'))
    return [view.height, window.innerHeight]
  }, [state, KEYBOARD_PX] as const)
// a row's place and buttons: each button's box, and whether a finger at its centre hits it
const rowLook = (page: Page, row: string) =>
  page.evaluate(row => {
    const bar = document.querySelector(row)!
    const box = bar.getBoundingClientRect()
    return {
      names: Array.from(bar.children, button => (button as HTMLElement).dataset.key),
      buttons: Array.from(bar.children, button => {
        const box = button.getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return [box.width, box.height, hit === button || button.contains(hit)]
      }),
      right: box.right,
      bottom: box.bottom,
    }
  }, row)
type Press = (name: string) => Promise<void>

// the box names an item, as a tag click leaves it: the query applied and the item shown as the target
const name = async (page: Page, label: string) => {
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), label)
  await shown(page, label)
  await blur(page)
}
const shown = (page: Page, label: string) =>
  expect
    .poll(async () => [(await query(page)).trim(), await page.evaluate(() => (document.querySelector('.container.target mark.label') as HTMLElement | null)?.title ?? null)], { message: `${label} named and shown` })
    .toEqual([label, label])

// (c) the walk through the tree: from the root Down, Right, Right, Left, Up; what the box names after each
const walk = async (page: Page, press: Press) => {
  await name(page, ROOT)
  const seen: string[] = []
  for (const step of ['down', 'right', 'right', 'left', 'up']) {
    const before = await query(page)
    await press(step)
    await expect.poll(() => query(page), { message: `${step} from ${before}` }).not.toBe(before)
    seen.push((await query(page)).trim())
    await shown(page, seen[seen.length - 1])
  }
  return seen
}

// (d) the create key from the window, then again in the editor it opened: the child's label, whether
// its editor took the focus, and the child as saved by the second press
const reply = async (page: Page, press: Press, parent: string) => {
  await name(page, parent)
  await press('create')
  const child = `${parent}/0`
  await expect.poll(() => query(page), { message: `a child of ${parent}` }).toBe(`${child} `)
  const id = await page.evaluate(label => window._item(label, true)!.id, child)
  await expect(page.locator(`#textarea-${id}`), 'the new item is edited, with the focus').toBeFocused()
  await page.keyboard.press('ArrowRight') // the selected suffix collapsed to its end
  await page.keyboard.type('a reply')
  await press('create') // in the focused editor: its save, once the modifier is released
  const saved = () => page.evaluate(label => [(window._item(label, true) as any).editing, window._item(label, true)!.text] as const, child)
  await expect.poll(saved, { message: `${child} saved by the key in its editor` }).toEqual([false, `${child} a reply`])
  return child
}

// (e) the two scrolls from a scrolled page: to the top with a history entry, and back to the position
const scrolls = async (page: Page, press: Press) => {
  await blur(page)
  const top = await headerTop(page)
  await expect
    .poll(async () => {
      await page.evaluate(y => document.body.scrollTo(0, y), top + 600)
      await page.waitForTimeout(150)
      return scrollTop(page)
    }, { message: 'the body scrolled below the header' })
    .toBeGreaterThan(top + 300)
  const position = await scrollTop(page)
  const [, index] = await entries(page)
  await press('top')
  await expect.poll(async () => Math.abs((await scrollTop(page)) - top) <= 2, { message: 'at the top' }).toBe(true)
  // one entry pushed after the current one, the last now (an entry ahead of it, left by an earlier Back, is dropped)
  expect(await entries(page), 'the scroll to the top pushed one entry').toEqual([index + 2, index + 1])
  await press('back')
  await expect.poll(async () => Math.abs((await scrollTop(page)) - position) <= 2, { message: 'back at the position' }).toBe(true)
  await page.waitForTimeout(300) // whatever the restore scheduled
  expect([Math.abs((await scrollTop(page)) - position) <= 2, await entries(page)], 'still there, one entry back').toEqual([true, [index + 2, index]])
}

test('the key buttons show on a phone, and a tap on one does what its key does', async ({ page, browser }) => {
  // (a) a desktop: the install draws the row through the item's own change hook, and hides it
  await loadAdmin(page)
  expect(await install(page, 'key_buttons')).toBeNull()
  const installed = Date.now()
  await expect(page.locator(BAR)).toHaveCount(1)
  await expect(page.locator(BAR), 'a desktop does not show the buttons').toBeHidden()
  await expect(page.locator(ABOVE), 'nor the row above a keyboard').toBeHidden()
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false)
  // (typed: an untyped <input> in an item is the app's image upload; the textarea in a box of
  // class `editor` is a widget of the item's own, built as the app's editors are)
  await page.evaluate(([root, list, field]) => [`${root} a fixture`, `${root}/1 a fixture`, `${root}/2 a fixture`, list, `${field} a fixture\n\n<input type="text" id="e2e_keys_field">\n\n<div class="editor"><textarea id="widget-notes"></textarea></div>`].forEach(text => void window._create(text)), [ROOT, TEXT, FIELD])
  await expect.poll(() => page.evaluate(labels => labels.every(label => !!window._item(label, true)?.saved_id), [ROOT, `${ROOT}/1`, `${ROOT}/2`, LIST, FIELD]), { timeout: 30_000 }).toBe(true)

  // (b) a phone, the same account: the row is drawn at the page's welcome, and shown
  const context = await browser.newContext(PHONE)
  const phone = await context.newPage()
  await loadAdmin(phone)
  const bar = phone.locator(BAR)
  const above = phone.locator(ABOVE)
  await expect(bar).toBeVisible()
  await expect(above, 'no keyboard is up').toBeHidden()
  const LOOK: Look = await phone.evaluate(() => (window._item('#key_buttons', true) as any).eval('KEY_BUTTONS_LOOK'))
  const look = await phone.evaluate(([selector, color]) => {
    const bar = document.querySelector(selector)!
    const header = document.querySelector('.header')!.getBoundingClientRect()
    const row = bar.getBoundingClientRect()
    // the look's color as the browser computes one
    const probe = document.body.appendChild(Object.assign(document.createElement('span'), { style: `color: ${color}` }))
    const colored = getComputedStyle(probe).color
    probe.remove()
    return {
      names: Array.from(bar.children, button => (button as HTMLElement).dataset.key),
      // each button: a circle of its size whose centre is its own, so nothing of the page covers it
      buttons: Array.from(bar.children, button => {
        const box = button.getBoundingClientRect()
        const style = getComputedStyle(button)
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return [box.width, box.height, style.borderRadius, style.color == colored, hit === button || button.contains(hit)]
      }),
      right: innerWidth - row.right,
      bottom: innerHeight - row.bottom,
      left: row.left >= 0,
      clear: header.bottom < row.top, // the MindBox, its buttons and the status line are far above
      labelled: Array.from(bar.children).every(button => !!button.getAttribute('aria-label') && !!button.querySelector('svg')),
    }
  }, [BAR, LOOK.color])
  expect(look).toEqual({ names: NAMES, buttons: NAMES.map(() => [LOOK.size, LOOK.size, '50%', true, true]), right: LOOK.right, bottom: LOOK.bottom, left: true, clear: true, labelled: true })

  // (c) the arrows, by the keys and by the buttons
  const steps = [`${ROOT}/1`, `${ROOT}/2`, `${ROOT}/1`, `${ROOT}/2`, ROOT]
  expect(await walk(phone, key(phone)), 'the keys').toEqual(steps)
  expect(await walk(phone, tap(phone)), 'the buttons').toEqual(steps)

  // (d) the create key, from the window and in the editor it opens
  expect(await reply(phone, key(phone), `${ROOT}/1`)).toBe(`${ROOT}/1/0`)
  expect(await reply(phone, tap(phone), `${ROOT}/2`)).toBe(`${ROOT}/2/0`)

  // (e) the scrolls
  await name(phone, ROOT)
  await scrolls(phone, key(phone))
  await scrolls(phone, tap(phone))

  // (f) an editor of an item with a bulleted line, opened by the window's Enter on the named item
  await name(phone, LIST)
  await phone.keyboard.press('Enter')
  const id = await phone.evaluate(label => window._item(label, true)!.id, LIST)
  const editor = phone.locator(`#textarea-${id}`)
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue(TEXT)
  await phone.evaluate(id => (textarea => textarea.setSelectionRange(textarea.value.length, textarea.value.length))(document.getElementById('textarea-' + id) as HTMLTextAreaElement), id)
  // what the real keys do there: Tab indents the caret's line, Shift+Tab takes the indent back
  const INDENTED = `${LIST}\n- one\n  - two`
  await phone.keyboard.press('Tab')
  await expect(editor).toHaveValue(INDENTED)
  await phone.keyboard.press('Shift+Tab')
  await expect(editor).toHaveValue(TEXT)
  // the editor low in the window, its last line where the keyboard will be
  const editorBottom = () => phone.evaluate(id => document.getElementById('textarea-' + id)!.getBoundingClientRect().bottom, id)
  await phone.evaluate(id => document.body.scrollBy(0, document.getElementById('textarea-' + id)!.getBoundingClientRect().bottom - (window.innerHeight - 44)), id)
  await expect.poll(async () => Math.abs((await editorBottom()) - (PHONE.viewport.height - 44)) <= 1, { message: 'the editor near the window\'s bottom' }).toBe(true)
  // the keyboard comes up: the main row hides, and the keyboard's row shows just above the
  // keyboard, from the visual viewport; nothing scrolls, though the caret's line is under the
  // keyboard (the caret's scroll is switched off in the item's table)
  const view = PHONE.viewport.height - KEYBOARD_PX
  expect(await keyboard(phone, 'up')).toEqual([view, PHONE.viewport.height])
  await expect(bar, 'hidden while the keyboard is up').toBeHidden()
  await expect(above).toBeVisible()
  await expect(phone.locator(RELOAD), 'the reload button too').toBeHidden()
  expect(await rowLook(phone, ABOVE)).toEqual({ names: ABOVE_NAMES, buttons: ABOVE_NAMES.map(() => [LOOK.size, LOOK.size, true]), right: PHONE.viewport.width - LOOK.edge, bottom: view - LOOK.above })
  await phone.waitForTimeout(500) // past every wait of the item's
  // (the editor's place in the window is the witness: off iOS the app resizes its padding with the
  // view and corrects the scroll by as much, so the scroll position changes while nothing moves)
  expect(Math.abs((await editorBottom()) - (PHONE.viewport.height - 44)) <= 2, 'the keyboard moved nothing: the editor\'s last line is where it was, under the keyboard').toBe(true)
  await expect(editor, 'the editor keeps the focus').toBeFocused()
  // its Tab and Shift+Tab are the keys', and the editor keeps its focus (and so its keyboard)
  const press = tap(phone, ABOVE)
  await press('indent')
  await expect(editor).toHaveValue(INDENTED)
  await expect(editor, 'a tap on the row takes no focus').toBeFocused()
  await press('outdent')
  await expect(editor).toHaveValue(TEXT)
  await expect(editor).toBeFocused()
  // Shift+Space is a Tab on this device: the line is indented and no space is typed
  await phone.keyboard.press('Shift+Space')
  await expect(editor).toHaveValue(INDENTED)
  // its Shift+Enter is the editor's own: the item saved as typed, the editor closed
  await press('done')
  await expect.poll(() => phone.evaluate(label => [(window._item(label, true) as any).editing, window._item(label, true)!.text] as const, LIST), { message: 'saved by the row\'s Shift+Enter' }).toEqual([false, INDENTED])
  // no field has the focus now: no keyboard is read, though the view is still short, and the main row is back
  await expect(bar, 'the main row with nothing focused').toBeVisible()
  await expect(above).toBeHidden()
  expect(await keyboard(phone, 'down')).toEqual([PHONE.viewport.height, PHONE.viewport.height])
  // a window whose own height follows the keyboard (what the owner's phone may have done once):
  // the window's signal reads nothing, the view against the tallest seen reads the keyboard
  await phone.locator('.header .backdrop').first().click()
  await expect(phone.locator('#textarea-mindbox')).toBeFocused()
  expect(await keyboard(phone, 'follows')).toEqual([view, view])
  await expect(above, 'the keyboard\'s row by the view alone').toBeVisible()
  await expect(bar).toBeHidden()
  expect((await rowLook(phone, ABOVE)).bottom).toBe(view - LOOK.above)
  // a tap is asked again whom it is for. the focus gone from the box and the row still showing
  // (the item looks again 150 ms after a focus leaves), Done sends nothing: the window's own
  // Shift+Enter would make a child of the item the MindBox names
  const count = () => phone.evaluate(() => (window as any)._items().length as number)
  const items = await count()
  const left = await phone.evaluate(done => {
    const button = document.querySelector(done) as HTMLElement
    ;(document.activeElement as HTMLElement).blur()
    const state = [document.activeElement === document.body, !button.parentElement!.hidden]
    button.click()
    return state
  }, `${ABOVE} > button[data-key="done"]`)
  expect(left, 'the focus gone, the row still showing at the click').toEqual([true, true])
  await phone.waitForTimeout(400) // past the item's look, and whatever a sent key would have started
  expect([await count(), (await query(phone)).trim()], 'nothing sent: no item made, the MindBox as it was').toEqual([items, LIST])
  await expect(bar, 'the item\'s look after the focus left: no keyboard, the main row').toBeVisible()
  expect(await keyboard(phone, 'down')).toEqual([PHONE.viewport.height, PHONE.viewport.height])
  await expect(above, 'hidden once the keyboard is down').toBeHidden()
  await expect(bar, 'shown again').toBeVisible()
  await blur(phone)
  // a field that is no editor of the app: an input embedded in an item, and a textarea of the
  // item's own markup in a box of class `editor` (a widget built as the app's editors are, which
  // the app names neither `textarea-mindbox` nor after an item being edited). Its keyboard hides
  // the main row and the reload button, as any keyboard does, and no row is offered above it:
  // the row's keys are the app's editors', and a Shift+Enter sent from this field would reach
  // the window and make an item of what the MindBox names. Nothing of the hidden row answers a
  // click either, and a Shift+Space is the field's own key: the item sends no Tab in its place
  // (whether a space is then typed is the app's affair: its window handler prevents the default
  // of every Space that reaches it). The field keeps its focus and the letters typed, the
  // MindBox its contents, and no item is made
  await name(phone, FIELD)
  for (const [selector, what] of [['#e2e_keys_field', 'an input'], ['#widget-notes', 'a textarea in a box of class editor']]) {
    const field = phone.locator(selector)
    await field.focus()
    await expect(field).toBeFocused()
    expect(await keyboard(phone, 'up')).toEqual([view, PHONE.viewport.height])
    await expect(bar, `the main row hides for any keyboard (${what})`).toBeHidden()
    await expect(phone.locator(RELOAD), 'and so does the reload button').toBeHidden()
    await expect(above, `no row above the keyboard of a field that is no editor of the app (${what})`).toBeHidden()
    await field.evaluate(element => {
      ;(window as any).__field_keys = []
      element.addEventListener('keydown', event => (window as any).__field_keys.push((event as KeyboardEvent).code))
    })
    await phone.keyboard.type('typed')
    await phone.keyboard.press('Shift+Space')
    await phone.keyboard.type('x')
    expect(await phone.evaluate(() => ((window as any).__field_keys as string[]).filter(code => code == 'Space' || code == 'Tab')), `its Shift+Space is the field's own key, and no Tab is sent in its place (${what})`).toEqual(['Space'])
    await phone.evaluate(done => (document.querySelector(done) as HTMLElement).click(), `${ABOVE} > button[data-key="done"]`)
    await phone.waitForTimeout(400) // past every wait of the item's, and whatever a sent key would have started
    await expect(above, `still no row (${what})`).toBeHidden()
    await expect(field, `the field keeps the focus (${what})`).toBeFocused()
    await expect(field, `and the letters typed (${what})`).toHaveValue(/^typed ?x$/)
    expect([(await query(phone)).trim(), await count()], 'the MindBox as it was, and no item made').toEqual([FIELD, items])
    expect(await keyboard(phone, 'down')).toEqual([PHONE.viewport.height, PHONE.viewport.height])
    await expect(bar, 'the main row again, the keyboard down').toBeVisible()
    await blur(phone)
  }
  // a desktop's Shift+Space is a space, as typed
  await page.evaluate(() => (window as any).MindBox.set(''))
  await page.locator('.header .backdrop').first().click()
  await expect(page.locator('#textarea-mindbox')).toBeFocused()
  await page.keyboard.type('x')
  await page.keyboard.press('Shift+Space')
  await expect(page.locator('#textarea-mindbox')).toHaveValue('x ')
  await page.evaluate(() => (window as any).MindBox.set(''))

  // (g) the reload button: the mirror of the sparkle's box, on the desktop page and on the phone
  const reloadBox = (target: Page) => target.evaluate(selector => (box => [box.x, window.innerHeight - box.bottom, box.width, box.height])(document.querySelector(selector)!.getBoundingClientRect()), RELOAD)
  await expect(page.locator(RELOAD), 'on a desktop too').toBeVisible()
  expect(await reloadBox(page)).toEqual(SPARKLE)
  await expect(phone.locator(RELOAD)).toBeVisible()
  expect(await reloadBox(phone)).toEqual(SPARKLE)
  expect(await phone.evaluate(selector => getComputedStyle(document.querySelector(selector)!).color, RELOAD), 'dim, as the idle sparkle is').toBe('rgba(255, 255, 255, 0.45)')
  const [row, button] = [(await bar.boundingBox())!, (await phone.locator(RELOAD).boundingBox())!]
  expect(row.x - (button.x + button.width), 'clear of the main row at this width').toBeGreaterThanOrEqual(LOOK.gap)
  // a tap reloads the page, through the app's own reload (window._reload): at once while nothing
  // is unsaved, one tap and no question
  const seen: string[] = [] // the browser's own dialogs: none is expected (one that comes is accepted, and told below)
  phone.on('dialog', dialog => {
    seen.push(dialog.type())
    void dialog.accept()
  })
  let loads = 0
  phone.on('load', () => loads++)
  const started = () => phone.evaluate(() => window._init_time)
  const reload = async () => {
    const box = (await phone.locator(RELOAD).boundingBox())!
    await phone.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  }
  const reloaded = async (since: number) => {
    await expect.poll(() => phone.evaluate(since => window._init_time > since && window._readonly === false, since).catch(() => false), { message: 'the page loaded again', timeout: 90_000 }).toBe(true)
    await waitForApp(phone)
  }
  const unsaved = () => phone.evaluate(() => ((window as any).__items as { text: string; savedText: string; editing: boolean; saving: boolean }[]).some(item => item.text != item.savedText || item.editing || item.saving))
  await expect.poll(unsaved, { message: 'nothing unsaved' }).toBe(false)
  expect(await phone.evaluate(() => typeof (window as any)._reload), 'the app has a reload of its own').toBe('function')
  let since = await started()
  await reload()
  await reloaded(since)
  expect([loads, seen], 'one reload by the one tap, and nothing asked').toEqual([1, []])
  await expect(bar, 'the rows drawn again at the page\'s welcome').toBeVisible()
  // an open edit: text typed into a saved item's editor, then the keyboard dismissed (the button
  // hides under a keyboard)
  await name(phone, LIST)
  await phone.keyboard.press('Enter')
  await expect(editor).toBeFocused()
  expect(await keyboard(phone, 'up')).toEqual([view, PHONE.viewport.height])
  await expect(phone.locator(RELOAD), 'no reload button under a keyboard').toBeHidden()
  await phone.keyboard.type(' typed and not saved')
  const typed = await editor.inputValue()
  expect(typed, 'the editor holds text its item does not').not.toBe(INDENTED)
  await blur(phone)
  expect(await keyboard(phone, 'down')).toEqual([PHONE.viewport.height, PHONE.viewport.height])
  await expect(phone.locator(RELOAD)).toBeVisible()
  const edit = () => phone.evaluate(([label, id]) => [(window._item(label, true) as any).editing, window._item(label, true)!.text, (document.getElementById('textarea-' + id) as HTMLTextAreaElement | null)?.value] as const, [LIST, id] as const)
  const modal = phone.locator('.modal')
  since = await started()
  // Reload asks first, in the app's dialog; cancelled, nothing is reloaded and the typed text is there
  await reload()
  await expect(modal, 'Reload asks first, in the app\'s dialog').toContainText(QUESTION)
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await phone.waitForTimeout(500) // a reload would have started by now
  expect([await started(), await edit(), loads, seen], 'cancelled: the page and the typed text stay').toEqual([since, [true, INDENTED, typed], 1, []])
  // on an app that predates its own reload (the released one) the item asks before EVERY reload,
  // in the app's dialog and in words of its own: it cannot know there what would be lost. The
  // open edit first
  await phone.evaluate(() => {
    ;(window as any).__app_reload = (window as any)._reload
    delete (window as any)._reload
  })
  await reload()
  await expect(modal, 'on an app without a reload of its own the item asks').toContainText(ASKS)
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await phone.waitForTimeout(500)
  expect([await started(), await edit(), loads, seen], 'cancelled on an app without a reload of its own: the page and the typed text stay').toEqual([since, [true, INDENTED, typed], 1, []])
  // then the draft its owner has just KEPT: the item's close button, and Cancel in the app's
  // question about the discard. The app has copied the draft into the item's text by then: the
  // item and its editor agree and nothing is being saved, which reads as clean through an item's
  // handles and is a draft that a reload loses. The keyboard dismissed, Reload asks all the same
  await phone.locator(`[data-item-id="${id}"] .edit-menu .button.cancel`).click()
  await expect(modal, 'the app asks about the discard').toContainText('Discard unsaved changes to')
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await blur(phone)
  const kept = typed.replace(/\u200B/g, '')
  const record = () => phone.evaluate(id => ((item: any) => [!!item.saving, item.savedText])(((window as any).__items as any[]).find(item => item.id == id)), id)
  expect([await edit(), await record()], 'the draft kept: in the item\'s text and in its editor alike, nothing being saved, the saved text the old one').toEqual([[true, kept, typed], [false, INDENTED]])
  await reload()
  await expect(modal, 'the item asks before a reload that would lose the draft its owner kept').toContainText(ASKS)
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await phone.waitForTimeout(500)
  expect([await started(), await edit(), loads, seen], 'cancelled: the page and the kept draft stay').toEqual([since, [true, kept, typed], 1, []])
  await phone.evaluate(() => void ((window as any)._reload = (window as any).__app_reload))
  // confirmed: the page reloads once, with no question of the browser's on top of the app's, and
  // the edit is gone with the page
  await reload()
  await expect(modal, 'Reload asks again').toContainText(QUESTION)
  await modal.locator('.button.confirm').click()
  await reloaded(since)
  expect([loads, seen], 'one reload, and no second question').toEqual([2, []])
  expect(await phone.evaluate(label => [(window._item(label, true) as any).editing, window._item(label, true)!.text] as const, LIST), 'the item as it was saved').toEqual([false, INDENTED])
  await expect(bar).toBeVisible()
  // a save that is not finished. The item's text is saved as B while its write is held at the
  // network; then the text is put back to A and saved again, which waits behind the first write
  // in the page alone. The item's three texts all say A now and nothing reads as unsaved, yet a
  // reload here would leave B at the server: Reload asks, and cancelled, the page stays until
  // the write for A has gone out
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  await phone.route(WRITES, async route => {
    if (route.request().method() == 'POST') await gate
    await route.continue()
  })
  await name(phone, LIST)
  await phone.keyboard.press('Enter')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue(INDENTED)
  await phone.evaluate(id => (textarea => textarea.setSelectionRange(textarea.value.length, textarea.value.length))(document.getElementById('textarea-' + id) as HTMLTextAreaElement), id)
  const [A, B] = [INDENTED, INDENTED + 'B']
  const saves = () => phone.evaluate(id => ((item: any) => ({ text: item.text, saved: item.savedText, editor: item.editorText, saving: !!item.saving, out: (item.unackedWrites ?? []).map((write: any) => write.text), waiting: !!item.saveTask }))(((window as any).__items as any[]).find(item => item.id == id)), id)
  await phone.keyboard.type('B')
  await phone.keyboard.press('Control+s')
  await expect.poll(saves, { message: 'B saved: its write is out, and held' }).toEqual({ text: B, saved: A, editor: B, saving: true, out: [B], waiting: true })
  await phone.keyboard.press('Backspace')
  await expect(editor).toHaveValue(A)
  await phone.keyboard.press('Control+s')
  await expect.poll(saves, { message: 'A saved again: all three texts say A, the write for B is still out, the save of A waits behind it' }).toEqual({ text: A, saved: A, editor: A, saving: true, out: [B], waiting: true })
  await blur(phone)
  since = await started()
  await reload()
  await expect(modal, 'Reload asks while a save is not finished').toContainText(QUESTION)
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await phone.waitForTimeout(500)
  expect([await started(), loads, seen], 'cancelled: the page stays').toEqual([since, 2, []])
  // the write let go: B goes out, then A, and the page has nothing left to save
  release()
  await expect.poll(saves, { message: 'both writes acknowledged', timeout: 30_000 }).toEqual({ text: A, saved: A, editor: A, saving: false, out: [], waiting: false })
  await phone.unroute(WRITES)
  const stored = await phone.evaluate(label => window._item(label, true)!.saved_id as string, LIST)
  const sent = async () => (await firestore().collection('history').where('item', '==', stored).get()).docs.map(entry => entry.data()).sort((a, b) => a.time - b.time).slice(-2).map(entry => entry.text)
  await expect.poll(sent, { message: 'the server was sent B, then A', timeout: 30_000 }).toEqual([B, A])
  expect((await firestore().collection('items').doc(stored).get()).data()?.text, 'and it holds A').toBe(A)
  // the editor closed, with nothing to discard: the page is clean again
  await phone.locator(`[data-item-id="${id}"] .edit-menu .button.cancel`).click()
  await expect.poll(unsaved, { message: 'nothing unsaved, nothing edited' }).toBe(false)
  await expect(bar).toBeVisible()
  // and on an app without a reload of its own this clean page is asked about too: every time
  await phone.evaluate(() => {
    ;(window as any).__app_reload = (window as any)._reload
    delete (window as any)._reload
  })
  await reload()
  await expect(modal, 'on an app without a reload of its own a clean page is asked about too').toContainText(ASKS)
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await phone.waitForTimeout(500)
  expect([await started(), loads, seen], 'cancelled: the clean page stays').toEqual([since, 2, []])
  await phone.evaluate(() => void ((window as any)._reload = (window as any).__app_reload))

  // (h) the task's look at the LIVE item retires nothing (it retires a controller whose code is
  // no longer the item's, by the item's hash as the app gives it then): more than one period of
  // the task after the install, the desktop page has a controller that is not disposed, and its
  // button is drawn. (That it is the very controller drawn at the install is not asserted.)
  const period = await page.evaluate(() => (window._item('#key_buttons', true) as any).eval('KEY_BUTTONS_TICK_MS') as number)
  await expect.poll(() => Date.now() - installed, { message: 'a period of the task since the install', timeout: period + 30_000 }).toBeGreaterThan(period + 2_000)
  expect(await page.evaluate(() => (window as any)._key_buttons?.disposed), 'the page has a live controller after a period of the task').toBe(false)
  await expect(page.locator(RELOAD), 'and its button is drawn').toBeVisible()
  // the item deleted: its rows and its button go at its task's next look, in this tab and in the other
  await phone.evaluate(() => window._item('#key_buttons', true)!.delete(false))
  await expect(bar).toHaveCount(0, { timeout: 30_000 })
  await expect(above).toHaveCount(0)
  await expect(phone.locator(RELOAD)).toHaveCount(0)
  await expect(page.locator(`${BAR}, ${ABOVE}, ${RELOAD}`)).toHaveCount(0, { timeout: 30_000 })
  await context.close()
})
