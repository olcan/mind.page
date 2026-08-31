import { expect, test, type Page } from '@playwright/test'
import { firestore, loadAdmin, waitForApp } from './helpers.js'

// editor flows driven by keyboard and mouse, as admin on the anonymous account: creating items from
// the mindbox, searching and url state, tag navigation and history, editing items in place, undelete
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const mindbox = (page: Page) => page.locator('#textarea-mindbox')
// the textarea is hidden behind a backdrop until focused; users click the backdrop (see Editor.svelte)
async function focusMindbox(page: Page) {
  await page.locator('.header .backdrop').first().click()
  await expect(mindbox(page)).toBeFocused()
}
const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)
const itemText = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.text ?? null, name)
// names of the items currently shown, in order (the rest are hidden past hideIndex)
const visible = (page: Page) =>
  page.evaluate(() => window.__items.slice(0, window.__hideIndex).map(item => item.labelText ?? ''))

test('typing in the mindbox and pressing shift+enter creates an item', async ({ page }) => {
  await loadAdmin(page)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_typed created via keyboard')
  await page.keyboard.press('Shift+Enter') // create, once the modifier is released (see Editor.svelte)
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_typed'))).toBe(true)
  await expect(mindbox(page)).toHaveValue('#e2e_typed ') // the new item's label stays as the search
  await expect.poll(() => savedId(page, '#e2e_typed'), { timeout: 30_000 }).toBeTruthy()
  expect(await itemText(page, '#e2e_typed')).toBe('#e2e_typed created via keyboard')
})

test('failed _tests rank, border, and log with dedup; relog after a healthy interval', async ({ page }) => {
  // issues/MindPage Failed Tests Pop Items Up With No Error Indication (reviews 192):
  // failed _tests in an item's global store rank it as an error on every mindbox
  // change but rendered no border and logged nothing. Now the dedicated failedTests
  // flag drives the red border AND exactly one deduped console.error summary per item
  // (base + alias entries normalized to ONE canonical stripped identity) plus one
  // captured-log replay -- cleared on all-pass so the SAME set failing again relogs.
  await loadAdmin(page)
  const name = '#e2e_failed_tests'
  const errors: string[] = []
  page.on('console', msg => {
    if (msg.type() == 'error' && msg.text().includes(name)) errors.push(msg.text())
  })
  await page.evaluate(text => void window._create(text), `${name}\nan item with stale failed tests`)
  // the PRODUCTION shape (tester.js): base result under the STRIPPED name, a
  // per-function alias entry carrying test:'_test_thing', both sharing get_log's
  // FORMATTED-STRING array
  const setTests = (ok: boolean, line: string) =>
    page.evaluate(([name, ok, line]) => {
      const gs = (window._item(name as string, true) as any).global_store
      gs._tests = {
        thing: { ms: 5, ok, log: [line] },
        thing_helper: { ms: 5, ok, log: [line], test: '_test_thing' },
      }
    }, [name, ok, line] as const)
  await setTests(false, "ERROR: test 'thing' FAILED in 5ms")
  await focusMindbox(page)
  const settle = async () => {
    await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false)).toBe(true)
  }
  await mindbox(page).fill('stale failed tests')
  await settle()
  await expect
    .poll(() => page.evaluate(name => {
      const item = (window.__items as any[]).find(i => i.labelText == name)
      return item && { failedTests: !!item.failedTests, hasError: !!item.hasError }
    }, name))
    .toMatchObject({ failedTests: true, hasError: true })
  // the red border: the container carries both error and bordered classes
  await expect
    .poll(() => page.evaluate(name => !!window._item(name, true)?.elem?.querySelector('.container.error.bordered'), name), { message: 'container carries the error class' })
    .toBe(true)
  // EXACTLY one summary + one replay: base and alias collapse to ONE canonical
  // identity, and the shared log is replayed once
  await expect.poll(() => errors.length).toBe(2)
  expect(errors[0]).toContain('1 failed test')
  expect(errors[0]).toContain('thing')
  expect(errors[0]).not.toContain('thing_helper')
  expect(errors[0]).not.toContain('_test_thing')
  expect(errors[1]).toContain("test 'thing' captured log")
  expect(errors[1]).toContain("ERROR: test 'thing' FAILED in 5ms")
  // dedup: further mindbox passes re-rank but do NOT re-log
  await mindbox(page).fill('stale failed')
  await settle()
  expect(errors.length).toBe(2)
  // tests pass -> the ranking input and border clear, error count unchanged
  await setTests(true, "ERROR: test 'thing' FAILED in 5ms")
  await mindbox(page).fill('stale failed tests')
  await settle()
  await expect
    .poll(() => page.evaluate(name => {
      const item = (window.__items as any[]).find(i => i.labelText == name)
      return item && { failedTests: !!item.failedTests, hasError: !!item.hasError }
    }, name))
    .toMatchObject({ failedTests: false, hasError: false })
  await expect
    .poll(() => page.evaluate(name => !!window._item(name, true)?.elem?.querySelector('.container.error'), name))
    .toBe(false)
  expect(errors.length).toBe(2)
  // the SAME canonical set fails again after the healthy interval: the memo was
  // cleared, so the second run logs again with the new captured line (review 192 §2.2)
  await setTests(false, "ERROR: test 'thing' FAILED in 7ms (second run)")
  await mindbox(page).fill('stale failed')
  await settle()
  await expect.poll(() => errors.length).toBe(4)
  expect(errors[3]).toContain('FAILED in 7ms (second run)')
  await mindbox(page).fill('')
  await page.keyboard.press('Escape')
})

