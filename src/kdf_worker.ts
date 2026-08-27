// The KDF WORKER: one message in — `{ id, password, salt, params }` — one message out —
// `{ id, key }` or `{ id, error }`. The body is exactly src/kdf.ts's argon2idDeriver, so the
// worker adds THREADING only, never semantics; the page-side workerDeriver (kdf_client.ts) posts
// here so a 64 MiB / ~1s derivation cannot jank the main thread. No SharedArrayBuffer, no
// cross-origin isolation: hash-wasm's argon2id is a single-threaded WASM.

import { argon2idDeriver, type KdfParams } from './kdf.js'

self.onmessage = async (
  event: MessageEvent<{ id: number; password: Uint8Array; salt: Uint8Array; params: KdfParams }>
) => {
  const { id, password, salt, params } = event.data
  try {
    const key = await argon2idDeriver({ password, salt, params })
    // the key buffer is TRANSFERRED, not copied: no second copy of key material lingers here
    ;(self as unknown as Worker).postMessage({ id, key }, [key.buffer as ArrayBuffer])
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id, error: String((e as Error)?.message ?? e) })
  }
}
