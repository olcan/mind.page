import { expect, test } from '@playwright/test'
import { createHiddenPersistence, type HiddenPersistenceDeps } from '../../src/hidden_persistence.js'
import { createHiddenIngress } from '../../src/hidden_ingress.js'
import { planTargetSlice, type Marker } from '../../src/hidden_confirm.js'
import {
  applyRemoteAdded,
  applyRemoteModified,
  invalidateAdopters,
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

// ONE macrotask, which drains every recursively queued microtask first — so a settled chain has
// fully propagated without coupling the assertion to a guessed number of hops. used for negative
// assertions; positive progress awaits the real deferred (see hidden_ingress.spec.ts, round 44)
const checkpoint = () => new Promise<void>(res => setImmediate(res))

type Call = { op: string; id?: string; text?: string }

function harness(overrides: Partial<HiddenPersistenceDeps> = {}) {
  const idx: HiddenIndex = { byId: new Map(), byName: new Map(), quarantined: new Set<string>() }
  const ingress = createHiddenIngress()
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
    // the REAL coordinator waiter: the harness's arrivals open deliveries with 'cipher:<id>', and
    // the writer's payloads carry 'cipher:<text>' — so an echo matches only when a delivery for
    // that exact ciphertext actually arrives, which is the point
    armEcho: (id, cipher) => ingress.armEcho(id, cipher),
    // the DEFAULT models "the server has exactly what the applied index has", so the plan is a
    // no-op and confirmation is behaviour-preserving for schedules that do not exercise it. a
    // test that cares supplies its own answer
    confirmTarget: async (name, hooks) => {
      calls.push({ op: 'confirm' })
      const answer = new Map(
        [...idx.byId.values()]
          .filter(w => !w.pending_create && !w.adopt_id)
          .map(w => [w.id, { id: w.id, kind: 'hidden' as const, name: w.name, wrapper: w, eligible: true }])
      )
      if (ingress.gate() != 'writable') return { kind: 'inconclusive' as const }
      return hooks.commit(answer, hooks.captureReadMarker())
    },
    registerTargetRow: (wrapper, mergeAdoptedFor) => void registerHidden(idx, wrapper, mergeAdoptedFor),
    adopt: (pending, found) => Object.assign(pending.item, { ...found.item, ...pending.item }),
    syncOwner: () => {}, // owner publication is index.svelte's side; schedules assert via calls
    invalidateAuthority: reason => void calls.push({ op: 'invalidate', id: reason }),
    newTempId: () => 'temp' + ++ids,
    readonly: () => false,
    // OFF by default: most schedules are ordinary pages. the fixed-page rows turn it on
    confirmsUpdates: false,
    // A REAL COORDINATOR, exactly as production wires it: the writer's staleness, refusal and
    // requeue decisions read this gate and frontier, so the arrival helpers below open real
    // deliveries rather than driving a fake predicate
    gate: () => ingress.gate(),
    receiptFrontier: id => ingress.receiptFrontier(id),
    whenActionable: () => ingress.whenActionable(),
    whenWritable: () => ingress.whenWritable(),
    ...overrides,
  }
  return { idx, calls, deps, ingress, controller: createHiddenPersistence(deps) }
}

// mimics the items listener for one remote hidden record. there is NO receipt any more: a
// delivery is visible to the writer through the coordinator's GATE, which stays non-writable from
// open() until the application settles — the same fact the receipt overlay used to duplicate.
// tests must arrive through these helpers, never by calling a reducer directly: a direct call
// manufactures an ordering production prevents.
// `ingress` is required for any schedule that exercises writer staleness; without it the gate
// never closes and the writer cannot see the delivery at all
// `cipher` matters only for an ECHO: the writer arms a waiter for the exact ciphertext it wrote,
// so a delivery standing in for our own echo must carry that same string. any other arrival can
// use the default, which deliberately matches nothing a writer armed
function arrive(controller: any, idx: HiddenIndex, wrapper: HiddenWrapper, ingress?: any, cipher?: string) {
  const handle = ingress?.open(wrapper.id, cipher ?? 'cipher:' + wrapper.id)
  const names = [idx.byId.get(wrapper.id)?.name, wrapper.name]
  const apply = () => controller.applyRemote(names, () => void applyRemoteAdded(idx, wrapper))
  if (!handle) return apply()
  handle.ready(apply)
  return handle.done
}

function arriveModified(controller: any, idx: HiddenIndex, wrapper: HiddenWrapper, ingress?: any) {
  const handle = ingress?.open(wrapper.id, 'cipher:' + wrapper.id)
  const names = [idx.byId.get(wrapper.id)?.name, wrapper.name]
  const apply = () => controller.applyRemote(names, () => void applyRemoteModified(idx, wrapper))
  if (!handle) return apply()
  handle.ready(apply)
  return handle.done
}

function arriveRemoval(controller: any, idx: HiddenIndex, id: string, ingress?: any) {
  const handle = ingress?.open(id) // a removal carries no ciphertext
  const apply = () => controller.applyRemote([controller.nameForDocument(id)], () => void removeHidden(idx, id))
  if (!handle) return apply()
  handle.ready(apply)
  return handle.done
}

// a confirmTarget whose answer is exactly these server rows. the old confirmIndex overrides
// expressed the same thing by calling registerHidden directly; now the answer goes through the
// plan, which is what makes slice replacement and the marker rules apply
function serverAnswer(rows: { id: string; name: string; item?: any }[], calls?: Call[], gate?: () => string) {
  return async (_name: string, hooks: any) => {
    calls?.push({ op: 'confirm' })
    // BOTH GATE CHECKS live in the adapter in production (see the confirmTarget dep): one after
    // the corpus predecessor, one immediately before the synchronous commit. a harness that skips
    // them commits behind a shut gate and cannot exercise the inconclusive path at all
    if (gate && gate() != 'writable') return { kind: 'inconclusive' as const }
    const answer = new Map(
      rows.map(r => [r.id, { id: r.id, kind: 'hidden' as const, name: r.name, wrapper: r, eligible: true }])
    )
    if (gate && gate() != 'writable') return { kind: 'inconclusive' as const }
    return hooks.commit(answer, hooks.captureReadMarker()) // VERBATIM, as production does
  }
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
    // the server read finds a surviving same-name document (e.g. a duplicate another client
    // kept): the plan registers it, adopting the recovering (pending) wrapper
    confirmTarget: (name, hooks) => serverAnswer([{ id: 'srv7', name: 'n', item: { theirs: 1 } }], calls)(name, hooks),
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
    confirmTarget: async () => {
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
    // the server confirmation finds an existing document, adopting the pending wrapper
    confirmTarget: serverAnswer([{ id: 'srv1', name: 'n', item: { theirs: 1 } }]),
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
    confirmTarget: serverAnswer([{ id: 'srv1', name: 'n', item: {} }]),
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
    confirmTarget: async (_name, hooks) => {
      calls.push({ op: 'confirm' })
      await confirm.promise // hold the create in confirmation while the second save queues
      return hooks.commit(new Map(), hooks.captureReadMarker())
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
    confirmTarget: async (_name, hooks) => {
      await confirm.promise
      return serverAnswer([{ id: 'srv1', name: 'n', item: { theirs: 1 } }])(_name, hooks)
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
    // authoritative, and the read finds NOTHING for the name: the slice is replaced with nothing
    confirmTarget: (name, hooks) => serverAnswer([], calls)(name, hooks),
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
  await controller.applyRemote(['n'], () => void order.push('remote'))
  expect(order).toEqual(['remote']) // applied without waiting for the acknowledgement
  ack.resolve()
})
test('saving belongs to the NAME: a wrapper replaced mid-write does not disturb it', async () => {
  // saving used to live on the wrapper, so a replacement mid-write meant the object the owner
  // reads had no saving state while a write for its name was in flight. it is DERIVED per name
  // now (rounds 60-61), so a replacement is simply irrelevant to it
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
  controller.save('n', { v: 1 })
  expect(controller.isSaving('n'), 'saving from the moment save() accepts').toBe(true)
  // the record is replaced remotely while that write is in flight
  const replacement: HiddenWrapper = { id: 'd1', name: 'n', item: { remote: true } }
  idx.byId.set('d1', replacement)
  idx.byName.set('n', replacement)
  controller.save('n', { v: 2 })
  expect(controller.isSaving('n'), 'still saving across the replacement').toBe(true)
  gated = false
  gate.resolve()
  for (let i = 0; i < 6; i++) await flush()
  expect(controller.isSaving('n'), 'and false once the last write is issued').toBe(false)
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
  await controller.applyRemote(['old', 'new'], () => void order.push('rename applied'))
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
    confirmTarget: serverAnswer([{ id: 'srv1', name: 'n', item: {} }]),
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
  const { idx, calls, controller, ingress } = harness({
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
  const applyingB = arrive(controller, idx, { id: 'd1', name: 'n', item: { v: 'B' } }, ingress) // queues behind
  encrypting.resolve()
  await applyingB
  for (let i = 0; i < 8; i++) await flush()
  // round-20 finding 1 changed the ORDER here, and the change is an improvement: the GATE closes
  // while B is outstanding, so the attempt is requeued BEHIND B's application instead of
  // rebuilding while holding the chain. our write therefore lands after B applies, and the record
  // carries C rather than sitting at B. this test previously asserted the intermediate { v: 'B' }
  expect(idx.byId.get('d1')!.item).toEqual({ v: 'C' })
  const update = calls.find(c => c.op == 'update')!
  expect(update.id).toBe('d1')
  expect(itemOf(update.text)).toEqual({ v: 'C' }) // the server has C
  // C's own delivery now arrives. hidden deliveries are never skipped (see isOwnPendingChange
  // in index.svelte), so it applies and the client catches up to the server
  await arrive(controller, idx, { id: 'd1', name: 'n', item: { v: 'C' } }, ingress)
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
  // the survivor arrives while that last encryption is held. MIGRATED off the receipt overlay
  // (round 71): the gate refuses the held attempt rather than the create seeing an unapplied
  // record, and the retry adopts. the outcome — no duplicate, one adopted update — is unchanged
  const delivery = arrive(controller, idx, { id: 'srv1', name: 'n', item: { theirs: 1 } }, h.ingress)
  second.resolve()
  await delivery
  for (let i = 0; i < 10; i++) await flush()
  expect(
    calls.filter(c => c.op == 'create'),
    'no duplicate document'
  ).toHaveLength(0)
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
    // the server read finds the survivor only on the FIRST confirmation
    confirmTarget: async (name, hooks) =>
      serverAnswer(updates == 0 ? [{ id: 'gone1', name, item: { theirs: 1 } }] : [])(name, hooks),
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
  // ... carrying the UNMERGED baseline. round 15 pinned the merged state here; round 35 changed
  // the contract deliberately: the adopted document is GONE from the server, invalidation left no
  // survivor, and resurrecting its state into a fresh document is exactly what adopter
  // invalidation exists to prevent — stale adopted defaults left visible would be legitimized as
  // new local intent by the next real save. the owner is republished the baseline for the same
  // reason (deps.syncOwner in the fresh-create reset)
  expect(itemOf(created!.text)).toEqual({ mine: 1 })
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
  // MIGRATED off the receipt overlay (round 71): the writer no longer SEES a received-but-
  // unapplied record — the coordinator's gate refuses it while the delivery is outstanding, and
  // the retry resolves from the applied index. the OUTCOME is what mattered and is unchanged:
  // exactly one write, to the lower-id record, carrying the user's state
  const encrypting = deferred<void>()
  const h = harness({
    encryptState: async state => {
      await encrypting.promise
      const encrypted: any = state
      encrypted.cipher = 'cipher:' + state.text
      encrypted.text = null
      return encrypted
    },
  })
  const { idx, calls, controller, ingress } = h
  const high: HiddenWrapper = { id: 'z9', name: 'n', item: { v: 'A' } }
  idx.byId.set('z9', high)
  idx.byName.set('n', high)
  controller.save('n', { v: 'D' })
  await flush() // held in encryption, holding the name's chain
  const delivery = arrive(controller, idx, { id: 'a1', name: 'n', item: { v: 'B' } }, ingress)
  encrypting.resolve()
  await delivery // the lower-id record is now APPLIED
  for (let i = 0; i < 8; i++) await flush()
  const updates = calls.filter(c => c.op == 'update')
  expect(updates, 'exactly one write, from the retry').toHaveLength(1)
  expect(updates[0].id, 'to the lower-id record that is now canonical').toBe('a1')
  expect(itemOf(updates[0].text)).toMatchObject({ v: 'D' })
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
    confirmTarget: async (_name, hooks) => {
      calls.push({ op: 'confirm' })
      if (failConfirm) throw new Error('server unavailable')
      return hooks.commit(new Map(), hooks.captureReadMarker())
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

test('readonly mode mutates the index but never writes — and never serializes', async () => {
  const failures: string[] = []
  const { idx, calls, controller } = harness({ readonly: () => true, notifyFailure: n => void failures.push(n) })
  controller.save('n', { v: 1 })
  await flush()
  expect(idx.byName.get('n')!.item).toEqual({ v: 1 })
  controller.save('n', {}) // emptying is an ordinary save now, and is equally suppressed
  await flush()
  // a read-only save NEVER serializes (round 38): a plain in-memory store holding non-JSON state
  // must not be rejected for a write that will never happen
  const cyclic: any = { bad: BigInt(1) }
  cyclic.self = cyclic
  expect(controller.save('n2', cyclic), 'accepted: nothing will be written').toBe(true)
  expect(idx.byName.get('n2')!.item, 'the index still updates').toBe(cyclic)
  expect(failures, 'no failure for a write that cannot happen').toEqual([])
  expect(calls).toEqual([])
})

test('a rejection whose applied fallback is raw read-only state publishes {} instead of throwing', async () => {
  // round 40: read-only mode indexes RAW non-JSON state, and production's readonly flag is
  // mutable — so a later writable rejection's fallback clone can itself throw, which would skip
  // syncOwner/notifyFailure/return-false and let the replacement error escape save()
  let readOnly = true
  const failures: unknown[] = []
  const published: any[] = []
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    readonly: () => readOnly,
    notifyFailure: (_name, e) => void failures.push(e),
    syncOwner: (_name, state) => void published.push(JSON.parse(JSON.stringify(state))),
  })
  const cyclic: any = { bad: BigInt(1) }
  cyclic.self = cyclic
  expect(controller.save('n', cyclic), 'raw state accepted while read-only').toBe(true)
  readOnly = false // the page becomes writable
  // ONE hoisted error object, asserted by IDENTITY: a fresh Error inside toJSON compared by
  // message would stay green if the controller replaced or wrapped it (round 41)
  const original = new Error('original rejection')
  const invalid = {
    toJSON: () => {
      throw original
    },
  }
  expect(controller.save('n', invalid as any), 'returns false rather than throwing').toBe(false)
  expect(failures, 'exactly one notification, with the ORIGINAL thrown object').toHaveLength(1)
  expect(failures[0], 'the same object, not a replacement').toBe(original)
  expect(published, 'exactly one rollback publication: {}').toEqual([{}])
  expect(idx.byName.get('n')!.item, 'the applied index still holds the exact raw object').toBe(cyclic)
  expect(controller.owes('n'), 'no owed generation').toBe(false)
  await flush()
  expect(
    calls.filter(c => c.op == 'create' || c.op == 'update'),
    'no SDK write'
  ).toHaveLength(0)
})

test('a FAILED application blocks the delivery, and the writer refuses rather than duplicating', async () => {
  // round-17 finding 2, migrated off receipts: a failed application used to release the receipt
  // anyway, leaving the index stale AND survivor selection blind — which is how a duplicate create
  // happens. the coordinator answers this structurally now: a rejected Apply is a BLOCKED
  // delivery, the global gate is blocked, and no writer resolution can reach an issue at all
  const { calls, controller, ingress } = harness()
  const handle = ingress.open('srv1', 'cipher:srv1')
  handle.ready(() =>
    controller.applyRemote(['n'], () => {
      throw new Error('item code threw during application')
    })
  )
  expect(await handle.done, 'the delivery is blocked').toBe('blocked')
  expect(ingress.gate(), 'and every writer is gated').toBe('blocked')
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 6; i++) await flush()
  expect(
    calls.filter(c => c.op == 'create'),
    'no duplicate: the writer never resolved'
  ).toHaveLength(0)
  expect(controller.owes('n'), 'the intent is retained for after healing').toBe(true)
})

// NOTE the receipt-token mechanism rows that stood here are DELETED with the API. "a stale token
// cannot release a newer receipt" and "a receipt arriving during the REBUILD retargets" described
// one replaceable slot per document id standing for every delivery received, the latest decoded
// state and the application lifecycle at once. Exact delivery handles cover stale terminalization
// and same-id overlap directly (hidden_ingress.spec.ts), and the gate covers writer staleness.
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
  // MIGRATED off the receipt overlay (round 71): the removal closes the GATE, so the held attempt
  // refuses instead of resolving against a record that is about to vanish. the outcome is
  // unchanged — never a write to the removed document, and the retry re-enters create resolution
  const removal = arriveRemoval(controller, idx, 'z9', h.ingress)
  pending.shift()!()
  await removal
  for (let i = 0; i < 6; i++) await flush()
  pending.shift()?.() // the create the retry re-entered
  for (let i = 0; i < 6; i++) await flush()
  expect(
    calls.filter(c => c.op == 'update'),
    'never the removed document'
  ).toHaveLength(0)
  expect(
    calls.filter(c => c.op == 'create'),
    're-entered create resolution'
  ).toHaveLength(1)
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
  const ack = deferred<void>()
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
      calls.push({ op: 'update', id, text: data.cipher })
      await ack.promise // held, so this write's echo can arrive first
    },
    reconcileOwner: name => void order.push('reconcile ' + name),
  })
  const live: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 0 } }
  idx.byId.set('d1', live)
  idx.byName.set('n', live)
  controller.save('n', { v: 1 })
  await flush() // building: the chain is busy, so an arrival now QUEUES behind it
  const remote: HiddenWrapper = { id: 'd2', name: 'n', item: { remote: 1 } } // higher id: no retarget
  // a REAL delivery, not a receipt: the coordinator handle is what makes the arrival visible to
  // the writer's gate, and its Apply is what queues behind the busy chain
  const handle = h.ingress.open('d2', 'cipher:d2')
  handle.ready(() =>
    controller.applyRemote(['n'], () => {
      order.push('remote applied')
      applyRemoteAdded(idx, remote)
    })
  )
  const arrival = handle.done
  pending.shift()!()
  await arrival // the delivery applies, reopening the gate
  // the held attempt REFUSED while d2 was outstanding (the gate, not a receipt), so the write is
  // the retry's — and it still targets d1, since d2 is a higher id and does not retarget
  for (let i = 0; i < 6; i++) await flush()
  pending.shift()?.() // the retry's encryption
  for (let i = 0; i < 8; i++) await flush()
  expect(calls.filter(c => c.op == 'update').map(c => c.id)).toEqual(['d1'])
  // ECHO BEFORE ACKNOWLEDGEMENT, the design's primary schedule. the echo carries the EXACT
  // ciphertext written, which is what the armed waiter matches — an unrelated later application
  // for the same id can no longer be mistaken for it
  const issued = calls.find(c => c.op == 'update')!.text!
  await arrive(controller, idx, { id: 'd1', name: 'n', item: { v: 1 } }, h.ingress, issued)
  ack.resolve()
  for (let i = 0; i < 8; i++) await flush()
  expect(order).toEqual(['remote applied', 'reconcile n'])
  expect(controller.owes('n')).toBe(false) // cleared only once settlement ran on the chain
})

