import { expect, test, type Page } from '@playwright/test'
import { interceptMindItems, loadAdmin, loadAnonymous, useGithubToken } from './helpers.js'

// write-path tests: signed in as the admin uid with ?user=anonymous, the app acts on the seeded
// anonymous account with write access (as on mindbox.io); these run after the baseline project
// (see playwright.config.ts) since they add items to the account
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

// mind.items to install via /_install <path> (dependencies are resolved recursively): the items
// defining _test_* functions (see `grep -l _test_` in mind.items) plus #tester, which runs them
const INSTALL = ['tester', 'util/core', 'util/math', 'util/stat', 'util/sample', 'util/sim', 'util/plot', 'logger']

type TestResult = { ok: boolean; ms?: number; log?: string }

// installs a mind.items item via /_install and resolves to the alert message if the command failed,
// otherwise null; a (root) install confirms with "Installed #x [OK]", then recommends reloading if
// new items contain init or welcome code ([Reload] [Skip]), and resolves once these are dismissed
async function install(page: Page, path: string): Promise<string | null> {
  let out: string | null | undefined
  const result = page
    .evaluate(
      text =>
        Promise.resolve(window._create(text, { command: true, return_alerts: true })).then(out =>
          typeof out == 'string' ? out : null
        ),
      `/_install ${path}`
    )
    .then(r => (out = r))
  const settledOr = (button: string) => async () =>
    out !== undefined || (await page.getByText(button, { exact: true }).isVisible())
  await expect.poll(settledOr('OK'), { message: `/_install ${path}`, timeout: 120_000 }).toBe(true)
  if (out === undefined) {
    await page.getByText('OK', { exact: true }).click()
    await expect.poll(settledOr('Skip'), { message: `/_install ${path} after OK`, timeout: 30_000 }).toBe(true)
    if (out === undefined) await page.getByText('Skip', { exact: true }).click() // reload happens in later tests anyway
    await result
  }
  return out ?? null
}

test('admin signs in and acts on the anonymous account with write access', async ({ page }) => {
  await loadAdmin(page)
  expect(await page.evaluate(() => window._user.uid)).toBe('anonymous')
  // admin sees all 121 seeded items, including the welcome template dropped from read-only views
  expect(await page.evaluate(() => window._items().length)).toBe(121)
})

test('installs mind.items with tests', async ({ page }) => {
  const local = await interceptMindItems(page)
  test.info().annotations.push({
    type: 'mind.items source',
    description: local ? 'local checkout' : 'github',
  })
  await useGithubToken(page)
  await loadAdmin(page)
  const exists = (name: string) => page.evaluate(name => window._exists(name), name)
  for (const path of INSTALL) {
    if (await exists(`#${path}`)) continue // already installed as a dependency of an earlier item
    expect(await install(page, path), `/_install ${path}`).toBeNull()
  }
  // items exist client-side before their firestore saves complete, and the app guards navigation
  // with a beforeunload prompt that headless tests bypass, so wait for every item to be saved
  // before other tests load the account
  await expect
    .poll(() => page.evaluate(() => window.__items.filter(item => !item.savedId).length), { timeout: 120_000 })
    .toBe(0)
})

test('/test passes for all installed items', async ({ page }) => {
  await loadAdmin(page)
  // every installed root must have survived the reload (see the save wait in the install test);
  // a lost item would otherwise only show as a smaller test count
  for (const path of INSTALL) expect(await page.evaluate(name => window._exists(name), `#${path}`), path).toBe(true)
  // /test confirms completion with a modal, so it is not awaited; results land in each item's global_store
  await page.evaluate(() => void window._create('/test', { command: true, return_alerts: true }))
  const done = page.getByText(/Completed \d+ tests? in \d+ items?\./)
  await expect(done).toBeVisible({ timeout: 240_000 })
  const summary = (await done.textContent())?.trim()
  await page.getByText('OK', { exact: true }).click()
  const results = await page.evaluate(() =>
    window
      ._items()
      .filter(item => item.global_store?._tests)
      .map(item => ({
        name: item.name,
        tests: item.global_store!._tests as Record<string, TestResult>,
      }))
  )
  const failures = results.flatMap(({ name, tests }) =>
    Object.entries(tests)
      .filter(([, result]) => !result.ok)
      .map(([test, result]) => `${name} ${test}: ${result.log ?? ''}`)
  )
  // per-item counts, e.g. to compare with /test on another account
  console.log(`${summary} ${results.map(({ name, tests }) => `${name} (${Object.keys(tests).length})`).join(', ')}`)
  expect(results.length, summary).toBeGreaterThan(0)
  expect(failures, `${summary}\n${failures.join('\n')}`).toEqual([])
})

test('an item created by admin syncs to a read-only visitor, and so does its deletion', async ({ page, browser }) => {
  await loadAdmin(page)
  const context = await browser.newContext() // a signed-out visitor of the same account
  try {
    const visitor = await context.newPage()
    await loadAnonymous(visitor)
    const exists = () => visitor.evaluate(() => window._items().some(item => item.name == '#e2e_sync'))
    expect(await exists()).toBe(false)
    await page.evaluate(() => void window._create('#e2e_sync created by admin during e2e tests'))
    await expect.poll(exists, { timeout: 30_000 }).toBe(true) // remote add
    // delete(false) skips the window.confirm prompt, which is auto-dismissed in headless browsers
    await page.evaluate(() => window._item('#e2e_sync')!.delete(false))
    await expect.poll(exists, { timeout: 30_000 }).toBe(false) // remote delete
  } finally {
    await context.close()
  }
})
