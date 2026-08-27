// The v1 KEY-DERIVATION contract (see the KDF migration design in the vault repo,
// notes/design/mind_page_kdf_migration.md, revision 2). This module owns phrase normalization, the
// ONE frozen parameter set, and derivation-boundary validation — the WASM lives in the worker
// adapter (src/kdf_worker.ts, static import), the worker lifecycle in src/kdf_client.ts, and there
// is deliberately NO cache here: the session's validated key bundle is acquisition state, and a
// phrase-keyed map would retain every attempted phrase and raw key for the tab's lifetime
// (review 81).
//
// THE VERSION IS THE PARAMETER SET. Account metadata says `v: 1`; the runtime value is UNTRUSTED
// and must be exactly the number 1 — an object lookup keyed by a stored value would accept "1",
// "__proto__" or "toString" through the prototype chain, which is how corrupt or hostile metadata
// reaches a deriver with invalid parameters.

// Argon2id inputs, in hash-wasm's units (memorySize in KiB)
export type KdfParams = {
  memorySize: number // KiB
  iterations: number
  parallelism: number
  hashLength: number // bytes
}

// v1: Argon2id 0x13, 64 MiB, t=3, p=1, 32-byte output. p=1 is the chosen lane count for a
// single-threaded browser WASM host; it is FINAL only after the fleet benchmark completes —
// desktop Chromium measured 121ms, the low-memory Safari run is still OPEN, and no v1 metadata is
// provisioned until the parameters freeze (the design's rollout rule)
export const V1_PARAMS: Readonly<KdfParams> = Object.freeze({
  memorySize: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
})

export const SALT_BYTES = 16
export const KEY_BYTES = 32

// machine-readable derivation outcomes (the design's "derivation unavailable/failed/aborted"):
// acquisition must be able to tell these from cipher outcomes, and a generic Error cannot carry
// that
export type KdfFailure = 'unavailable' | 'failed' | 'aborted'
export class KdfError extends Error {
  constructor(
    public readonly kind: KdfFailure,
    detail: string
  ) {
    super(`kdf ${kind}: ${detail}`)
  }
}

/**
 * Phrase bytes for v1 derivation: `utf8(NFC(phrase))`.
 *
 * v1 ONLY. The v0 key keeps the phrase's original exact Unicode bytes forever (a literal
 * decomposed-phrase v0 vector pins that this normalization never leaks into the legacy path).
 */
export function phraseBytes(phrase: string): Uint8Array {
  return new TextEncoder().encode(phrase.normalize('NFC'))
}

// the deriver: the worker adapter in production, a stand-in in tests. it receives EXPLICIT
// parameters so the cheap test set exists only where a caller injects it — the production path
// always passes the frozen V1_PARAMS
export type Deriver = (input: { password: Uint8Array; salt: Uint8Array; params: KdfParams }) => Promise<Uint8Array>

/**
 * Derives the 32 raw key bytes for `(phrase, salt, version)`, validating every untrusted input at
 * this boundary.
 *
 * RAW BYTES are the contract: the v0 string functions in crypto.ts hash their input again, so a
 * base64 Argon result passed through them would silently become `SHA-256(base64(Argon2(...)))`.
 * The caller imports these bytes directly (see importV1Key in crypto.ts) and retains only the
 * non-extractable `CryptoKey`.
 *
 * Fails if the version is not EXACTLY the number 1 (stored metadata is untrusted; no lookup a
 * hostile string can reach), the salt is not exactly 16 bytes, or the deriver returns anything but
 * exactly 32 bytes — a faulty deriver must fail here, not at a later import.
 */
export async function deriveKeyBytes(
  phrase: string,
  salt: Uint8Array,
  version: unknown,
  deriver: Deriver
): Promise<Uint8Array> {
  if (version !== 1) throw new Error(`unsupported kdf version: ${String(version)}`)
  if (!(salt instanceof Uint8Array) || salt.length != SALT_BYTES)
    throw new Error(`kdf salt must be ${SALT_BYTES} bytes`)
  const key = await deriver({ password: phraseBytes(phrase), salt, params: V1_PARAMS })
  if (!(key instanceof Uint8Array) || key.length != KEY_BYTES)
    throw new Error(`kdf deriver returned ${(key as Uint8Array)?.length ?? typeof key} bytes, expected ${KEY_BYTES}`)
  return key
}
