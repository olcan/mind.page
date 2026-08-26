// hidden-item index transitions (extracted from index.svelte; table-tested in
// tests/unit/hidden.spec.ts). hidden items carry encrypted per-item state (e.g. global stores):
// the index maps document id -> wrapper and name -> the MINIMUM-id wrapper for that name, which
// is the app's duplicate-resolution rule everywhere (initialization sorts by id; remote and
// registration transitions preserve the invariant incrementally). persistence, encryption and
// logging stay with the caller — these functions only decide and update the maps.

// THE id comparator: initialization once sorted with localeCompare while the index compared with
// `<`, so mixed-case firestore ids could disagree about which record is canonical. every ordering
// decision (initialization, name assignment, survivor choice, confirmation) uses this one
export const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export type HiddenWrapper = {
  id: string
  name: string
  item?: any
  // a locally created wrapper not yet persisted (see saveHiddenItem in index.svelte): its name
  // claim must not be displaced, and registration ADOPTS an existing document into it
  pending_create?: boolean | null
  adopt_id?: string | null
  saving?: Promise<string> | null
}

export type HiddenIndex = {
  byId: Map<string, HiddenWrapper>
  byName: Map<string, HiddenWrapper> // minimum-id wrapper per name (see above)
  // documents quarantined THIS SESSION as non-canonical duplicates (see quarantineNonCanonical).
  // nothing on the server marks them, so this lasts only as long as the page: it exists so a
  // record already judged redundant cannot come back through registration, a redelivery or an
  // adoption and resurrect the state it holds.
  // REQUIRED, deliberately: the production adapter rebuilds this object on every call, and when
  // this was optional the set was attached lazily to that temporary and discarded — quarantine
  // silently did nothing. an adapter that cannot forget the field cannot repeat that
  quarantined: Set<string>
}

export type InvalidHidden = {
  wrapper: HiddenWrapper
  // 'malformed' wrappers (unparseable text or missing name) are quarantined: reported and never
  // indexed — converting an unreadable record into absence would be destructive
  reason: 'duplicate' | 'anonymous' | 'orphaned' | 'malformed'
}

// points byName at the wrapper unless a smaller-id wrapper already holds the name; a
// pending_create holder is never displaced (its in-flight save owns the name until adoption)
export function indexByName(index: HiddenIndex, wrapper: HiddenWrapper) {
  const existing = index.byName.get(wrapper.name)
  if (existing?.pending_create) return
  if (!(existing && compareIds(existing.id, wrapper.id) < 0)) index.byName.set(wrapper.name, wrapper)
}

