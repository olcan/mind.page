// service-worker notification click relay (protocol v2; page-agnostic, zero item knowledge).
//
// CONTRACT between the app's service worker and page/item code:
// - page -> worker (`registration.active.postMessage`):
//     { type: 'mindpage:notificationclick:hello' }
//   answered to the sender with `{ type: 'mindpage:notificationclick:relay', version: 2 }` on
//   non-shared origins; the page accepts the answer ONLY from the specific worker it asked (no
//   answer without a source, none before a worker was asked), sets `window._notification_click_relay`
//   and `window._notification_click_worker`, and dispatches a `mindpage:notificationclick:relay`
//   event on `window`.
//     { type: 'mindpage:notificationclick:ready' }
//   sent by a window once its listener stands and its items are loaded (and again whenever a new
//   worker is confirmed); for every stored click eligible for that sender (oldest first, without
//   deleting until `received`), preserves stored posting order within that replay (the next row
//   waits until the preceding row's offer to this sender has been posted or skipped, not for its
//   acknowledgement interval), taking an offer turn if a `notificationclick` handler currently
//   owns that click or posting at once if no handler owns it.
//     { type: 'mindpage:notificationclick:status', id: string, showing: boolean, canHandle: boolean }
//   side-effect-free answer to a discovery query (`mindpage:notificationclick:query`) telling the
//   worker whether this window already shows the click's subject and whether it can handle it at
//   that moment; ignored when late, duplicate, or from a client that was not queried.
//     { type: 'mindpage:notificationclick:received', id: string }
//   sent by the handler only when it can act on a click of its own; deletes that stored click.
//     { type: 'mindpage:notificationclick:clear' }
//   sent at explicit sign-out (which marks the document left via `window._notification_account_left`
//   with relay marks withdrawn, and removes the origin-shared `mindpage_notification_account`
//   record) and when the origin-shared account record names a signed-in account other than the
//   newly confirmed Firebase uid (the shared record is written first, then `clear` is asked for via
//   `clearNotificationRelay`, whose async registration lookup expires with its wait); closes every
//   notification of this registration and drops all stored clicks. External auth transitions to an
//   account other than the one the document was confirmed for also set
//   `window._notification_account_left = true` (permanently for that document) and withdraw
//   `window._notification_click_relay` and `window._notification_click_worker` before requesting
//   reload, so a canceled reload starts no new notifications, sends no `ready`, and answers no
//   clicks; same-account external transitions leave the document unmarked.
// - worker -> page (`navigator.serviceWorker` `message` event):
//     { type: 'mindpage:notificationclick:query', id: string, tag: string, data: unknown, action?: string }
//   sent in parallel to all eligible windows before any actionable click when two or more eligible
//   windows exist. Discovery changes nothing on the page and holds no offer turn (so `ready` is
//   served at once): an updated page answers with `status` (`showing`, `canHandle`); an older page
//   ignores the unknown type. Delivery goes on as soon as every window has answered, the earliest
//   window in worker order whose showing+capable answer still stands (a post to a window uses its
//   answer up) cannot be beaten by any unanswered predecessor, a
//   `received` or `clear` arrives, or `min(ackTimeoutMs, totalAckBudgetMs)` ms elapse. Each listed
//   window's first valid answer is still taken after that decision, until all have answered, that
//   deadline passes, or the click is acknowledged, cleared or released.
//     { type: 'mindpage:notificationclick', id: string, tag: string, data: unknown, action?: string }
//   `id` is fresh per click, `tag` is notification.tag ('' when absent), `data` is passed verbatim
//   (structured-cloned, never inspected), and `action` is included only when non-empty.
//   While a `notificationclick` handler is running for a click, every ordinary offer (loop or
//   `ready`; cold-open direct posts excepted) takes a turn: one offer is in flight at a time for
//   its acknowledgement interval, and a posted offer keeps its interval. Of the offers that wait,
//   the one to a window that has answered that it shows the subject goes first (the loop's offer or
//   that window's own `ready`, queued before or after its answer; several: the earliest in worker
//   order), ahead of the offers to other windows; the others first come. An answer is good for the
//   next ordinary post to its window alone. Another `ready` from the same window
//   (where the loop's preferred offer and a `ready`'s offer would go to the same window, the
//   `ready`'s is served first) whose turn is in flight posts at once and restarts that turn's interval, unless a DIFFERENT
//   window that has answered that it shows the subject waits for the turn. Discovery only reorders: ONE
//   preferred offer goes to the earliest window in worker order whose answer still stands when that
//   offer's turn starts, with its own `ackTimeoutMs` interval; if it does not answer (or no answer
//   stands), the remaining
//   originally eligible windows are tried in released order (a `canHandle: false` answer removes
//   nobody) with the full `ACK_TOTAL_BUDGET_MS` budget (time spent waiting for a `ready` turn is
//   not charged to that budget). Single-window and cold-open paths skip discovery.
// - storage: single IndexedDB object store (`mindpage-notification-clicks`, v1, store `pending`
//   with autoIncrement `seq`, 5-minute TTL checked at next store use; disabled on isolated
//   shared-page hosts). Clicks nobody answered stay unassigned (`clientId: null`) so any app
//   window that says `ready` takes them; a refused cold open with no window leaves the click
//   stored unassigned; a cold open returning a window writes that window's id onto unassigned
//   stored clicks. Overlapping cold opens share one in-memory opening (`openInFlight`).
//
// KNOWN LIMITS:
// - With two windows of the app open, both can still act on one ordinary click when a window's
//   `received` reply outlasts the worker's wait (on timeout the worker offers the click to the next
//   window), or when two windows say `ready` close together for a stored click that no running
//   handler owns. Discovery itself is side-effect-free, and while a handler runs, ordinary offers
//   (loop and `ready`) take turns one at a time.
// - Page-owned `new Notification(...)` cards (used when no confirmed worker stands) still invoke
//   their creator window's click handler, and startup `ready` still replays only to its sender.
// - A click made while an earlier one is still on its way to a window that was just opened can
//   arrive first; the page then ends on the earlier one.
// - Rapid clicks can overtake each other in an already-open window when another window ignores
//   discovery: if window A holds X and Y and already shows Y while window B ignores the query,
//   clicking X at 0 ms and Y at 100 ms lets Y win discovery from A at once while X waits out B's
//   250 ms discovery timeout, so A handles Y first and then selects X at 258 ms.
// - A window that is loading at the moment of a click is posted it on its `ready` from the cache
//   and again at once on its second `ready`, also while discovery is still waiting for answers:
//   where a window that already shows the subject answers the query later than that second
//   `ready` (e.g. `ready` at 10 ms, the answer at 17 ms), or has answered but has no offer
//   waiting yet because a window ahead of it has not, the loading window takes the click.
// - A sign-out does not stop a notification or a click that is already in flight at that moment:
//   a notification that was just being shown can still appear after sign-out with that outgoing
//   notebook's text in it, and an old click payload can still reach a page after the clear. The
//   page asks for the clear and goes on after a bounded lookup of the registration (500 ms), not
//   when the worker has finished its cleanup: `posted` says only that a `postMessage` call
//   returned. A lookup that outlasts its wait, or a shared record that shows a DIFFERENT account
//   when the deferred post is due, prevents a FURTHER post only: where the controller had taken
//   the message, the worker's cleanup still runs; where no worker got one, the outgoing account's
//   settled cards stay on the screen and its still-eligible stored clicks are offered to the next
//   account's window at `ready` (the cleanup is best effort).
// - A clear is the registration's: it closes every card and drops every stored click that exists
//   when the worker handles it. The record check drops a deferred clear only when a readable
//   record shows ANOTHER account than the one the clear was asked for: where two tabs see the
//   same change of account and the second already has a card of the new one, the first tab's
//   clear takes it, and a record that cannot be read lets the post through.
// - The five-minute expiry (`PENDING_TTL_MS`) applies to stored pending clicks, not to
//   notification cards already on the screen.
// - Two `clients.matchAll` enumerations that are both outstanding before the first cold open
//   finishes can open two windows (`openInFlight` coalesces only once an open has started; a
//   backfill if wanted).
// - In a cold open, while the opened tab stays alive, a click addressed to it cannot be taken
//   over by a second notebook tab that already has the target (takeover deferred).
// - Rollout: if the last updated tab closes without leaving the shared account record (e.g. a
//   build before the shared key, or unavailable storage) before a pre-upgrade tab signs out and
//   erases the cached UID, a later updated page can lack the information to clear the outgoing
//   account's settled card. The shared record knows only of changes that an updated tab saw: if
//   every updated tab is closed while an old tab signs the account out and the same account in
//   again, the next start sees the same account and clears nothing.

