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
  const idx: HiddenIndex = { byId: new Map(), byName: new Map(), quarantined: new Set<string>() }
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
    // required in production (correctness depends on them); harnesses that do not exercise the
    // prompt, the owner or the failure surface supply no-ops, and the tests that DO exercise
    // them override here rather than relying on an optional hook being absent
    acquireSecret: async () => {},
    reconcileOwner: () => {},
    notifyFailure: () => {},
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
  // mirrors the production lifecycle exactly (see the items listener): note the receipt, apply
  // on the affected name chains, and release the token only if the application SUCCEEDED
  const token = controller.noteRemote(wrapper, wrapper.id, false)
  const names = [idx.byId.get(wrapper.id)?.name, wrapper.name]
  return controller
    .applyRemote(names, () => applyRemoteAdded(idx, wrapper))
    .then(() => controller.releaseRemote(wrapper.id, token))
}

function arriveRemoval(controller: any, idx: HiddenIndex, id: string) {
  const token = controller.noteRemote(undefined, id, true)
  return controller
    .applyRemote([controller.nameForDocument(id)], () => removeHidden(idx, id))
    .then(() => controller.releaseRemote(id, token))
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
  const created = calls.find(c => c.op == 'create')!
  expect(idx.byName.get('n')!.id).toBe(created.id) // re-keyed to the created document
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
  // ONE write, by the generation that is still current. this test previously asserted two: the
  // superseded generation resumed after its confirmation await and issued as well. round 19
  // finding 2 is exactly that — the generation must be rechecked after every persistCreate await,
  // so obsolete work neither writes nor finalizes. what the test is really for is unchanged: the
  // write that DOES go out carries the adoption merge, since payloads serialize at execution
  expect(updates).toHaveLength(1)
  expect(itemOf(updates[0].text)).toEqual({ theirs: 1, mine: 2 })
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

test('a save whose target vanishes is written to whatever holds the name instead', async () => {
  // round-17 finding 3: the intent belongs to the NAME. when the write's target turns out to be
  // gone, the state is persisted to the record that holds the name now — previously the recovery
  // inspected the wrapper the write started from, so a replacement (or a removal) dropped the
  // user's change entirely
  const inFlight = deferred<void>()
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      if (id == 'd1') {
        await inFlight.promise
        const e: any = new Error('missing')
        e.code = 'not-found'
        throw e
      }
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 0 } }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  controller.save('n', { v: 1 })
  await flush() // write to d1 in flight
  // a remote replacement lands and the server deletes the old document
  const replacement: HiddenWrapper = { id: 'd9', name: 'n', item: { remote: true } }
  idx.byId.delete('d1')
  idx.byId.set('d9', replacement)
  idx.byName.set('n', replacement)
  inFlight.resolve()
  await flush()
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0) // no duplicate document
  const update = calls.find(c => c.op == 'update' && c.id == 'd9')
  expect(update, 'the intent followed the name to its current holder').toBeTruthy()
  // ... and MERGES under itself: this record was never written by this intent, so it may hold
  // fields the owner never saw (here the replacement's own state). overwriting them would be
  // the fresh-clone loss again
  expect(itemOf(update!.text)).toEqual({ v: 1, remote: true })
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
  // the mirror clears when the task it belongs to settles, not when the chain finally drains
  expect(first.saving).toBeNull()
  expect(fresh.saving ?? null).toBeNull()
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


