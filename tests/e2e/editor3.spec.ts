import { expect, test, type Page } from '@playwright/test'
import { asUser, mindbox, focusMindbox, savedId, userSet, visible, createNavigationItems, scrollTop, headerTop, entries, scrollDown, nearTop, asSet, expand, focusMindboxInPlace, blur, noWritePending, settled, historyReads } from './editor_helpers.js'
import { firestore, loadAdmin, waitForApp } from './helpers.js'

// the editor suite's rows from Down with two modifiers to the stops, on a lane of their own
// (playwright.config.ts: `editor3`; cut from editor.spec.ts on 2026-11-21, so that no editor lane sets the
// gate's length): Down with two modifiers, Back and Forward across a reload, and the stops. Serial over the
// lane's seeded anonymous account, as there: the rows build on each other's items and on the navigation
// row's, which the first row here creates
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

// the items of editor.spec.ts's navigation row, which rows of this lane name (#e2e_source, #e2e_target and
// #e2e_target/sub): created first, as that row creates them
test("setup: the navigation row's items, created as editor.spec.ts creates them", async ({ page }) => {
  await createNavigationItems(page)
})

test('down with two modifiers undoes a scroll to the top: Back to the position when the previous entry shows the same query below, nothing otherwise', async ({ page }) => {
  // the owner's inverse (2026-10-03): Up with two modifiers pushes the top entry (the row above); Down goes
  // Back when Back would scroll DOWN within the same query: the cursor returns to the previous entry without
  // adding one (the top entry stays reachable by Forward). Nothing when no entry sits below the position,
  // when the page scrolled past the position since the Up, or when the previous entry shows another query
  // (an arrow never changes the query, a typed query still debouncing included: review 0 B1); a second
  // press before the popstate lands is ignored; Up and Down in one turn work
  await loadAdmin(page)
  const expanded = await expand(page)
  const [length, index] = await entries(page)
  const up = () => page.keyboard.press('Control+Meta+ArrowUp')
  const down = () => page.keyboard.press('Control+Meta+ArrowDown')
  const atPosition = (y: number, message: string) =>
    expect.poll(async () => Math.abs((await scrollTop(page)) - y) <= 2, { message }).toBe(true)
  // from the window: Up then Down lands back at the position without a new entry (the length kept, Forward
  // still holding the top entry; the index back), nothing focused, the expanded items kept
  const pos = await scrollDown(page)
  await blur(page)
  await up()
  await nearTop(page, 'scrolled to the top')
  expect(await entries(page)).toEqual([length + 1, index + 1])
  await down()
  await atPosition(pos, 'back at the position')
  expect(await entries(page)).toEqual([length + 1, index])
  await expect(mindbox(page), 'the MindBox not focused').not.toBeFocused()
  expect(asSet(await visible(page))).toEqual(asSet(expanded))
  // no entry below the position: another Down changes nothing
  await down()
  await page.waitForTimeout(300)
  expect(await entries(page)).toEqual([length + 1, index])
  await atPosition(pos, 'still at the position')
  // the page scrolled past the position since the Up: Back would scroll up, so nothing
  await up()
  await nearTop(page, 'at the top again')
  expect(await entries(page)).toEqual([length + 1, index + 1])
  await page.evaluate(y => document.body.scrollTo(0, y), pos + 100)
  await expect.poll(() => scrollTop(page), { message: 'scrolled past the position' }).toBeGreaterThan(pos + 50)
  const past = await scrollTop(page)
  await down()
  await page.waitForTimeout(300)
  expect(await entries(page)).toEqual([length + 1, index + 1])
  await atPosition(past, 'still past the position')
  // another query since: the previous entry (the top entry, its position written below the new query's)
  // shows a different text, so nothing: the query and the entries stay
  await noWritePending(page)
  expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index].scrollPosition), 'the top entry holds the position scrolled to').toBeGreaterThan(pos + 50)
  await focusMindboxInPlace(page)
  await page.keyboard.type('#e2e')
  await expect.poll(() => entries(page), { message: 'the typed query pushed its entry' }).toEqual([length + 2, index + 2])
  // at the top of the new query: its entry is no Up's (and its text another), so Down does nothing
  await page.evaluate(y => document.body.scrollTo(0, y), await headerTop(page))
  await nearTop(page, 'at the top of the typed query')
  await down()
  await page.waitForTimeout(300)
  await expect(mindbox(page)).toHaveValue('#e2e')
  expect(await entries(page)).toEqual([length + 2, index + 2])
  // in the MindBox, on that query: Up then Down, the focus and the text kept
  const pos2 = await scrollDown(page)
  await focusMindboxInPlace(page, 4)
  await up()
  await nearTop(page, 'scrolled to the top from the MindBox')
  expect(await entries(page)).toEqual([length + 3, index + 3])
  await down()
  await atPosition(pos2, 'back at the position from the MindBox')
  expect(await entries(page)).toEqual([length + 3, index + 2])
  await expect(mindbox(page)).toBeFocused()
  await expect(mindbox(page)).toHaveValue('#e2e')
  // two Downs in one browser turn go back ONCE: the second lands before the popstate of the first and is
  // ignored (the pending guard), so the history walks one entry, not two
  await blur(page)
  await up()
  await nearTop(page, 'at the top before the double press')
  const before = await entries(page)
  await page.evaluate(() => {
    const press = () => new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(press())
    document.body.dispatchEvent(press())
  })
  await atPosition(pos2, 'back at the position once')
  await page.waitForTimeout(300)
  expect(await entries(page)).toEqual([before[0], before[1] - 1])
  await expect(mindbox(page)).toHaveValue('#e2e')
  // from an item editor: the editor keeps the focus through Up and Down, the page back at the position.
  // (The query is cleared at the top with the MindBox focused first: Playwright will not fill the
  // unfocused MindBox, whose textarea it reports as not visible)
  await up()
  await nearTop(page, 'at the top to clear the query')
  await focusMindboxInPlace(page)
  await mindbox(page).fill('')
  await expect.poll(() => mindbox(page).inputValue()).toBe('')
  // the Backs restored the entries' smaller show-more cut (onPopState keeps the larger of the query's default
  // and the entry's hideIndex): expand again so the newest item renders below the pinned ones
  await expand(page)
  const backText = '#e2e_back ' + Array.from({ length: 40 }, (_, i) => `back ${i + 1}`).join('\n\n')
  await page.evaluate(text => void window._create(text), backText)
  await expect.poll(() => savedId(page, '#e2e_back'), { timeout: 30_000 }).toBeTruthy()
  const id = await page.evaluate(() => window._item('#e2e_back', true)!.id)
  await expect.poll(() => page.evaluate(id => !!document.querySelector(`#item-${id} p`), id), { timeout: 15_000, message: 'the fixture renders among the expanded items' }).toBe(true)
  const paragraph = page.locator(`#item-${id} p`).first()
  await paragraph.scrollIntoViewIfNeeded()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  await expect(page.locator(`#textarea-${id}`)).toBeFocused()
  await page.evaluate(y => document.body.scrollTo(0, y), (await headerTop(page)) + 600)
  await expect.poll(() => scrollTop(page), { message: 'scrolled with the editor open' }).toBeGreaterThan((await headerTop(page)) + 300)
  const pos3 = await scrollTop(page)
  const [length4, index4] = await entries(page)
  await page.keyboard.press('Control+Alt+ArrowUp')
  await nearTop(page, 'scrolled to the top from the editor')
  expect(await entries(page)).toEqual([length4 + 1, index4 + 1])
  await expect(page.locator(`#textarea-${id}`)).toBeFocused()
  await page.keyboard.press('Control+Alt+ArrowDown')
  await atPosition(pos3, 'back at the position from the editor')
  await page.waitForTimeout(300) // whatever the restore scheduled; the assertions below are the check
  await atPosition(pos3, 'still at the position once the restore settled')
  expect(await entries(page)).toEqual([length4 + 1, index4])
  await expect(page.locator(`#textarea-${id}`), 'the editor keeps the focus').toBeFocused()
  await page.keyboard.press('Escape') // nothing edited: the editor closes
  await expect(page.locator(`#textarea-${id}`)).toBeHidden()
  // the quick combo: Up and Down dispatched in ONE browser turn (the owner: "a quick up-down combo should
  // work"): Up writes its predecessor and pushes the top entry synchronously, so the Down right after it
  // finds the pair; the page ends back at the position with the index where it started
  const pos4 = await scrollDown(page)
  await blur(page)
  const [, index5] = await entries(page)
  await page.evaluate(() => {
    const press = (key: string) => new KeyboardEvent('keydown', { key, code: key, metaKey: true, altKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(press('ArrowUp'))
    document.body.dispatchEvent(press('ArrowDown'))
  })
  await atPosition(pos4, 'back at the position after Up and Down in one turn')
  await page.waitForTimeout(300)
  // the Up truncated the Forward entry the editor part's Back had left, then pushed: the length is the
  // index plus two whatever it was before
  expect(await entries(page)).toEqual([index5 + 2, index5])
  // a query typed and still debouncing (review 0 B1): its live text is not in the entry yet, so a Down in the
  // same turn, with the entries still a qualifying pair (the top entry over the same query below), must NOT
  // go Back (Back would have restored the old query and discarded the typing); the typed text survives and
  // the debounce then records it in an entry of its own
  await up()
  await nearTop(page, 'at the top before typing')
  await focusMindboxInPlace(page)
  const [, index6] = await entries(page)
  const typed = await page.evaluate(() => {
    const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
    t.value = '#e2e pending'
    t.dispatchEvent(new Event('input', { bubbles: true }))
    const w = window as any
    const before = { pending: w._editor_change_pending as boolean, recorded: w._history[w._history_index].editorText as string, index: w._history_index as number }
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true }))
    return before
  })
  expect(typed, 'the precondition held in the turn: the query debouncing, the entry still the old text').toEqual({ pending: true, recorded: '', index: index6 })
  await page.waitForTimeout(300)
  // no Back: the index never drops below the top entry's (the debounce, 500 ms with the MindBox focused,
  // may already have pushed the typed query's own entry above it)
  expect((await entries(page))[1], 'no Back').toBeGreaterThanOrEqual(index6)
  await expect(mindbox(page), 'the typed text survives').toHaveValue('#e2e pending')
  await expect.poll(() => page.evaluate(() => (window as any)._history[(window as any)._history_index].editorText), { message: 'the debounce recorded the typed query' }).toBe('#e2e pending')
  await expect(mindbox(page)).toHaveValue('#e2e pending')
})

