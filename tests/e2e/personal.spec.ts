import http from 'http'
import { expect, test, type Page } from '@playwright/test'
import { FieldValue } from 'firebase-admin/firestore'
import { isolateEmulatorWebChannelPosts } from './emulator_webchannel.js'
import { ALICE, customToken, firestore, loadUser, secretFor, waitForApp, lanePort, laneProjectId } from './helpers.js'
// @ts-expect-error host.js is plain js shared with the node server, without a declaration file
import { SHARED_LOCAL_HOST } from '../../src/host.js'

// personal account path: first sign-in (welcome item, secret phrase), encrypted items, the secret on
// a new device, sharing by key with anonymous visitors, and sign-out
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const PHRASE = 'correct horse battery staple'

// answers a secret phrase prompt (see getSecretPhrase in index.svelte)
async function enterPhrase(page: Page, prompt: RegExp, phrase: string, button: string) {
  await expect(page.getByText(prompt)).toBeVisible({ timeout: 60_000 })
  await page.fill('#modal-input', phrase)
  await page.locator('.modal .button.confirm', { hasText: button }).click()
}

// the firestore document of an item, as stored (encrypted or not)
async function stored(page: Page, name: string) {
  const id = await page.evaluate(name => window._item(name)?.saved_id, name)
  expect(id, `${name} saved`).toBeTruthy()
  return (await firestore().collection('items').doc(id!).get()).data()!
}

// stores the secret as a returning device would have it, before signing in (see secretFor)
async function withSecret(page: Page) {
  // the app reloads itself a moment after a sign-out shows its signed-out page (the cache cleared first),
  // later on a loaded host: a navigation that meets that reload is aborted and is made again (the full
  // gate, 2026-10-28, twice: the shared-page row's second round after its Sign Out)
  await page.goto('/').catch(async e => {
    if (!String(e?.message).includes('ERR_ABORTED')) throw e
    await page.goto('/')
  })
  await page.evaluate(secret => {
    localStorage.setItem('mindpage_secret', secret)
    // the reader now DEFAULTS ON (absent flag = enabled; exact 'off' is the emergency/legacy
    // override — see kdfEnabled in index.svelte). the legacy v0 rows of this suite keep their
    // intentional pre-KDF semantics via explicit 'off'; the KDF rows deliberately CLEAR the flag
    // to exercise the production default
    localStorage.setItem('mindpage_kdf', 'off')
  }, secretFor(ALICE, PHRASE))
}

const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)

// the account's hidden document holding a given store NAME, or null. names live inside the
// ciphertext, so this decrypts — which is also why an account-wide COUNT can never identify one
async function findStoreDoc(name: string) {
  return (await findStore(name))?.id ?? null
}

// the account's hidden document holding a store NAME together with its decrypted state, or null
async function findStore(name: string): Promise<{ id: string; item: any } | null> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const snap = await firestore().collection('items').where('user', '==', ALICE.uid).where('hidden', '==', true).get()
  for (const doc of snap.docs) {
    try {
      const plain = JSON.parse(await decryptWithSecret(doc.data().cipher, secretFor(ALICE, PHRASE)))
      const wrapper = JSON.parse(plain.text)
      if (wrapper.name == name) return { id: doc.id, item: wrapper.item }
    } catch {} // an unrelated corrupt or foreign-keyed record: not ours to identify
  }
  return null
}

test('first sign-in copies the welcome item and sets up a secret phrase that encrypts items', async ({ page }) => {
  await loadUser(page, ALICE)
  // an empty account is seeded with the anonymous account's welcome item (/_welcome), whose save
  // triggers the prompt for a new secret phrase
  await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
  await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
  await waitForApp(page)
  await expect
    .poll(() => page.evaluate(() => window._items().map(item => item.text.split(' ')[0])))
    .toEqual(['Welcome'])
  // the phrase is kept as a hash with the uid (see secretFor), never the phrase itself; it is
  // published LAST (adoptFreshFixedSecret in src/secret.ts: after the key derivation in the kdf
  // worker and the server's re-confirmation that the account is still empty), so the dialog's
  // confirm precedes the stored hash by hundreds of milliseconds on a loaded host (the full
  // gate of 2026-10-28 read null 400 ms after it)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mindpage_secret')), { timeout: 30_000 }).toBe(secretFor(ALICE, PHRASE))
  // items are stored encrypted: cipher only, text and attr nulled
  await page.evaluate(() => void window._create('#e2e_private secret text 12345'))
  await expect.poll(() => savedId(page, '#e2e_private'), { timeout: 30_000 }).toBeTruthy()
  const doc = await stored(page, '#e2e_private')
  expect(doc.user).toBe(ALICE.uid)
  expect(doc.text).toBeNull()
  expect(doc.attr).toBeNull()
  expect(doc.cipher).toMatch(/^[A-Za-z0-9+/=]{40,}$/)
  expect(await page.evaluate(() => window.__items.every(item => !!item.savedId))).toBe(true) // welcome item too
  // a server-served first revision grants hidden-index authority once its application settles
  // (the receipt-time grant used to be reset by initialize(), leaving server-first loads
  // unauthoritative forever)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 15_000 }).toBe(true)
  // reloading with the stored secret decrypts without prompting
  await page.reload()
  await waitForApp(page)
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_private', true)?.text ?? null))
    .toContain('secret text 12345')
  expect(await page.locator('#modal-input').count()).toBe(0)
  // a warm-cache initialization (secret retained) is confirmed by the server with a
  // metadata-only snapshot that can arrive WHILE initialization runs: the queued settlement
  // must await initialization and still grant (round 8: it was discarded, leaving warm-cache
  // loads unauthoritative until the next data change)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 15_000 }).toBe(true)
})

test('a new device must enter the phrase; a wrong one can only sign out', async ({ page }) => {
  // LEGACY (reader 'off' override) contract: under the default-on reader a wrong phrase enters
  // the session's retry flow (unit-pinned in kdf_session.spec) instead of this terminal modal;
  // this row pins the frozen v0 path, so the emergency override is seeded deliberately
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('mindpage_kdf', 'off'))
  await loadUser(page, ALICE) // fresh context: no secret in localStorage
  await enterPhrase(page, /Enter your secret phrase/, 'wrong phrase', 'Continue')
  await expect(page.getByText(/Unable to access your account/)).toBeVisible({ timeout: 60_000 })
  await page.locator('.modal .button.confirm', { hasText: 'Sign Out' }).click()
  // signed out: back to the anonymous account as a read-only visitor, credentials cleared
  await expect(page.getByText('Stay Anonymous', { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(
    await page.evaluate(() => [localStorage.getItem('mindpage_secret'), localStorage.getItem('mindpage_user')])
  ).toEqual([null, null])
  // the right phrase decrypts the account
  await loadUser(page, ALICE)
  await enterPhrase(page, /Enter your secret phrase/, PHRASE, 'Continue')
  await waitForApp(page)
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_private', true)?.text ?? null))
    .toContain('secret text 12345')
})

// ONE lifecycle for "stall the firestore channel, then let it go", shared by the two slow-cache
// tests. requests are DELAYED, not frozen: a channel held indefinitely is abandoned by the sdk and
// does not recover when resumed, which fails for a reason unrelated to what these tests assert.
// `active` counts only requests STILL held — leaving an entry whose timer already resumed it made
// the old `held.length` a lie that a test then waited on
function holdFirestore(page: Page) {
  let blocked = true
  let epoch = 0
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) epoch++
  })
  const held = new Map<() => void, number>() // entry -> the navigation epoch that requested it
  const install = () =>
    page.route(/:8080\/google\.firestore/, route => {
      const go = () => void route.continue().catch(() => {}) // the sign-in reload kills routes
      if (!blocked) return go()
      let entry!: () => void
      const timer = setTimeout(() => {
        held.delete(entry)
        go()
      }, 8_000)
      entry = () => {
        clearTimeout(timer)
        held.delete(entry)
        go()
      }
      held.set(entry, epoch)
    })
  return {
    install,
    get epoch() {
      return epoch
    },
    release: () => {
      blocked = false
      for (const entry of [...held.keys()]) entry()
    },
    // requests still held FOR A GIVEN NAVIGATION. counting all of them let a request from the
    // signed-out page, retained until its 8s timer, satisfy an assertion about the signed-in one
    activeAt: (at: number) => [...held.values()].filter(held => held == at).length,
  }
}

// counts the app's own "keep waiting for the server" decision PER PAGE LOAD, so a late log from
// the signed-out navigation cannot satisfy an assertion about the signed-in one
function watchCacheWait(page: Page) {
  // NAVIGATION COMMIT, not `load`: the app clears mindpage_signin_pending before its own load
  // event, so a load-counted epoch tagged the signed-in page's decision with the signed-out page's
  // number and a late decision from the old page could satisfy the assertion
  let epoch = 0
  let decided = -1
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) epoch++
  })
  page.on('console', message => {
    if (message.text().includes('ignoring first snapshot from cache (waiting for server)')) decided = epoch
  })
  return {
    get epoch() {
      return epoch
    },
    get decided() {
      return decided
    },
  }
}

test('a slow first connection does not reset the account to empty', async ({ page }) => {
  // a fresh device has an empty persistent cache; if the firestore channel is slow, the empty
  // cache snapshot must not initialize the account (which would create a welcome item and, on a
  // device without the secret, prompt for a NEW phrase over the existing items)
  await withSecret(page)
  const channel = holdFirestore(page)
  await channel.install()
  try {
    // sign in without waiting for initialization (as signIn in helpers, which polls past it)
    const token = await customToken(ALICE)
    await page.waitForFunction(() => !!window.firebase?.auth?.signInWithCustomToken, null, { timeout: 30_000 })
    await page.evaluate(token => {
      sessionStorage.setItem('mindpage_signin_pending', '1')
      document.cookie = '__session=signin_pending;max-age=600'
      void window.firebase.auth.signInWithCustomToken(window.firebase.auth.getAuth(window.firebase), token)
    }, token)
    // the reload into the signed-in app clears the pending flag before initializing
    await page.waitForFunction(() => !sessionStorage.getItem('mindpage_signin_pending'), null, { timeout: 30_000 })
    // NO positive milestone exists for THIS case, and review's suggested one does not fire here:
    // with the channel stalled and an EMPTY cache the sdk emits no first snapshot at all, so the
    // app never reaches the `wait_for_server` decision that logs. the state under test is exactly
    // "nothing has arrived and nothing was invented", which only a quiet window can evidence.
    // waiting for the listen to be held first makes the window mean something
    // FROZEN epoch: polling channel.epoch would follow an unexpected later navigation
    const epoch = channel.epoch
    await expect.poll(() => channel.activeAt(epoch)).toBeGreaterThan(0)
    await page.waitForTimeout(1_500)
    expect(await page.evaluate(() => window._init_time > 0)).toBe(false) // undefined until init
    expect(await page.getByText(/Choose a .*secret phrase/).count()).toBe(0)
    channel.release()
    await expect
      .poll(() => page.evaluate(() => window._init_time > 0 && window._readonly === false).catch(() => false), {
        timeout: 90_000,
      })
      .toBe(true)
    await waitForApp(page)
    const names = await page.evaluate(() => window._items().map(item => item.name))
    expect(names).toContain('#e2e_private') // account intact, no welcome item added
    expect(names.filter(name => name == '#e2e_private')).toHaveLength(1)
  } finally {
    channel.release() // however this test ends, no route is left held
  }
})

test('shared items are stored in the clear and visible to anonymous visitors by key', async ({ page, browser }) => {
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  await page.evaluate(() => void window._create('#e2e_shared hello visitors'))
  await expect.poll(() => savedId(page, '#e2e_shared'), { timeout: 30_000 }).toBeTruthy()
  expect((await stored(page, '#e2e_shared')).cipher).toBeTruthy()
  await page.evaluate(() => window._item('#e2e_shared')!.share('e2e-key', 0)) // indexed, so it is shown (not just accessible)
  await expect
    .poll(() => stored(page, '#e2e_shared'), { timeout: 30_000 })
    .toMatchObject({
      cipher: null,
      text: '#e2e_shared hello visitors',
      attr: { shared: { keys: ['e2e-key'] } },
    })
  const context = await browser.newContext() // a signed-out visitor
  try {
    const visitor = await context.newPage()
    await visitor.goto(`/?shared=${ALICE.uid}/e2e-key`)
    await waitForApp(visitor)
    expect(await visitor.evaluate(() => window._readonly)).toBe(true)
    expect(await visitor.evaluate(() => window._items().map(item => item.name))).toEqual(['#e2e_shared'])
    expect(await visitor.evaluate(() => window.__hideIndex)).toBe(1) // shown, not just accessible
    // the header names the sharer via /user/<uid> (the display name of the signed-in profile)
    await expect(visitor.locator('.header .status .center .subtitle')).toHaveText(/shared by Alice/)
  } finally {
    await context.close()
  }
  // unsharing encrypts the item again
  await page.evaluate(() => window._item('#e2e_shared')!.unshare('e2e-key'))
  await expect.poll(() => stored(page, '#e2e_shared'), { timeout: 30_000 }).toMatchObject({ text: null, attr: null })
  expect((await stored(page, '#e2e_shared')).cipher).toBeTruthy()
})

