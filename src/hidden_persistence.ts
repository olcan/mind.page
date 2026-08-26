// per-name persistence controller for hidden items (stage 1b of the index.svelte split;
// matrix-tested in tests/unit/hidden_persistence.spec.ts).
//
// what it does: serializes the BUILDING of writes for a name (encryption can prompt), issues them
// to firestore's queue without waiting for acknowledgement, and settles the index transitions in
// hidden.ts so the name invariant holds.
//
// what it does NOT do: order writers, identify its own echoes, or drop work that was overtaken.
// firestore delivers a document's changes in commit order and every delivery is applied; a
// queued save carries the latest INTENT for a name and resolves that name's current holder when
// it runs, so being overtaken costs nothing. there is no revision protocol, no write-identity
// tracking, and no deletion — emptying a store is an ordinary save of `{}`.
//
// NOTE: `wrapper.saving` is mirrored while a write is being built and issued, and cleared once it
// reaches the SDK's queue — not when the server acknowledges. item code observes it through
// _Item.saving_global_store, so that meaning is part of the window contract.

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
  confirmIndex: (pendingName: string) => Promise<void>
  // merges an adopted document's state under a pending wrapper's changes AND propagates the
  // merged state back to whatever owns it (e.g. the owner item's in-memory global_store): the
  // owner saves fresh full-state snapshots, so a merge it never sees is erased on its next save
  adopt: (pending: HiddenWrapper, found: HiddenWrapper) => void
  // synchronizes whatever owns a name's state (the owner item's in-memory global_store) with the
  // record that now holds it. called once when a generation SETTLES, ON THE NAME'S CHAIN: while a
  // name owes a change, deliveries deliberately do not touch the owner (they would roll it back
  // into a handler that saves), so something has to put it back in step when the change lands.
  // required: correctness depends on it, and an optional critical hook lets an adapter silently
  // reopen the invariant
  reconcileOwner: (name: string) => void
  // reports a TERMINAL write failure (a settled permission/validation error, not an offline
  // retry) to something the user can see. the record stays retryable, but `owes()` is a boolean
  // and `wrapper.saving` has already settled, so without this hook the only trace was a console
  // line while owner notifications stayed suppressed indefinitely
  notifyFailure: (name: string, error: unknown) => void
  // whether the latest hidden application for this document SUCCEEDED. the write barrier is
  // settle-only by design (an unrelated listener failure must never turn a committed firestore
  // write into a failed one), but that also swallowed the outcome of THIS write's own echo: on a
  // failed application the controller took its success path and reconciled the owner from an index
  // that may still hold the pre-write state, rolling the owner back with no later echo guaranteed
  echoApplied: (id: string) => boolean
  // revokes hidden-index authority (see settleHiddenAuthority in index.svelte): called when a
  // write proves the index stale (e.g. its target document no longer exists server-side)
  invalidateAuthority: (reason: string) => void
  newTempId: () => string
  readonly: () => boolean
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
  type Owed = { generation: number; state: any; phase: Phase }
  const owed = new Map<string, Owed>()
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
  type Receipt = { token: number; wrapper?: HiddenWrapper; pending?: boolean }
  const receipts = new Map<string, Receipt>()
  let receiptSeq = 0

  // true while `generation` is still the record the name owes
  const currentOwed = (name: string, generation: number) =>
    owed.get(name)?.generation == generation ? owed.get(name) : undefined

  // enqueue work for the name; failures settle inside each task, so the chain always continues;
  // the wrapper mirrors in-flight status via `saving`, cleared when ITS latest mirrored promise
  // settles (not when the chain drains: the name can be reused by a new wrapper whose work must
  // not keep the old wrapper's mirror alive forever)
  function enqueue(name: string, wrapper: HiddenWrapper | undefined, task: () => Promise<void>) {
    const next = (chains.get(name) ?? Promise.resolve()).then(task, task)
    chains.set(name, next)
    let mirrored: Promise<string> | undefined
    if (wrapper) {
      mirrored = next.then(() => wrapper.id) as Promise<string>
      mirrored.catch(() => {}) // observable to waiters, but never an unhandled rejection
      wrapper.saving = mirrored
    }
    next
      .catch(() => {}) // failures settle inside tasks; the chain itself must never be unhandled
      .then(() => {
        if (wrapper && wrapper.saving === mirrored) wrapper.saving = null
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

  // any change that has ENTERED the listener and is still being decoded. nothing is known about it
  // yet, so a fresh create cannot rule out that it is a same-name record
  const hasPendingReceipts = () => [...receipts.values()].some(receipt => receipt.pending)

  // a value that CHANGES if a document is removed, renamed, replaced under the same id, or has a
  // new delivery outstanding. an ADOPTION target is deliberately absent from the index until
  // finalization, so "is it still the record we would choose" can never answer this; the payload
  // was built from what we believed the document to be, and that belief is what must still hold.
  // a receipt (newest delivery) wins; otherwise the live object, whose IDENTITY changes when an
  // application replaces it. a spurious mismatch only costs one requeue — issuing wrongly does not
  function targetStamp(id: string): unknown {
    const receipt = receipts.get(id)
    if (receipt) return `receipt:${receipt.token}` // pending, present or removed: all are CHANGES
    return deps.index().byId.get(id) ?? 'absent'
  }

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
    op.phase = 'issued'
    const write = create ? deps.createDoc(id, data) : deps.updateDoc(id, data)
    write.then(
      () => {
        if (!currentOwed(name, generation)) return // superseded: a newer generation owns the name
        // settle ON THE NAME'S CHAIN, behind transitions already received. reconciliation reads
        // the APPLIED index, so settling straight from the acknowledgement could put the owner
        // back in step with state that a queued delivery was about to replace — and then clear
        // `owes()`, letting that delivery through as if nothing were outstanding
        void enqueue(name, undefined, async () => {
          if (!currentOwed(name, generation)) return
          owed.delete(name) // settled, and still the latest: the write IS committed
          // ... but only reconcile from an index that actually took this write's echo. when the
          // application FAILED the index may still hold the pre-write state, and the owner already
          // holds what we wrote — reconciling would roll it back, with no later echo guaranteed.
          // authority revocation and the dirty marking drive the repair instead
          if (deps.echoApplied(id)) deps.reconcileOwner(name)
          else console.warn(`hidden echo for '${name}' (${id}) did not apply; owner left as written`)
        })
      },
      e => {
        const current = currentOwed(name, generation)
        if (!current) return // superseded: this outcome no longer matters
        if (!isNotFound(e)) {
          // a settled permission/validation error, not offline retry (firestore keeps those
          // pending). leave the record IDLE and observable rather than clearing it
          current.phase = 'failed'
          console.error(`hidden write for '${name}' failed:`, e)
          return void deps.notifyFailure(name, e)
        }
        deps.invalidateAuthority(`hidden write target ${id} not found`)
        const index = deps.index()
        if (index.byId.get(id)) removeHidden(index, id) // it does not exist server-side
        current.phase = 'queued'
        void enqueue(name, undefined, () => persistOwed(name))
      },
    )
    return true
  }

  // ONE attempt for `generation`: resolve the target, build, recheck, issue. returns false when
  // the target MOVED while building, and the caller then requeues behind the remote applications
  // that moved it. an inner loop was the obvious alternative and is worse: it re-encrypts while
  // holding the chain, starving the very receipts it is waiting for, and its "each retarget takes
  // a lower id" termination argument is false — a removal or rename can retarget upward or to
  // absence, and receipts can oscillate. safety here rests on receipts eventually going quiet,
  // and the requeue gives them their turn
  async function attemptWrite(name: string, generation: number): Promise<boolean> {
    const current = () => currentOwed(name, generation)
    const state = current()?.state
    if (!current()) return true // superseded: nothing owed by this generation any more
    let holder = canonicalHolder(name)
    if (!holder) {
      // nothing holds the name (never created, or removed while we were building): re-enter the
      // confirmed-create resolution rather than writing to whatever we had before
      holder = { name, item: state, id: deps.newTempId(), saving: null, pending_create: true, adopt_id: null }
      const index = deps.index()
      index.byId.set(holder.id, holder)
      index.byName.set(name, holder)
    }
    if (holder.pending_create || holder.adopt_id) {
      holder.item = state
      return await attemptCreate(holder, generation)
    }
    // build the payload for a target WITHOUT mutating it unless it is live in the index: a record
    // that has only been received is about to be applied, and writing our state into that object
    // would make its own application carry our change instead of what arrived
    const merged = { ...holder, item: { ...(holder.item ?? {}) } }
    deps.adopt({ ...merged, item: state }, merged) // may hold fields the owner never saw
    if (deps.index().byId.get(holder.id) === holder) holder.item = state // live: keep in step
    const stamp = targetStamp(holder.id) // what we believe the target is, before we build for it
    const data = await deps.encryptState(payload({ ...holder, item: state }))
    if (!current()) return true
    // moved, or CHANGED under us — including a change that has entered the listener and is still
    // decrypting, which the stamp sees and canonical resolution deliberately does not
    if (canonicalHolder(name) !== holder || targetStamp(holder.id) !== stamp) return false
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
      if (!wrapper.adopt_id) {
        // the pending name is passed so the caller can register THAT name inline (the adoption
        // decision) while routing every other name through its own chain (see confirmIndex)
        await deps.confirmIndex(name) // rejects to fail the create
        if (!current()) return true // superseded: the newer generation redoes this
        // a same-name record can already be known locally even when confirmation was a no-op
        // (an authoritative index with a retained duplicate, or a remote arrival mid-create):
        // adopt the minimum-id survivor instead of creating alongside it
        const survivor = findSurvivor(wrapper)
        if (survivor) {
          wrapper.adopt_id = survivor.id
          deps.adopt(wrapper, survivor)
        }
      }
      // NOTE: both branches below finalize once the write is ISSUED to the SDK, not once the
      // server acknowledges. holding the chain for the acknowledgement is what lost every offline
      // save after the first: the create's promise stays pending until reconnect, so a later save
      // waited behind it and died with the tab while only the create survived in IndexedDB.
      // rejection recovery stays attached but detached from the chain
      if (wrapper.adopt_id) {
        const adoptId = wrapper.adopt_id
        const stamp = targetStamp(adoptId) // what we believe the target is, before we build for it
        const data = await deps.encryptState(payload(wrapper)) // merged state (see deps.adopt)
        if (!current()) return true
        // TWO conditions, and "strictly lower" alone was only the first: a lower id arriving makes
        // this target noncanonical, and a change to the target ITSELF (removed, renamed, replaced
        // under the same id) makes the payload we just built wrong for it — it would resurrect a
        // removed document, undo a rename, or erase a field that arrived while we encrypted
        const better = findSurvivor(wrapper)
        if ((better && compareIds(better.id, adoptId) < 0) || targetStamp(adoptId) !== stamp) {
          wrapper.adopt_id = null // re-choose on the retry, which reconfirms against the server
          return false
        }
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
      if (findSurvivor(wrapper) || hasPendingReceipts()) return false // requeue: the retry adopts it
      if (issueWrite(name, generation, id, data, true)) finalizeCreate(deps.index(), wrapper, id)
      return true
    } catch (e) {
      // a STALE generation must not mutate the index on its way out either: the current one owns
      // the wrapper now, and finalizing or removing it here is the same class of stale world
      // mutation the generation checks above exist to prevent. it returns ABANDONMENT rather than
      // rethrowing, so the outer catch does not log a failure for work already known to be obsolete
      if (!current()) return true
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

  // persists whatever the name currently owes, on whichever record holds it
  async function persistOwed(name: string) {
    const op = owed.get(name)
    if (!op || op.phase == 'building') return
    op.phase = 'building'
    const generation = op.generation
    const current = () => currentOwed(name, generation)
    try {
      // the phrase is acquired BEFORE any payload is resolved, and single-flighted by the
      // dependency: encryptState must not prompt, because a prompt between the last resolution
      // and the write could register a lower-id record
      await deps.acquireSecret()
      if (!current()) return
      if (await attemptWrite(name, generation)) return
      // the target moved. requeue at the BACK of the chain so the receipts that moved it apply
      // first — retrying here would hold the chain and re-encrypt against a view that cannot change
      const now = current()
      if (!now) return
      now.phase = 'queued'
      void enqueue(name, undefined, () => persistOwed(name))
    } catch (e) {
      const now = current()
      if (now) now.phase = 'failed' // retryable: a later save schedules it again
      // an intentional phrase cancellation is an expected outcome: neither reported to the user
      // nor logged as an error. everything else is a terminal BUILD failure (secret, confirmation,
      // encryption) and is just as invisible as a terminal WRITE failure was — owes() stays true,
      // the saving mirror clears, and owner notifications stay suppressed
      if (isCancellation(e)) return
      console.error(`persisting hidden item '${name}' failed:`, e)
      if (now) deps.notifyFailure(name, e)
    }
  }

  return {
    // replaces (or creates) the hidden item for the name with the given state. the wrapper's
    // state is updated immediately; the document payload is serialized when the queued task
    // EXECUTES, so it always carries the latest full state — including adoption merges and
    // later save() calls — and a failed earlier write is superseded rather than retried
    save(name: string, item: any) {
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
      // and briefly carry saving state for an object no longer in the live index
      const claimed = index.byName.get(name)
      let holder = claimed && index.byId.get(claimed.id) === claimed && claimed.name == name ? claimed : undefined
      if (!holder) {
        // claim the name SYNCHRONOUSLY: readers of the index (and saving_global_store) must see
        // the store the moment it is saved, not when its task happens to run
        holder = {
          name,
          item,
          id: deps.newTempId(),
          saving: null,
          pending_create: true,
          adopt_id: null,
        }
        index.byId.set(holder.id, holder)
        index.byName.set(name, holder)
      }
      holder.item = item
      if (deps.readonly()) return // the index is updated; nothing is persisted
      const op = owed.get(name)
      if (op) {
        op.state = item // supersede: whatever is queued or in flight now owes this state
        op.generation = ++generationSeq
        // a record that is QUEUED already has a task coming. one that is building, issued or
        // failed does not — and treating those as "already queued" is how failed work sat idle
        // forever, and how a save after issuance was never written
        if (op.phase == 'queued') return
        op.phase = 'queued'
      } else owed.set(name, { generation: ++generationSeq, state: item, phase: 'queued' })
      void enqueue(name, holder, () => persistOwed(name))
    },

    // true when this name still owes the server a local change. used for NOTIFICATION, never to
    // skip application: a delivery still lands in the index, but the owner's copy and its
    // "changed remotely" callback must not be driven backwards while a newer local generation is
    // still queued — a handler that reacts by saving would otherwise persist the older state
    owes(name: string) {
      return owed.has(name)
    },

    // applies a remote transition (add/modify/remove) for the name ON ITS CHAIN, so it can
    // never interleave with an in-flight write for the same name; with no queued work it runs
    // immediately. returns a promise that settles when the transition has applied — the caller
    // aggregates these before settling that revision's authority. pass the name when known; a removal
    // of an id not in the index applies immediately (nothing in flight can target it)
    applyRemote(names: (string | undefined)[] | string | undefined, apply: () => void): Promise<void> {
      // EVERY affected name is acquired, in a canonical order so two renames in opposite
      // directions cannot deadlock: a rename must join the in-flight write on its OLD name too,
      // otherwise an already-issued old-name update can write the old name back
      const affected = [...new Set((Array.isArray(names) ? names : [names]).filter(Boolean) as string[])]
        .filter(name => chains.has(name))
        .sort(compareIds)
      if (!affected.length) {
        try {
          apply()
          return Promise.resolve()
        } catch (e) {
          return Promise.reject(e)
        }
      }
      const acquire = (i: number): Promise<void> =>
        i == affected.length
          ? Promise.resolve(apply())
          : (enqueue(affected[i], undefined, () => acquire(i + 1)) as Promise<void>)
      return acquire(0)
    },

    // releases a receipt once its application has settled — only if it is still the latest, so a
    // newer receipt (e.g. a rename that a pending create must see) is never discarded by an
    // older application finishing. the inbox exists only so a create/adopt decision can see a
    // record whose application is still queued; keeping entries for the page lifetime let a
    // QUARANTINED duplicate be re-adopted by the next same-name create
    releaseRemote(id: string, token: number) {
      if (receipts.get(id)?.token == token) receipts.delete(id)
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
