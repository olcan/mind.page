import { expect, test } from '@playwright/test'
import { loadAnonymous } from './helpers.js'

// the top edge on an iPhone (the owner's phone, iOS 27.2.1, the app run from the Home Screen,
// 2026-11-17): the system blurred the top of the page, the tops of the header's buttons and
// picture with it. What is known is the owner's trials with an item's switches: in the last
// one a strip under the header, a strip with the header's controls raised over it and a sticky
// header each took the blur away, and no other form did; in the one before it a 12 px strip
// painted over the header was reported to work too, while covering the tops of the buttons and
// the picture. WHY (WebKit's rule for the edge was read from its source, never run) is not
// verified, and neither is the app's own form of the first, which had not been on the phone
// when this row was written: `.top-edge` in index.svelte, a 12 px strip in the header's color,
// fixed along the top edge, before `.items` in the document and at the page's own layer, on iOS
// alone. Chromium cannot show the blur. What this row holds is the form that was tried, as far
// as a desktop lane can tell, and that the strip touches nothing: it is there on iOS and nowhere else;
// at the top edge, in the header's color; under the header at the middle of the top edge, 4 px
// down (where WebKit's own test looks), and over the page's plain flow; the header's buttons
// and picture are hit at their tops as before; a tap on the header's top still focuses the
// box; the header's console still opens over the items (a sticky header, the other form that
// worked on the phone, would put it under them); and scrolled into the items the strip is
// still at the top edge, under an item's own box. Every stack below is read with no loading
// layer of the app's in it: the row says nothing of the page under that cover
const IPHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
}

