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

export type SnapshotDecision = {
  action: SnapshotAction
  // whether this revision of the query is CURRENT: served by the server with no local pending
  // writes. for the full-account query this is what makes the hidden-item index authoritative
  // (a cache-initialized account may be partial: uniquely keyed creates must re-confirm and
  // provisionally-classified invalid items must not be deleted until an authoritative revision);
  // a metadata-only cache-to-server confirmation carries no data but DOES establish authority
  authoritative: boolean
}

export function snapshotDecision(facts: SnapshotFacts): SnapshotDecision {
  const authoritative = !facts.syncDisabled && !facts.fromCache && !facts.hasPendingWrites
  if (facts.syncDisabled) return { action: 'ignore_sync_disabled', authoritative }
  if (facts.initializationStarted && !facts.firstSnapshot && facts.changeCount == 0)
    return { action: 'ignore_metadata_only', authoritative }
  if (facts.firstSnapshot) {
    if (
      !facts.initializationStarted &&
      facts.fromCache &&
      (facts.empty || (!facts.anonymous && !facts.fixed && !facts.hasStoredSecret))
    )
      return { action: 'wait_for_server', authoritative } // see the note on the action above; a
    // returning device with the stored secret still initializes offline from its complete cache
    return { action: 'initialize', authoritative }
  }
  return { action: 'apply_changes', authoritative }
}
