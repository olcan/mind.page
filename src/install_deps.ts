// install-time closure of the runtime autodep parent dependency. the runtime dependency graph
// (itemDeps in src/routes/index.svelte) treats an item's label-prefix parent as its FIRST
// dependency when the item is autodep — a uniquely labeled STRICT ancestor's raw tags include
// '#_autodep' (the tag applies to the carrier's descendants, never to the carrier itself,
// 2026-09-27; a carrier still inherits from a carrying ancestor of its own). both install-time
// dependency loops historically walked text tags only, so an autodep parent absent from the
// text never got installed and the installed closure under-approximated the runtime graph.
// this module is the correction: it decides, from the item text being installed plus local
// state and repo lookups, which parent tag (if any) the install closure must include

import { prefixOf, resolveTag, rootOf } from './lineage.js'

export type LocalAncestor = { autodep: boolean; chat?: boolean } | 'ambiguous' | null

export type AutodepDeps = {
  // resolves a tag against locally installed items: null if no item carries the label,
  // 'ambiguous' if more than one does, else whether the unique item makes ITS descendants
  // adopt their parent: it carries the tag, or adopts (a carrying ancestor of its own), and
  // whether it is a chat item (the runtime's classification; absent means it is not)
  local: (tag: string) => LocalAncestor
  // raw tags of the (lowercased) repo text backing a label-prefix tag, or null if no such file;
  // called at most once per tag per autodepParent call
  fetchRawTags: (tag: string) => Promise<string[] | null>
}

// label prefixes from longest (immediate parent) to shortest, mirroring itemTextChanged
export function labelPrefixes(label: string): string[] {
  const prefixes: string[] = []
  let pos: number
  while ((pos = label.lastIndexOf('/')) >= 0) prefixes.push((label = label.slice(0, pos)))
  return prefixes
}

// returns the label-prefix parent tag that belongs in the install closure, or null when the
// runtime graph cannot include one: the item is not autodep, has no label prefix, or the
// immediate parent resolves nowhere (neither installed nor in the repo) or ambiguously. a
// returned parent may already be installed; callers skip those like any other satisfied
// dependency. ancestors installed locally answer from their runtime flag without a fetch. a
// repo-only ancestor's tag counts only while every longer prefix was locally absent AND
// repo-present: the flag is then a prediction that recursive installation makes that ancestor
// local, and recursion proceeds parent-by-parent only through such levels — a locally present
// prefix (recursion skips installed levels), an ambiguous one, or a repo miss closes further
// repository discovery, while shorter LOCAL unique flags stay consultable past any boundary
// (the runtime inherits from installed ancestors across gaps)
// the tree override of a level (src/lineage.ts's tag parent, from what the seam can see): among the
// level's EXACT hidden tags (raw '#_x' forms resolved relative to its label) the one naming a LOCAL
// chat item under the level's root that is not its immediate textual parent; a target nested under
// the level is a nesting cycle with it, which BLOCKS the override whatever the others are (the
// core's rule: any resolved target in the level's cycle component), so a unique local one leaves
// the textual adoption walk to decide. A target that is not local is UNKNOWN (a repository file cannot be classified before it is
// installed, and it could be a second chat candidate) unless it is one of the runtime's fixed
// special tags, which name features when no item carries the label: the level's decision is then
// undecidable and the whole prospective adoption is declined (null from autodepParent) rather than
// guessed, the runtime deciding on the next reload once the target is installed -- a cold-install
// limitation, recorded, not the same boundary as a missing repository file. A dependency cycle
// between a local target and a repo-only level (which the runtime rejects) is beyond the seam's sight
function levelOverride(deps: AutodepDeps, label: string, rawTags: string[]): string | null | 'unknown' {
  if (!label.includes('/')) return null
  const chats: string[] = [] // the local chat items named, in any root
  let unknown = false // a non-local target named: a chat item or not once installed
  let unknownEligible = false // such a target under the root: the override itself, once installed
  const seen = new Set<string>()
  const eligible = (tag: string) => rootOf(tag) == rootOf(label) && tag != prefixOf(label)
  for (const raw of rawTags) {
    if (!raw.startsWith('#_')) continue
    const tag = resolveTag(label, '#' + raw.slice(2))
    if (tag === undefined || tag == label || seen.has(tag)) continue
    seen.add(tag)
    const local = deps.local(tag) // a local item first: a unique #log or #init is a real target
    if (tag.startsWith(label + '/')) {
      // nested under the level: a unique local one blocks the override (a nesting cycle), an
      // ambiguous one resolves nowhere, an absent one is unknown (it would block once installed)
      if (local === null) unknownEligible = true
      else if (local != 'ambiguous') return null
      continue
    }
    if (local === null) {
      if (SPECIAL_TAGS.has(tag)) continue // absent: a feature marker, never a candidate
      unknown = true
      if (eligible(tag)) unknownEligible = true
    } else if (local != 'ambiguous' && local.chat) chats.push(tag)
  }
  if (unknownEligible) return 'unknown' // it could be the override
  const overrides = chats.filter(eligible)
  if (overrides.length == 0) return null // nothing under the root to override with, whatever the others are
  if (unknown) return 'unknown' // a second chat candidate would cancel the override
  return chats.length == 1 ? overrides[0] : null
}