test('direct typed reads and dependency prefixes are memoized, evaluation scripts cache-friendly; deep reads follow a dependency edit and a dependency identity change (init_perf)', async ({ page }) => {
  // the read memo (readMemo in index.svelte): a DIRECT typed read is served from the memo on
  // repeat (window._read_memo counts hits and misses); a deep read is rebuilt from the memoized
  // direct reads, so it follows a dependency's text edit (a new hash) and a dependency IDENTITY
  // change with the same text (a duplicate-label twin outliving the original); the dependency is
  // the hidden tag #_e2e_memo_dep (dependencies come from hidden tags, see itemDeps). the
  // dependency PART of a deep read is memoized too (depsPrefixMemo, window._deps_prefix_memo),
  // keyed by the dependency ids, hashes and async flags, so it follows both changes as well. an
  // EVALUATION's script keeps its strict directive inside the wrapper (its top level sloppy: for
  // this script shape and indirect eval, V8's compilation cache served a repeated identical script
  // only then) and runs its replacement passes over the item's own part and the code only when the
  // dependency part carries no macro or $ token
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  const dep = (n: number) => `#e2e_memo_dep\n\`\`\`js\nconst E2E_MEMO = ${n}\nconst E2E_MEMO_ID = "$id"\nfunction e2e_memo_strict() { return this === undefined }\n\`\`\``
  await page.evaluate(t => void window._create(t), dep(1))
  await page.evaluate(() => void window._create('#e2e_memo_user #_e2e_memo_dep\n```js\nE2E_MEMO\nconst E2E_OWN_NAME = "$name"\n```'))
  // a dependency carrying a $ token (its dependents keep the whole-script replacement passes)
  await page.evaluate(() => void window._create('#e2e_memo_tokendep\n```js\nconst E2E_DEP_NAME = "$name"\n```'))
  await page.evaluate(() => void window._create('#e2e_memo_tokenuser #_e2e_memo_tokendep\n```js\nE2E_DEP_NAME\n```'))
  // a dependent whose own block does not reference the dependency (the include_deps table)
  await page.evaluate(() => void window._create('#e2e_memo_incl #_e2e_memo_dep\n```js\nconst E2E_INCL = 1\n```'))
  // a dependency with a markdown macro outside its js block and a $ token inside it, and its
  // dependent: a transient read (eval_macros with replace_items) must run the macro ONCE
  await page.evaluate(() => void window._create('#e2e_memo_macrodep <<++window.__e2e_counter>>\n```js\nconst E2E_MACRO_VALUE = "$name"\n```'))
  await page.evaluate(() => void window._create('#e2e_memo_macrouser #_e2e_memo_macrodep\n```js\nconst E2E_MACRO_USER = 1\n```'))
  await expect
    .poll(() => page.evaluate(() => ['#e2e_memo_user', '#e2e_memo_dep', '#e2e_memo_tokendep', '#e2e_memo_tokenuser', '#e2e_memo_incl', '#e2e_memo_macrodep', '#e2e_memo_macrouser'].every(n => !!window._item(n, true)?.saved_id)), {
      timeout: 30_000,
    })
    .toBe(true)
  const prefixStats = () => page.evaluate(() => ({ ...(window as any)._deps_prefix_memo }))
  const deep = () => page.evaluate(() => window._item('#e2e_memo_user')!.read_deep('js', { replace_ids: true }))
  const first = await deep()
  const depId = await page.evaluate(() => window._item('#e2e_memo_dep')!.id)
  expect(first).toContain('const E2E_MEMO = 1')
  expect(first, 'the dependency read substitutes its own id').toContain(`const E2E_MEMO_ID = "${depId}"`)
  // a repeated deep read does no read work: its dependency part comes from the prefix memo (one
  // hit, no miss) and its direct reads are not repeated (their counters do not move); a repeated
  // DIRECT typed read of the dependency is served from the direct memo (work counts, not string
  // comparisons; the counters are read and the reads made in one synchronous evaluation)
  const repeat = await page.evaluate(() => {
    const w = window as any
    const snap = () => ({ read: { ...w._read_memo }, prefix: { ...w._deps_prefix_memo } })
    const before = snap()
    const text = w._item('#e2e_memo_user').read_deep('js', { replace_ids: true })
    const after = snap()
    const direct = w._item('#e2e_memo_dep').read('js', { replace_ids: true })
    return { before, text, after, direct, afterDirect: snap() }
  })
  expect(repeat.text).toBe(first)
  expect(repeat.after.prefix.hits, 'the dependency prefix was served from the memo').toBe(repeat.before.prefix.hits + 1)
  expect(repeat.after.prefix.misses, 'the dependency prefix was not reassembled').toBe(repeat.before.prefix.misses)
  expect(repeat.after.read, 'no direct read was made for the repeated deep read').toEqual(repeat.before.read)
  expect(repeat.direct).toContain('const E2E_MEMO = 1')
  expect(repeat.afterDirect.read.hits, 'the direct read hits').toBe(repeat.after.read.hits + 1)
  expect(repeat.afterDirect.read.misses, 'no miss on the repeated direct read').toBe(repeat.after.read.misses)
  // the evaluation script: sloppy at its top level with the strict directive inside the wrapper,
  // the dependency part once at its place before the own part, and the $ tokens replaced in the
  // own part (a token-free dependency part) as in a dependency that carries one (the whole
  // script's passes, where the dependency's token takes the EVALUATING item's name, as before)
  const script = await page.evaluate(() => {
    const w = window as any
    const user = w._item('#e2e_memo_user')
    const text: string = user.eval('E2E_OWN_NAME', { trigger: 'e2e_script', skip_eval: true })
    const wrapperAt = text.indexOf('(() => {')
    return {
      head: text.slice(0, 10),
      strictInside: text.indexOf("'use strict';") > wrapperAt && wrapperAt > 0,
      depOnce: text.split('const E2E_MEMO = 1').length - 1,
      depBeforeOwn: text.indexOf('const E2E_MEMO = 1') < text.indexOf('const E2E_OWN_NAME'),
      ownReplaced: text.includes('const E2E_OWN_NAME = "#e2e_memo_user"'),
      value: user.eval('E2E_OWN_NAME', { trigger: 'e2e_script2' }),
      tokenValue: w._item('#e2e_memo_tokenuser').eval('E2E_DEP_NAME', { trigger: 'e2e_script3' }),
      debugLists: Object.keys(user.debug_store).includes('e2e_script2') && String(user.debug_store['e2e_script2']).includes('E2E_OWN_NAME'),
    }
  })
  expect(script).toEqual({ head: 'undefined;', strictInside: true, depOnce: 1, depBeforeOwn: true, ownReplaced: true, value: '#e2e_memo_user', tokenValue: '#e2e_memo_tokenuser', debugLists: true })
  // text parity with read_deep: the split path's script carries the prefix exactly as read_deep
  // reads it (the $name of the own part replaced, the dependency part verbatim), and a forwarded
  // comment_deps keeps read's html comments for the dependencies AND the item (the own comment
  // line is read's, not a copy); a forwarded include_deps suppresses the dependencies exactly when
  // read_deep did — for false and for an explicit undefined or null, not when absent or true
  const parity = await page.evaluate(() => {
    const w = window as any
    const user = w._item('#e2e_memo_user')
    const opts = { exclude_async_deps: true, replace_ids: true, remove_empty_lines: true, remove_comment_lines: true, remove_tests_and_benchmarks: true }
    const expected = user.read_deep('js', opts).replace(/\$name/g, '#e2e_memo_user')
    const text: string = user.eval('E2E_OWN_NAME', { trigger: 'e2e_parity', skip_eval: true })
    const commented: string = user.eval('E2E_OWN_NAME', { trigger: 'e2e_parity2', skip_eval: true, comment_deps: true })
    const typeOf = (o: object) => w._item('#e2e_memo_incl').eval('typeof E2E_MEMO', { trigger: 'e2e_parity3', ...o })
    return {
      prefixVerbatim: text.includes(expected),
      commented: commented.includes('<!-- #e2e_memo_dep -->') && commented.includes('<!-- #e2e_memo_user -->') && !commented.includes('/* js @ #e2e_memo_user */'),
      include: [typeOf({}), typeOf({ include_deps: true }), typeOf({ include_deps: false }), typeOf({ include_deps: undefined }), typeOf({ include_deps: null })],
    }
  })
  expect(parity).toEqual({ prefixVerbatim: true, commented: true, include: ['number', 'number', 'undefined', 'undefined', 'undefined'] })
  // the three wrappers keep the prefix's functions and the evaluated code strict (`this` of an
  // ordinary function is undefined); the start form runs read-only so its output is not written
  const strict = await page.evaluate(async () => {
    const w = window as any
    const user = w._item('#e2e_memo_user')
    const code = '[e2e_memo_strict(), (function () { return this === undefined })()]'
    return {
      sync: user.eval(code, { trigger: 'e2e_strict' }),
      simple: await user.eval(code, { trigger: 'e2e_strict2', async: true, async_simple: true }),
      start: await user.eval(code, { trigger: 'e2e_strict3', async: true, read_only: true }),
    }
  })
  expect(strict).toEqual({ sync: [true, true], simple: [true, true], start: [true, true] })
  // a transient evaluation read (eval_macros with replace_items: not memoizable) of a dependent whose
  // dependency carries a $ token: read_deep is taken at once, so the dependency's macro runs once
  const once = await page.evaluate(() => {
    const w = window as any
    w.__e2e_counter = 0
    const text: string = w._item('#e2e_memo_macrouser').eval('E2E_MACRO_VALUE', { trigger: 'e2e_once', skip_eval: true, eval_macros: true, replace_items: {} })
    return { counter: w.__e2e_counter, replaced: text.includes('const E2E_MACRO_VALUE = "#e2e_memo_macrouser"') }
  })
  expect(once).toEqual({ counter: 1, replaced: true })
  // whole-item deep reads bypass the prefix memo: their block selector is not in the key (a regex
  // supplies its source, a string is used as given: blockRegExp), so the two reads below must
  // differ — the first removes the dependency's js block, the second matches no block
  const whole = await page.evaluate(() => {
    const w = window as any
    const user = w._item('#e2e_memo_user')
    const before = { ...w._deps_prefix_memo }
    const removed = user.read('', { include_deps: true, remove_blocks: /js/ })
    const kept = user.read('', { include_deps: true, remove_blocks: '/js/' })
    return { before, after: { ...w._deps_prefix_memo }, removed, kept }
  })
  expect(whole.removed, 'the regex selector removed the dependency block').not.toContain('const E2E_MEMO')
  expect(whole.kept, 'the string selector matched no block').toContain('const E2E_MEMO = 1')
  expect(whole.after, 'whole-item reads touch no prefix memo counter').toEqual(whole.before)
  // the budget: a prefix over the live budget is assembled and returned but not stored (oversize),
  // an insertion that would exceed the budget clears the map first, and entries and chars track
  // what is stored (new read options make new keys, i.e. misses, without changing the text much)
  const budget = await page.evaluate(() => {
    const w = window as any
    const s = w._deps_prefix_memo
    const user = w._item('#e2e_memo_user')
    const saved = s.budget
    const text = user.read_deep('js', { replace_ids: true })
    s.budget = 1
    const before = { ...s }
    const oversize = user.read_deep('js', { replace_ids: true, remove_comment_lines: true })
    const afterOversize = { ...s }
    s.budget = saved
    const stored = user.read_deep('js', { replace_ids: true, remove_comment_lines: true })
    const afterStored = { ...s }
    // a budget just below the current size plus one more prefix: the next new key clears the map
    s.budget = afterStored.chars + 1
    const cleared = user.read_deep('js', { replace_ids: true, remove_empty_lines: true })
    const afterCleared = { ...s }
    s.budget = saved
    return { text, before, oversize, afterOversize, stored, afterStored, cleared, afterCleared }
  })
  expect(budget.oversize).toBe(budget.stored) // the same read, bypassed then stored
  expect(budget.afterOversize.oversize, 'an oversize prefix is counted, not stored').toBe(budget.before.oversize + 1)
  expect(budget.afterOversize.misses).toBe(budget.before.misses + 1)
  expect([budget.afterOversize.entries, budget.afterOversize.chars]).toEqual([budget.before.entries, budget.before.chars])
  expect(budget.afterStored.entries, 'stored once the budget allows').toBe(budget.before.entries + 1)
  expect(budget.afterStored.chars).toBeGreaterThan(budget.before.chars)
  expect(budget.afterStored.chars - budget.before.chars, 'chars grows by the stored prefix, less than the read').toBeLessThan(budget.stored.length)
  expect(budget.afterCleared.entries, 'the over-budget insertion cleared the map first').toBe(1)
  expect(budget.afterCleared.chars).toBeLessThanOrEqual(budget.cleared.length)
  expect(budget.cleared).toContain('const E2E_MEMO = 1')
  // a dependency text edit: a new hash, a new read, a reassembled prefix. the budget case evicted
  // this key, so it is warmed again first: the edit must invalidate a CACHED prefix
  expect(await deep()).toBe(first)
  const prefixBeforeEdit = await prefixStats()
  await page.evaluate(t => window._item('#e2e_memo_dep')!.write(t, ''), dep(2))
  await expect.poll(deep, { timeout: 30_000 }).toContain('const E2E_MEMO = 2')
  expect(await deep()).not.toContain('E2E_MEMO = 1')
  expect((await prefixStats()).misses, 'the edited dependency is a new prefix key').toBeGreaterThan(prefixBeforeEdit.misses)
  // a dependency IDENTITY change with the same text: a twin with the same label, then the
  // original deleted — the twin's id must appear (a deep read memoized under the deephash would
  // keep the original's id, since the deephash carries text hashes only)
  await page.evaluate(t => void window._create(t), dep(2))
  await page.evaluate(id => window._item(id)!.delete(false), depId)
  await expect
    .poll(async () => (await page.evaluate(() => window._items().filter(i => i.label == '#e2e_memo_dep').map(i => i.id))).length, { timeout: 30_000 })
    .toBe(1)
  const twinId = await page.evaluate(() => window._items().find(i => i.label == '#e2e_memo_dep')!.id)
  expect(twinId).not.toBe(depId)
  await expect.poll(deep, { timeout: 30_000 }).toContain(`const E2E_MEMO_ID = "${twinId}"`)
  expect(await deep(), 'the deleted original is gone from the deep read').not.toContain(depId)
  // cleanup once the twin has its saved id (it was created moments ago)
  await expect.poll(() => page.evaluate(() => window._item('#e2e_memo_dep', true)?.saved_id ?? null), { timeout: 30_000 }).toBeTruthy()
  const ids = await page.evaluate(() => ['#e2e_memo_user', '#e2e_memo_dep', '#e2e_memo_tokendep', '#e2e_memo_tokenuser', '#e2e_memo_incl', '#e2e_memo_macrodep', '#e2e_memo_macrouser'].map(n => window._item(n)!.saved_id))
  for (const id of ids) await firestore().collection('items').doc(id!).delete()
})

test('a partially cached account does not prompt for a new phrase', async ({ page }) => {
  // visiting a shared page caches its (plaintext) items; signing in afterwards on a device without
  // the stored secret used to initialize from that partial cache snapshot, see no ciphertext and
  // prompt for a NEW phrase over the existing encrypted items (found in a manual pass)
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  await page.evaluate(() => window._item('#e2e_shared')!.share('e2e-key', 0))
  await expect
    .poll(() => stored(page, '#e2e_shared'), { timeout: 30_000 })
    .toMatchObject({
      attr: { shared: { keys: ['e2e-key'] } },
    })
  // EMPTY THE CACHE THE SETUP ABOVE FILLED. sharing needs alice's whole account loaded, so without
  // this the "partial" cache already held every document and the item count below only reflected
  // the shared page's FILTER. clearing needs firestore terminated and no other tab of this origin
  // open; auth lives in its own database, so alice stays signed in across it
  expect(
    await page.evaluate(async () => {
      const { getFirestore, terminate, clearIndexedDbPersistence } = window.firebase.firestore
      const db = getFirestore(window.firebase)
      await terminate(db)
      await clearIndexedDbPersistence(db)
      return true
    }),
    'the persistent cache is cleared before the shared visit warms it'
  ).toBe(true)
  // the owner's OWN shared page stays on the account origin (see sharedOriginRedirect), and its
  // query is now the only thing that repopulates the cache — one document. a signed-out visit
  // would move to the isolated origin, whose cache is memory-only and cannot produce this at all
  await page.goto(`/?shared=${ALICE.uid}/e2e-key`)
  await waitForApp(page)
  expect(await page.evaluate(() => window._items().length)).toBe(1) // PARTIAL: the shared item only
  // drop the stored secret WITHOUT signing out: sign-out also clears the firestore cache, which is
  // the very state under test. what remains is exactly "a device that has this account's partial
  // cache and no stored secret"
  await page.evaluate(() => localStorage.removeItem('mindpage_secret'))
  const channel = holdFirestore(page)
  const cacheWait = watchCacheWait(page)
  await channel.install()
  try {
    // initialize with the firestore channel stalled: the first snapshot comes from the partial cache
    await page.goto('/')
    // EXACTLY this navigation's decision: >= would also accept one from a later reload. and the
    // hold must be REAL — if the route pattern ever stops matching, the cached snapshot still logs
    // wait_for_server and this test would pass having stalled nothing
    const epoch = cacheWait.epoch
    await expect.poll(() => cacheWait.decided, { timeout: 60_000 }).toBe(epoch)
    expect(channel.activeAt(epoch), 'the firestore channel is actually held for this navigation').toBeGreaterThan(0)
    expect(await page.evaluate(() => window._init_time > 0)).toBe(false) // undefined until init
    expect(await page.getByText(/Choose a .*secret phrase/).count()).toBe(0)
    channel.release()
    // the server snapshot arrives with the encrypted items, which prompt for the existing phrase
    await enterPhrase(page, /Enter your secret phrase/, PHRASE, 'Continue')
    await waitForApp(page)
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_private', true)?.text ?? null))
      .toContain('secret text 12345')
    await page.evaluate(() => window._item('#e2e_shared')!.unshare('e2e-key')) // restore for later tests
    await expect.poll(() => stored(page, '#e2e_shared'), { timeout: 30_000 }).toMatchObject({ text: null })
  } finally {
    channel.release() // however this test ends, no route is left held
  }
})

test('a complete cache without the stored secret still initializes from the server', async ({ page }) => {
  // with a complete cache matching the server there is no data change, so the first-snapshot gate
  // must rely on a metadata snapshot (fromCache -> false) to proceed; without includeMetadataChanges
  // the page hung forever at "ignoring first snapshot from cache" (found in production)
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page) // fills the persistent cache with the full account
  // simulate a device that lost only the local storage (cache intact), as a fresh profile that had
  // visited before signing in
  await page
    .evaluate(async () => {
      localStorage.removeItem('mindpage_secret')
      localStorage.removeItem('mindpage_user')
      await (window.firebase.auth.getAuth(window.firebase) as { signOut: () => Promise<void> }).signOut()
    })
    .catch(() => {}) // the app reloads itself on the auth change, destroying this context
  await page.waitForTimeout(1_000)
  await page.goto('about:blank') // settle before navigating
  await loadUser(page, ALICE)
  await enterPhrase(page, /Enter your secret phrase/, PHRASE, 'Continue') // not "Choose ..."
  await waitForApp(page)
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_private', true)?.text ?? null))
    .toContain('secret text 12345')
  // the cache-initialized index is not authoritative by itself; the server's metadata-only
  // confirmation grants authority through the serialized chain
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 15_000 }).toBe(true)
})

test('the header scrolls to the top on a short column (new account)', async ({ page }) => {
  // reported bug: the auto-scroll runs before the items are measured, so on a SHORT column the
  // document is briefly shorter than the target, the browser clamps the scroll, and the flag
  // latched anyway — leaving the header a few inches below the top with column padding above it,
  // permanently. tall columns (the public home page, a shared intro) already exceed the target
  // at first layout, which is why it only showed for new accounts
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const header = document.querySelector('.header') as HTMLElement
          return Math.round(header.getBoundingClientRect().top)
        }),
      { timeout: 30_000 }
    )
    .toBeLessThanOrEqual(1) // the header reaches the top of the viewport
  // and stays there once settled
  await page.waitForTimeout(2_000)
  expect(
    await page.evaluate(() =>
      Math.round((document.querySelector('.header') as HTMLElement).getBoundingClientRect().top)
    )
  ).toBeLessThanOrEqual(1)
})

