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
// function without it -- the framework is what runs them on chat item changes. the /vault test row
// asserts this, keeping the dependency edge continuously verified for fresh-account installs
const INSTALL = ['tester', 'util/core', 'util/math', 'util/stat', 'util/sample', 'util/sim', 'util/plot', 'logger', 'agent/chat/claude', 'agent/chat/gpt', 'agent/chat/gemini', 'agent/chat/together', 'agent/chat/groq', 'agent/chat/ollama', 'agent/chat/openrouter', 'agent/chat/llama']

type TestResult = { ok: boolean; ms?: number; log?: string }

test('admin signs in and acts on the anonymous account with write access', async ({ page }) => {
  await loadAdmin(page)
  expect(await page.evaluate(() => window._user.uid)).toBe('anonymous')
  // admin sees all 121 seeded items, including the welcome template dropped from read-only views.
  // counted as items WITHOUT attr.source (which /_install sets and no seeded item has), so the
  // exact assertion holds in either admin file order -- admin_live.spec.ts may legitimately
  // self-install providers before this file when live validation is enabled
  expect(await page.evaluate(() => window._items().filter(item => !item.attr?.source).length)).toBe(121)
  // /_gc explicitly refuses the synthetic-anonymous principal (review 130 §2.2): this app's
  // anonymous mode is the component-level `anonymous` flag, not user.isAnonymous -- the command
  // must refuse before any scan even though readonly is false here (asserted, so the anonymous
  // flag is uniquely causal)
  expect(await page.evaluate(() => window._readonly), 'admin mode is not read-only').toBe(false)
  expect(
    await page.evaluate(async () => await (window._create('/_gc', { command: true, return_alerts: true }) as any)),
    '/_gc anonymous refusal'
  ).toContain('signed-in owner')
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
  // catalog-driven transitive installs: the #chat catalog lists the llama-server aliases, so
  // they must arrive without being INSTALL roots (as every alias does)
  for (const name of ['#chat/next', '#chat/dsv4'])
    expect(await page.evaluate(name => window._exists(name), name), `${name} via the #chat catalog`).toBe(true)
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
  // /_install resolves text tags plus label-prefix autodep parents (src/install_deps.ts). the
  // synthetic autodep.test row below exercises that edge; THIS lane still follows the corpus's
  // explicit workaround tags (e.g. #_///template) and flips to the autodep path only when those
  // tags are removed after the fixed app deploys
  const errors = [...macroErrors].sort()
  expect(errors, `macro errors: ${errors.join(', ')}`).toEqual([])
})

test('/vault creates a tagged request item without breaking the agent framework', async ({ page }) => {
  // the vault "provider" (#agent/vault) is an agent item like every #agent/* item: the framework
  // starts it as an agent on change events (e.g. a request item created as its dependent), and
  // start_agent fatals unless the item carries a (deliberately inert) js_input block -- a doc-only
  // item shipped exactly that bug, caught only in a live account. this covers the /vault command,
  // the explicit #_agent/vault tag on request items (the vault bridge parses item text only), and
  // the agent-framework contract (the tombstones at the old names are inspected statically)
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
  await page.evaluate(() => void window._create('/vault hello bridge', { command: true }))
  const text = () => page.evaluate(() => window._item('#chat/vault/0', true)?.text ?? '')
  await expect.poll(text, { message: 'request item #chat/vault/0' }).toContain('<<user>> hello bridge')
  expect(await text()).toContain('#_agent/vault') // explicit tag for the text-parsing vault bridge
  // let the agent framework react to the change (start_agent on #agent/vault must not fatal)
  await page.waitForTimeout(2_000)
  expect(errors, errors.join('\n')).toEqual([])
})

