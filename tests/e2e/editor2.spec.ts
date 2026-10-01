import { expect, test, type Page } from '@playwright/test'
import { mindbox, focusMindbox, savedId, itemText, visible } from './editor_helpers.js'
import { firestore, loadAdmin } from './helpers.js'

// the editor lane's longest rows, on their own lane (playwright.config.ts: `editor2`) so the two
// editor lanes finish in about the same time; each row is self-contained (its own items, its own
// page loads), unlike the rows of editor.spec.ts that build on each other's items
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

test('an edit in one tab reaches another tab sharing the persistent cache', async ({ page }) => {
  // regression: with the multi-tab persistence manager both tabs share the mutation queue, so the
  // other tab sees the change with hasPendingWrites set; skipping every pending change as "local"
  // dropped it for good, since the acknowledging snapshot that follows is metadata-only (see
  // isOwnPendingChange in index.svelte)
  await loadAdmin(page)
  const other = await page.context().newPage() // a second tab: same origin, same indexeddb
  try {
    await loadAdmin(other)
    await page.evaluate(() => void window._create('#e2e_xtab original text'))
    await expect.poll(() => savedId(page, '#e2e_xtab'), { timeout: 30_000 }).toBeTruthy()
    // the new item reaches the other tab
    await expect.poll(() => itemText(other, '#e2e_xtab'), { timeout: 30_000 }).toBe('#e2e_xtab original text')
    // ... and so do later writes, in both directions (write appends an _output block)
    await page.evaluate(() => window._item('#e2e_xtab')!.write('from the first tab'))
    await expect.poll(() => itemText(other, '#e2e_xtab'), { timeout: 30_000 }).toContain('from the first tab')
    await other.evaluate(() => window._item('#e2e_xtab')!.write('from the second tab'))
    await expect.poll(() => itemText(page, '#e2e_xtab'), { timeout: 30_000 }).toContain('from the second tab')
    // a rapid burst of writes must not roll the item back: each write's echo arrives as a
    // pending change and must be recognized as our own even though a newer save has already
    // superseded savingText — a stale echo applied over local state would also be PERSISTED by
    // the queued save reading the rolled-back text (see unackedWrites in index.svelte)
    // the SAVE producer, pinned where writes demonstrably reach the server (see saveSeq in
    // index.svelte and tests/unit/reconcile.spec.ts): deleting the increment must fail a test
    const xtabSeq = () =>
      page.evaluate(() => {
        const id = window._item('#e2e_xtab', true)?.id
        return (window.__items as any[]).find(i => i.id == id)?.saveSeq ?? 0
      })
    const beforeBurst = await xtabSeq()
    await page.evaluate(() => {
      const item = window._item('#e2e_xtab')!
      for (const n of [1, 2, 3, 4]) item.write(`burst ${n}`)
    })
    await expect.poll(xtabSeq, { timeout: 30_000 }).toBeGreaterThan(beforeBurst)
    await expect.poll(() => itemText(page, '#e2e_xtab'), { timeout: 30_000 }).toContain('burst 4')
    await page.waitForTimeout(2_000) // let every echo and queued save settle ...
    expect(await itemText(page, '#e2e_xtab')).toContain('burst 4') // ... none may roll it back
    await expect.poll(() => itemText(other, '#e2e_xtab'), { timeout: 30_000 }).toContain('burst 4')
    expect(await itemText(other, '#e2e_xtab')).toBe(await itemText(page, '#e2e_xtab'))
    // OVERLAPPING writes from both tabs with no wait between them (round-8 finding 4): tab B's
    // pending change enters tab A's queue while A's own write is in flight — A must defer the
    // remote change instead of rolling back, and both tabs converge on the newest state
    await Promise.all([
      page.evaluate(() => window._item('#e2e_xtab')!.write('overlap A')),
      other.evaluate(() => window._item('#e2e_xtab')!.write('overlap B')),
    ])
    // no fixed settle: the convergence assertions below POLL the backend and the two tabs, which
    // is the event-driven wait this was standing in for
    // the invariant that matters is that what each tab SHOWS matches what the backend HOLDS: a
    // deferred change must not be applied under an unsettled local write (whose queued save
    // would then persist the rollback), and a deferred change must not be silently dropped —
    // each tab reconciles against the server once its own intent settles
    const serverText = async () => {
      const id = await savedId(page, '#e2e_xtab')
      return (await firestore().collection('items').doc(id!).get()).data()?.text ?? null
    }
    // ONE joint sample: tab A, tab B and the server read together and required to agree in the
    // SAME observation. polling them separately let A match server revision A, then B match a later
    // revision B, with A never rechecked — two tabs that were never simultaneously in step
    await expect
      .poll(
        async () => {
          const [a, b, server] = await Promise.all([
            itemText(page, '#e2e_xtab'),
            itemText(other, '#e2e_xtab'),
            serverText(),
          ])
          return a == server && b == server ? server : null
        },
        { timeout: 30_000 }
      )
      .toMatch(/overlap [AB]/)
    // a fresh context (no shared cache, no local state) sees exactly the same document
    const fresh = await page.context().browser()!.newContext()
    try {
      const third = await fresh.newPage()
      await loadAdmin(third)
      await expect.poll(() => itemText(third, '#e2e_xtab'), { timeout: 30_000 }).toBe(await serverText())
    } finally {
      await fresh.close()
    }
    // identical same-millisecond creates in both tabs must surface as TWO items in BOTH tabs:
    // create classification is by identity (preallocated document ids), where content matching
    // made each tab skip the other's same-content document as its own
    await Promise.all([
      page.evaluate(() => void window._create('#e2e_twin identical')),
      other.evaluate(() => void window._create('#e2e_twin identical')),
    ])
    for (const tab of [page, other])
      await expect
        .poll(() => tab.evaluate(() => window._items('#e2e_twin').length), { timeout: 30_000 })
        .toBe(2)
  } finally {
    await other.close()
  }
})

