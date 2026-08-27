// per-name persistence controller for hidden items (stage 1b of the index.svelte split;
// matrix-tested in tests/unit/hidden_persistence.spec.ts).
//
// what it does: serializes the BUILDING of writes for a name (encryption can prompt), issues them
// to firestore's queue without waiting for acknowledgement, and settles the index transitions in
// hidden.ts so the name invariant holds.
//
// what it does NOT do: order writers, identify its own echoes, or drop work that was overtaken. a
// queued save carries the latest INTENT for a name and resolves that name's current holder when it
// runs. there is no revision protocol, no write-identity tracking, and no deletion — emptying a
// store is an ordinary save of `{}`.
// NOTE an application can FAIL, in which case the delivery is retained dirty and unapplied, and
// overlapping deliveries for one document can erase one another (one receipt slot per id). both
// are open blockers — see the ingress coordinator contract in plans/mind_page_next_steps.md.
//
// NOTE: saving state is owned BY NAME (`isSaving`), true from the moment save() accepts an intent
// until that generation's write reaches the SDK's queue — not until the server acknowledges. item
// code observes it through _Item.saving_global_store, so that meaning is part of the window
// contract, with one exception: a QUEUED generation reads as not saving while the gate is
// blocked, since it cannot be written until a later delivery heals it. a generation already
// BUILDING stays saving even if the gate blocks mid-build — it goes false when the attempt
// observes the block and requeues. it was previously mirrored on the WRAPPER, which could
// not survive that wrapper being
// replaced, renamed or removed while the writer was parked on the gate (round 60): the intent,
// the wake and the blocked report already belong to the name, and so does this.

import type { ClassifiedRow, Marker } from './hidden_confirm.js'
import { planTargetSlice } from './hidden_confirm.js'
import {
  compareIds,
  isQuarantined,
  finalizeAdoption,
  finalizeCreate,
  removeHidden,
  type HiddenIndex,
  type HiddenWrapper,
} from './hidden.js'

export type HiddenDocData = { hidden: true; time: number; attr: null; text: string }

// the confirmation commit's synchronous result. a top-level `undefined` callback cannot report
// inconclusive or a marker dependency without an output cell or a sentinel throw — and a throw is
// specified to stop ingress
export type CommitResult = { kind: 'inconclusive' } | { kind: 'committed'; requiredMarker?: Marker }

export type HiddenPersistenceDeps = {
  index: () => HiddenIndex
  // encrypts a document payload off the session secret, which `acquireSecret` has already
  // obtained: this must NOT prompt (see encryptItem in index.svelte)
  encryptState: (state: HiddenDocData) => Promise<Record<string, any>>
  // acquires the session secret if it is not already held, PROMPTING if necessary, and
  // SINGLE-FLIGHTING that acquisition (see encrypt/getSecretPhrase in index.svelte): two name
  // chains reaching this together must join one prompt, not raise two. separating it from
  // encryptState means the payload is resolved and encrypted against a target chosen AFTER any
  // prompt, rather than one chosen before it and invalidated by what the prompt registered.
  // required: a harness with no prompt supplies a no-op, but no adapter may leave it out — the
  // stable target loop below depends on encryption never prompting
  acquireSecret: () => Promise<void>
  // an ordinary firestore update. it reaches the SDK's durable, ordered mutation queue as soon
  // as it is called; the promise resolves only when the server acknowledges, which offline can
  // be much later (or never, until reconnect) — so the controller must not wait on it to decide
  // anything, and callers must not treat resolution as "saved"
  updateDoc: (id: string, data: Record<string, any>) => Promise<void>
  // creates the document AT the given id, allocated by the caller (newDocId)
  createDoc: (id: string, data: Record<string, any>) => Promise<void>
  newDocId: () => string
  // server re-confirmation of the hidden index before an unconfirmed create (registration may
  // adopt the pending wrapper); resolves immediately when the index is authoritative, rejects
  // to FAIL the create (a partial index must never lead to a duplicate document)
  // ONE fresh complete hidden server read for `name`, through the serialized corpus seam. the
  // ADAPTER fetches, decrypts and purely classifies; the CONTROLLER commits through the callback
  // below, synchronously, inside that same corpus turn. an adapter-only commit reproduces the a/m
  // schedule: create `m` issued and unacknowledged, stale lower `a` canonical, an answer
  // containing neither, adapter slice-replacement removing BOTH, and re-resolution creating a
  // second id instead of updating `m` behind its own create.
  // resolves 'inconclusive' when a gate check refused with ZERO mutation; rejects to fail the
  // attempt (a server read proves query completeness, not a usable name index)
  confirmTarget: (
    name: string,
    hooks: {
      // captured AFTER the corpus predecessor and immediately BEFORE the query: the create's
      // settlement can clear the marker while the answer is in flight, and a plan built from a
      // later lookup would see nothing, synthesize absence, and remove a record that exists
      captureReadMarker: () => Marker | undefined
      // REQUIRED SYNCHRONOUS: the corpus tail serializes corpus operations, not independent
      // writers, so an await between two index mutations exposes a transient prefix with neither
      // the gate nor a frontier predicting the remainder
      commit: (answer: Map<string, ClassifiedRow>, readMarker: Marker | undefined) => CommitResult
    }
  ) => Promise<'committed' | 'inconclusive'>
  // the ADAPTER-owned synchronous registration for one fresh target row: it runs the
  // visible-to-hidden discriminator prelude and then calls registerHidden EXACTLY ONCE, whose
  // first eligible registration performs the single rebase/adoption/publication. NOTIFICATION-FREE:
  // confirmation runs for an OWED name, so the live remote-change notification would suppress on
  // owes() anyway, and a live delivery keeps its own
  registerTargetRow: (wrapper: HiddenWrapper, mergeAdopted: (pending: HiddenWrapper, found: HiddenWrapper) => undefined) => undefined
  // MERGE ONLY: merges the found document's state under the pending wrapper's changes, in place
  // (production: _.defaultsDeep(pending.item, found.item)). rebasing the wrapper first and
  // publishing the result to the owner are the CONTROLLER's job (see mergeAdopted): keeping merge
  // mechanics here and ownership there is what lets every registration path share one contract
  adopt: (pending: HiddenWrapper, found: HiddenWrapper) => void
  // THE COORDINATOR'S GLOBAL GATE: 'writable' means no delivery is open, ready or running
  // anywhere and no unhealed block is retained. every refuse-and-requeue decision reads this —
  // never a per-name predicate (see the design's v1 gate)
  gate: () => 'blocked' | 'pending' | 'writable'
  // the coordinator's per-id receipt frontier: advanced by every delivery opened for that
  // document, zero for an id with no cell. reading it must never allocate a cell
  receiptFrontier: (id: string) => number
  // THE WAKES, level-triggered and cancellable (see the coordinator's waits). `whenActionable`
  // resolves on writable OR blocked — a writer's blocked behaviour cannot run off a
  // writable-only promise — and `whenWritable` only on writable, which is what a blocked writer
  // waits on for healing. both replace the timer requeue: a retained block used to hot-poll
  // forever, and every pending state cost a chain turn and a secret acquisition
  whenActionable: () => { promise: Promise<'blocked' | 'writable'>; cancel(): void }
  whenWritable: () => { promise: Promise<void>; cancel(): void }
  // publishes an EXACT state to whatever owns a name (the owner item's in-memory global_store),
  // as a clone, never an alias. the owner saves fresh full-state snapshots, so a merge it never
  // sees is erased on its next save — this is how it sees one
  syncOwner: (name: string, state: any) => void
  // synchronizes whatever owns a name's state (the owner item's in-memory global_store) with the
  // record that now holds it. called once when a generation SETTLES, ON THE NAME'S CHAIN: while a
  // name owes a change, deliveries deliberately do not touch the owner (they would roll it back
  // into a handler that saves), so something has to put it back in step when the change lands.
  // required: correctness depends on it, and an optional critical hook lets an adapter silently
  // reopen the invariant
  reconcileOwner: (name: string) => void
  // reports a save failure to something the user can see. TWO shapes now reach it (round 38): a
  // TERMINAL write failure (a settled permission/validation error, not an offline retry), where
  // the record stays retryable; and a PRE-ACCEPTANCE validation rejection from save() — non-JSON
  // state — where the rejected save created no owed record and save() returned false. `error` is
  // an arbitrary thrown JavaScript value: the adapter must format it guardedly (template
  // interpolation of a Symbol throws, as does hostile coercion — String(Symbol) itself is fine)
  notifyFailure: (name: string, error: unknown) => void
  // whether the latest hidden application for this document SUCCEEDED. the write barrier is
  // settle-only by design (an unrelated listener failure must never turn a committed firestore
  // write into a failed one), but that also swallowed the outcome of THIS write's own echo: on a
  // failed application the controller took its success path and reconciled the owner from an index
  // that may still hold the pre-write state, rolling the owner back with no later echo guaranteed
  echoApplied: (id: string) => boolean
  // revokes hidden-index authority (see reserveHiddenAuthority in index.svelte): called when a
  // write proves the index stale (e.g. its target document no longer exists server-side)
  invalidateAuthority: (reason: string) => void
  newTempId: () => string
  readonly: () => boolean
}

