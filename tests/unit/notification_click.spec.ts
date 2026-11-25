import { expect, test } from '@playwright/test'
import {
  NOTIFICATION_CLICK_CLEAR,
  NOTIFICATION_CLICK_HELLO,
  NOTIFICATION_CLICK_READY,
  NOTIFICATION_CLICK_RECEIVED,
  NOTIFICATION_CLICK_RELAY,
  NOTIFICATION_CLICK_RELAY_VERSION,
  NOTIFICATION_CLICK_TYPE,
  NOTIFICATION_RELAY_ACCOUNT_KEY,
  PENDING_DB_VERSION,
  PENDING_STORE_NAME,
  PENDING_TTL_MS,
  attachNotificationRelayHandshake,
  buildClickMessage,
  clearNotificationRelay,
  clearNotificationRelayAccount,
  createExternalAuthReloader,
  createIdbPendingStore,
  createNotificationClickRelay,
  hasNotificationAccountChanged,
  isEligibleWindowClient,
  orderWindowClients,
  notificationRelayAccountIs,
  reconcileNotificationRelayAccount,
  shouldClearNotificationRelay,
  type ClearRelayContainerLike,
  type NotificationAccountStorageLike,
  type NotificationClickMessage,
  type PendingClickRecord,
  type PendingClickStore,
  type RelayContainerLike,
  type RelayRegistrationLike,
  type RelayWindowLike,
  type RelayWorkerLike,
  type ServiceWorkerScopeLike,
  type WindowClientLike,
} from '../../src/notification_click.js'

// Deferred helper for separately controlled promises in interleaving tests.
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function memoryStorage(initial: Record<string, string> = {}): NotificationAccountStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: key => {
      map.delete(key)
    },
  }
}

// In-memory store matching createIdbPendingStore semantics exactly (single pending store).
function memoryStore() {
  let seq = 1
  const rows: PendingClickRecord[] = []
  const prune = (now: number) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (now - rows[i].at >= PENDING_TTL_MS) rows.splice(i, 1)
    }
  }
  const store: PendingClickStore & { rows: PendingClickRecord[]; removeCalls: number } = {
    rows,
    removeCalls: 0,
    async put(record, now) {
      prune(now)
      rows.push({ ...record, seq: seq++ })
    },
    async assignUnassigned(clientId, now) {
      prune(now)
      for (const row of rows) {
        if (row.clientId === null) row.clientId = clientId
      }
    },
    async remove(id, now) {
      store.removeCalls++
      prune(now)
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].id === id) rows.splice(i, 1)
      }
    },
    async listEligible(clientId, liveClientIds, now) {
      prune(now)
      const eligible: NotificationClickMessage[] = []
      for (const row of rows) {
        if (row.clientId === clientId || row.clientId === null || (liveClientIds !== null && !liveClientIds.has(row.clientId))) {
          eligible.push(row.message)
        }
      }
      return eligible
    },
    async clear() {
      rows.length = 0
    },
  }
  return store
}

function fakeClient(
  id: string,
  opts: {
    focused?: boolean
    frameType?: string
    focusErr?: Error
    onPost?: (msg: unknown, client: WindowClientLike) => void
  } = {}
) {
  const posted: unknown[] = []
  let focusCalls = 0
  const client: WindowClientLike & { posted: unknown[]; focusCalls: () => number } = {
    id,
    focused: opts.focused ?? false,
    frameType: opts.frameType ?? 'top-level',
    posted,
    focusCalls: () => focusCalls,
    async focus() {
      focusCalls++
      if (opts.focusErr) throw opts.focusErr
      return client
    },
    postMessage(msg) {
      posted.push(msg)
      opts.onPost?.(msg, client)
    },
  }
  return client
}

function fakeNotification(opts: { tag?: string; data?: unknown } = {}) {
  let closed = false
  return {
    tag: opts.tag,
    data: opts.data,
    close() {
      closed = true
    },
    closed: () => closed,
  }
}

function seqIds(prefix = 'click') {
  let n = 0
  return () => `${prefix}-${++n}`
}

function fakeHandshakeWorker(initialState = 'activated') {
  const posted: unknown[] = []
  const stateListeners: (() => void)[] = []
  const worker: RelayWorkerLike & { posted: unknown[]; setState: (next: string) => void } = {
    state: initialState,
    posted,
    postMessage(msg) {
      posted.push(msg)
    },
    addEventListener(type, fn) {
      if (type === 'statechange') stateListeners.push(fn)
    },
    setState(next: string) {
      worker.state = next
      for (const fn of [...stateListeners]) fn()
    },
  }
  return worker
}

test('buildClickMessage carries fresh id, tag, opaque data verbatim, and action only when non-empty', () => {
  const opaque = { nested: [1, { b: true }], untouched: 'value' }
  const plain = buildClickMessage(fakeNotification({ tag: 'todoer:abc', data: opaque }), '', 'c-1')
  expect(plain).toEqual({ type: NOTIFICATION_CLICK_TYPE, id: 'c-1', tag: 'todoer:abc', data: opaque })
  expect('action' in plain).toBe(false)
  expect(plain.data).toBe(opaque)

  const withAction = buildClickMessage(fakeNotification({ tag: 'x', data: null }), 'open', 'c-2')
  expect(withAction).toEqual({ type: NOTIFICATION_CLICK_TYPE, id: 'c-2', tag: 'x', data: null, action: 'open' })

  const bare = buildClickMessage(fakeNotification({}), undefined, 'c-3')
  expect(bare).toEqual({ type: NOTIFICATION_CLICK_TYPE, id: 'c-3', tag: '', data: null })
  expect('action' in bare).toBe(false)
})

test('orderWindowClients includes top-level and auxiliary windows, excludes nested frames, focused first then matchAll order', () => {
  const top1 = fakeClient('top1', { focused: false, frameType: 'top-level' })
  const aux = fakeClient('aux', { focused: false, frameType: 'auxiliary' })
  const auxFocused = fakeClient('aux-f', { focused: true, frameType: 'auxiliary' })
  const nested = fakeClient('nested', { focused: true, frameType: 'nested' })
  const none = fakeClient('none', { focused: true, frameType: 'none' })
  const top2 = fakeClient('top2', { focused: true, frameType: 'top-level' })

  expect(isEligibleWindowClient(top1)).toBe(true)
  expect(isEligibleWindowClient(aux)).toBe(true)
  expect(isEligibleWindowClient(nested)).toBe(false)
  expect(isEligibleWindowClient(none)).toBe(false)
  expect(orderWindowClients([nested, top1, aux, none, auxFocused, top2]).map(c => c.id)).toEqual(['aux-f', 'top2', 'top1', 'aux'])
  expect(orderWindowClients([nested, none])).toEqual([])
})

test('hello handshake (worker side): answered with protocol v2 to sender on durable hosts, silent on shared-page hosts', async () => {
  const store = memoryStore()
  const durable = createNotificationClickRelay(store)
  const sender = fakeClient('sender-1')
  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [sender] }, async openWindow() { return null } },
  }

  await durable.onMessage({ data: { type: NOTIFICATION_CLICK_HELLO }, source: sender }, sw)
  expect(sender.posted).toEqual([{ type: NOTIFICATION_CLICK_RELAY, version: NOTIFICATION_CLICK_RELAY_VERSION }])
  expect(NOTIFICATION_CLICK_RELAY_VERSION).toBe(2)

  // shared-page host passes store = null: hello is NOT answered
  const shared = createNotificationClickRelay(null)
  const sharedSender = fakeClient('shared-sender')
  await shared.onMessage({ data: { type: NOTIFICATION_CLICK_HELLO }, source: sharedSender }, sw)
  expect(sharedSender.posted).toEqual([])
})

