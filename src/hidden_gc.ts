// explicit /_gc maintenance (design: notes/design/mind_page_hidden_gc.md in the vault repo;
// reviews 129-130): candidate projection over a COORDINATED scan's classified rows, and the
// exact preview/execution intersection the confirm modal authorizes. pure — the scan has
// already fail-closed indeterminate rows and excluded admitted ids (scanHiddenDocuments), so
// rows arrive parsed as (id, name); deletion stays in the command's transactional helper

export type GcRow = { id: string; name: string }
export type GcTarget = { id: string; name: string }

// unique canonical ownerless global_store_* records only (design §2.4): a name held by MORE
// than one server document is excluded entirely — deleting the canonical beside a same-name
// duplicate would let the old record become canonical on reload (the resurrection class), and
// deleting the group would widen v1 into duplicate cleanup
export function gcCandidates(rows: GcRow[], ownerExists: (id: string) => boolean): GcTarget[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  return rows.filter(row => {
    if (counts.get(row.name) != 1) return false
    const owner = row.name.match(/^global_store_(.+)$/)?.[1]
    return !!owner && !ownerExists(owner)
  })
}

// the modal authorizes an exact preview: execution targets only the (id, name) pairs present in
// BOTH sets — direct equality, deliberately no key encoding (review 130 §2.5: neither ids nor
// stored names are constrained to exclude any delimiter character)
export function gcIntersect(preview: GcTarget[], execution: GcTarget[]): GcTarget[] {
  return execution.filter(t => preview.some(p => p.id === t.id && p.name === t.name))
}
