import { expect, test } from '@playwright/test'
import {
  buildHiddenIndex,
  isQuarantined,
  quarantineNonCanonical,
  compareIds,
  classifyInvalidHidden,
  registerHidden,
  applyRemoteAdded,
  applyRemoteModified,
  applyRemoteRemoved,
  removeHidden,
  finalizeAdoption,
  invalidateAdopters,
  type HiddenIndex,
  type HiddenWrapper,
} from '../../src/hidden.js'

// table tests for the hidden-item index transitions (see src/hidden.ts): the minimum-id rule for
// duplicate names, invalid classification at initialization, pending-create adoption, and the
// remote add/modify/remove transitions

const index = (): HiddenIndex => ({ byId: new Map(), byName: new Map(), quarantined: new Set<string>() })
const doc = (id: string, name: string, item: any = {}) => ({ id, text: JSON.stringify({ name, item }) })
const wrapper = (id: string, name: string, item: any = {}): HiddenWrapper => ({ id, name, item })
const opts = { anonymous: false, checkOrphans: true, existingIds: new Set(['x']) }

test('initialization indexes by minimum id and classifies duplicates, anonymous and orphans', () => {
  const idx = index()
  const invalid = buildHiddenIndex(
    idx,
    [
      doc('b2', 'global_store_x', { late: 1 }), // duplicate (larger id, same name as a1)
      doc('a1', 'global_store_x', { early: 1 }), // wins the name despite input order
      doc('c3', 'global_store_gone'), // orphaned: item "gone" does not exist
      doc('d4', 'other_state'),
    ],
    opts
  )
  expect(idx.byName.get('global_store_x')!.id).toBe('a1')
  expect(idx.byId.has('d4')).toBe(true)
  // the duplicate is retained in byId so a later authoritative cleanup can still promote it if
  // the canonical document is removed first
  expect(idx.byId.has('b2')).toBe(true)
  expect(invalid.map(entry => [entry.wrapper.id, entry.reason])).toEqual([
    ['b2', 'duplicate'],
    ['c3', 'orphaned'],
  ])
  expect(removeHidden(idx, 'a1').removed!.id).toBe('a1')
  expect(idx.byName.get('global_store_x')!.id).toBe('b2') // retained duplicate promoted
})

test('malformed hidden items are quarantined, never indexed and never throw', () => {
  const idx = index()
  const invalid = buildHiddenIndex(
    idx,
    [
      { id: 'x1', text: 'not json' },
      { id: 'x2', text: JSON.stringify({ item: {} }) }, // missing name
      doc('a1', 'fine'),
    ],
    opts
  )
  expect(invalid.map(entry => [entry.wrapper.id, entry.reason])).toEqual([
    ['x1', 'malformed'],
    ['x2', 'malformed'],
  ])
  expect(idx.byId.size).toBe(1)
  expect(idx.byName.get('fine')!.id).toBe('a1')
})

test('initialization on the anonymous account classifies every hidden item invalid', () => {
  const idx = index()
  const invalid = buildHiddenIndex(idx, [doc('a1', 'anything')], { ...opts, anonymous: true })
  expect(invalid.map(entry => entry.reason)).toEqual(['anonymous'])
  expect(idx.byId.size).toBe(0)
})

test('orphan classification is skipped when the account is not fully loaded (fixed pages)', () => {
  const idx = index()
  const invalid = buildHiddenIndex(idx, [doc('c3', 'global_store_gone')], { ...opts, checkOrphans: false })
  expect(invalid).toEqual([])
  expect(idx.byName.has('global_store_gone')).toBe(true)
})