test('a terminal write failure is reported to the failure hook and stays retryable', async () => {
  // round-19 finding 3: the `failed` phase was private. owes() is a boolean and isSaving() is
  // already false for a failed generation, so a settled permission error left owner notifications
  // suppressed with nothing but a console line to show for it
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
  // every requested gate must EXIST: `pending.shift()?.()` silently turned a missing encryption
  // into a successful no-op, so a drain count proved nothing about how many builds happened
  // waits until an encryption is actually OUTSTANDING. a requeued attempt reaches its next
  // encryption through the chain and a confirmation, so this can take several turns — but it must
  // happen, and asserting that is what stopped these tests from silently skipping the very window
  // they claim to interrupt (`pending.shift()?.()` turned a missing gate into a passing no-op)
  const awaitGate = async (what: string) => {
    for (let turn = 0; turn < 30 && !pending.length; turn++) await flush()
    expect(pending.length, `no encryption was outstanding for: ${what}`).toBeGreaterThan(0)
  }
  const releaseGate = async () => {
    pending.shift()!()
    await flush()
  }
  const drain = async (times: number) => {
    for (let i = 0; i < times; i++) {
      await awaitGate(`gate ${i + 1} of ${times}`)
      await releaseGate()
    }
  }
  // releases gates until no further encryption is requested: for schedules whose exact number of
  // build attempts is the thing under test rather than a constant to hard-code
  const drainAll = async () => {
    for (let round = 0; round < 20; round++) {
      for (let turn = 0; turn < 6 && !pending.length; turn++) await flush()
      if (!pending.length) return
      await releaseGate()
    }
  }
  return { ...h, controller, pending, drain, awaitGate, releaseGate, drainAll }
}

test('a lower id arriving during an ADOPTION encryption retargets, instead of writing the middle record', async () => {
  // round-20 finding 1: only the ordinary update branch looped. create and adoption issued after
  // an unchecked encryption, so this schedule wrote `update b2` while canonical state became a1
  const { idx, calls, controller, awaitGate, releaseGate, drainAll, ingress } = gatedHarness()
  controller.save('n', { D: 1 })
  await awaitGate('the fresh create')
  const arrival = arrive(controller, idx, { id: 'b2', name: 'n', item: { B: 1 } }, ingress)
  await releaseGate() // the attempt refuses while b2 is outstanding
  await arrival // ... and b2 applies, reopening the gate for the retry that adopts it
  await awaitGate('the adopted payload for b2')
  const lower = arrive(controller, idx, { id: 'a1', name: 'n', item: { A1: 1 } }, ingress) // MID-encryption
  await releaseGate()
  await lower // a1 applies and the gate reopens
  await drainAll() // however many retries the refusals cost, the OUTCOME is what this pins
  expect(calls.filter(c => c.op == 'create')).toHaveLength(0) // never a duplicate document
  const updates = calls.filter(c => c.op == 'update')
  expect(updates.map(u => u.id)).toEqual(['a1']) // the record canonical NOW, never the middle one
  expect(itemOf(updates[0].text).D).toBe(1) // carrying the local state
})

// round-21 finding 1: the previous version of this test never removed anything — it added a lower
// id, duplicating the test above, while its title and comment claimed a removal schedule. these are
// the three ways the ADOPTION TARGET ITSELF can change under a payload already built for it, and
// all three previously issued that stale payload
const TARGET_CHANGES: {
  what: string
  arrive: (controller: any, idx: HiddenIndex, ingress: any) => Promise<unknown>
  expect?: (updates: Call[]) => void
}[] = [
  {
    what: 'removed',
    arrive: (controller: any, idx: HiddenIndex, ingress: any) => arriveRemoval(controller, idx, 'b2', ingress),
    // issuing would RESURRECT a document the server says is gone
  },
  {
    what: 'renamed',
    arrive: (controller: any, idx: HiddenIndex, ingress: any) =>
      arrive(controller, idx, { id: 'b2', name: 'm', item: { B: 1 } }, ingress),
    // issuing would write a payload naming it 'n', undoing the rename
  },
  {
    what: 'replaced under the same id',
    arrive: (controller: any, idx: HiddenIndex, ingress: any) =>
      arrive(controller, idx, { id: 'b2', name: 'n', item: { B: 1, E: 1 } }, ingress),
    // b2 is still the RIGHT target here — what must not happen is issuing the already-built
    // { D, B }, which would erase the E that arrived. so the retry rebuilds for it instead
    expect: (updates: Call[]) => {
      const written = updates.filter(u => u.id == 'b2')
      expect(written).toHaveLength(1)
      expect(itemOf(written[0].text)).toEqual({ D: 1, B: 1, E: 1 }) // E survives
    },
  },
]
for (const { what, arrive: deliver, expect: check } of TARGET_CHANGES)
  test(`an adoption target ${what} during its encryption is not written`, async () => {
    const { idx, calls, controller, ingress, awaitGate, releaseGate, drain } = gatedHarness()
    controller.save('n', { D: 1 })
    await awaitGate('the fresh create')
    void arrive(controller, idx, { id: 'b2', name: 'n', item: { B: 1 } }, ingress)
    await releaseGate() // b2 applies, the attempt requeues, and the retry adopts b2
    await awaitGate('the adopted payload for b2') // the window this test is actually about
    void deliver(controller, idx, ingress) // the target changes WHILE its adopted payload encrypts
    await releaseGate()
    await drain(1) // whatever the retry legitimately chooses instead
    const updates = calls.filter(c => c.op == 'update')
    if (check) check(updates)
    else
      expect(
        updates.map(u => u.id),
        'the stale target is never written'
      ).not.toContain('b2')
  })

test('a superseded generation does not leave an adoption pointing at a removed document', async () => {
  // round-21 finding 1: generation 1 is encrypting an adoption when the target is removed and
  // generation 2 supersedes it. generation 1 must exit without finalizing, and generation 2 must
  // not inherit an adopt_id for a document that no longer exists
  const { idx, calls, controller, awaitGate, releaseGate, drainAll, ingress } = gatedHarness()
  controller.save('n', { D: 1 })
  await awaitGate('the fresh create')
  const arrival = arrive(controller, idx, { id: 'b2', name: 'n', item: { B: 1 } }, ingress)
  await releaseGate()
  await arrival // b2 applies and the gate reopens for the retry that adopts it
  await awaitGate('the adopted payload for b2') // generation 1 is encrypting its adoption
  const removal = arriveRemoval(controller, idx, 'b2', ingress)
  controller.save('n', { D: 2 }) // supersedes generation 1
  await releaseGate()
  await removal
  await drainAll()
  expect(calls.filter(c => c.op == 'update').map(u => u.id)).not.toContain('b2')
  const created = calls.filter(c => c.op == 'create')
  expect(created).toHaveLength(1) // the removed target is not adopted; a fresh document is created
  expect(itemOf(created[0].text)).toEqual({ D: 2 }) // carrying the CURRENT generation's state
})

test('an error whose message merely contains "cancel" is still reported', async () => {
  // round-21 finding 3: /cancel/i matched real failures such as "operation cancelled by server",
  // suppressing them and recreating the invisible owes() state the hook exists to end
  const failures: string[] = []
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmTarget: async () => {
      throw new Error('operation cancelled by server')
    },
    notifyFailure: (name, error) => void failures.push(`${name}: ${(error as Error).message}`),
  })
  controller.save('n', { v: 1 })
  await flush()
  expect(failures).toEqual(['n: operation cancelled by server'])
})

test('a terminal BUILD failure is reported, not only a terminal write failure', async () => {
  // round-20 finding 3: notifyFailure covered the asynchronous write rejection only. a rejecting
  // confirmIndex produced no write, left owes() true, made isSaving() false and suppressed
  // owner notifications indefinitely — with nothing but a console line to show for it
  const failures: string[] = []
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmTarget: async () => {
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
  // so the echo then arrived as a spurious "changed remotely". the frontier heuristic that used to
  // paper over this is DELETED: settlement now reads the EXACT echo waiter's recorded outcome, one
  // causal microtask after the acknowledgement
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
  const moving = arrive(controller, idx, { id: 'a1', name: 'n', item: { v: 'B' } }, h.ingress) // lower id: the target moves
  pending.shift()!()
  await flush() // requeued behind a1's application
  pending.shift()?.()
  await flush() // rebuilt for a1 and issued
  expect(calls.filter(c => c.op == 'update').map(c => c.id)).toEqual(['a1'])
  expect(controller.owes('n')).toBe(true) // unsettled while the acknowledgement is outstanding
  // OUR OWN ECHO, carrying the exact ciphertext that was written — that is what the armed waiter
  // matches on, and it is why an unrelated later application for the same id can no longer be
  // mistaken for this write's echo
  const issued = calls.find(c => c.op == 'update')!.text!
  await arrive(controller, idx, { id: 'a1', name: 'n', item: { v: 'D' } }, h.ingress, issued)
  ack.resolve()
  for (let i = 0; i < 6; i++) await flush()
  expect(reconciled).toEqual([{ v: 'D' }]) // in step with the echo, never rolled back to B
  expect(controller.owes('n')).toBe(false)
})

test('a change that has ENTERED the listener but not yet decrypted still stops a stale write', async () => {
  // round-22 finding 1: production cannot decode until after decryptItem, and every
  // controller branch can finish encrypting and issue synchronously in that window — so a removal,
  // rename or same-id replacement already inside the listener left the stamp unchanged and the
  // stale write went out. the receipt now exists from listener ENTRY
  const { idx, calls, controller, ingress, awaitGate, releaseGate, drain } = gatedHarness()
  const live: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 'A' } }
  idx.byId.set('d1', live)
  idx.byName.set('n', live)
  controller.save('n', { v: 'D' })
  await awaitGate('the update for d1')
  // the listener has OPENED a delivery for d1 and is still decrypting: nothing is known about the
  // change yet, and the coordinator's gate is pending for its whole lifetime
  const entering = ingress.open('d1', 'cipher:d1')
  await releaseGate()
  expect(
    calls.filter(c => c.op == 'update'),
    'no write while a change for the target is in flight'
  ).toHaveLength(0)
  // the change turns out to be a removal, applied as that delivery's own Apply
  entering.ready(() => controller.applyRemote([controller.nameForDocument('d1')], () => void removeHidden(idx, 'd1')))
  await entering.done
  await drain(1)
  expect(calls.filter(c => c.op == 'update').map(u => u.id)).not.toContain('d1')
})

test('a target with an undecoded delivery is REFUSED, and writes once it decodes', async () => {
  // round-23 finding 1: a stamp read before and after an encryption cannot see a delivery that was
  // already in flight when the build started, so a stalled decrypt let a stale full-state write out.
  // round-24: the first fix AWAITED the delivery, which deadlocks — a hidden-to-visible delivery
  // awaits applyRemote on the very name chain the writer owns. so the attempt is REFUSED and
  // requeued instead, which fails closed and leaves the chain free for that application to run.
  // this test releases its encryption gate: the previous version did not, so it passed on the
  // implementation it was meant to distinguish
  const { idx, calls, controller, ingress, pending, drainAll } = gatedHarness()
  const live: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 'A' } }
  idx.byId.set('d1', live)
  idx.byName.set('n', live)
  const open = ingress.open('d1', 'cipher:d1') // a delivery for our target is decoding
  controller.save('n', { v: 'D' })
  for (let turn = 0; turn < 6; turn++) await flush()
  // it does not even ENCRYPT: refusing only after the build cost a secret acquisition and a full
  // encryption per retry, which a slow decode turns into repeated builds
  expect(pending, 'no encryption is attempted while the delivery is undecoded').toHaveLength(0)
  expect(
    calls.filter(c => c.op == 'update'),
    'nothing written while the delivery is undecoded'
  ).toHaveLength(0)
  expect(controller.owes('n'), 'the change is still owed').toBe(true)
  // decoded, and nothing about the record changed: the delivery applies as a no-op and terminates,
  // which is what returns the gate to writable
  open.ready(() => Promise.resolve())
  await open.done
  await drainAll()
  const updates = calls.filter(c => c.op == 'update')
  expect(updates.map(u => u.id)).toEqual(['d1']) // exactly one write, to the same document
  expect(itemOf(updates[0].text)).toEqual({ v: 'D' }) // carrying the latest state
  expect(controller.owes('n')).toBe(false)
})

