import { expect, test } from '@playwright/test'
import { createHiddenPersistence, type HiddenPersistenceDeps } from '../../src/hidden_persistence.js'
import {
  applyRemoteAdded,
  registerHidden,
  removeHidden,
  type HiddenIndex,
  type HiddenWrapper,
} from '../../src/hidden.js'

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
    // mimics production encryptItem EXACTLY: it MUTATES its argument and RETURNS THAT OBJECT
    // with text/attr nulled, the plaintext surviving only inside the cipher (an identity fake
    // masked a real provenance bug — see recordWrite in hidden_persistence.ts)
    encryptState: async state => {
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      encrypted.attr = null
      return encrypted
    },
    // an ordinary write, exactly like production: no precondition, no revision. the plaintext
    // survives only inside the cipher, since encryptState above nulls text like the real one
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
    },
    createDoc: async (id, data) => {
      calls.push({ op: 'create', id, text: data.cipher ?? data.text })
    },
    newDocId: () => 'doc' + ++ids,
    confirmIndex: async _name => void calls.push({ op: 'confirm' }),
    adopt: (pending, found) => Object.assign(pending.item, { ...found.item, ...pending.item }),
    invalidateAuthority: reason => void calls.push({ op: 'invalidate', id: reason }),
    newTempId: () => 'temp' + ++ids,
    readonly: () => false,
    ...overrides,
  }
  return { idx, calls, deps, controller: createHiddenPersistence(deps) }
}

// mimics the items listener for one remote hidden record: receipt-time intent is noted FIRST
// (so create/adopt decisions can see it even while its application queues behind them), then the
// application itself runs on the affected name chains. tests must arrive through this, never by
// calling the reducer directly — direct calls manufacture an ordering production prevents
function arrive(controller: any, idx: HiddenIndex, wrapper: HiddenWrapper) {
  controller.noteRemote(wrapper, wrapper.id, false)
  const names = [idx.byId.get(wrapper.id)?.name, wrapper.name]
  return controller.applyRemote(names, () => applyRemoteAdded(idx, wrapper))
}

function arriveRemoval(controller: any, idx: HiddenIndex, id: string) {
  controller.noteRemote(undefined, id, true)
  return controller.applyRemote([controller.nameForDocument(id)], () => removeHidden(idx, id))
}

const itemOf = (text?: string) => JSON.parse(String(text).replace(/^cipher:/, '')).item

