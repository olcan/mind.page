// The v0 SLOT-AND-PROVENANCE bookkeeping (review 90 §§2.3-2.4), extracted from the component so
// its exact microtask and concurrent-decrypt schedules are table-tested. It owns two decisions:
//
// - GUARDING A RESOLVED SLOT (§2.3): `Promise.resolve` yields even on an already-resolved value,
//   so a lifecycle clear or a newer establishment can land in that continuation gap. The caller
//   captures the session generation and the pending slot identity BEFORE awaiting and asks this
//   module afterwards: a changed generation or a slot that is no longer the awaited flight (or
//   its own resolved value) is SUPERSEDED — the old value is never returned or republished. The
//   writer-provenance refusal is a separate verdict, decided AFTER ownership passes, so refusing
//   a write never damages the candidate an authenticating reader is using.
//
// - PROVISIONAL READER AUTHENTICATION (§2.4): "unestablished for writes" and "not yet
//   authenticated by any reader" are different states. The provisional candidate is cleared as a
//   wrong phrase only when ALL of its current read attempts have settled with at least one REAL
//   authentication failure and no success; one success marks it authenticated, after which a
//   corrupt/tampered row can no longer erase a correct reader key. Writers stay refused until
//   the session ESTABLISHES (established()), regardless of reader authentication. Lifecycle
//   clears and establishment replace the record, making completions of older attempts inert.

export type SlotVerdict = 'ok' | 'superseded' | 'refuse-write'

export function createV0Provenance() {
  // the provisional candidate and its read-attempt accounting; null when no provisional value
  // exists (nothing published by the fallback, or establishment/lifecycle replaced it)
  let record: { value: string; authenticated: boolean; open: number; sawAuthFailure: boolean } | null = null

  return {
    /** The reader-only fallback published `value` into the in-memory slot without establishment. */
    markProvisional(value: string): undefined {
      record = { value, authenticated: false, open: 0, sawAuthFailure: false }
      return undefined
    },
    /** The session established (publishV0/adopt): provenance is superseded; older attempts inert. */
    established(): undefined {
      record = null
      return undefined
    },
    /** Lifecycle clear (sign-out, principal change, invalidate): forget everything. */
    clear(): undefined {
      record = null
      return undefined
    },
    /** True while `value` is the (unestablished) provisional candidate. */
    isProvisional(value: string): boolean {
      return record != null && record.value === value
    },
    /**
     * A v0 decrypt is starting under `value`. Returns a settle token when the value is the
     * current provisional candidate (null otherwise — established or foreign values need no
     * accounting). The token is bound to THIS record: completions after a clear/replacement are
     * inert.
     */
    beginRead(value: string): { settle: (outcome: 'ok' | 'auth-failed' | 'other') => 'keep' | 'clear-candidate' } | null {
      if (!record || record.value !== value) return null
      const mine = record
      mine.open++
      let settled = false
      return {
        settle: outcome => {
          if (settled) return 'keep'
          settled = true
          if (record !== mine) return 'keep' // replaced meanwhile: this completion is inert
          mine.open--
          if (outcome == 'ok') mine.authenticated = true
          if (outcome == 'auth-failed') mine.sawAuthFailure = true
          // the WRONG-CANDIDATE decision waits for every overlapping attempt: cleared only when
          // all settled, at least one real authentication failure, and no success anywhere
          if (mine.open == 0 && mine.sawAuthFailure && !mine.authenticated) {
            record = null
            return 'clear-candidate'
          }
          return 'keep'
        },
      }
    },
    /**
     * The post-await verdict for a resolved acquisition (review 90 §2.3). `generationChanged`
     * and `slotCurrent` are computed by the caller from the values it captured before awaiting:
     * the slot is current when it still holds the awaited flight or that flight's own resolved
     * value. Ownership is decided FIRST; the writer refusal never masks a supersession and never
     * clears anything.
     */
    guardResolved(input: { resolved: string; generationChanged: boolean; slotCurrent: boolean; forWrite: boolean }): SlotVerdict {
      if (input.generationChanged || !input.slotCurrent) return 'superseded'
      if (input.forWrite && record != null && record.value === input.resolved) return 'refuse-write'
      return 'ok'
    },
  }
}
export type V0Provenance = ReturnType<typeof createV0Provenance>