test('a remote change applied after our write is issued does not leave the client behind', async () => {
  // round-15 finding 2: B is received while our save C holds the name chain in encryption, so
  // B's application queues BEHIND C. C is issued, the chain releases, B applies — and the client
  // sits at B while the server ends at C. skipping C's own echo (the old ciphertext rule) left
  // nothing to correct it; applying it does, because firestore delivers a document's changes in
  // commit order, so the echo IS the newest server state
  const encrypting = deferred<void>()
  const { idx, calls, controller } = harness({
    encryptState: async state => {
      await encrypting.promise
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 'A' } }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  controller.save('n', { v: 'C' })
  await flush() // the save task is running, held in encryption; the name chain is occupied
  const applyingB = arrive(controller, idx, { id: 'd1', name: 'n', item: { v: 'B' } }) // queues behind
  encrypting.resolve()
  await flush()
  await applyingB
  // round-20 finding 1 changed the ORDER here, and the change is an improvement: the receipt for B
  // makes our target move mid-build, so the attempt is requeued BEHIND B's application instead of
  // rebuilding while holding the chain. our write therefore lands after B applies, and the record
  // carries C rather than sitting at B. this test previously asserted the intermediate { v: 'B' }
  expect(idx.byId.get('d1')!.item).toEqual({ v: 'C' })
  const update = calls.find(c => c.op == 'update')!
  expect(update.id).toBe('d1')
  expect(itemOf(update.text)).toEqual({ v: 'C' }) // the server has C
  // C's own delivery now arrives. hidden deliveries are never skipped (see isOwnPendingChange
  // in index.svelte), so it applies and the client catches up to the server
  await arrive(controller, idx, { id: 'd1', name: 'n', item: { v: 'C' } })
  expect(idx.byId.get('d1')!.item).toEqual({ v: 'C' }) // client and server agree again
})

test('a survivor received during the final encryption is adopted, not duplicated', async () => {
  // round-15 finding 3: findSurvivor ran once, then the fresh-create branch awaited ANOTHER
  // encryption. a same-name record received in that window was already known locally, yet the
  // create issued anyway — a duplicate we caused ourselves
  let encryptions = 0
  const second = deferred<void>()
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    encryptState: async state => {
      // the create's ONLY encryption before the late-survivor check (round 19 deleted the
      // preliminary one, whose sole purpose was to trigger the phrase prompt that acquireSecret
      // now owns), so holding the first opens the window the survivor arrives in
      if (++encryptions == 1) await second.promise
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
  })
  controller.save('n', { mine: 1 })
  await flush()
  // the survivor arrives while that last encryption is held
  void arrive(controller, idx, { id: 'srv1', name: 'n', item: { theirs: 1 } })
  second.resolve()
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0) // no duplicate document
  const update = calls.find(c => c.op == 'update')!
  expect(update.id).toBe('srv1') // adopted instead
  expect(itemOf(update.text)).toEqual({ theirs: 1, mine: 1 })
})

test('an adopted write rejected as not-found does not leave the wrapper on a vanished document', async () => {
  // round-15 finding 4: the adopted update's rejection was handled in a DETACHED catch, so
  // finalizeAdoption had already settled the wrapper onto an id the server says is gone — and
  // the merged state was never persisted anywhere
  let updates = 0
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmIndex: async name => {
      // the same merge production passes (mergeAdoptedStore): pending changes win
      if (updates == 0)
        registerHidden(idx, { id: 'gone1', name, item: { theirs: 1 } }, (pending, found) =>
          Object.assign(pending.item, { ...found.item, ...pending.item })
        )
    },
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
      if (++updates == 1) {
        const e: any = new Error('missing')
        e.code = 'not-found'
        throw e
      }
    },
  })
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 4; i++) await flush() // adoption, its rejection, recovery, then the create
  // the create is re-entered for the name rather than left settled on the vanished document
  expect(calls.filter(c => c.op == 'invalidate')).not.toHaveLength(0) // authority revoked
  const created = calls.find(c => c.op == 'create')
  expect(created).toBeTruthy() // the state reached a real document
  expect(itemOf(created!.text)).toEqual({ theirs: 1, mine: 1 }) // ... carrying the merged state
  expect(idx.byName.get('n')!.id).toBe(created!.id)
})

test('a save overtaken by a remote replacement follows the NAME instead of being dropped', async () => {
  // round-16 finding 3: the queued save held the wrapper it was created for and dropped itself
  // if that wrapper had been replaced meanwhile — silently losing the newest thing the user did.
  // the intent belongs to the name, so it is written to whatever record currently holds it
  const encrypting = deferred<void>()
  const { idx, calls, controller } = harness({
    encryptState: async state => {
      await encrypting.promise
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
  })
  const original: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 0 } }
  idx.byId.set('d1', original)
  idx.byName.set('n', original)
  controller.save('n', { v: 'mine' })
  await flush() // held in encryption
  // a remote delivery replaces the record holding this name (a different document even)
  const replacement: HiddenWrapper = { id: 'd2', name: 'n', item: { v: 'theirs' } }
  idx.byId.delete('d1')
  idx.byId.set('d2', replacement)
  idx.byName.set('n', replacement)
  encrypting.resolve()
  await flush()
  const update = calls.find(c => c.op == 'update')!
  expect(update.id).toBe('d2') // re-resolved onto the current holder ...
  expect(itemOf(update.text)).toEqual({ v: 'mine' }) // ... carrying the user's intent
  expect(idx.byName.get('n')!.item).toEqual({ v: 'mine' })
})