test('down with two modifiers, when Back does not apply, scrolls to the item the query names as a tag click does, with a history entry; nothing otherwise', async ({ page }) => {
  // the owner's fallback (2026-10-04): the query names an item (the listing item, the one a tag click
  // lands on) out of view, below or above: Down brings it to the upper middle of the view, as the tag
  // click's last step does, with an entry so Back returns to the position; the query, the caret, the
  // focus and the entries' texts stay. In view: nothing. The jump's entry is no Back candidate (Down undoes
  // an Up alone, the Back row), so a further Down does nothing and a scroll by hand brings the fallback again.
  // A short view, where the destination can equal the position: no entry (review 0 B1). A typed query not
  // yet applied: nothing (review 0 B2). A query naming no item: nothing. Each fallback press asserts its
  // premise, that Back does not apply (the previous entry another text, or a position not below)
  await loadAdmin(page)
  const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n\n')
  // the named item, tall, with two tall children under its tag, so the query's page scrolls well past it
  await page.evaluate(body => void window._create(`#e2e_named ${body}`), body)
  for (const n of ['p', 'q']) await page.evaluate(([n, body]) => void window._create(`#e2e_named/${n} ${body}`), [n, body] as const)
  await expect.poll(() => savedId(page, '#e2e_named/q'), { timeout: 30_000 }).toBeTruthy()
  const id = await page.evaluate(() => window._item('#e2e_named', true)!.id)
  const targeted = () =>
    expect.poll(() => page.evaluate(id => !!document.querySelector(`.super-container.target #item-${id}`), id), { timeout: 15_000 }).toBe(true)
  const down = () => page.keyboard.press('Control+Meta+ArrowDown')
  const up = () => page.keyboard.press('Control+Meta+ArrowUp')
  const atPosition = (y: number, message: string) =>
    expect.poll(async () => Math.abs((await scrollTop(page)) - y) <= 2, { message }).toBe(true)
  // the tag click's destination: the item's top less a quarter of the view, no higher than the header
  const destination = () =>
    page.evaluate(() => {
      const target = document.querySelector('.super-container.target') as HTMLElement
      return Math.max((document.querySelector('.header') as HTMLElement).offsetTop, target.offsetTop - visualViewport!.height / 4)
    })
  const targetTop = () => page.evaluate(() => (document.querySelector('.super-container.target') as HTMLElement).offsetTop)
  // the item below the view's lower band (the tag click's rule)
  const below = () => page.evaluate(() => (document.querySelector('.super-container.target') as HTMLElement).offsetTop > document.body.scrollTop + visualViewport!.height - 200)
  // the premise of a fallback press: Back does not apply (scrollBackWithHistory's test: the current entry an
  // Up's, the page still at its top)
  const noBack = () =>
    page.evaluate(() => {
      const w = window as any
      const current = w._history[w._history_index]
      const header = (document.querySelector('.header') as HTMLElement).offsetTop
      return !current?.scrolledToTop || document.body.scrollTop > header + 2
    })
  const selection = () =>
    page.evaluate(() => {
      const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      return [t.value, t.selectionStart, t.selectionEnd]
    })
  // the query from a fresh history: another query, Up (a final entry), then the query, pushed after it, so
  // the previous entry is another text and Back cannot apply whatever the positions
  // the app's bottom padding (0.85 of the view's height) follows a view change only while nothing is focused
  // (updateVerticalPadding under the resize handler, two unfocused passes), and shifts the position when it
  // does: settle it after a view change, before any position is measured
  const settleView = async (height: number) => {
    await blur(page)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            window.dispatchEvent(new Event('resize'))
            return parseFloat((document.querySelector('.items') as HTMLElement).style.paddingBottom || '0')
          }),
        { message: 'the padding follows the view', timeout: 10_000 }
      )
      .toBeCloseTo(0.85 * height, 0)
    await noWritePending(page)
  }
  const freshQuery = async () => {
    await focusMindboxInPlace(page)
    await mindbox(page).fill('#e2e_named/q')
    await expect.poll(() => page.evaluate(() => (window as any)._history[(window as any)._history_index].editorText), { timeout: 10_000 }).toBe('#e2e_named/q')
    await scrollDown(page)
    await up()
    await nearTop(page, 'a final entry at the top of the other query')
    await focusMindboxInPlace(page)
    await mindbox(page).fill('#e2e_named')
    await targeted()
    await expect.poll(() => page.evaluate(() => (window as any)._history[(window as any)._history_index].editorText), { timeout: 10_000 }).toBe('#e2e_named')
    expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index - 1].editorText), 'the previous entry is the other query').toBe('#e2e_named/q')
  }
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_named')
  await targeted()
  // the query's own layout scrolls to its item a few frames after the render, later on the full gate's
  // busier page (a Down before it landed scrolled to the item itself, with an entry, 2026-10-28): the item
  // in view and the position at rest for 200 ms before the premise is read
  const inView = () =>
    page.evaluate(() => {
      const top = (document.querySelector('.super-container.target') as HTMLElement).offsetTop
      return top >= document.body.scrollTop && top <= document.body.scrollTop + visualViewport!.height - 200
    })
  await expect
    .poll(
      async () => {
        const y = await scrollTop(page)
        await page.waitForTimeout(200)
        return (await inView()) && (await scrollTop(page)) == y
      },
      { timeout: 15_000, message: 'the item in view, the position at rest' }
    )
    .toBe(true)
  await noWritePending(page)
  const [length, index] = await entries(page)
  // in view (the query's own layout scrolled to its item; the item sits below the pinned items), the previous
  // entry another query: Down changes nothing
  const settled = await scrollTop(page)
  await focusMindboxInPlace(page, 4)
  expect(await noBack()).toBe(true)
  await down()
  await page.waitForTimeout(300)
  expect(await entries(page)).toEqual([length, index])
  await atPosition(settled, 'still where the query settled')
  // the item BELOW the view: from the top of the query's page, Down brings it to the upper middle with one
  // entry whose predecessor holds the top; the previous entry sits above, so the next Down is no Back
  // (the alternation holds after an upward jump alone) and, the item in view, nothing
  await page.evaluate(y => document.body.scrollTo(0, y), await headerTop(page))
  await nearTop(page, 'at the top of the query')
  await noWritePending(page)
  expect([await below(), await noBack()], 'the item below the view, no Back').toEqual([true, true])
  const dest = await destination()
  await down()
  await atPosition(dest, 'at the item, from above')
  expect(await entries(page)).toEqual([length + 1, index + 1])
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index), 'the top, kept in the previous entry').toBe(await headerTop(page))
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index + 1), 'the destination in the new entry').toBe(dest)
  expect(await page.evaluate(i => (window as any)._history[i].editorText, index + 1)).toBe('#e2e_named')
  expect(await selection(), 'the text and caret stay').toEqual(['#e2e_named', 4, 4])
  await expect(mindbox(page)).toBeFocused()
  expect(await noBack(), 'no Back after a downward jump').toBe(true)
  await down()
  await page.waitForTimeout(300)
  await atPosition(dest, 'still at the item: the item in view')
  expect(await entries(page)).toEqual([length + 1, index + 1])
  // scrolled PAST the item: Down brings it back up with an entry (the browser's Back returns to the position);
  // the entry is no Up's, so the next Down does nothing with the item in view (no toggle: the owner,
  // 2026-10-04); scrolled up by hand past the item, Down brings it back down, again with an entry
  const top = await targetTop()
  await page.evaluate(y => document.body.scrollTo(0, y), top + 400)
  await expect.poll(() => scrollTop(page), { message: 'scrolled past the item' }).toBeGreaterThan(top + 300)
  await noWritePending(page)
  const pos = await scrollTop(page)
  expect(await noBack(), 'no Back from past the item').toBe(true)
  await down()
  await atPosition(dest, 'at the item, as a tag click lands')
  expect(await entries(page)).toEqual([length + 2, index + 2])
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index + 1), 'the position left, kept in the previous entry').toBe(pos)
  expect(await noBack(), 'no Back after the jump: its entry is no Up\'s').toBe(true)
  await down()
  await page.waitForTimeout(300)
  await atPosition(dest, 'still at the item: no toggle')
  expect(await entries(page)).toEqual([length + 2, index + 2])
  await page.evaluate(y => document.body.scrollTo(0, y), await headerTop(page))
  await nearTop(page, 'scrolled up by hand, past the item')
  await noWritePending(page)
  expect([await below(), await noBack()], 'the item below the view, no Back').toEqual([true, true])
  await down()
  await atPosition(dest, 'at the item again, from above')
  expect(await entries(page)).toEqual([length + 3, index + 3])
  expect(await page.evaluate(i => (window as any)._history[i].scrollPosition, index + 2), 'the top, kept in the previous entry').toBe(await headerTop(page))
  // Back comes first: after Up, Down returns to the position Up left, not to the item; scrolled away from
  // that top by hand, the undo is gone and Down follows the fallback (the item below: to it, with an entry)
  await noWritePending(page)
  const pos2 = await scrollDown(page)
  expect(Math.abs(pos2 - dest), 'the position differs from the destination').toBeGreaterThan(50)
  await up()
  await nearTop(page, 'scrolled to the top')
  expect(await entries(page)).toEqual([length + 4, index + 4])
  expect(await noBack(), 'Back applies at the top of an Up').toBe(false)
  await down()
  await atPosition(pos2, 'Back to the position, not to the item')
  expect(await entries(page)).toEqual([length + 4, index + 3])
  await up()
  await nearTop(page, 'scrolled to the top again')
  await page.evaluate(y => document.body.scrollTo(0, y), (await headerTop(page)) + 60)
  await expect.poll(() => scrollTop(page), { message: 'scrolled away from the top by hand' }).toBeGreaterThan((await headerTop(page)) + 40)
  await noWritePending(page)
  expect([await below(), await noBack()], 'the item below the view, the undo gone').toEqual([true, true])
  await down()
  await atPosition(dest, 'at the item: the fallback, not Back')
  expect(await entries(page)).toEqual([length + 5, index + 5])
  // the jump's entry is never an Up's (review 0 B1): Up, then a 60 px scroll by hand and Down in ONE turn
  // (before the listener's write), so the fallback clones the still-marked Up entry; its entry carries no
  // mark, and back at the top by hand Down jumps to the item again instead of going Back to header + 60
  await up()
  await nearTop(page, 'at the top once more')
  const marked = await page.evaluate(() => (window as any)._history[(window as any)._history_index].scrolledToTop === true)
  expect(marked, "the Up's entry carries its mark").toBe(true)
  const marks = await page.evaluate(header => {
    const w = window as any
    document.body.scrollTo(0, header + 60)
    const before = w._history[w._history_index].scrolledToTop
    document
      .getElementById('textarea-mindbox')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true }))
    return { before, after: w._history[w._history_index].scrolledToTop, index: w._history_index }
  }, await headerTop(page))
  await atPosition(dest, 'at the item, from 60 px below the top in the same turn')
  expect(await entries(page), "the Up's entry and the jump's").toEqual([length + 7, index + 7])
  expect([marks.before, marks.after, marks.index], "the Up's entry marked, the jump's entry unmarked, in the key's turn").toEqual([true, false, index + 7])
  await noWritePending(page)
  await page.evaluate(y => document.body.scrollTo(0, y), await headerTop(page))
  await nearTop(page, 'back at the top by hand')
  await noWritePending(page)
  await down()
  await atPosition(dest, 'the item again, not Back to header + 60')
  expect(await entries(page)).toEqual([length + 8, index + 8])
  // a departure by hand ENDS the undo (review 0 B2): Up, a 60 px scroll by hand, the listener's write (the
  // mark cleared), back to the top by hand: Down is no Back to the position Up left but the fallback
  await up()
  await nearTop(page, 'at the top for the departure')
  await page.evaluate(header => document.body.scrollTo(0, header + 60), await headerTop(page))
  await expect.poll(() => scrollTop(page), { message: 'departed by hand' }).toBeGreaterThan((await headerTop(page)) + 40)
  await noWritePending(page)
  expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index].scrolledToTop), "the Up's mark cleared by the departure").toBe(false)
  await page.evaluate(y => document.body.scrollTo(0, y), await headerTop(page))
  await nearTop(page, 'back at the top by hand after the departure')
  await noWritePending(page)
  expect(await noBack(), 'the undo is gone').toBe(true)
  const [lengthD, indexD] = await entries(page)
  await down()
  await atPosition(dest, 'the fallback, not the position Up left')
  expect(await entries(page)).toEqual([lengthD + 1, indexD + 1])
  // a departure and a return both seen by the listener BEFORE its position write (review 1 B2 of
  // scroll_target2): the scroll events dispatched in one turn; the entry's mark is cleared at the departure
  // event itself, and Down in that turn is the fallback, its entry pushed, never a Back
  await up()
  await nearTop(page, 'at the top for the quick departure')
  const indexA = (await entries(page))[1] // the Up's entry, revisited below
  const quick = await page.evaluate(header => {
    const w = window as any
    const scroll = (y: number) => {
      document.body.scrollTo(0, y)
      document.body.dispatchEvent(new Event('scroll'))
    }
    scroll(header + 60)
    scroll(header)
    const mark = w._history[w._history_index].scrolledToTop
    const before = [w._history.length, w._history_index, document.body.scrollTop]
    document
      .getElementById('textarea-mindbox')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true }))
    return { mark, before, after: [w._history.length, w._history_index] }
  }, await headerTop(page))
  expect(quick.mark, 'the mark cleared at the departure event, before any position write').toBe(false)
  expect(quick.before[2], 'back at the top when the key arrived').toBeLessThanOrEqual((await headerTop(page)) + 2)
  expect(quick.after, 'the fallback pushed its entry, no Back').toEqual([quick.before[0] + 1, quick.before[1] + 1])
  await atPosition(dest, 'the fallback, from the top, after a departure and return in one turn')
  // the cleared mark belongs to the entry (review 2 B2 of scroll_target2): a later Up, then the browser's Back
  // twice, through the jump's entry back to the departed Up entry at its top: Down is the fallback, its entry
  // pushed (the cursor advances; a Back would have moved it down), not a return to the position that Up left
  await noWritePending(page)
  await up()
  await nearTop(page, 'a later Up')
  await page.goBack()
  await atPosition(dest, "Back to the jump's entry")
  await page.goBack()
  await nearTop(page, 'Back to the departed Up entry at its top')
  await noWritePending(page)
  expect(await page.evaluate(() => [(window as any)._history_index, (window as any)._history[(window as any)._history_index].scrolledToTop]), 'the departed entry revisited, its mark cleared').toEqual([indexA, false])
  await down()
  await atPosition(dest, 'the fallback from the revisited entry')
  expect(await entries(page), 'its entry pushed over the forward entries').toEqual([indexA + 2, indexA + 1])
  // the same departure and return, then the position write: the mark stays cleared, Down the fallback
  await noWritePending(page)
  await up()
  await nearTop(page, 'at the top for the persisted departure')
  await page.evaluate(header => {
    const scroll = (y: number) => {
      document.body.scrollTo(0, y)
      document.body.dispatchEvent(new Event('scroll'))
    }
    scroll(header + 60)
    scroll(header)
  }, await headerTop(page))
  await noWritePending(page)
  expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index].scrolledToTop), 'the mark cleared, through the write').toBe(false)
  const [lengthQ, indexQ] = await entries(page)
  await down()
  await atPosition(dest, 'the fallback after the persisted departure')
  expect(await entries(page)).toEqual([lengthQ + 1, indexQ + 1])
  // a query naming no item (a term the tall items carry): a long page, no target, so Down changes nothing
  await focusMindboxInPlace(page)
  await mindbox(page).fill('line')
  await expect.poll(() => page.evaluate(() => window.__items.filter(item => item.matching).length), { timeout: 10_000 }).toBeGreaterThan(2)
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.super-container.target')), { message: 'no target under the term', timeout: 10_000 }).toBe(false)
  await noWritePending(page)
  const pos3 = await scrollDown(page)
  const before = await entries(page)
  await down()
  await page.waitForTimeout(300)
  await atPosition(pos3, 'still at the position')
  expect(await entries(page)).toEqual(before)
  await expect(mindbox(page)).toHaveValue('line')
  // a SHORT view (review 0 B1): the in-view rule's lower band and the destination's quarter disagree there,
  // so at the destination the item still counts as below the view and the destination is the position: Down
  // moves nothing and pushes nothing (the precondition asserted, so an ordinary in-view no-op cannot stand in)
  await freshQuery()
  const size = page.viewportSize()!
  await page.setViewportSize({ width: size.width, height: 240 })
  await settleView(240)
  await focusMindboxInPlace(page)
  const top2 = await targetTop()
  await page.evaluate(y => document.body.scrollTo(0, y), top2 - 300)
  await expect.poll(() => scrollTop(page), { message: 'above the item in the short view' }).toBeLessThan(top2 - 200)
  await noWritePending(page)
  expect([await below(), await noBack()], 'the item below the short view, no Back').toEqual([true, true])
  const [length3, index3] = await entries(page)
  const dest3 = await destination()
  await down()
  await atPosition(dest3, 'at the item in the short view')
  expect(await entries(page)).toEqual([length3 + 1, index3 + 1])
  expect(await below(), 'the item still counts as below the short view at the destination').toBe(true)
  expect(Math.abs((await destination()) - (await scrollTop(page))), 'the destination is the position').toBeLessThanOrEqual(2)
  expect(await noBack(), 'no Back (the position left lies above)').toBe(true)
  await down()
  await page.waitForTimeout(300)
  await atPosition(dest3, 'unmoved')
  expect(await entries(page), 'no entry for a destination that is the position').toEqual([length3 + 1, index3 + 1])
  await page.setViewportSize(size)
  await settleView(size.height)
  // a typed query not yet applied (review 0 B2), the old target off screen: the input and Down in one browser
  // turn; the shortcut neither scrolls nor touches the history (the text guard), and the typed query then
  // settles with its own entry. The target is measured AFTER the view's restore (the padding's 408 px moved
  // it: review 1 B2, the row's third cut scrolled past a stale top and left the item in view), and the
  // premises are read in the same turn as the key: the target still the old item, above the position, its
  // destination well away from it, so the guard alone keeps the page
  const top3 = await targetTop()
  await page.evaluate(y => document.body.scrollTo(0, y), top3 + 400)
  await expect.poll(() => scrollTop(page), { message: 'past the item' }).toBeGreaterThan(top3 + 300)
  await noWritePending(page)
  const posP = await scrollTop(page)
  const [lengthP, indexP] = await entries(page)
  const typed = await page.evaluate(id => {
    const t = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
    t.focus({ preventScroll: true })
    t.setRangeText('/p', t.value.length, t.value.length, 'end')
    t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '/p' }))
    const w = window as any
    const pending = w._mindboxDebounced === true
    const recorded = w._history[w._history_index].editorText
    const target = document.querySelector('.super-container.target') as HTMLElement
    const scrollTop = document.body.scrollTop
    const destination = Math.max((document.querySelector('.header') as HTMLElement).offsetTop, target.offsetTop - visualViewport!.height / 4)
    const premises = {
      oldTarget: !!target.querySelector(`#item-${id}`),
      above: target.offsetTop < scrollTop,
      destinationAway: Math.abs(destination - scrollTop) > 50,
    }
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true, bubbles: true, cancelable: true }))
    return { pending, recorded, premises, live: t.value, scrollTop: document.body.scrollTop, length: w._history.length, index: w._history_index }
  }, id)
  expect(typed.premises, 'the old target, above the position, its destination away from it').toEqual({ oldTarget: true, above: true, destinationAway: true })
  expect(typed.pending, 'the query was still debouncing when the key arrived').toBe(true)
  expect([typed.recorded, typed.live], 'the entry holds the old text, the MindBox the new').toEqual(['#e2e_named', '#e2e_named/p'])
  expect([typed.scrollTop, typed.length, typed.index], 'the shortcut scrolled nothing and touched no entry').toEqual([posP, lengthP, indexP])
  await expect.poll(() => page.evaluate(() => (window as any)._history[(window as any)._history_index].editorText), { message: 'the typed query settled', timeout: 10_000 }).toBe('#e2e_named/p')
  await expect(mindbox(page)).toHaveValue('#e2e_named/p')
})

