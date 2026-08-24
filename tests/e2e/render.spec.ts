import { expect, test } from '@playwright/test'
import { loadAnonymous } from './helpers'
import { normalize, renderedHtml } from './rendering'

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

test('every anonymous item renders as before', async ({ page }) => {
  await loadAnonymous(page)
  const ids: string[] = await page.evaluate(() => window._items().map(item => item.id))
  for (const id of ids) {
    const html = await renderedHtml(page, id)
    expect.soft(html, `item ${id} rendered`).not.toBeNull()
    if (html != null && !(id in DYNAMIC_ITEMS)) expect.soft(normalize(html), `item ${id}`).toMatchSnapshot(`${id}.html`)
  }
})