test('a received lower-id record is written to, not stranded on the one that is applied', async () => {
  // round-18 finding 2: canonicalHolder scanned only APPLIED records, so a lower-id document
  // whose delivery was still queued was invisible. the write went to the higher-id record, the
  // lower-id one then became canonical, and the user's state was stranded on a noncanonical
  // document. delivered through arrive(), which is how production queues it
  const encrypting = deferred<void>()
  const { idx, calls, controller } = harness({
    encryptState: async state => {
      await encrypting.promise
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
  })
  const high: HiddenWrapper = { id: 'z9', name: 'n', item: { v: 'A' } }
  idx.byId.set('z9', high)
  idx.byName.set('n', high)
  controller.save('n', { v: 'D' })
  await flush() // held in encryption, holding the name's chain
  void arrive(controller, idx, { id: 'a1', name: 'n', item: { v: 'B' } }) // lower id, queued behind
  encrypting.resolve()
  await flush()
  await flush()
  const update = calls.find(c => c.op == 'update')!
  expect(update.id, 'the write targets the lower-id record that is about to be canonical').toBe('a1')
  expect(itemOf(update.text)).toMatchObject({ v: 'D' })
})

test('a stale not-found rejection cannot resurrect the state it carried', async () => {
  // round-18 finding 3: the detached rejection installed a new owed record containing ITS state,
  // with no generation check — so an older write's failure replaced a newer save that was still
  // building, and the newer state was never written
  const first = deferred<void>()
  const { idx, calls, controller } = harness({
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
      if (calls.filter(c => c.op == 'update').length == 1) {
        await first.promise
        const e: any = new Error('missing')
        e.code = 'not-found'
        throw e
      }
    },
  })
  const wrapper: HiddenWrapper = { id: 'd1', name: 'n', item: {} }
  idx.byId.set('d1', wrapper)
  idx.byName.set('n', wrapper)
  controller.save('n', { v: 'C' })
  await flush() // C issued, its rejection still pending
  controller.save('n', { v: 'D' }) // newer generation
  await flush()
  first.resolve() // C now fails, carrying its own older state
  await flush()
  await flush()
  const written = calls.filter(c => c.op == 'update' || c.op == 'create')
  expect(itemOf(written.at(-1)!.text), 'the newest state survives the older rejection').toMatchObject({ v: 'D' })
})

test('a build that fails is retried by the next save, not left idle forever', async () => {
  // round-18 finding 4: a failed build left the record with no task and no running flag, and the
  // next save read it as "already queued" and returned — so the work sat idle for the page's life
  let failConfirm = true
  const { calls, controller } = harness({
    confirmIndex: async () => {
      calls.push({ op: 'confirm' })
      if (failConfirm) throw new Error('server unavailable')
    },
  })
  controller.save('n', { v: 1 })
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0) // the create failed
  failConfirm = false
  controller.save('n', { v: 2 }) // the literal next save
  await flush()
  await flush()
  const created = calls.find(c => c.op == 'create')
  expect(created, 'the retry actually happened').toBeTruthy()
  expect(itemOf(created!.text)).toMatchObject({ v: 2 })
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

test('a failed application keeps its receipt, so the next create still sees the record', async () => {
  // round-17 finding 2: production chained `.then(success, error).then(release)`, and the error
  // handler returns normally — so a FAILED application released the receipt anyway. the index is
  // then stale AND survivor selection has forgotten the record, which is how a duplicate create
  // happens. application can fail on arbitrary item code (it reaches onFocus and owner listeners)
  const { idx, calls, controller } = harness()
  controller.noteRemote({ id: 'srv1', name: 'n', item: { theirs: 1 } }, 'srv1', false)
  await controller
    .applyRemote(['n'], () => {
      throw new Error('item code threw during application')
    })
    .catch(() => {}) // production logs this; the receipt must NOT be released
  controller.save('n', { mine: 1 })
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0) // no duplicate
  const holder = idx.byName.get('n')!
  expect(holder.adopt_id ?? holder.id).toBe('srv1') // the remembered record was adopted
})

