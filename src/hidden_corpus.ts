// THE CORPUS SEAM (see the ingress coordinator design in the vault repo,
// notes/design/mind_page_hidden_ingress_coordinator.md).
//
// A corpus operation is a fresh COMPLETE hidden server read — the fixed-owner candidate scan, and
// `confirmTarget`'s per-name confirmation. Only three things live here, and they are the three the
// design makes normative:
//
// 1. ONE settle-only tail. Corpus operations serialize against each other; a rejected one must
//    never poison the next, and the tail must fulfil even when the operation is cancelled.
// 2. ONE current completion boundary. A caller that needs "every corpus operation so far has
//    settled" awaits this rather than reaching for a dynamic snapshot frontier, which would
//    absorb post-exposure callbacks that are themselves waiting on the boundary.
// 3. ONE pending-hidden-id membership set. The first result's RAW membership is published BEFORE
//    the point reads are awaited, so the listener can admit a same-id delivery that arrives while
//    the scan is still in flight. It is cleared on EVERY outcome — success, failure and stop —
//    because a membership set that outlives its operation admits deliveries forever.
//
// What is deliberately NOT here: fetching, decryption, classification, the index, the owner, and
// the confirmation commit. The adapter fetches/decrypts/classifies/normalizes and the persistence
// controller commits through a callback that runs INSIDE the serialized turn — an adapter-only
// commit reproduces the a/m schedule the design records. This module only orders that work and
// owns the membership window.

export class CorpusStopped extends Error {
  constructor() {
    super('hidden corpus stopped')
  }
}

export type CorpusRun = {
  // publishes this operation's raw membership so the listener can admit intersecting deliveries.
  // callable ONCE, before any point read is awaited, and inert after stop
  publishMembership(ids: Iterable<string>): void
  // whether the corpus has stopped. every await-crossing continuation rechecks it, and the body
  // must perform no mutation after it turns true
  cancelled(): boolean
}

export function createHiddenCorpus() {
  // SERIALIZATION. settle-only: a rejected or cancelled operation must not stop the next one
  let tail: Promise<void> = Promise.resolve()
  // THE ACTIVE PRODUCER'S completion, installed only when a body actually starts — NOT the queue
  // tail. a delivery admitted by A's membership must be released when A finishes, not when some
  // unrelated B enqueued behind A also finishes: besides the latency, B may itself depend on the
  // listener record that is waiting for this boundary, which is a cycle
  let currentBoundary: Promise<void> = Promise.resolve()
  // the ids any in-flight corpus operation has published. NOT per operation: bodies are strictly
  // serialized and the listener asks one boolean question
  let membership = new Set<string>()
  let stopped = false
  let signalStop!: () => void
  const stopSignal = new Promise<void>(res => (signalStop = res))

  return {
    // is this id part of an in-flight corpus read? the listener's admission predicate consults
    // this so a delivery arriving mid-scan is admitted rather than treated as ordinary
    isPendingHiddenId: (id: string) => membership.has(id),
    // the ACTIVE producer's completion. fulfils on stop as well as on completion, so a caller
    // awaiting it is released rather than held for the page's lifetime
    boundary: () => currentBoundary,

    // run one corpus operation on the tail. the CALLER's promise carries the outcome: it rejects
    // with the body's own error, or with CorpusStopped. the tail and the boundary are private
    // fulfilled mirrors — that split is the whole contract, and making the caller unwrap a
    // fulfilled outcome union gave every call site a chance to continue after a failed read
    run<T>(body: (run: CorpusRun) => Promise<T>): Promise<T> {
      let finish!: () => void
      const completed = new Promise<void>(res => (finish = res))
      // STOP RELEASES THE MIRRORS IMMEDIATELY, even while the body is held at a point read or a
      // human-length phrase prompt. the late body stays responsible for checking cancelled()
      void stopSignal.then(finish)
      const turn = tail.then(async (): Promise<T> => {
        // the LIVE sticky bit, checked when this turn actually begins — not the value captured
        // when it was enqueued, which let an operation queued before stop run its server read
        // after it
        if (stopped) throw new CorpusStopped()
        currentBoundary = completed
        let published = false
        try {
          return await body({
            publishMembership(ids) {
              if (published) throw new Error('corpus membership already published')
              published = true
              if (stopped) return // a late continuation must not reopen a window stop closed
              membership = new Set(ids)
            },
            cancelled: () => stopped,
          })
        } finally {
          // CLEARED ON EVERY OUTCOME: a membership set that outlives its operation admits those
          // ids forever and makes the gate permanently pending
          membership = new Set()
          finish()
        }
      })
      const caller = Promise.race([
        turn,
        stopSignal.then((): never => {
          throw new CorpusStopped()
        }),
      ])
      caller.catch(() => {}) // observed by the caller; never an unhandled rejection here
      // serialize on COMPLETION, which stop also fulfils. NOTE this is indistinguishable from
      // following `turn` by any test, and deliberately so: before stop the two settle together,
      // and after stop every queued caller rejects at the race regardless of whether the tail
      // ever advances. `completed` is kept because it states the intent — this operation is done
      // for scheduling purposes — not because a schedule can tell them apart
      tail = completed.then(() => {})
      return caller
    },

    // sticky and page-scoped. releases the caller, the current boundary and the tail immediately,
    // makes every later run reject without executing its body, and closes the membership window
    stop() {
      if (stopped) return
      stopped = true
      membership = new Set()
      signalStop()
    },
  }
}

export type HiddenCorpus = ReturnType<typeof createHiddenCorpus>
