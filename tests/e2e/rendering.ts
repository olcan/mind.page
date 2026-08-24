import { type Page } from '@playwright/test'

// rendered html of an item's content: read from the dom if already rendered, otherwise render via
// _render_item; then wait for the html to settle, since e.g. charts draw after the render resolves;
// null if rendering did not complete in time (e.g. pending images or math)
export async function renderedHtml(page: Page, id: string, timeout = 15_000): Promise<string | null> {
  return page.evaluate(
    async ([id, timeout]) => {
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
      const item = window._item(id)
      if (!item) return null
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
    .replace(/ _cache_key="[^"]*"/g, '') // includes a per-render counter (see Item.svelte)
    .replace(/ _failed="\d+"/g, ' _failed') // failed image marker carries a timestamp
    .replace(/ ctxtmenu_counter="\d+"/g, '') // mathjax context menu counter (render order)
    .replace(/ ?position: relative;?/g, '') // set by c3 (chart containers) and mathjax at variable times
    .replace(/ style=""/g, '') // empty style attributes come and go
    .replace(/c3-\d{10,}/g, 'c3-TIMESTAMP') // c3 chart clip-path ids
    .replace(/https?:\/\/localhost(?::\d+)?\//g, '/') // page origin, e.g. in c3 clip-path urls
    .replace(/ aria-(?:owns|labelledby)="[^"]*"/g, '') // mathjax aria refs to dropped ids
    .replace(/>\s*</g, '>\n<') // one tag per line
    .trim()
}