// BACK AND FORWARD ACROSS A RELOAD (the owner, 2026-11-17: after a reload, Back and Forward onto the entries
// from before it logged the history handler's warnings, and the page did not follow). The browser keeps
// those entries across a reload, each with its state object and its index, while the page starts a new
// session: one that numbered its entries from 0 again read the kept ones as its own by their old indexes,
// warned (an out-of-bounds index, an inconsistent state, the current index), stayed where it was and
// overwrote each entry it landed on with a copy of one of its own. The session continues at the kept entry's
// index instead, and takes an entry it does not know as the browser holds it. Two reloads: on the first view
// with two entries ahead of it (a reload there writes nothing, so Forward still has them), then on an
// item's view (the reloaded page writes its first view and the address's query over the kept entry since
// 2026-11-19: until then it pushed both after it).
// Every entry reached shows its own query and its own scroll position, each position set by hand so that no
// two entries share one. The items are the navigation row's
test('Back and Forward across a reload reach the entries from before it, each with its query and its scroll position, and the history handler warns of nothing', async ({ page }) => {
  const { recorded, place, shows } = historyReads(page)

  await loadAdmin(page)
  const top = await headerTop(page)
  await nearTop(page, 'the page loads at the header')
  // two entries after the first view's, a query and a position each: a typed query, then a tag click from its item
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_source')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  await blur(page)
  await place(40)
  const [, index] = await entries(page) // the typed query's entry; the first view's is the one before it
  // the tag is brought into view before its click (a click's own scroll would move the page under the
  // entry being left, whose position is whatever was recorded last)
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  const tag = page.locator(`#item-${sourceId} mark[title="#e2e_target"]`)
  await tag.scrollIntoViewIfNeeded()
  await recorded()
  const atSource = await scrollTop(page)
  await tag.click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  const atTarget = await place(80)
  expect(await entries(page), 'the tag click pushed its entry').toEqual([index + 2, index + 1])
  expect(Math.min(atSource - top, Math.abs(atSource - atTarget)), 'three positions, none near another').toBeGreaterThan(30)
  await page.goBack()
  await shows('#e2e_source', atSource, 'Back within the session')
  await page.goBack()
  await shows('', top, 'Back to the first view')
  await recorded()

  // (1) a reload on the first view: the page starts on the entry the browser kept and writes nothing (the
  // same query and order), so the two entries ahead are still there
  await page.reload()
  await waitForApp(page)
  await shows('', top, 'the reloaded page is at the header')
  expect(await page.evaluate(() => history.state.index), 'the reloaded page is on the kept entry').toBe(index - 1)
  await page.goForward()
  await shows('#e2e_source', atSource, 'Forward onto an entry from before the reload')
  expect(await page.evaluate(() => location.hash)).toBe('#e2e_source')
  expect(await entries(page), 'the session continued at the kept index').toEqual([index + 1, index])
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward onto the next one')
  await page.goBack()
  await shows('#e2e_source', atSource, 'Back in the reloaded session')
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward again')
  await recorded()

  // (2) a reload on an item's view (a tag click's entry): the reloaded page writes its first view and the
  // address's query over the kept entry, which shows the query again, and adds none (until 2026-11-19 it
  // pushed both after the kept entry: two entries more, Back first showed the first view, then the kept
  // entry); Back reaches the entries from before the two reloads
  await page.reload()
  await waitForApp(page)
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await recorded()
  expect(await entries(page), 'the session continued at the kept index, and added nothing').toEqual([index + 2, index + 1])
  expect(await page.evaluate(() => [history.state.editorText, history.state.final]), 'the kept entry shows the query again, still final').toEqual(['#e2e_target ', true])
  await page.goBack()
  await shows('#e2e_source', atSource, 'Back onto the entry before the one the page was reloaded on')
  await page.goBack()
  await shows('', top, 'Back to the first view')
  expect(await entries(page), 'every entry in its place').toEqual([index + 2, index - 1])
})

// the entries of the two startup rows below, over the navigation row's items: the first view, a typed query,
// a tag click's entry left 400 px below the header, and a second typed query (it names an item and is not
// final); `index` is the first query's entry
const threeQueries = async (page: Page, { recorded, place }: ReturnType<typeof historyReads>) => {
  await loadAdmin(page)
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_source')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  await blur(page)
  const [, index] = await entries(page) // the first query's entry
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  const tag = page.locator(`#item-${sourceId} mark[title="#e2e_target"]`)
  await tag.scrollIntoViewIfNeeded()
  await recorded()
  await tag.click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  const atTarget = await place(400) // far enough from the header to tell the entry's position from a return there
  // the last query is set as a todo's row sets one, from a blurred box: it applies at once (a typed query
  // waits out its debounce with the box focused, the page scrolls to it meanwhile and the scroll listener
  // records that position on the entry being left: 640 for an entry left at 672, the reading of review 1)
  await userSet(page, '#e2e_target/sub')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_target/sub')
  await recorded()
  const atSub = await scrollTop(page)
  expect(await entries(page), "the second query's entry, pushed after the tag click's").toEqual([index + 3, index + 2])
  expect(await page.evaluate(i => [(window as any)._history[i].scrollPosition, (window as any)._history[i + 1].final], index + 1), "the tag click's entry keeps the position it was left at; the last entry is not final").toEqual([atTarget, false])
  return { index, atTarget, atSub }
}

// BACK WHILE A RELOADED PAGE IS STILL STARTING (review 1 of scroll_history, 2026-11-17). The browser moves at
// once; the page can apply nothing yet. The session took its index when the page was created and the
// handler returned before initialization, so the startup wrote the first view over the entry REACHED under
// the index of the entry LEFT, dropped the entries ahead, and pushed the departed entry's fragment: from
// then on a history link's distance was off. The session takes its place from the entry the browser is on
// when the corpus is ready, writes nothing over an entry reached this way, and applies its view once
// initialized. Four entries (the first view, a typed query, a tag click's, a typed query again), a reload
// on the last one with the index build stalled (the app's seam, `_initialize_stall_ms`), Back during the
// stall; then the entries ahead and behind, and the list above the header: its link to the first query is
// a jump of two entries
test('Back while a reloaded page is still starting shows the entry it reaches once the page is ready, keeps the entries ahead, and a history link lands on the entry it names', async ({ page }) => {
  const reads = historyReads(page)
  const { warnings, shows } = reads
  const { index, atTarget, atSub } = await threeQueries(page, reads)

  // the reload on the last entry, its index build stalled; Back while the page is still starting
  // every position the page is asked to scroll to is noted beside the app, from the reloaded page's start
  await page.addInitScript(() => {
    window._initialize_stall_ms = 3_000
    const asked: number[] = ((window as any).__asked = [])
    const scrollTo = Element.prototype.scrollTo as (...args: any[]) => void
    Element.prototype.scrollTo = function (this: Element, ...args: any[]) {
      if (this === document.body) asked.push(typeof args[0] == 'object' ? args[0].top : args[1])
      return scrollTo.apply(this, args)
    }
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => window._init_time > 0)).toBe(true)
  await page.goBack()
  await expect(page.locator('#sapper > .loading'), 'Back arrived before the page was initialized').toHaveClass(/visible/)
  await waitForApp(page)
  // where the entry was left, 400 px below the header: the page was ASKED for that position (the saved value
  // came through the wait: a scroll write built on the live state object, then not written, changes what
  // the replay reads to the starting page's own position, review 2) and stands there, not at the header and
  // not at the item the query names, where every layout of a starting page scrolls
  await shows('#e2e_target ', atTarget, 'the entry Back reached, shown once the page was ready, where it was left')
  expect(await page.evaluate(() => (window as any).__asked.map(Math.round)), 'the page was asked for the position the entry was left at').toContain(atTarget)
  expect(await page.evaluate(() => [history.state.index, location.hash]), "the browser's entry is the one reached, as it was").toEqual([index + 1, '#e2e_target'])
  expect(await entries(page), 'the session is on that entry').toEqual([index + 2, index + 1])
  // the entries ahead and behind are where they were
  await page.goForward()
  await shows('#e2e_target/sub', atSub, 'Forward: the entry the page was reloaded on, kept')
  await page.goBack()
  await shows('#e2e_target ', atTarget, 'Back')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward')
  await page.goForward()
  await shows('#e2e_target/sub', atSub, 'Forward again')
  // the list above the header names the two earlier queries; the link to the first one is two entries back
  const links = page.locator('.history-item')
  await expect(links).toHaveText(['#e2e_source', '#e2e_target'])
  await links.first().click()
  await expect(mindbox(page), 'the link lands on the entry it names').toHaveValue('#e2e_source')
  expect(await page.evaluate(() => [history.state.index, (window as any)._history_index])).toEqual([index, index])
  await page.goForward()
  await expect(mindbox(page), 'one entry ahead of it').toHaveValue('#e2e_target ')
  expect(warnings).toEqual([])
})