export const NOTIFICATION_CLICK_TYPE = 'mindpage:notificationclick'
export const NOTIFICATION_CLICK_QUERY = 'mindpage:notificationclick:query'
export const NOTIFICATION_CLICK_STATUS = 'mindpage:notificationclick:status'
export const NOTIFICATION_CLICK_HELLO = 'mindpage:notificationclick:hello'
export const NOTIFICATION_CLICK_RELAY = 'mindpage:notificationclick:relay'
export const NOTIFICATION_CLICK_RELAY_VERSION = 2
export const NOTIFICATION_CLICK_READY = 'mindpage:notificationclick:ready'
export const NOTIFICATION_CLICK_RECEIVED = 'mindpage:notificationclick:received'
export const NOTIFICATION_CLICK_CLEAR = 'mindpage:notificationclick:clear'
export const NOTIFICATION_RELAY_ACCOUNT_KEY = 'mindpage_notification_account'
export const CLEAR_RELAY_WAIT_MS = 500

export const PENDING_TTL_MS = 5 * 60 * 1000
// Per-client wait for a live document to answer `received` during `notificationclick`.
// Bounds focus latency when a window is reloading or static; a busy page or message delivery
// delay can outlast this window (one way the documented two-window duplicate arises).
export const ACK_WAIT_MS = 250
// Total probe budget across all open windows in one `notificationclick`, staying well inside
// browser transient user-activation limits (~5 s in Chromium/Firefox, tighter on WebKit) so
// focusing the fallback window in step 4 still carries activation.
export const ACK_TOTAL_BUDGET_MS = 1500

export const PENDING_DB_NAME = 'mindpage-notification-clicks'
export const PENDING_DB_VERSION = 1
export const PENDING_STORE_NAME = 'pending'

export type NotificationClickMessage = {
  type: typeof NOTIFICATION_CLICK_TYPE
  id: string
  tag: string
  data: unknown
  action?: string
}

export type NotificationClickQueryMessage = {
  type: typeof NOTIFICATION_CLICK_QUERY
  id: string
  tag: string
  data: unknown
  action?: string
}

export type NotificationClickStatusMessage = {
  type: typeof NOTIFICATION_CLICK_STATUS
  id: string
  showing: boolean
  canHandle: boolean
}

export type NotificationRelayHelloAnswer = {
  type: typeof NOTIFICATION_CLICK_RELAY
  version: typeof NOTIFICATION_CLICK_RELAY_VERSION
}

export type PendingClickRecord = {
  seq?: number
  id: string
  clientId: string | null
  message: NotificationClickMessage
  at: number
}

export type PendingClickStore = {
  put(record: Omit<PendingClickRecord, 'seq'>, now: number): Promise<void>
  assignUnassigned(clientId: string, now: number): Promise<void>
  remove(id: string, now: number): Promise<void>
  listEligible(clientId: string, liveClientIds: ReadonlySet<string> | null, now: number): Promise<NotificationClickMessage[]>
  clear(): Promise<void>
}

export type NotificationLike = {
  tag?: string
  data?: unknown
  close(): void
}

export type WindowClientLike = {
  id: string
  focused?: boolean
  frameType?: string
  focus(): Promise<WindowClientLike | void>
  postMessage(message: unknown): void
}

export type NotificationClickEventLike = {
  notification: NotificationLike
  action?: string
}

export type WorkerMessageEventLike = {
  data: unknown
  source: { id?: string; frameType?: string; postMessage?: (message: unknown) => void } | null
}

export type ServiceWorkerScopeLike = {
  registration?: {
    scope?: string
    getNotifications?(filter?: { tag?: string }): Promise<NotificationLike[]>
  }
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>
    openWindow(url: string): Promise<WindowClientLike | null>
  }
}

export type RelayOptions = {
  now?: () => number
  makeId?: () => string
  ackTimeoutMs?: number
  totalAckBudgetMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
}

export type RelayWorkerLike = {
  state?: string
  postMessage(message: unknown): void
  addEventListener?(type: string, listener: () => void): void
}

export type RelayRegistrationLike = {
  active?: RelayWorkerLike | null
  installing?: RelayWorkerLike | null
  waiting?: RelayWorkerLike | null
  addEventListener?(type: string, listener: () => void): void
}

export type RelayContainerLike = {
  controller?: RelayWorkerLike | null
  ready?: Promise<RelayRegistrationLike>
  getRegistration?(): Promise<RelayRegistrationLike | undefined>
  startMessages?(): void
  addEventListener(type: string, listener: (event: any) => void): void
}

export type ClearRelayContainerLike = {
  controller?: RelayWorkerLike | null
  getRegistration?(): Promise<RelayRegistrationLike | undefined>
}

export type ClearNotificationRelayResult = 'posted' | 'no_worker' | 'timed_out' | 'superseded'

export type RelayWindowLike = {
  _notification_click_relay?: string
  _notification_click_worker?: RelayWorkerLike
  _notification_account_left?: boolean
  dispatchEvent?(event: Event): boolean
}

