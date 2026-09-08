import { expect, test } from '@playwright/test'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { customToken, firestore, secretFor, waitForApp, type TestUser } from './helpers.js'
import { requireLocalEmulators } from './init_perf_guard.js'

// FAIL CLOSED before any firebase use or corpus read: the seed writes the exported corpus at its
// original document ids, so this file must never run against a real project (init_perf_guard.ts)
requireLocalEmulators(process.env)

// INIT RESPONSIVENESS HARNESS (not a gate: the .perf.ts name keeps it out of playwright.config.ts's projects; run through init_perf.config.ts): seeds an owner-shaped corpus (an exported,
// decrypted item set, re-encrypted here under a test account: v1 rows under a seeded envelope, v0
// rows under the test secret, plaintext rows as they are) and measures, per CPU throttle, the cold
// (server) and warm (persistent cache) start: when the loading overlay hides, when the deferred
// rendering finishes, the first moment the main thread is free, and the long tasks in between.
// run: tmp/init_perf/run.sh (emulators + server); OWNER_CORPUS points at the exported json
//
// HOW THIS HARNESS DIFFERS FROM PRODUCTION (keep this list current; each item is a deliberate choice):
//  1. server + host: the production build served by the same node server (server.mjs: the express
//     middleware, the LOCAL PROXY at /proxy/<backend>/… mounted unconditionally, kit's handler) on
//     http://localhost:3100 (NO_HTTPS=1, NODE_ENV=production, CONTENT_CACHE_MS=100); no deployed
//     hosting/ssr transport. the app is in LOCALHOST mode: after init it fetches a preview of every
//     installed item via /file/<repo>/<path> from the served checkout's SIBLING directory (parsing and
//     attr.embeds rebuilding cost real work even when nothing is written) and then requests /watch/,
//     which this server answers 404 (chokidar loads only in dev) so the client stops with one warning.
//     production never runs the watcher. the seed keeps the previews equal to the items (see 4).
//  2. backend: firebase auth + firestore EMULATORS on loopback (requireLocalEmulators), no production
//     latency; the whole corpus round-trips on this machine. a fresh emulator state per invocation is
//     the runner's doing (emulators:exec), not enforced here; the seed runs ONCE before the rate loop,
//     so item and store writes made during a start persist into the warm starts and the later rates
//     (each rate gets a fresh browser context, not a fresh corpus).
//  3. account: a synthetic user seeded from the exported owner corpus at its original document ids
//     (v1 rows re-encrypted under a seeded envelope, v0 rows under the test secret, plaintext rows as
//     they are); sign-in by custom token with the v0 secret and the bound v1 envelope in localStorage
//     — credentials only: no device preferences or item local stores, no writer flag (v1 writing and
//     lazy migration are off), no google sign-in, no phrase prompt.
//  4. installed items: their text is refreshed from the served checkout, byte-for-byte as the app's
//     preview would render it (source file + embed blocks), so the watcher finds nothing to write;
//     attr (source/repo/sha/embeds/token) stays as exported, so attr.sha is the export's, not the
//     checkout's. a production item holds its installed github revision plus any local edits.
//  5. network: DIRECT browser requests are OFFLINE by default (init_perf.config.ts: a chromium
//     host-resolver rule, so the http cache is untouched) except loopback (localhost, 127.0.0.1,
//     ::1: the server and the emulators) and the hosts app.html loads libraries and fonts from
//     (cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com, fonts.googleapis.com, fonts.gstatic.com;
//     item content on those hosts loads too). NOT covered: the server's local proxy (/proxy/…
//     forwards through node and resolves on its own; nothing used it in the measured runs). effects:
//     #updater's github checks stop at their first failed request (one warning per load) and its
//     github_webhooks listener still registers against the emulator; #pusher fails at its branch
//     lookup, so its welcome-time mirror fetch, corpus hashing and pushable reconciliation do not run;
//     #gapi's google api scripts and calendar refreshes fail fast; direct requests to other hosts fail
//     resolution, including embedded images on those hosts. PERF_ONLINE=1 lifts the browser rule
//     only (real direct requests with the credentials the corpus carries: per-item github token, gapi
//     client secret and tokens; updates may be applied and modals shown; firestore stays the
//     emulator) — use it to measure that part of init deliberately, never by default.
//  6. cpu: the BROWSER is throttled with CDP Emulation.setCPUThrottlingRate (PERF_RATES, default
//     1,4,6); the node server and the emulators are not, and no network throttling is applied (a
//     Slow-4G run needs Network.emulateNetworkConditions on the same cdp session). this is not a
//     slower device end to end.
//  7. cold / warm: the context is fresh (empty http cache and storage) for the ANONYMOUS first visit
//     that installs the credentials and signs in; the measured COLD start is the auth-triggered
//     reload that follows, so the account's corpus comes from the server (no firestore persistence
//     yet) while the page's assets were already requested once. warm1/warm2 are reloads of the same
//     page with the persistence cache primed (and with whatever the earlier starts wrote, see 2).
//     an empty-asset-cache start is a separate experiment; production cold starts also pay real
//     network and hosting transport that no number here includes.
//  8. instrumentation: an init script hooks console.debug for the app's init_log marks, observes
//     long tasks and paint (first-contentful-paint as the browser reports it; nothing here says
//     what was painted), polls the overlay and __rendered with rAF, and runs a 50 ms timer-drift
//     probe — an unquantified overhead present in every measured run and absent in production.
//     phase blocking assigns each long task to the phase where it STARTS, and the after-overlay
//     fields include the QUIET_MS settling window after __rendered. PERF_PROFILE=1 samples the cpu
//     every 500 µs for all three starts of the first rate: keep profile runs out of timing baselines.
//  9. not exercised: first sign-in and phrase flows, multiple tabs, the shared and pwa scopes, github
//     webhook DELIVERY (the listener is registered, see 5). a minimal service worker
//     (src/service-worker.ts) is registered by kit in both production and here.
const PERF: TestUser = { uid: 'perf_e2e', displayName: 'Perf Test', email: 'perf@e2e.test' }
const PHRASE = 'perf phrase'
const SALT = 'BwcHBwcHBwcHBwcHBwcHBw=='
const KEY_BYTES = new Uint8Array(32).map((_, i) => 64 + i)
const KEY_B64 = 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=' // KEY_BYTES, canonical base64
const RATES = (process.env.PERF_RATES ?? '1,4,6').split(',').map(Number)
const QUIET_MS = 8_000 // after __rendered: let the deferred chunks and welcome hooks run out
const RESULTS = process.env.PERF_RESULTS ?? '/Users/olcan/vault/tmp/init_perf/results.jsonl'
const TAG = process.env.PERF_TAG ?? ''