test('page handshake accepts relay ONLY from the exact worker it asked (rejects missing source, pre-probe, and other workers)', async () => {
  const messageListeners: ((e: unknown) => void)[] = []
  const controllerListeners: (() => void)[] = []
  const readyGate = deferred<RelayRegistrationLike>()
  const sw: RelayContainerLike = {
    controller: null,
    ready: readyGate.promise,
    addEventListener(type, fn) {
      if (type === 'message') messageListeners.push(fn)
      if (type === 'controllerchange') controllerListeners.push(fn as () => void)
    },
  }
  const events: unknown[] = []
  const win: RelayWindowLike = {
    dispatchEvent(ev) {
      events.push(ev)
      return true
    },
  }
  attachNotificationRelayHandshake(sw, win)
  const fireMsg = (ev: Record<string, unknown>) => {
    for (const fn of messageListeners) fn(ev)
  }

  const w1 = fakeHandshakeWorker('activated')
  const wOther = fakeHandshakeWorker('activated')
  const okData = { type: NOTIFICATION_CLICK_RELAY, version: NOTIFICATION_CLICK_RELAY_VERSION }

  // Before any worker was probed: MUST reject even with a worker source or null source
  fireMsg({ isTrusted: true, target: sw, source: w1, data: okData })
  fireMsg({ isTrusted: true, target: sw, source: null, data: okData })
  expect(win._notification_click_relay).toBeUndefined()
  expect(win._notification_click_worker).toBeUndefined()
  expect(events).toEqual([])

  // Probe w1 via controllerchange
  sw.controller = w1
  for (const fn of controllerListeners) fn()
  expect(w1.posted).toEqual([{ type: NOTIFICATION_CLICK_HELLO }])

  // Missing source, wrong source, untrusted, wrong target, wrong version: ALL rejected
  fireMsg({ isTrusted: true, target: sw, source: null, data: okData })
  fireMsg({ isTrusted: true, target: sw, source: undefined, data: okData })
  fireMsg({ isTrusted: true, target: sw, source: wOther, data: okData })
  fireMsg({ isTrusted: false, target: sw, source: w1, data: okData })
  fireMsg({ isTrusted: true, target: {}, source: w1, data: okData })
  fireMsg({ isTrusted: true, target: sw, source: w1, data: { type: NOTIFICATION_CLICK_RELAY, version: 1 } })
  expect(win._notification_click_relay).toBeUndefined()
  expect(win._notification_click_worker).toBeUndefined()
  expect(events).toEqual([])

  // Exact probed worker answers -> accepted, marks set, event dispatched once
  fireMsg({ isTrusted: true, target: sw, source: w1, data: okData })
  expect(win._notification_click_relay).toBe(NOTIFICATION_CLICK_TYPE)
  expect(win._notification_click_worker).toBe(w1)
  expect(events).toHaveLength(1)

  // Duplicate reply from same already-confirmed worker does not double-dispatch
  fireMsg({ isTrusted: true, target: sw, source: w1, data: okData })
  expect(events).toHaveLength(1)
})

test('page handshake handles old active worker ignoring hello, then new worker activating and confirming (and later replacement)', async () => {
  const messageListeners: ((e: unknown) => void)[] = []
  const controllerListeners: (() => void)[] = []
  const updateListeners: (() => void)[] = []
  const oldWorker = fakeHandshakeWorker('activated')
  const reg: RelayRegistrationLike = {
    active: oldWorker,
    installing: null,
    waiting: null,
    addEventListener(type, fn) {
      if (type === 'updatefound') updateListeners.push(fn)
    },
  }
  const sw: RelayContainerLike = {
    controller: oldWorker,
    ready: Promise.resolve(reg),
    addEventListener(type, fn) {
      if (type === 'message') messageListeners.push(fn)
      if (type === 'controllerchange') controllerListeners.push(fn as () => void)
    },
  }
  const confirmedWorkers: unknown[] = []
  const win: RelayWindowLike = {
    dispatchEvent(ev) {
      confirmedWorkers.push((ev as CustomEvent).detail?.worker)
      return true
    },
  }
  attachNotificationRelayHandshake(sw, win)
  await Promise.resolve()

  // Old worker was probed and ignored `hello`: relay stays unconfirmed
  expect(oldWorker.posted).toEqual([{ type: NOTIFICATION_CLICK_HELLO }])
  expect(win._notification_click_relay).toBeUndefined()
  expect(win._notification_click_worker).toBeUndefined()
  expect(confirmedWorkers).toEqual([])

  // New worker installs via updatefound and activates -> probed -> answers hello -> confirmed!
  const newWorker = fakeHandshakeWorker('installing')
  reg.installing = newWorker
  for (const fn of updateListeners) fn()
  expect(newWorker.posted).toEqual([])

  reg.installing = null
  reg.active = newWorker
  oldWorker.setState('redundant')
  newWorker.setState('activated')
  expect(newWorker.posted).toEqual([{ type: NOTIFICATION_CLICK_HELLO }])

  const okData = { type: NOTIFICATION_CLICK_RELAY, version: NOTIFICATION_CLICK_RELAY_VERSION }
  // Late reply from oldWorker is ignored
  for (const fn of messageListeners) fn({ isTrusted: true, target: sw, source: oldWorker, data: okData })
  expect(win._notification_click_worker).toBeUndefined()

  // Reply from newWorker confirms it and dispatches event
  for (const fn of messageListeners) fn({ isTrusted: true, target: sw, source: newWorker, data: okData })
  expect(win._notification_click_relay).toBe(NOTIFICATION_CLICK_TYPE)
  expect(win._notification_click_worker).toBe(newWorker)
  expect(confirmedWorkers).toEqual([newWorker])

  // controllerchange to already-probed newWorker keeps confirmation without re-probing or double-dispatching
  sw.controller = newWorker
  for (const fn of controllerListeners) fn()
  expect(newWorker.posted).toHaveLength(1)
  expect(win._notification_click_worker).toBe(newWorker)
  expect(confirmedWorkers).toEqual([newWorker])

  // Later replacement worker3 takes over via controllerchange -> clears previous confirmation until worker3 answers
  const worker3 = fakeHandshakeWorker('activated')
  sw.controller = worker3
  for (const fn of controllerListeners) fn()
  expect(win._notification_click_relay).toBeUndefined()
  expect(win._notification_click_worker).toBeUndefined()
  expect(worker3.posted).toEqual([{ type: NOTIFICATION_CLICK_HELLO }])

  // Stale reply from newWorker after worker3 was probed is rejected
  for (const fn of messageListeners) fn({ isTrusted: true, target: sw, source: newWorker, data: okData })
  expect(win._notification_click_worker).toBeUndefined()

  // worker3 answers -> confirmed and event dispatched again
  for (const fn of messageListeners) fn({ isTrusted: true, target: sw, source: worker3, data: okData })
  expect(win._notification_click_relay).toBe(NOTIFICATION_CLICK_TYPE)
  expect(win._notification_click_worker).toBe(worker3)
  expect(confirmedWorkers).toEqual([newWorker, worker3])
})

const accountCleanupCases: [string, string | null | undefined, string | null | undefined, boolean][] = [
  ['same publisher reloading in admin mode (previous actual = publisher, confirmed = publisher)', 'y2swh7JY2ScO5soV7mJMHVltAOX2', 'y2swh7JY2ScO5soV7mJMHVltAOX2', false],
  ['same account reloading', 'uid-a', 'uid-a', false],
  ['account A then none (step 1 of A -> none -> B): clears', 'uid-a', null, true],
  ['none then account B (step 2 of A -> none -> B): already cleared', null, 'uid-b', false],
  ['account A directly to account B: clears', 'uid-a', 'uid-b', true],
  ['sign-out made in another tab that this tab learns of: clears', 'uid-a', null, true],
  ['admin-mode publisher signed out in another tab: clears', 'y2swh7JY2ScO5soV7mJMHVltAOX2', null, true],
  ['signed-out visitor reloading: no clear', null, null, false],
  ['fresh sign-in from signed-out state: no clear', undefined, 'uid-a', false],
  ['acting anonymous record never clears signed-in account', 'anonymous', 'uid-a', false],
  ['signed-in record to anonymous clears', 'uid-a', 'anonymous', true],
]

for (const [name, recordedUid, confirmedUid, expected] of accountCleanupCases) {
  test(`shouldClearNotificationRelay: ${name}`, () => {
    expect(shouldClearNotificationRelay(recordedUid, confirmedUid)).toBe(expected)
  })
}

