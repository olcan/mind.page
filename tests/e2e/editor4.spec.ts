import { expect, test, type Page } from '@playwright/test'
import { asUser, mindbox, focusMindbox, savedId, itemText, userSet, visible, createNavigationItems, scrollTop, headerTop, entries, scrollDown, nearTop, expand, focusMindboxInPlace, blur, settled, historyReads } from './editor_helpers.js'
import { firestore, loadAdmin, waitForApp } from './helpers.js'

// the editor suite's last rows, on a lane of their own (playwright.config.ts: `editor4`; cut from
// editor.spec.ts on 2026-11-21): a change of the document width, a dangling relative tag, a tall item's
// caret, focus rings, a label's <style>, an edit through a layout that moves it, and what a reload and a
// re-ranking add to the history. Serial over the lane's seeded anonymous account, as there: the rows build on
// each other's items (the dangling-tag row's among them) and on the navigation row's, which the first row
// here creates
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

// the items of editor.spec.ts's navigation row, which rows of this lane name (#e2e_source, #e2e_target and
// #e2e_target/sub): created first, as that row creates them
test("setup: the navigation row's items, created as editor.spec.ts creates them", async ({ page }) => {
  await createNavigationItems(page)
})

test('a change of the document width scrolls the item the query names back into view: at the layout at the new width and at the one its re-measured heights trigger; a scroll by hand or an Up after the first correction supersedes it; the window expires', async ({ page }) => {
  // the owner (2026-10-11): going full-screen and back lost the position, the reflow moving the items under
  // a scroll position that stays. A layout at a new document width opens a 2 s window in which every layout
  // brings the target back into view (updateItemLayout's scroll, through scrollToTarget: a no-op for a target
  // in view) unless the page was scrolled away from the position the last target scroll left (reflowCorrecting).
  // A page without a target is deferred.
  // THE FIXTURE: a root whose block is four viewport widths high (8000 px at 2000, 6000 at 1500, 4000 at
  // 1000), a middle item of a fixed height, and a short leaf, the query naming the leaf (the pinned items,
  // the root and the middle item list above it). The layout's balancing walk (layoutItems) puts the middle
  // item in the column the root is not in, and the leaf after it stays in that column only while it is at
  // most 450 px above the root's, or fits within 810 px of it (670 px for a short leaf). The middle item's
  // height is 7260 px plus the SPLIT, the root's column base less the other column's height, measured with
  // the root laid out (the seed's pinned items are not balanced: one is tall): at 2000 (the root 8000) the
  // leaf follows the middle item, 7260 < 8670; at 1500 (the root 6000) it goes to the root's column,
  // 7260 > 6670. The layout at a new width still uses the root's height of the old width, so the leaf changes
  // column only at the layout its re-measured height triggers (the reflow re-renders the items, their
  // afterUpdate re-measures, tryLayout runs 250 ms later, held 500 ms past a scroll): at 2000 the second
  // layout takes it from below the 8000 px root to below the middle item, 820 px up; at 1500 from below the
  // middle item to below the 6000 px root, 1180 px up. The root's block is read at every width (the
  // premise), and so is each layout (window.__layoutCount)
  const S = 2000 // two columns of 1000 px (the column's maximum width)
  const N = 1500 // two columns of 750 px (the minimum)
  await page.setViewportSize({ width: S, height: 900 })
  await loadAdmin(page)
  const names = ['#e2e_reflow', '#e2e_reflow/mid', '#e2e_reflow/mid/leaf'] as const
  const columns = () => page.evaluate(() => document.querySelectorAll('.column:not(.hidden)').length)
  const layouts = () => page.evaluate(() => (window as any).__layoutCount as number)
  const targetTop = () => page.evaluate(() => (document.querySelector('.super-container.target') as HTMLElement).offsetTop)
  // the target in the band a target scroll leaves alone (inScrollBand)
  const inBand = () =>
    page.evaluate(() => {
      const top = (document.querySelector('.super-container.target') as HTMLElement).offsetTop
      return top >= document.body.scrollTop && top <= document.body.scrollTop + visualViewport!.height - 200
    })
  const rootHeight = () =>
    page.evaluate(() => (document.getElementById('super-container-' + window._item('#e2e_reflow', true)!.id) as HTMLElement).offsetHeight)
  // no layout for `ms` (tryLayout's retry is 250 ms, its hold past a scroll 500 ms)
  const quiet = async (ms = 800) => {
    let last = await layouts()
    let since = Date.now()
    await expect
      .poll(
        async () => {
          const count = await layouts()
          if (count != last) [last, since] = [count, Date.now()]
          return Date.now() - since >= ms
        },
        { message: `no layout for ${ms} ms`, timeout: 20_000 }
      )
      .toBe(true)
  }
  // the view resized: the layout at the new width awaited, the root's block following the width (the premise)
  const resize = async (width: number) => {
    const before = await layouts()
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(layouts, { message: `the layout at ${width}`, timeout: 15_000 }).toBeGreaterThan(before)
    const height = await rootHeight()
    expect(height >= 4 * width && height < 4 * width + 300, `the root's block follows the width (${height} at ${width})`).toBe(true)
  }
  // a correction observed: the position at the tag click's destination (the target's top less a quarter of the
  // view, no higher than the header)
  const corrected = (message: string) =>
    expect
      .poll(
        () =>
          page.evaluate(() => {
            const target = document.querySelector('.super-container.target') as HTMLElement
            const destination = Math.max((document.querySelector('.header') as HTMLElement).offsetTop, target.offsetTop - visualViewport!.height / 4)
            return Math.abs(document.body.scrollTop - destination) <= 2
          }),
        { message, timeout: 10_000 }
      )
      .toBe(true)
  // the view resized for the phases that watch the layouts: the count before the resize anchors them (the
  // first layout is before + 1, the second before + 2, whenever each is observed)
  const reflowTo = async (width: number) => {
    const before = await layouts()
    // the 250 ms timers armed from the resize to the watcher's action are HELD (lane_races review 0): the
    // second layout is tryLayout's 250 ms timer, armed by the re-measure right after the first layout, and
    // on a loaded host it fired inside the four frames the watcher waits, so the premise "the second layout
    // not yet run" read one past (three of seven full gates, then twice alone); held, it runs after the
    // action (firstLayout releases it a frame later, the action's scroll event dispatched), where the app's
    // own rule, a layout waits 500 ms past a scroll, orders it as in production. A write the correction's
    // scroll arms is held and released the same way; clearTimeout on a held id drops it, as the real one
    await page.evaluate(() => {
      const w = window as any
      const held: { id: number; cb: (...args: unknown[]) => void; args: unknown[] }[] = (w.__heldTimers = [])
      const setTimeout_ = (w.__setTimeout = window.setTimeout)
      const clearTimeout_ = (w.__clearTimeout = window.clearTimeout)
      // the ids are unique across the row's four holds: a hold that restarted them handed a previous hold's
      // write id to tryLayout, and the next scroll's clearTimeout(historyUpdateTimer), the app's stale id,
      // dropped the held layout for good (layoutPending stuck; the editor lane once, "the second layout after
      // the Up" never came)
      w.__fakeTimerId ??= 1 << 30
      ;(window as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        ms == 250 ? (held.push({ id: ++w.__fakeTimerId, cb, args }), w.__fakeTimerId) : setTimeout_(cb, ms, ...args)
      ;(window as any).clearTimeout = (id?: number) => {
        const i = held.findIndex(h => h.id == id)
        i >= 0 ? held.splice(i, 1) : clearTimeout_(id)
      }
    })
    await page.setViewportSize({ width, height: 900 })
    return before
  }
  // THE FIRST LAYOUT, WATCHED FRAME BY FRAME IN THE PAGE: the frame the first layout's correction landed (the
  // position at the destination) or, with the target in the band, the frame of the layout itself; then
  // FOUR FRAMES LATER, once that layout's correction has flushed (a tick and two frames; a scroll inside
  // that gap is still overridden by the first correction, which is admitted whatever position the resize
  // left: a known limit of about 50 ms), the action: a scroll by hand to the top, or an Up (two modifiers,
  // the window handler) with its entry checked. Resolves with the count at the action (the second layout
  // comes about 270 ms after a first layout that scrolled nothing, 500 ms past a correction's scroll: a
  // poll from the test could read the count after it), the target's top at the first layout, and whether
  // the position held across the four frames (the first correction scrolled nothing more)
  const firstLayout = (before: number, action: 'none' | 'hand' | 'up' = 'none') =>
    page.evaluate(
      ({ before, action }) =>
        new Promise<{ count: number; top: number; at: boolean; inBand: boolean; held: boolean; pushed: boolean | null; heldTimers: number }>((resolve, reject) => {
          const w = window as any
          const started = Date.now()
          const tick = () => {
            const target = document.querySelector('.super-container.target') as HTMLElement | null
            if ((w.__layoutCount as number) > before && target) {
              const header = (document.querySelector('.header') as HTMLElement).offsetTop
              const top = target.offsetTop
              const position = document.body.scrollTop
              const at = Math.abs(position - Math.max(header, top - visualViewport!.height / 4)) <= 2
              const inBand = top >= position && top <= position + visualViewport!.height - 200
              if (at || inBand) {
                let frames = 4
                const act = () => {
                  if (--frames > 0) return requestAnimationFrame(act)
                  const held = Math.abs(document.body.scrollTop - position) <= 2
                  const count = w.__layoutCount as number
                  let pushed: boolean | null = null
                  if (action == 'hand') document.body.scrollTo(0, header)
                  if (action == 'up') {
                    const index = w._history_index as number // the Up's entry is the next index (the entry the row's Back left ahead goes)
                    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }))
                    pushed = w._history_index == index + 1 && w._history[w._history_index].scrolledToTop === true
                  }
                  // the hold of reflowTo ends a frame later, the action's scroll event dispatched: the wrappers
                  // removed, the held timers run (tryLayout's among them, which re-arms itself past the scroll)
                  requestAnimationFrame(() => {
                    window.setTimeout = w.__setTimeout
                    window.clearTimeout = w.__clearTimeout
                    const late = w.__heldTimers.splice(0) as { cb: (...args: unknown[]) => void; args: unknown[] }[]
                    late.forEach(h => h.cb(...h.args))
                    resolve({ count, top, at, inBand, held, pushed, heldTimers: late.length })
                  })
                }
                requestAnimationFrame(act)
                return
              }
            }
            if (Date.now() - started > 15_000) reject(new Error('no first layout with the target placed'))
            else requestAnimationFrame(tick)
          }
          tick()
        }),
      { before, action }
    )
  // the second layout, the one the re-measured root triggers, awaited inside the window
  const second = async (before: number, message: string) => {
    const t = Date.now()
    await expect.poll(layouts, { message, timeout: 5_000 }).toBeGreaterThanOrEqual(before + 2)
    expect(Date.now() - t, 'the second layout came inside the window').toBeLessThan(2000)
  }
  const rootFollows = async (width: number) => {
    const height = await rootHeight()
    expect(height >= 4 * width && height < 4 * width + 300, `the root's block follows the width (${height} at ${width})`).toBe(true)
  }
  const targeted = (id: string) =>
    expect.poll(() => page.evaluate(id => !!document.querySelector(`.super-container.target #item-${id}`), id), { timeout: 15_000 }).toBe(true)
  await expect.poll(columns, { timeout: 15_000 }).toBe(2)
  // the root first, laid out under its own query to measure the split (its pos is its column's height at its
  // placement, the header's included; the other column's height is its items' pos plus outerHeight)
  await page.evaluate(() => void window._create('#e2e_reflow\n\n<div style="height: 400vw"></div>'))
  await expect.poll(() => savedId(page, '#e2e_reflow'), { timeout: 30_000 }).toBeTruthy()
  const rootId = await page.evaluate(() => window._item('#e2e_reflow', true)!.id)
  await focusMindboxInPlace(page)
  await mindbox(page).fill('#e2e_reflow')
  await targeted(rootId)
  await quiet()
  const split = await page.evaluate(id => {
    const w = window as any
    const root = w.__items.find((item: any) => item.id == id)
    const others = w.__items.slice(0, w.__hideIndex).filter((item: any) => item.column != root.column)
    return root.pos - Math.max(0, ...others.map((item: any) => item.pos + item.outerHeight))
  }, rootId)
  const middle = Math.round(7260 + split)
  await page.evaluate(h => void window._create(`#e2e_reflow/mid\n\n<div style="height: ${h}px"></div>`), middle)
  await page.evaluate(() => void window._create('#e2e_reflow/mid/leaf the leaf'))
  for (const name of names) await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
  const id = await page.evaluate(() => window._item('#e2e_reflow/mid/leaf', true)!.id)
  await focusMindboxInPlace(page)
  await mindbox(page).fill('#e2e_reflow/mid/leaf')
  await targeted(id)
  await quiet()
  expect(await inBand(), "the query's own scroll put the leaf in view").toBe(true)
  await blur(page)
  // the leaf is then REACHED THROUGH BACK (review 4 of scroll_history): its view left for the first one (a
  // new entry: the query is cleared with a target selected) and restored. A restore holds its entry's
  // position through the layouts it causes and no longer, so every correction below is of a restored view
  // (marked as an explicit scroll, which lasts until the query changes, the restore suppressed them all)
  await asUser(page, () => void (window as any).MindBox.clear())
  await expect(mindbox(page)).toHaveValue('')
  await quiet()
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_reflow/mid/leaf')
  await targeted(id)
  await quiet()
  expect(await inBand(), 'Back restored the leaf in view').toBe(true)
  // 1. the owner's case, one column: the leaf lies far below the position left (the premise) and the layout
  // at the new width scrolls to its upper middle; the re-measured root moves nothing in one column
  const left1 = await scrollTop(page)
  await resize(1000)
  expect((await targetTop()) - left1, 'the premise: at the position left the leaf would lie below the view').toBeGreaterThan(700)
  await corrected('scrolled to the leaf at one column')
  await quiet()
  expect(await inBand(), 'the leaf in view at one column').toBe(true)
  // 2. two columns of 750: the leaf lands in the root's column at the layout at the new width and stays there
  await resize(N)
  await expect.poll(inBand, { message: 'the leaf in view at two columns of 750' }).toBe(true)
  await quiet()
  // 3. the layout the re-measure triggers: at 2000 the root grows by 2000 px above the leaf, which the layout at
  // the new width keeps in the root's column (the first correction); the re-measured root then sends the
  // leaf to the middle item's column, 820 px up and out of the band at the position the first correction
  // left (the premise); the second layout corrects again, inside the window
  const left3 = await scrollTop(page)
  const before3 = await reflowTo(S)
  const first3 = await firstLayout(before3)
  await rootFollows(S)
  expect([first3.count, first3.at, first3.held], 'the first correction, the second layout not yet run').toEqual([before3 + 1, true, true])
  expect(first3.top - left3, 'the premise: the leaf below the view at the position left').toBeGreaterThan(700)
  await second(before3, 'the layout the re-measured root triggers')
  await expect.poll(targetTop, { message: 'the second layout moved the leaf up, out of the band' }).toBeLessThan(first3.top - 225)
  await expect.poll(inBand, { message: 'the second correction brought the leaf back' }).toBe(true)
  await quiet()
  // 4. a scroll by hand after the layout at the new width supersedes the correction of the second layout: at
  // 1500 the leaf keeps its place at the first layout (the middle item's column, in view, nothing to
  // correct), the page is scrolled to the top four frames after that layout (its correction flushed, a
  // no-op), and the second layout, which moves the leaf to the root's column, leaves the page at the top
  const before4 = await reflowTo(N)
  const first4 = await firstLayout(before4, 'hand')
  await rootFollows(N)
  expect([first4.count, first4.inBand, first4.held], 'the premise: the leaf in view after the first layout, its correction a no-op, the second layout not yet run').toEqual([before4 + 1, true, true])
  await nearTop(page, 'scrolled to the top by hand')
  await second(before4, 'the second layout after the scroll by hand')
  await page.waitForTimeout(300) // the correction's flush (two frames) would have scrolled by now
  await nearTop(page, 'the scroll by hand survives the second layout')
  expect(await inBand(), 'the leaf out of view at the top: the second layout had something to correct').toBe(false)
  // 5. an Up (the scroll to the top with a history entry) after the first correction supersedes the second:
  // at 2000 the first layout corrects (the leaf back in the root's column, 2000 px lower), the Up follows four
  // frames after the correction landed, and the second layout leaves the page at the top with the entry Down
  // undoes intact (a settled query sets no explicitScrollQuery, so the Up relies on this)
  const before5 = await reflowTo(S)
  const first5 = await firstLayout(before5, 'up')
  await rootFollows(S)
  expect([first5.count, first5.at, first5.held, first5.pushed], 'the first correction, the second layout not yet run, the Up pushed its entry').toEqual([before5 + 1, true, true, true])
  await nearTop(page, 'the Up scrolled to the top')
  await second(before5, 'the second layout after the Up')
  await page.waitForTimeout(300)
  await nearTop(page, 'the Up survives the second layout')
  expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index].scrolledToTop), 'the entry Down undoes is intact').toBe(true)
  expect(await inBand(), 'the leaf out of view at the top').toBe(false)
  // 6. the window expires: at 1500 both corrections run from the top (the leaf out of view at the first layout,
  // moved up at the second); then, 2 s after the second with no scroll, the middle item's block shrinks to
  // 1000 px (selected inside its .content: the .item's first styled child is the menu placeholder) and its
  // model takes the container's measurement, the one onItemResized reads, so the measurement callback the
  // re-render triggers finds no change and no further layout follows; the layout on demand sends the leaf
  // to the middle item's column, above the position kept: nothing scrolls
  const before6 = await reflowTo(N)
  const first6 = await firstLayout(before6)
  await rootFollows(N)
  expect([first6.count, first6.at, first6.held], 'the first correction at 1500, from the top').toEqual([before6 + 1, true, true])
  await second(before6, 'the second layout at 1500')
  await expect.poll(inBand, { message: 'the second correction at 1500' }).toBe(true)
  const t6 = Date.now()
  await quiet(2200)
  expect(Date.now() - t6, 'the window expired').toBeGreaterThanOrEqual(2000)
  const position6 = await scrollTop(page)
  const shrunk = await page.evaluate(() => {
    const w = window as any
    const mid = w.__items.find((item: any) => item.label == '#e2e_reflow/mid')
    const container = document.getElementById('super-container-' + mid.id)!.querySelector('.container') as HTMLElement
    const block = container.querySelector('.item > .content div[style]') as HTMLElement
    block.style.height = '1000px'
    const measured = container.offsetHeight
    mid.height = measured
    const count = w.__layoutCount as number
    w.__layout()
    return { block: block.offsetHeight, measured, layouts: (w.__layoutCount as number) - count, count: w.__layoutCount as number }
  })
  expect(shrunk.block, 'the middle block shrunk').toBe(1000)
  expect(shrunk.measured >= 1000 && shrunk.measured < 1300, `the container measured with the block (${shrunk.measured})`).toBe(true)
  expect(shrunk.layouts, 'one layout ran').toBe(1)
  await expect.poll(targetTop, { message: 'the layout moved the leaf above the position kept (the premise)' }).toBeLessThan(position6)
  await page.waitForTimeout(300)
  expect(Math.abs((await scrollTop(page)) - position6), 'no correction after the window').toBeLessThanOrEqual(2)
  expect(await layouts(), 'no further layout: the measurement callback found the model consistent').toBe(shrunk.count)
  // the fixture, deleted by its saved ids and the deletions persisted (deleteDoc is fire-and-forget)
  const ids = await Promise.all(names.map(name => savedId(page, name)))
  await page.evaluate(names => names.forEach(name => window._item(name, true)!.delete(false)), [...names])
  for (const doc of ids) await expect.poll(async () => (await firestore().collection('items').doc(doc!).get()).exists, { timeout: 30_000 }).toBe(false)
})

