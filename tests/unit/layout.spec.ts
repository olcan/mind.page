import { expect, test } from '@playwright/test'
import { layoutItems, previewLayout, regroupMovesItem, regroupMovesReader, type LayoutConfig } from '../../src/layout.js'

// synthetic-height tables for the per-item layout pass (see src/layout.ts): these pin the column
// assignment thresholds, separator arrows, time-string grouping, above-fold marking and mover
// flags deterministically — the e2e layout spec can only characterize the seeded corpus, whose
// visible set fits in one column (see tests/e2e/layout.spec.ts)

const config = (overrides: Partial<LayoutConfig> = {}): LayoutConfig => ({
  columnCount: 3,
  headerHeight: 100,
  screenHeight: 1000,
  defaultItemHeight: 0,
  separatorHeight: 80,
  hideIndex: 100,
  fixed: false,
  timeString: time => `${time}d`, // deterministic stand-in for itemTimeString
  ...overrides,
})

const item = (time: number, height: number, extra: Record<string, any> = {}): any => ({ time, height, ...extra })

test('unmeasured items (zero heights) stay in column zero', () => {
  const items = [item(3, 0), item(2, 0), item(1, 0)]
  layoutItems(items, config())
  expect(items.map(it => it.column)).toEqual([0, 0, 0])
})

test('stay/spill threshold boundaries: within half a screen of the minimum an item always stays', () => {
  // column 0 at header 100 + first item; screenHeight tuned so the second item sits exactly at
  // the 0.5*screen boundary (<= stays)
  const items = [item(3, 268), item(2, 600)] // 100 + (268+8+24) = 400 = 0 + 0.5 * 800
  layoutItems(items, config({ screenHeight: 800 }))
  expect(items[1].column).toBe(0) // boundary is inclusive
  const over = [item(3, 269), item(2, 600)] // one pixel over: falls to the second inequality
  layoutItems(over, config({ screenHeight: 800 }))
  // second inequality: 401 + (600+8) + 80 = 1089 > 0 + 0.9 * 800 = 720 -> spills
  expect(over[1].column).toBe(1)
  // the 0.9 boundary itself, exactly: 401 + (207+8+24) + 80 = 720 <= 720 stays ...
  const at = [item(3, 269), item(2, 207)]
  layoutItems(at, config({ screenHeight: 800 }))
  expect(at[1].column).toBe(0)
  // ... and one pixel over it spills
  const past = [item(3, 269), item(2, 208)]
  layoutItems(past, config({ screenHeight: 800 }))
  expect(past[1].column).toBe(1)
})

test('dotted items occupy no height and defaultItemHeight stands in for unmeasured items', () => {
  const items = [item(3, 500), item(2, 500, { dotted: true }), item(1, 0)]
  const { columnHeights } = layoutItems(items, config({ columnCount: 1, defaultItemHeight: 200 }))
  // 100 header + (500+8+24) + 0 (dotted) + (200+8+24): the unmeasured item uses the default
  // height and, starting a new time group, carries a time string
  expect(columnHeights).toEqual([100 + 532 + 0 + 232])
  expect(items[1].outerHeight).toBe(0)
})

test('tall items spill to the minimum column once ~a screen height over it, with arrows and a separator', () => {
  const items = [item(4, 600), item(3, 600), item(2, 600), item(1, 600)]
  const { columnHeights } = layoutItems(items, config())
  // header 100 + item0 (600+8+24 time string) puts column 0 at 732; item1 cannot stay (732 is
  // over min+0.5*screen and would land over min+0.9*screen) so it moves to the min column, and
  // likewise item2; item3's column IS then the minimum, so it stays
  expect(items.map(it => it.column)).toEqual([0, 1, 2, 2])
  expect(items[0].nextColumn).toBe(1) // the break is recorded on the item before it
  expect(items[0].arrows).toBe('↗')
  expect(items[1].arrows).toBe('↗')
  // exact heights pin the arithmetic: each item is 600+8 margins+24 time string = 632; broken
  // columns gain the 80px separator; removing any increment must fail this
  expect(columnHeights).toEqual([100 + 632 + 80, 632 + 80, 632 + 632])
  // per-column chaining links each item to the next in its column
  expect(items.map(it => it.nextItemInColumn)).toEqual([-1, -1, 3, -1])
})