test('two tabs sharing one registration and shared account record: late suspended tab waking on B leaves B card and stored click intact', async () => {
  const storage = memoryStorage()
  const store = memoryStore()
  const relay = createNotificationClickRelay(store, { now: () => 10_000, makeId: seqIds(), ackTimeoutMs: 10, totalAckBudgetMs: 50 })
  const notifications: Array<ReturnType<typeof fakeNotification>> = []
  let windows: WindowClientLike[] = []
  const sw: ServiceWorkerScopeLike = {
    registration: {
      scope: 'https://mind.page/',
      async getNotifications() {
        return notifications.filter(n => !n.closed())
      },
    },
    clients: {
      async matchAll() {
        return windows
      },
      async openWindow() {
        return null
      },
    },
  }
  const clearCalls: string[] = []
  const sendClear = (who: string) => {
    clearCalls.push(who)
    return relay.onMessage({ data: { type: NOTIFICATION_CLICK_CLEAR }, source: null }, sw)
  }

  // Both Tab 1 and Tab 2 initialize as account A (shared record -> uid-a)
  expect(reconcileNotificationRelayAccount(storage, 'uid-a')).toBe(false)
  expect(reconcileNotificationRelayAccount(storage, 'uid-a')).toBe(false)
  expect(storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)).toBe('uid-a')

  // Account A has a visible card and a stored click
  const cardA = fakeNotification({ tag: 'todoer:a1', data: { source: 'todoer', item: 'a1' } })
  notifications.push(cardA)
  windows = [fakeClient('tab-a', { focused: true })]
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:a2', data: { source: 'todoer', item: 'a2' } }) }, sw)
  expect(store.rows).toHaveLength(1)

  // Tab 1 explicitly signs out A: clears worker relay and removes shared record
  clearNotificationRelayAccount(storage)
  await sendClear('tab1-signout')
  expect(cardA.closed()).toBe(true)
  expect(store.rows).toEqual([])
  expect(storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)).toBeNull()

  // Tab 1 signs in as B: writes shared record = uid-b without clearing
  expect(reconcileNotificationRelayAccount(storage, 'uid-b')).toBe(false)
  expect(storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)).toBe('uid-b')

  // B shows a visible card AND has a stored pending click BEFORE suspended Tab 2 wakes up
  const cardB = fakeNotification({ tag: 'todoer:b1', data: { source: 'todoer', item: 'b1' } })
  notifications.push(cardB)
  const bClickCard = fakeNotification({ tag: 'todoer:b2', data: { source: 'todoer', item: 'b2' } })
  await relay.onNotificationClick({ notification: bClickCard }, sw)
  expect(store.rows.map(r => r.message.tag)).toEqual(['todoer:b2'])

  // Suspended Tab 2 (which was open as A) wakes up and receives external auth callback for B:
  // finds shared record already at uid-b -> sends NO clear; B's visible card and stored click survive!
  let tab2Invalidations = 0
  let tab2Reloads = 0
  const tab2Reloader = createExternalAuthReloader({
    storage,
    win: {},
    documentUid: 'uid-a',
    invalidateKeys: () => {
      tab2Invalidations++
    },
    clearRelay: () => sendClear('tab2-late'),
    reload: () => {
      tab2Reloads++
    },
  })
  await tab2Reloader('uid-b')

  expect(tab2Invalidations).toBe(1)
  expect(tab2Reloads).toBe(1)
  expect(clearCalls).toEqual(['tab1-signout'])
  expect(cardB.closed()).toBe(false)
  expect(store.rows.map(r => r.message.tag)).toEqual(['todoer:b2'])
  expect(storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)).toBe('uid-b')
})

test('two observers after a pre-upgrade sign-out: first updated observer clears A once and updates shared record, second stale observer preserves B', async () => {
  const storage = memoryStorage({ [NOTIFICATION_RELAY_ACCOUNT_KEY]: 'uid-a' })
  const store = memoryStore()
  const relay = createNotificationClickRelay(store, { now: () => 20_000, makeId: seqIds(), ackTimeoutMs: 10, totalAckBudgetMs: 50 })
  const notifications: Array<ReturnType<typeof fakeNotification>> = []
  const sw: ServiceWorkerScopeLike = {
    registration: {
      scope: 'https://mind.page/',
      async getNotifications() {
        return notifications.filter(n => !n.closed())
      },
    },
    clients: {
      async matchAll() {
        return [fakeClient('reloading', { focused: true })]
      },
      async openWindow() {
        return null
      },
    },
  }
  const clearCalls: string[] = []
  const sendClear = (who: string) => {
    clearCalls.push(who)
    return relay.onMessage({ data: { type: NOTIFICATION_CLICK_CLEAR }, source: null }, sw)
  }

  const cardA = fakeNotification({ tag: 'todoer:a1', data: { source: 'todoer', item: 'a1' } })
  notifications.push(cardA)
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:a2', data: { source: 'todoer', item: 'a2' } }) }, sw)

  // Pre-upgrade tab switched A -> B without touching the shared record (still uid-a).
  // Updated observer 1 sees uid-b -> clears A once and writes uid-b.
  const obs1 = createExternalAuthReloader({
    storage,
    win: {},
    documentUid: 'uid-a',
    invalidateKeys: () => {},
    clearRelay: () => sendClear('obs1'),
    reload: () => {},
  })
  await obs1('uid-b')
  expect(clearCalls).toEqual(['obs1'])
  expect(cardA.closed()).toBe(true)
  expect(store.rows).toEqual([])
  expect(storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)).toBe('uid-b')

  // B now shows a card and gets a stored click before observer 2 wakes up
  const cardB = fakeNotification({ tag: 'todoer:b1', data: { source: 'todoer', item: 'b1' } })
  notifications.push(cardB)
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:b2', data: { source: 'todoer', item: 'b2' } }) }, sw)

  // Updated observer 2 wakes up with uid-b -> sees shared record already at uid-b -> no clear!
  const obs2 = createExternalAuthReloader({
    storage,
    win: {},
    documentUid: 'uid-a',
    invalidateKeys: () => {},
    clearRelay: () => sendClear('obs2'),
    reload: () => {},
  })
  await obs2('uid-b')
  expect(clearCalls).toEqual(['obs1'])
  expect(cardB.closed()).toBe(false)
  expect(store.rows.map(r => r.message.tag)).toEqual(['todoer:b2'])
})

test('external auth reloader: after a canceled reload, a later callback for another account runs key invalidation, relay cleanup, and reload again', async () => {
  const storage = memoryStorage({ [NOTIFICATION_RELAY_ACCOUNT_KEY]: 'uid-a' })
  const clearGates = [deferred<void>(), deferred<void>(), deferred<void>()]
  let clearIdx = 0
  let invalidations = 0
  let reloads = 0
  const reloader = createExternalAuthReloader({
    storage,
    win: {},
    documentUid: 'uid-a',
    invalidateKeys: () => {
      invalidations++
    },
    clearRelay: () => clearGates[clearIdx++].promise,
    reload: () => {
      // Simulate owner choosing Stay at the browser's unsaved-changes discard prompt:
      // the document stays alive and receives further auth callbacks.
      reloads++
    },
  })

  // 1. First transition (uid-a -> uid-b): invalidates keys, awaits clear, then requests reload
  const p1 = reloader('uid-b')
  expect([invalidations, clearIdx, reloads, storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)]).toEqual([1, 1, 0, 'uid-b'])
  clearGates[0].resolve()
  await p1
  expect(reloads).toBe(1)

  // 2. Reload was canceled; next callback for uid-c must run EVERY effect again
  const p2 = reloader('uid-c')
  expect([invalidations, clearIdx, reloads, storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)]).toEqual([2, 2, 1, 'uid-c'])
  clearGates[1].resolve()
  await p2
  expect(reloads).toBe(2)

  // 3. Reload canceled again; callback matching shared record needs no clear, still invalidates and reloads synchronously
  reloader('uid-c')
  expect([invalidations, clearIdx, reloads]).toEqual([3, 2, 3])

  // 4. Reload canceled again; sign-out transition clears relay, removes shared record, and requests reload
  const p4 = reloader(null)
  expect([invalidations, clearIdx, reloads, storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)]).toEqual([4, 3, 3, null])
  clearGates[2].resolve()
  await p4
  expect(reloads).toBe(4)
})

test('external auth reloader: overlapping callback during in-flight cleanup waits for cleanup before one reload, then releases guard before navigation', async () => {
  const storage = memoryStorage({ [NOTIFICATION_RELAY_ACCOUNT_KEY]: 'uid-a' })
  const clearGates = [deferred<void>(), deferred<void>()]
  let clearIdx = 0
  let invalidations = 0
  let reloads = 0
  const reloader = createExternalAuthReloader({
    storage,
    win: {},
    documentUid: 'uid-a',
    invalidateKeys: () => {
      invalidations++
    },
    clearRelay: () => clearGates[clearIdx++].promise,
    reload: () => {
      reloads++
    },
  })

  // Callback 1 starts clearing uid-a -> null
  const p1 = reloader(null)
  // Callback 2 arrives while clear #1 is still in flight (null -> uid-b): does not reload early or double-reload
  const p2 = reloader('uid-b')
  expect([invalidations, clearIdx, reloads, storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)]).toEqual([2, 1, 0, 'uid-b'])
  clearGates[0].resolve()
  await Promise.all([p1, p2])
  expect(reloads).toBe(1)

  // After that reload is canceled, a subsequent transition (uid-b -> uid-c) runs fully again
  const p3 = reloader('uid-c')
  expect([invalidations, clearIdx, reloads, storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)]).toEqual([3, 2, 1, 'uid-c'])
  clearGates[1].resolve()
  await p3
  expect(reloads).toBe(2)
})

