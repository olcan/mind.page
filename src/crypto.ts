// aes-gcm encryption for item data (extracted from index.svelte; see encrypt/decrypt there for
// the session-secret wrappers). Ciphers are '<24-hex-char iv>' + base64(cipher bytes) in text
// mode, or '~' + iv hex + raw cipher bytes in uint8 ("bytes") mode; the key is the sha-256 of
// the utf8-encoded secret, and the stored form of a secret phrase is base64(sha-256(uid+phrase))

import { byteArrayToString, byteStringToArray, concatByteArrays } from './bytes.js'

// aes-gcm key for the secret, usable for the given operations
async function secretKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const secret_sha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', secret_sha256, { name: 'AES-GCM' }, false, usages)
}

const ivToHex = (iv: Uint8Array) =>
  Array.from(iv)
    .map(b => ('00' + b.toString(16)).slice(-2))
    .join('') // 24 hex chars for the 96-bit iv

const ivFromHex = (hex: string) => new Uint8Array(hex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)))

// the stored form of the secret phrase: base64 of sha-256(uid + phrase)
export async function hashSecretPhrase(uid: string, phrase: string): Promise<string> {
  const secret_utf8 = new TextEncoder().encode(uid + phrase)
  const secret_buffer = await crypto.subtle.digest('SHA-256', secret_utf8)
  const secret_array = Array.from(new Uint8Array(secret_buffer))
  return btoa(secret_array.map(b => String.fromCharCode(b)).join(''))
}

export async function encryptWithSecret(text: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)) // 96-bit random iv
  const key = await secretKey(secret, ['encrypt'])
  const cipher_buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text))
  return ivToHex(iv) + btoa(byteArrayToString(new Uint8Array(cipher_buffer)))
}

// encrypt arbitrary bytes (uint8); ideal for firebase storage of large binary data such as images
export async function encryptBytesWithSecret(
  bytes: Uint8Array<ArrayBuffer>,
  secret: string
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12)) // 96-bit random iv
  const key = await secretKey(secret, ['encrypt'])
  const cipher_buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)
  return concatByteArrays(byteStringToArray('~' + ivToHex(iv)), new Uint8Array(cipher_buffer))
}

// throws on a wrong secret (aes-gcm authentication), which getSecretPhrase in index.svelte uses
// to validate an entered phrase before committing it
export async function decryptWithSecret(cipher: string, secret: string): Promise<string> {
  if (cipher[0] == '~') throw new Error('data encrypted using encrypt_bytes must be decrypted using decrypt_bytes')
  const iv = ivFromHex(cipher.slice(0, 24))
  const key = await secretKey(secret, ['decrypt'])
  const cipher_array = byteStringToArray(atob(cipher.slice(24))) // base64-decode cipher string (encrypted in text mode)
  const text_buffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher_array)
  return new TextDecoder().decode(text_buffer)
}

export async function decryptBytesWithSecret(
  cipher: Uint8Array<ArrayBuffer>,
  secret: string
): Promise<Uint8Array<ArrayBuffer>> {
  // detect uint8 ("bytes") mode based on ~ prefix
  const encrypted_bytes = cipher[0] == '~'.charCodeAt(0)
  const offset = encrypted_bytes ? 1 : 0 // uint8 encoding has offset 1 for '~' prefix
  const iv = ivFromHex(byteArrayToString(cipher.subarray(offset, 24 + offset)))
  const key = await secretKey(secret, ['decrypt'])
  const cipher_array = encrypted_bytes
    ? cipher.subarray(24 + offset)
    : byteStringToArray(atob(byteArrayToString(cipher.subarray(24 + offset))))
  const text_buffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher_array)
  if (encrypted_bytes) return new Uint8Array(text_buffer) // return raw uint8 array
  // backwards compatibility mode: convert utf8-decoded text to uint8 array (code points <= 255 only)
  return byteStringToArray(new TextDecoder().decode(text_buffer))
}

// ---- v1: versioned, KDF-keyed ciphertext -------------------------------------------------------
// (See the KDF migration design, notes/design/mind_page_kdf_migration.md revision 2, in the vault
// repo.) The v0 functions above stay FROZEN — they hash their string input again, so a derived key
// passed through them would silently become SHA-256(base64(Argon2(...))). The v1 API takes the 32
// RAW key bytes from src/kdf.ts and imports them directly.
//
// Frame: text `'1!'` + iv hex (24) + base64(cipher); bytes `'~1!'` + iv hex + raw cipher bytes.
// '!' is outside both hex and base64, so v0/v1 detection is one prefix test and v0 remains the
// untagged form. AAD is one EXACT code-owned domain string per mode — it authenticates the regime
// the reader selected from the frame, and keeps the same key/ciphertext from crossing API domains.
// Neither uid nor salt is repeated in AAD: the per-account salt already makes the key distinct.