test('a spill can jump multiple columns, repeating the arrow', () => {
  // heights chosen so the final move jumps 2 -> 0 (a genuine two-column jump): columns fill
  // left to right, the tall items push the minimum back to column 0, and the last item moves
  // there directly (the earlier version of this test produced only one-column transitions, so
  // its arrow assertion never executed — and expected one symbol too many)
  const items = [item(6, 100), item(5, 100), item(4, 100), item(3, 300), item(2, 1000), item(1, 100)]
  layoutItems(items, config({ screenHeight: 500 }))
  expect(items.map(it => it.column)).toEqual([0, 0, 1, 1, 2, 0])
  const jump = items[4] // the item before the 2 -> 0 break records it
  expect(jump.nextColumn).toBe(0)
  expect(jump.arrows).toBe('↖←') // one symbol per column of distance (end cap + repeats)
})

test('a move to an earlier column points its arrows left', () => {
  // fill three columns, then oversize column 2 so the next item breaks back to column 1
  const items = [item(5, 600), item(4, 600), item(3, 600), item(2, 1200), item(1, 600)]
  layoutItems(items, config({ screenHeight: 500 }))
  expect(items.map(it => it.column)).toEqual([0, 1, 2, 2, 1])
  expect(items[3].nextColumn).toBe(1)
  expect(items[3].arrows).toBe('↖')
})

test('time strings group consecutive items and skip pinned items and fixed pages', () => {
  const items = [item(3, 100), item(3, 100), item(2, 100, { pinned: true }), item(2, 100), item(1, 100)]
  layoutItems(items, config({ columnCount: 1 }))
  expect(items.map(it => it.timeString)).toEqual(['3d', '', '', '2d', '1d'])
  const fixed_items = [item(3, 100), item(2, 100)]
  layoutItems(fixed_items, config({ columnCount: 1, fixed: true }))
  expect(fixed_items.map(it => it.timeString)).toEqual(['', ''])
})

test('an out-of-order newer item is marked when it starts a new time group', () => {
  const items = [item(2, 100), item(3, 100), item(1, 100)]
  const { newestTime, oldestTime, oldestTimeString } = layoutItems(items, config({ columnCount: 1 }))
  expect(items[1].timeOutOfOrder).toBe(true)
  expect(newestTime).toBe(3)
  expect(oldestTime).toBe(1)
  expect(oldestTimeString).toBe('1d')
})

test('without a regroup, time rows stay where they are: none appears or disappears, their text refreshes, the first item keeps one', () => {
  // the owner (2026-10-05): a passive re-ranking soft-touched the named item to now and the next
  // layout put a row above the item being read; rows are regrouped only on a query change
  const items = [item(3, 100), item(3, 100), item(2, 100), item(1, 100)]
  layoutItems(items, config({ columnCount: 1 }))
  expect(items.map(it => it.timeString)).toEqual(['3d', '', '2d', '1d'])
  // the first item touched to now: a regroup would give the second its own row (and mark nothing out of order)
  items[0].time = 9
  layoutItems(items, config({ columnCount: 1, regroupTimeRows: false }))
  expect(items.map(it => it.timeString), 'the rows as before, the first refreshed').toEqual(['9d', '', '2d', '1d'])
  // a later item touched to now: its row's text refreshes, no row appears before or after it
  items[2].time = 8
  layoutItems(items, config({ columnCount: 1, regroupTimeRows: false }))
  expect(items.map(it => it.timeString)).toEqual(['9d', '', '8d', '1d'])
  expect(items[2].timeOutOfOrder, 'out of order against the item before it').toBe(true)
  // the same bucket as its neighbor now: a regroup would drop its row; kept, and no longer out of order
  items[2].time = 3
  layoutItems(items, config({ columnCount: 1, regroupTimeRows: false }))
  expect(items.map(it => it.timeString)).toEqual(['9d', '', '3d', '1d'])
  expect(items[2].timeOutOfOrder).toBe(false)
  // the regroup (a query change) catches up
  items[2].time = 8
  layoutItems(items, config({ columnCount: 1 }))
  expect(items.map(it => it.timeString)).toEqual(['9d', '3d', '8d', '1d'])
  expect(items[2].timeOutOfOrder).toBe(true)
})

