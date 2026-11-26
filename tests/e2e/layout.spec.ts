import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { loadAnonymous } from './helpers.js'

// column layout (see updateItemLayout in index.svelte): columnCount is max(1, floor(width / 750)),
// every visible item is rendered exactly once with per-column order following index order, and the
// hidden render column and element cache track the first column's width; this pins the layout
// math ahead of its extraction from index.svelte

const columns = (page: Page) => page.evaluate(() => document.querySelectorAll('.column:not(.hidden)').length)
// visible item ids in index order (the layout must never reorder or drop them)
const visibleIds = (page: Page) => page.evaluate(() => window.__items.slice(0, window.__hideIndex).map(item => item.id))
// rendered item ids per visible column, in dom order
const renderedByColumn = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.column:not(.hidden)')].map(column =>
      [...column.querySelectorAll('.super-container')].map(elem => elem.id.replace('super-container-', '')),
    ),
  )
const widths = (page: Page) =>
  page.evaluate(() => ({
    first: (document.querySelector('.column:not(.hidden)') as HTMLElement).offsetWidth,
    hidden: (document.querySelector('.column.hidden') as HTMLElement).offsetWidth,
    cache: document.getElementById('cache-div')!.offsetWidth,
  }))

// every visible item appears exactly once, in the column the layout assigned it (item.column,
// set by updateItemLayout and used by the template), with dom order following index order
// NOTE: multi-column DISTRIBUTION is deliberately not asserted: the seeded corpus's visible set
// stays in column zero even on fresh two-column loads (observed behavior), so distribution over
// synthetic heights belongs to the pure-layout unit tables when updateItemLayout is extracted
async function expectConsistentColumns(page: Page) {
  const ids = await visibleIds(page)
  const by_column = await renderedByColumn(page)
  const rendered = by_column.flat()
  expect(rendered.length, 'each visible item rendered exactly once').toBe(new Set(rendered).size)
  expect(new Set(rendered), 'rendered items match the visible set').toEqual(new Set(ids))
  const assigned = await page.evaluate(() =>
    Object.fromEntries(window.__items.slice(0, window.__hideIndex).map(item => [item.id, item.column])),
  )
  by_column.forEach((column, index) => {
    for (const id of column) expect(assigned[id], `item ${id} in its assigned column`).toBe(index)
    const positions = column.map(id => ids.indexOf(id))
    expect(positions, 'column order follows index order').toEqual([...positions].sort((a, b) => a - b))
  })
  return ids
}

// ONE load. The account load is the expensive part, and both cases are viewport work on top of it:
// a fresh multi-column layout at 1200 (startup sizing is its own case — starting at 900 and only
// checking widths after a resize would pass a startup bug the first reflow repairs), then the
// reflow cycle, checking at every step that the hidden render column and the element cache track
// the FIRST column's width. The recreated column div must be re-sized promptly after a reflow (the
// post-flush re-apply in updateItemLayout, not an eventual later layout pass): renders started
// right after a reflow measure against these widths, and charts skip rendering at zero width.
// THE 1200 -> 900 -> 1200 ROUND TRIP IS THE POINT OF THIS TEST: it once stalled at one column when
// both viewport changes fit inside checkLayout's 250ms resize suppression while another trigger
// laid out at 900 — checkLayout's private observed-width memo then said "width-same" forever. the
// memo now belongs to updateItemLayout, stamped after the layout core succeeds. the diagnostic
// tracing that established this is deleted (its postmortem survives in the issue doc); this round
// trip is the durable regression test.
// See issues/MindPage Column Layout Stalls After Growing Back.md
test('column layout follows viewport width, keeping items unique, ordered and correctly sized', async ({
  page,
}) => {
  const settle = (count: number) => expect.poll(() => columns(page), { timeout: 15_000 }).toBe(count)

  await page.setViewportSize({ width: 1600, height: 900 }) // floor(1600 / 750) = 2 columns
  await loadAnonymous(page)
  await settle(2)
  const ids = await expectConsistentColumns(page)
  expect(ids.length).toBeGreaterThan(2)
  const fresh = await widths(page)
  expect(fresh.hidden, 'hidden column tracks the first on a fresh multi-column load').toBe(fresh.first)
  expect(fresh.cache, 'element cache tracks the first on a fresh multi-column load').toBe(fresh.first)

  for (const [width, count] of [
    [900, 1],
    [1600, 2],
    [2400, 3],
    [1200, 1],
  ] as const) {
    await page.setViewportSize({ width, height: 900 })
    await settle(count)
    expect(await expectConsistentColumns(page)).toEqual(ids) // same visible set, reordered never
    await expect.poll(async () => (await widths(page)).hidden, { timeout: 2_000 }).toBe((await widths(page)).first)
    const sizes = await widths(page)
    expect(sizes.hidden, `hidden column tracks the first at ${width}`).toBe(sizes.first)
    expect(sizes.cache, `element cache tracks the first at ${width}`).toBe(sizes.first)
  }
})

// the floating menu placeholder (the spacer inserted by Item.svelte's afterUpdate) must match its
// item's menu (its height, and its width less the number's own left padding where the number is the
// menu's first button: MENU_INDEX_PAD, 2026-11-17): the menu size is measured once per menu shape, digit count and zoom and reused
// (menuSize), and the item's number is the menu's only per-item content, so a number of at most
// four digits gets a fixed width, one ch a digit (.index.reserved; 4ch at every count until
// 2026-11-17), and sizes the menu by its digit count alone. pinned across the 9/10 and 99/100
// boundaries and for the runnable items of the corpus's digit bands, then for the one-digit and
// four-digit cases (menus cloned in place with the number replaced: one width per digit count
// whatever the digits, the box one ch a digit, digits not overflowing) in the page's font and in
// a wider bold fallback face, where four digits exceed the web font's and the 36px reservation
// that was tried first
type SeededItem = { id: string; runnable?: unknown }
const spacerAndMenu = (page: Page, position: number) =>
  page.evaluate(async position => {
    const seeded = window.__items[position] as SeededItem
    const item = window._item(seeded.id)!
    const elem = item.elem ?? (await window._render_item(item))
    const menu = elem.querySelector('.item-menu') as HTMLElement
    const spacer = elem.querySelector('#menu-' + seeded.id) as HTMLElement
    const first = menu.firstElementChild as HTMLElement
    return {
      number: position + 1,
      runnable: !!seeded.runnable,
      // the number's left padding, where the number is the menu's first button: no room the text keeps free
      pad: first.classList.contains('index') ? parseFloat(getComputedStyle(first).paddingLeft) : 0,
      menu: [menu.clientWidth, menu.clientHeight],
      spacer: [parseFloat(spacer.style.width), parseFloat(spacer.style.height)],
    }
  }, position)
// a rendered menu cloned beside itself with the number replaced (and its digit count, as the app
// sets it with the number): the menu's width, the number box's own width (its content box), the
// number's overflow and one ch of the number's font, for narrow and wide digits of one and of
// four digits, optionally under an injected font
const clonedMenuWidths = (page: Page, font = '') =>
  page.evaluate(async font => {
    const style = document.createElement('style')
    if (font) document.head.append(Object.assign(style, { textContent: `.item-menu > .index { font: ${font} }` }))
    await document.fonts.ready
    const menu = document.querySelector('.item-menu')!
    const widths = ['1', '8', '1111', '8888'].map(text => {
      const clone = menu.cloneNode(true) as HTMLElement
      const index = clone.querySelector('.index') as HTMLElement
      index.textContent = text
      index.style.setProperty('--index-digits', String(text.length))
      menu.parentElement!.append(clone)
      const probe = document.createElement('span')
      probe.style.cssText = 'position: absolute; visibility: hidden; width: 1ch'
      index.append(probe)
      const width = {
        menu: clone.clientWidth,
        box: parseFloat(getComputedStyle(index).width),
        overflow: index.scrollWidth - index.clientWidth,
        ch: probe.getBoundingClientRect().width,
      }
      clone.remove()
      return width
    })
    style.remove()
    return widths
  }, font)

test('menu placeholders match their menus across digit boundaries, menu kinds and fonts', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await loadAnonymous(page)
  const count = await page.evaluate(() => window.__items.length)
  expect(count).toBeGreaterThan(100) // both boundaries exist
  // the first runnable item of each digit band the seeded corpus has one in (its runnable items all
  // fall in the two-digit band in display order; the boundary positions cover plain menus per band)
  const runnable = await page.evaluate(() =>
    [1, 2, 3]
      .map(digits =>
        (window.__items as SeededItem[]).findIndex((item, i) => item.runnable && String(i + 1).length == digits),
      )
      .filter(position => position >= 0),
  )
  expect(runnable.length).toBeGreaterThan(0) // in display order the corpus's runnable items fall in one band
  const positions = [...new Set([8, 9, 10, 98, 99, 100, ...runnable])].sort((a, b) => a - b)
  const sizes = []
  for (const position of positions) sizes.push(await spacerAndMenu(page, position)) // one render at a time
  expect(sizes.some(size => size.runnable) && sizes.some(size => !size.runnable)).toBe(true)
  for (const size of sizes) {
    expect(size.menu[0], `menu ${size.number} has a width`).toBeGreaterThan(0)
    expect(size.pad, `the number's padding counts for item ${size.number} alone when no run button stands before it`).toBe(size.runnable ? 0 : 4)
    expect(size.spacer, `spacer of item ${size.number} (runnable ${size.runnable})`).toEqual([size.menu[0] - size.pad, size.menu[1]])
  }
  // the one-digit and four-digit cases: a menu's width follows its number's digit COUNT and nothing
  // else of the number (what the cached size relies on), the box is one ch a digit and the digits
  // fit it, in the page's font and in a wider bold face (Verdana, installed on the gate's machine;
  // the premise asserts a wider rendered box, whatever face the browser picks, so the case cannot
  // pass vacuously)
  const fours: number[] = [] // the box of four digits, per face
  for (const face of ['', 'bold 15px Verdana']) {
    const [one, eight, ones, eights] = await clonedMenuWidths(page, face)
    fours.push(ones.box)
    const named = face || "the page's font"
    expect([eight.menu, eights.menu], `one menu width per digit count in ${named}`).toEqual([one.menu, ones.menu])
    expect(ones.menu, `four digits widen the menu in ${named}`).toBeGreaterThan(one.menu)
    for (const [digits, width] of [[1, one], [1, eight], [4, ones], [4, eights]] as const) {
      expect(width.box, `the box of ${digits} digit(s) is ${digits} ch in ${named}`).toBeCloseTo(digits * width.ch, 1)
      expect(width.overflow, `${digits} digit(s) fit their box in ${named}`).toBe(0)
    }
  }
  expect(fours[1], 'four digits are wider in the wide face').toBeGreaterThan(fours[0])
})

// the room an item keeps free for its number is the number's own (the owner's todo of 2026-11-17:
// since the fixed 4ch of 2026-09-07 a one-digit number sat in a box four digits wide, and the
// first line of the item's text ended that much earlier, which a phone's window feels most). In a
// phone's window (390 px, touch) the number's box is as wide as its digits at every digit count
// the corpus has (one ch a digit, in the menu's own font), the digits fit it and the placeholder
// keeps the menu's height and the width the text has to keep clear (the menu's, less the number's
// own left padding on these plain items). The placeholder also FOLLOWS the number: an item whose number gains a digit with
// nothing of its own changed (items ranked above it: its children are not replaced) keeps the
// placeholder it has, resized. A touched item is ranked first below the pinned ones, so the first
// one touched is counted up to 9 by the touches after it, shown by the session's toggle, and
// counted up to 10 by one more touch while it stays shown (soft touches: nothing is saved, and
// the page is this row's own)
type RankedItem = { id: string; pinned?: boolean; log?: boolean }
// `mark` marks the placeholder element it reads (once, by the caller that later asks whether a read
// found that same element: review 0); every call says whether the element it read is the marked one
const numberRoom = (page: Page, id: string, mark = false) =>
  page.evaluate(async ({ id, mark }) => {
    const item = window._item(id)!
    const elem = item.elem ?? (await window._render_item(item))
    const menu = elem.querySelector('.item-menu') as HTMLElement
    const index = menu.querySelector('.index') as HTMLElement
    const spacer = elem.querySelector('#menu-' + id) as HTMLElement & { kept?: boolean }
    const probe = document.createElement('span')
    probe.style.cssText = 'position: absolute; visibility: hidden; width: 1ch' // one ch of the number's font
    index.append(probe)
    const ch = probe.getBoundingClientRect().width
    probe.remove()
    const kept = spacer.kept === true // the placeholder element the marking call saw
    const first = menu.firstElementChild as HTMLElement
    const pad = first == index ? parseFloat(getComputedStyle(index).paddingLeft) : 0
    const digits = document.createRange()
    digits.selectNodeContents(index.firstChild!) // the number's text, without the probe
    if (mark) spacer.kept = true
    return {
      number: index.textContent!.trim(),
      shown: !!elem.closest('.column:not(.hidden)'),
      ch,
      box: parseFloat(getComputedStyle(index).width),
      overflow: index.scrollWidth - index.clientWidth,
      menu: menu.clientWidth,
      spacer: parseFloat(spacer.style.width),
      room: menu.clientWidth - pad, // the placeholder's width: the menu's, less the number's left padding
      clear: digits.getBoundingClientRect().left - spacer.getBoundingClientRect().left, // from the text's limit to the digits
      kept,
    }
  }, { id, mark })

// how near the TEXT of items comes to what their menus show (the number's digits, and the run button
// before them on a runnable item), in one pass over the positions given that the corpus has: over the
// text nodes of an item's content, the line boxes that stand beside one of the two (the same lines,
// by more than 2 px), the smallest distance from a line's right end to its left edge. Infinity when
// no line stands beside them (an item that starts with a block of its own); a short first line gives
// a large distance. The content's own box is no measure: it spans the item's width, under the number
// (the owner, 2026-11-17: "in inspector i see the content div touching or even almost overlapping
// the digit")
const textToMenu = (page: Page, positions: number[]) =>
  page.evaluate(async positions => {
    const gaps: { runnable: boolean; nearest: number }[] = []
    for (const position of positions) {
      const seeded = window.__items[position] as SeededItem | undefined
      if (!seeded) continue // past the corpus's end
      const item = window._item(seeded.id)!
      const elem = item.elem ?? (await window._render_item(item))
      const menu = elem.querySelector('.item-menu') as HTMLElement
      const digits = document.createRange()
      digits.selectNodeContents((menu.querySelector('.index') as HTMLElement).firstChild!)
      const first = menu.firstElementChild as HTMLElement
      const runnable = !first.classList.contains('index') // the run button stands before the number
      const shown = [digits.getBoundingClientRect(), ...(runnable ? [first.getBoundingClientRect()] : [])]
      let nearest = Infinity
      const walker = document.createTreeWalker(elem.querySelector('.item')!, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent!.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const line of range.getClientRects())
          for (const box of shown)
            if (line.width && line.bottom > box.top + 2 && line.top < box.bottom - 2) nearest = Math.min(nearest, box.left - line.right)
      }
      gaps.push({ runnable, nearest })
    }
    return gaps
  }, positions)

test("an item's number keeps free the room of its own digits, and its placeholder follows it", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await loadAnonymous(page)
  expect(
    await page.evaluate(() => [innerWidth, matchMedia('(max-width: 400px)').matches, 'ontouchstart' in window]),
    "a phone's window: 390 px, the narrow styles, touch",
  ).toEqual([390, true, true])
  expect(await page.evaluate(() => window.__items.length)).toBeGreaterThan(100) // numbers of one, two and three digits
  for (const position of [0, 8, 9, 98, 99, 100]) {
    const room = await numberRoom(page, await page.evaluate(position => window.__items[position].id, position))
    const digits = String(position + 1).length
    expect(room.number, `the number of the item at position ${position}`).toBe(String(position + 1))
    expect(room.ch, 'one ch of the number').toBeGreaterThan(0)
    expect(room.box, `the box of ${room.number} is as wide as its digits (${digits} ch)`).toBeCloseTo(digits * room.ch, 1)
    expect(room.overflow, `the digits of ${room.number} fit their box`).toBe(0)
    expect(room.spacer, `the placeholder of ${room.number} is its menu's, less the number's own padding`).toBe(room.room)
    expect(room.spacer, `the placeholder of ${room.number} is narrower than its menu`).toBeLessThan(room.menu)
    expect([room.clear > 2, room.clear < 5], `the text comes to about 3 px from the digits of ${room.number} (${room.clear})`).toEqual([true, true])
  }
  // the text itself wraps before the menu: over the first 120 items of the corpus (numbers of one to
  // three digits) and its first runnable ones, no line that stands beside the digits or the run button
  // reaches them, and some lines come near (within 14 px: the check is not empty)
  const runnable = await page.evaluate(() => (window.__items as SeededItem[]).flatMap((item, position) => (item.runnable ? [position] : [])))
  const gaps = await textToMenu(page, [...new Set([...Array(120).keys(), ...runnable.slice(0, 20)])])
  const beside = gaps.filter(gap => Number.isFinite(gap.nearest))
  const nearest = (runnable: boolean) => Math.min(...beside.filter(gap => gap.runnable == runnable).map(gap => gap.nearest))
  console.log(
    `layout: text beside the menu on ${beside.length} of ${gaps.length} items (${beside.filter(gap => gap.runnable).length} runnable), ` +
      `nearest ${nearest(false).toFixed(2)} px to a number and ${nearest(true).toFixed(2)} px to a run button, ` +
      `within 14 px on ${beside.filter(gap => gap.nearest < 14).length}`,
  )
  expect(beside.filter(gap => !gap.runnable).length, 'plain items whose text stands beside their number').toBeGreaterThan(20)
  expect(beside.filter(gap => gap.runnable).length, 'runnable items whose text stands beside their menu').toBeGreaterThan(0)
  expect([nearest(false) > 1, nearest(true) > 1], `no text reaches its item's number (${nearest(false)}) or run button (${nearest(true)})`).toEqual([true, true])
  expect(beside.filter(gap => gap.nearest < 14).length, 'some first lines run up to their menu').toBeGreaterThan(0)

  // the first item touched is ranked right below the pinned ones, and each touch after it counts it
  // up by one (in the page's own list: a touched item is offered by the session's toggle, not shown)
  const [followed, ...others] = await page.evaluate(() =>
    (window.__items as RankedItem[]).filter(item => !item.pinned && !item.log).slice(-12).map(item => item.id),
  )
  const touch = (id: string) => page.evaluate(id => void (window._item(id) as unknown as { touch: () => void }).touch(), id)
  const position = (id: string) => page.evaluate(id => window.__items.findIndex(item => item.id == id), id)
  const numberOf = (id: string) =>
    page.evaluate(id => Number(window._item(id)!.elem?.querySelector('.item-menu .index')?.textContent ?? NaN), id)
  await touch(followed)
  await expect.poll(() => position(followed), 'the touched item is ranked below the pinned ones').toBeLessThan(8)
  let touched = 1
  for (let at = await position(followed); at < 8; at++, touched++) {
    await touch(others.shift()!)
    await expect.poll(() => position(followed), 'an item touched after it counts it up by one').toBe(at + 1)
  }
  // the session's toggle, the first one below the pinned items, shows the touched items, the first
  // one touched as number 9; one more touch changes the shown ranking, which shows the session's
  // items again, that one as number 10
  const toggle = page.locator('.toggle.show').first()
  await expect(toggle).toContainText(`show ${touched} items`)
  await toggle.click()
  await expect.poll(() => numberOf(followed)).toBe(9)
  const nine = await numberRoom(page, followed, true) // marks the placeholder shown at number 9
  expect([nine.number, nine.shown, nine.spacer], 'the item is shown as number 9, its placeholder its menu\'s less the padding').toEqual(['9', true, nine.room])
  await touch(others.shift()!)
  await expect.poll(() => numberOf(followed)).toBe(10)
  // identity and width in ONE read, and no read marks: a replacement of the right size is no pass
  await expect.poll(async () => (room => room.kept && room.spacer == room.room)(await numberRoom(page, followed)), { message: 'the marked placeholder follows the number to two digits', timeout: 5_000 }).toBe(true)
  const ten = await numberRoom(page, followed)
  expect([ten.number, ten.shown, ten.kept], 'the same placeholder, in the item still shown: its children were not replaced').toEqual(['10', true, true])
  expect(ten.menu, 'a second digit widens the menu').toBeGreaterThan(nine.menu)
  await context.close()
})

// THE RUNNING MARK (the owner's todo of 2026-11-18: "replace running border style with a circle
// indicator next to the item number"; and of the dimming, "should also go"). An item that runs is
// marked by a small ring in the blue its border had, left of its number, and by nothing else: its
// border keeps the colour it had and no overlay dims it. The ring takes no room of the menu, whose
// size the app measures once for all items of a shape: it is drawn in 18 px left of the digits,
// which the text's placeholder keeps free with a padding while the item runs and a run button
// leaves by moving aside. The ring is ALL a running item shows (the owner, 2026-11-19: the status
// line at the item's bottom, which "goes between log lines and the toggles", and the bar under it
// go): the status is the ring's tooltip, `running` alone without one, and a progress fills the ring
// clockwise from the top, standing still; with none, or at 0, it turns. The ring is an element of
// its own for that (it has a title and takes a tap), and stands on the number's baseline as the
// watched sparkle does. (The ring in the editor, the two marks side by side and the overlay of an
// item that is being saved are the watched mark's row, tests/e2e/sparkle.spec.ts, on an account
// that can edit and save.)
const BLUE = 'rgb(68, 170, 255)' // #4af
// marks as measured against their boxes' own edges: as many, and every edge within two pixels (a
// pixel for the whole pixels the hit test reads, and one more that a box at a fractional place
// read: the cloned five-digit menu's mark, 1.28 px wide of its edge)
const marksAre = (marks: number[][], boxes: number[][]) =>
  marks.length == boxes.length && marks.every((mark, at) => mark.every((edge, side) => Math.abs(edge - boxes[at][side]) < 2))
