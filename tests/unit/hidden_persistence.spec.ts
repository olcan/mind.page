import { expect, test } from '@playwright/test'
import { createHiddenPersistence, type HiddenPersistenceDeps } from '../../src/hidden_persistence.js'
import { applyRemoteAdded, registerHidden, type HiddenIndex, type HiddenWrapper } from '../../src/hidden.js'

// failure/order matrix for the per-name persistence controller (see src/hidden_persistence.ts):
// serialization, retry-by-supersession, not-found fallback, adoption settlement on success and
// failure, delete-during-create, and readonly. deps are fakes with controllable timing

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

type Call = { op: string; id?: string; text?: string }

function harness(overrides: Partial<HiddenPersistenceDeps> = {}) {
  const idx: HiddenIndex = { byId: new Map(), byName: new Map() }
  const calls: Call[] = []
  let ids = 0
  const deps: HiddenPersistenceDeps = {
    index: () => idx,
    encryptState: async state => ({ ...state }), // "encryption" is the identity for the matrix
    updateDoc: async (id, data) => void calls.push({ op: 'update', id, text: data.text }),
    createDoc: async data => {
      calls.push({ op: 'create', text: data.text })
      return 'doc' + ++ids
    },
    deleteDoc: async id => void calls.push({ op: 'delete', id }),
    confirmIndex: async () => void calls.push({ op: 'confirm' }),
    newTempId: () => 'temp' + ++ids,
    readonly: () => false,
    ...overrides,
  }
  return { idx, calls, deps, controller: createHiddenPersistence(deps) }
}

const itemOf = (text?: string) => JSON.parse(text!).item

test('concurrent updates are serialized per name: the later snapshot always lands last', async () => {
  const first = deferred<void>()
  const { idx, calls, deps, controller } = harness({
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.text })
      if (calls.length == 1) await first.promise // the FIRST write hangs; the second must wait
    },
  })
  idx.byId.set('d1', { id: 'd1', name: 'n' })
  idx.byName.set('n', idx.byId.get('d1')!)
  controller.save('n', { v: 1 })
  controller.save('n', { v: 2 })
  await flush()
  expect(calls.filter(c => c.op == 'update')).toHaveLength(1) // second not issued while first in flight
  first.resolve()
  await flush()
  const updates = calls.filter(c => c.op == 'update')
  expect(updates).toHaveLength(2)
  expect(itemOf(updates[1].text)).toEqual({ v: 2 }) // order preserved: latest state last
  void deps
})

test('a failed update is superseded by the next save, which carries the full state', async () => {
  let fail = true
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.text })
      if (fail) throw new Error('unavailable')
    },
  })
  idx.byId.set('d1', { id: 'd1', name: 'n' })
  idx.byName.set('n', idx.byId.get('d1')!)
  controller.save('n', { a: 1 })
  await flush()
  fail = false
  controller.save('n', { a: 1, b: 2 }) // callers pass complete state each time
  await flush()
  const updates = calls.filter(c => c.op == 'update')
  expect(updates).toHaveLength(2)
  expect(itemOf(updates[1].text)).toEqual({ a: 1, b: 2 })
})

test('an update hitting not-found confirms like a create, then creates the latest snapshot and re-keys', async () => {
  const { idx, calls, controller } = harness({
    updateDoc: async () => {
      const e: any = new Error('missing')
      e.code = 'not-found'
      throw e
    },
  })
  idx.byId.set('gone1', { id: 'gone1', name: 'n' })
  idx.byName.set('n', idx.byId.get('gone1')!)
  controller.save('n', { v: 1 })
  await flush()
  // the document vanished server-side, so this is a create-like transition: it must confirm
  // (adopting any surviving same-name document) BEFORE creating — a blind create could duplicate
  expect(calls.map(c => c.op)).toEqual(['confirm', 'create'])
  expect(itemOf(calls[1].text)).toEqual({ v: 1 })
  expect(idx.byName.get('n')!.id).toBe('doc1') // re-keyed to the created document
  expect(idx.byId.has('gone1')).toBe(false)
})

