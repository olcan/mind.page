import { expect, type Page } from '@playwright/test'
import { firestore, loadAdmin } from './helpers.js'

// helpers shared by the editor lanes (editor.spec.ts, editor2.spec.ts, editor3.spec.ts and editor4.spec.ts, see
// playwright.config.ts)
export const mindbox = (page: Page) => page.locator('#textarea-mindbox')
// the textarea is hidden behind a backdrop until focused; users click the backdrop (see Editor.svelte)
export async function focusMindbox(page: Page) {
  await page.locator('.header .backdrop').first().click()
  await expect(mindbox(page)).toBeFocused()
}
export const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)
export const itemText = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.text ?? null, name)
// names of the items currently shown, in order (the rest are hidden past hideIndex)
export const visible = (page: Page) =>
  page.evaluate(() => window.__items.slice(0, window.__hideIndex).map(item => item.labelText ?? ''))

// A USER'S STEP FROM A ROW (the rule of 2026-11-19: a history entry is added only within the user's input). `act`
// runs in the page inside the dispatch of a real key press (F9: noted by the app at the window, then swallowed
// here before any other handler of the page's sees it), as item code does that a widget's click runs; its result
// comes back. The callback is SYNCHRONOUS work, which can rely on the F9 dispatch: what it does after an `await`
// of its own, or from a timer, is outside the input, and work that needs the origin then carries it explicitly
// (`window._carry_input(f)`, taken inside the callback and called when its time comes, as item code does).
// A value it throws is the row's error, and a promise it returns is awaited for its outcome (as page.evaluate
// awaits one), not for its origin. A bare `page.evaluate` is no input: a query it sets is written over the entry
// the browser is on
export async function asUser<T, R>(page: Page, act: (arg: T) => R, arg?: T): Promise<Awaited<R>> {
  await page.evaluate(
    ([body, arg]) => {
      const w = window as any
      const swallow = (e: Event) => (e.stopImmediatePropagation(), e.preventDefault())
      window.addEventListener(
        'keydown',
        e => {
          swallow(e)
          // (an error of the callback is kept for the row: thrown here it was the page's alone, and the read
          // below then gave `undefined`, which is a valid result of a setup step)
          try {
            w.__as_user = { value: new Function(`return (${body})`)()(arg) }
          } catch (error) {
            w.__as_user = { error: String((error as Error)?.stack ?? error) }
          }
        },
        { capture: true, once: true },
      )
      window.addEventListener('keyup', swallow, { capture: true, once: true })
    },
    [act.toString(), arg] as const,
  )
  await page.keyboard.press('F9')
  const result = await page.evaluate(async () => {
    const w = window as any
    const result = w.__as_user as { value?: unknown; error?: string } | undefined
    delete w.__as_user
    if (result && result.error === undefined) result.value = await result.value
    return result
  })
  if (!result) throw new Error('asUser: the key press did not reach the page')
  if (result.error !== undefined) throw new Error(`asUser: the callback threw in the page: ${result.error}`)
  return result.value as Awaited<R>
}
// a query set as a widget's click sets one (the #mindbox item's controller, from a blurred box: applied at once)
export const userSet = (page: Page, text: string, options?: object) =>
  asUser(page, ([text, options]) => void (window as any).MindBox.set(text, options), [text, options] as const)

// the source item of the navigation row (editor.spec.ts, whose /_undelete row deletes and restores it); the
// later editor lanes create it for their own rows (createNavigationItems below)
export const SOURCE_TEXT =
  '#e2e_source refers to #e2e_target, [**e2e_target**/sub](#e2e_target/sub), [e2e_target/***sub***](#e2e_target/sub), ' +
  '[e2e_target&#39;s/sub](#e2e_target/sub) and [`&amp;`/sub](#e2e_target/sub)'
// the navigation row's three items, created as that row of editor.spec.ts creates them (`clicking a tag
// navigates to it`): the first row of each later editor lane (editor3.spec.ts, editor4.spec.ts), whose rows
// name them, makes them on its lane's account and waits until the server holds all three, since the editor
// lane's rows reached them dozens of rows after their creation
export async function createNavigationItems(page: Page) {
  await loadAdmin(page)
  const items = [
    ['#e2e_target', '#e2e_target the target'],
    ['#e2e_target/sub', '#e2e_target/sub the sub target'],
    ['#e2e_source', SOURCE_TEXT],
  ]
  await page.evaluate(items => items.forEach(([, text]) => void window._create(text)), items)
  for (const [name, text] of items) {
    await expect.poll(() => savedId(page, name), { message: `${name} saved`, timeout: 30_000 }).toBeTruthy()
    const id = (await savedId(page, name))!
    await expect
      .poll(async () => (await firestore().collection('items').doc(id).get()).data()?.text, { message: `${name} on the server`, timeout: 30_000 })
      .toBe(text)
  }
}

