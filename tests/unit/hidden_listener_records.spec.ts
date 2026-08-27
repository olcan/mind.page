import { expect, test } from '@playwright/test'
import { createRecordAllocator, type RecordHandle } from '../../src/hidden_listener_records.js'

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
  const a = createRecordAllocator({
    onBlindError: id => void blindErrors.push(id),
    onAdmittedBlocked: id => void revoked.push(id),
  })
  return { a, blindErrors, revoked }
}

test('same-callback [admitted x, blind h]: x does not wait on the LATER blind h', async () => {
  // the normative row. x can be awaiting a candidate that only h's completion can release, so an
  // admitted record must never be ordered behind a blind one received after it
  const { a } = allocator()
  const x = fakeHandle()
  const batch = a.allocate([{ id: 'x', handle: x.handle }, { id: 'h' }])
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
  const { a } = allocator()
  const x = fakeHandle()
  const batch = a.allocate([{ id: 'h' }, { id: 'x', handle: x.handle }])
  const [hr, xr] = batch.records
  ;(xr as any).schedule(async () => {})
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
  const { a } = allocator()
  const s2 = fakeHandle()
  const batch = a.allocate([{ id: 'd', handle: s2.handle }])
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
  const { a, revoked } = allocator()
  const h = fakeHandle()
  const batch = a.allocate([{ id: 'd', handle: h.handle }])
  const [r] = batch.records
  r.finish()
  await expect(r.done).rejects.toThrow(/could not be applied/)
  expect(revoked, 'the lease is revoked BEFORE the record rejects').toEqual(['d'])
  expect(batch.failed(await batch.landed), 'an admitted rejection fails the callback').toBe(true)
})

test('a blind body rejects its OWN record while the lane runs the next slot, and the lease stays fail-soft', async () => {
  const { a, blindErrors } = allocator()
  const batch = a.allocate([{ id: 'h1' }, { id: 'h2' }])
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

test('abort terminalizes a hung preparation: landed settles and late work is inert', async () => {
  // stop, while one record has been given nothing because its decrypt never returned
  const { a } = allocator()
  const h = fakeHandle()
  const batch = a.allocate([{ id: 'x', handle: h.handle }, { id: 'h' }])
  let landedSettled = false
  void batch.landed.then(() => (landedSettled = true))
  await checkpoint()
  expect(landedSettled, 'nothing has terminalized yet').toBe(false)
  batch.abort()
  const results = await batch.landed
  expect(results.map(r => r.status)).toEqual(['rejected', 'fulfilled'])
  expect(batch.failed(results), 'the aborted admitted record fails the callback').toBe(true)
  // a late continuation that tries to schedule after the abort is inert: the handle is terminal
  let late = false
  ;(batch.records[0] as any).schedule(async () => void (late = true))
  await checkpoint()
  expect(late, 'the late Apply never runs').toBe(false)
})

test('the global lane spans callbacks: an earlier batch body runs before a later one', async () => {
  const { a } = allocator()
  const order: string[] = []
  const first = a.allocate([{ id: 'a' }])
  const second = a.allocate([{ id: 'b' }])
  // the SECOND batch is given its body first; the lane still runs them in receipt order
  ;(second.records[0] as any).run(() => void order.push('b'))
  await checkpoint()
  expect(order, 'b waits: its slot is behind a').toEqual([])
  ;(first.records[0] as any).run(() => void order.push('a'))
  await second.records[0].done
  expect(order).toEqual(['a', 'b'])
})

test('a batch whose records all settle reports no failure', async () => {
  const { a } = allocator()
  const h = fakeHandle()
  const batch = a.allocate([{ id: 'x', handle: h.handle }, { id: 'h' }])
  ;(batch.records[0] as any).schedule(async () => {})
  ;(batch.records[1] as any).run(() => {})
  await checkpoint()
  await h.run()
  const results = await batch.landed
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(batch.failed(results)).toBe(false)
})