test('a dangling relative tag neither ranks an item up nor counts as missing; an absolute missing tag still does both', async ({ page }) => {
  // the owner's report (2026-10-04): a chat child carrying `#//why_each_row`, a sibling no item has, kept
  // surfacing at the top of the list, as if its time were updated: the dangling tag sat in missingTags,
  // which ranks items by their count just before the time and gives them show-more prominence. The split
  // (index.svelte updateMissingTags): a resolved tag no item carries is DANGLING when every occurrence is
  // a relative token (danglingTags: the faded mark and nothing else) and MISSING when an absolute token
  // names it (missingTags: the red mark, the error border, the rank)
  await loadAdmin(page)
  const create = async (text: string, name: string) => {
    await page.evaluate(t => void window._create(t), text)
    await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
  }
  await create('#e2e_rank_c absolute #e2e_missing_rank', '#e2e_rank_c') // the oldest of the three: a missing absolute tag
  await create('#e2e_rank_a sibling #//nowhere_rank and #///nope', '#e2e_rank_a') // older than b: a dangling relative tag (a root's sibling: `#nowhere_rank`) and a token no label resolves
  await create('#e2e_rank_b plain', '#e2e_rank_b') // the newest, nothing missing
  const state = (name: string) =>
    page.evaluate(name => {
      const item = ((window as any).__items as any[]).find(item => item.label == name)!
      return { missing: item.missingTags, dangling: item.danglingTags }
    }, name)
  await expect.poll(() => state('#e2e_rank_a'), { message: 'a: dangling, not missing' }).toEqual({ missing: [], dangling: ['#nowhere_rank'] })
  expect(await state('#e2e_rank_c'), 'c: missing').toEqual({ missing: ['#e2e_missing_rank'], dangling: [] })
  expect(await state('#e2e_rank_b')).toEqual({ missing: [], dangling: [] })
  // the shown order: the missing one first (promoted over newer items), then by time, b before a (the old
  // state promoted a too, above c by time). The newest items sit behind the show-more cut while prominent
  // items fill it (c is pulled in by its prominence): expand until all three show
  const names = ['#e2e_rank_c', '#e2e_rank_b', '#e2e_rank_a']
  const showAll = async () => {
    for (let i = 0; i < 4; i++) {
      const shown = await visible(page)
      if (names.every(n => shown.includes(n)) || !(await page.locator('.toggle.show').count())) return shown
      await expand(page)
    }
    return visible(page)
  }
  const order = await showAll()
  const at = (name: string) => order.indexOf(name)
  expect(names.every(n => at(n) >= 0), `all three shown: ${order.join(' ')}`).toBe(true)
  expect(at('#e2e_rank_c'), 'the missing tag promotes c').toBeLessThan(at('#e2e_rank_b'))
  expect(at('#e2e_rank_b'), 'the dangling tag does not promote a over the newer b').toBeLessThan(at('#e2e_rank_a'))
  // the marks and borders: a's faded dangling marks with the tokens as written (the sibling resolved by the
  // shared resolver to `#nowhere_rank`, as the item's tags are, not to a child of a; the unresolvable `#///nope`
  // dangling too) and no error border; c's red missing mark with the border
  const marks = (name: string) =>
    page.evaluate(name => {
      const elem = window._item(name, true)!.elem!
      return {
        marks: [...elem.querySelectorAll('.content mark:not(.label)')].map(m => [m.textContent, m.className]),
        error: !!elem.querySelector('.container.error'),
      }
    }, name)
  await expect.poll(() => marks('#e2e_rank_a'), { message: "a's marks" }).toEqual({ marks: [['#//nowhere_rank', 'dangling'], ['#///nope', 'dangling']], error: false })
  await expect.poll(() => marks('#e2e_rank_c'), { message: "c's marks" }).toEqual({ marks: [['e2e_missing_rank', 'missing']], error: true })
  // once a sibling named #nowhere_rank exists, a's tag is carried: the mark goes live, nothing dangling
  await create('#nowhere_rank now here', '#nowhere_rank')
  await expect.poll(() => state('#e2e_rank_a')).toEqual({ missing: [], dangling: [] })
  await showAll() // the layout re-ran: a may sit behind the cut again
  await expect.poll(() => marks('#e2e_rank_a').then(m => m.marks)).toEqual([['nowhere_rank', ''], ['#///nope', 'dangling']])
})

