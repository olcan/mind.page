import { expect, test } from '@playwright/test'

import {
  INPUT_EVENTS,
  SessionEntries,
  decodedFragment,
  inputActive,
  launchAnchor,
  launchQuery,
  launchIdentity,
  ownEntry,
  startupPlace,
  stopReturn,
  updatedEntry,
  writeMode,
  type HistoryEntry,
  type WriteAsk,
  type WriteMode,
} from '../../src/history_entries.js'

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
// position and, for a position whose address names an item of the notebook, that name. `launched` applies
// the decisions the route asks at a launch (index.svelte's initialize and its fragment step) to such a history,
// for a page created on one position and, when a traversal arrived while it was starting, standing on another:
// nothing when the place is deferred (the page's handler applies the position once the page is initialized);
// else the launch's first view, written over the state it starts on unless that entry is kept for the
// address's query (launchQuery), and then that query, written over the same position. Each write's mode is
// writeMode's: never a push, and an entry of the notebook's keeps its `final`
type Slot = { state: unknown; names?: string }
const NEW_RUN = 99
const of = (run: number, index: number, editorText: string, more: Record<string, unknown> = {}) => ({ ...entry(index, editorText, more), run })
const MARKER = { owner: OWNER, unknown: true }
const launched = (stack: Slot[], created: number, reached: number | null = null) => {
  const at = reached ?? created
  const place = startupPlace(OWNER, launchIdentity(stack[created].state), stack[at].state, reached !== null)
  if (place.deferred) return { place, stack, at }
  const run = place.run ?? NEW_RUN
  const named = stack[created].names ?? null
  const held = place.held
  const next = stack.slice()
  const write = (query: string, force: boolean) => {
    const mode = writeMode({ user: false, launch: true, force, replace: false, same: query == held?.editorText, final: !!held?.final, first: false, unknown: false, fragment: false })
    expect(mode, `the launch's write of '${query}'`).toBe('update')
    next[at] = { ...next[at], state: of(run, place.index, query, { final: held ? !!held.final : true }) }
  }
  if (!launchQuery(place, named).kept) write('', false)
  if (named) write(named + ' ', true)
  return { place, stack: next, at }
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
  // the same when the older entry is final
  const finals = two.map((slot, i) => (i == 1 ? { state: of(11, 1, 'the older query', { final: true }) } : slot))
  expect(launched(finals, 5, 1).stack).toEqual(finals)
  // another entry of the same run is a move too; the entry the page was created on is none (a restored tab can
  // send a popstate for it): the page launches on it, continuing it, its first view over the entry that is not final
  expect(launched(two, 5, 4).place.deferred).toBe(true)
  result = launched(two, 5, 5)
  expect(result.place).toEqual({ deferred: false, index: 1, run: 22, held: two[5].state })
  expect(result.stack.map(slot => (slot.state as HistoryEntry).editorText)).toEqual(['', 'the older query', '#ahead ', undefined, '', ''])
  expect(launched(two, 5).stack, 'as a reload without a traversal').toEqual(result.stack)
  // a reload on a final entry whose address names an item: the entry is kept while the first view shows, the
  // address's query is written over it, and nothing is added or dropped (until 2026-11-19: two pushes)
  expect(launched(two, 2).stack, 'a reload on the entry of #ahead').toEqual(two)
  // the address's query: pending whenever the address is not empty (cancellable, whether or not it names an
  // item yet), and the entry kept only where the page starts on an entry of the notebook's
  const start = (state: unknown, traversed = false) => startupPlace(OWNER, launchIdentity(two[5].state), state, traversed)
  expect(launchQuery(start(two[5].state), '#late')).toEqual({ pending: true, kept: true })
  expect(launchQuery(start(two[5].state), '')).toEqual({ pending: false, kept: false })
  expect(launchQuery(start(two[5].state), null)).toEqual({ pending: false, kept: false })
  expect(launchQuery(start(MARKER), '#late'), 'on a state that is no entry of the notebook').toEqual({ pending: true, kept: false })
  expect(launchQuery(start(two[1].state, true), '#late'), 'deferred to the position a traversal reached').toEqual({ pending: false, kept: false })

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
  // a reload of a tab that stands on the marker is a launch: a new run from 0 there, its address's query
  // written over the same position, and Q still ahead (until 2026-11-19 the query was pushed, and Q dropped)
  result = launched(marked, 0)
  expect(result.place).toEqual({ deferred: false, index: 0, run: null, held: null })
  expect(result.stack.map(slot => slot.state)).toEqual([of(NEW_RUN, 0, '#X ', { final: true }), marked[1].state])
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

test('a stop goes back to the position of the entry the session is on, by its key, and says which way the browser had moved; no return where none can be said', () => {
  // the browser's list as the Navigation API gives it: another account's two entries, the notebook's two, one of older code
  const places = ['a1', 'a2', 'n1', 'n2', 'old'].map((key, index) => ({ key, index }))
  // Back from the notebook's first entry onto the other account's: forward again to the entry the page shows
  expect(stopReturn(places, 'a2', 'n1')).toEqual({ key: 'n1', forward: false })
  // Forward from its last entry onto the one of older code: back again
  expect(stopReturn(places, 'old', 'n2')).toEqual({ key: 'n2', forward: true })
  // a jump (a long press on Back, a second Back before the first return has landed): the return is to the
  // KEY, whatever the distance
  expect(stopReturn(places, 'a1', 'n2')).toEqual({ key: 'n2', forward: false })
  // the index is the position's place in the list NOW: the browser has dropped its first two positions
  const shifted = places.slice(2).map(({ key }, index) => ({ key, index }))
  expect(stopReturn(shifted, 'old', 'n1')).toEqual({ key: 'n1', forward: true })
  // no return, and the page stays on the position as before the stop:
  expect(stopReturn(null, 'a2', 'n1'), 'a browser without the Navigation API').toBeNull()
  expect(stopReturn(places, null, 'n1'), 'no key for the position landed on').toBeNull()
  expect(stopReturn(places, 'a2', null), 'the session holds no entry at a position it knows').toBeNull()
  expect(stopReturn(shifted, 'old', 'a2'), "the held position is no longer in the browser's list").toBeNull()
  expect(stopReturn(shifted, 'a1', 'n1'), 'the position landed on is not in the list').toBeNull()
  expect(stopReturn(places, 'n1', 'n1'), 'the held position itself, its entry replaced by another writer').toBeNull()
})

test("the entry a page was created on is a stop's return address only when its whole state was an entry of this notebook's", () => {
  const anchor = (state: unknown, owner: string | null = OWNER) => launchAnchor(launchIdentity(state), owner)
  expect(anchor(entry(3, 'a query', { scrollPosition: 640, final: true }))).toBe(true)
  expect(anchor(of(11, 1, "an older run's entry")), 'an entry of an older run is the notebook\'s too').toBe(true)
  // states that NAME the notebook and are no entry the restore can consume: the owner alone admitted each
  // (a reload on one, an early Back onto another rejected position, and the app asked for a trip back to it)
  const named: [unknown, string][] = [
    [MARKER, 'a cleared position'],
    [{ ...MARKER, fragment: true }, "a fragment's own position"],
    [{ ...entry(3, 'q'), index: -1 }, 'a numbered state whose index is no distance'],
    [{ owner: OWNER, index: 3, editorText: 'q' }, 'one without a run'],
    [{ ...entry(3, 'q'), editorText: 7 }, 'one whose query is no text'],
    [{ ...entry(3, 'q'), scrollPosition: 'top' }, 'one whose position is no number'],
  ]
  for (const [state, why] of named) {
    expect(launchIdentity(state).owner, why).toBe(OWNER)
    expect(anchor(state), why).toBe(false)
  }
  // an entry of another notebook's, well formed under its own owner; one of older code; no state; no notebook yet
  expect(launchIdentity({ ...entry(3, 'q'), owner: '|bob|' }).own).toBe(true)
  expect(anchor({ ...entry(3, 'q'), owner: '|bob|' })).toBe(false)
  expect(anchor({ index: 3, editorText: 'q' })).toBe(false)
  expect(anchor(null)).toBe(false)
  expect(anchor(entry(3, 'q'), null)).toBe(false)
  expect(launchAnchor(null, OWNER)).toBe(false)
  // the identity that startupPlace compares is the three fields, as before: a launch on a marker is a launch there
  expect(startupPlace(OWNER, launchIdentity(MARKER), MARKER, false)).toEqual({ deferred: false, index: 0, run: null, held: null })
  expect(startupPlace(OWNER, launchIdentity(entry(3, 'q')), entry(3, 'q'), true).deferred, 'the same entry again is no move').toBe(false)
})

// THE WRITE DECISION (2026-11-19, the owner: "changes that are not triggered by a user action should not add new
// steps"): by the write's origin, the entry the browser is on and what the write asks for. `ask()` is a passive
// re-ranking of the same query on a final entry that is not the launch's
test("a history write is a step only as the user's: by its origin, never by what it asks for", () => {
  const ask = (more: Partial<WriteAsk> = {}): WriteAsk => ({ user: false, launch: false, force: false, replace: false, same: true, final: true, first: false, unknown: false, fragment: false, ...more })
  const rows: [string, Partial<WriteAsk>, WriteMode][] = [
    // not the user's: never a push, whatever is asked; the entry keeps what is its own
    ['a passive re-ranking on a final entry', {}, 'update'],
    ['a passive re-ranking on an entry that is not final', { final: false }, 'update'],
    ["a passive re-ranking on the launch's first view", { first: true }, 'update'],
    ['a passive new query (MindBox.set from a timer)', { same: false }, 'update'],
    ["a passive forced entry (a select from a timer, an autorun's /run query)", { force: true, same: false }, 'update'],
    ['a passive replacement (the selected item deleted by item code)', { replace: true, same: false }, 'update'],
    ["the launch's first view over a final entry of another query", { launch: true, same: false }, 'update'],
    ["the launch's forced query, the address's, over its entry", { launch: true, force: true, same: false }, 'update'],
    ["the launch's write while the user's input is being handled is the launch's still", { launch: true, user: true, force: true, same: false }, 'update'],
    // on a position that holds no entry: nothing but the user's navigation
    ['a passive re-ranking under a dropped edit on a position that holds no entry', { unknown: true, same: false }, 'none'],
    ['a passive forced entry there', { unknown: true, force: true, same: false }, 'none'],
    ['a passive re-ranking of the same query there', { unknown: true }, 'none'],
    ["the user's new query there", { unknown: true, user: true, same: false }, 'push'],
    ["the user's forced entry there", { unknown: true, user: true, force: true }, 'push'],
    ["the user's re-ranking of the same query there", { unknown: true, user: true }, 'none'],
    ["the user's replacement there", { unknown: true, user: true, replace: true, same: false }, 'none'],
    // a native fragment's own position is taken, whoever asks
    ["a native fragment's query", { fragment: true, unknown: true, force: true, same: false }, 'push'],
    ['a native fragment that names the view shown', { fragment: true, unknown: true, force: true }, 'push'],
    // the user's: as before the rule
    ["the user's new query on a final entry", { user: true, same: false }, 'push'],
    ["the user's new query on an entry that is not final (typing)", { user: true, same: false, final: false }, 'replace'],
    ["the user's forced entry on an entry that is not final (a tag's click)", { user: true, force: true, same: false, final: false }, 'push'],
    ["the user's re-ranking on a final entry", { user: true }, 'push'],
    ["the user's re-ranking on an entry that is not final", { user: true, final: false }, 'replace'],
    ["the user's re-ranking on the launch's first view", { user: true, first: true }, 'update'],
    ["the user's forced entry on the launch's first view", { user: true, first: true, force: true }, 'push'],
    ["the user's replacement on a final entry (their deletion of the selected item)", { user: true, replace: true, same: false }, 'replace'],
    ["the user's forced entry wins over a replacement", { user: true, force: true, replace: true, same: false }, 'push'],
  ]
  for (const [name, more, mode] of rows) expect(writeMode(ask(more)), name).toBe(mode)
})

test("the user's input is a trusted input event in dispatch: not one kept afterwards, not one a script dispatches, not a traversal or a scroll", () => {
  expect(inputActive({ isTrusted: true, type: 'click', eventPhase: 2 })).toBe(true)
  expect(inputActive({ isTrusted: true, type: 'keydown', eventPhase: 1 })).toBe(true)
  expect(inputActive({ isTrusted: true, type: 'input', eventPhase: 3 })).toBe(true)
  expect(inputActive({ isTrusted: true, type: 'click', eventPhase: 0 }), 'kept after its dispatch').toBe(false)
  expect(inputActive({ isTrusted: false, type: 'click', eventPhase: 2 }), 'dispatched by a script').toBe(false)
  expect(inputActive({ isTrusted: true, type: 'popstate', eventPhase: 2 }), 'a traversal').toBe(false)
  expect(inputActive({ isTrusted: true, type: 'scroll', eventPhase: 2 }), "a scroll (a script's scroll makes one too)").toBe(false)
  expect(inputActive(undefined)).toBe(false)
  expect(INPUT_EVENTS, 'a native drag ends with dragend').toContain('dragend')
})