// the boxes drawn left of a number's own box, found by a hit test along the number's middle line
// (a pseudo-element answers as its element, and the ring is the number's child): each as [from, to], px left of the digits, the
// nearest first, read off whole pixels (so each edge can read up to a pixel wide of the box's
// own: `marksAre` compares within that). The ring is measured standing still: a hit test reads a
// turning box up to 2 px wide of it. Given to the page once (`window.__marksLeftOf`), for the
// row's readers
function marksLeftOf(index: HTMLElement): number[][] {
  const digits = document.createRange()
  digits.selectNodeContents(index.firstChild!)
  const [number, own] = [digits.getBoundingClientRect(), index.getBoundingClientRect()]
  const still = document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '.running-mark::before { animation: none !important }' }))
  const marks: number[][] = [] // pixel by pixel leftwards from the number's own box: [left edge of the first pixel hit, right edge of the last]
  for (let k = 1, pixel = Math.floor(own.left) - 1; k <= 70; k++, pixel--) {
    if (!index.contains(document.elementFromPoint(pixel + 0.5, (own.top + own.bottom) / 2))) continue
    const last = marks[marks.length - 1]
    if (last && last[0] == number.left - pixel - 1) last[0] = number.left - pixel
    else marks.push([number.left - pixel, number.left - pixel - 1])
  }
  still.remove()
  return marks
}
type Scanning = { __marksLeftOf: typeof marksLeftOf; __stateCircles?: typeof stateCircles }
// what an item's box shows of running, read off the item in the SHOWN column (an element can be
// mounted in the offscreen render column alone) and found again after the frames it waits. `text` is how far left of the digits the nearest
// line of the item's text ends, of the lines that stand beside the number; `run` the same for a
// run button's two edges; `parts` the box's own children, by their first class (a status line was one)
const runningLook = (page: Page, id: string) =>
  page.evaluate(async id => {
    const shown = () => document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`) as HTMLElement
    shown().scrollIntoView({ block: 'center' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const box = shown()
    const [menu, index, spacer, loading] = ['.item-menu', '.item-menu > .index', '.item > [id^="menu-"]', ':scope > .loading'].map(part => box.querySelector(part) as HTMLElement) // (the box's own: an item's html can hold these classes)
    const mark = index.querySelector(':scope > .running-mark') as HTMLElement | null // the ring's element: after the digits, shown before them
    const digits = document.createRange()
    digits.selectNodeContents(index.firstChild!)
    const [number, own, whole] = [digits.getBoundingClientRect(), index.getBoundingClientRect(), box.getBoundingClientRect()]
    const ring = mark && getComputedStyle(mark, '::before')
    const turning = !!ring && ring.animationName != 'none' // read before the measure stops it
    const marks = (window as unknown as Scanning).__marksLeftOf(index)
    let text = Infinity
    const walker = document.createTreeWalker(box.querySelector('.item')!, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent!.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const line of range.getClientRects()) if (line.width && line.bottom > own.top + 2 && line.top < own.bottom - 2) text = Math.min(text, number.left - line.right)
    }
    const run = menu.querySelector('.run')?.getBoundingClientRect()
    const placed = getComputedStyle(spacer)
    const middle = document.elementFromPoint((whole.left + whole.right) / 2 - 40, (whole.top + whole.bottom) / 2)
    return {
      running: box.classList.contains('running'),
      bordered: box.classList.contains('bordered'),
      border: getComputedStyle(box).borderTopColor,
      overlay: getComputedStyle(loading).visibility,
      covered: !!middle?.closest('.loading'), // something of the overlay lies over the item's middle
      // (the stroke's style and width too: without them a transparent box still turns, hit-tests and reports the colour)
      ring: ring ? [ring.width, ring.borderTopStyle, ring.borderTopWidth, ring.borderTopColor, ring.borderRadius, turning] : null,
      // how the ring is placed: an inline box on the baseline of its element's line, 2 px down, in the number's own font
      placed: ring ? [ring.display, ring.verticalAlign, ring.top, getComputedStyle(mark!).font == getComputedStyle(index).font] : null,
      // its fill: the class, and how far its gradient says (none while it turns)
      fill: ring ? [mark!.classList.contains('filled'), ring.backgroundImage.match(/^conic-gradient\(rgb\(68, 170, 255\) ([\d.]+)%/)?.[1] ?? null] : null,
      title: mark ? mark.title : null, // the tooltip
      noted: mark ? [mark.classList.contains('noted'), getComputedStyle(mark, '::after').content] : null, // the note of a tap
      marks,
      room: [placed.marginLeft, placed.paddingLeft],
      placeholder: [parseFloat(spacer.style.width), menu.clientWidth],
      text,
      run: run ? [Math.round(number.left - run.right), Math.round(number.left - run.left)] : null, // a run button's right and left edge
      height: whole.height,
      // the height the layout holds for the item (index.svelte, onItemResized) against the box's own
      stored: [(window.__items.find(item => item.id == id) as unknown as { height: number }).height, box.offsetHeight],
      parts: [...box.children].map(part => part.classList[0]),
    }
  }, id)
// the first item the page's first view shows: its box in a shown column and not held offscreen
// (an item beyond the fold is mounted `.hidden`, 100,000 px to the left)
const firstShown = (page: Page) => page.evaluate(() => (document.querySelector('.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id]') as HTMLElement).dataset.itemId!)
// the ring and the digits BY PIXELS: a screenshot of the number's line, from the ring to the
// digits' end, read in the page (a canvas), with the ring standing still. `ring` and `digits` are
// the rows each inks, [first, past the last], from the clip's top (blue for the ring, bright and
// not blue for the digits, grey or green); `bright` says of each quarter of the ring, clockwise
// from the top (upper right, lower right, lower left, upper left), whether it is the bright blue
// (the rest of a ring is that blue at 30%), leaving out a pixel on each side of its two axes;
// `hollow` that nothing of the ring is inked within 2 px of its middle (a disc is: a filled ring
// that lost its mask keeps its bounds and its quarters)
const ringInk = async (page: Page, id: string) => {
  const still = await page.addStyleTag({ content: '.running-mark::before { animation: none !important }' })
  const clip = await page.evaluate(async id => {
    const index = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu > .index`) as HTMLElement
    index.scrollIntoView({ block: 'center' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const [mark, own] = [index.querySelector('.running-mark')!.getBoundingClientRect(), index.getBoundingClientRect()]
    return { x: Math.floor(mark.left) - 2, y: Math.floor(own.top) - 2, width: Math.ceil(own.right) - Math.floor(mark.left) + 2, height: Math.ceil(own.height) + 4, split: Math.ceil(mark.right) - Math.floor(mark.left) + 3 }
  }, id)
  const png = (await page.screenshot({ clip })).toString('base64')
  await still.evaluate(style => (style as Element).remove())
  return page.evaluate(async ([png, split]) => {
    const image = new Image()
    image.src = 'data:image/png;base64,' + png
    await image.decode()
    const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height })
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const { data, width, height } = context.getImageData(0, 0, image.width, image.height)
    const [ring, digits]: [number, number, number][][] = [[], []] // x, y, the blue channel
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const [r, g, b] = [0, 1, 2].map(channel => data[4 * (y * width + x) + channel])
        if (x < split && b - r > 25) ring.push([x, y, b])
        else if (x >= split && b - r < 25 && g > 40) digits.push([x, y, g])
      }
    const most = Math.max(...digits.map(pixel => pixel[2])) // (a digit's ink: more than half of its own brightest pixel)
    const rows = (inked: number[][]) => [Math.min(...inked.map(pixel => pixel[1])), Math.max(...inked.map(pixel => pixel[1])) + 1]
    const [left, right] = [Math.min(...ring.map(pixel => pixel[0])), Math.max(...ring.map(pixel => pixel[0])) + 1]
    const [top, bottom] = rows(ring)
    const quarter = (east: boolean, south: boolean) =>
      ring.filter(([x, y, b]) => b > 200 && (east ? x + 0.5 > (left + right) / 2 + 1 : x + 0.5 < (left + right) / 2 - 1) && (south ? y + 0.5 > (top + bottom) / 2 + 1 : y + 0.5 < (top + bottom) / 2 - 1)).length > 2
    const hollow = !ring.some(([x, y]) => Math.abs(x + 0.5 - (left + right) / 2) < 2 && Math.abs(y + 0.5 - (top + bottom) / 2) < 2)
    return { ring: [top, bottom], wide: right - left, digits: rows(digits.filter(pixel => pixel[2] - 17 > (most - 17) / 2)), bright: [quarter(true, false), quarter(true, true), quarter(false, true), quarter(false, false)], hollow }
  }, [png, clip.split] as const)
}

// THE RING, THE STATE CIRCLES AND THE DIGITS BY PIXELS, as `ringInk` reads the ring: a screenshot
// of the number's line from the ring (without one, from 56 px left of the number's box, past both
// circles) to the digits' end, read in the page, the ring standing still. Each mark's rows, [first, past the last], from the clip's top, and its columns as [from,
// to] px left of the digits' box (blue for the ring, the orange #a52 for the pushable circle, the
// pink #c7c for the previewable one; the digits are what is bright right of the digits' box's
// left edge, as `ringInk` reads them). And of each mark, whether its middle is empty (`hollow`:
// none of its ink within 2 px of the middle of its bounds, as `ringInk` reads the ring) and its
// STROKE across its middle line: the runs of its ink there, left to right, and the colour of the
// strongest pixel of them (the reddest), which a classifier of hues alone does not tell from
// another of the same hue (the push button's #f84 passes for the orange)
const marksInk = async (page: Page, id: string) => {
  const still = await page.addStyleTag({ content: '.running-mark::before { animation: none !important }' })
  const clip = await page.evaluate(async id => {
    const index = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu > .index`) as HTMLElement
    index.scrollIntoView({ block: 'center' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const [mark, own] = [index.querySelector('.running-mark')?.getBoundingClientRect(), index.getBoundingClientRect()]
    const digits = document.createRange()
    digits.selectNodeContents(index.firstChild!)
    const left = mark ? Math.floor(mark.left) - 2 : Math.floor(own.left) - 56
    return { x: left, y: Math.floor(own.top) - 2, width: Math.ceil(own.right) - left, height: Math.ceil(own.height) + 4, digits: digits.getBoundingClientRect().left - left }
  }, id)
  const png = (await page.screenshot({ clip })).toString('base64')
  await still.evaluate(style => (style as Element).remove())
  return page.evaluate(async ([png, at]) => {
    const image = new Image()
    image.src = 'data:image/png;base64,' + png
    await image.decode()
    const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height })
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const { data, width, height } = context.getImageData(0, 0, image.width, image.height)
    const inked: Record<string, number[][]> = { ring: [], pushable: [], previewable: [], digits: [] } // x, y, and the colour (for the digits the green channel alone)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const [r, g, b] = [0, 1, 2].map(channel => data[4 * (y * width + x) + channel])
        if (x + 0.5 > at) {
          if (b - r < 25 && g > 40) inked.digits.push([x, y, g])
        } else if (b - r > 25) inked.ring.push([x, y, r, g, b])
        else if (r - b > 50 && g < 0.7 * r) inked.pushable.push([x, y, r, g, b])
        else if (r - g > 40 && b - g > 40) inked.previewable.push([x, y, r, g, b])
      }
    const most = Math.max(...inked.digits.map(pixel => pixel[2])) // (a digit's ink: more than half of its own brightest pixel)
    inked.digits = inked.digits.filter(pixel => pixel[2] - 17 > (most - 17) / 2)
    return Object.fromEntries(
      Object.entries(inked).map(([mark, pixels]) => {
        if (!pixels.length) return [mark, null]
        const [xs, ys] = [pixels.map(pixel => pixel[0]), pixels.map(pixel => pixel[1])]
        const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs) + 1, Math.min(...ys), Math.max(...ys) + 1]
        const found = { rows: [top, bottom], wide: right - left, cols: [at - left, at - right] }
        if (mark == 'digits') return [mark, found]
        const middle = top + Math.floor((bottom - top) / 2) // (the 8th of 15 rows: the circle's middle runs through it)
        const across = pixels.filter(pixel => pixel[1] == middle).sort((one, other) => one[0] - other[0])
        const runs: number[] = []
        across.forEach((pixel, at) => (at && pixel[0] == across[at - 1][0] + 1 ? runs[runs.length - 1]++ : runs.push(1)))
        const strongest = across.reduce((best, pixel) => (pixel[2] > best[2] ? pixel : best), across[0] ?? [0, 0, 0, 0, 0])
        const hollow = !pixels.some(([x, y]) => Math.abs(x + 0.5 - (left + right) / 2) < 2 && Math.abs(y + 0.5 - (top + bottom) / 2) < 2)
        return [mark, { ...found, hollow, stroke: { runs, colour: strongest.slice(2) } }]
      }),
    ) as Record<'ring' | 'pushable' | 'previewable' | 'digits', { rows: number[]; wide: number; cols: number[]; hollow?: boolean; stroke?: { runs: number[]; colour: number[] } } | null>
  }, [png, clip.digits] as const)
}

// a number BEYOND FOUR DIGITS, as the app renders one: the item's menu cloned over itself with
// 12345 and without the reserved class. Its width, the marks left of its number, the state
// circles (the state circles' row; null where the page was not given their reader) and how far
// before the digits a run button ends
const fiveDigits = (page: Page, id: string) =>
  page.evaluate(id => {
    const menu = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu`) as HTMLElement
    const clone = menu.cloneNode(true) as HTMLElement
    const index = clone.querySelector('.index') as HTMLElement
    index.firstChild!.textContent = '12345'
    index.classList.remove('reserved')
    index.style.removeProperty('--index-digits')
    menu.parentElement!.append(clone) // over the menu itself: the same place, and on top
    const digits = document.createRange()
    digits.selectNodeContents(index.firstChild!)
    const found = {
      reserved: getComputedStyle(index).justifyContent, // (the reserved width's rule packs the digits at the end)
      menu: clone.clientWidth,
      marks: (window as unknown as Scanning).__marksLeftOf(index),
      circles: (window as unknown as Scanning).__stateCircles?.(clone) ?? null,
      run: Math.round(digits.getBoundingClientRect().left - clone.querySelector('.run')!.getBoundingClientRect().right),
    }
    clone.remove()
    return found
  }, id)

