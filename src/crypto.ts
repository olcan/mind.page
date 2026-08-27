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
  if (!cipher.startsWith(V1_TEXT_TAG)) throw new CipherError('unsupported-version', `not a v1 text cipher`)
  const ivHex = cipher.slice(2, 26)
  if (!IV_HEX.test(ivHex)) throw new CipherError('malformed-frame', 'bad iv')
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = byteStringToArray(atob(cipher.slice(26)))
  } catch {
    throw new CipherError('malformed-frame', 'bad base64')
  }
  if (bytes.length < GCM_MIN_BYTES) throw new CipherError('malformed-frame', 'shorter than a gcm tag')
  try {
    const text = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivFromHex(ivHex), additionalData: V1_TEXT_AAD },
      key,
      bytes
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
  const prefix = byteArrayToString(cipher.subarray(0, 3))
  if (prefix != V1_BYTES_TAG) throw new CipherError('unsupported-version', 'not a v1 bytes cipher')
  const ivHex = byteArrayToString(cipher.subarray(3, 27))
  if (!IV_HEX.test(ivHex)) throw new CipherError('malformed-frame', 'bad iv')
  if (cipher.length - 27 < GCM_MIN_BYTES) throw new CipherError('malformed-frame', 'shorter than a gcm tag')
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivFromHex(ivHex), additionalData: V1_BYTES_AAD },
      key,
      cipher.subarray(27)
    )
    return new Uint8Array(plain)
  } catch (e) {
    if (isOperationError(e)) throw new CipherError('authentication-failed', 'v1 bytes')
    throw e
  }
}

// what regime a stored TEXT value selects: '1!'-tagged v1; an untagged 24-hex-iv v0; a tagged
// value from a FUTURE version ('<digits>!' that is not '1'); or a malformed frame. the reader
// dispatches on this ONE test, and the unsupported-version answer is what a too-old build shows
// as "reload this tab" — for builds that HAVE this code; a genuinely old build has no recognizer,
// which is why the rollout gate is the owner checklist, not this message
export function classifyTextCipher(cipher: string): 'v0' | 'v1' | 'unsupported-version' | 'malformed-frame' {
  // the SAME canonical tag decryptV1Text parses — never a looser match here and a stricter one
  // there. any other digits-then-'!' shape is a tag from a future version (or corruption; a
  // future reader that knows it says "reload", which is all this arm is for)
  if (cipher.startsWith(V1_TEXT_TAG)) return 'v1'
  if (/^\d+!/.test(cipher)) return 'unsupported-version'
  return IV_HEX.test(cipher.slice(0, 24)) ? 'v0' : 'malformed-frame'
}

// the bytes-side dispatcher, with the same outcomes: legacy '~' + iv (v0 bytes mode), a legacy
// TEXT-form value stored as bytes (no '~', hex iv — decryptBytesWithSecret's compatibility mode),
// '~1!' (v1), a future '~N!' tag, or a malformed header
export function classifyBytesCipher(cipher: Uint8Array): 'v0' | 'v1' | 'unsupported-version' | 'malformed-frame' {
  const head = byteArrayToString(cipher.subarray(0, 28))
  if (head.startsWith(V1_BYTES_TAG)) return 'v1'
  if (/^~\d+!/.test(head)) return 'unsupported-version'
  if (head[0] == '~') return IV_HEX.test(head.slice(1, 25)) ? 'v0' : 'malformed-frame'
  return IV_HEX.test(head.slice(0, 24)) ? 'v0' : 'malformed-frame'
}
