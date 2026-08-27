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
  // SERIALIZATION. each operation's two-arm fulfilled mirror is its slot: a rejected or cancelled
  // operation must not stop the next one
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
  // ONE active cancellation, replaced each turn and dropped when it ends. a shared never-resolved
  // signal accumulated two reactions PER RUN that a completed run could not detach, retaining
  // every fixed-page confirmation until page stop
  let cancelActive: ((error: unknown) => void) | undefined

  return {
    // ONE accessor, and the only safe shape: it answers "is this id in an in-flight corpus read?"
    // AND hands back that producer's boundary in the same call. two coupled reads invited looking
    // the boundary up LATER — after decrypt or preparation — by which time producer A may have
    // finished and unrelated producer B become active, so the delivery either misses A or waits
    // for B and creates a dependency cycle. the listener calls this synchronously at receipt and
    // stores the promise; the eventual Apply awaits that stored value, never a fresh lookup.
    // FULFILS on failure and on stop as well as on success, so a waiter is released rather than
    // held for the page's lifetime
    pendingBoundary: (id: string) => (membership.has(id) ? currentBoundary : undefined),

    // run one corpus operation on the tail. the CALLER's promise carries the outcome: it rejects
    // with the body's own error, or with the stop cause. the tail and the boundary are private
    // fulfilled mirrors — that split is the whole contract, and making the caller unwrap a
    // fulfilled outcome union gave every call site a chance to continue after a failed read
    run<T>(body: (run: CorpusRun) => Promise<T>): Promise<T> {
      const turn = tail.then(async (): Promise<T> => {
        // the LIVE sticky bit, checked when this turn actually BEGINS — not the value captured
        // when it was enqueued, which let an operation queued before stop run its server read
        // after it
        // a QUEUED turn always gets the ordinary stop outcome: the cause belongs to the operation
        // that stopped itself, and handing it to unrelated queued callers would report someone
        // else's commit failure as their own
        if (stopped) throw new CorpusStopped()
        currentBoundary = mirror
        let published = false
        // the active cancellation: stop rejects THIS, releasing a body held at a point read or a
        // human-length phrase prompt
        const cancelled = new Promise<never>((_, reject) => (cancelActive = reject))
        cancelled.catch(() => {}) // it is raced, not always observed
        try {
          return await Promise.race([
            body({
              publishMembership(ids) {
                if (published) throw new Error('corpus membership already published')
                published = true
                if (stopped) return // a late continuation must not reopen a window stop closed
                membership = new Set(ids)
              },
              cancelled: () => stopped,
            }),
            cancelled,
          ])
        } finally {
          // CLEARED ON EVERY OUTCOME: a membership set that outlives its operation admits those
          // ids forever and makes the gate permanently pending
          membership = new Set()
          cancelActive = undefined
        }
      })
      // the two-arm fulfilled mirror IS this operation's serializer slot and its boundary
      const mirror = turn.then(
        () => {},
        () => {}
      )
      tail = mirror
      return turn
    },

    // sticky and page-scoped. `cause` is the ACTIVE operation's own fatal error when it stops
    // itself: without it, resolving a shared signal queued its reaction before the body's
    // rejection could win the race, so a postcommit failure that entered sticky stop and rethrew
    // reported CorpusStopped instead of the error the caller has to see
    stop(cause?: unknown) {
      if (stopped) return
      stopped = true
      membership = new Set()
      // computed here, not retained: it is consumed in this same call. checking arguments.length
      // rather than `cause !== undefined` matters because JavaScript can legally throw undefined,
      // and an ordinary external stop must not be misread as an active `undefined` cause
      cancelActive?.(arguments.length > 0 ? cause : new CorpusStopped())
    },
  }
}

export type HiddenCorpus = ReturnType<typeof createHiddenCorpus>