test('not-found recovery adopts a surviving same-name document instead of creating a duplicate', async () => {
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      if (id == 'gone1') {
        const e: any = new Error('missing')
        e.code = 'not-found'
        throw e
      }
      calls.push({ op: 'update', id, text: data.text })
    },
    confirmIndex: async () => {
      calls.push({ op: 'confirm' })
      // the server read finds a surviving same-name document (e.g. a duplicate another client
      // kept): registration adopts it into the recovering (pending) wrapper
      registerHidden(idx, { id: 'srv7', name: 'n', item: { theirs: 1 } }, (pending, found) =>
        Object.assign(pending.item, { ...found.item, ...pending.item })
      )
    },
  })
  idx.byId.set('gone1', { id: 'gone1', name: 'n' })
  idx.byName.set('n', idx.byId.get('gone1')!)
  controller.save('n', { mine: 2 })
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0) // never a duplicate create
  const updates = calls.filter(c => c.op == 'update')
  expect(updates).toEqual([{ op: 'update', id: 'srv7', text: updates[0].text }])
  expect(itemOf(updates[0].text)).toEqual({ theirs: 1, mine: 2 }) // merged, latest precedence
  expect(idx.byName.get('n')!.id).toBe('srv7')
  expect(idx.byId.has('gone1')).toBe(false)
})

test('a create claims the name, confirms the index, persists and re-keys to the persistent id', async () => {
  const { idx, calls, controller } = harness()
  controller.save('n', { v: 1 })
  const wrapper = idx.byName.get('n')!
  expect(wrapper.pending_create).toBe(true)
  await flush()
  expect(calls.map(c => c.op)).toEqual(['confirm', 'create'])
  expect(wrapper.pending_create).toBeNull()
  expect(idx.byId.get(wrapper.id)).toBe(wrapper)
  expect(wrapper.id).toMatch(/^doc/)
})

test('updates queued behind a create wait for it and use the persistent id', async () => {
  const gate = deferred<string>()
  const { idx, calls, controller } = harness({
    createDoc: async data => {
      calls.push({ op: 'create', text: data.text })
      return gate.promise
    },
  })
  controller.save('n', { v: 1 })
  await flush()
  controller.save('n', { v: 2 }) // update path: the pending wrapper already owns the name
  await flush()
  expect(calls.filter(c => c.op == 'update')).toHaveLength(0) // waiting behind the create
  gate.resolve('doc9')
  await flush()
  const updates = calls.filter(c => c.op == 'update')
  expect(updates).toHaveLength(1)
  expect(updates[0].id).toBe('doc9')
  expect(itemOf(updates[0].text)).toEqual({ v: 2 })
})

test('a failed confirmation fails the create: no document is written and the name is released', async () => {
  const { idx, calls, controller } = harness({
    confirmIndex: async () => {
      throw new Error('server unavailable')
    },
  })
  controller.save('n', { v: 1 })
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0)
  expect(idx.byName.has('n')).toBe(false) // released: the next save retries the create cleanly
})

test('adoption found during confirmation updates the existing document with merged state and settles', async () => {
  const { idx, calls, controller } = harness({
    confirmIndex: async () => {
      // the server confirmation registers an existing document, adopting the pending wrapper
      registerHidden(idx, { id: 'srv1', name: 'n', item: { theirs: 1 } }, (pending, found) =>
        Object.assign(pending.item, { ...found.item, ...pending.item })
      )
    },
  })
  controller.save('n', { mine: 2 })
  await flush()
  const updates = calls.filter(c => c.op == 'update')
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0)
  expect(updates).toHaveLength(1)
  expect(updates[0].id).toBe('srv1')
  expect(itemOf(updates[0].text)).toEqual({ theirs: 1, mine: 2 }) // merged, pending precedence
  const wrapper = idx.byName.get('n')!
  expect(wrapper.id).toBe('srv1')
  expect(wrapper.pending_create).toBeNull()
})

