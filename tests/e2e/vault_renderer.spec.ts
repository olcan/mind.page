import { expect, test, type Page } from '@playwright/test'
import { customToken, firestore, install, interceptMindItems, secretFor, waitForApp, type TestUser } from './helpers.js'

// the #template/vault renderer over REAL hidden documents (mind sync v2, slice 5b; design
// notes/design/mind_sync_store.md §3 and §6 in the vault). one self-contained personal account
// that installs the candidate renderer (and, through it, the generic #template utility) from the
// local mind.items checkout: a config item C whose navigation targets a section item S, their
// `_vault` stores written behind the app as encrypted hidden documents; phases: (a) adoption: C
// and S render their stored previews (C nests S's navigation), the badge compares the editable
// source with the pinned source, no source control; (b) the non-saving accessor: rendering,
// including the expanded context, schedules no store save for either owner and leaves the
// server ciphers unchanged, starting from a stale non-empty in-memory copy; (c) store-driven
// propagation through the renderer: a store-only replace of S's `_vault` re-renders S and the
// already-visible C without a reload or a visible-item write
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const USER: TestUser = { uid: 'vault_renderer_e2e', displayName: 'Vault Renderer', email: 'vault_renderer@e2e.test' }
const PHRASE = 'vault renderer e2e phrase'
const SECRET = secretFor(USER, PHRASE)
const C_PATH = 'agents/e2e_prc.md'
const S_PATH = 'agents/e2e_prs.md'
const label = (p: string) => '#vault/' + p.replace(/\.md$/, '')
const C = label(C_PATH)
const S = label(S_PATH)
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
const C_SOURCE = '---\nbase: agents/e2e_prs.md\n---\nIntro\n![[agents/e2e_prs]]\n'
const S_SOURCE = 'Section text\n'
const cStore = (sText: string) => ({
  v: 2,
  path: C_PATH,
  pinned_source: C_SOURCE,
  head_preview: {
    kind: 'config',
    navigation: [{ text: 'Intro\n' }, { target: S_PATH }],
    base: null,
    exact: { profile: 'bare', instructions: 'C instructions ' + sText, run_instructions: null, user_prompt: null },
  },
})
const sStore = (text: string, pinned = S_SOURCE) => ({
  v: 2,
  path: S_PATH,
  pinned_source: pinned,
  head_preview: { kind: 'section', navigation: [{ text }], base: null, exact: null },
})

async function cleanup() {
  const db = firestore()
  const docs = await db.collection('items').where('user', '==', USER.uid).get()
  for (const doc of docs.docs) await doc.ref.delete()
  await db.collection('users').doc(USER.uid).delete()
}

async function enterPhrase(page: Page, prompt: RegExp, phrase: string, button: string) {
  await expect(page.getByText(prompt)).toBeVisible({ timeout: 60_000 })
  await page.fill('#modal-input', phrase)
  await page.locator('.modal .button.confirm', { hasText: button }).click()
}

const rendered = (page: Page, name: string) =>
  page.evaluate(async name => {
    const item = window._item(name, true)
    if (!item) return null
    const expired = new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000))
    const elem = item.elem ?? (await Promise.race([window._render_item(item), expired]))
    if (!elem) return null
    const content = (elem as HTMLElement).querySelector('.content') as HTMLElement | null
    return {
      text: content?.textContent ?? '',
      carriers: [...(content?.querySelectorAll('pre code') ?? [])].map(c => c.textContent ?? ''),
      toggles: [...(content?.querySelectorAll('span.template_toggle') ?? [])].map(s => s.textContent ?? ''),
      badge: (elem as HTMLElement).querySelector('[title="managed by the vault sync"]')?.textContent ?? '',
    }
  }, name)

const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)

// the app's hidden document shape, encrypted v0 with the account's stored secret
async function writeStore(id: string, name: string, item: unknown) {
  const { encryptWithSecret } = await import('../../src/crypto.js')
  const time = Date.now()
  const cipher = await encryptWithSecret(JSON.stringify({ hidden: true, time, attr: null, text: JSON.stringify({ name, item }) }), SECRET)
  await firestore().collection('items').doc(id).set({ user: USER.uid, time, hidden: true, text: null, attr: null, cipher })
}
const cipherOf = async (id: string) => (await firestore().collection('items').doc(id).get()).data()?.cipher ?? null
const updateTime = async (id: string) => (await firestore().collection('items').doc(id).get()).updateTime?.toMillis() ?? null
// the decrypted text of a visible document as the SERVER holds it (the app writes v0 ciphers
// under its default write gate), or null: the acknowledgement barrier for an app-side edit
async function serverText(id: string): Promise<string | null> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const data = (await firestore().collection('items').doc(id).get()).data()
  if (!data?.cipher) return data?.text ?? null
  try {
    return JSON.parse(await decryptWithSecret(data.cipher, SECRET)).text ?? null
  } catch {
    return null
  }
}

test.beforeAll(cleanup)
test.afterAll(cleanup)

