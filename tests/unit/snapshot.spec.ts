import { expect, test } from '@playwright/test'
import { speaksForHiddenSide, snapshotDecision, type SnapshotFacts, type AuthorityPolicy } from '../../src/snapshot.js'

// table tests for the items-listener gate (see src/snapshot.ts); each case documents an incident
// or a policy the e2e cache tests exercise end-to-end (empty cache, partial cache, complete
// cache with a metadata-only confirmation). the decision carries the data action AND the
// authority POLICY for the callback's lease (see the ingress coordinator design): candidate may
// advance the basis, revoke invalidates synchronously at receipt, preserve does neither. the
// sync-disabled action carries NO policy — the discriminated union removes that combination

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
  prefetchSucceeded: false,
}

type Action = ReturnType<typeof snapshotDecision>['action']
const cases: [string, Partial<SnapshotFacts>, Action, AuthorityPolicy][] = [
  // fresh personal sign-in: an empty cached first snapshot must wait (initializing would copy
  // the welcome item and prompt for a NEW phrase over an existing account)
  ['cached empty first snapshot waits', { fromCache: true, empty: true }, 'wait_for_server', 'revoke'],
  // partial cache: only plaintext shared items cached by a shared-page visit; without a stored
  // secret this must also wait
  [
    'cached nonempty personal first snapshot without a stored secret waits',
    { fromCache: true },
    'wait_for_server',
    'revoke',
  ],
  // a returning device holds the secret and initializes offline from its cache — the cached
  // revision still REVOKES authority: the cache may be partial, so creates re-confirm and no
  // invalid item is deleted
  [
    'cached personal first snapshot with a stored secret initializes; cached revokes',
    { fromCache: true, hasStoredSecret: true },
    'initialize',
    'revoke',
  ],
  // the server snapshot that follows a wait initializes as a candidate — including the
  // metadata-only cache-to-server confirmation when the cache was already complete (changeCount
  // 0 does not suppress a FIRST snapshot; the wait outcome left firstSnapshot true)
  ['server first snapshot initializes as a candidate', {}, 'initialize', 'candidate'],
  [
    'metadata-only server confirmation of a complete cache initializes as a candidate',
    { changeCount: 0 },
    'initialize',
    'candidate',
  ],
  // this client's own pending-write overlay neither advances nor invalidates the basis
  ['server first snapshot with pending writes preserves', { hasPendingWrites: true }, 'initialize', 'preserve'],
  // CACHED-NESS TAKES PRECEDENCE over the overlay case (the design's fromCache && hasPendingWrites row)
  [
    'cached WITH pending writes still revokes',
    { fromCache: true, hasPendingWrites: true, hasStoredSecret: true },
    'initialize',
    'revoke',
  ],
  // anonymous and fixed pages keep their cache-friendly behavior (only empty caches wait), and a
  // CURRENT fixed/anonymous revision preserves — it is not the full-account query, so it can
  // neither advance nor discredit the basis
  [
    'anonymous cached first snapshot initializes; cached revokes',
    { fromCache: true, anonymous: true },
    'initialize',
    'revoke',
  ],
  ['fixed cached first snapshot initializes; cached revokes', { fromCache: true, fixed: true }, 'initialize', 'revoke'],
  [
    'anonymous cached EMPTY first snapshot still waits',
    { fromCache: true, anonymous: true, empty: true },
    'wait_for_server',
    'revoke',
  ],
  [
    'fixed cached EMPTY first snapshot still waits',
    { fromCache: true, fixed: true, empty: true },
    'wait_for_server',
    'revoke',
  ],
  ['current anonymous revision preserves', { anonymous: true }, 'initialize', 'preserve'],
  ['current fixed revision preserves', { fixed: true }, 'initialize', 'preserve'],
  // after initialization, metadata-only snapshots are ignored as data — but a server-confirmed
  // one is still a candidate (e.g. the server catching up after a cache initialization)
  [
    'metadata-only after init is ignored as data but is a candidate',
    { initializationStarted: true, firstSnapshot: false, changeCount: 0 },
    'ignore_metadata_only',
    'candidate',
  ],
  [
    'metadata-only pending-write ack after init preserves',
    { initializationStarted: true, firstSnapshot: false, changeCount: 0, hasPendingWrites: true },
    'ignore_metadata_only',
    'preserve',
  ],
  [
    'changes after init apply, as a candidate when current',
    { initializationStarted: true, firstSnapshot: false, changeCount: 2 },
    'apply_changes',
    'candidate',
  ],
  [
    'cached changes after init apply and revoke',
    { initializationStarted: true, firstSnapshot: false, changeCount: 2, fromCache: true },
    'apply_changes',
    'revoke',
  ],
  // THE STARTUP-PREFETCH ROWS (design: prefetchSucceeded + cached first snapshot waits for the
  // first non-cache snapshot, which supersedes prefetched same-id copies)
  [
    'successful prefetch + cached first snapshot waits',
    { prefetchSucceeded: true, fromCache: true, fixed: true, hasStoredSecret: true },
    'wait_for_server',
    'revoke',
  ],
  [
    'successful prefetch + the following current snapshot initializes',
    { prefetchSucceeded: true, fixed: true },
    'initialize',
    'preserve',
  ],
  // ... and a cached POST-initialization change still applies ordinarily: no overly broad
  // prefetchSucceeded && fromCache guard
  [
    'successful prefetch + cached post-init change applies ordinarily',
    { prefetchSucceeded: true, fromCache: true, initializationStarted: true, firstSnapshot: false, changeCount: 1 },
    'apply_changes',
    'revoke',
  ],
]

for (const [name, overrides, action, policy] of cases)
  test(name, () => {
    expect(snapshotDecision({ ...base, ...overrides })).toEqual({ action, policy })
  })

test('sync disabled carries NO policy — the union removes the combination', () => {
  const d = snapshotDecision({ ...base, syncDisabled: true, initializationStarted: true, firstSnapshot: false })
  expect(d).toEqual({ action: 'ignore_sync_disabled' })
  expect('policy' in d, 'no policy key at all').toBe(false)
})

test('a cached metadata-only post-initialization revision is ignored as data and revokes', () => {
  // the row the table was missing; caller-owned firstSnapshot bookkeeping (a wait outcome leaves
  // it unconsumed) is NOT provable by calling a pure function twice — the stage-3 listener
  // fixture owns that assertion
  expect(
    snapshotDecision({
      ...base,
      initializationStarted: true,
      firstSnapshot: false,
      changeCount: 0,
      fromCache: true,
    })
  ).toEqual({ action: 'ignore_metadata_only', policy: 'revoke' })
})

// what a delivery is EVIDENCE OF (see speaksForHiddenSide). a removal from a SUBSET query carries
// the document's OLD data and three possible causes, only one of which is deletion
for (const [what, facts, expected] of [
  ['a full-account removal IS deletion', { fixed: false, removed: true }, true],
  [
    'a fixed-page removal is "left the shared set", which includes turning hidden',
    { fixed: true, removed: true },
    false,
  ],
  ['a fixed-page non-removal carries the current document', { fixed: true, removed: false }, true],
  ['a full-account non-removal likewise', { fixed: false, removed: false }, true],
] as const)
  test(`hidden-side evidence: ${what}`, () => expect(speaksForHiddenSide(facts)).toBe(expected))