// BACK BETWEEN A RELOADED PAGE'S INITIALIZATION AND ITS LAUNCH FRAGMENT (review 2 of scroll_history,
// 2026-11-17). The launch's fragment is handled after the page is initialized, once the welcome is over and
// the frames after it have passed. A reload on a query that names an item, its entry not final, replaces
// that entry with the first view and keeps the address's fragment for that later step; Back in between was
// restored by the ordinary handler, and the step then pushed the departed entry's query over the entry
// reached and dropped the entry ahead. A traversal that the page follows now drops the pending fragment.
// The step and the welcome work after it wait for the row's release (the app's seam,
// `_launch_fragment_gate`; `_launch_fragment_done` marks the step). The entry reached stays WHERE IT WAS LEFT
// through the layouts that applying its query causes (review 3: restored at 1012 px, the page stood at the
// item the query names, 418 px on, a few seconds later, and the scroll listener recorded that over the
// entry's position).
// Then A NATIVE FRAGMENT NAVIGATION (review 3), as `location.hash` makes one: the browser adds a position of
// its own, and the handler added a second one after it for the query the fragment names (a link then landed
// on the position between); for a fragment that names nothing the old links stayed and the next scroll write
// copied the entry onto the position. The named query now takes the browser's position, as the first entry
// of a new run; an unnamed fragment's position holds no entry, like a rejected one
test("Back after a reloaded page is initialized and before its launch fragment is handled shows the entry reached, keeps it where it was left and keeps the entry ahead; a native fragment navigation takes the browser's own position under a new numbering, and one that names nothing is no entry's", async ({ page }) => {
  const reads = historyReads(page)
  const { warnings, shows, recorded } = reads
  const errors: string[] = [] // a fragment's decoding error, should one reach the page
  page.on('pageerror', error => void (/URI/.test(String(error)) && errors.push(String(error))))
  const { index, atTarget, atSub } = await threeQueries(page, reads)
  const top = await headerTop(page)
  const length = await page.evaluate(() => history.length)
  const links = page.locator('.history-item') // the list above the header
  // no layout for a second: the layouts that applying a query causes (its items rendering) have run
  const quiet = async () => {
    let last = -1
    await expect
      .poll(
        async () => {
          const now = await page.evaluate(() => (window as any).__layoutCount as number)
          const still = now === last
          last = now
          return still
        },
        { message: 'the layouts have run', intervals: [1_000], timeout: 30_000 }
      )
      .toBe(true)
  }
  await page.addInitScript(() => void ((window as any)._launch_fragment_gate = new Promise<void>(resolve => void ((window as any)._release_launch_fragment = resolve))))
  const browserKey = () => page.evaluate(() => (window as any).navigation.currentEntry.key as string)
  const reloadedOn = await browserKey()
  await page.reload()
  await waitForApp(page)
  const step = () => page.evaluate(() => (window as any)._launch_fragment_done === true)
  await shows('', top, 'the reloaded page: its first view, the fragment of its address not handled yet')
  await page.goBack()
  await shows('#e2e_target ', atTarget, 'the entry Back reached, where it was left')
  expect(await step(), "the launch's fragment had not been handled").toBe(false)
  await page.evaluate(() => (window as any)._release_launch_fragment())
  await expect.poll(step, { message: "the launch's fragment step has run" }).toBe(true)
  // settled: the layouts of the restored query have run and the scroll listener has written
  await quiet()
  await recorded()
  await shows('#e2e_target ', atTarget, "still the entry reached, where it was left: the departed entry's fragment was dropped, and no layout of its query moved the page")
  expect(
    await page.evaluate(i => [history.state.index, history.state.editorText, history.state.scrollPosition, (window as any)._history[i].scrollPosition, history.length], index + 1),
    'no entry was pushed, and the entry holds the position it was left at'
  ).toEqual([index + 1, '#e2e_target ', atTarget, atTarget, length])
  // THE ENTRY AHEAD IS THE ONE THE PAGE WAS RELOADED ON, AS IT WAS (review 0 of phantom_steps, blocker 3): its
  // address names an item, so the launch left it alone while its first view showed (the query is applied
  // later, once, and the Back above superseded it), and Forward lands on the same position and restores the
  // query it stores, where it was left. Until then the launch wrote its first view over the entry, and Forward
  // restored the empty list
  const stored = () => page.evaluate(() => [history.state.index, history.state.editorText, history.state.final])
  await page.goForward()
  await shows('#e2e_target/sub', atSub, 'Forward: the entry the page was reloaded on, the query it stores restored where it was left')
  expect([await browserKey(), await stored(), await page.evaluate(() => history.length)], 'the same position, its entry as it was').toEqual([reloadedOn, [index + 2, '#e2e_target/sub', false], length])
  // the same on a FINAL entry with entries on both sides (the tag click's): a reload there, a change no user
  // action triggered while the first view shows (written nowhere: the entry is kept), Back, the release, Forward
  const gated = async (message: string) => {
    await page.reload()
    await waitForApp(page)
    await shows('', top, `${message}: the reloaded page shows its first view, the address's query not applied yet`)
    expect(await step(), `${message}: the launch's query is pending`).toBe(false)
  }
  const release = async () => {
    await page.evaluate(() => (window as any)._release_launch_fragment())
    await expect.poll(step, { message: "the launch's fragment step has run" }).toBe(true)
    await settled(page)
  }
  await page.goBack()
  await shows('#e2e_target ', atTarget, "Back onto the tag click's entry")
  await recorded()
  const finalKey = await browserKey()
  await gated('a reload on a final entry')
  await page.evaluate(() => void (window._item(window.__items[window.__items.length - 1].id) as any).touch())
  await settled(page)
  expect([await browserKey(), await stored()], 'the entry is kept as it was while the first view shows, through a passive re-ranking').toEqual([finalKey, [index + 1, '#e2e_target ', true]])
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await release()
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward after the release: the reloaded entry, its stored query restored where it was left')
  expect([await browserKey(), await stored()], 'the same position, its entry as it was').toEqual([finalKey, [index + 1, '#e2e_target ', true]])
  // TYPING ON AN ENTRY THAT IS NOT FINAL while the query is pending (the position and the index stay the same):
  // the typed query replaces the entry's, and the release does not put the address's query back over it
  await page.goForward()
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')
  await recorded()
  await gated('a reload on an entry that is not final')
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_source')
  await expect.poll(stored, { message: 'the typed query, in the entry the page was reloaded on', timeout: 10_000 }).toEqual([index + 2, '#e2e_source', false])
  await blur(page)
  await release()
  const here = async (query: string, message: string) => expect([await browserKey(), await stored(), await mindbox(page).inputValue()], message).toEqual([reloadedOn, [index + 2, query, false], query])
  await here('#e2e_source', 'the typed query stays through the release, on the same position')
  // THE ITEMS CHANGE BETWEEN THE PAGE'S START AND THE RELEASE (review 1 of phantom_steps, blocker 3). First an
  // address that names NO item when the page starts (put on the entry by the row), the user's query while it is
  // pending, and the item arriving before the release (written behind the app, as a sync brings one): the
  // query is the user's still (resolvable only by then, the address was applied over their choice)
  await recorded()
  await page.evaluate(() => history.replaceState(history.state, '', location.pathname + location.search + '#e2e_late'))
  await gated('a reload on an address that names no item yet')
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_target/sub')
  await expect.poll(stored, { message: "the user's query, in the entry the page was reloaded on", timeout: 10_000 }).toEqual([index + 2, '#e2e_target/sub', false])
  await blur(page)
  const late = await firestore().collection('items').add({ user: 'anonymous', time: Date.now(), attr: null, text: '#e2e_late an item that arrives after the page has started' })
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_late')), { message: 'the item the address names has arrived', timeout: 30_000 }).toBe(true)
  await release()
  await here('#e2e_target/sub', "the user's query stays through the release, though the address names an item by then")
  // the other way round: the address names an item when the page starts (the query typed for it), and the item
  // is gone by the release (deleted behind the app). The view shown, the first view, is written over the entry
  // (left alone, the entry held a query that the box did not show)
  await focusMindbox(page)
  await mindbox(page).fill('#e2e_late')
  await expect.poll(() => page.evaluate(() => [history.state.editorText, location.hash]), { timeout: 10_000 }).toEqual(['#e2e_late', '#e2e_late'])
  await blur(page)
  await recorded()
  await gated('a reload on an address whose item is deleted meanwhile')
  await late.delete()
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_late')), { message: 'the item the address names is gone', timeout: 30_000 }).toBe(false)
  await release()
  await here('', 'the entry holds the view shown, the first view, on the same position and not final as before')
  // A SELECTION OF THE USER'S WHILE THE QUERY IS PENDING supersedes it (a real click on the number of the first
  // item of the temporary first view, which selects it): its entry is pushed after the kept one, and the
  // release leaves it alone (applied afterwards, the address's query was written over the entry the user had
  // just made, and Back could not recover their choice)
  await page.goBack()
  await shows('#e2e_target ', atTarget, "Back onto the tag click's entry")
  await recorded()
  await gated('a second reload on the final entry')
  // (pressed where it stands: the first number that is in view and on top at its own middle; the driver's own
  // click scrolls its target first, and the first item's number cannot be brought into view at the header)
  const number = await page.evaluate(() => {
    for (const el of document.querySelectorAll('.column:not(.hidden) .container[data-item-id] .button.index')) {
      const r = el.getBoundingClientRect()
      const [x, y] = [r.x + r.width / 2, r.y + r.height / 2]
      if (r.width > 0 && r.top > 0 && r.bottom < innerHeight && document.elementFromPoint(x, y) === el) return [x, y]
    }
    return null
  })
  expect(number, "premise: an item's number is in view on the temporary first view").toBeTruthy()
  await page.mouse.click(number![0], number![1])
  await expect.poll(async () => (await browserKey()) != finalKey, { message: "the click's own entry", timeout: 10_000 }).toBe(true)
  const [chosenKey, chosen] = [await browserKey(), await mindbox(page).inputValue()]
  expect(chosen, 'premise: the click selected an item').not.toBe('')
  await release()
  expect([await browserKey(), await stored(), await mindbox(page).inputValue()], "the user's entry stays theirs through the release").toEqual([chosenKey, [index + 2, chosen, true], chosen])
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  const kept = async (message: string) => expect([await browserKey(), await stored(), await mindbox(page).inputValue()], message).toEqual([finalKey, [index + 1, '#e2e_target ', true], '#e2e_target '])
  await kept('Back recovers the reloaded entry as it was')
  // BACK PAST THE FIRST ENTRY THE APP CAN TAKE while the launch keeps its entry (review 1, blocker 3): the entry
  // behind is rewritten as older code wrote one, so Back onto it stops and the browser returns to the kept
  // entry. The page never showed that entry's view (the first view stood over it), so the return RESTORES it:
  // the box and the entry agree after the release, and a passive re-ranking leaves the stored query alone
  // (taken for a view already shown, the box stayed empty over the entry, and the re-ranking wrote the empty
  // query over it)
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await recorded()
  await asOlderCode(page)
  const olderKey = await browserKey() // (the position the app cannot take: the stops below land on it)
  await page.goForward()
  await shows('#e2e_target ', atTarget, "Forward onto the tag click's entry, an entry of older code behind it")
  await recorded()
  await gated('a third reload on the final entry')
  await blur(page)
  await page.goBack()
  await expect(note(page), 'the note of a stop after Back').toHaveText('nothing to go back to')
  await passNote(page)
  await shows('#e2e_target ', atTarget, 'the stop returned to the reloaded entry and restored it: its query, where it was left')
  await release()
  await kept('after the release: the visible query, the stored one and the position')
  await page.evaluate(() => void (window._item(window.__items[window.__items.length - 1].id) as any).touch())
  await settled(page)
  await kept('after a passive re-ranking: the same')
  // A NATIVE FRAGMENT THAT NAMES NOTHING, WHILE THE LAUNCH KEEPS ITS ENTRY, then a jump back past that entry onto
  // the position the app cannot take (review 2 of phantom_steps, blocker 2). The fragment takes no entry and the
  // page still shows the temporary first view, so the launch's entry stays kept, and the stop's return restores
  // it (unkept by the fragment, the return took its view for shown: the box stayed empty over the entry, and a
  // passive re-ranking then wrote the empty query over it)
  await recorded()
  await gated('a fourth reload on the final entry')
  await page.evaluate(() => void (location.hash = '#e2e_no_such_item'))
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state)), { message: "the fragment's own position, its marker" }).toBe(JSON.stringify({ owner: 'admin|anonymous|', unknown: true, fragment: true }))
  await page.evaluate(() => history.go(-2))
  await expect(note(page), 'the note of a stop after the jump').toHaveText('nothing to go back to')
  await passNote(page)
  await shows('#e2e_target ', atTarget, 'the stop returned to the reloaded entry and restored it, past the fragment that named nothing')
  await release()
  await kept('after the jump and the release: the visible query, the stored one and the position')
  await page.evaluate(() => void (window._item(window.__items[window.__items.length - 1].id) as any).touch())
  await settled(page)
  await kept('after a passive re-ranking: the same')
  // THE TEMPORARY VIEW'S SCROLL IS NOT THE KEPT ENTRY'S, AND A QUERY TYPED OVER THAT VIEW OUTLASTS A STOP (review 2
  // of phantom_steps, blockers 3 and 2; one launch for both since review 3). The first view is scrolled to a
  // position of its own, which arms no write. A query is typed, and Back is asked for within the typing's own
  // input event (so always inside its debounce) onto the position the app cannot take: the browser lands there
  // and returns to the kept entry while the typing waits, and the page stays as it is (restored at the return,
  // as an entry the page never showed is, the kept entry's query went back into the box over the typed text).
  // The view is then scrolled again, which arms no write either: the entry is kept until the typed query is
  // applied. That query is recorded when its debounce ends, in an entry of its own after the kept one, and Back
  // restores the kept entry WHERE IT WAS SAVED (with the keep ended at the keystroke, the second scroll's write
  // fired within the debounce and stored the temporary view's position on the kept entry)
  await recorded()
  await gated('a fifth reload on the final entry')
  // (the scroll's own event is waited for, and the tasks due after it: the app's listener has run by then, and
  // it has ARMED NO WRITE for the held view, review 3. Armed there and dropped only when it fired, a write
  // still reached the kept entry when a stop's return had brought the page back to it before its restore
  // scrolled: the reviewer's replay)
  const [savedAt, scrolledTo, armed] = await page.evaluate(async y => {
    const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
    box.focus({ preventScroll: true })
    const heard = new Promise(resolve => document.body.addEventListener('scroll', () => setTimeout(resolve), { once: true }))
    document.body.scrollTo(0, y)
    await heard
    return [history.state.scrollPosition as number, document.body.scrollTop, (window as any)._history_update_pending as boolean] as const
  }, top + 150)
  expect([savedAt, Math.abs(scrolledTo - savedAt) > 100], 'premise: the kept entry holds its own position, far from the temporary one').toEqual([atTarget, true])
  expect(armed, "a scroll of the launch's temporary view arms no history write").toBe(false)
  await page.evaluate(y => {
    const w = window as any
    // (each landing of the browser as the page hears of it: the position's key, and whether the typing waits.
    // At the second, the return, the view is scrolled again from a task of its own, and what that scroll finds
    // is noted once its event has been handled: whether the typing still waits, and whether a write is armed)
    w.__e2e_landings = []
    w.__e2e_landed = () => {
      if (w.__e2e_landings.push([w.navigation.currentEntry.key, w._editor_change_pending]) != 2) return
      setTimeout(() => {
        document.body.addEventListener('scroll', () => setTimeout(() => (w.__e2e_rescrolled = [w._editor_change_pending, w._history_update_pending])), { once: true })
        document.body.scrollTo(0, y)
      })
    }
    addEventListener('popstate', w.__e2e_landed, { capture: true })
    addEventListener('input', () => history.go(-1), { once: true, capture: true })
  }, top + 120)
  await page.keyboard.insertText('e2e typed over')
  // THE STOP ITSELF (review 3 of phantom_steps: the final key and query alone do not show that one occurred): the
  // browser landed on the position the app cannot take and then on the kept entry again, the typing pending at both
  await expect
    .poll(() => page.evaluate(() => (window as any).__e2e_landings), { message: 'a stop while the typing waits: the position the app cannot take, then the kept entry again' })
    .toEqual([
      [olderKey, true],
      [finalKey, true],
    ])
  await page.evaluate(() => removeEventListener('popstate', (window as any).__e2e_landed, { capture: true }))
  await expect.poll(() => page.evaluate(() => (window as any).__e2e_rescrolled), { message: 'the view scrolled again while the typing waits: no history write is armed, the entry kept still' }).toEqual([true, false])
  await expect.poll(stored, { message: "the typed query outlasts the stop's return and is recorded in an entry of its own", timeout: 10_000 }).toEqual([index + 2, 'e2e typed over', false])
  await expect(mindbox(page)).toHaveValue('e2e typed over')
  const typedKey = await browserKey()
  await blur(page)
  await release()
  await page.goBack()
  await shows('#e2e_target ', atTarget, 'Back from the typed query: the reloaded entry, where it was saved')
  await kept('the reloaded entry as it was, through the stop')
  expect(await page.evaluate(() => history.state.scrollPosition), 'and the position it stores is its own').toBe(atTarget)
  // A QUERY THAT IS NOT THE USER'S REPLACES THEIR TYPING OVER THE TEMPORARY VIEW (reviews 3 and 4 of
  // phantom_steps). The keystroke cancels the address's query; the launch's step is then released, with nothing
  // left to apply; the view is scrolled; item code sets another query in the box, which still has the focus, so
  // that query waits in the debounce in its turn; Back is asked for onto the position the app cannot take; and
  // once the browser has returned, an item's timer selects another item. All of it within the debounce, arranged
  // in the page from the typing's own input event, in the order that a fix at the release alone would miss (the
  // select comes last). Until the select the entry is kept still: the scroll after the release arms no write,
  // and THE STOP'S RETURN LEAVES THE PAGE AS IT IS, item code's query in the box and pending (review 4: read
  // from the typed origin alone, which the set rightly ends, the return restored the kept entry's query into
  // the box and cancelled the pending one, which the release keeps). The select is not the user's: it is
  // written over the kept entry, which keeps its key, its `final` and the entry ahead, and the keep ends with
  // it, so a scroll's write is armed and made again. (The keep ended at the user's own write alone, and so
  // never: the box showed the selected item over an entry that still held the tag, with no typing pending, and
  // no scroll was written)
  await recorded()
  await gated('a sixth reload on the final entry')
  await page.evaluate(y => {
    const w = window as any
    const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
    box.focus({ preventScroll: true })
    // (what a step finds: whether a query waits in the debounce, the box, the stored query, a scroll's write armed)
    const found = () => [w._editor_change_pending, box.value, history.state?.editorText ?? null, w._history_update_pending]
    const select = () => {
      w.__e2e_returned = found()
      w._item('#e2e_source').select()
    }
    // (each landing of the browser as the page hears of it, by the position's key; what the first, on the
    // position the app cannot take, finds; and after the second, the return, a task of its own: the app's
    // handler has run by then, whichever listener heard the landing first)
    w.__e2e_stop = { keys: [], away: null }
    const landed = () => {
      if (w.__e2e_stop.keys.push(w.navigation.currentEntry.key) == 1) return void (w.__e2e_stop.away = found())
      removeEventListener('popstate', landed, { capture: true })
      setTimeout(select)
    }
    const replace = () => {
      w.__e2e_scrolled = found()
      w.MindBox.set('e2e set') // item code's, in the focused box: it waits in the debounce
      addEventListener('popstate', landed, { capture: true })
      history.go(-1)
    }
    const scroll = () => {
      if (!w._launch_fragment_done) return void setTimeout(scroll)
      document.body.addEventListener('scroll', () => setTimeout(replace), { once: true })
      document.body.scrollTo(0, y)
    }
    addEventListener('input', () => setTimeout(() => (w._release_launch_fragment(), setTimeout(scroll))), { once: true, capture: true })
  }, top + 150)
  await page.keyboard.insertText('e2e typed')
  await expect.poll(() => page.evaluate(() => (window as any).__e2e_returned !== undefined), { message: 'the steps arranged in the page have run' }).toBe(true)
  const [scrolled, stop, returned] = await page.evaluate(() => [(window as any).__e2e_scrolled, (window as any).__e2e_stop, (window as any).__e2e_returned])
  expect(scrolled, "premise: after the scroll, the launch's step has run, the typing still waits over the kept entry, and the scroll since the release has armed no write").toEqual([true, 'e2e typed', '#e2e_target ', false])
  expect(stop, "the stop: the browser landed on the position the app cannot take, item code's query waiting in the box by then, and returned to the kept entry").toEqual({ keys: [olderKey, finalKey], away: [true, 'e2e set', null, false] })
  expect(returned, "right after the return: item code's query is still in the box and pending, the entry kept as it was and no write armed").toEqual([true, 'e2e set', '#e2e_target ', false])
  await settled(page)
  const ahead = () =>
    page.evaluate(() => {
      const navigation = (window as any).navigation
      return (navigation.entries()[navigation.currentEntry.index + 1]?.key ?? null) as string | null
    })
  expect(
    [await mindbox(page).inputValue(), await stored(), await browserKey(), await ahead(), await page.evaluate(() => (window as any)._editor_change_pending)],
    "the timer's select is written over the kept entry: the box and the entry agree, on the same key, final as it was, the entry ahead kept, nothing pending"
  ).toEqual(['#e2e_source', [index + 1, '#e2e_source', true], finalKey, typedKey, false])
  // and the keep has ended: a scroll arms its write, which is made
  await recorded()
  const rearmed = await page.evaluate(async () => {
    const body = document.body
    const heard = new Promise(resolve => body.addEventListener('scroll', () => setTimeout(resolve), { once: true }))
    body.scrollTo(0, body.scrollTop + (body.scrollTop + 60 <= body.scrollHeight - body.clientHeight ? 60 : -60))
    await heard
    return (window as any)._history_update_pending as boolean
  })
  expect(rearmed, "a scroll arms its history write again, once the keep has ended").toBe(true)
  await recorded()
  expect(await page.evaluate(() => [history.state.scrollPosition === document.body.scrollTop, history.state.editorText, history.state.final]), "the scroll's write, on the entry as it is now").toEqual([true, '#e2e_source', true])
  // (an entry ahead again, for what follows: a select of the user's, within a key press)
  await asUser(page, () => void (window._item('#e2e_target/sub') as any).select())
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')

  // a native fragment that names an item: ONE position more, the named query on it as entry 0 of a new run,
  // and no link back (how far the earlier entries are from it is not known). The entry is FINAL, as a tag's
  // click makes one, also when the very query it brings (with its trailing space) has just been typed and still
  // waits in the debounce (review 3 of phantom_steps: the navigation is asked for from the typing's own input
  // event, so always within the debounce. Settled as the typing it matched, the fragment's entry was left not
  // final, the next typed query replaced it and Back skipped the fragment)
  const run = await page.evaluate(() => history.state.run)
  await page.evaluate(() => {
    const w = window as any
    const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
    box.focus({ preventScroll: true })
    box.select()
    addEventListener('input', () => setTimeout(() => ((w.__e2e_typed = [w._editor_change_pending, box.value]), (location.hash = '#e2e_source'))), { once: true, capture: true })
  })
  await page.keyboard.insertText('#e2e_source ')
  await expect.poll(() => page.evaluate(() => [history.state?.index, history.state?.editorText, history.state?.final, history.length]), { message: "the browser's own position holds the entry, final" }).toEqual([0, '#e2e_source ', true, length + 1])
  expect(await page.evaluate(() => (window as any).__e2e_typed), 'premise: the very query was typed and still pending when the fragment was navigated to').toEqual([true, '#e2e_source '])
  await expect(mindbox(page)).toHaveValue('#e2e_source ')
  await blur(page)
  expect(await page.evaluate(() => history.state.run), 'a new run').not.toBe(run)
  expect(await entries(page)).toEqual([1, 0])
  await expect(links).toHaveCount(0)
  // Back is the entry before it, of the earlier run; Forward from there is the fragment's entry again
  await page.goBack()
  await expect(mindbox(page), 'Back: the entry the fragment was navigated from').toHaveValue('#e2e_target/sub')
  expect(await page.evaluate(() => [history.state.index, history.state.run])).toEqual([index + 2, run])
  await page.goForward()
  await expect(mindbox(page), "Forward: the fragment's entry").toHaveValue('#e2e_source ')
  expect(await page.evaluate(() => [history.state.index, history.length])).toEqual([0, length + 1])
  // the same item by its ALIAS, its id: the query and the order are the ones shown, and the browser's new
  // position is the query's entry all the same, the first of another run (left to the writer's test for a
  // change, it became a cleared position under the named item's view, and a return to it later left
  // whatever view was shown then: review 4)
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  const aliased = await page.evaluate(() => history.state.run)
  await page.evaluate(id => void (location.hash = '#' + id), sourceId)
  await expect.poll(() => page.evaluate(() => [history.length, history.state?.index, history.state?.editorText, location.hash]), { message: "the alias's position holds the entry" }).toEqual([length + 2, 0, '#e2e_source ', '#e2e_source'])
  expect(await page.evaluate(() => history.state.run), 'another run').not.toBe(aliased)
  await expect(mindbox(page)).toHaveValue('#e2e_source ')
  expect(await entries(page)).toEqual([1, 0])
  // two more entries of that run, and a real link among them: one entry ahead
  await page.locator(`#item-${sourceId} mark[title="#e2e_target"]`).click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await userSet(page, '#e2e_target/sub')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_target/sub')
  expect(await entries(page)).toEqual([3, 2])
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source ')
  await expect(links).toHaveText(['#e2e_source', '#e2e_target'])
  await links.nth(1).click()
  await expect(mindbox(page), 'the link lands on the entry it names').toHaveValue('#e2e_target ')
  expect(await page.evaluate(() => [history.state.index, (window as any)._history_index])).toEqual([1, 1])

  // a native fragment that names nothing: its position holds no entry (cleared, no link from it, nothing
  // written by a scroll there), the page stays, and Back is the entry it was navigated from
  await recorded()
  const before = await page.evaluate(() => [(window as any)._history_index, (window as any)._history[1].scrollPosition, history.length])
  await page.evaluate(() => void (location.hash = '#e2e_no_such_item'))
  const CLEARED = JSON.stringify({ owner: 'admin|anonymous|', unknown: true, fragment: true })
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(CLEARED)
  await expect(mindbox(page), 'the page stays').toHaveValue('#e2e_target ')
  await expect(links).toHaveCount(0)
  await page.evaluate(() => document.body.scrollTo(0, document.body.scrollTop + 150))
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300))) // the scroll listener's write comes 250 ms after a scroll
  await expect.poll(() => page.evaluate(() => (window as any)._history_update_pending)).toBe(false)
  expect(await page.evaluate(() => [JSON.stringify(history.state), (window as any)._history_index, (window as any)._history[1].scrollPosition, history.length]), 'nothing written on it').toEqual([CLEARED, ...before])
  await page.goBack()
  await expect.poll(() => page.evaluate(() => history.state?.index), { timeout: 10_000 }).toBe(1)
  await shows('#e2e_target ', before[1], 'Back: the entry it was navigated from, where it was left')
  await expect(links).toHaveText(['#e2e_source', '#e2e_target'])
  // Forward onto it again: NO STOP at a native fragment's own position (the stop, below: this position lies
  // between the notebook's own entries, and the entries before it are reached through it). The browser
  // stays on it and the page as it is, without a note: no return is asked for (the calls are counted)
  await page.evaluate(() => {
    const w = window as any
    const real = w.navigation.traverseTo.bind(w.navigation)
    w.__returnsAsked = 0
    w.navigation.traverseTo = (...args: unknown[]) => (w.__returnsAsked++, real(...args))
  })
  await page.goForward()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(CLEARED)
  await settled(page)
  expect(await page.evaluate(() => [JSON.stringify(history.state), document.querySelectorAll('.stop-note.visible').length, (window as any).__returnsAsked]), "no return from a fragment's own position, and no note").toEqual([CLEARED, 0, 0])
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await page.goBack()
  await expect.poll(() => page.evaluate(() => history.state?.index), { timeout: 10_000 }).toBe(1)
  await shows('#e2e_target ', before[1], 'Back again: the entry before it')

  // a MALFORMED fragment (a `%` that is no escape: decoding it throws) names nothing either, and the leave to
  // take a fragment's position ends with its handler: Back, a new query, and Back from that is the original
  // query (the handler threw with the leave still set, and the new query's entry then replaced the entry it
  // was made from: review 4)
  await page.evaluate(() => void (location.hash = '#100%'))
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#100%')
  await page.goBack()
  await expect.poll(() => page.evaluate(() => [history.state?.index, location.hash]), { timeout: 10_000 }).toEqual([1, '#e2e_target'])
  await userSet(page, '#e2e_source')
  await expect.poll(() => page.evaluate(() => [history.state?.index, history.state?.editorText]), { timeout: 10_000 }).toEqual([2, '#e2e_source'])
  await page.goBack()
  await expect(mindbox(page), 'Back from the new query: the original query, its entry intact').toHaveValue('#e2e_target ')
  expect(await page.evaluate(() => [history.state.index, history.state.editorText])).toEqual([1, '#e2e_target '])
  // its position is cleared like any fragment's that names nothing, and a page LAUNCHED on such an address
  // starts: its first view
  await page.evaluate(() => void (location.hash = '#100%'))
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(CLEARED)
  await page.reload()
  await waitForApp(page)
  await expect(mindbox(page)).toHaveValue('')
  expect(errors, 'no decoding error reached the page').toEqual([])
  expect(warnings).toEqual([])
})

