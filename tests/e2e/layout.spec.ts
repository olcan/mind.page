import { expect, test, type Page } from '@playwright/test'
import { loadAnonymous } from './helpers.js'

// column layout (see updateItemLayout in index.svelte): columnCount is max(1, floor(width / 500)),
// items keep their order across reflows, and the hidden render column tracks the first column's
// width; this pins the layout math ahead of its extraction from index.svelte

const columns = (page: Page) => page.evaluate(() => document.querySelectorAll('.column:not(.hidden)').length)
// names of the visible items in index order (the layout must never reorder them)
const visible = (page: Page) =>
  page.evaluate(() => window.__items.slice(0, window.__hideIndex).map(item => item.labelText ?? ''))
const hiddenColumnWidth = (page: Page) =>
  page.evaluate(() => ({
    hidden: (document.querySelector('.column.hidden') as HTMLElement).offsetWidth,
    first: (document.querySelector('.column:not(.hidden)') as HTMLElement).offsetWidth,
  }))

test('column count follows viewport width and items keep their order', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 }) // floor(900 / 500) = 1 column
  await loadAnonymous(page)
  expect(await columns(page)).toBe(1)
  const order = await visible(page)
  expect(order.length).toBeGreaterThan(2)

  await page.setViewportSize({ width: 1200, height: 900 }) // floor(1200 / 500) = 2 columns
  await expect.poll(() => columns(page), { timeout: 15_000 }).toBe(2)
  expect(await visible(page)).toEqual(order) // reflow distributes items but keeps index order

  await page.setViewportSize({ width: 1600, height: 900 }) // floor(1600 / 500) = 3 columns
  await expect.poll(() => columns(page), { timeout: 15_000 }).toBe(3)
  expect(await visible(page)).toEqual(order)

  await page.setViewportSize({ width: 900, height: 900 })
  await expect.poll(() => columns(page), { timeout: 15_000 }).toBe(1)
  expect(await visible(page)).toEqual(order)
})

test('the hidden render column tracks the first column width', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await loadAnonymous(page)
  await expect.poll(() => columns(page), { timeout: 15_000 }).toBe(2)
  const { hidden, first } = await hiddenColumnWidth(page)
  expect(hidden).toBe(first)
  await page.setViewportSize({ width: 900, height: 900 })
  await expect.poll(() => columns(page), { timeout: 15_000 }).toBe(1)
  await expect.poll(async () => (await hiddenColumnWidth(page)).hidden, { timeout: 15_000 }).toBe(
    (await hiddenColumnWidth(page)).first
  )
})
