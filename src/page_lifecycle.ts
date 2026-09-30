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

// THE RESUME PROBE (2026-09-30). the owner's iPhone home-screen app showed stale items until a
// full restart. the HYPOTHESIS this guards against (the tethered session confirms or corrects it):
// a page the OS suspends without parking it in the page cache (a home-screen web app above all)
// comes back with no persisted pageshow, so the restore above never runs for it, and it turns
// visible again holding the client it was hidden with, whose Firestore stream the suspension may
// have killed on the wire (a dead socket raises no error until a write fails, and the Listen
// stream only reads), or, when the SDK's pagehide handler did run at the suspension, the
// restricted queue described above where nothing settles (the suite's dead-client witness proves
// that branch, not what the phone emits). either way the page shows the item set it was hidden
// with, and nothing says so. so a page that becomes visible after a long enough hide asks the
// server one small question with a deadline: a read of its own instance record from the server
// (getDocFromServer rides the same Listen stream as the items listener, so an answer means the
// listener's transport is live too). an answer in time is `ok`; an error is a client that could
// answer at all (offline, denied, a missing record) and is left alone, its transport left to the
// SDK's own reconnection; no answer by the deadline is the RECOVERY HEURISTIC: the client cannot
// be relied on, and the page recovers as the restore does (a reload at once, or after asking when
// an edit is unsaved: the reload discards it, which a client that answers nothing is unlikely to
// have saved either). the deadline proves nothing about the cause (the SDK itself allows ten
// seconds before it calls a stalled connection offline); it is the price of a reload against the
// price of a silently stale page, tuned on real-device evidence. the check runs after a hide long
// enough for a suspension to matter (a tab switch and back leaves the stream alone) and on a
// signed-in client (an anonymous page has no instance record to read); a resume while the browser
// reports itself OFFLINE defers it (a probe under it could only fail fast or time out; the online
// status establishes no reachability either, but a probe under it is at least not doomed) and
// the `online` event runs it while the page is still visible (review 0 R1: a restricted queue
// survives the network's return, so the deferred check is the page's one chance short of a
// restart). an attempt is INVALIDATED when the page hides or goes offline before its deadline
// (review 0 R2): its late result recovers nothing, while the check itself stays pending until an
// attempt of it is accepted (review 1 R4: `ResumeSchedule` below)
export const RESUME_PROBE_AFTER_MS = 15_000 // a hide shorter than this raises no check of its own
export const RESUME_PROBE_TIMEOUT_MS = 8_000 // the server's deadline
// the deferred check waits this long after the `online` event: the SDK restarts its streams on
// the same event, and a read issued at once fails fast as `unavailable` (an error, which recovers
// nothing) instead of asking the server
export const RESUME_ONLINE_GRACE_MS = 2_000
export type ProbeOutcome = 'ok' | 'timeout' | 'error'

// THE RESUME SCHEDULE (review 1 R4): a qualifying hide raises a CHECK that stays pending until
// an attempt of it reaches an accepted outcome, through every interruption: a hide or an offline
// event before the deadline invalidates the pending attempt (its late result is stale: nothing
// recorded, nothing recovered), never the check, so the next time the page is visible and
// online a fresh attempt runs with a fresh deadline, its hide short or not (a one-second app
// switch during a probe, a connection dropping and returning under a visible page, a deferred
// check interrupted before it starts). the caller owns the clock, the events and the probe
// itself; this object owns what is due
export class ResumeSchedule {
  pending = 0 // the hide length of the unfinished check (0: none)
  attempt = 0 // the current attempt's number: a hide or an offline event moves it on

  // the page turned hidden, or the browser went offline: the pending attempt is stale, the check stays
  invalidate(): void {
    this.attempt++
  }

  // the page turned visible after `hiddenMs`: the hide length to probe for now, or 0 (a hide
  // too short with no check pending, an anonymous page, or offline: the check waits for the
  // `online` event)
  shown(facts: { hiddenMs: number; online: boolean; anonymous: boolean }): number {
    if (facts.anonymous) return 0
    if (facts.hiddenMs >= RESUME_PROBE_AFTER_MS) this.pending = facts.hiddenMs
    return facts.online ? this.pending : 0
  }

  // the browser came back online (after the grace) with the page visible: the pending check, or 0
  online(facts: { visible: boolean; anonymous: boolean }): number {
    return facts.visible && !facts.anonymous ? this.pending : 0
  }

  // a fresh attempt: its number, compared at its end
  begin(): number {
    return ++this.attempt
  }

  // an attempt ended: accepted when it is still the current one (the check is done), stale otherwise
  settled(attempt: number): boolean {
    if (attempt != this.attempt) return false
    this.pending = 0
    return true
  }
}

// what an accepted outcome calls for: a timeout recovers, an answer or an error changes nothing
export function resumeAction(facts: { outcome: ProbeOutcome; unsaved: boolean }): RestoreAction {
  if (facts.outcome != 'timeout') return 'none'
  return facts.unsaved ? 'prompt' : 'reload'
}

// sessionStorage key: the reload a timed-out probe makes stamps itself for the next load (a JSON
// record: the reload's time, the hide's length and the probe's duration in ms), whose init log
// says why it reloaded and whose window._probe_reload_at holds the time; the reloaded page's
// instance record carries both stamps as `reloaded` (see updateInstance in index.svelte), so the
// #status item shows a recovery from any device. diagnostic only, guarded like RESTORED_RELOAD_KEY
export const PROBE_RELOAD_KEY = 'mindpage_probe_reload'