test('external auth reloader: marks document left and withdraws relay marks before reload on another account (permanently), not on the same account', async () => {
  expect(hasNotificationAccountChanged('uid-a', 'uid-a')).toBe(false)
  expect(hasNotificationAccountChanged('uid-a', null)).toBe(true)
  expect(hasNotificationAccountChanged('uid-a', 'uid-b')).toBe(true)
  expect(hasNotificationAccountChanged(null, 'uid-a')).toBe(true)
  expect(hasNotificationAccountChanged(null, null)).toBe(false)
  expect(hasNotificationAccountChanged('anonymous', null)).toBe(false)

  // 1. Another account (sign-out with clear in flight): mark stands and relay marks are withdrawn
  //    BEFORE clearRelay and BEFORE reload, and stay permanently even if another tab later signs
  //    back into the original account while this document stayed open.
  const workerA = fakeHandshakeWorker('activated')
  const messageListeners: Array<(e: any) => void> = []
  const controllerListeners: Array<() => void> = []
  const swForHandshake: RelayContainerLike = {
    controller: workerA,
    addEventListener(type, fn) {
      if (type === 'message') messageListeners.push(fn)
      if (type === 'controllerchange') controllerListeners.push(() => fn(undefined))
    },
  }
  const relayEvents: unknown[] = []
  const winA: RelayWindowLike = {
    dispatchEvent(ev) {
      relayEvents.push(ev)
      return true
    },
  }
  attachNotificationRelayHandshake(swForHandshake, winA)
  for (const fn of messageListeners) {
    fn({ isTrusted: true, target: swForHandshake, source: workerA, data: { type: NOTIFICATION_CLICK_RELAY, version: NOTIFICATION_CLICK_RELAY_VERSION } })
  }
  expect(winA._notification_click_relay).toBe(NOTIFICATION_CLICK_TYPE)
  expect(winA._notification_click_worker).toBe(workerA)
  expect(relayEvents).toHaveLength(1)

  const storageA = memoryStorage({ [NOTIFICATION_RELAY_ACCOUNT_KEY]: 'uid-a' })
  const clearGate = deferred<void>()
  const snapshots: Array<{ at: string; left: boolean | undefined; relay: string | undefined; worker: RelayWorkerLike | undefined }> = []
  const snap = (at: string, win: RelayWindowLike) =>
    snapshots.push({ at, left: win._notification_account_left, relay: win._notification_click_relay, worker: win._notification_click_worker })

  const reloaderA = createExternalAuthReloader({
    storage: storageA,
    win: winA,
    documentUid: 'uid-a',
    invalidateKeys: () => {},
    clearRelay: () => {
      snap('clearRelay', winA)
      return clearGate.promise
    },
    reload: () => {
      snap('reload', winA)
    },
  })

  const pending = reloaderA(null)
  expect(winA._notification_account_left).toBe(true)
  expect(winA._notification_click_relay).toBeUndefined()
  expect(winA._notification_click_worker).toBeUndefined()
  clearGate.resolve()
  await pending
  expect(snapshots).toEqual([
    { at: 'clearRelay', left: true, relay: undefined, worker: undefined },
    { at: 'reload', left: true, relay: undefined, worker: undefined },
  ])

  // Canceled reload: a later callback back to uid-a NEVER clears the mark, and a newly activated
  // worker cannot re-establish the withdrawn relay marks on this departed document.
  reloaderA('uid-a')
  expect(winA._notification_account_left).toBe(true)
  expect(winA._notification_click_relay).toBeUndefined()
  expect(winA._notification_click_worker).toBeUndefined()
  const workerNext = fakeHandshakeWorker('activated')
  swForHandshake.controller = workerNext
  for (const fn of controllerListeners) fn()
  for (const fn of messageListeners) {
    fn({ isTrusted: true, target: swForHandshake, source: workerNext, data: { type: NOTIFICATION_CLICK_RELAY, version: NOTIFICATION_CLICK_RELAY_VERSION } })
  }
  expect(workerNext.posted).toEqual([])
  expect(winA._notification_click_relay).toBeUndefined()
  expect(winA._notification_click_worker).toBeUndefined()
  expect(relayEvents).toHaveLength(1)

  // 2. Another account when the other tab ALREADY cleared the shared record (synchronous reload):
  //    mark still stands and relay marks are withdrawn BEFORE reload is requested.
  const workerSync = fakeHandshakeWorker('activated')
  const winSync: RelayWindowLike = { _notification_click_relay: NOTIFICATION_CLICK_TYPE, _notification_click_worker: workerSync }
  let seenAtSyncReload: { left: boolean | undefined; relay: string | undefined; worker: RelayWorkerLike | undefined } | null = null
  const reloaderSync = createExternalAuthReloader({
    storage: memoryStorage(), // already cleared by another tab
    win: winSync,
    documentUid: 'uid-a',
    invalidateKeys: () => {},
    clearRelay: () => {
      throw new Error('clearRelay should not run when shared record already cleared')
    },
    reload: () => {
      seenAtSyncReload = {
        left: winSync._notification_account_left,
        relay: winSync._notification_click_relay,
        worker: winSync._notification_click_worker,
      }
    },
  })
  reloaderSync(null)
  expect(seenAtSyncReload).toEqual({ left: true, relay: undefined, worker: undefined })

  // 3. Same account (same-account sign-in elsewhere): reload still runs, but document is NOT
  //    marked left and its relay marks stay intact.
  const workerSame = fakeHandshakeWorker('activated')
  const sameWin: RelayWindowLike = { _notification_click_relay: NOTIFICATION_CLICK_TYPE, _notification_click_worker: workerSame }
  let sameReloads = 0
  let sameClears = 0
  let seenAtSameReload: { left: boolean | undefined; relay: string | undefined; worker: RelayWorkerLike | undefined } | null = null
  const sameReloader = createExternalAuthReloader({
    storage: memoryStorage({ [NOTIFICATION_RELAY_ACCOUNT_KEY]: 'uid-a' }),
    win: sameWin,
    documentUid: 'uid-a',
    invalidateKeys: () => {},
    clearRelay: () => {
      sameClears++
    },
    reload: () => {
      sameReloads++
      seenAtSameReload = {
        left: sameWin._notification_account_left,
        relay: sameWin._notification_click_relay,
        worker: sameWin._notification_click_worker,
      }
    },
  })
  sameReloader('uid-a')
  expect(sameReloads).toBe(1)
  expect(sameClears).toBe(0)
  expect(seenAtSameReload).toEqual({ left: undefined, relay: NOTIFICATION_CLICK_TYPE, worker: workerSame })
  expect(sameWin._notification_account_left).toBeUndefined()
  expect(sameWin._notification_click_relay).toBe(NOTIFICATION_CLICK_TYPE)
  expect(sameWin._notification_click_worker).toBe(workerSame)
})

