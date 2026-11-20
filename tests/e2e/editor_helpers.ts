import { expect, type Page } from '@playwright/test'

// helpers shared by the editor lanes (editor.spec.ts and editor2.spec.ts, see playwright.config.ts)
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