test('a failed adopted update still settles onto the document: the next save updates, never creates', async () => {
  let fail = true
  const { idx, calls, controller } = harness({
    confirmIndex: async () => {
      registerHidden(idx, { id: 'srv1', name: 'n', item: {} }, () => {})
    },
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.text })
      if (fail) throw new Error('unavailable')
    },
  })
  controller.save('n', { v: 1 })
  await flush()
  expect(idx.byName.get('n')!.id).toBe('srv1') // settled onto the known document
  fail = false
  controller.save('n', { v: 2 })
  await flush()
  const updates = calls.filter(c => c.op == 'update')
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0) // never a duplicate create
  expect(updates[1]).toMatchObject({ id: 'srv1' })
  expect(itemOf(updates[1].text)).toEqual({ v: 2 })
})

test('a delete during a pending create removes the eventually-persisted document', async () => {
  const gate = deferred<string>()
  const { idx, calls, controller } = harness({
    createDoc: async data => {
      calls.push({ op: 'create', text: data.text })
      return gate.promise
    },
  })
  controller.save('n', { v: 1 })
  const wrapper = idx.byName.get('n')!
  await flush()
  const tempId = wrapper.id
  controller.delete(tempId)
  expect(idx.byName.has('n')).toBe(false) // removed from the index immediately
  await flush()
  expect(calls.filter(c => c.op == 'delete')).toHaveLength(0) // waiting behind the create
  gate.resolve('doc7')
  await flush()
  expect(calls.filter(c => c.op == 'delete')).toEqual([{ op: 'delete', id: 'doc7' }])
  // the tombstoned wrapper is never reinserted, and its saving mirror is cleared at the tail
  expect(idx.byId.size).toBe(0)
  expect(idx.byName.size).toBe(0)
  expect(wrapper.saving).toBeNull()
})

test('a delete after a FAILED create deletes nothing (no document was persisted)', async () => {
  const { idx, calls, controller } = harness({
    createDoc: async () => {
      throw new Error('unavailable')
    },
  })
  controller.save('n', { v: 1 })
  const tempId = idx.byName.get('n')!.id
  await flush()
  controller.delete(tempId) // wrapper already removed by the failure; direct id delete path
  await flush()
  expect(calls.filter(c => c.op == 'delete')).toHaveLength(1) // unknown id: deleted defensively
  const wrapperless = harness()
  wrapperless.controller.delete('never-existed')
  await flush()
  expect(wrapperless.calls).toEqual([{ op: 'delete', id: 'never-existed' }])
})


test('a save queued during a pending create is dropped when the create fails (never an unconfirmed create)', async () => {
  const confirm = deferred<void>()
  const { idx, calls, controller } = harness({
    confirmIndex: async () => {
      calls.push({ op: 'confirm' })
      await confirm.promise // hold the create in confirmation while the second save queues
    },
  })
  controller.save('n', { v: 1 })
  await flush()
  controller.save('n', { v: 2 }) // queues behind the in-flight create
  confirm.reject(new Error('server unavailable'))
  await flush()
  // pre-controller behavior restored: the queued save is dropped with the failed create — it
  // must not update the temporary id, hit not-found, and create WITHOUT confirmation
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0)
  expect(calls.filter(c => c.op == 'update')).toHaveLength(0)
  expect(idx.byName.has('n')).toBe(false) // released: the next save retries the create cleanly
  expect(idx.byId.size).toBe(0) // the removed wrapper is not resurrected
})

