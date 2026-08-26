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
  // encrypts a document payload off the session secret; may prompt for the phrase (see
  // encryptItem/getSecretPhrase in index.svelte), during which a fixed-page validation can
  // register the account's hidden items and ADOPT a pending create
  encryptState: (state: HiddenDocData) => Promise<Record<string, any>>
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

  // ONE record per name of what that name still OWES the server. it replaces three parallel
  // pieces of state (a queued-wrapper map, an unpruned intent map, and a recovering-id set) and
  // the wrapper-identity conditions that went with them. a generation counter says whether a
  // given attempt is still the latest, so a stale rejection or a late recovery cannot act, and
  // the record is cleared only when the generation it persisted is still current — which also
  // stops the old intent map from growing for the page lifetime
  type Owed = { generation: number; state: any; running: boolean; writtenTo?: string }
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

  // the record that legitimately holds a name RIGHT NOW: live in byId under that exact name,
  // minimum id, never quarantined. byName alone is not that: a remote rename deliberately leaves
  // the old name pointing at a wrapper no longer in byId, and writing through that alias renames
  // the live document back and overwrites its state
  function canonicalHolder(name: string): HiddenWrapper | undefined {
    const index = deps.index()
    let best: HiddenWrapper | undefined
    for (const w of index.byId.values()) {
      if (w.name != name || isQuarantined(index, w.id)) continue
      if (w.pending_create || w.adopt_id) return w // a create for this name owns it
      if (!best || compareIds(w.id, best.id) < 0) best = w
    }
    return best
  }

  // the minimum-id same-name record a create could adopt instead of creating alongside: live
  // records plus ones RECEIVED but not yet applied, since serialization must not hide a record
  // the client already knows about from the create that would duplicate it
  function findSurvivor(index: HiddenIndex, wrapper: HiddenWrapper): HiddenWrapper | undefined {
    let survivor: HiddenWrapper | undefined
    const consider = (w: HiddenWrapper) => {
      if (w === wrapper || w.name != wrapper.name) return
      if (w.pending_create || w.adopt_id || isQuarantined(index, w.id)) return
      if (!survivor || compareIds(w.id, survivor.id) < 0) survivor = w
    }
    for (const w of index.byId.values()) consider(w)
    for (const { wrapper: w } of receipts.values()) if (w && !index.byId.has(w.id)) consider(w)
    return survivor
  }

  // persists whatever the name currently owes, whoever holds it. ONE routine for initial saves
  // and for both ordinary and adopted not-found recovery, so the recovery paths cannot disagree
  // with the write path about which record a name should end up on. it re-resolves the holder
  // after every await, because the intent belongs to the name and follows it
  async function persistOwed(name: string) {
    const op = owed.get(name)
    if (!op || op.running) return
    op.running = true
    const generation = op.generation
    const stillOwed = () => owed.get(name)?.generation == generation
    try {
      let holder = canonicalHolder(name)
      if (!holder) {
        // nothing holds the name any more (a removal landed): claim it again and confirm, which
        // adopts a surviving server record if there is one
        holder = { name, item: op.state, id: deps.newTempId(), saving: null, pending_create: true, adopt_id: null }
        const index = deps.index()
        index.byId.set(holder.id, holder)
        index.byName.set(name, holder)
      }
      if (holder.pending_create || holder.adopt_id) {
        holder.item = op.state
        await persistCreate(holder)
        if (stillOwed()) owed.delete(name)
        return
      }
      // landing on a record this intent has not written before is an ADOPTION: the record may
      // hold fields the owner never saw (a retained duplicate, or the survivor a vanished target
      // was replaced by), and overwriting them is the fresh-clone loss again. merging under the
      // intent is exactly what the create path does when it adopts
      if (op.writtenTo != holder.id) {
        deps.adopt({ ...holder, item: op.state }, holder)
        holder.item = op.state
      }
      holder.item = op.state
      const data = await deps.encryptState(payload(holder))
      if (!stillOwed()) return // a newer save superseded this one while encrypting
      holder = canonicalHolder(name) ?? holder
      holder.item = op.state
      const target = holder.id
      op.writtenTo = target
      deps.updateDoc(target, data).catch(e => {
        if (!isNotFound(e)) return void console.error('hidden item update failed:', e)
        // the document is gone. the name still owes this state, so re-run for the NAME rather
        // than inspecting the wrapper this write started from: a delivery may have replaced or
        // removed it in the meantime, and the intent outlives whichever record held it
        deps.invalidateAuthority(`hidden write target ${target} not found`)
        const index = deps.index()
        if (index.byId.get(target)) removeHidden(index, target) // it does not exist server-side
        owed.set(name, { generation: ++generationSeq, state: op.state, running: false }) // supersede
        void enqueue(name, undefined, () => persistOwed(name))
      })
      if (stillOwed()) owed.delete(name)
    } catch (e) {
      console.error(`persisting hidden item '${name}' failed:`, e)
    } finally {
      const op_now = owed.get(name)
      if (op_now) op_now.running = false
    }
  }

  // issues a write for a create/adoption and routes its not-found through the same name-level
  // recovery the ordinary path uses: the record is gone, so the name is owed its state again
  function issueForName(name: string, id: string, data: Record<string, any>, state: any, create: boolean) {
    const write = create ? deps.createDoc(id, data) : deps.updateDoc(id, data)
    write.catch(e => {
      if (!isNotFound(e)) return void console.error(`hidden item ${create ? 'create' : 'adoption'} failed:`, e)
      deps.invalidateAuthority(`hidden write target ${id} vanished`)
      const index = deps.index()
      if (index.byId.get(id)) removeHidden(index, id)
      // ALWAYS supersede: the rejection can arrive while the attempt that caused it is still in
      // flight, and re-using that record would leave the recovery blocked behind its own
      // running flag — the recovery would then be dropped when the original attempt finished
      owed.set(name, { generation: ++generationSeq, state, running: false })
      void enqueue(name, undefined, () => persistOwed(name))
    })
  }

  async function persistCreate(wrapper: HiddenWrapper) {
    try {
      await deps.encryptState(payload(wrapper)) // may prompt; adoption can happen meanwhile
      // the pending name is passed so the caller can register THAT name inline (the adoption
      // decision) while routing every other name through its own chain (see confirmIndex)
      if (!wrapper.adopt_id) await deps.confirmIndex(wrapper.name) // rejects to fail the create
      if (!wrapper.adopt_id) {
        // a same-name record can already be known locally even when confirmation was a no-op
        // (an authoritative index with a retained duplicate, or a remote arrival mid-create):
        // adopt the minimum-id survivor instead of creating alongside it
        const survivor = findSurvivor(deps.index(), wrapper)
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
        const state = payload(wrapper) // merged state (see deps.adopt)
        const adoptId = wrapper.adopt_id
        const adopted = await deps.encryptState(state)
        issueForName(wrapper.name, adoptId, adopted, wrapper.item, false)
        finalizeAdoption(deps.index(), wrapper)
      } else {
        const state = payload(wrapper)
        const id = deps.newDocId()
        const created = await deps.encryptState(state)
        // one more look immediately before issuing: a same-name record can have been RECEIVED
        // during that encryption, and creating alongside a survivor we already know about is a
        // duplicate we cause ourselves. (a record another writer commits after this point is a
        // genuine race that no client read can close without server-side uniqueness)
        const late = findSurvivor(deps.index(), wrapper)
        if (late) {
          wrapper.adopt_id = late.id
          deps.adopt(wrapper, late)
          const merged = await deps.encryptState(payload(wrapper))
          issueForName(wrapper.name, late.id, merged, wrapper.item, false)
          finalizeAdoption(deps.index(), wrapper)
          return
        }
        // issued and released: the id is already allocated, so nothing downstream needs to wait
        // for the server (see the note above)
        issueForName(wrapper.name, id, created, wrapper.item, true)
        finalizeCreate(deps.index(), wrapper, id) // restores minimum-id if a lower-id duplicate arrived
      }
    } catch (e) {
      // NOTE: both branches below finalize once the write is ISSUED to the SDK, not once the
      // server acknowledges. holding the chain for the acknowledgement is what lost every offline
      // save after the first: the create's promise stays pending until reconnect, so a later save
      // waited behind it and died with the tab while only the create survived in IndexedDB.
      // rejection recovery stays attached but detached from the chain
      if (wrapper.adopt_id) {
        // the document exists: settle onto it so the next save UPDATES it — deleting the
        // wrapper would send the next save down the create path and duplicate it
        finalizeAdoption(deps.index(), wrapper)
      } else {
        // a genuinely failed fresh create: remove the wrapper (promoting any retained
        // same-name duplicate) so the next save retries cleanly
        removeHidden(deps.index(), wrapper.id)
      }
      throw e // keep the mirrored saving promise's rejection observable to waiters
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
      // the user's change must still land), and it is re-resolved after every await
      const index = deps.index()
      let holder = canonicalHolder(name) ?? index.byName.get(name)
      if (!holder) {
        // claim the name SYNCHRONOUSLY: readers of the index (and saving_global_store) must see
        // the store the moment it is saved, not when its task happens to run
        holder = { name, item, id: deps.newTempId(), saving: null, pending_create: true, adopt_id: null }
        index.byId.set(holder.id, holder)
        index.byName.set(name, holder)
      }
      holder.item = item
      if (deps.readonly()) return // the index is updated; nothing is persisted
      const op = owed.get(name)
      if (op) {
        op.state = item // supersede: a queued attempt picks up the latest state
        op.generation = ++generationSeq
        if (!op.running) return // its task has not built a payload yet
      } else owed.set(name, { generation: ++generationSeq, state: item, running: false })
      void enqueue(name, holder, () => persistOwed(name))
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
      // NOTE: no post-settle server reconcile. it existed because chain order is local execution
      // order, so a queued transition could land after a local write the server ordered first —
      return acquire(0)
    },

    // records a remote record/removal at RECEIPT so create/adopt decisions can see it before its
    // application runs (which may be queued behind the very create that needs it)
    // true when this delivery is the echo of a write this controller ISSUED and the server has
    // not acknowledged yet. firestore delivers a document's changes in commit order, so anything
    // else is genuinely newer state and must be applied — including another tab's write that
    // arrives while our own is still pending, which the old blanket in-flight skip lost

    // releases a receipt entry once its application has settled. the inbox exists only so a
    // create/adopt decision can see a record whose application is still queued; keeping entries
    // for the page lifetime let a QUARANTINED duplicate be re-adopted by the next same-name
    // create, which is exactly what quarantining was supposed to prevent
    // releases a receipt once its application has settled — only if it is still the latest, so a
    // newer receipt (e.g. a rename that a pending create must see) is never discarded by an
    // older application finishing
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
