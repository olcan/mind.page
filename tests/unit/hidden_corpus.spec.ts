import { expect, test } from '@playwright/test'
import { createHiddenCorpus } from '../../src/hidden_corpus.js'

// the corpus seam's ordering, membership window and stop behaviour (see src/hidden_corpus.ts).
// deferred-driven: no real timers, no guessed microtask counts

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

const checkpoint = () => new Promise<void>(res => setImmediate(res))

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
  expect((await a).kind).toBe('ok')
})

test('a FAILED operation does not poison the tail', async () => {
  const c = createHiddenCorpus()
  const failed = await c.run(async () => {
    throw new Error('read failed')
  })
  expect(failed.kind).toBe('failed')
  expect((failed as any).error.message).toBe('read failed')
  const next = await c.run(async () => 7)
  expect(next, 'the next operation still ran').toEqual({ kind: 'ok', value: 7 })
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
  expect(await op).toEqual({ kind: 'ok', value: 'done' })
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
  expect((await op).kind).toBe('failed')
  expect(c.isPendingHiddenId('d1'), 'a membership set that outlives its operation admits forever').toBe(false)
})

test('stop cancels the operation in flight, clears membership, and still FULFILS the boundary', async () => {
  const c = createHiddenCorpus()
  const held = deferred()
  let observedCancelled = false
  const op = c.run(async run => {
    run.publishMembership(['d1'])
    await held.promise
    observedCancelled = run.cancelled()
    return 'value'
  })
  await checkpoint()
  expect(c.isPendingHiddenId('d1')).toBe(true)
  c.stop()
  expect(c.isPendingHiddenId('d1'), 'membership clears immediately on stop').toBe(false)
  held.resolve()
  expect(await op, 'a value produced across a stop is NOT reported as ok').toEqual({ kind: 'cancelled' })
  expect(observedCancelled, 'and the body could see it before returning').toBe(true)
  // the boundary must be RELEASED, not left hanging for the page's lifetime
  let boundarySettled = false
  void c.boundary().then(() => (boundarySettled = true))
  await checkpoint()
  expect(boundarySettled).toBe(true)
})

test('a run created after stop never executes its body', async () => {
  const c = createHiddenCorpus()
  c.stop()
  let ran = false
  const op = c.run(async () => void (ran = true))
  expect(await op).toEqual({ kind: 'cancelled' })
  expect(ran, 'the body never ran').toBe(false)
})

test('the boundary means every operation SO FAR has settled, and does not absorb later work', async () => {
  const c = createHiddenCorpus()
  const first = deferred()
  void c.run(async () => void (await first.promise))
  const boundary = c.boundary()
  let settled = false
  void boundary.then(() => (settled = true))
  await checkpoint()
  expect(settled, 'the in-flight operation holds it').toBe(false)
  // work queued AFTER the boundary was taken must not extend it
  const second = deferred()
  void c.run(async () => void (await second.promise))
  first.resolve()
  await boundary
  expect(settled, 'released by the first operation alone').toBe(true)
  second.resolve()
})

test('publishing membership twice in one operation is a programming error', async () => {
  const c = createHiddenCorpus()
  const op = await c.run(async run => {
    run.publishMembership(['d1'])
    run.publishMembership(['d2'])
  })
  expect(op.kind).toBe('failed')
  expect((op as any).error.message).toMatch(/already published/)
})
