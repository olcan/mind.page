import { expect, test } from '@playwright/test'
import {
  hashSecretPhrase,
  encryptWithSecret,
  encryptBytesWithSecret,
  decryptWithSecret,
  decryptBytesWithSecret,
} from '../../src/crypto.js'
import { byteStringToArray } from '../../src/bytes.js'

// node-side unit tests for the aes-gcm module (webcrypto is global in node 20+); the end-to-end
// flows (secret phrase setup, encrypted items, shared-page validation) live in tests/e2e

const SECRET = 't8gMgujSmH8w0cPEdTh9ta598MwqJYk3GhYLMk6eGME=' // hashSecretPhrase('uid-123', 'correct horse')

test('hashSecretPhrase is the stable stored form (base64 of sha-256(uid + phrase))', async () => {
  expect(await hashSecretPhrase('uid-123', 'correct horse')).toBe(SECRET)
  expect(await hashSecretPhrase('uid-123', 'other phrase')).not.toBe(SECRET)
  expect(await hashSecretPhrase('other-uid', 'correct horse')).not.toBe(SECRET)
})

test('text round-trips through encrypt/decrypt, with a fresh iv per encryption', async () => {
  const text = 'item text with unicode ✓ and\nnewlines'
  const cipher = await encryptWithSecret(text, SECRET)
  expect(cipher).toMatch(/^[0-9a-f]{24}/) // hex iv prefix
  expect(await decryptWithSecret(cipher, SECRET)).toBe(text)
  const cipher2 = await encryptWithSecret(text, SECRET)
  expect(cipher2).not.toBe(cipher) // random iv
  expect(await decryptWithSecret(cipher2, SECRET)).toBe(text)
})

test('a wrong secret throws (aes-gcm authentication), which validates entered phrases', async () => {
  const cipher = await encryptWithSecret('secret text', SECRET)
  await expect(decryptWithSecret(cipher, await hashSecretPhrase('uid-123', 'wrong'))).rejects.toThrow()
})

test('bytes round-trip in uint8 mode, marked with the ~ prefix', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 7])
  const cipher = await encryptBytesWithSecret(bytes, SECRET)
  expect(cipher[0]).toBe('~'.charCodeAt(0))
  expect(Array.from(await decryptBytesWithSecret(cipher, SECRET))).toEqual(Array.from(bytes))
})

// frozen compatibility vectors: persisted user data must stay readable, so these exact ciphers —
// captured 2026-08-24, when the byte-identical format from before the crypto extraction was also
// verified end-to-end by the personal spec — must decrypt forever; a failure here means a format
// break (kdf, iv layout, base64 framing), not a bug to fix by regenerating the vectors
test('frozen ciphers from 2026-08-24 decrypt (persisted-data compatibility)', async () => {
  const FROZEN_TEXT =
    '1a6a8aced06c5d2df4e692f8e7wWhRUEF5e0127YeqVm5zPSYjEJPgtjk9zjq8OXsQ0tWtX/3X/xvB2BXGA273WcBrDy9FpZRNtm'
  expect(await decryptWithSecret(FROZEN_TEXT, SECRET)).toBe('frozen vector: item text with unicode ✓')
  const FROZEN_BYTES = 'fjNiNjhmOTk0YTI5NTMyMjRhZWM3NGRlYROLOeEVtgH6Wj9CS2fi44yciA9cbSfY' // base64 of the uint8-mode cipher
  const bytes_cipher = byteStringToArray(atob(FROZEN_BYTES))
  expect(Array.from(await decryptBytesWithSecret(bytes_cipher, SECRET))).toEqual([0, 1, 2, 250, 255, 128, 7])
  const FROZEN_LEGACY = '0d2063d038fd4768dbccdef38m+zVrINzC1MMoPVS4KMcOiB1UYbrw==' // text-mode cipher of byte content
  expect(Array.from(await decryptBytesWithSecret(byteStringToArray(FROZEN_LEGACY), SECRET))).toEqual([1, 2, 250, 255])
})

test('decrypt refuses uint8-mode ciphers, decrypt_bytes accepts legacy text-mode ciphers', async () => {
  // the string form of a uint8-mode cipher starts with '~' and must go through decrypt_bytes
  await expect(decryptWithSecret('~' + 'x'.repeat(40), SECRET)).rejects.toThrow(/decrypt_bytes/)
  // backwards compatibility: byte content encrypted in text mode (code points <= 255) decrypts
  // through the bytes api too
  const legacy = await encryptWithSecret('\x01\x02\xfa\xff', SECRET)
  expect(Array.from(await decryptBytesWithSecret(byteStringToArray(legacy), SECRET))).toEqual([1, 2, 250, 255])
})
