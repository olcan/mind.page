import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import { firestore, install, loadAdmin, waitForApp, waitWritesSettled } from './helpers.js'

// pictures of the strip states, written only where KEY_BUTTONS_SHOTS names a directory for them
const SHOTS = process.env.KEY_BUTTONS_SHOTS
const shot = async (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), ...(clip ? { clip } : {}) })
}

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
// button, on the desktop page and on the phone: beside the #vault item's sparkle at the lower right
// on a desktop, and at the lower left on a phone (the sparkle's mirror; no sparkle is drawn in this
// lane), clear of the main row, hidden while the
// keyboard is up; a tap reloads the page at once while nothing would be lost; with text typed
// into an item's editor it asks first, in the app's dialog: cancelled, the page and the typed
// text stay, and confirmed, the page reloads once with no question of the browser's on top; on
// an app without a reload of its own (the released one) the item asks before EVERY reload, the
// one after its owner kept a draft included (the item's close button, then Cancel: an open edit
// like any other since 2026-11-24, before that a state that read as clean through an item's
// handles), and a clean page's; with a save that is not finished (a write held
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
const NAV = '#e2e_nav' // small tree for the navigation-arrow lights, desktop strip and backdrop row
const LIST = '#e2e_keys_list' // an item with a bulleted line, for the Tab
const FIELD = '#e2e_keys_field' // an item with a field of its own, which is no editor of the app
const QUESTION = 'Reload and discard unsaved changes?' // the app's, where something would be lost
const ASKS = 'Reload and discard any unsaved changes?' // the item's own, on an app without a reload of its own
const WRITES = /Firestore\/Write\/channel/ // the requests of the Firestore client's writes (its Listen stream is another)
const TEXT = `${LIST}\n- one\n- two`
const BAR = '[data-key-buttons="bar"]'
const ABOVE = '[data-key-buttons="keyboard"]'
const RELOAD = '[data-key-buttons="reload"]'
const NAV_STRIP = '[data-key-buttons="nav-strip"]'
const NAV_V = '[data-key-buttons="nav-vertical"]'
const NAV_H = '[data-key-buttons="nav-horizontal"]'
const BACKDROP = '[data-key-buttons="backdrop"]'
const KEYBOARD_PX = 336 // what the simulated keyboard takes of the window's height
// the two rows' keys, in the rows' order, named here outright: a key of the item's table that
// is changed is then a walk, a save or a row below that fails, and nothing here reads how the
// item's code is spelled
const NAMES = ['top', 'back', 'create', 'left', 'up', 'down', 'right']
const STRIP_NAMES = ['top', 'back', 'left', 'up', 'down', 'right', 'create']
const STRIP_KEYS: [string, string][] = [
  ['top', 'Ctrl+Alt+Up'],
  ['back', 'Ctrl+Alt+Down'],
  ['left', 'Left'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['right', 'Right'],
  ['create', 'Shift+Enter'],
]
const ABOVE_NAMES = ['outdent', 'indent', 'done']
// the #vault item's sparkle: 14 px from the right edge, 10 px from the bottom, 24 px wide and
// high (the reload button is its mirror at the left). The numbers are its rule's in vault.md;
// the items' own table (mind.items tests/key_buttons_test.js) holds the button's to that rule
const SPARKLE = [14, 10, 24, 24]
// the item's table of the look (sizes, places, a color), read from the installed item on the
// page: a number changed there is what (b) expects, with none repeated here
type Look = {
  size: number
  gap: number
  group: number
  right: number
  bottom: number
  color: string
  valid: string
  dim: number
  above: number
  edge: number
  reload: { size: number; left: number; bottom: number; icon: number }
  backdrop: { fill: string; blur: string; border: string; shadow: string; shadow_blur: number; merge: number }
}
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

  // (g) the reload button: beside the sparkle on a desktop (24 px), and the row's size (32 px) on a phone,
  // centred on the same point as the desktop corner button
  const reloadBox = (target: Page) => target.evaluate(selector => (box => [box.x, window.innerHeight - box.bottom, box.width, box.height])(document.querySelector(selector)!.getBoundingClientRect()), RELOAD)
  const desktopReloadBox = (target: Page) => target.evaluate(selector => (box => [window.innerWidth - box.right, window.innerHeight - box.bottom, box.width, box.height])(document.querySelector(selector)!.getBoundingClientRect()), RELOAD)
  await expect(page.locator(RELOAD), 'on a desktop too').toBeVisible()
  expect(await desktopReloadBox(page), 'desktop reload button sits a group gap left of the sparkle').toEqual([SPARKLE[0] + SPARKLE[2] + LOOK.group, SPARKLE[1], SPARKLE[2], SPARKLE[3]])
  await expect(phone.locator(RELOAD)).toBeVisible()
  const touchGrow = (LOOK.size - SPARKLE[2]) / 2
  expect(await reloadBox(phone), 'touch reload button matches row size (32 px), centred on desktop corner point').toEqual([SPARKLE[0] - touchGrow, SPARKLE[1] - touchGrow, LOOK.size, LOOK.size])
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
  await expect(modal.locator('.unsaved-items li'), 'and names what would be lost: the item with the typed text').toHaveText([`${LIST} (being edited)`])
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
  // question about the discard. Asking copies nothing (since 2026-11-24; before, the app had copied
  // the draft into the item's text by then, which read as clean through an item's handles): the
  // item's text is the saved one and its editor holds the draft, as in any open edit, nothing is
  // being saved, and a reload loses the draft. The keyboard dismissed, Reload asks all the same
  await phone.locator(`[data-item-id="${id}"] .edit-menu .button.cancel`).click()
  await expect(modal, 'the app asks about the discard').toContainText('Discard unsaved changes to')
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await blur(phone)
  const record = () => phone.evaluate(id => ((item: any) => [!!item.saving, item.savedText])(((window as any).__items as any[]).find(item => item.id == id)), id)
  expect([await edit(), await record()], 'the draft kept: in its editor alone, the item\'s text and the saved text the old one, nothing being saved').toEqual([[true, INDENTED, typed], [false, INDENTED]])
  await reload()
  await expect(modal, 'the item asks before a reload that would lose the draft its owner kept').toContainText(ASKS)
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await phone.waitForTimeout(500)
  expect([await started(), await edit(), loads, seen], 'cancelled: the page and the kept draft stay').toEqual([since, [true, INDENTED, typed], 1, []])
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
  await expect(modal.locator('.unsaved-items li'), 'and names the item whose save is not finished').toHaveText([`${LIST} (being saved)`])
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await phone.waitForTimeout(500)
  expect([await started(), loads, seen], 'cancelled: the page stays').toEqual([since, 2, []])
  // the browser's own box in this state. nothing of this item reads as unsaved (its three texts say A),
  // so the box is asked for by ANOTHER item's unsaved text, and a page that is kept then lists both: the
  // list after the box names a save that is not finished too, as the app's own question above does
  await phone.evaluate(root => void ((window.__items as any[]).find(item => item.labelText == root).text += ' (changed)'), ROOT)
  expect(
    await phone.evaluate(() => {
      const event = document.createEvent('BeforeUnloadEvent')
      event.initEvent('beforeunload', false, true)
      window.dispatchEvent(event)
      return event.returnValue
    }),
    'the box is asked for'
  ).toBe('Discard unsaved changes?')
  await expect(modal.locator('.unsaved-items'), 'the kept page lists what the box was about').toBeVisible({ timeout: 10_000 })
  expect((await modal.locator('.unsaved-items li').allTextContents()).sort(), 'the unsaved text, and the save that is not finished').toEqual([`${ROOT} (not saved)`, `${LIST} (being saved)`].sort())
  await modal.locator('.button.confirm', { hasText: /^OK$/ }).click()
  await expect(modal).toBeHidden()
  await phone.evaluate(root => void ((item: any) => (item.text = item.savedText))((window.__items as any[]).find(item => item.labelText == root)), ROOT)
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

// navigation-arrow lights (green when valid, dim when not), always-shown desktop strip at the
// lower right (three groups + reload beside the sparkle), tooltips, strip clicks and editing
// guard, live updates on box and item changes, frosted-glass backdrop (one rounded right piece on
// wide desktop, full strip below 480 px and on a phone, pointer-events pass-through), and phone parity
test('navigation arrows light green or dim live, stay in place on desktop with frosted backdrop, and match on a phone', async ({ page, browser }) => {
  await loadAdmin(page)
  if (await page.evaluate(() => !!window._item('#key_buttons', true))) {
    // warm emulator: update #key_buttons from the local mind.items checkout so a rerun never tests
    // an older copy of the item
    let out: string | null | undefined
    const result = page
      .evaluate(
        text =>
          Promise.resolve(window._create(text, { command: true, return_alerts: true })).then(out =>
            typeof out == 'string' ? out : null
          ),
        '/_update key_buttons'
      )
      .then(r => (out = r))
    const settledOr = (button: string) => async () =>
      out !== undefined || (await page.locator('.modal').getByText(button, { exact: true }).isVisible())
    await expect.poll(settledOr('OK'), { message: '/_update key_buttons', timeout: 120_000 }).toBe(true)
    if (out === undefined) {
      await page.locator('.modal').getByText('OK', { exact: true }).click()
      await expect.poll(settledOr('Skip'), { message: '/_update key_buttons after OK', timeout: 30_000 }).toBe(true)
      if (out === undefined) await page.locator('.modal').getByText('Skip', { exact: true }).click()
      await result
    }
    expect(out ?? null, '/_update key_buttons on warm emulator succeeded').toBeNull()
  } else {
    expect(await install(page, 'key_buttons'), '/_install key_buttons').toBeNull()
  }
  await waitWritesSettled(page, '#key_buttons')
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any)._key_buttons?.disposed === false &&
            (window as any)._key_buttons?.code === (window._item('#key_buttons', true) as any)?.deephash
        ),
      { message: '#key_buttons controller reconciled to current item code', timeout: 10_000 }
    )
    .toBe(true)
  const navRoot = `${NAV}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const editRoot = `${navRoot}_edit`
  const tree = [navRoot, `${navRoot}/a`, `${navRoot}/a/0`, `${navRoot}/b`, editRoot]
  await page.evaluate(labels => labels.forEach(label => void window._create(`${label} a nav fixture`)), tree)
  await expect
    .poll(() => page.evaluate(labels => labels.every(l => !!window._item(l, true)?.saved_id), ['#key_buttons', ...tree]), { message: 'nav fixtures and #key_buttons saved', timeout: 30_000 })
    .toBe(true)

  const LOOK: Look = await page.evaluate(() => (window._item('#key_buttons', true) as any).eval('KEY_BUTTONS_LOOK'))
  await expect(page.locator(NAV_STRIP), 'desktop nav strip visible').toBeVisible()
  await expect(page.locator(NAV_V), 'no old vertical desktop group on the page').toHaveCount(0)
  await expect(page.locator(NAV_H), 'no old horizontal desktop group on the page').toHaveCount(0)
  await expect(page.locator(RELOAD), 'reload button visible').toBeVisible()

  // read icon state purely from computed styles (svg stroke colour + opacity), never class names
  const arrowLooks = (target: Page, selectors: string[]) =>
    target.evaluate(
      ([sels, validColor, baseColor, dimOpacity]) => {
        const rgb = (c: string) => {
          const s = document.body.appendChild(Object.assign(document.createElement('span'), { style: `color: ${c}` }))
          const out = getComputedStyle(s).color
          s.remove()
          return out
        }
        const [green, white] = [rgb(validColor), rgb(baseColor)]
        const out: Record<string, string> = {}
        for (const sel of sels) {
          for (const btn of Array.from(document.querySelectorAll(`${sel} > button[data-key]`))) {
            const key = (btn as HTMLElement).dataset.key!
            if (!['left', 'up', 'down', 'right'].includes(key)) continue
            const s = getComputedStyle(btn.querySelector('svg')!)
            const op = Number(s.opacity)
            out[key] =
              s.stroke == green && op == 1
                ? 'green'
                : s.stroke == white && Math.abs(op - dimOpacity) < 0.01
                  ? 'dim'
                  : `${s.stroke}@${s.opacity}`
          }
        }
        return out
      },
      [selectors, LOOK.valid, LOOK.color, LOOK.dim] as const
    )

  const nonArrowLooks = (target: Page, rowSel: string) =>
    target.evaluate(
      ([sel, baseColor]) => {
        const probe = document.body.appendChild(Object.assign(document.createElement('span'), { style: `color: ${baseColor}` }))
        const white = getComputedStyle(probe).color
        probe.remove()
        return ['top', 'back', 'create'].map(k => {
          const s = getComputedStyle(document.querySelector(`${sel} > button[data-key="${k}"] > svg`)!)
          return [k, s.stroke == white, Number(s.opacity)]
        })
      },
      [rowSel, LOOK.color] as const
    )

  // positions and gaps of the seven-button desktop strip and the reload button beside the sparkle
  const desktopLayout = () =>
    page.evaluate(
      ([reloadSel, stripSel]) => {
        const r = document.querySelector(reloadSel)!.getBoundingClientRect()
        const btns = Array.from(document.querySelectorAll(`${stripSel} > button`)) as HTMLElement[]
        const boxes = btns.map(b => b.getBoundingClientRect())
        const gaps: number[] = []
        for (let i = 1; i < boxes.length; i++) gaps.push(Math.round(boxes[i].x - (boxes[i - 1].x + boxes[i - 1].width)))
        gaps.push(Math.round(r.x - (boxes[boxes.length - 1].x + boxes[boxes.length - 1].width)))
        return {
          names: btns.map(b => b.dataset.key ?? ''),
          sameRowAndSize: boxes.every(
            box =>
              box.width > 0 &&
              box.height > 0 &&
              Math.round(box.y - r.y) === 0 &&
              Math.round(box.width) === Math.round(r.width) &&
              Math.round(box.height) === Math.round(r.height)
          ),
          reloadRight: Math.round(window.innerWidth - r.right),
          reloadBottom: Math.round(window.innerHeight - r.bottom),
          reloadSize: [Math.round(r.width), Math.round(r.height)],
          gaps,
        }
      },
      [RELOAD, NAV_STRIP] as const
    )

  const expectedReloadRight = SPARKLE[0] + SPARKLE[2] + LOOK.group
  const expectedGaps = [LOOK.gap, LOOK.group, LOOK.gap, LOOK.gap, LOOK.gap, LOOK.group, LOOK.group]
  const expectDesktopLayout = async (stage: string) => {
    const layout = await desktopLayout()
    expect(layout.names, `desktop strip has seven buttons in order top, back, left, up, down, right, create (${stage})`).toEqual(STRIP_NAMES)
    expect(
      [layout.reloadRight, layout.reloadBottom, layout.reloadSize],
      `desktop reload button sits a group gap left of the sparkle at the lower right (${stage})`
    ).toEqual([expectedReloadRight, SPARKLE[1], [SPARKLE[2], SPARKLE[3]]])
    expect(layout.sameRowAndSize, `desktop strip buttons share one row and circle size with reload (${stage})`).toBe(true)
    expect(
      layout.gaps,
      `desktop strip gaps: button gap inside groups, group gap between groups and before reload (${stage})`
    ).toEqual(expectedGaps)
  }

  const clickDesktop = async (btn: string) => {
    const box = (await page.locator(`${NAV_STRIP} > button[data-key="${btn}"]`).boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }
  const expectDesktop = (expected: Record<string, string>, msg: string) =>
    expect.poll(() => arrowLooks(page, [NAV_STRIP]), { message: msg, timeout: 3_000 }).toEqual(expected)

  // tooltips on the desktop strip: every button names its key, and back says "Scroll back down (Ctrl+Alt+Down)"
  const stripTitles = await page.evaluate(sel => {
    const out: Record<string, string> = {}
    for (const btn of Array.from(document.querySelectorAll(`${sel} > button[data-key]`)) as HTMLElement[]) {
      out[btn.dataset.key!] = btn.title
    }
    return out
  }, NAV_STRIP)
  expect(stripTitles.back, 'back button tooltip is Scroll back down (Ctrl+Alt+Down)').toBe('Scroll back down (Ctrl+Alt+Down)')
  expect(
    STRIP_NAMES.map(k => [k, /\(([^)]+)\)$/.exec(stripTitles[k] ?? '')?.[1] ?? '']),
    'each desktop strip button tooltip names its key'
  ).toEqual(STRIP_KEYS)

  // 1a & 1b. Desktop strip layout fixed + computed green/dim across empty, parent, child, grandchild
  await page.evaluate(() => (window as any).MindBox.set(''))
  await expectDesktop({ left: 'dim', up: 'dim', down: 'dim', right: 'dim' }, 'empty box dims all four desktop arrows')
  await expectDesktopLayout('empty box')
  expect(await nonArrowLooks(page, NAV_STRIP), 'non-arrow buttons in desktop strip never dim when box is empty').toEqual([
    ['top', true, 1],
    ['back', true, 1],
    ['create', true, 1],
  ])

  await name(page, navRoot)
  await expectDesktop({ left: 'dim', up: 'dim', down: 'green', right: 'dim' }, 'parent lights down green and dims the rest')
  await expectDesktopLayout('parent')

  await name(page, `${navRoot}/a`)
  await expectDesktop({ left: 'green', up: 'green', down: 'green', right: 'green' }, 'child with sibling and grandchild lights all four green')
  await expectDesktopLayout('child')
  expect(await nonArrowLooks(page, NAV_STRIP), 'non-arrow buttons in desktop strip never turn green on child').toEqual([
    ['top', true, 1],
    ['back', true, 1],
    ['create', true, 1],
  ])

  await name(page, `${navRoot}/a/0`)
  await expectDesktop({ left: 'dim', up: 'green', down: 'dim', right: 'dim' }, 'lone grandchild lights up green and dims the rest')
  await expectDesktopLayout('grandchild')

  // 1c. Clicking a green arrow moves as its key does; clicking a dim arrow still sends its key
  // (both a no-op case and a case where the app moves despite the dim light: Up on root clears box)
  await name(page, navRoot)
  await page.keyboard.press('ArrowDown')
  await shown(page, `${navRoot}/a`)
  await name(page, navRoot)
  await clickDesktop('down')
  await shown(page, `${navRoot}/a`)
  await clickDesktop('right')
  await shown(page, `${navRoot}/b`)
  await clickDesktop('left')
  await shown(page, `${navRoot}/a`)
  // the same with the MindBox genuinely FOCUSED (clicked via its backdrop, as a user does: an unfocused
  // editor's textarea is visibility: hidden, so locator.focus() bypasses Editor.svelte's visibility wrapper
  // and leaves document.activeElement on body) and its caret inside the name: there Editor.svelte stops
  // propagation on Left and Right, so a click's key must dispatch on document.body, not on the box
  await page.locator('.header .backdrop').first().click()
  await expect(page.locator('#textarea-mindbox'), 'MindBox textarea holds focus before desktop Right click').toBeFocused()
  await page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).setSelectionRange(1, 1))
  await clickDesktop('right')
  await expect.poll(async () => (await query(page)).trim(), { message: 'clicking green Right with the MindBox focused moves to the next sibling', timeout: 5_000 }).toBe(`${navRoot}/b`)
  await name(page, `${navRoot}/a`)
  await clickDesktop('down')
  await shown(page, `${navRoot}/a/0`)
  // dim no-op: Right on lone grandchild sends ArrowRight to window while box stays on grandchild
  await page.evaluate(() => {
    ;(window as any).__nav_keys = []
    ;(window as any).__nav_onkey = (e: KeyboardEvent) => (window as any).__nav_keys.push(e.code)
    window.addEventListener('keydown', (window as any).__nav_onkey)
  })
  await clickDesktop('right')
  const dimNoop = await page.evaluate(() => {
    window.removeEventListener('keydown', (window as any).__nav_onkey)
    return (window as any).__nav_keys as string[]
  })
  expect(dimNoop, 'clicking dim Right still dispatches ArrowRight').toEqual(['ArrowRight'])
  expect((await query(page)).trim(), 'box stays on grandchild after dim Right').toBe(`${navRoot}/a/0`)
  // green Up back to child, then to root; then dim Up on root clears the box (app moves despite dim)
  await clickDesktop('up')
  await shown(page, `${navRoot}/a`)
  await clickDesktop('up')
  await shown(page, navRoot)
  await expectDesktop({ left: 'dim', up: 'dim', down: 'green', right: 'dim' }, 'root has up dim before clicking it')
  await clickDesktop('up')
  await expect.poll(async () => (await query(page)).trim(), { message: 'clicking dim Up on root clears the box', timeout: 3_000 }).toBe('')
  await expectDesktop({ left: 'dim', up: 'dim', down: 'dim', right: 'dim' }, 'clearing box via dim Up dims all four')

  // 1c-edit. While ANY item is open for editing (including while a save of it is in flight, where
  // the route's ArrowUp cancellation asks no question and would discard newer typing), a real click
  // on a desktop arrow sends nothing and keeps the editor open with focus and the newer text; once
  // the editor closes, a click on Up works again as before. Naming the lone root `editRoot` ensures
  // Up is dim, no parent context exists, and no `.toggle.hide` intercepts ArrowUp ahead of the
  // window handler's `editingItems` cancellation path
  const editId = await page.evaluate(label => window._item(label, true)!.id, editRoot)
  const editOrig = await page.evaluate(label => window._item(label, true)!.text, editRoot)
  const editTextB = `${editOrig} B`
  const editTextC = `${editTextB} C`
  const editTextarea = page.locator(`#textarea-${editId}`)
  const editSaves = () =>
    page.evaluate(
      id =>
        ((it: any) => ({
          editing: !!it.editing,
          text: it.text,
          saved: it.savedText,
          saving: !!it.saving,
          out: (it.unackedWrites ?? []).map((w: any) => w.text),
        }))(((window as any).__items as any[]).find(it => it.id == id)),
      editId
    )
  let releaseEdit = () => {}
  const editGate = new Promise<void>(resolve => (releaseEdit = resolve))
  await page.route(WRITES, async route => {
    if (route.request().method() == 'POST') await editGate
    await route.continue()
  })
  try {
    await name(page, editRoot)
    await expectDesktop({ left: 'dim', up: 'dim', down: 'dim', right: 'dim' }, 'lone root dims all four arrows before opening its editor')
    await page.keyboard.press('Enter')
    await expect(editTextarea, 'item editor opens and takes focus before dim Up click').toBeFocused()
    await page.evaluate(id => {
      const ta = document.getElementById('textarea-' + id) as HTMLTextAreaElement
      ta.setSelectionRange(ta.value.length, ta.value.length)
    }, editId)
    await page.keyboard.type(' B')
    await page.keyboard.press('Control+s')
    await expect
      .poll(editSaves, { message: 'save of B is in flight and held at the network', timeout: 10_000 })
      .toEqual({ editing: true, text: editTextB, saved: editOrig, saving: true, out: [editTextB] })
    // collapse any session hide toggle so ArrowUp goes straight to the window handler's editingItems
    // cancellation path (index.svelte:12091) rather than being absorbed by a hide toggle
    for (let i = 0; i < 5 && (await page.locator('.toggle.hide').count()) > 0; i++) await page.locator('.toggle.hide').first().click()
    expect(await page.locator('.toggle.hide').count(), 'no hide toggle present before clicking dim Up while editing').toBe(0)
    await page.locator(`#super-container-${editId} .editor .backdrop`).first().click()
    await expect(editTextarea, 'item editor regains focus via its backdrop after collapsing hide toggle').toBeFocused()
    await page.evaluate(id => {
      const ta = document.getElementById('textarea-' + id) as HTMLTextAreaElement
      ta.setSelectionRange(ta.value.length, ta.value.length)
    }, editId)
    await page.keyboard.type(' C')
    await expect(editTextarea, 'editor holds newer text C while save of B is still in flight').toHaveValue(editTextC)
    await page.evaluate(() => {
      ;(window as any).__edit_keys = []
      ;(window as any).__edit_onkey = (e: KeyboardEvent) => (window as any).__edit_keys.push(e.code)
      window.addEventListener('keydown', (window as any).__edit_onkey)
    })
    let editKeys: string[] = []
    try {
      for (const btn of STRIP_NAMES) await clickDesktop(btn)
    } finally {
      editKeys = await page.evaluate(() => {
        window.removeEventListener('keydown', (window as any).__edit_onkey)
        const out = (window as any).__edit_keys as string[]
        delete (window as any).__edit_keys
        delete (window as any).__edit_onkey
        return out
      })
    }
    expect(
      editKeys,
      'clicking none of the seven desktop strip buttons dispatches any key while an item is open for editing'
    ).toEqual([])
    expect(
      await page.evaluate(id => (window._item(id, true) as any).editing, editId),
      'clicking all seven strip buttons while an item editor is open with a save in flight keeps the editor open'
    ).toBe(true)
    await expect(editTextarea, 'clicking all seven strip buttons while an item editor is open keeps the newer typed text').toHaveValue(editTextC)
    await expect(editTextarea, 'clicking all seven strip buttons while an item editor is open keeps focus in the editor').toBeFocused()
    await expect(page.locator('.modal'), 'clicking all seven strip buttons while an item editor is open shows no dialog').toBeHidden()
  } finally {
    releaseEdit()
    await page.unroute(WRITES)
  }
  await expect
    .poll(() => editSaves().then(s => [s.saving, s.out.length]), { message: 'held write of B settles after release', timeout: 30_000 })
    .toEqual([false, 0])
  await expect(editTextarea, 'editor still holds focus before saving and closing').toBeFocused()
  await page.keyboard.press('Shift+Enter')
  await expect
    .poll(() => editSaves().then(s => [s.editing, s.saving, s.text]), { message: 'editor saves newer text C and closes cleanly', timeout: 30_000 })
    .toEqual([false, false, editTextC])
  await name(page, navRoot)
  await expectDesktop({ left: 'dim', up: 'dim', down: 'green', right: 'dim' }, 'root has up dim after editor closes')
  await clickDesktop('up')
  await expect.poll(async () => (await query(page)).trim(), { message: 'with no item open for editing, clicking dim Up on root still clears the box', timeout: 3_000 }).toBe('')

  // 1c-strip. Clicking top, back and create on the desktop strip each act as their key does:
  // top and back scroll to the top and back down with the history entry, and create opens a new
  // child item under the named item with its editor focused
  await expect
    .poll(
      () => page.evaluate(() => document.body.scrollHeight - (document.querySelector('.header') as HTMLElement).offsetTop - window.innerHeight),
      { message: 'full list is tall enough to test desktop top and back clicks', timeout: 5_000 }
    )
    .toBeGreaterThan(400)
  await scrolls(page, clickDesktop)

  await name(page, editRoot)
  await clickDesktop('create')
  const createdChild = `${editRoot}/0`
  await expect
    .poll(() => query(page), { message: 'clicking desktop create opens a new child under the named item', timeout: 5_000 })
    .toBe(`${createdChild} `)
  const createdId = await page.evaluate(label => window._item(label, true)!.id, createdChild)
  await expect(page.locator(`#textarea-${createdId}`), 'clicking desktop create opens and focuses the new child editor').toBeFocused()
  await page.keyboard.press('Shift+Enter')
  await expect
    .poll(() => page.evaluate(label => (window._item(label, true) as any)?.editing, createdChild), { message: 'new child created by desktop create saves and closes cleanly', timeout: 30_000 })
    .toBe(false)

  // 1d. Live item create/delete in this page updates down on the named leaf with no other action
  await name(page, `${navRoot}/a/0`)
  await expectDesktop({ left: 'dim', up: 'green', down: 'dim', right: 'dim' }, 'leaf starts with down dim')
  const leafChild = `${navRoot}/a/0/0`
  await page.evaluate(label => void window._create(`${label} live child`), leafChild)
  await expectDesktop({ left: 'dim', up: 'green', down: 'green', right: 'dim' }, 'creating a child under the named leaf turns down green live')
  await page.evaluate(label => window._item(label, true)!.delete(false), leafChild)
  await expectDesktop({ left: 'dim', up: 'green', down: 'dim', right: 'dim' }, 'deleting that child turns down dim again live')

  // 1d-dangling. A solely-relative reference (#/later) to a missing child renders dangling and dims
  // Down; creating the child turns Down green live; deleting it with the parent reference still in
  // place turns Down dim again; an absolute tag written in full keeps Down green even with no child
  const danglingRoot = `${navRoot}_d`
  const absRoot = `${navRoot}_abs`
  await page.evaluate(
    ([d, a]) => {
      void window._create(`${d} #/later`)
      void window._create(`${a} ${a}/later`)
    },
    [danglingRoot, absRoot] as const
  )
  await expect
    .poll(() => page.evaluate(labels => labels.every(l => !!window._item(l, true)?.saved_id), [danglingRoot, absRoot]), { message: 'dangling and absolute fixtures saved', timeout: 30_000 })
    .toBe(true)
  await name(page, danglingRoot)
  await expectDesktop({ left: 'dim', up: 'dim', down: 'dim', right: 'dim' }, 'parent carrying only dangling relative reference #/later dims down')
  const danglingChild = `${danglingRoot}/later`
  await page.evaluate(label => void window._create(`${label} child appears`), danglingChild)
  await expectDesktop({ left: 'dim', up: 'dim', down: 'green', right: 'dim' }, 'creating the referenced child #/later turns down green live')
  await expect
    .poll(() => page.evaluate(l => !!window._item(l, true)?.saved_id, danglingChild), { message: 'referenced child saved before deletion', timeout: 30_000 })
    .toBe(true)
  await page.evaluate(label => window._item(label, true)!.delete(false), danglingChild)
  await expectDesktop({ left: 'dim', up: 'dim', down: 'dim', right: 'dim' }, 'deleting the child while parent keeps #/later turns down dim again live')
  await name(page, absRoot)
  await expectDesktop({ left: 'dim', up: 'dim', down: 'green', right: 'dim' }, 'parent carrying absolute tag to missing child keeps down green')

  // 1e. Live item create/delete FROM OUTSIDE this page (a second page of the same account, also
  // reused below as the phone context) turns down green then dim again on page with no action there
  await name(page, `${navRoot}/a/0`)
  const context = await browser.newContext(PHONE)
  const phone = await context.newPage()
  await loadAdmin(phone)
  await expect(phone.locator(BAR), 'phone main row visible').toBeVisible()
  const remoteChild = `${navRoot}/a/0/remote`
  await phone.evaluate(label => void window._create(`${label} remote child`), remoteChild)
  await expect
    .poll(() => phone.evaluate(l => !!window._item(l, true)?.saved_id, remoteChild), { message: 'remote child saved from second page', timeout: 15_000 })
    .toBe(true)
  await expectDesktop({ left: 'dim', up: 'green', down: 'green', right: 'dim' }, 'creating a child from a second page turns down green live')
  await phone.evaluate(label => window._item(label, true)!.delete(false), remoteChild)
  await expectDesktop({ left: 'dim', up: 'green', down: 'dim', right: 'dim' }, 'deleting that child from a second page turns down dim again live')

  // 1f. Raised frosted-glass background on desktop: one piece at the lower right reaching the
  // window's right edge (4 px blur, 9% white free-edge border, 12 px full-black shadow with
  // stdDeviation 6, one 12 px top-left corner, unused .key-buttons-bg-right always hidden),
  // press rejection on bare glass between groups, old lower-left open to clicks, stand-in sparkle
  // admitted by rect and target on that same piece, pointer-events pass-through, and full strip < 480 px
  const readBackdrop = (target: Page) =>
    target.evaluate(sel => {
      const bg = document.querySelector(sel) as HTMLElement
      const pane = bg.querySelector('.key-buttons-bg-pane') as HTMLElement
      const frame = bg.querySelector('.key-buttons-bg-frame') as HTMLElement
      const right = bg.querySelector('.key-buttons-bg-right') as HTMLElement
      const blur = (s: CSSStyleDeclaration) => (s.backdropFilter && s.backdropFilter != 'none' ? s.backdropFilter : (s as any).webkitBackdropFilter)
      const clip = (s: CSSStyleDeclaration) => (s.clipPath && s.clipPath != 'none' ? s.clipPath : (s as any).webkitClipPath)
      const readSvg = (cls: string) => {
        const svg = frame.querySelector(`.key-buttons-bg-svg.${cls}`) as SVGSVGElement
        const s = getComputedStyle(svg)
        const paths = Array.from(svg.querySelectorAll(':scope > path'))
        return {
          display: s.display,
          width: s.width,
          height: s.height,
          pointerEvents: s.pointerEvents,
          stdDev: svg.querySelector('feGaussianBlur')?.getAttribute('stdDeviation') ?? null,
          shadowFill: paths[0]?.getAttribute('fill') ?? null,
          borderStroke: paths[1]?.getAttribute('stroke') ?? null,
          borderWidth: paths[1]?.getAttribute('stroke-width') ?? null,
          borderArcs: (paths[1]?.getAttribute('d')?.match(/A 11\.5 11\.5/g) ?? []).length,
        }
      }
      const ps = getComputedStyle(pane)
      const pr = pane.getBoundingClientRect()
      const fs = getComputedStyle(frame)
      const rs = getComputedStyle(right)
      return {
        hidden: bg.hidden,
        display: getComputedStyle(bg).display,
        pane: {
          width: ps.width,
          height: ps.height,
          rightEdge: Math.round(window.innerWidth - pr.right),
          bottomEdge: Math.round(window.innerHeight - pr.bottom),
          blur: blur(ps),
          clip: clip(ps),
          clipArcs: (clip(ps).match(/A 12 12|a 12 12|12,\s*12/gi) ?? []).length,
          borderTopWidth: ps.borderTopWidth,
          borderTopColor: ps.borderTopColor,
          radiusTR: ps.borderTopRightRadius,
          radiusTL: ps.borderTopLeftRadius,
          boxShadow: ps.boxShadow,
          pointerEvents: ps.pointerEvents,
        },
        frame: {
          display: fs.display,
          pointerEvents: fs.pointerEvents,
          split: readSvg('split'),
          strip: readSvg('strip'),
        },
        right: {
          display: rs.display,
        },
      }
    }, BACKDROP)

  const hRow = LOOK.reload.size + 2 * LOOK.reload.bottom
  const stripH = `${hRow}px`
  const pieceW = 2 * LOOK.reload.left + 9 * LOOK.reload.size + 4 * LOOK.gap + 4 * LOOK.group
  const expectedBlur = 'blur(4px)'
  const expectedBorder = 'rgba(255, 255, 255, 0.09)'
  const expectedShadowCss = 'rgb(0, 0, 0) 0px 0px 12px 0px'

  const wideBg = await readBackdrop(page)
  expect(
    {
      hidden: wideBg.hidden,
      pane: [
        wideBg.pane.width,
        wideBg.pane.height,
        wideBg.pane.rightEdge,
        wideBg.pane.bottomEdge,
        wideBg.pane.blur,
        wideBg.pane.clipArcs,
        wideBg.pane.pointerEvents,
      ],
      frameDisplay: wideBg.frame.display,
      splitSvg: [
        wideBg.frame.split.display,
        wideBg.frame.split.pointerEvents,
        wideBg.frame.split.stdDev,
        wideBg.frame.split.shadowFill,
        wideBg.frame.split.borderStroke,
        wideBg.frame.split.borderWidth,
        wideBg.frame.split.borderArcs,
      ],
      stripSvgDisplay: wideBg.frame.strip.display,
      rightDisplay: wideBg.right.display,
    },
    'wide desktop shows one right frosted piece reaching the window right edge with 4 px blur, one 12 px top-left corner, 9% edge and 12 px black shadow (stdDeviation 6), and keeps .key-buttons-bg-right hidden'
  ).toEqual({
    hidden: false,
    pane: [`${pieceW}px`, stripH, 0, 0, expectedBlur, 1, 'none'],
    frameDisplay: 'block',
    splitSvg: ['block', 'none', '6', 'rgba(0, 0, 0, 1)', expectedBorder, '1', 1],
    stripSvgDisplay: 'none',
    rightDisplay: 'none',
  })

  // glass click rejection on desktop: clicking on bare glass between two groups (back and left)
  // reaches nothing of the page and leaves MindBox text and focus unchanged (unfocused and focused);
  // the old lower-left place and points outside the right piece reach the page; wheeling over the
  // glass still scrolls document.body
  const [backBtnBox, leftBtnBox] = [
    (await page.locator(`${NAV_STRIP} > button[data-key="back"]`).boundingBox())!,
    (await page.locator(`${NAV_STRIP} > button[data-key="left"]`).boundingBox())!,
  ]
  const [gapX, gapY] = [(backBtnBox.x + backBtnBox.width + leftBtnBox.x) / 2, backBtnBox.y + backBtnBox.height / 2]
  const watchTarget = (target: Page, x: number, y: number) =>
    target.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px, py) as HTMLElement | null
        const seen = { mousedown: 0, click: 0 }
        const onDown = () => {
          seen.mousedown++
        }
        const onClick = () => {
          seen.click++
        }
        el?.addEventListener('mousedown', onDown)
        el?.addEventListener('click', onClick)
        ;(window as any).__glass_watch = () => {
          el?.removeEventListener('mousedown', onDown)
          el?.removeEventListener('click', onClick)
          return { underPage: !!el && !el.closest('[data-key-buttons], .vault-sparkle'), ...seen }
        }
      },
      [x, y] as const
    )
  const readWatch = (target: Page) => target.evaluate(() => (window as any).__glass_watch() as { underPage: boolean; mousedown: number; click: number })

  // unfocused MindBox: click on bare glass between two groups (back and left) delivers no mousedown/click to page
  await blur(page)
  const textBeforeUnfocused = (await query(page)).trim()
  await watchTarget(page, gapX, gapY)
  await page.mouse.click(gapX, gapY)
  expect(await readWatch(page), 'click on bare frosted glass between two strip groups (box unfocused) delivers no mousedown or click to page').toEqual({ underPage: true, mousedown: 0, click: 0 })
  expect(
    [(await query(page)).trim(), await page.evaluate(() => document.activeElement?.id ?? '')],
    'unfocused MindBox text and focus stay unchanged after glass click'
  ).toEqual([textBeforeUnfocused, ''])

  // focused MindBox: click on bare glass between two groups keeps MindBox focused and delivers no mousedown/click to page
  await page.locator('.header .backdrop').first().click()
  await expect(page.locator('#textarea-mindbox'), 'MindBox focused before desktop glass click').toBeFocused()
  await watchTarget(page, gapX, gapY)
  await page.mouse.click(gapX, gapY)
  expect(await readWatch(page), 'click on bare frosted glass between two strip groups (box focused) delivers no mousedown or click to page').toEqual({ underPage: true, mousedown: 0, click: 0 })
  await expect(page.locator('#textarea-mindbox'), 'MindBox keeps focus after glass click').toBeFocused()
  expect((await query(page)).trim(), 'MindBox text unchanged after glass click').toBe(textBeforeUnfocused)
  await blur(page)

  // the three presses outside the glass go to a cover of the test's own, laid over the page and
  // under the buttons and their glass: the seeded items at those points are live (timers, a frame,
  // links). In one full gate the press at the old lower-left place opened one of them for editing
  // and the page scrolled by 434 px between the watch of the point left of the piece and its press
  // (the kept trace, as the code reviewer read it), so the element watched got nothing
  await page.evaluate(() => {
    const cover = document.createElement('div')
    cover.id = 'e2e-page-cover'
    cover.style.cssText = `position:fixed;inset:0;z-index:${Number(getComputedStyle(document.querySelector('.key-buttons-bg')!).zIndex) - 1}`
    document.body.append(cover)
  })
  const coverAt = (x: number, y: number) => page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.id ?? '', [x, y] as const)

  // old lower-left place takes a click as any page point does (no glass there now)
  const origSize = page.viewportSize()!
  const [oldLeftX, oldLeftY] = [LOOK.reload.left + LOOK.reload.size / 2, origSize.height - LOOK.reload.bottom - LOOK.reload.size / 2]
  expect(await coverAt(oldLeftX, oldLeftY), 'the cover is the page at the old lower-left place').toBe('e2e-page-cover')
  await watchTarget(page, oldLeftX, oldLeftY)
  await page.mouse.click(oldLeftX, oldLeftY)
  expect(await readWatch(page), 'click at old lower-left place reaches the page underneath (no glass there now)').toEqual({ underPage: true, mousedown: 1, click: 1 })

  // clicks just outside the right piece (above the row and left of the piece) reach the page
  const outsideY = origSize.height - hRow - 4
  expect(await coverAt(gapX, outsideY), 'the cover is the page above the row').toBe('e2e-page-cover')
  await watchTarget(page, gapX, outsideY)
  await page.mouse.click(gapX, outsideY)
  expect(await readWatch(page), 'click just outside the glass above the row reaches the page underneath').toEqual({ underPage: true, mousedown: 1, click: 1 })
  const outsideLeftX = origSize.width - pieceW - 6
  expect(await coverAt(outsideLeftX, gapY), 'the cover is the page left of the piece').toBe('e2e-page-cover')
  await watchTarget(page, outsideLeftX, gapY)
  await page.mouse.click(outsideLeftX, gapY)
  expect(await readWatch(page), 'click just left of the right glass piece reaches the page underneath').toEqual({ underPage: true, mousedown: 1, click: 1 })
  await page.evaluate(() => document.getElementById('e2e-page-cover')!.remove())

  // press-start rejection across the 44 px desktop row's top edge at gapX: a link laid across that
  // edge gets neither mousedown nor click when a press starts on glass 43 px above bottom and
  // releases on the link 45 px above bottom; a press starting above the glass delivers its
  // mousedown; and an ordinary click afterwards is delivered once
  const edgeLinkLeft = Math.round(gapX - 16)
  await page.evaluate(leftPx => {
    const link = document.createElement('a')
    link.id = 'e2e-glass-edge-link'
    link.href = '#e2e-glass-edge'
    link.textContent = 'edge'
    link.style.cssText = `position:fixed;left:${leftPx}px;bottom:30px;width:32px;height:30px;z-index:50;display:block`
    const counts = { mousedown: 0, click: 0 }
    link.addEventListener('mousedown', () => counts.mousedown++)
    link.addEventListener('click', e => {
      e.preventDefault()
      counts.click++
    })
    document.body.appendChild(link)
    ;(window as any).__edge_counts = () => ({ ...counts })
    ;(window as any).__edge_reset = () => {
      counts.mousedown = 0
      counts.click = 0
    }
  }, edgeLinkLeft)
  try {
    const insideEdgeY = origSize.height - (hRow - 1) // 43 px above bottom (on glass)
    const outsideEdgeY = origSize.height - (hRow + 1) // 45 px above bottom (above glass)
    await blur(page)
    await page.mouse.move(gapX, insideEdgeY)
    await page.mouse.down()
    await page.mouse.move(gapX, outsideEdgeY)
    await page.mouse.up()
    expect(
      await page.evaluate(() => (window as any).__edge_counts()),
      'press on desktop glass 43 px above bottom released on link 45 px above bottom delivers no mousedown or click'
    ).toEqual({ mousedown: 0, click: 0 })

    // immediately after the rejected glass press, before any further mouse press, Shift+ArrowDown
    // toggles show-more twice in a row via the route's code-dispatched Event('click') on .toggle.show
    const hide0 = await page.evaluate(() => window.__hideIndex)
    expect(
      await page.evaluate(() => !!document.querySelector('.toggle.show')),
      'show-more toggle present immediately after rejected glass press'
    ).toBe(true)
    await page.keyboard.press('Shift+ArrowDown')
    await expect
      .poll(() => page.evaluate(() => window.__hideIndex), {
        message: 'first Shift+ArrowDown after rejected glass press advances show-more toggle',
        timeout: 3_000,
      })
      .toBeGreaterThan(hide0)
    await page.evaluate(() => (window as any)._update_dom())
    const hide1 = await page.evaluate(() => window.__hideIndex)
    expect(
      await page.evaluate(() => !!document.querySelector('.toggle.show')),
      'second show-more toggle present after first Shift+ArrowDown'
    ).toBe(true)
    await page.keyboard.press('Shift+ArrowDown')
    await expect
      .poll(() => page.evaluate(() => window.__hideIndex), {
        message: 'second Shift+ArrowDown after rejected glass press advances show-more toggle again',
        timeout: 3_000,
      })
      .toBeGreaterThan(hide1)

    await page.evaluate(() => (window as any).__edge_reset())
    await page.mouse.move(gapX, outsideEdgeY)
    await page.mouse.down()
    await page.mouse.move(gapX, insideEdgeY)
    await page.mouse.up()
    expect(
      await page.evaluate(() => (window as any).__edge_counts()),
      'press starting on link above glass at 45 px above bottom delivers mousedown and click'
    ).toEqual({ mousedown: 1, click: 1 })

    await page.evaluate(() => (window as any).__edge_reset())
    await page.mouse.click(gapX, outsideEdgeY)
    expect(
      await page.evaluate(() => (window as any).__edge_counts()),
      'ordinary click on link above glass after edge-crossing presses is delivered once'
    ).toEqual({ mousedown: 1, click: 1 })
  } finally {
    await page.evaluate(() => {
      document.getElementById('e2e-glass-edge-link')?.remove()
      delete (window as any).__edge_counts
      delete (window as any).__edge_reset
    })
  }

  // wheel with pointer over the right glass piece scrolls document.body (clear filter so the full
  // seeded list gives ample scroll range below headerTop, where the app never auto-scrolls away)
  await page.evaluate(() => (window as any).MindBox.set(''))
  await expect
    .poll(() => page.evaluate(() => document.body.scrollHeight - (document.querySelector('.header') as HTMLElement).offsetTop - window.innerHeight), { timeout: 5_000 })
    .toBeGreaterThan(400)
  const desktopTop = await headerTop(page)
  await page.evaluate(y => {
    document.body.scrollTop = y
  }, desktopTop)
  await page.mouse.move(gapX, gapY)
  await page.mouse.wheel(0, 200)
  await expect.poll(() => scrollTop(page), { message: 'wheel with pointer over desktop frosted glass scrolls the page', timeout: 3_000 }).toBeGreaterThan(desktopTop + 50)
  await page.evaluate(y => {
    document.body.scrollTop = y
  }, desktopTop)

  // #vault sparkle overlays on that same right glass piece (vault.md: .vault-sparkle fixed right
  // 14/bottom 10, 24x24, z-index 90; .vault-sparkle-backdrop fixed inset 0, z-index 89;
  // .vault-sparkle-menu fixed right 14/bottom 42, z-index 90, direct children of body): .key-buttons-bg-right
  // stays hidden; the stand-in sparkle stands on the one right piece and is admitted by its
  // rectangle AND its target, while bare glass beside it and a corner of its square box outside its
  // circle reject clicks; backdrop and menu are admitted by target
  const clickOverlay = async (sel: string, x: number, y: number) => {
    await page.evaluate(
      ([s, px, py]) => {
        const el = document.querySelector(s) as HTMLElement
        const seen = { hit: !!el && el.contains(document.elementFromPoint(px, py)), mousedown: 0, click: 0 }
        const onDown = (e: MouseEvent) => {
          e.stopPropagation()
          seen.mousedown++
        }
        const onClick = (e: MouseEvent) => {
          e.stopPropagation()
          seen.click++
        }
        el.addEventListener('mousedown', onDown)
        el.addEventListener('click', onClick)
        ;(window as any).__overlay_watch = () => {
          el.removeEventListener('mousedown', onDown)
          el.removeEventListener('click', onClick)
          return seen
        }
      },
      [sel, x, y] as const
    )
    await page.mouse.click(x, y)
    return page.evaluate(() => (window as any).__overlay_watch() as { hit: boolean; mousedown: number; click: number })
  }

  await page.evaluate(([sRight, sBottom, sW, sH]) => {
    const sparkle = document.createElement('button')
    sparkle.type = 'button'
    sparkle.className = 'vault-sparkle'
    sparkle.style.cssText = `position:fixed;right:${sRight}px;bottom:${sBottom}px;z-index:90;display:flex;align-items:center;justify-content:center;width:${sW}px;height:${sH}px;margin:0;padding:0;border:0;border-radius:50%`
    sparkle.innerHTML = '<svg viewBox="0 0 16 16" style="display:block;width:16px;height:16px"><rect width="16" height="16"/></svg>'
    document.body.appendChild(sparkle)
  }, SPARKLE)
  try {
    expect((await readBackdrop(page)).right.display, '.key-buttons-bg-right stays hidden even when .vault-sparkle is visible').toBe('none')
    const [sparkleBox, paneBox, reloadBoxNow] = [
      (await page.locator('body > .vault-sparkle').boundingBox())!,
      (await page.locator(`${BACKDROP} > .key-buttons-bg-pane`).boundingBox())!,
      (await page.locator(RELOAD).boundingBox())!,
    ]
    expect(
      sparkleBox.x >= paneBox.x &&
        sparkleBox.x + sparkleBox.width <= paneBox.x + paneBox.width &&
        sparkleBox.y >= paneBox.y &&
        sparkleBox.y + sparkleBox.height <= paneBox.y + paneBox.height,
      'stand-in .vault-sparkle stands on the one right frosted piece'
    ).toBe(true)
    const [sparkleX, sparkleY] = [sparkleBox.x + sparkleBox.width / 2, sparkleBox.y + sparkleBox.height / 2]
    expect(
      await clickOverlay('body > .vault-sparkle', sparkleX, sparkleY),
      'click at centre of stand-in .vault-sparkle over right frosted piece reaches it'
    ).toEqual({ hit: true, mousedown: 1, click: 1 })

    // corner of .vault-sparkle's square bounding box outside its border-radius: 50% circle hits the page underneath:
    // coordinates are inside sparkle's rect, target is not sparkle -> rejected as glass
    const [sparkleCornerX, sparkleCornerY] = [sparkleBox.x + 1, sparkleBox.y + 1]
    await watchTarget(page, sparkleCornerX, sparkleCornerY)
    await page.mouse.click(sparkleCornerX, sparkleCornerY)
    expect(
      await readWatch(page),
      'click inside stand-in .vault-sparkle bounding rect whose target is the page is rejected as glass'
    ).toEqual({ underPage: true, mousedown: 0, click: 0 })

    const [rightGlassX, rightGlassY] = [(reloadBoxNow.x + reloadBoxNow.width + sparkleBox.x) / 2, sparkleY]
    await watchTarget(page, rightGlassX, rightGlassY)
    await page.mouse.click(rightGlassX, rightGlassY)
    expect(
      await readWatch(page),
      'click on bare glass of right frosted piece between reload and .vault-sparkle delivers no mousedown or click to page'
    ).toEqual({ underPage: true, mousedown: 0, click: 0 })

    await page.evaluate(() => {
      const backdrop = document.createElement('div')
      backdrop.className = 'vault-sparkle-backdrop'
      backdrop.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:89'
      const menu = document.createElement('div')
      menu.className = 'vault-sparkle-menu'
      menu.setAttribute('role', 'menu')
      menu.style.cssText =
        'position:fixed;right:14px;bottom:42px;z-index:90;box-sizing:border-box;padding:4px;border:1px solid #444;border-radius:6px;background:#1b1b1b'
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.textContent = 'Stop Watching'
      item.style.cssText = 'display:block;width:100%;margin:0;padding:6px 12px;border:0;font:14px/1.2 sans-serif;text-align:left;white-space:nowrap'
      menu.append(item)
      document.body.append(backdrop, menu)
    })
    expect(
      await clickOverlay('body > .vault-sparkle-backdrop', gapX, gapY),
      'click on stand-in .vault-sparkle-backdrop over frosted glass reaches it'
    ).toEqual({ hit: true, mousedown: 1, click: 1 })
    const menuBox = (await page.locator('body > .vault-sparkle-menu').boundingBox())!
    const [menuX, menuY] = [menuBox.x + menuBox.width - 20, menuBox.y + menuBox.height - 1]
    expect(
      {
        inGlass: origSize.height - menuY <= hRow && origSize.width - menuX <= pieceW,
        ...(await clickOverlay('body > .vault-sparkle-menu', menuX, menuY)),
      },
      'click on stand-in .vault-sparkle-menu overlapping the top of the right frosted piece reaches it'
    ).toEqual({ inGlass: true, hit: true, mousedown: 1, click: 1 })
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll('body > .vault-sparkle, body > .vault-sparkle-backdrop, body > .vault-sparkle-menu').forEach(el => el.remove())
    })
  }

  // narrow desktop (< 480 px): becomes one full-width unrounded strip (0 arcs, strip SVG shown, split SVG and bg-right hidden)
  await page.setViewportSize({ width: LOOK.backdrop.merge - 40, height: origSize.height })
  await expect
    .poll(async () => {
      const bg = await readBackdrop(page)
      return [
        bg.pane.width,
        bg.pane.height,
        bg.pane.clipArcs,
        bg.frame.strip.display,
        bg.frame.split.display,
        bg.frame.strip.stdDev,
        bg.frame.strip.borderStroke,
        bg.frame.strip.borderArcs,
        bg.right.display,
      ]
    }, { message: 'below 480 px desktop backdrop becomes one full-width strip', timeout: 3_000 })
    .toEqual([`${LOOK.backdrop.merge - 40}px`, stripH, 0, 'block', 'none', '6', expectedBorder, 0, 'none'])

  // a very narrow window on a device with a keyboard: the gaps between the groups shrink, so that
  // no control of the strip is cut off (review 3 of the thread nav_arrows: at 320 px the first
  // button began 6 px left of the window, at 300 px it was out of reach)
  for (const narrowWidth of [320, 300]) {
    await page.setViewportSize({ width: narrowWidth, height: origSize.height })
    await expect
      .poll(
        () =>
          page.evaluate(
            ([strip, reload]) => {
              const buttons = [...document.querySelectorAll(`${strip} > button`), document.querySelector(reload)!] as HTMLElement[]
              const top = document.querySelector(`${strip} > button[data-key="top"]`) as HTMLElement
              const box = top.getBoundingClientRect()
              return {
                width: window.innerWidth,
                count: buttons.length,
                inside: buttons.every(b => b.getBoundingClientRect().left >= 0 && b.getBoundingClientRect().right <= window.innerWidth),
                topHit: top.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
              }
            },
            [NAV_STRIP, RELOAD] as const
          ),
        { message: `at ${narrowWidth} px every control of the strip is inside the window and the top button takes a press at its centre`, timeout: 3_000 }
      )
      .toEqual({ width: narrowWidth, count: 8, inside: true, topHit: true })
  }
  await page.setViewportSize(origSize)

  // 2. Phone context: row arrows green/dim by the same rule, non-arrows never dim, full-width unrounded
  // strip shows with the main row and hides when the simulated on-screen keyboard replaces it
  await name(phone, `${navRoot}/b`)
  await expect
    .poll(() => arrowLooks(phone, [BAR]), { message: `phone arrows match rule: left, up, right green and down dim on ${navRoot}/b`, timeout: 3_000 })
    .toEqual({ left: 'green', up: 'green', down: 'dim', right: 'green' })
  const nonArrowStates = await phone.evaluate(
    ([barSel, baseColor]) => {
      const probe = document.body.appendChild(Object.assign(document.createElement('span'), { style: `color: ${baseColor}` }))
      const white = getComputedStyle(probe).color
      probe.remove()
      return ['top', 'back', 'create'].map(k => {
        const s = getComputedStyle(document.querySelector(`${barSel} > button[data-key="${k}"] > svg`)!)
        return [k, s.stroke == white, Number(s.opacity)]
      })
    },
    [BAR, LOOK.color] as const
  )
  expect(nonArrowStates, 'non-arrow buttons on phone never dim or turn green').toEqual([
    ['top', true, 1],
    ['back', true, 1],
    ['create', true, 1],
  ])
  const phoneBg = await readBackdrop(phone)
  expect(
    [
      phoneBg.hidden,
      phoneBg.pane.width,
      phoneBg.pane.height,
      phoneBg.pane.radiusTR,
      phoneBg.pane.radiusTL,
      phoneBg.pane.blur,
      phoneBg.pane.borderTopWidth,
      phoneBg.pane.borderTopColor,
      phoneBg.pane.boxShadow,
      phoneBg.pane.pointerEvents,
      phoneBg.frame.display,
      phoneBg.right.display,
    ],
    'phone shows full-width unrounded frosted strip with 4 px blur, 9% top edge and 12 px black shadow, and no desktop frame or right piece'
  ).toEqual([false, `${PHONE.viewport.width}px`, `${LOOK.size + 2 * LOOK.bottom}px`, '0px', '0px', expectedBlur, '1px', expectedBorder, expectedShadowCss, 'none', 'none', 'none'])

  // phone strip rejects a real tap at the midpoint of the 6 px gap between Left and Up even when
  // Chromium touch-adjusts the target onto a neighbouring button: zero keys dispatched and query
  // unchanged; a real tap at Left's centre then dispatches ArrowLeft and moves to the sibling
  const [phoneLeftBox, phoneUpBox] = [
    (await phone.locator(`${BAR} > button[data-key="left"]`).boundingBox())!,
    (await phone.locator(`${BAR} > button[data-key="up"]`).boundingBox())!,
  ]
  const [phoneGapX, phoneGapY] = [(phoneLeftBox.x + phoneLeftBox.width + phoneUpBox.x) / 2, phoneLeftBox.y + phoneLeftBox.height / 2]
  await phone.evaluate(() => {
    ;(window as any).__phone_keys = []
    ;(window as any).__phone_onkey = (e: KeyboardEvent) => (window as any).__phone_keys.push(e.code)
    window.addEventListener('keydown', (window as any).__phone_onkey)
  })
  try {
    await phone.touchscreen.tap(phoneGapX, phoneGapY)
    expect(
      await phone.evaluate(() => (window as any).__phone_keys as string[]),
      'tap at midpoint of 6 px gap between Left and Up on phone dispatches no key'
    ).toEqual([])
    expect((await query(phone)).trim(), 'tap at midpoint of 6 px gap between Left and Up on phone leaves query unchanged').toBe(`${navRoot}/b`)

    await phone.touchscreen.tap(phoneLeftBox.x + phoneLeftBox.width / 2, phoneLeftBox.y + phoneLeftBox.height / 2)
    await expect
      .poll(() => phone.evaluate(() => (window as any).__phone_keys as string[]), { message: 'tap at centre of phone Left button dispatches ArrowLeft', timeout: 3_000 })
      .toEqual(['ArrowLeft'])
    await expect
      .poll(async () => (await query(phone)).trim(), { message: 'tap at centre of phone Left button moves to previous sibling', timeout: 3_000 })
      .toBe(`${navRoot}/a`)
  } finally {
    await phone.evaluate(() => {
      window.removeEventListener('keydown', (window as any).__phone_onkey)
      delete (window as any).__phone_keys
      delete (window as any).__phone_onkey
    })
  }

  // phone strip beside a stand-in .vault-sparkle (24 px box at right: 14px; bottom: 10px, z-index 90):
  // a real touchscreen tap 1 px left of the sparkle's box on its centre line delivers no click to
  // the stand-in and nothing of the page gets one; a tap at its centre delivers exactly one click
  await phone.evaluate(([sRight, sBottom, sW, sH]) => {
    const sparkle = document.createElement('button')
    sparkle.type = 'button'
    sparkle.className = 'vault-sparkle'
    sparkle.style.cssText = `position:fixed;right:${sRight}px;bottom:${sBottom}px;z-index:90;display:flex;align-items:center;justify-content:center;width:${sW}px;height:${sH}px;margin:0;padding:0;border:0;border-radius:50%;cursor:pointer;touch-action:manipulation`
    sparkle.innerHTML = '<svg viewBox="0 0 16 16" style="display:block;width:16px;height:16px"><rect width="16" height="16"/></svg>'
    document.body.appendChild(sparkle)
  }, SPARKLE)
  try {
    const sparkleBox = (await phone.locator('body > .vault-sparkle').boundingBox())!
    const [sparkleGapX, sparkleCenterY] = [sparkleBox.x - 1, sparkleBox.y + sparkleBox.height / 2]
    const sparkleCenterX = sparkleBox.x + sparkleBox.width / 2
    await phone.evaluate(() => {
      const sparkle = document.querySelector('body > .vault-sparkle') as HTMLElement
      const counts = { sparkle: 0, page: 0 }
      const keys: string[] = []
      const targets: { type: string; tag: string; cls: string; onSparkle: boolean; x: number | null; y: number | null }[] = []
      const onSparkleClick = (e: MouseEvent) => {
        e.stopPropagation()
        counts.sparkle++
      }
      const onPageClick = () => {
        counts.page++
      }
      const onKey = (e: KeyboardEvent) => {
        keys.push(e.code)
      }
      const onCapture = (e: Event) => {
        const el = e.target instanceof Element ? e.target : null
        const t = (e as TouchEvent).touches?.[0] ?? (e as TouchEvent).changedTouches?.[0] ?? (e as MouseEvent)
        targets.push({
          type: e.type,
          tag: el?.tagName?.toLowerCase() ?? String(e.target),
          cls: typeof el?.className == 'string' ? el.className : el?.getAttribute?.('class') ?? '',
          onSparkle: !!el?.closest?.('.vault-sparkle'),
          x: typeof t?.clientX == 'number' ? Math.round(t.clientX * 10) / 10 : null,
          y: typeof t?.clientY == 'number' ? Math.round(t.clientY * 10) / 10 : null,
        })
      }
      sparkle.addEventListener('click', onSparkleClick)
      document.addEventListener('click', onPageClick)
      window.addEventListener('keydown', onKey)
      for (const ev of ['pointerdown', 'touchstart', 'mousedown', 'click']) window.addEventListener(ev, onCapture, true)
      ;(window as any).__sparkle_gap = {
        counts: () => ({ ...counts, keys: keys.slice() }),
        targets: () => targets.slice(),
        reset: () => {
          counts.sparkle = 0
          counts.page = 0
          keys.length = 0
          targets.length = 0
        },
        cleanup: () => {
          sparkle.removeEventListener('click', onSparkleClick)
          document.removeEventListener('click', onPageClick)
          window.removeEventListener('keydown', onKey)
          for (const ev of ['pointerdown', 'touchstart', 'mousedown', 'click']) window.removeEventListener(ev, onCapture, true)
        },
      }
    })
    try {
      await phone.touchscreen.tap(sparkleGapX, sparkleCenterY)
      const gapTargets = await phone.evaluate(() => (window as any).__sparkle_gap.targets())
      const gapCounts = await phone.evaluate(() => (window as any).__sparkle_gap.counts())
      console.log(`phone sparkle-gap tap (${sparkleGapX}, ${sparkleCenterY}) targets: ${JSON.stringify(gapTargets)}`)
      expect(
        gapCounts,
        'phone tap 1 px left of stand-in .vault-sparkle delivers no click to stand-in or page'
      ).toEqual({ sparkle: 0, page: 0, keys: [] })

      await phone.evaluate(() => (window as any).__sparkle_gap.reset())
      await phone.touchscreen.tap(sparkleCenterX, sparkleCenterY)
      expect(
        await phone.evaluate(() => (window as any).__sparkle_gap.counts()),
        'phone tap at centre of stand-in .vault-sparkle delivers exactly one click to stand-in'
      ).toEqual({ sparkle: 1, page: 0, keys: [] })
    } finally {
      await phone.evaluate(() => {
        ;(window as any).__sparkle_gap?.cleanup?.()
        delete (window as any).__sparkle_gap
      })
    }
  } finally {
    await phone.evaluate(() => {
      document.querySelector('body > .vault-sparkle')?.remove()
    })
  }

  // open glass between reload and main row still rejects taps to the page, while a finger drag
  // starting at that same point still scrolls document.body natively
  const [phoneReloadBox, phoneTopBox] = [
    (await phone.locator(RELOAD).boundingBox())!,
    (await phone.locator(`${BAR} > button[data-key="top"]`).boundingBox())!,
  ]
  const [phoneStripX, phoneStripY] = [(phoneReloadBox.x + phoneReloadBox.width + phoneTopBox.x) / 2, phoneTopBox.y + phoneTopBox.height / 2]
  await watchTarget(phone, phoneStripX, phoneStripY)
  await phone.touchscreen.tap(phoneStripX, phoneStripY)
  expect(await readWatch(phone), 'tap on phone frosted strip between buttons delivers no mousedown or click to page').toEqual({ underPage: true, mousedown: 0, click: 0 })

  await phone.evaluate(() => (window as any).MindBox.set(''))
  await expect
    .poll(() => phone.evaluate(() => document.body.scrollHeight - (document.querySelector('.header') as HTMLElement).offsetTop - window.innerHeight), { timeout: 5_000 })
    .toBeGreaterThan(400)
  const phoneTop = await headerTop(phone)
  await phone.evaluate(y => {
    document.body.scrollTop = y
  }, phoneTop)
  const cdp = await context.newCDPSession(phone)
  try {
    await cdp.send('Input.synthesizeScrollGesture', { x: phoneStripX, y: phoneStripY, yDistance: -300, gestureSourceType: 'touch' })
  } finally {
    await cdp.detach()
  }
  await expect.poll(() => scrollTop(phone), { message: 'finger drag starting on phone frosted strip scrolls the page', timeout: 3_000 }).toBeGreaterThan(phoneTop + 50)
  await phone.evaluate(y => {
    document.body.scrollTop = y
  }, phoneTop)

  // on-screen keyboard up hides the phone strip along with the main row; down brings both back
  // (.key-buttons-bg is a zero-height container whose child .key-buttons-bg-pane paints the strip)
  await phone.locator('.header .backdrop').first().click()
  await expect(phone.locator('#textarea-mindbox')).toBeFocused()
  await keyboard(phone, 'up')
  await expect(phone.locator(BAR), 'phone main row hides when keyboard is up').toBeHidden()
  await expect(phone.locator(ABOVE), 'keyboard row replaces main row').toBeVisible()
  await expect
    .poll(async () => {
      const bg = await readBackdrop(phone)
      return [bg.hidden, bg.display]
    }, { message: 'phone frosted strip hides when keyboard is up', timeout: 3_000 })
    .toEqual([true, 'none'])
  await keyboard(phone, 'down')
  await blur(phone)
  await expect(phone.locator(BAR), 'phone main row returns when keyboard closes').toBeVisible()
  await expect
    .poll(async () => {
      const bg = await readBackdrop(phone)
      return [bg.hidden, bg.display, bg.pane.height]
    }, { message: 'phone frosted strip returns with main row', timeout: 3_000 })
    .toEqual([false, 'block', `${LOOK.size + 2 * LOOK.bottom}px`])
  await context.close()
})