// THE STOP (the owner, 2026-11-18: "if i go back twice past the start, i have to come forward twice as well;
// i'm a bit puzzled why we don't just stop at starting point"). Back or Forward onto a position that holds
// no entry of the notebook's that the app can take (one of the app's older code here, which names no owner:
// every earlier entry of a window that was open across the release of 2026-11-17) moved the browser while
// the page stayed. The browser has moved before the app hears of it, so the app goes back at once to the
// position of the entry the page shows (by the Navigation API's key) and the page stays EXACTLY as it is; a
// note says why nothing moved. The two rows share the fixture: the three queries' entries, the first query's
// rewritten as older code wrote one and the first view's as another script's state (no index), and the page
// on the tag click's entry with one entry ahead
const asOlderCode = (page: Page) =>
  page.evaluate(() => {
    const { index, editorText, scrollPosition } = history.state
    history.replaceState({ index, editorText, scrollPosition }, '')
  })
const olderEntryBehind = async (page: Page, reads: ReturnType<typeof historyReads>) => {
  const { index, atTarget, atSub } = await threeQueries(page, reads)
  await page.goBack()
  await reads.shows('#e2e_target ', atTarget, "Back to the tag click's entry")
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await reads.recorded()
  await page.evaluate(() => history.replaceState({ custom: true }, ''))
  await page.goForward()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await reads.recorded()
  await asOlderCode(page)
  await page.goForward()
  await reads.shows('#e2e_target ', atTarget, "the tag click's entry, an entry of older code behind it and one entry ahead")
  await reads.recorded()
  return { index, atTarget, atSub }
}
// the note of a stop: passive since 2026-11-19 (noteStop in index.svelte), no longer the app's modal
const note = (page: Page) => page.locator('.stop-note.visible')
// read ONCE, never polled: the note goes by itself, so a poll would pass on a note that should not have shown
// or should have gone at a key
const noNote = async (page: Page, message: string) => {
  await settled(page)
  expect(await note(page).count(), message).toBe(0)
}
// the note goes at the next key: Shift, which the page does nothing with (where a row only needs the note
// gone; a press would act on whatever is under the pointer, since the note passes it through)
const passNote = async (page: Page) => {
  await page.keyboard.press('Shift')
  await noNote(page, 'the note goes at the next key')
}
// the page hidden and shown again by its own visibility events, raised as tests/e2e/lifecycle.spec.ts raises
// them (the driver's Chromium never hides a page): the notes shown before, and a task after the hiding
const hiddenAndShown = (page: Page) =>
  page.evaluate(async () => {
    const notes = () => document.querySelectorAll('.stop-note.visible').length
    const before = notes()
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise(resolve => setTimeout(resolve))
    const after = notes()
    delete (document as any).visibilityState // the prototype's own reading again
    document.dispatchEvent(new Event('visibilitychange'))
    return [before, after]
  })

