import { expect, test } from '@playwright/test'
import {
  createStorePublisher,
  invalidateDependents,
  publishOwnerStore,
  type PublisherDeps,
} from '../../src/hidden_publish.js'

// table tests for owner-store publication (see src/hidden_publish.ts): a changed publication
// assigns and then invalidates the owner and each dependent once, in that order; an unchanged
// one does nothing; the delivery-side dependents pass never touches the owner and never repeats
// a dependent; and the composition (createStorePublisher) resolves wrapper names to local owners,
// clones only a changed applied state, keeps the pre-extraction falsey-value rules, and
// publishes the startup-orphan `{}` fallback. one ORDERED event log per harness: the order of
// assignment and invalidations is part of the contract

const harness = (
  stores: Record<string, unknown>,
  dependents: Record<string, string[]>,
  applied: Record<string, unknown> = {},
  saved: Record<string, string> = {} // saved id -> local id
) => {
  const events: string[] = []
  let cloned = 0
  const deps: PublisherDeps = {
    current: id => stores[id],
    assign: (id, state) => {
      stores[id] = state
      events.push(`assign:${id}`)
    },
    dependents: id => dependents[id] ?? [],
    // an invalidation must see the new state already assigned to the owner
    invalidate: id => events.push(`invalidate:${id}:${JSON.stringify(stores[id] ?? null)}`),
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    exists: id => id in stores || id in dependents,
    localId: id => saved[id] ?? id,
    applied: name => applied[name],
    clone: state => {
      cloned++
      return JSON.parse(JSON.stringify(state))
    },
  }
  return { deps, events, stores, cloned: () => cloned }
}

test('a changed publication assigns, then invalidates the owner, then each dependent once', () => {
  const { deps, events, stores } = harness({ b: { v: 1 } }, { b: ['a', 'p', 'a', 'b'] })
  expect(publishOwnerStore(deps, 'b', { v: 2 })).toBe(true)
  expect(stores.b).toEqual({ v: 2 })
  // ordered: the assignment first, the owner next (seeing the new state), then the dependents
  // in order, duplicates and the owner's own id dropped
  expect(events).toEqual(['assign:b', 'invalidate:b:{"v":2}', 'invalidate:a:null', 'invalidate:p:null'])
})

test('an unchanged publication assigns and schedules nothing', () => {
  const { deps, events } = harness({ b: { v: 1 } }, { b: ['a'] })
  expect(publishOwnerStore(deps, 'b', { v: 1 })).toBe(false)
  expect(events).toEqual([])
})

test('a missing owner store equals an empty one, so publishing {} or undefined changes nothing', () => {
  const { deps, events } = harness({}, { b: ['a'] })
  expect(publishOwnerStore(deps, 'b', {})).toBe(false)
  expect(publishOwnerStore(deps, 'b', undefined)).toBe(false)
  expect(events).toEqual([])
  // and a first real value publishes
  expect(publishOwnerStore(deps, 'b', { v: 1 })).toBe(true)
  expect(events).toEqual(['assign:b', 'invalidate:b:{"v":1}', 'invalidate:a:null'])
})

test('the delivery-side pass invalidates each dependent once and never the owner', () => {
  const { deps, events } = harness({ b: { v: 1 } }, { b: ['a', 'a', 'b', 'q'] })
  invalidateDependents(deps, 'b')
  expect(events).toEqual(['invalidate:a:null', 'invalidate:q:null'])
  // an owner without dependents schedules nothing
  invalidateDependents(deps, 'lonely')
  expect(events).toEqual(['invalidate:a:null', 'invalidate:q:null'])
})

test('syncOwner publishes a changed private copy to the local owner of a saved id, or nothing', () => {
  const { deps, events, stores, cloned } = harness({ tmp_b: { v: 1 } }, { tmp_b: ['a'] }, {}, { saved_b: 'tmp_b' })
  const publisher = createStorePublisher(deps)
  const state = { v: 2 }
  publisher.syncOwner('global_store_saved_b', state)
  expect(stores.tmp_b).toBe(state) // handed over, not cloned
  expect(events).toEqual(['assign:tmp_b', 'invalidate:tmp_b:{"v":2}', 'invalidate:a:null'])
  expect(cloned()).toBe(0)
  // an equal state, a missing owner, and a name that is not a store publish nothing
  publisher.syncOwner('global_store_saved_b', { v: 2 })
  publisher.syncOwner('global_store_nobody', { v: 9 })
  publisher.syncOwner('focus', { v: 9 })
  expect(events).toHaveLength(3)
})

test('reconcileOwner clones the applied state only when it differs from the owner copy', () => {
  const applied: Record<string, unknown> = { global_store_b: { v: 1 } }
  const { deps, events, stores, cloned } = harness({ b: { v: 1 }, c: { v: 1 } }, { b: ['a'], c: [] }, applied)
  const publisher = createStorePublisher(deps)
  publisher.reconcileOwner('global_store_b') // equal: no clone, no invalidation
  expect(cloned()).toBe(0)
  expect(events).toEqual([])
  applied.global_store_b = { v: 3 }
  publisher.reconcileOwner('global_store_b')
  expect(cloned()).toBe(1)
  expect(stores.b).toEqual({ v: 3 })
  expect(stores.b).not.toBe(applied.global_store_b) // a clone, never the index's object
  expect(events).toEqual(['assign:b', 'invalidate:b:{"v":3}', 'invalidate:a:null'])
  // an EXISTING owner with no applied state publishes nothing (the owner keeps its copy)
  publisher.reconcileOwner('global_store_c')
  expect(stores.c).toEqual({ v: 1 })
  expect(events).toHaveLength(3)
})

test('falsey applied values keep the pre-extraction rules: reconcile skips them, registration maps them to {}', () => {
  for (const falsey of [undefined, null, false, 0, '']) {
    const applied: Record<string, unknown> = { global_store_b: falsey, global_store_c: falsey, global_store_d: falsey }
    const { deps, events, stores } = harness({ b: { v: 1 }, c: { v: 1 }, d: {} }, { b: ['a'], c: ['a'], d: ['a'] }, applied)
    const publisher = createStorePublisher(deps)
    publisher.reconcileOwner('global_store_b') // formerly `if (applied && ...)`: not published
    expect(stores.b).toEqual({ v: 1 })
    expect(events).toEqual([])
    publisher.registerOwner('global_store_c') // formerly `cloneDeep(applied) || {}`: reset to {}
    expect(stores.c).toEqual({})
    expect(events).toEqual(['assign:c', 'invalidate:c:{}', 'invalidate:a:null'])
    publisher.registerOwner('global_store_d') // an owner already holding {} publishes nothing for the same falsey value
    expect(events).toHaveLength(3)
  }
})

test('registerOwner publishes the registered store when the owner copy differs', () => {
  const applied: Record<string, unknown> = { global_store_b: { v: 5 } }
  const { deps, events, stores } = harness({ b: {} }, { b: ['a'] }, applied)
  const publisher = createStorePublisher(deps)
  publisher.registerOwner('global_store_b')
  expect(stores.b).toEqual({ v: 5 })
  expect(stores.b).not.toBe(applied.global_store_b)
  expect(events).toEqual(['assign:b', 'invalidate:b:{"v":5}', 'invalidate:a:null'])
  publisher.registerOwner('global_store_b') // now equal: nothing
  expect(events).toHaveLength(3)
})

test('deliver schedules only the local owner dependents', () => {
  const { deps, events } = harness({ b: { v: 1 } }, { b: ['a', 'p'] })
  createStorePublisher(deps).deliver('b')
  expect(events).toEqual(['invalidate:a:null', 'invalidate:p:null'])
})