test('registration adopts a pending create exactly once, merging under the pending changes', () => {
  const idx = index()
  const pending: HiddenWrapper = {
    id: 'temp1',
    name: 'global_store_x',
    item: { mine: 1 },
    pending_create: true,
    adopt_id: null,
  }
  idx.byId.set(pending.id, pending)
  idx.byName.set(pending.name, pending)
  const merge = (p: HiddenWrapper, found: HiddenWrapper) => Object.assign(p.item, { ...found.item, ...p.item })
  expect(registerHidden(idx, wrapper('srv1', 'global_store_x', { theirs: 2, mine: 0 }), merge)).toBe('adopted')
  expect(pending.adopt_id).toBe('srv1')
  expect(pending.item).toEqual({ mine: 1, theirs: 2 }) // pending changes take precedence
  // a second document under the same name is retained but neither adopts nor displaces
  expect(registerHidden(idx, wrapper('srv2', 'global_store_x'), merge)).toBe('exists')
  expect(pending.adopt_id).toBe('srv1')
  expect(idx.byName.get('global_store_x')).toBe(pending)
  expect(idx.byId.has('srv2')).toBe(true)
})

test('registration without a claim indexes by the minimum-id rule', () => {
  const idx = index()
  const merge = (): undefined => undefined
  expect(registerHidden(idx, wrapper('m5', 'name'), merge)).toBe('added')
  expect(registerHidden(idx, wrapper('a1', 'name'), merge)).toBe('exists')
  expect(idx.byName.get('name')!.id).toBe('a1') // smaller id takes the name
  expect(registerHidden(idx, wrapper('z9', 'name'), merge)).toBe('exists')
  expect(idx.byName.get('name')!.id).toBe('a1')
})

test('remote add keeps the minimum id and warns on a name conflict', () => {
  const idx = index()
  expect(applyRemoteAdded(idx, wrapper('m5', 'name')).warning).toBeUndefined()
  const { warning } = applyRemoteAdded(idx, wrapper('a1', 'name'))
  expect(warning).toMatch(/exists locally/)
  expect(idx.byName.get('name')!.id).toBe('a1')
})

test('remote modify replaces by id, warns on renames and keeps the old name working', () => {
  const idx = index()
  applyRemoteAdded(idx, wrapper('a1', 'old_name', { v: 1 }))
  expect(applyRemoteModified(idx, wrapper('a1', 'old_name', { v: 2 })).warning).toBeUndefined()
  expect(idx.byName.get('old_name')!.item).toEqual({ v: 2 })
  const { warning } = applyRemoteModified(idx, wrapper('a1', 'new_name', { v: 3 }))
  expect(warning).toMatch(/new name new_name/)
  expect(idx.byName.get('new_name')!.item).toEqual({ v: 3 })
  expect(idx.byName.has('old_name')).toBe(true) // stale entry retained until reload, as before
  expect(applyRemoteModified(idx, wrapper('zz', 'other')).warning).toMatch(/missing locally/)
})

test('removal reassigns the name to the minimum-id duplicate', () => {
  const idx = index()
  applyRemoteAdded(idx, wrapper('a1', 'name'))
  applyRemoteAdded(idx, wrapper('b2', 'name'))
  applyRemoteAdded(idx, wrapper('c3', 'name'))
  expect(idx.byName.get('name')!.id).toBe('a1')
  expect(removeHidden(idx, 'a1').removed!.id).toBe('a1')
  expect(idx.byName.get('name')!.id).toBe('b2')
  expect(applyRemoteRemoved(idx, 'b2').removed!.id).toBe('b2')
  expect(idx.byName.get('name')!.id).toBe('c3')
  expect(applyRemoteRemoved(idx, 'gone').removed).toBeUndefined() // local deletes echo back
})

test('adoption settlement re-keys to the persistent id and restores the minimum-id invariant', () => {
  const idx = index()
  const pending: HiddenWrapper = { id: 'temp1', name: 'name', item: { v: 1 }, pending_create: true, adopt_id: null }
  idx.byId.set(pending.id, pending)
  idx.byName.set(pending.name, pending)
  const merge = (): undefined => undefined
  // callers register server documents in ASCENDING id order (see saveHiddenItem/secret.ts), so
  // the pending create adopts the minimum-id duplicate; later duplicates are retained
  expect(registerHidden(idx, wrapper('a1', 'name'), merge)).toBe('adopted')
  expect(pending.adopt_id).toBe('a1')
  expect(registerHidden(idx, wrapper('z9', 'name'), merge)).toBe('exists')
  finalizeAdoption(idx, pending)
  expect(pending.id).toBe('a1')
  expect(pending.pending_create).toBeNull()
  expect(idx.byId.get('a1')).toBe(pending)
  expect(idx.byId.has('temp1')).toBe(false)
  expect(idx.byName.get('name')).toBe(pending) // a1 is the minimum id, the invariant holds
})

