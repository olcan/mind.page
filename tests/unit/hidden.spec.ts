import { expect, test } from '@playwright/test'
import {
  buildHiddenIndex,
  classifyInvalidHidden,
  registerHidden,
  applyRemoteAdded,
  applyRemoteModified,
  applyRemoteRemoved,
  removeHidden,
  finalizeAdoption,
  type HiddenIndex,
  type HiddenWrapper,
} from '../../src/hidden.js'

// table tests for the hidden-item index transitions (see src/hidden.ts): the minimum-id rule for
// duplicate names, invalid classification at initialization, pending-create adoption, and the
// remote add/modify/remove transitions

const index = (): HiddenIndex => ({ byId: new Map(), byName: new Map() })
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
  const pending: HiddenWrapper = { id: 'temp1', name: 'global_store_x', item: { mine: 1 }, pending_create: true, adopt_id: null }
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
  const merge = () => {}
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
  const merge = () => {}
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
  const index = { byId: new Map(), byName: new Map() }
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
