import { expect, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

// app globals used via page.evaluate (see window._* in index.svelte and client.ts)
declare global {
  interface Window {
    _items: () => { id: string; name: string; text: string; global_store?: Record<string, unknown> }[]
    _item: (
      name: string,
      silent?: boolean
    ) => {
      elem: HTMLElement | null
      delete: (confirm?: boolean) => void
      saved_id?: string
    } | null
    _render_item: (item: unknown) => Promise<HTMLElement>
    _create: (text: string, options?: object) => unknown
    _exists: (name: string) => boolean
    __items: { savedId?: string; labelText?: string }[] // internal item state
    _user: { uid: string }
    _init_time: number
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

// admin uid hard-coded in firestore.rules and index.svelte (isAdmin); signed in as this uid with
// ?user=anonymous, the app acts on the anonymous account with write access, as on mindbox.io
export const ADMIN_UID = 'y2swh7JY2ScO5soV7mJMHVltAOX2'

// custom token for the admin uid; unsigned, accepted by the auth emulator (FIREBASE_AUTH_EMULATOR_HOST)
// the user record is created first with a display name, without which the app's sign-in handler
// throws (sharer_name.match in index.svelte) before reaching isAdmin(), leaving the page read-only
export async function adminToken(): Promise<string> {
  const auth = getAuth(getApps()[0] ?? initializeApp({ projectId: 'olcanswiki' }))
  await auth
    .createUser({ uid: ADMIN_UID, displayName: 'E2E Admin', email: 'admin@e2e.test', emailVerified: true })
    .catch(e => {
      if (e.code != 'auth/uid-already-exists') throw e
    })
  return auth.createCustomToken(ADMIN_UID)
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

// signs in as the admin uid and loads the anonymous account with write access (see ADMIN_UID)
export async function loadAdmin(page: Page) {
  const token = await adminToken()
  await page.goto('/?user=anonymous')
  // fails fast if the served build predates the signInWithCustomToken export in client.ts
  await page.waitForFunction(() => !!window.firebase?.auth?.signInWithCustomToken, null, {
    timeout: 30_000,
  })
  // sign in without awaiting the result in-page: the app reloads itself when the auth state
  // changes, which destroys this evaluation's context; then wait for the reloaded app to be in
  // admin mode (acting on the anonymous account with write access)
  await page.evaluate(token => {
    void window.firebase.auth.signInWithCustomToken(window.firebase.auth.getAuth(window.firebase), token)
  }, token)
  await expect
    .poll(() => page.evaluate(() => window._init_time > 0 && window._readonly === false).catch(() => false), {
      timeout: 90_000,
    })
    .toBe(true)
  await waitForApp(page)
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
