// ONE fresh complete hidden read, composed (see the ingress coordinator design in the vault repo,
// notes/design/mind_page_hidden_ingress_coordinator.md).
//
// Two production callers need exactly the same read — `confirmTarget` (a create/fixed-update
// confirmation) and the post-prompt candidate scan (a fixed page whose owner just validated a
// phrase). Both must reconcile the full-account query against the listener records that raced it,
// and both were getting the same five things wrong when they hand-rolled it:
//
// - an ADMITTED intersection is owned by its real delivery, and that is a HISTORICAL fact. The
//   caller's gate is a CURRENT level, so a delivery that finished before the caller re-checked
//   would leave the gate writable and let this older query answer commit over the newer
//   application. It is reported, never merely skipped.
// - a referenced BLIND record's rejection is retained on the record precisely so an operation that
//   captured it aborts before its first mutation. Swallowing it defeats that.
// - an INDETERMINATE point answer is not absence. Only a real not-hidden answer may suppress; a
//   malformed hidden document must fail closed, or a stale target is removed and a duplicate
//   created.
// - the bounded prefix must close on EVERY outcome. A rejected query or a cancellation before the
//   close left the collector registered, retaining every record allocated afterwards.
// - intersections are grouped BY ID: overlapping records for one id are one point read, and
//   independent ids read in parallel.
//
// Everything fallible and impure — the query, decryption, the point read, cancellation — is a
// dependency. Ordering, grouping, fail-closed classification and normalization live here.

import { compareIds } from './hidden.js'
import { normalizeScan, type Classification, type PointAnswer } from './hidden_confirm.js'
import type { ListenerPrefix, ListenerRecord } from './hidden_listener_records.js'

export type ScanRow = { id: string; name: string; wrapper: unknown }

export type HiddenScan = {
  // hidden rows the read establishes, in CANONICAL id order even when the point reads completed
  // out of order — so a pending create cannot adopt a higher duplicate first. Admitted ids are
  // NOT here: their real delivery owns them
  apply: ScanRow[]
  // every id the full query returned, in query order. production publishes corpus membership from
  // this before any further await
  rawIds: string[]
  // ids whose fresh evidence came from an ADMITTED delivery. a confirmation is inconclusive when
  // this is non-empty; a candidate scan simply leaves those ids to their delivery
  admittedIds: string[]
  // raw hidden ids a point answer suppressed (the document is no longer hidden). omission from
  // `apply` already expresses this — the list is here for callers that must distinguish a
  // suppressed row from one that was never in the read at all
  skippedIds: string[]
}

export type ScanDeps = {
  // the bounded listener prefix, opened at FRESH-READ START (see createRecordAllocator)
  openPrefix: () => ListenerPrefix
  // ONE server-confirmed read of the account's hidden documents
  queryHidden: () => Promise<{ id: string; data: unknown }[]>
  // raw membership, published before any further await: a delivery for one of these ids arriving
  // mid-operation is then admitted rather than classified as ordinary
  publishMembership: (ids: string[]) => void
  // THROWS if the operation was cancelled. the caller owns the error so this module carries no
  // corpus dependency
  assertLive: () => void
  // decrypt + purely classify one document from the query result
  classify: (id: string, data: unknown) => Promise<Classification>
  // one fresh point read of `id`, decrypted and purely classified
  pointRead: (id: string) => Promise<Classification>
}

export async function scanHiddenDocuments(deps: ScanDeps): Promise<HiddenScan> {
  const prefix = deps.openPrefix()
  let closed = false
  // idempotent: called at membership publication (collection must stop THERE — a record allocated
  // afterwards is already covered by membership) and again on every exit
  const close = () => {
    if (closed) return
    closed = true
    prefix.close()
  }
  try {
    const docs = await deps.queryHidden()
    deps.assertLive()
    const rawIds = docs.map(d => d.id)
    deps.publishMembership(rawIds)
    close()

    // INTERSECTIONS, grouped by id
    const raw = new Set(rawIds)
    const intersecting = new Map<string, ListenerRecord[]>()
    for (const record of prefix.records()) {
      if (!raw.has(record.id)) continue
      const group = intersecting.get(record.id)
      if (group) group.push(record)
      else intersecting.set(record.id, [record])
    }

    const admitted = new Set<string>()
    const pointAnswers = new Map<string, PointAnswer>()
    await Promise.all(
      [...intersecting].map(async ([id, records]) => {
        if (records.some(r => r.kind == 'admitted')) return void admitted.add(id)
        // its own completion ONLY — never the whole callback, whose other admitted changes may be
        // waiting on a held chain or on this very scan. NOT caught: a blind rejection is retained
        // on the record so this operation aborts before its first mutation
        await Promise.all(records.map(r => r.done))
        deps.assertLive()
        const fresh = await deps.pointRead(id)
        if (fresh.kind == 'indeterminate')
          throw new Error(`hidden document ${id} could not be classified: ${fresh.reason}`)
        pointAnswers.set(
          id,
          fresh.kind == 'hidden'
            ? { kind: 'hidden', name: fresh.wrapper.name, wrapper: fresh.wrapper }
            : { kind: 'not-hidden' }
        )
      })
    )
    deps.assertLive()

    const classified = await Promise.all(docs.map(async d => [d.id, await deps.classify(d.id, d.data)] as const))
    deps.assertLive()
    const rows: ScanRow[] = []
    for (const [id, c] of classified) {
      if (admitted.has(id)) continue // owned by its real delivery
      if (c.kind == 'indeterminate') throw new Error(`hidden document ${id} could not be classified: ${c.reason}`)
      if (c.kind == 'hidden') rows.push({ id, name: c.wrapper.name, wrapper: c.wrapper })
    }
    // a point answer that says HIDDEN for an id the query row classified otherwise is still the
    // FRESHER evidence, and normalizeScan replaces BY ID: the row has to be present for its
    // answer to replace it, or the freshest read would be silently dropped
    for (const [id, point] of pointAnswers)
      if (point.kind == 'hidden' && !admitted.has(id) && !rows.some(r => r.id == id))
        rows.push({ id, name: point.name, wrapper: point.wrapper })

    const { apply } = normalizeScan(rows, pointAnswers)
    const applied = new Set(apply.map(r => r.id))
    return {
      apply,
      rawIds,
      admittedIds: [...admitted].sort(compareIds),
      skippedIds: rows
        .map(r => r.id)
        .filter(id => !applied.has(id))
        .sort(compareIds),
    }
  } finally {
    close()
  }
}