test('clearNotificationRelay: timed-out lookup expires and posts no late clear when resolved after next account settles', async () => {
  const store = memoryStore()
  const relay = createNotificationClickRelay(store, { now: () => 30_000, makeId: seqIds(), ackTimeoutMs: 10, totalAckBudgetMs: 50 })
  const notifications: Array<ReturnType<typeof fakeNotification>> = []
  const swScope: ServiceWorkerScopeLike = {
    registration: {
      scope: 'https://mind.page/',
      async getNotifications() {
        return notifications.filter(n => !n.closed())
      },
    },
    clients: {
      async matchAll() {
        return [fakeClient('reloading-b', { focused: true })]
      },
      async openWindow() {
        return null
      },
    },
  }
  const postedToWorker: unknown[] = []
  const worker: RelayWorkerLike = {
    state: 'activated',
    postMessage(msg) {
      postedToWorker.push(msg)
      void relay.onMessage({ data: msg, source: null }, swScope)
    },
  }

  // Page has no controller; getRegistration() is held while the wait ends.
  const lookup = deferred<RelayRegistrationLike | undefined>()
  const wait = deferred<void>()
  const swContainer: ClearRelayContainerLike = {
    controller: null,
    getRegistration: () => lookup.promise,
  }

  const clearPromise = clearNotificationRelay(swContainer, wait.promise)
  expect(postedToWorker).toEqual([])

  // Wait ends before getRegistration resolves: caller gets `'timed_out'` and the attempt expires.
  wait.resolve()
  expect(await clearPromise).toBe('timed_out')

  // Next account B settles with a visible card and a stored click.
  const cardB = fakeNotification({ tag: 'todoer:b1', data: { source: 'todoer', item: 'b1' } })
  notifications.push(cardB)
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:b2', data: { source: 'todoer', item: 'b2' } }) }, swScope)
  expect(store.rows.map(r => r.message.tag)).toEqual(['todoer:b2'])

  // Held lookup now resolves: nothing is posted and B's card and stored click both survive.
  lookup.resolve({ active: worker })
  await Promise.resolve()
  await Promise.resolve()
  expect(postedToWorker).toEqual([])
  expect(cardB.closed()).toBe(false)
  expect(store.rows.map(r => r.message.tag)).toEqual(['todoer:b2'])

  // Also when a controller already received clear synchronously and getRegistration() times out:
  // result is `'posted'` (controller got it), and a late lookup resolving a different active worker
  // posts nothing after expiry.
  const controllerPosted: unknown[] = []
  const lateActivePosted: unknown[] = []
  const controllerWorker: RelayWorkerLike = { state: 'activated', postMessage: m => controllerPosted.push(m) }
  const lateActiveWorker: RelayWorkerLike = { state: 'activated', postMessage: m => lateActivePosted.push(m) }
  const lookup2 = deferred<RelayRegistrationLike | undefined>()
  const wait2 = deferred<void>()
  const res2 = clearNotificationRelay({ controller: controllerWorker, getRegistration: () => lookup2.promise }, wait2.promise)
  wait2.resolve()
  expect(await res2).toBe('posted')
  lookup2.resolve({ active: lateActiveWorker })
  await Promise.resolve()
  await Promise.resolve()
  expect(controllerPosted).toEqual([{ type: NOTIFICATION_CLICK_CLEAR }])
  expect(lateActivePosted).toEqual([])
})

test('clearNotificationRelay: reports posted through controller or registration, and no_worker when no active worker exists', async () => {
  // 1. Posted through controller alone (no getRegistration)
  const w1 = fakeHandshakeWorker('activated')
  expect(await clearNotificationRelay({ controller: w1 })).toBe('posted')
  expect(w1.posted).toEqual([{ type: NOTIFICATION_CLICK_CLEAR }])

  // 2. Posted through controller with matching reg.active (posted once, timer cleared with numeric wait)
  const w2 = fakeHandshakeWorker('activated')
  expect(await clearNotificationRelay({ controller: w2, getRegistration: async () => ({ active: w2 }) }, 60_000)).toBe('posted')
  expect(w2.posted).toEqual([{ type: NOTIFICATION_CLICK_CLEAR }])

  // 3. Posted through controller AND a different reg.active before wait ends
  const wCtrl = fakeHandshakeWorker('activated')
  const wActive = fakeHandshakeWorker('activated')
  const wait3 = deferred<void>()
  expect(await clearNotificationRelay({ controller: wCtrl, getRegistration: async () => ({ active: wActive }) }, wait3.promise)).toBe('posted')
  expect(wCtrl.posted).toEqual([{ type: NOTIFICATION_CLICK_CLEAR }])
  expect(wActive.posted).toEqual([{ type: NOTIFICATION_CLICK_CLEAR }])

  // 4. No controller -> posted through getRegistration().active before wait ends
  const wReg = fakeHandshakeWorker('activated')
  const lookup4 = deferred<RelayRegistrationLike | undefined>()
  const wait4 = deferred<void>()
  const p4 = clearNotificationRelay({ controller: null, getRegistration: () => lookup4.promise }, wait4.promise)
  lookup4.resolve({ active: wReg })
  expect(await p4).toBe('posted')
  expect(wReg.posted).toEqual([{ type: NOTIFICATION_CLICK_CLEAR }])

  // 5. No worker cases -> `'no_worker'`
  expect(await clearNotificationRelay(null)).toBe('no_worker')
  expect(await clearNotificationRelay({ controller: null })).toBe('no_worker')
  expect(await clearNotificationRelay({ controller: null, getRegistration: async () => undefined }, deferred<void>().promise)).toBe('no_worker')
  expect(await clearNotificationRelay({ controller: null, getRegistration: async () => ({ active: null }) }, deferred<void>().promise)).toBe('no_worker')
  expect(
    await clearNotificationRelay(
      {
        controller: null,
        getRegistration: async () => {
          throw new Error('lookup failed')
        },
      },
      deferred<void>().promise
    )
  ).toBe('no_worker')
  const throwingWorker: RelayWorkerLike = {
    state: 'activated',
    postMessage() {
      throw new Error('post failed')
    },
  }
  expect(
    await clearNotificationRelay({ controller: throwingWorker, getRegistration: async () => ({ active: throwingWorker }) }, deferred<void>().promise)
  ).toBe('no_worker')
})

test('first window does not answer, second answers: focus goes to the second and received deletes the stored click', async () => {
  const store = memoryStore()
  const w1Got = deferred<void>()
  const w2Got = deferred<NotificationClickMessage>()
  const releaseAck = deferred<void>()
  let relay!: ReturnType<typeof createNotificationClickRelay>

  const w1 = fakeClient('w1', {
    focused: true,
    onPost: () => w1Got.resolve(),
  })
  const w2 = fakeClient('w2', {
    focused: false,
    onPost: msg => {
      const m = msg as NotificationClickMessage
      w2Got.resolve(m)
      void releaseAck.promise.then(() =>
        relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: w2 }, sw)
      )
    },
  })
  const nested = fakeClient('iframe', { focused: true, frameType: 'nested' })
  const matchCalls: unknown[] = []
  let openCalls = 0
  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll(opts) {
        matchCalls.push(opts)
        return [nested, w1, w2]
      },
      async openWindow() {
        openCalls++
        return null
      },
    },
  }
  relay = createNotificationClickRelay(store, { now: () => 1000, makeId: seqIds(), ackTimeoutMs: 25, totalAckBudgetMs: 200 })

  const n = fakeNotification({ tag: 'todoer:1', data: { source: 'todoer', item: '1' } })
  const clickDone = relay.onNotificationClick({ notification: n }, sw)

  await w1Got.promise
  // click is stored BEFORE probing settles
  expect(store.rows).toHaveLength(1)
  expect(nested.posted).toEqual([])

  const m2 = await w2Got.promise
  expect(m2).toEqual({ type: NOTIFICATION_CLICK_TYPE, id: 'click-1', tag: 'todoer:1', data: { source: 'todoer', item: '1' } })
  releaseAck.resolve()
  await clickDone

  expect(n.closed()).toBe(true)
  expect(matchCalls).toEqual([{ type: 'window', includeUncontrolled: true }])
  expect(openCalls).toBe(0)
  expect(w1.focusCalls()).toBe(0)
  expect(w2.focusCalls()).toBe(1)
  expect(store.rows).toEqual([])
  expect(store.removeCalls).toBe(1)
})

