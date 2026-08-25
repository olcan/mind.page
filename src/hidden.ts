// hidden-item index transitions (extracted from index.svelte; table-tested in
// tests/unit/hidden.spec.ts). hidden items carry encrypted per-item state (e.g. global stores):
// the index maps document id -> wrapper and name -> the MINIMUM-id wrapper for that name, which
// is the app's duplicate-resolution rule everywhere (initialization sorts by id; remote and
// registration transitions preserve the invariant incrementally). persistence, encryption and
// logging stay with the caller — these functions only decide and update the maps.

export type HiddenWrapper = {
  id: string
  name: string
  item?: any
  // a locally created wrapper not yet persisted (see saveHiddenItem in index.svelte): its name
  // claim must not be displaced, and registration ADOPTS an existing document into it
  pending_create?: boolean | null
  adopt_id?: string | null
  saving?: Promise<string> | null
  // tombstone set by a delete while controller work is in flight (see hidden_persistence.ts):
  // settlement transitions re-key the wrapper (so the queued delete can target the persisted
  // document) but never reinsert it into the maps
  deleted?: boolean
}

export type HiddenIndex = {
  byId: Map<string, HiddenWrapper>
  byName: Map<string, HiddenWrapper> // minimum-id wrapper per name (see above)
}

export type InvalidHidden = {
  wrapper: HiddenWrapper
  // 'malformed' wrappers (unparseable text or missing name) are quarantined: reported but never
  // auto-deleted, and never indexed — converting an unreadable record into absence would be
  // destructive
  reason: 'duplicate' | 'anonymous' | 'orphaned' | 'malformed'
}

// points byName at the wrapper unless a smaller-id wrapper already holds the name; a
// pending_create holder is never displaced (its in-flight save owns the name until adoption)
export function indexByName(index: HiddenIndex, wrapper: HiddenWrapper) {
  const existing = index.byName.get(wrapper.name)
  if (existing?.pending_create) return
  if (!(existing && existing.id < wrapper.id)) index.byName.set(wrapper.name, wrapper)
}

// after a removal or settlement, point byName at the minimum-id wrapper among any remaining
// duplicates (restores the index invariant whenever byName may have lost its holder)
export function reassignName(index: HiddenIndex, name: string) {
  for (const dup of index.byId.values())
    if (dup.name == name && !((index.byName.get(name)?.id as any) < dup.id)) index.byName.set(name, dup)
}

// builds the index from the account's decrypted hidden items (initialization): items are indexed
// in ascending id order so the minimum-id wrapper wins each name, and invalid wrappers are
// returned for the caller to log (and possibly delete after initialization — a policy decision
// that stays with the caller):
// - 'duplicate': a larger-id wrapper under an already-indexed name
// - 'anonymous': any hidden item on the anonymous account
// - 'orphaned': a global_store_<id> whose item <id> no longer exists — only decidable when the
//   account was fully loaded (checkOrphans false on fixed pages, which load a shared subset)
export function buildHiddenIndex(
  index: HiddenIndex,
  hidden_items: { id: string; text: string }[],
  { anonymous, checkOrphans, existingIds }: { anonymous: boolean; checkOrphans: boolean; existingIds: Set<string> }
): InvalidHidden[] {
  const invalid: InvalidHidden[] = []
  for (const item of [...hidden_items].sort((a, b) => a.id.localeCompare(b.id))) {
    let wrapper: HiddenWrapper
    try {
      wrapper = Object.assign(JSON.parse(item.text), { id: item.id })
      if (typeof wrapper.name != 'string' || !wrapper.name) throw new Error('missing name')
    } catch (e) {
      invalid.push({ wrapper: { id: item.id, name: '' }, reason: 'malformed' })
      continue
    }
    if (index.byName.has(wrapper.name)) {
      // retained in byId (canonical byName keeps the minimum id) so a later authoritative
      // cleanup can still promote it if the canonical document is removed first
      index.byId.set(wrapper.id, wrapper)
      invalid.push({ wrapper, reason: 'duplicate' })
      continue
    }
    if (anonymous) {
      invalid.push({ wrapper, reason: 'anonymous' })
      continue
    }
    if (checkOrphans && wrapper.name.match(/^global_store_/)) {
      const id = wrapper.name.replace(/^global_store_/, '')
      if (!existingIds.has(id)) {
        invalid.push({ wrapper, reason: 'orphaned' })
        continue
      }
    }
    index.byId.set(wrapper.id, wrapper)
    index.byName.set(wrapper.name, wrapper)
  }
  return invalid
}

// registers one decrypted hidden document (phrase validation on fixed pages, or the
// create-confirmation path in saveHiddenItem): a pending create that already claimed the name
// ADOPTS the document (update instead of create, existing state filled in under the pending
// changes via the caller-provided merge); otherwise the document is indexed under the
// minimum-id rule
export function registerHidden(
  index: HiddenIndex,
  wrapper: HiddenWrapper,
  mergeAdopted: (pending: HiddenWrapper, found: HiddenWrapper) => void
): 'adopted' | 'exists' | 'added' {
  const existing = index.byName.get(wrapper.name)
  if (existing) {
    if (existing.pending_create && !existing.adopt_id) {
      existing.adopt_id = wrapper.id
      mergeAdopted(existing, wrapper)
      return 'adopted'
    }
    // retain the record; the name keeps its minimum-id (or pending) holder
    index.byId.set(wrapper.id, wrapper)
    indexByName(index, wrapper)
    return 'exists'
  }
  index.byId.set(wrapper.id, wrapper)
  index.byName.set(wrapper.name, wrapper)
  return 'added'
}

