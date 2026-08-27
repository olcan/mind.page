import { expect, test } from '@playwright/test'
import { createHiddenCorpus, CorpusStopped } from '../../src/hidden_corpus.js'

// the corpus seam's ordering, membership window and stop behaviour (see src/hidden_corpus.ts).
// deferred-driven: no real timers, no guessed microtask counts. the stop rows assert SETTLED FLAGS
// after one checkpoint rather than awaiting, so a broken implementation fails immediately instead
// of burning the test timeout (round 68)

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

const checkpoint = () => new Promise<void>(res => setImmediate(res))

// records how a promise settled WITHOUT awaiting it, so a row can prove something settled by a
// given moment rather than merely eventually
function watch<T>(p: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined, error: undefined as any }
  void p.then(
    v => ((state.settled = true), (state.value = v)),
    e => ((state.settled = true), (state.error = e))
  )
  return state
}

test('operations serialize: the second body does not start until the first settles', async () => {
  const c = createHiddenCorpus()
  const first = deferred()
  const order: string[] = []
  const a = c.run(async () => {
    order.push('a start')
    await first.promise
    order.push('a end')
  })
  const b = c.run(async () => void order.push('b start'))
  await checkpoint()
  expect(order, 'b waits for a').toEqual(['a start'])
  first.resolve()
  await b
  expect(order).toEqual(['a start', 'a end', 'b start'])
  await a
})

test("a FAILED operation rejects its caller with the body's own error, and does not poison the tail", async () => {
  const c = createHiddenCorpus()
  const boom = new Error('read failed')
  await expect(
    c.run(async () => {
      throw boom
    }),
    'the ORIGINAL error, not a wrapped outcome the caller must unwrap'
  ).rejects.toBe(boom)
  expect(await c.run(async () => 7), 'the next operation still ran').toBe(7)
})

test('membership is published BEFORE the point reads and cleared on success', async () => {
  const c = createHiddenCorpus()
  const held = deferred()
  expect(c.isPendingHiddenId('d1'), 'nothing pending yet').toBe(false)
  const op = c.run(async run => {
    run.publishMembership(['d1', 'd2'])
    await held.promise // the point reads
    return 'done'
  })
  await checkpoint()
  expect(c.isPendingHiddenId('d1'), 'admitted while the scan is in flight').toBe(true)
  expect(c.isPendingHiddenId('d3')).toBe(false)
  held.resolve()
  expect(await op).toBe('done')
  expect(c.isPendingHiddenId('d1'), 'and cleared once it settles').toBe(false)
})

test('membership is cleared when the operation FAILS, not only when it succeeds', async () => {
  const c = createHiddenCorpus()
  const held = deferred()
  const op = c.run(async run => {
    run.publishMembership(['d1'])
    await held.promise
    throw new Error('read failed')
  })
  await checkpoint()
  expect(c.isPendingHiddenId('d1')).toBe(true)
  held.resolve()
  await expect(op).rejects.toThrow('read failed')
  expect(c.isPendingHiddenId('d1'), 'a membership set that outlives its operation admits forever').toBe(false)
})

test('stop releases the caller, a queued operation and the boundary WHILE the body is still held', async () => {
  // the round-68 row. the previous version resolved the hold BEFORE checking anything, so an
  // implementation that left everything pending for the whole hold still passed
  const c = createHiddenCorpus()
  const held = deferred()
  const late = deferred()
  let bRan = false
  let lateEffect = false
  const a = c.run(async run => {
    run.publishMembership(['h'])
    await held.promise
    // the late continuation must observe cancellation and do nothing
    if (!run.cancelled()) lateEffect = true
    late.resolve()
    return 'a'
  })
  const b = c.run(async () => {
    bRan = true
    return 'b'
  })
  const aState = watch(a)
  const bState = watch(b)
  await checkpoint() // A's turn has STARTED: only now is its boundary installed
  const boundary = watch(c.boundary())
  await checkpoint() // watch() records through .then: assert only after it has had its turn
  expect(c.isPendingHiddenId('h'), "a's membership is open").toBe(true)
  expect(boundary.settled, "and A's boundary is pending while A runs").toBe(false)
  c.stop()
  await checkpoint()
  // ... all of this BEFORE releasing the hold
  expect(aState.settled, "the active caller is released").toBe(true)
  expect(aState.error, 'with CorpusStopped').toBeInstanceOf(CorpusStopped)
  expect(bState.settled, 'the queued caller is released too').toBe(true)
  expect(bState.error).toBeInstanceOf(CorpusStopped)
  expect(boundary.settled, 'and the captured boundary fulfils').toBe(true)
  expect(c.isPendingHiddenId('h'), 'membership is closed').toBe(false)
  expect(bRan, "the queued body never ran").toBe(false)
  // now release the held body: its late continuation is inert
  held.resolve()
  await late.promise
  await checkpoint()
  expect(lateEffect, 'the late continuation saw cancellation').toBe(false)
})

test('a body that publishes membership AFTER stop cannot reopen the window', async () => {
  // publishMembership is once-only, so the second call in one body throws before reaching the
  // stopped guard. this row publishes for the FIRST time in a late continuation
  const c = createHiddenCorpus()
  const held = deferred()
  const second = deferred()
  const published = deferred()
  const op = c.run(async run => {
    await held.promise
    run.publishMembership(['late']) // the first and only publish, after stop
    published.resolve()
    await second.promise // the window would be OPEN across this await
    return 'done'
  })
  const state = watch(op)
  await checkpoint()
  c.stop()
  held.resolve()
  await published.promise
  await checkpoint()
  // checked DURING the body's next await: after it returns, the finally clears membership anyway,
  // so a row that looked afterwards could not tell the guard apart from nothing
  expect(c.isPendingHiddenId('late'), 'stop closed the window for good').toBe(false)
  expect(state.error, 'and the caller was released').toBeInstanceOf(CorpusStopped)
  second.resolve()
})

test('a run created after stop never executes its body', async () => {
  const c = createHiddenCorpus()
  c.stop()
  let ran = false
  await expect(c.run(async () => void (ran = true))).rejects.toBeInstanceOf(CorpusStopped)
  expect(ran, 'the body never ran').toBe(false)
})

test('the boundary is the ACTIVE producer, not the queue: B enqueued behind A does not extend it', async () => {
  // the reverse-order counterpart. capturing the boundary AFTER B is enqueued is what distinguishes
  // a current-producer boundary from an alias of the tail
  const c = createHiddenCorpus()
  const aHeld = deferred()
  const bHeld = deferred()
  const a = c.run(async run => {
    run.publishMembership(['h'])
    await aHeld.promise
    return 'a'
  })
  const b = c.run(async () => {
    await bHeld.promise
    return 'b'
  })
  await checkpoint()
  const boundary = watch(c.boundary()) // captured with B already queued
  await checkpoint()
  expect(boundary.settled, "A's boundary is pending while A runs").toBe(false)
  aHeld.resolve()
  await a
  await checkpoint()
  expect(boundary.settled, "released by A alone, while unrelated B is still running").toBe(true)
  bHeld.resolve()
  await b
})

test('publishing membership twice in one operation is a programming error', async () => {
  const c = createHiddenCorpus()
  await expect(
    c.run(async run => {
      run.publishMembership(['d1'])
      run.publishMembership(['d2'])
    })
  ).rejects.toThrow(/already published/)
})
