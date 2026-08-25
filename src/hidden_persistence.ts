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
  // NOTE: there is no write-provenance map and no own-delete set any more. both existed to
  // answer "is this delivery our own echo?" by matching payloads — which needed a size cap (an
  // evicted old echo then applied as remote state), consumption rules, and failure bookkeeping.
  // the document REVISION answers it exactly: an echo of our own write carries the revision we
  // already hold, so the listener's echo check rejects it (see isOwnEcho)

  // payloads this controller has ISSUED and the server has not acknowledged yet, per document.
  // this is the whole echo story: firestore delivers a document's changes in commit order, so a
  // delivery is either newer state (apply it) or the echo of a write we issued (skip it), and an
  // exact payload match identifies the latter. entries leave when the write settles, so there is
  // no cap to evict a still-live identity — the failure that made the previous provenance map
  // unsound. it deliberately does NOT try to order two writers: that is the server's job, and
  // the advisory revision that pretended to do it on the client is gone
  const outstanding = new Map<string, Set<string>>()
  // the WRAPPER whose save task is queued but has not built its payload yet, per name. a queued
  // task serializes that wrapper's current state, so a second save in the same window coalesces
  // into it instead of issuing an identical write. keyed on the wrapper, not just the name: if
  // the record was replaced in between, the queued task will be dropped by stillCurrent and the
  // new state must get a task of its own rather than coalescing into a doomed one
  const pendingSaves = new Map<string, HiddenWrapper>()
  const addOutstanding = (id: string, text: string) => {
    const texts = outstanding.get(id) ?? new Set<string>()
    texts.add(text)
    outstanding.set(id, texts)
    // the entry is released when its ECHO is seen (isOwnEcho consumes it), not when the server
    // acknowledges: the acknowledgement can beat the delivery, and clearing on it left our own
    // create looking like a remote record — which replaced the wrapper whose next save was still
    // queued, and that save was then dropped as stale. this returns the FAILURE release only
    return () => {
      texts.delete(text)
      if (!texts.size) outstanding.delete(id)
    }
  }

  // remote records observed at RECEIPT but whose application is queued (possibly behind the very
  // create that needs to know about them): serialization must not HIDE a same-name survivor from
  // a create/adopt decision, which would create a duplicate the listener then has to clean up
  const inbox = new Map<string, HiddenWrapper>() // document id -> record as received
  const inboxRemoved = new Set<string>() // ids whose removal was received (never adopt these)

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
      if (w.pending_create || w.adopt_id || inboxRemoved.has(w.id)) return
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
      if (wrapper.adopt_id) {
        const state = payload(wrapper) // merged state (see deps.adopt)
        const text = state.text // encryptState MUTATES state and nulls text
        const settled = addOutstanding(wrapper.adopt_id, text)
        try {
          // adoption DOES await its write: the create is not settled until the document it
          // adopted actually carries the merged state, and finalizing onto an unacknowledged
          // document would let a failure strand the wrapper on an id it never wrote
          await deps.updateDoc(wrapper.adopt_id, await deps.encryptState(state)).catch(e => {
            settled()
            throw e
          })
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
        const state = payload(wrapper)
        const id = deps.newDocId()
        const settled = addOutstanding(id, state.text) // BEFORE issuing: see newDocId above
        await deps.createDoc(id, await deps.encryptState(state)).catch(e => {
          settled()
          throw e
        })
        finalizeCreate(deps.index(), wrapper, id) // restores minimum-id if a lower-id duplicate arrived
      }
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
      throw e // keep the mirrored saving promise's rejection observable to waiters
    }
  }

  // true while the wrapper is a valid target for a queued save: it can have been deleted
  // (tombstone), removed by a failed create's cleanup, or displaced from byId by a remote
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
          const text = state.text // encryptState MUTATES state and nulls text
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
          const settled = addOutstanding(existing.id, text)
          deps
            .updateDoc(existing.id, data)
            .catch(e => {
              settled()
              if (!isNotFound(e)) return void console.error('hidden item update failed:', e)
              // the document was removed server-side: recover as a create-like transition, on
              // this name's chain rather than inline (we are outside it by now)
              if (!stillCurrent(name, existing)) return
              deps.invalidateAuthority(`hidden update target ${existing.id} not found`)
              existing.pending_create = true
              existing.adopt_id = null
              enqueue(name, existing, () =>
                persistCreate(existing).catch(err => void console.error('hidden item create failed:', err))
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
      // by the echo check, and anything else is exactly what should win
      return acquire(0)
    },

    // records a remote record/removal at RECEIPT so create/adopt decisions can see it before its
    // application runs (which may be queued behind the very create that needs it)
    // true when this delivery is the echo of a write this controller ISSUED and the server has
    // not acknowledged yet. firestore delivers a document's changes in commit order, so anything
    // else is genuinely newer state and must be applied — including another tab's write that
    // arrives while our own is still pending, which the old blanket in-flight skip lost
    isOwnEcho(id: string, text: string) {
      const texts = outstanding.get(id)
      if (!texts?.has(text)) return false
      texts.delete(text) // CONSUMED: a second delivery of the same payload is not ours
      if (!texts.size) outstanding.delete(id)
      return true
    },

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
    // NOTE: the controller no longer deletes anything. emptying a store is an ordinary
    // revisioned save of `{}` (see save_global_store), and invalid records are quarantined out
    // of the promotable index rather than removed from the server (see quarantineNonCanonical).
    // that retired name tombstones, mid-flight discovery drains, causally-later `born` stamps,
    // the expected-name validation, and both delete entry points — all of which existed only to
    // make client-side destructive writes safe against concurrent renames and late deliveries
  }
}
