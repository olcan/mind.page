import { createHash } from 'crypto'
import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { firestore, install, loadAdmin, loadAnonymous } from './helpers.js'

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
      // pushable marking reads the commit's files listing. file shas must be REAL git
      // blob shas of the served content -- the pusher/updater compare github_sha(text)
      // against them, and a placeholder could never match, permanently re-marking every
      // updated item pushable (which hid the pushable-clear assertion below)
      const blobSha = (content: string) =>
        createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex')
      return json(200, {
        sha: path.slice('commits/'.length),
        commit: { message: 'synthetic', author: { date: new Date().toISOString() } },
        files: Object.keys(files).map(filename => ({ filename, sha: blobSha(files[filename]) })),
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

  // THE PUSHABLE-CANCEL PHASE (review 143 §3.4): update_item must be able to CANCEL without
  // leaving metadata over old text -- the exact production stuck-item class (sha/token/embeds
  // advanced before the confirm; a later attr save then persisted new metadata with old text).
  // The candidate is EMBED-BEARING so one phase covers main sha AND embed metadata staging.
  files['e2e_autodep/b/c/d.md'] =
    '#e2e_autodep/b/c/d depends on #e2e_autodep explicitly and nothing else. v3\n```js:e.js\nplaceholder\n```\n'
  files['e2e_autodep/b/c/e.js'] = 'served_embed_body_v3()'
  sha = 'e2e-autodep-3'
  const updates3 = { 'e2e_autodep/b/c/d.md': 'e2e-autodep-3', 'e2e_autodep/b/c/e.js': 'e2e-autodep-3' }
  const itemState = () =>
    page.evaluate(() => {
      const item = window._item('#e2e_autodep/b/c/d')! as any
      return {
        text: item.text as string,
        sha: item.attr.sha as string,
        embeds: JSON.stringify(item.attr.embeds ?? null),
        pushable: !!item.pushable,
        // _global_store is the NON-auto-saving accessor (review 144 §5): reading
        // item.global_store itself schedules a save, polluting the observation
        marker: JSON.stringify(item._global_store?._updater ?? null),
      }
    })
  await page.evaluate(() => void ((window._item('#e2e_autodep/b/c/d') as any).pushable = true))
  const before = await itemState()
  expect(before.sha, 'phase precondition: at v2 sha').toBe('e2e-autodep-2')
  const runUpdate = async (clickLabel: string) => {
    let going = true
    const clicker = (async () => {
      while (going) await page.getByText(clickLabel, { exact: true }).click({ timeout: 200 }).catch(() => {})
    })()
    try {
      return await page.evaluate(async updates => {
        const update_item = await (window._item('#updater') as any).eval('update_item', {
          async: true,
          async_simple: true,
        })
        return update_item(window._item('#e2e_autodep/b/c/d'), updates)
      }, updates3)
    } finally {
      going = false
      await clicker
    }
  }
  // CANCEL: the marker must still be the PREVIOUS one while the modal is open (review
  // 144 §3/§5 -- publishing it early was durable and visible to other tabs, which
  // consume it as a completed update; restoring after Cancel cannot undo that), and the
  // complete item state must be preserved after the false return
  const pending = page.evaluate(async updates => {
    const update_item = await (window._item('#updater') as any).eval('update_item', {
      async: true,
      async_simple: true,
    })
    return update_item(window._item('#e2e_autodep/b/c/d'), updates)
  }, updates3)
  await expect(page.getByText('Overwrite unpushed changes', { exact: false })).toBeVisible({ timeout: 30_000 })
  expect((await itemState()).marker, 'marker unpublished while the modal is open').toBe(before.marker)
  await page.getByText('Cancel', { exact: true }).click()
  expect(await pending, 'cancelled update returns false').toBe(false)
  const cancelled = await itemState()
  expect(cancelled, 'cancel preserved the targeted state (text/sha/embeds/pushable/marker)').toEqual(before)
  // drive the exact persistence opportunity that stuck the production items, AWAITED
  await page.evaluate(() => (window._item('#e2e_autodep/b/c/d') as any).save())
  expect(await itemState(), 'state intact after an awaited save').toEqual(before)
  // OVERWRITE: the same update completes -- new sha, embed metadata staged then committed
  // together, served embed body inlined, pushable cleared by the post-write path
  expect(await runUpdate('Overwrite'), 'accepted update returns true').toBe(true)
  const accepted = await itemState()
  expect(accepted.sha).toBe('e2e-autodep-3')
  expect(accepted.text).toContain('v3')
  expect(accepted.text).toContain('served_embed_body_v3()')
  expect(JSON.parse(accepted.embeds)).toMatchObject([{ path: 'e2e_autodep/b/c/e.js', sha: 'e2e-autodep-3' }])
  expect(accepted.pushable, 'pushable cleared after a completed update').toBe(false)
  // the success MARKER published once per accepted write (review 145 §4: without
  // this, deleting the success assignment would still pass the phase)
  expect(JSON.parse(accepted.marker), 'marker equals the accepted updates').toEqual({ last_update: updates3 })
  // the CAPABILITY FENCE (review 146 §3/§4): the live wrapper reports the boolean
  // acceptance contract, and a capability-absent proxy fails closed without its writer
  // ever being called (the in-function fence precedes token/staging work by source
  // order; this row pins the failed-closed result and writer non-invocation)
  expect(
    await page.evaluate(() => (window._item('#e2e_autodep/b/c/d') as any).write_accepts),
    'live wrapper reports the acceptance capability'
  ).toBe(true)
  expect(
    await page.evaluate(async updates => {
      const update_item = await (window._item('#updater') as any).eval('update_item', {
        async: true,
        async_simple: true,
      })
      const real = window._item('#e2e_autodep/b/c/d') as any
      const stale = Object.create(real, {
        write_accepts: { value: undefined }, // the stale-runtime shape
        write: {
          value: () => {
            throw new Error('stale writer must never be called')
          },
        },
      })
      return update_item(stale, { 'e2e_autodep/b/c/d.md': 'e2e-autodep-4' })
    }),
    'stale wrapper fails closed without calling its writer'
  ).toBe(false)

  // THE MARKER SIDE-CHANNEL REFUSAL (review 151 §2.2): a candidate inside a REAL embed
  // body renders as a source-local marker in the grammar view; embed_text is a side
  // channel later spliced into fetched main text, so the updater must REFUSE the update
  // outright rather than let a literal marker persist. (the pusher applies the same
  // one-line policy to its embed capture; its refusal throws before the AFFECTED
  // side-push write -- an earlier clean destination in the loop may already have pushed)
  await page.evaluate(() => {
    const item = window._item('#e2e_autodep/b/c/d') as any
    item.write(
      item.text.replace(
        'served_embed_body_v3()',
        'served_embed_body_v3()\n<!--inert-->\nnot canonical <!--/inert--> x\n<!--/inert-->'
      ),
      ''
    )
  })
  files['e2e_autodep/b/c/d.md'] =
    '#e2e_autodep/b/c/d depends on #e2e_autodep explicitly and nothing else. v4\n```js:e.js\nplaceholder\n```\n'
  sha = 'e2e-autodep-4'
  const beforeRefusal = await itemState()
  expect(
    await page.evaluate(async () => {
      const update_item = await (window._item('#updater') as any).eval('update_item', {
        async: true,
        async_simple: true,
      })
      return update_item(window._item('#e2e_autodep/b/c/d'), { 'e2e_autodep/b/c/d.md': 'e2e-autodep-4' })
    }),
    'marker-bearing real embed refuses the update'
  ).toBe(false)
  const afterRefusal = await itemState()
  expect(afterRefusal, 'refusal preserved the item exactly').toEqual(beforeRefusal)
  // the check_updates branch refuses the same shape (review 152 §2.2: its early
  // preflight runs before token and mark_pushables undo work)
  expect(
    await page.evaluate(async () => {
      const check_updates = await (window._item('#updater') as any).eval('check_updates', {
        async: true,
        async_simple: true,
      })
      return check_updates(window._item('#e2e_autodep/b/c/d'), true)
    }),
    'check_updates refuses the marker-bearing embed'
  ).toBe(false)
  expect(afterRefusal.text, 'the candidate raw bytes are intact').toContain(
    '<!--inert-->\nnot canonical <!--/inert--> x\n<!--/inert-->'
  )
  expect(afterRefusal.text, 'no literal marker was persisted').not.toContain('\u27e6vault_result_v1:')
  // OLD-APP SHAPE (review 180 §3.2): with the capability absent, the DEFAULT
  // check_updates path (mark_pushables = false) on an embed-bearing item must warn and
  // return false BEFORE any token/network/writer work -- never throw
  expect(
    await page.evaluate(async () => {
      const check_updates = await (window._item('#updater') as any).eval('check_updates', {
        async: true,
        async_simple: true,
      })
      const grammar = (window as any)._grammar
      const fetches: string[] = []
      const realFetch = window.fetch
      try {
        delete (window as any)._grammar
        ;(window as any).fetch = (...args: any[]) => {
          fetches.push(String(args[0]))
          return realFetch.apply(window, args as any)
        }
        const result = await check_updates(window._item('#e2e_autodep/b/c/d'))
        return { result, fetches: fetches.length }
      } catch (e) {
        return { threw: String(e) }
      } finally {
        ;(window as any)._grammar = grammar
        ;(window as any).fetch = realFetch
      }
    }),
    'stale-app default check_updates fails closed without I/O'
  ).toEqual({ result: false, fetches: 0 })

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
    // the writer's explicit acceptance result (review 145 §4): a READ-ONLY wrapper
    // (via the _item options object) refuses with false -- the updater's capability
    // fence depends on this contract
    expect(
      await page.evaluate(() => (window._item as any)('#e2e_sync', { read_only: true }).write('nope')),
      'read-only write refused with false'
    ).toBe(false)
    const textBefore = await page.evaluate(() => window._item('#e2e_sync')!.text)
    expect(textBefore, 'text exactly unchanged by the refusal').toBe('#e2e_sync created by admin during e2e tests')
    // delete(false) skips the window.confirm prompt, which is auto-dismissed in headless browsers
    await page.evaluate(() => window._item('#e2e_sync')!.delete(false))
    await expect.poll(exists, { timeout: 30_000 }).toBe(false) // remote delete
  } finally {
    await context.close()
  }
})