export type NotificationAccountStorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function normalizeNotificationAccountUid(uid: string | null | undefined): string | null {
  return typeof uid === 'string' && uid && uid !== 'anonymous' ? uid : null
}

// Whether an external auth confirmation names an account other than the one this document was
// confirmed for (`null` / `'anonymous'` both normalize to signed-out).
export function hasNotificationAccountChanged(
  documentUid: string | null | undefined,
  confirmedUid: string | null | undefined
): boolean {
  return normalizeNotificationAccountUid(documentUid) !== normalizeNotificationAccountUid(confirmedUid)
}

// Permanently marks this document as having left its authenticated account and withdraws the
// relay's confirmation marks so item code stops showing notifications (worker or page), sending
// `ready`, and answering clicks even if the owner cancels the reload at the discard prompt.
export function markNotificationAccountLeft(win: RelayWindowLike | null | undefined): void {
  if (!win) return
  win._notification_account_left = true
  delete win._notification_click_relay
  delete win._notification_click_worker
}

// Posts `{ type: 'mindpage:notificationclick:clear' }` to the page's service worker: at once to a
// controller, and to the registration's active worker after an asynchronous `getRegistration()`
// lookup that is BOUNDED by `wait` (default 500 ms, or a caller-supplied promise for controlled
// tests). A post that comes after the lookup is deferred, so it is made only while it is still due:
// - once the wait has ended the attempt is expired, and a lookup resolving later posts nothing;
// - a lookup resolving in time posts only if `wanted()` still holds (the caller's check that the
//   account this clear was asked for is still the one the origin's shared record shows: another
//   tab may have confirmed a DIFFERENT account meanwhile, whose notifications a clear would erase).
// `'posted'` means that at least one `postMessage` call returned; the worker's cleanup can finish
// later, and after a post through the controller the caller can still wait for the lookup or the
// wait's end. `'superseded'`: nothing posted, since `wanted()` no longer held.
export function clearNotificationRelay(
  sw: ClearRelayContainerLike | null | undefined,
  wait: number | Promise<unknown> = CLEAR_RELAY_WAIT_MS,
  wanted?: () => boolean
): Promise<ClearNotificationRelayResult> {
  if (!sw) return Promise.resolve('no_worker')
  const msg = { type: NOTIFICATION_CLICK_CLEAR }
  let posted = false
  let postedWorker: RelayWorkerLike | null = null
  if (sw.controller) {
    try {
      sw.controller.postMessage(msg)
      posted = true
      postedWorker = sw.controller
    } catch {
      // fall through to registration lookup
    }
  }
  if (typeof sw.getRegistration !== 'function') {
    return Promise.resolve(posted ? 'posted' : 'no_worker')
  }
  let lookup: Promise<RelayRegistrationLike | undefined>
  try {
    lookup = Promise.resolve(sw.getRegistration())
  } catch {
    return Promise.resolve(posted ? 'posted' : 'no_worker')
  }
  return new Promise<ClearNotificationRelayResult>(resolve => {
    let settled = false
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: ClearNotificationRelayResult) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    const onWaitEnd = () => {
      expired = true
      finish(posted ? 'posted' : 'timed_out')
    }
    if (typeof wait === 'number') {
      timer = setTimeout(onWaitEnd, wait)
    } else {
      Promise.resolve(wait).then(onWaitEnd, onWaitEnd)
    }
    lookup.then(
      reg => {
        if (expired) return
        const active = reg?.active
        if (active && active !== postedWorker) {
          if (wanted && !wanted()) return finish(posted ? 'posted' : 'superseded')
          try {
            active.postMessage(msg)
            posted = true
          } catch {
            // ignore post failure
          }
        }
        finish(posted ? 'posted' : 'no_worker')
      },
      () => {
        if (expired) return
        finish(posted ? 'posted' : 'no_worker')
      }
    )
  })
}

// Whether an observed confirmed account requires clearing the notification relay (cards and stored
// clicks): clears when the SHARED origin record names a signed-in account (never `'anonymous'`)
// other than the CONFIRMED account (another uid, or null when signed out).
export function shouldClearNotificationRelay(
  recordedUid: string | null | undefined,
  confirmedUid: string | null | undefined
): boolean {
  const prev = normalizeNotificationAccountUid(recordedUid)
  const next = normalizeNotificationAccountUid(confirmedUid)
  return prev !== null && next !== prev
}

// Reconciles the origin-shared notification account record (`NOTIFICATION_RELAY_ACCOUNT_KEY`)
// against a newly confirmed Firebase uid: sends `clear` (returns `true`) only when the shared
// record names a signed-in account other than `confirmedUid`, and updates the shared record
// synchronously before any async cleanup/reload so a suspended tab waking up after another tab
// already cleared A and signed in B sees `recordedUid === B` and clears nothing.
export function reconcileNotificationRelayAccount(
  storage: NotificationAccountStorageLike | null | undefined,
  confirmedUid: string | null | undefined
): boolean {
  const next = normalizeNotificationAccountUid(confirmedUid)
  let recorded: string | null = null
  try {
    recorded = storage?.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY) ?? null
  } catch {
    recorded = null
  }
  const shouldClear = shouldClearNotificationRelay(recorded, next)
  try {
    if (next) {
      if (recorded !== next) storage?.setItem(NOTIFICATION_RELAY_ACCOUNT_KEY, next)
    } else if (recorded !== null) {
      storage?.removeItem(NOTIFICATION_RELAY_ACCOUNT_KEY)
    }
  } catch {
    // ignore storage errors (e.g. Safari "Block All Cookies")
  }
  return shouldClear
}

// Whether the origin-shared account record still shows `uid` (none for a signed-out or the acting
// `anonymous` one): what a clear's caller passes as `wanted`, so that a post deferred behind a
// registration lookup, or queued behind an earlier clear, is dropped once another tab has
// confirmed a DIFFERENT account. A record that cannot be read counts as unchanged.
export function notificationRelayAccountIs(
  storage: NotificationAccountStorageLike | null | undefined,
  uid: string | null | undefined
): boolean {
  let recorded: string | null = null
  try {
    recorded = storage?.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY) ?? null
  } catch {
    return true
  }
  return normalizeNotificationAccountUid(recorded) === normalizeNotificationAccountUid(uid)
}

// Removes the origin-shared notification account record during an explicit sign-out (called
// alongside posting `clear` to the service worker).
export function clearNotificationRelayAccount(storage: NotificationAccountStorageLike | null | undefined): void {
  try {
    storage?.removeItem(NOTIFICATION_RELAY_ACCOUNT_KEY)
  } catch {
    // ignore storage errors
  }
}

