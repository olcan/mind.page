import { expect, test, type Page } from '@playwright/test'
import { mindbox, focusMindbox, focusMindboxInPlace, savedId, itemText, visible, asUser, entries, settled, blur, headerTop, noWritePending } from './editor_helpers.js'
import { firestore, loadAdmin, waitForApp } from './helpers.js'

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

  // editor backdrop address colouring: a markdown link whose address carries a balanced bracket
  // pair and a colon tail keeps the whole address in its grey inner span, and a definition line
  // keeps its whole colon-tail address in one bare blue span
  const MD_URL = 'https://example.org/Mercury_(planet)#:~:text=small'
  const DEF_URL = 'https://alexwang.ai/posts/associative-memory/#rw=01m8:~:text=about%201.2%20million'
  await textarea.press('Backspace') // replaces the already-selected text
  await textarea.pressSequentially(`#e2e_zwsp [web](${MD_URL})`)
  await textarea.press('Enter')
  await textarea.pressSequentially(`[w1]: ${DEF_URL}`)
  const linkSpans = await textarea.evaluate((el: HTMLTextAreaElement) =>
    [...el.closest('.editor')!.querySelectorAll('.backdrop span.link')].map(s => ({
      text: (s.textContent ?? '').replaceAll('\u200B', ''),
      color: getComputedStyle(s).color,
      nested: s.parentElement?.matches('span.link') ?? false,
    }))
  )
  expect(linkSpans, 'markdown link inner address (grey) and definition address (blue) are coloured whole').toEqual([
    { text: `[web](${MD_URL})`, color: 'rgb(85, 119, 187)', nested: false },
    { text: MD_URL, color: 'rgb(136, 136, 136)', nested: true },
    { text: DEF_URL, color: 'rgb(85, 119, 187)', nested: false },
  ])

  // the edit is discarded: the item stays as the row always left it
  await page.keyboard.press('Escape')
  const discard = page.locator('.modal .button.confirm', { hasText: 'Discard' })
  await expect(discard).toBeVisible()
  await discard.click()
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
// a first child as the app makes it under a named item: caret collapsed after the space
const child = (label: string) => {
  const value = `${label}/0 `
  return { value, start: value.length, end: value.length }
}

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
    // (c) a named item takes its child without a dialog, its text as it was, and the child's
    // editor opens with the caret collapsed after the space so typing extends it
    await test.step('Shift+Enter on a named item opens the child editor with caret collapsed at the end and typing extends it', async () => {
      await selected(page, TAKEN, { focus: true })
      await page.keyboard.press('Shift+Enter')
      await expect.poll(() => childEditor(page), { message: 'child editor opened and focused', timeout: 30_000 }).not.toBeNull()
      const expected = `${TAKEN}/0 `
      expect(await childEditor(page), 'child editor opens with label, slash, number, space and caret collapsed at end').toEqual(child(TAKEN))
      expect([await page.evaluate(() => (window as any)._modal_visible()), await page.evaluate(id => window._item(id, true)!.text, taken.id)]).toEqual([false, texts[2]])
      await page.keyboard.type('x')
      expect(await childEditor(page), 'a typed character is added after the space').toEqual({
        value: expected + 'x',
        start: expected.length + 1,
        end: expected.length + 1,
      })
      await page.keyboard.press('Backspace')
      expect(await childEditor(page), 'backspacing restores the child scaffold').toEqual(child(TAKEN))
      await page.keyboard.press('Escape') // the child's editor closed, nothing typed
    })
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

test('deferred _create naming dialog applies mindbox_text while pending, keeps it on cancel, selects the child on accept, and keeps the prior query only on immediate refusals', async ({ page }) => {
  await deleteNamed()
  await loadAdmin(page)
  const texts = ['e2e_cn deferred cancel', 'e2e_cn deferred accept']
  try {
    const [uCancel, uAccept] = await createdItems(page, texts)

    // (a) Deferred naming dialog cancelled: matches pre-stage-2 behavior (box holds mindbox_text
    // while the prompt is open and after cancellation; promise resolves to undefined).
    await selected(page, `id:${uCancel.id}`)
    await expect(mindbox(page)).toHaveValue(`id:${uCancel.id}`)
    const isPromiseCancel = await page.evaluate(id => {
      const p = (window as any)._create(`id:${id}`, { history: true, mindbox_text: '#wanted' })
      ;(window as any).__f4_cancel = p
      return typeof p?.then === 'function'
    }, uCancel.id)
    expect(isPromiseCancel, 'naming-dialog _create returns a promise').toBe(true)
    await expect.poll(() => nameInput(page), { timeout: 30_000 }).toEqual(offered('thread_0'))
    expect(await mindbox(page).inputValue(), 'MindBox applies mindbox_text while naming dialog is open').toBe('#wanted')
    await page.keyboard.press('Escape')
    await expect(page.locator('.modal')).toBeHidden()
    expect(await page.evaluate(async () => (await (window as any).__f4_cancel) ?? null)).toBeNull()
    expect(await mindbox(page).inputValue(), 'MindBox keeps mindbox_text after naming dialog is cancelled').toBe('#wanted')
    expect(await page.evaluate(() => window._exists('#thread_0')), 'cancelled dialog creates no item').toBe(false)

    // (b) Deferred naming dialog accepted: box holds mindbox_text while open, then selects the new child.
    await selected(page, `id:${uAccept.id}`)
    await expect(mindbox(page)).toHaveValue(`id:${uAccept.id}`)
    const isPromiseAccept = await page.evaluate(id => {
      const p = (window as any)._create(`id:${id}`, { history: true, mindbox_text: '#wanted' })
      ;(window as any).__f4_accept = p
      return typeof p?.then === 'function'
    }, uAccept.id)
    expect(isPromiseAccept, 'naming-dialog _create returns a promise before accept').toBe(true)
    await expect.poll(() => nameInput(page), { timeout: 30_000 }).toEqual(offered('thread_0'))
    expect(await mindbox(page).inputValue(), 'MindBox applies mindbox_text while naming dialog is open (accept path)').toBe('#wanted')
    await page.keyboard.press('Enter')
    await expect(page.locator('.modal')).toBeHidden()
    const accepted = await page.evaluate(async () => {
      const it = await (window as any).__f4_accept
      return it ? { name: it.name, text: it.text } : null
    })
    expect(accepted, 'accepted naming dialog creates #thread_0/0').toEqual({ name: '#thread_0/0', text: '#thread_0/0 ' })
    expect(await mindbox(page).inputValue(), 'MindBox selects created child after naming dialog is accepted').toBe('#thread_0/0 ')

    // (c) Immediate refusal (non-editable unnamed item): both return_alerts=true (string return) and
    // return_alerts=false (undefined return) leave MindBox on the prior query instead of applying mindbox_text.
    await page.evaluate(id => void ((window._item(id, true) as any).editable = false), uCancel.id)
    try {
      await selected(page, `id:${uCancel.id}`)
      await expect(mindbox(page)).toHaveValue(`id:${uCancel.id}`)
      const alertStr = await page.evaluate(id => (window as any)._create(`id:${id}`, { history: true, mindbox_text: '#wanted', return_alerts: true }), uCancel.id)
      expect(alertStr, 'immediate refusal with return_alerts returns alert string').toBe('can not name an item that is not editable')
      expect(await mindbox(page).inputValue(), 'immediate refusal (string alert) leaves MindBox unchanged').toBe(`id:${uCancel.id}`)

      const alertUndef = await page.evaluate(id => (window as any)._create(`id:${id}`, { history: true, mindbox_text: '#wanted', return_alerts: false }) ?? null, uCancel.id)
      expect(alertUndef, 'immediate refusal without return_alerts returns undefined').toBeNull()
      await expect.poll(() => dialog(page), { timeout: 15_000 }).toEqual(['can not name an item that is not editable'])
      await page.keyboard.press('Escape')
      await expect(page.locator('.modal')).toBeHidden()
      expect(await mindbox(page).inputValue(), 'immediate refusal (undefined return) leaves MindBox unchanged').toBe(`id:${uCancel.id}`)
    } finally {
      await page.evaluate(id => void ((window._item(id, true) as any).editable = true), uCancel.id)
    }
  } finally {
    await deleteNamed()
  }
})