test('the out-of-order mark compares neighbors in either mode: a newer item behind a kept row of another bucket is marked', () => {
  const items = [item(3, 100), item(3, 100), item(2, 100)]
  layoutItems(items, config({ columnCount: 1 }))
  expect(items.map(it => it.timeString)).toEqual(['3d', '', '2d'])
  items[1].time = 2
  items[2].time = 3
  layoutItems(items, config({ columnCount: 1, regroupTimeRows: false }))
  expect(items.map(it => it.timeString)).toEqual(['3d', '', '3d'])
  expect(items.map(it => it.timeOutOfOrder), 'the third is newer than the second, whatever row it kept').toEqual([false, false, true])
  layoutItems(items, config({ columnCount: 1 }))
  expect(items.map(it => it.timeString)).toEqual(['3d', '2d', '3d'])
  expect(items.map(it => it.timeOutOfOrder)).toEqual([false, false, true])
})

test('without a regroup, a new first item still gets a row, a pinned item none, and a fixed page none', () => {
  const items = [item(3, 100), item(3, 100), item(2, 100)]
  layoutItems(items, config({ columnCount: 1 }))
  const moved = [items[1], items[0], items[2]] // the second item moved to the top (no row of its own before)
  layoutItems(moved, config({ columnCount: 1, regroupTimeRows: false }))
  expect(moved.map(it => it.timeString)).toEqual(['3d', '3d', '2d'])
  const pinned = [item(3, 100), item(3, 100, { pinned: true, timeString: '3d' })]
  layoutItems(pinned, config({ columnCount: 1, regroupTimeRows: false }))
  expect(pinned.map(it => it.timeString)).toEqual(['3d', ''])
  const fixed_items = [item(3, 100, { timeString: '3d' }), item(2, 100, { timeString: '2d' })]
  layoutItems(fixed_items, config({ columnCount: 1, fixed: true, regroupTimeRows: false }))
  expect(fixed_items.map(it => it.timeString)).toEqual(['', ''])
})

test('a preview leaves no layout behind: every field the pass writes is restored', () => {
  const items = [item(3, 100), item(3, 100), item(2, 100)]
  layoutItems(items, config({ columnCount: 1 }))
  items[1].time = 2 // a regroup would give it a row
  const before = items.map(it => ({ ...it }))
  const rows = previewLayout(items, config({ columnCount: 1 }), () => items.map(it => it.timeString))
  expect(rows).toEqual(['3d', '2d', ''])
  expect(items).toEqual(before)
})

test('whether a regroup moves an item: a row it would add above the item or on it, or drop above, moves it; a row below it, or one moving onto the item above, does not', () => {
  // the owner (2026-10-07): the arrows navigate through a query change, and the regroup at one pushed the
  // item being read down; such a regroup is skipped (updateItemLayout in index.svelte decides with this)
  const items = [item(3, 100), item(3, 100), item(3, 100), item(2, 100)]
  layoutItems(items, config({ columnCount: 1 }))
  expect(items.map(it => it.timeString)).toEqual(['3d', '', '', '2d'])
  items[1].time = 9 // touched to now: a regroup would give it a row, above the third item
  expect(regroupMovesItem(items, config({ columnCount: 1 }), 2), 'a row above').toBe(true)
  expect(regroupMovesItem(items, config({ columnCount: 1 }), 1), 'its own row, above its text').toBe(true)
  expect(regroupMovesItem(items, config({ columnCount: 1 }), 0), 'the first item keeps its row').toBe(false)
  items[1].time = 3
  items[3].time = 1 // the last row's text refreshes either way, the row stays
  expect(regroupMovesItem(items, config({ columnCount: 1 }), 2), 'a change below').toBe(false)
  items[3].time = 3 // the last row would go: nothing above the third item changes
  expect(regroupMovesItem(items, config({ columnCount: 1 }), 2)).toBe(false)
  expect(regroupMovesItem(items, config({ columnCount: 1 }), 3), 'the dropped row lifts its text').toBe(true)
  items[2].time = items[3].time = 2 // the last row would move onto the third item: the last item's text stays where it is
  expect(regroupMovesItem(items, config({ columnCount: 1 }), 3)).toBe(false)
  expect(regroupMovesItem(items, config({ columnCount: 1 }), 2), 'the third item gains the row').toBe(true)
  expect(items.map(it => it.timeString), 'the layout as before').toEqual(['3d', '', '', '2d'])
})