test('Back onto an entry of older code stops: the browser returns at once to the entry the page shows, the page stays as it is and a note says so; Forward still reaches the entry ahead; a jump onto a state without an index stops as quietly; a second Back stops again; the note, passive, also while the MindBox or an editor has the focus, which keeps it: nothing scrolls, a key or a press goes to the page as it would, typing goes on across the stop, and the note goes by itself, at that key or press, at the next traversal and when the page is hidden; it is drawn where a reader sees it, over another dialog and the narration camera too; without the Navigation API the page stays on the position as before', async ({ page }) => {
  const reads = historyReads(page)
  const { warnings, recorded, shows } = reads
  const { index, atTarget, atSub } = await olderEntryBehind(page, reads)
  const targetId = await page.evaluate(() => window._item('#e2e_target')!.id)
  // what would show a restore, a jump or a re-render: every state a traversal brings, every position the
  // page is asked for, every scroll and every change of the list above the header (`moves`), the layout
  // passes run and the shown item's element
  // (every warning and error of the console from here on, the handler's own among them; not the browser's
  // note on a stylesheet preloaded and not used, which comes a few seconds after a load whatever the page does)
  const noise: string[] = []
  page.on('console', msg => void (['warning', 'error'].includes(msg.type()) && !msg.text().includes('was preloaded using link preload') && noise.push(msg.text())))
  await page.evaluate(id => {
    const w = window as any
    w.__moves = []
    const scrollTo = Element.prototype.scrollTo as (...args: any[]) => void
    Element.prototype.scrollTo = function (this: Element, ...args: any[]) {
      if (this === document.body) w.__moves.push('asked')
      return scrollTo.apply(this, args)
    }
    document.body.addEventListener('scroll', () => w.__moves.push('scrolled'))
    window.addEventListener('popstate', e => w.__moves.push(e.state?.unknown ? 'cleared' : e.state?.owner ? `own ${e.state.index}` : 'index' in (e.state ?? {}) ? 'older' : 'custom'), true)
    new MutationObserver(() => w.__moves.push('list')).observe(document.querySelector('.history-container')!, { childList: true, subtree: true, characterData: true, attributes: true })
    w.__shown = document.getElementById('item-' + id)
  }, targetId)
  const moves = (): Promise<string[]> => page.evaluate(() => (window as any).__moves.splice(0))
  const traversed = () => page.evaluate(() => (window as any).__moves.filter((move: string) => /^(own|cleared|older|custom)/.test(move))) // the states the traversals brought, so far
  const still = () =>
    page.evaluate(id => {
      const w = window as any
      return {
        box: (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value,
        at: document.body.scrollTop,
        layouts: w.__layoutCount,
        element: w.__shown === document.getElementById('item-' + id) && w.__shown.isConnected,
        links: [...document.querySelectorAll('.history-item')].map(e => (e.textContent ?? '').trim()),
        entry: [history.state.index, history.state.editorText, history.state.scrollPosition, location.hash],
        session: [w._history.length, w._history_index],
      }
    }, targetId)
  const HERE = { box: '#e2e_target ', at: atTarget, element: true, links: ['#e2e_source', '#e2e_target'], entry: [index + 1, '#e2e_target ', atTarget, '#e2e_target'], session: [index + 3, index + 1] }

  // (1) Back onto the entry of older code: the browser went there and came back, and nothing else happened
  const before = await still()
  expect(before).toMatchObject(HERE)
  await page.goBack()
  await expect(note(page), 'the note of a stop after Back').toHaveText('nothing to go back to')
  await settled(page)
  expect(await moves(), 'the entry of older code, then the entry the page shows again: no position asked for, no scroll, the list untouched').toEqual(['older', `own ${index + 1}`])
  expect(await still(), 'the page is exactly as it was: its view, the MindBox, the position, its entry, the list above the header').toEqual(before)
  // Back again with the note still shown: the same stop, on the position the first one cleared, and one note
  await page.goBack()
  await expect.poll(() => page.evaluate(() => (window as any).__moves), { message: 'a stop while the note shows' }).toEqual(['cleared', `own ${index + 1}`])
  await moves()
  // it has no button, and it goes at the next key, which reaches the page (Shift: nothing else happens)
  await expect(note(page).locator('.button')).toHaveCount(0)
  await passNote(page)
  await recorded()
  expect(await still(), 'after the note: the viewport and the saved position are where they were').toEqual(before)
  expect({ noise, warnings }, 'nothing warned in the console').toEqual({ noise: [], warnings: [] })
  // a JUMP of two positions, onto a state that is no entry at all (another script's: no index): the same stop,
  // back to the entry by its key, and the console as quiet (such a state was cleared with a warning)
  await page.evaluate(() => history.go(-2))
  await expect(note(page), 'the note of a stop after a jump').toHaveText('nothing to go back to')
  await settled(page)
  expect(await moves(), 'the state without an index, then the entry the page shows again').toEqual(['custom', `own ${index + 1}`])
  expect(await still()).toEqual(before)
  expect({ noise, warnings }, 'nothing warned in the console, for a state without an index either').toEqual({ noise: [], warnings: [] })

  // (2) Forward still reaches the entry ahead, pressed WHILE THE NOTE OF THE JUMP SHOWS: the browser's own
  // Forward is no key and no press of the page's, and the note goes as the entry lands (until review 0 of
  // back_note it stayed for the rest of its three seconds, and the entry ahead said "nothing to go back
  // to"). It is read a task after the landing's popstate, before the entry's layouts and its scroll are
  // waited for. Then Back from the entry ahead, and Back again THE MOMENT THAT ONE HAS LANDED
  // (from a listener of the row's, which runs after the app's: before any write on the entry reached): the
  // second one stops, and returns to the entry the first one reached, the position noted when it landed
  // (the entry ahead is given a position of its own first: its write notes ITS position, the last one noted
  // before the two Backs)
  const showing = await page.evaluate(() => {
    const w = window as any
    w.__noteAtLanding = undefined
    window.addEventListener('popstate', () => void setTimeout(() => (w.__noteAtLanding = document.querySelector('.stop-note.visible')?.textContent ?? null)), { once: true })
    return document.querySelectorAll('.stop-note.visible').length
  })
  expect(showing, 'the premise: the note still shows as Forward is pressed').toBe(1)
  await page.goForward()
  await expect.poll(() => page.evaluate(() => (window as any).__noteAtLanding), { message: 'no note once the entry ahead has landed' }).toBe(null)
  await shows('#e2e_target/sub', atSub, 'Forward: the entry ahead, kept')
  expect(await reads.place(200), 'the entry ahead, at a position of its own').not.toBe(atTarget)
  await moves()
  await page.evaluate(() => void window.addEventListener('popstate', () => history.back(), { once: true }))
  await page.goBack()
  await expect(note(page), 'Back from the entry ahead, and at once Back again: a stop').toHaveText('nothing to go back to')
  // the note goes when the page is hidden (a hidden page's timers can be held, and it would come back with the old note)
  expect(await hiddenAndShown(page), 'the note shown, and gone once the page is hidden').toEqual([1, 0])
  await shows('#e2e_target ', atTarget, 'the entry the first Back reached, restored where it was left')
  expect((await moves()).filter(move => /^(own|cleared|older)/.test(move)), 'the entry reached, the cleared position, the entry reached again').toEqual([`own ${index + 1}`, 'cleared', `own ${index + 1}`])
  await recorded()
  expect(await still()).toMatchObject(HERE)
  await noNote(page, 'no note came back with the page shown again')

  // (3) Back once more, onto the cleared position, stops the same way. The MindBox holds the focus this
  // time, out of view above the window: the note shows all the same and takes nothing (a modal blurred the
  // box and gave the focus back with a scroll to it, which the scroll listener saved; until 2026-11-19 no
  // note was shown here): the box keeps the focus, no position is asked for and nothing scrolls, the box
  // stays above the window. Then the note goes by itself, and nothing moves then either
  const boxAbove = () => page.evaluate(() => document.getElementById('textarea-mindbox')!.getBoundingClientRect().bottom < 0)
  await focusMindboxInPlace(page)
  await expect(mindbox(page)).toBeFocused()
  expect(await boxAbove(), 'the MindBox is above the window').toBe(true)
  await recorded()
  await moves()
  await page.goBack()
  await expect.poll(traversed, { message: 'a second Back stops again, with the MindBox focused' }).toEqual(['cleared', `own ${index + 1}`])
  await expect(note(page), 'the note, with the MindBox focused').toHaveText('nothing to go back to')
  // (what a reader sees, not the class and the words alone: the element is rendered, inside the window)
  await expect(note(page), 'the note is rendered visible').toBeVisible()
  await expect(note(page), 'inside the window').toBeInViewport()
  await settled(page)
  await expect(mindbox(page), 'the MindBox keeps the focus while the note shows').toBeFocused()
  expect(await moves(), 'the two traversals alone: no position asked for, no scroll').toEqual(['cleared', `own ${index + 1}`])
  expect(await still(), 'the viewport and the saved position are where they were').toMatchObject(HERE)
  expect(await boxAbove(), 'the MindBox is still above the window').toBe(true)
  await expect(note(page), 'the note goes by itself').toHaveCount(0, { timeout: 10_000 })
  await settled(page)
  await recorded()
  expect(await moves(), 'nothing moved as it went').toEqual([])
  expect(await still(), 'the viewport and the saved position, once the note has gone').toMatchObject(HERE)
  await expect(mindbox(page), 'the MindBox still has the focus').toBeFocused()
  expect(await boxAbove(), 'and is still above the window').toBe(true)
  await blur(page)

  // (4) a press while the note shows goes to the page, AT THE NOTE'S OWN PLACE: the item's text is brought
  // under the middle of the window, where the note stands, and a stop is made with nothing focused. The hit
  // test at the note's centre answers with the paragraph under it, and a press there (by the mouse, which no
  // driver check holds back) opens the item's editor, the note gone at that press. Before the press, the
  // NARRATION CAMERA is stood in for (Webcam.svelte: the camera at z-index 1000 and its title at 1001; in
  // intro mode the camera covers the middle of the window; no camera is asked for here): two opaque boxes
  // of those layers over the note, beside it in the document as the camera's are. The pointer then goes to
  // the camera, through the note, and with the note made hittable for the reading it is the note that lies
  // on top of both (at 101 it lay under the camera). Then the editor holds the focus, with typed text not
  // saved: the stop shows the note there too (none until 2026-11-19: a modal takes the focus and every key
  // until it is dismissed), the editor keeps the focus, and the typing goes on where it was, the first key
  // typed included, at which the note goes
  const paragraph = page.locator(`#item-${targetId} p`).first()
  await paragraph.evaluate(p => {
    const r = p.getBoundingClientRect()
    document.body.scrollBy(0, Math.round(r.top + r.height / 2 - innerHeight / 2))
  })
  await recorded()
  await moves()
  await page.goBack()
  await expect.poll(traversed, { message: 'the stop, nothing focused' }).toEqual(['cleared', `own ${index + 1}`])
  await expect(note(page), 'the note, nothing focused').toHaveText('nothing to go back to')
  const place = await page.evaluate(id => {
    const shown = document.querySelector('.stop-note.visible') as HTMLElement
    const r = shown.getBoundingClientRect()
    const [x, y] = [r.left + r.width / 2, r.top + r.height / 2]
    const hit = () => document.elementFromPoint(x, y)
    const under = hit()
    const [camera, title] = [1000, 1001].map(layer => {
      const box = document.createElement('div')
      box.style.cssText = `position: fixed; z-index: ${layer}; width: 68.75vw; height: 50vw; right: 15.625vw; bottom: 0; background: #246`
      return shown.parentElement!.appendChild(box)
    })
    const through = hit()
    shown.style.pointerEvents = 'auto'
    const top = hit()
    shown.style.pointerEvents = ''
    camera.remove()
    title.remove()
    const name = (e: Element | null) => (e === shown ? 'the note' : e === title ? "the camera's title" : e === camera ? 'the camera' : e === document.querySelector(`#item-${id} p`) ? 'the paragraph' : (e?.tagName ?? null))
    return { x, y, under: name(under), through: name(through), top: name(top) }
  }, targetId)
  expect(place, "at the note's centre the pointer goes to what is under the note, and the note lies on top of the camera's layers").toMatchObject({ under: 'the paragraph', through: "the camera's title", top: 'the note' })
  await page.mouse.click(place.x, place.y)
  const textarea = page.locator(`#textarea-${targetId}`)
  await expect(textarea, "the press at the note's centre went to the page: the editor is open").toBeFocused()
  await noNote(page, 'the note goes at the press')
  const saved = await textarea.inputValue()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.type(' typed')
  await expect(textarea).toHaveValue(saved + ' typed')
  await recorded()
  await moves()
  await page.goBack()
  await expect.poll(traversed, { message: 'the stop, with an editor focused' }).toEqual(['cleared', `own ${index + 1}`])
  await expect(note(page), "the note, with an item's editor focused").toHaveText('nothing to go back to')
  await expect(textarea, 'the editor keeps the focus while the note shows').toBeFocused()
  await page.keyboard.type(' on')
  await expect(textarea, 'the typing goes on in the editor, the first key included').toHaveValue(saved + ' typed on')
  await noNote(page, 'the note goes at the first key typed')
  await textarea.fill(saved)
  await page.keyboard.press('Escape')
  await expect(textarea).toBeHidden()

  // (5) another dialog is open: the note shows over it (until 2026-11-19 none was shown while a dialog was
  // open: the guard returned at once), the dialog stays as it is, the pointer at the note's centre goes to
  // the dialog under it, and a press on the dialog's button reaches the button
  const dialog = page.locator('.background.visible .modal')
  await page.evaluate(() => void (window as any)._modal('a dialog of the page', { confirm: 'OK' }))
  await expect(dialog).toContainText('a dialog of the page')
  await moves()
  await page.goBack()
  await expect.poll(traversed, { message: 'the stop, with a dialog open' }).toEqual(['cleared', `own ${index + 1}`])
  await expect(note(page), 'the note, over the dialog').toHaveText('nothing to go back to')
  await expect(dialog, 'the dialog stays').toContainText('a dialog of the page')
  expect(
    await page.evaluate(() => {
      const shown = document.querySelector('.stop-note.visible')!
      const r = shown.getBoundingClientRect()
      const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return [shown.contains(under), !!under?.closest('.background.visible')]
    }),
    "at the note's centre the pointer goes to the dialog, not to the note"
  ).toEqual([false, true])
  await dialog.locator('.button.confirm').click()
  await expect(dialog, 'the press confirmed the dialog').toHaveCount(0)
  await noNote(page, 'and the note went at it')

  // (5b) typing in the MindBox ACROSS a stop: the note shows, a character typed before it and one typed
  // while it shows are both in the box, which keeps the focus, and the note goes at that key. The typed
  // query then applies as any edit of a final entry does (a new entry), and Back from it is the entry again
  await focusMindboxInPlace(page, '#e2e_target '.length)
  await page.keyboard.type('x')
  await moves()
  await page.goBack()
  await expect.poll(traversed, { message: 'the stop, between two typed characters' }).toEqual(['cleared', `own ${index + 1}`])
  await expect(note(page), 'the note, between two typed characters').toHaveText('nothing to go back to')
  await page.keyboard.type('y')
  await expect(mindbox(page), 'both characters are in the box').toHaveValue('#e2e_target xy')
  await expect(mindbox(page)).toBeFocused()
  await noNote(page, 'the note goes at the key typed')
  await expect.poll(() => page.evaluate(() => [history.state?.index, history.state?.editorText]), { message: 'the typed query, applied as an edit of the entry', timeout: 10_000 }).toEqual([index + 2, '#e2e_target xy'])
  await blur(page)
  await page.goBack()
  await expect.poll(() => page.evaluate(() => [history.state?.index, history.state?.editorText]), { timeout: 10_000 }).toEqual([index + 1, '#e2e_target '])
  await expect(mindbox(page)).toHaveValue('#e2e_target ')

  // (6) WITHOUT THE NAVIGATION API (hidden here, as in a browser that lacks it) no return can be said: the
  // page stays on the position, as before the stop, with no note, no link from it and nothing warned;
  // Forward restores the entry
  await page.evaluate(() => void Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }))
  await page.goBack()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state)), { message: 'the position, cleared at the first Back, and the browser still on it' }).toBe(JSON.stringify({ owner: 'admin|anonymous|', unknown: true }))
  await noNote(page, 'no note without a stop')
  await expect(mindbox(page), 'the page stays as it is').toHaveValue('#e2e_target ')
  await expect(page.locator('.history-item'), 'no link from a position that holds no entry').toHaveCount(0)
  await page.goForward()
  await expect.poll(() => page.evaluate(() => history.state?.index), { timeout: 10_000 }).toBe(index + 1)
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await expect(page.locator('.history-item')).toHaveCount(2)
  expect({ noise, warnings }, 'nothing warned in the console').toEqual({ noise: [], warnings: [] })
})

