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
  await expect
    .poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 15_000 })
    .toBe(true)
  // reloading with the stored secret decrypts without prompting
  await page.reload()
  await waitForApp(page)
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_private', true)?.text ?? null))
    .toContain('secret text 12345')
  expect(await page.locator('#modal-input').count()).toBe(0)
})

test('a new device must enter the phrase; a wrong one can only sign out', async ({ page }) => {
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

test('a slow first connection does not reset the account to empty', async ({ page }) => {
  // a fresh device has an empty persistent cache; if the firestore channel is slow, the empty
  // cache snapshot must not initialize the account (which would create a welcome item and, on a
  // device without the secret, prompt for a NEW phrase over the existing items)
  await withSecret(page)
  let blocked = true
  await page.route(/:8080\/google\.firestore/, route =>
    blocked ? void setTimeout(() => route.continue(), 8_000) : route.continue()
  )
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
  await page.waitForTimeout(4_000) // while the channel stalls, the app must keep waiting
  expect(await page.evaluate(() => window._init_time > 0)).toBe(false) // undefined until init
  expect(await page.getByText(/Choose a .*secret phrase/).count()).toBe(0)
  blocked = false
  await expect
    .poll(() => page.evaluate(() => window._init_time > 0 && window._readonly === false).catch(() => false), {
      timeout: 90_000,
    })
    .toBe(true)
  await waitForApp(page)
  const names = await page.evaluate(() => window._items().map(item => item.name))
  expect(names).toContain('#e2e_private') // account intact, no welcome item added
  expect(names.filter(name => name == '#e2e_private')).toHaveLength(1)
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
  let blocked = true
  await page.route(/:8080\/google\.firestore/, route =>
    blocked ? void setTimeout(() => route.continue(), 8_000) : route.continue()
  )
  const token = await customToken(ALICE)
  await page.waitForFunction(() => !!window.firebase?.auth?.signInWithCustomToken, null, { timeout: 30_000 })
  await page.evaluate(token => {
    sessionStorage.setItem('mindpage_signin_pending', '1')
    document.cookie = '__session=signin_pending;max-age=600'
    void window.firebase.auth.signInWithCustomToken(window.firebase.auth.getAuth(window.firebase), token)
  }, token)
  await page.waitForFunction(() => !sessionStorage.getItem('mindpage_signin_pending'), null, { timeout: 30_000 })
  await page.waitForTimeout(4_000) // while stalled, the app must keep waiting on the partial cache
  expect(await page.evaluate(() => window._init_time > 0)).toBe(false) // undefined until init
  expect(await page.getByText(/Choose a .*secret phrase/).count()).toBe(0)
  blocked = false
  // the server snapshot arrives with the encrypted items, which prompt for the existing phrase
  await enterPhrase(page, /Enter your secret phrase/, PHRASE, 'Continue')
  await waitForApp(page)
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_private', true)?.text ?? null))
    .toContain('secret text 12345')
  await page.evaluate(() => window._item('#e2e_shared')!.unshare('e2e-key')) // restore for later tests
  await expect.poll(() => stored(page, '#e2e_shared'), { timeout: 30_000 }).toMatchObject({ text: null })
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
  await expect
    .poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 15_000 })
    .toBe(true)
})

test('foreign shared-page code needs consent from a signed-in visitor (and cannot reach the secret unconfirmed)', async ({ page }) => {
  // a shared page runs its OWNER's item code in this origin (macros, _init, commands): with the
  // app bundle enabled and a visitor signed in to their own account, an unconfirmed foreign
  // #_init would execute with the visitor's stored secret reachable in localStorage. the gate
  // (see initialize in index.svelte) must ask first; declining still renders content
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
    // visit the foreign shared page as the signed-in visitor: the consent modal must gate code
    // (the standing shared-page welcome notice queues ahead of it and is dismissed first)
    const dismissNotice = async () => {
      const notice = page.locator('.modal .button', { hasText: 'View Shared Page' })
      if (await notice.isVisible({ timeout: 15_000 }).catch(() => false)) await notice.click()
    }
    await page.goto('/?shared=crawl_e2e/trap')
    await dismissNotice()
    await expect(page.getByText(/includes code written by its owner/)).toBeVisible({ timeout: 60_000 })
    await page.locator('.modal .button.cancel', { hasText: 'View Only' }).click()
    await expect(page.getByText('a foreign item with init code')).toBeVisible({ timeout: 60_000 }) // content renders
    expect(await page.evaluate(() => (window as any).__FOREIGN_RAN ?? null)).toBeNull() // code did NOT run
    expect(await page.evaluate(() => localStorage.getItem('mindpage_secret'))).toBeTruthy() // the asset the gate protects
    // consenting runs the code, and the choice is remembered for the session (no re-prompt)
    await page.reload()
    await dismissNotice()
    await expect(page.getByText(/includes code written by its owner/)).toBeVisible({ timeout: 60_000 })
    await page.locator('.modal .button.confirm', { hasText: 'Run Code' }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__FOREIGN_RAN ?? null), { timeout: 60_000 }).toBe(1)
    await page.reload()
    await dismissNotice()
    await expect.poll(() => page.evaluate(() => (window as any).__FOREIGN_RAN ?? null), { timeout: 60_000 }).toBe(1)
    expect(await page.getByText(/includes code written by its owner/).count()).toBe(0) // remembered
  } finally {
    await firestore().collection('items').doc('e2e-foreign-init').delete()
  }
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
  await page.evaluate(() => void (window._item('#e2e_shared')!.global_store._e2e_pre = 1))
  await expect.poll(hiddenCount, { timeout: 30_000 }).toBe(1)
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
  await expect.poll(hiddenCount, { timeout: 30_000 }).toBe(1)
  // the adopted update must be PERSISTED (merged probe present in the document) before
  // navigating away: a navigation discards a write not yet handed to the sdk
  await expect
    .poll(async () => (await storedHidden()).some(text => text.includes('_e2e_probe')), { timeout: 30_000 })
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
  await page.waitForTimeout(3_000) // allow the (dispatched) save to complete before checking
  await expect.poll(hiddenCount, { timeout: 30_000 }).toBe(1)
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
  ).toEqual(['_e2e_pre', '_e2e_probe', '_e2e_probe2']) // nothing lost across the shared-page saves
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
  expect(await page.evaluate(() => document.cookie)).not.toContain('__session=ey')
  // the firestore cache of the account was deleted (a fresh one is created for the anonymous account)
  await page.getByText('Stay Anonymous', { exact: true }).click()
  await waitForApp(page)
  expect(await page.evaluate(() => window._items().some(item => item.name == '#e2e_private'))).toBe(false)
})