test('nobody answers with a window present (e.g. static page or reloading tab): focuses first, leaves click unassigned so any ready app window takes it', async () => {
  const store = memoryStore()
  const staticPage = fakeClient('static-hello', { focused: true })
  let windows: WindowClientLike[] = [staticPage]
  let openCalls = 0
  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() {
        return windows
      },
      async openWindow() {
        openCalls++
        return null
      },
    },
  }
  const relay = createNotificationClickRelay(store, { now: () => 2000, makeId: seqIds(), ackTimeoutMs: 20, totalAckBudgetMs: 100 })
  const n = fakeNotification({ tag: 'todoer:reloading', data: { source: 'todoer', item: 'item-a' } })
  await relay.onNotificationClick({ notification: n }, sw)

  expect(n.closed()).toBe(true)
  expect(openCalls).toBe(0)
  expect(staticPage.focusCalls()).toBe(1)
  expect(store.rows).toHaveLength(1)
  // Stays UNASSIGNED (clientId === null), NOT bound to staticPage
  expect(store.rows[0].clientId).toBeNull()

  // An app window opens later while staticPage is STILL alive and says `ready` -> takes the click!
  const appWin = fakeClient('app-later', { focused: false })
  windows = [staticPage, appWin]
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: appWin }, sw)
  expect(appWin.posted).toEqual([
    { type: NOTIFICATION_CLICK_TYPE, id: 'click-1', tag: 'todoer:reloading', data: { source: 'todoer', item: 'item-a' } },
  ])
  // Still stored until `received`
  expect(store.rows).toHaveLength(1)

  // The same window says `ready` again before it answered (its item arrived after its first
  // `ready`, see the todoer's wait for the server-confirmed corpus): the kept click is sent again
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: appWin }, sw)
  expect(appWin.posted.map(m => (m as NotificationClickMessage).id)).toEqual(['click-1', 'click-1'])
  expect(store.rows).toHaveLength(1)

  // appWin acknowledges receipt -> stored click is deleted; subsequent ready delivers nothing
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: 'click-1' }, source: appWin }, sw)
  expect(store.rows).toEqual([])
  appWin.posted.length = 0
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: appWin }, sw)
  expect(appWin.posted).toEqual([])
})

test('refused focus still delivers to answering window and deletes click without calling openWindow', async () => {
  const store = memoryStore()
  let relay!: ReturnType<typeof createNotificationClickRelay>
  const w1 = fakeClient('w1', {
    focusErr: new Error('InvalidAccessError: Not allowed to focus a window.'),
    onPost: msg => {
      const m = msg as NotificationClickMessage
      queueMicrotask(() => void relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: w1 }, sw))
    },
  })
  let openCalls = 0
  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() {
        return [w1]
      },
      async openWindow() {
        openCalls++
        return null
      },
    },
  }
  relay = createNotificationClickRelay(store, { now: () => 1000, makeId: seqIds(), ackTimeoutMs: 30 })
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:2', data: { item: '2' } }), action: 'reply' }, sw)

  expect(openCalls).toBe(0)
  expect(w1.focusCalls()).toBe(1)
  expect(w1.posted).toEqual([{ type: NOTIFICATION_CLICK_TYPE, id: 'click-1', tag: 'todoer:2', data: { item: '2' }, action: 'reply' }])
  expect(store.rows).toEqual([])
})

test('two clicks overlapping one cold open (held openWindow promise): one open, opened window id written onto unassigned clicks, both delivered at ready', async () => {
  const store = memoryStore()
  const opened = fakeClient('win-cold')
  const openEntered = deferred<void>()
  const openGate = deferred<WindowClientLike | null>()
  let windows: WindowClientLike[] = []
  let openCalls = 0
  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() {
        return windows
      },
      openWindow() {
        openCalls++
        openEntered.resolve()
        return openGate.promise
      },
    },
  }
  const relay = createNotificationClickRelay(store, { now: () => 10_000, makeId: seqIds(), ackTimeoutMs: 20 })

  // Click 1 starts openWindow and blocks on openGate
  const p1 = relay.onNotificationClick({ notification: fakeNotification({ tag: 't:1', data: { n: 1 } }) }, sw)
  await openEntered.promise

  // Simulate the browser making the new client visible in matchAll BEFORE openWindow resolves
  windows = [opened]

  // Click 2 arrives while openWindow is STILL pending
  const p2 = relay.onNotificationClick({ notification: fakeNotification({ tag: 't:2', data: { n: 2 } }) }, sw)

  // Also test ready arriving while openWindow is still in-flight: waits for assignUnassigned, then delivers both
  const readyDone = relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: opened }, sw)

  openGate.resolve(opened)
  await Promise.all([p1, p2, readyDone])

  expect(openCalls).toBe(1)
  expect(store.rows.map(r => r.clientId)).toEqual(['win-cold', 'win-cold'])
  expect(opened.posted).toHaveLength(2)
  const [m1, m2] = opened.posted as NotificationClickMessage[]
  expect(m1).toMatchObject({ type: NOTIFICATION_CLICK_TYPE, tag: 't:1', data: { n: 1 } })
  expect(m2).toMatchObject({ type: NOTIFICATION_CLICK_TYPE, tag: 't:2', data: { n: 2 } })
  expect(m1.id).not.toBe(m2.id)

  // Receive both -> store empties
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m1.id }, source: opened }, sw)
  expect(store.rows).toHaveLength(1)
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m2.id }, source: opened }, sw)
  expect(store.rows).toEqual([])
})

test('bystander ready arriving while openWindow is in-flight waits and does NOT steal click addressed to live opened window; dead opened window is taken over', async () => {
  const store = memoryStore()
  const opened = fakeClient('win-opened')
  const bystander = fakeClient('win-bystander')
  const openEntered = deferred<void>()
  const openGate = deferred<WindowClientLike | null>()
  let windows: WindowClientLike[] = [bystander]
  let matchCount = 0
  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() {
        return matchCount++ === 0 ? [] : windows
      },
      openWindow() {
        openEntered.resolve()
        return openGate.promise
      },
    },
  }
  const relay = createNotificationClickRelay(store, { now: () => 30_000, makeId: seqIds() })
  const clickP = relay.onNotificationClick({ notification: fakeNotification({ tag: 't:own', data: 'mine' }) }, sw)
  await openEntered.promise

  const readyP = relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: bystander }, sw)
  windows = [opened, bystander]
  openGate.resolve(opened)
  await Promise.all([clickP, readyP])

  expect(bystander.posted).toEqual([])
  expect(store.rows).toHaveLength(1)
  expect(store.rows[0].clientId).toBe('win-opened')

  // Once win-opened disappears (closed or reloaded with a new client id), a ready replacement takes it
  const replacement = fakeClient('win-reloaded')
  windows = [replacement, bystander]
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: replacement }, sw)
  expect(replacement.posted).toEqual([{ type: NOTIFICATION_CLICK_TYPE, id: 'click-1', tag: 't:own', data: 'mine' }])
})

test('clear closes every notification of the registration and deletes every stored click', async () => {
  const store = memoryStore()
  const n1 = fakeNotification({ tag: 'todoer:1', data: { item: '1' } })
  const n2 = fakeNotification({ tag: 'todoer:2', data: { item: '2' } })
  const win = fakeClient('w1')
  const sw: ServiceWorkerScopeLike = {
    registration: {
      scope: 'https://mind.page/',
      async getNotifications() {
        return [n1, n2]
      },
    },
    clients: {
      async matchAll() {
        return [win]
      },
      async openWindow() {
        return null
      },
    },
  }
  const relay = createNotificationClickRelay(store, { now: () => 10_000, makeId: seqIds(), ackTimeoutMs: 10 })
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:kept', data: { item: 'k' } }) }, sw)
  expect(store.rows).toHaveLength(1)

  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_CLEAR }, source: win }, sw)
  expect(n1.closed()).toBe(true)
  expect(n2.closed()).toBe(true)
  expect(store.rows).toEqual([])

  win.posted.length = 0
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: win }, sw)
  expect(win.posted).toEqual([])
})

test('expiry drops stored clicks five minutes after their click at the next store use', async () => {
  const store = memoryStore()
  let clock = 100_000
  const w = fakeClient('w-exp')
  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() {
        return [w]
      },
      async openWindow() {
        return null
      },
    },
  }
  const relay = createNotificationClickRelay(store, { now: () => clock, makeId: seqIds(), ackTimeoutMs: 10 })
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 't:old', data: 'stale' }) }, sw)
  expect(store.rows).toHaveLength(1)

  // 1 ms before expiry: still delivered on ready
  clock = 100_000 + PENDING_TTL_MS - 1
  w.posted.length = 0
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: w }, sw)
  expect(w.posted).toHaveLength(1)
  expect(store.rows).toHaveLength(1)

  // at exact 5-minute cutoff: dropped and not delivered
  clock = 100_000 + PENDING_TTL_MS
  w.posted.length = 0
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: w }, sw)
  expect(w.posted).toEqual([])
  expect(store.rows).toEqual([])
})

