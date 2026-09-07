// the WELCOME BOUNDARY (2026-09-07): item welcome hooks (index.svelte: settleCorpusForWelcome)
// wait for the corpus to SETTLE. it settles when the listener published the server confirmation —
// a current server revision applied, see markServerConfirmed — or when no confirmation can be
// expected for now: the device reports offline, or the wait exceeded the timeout (a slow link,
// sync disabled, a stopped ingress). a fallback is permission to run the hooks, NOT evidence that
// the cached texts are current: the hooks then run on the cached corpus with
// `window._server_confirmed` still false, so item code that compares texts with an external
// source (the pusher's mirror verification, the updater, the sharer) keeps waiting for the
// confirmation, which can still arrive later — and whole-item attribute persistence
// (attrSaveStep below) waits for the confirmation itself, never for a fallback.
// a returning device initializes from its persistent cache, and hooks that ran on that stale
// corpus marked, updated or shared items by saving the whole item over the server's newer
// revision (the 2026-09-07 reversion); the boundary keeps the hooks off that corpus for as long
// as a confirmation can be expected
export const WELCOME_CONFIRMATION_TIMEOUT_MS = 10_000

export type Settlement = 'confirmed' | 'offline' | 'timeout'

// resolves with how the corpus settled; `online` is the device's report at the welcome step
// (navigator.onLine): false means no confirmation can come, so the hooks run at once
export function settleCorpus(deps: {
  confirmation: Promise<void>
  online: boolean
  timeoutMs: number
  delay: (ms: number) => Promise<void>
}): Promise<Settlement> {
  if (!deps.online) return Promise.resolve('offline')
  return Promise.race([
    deps.confirmation.then((): Settlement => 'confirmed'),
    deps.delay(deps.timeoutMs).then((): Settlement => 'timeout'),
  ])
}

// one turn of the HELD attribute save (index.svelte _update_attr_async, a 250 ms item task): the
// `editable` and `shared` setters mirror the in-memory value into `attr` and save the WHOLE item,
// text included, so the mirror-and-save runs only on a server-confirmed corpus. settlement by a
// fallback (offline, timeout) must not release it: a save released after a fallback wrote the
// old cached text over the server's newer revision. 'retry' holds the turn (poll again),
// 'unchanged' drops it — the value is already persisted, or a remote revision reset the pending
// toggle meanwhile (the accepted trade: a toggle made before the confirmation is lost when the
// server revision lands first; visible and redoable) — and 'save' mirrors and saves. while the
// device stays offline a toggle therefore lives in memory only, and persists once the
// confirmation arrives after reconnection (or is lost on a reload before that)
export function attrSaveStep<T>(turn: {
  confirmed: boolean // window._server_confirmed
  current: T // the in-memory value (this[prop])
  stored: T // the persisted mirror (attr[prop])
  equal: (a: T, b: T) => boolean
}): 'retry' | 'unchanged' | 'save' {
  if (!turn.confirmed) return 'retry'
  return turn.equal(turn.current, turn.stored) ? 'unchanged' : 'save'
}
