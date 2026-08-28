import { expect, test } from '@playwright/test'
import { createKdfWorker } from '../../src/kdf_client.js'
import { KdfError, type KdfParams } from '../../src/kdf.js'

// the WORKER OWNER's lifecycle state machine (see src/kdf_client.ts), driven through a stubbed
// `globalThis.Worker` — review 82's point: a real-browser success row proves emission and the
// happy path, but the failure RACES (dispose mid-flight, error retry, late messages, a throwing
// postMessage) are only deterministic with a controllable Worker. No production injection surface:
// the stub is the global, exactly what the code constructs.

const PARAMS: KdfParams = { memorySize: 8, iterations: 1, parallelism: 1, hashLength: 32 }
const input = () => ({ password: new Uint8Array([1]), salt: new Uint8Array(16), params: PARAMS })
const KEY = new Uint8Array(32).fill(5)

class FakeWorker {
  static instances: FakeWorker[] = []
  static failConstruction = false
  static throwOnPost: Error | undefined
  onmessage: ((e: { data: any }) => void) | null = null
  onmessageerror: (() => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  posted: any[] = []
  terminated = false
  constructor() {
    if (FakeWorker.failConstruction) throw new Error('construction refused')
    FakeWorker.instances.push(this)
  }
  postMessage(message: any) {
    if (FakeWorker.throwOnPost) throw FakeWorker.throwOnPost
    this.posted.push(message)
  }
  terminate() {
    this.terminated = true
  }
  // test controls
  answer(id: number, key: Uint8Array = KEY) {
    this.onmessage?.({ data: { id, key } })
  }
  fail(id: number, error: string) {
    this.onmessage?.({ data: { id, error } })
  }
}

const realWorker = globalThis.Worker
test.beforeEach(() => {
  FakeWorker.instances = []
  FakeWorker.failConstruction = false
  FakeWorker.throwOnPost = undefined
  ;(globalThis as any).Worker = FakeWorker
})
test.afterEach(() => void ((globalThis as any).Worker = realWorker))

const flush = () => new Promise<void>(res => setImmediate(res))

test('lazy construction, and AT MOST ONE posted derivation at a time', async () => {
  const owner = createKdfWorker()
  expect(FakeWorker.instances, 'nothing constructed before the first derive').toHaveLength(0)
  const first = owner.derive(input())
  const second = owner.derive(input())
  await flush()
  const w = FakeWorker.instances[0]
  expect(FakeWorker.instances, 'one worker').toHaveLength(1)
  expect(
    w.posted,
    'the second derivation is QUEUED, not posted: two concurrent productions would double the Argon footprint'
  ).toHaveLength(1)
  w.answer(w.posted[0].id)
  expect(await first).toEqual(KEY)
  await flush()
  expect(w.posted, 'the queue advances only after the first settles').toHaveLength(2)
  w.answer(w.posted[1].id)
  expect(await second).toEqual(KEY)
  owner.dispose()
})

test('dispose rejects ACTIVE and QUEUED work as aborted, terminates, and ignores late messages', async () => {
  const owner = createKdfWorker()
  const active = owner.derive(input())
  const queued = owner.derive(input())
  await flush()
  const w = FakeWorker.instances[0]
  owner.dispose('sign-out')
  const activeFailure = (await active.catch(e => e)) as KdfError
  const queuedFailure = (await queued.catch(e => e)) as KdfError
  expect(activeFailure.kind, 'active work aborted').toBe('aborted')
  expect(queuedFailure.kind, 'queued work aborted too').toBe('aborted')
  expect(w.terminated, 'the worker is terminated').toBe(true)
  w.answer(0) // a LATE message from the terminated worker
  await flush()
  const post = (await owner.derive(input()).catch(e => e)) as KdfError
  expect(post.kind, 'derivations after dispose reject immediately').toBe('aborted')
  expect(FakeWorker.instances, 'and construct nothing').toHaveLength(1)
})

test('onerror fails pending work as unavailable, terminates, and the NEXT derive retries fresh', async () => {
  const owner = createKdfWorker()
  const first = owner.derive(input())
  await flush()
  const broken = FakeWorker.instances[0]
  broken.onerror?.({ message: 'wasm failed to load' })
  const failure = (await first.catch(e => e)) as KdfError
  expect(failure.kind).toBe('unavailable')
  expect(broken.terminated, 'the broken worker is terminated, not leaked').toBe(true)
  const retry = owner.derive(input())
  await flush()
  expect(FakeWorker.instances, 'a FRESH worker for the retry').toHaveLength(2)
  const fresh = FakeWorker.instances[1]
  // the OLD worker answers the new id WITH THE WRONG KEY: without the generation fence this
  // poisoned answer would resolve the retry
  broken.answer(fresh.posted[0].id, new Uint8Array(32).fill(66))
  await flush()
  fresh.answer(fresh.posted[0].id)
  expect(await retry, 'only the CURRENT worker instance can answer').toEqual(KEY)
  owner.dispose()
})

test('messageerror and a throwing postMessage both reset the worker for the next call', async () => {
  const owner = createKdfWorker()
  const first = owner.derive(input())
  await flush()
  const w = FakeWorker.instances[0]
  w.onmessageerror?.() // an undecodable response answers nothing specific: fail everything
  expect(((await first.catch(e => e)) as KdfError).kind).toBe('unavailable')
  expect(w.terminated).toBe(true)
  FakeWorker.throwOnPost = new Error('detached port')
  const second = owner.derive(input())
  await flush()
  expect(((await second.catch(e => e)) as KdfError).kind).toBe('unavailable')
  expect(FakeWorker.instances[1].terminated, 'the post-throw worker is reset too').toBe(true)
  FakeWorker.throwOnPost = undefined
  const third = owner.derive(input())
  await flush()
  const fresh = FakeWorker.instances[2]
  fresh.answer(fresh.posted[0].id)
  expect(await third, 'the documented retry-with-a-fresh-worker contract is literal').toEqual(KEY)
  owner.dispose()
})

test('a failed CONSTRUCTION is unavailable, and the tail retains no key after success', async () => {
  FakeWorker.failConstruction = true
  const owner = createKdfWorker()
  expect(((await owner.derive(input()).catch(e => e)) as KdfError).kind).toBe('unavailable')
  FakeWorker.failConstruction = false
  const ok = owner.derive(input())
  await flush()
  const w = FakeWorker.instances[0]
  w.answer(w.posted[0].id)
  expect(await ok).toEqual(KEY)
  // NOTE the tail-retention rule (the serialization tail settles to undefined, never the raw
  // key) has NO observable surface by design — exposing the tail to pin it would create the very
  // reference path the rule removes. it is source-reviewed, and stated here so nobody mistakes
  // this row for its pin
  owner.dispose()
})