test('a data-selection over url text maps past the zero-width spaces in the editor', async ({ page }) => {
  await loadAdmin(page)
  // the todoer-shaped case: raw-domain offsets over an item whose long urls get ZWSP-augmented
  // in the textarea (src/zwsp.ts) — unmapped, a full-text selection ends one raw character
  // short per preceding ZWSP, leaving the url tail unselected (the 2026-08-29 todoer bug)
  const TODO =
    '#e2e_zwsp Ask vedant about the mail thread below ' +
    '[gmail](https://mail.google.com/mail/u/0/#inbox/19f0c2748522c278) ' +
    '[mail](message://%3CCAFXOJNHzgNtJc7CbqiMf%2BNeH%2B0gGYVpZYT%3DyNoKquDvL3Vo5Lw%40mail.gmail.com%3E)'
  await page.evaluate(text => void window._create(text), TODO)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_zwsp')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_zwsp', true)?.elem), { timeout: 10_000 }).toBe(true)
  const id = await page.evaluate(() => window._item('#e2e_zwsp')!.id)
  // record the raw-domain selection the way MindBox.select_in_target does for a non-editing
  // target: the FULL raw text range on the container's data-selection attribute
  await page.evaluate(
    ({ id, len }) => document.querySelector(`#item-${id}`)!.closest('.container')!.setAttribute('data-selection', `0,${len}`),
    { id, len: TODO.length }
  )
  // click the plain text: the CENTER OF ITS TEXT NODE, not the paragraph's midpoint -- with the
  // 2026-09-05 column widths (1000px columns) the whole line fits on one row and the paragraph
  // midpoint lands on a link, which navigates instead of opening the editor
  const point = await page.evaluate(id => {
    const paragraph = document.querySelector(`#item-${id} p`)!
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.includes('Ask vedant')) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = range.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    return null
  }, id)
  await page.mouse.click(point!.x, point!.y)
  const textarea = page.locator(`#textarea-${id}`)
  await expect(textarea).toBeVisible()
  const { value, start, end } = await textarea.evaluate((el: HTMLTextAreaElement) => ({
    value: el.value,
    start: el.selectionStart,
    end: el.selectionEnd,
  }))
  expect(value.length, 'the urls really are ZWSP-augmented').toBeGreaterThan(TODO.length)
  expect(start).toBe(0)
  expect(end, 'the mapped selection reaches the true end of the augmented value').toBe(value.length)
  expect(value.slice(start, end).replaceAll('\u200B', ''), 'the selection strips back to the exact raw text').toBe(TODO)
  await page.keyboard.press('Escape') // nothing was changed: closes without the discard modal
  await expect(textarea).toBeHidden()
})