test('a foreign shared page is served from the isolated origin, which clears app storage residue', async ({ page }) => {
  // a shared page runs its OWNER's code, and no in-origin measure contains that: any same-origin
  // realm recreates the firebase facade, and auth persistence, the session cookie and
  // localStorage (secret included) are per-ORIGIN. so foreign shared pages move to an isolated
  // origin (see sharedOriginRedirect, whose decision table is pinned in tests/unit/host.spec.ts),
  // which also closes the case a consent prompt never could — a visitor signed out today who signs
  // in later while owner code is still resident in a tab of this origin.
  // locally that origin is SHARED_LOCAL_HOST, a real second origin, so there is no fallback path
  // and the visitor's session on localhost is untouched.
  await firestore()
    .collection('items')
    .doc('e2e-foreign-init')
    .set({
      user: 'crawl_e2e',
      time: Date.now(),
      text: [
        '#e2e_trap #_init a foreign item with init code',
        '```js_init',
        'function _init() { window.__FOREIGN_RAN = (window.__FOREIGN_RAN ?? 0) + 1 }',
        '```',
      ].join('\n'),
      attr: { shared: { keys: ['trap'], indices: { trap: 0 } } },
    })
  try {
    // RESIDUE FROM A BUILD THAT PREDATES THE PER-KEY RULES, seeded before any app code runs. the
    // per-key rules stop new writes but cannot reach what is already there, so the boundary is a
    // wholesale scrub at startup (see +page.js). guarded by hostname: only the isolated origin
    await page.addInitScript(host => {
      if (location.hostname != host) return
      localStorage.setItem('mindpage_secret', 'residue-from-a-previous-owner')
      localStorage.setItem('mindpage_github_token', 'ghp_residue')
      localStorage.setItem('mindpage_item_store_abc', '{"leaked":true}')
      localStorage.setItem('mindpage_narrating', '{"deviceId":"leaked-camera"}')
      sessionStorage.setItem('mindpage_signin_pending', '1')
    }, SHARED_LOCAL_HOST)

    await withSecret(page)
    // no waitForApp: loadUser already proves the signed-in uid, and this page is navigated away
    // from immediately — only persisted auth and secret matter here (round 35)
    await loadUser(page, ALICE)
    expect(await page.evaluate(() => localStorage.getItem('mindpage_secret'))).toBeTruthy()

    await page.goto('/?shared=crawl_e2e/trap')
    // THE EXACT ORIGIN, not merely "somewhere else": a different port would not isolate, since
    // cookies are not port-scoped
    await expect
      .poll(() => page.evaluate(() => location.origin), { timeout: 60_000 })
      .toBe(`http://${SHARED_LOCAL_HOST}:${lanePort()}`)
    expect(new URL(page.url()).search).toBe('?shared=crawl_e2e/trap') // the url survives the move

    // ... and the page works normally for the anonymous visitor it is, running the owner's code
    const notice = page.locator('.modal .button', { hasText: 'View Shared Page' })
    if (await notice.isVisible({ timeout: 30_000 }).catch(() => false)) await notice.click()
    await expect(page.getByText('a foreign item with init code')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => page.evaluate(() => (window as any).__FOREIGN_RAN ?? null), { timeout: 60_000 }).toBe(1)

    // the seeded residue is gone, so the next owner's code cannot read what the last one left
    expect(
      await page.evaluate(() => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
      }))
    ).toEqual({ local: [], session: [] })
    expect(await page.evaluate(() => window._shared_origin), 'isolated shared origin exposes _shared_origin = true').toBe(true)

    // and NOTHING was taken from the visitor: their session lives on the origin they were on
    const own = await page.context().newPage()
    try {
      await own.goto('/')
      // NO waitForApp here: this asserts the visitor's ORIGIN still holds their session, which the
      // signed-in uid and the stored secret prove. waiting for every item to render (the overlay,
      // then __rendered in chunks) would cost the whole initial render for nothing
      await expect.poll(() => own.evaluate(() => window._user?.uid ?? null), { timeout: 90_000 }).toBe(ALICE.uid)
      expect(await own.evaluate(() => localStorage.getItem('mindpage_secret'))).toBeTruthy()
      expect(await own.evaluate(() => window._shared_origin), 'account origin exposes _shared_origin = false').toBe(false)
    } finally {
      await own.close()
    }
  } finally {
    await firestore().collection('items').doc('e2e-foreign-init').delete()
  }
})

test('a corrupted visible document can still be removed remotely (removal applies by id)', async ({ page }) => {
  // a removed record whose decrypt fails must still apply: removal is id-driven, so the
  // fabricated placeholder must not break text-dependent paths (round 8: the logging expression
  // threw on the missing text and the visible removal never ran, leaving the item forever)
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  await page.evaluate(() => void window._create('#e2e_corrupt_removed to be corrupted'))
  await expect.poll(() => savedId(page, '#e2e_corrupt_removed'), { timeout: 30_000 }).toBeTruthy()
  const id = await savedId(page, '#e2e_corrupt_removed')
  // corrupt the document server-side (its later change events cannot decrypt), then delete it.
  // CAUSAL, not a fixed sleep: the skip is what the removal below has to follow, and the app logs
  // it — a timer only guessed how long the corrupt modify would take to arrive
  const skipped = page.waitForEvent('console', {
    predicate: m => m.text().includes('could not apply remote change') && m.text().includes(id!),
    timeout: 60_000,
  })
  await firestore().collection('items').doc(id!).update({ cipher: 'not decryptable', text: null, attr: null })
  await skipped
  await firestore().collection('items').doc(id!).delete()
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_corrupt_removed', true)?.id ?? null), { timeout: 30_000 })
    .toBeNull()
})

test('global-store updates and deletions reach a second tab of the same account', async ({ page }) => {
  // hidden documents cross tabs through the shared persistent cache, so their changes arrive
  // with hasPendingWrites set: classification must be by exact payload identity — a pending
  // REMOVAL was misclassified as the receiving tab's own (wrapper present, matching content)
  // and the metadata-only acknowledgement never replayed it, leaving the store alive there
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  const other = await page.context().newPage() // same context: shared auth, secret and cache
  try {
    await other.goto('/')
    await waitForApp(other)
    await page.evaluate(() => void window._create('#e2e_xstore store owner'))
    await expect.poll(() => savedId(page, '#e2e_xstore'), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => savedId(other, '#e2e_xstore'), { timeout: 30_000 }).toBeTruthy()
    await page.evaluate(() => void (window._item('#e2e_xstore')!.global_store._xtab = 1))
    // polls read the non-saving _global_store accessor: reading .global_store dispatches a
    // sync-save, and a poll on the receiving tab would re-persist its stale copy against the
    // deletion below (resurrecting the store it is waiting to see die)
    await expect
      .poll(() => other.evaluate(() => (window._item('#e2e_xstore') as any)._global_store._xtab ?? null), {
        timeout: 30_000,
      })
      .toBe(1)
    await page.evaluate(() => void delete window._item('#e2e_xstore')!.global_store._xtab)
    await expect
      .poll(() => other.evaluate(() => (window._item('#e2e_xstore') as any)._global_store._xtab ?? null), {
        timeout: 30_000,
      })
      .toBeNull()

    // THE OLD-SIDE EFFECT of a hidden-to-visible transition (rounds 65-66): when a global_store
    // document becomes an ordinary visible item, the owner's store must be updated through the
    // REAL reducer — a bare index removal leaves it stale. round 66: the earlier version picked
    // an arbitrary hidden document with `.find(d => d.id)` before the value was even saved, and
    // an `if (storeDoc)` let it pass vacuously. the exact wrapper is identified by DECRYPTING
    await page.evaluate(() => void (window._item('#e2e_xstore')!.global_store._old = 7))
    await expect
      .poll(() => other.evaluate(() => (window._item('#e2e_xstore') as any)._global_store._old ?? null), {
        timeout: 30_000,
      })
      .toBe(7)
    const ownerId = await savedId(page, '#e2e_xstore')
    // the SERVER must hold `_old = 7` before the overwrite below: the other tab sees the value
    // through the shared persistent cache with the write still pending, and the store document
    // already exists from the `_xtab` phases, so finding it by name proves nothing about this
    // update — an overwrite racing the pending client update could land first and be undone by
    // it (the one-in-two full-gate failure of 2026-09-04). ONE query/decrypt pass per poll,
    // recovering the id from the same pass that proved the value
    let storeDocId: string | null = null
    await expect
      .poll(
        async () => {
          const found = await findStore(`global_store_${ownerId}`)
          storeDocId = found?.id ?? null
          return found?.item?._old ?? null
        },
        { timeout: 30_000 }
      )
      .toBe(7)
    // overwrite THAT id with visible content: the hidden side is dropped through the real
    // reducer, so the owner's store loses the value on BOTH tabs
    await firestore().collection('items').doc(storeDocId!).set({
      user: ALICE.uid,
      time: Date.now(),
      text: '#e2e_was_a_store now visible',
      attr: null,
    })
    await expect
      .poll(() => other.evaluate(() => (window._item('#e2e_xstore') as any)._global_store._old ?? null), {
        timeout: 30_000,
      })
      .toBeNull()
    await expect
      .poll(() => page.evaluate(() => (window._item('#e2e_xstore') as any)._global_store._old ?? null), {
        timeout: 30_000,
      })
      .toBeNull()
  } finally {
    await other.close()
  }
})

test('a corrupt hidden change revokes authority until healed, and invalid records are reported not deleted', async ({
  page,
}) => {
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  const authority = () => page.evaluate(() => (window as any).__hiddenAuthoritative)
  await expect.poll(authority, { timeout: 15_000 }).toBe(true)
  // an item with a global store: deleting the ITEM later (server-side) orphans the store
  await page.evaluate(() => void window._create('#e2e_orphan_owner store owner'))
  await expect.poll(() => savedId(page, '#e2e_orphan_owner'), { timeout: 30_000 }).toBeTruthy()
  const ownerId = await savedId(page, '#e2e_orphan_owner')
  await page.evaluate(() => void (window._item('#e2e_orphan_owner')!.global_store._e2e = 1))
  // THIS store's own document id. earlier tests leave their stores behind, so an account-wide
  // count cannot say WHICH document survived — and this test is about exactly one of them
  let storeId: string | null = null
  await expect
    .poll(async () => (storeId = await findStoreDoc(`global_store_${ownerId}`)), { timeout: 30_000 })
    .not.toBeNull()
  // an undecryptable hidden change arrives: the revision fails to apply it, so authority is
  // revoked AND the id stays dirty — later confirmations must not re-grant past the gap.
  // this is the UNCHANGED application-failure path (a server candidate that blocks, not a
  // cached revision): it must keep its unconditional console WARNING under the edge-triggered
  // levels, matched by exact text so no other warning can satisfy the waiter (review 134 §2.1
  // — the changed ternary's warn arm has no browser schedule and is code-reviewed instead)
  const strippingRevocation = page.waitForEvent('console', {
    predicate: m =>
      m.text() == 'hidden-index authority revoked: hidden change for e2e-corrupt-hidden could not be applied' &&
      m.type() == 'warning',
    timeout: 30_000,
  })
  await firestore().collection('items').doc('e2e-corrupt-hidden').set({
    user: ALICE.uid,
    time: Date.now(),
    hidden: true,
    cipher: 'not decryptable',
  })
  await expect.poll(authority, { timeout: 30_000 }).toBe(false)
  await strippingRevocation
  // /_gc refuses without authority (review 129): the maintenance command must not classify from
  // an unusable index -- nothing is scanned, previewed, or deleted
  const gcRefusal = String(
    await page.evaluate(async () => await (window._create('/_gc', { command: true, return_alerts: true }) as any))
  )
  expect(gcRefusal, '/_gc refusal while unauthoritative').toContain('authority')
  expect(gcRefusal, '/_gc refusal reports the fail-closed result').toContain('nothing was deleted')
  // the classification pass REPORTS what it found, and a deletion would have followed that
  // report — so the report is the causal signal that "kept" can be distinguished from "not yet
  // deleted". armed BEFORE the delete that orphans the store
  const reported = page.waitForEvent('console', {
    predicate: m =>
      m.text().includes('invalid hidden record(s) reported and quarantined') && m.text().includes(storeId!),
    timeout: 90_000,
  })
  // the owner item is deleted server-side while unauthoritative: its store is now orphaned
  await firestore().collection('items').doc(ownerId!).delete()
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_orphan_owner', true)?.id ?? null), { timeout: 30_000 })
    .toBeNull()
  // removing the corrupt document heals its block (removal applies by plaintext hidden + id, no
  // decrypt needed) and the same authoritative revision re-grants; the grant recomputes invalidity
  // from CURRENT state
  // ... but FIRST, the admission-overlap branch, while the block is STILL RETAINED (round 66: an
  // earlier version deleted the corrupt document first, which healed and PRUNED the block — so
  // hasOutstanding(id) was already false and the visible write took the ordinary blind route,
  // proving nothing). a visible document written to that id is admitted by hasOutstanding alone,
  // and its full transition must both install the visible row and heal the retained block
  await firestore().collection('items').doc('e2e-corrupt-hidden').set({
    user: ALICE.uid,
    time: Date.now(),
    text: '#e2e_healed_visible now an ordinary item',
    attr: null,
  })
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_healed_visible', true)?.id ?? null), { timeout: 30_000 })
    .not.toBeNull()
  await expect.poll(authority, { timeout: 30_000 }).toBe(true)

  // THE FAIL-CLOSED LOCAL-INTENT BOUNDARY, on the same loaded page and the same id. an admitted
  // transition may not defer: ordinary deferral is owned by reconciliation, which holds no
  // coordinator handle and could never heal the delivery. so it REJECTS, and a later admitted
  // delivery performs the complete repair once intent has cleared.
  // the barrier is the exact Apply error, not `authority == false`: opening the handle makes the
  // gate pending immediately, so an authority poll can finish before the Apply even runs (round
  // 67). and the payload is a SAVED-ITEM ENVELOPE — encrypting the wrapper directly leaves
  // decrypted.text undefined, so parseHiddenWrapper fails and the record blocks long before the
  // local-intent check
  await page.evaluate(() => {
    const raw = (window.__items as any[]).find(i => i.name == '#e2e_healed_visible')
    raw.saveTask = new Promise(() => {}) // never settles: hasLocalIntent is now true
  })
  const { encryptWithSecret } = await import('../../src/crypto.js')
  const envelope = JSON.stringify({
    hidden: true,
    attr: null,
    text: JSON.stringify({ name: 'e2e_intent_hidden', item: { held: 1 } }),
  })
  const intentError = page.waitForEvent('console', {
    predicate: m => m.text().includes('e2e-corrupt-hidden') && m.text().includes('local intent held'),
    timeout: 30_000,
  })
  await firestore()
    .collection('items')
    .doc('e2e-corrupt-hidden')
    .set({
      user: ALICE.uid,
      time: Date.now(),
      hidden: true,
      attr: null,
      text: null,
      cipher: await encryptWithSecret(envelope, secretFor(ALICE, PHRASE)),
    })
  await intentError // the Apply reached hasLocalIntent and refused
  expect(
    await page.evaluate(() => window._item('#e2e_healed_visible', true)?.text ?? null),
    'the visible representation is untouched: no half transition'
  ).toContain('ordinary item')
  // clear the intent and deliver a visible revision for that id: the retained block admits it and
  // the complete repair runs
  await page.evaluate(() => {
    const raw = (window.__items as any[]).find(i => i.name == '#e2e_healed_visible')
    raw.saveTask = null
  })
  await firestore().collection('items').doc('e2e-corrupt-hidden').set({
    user: ALICE.uid,
    time: Date.now(),
    text: '#e2e_healed_visible repaired text',
    attr: null,
  })
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_healed_visible', true)?.text ?? null), { timeout: 30_000 })
    .toContain('repaired text')
  await expect.poll(authority, { timeout: 30_000 }).toBe(true)
  // removing it heals nothing further (already healed) and leaves the orphan accounting below
  await firestore().collection('items').doc('e2e-corrupt-hidden').delete()
  await expect.poll(authority, { timeout: 30_000 }).toBe(true)
  // the now-orphaned store is REPORTED and quarantined, not deleted: a classification describes
  // one moment while the delete it used to queue landed later, after another client could have
  // renamed or updated that very document into a valid record. nothing is destroyed from a
  // render-time client any more (see reportInvalidHiddenCandidates)
  await reported
  expect((await firestore().collection('items').doc(storeId!).get()).exists, 'the reported orphan is KEPT').toBe(true)
})