// THE STOP WHILE A PAGE IS STILL STARTING. Back during a reload moves the browser before the page shows any
// entry (the early-Back row above: the position reached is applied once the page is initialized, and nothing
// is written at startup). When that position holds no entry the app can take, the browser returns to the
// entry the page was created on, one of the notebook's by the identity noted then, and that entry is shown
// as any entry reached: its query, where it was left. Nothing is written on the way, so the entry ahead is
// kept; the position reached is cleared
test('Back while a reloaded page is still starting, onto an entry of older code, stops once the page is ready: the browser returns to the entry the page was reloaded on, shown where it was left with the note, and the entry ahead is kept; a page reloaded on a cleared position makes no return to it', async ({ page }) => {
  const reads = historyReads(page)
  const { warnings, shows } = reads
  const { index, atTarget, atSub } = await olderEntryBehind(page, reads)
  await page.addInitScript(() => {
    window._initialize_stall_ms = 3_000
    window.addEventListener('popstate', e => ((window as any).__moves ??= []).push(e.state?.unknown ? 'cleared' : e.state?.owner ? `own ${e.state.index}` : 'index' in (e.state ?? {}) ? 'older' : 'custom'), true)
    // every return the page asks for
    const w = window as any
    const real = w.navigation.traverseTo.bind(w.navigation)
    w.__returnsAsked = 0
    w.navigation.traverseTo = (...args: unknown[]) => (w.__returnsAsked++, real(...args))
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => window._init_time > 0)).toBe(true)
  await page.goBack()
  await expect(page.locator('#sapper > .loading'), 'Back arrived before the page was initialized').toHaveClass(/visible/)
  expect(await page.evaluate(() => (window as any).__moves), 'the browser is on the entry of older code while the page starts').toEqual(['older'])
  // (the note is looked for while the page gets ready: it goes by itself, possibly before the page has
  // rendered all it renders at a load; the two start together, and a failure of either ends the wait)
  await Promise.all([expect(note(page), 'the note of the stop, once the page is ready').toHaveText('nothing to go back to', { timeout: 90_000 }), waitForApp(page)])
  await shows('#e2e_target ', atTarget, 'the entry the page was reloaded on, shown where it was left')
  expect(await page.evaluate(() => [(window as any).__moves, (window as any).__returnsAsked]), 'one return, to that entry').toEqual([['older', `own ${index + 1}`], 1])
  expect(await page.evaluate(() => [history.state.index, history.state.editorText, history.state.scrollPosition, location.hash]), "the browser's entry is that one, as it was").toEqual([index + 1, '#e2e_target ', atTarget, '#e2e_target'])
  expect(await entries(page), 'the session is on it').toEqual([index + 2, index + 1])
  await passNote(page)
  // nothing was lost: the entry ahead, and the entry itself on the way back
  await page.goForward()
  await shows('#e2e_target/sub', atSub, 'Forward: the entry ahead, kept')
  await page.goBack()
  await shows('#e2e_target ', atTarget, 'Back')
  // the position Back had reached was cleared before the browser left it (read where no return is made:
  // without the Navigation API, hidden here)
  await page.evaluate(() => void Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }))
  const CLEARED = JSON.stringify({ owner: 'admin|anonymous|', unknown: true })
  await page.goBack()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(CLEARED)
  await expect(mindbox(page)).toHaveValue('#e2e_target ')

  // A RELOAD ON THAT CLEARED POSITION, and Back while the page is starting, onto the state without an index
  // behind it (review 6 of scroll_history). The position the page was created on NAMES the notebook and is no
  // entry of its own, so it is no return address: no return is asked for (by the owner's name alone the
  // browser was sent back to it, a position the app could not restore either), and the page stays on the
  // position reached, cleared, as before the stop
  await page.reload()
  await expect.poll(() => page.evaluate(() => window._init_time > 0)).toBe(true)
  await page.goBack()
  await expect(page.locator('#sapper > .loading'), 'Back arrived before the page was initialized').toHaveClass(/visible/)
  await waitForApp(page)
  await noNote(page, 'no note: no stop was made')
  expect(await page.evaluate(() => [(window as any).__moves, (window as any).__returnsAsked, JSON.stringify(history.state)]), 'the state without an index, cleared, and no trip back to the position the page was reloaded on').toEqual([['custom'], 0, CLEARED])
  await expect(mindbox(page), 'the page shows its first view').toHaveValue('')
  expect(warnings).toEqual([])
})

