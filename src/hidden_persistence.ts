// per-name persistence controller for hidden items (stage 1b of the index.svelte split;
// matrix-tested in tests/unit/hidden_persistence.spec.ts). all writes for a given name run on
// one serialized chain — concurrent updates completing out of order could otherwise leave the
// server at an older state than memory — and every success/failure settles through the index
// transitions in hidden.ts so the name invariant holds. firestore, encryption and the
// server confirmation stay with the caller as injected capabilities.
//
// NOTE: ordering state lives in the controller, but `wrapper.saving` is still mirrored onto the
// wrapper while its chain has in-flight work: item code observes it (e.g. the store_saving
// getter in index.svelte), so it is part of the window contract.

import { finalizeAdoption, reassignName, removeHidden, type HiddenIndex, type HiddenWrapper } from './hidden.js'

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
  const chains = new Map<string, Promise<unknown>>() // per-name write serialization

  // enqueue a write for the name; failures settle inside each task, so the chain always
  // continues; the wrapper mirrors in-flight status via `saving` (see NOTE above)
  function enqueue(name: string, wrapper: HiddenWrapper | undefined, task: () => Promise<void>) {
    const next = (chains.get(name) ?? Promise.resolve()).then(task, task)
    chains.set(name, next)
    if (wrapper) {
      const mirrored = next.then(() => wrapper.id) as Promise<string>
      mirrored.catch(() => {}) // observable to waiters, but never an unhandled rejection
      wrapper.saving = mirrored
    }
    next
      .catch(() => {}) // failures settle inside tasks; the chain itself must never be unhandled
      .then(() => {
        if (chains.get(name) === next) {
          chains.delete(name)
          if (wrapper) wrapper.saving = null
        }
      })
  }

  return {
    // replaces (or creates) the hidden item for the name with the given state; each call
    // snapshots the full state it was given, so a later save carries everything and a failed
    // earlier write is superseded rather than retried
    save(name: string, item: any) {
      const index = deps.index()
      const existing = index.byName.get(name)
      if (existing) {
        existing.item = item
        if (deps.readonly()) return
        const state = payload(existing)
        enqueue(name, existing, async () => {
          try {
            const data = await deps.encryptState(state)
            try {
              await deps.updateDoc(existing.id, data)
            } catch (e) {
              if (!isNotFound(e)) throw e
              // the document was deleted concurrently (e.g. by another client's cleanup): fall
              // back to creating the LATEST full snapshot under a new id
              const created = await deps.createDoc(await deps.encryptState(payload(existing)))
              index.byId.delete(existing.id)
              existing.id = created
              index.byId.set(created, existing)
              reassignName(index, name)
            }
          } catch (e) {
            console.error('hidden item update failed:', e)
          }
        })
        return
      }

      // create: the wrapper claims the name immediately (pending), and the persisted document
      // is either an adoption of an existing one (found during the phrase prompt or the server
      // confirmation) or a fresh create
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
      const state = payload(wrapper) // pre-adoption snapshot; the adopted path re-serializes merged state
      enqueue(name, wrapper, async () => {
        try {
          const data = await deps.encryptState(state) // may prompt; adoption can happen meanwhile
          if (!wrapper.adopt_id) await deps.confirmIndex() // may adopt via registration; rejects to fail the create
          if (wrapper.adopt_id) {
            const adopted = await deps.encryptState(payload(wrapper)) // merged state (see registerHidden)
            await deps.updateDoc(wrapper.adopt_id, adopted)
            finalizeAdoption(deps.index(), wrapper)
          } else {
            const id = await deps.createDoc(data)
            const index = deps.index()
            index.byId.delete(wrapper.id)
            wrapper.id = id
            wrapper.pending_create = null
            index.byId.set(id, wrapper)
          }
        } catch (e) {
          console.error('hidden item create failed:', e)
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
      })
    },

    // removes the hidden item from the index immediately and deletes its document behind the
    // name's chain (a delete during a pending create removes the eventually-persisted document)
    delete(id: string) {
      const { removed } = removeHidden(deps.index(), id)
      if (deps.readonly()) return
      const run = async () => {
        // by the time the chain reaches this task, a preceding create has settled: on success
        // the wrapper carries the persistent id, on failure nothing was persisted
        const target = removed && !removed.pending_create ? removed.id : (removed?.adopt_id ?? removed?.id ?? id)
        if (removed?.pending_create && !removed.adopt_id) return // nothing persisted
        await deps.deleteDoc(target).catch(e => console.error('hidden item delete failed:', e))
      }
      if (removed) enqueue(removed.name, undefined, run)
      else void run()
    },
  }
}