// after a removal or settlement, point byName at the minimum-id wrapper among any remaining
// duplicates (restores the index invariant whenever byName may have lost its holder)
export function reassignName(index: HiddenIndex, name: string) {
  for (const dup of index.byId.values()) {
    if (dup.name != name) continue
    const held = index.byName.get(name)
    if (!held || compareIds(held.id, dup.id) > 0) index.byName.set(name, dup)
  }
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
  for (const item of [...hidden_items].sort((a, b) => compareIds(a.id, b.id))) {
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
): 'adopted' | 'exists' | 'added' | 'quarantined' {
  if (isQuarantined(index, wrapper.id)) return 'quarantined' // judged redundant this session
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
export function applyRemoteAdded(index: HiddenIndex, wrapper: HiddenWrapper): { warning?: string; applied?: boolean } {
  // an ignored delivery reports applied:false so the caller can skip the downstream effects too —
  // returning a bare {} let a quarantined duplicate still drive checkFocus and copy an older
  // canonical store over newer unsaved owner state
  if (isQuarantined(index, wrapper.id)) return { applied: false }
  const warning = index.byName.has(wrapper.name)
    ? 'remote-added hidden item exists locally; conflicts are resolved arbitrarily based on firebase id order'
    : undefined
  index.byId.set(wrapper.id, wrapper)
  indexByName(index, wrapper)
  return { warning, applied: true }
}

export function applyRemoteModified(index: HiddenIndex, wrapper: HiddenWrapper): { warning?: string; applied?: boolean } {
  if (isQuarantined(index, wrapper.id)) return { applied: false } // a redelivery must not reinstate it
  let warning: string | undefined
  const existing = index.byId.get(wrapper.id)
  if (!existing) warning = `remote-modified hidden item missing locally ${wrapper.id}`
  else if (existing.name != wrapper.name)
    // NOTE: the old name's byName entry is deliberately retained (pointing at the stale
    // wrapper) so the older name keeps working locally until reload, as before
    warning = `remote-modified hidden item has new name ${wrapper.name}; older name ${existing.name} will still work locally until reload`
  index.byId.set(wrapper.id, wrapper)
  indexByName(index, wrapper)
  return { warning, applied: true }
}

export function applyRemoteRemoved(index: HiddenIndex, id: string): { removed?: HiddenWrapper } {
  return removeHidden(index, id)
}

// the canonical (name -> live record) map derived purely from byId: byName can hold a STALE
// alias — applyRemoteModified deliberately leaves the old name pointing at a replaced wrapper
// object that is no longer in byId — and trusting it makes a real current record look like a
// duplicate. a pending create holds its name until it settles (its in-flight save owns it)
export function canonicalHolders(index: HiddenIndex): Map<string, HiddenWrapper> {
  const holders = new Map<string, HiddenWrapper>()
  for (const wrapper of index.byId.values()) {
    const held = holders.get(wrapper.name)
    if (!held) {
      holders.set(wrapper.name, wrapper)
      continue
    }
    if (held.pending_create != wrapper.pending_create) {
      if (wrapper.pending_create) holders.set(wrapper.name, wrapper)
      continue
    }
    if (compareIds(wrapper.id, held.id) < 0) holders.set(wrapper.name, wrapper)
  }
  return holders
}

// points byName at the canonical live record for every name that HAS one, so a stale alias can
// never mask a real current wrapper. an alias whose name has no live record is left alone: it
// stays readable until reload (the documented rename behavior) and masks nothing
export function repairNameIndex(index: HiddenIndex) {
  for (const [name, wrapper] of canonicalHolders(index)) index.byName.set(name, wrapper)
}

// recomputes invalid hidden records from the CURRENT index (never from startup snapshots,
// which go stale as remote changes apply — see cleanupInvalidHidden in index.svelte):
// - 'duplicate': a wrapper that is not its name's byName holder (the minimum-id rule keeps the
//   canonical one; the rest are redundant records)
// - 'orphaned': a canonical global_store_<id> wrapper whose owner item is absent per ownerExists
// wrappers with settlement in flight (pending_create/adopt_id) are never
// classified — their state is transitional and the next grant recomputes
export function classifyInvalidHidden(
  index: HiddenIndex,
  ownerExists: (id: string) => boolean
): { wrapper: HiddenWrapper; reason: 'duplicate' | 'orphaned' }[] {
  const invalid: { wrapper: HiddenWrapper; reason: 'duplicate' | 'orphaned' }[] = []
  const holders = canonicalHolders(index) // from live records only — never a byName alias
  for (const wrapper of index.byId.values()) {
    if (wrapper.pending_create || wrapper.adopt_id) continue
    if (holders.get(wrapper.name) !== wrapper) {
      invalid.push({ wrapper, reason: 'duplicate' })
      continue
    }
    const owner = wrapper.name.match(/^global_store_(.+)$/)?.[1]
    if (owner && !ownerExists(owner)) invalid.push({ wrapper, reason: 'orphaned' })
  }
  return invalid
}

// removes non-canonical records from the PROMOTABLE index without touching the server: a
// retained duplicate is the only reason a name could resurrect old state (removing its canonical
// record promotes it), so quarantining is the non-destructive way to get the same guarantee that
// deleting duplicates used to provide. quarantined records stay reported; they are simply no
// longer candidates for promotion or classification
export function quarantineNonCanonical(
  index: HiddenIndex,
  invalid: { wrapper: HiddenWrapper; reason: 'duplicate' | 'orphaned' }[]
) {
  for (const { wrapper, reason } of invalid) {
    if (reason != 'duplicate') continue
    if (index.byName.get(wrapper.name) === wrapper) continue // canonical: never quarantine
    if (index.byId.get(wrapper.id) === wrapper) index.byId.delete(wrapper.id)
    // remembered, so the record cannot be re-indexed by a confirmation or redelivery and then
    // adopted — which would merge its old state back into a store the user has since emptied
    index.quarantined.add(wrapper.id)
  }
}

export const isQuarantined = (index: HiddenIndex, id: string) => index.quarantined.has(id)

// settles a pending create's ADOPTION (its document was found to exist, see saveHiddenItem in
// index.svelte): re-keys the wrapper to the persistent id, clears the pending claim, then
// restores the minimum-id invariant for the name (a smaller-id retained duplicate may now win)
export function finalizeAdoption(index: HiddenIndex, wrapper: HiddenWrapper) {
  // guarded: the entry under the old id can already be a REPLACEMENT (a remote wrapper object
  // keyed to the same id) that must not be evicted while this wrapper settles away
  if (index.byId.get(wrapper.id) === wrapper) index.byId.delete(wrapper.id)
  wrapper.id = wrapper.adopt_id!
  wrapper.pending_create = wrapper.adopt_id = null
  index.byId.set(wrapper.id, wrapper)
  reassignName(index, wrapper.name)
}

// settles a fresh create: re-keys the wrapper to the persistent id and restores the minimum-id
// invariant for the name — a smaller-id duplicate can have arrived remotely while the create was
// in flight, and it must win the name (the cross-client duplicate-resolution rule)
export function finalizeCreate(index: HiddenIndex, wrapper: HiddenWrapper, id: string) {
  if (index.byId.get(wrapper.id) === wrapper) index.byId.delete(wrapper.id) // guarded, see finalizeAdoption
  wrapper.id = id
  // a concurrent confirmation can set adopt_id AFTER this task chose the create branch: clearing
  // only pending_create left a transitional wrapper that classification skips forever. the
  // adopted document becomes an ordinary duplicate and is cleaned up by recomputation
  wrapper.pending_create = wrapper.adopt_id = null
  index.byId.set(id, wrapper)
  reassignName(index, wrapper.name)
}

// removes a wrapper by id and reassigns its name to the minimum-id duplicate, if any
export function removeHidden(index: HiddenIndex, id: string): { removed?: HiddenWrapper } {
  // the record is gone server-side, so the session's judgement about it no longer applies: a
  // document later created under the same id is a new record and must be able to enter
  index.quarantined.delete(id)
  // an ADOPTION in flight toward this id has lost its target. clearing the pointer here is what
  // makes the next attempt re-choose instead of resurrecting a removed document — the adopting
  // wrapper is not `byId.get(id)` (an adoption target is absent from byId until finalization), so
  // nothing below would have touched it, and a generation that inherited the pointer would adopt
  for (const w of index.byId.values()) if (w.adopt_id == id) w.adopt_id = null
  const wrapper = index.byId.get(id)
  if (!wrapper) return {}
  index.byId.delete(wrapper.id)
  if (index.byName.get(wrapper.name) == wrapper) index.byName.delete(wrapper.name)
  reassignName(index, wrapper.name)
  return { removed: wrapper }
}
