// The page-side WORKER DERIVER: a `Deriver` (see src/kdf.ts) that posts to src/kdf_worker.ts, so
// the production derivation never runs on the main thread. The worker is created LAZILY on the
// first derivation and retained — one worker per tab, matching the per-tab single-flight — and a
// worker that fails to load surfaces as the design's "derivation unavailable" outcome rather than
// hanging the caller.

import type { Deriver } from './kdf.js'

export function createWorkerDeriver(): Deriver {
  let worker: Worker | undefined
  let nextId = 0
  const pending = new Map<number, { resolve: (key: Uint8Array) => void; reject: (e: unknown) => void }>()
  return ({ password, salt, params }) =>
    new Promise((resolve, reject) => {
      try {
        // Vite's worker bundling: the URL form is what makes the worker a build asset
        worker ??= new Worker(new URL('./kdf_worker.ts', import.meta.url), { type: 'module' })
      } catch (e) {
        return reject(new Error(`kdf worker unavailable: ${String((e as Error)?.message ?? e)}`))
      }
      const id = nextId++
      pending.set(id, { resolve, reject })
      worker.onmessage = (event: MessageEvent<{ id: number; key?: Uint8Array; error?: string }>) => {
        const entry = pending.get(event.data.id)
        if (!entry) return
        pending.delete(event.data.id)
        if (event.data.key) entry.resolve(event.data.key)
        else entry.reject(new Error(`kdf derivation failed: ${event.data.error}`))
      }
      worker.onerror = event => {
        // a LOAD failure fails every waiter: nothing else will ever answer them
        for (const [, entry] of pending) entry.reject(new Error(`kdf worker error: ${event.message}`))
        pending.clear()
        worker = undefined // the next derivation retries the load (transient failures recover)
      }
      worker.postMessage({ id, password, salt, params })
    })
}