// WHILE THE RETURN OF A STOP IS ON ITS WAY (review 6 of scroll_history, 2026-11-18). Between the landing and
// the return the browser is on a position that holds no entry, for a few milliseconds in a browser and for as
// long as the row holds it here: `navigation.traverseTo` is the row's (it keeps the app's call, then makes the
// real one, or refuses it). What happened there was decided by that position's rules: a typed update of a
// query was a push, which dropped the entry the reader was on and the entry ahead; a re-ranking and a scroll
// write that came due were dropped. They are kept for the entry and made when the browser is on it again.
// The fixture is four positions over the navigation row's items: the first view rewritten as older code
// wrote one, a typed query (NOT final: an update of it is a replacement, which keeps what is ahead; a final
// entry's may rightly drop it), the tag click's entry, and the last query rewritten as older code, AHEAD
test("while a stop's return is on its way an edit, a re-ranking and a due scroll write are kept for the entry and made on arrival, with the entry ahead kept; a refused return leaves the position as before the stop; another navigation retires the return, and no note follows a later visit; a history link is not followed meanwhile, nor when its click ends an overdue return; a second Back onto a fragment's own position drops the kept edit and keeps every position; an update of the view a kept edit shows is saved on the entry the edit gets", async ({ page }) => {
  const reads = historyReads(page)
  const { warnings, recorded, shows } = reads
  const { index, atTarget } = await threeQueries(page, reads)
  // [the first view, '#e2e_source' typed (index), the tag click's '#e2e_target ' (index + 1), '#e2e_target/sub' (index + 2)], on the last
  await recorded()
  await asOlderCode(page)
  await page.goBack()
  await shows('#e2e_target ', atTarget, "Back to the tag click's entry")
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  await asOlderCode(page)
  await page.goForward()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await recorded()
  const CLEARED = JSON.stringify({ owner: 'admin|anonymous|', unknown: true })
  const links = page.locator('.history-item')
  const browser = () => page.evaluate(() => [(window as any).navigation.currentEntry.key, history.length, (window as any).navigation.entries().length] as [string, number, number])
  const entry = (i = index) => page.evaluate(i => ({ at: JSON.stringify(history.state) == JSON.stringify((window as any)._history[i]) ? i : JSON.stringify(history.state), ...(window as any)._history[i] }), i)
  const on = (i: number) => expect.poll(() => page.evaluate(() => history.state?.index), { message: `the browser is on entry ${i}`, timeout: 10_000 }).toBe(i)
  const [keyS, length, positions] = await browser()
  expect(await entry(), 'the held entry is the typed query, NOT final, with two entries ahead').toMatchObject({ at: index, editorText: '#e2e_source', final: false })
  expect(await entries(page)).toEqual([index + 3, index])

  // the row's hold on the return: the app's call is kept until the row lets it go (the real method) or refuses it
  await page.evaluate(() => {
    const w = window as any
    const real = w.navigation.traverseTo.bind(w.navigation)
    w.__returns = []
    w.navigation.traverseTo = (key: string, options?: unknown) => {
      let release!: (mode: string) => void
      const gate = new Promise<string>(resolve => (release = resolve))
      w.__returns.push(release)
      const result = gate.then(mode => {
        if (mode == 'refuse') throw new DOMException('refused by the row', 'AbortError')
        return real(key, options)
      })
      return { committed: result.then((r: any) => r.committed), finished: result.then((r: any) => r.finished) }
    }
    // every traversal the page asks for by a distance (a history link's)
    w.__gone = []
    const go = history.go.bind(history)
    history.go = (delta?: number) => (w.__gone.push(delta), go(delta))
  })
  const held = (message: string) => expect.poll(() => page.evaluate(() => [(window as any).__returns.length, JSON.stringify(history.state)]), { message }).toEqual([1, CLEARED])
  const release = (mode: 'go' | 'refuse') => page.evaluate(mode => (window as any).__returns.shift()(mode), mode)
  const arrived = async (words: string, message: string) => {
    await expect(note(page), message).toHaveText(words)
    await passNote(page)
  }

  // (1) A QUERY UPDATE while the return is held: nothing is decided on the cleared position (no push there:
  // the browser's positions are what they were), the box shows the update, and the session's entry waits
  await page.goBack()
  await held('Back onto the entry of older code: cleared, and the return held')
  await userSet(page, '#e2e_target/sub')
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')
  expect([await browser(), await entry(), await page.evaluate(() => (window as any)._history_update_pending)], 'nothing written yet: the position cleared, the positions as they were, the entry as it was, a write kept').toMatchObject([[expect.not.stringMatching(keyS), length, positions], { at: CLEARED, editorText: '#e2e_source' }, true])
  // on arrival the update is the entry's own: a REPLACEMENT of a query that is not final, and the entry ahead is kept
  await release('go')
  await arrived('nothing to go back to', 'the return arrives')
  expect([await browser(), await entry()], 'the update replaced the held entry, at its own position').toMatchObject([[keyS, length, positions], { at: index, editorText: '#e2e_target/sub', final: false }])
  expect(await entries(page)).toEqual([index + 3, index])
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward: the entry ahead, kept')
  const keyT = (await browser())[0]
  await page.goBack()
  await on(index)
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')
  await recorded()

  // (2) A RE-RANKING with the query unchanged (an item touched), while the return is held: kept too, and
  // written on arrival (on the cleared position it took the replacing path, which writes nothing there)
  // (the item ranked last: touched, it is ranked ahead of the others, so the order changes)
  const [touched, order] = await page.evaluate(() => [window.__items[window.__items.length - 1].id, history.state.orderHash] as [string, string])
  expect((await entry()).unsavedTimes.some((time: { id: string }) => time.id == touched), 'the item is not among the times of the entry yet').toBe(false)
  await page.goBack()
  await held('Back again: the return held')
  await page.evaluate(id => void (window._item(id) as any).touch(), touched)
  await expect.poll(() => page.evaluate(() => (window as any)._history_update_pending), { message: "the re-ranking's write is kept" }).toBe(true)
  expect(await entry()).toMatchObject({ at: CLEARED, orderHash: order })
  await release('go')
  await arrived('nothing to go back to', 'the return arrives')
  const ranked = await entry()
  expect([ranked.at, ranked.editorText, ranked.orderHash == order, ranked.unsavedTimes.some((time: { id: string }) => time.id == touched)], 'the entry holds the order and the times shown').toEqual([index, '#e2e_target/sub', false, true])
  await recorded()

  // (3) A SCROLL WRITE THAT COMES DUE while the return is held. The scroll listener's 250 ms timer is the
  // row's for this step: armed by a scroll before Back, and run by the row during the return (every timer of
  // 250 ms set meanwhile is kept and run then: a scroll can also arm the app's focus restore, of the same delay)
  await page.evaluate(() => {
    const w = window as any
    const real = window.setTimeout
    w.__due = []
    ;(window as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => (ms === 250 ? (w.__due.push(() => cb(...args)), 0) : real(cb, ms, ...args))
    w.__timers = () => void ((window as any).setTimeout = real)
  })
  const saved = (await entry()).scrollPosition
  const scrolled = saved + 60
  await page.evaluate(y => document.body.scrollTo(0, y), scrolled)
  await expect.poll(() => page.evaluate(() => [(window as any).__due.length > 0, (window as any)._history_update_pending, document.body.scrollTop]), { message: "the scroll's write is armed" }).toEqual([true, true, scrolled])
  await page.evaluate(() => (window as any).__timers())
  await page.goBack()
  await held('Back within the 250 ms: the return held')
  await page.evaluate(() => (window as any).__due.splice(0).forEach((due: () => void) => due()))
  expect([await entry(), await page.evaluate(() => (window as any)._history_update_pending)], 'the write came due on the cleared position: kept, not dropped').toMatchObject([{ at: CLEARED, scrollPosition: saved }, true])
  await release('go')
  await arrived('nothing to go back to', 'the return arrives')
  expect([await entry(), await scrollTop(page)], 'the position the reader left is the one saved').toMatchObject([{ at: index, scrollPosition: scrolled }, scrolled])

  // (4) A REFUSED RETURN: the page is on the cleared position as before the stop (its marker, no link from
  // it, no note), and the next navigation works
  await page.goBack()
  await held('Back again: the return held')
  await expect(links, 'the list stays while the return is on its way').toHaveCount(2)
  await release('refuse')
  await expect(links, 'no link from a position that holds no entry').toHaveCount(0)
  await noNote(page, 'no note for a return that did not happen')
  expect((await entry()).at).toBe(CLEARED)
  await page.goForward()
  await on(index)
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')
  await expect(links).toHaveCount(2)

  // (5) ANOTHER NAVIGATION TAKES OVER: a traversal to another entry of the notebook's while the return is
  // held is followed and retires it; a later, ordinary visit to the entry the return was going to shows no note
  await page.goBack()
  await held('Back again: the return held')
  await page.evaluate(() => history.go(2))
  await shows('#e2e_target ', atTarget, "a jump to the tag click's entry, with the return still held")
  await page.goBack()
  await on(index)
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')
  await noNote(page, 'no note at an ordinary visit to the entry the retired return was going to')
  await release('refuse') // the held call ends; nothing of it is left to refuse
  await page.goForward()
  await shows('#e2e_target ', atTarget, 'Forward')
  await recorded()

  // (6) FORWARD onto the entry of older code AHEAD, the return held: A HISTORY LINK IS NOT FOLLOWED meanwhile
  // (its distance is from the entry, and the browser is not on it), and the return then arrives
  await page.evaluate(() => void ((window as any).__gone.length = 0))
  await page.goForward()
  await held('Forward onto the entry of older code: cleared, and the return held')
  await expect(links).toHaveCount(2)
  await links.first().click()
  expect(await page.evaluate(() => (window as any).__gone), 'no traversal by a distance while the return is on its way').toEqual([])
  // (a click in the header leaves the focus in the MindBox; blurred, as when a stop showed no note there)
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('textarea-mindbox')
  await blur(page)
  await release('go')
  await arrived('nothing to go forward to', 'the return arrives, from the other side')
  expect([(await browser())[0], (await entry(index + 1)).at]).toEqual([keyT, index + 1])

  // (7) A NATIVE FRAGMENT NAVIGATION takes over as well: the return is retired, and a later visit to the
  // entry it was going to shows no note
  await page.goForward()
  await held('Forward again: the return held')
  await page.evaluate(() => void (location.hash = '#e2e_no_such_item'))
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(JSON.stringify({ owner: 'admin|anonymous|', unknown: true, fragment: true }))
  await page.evaluate(() => history.go(-2))
  await on(index + 1)
  await noNote(page, 'no note at a visit to the entry the retired return was going to')
  await release('refuse')

  // (8) A RETURN THAT NEVER SETTLES does not keep the page waiting. An edit is kept while the return is held
  // (within the limit: two seconds, the app's seam here); once the return is overdue, whatever asks next ends
  // it as refused, and the kept edit is the edit of a position that holds no entry, as before the stop: a new
  // entry there, under a new numbering. Here A CLICK ON A HISTORY LINK asks (review 7 of scroll_history): it
  // BEGAN on a position that holds no entry, so it is consumed, though the kept edit's entry is the browser's
  // by the time the handler goes on (followed, its distance was from the old list: one back from the new entry)
  await recorded()
  await page.goForward()
  await held('Forward again: the return held, for good')
  await userSet(page, '#e2e_source')
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  expect([(await entry(index + 1)).at, await page.evaluate(() => (window as any)._history_update_pending)], 'the edit is kept').toEqual([CLEARED, true])
  await expect(links).toHaveCount(2)
  // (the press is dispatched on the link, the first one: not the current entry's. A click of the driver's
  // scrolls its target into view first, and a scroll asks too: the overdue return then ends before the press)
  const pressed = await page.evaluate(() => {
    const w = window as any
    w._stop_return_limit_ms = -1
    w.__gone.length = 0
    document.querySelector('.history-item')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    return [w.__gone.slice(), history.state?.index, history.state?.editorText]
  })
  expect(pressed, 'the kept edit is recorded, a new entry from the cleared position, and the press asked for no traversal').toEqual([[], 0, '#e2e_source'])
  expect(await entries(page)).toEqual([1, 0])
  await page.evaluate(() => void delete (window as any)._stop_return_limit_ms)
  await noNote(page, 'no note')
  await release('refuse')

  // (9) BACK TWICE, THE SECOND ONTO A FRAGMENT'S OWN POSITION THAT IS ALREADY THERE (review 7). The positions,
  // made by native fragments from here: one that names nothing (its marker), then three that name items, the
  // first of them rewritten as older code wrote one; the page on the second, with the third ahead
  const FRAGMENT = JSON.stringify({ owner: 'admin|anonymous|', unknown: true, fragment: true })
  const shown = (text: string) => expect.poll(() => page.evaluate(() => [history.state?.index, history.state?.editorText]), { message: `the browser is on the entry of ${text}`, timeout: 10_000 }).toEqual([0, text])
  await page.evaluate(() => void (location.hash = '#e2e_no_such_item'))
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toBe(FRAGMENT)
  for (const name of ['#e2e_source', '#e2e_target', '#e2e_target/sub']) {
    await page.evaluate(name => void (location.hash = name), name)
    await shown(name + ' ')
    await recorded()
    if (name == '#e2e_source') await asOlderCode(page)
  }
  await page.goBack()
  await shown('#e2e_target ')
  await recorded()
  const keys = () => page.evaluate(() => (window as any).navigation.entries().map((position: { key: string }) => position.key) as string[])
  const [positionsBefore, keyHeld] = [await keys(), (await browser())[0]]
  // Back onto the entry of older code, the return held, and an edit kept; then Back AGAIN, onto the marker
  await page.goBack()
  await held('Back onto the entry of older code: the return held')
  await userSet(page, '#e2e_source')
  await expect.poll(() => page.evaluate(() => (window as any)._history_update_pending), { message: 'the edit is kept' }).toBe(true)
  await page.goBack()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state)), { message: "the fragment's own position, its marker" }).toBe(FRAGMENT)
  await settled(page)
  expect([await keys(), await page.evaluate(() => [JSON.stringify(history.state), (window as any)._history_update_pending])], "nothing is written from the fragment's position: every position is still the browser's, the marker is intact, and the kept edit went with the retired return").toEqual([positionsBefore, [FRAGMENT, false]])
  // A CHANGE NO USER ACTION TRIGGERED ON THAT POSITION (review 0 of phantom_steps, blocker 1): the box shows the
  // dropped edit and the session holds the held entry's query, so a re-ranking there (a touch from the page's
  // script, as a timer of item code or a snapshot makes one) differs from that entry by its QUERY. It is no
  // navigation of the user's: nothing is written, the marker stays and the positions ahead are the browser's
  // still (taken for an edit, it started a new run from the marker and dropped them, on the release too)
  await page.evaluate(() => void (window._item(window.__items[window.__items.length - 1].id) as any).touch())
  await settled(page)
  expect([await keys(), await page.evaluate(() => JSON.stringify(history.state))], 'a passive re-ranking on a position that holds no entry writes nothing: the positions and the marker as they were').toEqual([positionsBefore, FRAGMENT])
  // ORDINARY FORWARD PRESSES from the marker (review 8 of scroll_history). The kept edit went with the retired
  // return, but the box still SHOWS it: the page is no longer the held entry's view. So the first press, onto
  // the cleared position, makes NO return to that entry (taken back there without a restore, the box held the
  // dropped query over the entry's own, and the next re-ranking took the difference for an edit: a push from
  // a final entry, and the entry ahead was gone). The browser stays on the cleared position, as before the
  // stop, and the second press restores the held entry as any entry reached
  const asked = await page.evaluate(() => (window as any).__returns.length)
  await page.goForward()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state)), { message: 'Forward: the cleared position' }).toBe(CLEARED)
  await settled(page)
  expect(await page.evaluate(() => [JSON.stringify(history.state), (window as any).__returns.length]), 'no return is asked for from there: the page does not show the held entry').toEqual([CLEARED, asked])
  await page.goForward()
  await shown('#e2e_target ')
  expect(
    [(await browser())[0], await mindbox(page).inputValue(), await page.evaluate(() => [history.state.editorText, (window as any)._history[0].editorText])],
    'Forward again: the held entry at its own position, and the box shows the query that both stored copies hold'
  ).toEqual([keyHeld, '#e2e_target ', ['#e2e_target ', '#e2e_target ']])
  await noNote(page, 'no note at an ordinary visit to the entry the retired return was going to')
  // a re-ranking there that changes no order (the item ranked first, touched) is no edit: nothing is written,
  // and the entry ahead is still the browser's
  await recorded()
  const ranking = () => page.evaluate(() => window.__items.map(item => item.id).join())
  const rankingBefore = await ranking()
  await page.evaluate(() => void (window._item(window.__items[0].id) as any).touch())
  await settled(page)
  expect([await ranking(), await keys(), await page.evaluate(() => [history.state.index, history.state.editorText])], 'a re-ranking that changes no order writes nothing: every position is still there').toEqual([rankingBefore, positionsBefore, [0, '#e2e_target ']])
  await page.goForward()
  await shown('#e2e_target/sub ')
  expect(await keys(), 'the entry ahead, and every position').toEqual(positionsBefore)
  await release('refuse')

  // (10) AN UPDATE OF THE VIEW A KEPT EDIT SHOWS (review 7). The held entry is FINAL (a fragment's), so the
  // edit kept during the return is a PUSH on arrival, rightly. In the same hold the new view is scrolled and
  // its write comes due; then a timer armed BEFORE the edit, in the held view, comes due too. On arrival the
  // entry the edit got holds the position of ITS view's write: not the position at the edit (the update was
  // kept for the held entry's index, and dropped once the push had moved it), and not the older timer's
  await page.goBack()
  await shown('#e2e_target ')
  await recorded()
  await page.evaluate(() => {
    const w = window as any
    const real = window.setTimeout
    w.__due = []
    ;(window as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => (ms === 250 ? (w.__due.push(() => cb(...args)), 0) : real(cb, ms, ...args))
    w.__timers = () => void ((window as any).setTimeout = real)
    w.__run = (due: (() => void)[]) => (due.splice(0).forEach(run => run()), document.body.scrollTop) // the timers run, and the position they read
  })
  const base = await scrollTop(page)
  await page.evaluate(y => document.body.scrollTo(0, y), base + 40)
  await expect.poll(() => page.evaluate(() => (window as any).__due.length > 0 && (window as any)._history_update_pending), { message: "a scroll in the held view: its write is armed" }).toBe(true)
  await page.goBack()
  await held('Back onto the cleared position: the return held')
  const atEdit = await asUser(page, () => {
    const w = window as any
    w.__old = w.__due.splice(0) // the timers armed in the held view
    w.MindBox.set('#e2e_source')
    return document.body.scrollTop
  })
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  // (the scroll's own event is waited for, by a listener registered after the app's: another timer of the same
  // delay can be waiting already, and the write of THIS scroll is armed only once its event has been handled)
  await page.evaluate(y => {
    const w = window as any
    w.__scrolled = false
    document.body.addEventListener('scroll', () => (w.__scrolled = true), { once: true })
    document.body.scrollTo(0, y)
  }, base + 140)
  await expect.poll(() => page.evaluate(() => (window as any).__scrolled && (window as any).__due.length > 0), { message: "a scroll in the new view: its write is armed" }).toBe(true)
  const atNew = await page.evaluate(() => (window as any).__run((window as any).__due))
  const atOld = await page.evaluate(y => (document.body.scrollTo(0, y), (window as any).__run((window as any).__old)), base + 90)
  expect(new Set([atEdit, atNew, atOld]).size, 'three positions: at the edit, at the write of the new view, at the older timer').toBe(3)
  await release('go')
  await arrived('nothing to go back to', 'the return arrives')
  expect(await page.evaluate(() => [history.state.index, history.state.editorText, history.state.scrollPosition, (window as any)._history[1].scrollPosition]), "the kept edit pushed its entry, which holds the position of its own view's write").toEqual([1, '#e2e_source', atNew, atNew])
  expect((await keys()).slice(0, -1), 'a push from the held entry: its position and those before it').toEqual(positionsBefore.slice(0, -1))
  // a later timer of the new view, due after the arrival, writes that entry as well
  await expect.poll(() => page.evaluate(() => (window as any).__due.length > 0), { message: "the new view's later scroll: its write is armed" }).toBe(true)
  const atLast = await page.evaluate(() => (window as any).__run((window as any).__due))
  expect(await page.evaluate(() => [history.state.index, history.state.scrollPosition]), 'due after the arrival: the same entry').toEqual([1, atLast])
  expect(atLast).not.toBe(atNew)
  await page.evaluate(() => (window as any).__timers())
  expect(warnings).toEqual([])
})