test('vault routing: start, completion, and catch fences suppress web dispatch', async ({ page }) => {
  // the THREE-fence routing witness (bridge design §2.1, reviews 143 §3.2, 148 §4). fixture
  // uses the REAL corpus path -- the installed #chat/ollama provider and its /ollama
  // command -- with its endpoint intercepted, so no model or network call happens and
  // the in-flight request is directly observable and releasable.
  await loadAdmin(page)
  let calls = 0
  let release: (() => void) | null = null
  await page.route('**/api/chat**', async route => {
    calls++
    await new Promise<void>(resolve => (release = resolve))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ message: { role: 'assistant', content: 'fake web reply' } }),
    })
  })
  const runAgent = (name: string) =>
    page.evaluate(async name => {
      const run = await (window._item('#agent/chat') as any).eval('run_on_chat_item', {
        async: true,
        async_simple: true,
      })
      return run(window._item(name))
    }, name)
  const textOf = (name: string) => page.evaluate(name => window._item(name, true)?.text ?? '', name)
  const cleanup = () =>
    page.evaluate(() => {
      for (const name of ['#chat/ollama/0', '#chat/ollama/1', '#chat/ollama/2'])
        if (window._exists(name)) window._item(name)!.delete(false)
    })
  await cleanup() // clear any residue from an earlier failed run (fixed /N names)
  try {
    // PHASE 1 (start fence): the owner adds a vault marker to a web-routed chat item --
  // the web provider must never be invoked at all
  await page.evaluate(() => void window._create('/ollama hello', { command: true }))
  await expect.poll(() => textOf('#chat/ollama/0'), { timeout: 30_000 }).toContain('hello')
  await page.evaluate(() => {
    const item = window._item('#chat/ollama/0')!
    const [first, ...rest] = item.text.split('\n')
    item.write([first + ' #_agent/vault', ...rest].join('\n'), '')
  })
  expect(await textOf('#chat/ollama/0'), 'the vault marker is on the item').toContain('#_agent/vault')
  const callsBefore = calls
  await runAgent('#chat/ollama/0')
  expect(calls, 'start fence: the web provider was never invoked').toBe(callsBefore)
  expect(await textOf('#chat/ollama/0'), 'start fence: nothing was appended').not.toContain('fake web reply')
  // PHASE 2 (completion fence): a web-only chat item starts, the provider blocks, the
  // owner adds the vault route, the provider is released -- the reply must NOT publish
  await page.evaluate(() => void window._create('/ollama hello again', { command: true }))
  await expect.poll(() => textOf('#chat/ollama/1'), { timeout: 30_000 }).toContain('hello again')
  const pending = runAgent('#chat/ollama/1').catch(error => `run failed: ${error}`)
  await expect.poll(() => calls, { message: 'the web provider REALLY ran', timeout: 30_000 }).toBe(callsBefore + 1)
  await page.evaluate(() => {
    const item = window._item('#chat/ollama/1')!
    const [first, ...rest] = item.text.split('\n')
    item.write([first + ' #_agent/vault', ...rest].join('\n'), '')
  })
  const routedText = await textOf('#chat/ollama/1')
  release!()
  expect(await pending, 'completion run settles normally (fence returns undefined)').toBeUndefined()
  expect(await textOf('#chat/ollama/1'), 'completion fence: exact routed text, no reply appended').toBe(routedText)
  // CATCH fence (review 148 §4): a provider REJECTION after the vault marker is added
  // must not publish a web _log either. a fresh web-only item, provider set to reject.
  let rejectRoute: (() => void) | null = null
  await page.unroute('**/api/chat**')
  await page.route('**/api/chat**', async route => {
    calls++
    await new Promise<void>(resolve => (rejectRoute = resolve))
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
  })
  await page.evaluate(() => void window._create('/ollama and again', { command: true }))
  await expect.poll(() => textOf('#chat/ollama/2'), { timeout: 30_000 }).toContain('and again')
  const rejecting = runAgent('#chat/ollama/2')
  await expect.poll(() => calls, { message: 'the rejecting provider ran', timeout: 30_000 }).toBe(callsBefore + 2)
  await page.evaluate(() => {
    const item = window._item('#chat/ollama/2')!
    const [first, ...rest] = item.text.split('\n')
    item.write([first + ' #_agent/vault', ...rest].join('\n'), '')
  })
  const routedText2 = await textOf('#chat/ollama/2')
  rejectRoute!()
  expect(await rejecting, 'catch run settles normally (fence returns undefined)').toBeUndefined()
  expect(await textOf('#chat/ollama/2'), 'catch fence: no web _log published into the routed item').toBe(routedText2)
    expect(await textOf('#chat/ollama/2'), 'catch fence: no error log block').not.toContain('```_log')
  } finally {
    await cleanup()
  }
})

