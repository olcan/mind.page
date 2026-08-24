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

test('the app waits for the cdn scripts even when they are slow', async ({ page }) => {
  // kit's bootstrap is an inline import(), which unlike sapper's classic bundle tag is not parser
  // ordered: the app container sits below the parser-blocking cdn script tags (see app.html) so
  // that items cannot evaluate before the globals (c3, hljs, graphviz, ...) exist
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.route(
    /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com/,
    route => void setTimeout(() => route.continue(), 2_500)
  )
  await loadAnonymous(page)
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
  // the goldens mask chart geometry (see normalize in rendering.ts), so data shape, visibility
  // and nondegenerate geometry are asserted here on the live page instead
  await loadAnonymous(page)
  await page.evaluate(() => void (location.hash = '#charts'))
  await expect
    .poll(() => page.evaluate(() => window._item('#charts')?.elem?.querySelectorAll('.c3 svg').length ?? 0), {
      timeout: 30_000,
    })
    .toBe(2)
  const charts = await page.evaluate(() =>
    [...(window._item('#charts')!.elem as HTMLElement).querySelectorAll('.c3')].map((chart: any) => ({
      width: chart.querySelector('svg').clientWidth,
      height: chart.querySelector('svg').clientHeight,
      // both seeded charts plot series y1 and y2 (see the #charts fixture)
      series: [...chart.querySelectorAll('.c3-chart-line')].map((line: any) =>
        [...line.classList].find((c: string) => c.startsWith('c3-target-'))
      ),
      // a real line path has multiple points (L segments), not a degenerate M-only path
      path_shapes: [...chart.querySelectorAll('.c3-chart-line path.c3-line')].map(
        (path: any) => path.getAttribute('d')?.match(/L/g)?.length ?? 0
      ),
      tick_labels: [...chart.querySelectorAll('.c3-axis-y .tick text')].map((tick: any) => tick.textContent),
    }))
  )
  for (const chart of charts) {
    expect(chart.width).toBeGreaterThan(100)
    expect(chart.height).toBeGreaterThan(50)
    expect(chart.series).toEqual(['c3-target-y1', 'c3-target-y2'])
    for (const segments of chart.path_shapes) expect(segments).toBeGreaterThanOrEqual(2)
  }
  expect(charts[1].tick_labels).toContain('10') // the second chart pins tick values [0, 5, 10]
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