test('shared-page host (store = null): stores nothing, best-effort in-memory probe still delivers to live window', async () => {
  let relay!: ReturnType<typeof createNotificationClickRelay>
  const w1 = fakeClient('w-shared', {
    onPost: msg => {
      const m = msg as NotificationClickMessage
      queueMicrotask(() => void relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: w1 }, sw))
    },
  })
  let windows: WindowClientLike[] = [w1]
  let openCalls = 0
  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://shared.mind.page/' },
    clients: {
      async matchAll() {
        return windows
      },
      async openWindow() {
        openCalls++
        return fakeClient('w-new')
      },
    },
  }
  relay = createNotificationClickRelay(null, { now: () => 1000, makeId: seqIds(), ackTimeoutMs: 25 })
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 't:s', data: 'ok' }) }, sw)
  expect(w1.posted).toEqual([{ type: NOTIFICATION_CLICK_TYPE, id: 'click-1', tag: 't:s', data: 'ok' }])
  expect(w1.focusCalls()).toBe(1)
  expect(openCalls).toBe(0)

  // no windows on shared host: opens app best-effort without storing anything
  windows = []
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 't:s2', data: 'cold' }) }, sw)
  expect(openCalls).toBe(1)
})

test('storage errors never lose a click that a live window can take at once, and fall back gracefully on cold open', async () => {
  const brokenStore: PendingClickStore = {
    async put() { throw new Error('IDB blocked') },
    async assignUnassigned() { throw new Error('IDB blocked') },
    async remove() { throw new Error('IDB blocked') },
    async listEligible() { throw new Error('IDB blocked') },
    async clear() { throw new Error('IDB blocked') },
  }
  let relay!: ReturnType<typeof createNotificationClickRelay>
  const live = fakeClient('w-live', {
    onPost: msg => {
      const m = msg as NotificationClickMessage
      queueMicrotask(() => void relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: live }, swLive))
    },
  })
  const swLive: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() { return [live] },
      async openWindow() { return null },
    },
  }
  relay = createNotificationClickRelay(brokenStore, { now: () => 60_000, makeId: seqIds(), ackTimeoutMs: 25 })
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 't:live', data: 'ok' }) }, swLive)
  expect(live.posted).toEqual([{ type: NOTIFICATION_CLICK_TYPE, id: 'click-1', tag: 't:live', data: 'ok' }])
  expect(live.focusCalls()).toBe(1)

  // Cold open with broken storage still opens the window and best-effort posts without throwing
  const opened = fakeClient('w-opened')
  await relay.onNotificationClick(
    { notification: fakeNotification({ tag: 't:cold', data: 'fallback' }) },
    {
      registration: { scope: 'https://mind.page/' },
      clients: {
        async matchAll() { return [] },
        async openWindow() { return opened },
      },
    }
  )
  expect(opened.posted).toEqual([{ type: NOTIFICATION_CLICK_TYPE, id: 'click-2', tag: 't:cold', data: 'fallback' }])
})

test('refused openWindow: concurrent ready window takes both overlapping clicks; no window LEAVES stored click unassigned for a later ready window', async () => {
  const store = memoryStore()
  let relay!: ReturnType<typeof createNotificationClickRelay>
  const late = fakeClient('win-late', {
    onPost: msg => {
      const m = msg as NotificationClickMessage
      queueMicrotask(() => void relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: late }, swConcurrent))
    },
  })
  const openEntered = deferred<void>()
  const openReject = deferred<WindowClientLike | null>()
  let calls = 0
  const swConcurrent: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() {
        return calls++ === 0 ? [] : [late]
      },
      openWindow() {
        openEntered.resolve()
        return openReject.promise
      },
    },
  }
  relay = createNotificationClickRelay(store, { now: () => 40_000, makeId: seqIds(), ackTimeoutMs: 25 })
  const p1 = relay.onNotificationClick({ notification: fakeNotification({ tag: 't:1', data: 1 }) }, swConcurrent)
  await openEntered.promise
  const p2 = relay.onNotificationClick({ notification: fakeNotification({ tag: 't:2', data: 2 }) }, swConcurrent)
  openReject.reject(new Error('InvalidAccessError: Not allowed to open a window.'))
  await Promise.all([p1, p2])

  expect(late.posted).toHaveLength(2)
  const [m1, m2] = late.posted as NotificationClickMessage[]
  expect(m1).toMatchObject({ type: NOTIFICATION_CLICK_TYPE, tag: 't:1', data: 1 })
  expect(m2).toMatchObject({ type: NOTIFICATION_CLICK_TYPE, tag: 't:2', data: 2 })
  expect(m1.id).not.toBe(m2.id)
  expect(store.rows).toEqual([])

  // Refused openWindow with NO window at all LEAVES the stored click unassigned so a later ready
  // window within the 5-minute TTL takes it
  const swNone: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() { return [] },
      async openWindow() { throw new Error('InvalidAccessError') },
    },
  }
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 't:refused', data: 8 }) }, swNone)
  expect(store.rows).toHaveLength(1)
  expect(store.rows[0].clientId).toBeNull()
  expect(store.rows[0].message).toMatchObject({ type: NOTIFICATION_CLICK_TYPE, tag: 't:refused', data: 8 })

  const laterApp = fakeClient('win-later-app')
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: laterApp }, swNone)
  expect(laterApp.posted).toEqual([store.rows[0].message])
  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: store.rows[0].id }, source: laterApp }, swNone)
  expect(store.rows).toEqual([])
})

test('openWindow resolving null: overlapping click shares the in-flight open, while a later gesture checks windows again and opens if none exist', async () => {
  const store = memoryStore()
  const openEntered = deferred<void>()
  const openGate = deferred<WindowClientLike | null>()
  const openedLater = fakeClient('win-second-gesture')
  let openCalls = 0
  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() { return [] },
      openWindow() {
        openCalls++
        if (openCalls === 1) {
          openEntered.resolve()
          return openGate.promise
        }
        return Promise.resolve(openedLater)
      },
    },
  }
  const relay = createNotificationClickRelay(store, { now: () => 50_000, makeId: seqIds() })

  // Click 1 and Click 2 overlap one openWindow that resolves null -> only 1 open call, both stored unassigned
  const p1 = relay.onNotificationClick({ notification: fakeNotification({ tag: 't:n1', data: 1 }) }, sw)
  await openEntered.promise
  const p2 = relay.onNotificationClick({ notification: fakeNotification({ tag: 't:n2', data: 2 }) }, sw)
  openGate.resolve(null)
  await Promise.all([p1, p2])
  expect(openCalls).toBe(1)
  expect(store.rows.map(r => r.clientId)).toEqual([null, null])

  // Click 3 arrives as a LATER gesture (no persisted opening mark!) with still no windows ->
  // enumerates windows again, calls openWindow a second time, and addresses all 3 unassigned clicks to it
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 't:n3', data: 3 }) }, sw)
  expect(openCalls).toBe(2)
  expect(store.rows.map(r => r.clientId)).toEqual(['win-second-gesture', 'win-second-gesture', 'win-second-gesture'])

  await relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: openedLater }, sw)
  expect(openedLater.posted.map(m => (m as NotificationClickMessage).tag)).toEqual(['t:n1', 't:n2', 't:n3'])
})

test('totalAckBudgetMs bounds probing across many unresponsive windows, focuses first, and leaves click unassigned', async () => {
  const store = memoryStore()
  const wins = [fakeClient('w1'), fakeClient('w2'), fakeClient('w3'), fakeClient('w4'), fakeClient('w5')]
  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() { return wins },
      async openWindow() { return null },
    },
  }
  let clock = 1000
  const relay = createNotificationClickRelay(store, {
    now: () => clock,
    makeId: seqIds(),
    ackTimeoutMs: 25,
    totalAckBudgetMs: 40,
  })
  // Advance simulated clock whenever a client is probed so budget cuts off before all 5 are tried
  for (const w of wins) {
    const orig = w.postMessage.bind(w)
    w.postMessage = msg => {
      orig(msg)
      clock += 25
    }
  }
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 't:many', data: 1 }) }, sw)
  const probedCount = wins.filter(w => w.posted.length > 0).length
  expect(probedCount).toBe(2)
  expect(wins[0].focusCalls()).toBe(1)
  expect(store.rows[0].clientId).toBeNull()
})