type Perf = {
  longtasks: { s: number; d: number }[]
  drift: { t: number; g: number }[]
  marks: { t: number; m: string }[] // the app's init_log lines, captured in-page
  overlay: number
  rendered: number
  firstPaint: number
}

// instrumentation installed before every navigation: long tasks (buffered), a 50 ms timer-drift
// probe, and rAF/interval polls that record when the overlay hid and when __rendered flipped —
// both polls run only when the main thread is free, so the times are "responsive" times
const instrument = (page: import('@playwright/test').Page) =>
  page.addInitScript(() => {
    const w = window as any
    const perf: Perf = { longtasks: [], drift: [], marks: [], overlay: 0, rendered: 0, firstPaint: 0 }
    w.__perf = perf
    const debug = console.debug.bind(console)
    console.debug = (...args: unknown[]) => {
      const m = /^\[(\d+)ms\] (.*)$/.exec(String(args[0]))
      if (m) perf.marks.push({ t: +m[1], m: m[2] })
      debug(...args)
    }
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) perf.longtasks.push({ s: Math.round(e.startTime), d: Math.round(e.duration) })
      }).observe({ type: 'longtask', buffered: true })
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) if (e.name == 'first-contentful-paint') perf.firstPaint = Math.round(e.startTime)
      }).observe({ type: 'paint', buffered: true })
    } catch {}
    let last = performance.now()
    setInterval(() => {
      const now = performance.now()
      const gap = now - last - 50
      if (gap > 100) perf.drift.push({ t: Math.round(now), g: Math.round(gap) })
      last = now
    }, 50)
    const poll = () => {
      const overlay = document.querySelector('#sapper > .loading')
      if (!perf.overlay && overlay && !overlay.classList.contains('visible')) perf.overlay = Math.round(performance.now())
      if (!perf.rendered && w.__rendered === true) perf.rendered = Math.round(performance.now())
      if (!perf.overlay || !perf.rendered) requestAnimationFrame(poll)
    }
    requestAnimationFrame(poll)
  })

