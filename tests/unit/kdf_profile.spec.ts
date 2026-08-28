import { expect, test } from '@playwright/test'
import {
  decodeKdfMetadata,
  decodeKeyEnvelope,
  encodeKeyEnvelope,
  encodeSalt,
  provisionKdfProfile,
} from '../../src/kdf_profile.js'

// the account KDF profile: metadata decoding, the provisioning transaction, and the persisted key
// envelope (see src/kdf_profile.ts and the design's Stage 2 acceptance list).

const SALT = new Uint8Array(16).fill(7)
const SALT_B64 = encodeSalt(SALT)
const KEY = new Uint8Array(32).map((_, i) => i)

test('metadata: ABSENT is provisionable; VALID adopts; present-but-invalid THROWS', () => {
  expect(decodeKdfMetadata(undefined)).toEqual({ kind: 'absent' })
  expect(decodeKdfMetadata(null)).toEqual({ kind: 'absent' })
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
    { v: 1, salt: SALT_B64.slice(0, -2) + 'B==' }, // noncanonical pad bits
  ])
    expect(() => decodeKdfMetadata(bad), JSON.stringify(bad)).toThrow()
})

test('the envelope round-trips through its canonical encodings', () => {
  const decoded = decodeKeyEnvelope(encodeKeyEnvelope({ uid: 'u', salt: SALT_B64, keyBytes: KEY }), 'u')
  expect(decoded?.salt).toBe(SALT_B64)
  expect(Array.from(decoded!.keyBytes)).toEqual(Array.from(KEY))
})

test('the provisioning transaction: absent writes ONE candidate; valid adopts the committed value', async () => {
  // the candidate is generated OUTSIDE the transaction body: firestore re-runs the body on
  // contention, and a fresh salt per retry makes "which salt committed" unanswerable
  let saltCalls = 0
  let writes = 0
  let attempts = 0
  const stored: Record<string, unknown> = {}
  const profile = await provisionKdfProfile({
    randomSalt: () => (saltCalls++, SALT),
    runTransaction: async body => {
      // TWO attempts: the first is "aborted by contention" after running, the second commits —
      // exactly firestore's retry shape
      await body({ get: async () => ({ ...stored }), set: () => void writes++ })
      attempts++
      return body({
        get: async () => ({ ...stored }),
        set: kdf => {
          writes++
          stored.kdf = kdf
        },
      })
    },
  })
  expect(saltCalls, 'one candidate across every retry').toBe(1)
  expect(profile.salt).toBe(SALT_B64)
  expect(stored.kdf).toEqual({ v: 1, salt: SALT_B64 })

  // a LOSER adopts: the doc now holds a committed profile from another device
  const otherSalt = encodeSalt(new Uint8Array(16).fill(9))
  const adopted = await provisionKdfProfile({
    randomSalt: () => SALT,
    runTransaction: async body =>
      body({
        get: async () => ({ kdf: { v: 1, salt: otherSalt } }),
        set: () => {
          throw new Error('must not write over a committed profile')
        },
      }),
  })
  expect(adopted.salt, 'derives from the COMMITTED value, never the local candidate').toBe(otherSalt)
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
  const good = encodeKeyEnvelope({ uid: 'uid-1', salt: SALT_B64, keyBytes: KEY })
  expect(decodeKeyEnvelope(good, 'uid-1')).not.toBeNull()
  expect(decodeKeyEnvelope(good, 'uid-2'), "another principal's envelope is not usable").toBeNull()
  for (const bad of [
    null,
    '',
    'not json',
    '42',
    '[]',
    JSON.stringify({ uid: 'uid-1', v: 1, salt: SALT_B64 }), // missing key
    JSON.stringify({ uid: 'uid-1', v: 1, salt: SALT_B64, key: 'AAA', extra: 1 }),
    JSON.stringify({ uid: 'uid-1', v: 2, salt: SALT_B64, key: 'AAA' }),
    JSON.stringify({ uid: 'uid-1', v: 1, salt: 'bad', key: 'AAA' }),
    JSON.stringify({ uid: 'uid-1', v: 1, salt: SALT_B64, key: btoa('short') }),
  ])
    expect(decodeKeyEnvelope(bad, 'uid-1'), String(bad).slice(0, 40)).toBeNull()
  // noncanonical KEY encoding: same bytes, different string — refused by the re-encode check
  const parsed = JSON.parse(good)
  parsed.key = parsed.key.slice(0, -2) + '=='
  if (parsed.key != JSON.parse(good).key) expect(decodeKeyEnvelope(JSON.stringify(parsed), 'uid-1')).toBeNull()
})
