import { expect, test } from '@playwright/test'
import {
  needsFinalStateEvidence,
  snapshotDecision,
  type SnapshotFacts,
  type AuthorityPolicy,
} from '../../src/snapshot.js'

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

// WHEN A DELIVERY MUST ESTABLISH THE CURRENT STATE (see needsFinalStateEvidence). ONE predicate
// decides both admission at receipt and the read at the delivery boundary — a blind record never
// reaches the resolver, so the two decisions must not be able to disagree
const owner = { fixed: true, readonly: false, anonymous: false, removed: true }
for (const [what, facts, expected] of [
  ['an owner-fixed removal is ambiguous: deleted, unshared, or TURNED HIDDEN', owner, true],
  ['a full-account removal IS deletion', { ...owner, fixed: false }, false],
  ['a fixed non-removal carries the current document', { ...owner, removed: false }, false],
  // a foreign or read-only fixed page cannot read or decrypt the sharer's hidden corpus, and must
  // never prompt a visitor for their secret
  ['a READ-ONLY fixed page stays an ordinary visible-query removal', { ...owner, readonly: true }, false],
  ['an ANONYMOUS fixed page likewise', { ...owner, anonymous: true }, false],
  // the SECOND trigger (the two-tab `_old` root cause): a non-removal whose payload side may
  // have moved by its reserved turn — held-side contradiction, prior same-id coordinator state
  // remaining outstanding (a queued nonterminal delivery OR a retained terminal block), a live
  // blind predecessor, or a pending corpus boundary — needs evidence on OWNER-CAPABLE pages; read-only
  // and anonymous pages are refused outright (they must never query or decrypt the corpus)
  [
    'side uncertainty forces evidence on the ordinary account page',
    { fixed: false, readonly: false, anonymous: false, removed: false, sideUncertain: true },
    true,
  ],
  [
    'side uncertainty forces evidence on an owner-fixed page too',
    { ...owner, removed: false, sideUncertain: true },
    true,
  ],
  [
    'no uncertainty leaves a non-removal blind, exactly as before',
    { fixed: false, readonly: false, anonymous: false, removed: false, sideUncertain: false },
    false,
  ],
  [
    'a READ-ONLY page is refused evidence even under uncertainty',
    { fixed: true, readonly: true, anonymous: false, removed: false, sideUncertain: true },
    false,
  ],
  [
    'an ANONYMOUS page is refused evidence even under uncertainty',
    { fixed: true, readonly: false, anonymous: true, removed: false, sideUncertain: true },
    false,
  ],
] as const)
  test(`final-state evidence: ${what}`, () => expect(needsFinalStateEvidence(facts)).toBe(expected))
