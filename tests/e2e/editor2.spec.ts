import { expect, test, type Page } from '@playwright/test'
import { mindbox, focusMindbox, focusMindboxInPlace, savedId, itemText, visible } from './editor_helpers.js'
import { firestore, loadAdmin } from './helpers.js'

// the editor lane's longest rows, on their own lane (playwright.config.ts: `editor2`) so the two
// editor lanes finish in about the same time; each row is self-contained (its own items, its own
// page loads), unlike the rows of editor.spec.ts that build on each other's items, so the rows are
// not a serial group: a failed row leaves the rest running (lane_races review 0: one early failure
// hid the later rows' evidence for a day), on the lane's one worker as before (fullyParallel is off)
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
  // the paragraph in the viewport and at rest for 200 ms before the point is taken: the app's scroll to
  // the query's target lands a few frames after the render, later on the full gate's busier page, and a
  // point taken before it landed 330 px below the viewport, where the click met nothing (2026-10-28, twice)
  const paragraphTop = () =>
    page.evaluate(id => {
      const rect = document.querySelector(`#item-${id} p`)!.getBoundingClientRect()
      const inside = rect.top >= 0 && rect.top + 20 <= innerHeight // the viewport as measured, not assumed
      if (!inside) document.querySelector(`#item-${id} p`)!.scrollIntoView({ block: 'center' })
      return { top: rect.top, inside }
    }, id)
  await expect
    .poll(
      async () => {
        const { top, inside } = await paragraphTop()
        await page.waitForTimeout(200)
        return inside && (await paragraphTop()).top == top
      },
      { timeout: 15_000, message: 'the paragraph in the viewport and at rest' }
    )
    .toBe(true)
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

// `/_rename #tag #new_tag` (index.svelte): which text is a tag and how it is renamed is the table of
// tests/unit/tag_rename.spec.ts; the two rows below hold what a table cannot, the command in the page:
// its dialog, its refusals and what a confirmed rename does to the items and their documents

// text typed into the mindbox (focused in place: its backdrop is covered once the box holds the
// focus), and a command entered there as the owner does it
async function typed(page: Page, text: string) {
  await page.evaluate(() => document.getElementById('textarea-mindbox')!.focus())
  await mindbox(page).fill(text)
}
async function entered(page: Page, text: string) {
  await typed(page, text)
  await page.keyboard.press('Shift+Enter') // done once the modifier is released (Editor.svelte)
}
// the open dialog's paragraphs, a line break in one as a newline
const dialog = (page: Page) => page.locator('.modal p').allInnerTexts()
// the page's pending timers run: the Modal answers a key from a timer, which the next injected key or
// evaluate can overtake, so a row that says a key did NOT answer a dialog waits here first
const timersRun = (page: Page) => page.evaluate(() => new Promise(resolve => setTimeout(resolve)))
// the fixture items' ids once every creation is saved, in the order given
async function saved(page: Page, labels: string[]): Promise<string[]> {
  const ids = () => page.evaluate(labels => labels.map(label => window._item(label, true)?.saved_id ?? null), labels)
  await expect.poll(async () => (await ids()).every(Boolean), { timeout: 30_000 }).toBe(true)
  return (await ids()) as string[]
}
// each item's document as the server holds it: its text and its time
const stored = (ids: string[]) =>
  Promise.all(
    ids.map(async id => {
      const data = (await firestore().collection('items').doc(id).get()).data()
      return [data?.text, data?.time]
    })
  )

test('/_rename renames a tag in every item after one confirmation that names the count and the first ten items; each item is saved as an edit of the text it has by then, its time kept', async ({ page }) => {
  await loadAdmin(page)
  const FROM = '#e2e_rename'
  const TO = '#e2e_renamed'
  // the fixture under a tag: the tag as a label; a label nested under it, with the hidden form, several
  // occurrences and one in code; eleven items that mention it, under look-alike labels; and a look-alike
  // that names it in code alone
  const refs = Array.from({ length: 11 }, (_, i) => `${FROM}_ref${String(i + 1).padStart(2, '0')}`)
  const labels = [FROM, `${FROM}/a`, ...refs, `${FROM}s`]
  const texts = (tag: string) => [
    `${tag} the root`,
    `${tag}/a #_${tag.slice(1)} a child that depends on the root\nsee ${tag}, ${tag}/a and \`${FROM}\` (${tag})`,
    ...refs.map(ref => `${ref} mentions ${tag}/a`),
    `${FROM}s a look-alike with \`${FROM}\` in code`,
  ]
  const [DELETED, EDITED, LOOKALIKE] = [11, 12, 13] // the last two mentions (neither among the ten named) and the look-alike
  const edited = (tag: string) => `${refs[10]} mentions ${tag}/a and, since the dialog opened, ${tag}`
  let ids: string[] = []
  try {
    for (const text of texts(FROM)) await page.evaluate(text => void window._create(text), text)
    ids = await saved(page, labels)
    await expect.poll(async () => (await stored(ids)).map(([text]) => text), { timeout: 30_000 }).toEqual(texts(FROM))
    await entered(page, `/_rename ${FROM} ${TO}`)
    // the count, then the items whose own label is renamed, then the others by name, ten in all
    await expect
      .poll(() => dialog(page), { timeout: 30_000 })
      .toEqual([`Rename ${FROM} to ${TO} in 13 items?`, [FROM, `${FROM}/a`, ...refs.slice(0, 8), '... (3 others)'].join('\n')])
    // while the dialog is open, behind the app: one of the items is edited and one is deleted
    await firestore().collection('items').doc(ids[EDITED]).update({ text: edited(FROM) })
    await firestore().collection('items').doc(ids[DELETED]).delete()
    const shown = () => page.evaluate(ids => ids.map(id => window._item(id, true)?.text ?? null), ids)
    const expected = (tag: string) => texts(tag).map((text, i) => (i == EDITED ? edited(tag) : i == DELETED ? null : text))
    await expect.poll(shown, { timeout: 30_000 }).toEqual(expected(FROM))
    const before = await stored(ids)
    // each item's time in the page, which a save writes (a created item's is set once more after its
    // document's, so the two can be a millisecond apart)
    const times = await page.evaluate(ids => ids.map(id => (window.__items as any[]).find(item => item.savedId == id)?.time ?? null), ids)
    await page.locator('.modal .button.confirm', { hasText: 'Rename' }).click()
    await expect(mindbox(page)).toHaveValue('', { timeout: 30_000 }) // a handled command clears the box
    // in the page: every item by its id (the edit made meanwhile kept and renamed, the deleted item
    // skipped), the two labels renamed with the tag, the look-alike as it was
    expect(await shown()).toEqual(expected(TO))
    const names = [FROM, `${FROM}/a`, TO, `${TO}/a`, `${FROM}s`]
    expect(await page.evaluate(names => names.map(name => window._exists(name)), names)).toEqual([false, false, true, true, true])
    // on the server: the renamed text under the time each item had in the page (an edit would have
    // set it to now and moved the item to the top), the look-alike's document and the deleted one's
    // absence as they were, and the history row of a saved edit
    await expect
      .poll(() => stored(ids), { timeout: 30_000 })
      .toEqual(expected(TO).map((text, i) => (i == LOOKALIKE || i == DELETED ? before[i] : [text, times[i]])))
    const history = async () => (await firestore().collection('history').where('item', '==', ids[0]).get()).docs.map(doc => doc.data().text)
    await expect.poll(history, { timeout: 30_000 }).toContain(`${TO} the root`)
  } finally {
    for (const id of ids) await firestore().collection('items').doc(id).delete().catch(() => {})
  }
})