test('searching filters items and puts the tag in the url; escape and shift+backspace clear', async ({ page }) => {
  await loadAdmin(page)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_typed')
  // the search is debounced while the editor is focused; a tag that exists becomes the url hash
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_typed')
  expect(await visible(page)).toContain('#e2e_typed') // shown with the pinned items, which rank first
  expect(await page.evaluate(() => window.__items.filter(item => item.matching).map(item => item.labelText))).toEqual([
    '#e2e_typed',
  ])
  // a command is cleared by escape (plain text is only blurred)
  await mindbox(page).fill('/e2e_not_a_command')
  await page.keyboard.press('Escape')
  await expect(mindbox(page)).toHaveValue('')
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('')
  // shift+backspace clears the search text
  await focusMindbox(page)
  await mindbox(page).pressSequentially('zzz no such item')
  await expect.poll(() => page.evaluate(() => window.__items.filter(item => item.matching).length)).toBe(0)
  await page.keyboard.press('Shift+Backspace')
  await expect(mindbox(page)).toHaveValue('')
})

test('clicking a tag navigates to it, and the browser back button returns', async ({ page }) => {
  await loadAdmin(page)
  await page.evaluate(() => {
    void window._create('#e2e_target the target')
    void window._create('#e2e_source refers to #e2e_target')
  })
  await expect.poll(() => savedId(page, '#e2e_source'), { timeout: 30_000 }).toBeTruthy()
  // items past hideIndex are not rendered, so search for the source item first
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_source')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  // tags render as <mark title="#tag"> with a mousedown handler (see _handleTagClick in Item.svelte)
  await page.locator(`#item-${sourceId} mark[title="#e2e_target"]`).click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ') // tag searches get a trailing space
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#e2e_target')
  await expect.poll(() => visible(page)).toContain('#e2e_target')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#e2e_source')
})