// JSON-NORMALIZING deep clone, in the payload's STRUCTURAL POSITION: the state is persisted as
// JSON under the `item` key (payload -> encryptState -> JSON), and JSON.stringify passes the key
// to toJSON — so a legal key-sensitive toJSON must see 'item' here exactly as it will at write
// time, and serializing at the root froze the wrong representation (round 37). wrapping also maps
// a top-level undefined or function to the omitted-item representation instead of retaining the
// mutable reference the root fallback leaked. a nested Date freezes to its serialized string, and
// a legal own `__proto__` key survives as a data property (JSON.parse never invokes the setter).
// throws on state JSON cannot serialize (BigInt, a throwing toJSON) — save() normalizes FIRST and
// routes that through notifyFailure before anything is mutated
function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify({ item: value })).item
}

// a document snapshot of the wrapper's current state (name + item only)
const payload = (wrapper: HiddenWrapper): HiddenDocData => ({
  hidden: true,
  time: Date.now(),
  attr: null,
  text: JSON.stringify({ name: wrapper.name, item: wrapper.item }),
})

const isNotFound = (e: any) => e?.code == 'not-found' || /NOT_FOUND/i.test(String(e?.message ?? e))

// a phrase prompt the user dismissed: an expected outcome, not a failure to report back to them.
// matched EXACTLY, never by a /cancel/i substring — that swallowed unrelated real errors whose
// message merely contains the word ("operation cancelled by server"), recreating the invisible
// owes() state the failure hook exists to end
const CANCELLED_PHRASE = 'secret phrase cancelled' // the message the production prompt rejects with
const isCancellation = (e: any) => e?.cancelled === true || String(e?.message ?? e) == CANCELLED_PHRASE