test('a stale receipt token cannot release a newer receipt', async () => {
  // receipts carry a token so an older application settling cannot discard a newer receipt that
  // a pending create still needs to see
  const { idx, calls, controller } = harness()
  const stale = controller.noteRemote({ id: 'srv1', name: 'n', item: { v: 1 } }, 'srv1', false)
  // the SAME document: releasing srv2 with srv1's token proves only that ids differ
  const current = controller.noteRemote({ id: 'srv1', name: 'n', item: { v: 2 } }, 'srv1', false)
  expect(current).not.toBe(stale)
  controller.releaseRemote('srv1', stale) // stale token for THIS document: ignored
  // the newer receipt still steers the create to adopt rather than duplicate
  controller.save('n', { mine: 1 })
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0)
  const holder = idx.byName.get('n')!
  expect(holder.adopt_id ?? holder.id).toBe('srv1') // minimum id among the received records
})

test('a receipt arriving during the REBUILD retargets again, instead of stranding the write', async () => {
  // round-19 finding 1: the code resolved once, rebuilt once, then issued WITHOUT resolving
  // again. a second lower-id record received during that rebuild left the write on the middle
  // record while the newly canonical one kept the stale state
  const pending: Array<() => void> = []
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    encryptState: async state => {
      await new Promise<void>(resolve => pending.push(resolve))
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
  })
  const start: HiddenWrapper = { id: 'z9', name: 'n', item: { A: 1 } }
  idx.byId.set('z9', start)
  idx.byName.set('n', start)
  controller.save('n', { D: 1 })
  await flush() // building for z9, first encryption held
  void arrive(controller, idx, { id: 'b2', name: 'n', item: { B: 1 } })
  pending.shift()!() // released: re-resolves to b2 and rebuilds for it
  await flush()
  void arrive(controller, idx, { id: 'a1', name: 'n', item: { A1: 1 } }) // still lower, mid-rebuild
  pending.shift()!()
  await flush()
  pending.shift()?.() // the rebuild for a1
  await flush()
  const updates = calls.filter(c => c.op == 'update')
  expect(updates).toHaveLength(1)
  expect(updates[0].id).toBe('a1') // the record canonical NOW, not the middle one
  expect(itemOf(updates[0].text).D).toBe(1)
})

test('a holder removed during its encryption is not updated', async () => {
  // round-19 finding 1: `canonicalHolder()` returns undefined when the selected holder is
  // removed mid-build, and the truthy-only recheck fell through and updated the removed id.
  // durability then depended on a later NOT_FOUND callback and the tab living long enough
  const pending: Array<() => void> = []
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    encryptState: async state => {
      await new Promise<void>(resolve => pending.push(resolve))
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
  })
  const start: HiddenWrapper = { id: 'z9', name: 'n', item: { A: 1 } }
  idx.byId.set('z9', start)
  idx.byName.set('n', start)
  controller.save('n', { D: 1 })
  await flush()
  void arriveRemoval(controller, idx, 'z9')
  pending.shift()!()
  await flush()
  pending.shift()?.() // the create the loop re-entered
  await flush()
  expect(calls.filter(c => c.op == 'update')).toHaveLength(0) // never the removed document
  expect(calls.filter(c => c.op == 'create')).toHaveLength(1) // re-entered create resolution
})

test('a superseded generation neither issues its create nor finalizes the wrapper', async () => {
  // round-19 finding 2: generation checks gated the detached CALLBACKS only. stale work still
  // called createDoc and still finalized the index transition, so an obsolete create could land
  // after the newer state had been written
  const pending: Array<() => void> = []
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    encryptState: async state => {
      await new Promise<void>(resolve => pending.push(resolve))
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
  })
  controller.save('n', { C: 1 })
  await flush() // the create's encryption is held
  expect(pending).toHaveLength(1)
  controller.save('n', { D: 1 }) // supersedes it
  pending.shift()!() // release the stale generation
  await flush()
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0) // it must not write
  pending.shift()!() // the current generation's create
  await flush()
  const creates = calls.filter(c => c.op == 'create')
  expect(creates).toHaveLength(1)
  expect(itemOf(creates[0].text)).toEqual({ D: 1 })
  expect(idx.byName.get('n')!.id).toBe(creates[0].id) // finalized once, by the generation that wrote
})