// NOTE this one pins the OUTCOME, not the barrier specifically: with the refusal disabled it still
// passes, because the stamp catches the removal at the final recheck. that is a genuine second line
// of defence and worth keeping pinned, but the test above is the one that distinguishes the barrier
test('a delivery that decodes into a removal is not written through by the retry', async () => {
  const { idx, calls, controller, drainAll, ingress } = gatedHarness()
  const live: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 'A' } }
  idx.byId.set('d1', live)
  idx.byName.set('n', live)
  controller.save('n', { v: 'D' })
  for (let turn = 0; turn < 6; turn++) await flush()
  const decoded = arriveRemoval(controller, idx, 'd1', ingress) // what the delivery turned out to be
  await drainAll()
  expect(calls.filter(c => c.op == 'update').map(u => u.id)).not.toContain('d1')
  expect(
    calls.filter(c => c.op == 'create'),
    'it re-enters create resolution'
  ).toHaveLength(1)
})

// NOTE 'settlement does not reconcile the owner when its own echo failed to apply' stood here and
// is SUPERSEDED by 'a BLOCKED echo does not reconcile', which proves the same round-22 property
// against the real waiter instead of an echoApplied flag the harness could assert into existence.
test('an adoption invalidated DURING encryption neither issues nor finalizes against the stale pointer', async () => {
  // round-35 stage-1a guard 2. targetStamp is not the pointer's CAS: for a target absent from byId
  // (adoption targets are, until finalization) the stamp reads `absent` before and after, so only
  // the captured-pointer equality can notice invalidateAdopters clearing the selection while the
  // attempt was inside encryptState
  const gate = deferred<void>()
  const h = harness()
  const { idx, calls } = h
  let wrapperRef: HiddenWrapper | undefined
  const controller = createHiddenPersistence({
    ...h.deps,
    // register the target ONCE: a later confirm must not re-offer it, or the retry would freshly
    // and legitimately re-adopt and the schedule could no longer tell stale from fresh
    confirmTarget: async (name, hooks) => {
      const answer = wrapperRef ? [] : [{ id: 'target1', name, item: { theirs: 1 } }]
      const outcome = await serverAnswer(answer)(name, hooks)
      // the merge callback belongs to the CONTROLLER now, so the pending wrapper is read from the
      // index rather than captured through a test-supplied merge
      wrapperRef = wrapperRef ?? [...idx.byId.values()].find(w => w.adopt_id)
      return outcome
    },
    encryptState: async state => {
      await gate.promise // hold the attempt inside encryption
      return { cipher: JSON.stringify(state) }
    },
  })
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 4; i++) await flush() // reach the encryption gate with adopt_id = target1
  expect(wrapperRef?.adopt_id).toBe('target1')
  invalidateAdopters(idx, 'target1') // the selection is cleared while we encrypt
  gate.resolve()
  for (let i = 0; i < 8; i++) await flush()
  expect(
    calls.filter(c => c.op == 'update' && c.id == 'target1'),
    'no stale write against the cleared selection'
  ).toHaveLength(0)
  // the retry re-chose with the selection gone: a FRESH create under a new id, not a resurrection
  const created = calls.find(c => c.op == 'create')
  expect(created).toBeTruthy()
  expect(created!.id).not.toBe('target1')
})

// ROUND-35 STAGE 1B: baseline / derived projection / owner as three distinct identities

test('adoption while acquireSecret is pending reaches payload, wrapper and owner; the baseline stays unmerged', async () => {
  // the schedule that FAILED under the first stage-1b attempt: fixed-page phrase validation
  // registers and adopts BEFORE the secret is published, so the merge lands while persistOwed is
  // still waiting on acquireSecret. the old code then reset the projection from the baseline on
  // attempt entry, and the merge was encrypted away
  const secret = deferred<void>()
  const published: any[] = []
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    acquireSecret: () => secret.promise,
    syncOwner: (_name, state) => void published.push(JSON.parse(JSON.stringify(state))),
  })
  const saved = { mine: 1 }
  controller.save('n', saved)
  await flush()
  // registration runs while the secret gate holds the attempt, through the REAL path (round 37):
  // registerHidden's adopted branch sets the pointer and invokes the controller merge, in
  // production's pointer-then-merge order
  const pending = idx.byName.get('n')!
  registerHidden(idx, { id: 'doc1', name: 'n', item: { pre: 1 } }, (p, f) => controller.mergeAdopted(p, f))
  expect(pending.adopt_id).toBe('doc1')
  secret.resolve()
  for (let i = 0; i < 6; i++) await flush()
  const written = calls.find(c => c.op == 'update' && c.id == 'doc1')
  expect(written, 'the adopted document was updated, not duplicated').toBeTruthy()
  expect(itemOf(written!.text), 'payload carries the merge').toEqual({ mine: 1, pre: 1 })
  expect(published.at(-1), 'the owner was published the projection').toEqual({ mine: 1, pre: 1 })
  expect(saved, 'the caller object was never touched').toEqual({ mine: 1 })
})

test('baseline, derived wrapper and owner are distinct identities', async () => {
  const published: any[] = []
  const h = harness()
  const { idx } = h
  const secret2 = deferred<void>()
  const controller = createHiddenPersistence({
    ...h.deps,
    acquireSecret: () => secret2.promise, // hold the attempt so the wrapper stays pending
    syncOwner: (_name, state) => void published.push(state),
  })
  const saved = { mine: 1 }
  controller.save('n', saved)
  await flush()
  const pending = idx.byName.get('n')!
  controller.mergeAdopted(pending, { id: 'doc1', name: 'n', item: { pre: 1 } })
  expect(pending.item, 'projection').toEqual({ mine: 1, pre: 1 })
  expect(pending.item, 'projection is not the caller object').not.toBe(saved)
  expect(published[0], 'owner state is not the projection object').not.toBe(pending.item)
  saved.mine = 99 // mutating the caller object reaches neither
  expect(pending.item.mine).toBe(1)
})

test('a same-id replacement DURING encryption never issues v1: payload, wrapper and owner all carry v2', async () => {
  // THE ABA SCHEDULE (round 36): a v1 adoption is encrypting when registerHidden receives a
  // same-id same-name replacement carrying v2 — entry invalidation clears the adopter and the
  // adopted branch immediately re-points it at the SAME id, with the controller rebasing to v2.
  // the pointer string and the (absent-from-byId) target stamp both look unchanged to the resumed
  // v1 attempt, so only the PROJECTION IDENTITY — mergeAdopted assigns a fresh object — can refuse
  // its already-encrypted v1 payload. and the refusal must clear nothing: the selection is v2's
  const gate = deferred<void>()
  let gated = false
  let gatedPayload: string | undefined
  const published: any[] = []
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    syncOwner: (_name, state) => void published.push(JSON.parse(JSON.stringify(state))),
    confirmTarget: async (name, hooks) =>
      serverAnswer(idx.byId.has('a1') ? [] : [{ id: 'a1', name, item: { shared: 'v1' } }])(name, hooks),
    encryptState: async state => {
      if (!gated) {
        gated = true
        gatedPayload = state.text // what the FIRST attempt is encrypting, captured at entry
        await gate.promise // hold the v1 attempt inside encryption
      }
      return { cipher: 'cipher:' + state.text } // the harness default shape (see itemOf)
    },
  })
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 4; i++) await flush() // reach the encryption gate with the v1 projection
  const pending = idx.byName.get('n')!
  expect(pending.adopt_id).toBe('a1')
  // PRECONDITION (round 38): the first attempt actually reached encryption CARRYING v1 before the
  // replacement registers — otherwise a scheduling change could let v2 arrive first and this test
  // would produce its exact end state without ever exercising the same-id ABA
  expect(gated, 'the v1 attempt is inside encryption').toBe(true)
  expect(JSON.parse(gatedPayload!).item.shared, 'and it is encrypting v1').toBe('v1')
  // the replacement arrives while the v1 attempt encrypts: same id, same name, v2
  registerHidden(idx, { id: 'a1', name: 'n', item: { shared: 'v2' } }, (p, f) => controller.mergeAdopted(p, f))
  expect(pending.adopt_id, 'freshly re-adopted to the same id').toBe('a1')
  gate.resolve()
  for (let i = 0; i < 10; i++) await flush()
  // EXACT (round 37): one or more all-v2 writes would still allow duplicate v2 updates or a fresh
  // v2 create under a wrong id — which is precisely the scheduling question this test pins: the
  // stale attempt's refuse-without-clearing requeues the SOLE continuation, so exactly one write
  const written = calls.filter(c => c.op == 'update' || c.op == 'create')
  expect(
    written.map(w => ({ op: w.op, id: w.id, shared: itemOf(w.text).shared })),
    'exactly one update, to a1, carrying v2 — no duplicate, no create'
  ).toEqual([{ op: 'update', id: 'a1', shared: 'v2' }])
  expect(pending.item.shared, 'the finalized wrapper carries v2').toBe('v2')
  expect(idx.byName.get('n')!.id, 'the final index holder is a1').toBe('a1')
  expect(published.at(-1)!.shared, 'the last owner publication carries v2').toBe('v2')
})

test('the baseline is cloned at save time: later caller mutations never reach a queued write', async () => {
  // both owed sites clone (creation and supersede): sharing the caller's object would let an owner
  // that keeps mutating its global_store change what an already-queued write persists, and adoption
  // rebases would rebase onto a moving target
  const h = harness()
  const { calls } = h
  const controller = createHiddenPersistence(h.deps)
  // nested values the earlier structural clone ALIASED (round 36): a Date freezes to the string
  // JSON will persist, and a legal own __proto__ key survives as a data property
  const when = new Date('2026-01-02T03:04:05.000Z')
  const live: any = { mine: 1, nested: { when }, ['__proto__']: { legal: true } }
  controller.save('n', live)
  live.mine = 'mutated after save'
  when.setFullYear(1999) // mutating the aliased Date must not reach the queued write
  for (let i = 0; i < 6; i++) await flush()
  const created = itemOf(calls.find(c => c.op == 'create')!.text)
  expect(created.mine).toBe(1)
  expect(created.nested.when, 'the Date froze at save time').toBe('2026-01-02T03:04:05.000Z')
  expect(Object.getOwnPropertyDescriptor(created, '__proto__')?.value, 'own __proto__ is data, not setter').toEqual({
    legal: true,
  })
  // a KEY-SENSITIVE toJSON on the STATE ITSELF must see the key the payload will pass it — 'item',
  // not the JSON root's '' (round 37). nested objects see their own property name either way, so
  // only the top level distinguishes the positional clone from the root clone
  calls.length = 0
  controller.save('n2', { toJSON: (key: string) => ({ sawKey: key }) } as any)
  for (let i = 0; i < 6; i++) await flush()
  const second = itemOf(calls.find(c => c.op == 'create')!.text)
  expect(second.sawKey, "toJSON saw the payload position 'item', not the JSON root ''").toBe('item')

  // the SUPERSEDE site: a second save while the first generation is still owed reassigns
  // localIntent rather than creating a new owed record
  calls.length = 0
  const third: any = { mine: 3 }
  const fourth: any = { mine: 4 }
  controller.save('n', third)
  controller.save('n', fourth) // supersedes before the first attempt runs
  fourth.mine = 'mutated after the superseding save'
  for (let i = 0; i < 8; i++) await flush()
  const written = calls.filter(c => c.op == 'create' || c.op == 'update')
  expect(written.length).toBeGreaterThan(0)
  expect(itemOf(written.at(-1)!.text)).toEqual({ mine: 4 })
})

test('non-JSON state fails through notifyFailure at save time, mutating nothing', async () => {
  // round-37 contract choice: normalization moved from the asynchronous build path to save() entry,
  // so its failure must reach the same user-visible hook as a settled write failure — and must
  // reach it BEFORE any index or owed mutation, or the failed save would leave a claimed name
  const failures: string[] = []
  const errors: unknown[] = []
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    notifyFailure: (name, e) => void (failures.push(name), errors.push(e)),
  })
  expect(controller.save('n', { bad: BigInt(1) }), 'rejected').toBe(false)
  for (let i = 0; i < 4; i++) await flush()
  expect(failures, 'the user-visible hook fired').toEqual(['n'])
  expect(idx.byName.has('n'), 'no claimed name').toBe(false)
  expect(controller.owes('n'), 'the rejected save creates no owed generation').toBe(false)
  expect(calls.filter(c => c.op == 'create' || c.op == 'update')).toHaveLength(0)

  // a legal toJSON can throw a SYMBOL. the controller passes the RAW value to the hook — that is
  // all this pins; production's modal formatter is guarded separately (template interpolation of a
  // Symbol throws, and hostile coercion can too — String(Symbol) itself is fine)
  expect(
    controller.save('n', {
      toJSON: () => {
        throw Symbol('bad')
      },
    } as any),
    'rejected too'
  ).toBe(false)
  expect(typeof errors.at(-1), 'the raw thrown value reaches the hook').toBe('symbol')
})

test('rejecting a NEW invalid value keeps the older owed generation AND rolls the owner back to it', async () => {
  // round-39: the rollback baseline must be the last accepted local INTENT (Owed.localIntent, the
  // immutable user snapshot — adoption can later publish a derived projection, so "last owner
  // view" would be a stronger claim than rejection safety needs). while D is owed, owes()
  // suppresses owner synchronization, so the applied index can hold remote C the owner never saw —
  // restoring C would discard the accepted owed D, and the local-change callback could then save C
  // and supersede D. the SDK acknowledgement (not encryption, which owns the name chain) is held
  // so D stays owed while C applies
  const ack = deferred<void>()
  const published: any[] = []
  const h = harness()
  const { idx, calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    createDoc: async (id, data) => {
      calls.push({ op: 'create', id, text: data.cipher ?? data.text })
      await ack.promise
    },
    syncOwner: (_name, state) => void published.push(JSON.parse(JSON.stringify(state))),
  })
  expect(controller.save('n', { mine: 'D' }), 'valid save accepted').toBe(true)
  for (let i = 0; i < 6; i++) await flush()
  expect(
    calls.filter(c => c.op == 'create'),
    'D was issued'
  ).toHaveLength(1)
  expect(controller.owes('n'), 'D is still owed (unacknowledged)').toBe(true)
  // remote C arrives through the production lifecycle (never a direct reducer call — see arrive)
  const docId = idx.byName.get('n')!.id
  await arriveModified(controller, idx, { id: docId, name: 'n', item: { mine: 'C' } })
  expect(idx.byName.get('n')!.item, 'the applied index holds C').toEqual({ mine: 'C' })

  published.length = 0 // the fresh-create attempt already published D; only the REJECTION is under test
  expect(controller.save('n', { bad: BigInt(1) }), 'invalid E rejected').toBe(false)
  expect(controller.owes('n'), 'the OLDER generation is still owed').toBe(true)
  expect(published, 'the rejection itself published exactly owed D, never applied C').toEqual([{ mine: 'D' }])
  expect(idx.byName.get('n')!.item, 'the applied index STILL holds C — nothing rolled it back').toEqual({
    mine: 'C',
  })
  // ... and the issued payload was D, not merely "one create occurred"
  expect(itemOf(calls.find(c => c.op == 'create')!.text)).toEqual({ mine: 'D' })
  ack.resolve()
  // ONE flush suffices: the acknowledgement handler and name-chain settlement are pure promise
  // work, drained before this timer fires (round 41)
  await flush()
  expect(controller.owes('n'), 'the owed generation settles — no detached work left behind').toBe(false)
})

