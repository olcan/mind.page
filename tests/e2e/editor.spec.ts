import { expect, test, type Page } from '@playwright/test'
import { firestore, loadAdmin } from './helpers.js'

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
    await page.evaluate(() => {
      const item = window._item('#e2e_xtab')!
      for (const n of [1, 2, 3, 4]) item.write(`burst ${n}`)
    })
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
    await page.waitForTimeout(3_000) // let every echo, deferred change and queued save settle
    // the invariant that matters is that what each tab SHOWS matches what the backend HOLDS: a
    // deferred change must not be applied under an unsettled local write (whose queued save
    // would then persist the rollback), and a deferred change must not be silently dropped —
    // each tab reconciles against the server once its own intent settles
    const serverText = async () => {
      const id = await savedId(page, '#e2e_xtab')
      return (await firestore().collection('items').doc(id!).get()).data()?.text ?? null
    }
    for (const tab of [page, other])
      await expect
        .poll(async () => (await itemText(tab, '#e2e_xtab')) == (await serverText()), { timeout: 30_000 })
        .toBe(true)
    expect(await serverText()).toMatch(/overlap [AB]/)
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
