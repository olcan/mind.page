// the PAGE-CACHE RESTORE (2026-09-23). a page the browser parks in its back/forward cache — a back
// navigation, and on iOS every background tab Safari suspends (WebKit's page-suspension SPI runs
// the same BackForwardCache::suspendPage path, which fires the event whether or not the page is
// otherwise cacheable) — receives `pagehide` first, and the Firestore SDK's own pagehide handler
// (IndexedDbPersistence.attachWindowUnloadHook, @firebase/firestore 4.17) leaves its client dead
// right there. the handler marks the client zombied on every browser, then takes one of two
// branches: on an iPhone WebKit browser (isSafari(): a UA with `Safari` and without `Chrome`, that
// also matches /(?:Version|Mobile)\/1[456]/ — every iPhone WebKit browser does, through the frozen
// `Mobile/15E148` token; iPad Safari sends a desktop UA and takes the other branch) it puts the
// async queue in restricted mode with the queued work purged, so every later operation returns a
// promise that never settles and the shutdown() the handler enqueues next is swallowed by that
// same guard: persistence stays open, which is the branch's point (WebKit bug 226547); on every
// other browser the queue stays live and that shutdown() runs (SimpleDb closed, the primary lease
// released, the client metadata deleted, the visibility handler and the metadata refresher
// removed). on every browser the multi-tab WebStorageSharedClientState shuts down at pagehide too
// (its `storage` listener removed). nothing registers `pageshow`: a restored page keeps the item
// set it was hidden with, receives no snapshot and no listener error, and can save nothing —
// silently, until a reload. the SDK's restart is terminate() plus a fresh initializeFirestore();
// the app reloads instead, since every listener and the item state would need rebuilding, and the
// restore decides one of three things:
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