test('rejection with NOTHING owed rolls the owner back to the applied state', async () => {
  const published: any[] = []
  const h = harness()
  const { idx } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    syncOwner: (_name, state) => void published.push(JSON.parse(JSON.stringify(state))),
  })
  idx.byId.set('a1', { id: 'a1', name: 'n', item: { applied: true } })
  idx.byName.set('n', idx.byId.get('a1')!)
  expect(controller.save('n', { bad: BigInt(1) })).toBe(false)
  expect(published.at(-1), 'the applied index is the fallback baseline').toEqual({ applied: true })
  expect(controller.save('fresh', { bad: BigInt(1) })).toBe(false)
  expect(published.at(-1), 'and {} when the name has nothing at all').toEqual({})
})

// STAGE 3: the writer's half of the sticky ingress stop

test('stop retains unissued intent, clears saving, and reports once per generation', async () => {
  const failures: string[] = []
  let acquisitions = 0
  const h = harness()
  const { calls } = h
  const controller = createHiddenPersistence({
    ...h.deps,
    acquireSecret: async () => void ++acquisitions,
    notifyFailure: n => void failures.push(n),
  })
  // stop arrives BEFORE the scheduler continuation runs, so the generation is still unissued
  controller.save('n', { mine: 1 })
  expect(controller.owes('n')).toBe(true)
  expect(controller.isSaving('n'), 'saving synchronously').toBe(true)

  controller.stop()
  expect(controller.isSaving('n'), 'and not saving once stopped').toBe(false)
  expect(failures, 'reported once for this generation').toEqual(['n'])
  expect(controller.owes('n'), 'the accepted intent is RETAINED — not lost, just unwritable').toBe(true)

  // THE ROUND-60 BOUNDARY: the already-scheduled continuation must not resume into secret work
  for (let i = 0; i < 8; i++) await flush()
  expect(acquisitions, 'the post-stop scheduler continuation acquires nothing').toBe(0)

  // a second stop is a no-op, and no further work starts
  calls.length = 0
  controller.stop()
  for (let i = 0; i < 6; i++) await flush()
  expect(failures, 'no second report for the same generation').toEqual(['n'])
  expect(acquisitions, 'still nothing').toBe(0)
  expect(
    calls.filter(c => c.op == 'create' || c.op == 'update'),
    'no new SDK work'
  ).toHaveLength(0)
})
// TABLED WITH ITS POSITIVE CONTROL, and pinning the OUTCOME rather than a specific barrier: with
// the no-await stop recheck deleted this still passes, because the refused attempt requeues and
// the retry refuses at attemptWrite's entry instead. Both checks are required by the design (a
// write already encrypting must not issue after the listener dies) and the no-await one is the
// only one that holds if a future path ever issues without requeueing — it is defence in depth,
// reviewed directly rather than pinned here. The control is what proves this schedule reaches the
// issue path at all
for (const stopDuringEncryption of [false, true])
  test(`a write encrypting when ingress ${stopDuringEncryption ? 'STOPS never issues' : 'stays live DOES issue'}`, async () => {
    const h = gatedHarness()
    const { calls, controller } = h
    controller.save('n', { mine: 1 })
    await h.awaitGate('the create for n')
    if (stopDuringEncryption) controller.stop() // the listener died while this payload encrypted
    await h.releaseGate()
    await h.drainAll()
    const written = calls.filter(c => c.op == 'create' || c.op == 'update')
    if (stopDuringEncryption) {
      expect(written, 'the no-await recheck refused').toHaveLength(0)
      expect(controller.owes('n'), 'and the intent is still owed').toBe(true)
    } else {
      expect(written, 'the control: this schedule really does reach the issue path').toHaveLength(1)
      expect(controller.owes('n')).toBe(false)
    }
  })

test('a save AFTER stop takes the stopped outcome SYNCHRONOUSLY: no secret, no chain, one report', async () => {
  const failures: string[] = []
  let acquisitions = 0
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    acquireSecret: async () => void ++acquisitions,
    notifyFailure: n => void failures.push(n),
  })
  controller.stop()
  expect(controller.save('n', { mine: 1 }), 'accepted as intent').toBe(true)
  // SYNCHRONOUSLY, before any turn: the outcome is knowable at save time, and the old code
  // enqueued a chain turn whose persistOwed awaited acquireSecret() — a PHRASE PROMPT — before
  // attemptWrite finally noticed stop
  expect(acquisitions, 'no secret work at all').toBe(0)
  expect(failures, 'reported once, at save time').toEqual(['n'])
  for (let i = 0; i < 6; i++) await flush()
  expect(acquisitions, 'and none afterwards either').toBe(0)
  expect(
    h.calls.filter(c => c.op == 'create' || c.op == 'update'),
    'no write'
  ).toHaveLength(0)
  expect(controller.owes('n'), 'retained for a reload').toBe(true)
  expect(failures, 'still exactly one for this generation').toEqual(['n'])
  // a genuinely superseding save is a NEW generation, and reports its own outcome (see Owed)
  expect(controller.save('n', { mine: 2 }), 'accepted as intent').toBe(true)
  expect(failures, 'one report per generation').toEqual(['n', 'n'])
  expect(acquisitions, 'still no secret work').toBe(0)
})

test('an acknowledgement arriving AFTER stop clears the owed record without reconciling the owner', async () => {
  const reconciled: string[] = []
  const ack = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    reconcileOwner: n => void reconciled.push(n),
    updateDoc: async (id, data) => {
      h.calls.push({ op: 'update', id, text: data.cipher })
      await ack.promise
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 6; i++) await flush()
  expect(
    h.calls.filter(c => c.op == 'update'),
    'the write went out before stop'
  ).toHaveLength(1)
  // the listener dies while the write is in flight
  controller.stop()
  ack.resolve()
  for (let i = 0; i < 6; i++) await flush()
  // the write IS committed, so the record is cleared — but the index has stopped tracking the
  // server, so publishing owner state derived from it would be a guess
  expect(controller.owes('n'), 'the committed write cleared it').toBe(false)
  expect(reconciled, 'stop wins over the echo').toEqual([])
})

test('a save while the gate is PENDING does no secret work at all until the delivery applies', async () => {
  let acquisitions = 0
  const h = harness()
  const controller = createHiddenPersistence({ ...h.deps, acquireSecret: async () => void ++acquisitions })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  // an unrelated document is mid-decode: the gate is global, so it holds every writer
  const other = h.ingress.open('d2', 'cipher:d2')
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 8; i++) await flush()
  // THE POINT: acquireSecret PROMPTS for a phrase in production. doing that for a write that
  // cannot issue is user-visible damage, not just wasted work
  expect(acquisitions, 'no phrase prompt while the gate is shut').toBe(0)
  expect(
    h.calls.filter(c => c.op == 'update'),
    'and no write'
  ).toHaveLength(0)
  // the delivery applies, the gate opens, and the wake resumes the writer
  other.ready(async () => {})
  expect(await other.done).toBe('applied')
  for (let i = 0; i < 8; i++) await flush()
  expect(acquisitions, 'exactly one acquisition, after the wake').toBe(1)
  expect(
    h.calls.filter(c => c.op == 'update').map(c => c.id),
    'and the write went out'
  ).toEqual(['d1'])
})

test('a BLOCKED gate is reported once and waits for healing, instead of polling forever', async () => {
  const failures: string[] = []
  let acquisitions = 0
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    acquireSecret: async () => void ++acquisitions,
    notifyFailure: n => void failures.push(n),
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  // a delivery for an unrelated document fails to apply and is RETAINED as a block: only a
  // strictly higher delivery in ITS cell can clear that
  const bad = h.ingress.open('d2', 'cipher:bad')
  bad.ready(() => Promise.reject(new Error('decrypt failed')))
  expect(await bad.done).toBe('blocked')
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 10; i++) await flush()
  expect(acquisitions, 'no secret work for a write that cannot issue').toBe(0)
  expect(
    h.calls.filter(c => c.op == 'update'),
    'no write'
  ).toHaveLength(0)
  expect(failures, 'the user is told ONCE, not on every wake').toEqual(['n'])
  expect(controller.owes('n'), 'still owed: healing can still let it through').toBe(true)
  // healing: a strictly higher delivery in d2's cell succeeds
  const heal = h.ingress.open('d2', 'cipher:good')
  heal.ready(async () => {})
  expect(await heal.done).toBe('applied')
  for (let i = 0; i < 10; i++) await flush()
  expect(
    h.calls.filter(c => c.op == 'update').map(c => c.id),
    'the healed write issues'
  ).toEqual(['d1'])
  expect(failures, 'and no second report').toEqual(['n'])
})

test('a failed Apply on the WRITE TARGET blocks, then a strictly newer same-id delivery resumes it', async () => {
  // the blocked cell is the very document the writer is targeting, which is the migration case:
  // proving permanent blockage alone would pass a controller that never resumes after healing. the
  // retained local intent must survive the block and reach the server exactly once
  const failures: string[] = []
  const h = harness()
  const controller = createHiddenPersistence({ ...h.deps, notifyFailure: n => void failures.push(n) })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => undefined)
  const bad = h.ingress.open('d1', 'cipher:bad')
  bad.ready(() => Promise.reject(new Error('apply failed')))
  expect(await bad.done).toBe('blocked')
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 10; i++) await flush()
  expect(
    h.calls.filter(c => c.op == 'update'),
    'nothing issues over an unhealed block'
  ).toHaveLength(0)
  expect(controller.owes('n'), 'the intent is RETAINED, not dropped').toBe(true)
  expect(failures, 'reported once').toEqual(['n'])
  // a strictly HIGHER delivery in d1's own cell succeeds: only that heals it
  const heal = h.ingress.open('d1', 'cipher:good')
  heal.ready(async () => void applyRemoteModified(h.idx, { id: 'd1', name: 'n', item: { server: 2 } }))
  expect(await heal.done).toBe('applied')
  for (let i = 0; i < 12; i++) await flush()
  const updates = h.calls.filter(c => c.op == 'update')
  expect(
    updates.map(u => u.id),
    'EXACTLY ONE write, to the healed document'
  ).toEqual(['d1'])
  // the retained local intent WINS, and the healed server revision is merged beneath it: the
  // owner writes full-state clones, so dropping `server: 2` here would erase what healing restored
  expect(itemOf(updates[0].text), 'carrying the intent retained across the block').toEqual({ mine: 1, server: 2 })
  expect(controller.owes('n'), 'and nothing is left owed').toBe(false)
  expect(failures, 'no second report').toEqual(['n'])
})

test('a NEW generation inheriting a parked wake is still reported blocked', async () => {
  // round 59: the deleted token was NOT unfalsifiable, and my argument for deleting it was wrong.
  // generation 1 reports and parks; a superseding save returns through the queued shortcut and
  // inherits that same parked waiter, so it never reaches the report site on its own
  const failures: string[] = []
  const h = harness()
  const controller = createHiddenPersistence({ ...h.deps, notifyFailure: n => void failures.push(n) })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  const bad = h.ingress.open('d2', 'cipher:bad')
  bad.ready(() => Promise.reject(new Error('decrypt failed')))
  expect(await bad.done).toBe('blocked')
  controller.save('n', { v: 1 })
  for (let i = 0; i < 6; i++) await flush()
  expect(failures, 'generation 1 reported').toEqual(['n'])
  controller.save('n', { v: 2 }) // supersedes, inherits the parked wake
  expect(failures, 'generation 2 is told too').toEqual(['n', 'n'])
  // and still exactly one write, of the newest state, once healed
  const heal = h.ingress.open('d2', 'cipher:good')
  heal.ready(async () => {})
  expect(await heal.done).toBe('applied')
  for (let i = 0; i < 10; i++) await flush()
  const updates = h.calls.filter(c => c.op == 'update')
  expect(updates).toHaveLength(1)
  expect(itemOf(updates[0].text)).toEqual({ v: 2 })
  expect(failures, 'no further reports').toEqual(['n', 'n'])
})

test('one generation is reported ONCE even when healing immediately re-blocks', async () => {
  // the other half: a healing delivery whose own continuation blocks a different cell brings the
  // waiter back through the blocked branch for the SAME generation. only the token stops a
  // duplicate report
  const failures: string[] = []
  const h = harness()
  const controller = createHiddenPersistence({ ...h.deps, notifyFailure: n => void failures.push(n) })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  const bad = h.ingress.open('d2', 'cipher:bad')
  bad.ready(() => Promise.reject(new Error('decrypt failed')))
  expect(await bad.done).toBe('blocked')
  controller.save('n', { v: 1 })
  for (let i = 0; i < 6; i++) await flush()
  expect(failures, 'reported once').toEqual(['n'])
  // heal d2, but a continuation on its own done synchronously opens and blocks d3 before the
  // writer's waiter continuation runs
  const heal = h.ingress.open('d2', 'cipher:good')
  const reblock = heal.done.then(() => {
    const bad2 = h.ingress.open('d3', 'cipher:bad2')
    bad2.ready(() => Promise.reject(new Error('decrypt failed')))
    return bad2.done
  })
  heal.ready(async () => {})
  expect(await reblock).toBe('blocked')
  for (let i = 0; i < 10; i++) await flush()
  expect(failures, 'STILL one report for this generation').toEqual(['n'])
  expect(
    h.calls.filter(c => c.op == 'update'),
    'and no write'
  ).toHaveLength(0)
})

test('a superseding save REUSES the parked name wake, and only the newest state is written', async () => {
  // the name owns the physical wait; Owed owns the intent. supersession deliberately does NOT
  // cancel the waiter -- an earlier version did, and the queued-phase shortcut then meant nothing
  // rearmed it and the work was dropped entirely (zero writes)
  const h = harness()
  const controller = createHiddenPersistence(h.deps)
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  const held = h.ingress.open('d2', 'cipher:d2')
  controller.save('n', { v: 1 })
  for (let i = 0; i < 4; i++) await flush()
  controller.save('n', { v: 2 }) // supersedes while the first is parked on its wake
  held.ready(async () => {})
  expect(await held.done).toBe('applied')
  for (let i = 0; i < 10; i++) await flush()
  const updates = h.calls.filter(c => c.op == 'update')
  expect(updates, 'one write, not one per parked generation').toHaveLength(1)
  expect(itemOf(updates[0].text), 'carrying the newest intent').toEqual({ v: 2 })
})