test('a running item is marked by a circle left of its number and by nothing else: its status is the circle\'s tooltip, its progress the circle\'s fill', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await loadAnonymous(page)
  await page.addScriptTag({ content: `window.__marksLeftOf = ${marksLeftOf.toString()}` })
  // an item whose first line runs up to its number, and a runnable one: of each kind, the one of
  // the corpus's first 120 whose text comes nearest to its menu
  const gaps = await textToMenu(page, [...Array(120).keys()])
  const at = (runnable: boolean) => gaps.reduce((best, gap, at) => (gap.runnable == runnable && gap.nearest < (gaps[best]?.nearest ?? Infinity) ? at : best), -1)
  expect([at(false) >= 0, at(true) >= 0], 'a plain and a runnable item with text beside the menu').toEqual([true, true])
  const [plain, runnable] = await page.evaluate(positions => positions.map(position => window.__items[position].id), [at(false), at(true)])
  const run = (id: string, running: boolean) => page.evaluate(([id, running]) => void ((window._item(id) as unknown as { running: boolean }).running = running), [id, running] as const)
  const shown = (id: string, running: boolean) =>
    expect
      .poll(() => page.evaluate(([id, running]) => !!document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]${running ? '.running' : ':not(.running)'}`), [id, running] as const), { timeout: 30_000 })
      .toBe(true)

  // (an item is shown, wherever it ranks, as the one the address names: its place in the page is
  // then the same whether it runs or not)
  const open = async (id: string) => {
    await page.evaluate(id => void (location.hash = id), id)
    await shown(id, false)
  }

  // not running: no ring, no room, and the text within 14 px of the digits
  await open(plain)
  const idle = await runningLook(page, plain)
  const PARTS = ['item-menu', 'item', 'loading'] // an item's box holds its menu, its text and the saving overlay
  expect([idle.ring, idle.marks, idle.room, idle.overlay, idle.title, idle.parts], 'an item that does not run').toEqual([null, [], ['0px', '0px'], 'hidden', null, PARTS])
  expect([idle.text > 1, idle.text < 14], `its first line runs up to its number (${idle.text})`).toEqual([true, true])

  // running: the ring, 15 px wide and 3 px from the digits, in room the placeholder's padding
  // keeps free; the menu and the placeholder's own width as they were; the border as it was, and
  // no overlay
  await run(plain, true)
  await shown(plain, true)
  const ran = await runningLook(page, plain)
  expect(ran.ring, 'the ring: 15 px, a solid stroke of 2 px in the blue of the border that went, round, turning').toEqual(['15px', 'solid', '2px', BLUE, '50%', true])
  expect(marksAre(ran.marks, [[18, 4]]), `one mark, in the 18 px left of the digits (its last pixel is inside the number's own box, which begins 4 px before them): ${JSON.stringify(ran.marks)}`).toBe(true)
  expect([ran.room, ran.placeholder], 'its room is the placeholder\'s padding, and the menu is not resized').toEqual([['0px', '18px'], idle.placeholder])
  expect(ran.text, 'the text, which reached into those 18 px, keeps out of them').toBeGreaterThanOrEqual(18 + 1)
  expect([ran.border, ran.bordered, ran.overlay, ran.covered], 'the border is not blue (it is as it was), and nothing dims the item').toEqual([idle.border, idle.bordered, 'hidden', false])
  expect(ran.border).not.toBe(BLUE)

  // WHERE THE RING STANDS: on the number's baseline, lowered 2 px, as the watched sparkle's image
  // (an inline box in a line of the number's own font, and that line is centred in the number's
  // box as the digits' line is), so the browser rounds the ring and the digits to the pixel grid
  // together. Here its construction and its size by pixels; where its ink lies against the
  // digits' is the next row's, in the app's own font (a lane's stand-in font has an ascent under
  // the ring's 15 px, so the ring makes its line taller than the digits' there, as the sparkle's
  // image does: it ended 3 px under the digits in this lane where it ends 2 in Open Sans)
  expect(ran.placed, 'the ring is an inline box on the baseline of a line of the number\'s font, 2 px down').toEqual(['inline-block', 'baseline', '2px', true])
  const turning = await ringInk(page, plain)
  expect([turning.ring[1] - turning.ring[0], turning.wide, turning.bright, turning.hollow], `the ring's ink: 15 px high and wide, with nothing inked at its middle; stopped where its turn begins, its upper quarter is the bright one (${JSON.stringify(turning)})`).toEqual([15, 15, [true, false, false, true], true])

  // THE STATUS IS THE RING'S TOOLTIP, and nothing else of the item changes with it: no line at
  // the item's bottom (the box's children are what they were), no room for one (the box's height
  // and the height the layout holds for it), the ring as it was. A status is html, as item code
  // has always written it: the tooltip is its text, a <br> and the end of a block a line break,
  // an escaped text unescaped; a status with nothing to read says what no status says. The status
  // is read back as the status line held it (the accessors' row, below: the browser's own html
  // for it, where an escaped quote reads as the quote)
  const say = (status: string | null, progress: number | null, id = plain) =>
    page.evaluate(([id, status, progress]) => {
      const item = window._item(id) as unknown as { status: string; progress: number }
      if (status !== null) item.status = status
      if (progress !== null) item.progress = progress
    }, [id, status, progress] as const)
  const read = (id = plain) => page.evaluate(id => (item => [item.status, item.progress])(window._item(id) as unknown as { status: string; progress: number }), id)
  // (the mark's own attribute, or null without a mark: a poll of it costs no measure of the item)
  const titled = (id = plain) => page.evaluate(id => document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu .running-mark`)?.getAttribute('title') ?? null, id)
  const tipped = (title: string | null, id = plain) => expect.poll(() => titled(id), { timeout: 15_000 }).toBe(title)
  expect([ran.title, ran.parts, ran.fill, await read()], 'no status: the tooltip says that the item runs').toEqual(['running', PARTS, [false, null], ['', null]])
  await expect.poll(async () => (await runningLook(page, plain)).stored, 'the premise: the stored height is the running box\'s').toEqual([ran.stored[1], ran.stored[1]])
  const LONG = 'a status that is much longer than the item is wide '.repeat(6).trim()
  for (const [html, text, held = html] of [
    ['waiting for the lanes …', 'waiting for the lanes …'],
    [LONG, LONG],
    ['t:1 u:2 r:0.5 <br>a:3/4 (75%)', 't:1 u:2 r:0.5\na:3/4 (75%)'],
    ['<div>first part</div><div>second   part</div>', 'first part\nsecond part'],
    ['Searching web for &#39;a &lt;b&gt; &amp; c&#39;', "Searching web for 'a <b> & c'", "Searching web for 'a &lt;b&gt; &amp; c'"],
    ['<progress value="0.4"></progress> working', 'working'],
    ['<!--pending-->', 'running'],
    ['<img src="data:image/png;base64,AAAA" onerror="window.__status_ran = true">loading', 'loading'],
  ] as const) {
    await say(html, null)
    await tipped(text)
    const told = await runningLook(page, plain)
    expect([told.parts, told.height, told.stored, told.ring, (await read())[0]], `no line and no room for the status ${html}`).toEqual([PARTS, ran.height, ran.stored, ran.ring, held])
  }
  // (a status is read in an inert document: nothing of it loads or runs. The image's error would
  // have come within a frame or two of its parsing)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))))
  expect(await page.evaluate(() => (window as unknown as { __status_ran?: boolean }).__status_ran ?? null), 'nothing of a status ran').toBeNull()
  await run(plain, false)
  await shown(plain, false)
  expect((look => [look.ring, look.title, look.height, look.parts])(await runningLook(page, plain)), 'the item no longer runs: no ring and no tooltip, whatever the status').toEqual([null, null, idle.height, PARTS])
  await run(plain, true)
  await shown(plain, true)
  await tipped('loading') // the status it has, on the new ring

  // A PROGRESS FILLS THE RING, clockwise from the top: the ring stands still, bright as far as
  // the progress says and the same blue at 30% beyond, a full ring at 1; it stands where the
  // turning one does, a ring still (nothing inked at its middle: the gradient is cut to the
  // stroke); a smaller fraction after a larger takes the fill back. At 0, which is what
  // clear_status writes and the #vault item for a run without a progress, and with none, the
  // ring turns. Read off the ring's own gradient and off its pixels, a quarter at a time
  const filled = async (progress: number, fill: string | null) => {
    await say(null, progress)
    await expect.poll(async () => (await runningLook(page, plain)).fill, { message: `the fill at ${progress}`, timeout: 15_000 }).toEqual([fill !== null, fill])
    return { look: await runningLook(page, plain), ink: await ringInk(page, plain) }
  }
  const none = await filled(0, null)
  expect([none.look.ring, none.ink.bright, (await read())[1]], 'a progress of 0 is none: the ring turns, as with no progress').toEqual([ran.ring, [true, false, false, true], 0])
  for (const [progress, fill, bright] of [[0.25, '25', [true, false, false, false]], [0.5, '50', [true, true, false, false]], [1, '100', [true, true, true, true]], [0.25, '25', [true, false, false, false]]] as const) {
    const part = await filled(progress, fill)
    expect(part.look.ring, `at ${progress} the ring stands still, its stroke the gradient's under a border that keeps its width`).toEqual(['15px', 'solid', '2px', 'rgba(0, 0, 0, 0)', '50%', false])
    expect([part.ink.bright, part.ink.hollow, part.ink.ring, part.ink.wide], `at ${progress}: bright from the top clockwise (upper right, lower right, lower left, upper left), a ring with nothing inked at its middle, and where the turning ring stands (${JSON.stringify(part.ink)})`).toEqual([bright, true, turning.ring, 15])
    expect([part.look.height, part.look.parts, part.look.title, (await read())[1]], 'nothing else of the item changes, and the progress is read back').toEqual([ran.height, PARTS, 'loading', progress])
  }
  expect(await page.evaluate(id => { try { return void ((window._item(id) as unknown as { progress: number }).progress = 1.5) } catch (e) { return String(e) } }, plain), 'a progress beyond 1 is refused, as it was').toBe('Error: invalid progress 1.5')
  await page.evaluate(id => (window._item(id) as unknown as { clear_status: () => void }).clear_status(), plain)
  await tipped('running')
  const cleared = await runningLook(page, plain)
  expect([cleared.ring, cleared.fill, await read()], 'cleared: the ring turns again, and the tooltip says only that the item runs').toEqual([ran.ring, [false, null], ['', 0]])
  expect((await ringInk(page, plain)).bright, 'and its pixels are the turning ring\'s').toEqual([true, false, false, true])
  // a progress with no status: the fill, under a tooltip that says only that the item runs
  const bare = await filled(0.5, '50')
  expect([bare.look.title, bare.ink.bright, bare.ink.hollow, await read()], 'a progress of 0.5 and an empty status: half a ring, and the tooltip `running`').toEqual(['running', [true, true, false, false], true, ['', 0.5]])
  await filled(0, null)

  // WHAT A WRITE COSTS (the first code review, 2026-11-19): a changed title and a changed fill
  // reach their ring, and NO item's height is read for it, the item's own included. The status
  // and the progress are written on the item's record and on its mark, and no component is
  // updated. In the change's first version they were assigned to the route's list, which
  // invalidates it whole: every mounted item was updated, and each update scheduled a check of
  // its item's height (its logs scanned, its offsetHeight read), for every title and every
  // fraction a writer reported. What is counted: the reads of an item box's offsetHeight, through
  // the prototype's own accessor, over two frames and 100 ms, before the write (the page is
  // settled: none) and after it. IF THIS STEP EVER FLAKES: the route's refresh of the time labels
  // (every ten seconds) can invalidate the list in either window. Retry it a bounded number of
  // times with a FRESH title and fraction each time (an update of every item for a write comes
  // with every write; an incidental refresh does not come back at once); a retry of the identical
  // values would hide the regression, since a value that has not changed is not written at all
  const cost = await page.evaluate(async id => {
    const settled = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))
    await settled()
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    const read: string[] = []
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.matches('.container[data-item-id]')) read.push(this.dataset.itemId!)
        return own.get!.call(this)
      },
    })
    try {
      const mounted = [...document.querySelectorAll('.container[data-item-id]')].map(box => (box as HTMLElement).dataset.itemId!)
      await settled()
      const before = [...new Set(read.splice(0))]
      const item = window._item(id) as unknown as { status: string; progress: number }
      item.status = 'a title that changed'
      item.progress = 0.75
      await settled()
      const mark = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu .running-mark`) as HTMLElement
      return { neighbors: mounted.filter(other => other != id).length > 0, before, read: [...new Set(read)].length, mark: [mark.title, mark.classList.contains('filled'), mark.style.getPropertyValue('--running-mark-fill')] }
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', own)
    }
  }, plain)
  expect(cost, 'a title and a fraction reach the ring, and no item\'s height is read: not a neighbor\'s, not its own').toEqual({ neighbors: true, before: [], read: 0, mark: ['a title that changed', true, '75.000%'] })
  await page.evaluate(id => (window._item(id) as unknown as { clear_status: () => void }).clear_status(), plain)
  await tipped('running')

  // a click on the ring where a pointer hovers (this page): nothing. No note (the tooltip does
  // that job), no editor, and no click on the number, which on this item, the one the address
  // names, would set its time to now
  const clicked = () => page.evaluate(id => (raw => [raw.time, !!raw.editing, (window as unknown as { _history_index: number })._history_index])(window.__items.find(item => item.id == id) as unknown as { time: number; editing: boolean }), plain)
  const [before, spot] = [await clicked(), await page.evaluate(id => (box => [box.left + box.width / 2, box.top + box.height / 2])(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .running-mark`)!.getBoundingClientRect()), plain)]
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches), 'the premise: a pointer hovers here').toBe(false)
  await page.mouse.click(spot[0], spot[1])
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve)))))
  expect([await clicked(), (await runningLook(page, plain)).noted], 'a click on the ring: the item as it was, and no note').toEqual([before, [false, 'none']])
  await run(plain, false)
  await shown(plain, false)
  expect({ ...(await runningLook(page, plain)), stored: idle.stored }, 'no longer running: everything as before').toEqual(idle)

  // A RUN'S PROGRESS IS THAT RUN'S ON THE RING (the first code review, 2026-11-19). A writer need
  // not clear what it reports: the sampler's `show_status(html, r)` skips an r of 0 and leaves
  // its last fraction on the item, and a run that writes a status alone writes no progress. A
  // ring that kept showing the last fraction began the item's next run filled: a full ring on an
  // item that had only just started, where the released spinner turned. So what the ring shows
  // of a progress goes when the item's last running reference is released, and the next run's
  // ring turns until that run reports a progress (unless a positive progress was written while the
  // item did not run: the next run's ring begins with that one); the progress itself is still READ
  // as the line kept it. The runs here are the app's own (`_Item.start`: the count raised, the work, the
  // count lowered in its `finally`, on a failure too), their writes the sampler's
  // (`show_status(html, r)`), each held open by the row until it lets it end.
  // what the mark shows: its title, whether it is filled and how far, and whether it turns
  const onMark = (id = plain) =>
    page.evaluate(id => (mark => (mark ? [mark.title, mark.classList.contains('filled'), mark.style.getPropertyValue('--running-mark-fill'), getComputedStyle(mark, '::before').animationName != 'none'] : null))(document.getElementById('super-container-' + id)?.querySelector('.item-menu .running-mark') as HTMLElement | null), id)
  type Held = { __release: () => void; __run: Promise<unknown> }
  type Runs = { start: (work: () => Promise<void>) => Promise<unknown>; show_status: (status: string, progress: number) => void; running: boolean; status: string; progress: number }
  const begin = (work: 'reports' | 'starts' | 'fails') =>
    page.evaluate(([id, work]) => {
      const item = window._item(id) as unknown as Runs
      const held = window as unknown as Held
      const hold = new Promise<void>(resolve => (held.__release = resolve))
      held.__run = item.start(async () => {
        if (work == 'starts') item.show_status('starting', 0) // a run's first write: a status, and a fraction of 0, which show_status skips
        else {
          item.show_status('t:1 u:1 r:0.5 <br>a:1/2 (50%)', 0.5)
          item.show_status('t:2 u:2 r:1 <br>a:2/2 (100%)', 1)
        }
        await hold
        if (work == 'fails') throw new Error('e2e: a run that fails')
      })
    }, [plain, work] as const)
  const end = () => page.evaluate(async () => (held => (held.__release(), held.__run))(window as unknown as Held))
  const FULL = ['t:2 u:2 r:1\na:2/2 (100%)', true, '100.000%', false]
  // a run reports up to 1 and completes: a full ring, then no ring; the progress is still read
  await begin('reports')
  await expect.poll(onMark, { message: 'a run that reported 1: a full ring', timeout: 15_000 }).toEqual(FULL)
  await end()
  await expect.poll(onMark, { message: 'the run is over: no ring', timeout: 15_000 }).toBeNull()
  expect(await read(), 'the status and the progress read as the line kept them, after the run').toEqual(['t:2 u:2 r:1 <br>a:2/2 (100%)', 1])
  // the next run, before its first positive fraction: its ring turns
  await begin('starts')
  await expect.poll(onMark, { message: 'the next run, which has reported nothing yet: its title, and a ring that turns', timeout: 15_000 }).toEqual(['starting', false, '', true])
  expect((await read())[1], 'the progress read is still the last one written').toBe(1)
  // its first positive fraction fills the ring; a second running reference keeps it through the first run's end
  await page.evaluate(id => (window._item(id) as unknown as Runs).show_status('t:1 u:1 r:0.25 <br>a:1/4 (25%)', 0.25), plain)
  const QUARTER = ['t:1 u:1 r:0.25\na:1/4 (25%)', true, '25.000%', false]
  await expect.poll(onMark, { message: 'its first fraction', timeout: 15_000 }).toEqual(QUARTER)
  await run(plain, true)
  await end()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve)))))
  expect([await onMark(), await page.evaluate(id => (window.__items.find(item => item.id == id) as unknown as { running: number }).running, plain)], 'the run is over while another reference holds the item running: the ring keeps the fraction').toEqual([QUARTER, 1])
  await run(plain, false)
  await expect.poll(onMark, { timeout: 15_000 }).toBeNull()
  // a run that FAILS after it reported; then a run that writes a status alone, as a chat's call does
  await begin('fails')
  await expect.poll(onMark, { timeout: 15_000 }).toEqual(FULL)
  await end()
  await expect.poll(onMark, { message: 'the failed run is over: no ring', timeout: 15_000 }).toBeNull()
  await page.evaluate(id => {
    const item = window._item(id) as unknown as Runs
    item.running = true
    item.status = 'waiting for someone ...'
  }, plain)
  await expect.poll(onMark, { message: 'after a failed run that had reported 1, a run that writes only a status: a ring that turns', timeout: 15_000 }).toEqual(['waiting for someone ...', false, '', true])
  await page.evaluate(id => {
    const item = window._item(id) as unknown as Runs
    item.running = false
    item.status = ''
  }, plain)
  await expect.poll(onMark, { timeout: 15_000 }).toBeNull()
  // OFF THE PAGE the same holds, on the item's record: a progress reported by an item that has no
  // element is on its ring when it gets one, and a run that ended while it had none left nothing
  // for the next
  const [reporting, ended] = await page.evaluate(async id => {
    const away = (window._items() as unknown as { id: string }[]).map(item => item.id).filter(other => other != id && !document.getElementById('super-container-' + other))
    const [reporting, ended] = [away[0], away[1]].map(other => window._item(other) as unknown as Runs)
    reporting.running = true
    reporting.show_status('off the page', 0.5)
    ended.running = true
    ended.show_status('off the page', 1)
    ended.running = false
    ended.running = true
    for (const item of [reporting, ended]) await (window._render_item as unknown as (item: Runs) => Promise<unknown>)(item)
    return [away[0], away[1]]
  }, plain)
  await expect.poll(async () => [await onMark(reporting), await onMark(ended)], { message: 'given their elements: the reporting run\'s half, and a turning ring for the run after the one that ended', timeout: 15_000 }).toEqual([['off the page', true, '50.000%', false], ['off the page', false, '', true]])
  await page.evaluate(ids => ids.forEach(id => void ((window._item(id) as unknown as Runs).running = false)), [reporting, ended])
  // AN OPTION-RUN TAKES ONE RUNNING REFERENCE OF EACH DEPENDENCY, AND RELEASES THAT ONE (review 1
  // of the ring's follow-ups, 2026-11-19). An Option-click on a parent's Run button runs the
  // parent's runnable dependencies first, each marked running until its run ends. That marking
  // wrote `true` and then `false` on the dependency's record, over its count, and its end ended
  // the dependency's display: a dependency that another run held (here the row's own reference,
  // at 50%) had no count and no ring once the Option-run was over, and the other run's own
  // release then logged `attempted running=false when already false`. (The overlap step above
  // takes both of its references through the `running` setter, which that marking bypassed.) Two
  // local items of the row's, both runnable: a root and, under it, a parent that depends on it by
  // a hidden tag, both shown by the query that names the parent. Their runs record the item and
  // its running count when they run (review 2: the times the runs set cannot tell the order, a
  // re-ranking moves the time of every running item): the root runs first, held twice (the
  // row's reference and the Option-run's), then the parent, on the Option-run's own reference
  // (A run that waits, and a dependency that leaves the page and comes back under its id while
  // it waits, is a row of tests/e2e/tasks.spec.ts: it writes behind the app, which this lane does not)
  const released: string[] = []
  const unheld = (message: { type: () => string; text: () => string }) => void (message.type() == 'error' && message.text().includes('attempted running=false') && released.push(message.text()))
  page.on('console', unheld)
  const [parent, root] = await page.evaluate(async () => {
    const made = async (text: string) => ((await window._create(text)) as unknown as { id: string }).id
    const recorded = ';(window.__optrun ??= []).push([_this.id, window.__items.find(item => item.id == _this.id).running])' // the item, and its count as it runs
    const root = await made(`#e2e_optrun the dependency of an Option-run\n\`\`\`js_input\n${recorded}\n\`\`\``)
    const parent = await made(`#e2e_optrun/parent #_e2e_optrun its parent\n\`\`\`js_input\n${recorded}\n\`\`\``)
    location.hash = '#e2e_optrun/parent'
    return [parent, root]
  })
  type Counted = { running: number | boolean; saving: boolean; runnable: unknown; deps: string[] }
  const counted = (id: string) => page.evaluate(id => (found => ({ running: found.running, saving: !!found.saving, runnable: !!found.runnable, deps: [...found.deps] }))(window.__items.find(item => item.id == id) as unknown as Counted), id)
  const onPage = (id: string) => page.evaluate(id => !!document.querySelector(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${id}"]`), id)
  await expect
    .poll(async () => (([up, down, shown]) => [up.deps.includes(root), up.runnable, down.runnable, up.running, down.running, up.saving || down.saving, ...shown])([await counted(parent), await counted(root), [await onPage(parent), await onPage(root)]] as const), {
      message: 'the premise: the parent depends on its root, both are runnable, neither runs nor is being saved, and the query shows both',
      timeout: 30_000,
    })
    .toEqual([true, true, true, 0, 0, false, true, true])
  await page.evaluate(id => {
    const item = window._item(id) as unknown as Runs
    item.running = true
    item.status = 'held by another run'
    item.progress = 0.5
  }, root)
  const HELD = ['held by another run', true, '50.000%', false]
  await expect.poll(() => onMark(root), { message: 'the root, held by the row at 50%: half a ring', timeout: 15_000 }).toEqual(HELD)
  await page.locator(`.column:not(.hidden) .container[data-item-id="${parent}"] .item-menu > .run`).click({ modifiers: ['Alt'] })
  await expect
    .poll(async () => [(await counted(parent)).running, await page.evaluate(() => (window as unknown as { __optrun?: unknown[] }).__optrun ?? [])], {
      message: 'the Option-run is over: the root ran first, held by the row and by the Option-run, then the parent on its own reference, which is released',
      timeout: 15_000,
    })
    .toEqual([0, [[root, 2], [parent, 1]]])
  await expect.poll(async () => [(await counted(root)).running, await onMark(root)], { message: 'the Option-run released its own reference of the root and no other: the row\'s is still held, and the ring keeps its half', timeout: 15_000 }).toEqual([1, HELD])
  await page.evaluate(id => void ((window._item(id) as unknown as Runs).running = false), root)
  await expect.poll(async () => [(await counted(root)).running, await onMark(root)], { message: 'the row releases its own: no count, no ring', timeout: 15_000 }).toEqual([0, null])
  // A PARENT THAT LEAVES THE PAGE STOPS ITS OPTION-RUN before any more of its work starts (review 3
  // of the ring's follow-ups, 2026-11-19). The parent is deleted while its first dependency's run
  // waits (that input returns a promise of the row's, which the Option-run awaits); when the run
  // ends, the queued dependency is not run, and the hold the Option-run took of it at its start is
  // released. (Checked only before the parent's own run, the parent let every queued input run
  // first: an input can write items or start other work, which balanced counts do not undo.)
  // Three local items, the parent shown by the query that names it; every input records its item
  type Recorded = { __optrun3?: string[]; __optrun3_hold: Promise<void>; __optrun3_release: () => void }
  const [gone, waits, queued] = await page.evaluate(async () => {
    const made = async (text: string) => ((await window._create(text)) as unknown as { id: string }).id
    const recorded = ';(window.__optrun3 ??= []).push(_this.id)' // the item, as it runs
    const waits = await made(`#e2e_optrun3_first the first dependency of an Option-run, whose run waits for the row\n\`\`\`js_input\n${recorded}\nreturn window.__optrun3_hold\n\`\`\``)
    const queued = await made(`#e2e_optrun3_queued the dependency after it\n\`\`\`js_input\n${recorded}\n\`\`\``)
    const gone = await made(`#e2e_optrun3 #_e2e_optrun3_first #_e2e_optrun3_queued their parent, which leaves the page\n\`\`\`js_input\n${recorded}\n\`\`\``)
    location.hash = '#e2e_optrun3'
    return [gone, waits, queued]
  })
  await expect
    .poll(async () => (([up, first, next, shown]) => [up.deps, up.runnable, first.runnable, next.runnable, [up.running, first.running, next.running], up.saving || first.saving || next.saving, shown])([await counted(gone), await counted(waits), await counted(queued), await onPage(gone)] as const), {
      message: 'the premise: the parent depends on the first and then the queued one, all are runnable, none runs or is being saved, and the parent is on the page',
      timeout: 30_000,
    })
    .toEqual([[waits, queued], true, true, true, [0, 0, 0], false, true])
  const ranOf = () => page.evaluate(() => (window as unknown as Recorded).__optrun3 ?? [])
  await page.evaluate(() => {
    const w = window as unknown as Recorded
    w.__optrun3 = []
    w.__optrun3_hold = new Promise(resolve => (w.__optrun3_release = resolve))
  })
  await page.locator(`.column:not(.hidden) .container[data-item-id="${gone}"] .item-menu > .run`).click({ modifiers: ['Alt'] })
  await expect.poll(async () => [await ranOf(), (await counted(queued)).running], { message: 'the first dependency\'s run has begun and waits; the queued one is held by the Option-run', timeout: 15_000 }).toEqual([[waits], 1])
  await page.evaluate(id => void (window._item(id) as unknown as { delete: (confirm: boolean) => boolean }).delete(false), gone)
  await expect.poll(() => page.evaluate(id => window.__items.some(item => item.id == id), gone), { message: 'the parent is deleted while the first run waits', timeout: 15_000 }).toBe(false)
  await page.evaluate(() => (window as unknown as Recorded).__optrun3_release())
  await expect.poll(async () => [(await counted(waits)).running, (await counted(queued)).running], { message: 'the first run is over, and both of the Option-run\'s holds are released', timeout: 15_000 }).toEqual([0, 0])
  expect(await ranOf(), 'only the first dependency ran: its parent had left the page, and the Option-run started nothing more').toEqual([waits])
  page.off('console', unheld)
  expect(released, 'no release was of a reference that was not held').toEqual([])

  // beside a run button: the button moves aside by the ring's room without the menu resizing, and
  // neither it nor the text reaches the ring
  await open(runnable)
  const still = await runningLook(page, runnable)
  expect([still.marks, still.run![0]], 'a run button stands right before the number\'s box').toEqual([[], 4])
  expect(still.text, 'its text ends left of the button (how near is the plain item\'s to say: this one\'s wraps earlier)').toBeGreaterThanOrEqual(still.run![1] + 1)
  await run(runnable, true)
  await shown(runnable, true)
  const moved = await runningLook(page, runnable)
  expect([marksAre(moved.marks, [[18, 4]]), moved.run, moved.room, moved.placeholder], `running: the ring between the run button and the digits (${JSON.stringify(moved.marks)}), the button 18 px further left, the menu not resized`).toEqual([true, still.run!.map(edge => edge + 18), ['0px', '18px'], still.placeholder])
  expect(moved.text, 'and the text keeps out of where the button now stands').toBeGreaterThanOrEqual(moved.run![1] + 1)
  await run(runnable, false)
  await shown(runnable, false)

  // beside a mark of item code (the #vault item's watched sparkle is one, and its row has the two
  // together: tests/e2e/sparkle.spec.ts). Such a mark is the number's `::before`, takes no room of
  // the number's line (a negative margin) and says its room on the item's box: the app keeps that
  // room free, and while the item runs the two rooms add up and the ring stands left of the mark,
  // 3 px from it, without either rule naming the other's size. This mark is 19 px in a room of 22,
  // not the sparkle's 15 in 18: an offset written for the sparkle's size would show here.
  // A number BEYOND FOUR DIGITS has no reserved width: its box, and the menu with it, is as wide
  // as its content, so no mark may take room in its line. The item's menu, cloned beside itself
  // with 12345 and without the reserved class (as the app renders such a number), keeps the width
  // it has with no mark at all, idle, marked and running, and the marks stand as they do beside a
  // short number (before the fix the menu grew by the mark's room when the run began)
  const natural = await fiveDigits(page, runnable)
  expect([natural.reserved, natural.menu > still.placeholder[1], natural.marks, natural.run], 'a five-digit number: no reserved width, a wider menu, no mark').toEqual(['normal', true, [], 4])
  const box = `.container[data-item-id="${runnable}"]`
  await page.addStyleTag({ content: `${box} { --item-mark-room: 22px }\n${box} .item-menu > .button.index::before { content: ''; flex: none; width: 19px; height: 15px; margin: 0 3px 0 -22px; background: #f5e389 }` })
  const marked = await runningLook(page, runnable)
  expect([marksAre(marked.marks, [[22, 4]]), marked.run, marked.room, marked.placeholder], `a mark of item code (${JSON.stringify(marked.marks)}): its 22 px kept free by the app`).toEqual([true, still.run!.map(edge => edge + 22), ['22px', '0px'], still.placeholder])
  const five = await fiveDigits(page, runnable)
  expect([five.menu, marksAre(five.marks, [[22, 4]]), five.run], `five digits, marked (${JSON.stringify(five.marks)}): the menu's natural width`).toEqual([natural.menu, true, 4 + 22])
  await run(runnable, true)
  await shown(runnable, true)
  const both = await runningLook(page, runnable)
  expect([marksAre(both.marks, [[22, 4], [40, 25]]), both.run, both.room, both.placeholder], `and running: the mark where it was and the ring left of it (${JSON.stringify(both.marks)}), the run button left of both, the room their sum`).toEqual([true, still.run!.map(edge => edge + 40), ['22px', '18px'], still.placeholder])
  expect(both.text, 'and the text keeps out of it all').toBeGreaterThanOrEqual(both.run![1] + 1)
  const fiveBoth = await fiveDigits(page, runnable)
  expect([fiveBoth.menu, marksAre(fiveBoth.marks, [[22, 4], [40, 25]]), fiveBoth.run], `five digits, marked and running (${JSON.stringify(fiveBoth.marks)}): still the natural width, the ring left of the mark, the run button left of both`).toEqual([natural.menu, true, 4 + 40])
  await run(runnable, false)
  await shown(runnable, false)
})