const V1_TEXT_AAD = new TextEncoder().encode('mindpage.v1.text')
const V1_BYTES_AAD = new TextEncoder().encode('mindpage.v1.bytes')

// the OBSERVABLE failure taxonomy (design: "what is actually observable"). AES-GCM cannot say WHY
// authentication failed — wrong key, modified cipher/tag and wrong AAD are one OperationError —
// so the codec distinguishes only what it can see. "Wrong phrase" is an interpretation SECRET
// ACQUISITION makes before a candidate is validated, never a fact this layer returns
export type CipherFailure = 'malformed-frame' | 'unsupported-version' | 'authentication-failed'
export class CipherError extends Error {
  constructor(
    public readonly kind: CipherFailure,
    detail: string
  ) {
    super(`${kind}: ${detail}`)
  }
}

/**
 * Imports 32 raw derived key bytes as a non-extractable AES-GCM key (retain the result; the raw
 * bytes should not outlive this call). A wrong length is an INVARIANT error, deliberately not a
 * CipherError: no frame is involved, and acquisition must not confuse broken key plumbing with
 * corpus corruption.
 */
export async function importV1Key(keyBytes: Uint8Array<ArrayBuffer>, usages: KeyUsage[] = ['encrypt', 'decrypt']) {
  if (keyBytes.length != 32) throw new Error(`invalid v1 key material: ${keyBytes.length} bytes, expected 32`)
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, usages)
}

const IV_HEX = /^[0-9a-f]{24}$/
// ONE strict grammar shared by classification and parsing: canonical '1!' exactly — never a
// looser tag match in one place and a stricter one in the other
const V1_TEXT_TAG = '1!'
const V1_BYTES_TAG = '~1!'
// a GCM ciphertext is plaintext + the 16-byte tag: anything shorter is an impossible frame and
// must be malformed, not an authentication failure the acquisition policy would read as evidence
const GCM_MIN_BYTES = 16
// translate ONLY the operation's own failure. an InvalidAccessError (wrong key usage/algorithm)
// is an integration error, not evidence about the data, and must propagate as itself
const isOperationError = (e: unknown) => e instanceof DOMException && e.name == 'OperationError'

// ---- the ONE structural preflight per storage mode ---------------------------------------------
// classification and decryption run the SAME frame validation (review 82: a header-only classifier
// called frames v0/v1 that the decryptors then called malformed). the preflight is non-decrypting:
// it validates the version tag, iv, payload decodability and the GCM minimum — everything short of
// the key

export type TextPreflight =
  | { kind: 'v0' }
  | { kind: 'v1'; ivHex: string; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'unsupported-version' }
  | { kind: 'malformed-frame' }

export function preflightTextCipher(cipher: string): TextPreflight {
  if (cipher.startsWith(V1_TEXT_TAG)) {
    const ivHex = cipher.slice(2, 26)
    if (!IV_HEX.test(ivHex)) return { kind: 'malformed-frame' }
    let bytes: Uint8Array<ArrayBuffer>
    try {
      bytes = byteStringToArray(atob(cipher.slice(26)))
    } catch {
      return { kind: 'malformed-frame' }
    }
    if (bytes.length < GCM_MIN_BYTES) return { kind: 'malformed-frame' }
    return { kind: 'v1', ivHex, bytes }
  }
  if (/^\d+!/.test(cipher)) return { kind: 'unsupported-version' }
  // v0: untagged, 24-hex iv + base64 payload of at least the GCM tag
  if (!IV_HEX.test(cipher.slice(0, 24))) return { kind: 'malformed-frame' }
  try {
    if (byteStringToArray(atob(cipher.slice(24))).length < GCM_MIN_BYTES) return { kind: 'malformed-frame' }
  } catch {
    return { kind: 'malformed-frame' }
  }
  return { kind: 'v0' }
}

