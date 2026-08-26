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
      for (let i = 0; i < 50; i++) {
        await sleep(200)
        const current = content.innerHTML
        // graphviz (dot) renders after a lazy wasm fetch, so a dot container without its svg is
        // still pending even if the html has not changed between polls
        const pending = /class="dot"/.test(current) && !/<svg/.test(current)
        if (current == html && !pending) break // settled
        html = current
      }
      return html
    },
    [id, timeout] as const
  )
}

export function normalize(html: string): string {
  // chart geometry (widths, positions, path data) scales to wherever the chart happened to
  // generate — the visible column, the hidden column or the element cache — and charts are
  // resized to their final container on adoption, so geometry inside c3 svgs is masked while
  // structure, data labels and non-geometric styles (colors, opacity, visibility) stay compared;
  // semantic geometry (positive bounds, nondegenerate paths) is asserted live in render.spec.ts
  html = html.replace(/<div[^>]*class="c3[^"]*"[^]*?<\/svg>/g, block =>
    block
      .replace(/ (width|height|x|y|x1|x2|y1|y2|r|cx|cy|dx|dy)="[^"]*"/g, ' $1="N"')
      .replace(/ d="[^"]*"/g, ' d="PATH"')
      .replace(/translate\([^)]*\)/g, 'translate(N)')
      .replace(/ style="([^"]*)"/g, (m, s: string) => {
        // drop only the geometric declarations (pixel sizes/offsets, transforms)
        const decls = s
          .split(';')
          .map(decl => decl.trim())
          .filter(decl => decl && !/px|translate\(/.test(decl))
        return decls.length ? ` style="${decls.join('; ')};"` : ''
      })
  )
  return html
    .replace(/ id="(?:mjx-|time-|[^"]*\d{8,})[^"]*"/g, '') // mathjax / $cid / timestamp ids
    .replace(/MJX-\d+-/g, 'MJX-') // glyph def/ref ids count typeset containers (render order)
    .replace(/ _(?:cached|rendered)="\d+"/g, '') // element cache timestamps (see Item.svelte)
    .replace(/ _cache_key="[^"]*"/g, '') // includes a per-render counter (see Item.svelte)
    .replace(/ _failed="\d+"/g, ' _failed') // failed image marker carries a timestamp
    .replace(/ ctxtmenu_counter="\d+"/g, '') // mathjax context menu counter (render order)
    .replace(/ ?position: relative;?/g, '') // set by c3 (chart containers) and mathjax at variable times
    // inline style declaration order varies with render timing (e.g. the img macro applies
    // width/height and custom style in either order), so declarations are compared sorted
    .replace(/ style="([^"]*)"/g, (m, s) => {
      const decls = s.split(';').map((decl: string) => decl.trim()).filter(Boolean).sort()
      return decls.length ? ` style="${decls.join('; ')};"` : ''
    })
    .replace(/ style=""/g, '') // empty style attributes come and go
    .replace(/c3-\d{10,}/g, 'c3-TIMESTAMP') // c3 chart clip-path ids
    // page origin, e.g. in c3 clip-path urls and relative image srcs. ANY local origin: a foreign
    // shared page now renders on shared.localhost (see SHARED_LOCAL_HOST), so goldens captured on
    // localhost would otherwise differ by hostname alone
    .replace(/https?:\/\/(?:[\w-]+\.)*localhost(?::\d+)?\//g, '/')
    .replace(/ aria-(?:owns|labelledby)="[^"]*"/g, '') // mathjax aria refs to dropped ids
    .replace(/>\s*</g, '>\n<') // one tag per line
    .trim()
}