test('a failed fresh create with a retained remote duplicate promotes it instead of losing the name', () => {
  const idx = index()
  const pending: HiddenWrapper = { id: 'temp1', name: 'name', item: {}, pending_create: true, adopt_id: null }
  idx.byId.set(pending.id, pending)
  idx.byName.set(pending.name, pending)
  // a remote same-name document arrives while the create is pending: retained, not displacing
  applyRemoteAdded(idx, wrapper('r5', 'name'))
  expect(idx.byName.get('name')).toBe(pending)
  // the create fails: removal must promote the retained remote wrapper, so the next save
  // UPDATES it instead of creating another duplicate
  expect(removeHidden(idx, 'temp1').removed).toBe(pending)
  expect(idx.byName.get('name')!.id).toBe('r5')
})

test('current-state invalidity: non-canonical duplicates and ownerless canonical stores, transitional wrappers skipped', () => {
  const index = { byId: new Map(), byName: new Map(), quarantined: new Set<string>() }
  const canonical = { id: 'a1', name: 'global_store_x', item: {} }
  const duplicate = { id: 'b2', name: 'global_store_x', item: {} } // retained, not the holder
  const orphan = { id: 'c3', name: 'global_store_gone', item: {} } // canonical but owner missing
  const pending = { id: 'd4', name: 'n', item: {}, pending_create: true } // settlement in flight
  const other = { id: 'e5', name: 'not_a_store', item: {} } // canonical non-store: valid
  for (const w of [canonical, duplicate, orphan, pending, other]) index.byId.set(w.id, w)
  index.byName.set('global_store_x', canonical)
  index.byName.set('global_store_gone', orphan)
  index.byName.set('n', pending)
  index.byName.set('not_a_store', other)
  const invalid = classifyInvalidHidden(index, id => id == 'x')
  expect(invalid).toEqual([
    { wrapper: duplicate, reason: 'duplicate' },
    { wrapper: orphan, reason: 'orphaned' },
  ])
  // a remote rename to a unique name revalidates the record: the old startup classification
  // must not survive recomputation (round-8 finding: stale candidates deleted renamed documents)
  index.byId.set('b2', { id: 'b2', name: 'renamed_unique', item: {} })
  index.byName.set('renamed_unique', index.byId.get('b2')!)
  expect(classifyInvalidHidden(index, id => id == 'x')).toEqual([{ wrapper: orphan, reason: 'orphaned' }])
  // an owner arriving revalidates the store the same way
  expect(classifyInvalidHidden(index, () => true)).toEqual([])
})

test('canonical selection is code-unit ordered, so mixed-case ids agree everywhere', () => {
  // round-10 finding 9: registration in secret.ts ordered by localeCompare while the index
  // selects the minimum id with compareIds. mixed-case firestore ids order DIFFERENTLY under a
  // locale collator ('B' < 'a' by code unit, 'a' < 'B' by locale), so the two disagreed and one
  // record could be adopted while another was retained as the canonical holder
  expect(compareIds('B1', 'a1') < 0).toBe(true) // code-unit: uppercase first
  expect('B1'.localeCompare('a1') < 0).toBe(false) // locale: the opposite
  const index = { byId: new Map(), byName: new Map(), quarantined: new Set<string>() }
  const upper = { id: 'B1', name: 'n', item: {} }
  const lower = { id: 'a1', name: 'n', item: {} }
  // arriving in either order, the SAME record wins the name
  applyRemoteAdded(index, lower)
  applyRemoteAdded(index, upper)
  expect(index.byName.get('n')).toBe(upper)
  const reversed = { byId: new Map(), byName: new Map(), quarantined: new Set<string>() }
  applyRemoteAdded(reversed, upper)
  applyRemoteAdded(reversed, lower)
  expect(reversed.byName.get('n')).toBe(upper)
})