test('the create key seeds non-collapsed page text selected outside editable fields as an unsaved draft in a new child editor, leaving the initial stored document at the scaffold, preserving characters verbatim on save, skipping macro eval while open, and quoting nothing for editable fields, empty selections, non-child or non-editing creations', async ({ page }) => {
  await deleteNamed()
  await loadAdmin(page)
  const OTHER = '#e2e_cn_other'
  const PARENT = `${OTHER}/sub`
  const RAW_PARENT = '#e2e_cn_raw'
  const LITERAL = 'R&D #e2e_lit <details open></details> <<1+1>>'
  const MACRO = '<<window.__e2e_quote_macro=1>>'
  const texts = [
    `${PARENT} hello world and plain text`,
    `${OTHER} context item\n\nplain paragraph\n\nfirst "inner" line\n\nsecond &#8203; line\n\n<input type="text" class="e2e-w-in" value="widget input">\n<div class="e2e-w-ce" contenteditable="true">editable div</div>`,
    'e2e_cn unnamed note with before dialog',
    'e2e_cn unnamed note for save dialog',
    `${RAW_PARENT}\n\n\`\`\` \\${MACRO} \`\`\`\n\n<!--inert-->\n\`${LITERAL}\`\n\n${MACRO}\n<!--/inert-->`,
    'e2e_cn plain note for the menu',
  ]
  const quotedChild = (label: string, n: number, quote: string) => {
    const value = `${label}/${n} "${quote}" `
    return { value, start: value.length, end: value.length }
  }
  const plainChild = (label: string, n: number) => {
    const value = `${label}/${n} `
    return { value, start: value.length, end: value.length }
  }
  const waitItem = async (id: string) => {
    await waitForRenderOverlayGone(page)
    await expect(page.locator(`.column:not(.hidden) #item-${id}`)).toBeVisible({ timeout: 10_000 })
  }
  const selectionInfo = () =>
    page.evaluate(() => {
      const sel = window.getSelection()
      return {
        type: sel?.type ?? null,
        collapsed: sel?.isCollapsed ?? true,
        text: sel?.toString() ?? '',
        active: document.activeElement?.tagName ?? null,
      }
    })
  const selectAcross = (itemId: string, startText: string, endText: string) =>
    page.evaluate(
      ([id, a, b]) => {
        const root = document.querySelector(`.column:not(.hidden) #item-${id}`)!
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let sNode: Node | null = null
        let sOff = 0
        let eNode: Node | null = null
        let eOff = 0
        while (walker.nextNode()) {
          const val = walker.currentNode.nodeValue ?? ''
          if (!sNode) {
            const at = val.indexOf(a)
            if (at >= 0) {
              sNode = walker.currentNode
              sOff = at
            }
          }
          const atEnd = val.indexOf(b)
          if (atEnd >= 0) {
            eNode = walker.currentNode
            eOff = atEnd + b.length
          }
        }
        if (!sNode || !eNode) return null
        ;(document.activeElement as HTMLElement | null)?.blur()
        window.getSelection()!.setBaseAndExtent(sNode, sOff, eNode, eOff)
        return window.getSelection()!.toString()
      },
      [itemId, startText, endText] as const
    )
  const dragPhrase = async (itemId: string, phrase: string) => {
    const box = await page.evaluate(
      ([id, text]) => {
        const root = document.querySelector(`.column:not(.hidden) #item-${id}`)!
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const at = (walker.currentNode.nodeValue ?? '').indexOf(text)
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(walker.currentNode, at)
          range.setEnd(walker.currentNode, at + text.length)
          const r = range.getBoundingClientRect()
          return { x: r.x, y: r.y + r.height / 2, width: r.width }
        }
        return null
      },
      [itemId, phrase] as const
    )
    expect(box, `phrase "${phrase}" found in item ${itemId}`).not.toBeNull()
    await page.mouse.move(box!.x + 1, box!.y)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width - 1, box!.y, { steps: 4 })
    await page.mouse.up()
  }
  const storedText = async (docId: string) => (await firestore().collection('items').doc(docId).get()).data()?.text ?? null
  // wait for an item's in-flight write to acknowledge in Firestore and return its state
  const waitAcked = async (label: string) => {
    let state: { id: string; savedId: string; text: string; savedText: string; editorText: string; editing: boolean; saving: boolean } | null = null
    await expect
      .poll(
        async () => {
          state = await page.evaluate(l => {
            const it = (window.__items as any[]).find(i => i.labelText == l)
            return it
              ? {
                  id: it.id as string,
                  savedId: (it.savedId ?? '') as string,
                  text: it.text as string,
                  savedText: it.savedText as string,
                  editorText: it.editorText as string,
                  editing: !!it.editing,
                  saving: !!it.saving,
                }
              : null
          }, label)
          return !!state?.savedId && !state.saving && !!state.savedText
        },
        { message: `${label}: initial/pending write acknowledged`, timeout: 30_000 }
      )
      .toBe(true)
    return state!
  }
  // exercises the app's own onBeforeUnload -> items.some(unsaved) predicate without navigating. where
  // the app answers with its prompt, the page was kept (nothing navigated here), so its list of the
  // unsaved items follows after its wait (listUnsavedIfKept in index.svelte; the list's own row is in
  // lifecycle.spec.ts): closed here, which gives the focus back, so that the row goes on as before
  const beforeUnloadPrompt = async () => {
    const answer = await page.evaluate(() => {
      const ev = document.createEvent('BeforeUnloadEvent')
      ev.initEvent('beforeunload', false, true)
      window.dispatchEvent(ev)
      return ev.returnValue
    })
    if (answer) {
      const list = page.locator('.modal .unsaved-items')
      await expect(list, 'a kept page lists its unsaved items').toBeVisible({ timeout: 10_000 })
      await page.locator('.modal .button.confirm', { hasText: /^OK$/ }).click()
      await expect(list).toBeHidden({ timeout: 10_000 })
    }
    return answer
  }
  const closeChild = async () => {
    await page.keyboard.press('Escape')
    await expect.poll(() => childEditor(page), { timeout: 10_000 }).toBeNull()
  }
  // leave an open quoted child without saving once its initial write settled: Escape prompts
  // "Discard unsaved changes to <label>?" (the app's exact behavior for typed text), and Discard
  // closes the editor leaving only the scaffold stored
  const discardQuotedChild = async (label: string, docId: string) => {
    await page.keyboard.press('Escape')
    await expect(page.getByText(`Discard unsaved changes to ${label}?`)).toBeVisible({ timeout: 10_000 })
    await page.locator('.modal .button.confirm', { hasText: 'Discard' }).click()
    await expect(page.locator('.modal')).toBeHidden({ timeout: 10_000 })
    await expect.poll(() => childEditor(page), { timeout: 10_000 }).toBeNull()
    await waitAcked(label)
    expect(await page.evaluate(l => window._item(l, true)?.text ?? null, label), `${label}: page text after discard has no quote`).toBe(`${label} `)
    expect(await storedText(docId), `${label}: stored document after discard has no quote`).toBe(`${label} `)
    expect(await beforeUnloadPrompt(), `${label}: nothing unsaved after discard`).toBe('')
  }
  try {
    const [parent, other, unnamed, unnamedSave, raw, menu] = await createdItems(page, texts)
    expect(await beforeUnloadPrompt(), 'premise: nothing unsaved before creating children').toBe('')

    // (a) named parent with a real mouse drag on its rendered text: first acknowledged document
    // holds only the scaffold; editor holds scaffold + quote with caret at end and backdrop painted;
    // app reports unsaved changes; typing and saving stores scaffold + quote + typed verbatim
    await selected(page, PARENT)
    await waitItem(parent.id)
    await page.locator(`.column:not(.hidden) #item-${parent.id} p`).first().scrollIntoViewIfNeeded()
    await dragPhrase(parent.id, 'hello world')
    expect(await selectionInfo(), 'mouse drag selected the phrase in the item').toMatchObject({
      type: 'Range',
      collapsed: false,
      text: 'hello world',
    })
    await page.keyboard.press('Shift+Enter')
    const FIRST = quotedChild(PARENT, 0, 'hello world')
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(FIRST)
    await expect(mindbox(page)).toHaveValue(`${PARENT}/0 `)
    expect(await selectionInfo(), 'focusing the new editor collapsed the page selection').toMatchObject({
      collapsed: true,
      text: '',
    })
    const firstAck = await waitAcked(`${PARENT}/0`)
    expect(await storedText(firstAck.savedId), 'first acknowledged document holds scaffold without quote').toBe(`${PARENT}/0 `)
    expect(firstAck, 'open item keeps scaffold in text/savedText and seeded draft in editorText').toMatchObject({
      editing: true,
      saving: false,
      text: `${PARENT}/0 `,
      savedText: `${PARENT}/0 `,
      editorText: FIRST.value,
    })
    expect(await childEditor(page), 'editor still holds draft after initial create acknowledges').toEqual(FIRST)
    expect(
      await page.locator(`#super-container-${firstAck.id} .editor .backdrop > div`).textContent(),
      'visible editor backdrop renders the seeded draft'
    ).toBe(FIRST.value + '\n')
    expect(await beforeUnloadPrompt(), 'app reports unsaved changes for the seeded draft').toBe('Discard unsaved changes?')
    await page.keyboard.type('next')
    expect(await childEditor(page), 'typing follows the quote at the collapsed caret').toEqual({
      value: FIRST.value + 'next',
      start: FIRST.value.length + 4,
      end: FIRST.value.length + 4,
    })
    await page.keyboard.press('Shift+Enter') // save the child
    await expect.poll(() => childEditor(page), { timeout: 10_000 }).toBeNull()
    await expect.poll(() => storedText(firstAck.savedId), { timeout: 30_000 }).toBe(FIRST.value + 'next')
    await waitAcked(`${PARENT}/0`)
    expect(await beforeUnloadPrompt(), 'nothing unsaved after saving child').toBe('')

    // (b) selection in ANOTHER item (not the named parent), across a line break, with inner quotes
    // and a ZWSP between spaces: whitespace runs collapse to one space, ZWSP removed, quotes kept;
    // leaving the editor without saving leaves only the scaffold stored
    await selected(page, PARENT)
    await waitItem(other.id)
    const rawMulti = await selectAcross(other.id, 'first', 'line')
    expect(rawMulti, 'premise: selection spans a line break and carries inner quotes and ZWSP').toMatch(/\n/)
    expect(rawMulti).toContain('"inner"')
    expect(rawMulti).toContain('\u200B')
    await page.keyboard.press('Shift+Enter')
    const SECOND = quotedChild(PARENT, 1, 'first "inner" line second line')
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(SECOND)
    const secondAck = await waitAcked(`${PARENT}/1`)
    expect(await storedText(secondAck.savedId), 'multi-line quote: first acknowledged document holds scaffold without quote').toBe(`${PARENT}/1 `)
    expect(await beforeUnloadPrompt(), 'multi-line quote: app reports unsaved changes').toBe('Discard unsaved changes?')
    // asking to discard changes nothing: while the app asks, and after Cancel, the item's own text is the
    // scaffold and its editor holds the draft; a save of the item for another reason (its time) then stores
    // the scaffold, and the draft is still the editor's
    const kept = () =>
      page.evaluate(label => {
        const it = (window.__items as any[]).find(i => i.labelText == label)
        return { text: it.text as string, editing: !!it.editing, editor: (document.getElementById(`textarea-${it.id}`) as HTMLTextAreaElement | null)?.value ?? null }
      }, `${PARENT}/1`)
    const KEPT = { text: `${PARENT}/1 `, editing: true, editor: SECOND.value }
    await page.keyboard.press('Escape')
    await expect(page.getByText(`Discard unsaved changes to ${PARENT}/1?`)).toBeVisible({ timeout: 10_000 })
    expect(await kept(), 'while the app asks, the draft is in the editor and not in the item').toEqual(KEPT)
    await page.locator('.modal .button.cancel').click()
    await expect(page.locator('.modal')).toBeHidden({ timeout: 10_000 })
    expect(await kept(), 'after Cancel, the draft is in the editor and not in the item').toEqual(KEPT)
    const storedTime = async () => (await firestore().collection('items').doc(secondAck.savedId).get()).data()?.time ?? null
    const timeBefore = await storedTime()
    await page.evaluate(label => void (window._item(label) as any).touch(true), `${PARENT}/1`)
    await expect.poll(storedTime, { message: "the save of the item's time reached the store", timeout: 30_000 }).not.toBe(timeBefore)
    await waitAcked(`${PARENT}/1`)
    expect(await storedText(secondAck.savedId), 'a save for another reason stores the scaffold, not the draft').toBe(`${PARENT}/1 `)
    expect(await kept(), 'the draft is still the editor\'s after that save').toEqual(KEPT)
    expect(await beforeUnloadPrompt(), 'the draft still counts as unsaved').toBe('Discard unsaved changes?')
    await page.locator(`#textarea-${secondAck.id}`).focus()
    await discardQuotedChild(`${PARENT}/1`, secondAck.savedId)

    // (c) unnamed parent through the naming dialog: selection captured BEFORE the dialog opens
    // (the dialog focuses and selects #modal-input, replacing the page selection) and carried into
    // the child's unsaved draft; verified for both discard and save paths
    await selected(page, `id:${unnamed.id}`)
    await waitItem(unnamed.id)
    await page.locator(`.column:not(.hidden) #item-${unnamed.id} p`).first().scrollIntoViewIfNeeded()
    await dragPhrase(unnamed.id, 'before dialog')
    expect(await selectionInfo(), 'premise: phrase selected before opening the naming dialog').toMatchObject({
      type: 'Range',
      collapsed: false,
      text: 'before dialog',
    })
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => nameInput(page), { timeout: 30_000 }).toEqual(offered('thread_0'))
    expect((await selectionInfo()).text, 'dialog replaced the page selection').not.toBe('before dialog')
    await page.keyboard.press('Enter')
    const DIALOG_DISCARD = quotedChild('#thread_0', 0, 'before dialog')
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(DIALOG_DISCARD)
    await expect(mindbox(page)).toHaveValue('#thread_0/0 ')
    const dialogDiscardAck = await waitAcked('#thread_0/0')
    expect(await storedText(dialogDiscardAck.savedId), 'dialog path: first acknowledged document holds scaffold without quote').toBe('#thread_0/0 ')
    expect(dialogDiscardAck, 'dialog path: open item holds seeded draft as unsaved editorText').toMatchObject({
      editing: true,
      saving: false,
      text: '#thread_0/0 ',
      savedText: '#thread_0/0 ',
      editorText: DIALOG_DISCARD.value,
    })
    expect(await beforeUnloadPrompt(), 'dialog path: app reports unsaved changes').toBe('Discard unsaved changes?')
    await discardQuotedChild('#thread_0/0', dialogDiscardAck.savedId)

    await selected(page, `id:${unnamedSave.id}`)
    await waitItem(unnamedSave.id)
    await page.locator(`.column:not(.hidden) #item-${unnamedSave.id} p`).first().scrollIntoViewIfNeeded()
    await dragPhrase(unnamedSave.id, 'save dialog')
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => nameInput(page), { timeout: 30_000 }).toEqual(offered('thread_1'))
    await page.keyboard.press('Enter')
    const DIALOG_SAVE = quotedChild('#thread_1', 0, 'save dialog')
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(DIALOG_SAVE)
    const dialogSaveAck = await waitAcked('#thread_1/0')
    expect(await storedText(dialogSaveAck.savedId), 'dialog save path: first acknowledged document holds scaffold without quote').toBe('#thread_1/0 ')
    expect(await beforeUnloadPrompt(), 'dialog save path: app reports unsaved changes').toBe('Discard unsaved changes?')
    await page.keyboard.type('kept')
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => childEditor(page), { timeout: 10_000 }).toBeNull()
    await expect.poll(() => storedText(dialogSaveAck.savedId), { timeout: 30_000 }).toBe(DIALOG_SAVE.value + 'kept')
    await waitAcked('#thread_1/0')

    // (d) selections inside editable fields quote nothing (plain child scaffold with caret at end):
    // (d1) MindBox textarea
    await selected(page, PARENT, { focus: true })
    await page.evaluate(() => {
      const ta = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      ta.setSelectionRange(0, ta.value.length)
    })
    expect(await selectionInfo(), 'premise: MindBox text selected').toMatchObject({ type: 'Range', text: PARENT })
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(plainChild(PARENT, 2))
    await closeChild()

    // (d2) an open item editor (non-collapsed Range in its .editor .backdrop, activeElement on BODY)
    await selected(page, PARENT)
    await waitItem(other.id)
    await page.locator(`.column:not(.hidden) #item-${other.id} p`, { hasText: 'plain paragraph' }).click()
    await expect(page.locator(`#textarea-${other.id}`)).toBeVisible({ timeout: 10_000 })
    // blur first and wait for Editor's post-blur DOM update before selecting inside its backdrop
    await page.locator(`#textarea-${other.id}`).blur()
    await expect(page.locator(`#textarea-${other.id}`)).not.toBeFocused()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    // the selection is set and the key sent in ONE script run: the editor redraws its backdrop on a schedule of
    // its own, which collapsed a selection inside it between two calls once (a loaded full gate, 2026-11-24). The
    // key's events are a keyboard's, in its order (as the key buttons' item sends them, on the body)
    const backdropPress = await page.evaluate(id => {
      const bd = document.querySelector(`#super-container-${id} .editor .backdrop`)!
      const walker = document.createTreeWalker(bd, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const val = walker.currentNode.nodeValue ?? ''
        const at = val.indexOf('plain paragraph')
        if (at < 0) continue
        const sel = window.getSelection()!
        sel.setBaseAndExtent(walker.currentNode, at, walker.currentNode, at + 'plain paragraph'.length)
        const stood = { text: sel.toString(), type: sel.type, collapsed: sel.isCollapsed, active: document.activeElement?.tagName }
        const send = (type: string, key: string, shiftKey: boolean) =>
          document.body.dispatchEvent(new KeyboardEvent(type, { key, code: key == 'Shift' ? 'ShiftLeft' : key, shiftKey, bubbles: true, cancelable: true, composed: true }))
        send('keydown', 'Shift', true)
        send('keydown', 'Enter', true)
        send('keyup', 'Enter', true)
        send('keyup', 'Shift', false)
        return stood
      }
      return null
    }, other.id)
    expect(backdropPress, 'premise: a non-collapsed selection stood inside the open item editor when the key was sent').toEqual({
      text: 'plain paragraph',
      type: 'Range',
      collapsed: false,
      active: 'BODY',
    })
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(plainChild(PARENT, 3))
    await page.keyboard.press('Escape') // closes the new child and focuses the still-open editor of `other`
    await expect(page.locator(`#textarea-${other.id}`)).toBeFocused({ timeout: 10_000 })
    await closeChild() // closes `other`'s editor too
    await waitItem(other.id)

    // (d3) a widget <input> (blurred, activeElement on BODY) and a widget [contenteditable="true"]
    await selected(page, PARENT)
    await waitItem(other.id)
    await page.evaluate(id => {
      const inp = document.querySelector(`#item-${id} input.e2e-w-in`) as HTMLInputElement
      inp.focus()
      inp.setSelectionRange(0, inp.value.length)
      inp.blur()
    }, other.id)
    expect(await selectionInfo(), 'premise: widget input text selected while blurred').toMatchObject({
      type: 'Range',
      text: 'widget input',
      active: 'BODY',
    })
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(plainChild(PARENT, 4))
    await closeChild()

    await selected(page, PARENT)
    await waitItem(other.id)
    await page.evaluate(id => {
      const ce = document.querySelector(`#item-${id} .e2e-w-ce`)!
      const text = ce.firstChild!
      window.getSelection()!.setBaseAndExtent(text, 0, text, text.nodeValue!.length)
      ;(document.activeElement as HTMLElement | null)?.blur()
    }, other.id)
    expect(await selectionInfo(), 'premise: contenteditable text selected while blurred').toMatchObject({
      type: 'Range',
      collapsed: false,
      text: 'editable div',
      active: 'BODY',
    })
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(plainChild(PARENT, 5))
    await closeChild()

    // (e) no selection, and a whitespace/ZWSP-only selection: plain child scaffold with caret at end
    await selected(page, PARENT)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    expect((await selectionInfo()).type).toBe('None')
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(plainChild(PARENT, 6))
    await closeChild()

    await selected(page, PARENT)
    await waitItem(other.id)
    expect(await selectAcross(other.id, ' \u200B ', ' \u200B ')).toBe(' \u200B ')
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(plainChild(PARENT, 7))
    await closeChild()

    // (f) creations that make no child (free text in the box), open no editor (2+ of Ctrl/Alt/Cmd
    // with Enter), or that no key asked for (synthetic _create, with or without history) quote nothing
    await selected(page, 'e2e_cn hello')
    await waitItem(parent.id)
    expect(await selectAcross(parent.id, 'plain text', 'plain text')).toBe('plain text')
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toMatchObject({ value: 'e2e_cn hello' })
    await closeChild()

    // keyboard creation that opens no editor (Ctrl+Alt+Enter -> editing == false): quotes nothing
    await selected(page, PARENT)
    await waitItem(parent.id)
    expect(await selectAcross(parent.id, 'hello world', 'hello world')).toBe('hello world')
    await page.keyboard.press('Control+Alt+Enter')
    const noEditAck = await waitAcked(`${PARENT}/8`)
    expect(noEditAck, 'no-editor keyboard creation leaves editor closed with scaffold alone').toMatchObject({
      editing: false,
      text: `${PARENT}/8 `,
      savedText: `${PARENT}/8 `,
      editorText: `${PARENT}/8 `,
    })
    expect(await childEditor(page), 'no-editor keyboard creation opened no item editor').toBeNull()
    expect(await storedText(noEditAck.savedId), 'no-editor keyboard creation stored no quote').toBe(`${PARENT}/8 `)

    await selected(page, PARENT)
    await waitItem(parent.id)
    expect(await selectAcross(parent.id, 'hello world', 'hello world')).toBe('hello world')
    expect(
      await page.evaluate(p => (window._create(p, { history: true }) as any)?.text, PARENT),
      'synthetic _create with history makes child without quoting'
    ).toBe(`${PARENT}/9 `)
    await selected(page, PARENT)
    await waitItem(parent.id)
    expect(await selectAcross(parent.id, 'hello world', 'hello world')).toBe('hello world')
    expect(
      await page.evaluate(p => (window._create(p) as any)?.text, PARENT),
      'synthetic _create quotes nothing'
    ).toBe(PARENT)

    // (g) a creation that runs the new item and opens its editor (Cmd/Ctrl+Enter in the box, no selection):
    // the editor shows the item's text WITH the run's output (the editor's text is derived from the item's
    // final text), nothing is unsaved, and a save without typing keeps the output
    const RUN = '#e2e_cn_run'
    await typed(page, `${RUN}\n\`\`\`js_input\n40 + 2\n\`\`\``)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect.poll(async () => (await childEditor(page))?.value ?? '', { message: "the new editor shows the run's output", timeout: 15_000 }).toMatch(/_output\n42\n/)
    const runAck = await waitAcked(RUN)
    expect(runAck, "the run's output is in the item, saved, with its editor open").toMatchObject({ editing: true, saving: false, savedText: runAck.text })
    expect(runAck.text).toMatch(/_output\n42\n/)
    expect((await childEditor(page))?.value, "the editor's text is the item's text").toBe(runAck.text)
    expect(await storedText(runAck.savedId), 'the first stored document has the output').toBe(runAck.text)
    expect(await beforeUnloadPrompt(), 'nothing unsaved after a creation with a run').toBe('')
    await page.keyboard.press('Shift+Enter') // save without typing
    await expect.poll(() => childEditor(page), { timeout: 10_000 }).toBeNull()
    await waitAcked(RUN)
    expect(await storedText(runAck.savedId), 'a save without typing keeps the output').toBe(runAck.text)
    // the same creation offline: the first write stays pending, and its snapshot (what a discard before the
    // acknowledgement restores) is the text WITH the output: Escape closes without a question and the output
    // stays, on the page and, once online, in the stored document
    const RUN2 = '#e2e_cn_run2'
    const pendingRun = () =>
      page.evaluate(label => {
        const it = (window.__items as any[]).find(i => i.labelText == label)
        return { text: it.text as string, savingText: (it.savingText ?? null) as string | null, saving: !!it.saving, editing: !!it.editing }
      }, RUN2)
    let pendingText = ''
    await page.context().setOffline(true)
    try {
      await typed(page, `${RUN2}\n\`\`\`js_input\n40 + 3\n\`\`\``)
      await page.keyboard.press('ControlOrMeta+Enter')
      await expect.poll(async () => (await childEditor(page))?.value ?? '', { message: "offline: the new editor shows the run's output", timeout: 15_000 }).toMatch(/_output\n43\n/)
      const pending = await pendingRun()
      pendingText = pending.text
      expect(pending, 'the pending first write: its snapshot is the text with the output').toEqual({ text: pendingText, savingText: pendingText, saving: true, editing: true })
      expect(pendingText).toMatch(/_output\n43\n/)
      await page.keyboard.press('Escape')
      await expect.poll(() => childEditor(page), { timeout: 10_000 }).toBeNull()
      expect(await page.locator('.modal').isVisible(), 'no question while the first write is pending').toBe(false)
      expect((await pendingRun()).text, 'the discard before the acknowledgement keeps the output').toBe(pendingText)
    } finally {
      await page.context().setOffline(false)
    }
    const run2Ack = await waitAcked(RUN2)
    expect(await storedText(run2Ack.savedId), 'once online, the stored document has the output').toBe(pendingText)

    // (h) the edit menu's Save follows the editor's draft, not the item's saved text: with an unlabelled
    // item's text cleared in its editor, after Close and Cancel at the discard question, a click on Save
    // does nothing (saving the empty draft would delete the item, an unlabelled one without a question):
    // the editor stays open and empty and the item keeps its text; with text typed the same button saves it
    const MENU = texts[5]
    const menuState = () =>
      page.evaluate(id => {
        const it = (window.__items as any[]).find(i => i.id == id)
        if (!it) return null
        const editor = document.getElementById(`textarea-${id}`) as HTMLTextAreaElement | null
        return { text: it.text as string, editing: !!it.editing, editor: editor?.value ?? null, saveable: !!editor?.closest('.container')?.classList.contains('saveable') }
      }, menu.id)
    await selected(page, `id:${menu.id}`)
    await waitItem(menu.id)
    await page.locator(`.column:not(.hidden) #item-${menu.id} p`).first().click()
    const menuEditor = page.locator(`#textarea-${menu.id}`)
    await expect(menuEditor).toBeVisible({ timeout: 10_000 })
    expect(await menuState(), 'premise: the open editor holds the saved text and Save is live').toEqual({ text: MENU, editing: true, editor: MENU, saveable: true })
    await menuEditor.fill('')
    const menuButtons = page.locator(`#super-container-${menu.id} .edit-menu`)
    await menuButtons.locator('.button.cancel').click()
    await expect(page.getByText('Discard unsaved changes to item?')).toBeVisible({ timeout: 10_000 })
    await page.locator('.modal .button.cancel').click()
    await expect(page.locator('.modal')).toBeHidden({ timeout: 10_000 })
    const EMPTIED = { text: MENU, editing: true, editor: '', saveable: false }
    expect(await menuState(), 'after Close and Cancel the emptied draft is kept and Save is not live').toEqual(EMPTIED)
    await menuButtons.locator('.button.save').click()
    expect(await menuState(), 'a click on Save changed nothing: the item is there, its editor open and empty').toEqual(EMPTIED)
    // (a blurred editor shows its backdrop in the textarea's place: a click on it is how its owner returns)
    await page.locator(`#super-container-${menu.id} .editor .backdrop`).click()
    await expect.poll(() => page.evaluate(id => document.activeElement?.id == `textarea-${id}`, menu.id), { message: 'the click on the editor focused it', timeout: 5_000 }).toBe(true)
    await page.keyboard.type('e2e_cn kept by the menu')
    await expect.poll(async () => (await menuState())?.editor, { timeout: 5_000 }).toBe('e2e_cn kept by the menu')
    await expect.poll(async () => (await menuState())?.saveable, { message: 'with text typed Save is live again', timeout: 10_000 }).toBe(true)
    await menuButtons.locator('.button.save').click()
    await expect.poll(async () => (await menuState())?.editing, { message: 'the same button saved the typed text', timeout: 10_000 }).toBe(false)
    await expect.poll(() => storedText(menu.saved), { timeout: 30_000 }).toBe('e2e_cn kept by the menu')

    // helper to select an element's full text inside `raw`
    const selectRawNode = async (selector: string, source: string, expected: string) => {
      await selected(page, RAW_PARENT)
      await waitItem(raw.id)
      const loc = page.locator(`.column:not(.hidden) #item-${raw.id} ${selector}`).first()
      await expect(loc, `${source} visible`).toBeVisible({ timeout: 10_000 })
      const selText = await page.evaluate(
        ([id, sel]) => {
          const el = document.querySelector(`.column:not(.hidden) #item-${id} ${sel}`)
          if (!el) return null
          ;(document.activeElement as HTMLElement | null)?.blur()
          const range = document.createRange()
          range.selectNodeContents(el)
          const s = window.getSelection()!
          s.removeAllRanges()
          s.addRange(range)
          return s.toString()
        },
        [raw.id, selector] as const
      )
      expect(selText, `premise: ${source} selection matches expected text verbatim`).toBe(expected)
    }

    // (g) verbatim save: ampersand (`R&D`), hash-tagged word, HTML tag and macro-like text are kept
    // character for character (no escaping/rewriting) and stored with the typed follow-up on save
    await selectRawNode('> .content .vault-result code', 'literal inert code span', LITERAL)
    await page.keyboard.press('Shift+Enter')
    const LIT_CHILD = quotedChild(RAW_PARENT, 0, LITERAL)
    await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(LIT_CHILD)
    const litAck = await waitAcked(`${RAW_PARENT}/0`)
    expect(await storedText(litAck.savedId), 'literal quote: first acknowledged document holds scaffold without quote').toBe(`${RAW_PARENT}/0 `)
    expect(await beforeUnloadPrompt(), 'literal quote: app reports unsaved changes').toBe('Discard unsaved changes?')
    await page.keyboard.type('notes')
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => childEditor(page), { timeout: 10_000 }).toBeNull()
    await expect.poll(() => storedText(litAck.savedId), { timeout: 30_000 }).toBe(LIT_CHILD.value + 'notes')
    await waitAcked(`${RAW_PARENT}/0`)

    // (h) a macro in the selection is NOT evaluated while the editor is open (it lives only in the
    // unsaved editor draft, not in item.text), and the item is NOT saved with the macro in it
    const verifyOpenMacroQuote = async (selector: string, childNum: number, source: string) => {
      const childLabel = `${RAW_PARENT}/${childNum}`
      await page.evaluate(() => {
        ;(window as any).__e2e_quote_macro = 0
      })
      await selectRawNode(selector, source, MACRO)
      await page.keyboard.press('Shift+Enter')
      const MACRO_CHILD = quotedChild(RAW_PARENT, childNum, MACRO)
      await expect.poll(() => childEditor(page), { timeout: 15_000 }).toEqual(MACRO_CHILD)
      const macroAck = await waitAcked(childLabel)
      expect(await storedText(macroAck.savedId), `${source}: first acknowledged document holds scaffold without macro`).toBe(`${childLabel} `)
      // wait for the background macro pass (expandMacros) while the new item's editor is still open
      await expect
        .poll(
          () =>
            page.evaluate(label => {
              const it = (window.__items as any[]).find(i => i.labelText == label)
              return (
                !!it?.editing &&
                !!it.expanded &&
                !it.expanded.error &&
                it.expanded.deephash === it.deephash &&
                it.expanded.version === it.version
              )
            }, childLabel),
          { message: `${source}: background macro pass expanded open editor`, timeout: 15_000 }
        )
        .toBe(true)
      expect(
        await page.evaluate(label => {
          const it = (window.__items as any[]).find(i => i.labelText == label)
          return { editing: !!it?.editing, macro: (window as any).__e2e_quote_macro }
        }, childLabel),
        `${source}: macro flag not set while new item's editor is still open`
      ).toEqual({ editing: true, macro: 0 })
      // leave without saving so the macro is never saved into the item
      await discardQuotedChild(childLabel, macroAck.savedId)
      expect(await page.evaluate(() => (window as any).__e2e_quote_macro), `${source}: macro flag stays 0 after discard`).toBe(0)
    }

    await verifyOpenMacroQuote('> .content > p > code', 1, 'code span')
    await verifyOpenMacroQuote('> .content .vault-result p:last-of-type', 2, 'inert region')
  } finally {
    await deleteNamed()
  }
})

