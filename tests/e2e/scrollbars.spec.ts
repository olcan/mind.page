import { expect, test } from '@playwright/test'
import { loadAnonymous } from './helpers.js'

// playwright's headless chromium hides every scrollbar (--hide-scrollbars), so this file's browser
// drops the switch: the probe in app.html then measures what the browser paints, as a user's does
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

test("a browser painting classic scrollbars gets slim ones of the app's own on inner scrollers", async ({ page }) => {
  // classic scrollbars (Linux, Windows) inside the dark app were the browser's gray-on-white bars
  // with arrow buttons, which Chrome keeps even at scrollbar-width: thin (the owner on gen14,
  // 2026-10-13): app.html marks a browser whose scrollbars take space with html.classic-scrollbars
  // and index.svelte styles every inner scroller's ::-webkit-scrollbar under the mark (11 px, no
  // buttons, a #555 thumb), while html and body keep hiding their own; an overlay scrollbar (macOS,
  // iOS) takes no space and stays native. a styled scrollbar takes its space whatever the browser
  // paints natively, so the gutter of a probe inside a seeded item's content is measured with the
  // mark and without it
  await loadAnonymous(page)
  const facts = await page.evaluate(async () => {
    const item = window._item('#typescript/example')!
    const elem = item.elem ?? (await window._render_item(item))
    const probe = document.createElement('div')
    probe.style.cssText = 'width:100px;height:100px;overflow:scroll'
    elem!.querySelector('.content')!.appendChild(probe)
    const html = document.documentElement
    const marked = html.classList.contains('classic-scrollbars')
    const gutter = (mark: boolean) => {
      html.classList.toggle('classic-scrollbars', mark)
      return probe.offsetWidth - probe.clientWidth
    }
    const facts = {
      marked,
      native: gutter(false),
      styled: gutter(true),
      viewport: window.innerWidth - html.clientWidth,
    }
    html.classList.toggle('classic-scrollbars', marked)
    probe.remove()
    return facts
  })
  expect(facts.marked).toBe(facts.native > 0) // the probe in app.html marks a browser whose scrollbars take space
  expect(facts.styled).toBe(11) // the app's own scrollbar under the mark
  expect(facts.viewport).toBe(0) // the page's own scrollbar stays hidden
})
