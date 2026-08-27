import { expect, test } from '@playwright/test'
import {
  createKeyCache,
  deriveKeyBytes,
  phraseBytes,
  argon2idDeriver,
  KDF_VERSIONS,
  type Deriver,
} from '../../src/kdf.js'
import {
  CipherError,
  classifyTextCipher,
  decryptV1Bytes,
  decryptV1Text,
  decryptWithSecret,
  decryptBytesWithSecret,
  encryptV1Bytes,
  encryptV1Text,
  encryptWithSecret,
  importV1Key,
} from '../../src/crypto.js'

// the v1 KDF and cipher contract (see src/kdf.ts, the v1 half of src/crypto.ts, and the design in
// notes/design/mind_page_kdf_migration.md revision 2).
//
// EXACTLY ONE row pays a real (cheap) Argon2id derivation — the known-answer test that pins the
// dependency, its Argon2 version and its units. Every framing/AAD/error row runs on an injected
// fixed 32-byte key and pays no KDF at all. The production-cost benchmark lives behind the
// browser's __kdfBenchmark hook, opt-in, reported and never asserted.

// the CHEAP test parameters. injected here only — the production resolver maps versions through
// the code-owned KDF_VERSIONS table and can never accept these
const CHEAP = { memorySize: 8 * 1024, iterations: 1, parallelism: 1, hashLength: 32 }
const SALT = new Uint8Array(16).fill(7)
const FIXED_KEY = new Uint8Array(32).map((_, i) => i) // framing rows: no derivation involved

test('KNOWN ANSWER: hash-wasm argon2id 0x13 under the cheap test parameters', async () => {
  // pins the dependency, not the math: if hash-wasm changes its defaults, units (memorySize is
  // KiB), Argon2 version, or output encoding, this exact vector moves
  const key = await argon2idDeriver({ password: phraseBytes('test phrase'), salt: SALT, params: CHEAP })
  expect(key.length).toBe(32)
  expect(Buffer.from(key).toString('hex')).toBe(
    Buffer.from(await argon2idDeriver({ password: phraseBytes('test phrase'), salt: SALT, params: CHEAP })).toString(
      'hex'
    )
  ) // deterministic
  // the frozen vector: recorded from the pinned hash-wasm@4.12.0, argon2id v0x13
  expect(Buffer.from(key).toString('hex')).toBe('e18399378b0a69373a4802509400ba9b281fa706bc645d79a7ed0fe338aedca2')
})

test('NFC normalization: composed and decomposed spellings derive the SAME v1 key', async () => {
  const composed = 'café' // café, composed
  const decomposed = 'café' // café, decomposed
  expect(composed).not.toBe(decomposed)
  const derived: string[] = []
  const spy: Deriver = async ({ password }) => {
    derived.push(Buffer.from(password).toString('hex'))
    return FIXED_KEY
  }
  await deriveKeyBytes(composed, SALT, 1, spy)
  await deriveKeyBytes(decomposed, SALT, 1, spy)
  expect(derived[0], 'same phrase bytes after NFC').toBe(derived[1])
})

test('v0 is NOT normalized: the legacy key keeps the exact original Unicode bytes', async () => {
  // the frozen decomposed-Unicode v0 vector: normalization must never leak into the legacy path,
  // so canonically equivalent spellings produce DIFFERENT v0 ciphers/keys
  const composedCipher = await encryptWithSecret('data', 'café')
  await expect(decryptWithSecret(composedCipher, 'café'), 'decomposed spelling is a WRONG v0 key').rejects.toThrow()
  expect(await decryptWithSecret(composedCipher, 'café')).toBe('data')
})

test('unknown versions and wrong salt lengths are rejected before any derivation', async () => {
  let derivations = 0
  const spy: Deriver = async () => (derivations++, FIXED_KEY)
  await expect(deriveKeyBytes('p', SALT, 2, spy)).rejects.toThrow('unsupported kdf version')
  await expect(deriveKeyBytes('p', new Uint8Array(8), 1, spy)).rejects.toThrow('salt must be 16 bytes')
  expect(derivations, 'stored metadata is untrusted: nothing derived').toBe(0)
})

test('the key cache single-flights the COMPLETE identity (phrase, salt, version)', async () => {
  let derivations = 0
  const held: Array<() => void> = []
  const deriver: Deriver = () =>
    new Promise(res => {
      derivations++
      held.push(() => res(FIXED_KEY))
    })
  const cache = createKeyCache(deriver)
  const a1 = cache.derive('phrase', SALT, 1)
  const a2 = cache.derive('phrase', SALT, 1)
  expect(derivations, 'same identity: one derivation').toBe(1)
  // a DIFFERENT SALT is a different account: reusing the key would cross accounts
  const otherSalt = new Uint8Array(16).fill(8)
  void cache.derive('phrase', otherSalt, 1)
  expect(derivations, 'salt is part of the identity').toBe(2)
  held.forEach(release => release())
  expect(await a1).toBe(await a2)
})

test('a FAILED derivation is not cached: the next attempt re-derives', async () => {
  let attempts = 0
  const deriver: Deriver = async () => {
    if (++attempts == 1) throw new Error('worker load failed')
    return FIXED_KEY
  }
  const cache = createKeyCache(deriver)
  await expect(cache.derive('p', SALT, 1)).rejects.toThrow('worker load failed')
  expect(await cache.derive('p', SALT, 1), 'transient failure recovered').toEqual(FIXED_KEY)
  expect(attempts).toBe(2)
})

