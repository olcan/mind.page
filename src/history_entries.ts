// the session's copy of the page's history entries, and the test an entry must pass before anything of it
// is read (plain data: index.svelte owns every effect, see its pushState, replaceState and onPopState).
//
// An entry of the browser's history that the app wrote carries its whole state: the index the app gave
// it, the notebook it belongs to (`owner`: the account and the page it shows, see index.svelte's
// initialize) and the view (the query, the unsaved times, the order's hash, the shown count, the
// position). The browser keeps those entries across a reload, a sign-out and a sign-in in the same tab,
// so a state read back from the browser is DATA FROM ELSEWHERE until `ownEntry` has passed it: an entry
// of another account must not put its query into this notebook, and an entry of older code, which names
// no owner, cannot be told from one.
//
// The index is LOGICAL: the app counts its entries up from the one it started on and continues across
// reloads, so in a long-lived tab it outgrows the entries the browser still holds, and the difference of
// two indexes is the distance `history.go` takes only across consecutively numbered entries. The session
// therefore holds the entries it wrote or landed on, keyed by index, and nothing per index in between.
//
// Entries are numbered in RUNS (`run`): one starts where the session cannot say how far its next entry is
// from the ones before (a launch on a state that is not the notebook's own; a navigation from a position
// of the browser's that holds no entry of the notebook's, see index.svelte's onPopState), so the
// difference of two indexes is offered as a distance only within a run, and the session holds one run.

export type HistoryEntry = {
  index: number
  owner: string
  run: number
  editorText: string
  unsavedTimes?: { id: string; time: number }[]
  orderHash?: string
  hideIndex?: number
  scrollPosition?: number
  final?: boolean
  intro?: boolean
  scrolledToTop?: boolean
  [key: string]: unknown // other writers' keys (SvelteKit's router marks the entry a page loads on)
}

const optional = (value: unknown, type: 'string' | 'boolean') => value === undefined || typeof value == type
const optionalNumber = (value: unknown) => value === undefined || (typeof value == 'number' && !Number.isNaN(value))

// whether a state read from the browser is an entry of THIS notebook that the restore can consume: the
// owner it was written under, an index usable as a distance, and every field the app reads in the shape
// it reads it. Anything else (another account's entry, older code's, another script's, a damaged one) is
// not the app's to read
export function ownEntry(state: unknown, owner: string | null | undefined): state is HistoryEntry {
  if (!owner || typeof state != 'object' || state === null) return false
  const s = state as Record<string, unknown>
  return (
    s.owner === owner &&
    Number.isFinite(s.run) &&
    Number.isSafeInteger(s.index) &&
    (s.index as number) >= 0 &&
    typeof s.editorText == 'string' &&
    optional(s.orderHash, 'string') &&
    optional(s.final, 'boolean') &&
    optional(s.intro, 'boolean') &&
    optional(s.scrolledToTop, 'boolean') &&
    optionalNumber(s.hideIndex) &&
    (s.scrollPosition === undefined || Number.isFinite(s.scrollPosition)) &&
    (s.unsavedTimes === undefined ||
      (Array.isArray(s.unsavedTimes) &&
        s.unsavedTimes.every(t => typeof t == 'object' && t !== null && typeof t.id == 'string' && Number.isFinite(t.time))))
  )
}

// an entry with an update, as a NEW object: what a writer proposes. The entry it is built from (the
// browser's live state object, or the session's copy) stays as it was when the proposal is then not written
// (the session unsettled, the browser on a position that holds no entry of the notebook's)
export const updatedEntry = <T extends object>(entry: T, update: Partial<HistoryEntry>): T => ({ ...entry, ...update })

// the fragment of an address as text. A malformed one (a `%` that is no escape, as in `#100%`:
// decodeURIComponent throws) names nothing: the empty string, at a launch and at a navigation alike
export const decodedFragment = (hash: string): string => {
  try {
    return decodeURIComponent(hash)
  } catch {
    return ''
  }
}

// the identity of the state a page was created on, kept to tell whether the browser has moved since then:
// compared, never used (it can be another notebook's). `own`: whether the WHOLE state was an entry of the
// notebook it names (ownEntry under its declared owner), which the identity's three fields do not say
export type LaunchIdentity = { owner?: unknown; run?: unknown; index?: unknown; own?: boolean }
export const launchIdentity = (state: unknown): LaunchIdentity => {
  const s = (typeof state == 'object' && state !== null ? state : {}) as Record<string, unknown>
  return { owner: s.owner, run: s.run, index: s.index, own: ownEntry(state, typeof s.owner == 'string' ? s.owner : null) }
}

// whether the entry a page was created on can be the return address of a stop while the page is starting
// (index.svelte's initialize, after a traversal that left it): only an entry of THIS notebook's that the
// restore can consume. The owner alone is not enough: the notebook's own cleared marker, a fragment's
// marker and a damaged numbered state name it too, and the app cannot restore any of them
export const launchAnchor = (launch: LaunchIdentity | null, owner: string | null): boolean =>
  !!launch && launch.own === true && !!owner && launch.owner === owner

