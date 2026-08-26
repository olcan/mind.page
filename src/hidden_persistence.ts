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
  type Receipt = { token: number; wrapper?: HiddenWrapper }
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
          owed.delete(name) // settled, and still the latest
          deps.reconcileOwner(name) // one explicit repair, now that notifications are unblocked
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

  // persists whatever the name currently owes, on whichever record holds it
  async function persistOwed(name: string) {
    const op = owed.get(name)
    if (!op || op.phase == 'building') return
    op.phase = 'building'
    const generation = op.generation
    const current = () => currentOwed(name, generation)
    // builds the payload for a target WITHOUT mutating it unless it is live in the index: a
    // record that has only been received is about to be applied, and writing our state into that
    // object would make its own application carry our change instead of what arrived
    const build = async (target: HiddenWrapper, state: any) => {
      // landing on a record this generation has not written merges under the intent: it may hold
      // fields the owner never saw (a retained duplicate, a newly registered lower id)
      const merged = { ...target, item: { ...(target.item ?? {}) } }
      deps.adopt({ ...merged, item: state }, merged)
      if (deps.index().byId.get(target.id) === target) target.item = state // live: keep in step
      return { data: await deps.encryptState(payload({ ...target, item: state })), id: target.id }
    }
    try {
      // the phrase is acquired BEFORE any payload is resolved, and single-flighted by the
      // dependency: encryptState must not prompt, because a prompt inside the loop below could
      // register a lower-id record between the last resolution and the write
      await deps.acquireSecret()
      if (!current()) return
      // ONE stable loop for updates, creates and adoptions: resolve the holder, merge, encrypt,
      // then resolve AGAIN — issuing only when the answer did not move. a single recheck closed
      // only the first retarget: a receipt arriving during the REBUILD stranded the write on a
      // record that was no longer canonical, and a holder REMOVED during the build fell through
      // a truthy-only condition and updated the removed id. this terminates because each retarget
      // takes the minimum id of a finite set, so continuing requires new receipts to keep arriving
      for (;;) {
        const state = current()?.state
        if (!current()) return
        let holder = canonicalHolder(name)
        if (!holder) {
          // no holder at all (never created, or removed while we were building): re-enter the
          // confirmed-create resolution rather than writing to whatever we had before
          holder = {
            name,
            item: state,
            id: deps.newTempId(),
            saving: null,
            pending_create: true,
            adopt_id: null,
          }
          const index = deps.index()
          index.byId.set(holder.id, holder)
          index.byName.set(name, holder)
        }
        if (holder.pending_create || holder.adopt_id) {
          holder.item = state
          await persistCreate(holder, generation)
          return
        }
        const built = await build(holder, state)
        if (!current()) return
        if (canonicalHolder(name) === holder) return void issueWrite(name, generation, built.id, built.data, false)
      }
    } catch (e) {
      const now = current()
      if (now) now.phase = 'failed' // retryable: a later save schedules it again
      console.error(`persisting hidden item '${name}' failed:`, e)
    }
  }

  async function persistCreate(wrapper: HiddenWrapper, generation: number) {
    const name = wrapper.name
    const current = () => currentOwed(name, generation)
    try {
      // the pending name is passed so the caller can register THAT name inline (the adoption
      // decision) while routing every other name through its own chain (see confirmIndex)
      if (!wrapper.adopt_id) await deps.confirmIndex(name) // rejects to fail the create
      if (!current()) return // superseded during confirmation: the newer generation redoes this
      if (!wrapper.adopt_id) {
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
        const adopted = await deps.encryptState(payload(wrapper)) // merged state (see deps.adopt)
        if (!current()) return
        if (issueWrite(name, generation, adoptId, adopted, false)) finalizeAdoption(deps.index(), wrapper)
        return
      }
      const id = deps.newDocId()
      const created = await deps.encryptState(payload(wrapper))
      if (!current()) return
      // one more look immediately before issuing: a same-name record can have been RECEIVED
      // during that encryption, and creating alongside a survivor we already know about is a
      // duplicate we cause ourselves. (a record another writer commits after this point is a
      // genuine race that no client read can close without server-side uniqueness)
      const late = findSurvivor(wrapper)
      if (late) {
        wrapper.adopt_id = late.id
        deps.adopt(wrapper, late)
        const merged = await deps.encryptState(payload(wrapper))
        if (!current()) return
        if (issueWrite(name, generation, late.id, merged, false)) finalizeAdoption(deps.index(), wrapper)
        return
      }
      // issued and released: the id is already allocated, so nothing downstream needs to wait
      // for the server (see the note above)
      if (issueWrite(name, generation, id, created, true)) finalizeCreate(deps.index(), wrapper, id)
    } catch (e) {
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
