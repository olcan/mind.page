import { expect, test } from '@playwright/test'
import {
  createStopWaiters,
  readHiddenMembership,
  receiveChanges,
  scheduleDelivery,
  type AdmittedDeliveryDeps,
  type Delivery,
  type ListenerChange,
  type Membership,
  type PageMode,
} from '../../src/hidden_delivery.js'
import { createRecordAllocator } from '../../src/hidden_listener_records.js'
import { createHiddenIngress } from '../../src/hidden_ingress.js'
import { createHiddenCorpus } from '../../src/hidden_corpus.js'
import { scanHiddenDocuments, type ScanDeps } from '../../src/hidden_scan.js'

// the LISTENER DELIVERY BOUNDARY schedules (see src/hidden_delivery.ts): allocation through
// reducer invocation, driven against the REAL coordinator, record allocator and corpus — and
// through the SAME receiveChanges/scheduleDelivery binding production uses, so a swapped envelope,
// a re-zipped record, or a skipped schedule handoff is exercised here, not merely read.

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

const OWNER: PageMode = { fixed: true, readonly: false, anonymous: false }

// a change as the listener sees one: the payload is the (possibly old) data the change carried
const changeOf = (id: string, type: 'added' | 'modified' | 'removed', data: any = {}): ListenerChange => ({
  type,
  doc: { id, data: () => data },
})

// a full production-shaped composition: real ingress, real allocator, real corpus, and the real
// binding helpers. the reducers are the effect log — the seam's whole output — and the fake
// UNIFIED reducer obeys the real one's contract: it routes on the change type and the item's
// hidden flag, and it does NOT remove a visible row for a hidden item
function harness(mode: PageMode = OWNER) {
  const ingress = createHiddenIngress()
  const corpus = createHiddenCorpus()
  const allocator = createRecordAllocator({ onBlindError: () => {} })
  const stopWaiters = createStopWaiters()
  const effects: string[] = []
  let stopped = false
  // the applied HIDDEN index: id -> name
  const hiddenById = new Map<string, string>()
  // the VISIBLE items: ids present
  const visible = new Set<string>()
  // the membership read, controllable per test: id -> current server state
  const server = new Map<string, { item: any; name?: string }>()
  let membershipReads = 0
  const readStarted = deferred()
  let membershipHold: Promise<void> | undefined
  const readMembership = async (id: string): Promise<Membership> => {
    membershipReads++
    readStarted.resolve()
    if (membershipHold) await membershipHold
    if (stopped) throw new Error('hidden ingress stopped')
    const row = server.get(id)
    if (row?.item.corrupt) throw new Error(`hidden document ${id} could not be classified`)
    if (!row || !row.item.hidden) return { kind: 'not-hidden' }
    return { kind: 'hidden', snap: { id, data: () => row.item }, item: row.item, wrapper: { id, name: row.name! } }
  }

  // production's applyRemote reaches the body on a LATER microtask, behind predecessors — a
  // synchronous stand-in made the in-body stop check undrivable (round 77). `holdBodies` lets a
  // row stop ingress between reservation and the body running
  let bodyHold: Promise<void> | undefined
  const reserved = deferred()
  const applyRemote = async (names: (string | undefined)[], body: () => undefined) => {
    effects.push(`chains:${names.map(n => n ?? '-').join(',')}`)
    reserved.resolve() // the reservation milestone: evidence and its liveness check are behind us
    await Promise.resolve() // the controller's serialized turn: never synchronous with reservation
    if (bodyHold) await bodyHold
    body()
  }

  // THE REAL BINDING: receiveChanges decides admission, allocates, and binds positionally
  const receive = (changes: ListenerChange[]) =>
    receiveChanges(changes, {
      mode,
      pendingBoundary: id => corpus.pendingBoundary(id),
      tracksDocument: id => hiddenById.has(id),
      hasOutstanding: id => ingress.hasOutstanding(id),
      open: (id, cipher) => ingress.open(id, cipher),
      allocate: (requests, revoke) => allocator.allocate(requests, revoke),
      revoke: () => {},
    })

  const depsFor = (id: string): AdmittedDeliveryDeps => ({
    stopped: () => stopped,
    stopWaiters,
    readMembership: () => readMembership(id),
    nameForDocument: () => hiddenById.get(id),
    hiddenIndexed: () => hiddenById.has(id),
    visiblePresent: () => visible.has(id),
    applyRemote,
    hasLocalIntent: () => false,
    removeVisibleForHidden: () => void (visible.delete(id), effects.push(`removeVisible:${id}`)),
    // the UNIFIED reducer's contract, honored: hidden item + removed -> hidden removal only
    // (NEVER the visible row); hidden item + added/modified -> hidden install; visible item ->
    // visible install/removal
    applyUnified: (change, _snap, item) => {
      effects.push(`apply:${change.type}:${id}:${item?.hidden ? 'hidden' : 'visible'}`)
      if (item?.hidden) {
        if (change.type == 'removed') hiddenById.delete(id)
        else hiddenById.set(id, server.get(id)?.name ?? 'unknown')
      } else if (change.type == 'removed') visible.delete(id)
      else visible.add(id)
      return undefined
    },
    removeHiddenRecord: () => {
      const name = hiddenById.get(id)
      hiddenById.delete(id)
      if (name) effects.push(`removeHidden:${id}`)
      return { droppedName: name }
    },
    hiddenChanged: name => void effects.push(`notify:${name}`),
    markCleanupPending: () => undefined,
    onEvidenceError: () => undefined,
    onApplyError: () => undefined,
  })

  // schedules one admitted delivery through the REAL scheduleDelivery, with the payload prepared
  // as the listener would (a removal fabricates the old-side item)
  const schedule = (delivery: Delivery, item: any, wrapper: { id: string; name: string } | null = null) => {
    if (delivery.record.kind != 'admitted') throw new Error('expected an admitted record')
    scheduleDelivery({ ...delivery, record: delivery.record }, { item, wrapper }, depsFor(delivery.change.doc.id))
  }

  return {
    ingress,
    corpus,
    allocator,
    stopWaiters,
    effects,
    hiddenById,
    visible,
    server,
    receive,
    schedule,
    stop: () => {
      stopped = true
      stopWaiters.stop(new Error('hidden ingress stopped'))
    },
    membershipReadCount: () => membershipReads,
    readStarted: readStarted.promise,
    reserved: reserved.promise,
    holdMembership: () => {
      const held = deferred()
      membershipHold = held.promise
      return held
    },
    holdBodies: () => {
      const held = deferred()
      bodyHold = held.promise
      return held
    },
  }
}

