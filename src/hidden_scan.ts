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
import type { Classification, ParsedWrapper, PointAnswer } from './hidden_confirm.js'
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
}
// NOTE there is no `skippedIds`. OMISSION from `apply` already carries everything either caller
// does with a suppressed row, and a list nothing reads is a claim of coverage the code does not
// make (review 73).

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
  // the operation's active cancellation: never fulfils, REJECTS on cancellation. it is RACED with
  // the query, because `assertLive()` can only be consulted between awaits — a network read that
  // never settles would otherwise hold this scan (and its registered prefix collector, retaining
  // every later listener record) for the page's lifetime, long after the caller was released
  cancellation: Promise<never>
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
    // RACED, not merely rechecked afterwards: see ScanDeps.cancellation
    const docs = await Promise.race([deps.queryHidden(), deps.cancellation])
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
        // AN ADMITTED RECORD OWNS THE WHOLE ID, including any blind record for it in the same
        // group. this scan will not touch that id at all, so there is nothing for a blind
        // rejection to abort — and awaiting one would add a dependency on a callback whose other
        // admitted changes may be waiting on this very scan
        if (records.some(r => r.kind == 'admitted')) return void admitted.add(id)
        // its own completion ONLY — never the whole callback. NOT caught: a blind rejection is
        // retained on the record so this operation aborts before its first mutation
        await Promise.all(records.map(r => r.done))
        deps.assertLive()
        const fresh = await Promise.race([deps.pointRead(id), deps.cancellation])
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

    // ONE PRECEDENCE PASS PER DOCUMENT, in strict evidence order. classifying every raw row FIRST
    // and filtering afterwards let stale evidence decide: a malformed or undecryptable raw row
    // rejected the whole scan even when a fresh point read said definitively hidden or not-hidden,
    // and an admitted id could reject during raw classification although its real delivery owns it
    // and the scan had already promised never to apply it (review 73)
    const rows: ScanRow[] = []
    await Promise.all(
      docs.map(async d => {
        if (admitted.has(d.id)) return // (1) owned by its delivery: never classified
        const point = pointAnswers.get(d.id)
        // (2) a point answer REPLACES the raw row entirely — applying the older row after the
        // fresher answer moves the index backward again
        if (point) {
          if (point.kind == 'hidden') rows.push({ id: d.id, name: point.name, wrapper: point.wrapper })
          return // not-hidden SUPPRESSES, with zero production-body calls
        }
        // (3) only now is the raw row the best evidence there is
        const c = await deps.classify(d.id, d.data)
        if (c.kind == 'indeterminate') throw new Error(`hidden document ${d.id} could not be classified: ${c.reason}`)
        if (c.kind == 'hidden') rows.push({ id: d.id, name: c.wrapper.name, wrapper: c.wrapper })
      })
    )
    deps.assertLive()
    // (4) CANONICAL id order, once, even though the point reads and decrypts completed out of it —
    // so a pending create cannot adopt a higher duplicate first
    rows.sort((a, b) => compareIds(a.id, b.id))
    return { apply: rows, rawIds, admittedIds: [...admitted].sort(compareIds) }
  } finally {
    close()
  }
}

// NOTE the delivery-side FINAL-STATE resolution moved to src/hidden_delivery.ts
// (readHiddenMembership + applyAdmittedDelivery), where it sits beside the admission decision that
// makes it reachable — round 76 showed the two halves must not live apart. This module keeps the
// full-scan composition; both share the owner hidden-set read through their injected deps.
