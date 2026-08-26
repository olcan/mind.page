// deferred-change reconciliation for ORDINARY (non-hidden) items, extracted from index.svelte so
// its schedules can be table-tested (tests/unit/reconcile.spec.ts).
//
// why deferral exists: a remote change that arrives while the document still has unsettled local
// intent must NOT be applied — it would roll the item back under the user's own in-flight edit,
// and the queued save, which builds its payload from live item state, would then persist that
// rollback to the server. the change is marked deferred instead and settled here once the intent
// has actually settled.
//
// why a SERVER read rather than replaying the deferred payload: item.time is semantic (attribute
// -only and keep_time saves preserve it, and clocks differ across devices), so neither "ours is
// newer" nor "theirs is newer" is sound. one read per actually-conflicted document settles what
// the server really holds.
//
// the scheduling loop stays in the component: it is timer plumbing over this decision.

export type ReconcileItem = {
  savedId?: string | null
  savedText?: string | null
  savedTime?: number | null
  savedAttr?: any
  // VERSION of local intent, bumped once per save (see saveSeq in index.svelte). the presence
  // checks below sample the present; this is what makes a save that came and went during the read
  // visible afterwards
  saveSeq?: number
}

export type ReconcileDeps = {
  // one-shot SERVER read: must not be served from cache, or it could return the very state the
  // deferral is about
  readFromServer: (id: string) => Promise<{ exists: boolean; data?: any }>
  decryptItem: (data: any) => Promise<any>
  // applies the settled outcome through the listener's own path, so deferral and delivery share
  // one application routine
  applyRemote: (type: 'removed' | 'modified', id: string, savedItem: any) => void
  // true while anything local is still going to write this item (an in-flight write, a queued save
  // task, or a save in progress)
  hasLocalIntent: (item: ReconcileItem) => boolean
  // the generation at which this document's latest remote change was deferred, or undefined
  deferredGeneration: (id: string) => number | undefined
  clearDeferral: (id: string) => void
}

// reconciles one deferred document against the server. returns true when it reached a TERMINAL
// outcome (applied, proven equal, or no longer ours to settle) and false when it should be
// retried — a transient read or decrypt failure, where the marker must stay so nothing else has
// to redeliver the change.
//
// EVERY await is followed by the same staleness test, over three things:
// - the deferral generation, so an older read cannot clear a newer deferral's marker;
// - present local intent, so a save queued meanwhile owns the document instead;
// - the intent VERSION, which is the one that matters here. `hasLocalIntent` answers "is a save in
//   flight NOW", so a save that both started and finished inside the read window left no trace in
//   it — and the response, read before that save landed, was applied over the user's completed
//   edit and then persisted by the next save. that was the last destructive case in this path.
export async function reconcileDeferred(
  deps: ReconcileDeps,
  item: ReconcileItem,
  generation: number
): Promise<boolean> {
  const id = item?.savedId
  if (!id || deps.deferredGeneration(id) !== generation) return true // superseded or gone
  if (deps.hasLocalIntent(item)) return true // more local intent queued: reconcile when IT settles
  const seenSaveSeq = item.saveSeq ?? 0
  const stale = () =>
    deps.deferredGeneration(id) !== generation || deps.hasLocalIntent(item) || (item.saveSeq ?? 0) !== seenSaveSeq
  // the marker is cleared only on a terminal outcome, and only if it is still OURS
  const settle = <T>(result: T): T => {
    if (deps.deferredGeneration(id) === generation) deps.clearDeferral(id)
    return result
  }
  try {
    const snapshot = await deps.readFromServer(id)
    if (stale()) return true // a newer deferral or new local intent owns this document now
    if (!snapshot.exists) {
      // application BEFORE settle: it is fallible, and clearing the marker first meant a throwing
      // apply returned "retryable" with nothing left to retry from
      deps.applyRemote('removed', id, { hidden: false, text: '' })
      return settle(true)
    }
    const savedItem = await deps.decryptItem(Object.assign(snapshot.data, { id }))
    if (stale()) return true
    if (savedItem.hidden) return settle(true) // not an ordinary item any more
    // the server already holds our state: nothing was lost, and applying would be a no-op. this
    // also covers the half of the race where the competing save reached the server BEFORE the
    // read, since the snapshot then carries it
    if (
      savedItem.text == item.savedText &&
      savedItem.time == item.savedTime &&
      deepEqual(savedItem.attr, item.savedAttr)
    )
      return settle(true)
    deps.applyRemote('modified', id, savedItem) // before settle: see the removal branch above
    return settle(true)
  } catch (e) {
    // transient read/decrypt failure: the marker stays, the caller retries
    console.error('could not reconcile deferred remote change (will retry):', id, e)
    return false
  }
}

// structural equality for the attribute bag: plain json-ish values only (see item.attr), so this
// avoids pulling lodash into a module the unit tests load directly
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == b
  if (typeof a != 'object' || typeof b != 'object') return false
  if (Array.isArray(a) != Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length != kb.length) return false
  return ka.every(k => deepEqual(a[k], b[k]))
}
