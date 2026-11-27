// Option+Down (Alt+ArrowDown) and Option+Up (Alt+ArrowUp): walk items below the selected one (or
// globally when the box is empty) in descending time order without wrapping, and step back through
// the active walk to its start without passing it; neither does anything outside a walk / valid
// start (the owner, 2026-11-24 and 2026-11-26). Pure choice and walk state, shared by
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
// order (ids stepped back from during replay, earlier first) and then by `items` order:
// - global (`start === null` or empty): non-pinned items, named or unnamed
// - label (`#...`): items whose `ancestors` include the label (at any depth, tag parents included)
// - anything else (e.g. `id:...`, `#log`, search text): null (nothing below it)
const isEligible = (item: RecentItem, start: string | null): boolean =>
  start === null ? !item.pinned : !!item.ancestors?.includes(start)

export function nextRecentItem<T extends RecentItem>(
  items: readonly T[],
  start: string | null,
  visited?: Iterable<string>,
  preferred?: Iterable<string>,
): T | null {
  const resolved = start === null ? null : recentStart(start)
  if (resolved === undefined) return null
  const seen = visited ? new Set(visited) : null
  let preferRank: Map<string, number> | null = null
  if (preferred) {
    for (const id of preferred) {
      if (!preferRank) preferRank = new Map()
      if (!preferRank.has(id)) preferRank.set(id, preferRank.size)
    }
  }
  let best: T | null = null
  let bestTime = -Infinity
  let bestRank = Infinity
  for (const item of items) {
    if (seen?.has(item.id) || !isEligible(item, resolved)) continue
    const time = Number.isFinite(item.time) ? item.time : -Infinity
    const rank = preferRank?.get(item.id) ?? Infinity
    if (best === null || time > bestTime || (time === bestTime && rank < bestRank)) {
      best = item
      bestTime = time
      bestRank = rank
    }
  }
  return best
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
// and the walk goes on. Callers also clear `walk` on any other box change or history traversal.
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
    const next = nextRecentItem(items, walk.start, walk.visited, walk.ahead)
    if (!next) return { item: null, walk }
    const query = queryOf(next)
    const ahead = walk.ahead.length ? walk.ahead.filter(id => id !== next.id) : []
    return {
      item: next,
      walk: { start: walk.start, startId: walk.startId, visited: [...walk.visited, next.id], ahead, query },
    }
  }
  const start = recentStart(boxText, hasUniqueLabel)
  if (start === undefined) return { item: null, walk: null }
  const next = nextRecentItem(items, start)
  if (!next) return { item: null, walk: null }
  const startId = start === null || !selectedId ? null : (selectedId(boxText) ?? null)
  const query = queryOf(next)
  return { item: next, walk: { start, startId, visited: [next.id], ahead: [], query } }
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
      walk: { start: walk.start, startId: walk.startId, visited: walk.visited.slice(0, i + 1), ahead, query },
    }
  }
  const ahead = [...walk.visited, ...walk.ahead]
  if (walk.start === null) {
    return {
      item: null,
      query: '',
      walk: { start: null, startId: null, visited: [], ahead, query: '' },
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
    walk: { start: walk.start, startId: walk.startId, visited: [], ahead, query },
  }
}