test('an item is edited in place with shift+enter, and escape discards an edit', async ({ page }) => {
  await loadAdmin(page)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_typed') // bring the item into view
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_typed')!.elem), { timeout: 10_000 }).toBe(true)
  const id = await page.evaluate(() => window._item('#e2e_typed')!.id)
  const textarea = page.locator(`#textarea-${id}`)
  // a click on the item text opens its editor: mid-paragraph, past the label (a tag) and clear of the
  // item menu widget in the top-right corner
  const paragraph = page.locator(`#item-${id} p`).first()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  await expect(textarea).toBeVisible()
  await expect(textarea).toHaveValue('#e2e_typed created via keyboard')
  await textarea.press('ControlOrMeta+a')
  await textarea.pressSequentially('#e2e_typed edited via keyboard')
  await page.keyboard.press('Shift+Enter') // save
  await expect(textarea).toBeHidden()
  await expect.poll(() => itemText(page, '#e2e_typed')).toBe('#e2e_typed edited via keyboard')
  await expect
    .poll(async () => (await firestore().collection('items').doc(id).get()).data()?.text, { timeout: 30_000 })
    .toBe('#e2e_typed edited via keyboard')
  // escape asks before discarding unsaved changes, once the item is no longer saving (a save in
  // progress discards silently), so wait for the client to have processed the save
  await expect
    .poll(
      () =>
        page.evaluate(id => {
          const item = window.__items.find(item => item.id == id)!
          return !item.saving && item.savedText
        }, id),
      { timeout: 30_000 }
    )
    .toBe('#e2e_typed edited via keyboard')
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  await expect(textarea).toBeVisible()
  await textarea.press('End')
  await textarea.pressSequentially(' DISCARDED')
  await page.keyboard.press('Escape')
  await expect(page.getByText(/Discard unsaved changes to #e2e_typed/)).toBeVisible()
  await page.locator('.modal .button.confirm', { hasText: 'Discard' }).click()
  await expect(textarea).toBeHidden()
  expect(await itemText(page, '#e2e_typed')).toBe('#e2e_typed edited via keyboard')
})

test('/_undelete restores the last deleted item', async ({ page }) => {
  await loadAdmin(page)
  await page.evaluate(() => window._item('#e2e_source')!.delete(false))
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_source'))).toBe(false)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('/_undelete')
  await page.keyboard.press('Shift+Enter')
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_source'))).toBe(true)
  await expect.poll(() => savedId(page, '#e2e_source'), { timeout: 30_000 }).toBeTruthy()
  expect(await itemText(page, '#e2e_source')).toBe('#e2e_source refers to #e2e_target')
})

test('attr changes reach the changed item and #_listen listeners, never bystanders', async ({ page }) => {
  // regression for itemAttrChanged (index.svelte): its guard compared item.id to itself, so every
  // item defining _on_attr_change ran on any attr change, and each received its OWN id instead of
  // the changed item's id
  await loadAdmin(page)
  const block = (kind: string) =>
    '```js\nfunction _on_attr_change(id, remote) { (window.__attr_calls ??= []).push([' +
    `'${kind}'` +
    ", id]) }\n```"
  await page.evaluate(
    ([target, listener, other]) => {
      void window._create('#e2e_attr_target\n' + target)
      void window._create('#e2e_attr_listener #_listen\n' + listener)
      void window._create('#e2e_attr_other\n' + other)
    },
    [block('self'), block('listener'), block('other')] as const
  )
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_attr_other'))).toBe(true)
  const target_id = await page.evaluate(() => {
    const item = window._item('#e2e_attr_target')!
    item.share('e2e_attr') // updates attr.shared via _update_attr_async -> itemAttrChanged
    return item.id as string
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).__attr_calls ?? []), { timeout: 15_000 })
    .toEqual(
      expect.arrayContaining([
        ['self', target_id],
        ['listener', target_id],
      ])
    )
  const calls: [string, string][] = await page.evaluate(() => (window as any).__attr_calls)
  expect(calls.filter(call => call[0] == 'other'), 'bystanders must not run').toEqual([])
  expect(calls.every(call => call[1] == target_id), 'all calls receive the changed id').toBe(true)
})

test('an expired live element is torn down exactly once when its replacement renders', async ({ page }) => {
  // pins the retired-node lifecycle (see invalidateElemCache/reapRetiredElems in util.js): cache
  // invalidation on a LIVE element must not destroy it in place (it stays functional), and the
  // re-render that replaces it must run its _destroy teardown exactly once per generation
  await loadAdmin(page)
  const text = [
    '#e2e_lifecycle',
    '```_html',
    '<div id="lc-$id" _cache_key="lc-$id"><script>',
    "const elem = document.getElementById('lc-$id')",
    "elem.setAttribute('_destroy', '')",
    'elem._destroy = () => { window.__destroys = (window.__destroys ?? 0) + 1 }',
    '</script>ok</div>',
    '```',
  ].join('\n')
  await page.evaluate(text => void window._create(text), text)
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_lifecycle'))).toBe(true)
  await page.evaluate(() => void (location.hash = '#e2e_lifecycle')) // render it (creates open in the editor)
  await expect
    .poll(() => page.evaluate(() => !!window._item('#e2e_lifecycle')?.elem?.querySelector('[_cache_key]')), {
      timeout: 15_000,
    })
    .toBe(true)
  expect(await page.evaluate(() => (window as any).__destroys ?? 0)).toBe(0)
  // invalidate with a forced render: the live element is retired, stays in place until the
  // replacement renders, then is destroyed exactly once
  await page.evaluate(() => (window._item('#e2e_lifecycle') as any).invalidate_elem_cache({ force_render: true, render_delay: 0 }))
  await expect.poll(() => page.evaluate(() => (window as any).__destroys ?? 0), { timeout: 15_000 }).toBe(1)
  // the next generation tears down once more — once per element, never double
  await page.evaluate(() => (window._item('#e2e_lifecycle') as any).invalidate_elem_cache({ force_render: true, render_delay: 0 }))
  await expect.poll(() => page.evaluate(() => (window as any).__destroys ?? 0), { timeout: 15_000 }).toBe(2)
  await page.waitForTimeout(2_000)
  expect(await page.evaluate(() => (window as any).__destroys)).toBe(2) // and stays there
})

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

test('images loading in small steps still trigger a layout within seconds', async ({ page }) => {
  // regression: item heights grow as each image loads, but each step stays under the 300px
  // relayout threshold — with only per-event deltas checked, no layout ran until an unrelated
  // pass (the periodic time-string update) 10+ seconds later, which is how a shared page could
  // take that long to wrap into its second column. the trigger now also fires on cumulative
  // drift from the height the LAST layout used (see onItemResized/updateItemLayout)
  const svg = (n: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160"><rect width="400" height="160" fill="#8cf"/><text x="10" y="80">${n}</text></svg>`
  await page.route(/\/e2e-grow-(\d)\.svg/, async route => {
    const n = route.request().url().match(/e2e-grow-(\d)/)![1]
    await new Promise(resolve => setTimeout(resolve, 1000 + 400 * Number(n))) // staggered loads
    await route.fulfill({ contentType: 'image/svg+xml', body: svg(n) })
  })
  await loadAdmin(page)
  await page.evaluate(() =>
    window._create('#e2e_growth staggered images\n![](/e2e-grow-1.svg)\n![](/e2e-grow-2.svg)\n![](/e2e-grow-3.svg)')
  )
  await page.evaluate(() => void (location.hash = '#e2e_growth')) // navigate to it so it renders
  // the item renders at its image-less height first (each image adds 160px only when it loads)
  await expect.poll(() => page.evaluate(() => window._item('#e2e_growth')?.elem?.offsetHeight ?? 0)).toBeGreaterThan(0)
  const before = await page.evaluate(() => (window as any).__layoutCount as number)
  // all three images load between ~1.4s and ~2.2s after creation, each step under the per-event
  // threshold; a layout pass must still follow within a few seconds, not after the 10s fallback
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_growth')?.elem?.offsetHeight ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(3 * 160)
  const heightSettledAt = Date.now()
  await expect
    .poll(() => page.evaluate(() => (window as any).__layoutCount as number), { timeout: 5_000 })
    .toBeGreaterThan(before)
  expect(Date.now() - heightSettledAt).toBeLessThan(5_000)
  // ... and the DOM must agree with what that layout computed: the layout mutates item.column
  // without assigning items, so without an explicit invalidation the columns it assigns are only
  // rendered when something else happens to invalidate them (up to 10s later, at the periodic
  // time-string pass) — the delayed column wrap seen on shared pages
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const items = (window as any).__items as { id: string; column: number; index: number }[]
          const hideIndex = (window as any).__hideIndex as number
          return items
            .filter(item => item.index < hideIndex)
            .every(item => {
              const div = document.querySelector('#super-container-' + item.id)
              const column = div ? [...document.querySelectorAll('.column')].indexOf(div.parentElement!) : -1
              return !div || column == item.column
            })
        }),
      { timeout: 3_000 } // well under the 10s periodic pass
    )
    .toBe(true)
})

