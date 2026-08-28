import { expect, test } from '@playwright/test'
import { encryptV1WithSession } from '../../src/kdf_writer.js'
import type { KdfSessionKeys } from '../../src/kdf_session.js'

// the v1 writer seam (src/kdf_writer.ts) — review 92 §2's identity-to-publication fence, staged
// deterministically with injected keys and a parkable encryption.

const KEYS_A = { uid: 'u', salt: 's', key: { k: 'A' } as unknown as CryptoKey, v0Secret: 'v0:a' } as KdfSessionKeys
const KEYS_B = { uid: 'u', salt: 's', key: { k: 'B' } as unknown as CryptoKey, v0Secret: 'v0:a' } as KdfSessionKeys

test('a not-ready acquisition fails the save observably with its reason — never a v0 downgrade', async () => {
  await expect(
    encryptV1WithSession({
      acquire: async () => ({ kind: 'not-ready', reason: 'offline without complete persisted keys' }),
      current: () => null,
      encrypt: async () => {
        throw new Error('unreachable')
      },
    })
  ).rejects.toThrow('cannot encrypt: v1 keys unavailable (offline without complete persisted keys)')
})

test('PARKED ENCRYPTION DRIFT (review 92 §2): ciphertext produced under A never survives a change to B or null', async () => {
  for (const replacement of [KEYS_B, null]) {
    let session: KdfSessionKeys | null = KEYS_A
    let releaseEncrypt: (c: string) => void = () => {}
    const parked = encryptV1WithSession({
      acquire: async () => ({ kind: 'ready', keys: KEYS_A }),
      current: () => session,
      encrypt: () => new Promise<string>(resolve => (releaseEncrypt = resolve)),
    })
    await new Promise(r => setTimeout(r, 0)) // parked inside the encryption
    session = replacement // another tab establishes B / a lifecycle clear lands
    releaseEncrypt('cipher-under-A')
    await expect(parked, replacement ? 'A replaced by B' : 'A cleared').rejects.toThrow(
      'v1 keys changed before publication: save aborted'
    )
  }
})

test('the returned FENCE re-checks the exact object at the enqueue seam', async () => {
  let session: KdfSessionKeys | null = KEYS_A
  const { value, fence } = await encryptV1WithSession({
    acquire: async () => ({ kind: 'ready', keys: KEYS_A }),
    current: () => session,
    encrypt: async keys => `cipher-under-${(keys.key as any).k}`,
  })
  expect(value).toBe('cipher-under-A')
  expect(() => fence(), 'still current: the enqueue proceeds').not.toThrow()
  // the representation moves between encryption and the actual write enqueue
  session = KEYS_B
  expect(() => fence(), 'exact-object check: non-null is NOT enough').toThrow(
    'v1 keys changed before publication: save aborted'
  )
  session = null
  expect(() => fence()).toThrow('save aborted')
})

test('the fence compares OBJECT identity, not content equality', async () => {
  // a structurally identical but distinct keys object (a later re-acquisition) must not pass:
  // the write was prepared under THE object the fence captured
  let session: KdfSessionKeys | null = KEYS_A
  const { fence } = await encryptV1WithSession({
    acquire: async () => ({ kind: 'ready', keys: KEYS_A }),
    current: () => session,
    encrypt: async () => 'cipher',
  })
  session = { ...KEYS_A } as KdfSessionKeys // same content, different object
  expect(() => fence()).toThrow('save aborted')
})