// NOTE this test used to SIGN IN on the shared page itself. That route no longer exists: a
// signed-out visit to any shared page is redirected to the isolated origin (see
// sharedOriginRedirect), and sign-in there deliberately opens the account domain in a NEW TAB
// rather than authenticating in place, since the isolated origin is not an authorized auth domain.
// It kept passing only because local hosts were exempt from that redirect. The phrase validation it
// incidentally covered is covered directly by 'a new device must enter the phrase' above; what is
// unique here, and still reachable, is what a shared-page SAVE does to the account's hidden store
test("a save from the owner's own shared page updates its store rather than duplicating it", async ({ page }) => {
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  await page.evaluate(() => window._item('#e2e_shared')!.share('e2e-key', 0))
  await expect
    .poll(() => stored(page, '#e2e_shared'), { timeout: 30_000 })
    .toMatchObject({
      attr: { shared: { keys: ['e2e-key'] } },
    })
  // a pre-existing store (saved from the main page): the shared-page saves below must update this
  // document, not duplicate it, even when the save itself triggers the phrase prompt
  const hiddenCount = async () =>
    (await firestore().collection('items').where('user', '==', ALICE.uid).where('hidden', '==', true).get()).size
  // counts are RELATIVE to what the account already holds: invalid records are reported and
  // quarantined rather than deleted (see reportInvalidHiddenCandidates), so earlier tests leave
  // their stores behind. what this test is about is that the shared-page saves below UPDATE this
  // store rather than duplicating it
  const hiddenBefore = await hiddenCount()
  await page.evaluate(() => void (window._item('#e2e_shared')!.global_store._e2e_pre = 1))
  await expect.poll(hiddenCount, { timeout: 30_000 }).toBe(hiddenBefore + 1)
  const hiddenExpected = hiddenBefore + 1
  await page.evaluate(() => void window._create('/_signout', { command: true }))
  await expect(page.getByText('Stay Anonymous', { exact: true })).toBeVisible({ timeout: 60_000 })
  // reach the state the save is about: signed in as the OWNER (so the shared page stays on this
  // origin), on their own shared page, with NO stored secret — so the save itself raises the prompt
  const saveFromOwnSharedPage = async () => {
    await withSecret(page)
    // no waitForApp: loadUser already waits for the reloaded app's init and expected uid, and this
    // page is navigated away from immediately — only persisted auth and secret matter (round 35)
    await loadUser(page, ALICE)
    await page.evaluate(() => localStorage.removeItem('mindpage_secret')) // a device without it
    await page.goto(`/?shared=${ALICE.uid}/e2e-key`)
    await page.getByText('View Shared Page', { exact: true }).click({ timeout: 60_000 }) // fixed-page welcome
    await waitForApp(page)
    // an encrypted save (item code saving global state, as the production #sharer item does)
    // prompts for the existing phrase, never a new one, validated against the account's ciphertext
    await page.evaluate(() => void (window._item('#e2e_shared')!.global_store._e2e_probe = Date.now()))
    await expect(page.getByText(/Enter your secret phrase/)).toBeVisible({ timeout: 60_000 })
    expect(await page.getByText(/Choose a .*secret phrase/).count()).toBe(0)
  }
  await saveFromOwnSharedPage()
  // a wrong phrase is rejected and re-prompted instead of encrypting under the wrong key
  await page.fill('#modal-input', 'wrong phrase')
  await page.locator('.modal .button.confirm', { hasText: 'Continue' }).click()
  await expect(page.getByText(/appears incorrect/)).toBeVisible({ timeout: 60_000 })
  await page.locator('.modal .button.confirm', { hasText: 'Try Again' }).click()
  await expect(page.getByText(/Enter your secret phrase/)).toBeVisible({ timeout: 60_000 })
  // cancelling signs out instead of re-prompting forever
  await page.locator('.modal .button.cancel', { hasText: 'Sign Out' }).click()
  await expect(page.getByText(/Welcome to MindPage/)).toBeVisible({ timeout: 60_000 }) // shared page, signed out
  // the correct phrase validates against the account's ciphertext
  await saveFromOwnSharedPage()
  await enterPhrase(page, /Enter your secret phrase/, PHRASE, 'Continue')
  await expect(page.getByText(/Enter your secret phrase/)).toBeHidden({ timeout: 60_000 }) // absent or in the closed modal's dom
  // POLLED, not read once: the modal closes when the phrase is accepted, but the secret is
  // published and stored only AFTER the fresh candidate-keyed hidden scan that follows it (see
  // getSecretPhrase) — a save that saw the secret before that scan registered could duplicate a
  // record. the ordering is the contract; the server round trip it costs is not a fixed delay
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mindpage_secret')), { timeout: 30_000 })
    .toBe(secretFor(ALICE, PHRASE))
  // decrypted contents of the account's hidden store documents (see src/crypto.ts)
  const storedHidden = async () => {
    const snap = await firestore().collection('items').where('user', '==', ALICE.uid).where('hidden', '==', true).get()
    const { decryptWithSecret } = await import('../../src/crypto.js')
    return Promise.all(snap.docs.map(d => decryptWithSecret(d.data().cipher, secretFor(ALICE, PHRASE))))
  }
  // the probe save updated the pre-existing store (adopted mid-save once the phrase validation
  // loaded the account's hidden items), not a duplicate
  await expect.poll(hiddenCount, { timeout: 30_000 }).toBe(hiddenExpected)
  // the adopted update must be PERSISTED (merged probe present in the document) before
  // navigating away: a navigation discards a write not yet handed to the sdk
  await expect
    .poll(async () => (await storedHidden()).some(text => text.includes('_e2e_probe')), { timeout: 30_000 })
    .toBe(true)
  // round-8 finding 6: adoption merged the PRE-EXISTING store into the wrapper AND synced the
  // owner item's in-memory store. the owner saves fresh full-state clones, so without the sync
  // the next save from this same session would erase the adopted fields on the server
  expect(await page.evaluate(() => window._item('#e2e_shared')!.global_store._e2e_pre ?? null)).toBe(1)
  await page.evaluate(() => void (window._item('#e2e_shared')!.global_store._e2e_probe3 = 1))
  await expect
    .poll(async () => (await storedHidden()).some(text => text.includes('_e2e_probe3') && text.includes('_e2e_pre')), {
      timeout: 30_000,
    })
    .toBe(true)
  await page.goto('/')
  await waitForApp(page)
  expect(await page.locator('#modal-input').count()).toBe(0) // no phrase prompt on the main page
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_private', true)?.text ?? null))
    .toContain('secret text 12345')
  // revisit the shared page (with the stored secret now) and save again: still one store
  await page.goto(`/?shared=${ALICE.uid}/e2e-key`)
  await page.getByText('View Shared Page', { exact: true }).click({ timeout: 60_000 })
  await waitForApp(page)
  await page.evaluate(() => void (window._item('#e2e_shared')!.global_store._e2e_probe2 = Date.now()))
  // no fixed wait: both assertions below already poll for the save to land
  await expect.poll(hiddenCount, { timeout: 30_000 }).toBe(hiddenExpected)
  await expect
    .poll(async () => (await storedHidden()).some(text => text.includes('_e2e_probe2')), { timeout: 30_000 })
    .toBe(true)
  await page.goto('/')
  await waitForApp(page)
  await page.evaluate(() => window._item('#e2e_shared')!.unshare('e2e-key')) // restore for later tests
  await expect.poll(() => stored(page, '#e2e_shared'), { timeout: 30_000 }).toMatchObject({ text: null })
  // both probes survived in the single store (nothing was lost to duplicate cleanup)
  expect(
    await page.evaluate(() =>
      Object.keys(window._item('#e2e_shared')!.global_store)
        .filter(k => k.startsWith('_e2e'))
        .sort()
    )
  ).toEqual(['_e2e_pre', '_e2e_probe', '_e2e_probe2', '_e2e_probe3']) // nothing lost across the shared-page saves
})

test('signing out clears legacy session cookies at every scope, not just the root', async ({ page, context }) => {
  // round-17 finding 7: old builds wrote __session with no Path, so it landed at the directory
  // of whatever scoped page set it (/2/, /f/, ...) — carrying a full firebase ID token. a root
  // clear cannot remove those, and a test that reads document.cookie from / cannot even SEE
  // them, so the previous assertion passed while the credentials remained
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  const origin = new URL(page.url()).origin
  // seed cookies exactly as old builds left them: a token value, at scoped paths, both spellings
  // NOTE: domain+path explicitly — deriving from a url takes the DIRECTORY of that url, so
  // several seeds would collapse onto '/' and the test would prove nothing
  const domain = new URL(origin).hostname
  const legacy = ['/2', '/2/', '/2f/', '/f/', '/b/']
  await context.addCookies(
    legacy.map(path => ({ name: '__session', value: 'eyJhbGciOiJSUzI1NiJ9.legacy.token', domain, path }))
  )
  // NOTE: cookies() with a URL returns only what would be SENT to that url — scoped cookies are
  // invisible from '/', which is exactly why the previous assertion could not see them
  const sessionCookies = async () => (await context.cookies()).filter(c => c.name == '__session')
  expect((await sessionCookies()).length, 'seeded at several scopes').toBeGreaterThan(1)
  await page.evaluate(() => void window._create('/_signout', { command: true }))
  await expect(page.getByText('Stay Anonymous', { exact: true })).toBeVisible({ timeout: 60_000 })
  // inspected across the whole context, not through one document: nothing may survive
  const remaining = await sessionCookies()
  expect(remaining, `left behind: ${JSON.stringify(remaining.map(c => c.path))}`).toEqual([])
})