test('a regroup that changes whether the item follows a section separator moves its text: a row after a separator overlaps it', () => {
  // review 0 B1: two columns; the target (the last item) returns to the first column after a separator,
  // its row overlapping the separator (the css pulls a timed item up by the row's height there, the
  // pass's discount), so its text sits at the row's top; the regroup rows the second item, which spills
  // to the second column, and the sixth returns to the first column before the target, which then
  // follows it directly with its row above its text: the same column, position and row, the text 24 px
  // lower. the first cut compared the column, position and row alone and read no move
  const heights = [108, 92, 212, 260, 260, 92, 44]
  const items = [2, 2, 1, 1, 3, 2, 1].map((time, i) => item(time, heights[i]))
  const cfg = config({ columnCount: 2, headerHeight: 200, screenHeight: 600 })
  layoutItems(items, cfg)
  const columns = () => [0, 1].map(column => items.map((it, i) => (it.column == column ? i : -1)).filter(i => i >= 0))
  expect(columns()).toEqual([[0, 1, 6], [2, 3, 4, 5]])
  const place = () => [items[6].column, items[6].pos, items[6].timeString]
  expect(place()).toEqual([0, 520, '1d'])
  items[1].time = 3
  expect(previewLayout(items, { ...cfg, regroupTimeRows: true }, () => [columns(), place()]), 'the regroup: the same column, position and row, no separator before it').toEqual([[[0, 5, 6], [1, 2, 3, 4]], [0, 520, '1d']])
  expect(regroupMovesItem(items, cfg, 6)).toBe(true)
})