// guest action buttons handed to #key_buttons (2026-11-24): wide desktop inline at the strip's
// left end a group gap away, narrow desktop second row above the left edge, phone touch second
// row (32 px buttons lined up with the 32 px reload button, hidden while a keyboard is up),
// busy highlight while an async press runs, glass rejection on the guest extension and floor,
// and console diagnostics for slow work, dropped taps, and page stalls (long animation frames
// and Event Timing fallback)
test('guest action buttons stand inline when wide, move to a second row when narrow or on a phone, stay lit while busy, hide under a keyboard, and log slow or dropped taps', async ({ page, browser }) => {
  await loadAdmin(page)
  if (!(await page.evaluate(() => !!window._item('#key_buttons', true)))) {
    expect(await install(page, 'key_buttons'), '/_install key_buttons').toBeNull()
    await waitWritesSettled(page, '#key_buttons')
  }
  await expect
    .poll(() => page.evaluate(() => (window as any)._key_buttons?.disposed === false), { message: '#key_buttons live', timeout: 10_000 })
    .toBe(true)
  const GUESTS = '[data-key-buttons="guests"]'
  const LOOK: Look = await page.evaluate(() => (window._item('#key_buttons', true) as any).eval('KEY_BUTTONS_LOOK'))
  const origSize = page.viewportSize()!
  const warns: string[] = []
  const errors: string[] = []
  page.on('console', msg => {
    if (msg.type() == 'warning') warns.push(msg.text())
    else if (msg.type() == 'error' && /key buttons:/i.test(msg.text())) errors.push(msg.text())
  })
  page.on('pageerror', err => void errors.push(err.message))

  const handOver = async (target: Page) => {
    await target.evaluate(() => {
      ;(window as any).__guest_calls = []
      ;(window as any).__guest_resolve = null
      ;(window as any)._key_buttons_guests = {
        buttons: [
          {
            name: 'busy',
            title: 'Busy action',
            icon: 'M3 8h10',
            color: '#6f6',
            press: () => {
              ;(window as any).__guest_calls.push('busy')
              return new Promise<void>(r => ((window as any).__guest_resolve = r))
            },
          },
          {
            name: 'slow',
            title: 'Slow action',
            icon: 'M3 8h10',
            color: '#fa4',
            press: () => {
              ;(window as any).__guest_calls.push('slow')
              return new Promise<void>(r => setTimeout(r, 1050))
            },
          },
          {
            name: 'plain',
            title: 'Plain action',
            icon: 'M3 8h10',
            color: '#fff',
            press: () => void (window as any).__guest_calls.push('plain'),
          },
          {
            name: 'fill',
            title: 'Filled action',
            icon: 'M8 1l7 7-7 7-7-7z',
            fill: true,
            color: '#ff6',
            press: () => void (window as any).__guest_calls.push('fill'),
          },
          {
            name: 'five',
            title: 'Fifth action',
            icon: 'M3 8h10',
            color: '#6af',
            press: () => void (window as any).__guest_calls.push('five'),
          },
          {
            name: 'six',
            title: 'Sixth action',
            icon: 'M3 8h10',
            color: '#f66',
            press: () => void (window as any).__guest_calls.push('six'),
          },
        ],
        taken: () => void (window as any).__guest_calls.push('taken'),
      }
      ;(window as any)._key_buttons.guest()
    })
  }

  try {
    // 1. Wide desktop (1280 px): inline at the strip's left end a group gap (18 px) away, split glass widened
    await page.setViewportSize({ width: 1280, height: origSize.height })
    await handOver(page)
    await expect(page.locator(GUESTS), 'guest group visible on wide desktop').toBeVisible()
    const wide = await page.evaluate(
      ([guestsSel, stripSel, bgSel]) => {
        const g = document.querySelector(guestsSel) as HTMLElement
        const strip = document.querySelector(stripSel) as HTMLElement
        const bg = document.querySelector(bgSel) as HTMLElement
        const pane = bg.querySelector('.key-buttons-bg-pane') as HTMLElement
        const floor = bg.querySelector('.key-buttons-bg-floor') as HTMLElement
        const btns = [...g.children] as HTMLElement[]
        const last = btns[btns.length - 1].getBoundingClientRect()
        const firstNav = strip.children[0].getBoundingClientRect()
        return {
          cls: g.className,
          bgCls: bg.className,
          floorDisplay: getComputedStyle(floor).display,
          paneW: Math.round(pane.getBoundingClientRect().width),
          gapToStrip: Math.round(firstNav.left - last.right),
          sizes: btns.map(b => [Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]),
          sameRow: btns.every(b => Math.round(b.getBoundingClientRect().top - firstNav.top) === 0),
          calls: (window as any).__guest_calls,
        }
      },
      [GUESTS, NAV_STRIP, BACKDROP] as const
    )
    const expectedW = await page.evaluate(() => (window._item('#key_buttons', true) as any).eval('key_buttons_backdrop_geom(KEY_BUTTONS_LOOK, 6).w_piece') as number)
    expect(wide, 'wide desktop places guests inline, group gap from strip, widening split glass with no floor').toEqual({
      cls: 'key-buttons-guests',
      bgCls: 'key-buttons-bg desktop split',
      floorDisplay: 'none',
      paneW: expectedW,
      gapToStrip: LOOK.group,
      sizes: Array(6).fill([24, 24]),
      sameRow: true,
      calls: ['taken'],
    })

    // busy highlight: button lights to LOOK.pressed (#555 = rgb(85, 85, 85)) while pending (even
    // after the pointer leaves it), and returns to idle #222 (rgb(34, 34, 34)) once settled
    const busyBtn = page.locator(`${GUESTS} > button[data-guest="busy"]`)
    await busyBtn.click()
    await page.mouse.move(0, 0)
    await expect
      .poll(() => busyBtn.evaluate(el => [el.classList.contains('busy'), getComputedStyle(el).backgroundColor]), { message: 'busy button stays lit while promise is pending', timeout: 3_000 })
      .toEqual([true, 'rgb(85, 85, 85)'])
    await page.evaluate(() => (window as any).__guest_resolve?.())
    await expect
      .poll(() => busyBtn.evaluate(el => [el.classList.contains('busy'), getComputedStyle(el).backgroundColor]), { message: 'busy highlight clears when promise settles', timeout: 3_000 })
      .toEqual([false, 'rgb(34, 34, 34)'])

    // slow work (>= 1000 ms) logs diagnostic warning to console
    warns.length = 0
    await page.locator(`${GUESTS} > button[data-guest="slow"]`).click()
    await expect
      .poll(() => warns.find(w => w.includes('the tap on "slow"')) ?? null, { message: 'slow guest work logs timing line', timeout: 5_000 })
      .toMatch(/key buttons: the tap on "slow" reached the page \d+ ms after the finger left; its work took \d+ ms/)

    // bare glass in the 18 px group gap between guests and strip rejects clicks to the page
    const [lastGuestBox, firstNavBox] = [
      (await page.locator(`${GUESTS} > button`).last().boundingBox())!,
      (await page.locator(`${NAV_STRIP} > button`).first().boundingBox())!,
    ]
    const [gapX, gapY] = [(lastGuestBox.x + lastGuestBox.width + firstNavBox.x) / 2, firstNavBox.y + firstNavBox.height / 2]
    await page.evaluate(() => {
      ;(window as any).__gap_clicks = 0
      ;(window as any).__gap_fn = () => (window as any).__gap_clicks++
      document.addEventListener('click', (window as any).__gap_fn)
    })
    await page.mouse.click(gapX, gapY)
    expect(await page.evaluate(() => (window as any).__gap_clicks), 'bare glass in group gap between guests and strip blocks page clicks').toBe(0)
    await page.evaluate(() => {
      document.removeEventListener('click', (window as any).__gap_fn)
      delete (window as any).__gap_clicks
      delete (window as any).__gap_fn
    })

    // 2a. Mid-narrow desktop (500 px, >= merge 480 and < w_piece 532): guests move to the second floor
    //     and the bottom strip's glass and border reach the window's right edge (drawn to w_piece 532)
    const readFloorStrip = () =>
      page.evaluate(
        ([guestsSel, bgSel]) => {
          const g = document.querySelector(guestsSel) as HTMLElement
          const bg = document.querySelector(bgSel) as HTMLElement
          const pane = bg.querySelector('.key-buttons-bg-pane') as HTMLElement
          const floor = bg.querySelector('.key-buttons-bg-floor') as HTMLElement
          const border = bg.querySelector('.key-buttons-bg-svg.strip > path[fill="none"]') as SVGPathElement | null
          const gr = g.getBoundingClientRect()
          const fr = floor.getBoundingClientRect()
          const first = g.children[0].getBoundingClientRect()
          const hit = document.elementFromPoint(first.left + first.width / 2, first.top + first.height / 2)
          const clipPath = getComputedStyle(pane).clipPath
          const borderD = border?.getAttribute('d') ?? ''
          const clipW = Number(clipPath.match(/\bH\s*([0-9.]+)/)?.[1] ?? NaN)
          const borderW = Number(borderD.match(/\bH\s*([0-9.]+)/)?.[1] ?? NaN)
          return {
            innerWidth: window.innerWidth,
            bgCls: bg.className,
            left: Math.round(gr.left),
            bottom: Math.round(window.innerHeight - gr.bottom),
            floorDisplay: getComputedStyle(floor).display,
            floorRect: [Math.round(fr.left), Math.round(window.innerHeight - fr.bottom), Math.round(fr.width), Math.round(fr.height)],
            paneW: Math.round(pane.getBoundingClientRect().width),
            clipW,
            borderW,
            hitFirst: g.children[0].contains(hit),
          }
        },
        [GUESTS, BACKDROP] as const
      )
    const rowH = LOOK.reload.size + 2 * LOOK.reload.bottom
    const expectedFloorW = 2 * LOOK.reload.left + 6 * LOOK.reload.size + 5 * LOOK.gap

    await page.setViewportSize({ width: 500, height: origSize.height })
    await expect
      .poll(() => page.evaluate(sel => document.querySelector(sel)?.className ?? '', GUESTS), { message: '500 px desktop moves guests to floor', timeout: 3_000 })
      .toBe('key-buttons-guests floor')
    const mid = await readFloorStrip()
    expect(
      { bgCls: mid.bgCls, left: mid.left, bottom: mid.bottom, floorDisplay: mid.floorDisplay, floorRect: mid.floorRect, paneW: mid.paneW, hitFirst: mid.hitFirst },
      '500 px desktop second row sits above the bottom strip at left 14 px with matching glass floor',
    ).toEqual({
      bgCls: 'key-buttons-bg desktop floor',
      left: LOOK.reload.left,
      bottom: rowH + LOOK.reload.bottom,
      floorDisplay: 'block',
      floorRect: [0, rowH, expectedFloorW, rowH],
      paneW: 500,
      hitFirst: true,
    })
    expect(mid.clipW, '500 px strip computed clip-path reaches the window right edge').toBeGreaterThanOrEqual(mid.innerWidth)
    expect(mid.borderW, '500 px strip border SVG path reaches the window right edge').toBeGreaterThanOrEqual(mid.innerWidth)
    expect([mid.clipW, mid.borderW], '500 px strip glass and border draw to w_piece (532)').toEqual([expectedW, expectedW])
    await shot(page, 'bb2_strip_500', { x: 0, y: origSize.height - 140, width: 500, height: 140 })

    // 2b. Narrow desktop (430 px, below merge 480): stays on second row at left edge above the bottom strip
    await page.setViewportSize({ width: 430, height: origSize.height })
    await expect.poll(() => page.evaluate(() => window.innerWidth), { timeout: 3_000 }).toBe(430)
    const narrow = await readFloorStrip()
    expect(
      { bgCls: narrow.bgCls, left: narrow.left, bottom: narrow.bottom, floorDisplay: narrow.floorDisplay, floorRect: narrow.floorRect, paneW: narrow.paneW, hitFirst: narrow.hitFirst },
      'narrow desktop second row sits above the bottom bar at left 14 px with matching glass floor',
    ).toEqual({
      bgCls: 'key-buttons-bg desktop floor',
      left: LOOK.reload.left,
      bottom: rowH + LOOK.reload.bottom,
      floorDisplay: 'block',
      floorRect: [0, rowH, expectedFloorW, rowH],
      paneW: 430,
      hitFirst: true,
    })
    expect(narrow.clipW, '430 px strip computed clip-path reaches the window right edge').toBeGreaterThanOrEqual(narrow.innerWidth)
    expect(narrow.borderW, '430 px strip border SVG path reaches the window right edge').toBeGreaterThanOrEqual(narrow.innerWidth)
    await shot(page, 'bb2_strip_430', { x: 0, y: origSize.height - 140, width: 430, height: 140 })

    // 3. Phone touch page: 32 px reload + 32 px second-row guests lined up with reload, hidden under keyboard, real tap works
    const phoneCtx = await browser.newContext(PHONE)
    const phone = await phoneCtx.newPage()
    const phoneWarns: string[] = []
    phone.on('console', msg => {
      if (msg.type() == 'error' && /key buttons:/i.test(msg.text())) errors.push(`phone: ${msg.text()}`)
      if (msg.type() == 'warning' && /key buttons:/i.test(msg.text())) phoneWarns.push(msg.text())
    })
    try {
      await loadAdmin(phone)
      await expect(phone.locator(BAR)).toBeVisible()
      // attach after initial anonymous-seed render (whose sandboxed iframe throws a localStorage SecurityError)
      phone.on('pageerror', err => void errors.push(`phone: ${err.message}`))
      await handOver(phone)
      await expect(phone.locator(GUESTS)).toBeVisible()
      const phoneGeom = await phone.evaluate(
        ([guestsSel, reloadSel, bgSel]) => {
          const g = document.querySelector(guestsSel) as HTMLElement
          const r = document.querySelector(reloadSel)!.getBoundingClientRect()
          const gr = g.getBoundingClientRect()
          const floor = document.querySelector(`${bgSel} > .key-buttons-bg-floor`)!.getBoundingClientRect()
          const btns = [...g.children] as HTMLElement[]
          return {
            cls: g.className,
            reload: [Math.round(r.left), Math.round(window.innerHeight - r.bottom), Math.round(r.width), Math.round(r.height)],
            guestsLeft: Math.round(gr.left),
            guestsBottom: Math.round(window.innerHeight - gr.bottom),
            btnSizes: btns.map(b => [Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]),
            floorRect: [Math.round(floor.left), Math.round(window.innerHeight - floor.bottom), Math.round(floor.width), Math.round(floor.height)],
          }
        },
        [GUESTS, RELOAD, BACKDROP] as const
      )
      const touchGrow = (LOOK.size - SPARKLE[2]) / 2
      const touchLeft = LOOK.reload.left - touchGrow
      const phoneRowH = LOOK.size + 2 * LOOK.bottom
      expect(phoneGeom, 'phone touch reload is 32 px at 10/6 and second-row guests line up with it at 32 px').toEqual({
        cls: 'key-buttons-guests floor touch',
        reload: [touchLeft, LOOK.reload.bottom - touchGrow, LOOK.size, LOOK.size],
        guestsLeft: touchLeft,
        guestsBottom: LOOK.size + 3 * LOOK.bottom,
        btnSizes: Array(6).fill([LOOK.size, LOOK.size]),
        floorRect: [0, phoneRowH, 2 * touchLeft + 6 * LOOK.size + 5 * LOOK.gap, phoneRowH],
      })
      // tap in the 6 px gap between two guest buttons on phone delivers zero press calls and logs
      // one dropped-tap warning where the browser adjusts the click onto a neighboring button;
      // tap on 'plain' button's centre invokes its press
      const [g0Box, g1Box, plainBox] = [
        (await phone.locator(`${GUESTS} > button[data-guest="busy"]`).boundingBox())!,
        (await phone.locator(`${GUESTS} > button[data-guest="slow"]`).boundingBox())!,
        (await phone.locator(`${GUESTS} > button[data-guest="plain"]`).boundingBox())!,
      ]
      const warnsBeforeGap = phoneWarns.length
      await phone.touchscreen.tap((g0Box.x + g0Box.width + g1Box.x) / 2, g0Box.y + g0Box.height / 2)
      expect(await phone.evaluate(() => (window as any).__guest_calls), 'tap in gap between guest buttons invokes no press').toEqual(['taken'])
      await expect
        .poll(() => phoneWarns.slice(warnsBeforeGap).filter(warn => /was not taken/.test(warn)), { message: 'adjusted tap in gap between guest buttons logs dropped-tap warning (a slow page\'s own line is not counted)', timeout: 3_000 })
        .toEqual([expect.stringMatching(/^key buttons: a tap on "(busy|slow)" was not taken: it began on the glass beside the button$/)])
      await phone.touchscreen.tap(plainBox.x + plainBox.width / 2, plainBox.y + plainBox.height / 2)
      await expect.poll(() => phone.evaluate(() => (window as any).__guest_calls), { message: 'tap on guest button centre invokes its press', timeout: 3_000 }).toEqual(['taken', 'plain'])
      // on-screen keyboard up hides guest buttons alongside the main bar; down restores both
      await phone.locator('.header .backdrop').first().click()
      await expect(phone.locator('#textarea-mindbox')).toBeFocused()
      await keyboard(phone, 'up')
      await expect(phone.locator(GUESTS), 'guest buttons hide while on-screen keyboard is up').toBeHidden()
      await expect(phone.locator(BAR)).toBeHidden()
      await keyboard(phone, 'down')
      await blur(phone)
      await expect(phone.locator(GUESTS), 'guest buttons return when keyboard closes').toBeVisible()
    } finally {
      await phoneCtx.close()
    }

    // 4. Page-stall console warning (~1.5 s synchronous click handler):
    //    (a) Chromium long-animation-frame path names safe BUTTON.onclick (no function, file or place)
    //    (b) Fresh page with long-animation-frame hidden from PerformanceObserver.supportedEntryTypes
    //        uses Event Timing and names safe click on BUTTON with >=1000 ms handling time
    //    Neither path leaks the sentinel id, class, handler function name, or button text.
    const stallSentinel = 'sentinel-payroll-9f4c'
    const addStallButton = async (target: Page) => {
      await target.evaluate(sentinel => {
        const b = document.createElement('button')
        b.id = sentinel
        b.className = `cls-${sentinel}`
        b.textContent = `secret item text ${sentinel}`
        b.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;padding:8px 12px'
        b.addEventListener('click', function e2eStallClickSentinel() {
          const until = performance.now() + 1500
          while (performance.now() < until) {}
        })
        document.body.appendChild(b)
      }, stallSentinel)
    }
    const loafPattern =
      /^key buttons: the page did not respond for \d+ ms, until .+; the browser names \d+ long frames?: .*\b[1-9]\d{3,} ms event-listener BUTTON\.onclick(?=[;,]|$)/
    const eventPattern =
      /^key buttons: the page did not respond for \d+ ms, until .+; the browser names \d+ slow events?: .*\b[1-9]\d{3,} ms click on BUTTON \(waited \d+ ms, handled for [1-9]\d{3,} ms\)/
    const leakPattern = new RegExp(`${stallSentinel}|e2eStallClickSentinel|secret item text`, 'i')
    await page.setViewportSize(origSize)
    await page.waitForTimeout(350)
    const warnsBeforeStall = warns.length
    await addStallButton(page)
    try {
      await page.locator(`#${stallSentinel}`).click()
      await expect
        .poll(() => warns.slice(warnsBeforeStall).find(w => loafPattern.test(w)) ?? null, {
          message: 'page stall logs long-animation-frame warning naming safe BUTTON.onclick with >=1000 ms handler time',
          timeout: 5_000,
        })
        .not.toBeNull()
      const loafLine = warns.slice(warnsBeforeStall).find(w => loafPattern.test(w))!
      console.log(`stall (long-animation-frame): ${loafLine}`)
      expect(loafLine, 'long-frame path does not emit slow-event text').not.toMatch(/slow event/)
      for (const w of warns.slice(warnsBeforeStall)) {
        expect(w, 'long-frame warnings leak no sentinel id, class, handler name, or button text').not.toMatch(leakPattern)
      }
    } finally {
      await page.evaluate(id => document.getElementById(id)?.remove(), stallSentinel)
    }

    const eventCtx = await browser.newContext()
    const eventPage = await eventCtx.newPage()
    const eventWarns: string[] = []
    await eventPage.addInitScript(() => {
      if (typeof PerformanceObserver != 'function') return
      const kept = (PerformanceObserver.supportedEntryTypes ?? []).filter(t => t !== 'long-animation-frame')
      Object.defineProperty(PerformanceObserver, 'supportedEntryTypes', { configurable: true, get: () => kept })
    })
    eventPage.on('console', msg => {
      if (msg.type() == 'warning') eventWarns.push(msg.text())
      else if (msg.type() == 'error' && /key buttons:/i.test(msg.text())) errors.push(`event: ${msg.text()}`)
    })
    try {
      await loadAdmin(eventPage)
      await expect
        .poll(() => eventPage.evaluate(() => (window as any)._key_buttons?.disposed === false), { message: '#key_buttons live on event-fallback page', timeout: 10_000 })
        .toBe(true)
      eventPage.on('pageerror', err => void errors.push(`event: ${err.message}`))
      expect(
        await eventPage.evaluate(() => [
          PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'),
          PerformanceObserver.supportedEntryTypes.includes('event'),
        ]),
        'init script hides long-animation-frame while keeping event'
      ).toEqual([false, true])
      await eventPage.waitForTimeout(350)
      const eventWarnsBefore = eventWarns.length
      await addStallButton(eventPage)
      await eventPage.locator(`#${stallSentinel}`).click()
      await expect
        .poll(() => eventWarns.slice(eventWarnsBefore).find(w => eventPattern.test(w)) ?? null, {
          message: 'event fallback logs slow-event warning naming safe click on BUTTON with >=1000 ms handler time',
          timeout: 5_000,
        })
        .not.toBeNull()
      const eventLine = eventWarns.slice(eventWarnsBefore).find(w => eventPattern.test(w))!
      console.log(`stall (event): ${eventLine}`)
      expect(eventLine, 'event path does not emit long-frame text').not.toMatch(/long frame/)
      for (const w of eventWarns.slice(eventWarnsBefore)) {
        expect(w, 'event warnings leak no sentinel id, class, handler name, or button text').not.toMatch(leakPattern)
      }
    } finally {
      await eventCtx.close()
    }
    expect(errors, 'no console errors or pageerrors during guest bar row').toEqual([])
  } finally {
    await page.setViewportSize(origSize)
    await page.evaluate(() => {
      ;(window as any)._key_buttons_guests = { buttons: [] }
      ;(window as any)._key_buttons?.guest?.()
      delete (window as any)._key_buttons_guests
      delete (window as any).__guest_calls
      delete (window as any).__guest_resolve
    })
  }
})