test('an invalid image src fails without holding the page loading overlay, and retries are bounded', async ({
  page,
}) => {
  // the reported bug: an image hash pasted from another account resolves under this account's
  // storage prefix and 404s forever — the download retried unboundedly, the img never counted
  // as rendered, and the page-level loading overlay covered the page until dev-tools surgery.
  // policy (owner-directed 2026-08-29): first failure releases the page; 4xx-class failures are
  // terminal (no retry); transient failures retry on backoff, capped at 5
  const fetches = { e2e404: 0, e2e500: 0 }
  let transiently = true // while true the e2e500 image fails 500 (transient); then 404 (terminal)
  await page.route(/firebasestorage\.googleapis\.com/, async route => {
    const url = route.request().url()
    const hash = url.includes('e2e404') ? 'e2e404' : url.includes('e2e500') ? 'e2e500' : null
    if (!hash) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
    fetches[hash]++
    const status = hash == 'e2e404' || !transiently ? 404 : 500
    await route.fulfill({ status, contentType: 'application/json', body: '{}' })
  })
  await loadAdmin(page)
  let badimg: string | null = null
  let slowimg: string | null = null
  try {
    await page.evaluate(() => {
      // both hashes are valid hex, so they resolve to <uid>/images/<hash> storage paths; the
      // 404 item carries TWO images of the SAME source to pin the coalesced terminal path
      // (review 135 §2.1/§3.2: the shared raw load must reject each consumer with the
      // ORIGINAL error, and the source is still fetched only once)
      void window._create(
        '#e2e_badimg pasted from another account\n<img src="e2e404" style="zoom:0.5"> <img src="e2e404" style="zoom:0.5">'
      )
      void window._create('#e2e_slowimg transiently failing\n<img src="e2e500" style="zoom:0.5">')
    })
    await page.evaluate(() => void (location.hash = '#e2e_badimg'))
    const attrs = (name: string) =>
      page.evaluate(name => {
        const imgs = [...(window._item(name, true)?.elem?.querySelectorAll('.content img') ?? [])]
        return (
          imgs.length > 0 && {
            pending: imgs.some(img => img.hasAttribute('_pending')),
            failed: imgs.every(img => img.hasAttribute('_failed')),
          }
        )
      }, name)
    const rendered = (name: string) =>
      page.evaluate(name => (window.__items.find(item => item.labelText == name) as any)?.rendered ?? false, name)
    // BOTH 404 images give up terminally after exactly ONE shared fetch: the coalesced
    // consumer received the original storage/object-not-found, not a swallowed undefined
    await expect.poll(() => attrs('#e2e_badimg'), { timeout: 15_000 }).toEqual({ pending: false, failed: true })
    expect(fetches.e2e404).toBe(1)
    // the item completes rendering in the imgs' failed state and the page overlay releases —
    // this is the assertion that failed before the fix (rendered stayed false forever)
    await expect.poll(() => rendered('#e2e_badimg'), { timeout: 15_000 }).toBe(true)
    // no visible item is still rendering (the renderingVisibleItems condition; asserted
    // through the item list so a failure names the stuck item) ...
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window.__items as any[])
              .slice(0, window.__hideIndex as any)
              .filter(item => !item.rendered && !item.editing)
              .map(item => item.labelText)
              .join(',')
          ),
        { timeout: 45_000 } // covers the transient image's first surfaced failure (15s sdk window)
      )
      .toBe('')
    // ... and the page-covering overlay itself — the user-visible symptom — is released
    await expect(page.locator('#sapper > .loading')).not.toHaveClass(/visible/)
    // the transient (500) image also releases the page after its FIRST SURFACED failure — the
    // sdk's internal retry window is bounded to 15s (maxOperationRetryTime), so the item
    // renders in failed-but-STILL-PENDING state while app-level retries continue underneath
    await page.evaluate(() => void (location.hash = '#e2e_slowimg'))
    await expect.poll(() => rendered('#e2e_slowimg'), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => attrs('#e2e_slowimg'), { timeout: 30_000 }).toEqual({ pending: true, failed: true })
    const surfaced = fetches.e2e500
    expect(surfaced).toBeGreaterThan(0)
    // the app-level retry loop really RUNS a retry (review 135 §3.1): flip the fixture to 404
    // so the next executed attempt terminates — settlement requires the fetch count to have
    // GROWN past the first surfaced failure (a first-failure-terminal implementation fails
    // here), and nothing fetches after give-up. (the 5-retry cap value itself is
    // code-reviewed, not browser-timed: total time since pending doubles per round)
    transiently = false
    await expect.poll(() => attrs('#e2e_slowimg'), { timeout: 90_000 }).toEqual({ pending: false, failed: true })
    expect(fetches.e2e500).toBeGreaterThan(surfaced)
    const settled = fetches.e2e500
    await page.waitForTimeout(1_000)
    expect(fetches.e2e500).toBe(settled) // no fetch after give-up
  } finally {
    // the invalid-image fixtures must not outlive this row (review 135 §3.4): outside this row's
    // page-scoped route the items would issue real storage requests on every later load of the
    // lane's account
    badimg ??= await savedId(page, '#e2e_badimg').catch(() => null)
    slowimg ??= await savedId(page, '#e2e_slowimg').catch(() => null)
    for (const id of [badimg, slowimg]) if (id) await firestore().collection('items').doc(id).delete().catch(() => {})
  }
})