const summarize = (perf: Perf) => {
  const marks = perf.marks
  const tasks = perf.longtasks
  const tbt = (from: number, to: number) =>
    tasks.filter(t => t.s >= from && t.s < to).reduce((sum, t) => sum + Math.max(0, t.d - 50), 0)
  const longest = tasks.reduce((m, t) => Math.max(m, t.d), 0)
  // a retrospective HEURISTIC, not elapsed time to responsiveness: the first moment at or after
  // the overlay hid with no recorded long task in the following 500 ms (under paced rendering the
  // turns are short but frequent, so it tends to the end of the render; report the fields below)
  let responsive = perf.overlay
  for (const t of tasks.filter(t => t.s + t.d > perf.overlay).sort((a, b) => a.s - b.s)) {
    if (t.s > responsive + 500) break
    responsive = Math.max(responsive, t.s + t.d)
  }
  const end = perf.rendered ? perf.rendered + QUIET_MS : Infinity
  const mark = (name: string) => marks.find(m => m.m.startsWith(name))?.t ?? null
  return {
    overlay_hidden_ms: perf.overlay,
    first_responsive_ms: responsive,
    rendered_ms: perf.rendered,
    first_paint_ms: perf.firstPaint,
    initialized_client_ms: mark('initialized client'),
    initialized_items_ms: marks.find(m => /^initialized \d+ items/.test(m.m))?.t ?? null,
    initialized_document_ms: mark('initialized document'),
    server_confirmed_ms: mark('server-confirmed corpus'),
    corpus_settled_ms: mark('corpus settled'),
    longtasks: tasks.length,
    longest_task_ms: longest,
    // after the page is visible: the longest task and the count of tasks over 100 ms whose START
    // is at or after the overlay hid (through the settling window after __rendered); tasks are
    // attributed by start time, a boundary-crossing task counts where it starts
    longest_after_overlay_ms: tasks.filter(t => t.s >= perf.overlay).reduce((m, t) => Math.max(m, t.d), 0),
    tasks_over_100_after_overlay: tasks.filter(t => t.s >= perf.overlay && t.d > 100).length,
    tbt_before_overlay_ms: tbt(0, perf.overlay),
    tbt_overlay_to_rendered_ms: tbt(perf.overlay, perf.rendered),
    tbt_after_rendered_ms: tbt(perf.rendered, end),
    tasks_over_1s: tasks.filter(t => t.d >= 1000).map(t => `${t.s}+${t.d}`).slice(0, 12),
    chunk_marks: marks.filter(m => m.m.startsWith('rendered ')).map(m => `${m.t}:${m.m.split(' ')[1]}`),
    drift_max_ms: perf.drift.reduce((m, d) => Math.max(m, d.g), 0),
  }
}

test.setTimeout(45 * 60_000)