// the round-60 table: the holder can be REPLACED, RENAMED or REMOVED while the writer is parked
// on the gate. under the old wrapper mirror each of these left the object the owner actually reads
// with no saving state -- rename and removal especially, since attemptWrite then synthesizes a
// fresh holder that never had one. saving belongs to the NAME, so all three are the same case
for (const [label, disturb] of [
  [
    'replaced under the same id',
    (idx: HiddenIndex) => {
      const b: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 1 } }
      idx.byId.set('d1', b)
      idx.byName.set('n', b)
    },
  ],
  [
    'renamed away',
    (idx: HiddenIndex) => {
      const b: HiddenWrapper = { id: 'd1', name: 'm', item: { v: 1 } }
      idx.byId.set('d1', b)
      idx.byName.set('m', b) // 'n' deliberately keeps its stale alias, as production does
    },
  ],
  [
    'removed',
    (idx: HiddenIndex) => {
      idx.byId.delete('d1')
    },
  ],
] as const)
  test(`a holder ${label} while the writer is parked leaves the NAME saving throughout`, async () => {
    const encrypting = deferred<void>()
    const encryptStarted = deferred<void>()
    const h = harness()
    const controller = createHiddenPersistence({
      ...h.deps,
      encryptState: async state => {
        encryptStarted.resolve() // CAUSAL: the test waits for this, never for a turn count
        await encrypting.promise
        const e: any = state
        e.cipher = 'cipher:' + state.text
        e.text = null
        return e
      },
    })
    const a: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 0 } }
    registerHidden(h.idx, a, () => {})
    const held = h.ingress.open('d2', 'cipher:d2') // an unrelated delivery shuts the global gate
    controller.save('n', { mine: 1 })
    expect(controller.isSaving('n'), 'saving synchronously').toBe(true)
    disturb(h.idx)
    expect(controller.isSaving('n'), 'still saving while parked, whatever happened to the holder').toBe(true)
    held.ready(async () => {})
    expect(await held.done).toBe('applied')
    await encryptStarted.promise // the chain turn is now genuinely inside the build
    expect(controller.isSaving('n'), 'and through the build').toBe(true)
    encrypting.resolve()
    for (let i = 0; i < 6; i++) await flush()
    expect(controller.isSaving('n'), 'false once the write is issued').toBe(false)
    expect(
      h.calls.filter(c => c.op == 'create' || c.op == 'update'),
      'exactly one write'
    ).toHaveLength(1)
  })
test('the gate closing during acquireSecret mutates nothing: no synthetic wrapper, no owner publication', async () => {
  // round 59 section 6: attemptWrite could clone, resolve a target, INSTALL a synthetic
  // pending_create in byId/byName and publish owner state before attemptCreate first read the
  // gate. acquireSecret prompts, so the gate can close while it is pending
  const published: string[] = []
  const release = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    acquireSecret: () => release.promise,
    syncOwner: n => void published.push(n),
  })
  controller.save('n', { mine: 1 }) // nothing holds 'n': the create path
  for (let i = 0; i < 4; i++) await flush()
  // the gate closes while the phrase prompt is open
  const held = h.ingress.open('d9', 'cipher:d9')
  release.resolve()
  for (let i = 0; i < 6; i++) await flush()
  // save() claiming the name synchronously is BY DESIGN (saving_global_store must be visible the
  // moment the user saves), so that wrapper is not the defect. what must not happen is the work
  // attemptWrite does on top of it before the gate is read: rewriting the claimed wrapper's item
  // and PUBLISHING it to the owner
  expect(published, 'nothing published to the owner while the gate is shut').toEqual([])
  expect(
    h.calls.filter(c => c.op == 'create' || c.op == 'update'),
    'no write'
  ).toHaveLength(0)
  // once the gate heals the create proceeds normally
  held.ready(async () => {})
  expect(await held.done).toBe('applied')
  for (let i = 0; i < 8; i++) await flush()
  expect(
    h.calls.filter(c => c.op == 'create'),
    'exactly one create, after the gate opened'
  ).toHaveLength(1)
})

// ---- TargetToken and the global gate are independently necessary (rounds 58, 59) ----
// these isolate the per-id receipt frontier and the global gate — the two halves of the issue
// token that ARE pinned. TargetToken.wrapper is not: see the note at the end of this file

test('an idempotent delivery for the SELECTED id refuses the first payload by frontier alone', async () => {
  // the delivery applies and PRUNES during the held encryption, leaving canonical selection and
  // wrapper identity exactly as they were. only receiptFrontier moved, so only it can refuse
  const { idx, calls, controller, ingress, awaitGate, releaseGate, drain } = gatedHarness()
  const live: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 'A' } }
  idx.byId.set('d1', live)
  idx.byName.set('n', live)
  controller.save('n', { v: 'B' })
  await awaitGate('the first payload')
  const d = ingress.open('d1', 'cipher:d1')
  d.ready(async () => {}) // applies and prunes without touching the index at all
  expect(await d.done).toBe('applied')
  expect(idx.byName.get('n'), 'selection unchanged').toBe(live)
  expect(idx.byId.get('d1'), 'wrapper identity unchanged').toBe(live)
  await releaseGate()
  expect(
    calls.filter(c => c.op == 'update'),
    'the first payload was refused'
  ).toHaveLength(0)
  await drain(1)
  expect(
    calls.filter(c => c.op == 'update').map(c => c.id),
    'the retry issues'
  ).toEqual(['d1'])
})

test('an UNRELATED open delivery refuses the payload through the global gate alone', async () => {
  // nothing about the target changed -- not its frontier, not its wrapper, not the selection.
  // only the global gate can refuse this one
  const { idx, calls, controller, ingress, awaitGate, releaseGate, drain } = gatedHarness()
  const live: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 'A' } }
  idx.byId.set('d1', live)
  idx.byName.set('n', live)
  controller.save('n', { v: 'B' })
  await awaitGate('the first payload')
  const unrelated = ingress.open('d9', 'cipher:d9')
  await releaseGate()
  expect(
    calls.filter(c => c.op == 'update'),
    'refused by the GLOBAL gate'
  ).toHaveLength(0)
  unrelated.ready(async () => {})
  expect(await unrelated.done).toBe('applied')
  await drain(1)
  expect(calls.filter(c => c.op == 'update').map(c => c.id)).toEqual(['d1'])
})

test('an unrelated delivery that applies BEFORE the encryption finishes lets the first payload issue', async () => {
  // the positive counterpart: this is what proves the frontier is TARGET-SPECIFIC rather than a
  // hidden global epoch. an unrelated id opening and closing must cost nothing
  const { idx, calls, controller, ingress, awaitGate, releaseGate } = gatedHarness()
  const live: HiddenWrapper = { id: 'd1', name: 'n', item: { v: 'A' } }
  idx.byId.set('d1', live)
  idx.byName.set('n', live)
  controller.save('n', { v: 'B' })
  await awaitGate('the first payload')
  const unrelated = ingress.open('d9', 'cipher:d9')
  unrelated.ready(async () => {})
  expect(await unrelated.done).toBe('applied') // gone again before the encryption returns
  await releaseGate()
  expect(
    calls.filter(c => c.op == 'update').map(c => c.id),
    'ONE write, no retry'
  ).toEqual(['d1'])
})

// ---- confirmation is an await, so both boundaries reopen across it (round 60) ----

test('a delivery opening during confirmation stops the create: no adoption, no publication, no encryption', async () => {
  const published: string[] = []
  const confirming = deferred<void>()
  const confirmStarted = deferred<void>()
  const encrypted: string[] = []
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmTarget: async (name, hooks) => {
      confirmStarted.resolve()
      await confirming.promise
      return serverAnswer([], undefined, () => h.ingress.gate())(name, hooks)
    },
    syncOwner: n => void published.push(n),
    encryptState: async state => {
      encrypted.push(state.text)
      const e: any = state
      e.cipher = 'cipher:' + state.text
      e.text = null
      return e
    },
  })
  // a same-name survivor exists, so a confirmation that returns would adopt and publish
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  h.idx.byName.delete('n') // ... but is not the claimed holder, so the create path runs
  controller.save('n', { mine: 1 })
  await confirmStarted.promise
  published.length = 0
  encrypted.length = 0
  const held = h.ingress.open('d2', 'cipher:d2') // the gate closes DURING confirmation
  confirming.resolve()
  for (let i = 0; i < 8; i++) await flush()
  expect(published, 'no owner publication behind a shut gate').toEqual([])
  expect(encrypted, 'and no encryption').toEqual([])
  expect(
    [...h.idx.byId.values()].filter(w => w.adopt_id),
    'and no adoption pointer was set'
  ).toEqual([])
  expect(
    h.calls.filter(c => c.op == 'create' || c.op == 'update'),
    'no write'
  ).toHaveLength(0)
  // once the gate heals the create completes normally
  held.ready(async () => {})
  expect(await held.done).toBe('applied')
  for (let i = 0; i < 10; i++) await flush()
  expect(h.calls.filter(c => c.op == 'create' || c.op == 'update').length, 'exactly one write, after healing').toBe(1)
})

for (const [label, settle] of [
  ['fulfils', (d: ReturnType<typeof deferred<void>>) => d.resolve()],
  ['rejects', (d: ReturnType<typeof deferred<void>>) => d.reject(new Error('confirmation failed'))],
] as const)
  test(`a confirmation that ${label} AFTER stop mutates nothing and reports nothing further`, async () => {
    const failures: string[] = []
    const published: string[] = []
    const confirming = deferred<void>()
    const confirmStarted = deferred<void>()
    const encrypted: string[] = []
    const h = harness()
    const controller = createHiddenPersistence({
      ...h.deps,
      confirmTarget: async (name, hooks) => {
        confirmStarted.resolve()
        await confirming.promise
        return serverAnswer([], undefined, () => h.ingress.gate())(name, hooks)
      },
      syncOwner: n => void published.push(n),
      encryptState: async state => {
        encrypted.push(state.text)
        const e: any = state
        e.cipher = 'cipher:' + state.text
        e.text = null
        return e
      },
      notifyFailure: n => void failures.push(n),
    })
    // a same-name SURVIVOR exists but does not hold the name, so a confirmation that returns
    // would adopt it and publish -- which is what makes this row able to tell the stop check
    // apart from doing nothing
    registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
    h.idx.byName.delete('n')
    controller.save('n', { mine: 1 })
    await confirmStarted.promise
    const before = [...h.idx.byId.keys()]
    // the KEYS alone are too weak: without the fulfil guard, adoption mutates the pending
    // wrapper's pointer and projection while preserving them. capture those directly, and count
    // encryptions, so this row proves what its name says
    // CLONE the projection: storing it by reference would miss an in-place mutation, which is
    // exactly what "mutates nothing" is supposed to exclude
    const pendingBefore = JSON.stringify([...h.idx.byId.values()].map(w => [w.id, w.adopt_id, w.item]))
    controller.stop()
    expect(failures, 'stop reported this generation once').toEqual(['n'])
    published.length = 0
    settle(confirming)
    for (let i = 0; i < 10; i++) await flush()
    expect([...h.idx.byId.keys()], 'the late continuation mutated no index state').toEqual(before)
    expect(
      JSON.stringify([...h.idx.byId.values()].map(w => [w.id, w.adopt_id, w.item])),
      'no adoption pointer moved and no projection was rebased or mutated in place'
    ).toEqual(pendingBefore)
    expect(encrypted, 'and nothing was encrypted').toEqual([])
    expect(published, 'and published nothing').toEqual([])
    expect(failures, 'and reported nothing further').toEqual(['n'])
    expect(
      h.calls.filter(c => c.op == 'create' || c.op == 'update'),
      'no write'
    ).toHaveLength(0)
    expect(controller.owes('n'), 'the intent is still retained').toBe(true)
  })

// ---- isSaving is DERIVED, so it cannot drift from the writer state (round 61) ----
// each row is a case where the previous parallel Set said the wrong thing

test('a blocked generation that HEALS is saving again through its build', async () => {
  const encrypting = deferred<void>()
  const encryptStarted = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    encryptState: async state => {
      encryptStarted.resolve()
      await encrypting.promise
      const e: any = state
      e.cipher = 'cipher:' + state.text
      e.text = null
      return e
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  const bad = h.ingress.open('d2', 'cipher:bad')
  bad.ready(() => Promise.reject(new Error('decrypt failed')))
  expect(await bad.done).toBe('blocked')
  controller.save('n', { mine: 1 })
  expect(controller.isSaving('n'), 'a blocked gate is not saving').toBe(false)
  const heal = h.ingress.open('d2', 'cipher:good')
  heal.ready(async () => {})
  expect(await heal.done).toBe('applied')
  expect(controller.isSaving('n'), 'saving again the INSTANT the gate heals').toBe(true)
  await encryptStarted.promise
  expect(controller.isSaving('n'), 'and through the build').toBe(true)
  encrypting.resolve()
  for (let i = 0; i < 6; i++) await flush()
  expect(controller.isSaving('n'), 'false once issued').toBe(false)
})

test('not-found RECOVERY is saving through its rebuild', async () => {
  const encrypting = deferred<void>()
  const encryptStarted = deferred<void>()
  let builds = 0
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    updateDoc: async () => {
      throw Object.assign(new Error('No document to update'), { code: 'not-found' })
    },
    encryptState: async state => {
      const e: any = state
      e.cipher = 'cipher:' + state.text
      e.text = null
      if (++builds > 1) {
        encryptStarted.resolve()
        await encrypting.promise
      }
      return e
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  controller.save('n', { mine: 1 })
  await encryptStarted.promise // the RECOVERY build, after the not-found rejection
  expect(controller.isSaving('n'), 'recovery is a build, so it is saving').toBe(true)
  encrypting.resolve()
  for (let i = 0; i < 8; i++) await flush()
  expect(controller.isSaving('n'), 'false once the recovery write is issued').toBe(false)
})

// ---- stop through the OUTER build catch (round 61 section 2) ----
for (const [label, hold] of [
  ['acquireSecret', 'secret'],
  ['ordinary encryption', 'encrypt'],
] as const)
  test(`a held ${label} rejecting AFTER stop reports nothing further`, async () => {
    const failures: string[] = []
    const held = deferred<void>()
    const started = deferred<void>()
    const h = harness()
    const controller = createHiddenPersistence({
      ...h.deps,
      acquireSecret: hold == 'secret' ? () => (started.resolve(), held.promise) : async () => {},
      encryptState:
        hold == 'encrypt'
          ? async () => {
              started.resolve()
              await held.promise
              return {} as any
            }
          : h.deps.encryptState,
      notifyFailure: n => void failures.push(n),
    })
    registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
    controller.save('n', { mine: 1 })
    await started.promise
    controller.stop()
    expect(failures, 'stop reported this generation once').toEqual(['n'])
    held.reject(new Error('rejected after stop'))
    for (let i = 0; i < 8; i++) await flush()
    expect(failures, 'the late catch reports nothing further').toEqual(['n'])
    expect(controller.owes('n'), 'and the intent stays owed').toBe(true)
    expect(
      h.calls.filter(c => c.op == 'create' || c.op == 'update'),
      'no write'
    ).toHaveLength(0)
  })

// THE `TargetToken.wrapper` DECISION, settled (review 73 asked for it). The wrapper-only mutation
// stayed green against the whole suite INCLUDING the landed corpus seam — but that only meant no
// test drove the schedule it exists for. The schedule is below, and with it the mutation fails.
//
// What the seq half cannot see: a CORPUS registration replaces the indexed object for an id
// WITHOUT advancing that id's receipt frontier, because no delivery was opened. The reachable case
// is a phrase prompt: name A is mid-encryption when name B's acquireSecret runs the post-prompt
// candidate scan, which registers fresh rows for MANY names — A's id among them. Its adoption merge
// may have rebased A's projection onto server state A's in-flight payload never saw, so issuing
// against the stale object overwrites it. The frontier is unchanged throughout.

test('a CORPUS registration replaces the target object without a delivery, and the write refuses', async () => {
  const encrypting = deferred<void>()
  const encryptStarted = deferred<void>()
  let encryptions = 0
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    encryptState: async state => {
      if (++encryptions == 1) {
        encryptStarted.resolve()
        await encrypting.promise
      }
      return h.deps.encryptState(state)
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => undefined)
  controller.save('n', { mine: 1 })
  await encryptStarted.promise
  const frontierBefore = h.ingress.receiptFrontier('d1')
  // A CORPUS REGISTRATION, mid-encryption: a fresh same-id observation REPLACES the indexed object
  // (registerHidden does byId.set). no delivery is opened, so the frontier does not move — the seq
  // half of the token is blind to this
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 2 } }, () => undefined)
  expect(h.ingress.receiptFrontier('d1'), 'no delivery, so no frontier movement').toBe(frontierBefore)
  encrypting.resolve()
  for (let i = 0; i < 14; i++) await flush()
  expect(encryptions, 'the stale-target attempt REFUSED and the retry built again').toBe(2)
  const updates = h.calls.filter(c => c.op == 'update')
  expect(updates, 'exactly one write').toHaveLength(1)
  // WITHOUT the wrapper half the first attempt issues, carrying `server: 1` — the state the
  // registration had just replaced, silently reverting it
  expect(itemOf(updates[0].text), 'built against the CURRENT record, not the replaced one').toEqual({
    mine: 1,
    server: 2,
  })
})

