// owner-store publication and dependent invalidation (extracted from index.svelte; table-tested
// in tests/unit/hidden_publish.spec.ts). a global_store change re-renders its OWNER, but an item
// that embeds the owner (a dependent) keeps its cached render: dependent invalidation keys off
// item text hashes, and a store carries no hash. these helpers schedule the owner's dependents
// exactly once per delivery or publication. persistence, delivery, and rendering stay with the
// caller — this module decides what to compare, assign, and invalidate, and `createStorePublisher`
// is the dependency-injected composition of the controller and startup publication paths plus
// the delivery-side dependent invalidation, so its rows exercise the real callbacks rather than
// a look-alike. the delivery handler keeps its own changed-state assignment.

export type PublishDeps = {
  // the owner's in-memory store (undefined when it holds none)
  current: (id: string) => unknown
  // assigns the owner's in-memory store; the caller decides cloning at its own boundary
  assign: (id: string, state: unknown) => void
  // the owner's dependents; the app's list is already transitive (each item's deps is a closure)
  dependents: (id: string) => readonly string[]
  // invalidates an item's element cache and forces a render (the app's keyed per-item task, so
  // repeated schedules coalesce while an earlier one is still pending)
  invalidate: (id: string) => void
  // structural equality of two store states
  equal: (a: unknown, b: unknown) => boolean
}

/** Schedules each of the owner's dependents once, never the owner itself. */
export function invalidateDependents(deps: PublishDeps, id: string): void {
  const seen = new Set<string>([id])
  for (const dep of deps.dependents(id)) {
    if (seen.has(dep)) continue
    seen.add(dep)
    deps.invalidate(dep)
  }
}

/**
 * Publishes an owner's store when it actually changes, in this order: compare, assign, invalidate
 * the owner, then invalidate each of its dependents once. An unchanged publication assigns and
 * schedules nothing. Returns whether the store changed.
 */
export function publishOwnerStore(deps: PublishDeps, id: string, state: unknown): boolean {
  if (deps.equal(deps.current(id) ?? {}, state ?? {})) return false
  deps.assign(id, state)
  deps.invalidate(id)
  invalidateDependents(deps, id)
  return true
}

export type PublisherDeps = PublishDeps & {
  // whether a LOCAL item id exists
  exists: (id: string) => boolean
  // the local id of a saved id (a fresh item keeps a temporary id in its session)
  localId: (savedId: string) => string
  // the applied hidden index: the store held under a wrapper name, undefined when none
  applied: (name: string) => unknown
  // a deep clone of a store state
  clone: (state: unknown) => unknown
}

/**
 * The composition of the owner-publication paths over the app's adapters: the controller's
 * `syncOwner` (a private copy handed over), its `reconcileOwner` (the applied index over the
 * owner's copy once an owed change settled; only a truthy applied state, cloned only when it
 * differs, as before the extraction), the startup registration of an orphaned store whose owner
 * arrived (the `|| {}` fallback of that path, as before), and the delivery pass (the owner's
 * dependents, before the delivery handler's early returns; the handler's own changed-state
 * assignment stays in the handler).
 */
export function createStorePublisher(deps: PublisherDeps) {
  const owner = (name: string): string | null => {
    const saved = name.match(/^global_store_(.+)$/)?.[1]
    if (!saved) return null
    const local = deps.localId(saved)
    return deps.exists(local) ? local : null
  }
  const publishApplied = (local: string, applied: unknown) => {
    // compare BEFORE cloning: equal echoes are the common case and stores can be large
    if (deps.equal(deps.current(local) ?? {}, applied ?? {})) return false
    return publishOwnerStore(deps, local, deps.clone(applied))
  }
  return {
    syncOwner(name: string, state: unknown): void {
      const local = owner(name)
      if (local) publishOwnerStore(deps, local, state)
    },
    reconcileOwner(name: string): void {
      const local = owner(name)
      if (!local) return
      const applied = deps.applied(name)
      if (applied) publishApplied(local, applied) // truthy only: a falsey stored value is not published
    },
    registerOwner(name: string): void {
      const local = owner(name)
      if (local) publishApplied(local, deps.applied(name) || {}) // a falsey stored value becomes {}
    },
    deliver(local: string): void {
      invalidateDependents(deps, local)
    },
  }
}
