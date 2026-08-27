// COMPLETION RECORDS and the GLOBAL BLIND LANE for the items listener (see the ingress coordinator
// design in the vault repo, notes/design/mind_page_hidden_ingress_coordinator.md).
//
// This is the exact mechanism index.svelte uses — not a testable copy of it. Firestore access,
// decryption, classification, the item reducers and every piece of UI state stay in the listener;
// what lives here is only the part whose ORDERING and LIFETIME rules were repeatedly getting them
// wrong: which work may run when, who terminalizes it, and what the callback's authority lease is
// allowed to conclude from the result.
//
// Two lanes, and they are not symmetric:
//
// - ORDINARY (blind) mutation bodies run on ONE global settle-only lane, in callback and document
//   receipt order. Callback preparation is deliberately NOT serialized any more, so this lane is
//   what stops ordinary effects from gaining readiness-order concurrency.
// - ADMITTED work never touches that lane. It runs on the coordinator's per-id delivery tail,
//   behind the lane position captured AT ITS OWN RECEIPT. Reserving in document order is what
//   leaves an admitted change free of a LATER blind one — the relaxation the candidate deadlock
//   needs — while a blind change received EARLIER still runs first.
//
// The record types are DISCRIMINATED on purpose: only a blind record can be given a body, and only
// an admitted record can be given an Apply. A round-65 defect where an admitted document reached
// the blind path became an uninitialized resolver and a swallowed TypeError; here it cannot be
// written at all.

export type Outcome = 'applied' | 'blocked'

// the coordinator's DeliveryHandle, narrowed to what a record needs
export type RecordHandle = {
  ready(apply: () => Promise<void>): void
  block(): void
  done: Promise<Outcome>
}

type Base = {
  id: string
  // RESOLVES when this record's work is done, REJECTS when it failed. an admitted rejection is
  // what fails the callback's authority lease; a blind rejection is retained on the record (a
  // corpus operation that captured it must be able to abort) but is deliberately NOT allowed to
  // fail the lease — plaintext ingress is fail-soft
  done: Promise<void>
  // PREPARATION finalization: the terminal path for a record no branch scheduled work for. an
  // admitted record with an Apply scheduled is deliberately left alone here — it is owned by its
  // handle, including while its handoff still waits on the lane position
  finish(): void
  // STOP. unconditional: an admitted record is blocked whether or not it scheduled work, because
  // a scheduled record can still be sitting open behind a held predecessor and would otherwise
  // keep `landed` — and its context — pending until that predecessor eventually released. the
  // coordinator's CAS makes this a no-op for a running or terminal handle
  cancel(): void
}

export type AdmittedRecord = Base & {
  kind: 'admitted'
  handle: RecordHandle
  // the lane tail as it stood at THIS record's receipt position
  blindPredecessor: Promise<void>
  // hands the handle its Apply once the captured lane position has passed. safe to call at any
  // point during preparation: the handle is not blocked while a schedule is outstanding
  schedule(apply: () => Promise<void>): void
}

export type BlindRecord = Base & {
  kind: 'blind'
  // hands this record's reserved lane slot its mutation body. `undefined` rather than `void`
  // deliberately: TypeScript accepts an async function where `() => void` is expected, and the
  // lane does NOT await the result — corpus code about to treat `record.done` as a causal
  // boundary must not be able to hand it a promise it silently drops
  run(body: () => undefined): void
}

export type ListenerRecord = AdmittedRecord | BlindRecord

export type Batch = {
  records: ListenerRecord[]
  // every record's outcome, over the FIXED array. Promise.allSettled snapshots its iterable, so
  // this is built at allocation and never appended to — a record pushed during preparation could
  // be missed by an aggregate that already ran, terminalizing the context while work was live
  landed: Promise<PromiseSettledResult<void>[]>
  // true once any admitted record has rejected. the lease reads this; a blind rejection never
  // contributes
  failed(results: PromiseSettledResult<void>[]): boolean
  // stop: terminalize every record that has not already finished. a running admitted Apply owns
  // its own outcome and is untouched
  abort(): void
}

export type AllocationRequest = {
  id: string
  // an admitted document MUST carry its handle; a blind one MUST NOT. the caller decides admission
  handle?: RecordHandle
}

