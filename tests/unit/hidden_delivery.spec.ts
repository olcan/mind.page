import { expect, test } from '@playwright/test'
import {
  applyAdmittedDelivery,
  createStopWaiters,
  readHiddenMembership,
  receiveChange,
  type AdmittedDeliveryDeps,
  type Membership,
  type PageMode,
} from '../../src/hidden_delivery.js'
import { createRecordAllocator } from '../../src/hidden_listener_records.js'
import { createHiddenIngress } from '../../src/hidden_ingress.js'
import { createHiddenCorpus } from '../../src/hidden_corpus.js'
import { scanHiddenDocuments, type ScanDeps } from '../../src/hidden_scan.js'

// the LISTENER DELIVERY BOUNDARY schedules (see src/hidden_delivery.ts): allocation through
// reducer invocation, driven against the REAL coordinator, record allocator and corpus — the
// modules production imports. rounds 74-76 each found a defect here that isolated helper rows
// could not see, because admission and evidence lived apart; these rows drive them together.

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

// ONE macrotask, draining recursively queued microtasks first. only for negative assertions
const checkpoint = () => new Promise<void>(res => setImmediate(res))

const OWNER: PageMode = { fixed: true, readonly: false, anonymous: false }

// a full production-shaped composition: real ingress, real allocator, real corpus. deliveries are
// received through receiveChange and applied through applyAdmittedDelivery; the reducers are the
// effect log, which is the seam's whole output
function harness(mode: PageMode = OWNER) {
  const ingress = createHiddenIngress()
  const corpus = createHiddenCorpus()
  const allocator = createRecordAllocator({ onBlindError: () => {} })
  const stopWaiters = createStopWaiters()
  const effects: string[] = []
  let stopped = false
  // the applied HIDDEN index: id -> name (enough for names/indexed/removal at this seam)
  const hiddenById = new Map<string, string>()
  // the VISIBLE items: ids present
  const visible = new Set<string>()
  // the membership read, controllable per test: id -> current state
  const server = new Map<string, { item: any; name?: string }>()
  let membershipReads = 0
  let membershipHold: Promise<void> | undefined
  const readMembership = async (id: string): Promise<Membership> => {
    membershipReads++
    if (membershipHold) await membershipHold
    if (stopped) throw new Error('hidden ingress stopped')
    const row = server.get(id)
    if (row?.item.corrupt) throw new Error(`hidden document ${id} could not be classified`)
    if (!row || !row.item.hidden) return { kind: 'not-hidden' }
    return { kind: 'hidden', snap: { id }, item: row.item, wrapper: { id, name: row.name! } }
  }

  const receive = (change: { id: string; removed: boolean; rawHidden: boolean; cipher?: string }) =>
    receiveChange(
      { cipher: undefined, ...change },
      {
        mode,
        pendingBoundary: id => corpus.pendingBoundary(id),
        tracksDocument: id => hiddenById.has(id),
        hasOutstanding: id => ingress.hasOutstanding(id),
        open: (id, cipher) => ingress.open(id, cipher),
      }
    )

  // the delivery deps for one id, writing to the effect log
  const depsFor = (id: string): AdmittedDeliveryDeps => ({
    stopped: () => stopped,
    stopWaiters,
    readMembership: () => readMembership(id),
    nameForDocument: () => hiddenById.get(id),
    hiddenIndexed: () => hiddenById.has(id),
    visiblePresent: () => visible.has(id),
    // serialized application stands in for the persistence controller here: these schedules are
    // about WHICH reducers run with WHAT — the controller's own chains are pinned in its spec
    applyRemote: async (names, body) => {
      effects.push(`chains:${names.map(n => n ?? '-').join(',')}`)
      body()
    },
    hasLocalIntent: () => false,
    removeVisibleForHidden: () => void (visible.delete(id), effects.push(`removeVisible:${id}`)),
    applyVisible: (change, _snap, item) => {
      effects.push(`apply:${change.type}:${id}:${item?.hidden ? 'hidden' : 'visible'}`)
      if (item?.hidden) hiddenById.set(id, server.get(id)?.name ?? 'unknown')
      else if (change.type == 'removed') visible.delete(id)
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
  })

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
    depsFor,
    stop: () => {
      stopped = true
      stopWaiters.stop(new Error('hidden ingress stopped'))
    },
    membershipReadCount: () => membershipReads,
    holdMembership: () => {
      const held = deferred()
      membershipHold = held.promise
      return held
    },
  }
}