// External auth transition handler (used by `index.svelte`'s `onAuthStateChanged` when
// `action == 'reload'`): invalidates key state on every transition, permanently marks the document
// left (withdrawing the relay's marks) BEFORE any cleanup or reload when the new account differs
// from `documentUid` (never on a same-account transition), reconciles the shared origin record
// synchronously first, clears the notification relay when the previous shared record disagreed
// with the newly confirmed uid, scopes any in-flight guard strictly to an outstanding
// `clearRelay()` promise, and releases it BEFORE requesting `reload()` so a reload canceled at the
// browser's unsaved-changes discard prompt leaves subsequent auth transitions fully active.
export function createExternalAuthReloader(deps: {
  storage: NotificationAccountStorageLike | null | undefined
  win: RelayWindowLike | null | undefined
  documentUid: string | null | undefined
  invalidateKeys: () => void
  clearRelay: (wanted: () => boolean) => Promise<unknown> | unknown
  reload: () => void
}): (confirmedUid: string | null | undefined) => Promise<void> | void {
  let clearInFlight: Promise<void> | null = null
  return (confirmedUid: string | null | undefined): Promise<void> | void => {
    deps.invalidateKeys()
    if (hasNotificationAccountChanged(deps.documentUid, confirmedUid)) {
      markNotificationAccountLeft(deps.win)
    }
    const needsClear = reconcileNotificationRelayAccount(deps.storage, confirmedUid)
    if (needsClear) {
      const prev = clearInFlight
      // (this clear is for THIS confirmation: where another tab has confirmed a further account by
      // the time it starts, behind an earlier clear, or by the time its deferred post is due, it
      // is dropped)
      const wanted = () => notificationRelayAccountIs(deps.storage, confirmedUid)
      const runClear = () => {
        if (!wanted()) return Promise.resolve()
        try {
          return Promise.resolve(deps.clearRelay(wanted)).then(
            () => undefined,
            () => undefined
          )
        } catch {
          return Promise.resolve()
        }
      }
      const pending: Promise<void> = (prev ? prev.then(runClear) : runClear()).then(() => {
        if (clearInFlight === pending) {
          clearInFlight = null
          deps.reload()
        }
      })
      clearInFlight = pending
      return pending
    }
    if (clearInFlight) return clearInFlight
    deps.reload()
  }
}

// Page-side strict handshake with the active service worker (protocol v2): asks each active or
// newly activated worker with `hello`, accepts `relay` ONLY from the exact worker that was asked
// (`!!probedWorker && e.source === probedWorker`), exposes `window._notification_click_relay` and
// `window._notification_click_worker`, and dispatches `mindpage:notificationclick:relay` on `window`
// so item code can resend `ready` to each newly confirmed worker.
export function attachNotificationRelayHandshake(sw: RelayContainerLike, win: RelayWindowLike): void {
  let probedWorker: RelayWorkerLike | null = null
  const watchedWorkers = new WeakSet<RelayWorkerLike>()

  const clearConfirmed = () => {
    delete win._notification_click_relay
    delete win._notification_click_worker
  }

  const probeWorker = (worker: RelayWorkerLike | null | undefined) => {
    if (win._notification_account_left) return
    if (!worker || worker === probedWorker || worker.state === 'redundant') return
    probedWorker = worker
    clearConfirmed()
    try {
      worker.postMessage({ type: NOTIFICATION_CLICK_HELLO })
    } catch {
      probedWorker = null
    }
  }

  const watchWorker = (worker: RelayWorkerLike | null | undefined) => {
    if (!worker) return
    if (worker.state === 'activated') {
      probeWorker(worker)
      return
    }
    if (watchedWorkers.has(worker)) return
    watchedWorkers.add(worker)
    worker.addEventListener?.('statechange', () => {
      if (worker.state === 'activated') probeWorker(worker)
    })
  }

  sw.addEventListener('message', (e: { isTrusted?: boolean; target?: unknown; source?: unknown; data?: { type?: unknown; version?: unknown } }) => {
    if (win._notification_account_left) return
    if (
      e.isTrusted === true &&
      e.target === sw &&
      probedWorker !== null &&
      e.source === probedWorker &&
      e.data?.type === NOTIFICATION_CLICK_RELAY &&
      e.data?.version === NOTIFICATION_CLICK_RELAY_VERSION
    ) {
      if (win._notification_click_worker === probedWorker && win._notification_click_relay === NOTIFICATION_CLICK_TYPE) return
      win._notification_click_relay = NOTIFICATION_CLICK_TYPE
      win._notification_click_worker = probedWorker
      if (typeof win.dispatchEvent === 'function') {
        const detail = { worker: probedWorker, version: NOTIFICATION_CLICK_RELAY_VERSION }
        const ev =
          typeof CustomEvent === 'function'
            ? new CustomEvent(NOTIFICATION_CLICK_RELAY, { detail })
            : ({ type: NOTIFICATION_CLICK_RELAY, detail } as unknown as Event)
        win.dispatchEvent(ev)
      }
    }
  })

  sw.startMessages?.()
  sw.addEventListener('controllerchange', () => probeWorker(sw.controller))
  if (sw.controller) probeWorker(sw.controller)
  sw.ready?.then(
    reg => {
      if (reg?.active) probeWorker(reg.active)
      watchWorker(reg?.installing)
      watchWorker(reg?.waiting)
      reg?.addEventListener?.('updatefound', () => watchWorker(reg.installing))
    },
    () => undefined
  )
}

export function buildClickMessage(notification: NotificationLike, action: string | undefined, id: string): NotificationClickMessage {
  const message: NotificationClickMessage = {
    type: NOTIFICATION_CLICK_TYPE,
    id,
    tag: typeof notification.tag === 'string' ? notification.tag : '',
    data: notification.data === undefined ? null : notification.data,
  }
  if (action) message.action = action
  return message
}

// Top-level windows and auxiliary windows (opened with an opener) count as app windows; nested
// iframes and non-window clients do not.
export function isEligibleWindowClient(client: WindowClientLike): boolean {
  return client.frameType !== 'nested' && client.frameType !== 'none'
}

// Orders eligible app window clients: currently focused windows first, then `matchAll`'s own
// most-recently-focused order per the W3C Service Workers spec.
export function orderWindowClients(windows: WindowClientLike[]): WindowClientLike[] {
  const eligible = windows.filter(isEligibleWindowClient)
  const focused: WindowClientLike[] = []
  const rest: WindowClientLike[] = []
  for (const client of eligible) {
    if (client.focused) focused.push(client)
    else rest.push(client)
  }
  return [...focused, ...rest]
}

