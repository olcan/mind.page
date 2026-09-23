// the PAGE-CACHE RESTORE (2026-09-23). a page the browser parks in its back/forward cache — a back
// navigation, and on iOS every background tab Safari suspends (WebKit's page-suspension SPI runs
// the same BackForwardCache::suspendPage path, which fires the event whether or not the page is
// otherwise cacheable) — receives `pagehide` first, and the Firestore SDK's own pagehide handler
// (IndexedDbPersistence.attachWindowUnloadHook, @firebase/firestore 4.17) takes one of two
// branches on its client right there, by the UA. first, on every browser, it marks the client
// zombied (a localStorage entry the other tabs read as "closed without finishing its cleanup").
// the RESTRICTED branch — isSafari(), a UA with `Safari` and without `Chrome`, that also matches
// /(?:Version|Mobile)\/1[456]/: every iPhone WebKit browser, Safari, Chrome and Firefox alike,
// through the frozen `Mobile/15E148` token (none of them carries `Chrome`), and Safari 14, 15
// and 16 on Mac and iPad through `Version/1[456]` — puts the async queue in restricted mode with
// the queued work purged: every later operation returns a promise that never settles, the
// shutdown() the handler enqueues next included, so persistence stays open (the branch's point,
// WebKit bug 226547) and the zombie mark stays. the SHUTDOWN branch — every other UA: Chromium
// and Firefox anywhere, Safari on Mac and iPad outside 14-16 — keeps the queue live and runs that
// shutdown() on it: the metadata refresher cancelled, the visibility and pagehide handlers
// detached, the primary lease released and the client metadata deleted in one IndexedDB
// transaction, SimpleDb closed, and, once that transaction committed, the zombie mark removed
// again (it covers a shutdown the page freeze cuts short); the queue and the connection live on,
// so a later write can still settle, while the tab is out of the multi-tab protocol for good. on
// every browser the multi-tab WebStorageSharedClientState shuts down at pagehide too (its
// `storage` listener and its client entry removed). nothing registers `pageshow`: a restored
// page keeps the item set it was hidden with, receives no snapshot and no listener error, and on
// the restricted branch can save nothing — silently, until a reload. the SDK's restart is
// terminate() plus a fresh initializeFirestore(); the app reloads instead, since every listener
// and the item state would need rebuilding, and the restore decides one of three things:
// - `none`: an ordinary load's pageshow (not persisted), or a client on the memory cache (the
//   shared origin, see client-globals.ts), which installs no pagehide handler and survives;
// - `reload`: nothing unsaved — reload at once, the fastest way back to a live client;
// - `prompt`: an edit is unsaved (an item's text differs from its saved text, or an open editor
//   holds typed text) — ask first, since the reload discards it and the dead client could never
//   have saved it either.
export type RestoreAction = 'reload' | 'prompt' | 'none'

export function restoreAction(facts: {
  persisted: boolean // event.persisted: restored from the back/forward cache
  persistentCache: boolean // the client runs the persistent (IndexedDB) cache, whose pagehide handler leaves it dead
  // an item's text differs from its saved text (the beforeunload predicate), or an OPEN editor's
  // typed text differs from its item's text: the editor writes the textarea into item.editorText
  // live (ZWSP-augmented, see Editor.svelte onInput), while item.text is assigned only when
  // editing ends (onItemEditing in index.svelte), so the first test alone is false mid-edit
  unsaved: boolean
}): RestoreAction {
  if (!facts.persisted || !facts.persistentCache) return 'none'
  return facts.unsaved ? 'prompt' : 'reload'
}

// sessionStorage key: the reload a restore makes stamps itself for the next load, whose init log
// says why it reloaded (console.debug: on a phone, readable only through a tethered Web Inspector)
// and whose window._restored_reload_at holds the stamp (readable from any console, or an item),
// since the restore itself leaves no trace. the stamp is diagnostic only: storage access can throw
// (Safari's "Block All Cookies"), so both ends guard it and never gate the recovery on it
export const RESTORED_RELOAD_KEY = 'mindpage_restored_reload'