test('createIdbPendingStore uses one pending object store (v1), assigns unassigned rows, enforces eligibility and TTL, and clears', async () => {
  type FakeStore = { keyPath: string; autoIncrement: boolean; nextSeq: number; rows: Map<string | number, Record<string, unknown>> }
  const stores = new Map<string, FakeStore>()
  let dbVersion = 0
  const fakeIdb = {
    open(_name: string, version: number) {
      const req: Record<string, unknown> = {}
      const db = {
        objectStoreNames: { contains: (n: string) => stores.has(n) },
        createObjectStore: (n: string, opts: { keyPath: string; autoIncrement?: boolean }) => {
          stores.set(n, { keyPath: opts.keyPath, autoIncrement: !!opts.autoIncrement, nextSeq: 1, rows: new Map() })
        },
        transaction() {
          const tx: Record<string, unknown> = {}
          const pendingOps: (() => void)[] = []
          const scheduleComplete = () => {
            queueMicrotask(() => {
              while (pendingOps.length) pendingOps.shift()!()
              ;(tx.oncomplete as (() => void) | undefined)?.()
            })
          }
          let scheduled = false
          const ensureScheduled = () => {
            if (!scheduled) {
              scheduled = true
              scheduleComplete()
            }
          }
          tx.objectStore = (name: string) => {
            const st = stores.get(name)!
            return {
              getAll() {
                const r: Record<string, unknown> = {}
                ensureScheduled()
                pendingOps.push(() => {
                  r.result = [...st.rows.values()].map(v => ({ ...v }))
                  ;(r.onsuccess as (() => void) | undefined)?.()
                })
                return r
              },
              add(val: Record<string, unknown>) {
                ensureScheduled()
                const rec = { ...val }
                if (st.autoIncrement && rec[st.keyPath] == null) rec[st.keyPath] = st.nextSeq++
                st.rows.set(rec[st.keyPath] as string | number, rec)
              },
              put(val: Record<string, unknown>) {
                ensureScheduled()
                const rec = { ...val }
                st.rows.set(rec[st.keyPath] as string | number, rec)
              },
              delete(key: string | number) {
                ensureScheduled()
                st.rows.delete(key)
              },
              clear() {
                ensureScheduled()
                st.rows.clear()
              },
            }
          }
          return tx
        },
        close() {},
      }
      queueMicrotask(() => {
        req.result = db
        if (dbVersion < version) {
          dbVersion = version
          ;(req.onupgradeneeded as (() => void) | undefined)?.()
        }
        ;(req.onsuccess as (() => void) | undefined)?.()
      })
      return req
    },
  } as unknown as IDBFactory

  expect(PENDING_DB_VERSION).toBe(1)
  const store = createIdbPendingStore(fakeIdb)
  const m1: NotificationClickMessage = { type: NOTIFICATION_CLICK_TYPE, id: 'c1', tag: 't:1', data: 1 }
  const m2: NotificationClickMessage = { type: NOTIFICATION_CLICK_TYPE, id: 'c2', tag: 't:2', data: 2 }

  await store.put({ id: 'c1', clientId: null, message: m1, at: 1000 }, 1000)
  expect([...stores.keys()]).toEqual([PENDING_STORE_NAME])
  expect(stores.get(PENDING_STORE_NAME)!.rows.size).toBe(1)

  await store.put({ id: 'c2', clientId: null, message: m2, at: 1500 }, 1500)
  await store.assignUnassigned('win-a', 2000)

  // liveClientIds === null never steals another client's click
  expect(await store.listEligible('win-b', null, 2500)).toEqual([])
  // live bystander cannot steal while win-a is live
  expect(await store.listEligible('win-b', new Set(['win-a', 'win-b']), 2500)).toEqual([])
  // win-a gone -> win-b takes both in oldest-first order
  expect(await store.listEligible('win-b', new Set(['win-b']), 2500)).toEqual([m1, m2])

  await store.remove('c1', 3000)
  expect(await store.listEligible('win-a', new Set(['win-a']), 3000)).toEqual([m2])

  // exact TTL expiry drops c2
  expect(await store.listEligible('win-a', new Set(['win-a']), 1500 + PENDING_TTL_MS)).toEqual([])

  await store.put({ id: 'c3', clientId: null, message: m1, at: 5000 }, 5000)
  await store.clear()
  expect(await store.listEligible('win-a', new Set(['win-a']), 5000)).toEqual([])
})

test('a clear whose lookup returns in time posts nothing once another tab has confirmed the next account: its card and its stored click stay', async () => {
  const storage = memoryStorage({ [NOTIFICATION_RELAY_ACCOUNT_KEY]: 'uid-a' })
  const store = memoryStore()
  const relay = createNotificationClickRelay(store, { now: () => 40_000, makeId: seqIds(), ackTimeoutMs: 10, totalAckBudgetMs: 50 })
  const notifications: Array<ReturnType<typeof fakeNotification>> = []
  const swScope: ServiceWorkerScopeLike = {
    registration: {
      scope: 'https://mind.page/',
      async getNotifications() {
        return notifications.filter(n => !n.closed())
      },
    },
    clients: {
      async matchAll() {
        return [fakeClient('tab-b', { focused: true })]
      },
      async openWindow() {
        return null
      },
    },
  }
  const postedToWorker: unknown[] = []
  const worker: RelayWorkerLike = {
    state: 'activated',
    postMessage(msg) {
      postedToWorker.push(msg)
      void relay.onMessage({ data: msg, source: null }, swScope)
    },
  }
  // A's tab has no controller: its clear waits for the registration's lookup, which is held here,
  // and the wait never ends in this row (the lookup is the one that returns)
  const lookup = deferred<RelayRegistrationLike | undefined>()
  const container: ClearRelayContainerLike = { controller: null, getRegistration: () => lookup.promise }
  const results: unknown[] = []
  let reloads = 0
  const reloader = createExternalAuthReloader({
    storage,
    win: {},
    documentUid: 'uid-a',
    invalidateKeys: () => {},
    clearRelay: wanted => clearNotificationRelay(container, new Promise(() => {}), wanted).then(result => void results.push(result)),
    reload: () => {
      reloads++
    },
  })

  // A is signed out in another tab: this tab takes A out of the shared record and asks for the clear
  const left = reloader(null)
  expect(storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY)).toBeNull()

  // meanwhile another tab confirms B, and B gets a card and a stored click
  expect(reconcileNotificationRelayAccount(storage, 'uid-b')).toBe(false)
  const cardB = fakeNotification({ tag: 'todoer:b1', data: { source: 'todoer', item: 'b1' } })
  notifications.push(cardB)
  await relay.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:b2', data: { source: 'todoer', item: 'b2' } }) }, swScope)
  expect(store.rows.map(r => r.message.tag)).toEqual(['todoer:b2'])

  // the lookup returns BEFORE the wait's end: the deferred post is no longer due
  lookup.resolve({ active: worker })
  await left
  expect(results).toEqual(['superseded'])
  expect(postedToWorker).toEqual([])
  expect(cardB.closed()).toBe(false)
  expect(store.rows.map(r => r.message.tag)).toEqual(['todoer:b2'])
  expect(reloads).toBe(1)

  // the control: a clear that is still due posts after the same kind of lookup
  const dueLookup = deferred<RelayRegistrationLike | undefined>()
  const due = clearNotificationRelay({ controller: null, getRegistration: () => dueLookup.promise }, new Promise(() => {}), () =>
    notificationRelayAccountIs(storage, 'uid-b')
  )
  dueLookup.resolve({ active: worker })
  expect(await due).toBe('posted')
  expect(postedToWorker).toEqual([{ type: NOTIFICATION_CLICK_CLEAR }])
})

test('external auth reloader: a clear queued behind an earlier one does not start once another tab has confirmed a further account', async () => {
  const storage = memoryStorage({ [NOTIFICATION_RELAY_ACCOUNT_KEY]: 'uid-a' })
  const first = deferred<void>()
  const started: string[] = []
  let reloads = 0
  const reloader = createExternalAuthReloader({
    storage,
    win: {},
    documentUid: 'uid-a',
    invalidateKeys: () => {},
    clearRelay: () => {
      started.push(storage.getItem(NOTIFICATION_RELAY_ACCOUNT_KEY) ?? 'none')
      return started.length == 1 ? first.promise : undefined
    },
    reload: () => {
      reloads++
    },
  })
  const one = reloader('uid-b') // A to B: this clear starts, and is held
  const two = reloader('uid-c') // B to C: this clear is queued behind it
  expect(started).toEqual(['uid-b'])
  // another tab confirms D while the first clear is outstanding (that tab asks for its own clear)
  expect(reconcileNotificationRelayAccount(storage, 'uid-d')).toBe(true)
  first.resolve()
  await Promise.all([one, two])
  expect(started).toEqual(['uid-b'])
  expect(reloads).toBe(1)
})
