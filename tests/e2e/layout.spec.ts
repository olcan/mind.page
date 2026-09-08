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
// item's menu: the menu size is measured once per menu shape and zoom and reused (menuSize), and
// the item's number is the menu's only per-item content, so a number of at most four digits gets a
// fixed width (.index.reserved, 4ch) and cannot size the menu. pinned across the 9/10 and 99/100
// boundaries and for the runnable items of the corpus's digit bands, then for the four-digit case
// (menus cloned in place with a one-digit and a four-digit number: equal widths, digits not
// overflowing) in the page's font and in a wider bold fallback face, where four digits exceed the
// web font's and the previous 36px reservation
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
// a rendered menu cloned beside itself with the number replaced: [menu width, number box width,
// number overflow], for a one-digit and a four-digit number, optionally under an injected font
const clonedMenuWidths = (page: Page, font = '') =>
  page.evaluate(async font => {
    const style = document.createElement('style')
    if (font) document.head.append(Object.assign(style, { textContent: `.item-menu > .index { font: ${font} }` }))
    await document.fonts.ready
    const menu = document.querySelector('.item-menu')!
    const widths = ['9', '1000'].map(text => {
      const clone = menu.cloneNode(true) as HTMLElement
      const index = clone.querySelector('.index') as HTMLElement
      index.textContent = text
      menu.parentElement!.append(clone)
      const width = [clone.clientWidth, index.clientWidth, index.scrollWidth - index.clientWidth]
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
  // the four-digit case: the same menu with a one-digit and a four-digit number has one width and
  // the digits fit their box, in the page's font and in a wider bold face (Verdana, installed on
  // the gate's machine; the premise asserts a wider rendered box, whatever face the browser picks,
  // so the case cannot pass vacuously)
  const [one, four] = await clonedMenuWidths(page)
  expect(four[0], 'menu width with 1000').toBe(one[0])
  expect(four[2], 'digits of 1000 fit their box').toBe(0)
  const [wideOne, wideFour] = await clonedMenuWidths(page, 'bold 15px Verdana')
  expect(wideFour[1], 'four digits are wider in the wide face').toBeGreaterThan(four[1])
  expect(wideFour[0], 'menu width with 1000 in the wide face').toBe(wideOne[0])
  expect(wideFour[2], 'digits of 1000 fit their box in the wide face').toBe(0)
})
