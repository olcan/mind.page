import { expect, test } from '@playwright/test'
import { mindbox, focusMindbox, savedId, itemText, visible } from './editor_helpers.js'
import { firestore, loadAdmin, waitForApp } from './helpers.js'

// editor flows driven by keyboard and mouse, as admin on the anonymous account: creating items from
// the mindbox, searching and url state, tag navigation and history, editing items in place, undelete
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

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

test('a transitive missing dependency logs one diagnostic at the red border; clears and relogs', async ({ page }) => {
  // src/item_errors.ts at Item.svelte's dom inspection seam: the macro expansion deliberately
  // keeps `eval missing dependencies` out of the console (a DIRECT missing dependency is marked
  // visibly), so a dependency's OWN missing dependency left the root red with no render-time
  // diagnostic, only the background reader's later line (the #chat/fable install, 2026-09-05). Now the rendered causes are read where the border is
  // decided and logged once per item; recovery forgets the item so a recurrence logs again.
  await loadAdmin(page)
  const root = '#e2e_dep_root'
  const diagnostics: string[] = []
  page.on('console', msg => {
    if (msg.type() == 'error' && msg.text().includes(`[${root}] error indication`)) diagnostics.push(msg.text())
  })
  // the dependency exists and is unique; ITS hidden dependency does not exist
  await page.evaluate(text => void window._create(text), '#e2e_dep_dep #_e2e_dep_absent\nthe dependency')
  await page.evaluate(text => void window._create(text), `${root} #_e2e_dep_dep\nroot with a macro <<1+1>>`)
  const bordered = () =>
    page.evaluate(root => !!window._item(root, true)?.elem?.querySelector('.container.error.bordered'), root)
  await expect.poll(bordered, { timeout: 30_000 }).toBe(true)
  await expect.poll(() => diagnostics.length).toBe(1)
  expect(diagnostics[0]).toContain('macro error: eval missing dependencies: e2e_dep_absent')
  expect(diagnostics[0]).toContain('dependencies can be transitive')
  // repeated mindbox passes re-rank and re-inspect but do NOT re-log
  await focusMindbox(page)
  await mindbox(page).fill('root with a macro')
  await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false)).toBe(true)
  expect(diagnostics.length).toBe(1)
  // the missing dependency arrives: the root re-expands, the border clears, nothing is logged
  await page.evaluate(text => void window._create(text), '#e2e_dep_absent\nnow present')
  await expect.poll(bordered, { timeout: 30_000 }).toBe(false)
  expect(diagnostics.length).toBe(1)
  // it disappears again: the SAME failure logs again (the item was forgotten on recovery)
  await page.evaluate(() => void window._item('#e2e_dep_absent', true)?.delete(false))
  await expect.poll(bordered, { timeout: 30_000 }).toBe(true)
  await expect.poll(() => diagnostics.length).toBe(2)
  expect(diagnostics[1]).toContain('eval missing dependencies: e2e_dep_absent')
  // leave no red-bordered items behind: error-ranked items pop on every mindbox change and
  // would shift the layout under later rows of this shared account
  for (const name of [root, '#e2e_dep_dep']) {
    await page.evaluate(name => void window._item(name, true)?.delete(false), name)
  }
  await expect.poll(() => page.evaluate(root => !!window._item(root, true), root)).toBe(false)
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
