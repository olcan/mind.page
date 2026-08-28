import { expect, test } from '@playwright/test'
import { deriveKeyBytes, phraseBytes, type Deriver } from '../../src/kdf.js'
import {
  CipherError,
  classifyTextCipher,
  decryptV1Bytes,
  decryptV1Text,
  decryptWithSecret,
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
// fixed 32-byte key and pays no KDF at all. The production-cost fleet benchmark is DONE and
// documented in the design; its temporary hook is gone (review 84).

// the CHEAP test parameters. injected here only — the production resolver maps versions through
// the code-owned KDF_VERSIONS table and can never accept these
const CHEAP = { memorySize: 8 * 1024, iterations: 1, parallelism: 1, hashLength: 32 }
const SALT = new Uint8Array(16).fill(7)
const FIXED_KEY = new Uint8Array(32).map((_, i) => i) // framing rows: no derivation involved

// the SHARED cross-check vector: identical input in this Node row and the browser worker smoke
// (tests/e2e/kdf.spec.ts asserts the same full 32-byte hex), so "matches the Node vector" is a
// literal statement rather than a four-byte overlap of different inputs (review 81)
export const KAT = {
  password: 'test phrase',
  hex: 'e18399378b0a69373a4802509400ba9b281fa706bc645d79a7ed0fe338aedca2',
}

test('KNOWN ANSWER: hash-wasm argon2id 0x13 under the cheap test parameters', async () => {
  // ONE real derivation — the literal expectation already pins determinism and output.
  // PROVENANCE (2026-08-27): this exact vector is INDEPENDENTLY reproduced by argon2-cffi 25.x
  // (CFFI bindings to the reference C implementation), hash_secret_raw(b'test phrase',
  // bytes([7]*16), time_cost=1, memory_cost=8192, parallelism=1, hash_len=32, type=ID,
  // version=19) — so it pins hash-wasm@4.12.0 AGAINST the reference, not against itself
  const { argon2id } = await import('hash-wasm')
  const key = await argon2id({
    password: phraseBytes(KAT.password),
    salt: SALT,
    memorySize: CHEAP.memorySize,
    iterations: CHEAP.iterations,
    parallelism: CHEAP.parallelism,
    hashLength: CHEAP.hashLength,
    outputType: 'binary',
  })
  expect(Buffer.from(key).toString('hex')).toBe(KAT.hex)
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

test('the version is validated as EXACTLY the number 1: hostile metadata never reaches a deriver', async () => {
  let derivations = 0
  const spy: Deriver = async () => (derivations++, FIXED_KEY)
  // TypeScript's annotation disappears at runtime; these are the values a stored document can
  // actually carry, including prototype-chain keys an object lookup would have resolved
  for (const version of ['1', '__proto__', 'toString', 1.5, 2, 0, null, undefined] as unknown[])
    await expect(deriveKeyBytes('p', SALT, version, spy), String(version)).rejects.toThrow('unsupported kdf version')
  await expect(deriveKeyBytes('p', new Uint8Array(8), 1, spy)).rejects.toThrow('salt must be 16 bytes')
  expect(derivations, 'stored metadata is untrusted: nothing derived').toBe(0)
})

test('a deriver returning anything but exactly 32 bytes fails AT the derivation boundary', async () => {
  // a faulty deriver must fail here, not at a later import: acquisition retains the result
  await expect(deriveKeyBytes('p', SALT, 1, async () => new Uint8Array(1))).rejects.toThrow('expected 32')
  await expect(deriveKeyBytes('p', SALT, 1, async () => new Uint8Array(44))).rejects.toThrow('expected 32')
  expect(await deriveKeyBytes('p', SALT, 1, async () => FIXED_KEY)).toEqual(FIXED_KEY)
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

test('importV1Key refuses non-32-byte material as an INVARIANT error, not a cipher outcome', async () => {
  // the v0 string functions hash their input again; this is the guard that a base64 string can
  // never silently become the key by length coincidence. it is a plain Error — broken key
  // plumbing must not be confusable with corpus corruption (review 81)
  const failure = await importV1Key(new Uint8Array(44)).catch(e => e)
  expect(String(failure)).toContain('invalid v1 key material')
  expect(failure instanceof CipherError, 'NOT a CipherError').toBe(false)
})

test('LITERAL v1 fixtures decrypt: the persisted formats are frozen, not just round-tripped', async () => {
  // a coordinated change to frame + AAD + writer keeps round-trip rows green while making
  // already-persisted v1 data unreadable (review 81). these literals pin the wire format
  const key = await importV1Key(FIXED_KEY)
  expect(await decryptV1Text('1!a0a1a2a3a4a5a6a7a8a9aaabgGoTVyClIslTRfO2fw7gcj85RoAlsImU/LyzzG0J', key)).toBe(
    'frozen v1 text'
  )
  const bytesFixture = new Uint8Array([
    ...'~1!a0a1a2a3a4a5a6a7a8a9aaab'.split('').map(c => c.charCodeAt(0)),
    ...Array.from(Buffer.from('7xB7K0DOsSE2Pj7UvZhowG41y/uJ', 'base64')),
  ])
  expect(Array.from(await decryptV1Bytes(bytesFixture, key))).toEqual([9, 8, 7, 6, 5])
})

test('an impossible frame length is MALFORMED, never an authentication failure', async () => {
  // a payload shorter than the 16-byte GCM tag cannot be a ciphertext at all; letting it reach
  // Web Crypto turned it into authentication-failed, which acquisition reads as evidence about
  // the phrase (review 81)
  const key = await importV1Key(FIXED_KEY)
  const short = '1!' + 'a0a1a2a3a4a5a6a7a8a9aaab' + Buffer.from(new Uint8Array(8)).toString('base64')
  const failure = await decryptV1Text(short, key).catch(e => e as CipherError)
  expect((failure as CipherError).kind).toBe('malformed-frame')
  const shortBytes = new Uint8Array([...'~1!a0a1a2a3a4a5a6a7a8a9aaab'.split('').map(c => c.charCodeAt(0)), 1, 2, 3])
  expect(((await decryptV1Bytes(shortBytes, key).catch(e => e)) as CipherError).kind).toBe('malformed-frame')
})

test('only OperationError translates to authentication-failed; an integration error propagates', async () => {
  // an InvalidAccessError (a key imported without the decrypt usage) is broken plumbing, not
  // evidence about the data — relabeling it authentication-failed would feed the prompt policy a lie
  const encryptOnly = await importV1Key(FIXED_KEY, ['encrypt'])
  const cipher = await encryptV1Text('t', encryptOnly)
  const failure = await decryptV1Text(cipher, encryptOnly).catch(e => e)
  expect(failure instanceof CipherError, 'NOT translated').toBe(false)
  expect((failure as DOMException).name).toBe('InvalidAccessError')
})

test('classification and parsing share ONE strict grammar, and the bytes dispatcher exists', async () => {
  const { classifyBytesCipher } = await import('../../src/crypto.js')
  // text: canonical '1!' only, AND structurally complete — the preflight is the same validation
  // decryption performs, so a frame too short to reach the key never classifies v1 (review 82)
  const real = await encryptV1Text('x', await importV1Key(FIXED_KEY))
  expect(classifyTextCipher(real)).toBe('v1')
  expect(classifyTextCipher('1!' + 'a'.repeat(24) + 'AAAA'), 'a sub-tag-length v1 frame is MALFORMED').toBe(
    'malformed-frame'
  )
  expect(classifyTextCipher('01!whatever')).toBe('unsupported-version')
  expect(classifyTextCipher('2!whatever')).toBe('unsupported-version')
  expect(classifyTextCipher('not a cipher')).toBe('malformed-frame')
  // bytes: legacy '~', legacy TEXT-form-stored-as-bytes, '~1!', future '~N!', malformed
  const b = (s: string, extra: number[] = []) => new Uint8Array([...s.split('').map(c => c.charCodeAt(0)), ...extra])
  expect(classifyBytesCipher(b('~' + 'ab'.repeat(12), Array.from(new Uint8Array(16))))).toBe('v0')
  expect(
    classifyBytesCipher(b('ab'.repeat(12) + Buffer.from(new Uint8Array(16)).toString('base64'))),
    'legacy text-form bytes with a full GCM payload'
  ).toBe('v0')
  expect(
    classifyBytesCipher(b('ab'.repeat(12) + 'QUFB')),
    'legacy text-form bytes DECODING to three bytes cannot hold a GCM tag'
  ).toBe('malformed-frame')
  expect(
    classifyBytesCipher(b('~1!' + 'ab'.repeat(12), Array.from(new Uint8Array(16)))),
    'v1 bytes with a full GCM payload'
  ).toBe('v1')
  expect(classifyBytesCipher(b('~1!' + 'ab'.repeat(12))), 'v1 bytes too short for the tag').toBe('malformed-frame')
  expect(classifyBytesCipher(b('~' + 'ab'.repeat(12))), 'v0 bytes too short for the tag').toBe('malformed-frame')
  expect(classifyBytesCipher(b('~2!' + 'ab'.repeat(12)))).toBe('unsupported-version')
  expect(classifyBytesCipher(b('~zz-not-hex'))).toBe('malformed-frame')
  expect(classifyBytesCipher(b('garbage!'))).toBe('malformed-frame')
})
