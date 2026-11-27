// Option+Down (Alt+ArrowDown), Option+Up (Alt+ArrowUp), Option+PageDown (Alt+PageDown), and
// Option+PageUp (Alt+PageUp): one hold of Option is one walk. Walks items below the selected one
// (or globally when the box is empty) in descending time order without wrapping, steps back through
// the active walk to its start without passing it, and jumps straight to the oldest item or back to
// the start; releasing Option (or losing window focus) ends the walk so the next hold starts fresh
// from what the box names, and none of the four keys does anything outside a walk / valid start
// (the owner, 2026-11-24, 2026-11-26 and 2026-11-27). Pure choice and walk state, shared by
// index.svelte, Editor.svelte and tests/unit/recent_descendant.spec.ts.

export type RecentItem = {
  id: string
  time: number
  pinned?: boolean
  ancestors?: readonly string[]
}

export type RecentWalk = {
  start: string | null // null for the global case (empty box), else lowercased unique label
  startId: string | null // id of the start item when resolved at walk start, else null
  visited: readonly string[] // ids selected so far in this walk (empty when stepped back to the start)
  ahead: readonly string[] // ids stepped back from, in forward order (equal-time tie preference on replay)
  tieOrder: ReadonlyMap<string, number> // rank by id of eligible items when the walk started (final tie-break for the hold)
  query: string // exact MindBox text written by the last step
}

export type RecentWalkBackResult<T extends RecentItem> = {
  item: T | null // target item stepped back to, or null for the global empty-box start, a stop, or outside a walk
  query: string | null // exact MindBox text to write, or null when no navigation occurs
  walk: RecentWalk | null // updated walk state, or null when no walk is active
}