// A SECOND TAB OF THE SHARED PERSISTENT CACHE CONFIRMS ON ITS OWN (2026-09-25): a secondary tab's
// snapshots come through the primary tab's cache, and firebase-js-sdk issue 8314 (10.12.1) once
// kept them at fromCache true for good, so a docs claim of 2026-09-23 had `_server_confirmed` never
// turning true there; that was fixed upstream (PR 8339) before the SDK in use, and this row pins
// it, since item code gates its store writes on the flag (the todoer's order save and unsnooze
// sweep): the second tab is a SECONDARY (the first tab's fresh lease keeps it from the primary
// lease; the SDK logs "Client is eligible for a primary lease" at its debug level when a client
// BECOMES primary, which the first tab does and the second never does), yet its first snapshot is
// current, its flag turns true and its welcome settles by the confirmation, not the timeout
const sdkLogs = (page: Page) =>
  page.addInitScript(() => {
    // the SDK's own debug log, captured through the app's firebase.onLog hook as soon as the app
    // exposes it, before the client's persistence starts (its lease attempt runs every 4 s)
    const timer = setInterval(() => {
      const fb = (window as any).firebase
      if (!fb?.onLog || !fb?.firestore?.setLogLevel) return
      clearInterval(timer)
      const sdk: string[] = ((window as any).__sdk_logs = [])
      fb.firestore.setLogLevel('debug')
      fb.onLog((e: { message: string }) => sdk.push(e.message), { level: 'debug' })
    }, 1)
  })
const becamePrimary = (page: Page) =>
  page.evaluate(() => {
    const sdk: string[] = (window as any).__sdk_logs ?? []
    return { tried: sdk.some(m => /updateClientMetadataAndTryBecomePrimary/.test(m)), became: sdk.some(m => /Client is eligible for a primary lease/.test(m)) }
  })