// runs one admitted removal end to end: receive -> allocate -> schedule -> apply
async function deliverRemoval(h: ReturnType<typeof harness>, id: string) {
  const envelope = h.receive({ id, removed: true, rawHidden: false })
  if (envelope.request.kind != 'admitted') throw new Error('expected admitted allocation')
  const batch = h.allocator.allocate([envelope.request], () => {})
  const record = batch.records[0]
  if (record.kind != 'admitted') throw new Error('expected admitted record')
  record.schedule(() =>
    applyAdmittedDelivery(
      {
        change: { type: 'removed', doc: { id } },
        item: { hidden: false, text: '' }, // the OLD visible payload a removal carries
        wrapper: null,
        boundary: envelope.boundary,
        needsEvidence: envelope.needsEvidence,
      },
      h.depsFor(id)
    )
  )
  // the coordinator handle's terminal outcome — the fact the gate and healing read
  return { envelope, record, batch, outcome: envelope.request.handle.done }
}

// ---- the four acceptance schedules -------------------------------------------------------------

test('NO CORPUS: an owner-fixed removal whose document is now hidden is admitted and installed', async () => {
  // the round-75 escape: no wrapper, no outstanding handle, no corpus membership — the old
  // admission list allocated this delivery BLIND, and the blind body removed the visible row from
  // the stale payload with nothing ever installing the hidden record
  const h = harness()
  h.visible.add('k')
  h.server.set('k', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const { outcome } = await deliverRemoval(h, 'k')
  expect(await outcome, 'the delivery applied').toBe('applied')
  expect(h.effects, 'evidence, then BOTH halves of the transition through the real reducer path').toEqual([
    'chains:-,global_store_b', // the FRESH name decided the chains; the payload's name set is empty
    `removeVisible:k`,
    'apply:added:k:hidden',
  ])
  expect(h.hiddenById.get('k'), 'the hidden record is installed').toBe('global_store_b')
  expect(h.visible.has('k'), 'and the visible row is gone').toBe(false)
})

test('PRE-MEMBERSHIP: a removal racing an unrelated confirmation is still admitted and installed', async () => {
  // feedback 75's second escape: the removal arrives while nameA's confirmation holds its query —
  // prefix OPEN, membership NOT yet published — so corpus membership admits nothing, and the
  // confirmation's own commit will ignore nameB's rows. only receipt-time needsEvidence admits it
  const h = harness()
  h.visible.add('k')
  h.server.set('k', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const query = deferred<{ id: string; data: unknown }[]>()
  const scanDeps: ScanDeps = {
    openPrefix: () => h.allocator.openPrefix(),
    queryHidden: () => query.promise,
    publishMembership: () => {},
    assertLive: () => {},
    cancellation: new Promise<never>(() => {}),
    classify: async id => ({ kind: 'hidden', wrapper: { id, name: 'global_store_a' } }),
    pointRead: async () => ({ kind: 'not-hidden' }),
  }
  const confirmation = h.corpus.run(() => scanHiddenDocuments(scanDeps))
  await checkpoint() // the confirmation's query is now held; membership unpublished
  expect(h.corpus.pendingBoundary('k'), 'no membership yet').toBeUndefined()
  const { envelope, outcome } = await deliverRemoval(h, 'k')
  expect(envelope.needsEvidence, 'admitted by the receipt-time predicate alone').toBe(true)
  expect(await outcome).toBe('applied')
  expect(h.hiddenById.get('k'), 'the delivery installed k; the confirmation never would').toBe('global_store_b')
  // the confirmation completes independently — its answer is about nameA's world
  query.resolve([{ id: 'a', data: {} }])
  await confirmation
})

test('HEALING: failed evidence does not heal an older block; newer successful evidence does', async () => {
  const h = harness()
  // an older delivery for k is BLOCKED: its cell retains the failure
  const older = h.ingress.open('k', 'cipher:bad')
  older.ready(() => Promise.reject(new Error('apply failed')))
  expect(await older.done).toBe('blocked')
  expect(h.ingress.gate(), 'the gate holds the block').toBe('blocked')
  // an ambiguous removal whose EVIDENCE fails: a set row that cannot be classified
  h.server.set('k', { item: { hidden: true, corrupt: true } })
  const failing = await deliverRemoval(h, 'k')
  expect(await failing.outcome, 'blocked, not applied: it established nothing').toBe('blocked')
  expect(h.ingress.gate(), 'and the older block is NOT healed').toBe('blocked')
  // a strictly newer delivery whose evidence SUCCEEDS
  h.server.set('k', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const healing = await deliverRemoval(h, 'k')
  expect(await healing.outcome).toBe('applied')
  expect(h.ingress.gate(), 'a successful evidence-backed delivery heals').toBe('writable')
})

test('DELETION: a document absent from the owner set applies the removal on BOTH sides', async () => {
  const h = harness()
  h.visible.add('k')
  h.hiddenById.set('k', 'global_store_b') // the index still tracks it
  // k is deleted server-side: absent from the hidden set (the rules-backed answer — see
  // tests/e2e/rules.spec.ts for why absence is only observable through this query)
  const { outcome } = await deliverRemoval(h, 'k')
  expect(await outcome).toBe('applied')
  expect(h.effects).toEqual([
    'chains:global_store_b', // the OLD name: the hidden side is being removed
    'removeHidden:k',
    'notify:global_store_b',
    'apply:removed:k:visible',
  ])
  expect(h.hiddenById.has('k')).toBe(false)
  expect(h.visible.has('k')).toBe(false)
})

test('SCOPE: a foreign or read-only fixed removal performs no hidden read and is not admitted for evidence', async () => {
  // the pure predicate table cannot catch a listener call site bypassing the predicate: this drives
  // the real receipt. a foreign page must never read or decrypt the sharer's corpus, nor prompt
  for (const mode of [
    { ...OWNER, readonly: true },
    { ...OWNER, anonymous: true },
    { ...OWNER, fixed: false },
  ]) {
    const h = harness(mode)
    const envelope = h.receive({ id: 'k', removed: true, rawHidden: false })
    expect(envelope.needsEvidence, JSON.stringify(mode)).toBe(false)
    expect(envelope.request.kind, 'an ordinary blind visible removal').toBe('blind')
    expect(h.membershipReadCount(), 'and no hidden read was taken').toBe(0)
  }
})

// ---- the stop-waiter lifecycle -----------------------------------------------------------------

test('a held evidence read is released by stop, and the delivery blocks rather than lingering', async () => {
  const h = harness()
  h.visible.add('k')
  h.server.set('k', { item: { hidden: true, text: 'cipher' }, name: 'global_store_b' })
  const held = h.holdMembership()
  const { outcome } = await deliverRemoval(h, 'k')
  await checkpoint()
  expect(h.stopWaiters.waiting(), 'one waiter registered while the read is held').toBe(1)
  h.stop() // the read never settles; only the waiter can release the delivery
  expect(await outcome, 'the delivery terminalizes instead of retaining its context').toBe('blocked')
  expect(h.stopWaiters.waiting(), 'and the waiter is drained').toBe(0)
  held.resolve() // the late network result is ignored: stopped() is rechecked before decrypt
  await checkpoint()
  expect(h.hiddenById.has('k'), 'no late mutation').toBe(false)
})

test('successful reads leave ZERO live stop waiters: nothing accumulates on a healthy page', async () => {
  // the round-76 finding: one shared pending promise cannot detach its losing race reactions, so a
  // page that never stops retained one per successful read — the pattern the corpus removed
  const h = harness()
  for (let i = 0; i < 20; i++) {
    const id = `k${i}`
    h.visible.add(id)
    h.server.set(id, { item: { hidden: true, text: 'cipher' }, name: `global_store_${id}` })
    const { outcome } = await deliverRemoval(h, id)
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
  // production finds the target id in the returned set; a mutation reading rows[0] instead must
  // fail here, which requires an unrelated hidden document to be PRESENT
  const rows = [{ id: 'other', data: () => ({ hidden: true, cipher: 'x' }) }]
  const m = await readHiddenMembership('k', {
    queryHiddenSet: async () => rows,
    stopped: () => false,
    decrypt: async data => data,
  })
  expect(m).toEqual({ kind: 'not-hidden' })
  // and the present target is found among others, not assumed to be the only row
  const m2 = await readHiddenMembership('k', {
    queryHiddenSet: async () => [...rows, { id: 'k', data: () => ({ hidden: true }) }],
    stopped: () => false,
    decrypt: async () => ({ hidden: true, text: JSON.stringify({ name: 'n' }) }),
  })
  expect(m2.kind).toBe('hidden')
  if (m2.kind == 'hidden') expect(m2.wrapper).toEqual({ id: 'k', name: 'n' })
})

test('membership rechecks liveness after the query and before decrypting', async () => {
  // racing the waiter does not abort the request: a late result must not prompt or do secret work
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
