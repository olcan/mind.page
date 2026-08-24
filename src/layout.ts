// per-item layout pass (extracted from updateItemLayout in index.svelte; table-tested with
// synthetic heights in tests/unit/layout.spec.ts): time-string grouping, column assignment
// (items stay on their column until it runs ~a screen height over the minimum, then move to the
// minimum column, recording section-separator arrows on the item before the break), above-fold
// marking, per-column chaining and mover flags. deterministic over plain facts and the injected
// time formatter; dom measurement, sizing and scroll scheduling stay in the component.

export type LayoutConfig = {
  columnCount: number
  headerHeight: number // first column includes the header
  screenHeight: number // window.outerHeight in the app
  defaultItemHeight: number // 0 until measured: initial layout is effectively single-column
  separatorHeight: number // .section-separator height including margins
  hideIndex: number // items past this index are hidden (movers are only marked when visible)
  fixed: boolean // fixed (shared) pages render no time strings
  timeString: (time: number) => string
}

export type LayoutAggregates = {
  columnHeights: number[]
  columnLastItem: number[]
  columnItemCount: number[]
  topMovers: number[] // per column, the smallest index that became visible or moved
  newestTime: number
  oldestTime: number
  oldestTimeString: string
  totalItemHeight: number
}

// mutates the per-item layout fields (column, pos, outerHeight, timeString, timeOutOfOrder,
// leader, aboveFold, arrows, nextColumn, nextItemInColumn, mover, lastVisible/lastColumn/lastPos)
// exactly as the original loop did, and returns the aggregates the caller scrolls/sizes with
export function layoutItems(items: any[], config: LayoutConfig): LayoutAggregates {
  const { columnCount, screenHeight, defaultItemHeight, separatorHeight, hideIndex, fixed } = config
  const columnHeights = new Array(columnCount).fill(0)
  const columnLastItem = new Array(columnCount).fill(-1)
  const columnItemCount = new Array(columnCount).fill(0)
  columnHeights[0] = config.headerHeight // first column includes header
  const topMovers = new Array(columnCount).fill(items.length) // see definition of "mover" below
  let lastTimeString = ''
  let newestTime = 0
  let oldestTime = Infinity
  let oldestTimeString = ''
  let totalItemHeight = 0

  items.forEach((item, index) => {
    let lastItem = items[index - 1]
    let timeString = config.timeString(item.time)
    if (item.time < oldestTime) {
      oldestTime = item.time
      oldestTimeString = timeString
    }
    if (item.time > newestTime) newestTime = item.time

    item.timeString = ''
    item.timeOutOfOrder = false
    if (!fixed && !item.pinned && (index == 0 || timeString != lastTimeString)) {
      item.timeString = timeString
      item.timeOutOfOrder = index > 0 && !lastItem.pinned && item.time > lastItem.time && timeString != lastTimeString
      lastTimeString = timeString // for grouping of subsequent items
    }

    // calculate item height (zero if dotted, or not yet calculated and default is zero)
    item.outerHeight = item.dotted ? 0 : item.height || defaultItemHeight
    // add item margins + time string height
    if (item.outerHeight > 0) item.outerHeight += 8 + (item.timeString ? 24 : 0)
    totalItemHeight += item.height // used to hide items until height available

    // determine item column
    item.nextColumn = -1
    item.nextItemInColumn = -1

    if (index == 0) item.column = 0
    else {
      // stay on same column unless column height would exceed minimum column height by 90% of screen height
      const lastColumn = lastItem.column
      const minColumnHeight = Math.min(...columnHeights)
      if (
        columnHeights[lastColumn] <= minColumnHeight + 0.5 * screenHeight ||
        columnHeights[lastColumn] + item.outerHeight + separatorHeight <= minColumnHeight + 0.9 * screenHeight
      )
        item.column = lastColumn
      else item.column = columnHeights.indexOf(minColumnHeight)
      if (item.column != lastColumn) {
        lastItem.nextColumn = item.column
        lastItem.arrows = item.column < lastColumn ? '↖' : ''
        for (let i = 0; i < Math.abs(item.column - lastColumn) - 1; ++i)
          lastItem.arrows += item.column < lastColumn ? '←' : '→'
        lastItem.arrows += item.column < lastColumn ? '' : '↗'
        // NOTE: we include .section-separator height but ignore show which is dynamic (like dotted items)
        columnHeights[lastColumn] += separatorHeight // .section-separator height including margins
      }
    }
    // mark item as aboveFold if it is pinned or item is visible (at least partially) on first screen
    // if item heights are not available, then we use item index in column and assume top 5 are above fold
    item.aboveFold =
      item.pinned || (item.height ? columnHeights[item.column] < screenHeight : columnItemCount[item.column] < 5)
    columnItemCount[item.column]++

    // if non-pinned item is first in its column or section and missing time string, add it now
    // also mark it as a "leader" for styling its index number
    item.leader = !item.pinned && (columnLastItem[item.column] < 0 || item.column != lastItem.column)
    if (!fixed && item.leader && !item.timeString) {
      item.timeString = timeString
      lastTimeString = timeString // for grouping of subsequent items
      // add time string height now, assuming we are not ignoring item height
      if (item.outerHeight > 0) item.outerHeight += 24
    }
    item.pos = columnHeights[item.column] // position in column
    columnHeights[item.column] += item.outerHeight
    if (columnLastItem[item.column] >= 0) {
      items[columnLastItem[item.column]].nextItemInColumn = index
      // if item is below section-separator and has timeString, discount -24px negative margin
      if (columnLastItem[item.column] != index - 1 && item.timeString) columnHeights[item.column] -= 24
    }
    columnLastItem[item.column] = index

    // mark item as "mover" if it becomes visible or changes column or position (within column)
    // note visibility (hideIndex) can change between layouts, but we use mover flags only for immediately scrolling
    item.mover =
      index < hideIndex && (!item.lastVisible || item.column != item.lastColumn || item.pos != item.lastPos)

    if (item.mover && index < topMovers[item.column]) topMovers[item.column] = index
    item.lastVisible = index < hideIndex
    item.lastColumn = item.column
    item.lastPos = item.pos
  })

  return { columnHeights, columnLastItem, columnItemCount, topMovers, newestTime, oldestTime, oldestTimeString, totalItemHeight }
}
