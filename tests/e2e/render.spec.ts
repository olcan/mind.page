import { expect, test } from '@playwright/test'
import { loadAnonymous } from './helpers.js'
import { normalize, renderedHtml } from './rendering.js'

// rendering goldens: the anonymous account (seeded from fixtures, see seed.mjs) is loaded as a
// signed-out visitor and every item is rendered via the app's own _render_item; the rendered html is
// normalized (volatile ids) and lightly formatted (one tag per line) for readable diffs, then
// compared to __snapshots__/render.spec.ts/<id>.html (create/update with --update-snapshots)

// items whose rendering is inherently dynamic and therefore only checked to render, not snapshotted
const DYNAMIC_ITEMS: Record<string, string> = {
  pqqYx32Zn5ejGW7PlbZE: 'live clock widget',
  UYPNsdxKgnZ7wUJjmzK1: 'welcome template (renders the corpus age in days, which drifts daily)',
}

test('anonymous account loads from the emulator', async ({ page }) => {
  await loadAnonymous(page)
  // 121 seeded items minus the welcome template, which read-only views drop (see adminItems)
  expect(await page.evaluate(() => window._items().length)).toBe(120)
})

test('the app cannot start until the cdn globals have loaded', async ({ page }) => {
  // tests/unit/app_html.spec.ts pins the shell's script order, which is most of this guarantee —
  // but %sveltekit.head% precedes those tags, so kit bootstrap moving into the head would satisfy
  // the structural check and still break this. that is what the browser is here for.
  // the quiet window is REAL: proving the app has not started needs elapsed time with the script
  // held. an earlier version used expect.poll(...).toBe(false), which returns on its FIRST sample
  // and so passed whether or not startup had been reordered
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  let reached = false
  await page.route(/c3@[\d.]+\/c3\.min\.js/, async route => {
    reached = true
    await held
    await route.continue()
  })
  const loaded = loadAnonymous(page)
  await expect.poll(() => reached, { timeout: 30_000 }).toBe(true) // the parser reached the script
  await page.waitForTimeout(1_500) // held: the app below it must not have started in that time
  expect(await page.evaluate(() => Boolean((window as any)._items)), 'the app started early').toBe(false)
  release()
  await loaded
  expect(errors.filter(error => /c3|hljs|graphviz|listLanguages|is not defined/.test(error))).toEqual([])
})

test('charts regenerate after a stale hidden render (zero-width skip)', async ({ page }) => {
  // clicking a section separator transiently renders off-screen items; their chart scripts measure
  // zero width in a delayed callback, skip generation and invalidate the element cache — which
  // must force a re-render when the empty element was already adopted (see invalidate_elem_cache
  // in index.svelte; regression under svelte 5, where adoption started winning that race and
  // charts came up empty when toggled into view)
  await loadAnonymous(page)
  await page.locator('.section-separator').last().click()
  await page.waitForTimeout(2_000) // let the stale chart callbacks fire
  for (const [name, charts] of [
    ['#charts', 2],
    ['#weight', 1],
  ] as const) {
    await page.evaluate(name => void (location.hash = name), name)
    await expect
      .poll(() => page.evaluate(name => window._item(name)?.elem?.querySelectorAll('svg').length ?? 0, name), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(charts)
  }
})

test('charts carry real data and geometry (semantic checks the masked goldens cannot make)', async ({ page }) => {
  // the goldens mask chart geometry (see normalize in rendering.ts), so data values, visibility
  // and nondegenerate geometry are asserted here on the live page instead; the #charts fixture
  // holds a bar chart (y1 [4,2,5,10], y2 [2,3,6,12]) and a line chart (y1 [4,2,6,10], y2 [2,3,7,12])
  await loadAnonymous(page)
  await page.evaluate(() => void (location.hash = '#charts'))
  await expect
    .poll(() => page.evaluate(() => window._item('#charts')?.elem?.querySelectorAll('.c3 svg').length ?? 0), {
      timeout: 30_000,
    })
    .toBe(2)
  const [bar, line] = await page.evaluate(() =>
    [...(window._item('#charts')!.elem as HTMLElement).querySelectorAll('.c3')].map((chart: any) => ({
      width: chart.querySelector('svg').clientWidth,
      height: chart.querySelector('svg').clientHeight,
      // series carry their bound data values (c3 attaches them as __data__ on each shape);
      // bar series render under .c3-chart-bar groups, line series under .c3-chart-line
      values: Object.fromEntries(
        [...chart.querySelectorAll('.c3-chart-bar, .c3-chart-line')]
          .map((series: any) => [
            [...series.classList].find((c: string) => c.startsWith('c3-target-')),
            [...series.querySelectorAll('.c3-bar, .c3-circle')].map((shape: any) => shape.__data__?.value),
          ])
          .filter(([, values]: any) => values.length),
      ),
      bars: [...chart.querySelectorAll('.c3-bar')].map((barpath: any) => {
        const box = barpath.getBBox()
        return { d: barpath.getAttribute('d'), area: box.width * box.height }
      }),
      line_paths: [...chart.querySelectorAll('.c3-chart-line path.c3-line')].map((path: any) => path.getAttribute('d')),
      tick_labels: [...chart.querySelectorAll('.c3-axis-y .tick text')].map((tick: any) => tick.textContent),
    })),
  )
  for (const chart of [bar, line]) {
    expect(chart.width).toBeGreaterThan(100)
    expect(chart.height).toBeGreaterThan(50)
  }
  // the bar chart binds the exact fixture values to its bars, with finite nonzero geometry
  expect(bar.values).toEqual({ 'c3-target-y1': [4, 2, 5, 10], 'c3-target-y2': [2, 3, 6, 12] })
  expect(bar.bars).toHaveLength(8)
  for (const barpath of bar.bars) {
    expect(barpath.d).not.toMatch(/NaN|Infinity/)
    expect(barpath.area).toBeGreaterThan(0)
  }
  // the line chart binds the exact fixture values to its points, with nondegenerate finite lines
  expect(line.values).toEqual({ 'c3-target-y1': [4, 2, 6, 10], 'c3-target-y2': [2, 3, 7, 12] })
  expect(line.line_paths).toHaveLength(2)
  for (const d of line.line_paths) {
    expect(d).not.toMatch(/NaN|Infinity/)
    expect(d.match(/L/g)!.length).toBeGreaterThanOrEqual(3) // 4 points per series
  }
  expect(line.tick_labels).toContain('10') // the line chart pins tick values [0, 5, 10]
})

test('every anonymous item renders as before', async ({ page }) => {
  await loadAnonymous(page)
  const ids: string[] = await page.evaluate(() => window._items().map(item => item.id))
  for (const id of ids) {
    const html = await renderedHtml(page, id)
    expect.soft(html, `item ${id} rendered`).not.toBeNull()
    if (html != null && !(id in DYNAMIC_ITEMS)) expect.soft(normalize(html), `item ${id}`).toMatchSnapshot(`${id}.html`)
  }
})