export type ModifierState = {
  altKey?: boolean
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

// Alt/Option+ArrowDown alone (no Shift, Ctrl or Cmd: two or more of Ctrl, Alt and Cmd is the
// global scroll shortcut, and Shift+ArrowDown toggles items)
export const isRecentDownKey = (key: string, e: ModifierState): boolean =>
  key == 'ArrowDown' && !!e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey

// Alt/Option+ArrowUp alone (same modifier restriction: two or more of Ctrl, Alt and Cmd is the
// global scroll shortcut, and Shift+ArrowUp toggles items)
export const isRecentUpKey = (key: string, e: ModifierState): boolean =>
  key == 'ArrowUp' && !!e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey

// Alt/Option+PageDown alone (no Shift, Ctrl or Cmd): jump to the walk's oldest item
export const isRecentPageDownKey = (key: string, e: ModifierState): boolean =>
  key == 'PageDown' && !!e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey

// Alt/Option+PageUp alone (no Shift, Ctrl or Cmd): jump back to the walk's start
export const isRecentPageUpKey = (key: string, e: ModifierState): boolean =>
  key == 'PageUp' && !!e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey

// Option/Alt release on keyup: ends an active walk once no Option key remains held (either Option
// key alone reports `altKey: false`; releasing a second Option key while the first is still held
// keeps `altKey: true` on browsers that track per-side modifier state, so the walk continues until
// the last held Option key comes up)
export const isRecentWalkEndKey = (key: string, e: ModifierState): boolean =>
  (key == 'AltLeft' || key == 'AltRight' || key == 'Alt' || key == 'AltGraph') && !e.altKey

// resolve what a fresh press starts from given the box text: null for the global case (empty box),
// a lowercased unique label for a selected named item, or undefined when the box names no valid start
// (an id reference, a non-unique or missing label, #log, or a multi-term/search/command query)
export function recentStart(query: string, hasUniqueLabel?: (label: string) => boolean): string | null | undefined {
  const trimmed = query.trim()
  if (!trimmed) return null
  if (!/^#[^#\s]+$/.test(trimmed)) return undefined
  const label = trimmed.toLowerCase()
  if (label == '#log') return undefined
  if (hasUniqueLabel && !hasUniqueLabel(label)) return undefined
  return label
}

// pick the newest eligible item not yet in `visited`, breaking equal-time ties by `preferred`
// order (ids stepped back from during replay, earlier first), then by `tieOrder` (order captured
// when the walk started; items absent at start come after those present), and finally by `items`
// array order:
// - global (`start === null` or empty): non-pinned items, named or unnamed
// - label (`#...`): items whose `ancestors` include the label (at any depth, tag parents included)
// - anything else (e.g. `id:...`, `#log`, search text): null (nothing below it)
const isEligible = (item: RecentItem, start: string | null): boolean =>
  start === null ? !item.pinned : !!item.ancestors?.includes(start)

function isRankMap(order: ReadonlyMap<string, number> | Iterable<string>): order is ReadonlyMap<string, number> {
  return order instanceof Map
}

function buildRank(order?: ReadonlyMap<string, number> | Iterable<string>): ReadonlyMap<string, number> | null {
  if (!order) return null
  if (isRankMap(order)) return order
  let rank: Map<string, number> | null = null
  for (const id of order) {
    if (!rank) rank = new Map()
    if (!rank.has(id)) rank.set(id, rank.size)
  }
  return rank
}

function captureTieOrder<T extends RecentItem>(items: readonly T[], start: string | null): Map<string, number> {
  const rank = new Map<string, number>()
  for (const item of items) {
    if (!isEligible(item, start) || rank.has(item.id)) continue
    rank.set(item.id, rank.size)
  }
  return rank
}

export function nextRecentItem<T extends RecentItem>(
  items: readonly T[],
  start: string | null,
  visited?: Iterable<string>,
  preferred?: Iterable<string>,
  tieOrder?: ReadonlyMap<string, number> | Iterable<string>,
): T | null {
  const resolved = start === null ? null : recentStart(start)
  if (resolved === undefined) return null
  const seen = visited ? new Set(visited) : null
  const preferRank = buildRank(preferred)
  const tieRank = buildRank(tieOrder)
  let best: T | null = null
  let bestTime = -Infinity
  let bestPrefer = Infinity
  let bestTie = Infinity
  for (const item of items) {
    if (seen?.has(item.id) || !isEligible(item, resolved)) continue
    const time = Number.isFinite(item.time) ? item.time : -Infinity
    const prefer = preferRank?.get(item.id) ?? Infinity
    const tie = tieRank?.get(item.id) ?? Infinity
    if (
      best === null ||
      time > bestTime ||
      (time === bestTime && (prefer < bestPrefer || (prefer === bestPrefer && tie < bestTie)))
    ) {
      best = item
      bestTime = time
      bestPrefer = prefer
      bestTie = tie
    }
  }
  return best
}

// all eligible unvisited items under `start`, in the exact order repeated `nextRecentItem` calls
// would visit them: `time` descending (non-finite treated as `-Infinity`), equal-time ties broken
// by `preferred` order (first occurrence, earlier first), then by `tieOrder` (ranks from walk
// start, absent items after present ones), and finally by `items` array order
function orderedRecentItems<T extends RecentItem>(
  items: readonly T[],
  start: string | null,
  visited?: Iterable<string>,
  preferred?: Iterable<string>,
  tieOrder?: ReadonlyMap<string, number> | Iterable<string>,
): T[] {
  const resolved = start === null ? null : recentStart(start)
  if (resolved === undefined) return []
  const seen = visited ? new Set(visited) : null
  const preferRank = buildRank(preferred)
  const tieRank = buildRank(tieOrder)
  const candidates: { item: T; time: number; prefer: number; tie: number; index: number }[] = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (seen?.has(item.id) || !isEligible(item, resolved)) continue
    const time = Number.isFinite(item.time) ? item.time : -Infinity
    const prefer = preferRank?.get(item.id) ?? Infinity
    const tie = tieRank?.get(item.id) ?? Infinity
    candidates.push({ item, time, prefer, tie, index })
  }
  if (candidates.length <= 1) return candidates.map(c => c.item)
  candidates.sort((a, b) => {
    if (a.time !== b.time) return a.time > b.time ? -1 : 1
    if (a.prefer !== b.prefer) return a.prefer < b.prefer ? -1 : 1
    if (a.tie !== b.tie) return a.tie < b.tie ? -1 : 1
    return a.index - b.index
  })
  const result: T[] = []
  const added = new Set<string>()
  for (const c of candidates) {
    if (added.has(c.item.id)) continue
    added.add(c.item.id)
    result.push(c.item)
  }
  return result
}

// whether `walk` is still active on `boxText`: the box still holds the exact query the last step
// wrote, the start item still exists uniquely (and is still the same item when `startId` and
// `selectedId` are given), and `boxText` still selects the step's item (or the start item when
// stepped back to the start of a labelled walk)
function isWalkContinuing(
  boxText: string,
  walk: RecentWalk | null,
  hasUniqueLabel?: (label: string) => boolean,
  selectedId?: (query: string) => string | null | undefined,
): walk is RecentWalk {
  if (walk === null || boxText !== walk.query) return false
  if (walk.start !== null) {
    if (hasUniqueLabel && !hasUniqueLabel(walk.start)) return false
    if (selectedId && walk.startId != null && selectedId(walk.start) !== walk.startId) return false
  }
  if (walk.visited.length > 0) {
    if (selectedId && selectedId(boxText) !== walk.visited[walk.visited.length - 1]) return false
  } else if (walk.start !== null) {
    if (selectedId && walk.startId != null && selectedId(boxText) !== walk.startId) return false
  }
  return true
}

// advance or start a walk for a press of Option+Down. Continues `walk` only while the box still
// holds the exact query the last step wrote AND that query still selects the step's item
// (`selectedId`: the id of the item a query selects, as the app resolves it, without case for a
// label and by either spelling of an id). An item renamed away or deleted elsewhere (another tab,
// an agent) leaves its old query in the box: the walk ends there and the press starts anew from
// what the box names now, which is nothing, or the item that took the old label. A name changed
// in its case alone, or a first label given to an item selected by its id, still selects the item,
// and the walk goes on. Callers also clear `walk` on Option release, window focus loss, any other
// box change, or history traversal.
// At the walk's end returns `{ item: null, walk }` so another press stays a no-op instead of
// wrapping or restarting from the last selected item
export function stepRecentWalk<T extends RecentItem>(
  items: readonly T[],
  boxText: string,
  walk: RecentWalk | null,
  queryOf: (item: T) => string,
  hasUniqueLabel?: (label: string) => boolean,
  selectedId?: (query: string) => string | null | undefined,
): { item: T | null; walk: RecentWalk | null } {
  if (isWalkContinuing(boxText, walk, hasUniqueLabel, selectedId)) {
    const next = nextRecentItem(items, walk.start, walk.visited, walk.ahead, walk.tieOrder)
    if (!next) return { item: null, walk }
    const query = queryOf(next)
    const ahead = walk.ahead.length ? walk.ahead.filter(id => id !== next.id) : []
    return {
      item: next,
      walk: {
        start: walk.start,
        startId: walk.startId,
        visited: [...walk.visited, next.id],
        ahead,
        tieOrder: walk.tieOrder,
        query,
      },
    }
  }
  const start = recentStart(boxText, hasUniqueLabel)
  if (start === undefined) return { item: null, walk: null }
  const next = nextRecentItem(items, start)
  if (!next) return { item: null, walk: null }
  const startId = start === null || !selectedId ? null : (selectedId(boxText) ?? null)
  const query = queryOf(next)
  return {
    item: next,
    walk: { start, startId, visited: [next.id], ahead: [], tieOrder: captureTieOrder(items, start), query },
  }
}

// step back through an active walk for a press of Option+Up:
// - outside a walk (no walk, box changed, current or start item renamed/deleted): returns
//   `{ item: null, query: null, walk: null }` so the caller clears any stale walk and does nothing
// - at the walk's start (`visited` empty): returns `{ item: null, query: null, walk }` (no-op stop;
//   the walk stays on so Option+Down goes forward again from the first item)
// - from the k-th item (k >= 2): returns the nearest earlier visited item still present and
//   eligible under `walk.start` (passing over any earlier item deleted or moved out of the start
//   meanwhile, symmetric with forward passing over an unvisited sibling that is gone)
// - from the first item (or when all earlier visited items are gone): returns to the walk's start
//   (empty box `''` for a global walk, else the start item's query or `${walk.start} `), leaving
//   `visited` empty so a further Option+Up stops and Option+Down goes forward again
export function stepRecentWalkBack<T extends RecentItem>(
  items: readonly T[],
  boxText: string,
  walk: RecentWalk | null,
  queryOf: (item: T) => string,
  hasUniqueLabel?: (label: string) => boolean,
  selectedId?: (query: string) => string | null | undefined,
): RecentWalkBackResult<T> {
  if (!isWalkContinuing(boxText, walk, hasUniqueLabel, selectedId)) {
    return { item: null, query: null, walk: null }
  }
  if (walk.visited.length === 0) {
    return { item: null, query: null, walk }
  }
  for (let i = walk.visited.length - 2; i >= 0; i--) {
    const prevId = walk.visited[i]
    const prev = items.find(item => item.id === prevId)
    if (!prev || !isEligible(prev, walk.start)) continue
    const query = queryOf(prev)
    const ahead = [...walk.visited.slice(i + 1), ...walk.ahead]
    return {
      item: prev,
      query,
      walk: {
        start: walk.start,
        startId: walk.startId,
        visited: walk.visited.slice(0, i + 1),
        ahead,
        tieOrder: walk.tieOrder,
        query,
      },
    }
  }
  return backToStart(items, walk, queryOf)
}

function backToStart<T extends RecentItem>(
  items: readonly T[],
  walk: RecentWalk,
  queryOf: (item: T) => string,
): RecentWalkBackResult<T> {
  const ahead = [...walk.visited, ...walk.ahead]
  if (walk.start === null) {
    return {
      item: null,
      query: '',
      walk: { start: null, startId: null, visited: [], ahead, tieOrder: walk.tieOrder, query: '' },
    }
  }
  const startItem = walk.startId != null ? (items.find(item => item.id === walk.startId) ?? null) : null
  if (walk.startId != null && !startItem) {
    return { item: null, query: null, walk: null }
  }
  const query = startItem ? queryOf(startItem) : `${walk.start} `
  return {
    item: startItem,
    query,
    walk: { start: walk.start, startId: walk.startId, visited: [], ahead, tieOrder: walk.tieOrder, query },
  }
}

// jump to the oldest eligible item of a walk for a press of Option+PageDown:
// - while a walk is continuing, jumps to the oldest remaining unvisited eligible item (the exact
//   item repeated Option+Down presses would stop on), recording all newly passed items in `visited`
//   in the same order (equal-time tie rules and `ahead` preferences included) so Option+Up steps
//   back through them one by one; at the oldest item already, returns `{ item: null, walk }`
// - outside a walk (first key of a hold, or stale/drifted walk), starts a fresh walk from
//   `boxText` with the same valid starts as Option+Down and jumps straight to the oldest item; if
//   `boxText` names no valid start or has no eligible items, returns `{ item: null, walk: null }`
export function jumpRecentWalkOldest<T extends RecentItem>(
  items: readonly T[],
  boxText: string,
  walk: RecentWalk | null,
  queryOf: (item: T) => string,
  hasUniqueLabel?: (label: string) => boolean,
  selectedId?: (query: string) => string | null | undefined,
): { item: T | null; walk: RecentWalk | null } {
  if (isWalkContinuing(boxText, walk, hasUniqueLabel, selectedId)) {
    const remaining = orderedRecentItems(items, walk.start, walk.visited, walk.ahead, walk.tieOrder)
    if (!remaining.length) return { item: null, walk }
    const oldest = remaining[remaining.length - 1]
    const query = queryOf(oldest)
    const remainingIds = remaining.map(item => item.id)
    let ahead: readonly string[] = []
    if (walk.ahead.length) {
      const addedIds = new Set(remainingIds)
      ahead = walk.ahead.filter(id => !addedIds.has(id))
    }
    return {
      item: oldest,
      walk: {
        start: walk.start,
        startId: walk.startId,
        visited: [...walk.visited, ...remainingIds],
        ahead,
        tieOrder: walk.tieOrder,
        query,
      },
    }
  }
  const start = recentStart(boxText, hasUniqueLabel)
  if (start === undefined) return { item: null, walk: null }
  const ordered = orderedRecentItems(items, start)
  if (!ordered.length) return { item: null, walk: null }
  const startId = start === null || !selectedId ? null : (selectedId(boxText) ?? null)
  const oldest = ordered[ordered.length - 1]
  const query = queryOf(oldest)
  return {
    item: oldest,
    walk: { start, startId, visited: ordered.map(item => item.id), ahead: [], tieOrder: captureTieOrder(items, start), query },
  }
}

// jump back to the start of an active walk for a press of Option+PageUp:
// - outside a walk (no walk, first key of a hold, box changed, current or start item renamed or
//   deleted): returns `{ item: null, query: null, walk: null }`
// - at the walk's start already (`visited` empty): returns `{ item: null, query: null, walk }`
// - anywhere further in the walk: returns straight to the walk's start (empty box `''` for a
//   global walk, else the start item's query or `${walk.start} `), moving `visited` onto the
//   front of `ahead` so Option+Down replays from the newest item with the same tie preferences
export function jumpRecentWalkStart<T extends RecentItem>(
  items: readonly T[],
  boxText: string,
  walk: RecentWalk | null,
  queryOf: (item: T) => string,
  hasUniqueLabel?: (label: string) => boolean,
  selectedId?: (query: string) => string | null | undefined,
): RecentWalkBackResult<T> {
  if (!isWalkContinuing(boxText, walk, hasUniqueLabel, selectedId)) {
    return { item: null, query: null, walk: null }
  }
  if (walk.visited.length === 0) {
    return { item: null, query: null, walk }
  }
  return backToStart(items, walk, queryOf)
}
