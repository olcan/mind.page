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
  // iOS, Chrome's overlay-scrollbars flag) takes no space and is recolored by the standard
  // scrollbar-color instead (the owner on gen14 with the flag, 2026-10-28: the overlay bar was the
  // gray-on-white one, shown on hover), a property that must stay off under the mark, since Chrome
  // ignores the pseudo-elements on an element that sets it. a styled scrollbar takes its space
  // whatever the browser paints natively, so the gutter and the color of a probe inside a seeded
  // item's content are measured with the mark and without it
  await loadAnonymous(page)
  const facts = await page.evaluate(async () => {
    const item = window._item('#typescript/example')!
    const elem = item.elem ?? (await window._render_item(item))
    const probe = document.createElement('div')
    probe.style.cssText = 'width:100px;height:100px;overflow:scroll'
    elem!.querySelector('.content')!.appendChild(probe)
    const html = document.documentElement
    const marked = html.classList.contains('classic-scrollbars')
    const under = (mark: boolean) => {
      html.classList.toggle('classic-scrollbars', mark)
      return {
        gutter: probe.offsetWidth - probe.clientWidth,
        color: getComputedStyle(probe).getPropertyValue('scrollbar-color'),
      }
    }
    const facts = {
      marked,
      unmarked: under(false),
      styled: under(true),
      viewport: window.innerWidth - html.clientWidth,
    }
    html.classList.toggle('classic-scrollbars', marked)
    probe.remove()
    return facts
  })
  expect(facts.marked).toBe(facts.unmarked.gutter > 0) // the probe in app.html marks a browser whose scrollbars take space
  expect(facts.styled.gutter).toBe(11) // the app's own scrollbar under the mark
  expect(facts.styled.color).toBe('auto') // the standard property stays off under the mark, or Chrome would paint its native bar
  expect(facts.unmarked.color).toBe('rgb(85, 85, 85) rgba(0, 0, 0, 0)') // an overlay scrollbar, unmarked, is recolored instead
  expect(facts.viewport).toBe(0) // the page's own scrollbar stays hidden
})