test('settlement reconciles the owner behind an already-received transition, not ahead of it', async () => {
  // round-19 finding 3: settlement ran straight off the acknowledgement, outside the name chain.
  // reconciliation reads the APPLIED index, so an ack that beat a queued application put the
  // owner back in step with state that delivery was about to replace, then cleared owes()
  const order: string[] = []
  const pending: Array<() => void> = []
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    encryptState: async state => {
      await new Promise<void>(resolve => pending.push(resolve))
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
    reconcileOwner: name => void order.push('reconcile ' + name),
  })
  const live: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 0 } }
  idx.byId.set('d1', live)
  idx.byName.set('n', live)
  controller.save('n', { v: 1 })
  await flush() // building: the chain is busy, so an arrival now QUEUES behind it
  const remote: HiddenWrapper = { id: 'd2', name: 'n', item: { remote: 1 } } // higher id: no retarget
  const token = controller.noteRemote(remote, 'd2', false)
  const arrival = controller
    .applyRemote(['n'], () => {
      order.push('remote applied')
      applyRemoteAdded(idx, remote)
    })
    .then(() => controller.releaseRemote('d2', token))
  pending.shift()!()
  await flush()
  await arrival
  await flush()
  expect(calls.filter(c => c.op == 'update').map(c => c.id)).toEqual(['d1'])
  expect(order).toEqual(['remote applied', 'reconcile n'])
  expect(controller.owes('n')).toBe(false) // cleared only once settlement ran on the chain
})

test('a terminal write failure is reported to the failure hook and stays retryable', async () => {
  // round-19 finding 3: the `failed` phase was private. owes() is a boolean and wrapper.saving
  // has already settled, so a settled permission error left owner notifications suppressed with
  // nothing but a console line to show for it
  const failures: string[] = []
  const h = harness()
  const { idx } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    updateDoc: async () => {
      throw Object.assign(new Error('permission denied'), { code: 'permission-denied' })
    },
    notifyFailure: (name, error) => void failures.push(`${name}: ${(error as Error).message}`),
  })
  const live: HiddenWrapper = { id: 'd1', name: 'n', item: {} }
  idx.byId.set('d1', live)
  idx.byName.set('n', live)
  controller.save('n', { v: 1 })
  await flush()
  expect(failures).toEqual(['n: permission denied'])
  expect(controller.owes('n')).toBe(true) // retained, and a later save retries it
})

test('the secret is acquired before any payload is encrypted', async () => {
  // round-19 finding 4: encryption must not prompt, which only holds if acquisition completes
  // first. the loop that re-resolves the target depends on it — a prompt inside the loop could
  // register a lower-id record between the last resolution and the write
  const order: string[] = []
  const secret = deferred<void>()
  const h = harness()
  const { idx } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    acquireSecret: async () => {
      order.push('acquire')
      await secret.promise
    },
    encryptState: async state => {
      order.push('encrypt')
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
  })
  const live: HiddenWrapper = { id: 'd1', name: 'n', item: {} }
  idx.byId.set('d1', live)
  idx.byName.set('n', live)
  controller.save('n', { v: 1 })
  await flush()
  expect(order).toEqual(['acquire']) // nothing encrypted while the phrase is outstanding
  secret.resolve()
  await flush()
  expect(order).toEqual(['acquire', 'encrypt'])
})

// a gated encryption that records each call, so a schedule can release them one at a time
function gatedHarness() {
  const pending: Array<() => void> = []
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    encryptState: async state => {
      await new Promise<void>(resolve => pending.push(resolve))
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
  })
  const drain = async (times: number) => {
    for (let i = 0; i < times; i++) {
      pending.shift()?.()
      await flush()
    }
  }
  return { ...h, controller, pending, drain }
}

test('a lower id arriving during an ADOPTION encryption retargets, instead of writing the middle record', async () => {
  // round-20 finding 1: only the ordinary update branch looped. create and adoption issued after
  // an unchecked encryption, so this schedule wrote `update b2` while canonical state became a1
  const { idx, calls, controller, pending, drain } = gatedHarness()
  controller.save('n', { D: 1 })
  await flush() // fresh create, its encryption held
  expect(pending).toHaveLength(1)
  void arrive(controller, idx, { id: 'b2', name: 'n', item: { B: 1 } })
  await drain(1) // b2 applies, the attempt requeues, and the retry adopts b2
  void arrive(controller, idx, { id: 'a1', name: 'n', item: { A1: 1 } }) // still lower, mid-encryption
  await drain(3)
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0) // never a duplicate document
  const updates = calls.filter(c => c.op == 'update')
  expect(updates.map(u => u.id)).toEqual(['a1']) // the record canonical NOW, never the middle one
  expect(itemOf(updates[0].text).D).toBe(1) // carrying the local state
})

