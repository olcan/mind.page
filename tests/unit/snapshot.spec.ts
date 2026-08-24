import { expect, test } from '@playwright/test'
import { snapshotDecision, type SnapshotFacts } from '../../src/snapshot.js'

// table tests for the items-listener gate (see src/snapshot.ts); each case documents an incident
// or a policy the e2e cache tests exercise end-to-end (empty cache, partial cache, complete
// cache with a metadata-only confirmation). the decision carries the data action AND whether the
// revision is authoritative (current: server-served, no pending writes) — a cache-initialized
// account may be partial, so authority gates hidden-item creates and invalid-item deletion

const base: SnapshotFacts = {
  syncDisabled: false,
  initializationStarted: false,
  firstSnapshot: true,
  fromCache: false,
  empty: false,
  changeCount: 1,
  hasPendingWrites: false,
  anonymous: false,
  fixed: false,
  hasStoredSecret: false,
}

type Expected = [ReturnType<typeof snapshotDecision>['action'], boolean /* authoritative */]
const cases: [string, Partial<SnapshotFacts>, Expected][] = [
  // fresh personal sign-in: an empty cached first snapshot must wait (initializing would copy
  // the welcome item and prompt for a NEW phrase over an existing account)
  ['cached empty first snapshot waits', { fromCache: true, empty: true }, ['wait_for_server', false]],
  // partial cache: only plaintext shared items cached by a shared-page visit; without a stored
  // secret this must also wait
  ['cached nonempty personal first snapshot without a stored secret waits', { fromCache: true }, ['wait_for_server', false]],
  // a returning device holds the secret and initializes offline from its cache — WITHOUT
  // authority: the cache may be partial, so creates re-confirm and no invalid item is deleted
  ['cached personal first snapshot with a stored secret initializes, not authoritative', { fromCache: true, hasStoredSecret: true }, ['initialize', false]],
  // the server snapshot that follows a wait initializes with authority — including the
  // metadata-only cache-to-server confirmation when the cache was already complete (changeCount
  // 0 does not suppress a FIRST snapshot; the wait outcome left firstSnapshot true)
  ['server first snapshot initializes with authority', {}, ['initialize', true]],
  ['metadata-only server confirmation of a complete cache initializes with authority', { changeCount: 0 }, ['initialize', true]],
  // pending local writes keep a server revision non-authoritative
  ['server first snapshot with pending writes initializes without authority', { hasPendingWrites: true }, ['initialize', false]],
  // anonymous and fixed pages keep their cache-friendly behavior (only empty caches wait)
  ['anonymous cached first snapshot initializes', { fromCache: true, anonymous: true }, ['initialize', false]],
  ['fixed cached first snapshot initializes', { fromCache: true, fixed: true }, ['initialize', false]],
  ['anonymous cached EMPTY first snapshot still waits', { fromCache: true, anonymous: true, empty: true }, ['wait_for_server', false]],
  ['fixed cached EMPTY first snapshot still waits', { fromCache: true, fixed: true, empty: true }, ['wait_for_server', false]],
  // after initialization, metadata-only snapshots are ignored as data — but a server-confirmed
  // one still establishes authority (e.g. the server catching up after a cache initialization)
  ['metadata-only after init is ignored as data but can grant authority', { initializationStarted: true, firstSnapshot: false, changeCount: 0 }, ['ignore_metadata_only', true]],
  ['metadata-only pending-write ack after init grants nothing', { initializationStarted: true, firstSnapshot: false, changeCount: 0, hasPendingWrites: true }, ['ignore_metadata_only', false]],
  ['changes after init apply, with authority when current', { initializationStarted: true, firstSnapshot: false, changeCount: 2 }, ['apply_changes', true]],
  ['cached changes after init apply without authority', { initializationStarted: true, firstSnapshot: false, changeCount: 2, fromCache: true }, ['apply_changes', false]],
  // _disable_sync drops everything and grants nothing
  ['sync disabled ignores and grants nothing', { syncDisabled: true, initializationStarted: true, firstSnapshot: false }, ['ignore_sync_disabled', false]],
]

for (const [name, overrides, [action, authoritative]] of cases)
  test(name, () => {
    expect(snapshotDecision({ ...base, ...overrides })).toEqual({ action, authoritative })
  })

test('waiting is stable: the same cached snapshot keeps waiting until the server answers', () => {
  const facts = { ...base, fromCache: true, empty: true }
  expect(snapshotDecision(facts).action).toBe('wait_for_server')
  expect(snapshotDecision(facts).action).toBe('wait_for_server') // wait does not consume the first snapshot
  expect(snapshotDecision({ ...facts, fromCache: false })).toEqual({ action: 'initialize', authoritative: true })
})
