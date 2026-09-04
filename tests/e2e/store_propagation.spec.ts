import { expect, test, type Page } from '@playwright/test'
import { customToken, firestore, install, interceptMindItems, secretFor, waitForApp, type TestUser } from './helpers.js'

// store-change propagation to items that EMBED a store owner (mind sync v2, slice 5a; design
// notes/design/mind_sync_store.md §3 and §6 in the vault). one self-contained personal account
// with only the generic #template utility installed (from the local mind.items checkout; the v2
// renderer is slice 5b): B's template region reads B's own store, A carries B's hidden tag and
// templates B, so A is a dependent of B and renders B through the real template() path. phases:
// (a) a foreign store delivery (a hidden document written behind the app) re-renders B AND the
// already-visible A without a reload or a visible-item write (server updateTime unchanged); (b) a
// local write through B's real saving accessor reaches A once the server holds it; (c) an
// item-and-store pair delivered in the two controlled orders, store observed before item and
// item observed before store, with an observable barrier between the two writes, pins the
// eventual output of the pair and of an embedding parent. the mutation pins are recorded in the
// review request, not automated
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

// a DEDICATED uid: every document under it is test-owned, so cleanup deletes them all by
// ownership (mind.page deliberately leaves a deleted item's store orphaned, so app deletion alone
// is not cleanup) and the account starts fresh (the kdf profile document is removed too, so the
// phrase flow is the first-sign-in flow every run)
const USER: TestUser = { uid: 'store_prop_e2e', displayName: 'Store Propagation', email: 'store_prop@e2e.test' }
const PHRASE = 'store propagation e2e phrase'
const SECRET = secretFor(USER, PHRASE)
const B = '#e2e_prop_b'
const A = '#e2e_prop_a'
// the admin-created pair items carry deterministic ids
const C_ID = 'e2e-prop-c'
const E_ID = 'e2e-prop-e'

// an owner whose template region reads its own store through the non-saving accessor
const ownerText = (label: string) =>
  `${label}\n<!-- template -->\nv=<<JSON.stringify(_this._global_store.v ?? null)>>\n<!-- /template -->`
// a parent that templates the owner: the dependency edge comes from the owner's HIDDEN tag (the
// app derives edges from hidden tags, exactly as the vault items carry #_vault/<path>), and the
// #_template tag makes template() available
const parentText = (label: string, owner: string) =>
  `${label} embeds <<template('${owner}')>> #_template #_${owner.slice(1)}`

async function cleanup() {
  const db = firestore()
  const docs = await db.collection('items').where('user', '==', USER.uid).get()
  for (const doc of docs.docs) await doc.ref.delete()
  await db.collection('users').doc(USER.uid).delete()
}

// answers a secret phrase prompt (as tests/e2e/personal.spec.ts)
async function enterPhrase(page: Page, prompt: RegExp, phrase: string, button: string) {
  await expect(page.getByText(prompt)).toBeVisible({ timeout: 60_000 })
  await page.fill('#modal-input', phrase)
  await page.locator('.modal .button.confirm', { hasText: button }).click()
}

// the item's on-screen element, else the app's own render of it (as tests/e2e/rendering.ts)
const rendered = (page: Page, name: string) =>
  page.evaluate(async name => {
    const item = window._item(name, true)
    if (!item) return null
    const expired = new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000))
    const elem = item.elem ?? (await Promise.race([window._render_item(item), expired]))
    return elem ? (elem as HTMLElement).textContent : null
  }, name)

const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)

// the app's hidden document shape (encryptItem of {hidden, time, attr: null, text} plus user),
// encrypted v0 with the account's stored secret, which the default-on reader accepts
async function writeStore(name: string, item: unknown) {
  const { encryptWithSecret } = await import('../../src/crypto.js')
  const time = Date.now()
  const text = JSON.stringify({ name, item })
  const cipher = await encryptWithSecret(JSON.stringify({ hidden: true, time, attr: null, text }), SECRET)
  await firestore()
    .collection('items')
    .doc()
    .set({ user: USER.uid, time, hidden: true, text: null, attr: null, cipher })
}

// the store value the server holds under a wrapper name (decrypting every hidden document of
// the account, since names live inside the ciphertext), or null when none does
async function serverStore(name: string): Promise<unknown> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const snap = await firestore().collection('items').where('user', '==', USER.uid).where('hidden', '==', true).get()
  for (const doc of snap.docs) {
    try {
      const plain = JSON.parse(await decryptWithSecret(doc.data().cipher, SECRET))
      const wrapper = JSON.parse(plain.text)
      if (wrapper.name == name) return wrapper.item
    } catch {} // an unrelated or differently keyed record
  }
  return null
}

// a plaintext visible item written behind the app (the app applies it as a remote add)
async function writeItem(id: string, text: string) {
  await firestore().collection('items').doc(id).set({ user: USER.uid, time: Date.now(), text, attr: null })
}

// the server's write times of documents: the exact witness that nothing rewrote them (the app's
// own `time` field survives a redundant rewrite of the same payload)
const updateTimes = async (ids: string[]) => {
  const out: Record<string, number | null> = {}
  for (const id of ids) out[id] = (await firestore().collection('items').doc(id).get()).updateTime?.toMillis() ?? null
  return out
}

test.beforeAll(cleanup)
test.afterAll(cleanup)