async function deleteBoxAfterCreation() {
  const docs = await firestore().collection('items').where('user', '==', 'anonymous').get()
  for (const doc of docs.docs) if (/^\s*#?e2e_bc/.test(doc.data().text ?? '')) await doc.ref.delete()
}

const findBcItem = (page: Page, text: string) =>
  page.evaluate(t => {
    const it = ((window as any).__items as any[]).find(i => i.text === t)
    return it
      ? { id: it.id as string, savedId: (it.savedId ?? null) as string | null, target: !!it.target, editing: !!it.editing }
      : null
  }, text)

async function waitPendingBc(
  page: Page,
  text: string,
  expected: { editing?: boolean; target?: boolean } = { target: true },
  message = 'unnamed item created locally and selected'
): Promise<string> {
  let tabId = ''
  await expect
    .poll(
      async () => {
        const found = await findBcItem(page, text)
        if (found) tabId = found.id
        return found
      },
      { message, timeout: 10_000 }
    )
    .toMatchObject({ savedId: null, ...expected })
  expect(tabId, 'premise: tab id exists').toBeTruthy()
  return tabId
}

const waitNoBcSaves = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(() =>
          ((window as any).__items as any[]).every(
            it => it.savedId && !it.saving && !it.saveTask && !it.unackedWrites?.length
          )
        ),
      { message: 'all writes acknowledged and settled', timeout: 30_000 }
    )
    .toBe(true)