// THE ACCESSORS READ AS THE STATUS LINE DID. Until 2026-11-19 `_Item.status` and `_Item.progress`
// read and wrote the item's status line in its element; the line is gone, and what is set is kept
// on the item's record. The getters still give what the line gave, state by state: null, both,
// for an item that has no element on the page; with an element the status as the line held it
// (the browser's html for it, '' when none) and the progress as the number its text gave. An
// item's own text can read them while it renders: the docs item of the anonymous corpus prints
// both, `null` while it first renders (before its element is there: its golden of
// render.spec.ts) and an empty status when it is rendered again where it stands. The first
// version of the ring's change read the record wherever the item was, and that golden failed.
// EVERY VALUE BELOW IS THE RELEASED APP'S (f73cd35), read by this same script in a probe of that
// build, except the states under KEPT, where the released value is beside each: what is set is
// now kept whether the item is on the page or not, and a write is there at once.
// `pause` is 0 here; the probe of the released build waited after each write, whose status
// setter was a task
async function accessorStates([docs, pause]: readonly [string, number]) {
  type Handle = { status: unknown; progress: unknown; running: boolean; show_status: (status: unknown, progress: unknown) => void; clear_status: () => void; invalidate_elem_cache: (options: object) => void }
  const [handle, render] = [window._item as unknown as (id: string) => Handle, window._render_item as unknown as (item: Handle) => Promise<unknown>]
  const settle = (times = 1) => new Promise(resolve => setTimeout(resolve, pause * times))
  const safe = (value: unknown) => (value === undefined ? 'undefined' : typeof value == 'number' && isNaN(value) ? 'NaN' : value)
  const read = (id: string) => [safe(handle(id).status), safe(handle(id).progress)]
  const tried = (act: () => void) => {
    try {
      act()
      return 'no error'
    } catch (e) {
      return String(e)
    }
  }
  const shown = [...document.querySelectorAll('.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id]')].map(box => (box as HTMLElement).dataset.itemId!)
  const away = (window._items() as unknown as { id: string }[]).map(item => item.id).filter(id => id != docs && !document.getElementById('super-container-' + id))
  const [a, b] = shown // on the page
  const [x, y, z] = away // no element
  const item = handle(a)
  const out: Record<string, unknown> = {}
  out['never set, no element on the page'] = read(x)
  out['never set, on the page'] = read(a)
  item.status = 'first'
  out['set, read in the same turn'] = read(a)
  await settle()
  out['set'] = read(a)
  for (const [name, status] of [['set, with entities', 'it&#39;s a &lt;b&gt; &amp; c'], ['set, a bare ampersand', 'a & b'], ['set, an open tag', '<div>open'], ['set, an open tag inside a noscript', '<noscript><b>open</noscript>'], ['set, a number', 5], ['set, null', null], ['set, undefined', undefined]] as const) {
    item.status = status
    await settle()
    out[name] = read(a)
  }
  item.status = 'again'
  await settle()
  item.status = ''
  await settle()
  out["set, then cleared with ''"] = read(a)
  for (const progress of [0, 0.25, '0.5', 1, '']) out[`progress ${JSON.stringify(progress)}`] = [tried(() => void (item.progress = progress)), read(a)[1]]
  for (const [name, progress] of [['1.5', 1.5], ['-0.1', -0.1], ['NaN', NaN], ['undefined', undefined], ['null', null]] as const) {
    item.progress = 0.25
    out[`progress ${name}`] = [tried(() => void (item.progress = progress)), read(a)[1]]
  }
  item.status = 'to clear'
  item.progress = 0.75
  await settle()
  out['set, both'] = read(a)
  item.clear_status()
  await settle()
  out['set, then clear_status()'] = read(a)
  item.show_status('shown', 0.5)
  await settle()
  out['show_status(status, 0.5)'] = read(a)
  item.show_status('', 0)
  await settle()
  out["show_status('', 0), which skips both"] = read(a)
  item.clear_status()
  const other = handle(b)
  other.running = true
  other.status = 'while running'
  other.progress = 0.5
  await settle()
  out['set on a running item'] = read(b)
  other.running = false
  await settle()
  out['the same item, no longer running'] = read(b)
  other.clear_status()
  // while the item has no element on the page
  const off = handle(x)
  off.status = 'set off the page'
  out['set off the page: the progress, and both read in the same turn'] = [tried(() => void (off.progress = 0.5)), read(x)]
  await settle(1.5)
  out['set off the page: read later, still off'] = read(x)
  out['off the page: a progress of undefined, of null, of 1.5'] = [undefined, null, 1.5].map(progress => tried(() => void (off.progress = progress)))
  out['set off the page: read again'] = read(x)
  await render(off)
  out['set off the page, then given an element: at once'] = [!!document.getElementById('super-container-' + x), read(x)]
  await settle(2.25)
  out['set off the page, then given an element: later'] = read(x)
  await render(handle(y))
  await settle()
  out['never set, then given an element'] = read(y)
  const cleared = handle(z)
  cleared.status = 'pending'
  cleared.progress = 0.5
  cleared.clear_status()
  await settle()
  out['set and cleared off the page: read off'] = read(z)
  await render(cleared)
  await settle(2.25)
  out['set and cleared off the page, then given an element'] = read(z)
  // what an item's own text reads while it renders: the docs item's table prints both
  const cells = () => {
    const rows = [...(document.getElementById('super-container-' + docs)?.querySelectorAll('tr') ?? [])]
    return ['status', 'progress'].map(name => rows.find(row => row.cells[0]?.textContent?.trim() == name)?.cells[1]?.innerHTML.trim() ?? null)
  }
  out['the docs item: on the page before'] = !!document.getElementById('super-container-' + docs)
  await render(handle(docs))
  await settle()
  out['the docs item: its cells as first rendered'] = cells()
  out['the docs item: read from outside, with its element'] = read(docs)
  const first = document.getElementById('item-' + docs)!.firstElementChild
  handle(docs).invalidate_elem_cache({ force_render: true, render_delay: 0 })
  for (let waited = 0; waited < 100 && document.getElementById('item-' + docs)?.firstElementChild === first; waited++) await new Promise(resolve => setTimeout(resolve, 50))
  out['the docs item: rendered again'] = document.getElementById('item-' + docs)?.firstElementChild !== first
  out['the docs item: its cells rendered again where it stands'] = cells()
  return out
}
// the two accessors after the item's ELEMENT is made anew. The items render per column, a keyed
// each inside a block per column, so an item that a layout moves to another column is destroyed
// in one block and created in the other (the fixture is the remount row's of editor.spec.ts: a
// root with a 1200 px block and a short leaf, the query naming the leaf: at two columns the root
// fills column 0 and the leaf opens column 1, at one column both are in column 0). The status
// line was that element's, and what it held went with it
async function statusAfterRemount(page: Page, pause: number) {
  await page.setViewportSize({ width: 1600, height: 900 }) // floor(1600 / 750) = 2 columns
  const id = await page.evaluate(async () => {
    await window._create('#e2e_status_remount\n\n<div style="height: 1200px"></div>')
    const leaf = (await window._create('#e2e_status_remount/leaf what is set outlives the element')) as unknown as { id: string }
    location.hash = '#e2e_status_remount/leaf'
    return leaf.id
  })
  // the leaf's element in a shown column, in `column` of `columns`, and `stamped` or made since the stamp
  const placed = (columns: number, column: number, stamped: boolean) =>
    page.waitForFunction(
      ([id, columns, column, stamped]) => {
        const elem = document.getElementById('super-container-' + id) as (HTMLElement & { __stamped?: boolean }) | null
        const record = window.__items.find(item => item.id == id) as unknown as { column: number } | undefined
        return document.querySelectorAll('.column:not(.hidden)').length == columns && record?.column == column && !!elem && !elem.closest('.column.hidden') && !!elem.__stamped == stamped
      },
      [id, columns, column, stamped] as const,
      { timeout: 30_000 },
    )
  await placed(2, 1, false)
  const read = (wait: number, set: boolean) =>
    page.evaluate(
      async ([id, wait, set]) => {
        const item = window._item(id) as unknown as { status: unknown; progress: unknown }
        if (set) {
          item.status = 'kept'
          item.progress = 0.25
          ;(document.getElementById('super-container-' + id) as HTMLElement & { __stamped?: boolean }).__stamped = true
        }
        await new Promise(resolve => setTimeout(resolve, wait))
        return [item.status, item.progress]
      },
      [id, wait, set] as const,
    )
  const before = await read(pause, true)
  await placed(2, 1, true)
  await page.setViewportSize({ width: 900, height: 900 }) // one column
  await placed(1, 0, false)
  return { 'set, in column 1 of two': before, 'in a new element, in the one column': await read(pause * 2.25, false) }
}
test("an item's status and progress read as they did while they were its status line's", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await loadAnonymous(page)
  const DOCS = 'm0qFIgl8omG5ThQKmg1q' // #MindPage/core/properties: its table prints `_this.status` and `_this.progress`
  const read: Record<string, unknown> = { ...(await page.evaluate(accessorStates, [DOCS, 0] as const)), ...(await statusAfterRemount(page, 0)) }
  const NO_TEXT = (value: string) => `TypeError: Cannot read properties of ${value} (reading 'toString')`
  const AS_RELEASED: Record<string, unknown> = {
    'never set, no element on the page': [null, null],
    'never set, on the page': ['', null],
    set: ['first', null],
    'set, with entities': ["it's a &lt;b&gt; &amp; c", null],
    'set, a bare ampersand': ['a &amp; b', null],
    'set, an open tag': ['<div>open</div>', null],
    'set, a number': ['5', null],
    'set, null': ['', null],
    'set, undefined': ['undefined', null],
    "set, then cleared with ''": ['', null],
    'progress 0': ['no error', 0],
    'progress 0.25': ['no error', 0.25],
    'progress "0.5"': ['no error', 0.5],
    'progress 1': ['no error', 1],
    'progress ""': ['no error', null],
    'progress 1.5': ['Error: invalid progress 1.5', 0.25],
    'progress -0.1': ['Error: invalid progress -0.1', 0.25],
    'progress NaN': ['no error', 'NaN'],
    'progress undefined': [NO_TEXT('undefined'), 0.25],
    'progress null': [NO_TEXT('null'), 0.25],
    'set, both': ['to clear', 0.75],
    'set, then clear_status()': ['', 0],
    'show_status(status, 0.5)': ['shown', 0.5],
    "show_status('', 0), which skips both": ['shown', 0.5],
    'set on a running item': ['while running', 0.5],
    'the same item, no longer running': ['while running', 0.5],
    'set off the page: the progress, and both read in the same turn': ['no error', [null, null]],
    'set off the page: read later, still off': [null, null],
    'off the page: a progress of undefined, of null, of 1.5': ['no error', 'no error', 'Error: invalid progress 1.5'],
    'set off the page: read again': [null, null],
    'never set, then given an element': ['', null],
    'set and cleared off the page: read off': [null, null],
    'the docs item: on the page before': false,
    'the docs item: its cells as first rendered': ['<code>null</code>', '<code>null</code>'],
    'the docs item: read from outside, with its element': ['', null],
    'the docs item: rendered again': true,
    'the docs item: its cells rendered again where it stands': ['``', '<code>null</code>'],
    'set, in column 1 of two': ['kept', 0.25],
  }
  // what is set is kept, and is there at once (the released value beside each)
  const KEPT: Record<string, unknown> = {
    'set, read in the same turn': ['first', null], // ['', null]: the line was written by a task, a timer after the assignment
    'set off the page, then given an element: at once': [true, ['set off the page', 0.5]], // [true, ['', null]]: the status came with the setter's next retry, within 250 ms
    'set off the page, then given an element: later': ['set off the page', 0.5], // ['set off the page', null]: a progress set off the page was dropped
    'set and cleared off the page, then given an element': ['', 0], // ['', null]: likewise, the clearing 0
    'in a new element, in the one column': ['kept', 0.25], // ['', null]: the line was the element's, and what it held went with it
    'set, an open tag inside a noscript': ['<noscript><b>open</b></noscript>', null], // ['<noscript><b>open</noscript>', null]: the page's own document reads a noscript's content as text, the inert one that the status is now read in as markup
  }
  // (soft: each state is its own finding, and one wrong value must not hide the others)
  for (const [state, value] of Object.entries({ ...AS_RELEASED, ...KEPT })) expect.soft(read[state], state).toEqual(value)
  expect(Object.keys(read).sort(), 'every state read is one of the table').toEqual(Object.keys({ ...AS_RELEASED, ...KEPT }).sort())
})

// THE RING'S HEIGHT IN THE APP'S OWN FONT (the owner, 2026-11-19: the circle "seems off, a bit too
// high; can you match it to the sparkle's alignment?"). A lane loads no web font (its browsers
// resolve loopback only), so this row gives the page the digits of Open Sans 600 from a fixture
// (tests/e2e/fixtures/open_sans_600_digits.woff2: the subset Google Fonts serves for
// `text=0123456789`, 3 kB; its upstream notice, the SIL Open Font License, is the .OFL.txt
// beside it) and reads the ring and the digits by pixels. The ring's line is then as
// tall as the digits' and at their height, and the ring inks 15 rows that end 2 px under the
// digits, whose ink ends on the baseline: where the item sits and with the item half a pixel
// lower, turning and filled. Centred in the number's box, as the ring was released, it ended 1 px
// under them at one of the two places (the browser rounds a text's baseline and a box's edge to the
// pixel grid separately): on an item at a whole pixel it stood a pixel high
test("the running mark stands on the number's baseline in the app's own font, as the watched sparkle does", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await loadAnonymous(page)
  const font = readFileSync(resolve('tests/e2e/fixtures/open_sans_600_digits.woff2')).toString('base64')
  const id = await firstShown(page)
  const box = `.column:not(.hidden) .container[data-item-id="${id}"]`
  await page.evaluate(async font => void document.fonts.add(await new FontFace('Open Sans', `url(data:font/woff2;base64,${font})`, { weight: '600' }).load()), font)
  await page.evaluate(id => void ((window._item(id) as unknown as { running: boolean }).running = true), id)
  // the premise: the number is set in Open Sans 600 at 15 px
  const lines = () =>
    page.evaluate(box => {
      const index = document.querySelector(`${box} .item-menu > .index`) as HTMLElement
      const mark = index.querySelector(':scope > .running-mark')
      if (!mark) return null
      const digits = document.createRange()
      digits.selectNodeContents(index.firstChild!)
      const [line, own, style] = [digits.getBoundingClientRect(), mark.getBoundingClientRect(), getComputedStyle(index)]
      return { font: [document.fonts.check(`600 15px 'Open Sans'`), style.fontFamily.split(',')[0], style.fontWeight, style.fontSize, line.height], ring: [own.height, own.top - line.top] }
    }, box)
  await expect.poll(async () => (await lines())?.font, { message: 'the number is set in Open Sans 600 at 15 px, a line of 20', timeout: 30_000 }).toEqual([true, '"Open Sans"', '600', '15px', 20])
  for (const progress of [0, 0.5]) {
    await page.evaluate(([id, progress]) => void ((window._item(id) as unknown as { progress: number }).progress = progress), [id, progress] as const)
    await expect.poll(() => page.evaluate(box => document.querySelector(`${box} .running-mark`)!.classList.contains('filled'), box)).toBe(progress > 0)
    for (const lower of [false, true]) {
      const nudge = lower ? await page.addStyleTag({ content: `.container[data-item-id="${id}"] { top: 0.5px }` }) : null
      const ink = await ringInk(page, id)
      expect([ink.ring[1] - ink.ring[0], ink.wide, ink.ring[1] - ink.digits[1], ink.digits[1] - ink.digits[0]], `the ring${progress ? ', filled' : ''}${lower ? ', the item half a pixel lower' : ''}: 15 px high and wide, ending 2 px under the digits, which ink 11 rows (${JSON.stringify(ink)})`).toEqual([15, 15, 2, 11])
      await nudge?.evaluate(style => (style as Element).remove())
    }
  }
  // and why: the ring's element is a line as tall as the digits' and at their height (in this
  // font, whose ascent takes the ring's 15 px), so the two share a baseline
  expect((await lines())!.ring, 'the ring\'s line is as tall as the digits\' and at their height').toEqual([20, 0])
  // THE STATE CIRCLES AT THE RING'S HEIGHT (2026-11-19): the same item, can be pushed and
  // previewed too, has both circles between the ring and the digits, each an image on the
  // baseline of a line of the number's font (the circles' box in the menu), lowered 2 px as the ring is:
  // each inks the ring's 15 rows and 15 columns, the rows ending 2 px under the digits, where the
  // item sits and with the item half a pixel lower, the ring turning and filled; from the left the
  // ring, the previewable circle and the pushable one, 3 px apart and 3 px before the digits
  await page.evaluate(id => {
    ;(window.__items.find(item => item.id == id) as unknown as { previewable: boolean }).previewable = true
    ;(window._item(id) as unknown as { pushable: boolean }).pushable = true // (a change that re-ranks, and so renders the other state too)
  }, id)
  await expect.poll(() => page.evaluate(box => !!document.querySelector(`${box}.pushable.previewable`), box), { timeout: 30_000 }).toBe(true)
  for (const progress of [0, 0.5]) {
    await page.evaluate(([id, progress]) => void ((window._item(id) as unknown as { progress: number }).progress = progress), [id, progress] as const)
    await expect.poll(() => page.evaluate(box => document.querySelector(`${box} .running-mark`)!.classList.contains('filled'), box)).toBe(progress > 0)
    for (const lower of [false, true]) {
      const nudge = lower ? await page.addStyleTag({ content: `.container[data-item-id="${id}"] { top: 0.5px }` }) : null
      const ink = await marksInk(page, id)
      const said = `${progress ? ', filled' : ''}${lower ? ', the item half a pixel lower' : ''} (${JSON.stringify(ink)})`
      expect((['ring', 'previewable', 'pushable'] as const).map(mark => (at => at && [at.rows[1] - at.rows[0], at.wide, at.rows[1] - ink.digits!.rows[1]])(ink[mark])), `the ring and the two circles: 15 px high and wide, ending 2 px under the digits${said}`).toEqual([[15, 15, 2], [15, 15, 2], [15, 15, 2]])
      const wanted = { ring: [54, 39], previewable: [36, 21], pushable: [18, 3] } // px left of the digits' box
      expect((['ring', 'previewable', 'pushable'] as const).map(mark => marksAre([ink[mark]!.cols], [wanted[mark]])), `from the left the ring, the previewable circle and the pushable one${said}`).toEqual([true, true, true])
      await nudge?.evaluate(style => (style as Element).remove())
    }
  }
})

