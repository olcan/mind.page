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
// item's menu: the menu size is measured once per menu shape, digit count and zoom and reused
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
    return {
      number: position + 1,
      runnable: !!seeded.runnable,
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
    expect(size.spacer, `spacer of item ${size.number} (runnable ${size.runnable})`).toEqual(size.menu)
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
// is the menu's. The placeholder also FOLLOWS the number: an item whose number gains a digit with
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
    if (mark) spacer.kept = true
    return {
      number: index.textContent!.trim(),
      shown: !!elem.closest('.column:not(.hidden)'),
      ch,
      box: parseFloat(getComputedStyle(index).width),
      overflow: index.scrollWidth - index.clientWidth,
      menu: menu.clientWidth,
      spacer: parseFloat(spacer.style.width),
      kept,
    }
  }, { id, mark })

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
    expect(room.spacer, `the placeholder of ${room.number} is its menu's`).toBe(room.menu)
  }

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
  expect([nine.number, nine.shown, nine.spacer], 'the item is shown as number 9, its placeholder its menu\'s').toEqual(['9', true, nine.menu])
  await touch(others.shift()!)
  await expect.poll(() => numberOf(followed)).toBe(10)
  // identity and width in ONE read, and no read marks: a replacement of the right size is no pass
  await expect.poll(async () => (room => room.kept && room.spacer == room.menu)(await numberRoom(page, followed)), { message: 'the marked placeholder follows the number to two digits', timeout: 5_000 }).toBe(true)
  const ten = await numberRoom(page, followed)
  expect([ten.number, ten.shown, ten.kept], 'the same placeholder, in the item still shown: its children were not replaced').toEqual(['10', true, true])
  expect(ten.menu, 'a second digit widens the menu').toBeGreaterThan(nine.menu)
  await context.close()
})
