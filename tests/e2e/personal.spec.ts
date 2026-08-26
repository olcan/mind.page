import { expect, test, type Page } from '@playwright/test'
import { ALICE, customToken, firestore, loadUser, secretFor, waitForApp } from './helpers.js'

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
  await page.goto('/')
  await page.evaluate(secret => localStorage.setItem('mindpage_secret', secret), secretFor(ALICE, PHRASE))
}

const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)

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
  // the phrase is kept as a hash with the uid (see secretFor), never the phrase itself
  expect(await page.evaluate(() => localStorage.getItem('mindpage_secret'))).toBe(secretFor(ALICE, PHRASE))
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
  await loadUser(page, ALICE) // fresh context: no secret in localStorage
  await enterPhrase(page, /Enter your secret phrase/, 'wrong phrase', 'Continue')
  await expect(page.getByText(/Unable to access your account/)).toBeVisible({ timeout: 60_000 })
  await page.locator('.modal .button.confirm', { hasText: 'Sign Out' }).click()
  // signed out: back to the anonymous account as a read-only visitor, credentials cleared
  await expect(page.getByText('Stay Anonymous', { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(
    await page.evaluate(() => [localStorage.getItem('mindpage_secret'), localStorage.getItem('mindpage_user')]),
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
    await expect.poll(() => channel.activeAt(channel.epoch)).toBeGreaterThan(0)
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
  await page.evaluate(() => void window._create('/_signout', { command: true })) // also clears the cache
  await expect(page.getByText('Stay Anonymous', { exact: true })).toBeVisible({ timeout: 60_000 })
  // cache alice's shared item by visiting her shared page as a signed-out visitor
  await page.goto(`/?shared=${ALICE.uid}/e2e-key`)
  await waitForApp(page)
  expect(await page.evaluate(() => window._items().length)).toBe(1)
  // sign in with the firestore channel stalled: the first snapshot comes from the partial cache
  await page.goto('/')
  const channel = holdFirestore(page)
  const cacheWait = watchCacheWait(page)
  await channel.install()
  try {
    const token = await customToken(ALICE)
    await page.waitForFunction(() => !!window.firebase?.auth?.signInWithCustomToken, null, { timeout: 30_000 })
    await page.evaluate(token => {
      sessionStorage.setItem('mindpage_signin_pending', '1')
      document.cookie = '__session=signin_pending;max-age=600'
      void window.firebase.auth.signInWithCustomToken(window.firebase.auth.getAuth(window.firebase), token)
    }, token)
    await page.waitForFunction(() => !sessionStorage.getItem('mindpage_signin_pending'), null, { timeout: 30_000 })
    // EXACTLY this navigation's decision: >= would also accept one from a later reload
    const epoch = cacheWait.epoch
    await expect.poll(() => cacheWait.decided, { timeout: 60_000 }).toBe(epoch)
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
      { timeout: 30_000 },
    )
    .toBeLessThanOrEqual(1) // the header reaches the top of the viewport
  // and stays there once settled
  await page.waitForTimeout(2_000)
  expect(
    await page.evaluate(() =>
      Math.round((document.querySelector('.header') as HTMLElement).getBoundingClientRect().top),
    ),
  ).toBeLessThanOrEqual(1)
})

test('a foreign shared page never coexists with a session on this origin', async ({ page }) => {
  // a shared page runs its OWNER's code, and no in-origin measure contains that: any same-origin
  // realm recreates the firebase facade, and auth persistence, the session cookie and
  // localStorage (secret included) are per-ORIGIN. so foreign shared pages are served from an
  // isolated origin (see sharedOriginRedirect, pinned in tests/unit/host.spec.ts), which also
  // closes the case a prompt never could — a visitor signed out today who signs in later while
  // owner code is still resident in a tab of this origin.
  // localhost has no second origin, so the redirect is suppressed here and the FALLBACK applies:
  // the session is ended rather than the visitor being asked to weigh anything
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
    await withSecret(page)
    await loadUser(page, ALICE)
    await waitForApp(page)
    expect(await page.evaluate(() => localStorage.getItem('mindpage_secret'))).toBeTruthy()
    await page.goto('/?shared=crawl_e2e/trap')
    // the session ends, taking the stored secret with it — no prompt, no decision. signOut()
    // reloads, so an evaluate can land mid-navigation: that is the behavior under test, not a
    // failure, so the polls tolerate a destroyed context and keep waiting
    const evalOrRetry = <T>(fn: () => Promise<T>) => fn().catch(() => 'navigating' as unknown as T)
    await expect
      .poll(() => evalOrRetry(() => page.evaluate(() => localStorage.getItem('mindpage_secret'))), {
        timeout: 60_000,
      })
      .toBeNull()
    await expect
      .poll(() => evalOrRetry(() => page.evaluate(() => window._user?.uid ?? null)), { timeout: 60_000 })
      .not.toBe(ALICE.uid)
    // ... and the page then works normally for the anonymous visitor it left behind
    const notice = page.locator('.modal .button', { hasText: 'View Shared Page' })
    if (await notice.isVisible({ timeout: 30_000 }).catch(() => false)) await notice.click()
    await expect(page.getByText('a foreign item with init code')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => page.evaluate(() => (window as any).__FOREIGN_RAN ?? null), { timeout: 60_000 }).toBe(1)
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
  // corrupt the document server-side (its later change events cannot decrypt), then delete it
  await firestore().collection('items').doc(id!).update({ cipher: 'not decryptable', text: null, attr: null })
  await page.waitForTimeout(2_000) // the corrupt modify arrives and is skipped (logged)
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
  const hiddenDocs = async () =>
    (await firestore().collection('items').where('user', '==', ALICE.uid).where('hidden', '==', true).get()).size
  const base = await expect
    .poll(hiddenDocs, { timeout: 30_000 })
    .toBeGreaterThan(0)
    .then(() => hiddenDocs())
  // an undecryptable hidden change arrives: the revision fails to apply it, so authority is
  // revoked AND the id stays dirty — later confirmations must not re-grant past the gap
  await firestore().collection('items').doc('e2e-corrupt-hidden').set({
    user: ALICE.uid,
    time: Date.now(),
    hidden: true,
    cipher: 'not decryptable',
  })
  await expect.poll(authority, { timeout: 30_000 }).toBe(false)
  // the owner item is deleted server-side while unauthoritative: its store is now orphaned
  await firestore().collection('items').doc(ownerId!).delete()
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_orphan_owner', true)?.id ?? null), { timeout: 30_000 })
    .toBeNull()
  // removing the corrupt document heals its dirty id (removal applies by plaintext hidden + id,
  // no decrypt needed) and the same authoritative revision re-grants; the false -> true grant
  // recomputes invalidity from CURRENT state and deletes the now-orphaned store
  await firestore().collection('items').doc('e2e-corrupt-hidden').delete()
  await expect.poll(authority, { timeout: 30_000 }).toBe(true)
  // the now-orphaned store is REPORTED and quarantined, not deleted: a classification describes
  // one moment while the delete it used to queue landed later, after another client could have
  // renamed or updated that very document into a valid record. nothing is destroyed from a
  // render-time client any more (see reportInvalidHiddenCandidates)
  await page.waitForTimeout(3_000)
  expect(await hiddenDocs()).toBe(base)
})

test('a shared-page sign-in validates the phrase and warms the cache for the main page', async ({ page }) => {
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
  // sign in on the shared page itself (as the owner, without the stored secret)
  const signInOnSharedPage = async () => {
    const token = await customToken(ALICE)
    await page.goto(`/?shared=${ALICE.uid}/e2e-key`)
    await page.waitForFunction(() => !!window.firebase?.auth?.signInWithCustomToken, null, { timeout: 30_000 })
    await page.evaluate(token => {
      sessionStorage.setItem('mindpage_signin_pending', '1')
      document.cookie = '__session=signin_pending;max-age=600'
      void window.firebase.auth.signInWithCustomToken(window.firebase.auth.getAuth(window.firebase), token)
    }, token)
    await page.waitForFunction(() => !sessionStorage.getItem('mindpage_signin_pending'), null, { timeout: 30_000 })
    await page.getByText('View Shared Page', { exact: true }).click({ timeout: 60_000 }) // fixed-page welcome
    await waitForApp(page)
    // an encrypted save (item code saving global state, as the production #sharer item does)
    // prompts for the existing phrase, never a new one, validated against the account's ciphertext
    await page.evaluate(() => void (window._item('#e2e_shared')!.global_store._e2e_probe = Date.now()))
    await expect(page.getByText(/Enter your secret phrase/)).toBeVisible({ timeout: 60_000 })
    expect(await page.getByText(/Choose a .*secret phrase/).count()).toBe(0)
  }
  await signInOnSharedPage()
  // a wrong phrase is rejected and re-prompted instead of encrypting under the wrong key
  await page.fill('#modal-input', 'wrong phrase')
  await page.locator('.modal .button.confirm', { hasText: 'Continue' }).click()
  await expect(page.getByText(/appears incorrect/)).toBeVisible({ timeout: 60_000 })
  await page.locator('.modal .button.confirm', { hasText: 'Try Again' }).click()
  await expect(page.getByText(/Enter your secret phrase/)).toBeVisible({ timeout: 60_000 })
  // cancelling signs out instead of re-prompting forever
  await page.locator('.modal .button.cancel', { hasText: 'Sign Out' }).click()
  await expect(page.getByText(/Welcome to MindPage/)).toBeVisible({ timeout: 60_000 }) // shared page, signed out
  // the correct phrase validates, and the validation fetch warms the cache: the main page then
  // initializes without any prompt
  await signInOnSharedPage()
  await enterPhrase(page, /Enter your secret phrase/, PHRASE, 'Continue')
  await expect(page.getByText(/Enter your secret phrase/)).toBeHidden({ timeout: 60_000 }) // absent or in the closed modal's dom
  expect(await page.evaluate(() => localStorage.getItem('mindpage_secret'))).toBe(secretFor(ALICE, PHRASE))
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
        .sort(),
    ),
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
    legacy.map(path => ({ name: '__session', value: 'eyJhbGciOiJSUzI1NiJ9.legacy.token', domain, path })),
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
    await page.evaluate(() => [localStorage.getItem('mindpage_secret'), localStorage.getItem('mindpage_user')]),
  ).toEqual([null, null])
  // the marker must be GONE after sign-out, not merely free of a token: a stale `__session=1`
  // keeps suppressing anonymous server rendering for signed-out requests
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/__session=[^;]/)
  // the firestore cache of the account was deleted (a fresh one is created for the anonymous account)
  await page.getByText('Stay Anonymous', { exact: true }).click()
  await waitForApp(page)
  expect(await page.evaluate(() => window._items().some(item => item.name == '#e2e_private'))).toBe(false)
})
