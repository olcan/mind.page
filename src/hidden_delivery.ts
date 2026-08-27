// THE LISTENER DELIVERY BOUNDARY (see the ingress coordinator design in the vault repo,
// notes/design/mind_page_hidden_ingress_coordinator.md): allocation through reducer invocation,
// as ONE typed seam.
//
// This is the mechanism index.svelte calls, not a testable likeness of it. What lives here is the
// part reviews 74-76 kept finding half-wired because it could only be read, never driven: which
// change is ADMITTED at receipt, which delivery must establish its document's CURRENT state before
// acting, the order those decisions run in, and which injected reducer each answer reaches. The
// reducer implementations, startup/authority policy, UI and logging stay in the component.
//
// The receipt-time and delivery-time halves share ONE envelope, so the facts a delivery consumes —
// its captured corpus boundary, its `needsEvidence` bit — are exactly the ones its RECEIPT
// computed, positionally, never recomputed from state that may have moved.

import type { AllocationRequest, RecordHandle } from './hidden_listener_records.js'
import { classifyHiddenDocument, type ParsedWrapper } from './hidden_confirm.js'
import { needsFinalStateEvidence } from './snapshot.js'

// ---- the per-delivery stop waiters -------------------------------------------------------------
// A delivery holding a network read cannot be terminalized by batch.abort() once its handle is
// running, so a never-settling read would retain the handle, its callback context and batch.landed
// until reload. The wait is made cancellable PER READ: each race registers its own rejector and
// removes it in `finally`, so a healthy page that never stops retains NOTHING — the page-lifetime
// shared pending promise this replaces leaked one reaction per successful read, the exact pattern
// the corpus module removed in round 69.

export function createStopWaiters() {
  const waiters = new Set<(error: unknown) => void>()
  let stopped: { error: unknown } | undefined
  return {
    // race `read` against page stop. resolves/rejects with the read, or rejects with the stop
    // error — whichever settles first. NOTE stop does not abort the underlying request: the caller
    // must recheck liveness before acting on a late result
    race<T>(read: Promise<T>): Promise<T> {
      if (stopped) return Promise.reject(stopped.error)
      let reject!: (error: unknown) => void
      const cancelled = new Promise<never>((_, rej) => (reject = rej))
      waiters.add(reject)
      return Promise.race([read, cancelled]).finally(() => void waiters.delete(reject))
    },
    // drained exactly once; late reads then reject immediately rather than racing
    stop(error: unknown): undefined {
      if (stopped) return undefined
      stopped = { error }
      for (const reject of [...waiters]) reject(error)
      waiters.clear()
      return undefined
    },
    // observability for the retention pin: a healthy page holds zero waiters between reads
    waiting: () => waiters.size,
  }
}
export type StopWaiters = ReturnType<typeof createStopWaiters>

// ---- the owner hidden-set membership read ------------------------------------------------------
// What a document CURRENTLY is, shaped so ABSENCE is a real answer. It is the owner's hidden-set
// query, NOT a direct get: the read rule reads fields off `resource.data`, and a deleted document
// has no resource — so a direct get of a missing id is DENIED, which a caller cannot tell from a
// failure, and a documentId()-constrained query reproduces the denial (both pinned against the
// deployed rules in tests/e2e/rules.spec.ts). Absence from the set IS the answer, so a not-hidden
// verdict costs NO decrypt.

export type Membership =
  // the id is not in the owner's hidden set: deleted, unshared, or visible — all the same thing to
  // the hidden side. this is NOT a claim the document is gone from the world
  | { kind: 'not-hidden' }
  // it is hidden NOW: the CURRENT document, decrypted and classified
  | { kind: 'hidden'; snap: unknown; item: any; wrapper: ParsedWrapper }

export async function readHiddenMembership(
  id: string,
  deps: {
    // ONE server-confirmed read of the owner's hidden set (user == uid && hidden == true)
    queryHiddenSet: () => Promise<{ id: string; data: () => any; [key: string]: any }[]>
    // liveness, rechecked AFTER the query and BEFORE decrypting: racing the wait does not abort
    // the request, and a late result must not prompt or do secret work after stop
    stopped: () => boolean
    decrypt: (data: any, id: string) => Promise<any>
  }
): Promise<Membership> {
  const rows = await deps.queryHiddenSet()
  if (deps.stopped()) throw new Error('hidden ingress stopped')
  const snap = rows.find(row => row.id == id)
  if (!snap) return { kind: 'not-hidden' }
  const item = await deps.decrypt(snap.data(), id)
  if (deps.stopped()) throw new Error('hidden ingress stopped')
  const c = classifyHiddenDocument(id, !!item.hidden, item.text)
  // FAIL CLOSED, twice over: an indeterminate classification is not absence, and a row in the
  // hidden set that classifies not-hidden is a server contradiction this delivery cannot resolve.
  // either way it must not heal an older same-cell block on evidence it does not have
  if (c.kind != 'hidden') throw new Error(`hidden document ${id} could not be classified`)
  return { kind: 'hidden', snap, item, wrapper: c.wrapper }
}