test('what a query change holds in place: the target in view in its place; else the target taking the previous target\'s place, with that place\'s row; else the previous target in view keeping its place; nothing otherwise', () => {
  // the owner (2026-10-07): Left and Right swap a sibling into the place of the item being read, below the
  // same context, and its row there followed its own bucket (the regroup) or its stale row among the rest
  // (the keeping pass), so the item being read shifted; Down into a child the shown count hid regrouped
  // with nothing held, and a row above the item being read pushed it down. A root and its children: the
  // first in the root's bucket, the second newer (a row of its own), then the rest; the children's query
  // lists the root above the child as context
  const cfg = config({ columnCount: 1 })
  const [root, first, second, rest] = [item(3, 100), item(3, 100), item(5, 100), item(1, 100)]
  const onFirst = [root, first, second, rest] // the first child's query: the second among the rest
  layoutItems(onFirst, cfg)
  expect(onFirst.map(it => [it.timeString, it.pos])).toEqual([['3d', 100], ['', 232], ['5d', 340], ['1d', 472]])
  const before = onFirst.map(it => ({ ...it }))
  // Right to the second child: it takes the first child's place, below the root; the first child, on the
  // page, is the previous target. the regroup would row it (its bucket against the root's) 24 px below
  // where the first child's text was, the keeping pass by the row it had among the rest: it takes over the
  // row of the place instead (none), and the regroup moves it
  const onSecond = [root, second, first, rest]
  const onPage = (it: any) => it === root || it === first
  expect(regroupMovesReader(onSecond, cfg, 1, 2, onPage)).toBe(true)
  expect(second.timeString, 'the row of the place, written for the keeping pass').toBe('')
  expect(onSecond.map(it => ({ ...it, timeString: it === second ? '5d' : it.timeString })), 'nothing else written, on the second child or the others').toEqual([before[0], before[2], before[1], before[3]])
  layoutItems(onSecond, { ...cfg, regroupTimeRows: false })
  expect([second.pos, second.timeString], "the keeping pass: the second child's text where the first's was").toEqual([232, ''])
  // Right again, to the third child, in the root's bucket: it takes over the place's row (none), and its
  // own grouping agrees: no move, the regroup runs
  const third = item(3, 100)
  const onThird = [root, third, second, first, rest]
  expect(regroupMovesReader(onThird, cfg, 1, 2, it => it === root || it === second)).toBe(false)
  layoutItems(onThird, cfg)
  expect(onThird.map(it => it.timeString), 'the regroup: the second child heads its group among the rest').toEqual(['3d', '', '5d', '3d', '1d'])
  // Left, back to the second child, which takes over the third's row (none) again; a sibling taking over a
  // ROW (a place whose item was rowed) keeps it with its own text: the regroup would lift its text
  const backToSecond = [root, second, third, first, rest]
  expect(regroupMovesReader(backToSecond, cfg, 1, 2, it => it === root || it === third)).toBe(true)
  layoutItems(backToSecond, { ...cfg, regroupTimeRows: false })
  expect([second.pos, second.timeString]).toEqual([232, ''])
  const [parent, rowed, plain] = [item(3, 100), item(5, 100), item(3, 100)]
  layoutItems([parent, rowed, plain], cfg)
  expect(rowed.timeString).toBe('5d')
  expect(regroupMovesReader([parent, plain, rowed], cfg, 1, 2, it => it === parent || it === rowed), 'the regroup would drop the row the place had').toBe(true)
  layoutItems([parent, plain, rowed], { ...cfg, regroupTimeRows: false })
  expect([plain.pos, plain.timeString], 'the row kept, with the text of its own bucket').toEqual([232, '3d'])
})

test('what a query change holds in place: Down into a hidden child holds the item above it, a target in view in its place is held, a previous target that leaves its place holds nothing, nor does no target in view', () => {
  const cfg = config({ columnCount: 1 })
  const [root, parent, child] = [item(3, 100), item(3, 100), item(3, 100)]
  const items = [root, parent, child]
  layoutItems(items, cfg)
  expect(items.map(it => it.timeString)).toEqual(['3d', '', ''])
  parent.time = 9 // touched to now by a passive re-ranking: a regroup would row it, pushing the child down
  // Down into the child, behind the shown count (no element): the parent, the previous target, keeps its
  // place in view and is held; the regroup moves it
  expect(regroupMovesReader(items, cfg, 2, 1, it => it === parent)).toBe(true)
  // the child shown: the target in view in its place is held, and the parent's row moves it too
  expect(regroupMovesReader(items, cfg, 2, 1, () => true)).toBe(true)
  // nothing in view: nothing held
  expect(regroupMovesReader(items, cfg, 2, 1, () => false)).toBe(false)
  // no target (an empty query) with the previous target in view in its place: held
  expect(regroupMovesReader(items, cfg, -1, 1, it => it === parent)).toBe(true)
  // the same target (a re-ranking under the same name) in view in its place: as before
  expect(regroupMovesReader(items, cfg, 1, 1, () => true)).toBe(true)
  expect(regroupMovesReader(items, cfg, 1, -1, () => true), 'no previous target').toBe(true)
  // a typed query that puts the child first, the root and the parent below it: the previous target (the
  // parent) leaves its place, the target takes a new one; nothing held although the regroup rows the parent
  const retyped = [child, root, parent]
  expect(regroupMovesReader(retyped, cfg, 0, 2, () => true)).toBe(false)
  expect(previewLayout(retyped, { ...cfg, regroupTimeRows: true }, () => retyped.map(it => it.timeString)), 'the regroup rows the parent').toEqual(['3d', '', '9d'])
  expect(items.map(it => [it.timeString, it.pos]), 'the layout as before').toEqual([['3d', 100], ['', 232], ['', 340]])
})

