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

import { finalizeAdoption, finalizeCreate, removeHidden, type HiddenIndex, type HiddenWrapper } from './hidden.js'

export type HiddenDocData = { hidden: true; time: number; attr: null; text: string }

export type HiddenPersistenceDeps = {
  index: () => HiddenIndex
  // encrypts a document payload off the session secret; may prompt for the phrase (see
  // encryptItem/getSecretPhrase in index.svelte), during which a fixed-page validation can
  // register the account's hidden items and ADOPT a pending create
  encryptState: (state: HiddenDocData) => Promise<Record<string, any>>
  updateDoc: (id: string, data: Record<string, any>) => Promise<void>
  createDoc: (data: Record<string, any>) => Promise<string> // resolves the persistent id
  deleteDoc: (id: string) => Promise<void>
  // server re-confirmation of the hidden index before an unconfirmed create (registration may
  // adopt the pending wrapper); resolves immediately when the index is authoritative, rejects
  // to FAIL the create (a partial index must never lead to a duplicate document)
  confirmIndex: () => Promise<void>
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
  // exact plaintext payloads written per document, so the listener can classify a pending echo
  // as OUR OWN by content identity (payloads carry a fresh timestamp, so texts are unique);
  // bounded per id, never cleared — a stale entry can only match its own historical echo
  const recentWrites = new Map<string, string[]>()
  const recordWrite = (id: string, text: string) => {
    const texts = recentWrites.get(id) ?? []
    texts.push(text)
    if (texts.length > 8) texts.shift()
    recentWrites.set(id, texts)
  }
  // documents THIS controller deleted: a pending removal echo for one of these is our own; any
  // other pending removal is another tab's deletion and must be applied
  const ownDeletes = new Set<string>()
  const deleteDocTracked = (id: string) => {
    ownDeletes.add(id)
    return deps.deleteDoc(id)
  }
  // name-level deletion tombstones: while a logical deletion is unsettled, any same-name
  // document DISCOVERED (e.g. registered during another task's confirmation) is added to the
  // deletion's targets instead of being registered — see deleteName/deleteDiscovered
  const deleting = new Map<string, string[]>()

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
    for (const w of index.byId.values())
      if (w !== wrapper && w.name == wrapper.name && !w.pending_create && !w.adopt_id && !w.deleted)
        if (!survivor || w.id < survivor.id) survivor = w
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
      if (!wrapper.adopt_id) await deps.confirmIndex() // may adopt via registration; rejects to fail the create
      if (wrapper.deleted) return
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
      if (wrapper.adopt_id) {
        const state = payload(wrapper) // merged state (see deps.adopt)
        const adopted = await deps.encryptState(state)
        recordWrite(wrapper.adopt_id, state.text)
        await deps.updateDoc(wrapper.adopt_id, adopted)
        finalizeAdoption(deps.index(), wrapper)
      } else {
        const state = payload(wrapper)
        const id = await deps.createDoc(await deps.encryptState(state))
        recordWrite(id, state.text) // the create's own echo can arrive as added-then-modified
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
            const state = payload(existing)
            const data = await deps.encryptState(state)
            if (!stillCurrent(name, existing)) {
              console.warn(`dropping hidden save for '${name}': wrapper removed or replaced during encryption`)
              return
            }
            try {
              recordWrite(existing.id, state.text)
              await deps.updateDoc(existing.id, data)
            } catch (e) {
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
    applyRemote(name: string | undefined, apply: () => void): Promise<void> {
      if (!name || !chains.has(name)) {
        try {
          apply()
          return Promise.resolve()
        } catch (e) {
          return Promise.reject(e)
        }
      }
      return enqueue(name, undefined, async () => apply()) as Promise<void>
    },

    // LOGICAL deletion of the hidden name the id belongs to ("this store is empty"): removes
    // every same-name record — the canonical wrapper plus any retained duplicates, whose
    // promotion would otherwise resurrect old state — and tombstones the name until the
    // deletion settles, so a same-name document discovered mid-flight (e.g. registered during
    // another task's confirmation) is deleted instead of registered
    deleteName(id: string) {
      const index = deps.index()
      const name = index.byId.get(id)?.name
      if (!name) {
        // unknown id (e.g. already removed): best-effort record deletion
        if (!deps.readonly()) void deleteDocTracked(id).catch(e => console.error('hidden item delete failed:', e))
        return
      }
      const removedList: HiddenWrapper[] = []
      for (const w of [...index.byId.values()])
        if (w.name == name) {
          const { removed } = removeHidden(index, w.id)
          if (removed) {
            removed.deleted = true
            removedList.push(removed)
          }
        }
      if (deps.readonly()) return
      const discovered: string[] = []
      deleting.set(name, discovered)
      const run = async () => {
        try {
          const targets = new Set<string>()
          for (const w of removedList) {
            // by now any preceding create settled: on success the wrapper carries the
            // persistent id (re-keyed even when tombstoned), on failure nothing was persisted
            if (w.pending_create && !w.adopt_id) continue
            targets.add(!w.pending_create ? w.id : (w.adopt_id ?? w.id))
          }
          for (const target of discovered) targets.add(target)
          for (const target of targets)
            await deleteDocTracked(target).catch(e => console.error('hidden item delete failed:', e))
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

    // classification for the remote listener: a pending change whose payload matches one THIS
    // controller wrote, or a removal of a document it deleted, is our own echo and is skipped;
    // everything else — including another tab's work on a wrapper we are still writing — applies
    isOwnWrite(id: string, text: string) {
      return recentWrites.get(id)?.includes(text) ?? false
    },
    isOwnDelete(id: string) {
      return ownDeletes.has(id)
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