test('signing out clears the secret, the session and the local cache', async ({ page }) => {
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  expect(await page.evaluate(() => window._items().length)).toBeGreaterThan(1)
  await page.evaluate(() => void window._create('/_signout', { command: true }))
  await expect(page.getByText('Stay Anonymous', { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(
    await page.evaluate(() => [localStorage.getItem('mindpage_secret'), localStorage.getItem('mindpage_user')])
  ).toEqual([null, null])
  // the marker must be GONE after sign-out, not merely free of a token: a stale `__session=1`
  // keeps suppressing anonymous server rendering for signed-out requests
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/__session=[^;]/)
  // the firestore cache of the account was deleted (a fresh one is created for the anonymous account)
  await page.getByText('Stay Anonymous', { exact: true }).click()
  await waitForApp(page)
  expect(await page.evaluate(() => window._items().some(item => item.name == '#e2e_private'))).toBe(false)
})

test('MIXED CORPUS: seeded v1 text, bytes and hidden state open through the application beside v0', async ({ page }) => {
  // the stage-2 deployability row (KDF design): the production application opens frozen v0 AND v1
  // — visible text, bytes, and a hidden global store — in ONE session with ZERO Argon cost: the
  // v1 key arrives via a seeded persisted envelope, the profile via seeded users/{uid} metadata,
  // and the reader runs at its production DEFAULT (absent flag). writes remain v0 throughout (the writer switch
  // is stage 3). SELF-CONTAINED (review 85 §3): every fixture is seeded here — v0 included — and
  // encrypted at seed time with the same frozen primitives the unit fixtures pin, so a focused
  // run needs no serial predecessor
  const SALT = 'BwcHBwcHBwcHBwcHBwcHBw=='
  const KEY_BYTES = new Uint8Array(32).map((_, i) => 64 + i)
  const KEY_B64 = 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=' // KEY_BYTES, canonical base64
  const { encryptWithSecret, encryptV1Text, encryptV1Bytes, importV1Key } = await import('../../src/crypto.js')
  const v1key = await importV1Key(KEY_BYTES)
  const BYTES_PLAINTEXT = 'v1 bytes plaintext 424242'
  // ALL FIXED IDS, all seeded before the one login (review 86 §4): the hidden store names its
  // visible owner by the owner's DOCUMENT id, so seeding both makes the v1 hidden adoption
  // observable on the initial load — no UI save, no poll for a generated id, no reload
  const seededDocs = ['e2e-v0-item', 'e2e-v1-item', 'e2e-v1-owner', 'e2e-v1-store']
  await firestore()
    .collection('users')
    .doc(ALICE.uid)
    .set({ kdf: { v: 1, salt: SALT } }, { merge: true })
  await firestore()
    .collection('items')
    .doc('e2e-v0-item')
    .set({
      user: ALICE.uid,
      time: Date.now(),
      hidden: false,
      text: null,
      attr: null,
      cipher: await encryptWithSecret(
        JSON.stringify({ text: '#e2e_v0item v0 fixture text 67890', attr: null }),
        secretFor(ALICE, PHRASE)
      ),
    })
  await firestore()
    .collection('items')
    .doc('e2e-v1-item')
    .set({
      user: ALICE.uid,
      time: Date.now(),
      hidden: false,
      text: null,
      attr: null,
      cipher: await encryptV1Text(JSON.stringify({ text: '#e2e_v1item decrypted-from-v1 xyz789', attr: null }), v1key),
    })
  // the visible OWNER of the hidden store (v0-encrypted, like the app would have written it)...
  await firestore()
    .collection('items')
    .doc('e2e-v1-owner')
    .set({
      user: ALICE.uid,
      time: Date.now(),
      hidden: false,
      text: null,
      attr: null,
      cipher: await encryptWithSecret(
        JSON.stringify({ text: '#e2e_v1store store owner', attr: null }),
        secretFor(ALICE, PHRASE)
      ),
    })
  // ...and its global store, seeded as V1 ciphertext: initialization must decrypt it through the
  // session and expose the value on the owner (hidden state is an encrypted consumer too)
  await firestore()
    .collection('items')
    .doc('e2e-v1-store')
    .set({
      user: ALICE.uid,
      time: Date.now(),
      hidden: true,
      text: null,
      attr: null,
      cipher: await encryptV1Text(
        JSON.stringify({
          text: JSON.stringify({ name: 'global_store_e2e-v1-owner', item: { marker: 'v1-hidden' } }),
          attr: null,
        }),
        v1key
      ),
    })
  try {
    await withSecret(page)
    await page.evaluate(
      ([uid, salt, key, v0]) => {
        // DELIBERATE: the flag is cleared, not set — this mixed corpus opens under the
        // PRODUCTION DEFAULT (absent = reader enabled; withSecret seeds legacy 'off')
        localStorage.removeItem('mindpage_kdf')
        // the envelope is BOUND to the v0 secret its establishment produced (review 88 §2.1):
        // the session restores only the complete matched pair
        localStorage.setItem('mindpage_key1', JSON.stringify({ uid, v: 1, salt, key, v0 }))
      },
      [ALICE.uid, SALT, KEY_B64, secretFor(ALICE, PHRASE)]
    )
    expect(await page.evaluate(() => localStorage.getItem('mindpage_kdf')), 'absent reader flag').toBeNull()
    await loadUser(page, ALICE)
    await waitForApp(page)
    // the v1 item decrypted through decryptItem -> the session single-flight -> decryptV1Text
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_v1item', true)?.text ?? null), { timeout: 30_000 })
      .toContain('decrypted-from-v1 xyz789')
    // and the v0 corpus opens beside it (the frozen reader; same session, same secret)
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_v0item', true)?.text ?? null))
      .toContain('v0 fixture text 67890')
    // the reader session is observably READY (the rollout checklist reads this same hook)
    expect(await page.evaluate(() => (window as any).__kdfReady)).toBe(true)
    // v1 BYTES through the application's own wrapper (window._decrypt_bytes — review 85 §3): the
    // same session key, the bytes AAD domain, no Storage emulator and no Argon
    const cipherBytes = Array.from(await encryptV1Bytes(new TextEncoder().encode(BYTES_PLAINTEXT), v1key))
    const decryptedBytes: number[] = await page.evaluate(
      async arr => Array.from(await window._decrypt_bytes(new Uint8Array(arr))),
      cipherBytes
    )
    expect(new TextDecoder().decode(new Uint8Array(decryptedBytes))).toBe(BYTES_PLAINTEXT)
    // v1 HIDDEN adoption, same initial load: the seeded v1 store document was decrypted through
    // the session during initialization and its value reached the seeded owner
    await expect
      .poll(() => page.evaluate(() => (window._item('#e2e_v1store') as any)?._global_store?.marker ?? null), {
        timeout: 30_000,
      })
      .toBe('v1-hidden')
    // no upgrade prompt appeared anywhere in this session: the envelope satisfied every path
    expect(await page.getByText(/upgrade the encryption/).count()).toBe(0)
  } finally {
    for (const id of seededDocs) await firestore().collection('items').doc(id).delete()
    // FieldValue.delete(), NOT `kdf: null` (review 85 §3): the field was originally ABSENT, and a
    // null residue is exactly the present-invalid state the decoder rejects. NOT swallowed — a
    // failed cleanup here must fail the row rather than silently poison the next one (review 86)
    await firestore().collection('users').doc(ALICE.uid).update({ kdf: FieldValue.delete() })
    await page.evaluate(() => {
      localStorage.removeItem('mindpage_kdf')
      localStorage.removeItem('mindpage_key1')
    })
  }
})

test('ALL-V0 TRIGGER: the reader default prompts a returning device once at sign-in; declining stays v0 and cheap', async ({
  page,
}) => {
  // review 85 §2.1: an all-v0 account never decrypts a v1 cipher, so the upgrade must be driven
  // by the post-auth reader trigger — this row proves profile provisioning (a REAL transaction
  // through the app) and the prompt, then DECLINES: no derivation runs (no envelope appears), and
  // the session stays fully usable on v0
  await firestore()
    .collection('items')
    .doc('e2e-v0-trigger')
    .set({
      user: ALICE.uid,
      time: Date.now(),
      hidden: false,
      text: null,
      attr: null,
      cipher: await (async () => {
        const { encryptWithSecret } = await import('../../src/crypto.js')
        return encryptWithSecret(
          JSON.stringify({ text: '#e2e_v0trigger still readable 13579', attr: null }),
          secretFor(ALICE, PHRASE)
        )
      })(),
    })
  // PRECONDITION established here, not assumed from the previous row's cleanup (review 86 §4):
  // the profile must be ABSENT, or the row would silently prove adoption instead of provisioning
  await firestore()
    .collection('users')
    .doc(ALICE.uid)
    .update({ kdf: FieldValue.delete() })
    .catch(() => {}) // the document or field may not exist yet — absence is what matters
  expect((await firestore().collection('users').doc(ALICE.uid).get()).data()?.kdf, 'absent profile').toBeUndefined()
  try {
    await withSecret(page)
    // DELIBERATE: absent flag — the trigger must fire under the PRODUCTION DEFAULT (absent =
    // reader enabled), not an explicit opt-in
    await page.evaluate(() => localStorage.removeItem('mindpage_kdf'))
    expect(await page.evaluate(() => localStorage.getItem('mindpage_kdf')), 'absent reader flag').toBeNull()
    await loadUser(page, ALICE)
    // the trigger runs off the confirmed principal: profile provisions (absent -> candidate) and
    // the one-time upgrade prompt appears WITHOUT any v1 ciphertext in the account
    await expect(page.getByText(/upgrade the encryption/)).toBeVisible({ timeout: 60_000 })
    await page.locator('.modal .button.cancel', { hasText: 'Not Now' }).click()
    await waitForApp(page)
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_v0trigger', true)?.text ?? null), { timeout: 30_000 })
      .toContain('still readable 13579')
    // declined: nothing derived, nothing persisted, not reader-ready — and v0 unaffected
    expect(await page.evaluate(() => [localStorage.getItem('mindpage_key1'), (window as any).__kdfReady])).toEqual([
      null,
      false,
    ])
    // provisioning DID commit a valid profile through the real transaction (the salt is public)
    const kdf = (await firestore().collection('users').doc(ALICE.uid).get()).data()?.kdf
    expect(kdf?.v).toBe(1)
    expect(kdf?.salt).toMatch(/^[A-Za-z0-9+/]{21}[AQgw]==$/)
  } finally {
    await firestore().collection('items').doc('e2e-v0-trigger').delete()
    await firestore().collection('users').doc(ALICE.uid).update({ kdf: FieldValue.delete() })
    await page.evaluate(() => localStorage.removeItem('mindpage_kdf'))
  }
})

test('STAGE 3 WRITER: real acquisition, lazy v1 text/bytes writes, coexistence, reload, refusal, rollback', async ({
  page,
}) => {
  // the combined stage-3 milestone (review 92 §6): one session covers the REAL correct-phrase
  // acquisition (production Argon2id, once), lazy per-save v1 upgrade for text, the production
  // bytes wrapper, old-writer v0 coexistence, auth reload, the observable no-silent-downgrade
  // refusal, and writer rollback with v1 data still readable
  test.setTimeout(240_000)
  const { encryptWithSecret, encryptV1Text, importV1Key } = await import('../../src/crypto.js')
  const seedV0 = async (id: string, text: string) =>
    firestore()
      .collection('items')
      .doc(id)
      .set({
        user: ALICE.uid,
        time: Date.now(),
        hidden: false,
        text: null,
        attr: null,
        cipher: await encryptWithSecret(JSON.stringify({ text, attr: null }), secretFor(ALICE, PHRASE)),
      })
  await seedV0('e2e-w-edit', '#e2e_w_edit original v0 text 111')
  await seedV0('e2e-w-keep', '#e2e_w_keep untouched v0 text 222')
  const seededDocs = ['e2e-w-edit', 'e2e-w-keep', 'e2e-w-old', 'e2e-w-v1seed']
  let createdItemId: string | null = null
  try {
    // A. REAL ACQUISITION: stored v0 secret, reader at the PRODUCTION DEFAULT (absent flag =
    // enabled), NO envelope — the sign-in trigger raises the one-time upgrade prompt, and the
    // entered phrase pays production Argon once
    await withSecret(page)
    await page.evaluate(() => {
      localStorage.removeItem('mindpage_kdf') // DELIBERATE: the default, not an opt-in
      localStorage.removeItem('mindpage_key1')
    })
    expect(await page.evaluate(() => localStorage.getItem('mindpage_kdf')), 'absent reader flag').toBeNull()
    await loadUser(page, ALICE)
    await enterPhrase(page, /upgrade the encryption/, PHRASE, 'Upgrade')
    await waitForApp(page)
    await expect.poll(() => page.evaluate(() => (window as any).__kdfReady), { timeout: 60_000 }).toBe(true)
    const envelope = await page.evaluate(() => JSON.parse(localStorage.getItem('mindpage_key1')!))
    expect(envelope.v0, 'the envelope is BOUND to the establishment').toBe(secretFor(ALICE, PHRASE))

    // B. the REAL derived key opens externally-produced v1: seed a v1 doc under the envelope key
    const realKey = await importV1Key(new Uint8Array([...atob(envelope.key)].map(c => c.charCodeAt(0))))
    await firestore()
      .collection('items')
      .doc('e2e-w-v1seed')
      .set({
        user: ALICE.uid,
        time: Date.now(),
        hidden: false,
        text: null,
        attr: null,
        cipher: await encryptV1Text(JSON.stringify({ text: '#e2e_w_v1seed external v1 333', attr: null }), realKey),
      })
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_w_v1seed', true)?.text ?? null), { timeout: 30_000 })
      .toContain('external v1 333')

    // B2. FRESH-KDF-STATE RECOVERY (the 2026-08-28 production incident, pinned): the
    // KDF-relevant state of a fresh origin/profile — NO stored secret, NO envelope, NEITHER
    // flag (same context/auth/cache otherwise) — opens this MIXED corpus under the reader
    // default — sign-in prompts once for the phrase, fail-closed
    // initialization completes across v0 AND v1, and the session is reader-ready. Before the
    // reader default, this exact state hard-locked the whole account ("Unable to access your
    // account"; `v1 ciphertext but no v1 key on this device (kdf disabled)`)
    expect(
      await page.evaluate(() => {
        localStorage.removeItem('mindpage_secret')
        localStorage.removeItem('mindpage_key1')
        localStorage.removeItem('mindpage_kdf')
        localStorage.removeItem('mindpage_kdf_write')
        // the four-part precondition IS the incident contract (review 107 §2.1): secret, bound
        // envelope and both flags must all be absent before the reload proves recovery
        return [
          localStorage.getItem('mindpage_secret'),
          localStorage.getItem('mindpage_key1'),
          localStorage.getItem('mindpage_kdf'),
          localStorage.getItem('mindpage_kdf_write'),
        ]
      }),
      'the fresh-KDF-state precondition: all four keys absent'
    ).toEqual([null, null, null, null])
    await page.reload()
    // the ENTRY prompt, not the upgrade prompt: a fresh origin holds no v0 secret at all (the
    // upgrade modal is for devices that have the secret but no v1 key)
    await enterPhrase(page, /Enter your secret phrase/, PHRASE, 'Continue')
    await waitForApp(page)
    await expect.poll(() => page.evaluate(() => (window as any).__kdfReady), { timeout: 60_000 }).toBe(true)
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_w_v1seed', true)?.text ?? null), { timeout: 30_000 })
      .toContain('external v1 333')
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_w_keep', true)?.text ?? null), { timeout: 30_000 })
      .toContain('untouched v0 text 222')

    // C. LAZY TEXT UPGRADE: writer on; ONE edit produces a v1 document; the untouched item stays v0
    await page.evaluate(() => localStorage.setItem('mindpage_kdf_write', 'on'))
    const before = (await firestore().collection('items').doc('e2e-w-edit').get()).data()!.cipher as string
    await page.evaluate(() => window._item('#e2e_w_edit')!.write('#e2e_w_edit lazily upgraded 444'))
    await expect
      .poll(async () => (await firestore().collection('items').doc('e2e-w-edit').get()).data()!.cipher, {
        timeout: 30_000,
      })
      .not.toBe(before)
    const upgraded = (await firestore().collection('items').doc('e2e-w-edit').get()).data()!.cipher as string
    expect(upgraded.startsWith('1!'), 'the edited item is v1').toBe(true)
    const kept = (await firestore().collection('items').doc('e2e-w-keep').get()).data()!.cipher as string
    expect(kept.startsWith('1!'), 'the untouched item keeps v0').toBe(false)
    // the HISTORY row of that update is CIPHERTEXT, not plaintext (review 93 §2.1: the in-place
    // decrypt used to strip the cipher before the history spread — every update since 2024
    // published plaintext history). POLLED: history enqueues after the primary acknowledgement
    // continuation, so the row may trail the cipher change (review 94 §2); cleanup is in finally
    await expect
      .poll(async () => (await firestore().collection('history').where('item', '==', 'e2e-w-edit').get()).size, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0)
    for (const h of (await firestore().collection('history').where('item', '==', 'e2e-w-edit').get()).docs) {
      const data = h.data()
      expect(data.text, 'NO plaintext in history').toBeNull()
      expect(typeof data.cipher, 'ciphertext present').toBe('string')
      expect((data.cipher as string).startsWith('1!'), 'the v1 payload, exactly as enqueued').toBe(true)
    }

    // C2. a REAL flag-on CREATE (review 94 §2): the item AND its history row are v1 ciphertext
    await page.evaluate(() => void window._create('#e2e_w_new created v1 999'))
    await expect.poll(() => savedId(page, '#e2e_w_new'), { timeout: 30_000 }).toBeTruthy()
    const createdId = (createdItemId = (await savedId(page, '#e2e_w_new'))!)
    const createdDoc = (await firestore().collection('items').doc(createdId).get()).data()!
    expect((createdDoc.cipher as string).startsWith('1!'), 'the created item is v1').toBe(true)
    expect(createdDoc.text, 'no plaintext on the created item').toBeNull()
    await expect
      .poll(async () => (await firestore().collection('history').where('item', '==', createdId).get()).size, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0)
    for (const h of (await firestore().collection('history').where('item', '==', createdId).get()).docs) {
      const data = h.data()
      expect(data.text, 'NO plaintext in the CREATE history').toBeNull()
      expect((data.cipher as string).startsWith('1!'), 'the fenced v1 create-history payload').toBe(true)
    }

    // D. BYTES through the production wrapper: the v1 bytes frame tag is ~1!
    const firstBytes: number[] = await page.evaluate(async () =>
      Array.from((await (window as any)._encrypt_bytes(new TextEncoder().encode('bytes 555'))).slice(0, 3))
    )
    expect(firstBytes, 'the ~1! v1 bytes tag').toEqual([126, 49, 33])

    // E. OLD-WRITER COEXISTENCE: a phase-1 device adds v0 beside v1; both open
    await seedV0('e2e-w-old', '#e2e_w_old old writer v0 666')
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_w_old', true)?.text ?? null), { timeout: 30_000 })
      .toContain('old writer v0 666')

    // F. AUTH RELOAD: the bound envelope restores silently; no prompt; everything still opens
    await page.reload()
    await waitForApp(page)
    expect(await page.getByText(/upgrade the encryption/).count()).toBe(0)
    expect(await page.evaluate(() => (window as any).__kdfReady)).toBe(true)
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_w_v1seed', true)?.text ?? null), { timeout: 30_000 })
      .toContain('external v1 333')
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_w_edit', true)?.text ?? null))
      .toContain('lazily upgraded 444')
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_w_old', true)?.text ?? null), { timeout: 30_000 })
      .toContain('old writer v0 666')

    // G. OBSERVABLE REFUSAL, never a silent v0 downgrade: with the writer flag on but the reader
    // EXPLICITLY 'off' (the emergency override — under the reader default, absence means ON, so
    // only the exact override can produce this misconfiguration), an encrypted write FAILS with
    // the session's reason
    await page.evaluate(() => localStorage.setItem('mindpage_kdf', 'off'))
    const refusal = await page.evaluate(async () => {
      try {
        await (window as any)._encrypt('refused 777')
        return 'no error'
      } catch (e) {
        return (e as Error).message
      }
    })
    expect(refusal).toContain('v1 keys unavailable (kdf disabled)')
    // and a REAL item save under the same misconfiguration fails without touching the stored
    // document (review 93 §5): zero durable writes, and the item's saving state settles
    const cipherBeforeRefusal = (await firestore().collection('items').doc('e2e-w-edit').get()).data()!
      .cipher as string
    await page.evaluate(() => window._item('#e2e_w_edit')!.write('refused write 779'))
    await expect
      .poll(() => page.evaluate(() => window.__items.every(i => !i.saving)), { timeout: 30_000 })
      .toBe(true)
    expect(
      (await firestore().collection('items').doc('e2e-w-edit').get()).data()!.cipher,
      'the stored cipher is untouched by the refused save'
    ).toBe(cipherBeforeRefusal)
    // G2. a REAL failed CREATE settles instead of wedging (reviews 94-95 §2): the queued save is
    // RETAINED and must REJECT through createFailed (queued while creation is unresolved — the
    // original forever-polling condition), the database must show ZERO new documents, and the
    // failure state binds to THE item
    const itemCountBefore = (await firestore().collection('items').where('user', '==', ALICE.uid).get()).size
    const queuedRejection = await page.evaluate(async () => {
      void window._create('#e2e_w_fail must fail 780')
      // BOUNDED wait (review 96): if the forever-polling wedge ever regresses, this fails in
      // ~10s with its own sentinel instead of consuming the row's whole timeout
      const timeout = new Promise<string>(resolve => setTimeout(() => resolve('TIMEOUT: save never settled'), 10_000))
      const save = (async () => {
        try {
          await (window._item('#e2e_w_fail') as any)!.save() // queued before any settlement wait
          return 'no rejection'
        } catch (e) {
          return (e as Error).message
        }
      })()
      return Promise.race([save, timeout])
    })
    expect(queuedRejection, 'the queued save rejects with the KDF-disabled cause').toContain(
      'v1 keys unavailable (kdf disabled)'
    )
    await expect(page.getByText(/Could not save new item/)).toBeVisible({ timeout: 30_000 })
    await page.evaluate(() => (window as any)._modal_close()) // a bare alert modal has no buttons
    await expect
      .poll(() => page.evaluate(() => window.__items.every(i => !i.saving)), { timeout: 30_000 })
      .toBe(true)
    expect(
      await page.evaluate(() => {
        // ONE item carries the whole failure state (review 95 §2.2: never splice a stale marker
        // from one item with another's text)
        const it = window.__items.find(i => i.labelText == '#e2e_w_fail') as any
        // the text comes from the SAME selected entry (review 96): one object carries the whole
        // failure state, so a stale marker cannot be spliced with another item's text
        return it ? { createFailed: !!it.createFailed, savedId: it.savedId ?? null, text: it.text ?? null } : null
      }),
      'createFailed recorded on THE item; no savedId; local text retained'
    ).toEqual({ createFailed: true, savedId: null, text: '#e2e_w_fail must fail 780' })
    // ZERO durable writes, asserted at the DATABASE (savedId is client state)
    expect(
      (await firestore().collection('items').where('user', '==', ALICE.uid).get()).size,
      'no document was created'
    ).toBe(itemCountBefore)
    await page.evaluate(() => window._item('#e2e_w_fail')!.delete(false)) // local-only cleanup
    // cleanup: remove the override, restoring the default-on CONFIGURATION for the rest of
    // the row (the absent default's behavior is observed by MIXED CORPUS and B2, not here)
    await page.evaluate(() => localStorage.removeItem('mindpage_kdf'))

    // H. ROLLBACK: writer off; a new edit returns to v0 while existing v1 stays readable
    await page.evaluate(() => localStorage.removeItem('mindpage_kdf_write'))
    await page.evaluate(() => window._item('#e2e_w_edit')!.write('#e2e_w_edit rolled back 888'))
    await expect
      .poll(async () => (await firestore().collection('items').doc('e2e-w-edit').get()).data()!.cipher, {
        timeout: 30_000,
      })
      .not.toBe(upgraded)
    const rolled = (await firestore().collection('items').doc('e2e-w-edit').get()).data()!.cipher as string
    expect(rolled.startsWith('1!'), 'rollback writes v0 again').toBe(false)
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_w_v1seed', true)?.text ?? null))
      .toContain('external v1 333')
    // let the rollback save FULLY settle (its history enqueues after the acknowledgement), so
    // the finally-cleanup's one-shot history queries cannot race a trailing append (review 95)
    await expect
      .poll(() => page.evaluate(() => window.__items.every(i => !i.saving)), { timeout: 30_000 })
      .toBe(true)
  } finally {
    for (const id of seededDocs)
      await firestore()
        .collection('items')
        .doc(id)
        .delete()
        .catch(() => {})
    // ALL history rows this row produced (update, create, and the rollback's v0 row) — in
    // finally, so an earlier failure cannot strand them for later rows (review 94 §2)
    for (const itemId of ['e2e-w-edit', ...(createdItemId ? [createdItemId] : [])]) {
      for (const h of (await firestore().collection('history').where('item', '==', itemId).get()).docs)
        await h.ref.delete().catch(() => {})
    }
    await page.evaluate(() => window._item('#e2e_w_new', true)?.delete(false)).catch(() => {})
    if (createdItemId)
      await firestore()
        .collection('items')
        .doc(createdItemId)
        .delete()
        .catch(() => {})
    await firestore().collection('users').doc(ALICE.uid).update({ kdf: FieldValue.delete() })
    await page.evaluate(() => {
      localStorage.removeItem('mindpage_kdf')
      localStorage.removeItem('mindpage_kdf_write')
      localStorage.removeItem('mindpage_key1')
    })
  }
})

test('/_gc deletes exactly the previewed orphans, and an owner restored mid-confirm survives', async ({ page }) => {
  // the explicit maintenance path (review 129; design notes/design/mind_page_hidden_gc.md in the
  // vault): two stores are orphaned server-side and take the STARTUP-invalid path via reload
  // (never indexed -- the class the live classifier cannot see), then /_gc previews both; one
  // owner is restored under its EXACT old id while the confirm modal is open, and execution must
  // delete only the still-orphaned store while the restored owner's store survives
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  const authority = () => page.evaluate(() => (window as any).__hiddenAuthoritative)
  await expect.poll(authority, { timeout: 15_000 }).toBe(true)
  // cleanup scope opens BEFORE the first fixture creation (review 130 §3): any failure from
  // here on runs the finally, so a half-created pair cannot poison a focused rerun
  let ownerA: string | null = null
  let ownerB: string | null = null
  let storeA: string | null = null
  let storeB: string | null = null
  try {
    await page.evaluate(() => {
      void window._create('#e2e_gc_a gc owner a')
      void window._create('#e2e_gc_b gc owner b')
    })
    await expect.poll(async () => (ownerA = await savedId(page, '#e2e_gc_a')), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(async () => (ownerB = await savedId(page, '#e2e_gc_b')), { timeout: 30_000 }).toBeTruthy()
    await page.evaluate(() => {
      void (window._item('#e2e_gc_a')!.global_store._gc = 'a')
      void (window._item('#e2e_gc_b')!.global_store._gc = 'b')
    })
    await expect
      .poll(async () => (storeA = await findStoreDoc(`global_store_${ownerA}`)), { timeout: 30_000 })
      .not.toBeNull()
    await expect
      .poll(async () => (storeB = await findStoreDoc(`global_store_${ownerB}`)), { timeout: 30_000 })
      .not.toBeNull()
    // capture owner A's full document so it can be restored under its EXACT old id
    const ownerDocA = (await firestore().collection('items').doc(ownerA!).get()).data()!
    await firestore().collection('items').doc(ownerA!).delete()
    await firestore().collection('items').doc(ownerB!).delete()
    // the reload starts from the persistent cache, so the fail-closed cached-revision
    // revocation fires during startup -- it must log at DEBUG, never as a warning: nothing
    // usable is stripped at startup (edge-triggered levels, owner-directed 2026-08-29)
    const cachedRevocations: string[] = []
    page.on('console', m => {
      if (m.text().includes('authority revoked: cached revision')) cachedRevocations.push(m.type())
    })
    await page.reload()
    await waitForApp(page)
    await isolateEmulatorWebChannelPosts(page)
    await expect.poll(authority, { timeout: 30_000 }).toBe(true)
    expect(cachedRevocations.length, 'cached first snapshot revoked at startup').toBeGreaterThan(0)
    expect(cachedRevocations.every(type => type == 'debug'), 'startup revocations are exactly debug').toBe(true)
    // /_gc: the preview must include BOTH of this row's orphans. the suite is STATEFUL --
    // earlier rows deliberately leave orphaned stores behind (report-only contract), so the
    // count is >= 2 and this run also sweeps that residue
    const result = page.evaluate(async () => await (window._create('/_gc', { command: true, return_alerts: true }) as any))
    // ALL locators scoped to .modal: the same ids also render in the on-page console feed
    const modal = page.locator('.modal')
    await expect(modal.getByText(/Permanently delete \d+ orphaned/)).toBeVisible({ timeout: 30_000 })
    await expect(modal.locator('p').filter({ hasText: storeA! }).first()).toBeVisible()
    await expect(modal.locator('p').filter({ hasText: storeB! }).first()).toBeVisible()
    // restore owner A while the modal is open; wait for it to arrive locally so the execute-time
    // recomputation sees it (owner existence is checked against local items)
    await firestore().collection('items').doc(ownerA!).set(ownerDocA)
    await expect
      .poll(() => page.evaluate(id => window.__items.some(item => item.savedId == id), ownerA), { timeout: 30_000 })
      .toBe(true)
    // make the command's precondition explicit rather than timing-dependent: authority must be
    // usable again (the restored owner's revision granted) before execution is authorized
    await expect.poll(authority, { timeout: 30_000 }).toBe(true)
    await modal.getByText('Delete', { exact: true }).click()
    // exactly ONE previewed target is dropped (the restored owner's store); everything else
    // previewed -- this row's victim plus any prior residue -- is deleted, with no failures
    const summary = String(await result)
    const split = summary.match(/deleted (\d+) of (\d+) previewed/)
    expect(split, `summary shape: ${summary}`).toBeTruthy()
    expect(+split![1], `summary split: ${summary}`).toBe(+split![2] - 1)
    // the restored owner is a PREVIEW-TIME skip and must be reported as such (review 130 §2.3)
    expect(summary, `revalidated partition: ${summary}`).toContain('skipped 1 revalidated')
    expect(summary, `no failures: ${summary}`).not.toContain('FAILED')
    // the victim reaches a durable 404 at the emulator; the survivor remains (Bearer owner is
    // the emulator admin bypass -- rules 403 unauthenticated REST, indistinguishable from present)
    const status = (id: string) =>
      fetch(`http://localhost:8080/v1/projects/${laneProjectId()}/databases/(default)/documents/items/${id}`, {
        headers: { Authorization: 'Bearer owner' },
      }).then(r => r.status)
    await expect.poll(() => status(storeB!), { message: 'victim store durably deleted', timeout: 30_000 }).toBe(404)
    expect(await status(storeA!), 'restored owner store survives').toBe(200)
  } finally {
    // best-effort residue cleanup on every exit, both pairs (reviews 130-132): ids not yet
    // captured are recovered from the fixed labels before deleting whatever exists
    ownerA ??= await savedId(page, '#e2e_gc_a').catch(() => null)
    ownerB ??= await savedId(page, '#e2e_gc_b').catch(() => null)
    if (ownerA && !storeA) storeA = await findStoreDoc(`global_store_${ownerA}`).catch(() => null)
    if (ownerB && !storeB) storeB = await findStoreDoc(`global_store_${ownerB}`).catch(() => null)
    for (const id of [ownerA, ownerB, storeA, storeB])
      if (id) await firestore().collection('items').doc(id).delete().catch(() => {})
  }
})

test('/device names this browser profile for the instances listing, in every open tab, at once and across a reload', async ({ page }) => {
  // the instance record's device_name (the #status item shows it in place of the public ip): set
  // with /device per browser profile (localStorage, shared by every tab of the origin), re-read at
  // every instance publication and republished at once by the issuing tab and, through the storage
  // event, by its sibling tabs (review 4 B1: a sibling's cached record must not keep the old
  // name); a reload keeps it; /device without a name clears it. The records are found in the
  // instances listing by each tab's init time (the listener includes the tab's own writes before
  // they sync); a missing record is reported, never read as a cleared name
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  const sibling = await page.context().newPage() // a second tab of the same profile, open BEFORE the naming
  try {
    await sibling.goto('/')
    await waitForApp(sibling)
    const siblingInit = await sibling.evaluate(() => window._init_time)
    const named = (init: number) =>
      page.evaluate(init => {
        const record = ((window as any)._instances as any[]).find(i => i.init_time === init)
        return record === undefined ? 'no record' : record.device_name
      }, init)
    const own = () => page.evaluate(() => window._init_time).then(named)
    const other = () => named(siblingInit)
    const device = (text: string) =>
      page.evaluate(async text => await (window._create(text, { command: true, return_alerts: true }) as any), text)
    await expect.poll(other, { message: 'the sibling publishes a nameless record', timeout: 30_000 }).toBeNull()
    expect(await device('/device e2e laptop'), 'the command returns no alert').toBeFalsy()
    expect(await page.evaluate(() => localStorage.getItem('mindpage_device_name'))).toBe('e2e laptop')
    await expect.poll(own, { message: 'the own record carries the name', timeout: 30_000 }).toBe('e2e laptop')
    await expect.poll(other, { message: 'the sibling republishes with the name (the storage event)', timeout: 30_000 }).toBe('e2e laptop')
    expect(await device('/device e2e desk'), 'a rename returns no alert').toBeFalsy()
    await expect.poll(own, { message: 'the own record renamed', timeout: 30_000 }).toBe('e2e desk')
    await expect.poll(other, { message: 'the sibling renamed', timeout: 30_000 }).toBe('e2e desk')
    await page.reload()
    await waitForApp(page)
    await expect.poll(own, { message: 'the name survives a reload', timeout: 30_000 }).toBe('e2e desk')
    expect(await device('/device'), 'clearing returns no alert').toBeFalsy()
    expect(await page.evaluate(() => localStorage.getItem('mindpage_device_name'))).toBeNull()
    await expect.poll(own, { message: 'the own record is republished without a name', timeout: 30_000 }).toBeNull()
    await expect.poll(other, { message: 'the sibling republishes without a name', timeout: 30_000 }).toBeNull()
  } finally {
    await sibling.close()
  }
})

// gives each tab's reporter of invalid hidden records one more run: a plaintext marker item is
// written behind the app (an arriving item requests the report), and each tab must show the
// marker and then have a usable index. that is ALL it shows: not that a tab applied any earlier
// change of the server (a second tab of a profile was seen with a removed store still held past
// its marker), so a row that needs a removal applied asserts that removal itself (tookIn below).
// resolves to the marker's document id, for the caller's cleanup
async function takenIn(tabs: Page[], label: string) {
  const marker = firestore().collection('items').doc()
  await marker.set({ user: ALICE.uid, time: Date.now(), text: `${label} marker`, attr: null })
  for (const tab of tabs) {
    await expect.poll(() => tab.evaluate(label => !!window._item(label, true), label), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => tab.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 30_000 }).toBe(true)
  }
  return marker.id
}

test('an item deleted in this tab takes its store with it, with no warning of the store here and no word of its removal in another client; a refused delete and an owed save leave the store, reported then; unusable authority only delays it, and a delayed cascade keeps to the record it saw', async ({ page, browser }) => {
  // deleteItem's store cascade (design notes/design/mind_page_hidden_gc.md §5 in the vault): once
  // the server has an item's delete, the tab deletes its global_store_<id> through /_gc's
  // exact-identity transaction. the store's name is in flight until that cascade has its last
  // word and the reporter leaves it out, so a store that goes with its item is never announced
  // and one that stays is reported then, the cascade giving its reason at debug (a refused
  // owner delete never cascades: its error is all that is logged before the report). each
  // phase holds every other condition true (a usable index, a settled store), so that the one
  // it names is all that stands between the delete and the store
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  await isolateEmulatorWebChannelPosts(page)
  const authority = () => page.evaluate(() => (window as any).__hiddenAuthoritative)
  const exists = async (id: string) => (await firestore().collection('items').doc(id).get()).exists
  const SINGLE = '#e2e_cascade_single'
  const TREE = '#e2e_cascade'
  const KIDS = [`${TREE}/a`, `${TREE}/b`]
  const REFUSED = '#e2e_cascade_refused'
  const OWED = '#e2e_cascade_owed'
  const BLIND = '#e2e_cascade_blind'
  const SWAPPED = '#e2e_cascade_swapped'
  const CORRUPT = 'e2e-cascade-corrupt'
  const labels = [SINGLE, TREE, ...KIDS, REFUSED, OWED, BLIND, SWAPPED]
  const owners: Record<string, string | null> = {}
  const stores: Record<string, string | null> = {}
  let replacement: string | null = null // the record written behind the app under SWAPPED's store name
  const name = (label: string) => `global_store_${owners[label]}`
  type Line = { type: string; text: string }
  const watch = (tab: Page) => {
    const log: Line[] = []
    tab.on('console', m => void log.push({ type: m.type(), text: m.text() }))
    return log
  }
  const lines = watch(page)
  // the reporter's warnings that name a label's store; what the cascade says of it, at debug;
  // the app's line for a removal a tab took in; the one warning that is the emulator's own
  const reports = (label: string) =>
    lines.filter(l => l.type == 'warning' && l.text.includes(`orphaned ${name(label)} (${stores[label]})`)).length
  const said = (label: string) =>
    lines.filter(l => l.type == 'debug' && l.text.startsWith(`hidden store ${name(label)} `)).map(l => l.text)
  const left = (label: string, why: string) => `hidden store ${name(label)} left for /_gc: ${why}`
  const deferred = (label: string, why: string) => `hidden store ${name(label)} deferred to the next authority grant: ${why}`
  const tookIn = (log: Line[], label: string) => log.some(l => l.type == 'debug' && l.text.includes(`removed hidden ${stores[label]}`))
  const CACHED = 'hidden-index authority revoked: cached revision'
  // a second client of the account for the first phase, with a cache and a connection of its
  // own. a second tab of THIS profile shares this tab's, and on the emulator it never took a
  // store's removal in: not within 30 s, and not with the server's next change either
  // (2026-11-17, twice), so it could witness nothing about that removal
  const elsewhere = await browser.newContext()
  const other = await elsewhere.newPage()
  const otherLines = watch(other)
  const markers: string[] = []
  try {
    await withSecret(other)
    await loadUser(other, ALICE)
    await waitForApp(other)
    await page.evaluate(labels => labels.forEach(label => void window._create(`${label} store owner`)), labels)
    for (const label of labels)
      await expect.poll(async () => (owners[label] = await savedId(page, label)), { timeout: 30_000 }).toBeTruthy()
    await page.evaluate(labels => labels.forEach(label => void (window._item(label)!.global_store._e2e = 1)), labels)
    for (const label of labels)
      await expect.poll(async () => (stores[label] = await findStoreDoc(name(label))), { timeout: 30_000 }).not.toBeNull()
    // the other client holds the first item's store too (read through the non-saving accessor)
    await expect
      .poll(() => other.evaluate(label => (window._item(label, true) as any)?._global_store?._e2e ?? null, SINGLE), {
        timeout: 30_000,
      })
      .toBe(1)
    await expect.poll(authority, { timeout: 30_000 }).toBe(true)

    // (1) A SINGLE DELETE takes its store with it and warns of nothing in this tab, where the
    // reporter leaves the store out while its cascade is in flight; and for the other client a
    // removed store whose item is gone is what a cascade leaves behind, not worth a line. (that
    // client did report the store as an orphan when the item's removal reached it, as it always
    // has.) the one warning left here is the emulator's way of delivering a remote delete: a
    // cached revision, which revokes authority until the next server revision and says so
    const quietFrom = lines.length
    expect(await page.evaluate(label => window._item(label)!.delete(false), SINGLE)).toBe(true)
    await expect
      .poll(() => exists(stores[SINGLE]!), { message: `the store of ${SINGLE} deleted with it`, timeout: 30_000 })
      .toBe(false)
    markers.push(await takenIn([page, other], '#e2e_cascade_seen'))
    expect([tookIn(lines, SINGLE), tookIn(otherLines, SINGLE)], 'both clients took the removal in').toEqual([true, true])
    expect(
      otherLines.filter(l => l.text.includes('missing local item for remote-removed')).map(l => l.text),
      'the other client says nothing of the removed store'
    ).toEqual([])
    expect(
      lines
        .slice(quietFrom)
        .filter(l => ['warning', 'error'].includes(l.type) && !l.text.includes(CACHED))
        .map(l => l.text),
      'a delete that cascades is quiet in its own tab'
    ).toEqual([])
    await elsewhere.close()

    // (2) A REFUSED OWNER DELETE NEVER CASCADES, and the store it leaves is reported when the
    // refusal ends its cascade, not at the delete: once by then (like any invalid record it is
    // named again at each later run of the reporter). the document is deleted first by a write
    // of this tab's own client behind the app (what a twin tab's delete amounts to), so the app's
    // delete, queued right behind it, is refused by the rules: they read fields off a resource
    // that does not exist (the get pinned in rules.spec.ts). a third delete, queued behind the
    // app's, shows that refusal and, since writes settle in order, returns only once the app's
    // own has settled
    await expect.poll(authority, { timeout: 30_000 }).toBe(true)
    const refusal = await page.evaluate(async label => {
      const { getFirestore, doc, deleteDoc } = window.firebase.firestore as any
      const item = window._item(label)!
      const ref = doc(getFirestore(window.firebase), 'items', item.saved_id)
      const first = deleteDoc(ref).then(() => 'deleted', (e: any) => e.code)
      const deleted = item.delete(false) // synchronous, as before: the item is gone when it returns
      const gone = !window._item(label, true)
      const third = await deleteDoc(ref).then(() => 'deleted', (e: any) => e.code)
      return { deleted, gone, first: await first, third }
    }, REFUSED)
    expect(refusal).toEqual({ deleted: true, gone: true, first: 'deleted', third: 'permission-denied' })
    await expect
      .poll(async () => ({ kept: await exists(stores[REFUSED]!), reported: reports(REFUSED) }), {
        message: 'a refused delete leaves its store, reported once at the refusal',
        timeout: 30_000,
      })
      .toEqual({ kept: true, reported: 1 })

    // (3) SEVERAL ITEMS DELETED IN ONE TURN (a subtree: the children, then the item) each take
    // their own store, and the delete stays synchronous for its caller
    expect(await page.evaluate(label => window._item(label)!.delete_subtree(false), TREE)).toBe(true)
    for (const label of [TREE, ...KIDS]) {
      await expect.poll(() => exists(owners[label]!), { message: `${label} deleted`, timeout: 30_000 }).toBe(false)
      await expect
        .poll(() => exists(stores[label]!), { message: `the store of ${label} deleted with it`, timeout: 30_000 })
        .toBe(false)
    }
    // nothing of this phase is in flight when the next one starts: the tab took each removal in
    await expect
      .poll(() => [TREE, ...KIDS].every(label => tookIn(lines, label)), { timeout: 30_000 })
      .toBe(true)

    // (4) A STORE THIS TAB OWES A SAVE IS LEFT ALONE. the item is deleted in the turn its store
    // save is accepted, from the save task's own completion (an item's code deleting its item),
    // before that save's write can be issued (it is still to be encrypted): the owner delete is
    // acknowledged first, with the save still owed. a report is made inside that turn (the index
    // usable, the refused store to name) with the deleted item still on the eval stack, and the
    // delete returns all the same
    await expect.poll(authority, { timeout: 30_000 }).toBe(true)
    await page.evaluate(label => {
      const item = window._item(label)!
      const raw = (window.__items as any[]).find(i => i.id == item.id)
      item.global_store._owed = 1 // the saving accessor dispatches the save task
      raw.tasks.save_global_store._on_done = () => {
        const usable = (window as any).__hiddenAuthoritative
        ;(window as any).__e2e_owed = { usable, deleted: item.delete(false) }
      }
    }, OWED)
    await expect
      .poll(() => page.evaluate(() => (window as any).__e2e_owed ?? null), {
        message: "an item's own delete returns, the index usable",
        timeout: 30_000,
      })
      .toEqual({ usable: true, deleted: true })
    await expect
      .poll(() => said(OWED), { message: 'the owed store is left, and why', timeout: 30_000 })
      .toEqual([left(OWED, 'this tab owes it a save')])
    // ... reported at that last word of its cascade, not before it
    const at = (text: string) => lines.findIndex(l => l.text.includes(text))
    await expect
      .poll(() => reports(OWED), { message: 'the store an owed save keeps is reported', timeout: 30_000 })
      .toBeGreaterThan(0)
    expect(at(`orphaned ${name(OWED)} (`), 'and only once its cascade ended').toBeGreaterThan(at(left(OWED, 'this tab owes it a save')))
    // ... and the owed save then lands on that same document
    await expect
      .poll(
        async () => {
          const held = await findStore(name(OWED))
          return held && [held.id, held.item._owed]
        },
        { timeout: 30_000 }
      )
      .toEqual([stores[OWED], 1])

    // (5) UNUSABLE AUTHORITY ONLY DELAYS THE CASCADE, AND A DELAYED ONE KEEPS TO THE RECORD IT
    // SAW: an undecryptable hidden change blocks the gate (as in the corrupt-change row above)
    // and two cascades wait for the next authority grant. behind the app another document then
    // takes one store's name (its record deleted, a new one written under the name), and the tab
    // takes both changes in, its index still blocked. at the grant the store whose record is
    // still the one first seen goes; under the other name the new record stays, the cascade
    // says why, and the reporter names it
    await firestore()
      .collection('items')
      .doc(CORRUPT)
      .set({ user: ALICE.uid, time: Date.now(), hidden: true, cipher: 'not decryptable' })
    await expect.poll(authority, { timeout: 30_000 }).toBe(false)
    expect(
      await page.evaluate(labels => labels.map(label => window._item(label)!.delete(false)), [BLIND, SWAPPED])
    ).toEqual([true, true])
    for (const label of [BLIND, SWAPPED])
      await expect
        .poll(() => said(label), { message: 'the cascade waits for the index, and says so', timeout: 30_000 })
        .toEqual([deferred(label, 'hidden-index authority is not usable')])
    expect(await exists(stores[BLIND]!), 'its store is still there meanwhile').toBe(true)
    const { encryptWithSecret } = await import('../../src/crypto.js')
    const envelope = JSON.stringify({
      hidden: true,
      attr: null,
      text: JSON.stringify({ name: name(SWAPPED), item: { _e2e: 2 } }),
    })
    await firestore().collection('items').doc(stores[SWAPPED]!).delete()
    const added = firestore().collection('items').doc()
    replacement = added.id
    await added.set({
      user: ALICE.uid,
      time: Date.now(),
      hidden: true,
      attr: null,
      text: null,
      cipher: await encryptWithSecret(envelope, secretFor(ALICE, PHRASE)),
    })
    await expect
      .poll(
        () => [tookIn(lines, SWAPPED), lines.some(l => l.type == 'debug' && l.text.includes(`added hidden ${added.id}`))],
        { message: 'the tab holds the other record under the name', timeout: 30_000 }
      )
      .toEqual([true, true])
    expect([await authority(), said(SWAPPED).length], 'its index still blocked, the cascade still waiting').toEqual([
      false,
      1,
    ])
    await firestore().collection('items').doc(CORRUPT).delete()
    await expect
      .poll(() => exists(stores[BLIND]!), { message: 'the store goes once authority is granted again', timeout: 30_000 })
      .toBe(false)
    const leftSwapped = left(SWAPPED, `another record holds the name (${added.id}, not ${stores[SWAPPED]})`)
    await expect
      .poll(async () => ({ kept: await exists(added.id), said: said(SWAPPED) }), {
        message: 'a cascade that waited deletes only the record it saw: another under the name stays, and why',
        timeout: 30_000,
      })
      .toEqual({ kept: true, said: [deferred(SWAPPED, 'hidden-index authority is not usable'), leftSwapped] })
    await expect
      .poll(
        () => lines.some(l => l.type == 'warning' && l.text.includes(`orphaned ${name(SWAPPED)} (${added.id})`)),
        { message: 'the record that stayed is reported', timeout: 30_000 }
      )
      .toBe(true)

    // one more report, after the tab took the last cascade's removal in: the stores that were
    // left are still there, and nothing was ever reported of a store that went with its item
    await expect.poll(() => tookIn(lines, BLIND), { message: 'the tab took the last removal in', timeout: 30_000 }).toBe(true)
    markers.push(await takenIn([page], '#e2e_cascade_done'))
    for (const label of [REFUSED, OWED]) {
      expect(await exists(owners[label]!), `${label} deleted`).toBe(false)
      expect(await exists(stores[label]!), `the store of ${label} left for /_gc`).toBe(true)
    }
    expect(await exists(added.id), 'the record that took a waiting name is still there').toBe(true)
    expect(
      [SINGLE, TREE, ...KIDS, BLIND].filter(label => reports(label)),
      'no report of a store that went with its item'
    ).toEqual([])
    expect(lines.filter(l => l.text.includes('left for /_gc')).map(l => l.text)).toEqual([
      left(OWED, 'this tab owes it a save'),
      leftSwapped,
    ])
  } finally {
    // best-effort residue cleanup on every exit (as the /_gc row): whatever exists of the pairs
    if (!other.isClosed()) await elsewhere.close()
    await firestore().collection('items').doc(CORRUPT).delete().catch(() => {})
    for (const id of [...markers, replacement, ...labels.flatMap(label => [owners[label], stores[label]])])
      if (id) await firestore().collection('items').doc(id).delete().catch(() => {})
  }
})

test('a subtree of 26 items deleted at once takes every store with it, quietly', async ({ page }) => {
  // the batch (design notes/design/mind_page_hidden_gc.md §5): every cascade checks authority at
  // its own delete's acknowledgment, the SDK sends ten writes ahead, and the earlier stores'
  // removals, coming back through the listener, make authority unusable for the later ones (14
  // of these 26 stores were left when such a cascade ended there). a cascade that meets an
  // unsettled index waits for the next authority grant instead and runs again, so every store
  // goes; none is ever reported, and a removed store whose item is gone is no warning either
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  await isolateEmulatorWebChannelPosts(page)
  const ROOT = '#e2e_cascade_batch'
  const labels = [ROOT, ...Array.from({ length: 25 }, (_, i) => `${ROOT}/k${i}`)]
  const exist = async (ids: (string | null)[]) =>
    (await Promise.all(ids.map(id => firestore().collection('items').doc(id!).get()))).filter(doc => doc.exists).length
  let owners: (string | null)[] = []
  const stores: (string | null)[] = []
  let marker: string | null = null
  const lines: { type: string; text: string }[] = []
  page.on('console', m => void lines.push({ type: m.type(), text: m.text() }))
  try {
    await page.evaluate(labels => labels.forEach(label => void window._create(`${label} store owner`)), labels)
    await expect
      .poll(
        async () =>
          (owners = await page.evaluate(labels => labels.map(l => window._item(l, true)?.saved_id ?? null), labels)).every(Boolean),
        { timeout: 60_000 }
      )
      .toBe(true)
    await page.evaluate(labels => labels.forEach(label => void (window._item(label)!.global_store._e2e = 1)), labels)
    for (const [i, owner] of owners.entries())
      await expect.poll(async () => (stores[i] = await findStoreDoc(`global_store_${owner}`)), { timeout: 30_000 }).not.toBeNull()
    await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 30_000 }).toBe(true)
    const from = lines.length
    expect(await page.evaluate(label => window._item(label)!.delete_subtree(false), ROOT)).toBe(true)
    await expect.poll(() => exist(owners), { message: 'every item of the subtree deleted', timeout: 60_000 }).toBe(0)
    await expect.poll(() => exist(stores), { message: 'every store of the subtree deleted with its item', timeout: 60_000 }).toBe(0)
    // one more report in the tab (the marker's), and all along it warned of nothing but the
    // emulator's cached revisions. that the tab had applied all 26 removals by then is NOT
    // asserted: a line of applied changes names ten at most, and nothing else shows the index
    marker = await takenIn([page], '#e2e_cascade_batch_done')
    expect(
      lines
        .slice(from)
        .filter(
          l =>
            (['warning', 'error'].includes(l.type) || l.text.includes('left for /_gc')) &&
            !l.text.includes('hidden-index authority revoked: cached revision')
        )
        .map(l => l.text),
      'a batch that cascades is quiet too, and leaves nothing'
    ).toEqual([])
  } finally {
    for (const id of [marker, ...owners, ...stores]) if (id) await firestore().collection('items').doc(id).delete().catch(() => {})
  }
})