test('the run button works on an installed item whose input blocks are all hidden', async ({ page }) => {
  // reported bug (issues/MindPage Run Button Crash on Installed Agent Items.md): the `runnable`
  // flag that SHOWS the button accepts hidden/removed input blocks, but the installed-item run
  // path extracted inputs with a stricter regex — so `match` returned null and `.join` threw an
  // uncaught TypeError. every installed #agent/chat/* provider is exactly this shape: its only
  // block is js_input_removed
  await loadAdmin(page)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.evaluate(() =>
    window._create(['#e2e_hidden_input hidden-only input', '```js_input_removed', '1 + 1', '```'].join('\n'))
  )
  await expect.poll(() => savedId(page, '#e2e_hidden_input'), { timeout: 30_000 }).toBeTruthy()
  // mark it INSTALLED the way /_install does — in the stored document — then reload so the app
  // loads it as an installed item (attr.source is what selects the run path under test)
  const id = await savedId(page, '#e2e_hidden_input')
  await firestore()
    .collection('items')
    .doc(id!)
    .update({ attr: { source: 'https://github.com/olcan/mind.items/blob/master/e2e.md' } })
  await page.reload()
  await waitForApp(page)
  await page.evaluate(() => void (location.hash = '#e2e_hidden_input')) // bring it up so it renders
  // NOTE: .button.run lives in .item-menu, a SIBLING of .item — not inside it
  const run = page.locator('.button.run')
  await expect(run).toHaveCount(1, { timeout: 30_000 }) // only this item is runnable
  await run.click()
  // the run item is created from the hidden input, and nothing throws
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_hidden_input/run')), { timeout: 30_000 }).toBe(true)
  expect(errors.filter(e => e.includes('TypeError'))).toEqual([])
  // the copied block keeps ONE suffix: normalizing an already-hidden block must not produce
  // js_input_removed_removed
  const runText = await page.evaluate(() => window._item('#e2e_hidden_input/run', true)?.text ?? '')
  expect(runText).toContain('js_input_removed')
  expect(runText).not.toContain('_removed_removed')
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
  // click the plain text (mid-paragraph is inside the long plain prefix, clear of the links)
  const paragraph = page.locator(`#item-${id} p`).first()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
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
    // the invalid-image fixtures must not outlive this row (review 135 §3.4): the editor
    // account feeds the dependent bridge lane, where this page-scoped route no longer exists
    // and the items would issue real storage requests
    badimg ??= await savedId(page, '#e2e_badimg').catch(() => null)
    slowimg ??= await savedId(page, '#e2e_slowimg').catch(() => null)
    for (const id of [badimg, slowimg]) if (id) await firestore().collection('items').doc(id).delete().catch(() => {})
  }
})
