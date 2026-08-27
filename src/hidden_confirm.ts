// PURE planning for `confirmTarget` (see the ingress coordinator design in the vault repo,
// notes/design/mind_page_hidden_ingress_coordinator.md). Nothing here fetches, decrypts, mutates
// an index, publishes to an owner, or touches the coordinator — it turns a classified answer plus
// the local slice into a PLAN the persistence controller executes synchronously, in one turn.
//
// Keeping this pure is what makes the hard rules testable as tables: the affected-closure
// projection, canonical ordering, and the read-start marker proof are all decisions, not effects.

import { compareIds } from './hidden.js'

// the writer's own unacknowledged create, retained until its SDK promise settles. WRAPPER-EXACT,
// never id-exact: registerHidden replaces the indexed object on a fresh same-id observation, and
// an id-only exemption would mistake that independent replacement — or a same-id rename — for the
// original local create
export type Marker = { id: string; wrapper: unknown; token: number }

// what a fresh complete read said about ONE document
export type ClassifiedRow =
  | { id: string; kind: 'hidden'; name: string; wrapper: unknown }
  // the server does not have it, or has it as a non-hidden document. both mean the same thing to
  // a name slice: this id is not part of any hidden name any more
  | { id: string; kind: 'absent' }

// what the applied index currently holds for the name being confirmed
export type LocalRow = { id: string; name: string; wrapper: unknown }

export type TargetPlan = {
  // ids to remove from the target name's slice, in CANONICAL id order. reconciliation replaces the
  // whole nonpending server-backed slice: invalidating only the selected candidate is not enough,
  // because the index deliberately retains same-name duplicates and removeHidden promotes the next
  // stale one, which can beat the current server record and receive the very update this prevents
  remove: string[]
  // fresh target-name rows to register, in CANONICAL id order, so a pending create cannot adopt a
  // higher duplicate first
  register: { id: string; name: string; wrapper: unknown }[]
  // set whenever omission preservation USED the read-start proof. the controller must
  // compare-and-set it immediately before the first mutation: if it settled while the answer was
  // in flight, the whole result is inconclusive with zero effects — EVEN IF a fresh lower row
  // would eventually be selected. that is a different fact from the one below, and deriving it
  // from local/answer/marker at the call site would defeat the point of a pure planner
  preservedMarker?: Marker
  // set only when that preserved wrapper is also the FINAL selected target. the writer carries
  // this into the no-await issue token; an independently observed row, or a fresh lower one that
  // wins selection, is server evidence in its own right and needs no dependency
  requiredMarker?: Marker
}
// NOTE there is no `resetBaseline` field. `register.length == 0` IS the baseline-reset branch —
// with only an omitted, marker-preserved wrapper there is no fresh registration to perform the
// rebase/publication, so the pending projection must still reset once. And `register[0]?.id` is
// the canonical eligible FRESH target for stale-adopt_id clearing. Both are already here.

/**
 * Builds the target-name slice plan.
 *
 * `answer` is the complete classified read, keyed by id. `local` is the complete NONPENDING,
 * SERVER-BACKED slice for the confirmed name — not every applied-index row: a pending create is
 * preserved by the controller, not judged here. `marker` is the read-start proof, captured after
 * the corpus predecessor and immediately before the query.
 */
export function planTargetSlice({
  name,
  local,
  answer,
  marker,
}: {
  name: string
  local: LocalRow[]
  answer: Map<string, ClassifiedRow>
  marker?: Marker
}): TargetPlan {
  const remove: string[] = []
  const register: { id: string; name: string; wrapper: unknown }[] = []
  let preservedMarker: Marker | undefined

  // ---- the LOCAL side: every row the name currently holds is judged by the fresh answer ----
  for (const row of local) {
    const fresh = answer.get(row.id)
    if (fresh && fresh.kind == 'hidden' && fresh.name == name) continue // still ours: kept below
    if (fresh) {
      // absent, or hidden under a DIFFERENT name. either way it is absent FROM THIS NAME, which is
      // all this plan may conclude: passing the actual other-name row through would mutate a name
      // outside this confirmation's affected closure, on a chain it does not hold
      remove.push(row.id)
      continue
    }
    // OMITTED from the answer. normally that means gone — but a create this writer issued and the
    // server has not yet published is legitimately omitted, and removing it would delete a record
    // that exists. the proof is the READ-START marker, and it must match the exact wrapper: the
    // token may have cleared while the answer was in flight, and a live-at-plan-time lookup would
    // see nothing, synthesize absence, and remove from a stale negative
    if (marker && marker.id == row.id && marker.wrapper === row.wrapper) {
      preservedMarker = marker // preserved BECAUSE of the proof: the controller must CAS it
      continue
    }
    remove.push(row.id)
  }

  // ---- the FRESH side: rows the answer says belong to this name ----
  for (const row of answer.values()) {
    if (row.kind != 'hidden' || row.name != name) continue // outside the affected closure
    register.push({ id: row.id, name: row.name, wrapper: row.wrapper })
  }

  remove.sort(compareIds)
  register.sort((a, b) => compareIds(a.id, b.id))

  // the marker dependency is PROVENANCE, not blanket capture: it is carried only when the
  // preserved row is the one the plan actually selects. an independently observed `m`, or a fresh
  // lower `a` that wins selection, is server evidence in its own right and needs no dependency —
  // carrying one anyway would force a needless reconfirmation
  const survivors = [...register.map(r => r.id), ...(preservedMarker ? [preservedMarker.id] : [])].sort(compareIds)
  const selected = survivors[0]
  const requiredMarker = preservedMarker && selected == preservedMarker.id ? preservedMarker : undefined

  return { remove, register, preservedMarker, requiredMarker }
}

// ---- point-answer normalization -------------------------------------------------------------
// A post-initialization scan intersecting the live listener takes ONE fresh point read per id. The
// application is deliberately ASYMMETRIC (round 54).

export type PointAnswer =
  | { kind: 'hidden'; name: string; wrapper: unknown }
  // shared-visible, absent, or nonshared. all three mean the same thing here
  | { kind: 'not-hidden' }

export type NormalizedScan = {
  // rows entering hidden registration through the production apply body, in CANONICAL id order
  // even when the point reads completed out of order — so a pending create cannot adopt a higher
  // duplicate first
  apply: { id: string; name: string; wrapper: unknown }[]
  // stale raw-hidden rows that are merely SUPPRESSED. zero production-body calls: a blind change
  // is by definition neither hidden nor outstanding when received, so its completed ordinary task
  // or existing deferral owns visible state — replaying the visible side through an extracted body
  // would bypass hasLocalIntent/deferRemoteChange and overwrite an unsaved edit the live callback
  // deliberately deferred
  suppress: string[]
}

/**
 * Applies point answers over a raw scan result. Each answer REPLACES its raw entry — collected
 * first and applied once, because applying a fresh answer and then iterating the older full-query
 * row moves the index backward again.
 */
export function normalizeScan(
  raw: { id: string; name: string; wrapper: unknown }[],
  answers: Map<string, PointAnswer>
): NormalizedScan {
  const apply: { id: string; name: string; wrapper: unknown }[] = []
  const suppress: string[] = []
  for (const row of raw) {
    const point = answers.get(row.id)
    if (!point) {
      apply.push(row) // no intersection: the raw row stands
      continue
    }
    if (point.kind == 'hidden') apply.push({ id: row.id, name: point.name, wrapper: point.wrapper })
    else suppress.push(row.id)
  }
  apply.sort((a, b) => compareIds(a.id, b.id))
  suppress.sort(compareIds)
  return { apply, suppress }
}
