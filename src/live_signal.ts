// THE LIVE SERVER SIGNAL (2026-09-26): `window._server_current` says whether the latest items
// snapshot came from the server (not the cache) AND its application has landed, so item code
// that writes a store from its in-memory copies (the todoer's order save and unsnooze sweep)
// can tell a currently served corpus from a stale one: the sticky `_server_confirmed` says a
// current server revision applied ONCE, which a tab keeps after its stream died (a resumed
// tab, a lost link) and while a reconnect's catch-up is still being applied. every receipt
// numbers itself and drops the flag (a cache receipt: the SDK's online state went offline, its
// metadata-only snapshot rides the listener's `includeMetadataChanges`; a server receipt: its
// changes are not applied yet), and a server receipt raises it from the same ordered lease that
// carries the confirmation (index.svelte reserveHiddenAuthority: the lease's `done`, after the
// receipt's ordered effect is consumed), only while it is still the latest receipt and the
// ingress runs, since an older application completing after a newer receipt says nothing
// about the copies now, and a stopped ingress applies nothing further. receipt-time
// publication was the first draft's mistake (review 0 of `todoer_residuals`: a reconnect's
// snapshot raised the flag while the expired snooze it would replace was still in the queue)
export type Receipt = { n: number; current: boolean }

// the next receipt: numbered after the previous, current when the snapshot is the server's
export function receiveSnapshot(previous: Receipt, fromCache: boolean): Receipt {
  return { n: previous.n + 1, current: !fromCache }
}

// whether a sealed application raises the signal: the applied receipt is a server one, still
// the latest, and the ingress runs
export function raisesLiveSignal(facts: { applied: Receipt; latest: Receipt; stopped: boolean }): boolean {
  return facts.applied.current && facts.applied.n == facts.latest.n && !facts.stopped
}
