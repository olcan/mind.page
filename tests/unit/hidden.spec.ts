import { expect, test } from '@playwright/test'
import {
  buildHiddenIndex,
  registerHidden,
  applyRemoteAdded,
  applyRemoteModified,
  applyRemoteRemoved,
  removeHidden,
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
  expect(invalid.map(entry => [entry.wrapper.id, entry.reason])).toEqual([
    ['b2', 'duplicate'],
    ['c3', 'orphaned'],
  ])
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