// THE TAP (the owner, 2026-11-19: "yes to the tap on mobile for the tooltip"). Where no pointer
// hovers a tooltip never shows: there a tap on the ring shows the same text in a small note under
// the item's menu, which follows the status while it shows and goes at the next tap anywhere. The
// tap is the ring's alone: it starts no editor and is no tap on the number (which, on the first
// view, selects the item: a history entry more; on a green number it would set the item's time);
// the tap that takes the note away does whatever else it does (on the item's text it opens the
// editor, whose ring takes a tap the same way). And a tap on the DIGITS of a running item is still
// the number's: a touch browser hands a tap to a clickable child of the clickable element under
// the finger when the finger's area reaches that child (Chromium's touch adjustment), which gave
// the ring every tap on a short number while it had a click listener of its own. A phone's
// window, 375 px, with touch
test('a tap on the running mark shows its status in a note where no pointer hovers, and the next tap takes the note away', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await loadAnonymous(page)
  expect(await page.evaluate(() => [innerWidth, matchMedia('(hover: none)').matches]), "a phone's window: 375 px, no pointer that hovers").toEqual([375, true])
  const id = await firstShown(page)
  const box = `.column:not(.hidden) .container[data-item-id="${id}"]`
  await page.evaluate(id => {
    const item = window._item(id) as unknown as { running: boolean; status: string }
    item.running = true
    item.status = 'waiting for the lanes …'
  }, id)
  await expect.poll(() => page.evaluate(box => document.querySelector(`${box} .running-mark`)?.getAttribute('title') ?? null, box), { timeout: 30_000 }).toBe('waiting for the lanes …')
  // the note as shown (its class and the text it draws), where it lies (the box of the mark's
  // ::after, placed in the menu: by its used size and offsets) and what a hit in its middle
  // answers; and what a tap on the item or on its number would have changed
  const seen = () =>
    page.evaluate(async ([id, box]) => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve))))
      const [mark, menu] = ['.running-mark', '.item-menu'].map(part => document.querySelector(`${box} ${part}`) as HTMLElement)
      const [note, around, raw] = [getComputedStyle(mark, '::after'), menu.getBoundingClientRect(), window.__items.find(item => item.id == id) as unknown as { time: number; editing: boolean }]
      const shows = note.content != 'none'
      const [right, top] = [around.right - parseFloat(note.right), around.bottom + parseFloat(note.top) - around.height]
      const lies = shows ? [right - parseFloat(note.width), top, right, top + parseFloat(note.height)] : null
      return {
        noted: [mark.classList.contains('noted'), note.content],
        lies,
        inside: !!lies && lies[0] >= 0 && lies[2] <= innerWidth && lies[1] >= around.bottom && lies[3] <= innerHeight,
        hit: !!lies && document.elementFromPoint((lies[0] + lies[2]) / 2, (lies[1] + lies[3]) / 2) === mark,
        item: [raw.time, (window as unknown as { _history_index: number })._history_index, !!raw.editing, !!document.querySelector(`${box}.editing`)],
      }
    }, [id, box] as const)
  const ring = () => page.evaluate(box => (ring => [ring.left + ring.width / 2, ring.top + ring.height / 2] as [number, number])(document.querySelector(`${box} .running-mark`)!.getBoundingClientRect()), box)
  await page.evaluate(box => document.querySelector(box)!.scrollIntoView({ block: 'center' }), box)
  // a tap on the digits of the running item is the number's own, the ring 3 px beside them: on
  // this first view it selects the item (a history entry more), and shows no note
  const first = await seen()
  expect([first.noted, first.item.slice(2)], 'before a tap: no note').toEqual([[false, 'none'], [false, false]])
  await page.touchscreen.tap(...(await page.evaluate(box => {
    const digits = document.createRange()
    digits.selectNodeContents(document.querySelector(`${box} .item-menu > .index`)!.firstChild!)
    return (rect => [rect.left + rect.width / 2, rect.top + rect.height / 2] as [number, number])(digits.getBoundingClientRect())
  }, box)))
  await expect.poll(async () => (after => [after.noted, (after.item[1] as number) - (first.item[1] as number), after.item.slice(2)])(await seen()), { message: 'a tap on the digits selects the item, and is no tap on the ring', timeout: 15_000 }).toEqual([[false, 'none'], 1, [false, false]])
  await expect.poll(() => page.evaluate(box => (shown => !!shown && !shown.closest('.super-container.hidden'))(document.querySelector(box)), box), { timeout: 30_000 }).toBe(true)
  await page.evaluate(box => document.querySelector(box)!.scrollIntoView({ block: 'center' }), box)
  const before = await seen() // (the item is now the one the address names: a tap on its number would set its time to now)
  // THE FOCUS STAYS WHERE IT IS through a tap on the ring and through the tap that takes the note
  // away (the first code review, 2026-11-19): the MindBox has it here, as the editor of another
  // item could, and a press that took it would close a phone's keyboard under the owner's typing.
  // The press's default is prevented for the ring by the number and for its note; the click is
  // still the number's handler's to tell apart
  const mindbox = page.locator('#textarea-mindbox')
  await page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).focus({ preventScroll: true }))
  await expect(mindbox, 'the premise: the MindBox has the focus').toBeFocused()
  // a tap on the ring: the note, with the status, inside the window under the menu; no editor, and the item neither selected nor moved
  await page.touchscreen.tap(...(await ring()))
  const noted = await seen()
  expect([noted.noted, noted.inside, noted.hit, noted.item], `a tap on the ring shows the status in a note under the menu, and does nothing else (${JSON.stringify(noted.lies)})`).toEqual([[true, '"waiting for the lanes …"'], true, true, before.item])
  await expect(mindbox, 'the tap on the ring left the focus in the MindBox').toBeFocused()
  // the status changes while the note shows: the note follows
  await page.evaluate(id => void ((window._item(id) as unknown as { status: string }).status = 'second <b>status</b>'), id)
  await expect.poll(async () => (await seen()).noted, { timeout: 15_000 }).toEqual([true, '"second status"'])
  // the next tap, on the note itself: gone, and nothing else
  const lies = (await seen()).lies!
  await page.touchscreen.tap((lies[0] + lies[2]) / 2, (lies[1] + lies[3]) / 2)
  expect((gone => [gone.noted, gone.item])(await seen()), 'a tap on the note takes it away, and does nothing else').toEqual([[false, 'none'], before.item])
  await expect(mindbox, 'the tap on the note left the focus in the MindBox').toBeFocused()
  // shown again, and a tap on the ring takes it away (it is not shown anew by the tap that dismissed it)
  await page.touchscreen.tap(...(await ring()))
  expect((await seen()).noted[0], 'a tap on the ring shows it again').toBe(true)
  await page.touchscreen.tap(...(await ring()))
  expect((gone => [gone.noted, gone.item])(await seen()), 'and a second tap on the ring takes it away').toEqual([[false, 'none'], before.item])
  await expect(mindbox, 'and the focus is the MindBox\'s still').toBeFocused()
  // AND WITH BOTH STATE CIRCLES (2026-11-19, the circles' code review): the item can be pushed and
  // previewed too, so the ring stands 36 px further left, left of the two circles (moved by its
  // margins), and a tap on it there is the ring's as before: the note opens under the menu and
  // takes a hit, the focus stays in the MindBox, and the item's time, its history and its editor
  // stay as they were (as they are once the states are set: their re-ranking may touch them).
  // The states are cleared before the row goes on
  const states = (on: boolean) =>
    page.evaluate(([id, on]) => {
      ;(window.__items.find(item => item.id == id) as unknown as { previewable: boolean }).previewable = on
      ;(window._item(id) as unknown as { pushable: boolean }).pushable = on // (a change that re-ranks, and so renders the other state too)
    }, [id, on] as const)
  const stated = (on: boolean) => expect.poll(() => page.evaluate(([box, on]) => !!document.querySelector(`${box}${on ? '.pushable.previewable' : ':not(.pushable):not(.previewable)'}`), [box, on] as const), { timeout: 30_000 }).toBe(true)
  await states(true)
  await stated(true)
  await expect.poll(() => page.evaluate(() => (window as unknown as { _history_update_pending: boolean })._history_update_pending), { timeout: 15_000 }).toBe(false)
  await page.evaluate(box => document.querySelector(box)!.scrollIntoView({ block: 'center' }), box)
  // how far the ring's right edge stands from the digits: 3 px, and 36 px more beside the two circles
  const displaced = () =>
    page.evaluate(box => {
      const digits = document.createRange()
      digits.selectNodeContents(document.querySelector(`${box} .item-menu > .index`)!.firstChild!)
      return Math.round(digits.getBoundingClientRect().left - document.querySelector(`${box} .running-mark`)!.getBoundingClientRect().right)
    }, box)
  const circled = await seen()
  expect([await displaced(), circled.noted], 'the premise: the ring 39 px from the digits, left of the two circles, and no note').toEqual([39, [false, 'none']])
  await page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).focus({ preventScroll: true }))
  await expect(mindbox, 'the premise: the MindBox has the focus').toBeFocused()
  await page.touchscreen.tap(...(await ring()))
  const there = await seen()
  expect([there.noted, there.inside, there.hit, there.item], `a tap on the ring left of the two circles shows the status in a note under the menu, which takes a hit, and does nothing else (${JSON.stringify(there.lies)})`).toEqual([[true, '"second status"'], true, true, circled.item])
  await expect(mindbox, 'the tap on the displaced ring left the focus in the MindBox').toBeFocused()
  await page.touchscreen.tap(...(await ring()))
  expect((gone => [gone.noted, gone.item])(await seen()), 'and a second tap on it takes the note away').toEqual([[false, 'none'], circled.item])
  await expect(mindbox).toBeFocused()
  await states(false)
  await stated(false)
  // shown again, and a tap elsewhere, on the item's text: the note goes, and the tap is the item's own (its editor opens)
  await page.touchscreen.tap(...(await ring()))
  expect((await seen()).noted[0]).toBe(true)
  await page.touchscreen.tap(...(await page.evaluate(box => (rect => [rect.left + 40, rect.bottom - 12] as [number, number])(document.querySelector(box)!.getBoundingClientRect()), box)))
  await expect.poll(() => page.evaluate(box => !!document.querySelector(`${box}.editing .edit-menu > .running-mark`), box), { message: 'a tap on the item\'s text opens its editor, whose menu has the ring', timeout: 15_000 }).toBe(true)
  // IN THE EDITOR the ring is the edit menu's first thing, and a tap on it shows the note under it
  // (placed at the menu's left edge, no wider than the menu), the editor staying open; a second tap takes it away
  const edited = () =>
    page.evaluate(async box => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve))))
      const [mark, menu] = ['.edit-menu > .running-mark', '.edit-menu'].map(part => document.querySelector(`${box} ${part}`) as HTMLElement)
      const [note, around, ring] = [getComputedStyle(mark, '::after'), menu.getBoundingClientRect(), mark.getBoundingClientRect()]
      const lies = note.content == 'none' ? null : [around.left + parseFloat(note.left), around.bottom + parseFloat(note.top) - around.height, around.left + parseFloat(note.left) + parseFloat(note.width)]
      return { noted: [mark.classList.contains('noted'), note.content], under: !!lies && Math.abs(lies[0] - ring.left) < 1 && lies[1] >= around.bottom && lies[0] >= 0 && lies[2] <= Math.min(innerWidth, around.right + 1), editing: !!document.querySelector(`${box}.editing`) }
    }, box)
  expect(await edited(), 'the editor opened without a note (the tap that opened it took the note away)').toEqual({ noted: [false, 'none'], under: false, editing: true })
  // (the editor's own textarea has the focus, and keeps it through both taps on its menu's ring)
  const textarea = page.locator(`#textarea-${id}`)
  await expect(textarea, 'the opened editor has the focus').toBeFocused()
  await page.touchscreen.tap(...(await ring()))
  expect(await edited(), 'a tap on the editor\'s ring: the note under the ring, within the menu\'s width and the window, the editor open').toEqual({ noted: [true, '"second status"'], under: true, editing: true })
  await expect(textarea, 'the tap on the editor\'s ring left the focus in its textarea').toBeFocused()
  await page.touchscreen.tap(...(await ring()))
  expect(await edited(), 'and a second tap takes it away').toEqual({ noted: [false, 'none'], under: false, editing: true })
  await expect(textarea, 'and the second tap left it there').toBeFocused()
  // a note that was showing when the run ended leaves nothing behind: the next run's ring has no
  // note, and its FIRST tap shows one (the note's one-shot dismissal, still armed from the run
  // before, took that tap for its own until it asked whether a note was showing)
  await page.touchscreen.tap(...(await ring()))
  expect((await edited()).noted[0], 'the note, showing').toBe(true)
  await page.evaluate(id => void ((window._item(id) as unknown as { running: boolean }).running = false), id)
  await expect.poll(() => page.evaluate(box => document.querySelectorAll(`${box} .running-mark`).length, box), { timeout: 15_000 }).toBe(0)
  await page.evaluate(id => void ((window._item(id) as unknown as { running: boolean }).running = true), id)
  await expect.poll(() => page.evaluate(box => !!document.querySelector(`${box} .edit-menu > .running-mark`), box), { timeout: 15_000 }).toBe(true)
  expect((await edited()).noted, 'the next run\'s ring has no note').toEqual([false, 'none'])
  await page.touchscreen.tap(...(await ring()))
  expect((await edited()).noted, 'and its first tap shows the note').toEqual([true, '"second status"'])
  // an item that no longer runs has no mark to tap
  await page.evaluate(id => void ((window._item(id) as unknown as { running: boolean }).running = false), id)
  await expect.poll(() => page.evaluate(box => document.querySelectorAll(`${box} .running-mark`).length, box), { timeout: 15_000 }).toBe(0)
  await context.close()
})

// THE STATE CIRCLES (the owner, 2026-11-19, of the ring: "can we also turn the pushable (orange)
// border into a circular indicator like this one? pushable items seem to happen a lot lately
// (though often transient) and the orange border is a bit too distracting"; that the circle
// stands still and that the border of an item that can be previewed goes the same way: "yes to
// both questions"). An item that can be pushed shows a ring of the running mark's size in the
// orange its border had, one that can be previewed the same in its border's pink, and neither has
// a border for it or turns. Both are in ONE box in the item's MENU (an element, `.state-marks`,
// with an element per circle, since each circle has a tooltip and takes a mouse's click: the rows
// after this one; it was the menu's `::before`. The number's `::before` is a mark of item code's,
// and a click on the number's box would be the number's), the circles boxes of their images' size
// on the baseline of a line of the number's font: the box
// stands in the menu's line right before the number's and takes no room there, so the menu is not
// resized; its room is a property per state on the item's box, kept free as the ring's is. The
// order from the left: the ring, previewable, pushable, a mark of item code, the number. (Their
// height by pixels in the app's own font is the ring's height row above; the editor, and the
// circles beside the watched sparkle itself, are the watched mark's row.)
const BORDERS = ['rgb(170, 85, 34)', 'rgb(204, 119, 204)'] // #a52 and #c7c, the two borders' colours
// what a menu's box of state circles draws, null when the menu has none: its box as [from, to] in
// px left of the digits, by the hit test of `marksLeftOf` (a hit on the box or on a circle in it:
// since the circles take a mouse's click the box is an element, `.state-marks`, and each circle an
// element in it; it was the menu's `::before`, with the same style, read here as it was), its
// width, how it is placed (centred in the menu's line, 2 px down, in the number's own font) and
// whether it turns (what it draws is read by its ink: `circlesInk`). Given to the page once
function stateCircles(menu: HTMLElement) {
  const marks = menu.querySelector(':scope > .state-marks') as HTMLElement | null
  if (!marks) return null
  const drawn = getComputedStyle(marks)
  const index = menu.querySelector('.index') as HTMLElement
  const digits = document.createRange()
  digits.selectNodeContents(index.firstChild!)
  const [number, own] = [digits.getBoundingClientRect(), index.getBoundingClientRect()]
  const box: number[][] = [] // one mark at most, as `marksLeftOf` gives its marks
  for (let k = 1, pixel = Math.floor(own.left) - 1; k <= 90; k++, pixel--)
    if (marks.contains(document.elementFromPoint(pixel + 0.5, (own.top + own.bottom) / 2))) box[0] = [number.left - pixel, box[0]?.[1] ?? number.left - pixel - 1]
  return { box, width: drawn.width, placed: [drawn.alignSelf, drawn.position, drawn.top, drawn.font == getComputedStyle(index).font], still: drawn.animationName == 'none' }
}
// the circles of an item in the shown column, and where its menu stands in its box
const circlesOf = (page: Page, id: string) =>
  page.evaluate(id => {
    const menu = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu`) as HTMLElement
    return { circles: (window as unknown as Scanning).__stateCircles!(menu), inset: [getComputedStyle(menu).top, getComputedStyle(menu).right] }
  }, id)
const ONE = { width: '18px', placed: ['center', 'relative', '2px', true], still: true }
// the two circles by their ink (`marksInk`): each one's columns, [from, to] px left of the digits'
// box, its size and its rows, null for a state not shown
const circlesInk = async (page: Page, id: string) => {
  const ink = await marksInk(page, id)
  return Object.fromEntries((['previewable', 'pushable'] as const).map(mark => [mark, ink[mark] && { cols: ink[mark]!.cols, size: [ink[mark]!.wide, ink[mark]!.rows[1] - ink[mark]!.rows[0]], rows: ink[mark]!.rows, hollow: ink[mark]!.hollow, stroke: ink[mark]!.stroke }])) as Record<'previewable' | 'pushable', { cols: number[]; size: number[]; rows: number[]; hollow?: boolean; stroke?: { runs: number[]; colour: number[] } } | null>
}
// one circle at [from, to] px left of the digits, 15 px wide and high
const inks = (at: { cols: number[]; size: number[] } | null, cols: number[]) => !!at && marksAre([at.cols], [cols]) && at.size[0] == 15 && at.size[1] == 15
// the place of the menu's digits, state circles, running ring and (when present) run button,
// RELATIVE TO THE ITEM'S OWN BOX (`.container`), both by layout boxes and by pixels (a screenshot
// anchored at the container's outer top-right corner, with the ring standing still). Every offset is
// measured from the box's outer top (`y - box.top`) and outer right (`box.right - x`), so a move
// of the item in the page cancels out; for a runnable item, the top two pixel rows across the
// button's span also check whether the 1 px top border stays clear above the button
const cornerPlace = async (page: Page, id: string) => {
  const still = await page.addStyleTag({ content: '.running-mark::before { animation: none !important }' })
  const layout = await page.evaluate(async id => {
    const box = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`) as HTMLElement
    box.scrollIntoView({ block: 'center' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const menu = box.querySelector('.item-menu') as HTMLElement
    const index = menu.querySelector(':scope > .index') as HTMLElement
    const digitsRange = document.createRange()
    digitsRange.selectNodeContents(index.firstChild!)
    const whole = box.getBoundingClientRect()
    const round = (n: number) => Math.round(n * 100) / 100
    const rel = (rect: DOMRect | null) =>
      rect ? [round(rect.top - whole.top), round(whole.right - rect.right), round(whole.right - rect.left)] : null
    const run = menu.querySelector(':scope > .run')?.getBoundingClientRect() ?? null
    const pushable = menu.querySelector('.pushable-mark')?.getBoundingClientRect() ?? null
    const previewable = menu.querySelector('.previewable-mark')?.getBoundingClientRect() ?? null
    const ring = index.querySelector(':scope > .running-mark')?.getBoundingClientRect() ?? null
    const digits = digitsRange.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const left = Math.floor(Math.min(run?.left ?? Infinity, ring?.left ?? Infinity, previewable?.left ?? Infinity, pushable?.left ?? Infinity, digits.left)) - 2
    const clipX = Math.max(Math.floor(whole.left), left)
    const clipY = Math.round(whole.top)
    const clipRight = Math.round(whole.right)
    return {
      bordered: box.classList.contains('bordered'),
      border: getComputedStyle(box).borderTopColor,
      number: index.firstChild!.textContent!.trim(),
      boxTop: round(whole.top),
      docTop: round(whole.top + document.body.scrollTop + document.documentElement.scrollTop),
      menuSize: [menu.clientWidth, menu.clientHeight],
      radius: getComputedStyle(index).borderTopRightRadius,
      menu: rel(menuRect),
      digits: rel(digits),
      pushable: rel(pushable),
      previewable: rel(previewable),
      ring: rel(ring),
      run: run ? [round(run.top - whole.top), round(run.left - whole.left), round(whole.right - run.right)] : null,
      clip: { x: clipX, y: clipY, width: clipRight - clipX, height: 28 },
      digitsLeftInClip: digits.left - clipX,
      runRightInClip: run ? Math.ceil(run.right) - clipX : 0,
      runSpanInClip: run ? [Math.ceil(run.left) + 2 - clipX, Math.floor(run.right) - 3 - clipX] : null,
    }
  }, id)
  const png = (await page.screenshot({ clip: layout.clip })).toString('base64')
  await still.evaluate(style => (style as Element).remove())
  const ink = await page.evaluate(
    async ([png, digitsLeft, runRight, runSpan]) => {
      const image = new Image()
      image.src = 'data:image/png;base64,' + png
      await image.decode()
      const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height })
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const { data, width, height } = context.getImageData(0, 0, image.width, image.height)
      const inked: Record<string, number[][]> = { ring: [], pushable: [], previewable: [], digits: [] }
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const [r, g, b] = [0, 1, 2].map(channel => data[4 * (y * width + x) + channel])
          if (x + 0.5 > digitsLeft) {
            if (r > 50 && g > 50 && Math.abs(r - b) <= 4) inked.digits.push([x, y, g])
          } else if (x >= runRight && b - r > 25) inked.ring.push([x, y])
          else if (r - b > 50 && g < 0.7 * r) inked.pushable.push([x, y])
          else if (r - g > 40 && b - g > 40) inked.previewable.push([x, y])
        }
      if (inked.digits.length) {
        const most = Math.max(...inked.digits.map(pixel => pixel[2]))
        inked.digits = inked.digits.filter(pixel => pixel[2] - 17 > (most - 17) / 2)
      }
      const bounds = (pixels: number[][]) => {
        if (!pixels.length) return null
        const [xs, ys] = [pixels.map(p => p[0]), pixels.map(p => p[1])]
        return { rows: [Math.min(...ys), Math.max(...ys) + 1], fromRight: [width - (Math.max(...xs) + 1), width - Math.min(...xs)] }
      }
      let runTopRow: { border: number; button: number; total: number } | null = null
      let runSecondRow: { border: number; button: number; total: number } | null = null
      if (runSpan && runSpan[1] > runSpan[0]) {
        const scanRow = (y: number) => {
          let border = 0
          let button = 0
          const total = runSpan[1] - runSpan[0]
          for (let x = runSpan[0]; x < runSpan[1]; x++) {
            const [r, g, b] = [0, 1, 2].map(channel => data[4 * (y * width + x) + channel])
            if (Math.abs(r - 34) <= 6 && Math.abs(g - 68) <= 6 && Math.abs(b - 34) <= 6) border++
            if (b - r > 100 && g > 120) button++
          }
          return { border, button, total }
        }
        runTopRow = scanRow(0)
        runSecondRow = scanRow(1)
      }
      return {
        digits: bounds(inked.digits),
        pushable: bounds(inked.pushable),
        previewable: bounds(inked.previewable),
        ring: bounds(inked.ring),
        runTopRow,
        runSecondRow,
      }
    },
    [png, layout.digitsLeftInClip, layout.runRightInClip, layout.runSpanInClip] as const,
  )
  return { ...layout, ink }
}