test('quarantining a duplicate stops it being promoted when the canonical record is removed', () => {
  // the non-destructive replacement for deleting duplicates: a retained duplicate is the only
  // way a name resurrects old state, so it is dropped from the PROMOTABLE index instead of the
  // server (see quarantineNonCanonical)
  const index = { byId: new Map(), byName: new Map(), quarantined: new Set<string>() }
  const canonical = { id: 'a1', name: 'n', item: { current: true } }
  const duplicate = { id: 'b2', name: 'n', item: { ancient: true } }
  index.byId.set('a1', canonical)
  index.byId.set('b2', duplicate)
  index.byName.set('n', canonical)
  quarantineNonCanonical(index, [{ wrapper: duplicate, reason: 'duplicate' }])
  expect(index.byId.has('b2')).toBe(false) // no longer promotable ...
  expect(index.byName.get('n')).toBe(canonical) // ... and the canonical record is untouched
  // removing the canonical record now leaves the name empty rather than resurrecting old state
  removeHidden(index, 'a1')
  expect(index.byName.get('n')).toBeUndefined()
  // a CANONICAL record is never quarantined, whatever it is classified as
  const solo = { id: 'c3', name: 'm', item: {} }
  index.byId.set('c3', solo)
  index.byName.set('m', solo)
  quarantineNonCanonical(index, [{ wrapper: solo, reason: 'orphaned' }])
  expect(index.byId.get('c3')).toBe(solo)
})

test('quarantine survives an index adapter that is rebuilt on every call (as production is)', () => {
  // the production adapter is `() => ({ byId, byName, quarantined })` — a NEW object each call.
  // quarantine state attached lazily to that object was discarded immediately, so the whole
  // mechanism silently did nothing; the earlier test passed only because it reused one object
  const byId = new Map<string, any>()
  const byName = new Map<string, any>()
  const quarantined = new Set<string>()
  const index = () => ({ byId, byName, quarantined }) // rebuilt per call, exactly like production
  const canonical = { id: 'a1', name: 'n', item: { current: true } }
  const duplicate = { id: 'b2', name: 'n', item: { ancient: true } }
  byId.set('a1', canonical)
  byId.set('b2', duplicate)
  byName.set('n', canonical)
  quarantineNonCanonical(index(), [{ wrapper: duplicate, reason: 'duplicate' }])
  expect(isQuarantined(index(), 'b2')).toBe(true) // ... through a DIFFERENT adapter object

  // a redelivery of the quarantined record must not reinstate it, directly or by promotion
  applyRemoteModified(index(), { id: 'b2', name: 'n', item: { ancient: true } })
  applyRemoteAdded(index(), { id: 'b2', name: 'n', item: { ancient: true } })
  expect(index().byId.has('b2')).toBe(false)
  removeHidden(index(), 'a1') // the canonical record goes away
  expect(index().byName.get('n')).toBeUndefined() // no promotion of the quarantined duplicate

  // a pending create for the name must not adopt it either
  const pending = { id: 'temp1', name: 'n', item: {}, pending_create: true }
  byId.set('temp1', pending)
  byName.set('n', pending)
  expect(registerHidden(index(), { id: 'b2', name: 'n', item: { ancient: true } }, () => {})).toBe('quarantined')
  expect(pending.item).toEqual({})

  // but a genuine server REMOVAL of that document releases it: an id created again later is a
  // new record, and the session's judgement about the old one no longer applies
  removeHidden(index(), 'b2')
  expect(isQuarantined(index(), 'b2')).toBe(false)
})

// round-34 stage 1: an adoption's merge is only sound against the document state it saw, so every
// transition that replaces that document must invalidate it (see invalidateAdopters)

