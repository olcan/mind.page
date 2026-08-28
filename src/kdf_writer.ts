// The v1 WRITER SEAM (Stage 3; reviews 88-92): every encrypted write under the DISTINCT writer
// flag consumes one complete guarded session and carries an IDENTITY-TO-PUBLICATION FENCE.
//
// An acquire() result naturally ages after its Promise resolves — no cache can make another
// tab's storage changes atomic with a later Web Crypto operation or database write — so the
// contract (review 92 §2) is:
//
// 1. acquire() per save; retain the EXACT ready `keys` object;
// 2. encrypt with keys.key;
// 3. after every await between key selection and durable publication, require
//    current() === keys — the exact object, not merely non-null: A may have been replaced by a
//    newly acquired B while encryption under A was parked; and
// 4. run the last check immediately before enqueueing the actual write (the caller re-fences at
//    its enqueue seam via the returned fence). On mismatch the produced ciphertext is discarded
//    and the save fails observably — NEVER a silent v0 downgrade while the writer flag is on.
//
// Key-unavailable is equally observable: a not-ready acquisition fails the save with its reason.

import type { KdfAcquireOutcome, KdfSessionKeys } from './kdf_session.js'

// throws when the exact acquired session is no longer current — called by this module after the
// encryption await, and by the caller again at its publication/enqueue seam
export type V1Fence = () => undefined

export async function encryptV1WithSession<T>(deps: {
  // the session acquisition, ALREADY MAPPED by the caller (cancellation/supersession/conflict
  // handling is the component mapper's job); a residual not-ready fails the save here
  acquire: () => Promise<KdfAcquireOutcome>
  current: () => KdfSessionKeys | null
  // the Web Crypto operation under the acquired keys
  encrypt: (keys: KdfSessionKeys) => Promise<T>
}): Promise<{ value: T; fence: V1Fence }> {
  const outcome = await deps.acquire()
  if (outcome.kind != 'ready') throw new Error(`cannot encrypt: v1 keys unavailable (${outcome.reason})`)
  const keys = outcome.keys
  const fence: V1Fence = () => {
    // EXACT-OBJECT identity (review 92 §2): current() != null is insufficient
    if (deps.current() !== keys) throw new Error('v1 keys changed before publication: save aborted')
    return undefined
  }
  const value = await deps.encrypt(keys)
  fence() // the post-encryption check; the ciphertext is discarded by the throw
  return { value, fence }
}
