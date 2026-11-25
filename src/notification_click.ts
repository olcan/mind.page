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
//   worker is confirmed); posts every stored click eligible for that sender, oldest first (without
//   deleting them until `received`).
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
//     { type: 'mindpage:notificationclick', id: string, tag: string, data: unknown, action?: string }
//   `id` is fresh per click, `tag` is notification.tag ('' when absent), `data` is passed verbatim
//   (structured-cloned, never inspected), and `action` is included only when non-empty.
// - storage: single IndexedDB object store (`mindpage-notification-clicks`, v1, store `pending`
//   with autoIncrement `seq`, 5-minute TTL checked at next store use; disabled on isolated
//   shared-page hosts). Clicks nobody answered stay unassigned (`clientId: null`) so any app
//   window that says `ready` takes them; a refused cold open with no window leaves the click
//   stored unassigned; a cold open returning a window writes that window's id onto unassigned
//   stored clicks. Overlapping cold opens share one in-memory opening (`openInFlight`).
//
// KNOWN LIMITS:
// - With two windows of the app open, both can take one click: a window whose answer outlasts
//   the worker's wait (e.g. a busy main thread or message delivery delay), or two that say `ready`
//   close together. Both then select the item.
// - A click made while an earlier one is still on its way to a window that was just opened can
//   arrive first; the page then ends on the earlier one.
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

  type AckInfo = { senderId: string | null; client: WindowClientLike | null }
  type ClickState = {
    acked: boolean
    senderId: string | null
    senderClient: WindowClientLike | null
    removal: Promise<void> | null
  }
  type OpenOutcome = { client: WindowClientLike | null; opened: boolean; rejected: boolean; ready: boolean }
  type OpenAttempt = { promise: Promise<OpenOutcome> }

  const pendingAcks = new Map<string, (ack: AckInfo) => void>()
  const inFlightClicks = new Map<string, ClickState>()
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

  async function probeWindows(
    ordered: WindowClientLike[],
    message: NotificationClickMessage,
    startedAt: number
  ): Promise<WindowClientLike | null> {
    const deadline = startedAt + totalAckBudgetMs
    for (const client of ordered) {
      const remaining = deadline - now()
      if (remaining <= 0) break
      const waitMs = Math.min(ackTimeoutMs, remaining)
      const ack = await new Promise<AckInfo | undefined>(resolve => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (info: AckInfo | undefined) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (pendingAcks.get(message.id) === onAck) pendingAcks.delete(message.id)
          resolve(info)
        }
        const onAck = (info: AckInfo) => finish(info)
        pendingAcks.set(message.id, onAck)
        try {
          client.postMessage(message)
        } catch {
          finish(undefined)
          return
        }
        if (!settled) {
          timer = setTimeout(() => finish(undefined), waitMs)
        }
      })
      if (ack !== undefined) {
        return ordered.find(c => c.id === ack.senderId) ?? ack.client ?? client
      }
    }
    return null
  }

  async function settleAfterOpen(outcome: OpenOutcome, message: NotificationClickMessage, clickState: ClickState): Promise<boolean> {
    if (clickState.acked) {
      await awaitRemoval(message.id, clickState)
      return true
    }
    if (outcome.client) {
      if (outcome.ready) {
        const winner = await probeWindows([outcome.client], message, now())
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
          const winner = await probeWindows(after, message, now())
          if (winner) {
            await focusBestEffort(winner)
            await awaitRemoval(message.id, clickState)
            resolveOpen({ client: winner, opened: false, rejected: false, ready: true })
            return
          }
          if (clickState.acked) {
            const lateWinner = after.find(c => c.id === clickState.senderId) ?? clickState.senderClient ?? after[0]
            await focusBestEffort(lateWinner)
            await awaitRemoval(message.id, clickState)
            resolveOpen({ client: lateWinner, opened: false, rejected: false, ready: true })
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
    const clickState: ClickState = { acked: false, senderId: null, senderClient: null, removal: null }
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

      // 2. Gather eligible app window clients, focused first, then matchAll order.
      const ordered = orderWindowClients(await sw.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      if (clickState.acked) {
        const winner = ordered.find(c => c.id === clickState.senderId) ?? clickState.senderClient
        if (winner) await focusBestEffort(winner)
        await awaitRemoval(message.id, clickState)
        return
      }

      // 3. Post to eligible windows one at a time, waiting a short bounded time for `received`.
      if (ordered.length > 0) {
        const winner = await probeWindows(ordered, message, now())
        if (winner) {
          await focusBestEffort(winner)
          await awaitRemoval(message.id, clickState)
          return
        }
        if (clickState.acked) {
          const lateWinner = ordered.find(c => c.id === clickState.senderId) ?? clickState.senderClient ?? ordered[0]
          await focusBestEffort(lateWinner)
          await awaitRemoval(message.id, clickState)
          return
        }
        // 4. Nobody answered and at least one window exists (e.g. reloading, fixed shared view, or
        //    a same-origin static page): focus the first window and leave the click stored UNASSIGNED
        //    so any app window that says `ready` takes it. No new window.
        await focusBestEffort(ordered[0])
        return
      }

      // 5. No eligible window at all: open the app.
      await handleColdOpen(message, stored, sw, clickState)
    } finally {
      inFlightClicks.delete(message.id)
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
      const source = event.source
      const senderId = typeof source?.id === 'string' ? source.id : null
      const senderClient =
        source && typeof (source as Partial<WindowClientLike>).focus === 'function' ? (source as WindowClientLike) : null
      const inFlight = inFlightClicks.get(id)
      const removal = inFlight?.removal ?? safeRemove(id)
      if (inFlight) {
        inFlight.acked = true
        inFlight.senderId = senderId
        inFlight.senderClient = senderClient
        inFlight.removal = removal
      }
      const waiter = pendingAcks.get(id)
      if (waiter) waiter({ senderId, client: senderClient })
      await removal
      return
    }

    if (type === NOTIFICATION_CLICK_CLEAR) {
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

      if (openInFlight) await openInFlight.promise

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

      let eligible: NotificationClickMessage[]
      try {
        eligible = await store.listEligible(source.id, liveClientIds, now())
      } catch {
        return
      }
      for (const message of eligible) {
        try {
          source.postMessage(message)
        } catch {
          // leave stored until acknowledged or expired
        }
      }
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