test('an autodep parent absent from every text tag is installed and joins the runtime graph', async ({ page }) => {
  await loadAdmin(page)
  // synthetic four-level hierarchy on a dedicated repo route (review 118 §4): the root depends
  // on #e2e_autodep in TEXT only, e2e_autodep.md's #_autodep makes the hierarchy autodep,
  // e2e_autodep/b.md is a genuine 404 (exercising the known-source probe), and the immediate
  // parent e2e_autodep/b/c.md is reachable ONLY via the label-prefix autodep edge resolved AFTER
  // text dependencies settle -- the corpus itself cannot provide this fixture while its explicit
  // workaround tags close the same edge
  let sha = 'e2e-autodep' // mutable: the updater-cycle stage below advances the synthetic repo
  const files: Record<string, string> = {
    'e2e_autodep.md': '#e2e_autodep #_autodep defines the root of a synthetic autodep hierarchy.\n',
    'e2e_autodep/b/c.md': '#e2e_autodep/b/c is a middle level with no dependencies of its own.\n',
    'e2e_autodep/b/c/d.md': '#e2e_autodep/b/c/d depends on #e2e_autodep explicitly and nothing else.\n',
  }
  // successful installs start watchLocalRepo(repo) without awaiting, which on localhost calls
  // fetchPreview for each installed source item via /file/<repo>/<path> BEFORE the (already
  // intercepted) /watch/... loop -- serve those from the same map, 404 fail-closed, so the
  // fixture stays hermetic (an unintercepted miss throws via the app fetch wrapper and opens an
  // error modal concurrently with the install modals)
  await page.route('**/file/autodep.test/**', route => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/file\/autodep\.test\//, ''))
    if (!(file in files)) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })
    return route.fulfill({ status: 200, contentType: 'text/plain', body: files[file] })
  })
  await page.route('https://api.github.com/repos/olcan/autodep.test/**', route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/repos/olcan/autodep.test/', '')
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path == 'commits') {
      const file = url.searchParams.get('path') ?? ''
      if (!(file in files)) return json(200, [])
      return json(200, [{ sha, commit: { message: 'synthetic', author: { date: new Date().toISOString() } } }])
    }
    if (path.startsWith('commits/')) {
      // single-commit fetch: update_item validates the target sha, and check_updates'
      // pushable marking reads the commit's files listing
      return json(200, {
        sha: path.slice('commits/'.length),
        commit: { message: 'synthetic', author: { date: new Date().toISOString() } },
        files: Object.keys(files).map(filename => ({ filename, sha })),
      })
    }
    if (path.startsWith('contents/')) {
      const file = decodeURIComponent(path.slice('contents/'.length))
      if (!(file in files)) return json(404, { message: 'Not Found' })
      return json(200, {
        type: 'file',
        path: file,
        name: file.split('/').pop(),
        sha,
        content: Buffer.from(files[file]).toString('base64'),
        encoding: 'base64',
      })
    }
    // FAIL CLOSED, matching the mind.items interceptor: nothing may reach real github
    return json(404, { message: `unmodeled autodep.test api path in e2e interception: ${path}` })
  })
  expect(await install(page, 'e2e_autodep/b/c/d autodep.test master olcan'), '/_install e2e_autodep/b/c/d').toBeNull()
  const exists = (name: string) => page.evaluate(name => window._exists(name), name)
  expect(await exists('#e2e_autodep'), '#e2e_autodep via text dependency').toBe(true)
  expect(await exists('#e2e_autodep/b/c'), '#e2e_autodep/b/c via the autodep edge').toBe(true)
  expect(await exists('#e2e_autodep/b/c/d'), 'the installed root').toBe(true)
  expect(await exists('#e2e_autodep/b'), '#e2e_autodep/b stays uninstalled (genuine 404)').toBe(false)
  // the root's runtime dependency list must include its immediate parent
  expect(
    await page.evaluate(() => window._item('#e2e_autodep/b/c/d')!.dependencies.includes(window._item('#e2e_autodep/b/c')!.id)),
    'parent in runtime dependencies'
  ).toBe(true)
  // THE REAL UPDATER CYCLE (review 126 §3): prove the new update_item seam branch end to end.
  // Stage the broken state an update must heal -- delete the text-dep root AND the autodep
  // parent -- then advance the synthetic repo one sha with updated child text. The REAL
  // #updater's update_item (installed only for this row, never in the shared INSTALL; its
  // function evaluated from the item) must then: pass 1 -- reinstall the text dependency via
  // /_install and restart; restart pass -- with text deps local, consult window._autodep_parent
  // and install the missing parent through the same flow; land the new sha. Removing the
  // updater's seam branch fails the parent assertions below with everything else green.
  await page.evaluate(() => {
    for (const name of ['#e2e_autodep', '#e2e_autodep/b/c']) window._item(name)!.delete(false)
  })
  files['e2e_autodep/b/c/d.md'] = '#e2e_autodep/b/c/d depends on #e2e_autodep explicitly and nothing else. v2\n'
  sha = 'e2e-autodep-2'
  expect(await install(page, 'updater'), '/_install updater').toBeNull()
  await page.evaluate(() => {
    // init_updater runs only on welcome (page load), which this mid-session install skips --
    // seed the store fields the update/restart path reads
    const store = (window._item('#updater') as any).store
    store.modified_ids ??= []
    store.pending_updates ??= {}
  })
  // root /_install commands (which the updater's dependency flow issues via MindBox.create)
  // finish with REAL modals -- the "Installed <item>" OK confirmation, the updater's own
  // Continue confirmation for missing dependencies, and (once #updater exists as a welcome
  // item) a Reload/Skip recommendation. Production is interactive; the row clicks through
  // exactly as the install() helper does, never clicking Reload
  let clicking = true
  const clicks = (async () => {
    while (clicking)
      for (const label of ['Continue', 'OK', 'Skip'])
        await page.getByText(label, { exact: true }).click({ timeout: 200 }).catch(() => {})
  })()
  let updated: unknown
  try {
    updated = await page.evaluate(async () => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('update_item timed out in 90s')), 90_000)
      )
      const run = (async () => {
        const update_item = await (window._item('#updater') as any).eval('update_item', {
          async: true,
          async_simple: true,
        })
        return update_item(window._item('#e2e_autodep/b/c/d'), { 'e2e_autodep/b/c/d.md': 'e2e-autodep-2' })
      })()
      return Promise.race([run, timeout])
    })
  } finally {
    clicking = false
    await clicks
  }
  expect(updated, 'update_item completed').toBe(true)
  // the healed closure: the text dependency reinstalled by pass 1, the autodep parent by the
  // updater's seam branch on the restart pass, and the updated text landed
  expect(await exists('#e2e_autodep'), 'text dependency reinstalled by the update').toBe(true)
  expect(await exists('#e2e_autodep/b/c'), 'autodep parent reinstalled by the updater seam branch').toBe(true)
  expect(await page.evaluate(() => window._item('#e2e_autodep/b/c/d')!.text), 'updated text landed').toContain('v2')
  expect(
    await page.evaluate(() =>
      window._item('#e2e_autodep/b/c/d')!.dependencies.includes(window._item('#e2e_autodep/b/c')!.id)
    ),
    'parent back in runtime dependencies'
  ).toBe(true)
  // wait for saves before deleting below, so no create can land after its delete
  await expect
    .poll(() => page.evaluate(() => window.__items.filter(item => !item.savedId).length), { timeout: 120_000 })
    .toBe(0)
  // durable cleanup (review 120 §3): the /file route above is page-local but saved items are not --
  // every later page's startup would call watchLocalRepo('autodep.test') for them and hit the
  // unmocked local-preview seam. delete the three synthetic items and confirm the deletions are
  // durable in the emulator (local removal is immediate; the remote write can still be pending)
  const ids = await page.evaluate(() =>
    window.__items
      .filter(item => item.labelText?.startsWith('#e2e_autodep') || item.labelText == '#updater')
      .map(item => item.savedId!)
  )
  expect(ids, 'three synthetic items plus #updater').toHaveLength(4)
  await page.evaluate(() => {
    for (const name of ['#e2e_autodep/b/c/d', '#e2e_autodep/b/c', '#e2e_autodep', '#updater'])
      window._item(name)!.delete(false)
  })
  // Bearer owner is the emulator's admin bypass: rules otherwise 403 unauthenticated REST reads,
  // which cannot distinguish a deleted document from a present one
  for (const id of ids)
    await expect
      .poll(
        async () =>
          (
            await fetch(`http://localhost:8080/v1/projects/olcanswiki/databases/(default)/documents/items/${id}`, {
              headers: { Authorization: 'Bearer owner' },
            })
          ).status,
        { message: `durable deletion of ${id}`, timeout: 30_000 }
      )
      .toBe(404)
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