// the coordinator's terminal outcome for a delivery — the fact the gate and healing read
function outcomeOf(delivery: Delivery) {
  return delivery.record.done.then(
    () => 'applied' as const,
    () => 'blocked' as const
  )
}

// receive + schedule one owner-fixed removal (old visible payload), returning the handle outcome
function deliverRemoval(h: ReturnType<typeof harness>, id: string) {
  const { deliveries } = h.receive([changeOf(id, 'removed', { hidden: false })])
  const delivery = deliveries[0]
  if (delivery.record.kind != 'admitted') throw new Error('expected admitted allocation')
  h.schedule(delivery, { hidden: false, text: '' })
  return { delivery, outcome: outcomeOf(delivery) }
}

// ---- the acceptance schedules ------------------------------------------------------------------

test('NO CORPUS: an owner-fixed removal whose document is now hidden is admitted and installed', async () => {
  // the round-75 escape: no wrapper, no outstanding handle, no corpus membership — the old
  // admission list allocated this delivery BLIND, and the blind body removed the visible row from
  // the stale payload with nothing ever installing the hidden record
  const h = harness()
  h.visible.add('k')
  h.server.set('k', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const { outcome } = deliverRemoval(h, 'k')
  expect(await outcome, 'the delivery applied').toBe('applied')
  expect(h.effects, 'evidence, then BOTH halves of the transition through the real reducer path').toEqual([
    'chains:-,global_store_b', // the FRESH name decided the chains; the payload's name set is empty
    'removeVisible:k',
    'apply:added:k:hidden',
  ])
  expect(h.hiddenById.get('k'), 'the hidden record is installed').toBe('global_store_b')
  expect(h.visible.has('k'), 'and the visible row is gone').toBe(false)
})

test('RAW-HIDDEN DELETION: a full-account hidden removal removes BOTH representations', async () => {
  // the round-77 regression: routing the body on `hidden && !removed` sent a hidden deletion down
  // the nonhidden body, whose unified-reducer call saw a hidden item, took its hidden branch, and
  // never touched a stale visible row. the body must route on the payload's own hidden flag —
  // visible sweep first, then the unified reducer's hidden removal
  const h = harness({ fixed: false, readonly: false, anonymous: false }) // full-account page
  h.visible.add('k') // a stale/partially installed visible representation
  h.hiddenById.set('k', 'global_store_b')
  const { deliveries } = h.receive([changeOf('k', 'removed', { hidden: true, cipher: 'x' })])
  const delivery = deliveries[0]
  expect(delivery.record.kind, 'admitted by rawHidden').toBe('admitted')
  h.schedule(delivery, { hidden: true, text: '' }) // the fabricated old-side hidden payload
  expect(await outcomeOf(delivery)).toBe('applied')
  expect(h.effects).toEqual([
    'chains:global_store_b', // a removal's name comes from the applied index alone
    'removeVisible:k', // the visible sweep runs FIRST, exactly as the old inline body did
    'apply:removed:k:hidden', // then the unified reducer performs the hidden removal
  ])
  expect(h.hiddenById.has('k'), 'the hidden representation is gone').toBe(false)
  expect(h.visible.has('k'), 'and so is the stale visible row').toBe(false)
})

test('BOUNDARY: a delivery admitted by corpus membership waits for THAT producer to settle', async () => {
  // deleting the boundary await left every schedule green in round 77, because no row ever
  // captured a DEFINED boundary. this one does: the producer publishes `k` and stays held
  const h = harness()
  h.server.set('k', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const membershipPublished = deferred()
  const producerHold = deferred()
  const producer = h.corpus.run(async run => {
    run.publishMembership(['k']) // k is in an in-flight corpus read
    membershipPublished.resolve()
    await producerHold.promise // the producer is HELD, its boundary pending
  })
  await membershipPublished.promise
  const { deliveries } = h.receive([changeOf('k', 'modified', { hidden: true, cipher: 'x' })])
  const delivery = deliveries[0]
  expect(delivery.boundary, 'the receipt captured a DEFINED boundary').toBeTruthy()
  h.schedule(delivery, { hidden: true, text: '' }, { id: 'k', name: 'global_store_b' })
  await new Promise(res => setImmediate(res))
  expect(h.effects, 'NOTHING runs while the producer holds the boundary').toEqual([])
  producerHold.resolve() // the producer settles; the boundary releases
  await producer
  expect(await outcomeOf(delivery)).toBe('applied')
  expect(h.effects[0], 'the application ran only after the boundary released').toContain('chains:')
})

test('STOP between reservation and the body: the delivery blocks with zero mutation', async () => {
  // production applyRemote reaches the body on a later microtask behind predecessors; a stop can
  // land in that gap, and the body-level check is what refuses — deleting it survived round 77
  // because the stand-in invoked bodies synchronously
  const h = harness()
  h.visible.add('k')
  h.server.set('k', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const held = h.holdBodies()
  const { outcome } = deliverRemoval(h, 'k')
  // the RESERVATION milestone: evidence and its own liveness check are already behind us, so the
  // in-body check is the only refusal left — which is precisely what this row pins
  await h.reserved
  h.stop()
  held.resolve()
  expect(await outcome, 'blocked, not applied').toBe('blocked')
  expect(
    h.effects.filter(e => !e.startsWith('chains:')),
    'zero mutation after the stop'
  ).toEqual([])
  expect(h.hiddenById.has('k'), 'nothing installed').toBe(false)
})

test('PRE-MEMBERSHIP ADMISSION: a removal racing an unpublished confirmation is admitted by receipt alone', async () => {
  // the round-75 window: nameA's confirmation holds its query with the prefix OPEN and membership
  // NOT yet published, so corpus membership admits nothing — only receipt-time needsEvidence does.
  // NOTE what this row proves is the ADMISSION and the install; the full target-slice composition
  // (nameA's commit ignoring nameB's rows) is the controller's own pinned behavior
  const h = harness()
  h.visible.add('k')
  h.server.set('k', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const queryStarted = deferred()
  const query = deferred<{ id: string; data: unknown }[]>()
  const scanDeps: ScanDeps = {
    openPrefix: () => h.allocator.openPrefix(),
    queryHidden: () => (queryStarted.resolve(), query.promise),
    publishMembership: () => {},
    assertLive: () => {},
    cancellation: new Promise<never>(() => {}),
    classify: async id => ({ kind: 'hidden', wrapper: { id, name: 'global_store_a' } }),
    pointRead: async () => ({ kind: 'not-hidden' }),
  }
  const confirmation = h.corpus.run(() => scanHiddenDocuments(scanDeps))
  await queryStarted.promise // held: prefix open, membership unpublished
  expect(h.corpus.pendingBoundary('k'), 'no membership yet').toBeUndefined()
  const { delivery, outcome } = deliverRemoval(h, 'k')
  expect(delivery.needsEvidence, 'admitted by the receipt-time predicate alone').toBe(true)
  expect(await outcome).toBe('applied')
  expect(h.hiddenById.get('k'), 'the delivery installed k; the confirmation never would').toBe('global_store_b')
  query.resolve([{ id: 'a', data: {} }])
  await confirmation
})

test('HEALING: failed evidence does not heal an older block; newer successful evidence does', async () => {
  const h = harness()
  const older = h.ingress.open('k', 'cipher:bad')
  older.ready(() => Promise.reject(new Error('apply failed')))
  expect(await older.done).toBe('blocked')
  expect(h.ingress.gate(), 'the gate holds the block').toBe('blocked')
  h.server.set('k', { item: { hidden: true, corrupt: true } })
  const failing = deliverRemoval(h, 'k')
  expect(await failing.outcome, 'blocked, not applied: it established nothing').toBe('blocked')
  expect(h.ingress.gate(), 'and the older block is NOT healed').toBe('blocked')
  h.server.set('k', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const healing = deliverRemoval(h, 'k')
  expect(await healing.outcome).toBe('applied')
  expect(h.ingress.gate(), 'a successful evidence-backed delivery heals').toBe('writable')
})

test('DELETION: a document absent from the owner set applies the removal on BOTH sides', async () => {
  const h = harness()
  h.visible.add('k')
  h.hiddenById.set('k', 'global_store_b') // the index still tracks it
  const { outcome } = deliverRemoval(h, 'k')
  expect(await outcome).toBe('applied')
  expect(h.effects).toEqual([
    'chains:global_store_b',
    'removeHidden:k',
    'notify:global_store_b',
    'apply:removed:k:visible',
  ])
  expect(h.hiddenById.has('k')).toBe(false)
  expect(h.visible.has('k')).toBe(false)
})

test('SCOPE: a foreign or read-only fixed removal performs no hidden read and is not admitted for evidence', async () => {
  for (const mode of [
    { ...OWNER, readonly: true },
    { ...OWNER, anonymous: true },
    { ...OWNER, fixed: false },
  ]) {
    const h = harness(mode)
    const { deliveries } = h.receive([changeOf('k', 'removed', { hidden: false })])
    expect(deliveries[0].needsEvidence, JSON.stringify(mode)).toBe(false)
    expect(deliveries[0].record.kind, 'an ordinary blind visible removal').toBe('blind')
    expect(h.membershipReadCount(), 'and no hidden read was taken').toBe(0)
    deliveries[0].record.finish()
  }
})

test('CORRELATION: two changes keep their own records, boundaries and evidence bits', async () => {
  // the binding invariant receiveChanges owns: swapping two envelopes or records must be visible.
  // `a` is a raw-hidden modification (admitted, no evidence); `b` is an ambiguous owner removal
  // (admitted, evidence). their facts must not cross
  const h = harness()
  h.server.set('b', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const { deliveries } = h.receive([
    changeOf('a', 'modified', { hidden: true, cipher: 'ca' }),
    changeOf('b', 'removed', { hidden: false }),
  ])
  expect(deliveries.map(d => d.change.doc.id)).toEqual(['a', 'b'])
  expect(
    deliveries.map(d => d.record.id),
    'record i is change i'
  ).toEqual(['a', 'b'])
  expect(
    deliveries.map(d => d.needsEvidence),
    'the evidence bit stays with its own change'
  ).toEqual([false, true])
  h.schedule(deliveries[0], { hidden: true, text: '' }, { id: 'a', name: 'global_store_a' })
  h.schedule(deliveries[1], { hidden: false, text: '' })
  await Promise.all(deliveries.map(outcomeOf))
  expect(h.membershipReadCount(), 'exactly ONE evidence read: b, never a').toBe(1)
  expect(h.hiddenById.get('b'), 'b installed from its own evidence').toBe('global_store_b')
})

// ---- the stop-waiter lifecycle -----------------------------------------------------------------

test('a held evidence read is released by stop, and the delivery blocks rather than lingering', async () => {
  const h = harness()
  h.visible.add('k')
  h.server.set('k', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const held = h.holdMembership()
  const { outcome } = deliverRemoval(h, 'k')
  await h.readStarted // the read is genuinely in flight — a milestone, not a guessed checkpoint
  expect(h.stopWaiters.waiting(), 'one waiter registered while the read is held').toBe(1)
  h.stop() // the read never settles; only the waiter can release the delivery
  expect(await outcome, 'the delivery terminalizes instead of retaining its context').toBe('blocked')
  expect(h.stopWaiters.waiting(), 'and the waiter is drained').toBe(0)
  held.resolve() // the late network result is ignored: stopped() is rechecked before decrypt
  await new Promise(res => setImmediate(res))
  expect(h.hiddenById.has('k'), 'no late mutation').toBe(false)
})

test('successful reads leave ZERO live stop waiters: nothing accumulates on a healthy page', async () => {
  const h = harness()
  for (let i = 0; i < 20; i++) {
    const id = `k${i}`
    h.visible.add(id)
    h.server.set(id, { item: { hidden: true, text: 'cipher' }, name: `global_store_${id}` })
    const { outcome } = deliverRemoval(h, id)
    expect(await outcome).toBe('applied')
  }
  expect(h.stopWaiters.waiting(), 'twenty successful reads, zero retained waiters').toBe(0)
})

test('a read arriving AFTER stop rejects immediately instead of racing', async () => {
  const waiters = createStopWaiters()
  waiters.stop(new Error('stopped'))
  await expect(waiters.race(new Promise(() => {}))).rejects.toThrow('stopped')
  expect(waiters.waiting()).toBe(0)
})

// ---- the membership read -----------------------------------------------------------------------

test('membership answers absence from a NONEMPTY set by target id, not by emptiness', async () => {
  const rows = [{ id: 'other', data: () => ({ hidden: true, cipher: 'x' }) }]
  const m = await readHiddenMembership('k', {
    queryHiddenSet: async () => rows,
    stopped: () => false,
    decrypt: async data => data,
  })
  expect(m).toEqual({ kind: 'not-hidden' })
  const m2 = await readHiddenMembership('k', {
    queryHiddenSet: async () => [...rows, { id: 'k', data: () => ({ hidden: true }) }],
    stopped: () => false,
    decrypt: async () => ({ hidden: true, text: JSON.stringify({ name: 'n' }) }),
  })
  expect(m2.kind).toBe('hidden')
  if (m2.kind == 'hidden') expect(m2.wrapper).toEqual({ id: 'k', name: 'n' })
})

test('membership rechecks liveness after the query and before decrypting', async () => {
  let stopped = false
  let decrypts = 0
  const p = readHiddenMembership('k', {
    queryHiddenSet: async () => {
      stopped = true // stop lands while the query is in flight
      return [{ id: 'k', data: () => ({ hidden: true, cipher: 'x' }) }]
    },
    stopped: () => stopped,
    decrypt: async data => (decrypts++, data),
  })
  await expect(p).rejects.toThrow('stopped')
  expect(decrypts, 'the late result never reached decryption').toBe(0)
})

test('a set row that cannot be classified fails closed instead of healing', async () => {
  await expect(
    readHiddenMembership('k', {
      queryHiddenSet: async () => [{ id: 'k', data: () => ({ hidden: true }) }],
      stopped: () => false,
      decrypt: async () => ({ hidden: true, text: 'not json' }),
    })
  ).rejects.toThrow('could not be classified')
})