test('a save queued across an adoption still persists the merged state (adopted fields survive)', async () => {
  const confirm = deferred<void>()
  const { idx, calls, controller } = harness({
    confirmIndex: async () => {
      registerHidden(idx, { id: 'srv1', name: 'n', item: { theirs: 1 } }, (pending, found) =>
        Object.assign(pending.item, { ...found.item, ...pending.item })
      )
      await confirm.promise
    },
  })
  controller.save('n', { mine: 2 })
  await flush()
  controller.save('n', idx.byName.get('n')!.item) // caller mutates and re-saves the same state object
  confirm.resolve()
  await flush()
  const updates = calls.filter(c => c.op == 'update')
  expect(updates).toHaveLength(2)
  // both writes carry the adoption-merged state: payloads serialize at execution, after the merge
  expect(itemOf(updates[0].text)).toEqual({ theirs: 1, mine: 2 })
  expect(itemOf(updates[1].text)).toEqual({ theirs: 1, mine: 2 })
})

test('a delete during an adopted create does not resurrect the wrapper and deletes the adopted document', async () => {
  const update = deferred<void>()
  const { idx, calls, controller } = harness({
    confirmIndex: async () => {
      registerHidden(idx, { id: 'srv1', name: 'n', item: {} }, () => {})
    },
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.text })
      await update.promise // hold the adopted update in flight while the delete arrives
    },
  })
  controller.save('n', { v: 1 })
  await flush()
  const wrapper = idx.byName.get('n')!
  controller.delete(wrapper.id)
  expect(idx.byName.has('n')).toBe(false)
  update.resolve()
  await flush()
  // settlement re-keys the tombstoned wrapper but must NOT reinsert it; the queued delete then
  // removes the adopted document
  expect(idx.byId.size).toBe(0)
  expect(idx.byName.size).toBe(0)
  expect(calls.filter(c => c.op == 'delete')).toEqual([{ op: 'delete', id: 'srv1' }])
  expect(wrapper.saving).toBeNull()
})

test('a fresh create settles to the minimum id when a lower-id duplicate arrives while it is in flight', async () => {
  const gate = deferred<string>()
  const { idx, calls, controller } = harness({
    createDoc: async data => {
      calls.push({ op: 'create', text: data.text })
      return gate.promise
    },
  })
  controller.save('n', { v: 1 })
  await flush()
  // a remote lower-id duplicate arrives mid-create; the pending claim is not displaced ...
  applyRemoteAdded(idx, { id: 'aaa1', name: 'n', item: { remote: true } })
  expect(idx.byName.get('n')!.pending_create).toBe(true)
  gate.resolve('zzz9')
  await flush()
  // ... but settlement restores the module's minimum-id rule: the remote duplicate wins the name
  expect(idx.byName.get('n')!.id).toBe('aaa1')
  expect(idx.byId.get('zzz9')!.item).toEqual({ v: 1 }) // the created document is retained in byId
})

test('a save against a wrapper displaced from byId (remote replacement or rename) is dropped', async () => {
  const gate = deferred<void>()
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.text })
      if (calls.length == 1) await gate.promise
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 0 } }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  controller.save('n', { v: 1 })
  await flush() // the first write is now in flight, held at the gate
  controller.save('n', { v: 2 }) // queued behind it
  // a remote modification replaces the wrapper object under the same id (or a rename leaves a
  // stale byName alias): the queued save must not write through the displaced wrapper — it
  // would overwrite the canonical remote state or rename the document back
  idx.byId.set('d1', { id: 'd1', name: 'n', item: { remote: true } })
  gate.resolve()
  await flush()
  expect(calls.filter(c => c.op == 'update')).toHaveLength(1) // only the first, in-flight write
})

test('readonly mode mutates the index but never writes', async () => {
  const { idx, calls, controller } = harness({ readonly: () => true })
  controller.save('n', { v: 1 })
  await flush()
  expect(idx.byName.get('n')!.item).toEqual({ v: 1 })
  controller.delete(idx.byName.get('n')!.id)
  await flush()
  expect(calls).toEqual([])
})
