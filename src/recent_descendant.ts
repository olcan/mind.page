// Option+Down (Alt+ArrowDown): select the newest item below the selected one (or globally when the box
// is empty), and on consecutive presses walk on to the next newest from the same start without going
// back up (the owner, 2026-11-24). Pure choice and walk state, shared by index.svelte, Editor.svelte
// and tests/unit/recent_descendant.spec.ts.

export type RecentItem = {
  id: string
  time: number
  pinned?: boolean
  ancestors?: readonly string[]
}

export type RecentWalk = {
  start: string | null // null for the global case (empty box), else lowercased unique label
  visited: readonly string[] // ids selected so far in this walk
  query: string // exact MindBox text written by the last step
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

// pick the newest eligible item not yet in `visited`, breaking equal-time ties by `items` order:
// - global (`start === null` or empty): non-pinned items, named or unnamed
// - label (`#...`): items whose `ancestors` include the label (at any depth, tag parents included)
// - anything else (e.g. `id:...`, `#log`, search text): null (nothing below it)
export function nextRecentItem<T extends RecentItem>(
  items: readonly T[],
  start: string | null,
  visited?: Iterable<string>,
): T | null {
  const resolved = start === null ? null : recentStart(start)
  if (resolved === undefined) return null
  const seen = visited ? new Set(visited) : null
  let best: T | null = null
  let bestTime = -Infinity
  for (const item of items) {
    if (seen?.has(item.id)) continue
    if (resolved === null) {
      if (item.pinned) continue
    } else {
      if (!item.ancestors?.includes(resolved)) continue
    }
    const time = Number.isFinite(item.time) ? item.time : -Infinity
    if (best === null || time > bestTime) {
      best = item
      bestTime = time
    }
  }
  return best
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
  const continuing =
    walk !== null &&
    boxText === walk.query &&
    (!selectedId || selectedId(boxText) === walk.visited[walk.visited.length - 1]) &&
    (walk.start === null || !hasUniqueLabel || hasUniqueLabel(walk.start))
  if (continuing) {
    const next = nextRecentItem(items, walk.start, walk.visited)
    if (!next) return { item: null, walk }
    const query = queryOf(next)
    return { item: next, walk: { start: walk.start, visited: [...walk.visited, next.id], query } }
  }
  const start = recentStart(boxText, hasUniqueLabel)
  if (start === undefined) return { item: null, walk: null }
  const next = nextRecentItem(items, start)
  if (!next) return { item: null, walk: null }
  const query = queryOf(next)
  return { item: next, walk: { start, visited: [next.id], query } }
}