test('on iOS a strip in the header\'s color lies under the header at the top edge, and covers nothing', async ({ page, browser }) => {
  // off iOS there is no such element
  await loadAnonymous(page)
  await expect(page.locator('.header')).toHaveCount(1)
  await expect(page.locator('.top-edge'), 'no strip off iOS').toHaveCount(0)

  // an iPhone as far as the lane plays one. The app's own test for iOS (isIOS in index.svelte)
  // takes EITHER an iPhone's or iPad's `navigator.platform` OR a user agent that names a Mac on
  // a document with touch events (an iPhone's does: `like Mac OS X`); this row gives both
  const context = await browser.newContext(IPHONE)
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'iPhone' }))
  const phone = await context.newPage()
  await loadAnonymous(phone)
  await expect(phone.locator('.top-edge')).toHaveCount(1)
  const rested = () => phone.evaluate(() => Math.abs(document.body.scrollTop - (document.querySelector('.header') as HTMLElement).offsetTop) <= 2)
  await expect.poll(rested, { message: 'at rest the header is at the window\'s top' }).toBe(true)

  // the strip: at the top edge, in the header's color, at the page's own layer, before the items
  const strip = () =>
    phone.evaluate(() => {
      const strip = document.querySelector('.top-edge')!
      const style = getComputedStyle(strip)
      const box = strip.getBoundingClientRect()
      return {
        box: [box.x, box.y, box.width, box.height],
        position: style.position,
        layer: style.zIndex,
        opacity: style.opacity,
        color: style.backgroundColor,
        before: !!(strip.compareDocumentPosition(document.querySelector('.items')!) & Node.DOCUMENT_POSITION_FOLLOWING),
      }
    })
  const there = { box: [0, 0, IPHONE.viewport.width, 12], position: 'fixed', layer: 'auto', opacity: '1', color: 'rgb(23, 23, 23)', before: true }
  expect(await strip()).toEqual(there)
  expect(await phone.evaluate(() => (header => [getComputedStyle(header.querySelector('.header-container')!).backgroundColor, getComputedStyle(header).position, Math.round(header.getBoundingClientRect().top)])(document.querySelector('.header')!)), 'the header: its color is the strip\'s, it is positioned as it was, and it is at the top edge').toEqual(['rgb(23, 23, 23)', 'relative', 0])

  // what lies at a point, the topmost first, all of it. The app's loading layer comes and goes
  // over the whole window: a stack is taken once none is in it, and nothing is dropped from it
  const hit = async (x: number, y: number) => {
    let stack: string[] = []
    const read = () => phone.evaluate(([x, y]) => document.elementsFromPoint(x, y).map(e => [e.tagName.toLowerCase(), ...Array.from(e.classList).filter(name => !name.startsWith('svelte-'))].join('.')), [x, y])
    await expect.poll(async () => (stack = await read()).some(name => name.split('.').includes('loading')), { message: `no loading layer at ${x}, ${y}` }).toBe(false)
    return stack
  }
  const middle = async (selector: string) => (at => at.x + at.width / 2)((await phone.locator(selector).first().boundingBox())!)
  const stack = await hit(IPHONE.viewport.width / 2, 4)
  const layer = (name: string) => stack.findIndex(entry => entry.startsWith(name))
  expect([layer('div.header-container'), layer('div.top-edge') > layer('div.header-container'), layer('div.items') > layer('div.top-edge')], `under the header, over the page's flow (${stack.join(' < ')})`).toEqual([0, true, true])
  // it covers nothing: the header's buttons and picture are hit at their tops, the strip under them
  const [create, picture] = [await middle('.header .buttons .create'), await middle('.header img.user')]
  const [on_button, on_picture] = [await hit(create, 6), await hit(picture, 9)]
  expect([on_button[0], on_button.includes('div.top-edge'), on_picture[0].split('.').slice(0, 2).join('.'), on_picture.includes('div.top-edge')]).toEqual(['div.button.create', true, 'img.user', true])
  // a tap on the header's top, over the strip, is the header's as before: the box takes the focus
  await phone.touchscreen.tap(IPHONE.viewport.width / 2, 4)
  await expect(phone.locator('#textarea-mindbox')).toBeFocused()
  await phone.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())

  // the header's console opens over the items, as before
  await phone.evaluate(() => Array.from({ length: 10 }, (_, line) => console.warn('top edge row, line ' + line)))
  await phone.locator('.header .console-summary').click()
  await expect(phone.locator('.header .console')).toBeVisible()
  const over = await phone.evaluate(() => {
    // a point of the console, in the window, that an item's box holds too: the first such, going down
    const box = document.querySelector('.header .console')!.getBoundingClientRect()
    const items = Array.from(document.querySelectorAll('.super-container'), item => item.getBoundingClientRect())
    const x = box.x + 30
    for (let y = box.top + 20; y < Math.min(box.bottom, window.innerHeight) - 8; y += 8)
      if (items.some(at => at.top < y && at.bottom > y && at.left < x && at.right > x)) return [true, !!document.elementFromPoint(x, y)?.closest('.console')]
    return [false, false]
  })
  expect(over, 'a point of the console that lies over an item: the console is what is hit').toEqual([true, true])
  await phone.locator('.header .console').click()
  await expect(phone.locator('.header .console')).toBeHidden()

  // scrolled into the items: the strip is still at the window's top edge, and an item lies over
  // it. The first item in the window's width that is tall enough is brought 24 px above the
  // window's top, and what is hit 4 px down at its middle must be of that item's own box (an
  // empty stretch of its column is none), with the strip in the stack under it
  const column = await phone.evaluate(() => {
    const item = Array.from(document.querySelectorAll('.super-container'), item => item.getBoundingClientRect()).find(box => box.height > 60 && box.width > 100 && box.left >= 0 && box.right <= window.innerWidth)!
    document.body.scrollBy(0, item.top + 24)
    return item.left + item.width / 2
  })
  await expect.poll(async () => !(await rested()), { message: 'scrolled off the header' }).toBe(true)
  expect(await strip()).toEqual(there)
  const under = await hit(column, 4)
  const owned = await phone.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.super-container'), [column, 4])
  expect([owned, under.slice(1).includes('div.top-edge')], `an item's own box at ${column}, 4, the strip under it (${under.join(' < ')})`).toEqual([true, true])
  await context.close()
})