test("ctrl+arrows in a tall item bring the caret's edge into view", async ({ page }) => {
  // the textarea is as tall as its text, so the caret moved to the start or end sits at its top or
  // bottom edge, possibly far outside the viewport: the Ctrl move brings that edge into view (review 0
  // B1 of arrow_edges: a plain scroll, no history entry; the next press is still the edge jump)
  await loadAdmin(page)
  const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n\n')
  await page.evaluate(body => void window._create(`#e2e_tall/pad ${body}`), body) // a child of the item, for the page to continue below the editor
  await expect.poll(() => savedId(page, '#e2e_tall/pad'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(body => void window._create(`#e2e_tall ${body}`), body)
  await expect.poll(() => savedId(page, '#e2e_tall'), { timeout: 30_000 }).toBeTruthy()
  await userSet(page, '#e2e_tall', { scroll: true })
  const id = await page.evaluate(() => window._item('#e2e_tall', true)!.id)
  await expect.poll(() => page.evaluate(id => !!document.querySelector(`#item-${id} p`), id), { timeout: 15_000 }).toBe(true)
  const paragraph = page.locator(`#item-${id} p`).nth(30)
  await paragraph.scrollIntoViewIfNeeded()
  const box = (await paragraph.boundingBox())!
  await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
  const textarea = page.locator(`#textarea-${id}`)
  await expect(textarea).toBeFocused()
  // the caret in the middle of the text, the textarea's edges both outside the viewport
  const rect = () => page.evaluate(id => {
    const r = document.getElementById(`textarea-${id}`)!.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, height: innerHeight }
  }, id)
  await page.evaluate(id => {
    const t = document.getElementById(`textarea-${id}`) as HTMLTextAreaElement
    t.setSelectionRange(Math.floor(t.value.length / 2), Math.floor(t.value.length / 2))
    const r = t.getBoundingClientRect()
    document.body.scrollBy(0, r.top + r.height / 2 - innerHeight / 2) // the middle of the textarea mid-viewport
  }, id)
  const before = await rect()
  expect(before.top < 0 && before.bottom > before.height, 'both edges outside the viewport').toBe(true)
  const [length] = await entries(page)
  await page.keyboard.press('Control+ArrowUp')
  await expect(textarea).toBeFocused()
  // within a pixel: scrollIntoView lands on a fractional scroll position (-0.44 px seen)
  await expect.poll(async () => (await rect()).top, { message: 'the top edge in view' }).toBeGreaterThanOrEqual(-1)
  expect((await rect()).top).toBeLessThan(before.height)
  expect(await page.evaluate(id => (document.getElementById(`textarea-${id}`) as HTMLTextAreaElement).selectionEnd, id)).toBe(0)
  await page.keyboard.press('Control+ArrowDown')
  await expect(textarea).toBeFocused()
  await expect.poll(async () => (await rect()).bottom, { message: 'the bottom edge in view' }).toBeLessThanOrEqual(before.height + 1)
  expect((await rect()).bottom).toBeGreaterThan(0)
  expect(await page.evaluate(id => {
    const t = document.getElementById(`textarea-${id}`) as HTMLTextAreaElement
    return t.selectionStart == t.value.length
  }, id)).toBe(true)
  expect((await entries(page))[0], 'plain scrolls: no history entry').toBe(length)
  // the editor left ENTIRELY past a boundary (review 1): below the viewport after a scroll to the top,
  // ⌃↑ brings its top edge back; above the viewport after a scroll to the bottom, ⌃↓ brings its bottom
  // edge back. The child is hidden past hideIndex while editing, so it is shown through the toggle first
  // (the click leaves the editor open; it is refocused in place), which keeps the page scrollable past the editor
  await page.evaluate(top => document.body.scrollTo(0, top), await headerTop(page))
  expect((await rect()).top, 'the editor entirely below the viewport').toBeGreaterThan(before.height)
  await expect(textarea).toBeFocused()
  await page.keyboard.press('Control+ArrowUp')
  await expect.poll(async () => (await rect()).top, { message: 'the top edge back in view' }).toBeLessThan(before.height)
  expect((await rect()).top).toBeGreaterThanOrEqual(-1)
  await page.locator('.toggle.show').first().click()
  await expect
    .poll(() => page.evaluate(() => !!document.querySelector(`#super-container-${window._item('#e2e_tall/pad', true)!.id}`)), { timeout: 15_000 })
    .toBe(true)
  await page.evaluate(id => (document.getElementById(`textarea-${id}`) as HTMLTextAreaElement).focus({ preventScroll: true }), id)
  await expect(textarea).toBeFocused()
  await page.evaluate(() => document.body.scrollTo(0, document.body.scrollHeight))
  expect((await rect()).bottom, 'the editor entirely above the viewport').toBeLessThan(0)
  await page.keyboard.press('Control+ArrowDown')
  await expect.poll(async () => (await rect()).bottom, { message: 'the bottom edge back in view' }).toBeGreaterThan(0)
  expect((await rect()).bottom).toBeLessThanOrEqual(before.height + 1)
  expect((await entries(page))[0], 'still no history entry').toBe(length)
  await page.keyboard.press('Escape') // nothing edited: the editor closes
  await expect(textarea).toBeHidden()
})

test('no link on the page shows a focus ring', async ({ page }) => {
  // the ring showed on a link after the window returned from another app (the owner, 2026-09-29);
  // the rule is the page's, so an ordinary link of an item and one outside every item lose it alike
  await loadAdmin(page)
  await page.evaluate(() => void window._create('#e2e_link_ring see [the proposal](https://example.com/proposal)'))
  await expect.poll(() => savedId(page, '#e2e_link_ring'), { timeout: 30_000 }).toBeTruthy()
  await userSet(page, '#e2e_link_ring', { scroll: true })
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_link_ring', true)?.elem?.querySelector('a[href*="example.com"]')), { timeout: 15_000 }).toBe(true)
  const rings = await page.evaluate(() => {
    const ring = (a: HTMLAnchorElement) => {
      a.focus()
      return [document.activeElement === a, getComputedStyle(a).outlineStyle]
    }
    const inItem = window._item('#e2e_link_ring', true)!.elem!.querySelector('a[href*="example.com"]') as HTMLAnchorElement
    const outside = document.body.appendChild(Object.assign(document.createElement('a'), { href: 'https://example.com/outside', textContent: 'outside' }))
    const result = { inItem: ring(inItem), outside: ring(outside) }
    outside.remove()
    return result
  })
  expect(rings).toEqual({ inItem: [true, 'none'], outside: [true, 'none'] })
})

test('a <style> after the label keeps the header minimal and applies as item-specific css; visible html after the label does not', async ({ page }) => {
  // item-specific css lives in a <style> whose #item the renderer rewrites to the element's id
  // (Item.svelte); html BEFORE the label is moved off the label line into its own block, so the
  // place for it is after the label on the first line, where it has no box and must not unset
  // headerMinimal, which the #chat styles float a chat's role header beside (the owner,
  // 2026-10-10: the header dropped a line whenever a chat carried such a style)
  await loadAdmin(page)
  await page.evaluate(() =>
    window._create(
      ['#e2e_hdr_style <style> #item .e2e_hdr_probe { color: rgb(1, 2, 3) } </style>', 'body <span class="e2e_hdr_probe">probe</span>'].join('\n')
    )
  )
  await page.evaluate(() => void window._create('#e2e_hdr_span <span>after</span>'))
  await expect.poll(() => savedId(page, '#e2e_hdr_style'), { timeout: 30_000 }).toBeTruthy()
  await expect.poll(() => savedId(page, '#e2e_hdr_span'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(() => void (location.hash = '#e2e_hdr_style')) // bring it up so it renders
  const probe = page.locator('.e2e_hdr_probe')
  await expect(probe).toBeVisible({ timeout: 30_000 })
  await expect(probe, 'the style applies to the item').toHaveCSS('color', 'rgb(1, 2, 3)')
  const elemId = (name: string) => page.evaluate(name => window._item(name, true)?.id ?? null, name) // the element id is the item's id
  await expect(page.locator(`#item-${await elemId('#e2e_hdr_style')}`)).toHaveClass(/\bheaderMinimal\b/)
  await page.evaluate(() => void (location.hash = '#e2e_hdr_span'))
  const span = page.locator(`#item-${await elemId('#e2e_hdr_span')}`)
  await expect(span).toBeVisible({ timeout: 30_000 })
  await expect(span, 'visible html after the label is not minimal').not.toHaveClass(/\bheaderMinimal\b/)
})

test('an item being edited keeps its unsaved text, its selection and its focus through a layout that moves it to another column, in both directions; the save carries the text', async ({ page }) => {
  // the owner (2026-10-13): "sometimes when i'm editing an item and haven't saved yet and there is a layout
  // event and items move around, the text in the item gets reverted to the saved text as if the unsaved
  // edits were lost. i can recover the unsaved edits by hitting close button and then choosing cancel when
  // prompted about unsaved edits". The items render per column (index.svelte: a keyed each over the items
  // inside a block per column), and a keyed each cannot move a component between two blocks: an item a
  // layout moves to another column is destroyed in one block and created in the other, its Item and
  // Editor with it, and the new textarea seeded from the SAVED text prop (the draft lived on in
  // item.editorText, bound to the model, which the close button's Cancel assigned back to item.text: the
  // recovery). Now the Editor stashes its textarea's state at its destroy (editorStates in Editor.svelte)
  // and the Editor created in its place resumes it (the Item created while editing asks for it, and the
  // entry's draft is the model's): the value and the selection with its direction, read at the destroy
  // from the DETACHED element (which keeps them), and the focus, the destroyed editor's own, which its
  // removal blur (fired while the element is still connected in Chromium) settles a microtask later.
  // THE FIXTURE: a root with a 1200 px block and a short leaf, the query naming the leaf (the root lists
  // above it): at two columns the root fills column 0 past the balancing threshold (layoutItems: half a
  // screen height over the other column), so the leaf opens column 1; at one column every item is in
  // column 0. The viewport crosses the two-column threshold (750 px a column) both ways.
  await page.setViewportSize({ width: 1600, height: 900 }) // floor(1600 / 750) = 2 columns
  await loadAdmin(page)
  await page.evaluate(() => void window._create('#e2e_remount\n\n<div style="height: 1200px"></div>'))
  await page.evaluate(() => void window._create('#e2e_remount/leaf draft survives'))
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_remount/leaf')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_remount/leaf', true)?.elem), { timeout: 10_000 }).toBe(true)
  const id = await page.evaluate(() => window._item('#e2e_remount/leaf')!.id)
  const textarea = page.locator(`#textarea-${id}`)
  const column = () => page.evaluate(id => window.__items.find(item => item.id == id)!.column as number, id)
  const columns = () => page.evaluate(() => document.querySelectorAll('.column:not(.hidden)').length)
  // the textarea's state, the value ZWSP-insensitive as the suite compares; `fresh` tells an element a
  // remount created from the one stamped before (the locator resolves to whichever is in the document)
  const state = () =>
    textarea.evaluate((t: HTMLTextAreaElement) => ({
      value: t.value.replaceAll('​', ''),
      start: t.selectionStart,
      end: t.selectionEnd,
      direction: t.selectionDirection,
      focused: document.activeElement === t,
      fresh: !(t as any).__stamped,
    }))
  const stamp = () => textarea.evaluate((t: HTMLTextAreaElement) => void ((t as any).__stamped = true))
  expect(await columns()).toBe(2)
  expect(await column(), 'the leaf opens column 1 at two columns (the premise)').toBe(1)
  // the live item's paragraph (the measuring column is hidden), clicked at its center, past its label tag
  // (a tag navigates); the click auto-waits, since the item re-renders after the save below and an explicit
  // box read null for a moment in the lane
  const paragraph = page.locator(`.column:not(.hidden) #item-${id} p`).first()
  const clickParagraph = () => paragraph.click()
  await clickParagraph()
  await expect(textarea).toBeFocused()
  await stamp()
  await textarea.press('ControlOrMeta+a')
  await textarea.pressSequentially('#e2e_remount/leaf draft survives typed')
  for (let i = 0; i < 3; i++) await textarea.press('Shift+ArrowLeft') // a backward selection over "ped"
  const typed = await state()
  expect(typed).toEqual({ value: '#e2e_remount/leaf draft survives typed', start: 35, end: 38, direction: 'backward', focused: true, fresh: false })
  for (const [width, count, target] of [
    [900, 1, 0],
    [1600, 2, 1],
  ] as const) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(columns, { message: `${count} column(s) at ${width}`, timeout: 15_000 }).toBe(count)
    await expect.poll(column, { message: `the leaf moved to column ${target} at ${width}`, timeout: 15_000 }).toBe(target)
    await expect.poll(state, { message: `the editor's state at ${width}`, timeout: 5_000 }).toEqual({ ...typed, fresh: true })
    await stamp()
  }
  await page.keyboard.press('Shift+Enter') // save
  await expect(textarea).toBeHidden()
  const saved = '#e2e_remount/leaf draft survives typed'
  await expect.poll(() => itemText(page, '#e2e_remount/leaf')).toBe(saved)
  // the save persisted before the discard below: a cancel while the item is still saving discards without
  // the prompt (onItemEditing), which the lane's load made ordinary
  await expect
    .poll(
      () =>
        page.evaluate(id => {
          const item = window.__items.find(item => item.id == id)!
          return !item.saving && item.savedText
        }, id),
      { timeout: 30_000 }
    )
    .toBe(saved)
  // a later session of the Item the remount created does not resume the entry the saved session's end
  // wrote (the Item withdraws the resume at that end; review 1: kept for the Item's life, it brought the
  // entry back at every later edit): a re-edit opens on a fresh element at the Item's retained selection
  // (pre-existing: a click sets no caret), a suffix is typed from a collapsed caret and discarded, and the
  // next re-edit shows the SAVED text with a collapsed caret, not the entry's draft and backward range
  await clickParagraph()
  await expect(textarea).toBeFocused()
  await expect.poll(state).toEqual({ value: saved, start: 35, end: 38, direction: expect.any(String), focused: true, fresh: true })
  await stamp()
  await textarea.press('ArrowRight') // collapses the selection to its end (End scrolls on a Mac)
  await textarea.pressSequentially(' discarded')
  await page.keyboard.press('Escape')
  await expect(page.getByText(/Discard unsaved changes to #e2e_remount\/leaf/)).toBeVisible()
  await page.locator('.modal .button.confirm', { hasText: 'Discard' }).click()
  await expect(textarea).toBeHidden()
  await expect.poll(() => itemText(page, '#e2e_remount/leaf')).toBe(saved)
  await clickParagraph()
  await expect(textarea).toBeFocused()
  await expect.poll(state, { message: 'the re-edit after the discard' }).toEqual({ value: saved, start: 38, end: 38, direction: expect.any(String), focused: true, fresh: true })
  expect((await state()).direction, 'not the entry\'s backward range').not.toBe('backward')
  await page.keyboard.press('Escape') // nothing to discard
  await expect(textarea).toBeHidden()
  // the fixture, deleted by its saved ids and the deletions persisted (deleteDoc is fire-and-forget)
  const names = ['#e2e_remount', '#e2e_remount/leaf']
  for (const name of names) await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
  const ids = await Promise.all(names.map(name => savedId(page, name)))
  await page.evaluate(names => names.forEach(name => window._item(name, true)!.delete(false)), names)
  for (const doc of ids) await expect.poll(async () => (await firestore().collection('items').doc(doc!).get()).exists, { timeout: 30_000 }).toBe(false)
})

// A RELOAD ON A FINAL KEPT ENTRY OF THE FULL LIST ADDS NO HISTORY ENTRY (the owner, 2026-11-18: "a reload w/o a
// query seems to add a (duplicate, no-op) step"). A launch on the entry the browser kept for it compares the
// order it loads with the one the entry recorded, and after most sessions the two differ: the session's soft
// touches are gone after a reload, and an item changed since ranks by its new time. On a FINAL entry of the
// empty query (a launch's first view, a click on the tag the query names) the launch pushed its first view after
// it, a second entry of the same list, and dropped the entries ahead. It takes that entry over now, replaced
// where it is by the view it loads (`launch` in index.svelte's onEditorChange); a re-ranking within the session
// is a new entry as before, except on the launch's own first view, whose entry it is written over (`first`).
// the browser's list of positions by key, the one it is on and what the entry there holds
const places = (page: Page) =>
  page.evaluate(() => {
    const nav = (window as any).navigation
    const { index, run, editorText, final, orderHash } = history.state
    return { keys: nav.entries().map((e: any) => e.key) as string[], at: nav.currentEntry.key as string, state: { index, run, editorText, final, orderHash } }
  })
// the order of the items as the page ranks them now, as an entry records it
const orderShown = (page: Page) => page.evaluate(() => (window as any)._hash((window as any).__items.map((item: any) => item.id).join()) as string)
// a typed query's entry, then a tag click's from its item (final), over the navigation row's items, each at a position of its own
const typedThenTag = async (page: Page, { recorded, place }: ReturnType<typeof historyReads>) => {
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_source')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  await blur(page)
  await place(40)
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  const tag = page.locator(`#item-${sourceId} mark[title="#e2e_target"]`)
  await tag.scrollIntoViewIfNeeded()
  await recorded()
  await tag.click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  return place(80)
}

// The kept entry is a real one in the middle of the browser's list: a final entry of the empty query (a click
// on the tag the query names), a tag's entry behind it and a query's ahead. What the reload finds different is
// installed by the row, a STALE ORDER on that entry (what any change of the notebook since the entry was
// written leaves), in the same browser turn as the reload, so that nothing of the page's can write the entry in
// between; the row's listener notes at `pagehide` that the entry still held it, and the baseline is read in
// that turn. (From the dropped change of 2026-11-18, run noop_entries, whose first shape of the row rewrote an
// item behind an offline page: the page took the change before the reload in one run of six, review 9 of
// scroll_history. A change that arrives from another client is the next row's.)
test('a reload on a kept first view whose order differs adds no history entry: the entry is taken over where it is by the view loaded, the entry ahead is kept and Back goes where it went before the reload', async ({ page }) => {
  const reads = historyReads(page)
  const { recorded, place, shows } = reads

  await loadAdmin(page)
  const top = await headerTop(page)
  await typedThenTag(page, reads)
  // the first view again, in a final entry of its own: a click on the tag the query names, on its own item
  const targetId = await page.evaluate(() => window._item('#e2e_target')!.id)
  const label = page.locator(`#item-${targetId} mark[title="#e2e_target"]`).first()
  await label.scrollIntoViewIfNeeded()
  await recorded()
  const atTag = await scrollTop(page)
  await label.click()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  // an entry ahead of it, left at a position of its own: a query set from a blurred box; then Back
  await blur(page)
  await userSet(page, '#e2e_source')
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  const atAhead = await place(60)
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  await settled(page)

  // the stale order and the reload in ONE turn, the baseline read in it (kept across the reload with the
  // order the entry held when the page went away)
  const read = () => {
    const nav = (window as any).navigation
    const { index, run, editorText, final, orderHash } = history.state
    return { keys: nav.entries().map((e: any) => e.key) as string[], at: nav.currentEntry.key as string, state: { index, run, editorText, final }, orderHash: orderHash as string }
  }
  await page
    .evaluate(read => {
      sessionStorage.setItem('e2e_kept_before', JSON.stringify(new Function(`return (${read})()`)()))
      window.addEventListener('pagehide', () => sessionStorage.setItem('e2e_kept_order', String(history.state?.orderHash)))
      history.replaceState({ ...history.state, orderHash: 'stale' }, '')
      location.reload()
    }, read.toString())
    .catch(() => undefined) // (the turn's result can be lost to the navigation it starts: the two notes below say that it ran)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('e2e_kept_order')).catch(() => null), { message: 'premise: the page went away with the stale order on its entry', timeout: 30_000 }).toBe('stale')
  await waitForApp(page)
  const before = JSON.parse((await page.evaluate(() => sessionStorage.getItem('e2e_kept_before')))!) as ReturnType<typeof read>
  expect(before.state, 'premise: a final entry of the empty query').toMatchObject({ editorText: '', final: true })
  expect(before.keys.indexOf(before.at), 'premise: one entry ahead of it').toBe(before.keys.length - 2)
  expect(before.keys.length, 'premise: and entries behind it').toBeGreaterThan(3)

  // THE RELOAD ADDED NOTHING: the same positions, the browser on the same one, the entry its own (index, run,
  // query, final), and its order the one loaded
  await shows('', top, 'the reloaded page shows the first view at the header')
  await settled(page)
  const after = await page.evaluate(read => new Function(`return (${read})()`)() as any, read.toString())
  expect({ keys: after.keys, at: after.at, state: after.state }, 'a reload on a kept first view of another order: no entry added, the entry where and what it was').toEqual({ keys: before.keys, at: before.at, state: before.state })
  expect([after.orderHash, before.orderHash == 'stale'], 'the entry holds the order loaded (the baseline held its own)').toEqual([await orderShown(page), false])

  // both neighbours as before the reload: Forward onto the entry ahead (a push would have dropped it), Back
  // from the first view onto the tag's entry, at its position
  await recorded()
  await page.goForward()
  await shows('#e2e_source', atAhead, 'Forward onto the entry ahead of the first view')
  await page.goBack()
  await shows('', top, 'Back to the first view')
  await page.goBack()
  await shows('#e2e_target ', atTag, 'Back from the first view, as before the reload')
})

// A CHANGE FROM ANOTHER CLIENT changes the list's order, a re-ranking within the session that no user action
// triggered. On the LAUNCH'S OWN first view (the entry the launch wrote or took over) it is written over that
// entry, which stays final, since the first change of 2026-11-19 (`first` in index.svelte's onEditorChange): until
// then it pushed an entry there, and an order change as a page started left a second entry of the same query after
// that reload (the next row). On a final first view that is NOT the launch's (the full list reached by a click on
// the tag the query names) it was a new entry of the same query until the second change of that day, which writes
// every change that is not the user's over the entry the browser is on (the row after the next). And the owner's
// case of 2026-11-18 without an installed order: Back onto the first view, whose entry holds the order from before
// a change made while the browser was on the entry ahead, and a reload there, which loads the change's order: no
// entry added, the entry ahead stays (the launch takes the entry over), and it still does after a further change,
// which the reloaded page writes over its own entry (a push dropped it). The item changed is the one ranked last
// among the unpinned (a new time, its text as it was): it moves up, so the order changes wherever it is shown
test("a change from another client is written over a final first view, the launch's own, which keeps its mark of Up and its narration's choice, and another one; a reload on the first view that Back left it on adds none, and the entry ahead stays, through a change after the reload too; a list opened again at the launch entry's index too", async ({ page }) => {
  const reads = historyReads(page)
  const { recorded, place, shows } = reads
  await loadAdmin(page)
  const top = await headerTop(page)
  await shows('', top, 'the first view at the header')
  await recorded()
  const change = async () => {
    const saved = await page.evaluate(() => [...(window as any).__items].reverse().find((item: any) => !item.pinned && !item.log && item.savedId).savedId as string)
    await firestore().collection('items').doc(saved).update({ time: Date.now() })
  }
  // on a final first view, the launch's own or another: the entry where it was, final, of the order the change gave
  const changedInPlace = async (message: string) => {
    const before = await places(page)
    await change()
    await expect.poll(async () => (await places(page)).state.orderHash, { message: `${message}: the change re-ranked the page`, timeout: 30_000 }).not.toBe(before.state.orderHash)
    await settled(page)
    expect(await places(page), `${message}: no entry added, the entry updated where it is and still final`).toEqual({ ...before, state: { ...before.state, orderHash: await orderShown(page) } })
  }

  // THE LAUNCH'S ENTRY WITH WHAT IS ITS OWN TO KEEP (review 0 of reload_rerank, B3): an entry that Up made,
  // whose mark is what lets Down undo the Up, and which holds a narration's choice that is not the page's
  // live one (`intro`: the lane's page does not narrate, so its live value is false, and the row installs
  // `true` on the entry in the turn of the reload; entry 0 always holds true, this one is entry 1), reloaded
  // on with its order unchanged: the launch writes nothing and leaves both. A re-ranking written over the
  // entry wrote the page's whole view until that review: the mark gone, the live choice saved over the entry's
  const below = await scrollDown(page)
  await recorded()
  await blur(page)
  await page.keyboard.press('Control+Meta+ArrowUp')
  await nearTop(page, 'Up: the top of the page, in an entry of its own')
  await recorded()
  await page
    .evaluate(() => {
      window.addEventListener('pagehide', () => sessionStorage.setItem('e2e_up_left', String(history.state?.scrolledToTop)))
      history.replaceState({ ...history.state, intro: true }, '')
      location.reload()
    })
    .catch(() => undefined) // (the turn's result can be lost to the navigation it starts)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('e2e_up_left')).catch(() => null), { message: "premise: the page went away on Up's entry", timeout: 30_000 }).toBe('true')
  await waitForApp(page)
  await shows('', top, 'the reloaded page shows the first view at the header')
  await settled(page)
  await recorded()
  const own = () => page.evaluate(() => (({ scrolledToTop, intro, final, editorText }) => ({ scrolledToTop, intro, final, editorText }))(history.state))
  const marked = await own()
  expect(marked, "premise: a reload that changes nothing leaves Up's entry as it was: its mark, its narration's choice, final").toEqual({ scrolledToTop: true, intro: true, final: true, editorText: '' })
  expect((await places(page)).state.index, 'premise: and it is not entry 0, which always holds the intro').toBeGreaterThan(0)

  // a change on the launch's first view is written over its entry, which keeps what is its own
  await changedInPlace("a change from another client on the launch's first view")
  expect(await own(), "the launch's entry keeps its mark of Up and its narration's choice through the re-ranking written over it").toEqual(marked)
  // so Down still undoes the Up, once the session knows the entry below (a reloaded session holds the entry
  // it was reloaded on alone): a visit, then Down from the top is Back to the position Up left
  await page.goBack()
  await shows('', below, 'Back onto the view Up left, where it was left')
  await page.goForward()
  await shows('', top, "Forward onto Up's entry")
  await recorded()
  await blur(page)
  await page.keyboard.press('Control+Meta+ArrowDown')
  await shows('', below, 'Down undoes the Up: Back to the position it left')
  await recorded()

  // a first view that is not the launch's, final too (a click on the tag the query names): a change there is
  // written over it as well (until the second change of 2026-11-19: a new entry). Then an entry ahead of it (a
  // query set from a blurred box), a change while the browser is on that one, and Back onto the first view
  await typedThenTag(page, reads)
  const targetId = await page.evaluate(() => window._item('#e2e_target')!.id)
  const label = page.locator(`#item-${targetId} mark[title="#e2e_target"]`).first()
  await label.scrollIntoViewIfNeeded()
  await recorded()
  await label.click()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  const list = await places(page)
  expect(list.state, "premise: a first view that is not the launch's, final").toMatchObject({ editorText: '', final: true })
  await changedInPlace("a change from another client on a first view that is not the launch's")
  await recorded()
  const atList = await scrollTop(page)
  await blur(page)
  await userSet(page, '#e2e_source')
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await place(60)
  const ahead = await places(page)
  await change()
  await expect.poll(async () => (await places(page)).state.orderHash, { message: 'the change re-ranked the entry ahead', timeout: 30_000 }).not.toBe(ahead.state.orderHash)
  await page.goBack()
  await shows('', atList, 'Back onto the first view')
  await recorded()
  const kept = await places(page)
  expect({ keys: kept.keys, state: { ...kept.state, orderHash: undefined } }, 'premise: the first view as it was, the entry ahead of it').toEqual({ keys: ahead.keys, state: { ...list.state, orderHash: undefined } })
  expect(kept.state.orderHash, 'premise: the entry holds the order from before the change').not.toBe(await orderShown(page))

  // the reload: no entry added, the entry where and what it was, of the order loaded; the entry ahead
  await page.reload()
  await waitForApp(page)
  await shows('', top, 'the reloaded page shows the first view at the header')
  await settled(page)
  const reloaded = await places(page)
  expect({ ...reloaded, state: { ...reloaded.state, orderHash: kept.state.orderHash } }, 'a reload on the first view: no entry added, the entry where and what it was').toEqual(kept)
  expect(reloaded.state.orderHash, 'the entry holds the order loaded').toBe(await orderShown(page))
  await recorded()

  // the entry is the reloaded page's own first view now: a change is written over it, and the entry ahead stays
  await changedInPlace('a change from another client after the reload')
  await recorded()
  await page.goForward()
  await expect(mindbox(page), 'Forward onto the entry ahead from before the reload').toHaveValue('#e2e_source')
  expect((await places(page)).at, 'the entry ahead, kept').toBe(ahead.at)
  await page.goBack()
  await shows('', top, 'Back onto the first view again')

  // A NEW BRANCH (review 0 of reload_rerank, B1): Back onto the tag's view and a click on the tag's own label
  // open the full list again, in a new final entry at the launch entry's index and in its run (another position
  // of the browser's: its key). A change there is written over it as over any final entry since the second change
  // of 2026-11-19 (until then a new entry after it); that the list is not the launch's (`first`) is told by the
  // user's own re-ranking there, a step: at the end of this row
  await recorded()
  const launched = await places(page)
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await label.scrollIntoViewIfNeeded()
  await recorded()
  await label.click()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  const reopened = await places(page)
  expect(
    [reopened.state.run, reopened.state.index, reopened.state.editorText, reopened.state.final, reopened.at == launched.at],
    "the list opened again: the launch entry's run and index, the empty query, final, at another position of the browser's"
  ).toEqual([launched.state.run, launched.state.index, '', true, false])
  await changedInPlace('a change from another client on the list opened again')
  // and the user's own re-ordering there is a step: the list opened again is not the launch's, whose user's
  // re-ordering is written over it (`first`: the mark is cleared by the push that opened this list)
  await moveUp(page)
  const moved = await places(page)
  expect([moved.keys.indexOf(moved.at), moved.state.editorText, moved.state.final], "the user's re-ordering on the list opened again: a new entry right after it").toEqual([moved.keys.indexOf(reopened.at) + 1, '', false])
})

// A RE-RANKING AS THE PAGE STARTS (the owner on the release of 2026-11-18: "i'm still seeing a reload on empty
// mindbox, with #vault in back, adds another empty step, so i have to hit back twice on reload to get to
// #vault"). The launch writes or takes over a FINAL entry, and the first ranking after it whose order differed
// pushed one more entry of the same query (history compares the ordered item ids): item code that touches an
// item or marks one as the page starts, a change from another client, a ranking that counts a missing tag
// which the launch ranked without, where the count moves the item. The fixture is an item whose `_init`
// touches itself (a soft touch, gone with every reload, and the item's saved time is old: every launch of a
// page that holds it changes the order while the page is still initializing), written behind the app before
// the page loads. The re-ranking is written
// over the launch's entry, which STAYS FINAL: written as a re-ranking's own view is, not final, the next typed
// query would replace the full list instead of following it
test("a re-ranking as a reloaded page starts adds no history entry on the full list: the entry is updated where it is, the entry ahead is kept and Back reaches the tag's view behind in one step; the entry stays final, so a query typed on it is a new entry and Back from that returns to the full list; a re-ranking while that Back is restoring the entry leaves it its own position", async ({ page }) => {
  const reads = historyReads(page)
  const { recorded, place, shows } = reads
  const fixture = await firestore()
    .collection('items')
    .add({ user: 'anonymous', time: Date.UTC(2021, 0, 1), attr: null, text: '#e2e_startup_touch #_init\n```js\nfunction _init() { _this.touch() }\n```' })
  const touched = () =>
    page.evaluate(() => {
      const item = (window as any).__items.find((item: any) => item.label == '#e2e_startup_touch')
      return item.time > item.savedTime
    })

  await loadAdmin(page)
  const top = await headerTop(page)
  expect(await touched(), 'premise: the item code touched its item as the page started').toBe(true)
  await typedThenTag(page, reads)
  // the full list in a final entry of its own (a click on the tag the query names), an entry ahead of it left
  // at a position of its own (a query set from a blurred box), then Back onto the full list
  const targetId = await page.evaluate(() => window._item('#e2e_target')!.id)
  const label = page.locator(`#item-${targetId} mark[title="#e2e_target"]`).first()
  await label.scrollIntoViewIfNeeded()
  await recorded()
  const atTag = await scrollTop(page)
  await label.click()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  await blur(page)
  await userSet(page, '#e2e_source')
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  const atAhead = await place(60)
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  await settled(page)
  const before = await places(page)
  expect(before.state, 'premise: a final entry of the empty query').toMatchObject({ editorText: '', final: true })
  expect(before.keys.indexOf(before.at), 'premise: one entry ahead of it').toBe(before.keys.length - 2)

  // THE RELOAD, WITH ITS RE-RANKING, ADDED NOTHING: the same positions, the browser on the same one, the entry
  // its own (index, run, query, final), of the order shown, which is the touched one
  await page.reload()
  await waitForApp(page)
  await shows('', top, 'the reloaded page shows the first view at the header')
  await settled(page)
  await recorded()
  expect(await touched(), 'premise: the item code touched its item again as the reloaded page started').toBe(true)
  const after = await places(page)
  expect(after, 'a reload whose start re-ranks the list: no entry added, the entry where it was, final, of the order shown').toEqual({ ...before, state: { ...before.state, orderHash: await orderShown(page) } })

  // Back from the full list reaches the tag's view in ONE step, and the entry ahead is still there (a push
  // would have dropped it)
  await page.goBack()
  await shows('#e2e_target ', atTag, "Back from the reloaded full list reaches the tag's view in one step")
  await page.goForward()
  await shows('', top, 'Forward onto the full list')
  await recorded()
  await page.goForward()
  await shows('#e2e_source', atAhead, 'Forward onto the entry ahead of the full list')

  // the entry is still final: a query typed on it is a new entry right after it, and Back returns to the list
  await page.goBack()
  await shows('', top, 'Back onto the full list')
  await recorded()
  const atList = await page.evaluate(() => history.state.scrollPosition as number)
  await blur(page)
  await userSet(page, '#e2e_source')
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await recorded()
  const typed = await places(page)
  expect([typed.keys.indexOf(after.at), typed.keys.indexOf(typed.at)], 'a query typed on the full list is a new entry right after it').toEqual([after.keys.indexOf(after.at), after.keys.indexOf(after.at) + 1])
  // A RE-RANKING WHILE BACK IS RESTORING THE ENTRY (review 0 of reload_rerank, B2): the route reads the
  // position of the entry reached and scrolls to it frames later; a re-ranking in between (an item's listener
  // that touches an item; here a one-shot listener of the row's, registered after the route's, which touches
  // the item ranked last) is written over the launch's entry while the viewport is still the departed view's,
  // and saved that position on it. The typed view is left at a position of its own, 60 px from the list's
  const atTyped = await place(60)
  await page.evaluate(() => {
    const w = window as any
    window.addEventListener(
      'popstate',
      () => {
        const order = history.state.orderHash
        const last = [...w.__items].reverse().find((item: any) => !item.pinned && !item.log && item.savedId)
        w._item(last.id).touch()
        w.__restoring = { rewritten: history.state.orderHash != order, viewport: document.body.scrollTop, stored: history.state.scrollPosition, held: w._history[w._history_index].scrollPosition }
      },
      { once: true }
    )
  })
  await page.goBack()
  await shows('', top, 'Back from the typed query returns to the full list')
  expect((await places(page)).at, "on the full list's entry").toBe(after.at)
  expect(await page.evaluate(() => (window as any).__restoring), "a re-ranking before the restore has scrolled is written over the entry reached, the viewport still the typed view's, and the entry keeps its own position").toEqual({
    rewritten: true,
    viewport: atTyped,
    stored: atList,
    held: atList,
  })
  await fixture.delete()
})

// a re-ordering the USER makes: a Cmd+click on an item's number moves the item one place up (src/number_click.ts),
// an item of the list that ranks by its time just below another's, so the order changes: a re-ranking within a
// trusted click. The first view renders the items above its fold: its toggle (a click of the user's that replaces
// the entry's shown count) shows more until two such items are on the page
const moveUp = async (page: Page) => {
  const pair = () =>
    page.evaluate(() => {
      const items = (window as any).__items as any[]
      const plain = (item: any) => !item.pinned && !item.log && !item.hasError && !item.missingTags.length && !item.running && !item.pushable && !item.previewable && !item.editing && !!document.querySelector(`.column:not(.hidden) .container[data-item-id="${item.id}"] .button.index`)
      return (items[items.findIndex((item, k) => k > 0 && plain(item) && plain(items[k - 1]) && item.time < items[k - 1].time)]?.id as string) ?? null
    })
  await settled(page)
  let id = await pair()
  for (let more = 0; !id && more < 3; more++) {
    await page.locator('.toggle.show').first().click()
    await settled(page)
    id = await pair()
  }
  expect(id, 'premise: two items on the page that rank by their times, one below the other').toBeTruthy()
  const order = await orderShown(page)
  await page.locator(`.column:not(.hidden) .container[data-item-id="${id}"] .button.index`).click({ modifiers: ['Meta'] })
  await expect.poll(() => orderShown(page), { message: 'premise: the click moved the item' }).not.toBe(order)
  await settled(page)
}

// every write of an entry of the notebook's, noted beside the app from each document's start (an init script:
// a reload included): a push or a replacement, and the order it wrote
const noteWrites = (page: Page) =>
  page.addInitScript(() => {
    const w = window as any
    w.__writes = []
    for (const kind of ['pushState', 'replaceState']) {
      const real = (History.prototype as any)[kind]
      ;(History.prototype as any)[kind] = function (this: History, ...args: any[]) {
        if (args[0]?.owner) w.__writes.push({ kind, orderHash: args[0].orderHash })
        return real.apply(this, args)
      }
    }
  })
const writes = (page: Page) => page.evaluate(() => (window as any).__writes as { kind: string; orderHash: string }[])

// A CHANGE THAT NO USER ACTION TRIGGERED ADDS NO STEP (the owner, 2026-11-19: "changes that are not triggered by a
// user action should not add new steps"; the decision is writeMode in src/history_entries.ts, its table in
// tests/unit/history_entries.spec.ts: this row is for what only a browser shows, the ORIGIN of each change).
// - A re-ordering: on the LAUNCH'S OWN first view, item code at `_init` and at `_on_welcome` (a reload each), then
//   in one document the missing tags the launch counts after its first ranking (a touch of the item that leads,
//   which moves nothing of its own), a touch and a `pushable` mark from a timer of item code and a change from
//   another client; on a TAG CLICK'S entry a timer's touch, `pushable` taken off, `running` and a change from
//   another client. Each is written over the entry: the browser's positions, the one it is on and the entry's
//   own fields as they were, every write since a replacement.
// - ITEM CODE THAT CHANGES THE QUERY BY ITSELF (review 0, blocker 1), on that final entry with an entry ahead: a
//   timer's `MindBox.set`, a timer's `select()`, and the selected item deleted by a timer. The query is accepted
//   and written over the entry, which stays final, and Forward is kept (each pushed, or wrote `final: false`).
// - WHAT THE USER DOES is a step as before, on a final first view that is not the launch's: a Cmd+click on an
//   item's number (src/number_click.ts), a write of item code within a click, and A WRITE AFTER A WAIT whose
//   intent the click's handler carried to it (blocker 2: `window._carry_input`, as the todoer's drop into the
//   agent bin does); the same write after the same wait from no input is written over. On the launch's own
//   first view the Cmd+click is written over the entry (`first`).
// The fixture is one item written behind the app before the page loads: its code acts only when the row asks
const QUIET = '#e2e_quiet'
const QUIET_TEXT = [
  `${QUIET} #_init #_welcome item code that changes the page when the row asks it to`,
  '```js',
  "const asked = () => sessionStorage.getItem('e2e_quiet')",
  'function _init() {',
  '  window.__e2e_quiet = act =>',
  '    setTimeout(() => {',
  "      if (act == 'touch') _this.touch()",
  "      if (act == 'pushable') _this.pushable = !_this.pushable",
  "      if (act == 'running') _this.running = !_this.running",
  "      if (act == 'leader') _item(window.__items.find(item => !item.pinned && !item.log).id).touch()",
  "      if (act == 'query') MindBox.set('#e2e_source')",
  "      if (act == 'select') _item('#e2e_quiet_gone').select()",
  "      if (act == 'delete') _item('#e2e_quiet_gone').delete(false)",
  "      if (act == 'group') MindBox.set('#e2e_steps')",
  '    })',
  "  if (asked() == 'init') _this.touch()",
  '}',
  "function _on_welcome() { if (asked() == 'welcome') _this.touch() }",
  '```',
].join('\n')
test("a change that no user action triggered adds no history entry: a re-ordering by item code, a mark or another client is written over the launch's own first view and over a tag click's entry, and so is a query that item code sets, selects or backs up by itself, the entry final as it was and Forward kept; what the user does is a step as before, across a wait of its handler's too", async ({ page }) => {
  const reads = historyReads(page)
  const { recorded, place, shows } = reads
  await noteWrites(page)
  const add = (time: number, text: string) => firestore().collection('items').add({ user: 'anonymous', time, attr: null, text })
  const fixture = await add(Date.UTC(2021, 0, 1), QUIET_TEXT)
  const gone = await add(Date.UTC(2021, 0, 3), '#e2e_quiet_gone an item that item code selects and deletes')
  // two items that share a label (no item is named by it: under it they rank by their times alone)
  const newer = await add(Date.now() - 3_600_000, '#e2e_steps the newer of two items that share a label')
  const older = await add(Date.now() - 7_200_000, '#e2e_steps the older of the two')
  const quiet = (act: string) => page.evaluate(act => (window as any).__e2e_quiet(act), act)
  const touched = () => page.evaluate(label => (({ time, savedTime }) => time > savedTime)((window as any).__items.find((item: any) => item.label == label)), QUIET)
  // a change from another client: the item ranked last among the unpinned, not the row's own (a new time saved on
  // the fixture would make it lead the list from then on, and a touch of it would move nothing)
  const remote = async () => {
    const saved = await page.evaluate(() => [...(window as any).__items].reverse().find((item: any) => !item.pinned && !item.log && item.savedId && !String(item.label).startsWith('#e2e_quiet')).savedId as string)
    await firestore().collection('items').doc(saved).update({ time: Date.now() })
  }
  // whether the fixture leads the unpinned items that rank by their times (an old item: only a touch puts it there)
  const leads = () => page.evaluate(label => (window as any).__items.find((item: any) => !item.pinned && !item.log && !item.missingTags.length && !item.hasError && !item.running && !item.pushable)?.label == label, QUIET)
  // the change written over the entry the browser is on: the positions, the one the browser is on and the entry
  // as they were but for the order, which is the one shown; nothing pushed in the writes from `since` on; after a
  // reload (`since` 0) another order among them, the launch's (the order the source changed)
  const overwritten = async (before: Awaited<ReturnType<typeof places>>, since: number, message: string) => {
    await settled(page)
    await recorded()
    const [after, shown] = [await places(page), await orderShown(page)]
    const all = (await writes(page)).slice(since)
    expect(after, `${message}: no entry added, the entry where and what it was, of the order shown`).toEqual({ ...before, state: { ...before.state, orderHash: shown } })
    expect([all.filter(w => w.kind != 'replaceState').length, since > 0 || all.some(w => w.orderHash != shown)], `${message}: every write a replacement`).toEqual([0, true])
  }
  // a source set off on the entry the browser is on: the order it gives, written over the entry
  const onEntry = async (cause: () => Promise<unknown>, message: string) => {
    await settled(page)
    const [before, since, order] = [await places(page), (await writes(page)).length, await orderShown(page)]
    await cause()
    await expect.poll(() => orderShown(page), { message: `${message}, premise: the page re-ranked`, timeout: 30_000 }).not.toBe(order)
    await overwritten(before, since, message)
  }

  await loadAdmin(page)
  const top = await headerTop(page)
  await typedThenTag(page, reads)
  // the full list in a final entry of its own (a click on the tag the query names), an entry ahead of it left at
  // a position of its own (a query set within a key press, from a blurred box), then Back onto the full list
  const targetId = await page.evaluate(() => window._item('#e2e_target')!.id)
  const label = page.locator(`#item-${targetId} mark[title="#e2e_target"]`).first()
  await label.scrollIntoViewIfNeeded()
  await recorded()
  const atTag = await scrollTop(page)
  await label.click()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  await blur(page)
  await userSet(page, '#e2e_source')
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  const atAhead = await place(60)
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await recorded()
  await settled(page)
  const list = await places(page)
  expect(list.state, 'premise: a final entry of the empty query').toMatchObject({ editorText: '', final: true })
  expect(list.keys.indexOf(list.at), 'premise: one entry ahead of it').toBe(list.keys.length - 2)

  // THE LAUNCH'S OWN FIRST VIEW. A source of the page's start (a reload each, asked for through the session's
  // storage) touches the fixture, which its old time keeps last until then: the entry ends on an order in which
  // the fixture leads, after the launch's own write of another one
  const launched = async (source: string, message: string) => {
    await page.evaluate(source => sessionStorage.setItem('e2e_quiet', source), source)
    await page.reload()
    await waitForApp(page)
    await shows('', top, `${message}: the reloaded page shows the first view at the header`)
    if (!source) return
    await expect.poll(touched, { message: `${message}, premise: the item code touched its item` }).toBe(true)
    await expect.poll(leads, { message: `${message}, premise: the touched item leads the list` }).toBe(true)
    await overwritten(list, 0, message)
  }
  await launched('init', 'item code that touches an item at _init')
  await launched('welcome', 'item code that touches an item at _on_welcome')
  // and the sources the row sets off after a launch, in one document. First the missing tags: an old item with a
  // tag that no item carries ranks above the items without one, and the launch ranks before it counts them, so
  // the first ranking after it moves the item (a touch of the item that leads, which moves nothing of its own)
  const missing = await add(Date.UTC(2021, 0, 2), '#e2e_quiet_missing an old item with a tag no item carries, #e2e_quiet_nowhere')
  await launched('', 'a launch that sets off nothing')
  const rankOf = () => page.evaluate(() => (window as any).__items.findIndex((item: any) => item.label == '#e2e_quiet_missing') as number)
  const unranked = await rankOf()
  await onEntry(() => quiet('leader'), 'a ranking that counts a missing tag the launch ranked without')
  expect(await rankOf(), 'premise: the item with the missing tag moved up').toBeLessThan(unranked)
  await onEntry(() => quiet('touch'), "a touch from a timer of item code on the launch's own first view")
  await onEntry(() => quiet('pushable'), "a pushable mark from a timer of item code on the launch's own first view")
  await onEntry(remote, "a change from another client on the launch's own first view")
  await page.evaluate(() => sessionStorage.removeItem('e2e_quiet'))
  // Back from the reloaded full list reaches the tag's view in ONE step, and the entry ahead is still there
  await page.goBack()
  await shows('#e2e_target ', atTag, "Back from the reloaded full list reaches the tag's view in one step")
  await page.goForward()
  await expect(mindbox(page)).toHaveValue('')
  await page.goForward()
  await shows('#e2e_source', atAhead, 'Forward onto the entry ahead of the full list, kept')

  // A TAG CLICK'S ENTRY (final, not the launch's): Back onto it, and each source while the browser is on it
  await page.goBack()
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await recorded()
  const tag = await places(page)
  expect(tag.state, "premise: the tag click's entry, final").toMatchObject({ editorText: '#e2e_target ', final: true })
  // (the mark set on the launch's entry first: a pushable item ranks under the target whatever its time)
  await onEntry(() => quiet('pushable'), "a pushable mark taken off by a timer of item code on a tag click's entry")
  await onEntry(() => quiet('touch'), "a touch from a timer of item code on a tag click's entry")
  await onEntry(() => quiet('running'), "a running mark from a timer of item code on a tag click's entry")
  await onEntry(remote, "a change from another client on a tag click's entry")
  // ITEM CODE THAT CHANGES THE QUERY BY ITSELF: accepted, written over the entry, which keeps its place, its
  // index and its `final`; nothing pushed, so the entry ahead stays
  // a keystroke of the user's into the focused MindBox (one trusted input event), and a timer of item code armed
  // inside its dispatch by a listener of the row's: the timer fires within the debounce whatever the driver's
  // pace, and is no input itself
  const typedThen = async (act: string, typed: string) => {
    await focusMindboxInPlace(page)
    await page.evaluate(act => {
      const w = window as any
      document.getElementById('textarea-mindbox')!.addEventListener('input', () => ((w.__e2e_pending = w._editor_change_pending), w.__e2e_quiet(act)), { once: true })
    }, act)
    await page.keyboard.insertText(typed)
  }
  const accepted = async (cause: () => Promise<unknown>, query: string, message: string) => {
    await settled(page)
    const [before, since] = [await places(page), (await writes(page)).length]
    await cause()
    await expect.poll(() => page.evaluate(() => [history.state.editorText, (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value]), { message: `${message}: the query is accepted, in the box and on the entry`, timeout: 10_000 }).toEqual([query, query])
    await settled(page)
    const after = await places(page)
    expect({ ...after, state: { ...after.state, orderHash: '' } }, `${message}: no entry added, the entry where it was and final as it was`).toEqual({ ...before, state: { ...before.state, editorText: query, orderHash: '' } })
    expect((await writes(page)).slice(since).filter(w => w.kind != 'replaceState').length, `${message}: nothing pushed`).toBe(0)
  }
  await accepted(() => quiet('query'), '#e2e_source', 'a query set by a timer of item code')
  // A KEYSTROKE OF THE USER'S THAT IS PENDING IN THE DEBOUNCE lends its origin to no other write (review 1 of
  // phantom_steps, blocker 1): the select below comes within the debounce of a typed character and supersedes
  // it. It is item code's own: accepted, written over the entry, nothing pushed (the pending origin was a
  // boolean, and the select took it: a push over the entry ahead, and the typed query never got an entry)
  await accepted(() => typedThen('select', 'x'), '#e2e_quiet_gone', "a select by a timer of item code, over a keystroke of the user's pending in the debounce")
  expect(await page.evaluate(() => (window as any).__e2e_pending), 'premise: the keystroke was pending when the timer was armed').toBe(true)
  await accepted(() => quiet('delete'), '', 'the selected item deleted by a timer of item code')
  await page.goBack()
  await expect(mindbox(page), "Back from the tag click's entry reaches the query before it in one step").toHaveValue('#e2e_source')
  await page.goForward()
  await expect.poll(async () => (await places(page)).at).toBe(tag.at)
  await page.goForward()
  await expect.poll(async () => (await places(page)).at, { message: 'Forward from it: the full list ahead, kept' }).toBe(list.at)
  await page.goBack()
  await expect.poll(async () => (await places(page)).at).toBe(tag.at)
  await expect(mindbox(page)).toHaveValue('')
  // THE SAME KEYSTROKE, APPLIED EARLY BY A RE-RANKING, keeps its origin (the other side of the case above): the
  // typed query is the user's whoever applies it, a new entry after the final one it was typed on
  await typedThen('touch', 'e2e_typed_query')
  await expect.poll(() => page.evaluate(() => history.state.editorText), { message: 'the typed query, applied by the re-ranking', timeout: 10_000 }).toBe('e2e_typed_query')
  expect(await page.evaluate(() => (window as any).__e2e_pending), 'premise: the keystroke was pending when the timer was armed').toBe(true)
  await settled(page)
  const typed = await places(page)
  expect([typed.keys.indexOf(typed.at), typed.state.final], "a typed query that a passive re-ranking applies early is the user's still: a new entry right after the one it was typed on").toEqual([typed.keys.indexOf(tag.at) + 1, false])
  await blur(page)
  await page.goBack()
  await expect.poll(async () => (await places(page)).at).toBe(tag.at)
  await expect(mindbox(page)).toHaveValue('')

  // WHAT THE USER DOES, on that entry: the empty query by now, final, and not the launch's. A Cmd+click on an
  // item's number moves the item one place up (an item of the list ranked by its time just below another's): a
  // re-ranking within a trusted click. (The first view renders the items above its fold: its toggle, a click of
  // the user's that replaces the entry's shown count, shows more until two such items are on the page)
  const here = await places(page)
  expect([here.state.editorText, here.state.final], "premise: a final first view that is not the launch's").toEqual(['', true])
  const stepped = async (message: string) => {
    const after = await places(page)
    expect([after.keys.indexOf(after.at), after.state.editorText, after.state.final], `${message}: a new entry right after the list`).toEqual([after.keys.indexOf(here.at) + 1, '', false])
    await page.goBack()
    await expect.poll(async () => (await places(page)).at, { message: `${message}: Back from it reaches the list in one step` }).toBe(here.at)
  }
  await moveUp(page)
  await stepped("the user's re-ranking on a first view that is not the launch's")
  // item code run by the user's click: a write (of the item ranked last among the unpinned, its text as it is,
  // which the app re-ranks from a timer) at once, and after a wait of the handler's own with the click's intent
  // carried to it (`_carry_input`, captured in the click)
  await page.evaluate(() => {
    const w = window as any
    w.__e2e_write = (wait: number | null, carry: boolean) => {
      const last = [...w.__items].reverse().find((item: any) => !item.pinned && !item.log && item.savedId && !item.missingTags.length && !String(item.label).startsWith('#e2e_quiet'))
      const handle = w._item(last.id)
      const write = () => handle.write(handle.text, '')
      if (wait === null) write()
      else setTimeout(carry ? w._carry_input(write) : write, wait)
    }
    const button = Object.assign(document.createElement('button'), { id: 'e2e-write', textContent: 'write' })
    Object.assign(button.style, { position: 'fixed', top: '40px', left: '40px', zIndex: '1000' })
    button.addEventListener('click', () => w.__e2e_write(w.__e2e_wait, true))
    document.body.appendChild(button)
  })
  const clicked = async (wait: number | null, message: string) => {
    const order = await orderShown(page)
    await page.evaluate(wait => void ((window as any).__e2e_wait = wait), wait)
    await page.locator('#e2e-write').click()
    await expect.poll(() => orderShown(page), { message: `${message}, premise: the write re-ranked the page` }).not.toBe(order)
    await settled(page)
    await stepped(message)
  }
  await clicked(null, "a write of item code within the user's click")
  await clicked(300, "a write of item code after a wait of its handler's, the click's intent carried to it")
  // the same write after the same wait from no input: written over the list
  await onEntry(() => page.evaluate(() => (window as any).__e2e_write(300, false)), "the same write after the same wait, from no input, on a first view that is not the launch's")
  await page.evaluate(() => document.getElementById('e2e-write')?.remove())
  // on the launch's own first view (a reload there): the user's re-ranking is written over the entry, which stays final
  await page.reload()
  await waitForApp(page)
  await expect(mindbox(page)).toHaveValue('')
  await settled(page)
  await recorded()
  const own = await places(page)
  await moveUp(page)
  const since = await places(page)
  expect({ keys: since.keys, at: since.at, final: since.state.final }, "the user's re-ranking on the launch's own first view: written over it, which stays final").toEqual({ keys: own.keys, at: own.at, final: true })
  expect(since.state.orderHash, 'of the order the click gave').toBe(await orderShown(page))
  // A QUERY THAT ITEM CODE WRITES OVER THE LAUNCH'S ENTRY IS NO FIRST VIEW (review 1 of phantom_steps, blocker 2): a
  // shared label set by a timer is accepted and written over the launch's entry, final as it was; the user's
  // Cmd+click on the older item's number under that label is then a step, and the entry behind it holds the
  // order from before the click (recognized by its run and index alone, the launch's entry took the user's
  // re-ordering as a replacement too, and Back could not reach the order before it)
  await settled(page)
  const launchAt = await places(page)
  await quiet('group')
  await expect.poll(() => page.evaluate(() => history.state.editorText), { message: 'the label that item code set, on the entry', timeout: 10_000 }).toBe('#e2e_steps')
  await settled(page)
  const grouped = await places(page)
  expect([grouped.at, grouped.keys, grouped.state.final], "premise: the label is written over the launch's entry, final as it was").toEqual([launchAt.at, launchAt.keys, true])
  const ordered = await orderShown(page)
  await page.locator(`.column:not(.hidden) .container[data-item-id="${older.id}"] .button.index`).click({ modifiers: ['Meta'] })
  await expect.poll(() => orderShown(page), { message: 'premise: the click moved the older item up' }).not.toBe(ordered)
  await settled(page)
  const reordered = await places(page)
  expect([reordered.keys.indexOf(reordered.at), reordered.state.editorText, reordered.state.final], "the user's re-ordering under a label that item code set on the launch's entry: a new entry right after it").toEqual([reordered.keys.indexOf(launchAt.at) + 1, '#e2e_steps', false])
  await page.goBack()
  await expect.poll(async () => (({ at, state }) => [at, state.orderHash])(await places(page)), { message: 'Back reaches the entry that holds the order from before the click' }).toEqual([launchAt.at, grouped.state.orderHash])
  for (const doc of [missing, gone, newer, older, fixture]) await doc.delete()
})

// A RELOAD WITH A QUERY IN THE BOX ADDS NO STEP (the owner, 2026-11-19, on the reload's remaining steps: "i'd
// like these fixed also"). The launch leaves the entry the browser is on as it is while its first view shows,
// then applies the address's query over it (its fragment step), and the entry keeps its `final`: a typed tag's
// (not final), a tag click's and a select's by an item's id (final). The page shows the query again, as before
// (what a reload should show is the owner's other todo). Until 2026-11-19 the launch pushed the address's query
// after its first view, and the first view itself after a final entry of another query: one entry more for a
// typed tag, two for a clicked one or a select, and Forward was gone. Every step of the setup is the user's: typed
// text, a tag's click, and a query or a select made within a key press (as a click in a widget makes them)
test("a reload with a query in the box adds no history entry: a typed tag, a tag click's and a select's by an item's id each show the query again in the entry the browser is on, which keeps its final; Back reaches the entry before in one step and Forward the entry ahead", async ({ page }) => {
  const reads = historyReads(page)
  const { recorded } = reads
  await noteWrites(page)
  const unnamed = await firestore().collection('items').add({ user: 'anonymous', time: Date.now(), attr: null, text: 'an unnamed item of the reload row, selected by its id' })
  await loadAdmin(page)
  // a reload on the entry the browser is on: no position added, the browser on the same one, the query shown
  // again and kept by the entry (the fragment step gives it the space a tag's click does), its index, run and
  // `final` as they were, nothing pushed; then Back and Forward
  const reloaded = async (query: string, behind: string, ahead: string, message: string) => {
    await recorded()
    const before = await places(page)
    await page.reload()
    await waitForApp(page)
    await expect(mindbox(page), `${message}: the reloaded page shows the query again`).toHaveValue(query.trim() + ' ')
    await expect.poll(() => page.evaluate(() => (window as any)._launch_fragment_done === true), { message: `${message}: the launch's fragment step has run` }).toBe(true)
    await settled(page)
    const after = await places(page)
    const kept = (p: typeof before) => ({ keys: p.keys, at: p.at, index: p.state.index, run: p.state.run, final: p.state.final, query: p.state.editorText.trim() })
    expect(kept(after), `${message}: no entry added, the entry where it was, its query and final as they were`).toEqual(kept(before))
    expect((await writes(page)).filter(w => w.kind != 'replaceState').length, `${message}: nothing pushed`).toBe(0)
    await page.goBack()
    await expect(mindbox(page), `${message}: Back reaches the entry before it in one step`).toHaveValue(behind)
    await page.goForward()
    await expect(mindbox(page)).toHaveValue(query.trim() + ' ')
    await page.goForward()
    await expect(mindbox(page), `${message}: Forward reaches the entry ahead, kept`).toHaveValue(ahead)
    await page.goBack()
    await expect(mindbox(page)).toHaveValue(query.trim() + ' ')
  }

  // a TYPED tag (its entry not final), the tag click's entry from its item ahead of it, Back onto the typed one
  await focusMindbox(page)
  await mindbox(page).pressSequentially('#e2e_source')
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toBe('#e2e_source')
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_source')!.elem)).toBe(true)
  await blur(page)
  const sourceId = await page.evaluate(() => window._item('#e2e_source')!.id)
  await page.locator(`#item-${sourceId} mark[title="#e2e_target"]`).scrollIntoViewIfNeeded()
  await page.locator(`#item-${sourceId} mark[title="#e2e_target"]`).click()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  expect((await places(page)).state, 'premise: a typed query, not final').toMatchObject({ editorText: '#e2e_source', final: false })
  await reloaded('#e2e_source', '', '#e2e_target ', 'a reload on a typed tag')
  expect((await places(page)).state.final, 'the typed entry is still not final').toBe(false)

  // a tag CLICK's entry (final), a query ahead of it
  await page.goForward()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  await blur(page)
  await userSet(page, '#e2e_target/sub')
  await expect(mindbox(page)).toHaveValue('#e2e_target/sub')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_target ')
  expect((await places(page)).state, "premise: a tag click's entry, final").toMatchObject({ editorText: '#e2e_target ', final: true })
  await reloaded('#e2e_target', '#e2e_source ', '#e2e_target/sub', "a reload on a tag click's entry")

  // a SELECT's entry by an item's id (an unnamed item: `id:<saved id>`, final), a query ahead of it again
  await expect.poll(() => page.evaluate(id => window._exists(id), unnamed.id), { message: 'premise: the unnamed item is in the page', timeout: 30_000 }).toBe(true)
  await asUser(page, id => (window._item(id) as any).select(), unnamed.id)
  await expect(mindbox(page)).toHaveValue('id:' + unnamed.id)
  await blur(page)
  await userSet(page, '#e2e_source')
  await expect(mindbox(page)).toHaveValue('#e2e_source')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('id:' + unnamed.id)
  expect((await places(page)).state, "premise: a select's entry, final").toMatchObject({ editorText: 'id:' + unnamed.id, final: true })
  await reloaded('id:' + unnamed.id, '#e2e_target ', '#e2e_source', "a reload on a select's entry by an item's id")
  await unnamed.delete()
})

// WHAT THE USER STARTS KEEPS ITS ORIGIN ACROSS A WAIT OF THE APP'S OWN, AND LENDS IT TO NOTHING ELSE (reviews 0 to 2
// of phantom_steps): the intent is captured at the action and handed to the write that continues it
// (index.svelte's carryInput), and the typed query's is bound to its text in the MindBox's debounce.
// - A COMMAND THROUGH ITS DIALOG, answered by a key: `/_rename`'s confirmation resolves from a timer of the
//   Modal's, so the rename and the clear of the box came from no input. On a FINAL entry that holds the command
//   (the copy an Up makes) the clear is the user's new query: a new entry, and Back restores the command's entry
//   (taken for a passive write, the clear was written over that entry, which then no longer held the command).
// - A TYPED QUERY THROUGH THE DEBOUNCE, on a clock the row drives (page.clock, installed before the page loads
//   and held from the first typed text on): typed text, a re-ranking that applies it early (the typed query is
//   the user's whoever applies it: a new entry after the final one), more typing, and ONE applied query once the
//   typing is quiet. Before 2026-11-19 the early application left its timer live: it met the new typing's own,
//   and the two postponed each other for as long as the box kept the focus (issues/Typed Query Stays Pending
//   When A Stale Debounce Timer Meets New Typing).
// - WHAT A PASSIVE CALL MAKES OF A PENDING TYPED QUERY (review 2, blocker 1), each on an entry with one ahead:
//   a timer's select of the very name typed, on an entry that is NOT final, settles the text as the user's
//   typing is written, the entry replaced and not final (the select's forced, final entry came with the user's
//   origin: a push over the entry ahead); and a typed query that item code supersedes and then sets again, the
//   box focused throughout, is item code's: written over the FINAL entry, which stays final (the typed text's
//   origin outlived the query between, and the debounce pushed it as the user's)
test("what the user starts keeps its origin across the app's own waits and lends it to nothing else: a command confirmed by a key in its dialog clears the box in a new entry; a typed query that a re-ranking applies early, then typed further, is applied once more when the typing is quiet; a timer's select of the name typed is written as typing, and a typed query that item code supersedes is item code's, the entry ahead kept each time", async ({ page }) => {
  const { recorded } = historyReads(page)
  await page.clock.install() // before the page has any timer of its own; it runs with the wall's until it is held
  await loadAdmin(page)
  const browserKey = () => page.evaluate(() => (window as any).navigation.currentEntry.key as string)
  const keys = () => page.evaluate(() => (window as any).navigation.entries().map((e: any) => e.key) as string[])
  const stored = () => page.evaluate(() => [history.state.editorText, history.state.final])
  const pending = () => page.evaluate(() => (window as any)._editor_change_pending as boolean)

  // the command, typed (its entry is not final), then the copy an Up makes of it from a scrolled page: final
  const COMMAND = '/_rename #e2e_waits #e2e_waited'
  await page.evaluate(() => {
    void window._create('#e2e_waits an item whose tag the command renames')
    void window._create('#e2e_waits_b another item of the row')
  })
  await expect.poll(async () => !!(await savedId(page, '#e2e_waits')) && !!(await savedId(page, '#e2e_waits_b')), { timeout: 30_000 }).toBe(true)
  await focusMindbox(page)
  await mindbox(page).fill(COMMAND)
  await expect.poll(stored, { message: "the typed command's entry", timeout: 10_000 }).toEqual([COMMAND, false])
  await blur(page)
  await scrollDown(page)
  await recorded()
  await page.keyboard.press('Control+Meta+ArrowUp')
  await nearTop(page, 'Up: the top of the page, in an entry of its own')
  const upKey = await browserKey()
  expect(await stored(), "premise: the Up's copy holds the command, final").toEqual([COMMAND, true])
  // the command entered from the box, and its dialog confirmed by a NEW press of Enter (the Modal answers a key
  // from a timer)
  await focusMindboxInPlace(page)
  await page.keyboard.press('Shift+Enter')
  await expect(page.locator('.background.visible .modal'), "the command's dialog").toContainText('Rename')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => [window._exists('#e2e_waited'), history.state.editorText]), { message: 'the rename is applied and the box cleared', timeout: 30_000 }).toEqual([true, ''])
  await settled(page)
  const cleared = await places(page)
  expect([cleared.keys.indexOf(cleared.at), cleared.state.editorText], "the clear is the command's, the user's: a new entry right after the one that holds the command").toEqual([cleared.keys.indexOf(upKey) + 1, ''])
  await page.goBack()
  await expect(mindbox(page), "Back restores the command's entry").toHaveValue(COMMAND)
  expect([await browserKey(), await stored()], 'the entry the command was entered on, as it was').toEqual([upKey, [COMMAND, true]])

  // the debounce, on the row's clock, held from here. The box focused on a final entry (the Up's)
  await focusMindboxInPlace(page)
  const [length, index] = await entries(page)
  await page.clock.pauseAt(Date.now() + 1_000)
  await page.keyboard.insertText(' typed')
  expect([await pending(), (await stored())[0]], 'typed text: pending in the debounce, the entry as it was').toEqual([true, COMMAND])
  // 100 ms on, a re-ranking applies it early (a touch from the page's script, which is no input): the typed
  // query is the user's, a new entry after the final one it was typed on
  await page.clock.runFor(100)
  await page.evaluate(() => void (window._item(window.__items[window.__items.length - 1].id) as any).touch())
  // (a push from the Up's entry: the entry ahead of it, the cleared box's, is replaced, so the session's length stays)
  expect([await pending(), await stored(), await entries(page), (await browserKey()) == upKey], "the early application: the typed query in a new entry, the user's").toEqual([false, [COMMAND + ' typed', false], [length, index + 1], false])
  const typedKey = await browserKey()
  // 100 ms on, more typing: pending again; then the quiet. The first timer is gone with the early application,
  // and the new one applies the query once, 500 ms after the last typed text
  await page.clock.runFor(100)
  await page.keyboard.insertText(' more')
  expect(await pending(), 'more typing: pending again').toBe(true)
  await page.clock.runFor(499)
  expect([await pending(), (await stored())[0]], 'not yet applied within the quiet').toEqual([true, COMMAND + ' typed'])
  await page.clock.runFor(2)
  expect([await pending(), await stored(), await entries(page), await browserKey()], 'applied once the typing has been quiet for the debounce, in the same entry').toEqual([false, [COMMAND + ' typed more', false], [length, index + 1], typedKey])
  await page.clock.runFor(5_000)
  expect([await pending(), (await stored())[0]], 'and nothing is pending afterwards').toEqual([false, COMMAND + ' typed more'])

  // A TIMER'S SELECT OF THE VERY NAME TYPED, within the debounce, on that entry, which is NOT final, with an entry
  // ahead of it (a select of the user's, within a key press, and Back; a traversal's restore scrolls from a
  // frame, so the clock runs a few after each)
  const typeOver = async (text: string) => {
    await page.evaluate(() => {
      const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      box.focus({ preventScroll: true })
      box.select()
    })
    await page.keyboard.insertText(text)
  }
  await asUser(page, () => void (window._item('#e2e_waits_b') as any).select())
  const aheadKey = await browserKey()
  expect([await stored(), aheadKey == typedKey], "premise: the user's select, final, in an entry of its own").toEqual([['#e2e_waits_b', true], false])
  await page.goBack()
  await expect.poll(browserKey, { message: 'Back onto the typed entry' }).toBe(typedKey)
  await page.clock.runFor(50)
  await typeOver('#e2e_waited')
  expect(await pending(), 'the name typed: pending in the debounce').toBe(true)
  await page.evaluate(() => void setTimeout(() => (window._item('#e2e_waited') as any).select()))
  await page.clock.runFor(1)
  expect([await pending(), await browserKey(), await stored(), (await keys()).includes(aheadKey)], "a timer's select of the name the user typed settles it as their typing: the entry replaced where it is, not final, the entry ahead kept").toEqual([false, typedKey, ['#e2e_waited', false], true])
  await page.goForward()
  await expect.poll(browserKey, { message: 'Forward still reaches the entry ahead, by its key' }).toBe(aheadKey)
  await page.clock.runFor(50)

  // A TYPED QUERY THAT ITEM CODE SUPERSEDES AND THEN SETS AGAIN, the box focused throughout, on the select's entry,
  // which is FINAL, with an entry ahead of it (another select of the user's, and Back)
  await asUser(page, () => void (window._item('#e2e_waited') as any).select())
  const lastKey = await browserKey()
  expect([await stored(), lastKey == aheadKey], "premise: the user's second select, final, in an entry of its own").toEqual([['#e2e_waited', true], false])
  await page.goBack()
  await expect.poll(browserKey, { message: "Back onto the first select's entry" }).toBe(aheadKey)
  await page.clock.runFor(50)
  await typeOver('e2e typed b')
  expect(await pending(), 'the query typed: pending in the debounce').toBe(true)
  await page.evaluate(
    () =>
      void setTimeout(() => {
        ;(window as any).MindBox.set('e2e typed c')
        ;(window as any).MindBox.set('e2e typed b')
      }),
  )
  await page.clock.runFor(1)
  expect([await pending(), (await stored())[0], await mindbox(page).inputValue()], "item code's two sets wait in the debounce, the box focused").toEqual([true, '#e2e_waits_b', 'e2e typed b'])
  await page.clock.runFor(1_100)
  expect([await pending(), await browserKey(), await stored(), (await keys()).includes(lastKey)], "the query item code set last is item code's, though it is the text the user had typed: written over the entry, final as it was, the entry ahead kept").toEqual([false, aheadKey, ['e2e typed b', true], true])
})
