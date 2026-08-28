// The account KDF PROFILE: metadata decoding, salt provisioning, and the persisted key envelope
// (see the KDF migration design in the vault repo, notes/design/mind_page_kdf_migration.md).
//
// Stored metadata and stored envelopes are UNTRUSTED input. Three states, never collapsed:
// ABSENT (provisionable — the account has no profile yet), VALID (adopt it), and PRESENT-INVALID
// (corrupt or from-the-future metadata, which must FAIL rather than be silently re-provisioned:
// overwriting a salt this client merely cannot read would strand every ciphertext derived from it).

import { SALT_BYTES, KEY_BYTES } from './kdf.js'

// canonical standard base64 for exactly 16 bytes: 22 chars + '=='. the final-block alternation
// matters — a lax {22}== accepts noncanonical pad bits, giving one salt many encodings, and the
// envelope comparison and rules both assume ONE canonical form (the firestore rule pins the same
// regex)
const SALT_B64 = /^[A-Za-z0-9+/]{21}[AQgw]==$/

export function encodeSalt(salt: Uint8Array): string {
  if (salt.length != SALT_BYTES) throw new Error(`salt must be ${SALT_BYTES} bytes`)
  let binary = ''
  for (const byte of salt) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeSalt(saltB64: string): Uint8Array {
  if (!SALT_B64.test(saltB64)) throw new Error('noncanonical or malformed salt encoding')
  const binary = atob(saltB64)
  return new Uint8Array([...binary].map(c => c.charCodeAt(0)))
}

export type KdfProfile = { v: 1; salt: string }

export type ProfileState =
  | { kind: 'absent' } // provisionable
  | { kind: 'valid'; profile: KdfProfile }
// present-but-invalid THROWS: it is not a third value to route on, because every route except
// "stop and report" is wrong for it

/** Decodes the `kdf` field of a users/{uid} document. */
export function decodeKdfMetadata(kdf: unknown): ProfileState {
  if (kdf === undefined || kdf === null) return { kind: 'absent' }
  if (typeof kdf != 'object' || Array.isArray(kdf)) throw new Error('kdf metadata is not a map')
  const { v, salt, ...rest } = kdf as Record<string, unknown>
  if (Object.keys(rest).length) throw new Error(`kdf metadata has unexpected fields: ${Object.keys(rest).join(',')}`)
  if (v !== 1) throw new Error(`unsupported kdf version: ${String(v)}`)
  if (typeof salt != 'string' || !SALT_B64.test(salt)) throw new Error('kdf salt is not canonical 16-byte base64')
  return { kind: 'valid', profile: { v: 1, salt } }
}

/**
 * Provisions (or adopts) the account's KDF profile in ONE transaction.
 *
 * The CANDIDATE salt is generated once, OUTSIDE the transaction body — Firestore re-runs the body
 * on contention, and a fresh salt per retry would make "which salt did we actually commit"
 * unanswerable. The returned profile is the one the SUCCESSFUL attempt observed or wrote: a
 * transaction loser derives from the committed value, never from its local candidate.
 *
 * Fails (rather than overwriting) on present-but-invalid metadata, and propagates transaction
 * failures — offline provisioning is impossible by construction, which is the design's
 * server-confirmation rule.
 */
export async function provisionKdfProfile(deps: {
  // one transaction: `get` reads the users/{uid} doc's data (undefined if missing); `set` merges
  // { kdf: profile } into it. both run inside the SAME transaction attempt
  runTransaction: <T>(
    body: (tx: {
      get: () => Promise<Record<string, unknown> | undefined>
      set: (kdf: KdfProfile) => void
    }) => Promise<T>
  ) => Promise<T>
  randomSalt: () => Uint8Array
}): Promise<KdfProfile> {
  const candidate: KdfProfile = { v: 1, salt: encodeSalt(deps.randomSalt()) }
  return deps.runTransaction(async tx => {
    const state = decodeKdfMetadata((await tx.get())?.kdf)
    if (state.kind == 'valid') return state.profile // adopt the committed value
    tx.set(candidate)
    return candidate
  })
}

// ---- the persisted key envelope ----------------------------------------------------------------
// localStorage form of the derived v1 key: ACCOUNT-BOUND, exact-shape, canonical encodings. a
// mismatch on any field means the envelope is for some other account/profile and is DISCARDED —
// never "close enough". decode validates; the caller compares uid and salt against the
// server-confirmed profile before importing the key.

export type KeyEnvelope = { uid: string; v: 1; salt: string; key: string }

export function encodeKeyEnvelope(envelope: { uid: string; salt: string; keyBytes: Uint8Array }): string {
  if (envelope.keyBytes.length != KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`)
  let binary = ''
  for (const byte of envelope.keyBytes) binary += String.fromCharCode(byte)
  return JSON.stringify({ uid: envelope.uid, v: 1, salt: envelope.salt, key: btoa(binary) })
}

/** Decodes and validates a stored envelope; returns null for ANY defect (a stored value is never
 * worth an error path — it is simply not a usable envelope). */
export function decodeKeyEnvelope(
  stored: string | null,
  expectedUid: string
): { salt: string; keyBytes: Uint8Array } | null {
  if (!stored) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return null
  }
  if (typeof parsed != 'object' || parsed === null || Array.isArray(parsed)) return null
  const { uid, v, salt, key, ...rest } = parsed as Record<string, unknown>
  if (Object.keys(rest).length) return null
  if (uid !== expectedUid) return null // account-bound: some other principal's envelope
  if (v !== 1) return null
  if (typeof salt != 'string' || !SALT_B64.test(salt)) return null
  if (typeof key != 'string') return null
  let keyBytes: Uint8Array
  try {
    keyBytes = new Uint8Array([...atob(key)].map(c => c.charCodeAt(0)))
  } catch {
    return null
  }
  if (keyBytes.length != KEY_BYTES) return null
  // canonical re-encode: the stored encoding must be THE encoding, or two strings could name one
  // key and identity comparisons drift
  let binary = ''
  for (const byte of keyBytes) binary += String.fromCharCode(byte)
  if (btoa(binary) !== key) return null
  return { salt, keyBytes }
}
