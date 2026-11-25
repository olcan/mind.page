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
//   `id` (`{ type: 'mindpage:notificationclick', id, tag, data, action? }`), stores it first,
//   probes eligible app windows (top-level and auxiliary, uncontrolled included; focused first,
//   then matchAll order) one at a time waiting briefly for `received`, focuses the answering
//   window and deletes the stored click. If none answers and a window exists (e.g. reloading, a
//   fixed shared view, or a static page), it focuses the first and leaves the click stored
//   unassigned so any ready app window takes it. If none exists, it opens the app
//   (`clients.openWindow(registration.scope)`) sharing one in-memory opening across overlapping
//   clicks, writes the opened window's id onto unassigned clicks, and leaves clicks stored
//   unassigned on a refused or null open.
// - On `{ type: 'mindpage:notificationclick:ready' }`, the worker posts (oldest first) every
//   stored click addressed to the sender, unassigned, or addressed to a client no longer among
//   live window clients, without deleting until `received`.
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
