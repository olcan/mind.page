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
