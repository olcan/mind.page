import { expect, test, type Page } from '@playwright/test'
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
// leaves by moving aside. The status line, which the overlay carried, is one line at the bottom
// of the running item's box: cut when too long, with its progress as a bar under it, and no room
// taken when it is empty or the item does not run. (The ring in the editor, the two marks side by
// side and the overlay of an item that is being saved are the watched mark's row,
// tests/e2e/sparkle.spec.ts, on an account that can edit and save.)
const BLUE = 'rgb(68, 170, 255)' // #4af
// marks as measured against their boxes' own edges: as many, and every edge within two pixels (a
// pixel for the whole pixels the hit test reads, and one more that a box at a fractional place
// read: the cloned five-digit menu's mark, 1.28 px wide of its edge)
const marksAre = (marks: number[][], boxes: number[][]) =>
  marks.length == boxes.length && marks.every((mark, at) => mark.every((edge, side) => Math.abs(edge - boxes[at][side]) < 2))
// the boxes drawn left of a number's own box, found by a hit test along the number's middle line
// (a pseudo-element answers as its element): each as [from, to], px left of the digits, the
// nearest first, read off whole pixels (so each edge can read up to a pixel wide of the box's
// own: `marksAre` compares within that). The ring is measured standing still: a hit test reads a
// turning box up to 2 px wide of it. Given to the page once (`window.__marksLeftOf`), for the
// row's readers
function marksLeftOf(index: HTMLElement): number[][] {
  const digits = document.createRange()
  digits.selectNodeContents(index.firstChild!)
  const [number, own] = [digits.getBoundingClientRect(), index.getBoundingClientRect()]
  const still = document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '.item-menu > .index::after { animation: none !important }' }))
  const marks: number[][] = [] // pixel by pixel leftwards from the number's own box: [left edge of the first pixel hit, right edge of the last]
  for (let k = 1, pixel = Math.floor(own.left) - 1; k <= 70; k++, pixel--) {
    if (document.elementFromPoint(pixel + 0.5, (own.top + own.bottom) / 2) !== index) continue
    const last = marks[marks.length - 1]
    if (last && last[0] == number.left - pixel - 1) last[0] = number.left - pixel
    else marks.push([number.left - pixel, number.left - pixel - 1])
  }
  still.remove()
  return marks
}
type Scanning = { __marksLeftOf: typeof marksLeftOf }
// what an item's box shows of running, read off the item in the SHOWN column (an element can be
// mounted in the offscreen render column alone) and found again after the frames it waits. `text` is how far left of the digits the nearest
// line of the item's text ends, of the lines that stand beside the number; `run` the same for a
// run button's two edges
const runningLook = (page: Page, id: string) =>
  page.evaluate(async id => {
    const shown = () => document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`) as HTMLElement
    shown().scrollIntoView({ block: 'center' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const box = shown()
    const [menu, index, spacer, loading, status] = ['.item-menu', '.item-menu > .index', '.item > [id^="menu-"]', ':scope > .loading', ':scope > .run-status'].map(part => box.querySelector(part) as HTMLElement) // (the box's own: an item's html can hold these classes)
    const digits = document.createRange()
    digits.selectNodeContents(index.firstChild!)
    const [number, own, whole] = [digits.getBoundingClientRect(), index.getBoundingClientRect(), box.getBoundingClientRect()]
    const turning = getComputedStyle(index, '::after').animationName != 'none' // read before the measure stops it
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
    const [ring, placed, said] = [getComputedStyle(index, '::after'), getComputedStyle(spacer), getComputedStyle(status)]
    const line = status.getBoundingClientRect()
    const middle = document.elementFromPoint((whole.left + whole.right) / 2 - 40, (whole.top + whole.bottom) / 2)
    return {
      running: box.classList.contains('running'),
      bordered: box.classList.contains('bordered'),
      border: getComputedStyle(box).borderTopColor,
      overlay: getComputedStyle(loading).visibility,
      covered: !!middle?.closest('.loading'), // something of the overlay lies over the item's middle
      // (the stroke's style and width too: without them a transparent box still turns, hit-tests and reports the colour)
      ring: ring.content == 'none' ? null : [ring.width, ring.borderTopStyle, ring.borderTopWidth, ring.borderTopColor, ring.borderRadius, turning],
      marks,
      room: [placed.marginLeft, placed.paddingLeft],
      placeholder: [parseFloat(spacer.style.width), menu.clientWidth],
      text,
      run: run ? [Math.round(number.left - run.right), Math.round(number.left - run.left)] : null, // a run button's right and left edge
      height: whole.height,
      // the height the layout holds for the item (index.svelte, onItemResized) against the box's own
      stored: [(window.__items.find(item => item.id == id) as unknown as { height: number }).height, box.offsetHeight],
      html: status.innerHTML, // the status as written, shown or not
      status: said.display == 'none' ? null : {
        text: status.textContent,
        tall: line.height, // one line: 16 px and the bar's 3
        rows: new Set([...status.children].map(child => Math.round(child.getBoundingClientRect().top))).size, // of its child elements
        inside: line.left >= whole.left && line.right <= whole.right && line.top >= whole.top && line.bottom <= whole.bottom,
        below: line.top >= box.querySelector('.item')!.getBoundingClientRect().bottom, // under the text's box
        lines: line.height / parseFloat(said.lineHeight), // a second line would double it
        cut: [status.scrollWidth > status.clientWidth, said.textOverflow],
        bar: [said.backgroundImage.startsWith('linear-gradient'), status.style.getPropertyValue('--progress')],
      },
    }
  }, id)

test('a running item is marked by a circle left of its number and by nothing else, with its status line at its bottom', async ({ page }) => {
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
  expect([idle.ring, idle.marks, idle.room, idle.overlay, idle.status], 'an item that does not run').toEqual([null, [], ['0px', '0px'], 'hidden', null])
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

  // the status line: at the bottom of the box, one line, cut when too long, with its progress;
  // none when empty or when the item does not run. It is one line of HEIGHT whatever html the
  // status holds (two blocks, a native progress), and the height the layout holds for the item
  // (item.height, by which the columns are filled) follows the line as it shows and goes, though
  // no component updates then: this item is settled and has no log
  const say = (status: string, progress: number, id = plain) =>
    page.evaluate(([id, status, progress]) => {
      const item = window._item(id) as unknown as { status: string; progress: number }
      item.status = status
      item.progress = progress
    }, [id, status, progress] as const)
  const said = (text: string | null, id = plain) => expect.poll(async () => (await runningLook(page, id)).status?.text ?? null, { timeout: 15_000 }).toBe(text)
  await expect.poll(async () => (await runningLook(page, plain)).stored, 'the premise: the stored height is the running box\'s').toEqual([ran.stored[1], ran.stored[1]])
  await say('waiting for the lanes …', 0)
  await said('waiting for the lanes …')
  const short = await runningLook(page, plain)
  expect(short.status, 'a short status: inside the box, under the text, one line, nothing cut, no bar').toMatchObject({ tall: 19, inside: true, below: true, lines: expect.closeTo(1.2, 1), cut: [false, 'ellipsis'], bar: [false, '0.000%'] })
  expect(short.stored, 'the line takes 33 px (its 16, the bar\'s 3, and 14 that keep it clear of the summaries), and the stored height has them').toEqual([ran.stored[1] + 33, ran.stored[1] + 33])
  const LONG = 'a status that is much longer than the item is wide '.repeat(6).trim()
  await say(LONG, 0.6)
  await said(LONG)
  const long = await runningLook(page, plain)
  expect(long.status, 'a long status with a progress: still one line, cut, with the bar at 60%').toMatchObject({ tall: 19, inside: true, below: true, lines: short.status!.lines, cut: [true, 'ellipsis'], bar: [true, '60.000%'] })
  expect(long.height, 'a long status is no taller').toBe(short.height)
  // (two blocks are laid out side by side, on the line; two elements that insist on being blocks
  // are held to the line's height all the same; a native progress stands in the line)
  const BLOCKS = '<span style="display: block">first</span><span style="display: block">second</span>'
  for (const [html, text, rows] of [['<div>first part</div><div>second part</div>', 'first partsecond part', 1], [BLOCKS, 'firstsecond', 2], ['<progress value="0.4"></progress> working', ' working', 1]] as const) {
    await say(html, 0)
    await said(text)
    const held = await runningLook(page, plain)
    expect([held.status!.tall, held.status!.rows, held.height], `one line of height for ${html}`).toEqual([19, rows, short.height])
  }
  await run(plain, false)
  await shown(plain, false)
  expect([(await runningLook(page, plain)).status, (await runningLook(page, plain)).height], 'the item no longer runs: no line and no room, whatever the status').toEqual([null, idle.height])
  await run(plain, true)
  await shown(plain, true)
  await said(' working')
  await expect.poll(async () => (await runningLook(page, plain)).stored, 'running again with its status: the stored height is the box\'s (the component updated)').toEqual(short.stored)
  await say('', 0)
  await said(null)
  const cleared = await runningLook(page, plain)
  expect([cleared.height, cleared.stored], 'an empty status takes no room, and the stored height gives it back').toEqual([ran.height, [ran.stored[1], ran.stored[1]]])
  // whether the line shows is the stylesheet's question, and the setter asks it the same way
  // (review 1): a status that is a COMMENT alone is `:empty` and shows no line, though its html is
  // no empty string. From the comment to a status and back the line shows and goes, and the stored
  // height with it. The status in between is markup of the log's own class: it is no log of the
  // item's (the layout leaves an item's log out of its height, and this item has none), so
  // nothing of it is taken off
  const written = async (html: string) => {
    await say(html, 0)
    await expect.poll(async () => (await runningLook(page, plain)).html, { timeout: 15_000 }).toBe(html)
    return (await runningLook(page, plain)).stored
  }
  expect(await written('<!--pending-->'), 'a comment alone: no line, the height as it was').toEqual([ran.stored[1], ran.stored[1]])
  expect(await written('<code class="_log">working</code>'), 'from the comment to a status, of the log\'s class: the line shows, and all of its height is stored').toEqual(short.stored)
  expect(await written('<!--pending-->'), 'and back to the comment: the line goes, and the stored height with it').toEqual([ran.stored[1], ran.stored[1]])
  await written('')
  await run(plain, false)
  await shown(plain, false)
  expect({ ...(await runningLook(page, plain)), stored: idle.stored }, 'no longer running: everything as before').toEqual(idle)

  // the line is the item's OWN, and clear of the summaries along the item's lower edge. A local
  // item whose html holds a box with the line's very classes, and a log line (so a log summary):
  // a status and a progress reach the item's line and are read back from it, the widget keeps its
  // text and gets no progress; and a hit on the line's last pixel row is the line's, where the
  // log summary's 22 px target used to lie over it, a hit on the summary the summary's
  const made = await page.evaluate(async () => {
    const text = '#e2e_status_widget an item whose html holds a status box of its own, with a log line\n<div class="container"><div class="run-status">job output</div></div>\n' + '```_log\n12:00:00 a line of its log\n```'
    return ((await window._create(text)) as unknown as { id: string }).id
  })
  await open(made)
  await run(made, true)
  await shown(made, true)
  await say('working …', 0.6, made)
  await said('working …', made)
  expect(
    await page.evaluate(id => {
      const box = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`) as HTMLElement
      const [line, widget, summary] = [':scope > .run-status', '.item .container > .run-status', '.item > .log-summary'].map(part => box.querySelector(part) as HTMLElement)
      const item = window._item(id) as unknown as { status: string; progress: number }
      const [lined, summed] = [line.getBoundingClientRect(), summary.getBoundingClientRect()]
      const hit = (x: number, y: number) => (at => (at === line ? 'line' : at?.closest('.log-summary') ? 'summary' : (at?.className ?? null)))(document.elementFromPoint(x, y))
      return {
        line: [line.textContent, line.getAttribute('data-progress'), line.style.getPropertyValue('--progress')],
        widget: [widget.textContent, widget.getAttribute('data-progress'), widget.style.getPropertyValue('--progress')],
        read: [item.status, item.progress],
        hits: [hit(box.getBoundingClientRect().left + 20, lined.bottom - 1), hit(summed.left + 10, summed.top + 2)],
        clear: summed.top >= lined.bottom,
      }
    }, made),
    'the status and the progress are the item\'s line\'s, the widget is untouched, and the line and the log summary each take their own hits',
  ).toEqual({ line: ['working …', '0.6', '60.000%'], widget: ['job output', null, ''], read: ['working …', 0.6], hits: ['line', 'summary'], clear: true })
  await say('', 0, made)
  await said(null, made)
  await run(made, false)
  await shown(made, false)

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
  const fiveDigits = () =>
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
        run: Math.round(digits.getBoundingClientRect().left - clone.querySelector('.run')!.getBoundingClientRect().right),
      }
      clone.remove()
      return found
    }, runnable)
  const natural = await fiveDigits()
  expect([natural.reserved, natural.menu > still.placeholder[1], natural.marks, natural.run], 'a five-digit number: no reserved width, a wider menu, no mark').toEqual(['normal', true, [], 4])
  const box = `.container[data-item-id="${runnable}"]`
  await page.addStyleTag({ content: `${box} { --item-mark-room: 22px }\n${box} .item-menu > .button.index::before { content: ''; flex: none; width: 19px; height: 15px; margin: 0 3px 0 -22px; background: #f5e389 }` })
  const marked = await runningLook(page, runnable)
  expect([marksAre(marked.marks, [[22, 4]]), marked.run, marked.room, marked.placeholder], `a mark of item code (${JSON.stringify(marked.marks)}): its 22 px kept free by the app`).toEqual([true, still.run!.map(edge => edge + 22), ['22px', '0px'], still.placeholder])
  const five = await fiveDigits()
  expect([five.menu, marksAre(five.marks, [[22, 4]]), five.run], `five digits, marked (${JSON.stringify(five.marks)}): the menu's natural width`).toEqual([natural.menu, true, 4 + 22])
  await run(runnable, true)
  await shown(runnable, true)
  const both = await runningLook(page, runnable)
  expect([marksAre(both.marks, [[22, 4], [40, 25]]), both.run, both.room, both.placeholder], `and running: the mark where it was and the ring left of it (${JSON.stringify(both.marks)}), the run button left of both, the room their sum`).toEqual([true, still.run!.map(edge => edge + 40), ['22px', '18px'], still.placeholder])
  expect(both.text, 'and the text keeps out of it all').toBeGreaterThanOrEqual(both.run![1] + 1)
  const fiveBoth = await fiveDigits()
  expect([fiveBoth.menu, marksAre(fiveBoth.marks, [[22, 4], [40, 25]]), fiveBoth.run], `five digits, marked and running (${JSON.stringify(fiveBoth.marks)}): still the natural width, the ring left of the mark, the run button left of both`).toEqual([natural.menu, true, 4 + 40])
  await run(runnable, false)
  await shown(runnable, false)
})