// where a session starts, decided when the notebook is known (index.svelte's initialize), from the state the
// browser is on THEN and whether a traversal arrived while the page was starting:
// - `deferred`: the browser has moved to another position. Nothing is written at startup, which would
//   replace what the position holds or drop the entries ahead of it; the page's handler applies the
//   position once the page is initialized (an entry of the notebook's is restored, any other state is a
//   position that holds none, a fragment is read). The browser has moved unless the state is the numbered
//   entry the page was created on, by its owner, run and index: an index and an address are shared by
//   entries of different runs (two free-text queries, each second of its run), and nothing tells two
//   positions without a numbered entry apart, so a traversal that ends on one is always a move
// - otherwise the page launches on the entry: the notebook's own is continued (its index and run, `held`
//   as the session's copy), any other state starts a new run at 0 (`run: null`), the launch's first write
//   replacing it
export type StartupPlace = { deferred: boolean; index: number; run: number | null; held: HistoryEntry | null }
export function startupPlace(owner: string | null, launch: LaunchIdentity | null, state: unknown, traversed: boolean): StartupPlace {
  const own = ownEntry(state, owner) ? state : null
  const same = !!own && !!launch && launch.owner === own.owner && launch.run === own.run && launch.index === own.index
  if (traversed && !same) return { deferred: true, index: 0, run: null, held: null }
  return own ? { deferred: false, index: own.index, run: own.run, held: own } : { deferred: false, index: 0, run: null, held: null }
}

// THE STOP: where the browser goes back to when Back or Forward has landed on a position that holds no entry
// of the notebook's that the app can take (index.svelte's onPopState), and which way it had moved. The
// browser moves first and tells the app afterwards, and nothing in a `popstate` says from where or which
// way: both are read off the Navigation API, whose key names a position of the browser's list for as long as
// the position lives (across a replacement and a reload) and whose index is the position's present place in
// that list. `places` is that list as the browser gives it now, `landed` the key of the position the browser
// is on, `held` the key noted when the browser was last on the entry the session is on. The return is to
// that KEY, never by a distance (a second Back pressed before the return has landed leaves a distance one
// short), and the way the browser moved is the side of the held position it landed on (after moves in
// between that can differ from the button pressed last). No return (`null`)
// where one cannot be said: a browser without the Navigation API (`places` or `landed` missing), a session
// that holds no entry at a position it knows, a held position the browser no longer lists, and a landing on
// the held position itself (what it held was replaced by another writer: there is nowhere else to go).
// The page then stays on the position, as it did before the stop (2026-11-18)
export type HistoryPlace = { key: string; index: number }
export type StopReturn = { key: string; forward: boolean }
export function stopReturn(places: HistoryPlace[] | null, landed: string | null, held: string | null): StopReturn | null {
  if (!places) return null
  const from = places.find(place => place.key === held)
  const to = places.find(place => place.key === landed)
  if (!from || !to || from.index === to.index) return null
  return { key: from.key, forward: to.index > from.index }
}

// a link of the list above the header: an earlier query and the distance to it (what history.go takes)
export type HistoryLink = { index: number; text: string; delta: number }

export class SessionEntries {
  private entries = new Map<number, HistoryEntry>()

  // the entries held: what the session wrote or landed on, whatever their indexes
  get size(): number {
    return this.entries.size
  }
  // one past the highest index held (0 when none): the length of the list the indexes describe
  get length(): number {
    let last = -1
    for (const index of this.entries.keys()) if (index > last) last = index
    return last + 1
  }
  get(index: number): HistoryEntry | undefined {
    return this.entries.get(index)
  }
  set(index: number, entry: HistoryEntry): void {
    this.entries.set(index, entry)
  }
  // drops the entries at and past an index: a new entry there replaces the browser's branch ahead
  truncate(index: number): void {
    for (const held of [...this.entries.keys()]) if (held >= index) this.entries.delete(held)
  }
  // the list above the header, as seen from the entry at `current`: the held entries with a query, in
  // order, except the last one held; `delta` is what history.go takes to reach the entry. No link from
  // a position that is none of the entries' (`null`): no distance can be said from there
  links(current: number | null): HistoryLink[] {
    if (current === null) return []
    const last = this.length - 1
    return [...this.entries.values()]
      .filter(entry => entry.index < last && entry.editorText.trim())
      .sort((a, b) => a.index - b.index)
      .map(entry => ({ index: entry.index, text: entry.editorText.trim(), delta: entry.index - current }))
  }
  // the entries as a sparse array by index (the tests' window._history): holes where nothing is held
  toArray(): HistoryEntry[] {
    const list: HistoryEntry[] = []
    for (const [index, entry] of this.entries) list[index] = entry
    return list
  }
}