// remote listener transitions; returned warnings are for the caller to log
export function applyRemoteAdded(index: HiddenIndex, wrapper: HiddenWrapper): { warning?: string } {
  const warning = index.byName.has(wrapper.name)
    ? 'remote-added hidden item exists locally; conflicts are resolved arbitrarily based on firebase id order'
    : undefined
  index.byId.set(wrapper.id, wrapper)
  indexByName(index, wrapper)
  return { warning }
}

export function applyRemoteModified(index: HiddenIndex, wrapper: HiddenWrapper): { warning?: string } {
  let warning: string | undefined
  const existing = index.byId.get(wrapper.id)
  if (!existing) warning = `remote-modified hidden item missing locally ${wrapper.id}`
  else if (existing.name != wrapper.name)
    // NOTE: the old name's byName entry is deliberately retained (pointing at the stale
    // wrapper) so the older name keeps working locally until reload, as before
    warning = `remote-modified hidden item has new name ${wrapper.name}; older name ${existing.name} will still work locally until reload`
  index.byId.set(wrapper.id, wrapper)
  indexByName(index, wrapper)
  return { warning }
}

export function applyRemoteRemoved(index: HiddenIndex, id: string): { removed?: HiddenWrapper } {
  return removeHidden(index, id)
}

// recomputes invalid hidden records from the CURRENT index (never from startup snapshots,
// which go stale as remote changes apply — see cleanupInvalidHidden in index.svelte):
// - 'duplicate': a wrapper that is not its name's byName holder (the minimum-id rule keeps the
//   canonical one; the rest are redundant records)
// - 'orphaned': a canonical global_store_<id> wrapper whose owner item is absent per ownerExists
// wrappers with settlement in flight (pending_create/adopt_id) or tombstoned are never
// classified — their state is transitional and the next grant recomputes
export function classifyInvalidHidden(
  index: HiddenIndex,
  ownerExists: (id: string) => boolean
): { wrapper: HiddenWrapper; reason: 'duplicate' | 'orphaned' }[] {
  const invalid: { wrapper: HiddenWrapper; reason: 'duplicate' | 'orphaned' }[] = []
  for (const wrapper of index.byId.values()) {
    if (wrapper.pending_create || wrapper.adopt_id || wrapper.deleted) continue
    if (index.byName.get(wrapper.name) !== wrapper) {
      invalid.push({ wrapper, reason: 'duplicate' })
      continue
    }
    const owner = wrapper.name.match(/^global_store_(.+)$/)?.[1]
    if (owner && !ownerExists(owner)) invalid.push({ wrapper, reason: 'orphaned' })
  }
  return invalid
}

// settles a pending create's ADOPTION (its document was found to exist, see saveHiddenItem in
// index.svelte): re-keys the wrapper to the persistent id, clears the pending claim, then
// restores the minimum-id invariant for the name (a smaller-id retained duplicate may now win)
export function finalizeAdoption(index: HiddenIndex, wrapper: HiddenWrapper) {
  // guarded: the entry under the old id can already be a REPLACEMENT (a remote wrapper object
  // keyed to the same id) that must not be evicted while this wrapper settles away
  if (index.byId.get(wrapper.id) === wrapper) index.byId.delete(wrapper.id)
  wrapper.id = wrapper.adopt_id!
  wrapper.pending_create = wrapper.adopt_id = null
  if (wrapper.deleted) return // deleted while in flight: re-keyed for the queued delete, not reinserted
  index.byId.set(wrapper.id, wrapper)
  reassignName(index, wrapper.name)
}

// settles a fresh create: re-keys the wrapper to the persistent id and restores the minimum-id
// invariant for the name — a smaller-id duplicate can have arrived remotely while the create was
// in flight, and it must win the name (the cross-client duplicate-resolution rule)
export function finalizeCreate(index: HiddenIndex, wrapper: HiddenWrapper, id: string) {
  if (index.byId.get(wrapper.id) === wrapper) index.byId.delete(wrapper.id) // guarded, see finalizeAdoption
  wrapper.id = id
  wrapper.pending_create = null
  if (wrapper.deleted) return // deleted while in flight: re-keyed for the queued delete, not reinserted
  index.byId.set(id, wrapper)
  reassignName(index, wrapper.name)
}

// removes a wrapper by id and reassigns its name to the minimum-id duplicate, if any
export function removeHidden(index: HiddenIndex, id: string): { removed?: HiddenWrapper } {
  const wrapper = index.byId.get(id)
  if (!wrapper) return {}
  index.byId.delete(wrapper.id)
  if (index.byName.get(wrapper.name) == wrapper) index.byName.delete(wrapper.name)
  reassignName(index, wrapper.name)
  return { removed: wrapper }
}