test('unnamed creation selects the new item by its tab id, upgrades the box to its saved id in place on save without moving focus, caret, or history, and survives reload', async ({ page }) => {
  await deleteBoxAfterCreation()
  await loadAdmin(page)
  const errors: string[] = []
  const consoleErrors: string[] = []
  // filter the known app-load localStorage SecurityError triggered on page reload (docs/mind_page_bridge_worker.md)
  page.on('pageerror', error => {
    if (!String(error).includes('localStorage')) errors.push(String(error))
  })
  page.on('console', msg => {
    if (msg.type() == 'error') consoleErrors.push(msg.text())
  })
  const PRIOR = '#e2e_bc_prior'
  const PLAIN = 'e2e_bc plain note'
  const NOEDIT = 'e2e_bc noedit note'
  const RESELECT = 'e2e_bc reselect note'
  const FAIL_VIEW = 'e2e_bc fail view note'
  const createdEmptyIds: string[] = []
  try {
    await page.evaluate(text => void window._create(text), `${PRIOR} prior target`)
    await saved(page, [PRIOR])
    await asUser(page, label => (window._item(label) as any).select(), PRIOR)
    await expect(mindbox(page)).toHaveValue(PRIOR)
    const [priorLen, priorIndex] = await entries(page)

    // go offline so the create write stays pending and we can observe the tab-id state directly
    await page.context().setOffline(true)
    await focusMindbox(page)
    await mindbox(page).fill(PLAIN)
    await page.keyboard.press('Shift+Enter')

    // before save: box holds id:<tabId>, item is selected, editor focused, one history entry pushed
    const tabId = await waitPendingBc(page, PLAIN, { target: true, editing: true })
    await expect(mindbox(page), 'before save: MindBox holds id:<tabId>').toHaveValue(`id:${tabId}`)
    expect(await page.evaluate(() => location.hash), 'before save: url hash holds #<tabId>').toBe(`#${tabId}`)
    const [createdLen, createdIndex] = await entries(page)
    expect([createdLen, createdIndex], 'creation pushed one entry after prior final view').toEqual([priorLen + 1, priorIndex + 1])
    expect(await page.evaluate(() => history.state?.editorText), 'before save: history entry holds id:<tabId>').toBe(`id:${tabId}`)

    const itemEditor = page.locator(`#textarea-${tabId}`)
    await expect(itemEditor, 'new item editor is focused').toBeFocused()
    await page.evaluate(id => (document.getElementById(`textarea-${id}`) as HTMLTextAreaElement).setSelectionRange(5, 5), tabId)

    // come back online so the create write confirms
    await page.context().setOffline(false)
    const [persistedId] = await saved(page, [tabId])
    expect(persistedId, 'saved id differs from tab id').not.toBe(tabId)

    // after save: box upgraded to id:<savedId>, item still selected, history updated in place, focus & caret untouched
    await expect(mindbox(page), 'after save: MindBox upgraded to id:<savedId>').toHaveValue(`id:${persistedId}`)
    expect(
      await page.evaluate(localId => {
        const it = ((window as any).__items as any[]).find(i => i.id === localId)
        return { target: !!it?.target, hash: location.hash, stateText: history.state?.editorText, index: history.state?.index }
      }, tabId),
      'after save: item stays target, hash and history.state updated in place'
    ).toEqual({ target: true, hash: `#${persistedId}`, stateText: `id:${persistedId}`, index: createdIndex })
    expect(await entries(page), 'after save: no history entry added').toEqual([createdLen, createdIndex])
    expect(
      await page.evaluate(localId => {
        const ta = document.getElementById(`textarea-${localId}`) as HTMLTextAreaElement
        return { activeId: document.activeElement?.id ?? null, start: ta.selectionStart, end: ta.selectionEnd }
      }, tabId),
      'after save: item editor kept focus and caret'
    ).toEqual({ activeId: `textarea-${tabId}`, start: 5, end: 5 })

    // close editor, verify Back/Forward, reload, and Back after reload
    await page.keyboard.press('Shift+Enter')
    await expect(itemEditor).toBeHidden()
    await waitNoBcSaves(page)
    await page.goBack()
    await expect(mindbox(page), 'Back returns to prior view in one step').toHaveValue(PRIOR)
    await page.goForward()
    await expect(mindbox(page), 'Forward returns to id:<savedId>').toHaveValue(`id:${persistedId}`)

    await page.reload()
    await waitForApp(page)
    await expect(mindbox(page), 'after reload: MindBox keeps id:<savedId>').toHaveValue(`id:${persistedId} `)
    await expect
      .poll(
        () =>
          page.evaluate(docId => {
            const it = ((window as any).__items as any[]).find(i => i.id === docId || i.savedId === docId)
            return it ? { text: it.text as string, target: !!it.target } : null
          }, persistedId),
        { message: 'after reload: persisted item is selected (target)', timeout: 15_000 }
      )
      .toEqual({ text: PLAIN, target: true })
    await page.goBack()
    await expect(mindbox(page), 'after reload: Back still reaches prior view in one step').toHaveValue(PRIOR)

    // non-editing creation (Control+Alt+S leaves focus in MindBox): MindBox keeps focus, mapped end, and backward
    // selection across save upgrade; clicking header Create without typing reads the visible id (naming dialog, no dup)
    await page.context().setOffline(true)
    await focusMindboxInPlace(page)
    await expect(mindbox(page)).toBeFocused()
    await mindbox(page).fill(NOEDIT)
    await page.keyboard.press('Control+Alt+s')
    const tabId2 = await waitPendingBc(page, NOEDIT, { editing: false, target: true }, 'non-editing unnamed item created locally')
    await expect(mindbox(page), 'non-editing before save: MindBox holds id:<tabId2>').toHaveValue(`id:${tabId2}`)
    await expect(mindbox(page), 'non-editing before save: MindBox kept focus').toBeFocused()
    await page.evaluate(() => {
      const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      box.setSelectionRange(3, box.value.length, 'backward')
    })
    await page.context().setOffline(false)
    const [savedId2] = await saved(page, [tabId2])
    expect(savedId2.length, 'premise: saved id length differs from tab id length').not.toBe(tabId2.length)
    await expect(mindbox(page), 'non-editing after save: MindBox upgraded to id:<savedId2>').toHaveValue(`id:${savedId2}`)
    await settled(page)
    expect(
      await page.evaluate(() => {
        const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
        return { activeId: document.activeElement?.id ?? null, start: box.selectionStart, end: box.selectionEnd, dir: box.selectionDirection }
      }),
      'non-editing after save: MindBox kept focus, mapped end, and backward selection direction'
    ).toEqual({ activeId: 'textarea-mindbox', start: 3, end: `id:${savedId2}`.length, dir: 'backward' })

    await page.locator('.header .button.create').click()
    await expect.poll(() => dialog(page), { message: 'create button on visible id opens naming dialog', timeout: 5_000 }).toEqual([NAME_PROMPT])
    expect(await nameInput(page), 'naming dialog offers a name').toBeTruthy()
    expect(
      await page.evaluate(text => ((window as any).__items as any[]).filter(i => i.text === text).length, NOEDIT),
      'create button did not duplicate the note'
    ).toBe(1)
    await page.locator('.modal .button.cancel', { hasText: 'Cancel' }).click()
    await expect(page.locator('.modal')).toBeHidden()
    await expect(mindbox(page), 'cancelling naming dialog keeps id:<savedId2>').toHaveValue(`id:${savedId2}`)

    // leave and reselect while offline: create A -> select B -> Shift+click A's number -> reconnect;
    // the later current entry gets the saved id while the creation's own earlier entry keeps the tab id
    await page.context().setOffline(true)
    await focusMindboxInPlace(page)
    await mindbox(page).fill(RESELECT)
    await page.keyboard.press('Control+Alt+s')
    const tabIdA = await waitPendingBc(page, RESELECT, { editing: false, target: true }, 'reselect item created locally')
    await expect(mindbox(page)).toHaveValue(`id:${tabIdA}`)
    const [, idxA] = await entries(page)

    await asUser(page, label => (window._item(label) as any).select(), PRIOR)
    await expect(mindbox(page)).toHaveValue(PRIOR)
    const [, idxB] = await entries(page)
    expect(idxB, 'selecting B pushed an entry after A').toBe(idxA + 1)

    const numberA = page.locator(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${tabIdA}"] .item-menu > .index`)
    if (!(await numberA.count())) await page.locator('.toggle.show').first().click()
    await expect(numberA).toBeVisible()
    await numberA.click({ modifiers: ['Shift'] })
    await expect(mindbox(page), 'Shift+click selects pending A by its tab id').toHaveValue(`id:${tabIdA}`)
    const [lenReselect, idxReselect] = await entries(page)
    expect(idxReselect, 'Shift+click pushed a fresh history entry').toBe(idxB + 1)

    await page.context().setOffline(false)
    const [savedIdA] = await saved(page, [tabIdA])
    await expect(mindbox(page), 'reselected entry after save: MindBox upgraded to id:<savedIdA>').toHaveValue(`id:${savedIdA}`)
    expect(
      await page.evaluate(() => ({ hash: location.hash, stateText: history.state?.editorText, index: history.state?.index })),
      'reselected entry updated in place with saved id'
    ).toEqual({ hash: `#${savedIdA}`, stateText: `id:${savedIdA}`, index: idxReselect })
    expect(await entries(page), 'reselected entry upgrade added no history step').toEqual([lenReselect, idxReselect])
    await page.goBack()
    await expect(mindbox(page), 'first Back from reselected A returns to B').toHaveValue(PRIOR)
    await page.goBack()
    await expect(mindbox(page), 'second Back reaches creation entry, which kept the tab id').toHaveValue(`id:${tabIdA}`)
    expect(
      await page.evaluate(() => ({ hash: location.hash, stateText: history.state?.editorText, index: history.state?.index })),
      'creation entry still holds id:<tabIdA>'
    ).toEqual({ hash: `#${tabIdA}`, stateText: `id:${tabIdA}`, index: idxA })

    // view-update failure at acknowledgement must not skip save bookkeeping or creation history, and must report the error
    const INJECTED_ERR = 'e2e_bc injected replaceState failure'
    await page.context().setOffline(true)
    await focusMindboxInPlace(page)
    await mindbox(page).fill(FAIL_VIEW)
    await page.keyboard.press('Control+Alt+s')
    const failTabId = await waitPendingBc(page, FAIL_VIEW, { editing: false, target: true }, 'fail-view item created locally')
    await expect(mindbox(page)).toHaveValue(`id:${failTabId}`)
    await page.evaluate(
      ([tab, msg]) => {
        const orig = history.replaceState.bind(history)
        let tripped = false
        history.replaceState = (...args: Parameters<History['replaceState']>) => {
          const text = (args[0] as any)?.editorText
          if (!tripped && typeof text === 'string' && text.startsWith('id:') && text !== `id:${tab}`) {
            tripped = true
            history.replaceState = orig
            throw new Error(msg)
          }
          return orig(...args)
        }
        ;(window as any).__bc_restore_replace = () => {
          history.replaceState = orig
        }
      },
      [failTabId, INJECTED_ERR] as const
    )
    consoleErrors.length = 0
    await page.context().setOffline(false)
    const [failSavedId] = await saved(page, [failTabId])
    await expect
      .poll(
        () =>
          page.evaluate(localId => {
            const it = ((window as any).__items as any[]).find(i => i.id === localId)
            return it
              ? { savedId: (it.savedId ?? null) as string | null, saving: !!it.saving, savingText: it.savingText ?? null, savedText: it.savedText ?? '' }
              : null
          }, failTabId),
        { message: 'item ends saved and not saving despite view-update error', timeout: 10_000 }
      )
      .toEqual({ savedId: failSavedId, saving: false, savingText: null, savedText: FAIL_VIEW })
    await expect
      .poll(
        async () => (await firestore().collection('history').where('item', '==', failSavedId).get()).docs.map(d => d.data().text),
        { message: 'creation history recorded despite view-update error', timeout: 10_000 }
      )
      .toContain(FAIL_VIEW)
    expect(
      consoleErrors.some(msg => msg.includes(INJECTED_ERR)),
      'view-update error was reported via console.error'
    ).toBe(true)

    // empty-box (and tag-query) Shift+Enter frame stability across top, scrolled, and unfocused starts,
    // plus in-place id upgrade (listeners, inert toggles, and guard fallbacks) through save ack
    const waitQueryReady = async () => {
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const w = window as any
              return !w._editor_change_pending && !w._mindboxDebounced && !w.__layoutPending
            }),
          { message: 'query debounce and layout settled', timeout: 10_000 }
        )
        .toBe(true)
      await expect(page.locator('#sapper > .loading')).not.toHaveClass(/visible/, { timeout: 15_000 })
      await settled(page)
    }

    const waitResizeLayout = async (minLayoutCount: number) => {
      await expect
        .poll(
          () =>
            page.evaluate(min => {
              const w = window as any
              return !w.__layoutPending && (w.__layoutCount as number) >= min
            }, minLayoutCount),
          { message: 'resize layout pass completed', timeout: 10_000 }
        )
        .toBe(true)
      await settled(page)
    }

    const expandQueryList = async (minVisible: number, boxText: string) => {
      await focusMindboxInPlace(page)
      await mindbox(page).fill(boxText)
      await waitQueryReady()
      for (let i = 0; i < 8; i++) {
        const before = await page.evaluate(() => (window as any).__hideIndex as number)
        if (before >= minVisible) break
        const toggle = page.locator('.column:not(.hidden) .toggle.show').first()
        if ((await toggle.count()) === 0) break
        await toggle.click()
        await expect.poll(() => page.evaluate(() => (window as any).__hideIndex as number), { timeout: 5_000 }).toBeGreaterThan(before)
      }
      await waitQueryReady()
    }

    // delete a saved test item on the server and wait until the browser's snapshot listener has
    // removed it locally (keeps Firestore's client write queue empty across offline transitions so
    // an unacked client deleteDoc cannot be retried on reconnect and trigger a rollback snapshot)
    const removeSavedItem = async (id: string) => {
      await waitNoBcSaves(page)
      await firestore().collection('items').doc(id).delete()
      await expect.poll(() => page.evaluate(docId => window._item('id:' + docId, true), id), { timeout: 10_000 }).toBeNull()
      await waitQueryReady()
    }

    const measureShiftEnter = async (opts: {
      boxText?: string
      expandTo: number
      scrollOffset: number
      fromWindow?: boolean
      holdOffline?: boolean
      expandBeforeAck?: boolean
      checkListeners?: boolean
      scrollAfterFocus?: boolean
    }) => {
      const boxText = opts.boxText ?? ''
      if (opts.expandTo > 0) await expandQueryList(opts.expandTo, boxText)
      else {
        await focusMindboxInPlace(page)
        await mindbox(page).fill(boxText)
        await waitQueryReady()
        // collapse any session-created items so hideIndex starts at pinnedCount (matching a fresh load)
        for (let i = 0; i < 4; i++) {
          const { hide, pinned } = await page.evaluate(() => {
            const w = window as any
            return { hide: w.__hideIndex as number, pinned: (w.__items as any[]).filter(it => it.pinned).length }
          })
          if (hide <= pinned) break
          const hideToggle = page.locator('.column:not(.hidden) .toggle.hide').first()
          if ((await hideToggle.count()) === 0) break
          await hideToggle.click()
          await expect.poll(() => page.evaluate(() => (window as any).__hideIndex as number), { timeout: 5_000 }).toBeLessThan(hide)
        }
        await waitQueryReady()
      }
      const { hideBefore, pinnedCount } = await page.evaluate(() => {
        const w = window as any
        return { hideBefore: w.__hideIndex as number, pinnedCount: (w.__items as any[]).filter(it => it.pinned).length }
      })
      if (opts.fromWindow) {
        await blur(page)
      } else {
        await focusMindboxInPlace(page)
        await expect(mindbox(page)).toBeFocused()
      }
      const hdrTop = await headerTop(page)
      const maxScroll = await page.evaluate(() => document.body.scrollHeight - document.body.clientHeight)
      const preY = Math.min(hdrTop + opts.scrollOffset, maxScroll)
      await page.evaluate(y => document.body.scrollTo(0, y), preY)
      await settled(page)
      await noWritePending(page)
      await expect.poll(() => page.evaluate(() => !(window as any).__layoutPending), { timeout: 10_000 }).toBe(true)

      if (opts.holdOffline) {
        await page.context().setOffline(true)
      }

      // install per-frame recorder plus focus/scrollTo wrappers before the new item mounts
      await page.evaluate(scrollAfterFocus => {
        const w = window as any
        const origFocus = HTMLElement.prototype.focus
        const origScrollTo = Element.prototype.scrollTo
        const rec = {
          active: true,
          rafId: 0,
          existingIds: new Set((w.__items as any[]).map(i => i.id)),
          frames: [] as any[],
          focusCalls: [] as { id: string; delta: number }[],
          scrollToCalls: [] as { before: number; after: number }[],
          mindboxFocused: false,
          ignoreFocus: false,
          userScrolledAfterFocus: false,
          restore() {
            this.active = false
            cancelAnimationFrame(this.rafId)
            HTMLElement.prototype.focus = origFocus
            Element.prototype.scrollTo = origScrollTo
          },
        }
        HTMLElement.prototype.focus = function (...args: any[]) {
          const before = document.body.scrollTop
          const res = origFocus.apply(this, args as any)
          const after = document.body.scrollTop
          if (rec.active && !rec.ignoreFocus) {
            if (this.id === 'textarea-mindbox') rec.mindboxFocused = true
            else if (this.id?.startsWith('textarea-')) {
              const itemId = this.id.slice('textarea-'.length)
              if (!rec.existingIds.has(itemId)) {
                rec.focusCalls.push({ id: this.id, delta: Math.round(after - before) })
                if (scrollAfterFocus && !rec.userScrolledAfterFocus) {
                  rec.userScrolledAfterFocus = true
                  // scroll on the next animation frame (after tick(), before update_dom()'s 2nd rAF)
                  requestAnimationFrame(() => {
                    const hdr = (document.querySelector('.header') as HTMLElement).offsetTop
                    origScrollTo.call(document.body, 0, hdr)
                  })
                }
              }
            }
          }
          return res
        }
        Element.prototype.scrollTo = function (...args: any[]) {
          const before = this === document.body ? document.body.scrollTop : 0
          const res = origScrollTo.apply(this, args as any)
          if (rec.active && this === document.body) {
            rec.scrollToCalls.push({ before: Math.round(before), after: Math.round(document.body.scrollTop) })
          }
          return res
        }
        const sample = () => {
          if (!rec.active) return
          const newIt = (w.__items as any[]).find(i => !rec.existingIds.has(i.id)) || null
          const sc = newIt ? document.querySelector(`.column:not(.hidden) #super-container-${newIt.id}`) : null
          const ta = newIt ? (document.getElementById(`textarea-${newIt.id}`) as HTMLTextAreaElement | null) : null
          const active = document.activeElement as HTMLTextAreaElement | null
          rec.frames.push({
            scrollTop: Math.round(document.body.scrollTop),
            headerTop: Math.round((document.querySelector('.header') as HTMLElement).offsetTop),
            boxText: (document.getElementById('textarea-mindbox') as HTMLTextAreaElement | null)?.value ?? '',
            activeId: active?.id ?? null,
            caret: active?.tagName === 'TEXTAREA' ? [active.selectionStart, active.selectionEnd] : null,
            itemTop: sc ? Math.round(sc.getBoundingClientRect().top) : null,
            edTop: ta ? Math.round(ta.getBoundingClientRect().top) : null,
            hideIndex: w.__hideIndex as number,
          })
          rec.rafId = requestAnimationFrame(sample)
        }
        rec.rafId = requestAnimationFrame(sample)
        w.__se1_rec = rec
      }, !!opts.scrollAfterFocus)

      const layoutBefore = await page.evaluate(clearListeners => {
        const w = window as any
        if (clearListeners) {
          w.__se3_changes = []
          w.__se3_searches = []
          w.__se3_applied = []
        }
        return w.__layoutCount as number
      }, !!opts.checkListeners)

      await page.keyboard.press('Shift+Enter')

      let tabId = ''
      await expect
        .poll(
          async () => {
            const id = await page.evaluate(() => {
              const rec = (window as any).__se1_rec
              return ((window as any).__items as any[]).find(i => !rec.existingIds.has(i.id))?.id ?? null
            })
            if (id) tabId = id
            return id
          },
          { message: 'empty-box Shift+Enter created new item', timeout: 10_000 }
        )
        .toBeTruthy()
      await expect(page.locator(`#textarea-${tabId}`), 'new empty item editor is focused').toBeFocused()

      let preAck: { scrollTop: number; itemTop: number; hideIndex: number; hideBeforeExpand: number } | null = null
      let postAck: {
        scrollTop: number
        itemTop: number
        hideIndex: number
        activeId: string | null
        caret: [number, number] | null
        val: string
      } | null = null

      if (opts.holdOffline) {
        // witness the creation's own resize layout pass while still offline on id:<tabId>
        await waitResizeLayout(layoutBefore + 2)
        await expect(mindbox(page), 'offline empty creation holds id:<tabId>').toHaveValue(`id:${tabId}`)
        if (opts.checkListeners) {
          await expect
            .poll(
              () =>
                page.evaluate(() => ({
                  changes: (window as any).__se3_changes ?? [],
                  searches: (window as any).__se3_searches ?? [],
                })),
              { message: 'offline creation delivers tab id query to _on_change and _on_search listeners', timeout: 5_000 }
            )
            .toEqual({ changes: [`id:${tabId}`], searches: [`id:${tabId}`] })
        }
        await page.keyboard.type('abc')
        await page.evaluate(id => {
          const ta = document.getElementById(`textarea-${id}`) as HTMLTextAreaElement
          ta.setSelectionRange(2, 2)
        }, tabId)
        const hideBeforeExpand = await page.evaluate(() => (window as any).__hideIndex as number)
        if (opts.expandBeforeAck) {
          const showToggle = page.locator('.column:not(.hidden) .toggle.show').first()
          await expect(showToggle, 'offline creation exposes a .toggle.show control to expand').toBeVisible({ timeout: 5_000 })
          await page.evaluate(() => {
            ;(document.querySelector('.column:not(.hidden) .toggle.show') as HTMLElement).click()
          })
          await expect
            .poll(() => page.evaluate(() => (window as any).__hideIndex as number), {
              message: 'clicking .toggle.show strictly increases hideIndex before reconnect',
              timeout: 5_000,
            })
            .toBeGreaterThan(hideBeforeExpand)
          await waitQueryReady()
          await page.evaluate(id => {
            const rec = (window as any).__se1_rec
            const ta = document.getElementById(`textarea-${id}`) as HTMLTextAreaElement
            rec.ignoreFocus = true
            try {
              ta.focus({ preventScroll: true })
              ta.setSelectionRange(2, 2)
            } finally {
              rec.ignoreFocus = false
            }
          }, tabId)
        }
        preAck = await page.evaluate(
          ([id, beforeExpand]) => {
            const w = window as any
            const sc = document.querySelector(`.column:not(.hidden) #super-container-${id}`)!
            return {
              scrollTop: Math.round(document.body.scrollTop),
              itemTop: Math.round(sc.getBoundingClientRect().top),
              hideIndex: w.__hideIndex as number,
              hideBeforeExpand: beforeExpand,
            }
          },
          [tabId, hideBeforeExpand] as const
        )
        await page.context().setOffline(false)
      }

      const [savedDocId] = await saved(page, [tabId])
      createdEmptyIds.push(savedDocId)
      if (boxText === '') {
        await expect(mindbox(page), 'empty-box creation upgrades to id:<savedId>').toHaveValue(`id:${savedDocId}`)
      } else {
        await expect(mindbox(page), 'tag-query creation keeps tag in box').toHaveValue(boxText)
      }
      if (opts.holdOffline) {
        if (opts.checkListeners) {
          await expect
            .poll(() => page.evaluate(() => (window as any).__se3_changes ?? []), {
              message: 'save ack delivers saved id query once to _on_change listeners',
              timeout: 5_000,
            })
            .toEqual([`id:${tabId}`, `id:${savedDocId}`])
          await expect
            .poll(() => page.evaluate(() => (window as any).__se3_searches ?? []), {
              message: 'save ack delivers saved id query once to _on_search listeners',
              timeout: 5_000,
            })
            .toEqual([`id:${tabId}`, `id:${savedDocId}`])
          // the applied query that item code reads while a later draft is debounced (window._mindboxApplied),
          // as it stands AT each search hook: the in-place upgrade sets it too, in the id's exact case
          expect(
            await page.evaluate(() => (window as any).__se3_applied ?? []),
            'save ack sets the applied query (window._mindboxApplied) to the exact saved id by its search hook'
          ).toEqual([`id:${tabId}`, `id:${savedDocId}`])
        }
        await expect.poll(() => page.evaluate(() => !(window as any).__layoutPending), { timeout: 10_000 }).toBe(true)
        await settled(page)
        if (opts.checkListeners) {
          expect(
            await page.evaluate(() => ({
              changes: (window as any).__se3_changes ?? [],
              searches: (window as any).__se3_searches ?? [],
            })),
            'save ack notifies _on_change and _on_search exactly once each'
          ).toEqual({ changes: [`id:${tabId}`, `id:${savedDocId}`], searches: [`id:${tabId}`, `id:${savedDocId}`] })
        }
        postAck = await page.evaluate(id => {
          const w = window as any
          const sc = document.querySelector(`.column:not(.hidden) #super-container-${id}`)!
          const ta = document.getElementById(`textarea-${id}`) as HTMLTextAreaElement
          const active = document.activeElement as HTMLTextAreaElement | null
          return {
            scrollTop: Math.round(document.body.scrollTop),
            itemTop: Math.round(sc.getBoundingClientRect().top),
            hideIndex: w.__hideIndex as number,
            activeId: active?.id ?? null,
            caret: active?.tagName === 'TEXTAREA' ? ([active.selectionStart, active.selectionEnd] as [number, number]) : null,
            val: ta.value,
          }
        }, tabId)
      } else {
        // witness the creation's resize layout pass (and any ack layout if mutated)
        await waitResizeLayout(layoutBefore + 2)
      }

      const result = await page.evaluate(id => {
        const rec = (window as any).__se1_rec
        rec.restore()
        delete (window as any).__se1_rec
        const sc = document.querySelector(`.column:not(.hidden) #super-container-${id}`) as HTMLElement | null
        return {
          frames: rec.frames as any[],
          focusCalls: rec.focusCalls as { id: string; delta: number }[],
          scrollToCalls: rec.scrollToCalls as { before: number; after: number }[],
          mindboxFocused: rec.mindboxFocused as boolean,
          viewportHeight: visualViewport!.height,
          newItemOffsetTop: sc ? Math.round(sc.offsetTop) : -1,
        }
      }, tabId)

      // collapse consecutive equal scrollTops (within 2px) starting from preY
      const visitedScrolls: number[] = [preY]
      for (const f of result.frames) {
        if (Math.abs(f.scrollTop - visitedScrolls[visitedScrolls.length - 1]) > 2) visitedScrolls.push(f.scrollTop)
      }
      const distinctItemTops: number[] = []
      for (const f of result.frames) {
        if (f.itemTop != null && (distinctItemTops.length === 0 || Math.abs(f.itemTop - distinctItemTops[distinctItemTops.length - 1]) > 2)) {
          distinctItemTops.push(f.itemTop)
        }
      }
      const firstItemTop = result.frames.find(f => f.itemTop != null)?.itemTop as number | undefined
      const firstEdTop = result.frames.find(f => f.edTop != null)?.edTop as number | undefined
      await removeSavedItem(savedDocId)

      return {
        ...result,
        hideBefore,
        pinnedCount,
        preY,
        headerTop: hdrTop,
        tabId,
        savedDocId,
        visitedScrolls,
        distinctItemTops,
        firstItemTop,
        firstEdTop,
        preAck,
        postAck,
      }
    }

    // (1) unexpanded page at top, offline -> online: exercises edOffsetTop band scroll,
    // preventScroll focus, item.lastVisible + lastFocusedEditElement across tryLayout,
    // real #_listen _on_change/_on_search delivery across save ack, and in-place ack upgrade
    const listenText = [
      '#e2e_se3_listener #_listen',
      '```js',
      'function _on_change(text) { (window.__se3_changes ??= []).push(text) }',
      'function _on_search(text) { (window.__se3_searches ??= []).push(text); (window.__se3_applied ??= []).push(window._mindboxApplied) }',
      '```',
    ].join('\n')
    const listenTabId = await page.evaluate(text => (window._create(text) as any).id as string, listenText)
    const [listenSavedId] = await saved(page, [listenTabId])
    createdEmptyIds.push(listenSavedId)
    const unexpTop = await measureShiftEnter({ expandTo: 0, scrollOffset: 0, holdOffline: true, expandBeforeAck: true, checkListeners: true })
    await removeSavedItem(listenSavedId)
    expect(unexpTop.hideBefore, 'unexpanded start collapses unpinned items so new item sits at old hideIndex').toBe(unexpTop.pinnedCount)
    expect(unexpTop.focusCalls[0]?.delta, 'empty-box Shift+Enter focus must not trigger browser-native scroll').toBe(0)
    expect(unexpTop.visitedScrolls.length, 'unexpanded top: at most one scroll').toBeLessThanOrEqual(2)
    expect(new Set(unexpTop.visitedScrolls).size, 'unexpanded top: no scroll position visited and left again').toBe(unexpTop.visitedScrolls.length)
    expect(unexpTop.visitedScrolls.every(y => y >= unexpTop.headerTop - 2), 'unexpanded top: never scrolls above header').toBe(true)
    expect(unexpTop.firstItemTop, 'empty-box creation brings new editor into comfortable view band').toBeGreaterThanOrEqual(0)
    expect(unexpTop.firstEdTop, 'empty-box creation brings new editor into comfortable view band').toBeLessThanOrEqual(unexpTop.viewportHeight - 200)
    expect(unexpTop.distinctItemTops.length, 'unexpanded top: new item stays at one screen position').toBe(1)
    expect(unexpTop.focusCalls.length, 'no redundant refocus on first resize layout (unexpanded)').toBe(1)
    expect(unexpTop.preAck!.hideIndex, 'pre-ack hideIndex strictly increased after clicking .toggle.show').toBeGreaterThan(unexpTop.preAck!.hideBeforeExpand)
    expect(unexpTop.postAck, 'save ack id upgrade keeps manually expanded items open without re-ranking, moving page, or losing caret').toEqual({
      scrollTop: unexpTop.preAck!.scrollTop,
      itemTop: unexpTop.preAck!.itemTop,
      hideIndex: unexpTop.preAck!.hideIndex,
      activeId: `textarea-${unexpTop.tabId}`,
      caret: [2, 2],
      val: 'abc',
    })

    // (2) expanded 60+ items, scrolled +500px with MindBox focused (where itemTop=498, edTop=527 used to jump +360px at ack)
    const exp500 = await measureShiftEnter({ expandTo: 60, scrollOffset: 500 })
    expect(exp500.visitedScrolls.length, 'expanded scrolled +500: at most one scroll').toBeLessThanOrEqual(2)
    expect(new Set(exp500.visitedScrolls).size, 'expanded scrolled +500: no scroll position visited and left again').toBe(exp500.visitedScrolls.length)
    expect(exp500.distinctItemTops.length, 'expanded scrolled +500: new item does not jump after first paint').toBe(1)
    expect(exp500.focusCalls.length, 'no redundant refocus on first resize layout (expanded)').toBe(1)

    // (3) expanded non-unique tag list (#features ), scrolled past the new item (+1500px) with MindBox focused:
    // making #features non-unique prevents child creation and target-collapse, so the list stays tall and
    // scrollTop stays past sc.offsetTop until creation scrolls up to unclip the new item
    const dupTabId = await page.evaluate(() => (window._create('#features e2e_sc_dup') as any).id as string)
    const [dupFeaturesId] = await saved(page, [dupTabId])
    createdEmptyIds.push(dupFeaturesId)
    const expPast = await measureShiftEnter({ boxText: '#features ', expandTo: 18, scrollOffset: 1500 })
    await removeSavedItem(dupFeaturesId)
    expect(expPast.preY, 'scrolled-past premise: started scrolled past new item').toBeGreaterThan(expPast.newItemOffsetTop)
    expect(expPast.visitedScrolls.length, 'scrolled-past creation: at most one scroll').toBeLessThanOrEqual(2)
    expect(new Set(expPast.visitedScrolls).size, 'scrolled-past creation: no position visited and left again').toBe(expPast.visitedScrolls.length)
    expect(expPast.visitedScrolls.every(y => y >= expPast.headerTop - 2), 'scrolled-past creation: never scrolls above header').toBe(true)
    expect(expPast.firstItemTop, 'scrolled-past creation keeps new item unclipped in view').toBeGreaterThanOrEqual(0)

    // (4) expanded 60+ items, scrolled +500px with MindBox blurred (window.onKeyDown): must not visit header or focus MindBox
    const expWin = await measureShiftEnter({ expandTo: 60, scrollOffset: 500, fromWindow: true })
    expect(expWin.mindboxFocused, 'unfocused scrolled Shift+Enter does not visit header or focus MindBox before new editor').toBe(false)
    expect(expWin.scrollToCalls.length, 'unfocused scrolled Shift+Enter does not visit header or focus MindBox before new editor').toBeLessThanOrEqual(1)
    expect(expWin.visitedScrolls.length, 'unfocused scrolled Shift+Enter: at most one scroll').toBeLessThanOrEqual(2)
    expect(new Set(expWin.visitedScrolls).size, 'unfocused scrolled Shift+Enter: no position visited and left again').toBe(expWin.visitedScrolls.length)

    // (4b) same unfocused scrolled Shift+Enter with a command that opens no editor (/_green_screen):
    // must still scroll up to the header and focus MindBox, matching base behavior
    await expandQueryList(60, '/_green_screen')
    const greenBefore = await page.evaluate(() => !!(window as any)._green_screen)
    await blur(page)
    const cmdHdrTop = await headerTop(page)
    const cmdMaxScroll = await page.evaluate(() => document.body.scrollHeight - document.body.clientHeight)
    const cmdPreY = Math.min(cmdHdrTop + 500, cmdMaxScroll)
    expect(cmdPreY, 'command fallback premise: page scrolled well below header').toBeGreaterThan(cmdHdrTop + 200)
    await page.evaluate(y => document.body.scrollTo(0, y), cmdPreY)
    await settled(page)
    await noWritePending(page)
    await page.keyboard.press('Shift+Enter')
    await settled(page)
    expect(await page.evaluate(() => !!(window as any)._green_screen), '/_green_screen command ran').toBe(!greenBefore)
    const cmdAfter = await page.evaluate(() => ({
      scrollTop: Math.round(document.body.scrollTop),
      activeId: document.activeElement?.id ?? null,
    }))
    expect(
      { atHeader: Math.abs(cmdAfter.scrollTop - cmdHdrTop) <= 2, activeId: cmdAfter.activeId },
      'unfocused scrolled Shift+Enter with a command that opens no editor visits header and focuses MindBox'
    ).toEqual({ atHeader: true, activeId: 'textarea-mindbox' })
    // restore green_screen toggle so later cases see clean state
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => page.evaluate(() => !!(window as any)._green_screen)).toBe(greenBefore)

    // (5) stale creation layout scroll must not yank a scroll made right after editor focus (between tick() and update_dom())
    const noYank = await measureShiftEnter({ expandTo: 60, scrollOffset: 0, scrollAfterFocus: true })
    expect(
      Math.abs(noYank.frames[noYank.frames.length - 1].scrollTop - noYank.headerTop),
      'stale creation layout scroll must not yank a scroll made right after editor focus'
    ).toBeLessThanOrEqual(2)

    // (6) inert section toggle opened after save ack survives a same-query remote re-rank, then
    // closes when the user moves to a genuinely different query
    const INERT_LABEL = '#e2e_se3_inert'
    const REMOTE_LABEL = '#e2e_se3_remote'
    const inertHolderTab = await page.evaluate(
      text => (window._create(text) as any).id as string,
      `${INERT_LABEL} #_pin inert holder\n<!--inert-->\nagent\n- working: inert check\n    - [x] step one\n    - [ ] step two\n<!--/inert-->\ntail line`
    )
    const remoteTab = await page.evaluate(text => (window._create(text) as any).id as string, `${REMOTE_LABEL} remote initial`)
    const [inertHolderSavedId, remoteSavedId] = await saved(page, [inertHolderTab, remoteTab])
    createdEmptyIds.push(inertHolderSavedId, remoteSavedId)
    await waitQueryReady()
    await page.context().setOffline(true)
    await focusMindboxInPlace(page)
    await mindbox(page).fill('')
    await waitQueryReady()
    await page.keyboard.press('Shift+Enter')
    let inertTabId = ''
    await expect
      .poll(
        async () => {
          const it = await page.evaluate(() => ((window as any).__items as any[]).find(i => i.savedId == null && i.editing))
          if (it) inertTabId = it.id
          return it ? { id: it.id, target: !!it.target } : null
        },
        { message: 'offline empty item created for inert-section check', timeout: 10_000 }
      )
      .toMatchObject({ target: true })
    await expect(mindbox(page)).toHaveValue(`id:${inertTabId}`)
    await page.context().setOffline(false)
    const [inertSavedId] = await saved(page, [inertTabId])
    createdEmptyIds.push(inertSavedId)
    await expect(mindbox(page)).toHaveValue(`id:${inertSavedId}`)
    await settled(page)
    const inertState = () =>
      page.evaluate(label => {
        const it = window._item(label, true)
        const block = it
          ? document.querySelector(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${it.id}"] .inert-block`)
          : null
        if (!block) return null
        return {
          opened: block.classList.contains('opened'),
          says: block.querySelector(':scope > .inert-line > .inert-toggle')?.getAttribute('aria-expanded') ?? null,
        }
      }, INERT_LABEL)
    await expect.poll(inertState, { message: 'inert section on pinned item starts closed after save ack', timeout: 5_000 }).toEqual({
      opened: false,
      says: 'false',
    })
    const inertHolderLocalId = await page.evaluate(label => window._item(label, true)!.id as string, INERT_LABEL)
    await page
      .locator(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${inertHolderLocalId}"] .inert-block > .inert-line`)
      .first()
      .click({ position: { x: 5, y: 8 } })
    await expect.poll(inertState, { message: 'clicking inert section head after save ack opens it', timeout: 5_000 }).toEqual({
      opened: true,
      says: 'true',
    })
    const layoutBeforeRemote = await page.evaluate(() => (window as any).__layoutCount as number)
    await firestore()
      .collection('items')
      .doc(remoteSavedId)
      .update({ text: `${REMOTE_LABEL} remote updated`, time: Date.now() })
    await expect
      .poll(
        async () => {
          const text = await itemText(page, REMOTE_LABEL)
          const done = await page.evaluate(
            min => !(window as any).__layoutPending && ((window as any).__layoutCount as number) > min,
            layoutBeforeRemote
          )
          return text === `${REMOTE_LABEL} remote updated` && done
        },
        { message: 'remote edit arrived and re-ranked the saved query', timeout: 15_000 }
      )
      .toBe(true)
    await settled(page)
    expect(await inertState(), 'same-query re-rank after save ack keeps inert section opened after ack').toEqual({
      opened: true,
      says: 'true',
    })
    await asUser(page, () => void (window as any).MindBox.set('e2e_se3_different_query'))
    await waitQueryReady()
    expect(await inertState(), 'a genuinely different query after save ack still closes the inert section').toEqual({
      opened: false,
      says: 'false',
    })
    for (const id of [inertSavedId, inertHolderSavedId, remoteSavedId]) await removeSavedItem(id)

    // synchronously dispatch one or more MindBox input events while holding only the 500ms
    // editorChangeTimer they schedule (unwrapping window.setTimeout before returning so no
    // background/Firestore timer is ever caught or delayed)
    const fillHoldingDebounce = async (values: string[]) => {
      const heldCount = await page.evaluate(vals => {
        const w = window as any
        const origSetTimeout = window.setTimeout.bind(window)
        const heldIds: number[] = []
        w.__se1_restore_timer = () => {
          window.setTimeout = origSetTimeout
          for (const id of heldIds) clearTimeout(id)
          heldIds.length = 0
          delete w.__se1_restore_timer
        }
        window.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => {
          if (ms === 500) {
            const id = origSetTimeout(fn, 60_000, ...rest)
            heldIds.push(id)
            return id
          }
          return origSetTimeout(fn, ms, ...rest)
        }) as any
        try {
          const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
          for (const val of vals) {
            box.value = val
            box.dispatchEvent(new Event('input', { bubbles: true }))
          }
        } finally {
          window.setTimeout = origSetTimeout
        }
        return heldIds.length
      }, values)
      expect(heldCount, 'captured the MindBox 500ms debounce timer').toBe(1)
    }

    // (7a) save ack over a different ranked query (user typed another query, let debounce apply, then typed back id:<tabId> while debouncing)
    await page.context().setOffline(true)
    await focusMindboxInPlace(page)
    await mindbox(page).fill('')
    await waitQueryReady()
    await page.keyboard.press('Shift+Enter')
    let guardTabId = ''
    await expect
      .poll(
        async () => {
          const it = await page.evaluate(() => ((window as any).__items as any[]).find(i => i.savedId == null && i.editing))
          if (it) guardTabId = it.id
          return it ? { id: it.id, target: !!it.target } : null
        },
        { message: 'offline empty item created for guard check', timeout: 10_000 }
      )
      .toMatchObject({ target: true })
    await expect(mindbox(page)).toHaveValue(`id:${guardTabId}`)
    await focusMindboxInPlace(page)
    await mindbox(page).fill('e2e_bc_other_query')
    await waitQueryReady() // let debounce apply so lastRankedQuery becomes 'e2e_bc_other_query'
    await expect
      .poll(() => page.evaluate(id => !!((window as any).__items as any[]).find(i => i.id === id)?.target, guardTabId))
      .toBe(false)
    await fillHoldingDebounce([`id:${guardTabId}`])
    expect(await page.evaluate(() => (window as any)._editor_change_pending), 'debounce pending before save ack').toBe(true)
    await page.context().setOffline(false)
    const [guardSavedId] = await saved(page, [guardTabId])
    await page.evaluate(() => (window as any).__se1_restore_timer?.())
    createdEmptyIds.push(guardSavedId)
    await expect(mindbox(page), 'save ack over a different ranked query still selects the saved item').toHaveValue(`id:${guardSavedId}`)
    expect(
      await page.evaluate(id => !!((window as any).__items as any[]).find(i => i.id === id)?.target, guardTabId),
      'save ack over a different ranked query still selects the saved item'
    ).toBe(true)
    await removeSavedItem(guardSavedId)

    // (7b) save ack with a pending change while lastRankedQuery is STILL id:<tabId> (typed away
    // and back inside one debounce interval): must take the full path and settle
    await page.context().setOffline(true)
    await focusMindboxInPlace(page)
    await mindbox(page).fill('')
    await waitQueryReady()
    await page.keyboard.press('Shift+Enter')
    let pendTabId = ''
    await expect
      .poll(
        async () => {
          const it = await page.evaluate(() => ((window as any).__items as any[]).find(i => i.savedId == null && i.editing))
          if (it) pendTabId = it.id
          return it ? { id: it.id, target: !!it.target } : null
        },
        { message: 'offline empty item created for pending same-query guard check', timeout: 10_000 }
      )
      .toMatchObject({ target: true })
    await expect(mindbox(page)).toHaveValue(`id:${pendTabId}`)
    await waitQueryReady()
    await focusMindboxInPlace(page)
    await fillHoldingDebounce(['e2e_se3_typed_away', `id:${pendTabId}`])
    expect(
      await page.evaluate(id => {
        const w = window as any
        return {
          pending: !!w._editor_change_pending,
          debounced: !!w._mindboxDebounced,
          target: !!(w.__items as any[]).find(i => i.id === id)?.target,
        }
      }, pendTabId),
      'pending same-query premise: change pending with lastRankedQuery still on id:<tabId>'
    ).toEqual({ pending: true, debounced: true, target: true })
    const layoutBeforePendAck = await page.evaluate(() => (window as any).__layoutCount as number)
    await page.context().setOffline(false)
    const [pendSavedId] = await saved(page, [pendTabId])
    createdEmptyIds.push(pendSavedId)
    await expect(mindbox(page), 'pending same-query save ack upgrades box to id:<savedId>').toHaveValue(`id:${pendSavedId}`)
    expect(
      await page.evaluate(before => {
        const w = window as any
        return {
          pending: !!w._editor_change_pending,
          debounced: !!w._mindboxDebounced,
          reranked: (w.__layoutCount as number) > before,
        }
      }, layoutBeforePendAck),
      'save ack with a pending change on the same ranked query takes the full path and settles'
    ).toEqual({ pending: false, debounced: false, reranked: true })
    await page.evaluate(() => (window as any).__se1_restore_timer?.())
    await removeSavedItem(pendSavedId)

    await waitNoBcSaves(page)
    expect(errors, 'no page errors').toEqual([])
  } finally {
    await page.evaluate(() => {
      ;(window as any).__bc_restore_replace?.()
      ;(window as any).__se1_rec?.restore?.()
      ;(window as any).__se1_restore_timer?.()
      delete (window as any).__se3_changes
      delete (window as any).__se3_searches
      delete (window as any).__se3_applied
      localStorage.removeItem('mindpage_green_screen')
    }).catch(() => {})
    await page.context().setOffline(false)
    for (const id of createdEmptyIds) await firestore().collection('items').doc(id).delete().catch(() => {})
    await deleteBoxAfterCreation()
  }
})