test('a generation that heals, builds, and RE-BLOCKS is not saving and is reported only once', async () => {
  // round 62: my previous version of this row never executed the path it named -- it left the
  // gate continuously blocked, so the parked whenWritable never resumed, no build started, and
  // reportBlocked was never revisited. it passed the pre-fix implementation unchanged. this is
  // the causal schedule: heal, get INSIDE the build, block again during it, then let the attempt
  // refuse and requeue, and wait for the SECOND wake registration rather than counting turns
  const failures: string[] = []
  const encrypting = deferred<void>()
  const encryptStarted = deferred<void>()
  const secondWake = deferred<void>()
  let wakes = 0
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    whenWritable: () => {
      if (++wakes == 2) secondWake.resolve()
      return h.ingress.whenWritable()
    },
    encryptState: async state => {
      encryptStarted.resolve()
      await encrypting.promise
      const e: any = state
      e.cipher = 'cipher:' + state.text
      e.text = null
      return e
    },
    notifyFailure: n => void failures.push(n),
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  const bad = h.ingress.open('d2', 'cipher:bad')
  bad.ready(() => Promise.reject(new Error('decrypt failed')))
  expect(await bad.done).toBe('blocked')
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 4; i++) await flush()
  expect(failures, 'reported once for this generation').toEqual(['n'])
  expect(controller.isSaving('n'), 'blocked: not saving').toBe(false)
  // HEAL, and get inside the resumed build
  const heal = h.ingress.open('d2', 'cipher:good')
  heal.ready(async () => {})
  expect(await heal.done).toBe('applied')
  await encryptStarted.promise
  expect(controller.isSaving('n'), 'building: saving').toBe(true)
  // RE-BLOCK during the build, then let the attempt finish and refuse
  const bad2 = h.ingress.open('d3', 'cipher:bad2')
  bad2.ready(() => Promise.reject(new Error('decrypt failed')))
  expect(await bad2.done).toBe('blocked')
  // THE SUB-WINDOW: a build in progress stays saving even though the gate just blocked. a formula
  // that gated `building` on the gate would pass everything else in this row
  expect(controller.isSaving('n'), 'building stays saving across a gate block').toBe(true)
  encrypting.resolve()
  await secondWake.promise // the retry has parked again: the exact completion signal
  expect(controller.isSaving('n'), 'false after refusal and requeue').toBe(false)
  expect(failures, 'and STILL one report for this generation').toEqual(['n'])
  expect(
    h.calls.filter(c => c.op == 'create' || c.op == 'update'),
    'nothing was written'
  ).toHaveLength(0)
})

test('an ADOPTED create whose encryption rejects after stop does not finalize the adoption', async () => {
  // round 62: the confirmation-rejection row rejects BEFORE survivor selection, while adopt_id is
  // null, so it only ever exercised the fresh-wrapper removeHidden arm. this reaches the
  // finalizeAdoption arm, which a mutant could take after stop with all 84 tests still green
  const failures: string[] = []
  const published: string[] = []
  const encrypting = deferred<void>()
  const encryptStarted = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    // the server CONFIRMS the survivor, so the create adopts it rather than the slice being
    // replaced with nothing (an empty answer legitimately removes it now)
    confirmTarget: (name, hooks) =>
      serverAnswer([{ id: 'd1', name: 'n', item: { server: 1 } }], undefined, () => h.ingress.gate())(name, hooks),
    syncOwner: n => void published.push(n),
    notifyFailure: n => void failures.push(n),
    encryptState: async state => {
      encryptStarted.resolve()
      await encrypting.promise
      return state as any
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  h.idx.byName.delete('n') // a survivor that does not hold the name: the create ADOPTS it
  controller.save('n', { mine: 1 })
  await encryptStarted.promise
  const pending = [...h.idx.byId.values()].find(w => w.adopt_id)!
  expect(pending.adopt_id, 'a real adoption is in flight').toBe('d1')
  const idsBefore = [...h.idx.byId.keys()]
  controller.stop()
  expect(failures, 'stop reported this generation once').toEqual(['n'])
  published.length = 0
  encrypting.reject(new Error('rejected after stop'))
  for (let i = 0; i < 8; i++) await flush()
  expect(pending.adopt_id, 'the adoption was NOT finalized').toBe('d1')
  expect([...h.idx.byId.keys()], 'and no index mutation').toEqual(idsBefore)
  expect(published, 'and nothing published').toEqual([])
  expect(failures, 'and no second report').toEqual(['n'])
})

test('an ISSUED update rejecting not-found after stop starts no recovery', async () => {
  // issueWrite's not-found path invalidates authority, removes the live wrapper and schedules a
  // rebuild. after stop none of that may happen -- and removing only that guard left all 84
  // persistence tests green
  const invalidations: string[] = []
  const rejectWrite = deferred<void>()
  const writeIssued = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    invalidateAuthority: r => void invalidations.push(r),
    updateDoc: async () => {
      writeIssued.resolve()
      await rejectWrite.promise
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  controller.save('n', { mine: 1 })
  await writeIssued.promise
  const idsBefore = [...h.idx.byId.keys()]
  controller.stop()
  rejectWrite.reject(Object.assign(new Error('No document to update'), { code: 'not-found' }))
  for (let i = 0; i < 8; i++) await flush()
  expect(invalidations, 'no authority invalidation after stop').toEqual([])
  expect([...h.idx.byId.keys()], 'the live wrapper was not removed').toEqual(idsBefore)
  expect(
    h.calls.filter(c => c.op == 'create'),
    'and no recovery create'
  ).toHaveLength(0)
  expect(controller.owes('n'), 'the intent is retained').toBe(true)
})

// ---- applyRemote publishes ONE operation to every affected tail (rounds 62-63) ----
// ONE schedule replaces four timer-heavy partial rows. It kills, together: the idle-name filter,
// delayed/recursive reservation of the idle name, waiting on only some predecessors,
// fulfillment-only predecessor handling, a discarded async result, a lost own rejection, and tail
// poisoning. Everything is driven by deferreds -- no flush loops

test('the shared tail: every affected name reserved at once, behind every predecessor', async () => {
  const h = harness()
  const controller = createHiddenPersistence(h.deps)
  const A = deferred<void>()
  const C = deferred<void>()
  // prior tails on A and C; B is IDLE
  void controller.applyRemote(['A'], () => A.promise)
  void controller.applyRemote(['C'], () => C.promise)
  const s1Body = deferred<void>()
  let s1Runs = 0
  const s1 = controller.applyRemote(['A', 'B', 'C'], async () => {
    s1Runs++
    await s1Body.promise
  })
  let s2Ran = false
  const s2 = controller.applyRemote(['B'], () => void (s2Ran = true)) // newer, on the IDLE name
  // A REJECTS while C is still held: neither may start
  A.reject(new Error('predecessor A failed'))
  await checkpoint()
  expect(s1Runs, 'S1 waits for EVERY predecessor, not just one').toBe(0)
  expect(s2Ran, 'and S2 is behind S1 on the idle name B').toBe(false)
  // C resolves: S1 starts, exactly once, and S2 is still held by its async body. asserting on a
  // CHECKPOINT rather than awaiting s1Started makes a Promise.all mutant fail here immediately
  // (S1 never runs at all) instead of hanging until the suite timeout
  C.resolve()
  await checkpoint()
  expect(s1Runs, 'exactly once, and it DID run: a fulfillment-only wait would skip it').toBe(1)
  expect(s2Ran, "S2 is behind S1's ASYNC body, not merely its invocation").toBe(false)
  // S1 rejects: its OWN result rejects, and S2 still runs
  s1Body.reject(new Error('S1 failed'))
  await expect(s1).rejects.toThrow('S1 failed')
  await s2
  expect(s2Ran, 'a rejected operation does not poison the tail it published to').toBe(true)
})

test('a reentrant same-name operation is not overwritten by its outer publication', async () => {
  // the exact window the old synchronous no-predecessor branch opened: the inner call published
  // its tail, then the outer publication replaced it, and a follower passed the inner work
  const h = harness()
  const controller = createHiddenPersistence(h.deps)
  const inner = deferred<void>()
  let innerDone = false
  let followerRan = false
  const outer = controller.applyRemote(['n'], () => {
    // synchronously queue async same-name work from inside the Apply
    void controller.applyRemote(['n'], async () => {
      await inner.promise
      innerDone = true
    })
  })
  await outer
  void controller.applyRemote(['n'], () => void (followerRan = true))
  await checkpoint()
  expect(followerRan, 'the follower is behind the INNER work, not just the outer call').toBe(false)
  inner.resolve()
  await checkpoint()
  expect(innerDone).toBe(true)
  expect(followerRan).toBe(true)
})

test('stop cancels a REGISTERED coordinator wake, and later healing resumes nothing', async () => {
  // the round-60 row that was still missing: previous stop tests never registered a real wake, so
  // nothing pinned the cancellation. this one waits for the actual subscription before stopping
  let acquisitions = 0
  let registered = 0
  let cancelled = 0
  const wakeRegistered = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    acquireSecret: async () => void ++acquisitions,
    whenActionable: () => {
      if (++registered == 1) wakeRegistered.resolve()
      const sub = h.ingress.whenActionable()
      return {
        promise: sub.promise,
        cancel() {
          cancelled++
          sub.cancel()
        },
      }
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  const held = h.ingress.open('d2', 'cipher:d2') // the gate is pending: the writer parks
  controller.save('n', { mine: 1 })
  await wakeRegistered.promise
  controller.stop()
  // the SUBSCRIPTION itself is released, not merely ignored: a stopped page must not retain a
  // coordinator waiter for the rest of its life
  expect(cancelled, 'stop cancelled the registered wake').toBe(1)
  // healing after stop must wake nobody
  held.ready(async () => {})
  expect(await held.done).toBe('applied')
  for (let i = 0; i < 6; i++) await flush()
  expect(acquisitions, 'no secret work after stop, even once the gate opens').toBe(0)
  expect(
    h.calls.filter(c => c.op == 'create' || c.op == 'update'),
    'and no write'
  ).toHaveLength(0)
  expect(controller.owes('n'), 'the intent is retained').toBe(true)
})

test('stop before a queued name-chain turn runs: the chain-entry check does no secret work', async () => {
  // the OTHER round-60 row: a turn already sitting in the chain queue when stop lands. the
  // predecessor is a real applyRemote tail, not an SDK acknowledgement (round 63)
  let acquisitions = 0
  const predecessor = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({ ...h.deps, acquireSecret: async () => void ++acquisitions })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  void controller.applyRemote(['n'], () => predecessor.promise) // holds the 'n' chain
  controller.save('n', { mine: 1 })
  await checkpoint()
  expect(acquisitions, 'the writer is queued behind the held chain').toBe(0)
  controller.stop()
  predecessor.resolve() // the queued persistOwed turn now runs
  for (let i = 0; i < 6; i++) await flush()
  expect(acquisitions, 'and refuses at chain entry, before acquiring anything').toBe(0)
  expect(
    h.calls.filter(c => c.op == 'create' || c.op == 'update'),
    'no write'
  ).toHaveLength(0)
})

test('a rejected Apply on a name chain is consumed by ORDINARY queued work, not just by applyRemote', async () => {
  // publishing the RAW result made enqueue's rejection arm — `.then(task, task)` — load-bearing.
  // the A/C/B row proves another applyRemote consumes a rejected predecessor through allSettled;
  // this proves acknowledgement settlement does too, which is the production shape: an ack really
  // can enter the name chain while a delivery Apply owns it
  const ack = deferred<void>()
  const applyBody = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    updateDoc: async (id, data) => {
      h.calls.push({ op: 'update', id, text: data.cipher })
      await ack.promise
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  controller.save('n', { mine: 1 })
  await checkpoint()
  expect(
    h.calls.filter(c => c.op == 'update'),
    'the write is issued and awaiting its ack'
  ).toHaveLength(1)
  // a same-name Apply is now running and held
  const application = controller.applyRemote(['n'], () => applyBody.promise)
  await checkpoint()
  // the acknowledgement resolves WHILE that Apply owns the chain: its settlement queues behind
  // the still-held raw tail
  ack.resolve()
  await checkpoint()
  expect(controller.owes('n'), 'settlement has not run yet: it is behind the Apply').toBe(true)
  const follower = controller.applyRemote(['n'], () => {})
  applyBody.reject(new Error('the Apply failed'))
  await expect(application).rejects.toThrow('the Apply failed')
  await follower // the exact drain boundary
  expect(controller.owes('n'), 'the queued settlement ran THROUGH the rejected predecessor').toBe(false)
})

test('applyRemote with NO affected name still starts asynchronously and rejects a synchronous throw', async () => {
  // the design's asynchronous direct path: no name to reserve, but the body must not run in the
  // caller's turn, and a synchronous throw must arrive as a rejection like any other
  const h = harness()
  const controller = createHiddenPersistence(h.deps)
  let ran = false
  const direct = controller.applyRemote(undefined, () => void (ran = true))
  expect(ran, 'not in the calling turn').toBe(false)
  await direct
  expect(ran).toBe(true)
  const boom = new Error('synchronous throw')
  await expect(
    controller.applyRemote(undefined, () => {
      throw boom
    })
  ).rejects.toBe(boom)
})

// ---- the own-unacknowledged-create marker ----

// THE MARKER'S CONTROLLER-LEVEL EFFECT IS NOT YET OBSERVABLE, and no test here claims it.
// confirmTarget is wired into the CREATE path only; a second save for the same name finds the
// holder finalizeCreate registered at ISSUE time and takes the UPDATE path, which does not
// confirm. So a controller row for "the marker preserved our unacknowledged create through a
// confirmation" passes with the marker never set at all -- I wrote one, mutated it, and deleted
// it rather than ship it. The marker's DECISION is pinned purely in hidden_confirm.spec.ts; its
// wiring becomes observable when confirmTarget-before-update lands for fixed pages.

// NOTE the UPDATE path does not confirm yet. The design scopes confirmTarget-before-update to
// FIXED PAGES, and the controller has no fixed-page input; wiring that is the remaining half of
// this cut. So "the marker stops protecting once the create is acknowledged" has no observable
// consequence to assert here yet, and is deliberately NOT claimed.

test('the marker protects only its OWN id: another stale row is still removed', () => {
  // the exemption is an exact-target confirmation exemption and never overrides name selection.
  // a blanket or name-wide exemption would preserve records the read genuinely disproved
  const marker: Marker = { id: 'mine', wrapper: { m: 1 }, token: 1 }
  const plan = planTargetSlice({
    name: 'n',
    local: [
      { id: 'mine', name: 'n', wrapper: marker.wrapper },
      { id: 'stale', name: 'n', wrapper: {} },
    ],
    answer: new Map(),
    marker,
  })
  expect(plan.remove, 'only the unprotected row goes').toEqual(['stale'])
  expect(plan.preservedMarker).toBe(marker)
})

// ---- fixed pages confirm before UPDATING, and the marker exempts the exact target ----

test('a fixed page confirms before an update, and writes to the CONFIRMED target', async () => {
  // a stale lower-id holder the server no longer has would otherwise keep winning re-resolution
  // and receive the very update confirmation exists to prevent
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmsUpdates: true,
    // the server has 'srv' under this name; local 'stale' is gone
    confirmTarget: (name, hooks) =>
      serverAnswer([{ id: 'srv', name: 'n', item: { server: 1 } }], h.calls, () => h.ingress.gate())(name, hooks),
  })
  registerHidden(h.idx, { id: 'stale', name: 'n', item: { old: 1 } }, () => {})
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 10; i++) await flush()
  expect(
    h.calls.filter(c => c.op == 'confirm'),
    'it confirmed'
  ).toHaveLength(1)
  const updates = h.calls.filter(c => c.op == 'update')
  expect(
    updates.map(c => c.id),
    'and wrote to the confirmed target, never the stale one'
  ).toEqual(['srv'])
  expect(h.idx.byId.has('stale'), 'the disproved row was removed').toBe(false)
})

test('the direct bypass skips confirmation for our own unacknowledged create — and only for it', async () => {
  // the exemption is exact-target: same id and token with a DIFFERENT canonical wrapper does not
  // qualify, because registerHidden replaces the indexed object on a fresh same-id observation
  const ack = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmsUpdates: true,
    createDoc: async (id, data) => {
      h.calls.push({ op: 'create', id, text: data.cipher })
      await ack.promise // unacknowledged: the marker stands
    },
    confirmTarget: (name, hooks) => serverAnswer([], h.calls, () => h.ingress.gate())(name, hooks),
  })
  controller.save('n', { v: 1 })
  for (let i = 0; i < 8; i++) await flush()
  const created = h.calls.find(c => c.op == 'create')!.id!
  const confirmsAfterCreate = h.calls.filter(c => c.op == 'confirm').length
  // a SECOND save updates that same unacknowledged create: the bypass applies, so no confirmation
  controller.save('n', { v: 2 })
  for (let i = 0; i < 10; i++) await flush()
  expect(h.calls.filter(c => c.op == 'confirm').length, 'bypassed: no second confirmation').toBe(confirmsAfterCreate)
  expect(
    h.calls.filter(c => c.op == 'update').map(c => c.id),
    'and it updated the create'
  ).toEqual([created])
  expect(h.idx.byId.has(created), 'which an unbypassed empty answer would have deleted').toBe(true)
  ack.resolve()
})