test('a store change re-renders the owner and the items that template it', async ({ page }) => {
  // the generic #template utility installs from the local mind.items checkout with the fake token
  // (as loadAdmin does; the route is always intercepted, so no real token is involved)
  expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
  await page.addInitScript(() => localStorage.setItem('mindpage_github_token', 'e2e-local'))
  // a fresh account: sign in by custom token, then the first-sign-in phrase flow
  const token = await customToken(USER)
  await page.goto('/')
  await page.waitForFunction(() => !!window.firebase?.auth?.signInWithCustomToken, null, { timeout: 30_000 })
  await page.evaluate(token => {
    sessionStorage.setItem('mindpage_signin_pending', '1')
    document.cookie = '__session=signin_pending;max-age=600'
    void window.firebase.auth.signInWithCustomToken(window.firebase.auth.getAuth(window.firebase), token)
  }, token)
  await expect
    .poll(() => page.evaluate(() => window._init_time > 0 && window._readonly === false).catch(() => false), {
      timeout: 90_000,
    })
    .toBe(true)
  await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
  await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
  await waitForApp(page)
  expect(await install(page, 'template')).toBeNull()
  // reload so the utility's init code has run; the stored secret decrypts without a prompt
  await page.reload()
  await waitForApp(page)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 30_000 }).toBe(true)
  const warnings: string[] = []
  page.on('console', m => {
    if (m.type() == 'warning') warnings.push(m.text())
  })

  await page.evaluate(text => void window._create(text), ownerText(B))
  await expect.poll(() => savedId(page, B), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(text => void window._create(text), parentText(A, B))
  await expect.poll(() => savedId(page, A), { timeout: 30_000 }).toBeTruthy()
  const bId = (await savedId(page, B))!
  const aId = (await savedId(page, A))!
  // dependents hold LOCAL ids (a fresh item keeps its temporary id in this session)
  const aLocal = await page.evaluate(([A]) => window._item(A)!.id, [A] as const)
  expect(await page.evaluate(([B]) => (window._item(B) as any).dependents as string[], [B] as const)).toContain(aLocal)
  await expect.poll(() => rendered(page, B)).toContain('v=null')
  await expect.poll(() => rendered(page, A)).toContain('v=null')

  // (a) a foreign store delivery re-renders B and the already-visible A with no visible write:
  // the two documents' server write times must have settled (two non-null samples half a second
  // apart agree) and then stay unchanged
  let before: Record<string, number | null> = {}
  await expect
    .poll(async () => {
      const first = await updateTimes([aId, bId])
      await new Promise(resolve => setTimeout(resolve, 500))
      const second = await updateTimes([aId, bId])
      const stable = Object.values(first).every(t => t !== null) && JSON.stringify(first) == JSON.stringify(second)
      if (stable) before = second
      return stable
    })
    .toBe(true)
  await writeStore(`global_store_${bId}`, { v: 1 })
  await expect.poll(() => rendered(page, B), { timeout: 30_000 }).toContain('v=1')
  await expect.poll(() => rendered(page, A), { timeout: 30_000 }).toContain('v=1')
  expect(await updateTimes([aId, bId])).toEqual(before)

  // (b) a local write through B's real saving accessor reaches A once the server holds it
  await page.evaluate(([B]) => void (window._item(B)!.global_store.v = 2), [B] as const)
  await expect.poll(() => serverStore(`global_store_${bId}`), { timeout: 30_000 }).toEqual({ v: 2 })
  await expect.poll(() => rendered(page, A), { timeout: 30_000 }).toContain('v=2')
  await expect.poll(() => rendered(page, B), { timeout: 30_000 }).toContain('v=2')

  // (c1) store observed before item: the store arrives for a missing owner (the app's warning is
  // the barrier), then the item; the pair and a parent created afterwards settle on the value
  const cName = '#e2e_prop_c'
  await writeStore(`global_store_${C_ID}`, { v: 7 })
  await expect
    .poll(() => warnings.some(w => w.includes(`missing local item for remote-added hidden item global_store_${C_ID}`)), {
      timeout: 30_000,
    })
    .toBe(true)
  await writeItem(C_ID, ownerText(cName))
  await expect.poll(() => rendered(page, cName), { timeout: 30_000 }).toContain('v=7')
  await page.evaluate(text => void window._create(text), parentText('#e2e_prop_d', cName))
  await expect.poll(() => savedId(page, '#e2e_prop_d'), { timeout: 30_000 }).toBeTruthy()
  await expect.poll(() => rendered(page, '#e2e_prop_d'), { timeout: 30_000 }).toContain('v=7')

  // (c2) item observed before store: the item renders with no store (the barrier), an embedding
  // parent is created while the store is still absent, then the store arrives and both update
  const eName = '#e2e_prop_e'
  await writeItem(E_ID, ownerText(eName))
  await expect.poll(() => rendered(page, eName), { timeout: 30_000 }).toContain('v=null')
  await page.evaluate(text => void window._create(text), parentText('#e2e_prop_f', eName))
  await expect.poll(() => savedId(page, '#e2e_prop_f'), { timeout: 30_000 }).toBeTruthy()
  await expect.poll(() => rendered(page, '#e2e_prop_f'), { timeout: 30_000 }).toContain('v=null')
  await writeStore(`global_store_${E_ID}`, { v: 9 })
  await expect.poll(() => rendered(page, eName), { timeout: 30_000 }).toContain('v=9')
  await expect.poll(() => rendered(page, '#e2e_prop_f'), { timeout: 30_000 }).toContain('v=9')
})