// the scroll-to-top rows (2026-10-03): the page's TOP is the header's offset (an area sits above the
// header, 600 px or so, and the page loads scrolled to the header; scrollTo lands within 2 px of it)
export const scrollTop = (page: Page) => page.evaluate(() => document.body.scrollTop)
export const headerTop = (page: Page) => page.evaluate(() => (document.querySelector('.header') as HTMLElement).offsetTop)
// the page's history entries: the session state history's length and the current index
export const entries = (page: Page) => page.evaluate(() => [(window as any)._history.length, (window as any)._history_index] as const)
// scrolls 600 px below the header and returns the position; the scroll is repeated until it holds for
// 150 ms: one scroll before the poll stayed at the top for 30 s under the full gate, twice (2026-10-28,
// the scroll right after Control+ArrowUp: the position read 612, the header, where more than 912 was
// expected; what returned it there, a layout's scroll or a clamp on a page still short, is not identified:
// lane_races review 0 corrected the first account). the rows that call this test what the keys do from a
// scrolled page, not whether a first scroll survives, so the repeat hides nothing they assert
export const scrollDown = async (page: Page) => {
  const top = await headerTop(page)
  await expect
    .poll(
      async () => {
        await page.evaluate(y => document.body.scrollTo(0, y), top + 600)
        await page.waitForTimeout(150)
        return scrollTop(page)
      },
      { message: 'the body scrolled below the header (the page is long enough)' }
    )
    .toBeGreaterThan(top + 300)
  return scrollTop(page)
}
export const nearTop = async (page: Page, message: string) =>
  expect.poll(async () => Math.abs((await scrollTop(page)) - (await headerTop(page))) <= 2, { message }).toBe(true)
// the shown names as a SET (sorted): the rank of an unrelated item can shift under a row (the
// dependency row's items relog on a timer), and these assertions guard against a collapse, not an order
export const asSet = (names: string[]) => [...names].sort()
// shows more items (the set a visibility reset would collapse) and returns the shown names
export const expand = async (page: Page) => {
  const shown = await visible(page)
  await page.locator('.toggle.show').first().click()
  await expect.poll(() => visible(page).then(v => v.length)).toBeGreaterThan(shown.length)
  return visible(page)
}
export const focusMindboxInPlace = (page: Page, caret?: number) =>
  page.evaluate(caret => {
    const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
    t.focus({ preventScroll: true }) // see the focus wrapper row of editor.spec.ts
    if (caret !== undefined) t.setSelectionRange(caret, caret)
  }, caret)
export const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
// the scroll listener's 250 ms write idle, so the next turn's scroll event arms it (a row that needs
// the write pending across its own steps waits for this first)
export const noWritePending = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window as any)._history_update_pending), { message: 'no scroll write pending' }).toBe(false)
// (a restore scrolls from a later frame, and a modal is shown from a promise's callback: two frames and the
// timers due, no fixed wait)
export const settled = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve)))))

// what the reload rows read off the page: the history handler's warnings, collected from the first call on,
// and the readers below
export const historyReads = (page: Page) => {
  const warnings: string[] = []
  page.on('console', msg => void (msg.type() == 'warning' && msg.text().includes('onPopState') && warnings.push(msg.text())))
  // the current entry holds the position shown, the scroll listener's write done
  const recorded = () =>
    expect
      .poll(() => page.evaluate(() => !(window as any)._history_update_pending && (window as any)._history[(window as any)._history_index].scrollPosition === document.body.scrollTop), {
        message: 'the position shown is recorded',
        timeout: 10_000,
      })
      .toBe(true)
  // a position of the entry's own: set until it holds (a navigation's own scroll can land after the first), then recorded
  const place = async (below: number) => {
    const y = (await headerTop(page)) + below
    await expect
      .poll(
        async () => {
          await page.evaluate(y => document.body.scrollTo(0, y), y)
          await page.waitForTimeout(150)
          return scrollTop(page)
        },
        { message: `the page holds ${below} px below the header` }
      )
      .toBe(y)
    await recorded()
    return y
  }
  // what the page shows (the MindBox's text, the position within 2 px) with what the handler logged, so that a failure names all three
  const shows = (text: string, y: number, message: string) =>
    expect
      .poll(
        async () => {
          const [box, now] = await page.evaluate(() => [(document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value, document.body.scrollTop] as const)
          return { box, at: Math.abs(now - y) <= 2 ? y : now, warnings }
        },
        { message, timeout: 10_000 }
      )
      .toEqual({ box: text, at: y, warnings: [] })
  return { warnings, recorded, place, shows }
}
