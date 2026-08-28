import { expect, test } from '@playwright/test'
import {
  decodeKdfMetadata,
  decodeSalt,
  decodeKeyEnvelope,
  encodeKeyEnvelope,
  encodeSalt,
  provisionKdfProfile,
  restoreKeyEnvelope,
} from '../../src/kdf_profile.js'

// the account KDF profile: metadata decoding, the provisioning transaction, and the persisted key
// envelope (see src/kdf_profile.ts and the design's Stage 2 acceptance list).

const SALT = new Uint8Array(16).fill(7)
const SALT_B64 = encodeSalt(SALT)
const KEY = new Uint8Array(32).map((_, i) => i)

test('metadata: only a MISSING field is absent; VALID adopts; present-but-invalid THROWS', () => {
  expect(decodeKdfMetadata(undefined)).toEqual({ kind: 'absent' })
  // an explicit null is PRESENT: the rules reject it and forbid replacing it, so calling it
  // provisionable would send a write the server denies (review 84)
  expect(() => decodeKdfMetadata(null)).toThrow('kdf metadata is not a map') // not a destructuring TypeError
  expect(decodeKdfMetadata({ v: 1, salt: SALT_B64 })).toEqual({ kind: 'valid', profile: { v: 1, salt: SALT_B64 } })
  // present-but-invalid is NOT a third routable value: overwriting a salt this client merely
  // cannot read would strand every ciphertext derived from it
  for (const bad of [
    42,
    'string',
    [],
    { v: 2, salt: SALT_B64 },
    { v: '1', salt: SALT_B64 },
    { v: 1 },
    { salt: SALT_B64 },
    { v: 1, salt: SALT_B64, extra: true },
    { v: 1, salt: 'not-base64!' },
    { v: 1, salt: SALT_B64.slice(0, -3) + 'x==' }, // SAME bytes, noncanonical pad bits (24 chars)
  ])
    expect(() => decodeKdfMetadata(bad), JSON.stringify(bad)).toThrow()
})

test('the envelope round-trips through its canonical encodings, v0 binding included', () => {
  const decoded = decodeKeyEnvelope(
    encodeKeyEnvelope({ uid: 'u', salt: SALT_B64, keyBytes: KEY, v0Secret: 'v0:phrase' }),
    'u'
  )
  expect(decoded?.salt).toBe(SALT_B64)
  expect(decoded?.v0Secret, 'the establishment that produced the key is carried with it').toBe('v0:phrase')
  expect(Array.from(decoded!.keyBytes)).toEqual(Array.from(KEY))
})

test('provisioning: ONE candidate across retries, and a contention loser adopts without writing', async () => {
  // combined retry + loser shape (review 84): attempt 1 reads ABSENCE and stages the candidate;
  // contention installs ANOTHER device's salt before the retry; the retry reads that salt,
  // performs NO write, and the caller receives the committed value — its local candidate is
  // demonstrably abandoned
  const otherSalt = encodeSalt(new Uint8Array(16).fill(9))
  let saltCalls = 0
  let retryWrites = 0
  let attempt = 0
  const profile = await provisionKdfProfile({
    randomSalt: () => (saltCalls++, SALT),
    runTransaction: async body => {
      attempt++
      await body({ get: async () => ({}), set: () => {} }) // attempt 1: absent; then contention
      attempt++
      return body({
        get: async () => ({ kdf: { v: 1, salt: otherSalt } }),
        set: () => void retryWrites++,
      })
    },
  })
  expect(saltCalls, 'one random salt across every retry').toBe(1)
  expect(retryWrites, 'the retry writes nothing over a committed profile').toBe(0)
  expect(profile.salt, 'the caller receives the COMMITTED salt, not its candidate').toBe(otherSalt)
  expect(attempt).toBe(2)
})

test('provisioning: an uncontended absent account commits the single candidate', async () => {
  const stored: Record<string, unknown> = {}
  const profile = await provisionKdfProfile({
    randomSalt: () => SALT,
    runTransaction: async body => body({ get: async () => ({ ...stored }), set: kdf => void (stored.kdf = kdf) }),
  })
  expect(profile.salt).toBe(SALT_B64)
  expect(stored.kdf).toEqual({ v: 1, salt: SALT_B64 })
})

test('provisioning FAILS on present-but-invalid metadata instead of overwriting it', async () => {
  await expect(
    provisionKdfProfile({
      randomSalt: () => SALT,
      runTransaction: async body =>
        body({
          get: async () => ({ kdf: { v: 99, salt: 'future' } }),
          set: () => {
            throw new Error('unreachable')
          },
        }),
    })
  ).rejects.toThrow('unsupported kdf version')
})