test('unnamed creation leaves a changed box alone on save, keeps named, child, command and _create behavior as today, and handles concurrent pending saves and pre-save deletion', async ({ page }) => {
  await deleteBoxAfterCreation()
  await loadAdmin(page)
  const errors: string[] = []
  page.on('pageerror', error => {
    if (!String(error).includes('localStorage')) errors.push(String(error))
  })
  const focusBox = async () => {
    await focusMindboxInPlace(page)
    await expect(mindbox(page)).toBeFocused()
  }
  try {
    // (a) box changed before save: save leaves the owner's box alone
    const CHANGED = 'e2e_bc changed before save'
    const OWNER_TYPED = 'e2e_bc owner query'
    await page.context().setOffline(true)
    await focusBox()
    await mindbox(page).fill(CHANGED)
    await page.keyboard.press('Shift+Enter')
    const changedId = await waitPendingBc(page, CHANGED)
    await expect(mindbox(page)).toHaveValue(`id:${changedId}`)
    await focusBox()
    await mindbox(page).fill(OWNER_TYPED)
    await page.context().setOffline(false)
    await saved(page, [changedId])
    await settled(page)
    await expect(mindbox(page), 'box changed before save is left alone').toHaveValue(OWNER_TYPED)
    await page.evaluate(id => (document.getElementById(`textarea-${id}`) as HTMLTextAreaElement | null)?.focus(), changedId)
    await page.keyboard.press('Shift+Enter')

    // (b) named creation, duplicate-tag creation, and whitespace-prefixed unique label
    const NAMED = '#e2e_bc_named'
    await focusBox()
    await mindbox(page).fill(`${NAMED} named item`)
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => page.evaluate(l => window._exists(l), NAMED)).toBe(true)
    await expect(mindbox(page), 'named creation keeps label + space').toHaveValue(`${NAMED} `)
    await saved(page, [NAMED])
    await expect(mindbox(page), 'named creation still holds label + space after save').toHaveValue(`${NAMED} `)
    await page.keyboard.press('Shift+Enter')

    const DUP = '#e2e_bc_dup'
    await page.evaluate(t => void window._create(t), `${DUP} first`)
    await expect.poll(() => page.evaluate(l => window._items(l).length, DUP)).toBe(1)
    await focusBox()
    await mindbox(page).fill(`${DUP} second`)
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => page.evaluate(l => window._items(l).length, DUP)).toBe(2)
    await expect(mindbox(page), 'duplicate leading tag still keeps tag + space').toHaveValue(`${DUP} `)
    await page.keyboard.press('Shift+Enter')

    const WS_NAMED = '#e2e_bc_ws'
    await focusBox()
    await mindbox(page).fill(`  ${WS_NAMED} leading whitespace`)
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => page.evaluate(l => window._exists(l), WS_NAMED)).toBe(true)
    await expect(mindbox(page), 'whitespace-prefixed unique label selects by label (not id)').toHaveValue(WS_NAMED)
    await saved(page, [WS_NAMED])
    await expect(mindbox(page), 'whitespace-prefixed unique label keeps label after save').toHaveValue(WS_NAMED)
    await page.keyboard.press('Shift+Enter')

    // (c) child creation stays as today
    await asUser(page, l => (window._item(l) as any).select(), NAMED)
    await expect(mindbox(page)).toHaveValue(NAMED)
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => page.evaluate(l => window._exists(l), `${NAMED}/0`)).toBe(true)
    await expect(mindbox(page), 'child creation keeps child label + space').toHaveValue(`${NAMED}/0 `)
    await saved(page, [`${NAMED}/0`])
    await expect(mindbox(page), 'child creation still holds child label + space after save').toHaveValue(`${NAMED}/0 `)
    await page.keyboard.press('Shift+Enter')

    // (d) other box creation triggers on unnamed text: Ctrl+S, Alt+Enter, Create button, Run key (Ctrl/Cmd+Enter)
    for (const [label, text, trigger] of [
      ['Ctrl+S', 'e2e_bc created via ctrl+s', () => page.keyboard.press('Control+s')],
      ['Alt+Enter', 'e2e_bc created via alt+enter', () => page.keyboard.press('Alt+Enter')],
      ['create button', 'e2e_bc created via create button', () => page.locator('.header .button.create').click()],
    ] as const) {
      await focusBox()
      await mindbox(page).fill(text)
      await trigger()
      let id = ''
      await expect.poll(async () => {
        const it = await findBcItem(page, text)
        if (it) id = it.id
        return it?.target ?? false
      }).toBe(true)
      const [docId] = await saved(page, [id])
      await expect(mindbox(page), `${label} unnamed creation upgrades box to id:<savedId>`).toHaveValue(`id:${docId}`)
      await page.keyboard.press('Shift+Enter')
    }

    const RUN = 'e2e_bc run unnamed\n```js_input\n20 + 22\n```'
    await focusBox()
    await mindbox(page).fill(RUN)
    await page.keyboard.press('ControlOrMeta+Enter')
    let runId = ''
    await expect
      .poll(async () => {
        const it = await page.evaluate(() =>
          ((window as any).__items as any[]).find(i => i.text.startsWith('e2e_bc run unnamed') && i.text.includes('42'))
        )
        if (it) runId = it.id
        return it ? { target: !!it.target, hasOutput: it.text.includes('42') } : null
      })
      .toEqual({ target: true, hasOutput: true })
    const [runSaved] = await saved(page, [runId])
    await expect(mindbox(page), 'run-key unnamed creation upgrades box to id:<savedId>').toHaveValue(`id:${runSaved}`)
    await page.keyboard.press('Shift+Enter')

    // (e) synthetic window._create keeps box untouched, and fall-through /_undelete stays cleared
    await asUser(page, l => (window._item(l) as any).select(), NAMED)
    await expect(mindbox(page)).toHaveValue(NAMED)
    await page.evaluate(() => void window._create('e2e_bc synthetic create'))
    await expect.poll(async () => !!(await findBcItem(page, 'e2e_bc synthetic create'))?.savedId, { timeout: 30_000 }).toBe(true)
    await expect(mindbox(page), 'synthetic window._create leaves MindBox alone').toHaveValue(NAMED)

    await page.evaluate(l => void window._item(l)!.delete(false), NAMED)
    await expect.poll(() => page.evaluate(l => window._exists(l), NAMED)).toBe(false)
    await focusBox()
    await mindbox(page).fill('/_undelete')
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => page.evaluate(l => window._exists(l), NAMED)).toBe(true)
    await saved(page, [NAMED])
    await expect(mindbox(page), '/_undelete clears box as today (never selects named item by id)').toHaveValue('')

    // (f) second creation while first save is pending: first save never clobbers the second
    const FIRST = 'e2e_bc pending first'
    const SECOND = 'e2e_bc pending second'
    await page.context().setOffline(true)
    await focusBox()
    await mindbox(page).fill(FIRST)
    await page.keyboard.press('Shift+Enter')
    const firstId = await waitPendingBc(page, FIRST)
    await expect(mindbox(page)).toHaveValue(`id:${firstId}`)

    await focusBox()
    await mindbox(page).fill(SECOND)
    await page.keyboard.press('Shift+Enter')
    const secondId = await waitPendingBc(page, SECOND)
    await expect(mindbox(page)).toHaveValue(`id:${secondId}`)

    await page.context().setOffline(false)
    const [firstSaved, secondSaved] = await saved(page, [firstId, secondId])
    expect(firstSaved).not.toBe(secondSaved)
    await expect(mindbox(page), 'after both saves confirm, box holds the second item id').toHaveValue(`id:${secondSaved}`)
    await page.keyboard.press('Shift+Enter')

    // (g) item deleted before its save confirms: box clears on delete and stays clear after online reconnect
    const DELETED = 'e2e_bc deleted before save'
    await page.context().setOffline(true)
    await focusBox()
    await mindbox(page).fill(DELETED)
    await page.keyboard.press('Shift+Enter')
    const deletedId = await waitPendingBc(page, DELETED)
    await expect(mindbox(page)).toHaveValue(`id:${deletedId}`)
    await page.evaluate(id => void window._item(id)!.delete(false), deletedId)
    await expect(mindbox(page), 'deleting pending item clears MindBox').toHaveValue('')
    await page.context().setOffline(false)
    const SENTINEL = 'e2e_bc sentinel after delete'
    await page.evaluate(t => void window._create(t), SENTINEL)
    await expect.poll(async () => !!(await findBcItem(page, SENTINEL))?.savedId, { timeout: 30_000 }).toBe(true)
    await settled(page)
    await expect(mindbox(page), 'after reconnect, deleted item save does not write a dead id into MindBox').toHaveValue('')
    await expect
      .poll(
        async () => {
          const remaining = await firestore().collection('items').where('user', '==', 'anonymous').get()
          return remaining.docs.filter(d => d.data().text === DELETED).length
        },
        { message: 'deleted-before-save item was also removed from Firestore', timeout: 15_000 }
      )
      .toBe(0)
    expect(errors, 'no page errors').toEqual([])
  } finally {
    await page.context().setOffline(false)
    await deleteBoxAfterCreation()
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

// wait until the route's render overlay (.loading.visible, translucent while renderingVisibleItems) is gone
// (see docs/mind_page_testing.md and ready() in tests/e2e/layout.spec.ts)
async function waitForRenderOverlayGone(page: Page) {
  await expect
    .poll(() => page.evaluate(() => !document.querySelector('.loading.visible')), {
      message: "the page is done rendering: the route's overlay is gone",
      timeout: 30_000,
    })
    .toBe(true)
}

async function openEditorWithDraft(page: Page, id: string, suffix: string, expectedDraft: string) {
  const paragraph = page.locator(`.column:not(.hidden) .super-container:not(.hidden) #item-${id} p`).first()
  const editTextarea = page.locator(`#textarea-${id}`)
  await expect(paragraph).toBeVisible()
  await expect(async () => {
    await waitForRenderOverlayGone(page)
    const alreadyOpen = await page.evaluate(
      targetId => !!(window as any).__items.find((i: any) => i.id == targetId)?.editing,
      id
    )
    if (!alreadyOpen) {
      await expect(paragraph).toBeVisible({ timeout: 2_000 })
      await paragraph.click({ timeout: 2_000 })
    }
    await expect(editTextarea).toBeFocused({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
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

const SANITY_ERROR_RE = /toggles are not|toggles are incomplete|invalid toggles|invalid hideIndex|items are not ordered by time/

async function clickShowMoreRevealsNext(page: Page, context: string) {
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())))
  const initial = await page.evaluate(() => ({
    hideIndex: (window as any).__hideIndex as number,
    total: ((window as any).__items as any[]).length,
  }))
  expect(initial.hideIndex, `precondition: items remain hidden ${context}`).toBeLessThan(initial.total)
  const show = page.locator('.column:not(.hidden) .toggle.show').first()
  // non-retrying check after Svelte's flush: a retrying wait can be masked seconds later by an unrelated background rerank
  expect(await show.count(), `show more control is rendered ${context} (hideIndex=${initial.hideIndex})`).toBeGreaterThan(0)
  await waitForRenderOverlayGone(page)
  const before = await page.evaluate(() => {
    const items = (window as any).__items as any[]
    const hideIndex = (window as any).__hideIndex as number
    return { hideIndex, total: items.length, nextId: items[hideIndex]?.id ?? null }
  })
  expect(before.hideIndex, `precondition: items remain hidden ${context}`).toBeLessThan(before.total)
  await expect(show, `show more control is visible ${context}`).toBeVisible()
  const countText = (await show.locator('.count').textContent()) ?? ''
  const shownCount = Number(countText.match(/show (\d+) items/)?.[1] ?? NaN)
  expect(shownCount, `show more control reports a positive count ${context} ("${countText}")`).toBeGreaterThan(0)
  await show.click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__hideIndex as number), {
      message: `clicking show more advances __hideIndex by ${shownCount} ${context}`,
      timeout: 10_000,
    })
    .toBe(before.hideIndex + shownCount)
  await expect(
    page.locator(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${before.nextId}"]`),
    `clicking show more reveals the next hidden item ${context}`
  ).toBeVisible()
  await waitForRenderOverlayGone(page)
}

test('the show-more cutoff stays below deep log entries edited in place across Ctrl+Down, Tab, trailing space, and arrival', async ({ page }) => {
  const LOG_COUNT = 45
  const logIds = Array.from({ length: LOG_COUNT }, (_, i) => `e2e_cutoff_ab_log_${String(i).padStart(2, '0')}`)
  const ARRIVED_ID = 'e2e_cutoff_ab_arrived'
  const baseTime = Date.now() - 48 * 3600 * 1000
  const batch = firestore().batch()
  const itemsCol = firestore().collection('items')
  logIds.forEach((id, i) => {
    batch.set(itemsCol.doc(id), { user: 'anonymous', time: baseTime + i * 60_000, attr: null, text: `#log e2e_cutoff_ab entry ${i}` })
  })
  await batch.commit()

  const sanityErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() == 'error' && SANITY_ERROR_RE.test(msg.text())) sanityErrors.push(msg.text())
  })

  const cutoffOf = (id: string) =>
    page.evaluate(targetId => {
      const items = (window as any).__items as any[]
      const item = items.find(i => i.id == targetId)
      return {
        hideIndex: (window as any).__hideIndex as number,
        index: item ? (item.index as number) : -1,
        editingPromoted: !!item?.editingPromoted,
      }
    }, id)

  try {
    await loadAdmin(page)
    await expect
      .poll(() => page.evaluate(ids => ids.every(id => (window as any).__items.some((i: any) => i.id == id)), logIds), {
        message: 'all seeded log fixtures loaded',
        timeout: 30_000,
      })
      .toBe(true)

    // precondition: under #log expand one group to locate a real group boundary, then expand past it
    await searchMindbox(page, '#log')
    const initialHideIndex = await page.evaluate(() => (window as any).__hideIndex as number)
    await clickShowMoreRevealsNext(page, 'expanding first group under #log')
    const boundary = await page.evaluate(() => (window as any).__hideIndex as number)
    expect(boundary, 'precondition: group boundary lies past initial cutoff').toBeGreaterThan(initialHideIndex)
    const { beforeId, beforeText, afterId, afterText } = await page.evaluate(b => {
      const items = (window as any).__items as any[]
      return {
        beforeId: items[b - 1].id as string,
        beforeText: items[b - 1].text as string,
        afterId: items[b].id as string,
        afterText: items[b].text as string,
      }
    }, boundary)
    await clickShowMoreRevealsNext(page, 'expanding past boundary under #log')

    // click to edit the last log before the boundary (caches hideIndexMinimal = boundary), then Ctrl+Down opens the next log across it
    const firstDraft = `${beforeText} first`
    const secondDraft = `${afterText} second`
    await openEditorWithDraft(page, beforeId, ' first', firstDraft)
    expect((await cutoffOf(beforeId)).editingPromoted, 'precondition: deep log is edited in place').toBe(false)
    await page.keyboard.press('Control+ArrowDown')
    const secondTextarea = page.locator(`#textarea-${afterId}`)
    await expect(secondTextarea, 'Ctrl+Down opened and focused the editor past the boundary').toBeFocused()
    await page.evaluate(id => {
      const t = document.getElementById(`textarea-${id}`) as HTMLTextAreaElement
      t.setSelectionRange(t.value.length, t.value.length)
    }, afterId)
    await page.keyboard.type(' second')
    await expect(secondTextarea).toHaveValue(secondDraft)

    // expand one more group via Show more (returning focus to page), then Tab retreats across a real group boundary without hiding the Ctrl+Down draft
    await clickShowMoreRevealsNext(page, 'expanding further before window Tab')
    const beforeTabHideIndex = await page.evaluate(() => (window as any).__hideIndex as number)
    await expect(secondTextarea).not.toBeFocused()
    await page.keyboard.press('Tab')
    await expect(mindbox(page), 'window Tab handler ran and focused MindBox').toBeFocused()
    const afterTab = await cutoffOf(afterId)
    expect(afterTab.hideIndex, 'precondition: Tab retreated across a real group boundary').toBeLessThan(beforeTabHideIndex)
    expect(
      afterTab.index,
      `Ctrl+Down editor index (${afterTab.index}) must stay below __hideIndex (${afterTab.hideIndex}) after window Tab`
    ).toBeLessThan(afterTab.hideIndex)
    await expectEditorVisible(page, afterId, secondDraft, 'after window Tab across a group boundary')
    await clickShowMoreRevealsNext(page, 'after window Tab')

    // A: appending a space changes raw text (triggering cutoff reset) without promoting the deep log entry
    await searchMindbox(page, '#log ')
    const afterSpace = await cutoffOf(afterId)
    expect(afterSpace.editingPromoted, 'deep log stays unpromoted after trailing space').toBe(false)
    expect(afterSpace.index, 'deep log keeps its place after trailing space').toBe(boundary)
    expect(
      afterSpace.index,
      `deep log index (${afterSpace.index}) must stay below __hideIndex (${afterSpace.hideIndex}) after trailing space`
    ).toBeLessThan(afterSpace.hideIndex)
    await expectEditorVisible(page, afterId, secondDraft, 'after trailing space under #log')

    // B: a new log item arrives from the store above the edited entry
    await itemsCol.doc(ARRIVED_ID).set({
      user: 'anonymous',
      time: Date.now(),
      attr: null,
      text: '#log e2e_cutoff_ab arrived remotely',
    })
    await expect
      .poll(() => page.evaluate(id => (window as any).__items.some((i: any) => i.id == id), ARRIVED_ID), {
        message: 'arrived log item integrated',
        timeout: 30_000,
      })
      .toBe(true)

    const afterArrival = await cutoffOf(afterId)
    expect((await cutoffOf(ARRIVED_ID)).index, 'precondition: arriving log ranks above deep log').toBeLessThan(afterArrival.index)
    expect(afterArrival.editingPromoted, 'deep log stays unpromoted after arriving log item').toBe(false)
    expect(afterArrival.index, 'deep log shifts by 1 in time order after arrival').toBe(boundary + 1)
    expect(
      afterArrival.index,
      `deep log index (${afterArrival.index}) must stay below __hideIndex (${afterArrival.hideIndex}) after arriving log item`
    ).toBeLessThan(afterArrival.hideIndex)
    await expectEditorVisible(page, afterId, secondDraft, 'after arriving log item under #log')
    expect(sanityErrors, 'toggle and ranking sanity checks stayed silent').toEqual([])
  } finally {
    const cleanup = firestore().batch()
    ;[...logIds, ARRIVED_ID].forEach(id => cleanup.delete(itemsCol.doc(id)))
    await cleanup.commit()
  }
})

