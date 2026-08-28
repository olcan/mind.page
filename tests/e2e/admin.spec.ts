import { expect, test } from '@playwright/test'
import { install, loadAdmin, loadAnonymous } from './helpers.js'

// write-path tests: signed in as the admin uid with ?user=anonymous, the app acts on the seeded
// anonymous account with write access (as on mindbox.io); these run after the baseline project
// (see playwright.config.ts) since they add items to the account
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

// mind.items to install via /_install <path> (dependencies are resolved recursively): the items
// defining _test_* functions (see `grep -l _test_` in mind.items) plus #tester, which runs them
// note the agent framework (#agent, welcome hook + check_agents task) is NOT listed: it must
// arrive as a dependency of the providers (via agent/chat's #_///agent), since providers cannot
// function without it -- the framework is what runs them on chat item changes. the /native test
// asserts this, keeping the dependency edge continuously verified for fresh-account installs
const INSTALL = ['tester', 'util/core', 'util/math', 'util/stat', 'util/sample', 'util/sim', 'util/plot', 'logger', 'agent/chat/claude', 'agent/chat/gpt', 'agent/chat/gemini', 'agent/chat/together', 'agent/chat/groq', 'agent/chat/ollama', 'agent/chat/openrouter']

type TestResult = { ok: boolean; ms?: number; log?: string }

test('admin signs in and acts on the anonymous account with write access', async ({ page }) => {
  await loadAdmin(page)
  expect(await page.evaluate(() => window._user.uid)).toBe('anonymous')
  // admin sees all 121 seeded items, including the welcome template dropped from read-only views.
  // counted as items WITHOUT attr.source (which /_install sets and no seeded item has), so the
  // exact assertion holds in either admin file order -- admin_live.spec.ts may legitimately
  // self-install providers before this file when live validation is enabled
  expect(await page.evaluate(() => window._items().filter(item => !item.attr?.source).length)).toBe(121)
})

test('installs mind.items with tests', async ({ page }) => {
  await loadAdmin(page) // fails fast without the local checkout -- the only supported source
  test.info().annotations.push({ type: 'mind.items source', description: 'local checkout' })
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
  // collect rendering/eval errors of installed items from the first render on: "macro error in
  // item X" (macro eval failures) and "[#x] Error:" (item errors, e.g. agent framework fatals)
  const macroErrors = new Set<string>()
  page.on('console', m => {
    const match = m.text().match(/^macro error in item ([^:]+):/) ?? m.text().match(/^\[(#[^\]]+)\] Error:/)
    if (match) macroErrors.add(match[1])
  })
  await loadAdmin(page) // interception on every load is loadAdmin's invariant (see helpers.ts)
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
  // no installed item may macro-error during rendering: console errors are otherwise unasserted
  // noise, which is how a doc item once shipped with unescaped delimiter macros (evaluated even
  // inside inline code spans) without failing any test. requires complete install closures --
  // /_install walks text tags only (label-prefix autodeps are runtime-only), so items invoking
  // parent-defined macros must declare the parent explicitly (e.g. #_///template)
  const errors = [...macroErrors].sort()
  expect(errors, `macro errors: ${errors.join(', ')}`).toEqual([])
})

test('/native creates a tagged request item without breaking the agent framework', async ({ page }) => {
  // the native "provider" (#agent/native) is an agent item like every #agent/* item: the framework
  // starts it as an agent on change events (e.g. a request item created as its dependent), and
  // start_agent fatals unless the item carries a (deliberately inert) js_input block -- a doc-only
  // item shipped exactly that bug, caught only in a live account. this covers the /native command,
  // the explicit #_agent/native tag on request items (the vault bridge parses item text only), and
  // the agent-framework contract
  const errors: string[] = []
  page.on('console', m => {
    const match = m.text().match(/^\[(#[^\]]+)\] Error: (.*)$/s)
    if (match) errors.push(`${match[1]}: ${match[2].slice(0, 160)}`)
  })
  await loadAdmin(page)
  // the framework must have arrived via dependency resolution (providers -> agent/chat -> agent):
  // it is deliberately not in INSTALL, so this continuously verifies the install-time dependency
  // edge that fresh accounts rely on (without it, installed providers never reply at all)
  expect(await page.evaluate(() => window._exists('#agent')), '#agent installed as dependency').toBe(true)
  await page.evaluate(() => void window._create('/native hello bridge', { command: true }))
  const text = () => page.evaluate(() => window._item('#chat/native/0', true)?.text ?? '')
  await expect.poll(text, { message: 'request item #chat/native/0' }).toContain('<<user>> hello bridge')
  expect(await text()).toContain('#_agent/native') // explicit tag for the text-parsing vault bridge
  // let the agent framework react to the change (start_agent on #agent/native must not fatal)
  await page.waitForTimeout(2_000)
  expect(errors, errors.join('\n')).toEqual([])
})

test('an item created by admin syncs to a read-only visitor, and so does its deletion', async ({ page, browser }) => {
  await loadAdmin(page) // interception + fake token are loadAdmin's invariant (see helpers.ts)
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
