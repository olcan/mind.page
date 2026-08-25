import { expect, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { createHash } from 'crypto'

// app globals used via page.evaluate (see window._* in index.svelte and client.ts)
declare global {
  interface Window {
    _items: () => { id: string; name: string; text: string; global_store?: Record<string, unknown> }[]
    _item: (
      name: string,
      silent?: boolean
    ) => {
      id: string
      elem: HTMLElement | null
      text: string
      saved_id?: string
      global_store: Record<string, unknown>
      write: (text: string) => void
      delete: (confirm?: boolean) => void
      share: (key: string, index?: number) => void
      unshare: (key: string) => void
    } | null
    _render_item: (item: unknown) => Promise<HTMLElement>
    _create: (text: string, options?: object) => unknown
    _exists: (name: string) => boolean
    __items: {
      id: string
      savedId?: string
      savedText?: string
      saving?: boolean
      labelText?: string
      matching?: boolean
      column?: number // assigned by updateItemLayout, used by the column template
    }[] // internal item state
    __hideIndex: number // items past this index are hidden (search results are ranked first)
    _user: { uid: string }
    _init_time: number // 0-ish (undefined) until initialization begins
    __rendered: boolean // initial (chunked) rendering complete, required by _render_item
    _readonly: boolean
    firebase: {
      auth: {
        getAuth: (app: unknown) => unknown
        signInWithCustomToken: (auth: unknown, token: string) => Promise<unknown>
      }
    }
  }
}

// test users in the auth emulator; a record needs a display name, without which the app's sign-in
// handler threw before reaching isAdmin() (fixed, but the e2e user should look like a real one)
export type TestUser = { uid: string; displayName: string; email: string }

// admin uid hard-coded in firestore.rules and index.svelte (isAdmin); signed in as this uid with
// ?user=anonymous, the app acts on the anonymous account with write access, as on mindbox.io
export const ADMIN: TestUser = {
  uid: 'y2swh7JY2ScO5soV7mJMHVltAOX2',
  displayName: 'E2E Admin',
  email: 'admin@e2e.test',
}

// a regular (personal) account; the uid must match \w+ for /user/<uid> (see server.ts)
export const ALICE: TestUser = { uid: 'alice_e2e', displayName: 'Alice Test', email: 'alice@e2e.test' }

// firebase-admin against the emulators (FIREBASE_AUTH_EMULATOR_HOST, FIRESTORE_EMULATOR_HOST are set
// by `firebase emulators:exec`); used to mint tokens and to inspect documents behind the app
export function admin() {
  return getApps()[0] ?? initializeApp({ projectId: 'olcanswiki' })
}
export function firestore() {
  return getFirestore(admin())
}

// custom token for a test user; unsigned, accepted by the auth emulator; the user record is
// created on first use
export async function customToken(user: TestUser): Promise<string> {
  const auth = getAuth(admin())
  await auth.createUser({ ...user, emailVerified: true }).catch(e => {
    if (e.code != 'auth/uid-already-exists') throw e
  })
  return auth.createCustomToken(user.uid)
}

// secret phrase as stored by the app in localStorage (mindpage_secret): base64 of sha-256(uid + phrase),
// see getSecretPhrase in index.svelte; lets tests skip the prompts and pins the derivation
export function secretFor(user: TestUser, phrase: string): string {
  return createHash('sha256')
    .update(user.uid + phrase)
    .digest('base64')
}

// waits for the app to be initialized and initially rendered
export async function waitForApp(page: Page) {
  // the global loading overlay (a top-level child of the app root, unlike per-item .loading divs) is
  // visible until initialized and rendered (see class:visible in index.svelte)
  await expect(page.locator('#sapper > .loading')).not.toHaveClass(/visible/, { timeout: 90_000 })
  await expect.poll(() => page.evaluate(() => window._init_time > 0)).toBe(true)
  // initial rendering continues in chunks after the overlay is hidden; _render_item requires it done
  await expect.poll(() => page.evaluate(() => window.__rendered), { timeout: 90_000 }).toBe(true)
}

// loads the anonymous account as a signed-out (read-only) visitor
export async function loadAnonymous(page: Page) {
  await page.goto('/')
  // read-only visitors are asked to sign in or stay anonymous on every visit (see index.svelte)
  await page.getByText('Stay Anonymous', { exact: true }).click({ timeout: 60_000 })
  await waitForApp(page)
}

// signs in as a test user on the given url and waits for the reloaded app to be signed in; the
// sign-in is not awaited in-page since the app reloads itself when the auth state changes
export async function signIn(page: Page, user: TestUser, url = '/') {
  const token = await customToken(user)
  await page.goto(url)
  // fails fast if the served build predates the signInWithCustomToken export in client.ts
  await page.waitForFunction(() => !!window.firebase?.auth?.signInWithCustomToken, null, { timeout: 30_000 })
  await page.evaluate(token => {
    // as signIn() in index.svelte: marks the sign-in as pending so that the reload does not start as
    // an anonymous visitor (whose welcome prompt would otherwise stay open, queueing later modals)
    sessionStorage.setItem('mindpage_signin_pending', '1')
    document.cookie = '__session=signin_pending;max-age=600'
    void window.firebase.auth.signInWithCustomToken(window.firebase.auth.getAuth(window.firebase), token)
  }, token)
  await expect
    .poll(() => page.evaluate(() => window._init_time > 0 && window._readonly === false).catch(() => false), {
      timeout: 90_000,
    })
    .toBe(true)
}

// signs in as the admin uid and loads the anonymous account with write access (see ADMIN)
export async function loadAdmin(page: Page) {
  await signIn(page, ADMIN, '/?user=anonymous')
  await waitForApp(page)
}

// signs in as a regular user and loads their personal account
export async function loadUser(page: Page, user: TestUser) {
  await signIn(page, user, '/')
  expect(await page.evaluate(() => window._user.uid)).toBe(user.uid)
}

// /_install prompts for a github personal access token (see index.svelte) unless one is stored, so
// tests seed one: any value works while github is intercepted (see interceptMindItems), otherwise
// set GITHUB_TOKEN to raise the unauthenticated rate limit
export async function useGithubToken(page: Page, token = process.env.GITHUB_TOKEN ?? 'e2e-local') {
  await page.addInitScript(token => localStorage.setItem('mindpage_github_token', token), token)
}

// serves github api requests for olcan/mind.items from a local checkout (default ../mind.items,
// override with MIND_ITEMS_DIR), so that /install works offline, within rate limits, and against
// uncommitted item changes; returns false (no interception) if the directory is missing
export async function interceptMindItems(page: Page): Promise<boolean> {
  const dir = resolve(process.env.MIND_ITEMS_DIR ?? '../mind.items')
  if (!existsSync(dir)) return false
  const sha = 'local-' + Date.now().toString(36) // stands in for the latest commit sha
  // after installing, the app watches the local repo via /watch/... (see watchLocalRepo), which the
  // production server only serves in dev mode; answer with no events to keep it quiet
  await page.route('**/watch/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await page.route('https://api.github.com/repos/olcan/mind.items/**', route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/repos/olcan/mind.items/', '')
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path == 'commits') {
      const file = url.searchParams.get('path') ?? ''
      if (!existsSync(resolve(dir, file))) return json(200, [])
      return json(200, [{ sha, commit: { message: 'local checkout', author: { date: new Date().toISOString() } } }])
    }
    if (path.startsWith('contents/')) {
      const file = decodeURIComponent(path.slice('contents/'.length))
      const abs = resolve(dir, file)
      if (!abs.startsWith(dir) || !existsSync(abs)) return json(404, { message: 'Not Found' })
      const content = readFileSync(abs).toString('base64')
      return json(200, {
        type: 'file',
        path: file,
        name: file.split('/').pop(),
        sha,
        content,
        encoding: 'base64',
      })
    }
    return route.continue()
  })
  return true
}
