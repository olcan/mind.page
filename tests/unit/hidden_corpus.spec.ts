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

// the accessor answers membership and boundary together; these read only the membership half
const isPending = (c: ReturnType<typeof createHiddenCorpus>, id: string) => !!c.pendingBoundary(id)

// the boundary for an id that MUST be in an in-flight read. throwing rather than falling back is
// deliberate: a silent `?? Promise.resolve()` makes every later assertion vacuously true
function boundaryFor(c: ReturnType<typeof createHiddenCorpus>, id: string) {
  const b = c.pendingBoundary(id)
  if (!b) throw new Error(`no in-flight corpus read published ${id}`)
  return b
}

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

test('a FAILED operation: original error, FULFILLED boundary, cleared membership, tail intact', async () => {
  // folded from two rows so the boundary is actually captured: changing it to reject on failure
  // would strand every delivery admitted by that operation's membership, and neither earlier row
  // would have noticed
  const c = createHiddenCorpus()
  const held = deferred()
  const boom = new Error('read failed')
  const op = c.run(async run => {
    run.publishMembership(['d1'])
    await held.promise
    throw boom
  })
  const state = watch(op)
  await checkpoint()
  const boundary = watch(boundaryFor(c, 'd1'))
  await checkpoint()
  expect(isPending(c, 'd1'), 'membership is open while it runs').toBe(true)
  expect(boundary.settled, 'and the boundary is pending').toBe(false)
  held.reject(boom)
  await checkpoint()
  expect(state.error, 'the ORIGINAL error, not a wrapped outcome the caller must unwrap').toBe(boom)
  expect(boundary.settled, 'the boundary FULFILS on failure').toBe(true)
  expect(boundary.error, 'it does not reject').toBeUndefined()
  expect(isPending(c, 'd1'), 'membership is cleared').toBe(false)
  expect(await c.run(async () => 7), 'and the tail is intact').toBe(7)
})

test('an operation that stops ITSELF keeps its own error; a queued one gets CorpusStopped', async () => {
  // the round-69 defect, reproduced by the reviewer: resolving a shared stop signal queued its
  // reaction before the async body rejection could win the race, so a postcommit failure that
  // entered sticky stop and rethrew reported CorpusStopped instead of the error the caller needs
  const c = createHiddenCorpus()
  const boom = new Error('commit failed')
  let bRan = false
  const held = deferred()
  const started = deferred()
  const a = c.run(async () => {
    started.resolve()
    await held.promise // genuinely mid-flight: a body that throws SYNCHRONOUSLY wins the race on
    // array order alone, so it could not tell the cause channel apart from anything
    c.stop(boom) // sticky stop, carrying the real cause
    throw boom
  })
  const b = c.run(async () => {
    bRan = true
    return 'b'
  })
  const bState = watch(b)
  await started.promise
  held.resolve()
  await expect(a, 'A retains its exact commit error').rejects.toBe(boom)
  await checkpoint()
  expect(bState.error, 'B gets the ordinary stop outcome').toBeInstanceOf(CorpusStopped)
  expect(bRan, "and B's body never ran").toBe(false)
  expect(c.pendingBoundary('anything'), 'no read is in flight after stop').toBeUndefined()
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
  const boundary = watch(boundaryFor(c, 'h'))
  await checkpoint() // watch() records through .then: assert only after it has had its turn
  expect(isPending(c, 'h'), "a's membership is open").toBe(true)
  expect(boundary.settled, "and A's boundary is pending while A runs").toBe(false)
  c.stop()
  await checkpoint()
  // ... all of this BEFORE releasing the hold
  expect(aState.settled, "the active caller is released").toBe(true)
  expect(aState.error, 'with CorpusStopped').toBeInstanceOf(CorpusStopped)
  expect(bState.settled, 'the queued caller is released too').toBe(true)
  expect(bState.error).toBeInstanceOf(CorpusStopped)
  expect(boundary.settled, 'and the captured boundary fulfils').toBe(true)
  expect(isPending(c, 'h'), 'membership is closed').toBe(false)
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
  expect(isPending(c, 'late'), 'stop closed the window for good').toBe(false)
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
  const boundary = watch(boundaryFor(c, 'h')) // captured with B already queued
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