test('an item that can be pushed or previewed is marked by a still circle left of its number, in place of its border', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await loadAnonymous(page)
  await page.addScriptTag({ content: `window.__marksLeftOf = ${marksLeftOf.toString()}\nwindow.__stateCircles = ${stateCircles.toString()}` })
  // as the running mark's row: the plain and the runnable item whose text comes nearest to its
  // menu, and a second plain one
  const gaps = await textToMenu(page, [...Array(120).keys()])
  const at = (runnable: boolean, but = -1) => gaps.reduce((best, gap, at) => (gap.runnable == runnable && at != but && gap.nearest < (gaps[best]?.nearest ?? Infinity) ? at : best), -1)
  expect([at(false) >= 0, at(true) >= 0, at(false, at(false)) >= 0], 'two plain items and a runnable one with text beside the menu').toEqual([true, true, true])
  const [plain, runnable, other] = await page.evaluate(positions => positions.map(position => window.__items[position].id), [at(false), at(true), at(false, at(false))])
  // the two states as their writers set them: `pushable` through item code's setter (the pusher
  // and the updater mark an item so), `previewable` on the page's own record of the item (the app
  // alone sets it, when it fetches a preview); a change of the first re-ranks and renders both
  const mark = (id: string, pushable: boolean, previewable = false) =>
    page.evaluate(([id, pushable, previewable]) => {
      const item = window._item(id) as unknown as { pushable: boolean }
      ;(window.__items.find(item => item.id == id) as unknown as { previewable: boolean }).previewable = previewable
      item.pushable = !pushable
      item.pushable = pushable
    }, [id, pushable, previewable] as const)
  const look = async (id: string) => ({ ...(await runningLook(page, id)), ...(await circlesOf(page, id)) })
  const marked = async (id: string, pushable: boolean, previewable = false) => {
    await mark(id, pushable, previewable)
    await expect
      .poll(() => page.evaluate(id => (box => box && ['pushable', 'previewable'].map(state => box.classList.contains(state)))(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`)), id), { timeout: 30_000 })
      .toEqual([pushable, previewable])
    return look(id)
  }
  const run = async (id: string, running: boolean) => {
    await page.evaluate(([id, running]) => void ((window._item(id) as unknown as { running: boolean }).running = running), [id, running] as const)
    await expect.poll(() => page.evaluate(([id, running]) => !!document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]${running ? '.running' : ':not(.running)'}`), [id, running] as const), { timeout: 30_000 }).toBe(true)
  }
  const open = async (id: string) => {
    await page.evaluate(id => void (location.hash = id), id)
    await expect.poll(() => page.evaluate(id => !!document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"].target`), id), { timeout: 30_000 }).toBe(true)
  }
  // a window without the focus, as the app learns of it (its window's blur and document.hasFocus),
  // and the opacity it gives the items: whether the list is shown focused, and each item's
  const away = (gone: boolean) =>
    page.evaluate(gone => {
      if (gone) Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true })
      else delete (document as unknown as { hasFocus?: unknown }).hasFocus
      window.dispatchEvent(new Event(gone ? 'blur' : 'focus'))
    }, gone)
  const faded = (id: string) =>
    page.evaluate(id => {
      const opacity = (box: Element | null) => (box ? getComputedStyle(box.closest('.super-container')!).opacity : null)
      return [
        document.querySelector('.items')!.classList.contains('focused'),
        opacity(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`)),
        opacity(document.querySelector('.column:not(.hidden) .super-container:not(.hidden) > .container:not(.pushable):not(.previewable):not(.target):not(.target_context):not(.editing)')), // an item shown in no state
      ]
    }, id)

  // an item whose ONLY border was the state's: it has none now, and its menu stands where a plain
  // item's does; the circle is there all the same
  const apart = await marked(other, true)
  expect([apart.bordered, apart.border, apart.inset], 'pushable alone: no border class, the transparent border of a plain item, the menu not inset').toEqual([false, 'rgba(0, 0, 0, 0)', ['-1px', '-1px']])
  const apartInk = await circlesInk(page, other)
  expect([inks(apartInk.pushable, [18, 3]), apartInk.previewable, marksAre(apart.circles?.box ?? [], [[21, 4]])], `and its circle: 15 px of orange ink in the 18 px left of the digits, in a box with 3 px of air on its left (${JSON.stringify([apartInk, apart.circles?.box])})`).toEqual([true, null, true])
  // in a window without the focus every item dims to 0.75, and one that can be pushed or
  // previewed dims like the others (until 2026-11-19 it stayed at 0.95, which kept its border
  // readable: without the border it read as one oddly bright item)
  await away(true)
  await expect.poll(() => faded(other), { message: 'unfocused: the item that can be pushed dims as a plain one does', timeout: 15_000 }).toEqual([false, '0.75', '0.75'])
  const pink = await marked(other, false, true)
  expect([pink.bordered, pink.border, pink.inset], 'previewable alone: the same').toEqual([false, 'rgba(0, 0, 0, 0)', ['-1px', '-1px']])
  expect(await faded(other), 'unfocused: the item that can be previewed dims as a plain one does').toEqual([false, '0.75', '0.75'])
  await away(false)
  await expect.poll(() => faded(other), { message: 'focused again: nothing dims', timeout: 15_000 }).toEqual([true, '1', '1'])
  // (its ink read in the focused window: unfocused, the menu is at 0.5 and the item at 0.75)
  const pinkInk = await circlesInk(page, other)
  expect([inks(pinkInk.previewable, [18, 3]), pinkInk.pushable], `with its own circle, pink (${JSON.stringify(pinkInk)})`).toEqual([true, null])
  // SELECTING AN ITEM DOES NOT SHIFT ITS MENU: with both circles and the running ring showing,
  // measure their places and the number's digits relative to the item's own box while it is NOT
  // the target, then again for the same item as the target (whose border turns green and whose
  // place in the page moves). Both layout boxes and inked pixels must agree to the pixel
  await run(other, true)
  await marked(other, true, true)
  const beforeTarget = await cornerPlace(page, other)
  await open(other)
  const asTarget = await cornerPlace(page, other)
  expect([beforeTarget.bordered, beforeTarget.border, asTarget.bordered, asTarget.border], 'premise: plain to target border').toEqual([false, 'rgba(0, 0, 0, 0)', true, 'rgb(34, 68, 34)'])
  expect([beforeTarget.number.length, asTarget.number.length], 'premise: one-digit number before and after').toEqual([1, 1])
  const placeDiff = JSON.stringify({
    before: { boxTop: beforeTarget.boxTop, docTop: beforeTarget.docTop, number: beforeTarget.number, menu: beforeTarget.menu, digits: beforeTarget.digits, pushable: beforeTarget.pushable, previewable: beforeTarget.previewable, ring: beforeTarget.ring, ink: beforeTarget.ink },
    after: { boxTop: asTarget.boxTop, docTop: asTarget.docTop, number: asTarget.number, menu: asTarget.menu, digits: asTarget.digits, pushable: asTarget.pushable, previewable: asTarget.previewable, ring: asTarget.ring, ink: asTarget.ink },
  })
  expect(
    [asTarget.radius, asTarget.menu, asTarget.digits, asTarget.pushable, asTarget.previewable, asTarget.ring],
    `selecting an item does not shift its menu, digits, circles or running ring (${placeDiff})`,
  ).toEqual(['5px', beforeTarget.menu, beforeTarget.digits, beforeTarget.pushable, beforeTarget.previewable, beforeTarget.ring])
  expect(
    [asTarget.ink.digits?.rows, asTarget.ink.pushable, asTarget.ink.previewable, asTarget.ink.ring],
    `and by pixels relative to the item's box (${placeDiff})`,
  ).toEqual([beforeTarget.ink.digits?.rows, beforeTarget.ink.pushable, beforeTarget.ink.previewable, beforeTarget.ink.ring])
  await run(other, false)
  await mark(other, false) // (in no state the item goes back to its rank, which need not be on the page)

  // the item the address names (its place in the page is then the same in every state). No state:
  // no circle, no room, and the text within 14 px of the digits
  await open(plain)
  const idle = await marked(plain, false)
  expect([idle.circles, idle.ring, idle.marks, idle.room], 'an item in neither state').toEqual([null, null, [], ['0px', '0px']])
  expect([idle.text > 1, idle.text < 14], `its first line runs up to its number (${idle.text})`).toEqual([true, true])

  // pushable: one still ring, 15 px in the 18 px left of the digits, an image of the stroke the
  // running mark has (2 px, in the orange the border had), on the baseline of the number's line;
  // its room the placeholder's padding, which the text keeps out of; the menu not resized; the
  // border as it was
  const pushed = await marked(plain, true)
  const pushedInk = await circlesInk(page, plain)
  expect([pushed.circles, inks(pushedInk.pushable, [18, 3]), pushedInk.previewable], `the circle of an item that can be pushed, by its ink (${JSON.stringify(pushedInk)})`).toMatchObject([ONE, true, null])
  expect(marksAre(pushed.circles!.box, [[21, 4]]), `in the 18 px left of the digits, the image's 3 px of air on its left (${JSON.stringify(pushed.circles!.box)})`).toBe(true)
  expect([pushed.ring, pushed.marks, pushed.room, pushed.placeholder], 'no ring; the room is the placeholder\'s padding, and the menu is not resized').toEqual([null, [], ['0px', '18px'], idle.placeholder])
  expect(pushed.text, 'the text, which reached into those 18 px, keeps out of them').toBeGreaterThanOrEqual(18 + 1)
  expect([pushed.border, BORDERS.includes(pushed.border), pushed.overlay], 'the border is as it was, not the state\'s').toEqual([idle.border, false, 'hidden'])
  // the item the address names is the page's target, and a target stays at 0.95 in a window
  // without the focus, in a state too (the rule's other half, as it was)
  await away(true)
  await expect.poll(() => faded(plain), { message: 'unfocused: the target, which can be pushed, at 0.95', timeout: 15_000 }).toEqual([false, '0.95', '0.75'])
  await away(false)
  await expect.poll(() => faded(plain), { timeout: 15_000 }).toEqual([true, '1', '1'])
  // gone with the state, and the height the layout holds for the item with it
  await mark(plain, false)
  await expect.poll(() => look(plain), { message: 'no longer pushable: everything as before, the stored height too', timeout: 15_000 }).toEqual(idle)

  // previewable: the same in the pink of its border; both: two rings in one box, the previewable
  // one at its left end and the pushable one nearest the number, and the room of both
  const previewed = await marked(plain, false, true)
  const previewedInk = await circlesInk(page, plain)
  expect([previewed.circles, inks(previewedInk.previewable, [18, 3]), previewedInk.pushable], `the circle of an item that can be previewed, by its ink (${JSON.stringify(previewedInk)})`).toMatchObject([ONE, true, null])
  expect([marksAre(previewed.circles!.box, [[21, 4]]), previewed.room, previewed.text >= 18 + 1, previewed.border], `in the same 18 px (${JSON.stringify(previewed.circles!.box)}), kept free; the border as it was`).toEqual([true, ['0px', '18px'], true, idle.border])
  const both = await marked(plain, true, true)
  const bothInk = await circlesInk(page, plain)
  expect([both.circles, inks(bothInk.previewable, [36, 21]), inks(bothInk.pushable, [18, 3]), bothInk.previewable?.rows, bothInk.pushable?.rows], `both states: the previewable circle left of the pushable one, 3 px apart, on the same rows (${JSON.stringify(bothInk)})`).toMatchObject([{ ...ONE, width: '36px' }, true, true, bothInk.pushable?.rows, bothInk.previewable?.rows])
  // and HOLLOW, each in its border's colour (the review's round 1): the middle of each circle is
  // empty, as the running ring's is, and across its middle line its stroke is two runs of 2 px,
  // the left and the right, whose strongest pixel is its own colour within a few levels (#a52 for
  // the pushable circle, not the push button's brighter #f84; #c7c for the previewable one), so
  // that a filled disk, or another orange of the same bounds, fails
  const COLOURS = { previewable: [204, 119, 204], pushable: [170, 85, 34] } // #c7c and #a52
  const tinted = (colour: number[] | undefined, want: number[]) => !!colour && colour.every((channel, at) => Math.abs(channel - want[at]) <= 12)
  expect((['previewable', 'pushable'] as const).map(mark => [bothInk[mark]?.hollow, bothInk[mark]?.stroke?.runs, tinted(bothInk[mark]?.stroke?.colour, COLOURS[mark])]), `both circles hollow, each a stroke of 2 px on either side of its middle in its own colour (${JSON.stringify((['previewable', 'pushable'] as const).map(mark => [bothInk[mark]?.hollow, bothInk[mark]?.stroke]))})`).toEqual([[true, [2, 2], true], [true, [2, 2], true]])
  expect([marksAre(both.circles!.box, [[39, 4]]), both.room, both.text >= 36 + 1, both.placeholder, both.border], `in 36 px (${JSON.stringify(both.circles!.box)}), kept free`).toEqual([true, ['0px', '36px'], true, idle.placeholder, idle.border])

  // and running: the ring left of the circles, 3 px from them, and the room of all three; its
  // note's place is the menu's, as without the circles (the ring is moved by its margins: a
  // translate would make it the containing block of its note)
  await run(plain, true)
  const three = await marked(plain, true, true)
  expect([marksAre(three.marks, [[54, 39]]), marksAre(three.circles!.box, [[39, 4]]), three.room, three.text >= 54 + 1], `running in both states: the ring left of the two circles (${JSON.stringify(three.marks)}, ${JSON.stringify(three.circles!.box)})`).toEqual([true, true, ['0px', '54px'], true])
  expect(three.ring, 'the ring is the running mark still, and turns').toEqual(['15px', 'solid', '2px', BLUE, '50%', true])
  expect(await page.evaluate(id => getComputedStyle(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu > .index > .running-mark`)!).translate, plain), 'the ring is not translated').toBe('none')
  const two = await marked(plain, true)
  expect([marksAre(two.marks, [[36, 21]]), marksAre(two.circles!.box, [[21, 4]]), two.room], `running and pushable: the ring left of the circle (${JSON.stringify(two.marks)})`).toEqual([true, true, ['0px', '36px']])
  await run(plain, false)
  await mark(plain, false)
  await expect.poll(() => look(plain), { message: 'neither running nor in a state: everything as before, the stored height too', timeout: 15_000 }).toEqual(idle)

  // beside a run button: the button moves aside by the circle's room without the menu resizing,
  // and the text keeps out of where it then stands
  await open(runnable)
  const still = await marked(runnable, false)
  const natural = await fiveDigits(page, runnable)
  expect([still.circles, still.marks, still.run![0], natural.circles], 'a run button stands right before the number\'s box').toEqual([null, [], 4, null])
  const moved = await marked(runnable, true)
  expect([marksAre(moved.circles!.box, [[21, 4]]), moved.run, moved.room, moved.placeholder], `pushable: the circle between the run button and the digits (${JSON.stringify(moved.circles!.box)}), the button 18 px further left, the menu not resized`).toEqual([true, still.run!.map(edge => edge + 18), ['0px', '18px'], still.placeholder])
  expect(moved.text, 'and the text keeps out of where the button now stands').toBeGreaterThanOrEqual(moved.run![1] + 1)

  // beside a mark of item code, which says its room (22 px here, as in the running mark's row):
  // the circle stands left of it, and while the item runs the ring left of the circle. The same
  // beside a number beyond four digits, whose menu keeps its natural width
  const box = `.container[data-item-id="${runnable}"]`
  await page.addStyleTag({ content: `${box} { --item-mark-room: 22px }\n${box} .item-menu > .button.index::before { content: ''; flex: none; width: 19px; height: 15px; margin: 0 3px 0 -22px; background: #f5e389 }` })
  const beside = await marked(runnable, true)
  expect([marksAre(beside.marks, [[22, 4]]), marksAre(beside.circles!.box, [[43, 25]]), beside.run, beside.room, beside.placeholder], `a mark of item code nearest the digits and the circle left of it (${JSON.stringify(beside.marks)}, ${JSON.stringify(beside.circles!.box)})`).toEqual([true, true, still.run!.map(edge => edge + 40), ['22px', '18px'], still.placeholder])
  const five = await fiveDigits(page, runnable)
  expect([five.menu, marksAre(five.marks, [[22, 4]]), marksAre(five.circles!.box, [[43, 25]]), five.run], `five digits: the menu's natural width, the same marks (${JSON.stringify(five.marks)}, ${JSON.stringify(five.circles!.box)})`).toEqual([natural.menu, true, true, 4 + 40])
  await run(runnable, true)
  const all = await marked(runnable, true)
  expect([marksAre(all.marks, [[22, 4], [58, 43]]), marksAre(all.circles!.box, [[43, 25]]), all.run, all.room, all.placeholder], `and running: the ring left of the circle (${JSON.stringify(all.marks)}), the run button left of all three`).toEqual([true, true, still.run!.map(edge => edge + 58), ['22px', '36px'], still.placeholder])
  expect(all.text, 'and the text keeps out of it all').toBeGreaterThanOrEqual(all.run![1] + 1)
  const fiveAll = await fiveDigits(page, runnable)
  expect([fiveAll.menu, marksAre(fiveAll.marks, [[22, 4], [58, 43]]), marksAre(fiveAll.circles!.box, [[43, 25]]), fiveAll.run], `five digits, running: still the natural width (${JSON.stringify(fiveAll.marks)})`).toEqual([natural.menu, true, true, 4 + 58])
  await run(runnable, false)
  await marked(runnable, false)

  // A RUNNABLE TARGET ITEM: the run button alone steps 1 px down so the border's top line stays
  // clear above it (checked by pixels), while keeping the same side-to-side place as on a plain
  // item and without growing the menu (so circles and the ring stay at the exact same pixels too)
  const runTarget = await page.evaluate(async () => ((await window._create('e2e_runnable_target_probe\n```js_input\nreturn 1\n```')) as unknown as { id: string }).id)
  const searchPlain = async (query: string, id: string) => {
    await page.evaluate(query => {
      location.hash = ''
      ;(window as unknown as { MindBox: { set: (value: string) => void } }).MindBox.set(query)
    }, query)
    await expect
      .poll(() => page.evaluate(id => (box => !!box && !box.classList.contains('target') && !box.classList.contains('bordered'))(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`)), id), { timeout: 30_000 })
      .toBe(true)
  }
  await searchPlain('e2e_runnable_target_probe', runTarget)
  const runPlain = await cornerPlace(page, runTarget)
  await open(runTarget)
  const runSelected = await cornerPlace(page, runTarget)
  expect([runPlain.bordered, runSelected.bordered, runSelected.border, runPlain.number.length, runSelected.number.length], 'premise: plain runnable to target runnable (one-digit)').toEqual([false, true, 'rgb(34, 68, 34)', 1, 1])
  expect([runSelected.radius, runSelected.menuSize], 'a bordered runnable item keeps the outer corner radius and the same menu size (25 px high)').toEqual(['5px', runPlain.menuSize])
  expect(runSelected.run!.slice(1), `the run button keeps its side-to-side place on a target item (${JSON.stringify({ runPlain: runPlain.run, runSelected: runSelected.run })})`).toEqual(runPlain.run!.slice(1))
  expect(
    [
      runSelected.ink.runTopRow!.total >= 20,
      runSelected.ink.runTopRow!.border,
      runSelected.ink.runTopRow!.button,
      runSelected.ink.runSecondRow!.button,
      runSelected.ink.runSecondRow!.border,
    ],
    `by pixels: the target border's top line stays clear above the run button (${JSON.stringify({ top: runSelected.ink.runTopRow, second: runSelected.ink.runSecondRow })})`,
  ).toEqual([true, runSelected.ink.runTopRow!.total, 0, runSelected.ink.runSecondRow!.total, 0])
  expect([runPlain.run![0], runSelected.run![0]], 'the run button steps 1 px down on a bordered item').toEqual([0, 1])
  // and with state circles and the running ring on the same runnable item: stepping the button
  // must not grow the menu or shift the circles, ring or digits
  await searchPlain('e2e_runnable_target_probe', runTarget)
  await run(runTarget, true)
  await marked(runTarget, true, true)
  const runMarkedPlain = await cornerPlace(page, runTarget)
  await open(runTarget)
  const runMarkedTarget = await cornerPlace(page, runTarget)
  expect(
    [runMarkedTarget.menuSize, runMarkedTarget.digits, runMarkedTarget.pushable, runMarkedTarget.previewable, runMarkedTarget.ring, runMarkedTarget.run!.slice(1)],
    `runnable with circles and ring: selecting keeps menu size, digits, circles, ring and button x (${JSON.stringify({ plain: runMarkedPlain, target: runMarkedTarget })})`,
  ).toEqual([runMarkedPlain.menuSize, runMarkedPlain.digits, runMarkedPlain.pushable, runMarkedPlain.previewable, runMarkedPlain.ring, runMarkedPlain.run!.slice(1)])
  expect(
    [runMarkedTarget.ink.digits?.rows, runMarkedTarget.ink.pushable, runMarkedTarget.ink.previewable, runMarkedTarget.ink.ring],
    'and by pixels on the runnable item',
  ).toEqual([runMarkedPlain.ink.digits?.rows, runMarkedPlain.ink.pushable, runMarkedPlain.ink.previewable, runMarkedPlain.ink.ring])
  await run(runTarget, false)
  await mark(runTarget, false)

  // THE RE-WRAP (the circles' code review, 2026-11-19: the movement is the owner's to accept). While
  // a circle shows, the text's placeholder is 18 px wider (36 px for both), so at a wrap boundary a
  // word moves to the next line, the item grows by a line and the next item of its column moves
  // down; clearing the state reverses it. A local item whose one line of text ends 8 px before the
  // placeholder (a filler, an inline box, made as wide as puts it there), held first as the page's
  // target, with the item after it in its column: on each transition the box and the height the
  // layout holds for the item agree, the item is a line (30 px) taller while it can be pushed, and
  // its neighbour lower by as much
  const near = await page.evaluate(async () => ((await window._create('#e2e_rewrap its one line ends just before the number <span class="e2e-filler" style="display: inline-block"></span> wrapped')) as unknown as { id: string }).id)
  await open(near)
  const filler = await page.evaluate(async id => {
    const shown = () => document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`) as HTMLElement
    shown().scrollIntoView({ block: 'center' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const box = shown()
    const [word, spacer] = [box.querySelector('.e2e-filler')!.nextSibling!, box.querySelector('.item > [id^="menu-"]')!]
    const range = document.createRange()
    range.selectNodeContents(word)
    return Math.floor(spacer.getBoundingClientRect().left - range.getBoundingClientRect().right) - 8
  }, near)
  await page.addStyleTag({ content: `.e2e-filler { width: ${filler}px }` })
  // the item's box, the height the layout holds for it, the lines of its text, how far the word
  // after the filler ends before the placeholder, and where the next item of its column begins,
  // below the item's own top (and in the window)
  const wrapped = () =>
    page.evaluate(async id => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve))))
      const box = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`) as HTMLElement
      const own = box.closest('.super-container')!
      const after = [...own.parentElement!.querySelectorAll(':scope > .super-container:not(.hidden)')]
      const next = after[after.indexOf(own) + 1]!.querySelector(':scope > .container')!
      const [word, spacer] = [box.querySelector('.e2e-filler')!.nextSibling!, box.querySelector('.item > [id^="menu-"]')!]
      const range = document.createRange()
      range.selectNodeContents(word)
      // (the lines of its text: the tops of its text's boxes, the empty filler's left out)
      const texts: DOMRect[] = []
      const walker = document.createTreeWalker(box.querySelector('.item')!, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent!.trim()) texts.push(...(text => (range => (range.selectNodeContents(text), [...range.getClientRects()]))(document.createRange()))(node))
      const lines = new Set(texts.filter(line => line.width).map(line => Math.round(line.top))).size
      return {
        height: box.offsetHeight,
        stored: (window.__items.find(item => item.id == id) as unknown as { height: number }).height,
        lines,
        gap: Math.round(spacer.getBoundingClientRect().left - range.getBoundingClientRect().right),
        next: Math.round(next.getBoundingClientRect().top - box.getBoundingClientRect().top),
        at: Math.round(next.getBoundingClientRect().top),
        neighbour: next.getAttribute('data-item-id'), // (the same item on every reading: the premise that it is the one that moved)
      }
    }, near)
  const flat = await wrapped()
  expect([flat.lines, flat.stored, flat.gap > 0 && flat.gap < 18, flat.next > flat.height, !!flat.neighbour], `the premise: one line ending within the 18 px a circle takes (8 px before the placeholder, give or take the rounding of a place), the stored height the box's, the neighbour below (${JSON.stringify(flat)})`).toEqual([1, flat.height, true, true, true])
  await mark(near, true)
  await expect.poll(wrapped, { message: 'pushable: the word wrapped, the item a line taller and its stored height that of its box, the neighbour as much lower', timeout: 15_000 }).toMatchObject({ lines: 2, height: flat.height + 30, stored: flat.height + 30, next: flat.next + 30, neighbour: flat.neighbour })
  await mark(near, false)
  await expect.poll(wrapped, { message: 'no longer pushable: one line again, the height and the stored height as they were, the neighbour back', timeout: 15_000 }).toMatchObject({ lines: 1, height: flat.height, stored: flat.height, gap: flat.gap, next: flat.next, neighbour: flat.neighbour })
})

// A STATE CIRCLE UNDER A PRESS: A MOUSE'S CONTROL, AND WHAT IT WAS FOR A FINGER (the owner,
// 2026-11-19: "would it make sense for the pushable indicator to accept clicks (with hand icon)
// and actually trigger a push of the item, same as the push button in the editor?"). By the number
// each circle is an element of its own with NO listener of its own: the item's handlers tell a
// circle's press and click by the two elements the item made, and act only for a press that a
// MOUSE began (the pointer's type at the press), single, and released on the circle it was made
// on. The hand and the tooltip (`push`, `preview`) come with a mouse's pointer over the circle.
// The two rows below read the first item of the anonymous corpus, which is plain (no run button,
// no ring, no sparkle) and whose text stands where its pushable circle's middle is, and local
// items of their own, with the MindBox focused before each press.

// whether the item's editor is open, where the focus is, and the history's index
const focusName = (focused: string, id: string) => (focused == 'textarea-' + id ? 'its editor' : focused == 'textarea-mindbox' ? 'the MindBox' : focused || 'none')
const pressState = async (page: Page, id: string) => {
  const state = await page.evaluate(id => ({ editing: !!document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"].editing`), focus: document.activeElement?.id ?? '', entry: (window as unknown as { _history_index: number })._history_index }), id)
  return { ...state, focus: focusName(state.focus, id) }
}
// WHAT THE PAGE SAW OF A PRESS, in a record that listeners of the row's write (given to the
// window once, at the window, so that they see every event first and last): what the click was
// delivered to and its count (`clicked`: where, which circle, the event's detail), whether the
// click went on past the item (`bubbled`: the item's own click does, a circle's own is stopped
// at the item), the focus at the release, before any click handler has run (`held`: what the
// press alone did to it), and how long the press lasted in the page's own time (`ms`)
type Press = { clicked?: [string, string | null, number]; bubbled?: boolean; held?: string; down?: number; ms?: number }
type Pressing = { __press?: Press; __pressing?: boolean }
const where = (target: HTMLElement) => (target.closest('.item-menu') ? (target.closest('.index') ? 'number' : 'menu') : target.closest('a, mark, button, input') ? 'control' : target.closest('.item') ? 'text' : target.className)
const circle = (target: HTMLElement) => ['pushable', 'previewable'].find(state => target.classList.contains(state + '-mark')) ?? null
const pressRecorded = (page: Page) =>
  page.evaluate(`(() => {
    const where = ${where.toString()}
    const circle = ${circle.toString()}
    if (!window.__pressing) {
      window.__pressing = true
      window.addEventListener('mousedown', e => void (window.__press && (window.__press.down = e.timeStamp)), { capture: true })
      window.addEventListener('mouseup', e => void (window.__press && Object.assign(window.__press, { ms: Math.round(e.timeStamp - window.__press.down), held: document.activeElement?.id ?? '' })), { capture: true })
      window.addEventListener('click', e => void (window.__press && (window.__press.clicked = [where(e.target), circle(e.target), e.detail])), { capture: true })
      window.addEventListener('click', () => void (window.__press && (window.__press.bubbled = true)))
    }
    window.__press = {}
  })()`)
const pressed = (page: Page) => page.evaluate(() => (window as unknown as Pressing).__press ?? {})
// the point of a press: the middle of the pushable circle, whose ink is the 15 px that end 3 px
// before the digits, on the number's middle line (`far`: the circle 18 px further left, the
// previewable one of an item in both states), with a new record for the press
const circleSpot = async (page: Page, id: string, far = false) => {
  await pressRecorded(page)
  return page.evaluate(
    async ([id, far]) => {
      const box = `.column:not(.hidden) .container[data-item-id="${id}"]`
      document.querySelector(box)!.scrollIntoView({ block: 'center' })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve))))
      const index = document.querySelector(`${box} .item-menu > .index`) as HTMLElement
      const digits = document.createRange()
      digits.selectNodeContents(index.firstChild!)
      const [number, own] = [digits.getBoundingClientRect(), index.getBoundingClientRect()]
      return { x: number.left - 3 - 7.5 - (far ? 18 : 0), y: (own.top + own.bottom) / 2 }
    },
    [id, far] as const,
  )
}
// what stands at a point: where it is, which circle, its tooltip and its cursor
const standing = (page: Page, at: { x: number; y: number }) =>
  page.evaluate(`(hit => { const where = ${where.toString()}; const circle = ${circle.toString()}; return [where(hit), circle(hit), hit.getAttribute('title') ?? '', getComputedStyle(hit).cursor] })(document.elementFromPoint(${at.x}, ${at.y}))`) as Promise<[string, string | null, string, string]>
const focusMindbox = (page: Page) => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).focus({ preventScroll: true }))
// the page's timers and frames have run: for what a press must NOT have done
const settled = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)))))
// the item's two states as their writers set them (as in the circles' row), once the page shows them
const circlesStated = async (page: Page, id: string, pushable: boolean, previewable = false) => {
  await page.evaluate(([id, pushable, previewable]) => {
    const item = window._item(id) as unknown as { pushable: boolean }
    ;(window.__items.find(item => item.id == id) as unknown as { previewable: boolean }).previewable = previewable
    item.pushable = !pushable
    item.pushable = pushable
  }, [id, pushable, previewable] as const)
  await expect.poll(() => page.evaluate(id => (box => box && ['pushable', 'previewable'].map(state => box.classList.contains(state)))(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`)), id), { timeout: 30_000 }).toEqual([pushable, previewable])
}
// the preview call, seen by its own refusal: an item marked on the page's record, with no preview
// fetched, is refused at the call's first check, which the app logs. The refusals so far
const REFUSAL = 'preview item missing preview text'
const previewRefusals = (page: Page) => {
  const refusals: string[] = []
  page.on('console', message => void (message.type() == 'error' && message.text().includes(REFUSAL) && refusals.push(message.text())))
  return refusals
}

// the pusher's stand-in, a visitor's local item: the app dispatches `/push <name>` to it (the
// first listening item that defines the command), and it records the name it is asked to push,
// writes nothing anywhere, and returns what the row holds for it
const PUSHER = '#pusher #_listen the row\'s stand-in for the pusher: it records a push and writes nothing\n```js\nfunction _on_command_push(label) {\n  ;(window.__pushed ??= []).push(label)\n  return window.__push_return\n}\n```'
// A PRESS AS A SCRIPT GIVES IT, event by event, on an item's pushable circle or elsewhere (the
// page's body): for the orders of events that two pointers at once can make (a script fixes the
// target, the order and a legacy click's shape, which the rows' driver calls do not),
// and for the browsers whose click says nothing of its pointer. A step is an event's type, where
// it is dispatched, and the pointer's type (a `pointer…` event's, and a click's when it says one;
// a mousedown and a mouseup say none). Answers whether the LAST mousedown's default was prevented
type Step = readonly [type: 'pointerdown' | 'pointerup' | 'pointercancel' | 'mousedown' | 'mouseup' | 'click', on: 'circle' | 'elsewhere', pointer?: 'mouse' | 'touch']
const dispatched = (page: Page, id: string, steps: readonly Step[]) =>
  page.evaluate(
    ([id, steps]) => {
      const circle = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu .pushable-mark`) as HTMLElement
      let prevented: boolean | null = null
      for (const [type, on, pointer] of steps) {
        const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: type.endsWith('down') ? 1 : 0, detail: type.startsWith('pointer') ? 0 : 1 }
        const event = type.startsWith('pointer') || pointer ? new PointerEvent(type, { ...init, pointerType: pointer, pointerId: pointer == 'touch' ? 2 : 1, isPrimary: true }) : new MouseEvent(type, init)
        const went = (on == 'circle' ? circle : document.body).dispatchEvent(event)
        if (type == 'mousedown') prevented = !went
      }
      return prevented
    },
    [id, steps] as const,
  )

