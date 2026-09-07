import { expect, test } from '@playwright/test'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
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
  // PERF_PATCH_VAULT_JS=<file>: the seeded #template/vault item carries the checkout's renderer
  // (its ```js_removed:vault.js block body replaced), so a renderer change is measured too
  const patchVault = process.env.PERF_PATCH_VAULT_JS ? readFileSync(process.env.PERF_PATCH_VAULT_JS, 'utf8').replace(/\n$/, '') : null
  let patched = 0
  for (const row of items) {
    let { id, plain, version, error: _error, ...fields } = row
    if (patchVault && plain?.includes('js_removed:vault.js')) {
      const inner = JSON.parse(plain)
      const before = inner.text
      inner.text = inner.text.replace(/(```js_removed:vault\.js\n)[\s\S]*?(\n```)/, (_m: string, a: string, b: string) => a + patchVault + b)
      if (inner.text != before) patched++
      plain = JSON.stringify(inner)
    }
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
  if (patchVault && patched == 0) throw new Error('PERF_PATCH_VAULT_JS matched no item: the corpus has no ```js_removed:vault.js block')
  console.log(`seeded ${n} items for ${PERF.uid}: ${JSON.stringify(counts)}${patchVault ? `, vault renderer patched in ${patched} item(s)` : ''}`)

  for (const rate of RATES) {
    const context = await browser.newContext() // fresh: no persistent cache, no storage
    const page = await context.newPage()
    await instrument(page)
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
      if (profile) {
        const { profile: data } = (await cdp.send('Profiler.stop')) as { profile: unknown }
        const file = `/Users/olcan/vault/tmp/init_perf/profile_${rate}x_${kind}.cpuprofile`
        writeFileSync(file, JSON.stringify(data))
        console.log(`wrote ${file}`)
      }
      const run = { tag: TAG, rate, kind, items: itemCount, ...summarize(perf), marks: perf.marks.slice(0, 60) }
      runs.push(run)
      console.log(JSON.stringify({ ...run, marks: undefined }))
      appendFileSync(RESULTS, JSON.stringify({ at: new Date().toISOString(), ...run }) + '\n')
    }
    await context.close()
  }
})
