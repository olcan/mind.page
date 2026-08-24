import { expect, test } from '@playwright/test'
import { snapshotAction, type SnapshotFacts } from '../../src/snapshot.js'

// table tests for the items-listener gate (see src/snapshot.ts); each case documents an incident
// or a policy the e2e cache tests exercise end-to-end (empty cache, partial cache, complete
// cache with a metadata-only confirmation)

const base: SnapshotFacts = {
  syncDisabled: false,
  initialized: false,
  firstSnapshot: true,
  fromCache: false,
  empty: false,
  changeCount: 1,
  anonymous: false,
  fixed: false,
  hasStoredSecret: false,
}

const cases: [string, Partial<SnapshotFacts>, ReturnType<typeof snapshotAction>][] = [
  // fresh personal sign-in: an empty cached first snapshot must wait (initializing would copy
  // the welcome item and prompt for a NEW phrase over an existing account)
  ['cached empty first snapshot waits', { fromCache: true, empty: true }, 'wait_for_server'],
  // partial cache: only plaintext shared items cached by a shared-page visit; without a stored
  // secret this must also wait
  ['cached nonempty personal first snapshot without a stored secret waits', { fromCache: true }, 'wait_for_server'],
  // a returning device holds the secret and initializes offline from its complete cache
  ['cached personal first snapshot with a stored secret initializes', { fromCache: true, hasStoredSecret: true }, 'initialize'],
  // the server snapshot that follows a wait initializes — including the metadata-only
  // cache-to-server confirmation when the cache was already complete (changeCount 0 does not
  // suppress a FIRST snapshot; the wait outcome left firstSnapshot true)
  ['server first snapshot initializes', {}, 'initialize'],
  ['metadata-only server confirmation of a complete cache initializes', { changeCount: 0 }, 'initialize'],
  // anonymous and fixed pages keep their cache-friendly behavior (only empty caches wait)
  ['anonymous cached first snapshot initializes', { fromCache: true, anonymous: true }, 'initialize'],
  ['fixed cached first snapshot initializes', { fromCache: true, fixed: true }, 'initialize'],
  ['anonymous cached EMPTY first snapshot still waits', { fromCache: true, anonymous: true, empty: true }, 'wait_for_server'],
  ['fixed cached EMPTY first snapshot still waits', { fromCache: true, fixed: true, empty: true }, 'wait_for_server'],
  // initialization already started from a direct server load: the (cached) first listener
  // snapshot only arms completion, without repopulating items
  ['already-initializing first snapshot arms completion', { initialized: true, fromCache: true }, 'arm_completion'],
  // after initialization, metadata-only snapshots (pending-write acks, cache-to-server
  // transitions) are ignored, and snapshots with changes apply
  ['metadata-only after init is ignored', { initialized: true, firstSnapshot: false, changeCount: 0 }, 'ignore_metadata_only'],
  ['changes after init apply', { initialized: true, firstSnapshot: false, changeCount: 2 }, 'apply_changes'],
  // _disable_sync drops everything
  ['sync disabled ignores', { syncDisabled: true, initialized: true, firstSnapshot: false }, 'ignore_sync_disabled'],
]

for (const [name, overrides, expected] of cases)
  test(name, () => {
    expect(snapshotAction({ ...base, ...overrides })).toBe(expected)
  })

test('waiting is stable: the same cached snapshot keeps waiting until the server answers', () => {
  const facts = { ...base, fromCache: true, empty: true }
  expect(snapshotAction(facts)).toBe('wait_for_server')
  expect(snapshotAction(facts)).toBe('wait_for_server') // wait does not consume the first snapshot
  expect(snapshotAction({ ...facts, fromCache: false })).toBe('initialize') // the server does
})
