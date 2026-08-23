import { expect, test, type Page } from '@playwright/test'

// rendering goldens: the anonymous account (seeded from fixtures, see seed.mjs) is loaded as a
// signed-out visitor and every item is rendered via the app's own _render_item; the rendered html is
// normalized (volatile ids) and lightly formatted (one tag per line) for readable diffs, then
// compared to __snapshots__/render.spec.ts/<id>.html (create/update with --update-snapshots)

// app globals used via page.evaluate (see window._* in index.svelte)
declare global {
  interface Window {
    _items: () => { id: string; name: string }[]
    _item: (name: string) => { elem: HTMLElement | null }
    _render_item: (item: unknown) => Promise<HTMLElement>
    _init_time: number
    __rendered: boolean // initial (chunked) rendering complete, required by _render_item
  }
}

// items whose rendering is inherently dynamic and therefore only checked to render, not snapshotted
const DYNAMIC_ITEMS: Record<string, string> = {
  pqqYx32Zn5ejGW7PlbZE: 'live clock widget',
}

// rendered html of an item's content: read from the dom if already rendered, otherwise render via
// _render_item; then wait for the html to settle, since e.g. charts draw after the render resolves;
// null if rendering did not complete in time (e.g. pending images or math)
export async function renderedHtml(page: Page, id: string, timeout = 15_000): Promise<string | null> {
  return page.evaluate(
    async ([id, timeout]) => {
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
      const item = window._item(id)
      const expired = new Promise<null>(resolve => setTimeout(() => resolve(null), timeout))
      const elem = item.elem ?? (await Promise.race([window._render_item(item), expired]))
      if (!elem) return null
      const content = elem.querySelector('.content') ?? elem
      let html = content.innerHTML
      for (let i = 0; i < 10; i++) {
        await sleep(100)
        if (content.innerHTML == html) break // settled
        html = content.innerHTML
      }
      return html
    },
    [id, timeout] as const
  )
}

export function normalize(html: string): string {
  return html
    .replace(/ id="(?:mjx-|time-|[^"]*\d{8,})[^"]*"/g, '') // mathjax / $cid / timestamp ids
    .replace(/ _(?:cached|rendered)="\d+"/g, '') // element cache timestamps (see Item.svelte)
    .replace(/ ctxtmenu_counter="\d+"/g, '') // mathjax context menu counter (render order)
    .replace(/ style=""/g, '') // empty style attributes come and go
    .replace(/c3-\d{10,}/g, 'c3-TIMESTAMP') // c3 chart clip-path ids
    .replace(/https?:\/\/localhost(?::\d+)?\//g, '/') // page origin, e.g. in c3 clip-path urls
    .replace(/ aria-(?:owns|labelledby)="[^"]*"/g, '') // mathjax aria refs to dropped ids
    .replace(/>\s*</g, '>\n<') // one tag per line
    .trim()
}

async function loadAnonymous(page: Page) {
  await page.goto('/')
  // read-only visitors are asked to sign in or stay anonymous on every visit (see index.svelte)
  await page.getByText('Stay Anonymous', { exact: true }).click({ timeout: 60_000 })
  // the global loading overlay (a top-level child of the app root, unlike per-item .loading divs) is
  // visible until initialized and rendered (see class:visible in index.svelte)
  await expect(page.locator('#sapper > .loading')).not.toHaveClass(/visible/, { timeout: 90_000 })
  await expect.poll(() => page.evaluate(() => window._init_time > 0)).toBe(true)
  // initial rendering continues in chunks after the overlay is hidden; _render_item requires it done
  await expect.poll(() => page.evaluate(() => window.__rendered), { timeout: 90_000 }).toBe(true)
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
    if (html != null && !(id in DYNAMIC_ITEMS))
      expect.soft(normalize(html), `item ${id}`).toMatchSnapshot(`${id}.html`)
  }
})