// ---- vault renderer contract (mind sync design, phase 0) ----

// the SYNTHETIC consumer fixtures of the vault's mind sync design (v2 representation,
// notes/design/mind_sync_store.md in the vault): each .md file is one managed item's full text
// under a synthetic managed path (agents/e2e_*.md) and its .json sidecar is the `_vault` value
// of the item's store, converted once from the v1 fixtures the vault's Python encoder generated
// and checked in; they exercise the schema and nesting, not producer truth. in this ANONYMOUS
// row the store is injected in memory (the app's anonymous store path); real hidden documents,
// the non-saving accessor's no-write property, and store-driven propagation through the
// renderer are the personal-account row in vault_renderer.spec.ts. resolved like helpers.ts
// (cwd-relative: playwright runs from the mind.page root; ESM has no __dirname)
const FIXTURES = resolve(process.env.MIND_ITEMS_DIR ?? '../mind.items', 'tests', 'fixtures', 'vault_sync')
const MANIFEST = ['e2e_absent.md', 'e2e_config.md', 'e2e_large.md', 'e2e_nested.md', 'e2e_section.md', 'e2e_worker.md']
const PREFIX = '#vault/agents/e2e_' // every synthetic label starts with this
const RENDERER = '#template/vault'
const block = (text: string, lang: string) => text.split('```' + lang + '\n')[1]?.split('\n```')[0] ?? ''
const unescape = (body: string) => body.replace(/(\\+)<{2}/g, (_m, bs: string) => bs.slice(1) + '<<')
const label = (p: string) => '#vault/' + p.replace(/\.md$/, '')
// a managed item's text (the v2 skeleton: the escaped source, the template region, the tags)
const itemText = (p: string, source: string, deps: string[]) =>
  [
    `${label(p)} <<vault_badge()>>`,
    '```jinja_removed',
    source.replace(/(\\*)<{2}/g, (_m, bs: string) => bs + '\\<<'),
    '```',
    '<!-- template -->',
    '<<vault_render()>>',
    '<!-- /template -->',
    ['#_template/vault', ...deps.map(d => '#_' + label(d).slice(1))].join(' '),
  ].join('\n')
