// The v1 KEY-DERIVATION contract (see the KDF migration design in the vault repo,
// notes/design/mind_page_kdf_migration.md, revision 2). This module owns phrase normalization,
// the code-owned parameter sets, the derivation identity, and the per-tab single-flight — the
// WASM itself is behind an injected deriver, so tests never touch it and the worker loads lazily.
//
// THE VERSION IS THE PARAMETER SET. There is no stored profile id and no registry: account
// metadata says `v: 1`, this table maps the version to code-owned parameters, and unknown
// versions are rejected — stored memory/iteration values are never consumed, so corrupt or
// hostile metadata cannot become a client-side denial of service.

// Argon2id inputs, in hash-wasm's units (memorySize in KiB)
export type KdfParams = {
  memorySize: number // KiB
  iterations: number
  parallelism: number
  hashLength: number // bytes
}

// v1: Argon2id 0x13, 64 MiB, t=3, p=1, 32-byte output. p=1 is an APP-TUNED single-threaded
// choice — the RFC 9106 memory-constrained recommendation is p=4, but a browser WASM build
// without shared memory executes lanes serially, so declaring one lane is the honest version of
// the same work. Finalized against the fleet benchmark (design: ≤ 1.5s on the slowest device)
export const KDF_VERSIONS: Record<number, KdfParams> = {
  1: { memorySize: 64 * 1024, iterations: 3, parallelism: 1, hashLength: 32 },
}

export const SALT_BYTES = 16

/**
 * Phrase bytes for v1 derivation: `utf8(NFC(phrase))`.
 *
 * v1 ONLY. The v0 key keeps the phrase's original exact Unicode bytes forever (a decomposed
 * frozen v0 vector pins that this normalization never leaks into the legacy path).
 */
export function phraseBytes(phrase: string): Uint8Array {
  return new TextEncoder().encode(phrase.normalize('NFC'))
}

// the deriver: hash-wasm's argon2id (production: in a worker), or a test stand-in. it receives
// EXPLICIT parameters so the cheap test set exists only where a test injects it — the production
// path always passes the code-owned version table's entry
export type Deriver = (input: { password: Uint8Array; salt: Uint8Array; params: KdfParams }) => Promise<Uint8Array>

/**
 * Derives the 32 raw key bytes for `(phrase, salt, version)`.
 *
 * RAW BYTES are the contract: the v0 string functions in crypto.ts hash their input again, so a
 * base64 Argon result passed through them would silently become `SHA-256(base64(Argon2(...)))`.
 * The caller imports these bytes directly (see importV1Key in crypto.ts).
 *
 * Fails if the version is unknown (stored metadata is untrusted and maps only through the
 * code-owned table) or the salt length is wrong.
 */
export async function deriveKeyBytes(
  phrase: string,
  salt: Uint8Array,
  version: number,
  deriver: Deriver
): Promise<Uint8Array> {
  const params = KDF_VERSIONS[version]
  if (!params) throw new Error(`unsupported kdf version: ${version}`)
  if (salt.length != SALT_BYTES) throw new Error(`kdf salt must be ${SALT_BYTES} bytes, got ${salt.length}`)
  return deriver({ password: phraseBytes(phrase), salt, params })
}

/**
 * Per-tab single-flight over the COMPLETE derivation identity `(phrase, salt, version)`.
 *
 * Salt is part of the identity — without it an account's key could be reused for another account.
 * Cross-tab is deliberately NOT coordinated: a second tab deriving in parallel is accepted cost
 * (the in-flight secret state is tab-local), not a correctness issue. The human-length derivation
 * runs OUTSIDE any corpus operation; the coordinator serializes the post-prompt registration
 * seam, never a worker spending a second deriving.
 */
export function createKeyCache(deriver: Deriver) {
  const inflight = new Map<string, Promise<Uint8Array>>()
  const saltHex = (salt: Uint8Array) =>
    Array.from(salt)
      .map(b => ('00' + b.toString(16)).slice(-2))
      .join('')
  return {
    derive(phrase: string, salt: Uint8Array, version: number): Promise<Uint8Array> {
      const identity = `${version}:${saltHex(salt)}:${phrase}`
      const existing = inflight.get(identity)
      if (existing) return existing
      const derivation = deriveKeyBytes(phrase, salt, version, deriver)
      inflight.set(identity, derivation)
      // a FAILED derivation must not be cached: the next attempt (a transient worker/memory
      // failure) re-derives rather than replaying the rejection forever
      derivation.catch(() => void inflight.delete(identity))
      return derivation
    },
    // observability for tests: how many identities are in flight or resolved
    size: () => inflight.size,
  }
}

/**
 * The production deriver: hash-wasm's argon2id, loaded lazily so the WASM is paid for only when a
 * v1 derivation actually runs. Argon2 version 0x13 (hash-wasm's only supported version).
 *
 * NOTE this runs the WASM on the CALLING thread. The design places production derivation in a
 * dedicated worker; that worker's body calls exactly this function (see src/kdf_worker.ts), and
 * the page-side deriver posts to it. Tests and the Node known-answer row call it directly.
 */
export const argon2idDeriver: Deriver = async ({ password, salt, params }) => {
  const { argon2id } = await import('hash-wasm')
  return argon2id({
    password,
    salt,
    memorySize: params.memorySize,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: params.hashLength,
    outputType: 'binary',
  })
}