test('a second tab of the profile that deletes an item takes its store with it too, and never reports the store it deleted', async ({ page }) => {
  // the tab that deletes may be a second tab of its profile, which shares the first one's cache
  // and connection. its cascade deletes the store all the same. on the emulator that tab then
  // does not take the store's removal in (see the cascade row above), so the record stays in
  // its index: the reporter goes on leaving out the exact record the tab deleted, or every
  // later report there would name a store that is gone. (where the tab does take the removal
  // in, there is nothing left to name: the annotation says which case a run met)
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  await isolateEmulatorWebChannelPosts(page)
  const LABEL = '#e2e_cascade_twin'
  let owner: string | null = null
  let store: string | null = null
  let marker: string | null = null
  const twin = await page.context().newPage()
  await isolateEmulatorWebChannelPosts(twin)
  const twinLines: { type: string; text: string }[] = []
  twin.on('console', m => void twinLines.push({ type: m.type(), text: m.text() }))
  try {
    await page.evaluate(text => void window._create(text), `${LABEL} store owner`)
    await expect.poll(async () => (owner = await savedId(page, LABEL)), { timeout: 30_000 }).toBeTruthy()
    await page.evaluate(label => void (window._item(label)!.global_store._e2e = 1), LABEL)
    await expect.poll(async () => (store = await findStoreDoc(`global_store_${owner}`)), { timeout: 30_000 }).not.toBeNull()
    await twin.goto('/')
    await waitForApp(twin)
    // the second tab holds the item and its store (the non-saving accessor), its index usable
    await expect
      .poll(() => twin.evaluate(label => (window._item(label, true) as any)?._global_store?._e2e ?? null, LABEL), { timeout: 30_000 })
      .toBe(1)
    await expect.poll(() => twin.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 30_000 }).toBe(true)
    expect(await twin.evaluate(label => window._item(label)!.delete(false), LABEL)).toBe(true)
    await expect
      .poll(async () => (await firestore().collection('items').doc(store!).get()).exists, {
        message: 'the store deleted with its item, from a second tab',
        timeout: 30_000,
      })
      .toBe(false)
    // a marker's arrival makes the second tab report once more, the deleted record still held or not
    marker = await takenIn([page, twin], '#e2e_cascade_twin_seen')
    test.info().annotations.push({
      type: 'the second tab took the removal in',
      description: String(twinLines.some(l => l.type == 'debug' && l.text.includes(`removed hidden ${store}`))),
    })
    expect(
      twinLines.filter(l => l.type == 'warning' && l.text.includes(`orphaned global_store_${owner} (`)).map(l => l.text),
      'the tab that deleted a store never reports it'
    ).toEqual([])
  } finally {
    await twin.close()
    for (const id of [marker, owner, store]) if (id) await firestore().collection('items').doc(id).delete().catch(() => {})
  }
})