test('an external image that fails once is retried once with a cache-busting query; one that fails twice is marked failed', async ({
  page,
}) => {
  // the owner's iPhone (2026-10-01): six Dropbox-hosted icons failed with "The network connection
  // was lost" in the first seconds of every launch and loaded fine a moment later. an external
  // image's first failure now schedules one retry (2 s, a `_retry` query inserted before any
  // fragment); a second failure takes the ordinary failed path. the routes stand in for the
  // flaky host: `flaky.png` (with a query and a fragment, review 0 R1) fails its first request and
  // serves a 1x1 png to the second, which is HELD until the row has seen the page released;
  // `dead.png` fails every request
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII', 'base64')
  const requests: string[] = []
  let releaseRetry!: () => void
  const retryHeld = new Promise<void>(resolve => (releaseRetry = resolve))
  await page.route(/https:\/\/icons\.e2e\.invalid\//, async route => {
    const url = route.request().url()
    requests.push(url)
    const flaky = url.includes('flaky.png')
    if (!flaky || requests.filter(u => u.includes('flaky.png')).length == 1) return route.abort('connectionfailed')
    await retryHeld // the retry's response waits for the release below
    await route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })
  const logs: string[] = []
  page.on('console', msg => logs.push(`${msg.type()}: ${msg.text()}`))
  await loadAdmin(page)
  try {
    await page.evaluate(() => {
      void window._create(
        '#e2e_extimg external icons\n<img src="https://icons.e2e.invalid/flaky.png?size=16#view" style="zoom:0.5"> <img src="https://icons.e2e.invalid/dead.png" style="zoom:0.5">'
      )
    })
    await page.evaluate(() => void (location.hash = '#e2e_extimg'))
    const state = () =>
      page.evaluate(() => {
        const imgs = [...(window._item('#e2e_extimg', true)?.elem?.querySelectorAll('.content img') ?? [])] as HTMLImageElement[]
        return imgs.map(img => ({
          src: img.getAttribute('src')!.replace(/_retry=\d+/, '_retry=T'),
          retried: img.hasAttribute('_retried'),
          failed: img.hasAttribute('_failed'),
          rendered: img.hasAttribute('_rendered'),
          width: img.naturalWidth,
        }))
      })
    const rendered = () => page.evaluate(() => (window.__items.find(item => item.labelText == '#e2e_extimg') as any)?.rendered ?? false)
    // the first failures: both retried, the item rendered (the page released) while the flaky
    // image's retry is still held and nothing has loaded
    await expect.poll(async () => requests.filter(u => u.includes('flaky.png')).length, { timeout: 20_000 }).toBe(2)
    await expect.poll(rendered, { timeout: 20_000 }).toBe(true)
    expect((await state()).map(s => s.width), 'nothing loaded yet').toEqual([0, 0])
    // the retry's request carries the parameter IN THE QUERY, after the existing one; the fragment
    // never reaches the server and stays on the element
    expect(requests.filter(u => u.includes('flaky.png'))[1]).toMatch(/^https:\/\/icons\.e2e\.invalid\/flaky\.png\?size=16&_retry=\d+$/)
    releaseRetry()
    // the flaky one: loaded by its retry, the fragment kept; the dead one: retried once, then failed
    await expect.poll(state, { timeout: 20_000 }).toEqual([
      { src: 'https://icons.e2e.invalid/flaky.png?size=16&_retry=T#view', retried: true, failed: false, rendered: true, width: 1 },
      { src: 'https://icons.e2e.invalid/dead.png?_retry=T', retried: true, failed: true, rendered: true, width: 0 },
    ])
    expect(requests.filter(u => u.includes('flaky.png')).length, 'exactly two requests for the flaky image: the failure and the retry that loaded').toBe(2)
    // the dead one: its retry was requested; an item's settling re-renders create fresh elements,
    // each failing from the memory cache without a request and scheduling a retry that finds its
    // element replaced, so the log lines are not a count of attempts: the requests and the final
    // state are (and `_failed` on the flaky image would be the error's mark: it has none)
    expect(requests.filter(u => u.includes('dead.png')).length, 'the dead one was retried').toBeGreaterThanOrEqual(2)
    expect(logs.some(l => l.startsWith('debug: image load failed, retrying once in 2000ms: https://icons.e2e.invalid/flaky.png?size=16#view')), 'the retry is logged at debug').toBe(true)
    expect(logs.some(l => l.startsWith('error: image load failed')), 'the second failure is the error').toBe(true)
  } finally {
    releaseRetry() // harmless twice: a route handler must not stay awaiting it after a failed assertion
    const id = await savedId(page, '#e2e_extimg').catch(() => null)
    if (id) await firestore().collection('items').doc(id).delete()
  }
})

test('a second tab sharing the persistent cache, a secondary, confirms on its own', async ({ page }) => {
  await sdkLogs(page)
  await loadAdmin(page)
  await expect.poll(() => page.evaluate(() => window._server_confirmed), { timeout: 30_000 }).toBe(true)
  expect(await becamePrimary(page), 'the first tab took the primary lease').toEqual({ tried: true, became: true })
  const other = await page.context().newPage() // a second tab: same origin, same indexeddb
  try {
    const logs: string[] = []
    other.on('console', msg => logs.push(msg.text()))
    await sdkLogs(other)
    await loadAdmin(other)
    await expect.poll(() => other.evaluate(() => window._server_confirmed), { timeout: 30_000 }).toBe(true)
    expect(await becamePrimary(other), 'the second tab tried and stayed a secondary').toEqual({ tried: true, became: false })
    expect(logs.join('\n'), 'confirmed by a current server revision of its own').toMatch(/server-confirmed corpus/)
    expect(logs.join('\n'), 'the welcome settled by the confirmation').toMatch(/corpus settled: confirmed/)
  } finally {
    await other.close()
  }
})