test('/_rename refuses bad arguments and an item being edited, and a cancelled confirmation changes nothing; a refused or cancelled command stays in the box', async ({ page }) => {
  await loadAdmin(page)
  const FROM = '#e2e_rncancel'
  const TO = '#e2e_rnkept'
  const created = [`${FROM} the root`, `${FROM}/a a child`, `${TO}/a holds the label the rename would give the child`]
  // a command run without the box: the message it refuses with, or `unanswered` when it waits on a
  // dialog instead (a refusal answers at once)
  const command = (text: string) =>
    page.evaluate(
      text =>
        Promise.race([
          Promise.resolve(window._create(text, { command: true, return_alerts: true })).then(out => (typeof out == 'string' ? out : null)),
          new Promise<string>(resolve => setTimeout(() => resolve('unanswered'), 10_000)),
        ]),
      text
    )
  let ids: string[] = []
  const state = async () => ({ page: await page.evaluate(ids => ids.map(id => window._item(id, true)?.text), ids), server: (await stored(ids)).map(([text]) => text) })
  try {
    for (const text of created) await page.evaluate(text => void window._create(text), text)
    ids = await saved(page, [FROM, `${FROM}/a`, `${TO}/a`])
    await expect.poll(state, { timeout: 30_000 }).toEqual({ page: created, server: created })
    // refused: any count of arguments but two, a hidden or a relative form, a tag no item carries (or its own name)
    for (const args of ['', ` ${FROM}`, ` ${FROM} ${TO} #more`]) expect(await command('/_rename' + args), args).toBe('usage: /_rename #tag #new_tag')
    for (const [args, invalid] of [[`#_${FROM.slice(1)} ${TO}`, `#_${FROM.slice(1)}`], [`${FROM} #/a`, '#/a']])
      expect(await command(`/_rename ${args}`)).toBe(`/_rename: invalid tag '${invalid}' (expected a visible absolute tag like #tag)`)
    for (const args of [`#e2e_rnabsent ${TO}`, `${FROM} ${FROM}`]) expect(await command(`/_rename ${args}`), args).toBe('/_rename: nothing to rename (no item would change)')
    // refused: an item the rename would change is open in an editor (a write would replace the editor's text)
    await typed(page, `${FROM}/a`) // the query brings the child into view
    await expect.poll(() => page.evaluate(label => !!window._item(label, true)?.elem, `${FROM}/a`), { timeout: 10_000 }).toBe(true)
    const child = await page.evaluate(label => window._item(label)!.id, `${FROM}/a`)
    await page.locator(`.column:not(.hidden) #item-${child} p`).first().click()
    await expect(page.locator(`#textarea-${child}`)).toBeFocused()
    expect(await command(`/_rename ${FROM} ${TO}`)).toBe(`/_rename: can not rename while editing ${FROM}/a`)
    await page.keyboard.press('Escape') // nothing typed, nothing to discard
    await expect(page.locator(`#textarea-${child}`)).toBeHidden()
    // entered into the box: the refusal is shown and the command stays
    await entered(page, `/_rename ${FROM}`)
    await expect.poll(() => dialog(page), { timeout: 30_000 }).toEqual(['usage: /_rename #tag #new_tag'])
    await page.keyboard.press('Escape')
    await expect(page.locator('.modal')).toBeHidden()
    await expect(mindbox(page)).toHaveValue(`/_rename ${FROM}`)
    // the confirmation names the label two items would share; cancelled, nothing changed and the command stays
    await entered(page, `/_rename ${FROM} ${TO}`)
    await expect
      .poll(() => dialog(page), { timeout: 30_000 })
      .toEqual([`Rename ${FROM} to ${TO} in 2 items?`, `${FROM}\n${FROM}/a`, `Multiple items would be labeled:\n${TO}/a`])
    await page.locator('.modal .button.cancel', { hasText: 'Cancel' }).click()
    await expect(page.locator('.modal')).toBeHidden()
    await expect(mindbox(page)).toHaveValue(`/_rename ${FROM} ${TO}`)
    expect(await state()).toEqual({ page: created, server: created })
    // one item, no label shared: the count in the singular and the name alone
    await entered(page, `/_rename ${FROM}/a #e2e_rnone`)
    await expect.poll(() => dialog(page), { timeout: 30_000 }).toEqual([`Rename ${FROM}/a to #e2e_rnone in 1 item?`, `${FROM}/a`])
    await page.locator('.modal .button.cancel', { hasText: 'Cancel' }).click()
    await expect(page.locator('.modal')).toBeHidden()
    expect(await state()).toEqual({ page: created, server: created })
    // entered from the window (the box holds the command, the focus elsewhere): the confirmation is shown
    // while that keydown is still dispatched, and the key that entered the command does not answer it
    // (Modal.svelte, 2026-11-17: until then the rename ran there without waiting for its answer)
    await page.evaluate(command => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      ;(window as any).MindBox.set(command)
    }, `/_rename ${FROM}/a #e2e_rnone`)
    await page.keyboard.press('Shift+Enter')
    await timersRun(page)
    await expect.poll(() => dialog(page), { timeout: 10_000 }).toEqual([`Rename ${FROM}/a to #e2e_rnone in 1 item?`, `${FROM}/a`])
    await page.locator('.modal .button.cancel', { hasText: 'Cancel' }).click()
    await expect(page.locator('.modal')).toBeHidden()
    expect(await state()).toEqual({ page: created, server: created })
  } finally {
    for (const id of ids) await firestore().collection('items').doc(id).delete().catch(() => {})
  }
})

