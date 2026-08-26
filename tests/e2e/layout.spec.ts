import { expect, test, type Page } from '@playwright/test'
import { loadAnonymous } from './helpers.js'

// column layout (see updateItemLayout in index.svelte): columnCount is max(1, floor(width / 500)),
// every visible item is rendered exactly once with per-column order following index order, and the
// hidden render column and element cache track the first column's width; this pins the layout
// math ahead of its extraction from index.svelte

const columns = (page: Page) => page.evaluate(() => document.querySelectorAll('.column:not(.hidden)').length)
// visible item ids in index order (the layout must never reorder or drop them)
const visibleIds = (page: Page) =>
  page.evaluate(() => window.__items.slice(0, window.__hideIndex).map(item => item.id))
// rendered item ids per visible column, in dom order
const renderedByColumn = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.column:not(.hidden)')].map(column =>
      [...column.querySelectorAll('.super-container')].map(elem => elem.id.replace('super-container-', ''))
    )
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
    Object.fromEntries(window.__items.slice(0, window.__hideIndex).map(item => [item.id, item.column]))
  )
  by_column.forEach((column, index) => {
    for (const id of column) expect(assigned[id], `item ${id} in its assigned column`).toBe(index)
    const positions = column.map(id => ids.indexOf(id))
    expect(positions, 'column order follows index order').toEqual([...positions].sort((a, b) => a - b))
  })
  return ids
}

// NOTE two loads, kept apart because of an INTERMITTENT, unexplained stall. Merging them into one
// test that cycles 900 -> 1200 -> 1600 -> 900 was tried; twice the grow back to 1200 left the page
// at one column for more than 8s. It has NOT reproduced since — 29 consecutive round trips settled
// in 400-500ms, including under a fully concurrent gate — so the cause is unknown and the merge is
// not proven unsafe, only unproven. Until it is explained, these stay separate: only a merged test
// exercises 1200 -> 900 -> 1200, and a rare multi-second stall there would flake the gate.
test('column count follows viewport width; items stay unique and ordered', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 }) // floor(900 / 500) = 1 column
  await loadAnonymous(page)
  expect(await columns(page)).toBe(1)
  const ids = await expectConsistentColumns(page)
  expect(ids.length).toBeGreaterThan(2)

  for (const [width, count] of [
    [1200, 2],
    [1600, 3],
    [900, 1],
  ] as const) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => columns(page), { timeout: 15_000 }).toBe(count)
    expect(await expectConsistentColumns(page)).toEqual(ids) // same visible set, reordered never
  }
})

test('the hidden render column and element cache track the first column width', async ({ page }) => {
  // a FRESH multi-column load: startup sizing is its own case, distinct from the reflow below
  await page.setViewportSize({ width: 1200, height: 900 })
  await loadAnonymous(page)
  await expect.poll(() => columns(page), { timeout: 15_000 }).toBe(2)
  let sizes = await widths(page)
  expect(sizes.hidden).toBe(sizes.first)
  expect(sizes.cache).toBe(sizes.first)
  // after a reflow the recreated column div must be re-sized promptly (post-flush re-apply in
  // updateItemLayout, not an eventual later layout pass): renders started right after the reflow
  // measure against these widths, e.g. charts skip rendering at zero width
  await page.setViewportSize({ width: 900, height: 900 })
  await expect.poll(() => columns(page), { timeout: 15_000 }).toBe(1)
  await expect.poll(async () => (await widths(page)).hidden, { timeout: 2_000 }).toBe((await widths(page)).first)
  sizes = await widths(page)
  expect(sizes.hidden).toBe(sizes.first)
  expect(sizes.cache).toBe(sizes.first)
})