test('a fresh same-id observation defeats the bypass: the wrapper is no longer ours', async () => {
  const ack = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmsUpdates: true,
    createDoc: async (id, data) => {
      h.calls.push({ op: 'create', id, text: data.cipher })
      await ack.promise
    },
    // the FIRST confirmation answers empty so a real create happens; later ones show a server row
    confirmTarget: (name, hooks) =>
      serverAnswer(
        h.calls.some(c => c.op == 'create') ? [{ id: 'replaced', name: 'n', item: { server: 1 } }] : [],
        h.calls,
        () => h.ingress.gate()
      )(name, hooks),
  })
  controller.save('n', { v: 1 })
  for (let i = 0; i < 8; i++) await flush()
  const created = h.calls.find(c => c.op == 'create')!.id!
  const before = h.calls.filter(c => c.op == 'confirm').length
  // the indexed object for that id is REPLACED — a fresh same-id observation. the marker's id and
  // token are unchanged, but its wrapper is not the canonical object any more
  registerHidden(h.idx, { id: created, name: 'n', item: { fresh: 1 } }, () => {})
  controller.save('n', { v: 2 })
  for (let i = 0; i < 10; i++) await flush()
  expect(h.calls.filter(c => c.op == 'confirm').length, 'NOT bypassed: it confirmed').toBeGreaterThan(before)
  ack.resolve()
})

// ---- acknowledgement versus the exact echo ----

test('acknowledgement BEFORE any echo: cleared, not reconciled, and the waiter is disposed', async () => {
  // on a fixed/shared page the live query is the shared subset, so a hidden write's echo may never
  // arrive at all. the old per-id flag read "no entry" as SUCCESS and reconciled the owner from an
  // index that never took the write
  const reconciled: string[] = []
  const h = harness()
  const controller = createHiddenPersistence({ ...h.deps, reconcileOwner: n => void reconciled.push(n) })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 8; i++) await flush()
  expect(
    h.calls.filter(c => c.op == 'update'),
    'the write was acknowledged'
  ).toHaveLength(1)
  expect(controller.owes('n'), 'and the record is cleared').toBe(false)
  expect(reconciled, 'but the owner is NOT reconciled from an echo that never came').toEqual([])
  // a LATER delivery for that id must not be mistaken for the disposed waiter's echo
  const issued = h.calls.find(c => c.op == 'update')!.text!
  await arrive(controller, h.idx, { id: 'd1', name: 'n', item: { mine: 1 } }, h.ingress, issued)
  for (let i = 0; i < 6; i++) await flush()
  expect(reconciled, 'the waiter was disposed at settlement').toEqual([])
})

// ---- ECHO WAITER OWNERSHIP -------------------------------------------------------------------
// An armed waiter is a retained resolver plus the controller state its reactions captured. On a
// fixed page the echo may never enter the live shared query at all, so a waiter nobody disposes
// lives for the page's lifetime. DISPOSAL IS NOT OBSERVABLE THROUGH BEHAVIOUR — a stale waiter's
// reaction finds no current generation and does nothing visible — so these rows spy on the
// coordinator's own cancel. They are the only rows that may: matching and ordering stay on the
// real coordinator above.

// wraps the real armEcho so cancellation is countable, per (id, cipher)
function echoSpy() {
  const ingress = createHiddenIngress()
  const cancelled: string[] = []
  let armed = 0
  return {
    ingress,
    cancelled,
    armedCount: () => armed,
    armEcho: (id: string, cipher: string) => {
      armed++
      const sub = ingress.armEcho(id, cipher)
      return {
        promise: sub.promise,
        cancel: () => {
          cancelled.push(id)
          sub.cancel()
        },
      }
    },
  }
}

test('an acknowledgement with no echo DISPOSES the waiter it armed', async () => {
  const spy = echoSpy()
  const h = harness()
  const controller = createHiddenPersistence({ ...h.deps, armEcho: spy.armEcho, gate: () => spy.ingress.gate() })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 8; i++) await flush()
  expect(spy.armedCount(), 'one write, one waiter').toBe(1)
  expect(spy.cancelled, 'and it is disposed at settlement').toEqual(['d1'])
})

test('a SUPERSEDING save disposes the outgoing generation‘s waiter', async () => {
  const spy = echoSpy()
  const ack = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    armEcho: spy.armEcho,
    gate: () => spy.ingress.gate(),
    updateDoc: async (id, data) => {
      h.calls.push({ op: 'update', id, text: data.cipher })
      await ack.promise // held: the first generation is still issued when the second arrives
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 8; i++) await flush()
  expect(spy.armedCount()).toBe(1)
  expect(spy.cancelled, 'still outstanding: the write has not acknowledged').toEqual([])
  controller.save('n', { mine: 2 }) // supersedes generation one
  expect(spy.cancelled, 'the outgoing generation‘s waiter dies with it, synchronously').toEqual(['d1'])
  ack.resolve()
  for (let i = 0; i < 8; i++) await flush()
})

test('STOP disposes an offline write‘s waiter, whose sdk promise will never settle', async () => {
  const spy = echoSpy()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    armEcho: spy.armEcho,
    gate: () => spy.ingress.gate(),
    // firestore keeps an offline write pending indefinitely: nothing else will ever reach this
    // waiter, so stop is the only remaining owner
    updateDoc: async (id, data) => {
      h.calls.push({ op: 'update', id, text: data.cipher })
      await new Promise(() => {})
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 8; i++) await flush()
  expect(spy.armedCount()).toBe(1)
  expect(spy.cancelled).toEqual([])
  controller.stop()
  expect(spy.cancelled, 'stop owns what nothing else can reach').toEqual(['d1'])
})

test('a SYNCHRONOUS sdk throw disposes the waiter and clears the create marker', async () => {
  const spy = echoSpy()
  const h = harness()
  const boom = new Error('sdk refused synchronously')
  const controller = createHiddenPersistence({
    ...h.deps,
    armEcho: spy.armEcho,
    gate: () => spy.ingress.gate(),
    createDoc: (() => {
      throw boom
    }) as any,
    // the create path: nothing holds the name, so the writer confirms and then creates
    confirmTarget: async (_name, hooks) => hooks.commit(new Map(), hooks.captureReadMarker()),
    notifyFailure: () => {},
  })
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 10; i++) await flush()
  expect(spy.armedCount(), 'the waiter was armed immediately before the sdk call').toBe(1)
  expect(spy.cancelled, 'and disposed when it threw').toHaveLength(1)
  expect(controller.owes('n'), 'the intent is retained for a page that can still write').toBe(true)
  // THE MARKER is cleared here too, but that is HYGIENE, not a load-bearing rule, and this row does
  // not pretend otherwise (round 73 asked for the pin and this is the answer). issueWrite installs
  // the marker before the SDK call and `finalizeCreate` runs only AFTER it returns, so a
  // synchronous throw leaves the marker pointing at a wrapper that never entered the index at all:
  // it is absent from `local`, so the plan can never preserve it; `bypassesConfirmation` compares
  // object identity against the current holder, which is a different object; and the next create
  // for this name overwrites it. Every reader is covered, and none of them can see it.
  expect(
    [...h.idx.byId.values()].filter(w => w.name == 'n'),
    'the never-written create left nothing in the index for a marker to exempt'
  ).toEqual([])
  // what IS load-bearing is asserted by the marker table above: clearing on fulfilment and on
  // rejection, where the wrapper HAS finalized and a retained marker really would exempt it
})

test('a BLOCKED echo does not reconcile: the index may still hold the pre-write state', async () => {
  const reconciled: string[] = []
  const warnings: string[] = []
  const ack = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    reconcileOwner: n => void reconciled.push(n),
    updateDoc: async (id, data) => {
      h.calls.push({ op: 'update', id, text: data.cipher })
      await ack.promise
    },
  })
  const realWarn = console.warn
  console.warn = (...a: any[]) => void warnings.push(String(a[0]))
  try {
    registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
    controller.save('n', { mine: 1 })
    for (let i = 0; i < 8; i++) await flush()
    const issued = h.calls.find(c => c.op == 'update')!.text!
    // our echo arrives but its APPLICATION fails: the delivery is blocked
    const handle = h.ingress.open('d1', issued)
    handle.ready(() => Promise.reject(new Error('application failed')))
    expect(await handle.done).toBe('blocked')
    ack.resolve()
    for (let i = 0; i < 8; i++) await flush()
    expect(reconciled, 'the owner already holds what we wrote; reconciling would roll it back').toEqual([])
    expect(
      warnings.some(w => w.includes('did not apply')),
      'and it says so'
    ).toBe(true)
  } finally {
    console.warn = realWarn
  }
})

test('an echo terminalizing in the SAME turn as the acknowledgement is still seen', async () => {
  // the causal microtask: handle.done resolving queues the waiter's reaction as a microtask, so a
  // settlement that read the recorded outcome immediately would see nothing and skip
  // reconciliation for an echo that HAD arrived
  const reconciled: string[] = []
  const ack = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    reconcileOwner: n => void reconciled.push(n),
    updateDoc: async (id, data) => {
      h.calls.push({ op: 'update', id, text: data.cipher })
      await ack.promise
    },
  })
  registerHidden(h.idx, { id: 'd1', name: 'n', item: { server: 1 } }, () => {})
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 8; i++) await flush()
  const issued = h.calls.find(c => c.op == 'update')!.text!
  const handle = h.ingress.open('d1', issued)
  // terminalize the echo and resolve the acknowledgement in the SAME synchronous turn, without
  // awaiting handle.done in between
  handle.ready(async () => {})
  ack.resolve()
  for (let i = 0; i < 8; i++) await flush()
  expect(reconciled, 'the echo was recorded in time').toEqual(['n'])
})

// ---- marker scope and provenance (round 71) ----

test('markers are PER NAME: a concurrent create for another name does not clobber ours', async () => {
  // ONE controller-wide slot was wrong. write construction serializes per NAME, so two names can
  // hold unacknowledged creates at once: B's marker replaced A's, a later fixed-page save for A no
  // longer bypassed, and a complete read that legitimately omits unacknowledged A removed its
  // wrapper and let the retry allocate a duplicate
  const ackA = deferred<void>()
  const ackB = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmsUpdates: true,
    createDoc: async (id, data) => {
      h.calls.push({ op: 'create', id, text: data.cipher })
      await (data.cipher!.includes('"A"') ? ackA.promise : ackB.promise)
    },
    // every confirmation answers EMPTY: without a live marker the slice replacement removes the
    // unacknowledged create's wrapper
    confirmTarget: (name, hooks) => serverAnswer([], h.calls, () => h.ingress.gate())(name, hooks),
  })
  controller.save('nameA', { v: 'A' })
  for (let i = 0; i < 8; i++) await flush()
  controller.save('nameB', { v: 'B' }) // a SECOND name's create, also unacknowledged
  for (let i = 0; i < 8; i++) await flush()
  const createdA = h.calls.find(c => c.op == 'create' && c.text!.includes('"A"'))!.id!
  expect(h.idx.byId.has(createdA), "A's wrapper is in the index").toBe(true)
  // a second save for A must still bypass, and must not lose its wrapper
  controller.save('nameA', { v: 'A2' })
  for (let i = 0; i < 10; i++) await flush()
  expect(h.idx.byId.has(createdA), "A's marker survived B's create").toBe(true)
  expect(
    h.calls.filter(c => c.op == 'create' && c.text!.includes('"A')),
    'no duplicate for A'
  ).toHaveLength(1)
  // "no second create" is the weak half: the save must UPDATE A's ORIGINAL document, carrying the
  // new payload. a bypass that issued nothing at all would also produce no second create
  const updatesA = h.calls.filter(c => c.op == 'update' && c.id == createdA)
  expect(
    updatesA.map(u => u.text),
    "the second save updated A's own id with its new state"
  ).toEqual(['cipher:{"name":"nameA","item":{"v":"A2"}}'])
  ackA.resolve()
  ackB.resolve()
})

test('the PRECOMMIT marker CAS runs before the first effect, even when a fresh lower row would win', async () => {
  // preservation of the omitted create used the read-start proof, so if that proof settled while
  // the answer was in flight the whole result is inconclusive with ZERO effects — the plan was
  // built on a fact that is no longer true. this holds EVEN THOUGH fresh lower `a` would have won
  // selection: it is the plan as a whole that is void, not just its marker dependency
  const ack = deferred<void>()
  const removed: string[] = []
  const registered: string[] = []
  // the effect log AT THE MOMENT the refused attempt requeues and confirms again — the window the
  // CAS is about. a whole-test count cannot be used: the retry legitimately does mutate
  let atRequeue: { registered: string[]; removed: string[] } | undefined
  let attempt = 0
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmsUpdates: true,
    createDoc: async (id, data) => {
      h.calls.push({ op: 'create', id, text: data.cipher })
      await ack.promise // `m` stays unacknowledged, so its marker is live at read start
    },
    registerTargetRow: (wrapper, merge) => void (registered.push(wrapper.id), registerHidden(h.idx, wrapper, merge)),
    confirmTarget: async (name, hooks) => {
      // (1) resolves the create itself: nothing is owed a marker yet
      if (++attempt == 1) return serverAnswer([], h.calls, () => h.ingress.gate())(name, hooks)
      if (attempt > 2) {
        atRequeue ??= { registered: [...registered], removed: [...removed] }
        return serverAnswer([], h.calls, () => h.ingress.gate())(name, hooks)
      }
      // (2) THE SCHEDULE. the marker is live at read start ...
      const marker = hooks.captureReadMarker()
      expect(marker, 'the unacknowledged create is the read-start proof').toBeTruthy()
      // ... and SETTLES while the answer is in flight
      ack.resolve()
      for (let i = 0; i < 8; i++) await flush()
      // the answer omits the create (legitimately: the server has not published it) and carries
      // fresh lower `a`, which WOULD win selection
      const answer = new Map([
        ['a', { id: 'a', kind: 'hidden' as const, name, wrapper: { id: 'a', name, item: {} }, eligible: true }],
      ])
      return hooks.commit(answer, marker)
    },
  })
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 10; i++) await flush()
  const m = h.calls.find(c => c.op == 'create')!.id!
  // a stale LOWER row is canonical locally, so the next save CONFIRMS rather than taking the
  // direct marker bypass — the bypass never reaches the plan, and a schedule without this row
  // proves nothing about the CAS at all
  registerHidden(h.idx, { id: 'a', name: 'n', item: { stale: 1 } }, () => undefined)
  expect(h.idx.byName.get('n')!.id, '`a` sorts below the created id and wins selection').toBe('a')
  const realRemove = h.idx.byId.delete.bind(h.idx.byId)
  h.idx.byId.delete = (id: string) => (removed.push(id), realRemove(id))
  controller.save('n', { mine: 2 })
  for (let i = 0; i < 24; i++) await flush()
  expect(attempt, 'the refused attempt requeued and confirmed again').toBeGreaterThan(2)
  // WITHOUT the CAS, fresh `a` is registered from a plan whose preservation of `m` rested on a
  // proof that had already settled
  expect(atRequeue, 'ZERO effects from the plan built on a settled proof').toEqual({ registered: [], removed: [] })
  // the retry is a DIFFERENT question and legitimately mutates: by then the create has
  // acknowledged, so a complete read that omits it really does disprove it
  void m
})