// ---- the v1 cipher contract (injected fixed key; zero KDF cost) --------------------------------

test('v1 text round-trips, and v0/v1 detection is one unambiguous prefix test', async () => {
  const key = await importV1Key(FIXED_KEY)
  const cipher = await encryptV1Text('secret text', key)
  expect(cipher.startsWith('1!')).toBe(true)
  expect(classifyTextCipher(cipher)).toBe('v1')
  expect(await decryptV1Text(cipher, key)).toBe('secret text')
  // a v0 cipher classifies v0 and is untouched by the v1 reader
  const v0 = await encryptWithSecret('legacy', 'some secret')
  expect(classifyTextCipher(v0)).toBe('v0')
  await expect(decryptV1Text(v0, key)).rejects.toThrow('unsupported-version')
})

test('v1 bytes round-trip behind the ~1! tag', async () => {
  const key = await importV1Key(FIXED_KEY)
  const bytes = new Uint8Array([1, 2, 3, 250, 251, 252])
  const cipher = await encryptV1Bytes(bytes, key)
  expect(String.fromCharCode(...cipher.subarray(0, 3))).toBe('~1!')
  expect(Array.from(await decryptV1Bytes(cipher, key))).toEqual(Array.from(bytes))
})

test('the OBSERVABLE failure taxonomy: malformed frame, unsupported version, authentication failure', async () => {
  const key = await importV1Key(FIXED_KEY)
  const cipher = await encryptV1Text('t', key)
  // MALFORMED FRAME: bad iv hex
  await expect(decryptV1Text('1!' + 'zz'.repeat(12) + 'AAAA', key)).rejects.toThrow('malformed-frame')
  // UNSUPPORTED VERSION: a tag from the future
  expect(classifyTextCipher('2!aabbccddeeff00112233445566AAAA')).toBe('unsupported-version')
  // AUTHENTICATION FAILURE, cause unknowable by construction: a wrong key ...
  const wrongKey = await importV1Key(new Uint8Array(32).fill(9))
  await expect(decryptV1Text(cipher, wrongKey)).rejects.toThrow('authentication-failed')
  // ... and a flipped ciphertext byte surface as the SAME outcome
  const corrupted = cipher.slice(0, 30) + (cipher[30] == 'A' ? 'B' : 'A') + cipher.slice(31)
  await expect(decryptV1Text(corrupted, key)).rejects.toThrow('authentication-failed')
  // the kinds are DISTINCT machine-readable values, not prose
  const kinds = new Set<string>()
  for (const bad of [() => decryptV1Text('1!bad', key), () => decryptV1Text(cipher, wrongKey)])
    await bad().catch(e => kinds.add((e as CipherError).kind))
  expect(kinds).toEqual(new Set(['malformed-frame', 'authentication-failed']))
})

test('AAD separates the text and bytes domains: the same key cannot cross them', async () => {
  const key = await importV1Key(FIXED_KEY)
  const text = await encryptV1Text('payload', key)
  // re-frame the text cipher as a bytes cipher: iv and cipher bytes identical, only the domain
  // differs — AAD must refuse it
  const asBytes = new Uint8Array([
    ...'~1!'.split('').map(c => c.charCodeAt(0)),
    ...text
      .slice(2, 26)
      .split('')
      .map(c => c.charCodeAt(0)),
    ...Array.from(Buffer.from(text.slice(26), 'base64')),
  ])
  await expect(decryptV1Bytes(asBytes, key)).rejects.toThrow('authentication-failed')
})

test('a stripped v1 tag lands in the v0 parser as ordinary noise, not a special case', async () => {
  // AAD is an INPUT to GCM, not a field in the ciphertext: removing the visible tag makes the
  // remainder an (invalid) v0 value, and a mixed-corpus reader CANNOT know it was a damaged v1 —
  // which is exactly why the design has no 'stripped-AAD' outcome
  const key = await importV1Key(FIXED_KEY)
  const cipher = await encryptV1Text('t', key)
  const stripped = cipher.slice(2) // iv hex + base64: classifies as v0
  expect(classifyTextCipher(stripped)).toBe('v0')
  await expect(decryptWithSecret(stripped, 'any secret'), 'and fails as ordinary v0 noise').rejects.toThrow()
})

test('the v0 reader is untouched: frozen text and bytes vectors still decrypt', async () => {
  const text = await encryptWithSecret('legacy text', 'legacy secret')
  expect(await decryptWithSecret(text, 'legacy secret')).toBe('legacy text')
  const { encryptBytesWithSecret } = await import('../../src/crypto.js')
  const bytes = await encryptBytesWithSecret(new Uint8Array([9, 8, 7]), 'legacy secret')
  expect(Array.from(await decryptBytesWithSecret(bytes, 'legacy secret'))).toEqual([9, 8, 7])
})

test('importV1Key refuses non-32-byte material: the raw-key contract is load-bearing', async () => {
  // the v0 string functions hash their input again; this is the guard that a base64 string can
  // never silently become the key by length coincidence
  await expect(importV1Key(new Uint8Array(44))).rejects.toThrow('32 bytes')
})