test('a record removed during an adoption encryption is not written', async () => {
  // the same recheck covers disappearance: the adoption target moving out from under the write
  // must abandon the attempt rather than update an id the controller already knows moved
  const { idx, calls, controller, drain } = gatedHarness()
  controller.save('n', { D: 1 })
  await flush()
  void arrive(controller, idx, { id: 'b2', name: 'n', item: { B: 1 } })
  await drain(1) // adopting b2, its encryption held
  void arrive(controller, idx, { id: 'a1', name: 'n', item: { A1: 1 } })
  await drain(3)
  expect(calls.filter(c => c.op == 'update').map(u => u.id)).not.toContain('b2')
})

test('a terminal BUILD failure is reported, not only a terminal write failure', async () => {
  // round-20 finding 3: notifyFailure covered the asynchronous write rejection only. a rejecting
  // confirmIndex produced no write, left owes() true, cleared the saving mirror and suppressed
  // owner notifications indefinitely — with nothing but a console line to show for it
  const failures: string[] = []
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmIndex: async () => {
      throw new Error('index unavailable')
    },
    notifyFailure: (name, error) => void failures.push(`${name}: ${(error as Error).message}`),
  })
  controller.save('n', { v: 1 })
  await flush()
  expect(failures).toEqual(['n: index unavailable'])
  expect(controller.owes('n')).toBe(true) // retained and retryable
})

test('a cancelled phrase prompt is not reported as a failure', async () => {
  // dismissing the prompt is an expected outcome, not something to alert the user about
  const failures: string[] = []
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    acquireSecret: async () => {
      throw Object.assign(new Error('cancelled by user'), { cancelled: true })
    },
    notifyFailure: (name, error) => void failures.push(`${name}: ${(error as Error).message}`),
  })
  controller.save('n', { v: 1 })
  await flush()
  expect(failures).toEqual([])
  expect(controller.owes('n')).toBe(true) // still owed, so a later save retries it
})

test('settlement follows the write dependency, so an ack behind the frontier reconciles from the echo', async () => {
  // round-20 finding 2: settlement waited behind transitions already noted, but production does not
  // note a transition until its snapshot is decrypted. a fast ack therefore crossed the app's own
  // echo, reconciled the owner from the state that echo was about to replace, and cleared owes() —
  // so the echo then arrived as a spurious "changed remotely". the fix is in the write dependency,
  // which now awaits the application frontier before resolving (see snapshotFrontier in
  // index.svelte); this pins the controller half of that contract
  const reconciled: any[] = []
  const ack = deferred<void>()
  const pending: Array<() => void> = []
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    encryptState: async state => {
      await new Promise<void>(resolve => pending.push(resolve))
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
    updateDoc: async (id, data) => {
      calls.push({ op: 'update', id, text: data.cipher ?? data.text })
      await ack.promise // production awaits the snapshot frontier at exactly this point
    },
    reconcileOwner: name => void reconciled.push(idx.byName.get(name)?.item),
  })
  const live: HiddenWrapper = { id: 'z9', name: 'n', item: { v: 'A' } }
  idx.byId.set('z9', live)
  idx.byName.set('n', live)
  controller.save('n', { v: 'D' })
  await flush()
  void arrive(controller, idx, { id: 'a1', name: 'n', item: { v: 'B' } }) // lower id: the target moves
  pending.shift()!()
  await flush() // requeued behind a1's application
  pending.shift()?.()
  await flush() // rebuilt for a1 and issued
  expect(calls.filter(c => c.op == 'update').map(c => c.id)).toEqual(['a1'])
  expect(controller.owes('n')).toBe(true) // unsettled while the acknowledgement is outstanding
  await arrive(controller, idx, { id: 'a1', name: 'n', item: { v: 'D' } }) // our own echo, applied
  ack.resolve()
  await flush()
  expect(reconciled).toEqual([{ v: 'D' }]) // in step with the echo, never rolled back to B
  expect(controller.owes('n')).toBe(false)
})