test('successive saves both reach the write queue in order, without waiting for acknowledgement', async () => {
  // round-13 finding 2: this test previously asserted the opposite — that a second save must not
  // be issued while the first was unacknowledged. offline, `updateDoc` reaches the SDK's durable
  // queue immediately but its promise stays pending until the server accepts, so waiting on it
  // meant only the FIRST offline save survived a reload and every later one was lost with the
  // tab. issue order is preserved; acknowledgement order is the server's business
  const ack = deferred<void>()
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
      await ack.promise // NEITHER write is acknowledged during this test
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: {} }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  // two saves in the same window COALESCE: the queued task serializes current state, so a
  // second write of identical content would be pure waste
  controller.save('n', { v: 1 })
  controller.save('n', { v: 2 })
  await flush()
  expect(calls.filter(c => c.op == 'update')).toHaveLength(1)
  expect(itemOf(calls[0].text)).toEqual({ v: 2 }) // carrying the latest state
  // a LATER save is issued even though the first is still unacknowledged: waiting for the ack
  // is what lost every offline change after the first (round-13 finding 2)
  controller.save('n', { v: 3 })
  await flush()
  const updates = calls.filter(c => c.op == 'update')
  expect(updates).toHaveLength(2)
  expect(itemOf(updates[1].text)).toEqual({ v: 3 })
  ack.resolve()
})
test('a failed update is superseded by the next save, which carries the full state', async () => {
  let fail = true
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
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
  // the document vanished server-side, so this is a create-like transition: it must revoke
  // authority (the missing target proves the index stale, so confirmation actually re-reads
  // the server) and confirm BEFORE creating — a blind create could duplicate
  expect(calls.map(c => c.op)).toEqual(['invalidate', 'confirm', 'create'])
  expect(itemOf(calls[2].text)).toEqual({ v: 1 })
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
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
    },
    confirmIndex: async _name => {
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

test('a save after a create does not wait for the create to be acknowledged', async () => {
  // round-14 finding 2: this test previously asserted the opposite — that no update may be
  // issued until the create's promise resolved. offline that promise never resolves, so a store
  // created and then changed offline persisted only its FIRST state and lost every later one on
  // reload. the id is preallocated, so nothing downstream needs the server's answer
  const ack = deferred<void>()
  const { idx, calls, controller } = harness({
    createDoc: async (id, data) => {
      calls.push({ op: 'create', id, text: data.cipher ?? data.text })
      await ack.promise // never acknowledged during this test
    },
  })
  controller.save('n', { v: 1 })
  await flush()
  const createdId = calls.find(c => c.op == 'create')!.id!
  controller.save('n', { v: 2 }) // update path: the pending wrapper already owns the name
  await flush()
  const updates = calls.filter(c => c.op == 'update')
  expect(updates).toHaveLength(1) // issued despite the unacknowledged create
  expect(updates[0].id).toBe(createdId) // targeting the preallocated id
  expect(itemOf(updates[0].text)).toEqual({ v: 2 })
  ack.resolve()
})
test('a failed confirmation fails the create: no document is written and the name is released', async () => {
  const { idx, calls, controller } = harness({
    confirmIndex: async _name => {
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
    confirmIndex: async _name => {
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
    confirmIndex: async _name => {
      registerHidden(idx, { id: 'srv1', name: 'n', item: {} }, () => {})
    },
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
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

test('a save queued during a pending create is dropped when the create fails (never an unconfirmed create)', async () => {
  const confirm = deferred<void>()
  const { idx, calls, controller } = harness({
    confirmIndex: async _name => {
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
    confirmIndex: async _name => {
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

test('a fresh create settles to the minimum id when a lower-id duplicate arrives right after it', async () => {
  // the create no longer stays "in flight" (it settles as soon as the write is ISSUED, see the
  // durability note in persistCreate), but the minimum-id rule must still hold when a lower-id
  // duplicate arrives: the remote record wins the name, and ours is retained in byId
  const { idx, calls, controller } = harness()
  controller.save('n', { v: 1 })
  await flush()
  const createdId = calls.find(c => c.op == 'create')!.id!
  await arrive(controller, idx, { id: 'aaa1', name: 'n', item: { remote: true } })
  expect(idx.byName.get('n')!.id).toBe('aaa1') // lower id wins the name
  expect(idx.byId.get(createdId)!.item).toEqual({ v: 1 }) // ours is retained, not lost
})
test('a save against a wrapper displaced from byId (remote replacement or rename) is dropped', async () => {
  const gate = deferred<void>()
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
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


test('a create adopts a same-name record already known locally instead of creating alongside it', async () => {
  // round-8 finding 5: an authoritative (no-op) confirmation with a survivor already in byId
  // must adopt the minimum-id survivor, not create a duplicate document
  const gate = deferred<void>()
  const { idx, calls, controller } = harness({
    createDoc: async (id, data) => {
      calls.push({ op: 'create', id, text: data.cipher ?? data.text })
      return gate.promise
    },
  })
  // the record arrives through the LISTENER path while the create is in flight: its application
  // queues behind the create on the same name chain, so only the receipt-time intent can save
  // the decision from creating a duplicate
  controller.save('n', { mine: 2 })
  void arrive(controller, idx, { id: 'srv1', name: 'n', item: { theirs: 1 } })
  gate.resolve()
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0)
  const updates = calls.filter(c => c.op == 'update')
  expect(updates).toHaveLength(1)
  expect(updates[0].id).toBe('srv1')
  expect(itemOf(updates[0].text)).toEqual({ theirs: 1, mine: 2 }) // adopted state merged, latest wins
  expect(idx.byName.get('n')!.id).toBe('srv1')
})

test('not-found recovery with an authoritative no-op confirmation adopts the retained survivor', async () => {
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      if (id == 'gone1') {
        const e: any = new Error('missing')
        e.code = 'not-found'
        throw e
      }
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
    },
    confirmIndex: async _name => void calls.push({ op: 'confirm' }), // authoritative: registers nothing
  })
  const canonical: HiddenWrapper = { id: 'gone1', name: 'n', item: { v: 0 } }
  const survivor: HiddenWrapper = { id: 'srv0', name: 'n', item: { theirs: 1 } } // retained duplicate
  idx.byId.set('gone1', canonical)
  idx.byId.set('srv0', survivor)
  idx.byName.set('n', canonical)
  controller.save('n', { mine: 2 })
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0) // never a duplicate
  const updates = calls.filter(c => c.op == 'update')
  expect(updates).toEqual([{ op: 'update', id: 'srv0', text: updates[0].text }])
  expect(itemOf(updates[0].text)).toEqual({ theirs: 1, mine: 2 })
  expect(idx.byName.get('n')!.id).toBe('srv0')
  expect(idx.byId.has('gone1')).toBe(false)
})

test('a save whose wrapper is replaced during encryption is dropped', async () => {
  const gate = deferred<void>()
  const { idx, calls, controller } = harness({
    encryptState: async state => {
      await gate.promise // encryption pauses (e.g. a phrase prompt)
      return { ...state }
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 0 } }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  controller.save('n', { v: 1 })
  await flush() // task started, held inside encryptState
  const replacement: HiddenWrapper = { id: 'd1', name: 'n', item: { remote: true } }
  idx.byId.set('d1', replacement)
  idx.byName.set('n', replacement)
  gate.resolve()
  await flush()
  expect(calls.filter(c => c.op == 'update')).toHaveLength(0) // the stale write never went out
})

test('a save whose wrapper is replaced while its write is in flight drops on not-found instead of recovering', async () => {
  const inFlight = deferred<void>()
  const { idx, calls, controller } = harness({
    updateDoc: async () => {
      await inFlight.promise
      const e: any = new Error('missing')
      e.code = 'not-found'
      throw e
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 0 } }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  controller.save('n', { v: 1 })
  await flush() // write in flight
  // a remote replacement lands and the server deletes the old document: the replacement is
  // canonical, so the stale write must not enter create-recovery and duplicate or rename back
  const replacement: HiddenWrapper = { id: 'd9', name: 'n', item: { remote: true } }
  idx.byId.delete('d1')
  idx.byId.set('d9', replacement)
  idx.byName.set('n', replacement)
  inFlight.resolve()
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0)
  expect(calls.filter(c => c.op == 'confirm')).toHaveLength(0)
  expect(idx.byName.get('n')).toBe(replacement) // untouched
})

test('remote transitions are not delayed by an unacknowledged local write', async () => {
  // the chain used to hold until the server acknowledged, which delayed every remote transition
  // for that name behind it — and offline, indefinitely. writes are issued and released now, so
  // a remote change applies promptly; our own echo is filtered by payload instead (isOwnEcho)
  const ack = deferred<void>()
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
      await ack.promise
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 0 } }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  controller.save('n', { v: 1 })
  await flush() // write issued, still unacknowledged
  const order: string[] = []
  await controller.applyRemote(['n'], () => order.push('remote'))
  expect(order).toEqual(['remote']) // applied without waiting for the acknowledgement
  ack.resolve()
})
test('the saving mirror clears per wrapper even when the name chain continues with a new wrapper', async () => {
  const gate = deferred<void>()
  let gated = true
  const h = harness()
  const { idx } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    updateDoc: async () => {
      if (gated) await gate.promise
    },
  })
  const first: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 0 } }
  idx.byId.set('d1', first)
  idx.byName.set('n', first)
  controller.save('n', { v: 1 }) // first wrapper mirrors its in-flight write
  expect(first.saving).toBeTruthy()
  // the record is replaced remotely while that write is in flight, and the NEW wrapper takes
  // over the name's chain
  const replacement: HiddenWrapper = { id: 'd1', name: 'n', item: { remote: true } }
  idx.byId.set('d1', replacement)
  idx.byName.set('n', replacement)
  controller.save('n', { v: 2 })
  const fresh = idx.byName.get('n')!
  gated = false
  gate.resolve()
  await flush()
  // each wrapper's mirror clears when ITS OWN task settles, not when the chain finally drains
  expect(first.saving).toBeNull()
  expect(fresh.saving).toBeNull()
})
test('a write already issued is not retracted by a later rename (durability over rename order)', async () => {
  // round-9 finding 6 wanted a remote rename to wait for an in-flight old-name write, so the
  // write could not put the old name back. that guarantee is incompatible with durable offline
  // writes: a write reaches the SDK's queue the moment it is issued and cannot be recalled by
  // information that arrives afterwards. the app never renames hidden records (their names are
  // global_store_<owner id>), so durability wins and this is a documented residual, pinned here
  // so it cannot become an accident
  const ack = deferred<void>()
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
      await ack.promise
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'old', item: { v: 0 } }
  idx.byId.set('d1', wrapper)
  idx.byName.set('old', wrapper)
  controller.save('old', { v: 1 })
  await flush() // issued, carrying name 'old'
  const order: string[] = []
  await controller.applyRemote(['old', 'new'], () => order.push('rename applied'))
  expect(order).toEqual(['rename applied']) // applies immediately; the queued write is not held
  expect(itemOf(calls[0].text)).toEqual({ v: 1 })
  ack.resolve()
})
test('a removal arriving during an adopted create serializes on the adopting name', async () => {
  // the adopted server id is not in byId until finalization, so its name can only be derived
  // from the pending adoption — otherwise the removal ran outside the chain entirely
  const update = deferred<void>()
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmIndex: async _name => {
      registerHidden(idx, { id: 'srv1', name: 'n', item: {} }, () => {})
    },
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
      await update.promise
    },
  })
  controller.save('n', { v: 1 })
  await flush() // adoption chosen, adopted update in flight
  expect(controller.nameForDocument('srv1')).toBe('n') // derived from the pending adoption
  const order: string[] = []
  const removal = arriveRemoval(controller, idx, 'srv1')
  order.push('queued')
  update.resolve()
  await removal
  expect(order).toEqual(['queued'])
  expect(idx.byId.has('srv1')).toBe(false) // the removal applied, after the adoption settled
})


test('emptying a store is an ordinary save, not a deletion', async () => {
  // round-12: physical deletion is what made emptying dangerous — the delete landed later than
  // the classification that authorized it, and could race a concurrent rename into destroying a
  // live record. an empty store is now just state, written through the same path as any other
  const { idx, calls, controller } = harness()
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 1 } }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  controller.save('n', {})
  await flush()
  expect(calls.filter(c => c.op == 'delete')).toHaveLength(0) // nothing is deleted, ever
  const update = calls.find(c => c.op == 'update')!
  expect(itemOf(update.text)).toEqual({}) // the empty state is persisted as state
  expect(idx.byName.get('n')!.item).toEqual({}) // and the record survives
})

