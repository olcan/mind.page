// aes-gcm encryption for item data (extracted from index.svelte; see encrypt/decrypt there for
// the session-secret wrappers). Ciphers are '<24-hex-char iv>' + base64(cipher bytes) in text
// mode, or '~' + iv hex + raw cipher bytes in uint8 ("bytes") mode; the key is the sha-256 of
// the utf8-encoded secret, and the stored form of a secret phrase is base64(sha-256(uid+phrase))

// @ts-ignore util.js is untyped (the strict tsc pass over tests reaches this module)
import { byteArrayToString, byteStringToArray, concatByteArrays } from './util.js'

// aes-gcm key for the secret, usable for the given operations
async function secretKey(secret: string, usages: KeyUsage[], iv: Uint8Array): Promise<CryptoKey> {
  const secret_sha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', secret_sha256, { name: 'AES-GCM', iv } as AesGcmParams, false, usages)
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
  const key = await secretKey(secret, ['encrypt'], iv)
  const cipher_buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text))
  return ivToHex(iv) + btoa(byteArrayToString(new Uint8Array(cipher_buffer)))
}

// encrypt arbitrary bytes (uint8); ideal for firebase storage of large binary data such as images
export async function encryptBytesWithSecret(bytes: Uint8Array<ArrayBuffer>, secret: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12)) // 96-bit random iv
  const key = await secretKey(secret, ['encrypt'], iv)
  const cipher_buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)
  return concatByteArrays(byteStringToArray('~' + ivToHex(iv)), new Uint8Array(cipher_buffer))
}

// throws on a wrong secret (aes-gcm authentication), which getSecretPhrase in index.svelte uses
// to validate an entered phrase before committing it
export async function decryptWithSecret(cipher: string, secret: string): Promise<string> {
  if (cipher[0] == '~') throw new Error('data encrypted using encrypt_bytes must be decrypted using decrypt_bytes')
  const iv = ivFromHex(cipher.slice(0, 24))
  const key = await secretKey(secret, ['decrypt'], iv)
  const cipher_array = byteStringToArray(atob(cipher.slice(24))) // base64-decode cipher string (encrypted in text mode)
  const text_buffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher_array)
  return new TextDecoder().decode(text_buffer)
}

export async function decryptBytesWithSecret(cipher: Uint8Array, secret: string): Promise<Uint8Array<ArrayBuffer>> {
  // detect uint8 ("bytes") mode based on ~ prefix
  const encrypted_bytes = cipher[0] == '~'.charCodeAt(0)
  const offset = encrypted_bytes ? 1 : 0 // uint8 encoding has offset 1 for '~' prefix
  const iv = ivFromHex(byteArrayToString(cipher.subarray(offset, 24 + offset)))
  const key = await secretKey(secret, ['decrypt'], iv)
  const cipher_array = encrypted_bytes
    ? cipher.subarray(24 + offset)
    : byteStringToArray(atob(byteArrayToString(cipher.subarray(24 + offset))))
  const text_buffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher_array)
  if (encrypted_bytes) return new Uint8Array(text_buffer) // return raw uint8 array
  // backwards compatibility mode: convert utf8-decoded text to uint8 array (code points <= 255 only)
  return byteStringToArray(new TextDecoder().decode(text_buffer))
}
