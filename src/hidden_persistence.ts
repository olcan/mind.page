// per-name persistence controller for hidden items (stage 1b of the index.svelte split;
// matrix-tested in tests/unit/hidden_persistence.spec.ts).
//
// what it does: serializes the BUILDING of writes for a name (encryption can prompt), issues
// them to firestore's own durable ordered queue without waiting for acknowledgement, and settles
// the index transitions in hidden.ts so the name invariant holds. it does NOT order writers:
// firestore delivers a document's changes in commit order, and the only thing the client has to
// recognize is the echo of a write it issued itself, by the outbound ciphertext (unique per
// write via the random IV). there is no revision protocol, no provenance-by-plaintext, and no
// deletion — emptying a store is an ordinary save of `{}`.
//
// NOTE: `wrapper.saving` is mirrored while a write is being BUILT and ISSUED, and cleared once
// it reaches the SDK's queue — not when the server acknowledges. item code observes it through
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
  // creates the document AT the given id. the id is allocated by the caller (newDocId) so the
  // payload can be registered as outstanding BEFORE the write is issued — the local echo of a
  // create arrives through latency compensation almost immediately, and an id known only after
  // the promise resolves leaves a window in which our own create looks like a remote record and
  // replaces the very wrapper whose next save is still queued
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

  // the WRAPPER whose save task is queued but has not built its payload yet, per name. a queued
  // task serializes that wrapper's current state, so a second save in the same window coalesces
  // into it instead of issuing an identical write. keyed on the wrapper, not just the name: if
  // the record was replaced in between, the queued task will be dropped by stillCurrent and the
  // new state must get a task of its own rather than coalescing into a doomed one
  const pendingSaves = new Map<string, HiddenWrapper>()
  // document ids whose not-found recovery is already under way. every issued update installs its
  // own rejection handler, so two offline updates to a document deleted remotely both reject and
  // both used to start a recovery — the second ran against the already-settled wrapper, could not
  // see the record the first had just created, and created a duplicate
  const recovering = new Set<string>()
  // remote records observed at RECEIPT but whose application is queued (possibly behind the very
  // create that needs to know about them): serialization must not HIDE a same-name survivor from
  // a create/adopt decision, which would create a duplicate the listener then has to clean up
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

  // the minimum-id same-name wrapper that could hold this create's state: a retained duplicate
  // observed at initialization, or one that arrived remotely while the create was in flight —
  // creating alongside it would duplicate the name even though the survivor is already known
  function findSurvivor(index: HiddenIndex, wrapper: HiddenWrapper): HiddenWrapper | undefined {
    let survivor: HiddenWrapper | undefined
    const consider = (w: HiddenWrapper) => {
      if (w === wrapper || w.name != wrapper.name) return
      if (w.pending_create || w.adopt_id || isQuarantined(index, w.id)) return
      if (!survivor || compareIds(w.id, survivor.id) < 0) survivor = w
    }
    for (const w of index.byId.values()) {
      if (receipts.get(w.id) && !receipts.get(w.id)!.wrapper) continue // its removal was received
      consider(w)
    }
    // received but not yet applied: a create must see these, or it duplicates a record it knows about
    for (const { wrapper: w } of receipts.values()) if (w && !index.byId.has(w.id)) consider(w)
    return survivor
  }

  // persists a pending create: confirm (unless already adopted), adopt any already-known
  // same-name survivor, then either update the adopted document with merged state or create a
  // fresh one. shared by the create path and by not-found recovery (an update whose document
  // was deleted concurrently is a create-like transition: it must confirm and adopt any
  // surviving same-name document, never blindly create a duplicate)
  // issues an adopted write and settles the wrapper onto that document. the write is durable in
  // the SDK's queue from the moment it is issued, so nothing waits for the server — but if the
  // server later says the document is GONE, the wrapper is settled on an id that does not exist
  // and the merged state was never persisted. that is repaired by re-entering the create path
  // for the name, which will adopt a current holder or create a fresh record
  function issueAdoptedWrite(wrapper: HiddenWrapper, data: Record<string, any>) {
    const adoptId = wrapper.adopt_id!
    const name = wrapper.name
    deps.updateDoc(adoptId, data).catch(e => {
      if (!isNotFound(e)) return void console.error('hidden item adoption failed:', e)
      deps.invalidateAuthority(`adopted hidden document ${adoptId} vanished`)
      const index = deps.index()
      // only if the wrapper is still the name's holder AND still on the vanished id: anything
      // else means a later delivery already decided this name, and it wins
      if (index.byName.get(name) !== wrapper || wrapper.id != adoptId) return
      if (recovering.has(adoptId)) return
      recovering.add(adoptId)
      wrapper.pending_create = true
      wrapper.adopt_id = null
      enqueue(name, wrapper, () =>
        persistCreate(wrapper)
          .catch(err => void console.error('hidden item create failed:', err))
          .finally(() => recovering.delete(adoptId))
      )
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
        const adopted = await deps.encryptState(payload(wrapper)) // merged state (see deps.adopt)
        issueAdoptedWrite(wrapper, adopted)
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
          issueAdoptedWrite(wrapper, merged)
          finalizeAdoption(deps.index(), wrapper)
          return
        }
        // issued and released: the id is already allocated, so nothing downstream needs to wait
        // for the server (see the note above)
        deps.createDoc(id, created).catch(e => {
          console.error('hidden item create failed:', e)
        })
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

  // true while the wrapper is a valid target for a queued save: it can have been removed by a
  // failed create's cleanup, or displaced from byId by a remote
  // replacement or rename — a write against a transitional wrapper would resurrect deleted
  // state, bypass create confirmation, or rename the document back
  function stillCurrent(name: string, wrapper: HiddenWrapper) {
    const index = deps.index()
    // wrapper.name is checked too: a stale byName alias can still point at a record that was
    // RENAMED remotely, and writing through it would put the old store's value into the live
    // record under its new name
    return (
      wrapper.name == name &&
      index.byName.get(name) === wrapper &&
      index.byId.get(wrapper.id) === wrapper
    )
  }

  return {
    // replaces (or creates) the hidden item for the name with the given state. the wrapper's
    // state is updated immediately; the document payload is serialized when the queued task
    // EXECUTES, so it always carries the latest full state — including adoption merges and
    // later save() calls — and a failed earlier write is superseded rather than retried
    save(name: string, item: any) {
      const index = deps.index()
      const existing = index.byName.get(name)
      if (existing) {
        existing.item = item
        if (deps.readonly()) return
        if (pendingSaves.get(name) === existing) return // a queued save will pick this state up
        pendingSaves.set(name, existing)
        enqueue(name, existing, async () => {
          if (pendingSaves.get(name) === existing) pendingSaves.delete(name) // payload fixed from here
          // re-resolve the target at execution, and AGAIN after the encryption await: the index
          // can move underneath a queued save (a remote replacement, a failed create's cleanup),
          // and writing through a wrapper that is no longer current would resurrect stale state.
          // dropping is the explicit remote-wins outcome, logged so it is observable
          if (!stillCurrent(name, existing)) {
            console.warn(`dropping hidden save for '${name}': wrapper removed or replaced while queued`)
            return
          }
          let data
          const state = payload(existing)
          try {
            data = await deps.encryptState(state)
          } catch (e) {
            console.error('hidden item update failed:', e)
            return
          }
          if (!stillCurrent(name, existing)) {
            console.warn(`dropping hidden save for '${name}': wrapper removed or replaced during encryption`)
            return
          }
          // ISSUE the write and let the chain continue. awaiting the acknowledgement is what
          // broke offline durability: updateDoc reaches the SDK's durable queue immediately, but
          // its promise stays pending until the server accepts — so a second offline save waited
          // behind the first forever and vanished on reload while the first survived. the SDK's
          // queue preserves issue order, which is the ordering this chain was reconstructing by
          // hand. what still belongs on the chain is building the payload (encryption can prompt)
          const target = existing.id // the id THIS write goes to; recovery is keyed on it
          deps
            .updateDoc(target, data)
            .catch(e => {
              if (!isNotFound(e)) return void console.error('hidden item update failed:', e)
              // the document was removed server-side: recover as a create-like transition, on
              // this name's chain rather than inline (we are outside it by now). the check is on
              // the TARGET this write actually used — a later rejection for the same target, or
              // one arriving after the wrapper already moved on, must not start a second recovery
              if (recovering.has(target) || existing.id != target) return
              if (!stillCurrent(name, existing)) return
              recovering.add(target)
              deps.invalidateAuthority(`hidden update target ${existing.id} not found`)
              existing.pending_create = true
              existing.adopt_id = null
              enqueue(name, existing, () =>
                persistCreate(existing)
                  .catch(err => void console.error('hidden item create failed:', err))
                  .finally(() => recovering.delete(target))
              )
            })
        })
        return
      }

      // create: the wrapper claims the name immediately (pending), and the persisted document
      // is either an adoption of an existing one (found during the phrase prompt, the server
      // confirmation, or already known locally) or a fresh create
      const wrapper: HiddenWrapper = {
        name,
        item,
        id: deps.newTempId(),
        saving: null,
        pending_create: true,
        adopt_id: null,
      }
      index.byId.set(wrapper.id, wrapper)
      index.byName.set(name, wrapper)
      if (deps.readonly()) return
      enqueue(name, wrapper, async () => {
        try {
          await persistCreate(wrapper)
        } catch (e) {
          console.error('hidden item create failed:', e)
          throw e
        }
      })
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
    // true when a save for this name is QUEUED and has not built its payload yet. that save will
    // supersede whatever the server currently holds, so a delivery arriving now would only be
    // rolled back by it — this is the one case where a delivery must be skipped.
    // everything else applies, INCLUDING the echo of our own write: firestore delivers a
    // document's changes in commit order, so an echo is simply the newest server state. skipping
    // it was the bug — a remote B applied after our C was issued left the client at B while the
    // server ended at C, with no later delivery to correct it
    hasPendingSave(name: string) {
      return pendingSaves.has(name)
    },

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
