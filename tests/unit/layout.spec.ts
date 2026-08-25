import { expect, test } from '@playwright/test'
import { layoutItems, type LayoutConfig } from '../../src/layout.js'

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