// the runtime's fixed special tags (altTags): feature markers when no item carries the label
const SPECIAL_TAGS = new Set(
  ['menu', 'context', 'init', 'welcome', 'listen', 'async', 'debug', 'autorun', 'autodep', 'style', 'spell', 'nospell', 'log', 'todo', 'pin'].map(
    t => '#' + t
  )
)

export async function autodepParent(deps: AutodepDeps, label: string, rawTags: string[]): Promise<string | null> {
  const prefixes = labelPrefixes(label)
  if (prefixes.length == 0) return null
  // the item's own override: its tag parent is a text dependency already, nothing to add; an
  // undecidable one declines the adoption
  if (levelOverride(deps, label, rawTags) !== null) return null
  const fetched = new Map<string, string[] | null>()
  const fetchOnce = async (tag: string) => {
    if (!fetched.has(tag)) fetched.set(tag, await deps.fetchRawTags(tag))
    return fetched.get(tag) ?? null
  }
  // the item's OWN #_autodep tag applies to its descendants, not to itself (2026-09-27): only an
  // ancestor's tag (carried, or adopted from a further ancestor) makes the parent a dependency
  let autodep = false
  let repoChain = true // repo discovery open: all longer prefixes locally absent and repo-present
  for (const pfx of prefixes) {
    if (autodep) break
    const local = deps.local(pfx)
    if (local == 'ambiguous') {
      repoChain = false // runtime ignores non-unique labels; recursion cannot traverse them
      continue
    }
    if (local) {
      // a unique local level's flag (it carries, or adopts) summarizes the whole effective
      // ancestry above it, an override of its own included: its answer, true or false, is final
      autodep = local.autodep
      break
    }
    if (!repoChain) continue // locally absent and repository discovery is closed
    const tags = await fetchOnce(pfx)
    if (tags == null) {
      repoChain = false // repo miss: recursion cannot install this level
      continue
    }
    // the level's own carrier makes its descendants adopt whatever its override (the tag applies
    // to the descendants, the override to the level's own place); otherwise a repo-only level
    // that takes an override continues its ancestry at the LOCAL tag parent, whose own flag
    // summarizes that ancestry (it carries, or adopts), and an undecidable one declines the
    // whole adoption
    if (tags.includes('#_autodep')) {
      autodep = true
      break
    }
    const override = levelOverride(deps, pfx, tags)
    if (override == 'unknown') return null
    if (override !== null) {
      const target = deps.local(override)
      autodep = target !== null && target != 'ambiguous' && target.autodep
      break
    }
  }
  if (!autodep) return null
  const parent = prefixes[0]
  const local = deps.local(parent)
  if (local == 'ambiguous') return null // another copy could not join the runtime graph
  if (local) return parent // already installed; caller's existence check skips the install
  return (await fetchOnce(parent)) ? parent : null
}