test('init responsiveness on the owner-shaped corpus, cold and warm, per CPU throttle', async ({ browser }) => {
  const { encryptWithSecret, encryptV1Text, importV1Key } = await import('../../src/crypto.js')
  const v1key = await importV1Key(KEY_BYTES)
  const secret = secretFor(PERF, PHRASE)
  const { items } = JSON.parse(readFileSync(process.env.OWNER_CORPUS!, 'utf8'))
  const db = firestore()
  await db.collection('users').doc(PERF.uid).set({ displayName: PERF.displayName, kdf: { v: 1, salt: SALT } }, { merge: true })
  let batch = db.batch()
  let n = 0
  const counts = { v1: 0, v0: 0, plain: 0 }
  // INSTALLED ITEMS ARE REFRESHED FROM THE SERVED CHECKOUT, exactly as the app's localhost preview
  // would render them (fetchPreview: the source file, each ```lang:path embed block body replaced by
  // that file's text verbatim, resolve_embed_path semantics), so the app finds every preview equal to
  // its item and writes nothing. items stay installed (source/repo/sha/embeds/token untouched): on the
  // owner's account they are, and the app's watcher, #updater and #pusher paths run as they do there.
  // the app serves /file/<repo>/<path> from the served checkout's SIBLING directory (src/server/app.mjs),
  // which is what this reads too; a checkout renderer change is therefore measured (this replaces the
  // PERF_PATCH_VAULT_JS block patch, whose stripped trailing newline was itself a drift the app's
  // auto-preview then wrote back into #template/vault inside the cold start, 2026-09-08).
  // fail closed: an installed item whose repo is not a sibling checkout aborts the seed
  // the served checkout's sibling directory, from THIS file's location (tests/e2e/ under the checkout),
  // not from the cwd of whoever invoked playwright
  const repoDir = (repo: string) => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', repo)
  const embedPath = (sfx: string, itemPath: string) =>
    sfx.startsWith('/') || !itemPath.includes('/', 1) ? sfx : itemPath.substr(0, itemPath.lastIndexOf('/')) + '/' + sfx
  const refreshed = { items: 0, changed: 0 }
  const refresh = (inner: { text: string; attr?: Record<string, any> | null }) => {
    const attr = inner.attr
    if (!attr?.source) return
    const root = repoDir(attr.repo)
    if (!existsSync(root)) throw new Error(`installed item from ${attr.repo} but ${root} does not exist (expected the served checkout's sibling)`)
    let text = readFileSync(join(root, attr.path.replace(/^\//, '')), 'utf8')
    text = text.replace(/((?:^|\n) *)```(\S+):(\S+?)\n(.*?)\n```/gs, (m: string, mpfx: string, pfx: string, sfx: string) => {
      if (!sfx.includes('.')) return m // not a path
      const embed = readFileSync(join(root, embedPath(sfx, attr.path).replace(/^\//, '')), 'utf8')
      return mpfx + '```' + pfx + ':' + sfx + '\n' + embed + '\n```'
    })
    refreshed.items++
    if (text != inner.text) refreshed.changed++
    inner.text = text
  }
  for (const row of items) {
    let { id, plain, version, error: _error, ...fields } = row
    if (plain) {
      const inner = JSON.parse(plain)
      refresh(inner)
      plain = JSON.stringify(inner)
    } else refresh(fields as { text: string; attr?: Record<string, any> | null })
    const doc: Record<string, unknown> = { ...fields, user: PERF.uid }
    if (version == 'v1') (doc.cipher = await encryptV1Text(plain, v1key)), counts.v1++
    else if (version == 'v0') (doc.cipher = await encryptWithSecret(plain, secret)), counts.v0++
    else counts.plain++
    batch.set(db.collection('items').doc(id), doc)
    if (++n % 400 == 0) {
      await batch.commit()
      batch = db.batch()
    }
  }
  await batch.commit()
  console.log(`seeded ${n} items for ${PERF.uid}: ${JSON.stringify(counts)}, ${refreshed.items} installed items refreshed from the checkout (${refreshed.changed} changed)`)

  for (const rate of RATES) {
    const context = await browser.newContext() // fresh: no persistent cache, no storage
    const page = await context.newPage()
    await instrument(page)
    // NO page.route here: enabling playwright routing disables the browser http cache, and a warm start
    // then re-downloads the bundle (visible 0.65 → 1.4-1.8 s, measured 2026-09-08). the localhost repo
    // watcher finds nothing to write (see the seed refresh above) and the network policy is the
    // browser's resolver rule (init_perf.config.ts, header item 5)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate })
    const profile = process.env.PERF_PROFILE == '1' && rate == RATES[0]
    // a returning device: the v0 secret and the bound v1 envelope in localStorage before sign-in
    await page.goto('/')
    await page.evaluate(
      ([uid, salt, key, v0]) => {
        localStorage.setItem('mindpage_secret', v0)
        localStorage.removeItem('mindpage_kdf')
        localStorage.setItem('mindpage_key1', JSON.stringify({ uid, v: 1, salt, key, v0 }))
      },
      [PERF.uid, SALT, KEY_B64, secret]
    )
    const token = await customToken(PERF)
    await page.waitForFunction(() => !!(window as any).firebase?.auth?.signInWithCustomToken, null, { timeout: 30_000 })
    await page.evaluate(token => {
      sessionStorage.setItem('mindpage_signin_pending', '1')
      document.cookie = '__session=signin_pending;max-age=600'
      const fb = (window as any).firebase
      void fb.auth.signInWithCustomToken(fb.auth.getAuth(fb), token)
    }, token)
    // the app reloads itself on the auth change: that reload is the COLD start (server snapshot)
    const runs: Record<string, unknown>[] = []
    for (const kind of ['cold', 'warm1', 'warm2']) {
      if (profile) {
        await cdp.send('Profiler.enable')
        await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
        await cdp.send('Profiler.start')
      }
      if (kind != 'cold') await page.reload()
      await expect
        .poll(() => page.evaluate(() => (window as any)._init_time > 0 && (window as any)._readonly === false).catch(() => false), {
          timeout: 600_000,
        })
        .toBe(true)
      await waitForApp(page)
      await page.waitForFunction(() => (window as any).__perf.rendered > 0, null, { timeout: 600_000 })
      await page.waitForTimeout(QUIET_MS)
      const perf: Perf = await page.evaluate(() => (window as any).__perf)
      const itemCount = await page.evaluate(() => (window as any).__items?.length ?? 0)
      // PROBE: read counters and dependency-list diversity (cache-eligible deep reads = prefix hits + misses;
      // bypassed reads are not counted; the list count and median are over ALL items, empty lists included)
      const probe = await page.evaluate(() => {
        const w = window as any
        const items = w.__items ?? []
        const lists = new Set(items.map((i: any) => (i.deps ?? []).join(',')))
        const withDeps = items.filter((i: any) => i.deps?.length).length
        const depsLen = items.map((i: any) => i.deps?.length ?? 0).sort((a: number, b: number) => a - b)
        return { read_memo: { ...w._read_memo }, deps_prefix_memo: { ...w._deps_prefix_memo }, distinct_dep_lists: lists.size, items_with_deps: withDeps, deps_len_median: depsLen[Math.floor(depsLen.length / 2)], deps_len_max: depsLen[depsLen.length - 1] }
      })
      if (profile) {
        const { profile: data } = (await cdp.send('Profiler.stop')) as { profile: unknown }
        const file = `/Users/olcan/vault/tmp/init_perf/profile_${rate}x_${kind}.cpuprofile`
        writeFileSync(file, JSON.stringify(data))
        console.log(`wrote ${file}`)
      }
      const run = { tag: TAG, rate, kind, items: itemCount, ...summarize(perf), marks: perf.marks.slice(0, 60) }
      runs.push(run)
      console.log(JSON.stringify({ ...run, marks: undefined }))
      appendFileSync(RESULTS, JSON.stringify({ at: new Date().toISOString(), ...run, probe }) + '\n')
    }
    await context.close()
  }
})
