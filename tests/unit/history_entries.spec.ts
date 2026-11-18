import { expect, test } from '@playwright/test'

import { SessionEntries, decodedFragment, launchIdentity, ownEntry, startupPlace, updatedEntry, type HistoryEntry } from '../../src/history_entries.js'

const OWNER = '|alice|'
const entry = (index: number, editorText = '', more: Record<string, unknown> = {}): HistoryEntry => ({ index, owner: OWNER, run: 1, editorText, ...more })

test('an entry is the notebook\'s own only under its owner, with a usable index and the fields the restore reads', () => {
  const full = entry(3, 'free text query', {
    unsavedTimes: [{ id: 'abc', time: 1 }],
    orderHash: 'f00',
    hideIndex: 2,
    scrollPosition: 612.5,
    final: true,
    intro: false,
    scrolledToTop: false,
    'sveltekit:history': 1794962777323, // another writer's key is carried, not judged
  })
  expect(ownEntry(full, OWNER)).toBe(true)
  expect(ownEntry(entry(0), OWNER), 'the first view before its position is recorded').toBe(true)
  expect(ownEntry({ ...entry(0), scrollPosition: undefined }, OWNER)).toBe(true)
  // the owner: another account's entry, an entry of older code (no owner), a session that knows no owner yet
  expect(ownEntry(full, '|bob|')).toBe(false)
  expect(ownEntry({ ...full, owner: undefined }, OWNER)).toBe(false)
  expect(ownEntry(full, null)).toBe(false)
  expect(ownEntry(full, '')).toBe(false)
  // not an entry at all
  for (const state of [null, undefined, 'x', 7, [], { 'sveltekit:history': 1 }]) expect(ownEntry(state, OWNER), JSON.stringify(state)).toBe(false)
  // an index that is no distance
  for (const index of [-1, 1.5, '2', NaN, Infinity, 2 ** 53, undefined]) expect(ownEntry({ ...full, index }, OWNER), String(index)).toBe(false)
  expect(ownEntry({ ...full, index: Number.MAX_SAFE_INTEGER }, OWNER), 'a large index can be legitimate').toBe(true)
  // a field the restore would read in another shape
  const damaged: Record<string, unknown>[] = [
    { run: undefined },
    { run: '1' },
    { run: NaN },
    { editorText: undefined },
    { editorText: 7 },
    { unsavedTimes: 'x' },
    { unsavedTimes: [null] },
    { unsavedTimes: [{ id: 1, time: 1 }] },
    { unsavedTimes: [{ id: 'a', time: '1' }] },
    { hideIndex: '2' },
    { hideIndex: NaN },
    { scrollPosition: '612' },
    { scrollPosition: Infinity },
    { final: 1 },
    { intro: 'yes' },
    { scrolledToTop: 0 },
    { orderHash: 5 },
  ]
  for (const field of damaged) expect(ownEntry({ ...full, ...field }, OWNER), JSON.stringify(field)).toBe(false)
})

