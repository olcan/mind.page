// pure decision function for an items-query snapshot (extracted from the listener in
// index.svelte; table-tested in tests/unit/snapshot.spec.ts). the caller owns all effects —
// populating items, starting initialization, arming the init-completion callback, applying doc
// changes — and the firstSnapshot/initTime bookkeeping; this function only decides.

export type SnapshotFacts = {
  // sync disabled via window._disable_sync (item code can pause remote application)
  syncDisabled: boolean
  // initialization has STARTED (initTime set) — distinct from the component's `initialized`
  // flag, which means initialization completed
  initializationStarted: boolean
  // no snapshot has been processed yet by this listener (a 'wait_for_server' outcome does NOT
  // consume the first snapshot: the next snapshot is still the first)
  firstSnapshot: boolean
  // snapshot.metadata.fromCache: served by the persistent local cache, not the server
  fromCache: boolean
  // snapshot.empty
  empty: boolean
  // snapshot.docChanges().length
  changeCount: number
  // snapshot.metadata.hasPendingWrites (local writes not yet acknowledged by the server)
  hasPendingWrites: boolean
  // account mode
  anonymous: boolean
  fixed: boolean
  // this device holds the account secret (localStorage.mindpage_secret)
  hasStoredSecret: boolean
  // an eligible fixed hidden prefetch settled successfully BEFORE the listener installed (a
  // successful EMPTY prefetch is still true; failed and not-attempted carry identical policy,
  // so one boolean suffices — see the design's startup section)
  prefetchSucceeded: boolean
}

export type SnapshotAction =
  // window._disable_sync: warn and drop the snapshot
  | 'ignore_sync_disabled'
  // post-initialization snapshot with no doc changes (metadata only, e.g. a pending-write ack
  // or a cache-to-server confirmation after init): no data to apply — though it can still
  // establish authority (see below), which is why the decision carries both facts
  | 'ignore_metadata_only'
  // first snapshot from the cache that must not initialize the account: an empty cache (fresh)
  // or a partial one (e.g. only plaintext shared items cached by a shared-page visit) would
  // treat a populated account as empty or unencrypted and prompt for a NEW secret phrase over
  // the existing items; keep waiting — the server snapshot follows (metadata-only if the cache
  // was complete, which is why the listener includes metadata changes)
  | 'wait_for_server'
  // first usable snapshot: populate items from it, start initialization, arm completion
  // NOTE: this can be a cached snapshot (anonymous/fixed pages, or a returning device with the
  // stored secret initializing offline) — initialization does NOT imply authority
  | 'initialize'
  // any later snapshot: apply its doc changes (once initialization completes)
  | 'apply_changes'

// the AUTHORITY POLICY for a snapshot callback's lease (see the ingress coordinator design,
// notes/design/mind_page_hidden_ingress_coordinator.md in the vault repo):
// - `candidate`: a current full-account server revision — may advance the authority basis;
// - `revoke`: any cached revision invalidates synchronously at receipt (the cache may be partial
//   or stale). `fromCache && hasPendingWrites` is REVOKE: cached-ness takes precedence over the
//   own-overlay case;
// - `preserve`: a server pending-write overlay (this client's own writes), or a current
//   fixed/anonymous revision — neither advances nor invalidates the basis.
// the sync-disabled action carries NO policy: it routes to the sticky ingress stop, and a policy
// there would be the meaningless combination the discriminated union exists to remove
export type AuthorityPolicy = 'candidate' | 'revoke' | 'preserve'

export type SnapshotDecision =
  | { action: 'ignore_sync_disabled' }
  | { action: Exclude<SnapshotAction, 'ignore_sync_disabled'>; policy: AuthorityPolicy }

// one policy table for every non-sync-disabled action
function authorityPolicy(facts: SnapshotFacts): AuthorityPolicy {
  if (facts.fromCache) return 'revoke'
  if (facts.hasPendingWrites) return 'preserve'
  if (facts.anonymous || facts.fixed) return 'preserve'
  return 'candidate'
}