export function createNotificationClickRelay(store: PendingClickStore | null, opts: RelayOptions = {}) {
  const now = opts.now ?? Date.now
  let idSeq = 0
  const makeId =
    opts.makeId ??
    (() =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${now()}-${++idSeq}-${Math.random().toString(36).slice(2)}`)
  const ackTimeoutMs = opts.ackTimeoutMs ?? ACK_WAIT_MS
  const totalAckBudgetMs = opts.totalAckBudgetMs ?? ACK_TOTAL_BUDGET_MS
  const setTimer = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))

  type AckInfo = { senderId: string | null; client: WindowClientLike | null }
  type ReadySource = { id: string; postMessage: (message: unknown) => void }
  type DiscoveryAnswer = { showing: boolean; canHandle: boolean }
  type DiscoveryWaiter = {
    expectedIds: ReadonlySet<string>
    onStatus: (clientId: string, answer: DiscoveryAnswer) => void
    cancel: () => void
  }
  type ActiveTurn = {
    clientId: string
    reset: (waitMs: number) => void
    finish: (info: AckInfo | undefined) => void
    done: Promise<AckInfo | undefined>
  }
  // `target`: the window an offer that waits would go to now (fixed, or for the loop's preferred offer the window
  // picked when its turn starts; null: nothing would be posted)
  // `pick`: the loop's preferred offer (its window is picked when its turn starts); else the window is fixed
  type TurnWaiter = { target: () => ReadySource | null; pick: boolean; start: () => void }
  type ClickState = {
    acked: boolean
    cleared: boolean
    senderId: string | null
    senderClient: WindowClientLike | null
    removal: Promise<void> | null
    busy: boolean // an offer has the turn, or the turn is being handed to the next one
    waiting: TurnWaiter[] // the offers that wait for the turn, in the order they came
    // windows whose answer for this click was showing+capable -> their place in worker order; an entry is good
    // for the next ordinary post to that window and removed just before it
    showing: Map<string, number>
    idleWaiters: (() => void)[]
    activeTurn: ActiveTurn | null
    releaseWhenIdle: boolean
  }
  type OpenOutcome = { client: WindowClientLike | null; opened: boolean; rejected: boolean; ready: boolean }
  type OpenAttempt = { promise: Promise<OpenOutcome> }

  const pendingQueries = new Map<string, DiscoveryWaiter>()
  const inFlightClicks = new Map<string, ClickState>()
  const activeReplayAckSets = new Set<Set<string>>()
  let clearEpoch = 0
  let openInFlight: OpenAttempt | null = null

  async function focusBestEffort(client: WindowClientLike): Promise<void> {
    try {
      await client.focus()
    } catch {
      // browser may refuse focus (e.g. missing activation); never fail delivery or trigger openWindow
    }
  }

  async function safeRemove(id: string): Promise<void> {
    if (!store) return
    try {
      await store.remove(id, now())
    } catch {
      // ignore storage failure
    }
  }

  async function awaitRemoval(id: string, clickState: ClickState): Promise<void> {
    if (!clickState.removal) clickState.removal = safeRemove(id)
    await clickState.removal
  }

  async function safeAssignUnassigned(clientId: string): Promise<void> {
    if (!store) return
    try {
      await store.assignUnassigned(clientId, now())
    } catch {
      // ignore storage failure
    }
  }

  // The next of the offers that wait: one to a window whose answer for this click was showing+capable, whether
  // the answer came before or after that offer queued (several such windows: the earliest in worker order,
  // discovery's own tie order), ahead of the offers to other windows; else first come. Where the loop's preferred
  // offer and a fixed offer (a `ready`'s) would go to the same window, the fixed one is served first: the post
  // goes to that window either way, and the preferred offer can then still take another window whose answer stands.
  function takeNextWaiter(clickState: ClickState): TurnWaiter | undefined {
    let at = -1
    let best = Infinity
    clickState.waiting.forEach((w, i) => {
      const to = w.target()
      const rank = to ? clickState.showing.get(to.id) : undefined
      if (rank !== undefined && (rank < best || (rank === best && at >= 0 && clickState.waiting[at].pick && !w.pick))) {
        best = rank
        at = i
      }
    })
    return at < 0 ? clickState.waiting.shift() : clickState.waiting.splice(at, 1)[0]
  }

  async function offerClick(
    clickState: ClickState,
    to: ReadySource | (() => ReadySource | null), // a window; or a pick made when the offer's turn starts
    message: NotificationClickMessage,
    waitMs: number,
    allowSameWindow = false,
    onStart?: (client: ReadySource) => void,
    onPosted?: () => void
  ): Promise<AckInfo | undefined> {
    const target = typeof to === 'function' ? to : () => to
    const same = typeof to === 'function' ? null : to
    let postedNotified = false
    const notifyPosted = () => {
      if (postedNotified) return
      postedNotified = true
      onPosted?.()
    }
    if (clickState.acked || clickState.cleared) {
      notifyPosted()
      return undefined
    }
    // Same window again while its own offer is in flight: post at once and restart its wait, unless a
    // DIFFERENT window that has answered that it shows the subject waits for the turn, whichever way its
    // offer came (the loop's, or its own `ready`, queued before or after its answer): that one is not
    // overtaken (the same window's own queued offer, or a window that has not said it shows the subject, is).
    if (
      allowSameWindow &&
      same &&
      clickState.activeTurn?.clientId === same.id &&
      !clickState.waiting.some(w => {
        const other = w.target()
        return !!other && other.id !== same.id && clickState.showing.has(other.id)
      })
    ) {
      const active = clickState.activeTurn
      clickState.showing.delete(same.id) // its answer is used up by this post (see below)
      try {
        same.postMessage(message)
      } catch {
        notifyPosted()
        return undefined
      }
      if (clickState.activeTurn === active && !clickState.acked && !clickState.cleared) active.reset(waitMs)
      notifyPosted()
      return active.done
    }

    // Take the turn, or wait for it: a posted offer keeps its interval, and the next is chosen when it ends.
    if (clickState.busy) await new Promise<void>(resolve => clickState.waiting.push({ target, pick: !same, start: resolve }))
    else clickState.busy = true
    try {
      if (clickState.acked || clickState.cleared) {
        notifyPosted()
        return undefined
      }
      // the window of this offer, now that its turn has come (a pick can find no window left: nothing is posted)
      const client = target()
      if (!client) {
        notifyPosted()
        return undefined
      }
      onStart?.(client)
      let settled = false
      let result: AckInfo | undefined
      let timer: unknown
      let resolveDone!: (info: AckInfo | undefined) => void
      const done = new Promise<AckInfo | undefined>(r => { resolveDone = r })
      const finish = (info: AckInfo | undefined) => {
        if (settled) return
        settled = true
        result = info
        if (timer !== undefined) clearTimer(timer)
        if (clickState.activeTurn === turn) clickState.activeTurn = null
        resolveDone(info)
      }
      const reset = (ms: number) => {
        if (settled) return
        if (timer !== undefined) clearTimer(timer)
        timer = setTimer(() => finish(undefined), ms)
      }
      const turn: ActiveTurn = { clientId: client.id, reset, finish, done }
      clickState.activeTurn = turn
      // A positive answer gives its window the place ahead for the NEXT ordinary post to it alone: used up here,
      // before the post, so that an unanswered offer does not earn the window a second turn ahead of the others
      // (an answer that arrives after a post still ranks that window's next offer).
      clickState.showing.delete(client.id)
      try {
        client.postMessage(message)
      } catch {
        finish(undefined)
        notifyPosted()
        return undefined
      }
      if (!settled) {
        reset(waitMs)
        notifyPosted()
        return await done
      }
      notifyPosted()
      return result
    } finally {
      notifyPosted()
      // pass the turn on, or end it
      const next = takeNextWaiter(clickState)
      if (next) next.start()
      else {
        clickState.busy = false
        if (clickState.releaseWhenIdle && inFlightClicks.get(message.id) === clickState) {
          inFlightClicks.delete(message.id)
          pendingQueries.get(message.id)?.cancel() // a released click takes no more answers
        }
        for (const wake of clickState.idleWaiters.splice(0)) wake()
      }
    }
  }

  async function waitForTurns(clickState: ClickState): Promise<void> {
    while (clickState.busy) await new Promise<void>(resolve => clickState.idleWaiters.push(resolve))
  }

  async function probeClients(
    clients: (WindowClientLike | (() => WindowClientLike | null))[],
    allClients: WindowClientLike[],
    message: NotificationClickMessage,
    totalBudgetMs: number,
    clickState: ClickState,
    onTried?: (client: WindowClientLike) => void
  ): Promise<WindowClientLike | null> {
    let budget = totalBudgetMs
    const winnerOf = (id: string | null, client: WindowClientLike | null) => allClients.find(c => c.id === id) ?? client
    for (const client of clients) {
      if (clickState.acked) return winnerOf(clickState.senderId, clickState.senderClient)
      if (clickState.cleared || budget <= 0) break
      const waitMs = Math.min(ackTimeoutMs, budget)
      let startedAt: number | null = null
      let tried = (typeof client === 'function' ? null : client) as WindowClientLike | null
      const ack = await offerClick(clickState, client, message, waitMs, false, posted => {
        startedAt = now()
        tried = posted as WindowClientLike
        onTried?.(tried)
      })
      if (ack) return winnerOf(ack.senderId, ack.client) ?? tried
      if (clickState.acked) return winnerOf(clickState.senderId, clickState.senderClient)
      if (clickState.cleared) return null
      if (startedAt !== null) budget -= Math.min(waitMs, Math.max(0, now() - startedAt))
    }
    return null
  }

  async function discoverWindows(
    ordered: WindowClientLike[],
    message: NotificationClickMessage,
    waitMs: number,
    clickState: ClickState
  ): Promise<void> {
    clickState.showing = new Map()
    if (ordered.length < 2 || waitMs <= 0) return
    const query: NotificationClickQueryMessage = { ...message, type: NOTIFICATION_CLICK_QUERY }
    const expectedIds = new Set(ordered.map(c => c.id))
    const answered = new Set<string>()
    const isDecided = () => {
      if (clickState.acked || clickState.cleared) return true
      for (const client of ordered) {
        if (!answered.has(client.id)) return false
        // an answer that still stands: one that a post has used up no longer ends discovery
        if (clickState.showing.has(client.id)) return true
      }
      return true
    }
    // The first decision lets delivery go on at once. Each listed window's first valid answer is still taken
    // until all have answered, the deadline passes, or the click is acknowledged, cleared or released: an answer
    // that comes after the decision can still rank an offer that waits, and be the preferred offer's window.
    await new Promise<void>(resolve => {
      let decided = false
      let closed = false
      let timer: unknown
      const decide = () => {
        if (decided) return
        decided = true
        resolve()
      }
      const close = () => {
        if (closed) return
        closed = true
        if (timer !== undefined) clearTimer(timer)
        if (pendingQueries.get(message.id) === waiter) pendingQueries.delete(message.id)
        decide()
      }
      const waiter: DiscoveryWaiter = {
        expectedIds,
        onStatus: (clientId, answer) => {
          if (answered.has(clientId)) return
          answered.add(clientId)
          // known to the turn line at once, also while discovery still waits for a window ahead of this one
          if (answer.showing && answer.canHandle) clickState.showing.set(clientId, ordered.findIndex(c => c.id === clientId))
          if (answered.size >= expectedIds.size) close()
          else if (isDecided()) decide()
        },
        cancel: close,
      }
      pendingQueries.get(message.id)?.cancel() // an earlier discovery of this click takes no more answers
      pendingQueries.set(message.id, waiter)
      for (const client of ordered) {
        try {
          client.postMessage(query)
        } catch {
          answered.add(client.id)
        }
      }
      if (answered.size >= expectedIds.size) close()
      else {
        timer = setTimer(close, waitMs)
        if (isDecided()) decide()
      }
    })
  }

  async function probeWindows(
    ordered: WindowClientLike[],
    message: NotificationClickMessage,
    clickState: ClickState
  ): Promise<WindowClientLike | null> {
    if (ordered.length < 2) {
      return probeClients(ordered, ordered, message, totalAckBudgetMs, clickState)
    }

    // Discovery only reorders (a `canHandle: false` answer removes nobody) and holds no turn;
    // the preferred window's offer has its own `ackTimeoutMs` wait ahead of the fallback budget.
    await discoverWindows(ordered, message, Math.min(ackTimeoutMs, totalAckBudgetMs), clickState)
    if (clickState.acked || clickState.cleared) return null
    // ONE preferred offer, to the earliest window in worker order whose answer still stands. A post uses an answer
    // up, so the window is picked when the offer's turn STARTS: a `ready` of the window that leads now may have
    // spent its answer by then (the next one is taken; with none left nothing is posted and the fallback goes on).
    const stillShowing = () => ordered.find(c => clickState.showing.has(c.id)) ?? null
    let winner: WindowClientLike | null = null
    let tried = null as WindowClientLike | null
    if (stillShowing()) winner = await probeClients([stillShowing], ordered, message, ackTimeoutMs, clickState, client => { tried = client })
    if (!winner && !clickState.acked && !clickState.cleared) {
      // the fallback leaves out the window that the preferred offer was actually posted to
      const rest = tried ? ordered.filter(c => c !== tried) : ordered
      winner = await probeClients(rest, ordered, message, totalAckBudgetMs, clickState)
    }
    return winner
  }

  async function settleAfterOpen(outcome: OpenOutcome, message: NotificationClickMessage, clickState: ClickState): Promise<boolean> {
    if (clickState.acked) {
      await awaitRemoval(message.id, clickState)
      return true
    }
    if (outcome.client) {
      if (outcome.ready) {
        const winner = await probeClients([outcome.client], [outcome.client], message, totalAckBudgetMs, clickState)
        if (winner) {
          await focusBestEffort(winner)
          await awaitRemoval(message.id, clickState)
          return true
        }
        if (clickState.acked) {
          await focusBestEffort(clickState.senderClient ?? outcome.client)
          await awaitRemoval(message.id, clickState)
          return true
        }
        return false
      }
      if (outcome.opened && outcome.client.id) {
        await safeAssignUnassigned(outcome.client.id)
      }
      await focusBestEffort(outcome.client)
      return true
    }
    return !outcome.rejected
  }

  async function handleColdOpen(
    message: NotificationClickMessage,
    stored: boolean,
    sw: ServiceWorkerScopeLike,
    clickState: ClickState
  ): Promise<void> {
    while (openInFlight) {
      const outcome = await openInFlight.promise
      if (await settleAfterOpen(outcome, message, clickState)) return
    }

    let resolveOpen!: (outcome: OpenOutcome) => void
    const attempt: OpenAttempt = {
      promise: new Promise<OpenOutcome>(resolve => {
        resolveOpen = resolve
      }),
    }
    openInFlight = attempt

    let opened: WindowClientLike | null = null
    let openRejected = false
    try {
      const scope = sw.registration?.scope || '/'
      try {
        opened = await sw.clients.openWindow(scope)
      } catch {
        openRejected = true
      }

      if (opened) {
        if (store) {
          if (stored && opened.id) {
            try {
              await store.assignUnassigned(opened.id, now())
            } catch {
              try {
                opened.postMessage(message)
              } catch {
                // best effort when storage fails
              }
            }
          } else if (!stored) {
            try {
              opened.postMessage(message)
            } catch {
              // best effort when initial put failed
            }
          }
        }
        resolveOpen({ client: opened, opened: true, rejected: false, ready: false })
        return
      }

      if (openRejected) {
        const after = orderWindowClients(await sw.clients.matchAll({ type: 'window', includeUncontrolled: true }))
        if (after.length > 0) {
          const winner = await probeWindows(after, message, clickState)
          if (winner) {
            await focusBestEffort(winner)
            await awaitRemoval(message.id, clickState)
            resolveOpen({ client: winner, opened: false, rejected: false, ready: true })
            return
          }
          await waitForTurns(clickState)
          if (clickState.acked) {
            const lateWinner = after.find(c => c.id === clickState.senderId) ?? clickState.senderClient ?? after[0]
            await focusBestEffort(lateWinner)
            await awaitRemoval(message.id, clickState)
            resolveOpen({ client: lateWinner, opened: false, rejected: false, ready: true })
            return
          }
          if (clickState.cleared) {
            resolveOpen({ client: null, opened: false, rejected: false, ready: false })
            return
          }
          // Nobody answered among concurrent windows: leave unassigned so any ready app window takes it.
          await focusBestEffort(after[0])
          resolveOpen({ client: after[0], opened: false, rejected: false, ready: false })
          return
        }
        // Refused open with no window at all: leave the stored click unassigned until normal expiry
        // so an app window that says `ready` within the TTL takes it.
        resolveOpen({ client: null, opened: false, rejected: true, ready: false })
        return
      }

      // openWindow resolved null without throwing: leave click stored unassigned; any overlapping
      // click avoids opening a second window, while a later gesture checks windows and may open again.
      resolveOpen({ client: null, opened: false, rejected: false, ready: false })
    } finally {
      if (openInFlight === attempt) openInFlight = null
    }
  }

  async function onNotificationClick(event: NotificationClickEventLike, sw: ServiceWorkerScopeLike): Promise<void> {
    const notification = event.notification
    notification.close()
    const message = buildClickMessage(notification, event.action, makeId())
    const clickAt = now()
    const clickState: ClickState = {
      acked: false, cleared: false, senderId: null, senderClient: null, removal: null,
      busy: false, waiting: [], showing: new Map(), idleWaiters: [], activeTurn: null, releaseWhenIdle: false,
    }
    inFlightClicks.set(message.id, clickState)

    let stored = false
    try {
      // 1. Store the click FIRST (on non-shared origins; shared-page origins pass store = null).
      if (store) {
        try {
          await store.put({ id: message.id, clientId: null, message, at: clickAt }, clickAt)
          stored = true
        } catch {
          // storage failure must never lose a click that a window could take at once
        }
      }

      // If a cold open is already under way in this worker, wait behind it and open no second window.
      while (openInFlight) {
        const outcome = await openInFlight.promise
        if (await settleAfterOpen(outcome, message, clickState)) return
      }

      if (clickState.acked) {
        await awaitRemoval(message.id, clickState)
        return
      }
      if (clickState.cleared) return

      // 2. Gather eligible app window clients, focused first, then matchAll order.
      const ordered = orderWindowClients(await sw.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      if (clickState.acked) {
        const winner = ordered.find(c => c.id === clickState.senderId) ?? clickState.senderClient
        if (winner) await focusBestEffort(winner)
        await awaitRemoval(message.id, clickState)
        return
      }
      if (clickState.cleared) return

      // 3. Deliver to eligible windows (discovering a showing window first when 2+ windows exist).
      if (ordered.length > 0) {
        const winner = await probeWindows(ordered, message, clickState)
        if (winner) {
          await focusBestEffort(winner)
          await awaitRemoval(message.id, clickState)
          return
        }
        await waitForTurns(clickState)
        if (clickState.acked) {
          const lateWinner = ordered.find(c => c.id === clickState.senderId) ?? clickState.senderClient ?? ordered[0]
          await focusBestEffort(lateWinner)
          await awaitRemoval(message.id, clickState)
          return
        }
        if (clickState.cleared) return
        // 4. Nobody answered and at least one window exists (e.g. reloading, fixed shared view, or
        //    a same-origin static page): focus the first window and leave the click stored UNASSIGNED
        //    so any app window that says `ready` takes it. No new window.
        await focusBestEffort(ordered[0])
        return
      }

      // 5. No eligible window at all: open the app.
      await handleColdOpen(message, stored, sw, clickState)
    } finally {
      if (!clickState.busy) {
        inFlightClicks.delete(message.id)
        pendingQueries.get(message.id)?.cancel() // a released click takes no more answers
      } else clickState.releaseWhenIdle = true
    }
  }

  async function onMessage(event: WorkerMessageEventLike, sw: ServiceWorkerScopeLike): Promise<void> {
    const data = event.data
    if (!data || typeof data !== 'object') return
    const type = (data as { type?: unknown }).type

    if (type === NOTIFICATION_CLICK_HELLO) {
      if (!store) return
      const source = event.source
      if (!source || typeof source.postMessage !== 'function') return
      const answer: NotificationRelayHelloAnswer = {
        type: NOTIFICATION_CLICK_RELAY,
        version: NOTIFICATION_CLICK_RELAY_VERSION,
      }
      try {
        source.postMessage(answer)
      } catch {
        // ignore post failure
      }
      return
    }

    if (type === NOTIFICATION_CLICK_RECEIVED) {
      const id = (data as { id?: unknown }).id
      if (typeof id !== 'string' || !id) return
      for (const s of activeReplayAckSets) s.add(id)
      const source = event.source
      const senderId = typeof source?.id === 'string' ? source.id : null
      const senderClient =
        source && typeof (source as Partial<WindowClientLike>).focus === 'function' ? (source as WindowClientLike) : null
      const inFlight = inFlightClicks.get(id)
      const removal = inFlight?.removal ?? safeRemove(id)
      if (inFlight) {
        if (!inFlight.acked) {
          inFlight.acked = true
          inFlight.senderId = senderId
          inFlight.senderClient = senderClient
        }
        inFlight.removal = removal
        inFlight.activeTurn?.finish({ senderId, client: senderClient })
      }
      pendingQueries.get(id)?.cancel()
      await removal
      return
    }

    if (type === NOTIFICATION_CLICK_STATUS) {
      const id = (data as { id?: unknown }).id
      if (typeof id !== 'string' || !id) return
      const source = event.source
      const senderId = typeof source?.id === 'string' ? source.id : null
      if (!senderId) return
      const waiter = pendingQueries.get(id)
      if (!waiter || !waiter.expectedIds.has(senderId)) return
      const showing = (data as { showing?: unknown }).showing === true
      const canHandle = (data as { canHandle?: unknown }).canHandle === true
      waiter.onStatus(senderId, { showing, canHandle })
      return
    }

    if (type === NOTIFICATION_CLICK_CLEAR) {
      clearEpoch++
      for (const [id, state] of [...inFlightClicks]) {
        state.cleared = true
        state.activeTurn?.finish(undefined)
        pendingQueries.get(id)?.cancel()
      }
      if (sw.registration && typeof sw.registration.getNotifications === 'function') {
        try {
          const list = await sw.registration.getNotifications()
          for (const n of list) {
            try {
              n.close()
            } catch {
              // ignore close failure
            }
          }
        } catch {
          // ignore getNotifications failure
        }
      }
      if (store) {
        try {
          await store.clear()
        } catch {
          // ignore storage failure
        }
      }
      return
    }

    if (type === NOTIFICATION_CLICK_READY) {
      if (!store) return
      const source = event.source
      if (!source || typeof source.id !== 'string' || typeof source.postMessage !== 'function') return
      if (source.frameType === 'nested' || source.frameType === 'none') return

      while (openInFlight) await openInFlight.promise

      let liveClientIds: Set<string> | null
      try {
        const windows = orderWindowClients(await sw.clients.matchAll({ type: 'window', includeUncontrolled: true }))
        liveClientIds = new Set(windows.map(w => w.id))
        liveClientIds.add(source.id)
      } catch {
        // When matchAll fails we cannot tell which other clients are dead; only take clicks
        // addressed to this sender or unassigned so we never steal a live client's click.
        liveClientIds = null
      }

      const replayClearEpoch = clearEpoch
      const ackedDuringReplay = new Set<string>()
      activeReplayAckSets.add(ackedDuringReplay)
      const pending: Promise<unknown>[] = []
      try {
        let eligible: NotificationClickMessage[]
        try {
          eligible = await store.listEligible(source.id, liveClientIds, now())
        } catch {
          return
        }
        const rows = eligible.map(message => ({ message, initial: inFlightClicks.get(message.id) }))
        for (const { message, initial } of rows) {
          if (clearEpoch !== replayClearEpoch) break
          if (ackedDuringReplay.has(message.id) || initial?.acked || initial?.cleared) continue
          const inFlight = inFlightClicks.get(message.id)
          if (inFlight) {
            let postedNow = false
            let resolvePosted: (() => void) | null = null
            const onPosted = () => {
              postedNow = true
              resolvePosted?.()
            }
            pending.push(offerClick(inFlight, source as ReadySource, message, ackTimeoutMs, true, undefined, onPosted))
            if (!postedNow) await new Promise<void>(r => { resolvePosted = r })
            continue
          }
          try {
            source.postMessage(message)
          } catch {
            // leave stored until acknowledged or expired
          }
        }
      } finally {
        activeReplayAckSets.delete(ackedDuringReplay)
      }
      if (pending.length > 0) await Promise.all(pending)
    }
  }

  return { onNotificationClick, onMessage }
}

function openPendingDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(PENDING_DB_NAME, PENDING_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(PENDING_STORE_NAME)) {
        db.createObjectStore(PENDING_STORE_NAME, { keyPath: 'seq', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
  })
}

async function runTx<T>(idb: IDBFactory, run: (pending: IDBObjectStore) => () => T): Promise<T> {
  const db = await openPendingDb(idb)
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(PENDING_STORE_NAME, 'readwrite')
      const getResult = run(tx.objectStore(PENDING_STORE_NAME))
      tx.oncomplete = () => resolve(getResult())
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'))
    })
  } finally {
    db.close()
  }
}

export function createIdbPendingStore(idb: IDBFactory | undefined = typeof indexedDB !== 'undefined' ? indexedDB : undefined): PendingClickStore {
  const requireIdb = () => {
    if (!idb) throw new Error('indexedDB unavailable')
    return idb
  }
  return {
    put(record, now) {
      return runTx(requireIdb(), pending => {
        const req = pending.getAll()
        req.onsuccess = () => {
          for (const row of req.result as PendingClickRecord[]) {
            if (now - row.at >= PENDING_TTL_MS && row.seq != null) pending.delete(row.seq)
          }
          pending.add(record)
        }
        return () => undefined
      })
    },
    assignUnassigned(clientId, now) {
      return runTx(requireIdb(), pending => {
        const req = pending.getAll()
        req.onsuccess = () => {
          for (const row of req.result as PendingClickRecord[]) {
            if (now - row.at >= PENDING_TTL_MS) {
              if (row.seq != null) pending.delete(row.seq)
            } else if (row.clientId === null) {
              pending.put({ ...row, clientId })
            }
          }
        }
        return () => undefined
      })
    },
    remove(id, now) {
      return runTx(requireIdb(), pending => {
        const req = pending.getAll()
        req.onsuccess = () => {
          for (const row of req.result as PendingClickRecord[]) {
            if (now - row.at >= PENDING_TTL_MS || row.id === id) {
              if (row.seq != null) pending.delete(row.seq)
            }
          }
        }
        return () => undefined
      })
    },
    listEligible(clientId, liveClientIds, now) {
      return runTx(requireIdb(), pending => {
        const eligible: NotificationClickMessage[] = []
        const req = pending.getAll()
        req.onsuccess = () => {
          for (const row of req.result as PendingClickRecord[]) {
            if (now - row.at >= PENDING_TTL_MS) {
              if (row.seq != null) pending.delete(row.seq)
            } else if (row.clientId === clientId || row.clientId === null || (liveClientIds !== null && !liveClientIds.has(row.clientId))) {
              eligible.push(row.message)
            }
          }
        }
        return () => eligible
      })
    },
    clear() {
      return runTx(requireIdb(), pending => {
        pending.clear()
        return () => undefined
      })
    },
  }
}