// the create key on an UNNAMED item, one the box names by its id (index.svelte, onEditorDone): the name
// as a label, the names refused, the name offered and where the label goes in the text are the table
// of tests/unit/item_name.spec.ts; the two rows below hold what a table cannot, the key in the page:
// the dialog, what an accepted name does to the item, to its document and to the child, and what is
// refused or cancelled

const NAME_PROMPT = 'The selected item is unnamed. Name it (a unique label) to create a child under it:'
// the fixture items once every creation is saved, in the order given: each one's id in the page (an
// unnamed item is found by its text) and its document's id
async function createdItems(page: Page, texts: string[]): Promise<{ id: string; saved: string }[]> {
  for (const text of texts) await page.evaluate(text => void window._create(text), text)
  const found = () =>
    page.evaluate(
      texts => texts.map(text => window._items().find(item => item.text == text)).map(item => item && { id: item.id, saved: window._item(item.id, true)?.saved_id ?? null }),
      texts
    )
  await expect.poll(async () => (await found()).every(item => item?.saved), { timeout: 30_000 }).toBe(true)
  return (await found()) as { id: string; saved: string }[]
}
// the rows' documents, the fixtures and what the key created, also after a failed row: the offered
// name depends on every label of the account (the anonymous account's documents hold their text in the clear)
async function deleteNamed() {
  const docs = await firestore().collection('items').where('user', '==', 'anonymous').get()
  for (const doc of docs.docs) if (/^(?:#?e2e_cn|#thread_\d|id:\d)/.test(doc.data().text ?? '')) await doc.ref.delete()
}
// the box set to a name as a todo's row sets it (MindBox.set: the query applies at once, the box
// without the focus), for the key from the window; `focus` puts the caret in the box, for the key there
async function selected(page: Page, name: string, { focus = false } = {}) {
  await page.evaluate(
    ([name, focus]) => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      ;(window as any).MindBox.set(name, { scroll: true })
      if (focus) document.getElementById('textarea-mindbox')!.focus()
    },
    [name, focus] as const
  )
}
// the dialog's input: its text, its selection, and whether it holds the focus (a hidden one cannot)
const nameInput = (page: Page) =>
  page.evaluate(() => {
    const input = document.querySelector('#modal-input') as HTMLInputElement | null
    return input && { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input }
  })
const offered = (name: string) => ({ value: name, start: 0, end: name.length, focused: true })
// the focused item editor (never the MindBox, which holds a created child's label too): its text and selection
const childEditor = (page: Page) =>
  page.evaluate(() => {
    const editor = document.activeElement as HTMLTextAreaElement | null
    return editor?.tagName == 'TEXTAREA' && editor.id != 'textarea-mindbox' ? { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd } : null
  })
// a first child as the app makes it under a named item: its index selected, with the space after it
const child = (label: string) => ({ value: `${label}/0 `, start: label.length + 1, end: label.length + 3 })

test('the create key on an unnamed item the box names by its id asks for its name, the next free thread_<n> offered and selected; accepted, the name is saved in front of the text the item has by then, as its label and under the time its document had, and the child is created under it as under a named item; a typed name replaces the offer; the key that opened the dialog does not answer it, pressed or held', async ({ page }) => {
  await loadAdmin(page)
  // the fixture: two items that share a label, so that neither is named by it (as todos share #todo); an
  // item without a label; and the labels that hold the first two offers, one of them by a child left behind
  const SHARED = '#e2e_cn_shared'
  const texts = [`${SHARED} the first`, `${SHARED} the second`, 'e2e_cn plain words', '#thread_0 holds the first offer', '#thread_1/0 left behind by its parent']
  try {
    const [first, , plain] = await createdItems(page, texts)
    expect(await page.evaluate(ids => ids.map(id => window._item(id, true)!.name), [first.id, plain.id]), "the app's name of each is its id").toEqual([`id:${first.id}`, `id:${plain.id}`])
    await expect.poll(async () => (await stored([first.saved, plain.saved])).map(([text]) => text), { timeout: 30_000 }).toEqual([texts[0], texts[2]])
    // (a) the key in the MindBox, which names the first sharer by its id: the dialog, the next free name
    // in its input, selected and focused, and nothing changed
    await selected(page, `id:${first.id}`, { focus: true })
    await page.keyboard.press('Shift+Enter') // done once the modifier is released (Editor.svelte)
    await expect.poll(() => nameInput(page), { timeout: 30_000 }).toEqual(offered('thread_2'))
    expect(await dialog(page)).toEqual([NAME_PROMPT])
    // while the dialog is open, behind the app: the item is edited
    const EDITED = `${SHARED} the first, edited since the dialog opened`
    await firestore().collection('items').doc(first.saved).update({ text: EDITED })
    const shown = (id: string) => page.evaluate(id => window._item(id, true)?.text ?? null, id)
    await expect.poll(() => shown(first.id), { timeout: 30_000 }).toBe(EDITED)
    const [[, time]] = await stored([first.saved])
    expect([await mindbox(page).inputValue(), await page.evaluate(() => window._exists('#thread_2'))]).toEqual([`id:${first.id}`, false])
    // Enter accepts the offer: the child in its editor as under any named item, the box on it, the item
    // named by the label in front of the text it had by then (on the line of the shared label, as the
    // owner writes it by hand before a #todo)
    await page.keyboard.press('Enter')
    await expect.poll(() => childEditor(page), { timeout: 30_000 }).toEqual(child('#thread_2'))
    await expect(page.locator('.modal')).toBeHidden()
    await expect(mindbox(page)).toHaveValue('#thread_2/0 ')
    const NAMED = `#thread_2 ${EDITED}`
    expect([await shown(first.id), await page.evaluate(id => window._item(id, true)!.name, first.id)]).toEqual([NAMED, '#thread_2'])
    // on the server: the item's document with the label under the time it had (an edit would have set
    // it to now, and a save of the page's time to the soft touch of the query that named the item), the
    // history row of a saved edit, and the child's document
    await expect.poll(() => stored([first.saved]), { timeout: 30_000 }).toEqual([[NAMED, time]])
    const history = async () => (await firestore().collection('history').where('item', '==', first.saved).get()).docs.map(doc => doc.data().text)
    await expect.poll(history, { timeout: 30_000 }).toContain(NAMED)
    await saved(page, ['#thread_2/0'])
    await page.keyboard.press('Escape') // the child's editor closed, nothing typed
    // (b) the key from the window, as after a todo's row click, and held: the dialog with the next offer
    // is shown while that keydown is still dispatched, and neither that event nor the key's repeat
    // answers it; a typed name replaces the offer, on the first line of a text that starts with a word.
    // the name is typed with a zero-width space, as a pasted one can carry: a save drops that character
    // from an item's text, so the name is checked, written and nested under without it, and the item
    // is alone under its label with the child as its /0 (kept in, the child's creation missed the label
    // and made a second item of it; the names refused that way are unit rows)
    await selected(page, `id:${plain.id}`)
    await page.keyboard.down('Shift')
    await page.keyboard.down('Enter')
    await expect.poll(() => nameInput(page), { timeout: 30_000 }).toEqual(offered('thread_3'))
    await page.keyboard.down('Enter') // the held key repeats
    await page.keyboard.up('Enter')
    await page.keyboard.up('Shift')
    await timersRun(page)
    expect(await nameInput(page), 'the dialog as the held key found it').toEqual(offered('thread_3'))
    const TYPED = 'e2e_cn_ty\u200Bped'
    await page.keyboard.type(TYPED)
    expect(await nameInput(page), 'typed over the selected offer').toEqual({ value: TYPED, start: 13, end: 13, focused: true })
    await page.keyboard.press('Enter')
    await expect.poll(() => childEditor(page), { timeout: 30_000 }).toEqual(child('#e2e_cn_typed'))
    expect([await shown(plain.id), await page.evaluate(id => window._item(id, true)!.name, plain.id), await page.evaluate(() => window._exists('#thread_3'))]).toEqual([`#e2e_cn_typed ${texts[2]}`, '#e2e_cn_typed', false])
    await expect.poll(async () => (await stored([plain.saved]))[0][0], { timeout: 30_000 }).toBe(`#e2e_cn_typed ${texts[2]}`)
  } finally {
    await deleteNamed()
  }
})

test('a name that is no label, that an item is labeled with already or that is #log is refused: the dialog is back with what was typed and the reason; a cancel changes nothing and keeps the box, and an item deleted meanwhile is not named; an item open in an editor or not editable is refused; a named item takes its child without a dialog, and one the box names by its id is left as it was', async ({ page }) => {
  await deleteNamed() // the first offer below is the account's: nothing of the row above may be left
  await loadAdmin(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  const TAKEN = '#e2e_cn_taken'
  const texts = ['e2e_cn an unnamed item', 'e2e_cn another, deleted while its dialog is open', `${TAKEN} an item that holds a name`]
  try {
    const [unnamed, gone, taken] = await createdItems(page, texts)
    const ids = [unnamed, gone, taken]
    // the fixture in the page and on the server (text and time), and the count of the page's items
    const state = async () => ({
      page: await page.evaluate(ids => [ids.map(id => window._item(id, true)?.text ?? null), window.__items.length], ids.map(item => item.id)),
      server: await stored(ids.map(item => item.saved)),
    })
    await expect.poll(async () => (await state()).server.map(([text]) => text), { timeout: 30_000 }).toEqual(texts)
    const before = await state()
    // (a) each refused name is typed over the selection and entered: the dialog is back with it, selected,
    // and the reason under the prompt (a tag in a reason is shown as code)
    await selected(page, `id:${unnamed.id}`, { focus: true })
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => nameInput(page), { timeout: 30_000 }).toEqual(offered('thread_0'))
    const INVALID = 'Invalid name: expected a visible absolute tag like #name (the # is optional).'
    for (const [name, reason] of [
      ['e2e cn', INVALID],
      [TAKEN.toUpperCase(), `An item is already labeled ${TAKEN.toUpperCase()}.`], // without case, with the #
      ['#_e2e_cn', INVALID],
      [TAKEN.slice(1), `An item is already labeled ${TAKEN}.`], // without the #
      ['log', '#log is reserved for log items.'],
    ]) {
      await page.keyboard.type(name)
      await page.keyboard.press('Enter')
      await expect.poll(() => nameInput(page), { timeout: 30_000, message: name }).toEqual(offered(name))
      expect(await dialog(page), name).toEqual([NAME_PROMPT, reason])
    }
    expect(await state()).toEqual(before)
    // (b) cancelled, by the button and by Escape: nothing changed, no item created, the box as it was and focused
    await page.locator('.modal .button.cancel', { hasText: 'Cancel' }).click()
    await expect(page.locator('.modal')).toBeHidden()
    await expect(mindbox(page)).toBeFocused()
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => nameInput(page), { timeout: 30_000 }).toEqual(offered('thread_0'))
    await page.keyboard.press('Escape')
    await expect(page.locator('.modal')).toBeHidden()
    await expect(mindbox(page)).toHaveValue(`id:${unnamed.id}`)
    expect(await state()).toEqual(before)
    // (c) a named item takes its child as before: no dialog, its text as it was
    await selected(page, TAKEN, { focus: true })
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => childEditor(page), { timeout: 30_000 }).toEqual(child(TAKEN))
    expect([await page.evaluate(() => (window as any)._modal_visible()), await page.evaluate(id => window._item(id, true)!.text, taken.id)]).toEqual([false, texts[2]])
    await page.keyboard.press('Escape') // the child's editor closed, nothing typed
    // and one the box names by its id is left as it was: no dialog either (the box's text becomes an item)
    await selected(page, `id:${taken.id}`, { focus: true })
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => childEditor(page), { timeout: 30_000 }).toMatchObject({ value: `id:${taken.id}` })
    expect(await page.evaluate(() => (window as any)._modal_visible())).toBe(false)
    await page.keyboard.press('Escape')
    // nor does a create by code ask, whatever its text names: the key and the create button do (as for a named item's child)
    expect(await page.evaluate(id => (window._create(`id:${id}`) as any)?.text ?? null, unnamed.id)).toBe(`id:${unnamed.id}`)
    expect(await page.evaluate(() => (window as any)._modal_visible())).toBe(false)
    // nor a text that a command puts in the entered one's place: that item deleted, and /_undelete entered
    const copies = () => page.evaluate(id => window._items().filter(item => item.text == `id:${id}`).length, unnamed.id)
    await page.evaluate(id => window._item(window._items().find(item => item.text == `id:${id}`)!.id, true)!.delete(false), unnamed.id)
    expect(await copies()).toBe(0)
    await selected(page, '/_undelete', { focus: true })
    await page.keyboard.press('Shift+Enter')
    await expect.poll(copies, { timeout: 30_000 }).toBe(1)
    expect(await page.evaluate(() => (window as any)._modal_visible())).toBe(false)
    // (d) an item deleted behind the app while its dialog is open: the accepted name names nothing
    await selected(page, `id:${gone.id}`, { focus: true })
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => nameInput(page), { timeout: 30_000 }).toEqual(offered('thread_0'))
    await firestore().collection('items').doc(gone.saved).delete()
    await expect.poll(() => page.evaluate(id => window._exists(id), gone.id), { timeout: 30_000 }).toBe(false)
    await page.keyboard.press('Enter')
    await expect(page.locator('.modal')).toBeHidden()
    expect([await page.evaluate(() => window._exists('#thread_0')), errors]).toEqual([false, []])
    // (e) refused: the item is not editable (an installed item, until /_edit)
    const editable = (editable: boolean) => page.evaluate(([id, editable]) => void ((window._item(id, true) as any).editable = editable), [unnamed.id, editable] as const)
    await editable(false)
    await selected(page, `id:${unnamed.id}`, { focus: true })
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => dialog(page), { timeout: 30_000 }).toEqual(['can not name an item that is not editable'])
    await page.keyboard.press('Escape')
    await expect(page.locator('.modal')).toBeHidden()
    await editable(true)
    // (f) refused: the item is open in an editor (a write would replace the editor's text and stay unsaved)
    await selected(page, `id:${unnamed.id}`) // the query brings the item into view
    await expect.poll(() => page.evaluate(id => !!window._item(id, true)?.elem, unnamed.id), { timeout: 10_000 }).toBe(true)
    await page.locator(`.column:not(.hidden) #item-${unnamed.id} p`).first().click()
    await expect(page.locator(`#textarea-${unnamed.id}`)).toBeFocused()
    await page.evaluate(() => document.getElementById('textarea-mindbox')!.focus()) // the item's editor stays open
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => dialog(page), { timeout: 30_000 }).toEqual(['can not name an item while editing it'])
    await page.keyboard.press('Escape')
    await expect(page.locator('.modal')).toBeHidden()
    expect([await page.evaluate(id => window._item(id, true)!.text, unnamed.id), await mindbox(page).inputValue()]).toEqual([texts[0], `id:${unnamed.id}`])
  } finally {
    await deleteNamed()
  }
})