// ---- receipt ----------------------------------------------------------------------------------

export type PageMode = { fixed: boolean; readonly: boolean; anonymous: boolean }

export type ReceiptEnvelope = {
  id: string
  removed: boolean
  rawHidden: boolean
  // the allocation this receipt decided — handed to the allocator verbatim
  request: AllocationRequest
  // the pending corpus producer's boundary, captured IN THIS TURN. looked up later, the producer
  // may have finished and an unrelated one become active
  boundary: Promise<void> | undefined
  // whether this delivery must establish its document's CURRENT state before acting (see
  // needsFinalStateEvidence). captured HERE and carried, so admission and the delivery-time read
  // cannot disagree — not on the formula, and not on the inputs either
  needsEvidence: boolean
}

/**
 * The ONE receipt decision for a change: what to allocate, and the facts its delivery will consume.
 *
 * An AMBIGUOUS OWNER-FIXED REMOVAL is admitted on its own: its payload is the OLD visible document,
 * so `rawHidden` is false, and an ordinary visible-to-hidden transition has no wrapper, no
 * outstanding handle and no corpus membership either — blind, it would remove the visible row from
 * a stale payload and never take the read that installs the hidden record. A foreign or read-only
 * fixed page is deliberately NOT admitted this way: it neither owns nor can decrypt the sharer's
 * hidden corpus, and must never prompt a visitor for the owner's secret.
 */
export function receiveChange(
  change: { id: string; removed: boolean; rawHidden: boolean; cipher: string | undefined },
  deps: {
    mode: PageMode
    pendingBoundary: (id: string) => Promise<void> | undefined
    // whether the applied index depends on this id (a wrapper, or an adoption in flight)
    tracksDocument: (id: string) => boolean
    hasOutstanding: (id: string) => boolean
    open: (id: string, cipher: string | undefined) => RecordHandle
  }
): ReceiptEnvelope {
  const { id, removed, rawHidden } = change
  const boundary = deps.pendingBoundary(id)
  const needsEvidence = needsFinalStateEvidence({ ...deps.mode, removed })
  const admitted = rawHidden || needsEvidence || deps.tracksDocument(id) || deps.hasOutstanding(id) || !!boundary
  // the raw cipher is captured BEFORE decrypt, so an echo waiter can learn its own echo failed to
  // decrypt rather than waiting forever. ONLY for a live raw-hidden delivery: firestore hands a
  // REMOVED change its old data, so forwarding that cipher would let a deletion satisfy the exact
  // echo waiter of the write it deleted
  const live = !removed && rawHidden
  return {
    id,
    removed,
    rawHidden,
    request: admitted
      ? { kind: 'admitted', id, handle: deps.open(id, live ? change.cipher : undefined) }
      : { kind: 'blind', id },
    boundary,
    needsEvidence,
  }
}

// ---- the admitted delivery ---------------------------------------------------------------------

export type AdmittedDeliveryDeps = {
  stopped: () => boolean
  stopWaiters: StopWaiters
  // the owner hidden-set membership read for this delivery's id
  readMembership: () => Promise<Membership>
  // the applied index's current holder name for the id (round 66: read IN the reserved turn)
  nameForDocument: () => string | undefined
  // whether the HIDDEN index currently holds the id — re-types an evidence-backed transition for
  // the hidden reducers (added vs modified)
  hiddenIndexed: () => boolean
  // whether the VISIBLE items currently hold the id — normalizes the visible half so a redelivery
  // repairs an absent row and a partially installed one identically
  visiblePresent: () => boolean
  // the persistence controller's serialized application (names, then the synchronous body)
  applyRemote: (names: (string | undefined)[], body: () => undefined) => Promise<void>
  // fail-closed local intent: an admitted transition may not defer (see the design)
  hasLocalIntent: () => boolean
  // ---- the real reducers, injected ----
  // remove the visible representation of a document that is now hidden
  removeVisibleForHidden: (snap: unknown) => undefined
  // apply one change through the ordinary visible reducers (with supersession)
  applyVisible: (change: { type: string; doc: unknown }, snap: unknown, item: any) => undefined
  // remove the hidden record, reporting the dropped name if one was indexed
  removeHiddenRecord: () => { droppedName: string | undefined }
  // downstream notification for a dropped hidden name
  hiddenChanged: (name: string, changeType: string) => undefined
  // hidden validity may have changed: schedule the authoritative recomputation
  markCleanupPending: () => undefined
  // diagnostics: the evidence read failed (blocks the handle before the application's own arm)
  onEvidenceError: (error: unknown) => undefined
}