test('the session holds the entries it wrote or landed on, whatever the distance between their indexes, and a link is its distance', () => {
  // a tab whose counter is far past the entries the browser still holds: one entry from long ago, then
  // the three the session is among (a slot per index would be five billion objects)
  const FAR = 5_000_000_000
  const entries = new SessionEntries()
  entries.set(3, entry(3, '#long_ago '))
  entries.set(FAR, entry(FAR, 'free text'))
  entries.set(FAR + 1, entry(FAR + 1, '')) // the first view: no query, no link
  entries.set(FAR + 2, entry(FAR + 2, ' #named '))
  entries.set(FAR + 3, entry(FAR + 3, '#last'))
  expect(entries.size, 'stored: the entries, not the indexes').toBe(5)
  expect(entries.length).toBe(FAR + 4)
  expect(entries.get(FAR + 2)?.editorText).toBe(' #named ')
  expect(entries.get(4), 'nothing between').toBeUndefined()
  // the list as seen from the last entry: every held entry with a query but the last, in order, each
  // with the distance history.go takes (the difference of the indexes)
  expect(entries.links(FAR + 3)).toEqual([
    { index: 3, text: '#long_ago', delta: 3 - (FAR + 3) },
    { index: FAR, text: 'free text', delta: -3 },
    { index: FAR + 2, text: '#named', delta: -1 },
  ])
  // from an entry in the middle the same links lead back and ahead; the entry's own link is distance 0
  expect(entries.links(FAR).map(link => link.delta)).toEqual([3 - FAR, 0, 2])
  // from a position that is none of the entries' no distance can be said: no link is offered
  expect(entries.links(null)).toEqual([])
  // the tests' array view keeps the indexes and holds nothing else
  expect(Object.keys(entries.toArray()).map(Number)).toEqual([3, FAR, FAR + 1, FAR + 2, FAR + 3])
  // a new entry at an index replaces the branch ahead: the entries at and past it are dropped
  entries.truncate(FAR + 1)
  expect([entries.size, entries.length, entries.get(FAR + 1)], 'the entry at the index goes with the ones past it').toEqual([2, FAR + 1, undefined])
  entries.set(FAR + 1, entry(FAR + 1, '#pushed'))
  expect(entries.size).toBe(3)
  expect(entries.length).toBe(FAR + 2)
  expect(entries.links(FAR + 1)).toEqual([
    { index: 3, text: '#long_ago', delta: 3 - (FAR + 1) },
    { index: FAR, text: 'free text', delta: -1 },
  ])
  expect(new SessionEntries().length).toBe(0)
  expect(new SessionEntries().links(0)).toEqual([])
})

test("a proposed update is a new object: a write that is then suppressed leaves the entry reached and the session's copy as they were", () => {
  // the entry a traversal during startup reached, as the browser holds it (history.state is a live object)
  // and as the session holds it: left 2200 px down. A scroll at the startup viewport proposes 612; the
  // writer then returns without writing (the session unsettled, or a position that holds no entry)
  const saved = () => entry(7, '#named ', { scrollPosition: 2200, final: true, scrolledToTop: true })
  const reached = saved()
  const entries = new SessionEntries()
  entries.set(7, saved())
  const held = entries.get(7)!
  const proposed = [updatedEntry(reached, { scrollPosition: 612 }), updatedEntry(held, { scrollPosition: 612, scrolledToTop: false })]
  expect(proposed).toEqual([{ ...saved(), scrollPosition: 612 }, { ...saved(), scrollPosition: 612, scrolledToTop: false }])
  expect(reached, 'the entry reached').toEqual(saved())
  expect(entries.get(7), "the session's copy").toEqual(saved())
})

// WHERE A SESSION STARTS (startupPlace), over small histories as the browser holds them: a state per
// position and, for a position whose address names an item of the notebook, that name. `launched` is a model
// of what the startup then WRITES (index.svelte's initialize and onEditorChange), for a page created on one
// position and, when a traversal arrived while it was starting, standing on another: nothing when the place
// is deferred (the page's handler applies the position once the page is initialized); else the launch's first
// view over the state it starts on, or pushed after it when that is the notebook's own final entry (the
// positions ahead are dropped), and then the query its address names, pushed after that
type Slot = { state: unknown; names?: string }
const NEW_RUN = 99
const of = (run: number, index: number, editorText: string, more: Record<string, unknown> = {}) => ({ ...entry(index, editorText, more), run })
const MARKER = { owner: OWNER, unknown: true }
const launched = (stack: Slot[], created: number, reached: number | null = null) => {
  const at = reached ?? created
  const place = startupPlace(OWNER, launchIdentity(stack[created].state), stack[at].state, reached !== null)
  if (place.deferred) return { place, stack, at }
  const run = place.run ?? NEW_RUN
  let next = stack.slice()
  let now = at
  if (place.held?.final) {
    next = next.slice(0, at + 1).concat({ state: of(run, place.index + 1, '', { final: true }) })
    now = at + 1
  } else next[at] = { ...next[at], state: of(run, place.index, '', { final: true }) }
  const named = stack[created].names
  if (named) {
    next = next.slice(0, now + 1).concat({ state: of(run, (next[now].state as HistoryEntry).index + 1, named + ' ', { final: true }), names: named })
    now += 1
  }
  return { place, stack: next, at: now }
}

