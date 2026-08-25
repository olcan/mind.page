// per-name persistence controller for hidden items (stage 1b of the index.svelte split;
// matrix-tested in tests/unit/hidden_persistence.spec.ts). all work for a given name — local
// writes, deletions AND remote transitions — runs on one serialized chain: concurrent updates
// completing out of order could otherwise leave the server at an older state than memory, and a
// remote replacement applied mid-write could displace the wrapper a write is targeting. every
// success/failure settles through the index transitions in hidden.ts so the name invariant
// holds. tasks hold INTENTS: targets and payloads are resolved when a task EXECUTES, never when
// it is enqueued. firestore, encryption and the server confirmation stay with the caller as
// injected capabilities.
//
// NOTE: ordering state lives in the controller, but `wrapper.saving` is still mirrored onto the
// wrapper while it has in-flight work: item code observes it (e.g. the store_saving getter in
// index.svelte), so it is part of the window contract.

import {
  compareIds,
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
  // updates the document ONLY if it is still at `expectedRev`, and stamps rev = expectedRev + 1.
  // resolves the new revision, or rejects with a conflict (see isConflict) carrying the record
  // the server actually holds — the client never has to infer commit order
  updateDoc: (id: string, data: Record<string, any>, expectedRev: number) => Promise<number>
  createDoc: (data: Record<string, any>) => Promise<string> // resolves the persistent id
  deleteDoc: (id: string) => Promise<void>
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

// a write rejected because the document moved on: the server holds a newer revision. this is an
// OBSERVABLE conflict outcome rather than a silent overwrite in either direction
export type HiddenConflict = { conflict: true; rev: number }
export const isConflict = (e: any): boolean => !!e?.conflict

export function createHiddenPersistence(deps: HiddenPersistenceDeps) {
  const chains = new Map<string, Promise<unknown>>() // per-name serialization
  // NOTE: there is no write-provenance map and no own-delete set any more. both existed to
  // answer "is this delivery our own echo?" by matching payloads — which needed a size cap (an
  // evicted old echo then applied as remote state), consumption rules, and failure bookkeeping.
  // the document REVISION answers it exactly: an echo of our own write carries the revision we
  // already hold, so isNewerRevision rejects it, while any genuinely later change carries a
  // higher one
  const deleteDocTracked = (id: string) => deps.deleteDoc(id)

  // name-level deletion tombstones: while a logical deletion is unsettled, any same-name
  // document DISCOVERED (e.g. registered during another task's confirmation, or arriving at the
  // listener) is added to the deletion's targets instead of being registered — see
  // deleteName/deleteDiscovered
  const deleting = new Map<string, string[]>()
  // remote records observed at RECEIPT but whose application is queued (possibly behind the very
  // create that needs to know about them): serialization must not HIDE a same-name survivor from
  // a create/adopt decision, which would create a duplicate the listener then has to clean up
  const inbox = new Map<string, HiddenWrapper>() // document id -> record as received
  const inboxRemoved = new Set<string>() // ids whose removal was received (never adopt these)
  let bornSeq = 0 // stamps local creates so a deletion can exclude causally-later ones

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
      if (w.pending_create || w.adopt_id || w.deleted || inboxRemoved.has(w.id)) return
      if (!survivor || compareIds(w.id, survivor.id) < 0) survivor = w
    }
    for (const w of index.byId.values()) consider(w)
    for (const w of inbox.values()) if (!index.byId.has(w.id)) consider(w) // received, not yet applied
    return survivor
  }

  // persists a pending create: confirm (unless already adopted), adopt any already-known
  // same-name survivor, then either update the adopted document with merged state or create a
  // fresh one. shared by the create path and by not-found recovery (an update whose document
  // was deleted concurrently is a create-like transition: it must confirm and adopt any
  // surviving same-name document, never blindly create a duplicate). the wrapper can be
  // tombstoned by a delete at any await: nothing further is persisted, and settlement re-keys
  // the wrapper WITHOUT reinserting it (the queued delete targets the result)
  async function persistCreate(wrapper: HiddenWrapper) {
    try {
      await deps.encryptState(payload(wrapper)) // may prompt; adoption can happen meanwhile
      if (wrapper.deleted) return
      // the pending name is passed so the caller can register THAT name inline (the adoption
      // decision) while routing every other name through its own chain (see confirmIndex)
      if (!wrapper.adopt_id) await deps.confirmIndex(wrapper.name) // rejects to fail the create
      if (wrapper.deleted) return
      if (!wrapper.adopt_id) {
        // a same-name record can already be known locally even when confirmation was a no-op
        // (an authoritative index with a retained duplicate, or a remote arrival mid-create):
        // adopt the minimum-id survivor instead of creating alongside it
        const survivor = findSurvivor(deps.index(), wrapper)
        if (survivor) {
          wrapper.adopt_id = survivor.id
          wrapper.rev = survivor.rev // precondition the adopted write on the survivor's revision
          deps.adopt(wrapper, survivor)
        }
      }
      if (wrapper.adopt_id) {
        const state = payload(wrapper) // merged state (see deps.adopt)
        try {
          // the adopted record's revision travels on the wrapper (set where adoption is decided:
          // registerHidden, or findSurvivor below), since the record may be known only from the
          // receipt inbox and not yet present in the index
          wrapper.rev = await deps.updateDoc(wrapper.adopt_id, await deps.encryptState(state), wrapper.rev ?? 0)
        } catch (e) {
          // the adopted document is gone (deleted concurrently, possibly by a removal that
          // arrived while we adopted): finalizing would settle the wrapper onto a document that
          // no longer exists, so the create FAILS instead and the next save retries cleanly
          if (isNotFound(e)) {
            wrapper.adopt_id = null
            deps.invalidateAuthority(`adopted hidden document vanished during adoption`)
          }
          throw e
        }
        finalizeAdoption(deps.index(), wrapper)
      } else {
        const id = await deps.createDoc(await deps.encryptState(payload(wrapper)))
        wrapper.rev = 1 // a fresh document starts at revision 1
        finalizeCreate(deps.index(), wrapper, id) // restores minimum-id if a lower-id duplicate arrived
      }
    } catch (e) {
      if (wrapper.deleted) throw e // the maps were already cleared by the delete: leave them alone
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

  // true while the wrapper is a valid target for a queued save: it can have been deleted
  // (tombstone), removed by a failed create's cleanup, or displaced from byId by a remote
  // replacement or rename — a write against a transitional wrapper would resurrect deleted
  // state, bypass create confirmation, or rename the document back
  function stillCurrent(name: string, wrapper: HiddenWrapper) {
    const index = deps.index()
    return !wrapper.deleted && index.byName.get(name) === wrapper && index.byId.get(wrapper.id) === wrapper
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
        enqueue(name, existing, async () => {
          // re-resolve the target at execution, and AGAIN after the encryption await (remote
          // transitions serialize on this same chain, but the index can still move underneath
          // through non-chain paths, e.g. an authoritative cleanup); dropped saves are the
          // explicit remote-wins outcome, logged so the conflict is observable
          if (!stillCurrent(name, existing)) {
            console.warn(`dropping hidden save for '${name}': wrapper removed or replaced while queued`)
            return
          }
          try {
            const data = await deps.encryptState(payload(existing))
            if (!stillCurrent(name, existing)) {
              console.warn(`dropping hidden save for '${name}': wrapper removed or replaced during encryption`)
              return
            }
            try {
              // preconditioned on the revision this state was built from: if anything committed
              // in between — another tab, another device, a queued transition — the write does
              // not land and the conflict is reported instead of being silently resolved
              existing.rev = await deps.updateDoc(existing.id, data, existing.rev ?? 0)
            } catch (e) {
              if (isConflict(e)) {
                // the server moved on. the listener delivers that newer revision (and applies it
                // by isNewerRevision), so this write is simply superseded — an explicit,
                // observable remote-wins outcome, not a lost update discovered later
                console.warn(`hidden save for '${name}' superseded by a newer revision on the server`)
                return
              }
              if (!isNotFound(e)) throw e
              // the target can have been displaced WHILE the write was in flight (a remote
              // replacement or rename landed and the server deleted the old document): the
              // replacement is canonical, so the stale write is dropped, not recovered
              if (!stillCurrent(name, existing)) {
                console.warn(`dropping hidden save for '${name}': wrapper replaced while its write was in flight`)
                return
              }
              // deleted concurrently (e.g. another client's cleanup): a create-like transition.
              // the missing target also proves the index is stale — authority must be revoked
              // so the confirmation below actually re-reads the server instead of no-opping
              deps.invalidateAuthority(`hidden update target ${existing.id} not found`)
              existing.pending_create = true
              existing.adopt_id = null
              await persistCreate(existing)
            }
          } catch (e) {
            console.error('hidden item update failed:', e)
          }
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
        born: ++bornSeq,
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
    // aggregates these before settling revision authority. pass the name when known; a removal
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
      // the client then had to re-read to discover the truth. with revisions the application
      // itself carries the answer: a queued delivery that is older than what we hold is rejected
      // by isNewerRevision, and a newer one is exactly what should win
      return acquire(0)
    },

    // records a remote record/removal at RECEIPT so create/adopt decisions can see it before its
    // application runs (which may be queued behind the very create that needs it)
    noteRemote(wrapper: HiddenWrapper | undefined, id: string, removed: boolean) {
      if (removed) {
        inboxRemoved.add(id)
        inbox.delete(id)
      } else if (wrapper) inbox.set(id, wrapper)
    },

    // the name a document belongs to, including one being ADOPTED (whose server id is not in
    // byId until finalization): a removal of that id must serialize on the adopting name's chain
    nameForDocument(id: string) {
      const index = deps.index()
      const known = index.byId.get(id)?.name
      if (known) return known
      for (const w of index.byId.values()) if (w.adopt_id == id) return w.name
      return inbox.get(id)?.name
    },

    // LOGICAL deletion of the hidden name the id belongs to ("this store is empty"): removes
    // every same-name record — the canonical wrapper plus any retained duplicates, whose
    // promotion would otherwise resurrect old state — and tombstones the name until the
    // deletion settles, so a same-name document discovered mid-flight (e.g. registered during
    // another task's confirmation) is deleted instead of registered
    // `expectedName` is the name the CALLER believes it is emptying. it is authoritative when
    // given: resolving the name from the id alone lets a stale alias (an id whose live wrapper
    // was renamed remotely) delete every record of the record's NEW name — the caller's own
    // store is not what would die
    deleteName(id: string, expectedName?: string) {
      const index = deps.index()
      const live = index.byId.get(id)?.name
      if (expectedName && live && live != expectedName) {
        console.warn(`hidden delete for '${expectedName}' targeted a record now named '${live}': deleting by name only`)
      }
      const name = expectedName ?? live
      if (!name) {
        // unknown id (e.g. already removed): best-effort record deletion
        if (!deps.readonly()) void deleteDocTracked(id).catch(e => console.error('hidden item delete failed:', e))
        return
      }
      // removes every record currently known under the name; called again INSIDE the task, since
      // arrivals queued ahead of it can add more records between now and then (a snapshot list
      // taken here would let those survive and resurrect the store)
      // records created (locally) AFTER this deletion was issued are causally later intent and
      // must survive it: "empty this store, then put this in it" cannot end empty
      const issuedAt = bornSeq
      const removedList: HiddenWrapper[] = []
      const removeAllNamed = () => {
        const index = deps.index()
        for (const w of [...index.byId.values()])
          if (w.name == name && !w.deleted && !((w.born ?? 0) > issuedAt)) {
            const { removed } = removeHidden(index, w.id)
            if (removed) {
              removed.deleted = true
              removedList.push(removed)
            }
          }
      }
      removeAllNamed()
      if (deps.readonly()) return
      const discovered: string[] = []
      deleting.set(name, discovered)
      const run = async () => {
        try {
          // an index that is not authoritative may not KNOW every record of this name (a partial
          // cache can hold one while an older one is unseen): confirm against the server first,
          // with the tombstone routing every same-name document it finds into this deletion.
          // without it, deleting a store can be undone by later discovery of an unseen record
          // a failed confirmation means the index may still be missing records of this name:
          // authority is revoked so nothing later treats the deletion as complete evidence
          await deps.confirmIndex(name).catch(e => {
            console.error('hidden delete confirmation failed:', e)
            deps.invalidateAuthority('hidden delete confirmation failed')
          })
          // by the time the task runs, any preceding create has settled: on success the wrapper
          // carries the persistent id (re-keyed even when tombstoned), on failure nothing was
          // persisted (and is skipped below)
          const deleted = new Set<string>()
          const targets = new Set<string>()
          // discoveries and applied arrivals can keep landing WHILE a delete is in flight: drain
          // until nothing new is left rather than snapshotting the list once
          for (;;) {
            removeAllNamed() // records applied since the last pass
            for (const w of removedList)
              if (!(w.pending_create && !w.adopt_id)) targets.add(!w.pending_create ? w.id : (w.adopt_id ?? w.id))
            for (const id of discovered.splice(0)) targets.add(id)
            const pending = [...targets].filter(id => !deleted.has(id))
            if (!pending.length) break
            for (const target of pending) {
              deleted.add(target)
              // a failed delete leaves the document ALIVE server-side while the local record is
              // gone: revoke authority so the next same-name create re-confirms and adopts it
              // instead of creating a duplicate beside the survivor
              await deleteDocTracked(target).catch(e => {
                console.error('hidden item delete failed:', e)
                deps.invalidateAuthority('hidden delete failed')
              })
            }
          }
        } finally {
          if (deleting.get(name) === discovered) deleting.delete(name)
        }
      }
      // the canonical wrapper (if any) mirrors saving through the deletion so item code can
      // still observe the in-flight work; the mirror clears when this task settles
      enqueue(name, removedList[0], run)
    },

    // RECORD deletion of one hidden document (invalid-record cleanup): removes only this
    // wrapper — a same-name canonical record stays — and deletes only this document
    deleteRecord(id: string) {
      const { removed } = removeHidden(deps.index(), id)
      if (removed) removed.deleted = true
      if (deps.readonly()) return
      const run = async () => {
        const target = removed && !removed.pending_create ? removed.id : (removed?.adopt_id ?? removed?.id ?? id)
        if (removed?.pending_create && !removed.adopt_id) return // nothing persisted
        await deleteDocTracked(target).catch(e => console.error('hidden item delete failed:', e))
      }
      if (removed) enqueue(removed.name, removed, run)
      else void run()
    },

    // true while a logical deletion of the name is unsettled: registration paths consult this
    // and hand same-name discoveries to deleteDiscovered instead of registering them
    isDeleting(name: string) {
      return deleting.has(name)
    },

    // routes a document discovered during an unsettled logical deletion into that deletion's
    // targets (or deletes it directly if the deletion settled in the meantime)
    deleteDiscovered(name: string, id: string) {
      const targets = deleting.get(name)
      if (targets) targets.push(id)
      else if (!deps.readonly()) void deleteDocTracked(id).catch(e => console.error('hidden item delete failed:', e))
    },
  }
}