test('signed-in global_store wake: startup child stays parked before initialized and saves on retry; post-init child persists on savedId while its 1 s timer stays held', async ({ page }) => {
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  await isolateEmulatorWebChannelPosts(page)
  const createdDocs = new Set<string>()
  let reloaded = false
  let hookTabId: string | null = null
  let hookDocId: string | null = null
  let childTabId: string | null = null
  let childId: string | null = null
  let childStoreDocId: string | null = null
  let wakeChildTabId: string | null = null
  let wakeChildId: string | null = null
  let wakeStoreDocId: string | null = null
  let releaseCreateWrite = () => {}
  const createWriteRelease = new Promise<void>(r => {
    releaseCreateWrite = r
  })
  let heldCreateWrite = false
  let releaseWakeWrite = () => {}
  const wakeWriteRelease = new Promise<void>(r => {
    releaseWakeWrite = r
  })
  let heldWakeWrite = false
  const holdWakeWriteRoute = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) => {
    const req = route.request()
    if (req.method() == 'POST') {
      const rawBody = req.postData() ?? ''
      let body = rawBody
      try {
        body = decodeURIComponent(rawBody)
      } catch {}
      if (body.includes('/documents/items/')) {
        heldWakeWrite = true
        await wakeWriteRelease
      }
    }
    await route.fallback()
  }
  const holdWriteRoute = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) => {
    const req = route.request()
    if (req.method() == 'POST') {
      const rawBody = req.postData() ?? ''
      let body = rawBody
      try {
        body = decodeURIComponent(rawBody)
      } catch {}
      if (body.includes('/documents/items/')) {
        heldCreateWrite = true
        await createWriteRelease
      }
    }
    await route.fallback()
  }
  const errors: string[] = []
  let reloadInitializedLog = false
  let watchingReload = false
  page.on('console', m => {
    const text = m.text()
    if (/saveHiddenItem called before initialized|stopping task 'save_global_store'/.test(text)) errors.push(text)
    if (watchingReload && /initialized \d+ items/.test(text)) reloadInitializedLog = true
  })
  try {
    // seed an #_init item that creates #e2e_init_store_child and writes its global_store during
    // initItems(), and traps resolve_height on items[0] (always in the first renderRange chunk)
    // so initialized stays false across the create acknowledgement until we release it
    const hookText = [
      '#e2e_init_store_hook #_init',
      '```js',
      'function _init() {',
      '  if (!window.__e2eAllowStartupHold) return',
      "  if (_item('#e2e_init_store_child', true)) return",
      "  const child = _create('#e2e_init_store_child startup store owner')",
      '  window.__e2eStartupChildTabId = child.id',
      '  child.global_store.fromInit = 1',
      '  const target = window.__items[0]',
      '  let realResolve = null',
      '  let released = false',
      '  window.__e2eHoldInit = {',
      '    armed: false,',
      '    release: () => {',
      '      released = true',
      '      if (realResolve) {',
      '        const fn = realResolve',
      '        realResolve = null',
      '        fn(100)',
      '      }',
      '    },',
      '  }',
      "  Object.defineProperty(target, 'resolve_height', {",
      '    configurable: true,',
      '    get: () =>',
      '      realResolve',
      '        ? h => {',
      '            window.__e2eHoldInit.armed = true',
      '            if (released) {',
      '              const fn = realResolve',
      '              realResolve = null',
      '              fn(h)',
      '            }',
      '          }',
      '        : null,',
      '    set: fn => {',
      '      if (fn) realResolve = fn',
      '      else if (released) realResolve = null',
      '    },',
      '  })',
      '}',
      '```',
    ].join('\n')
    hookTabId = await page.evaluate(text => {
      const id = (window._create(text) as any).id as string
      ;(window as any).__e2eHookTabId = id
      return id
    }, hookText)
    await expect
      .poll(
        async () =>
          (hookDocId = await page.evaluate(
            id => ((window.__items as any[]).find(i => i.id === id)?.savedId as string | undefined) ?? null,
            hookTabId!
          )),
        { timeout: 30_000 }
      )
      .toBeTruthy()
    createdDocs.add(hookDocId!)

    // on the next load, opt in to the #e2e_init_store_hook hold and hold the parked 1 s retry
    // timer of the startup child's save_global_store at dispatch
    await page.addInitScript(() => {
      ;(window as any).__e2eAllowStartupHold = true
      const realSetTimeout = window.setTimeout.bind(window)
      const seen = new WeakSet<object>()
      const heldRetries: Array<{ task: unknown; fn: TimerHandler; args: unknown[]; fired: boolean }> = []
      window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        const id = (window as any).__e2eStartupChildTabId as string | undefined
        const raw = id ? ((window as any).__items as any[])?.find((i: any) => i.id === id) : null
        const task = raw?.tasks?.save_global_store
        if (raw && task && !seen.has(task)) {
          seen.add(task)
          if (delay === 1000 && !raw.savedId) {
            heldRetries.push({ task, fn, args, fired: false })
            return -heldRetries.length
          }
        }
        return realSetTimeout(fn, delay, ...args)
      }) as typeof window.setTimeout
      ;(window as any).__e2eStartup = {
        heldRetries,
        restore: () => {
          window.setTimeout = realSetTimeout
        },
        fireRetries: () => {
          window.setTimeout = realSetTimeout
          for (const h of heldRetries) {
            if (!h.fired) {
              h.fired = true
              realSetTimeout(h.fn, 0, ...h.args)
            }
          }
        },
      }
    })
    await page.route('**/Write/channel**', holdWriteRoute)
    watchingReload = true
    reloaded = true
    await page.reload()

    // precondition: first renderRange chunk is held (initialized=false), the create write is held,
    // and #e2e_init_store_child's save_global_store has parked with its 1 s timer held
    await expect.poll(() => heldCreateWrite, { message: '#e2e_init_store_child create held by route', timeout: 30_000 }).toBe(true)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const st = (window as any).__e2eStartup
            const hold = (window as any).__e2eHoldInit
            const id = (window as any).__e2eStartupChildTabId as string | undefined
            const raw = id ? (window.__items as any[]).find(i => i.id === id) : null
            const task = raw?.tasks?.save_global_store ?? null
            const latest = [...(st?.heldRetries ?? [])].reverse()[0] ?? null
            return {
              initHeld: Boolean(hold?.armed),
              unsaved: Boolean(raw && !raw.savedId),
              parkedAndHeld: Boolean(raw && !raw.savedId && task && latest && latest.task === task && !latest.fired),
            }
          }),
        { message: 'save_global_store parked while first renderRange chunk is held before initialized', timeout: 30_000 }
      )
      .toEqual({ initHeld: true, unsaved: true, parkedAndHeld: true })
    childTabId = await page.evaluate(() => ((window as any).__e2eStartupChildTabId as string | undefined) ?? null)
    expect(childTabId, 'captured startup child tab id').toBeTruthy()
    expect(reloadInitializedLog, 'app not yet initialized before create acknowledgement').toBe(false)

    // release ONLY the create write: savedId arrives while initialized is STILL false
    releaseCreateWrite()
    await page.unroute('**/Write/channel**', holdWriteRoute)
    await expect
      .poll(
        async () =>
          (childId = await page.evaluate(
            id => ((window.__items as any[]).find(i => i.id === id)?.savedId as string | undefined) ?? null,
            childTabId!
          )),
        { timeout: 30_000 }
      )
      .toBeTruthy()
    createdDocs.add(childId!)
    // give any erroneous premature wake a turn to run while initialized is still false
    await page.evaluate(() => new Promise(r => setTimeout(r, 50)))
    expect(reloadInitializedLog, 'app still not initialized after create acknowledgement').toBe(false)
    expect(
      await page.evaluate(id => {
        const st = (window as any).__e2eStartup
        const raw = (window.__items as any[]).find(i => i.id === id) ?? null
        const latest = [...(st?.heldRetries ?? [])].reverse()[0] ?? null
        return {
          stillParked: Boolean(raw?.tasks?.save_global_store && latest && raw.tasks.save_global_store === latest.task),
        }
      }, childTabId!),
      'save_global_store stayed parked instead of hitting saveHiddenItem before initialized'
    ).toEqual({ stillParked: true })
    expect(errors, 'no saveHiddenItem-before-initialized error').toEqual([])

    // release the first render chunk (initialized=true), then let the parked 1 s retry run -> hidden store lands
    await page.evaluate(() => (window as any).__e2eHoldInit.release())
    await waitForApp(page)
    expect(reloadInitializedLog, 'app initialized after releasing first render chunk').toBe(true)
    await page.evaluate(() => (window as any).__e2eStartup.fireRetries())
    let storeDoc: { id: string; item: any } | null = null
    await expect
      .poll(async () => {
        storeDoc = await findStore(`global_store_${childId}`)
        return storeDoc?.item ?? null
      }, { message: 'hidden global store persisted after initialized', timeout: 30_000 })
      .toEqual({ fromInit: 1 })
    if (storeDoc) {
      childStoreDocId = (storeDoc as { id: string }).id
      createdDocs.add(childStoreDocId)
    }
    expect(errors).toEqual([])

    // phase 2 (once initialized): a parked global_store save on a second, post-init signed-in child
    // wakes on savedId and reaches Firestore WHILE its 1 s fallback timer stays held
    await page.evaluate(() => {
      const real = window.setTimeout.bind(window)
      const seen = new WeakSet<object>()
      const held: Array<{ task: unknown; fired: boolean }> = []
      window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        const id = (window as any).__e2eWakeChildTabId as string | undefined
        const raw = id ? (window.__items as any[]).find(i => i.id === id) : null
        const task = raw?.tasks?.save_global_store
        if (raw && task && !seen.has(task)) {
          seen.add(task)
          if (delay === 1000 && !raw.savedId) {
            held.push({ task, fired: false })
            return -held.length
          }
        }
        return real(fn, delay, ...args)
      }) as typeof window.setTimeout
      ;(window as any).__e2eSignedInWake = {
        held,
        restore: () => {
          window.setTimeout = real
        },
      }
    })
    await page.route('**/Write/channel**', holdWakeWriteRoute)
    wakeChildTabId = await page.evaluate(() => {
      const it = window._create('#e2e_signed_in_wake post-init wake owner') as any
      ;(window as any).__e2eWakeChildTabId = it.id
      it.global_store.woken = 1
      return it.id as string
    })
    await expect.poll(() => heldWakeWrite, { message: '#e2e_signed_in_wake create held by route', timeout: 30_000 }).toBe(true)
    await expect
      .poll(
        () =>
          page.evaluate(id => {
            const held = ((window as any).__e2eSignedInWake?.held ?? []) as Array<{ task: unknown; fired: boolean }>
            const raw = (window.__items as any[]).find(i => i.id === id) ?? null
            const task = raw?.tasks?.save_global_store ?? null
            const latest = [...held].reverse()[0] ?? null
            return {
              unsaved: Boolean(raw && !raw.savedId),
              parkedAndHeld: Boolean(raw && !raw.savedId && task && latest && latest.task === task && !latest.fired),
            }
          }, wakeChildTabId!),
        { message: 'post-init signed-in save_global_store parked with 1 s timer held', timeout: 15_000 }
      )
      .toEqual({ unsaved: true, parkedAndHeld: true })
    releaseWakeWrite()
    await page.unroute('**/Write/channel**', holdWakeWriteRoute)
    await expect
      .poll(
        async () =>
          (wakeChildId = await page.evaluate(
            id => ((window.__items as any[]).find(i => i.id === id)?.savedId as string | undefined) ?? null,
            wakeChildTabId!
          )),
        { timeout: 30_000 }
      )
      .toBeTruthy()
    createdDocs.add(wakeChildId!)
    let wakeStoreDoc: { id: string; item: any } | null = null
    await expect
      .poll(async () => {
        wakeStoreDoc = await findStore(`global_store_${wakeChildId}`)
        return wakeStoreDoc?.item ?? null
      }, { message: 'signed-in save_global_store woke on savedId while 1 s timer stayed held', timeout: 15_000 })
      .toEqual({ woken: 1 })
    if (wakeStoreDoc) {
      wakeStoreDocId = (wakeStoreDoc as { id: string }).id
      createdDocs.add(wakeStoreDocId)
    }
    expect(
      await page.evaluate(() => ((window as any).__e2eSignedInWake?.held ?? []).every((h: any) => !h.fired)),
      'post-init held 1 s retry timer never fired'
    ).toBe(true)
    await page.evaluate(() => (window as any).__e2eSignedInWake?.restore?.())
    expect(errors).toEqual([])
  } finally {
    releaseCreateWrite()
    releaseWakeWrite()
    await page.unroute('**/Write/channel**', holdWriteRoute).catch(() => {})
    await page.unroute('**/Write/channel**', holdWakeWriteRoute).catch(() => {})
    await page
      .evaluate(() => {
        ;(window as any).__e2eHoldInit?.release?.()
        ;(window as any).__e2eStartup?.restore?.()
        ;(window as any).__e2eSignedInWake?.restore?.()
      })
      .catch(() => {})
    const settleTabId = async (tabId: string) =>
      page
        .evaluate(async id => {
          const deadline = Date.now() + 15_000
          while (Date.now() < deadline) {
            const raw = (window.__items as any[]).find(i => i.id === id)
            if (!raw || raw.savedId || raw.createFailed) return (raw?.savedId as string | undefined) ?? null
            await new Promise(r => setTimeout(r, 50))
          }
          return (((window.__items as any[]).find(i => i.id === id)?.savedId as string | undefined) ?? null)
        }, tabId)
        .catch(() => null)
    if (!page.isClosed()) {
      if (!reloaded && !hookDocId) {
        hookTabId ??= await page.evaluate(() => ((window as any).__e2eHookTabId as string | undefined) ?? null).catch(() => null)
        if (hookTabId) {
          hookDocId = await settleTabId(hookTabId)
          if (hookDocId) createdDocs.add(hookDocId)
        }
      }
      if (reloaded) {
        if (!childId) {
          childTabId ??= await page
            .evaluate(() => ((window as any).__e2eStartupChildTabId as string | undefined) ?? null)
            .catch(() => null)
          if (childTabId) {
            childId = await settleTabId(childTabId)
            if (childId) createdDocs.add(childId)
          }
        }
        if (!wakeChildId) {
          wakeChildTabId ??= await page
            .evaluate(() => ((window as any).__e2eWakeChildTabId as string | undefined) ?? null)
            .catch(() => null)
          if (wakeChildTabId) {
            wakeChildId = await settleTabId(wakeChildTabId)
            if (wakeChildId) createdDocs.add(wakeChildId)
          }
        }
      }
    }
    let cleanupErr: unknown = null
    for (const [ownerId, knownStoreId] of [
      [childId, childStoreDocId],
      [wakeChildId, wakeStoreDocId],
    ] as const) {
      if (!ownerId || knownStoreId) continue
      try {
        const storeId = await findStoreDoc(`global_store_${ownerId}`)
        if (storeId) createdDocs.add(storeId)
      } catch (e) {
        cleanupErr ??= e
      }
    }
    for (const id of createdDocs) {
      try {
        await firestore().collection('items').doc(id).delete()
      } catch (e) {
        cleanupErr ??= e
      }
    }
    if (cleanupErr) throw cleanupErr
  }
})