/**
 * Runs one admitted delivery's application, inside its record's reserved turn.
 *
 * Order: the captured corpus boundary, then liveness, then — for an ambiguous owner-fixed removal —
 * the final-state read (BEFORE the name chains, because the answer determines the affected NAMES as
 * much as the effects; the stale payload's name set is empty), then `applyRemote` with the routed
 * synchronous body. A rejection anywhere blocks the handle: a delivery that established or applied
 * nothing must not publish `applied` and heal older same-cell blocks with it.
 */
export async function applyAdmittedDelivery(
  delivery: {
    change: { type: string; doc: unknown }
    // the payload as delivered (decrypted; a removal fabricates `{ hidden, text: '' }`)
    item: any
    // the payload's parsed wrapper for a live hidden change, if any
    wrapper: ParsedWrapper | null
    boundary: Promise<void> | undefined
    needsEvidence: boolean
  },
  deps: AdmittedDeliveryDeps
): Promise<void> {
  if (delivery.boundary) await delivery.boundary
  if (deps.stopped()) throw new Error('hidden ingress stopped')

  // FINAL-STATE EVIDENCE for an ambiguous owner-fixed removal. the SAME envelope bit forced this
  // record to be allocated admitted, so a blind record can never reach this line
  let saved = delivery.item
  let target = delivery.wrapper
  let gone = delivery.change.type == 'removed'
  let applyChange = delivery.change
  let applySnap: unknown = delivery.change.doc
  if (delivery.needsEvidence) {
    const membership = await deps.stopWaiters.race(deps.readMembership()).catch(e => {
      deps.onEvidenceError(e)
      throw e
    })
    if (deps.stopped()) throw new Error('hidden ingress stopped')
    if (membership.kind == 'hidden') {
      // the payload described the OLD side of a visible-to-hidden transition: apply the CURRENT
      // document, re-typed from current presence so the ordinary reducers install it
      saved = membership.item
      target = membership.wrapper
      gone = false
      applySnap = membership.snap
      applyChange = { ...delivery.change, type: deps.hiddenIndexed() ? 'modified' : 'added', doc: membership.snap }
    }
    // not-hidden: the removal stands, and the hidden-side removal below is backed by evidence
  }

  const hidden = !!saved?.hidden && !gone
  // IN-TURN: the affected name chains are read here, from the index as it stands in this
  // delivery's reserved turn. a rename must join the in-flight write on its OLD name
  const names = hidden ? [deps.nameForDocument(), target?.name] : [deps.nameForDocument()]
  return deps.applyRemote(names, () => {
    // STOP REJECTS rather than returning: a running handle cannot be blocked, and returning
    // successfully would publish `applied` for a delivery that mutated nothing
    if (deps.stopped()) throw new Error('hidden ingress stopped')
    // LOCAL INTENT, fail-closed: ordinary reconciliation owns no coordinator handle and cannot
    // heal this delivery, so deferring would strand it and clearing a deferral would lose the
    // local change. recovery is a reload or an independently later delivery
    if (deps.hasLocalIntent()) throw new Error('local intent held')
    if (hidden) {
      // VISIBLE -> HIDDEN, both halves in this turn
      deps.removeVisibleForHidden(applySnap)
      deps.applyVisible(applyChange, applySnap, saved)
      deps.markCleanupPending()
      return undefined
    }
    // HIDDEN -> VISIBLE, a removal, or a redelivery for an id the hidden index still depends on.
    // the old side uses the real reducer and its downstream notification — and it is always backed
    // by evidence now: an ambiguous payload was replaced by the fresh read above
    const { droppedName } = deps.removeHiddenRecord()
    if (droppedName) {
      deps.hiddenChanged(droppedName, applyChange.type)
      deps.markCleanupPending()
    }
    if (gone) return deps.applyVisible(applyChange, applySnap, saved)
    // NORMALIZE the visible half from CURRENT presence, so a redelivery repairs an absent row and
    // a partially installed one identically
    const type = deps.visiblePresent() ? 'modified' : 'added'
    const visible = applyChange.type == type ? applyChange : { ...applyChange, type, doc: applySnap }
    return deps.applyVisible(visible, applySnap, saved)
  })
}
