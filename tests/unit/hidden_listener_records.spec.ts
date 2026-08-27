import { expect, test } from '@playwright/test'
import { createRecordAllocator, type RecordHandle } from '../../src/hidden_listener_records.js'
import { createHiddenIngress } from '../../src/hidden_ingress.js'

// the record/lane schedules for the items listener (see src/hidden_listener_records.ts). this is
// the EXACT module production imports, not a copy of its shape — the round-58 lesson. everything
// is deferred-driven: no real timers, no guessed microtask counts

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

// ONE macrotask, which drains every recursively queued microtask first. used ONLY for negative
// assertions; positive progress always awaits a real promise
const checkpoint = () => new Promise<void>(res => setImmediate(res))

// a fake coordinator handle with the same CAS contract: ready() and block() compete, whichever
// lands first owns the outcome, and done FULFILLS with 'blocked' rather than rejecting
function fakeHandle() {
  const d = deferred<'applied' | 'blocked'>()
  let phase: 'open' | 'ready' | 'running' | 'terminal' = 'open'
  let apply: (() => Promise<void>) | undefined
  const handle: RecordHandle = {
    ready(a) {
      if (phase != 'open') return
      phase = 'ready'
      apply = a
    },
    block() {
      if (phase != 'open' && phase != 'ready') return
      phase = 'terminal'
      d.resolve('blocked')
    },
    done: d.promise,
  }
  return {
    handle,
    isReady: () => phase == 'ready',
    // run whatever was handed over, as the coordinator's tail would
    async run() {
      if (phase != 'ready') throw new Error(`cannot run: phase is ${phase}`)
      phase = 'running'
      try {
        await apply!()
        phase = 'terminal'
        d.resolve('applied')
      } catch {
        phase = 'terminal'
        d.resolve('blocked')
      }
    },
  }
}

function allocator() {
  const blindErrors: string[] = []
  const revoked: string[] = []
  const a = createRecordAllocator({ onBlindError: id => void blindErrors.push(id) })
  // the revocation is BATCH-scoped: production passes the callback's own state-only
  // revokeThisRevision, never a fresh outside-callback ordinal
  const allocate = (reqs: Parameters<typeof a.allocate>[0]) => a.allocate(reqs, r => void revoked.push(r))
  return { a, allocate, blindErrors, revoked }
}

test('same-callback [admitted x, blind h]: x does not wait on the LATER blind h', async () => {
  // the normative row. x can be awaiting a candidate that only h's completion can release, so an
  // admitted record must never be ordered behind a blind one received after it
  const { allocate } = allocator()
  const x = fakeHandle()
  const batch = allocate([{ id: 'x', handle: x.handle }, { id: 'h' }])
  const [xr, hr] = batch.records
  expect(xr.kind).toBe('admitted')
  expect(hr.kind).toBe('blind')
  // x schedules while h has NOT been given a body yet
  const applied = deferred()
  ;(xr as any).schedule(async () => void applied.resolve())
  await checkpoint()
  expect(x.isReady(), 'x reached the handle without waiting for later h').toBe(true)
  await x.run()
  await applied.promise
  // ... and h still runs afterwards
  let hRan = false
  ;(hr as any).run(() => void (hRan = true))
  await hr.done
  expect(hRan).toBe(true)
})

test('[blind h, admitted x]: x IS held behind the earlier blind h', async () => {
  const { allocate } = allocator()
  const x = fakeHandle()
  const batch = allocate([{ id: 'h' }, { id: 'x', handle: x.handle }])
  const [hr, xr] = batch.records
  ;(xr as any).schedule(async () => {})
  // ... and x's PREPARATION finalizes while h is still held. that is the hazardous order: a
  // scheduled record must survive its own finalization while its handoff is still waiting
  xr.finish()
  await checkpoint()
  expect(x.isReady(), 'x waits: h was received first').toBe(false)
  let hRan = false
  ;(hr as any).run(() => void (hRan = true))
  await hr.done
  await checkpoint()
  expect(hRan).toBe(true)
  expect(x.isReady(), 'and reaches the handle once h has run').toBe(true)
})

test('a newer same-id handle still queued behind an older one is NOT aborted by finalization', async () => {
  // round 58, and again in round 65: preparation finalization must leave a scheduled record alone.
  // a handle whose Apply is scheduled but still waiting is `ready`, and block() converts `ready`
  const { allocate } = allocator()
  const s2 = fakeHandle()
  const batch = allocate([{ id: 'd', handle: s2.handle }])
  const [r] = batch.records
  let ran = false
  ;(r as any).schedule(async () => void (ran = true))
  r.finish() // preparation is over for this record; its Apply is still queued
  await checkpoint()
  expect(s2.isReady(), 'still ready, not blocked').toBe(true)
  await s2.run()
  await r.done
  expect(ran, 'and it actually ran').toBe(true)
})

test('an admitted record with NOTHING scheduled is blocked by finalization, and rejects', async () => {
  const { allocate, revoked } = allocator()
  const h = fakeHandle()
  const batch = allocate([{ id: 'd', handle: h.handle }])
  const [r] = batch.records
  r.finish()
  await expect(r.done).rejects.toThrow(/could not be applied/)
  expect(revoked.length, 'the lease is revoked BEFORE the record rejects').toBe(1)
  expect(batch.failed(await batch.landed), 'an admitted rejection fails the callback').toBe(true)
})