test('a sibling takes the place with the row of the place: its own stale row would push it over a column break, which read as another place', () => {
  // review 0 B1 (the reviewer's table): two columns, a root and two children of equal height, the second
  // newer than the root's bucket; under the first child's query the second, rowed, spills to the second
  // column. Right to the second child: with its stale row its box is 24 px taller and spills again in the
  // keeping pass, so the first cut read it as not taking the first child's place and held nothing (the
  // regroup ran, the second child landing in the second column, rowed); with the row of the place (none)
  // it fits the first column exactly, where the first child's text was, and the regroup moves it
  const cfg = config({ columnCount: 2, headerHeight: 100, screenHeight: 1000 })
  const [root, first, second] = [item(3, 468), item(3, 212), item(5, 212)]
  layoutItems([root, first, second], cfg)
  expect([root, first, second].map(it => [it.column, it.pos, it.timeString])).toEqual([[0, 100, '3d'], [0, 600, ''], [1, 0, '5d']])
  const swapped = [root, second, first]
  const skip = regroupMovesReader(swapped, cfg, 1, 2, it => it === first)
  expect(skip).toBe(true)
  layoutItems(swapped, { ...cfg, regroupTimeRows: !skip })
  expect([second.column, second.pos, second.timeString], "the second child where the first's text was, no row").toEqual([0, 600, ''])
  // a sibling that takes no place (a third column's worth of context above it) has its own row restored
  const [parent, before, after] = [item(3, 100), item(3, 100), item(5, 100)]
  layoutItems([parent, before, after], config({ columnCount: 1 }))
  expect(after.timeString).toBe('5d')
  const far = item(3, 2000)
  expect(regroupMovesReader([far, parent, after, before], config({ columnCount: 1 }), 2, 3, it => it === before)).toBe(false)
  expect(after.timeString, 'its own row restored, the place not taken').toBe('5d')
})

test('a column leader gets a time string (and its height) even mid-group', () => {
  const items = [item(3, 600), item(3, 600), item(3, 600)]
  layoutItems(items, config())
  expect(items.map(it => it.column)).toEqual([0, 1, 2])
  // items 1 and 2 share item 0's time group but lead their columns, so they carry the string
  expect(items.map(it => it.timeString)).toEqual(['3d', '3d', '3d'])
  expect(items.map(it => it.leader)).toEqual([true, true, true])
})

test('above-fold uses measured heights when available, else the first five per column', () => {
  const measured = [item(9, 400), item(8, 400), item(7, 400), item(6, 400)]
  layoutItems(measured, config({ columnCount: 1, screenHeight: 1000 }))
  // fold: heights accumulate 100 -> 532 -> 964 -> 1396: the fourth starts past one screen
  expect(measured.map(it => it.aboveFold)).toEqual([true, true, true, false])
  const unmeasured = Array.from({ length: 7 }, (_, i) => item(9 - i, 0))
  layoutItems(unmeasured, config({ columnCount: 1 }))
  expect(unmeasured.map(it => it.aboveFold)).toEqual([true, true, true, true, true, false, false])
  const pinned = [item(1, 2000, { pinned: true })]
  layoutItems(pinned, config({ columnCount: 1, screenHeight: 100 }))
  expect(pinned[0].aboveFold).toBe(true)
})

test('movers mark visible items that appeared or moved, and settle on a repeated layout', () => {
  const items = [item(3, 100), item(2, 100), item(1, 100)]
  const first = layoutItems(items, config({ columnCount: 1, hideIndex: 2 }))
  expect(items.map(it => it.mover)).toEqual([true, true, false]) // item 2 is past hideIndex
  expect(first.topMovers[0]).toBe(0)
  const second = layoutItems(items, config({ columnCount: 1, hideIndex: 2 }))
  expect(items.map(it => it.mover)).toEqual([false, false, false]) // nothing changed
  expect(second.topMovers[0]).toBe(items.length) // no movers
})