// a `_vault` store value (the consumer accepts any object; wrapper identity and provenance are
// the vault's and the producer's, not a renderer check)
const storeOf = (p: string, pinned: string | null, head_preview: unknown) => ({ v: 2, path: p, pinned_source: pinned, head_preview })

test('vault renderer contract', async ({ page }) => {
  await loadAdmin(page)
  const files = readdirSync(FIXTURES).filter(f => f.endsWith('.md')).sort()
  expect(files, 'the exact fixture manifest').toEqual(MANIFEST)
  const texts = files.map(file => readFileSync(resolve(FIXTURES, file), 'utf8'))
  const stores = files.map(file => JSON.parse(readFileSync(resolve(FIXTURES, file.replace(/\.md$/, '.json')), 'utf8')))
  // the in-memory store injection of this anonymous row (the app's anonymous store path), then a
  // forced render so the injected value is what the next read sees
  const setStore = (n: string, store: unknown) =>
    page.evaluate(
      ([n, store]) => {
        const item = window._item(n)!
        item.global_store = { _vault: store }
        ;(item as any).invalidate_elem_cache({ force_render: true, render_delay: 0 })
      },
      [n, store] as const
    )
  // the badge as rendered on screen; the forced render after an injection is asynchronous, so
  // every read of an injected item first waits for its badge to leave the pre-injection note
  const badgeOf = (n: string) =>
    page.evaluate(n => window._item(n, true)?.elem?.querySelector('[title="managed by the vault sync"]')?.textContent ?? null, n)
  const nameOf = (text: string) => text.split(/\s/)[0]
  const fixture = (file: string) => texts[files.indexOf(file)]
  // items are addressed by LOCAL id: a duplicated label renames both wrappers to id:<local-id>,
  // so names are ambiguous exactly in the killed-run state the pre-clean must recover from
  const localIdOf = (label: string) => page.evaluate(l => window._items().find(i => i.label == l)?.id ?? null, label)
  const savedIdOfId = (id: string) => page.evaluate(id => (window._item(id, true) as any)?.saved_id ?? null, id)
  const savedIdOf = async (label: string) => {
    const id = await localIdOf(label)
    return id ? savedIdOfId(id) : null
  }
  // DURABLE persistence (feedback 6/7): a create is awaited until the item has its saved id,
  // a delete is awaited until the emulator's document is gone (the app's deleteDoc is
  // fire-and-forget and the local array drops the item synchronously)
  const absent = async (ids: string[]) => {
    for (const id of ids) await expect.poll(async () => (await firestore().collection('items').doc(id).get()).exists, { timeout: 30_000 }).toBe(false)
  }
  const create = async (text: string) => {
    const before: string[] = await page.evaluate(l => window._items().filter(i => i.label == l).map(i => i.id), nameOf(text))
    await page.evaluate(t => void window._create(t), text)
    let id: string | null = null
    await expect.poll(async () => (id = await page.evaluate(([l, b]) => window._items().find(i => i.label == l && !b.includes(i.id))?.id ?? null, [nameOf(text), before] as const)), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => savedIdOfId(id!), { timeout: 30_000 }).toBeTruthy()
    return { id: id!, saved: (await savedIdOfId(id!)) as string }
  }
  const remove = async (localId: string, savedId: string | null) => {
    await page.evaluate(id => window._item(id)!.delete(false), localId)
    if (savedId) await absent([savedId])
  }
  // every local item under the synthetic prefix or the renderer, by LOCAL id (labels may be
  // duplicated after a killed run, when _item(label) would be ambiguous); pre-cleaning is the
  // recovery path after a killed or timed-out run, the finally path handles failures
  const clean = async () => {
    const local: { id: string; saved: string | null }[] = await page.evaluate(
      ([p, r]) => window._items().filter(i => i.label.startsWith(p) || i.label == r).map(i => ({ id: i.id, saved: (i as any).saved_id ?? null })),
      [PREFIX, RENDERER] as const
    )
    for (const { id, saved } of local) await remove(id, saved)
    expect(await page.evaluate(([p, r]) => window._items().filter(i => i.label.startsWith(p) || i.label == r).length, [PREFIX, RENDERER] as const)).toBe(0)
    return local.map(l => l.saved).filter((s): s is string => !!s)
  }
  const carriers = (n: string) =>
    page.evaluate(n => {
      const content = window._item(n, true)!.elem?.querySelector('.content') as HTMLElement
      return [...(content?.querySelectorAll('pre code') ?? [])].map(c => c.textContent ?? '')
    }, n)
  const show = async (n: string) => {
    await page.evaluate(n => void (location.hash = n), n)
    await expect.poll(() => page.evaluate(n => !!window._item(n, true)?.elem, n), { timeout: 15_000 }).toBe(true)
  }
  await clean()
  try {
    expect(await install(page, 'template/vault'), '/_install template/vault').toBeNull()
    await expect.poll(() => savedIdOf(RENDERER), { timeout: 30_000 }).toBeTruthy()
    // install every fixture before rendering any (dependency tags must resolve first), then
    // inject every store
    for (const text of texts) await create(text)
    for (const [i, text] of texts.entries()) await setStore(nameOf(text), stores[i])
    for (const [i, file] of files.entries()) {
      const text = texts[i]
      const name = nameOf(text)
      const store = stores[i]
      const source = unescape(block(text, 'jinja_removed'))
      // the visible badge drops the path the label already carries (mind sync presentation P2)
      const expectedBadge = store.head_preview
        ? store.head_preview.kind + (source === store.pinned_source ? '' : ' · differs from the stored sync snapshot')
        : 'not in the stored sync snapshot'
      await show(name)
      await expect.poll(() => badgeOf(name), { timeout: 30_000 }).toBe(expectedBadge)
      const r = await page.evaluate(n => {
        const item = window._item(n, true)!
        const content = item.elem?.querySelector('.content') as HTMLElement
        const owner = (el: Element) => (el.getAttribute('onclick') ?? '').match(/_item\('([^']+)'\)/)?.[1] ?? ''
        // both halves of every toggle: the visible span and the revealed div, paired by id class
        const halves = [...(content?.querySelectorAll('span.template_toggle') ?? [])].map(s => {
          const idc = [...s.classList].find(c => c.startsWith('id_')) ?? ''
          const div = idc ? content.querySelector('div.template_toggle.' + idc) : null
          return {
            idc,
            spanOwner: owner(s),
            divOwner: div ? owner(div) : null,
            inVault: !!s.closest('.vault') && !!div?.closest('.vault'),
            labelHasBlock: !!s.querySelector('pre'),
            hidden: div?.classList.contains('hidden') ?? null,
            handlerLeak: (div?.textContent ?? '').includes('classList.toggle'),
            label: s.textContent ?? '',
          }
        })
        return {
          id: item.id,
          rendered: content?.textContent ?? '',
          containers: content?.querySelectorAll('.vault').length ?? 0,
          // every block carrier sits under a .vault ancestor (checked outward from the carrier)
          carriersOutsideVault: [...(content?.querySelectorAll('pre code') ?? [])].filter(c => !c.closest('.vault')).length,
          codeText: [...(content?.querySelectorAll('pre code') ?? [])].map(c => c.textContent ?? ''),
          // the badge is the placeholder span titled by vault_badge()
          badge: item.elem?.querySelector('[title="managed by the vault sync"]')?.textContent ?? '',
          carrierChildElements: [...(content?.querySelectorAll('pre code *') ?? [])].length,
          togglesInPre: [...(content?.querySelectorAll('pre .template_toggle') ?? [])].length,
          halves,
          // the expanded context (agent/chat.js: eval_macros with context 'expanded'): both macros
          // return plain text there (the removed blocks are the app's later pass, not the macros')
          expanded: String((item as any).eval_macros('<<vault_badge()>> <<vault_render()>>', { context: 'expanded' })),
        }
      }, name)
      expect(r.containers, `${file}: rendered under a .vault container`).toBeGreaterThan(0)
      expect(r.carriersOutsideVault, `${file}: every carrier has a .vault ancestor`).toBe(0)
      expect(r.codeText, `${file}: the editable source is the editor's, never a carrier`).not.toContain(source)
      expect(r.badge, `${file}: the live badge compares the source with the stored snapshot`).toBe(expectedBadge)
      expect(r.carrierChildElements, `${file}: carriers hold text only`).toBe(0)
      expect(r.togglesInPre, `${file}: no toggle inside a pre`).toBe(0)
      expect(r.halves.map(t => t.label), `${file}: no source control`).not.toContain('⋮ source')
      if (store.head_preview) expect(r.halves.length, `${file}: at least the navigation toggle`).toBeGreaterThan(0)
      else expect(r.rendered, `${file}: a null preview renders its placeholder`).toContain('no pinned preview (not in the stored sync snapshot)')
      for (const t of r.halves) {
        expect(t.divOwner, `${file}: toggle ${t.idc} has a revealed div bound to the outer item`).toBe(r.id)
        expect(t.spanOwner, `${file}: toggle ${t.idc} span bound to the outer item`).toBe(r.id)
        expect(t.inVault, `${file}: toggle ${t.idc} halves have a .vault ancestor`).toBe(true)
        expect(t.labelHasBlock, `${file}: toggle ${t.idc} label carries no block carrier`).toBe(false)
        expect(t.hidden, `${file}: toggle ${t.idc} starts collapsed`).toBe(true)
        expect(t.handlerLeak, `${file}: toggle ${t.idc} leaks no handler text into content`).toBe(false)
      }
      expect(r.expanded, `${file}: expanded context carries no markup`).not.toMatch(/<(div|span|pre|code)\b/)
      expect(r.expanded, `${file}: expanded context never carries the editable source`).not.toContain(source.trim())
    }
    // current-item identity, browser form: the config (A) nests the section (B); A's DOM shows
    // B-unique navigation output (from _this = B) with every toggle bound to A (asserted above),
    // and never B's source (a nested child returns only its navigation composition)
    const A = nameOf(fixture('e2e_config.md'))
    const B = nameOf(fixture('e2e_section.md'))
    const sectionSource = unescape(block(fixture('e2e_section.md'), 'jinja_removed'))
    await show(A)
    const nested = await carriers(A)
    expect(nested.some(t => t.startsWith('**Docs**\nB\n')), 'B-unique navigation rendered under A').toBe(true)
    expect(nested, 'B source never rendered under A').not.toContain(sectionSource)
    // a nested toggle opens on its span and closes on its revealed div (both handlers bound to A)
    const nestedToggle = await page.evaluate(n => {
      const content = window._item(n, true)!.elem?.querySelector('.content') as HTMLElement
      const span = [...content.querySelectorAll('span.template_toggle')].find(s => (s.textContent ?? '').includes('![[agents/e2e_section]]'))
      return span ? ([...span.classList].find(c => c.startsWith('id_')) ?? null) : null
    }, A)
    expect(nestedToggle, 'the nested section toggle exists under A').toBeTruthy()
    const hiddenState = () => page.evaluate(idc => document.querySelector('div.template_toggle.' + idc)?.classList.contains('hidden') ?? null, nestedToggle!)
    // programmatic clicks: a real mouse click also starts editing the item, which is not the
    // toggle contract under test and would leave editing state behind
    const clickToggle = (sel: string) => page.evaluate(sel => (document.querySelector(sel) as HTMLElement).click(), sel)
    await clickToggle('span.template_toggle.' + nestedToggle)
    await expect.poll(hiddenState, { timeout: 5_000 }).toBe(false)
    await clickToggle('div.template_toggle.' + nestedToggle)
    await expect.poll(hiddenState, { timeout: 5_000 }).toBe(true)
    // no rescan: the nested item carries its marker-shaped text part byte-for-byte
    await show(nameOf(fixture('e2e_nested.md')))
    expect(await carriers(nameOf(fixture('e2e_nested.md'))), 'marker-shaped text part carried verbatim').toContain('\n![[agents/e2e_section]]\n')

    await test.step('carrier textContent corpus', async () => {
      // section 3's corpus: exact fields carry the empty and leading/terminal-LF cases, navigation
      // text parts (separated by a target so they are never adjacent) carry the rest
      const corpus = ['\n\nlead', 'trail\n\n', '&lt;', '😀 ünï é', '---', 'https://example.com/x?y=1', '#tag', '`code`', '<path>', '  padded  ', 'a\n\nb', 'a\tb']
      const navigation = corpus.flatMap(text => [{ text }, { target: 'agents/e2e_worker.md' }])
      const store = storeOf('agents/e2e_corpus.md', 'corpus\n', { kind: 'config', navigation, base: null, exact: { profile: 'bare', instructions: '', run_instructions: '\nlead', user_prompt: 'trail\n' } })
      await create(itemText('agents/e2e_corpus.md', 'corpus\n', ['agents/e2e_worker.md']))
      await setStore(label('agents/e2e_corpus.md'), store)
      await show(label('agents/e2e_corpus.md'))
      await expect.poll(() => badgeOf(label('agents/e2e_corpus.md')), { timeout: 30_000 }).toBe('config')
      const got = await carriers(label('agents/e2e_corpus.md'))
      for (const text of ['', '\nlead', 'trail\n', ...corpus]) expect.soft(got, `carrier ${JSON.stringify(text)} is text-exact`).toContain(text)
    })

    await test.step('rejected stores and envelopes fail closed', async () => {
      // stores that fail the observable contract: a control, a C1 character, a lone surrogate,
      // and a delimiter in a text part; a store naming another item's path; a missing store;
      // and a leftover v1 payload block in the text
      const badStores: [string, unknown][] = [
        ['agents/e2e_bad_control.md', storeOf('agents/e2e_bad_control.md', 'bad\n', { kind: 'section', navigation: [{ text: 'a\u0000b' }], base: null, exact: null })],
        ['agents/e2e_bad_c1.md', storeOf('agents/e2e_bad_c1.md', 'bad\n', { kind: 'section', navigation: [{ text: 'a\u0080b' }], base: null, exact: null })],
        ['agents/e2e_bad_surrogate.md', storeOf('agents/e2e_bad_surrogate.md', 'bad\n', { kind: 'section', navigation: [{ text: 'a\ud800b' }], base: null, exact: null })],
        ['agents/e2e_bad_delimiter.md', storeOf('agents/e2e_bad_delimiter.md', 'bad\n', { kind: 'section', navigation: [{ text: 'x<!-- /template -->y' }], base: null, exact: null })],
        // an otherwise VALID store (null preview) naming another item's path
        ['agents/e2e_bad_label.md', storeOf('agents/e2e_worker.md', null, null)],
        // a v1 payload object under the key
        ['agents/e2e_bad_v1.md', { v: 1, path: 'agents/e2e_bad_v1.md', source_head_relation: 'matches', head_preview: { kind: 'section', navigation: [], base: null, exact: null } }],
      ]
      const failed = (p: string) =>
        page.evaluate(n => {
          const item = window._item(n, true)!
          const content = item.elem?.querySelector('.content') as HTMLElement
          return { badge: item.elem?.querySelector('[title="managed by the vault sync"]')?.textContent ?? '', rendered: content?.textContent ?? '', containers: content?.querySelectorAll('.vault').length ?? 0 }
        }, label(p))
      for (const [p, store] of badStores) {
        await create(itemText(p, 'bad\n', []))
        await setStore(label(p), store)
        await show(label(p))
        await expect.poll(() => badgeOf(label(p)), { timeout: 30_000 }).toBe('vault store invalid')
        const r = await failed(p)
        expect.soft(r.badge, `${p}: badge fails closed`).toBe('vault store invalid')
        expect.soft(r.containers, `${p}: no composition`).toBe(0)
        expect.soft(r.rendered, `${p}: no partial interpretation`).not.toMatch(/a.b|x.y|e2e_worker\.md/)
      }
      await create(itemText('agents/e2e_no_store.md', 'bad\n', []))
      await show(label('agents/e2e_no_store.md'))
      await expect.poll(() => badgeOf(label('agents/e2e_no_store.md')), { timeout: 30_000 }).toBe('vault store missing')
      let r = await failed('agents/e2e_no_store.md')
      expect.soft(r.badge, 'a missing store fails closed').toBe('vault store missing')
      expect.soft(r.containers, 'a missing store composes nothing').toBe(0)
      const v1Text = itemText('agents/e2e_v1_text.md', 'bad\n', []).replace('<!-- template -->', '```vault_removed\nYQ==\n```\n<!-- template -->')
      await create(v1Text)
      await setStore(label('agents/e2e_v1_text.md'), storeOf('agents/e2e_v1_text.md', null, null))
      await show(label('agents/e2e_v1_text.md'))
      await expect.poll(() => badgeOf(label('agents/e2e_v1_text.md')), { timeout: 30_000 }).toBe('vault source invalid')
      r = await failed('agents/e2e_v1_text.md')
      expect.soft(r.badge, 'a leftover v1 payload block fails closed').toBe('vault source invalid')
      expect.soft(r.containers, 'a leftover v1 payload block composes nothing').toBe(0)
    })

    // the timed forced-remount record is a phase-2 attended procedure (design section 8): the
    // app keeps a programmatically rendered root mounted across hash navigation in a
    // history-dependent way, so an unmounted-root precondition could not be made stable here
    // a nested render reads the child's CURRENT store: after B's store changes and A is forced to
    // render, A's nested composition shows the new text (no stale nested cache through template();
    // store-driven propagation without a forced render is the personal-account row's contract)
    const bStore = JSON.parse(JSON.stringify(stores[files.indexOf('e2e_section.md')]))
    bStore.head_preview.navigation[0].text = '**Docs**\nB (edited)\n'
    await show(A)
    await setStore(B, bStore)
    await page.evaluate(n => void (window._item(n) as any).invalidate_elem_cache({ force_render: true, render_delay: 0 }), A)
    await expect.poll(async () => (await carriers(A)).some(t => t.startsWith('**Docs**\nB (edited)\n')), { timeout: 30_000 }).toBe(true)

    // HARD: missing-to-created recovery -- deleting a dependency makes the app's dependency
    // resolution fail before vault_render() runs (raw text, no composition); recreating it
    // (after its durable absence, so no two documents ever share the label) and reading A again
    // recovers the composition
    const worker = nameOf(fixture('e2e_worker.md'))
    const workerLocalId = (await localIdOf(worker)) as string
    await remove(workerLocalId, await savedIdOfId(workerLocalId))
    await expect
      .poll(
        () =>
          page.evaluate(n => {
            const item = window._item(n, true)!
            const error = String((window as any).__items[(item as any).index]?.expanded?.error?.message ?? '')
            return { containers: item.elem?.querySelectorAll('.vault').length ?? -1, missing: error.startsWith('eval missing dependencies') }
          }, A),
        { timeout: 30_000 }
      )
      .toEqual({ containers: 0, missing: true })
    await create(fixture('e2e_worker.md'))
    await setStore(worker, stores[files.indexOf('e2e_worker.md')])
    await show(worker)
    await expect.poll(() => badgeOf(worker), { timeout: 30_000 }).toBe('config')
    await show(A)
    await expect.poll(async () => (await carriers(A)).some(t => t.startsWith('**Docs**\nB (edited)\n')), { timeout: 30_000 }).toBe(true)

    // the cleanup path must recover a killed run's duplicate labels: two saved items under one
    // synthetic label (their names become id:<local-id>), both documents durably gone afterwards
    await test.step('duplicate-label cleanup', async () => {
      const dup = itemText('agents/e2e_dup.md', 'dup\n', [])
      const first = await create(dup)
      const second = await create(dup)
      expect(await page.evaluate(([a, b]) => [window._item(a, true)?.name, window._item(b, true)?.name], [first.id, second.id] as const), 'duplicate labels renamed').toEqual([`id:${first.id}`, `id:${second.id}`])
      const removed = await clean()
      expect(removed, 'both duplicates were addressed').toEqual(expect.arrayContaining([first.saved, second.saved]))
      await absent([first.saved, second.saved])
    })
  } finally {
    await clean()
  }
})