export function createHiddenPersistence(deps: HiddenPersistenceDeps) {
  const chains = new Map<string, Promise<unknown>>() // per-name serialization

  // ONE record per name describing the whole operation, not just its build window. it replaces
  // three parallel pieces of state (a queued-wrapper map, an unpruned intent map and a
  // recovering-id set) and the wrapper-identity conditions that went with them:
  // - `generation` advances on every save. EVERY step that acts on the world — issuing a write,
  //   finalizing an index transition, settling, recovering — compares its captured generation
  //   first, so stale work cannot resurrect an older state over a newer one
  // - `phase` distinguishes work that is queued, being built, issued (waiting on the server) and
  //   idle after a failure. an idle record is retryable: a later save schedules it, where before
  //   it looked like "a task is already queued" and the work sat forever
  // - the record survives issuance, so `owes()` still classifies the echoes of that write
  type Phase = 'queued' | 'building' | 'issued' | 'failed'
  // localIntent is ONE DEEP CLONE of what the caller saved, per generation, and is never mutated
  // by adoption: every merge rebases from a fresh clone of it (see mergeAdopted). the pending
  // wrapper's `item` is the mutable DERIVED projection built over it; the owner's global_store is
  // a published clone of that projection — three distinct identities (round 35)
  // reportedStop: the terminal stop is reported ONCE PER GENERATION — a genuinely superseding
  // save creates a new generation and may report its own immediate stopped outcome, while old
  // continuations may not report again
  // reportedBlocked: a blocked GENERATION notifies exactly once (design: "notify EXACTLY ONCE").
  // not per block episode — an intervening writable can let the loop reach the report again for
  // the same generation, and a NEW generation inheriting a parked wake would otherwise never be
  // reported at all
  type Owed = { generation: number; localIntent: any; phase: Phase; reportedStop?: boolean; reportedBlocked?: boolean }
  const owed = new Map<string, Owed>()
  // THE OWN-UNACKNOWLEDGED-CREATE MARKER. the writer retains the exact id it issued a create for
  // until that SDK promise settles, INDEPENDENTLY of any later owed generation. it is an
  // exact-target confirmation EXEMPTION that never overrides name selection, and it is
  // WRAPPER-EXACT: registerHidden replaces the indexed object on a fresh same-id observation, and
  // a same-id rename does too, so an id-only exemption would mistake either for this create
  let marker: Marker | undefined
  let markerSeq = 0

  // sticky for the controller's lifetime; every await-crossing continuation rechecks it
  let stopped = false
  // one message for both stop paths — the terminal transition and a save that arrives after it
  const stoppedError = () => new Error('hidden ingress stopped: reload to recover')
  let generationSeq = 0

  // the LATEST receipt per document: either the record as received, or the fact of its removal.
  // one map rather than a map plus a removed-set — the two could disagree, and only the map was
  // ever released, so removed ids accumulated for the page lifetime and a document that was
  // removed and later recreated stayed invisible to survivor selection forever.
  // each receipt carries a token; a release only takes effect if it is still the latest, so an
  // older application settling cannot discard a newer receipt that a pending create still needs
  // `pending` marks a change the listener has RECEIVED but not yet decrypted. it exists only to
  // move the target stamp: a document being decoded right now is a document that may be about to
  // change, and a write that was built before it arrived must not issue. it is deliberately
  // INVISIBLE to canonical resolution — nothing is known about it yet, so treating it as a record
  // or as a removal would both be wrong
  // `pending` marks a delivery the listener has received but not yet decoded. it is a BARRIER, not
  // a marker for comparison: a stamp read before and after an encryption cannot see a change that
  // was already in flight when the build started, and that stalled-decrypt window is where a stale
  // full-state write got out. it is a plain flag deliberately — an awaitable promise per entry
  // strands its waiter as soon as a second callback for the same id replaces the slot
  type Receipt = { token: number; wrapper?: HiddenWrapper; pending?: boolean }
  const receipts = new Map<string, Receipt>()
  let receiptSeq = 0

  // adopts `found` under `pending`: REBASES the projection from a clone of the immutable local
  // intent when this name owes one, merges the found state underneath, and publishes the exact
  // result to the owner. rebasing here — at selection time, not at the next write attempt — is
  // what makes an invalidate-then-readopt discard the stale merge: defaultsDeep never overwrites a
  // filled-in key, so merging into an old projection would keep the replaced document's values
  function mergeAdopted(pending: HiddenWrapper, found: HiddenWrapper): undefined {
    const op = owed.get(pending.name)
    if (op) pending.item = cloneState(op.localIntent)
    deps.adopt(pending, found)
    deps.syncOwner(pending.name, cloneState(pending.item)) // a CLONE: no adapter may alias the projection
    return undefined
  }

  // true while `generation` is still the record the name owes
  const currentOwed = (name: string, generation: number) =>
    owed.get(name)?.generation == generation ? owed.get(name) : undefined

  // enqueue work for the name. the rejection arm of `.then(task, task)` is LOAD-BEARING: since
  // applyRemote publishes its raw operation result, a predecessor on this chain can be a REJECTED
  // remote Apply — and an acknowledgement settlement really can queue behind one. persistOwed
  // still handles its own errors; this is about the predecessor, not the task.
  // saving state is NOT mirrored here: it is DERIVED per name (see isSaving), because a wrapper
  // can be replaced, renamed or removed while its write is still owed
  function enqueue(name: string, task: () => Promise<void>) {
    const next = (chains.get(name) ?? Promise.resolve()).then(task, task)
    chains.set(name, next)
    next
      .catch(() => {}) // failures settle inside tasks; the chain itself must never be unhandled
      .then(() => {
        if (chains.get(name) === next) chains.delete(name)
      })
    return next
  }

  // the EFFECTIVE view of a name's records: live `byId` entries overlaid with the latest receipt
  // per document, with removal receipts taken out. every path uses it — update, create and
  // adoption — because a record that has been RECEIVED but whose application is still queued is
  // just as real as an applied one, and ignoring it is how a write lands on a document that is
  // about to stop being canonical, or how a create duplicates a record already in hand
  function effectiveRecords(name: string): HiddenWrapper[] {
    const index = deps.index()
    const byId = new Map<string, HiddenWrapper>()
    for (const w of index.byId.values()) if (w.name == name) byId.set(w.id, w)
    for (const [id, receipt] of receipts) {
      if (receipt.pending) continue // received, not yet decoded: says nothing about the record yet
      if (!receipt.wrapper)
        byId.delete(id) // its removal was received
      else if (receipt.wrapper.name == name)
        byId.set(id, receipt.wrapper) // receipts REPLACE
      else byId.delete(id) // received under a different name (a rename): no longer ours
    }
    return [...byId.values()].filter(w => !isQuarantined(index, w.id))
  }

  // the record that holds the name right now: the eligible minimum id, or a create in flight
  function canonicalHolder(name: string): HiddenWrapper | undefined {
    let best: HiddenWrapper | undefined
    for (const w of effectiveRecords(name)) {
      if (w.pending_create || w.adopt_id) return w // a create for this name owns it
      if (!best || compareIds(w.id, best.id) < 0) best = w
    }
    return best
  }

  // THE COORDINATOR'S GLOBAL GATE (see the ingress coordinator design): any open, ready or
  // running delivery anywhere makes writers `pending`; any unhealed block makes them `blocked`.
  // v1 is deliberately GLOBAL rather than per-name — an aborted ready slot never starts mutating
  // state, so it can never capture the receipt-order old name a per-name block would have to
  // retain, and briefly stalling unrelated names is cheaper than a second reservation protocol
  const gateWritable = () => deps.gate() == 'writable'

  // retained under their old names so the refuse-and-requeue call sites read unchanged: both now
  // ask the one gate. a fresh create could never rule out that an undecoded delivery is a
  // same-name record, and an update could never rule out that one changes its target
  const hasPendingReceipts = () => !gateWritable()
  const isPending = (_id: string) => !gateWritable()


  // THE NAME-OWNED WAKE: at most one live subscription per name, REUSED across supersession —
  // `Owed` already represents the latest intent for the name, so a parked waiter serves whatever
  // the name owes when it fires. only stop cancels one. reporting is separately GENERATION-scoped
  // (see reportBlocked and Owed.reportedBlocked): the physical wait and the user-visible outcome
  // have different owners, and conflating them is what made supersession drop work entirely
  const wakes = new Map<string, { cancel(): void }>()
  function cancelWake(name: string) {
    wakes.get(name)?.cancel()
    wakes.delete(name)
  }
  // waits for a WRITABLE gate before any secret acquisition, target resolution, wrapper creation,
  // owner publication or encryption — the design's "wait until gate() is writable" step. returns
  // false when this generation no longer owns the name (superseded, stopped, or blocked).
  // `blocked` is a real outcome, not a retry: it is delivered by whenActionable precisely so the
  // writer can report it once and then wait for HEALING on whenWritable, rather than hot-polling
  // a state only a later successful delivery can clear
  async function awaitWritable(name: string): Promise<boolean> {
    for (;;) {
      // NAME-SCOPED, not generation-scoped: the intent belongs to the name, so a save that
      // supersedes while this is parked is served by this same wake — persistOwed re-reads the
      // current generation when it runs. scoping it to a generation meant a supersession had to
      // cancel and re-arm, and the "already queued" shortcut then dropped the work entirely
      if (stopped || !owed.has(name)) return false
      const g = deps.gate()
      if (g == 'writable') return true
      cancelWake(name)
      // blocked waits ONLY for writable: whenActionable would resolve immediately on the same
      // blocked level and spin. pending waits on whenActionable so a block that appears while
      // waiting is reported rather than silently waited through
      const sub: { promise: Promise<unknown>; cancel(): void } =
        g == 'blocked' ? deps.whenWritable() : deps.whenActionable()
      // no cancellation race any more: it existed ONLY so a cancelled park could reach its finally
      // and settle the wrapper placeholder. isSaving() is derived, so a cancelled schedule has
      // nothing to clean up and simply never resumes — which is the right outcome for a page whose
      // writer is permanently stopped. the coordinator's cancel() keeps its own contract
      wakes.set(name, sub)
      if (g == 'blocked') reportBlocked(name)
      await sub.promise
      if (wakes.get(name) === sub) wakes.delete(name)
      // LOOP rather than trust the level: the wake resolved for the gate at that instant, and a
      // new delivery can open before this continuation runs
    }
  }
  // THE SCHEDULING ENTRY POINT: wait for a writable gate OFF the name chain, then take the chain.
  // this ordering is the whole point — persistOwed runs inside the chain, and a delivery's
  // application enqueues on that same chain, so a writer that waits while holding it deadlocks
  // against the very delivery that would release it
  function scheduleOwed(name: string) {
    // nothing to mark: isSaving() is DERIVED from the owed phase and the gate, so the observable
    // is already true the moment save() accepted this intent, and stays true across a refusal and
    // its requeue without a scheduler continuation having to maintain it
    void (async () => {
      if (!owed.has(name)) return
      if (!(await awaitWritable(name))) return
      // RECHECK AFTER THE AWAIT: awaitWritable can return true from an immediately fulfilled
      // wake, and stop can land in the continuation gap. without this the writer enqueues, and
      // persistOwed then prompts for a phrase for a page that can never write again
      if (stopped || !owed.has(name)) return
      void enqueue(name, () => persistOwed(name))
    })()
  }

  // ONCE PER GENERATION. the parking bounds it in the simple case, but not in two others: a
  // healing delivery whose own continuation blocks another cell brings the loop back here for the
  // SAME generation, and a superseding save that inherits a parked wake is a NEW generation that
  // must be told. the token distinguishes both; the parking alone distinguishes neither
  function reportBlocked(name: string) {
    const op = owed.get(name)
    if (!op || op.reportedBlocked) return
    op.reportedBlocked = true
    try {
      deps.notifyFailure(name, new Error(`hidden ingress blocked: '${name}' cannot be written until a later change for the affected document applies`))
    } catch (e) {
      console.error('blocked notification failed:', name, e)
    }
  }

  // a value that CHANGES if a document is removed, renamed, replaced under the same id, or has a
  // new delivery outstanding. an ADOPTION target is deliberately absent from the index until
  // finalization, so "is it still the record we would choose" can never answer this; the payload
  // was built from what we believed the document to be, and that belief is what must still hold.
  // a receipt (newest delivery) wins; otherwise the live object, whose IDENTITY changes when an
  // application replaces it. a spurious mismatch only costs one requeue; issuing wrongly does not.
  // TWO facts, captured together so a caller cannot compare one and forget the other: the
  // coordinator's per-id RECEIPT FRONTIER (advanced by every open() for this document; zero for
  // an id with no cell, and reading it never allocates one) AND the live wrapper's exact object
  // IDENTITY.
  // the WRAPPER half is PROVISIONAL and currently unpinned, pending the corpus-seam mutation
  // (the recipe and the history are in the test)
  type TargetToken = { seq: number; wrapper: unknown }
  const targetStamp = (id: string): TargetToken => ({
    seq: deps.receiptFrontier(id),
    wrapper: deps.index().byId.get(id) ?? 'absent',
  })
  const sameTarget = (a: TargetToken, b: TargetToken) => a.seq === b.seq && a.wrapper === b.wrapper



  // the minimum-id record a create could adopt instead of creating alongside it
  function findSurvivor(wrapper: HiddenWrapper): HiddenWrapper | undefined {
    let survivor: HiddenWrapper | undefined
    for (const w of effectiveRecords(wrapper.name)) {
      if (w === wrapper || w.pending_create || w.adopt_id) continue
      if (!survivor || compareIds(w.id, survivor.id) < 0) survivor = w
    }
    return survivor
  }

  // issues one write for `generation`, or REFUSES if that generation has been superseded. the
  // refusal is the point: gating only the detached callbacks left stale work still calling
  // createDoc/updateDoc and still finalizing index transitions, so an obsolete create could land
  // after a newer update. returns whether the write was issued, so callers finalize only what
  // actually went out
  function issueWrite(name: string, generation: number, id: string, data: Record<string, any>, create: boolean) {
    const op = currentOwed(name, generation)
    if (!op) return false // superseded before issue: no write, no finalization
    op.phase = 'issued' // ... which is where isSaving() stops being true (see its derivation)
    // THE OWN-UNACKNOWLEDGED-CREATE MARKER, retained until this SDK promise settles and
    // INDEPENDENTLY of any later owed generation: the server has not published this document yet,
    // so a complete read legitimately omits it, and a confirmation must not remove it from that
    // stale negative. wrapper-exact, so a fresh same-id observation or a same-id rename cannot be
    // mistaken for it
    const issuedMarker: Marker | undefined = create
      ? { id, wrapper: deps.index().byId.get(id) ?? op, token: ++markerSeq }
      : undefined
    if (issuedMarker) marker = issuedMarker
    const write = create ? deps.createDoc(id, data) : deps.updateDoc(id, data)
    // COMPARE-AND-SET on the token: a newer create may already have replaced the marker, and this
    // settlement must not clear that one. it never reinserts or finalizes the old wrapper either
    const clearMarker = () => {
      if (issuedMarker && marker && marker.token === issuedMarker.token) marker = undefined
    }
    write.then(
      () => {
        clearMarker()
        if (!currentOwed(name, generation)) return // superseded: a newer generation owns the name
        // settle ON THE NAME'S CHAIN, behind transitions already received. reconciliation reads
        // the APPLIED index, so settling straight from the acknowledgement could put the owner
        // back in step with state that a queued delivery was about to replace — and then clear
        // `owes()`, letting that delivery through as if nothing were outstanding
        void enqueue(name, async () => {
          if (!currentOwed(name, generation)) return
          owed.delete(name) // settled, and still the latest: the write IS committed
          // STOP WINS over the echo. reconciling publishes owner state derived from an index that
          // has stopped tracking the server, so a stop that landed while this write was in flight
          // must clear the record and stop there — even if an applied echo was already recorded
          if (stopped) return
          // ... but only reconcile from an index that actually took this write's echo. when the
          // application FAILED the index may still hold the pre-write state, and the owner already
          // holds what we wrote — reconciling would roll it back, with no later echo guaranteed.
          // authority revocation and the dirty marking drive the repair instead
          if (deps.echoApplied(id)) deps.reconcileOwner(name)
          else console.warn(`hidden echo for '${name}' (${id}) did not apply; owner left as written`)
        })
      },
      e => {
        clearMarker()
        const current = currentOwed(name, generation)
        if (!current) return // superseded: this outcome no longer matters
        if (!isNotFound(e)) {
          // a settled permission/validation error, not offline retry (firestore keeps those
          // pending). leave the record IDLE and observable rather than clearing it
          current.phase = 'failed'
          console.error(`hidden write for '${name}' failed:`, e)
          return void deps.notifyFailure(name, e)
        }
        if (stopped) return // not-found recovery NEVER starts after stop
        deps.invalidateAuthority(`hidden write target ${id} not found`)
        const index = deps.index()
        if (index.byId.get(id)) removeHidden(index, id) // it does not exist server-side
        current.phase = 'queued'
        scheduleOwed(name) // the ONE gate-aware entry: taking the chain first only to find the
        // gate shut and schedule again is the polling this replaced
      },
    )
    return true
  }

  // ONE attempt for `generation`: resolve the target, build, recheck, issue. returns false when the
  // target MOVED while building, and the caller requeues. an inner loop is worse: it re-encrypts
  // while holding the chain, starving the receipts it waits for, and its "each retarget takes a
  // lower id" termination argument is false — a removal or rename can retarget upward or to
  // absence. safety rests on receipts eventually going quiet, NOT on the requeue being ordered
  // behind the application that moved the target, which it is not
  async function attemptWrite(name: string, generation: number): Promise<boolean> {
    const current = () => currentOwed(name, generation)
    if (stopped) return true // ingress is terminal: no new work, and the intent stays owed
    if (!current()) return true // superseded: nothing owed by this generation any more
    // THE GATE, BEFORE ANYTHING ELSE. acquireSecret() can prompt, and the gate can close while it
    // is pending — so this ran with a stale writable answer and got as far as installing a
    // synthetic pending_create wrapper in byId/byName and publishing owner state before
    // attemptCreate asked the gate at all. every check below is a REFUSAL, but this one has to
    // precede the clone, the target resolution, the wrapper mutation and the publication, not
    // follow them
    if (!gateWritable()) return false
    // PER-ATTEMPT WORKING COPY of the immutable baseline: merges below must not touch it
    const state = cloneState(current()!.localIntent)
    let holder = canonicalHolder(name)
    if (!holder) {
      // nothing holds the name (never created, or removed while we were building): re-enter the
      // confirmed-create resolution rather than writing to whatever we had before
      holder = { name, item: state, id: deps.newTempId(), pending_create: true, adopt_id: null }
      const index = deps.index()
      index.byId.set(holder.id, holder)
      index.byName.set(name, holder)
    }
    if (holder.pending_create || holder.adopt_id) {
      // a VALID adoption keeps its merged projection: the merge may have already run while
      // acquireSecret was pending (fixed-page phrase validation registers before publishing the
      // secret), and resetting from the baseline here erased it — attemptCreate then skipped the
      // merge (adopt_id set), encrypted the reset baseline, and finalization copied it back over
      // the owner (round 35). only a FRESH create rebuilds from the unmerged baseline, and it
      // PUBLISHES that baseline to the owner too: leaving stale adopted defaults visible would let
      // a later real save legitimize them as new local intent — resurrecting state whose document
      // is gone, which is what adopter invalidation exists to prevent
      if (!holder.adopt_id) {
        holder.item = state
        deps.syncOwner(name, cloneState(state))
      }
      return await attemptCreate(holder, generation)
    }
    // check BEFORE the expensive work as well as after it: a refusal discovered only at the end
    // costs a secret acquisition and a full encryption per retry, and a slow decode turns that into
    // repeated builds. (this is still polling — see the requeue below — but cheap polling)
    if (isPending(holder.id)) return false
    // build the payload for a target WITHOUT mutating it unless it is live in the index: a record
    // that has only been received is about to be applied, and writing our state into that object
    // would make its own application carry our change instead of what arrived
    const merged = { ...holder, item: { ...(holder.item ?? {}) } }
    // deps.adopt DIRECTLY, not mergeAdopted: the merge must land in `state` itself (adopt mutates
    // its first argument's item in place), because the payload below is built from `state`.
    // mergeAdopted's rebase would swap in a fresh object and the merge would be discarded with the
    // temp wrapper. the rebase is moot here anyway — `state` IS a fresh clone of the baseline —
    // and the owner publication follows explicitly
    deps.adopt({ ...merged, item: state }, merged) // may hold fields the owner never saw
    deps.syncOwner(name, cloneState(state))
    if (deps.index().byId.get(holder.id) === holder) holder.item = state // live: keep in step
    const stamp = targetStamp(holder.id) // what we believe the target is, before we build for it
    const data = await deps.encryptState(payload({ ...holder, item: state }))
    if (!current()) return true
    // REFUSE, do not await: awaiting the entry promise deadlocks. a valid hidden-to-visible
    // delivery for this document awaits applyRemote on THIS name's chain, which this write owns —
    // the writer would wait for the listener while the listener waits for the writer. requeueing
    // releases the chain, lets that application run, and fails closed in the meantime
    if (isPending(holder.id)) return false
    // moved, or CHANGED under us — including a change that has entered the listener and is still
    // decrypting, which the stamp sees and canonical resolution deliberately does not
    if (canonicalHolder(name) !== holder || !sameTarget(targetStamp(holder.id), stamp)) return false
    if (stopped) return true // rechecked in the no-await token: a write already encrypting when
    // the listener died must not issue afterwards
    issueWrite(name, generation, holder.id, data, false)
    return true
  }

  // the create/adoption half of the SAME resolve-build-recheck shape. every branch ends at one
  // recheck immediately before issuing: the target it encrypted for must still be the target it
  // would choose now, or the attempt is abandoned and requeued
  async function attemptCreate(wrapper: HiddenWrapper, generation: number): Promise<boolean> {
    const name = wrapper.name
    const current = () => currentOwed(name, generation)
    try {
      // as in the ordinary path: refuse before confirming the index or allocating an id, not after
      if (wrapper.adopt_id ? isPending(wrapper.adopt_id) : hasPendingReceipts()) return false
      if (!wrapper.adopt_id) {
        // CONFIRMATION, updates included: one attempt never performs both a create-only index
        // confirmation and an update. the controller commits the name slice synchronously inside
        // the corpus turn through this callback, so the whole affected closure applies at once
        const outcome = await deps.confirmTarget(name, {
          captureReadMarker: () => marker,
          commit: (answer, readMarker) => commitTargetSlice(name, answer, readMarker),
        })
        if (!current()) return true // superseded: the newer generation redoes this
        // INCONCLUSIVE means a gate check refused with zero mutation: release the chain and let
        // the delivery that made the gate non-writable apply, then retry
        if (outcome == 'inconclusive') return false
        // THE SAME CONTINUATION RULE as after acquireSecret: confirmation is an await, so a
        // delivery can open or ingress can stop across it. checking only generation ownership let
        // this go on to select an adopter, publish to the owner through mergeAdopted, and start a
        // fresh encryption behind a shut gate or after stop
        if (stopped) return true
        if (!gateWritable()) return false
        // a same-name record can already be known locally even when confirmation was a no-op
        // (an authoritative index with a retained duplicate, or a remote arrival mid-create):
        // adopt the minimum-id survivor instead of creating alongside it
        const survivor = findSurvivor(wrapper)
        if (survivor) {
          wrapper.adopt_id = survivor.id
          mergeAdopted(wrapper, survivor) // rebases from the baseline and publishes to the owner
        }
      }
      // NOTE: both branches below finalize once the write is ISSUED to the SDK, not once the
      // server acknowledges. holding the chain for the acknowledgement is what lost every offline
      // save after the first: the create's promise stays pending until reconnect, so a later save
      // waited behind it and died with the tab while only the create survived in IndexedDB.
      // rejection recovery stays attached but detached from the chain
      if (wrapper.adopt_id) {
        const adoptId = wrapper.adopt_id
        // the SELECTION is the pointer AND the derived projection object: a same-id invalidation
        // followed by immediate same-id re-adoption restores the pointer string, and the target —
        // absent from byId until finalization — keeps stamp `absent` on both sides, so neither
        // notices. mergeAdopted rebases by assigning a FRESH object, so projection identity is the
        // selection version (round 36): a re-adoption while we encrypt changes it, and the stale
        // attempt must not issue its already-encrypted old payload against the newer selection
        const projection = wrapper.item
        const stamp = targetStamp(adoptId) // what we believe the target is, before we build for it
        const data = await deps.encryptState(payload(wrapper)) // merged state (see deps.adopt)
        if (!current()) return true
        if (isPending(adoptId)) return false // refuse, do not await (see the ordinary path)
        // a NEWER selection (pointer moved or projection rebased): refuse and clear NOTHING — the
        // selection belongs to whoever made it, and the retry re-merges from the current state
        if (wrapper.adopt_id !== adoptId || wrapper.item !== projection) return false
        // our own selection is stale against the WORLD: a lower id arriving makes this target
        // noncanonical, and a change to the target itself (removed, renamed, replaced under the
        // same id) makes the payload we just built wrong for it. clear our selection and re-choose
        const better = findSurvivor(wrapper)
        if ((better && compareIds(better.id, adoptId) < 0) || !sameTarget(targetStamp(adoptId), stamp)) {
          wrapper.adopt_id = null // ours, still current — see the identity check above
          return false
        }
        if (stopped) return true // see the ordinary path's no-await recheck
        if (issueWrite(name, generation, adoptId, data, false)) finalizeAdoption(deps.index(), wrapper)
        return true
      }
      const id = deps.newDocId()
      const data = await deps.encryptState(payload(wrapper))
      if (!current()) return true

      // a same-name record RECEIVED during that encryption is a record we already know about, and
      // creating alongside it is a duplicate we cause ourselves. (one another writer commits after
      // this point is a genuine race no client read closes without server-side uniqueness.)
      // a change still DECODING could also be one, and nothing is known about it yet — so a fresh
      // create waits rather than risk the duplicate. deliberately broad: it can requeue for a
      // change that turns out to be unrelated, and a duplicate document is the worse outcome
      // a fresh create refuses while ANY delivery is undecoded: their names are unknown, so any of
      // them could be the same-name record that would make this create a duplicate
      if (findSurvivor(wrapper) || hasPendingReceipts()) return false // requeue: the retry adopts it
      if (stopped) return true // see the ordinary path's no-await recheck
      if (issueWrite(name, generation, id, data, true)) finalizeCreate(deps.index(), wrapper, id)
      return true
    } catch (e) {
      // a STALE generation must not mutate the index on its way out either: the current one owns
      // the wrapper now, and finalizing or removing it here is the same class of stale world
      // mutation the generation checks above exist to prevent. it returns ABANDONMENT rather than
      // rethrowing, so the outer catch does not log a failure for work already known to be obsolete
      if (!current()) return true
      // AND ON THE WAY OUT. a confirmation or encryption held across stop can reject afterwards,
      // and finalizing an adoption or removing the pending wrapper here is exactly the stale
      // world mutation the generation check above prevents — stop retained and reported this
      // generation already, so its late continuation mutates nothing and reports nothing
      if (stopped) return true
      if (wrapper.adopt_id) {
        // the document exists: settle onto it so the next save UPDATES it — deleting the
        // wrapper would send the next save down the create path and duplicate it
        finalizeAdoption(deps.index(), wrapper)
      } else {
        // a genuinely failed fresh create: remove the wrapper (promoting any retained
        // same-name duplicate) so the next save retries cleanly
        removeHidden(deps.index(), wrapper.id)
      }
      throw e // persistOwed marks the record failed (and therefore retryable)
    }
  }

  // THE ONE COMMIT ALGORITHM, run synchronously inside the corpus turn (see the confirmTarget
  // dep). the whole affected closure applies in ONE JavaScript turn
  function commitTargetSlice(name: string, answer: Map<string, ClassifiedRow>, readMarker: Marker | undefined): CommitResult {
    // STOP, checked HERE and not only after confirmTarget returns: the commit runs INSIDE the
    // corpus turn, so by the time the controller could recheck, the mutation would already have
    // happened. production's corpus cancels a stopped run before this is reached; this is the
    // controller's own invariant, and it must not depend on the adapter enforcing it
    if (stopped) return { kind: 'inconclusive' }
    const index = deps.index()
    // the NONPENDING, SERVER-BACKED slice: a pending create or adoption target is preserved by
    // this controller, never judged by the read (an adoption target is absent from byId until
    // finalization, so slice removal could not touch it anyway)
    const local = [...index.byId.values()]
      .filter(w => w.name == name && !w.pending_create && !w.adopt_id)
      .map(w => ({ id: w.id, name: w.name, wrapper: w as unknown }))
    const plan = planTargetSlice({ name, local, answer, marker: readMarker })
    // THE PRECOMMIT COMPARE-AND-SET. if preservation used the proof and it settled while the
    // answer was in flight, the whole result is inconclusive with ZERO effects — even when a
    // fresh lower row would eventually have been selected
    if (plan.preservedMarker && !(marker && marker === plan.preservedMarker && marker.token === plan.preservedMarker.token))
      return { kind: 'inconclusive' }
    // (3) destructive rows once, in canonical id order
    for (const id of plan.remove) removeHidden(index, id)
    // (4) clear a pending wrapper's stale adopt_id when it differs from the canonical fresh target
    const pending = index.byName.get(name)
    const canonicalFresh = plan.register[0]?.id
    if (pending?.adopt_id && pending.adopt_id !== canonicalFresh) pending.adopt_id = null
    // (5) with no eligible fresh target the pending projection resets to its immutable baseline
    // ONCE; otherwise the adapter registers each fresh row, and registerHidden's first eligible
    // registration performs the single rebase/adoption/publication
    if (!plan.register.length) {
      const op = owed.get(name)
      if (op && pending) {
        pending.item = cloneState(op.localIntent)
        deps.syncOwner(name, cloneState(op.localIntent))
      }
    } else {
      for (const row of plan.register) deps.registerTargetRow(row.wrapper as HiddenWrapper, mergeAdopted)
    }
    return { kind: 'committed', requiredMarker: plan.requiredMarker }
  }

  // persists whatever the name currently owes, on whichever record holds it
  async function persistOwed(name: string) {
    const op = owed.get(name)
    if (!op || op.phase == 'building') return
    // AND AGAIN AT ENTRY: stop can land after the schedule's check but before this turn, which
    // was already sitting in the name chain queue. the two checks are not redundant — they close
    // different gaps, and the one below (post-acquisition, in attemptWrite) covers work already
    // running
    if (stopped) return
    op.phase = 'building'
    const generation = op.generation
    const current = () => currentOwed(name, generation)
    try {
      // the gate may have closed while this task sat in the chain queue. RECHECK, but never wait
      // here: persistOwed runs ON the name chain, and the delivery that would reopen the gate
      // applies on that same chain — awaiting inside it deadlocks (the reason the target checks
      // below refuse rather than await). rescheduling waits OFF the chain instead
      if (deps.gate() != 'writable') {
        const now = current()
        if (!now) return
        now.phase = 'queued'
        scheduleOwed(name)
        return
      }
      // the phrase is acquired BEFORE any payload is resolved, and single-flighted by the
      // dependency: encryptState must not prompt, because a prompt between the last resolution
      // and the write could register a lower-id record
      await deps.acquireSecret()
      if (!current()) return
      if (await attemptWrite(name, generation)) return
      // the target moved: requeue rather than retry here, which would hold the chain and
      // re-encrypt against a view that cannot change. this does NOT order the retry behind the
      // remote application — that may be on a different name chain. no yield is needed any more:
      // awaitWritable at the top of the retry blocks on a real coordinator transition, so a
      // requeue can no longer spin against an unchanged view
      const now = current()
      if (!now) return
      now.phase = 'queued'
      scheduleOwed(name)
    } catch (e) {
      // STOP FIRST. acquireSecret() and ordinary-update encryption reject into THIS catch, not
      // attemptCreate's — so a held prompt or encryption that rejects after stop would change the
      // phase and report a SECOND failure for a generation stop already reported. there is no
      // useful late outcome for a page whose ingress is terminal; the intent stays owed
      if (stopped) return
      const now = current()
      if (now) now.phase = 'failed' // retryable: a later save schedules it again
      // an intentional phrase cancellation is an expected outcome: neither reported to the user
      // nor logged as an error. everything else is a terminal BUILD failure (secret, confirmation,
      // encryption) and is just as invisible as a terminal WRITE failure was — owes() stays true,
      // isSaving() goes false with the phase, and owner notifications stay suppressed
      if (isCancellation(e)) return
      console.error(`persisting hidden item '${name}' failed:`, e)
      if (now) deps.notifyFailure(name, e)
    }
  }

  return {
    // THE ONE WRITER STOP TRANSITION, in TWO SYNCHRONOUS PHASES so a throwing notification hook
    // cannot leave later generations half-stopped and a reentrant save cannot observe a partial
    // state. phase 1 sets stopped state, cancels every NAME-owned wake, updates each
    // report-once token, and CAPTURES the notifications; phase 2 invokes them under individual
    // guards — nothing escapes stop().
    // effects are qualified BY GENERATION: an unissued generation reports
    // once and RETAINS its owed intent (the change is not lost, it simply cannot be written by
    // this page); an issued generation stays owned by its SDK result and is never prematurely
    // cleared or reported as a stopped build
    stop(): undefined {
      if (stopped) return undefined
      stopped = true
      // every name-owned wake, first: one resolving after stop would re-enter
      // persistOwed for a page that can never write again
      for (const name of [...wakes.keys()]) cancelWake(name)
      const notifications: Array<[string, unknown]> = []
      for (const [name, op] of owed) {
        // an issued generation is owned by its SDK result: it is not reported as a stopped build,
        // and isSaving() already answers false for it by derivation
        if (op.phase == 'issued') continue
        if (op.reportedStop) continue
        op.reportedStop = true
        notifications.push([name, stoppedError()])
      }
      for (const [name, error] of notifications) {
        try {
          deps.notifyFailure(name, error)
        } catch (e) {
          console.error('stop notification failed:', name, e)
        }
      }
      return undefined
    },

    // the adoption merge for REGISTRATION paths (fixed-page phrase validation, post-init
    // arrivals): rebases from this name's immutable local intent when one is owed, merges, and
    // publishes to the owner — one contract for every path that adopts (round 35)
    mergeAdopted,

    // replaces (or creates) the hidden item for the name with the given state. the wrapper's
    // state is updated immediately; the document payload is serialized when the queued task
    // EXECUTES, so it always carries the latest full state — including adoption merges and
    // later save() calls — and a failed earlier write is superseded rather than retried
    save(name: string, item: any): boolean {
      // a READ-ONLY save never serializes: it mutates the index and persists nothing, so a plain
      // in-memory store holding a cycle or BigInt must not be rejected for a write that will
      // never happen (round 38)
      const readOnly = deps.readonly()
      // NORMALIZE FIRST for writable saves, before any index or owed mutation: cloneState freezes
      // the JSON representation that will be persisted, and state JSON cannot serialize (a
      // BigInt, a throwing toJSON) must fail through the same user-visible hook as a settled
      // write failure — not synchronously out of save() after the index was already mutated
      // (round 37). the rejection creates NO owed generation; an older valid generation already
      // owed stays owed and still lands. (owes() DOES keep suppressing owner synchronization and
      // remote-change notification for that name meanwhile — index application is what is never
      // skipped — which is exactly why the rollback in the catch below prefers the owed
      // localIntent.) the CONTROLLER settles the rejection — it rolls the owner back itself, via
      // syncOwner — and returns false only so the caller stops its post-acceptance effects
      // (listeners, invalidation) for a value that was never accepted
      let intent: any
      if (!readOnly)
        try {
          intent = cloneState(item)
        } catch (e) {
          console.error(`hidden save for '${name}' rejected: state is not JSON-serializable:`, e)
          // ROLL BACK THE OWNER HERE, where both inputs live (round 39). the last accepted local
          // INTENT is what must be restored, and that is NOT always the applied index: while an
          // older valid generation is owed, owes() deliberately suppresses owner synchronization,
          // so the applied index may hold a remote value the owner never saw — restoring THAT
          // would discard the accepted owed intent, and the local-change callback running after
          // the replacement could save it and supersede the owed work. the owed localIntent wins
          // (already normalized, so its clone cannot throw); the applied index is the fallback —
          // and READ-ONLY mode indexes raw non-JSON state, so if the page later became writable
          // that fallback itself may not clone: publish {} then, notify with the ORIGINAL
          // rejection, and never let the replacement error escape save() (round 40)
          const op = owed.get(name)
          let baseline: any = {}
          if (op) baseline = cloneState(op.localIntent)
          else
            try {
              baseline = cloneState(deps.index().byName.get(name)?.item ?? {})
            } catch {
              baseline = {}
            }
          deps.syncOwner(name, baseline)
          deps.notifyFailure(name, e)
          return false
        }
      // record what the name now OWES and let one routine persist it. the intent belongs to the
      // NAME: it is not attached to a wrapper (a delivery can replace or remove that record and
      // the user's change must still land), and it is re-resolved after every await.
      // the claim is made against the APPLIED index: a record that has only been RECEIVED is not
      // in byName, and treating it as the holder here would leave the name with no local entry
      // at all. choosing the write TARGET is a different question, answered at persist time by
      // the receipt-overlaid resolver
      const index = deps.index()
      // accept the byName alias only while it is still the LIVE record for that id and name.
      // a stale alias (kept deliberately for read-only display) would otherwise take the claim
      // for an object no longer in the live index
      const claimed = index.byName.get(name)
      let holder = claimed && index.byId.get(claimed.id) === claimed && claimed.name == name ? claimed : undefined
      if (!holder) {
        // claim the name SYNCHRONOUSLY: readers of the index (and saving_global_store) must see
        // the store the moment it is saved, not when its task happens to run
        holder = {
          name,
          item,
          id: deps.newTempId(),
          pending_create: true,
          adopt_id: null,
        }
        index.byId.set(holder.id, holder)
        index.byName.set(name, holder)
      }
      holder.item = item
      if (readOnly) return true // the index is updated; nothing is persisted
      const op = owed.get(name)
      if (op) {
        // CLONE: the baseline must stay immutable under later caller mutations and adoption merges
        op.localIntent = intent // supersede: this is what the name owes now
        op.generation = ++generationSeq
        op.reportedStop = false // a new generation reports its own outcome (see Owed)
        op.reportedBlocked = false
        // a generation that inherits a PARKED wake would never reach reportBlocked, because the
        // waiter does not resume until the gate opens. report for it here instead — the wake
        // itself stays name-scoped (one physical waiter), the REPORTING is generation-scoped
        if (deps.gate() == 'blocked' && wakes.has(name)) reportBlocked(name)
        // a record that is QUEUED already has a task coming. one that is building, issued or
        // failed does not — and treating those as "already queued" is how failed work sat idle
        // forever, and how a save after issuance was never written.
        // NOT while stopped: this is a SCHEDULING shortcut, and after stop nothing was enqueued,
        // so "queued" no longer implies a task is coming. every post-stop save must fall through
        // to take — and report — its own generation's stopped outcome
        if (!stopped && op.phase == 'queued') return true
        op.phase = 'queued'
      } else owed.set(name, { generation: ++generationSeq, localIntent: intent, phase: 'queued' })
      // STOPPED: the intent is RETAINED (owes() stays true, and a reload recovers it) but nothing
      // is scheduled. enqueueing would take a chain turn and persistOwed would await
      // acquireSecret() — prompting for a phrase, no less — before attemptWrite finally noticed
      // stop and refused. the outcome is knowable synchronously, so take it synchronously, and
      // report exactly once for THIS generation (see Owed)
      if (stopped) {
        const op = owed.get(name)!
        if (!op.reportedStop) {
          op.reportedStop = true
          try {
            deps.notifyFailure(name, stoppedError())
          } catch (e) {
            console.error('stop notification failed:', name, e)
          }
        }
        return true
      }
      scheduleOwed(name)
      return true
    },

    // true when this name still owes the server a local change. used for NOTIFICATION, never to
    // skip application: a delivery still lands in the index, but the owner's copy and its
    // "changed remotely" callback must not be driven backwards while a newer local generation is
    // still queued — a handler that reacts by saving would otherwise persist the older state
    owes(name: string) {
      return owed.has(name)
    },

    // whether this NAME has a change being built or waiting to be built. DERIVED from the state
    // that already owns the answer rather than tracked separately: a parallel set diverged three
    // ways (a healed block never re-added the name, a re-block shared the report-once early
    // return, and not-found recovery enqueued without it), and every one of those was a lie to
    // _Item.saving_global_store. queued is saving while the gate can still progress; building is
    // saving; issued and failed are not; stop wins over all of them
    isSaving(name: string) {
      const phase = owed.get(name)?.phase
      return !stopped && (phase == 'building' || (phase == 'queued' && deps.gate() != 'blocked'))
    },

    // applies a remote transition (add/modify/remove) for the name ON ITS CHAIN, so it can
    // never interleave with an in-flight write for the same name; with no queued work it runs
    // immediately. returns a promise that settles when the transition has applied — the caller
    // aggregates these before settling that revision's authority. pass the name when known; a removal
    // of an id not in the index has no affected name, so it starts on the NEXT MICROTASK with
    // nothing to wait for (the design's asynchronous direct path) rather than synchronously
    applyRemote(
      names: (string | undefined)[] | string | undefined,
      apply: () => void | Promise<void>
    ): Promise<void> {
      // ONE OPERATION PUBLISHED TO EVERY AFFECTED TAIL, in a single synchronous turn. three
      // things were wrong with the previous shape:
      //  - `.filter(chains.has)` dropped every affected name with no in-flight write, so a write
      //    STARTING for that name during this application was not ordered behind it — which is
      //    the entire guarantee multi-name acquisition exists to provide;
      //  - acquisition was RECURSIVE, so the second name was not reserved until the first chain
      //    reached it, and a writer for the second could slip in between; and
      //  - an async `apply` was typed and treated as void, so the chain did not await the work.
      // reserving every tail at once also removes the deadlock the canonical sort defended
      // against: nothing can be half-acquired, so there is no acquisition order to agree on
      const affected = [...new Set((Array.isArray(names) ? names : [names]).filter(Boolean) as string[])]
      const predecessors = affected.map(name => chains.get(name)).filter(Boolean) as Promise<void>[]
      // ONE promise, published to every affected tail BEFORE apply() can run. the previous version
      // had a synchronous no-predecessor branch that invoked apply() first and published after,
      // which reverses the whole property: a reentrant same-name operation saw no predecessor,
      // published its own tail, and had it overwritten when the outer call resumed.
      // no cardinality branches: with no predecessors the `then` still runs a microtask later,
      // after publication; with no affected name it is the design's asynchronous direct path; and
      // it assimilates an async apply and turns a synchronous throw into a rejection for free
      const result = Promise.allSettled(predecessors).then(() => apply())
      for (const name of affected) chains.set(name, result)
      // publish `result` ITSELF, not a fulfilled mirror. the mirror was not load-bearing — the
      // inbound allSettled already consumes predecessor rejection — and it HID the rejected-
      // predecessor branch from any schedule that tried to exercise it
      const cleanup = () => {
        for (const name of affected) if (chains.get(name) === result) chains.delete(name)
      }
      void result.then(cleanup, cleanup) // two-way: no unhandled rejection from the tail copy
      return result // the REAL result: the caller's handle records blocked on rejection
    },

    // releases a receipt once its application has settled — only if it is still the latest, so a
    // newer receipt (e.g. a rename that a pending create must see) is never discarded by an
    // older application finishing. the inbox exists only so a create/adopt decision can see a
    // record whose application is still queued; keeping entries for the page lifetime let a
    // QUARANTINED duplicate be re-adopted by the next same-name create
    releaseRemote(id: string, token: number) {
      if (receipts.get(id)?.token != token) return
      receipts.delete(id)
    },

    // records what was received for a document and returns the token to release it with. a
    // removal is recorded as a receipt with no wrapper, so a later add of the same id simply
    // supersedes it
    noteRemote(wrapper: HiddenWrapper | undefined, id: string, removed: boolean) {
      const token = ++receiptSeq
      receipts.set(id, { token, wrapper: removed ? undefined : wrapper })
      return token
    },

    // records that a change for this document has ENTERED the listener, before anything is known
    // about it. production cannot call noteRemote until after decryptItem, and every controller
    // branch can finish encrypting and issue synchronously in that window — so a removal, rename
    // or same-id replacement already inside the listener left the target stamp unchanged and a
    // stale write went out. this moves the stamp at ENTRY instead, at the cost of an occasional
    // extra requeue for a change that turns out not to concern us. a requeue is safe; the write
    // was not. release it once the change has been noted properly (or has proved irrelevant)
    noteRemotePending(id: string) {
      const token = ++receiptSeq
      receipts.set(id, { token, pending: true })
      return token
    },

    // the name a document belongs to, including one being ADOPTED (whose server id is not in
    // byId until finalization): a removal of that id must serialize on the adopting name's chain
    nameForDocument(id: string) {
      const index = deps.index()
      const known = index.byId.get(id)?.name ?? receipts.get(id)?.wrapper?.name
      if (known) return known
      for (const w of index.byId.values()) if (w.adopt_id == id) return w.name
      return undefined
    },
  }
}