export function createRecordAllocator(deps: {
  // an unexpected blind body failure. the lane consumes it so later slots still run, but the
  // record keeps its rejection
  onBlindError: (id: string, error: unknown) => void
}) {
  // ONE lane for the page, across callbacks
  let blindTail: Promise<void> = Promise.resolve()

  return {
    // allocate every record for one callback, SYNCHRONOUSLY and in document order, before any
    // preparation starts
    // `revoke` is the CALLBACK's own state-only revocation, passed per batch. it must not be a
    // fresh outside-callback ordinal: if C1 reserves first, C2 reserves a newer candidate and C1
    // fails late, a fresh ordinal would stale C2 — the design requires C1 to invalidate only
    // through its OWN receipt so C2 can heal it
    allocate(requests: AllocationRequest[], revoke: (reason: string) => void): Batch {
      const records: ListenerRecord[] = []
      for (const { id, handle } of requests) {
        let settled = false
        let resolve!: () => void
        let reject!: (e: unknown) => void
        const done = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)))
        done.catch(() => {}) // observed through `landed`; never an unhandled rejection

        if (handle) {
          // ADMITTED. the handle's terminal outcome IS this record's outcome — whatever produces
          // it: a normal application, an abort, or a stop. handle.done FULFILLS with 'blocked', so
          // the mapping to a rejecting record is explicit rather than inferred
          const blindPredecessor = blindTail
          let scheduled = false
          void handle.done.then(outcome => {
            if (settled) return
            settled = true
            if (outcome == 'applied') return resolve()
            // EXACTLY ONE lease effect for a blocked delivery, at the record boundary — branch
            // local calls miss the abort and orchestration paths. try/finally so a throwing hook
            // cannot leave `done` pending
            try {
              revoke(`hidden change for ${id} could not be applied`)
            } catch (e) {
              console.error('revocation hook failed:', id, e)
            } finally {
              reject(new Error(`hidden ingress: ${id} could not be applied`))
            }
          })
          records.push({
            kind: 'admitted',
            id,
            done,
            handle,
            blindPredecessor,
            schedule(apply) {
              scheduled = true
              void blindPredecessor.then(() => handle.ready(apply))
            },
            finish() {
              // only a record with nothing scheduled is blocked here. one WITH an Apply scheduled
              // is owned by handle.done, including while its handoff is still waiting on the lane
              // position — blocking it there is what silently discarded valid work in round 58
              if (!scheduled) handle.block()
            },
            cancel() {
              handle.block() // unconditional: see the type
            },
          })
        } else {
          // BLIND. its slot is reserved NOW, at this position, so a record that never receives a
          // body still settles its slot and the lane continues
          let giveBody!: (body: (() => undefined) | null) => void
          const bodyGiven = new Promise<(() => undefined) | null>(res => (giveBody = res))
          // the RAW result carries the body's failure to the record; the lane takes the caught
          // continuation, so one bad body cannot stop every later ordinary change
          const rawResult = blindTail.then(async () => {
            const body = await bodyGiven
            if (!body) return
            body()
          })
          blindTail = rawResult.catch(() => {})
          void rawResult.then(
            () => {
              if (settled) return
              settled = true
              resolve()
            },
            e => {
              if (settled) return
              settled = true
              deps.onBlindError(id, e)
              reject(e) // RETAINED on the record even though the lane consumed it
            }
          )
          records.push({
            kind: 'blind',
            id,
            done,
            run(body) {
              giveBody(body)
            },
            finish() {
              giveBody(null) // release an unused slot: the lane must continue
            },
            cancel() {
              giveBody(null)
            },
          })
        }
      }

      const landed = Promise.allSettled(records.map(r => r.done))
      return {
        records,
        landed,
        // ONLY an admitted rejection fails the callback. a blind body's failure is listener
        // fail-soft by design and must not invalidate hidden authority
        failed: results => results.some((r, i) => r.status == 'rejected' && records[i].kind == 'admitted'),
        abort() {
          for (const r of records) r.cancel()
        },
      }
    },
  }
}

export type RecordAllocator = ReturnType<typeof createRecordAllocator>