test('the show-more cutoff stays below an open editor ranked below search-specific pins, including after ArrowUp to a pinned parent', async ({ page }) => {
  const TOPIC_ID = 'e2e_cutoff_c_topic'
  const CHILD_ID = 'e2e_cutoff_c_child'
  const TOPIC_PIN_ID = 'e2e_cutoff_c_topic_pin'
  const EDIT_ID = 'e2e_cutoff_c_edit'
  const EDIT_TEXT = '#e2e_cutoff_c_edit non-log item edited below search pins'
  const DRAFT_TEXT = `${EDIT_TEXT} draft`
  const LOG_PIN_COUNT = 12
  const LOG_COUNT = 40
  const OLDER_LOG_ID = 'e2e_cutoff_c_older_log'
  const logPinIds = Array.from({ length: LOG_PIN_COUNT }, (_, i) => `e2e_cutoff_c_logpin_${String(i).padStart(2, '0')}`)
  const logIds = Array.from({ length: LOG_COUNT }, (_, i) => `e2e_cutoff_c_log_${String(i).padStart(2, '0')}`)
  const allIds = [TOPIC_ID, CHILD_ID, TOPIC_PIN_ID, EDIT_ID, ...logPinIds, ...logIds]
  const baseTime = Date.now() - 48 * 3600 * 1000
  const batch = firestore().batch()
  const itemsCol = firestore().collection('items')
  batch.set(itemsCol.doc(TOPIC_ID), { user: 'anonymous', time: baseTime - 60_000, attr: null, text: '#e2e_cutoff_c_topic unique target item' })
  batch.set(itemsCol.doc(CHILD_ID), { user: 'anonymous', time: baseTime - 90_000, attr: null, text: '#e2e_cutoff_c_topic/child child under pinned parent' })
  batch.set(itemsCol.doc(TOPIC_PIN_ID), { user: 'anonymous', time: baseTime - 120_000, attr: null, text: '#e2e_cutoff_c_topic_pin #_e2e_cutoff_c_topic/pin pinned to topic' })
  batch.set(itemsCol.doc(EDIT_ID), { user: 'anonymous', time: baseTime - 180_000, attr: null, text: EDIT_TEXT })
  logPinIds.forEach((id, i) => {
    batch.set(itemsCol.doc(id), {
      user: 'anonymous',
      time: baseTime - 240_000 - i * 1000,
      attr: null,
      text: `#${id} #_log/pin/${String(i).padStart(2, '0')} pinned to log ${i}`,
    })
  })
  logIds.forEach((id, i) => {
    batch.set(itemsCol.doc(id), { user: 'anonymous', time: baseTime + i * 60_000, attr: null, text: `#log e2e_cutoff_c entry ${i}` })
  })
  await batch.commit()

  const sanityErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() == 'error' && SANITY_ERROR_RE.test(msg.text())) sanityErrors.push(msg.text())
  })

  const readState = () =>
    page.evaluate(
      ([topicId, topicPinId, editId, logPinIds]) => {
        const items = (window as any).__items as any[]
        const info = (id: string) => {
          const it = items.find(i => i.id == id)
          return it ? { index: it.index as number, pinned: !!it.pinned, pinnedMatch: !!it.pinnedMatch, target: !!it.target } : null
        }
        return {
          hideIndex: (window as any).__hideIndex as number,
          editingCount: items.filter(i => i.editing).length,
          topic: info(topicId),
          topicPin: info(topicPinId),
          edit: info(editId),
          logPins: logPinIds.map(id => info(id)),
        }
      },
      [TOPIC_ID, TOPIC_PIN_ID, EDIT_ID, logPinIds] as const
    )

  const visibleItem = (id: string) =>
    page.locator(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${id}"]`)

  try {
    await loadAdmin(page)
    await expect
      .poll(() => page.evaluate(ids => ids.every(id => (window as any).__items.some((i: any) => i.id == id)), allIds), {
        message: 'all seeded pin-match fixtures loaded',
        timeout: 30_000,
      })
      .toBe(true)

    // no item in edit mode: under unique #topic with #_topic/pin, both pin and target are rendered and below __hideIndex
    await searchMindbox(page, '#e2e_cutoff_c_topic')
    const atTopicNoEdit = await readState()
    expect(atTopicNoEdit.editingCount, 'precondition: no item is in edit mode under #topic').toBe(0)
    expect(
      atTopicNoEdit.topicPin?.pinnedMatch && !atTopicNoEdit.topicPin.pinned,
      'precondition: #_topic/pin is pinnedMatch, not pinned (no edit)'
    ).toBe(true)
    expect(atTopicNoEdit.topic?.target, 'precondition: #topic is the target (no edit)').toBe(true)
    expect(atTopicNoEdit.topicPin!.index, 'precondition: #_topic/pin ranks above target (no edit)').toBeLessThan(
      atTopicNoEdit.topic!.index
    )
    expect.soft(
      atTopicNoEdit.topicPin!.index,
      `no-edit #topic: #_topic/pin index (${atTopicNoEdit.topicPin!.index}) must stay below __hideIndex (${atTopicNoEdit.hideIndex})`
    ).toBeLessThan(atTopicNoEdit.hideIndex)
    expect.soft(
      atTopicNoEdit.topic!.index,
      `no-edit #topic: target index (${atTopicNoEdit.topic!.index}) must stay below __hideIndex (${atTopicNoEdit.hideIndex})`
    ).toBeLessThan(atTopicNoEdit.hideIndex)
    await expect.soft
      .poll(
        () =>
          page.evaluate(
            ([pinId, topicId]) => {
              const rendered = (id: string) => {
                const el = document.querySelector(
                  `.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${id}"]`
                )
                return !!el && el.getClientRects().length > 0
              }
              return { pinRendered: rendered(pinId), targetRendered: rendered(topicId) }
            },
            [TOPIC_PIN_ID, TOPIC_ID] as const
          ),
        { message: 'no-edit #topic: both #_topic/pin and target are rendered' }
      )
      .toEqual({ pinRendered: true, targetRendered: true })

    // Back after closing promoted #log editors elsewhere: with two editors open under pinned #topic,
    // the saved cutoff (10) falls strictly inside a rebuilt step once both close and drop to the tail
    const LOG_A = logIds[0]
    const LOG_B = logIds[9]
    await searchMindbox(page, 'e2e_cutoff_c entry 0')
    await openEditorWithDraft(page, LOG_A, ' draft', '#log e2e_cutoff_c entry 0 draft')
    await searchMindbox(page, 'e2e_cutoff_c entry 9')
    await openEditorWithDraft(page, LOG_B, ' draft', '#log e2e_cutoff_c entry 9 draft')
    await searchMindbox(page, '#e2e_cutoff_c_topic')
    await expectEditorVisible(page, LOG_A, '#log e2e_cutoff_c entry 0 draft', 'first promoted #log under pinned #topic')
    await expectEditorVisible(page, LOG_B, '#log e2e_cutoff_c entry 9 draft', 'second promoted #log under pinned #topic')
    const savedHideIndex = await page.evaluate(() => (window as any).__hideIndex as number)
    await page.locator(`#item-${TOPIC_PIN_ID} mark.label`).first().click()
    await expect
      .poll(() => page.evaluate(() => history.state?.editorText), { message: 'navigated away from pinned #topic' })
      .toBe('#e2e_cutoff_c_topic_pin ')
    for (const id of [LOG_A, LOG_B]) {
      await visibleEditContainer(page, id).locator('.edit-menu .button.cancel').click()
      await page.locator('.modal .button.confirm', { hasText: 'Discard' }).click()
      await expect
        .poll(() => page.evaluate(targetId => (window as any).__items.find((i: any) => i.id == targetId)?.editing, id))
        .toBe(false)
    }
    for (let steps = 0; steps < 4; steps++) {
      if ((await page.evaluate(() => history.state?.editorText)) == '#e2e_cutoff_c_topic') break
      await page.goBack()
      await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())))
    }
    await expect
      .poll(() => page.evaluate(() => history.state?.editorText), { message: 'returned to pinned #topic via Back' })
      .toBe('#e2e_cutoff_c_topic')
    const afterBack = await page.evaluate(() => ({
      hideIndex: (window as any).__hideIndex as number,
      toggles: ((window as any).__toggles as Array<{ start: number; end: number }>).map(t => ({
        start: t.start,
        end: t.end,
      })),
    }))
    expect(afterBack.hideIndex, 'Back restored the saved cutoff').toBe(savedHideIndex)
    expect(
      afterBack.toggles.some(t => t.start == afterBack.hideIndex),
      `precondition: restored cutoff (${afterBack.hideIndex}) is not any step start: ${JSON.stringify(afterBack.toggles)}`
    ).toBe(false)
    expect(
      afterBack.toggles.some(t => t.start < afterBack.hideIndex && afterBack.hideIndex < t.end),
      `precondition: restored cutoff (${afterBack.hideIndex}) falls strictly inside a rebuilt toggle step: ${JSON.stringify(afterBack.toggles)}`
    ).toBe(true)
    await clickShowMoreRevealsNext(page, 'after Back with editors closed under pinned #topic')

    // expand to the end of the final group, let an older unrelated log arrive (putting hideIndex inside the last group),
    // then press Tab: earlier groups must survive so Show more still works after Tab retreats
    for (let clicks = 0; clicks < 10; clicks++) {
      const { hideIndex, total } = await page.evaluate(() => ({
        hideIndex: (window as any).__hideIndex as number,
        total: ((window as any).__items as any[]).length,
      }))
      if (hideIndex >= total) break
      await clickShowMoreRevealsNext(page, `expanding to final group (step ${clicks})`)
    }
    const oldestTime = await page.evaluate(() => Math.min(...((window as any).__items as any[]).map(i => i.time as number)))
    await itemsCol.doc(OLDER_LOG_ID).set({
      user: 'anonymous',
      time: oldestTime - 60_000,
      attr: null,
      text: '#log e2e_cutoff_c older unrelated log',
    })
    await expect
      .poll(() => page.evaluate(id => (window as any).__items.some((i: any) => i.id == id), OLDER_LOG_ID), {
        message: 'older unrelated log integrated',
        timeout: 30_000,
      })
      .toBe(true)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Tab')
    await expect(mindbox(page), 'window Tab handler ran after older log arrival').toBeFocused()
    await clickShowMoreRevealsNext(page, 'after older log arrival and window Tab')

    await searchMindbox(page, '#e2e_cutoff_c_edit')
    await openEditorWithDraft(page, EDIT_ID, ' draft', DRAFT_TEXT)

    // C1: unique #topic with one #_topic/pin item (first toggle is trimmed past the target to start at the open editor)
    await searchMindbox(page, '#e2e_cutoff_c_topic')
    const atTopic = await readState()
    expect(atTopic.topicPin?.pinnedMatch && !atTopic.topicPin.pinned, 'precondition: #_topic/pin is pinnedMatch, not pinned').toBe(true)
    expect(atTopic.topic?.target, 'precondition: #topic is the target').toBe(true)
    expect(atTopic.topicPin!.index, 'precondition: #_topic/pin ranks above target').toBeLessThan(atTopic.topic!.index)
    expect(atTopic.topic!.index, 'precondition: target ranks above open editor').toBeLessThan(atTopic.edit!.index)
    expect(
      atTopic.edit!.index,
      `C1: edited item index (${atTopic.edit!.index}) must stay below __hideIndex (${atTopic.hideIndex}) under #topic with #_topic/pin`
    ).toBeLessThan(atTopic.hideIndex)
    await expectEditorVisible(page, EDIT_ID, DRAFT_TEXT, 'under #topic with #_topic/pin')

    // C2: #log with 12 #_log/pin items (first toggle ends before the edited non-log item)
    await searchMindbox(page, '#log')
    const atLog = await readState()
    expect(atLog.logPins.every(p => p && p.pinnedMatch && !p.pinned), 'precondition: all 12 #_log/pin items are pinnedMatch, not pinned').toBe(true)
    expect(Math.max(...atLog.logPins.map(p => p!.index)), 'precondition: all 12 #_log/pin items rank above editor').toBeLessThan(atLog.edit!.index)
    expect(
      atLog.edit!.index,
      `C2: edited item index (${atLog.edit!.index}) must stay below __hideIndex (${atLog.hideIndex}) under #log with 12 #_log/pin items`
    ).toBeLessThan(atLog.hideIndex)
    await expectEditorVisible(page, EDIT_ID, DRAFT_TEXT, 'under #log with 12 #_log/pin items')

    // ArrowUp from #topic/child (no Hide control) to unique parent #topic with #_topic/pin: automatic collapse must not hide target or draft
    await searchMindbox(page, '#e2e_cutoff_c_topic/child')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await expect(mindbox(page)).not.toBeFocused()
    await expect(page.locator('.column:not(.hidden) .toggle.hide'), 'precondition: child view has no Hide control').toHaveCount(0)
    await page.keyboard.press('ArrowUp')
    await expect
      .poll(() => page.evaluate(() => history.state?.editorText), { message: 'ArrowUp navigated to parent #topic' })
      .toBe('#e2e_cutoff_c_topic ')
    // wait for ArrowUp's deferred update_dom().then(...) collapse to settle
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))))
    const afterArrowUp = await readState()
    expect(afterArrowUp.topic?.target, 'parent #topic is target after ArrowUp').toBe(true)
    expect(
      afterArrowUp.topic!.index,
      `after ArrowUp to pinned parent, target index (${afterArrowUp.topic!.index}) must stay below __hideIndex (${afterArrowUp.hideIndex})`
    ).toBeLessThan(afterArrowUp.hideIndex)
    await expect(visibleItem(TOPIC_ID), 'parent #topic stays rendered after ArrowUp').toBeVisible()
    expect(
      afterArrowUp.edit!.index,
      `after ArrowUp to pinned parent, editor index (${afterArrowUp.edit!.index}) must stay below __hideIndex (${afterArrowUp.hideIndex})`
    ).toBeLessThan(afterArrowUp.hideIndex)
    await expectEditorVisible(page, EDIT_ID, DRAFT_TEXT, 'after ArrowUp to pinned parent')
    expect(sanityErrors, 'toggle and ranking sanity checks stayed silent').toEqual([])
  } finally {
    const cleanup = firestore().batch()
    ;[...allIds, OLDER_LOG_ID].forEach(id => cleanup.delete(itemsCol.doc(id)))
    await cleanup.commit()
  }
})

