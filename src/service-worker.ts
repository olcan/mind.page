import { durableNotificationRelay } from './host.js'
import { createIdbPendingStore, createNotificationClickRelay } from './notification_click'

// minimal service worker that enables installation and relays notification clicks to the page.
// see https://developers.google.com/web/ilt/pwa/caching-files-with-service-worker#network_only
// NOTE: the no-op fetch handler below is only required for Chrome's automatic install prompt;
// installation from the menu no longer requires it (since Chrome 108 on mobile, 112 on desktop),
// and Chrome warns that a no-op handler adds overhead on every navigation, so it is disabled for
// now. Bring it back if its absence becomes inconvenient.
// self.addEventListener('fetch', event => {})
//
// NOTIFICATION CLICK CONTRACT (protocol v2; page-agnostic; never reads inside notification.data):
// - On non-shared origins (`durableNotificationRelay(location.hostname)`), the worker answers
//   `{ type: 'mindpage:notificationclick:hello' }` with
//   `{ type: 'mindpage:notificationclick:relay', version: 2 }` to the sender, and persists clicks
//   in IndexedDB (`mindpage-notification-clicks`, v1, single `pending` store, 5-minute TTL) until
//   a document acknowledges them with `{ type: 'mindpage:notificationclick:received', id }` or an
//   account clear sends `{ type: 'mindpage:notificationclick:clear' }`. On isolated shared-page
//   origins nothing is stored (best-effort in-memory delivery only, and `hello` is not answered).
// - On `notificationclick`, the worker closes the notification, creates a message with a fresh
//   `id` (`{ type: 'mindpage:notificationclick', id, tag, data, action? }`), stores it first, and
//   probes eligible app windows (top-level and auxiliary, uncontrolled included; focused first, then
//   matchAll order). While a `notificationclick` handler is running for a click, every ordinary
//   offer (from the probe loop or from `ready`; cold-open direct posts excepted) takes a turn so
//   one offer at a time gets its acknowledgement interval: a posted offer keeps its interval, and
//   of the offers that wait, the one to a window that answered that it shows the subject goes
//   first (an answer is good for the next ordinary post to its window alone), the others first
//   come. Another `ready` from the same window whose turn is in flight
//   posts at once and restarts that turn's interval, unless a DIFFERENT window that answered that
//   it shows the subject waits for the turn. When two
//   or more eligible windows exist, it first queries them in parallel with
//   `{ type: 'mindpage:notificationclick:query', id, tag, data, action? }` (side-effect-free,
//   holding no turn; updated pages reply `{ type: 'mindpage:notificationclick:status', id, showing,
//   canHandle }`; delivery goes on at the first decision, and answers are still taken until the
//   deadline; a `received` or `clear` ends discovery at once). Discovery only reorders:
//   one preferred offer goes to the earliest window whose showing+capable answer still stands when
//   that offer's turn starts, with its own `ackTimeoutMs` wait; if it does not answer (or no answer
//   stands), the remaining originally eligible
//   windows are tried in released order (a `canHandle: false` answer removes nobody) with the full
//   fallback budget (time spent waiting for a `ready` turn is not charged to that budget). Before
//   going on to "nobody answered" among listed windows, the handler waits for any in-flight or
//   queued turns to end and rechecks acknowledgement; it focuses the answering window and deletes
//   the stored click, or else focuses the first window and leaves the click stored unassigned. If
//   no window is listed, it opens the app at once, as released, without waiting for a turn
//   (`clients.openWindow(registration.scope)`), sharing one
//   in-memory opening across overlapping clicks, writes the opened window's id onto unassigned
//   clicks, and leaves clicks stored unassigned on a refused or null open.
// - On `{ type: 'mindpage:notificationclick:ready' }`, for every stored click (oldest first,
//   without deleting until `received`) addressed to the sender, unassigned, or addressed to a client
//   no longer among live window clients, the worker takes a turn if a handler currently owns that
//   click, or posts at once otherwise.
// - On `{ type: 'mindpage:notificationclick:clear' }`, the worker closes every notification of
//   this registration and clears all stored clicks.

const sw = self as unknown as ServiceWorkerGlobalScope
const relay = createNotificationClickRelay(durableNotificationRelay(sw.location.hostname) ? createIdbPendingStore() : null)

// activate new versions immediately instead of waiting for all controlled tabs to close, so that
// e.g. the previous no-op fetch handler is replaced on next load
sw.addEventListener('install', () => void sw.skipWaiting())

sw.addEventListener('notificationclick', event => {
  event.waitUntil(relay.onNotificationClick(event, sw))
})

sw.addEventListener('message', event => {
  event.waitUntil(relay.onMessage(event, sw))
})