test('a session starts on the entry the page was created on, or defers to the position a traversal reached: never a write over that position', () => {
  // two runs of one notebook, each with a free-text query as its second entry: the same index, the same
  // (root) address. Run 22 was started from a cleared position after run 11
  const two: Slot[] = [
    { state: of(11, 0, '', { final: true }) },
    { state: of(11, 1, 'the older query') },
    { state: of(11, 2, '#ahead ', { final: true }), names: '#ahead' },
    { state: MARKER },
    { state: of(22, 0, '', { final: true }) },
    { state: of(22, 1, 'the later query') },
  ]
  // a reload on run 22's query, and Back while the page starts, to run 11's: a move, whatever the index
  let result = launched(two, 5, 1)
  expect(result.place).toEqual({ deferred: true, index: 0, run: null, held: null })
  expect(result.stack, 'the older query and the entries ahead of it are as they were').toEqual(two)
  // the same when the older entry is final (a launch on it would push and drop the entries ahead)
  const finals = two.map((slot, i) => (i == 1 ? { state: of(11, 1, 'the older query', { final: true }) } : slot))
  expect(launched(finals, 5, 1).stack).toEqual(finals)
  // another entry of the same run is a move too; the entry the page was created on is none (a restored tab can
  // send a popstate for it): the page launches on it, continuing it, its first view over the entry that is not final
  expect(launched(two, 5, 4).place.deferred).toBe(true)
  result = launched(two, 5, 5)
  expect(result.place).toEqual({ deferred: false, index: 1, run: 22, held: two[5].state })
  expect(result.stack.map(slot => (slot.state as HistoryEntry).editorText)).toEqual(['', 'the older query', '#ahead ', undefined, '', ''])
  expect(launched(two, 5).stack, 'as a reload without a traversal').toEqual(result.stack)

  // a cleared position whose address names an item X, then the notebook's entry Q, whose address names Q
  const marked: Slot[] = [{ state: MARKER, names: '#X' }, { state: of(22, 0, '#Q ', { final: true }), names: '#Q' }]
  // a reload on Q and Back while the page starts: the position stays unnumbered, and Q is still ahead
  result = launched(marked, 1, 0)
  expect(result.place.deferred).toBe(true)
  expect(result.stack, 'the marker is not renumbered, X is not pushed, Q is not dropped').toEqual(marked)
  // the same on first reaching another notebook's entry there, an entry of older code, or a native fragment's position
  for (const state of [{ ...of(22, 0, 'theirs'), owner: '|bob|' }, { index: 0, editorText: 'older code' }, null]) {
    const foreign: Slot[] = [{ state, names: '#X' }, marked[1]]
    result = launched(foreign, 1, 0)
    expect(result.place.deferred, JSON.stringify(state)).toBe(true)
    expect(result.stack).toEqual(foreign)
  }
  // a reload of a tab that stands on the marker is a launch: a new run from 0 there, and its address's query
  result = launched(marked, 0)
  expect(result.place).toEqual({ deferred: false, index: 0, run: null, held: null })
  expect(result.stack.map(slot => slot.state)).toEqual([of(NEW_RUN, 0, '', { final: true }), of(NEW_RUN, 1, '#X ', { final: true })])
  // a traversal that ends on a position without a numbered entry is always a move: nothing tells two apart
  expect(launched([{ state: MARKER }, { state: MARKER }], 1, 0).place.deferred).toBe(true)
  expect(launched([{ state: MARKER }], 0, 0).place.deferred).toBe(true)
})

test('a fragment is read as text, and a malformed one names nothing', () => {
  expect(decodedFragment('#e2e_target/sub')).toBe('#e2e_target/sub')
  expect(decodedFragment('#a%20label%2Fsub')).toBe('#a label/sub')
  expect(decodedFragment('')).toBe('')
  // a `%` that is no escape: decodeURIComponent throws on each of these
  for (const hash of ['#100%', '#%', '#%zz', '#a%2', '#%E0%A4%A']) {
    expect(() => decodeURIComponent(hash), hash).toThrow(URIError)
    expect(decodedFragment(hash), hash).toBe('')
  }
})
