// install-time closure of the runtime autodep parent dependency. the runtime dependency graph
// (itemDeps in src/routes/index.svelte) treats an item's label-prefix parent as its FIRST
// dependency when the item is autodep — its own raw tags include '#_autodep', or any uniquely
// labeled ancestor's do (the flag inherits down the label hierarchy). both install-time
// dependency loops historically walked text tags only, so an autodep parent absent from the
// text never got installed and the installed closure under-approximated the runtime graph.
// this module is the correction: it decides, from the item text being installed plus local
// state and repo lookups, which parent tag (if any) the install closure must include

export type LocalAncestor = { autodep: boolean } | 'ambiguous' | null

export type AutodepDeps = {
  // resolves a tag against locally installed items: null if no item carries the label,
  // 'ambiguous' if more than one does, else the unique item's runtime autodep flag (which
  // already incorporates that item's own ancestors)
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
export async function autodepParent(deps: AutodepDeps, label: string, rawTags: string[]): Promise<string | null> {
  const prefixes = labelPrefixes(label)
  if (prefixes.length == 0) return null
  const fetched = new Map<string, string[] | null>()
  const fetchOnce = async (tag: string) => {
    if (!fetched.has(tag)) fetched.set(tag, await deps.fetchRawTags(tag))
    return fetched.get(tag) ?? null
  }
  let autodep = rawTags.includes('#_autodep')
  let repoChain = true // repo discovery open: all longer prefixes locally absent and repo-present
  for (const pfx of prefixes) {
    if (autodep) break
    const local = deps.local(pfx)
    if (local == 'ambiguous') {
      repoChain = false // runtime ignores non-unique labels; recursion cannot traverse them
      continue
    }
    if (local) {
      if (local.autodep) autodep = true
      repoChain = false // recursion skips installed levels, so nothing deeper can materialize
      continue
    }
    if (!repoChain) continue // locally absent and repository discovery is closed
    const tags = await fetchOnce(pfx)
    if (tags == null) repoChain = false // repo miss: recursion cannot install this level
    else if (tags.includes('#_autodep')) autodep = true
  }
  if (!autodep) return null
  const parent = prefixes[0]
  const local = deps.local(parent)
  if (local == 'ambiguous') return null // another copy could not join the runtime graph
  if (local) return parent // already installed; caller's existence check skips the install
  return (await fetchOnce(parent)) ? parent : null
}
