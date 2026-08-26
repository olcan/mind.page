import { expect, test, type Page } from '@playwright/test'
import { loadAnonymous } from './helpers.js'

// column layout (see updateItemLayout in index.svelte): columnCount is max(1, floor(width / 500)),
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

  await page.setViewportSize({ width: 1200, height: 900 }) // floor(1200 / 500) = 2 columns
  await loadAnonymous(page)
  await settle(2)
  const ids = await expectConsistentColumns(page)
  expect(ids.length).toBeGreaterThan(2)
  const fresh = await widths(page)
  expect(fresh.hidden, 'hidden column tracks the first on a fresh multi-column load').toBe(fresh.first)
  expect(fresh.cache, 'element cache tracks the first on a fresh multi-column load').toBe(fresh.first)

  for (const [width, count] of [
    [900, 1],
    [1200, 2],
    [1600, 3],
    [900, 1],
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