test('a blind body rejects its OWN record while the lane runs the next slot, and the lease stays fail-soft', async () => {
  const { allocate, blindErrors } = allocator()
  const batch = allocate([{ id: 'h1' }, { id: 'h2' }])
  const [r1, r2] = batch.records
  let secondRan = false
  ;(r1 as any).run(() => {
    throw new Error('blind body failed')
  })
  ;(r2 as any).run(() => void (secondRan = true))
  await expect(r1.done, 'the record RETAINS its rejection').rejects.toThrow('blind body failed')
  await r2.done
  expect(secondRan, 'the lane consumed it so the next slot still ran').toBe(true)
  expect(blindErrors).toEqual(['h1'])
  expect(batch.failed(await batch.landed), 'but a blind failure never fails the callback').toBe(false)
})

test('a THROWING blind-error diagnostic does not strand the record or the lane', async () => {
  // round 67: the hook ran before the rejection, so a throwing diagnostic left record.done pending
  // forever — stranding batch.landed, its context and lease, and every corpus consumer
  const calls: string[] = []
  const a = createRecordAllocator({
    onBlindError: id => {
      calls.push(id)
      throw new Error('diagnostic failed')
    },
  })
  const batch = a.allocate([{ id: 'h1' }, { id: 'h2' }], () => {})
  const [r1, r2] = batch.records
  let secondRan = false
  ;(r1 as any).run(() => {
    throw new Error('blind body failed')
  })
  ;(r2 as any).run(() => void (secondRan = true))
  await expect(r1.done, 'rejected with the BODY error, not the hook error').rejects.toThrow('blind body failed')
  await r2.done
  expect(calls, 'the hook did run').toEqual(['h1'])
  expect(secondRan, 'and the lane still ran the next slot').toBe(true)
  const results = await batch.landed
  expect(results.map(r => r.status), 'landed settles').toEqual(['rejected', 'fulfilled'])
})

test('abort terminalizes a SCHEDULED record held behind a predecessor, not just an unstarted one', async () => {
  // round 66: abort reused finish(), which deliberately preserves scheduled work. so a record
  // scheduled behind a held blind predecessor stayed open, and `landed` — with its context and
  // every consumer of that boundary — remained pending until the predecessor eventually released
  const { allocate } = allocator()
  const x = fakeHandle()
  const batch = allocate([{ id: 'h' }, { id: 'x', handle: x.handle }])
  const [hr, xr] = batch.records
  let ran = false
  ;(xr as any).schedule(async () => void (ran = true))
  xr.finish() // preparation over; the handoff is still behind h
  let landedSettled = false
  void batch.landed.then(() => (landedSettled = true))
  await checkpoint()
  expect(landedSettled, 'nothing has terminalized: h is still held').toBe(false)
  batch.abort() // STOP, with h never released
  const results = await batch.landed
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
  expect(batch.failed(results), 'the aborted admitted record fails the callback').toBe(true)
  expect(x.isReady(), 'x is blocked, not left ready').toBe(false)
  // late calls on BOTH records are inert
  let late = false
  ;(xr as any).schedule(async () => void (late = true))
  ;(hr as any).run(() => void (late = true))
  await checkpoint()
  expect(late, 'no late work runs').toBe(false)
  expect(ran, 'and the scheduled Apply never ran').toBe(false)
})

test('the global lane spans callbacks: an earlier batch body runs before a later one', async () => {
  const { allocate } = allocator()
  const order: string[] = []
  const first = allocate([{ id: 'a' }])
  const second = allocate([{ id: 'b' }])
  // the SECOND batch is given its body first; the lane still runs them in receipt order
  ;(second.records[0] as any).run(() => void order.push('b'))
  await checkpoint()
  expect(order, 'b waits: its slot is behind a').toEqual([])
  ;(first.records[0] as any).run(() => void order.push('a'))
  await second.records[0].done
  expect(order).toEqual(['a', 'b'])
})

test('a batch whose records all settle reports no failure', async () => {
  const { allocate } = allocator()
  const h = fakeHandle()
  const batch = allocate([{ id: 'x', handle: h.handle }, { id: 'h' }])
  ;(batch.records[0] as any).schedule(async () => {})
  ;(batch.records[1] as any).run(() => {})
  await checkpoint()
  await h.run()
  const results = await batch.landed
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(batch.failed(results)).toBe(false)
})

// ---- composition with the REAL coordinator (round 66) ----

test('S1/S2/S3 for one id: finalization preserves S2, S2 blocks, S3 heals', async () => {
  // the fakeHandle rows pin the record contract; this one pins the exact composition with
  // createHiddenIngress, which is what production wires. no coordinator behaviour is duplicated
  // here — only the crossing
  const { allocate } = allocator()
  const ingress = createHiddenIngress()
  const s1 = ingress.open('d', 'c1')
  const s2 = ingress.open('d', 'c2')
  const b1 = allocate([{ id: 'd', handle: s1 }])
  const b2 = allocate([{ id: 'd', handle: s2 }])
  const held = deferred()
  ;(b1.records[0] as any).schedule(() => held.promise)
  b1.records[0].finish()
  // S2 schedules a FAILING Apply and finalizes while S1 is still running
  ;(b2.records[0] as any).schedule(async () => {
    throw new Error('S2 failed')
  })
  b2.records[0].finish()
  await checkpoint()
  expect(ingress.gate(), 'both deliveries are outstanding').toBe('pending')
  held.resolve()
  await b1.records[0].done // S1 applied
  await expect(b2.records[0].done, 'S2 was preserved by finalization, ran, and blocked').rejects.toThrow()
  expect(ingress.gate(), 'and its block gates every writer').toBe('blocked')
  // S3 for the same id succeeds and heals it
  const s3 = ingress.open('d', 'c3')
  const b3 = allocate([{ id: 'd', handle: s3 }])
  ;(b3.records[0] as any).schedule(async () => {})
  b3.records[0].finish()
  await b3.records[0].done
  expect(ingress.gate(), 'healed').toBe('writable')
})