test('a create marker is cleared on FULFILMENT and on REJECTION, so neither exempts a later read', async () => {
  // the marker is an exemption from confirmation. left installed after the sdk settles, it exempts
  // a document that either already exists on the server (fulfilment: the read can see it) or was
  // never written at all (rejection) — the second is how a stale wrapper survives every complete
  // read that legitimately disproves it
  for (const outcome of ['fulfil', 'reject'] as const) {
    const ack = deferred<void>()
    const h = harness()
    const removed: string[] = []
    const controller = createHiddenPersistence({
      ...h.deps,
      confirmsUpdates: true,
      notifyFailure: () => {},
      createDoc: async (id, data) => {
        h.calls.push({ op: 'create', id, text: data.cipher })
        await ack.promise
        if (outcome == 'reject') throw Object.assign(new Error('permission denied'), { code: 'permission-denied' })
      },
      // EMPTY, always: only a live marker can preserve the create's wrapper through this
      confirmTarget: (name, hooks) => serverAnswer([], h.calls, () => h.ingress.gate())(name, hooks),
    })
    controller.save('n', { mine: 1 })
    for (let i = 0; i < 8; i++) await flush()
    const created = h.calls.find(c => c.op == 'create')!.id!
    expect(h.idx.byId.has(created), `${outcome}: the create's wrapper is indexed`).toBe(true)
    ack.resolve() // the sdk promise settles: the marker must clear either way
    for (let i = 0; i < 10; i++) await flush()
    const realRemove = h.idx.byId.delete.bind(h.idx.byId)
    h.idx.byId.delete = (id: string) => (removed.push(id), realRemove(id))
    controller.save('n', { mine: 2 })
    for (let i = 0; i < 14; i++) await flush()
    expect(removed, `${outcome}: the empty answer disproves the wrapper, with no marker to exempt it`).toContain(
      created
    )
  }
})

test('a CONFIRMED update refuses when its requiredMarker settles in the continuation gap', async () => {
  // the other half of the same rule. the confirmation RETURNED a marker dependency, meaning the
  // selected target is a wrapper only that marker preserved — so if it settles between the
  // confirmation returning and the re-resolution, the whole answer rests on a fact that no longer
  // holds and the attempt must requeue with zero post-confirmation effects
  const ack = deferred<void>()
  let attempt = 0
  let confirmsAtFirstWrite = -1
  let encryptions = 0
  let publications = 0
  // the effect counters at the two ends of the refused attempt: everything it would have done —
  // re-resolution, owner publication, a full encryption — happens between them
  let afterCommit: { encryptions: number; publications: number } | undefined
  let atRequeue: { encryptions: number; publications: number } | undefined
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmsUpdates: true,
    encryptState: async state => {
      encryptions++
      return h.deps.encryptState(state)
    },
    syncOwner: () => void publications++,
    createDoc: async (id, data) => {
      h.calls.push({ op: 'create', id, text: data.cipher })
      await ack.promise
    },
    updateDoc: async (id, data) => {
      if (confirmsAtFirstWrite < 0) confirmsAtFirstWrite = attempt
      h.calls.push({ op: 'update', id, text: data.cipher })
    },
    confirmTarget: async (name, hooks) => {
      h.calls.push({ op: 'confirm' })
      attempt++
      if (attempt == 1) return hooks.commit(new Map(), hooks.captureReadMarker()) // resolves the create
      const marker = hooks.captureReadMarker()
      // ATTEMPT 2 disproves stale lower `a` and OMITS the create, so the preserved wrapper is the
      // only survivor — which is exactly when a requiredMarker is returned. LATER attempts see the
      // create published, as the server would once it acknowledged
      const created = h.idx.byId.get(h.calls.find(c => c.op == 'create')!.id!)
      const answer = new Map<string, any>([['a', { id: 'a', kind: 'absent' as const }]])
      if (attempt > 2 && created)
        answer.set(created.id, {
          id: created.id,
          kind: 'hidden' as const,
          name,
          wrapper: created,
          eligible: true,
        })
      const result = hooks.commit(answer, marker)
      if (attempt == 2) {
        // ... and it settles in the CONTINUATION GAP, after commit and before the caller resumes
        ack.resolve()
        for (let i = 0; i < 8; i++) await flush()
        afterCommit = { encryptions, publications }
      }
      if (attempt > 2) atRequeue ??= { encryptions, publications }
      return result
    },
  })
  controller.save('n', { v: 1 })
  for (let i = 0; i < 10; i++) await flush()
  const m = h.calls.find(c => c.op == 'create')!.id!
  // a stale LOWER row, so the DIRECT bypass cannot apply and the confirmation path is taken
  registerHidden(h.idx, { id: 'a', name: 'n', item: { stale: 1 } }, () => undefined)
  controller.save('n', { v: 2 })
  for (let i = 0; i < 24; i++) await flush()
  expect(
    h.calls.filter(c => c.op == 'update').map(c => c.id),
    'the write eventually goes out, to the preserved document'
  ).toEqual([m])
  expect(confirmsAtFirstWrite, 'the refused attempt re-confirmed before writing').toBeGreaterThan(2)
  // and it refused with ZERO POST-CONFIRMATION EFFECTS. the check before the ISSUE would catch the
  // settled marker either way; this one is what makes the refusal a cheap retry rather than a
  // wasted re-resolution, owner publication and full encryption
  expect(atRequeue, 'the refused attempt did nothing after its commit').toEqual(afterCommit)
})

test('a bypassed update REFUSES when the create settles during its encryption', async () => {
  // the bypass skipped confirmation BECAUSE the marker was live, so the attempt depends on it
  // staying live. without carrying that proof, an exempted update issued after settlement
  const ack = deferred<void>()
  const encrypting = deferred<void>()
  let encryptions = 0
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmsUpdates: true,
    createDoc: async (id, data) => {
      h.calls.push({ op: 'create', id, text: data.cipher })
      await ack.promise
    },
    encryptState: async state => {
      const e: any = state
      e.cipher = 'cipher:' + state.text
      e.text = null
      if (++encryptions == 2) await encrypting.promise // hold the UPDATE's encryption
      return e
    },
    confirmTarget: (name, hooks) => serverAnswer([], h.calls, () => h.ingress.gate())(name, hooks),
  })
  controller.save('n', { v: 1 })
  for (let i = 0; i < 8; i++) await flush()
  controller.save('n', { v: 2 }) // bypasses, and is now held in encryption
  for (let i = 0; i < 6; i++) await flush()
  const updatesBefore = h.calls.filter(c => c.op == 'update').length
  // taken while the bypassed attempt is still held in encryption: it skipped confirmation, so
  // this is the count the refusal has to move
  const confirmsBefore = h.calls.filter(c => c.op == 'confirm').length
  ack.resolve() // the create settles: the marker clears
  for (let i = 0; i < 4; i++) await flush()
  encrypting.resolve()
  for (let i = 0; i < 6; i++) await flush()
  expect(h.calls.filter(c => c.op == 'update').length, 'the exempted payload did not issue').toBe(updatesBefore)
  // REFUSING is only half the contract: the change is still owed, so the attempt must RETRY
  // through a fresh confirmation. a controller that refused and then sat idle would also pass the
  // assertion above, and the save would be silently lost
  for (let i = 0; i < 14; i++) await flush()
  expect(
    h.calls.filter(c => c.op == 'confirm').length,
    'the refused attempt RE-CONFIRMED instead of trusting the settled marker'
  ).toBeGreaterThan(confirmsBefore)
  // and it wrote what was owed. this harness answers EMPTY every time, so a fresh confirmation
  // legitimately resolves to a new document; what matters is that v: 2 reached the server through
  // a re-resolved target rather than being dropped
  expect(
    h.calls.filter(c => c.op != 'confirm').map(c => c.text),
    'the owed state was written through the re-resolved target'
  ).toEqual(['cipher:{"name":"n","item":{"v":1}}', 'cipher:{"name":"n","item":{"v":2}}'])
  expect(controller.owes('n'), 'and nothing is left owed').toBe(false)
})

// ---- the a/m schedule, and one effect-log table for the commit's call counts ----

test('the a/m schedule: stale lower `a` is removed, unacknowledged `m` is preserved and updated once', async () => {
  // the schedule the design names as the reason the COMMIT belongs to the controller: create `m`
  // issued and unacknowledged, stale lower `a` canonical, and a confirmation answer containing
  // NEITHER. an adapter-only slice replacement removes both, and re-resolution then creates a
  // second document instead of updating `m` behind its own create
  const ack = deferred<void>()
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmsUpdates: true,
    createDoc: async (id, data) => {
      h.calls.push({ op: 'create', id, text: data.cipher })
      await ack.promise // `m` stays unacknowledged
    },
    confirmTarget: (name, hooks) => serverAnswer([], h.calls, () => h.ingress.gate())(name, hooks),
  })
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 8; i++) await flush()
  const m = h.calls.find(c => c.op == 'create')!.id!
  // a stale LOWER id is canonical locally, and the server answer contains neither it nor `m`
  registerHidden(h.idx, { id: 'a', name: 'n', item: { stale: 1 } }, () => {})
  expect(h.idx.byName.get('n')!.id, '`a` sorts below `m` and wins selection').toBe('a')
  controller.save('n', { mine: 2 })
  for (let i = 0; i < 12; i++) await flush()
  expect(h.idx.byId.has('a'), 'the disproved stale row is removed').toBe(false)
  expect(h.idx.byId.has(m), 'the unacknowledged create is PRESERVED by its marker').toBe(true)
  const updates = h.calls.filter(c => c.op == 'update')
  expect(
    updates.map(u => u.id),
    'exactly one update, to `m`'
  ).toEqual([m])
  expect(
    h.calls.filter(c => c.op == 'create'),
    'and no second document'
  ).toHaveLength(1)
  ack.resolve()
})

// the controller acceptance properties as ONE effect table, per review 71. THE COMMIT WINDOW IS
// ISOLATED: `hooks.commit` is synchronous, so a flag raised around it in the confirmTarget dep
// attributes each effect exactly. syncOwner has several callers in a save (the name claim, the
// adopt path), and an account-wide count could not tell the commit's baseline publication apart
// from any of them — which is why the earlier version of this table asserted registration LENGTH
// only and discarded its publication fields
for (const [what, rows, expected] of [
  // no eligible fresh registration, so no registration performs the rebase/publication — the
  // pending projection must still reset and publish its immutable local-intent baseline ONCE
  ['an empty answer', [], { register: [] as string[], published: 1 }],
  ['an ineligible-only answer', [{ id: 'q', name: 'n', eligible: false }], { register: [] as string[], published: 1 }],
  [
    // the quarantined LOWER row must be skipped and the eligible one registered — asserting a
    // count of one cannot tell which of the two it was. that ONE eligible registration is also
    // what performs the single rebase/adoption/publication, so the count matches the rows above
    // while the route to it differs
    'a quarantined lower row beside an eligible one',
    [
      { id: 'a', name: 'n', eligible: false },
      { id: 'k', name: 'n', eligible: true },
    ],
    { register: ['k'], published: 1 },
  ],
] as const)
  test(`commit effects: ${what}`, async () => {
    const registered: string[] = []
    const publishedInCommit: string[] = []
    const publishedState: any[] = []
    let inCommit = false
    const h = harness()
    const controller = createHiddenPersistence({
      ...h.deps,
      registerTargetRow: (wrapper, merge) => void (registered.push(wrapper.id), registerHidden(h.idx, wrapper, merge)),
      syncOwner: (n, state) => void (inCommit && (publishedInCommit.push(n), publishedState.push(state))),
      confirmTarget: async (name, hooks) => {
        const answer = new Map(
          rows.map(r => [
            r.id,
            {
              id: r.id,
              kind: 'hidden' as const,
              name: r.name,
              wrapper: { id: r.id, name: r.name, item: {} },
              eligible: r.eligible,
            },
          ])
        )
        inCommit = true
        try {
          return hooks.commit(answer, hooks.captureReadMarker())
        } finally {
          inCommit = false
        }
      },
    })
    registerHidden(h.idx, { id: 'stale', name: 'n', item: {} }, () => {})
    h.idx.byName.delete('n')
    controller.save('n', { mine: 1 })
    for (let i = 0; i < 10; i++) await flush()
    expect(registered, 'the EXACT rows registerTargetRow received').toEqual(expected.register)
    expect(publishedInCommit.length, 'owner publications inside the commit turn').toBe(expected.published)
    // and the RESET branch publishes the immutable local-intent BASELINE, not whatever the index
    // happened to hold: a publication count proves one happened, not that it carried the right
    // state, and the owner writes full-state clones over what it sees
    if (!expected.register.length) expect(publishedState[0]).toEqual({ mine: 1 })
  })

test('commit effects: a RELEVANT indeterminate answer produces zero effects, and a later read succeeds', async () => {
  // indeterminate is not absence: the document exists and this read cannot place it, so treating
  // it as target-side absence would remove a live record from a stale negative
  let attempt = 0
  const registered: string[] = []
  const h = harness()
  const controller = createHiddenPersistence({
    ...h.deps,
    confirmsUpdates: true, // so the RETRY confirms too, rather than updating blind
    registerTargetRow: (wrapper, merge) => void (registered.push(wrapper.id), registerHidden(h.idx, wrapper, merge)),
    confirmTarget: async (name, hooks) => {
      if (++attempt == 1) throw new Error('hidden document d1 could not be classified: unparseable')
      return serverAnswer([{ id: 'k', name: 'n', item: {} }])(name, hooks)
    },
  })
  const live: HiddenWrapper = { id: 'live', name: 'n', item: { v: 1 } }
  registerHidden(h.idx, live, () => {})
  h.idx.byName.delete('n')
  controller.save('n', { mine: 1 })
  for (let i = 0; i < 8; i++) await flush()
  expect(registered, 'the failed classification mutated nothing').toEqual([])
  expect(h.idx.byId.has('live'), 'and removed nothing from a stale negative').toBe(true)
  // a later save confirms successfully
  controller.save('n', { mine: 2 })
  for (let i = 0; i < 12; i++) await flush()
  expect(registered, 'the retry commits').toContain('k')
})
