// the STARTUP LIFECYCLE of the items listener (see the ingress coordinator design in the vault
// repo, notes/design/mind_page_hidden_ingress_coordinator.md). Extracted from index.svelte because
// its defects are all LIVENESS defects — something awaited a promise that never settled — and a
// liveness defect inside a 10,000-line component cannot be observed by any table over pure
// decisions, nor driven deterministically by the browser suite.
//
// This is the mechanism index.svelte calls, not a testable likeness of it. Firestore, the item
// reducers, rendering and the coordinator stay in the component; what lives here is the ORDER and
// the TERMINATION rules:
//
// - the prefetch settles BEFORE the listener installs, and installs the listener on every outcome
//   except a sticky stop — a failed prefetch is fail-soft (the index is simply not authoritative);
// - the initialization attempt is terminal on every branch, including an early return that never
//   reaches the rendering pass which resolves the component's success-only `initialization`;
// - a FAILED authority lease never waits for that attempt. It establishes nothing, so there is
//   nothing to order it behind — and the attempt can be pending for a human-length phrase prompt.

/** Runs the eligible pre-listener prefetch, retains its result, then installs the listener. */
export async function prefetchThenInstall<T>(deps: {
  // whether this page should prefetch at all (a fixed, non-readonly, non-anonymous owner holding
  // the stored secret)
  eligible: boolean
  fetch: () => Promise<T[]>
  onError: (error: unknown) => void
  // RETAINED BEFORE the listener installs — never afterwards, and never through the returned
  // promise: the first snapshot can be dispatched in the same turn as the installation, and a
  // result published after that is invisible to the decision that reads it.
  // an array — INCLUDING an empty one — means a successful scan, which is what makes a cached
  // first snapshot wait for the server; `undefined` means not attempted or failed, and those two
  // carry identical policy
  retain: (prefetched: T[] | undefined) => void
  // a sticky stop reached while the prefetch was in flight: installing then would open a listener
  // nothing will ever terminalize
  stopped: () => boolean
  install: () => void
}): Promise<void> {
  let prefetched: T[] | undefined
  if (deps.eligible) {
    try {
      prefetched = await deps.fetch()
    } catch (e) {
      deps.onError(e) // FAIL-SOFT: the page still installs and initializes
    }
  }
  deps.retain(prefetched)
  if (!deps.stopped()) deps.install()
}

/**
 * One ALWAYS-SETTLING initialization attempt: it resolves whether the rebuild completed, and
 * enters sticky stop on any incomplete or failed one so a later metadata-only candidate can never
 * seal over a half-built index.
 */
export async function runInitializationAttempt(deps: {
  // resolves whether the rebuild ran to completion. it must NOT be the component's success-only
  // `initialization` promise: an encryption/signout early return never resolves that one
  initialize: () => Promise<boolean>
  onError: (error: unknown) => void
  stop: (reason: string) => void
}): Promise<boolean> {
  try {
    const ok = await deps.initialize()
    if (!ok) deps.stop('initialization did not complete')
    return ok
  } catch (e) {
    deps.onError(e)
    deps.stop('initialization failed')
    return false
  }
}

/**
 * What one authority lease concludes, and — the point of this function — WHEN.
 *
 * A failed lease resolves without awaiting anything. A successful one settles behind the retained
 * initialization attempt and therefore in receipt order; with no attempt started, this callback
 * can conclude nothing and fails.
 */
export async function settleAuthorityLease(deps: {
  failed: boolean
  // the retained attempt, or `undefined` before one starts
  attempt: () => Promise<boolean> | undefined
  // the component's own completion flag, read AFTER the attempt settles
  initialized: () => boolean
}): Promise<'seal' | 'fail'> {
  if (deps.failed) return 'fail'
  const attempt = deps.attempt()
  if (!attempt) return 'fail'
  const ok = await attempt
  return ok && deps.initialized() ? 'seal' : 'fail'
}