test('the controller exposes no deletion surface at all', () => {
  // the whole tombstone/drain/born apparatus existed to make client-side destructive writes safe.
  // with deletion gone, so is the apparatus — this pins that it does not creep back
  const { controller } = harness()
  for (const gone of ['deleteName', 'deleteRecord', 'isDeleting', 'deleteDiscovered'])
    expect((controller as any)[gone]).toBeUndefined()
})


test('two writes of identical state have distinct echo identities (multiplicity preserved)', async () => {
  // round-14 finding 5: matching echoes by PLAINTEXT collapsed two identical writes to one
  // entry, so the first echo consumed it and the second applied as remote state. every
  // encryption uses a fresh random IV, so the outbound ciphertext is unique per write
  let n = 0
  const { idx, calls, controller } = harness({
    encryptState: async state => {
      const encrypted: any = state
      encrypted.cipher = `cipher${++n}:` + state.text // a distinct cipher per write, as in production
      encrypted.text = null
      encrypted.attr = null
      return encrypted
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: {} }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  controller.save('n', { same: true })
  await flush()
  controller.save('n', { same: true }) // identical STATE, second write
  await flush()
  const ciphers = calls.filter(c => c.op == 'update').map(c => c.text!)
  expect(ciphers).toHaveLength(2)
  expect(new Set(ciphers).size).toBe(2) // two identities, not one
  // each echo consumes exactly its own entry; neither is mistaken for a remote change
  expect(controller.isOwnEcho('d1', ciphers[0])).toBe(true)
  expect(controller.isOwnEcho('d1', ciphers[1])).toBe(true)
  expect(controller.isOwnEcho('d1', ciphers[0])).toBe(false) // consumed: a redelivery is not ours
})

test('a failed write releases only its own echo identity', async () => {
  let n = 0
  const failures = new Set<string>()
  const { idx, calls, controller } = harness({
    encryptState: async state => {
      const encrypted: any = state
      encrypted.cipher = `cipher${++n}:` + state.text
      encrypted.text = null
      encrypted.attr = null
      return encrypted
    },
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher })
      if (failures.has(data.cipher)) throw new Error('unavailable')
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: {} }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  failures.add('cipher1:' + JSON.stringify({ name: 'n', item: { same: true } }))
  controller.save('n', { same: true })
  await flush()
  controller.save('n', { same: true })
  await flush()
  const ciphers = calls.filter(c => c.op == 'update').map(c => c.text!)
  // the FAILED write's identity is released; the live one survives (plaintext matching deleted
  // the single shared entry and erased the live write's identity with it)
  expect(controller.isOwnEcho('d1', ciphers[0])).toBe(false)
  expect(controller.isOwnEcho('d1', ciphers[1])).toBe(true)
})

test('readonly mode mutates the index but never writes', async () => {
  const { idx, calls, controller } = harness({ readonly: () => true })
  controller.save('n', { v: 1 })
  await flush()
  expect(idx.byName.get('n')!.item).toEqual({ v: 1 })
  controller.save('n', {}) // emptying is an ordinary save now, and is equally suppressed
  await flush()
  expect(calls).toEqual([])
})
