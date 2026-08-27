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

export type CorpusOutcome<T> = { kind: 'ok'; value: T } | { kind: 'cancelled' } | { kind: 'failed'; error: unknown }

export type CorpusRun<T> = {
  // publishes this operation's raw membership so the listener can admit intersecting deliveries.
  // callable ONCE, before any point read is awaited
  publishMembership(ids: Iterable<string>): void
  // whether this operation has been cancelled (stop). every await-crossing continuation rechecks
  // it, and the operation must perform no mutation after it turns true
  cancelled(): boolean
}

export function createHiddenCorpus() {
  // settle-only: a rejected or cancelled operation must not stop the next one
  let tail: Promise<void> = Promise.resolve()
  // the ids any in-flight corpus operation has published. NOT per operation: the listener asks one
  // question — "is this id part of a corpus read that has not finished?" — and operations do not
  // overlap, because they run on the tail
  let membership = new Set<string>()
  let stopped = false
  let cancelCurrent: (() => void) | undefined

  return {
    // is this id part of an in-flight corpus read? the listener's admission predicate consults
    // this so a delivery arriving mid-scan is admitted rather than treated as ordinary
    isPendingHiddenId: (id: string) => membership.has(id),
    // every corpus operation so far has settled. a caller that must not overtake the corpus awaits
    // this exactly once; it does not absorb work queued after the call
    boundary: () => tail,

    // run one corpus operation on the tail. `body` receives the run handle; its membership window
    // opens when it publishes and closes when the operation settles, whatever the outcome
    run<T>(body: (run: CorpusRun<T>) => Promise<T>): Promise<CorpusOutcome<T>> {
      let published = false
      let cancelled = stopped // a run created after stop is born cancelled
      const settled = tail.then(async (): Promise<CorpusOutcome<T>> => {
        if (cancelled) return { kind: 'cancelled' }
        cancelCurrent = () => (cancelled = true)
        const run: CorpusRun<T> = {
          publishMembership(ids) {
            if (published) throw new Error('corpus membership already published')
            published = true
            // BEFORE the point reads are awaited: a same-id delivery arriving during the scan
            // must be admitted, not classified as ordinary
            membership = new Set(ids)
          },
          cancelled: () => cancelled,
        }
        try {
          const value = await body(run)
          // a cancelled operation reports cancellation even if its body returned a value: the
          // caller must not commit from a read taken across a stop
          return cancelled ? { kind: 'cancelled' } : { kind: 'ok', value }
        } catch (error) {
          return cancelled ? { kind: 'cancelled' } : { kind: 'failed', error }
        } finally {
          // CLEARED ON EVERY OUTCOME. a membership set that outlives its operation admits every
          // later delivery for those ids forever, which makes the gate permanently pending
          membership = new Set()
          cancelCurrent = undefined
        }
      })
      // the TAIL never carries the outcome: the next operation runs whatever happened to this
      // one. `settled` cannot reject BY CONSTRUCTION — every path through the body returns an
      // outcome value — so a two-arm handler here would be unfalsifiable rather than protective
      tail = settled.then(() => {})
      return settled
    },

    // sticky. cancels the operation in flight and makes every later run cancelled without
    // executing its body — while still FULFILLING the tail and the boundary, so a caller awaiting
    // either is released rather than hanging for the page's lifetime
    stop() {
      stopped = true
      cancelCurrent?.()
      membership = new Set()
    },
  }
}

export type HiddenCorpus = ReturnType<typeof createHiddenCorpus>