const adopting = (idx: HiddenIndex, target: HiddenWrapper, local: any) => {
  // a pending create that claimed the name, then found `target` and merged its state underneath
  const pending: HiddenWrapper = { id: 'temp1', name: target.name, item: local, pending_create: true, adopt_id: null }
  idx.byId.set('temp1', pending)
  idx.byName.set(target.name, pending)
  // the real merge is _.defaultsDeep(pending.item, found.item), which MUTATES pending.item
  const merge = (p: HiddenWrapper, f: HiddenWrapper): undefined => {
    for (const k of Object.keys(f.item)) if (!(k in p.item)) p.item[k] = f.item[k]
  }
  expect(registerHidden(idx, target, merge)).toBe('adopted')
  expect(pending.adopt_id).toBe(target.id)
  return pending
}

test('a same-id replacement of the adoption target invalidates the adoption', async () => {
  // THE SCHEDULE FROM REVIEW ROUND 34: v1 is adopted and merged; v2 replaces it same-id/same-name
  // and fully applies before the write retries. defaultsDeep will not overwrite the keys v1 already
  // filled in, so a retry that kept its pointer would settle v1's values over v2's, silently
  for (const [label, apply] of [
    ['modify', (idx: HiddenIndex) => applyRemoteModified(idx, wrapper('a1', 'name', { x: 'v2' }))],
    ['add', (idx: HiddenIndex) => applyRemoteAdded(idx, wrapper('a1', 'name', { x: 'v2' }))],
    ['remove', (idx: HiddenIndex) => removeHidden(idx, 'a1')],
  ] as const) {
    const idx = index()
    const pending = adopting(idx, wrapper('a1', 'name', { x: 'v1' }), { mine: 1 })
    expect(pending.item, `${label}: merged v1`).toEqual({ mine: 1, x: 'v1' })
    apply(idx)
    expect(pending.adopt_id, `${label} invalidates the adoption`).toBe(null)
  }
})

test('a same-name re-registration invalidates the old adoption and FRESHLY re-adopts', async () => {
  // round 35: invalidation runs at ENTRY, before any branch, so the pending wrapper's cleared
  // adopt_id makes it eligible to adopt again — the stale merge is discarded in favor of a fresh
  // one against the arriving state. (the fresh merge REBASES from unmerged local intent in stage
  // 1b; the reducer's half is invalidate-then-readopt with the merge callback invoked again)
  const idx = index()
  let merges = 0
  const pending: HiddenWrapper = { id: 'temp1', name: 'name', item: { mine: 1 }, pending_create: true, adopt_id: null }
  idx.byId.set('temp1', pending)
  idx.byName.set('name', pending)
  const merge = () => void merges++
  expect(registerHidden(idx, wrapper('a1', 'name', { x: 'v1' }), merge)).toBe('adopted')
  expect([pending.adopt_id, merges]).toEqual(['a1', 1])
  expect(registerHidden(idx, wrapper('a1', 'name', { x: 'v2' }), merge)).toBe('adopted')
  expect(pending.adopt_id, 'freshly re-adopted').toBe('a1')
  expect(merges, 'the merge ran AGAIN, against the arriving state').toBe(2)
})

test('re-registration under a NEW name still invalidates an adoption held under the old name', async () => {
  // the round-35 hole: re-registration of d1 under name B finds no byName[B], takes the 'added'
  // branch, and a branch-local invalidation would never run — leaving the old adopter free to
  // write name A's stale merge back to d1
  const idx = index()
  const pending: HiddenWrapper = { id: 'temp1', name: 'A', item: { mine: 1 }, pending_create: true, adopt_id: null }
  idx.byId.set('temp1', pending)
  idx.byName.set('A', pending)
  expect(
    registerHidden(idx, wrapper('d1', 'A', { x: 1 }), (p, f) => Object.assign(p.item, { ...f.item, ...p.item }))
  ).toBe('adopted')
  expect(pending.adopt_id).toBe('d1')
  // d1 arrives again under name B: the 'added' branch (no byName[B]) must still invalidate
  expect(registerHidden(idx, wrapper('d1', 'B', { x: 2 }), () => {})).toBe('added')
  expect(pending.adopt_id, 'the old-name adopter cannot keep writing d1').toBe(null)

  // ... and the 'adopted' branch analogue: d1 re-registers under name C that ANOTHER pending owns
  const other: HiddenWrapper = { id: 'temp2', name: 'C', item: {}, pending_create: true, adopt_id: null }
  idx.byId.set('temp2', other)
  idx.byName.set('C', other)
  pending.adopt_id = 'd1' // re-arm the stale pointer
  expect(registerHidden(idx, wrapper('d1', 'C', { y: 1 }), () => {})).toBe('adopted')
  expect(other.adopt_id, 'the C-name pending adopts the arrival').toBe('d1')
  expect(pending.adopt_id, 'the stale A-name adopter is invalidated by the same entry').toBe(null)
})