// WITH A MOUSE: the hand and the tooltip on each circle under the pointer, and a click that is the
// circle's alone. On the circle of an item that can be pushed it is the call of the edit menu's
// push button, seen two ways: on this notebook, which has no `#pusher` item, by the app's dialog
// that says so and names the item; and, once the row has made a local `#pusher` listener (it
// records the name it is asked to push and writes nothing anywhere), by that record. On the
// circle of an item that can be previewed it is the call a click on such an item makes, seen by
// its refusal, and for a local item with a preview, by the preview itself. No such click opens
// the item's editor, selects the item (a history entry more) or moves it by its number (its
// time), and the press takes no focus, from the MindBox or from another item's editor: read at
// the release, in the page, and again once the dialog has gone (a dialog gives the focus back to
// what had it when it opened). On an item in both states each circle acts for itself.
// THE CONTROL is the same click at the same point of the item in no state, which is the item's:
// its editor opens and takes the focus, as a click on a circle did until 2026-11-19. One driver
// call, press and release back to back: the item's own click must come within 250 ms of its
// press, which a driver round trip between the two can exceed on a loaded machine.
// WHAT ACTS ON NO CIRCLE: content of an item's own text with the circles' class names; a press on
// a circle released elsewhere, on the other circle or on the item's text (neither the circle's
// action nor the item's, though the release came within the item's 250 ms); and the second click
// of a double click, which arrives when a successful preview has put the pushable circle in the
// previewable one's place.
// THE PUSH ITSELF LEAVES THE MINDBOX ALONE: with a draft in the box and the focus there, the
// box's text is not replaced by the command's, what is typed while the push is still at work
// stays, and nothing clears or blurs the box at its end, whether the pusher resolves to nothing
// or to a text; from the editor's push button likewise (the same call)
test('with a mouse, a click on a state circle is the circle\'s own: it pushes the item, or previews it, and takes no focus', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await loadAnonymous(page)
  const id = await firstShown(page)
  const name = await page.evaluate(id => window._item(id)!.name, id)
  expect(await page.evaluate(() => !!window._item('#pusher', true)), 'the premise: a notebook without the #pusher item').toBe(false)
  const PUSH = `can not push ${name}, #pusher must be installed first`
  const refusals = previewRefusals(page)
  const dialog = () => page.evaluate(() => ((window as unknown as { _modal_visible: () => boolean })._modal_visible() ? (document.querySelector('.background.visible .modal')?.textContent ?? '').trim() : null))
  const pushes = () => page.evaluate(() => [...((window as unknown as { __pushed?: string[] }).__pushed ?? [])])
  const box = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  // what a circle's click must leave as it was (no editor, the focus, the history's index, the
  // item's time) beside what it adds (a dialog, a refusal, a push)
  const read = async (of = id) => ({ ...(await pressState(page, of)), time: await page.evaluate(id => (window.__items.find(item => item.id == id) as unknown as { time: number }).time, of), refusals: refusals.length, dialog: await dialog(), pushes: (await pushes()).length })
  // one real click at a circle's place, with the mouse brought there first (the hand and the
  // tooltip are read under it): one driver call, the press and the release back to back. The
  // focus is the MindBox's before it, or `holder`'s, which has it already
  const click = async (of = id, far = false, holder = 'the MindBox') => {
    const spot = await circleSpot(page, of, far)
    if (holder == 'the MindBox') await focusMindbox(page)
    const before = await read(of)
    expect(before, `the premise: ${holder} has the focus, the item's editor is not open and no dialog shows`).toMatchObject({ editing: false, focus: holder, dialog: null })
    await ready()
    await page.mouse.move(spot.x, spot.y)
    const at = await standing(page, spot)
    await page.mouse.click(spot.x, spot.y)
    const press = await pressed(page)
    return { spot, at, before, press, held: focusName(press.held ?? '', of), clicked: press.clicked?.slice(0, 2) ?? null, said: JSON.stringify(press) }
  }
  // a push's dialog, taken away by a click beside it, gives the focus back to what had it
  const dismissed = async (entry: number) => {
    await page.locator('.background.visible').click({ position: { x: 4, y: 4 } })
    await expect.poll(async () => (now => [now.dialog, now.editing, now.focus, now.entry])(await read()), { message: 'the dialog gone: no editor, no entry more, and the focus in the MindBox, where it was', timeout: 10_000 }).toEqual([null, false, 'the MindBox', entry])
  }
  const open = async (of: string) => {
    await page.evaluate(id => void (location.hash = id), of)
    await expect.poll(() => page.evaluate(id => !!document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"].target`), of), { timeout: 30_000 }).toBe(true)
  }
  // the page is ready for a press once it is done rendering: while it renders the items of a new
  // view (after a local item is made or named by the address) the route's own overlay lies over
  // the page and takes the click. (That overlay alone: an item's own, shown while the item is
  // saved, has no such class and lets a click through)
  const ready = () => expect.poll(() => page.evaluate(() => !document.querySelector('.loading.visible')), { message: 'the page is done rendering: the route\'s overlay is gone', timeout: 30_000 }).toBe(true)
  const closed = async () => {
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('.column:not(.hidden) .container.editing').length), { message: 'Escape closes the editor that was opened: none is open', timeout: 15_000 }).toBe(0)
  }
  // (the number's corner, which is the corner of the menu's last button: the circles' box comes
  // after the number in the menu, and a rule keeps the number's corner as it is)
  const corner = () => page.evaluate(id => getComputedStyle(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu > .index`)!).borderTopRightRadius, id)
  const cornered = await corner()

  // the control: in no state the point is the item's text, and the click the item's
  const plain = await click()
  await expect.poll(() => pressState(page, id), { message: `in no state a click at that point opens the item's editor, which takes the focus (the press as the page saw it: ${plain.said})`, timeout: 10_000 }).toEqual({ editing: true, focus: 'its editor', entry: plain.before.entry })
  expect([plain.at, plain.held, plain.clicked, plain.press.bubbled], `the text there: no circle, no tooltip, no hand; the press alone took the focus out of the MindBox, and the click went on past the item (${plain.said})`).toEqual([['text', null, '', 'auto'], 'none', ['text', null], true])
  await closed()

  // an item that can be pushed: the hand, the tooltip, and a click that is the push button's call
  await circlesStated(page, id, true)
  expect(await corner(), 'the number keeps the corner it has as the menu\'s last button').toBe(cornered)
  const push = await click()
  expect([push.at, push.held], `the circle of an item that can be pushed is an element of its own: under the mouse the tooltip \`push\` and the hand, and a press that takes no focus (${push.said})`).toEqual([['menu', 'pushable', 'push', 'pointer'], 'the MindBox'])
  await expect.poll(dialog, { message: `its click is the push button's call: without #pusher, the app's dialog that names the item (${push.said})`, timeout: 10_000 }).toBe(PUSH)
  expect([push.clicked, push.press.bubbled ?? false, await read()], 'the click was delivered to the circle and stopped at the item, and it is the circle\'s alone: no editor, no entry more (a select), the item\'s time as it was (a move by its number), no preview').toMatchObject([['menu', 'pushable'], false, { editing: false, entry: push.before.entry, time: push.before.time, refusals: push.before.refusals }])
  await dismissed(push.before.entry)

  // an item that can be previewed: the same, and a click that is the preview's call
  await circlesStated(page, id, false, true)
  const preview = await click()
  expect([preview.at, preview.held], `the circle of an item that can be previewed: the tooltip \`preview\`, the hand, and a press that takes no focus (${preview.said})`).toEqual([['menu', 'previewable', 'preview', 'pointer'], 'the MindBox'])
  await expect.poll(() => refusals.length - preview.before.refusals, { message: 'its click is the preview\'s call, seen by its refusal', timeout: 10_000 }).toBe(1)
  expect([preview.clicked, await read()], 'the click was the circle\'s alone: no editor, the focus still in the MindBox, no entry more, the item\'s time as it was, no dialog').toEqual([['menu', 'previewable'], { editing: false, focus: 'the MindBox', entry: preview.before.entry, time: preview.before.time, refusals: preview.before.refusals + 1, dialog: null, pushes: 0 }])

  // and with the focus in ANOTHER item's editor (the first other plain item shown, opened by a
  // click on it): the press and the click on the circle leave it there
  const other = await page.evaluate(id => (document.querySelector(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id]:not([data-item-id="${id}"]):not(.runnable)`) as HTMLElement).dataset.itemId!, id)
  const beside = await circleSpot(page, other)
  await page.mouse.click(beside.x, beside.y)
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? ''), { message: 'the premise: a click on another item opens its editor, which has the focus', timeout: 10_000 }).toBe('textarea-' + other)
  const edited = await click(id, false, 'textarea-' + other)
  expect([edited.at, edited.held], `a press on the circle takes no focus from another item's editor (${edited.said})`).toEqual([['menu', 'previewable', 'preview', 'pointer'], 'textarea-' + other])
  await expect.poll(() => refusals.length - edited.before.refusals, { message: 'and its click previews', timeout: 10_000 }).toBe(1)
  expect(await read(), 'with the focus still in that editor, and no editor of its own').toMatchObject({ editing: false, focus: 'textarea-' + other, entry: edited.before.entry, dialog: null })
  await closed()

  // both states: two circles, and each acts for itself
  await circlesStated(page, id, true, true)
  const near = await click()
  expect([near.at, near.held], `both states: the circle nearest the number is the pushable one (${near.said})`).toEqual([['menu', 'pushable', 'push', 'pointer'], 'the MindBox'])
  await expect.poll(dialog, { message: 'and its click pushes, on an item that can be previewed too', timeout: 10_000 }).toBe(PUSH)
  expect([near.clicked, await read()], 'a push alone: no preview, no editor').toMatchObject([['menu', 'pushable'], { editing: false, entry: near.before.entry, time: near.before.time, refusals: near.before.refusals }])
  await dismissed(near.before.entry)
  const far = await click(id, true)
  expect([far.at, far.held], `and the circle left of it the previewable one (${far.said})`).toEqual([['menu', 'previewable', 'preview', 'pointer'], 'the MindBox'])
  await expect.poll(() => refusals.length - far.before.refusals, { message: 'whose click previews', timeout: 10_000 }).toBe(1)
  expect([far.clicked, await read()], 'a preview alone: no dialog of a push, no editor, the focus still in the MindBox').toEqual([['menu', 'previewable'], { editing: false, focus: 'the MindBox', entry: far.before.entry, time: far.before.time, refusals: far.before.refusals + 1, dialog: null, pushes: 0 }])

  // A PRESS RELEASED OFF ITS CIRCLE DOES NOTHING. Pressed on the pushable circle and released on
  // the previewable one, the click is delivered to their common ancestor, the circles' box: no
  // push, and no preview by the item's own click either, which a press arms for 250 ms; pressed on
  // the circle of an item that can only be pushed and released on the item's text, no editor. The
  // release must come within those 250 ms for the item's click to be in question at all, so the
  // gesture (three driver calls) is made again, five times at most, until the page saw it so
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const made: Press[] = []
    while (made.length < 5 && !(made[made.length - 1]?.ms! < 250)) {
      await pressRecorded(page)
      await focusMindbox(page)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y)
      await page.mouse.up()
      made.push(await pressed(page))
    }
    await settled(page)
    return { press: made[made.length - 1], said: JSON.stringify(made) }
  }
  const [onPushable, onPreviewable] = [await circleSpot(page, id), await circleSpot(page, id, true)]
  const kept = await read()
  const across = await drag(onPushable, onPreviewable)
  expect([across.press.ms! < 250, across.press.clicked?.slice(0, 2), focusName(across.press.held ?? '', id)], `the premise: released within 250 ms, on the other circle, so that the click is the circles' box's; and the press took no focus (${across.said})`).toEqual([true, ['menu', null], 'the MindBox'])
  expect(await read(), `pressed on the pushable circle and released on the previewable one: no push, no preview, no editor (${across.said})`).toEqual(kept)
  await circlesStated(page, id, true)
  const onText = { x: onPushable.x - 60, y: onPushable.y }
  const off = await drag(onPushable, onText)
  expect([off.press.ms! < 250, off.press.clicked?.[1]], `the premise: released within 250 ms, off the circle (${off.said})`).toEqual([true, null])
  expect(await read(), `pressed on the circle and released on the item: no push, no editor (${off.said})`).toMatchObject({ editing: false, focus: 'the MindBox', dialog: null, refusals: kept.refusals, pushes: 0 })
  // and a circle MADE ANEW under a held press (the item leaves its state and enters it again
  // while the button is down: another element stands at that place) is not the circle that was
  // pressed: neither a click delivered to the new one (a script's here: where a browser sends the
  // click of such a press is its own affair, and Chromium sent the new circle none) nor the
  // release there does anything
  await pressRecorded(page)
  await focusMindbox(page)
  await page.mouse.move(onPushable.x, onPushable.y)
  await page.mouse.down()
  await circlesStated(page, id, false)
  await circlesStated(page, id, true)
  await page.evaluate(id => (document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu .pushable-mark`) as HTMLElement).click(), id)
  await page.mouse.up()
  const renewed = await pressed(page)
  await settled(page)
  expect([(await standing(page, onPushable)).slice(0, 2), await read()], `a click on the circle that took the pressed one's place, and the release there: no push, no editor (${JSON.stringify(renewed)})`).toMatchObject([['menu', 'pushable'], { editing: false, dialog: null, refusals: kept.refusals, pushes: 0 }])
  await circlesStated(page, id, false)

  // ONLY THE ITEM'S OWN CIRCLES ACT: content of an item's text that carries the menu's and the
  // circles' class names is content. A click on it is the item's (its editor opens), and no push
  // is called, for which this notebook would show its dialog
  const lookalike = await page.evaluate(async () => ((await window._create('#e2e_lookalike <div class="item-menu"><span class="state-marks"><span class="state-mark pushable-mark">content with the class names of a circle</span></span></div>')) as unknown as { id: string }).id)
  await open(lookalike)
  const fake = await page.evaluate(async id => {
    const span = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item .state-mark.pushable-mark`) as HTMLElement
    span.scrollIntoView({ block: 'center' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve))))
    const at = span.getBoundingClientRect()
    return { x: (at.left + at.right) / 2, y: (at.top + at.bottom) / 2, matches: !!span.closest('.item-menu .state-mark'), own: !!span.closest('.container')!.querySelector(':scope > .item-menu .state-mark') }
  }, lookalike)
  expect([fake.matches, fake.own], 'the premise: the content matches the selector of a circle in a menu, on an item that has no circle').toEqual([true, false])
  await pressRecorded(page)
  await focusMindbox(page)
  await ready()
  await page.mouse.move(fake.x, fake.y)
  await page.mouse.click(fake.x, fake.y)
  await expect.poll(async () => [(await pressState(page, lookalike)).editing, await dialog()], { message: `a click on such content is the item's: its editor opens, and nothing is pushed (${JSON.stringify(await pressed(page))})`, timeout: 10_000 }).toEqual([true, null])
  await closed()

  // THE PUSH ITSELF, AND THE MINDBOX. A local `#pusher` listener stands in for the pusher: it
  // records the name it is asked to push and returns what the row holds for it, a promise the row
  // settles or a text, and nothing is written anywhere. The item is a local one, shown by the
  // draft that the row types into the MindBox, which names it
  await page.evaluate(async text => void (await window._create(text)), PUSHER)
  await expect.poll(() => page.evaluate(() => !!window._item('#pusher', true)), { timeout: 15_000 }).toBe(true)
  const local = await page.evaluate(async () => ((await window._create('#e2e_pushed a local item of the row\'s, which can be pushed')) as unknown as { id: string }).id)
  const DRAFT = '#e2e_pushed and the draft of a new item'
  await focusMindbox(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(DRAFT)
  await circlesStated(page, local, true)
  await page.evaluate(() => void ((window as unknown as { __push_return: unknown; __push_done: unknown }).__push_return = new Promise(resolve => ((window as unknown as { __push_done: unknown }).__push_done = resolve))))
  expect(await box(), 'the premise: the MindBox holds the draft').toBe(DRAFT)
  const sent = await click(local)
  await expect.poll(pushes, { message: `with #pusher, the circle's click is a push of that item by name, once (${sent.said})`, timeout: 10_000 }).toEqual(['#e2e_pushed'])
  expect([sent.at, sent.held, await box(), (await pressState(page, local)).focus, await dialog()], 'while the push is at work: the draft is still the box\'s text, not the command\'s, and the focus is still there').toEqual([['menu', 'pushable', 'push', 'pointer'], 'the MindBox', DRAFT, 'the MindBox', null])
  await page.keyboard.type(' that goes on')
  await page.evaluate(() => (window as unknown as { __push_done: (value?: unknown) => void }).__push_done())
  await settled(page)
  expect([await box(), (await pressState(page, local)).focus, await pushes()], 'the push done, resolved to nothing: the box holds the draft and what was typed meanwhile, with the focus, neither cleared nor blurred').toEqual([DRAFT + ' that goes on', 'the MindBox', ['#e2e_pushed']])
  // a text that the pusher returns (it does when it finds no item by that name) is the box's text
  // for a command typed there: not for this one
  await page.evaluate(() => void ((window as unknown as { __push_return: unknown }).__push_return = '/push #e2e_pushed'))
  await click(local)
  await expect.poll(pushes, { timeout: 10_000 }).toEqual(['#e2e_pushed', '#e2e_pushed'])
  await settled(page)
  expect([await box(), (await pressState(page, local)).focus], 'a push that returns a text: the box as it was, with the focus').toEqual([DRAFT + ' that goes on', 'the MindBox'])
  // and the push button of the item's editor, which is the same call: the item's editor opened
  // by a click on its text, the button clicked, the box as it was
  await page.evaluate(() => void ((window as unknown as { __push_return: unknown }).__push_return = undefined))
  const text = await page.evaluate(id => {
    const item = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item`)!
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
    let last: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent!.trim() && !node.parentElement!.closest('a, mark, button, input')) last = node as Text
    const range = document.createRange()
    range.selectNodeContents(last!)
    const at = range.getClientRects()[0]
    return { x: at.left + Math.min(at.width / 2, 40), y: (at.top + at.bottom) / 2 }
  }, local)
  await page.mouse.click(text.x, text.y)
  await expect.poll(async () => (await pressState(page, local)).focus, { message: 'the premise: a click on the item\'s text opens its editor', timeout: 10_000 }).toBe('its editor')
  await page.locator(`.column:not(.hidden) .container[data-item-id="${local}"] .edit-menu .button.push`).click()
  await expect.poll(pushes, { message: 'the editor\'s push button is the same push', timeout: 10_000 }).toEqual(['#e2e_pushed', '#e2e_pushed', '#e2e_pushed'])
  await settled(page)
  expect(await box(), 'and leaves the box as it was too').toBe(DRAFT + ' that goes on')
  await closed()

  // WHOSE PRESS IT IS, WHEN TWO POINTERS OVERLAP (the review's round 1: a finger was down, a mouse
  // pressed elsewhere, and the finger's compatibility mousedown, delivered to the push circle,
  // was taken for the mouse's: the circle was armed, the touch press's default prevented, and
  // the click pushed though it said `touch`). A circle is armed by the mouse press that was MADE
  // ON IT and by nothing else. The orders of events are a script's (`dispatched`: the rows'
  // driver calls do not make a finger and a mouse overlap, and a real tap's mousedown at this
  // circle goes to the number), in this window, whose primary pointer hovers, as a laptop's with a touch screen. Of
  // each: the pushes it made (the stand-in's record), whether its last mousedown's default was
  // prevented (a touch press keeps its own: the focus goes where a tap's goes), and whether it
  // was the item's click (the editor of this item, which can only be pushed)
  const [M, E] = ['circle', 'elsewhere'] as const
  const orders: [string, Step[], [number, boolean, boolean]][] = [
    ['the control: a mouse\'s own press and click on the circle push once', [['pointerdown', M, 'mouse'], ['mousedown', M], ['mouseup', M], ['click', M, 'mouse']], [1, true, false]],
    ['THE INTERLEAVING: a finger down, a mouse press elsewhere, the finger\'s mousedown on the circle, its click a touch\'s', [['pointerdown', M, 'touch'], ['pointerdown', E, 'mouse'], ['mousedown', E], ['pointerup', M, 'touch'], ['mousedown', M], ['mouseup', M], ['click', M, 'touch']], [0, false, true]],
    ['the same, its click saying nothing of its pointer', [['pointerdown', M, 'touch'], ['pointerdown', E, 'mouse'], ['mousedown', E], ['pointerup', M, 'touch'], ['mousedown', M], ['mouseup', M], ['click', M]], [0, false, true]],
    ['a mouse\'s press on the circle, the click a touch\'s: refused, and not the item\'s either', [['pointerdown', M, 'mouse'], ['mousedown', M], ['mouseup', M], ['click', M, 'touch']], [0, true, false]],
    ['superseded: a mouse\'s press on the circle whose mousedown never came, a finger down elsewhere, then a mousedown on the circle', [['pointerdown', M, 'mouse'], ['pointerdown', E, 'touch'], ['mousedown', M], ['mouseup', M], ['click', M]], [0, false, true]],
    ['ended: the same mouse press released, then a mousedown on the circle', [['pointerdown', M, 'mouse'], ['pointerup', M, 'mouse'], ['mousedown', M], ['mouseup', M], ['click', M]], [0, false, true]],
    ['cancelled: the same mouse press cancelled, then a mousedown on the circle', [['pointerdown', M, 'mouse'], ['pointercancel', M, 'mouse'], ['mousedown', M], ['mouseup', M], ['click', M]], [0, false, true]],
    ['taken once: a second mousedown on the circle after the mouse\'s own', [['pointerdown', M, 'mouse'], ['mousedown', M], ['mousedown', M], ['mouseup', M], ['click', M]], [0, false, true]],
  ]
  for (const [what, steps, expected] of orders) {
    await ready()
    const count = (await pushes()).length
    const prevented = await dispatched(page, local, steps)
    await settled(page)
    expect([(await pushes()).length - count, prevented, (await pressState(page, local)).editing], `${what}: its pushes, its last mousedown's default prevented, the item's editor opened`).toEqual(expected)
    await closed()
  }

  // THE SECOND CLICK OF A DOUBLE CLICK ACTS ON NO CIRCLE (the owner's rule: a push goes outward
  // and takes a deliberate single click). A local item with a preview that succeeds (its record
  // given a source and the text of its file, as the app has them for an installed item): a click
  // on its previewable circle previews it, the item can be pushed and no longer previewed, and
  // the pushable circle stands where the previewable one stood, under the pointer. The second
  // click of a double click arrives there (the driver's click count of 2): nothing is pushed. A
  // single click after it pushes
  const PREVIEW = '#e2e_previewed as its file has it now'
  const twice = await page.evaluate(async preview => {
    const id = ((await window._create('#e2e_previewed as it was installed')) as unknown as { id: string }).id
    Object.assign(window.__items.find(item => item.id == id)!, { attr: { source: 'https://github.com/e2e/e2e/blob/master/e2e_previewed.md', owner: 'e2e', repo: 'e2e', branch: 'master', path: 'e2e_previewed.md', sha: 'e2e', token: null }, previewText: preview })
    return id
  }, PREVIEW)
  await open(twice)
  await circlesStated(page, twice, false, true)
  const before = (await pushes()).length
  const first = await click(twice)
  expect([first.at, first.clicked, first.press.clicked?.[2]], `the premise: a single click on the previewable circle of an item that can only be previewed (${first.said})`).toEqual([['menu', 'previewable', 'preview', 'pointer'], ['menu', 'previewable'], 1])
  const state = () => page.evaluate(id => (item => [item.text, item.pushable, item.previewable])(window.__items.find(item => item.id == id) as unknown as { text: string; pushable: boolean; previewable: boolean }), twice)
  await expect.poll(state, { message: 'the click previews: the item has its file\'s text, can be pushed and can no longer be previewed', timeout: 15_000 }).toEqual([PREVIEW, true, false])
  await expect.poll(() => page.evaluate(id => (box => box && ['pushable', 'previewable'].map(state => box.classList.contains(state)))(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`)), twice), { timeout: 15_000 }).toEqual([true, false])
  // (read at the point of the first click itself, where the mouse still is: nothing is scrolled
  // or measured again in between)
  await pressRecorded(page)
  expect((await standing(page, first.spot)).slice(0, 2), 'the premise: the pushable circle stands at the point where the previewable one was clicked, under the mouse').toEqual(['menu', 'pushable'])
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
  const again = await pressed(page)
  await settled(page)
  expect([again.clicked, (await pushes()).length - before, (await pressState(page, twice)).editing, await dialog()], `the second click of a double click, delivered to the pushable circle: no push, no editor (${JSON.stringify(again)})`).toEqual([['menu', 'pushable', 2], 0, false, null])
  await page.mouse.click(first.spot.x, first.spot.y)
  await expect.poll(async () => (await pushes()).slice(before), { message: 'a single click on it pushes', timeout: 10_000 }).toEqual(['#e2e_previewed'])
})

// IN A PHONE'S WINDOW A CIRCLE IS NO CONTROL, AND A TAP AT IT DOES WHAT ONE AT THAT POINT DID. The
// circle has no tooltip and no hand, before a tap and after one. A tap at the middle of the
// pushable circle, and the same tap at the same point of the same item in no state: the browser
// hands both to the NUMBER, 6.5 px from that point (Chromium's touch adjustment: the nearest
// element that takes clicks within the finger's area, the number's box beginning 4 px before the
// digits), which selects the item and takes the focus out of the MindBox, with the circle as
// without it. That is why the circles have no listener of their own: with one, or with a `:hover`
// rule that names a circle, this tap is the circle's and opens the item's editor (probed with a
// mutant of each; the ring's lesson).
// THE ONE TAP THAT REACHES A CIRCLE is on the previewable circle of an item in both states, 24.5 px
// from the number's box: it is delivered where it is made, and it is the ITEM'S click, as it was
// while the circles were the menu's `::before`. Three things say so, and a circle acting for
// itself there would fail each: the item's own handler previews an item that can be previewed
// (seen by the refusal), the tap takes the focus out of the MindBox, as a tap on the item's text
// does, and the click goes on past the item (the item's own click bubbles; a circle's own is
// stopped at the item, so a click that acted as the circle's after a press that did not would
// still be told)
test('in a phone\'s window a tap on a state circle, with the MindBox focused, is what a tap at that point was: no control of its own', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await loadAnonymous(page)
  expect(await page.evaluate(() => innerWidth), "a phone's window: 375 px").toBe(375)
  const id = await firstShown(page)
  const refusals = previewRefusals(page)
  const tapped = async (pushable: boolean, previewable = false) => {
    await circlesStated(page, id, pushable, previewable)
    const spot = await circleSpot(page, id, previewable)
    const at = await standing(page, spot)
    await focusMindbox(page)
    const before = { ...(await pressState(page, id)), refusals: refusals.length }
    expect(before, 'the premise: the MindBox has the focus, and no editor is open').toMatchObject({ editing: false, focus: 'the MindBox' })
    await page.touchscreen.tap(spot.x, spot.y)
    // the outcome as it shows, polled as the whole state, so that a tap that did otherwise says
    // what it did: a select (a history entry more, the focus out of the MindBox) for a tap the
    // number gets, and a refused preview (the focus out of the MindBox too) for one the item gets
    await expect
      .poll(async () => ({ ...(await pressState(page, id)), refusals: refusals.length }), { message: `a tap in a phone's window at that point${previewable ? ', on the previewable circle of an item in both states' : pushable ? ', on the circle' : ', on the text'}: its outcome (${JSON.stringify(await pressed(page))})`, timeout: 10_000 })
      .toEqual(previewable ? { editing: false, focus: 'none', entry: before.entry, refusals: before.refusals + 1 } : { editing: false, focus: 'none', entry: before.entry + 1, refusals: before.refusals })
    const [after, press] = [await pressState(page, id), await pressed(page)]
    const found = { hit: at[0], circle: at[1], tooltip: at[2], cursor: at[3], after: (await standing(page, spot)).slice(1), clicked: press.clicked?.slice(0, 2) ?? null, bubbled: press.bubbled ?? false, editing: after.editing, focus: after.focus, selected: after.entry != before.entry }
    // the starting state again: Back to the entry the select left, no state
    if (after.entry != before.entry) {
      await page.goBack()
      await expect.poll(async () => (await pressState(page, id)).entry, { timeout: 15_000 }).toBe(before.entry)
    }
    if (pushable || previewable) await circlesStated(page, id, false)
    return found
  }
  const [plain, circled] = [await tapped(false), await tapped(true)]
  expect([plain.hit, circled.hit], 'the spot is the item\'s text, and the circle\'s (in the menu) when it can be pushed').toEqual(['text', 'menu'])
  expect([circled.circle, circled.tooltip, circled.cursor], 'the circle is there, with no tooltip and no hand').toEqual(['pushable', '', 'auto'])
  const outcome = ({ editing, focus, selected }: typeof plain) => ({ editing, focus, selected })
  expect(outcome(circled), `a tap on the circle does what one at that point of the text did (${JSON.stringify([plain, circled])})`).toEqual(outcome(plain))
  expect([plain.clicked?.[0], circled.clicked?.[0], outcome(circled)], 'delivered to the number, with the circle as without it, which selects the item and takes the focus out of the MindBox').toEqual(['number', 'number', { editing: false, focus: 'none', selected: true }])
  const far = await tapped(true, true)
  expect([far.circle, far.tooltip, far.cursor, far.clicked, outcome(far)], `the previewable circle of an item in both states, far from the number: the tap is delivered to it, and is the item's (${JSON.stringify(far)})`).toEqual(['previewable', '', 'auto', ['menu', 'previewable'], { editing: false, focus: 'none', selected: false }])
  expect([far.bubbled, far.after], 'by the item\'s own click, which goes on past the item; and the finger left the circle no tooltip and no hand').toEqual([true, ['previewable', '', 'auto']])

  // AND A MOUSE ATTACHED TO THIS DEVICE IS A MOUSE (the positive control of the rule "by what
  // pressed"): in this same window, whose primary pointer is the finger and does not hover, a
  // real mouse's pointer over the push circle shows the hand and the tooltip, and its click
  // pushes, once, with the focus where it was. The push is seen by the pusher's stand-in, as in
  // the mouse's row; the item is named by the address, so that it stays on the page
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches), 'the premise: the primary pointer of this window does not hover').toBe(true)
  await page.evaluate(async text => void (await window._create(text)), PUSHER)
  await expect.poll(() => page.evaluate(() => !!window._item('#pusher', true)), { timeout: 15_000 }).toBe(true)
  await page.evaluate(id => void (location.hash = id), id)
  await expect.poll(() => page.evaluate(id => !!document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"].target`), id), { timeout: 30_000 }).toBe(true)
  await circlesStated(page, id, true)
  await expect.poll(() => page.evaluate(() => !document.querySelector('.loading.visible')), { message: 'the page is done rendering: the route\'s overlay is gone', timeout: 30_000 }).toBe(true)
  const spot = await circleSpot(page, id)
  await focusMindbox(page)
  await page.mouse.move(spot.x, spot.y)
  const under = await standing(page, spot)
  await page.mouse.click(spot.x, spot.y)
  const press = await pressed(page)
  await expect.poll(() => page.evaluate(() => [...((window as unknown as { __pushed?: string[] }).__pushed ?? [])]), { message: `a mouse's click on the push circle pushes the item, once (${JSON.stringify(press)})`, timeout: 10_000 }).toEqual([await page.evaluate(id => window._item(id)!.name, id)])
  expect([under, press.clicked?.slice(0, 2), focusName(press.held ?? '', id), (await pressState(page, id)).editing], `under the mouse the hand and the tooltip; the click delivered to the circle, the focus kept, no editor (${JSON.stringify(press)})`).toEqual([['menu', 'pushable', 'push', 'pointer'], ['menu', 'pushable'], 'the MindBox', false])
  await context.close()
})