test('isolating emulator WebChannel POSTs forwards Listen and Write on distinct sockets while GET and REST fall through', async ({ browser }) => {
  // forwarding-contract check for emulator_webchannel.ts against an ordinary HTTP server:
  // Listen and Write POSTs are isolated onto distinct non-pooled upstream sockets with bodies and
  // replies preserved at both ends, while streaming GET and REST :commit fall through to the
  // browser's own transport (witnessed by a lower-priority route)
  const sockets = new Set<http.IncomingMessage['socket']>()
  const socketIds = new WeakMap<http.IncomingMessage['socket'], number>()
  let nextSockId = 1
  const webChannelPosts: { path: string; body: string; channel: string | undefined; contentType: string | undefined; socketId: number }[] = []
  const restCommits: string[] = []
  let streamRes: http.ServerResponse | null = null

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const server = http.createServer(async (req, res) => {
    const reqPath = req.url ?? '/'
    const socketId = socketIds.get(req.socket) ?? -1
    const channelMatch = req.method === 'POST' ? reqPath.match(/^\/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel(?:\?|$)/) : null
    if (req.method === 'GET' && reqPath === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    } else if (req.method === 'GET' && reqPath === '/favicon.ico') {
      res.writeHead(204)
      res.end()
    } else if (req.method === 'GET' && reqPath.startsWith('/google.firestore.v1.Firestore/Listen/channel')) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
      streamRes = res
      res.write('first-chunk\n')
    } else if (channelMatch) {
      const kind = channelMatch[1].toLowerCase()
      webChannelPosts.push({
        path: reqPath,
        body: await readBody(req),
        channel: typeof req.headers['x-e2e-channel'] === 'string' ? req.headers['x-e2e-channel'] : undefined,
        contentType: req.headers['content-type'],
        socketId,
      })
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-E2E-Reply': `${kind}-ok` })
      res.end(kind === 'listen' ? '12\n["listen"]\n' : '11\n["write"]\n')
    } else if (req.method === 'POST' && reqPath === '/v1/projects/p/databases/(default)/documents:commit') {
      restCommits.push(await readBody(req))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"commitTime":"2026-11-26T00:00:00Z"}')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  server.on('connection', sock => {
    socketIds.set(sock, nextSockId++)
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const base = `http://127.0.0.1:${port}`
  const ctx = await browser.newContext()
  try {
    const tab = await ctx.newPage()
    // lower-priority witness route (registered first so isolateEmulatorWebChannelPosts runs ahead of it)
    const fellThrough: string[] = []
    await tab.route(new RegExp(`^http://127\\.0\\.0\\.1:${port}/(google\\.firestore\\.v1\\.Firestore/|v1/)`), async route => {
      const req = route.request()
      fellThrough.push(`${req.method()} ${new URL(req.url()).pathname}`)
      await route.continue()
    })
    await isolateEmulatorWebChannelPosts(tab, `127.0.0.1:${port}`)
    await tab.goto(`${base}/`)

    // (1) streaming GET falls through unbuffered: first chunk arrives while response is still open
    const stream = await tab.evaluate(
      url =>
        new Promise<{ chunk: string; readyState: number }>(resolve => {
          const x = new XMLHttpRequest()
          const timer = setTimeout(() => {
            x.abort()
            resolve({ chunk: 'timeout', readyState: x.readyState })
          }, 2_000)
          x.open('GET', url, true)
          x.onprogress = () => {
            if (x.responseText) {
              clearTimeout(timer)
              const result = { chunk: x.responseText, readyState: x.readyState }
              x.abort()
              resolve(result)
            }
          }
          x.onerror = () => {
            clearTimeout(timer)
            resolve({ chunk: 'error', readyState: x.readyState })
          }
          x.send()
        }),
      `${base}/google.firestore.v1.Firestore/Listen/channel?VER=8&RID=rpc`
    )
    expect(stream, 'streaming GET first chunk arrives before EOF').toEqual({ chunk: 'first-chunk\n', readyState: 3 })
    const openStream = streamRes as http.ServerResponse | null
    expect(openStream?.writableEnded, 'server had not ended streaming GET when first chunk arrived').toBe(false)
    openStream?.end()

    // (2) distinct Listen POST, Write POST, and browser REST commit
    const commitBody = JSON.stringify({ writes: [{ delete: 'projects/p/databases/(default)/documents/items/doc1' }] })
    const replies = await tab.evaluate(
      async ({ base, commitBody }) => {
        const post = (url: string, body: string, ct: string, channel?: string) =>
          new Promise<{ status: number; reply: string | null; body: string }>(resolve => {
            const x = new XMLHttpRequest()
            x.open('POST', url, true)
            x.setRequestHeader('Content-Type', ct)
            if (channel) x.setRequestHeader('X-E2E-Channel', channel)
            x.onload = () => resolve({ status: x.status, reply: x.getResponseHeader('x-e2e-reply'), body: x.responseText })
            x.onerror = () => resolve({ status: 0, reply: null, body: 'ERR' })
            x.send(body)
          })
        const listen = await post(
          `${base}/google.firestore.v1.Firestore/Listen/channel?VER=8`,
          'count=1&req=listen',
          'application/x-www-form-urlencoded',
          'listen'
        )
        const write = await post(
          `${base}/google.firestore.v1.Firestore/Write/channel?VER=8`,
          'count=2&req=write',
          'application/x-www-form-urlencoded',
          'write'
        )
        const commit = await post(`${base}/v1/projects/p/databases/(default)/documents:commit`, commitBody, 'text/plain')
        return { listen, write, commit }
      },
      { base, commitBody }
    )

    expect(replies.listen, 'page received Listen POST reply').toEqual({
      status: 200,
      reply: 'listen-ok',
      body: '12\n["listen"]\n',
    })
    expect(replies.write, 'page received Write POST reply').toEqual({
      status: 200,
      reply: 'write-ok',
      body: '11\n["write"]\n',
    })
    expect(replies.commit, 'page received REST commit reply').toEqual({
      status: 200,
      reply: null,
      body: '{"commitTime":"2026-11-26T00:00:00Z"}',
    })
    expect(fellThrough, 'only streaming GET and REST commit fall through to the browser transport').toEqual([
      'GET /google.firestore.v1.Firestore/Listen/channel',
      'POST /v1/projects/p/databases/(default)/documents:commit',
    ])
    expect(
      webChannelPosts.map(({ socketId: _socketId, ...rest }) => rest),
      'server received distinct Listen and Write POSTs'
    ).toEqual([
      {
        path: '/google.firestore.v1.Firestore/Listen/channel?VER=8',
        body: 'count=1&req=listen',
        channel: 'listen',
        contentType: 'application/x-www-form-urlencoded',
      },
      {
        path: '/google.firestore.v1.Firestore/Write/channel?VER=8',
        body: 'count=2&req=write',
        channel: 'write',
        contentType: 'application/x-www-form-urlencoded',
      },
    ])
    expect(
      new Set(webChannelPosts.map(p => p.socketId)).size,
      'Listen and Write POSTs use distinct upstream sockets (agent: false)'
    ).toBe(2)
    expect(restCommits, 'server received the browser REST commit').toEqual([commitBody])
  } finally {
    await ctx.close()
    for (const s of sockets) s.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