export type BytesPreflight =
  | { kind: 'v0' }
  | { kind: 'v1'; ivHex: string; payload: Uint8Array<ArrayBuffer> }
  | { kind: 'unsupported-version' }
  | { kind: 'malformed-frame' }

export function preflightBytesCipher(cipher: Uint8Array<ArrayBuffer>): BytesPreflight {
  const head = byteArrayToString(cipher.subarray(0, 28))
  if (head.startsWith(V1_BYTES_TAG)) {
    const ivHex = head.slice(3, 27)
    if (!IV_HEX.test(ivHex)) return { kind: 'malformed-frame' }
    if (cipher.length - 27 < GCM_MIN_BYTES) return { kind: 'malformed-frame' }
    return { kind: 'v1', ivHex, payload: cipher.subarray(27) }
  }
  if (/^~\d+!/.test(head)) return { kind: 'unsupported-version' }
  if (head[0] == '~') {
    // v0 bytes mode: '~' + iv hex + raw cipher bytes
    if (!IV_HEX.test(head.slice(1, 25))) return { kind: 'malformed-frame' }
    if (cipher.length - 25 < GCM_MIN_BYTES) return { kind: 'malformed-frame' }
    return { kind: 'v0' }
  }
  // legacy TEXT-form value stored as bytes (decryptBytesWithSecret's compatibility mode): the
  // payload after the 24 ASCII iv chars is base64 TEXT, so the structural check decodes it and
  // requires the GCM minimum — review 83: iv-only validation accepted a three-byte payload
  if (!IV_HEX.test(head.slice(0, 24))) return { kind: 'malformed-frame' }
  try {
    if (byteStringToArray(atob(byteArrayToString(cipher.subarray(24)))).length < GCM_MIN_BYTES)
      return { kind: 'malformed-frame' }
  } catch {
    return { kind: 'malformed-frame' }
  }
  return { kind: 'v0' }
}

export async function encryptV1Text(text: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: V1_TEXT_AAD },
    key,
    new TextEncoder().encode(text)
  )
  return '1!' + ivToHex(iv) + btoa(byteArrayToString(new Uint8Array(cipher)))
}

export async function decryptV1Text(cipher: string, key: CryptoKey): Promise<string> {
  // THE SAME preflight classification uses: one grammar, one place
  const frame = preflightTextCipher(cipher)
  if (frame.kind != 'v1') throw new CipherError(frame.kind == 'v0' ? 'unsupported-version' : frame.kind, 'v1 text')
  try {
    const text = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivFromHex(frame.ivHex), additionalData: V1_TEXT_AAD },
      key,
      frame.bytes
    )
    return new TextDecoder().decode(text)
  } catch (e) {
    // cause unknowable by construction: wrong key, modified cipher/tag, or wrong AAD — but ONLY
    // the operation's own failure translates; anything else is an integration error
    if (isOperationError(e)) throw new CipherError('authentication-failed', 'v1 text')
    throw e
  }
}

export async function encryptV1Bytes(bytes: Uint8Array<ArrayBuffer>, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: V1_BYTES_AAD }, key, bytes)
  return concatByteArrays(byteStringToArray('~1!' + ivToHex(iv)), new Uint8Array(cipher))
}

export async function decryptV1Bytes(
  cipher: Uint8Array<ArrayBuffer>,
  key: CryptoKey
): Promise<Uint8Array<ArrayBuffer>> {
  const frame = preflightBytesCipher(cipher)
  if (frame.kind != 'v1') throw new CipherError(frame.kind == 'v0' ? 'unsupported-version' : frame.kind, 'v1 bytes')
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivFromHex(frame.ivHex), additionalData: V1_BYTES_AAD },
      key,
      frame.payload
    )
    return new Uint8Array(plain)
  } catch (e) {
    if (isOperationError(e)) throw new CipherError('authentication-failed', 'v1 bytes')
    throw e
  }
}

// what regime a stored value selects: the PREFLIGHT's answer, projected. classification is the
// same structural validation decryption performs — a frame that classifies v1 always reaches the
// key, and one that cannot reach the key never classifies v1
export function classifyTextCipher(cipher: string): 'v0' | 'v1' | 'unsupported-version' | 'malformed-frame' {
  return preflightTextCipher(cipher).kind
}

export function classifyBytesCipher(
  cipher: Uint8Array<ArrayBuffer>
): 'v0' | 'v1' | 'unsupported-version' | 'malformed-frame' {
  return preflightBytesCipher(cipher).kind
}