export function snapshotDecision(facts: SnapshotFacts): SnapshotDecision {
  if (facts.syncDisabled) return { action: 'ignore_sync_disabled' }
  const policy = authorityPolicy(facts)
  if (facts.initializationStarted && !facts.firstSnapshot && facts.changeCount == 0)
    return { action: 'ignore_metadata_only', policy }
  if (facts.firstSnapshot) {
    // a SUCCESSFUL hidden prefetch waits through a cached first snapshot for the first non-cache
    // snapshot, which supersedes prefetched copies of the same id — a fixed page could otherwise
    // initialize from a stale cached snapshot even though the prefetch just came from the
    // server. the listener supplies this from its RETAINED pre-listener prefetch result (see
    // prefetchThenInstall in src/startup.ts): an array — including an empty one — is success
    if (facts.prefetchSucceeded && facts.fromCache) return { action: 'wait_for_server', policy }
    if (
      !facts.initializationStarted &&
      facts.fromCache &&
      (facts.empty || (!facts.anonymous && !facts.fixed && !facts.hasStoredSecret))
    )
      return { action: 'wait_for_server', policy } // see the note on the action above; a
    // returning device with the stored secret still initializes offline from its complete cache
    return { action: 'initialize', policy }
  }
  return { action: 'apply_changes', policy }
}

/**
 * Whether a delivery must go and establish what its document CURRENTLY is, rather than acting on
 * the payload it was handed.
 *
 * Firestore hands a `removed` change the document's **old** data. On the full-account listener that
 * is harmless: the query IS the account, so leaving it can only mean deletion. A fixed (shared)
 * page's query is a strict subset — `attr.shared.keys array-contains <key>` — and a hidden document
 * can never be in it, because hidden documents are written with `attr` null. So a removal there
 * means the document left the SHARED SET: deleted, unshared, or **turned hidden**, whose payload
 * describes the old, visible side.
 *
 * Acting on that payload loses the document: the visible row is removed and nothing installs the
 * hidden record, because a confirmation commits only its own name's affected closure. The delivery
 * would also resolve `applied` and heal every strictly older same-cell block having established
 * nothing about the hidden side.
 *
 * SCOPED TO THE OWNER, and positively: only a writable, authenticated owner of a fixed page can
 * read or decrypt that account's hidden corpus. A foreign or read-only fixed page must keep
 * treating its removals as ordinary visible-query removals — its read would be unauthorized, and it
 * must never prompt a visitor for the sharer's secret.
 *
 * ONE predicate for both uses: it forces ADMITTED allocation at receipt (a blind record never
 * reaches the resolver at all) and selects the final-state read at the delivery boundary. Those two
 * decisions must not be able to disagree.
 *
 * THE SECOND TRIGGER — `sideUncertain` (2026-08-28, the two-tab `_old` root cause; see the vault
 * issue "MindPage Stale Hidden Redelivery Reverses a Visible Transition"): a NON-REMOVAL delivery
 * whose payload side may not be the document's side by its reserved turn. A listener can deliver
 * an OLDER opposite-side payload around a newer transition (transport unisolated: listener
 * re-emission, shared-cache replay, or a late acknowledgement — the application fix is
 * transport-agnostic), and a payload-routed application then reverses the transition — removing
 * the visible row and reinstalling a stale wrapper, or dropping a live hidden record for a stale
 * visible row. Uncertainty is CAPTURED AT RECEIPT from four sources: the held side already
 * contradicts the payload; prior same-id coordinator STATE REMAINS OUTSTANDING — a queued
 * nonterminal delivery, or a retained terminal block whose applied side still matches the stale
 * payload (hasOutstanding covers both); an earlier live BLIND record, whose not-hidden body may
 * install the visible side before a raw-hidden delivery's lane turn; or a pending corpus
 * producer holds a boundary the delivery waits behind and may change the held side first. The
 * membership read resolves the CURRENT side server-confirmed; a delivery whose payload matches
 * it routes exactly as before.
 *
 * OWNER-SCOPED, defensively: read-only and anonymous pages must never take the MEMBERSHIP READ
 * (nor decrypt its queried hidden result) — anonymous pages DO run the realtime listener on an
 * admin-writable account and hold no owner secret (acquisition throws), and a read-only page
 * must not query a corpus it does not own — so the evidence boundary refuses both modes
 * outright rather than relying on uncertainty sources being unreachable there. (Delivered live
 * payloads are still decrypted during ordinary preparation; this scopes only the evidence
 * seam.) (Live anonymous hidden-row validity is a
 * pre-existing policy hole recorded for backfill, deliberately not solved in this slice.)
 */
export function needsFinalStateEvidence(facts: {
  fixed: boolean
  readonly: boolean
  anonymous: boolean
  removed: boolean
  // the payload's side may have moved by the delivery's reserved turn (non-removal); see above
  sideUncertain?: boolean
}): boolean {
  return !facts.readonly && !facts.anonymous && ((facts.fixed && facts.removed) || !!facts.sideUncertain)
}
