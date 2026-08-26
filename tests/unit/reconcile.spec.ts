import { expect, test } from '@playwright/test'
import { reconcileDeferred, type ReconcileDeps, type ReconcileItem } from '../../src/reconcile.js'

// schedules for deferred-change reconciliation (see src/reconcile.ts). these exist as unit tests
// because the schedule that matters CANNOT be staged from outside the browser: the app talks to
// firestore over Listen and Write channels only, and a server read rides Listen — so holding it
// client-side means the server has not read yet, and on release it reads AFTER the competing write
// and returns the new state, which the equality check settles harmlessly. the destructive case
// needs the server to read BEFORE the write lands and the RESPONSE to arrive after, which route
// interception cannot produce inside a WebChannel stream

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

type Applied = { type: string; id: string; savedItem: any }

function harness(overrides: Partial<ReconcileDeps> = {}) {
  const applied: Applied[] = []
  const deferrals = new Map<string, number>([['d1', 1]])
  const deps: ReconcileDeps = {
    readFromServer: async () => ({ exists: true, data: { text: 'server', time: 2, attr: null } }),
    decryptItem: async data => data,
    applyRemote: (type, id, savedItem) => void applied.push({ type, id, savedItem }),
    hasLocalIntent: () => false,
    deferredGeneration: id => deferrals.get(id),
    clearDeferral: id => void deferrals.delete(id),
    ...overrides,
  }
  // what the app believes the server holds; the read below returns something different
  const item: ReconcileItem = { savedId: 'd1', savedText: 'local', savedTime: 1, savedAttr: null, saveSeq: 0 }
  return { deps, item, applied, deferrals }
}

test('a differing server copy is applied and the marker cleared', async () => {
  const { deps, item, applied, deferrals } = harness()
  expect(await reconcileDeferred(deps, item, 1)).toBe(true)
  expect(applied).toEqual([{ type: 'modified', id: 'd1', savedItem: { text: 'server', time: 2, attr: null, id: 'd1' } }])
  expect(deferrals.has('d1')).toBe(false) // terminal
})

test('A SAVE THAT STARTS AND FINISHES DURING THE READ is not overwritten', async () => {
  // THE destructive case. hasLocalIntent answers "is a save in flight NOW", so a save that both
  // started and finished inside the read window left no trace in it — and the response, read
  // before that save landed, was applied over the user's completed edit and then persisted by the
  // next save. the intent VERSION is what makes it visible
  const read = deferred<{ exists: boolean; data?: any }>()
  const { deps, item, applied, deferrals } = harness({ readFromServer: () => read.promise })
  const settled = reconcileDeferred(deps, item, 1)
  // ... the save runs entirely inside the read window: it bumps the version and leaves no other
  // trace, since it has already completed by the time the response arrives
  item.saveSeq = 1
  item.savedText = 'edited during the read'
  read.resolve({ exists: true, data: { text: 'server', time: 2, attr: null } })
  expect(await settled).toBe(true)
  expect(applied, 'the completed edit is not rolled back').toEqual([])
  expect(deferrals.get('d1'), 'the marker stays: a later reconcile settles it').toBe(1)
})

test('intent already present at entry defers to it', async () => {
  const { deps, item, applied } = harness({ hasLocalIntent: () => true })
  expect(await reconcileDeferred(deps, item, 1)).toBe(true)
  expect(applied).toEqual([])
})

test('intent arriving during the read defers to it', async () => {
  const read = deferred<{ exists: boolean; data?: any }>()
  let intent = false
  const { deps, item, applied } = harness({ readFromServer: () => read.promise, hasLocalIntent: () => intent })
  const settled = reconcileDeferred(deps, item, 1)
  intent = true // a save queued while the read was in flight, and still unsettled
  read.resolve({ exists: true, data: { text: 'server', time: 2, attr: null } })
  expect(await settled).toBe(true)
  expect(applied).toEqual([])
})

test('a newer deferral during the read owns the document, and its marker survives', async () => {
  const read = deferred<{ exists: boolean; data?: any }>()
  const { deps, item, applied, deferrals } = harness({ readFromServer: () => read.promise })
  const settled = reconcileDeferred(deps, item, 1)
  deferrals.set('d1', 2) // a newer remote change arrived and was deferred
  read.resolve({ exists: true, data: { text: 'server', time: 2, attr: null } })
  expect(await settled).toBe(true)
  expect(applied).toEqual([])
  expect(deferrals.get('d1'), "the newer deferral's marker is not cleared by this older read").toBe(2)
})

test('a document gone from the server is removed', async () => {
  const { deps, item, applied, deferrals } = harness({ readFromServer: async () => ({ exists: false }) })
  expect(await reconcileDeferred(deps, item, 1)).toBe(true)
  expect(applied).toEqual([{ type: 'removed', id: 'd1', savedItem: { hidden: false, text: '' } }])
  expect(deferrals.has('d1')).toBe(false)
})

test('a server copy equal to what we already hold applies nothing', async () => {
  const { deps, item, applied, deferrals } = harness({
    readFromServer: async () => ({ exists: true, data: { text: 'local', time: 1, attr: null } }),
  })
  expect(await reconcileDeferred(deps, item, 1)).toBe(true)
  expect(applied, 'applying would be a no-op').toEqual([])
  expect(deferrals.has('d1')).toBe(false) // still terminal: nothing was lost
})

test('attributes are compared structurally, not by identity', async () => {
  const { deps, item, applied } = harness({
    readFromServer: async () => ({ exists: true, data: { text: 'local', time: 1, attr: { a: [1, { b: 2 }] } } }),
  })
  item.savedAttr = { a: [1, { b: 2 }] } // equal contents, different object
  expect(await reconcileDeferred(deps, item, 1)).toBe(true)
  expect(applied).toEqual([])
})

test('a document that became hidden is no longer ours to settle', async () => {
  const { deps, item, applied, deferrals } = harness({
    readFromServer: async () => ({ exists: true, data: { hidden: true, text: 'wrapper' } }),
  })
  expect(await reconcileDeferred(deps, item, 1)).toBe(true)
  expect(applied).toEqual([])
  expect(deferrals.has('d1')).toBe(false)
})

test('a failed read is RETRYABLE and keeps its marker', async () => {
  const { deps, item, applied, deferrals } = harness({
    readFromServer: async () => {
      throw new Error('unavailable')
    },
  })
  expect(await reconcileDeferred(deps, item, 1), 'not terminal').toBe(false)
  expect(applied).toEqual([])
  expect(deferrals.get('d1'), 'nothing else will redeliver this change').toBe(1)
})

test('a failed decrypt is retryable too', async () => {
  const { deps, item, deferrals } = harness({
    decryptItem: async () => {
      throw new Error('bad cipher')
    },
  })
  expect(await reconcileDeferred(deps, item, 1)).toBe(false)
  expect(deferrals.get('d1')).toBe(1)
})

test('a document with no saved id is not ours to settle', async () => {
  const { deps, applied } = harness()
  expect(await reconcileDeferred(deps, { savedId: null }, 1)).toBe(true)
  expect(applied).toEqual([])
})
