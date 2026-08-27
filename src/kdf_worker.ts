// The KDF WORKER: one message in — `{ id, password, salt, params }` — one message out —
// `{ id, key }` or `{ id, error }`. STATIC NAMED IMPORT, deliberately: a dynamic namespace import
// of hash-wasm defeated tree shaking and shipped a ~216 KB worker full of unrelated hash
// implementations (review 81); the named import lets Vite emit the Argon2 slice alone. The worker
// is already constructed lazily (see kdf_client.ts), so nothing is paid before the first
// derivation. No SharedArrayBuffer, no cross-origin isolation.
//
// hash-wasm's argon2id instantiates its Argon module plus a BLAKE2b module (Argon2's internal
// hash) — two WASM instances, not one. Argon2 version 0x13.

import { argon2id } from 'hash-wasm'
import type { KdfParams } from './kdf.js'

self.onmessage = async (
  event: MessageEvent<{ id: number; password: Uint8Array; salt: Uint8Array; params: KdfParams }>
) => {
  const { id, password, salt, params } = event.data
  try {
    const key = await argon2id({
      password,
      salt,
      memorySize: params.memorySize,
      iterations: params.iterations,
      parallelism: params.parallelism,
      hashLength: params.hashLength,
      outputType: 'binary',
    })
    // the returned JS buffer is transferred rather than copied. NOTE this detaches only THIS
    // buffer: hash-wasm's internal WASM memory may retain working copies of key material, and no
    // claim is made here that it does not
    ;(self as unknown as Worker).postMessage({ id, key }, [key.buffer as ArrayBuffer])
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id, error: String((e as Error)?.message ?? e) })
  }
}