async function searchMindbox(page: Page, q: string) {
  await focusMindboxInPlace(page)
  await expect(mindbox(page)).toBeFocused()
  await mindbox(page).fill(q)
  await expect
    .poll(
      () =>
        page.evaluate(
          q =>
            (window as any)._mindboxDebounced === false &&
            (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value === q &&
            history.state?.editorText === q,
          q
        ),
      { message: `query "${q}" applied`, timeout: 10_000 }
    )
    .toBe(true)
}

function visibleEditContainer(page: Page, id: string) {
  return page.locator(`.column:not(.hidden) .super-container:not(.hidden) > .container.editing[data-item-id="${id}"]`)
}

async function expectEditorVisible(page: Page, id: string, draft: string, context: string) {
  const editContainer = visibleEditContainer(page, id)
  await expect(editContainer, `edited item stays rendered ${context}`).toBeVisible()
  await expect(editContainer.locator('.edit-menu'), `edit menu stays visible ${context}`).toBeVisible()
  await expect(editContainer.locator(`#textarea-${id}`), `unsaved draft stays intact ${context}`).toHaveValue(draft)
}

async function openEditorWithDraft(page: Page, id: string, suffix: string, expectedDraft: string) {
  const paragraph = page.locator(`.column:not(.hidden) .super-container:not(.hidden) #item-${id} p`).first()
  await expect(paragraph).toBeVisible()
  await paragraph.click()
  const editTextarea = page.locator(`#textarea-${id}`)
  await expect(editTextarea).toBeFocused()
  await page.evaluate(id => {
    const t = document.getElementById(`textarea-${id}`) as HTMLTextAreaElement
    t.setSelectionRange(t.value.length, t.value.length)
  }, id)
  await page.keyboard.type(suffix)
  await expect(editTextarea).toHaveValue(expectedDraft)
}

test('searching for #log keeps an edited non-log item visible above the log items, leaving edited log items, errors, and other queries unchanged', async ({ page }) => {
  const LOG_COUNT = 40
  const EDIT_ID = 'e2e_log_search_edit'
  const OTHER_ID = 'e2e_log_search_other'
  const PIN_MATCH_ID = 'e2e_log_search_pm'
  const ERROR_ID = 'e2e_log_search_err'
  const EDIT_TEXT = '#e2e_log_search_edit non-log item edited across a search'
  const DRAFT_TEXT = `${EDIT_TEXT} draft`
  const logIds = Array.from({ length: LOG_COUNT }, (_, i) => `e2e_log_search_log_${String(i).padStart(2, '0')}`)
  const expectedLogIdsNewestFirst = [...logIds].reverse()
  const allIds = [EDIT_ID, OTHER_ID, PIN_MATCH_ID, ERROR_ID, ...logIds]
  const baseTime = Date.now() - 48 * 3600 * 1000
  const batch = firestore().batch()
  const itemsCol = firestore().collection('items')
  batch.set(itemsCol.doc(EDIT_ID), { user: 'anonymous', time: baseTime - 60_000, attr: null, text: EDIT_TEXT })
  batch.set(itemsCol.doc(OTHER_ID), { user: 'anonymous', time: baseTime - 120_000, attr: null, text: '#e2e_log_search_other target for another query' })
  batch.set(itemsCol.doc(PIN_MATCH_ID), { user: 'anonymous', time: baseTime - 180_000, attr: null, text: '#e2e_log_search_pm #_log/pin pinned match for log' })
  batch.set(itemsCol.doc(ERROR_ID), { user: 'anonymous', time: baseTime - 240_000, attr: null, text: '#e2e_log_search_err\nERROR: synthetic error' })
  logIds.forEach((id, i) => {
    batch.set(itemsCol.doc(id), { user: 'anonymous', time: baseTime + i * 60_000, attr: null, text: `#log e2e_log_search entry ${i}` })
  })
  await batch.commit()

  const readState = () =>
    page.evaluate(
      ([editId, otherId, pinMatchId, errorId, logPrefix]) => {
        const items = (window as any).__items as any[]
        const hideIndex = (window as any).__hideIndex as number
        const byId = (id: string) => {
          const item = items.find(i => i.id == id)
          return item
            ? {
                index: item.index as number,
                editing: !!item.editing,
                target: !!item.target,
                pinnedMatch: !!item.pinnedMatch,
                hasError: !!item.hasError,
              }
            : null
        }
        const above = items.filter(i => i.dotted || i.pinned || i.pinnedMatch).map(i => i.index as number)
        const logs = items
          .filter(i => i.log && !i.dotted && !i.pinned && !i.pinnedMatch)
          .map(i => ({ id: i.id as string, index: i.index as number, time: i.time as number, editing: !!i.editing }))
        const seededLogs = logs.filter(i => i.id.startsWith(logPrefix))
        return {
          hideIndex,
          lastAbove: above.length ? Math.max(...above) : -1,
          edit: byId(editId),
          other: byId(otherId),
          pinMatch: byId(pinMatchId),
          err: byId(errorId),
          logs,
          seededLogs,
        }
      },
      [EDIT_ID, OTHER_ID, PIN_MATCH_ID, ERROR_ID, 'e2e_log_search_log_'] as const
    )

  try {
    await loadAdmin(page)
    await expect
      .poll(() => page.evaluate(ids => ids.every(id => (window as any).__items.some((i: any) => i.id == id)), allIds), {
        message: 'all seeded fixtures loaded',
        timeout: 30_000,
      })
      .toBe(true)

    // bring the non-log item into view and open its editor with an unsaved draft
    await searchMindbox(page, '#e2e_log_search_edit')
    await openEditorWithDraft(page, EDIT_ID, ' draft', DRAFT_TEXT)

    // search for #log while the non-log item is in edit mode
    await searchMindbox(page, '#log')
    const atLog = await readState()
    expect(atLog.seededLogs.length, 'all 40 seeded log items are ranked').toBe(LOG_COUNT)
    expect(atLog.edit?.editing, 'precondition: non-log item is in edit mode').toBe(true)
    const firstLogIndex = atLog.logs[0].index
    const lastLogIndex = atLog.logs[atLog.logs.length - 1].index
    const hiddenLogs = atLog.logs.filter(i => i.index >= atLog.hideIndex).length
    expect(lastLogIndex, 'precondition: log items extend past __hideIndex so an item below them disappears').toBeGreaterThanOrEqual(atLog.hideIndex)
    expect(hiddenLogs, 'precondition: at least five log items lie past __hideIndex').toBeGreaterThanOrEqual(5)

    // the edited non-log item stays below __hideIndex, rendered with its editor, above the log items,
    // and below dotted, pinned and pinned-match items
    expect(atLog.edit!.index, `edited non-log item index (${atLog.edit!.index}) must stay below __hideIndex (${atLog.hideIndex}) under #log`).toBeLessThan(atLog.hideIndex)
    expect(atLog.edit!.index, `edited non-log item (${atLog.edit!.index}) must rank above the first log item (${firstLogIndex}) under #log`).toBeLessThan(firstLogIndex)
    expect(atLog.edit!.index, 'edited non-log item stays below dotted, pinned and pinned-match items').toBeGreaterThan(atLog.lastAbove)
    expect(atLog.pinMatch?.pinnedMatch && atLog.pinMatch.index < atLog.edit!.index, 'pinned-match item ranks above the edited non-log item').toBe(true)
    await expectEditorVisible(page, EDIT_ID, DRAFT_TEXT, 'under #log')

    // all unpinned log items stay in descending time order below the edited item, and error items stay below them
    expect(atLog.logs.every(i => i.index > atLog.edit!.index), 'every unpinned log item ranks below the edited non-log item').toBe(true)
    expect(atLog.logs.every((it, i) => i == 0 || atLog.logs[i - 1].time >= it.time), 'all unpinned log items remain in descending time order').toBe(true)
    expect(atLog.seededLogs.map(i => i.id), 'the 40 seeded log items remain newest-to-oldest').toEqual(expectedLogIdsNewestFirst)
    expect(atLog.err?.hasError && atLog.err.index > lastLogIndex, 'error non-log item stays below log items under #log').toBe(true)

    // under a different query (with a target that does not match the edited item), the edited item is still shown below the target as before
    await searchMindbox(page, '#e2e_log_search_other')
    const atOther = await readState()
    expect(atOther.other?.target, 'the other query has its target').toBe(true)
    expect(atOther.edit!.index, 'under another query the edited item stays below the target').toBeGreaterThan(atOther.other!.index)
    expect(atOther.edit!.index, 'under another query the edited item stays below __hideIndex').toBeLessThan(atOther.hideIndex)
    await expectEditorVisible(page, EDIT_ID, DRAFT_TEXT, 'under another query')

    // an edited log item keeps its place in time order under #log (opening its editor triggers onEditorChange('#log'))
    await searchMindbox(page, '#log')
    const midLogId = expectedLogIdsNewestFirst[2] // 3rd newest seeded log item, above __hideIndex
    const midLogParagraph = page.locator(`.column:not(.hidden) .super-container:not(.hidden) #item-${midLogId} p`).first()
    await expect(midLogParagraph).toBeVisible()
    await midLogParagraph.click()
    await expect(page.locator(`#textarea-${midLogId}`)).toBeFocused()
    const withEditedLog = await readState()
    expect(withEditedLog.seededLogs.find(i => i.id == midLogId)?.editing, 'log item is in edit mode').toBe(true)
    expect(withEditedLog.seededLogs.map(i => i.id), 'an edited log item keeps its exact place in time order under #log').toEqual(expectedLogIdsNewestFirst)
    expect(withEditedLog.edit!.index, 'edited non-log item still ranks above the first log item').toBeLessThan(withEditedLog.logs[0].index)
  } finally {
    const cleanup = firestore().batch()
    allIds.forEach(id => cleanup.delete(itemsCol.doc(id)))
    await cleanup.commit()
  }
})

test('an old log item being edited stays in place while the search stands, moves into view on a new search, and returns to its time order on cancel', async ({ page }) => {
  const LOG_COUNT = 40
  const FIND_QUERY = 'e2e_log_edit_find'
  const OTHER_ID = 'e2e_log_edit_other'
  const logIds = Array.from({ length: LOG_COUNT }, (_, i) => `e2e_log_edit_log_${String(i).padStart(2, '0')}`)
  const expectedLogIdsNewestFirst = [...logIds].reverse()
  const OLD_LOG_ID = logIds[0] // oldest seeded log item
  const NEW_LOG_ID = logIds[LOG_COUNT - 1] // newest seeded log item, shares FIND_QUERY so OLD_LOG_ID ranks below it
  const OLD_LOG_TEXT = `#log ${FIND_QUERY} old entry`
  const DRAFT_TEXT = `${OLD_LOG_TEXT} draft`
  const allIds = [OTHER_ID, ...logIds]
  const baseTime = Date.now() - 48 * 3600 * 1000
  const oldLogTime = baseTime
  const batch = firestore().batch()
  const itemsCol = firestore().collection('items')
  batch.set(itemsCol.doc(OTHER_ID), { user: 'anonymous', time: baseTime - 60_000, attr: null, text: '#e2e_log_edit_other target for another query' })
  logIds.forEach((id, i) => {
    const text =
      id == OLD_LOG_ID
        ? OLD_LOG_TEXT
        : id == NEW_LOG_ID
          ? `#log ${FIND_QUERY} newest entry`
          : `#log e2e_log_edit entry ${i}`
    batch.set(itemsCol.doc(id), { user: 'anonymous', time: baseTime + i * 60_000, attr: null, text })
  })
  await batch.commit()

  const readState = () =>
    page.evaluate(
      ([oldLogId, newLogId, otherId, logPrefix]) => {
        const items = (window as any).__items as any[]
        const hideIndex = (window as any).__hideIndex as number
        const byId = (id: string) => {
          const item = items.find(i => i.id == id)
          return item
            ? {
                index: item.index as number,
                time: item.time as number,
                editing: !!item.editing,
                editingPromoted: !!item.editingPromoted,
                target: !!item.target,
              }
            : null
        }
        const logs = items
          .filter(i => i.log && !i.dotted && !i.pinned && !i.pinnedMatch)
          .map(i => ({ id: i.id as string, index: i.index as number, time: i.time as number, editing: !!i.editing }))
        const seededLogs = logs.filter(i => i.id.startsWith(logPrefix))
        return {
          hideIndex,
          oldLog: byId(oldLogId),
          newLog: byId(newLogId),
          other: byId(otherId),
          logs,
          seededLogs,
        }
      },
      [OLD_LOG_ID, NEW_LOG_ID, OTHER_ID, 'e2e_log_edit_log_'] as const
    )

  try {
    await loadAdmin(page)
    await expect
      .poll(() => page.evaluate(ids => ids.every(id => (window as any).__items.some((i: any) => i.id == id)), allIds), {
        message: 'all seeded fixtures loaded',
        timeout: 30_000,
      })
      .toBe(true)

    // precondition: under #log the old log item sits past __hideIndex among the seeded log items
    await searchMindbox(page, '#log')
    const initialLog = await readState()
    expect(initialLog.seededLogs.map(i => i.id), 'precondition: all 40 seeded log items ranked newest-to-oldest').toEqual(expectedLogIdsNewestFirst)
    expect(
      initialLog.oldLog!.index,
      `precondition: old log item (${initialLog.oldLog!.index}) must lie past __hideIndex (${initialLog.hideIndex}) under #log`
    ).toBeGreaterThanOrEqual(initialLog.hideIndex)

    // find the old log item by its text (below NEW_LOG_ID so staying in place is observable) and open its editor with an unsaved draft
    await searchMindbox(page, FIND_QUERY)
    const found = await readState()
    expect(found.oldLog!.index, 'precondition: old log item is visible under text search').toBeLessThan(found.hideIndex)
    expect(found.oldLog!.index, 'precondition: old log item ranks below the newer matching log item').toBeGreaterThan(found.newLog!.index)
    const inPlaceIndex = found.oldLog!.index
    await openEditorWithDraft(page, OLD_LOG_ID, ' draft', DRAFT_TEXT)
    const afterOpen = await readState()
    expect(afterOpen.oldLog!.editing, 'old log item is in edit mode').toBe(true)
    expect(afterOpen.oldLog!.index, 'opening the editor keeps the old log item in place').toBe(inPlaceIndex)
    expect(afterOpen.oldLog!.time, 'opening the editor leaves the log item time unchanged').toBe(oldLogTime)

    // (a) the same search again (same ranked query, different raw spacing to trigger a real ranking pass): index unchanged
    await searchMindbox(page, `${FIND_QUERY} `)
    const afterSameSearch = await readState()
    expect(afterSameSearch.oldLog!.index, 'same search again keeps the edited log item in place').toBe(inPlaceIndex)
    expect(afterSameSearch.oldLog!.index, 'still below the newer matching log item').toBeGreaterThan(afterSameSearch.newLog!.index)
    expect(afterSameSearch.oldLog!.time, 'same search leaves the log item time unchanged').toBe(oldLogTime)
    await expectEditorVisible(page, OLD_LOG_ID, DRAFT_TEXT, 'under the same search')

    // (b) search #log: the edited log item moves into view above the first non-edited log item, keeping its draft
    await searchMindbox(page, '#log')
    const atLog = await readState()
    const firstNonEditedLog = atLog.logs.find(i => !i.editing)!
    expect(atLog.oldLog!.editing, 'old log item remains in edit mode under #log').toBe(true)
    expect(
      atLog.oldLog!.index,
      `edited old log item index (${atLog.oldLog!.index}) must stay below __hideIndex (${atLog.hideIndex}) under #log`
    ).toBeLessThan(atLog.hideIndex)
    expect(
      atLog.oldLog!.index,
      `edited old log item (${atLog.oldLog!.index}) must rank above the first non-edited log item (${firstNonEditedLog.index}) under #log`
    ).toBeLessThan(firstNonEditedLog.index)
    expect(atLog.oldLog!.time, 'moving up under #log leaves the log item time unchanged').toBe(oldLogTime)
    await expectEditorVisible(page, OLD_LOG_ID, DRAFT_TEXT, 'under #log')

    // (c) another query: still visible below the target, keeping its draft
    await searchMindbox(page, '#e2e_log_edit_other')
    const atOther = await readState()
    expect(atOther.other?.target, 'the other query has its target').toBe(true)
    expect(atOther.oldLog!.index, 'under another query the edited log item stays below the target').toBeGreaterThan(atOther.other!.index)
    expect(atOther.oldLog!.index, 'under another query the edited log item stays below __hideIndex').toBeLessThan(atOther.hideIndex)
    expect(atOther.oldLog!.time, 'another query leaves the log item time unchanged').toBe(oldLogTime)
    await expectEditorVisible(page, OLD_LOG_ID, DRAFT_TEXT, 'under another query')

    // (d) end the edit by a cancel (confirming discard of the unsaved draft): under #log it returns to its place by time
    await visibleEditContainer(page, OLD_LOG_ID).locator('.edit-menu .button.cancel').click()
    await expect(page.locator('.modal')).toContainText('Discard unsaved changes to')
    await page.locator('.modal .button.confirm', { hasText: 'Discard' }).click()
    await expect(page.locator('.modal')).toBeHidden()
    await expect
      .poll(() => page.evaluate(id => (window as any).__items.find((i: any) => i.id == id)?.editing, OLD_LOG_ID), {
        message: 'old log item exits edit mode after cancel',
        timeout: 10_000,
      })
      .toBe(false)

    await searchMindbox(page, '#log')
    const afterCancel = await readState()
    expect(afterCancel.oldLog!.editing, 'old log item is no longer editing').toBe(false)
    expect(afterCancel.oldLog!.editingPromoted, 'promotion flag is cleared when the edit ends').toBe(false)
    expect(afterCancel.oldLog!.time, 'cancelling the edit leaves the log item time unchanged').toBe(oldLogTime)
    expect(afterCancel.oldLog!.index, 'after cancel, old log item is past __hideIndex again under #log').toBeGreaterThanOrEqual(afterCancel.hideIndex)
    expect(afterCancel.seededLogs.map(i => i.id), 'after cancel, all 40 seeded log items are back in newest-to-oldest order').toEqual(expectedLogIdsNewestFirst)
  } finally {
    const cleanup = firestore().batch()
    allIds.forEach(id => cleanup.delete(itemsCol.doc(id)))
    await cleanup.commit()
  }
})