test('an in-place log saved to a step past the cutoff is promoted below the target, matching a near save in history and keeping focus', async ({ page }) => {
  const TOPIC_ID = 'e2e_promote_topic'
  const PIN_ID = 'e2e_promote_pin'
  const EXACT_COUNT = 50
  const SUB_COUNT = 20
  const exactIds = Array.from({ length: EXACT_COUNT }, (_, i) => `e2e_promote_log_${String(i).padStart(2, '0')}`)
  const subIds = Array.from({ length: SUB_COUNT }, (_, i) => `e2e_promote_sub_${String(i).padStart(2, '0')}`)
  const NEAR_LOG_ID = exactIds[EXACT_COUNT - 1]
  // pick a deeper exact-tag log (not already directly below the target) so promotion visibly reorders items
  const FAR_LOG_ID = exactIds[EXACT_COUNT - 5]
  const allIds = [TOPIC_ID, PIN_ID, ...exactIds, ...subIds]
  const baseTime = Date.now() - 48 * 3600 * 1000
  const batch = firestore().batch()
  const itemsCol = firestore().collection('items')
  batch.set(itemsCol.doc(TOPIC_ID), { user: 'anonymous', time: baseTime - 60_000, attr: null, text: `#${TOPIC_ID} unique target item` })
  batch.set(itemsCol.doc(PIN_ID), { user: 'anonymous', time: baseTime - 120_000, attr: null, text: `#${PIN_ID} #_${TOPIC_ID}/pin pinned to topic` })
  subIds.forEach((id, i) => {
    batch.set(itemsCol.doc(id), {
      user: 'anonymous',
      time: baseTime + i * 60_000,
      attr: null,
      text: `#log sub ${String(i).padStart(2, '0')} #${TOPIC_ID}/sub`,
    })
  })
  exactIds.forEach((id, i) => {
    batch.set(itemsCol.doc(id), {
      user: 'anonymous',
      time: baseTime + (SUB_COUNT + i) * 60_000,
      attr: null,
      text: `#log entry ${String(i).padStart(2, '0')} #${TOPIC_ID}`,
    })
  })
  await batch.commit()

  const sanityErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() == 'error' && SANITY_ERROR_RE.test(msg.text())) sanityErrors.push(msg.text())
  })

  // open the target query via a label click from a non-target search so history.state.final is true and a user re-ranking pushes once
  const openFinalTargetQuery = async () => {
    await searchMindbox(page, `${TOPIC_ID} unique`)
    await waitForRenderOverlayGone(page)
    await page.locator(`#item-${TOPIC_ID} mark.label`).first().click()
    await expect
      .poll(
        () =>
          page.evaluate(
            topicId => ({
              editorText: history.state?.editorText,
              final: !!history.state?.final,
              targetIdx: ((window as any).__items as any[]).findIndex(i => i.id == topicId),
              hideIndex: (window as any).__hideIndex as number,
            }),
            TOPIC_ID
          ),
        { message: 'finalized target query active via label click', timeout: 10_000 }
      )
      .toMatchObject({ editorText: `#${TOPIC_ID} `, final: true })
    await waitForRenderOverlayGone(page)
  }

  const readLogState = (id: string) =>
    page.evaluate(
      ([logId, topicId, firstSubId]) => {
        const items = (window as any).__items as any[]
        const toggles = (window as any).__toggles as Array<{ start: number; end: number }>
        const hideIndex = (window as any).__hideIndex as number
        const item = items.find(i => i.id == logId)
        const target = items.find(i => i.id == topicId)
        const firstSubIdx = items.findIndex(i => i.id == firstSubId)
        const destIdx = firstSubIdx > 0 ? firstSubIdx - 1 : -1
        const destStep = toggles.find(t => destIdx >= t.start && destIdx < t.end) ?? null
        const textarea = document.getElementById(`textarea-${logId}`) as HTMLTextAreaElement | null
        return {
          hideIndex,
          historyLength: history.length,
          historyFinal: !!history.state?.final,
          targetIndex: target ? (target.index as number) : -1,
          destIdx,
          destStep,
          item: item
            ? {
                index: item.index as number,
                editing: !!item.editing,
                editingPromoted: !!item.editingPromoted,
                firstTagMatch: !!item.firstTagMatch,
                saving: !!item.saving,
                savedText: item.savedText as string,
              }
            : null,
          textareaValue: textarea?.value ?? null,
          textareaFocused: !!textarea && document.activeElement === textarea,
        }
      },
      [id, TOPIC_ID, subIds[SUB_COUNT - 1]] as const
    )

  try {
    await loadAdmin(page)
    await expect
      .poll(() => page.evaluate(ids => ids.every(id => (window as any).__items.some((i: any) => i.id == id)), allIds), {
        message: 'all seeded promotion fixtures loaded',
        timeout: 30_000,
      })
      .toBe(true)

    // 1. Near move baseline: expand until the destination step for #topic/sub starts at or below __hideIndex,
    // retag the newest exact log in place, and save without closing (Control+s)
    await openFinalTargetQuery()
    for (let clicks = 0; clicks < 6; clicks++) {
      const s = await readLogState(NEAR_LOG_ID)
      if (s.item && s.item.index < s.hideIndex && (!s.destStep || s.destStep.start <= s.hideIndex)) break
      await clickShowMoreRevealsNext(page, `expanding for near move (step ${clicks})`)
    }
    const nearPre = await readLogState(NEAR_LOG_ID)
    expect(nearPre.item!.index, 'precondition: near log is visible').toBeLessThan(nearPre.hideIndex)
    expect(
      !nearPre.destStep || nearPre.destStep.start <= nearPre.hideIndex,
      `precondition: near destination step (${nearPre.destStep?.start}..${nearPre.destStep?.end}) starts at or below hideIndex (${nearPre.hideIndex})`
    ).toBe(true)

    const nearExpectedText = `#log entry ${String(EXACT_COUNT - 1).padStart(2, '0')} #${TOPIC_ID}/sub`
    await openEditorWithDraft(page, NEAR_LOG_ID, '/sub', nearExpectedText)
    const nearBeforeSave = await readLogState(NEAR_LOG_ID)
    expect(nearBeforeSave.historyFinal, 'precondition: finalized entry before near save').toBe(true)
    expect(nearBeforeSave.textareaFocused, 'precondition: textarea focused before near save').toBe(true)

    await page.keyboard.press('Control+s')
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())))
    await waitForRenderOverlayGone(page)
    // let updateItemLayout's update_dom() (tick + 2 rAFs) finish restoring focus/scroll
    await page.evaluate(
      () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))
    )
    const nearAfter = await readLogState(NEAR_LOG_ID)
    expect(nearAfter.item?.firstTagMatch, 'near log was saved with #topic/sub').toBe(false)
    expect(nearAfter.item?.editing, 'near log stays open in edit mode').toBe(true)
    expect(nearAfter.item?.editingPromoted, 'near move stays unpromoted in place').toBe(false)
    expect(nearAfter.item!.index, 'near move lands in subtag order, not directly below target').toBeGreaterThan(
      nearAfter.targetIndex + 1
    )
    expect(nearAfter.item!.index, 'near move stays below cutoff').toBeLessThan(nearAfter.hideIndex)
    await expectEditorVisible(page, NEAR_LOG_ID, nearExpectedText, 'after near retag save')
    const nearHistoryDelta = nearAfter.historyLength - nearBeforeSave.historyLength
    expect(nearHistoryDelta, 'near save pushes one history step from final entry').toBe(1)

    // wait for save to commit and close the near editor cleanly
    await expect
      .poll(async () => (await readLogState(NEAR_LOG_ID)).item, { message: 'near save persisted', timeout: 15_000 })
      .toMatchObject({ saving: false, savedText: nearExpectedText })
    await visibleEditContainer(page, NEAR_LOG_ID).locator('.edit-menu .button.save').click()
    await expect
      .poll(async () => (await readLogState(NEAR_LOG_ID)).item?.editing, { message: 'near editor closed', timeout: 10_000 })
      .toBe(false)

    // 2. Far move: reset to finalized target query, expand once so the destination step lies strictly past
    // __hideIndex (more than one step away), retag the next exact log in place, and save without closing
    await openFinalTargetQuery()
    await clickShowMoreRevealsNext(page, 'expanding first step for far move')
    const farPre = await readLogState(FAR_LOG_ID)
    expect(farPre.item!.index, 'precondition: far log starts below the first log slot').toBeGreaterThan(
      farPre.targetIndex + 1
    )
    expect(farPre.item!.index, 'precondition: far log is visible').toBeLessThan(farPre.hideIndex)
    expect(
      farPre.destStep && farPre.destStep.start > farPre.hideIndex,
      `precondition: far destination step (${farPre.destStep?.start}..${farPre.destStep?.end}) starts strictly past hideIndex (${farPre.hideIndex})`
    ).toBe(true)

    const farExpectedText = `#log entry ${String(EXACT_COUNT - 5).padStart(2, '0')} #${TOPIC_ID}/sub`
    await openEditorWithDraft(page, FAR_LOG_ID, '/sub', farExpectedText)
    const farBeforeSave = await readLogState(FAR_LOG_ID)
    expect(farBeforeSave.historyFinal, 'precondition: finalized entry before far save').toBe(true)
    expect(farBeforeSave.textareaFocused, 'precondition: textarea focused before far save').toBe(true)

    await page.keyboard.press('Control+s')
    // non-retrying check right after Svelte's flush so a missing synchronous restart cannot be masked later
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())))
    const farImmediate = await readLogState(FAR_LOG_ID)
    expect(farImmediate.item?.firstTagMatch, 'far log was saved with #topic/sub').toBe(false)
    expect(farImmediate.item?.editing, 'far log stays open in edit mode').toBe(true)
    expect(farImmediate.item?.editingPromoted, 'far-moving log is promoted').toBe(true)
    expect(
      farImmediate.item!.index,
      `promoted log (${farImmediate.item!.index}) ranks directly below target (${farImmediate.targetIndex})`
    ).toBe(farImmediate.targetIndex + 1)
    expect(
      farImmediate.item!.index,
      `promoted log (${farImmediate.item!.index}) stays below cutoff (${farImmediate.hideIndex})`
    ).toBeLessThan(farImmediate.hideIndex)
    expect(farImmediate.textareaValue, 'textarea remains mounted with updated text immediately after save').toBe(
      farExpectedText
    )
    const farHistoryDelta = farImmediate.historyLength - farBeforeSave.historyLength
    expect(farHistoryDelta, `history.length delta matches near save (near=${nearHistoryDelta}, far=${farHistoryDelta})`).toBe(
      nearHistoryDelta
    )

    await waitForRenderOverlayGone(page)
    // let updateItemLayout's update_dom() (tick + 2 rAFs) finish restoring focus/scroll
    await page.evaluate(
      () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))
    )
    await expectEditorVisible(page, FAR_LOG_ID, farExpectedText, 'after far retag save')
    const farSettled = await readLogState(FAR_LOG_ID)
    expect(
      farSettled.historyLength - farBeforeSave.historyLength,
      'no second history write after render settles'
    ).toBe(nearHistoryDelta)
    // near save moves across the pre-layout cutoff (losing focus there), whereas promotion lands directly below
    // target inside the already-visible prefix and keeps focus on the textarea
    expect(farSettled.textareaFocused, 'textarea keeps focus after promoted far save').toBe(true)
    expect(sanityErrors, 'toggle and ranking sanity checks stayed silent').toEqual([])
  } finally {
    const cleanup = firestore().batch()
    allIds.forEach(id => cleanup.delete(itemsCol.doc(id)))
    await cleanup.commit()
  }
})

