import { expect, test } from '@playwright/test'
import { prefetchThenInstall, runInitializationAttempt, settleAuthorityLease } from '../../src/startup.js'

// the startup LIFECYCLE schedules (see src/startup.ts). every defect these pin is a LIVENESS
// defect — something awaited a promise that never settled — which no table over pure decisions can
// see and the browser suite cannot drive deterministically

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

// ONE macrotask, draining recursively queued microtasks first. only for negative assertions
const checkpoint = () => new Promise<void>(res => setImmediate(res))

// ---- the prefetch ----------------------------------------------------------------------------

test('a successful prefetch is retained BEFORE the listener installs — an empty one included', async () => {
  const order: string[] = []
  let retained: unknown[] | undefined | 'unset' = 'unset'
  await prefetchThenInstall<{ id: string }>({
    eligible: true,
    fetch: async () => {
      order.push('fetch')
      return []
    },
    onError: () => order.push('error'),
    retain: docs => {
      order.push('retain')
      retained = docs
    },
    stopped: () => false,
    install: () => order.push('install'),
  })
  // the first snapshot can be dispatched in the SAME turn as the installation: a result published
  // afterwards is invisible to the decision that reads it
  expect(order).toEqual(['fetch', 'retain', 'install'])
  expect(retained).toEqual([]) // a successful EMPTY scan is not the same as no scan
})

test('a REJECTED prefetch is fail-soft: undefined is retained and the listener still installs', async () => {
  const order: string[] = []
  let retained: unknown[] | undefined | 'unset' = 'unset'
  await prefetchThenInstall<{ id: string }>({
    eligible: true,
    fetch: async () => {
      throw new Error('offline')
    },
    onError: () => order.push('error'),
    retain: docs => {
      retained = docs
    },
    stopped: () => false,
    install: () => order.push('install'),
  })
  expect(order).toEqual(['error', 'install'])
  expect(retained).toBeUndefined() // not attempted and failed carry identical policy
})

test('an INELIGIBLE page installs immediately, with no fetch', async () => {
  let fetched = false
  let installed = false
  await prefetchThenInstall<{ id: string }>({
    eligible: false,
    fetch: async () => ((fetched = true), []),
    onError: () => {},
    retain: () => {},
    stopped: () => false,
    install: () => (installed = true),
  })
  expect(fetched).toBe(false)
  expect(installed).toBe(true)
})

test('a sticky stop reached DURING the prefetch suppresses installation', async () => {
  const held = deferred<{ id: string }[]>()
  let stopped = false
  let installed = false
  const done = prefetchThenInstall<{ id: string }>({
    eligible: true,
    fetch: () => held.promise,
    onError: () => {},
    retain: () => {},
    stopped: () => stopped,
    install: () => (installed = true),
  })
  await checkpoint()
  expect(installed).toBe(false) // it waits for the prefetch, which is the whole point
  stopped = true
  held.resolve([{ id: 'a' }])
  await done
  expect(installed).toBe(false) // a listener nothing would ever terminalize
})

// ---- the initialization attempt --------------------------------------------------------------

test('the attempt is TERMINAL on every branch, including an incomplete rebuild', async () => {
  const stops: string[] = []
  expect(
    await runInitializationAttempt({
      initialize: async () => true,
      onError: () => {},
      stop: r => void stops.push(r),
    })
  ).toBe(true)
  expect(stops).toEqual([])

  // the encryption/signout early return: it never reaches the rendering pass that resolves the
  // component's success-only `initialization`, which is what used to hang here forever
  expect(
    await runInitializationAttempt({
      initialize: async () => false,
      onError: () => {},
      stop: r => void stops.push(r),
    })
  ).toBe(false)
  expect(stops).toEqual(['initialization did not complete'])

  const errors: unknown[] = []
  expect(
    await runInitializationAttempt({
      initialize: async () => {
        throw new Error('boom')
      },
      onError: e => void errors.push(e),
      stop: r => void stops.push(r),
    })
  ).toBe(false)
  expect(stops).toEqual(['initialization did not complete', 'initialization failed'])
  expect((errors[0] as Error).message).toBe('boom')
})

// ---- the authority lease ---------------------------------------------------------------------

test('a FAILED lease settles without awaiting the attempt at all', async () => {
  // the attempt never settles — a human-length phrase prompt, or an initialization that will never
  // complete. awaiting it first and inspecting `failed` after left this lease pending forever, and
  // every later lease queued behind it for the page's lifetime
  const never = new Promise<boolean>(() => {})
  expect(await settleAuthorityLease({ failed: true, attempt: () => never, initialized: () => false })).toBe('fail')
})

test('a successful lease settles BEHIND the attempt, and concludes nothing without one', async () => {
  const attempt = deferred<boolean>()
  let settled: string | undefined
  void settleAuthorityLease({
    failed: false,
    attempt: () => attempt.promise,
    initialized: () => true,
  }).then(o => (settled = o))
  await checkpoint()
  expect(settled).toBeUndefined() // ordered behind the rebuild, hence in receipt order
  attempt.resolve(true)
  await checkpoint()
  expect(settled).toBe('seal')

  // no attempt started: this callback established nothing
  expect(await settleAuthorityLease({ failed: false, attempt: () => undefined, initialized: () => true })).toBe('fail')
  // the attempt failed, or completed without setting the component flag
  expect(
    await settleAuthorityLease({ failed: false, attempt: () => Promise.resolve(false), initialized: () => true })
  ).toBe('fail')
  expect(
    await settleAuthorityLease({ failed: false, attempt: () => Promise.resolve(true), initialized: () => false })
  ).toBe('fail')
})