test('a rename of the adoption target invalidates it too', async () => {
  // a rename arrives as a modify carrying a different name: the adopter chose this document for a
  // name it no longer holds
  const idx = index()
  const pending = adopting(idx, wrapper('a1', 'name', { x: 'v1' }), { mine: 1 })
  applyRemoteModified(idx, wrapper('a1', 'renamed', { x: 'v1' }))
  expect(pending.adopt_id).toBe(null)
})

test('an unrelated document does not invalidate an adoption', async () => {
  const idx = index()
  const pending = adopting(idx, wrapper('a1', 'name', { x: 'v1' }), { mine: 1 })
  applyRemoteModified(idx, wrapper('b2', 'other', { y: 1 }))
  removeHidden(idx, 'b2')
  expect(pending.adopt_id, 'still adopting its own target').toBe('a1')
})

test('invalidateAdopters finds adopters that are absent from byId as targets', async () => {
  // an adoption target is NOT byId.get(id) -- it is absent until finalization -- so the scan is
  // over adopt_id pointers, not over the id being transitioned
  const idx = index()
  const one: HiddenWrapper = { id: 't1', name: 'n1', item: {}, pending_create: true, adopt_id: 'srv' }
  const two: HiddenWrapper = { id: 't2', name: 'n2', item: {}, pending_create: true, adopt_id: 'other' }
  idx.byId.set('t1', one)
  idx.byId.set('t2', two)
  expect(idx.byId.has('srv'), 'the target is not in the index').toBe(false)
  invalidateAdopters(idx, 'srv')
  expect([one.adopt_id, two.adopt_id]).toEqual([null, 'other'])
})

// /_gc candidate projection and preview intersection (src/hidden_gc.ts; reviews 129-130).
// rows arrive PARSED (id, name) from the coordinated scan, which fails closed on indeterminate
// rows and excludes admitted ids (pinned in hidden_scan.spec.ts) -- that is why no unreadable
// row can reach this projection
import { gcCandidates, gcIntersect } from '../../src/hidden_gc.js'

test('gc candidates: unique canonical ownerless stores only', () => {
  const rows = [
    { id: 'a1', name: 'global_store_gone' }, // unique orphan: candidate
    { id: 'b1', name: 'global_store_alive' }, // owner exists: revalidated, not a candidate
    { id: 'c1', name: 'global_store_dup' }, // duplicate-name group: excluded entirely
    { id: 'c2', name: 'global_store_dup' },
    { id: 'd1', name: 'not_a_store' }, // non-store hidden record: never a candidate
  ]
  expect(gcCandidates(rows, id => id == 'alive')).toEqual([{ id: 'a1', name: 'global_store_gone' }])
  // owner ARRIVAL revalidates: the same rows with the owner now present select nothing
  expect(gcCandidates(rows, () => true)).toEqual([])
})

test('gc intersection: the modal authorizes an exact (id, name) preview', () => {
  const preview = [
    { id: 'a1', name: 'global_store_x' },
    { id: 'b1', name: 'global_store_y' },
  ]
  const execution = [
    { id: 'a1', name: 'global_store_RENAMED' }, // same id, different name: misses
    { id: 'b1', name: 'global_store_y' }, // exact match: targeted
    { id: 'c1', name: 'global_store_new' }, // appeared while the modal was open: not previewed
  ]
  expect(gcIntersect(preview, execution)).toEqual([{ id: 'b1', name: 'global_store_y' }])
})
