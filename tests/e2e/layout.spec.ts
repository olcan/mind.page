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
// THE 1200 -> 900 -> 1200 ROUND TRIP IS THE POINT OF THIS TEST. It was quarantined for one round
// after roughly five stalls, all of it inside a full gate; the cause is now understood and fixed
// (checkLayout's width memo moved to updateItemLayout, which is what invalidates it — see
// lastDocumentWidth in index.svelte and the issue doc). Both viewport changes fit inside one 250ms
// resize-suppression window, a layout ran from another trigger meanwhile, and checkLayout then
// compared the grown-back width against its own stale observation of the same number.
// `LAYOUT_DIAGNOSTIC=1 tests/e2e/run.sh` re-arms the decision trace that diagnosed it; ordinary
// gates run the same assertions with no instrumentation.
// See issues/MindPage Column Layout Stalls After Growing Back.md
const DIAGNOSTIC = !!process.env.LAYOUT_DIAGNOSTIC
test('column layout follows viewport width, keeping items unique, ordered and correctly sized', async ({
  page,
}, testInfo) => {
  // scalar-only tracing inside checkLayout (see traceLayout in index.svelte), plus a test-side
  // heartbeat that separates main-thread starvation from a layout decision that ran and declined.
  // reading layout properties from here while reproducing would perturb the scheduling under test,
  // so nothing is polled from the page except the column count the assertions already need
  if (DIAGNOSTIC)
    await page.addInitScript(() => {
      ;(globalThis as any).__layoutTraceOn = true
      ;(globalThis as any).__beats = []
      setInterval(() => {
        const beats = (globalThis as any).__beats
        if (beats.length >= 500) beats.shift()
        beats.push(Math.round(performance.now()))
      }, 100)
      try {
        new PerformanceObserver(list => {
          const long = ((globalThis as any).__longTasks ??= [])
          for (const entry of list.getEntries())
            long.push({ t: Math.round(entry.startTime), ms: Math.round(entry.duration) })
        }).observe({ entryTypes: ['longtask'] })
      } catch {
        // longtask is not observable everywhere; the heartbeat gaps still show starvation
      }
    })
  const attachTrace = async (label: string) => {
    const dump = await page
      .evaluate(() => ({
        trace: (window as any).__layoutTrace ?? [],
        beats: (globalThis as any).__beats ?? [],
        longTasks: (globalThis as any).__longTasks ?? [],
        columns: document.querySelectorAll('.column:not(.hidden)').length,
        innerWidth,
        clientWidth: document.documentElement.clientWidth,
        layoutCount: (window as any).__layoutCount,
      }))
      .catch(e => ({ error: String(e) }))
    await testInfo.attach(label, { body: JSON.stringify(dump, null, 2), contentType: 'application/json' })
  }
  // one attachment per transition, so a failure carries the trace of the transition that stalled
  const settle = async (count: number, label: string) => {
    try {
      await expect.poll(() => columns(page), { timeout: 15_000 }).toBe(count)
    } finally {
      if (DIAGNOSTIC) await attachTrace(label)
    }
  }

  await page.setViewportSize({ width: 1200, height: 900 }) // floor(1200 / 500) = 2 columns
  await loadAnonymous(page)
  await settle(2, 'fresh-1200')
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
    await settle(count, `resize-${width}`)
    expect(await expectConsistentColumns(page)).toEqual(ids) // same visible set, reordered never
    await expect.poll(async () => (await widths(page)).hidden, { timeout: 2_000 }).toBe((await widths(page)).first)
    const sizes = await widths(page)
    expect(sizes.hidden, `hidden column tracks the first at ${width}`).toBe(sizes.first)
    expect(sizes.cache, `element cache tracks the first at ${width}`).toBe(sizes.first)
  }
})