test('the renderer reads real hidden stores, saves nothing, and follows store-only changes', async ({ page }) => {
  expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
  await page.addInitScript(() => localStorage.setItem('mindpage_github_token', 'e2e-local'))
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
  // the candidate renderer from the local checkout (its #_///template dependency comes with it)
  expect(await install(page, 'template/vault'), '/_install template/vault').toBeNull()
  await page.reload()
  await waitForApp(page)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 30_000 }).toBe(true)
  expect(await page.evaluate(() => window._exists('#template/vault') && window._exists('#template')), 'renderer and #template installed').toBe(true)

  // the two managed items (S first: C's tag line depends on it), then their stores behind the app
  await page.evaluate(t => void window._create(t), itemText(S_PATH, S_SOURCE, []))
  await expect.poll(() => savedId(page, S), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(t => void window._create(t), itemText(C_PATH, C_SOURCE, [S_PATH]))
  await expect.poll(() => savedId(page, C), { timeout: 30_000 }).toBeTruthy()
  const sId = (await savedId(page, S))!
  const cId = (await savedId(page, C))!
  // before any store: both fail closed as missing
  await expect.poll(async () => (await rendered(page, S))?.badge, { timeout: 30_000 }).toBe('vault store missing')
  await expect.poll(async () => (await rendered(page, C))?.badge, { timeout: 30_000 }).toBe('vault store missing')
  const S_STORE_ID = 'e2e-prs-store'
  const C_STORE_ID = 'e2e-prc-store'
  await writeStore(S_STORE_ID, `global_store_${sId}`, { _vault: sStore('S one\n') })
  await writeStore(C_STORE_ID, `global_store_${cId}`, { _vault: cStore('one') })

  // (a) adoption: the stored previews render; C nests S; the badges compare the editable source
  // with the pinned source; no source control anywhere
  await expect.poll(async () => (await rendered(page, S))?.badge, { timeout: 30_000 }).toBe('section · ' + S_PATH)
  await expect.poll(async () => (await rendered(page, C))?.badge, { timeout: 30_000 }).toBe('config · ' + C_PATH)
  await expect.poll(async () => (await rendered(page, C))?.carriers ?? [], { timeout: 30_000 }).toContain('C instructions one')
  const c1 = (await rendered(page, C))!
  expect(c1.carriers, 'C nests S\'s navigation text').toContain('S one\n')
  expect(c1.carriers, 'the editable source is never a carrier').not.toContain(C_SOURCE)
  expect(c1.toggles.join('|'), 'no source control').not.toContain('⋮ source')
  expect(c1.toggles.some(t => t.includes('instructions (bare profile)')), 'the instructions control').toBe(true)
  // an edited source shows the differs form the moment it renders, without any sync; the edit
  // must then be acknowledged by the server before phase (c)'s no-visible-write baseline
  const sEdited = itemText(S_PATH, S_SOURCE + 'edited\n', [])
  await page.evaluate(([n, t]) => void window._item(n)!.write(t, ''), [S, sEdited] as const)
  await expect.poll(async () => (await rendered(page, S))?.badge, { timeout: 30_000 }).toBe('section · ' + S_PATH + ' · differs from the stored sync snapshot')
  await expect.poll(() => serverText(sId), { timeout: 30_000 }).toBe(sEdited)

  // (b) the non-saving accessor: from a stale non-empty in-memory copy, evaluating both macros
  // of C and S in the ordinary and the expanded context schedules no store save for either
  // owner (the seam counter increments synchronously, scoped to the two owners, so the results
  // of the evaluations themselves are the completion witness) and leaves both server ciphers
  // unchanged
  const cipherS = await cipherOf(S_STORE_ID)
  const cipherC = await cipherOf(C_STORE_ID)
  expect(cipherS && cipherC, 'both stores exist on the server').toBeTruthy()
  const evaluated = await page.evaluate(([c, s]) => {
    const w = window as any
    w.__storeSaves = 0
    const proto = Object.getPrototypeOf(window._item(c)!)
    const original = proto.save_global_store
    proto.save_global_store = function (...args: unknown[]) {
      if (this.name == c || this.name == s) w.__storeSaves++
      return original.apply(this, args)
    }
    // a stale non-empty in-memory copy: the app's memory differs from the applied index
    ;(window._item(s) as any)._global_store._stale = 1
    const out: Record<string, string> = {}
    try {
      for (const n of [c, s]) {
        out[n + ':ordinary'] = String((window._item(n) as any).eval_macros('<<vault_badge()>> <<vault_render()>>'))
        out[n + ':expanded'] = String((window._item(n) as any).eval_macros('<<vault_badge()>> <<vault_render()>>', { context: 'expanded' }))
      }
    } finally {
      proto.save_global_store = original
      delete (window._item(s) as any)._global_store._stale
    }
    return { out, saves: w.__storeSaves as number }
  }, [C, S] as const)
  expect(evaluated.out[C + ':ordinary'], 'C renders its composition in the ordinary context').toContain('class="vault"')
  expect(evaluated.out[C + ':ordinary'], 'C badge in the ordinary context').toContain('title="managed by the vault sync"')
  expect(evaluated.out[C + ':expanded'], 'C expanded context is its instructions').toContain('C instructions one')
  expect(evaluated.out[S + ':expanded'], 'S expanded context is the navigation-only string').toContain('vault: navigation only')
  expect(evaluated.saves, 'no store save scheduled by rendering').toBe(0)
  expect(await cipherOf(S_STORE_ID), 'the S store cipher is unchanged').toBe(cipherS)
  expect(await cipherOf(C_STORE_ID), 'the C store cipher is unchanged').toBe(cipherC)

  // (c) store-driven propagation through the renderer: a store-only replace of S's `_vault`
  // re-renders S and the already-visible C, with both visible documents unwritten
  const before = { s: await updateTime(sId), c: await updateTime(cId) }
  await writeStore(S_STORE_ID, `global_store_${sId}`, { _vault: sStore('S two\n', S_SOURCE + 'edited\n') })
  await expect.poll(async () => (await rendered(page, S))?.carriers ?? [], { timeout: 30_000 }).toContain('S two\n')
  await expect.poll(async () => (await rendered(page, S))?.badge, { timeout: 30_000 }).toBe('section · ' + S_PATH)
  await expect.poll(async () => (await rendered(page, C))?.carriers ?? [], { timeout: 30_000 }).toContain('S two\n')
  expect({ s: await updateTime(sId), c: await updateTime(cId) }, 'no visible-item write').toEqual(before)
})