test('the envelope decodes only its EXACT shape, bound to the expected uid', () => {
  const good = encodeKeyEnvelope({ uid: 'uid-1', salt: SALT_B64, keyBytes: KEY, v0Secret: 'v0:phrase' })
  expect(decodeKeyEnvelope(good, 'uid-1')).not.toBeNull()
  expect(decodeKeyEnvelope(good, 'uid-2'), "another principal's envelope is not usable").toBeNull()
  // ONE FIELD CHANGED PER ROW, from the parsed GOOD envelope — a table whose rows also carried a
  // short key stayed green on the length guard whichever check was deleted (review 84)
  const mutate = (change: (parsed: any) => void) => {
    const parsed = JSON.parse(good)
    change(parsed)
    return JSON.stringify(parsed)
  }
  expect(decodeKeyEnvelope(null, 'uid-1')).toBeNull()
  expect(decodeKeyEnvelope('', 'uid-1')).toBeNull()
  expect(decodeKeyEnvelope('not json', 'uid-1')).toBeNull()
  expect(decodeKeyEnvelope('42', 'uid-1')).toBeNull()
  expect(decodeKeyEnvelope('[]', 'uid-1')).toBeNull()
  expect(
    decodeKeyEnvelope(
      mutate(p => delete p.key),
      'uid-1'
    ),
    'missing key'
  ).toBeNull()
  expect(
    decodeKeyEnvelope(
      mutate(p => delete p.v0),
      'uid-1'
    ),
    'UNBOUND (pre-rollout) envelope: re-acquire rather than trust it (review 88 §2.1)'
  ).toBeNull()
  expect(
    decodeKeyEnvelope(
      mutate(p => (p.v0 = '')),
      'uid-1'
    ),
    'empty v0 binding'
  ).toBeNull()
  expect(
    decodeKeyEnvelope(
      mutate(p => (p.v0 = 42)),
      'uid-1'
    ),
    'non-string v0 binding'
  ).toBeNull()
  expect(
    decodeKeyEnvelope(
      mutate(p => (p.extra = 1)),
      'uid-1'
    ),
    'extra field'
  ).toBeNull()
  expect(
    decodeKeyEnvelope(
      mutate(p => (p.v = 2)),
      'uid-1'
    ),
    'wrong version'
  ).toBeNull()
  expect(
    decodeKeyEnvelope(
      mutate(p => (p.salt = 'bad')),
      'uid-1'
    ),
    'bad salt'
  ).toBeNull()
  expect(
    decodeKeyEnvelope(
      mutate(p => (p.key = btoa('short'))),
      'uid-1'
    ),
    'short key'
  ).toBeNull()
  expect(
    decodeKeyEnvelope(
      mutate(p => (p.key = 'not base64!')),
      'uid-1'
    ),
    'undecodable key'
  ).toBeNull()
  // NONCANONICAL KEY ENCODING, same 32 bytes: for key bytes 0..31 the canonical string ends 'Hh8='
  // and 'Hh9=' decodes identically — only the re-encode check can refuse it
  const nonCanonical = mutate(p => (p.key = p.key.slice(0, -2) + '9='))
  expect(JSON.parse(nonCanonical).key).not.toBe(JSON.parse(good).key)
  expect(decodeKeyEnvelope(nonCanonical, 'uid-1'), 'same bytes, noncanonical encoding').toBeNull()
})

test('decodeSalt/encodeSalt: an independent literal vector, both directions', () => {
  // review 84: SALT_B64 was produced by encodeSalt, so the encoder had no independent pin
  const bytes = new Uint8Array(16).map((_, i) => i)
  expect(encodeSalt(bytes)).toBe('AAECAwQFBgcICQoLDA0ODw==')
  expect(Array.from(decodeSalt('AAECAwQFBgcICQoLDA0ODw=='))).toEqual(Array.from(bytes))
  expect(() => decodeSalt('AAECAwQFBgcICQoLDA0ODx==')).toThrow() // same bytes, noncanonical
})

test('encodeKeyEnvelope refuses an invalid salt or missing v0: the codec invariant is self-contained', () => {
  expect(() => encodeKeyEnvelope({ uid: 'u', salt: 'not-canonical', keyBytes: KEY, v0Secret: 'v0:x' })).toThrow()
  expect(() => encodeKeyEnvelope({ uid: 'u', salt: SALT_B64, keyBytes: KEY, v0Secret: '' })).toThrow(
    'established v0 secret'
  )
})

test('a valid envelope whose salt differs from the server profile is DISCARDED, never restored', () => {
  const stored = encodeKeyEnvelope({ uid: 'uid-1', salt: SALT_B64, keyBytes: KEY, v0Secret: 'v0:phrase' })
  expect(restoreKeyEnvelope(stored, 'uid-1', { v: 1, salt: SALT_B64 })).not.toBeNull()
  const otherSalt = encodeSalt(new Uint8Array(16).fill(9))
  expect(
    restoreKeyEnvelope(stored, 'uid-1', { v: 1, salt: otherSalt }),
    'another provisioning epoch‘s key: not importable'
  ).toBeNull()
  expect(restoreKeyEnvelope(stored, 'uid-2', { v: 1, salt: SALT_B64 }), 'wrong uid').toBeNull()
})
