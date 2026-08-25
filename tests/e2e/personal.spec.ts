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
  // a warm-cache initialization (secret retained) is confirmed by the server with a
  // metadata-only snapshot that can arrive WHILE initialization runs: the queued settlement
  // must await initialization and still grant (round 8: it was discarded, leaving warm-cache
  // loads unauthoritative until the next data change)
  await expect
    .poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 15_000 })
    .toBe(true)
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
  // the OTHER owner-code execution paths, none of which passes through Item.eval: the
  // special-tag evaluator runs an item's js block directly, _html content is inserted with
  // {@html} where browser-native active content executes on its own, markdown links keep
  // javascript: urls by design, and a style item installs owner css into the page
  await firestore()
    .collection('items')
    .doc('e2e-foreign-vectors')
    .set({
      user: 'crawl_e2e',
      time: Date.now() - 1,
      text: [
        '#e2e_trap_vectors a foreign item with non-eval execution paths',
        '```js',
        'window.__SPECIAL_BYPASS = localStorage.getItem("mindpage_secret")',
        'function _special_tag_aliases() { return false }',
        '```',
        '```_html',
        '<iframe srcdoc="&lt;script&gt;parent.__HTML_BYPASS = 1&lt;/script&gt;"></iframe>',
        '<img src="x" onerror="window.__HTML_BYPASS = 2">',
        '<svg onload="window.__HTML_BYPASS = 3"><circle r="5"></circle></svg>',
        // a RAW style element: owner css that the style-item guard and the style-ATTRIBUTE
        // removal both miss, and which can overlay the page or build a page-wide click target
        '<style>body { --e2e-raw-css: injected }</style>',
        '```',
        // mathjax builds NEW dom from owner TeX after the render-time scrub, and TeX authors links
        'math link: $`\\href{javascript:window.__MATH_BYPASS=1}{click}`$',
        '[a javascript link](javascript:window.__LINK_BYPASS=1)',
      ].join('\n'),
      attr: { shared: { keys: ['trap'], indices: { trap: 1 } } },
    })
  await firestore()
    .collection('items')
    .doc('e2e-foreign-title')
    .set({
      user: 'crawl_e2e',
      time: Date.now() - 3,
      text: [
        '#webcam-title narration title',
        '```html',
        '<img src="x" onerror="window.__TITLE_BYPASS = 1">',
        '```',
      ].join('\n'),
      attr: { shared: { keys: ['trap'], indices: { trap: 3 } } },
    })
  await firestore()
    .collection('items')
    .doc('e2e-foreign-comment')
    .set({
      user: 'crawl_e2e',
      time: Date.now() - 4,
      // no math in this item: nothing re-scrubs it after the comment linkifier runs
      text: [
        '#e2e_trap_comment a foreign item with a hostile code comment',
        '```js',
        "// see https://evil.example/',globalThis.__POST_SCRUB=1,'",
        'const x = 1',
        '```',
      ].join('\n'),
      attr: { shared: { keys: ['trap'], indices: { trap: 4 } } },
    })
  // an owner-controlled source url reaches window.open through the source control
  await firestore()
    .collection('items')
    .doc('e2e-foreign-source')
    .set({
      user: 'crawl_e2e',
      time: Date.now() - 5,
      text: '#e2e_trap_source an item whose source control carries a javascript url',
      attr: {
        source: 'javascript:window.__SOURCE_BYPASS=1',
        shared: { keys: ['trap'], indices: { trap: 5 } },
      },
    })
  await firestore()
    .collection('items')
    .doc('e2e-foreign-style')
    .set({
      user: 'crawl_e2e',
      time: Date.now() - 2,
      text: ['#e2e_trap_style #_style', '```css', 'body { --e2e-owner-css: injected }', '```'].join('\n'),
      attr: { shared: { keys: ['trap'], indices: { trap: 2 } } },
    })
  try {
    await withSecret(page)
    await loadUser(page, ALICE)
    await waitForApp(page)
    // visit the foreign shared page as the signed-in visitor: the consent modal must gate code
    // (the standing shared-page welcome notice queues ahead of it and is dismissed first)
    const dismissNotice = async () => {
      const notice = page.locator('.modal .button', { hasText: 'View Shared Page' })
      // dispatchEvent, not click: narration mode (enabled below) overlays the page with the
      // webcam layer, which is topmost and swallows even a forced click — modal buttons listen
      // on mousedown, so dispatching to the element directly bypasses hit-testing
      if (await notice.isVisible({ timeout: 15_000 }).catch(() => false)) await notice.dispatchEvent('mousedown')
    }
    // narration is restored from local state, so a visitor can arrive with it already enabled —
    // the narration sink writes an item's RAW html into the page, outside toHTML
    await page.goto('/?shared=crawl_e2e/trap')
    await page.evaluate(() => localStorage.setItem('mindpage_narrating', 'true'))
    await page.reload()
    await dismissNotice()
    await expect(page.getByText(/includes code written by its owner/)).toBeVisible({ timeout: 60_000 })
    await page.locator('.modal .button.cancel', { hasText: 'View Only' }).dispatchEvent('mousedown')
    await expect(page.getByText('a foreign item with init code')).toBeVisible({ timeout: 60_000 }) // content renders
    expect(await page.evaluate(() => (window as any).__FOREIGN_RAN ?? null)).toBeNull() // code did NOT run
    expect(await page.evaluate(() => localStorage.getItem('mindpage_secret'))).toBeTruthy() // the asset the gate protects
    // ... and neither did any of the paths that never reach Item.eval
    await expect(page.getByText('non-eval execution paths')).toBeVisible({ timeout: 60_000 }) // rendered ...
    expect(await page.evaluate(() => (window as any).__SPECIAL_BYPASS ?? null)).toBeNull() // ... special-tag eval
    expect(await page.evaluate(() => (window as any).__HTML_BYPASS ?? null)).toBeNull() // ... {@html} content
    expect(await page.evaluate(() => document.querySelectorAll('iframe').length)).toBe(0) // frame removed
    expect(await page.evaluate(() => document.querySelectorAll('[onerror],[onload]').length)).toBe(0) // handlers gone
    // a javascript: link keeps its text but loses its href, so clicking it cannot navigate/execute
    const jsLink = page.getByText('a javascript link')
    await expect(jsLink).toBeVisible({ timeout: 30_000 })
    expect(await jsLink.getAttribute('href')).toBeNull()
    await jsLink.dispatchEvent('click')
    await page.waitForTimeout(1_000)
    expect(await page.evaluate(() => (window as any).__LINK_BYPASS ?? null)).toBeNull()
    // the code-comment linkifier runs in afterUpdate, AFTER the render-time scrub, and used to
    // build its click handler by interpolating the url into javascript source (html-escaped,
    // which the parser decodes before compiling the attribute). clicking such a link executed
    // the owner's expression despite View Only
    const comment = page.locator('.hljs-comment').first()
    if (await comment.isVisible({ timeout: 15_000 }).catch(() => false)) await comment.dispatchEvent('click')
    for (const link of await page.locator('.hljs-comment a').all()) await link.dispatchEvent('click')
    expect(await page.evaluate(() => (window as any).__POST_SCRUB ?? null)).toBeNull()
    expect(await page.evaluate(() => document.querySelectorAll('[onclick],[onmousedown]').length)).toBe(0)
    // the source control cannot navigate to an owner javascript: url either
    for (const src of await page.locator('.source, [class*="source"]').all())
      await src.dispatchEvent('click').catch(() => {})
    expect(await page.evaluate(() => (window as any).__SOURCE_BYPASS ?? null)).toBeNull()
    // safe links keep working but never carry an opener into this tab
    expect(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href^="http"]')).every(a =>
          (a.getAttribute('rel') ?? '').includes('noopener')
        )
      )
    ).toBe(true)
    // owner css is not installed either (it can overlay the page or build a click target) —
    // neither the special style item nor a RAW <style> element inside owner html
    expect(
      await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--e2e-owner-css').trim())
    ).toBe('')
    expect(
      await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--e2e-raw-css').trim())
    ).toBe('')
    expect(await page.evaluate(() => document.querySelectorAll('style[data-e2e], .item style').length)).toBe(0)
    // the narration sink wrote scrubbed html (its handler is gone), and mathjax's generated dom
    // is re-scrubbed after typesetting, so an owner-authored TeX link cannot execute either
    await page.waitForTimeout(2_000) // let narration fill and typesetting settle
    expect(await page.evaluate(() => (window as any).__TITLE_BYPASS ?? null)).toBeNull()
    expect(await page.evaluate(() => (window as any).__MATH_BYPASS ?? null)).toBeNull()
    expect(
      await page.evaluate(() => document.querySelectorAll('a[href^="javascript:"], [onerror], [onload]').length)
    ).toBe(0)
    // consenting runs the code, and the choice is remembered for the session (no re-prompt)
    await page.reload()
    await dismissNotice()
    await expect(page.getByText(/includes code written by its owner/)).toBeVisible({ timeout: 60_000 })
    await page.locator('.modal .button.confirm', { hasText: 'Run Code' }).dispatchEvent('mousedown')
    await expect.poll(() => page.evaluate(() => (window as any).__FOREIGN_RAN ?? null), { timeout: 60_000 }).toBe(1)
    // consent is PER LOAD and in memory: a stored record cannot be an integrity boundary against
    // code running in the same origin (an ungated anonymous visit could write one for another
    // uid), so the next load asks again rather than honoring anything persisted
    await page.reload()
    await dismissNotice()
    await expect(page.getByText(/includes code written by its owner/)).toBeVisible({ timeout: 60_000 })
    expect(await page.evaluate(() => (window as any).__FOREIGN_RAN ?? null)).toBeNull() // not yet run
    expect(
      await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('mindpage_run_code_')).length)
    ).toBe(0) // nothing persisted to forge against
    // an ANONYMOUS visitor keeps a working page (owner code runs), but that realm cannot
    // AUTHENTICATE anyone: the sign-in surface is removed from window.firebase before item code
    // runs, so owner code cannot open its own popup under an intercepted click and end up
    // holding a live session
    await page.goto('/') // sign out from a first-party page, not from the foreign one
    await waitForApp(page)
    await page.evaluate(() => void window._create('/_signout', { command: true }))
    await expect(page.getByText('Stay Anonymous', { exact: true })).toBeVisible({ timeout: 60_000 })
    await page.goto('/?shared=crawl_e2e/trap')
    await dismissNotice()
    await expect(page.getByText('a foreign item with init code')).toBeVisible({ timeout: 60_000 })
    expect(
      await page.evaluate(() =>
        [
          'signInWithPopup',
          'signInWithRedirect',
          'signInWithCustomToken',
          'signInAnonymously',
          'getRedirectResult',
        ].filter(m => typeof (window as any).firebase?.auth?.[m] == 'function')
      )
    ).toEqual([]) // no way to establish a session from this realm
    await withSecret(page)
    await loadUser(page, ALICE)
    await page.goto('/?shared=crawl_e2e/trap')
    await dismissNotice()
    // an authenticated visitor with NO stored secret is gated just the same: window.firebase
    // exposes their authenticated firestore/storage/auth handles and the id token sits in a
    // javascript-readable __session cookie, so the secret is not the only asset at risk
    await page.evaluate(() => {
      localStorage.removeItem('mindpage_secret')
      sessionStorage.clear() // drop the remembered consent for this check
    })
    await page.reload()
    await dismissNotice()
    await expect(page.getByText(/includes code written by its owner/)).toBeVisible({ timeout: 60_000 })
  } finally {
    for (const id of [
      'e2e-foreign-init',
      'e2e-foreign-vectors',
      'e2e-foreign-style',
      'e2e-foreign-title',
      'e2e-foreign-comment',
      'e2e-foreign-source',
    ])
      await firestore().collection('items').doc(id).delete()
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

test('a corrupt hidden change revokes authority until healed, and invalid records are reported not deleted', async ({ page }) => {
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
    .poll(
      async () => (await storedHidden()).some(text => text.includes('_e2e_probe3') && text.includes('_e2e_pre')),
      { timeout: 30_000 }
    )
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
