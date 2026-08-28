// The page-side WORKER OWNER: one lazily created worker PER OWNER, serialized derivations, and an
// explicit dispose — the bounded lifecycle review 81 required. (One owner per acquisition is the
// callers' rule, enforced by the component's single-flight, not by this factory.) Each production derivation
// allocates ~64 MiB of Argon working memory, so two must never run concurrently in one tab; and a
// worker with no owner could outlive the sign-out that made its result meaningless.
//
// Failures are machine-readable KdfError kinds (see src/kdf.ts): `unavailable` (the worker or its
// WASM could not load/run — the broken worker is terminated and a later call retries with a fresh
// one), `failed` (the derivation itself errored), `aborted` (dispose won). A late message from a
// replaced or disposed worker is ignored by generation: entries belong to the worker instance
// that created them.
//
// OWNERSHIP: acquisition creates one of these per acquisition and disposes it in `finally` — a
// page-lifetime singleton would retain a ~64 MiB-capable worker with no owner.

import { KdfError, type Deriver } from './kdf.js'

export function createKdfWorker(): { derive: Deriver; dispose: (reason?: string) => undefined } {
  let worker: Worker | undefined
  let disposed = false
  let nextId = 0
  let tail: Promise<void> = Promise.resolve() // SERIALIZED: one derivation at a time
  const pending = new Map<number, { resolve: (key: Uint8Array) => void; reject: (e: unknown) => void }>()

  const failAllPending = (error: KdfError) => {
    for (const [, entry] of pending) entry.reject(error)
    pending.clear()
  }

  const ensureWorker = (): Worker => {
    if (worker) return worker
    const created = new Worker(new URL('./kdf_worker.ts', import.meta.url), { type: 'module' })
    created.onmessage = (event: MessageEvent<{ id: number; key?: Uint8Array; error?: string }>) => {
      if (worker !== created) return // a replaced/disposed worker's late message: not ours
      const entry = pending.get(event.data.id)
      if (!entry) return
      pending.delete(event.data.id)
      if (event.data.key) entry.resolve(event.data.key)
      else entry.reject(new KdfError('failed', event.data.error ?? 'derivation error'))
    }
    created.onmessageerror = () => {
      if (worker !== created) return
      // an undecodable response can answer NOTHING specific — the id is unreadable — so every
      // pending waiter fails rather than hanging, and the next derive starts fresh
      failAllPending(new KdfError('unavailable', 'undecodable worker message'))
      worker = undefined
      created.terminate()
    }
    created.onerror = event => {
      if (worker !== created) return
      // a LOAD/runtime failure fails every waiter — nothing else will answer them — and the
      // broken worker is terminated rather than left running; the NEXT derive retries fresh
      failAllPending(new KdfError('unavailable', event.message || 'worker error'))
      worker = undefined
      created.terminate()
    }
    worker = created
    return created
  }

  const deriveOne: Deriver = ({ password, salt, params }) =>
    new Promise<Uint8Array>((resolve, reject) => {
      if (disposed) return reject(new KdfError('aborted', 'kdf worker disposed'))
      let w: Worker
      try {
        w = ensureWorker()
      } catch (e) {
        return reject(new KdfError('unavailable', String((e as Error)?.message ?? e)))
      }
      const id = nextId++
      pending.set(id, { resolve, reject })
      try {
        w.postMessage({ id, password, salt, params })
      } catch (e) {
        // a throwing postMessage must not leave its entry behind — and the WORKER is reset too,
        // so the documented `unavailable` contract ("a later call retries with a fresh worker")
        // is literal rather than aspirational
        pending.delete(id)
        worker = undefined
        w.terminate()
        reject(new KdfError('unavailable', String((e as Error)?.message ?? e)))
      }
    })

  return {
    // SERIALIZED through a tail that settles to UNDEFINED on both arms: `turn.catch(() => {})`
    // passes a fulfilled value through, so the tail would retain the LAST RAW KEY until the next
    // derivation — the same retention deleting the cache was for (review 82)
    derive: input => {
      const turn = tail.then(() => deriveOne(input))
      tail = turn.then(
        () => undefined,
        () => undefined
      )
      return turn
    },
    // terminates the worker and rejects everything in flight as `aborted`. sign-out and principal
    // changes call this so a late result cannot publish into a session that no longer exists
    dispose(reason = 'disposed') {
      if (disposed) return undefined
      disposed = true
      failAllPending(new KdfError('aborted', reason))
      worker?.terminate()
      worker = undefined
      return undefined
    },
  }
}