test('removing a leading space before a slash via typed keys promotes a hidden in-place log and keeps the typed history step', async ({ page }) => {
  const NEEDLE = '/e2e_slash_needle'
  const SEARCH_QUERY = ` ${NEEDLE}`
  const OLD_LOG_ID = 'e2e_slash_old_log'
  const OLD_LOG_TEXT = `#log ${NEEDLE} old log matched only with leading space`
  const DRAFT_TEXT = `${OLD_LOG_TEXT} draft`
  const FILLER_COUNT = 50
  const fillerIds = Array.from({ length: FILLER_COUNT }, (_, i) => `e2e_slash_filler_${String(i).padStart(2, '0')}`)
  const allIds = [OLD_LOG_ID, ...fillerIds]
  const now = Date.now()
  const batch = firestore().batch()
  const itemsCol = firestore().collection('items')
  batch.set(itemsCol.doc(OLD_LOG_ID), {
    user: 'anonymous',
    time: now - 365 * 24 * 3600 * 1000,
    attr: null,
    text: OLD_LOG_TEXT,
  })
  fillerIds.forEach((id, i) => {
    batch.set(itemsCol.doc(id), {
      user: 'anonymous',
      time: now - (48 + i) * 60_000,
      attr: null,
      text: `#${id} newer filler item ${String(i).padStart(2, '0')}`,
    })
  })
  await batch.commit()

  const sanityErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() == 'error' && SANITY_ERROR_RE.test(msg.text())) sanityErrors.push(msg.text())
  })

  const readSlashState = () =>
    page.evaluate(
      ([oldLogId, fillerIds]) => {
        const items = (window as any).__items as any[]
        const oldLog = items.find(i => i.id == oldLogId)
        const fillerIndices = fillerIds.map(id => items.findIndex(i => i.id == id)).filter(i => i >= 0)
        return {
          hideIndex: (window as any).__hideIndex as number,
          historyLength: history.length,
          historyIndex: (history.state?.index as number | undefined) ?? null,
          historyEditorText: (history.state?.editorText as string | undefined) ?? null,
          historyFinal: !!history.state?.final,
          mindboxValue: (document.getElementById('textarea-mindbox') as HTMLTextAreaElement)?.value ?? null,
          debounced: !!(window as any)._mindboxDebounced,
          minFillerIndex: fillerIndices.length ? Math.min(...fillerIndices) : -1,
          oldLog: oldLog
            ? {
                index: oldLog.index as number,
                editing: !!oldLog.editing,
                editingPromoted: !!oldLog.editingPromoted,
                matching: !!oldLog.matching,
              }
            : null,
        }
      },
      [OLD_LOG_ID, fillerIds] as const
    )

  // arrive at the leading-space query on a FINAL history entry at the tip of history:
  // tag/label clicks always start with `#`, so finalize via scrollToTopWithHistory (Control+Alt+ArrowUp)
  const enterFinalLeadingSpaceQuery = async (resetQuery: string) => {
    await searchMindbox(page, resetQuery)
    await searchMindbox(page, SEARCH_QUERY)
    await waitForRenderOverlayGone(page)
    const headerTop = await page.evaluate(() => (document.querySelector('.header') as HTMLElement).offsetTop)
    await page.evaluate(y => document.body.scrollTo(0, y), headerTop + 200)
    await expect
      .poll(() => page.evaluate(() => document.body.scrollTop), { message: 'page scrolled below header', timeout: 10_000 })
      .toBeGreaterThan(headerTop + 50)
    await page.keyboard.press('Control+Alt+ArrowUp')
    await expect
      .poll(
        async () => {
          const s = await readSlashState()
          return { editorText: s.historyEditorText, final: s.historyFinal }
        },
        { message: 'leading-space query finalized via scroll shortcut', timeout: 10_000 }
      )
      .toEqual({ editorText: SEARCH_QUERY, final: true })
    await waitForRenderOverlayGone(page)
  }

  // remove the leading space with a real Backspace in the MindBox and let the debounce timer apply it
  const deleteLeadingSpaceViaDebounce = async () => {
    await focusMindboxInPlace(page)
    await expect(mindbox(page)).toBeFocused()
    await expect(mindbox(page)).toHaveValue(SEARCH_QUERY)
    await page.evaluate(() => {
      const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      box.setSelectionRange(1, 1)
    })
    await page.keyboard.press('Backspace')
    const afterKey = await readSlashState()
    expect(afterKey.mindboxValue, 'Backspace removed only the leading space').toBe(NEEDLE)
    expect(afterKey.debounced, 'typed leading-space deletion entered the debounce timer').toBe(true)
    await expect
      .poll(
        async () => {
          const s = await readSlashState()
          return !s.debounced && s.historyEditorText === NEEDLE
        },
        { message: `debounced query "${NEEDLE}" applied`, timeout: 10_000 }
      )
      .toBe(true)
    await waitForRenderOverlayGone(page)
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())))
  }

  try {
    await loadAdmin(page)
    await expect
      .poll(() => page.evaluate(ids => ids.every(id => (window as any).__items.some((i: any) => i.id == id)), allIds), {
        message: 'all seeded leading-slash fixtures loaded',
        timeout: 30_000,
      })
      .toBe(true)

    // 1. Twin (no editor open -> single pass, no restart): measure history.length delta and Back
    await enterFinalLeadingSpaceQuery(`#${fillerIds[0]}`)
    const twinBefore = await readSlashState()
    expect(twinBefore.historyFinal, 'twin precondition: on a final history entry').toBe(true)
    expect(twinBefore.oldLog?.matching, 'twin precondition: old log matches under leading-space query').toBe(true)
    expect(twinBefore.oldLog!.index, 'twin precondition: old log starts visible').toBeLessThan(twinBefore.hideIndex)

    await deleteLeadingSpaceViaDebounce()
    const twinAfter = await readSlashState()
    expect(twinAfter.oldLog?.matching, 'twin: removing leading space disables search').toBe(false)
    expect(twinAfter.oldLog!.index, 'twin: unedited old log falls behind all 50 newer fillers and past cutoff').toBeGreaterThanOrEqual(
      Math.max(twinAfter.hideIndex, FILLER_COUNT)
    )
    const twinHistoryDelta = twinAfter.historyLength - twinBefore.historyLength
    const twinIndexDelta = twinAfter.historyIndex! - twinBefore.historyIndex!
    expect(twinHistoryDelta, 'twin: debounced typed change from final entry pushes one history step').toBe(1)
    expect(twinIndexDelta, 'twin: history state index advances by one').toBe(1)

    await page.goBack()
    await expect
      .poll(
        async () => {
          const s = await readSlashState()
          return { editorText: s.historyEditorText, index: s.historyIndex }
        },
        { message: 'twin: Back returns to the leading-space query entry', timeout: 10_000 }
      )
      .toEqual({ editorText: SEARCH_QUERY, index: twinBefore.historyIndex })

    // 2. Restart path (old log open in place with a draft): removing the leading space drops it far past
    // the cutoff, triggering promotion + synchronous restart while preserving typedInput through debounce
    await enterFinalLeadingSpaceQuery(`#${fillerIds[1]}`)
    await openEditorWithDraft(page, OLD_LOG_ID, ' draft', DRAFT_TEXT)
    const restartBefore = await readSlashState()
    expect(restartBefore.historyFinal, 'restart precondition: still on a final history entry with editor open').toBe(true)
    expect(restartBefore.oldLog?.editing, 'restart precondition: old log editor is open').toBe(true)
    expect(restartBefore.oldLog?.editingPromoted, 'restart precondition: old log starts unpromoted in place').toBe(false)
    expect(restartBefore.oldLog!.index, 'restart precondition: old log starts visible').toBeLessThan(restartBefore.hideIndex)
    expect(restartBefore.hideIndex, 'restart precondition: prior cutoff stays well above the 50 fillers').toBeLessThan(FILLER_COUNT)

    await deleteLeadingSpaceViaDebounce()
    const restartAfter = await readSlashState()
    expect(restartAfter.oldLog?.matching, 'restart: removing leading space disables search').toBe(false)
    expect(restartAfter.oldLog?.editing, 'restart: old log stays open in edit mode').toBe(true)
    expect(restartAfter.oldLog?.editingPromoted, 'restart: hidden in-place log is promoted').toBe(true)
    expect(
      restartAfter.oldLog!.index,
      `restart: promoted log (${restartAfter.oldLog!.index}) ranks in the editing tier above newer fillers (${restartAfter.minFillerIndex})`
    ).toBeLessThan(restartAfter.minFillerIndex)
    expect(
      restartAfter.oldLog!.index,
      `restart: promoted log (${restartAfter.oldLog!.index}) stays below cutoff (${restartAfter.hideIndex})`
    ).toBeLessThan(restartAfter.hideIndex)
    await expectEditorVisible(page, OLD_LOG_ID, DRAFT_TEXT, 'after removing leading space via debounce')

    const restartHistoryDelta = restartAfter.historyLength - restartBefore.historyLength
    const restartIndexDelta = restartAfter.historyIndex! - restartBefore.historyIndex!
    expect(
      restartHistoryDelta,
      `history.length delta matches twin (twin=${twinHistoryDelta}, restart=${restartHistoryDelta})`
    ).toBe(twinHistoryDelta)
    expect(
      restartIndexDelta,
      `history.state.index delta matches twin (twin=${twinIndexDelta}, restart=${restartIndexDelta})`
    ).toBe(twinIndexDelta)

    await page.goBack()
    await expect
      .poll(
        async () => {
          const s = await readSlashState()
          return { editorText: s.historyEditorText, index: s.historyIndex }
        },
        { message: 'restart: Back returns to the leading-space query entry', timeout: 10_000 }
      )
      .toEqual({ editorText: SEARCH_QUERY, index: restartBefore.historyIndex })

    expect(sanityErrors, 'toggle and ranking sanity checks stayed silent').toEqual([])
  } finally {
    const cleanup = firestore().batch()
    allIds.forEach(id => cleanup.delete(itemsCol.doc(id)))
    await cleanup.commit()
  }
})

test('Back onto an expanded vs shallow slash query keeps an in-place log unpromoted when restored in view and fires _on_search once', async ({ page }) => {
  const NEEDLE = '/e2e_rslash_needle'
  const SEARCH_QUERY = ` ${NEEDLE}`
  const OLD_LOG_ID = 'e2e_rslash_old_log'
  const OLD_LOG_TEXT = `#log ${NEEDLE} old log for reverse traversal`
  const DRAFT_DEEP = `${OLD_LOG_TEXT} deep`
  const DRAFT_SHALLOW = `${OLD_LOG_TEXT} shallow`
  const LISTENER_ID = 'e2e_rslash_listener'
  const LISTENER_TEXT = [
    `#${LISTENER_ID} #_listen`,
    '```js',
    'function _on_change(text) { (window.__rslashChanges ??= []).push(text) }',
    'function _on_search(text) { (window.__rslashSearches ??= []).push(text) }',
    '```',
  ].join('\n')
  const FILLER_COUNT = 50
  const fillerIds = Array.from({ length: FILLER_COUNT }, (_, i) => `e2e_rslash_filler_${String(i).padStart(2, '0')}`)
  const allIds = [OLD_LOG_ID, LISTENER_ID, ...fillerIds]
  const now = Date.now()
  const batch = firestore().batch()
  const itemsCol = firestore().collection('items')
  // older than all 50 fillers (48..97m ago) so it drops past them when search is disabled, yet within 1d for quick expansion
  batch.set(itemsCol.doc(OLD_LOG_ID), {
    user: 'anonymous',
    time: now - 2 * 3600 * 1000,
    attr: null,
    text: OLD_LOG_TEXT,
  })
  batch.set(itemsCol.doc(LISTENER_ID), {
    user: 'anonymous',
    time: now - 200 * 60_000,
    attr: null,
    text: LISTENER_TEXT,
  })
  fillerIds.forEach((id, i) => {
    batch.set(itemsCol.doc(id), {
      user: 'anonymous',
      time: now - (48 + i) * 60_000,
      attr: null,
      text: `#${id} newer filler item ${String(i).padStart(2, '0')}`,
    })
  })
  await batch.commit()

  const sanityErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() == 'error' && SANITY_ERROR_RE.test(msg.text())) sanityErrors.push(msg.text())
  })

  const readState = () =>
    page.evaluate(
      ([oldLogId, fillerIds]) => {
        const items = (window as any).__items as any[]
        const oldLog = items.find(i => i.id == oldLogId)
        const fillerIndices = fillerIds.map(id => items.findIndex(i => i.id == id)).filter(i => i >= 0)
        return {
          total: items.length,
          hideIndex: (window as any).__hideIndex as number,
          savedHideIndex: (history.state?.hideIndex as number | undefined) ?? null,
          historyEditorText: (history.state?.editorText as string | undefined) ?? null,
          historyFinal: !!history.state?.final,
          minFillerIndex: fillerIndices.length ? Math.min(...fillerIndices) : -1,
          maxFillerIndex: fillerIndices.length ? Math.max(...fillerIndices) : -1,
          oldLog: oldLog
            ? {
                index: oldLog.index as number,
                editing: !!oldLog.editing,
                editingPromoted: !!oldLog.editingPromoted,
                matching: !!oldLog.matching,
              }
            : null,
          changes: [...(((window as any).__rslashChanges as string[] | undefined) ?? [])],
          searches: [...(((window as any).__rslashSearches as string[] | undefined) ?? [])],
        }
      },
      [OLD_LOG_ID, fillerIds] as const
    )

  const finalizeCurrentQuery = async (expectedQuery: string) => {
    await waitForRenderOverlayGone(page)
    const headerTop = await page.evaluate(() => (document.querySelector('.header') as HTMLElement).offsetTop)
    await page.evaluate(y => document.body.scrollTo(0, y), headerTop + 200)
    await expect
      .poll(() => page.evaluate(() => document.body.scrollTop), { message: 'scrolled below header to finalize', timeout: 10_000 })
      .toBeGreaterThan(headerTop + 50)
    await page.keyboard.press('Control+Alt+ArrowUp')
    await expect
      .poll(
        async () => {
          const s = await readState()
          return { editorText: s.historyEditorText, final: s.historyFinal }
        },
        { message: `query "${expectedQuery}" finalized via scroll shortcut`, timeout: 10_000 }
      )
      .toEqual({ editorText: expectedQuery, final: true })
    await waitForRenderOverlayGone(page)
  }

  const resetListenerLogs = async () => {
    await page.evaluate(() => new Promise<void>(r => setTimeout(r, 80)))
    await page.evaluate(() => {
      ;(window as any).__rslashChanges = []
      ;(window as any).__rslashSearches = []
    })
  }

  try {
    await loadAdmin(page)
    await expect
      .poll(
        () =>
          page.evaluate(
            ([ids, listenerId]) =>
              ids.every(id => (window as any).__items.some((i: any) => i.id == id)) &&
              !!(window as any).__items.find((i: any) => i.id == listenerId)?.listen,
            [allIds, LISTENER_ID] as const
          ),
        { message: 'all reverse-traversal fixtures and listener loaded', timeout: 30_000 }
      )
      .toBe(true)

    // 1. Deep reverse traversal: search `/needle`, expand to all rows, finalize, navigate to ` /needle`,
    // open the matched old log in place, then press Back onto the expanded `/needle` view
    await searchMindbox(page, NEEDLE)
    for (let clicks = 0; clicks < 15; clicks++) {
      const s = await readState()
      if ((s.oldLog && s.oldLog.index < s.hideIndex) || s.hideIndex >= s.total) break
      await clickShowMoreRevealsNext(page, `expanding slash view past old log for deep Back (step ${clicks})`)
    }
    const expanded = await readState()
    expect(expanded.oldLog!.index, 'precondition: old log sits below all 50 fillers').toBeGreaterThan(expanded.maxFillerIndex)
    expect(expanded.oldLog!.index, 'precondition: slash view expanded past old log').toBeLessThan(expanded.hideIndex)
    await finalizeCurrentQuery(NEEDLE)
    const deepSaved = await readState()
    expect(
      deepSaved.savedHideIndex,
      'precondition: finalized expanded entry stores hideIndex past old log'
    ).toBeGreaterThan(deepSaved.oldLog!.index)

    await searchMindbox(page, SEARCH_QUERY)
    await openEditorWithDraft(page, OLD_LOG_ID, ' deep', DRAFT_DEEP)
    const beforeDeepBack = await readState()
    expect(beforeDeepBack.oldLog?.matching, 'precondition: old log matches under leading-space query').toBe(true)
    expect(beforeDeepBack.oldLog?.editingPromoted, 'precondition: old log starts unpromoted').toBe(false)
    expect(beforeDeepBack.hideIndex, 'precondition: departed view cutoff is small').toBeLessThan(FILLER_COUNT)

    await resetListenerLogs()
    await page.goBack()
    await expect
      .poll(async () => (await readState()).historyEditorText, { message: 'deep Back returned to slash query', timeout: 10_000 })
      .toBe(NEEDLE)
    await waitForRenderOverlayGone(page)
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 120))))

    const afterDeepBack = await readState()
    expect(afterDeepBack.oldLog?.editing, 'deep Back: old log stays open in edit mode').toBe(true)
    expect(afterDeepBack.oldLog?.editingPromoted, 'deep Back: open log stays not promoted').toBe(false)
    expect(
      afterDeepBack.oldLog!.index,
      `deep Back: open log (${afterDeepBack.oldLog!.index}) stays in time order below fillers (max ${afterDeepBack.maxFillerIndex})`
    ).toBeGreaterThan(afterDeepBack.maxFillerIndex)
    expect(
      afterDeepBack.oldLog!.index,
      `deep Back: open log (${afterDeepBack.oldLog!.index}) stays above restored cutoff (${afterDeepBack.hideIndex})`
    ).toBeLessThan(afterDeepBack.hideIndex)
    await expectEditorVisible(page, OLD_LOG_ID, DRAFT_DEEP, 'after deep Back onto expanded slash view')
    expect(afterDeepBack.changes, 'deep Back: _on_change called once for returned-to query').toEqual([NEEDLE])
    expect(afterDeepBack.searches, 'deep Back: _on_search called once for returned-to query').toEqual([NEEDLE])

    // close the open draft cleanly before the shallow-traversal twin
    await visibleEditContainer(page, OLD_LOG_ID).locator('.edit-menu .button.cancel').click()
    await page.locator('.modal .button.confirm', { hasText: 'Discard' }).click()
    await expect
      .poll(async () => (await readState()).oldLog?.editing, { message: 'deep Back draft discarded', timeout: 10_000 })
      .toBe(false)

    // 2. Shallow reverse traversal: search `/needle` WITHOUT expanding (small saved cutoff), finalize,
    // navigate to ` /needle`, open the old log in place, then press Back onto the shallow `/needle` view
    await searchMindbox(page, `#${fillerIds[0]}`)
    await searchMindbox(page, NEEDLE)
    const shallow = await readState()
    expect(shallow.oldLog!.index, 'precondition: shallow slash view hides old log behind cutoff').toBeGreaterThanOrEqual(
      shallow.hideIndex
    )
    await finalizeCurrentQuery(NEEDLE)
    const shallowSaved = await readState()
    expect(
      shallowSaved.savedHideIndex,
      'precondition: finalized shallow entry stores small hideIndex below old log'
    ).toBeLessThan(shallowSaved.oldLog!.index)

    await searchMindbox(page, SEARCH_QUERY)
    await openEditorWithDraft(page, OLD_LOG_ID, ' shallow', DRAFT_SHALLOW)
    const beforeShallowBack = await readState()
    expect(beforeShallowBack.oldLog?.editingPromoted, 'precondition: old log starts unpromoted for shallow Back').toBe(false)

    await resetListenerLogs()
    await page.goBack()
    await expect
      .poll(async () => (await readState()).historyEditorText, { message: 'shallow Back returned to slash query', timeout: 10_000 })
      .toBe(NEEDLE)
    await waitForRenderOverlayGone(page)
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 120))))

    const afterShallowBack = await readState()
    expect(afterShallowBack.oldLog?.editing, 'shallow Back: old log stays open in edit mode').toBe(true)
    expect(afterShallowBack.oldLog?.editingPromoted, 'shallow Back: hidden open log is promoted').toBe(true)
    expect(
      afterShallowBack.oldLog!.index,
      `shallow Back: promoted log (${afterShallowBack.oldLog!.index}) ranks above fillers (min ${afterShallowBack.minFillerIndex})`
    ).toBeLessThan(afterShallowBack.minFillerIndex)
    expect(
      afterShallowBack.oldLog!.index,
      `shallow Back: promoted log (${afterShallowBack.oldLog!.index}) stays above cutoff (${afterShallowBack.hideIndex})`
    ).toBeLessThan(afterShallowBack.hideIndex)
    await expectEditorVisible(page, OLD_LOG_ID, DRAFT_SHALLOW, 'after shallow Back onto unexpanded slash view')
    expect(afterShallowBack.changes, 'shallow Back: _on_change called once for returned-to query').toEqual([NEEDLE])
    expect(afterShallowBack.searches, 'shallow Back: _on_search called once for returned-to query').toEqual([NEEDLE])
    expect(sanityErrors, 'toggle and ranking sanity checks stayed silent').toEqual([])
  } finally {
    const cleanup = firestore().batch()
    allIds.forEach(id => cleanup.delete(itemsCol.doc(id)))
    await cleanup.commit()
  }
})
