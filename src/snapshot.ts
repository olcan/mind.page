// pure decision function for an items-query snapshot (extracted from the listener in
// index.svelte; table-tested in tests/unit/snapshot.spec.ts). the caller owns all effects —
// populating items, starting initialization, arming the init-completion callback, applying doc
// changes — and the firstSnapshot/initTime bookkeeping; this function only decides.

export type SnapshotFacts = {
  // sync disabled via window._disable_sync (item code can pause remote application)
  syncDisabled: boolean
  // initialization has started (initTime set)
  initialized: boolean
  // no snapshot has been processed yet by this listener (a 'wait_for_server' outcome does NOT
  // consume the first snapshot: the next snapshot is still the first)
  firstSnapshot: boolean
  // snapshot.metadata.fromCache: served by the persistent local cache, not the server
  fromCache: boolean
  // snapshot.empty
  empty: boolean
  // snapshot.docChanges().length
  changeCount: number
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
  // or a cache-to-server confirmation after init): nothing to apply
  | 'ignore_metadata_only'
  // first snapshot from the cache that must not initialize the account: an empty cache (fresh)
  // or a partial one (e.g. only plaintext shared items cached by a shared-page visit) would
  // treat a populated account as empty or unencrypted and prompt for a NEW secret phrase over
  // the existing items; keep waiting — the server snapshot follows (metadata-only if the cache
  // was complete, which is why the listener includes metadata changes)
  | 'wait_for_server'
  // first usable snapshot: populate items from it, start initialization, arm completion
  | 'initialize'
  // first snapshot arriving after initialization already started from a direct server load:
  // ignore its docs (presumably the local cache) and only arm the init-completion callback
  | 'arm_completion'
  // any later snapshot: apply its doc changes (once initialization completes)
  | 'apply_changes'

export function snapshotAction(facts: SnapshotFacts): SnapshotAction {
  if (facts.syncDisabled) return 'ignore_sync_disabled'
  if (facts.initialized && !facts.firstSnapshot && facts.changeCount == 0) return 'ignore_metadata_only'
  if (facts.firstSnapshot) {
    if (
      !facts.initialized &&
      facts.fromCache &&
      (facts.empty || (!facts.anonymous && !facts.fixed && !facts.hasStoredSecret))
    )
      return 'wait_for_server' // see the note on the action above; a returning device with the
    // stored secret still initializes offline from its complete cache
    return facts.initialized ? 'arm_completion' : 'initialize'
  }
  return 'apply_changes'
}
