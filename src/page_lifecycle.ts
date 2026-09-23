// the PAGE-CACHE RESTORE (2026-09-23). a page the browser parks in its back/forward cache — a back
// navigation, and on iOS every background tab Safari suspends (WebKit's page-suspension SPI runs
// the same BackForwardCache::suspendPage path, which fires the event whether or not the page is
// otherwise cacheable) — receives `pagehide` first, and the Firestore SDK's own pagehide handler
// (IndexedDbPersistence, @firebase/firestore 4.17) shuts its client down right there: the client
// is marked zombied, the async queue enters restricted mode (every later operation returns a
// promise that never settles) and persistence closes. Nothing restarts it at `pageshow`: a
// restored page keeps the item set it was hidden with, receives no snapshot and no listener
// error, and can save nothing — silently, until a reload. the SDK exposes no restart, so a reload
// is the recovery, and the restore decides one of three things:
// - `none`: an ordinary load's pageshow (not persisted), or a client on the memory cache (the
//   shared origin, see client-globals.ts), which installs no pagehide handler and survives;
// - `reload`: nothing unsaved — reload at once, the fastest way back to a live client;
// - `prompt`: an edit is unsaved (the text differs from the saved text) — ask first, since the
//   reload discards it and the dead client could never have saved it either.
export type RestoreAction = 'reload' | 'prompt' | 'none'

export function restoreAction(facts: {
  persisted: boolean // event.persisted: restored from the back/forward cache
  persistentCache: boolean // the client runs the persistent (IndexedDB) cache, whose pagehide handler shuts it down
  unsaved: boolean // some item's text differs from its saved text (the beforeunload predicate)
}): RestoreAction {
  if (!facts.persisted || !facts.persistentCache) return 'none'
  return facts.unsaved ? 'prompt' : 'reload'
}

// sessionStorage key: the reload a restore makes stamps itself for the next load's init log, so
// the app console of the reloaded page says why it reloaded (the owner's confirmation on a phone,
// where the restore itself leaves no trace)
export const RESTORED_RELOAD_KEY = 'mindpage_restored_reload'
