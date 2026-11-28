import { expect, test } from '@playwright/test'
import {
  NOTIFICATION_CLICK_CLEAR,
  NOTIFICATION_CLICK_HELLO,
  NOTIFICATION_CLICK_QUERY,
  NOTIFICATION_CLICK_READY,
  NOTIFICATION_CLICK_RECEIVED,
  NOTIFICATION_CLICK_RELAY,
  NOTIFICATION_CLICK_RELAY_VERSION,
  NOTIFICATION_CLICK_STATUS,
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
  type NotificationClickQueryMessage,
  type PendingClickRecord,
  type PendingClickStore,
  type RelayContainerLike,
  type RelayRegistrationLike,
  type RelayWindowLike,
  type RelayWorkerLike,
  type ServiceWorkerScopeLike,
  type WindowClientLike,
} from '../../src/notification_click.js'

// Controllable clock + timer queue shared by worker relay tests in place of real sleeps.
function makeFakeClock(start = 10_000) {
  let time = start
  let nextId = 1
  const timers = new Map<number, { id: number; at: number; fn: () => void }>()
  const setTimer = (fn: () => void, ms: number) => {
    const id = nextId++
    timers.set(id, { id, at: time + Math.max(0, ms), fn })
    return id
  }
  const clearTimer = (id: unknown) => {
    timers.delete(id as number)
  }
  const flushMicrotasks = async (n = 8) => {
    for (let i = 0; i < n; i++) await Promise.resolve()
  }
  const advance = async (ms: number) => {
    const target = time + ms
    await flushMicrotasks()
    while (true) {
      let due: { id: number; at: number; fn: () => void } | null = null
      for (const t of timers.values()) {
        if (t.at <= target && (!due || t.at < due.at || (t.at === due.at && t.id < due.id))) due = t
      }
      if (!due) break
      time = due.at
      timers.delete(due.id)
      due.fn()
      await flushMicrotasks()
    }
    time = target
    await flushMicrotasks()
  }
  const runUntilIdle = async (maxSteps = 50) => {
    await flushMicrotasks()
    for (let i = 0; i < maxSteps; i++) {
      let due: { id: number; at: number; fn: () => void } | null = null
      for (const t of timers.values()) {
        if (!due || t.at < due.at || (t.at === due.at && t.id < due.id)) due = t
      }
      if (!due) break
      time = due.at
      timers.delete(due.id)
      due.fn()
      await flushMicrotasks()
    }
  }
  return {
    now: () => time,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    advance,
    runUntilIdle,
    flushMicrotasks,
  }
}

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
    onPost: msg => {
      if ((msg as { type?: string }).type === NOTIFICATION_CLICK_TYPE) w1Got.resolve()
    },
  })
  const w2 = fakeClient('w2', {
    focused: false,
    onPost: msg => {
      const m = msg as NotificationClickMessage
      if (m.type !== NOTIFICATION_CLICK_TYPE) return
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
  const clock = makeFakeClock(1000)
  const relay = createNotificationClickRelay(store, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 25,
    totalAckBudgetMs: 40,
  })
  const done = relay.onNotificationClick({ notification: fakeNotification({ tag: 't:many', data: 1 }) }, sw)
  await clock.runUntilIdle()
  await done
  const clickPosts = wins.map(w => w.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE).length)
  expect(clickPosts).toEqual([1, 1, 0, 0, 0])
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

test('discovery: answers and choice — first showing+capable window receives the ordinary click alone and is focused', async () => {
  // Subcase A: w1 (focused) non-showing, w2 showing+capable, w3 silent -> early finish at t=0, only w2 gets ordinary click
  const storeA = memoryStore()
  const clockA = makeFakeClock(5000)
  let relayA!: ReturnType<typeof createNotificationClickRelay>
  const w1A = fakeClient('w1', {
    focused: true,
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage | NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayA.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: true }, source: w1A }, swA))
      }
    },
  })
  const w2A = fakeClient('w2', {
    focused: false,
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage | NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayA.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: true, canHandle: true }, source: w2A }, swA))
      } else if (m.type === NOTIFICATION_CLICK_TYPE) {
        queueMicrotask(() => void relayA.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: w2A }, swA))
      }
    },
  })
  const w3A = fakeClient('w3', { focused: false }) // silent
  let openCallsA = 0
  const swA: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [w1A, w2A, w3A] }, async openWindow() { openCallsA++; return null } },
  }
  relayA = createNotificationClickRelay(storeA, {
    now: clockA.now,
    setTimeout: clockA.setTimeout,
    clearTimeout: clockA.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const doneA = relayA.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:s1', data: { source: 'todoer', item: 's1' } }) }, swA)
  await clockA.runUntilIdle()
  await doneA

  expect(clockA.now()).toBe(5000) // early finish: zero wait for silent w3
  expect(w1A.posted).toEqual([{ type: NOTIFICATION_CLICK_QUERY, id: 'click-1', tag: 'todoer:s1', data: { source: 'todoer', item: 's1' } }])
  expect(w2A.posted).toEqual([
    { type: NOTIFICATION_CLICK_QUERY, id: 'click-1', tag: 'todoer:s1', data: { source: 'todoer', item: 's1' } },
    { type: NOTIFICATION_CLICK_TYPE, id: 'click-1', tag: 'todoer:s1', data: { source: 'todoer', item: 's1' } },
  ])
  expect(w3A.posted).toEqual([{ type: NOTIFICATION_CLICK_QUERY, id: 'click-1', tag: 'todoer:s1', data: { source: 'todoer', item: 's1' } }])
  expect(w1A.focusCalls()).toBe(0)
  expect(w2A.focusCalls()).toBe(1)
  expect(w3A.focusCalls()).toBe(0)
  expect(openCallsA).toBe(0)
  expect(storeA.rows).toEqual([])
  expect(storeA.removeCalls).toBe(1)

  // Subcase B: w1 reports showing:true, canHandle:false; both w2 and w3 report showing:true, canHandle:true -> w2 (first in order) wins
  const storeB = memoryStore()
  const clockB = makeFakeClock(6000)
  let relayB!: ReturnType<typeof createNotificationClickRelay>
  const w1B = fakeClient('w1', {
    focused: true,
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayB.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: true, canHandle: false }, source: w1B }, swB))
      }
    },
  })
  const w2B = fakeClient('w2', {
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage | NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayB.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: true, canHandle: true }, source: w2B }, swB))
      } else if (m.type === NOTIFICATION_CLICK_TYPE) {
        queueMicrotask(() => void relayB.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: w2B }, swB))
      }
    },
  })
  const w3B = fakeClient('w3', {
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayB.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: true, canHandle: true }, source: w3B }, swB))
      }
    },
  })
  const swB: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [w1B, w2B, w3B] }, async openWindow() { return null } },
  }
  relayB = createNotificationClickRelay(storeB, {
    now: clockB.now,
    setTimeout: clockB.setTimeout,
    clearTimeout: clockB.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const doneB = relayB.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:s2', data: { source: 'todoer', item: 's2' } }) }, swB)
  await clockB.runUntilIdle()
  await doneB

  expect(w1B.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toEqual([])
  expect(w2B.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toHaveLength(1)
  expect(w3B.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toEqual([])
  expect(w2B.focusCalls()).toBe(1)

  // Subcase C: single eligible window -> discovery is skipped completely
  const storeC = memoryStore()
  const clockC = makeFakeClock(7000)
  let relayC!: ReturnType<typeof createNotificationClickRelay>
  const solo = fakeClient('solo', {
    focused: true,
    onPost: msg => {
      const m = msg as NotificationClickMessage
      queueMicrotask(() => void relayC.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: solo }, swC))
    },
  })
  const swC: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [solo] }, async openWindow() { return null } },
  }
  relayC = createNotificationClickRelay(storeC, {
    now: clockC.now,
    setTimeout: clockC.setTimeout,
    clearTimeout: clockC.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const doneC = relayC.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:solo', data: { source: 'todoer', item: 'solo' } }) }, swC)
  await clockC.runUntilIdle()
  await doneC

  expect(solo.posted).toEqual([{ type: NOTIFICATION_CLICK_TYPE, id: 'click-1', tag: 'todoer:solo', data: { source: 'todoer', item: 'solo' } }])
  expect(solo.focusCalls()).toBe(1)
})

test('discovery: keeps canHandle:false windows in fallback order; if chosen showing window stays silent on click, fallback continues over the others', async () => {
  // Subcase A: w1 reports canHandle:false and stays silent on click; w2 & w3 report showing:false, canHandle:true ->
  // w1 is NOT removed from the fallback line; after w1 times out, w2 receives the click and is focused
  const storeA = memoryStore()
  const clockA = makeFakeClock(1000)
  let relayA!: ReturnType<typeof createNotificationClickRelay>
  const w1A = fakeClient('w1', {
    focused: true,
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayA.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: false }, source: w1A }, swA))
      }
    },
  })
  const w2A = fakeClient('w2', {
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage | NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayA.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: true }, source: w2A }, swA))
      } else if (m.type === NOTIFICATION_CLICK_TYPE) {
        queueMicrotask(() => void relayA.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: w2A }, swA))
      }
    },
  })
  const w3A = fakeClient('w3', {
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayA.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: true }, source: w3A }, swA))
      }
    },
  })
  const swA: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [w1A, w2A, w3A] }, async openWindow() { return null } },
  }
  relayA = createNotificationClickRelay(storeA, {
    now: clockA.now,
    setTimeout: clockA.setTimeout,
    clearTimeout: clockA.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const doneA = relayA.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:keep-order', data: 1 }) }, swA)
  await clockA.runUntilIdle()
  await doneA

  expect(clockA.now()).toBe(1250) // w1 still probed for ackTimeoutMs before fallback moves to w2
  expect(w1A.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toHaveLength(1)
  expect(w2A.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toHaveLength(1)
  expect(w3A.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toEqual([])
  expect(w2A.focusCalls()).toBe(1)
  expect(storeA.rows).toEqual([])

  // Subcase B: all windows report canHandle:false and stay silent -> both are still probed in released order, focuses first, leaves click unassigned
  const storeB = memoryStore()
  const clockB = makeFakeClock(2000)
  let relayB!: ReturnType<typeof createNotificationClickRelay>
  const w1B = fakeClient('w1', {
    focused: true,
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayB.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: false }, source: w1B }, swB))
      }
    },
  })
  const w2B = fakeClient('w2', {
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayB.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: false }, source: w2B }, swB))
      }
    },
  })
  const swB: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [w1B, w2B] }, async openWindow() { return null } },
  }
  relayB = createNotificationClickRelay(storeB, {
    now: clockB.now,
    setTimeout: clockB.setTimeout,
    clearTimeout: clockB.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const doneB = relayB.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:none', data: 2 }) }, swB)
  await clockB.runUntilIdle()
  await doneB

  expect(clockB.now()).toBe(2500) // discovery finished at t=0; serial fallback probed w1 (250) + w2 (250)
  expect(w1B.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toHaveLength(1)
  expect(w2B.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toHaveLength(1)
  expect(w1B.focusCalls()).toBe(1)
  expect(storeB.rows).toHaveLength(1)
  expect(storeB.rows[0].clientId).toBeNull()

  // Subcase C: chosen showing w2 does not answer its ordinary click -> fallback continues to w1 and focuses w1
  const storeC = memoryStore()
  const clockC = makeFakeClock(3000)
  let relayC!: ReturnType<typeof createNotificationClickRelay>
  const clickLog: string[] = []
  const w1C = fakeClient('w1', {
    focused: true,
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage | NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayC.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: true }, source: w1C }, swC))
      } else if (m.type === NOTIFICATION_CLICK_TYPE) {
        clickLog.push('w1')
        queueMicrotask(() => void relayC.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: w1C }, swC))
      }
    },
  })
  const w2C = fakeClient('w2', {
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage | NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayC.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: true, canHandle: true }, source: w2C }, swC))
      } else if (m.type === NOTIFICATION_CLICK_TYPE) {
        clickLog.push('w2')
        // silent on ordinary click
      }
    },
  })
  const swC: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [w1C, w2C] }, async openWindow() { return null } },
  }
  relayC = createNotificationClickRelay(storeC, {
    now: clockC.now,
    setTimeout: clockC.setTimeout,
    clearTimeout: clockC.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const doneC = relayC.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:silent-chosen', data: 3 }) }, swC)
  await clockC.runUntilIdle()
  await doneC

  expect(clickLog).toEqual(['w2', 'w1'])
  expect(clockC.now()).toBe(3250)
  expect(w1C.focusCalls()).toBe(1)
  expect(w2C.focusCalls()).toBe(0)
  expect(storeC.rows).toEqual([])
})

test('discovery: no answer at all (every page old) runs the released probe; mixed old/new and invalid status handled cleanly', async () => {
  // Subcase A: every page is old (ignores query) -> after one discovery wait, released probe runs in order
  const storeA = memoryStore()
  const clockA = makeFakeClock(1000)
  let relayA!: ReturnType<typeof createNotificationClickRelay>
  const clickOrderA: string[] = []
  const old1 = fakeClient('old1', {
    focused: true,
    onPost: msg => {
      if ((msg as { type?: string }).type === NOTIFICATION_CLICK_TYPE) clickOrderA.push('old1')
      // ignores query AND silent on click -> moves to old2
    },
  })
  const old2 = fakeClient('old2', {
    onPost: msg => {
      const m = msg as NotificationClickMessage
      if (m.type !== NOTIFICATION_CLICK_TYPE) return
      clickOrderA.push('old2')
      queueMicrotask(() => void relayA.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: old2 }, swA))
    },
  })
  const swA: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [old1, old2] }, async openWindow() { return null } },
  }
  relayA = createNotificationClickRelay(storeA, {
    now: clockA.now,
    setTimeout: clockA.setTimeout,
    clearTimeout: clockA.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const doneA = relayA.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:old', data: { source: 'todoer', item: 's1' } }) }, swA)
  await clockA.runUntilIdle()
  await doneA

  expect(clickOrderA).toEqual(['old1', 'old2'])
  expect(clockA.now()).toBe(1500) // 250 ms parallel discovery + 250 ms old1 probe
  expect(old2.focusCalls()).toBe(1)
  expect(old1.focusCalls()).toBe(0)
  expect(storeA.rows).toEqual([])

  // Subcase B: focused old page + background new showing page -> showing new page wins and old page gets zero clicks
  const storeB = memoryStore()
  const clockB = makeFakeClock(2000)
  let relayB!: ReturnType<typeof createNotificationClickRelay>
  const oldFocusedB = fakeClient('old-w1', {
    focused: true,
    onPost: msg => {
      const m = msg as NotificationClickMessage
      if (m.type !== NOTIFICATION_CLICK_TYPE) return
      queueMicrotask(() => void relayB.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: oldFocusedB }, swB))
    },
  })
  const newShowingB = fakeClient('new-w2', {
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage | NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayB.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: true, canHandle: true }, source: newShowingB }, swB))
      } else if (m.type === NOTIFICATION_CLICK_TYPE) {
        queueMicrotask(() => void relayB.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: newShowingB }, swB))
      }
    },
  })
  const swB: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [oldFocusedB, newShowingB] }, async openWindow() { return null } },
  }
  relayB = createNotificationClickRelay(storeB, {
    now: clockB.now,
    setTimeout: clockB.setTimeout,
    clearTimeout: clockB.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const doneB = relayB.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:mixed1', data: 1 }) }, swB)
  await clockB.runUntilIdle()
  await doneB

  expect(oldFocusedB.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toEqual([])
  expect(newShowingB.focusCalls()).toBe(1)
  expect(oldFocusedB.focusCalls()).toBe(0)

  // Subcase C: focused new non-showing page + background old page -> fallback picks focused new page (same winner as released)
  const storeC = memoryStore()
  const clockC = makeFakeClock(3000)
  let relayC!: ReturnType<typeof createNotificationClickRelay>
  const newFocusedC = fakeClient('new-w1', {
    focused: true,
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage | NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relayC.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: true }, source: newFocusedC }, swC))
      } else if (m.type === NOTIFICATION_CLICK_TYPE) {
        queueMicrotask(() => void relayC.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: newFocusedC }, swC))
      }
    },
  })
  const oldPeerC = fakeClient('old-w2', {
    onPost: msg => {
      const m = msg as NotificationClickMessage
      if (m.type !== NOTIFICATION_CLICK_TYPE) return
      queueMicrotask(() => void relayC.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: oldPeerC }, swC))
    },
  })
  const swC: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [newFocusedC, oldPeerC] }, async openWindow() { return null } },
  }
  relayC = createNotificationClickRelay(storeC, {
    now: clockC.now,
    setTimeout: clockC.setTimeout,
    clearTimeout: clockC.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const doneC = relayC.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:mixed2', data: 2 }) }, swC)
  await clockC.runUntilIdle()
  await doneC

  expect(newFocusedC.focusCalls()).toBe(1)
  expect(oldPeerC.focusCalls()).toBe(0)
  expect(oldPeerC.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toEqual([])

  // Subcase D: unknown-client, duplicate, and late status replies are safely ignored
  const storeD = memoryStore()
  const clockD = makeFakeClock(4000)
  let relayD!: ReturnType<typeof createNotificationClickRelay>
  const stranger = fakeClient('stranger')
  const w1D = fakeClient('w1', { focused: true })
  const w2D = fakeClient('w2', {
    onPost: msg => {
      const m = msg as NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_TYPE) {
        queueMicrotask(() => void relayD.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: w2D }, swD))
      }
    },
  })
  const swD: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [w1D, w2D] }, async openWindow() { return null } },
  }
  relayD = createNotificationClickRelay(storeD, {
    now: clockD.now,
    setTimeout: clockD.setTimeout,
    clearTimeout: clockD.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const doneD = relayD.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:status-guard', data: 3 }) }, swD)
  await clockD.flushMicrotasks()
  // Stranger claiming showing:true is ignored; duplicate status from w1 does not overwrite its first answer,
  // so w2 reporting showing:true wins ahead of w1 and w1 receives zero ordinary clicks
  await relayD.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: 'click-1', showing: true, canHandle: true }, source: stranger }, swD)
  await relayD.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: 'click-1', showing: false, canHandle: false }, source: w1D }, swD)
  await relayD.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: 'click-1', showing: true, canHandle: true }, source: w1D }, swD)
  await relayD.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: 'click-1', showing: true, canHandle: true }, source: w2D }, swD)
  await clockD.runUntilIdle()
  await doneD
  // Late status after completion is harmless
  await relayD.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: 'click-1', showing: true, canHandle: true }, source: w2D }, swD)
  expect(stranger.posted).toEqual([])
  expect(w1D.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE)).toEqual([])
  expect(w2D.focusCalls()).toBe(1)
  expect(storeD.rows).toEqual([])
})

// Controllable-clock + incoming-message harness for turn-rule order tests (prompt = 8 ms, 250 / 1500 ms timers).
type TurnWindowSpec = {
  id: string
  focused?: boolean
  showing?: boolean
  canHandle?: boolean
  canHandleItem?: (item: string) => boolean
  silentQuery?: boolean
  silentClick?: boolean
  queryDelayMs?: number
  clickDelayMs?: number
}

function makeTurnHarness(opts: { start?: number; ackTimeoutMs?: number; totalAckBudgetMs?: number } = {}) {
  const start = opts.start ?? 0
  const clock = makeFakeClock(start)
  const store = memoryStore()
  let relay!: ReturnType<typeof createNotificationClickRelay>
  let liveWindows: WindowClientLike[] = []
  let firstMatchAllGate: ReturnType<typeof deferred<WindowClientLike[]>> | null = null
  let matchAllCount = 0
  let openCalls = 0
  const focusLog: { id: string; at: number }[] = []

  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() {
        matchAllCount++
        if (matchAllCount === 1 && firstMatchAllGate) return firstMatchAllGate.promise
        return [...liveWindows]
      },
      async openWindow() {
        openCalls++
        return null
      },
    },
  }

  relay = createNotificationClickRelay(store, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: opts.ackTimeoutMs ?? 250,
    totalAckBudgetMs: opts.totalAckBudgetMs ?? 1500,
  })

  const makeWin = (spec: TurnWindowSpec) => {
    const state = {
      showing: spec.showing ?? false,
      canHandle: spec.canHandle ?? true,
      canHandleItem: spec.canHandleItem,
      silentQuery: spec.silentQuery ?? false,
      silentClick: spec.silentClick ?? false,
      queryDelayMs: spec.queryDelayMs ?? 8,
      clickDelayMs: spec.clickDelayMs ?? 8,
    }
    const itemOf = (m: NotificationClickQueryMessage | NotificationClickMessage) =>
      (m.data && typeof m.data === 'object' && 'item' in m.data ? String((m.data as { item?: unknown }).item) : m.tag)
    const receivedClicks: { id: string; item: string; at: number }[] = []
    const handledClicks: { id: string; item: string; at: number }[] = []
    const focusTimes: number[] = []
    const handledIds = new Set<string>()
    let holdIn = false
    const inQueue: (() => void)[] = []

    const enqueue = (fn: () => void, delayMs: number) => {
      if (holdIn) inQueue.push(fn)
      else if (delayMs === 0) queueMicrotask(fn)
      else clock.setTimeout(fn, delayMs)
    }

    const client: WindowClientLike = {
      id: spec.id,
      focused: spec.focused ?? false,
      frameType: 'top-level',
      async focus() {
        const at = clock.now() - start
        focusTimes.push(at)
        focusLog.push({ id: spec.id, at })
        return client
      },
      postMessage(msg: unknown) {
        const m = msg as NotificationClickQueryMessage | NotificationClickMessage
        const item = itemOf(m)
        const capable = state.canHandleItem ? state.canHandleItem(item) : state.canHandle
        if (m.type === NOTIFICATION_CLICK_QUERY) {
          if (state.silentQuery) return
          enqueue(() => {
            void relay.onMessage(
              { data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: state.showing, canHandle: capable }, source: client },
              sw
            )
          }, state.queryDelayMs)
          return
        }
        if (m.type === NOTIFICATION_CLICK_TYPE) {
          receivedClicks.push({ id: m.id, item, at: clock.now() - start })
          if (state.silentClick) return
          enqueue(() => {
            const canNow = state.canHandleItem ? state.canHandleItem(item) : state.canHandle
            if (!canNow) return
            if (!handledIds.has(m.id)) {
              handledIds.add(m.id)
              handledClicks.push({ id: m.id, item, at: clock.now() - start })
            }
            void relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: client }, sw)
          }, state.clickDelayMs)
        }
      },
    }

    return {
      client,
      state,
      receivedClicks,
      handledClicks,
      focusTimes,
      finalItem: () => (handledClicks.length > 0 ? handledClicks[handledClicks.length - 1].item : null),
      setHoldIn: (v: boolean) => { holdIn = v },
      deliverIn: () => { while (inQueue.length) inQueue.shift()!() },
      summary: () => ({
        received: receivedClicks.map(c => c.at),
        handled: handledClicks.map(c => c.at),
        focused: [...focusTimes],
      }),
    }
  }

  return {
    clock,
    store,
    relay,
    sw,
    focusLog,
    openCalls: () => openCalls,
    setLive: (wins: WindowClientLike[]) => { liveWindows = wins },
    holdFirstMatchAll: () => {
      firstMatchAllGate = deferred<WindowClientLike[]>()
      return firstMatchAllGate
    },
    makeWin,
    click: (tag = 'todoer:s1', data: unknown = { source: 'todoer', item: 's1' }) =>
      relay.onNotificationClick({ notification: fakeNotification({ tag, data }) }, sw),
    sendReady: (client: WindowClientLike) => relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: client }, sw),
    sendClear: (client: WindowClientLike) => relay.onMessage({ data: { type: NOTIFICATION_CLICK_CLEAR }, source: client }, sw),
  }
}

test('turn rule (order 1): ready offer in flight when windows are listed — C alone acts at 8 ms and is focused; B is never posted the click', async () => {
  // Subcase A (review 3 trace 1): A & B answer discovery immediately at t=1 (before C acks at t=8),
  // so the loop chooses B at t=1 and MUST wait behind C's active turn; C alone acts at 8 ms and B gets 0 clicks
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 0, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 0, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, showing: false, canHandle: true, clickDelayMs: 8 })
    const gate = h.holdFirstMatchAll()
    h.setLive([A.client, B.client, C.client])

    const clickP = h.click('todoer:o1a')
    await h.clock.flushMicrotasks()
    // C says ready while the first window list is still pending
    const readyC = h.sendReady(C.client)
    await h.clock.flushMicrotasks()
    // 1 ms later the first list returns [A, B]
    await h.clock.advance(1)
    gate.resolve([A.client, B.client])
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC])

    expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(B.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(C.summary()).toEqual({ received: [0], handled: [8], focused: [8] })
    expect(h.store.rows).toEqual([])
  }

  // Subcase B: A & B also take 8 ms for discovery (would answer at t=9); C's ack at t=8 ends discovery immediately
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, showing: false, canHandle: true, clickDelayMs: 8 })
    const gate = h.holdFirstMatchAll()
    h.setLive([A.client, B.client, C.client])

    const clickP = h.click('todoer:o1b')
    await h.clock.flushMicrotasks()
    const readyC = h.sendReady(C.client)
    await h.clock.flushMicrotasks()
    await h.clock.advance(1)
    gate.resolve([A.client, B.client])
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC])

    expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(B.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(C.summary()).toEqual({ received: [0], handled: [8], focused: [8] })
    expect(h.store.rows).toEqual([])
  }
})

test('turn rule (order 2): two windows load while first two are silent — C acts and is focused at 58 ms (ending discovery early); D gets nothing', async () => {
  // Subcase A (review 3 trace 2): A and B silent; C says ready at 50 ms, D at 500 ms (both prompt 8 ms)
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, silentQuery: true, silentClick: true })
    const B = h.makeWin({ id: 'B', focused: false, silentQuery: true, silentClick: true })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    const D = h.makeWin({ id: 'D', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickP = h.click('todoer:o2a')
    await h.clock.advance(50)
    h.setLive([A.client, B.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.advance(450) // t=500
    h.setLive([A.client, B.client, C.client, D.client])
    const readyD = h.sendReady(D.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC, readyD])

    expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(B.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(C.summary()).toEqual({ received: [50], handled: [58], focused: [58] })
    expect(D.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  }

  // Subcase B: C says ready at 50 ms, D says ready at 53 ms (3 ms later while C's turn is in flight) -> D waits and is dropped
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, silentQuery: true, silentClick: true })
    const B = h.makeWin({ id: 'B', focused: false, silentQuery: true, silentClick: true })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    const D = h.makeWin({ id: 'D', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickP = h.click('todoer:o2b')
    await h.clock.advance(50)
    h.setLive([A.client, B.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.advance(3)
    h.setLive([A.client, B.client, C.client, D.client])
    const readyD = h.sendReady(D.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC, readyD])

    expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(B.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(C.summary()).toEqual({ received: [50], handled: [58], focused: [58] })
    expect(D.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  }

  // Subcase C: clear arriving during discovery ends discovery immediately at 50 ms (not 250 ms)
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, silentQuery: true, silentClick: true })
    const B = h.makeWin({ id: 'B', focused: false, silentQuery: true, silentClick: true })
    h.setLive([A.client, B.client])

    let endedAt = -1
    const clickP = h.click('todoer:o2c').then(() => { endedAt = h.clock.now() })
    await h.clock.advance(50)
    await h.sendClear(A.client)
    await h.clock.flushMicrotasks()
    await clickP

    expect(endedAt).toBe(50)
    expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(B.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  }
})

test('turn rule (order 3): ready while a loop offer is in flight — B alone acts; C waits its turn and is dropped on ack', async () => {
  // Subcase A: third window C says ready 3 ms after B was posted the click
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, silentClick: true, queryDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickP = h.click('todoer:o3a')
    await h.clock.advance(11) // discovery ends at t=8, B posted at t=8; C says ready at t=11 (3 ms after B's post)
    expect(B.receivedClicks.map(c => c.at)).toEqual([8])
    h.setLive([A.client, B.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC])

    expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(B.summary()).toEqual({ received: [8], handled: [16], focused: [16] })
    expect(C.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  }

  // Subcase B: first window A itself says ready 3 ms after B was posted -> A waits behind B and is dropped on ack
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickP = h.click('todoer:o3b')
    await h.clock.advance(11)
    expect(B.receivedClicks.map(c => c.at)).toEqual([8])
    const readyA = h.sendReady(A.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyA])

    expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(B.summary()).toEqual({ received: [8], handled: [16], focused: [16] })
    expect(h.store.rows).toEqual([])
  }
})

test('turn rule (order 4): ready behind a silent offer — C acts when A interval ends (250 ms) and is focused; second ready D gets nothing', async () => {
  // Subcase A: A alone is listed and silent; C says ready at 50 ms (prompt 8 ms)
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, silentQuery: true, silentClick: true })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client])

    const clickP = h.click('todoer:o4a')
    await h.clock.advance(50)
    h.setLive([A.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.flushMicrotasks()
    expect(C.receivedClicks).toEqual([]) // still waiting behind A's interval
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC])

    expect(A.summary()).toEqual({ received: [0], handled: [], focused: [] })
    expect(C.summary()).toEqual({ received: [250], handled: [258], focused: [258] })
    expect(h.store.rows).toEqual([])
  }

  // Subcase B: same with D also saying ready at 60 ms -> C acts at 258 ms and is focused; D gets nothing
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, silentQuery: true, silentClick: true })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    const D = h.makeWin({ id: 'D', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client])

    const clickP = h.click('todoer:o4b')
    await h.clock.advance(50)
    h.setLive([A.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.advance(10) // t=60
    h.setLive([A.client, C.client, D.client])
    const readyD = h.sendReady(D.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC, readyD])

    expect(A.summary()).toEqual({ received: [0], handled: [], focused: [] })
    expect(C.summary()).toEqual({ received: [250], handled: [258], focused: [258] })
    expect(D.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  }

  // Subcase C: time spent waiting for a silent ready turn is NOT charged to the loop's 1500 ms budget
  {
    const h = makeTurnHarness()
    const silents = ['s1', 's2', 's3', 's4', 's5'].map((id, i) =>
      h.makeWin({ id, focused: i === 0, silentQuery: true, silentClick: true })
    )
    const F = h.makeWin({ id: 'F', focused: false, silentQuery: true, canHandle: true, clickDelayMs: 8 })
    const X = h.makeWin({ id: 'X', focused: false, silentQuery: true, silentClick: true })
    h.setLive([...silents.map(w => w.client), F.client])

    const clickP = h.click('todoer:o4c')
    await h.clock.advance(50) // during discovery, silent X takes a ready turn (t=50..300)
    h.setLive([...silents.map(w => w.client), F.client, X.client])
    const readyX = h.sendReady(X.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyX])

    expect(X.summary()).toEqual({ received: [50], handled: [], focused: [] })
    expect(silents.map(w => w.summary().received)).toEqual([[300], [550], [800], [1050], [1300]])
    expect(F.summary()).toEqual({ received: [1550], handled: [1558], focused: [1558] })
    expect(h.store.rows).toEqual([])
  }

  // Subcase D: clear while ready C waits behind silent A drops C without posting and clears the store
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, silentQuery: true, silentClick: true })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client])

    const clickP = h.click('todoer:o4d')
    await h.clock.advance(50)
    h.setLive([A.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.advance(10)
    await h.sendClear(A.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC])

    expect(A.summary()).toEqual({ received: [0], handled: [], focused: [] })
    expect(C.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  }

  // Subcase E: nobody answers and no ready arrives while handler runs -> unassigned row; later ready posts at once
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, silentQuery: true, silentClick: true })
    const B = h.makeWin({ id: 'B', focused: false, silentQuery: true, silentClick: true })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickP = h.click('todoer:o4e')
    await h.clock.runUntilIdle()
    await clickP
    expect(A.summary()).toEqual({ received: [250], handled: [], focused: [750] })
    expect(B.summary()).toEqual({ received: [500], handled: [], focused: [] })
    expect(h.store.rows).toHaveLength(1)
    expect(h.store.rows[0].clientId).toBeNull()

    h.setLive([A.client, B.client, C.client])
    await h.sendReady(C.client)
    await h.clock.runUntilIdle()
    expect(C.summary()).toEqual({ received: [750], handled: [758], focused: [] })
    expect(h.store.rows).toEqual([])
  }
})

test('turn rule (order 7): ready during discovery (from third window C and from first window A) yields one actor alone; late discovery reply adds no second actor', async () => {
  // Subcase A: during discovery (B pending), C sends ready -> C gets older unowned click AND click-1's turn;
  // B answers showing:true at t=1 (before C acks at t=8) -> B waits behind C and is dropped; C alone acts on click-1
  {
    const h = makeTurnHarness()
    const olderMsg: NotificationClickMessage = { type: NOTIFICATION_CLICK_TYPE, id: 'old-unowned', tag: 'todoer:old', data: 'old' }
    await h.store.put({ id: olderMsg.id, clientId: null, message: olderMsg, at: 0 }, 0)

    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: true, queryDelayMs: 0, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 0, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    B.setHoldIn(true)
    h.setLive([A.client, B.client])

    const clickP = h.click('todoer:o7a')
    await h.clock.flushMicrotasks()
    h.setLive([A.client, B.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.advance(1)
    B.setHoldIn(false)
    B.deliverIn()
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC])

    expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(B.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(C.receivedClicks.map(c => c.id)).toEqual(['old-unowned', 'click-1'])
    expect(C.handledClicks.map(c => c.id)).toEqual(['old-unowned', 'click-1'])
    expect(C.focusTimes).toEqual([8])
    expect(h.store.rows).toEqual([])
  }

  // Subcase B: first window A itself sends ready during discovery while B's query is pending;
  // B then answers showing:true at t=1 before A acks at t=8 -> B waits behind A and is dropped; A alone acts
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: true, queryDelayMs: 0, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 0, clickDelayMs: 8 })
    B.setHoldIn(true)
    h.setLive([A.client, B.client])

    const clickP = h.click('todoer:o7b')
    await h.clock.flushMicrotasks()
    const readyA = h.sendReady(A.client)
    await h.clock.advance(1)
    B.setHoldIn(false)
    B.deliverIn()
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyA])

    expect(A.summary()).toEqual({ received: [0], handled: [8], focused: [8] })
    expect(B.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  }

  // Subcase C: late discovery answer from showing B after discovery timed out -> A alone acts and is focused; B untouched
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
    B.setHoldIn(true)
    h.setLive([A.client, B.client])

    const clickP = h.click('todoer:o7c')
    await h.clock.runUntilIdle()
    await clickP
    B.setHoldIn(false)
    B.deliverIn()
    await h.clock.runUntilIdle()

    expect(A.summary()).toEqual({ received: [250], handled: [258], focused: [258] })
    expect(B.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  }
})

test('turn rule (order 8): focused A lacks item, B shows it, both prompt, no ready — B alone acts and is focused within a few milliseconds', async () => {
  const h = makeTurnHarness()
  const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
  const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
  h.setLive([A.client, B.client])

  const clickP = h.click('todoer:o8')
  await h.clock.runUntilIdle()
  await clickP

  expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
  expect(B.summary()).toEqual({ received: [8], handled: [16], focused: [16] })
  expect(h.store.rows).toEqual([])
})

test('budget: fourth capable client behind three silent windows is reached under working and failing stores (and sixth at the 1500 ms limit)', async () => {
  const brokenStore = (): PendingClickStore => ({
    async put() { throw new Error('IDB blocked') },
    async assignUnassigned() { throw new Error('IDB blocked') },
    async remove() { throw new Error('IDB blocked') },
    async listEligible() { throw new Error('IDB blocked') },
    async clear() { throw new Error('IDB blocked') },
  })

  const runSilentPrefix = async (opts: { silentCount: number; capableAnswersQuery: boolean; capableShowing: boolean; failStore: boolean }) => {
    const memStore = opts.failStore ? null : memoryStore()
    const store: PendingClickStore = memStore ?? brokenStore()
    const clock = makeFakeClock(10_000)
    let relay!: ReturnType<typeof createNotificationClickRelay>
    const silents = Array.from({ length: opts.silentCount }, (_, i) => fakeClient(`s${i + 1}`, { focused: i === 0 }))
    const capable = fakeClient('capable', {
      onPost: msg => {
        const m = msg as NotificationClickQueryMessage | NotificationClickMessage
        if (m.type === NOTIFICATION_CLICK_QUERY && opts.capableAnswersQuery) {
          queueMicrotask(
            () =>
              void relay.onMessage(
                { data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: opts.capableShowing, canHandle: true }, source: capable },
                sw
              )
          )
        } else if (m.type === NOTIFICATION_CLICK_TYPE) {
          queueMicrotask(() => void relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: capable }, sw))
        }
      },
    })
    const trailing = fakeClient('trailing')
    const sw: ServiceWorkerScopeLike = {
      registration: { scope: 'https://mind.page/' },
      clients: { async matchAll() { return [...silents, capable, trailing] }, async openWindow() { return null } },
    }
    relay = createNotificationClickRelay(store, {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      makeId: seqIds(),
      ackTimeoutMs: 250,
      totalAckBudgetMs: 1500,
    })
    const done = relay.onNotificationClick({ notification: fakeNotification({ tag: 't:budget', data: 1 }) }, sw)
    await clock.runUntilIdle()
    await done
    return {
      elapsed: clock.now() - 10_000,
      capableClicks: capable.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE).length,
      capableFocus: capable.focusCalls(),
      firstSilentFocus: silents[0].focusCalls(),
      trailingClicks: trailing.posted.filter(m => (m as { type?: string }).type === NOTIFICATION_CLICK_TYPE).length,
      storedRows: memStore ? memStore.rows.length : 0,
    }
  }

  // 3 silent windows ahead of capable 4th client (non-showing new page): working store AND failing store
  expect(await runSilentPrefix({ silentCount: 3, capableAnswersQuery: true, capableShowing: false, failStore: false })).toEqual({
    elapsed: 1000, // 250 ms discovery + 3 * 250 ms silent fallback
    capableClicks: 1,
    capableFocus: 1,
    firstSilentFocus: 0,
    trailingClicks: 0,
    storedRows: 0,
  })
  expect(await runSilentPrefix({ silentCount: 3, capableAnswersQuery: true, capableShowing: false, failStore: true })).toEqual({
    elapsed: 1000,
    capableClicks: 1,
    capableFocus: 1,
    firstSilentFocus: 0,
    trailingClicks: 0,
    storedRows: 0,
  })
  // 3 silent windows ahead of old 4th client (ignores query): working store AND failing store
  expect(await runSilentPrefix({ silentCount: 3, capableAnswersQuery: false, capableShowing: false, failStore: false })).toEqual({
    elapsed: 1000,
    capableClicks: 1,
    capableFocus: 1,
    firstSilentFocus: 0,
    trailingClicks: 0,
    storedRows: 0,
  })
  expect(await runSilentPrefix({ silentCount: 3, capableAnswersQuery: false, capableShowing: false, failStore: true })).toEqual({
    elapsed: 1000,
    capableClicks: 1,
    capableFocus: 1,
    firstSilentFocus: 0,
    trailingClicks: 0,
    storedRows: 0,
  })
  // 3 silent windows ahead of showing 4th client: chosen right after the single 250 ms parallel discovery wait
  expect(await runSilentPrefix({ silentCount: 3, capableAnswersQuery: true, capableShowing: true, failStore: false })).toEqual({
    elapsed: 250,
    capableClicks: 1,
    capableFocus: 1,
    firstSilentFocus: 0,
    trailingClicks: 0,
    storedRows: 0,
  })
  // 5 silent windows ahead of capable 6th client (the exact 1500 ms reach of the released worker): both store outcomes
  expect(await runSilentPrefix({ silentCount: 5, capableAnswersQuery: false, capableShowing: false, failStore: false })).toEqual({
    elapsed: 1500, // 250 ms discovery + 5 * 250 ms silent fallback; 6th still has 250 ms left
    capableClicks: 1,
    capableFocus: 1,
    firstSilentFocus: 0,
    trailingClicks: 0,
    storedRows: 0,
  })
  expect(await runSilentPrefix({ silentCount: 5, capableAnswersQuery: false, capableShowing: false, failStore: true })).toEqual({
    elapsed: 1500,
    capableClicks: 1,
    capableFocus: 1,
    firstSilentFocus: 0,
    trailingClicks: 0,
    storedRows: 0,
  })
})

test('discovery: failed initial store write still delivers to showing discovery winner and to fallback window', async () => {
  const brokenStore: PendingClickStore = {
    async put() { throw new Error('IDB blocked') },
    async assignUnassigned() { throw new Error('IDB blocked') },
    async remove() { throw new Error('IDB blocked') },
    async listEligible() { throw new Error('IDB blocked') },
    async clear() { throw new Error('IDB blocked') },
  }

  // Showing w2 wins despite failed put()
  const clock1 = makeFakeClock(60_000)
  let relay1!: ReturnType<typeof createNotificationClickRelay>
  const w1a = fakeClient('w1', {
    focused: true,
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relay1.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: true }, source: w1a }, sw1))
      }
    },
  })
  const w2a = fakeClient('w2', {
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage | NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relay1.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: true, canHandle: true }, source: w2a }, sw1))
      } else if (m.type === NOTIFICATION_CLICK_TYPE) {
        queueMicrotask(() => void relay1.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: w2a }, sw1))
      }
    },
  })
  const sw1: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [w1a, w2a] }, async openWindow() { return null } },
  }
  relay1 = createNotificationClickRelay(brokenStore, {
    now: clock1.now,
    setTimeout: clock1.setTimeout,
    clearTimeout: clock1.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const done1 = relay1.onNotificationClick({ notification: fakeNotification({ tag: 't:fail1', data: 'p1' }) }, sw1)
  await clock1.runUntilIdle()
  await done1
  expect(w2a.focusCalls()).toBe(1)
  expect(w1a.focusCalls()).toBe(0)

  // Both non-showing -> fallback delivers in-memory to focused w1 despite failed put()
  const clock2 = makeFakeClock(60_000)
  let relay2!: ReturnType<typeof createNotificationClickRelay>
  const w1b = fakeClient('w1', {
    focused: true,
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage | NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relay2.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: true }, source: w1b }, sw2))
      } else if (m.type === NOTIFICATION_CLICK_TYPE) {
        queueMicrotask(() => void relay2.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: w1b }, sw2))
      }
    },
  })
  const w2b = fakeClient('w2', {
    onPost: msg => {
      const m = msg as NotificationClickQueryMessage
      if (m.type === NOTIFICATION_CLICK_QUERY) {
        queueMicrotask(() => void relay2.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: true }, source: w2b }, sw2))
      }
    },
  })
  const sw2: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: { async matchAll() { return [w1b, w2b] }, async openWindow() { return null } },
  }
  relay2 = createNotificationClickRelay(brokenStore, {
    now: clock2.now,
    setTimeout: clock2.setTimeout,
    clearTimeout: clock2.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })
  const done2 = relay2.onNotificationClick({ notification: fakeNotification({ tag: 't:fail2', data: 'p2' }) }, sw2)
  await clock2.runUntilIdle()
  await done2
  expect(w1b.focusCalls()).toBe(1)
  expect(w2b.focusCalls()).toBe(0)
})

test('regression (finding 1): window answering canHandle:false at discovery stays in fallback line and delivers once it can act (working and failing stores)', async () => {
  const brokenStore = (): PendingClickStore => ({
    async put() { throw new Error('IDB blocked') },
    async assignUnassigned() { throw new Error('IDB blocked') },
    async remove() { throw new Error('IDB blocked') },
    async listEligible() { throw new Error('IDB blocked') },
    async clear() { throw new Error('IDB blocked') },
  })

  const runCase = async (failStore: boolean) => {
    const memStore = failStore ? null : memoryStore()
    const store: PendingClickStore = memStore ?? brokenStore()
    const clock = makeFakeClock(10_000)
    let relay!: ReturnType<typeof createNotificationClickRelay>
    let bHasItem = false
    const clickOrder: string[] = []
    const acted: string[] = []

    const wA = fakeClient('A', {
      focused: true,
      onPost: msg => {
        const m = msg as NotificationClickQueryMessage | NotificationClickMessage
        if (m.type === NOTIFICATION_CLICK_TYPE) {
          clickOrder.push('A')
          // Item arrives in B by sync while worker waits for reloading A
          bHasItem = true
        }
      },
    })
    const wB = fakeClient('B', {
      focused: false,
      onPost: msg => {
        const m = msg as NotificationClickQueryMessage | NotificationClickMessage
        if (m.type === NOTIFICATION_CLICK_QUERY) {
          queueMicrotask(() =>
            void relay.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: bHasItem }, source: wB }, sw)
          )
        } else if (m.type === NOTIFICATION_CLICK_TYPE) {
          clickOrder.push('B')
          if (!bHasItem) return
          acted.push('B')
          queueMicrotask(() => void relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: wB }, sw))
        }
      },
    })
    const sw: ServiceWorkerScopeLike = {
      registration: { scope: 'https://mind.page/' },
      clients: { async matchAll() { return [wA, wB] }, async openWindow() { return null } },
    }
    relay = createNotificationClickRelay(store, {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      makeId: seqIds(),
      ackTimeoutMs: 250,
      totalAckBudgetMs: 1500,
    })
    const done = relay.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:sync', data: { source: 'todoer', item: 's1' } }) }, sw)
    await clock.runUntilIdle()
    await done
    return {
      clickOrder,
      acted,
      focusA: wA.focusCalls(),
      focusB: wB.focusCalls(),
      storedRows: memStore ? memStore.rows.length : 0,
    }
  }

  // Healthy storage: B is tried behind A, acts, is focused, and stored row is deleted
  expect(await runCase(false)).toEqual({
    clickOrder: ['A', 'B'],
    acted: ['B'],
    focusA: 0,
    focusB: 1,
    storedRows: 0,
  })
  // Failing storage: B still receives the in-memory fallback click, acts, and is focused (click not lost)
  expect(await runCase(true)).toEqual({
    clickOrder: ['A', 'B'],
    acted: ['B'],
    focusA: 0,
    focusB: 1,
    storedRows: 0,
  })
})

test('turn rule (order 5): same window twice (cache-then-server ready) — posts at once without waiting behind itself (one window and two windows)', async () => {
  // Subcase A: single window A starts from cache without item, receives loop offer (t=0) and ready #1 offer (t=50),
  // then server confirms item and A sends ready #2 at t=60 -> posted AT ONCE at t=60 (restarting interval), acts & focused at 68 ms
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, canHandle: false, clickDelayMs: 8 })
    h.setLive([A.client])

    const clickP = h.click('todoer:cache1')
    await h.clock.advance(50)
    expect(A.receivedClicks.map(c => c.at)).toEqual([0])
    const ready1 = h.sendReady(A.client)
    await h.clock.flushMicrotasks()
    // Assert the first ready post actually reached A BEFORE enabling the item and sending ready #2
    expect(A.receivedClicks.map(c => c.at)).toEqual([0, 50])
    expect(A.handledClicks).toEqual([])

    await h.clock.advance(10) // t=60
    A.state.canHandle = true
    const ready2 = h.sendReady(A.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickP, ready1, ready2])

    expect(A.summary()).toEqual({ received: [0, 50, 60], handled: [68], focused: [68] })
    expect(h.store.rows).toEqual([])
  }

  // Subcase B: two windows [A, B] (B silent) — A sends cache ready #1 at t=50 during discovery (taking active turn),
  // first post reaches A at t=50; at t=60 item arrives and A sends ready #2 -> posted AT ONCE at t=60, acts & focused at 68 ms
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, silentQuery: true, silentClick: true })
    h.setLive([A.client, B.client])

    const clickP = h.click('todoer:cache2')
    await h.clock.advance(50)
    const ready1 = h.sendReady(A.client)
    await h.clock.flushMicrotasks()
    // Assert the first ready post actually reached A BEFORE enabling the item and sending ready #2
    expect(A.receivedClicks.map(c => c.at)).toEqual([50])
    expect(A.handledClicks).toEqual([])

    await h.clock.advance(10) // t=60
    A.state.canHandle = true
    const ready2 = h.sendReady(A.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickP, ready1, ready2])

    expect(A.summary()).toEqual({ received: [50, 60], handled: [68], focused: [68] })
    expect(B.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  }
})

test('turn rule (same window again, another window waiting): a second ready does not jump ahead of the showing window that waits behind the first', async () => {
  // the opposing case (found by the watching session's sweep after review 5; kept by review 6): a DIFFERENT
  // window that is known to show the item waits, so the retry is held back. Focused A already shows the item; C has just
  // loaded and says ready from its cache, without the item, while the first window list is pending: the
  // click is posted to C and C's turn is in flight. The list returns, A answers that it shows the item, and
  // A's offer waits behind C's turn. C then gets the item and says ready again. Posted at once (as with
  // nobody waiting), C took the click at 18 ms and A, which shows the item, never got it; the released
  // worker gives it to A. With an offer waiting, the second ready takes its turn behind it.
  const h = makeTurnHarness()
  const A = h.makeWin({ id: 'A', focused: true, showing: true, canHandle: true, queryDelayMs: 0, clickDelayMs: 8 })
  const C = h.makeWin({ id: 'C', focused: false, showing: false, canHandle: false, queryDelayMs: 0, clickDelayMs: 8 })
  const gate = h.holdFirstMatchAll()
  h.setLive([A.client, C.client])

  const clickP = h.click('todoer:again')
  await h.clock.flushMicrotasks()
  const ready1 = h.sendReady(C.client)
  await h.clock.flushMicrotasks()
  expect(C.receivedClicks.map(c => c.at), 'premise: the first ready post reached C, whose turn is in flight').toEqual([0])
  await h.clock.advance(1)
  gate.resolve([A.client, C.client])
  await h.clock.advance(9) // t=10: A has answered that it shows the item, and its offer waits behind C's turn
  expect(A.receivedClicks, 'premise: A is not posted the click while C holds the turn').toEqual([])
  C.state.canHandle = true
  const ready2 = h.sendReady(C.client)
  await h.clock.runUntilIdle()
  await Promise.all([clickP, ready1, ready2])

  expect(C.summary(), 'C is posted the click once, cannot take it then, and is not posted it again').toEqual({ received: [0], handled: [], focused: [] })
  expect(A.summary(), 'A, which shows the item, takes the click when C interval ends').toEqual({ received: [250], handled: [258], focused: [258] })
  expect(h.store.rows).toEqual([])
})

test('turn rule (same window again, only itself waiting): the only window retries at once, also where the loop has queued it behind its own offer', async () => {
  // review 6, finding 1, first schedule: C is the only window. Its cache ready is posted first, before C has the
  // item; the list returns and the loop queues C again, behind C's own offer; C gets the item and says ready
  // again at 50 ms. Nobody else waits, so the retry is posted at once (held back, C acted at 258 ms, or never)
  const h = makeTurnHarness()
  const C = h.makeWin({ id: 'C', focused: true, showing: false, canHandle: false, queryDelayMs: 0, clickDelayMs: 8 })
  const gate = h.holdFirstMatchAll()
  h.setLive([C.client])

  const clickP = h.click('todoer:only')
  await h.clock.flushMicrotasks()
  const ready1 = h.sendReady(C.client)
  await h.clock.flushMicrotasks()
  expect(C.receivedClicks.map(c => c.at), 'premise: the cache ready post reached C first').toEqual([0])
  await h.clock.advance(1)
  gate.resolve([C.client])
  await h.clock.advance(49) // t=50
  C.state.canHandle = true
  const ready2 = h.sendReady(C.client)
  await h.clock.runUntilIdle()
  await Promise.all([clickP, ready1, ready2])

  expect(C.summary(), 'C retries at once and takes the click').toEqual({ received: [0, 50], handled: [58], focused: [58] })
  expect(h.store.rows).toEqual([])
})

test('turn rule (same window again, a fallback waiting): the window that now shows the item retries at once; the fallback that waited is never posted', async () => {
  // review 6, finding 1, second schedule: focused A (another view) and C both lack the item at discovery, so
  // A waits as an ordinary fallback behind C's cache offer. C gets the item, shows it and says ready at 50 ms;
  // A gains the item at 100 ms without showing it. C takes the click at 58 ms and A keeps its view
  const h = makeTurnHarness()
  const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 0, clickDelayMs: 8 })
  const C = h.makeWin({ id: 'C', focused: false, showing: false, canHandle: false, queryDelayMs: 0, clickDelayMs: 8 })
  const gate = h.holdFirstMatchAll()
  h.setLive([A.client, C.client])

  const clickP = h.click('todoer:fallback')
  await h.clock.flushMicrotasks()
  const ready1 = h.sendReady(C.client)
  await h.clock.flushMicrotasks()
  expect(C.receivedClicks.map(c => c.at), 'premise: the cache ready post reached C first').toEqual([0])
  await h.clock.advance(1)
  gate.resolve([A.client, C.client])
  await h.clock.advance(49) // t=50
  expect(A.receivedClicks, 'premise: A waits behind C offer').toEqual([])
  C.state.canHandle = true
  C.state.showing = true
  const ready2 = h.sendReady(C.client)
  await h.clock.advance(50) // t=100
  A.state.canHandle = true
  await h.clock.runUntilIdle()
  await Promise.all([clickP, ready1, ready2])

  expect(C.summary(), 'C retries at once and takes the click').toEqual({ received: [0, 50], handled: [58], focused: [58] })
  expect(A.summary(), 'the fallback is never posted the click').toEqual({ received: [], handled: [], focused: [] })
  expect(h.store.rows).toEqual([])
})

test('turn rule (a showing window ahead of the offers that wait): a queued cache ready does not outrank the window known to show the item', async () => {
  // review 6, finding 2: A shows the item. C's cache offer is posted at 0 ms; B's cache ready queues at 1 ms while
  // B lacks the item; the list returns at 2 ms; A answers at 10 ms that it shows the item; B gets the item and says
  // ready again at 50 ms. When C's interval ends, A goes first: first come, B was posted at 250 ms and took it
  const h = makeTurnHarness()
  const A = h.makeWin({ id: 'A', focused: true, showing: true, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
  const B = h.makeWin({ id: 'B', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
  const C = h.makeWin({ id: 'C', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
  const gate = h.holdFirstMatchAll()
  h.setLive([A.client, B.client, C.client])

  const clickP = h.click('todoer:rank')
  await h.clock.flushMicrotasks()
  const readyC = h.sendReady(C.client)
  await h.clock.flushMicrotasks()
  expect(C.receivedClicks.map(c => c.at), 'premise: C cache offer is the posted one').toEqual([0])
  await h.clock.advance(1)
  const readyB1 = h.sendReady(B.client)
  await h.clock.flushMicrotasks()
  await h.clock.advance(1) // t=2
  gate.resolve([A.client, B.client, C.client])
  await h.clock.advance(48) // t=50: A answered at 10 ms and waits for the turn
  expect([A.receivedClicks, B.receivedClicks], 'premise: neither A nor B is posted while C holds the turn').toEqual([[], []])
  B.state.canHandle = true
  const readyB2 = h.sendReady(B.client)
  await h.clock.runUntilIdle()
  await Promise.all([clickP, readyC, readyB1, readyB2])

  expect(C.summary()).toEqual({ received: [0], handled: [], focused: [] })
  expect(A.summary(), 'A, known to show the item, is posted first when C interval ends').toEqual({ received: [250], handled: [258], focused: [258] })
  expect(B.summary(), 'B is never posted the click').toEqual({ received: [], handled: [], focused: [] })
  expect(h.store.rows).toEqual([])
})

test('turn rule (documented limit): a second ready that comes before the showing window has answered still goes out at once', async () => {
  // review 6: the opposing case above with A's answer after 16 ms: at 10 ms nothing says yet that A shows the
  // item, so C's retry is posted at once and C takes the click (the released worker gives it to A)
  const h = makeTurnHarness()
  const A = h.makeWin({ id: 'A', focused: true, showing: true, canHandle: true, queryDelayMs: 16, clickDelayMs: 8 })
  const C = h.makeWin({ id: 'C', focused: false, showing: false, canHandle: false, queryDelayMs: 0, clickDelayMs: 8 })
  const gate = h.holdFirstMatchAll()
  h.setLive([A.client, C.client])

  const clickP = h.click('todoer:limit')
  await h.clock.flushMicrotasks()
  const ready1 = h.sendReady(C.client)
  await h.clock.flushMicrotasks()
  await h.clock.advance(1)
  gate.resolve([A.client, C.client])
  await h.clock.advance(9) // t=10: A's answer is due at 17 ms
  C.state.canHandle = true
  const ready2 = h.sendReady(C.client)
  await h.clock.runUntilIdle()
  await Promise.all([clickP, ready1, ready2])

  expect(C.summary()).toEqual({ received: [0, 10], handled: [18], focused: [18] })
  expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
  expect(h.store.rows).toEqual([])
})

for (const variant of [
  { name: 'its ready after its answer', bReadyAt: 20, d: 'none' },
  { name: 'its ready before its answer', bReadyAt: 5, d: 'none' },
  { name: 'the handoff, a window queued ahead of it gains the item', bReadyAt: 20, d: 'gains' },
  { name: 'the tie, a later window in worker order that shows the item too is queued ahead of it', bReadyAt: 20, d: 'shows' },
] as const) {
  test(`turn rule (the answers rank the offers that wait; ${variant.name}): a window that has answered that it shows the item is not passed by another window`, async () => {
    // review 7. A is first in worker order, lacks the item and answers the question late, so discovery stays
    // open. B shows the item and answers at 9 ms; its own ready (at 5 or 20 ms) waits behind C's posted cache
    // offer. Without D, C gets the item (not showing it) and says ready again at 50 ms: held back, for B had
    // answered 41 ms before (posted at once, C took the click at 58 ms). With D queued ahead of B (its ready at
    // 3 ms): the handoff, where D gains the item at 100 ms, and the tie, where D shows the item too but comes
    // after B in worker order (discovery's own order): when C's interval ends, 1 ms before discovery's, B is
    // next, not D. In every variant B is posted the click at 250 ms and takes it
    const h = makeTurnHarness()
    const withD = variant.d !== 'none'
    const dShows = variant.d === 'shows'
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: withD ? 400 : 64, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const D = h.makeWin({ id: 'D', focused: false, showing: dShows, canHandle: dShows, queryDelayMs: 8, clickDelayMs: 8 })
    const live = withD ? [A.client, B.client, C.client, D.client] : [A.client, B.client, C.client]
    const gate = h.holdFirstMatchAll()
    h.setLive(live)

    const clickP = h.click('todoer:answers')
    await h.clock.flushMicrotasks()
    const pending = [h.sendReady(C.client)]
    await h.clock.flushMicrotasks()
    expect(C.receivedClicks.map(c => c.at), 'premise: C cache offer is the posted one').toEqual([0])
    await h.clock.advance(1)
    gate.resolve(live)
    await h.clock.flushMicrotasks()
    let t = 1
    const at = async (ms: number, act: () => void) => {
      await h.clock.advance(ms - t)
      t = ms
      act()
      await h.clock.flushMicrotasks()
    }
    if (withD) await at(3, () => pending.push(h.sendReady(D.client)))
    if (variant.bReadyAt < 9) await at(variant.bReadyAt, () => pending.push(h.sendReady(B.client)))
    await at(10, () => {}) // the answers of B (it shows the item), C (it cannot handle) and D arrived at 9 ms
    if (variant.bReadyAt >= 9) await at(variant.bReadyAt, () => pending.push(h.sendReady(B.client)))
    expect([A.receivedClicks, B.receivedClicks, D.receivedClicks], 'premise: nobody else is posted while C holds the turn').toEqual([[], [], []])
    if (variant.d === 'gains') {
      await at(100, () => {
        D.state.canHandle = true
      })
    } else if (variant.d === 'none') {
      await at(50, () => {
        C.state.canHandle = true
        pending.push(h.sendReady(C.client))
      })
    }
    await h.clock.runUntilIdle()
    await Promise.all([clickP, ...pending])

    expect(C.summary(), 'C is posted once, and not again while B waits').toEqual({ received: [0], handled: [], focused: [] })
    expect(B.summary(), 'B is posted when C interval ends, and takes the click').toEqual({ received: [250], handled: [258], focused: [258] })
    expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(D.summary(), 'a window queued ahead of B is never posted').toEqual({ received: [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  })
}

for (const variant of [
  { name: 'the item returns to the first window behind a draft', back: true, leaves: false },
  { name: 'the other window leaves soon after', back: false, leaves: true },
] as const) {
  test(`turn rule (an answer is good for one offer; ${variant.name}): a window whose offer went unanswered does not get a second turn ahead of another window that shows the item`, async () => {
    // review 8. A (first in worker order) and B both show the item and say so (B at 5 ms, A at 9 ms); C has just
    // loaded and holds the turn with its cache offer. B says ready at 20 ms and A at 50 ms: both wait, as does the
    // loop's own offer to A. At 100 ms A loses the item and begins a draft. At 250 ms A is offered the click for
    // its answer's sake and cannot take it. At 500 ms B is next, for A's answer was used up by that offer: with it
    // still counting, A was offered the click a second time, replaced its draft where the item had come back
    // (400 ms), and B, which shows the item throughout, got the click a full interval later or, gone by then, never
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: true, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 4, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const live = [A.client, B.client, C.client]
    const gate = h.holdFirstMatchAll()
    h.setLive(live)

    const clickP = h.click('todoer:once')
    await h.clock.flushMicrotasks()
    const pending = [h.sendReady(C.client)]
    await h.clock.flushMicrotasks()
    expect(C.receivedClicks.map(c => c.at), 'premise: C cache offer is the posted one').toEqual([0])
    await h.clock.advance(1)
    gate.resolve(live)
    await h.clock.flushMicrotasks()
    let t = 1
    const at = async (ms: number, act: () => void) => {
      await h.clock.advance(ms - t)
      t = ms
      act()
      await h.clock.flushMicrotasks()
    }
    await at(20, () => pending.push(h.sendReady(B.client)))
    await at(50, () => pending.push(h.sendReady(A.client)))
    expect([A.receivedClicks, B.receivedClicks], 'premise: both showing windows wait behind C').toEqual([[], []])
    await at(100, () => {
      A.state.showing = false
      A.state.canHandle = false
    })
    await at(260, () => {})
    expect([A.receivedClicks.map(c => c.at), B.receivedClicks], 'premise: A, first in worker order, is offered the click when C interval ends').toEqual([[250], []])
    if (variant.back) {
      await at(400, () => {
        A.state.canHandle = true
      })
    }
    if (variant.leaves) {
      await at(600, () => {
        B.state.showing = false
        B.state.canHandle = false
      })
    }
    await h.clock.runUntilIdle()
    await Promise.all([clickP, ...pending])

    expect(A.summary(), 'A is offered the click once, and keeps its draft').toEqual({ received: [250], handled: [], focused: [] })
    expect(B.summary(), 'B is next when A interval ends, and takes the click').toEqual({ received: [500], handled: [508], focused: [508] })
    expect(C.summary()).toEqual({ received: [0], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  })
}

test('turn rule (an answer is good for one offer; the control): an answer that arrives after an earlier post to its window still ranks that window next offer', async () => {
  // review 8's control. B has just loaded: its cache ready is posted the click at 0 ms and B, without the item,
  // lets it pass (B handles a click at once here: the harness fixes the `canHandle` of a window's ANSWER when the
  // question is posted to it, so B must have the item by then). B gets the item and shows it right after its
  // cache post, and its answer says so at 9 ms: after the post it
  // already had, so the answer is not used up. D says ready at 3 ms and waits; it gains the item at 100 ms. When
  // B's interval ends, the loop's offer to B goes ahead of D, queued earlier, and B takes the click
  const h = makeTurnHarness()
  const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
  const B = h.makeWin({ id: 'B', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 0 })
  const D = h.makeWin({ id: 'D', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
  const live = [A.client, B.client, D.client]
  const gate = h.holdFirstMatchAll()
  h.setLive(live)

  const clickP = h.click('todoer:later')
  await h.clock.flushMicrotasks()
  const pending = [h.sendReady(B.client)]
  await h.clock.flushMicrotasks()
  expect([B.receivedClicks.map(c => c.at), B.handledClicks], 'premise: B cache offer is the posted one, and B let it pass').toEqual([[0], []])
  B.state.showing = true
  B.state.canHandle = true
  await h.clock.advance(1)
  gate.resolve(live)
  await h.clock.flushMicrotasks()
  let t = 1
  const at = async (ms: number, act: () => void) => {
    await h.clock.advance(ms - t)
    t = ms
    act()
    await h.clock.flushMicrotasks()
  }
  await at(3, () => pending.push(h.sendReady(D.client)))
  await at(100, () => {
    D.state.canHandle = true
  })
  expect([B.receivedClicks.map(c => c.at), D.receivedClicks], 'premise: nothing more is posted while B first offer has the turn').toEqual([[0], []])
  await h.clock.runUntilIdle()
  await Promise.all([clickP, ...pending])

  expect(B.summary(), 'B is offered the click again when its first interval ends, ahead of D, and takes it').toEqual({ received: [0, 250], handled: [250], focused: [250] })
  expect(D.summary(), 'D, queued earlier, is never posted').toEqual({ received: [], handled: [], focused: [] })
  expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
  expect(h.store.rows).toEqual([])
})

test('turn rule (an answer is good for one offer; the same window again): a second ready that goes out at once uses the answer up too', async () => {
  // A has just loaded: its cache ready is posted the click at 0 ms and A, without the item, lets it pass (A
  // handles a click at once here, as B does in the control above). A gets the item and shows it right after, and
  // its answer says so at 9 ms (the loop's offer to A then waits too). B, which can take the click but does not
  // show the item, says ready at 3 ms and waits. A loses the item again at 40 ms and says ready again at 50 ms:
  // posted at once, which uses its answer up. When that interval ends at 300 ms, B, queued first, is next
  // (with the answer still counting, A was offered the click a third time and B waited to 550 ms)
  const h = makeTurnHarness()
  const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 0 })
  const B = h.makeWin({ id: 'B', focused: false, showing: false, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
  const live = [A.client, B.client]
  const gate = h.holdFirstMatchAll()
  h.setLive(live)

  const clickP = h.click('todoer:retry')
  await h.clock.flushMicrotasks()
  const pending = [h.sendReady(A.client)]
  await h.clock.flushMicrotasks()
  expect([A.receivedClicks.map(c => c.at), A.handledClicks], 'premise: A cache offer is the posted one, and A let it pass').toEqual([[0], []])
  A.state.showing = true
  A.state.canHandle = true
  await h.clock.advance(1)
  gate.resolve(live)
  await h.clock.flushMicrotasks()
  let t = 1
  const at = async (ms: number, act: () => void) => {
    await h.clock.advance(ms - t)
    t = ms
    act()
    await h.clock.flushMicrotasks()
  }
  await at(3, () => pending.push(h.sendReady(B.client)))
  await at(40, () => {
    A.state.showing = false
    A.state.canHandle = false
  })
  await at(50, () => pending.push(h.sendReady(A.client)))
  expect([A.receivedClicks.map(c => c.at), B.receivedClicks], 'premise: A second ready goes out at once; B still waits').toEqual([[0, 50], []])
  await h.clock.runUntilIdle()
  await Promise.all([clickP, ...pending])

  expect(A.summary(), 'A is posted twice and not a third time').toEqual({ received: [0, 50], handled: [], focused: [] })
  expect(B.summary(), 'B, queued first, is next when A interval ends').toEqual({ received: [300], handled: [308], focused: [308] })
  expect(h.store.rows).toEqual([])
})

for (const variant of [
  { name: 'the trace', cQueryDelayMs: 8, fourth: false },
  { name: 'the other showing window answers after the negative answer', cQueryDelayMs: 224, fourth: false },
  { name: 'a fourth window holds the first turn', cQueryDelayMs: 8, fourth: true },
] as const) {
  test(`turn rule (a used-up answer in the loop; ${variant.name}): the loop does not choose a window again whose answer a post has used up`, async () => {
    // review 9. A is first in worker order, lacks the item and says so only at 200 ms. B and C both show the item
    // (B says so at 9 ms; C at 9 ms, or at 225 ms). At 40 ms B loses the item and begins a draft; at 100 ms it says
    // ready and is offered the click, which uses its answer up, and cannot take it; at 300 ms the item is back in
    // B, not shown. When discovery ends, the loop's preferred offer goes to C, whose answer stands: reading the old
    // answers, the loop chose B again (B replaced its draft at 358 ms), or ended discovery at A's answer before
    // C's had come. With a fourth window D holding the first turn, B's ready and the loop's offer both wait when
    // discovery ends: B's ready is posted when D's interval ends (250 ms), and the loop's offer, which picks its
    // window when its turn starts, then goes to C (fixed to B, it went there a second time at 500 ms)
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 199, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, showing: true, canHandle: true, queryDelayMs: variant.cQueryDelayMs, clickDelayMs: 8 })
    const D = h.makeWin({ id: 'D', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const live = variant.fourth ? [A.client, B.client, C.client, D.client] : [A.client, B.client, C.client]
    const gate = h.holdFirstMatchAll()
    h.setLive(live)

    const clickP = h.click('todoer:spent')
    await h.clock.flushMicrotasks()
    const pending: ReturnType<typeof h.sendReady>[] = []
    if (variant.fourth) {
      pending.push(h.sendReady(D.client))
      await h.clock.flushMicrotasks()
    }
    expect(D.receivedClicks.map(c => c.at), 'premise: with a fourth window, its cache offer holds the first turn').toEqual(variant.fourth ? [0] : [])
    await h.clock.advance(1)
    gate.resolve(live)
    await h.clock.flushMicrotasks()
    let t = 1
    const at = async (ms: number, act: () => void) => {
      await h.clock.advance(ms - t)
      t = ms
      act()
      await h.clock.flushMicrotasks()
    }
    await at(40, () => {
      B.state.showing = false
      B.state.canHandle = false
    })
    await at(100, () => pending.push(h.sendReady(B.client)))
    expect(B.receivedClicks.map(c => c.at), 'premise: B ready is posted at once, or waits behind the fourth window').toEqual(variant.fourth ? [] : [100])
    await at(300, () => {
      B.state.canHandle = true
    })
    await h.clock.runUntilIdle()
    await Promise.all([clickP, ...pending])

    const bAt = variant.fourth ? 250 : 100
    const cAt = bAt + 250
    expect(B.summary(), 'B is offered the click once, and keeps its draft').toEqual({ received: [bAt], handled: [], focused: [] })
    expect(C.summary(), 'C, whose answer stands, gets the loop preferred offer and takes the click').toEqual({ received: [cAt], handled: [cAt + 8], focused: [cAt + 8] })
    expect(A.summary()).toEqual({ received: [], handled: [], focused: [] })
    expect(D.summary()).toEqual({ received: variant.fourth ? [0] : [], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  })
}

for (const variant of [
  { name: 'a late answer; the item returns behind a draft', late: true, leaves: false },
  { name: 'a late answer; the showing window leaves', late: true, leaves: true },
  { name: 'prompt answers; the item returns behind a draft', late: false, leaves: false },
  { name: 'prompt answers; the showing window leaves', late: false, leaves: true },
] as const) {
  test(`turn rule (answers after the decision, and a tie at the handoff; ${variant.name}): the window that shows the item throughout gets the preferred offer`, async () => {
    // review 10. A lacks the item and holds the first turn with its cache offer. B and C show the item. B says so
    // at 9 ms, loses the item at 40 ms, begins a draft and says ready at 100 ms. Late: A answers at 200 ms, which
    // ends the wait (B's answer stands), and C answers at 225 ms: within the deadline, so it is still taken. Prompt:
    // all three answer at 9 ms, B's answer decides and C's, in the same moment, is still taken; the loop's
    // preferred offer then waits AHEAD of B's ready, both for B. When A's interval ends (250 ms) B's own ready is
    // served first, also at the tie, and uses B's answer up; B cannot take the click. At 500 ms the preferred offer
    // picks C, which takes it. (With the answer after the decision dropped, no answer stood and the fallback came
    // to B again at 750 ms; with the preferred offer first at the tie, B's ready posted to B again at 500 ms: B
    // replaced its draft where the item was back, and C, gone at 600 ms, never got the click)
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: variant.late ? 199 : 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: true, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, showing: true, canHandle: true, queryDelayMs: variant.late ? 224 : 8, clickDelayMs: 8 })
    const live = [A.client, B.client, C.client]
    const gate = h.holdFirstMatchAll()
    h.setLive(live)

    const clickP = h.click('todoer:after')
    await h.clock.flushMicrotasks()
    const pending = [h.sendReady(A.client)]
    await h.clock.flushMicrotasks()
    expect(A.receivedClicks.map(c => c.at), 'premise: A cache offer holds the first turn').toEqual([0])
    await h.clock.advance(1)
    gate.resolve(live)
    await h.clock.flushMicrotasks()
    let t = 1
    const at = async (ms: number, act: () => void) => {
      await h.clock.advance(ms - t)
      t = ms
      act()
      await h.clock.flushMicrotasks()
    }
    await at(40, () => {
      B.state.showing = false
      B.state.canHandle = false
    })
    await at(100, () => pending.push(h.sendReady(B.client)))
    await at(260, () => {})
    expect([B.receivedClicks.map(c => c.at), C.receivedClicks], 'premise: B own ready is served when A interval ends').toEqual([[250], []])
    if (variant.leaves) {
      await at(600, () => {
        C.state.showing = false
        C.state.canHandle = false
      })
    } else {
      await at(300, () => {
        B.state.canHandle = true
      })
    }
    await h.clock.runUntilIdle()
    await Promise.all([clickP, ...pending])

    expect(B.summary(), 'B is offered the click once, and keeps its draft').toEqual({ received: [250], handled: [], focused: [] })
    expect(C.summary(), 'C gets the preferred offer when B interval ends, and takes the click').toEqual({ received: [500], handled: [508], focused: [508] })
    expect(A.summary()).toEqual({ received: [0], handled: [], focused: [] })
    expect(h.store.rows).toEqual([])
  })
}

test('turn rule (the fallback leaves out the window the preferred offer was posted to): a showing window that stays silent is offered the click once', async () => {
  // B is first in worker order, answers that it shows the item, and then stays silent on the click. The loop's
  // preferred offer goes to B (9 ms); when its interval ends, the fallback goes on with the OTHER windows in
  // worker order: A is offered the click at 259 ms and takes it (with B still in the fallback, B was posted a
  // second time and A waited to 509 ms)
  const h = makeTurnHarness()
  const B = h.makeWin({ id: 'B', focused: true, showing: true, canHandle: true, silentClick: true, queryDelayMs: 8, clickDelayMs: 8 })
  const A = h.makeWin({ id: 'A', focused: false, showing: false, canHandle: true, queryDelayMs: 8, clickDelayMs: 8 })
  const live = [B.client, A.client]
  const gate = h.holdFirstMatchAll()
  h.setLive(live)

  const clickP = h.click('todoer:left-out')
  await h.clock.flushMicrotasks()
  await h.clock.advance(1)
  gate.resolve(live)
  await h.clock.flushMicrotasks()
  await h.clock.advance(19) // t=20
  expect([B.receivedClicks.map(c => c.at), A.receivedClicks], 'premise: the preferred offer went to B, first in worker order and showing').toEqual([[9], []])
  await h.clock.runUntilIdle()
  await clickP

  expect(B.summary(), 'B is offered the click once').toEqual({ received: [9], handled: [], focused: [] })
  expect(A.summary(), 'A is next when B interval ends, and takes the click').toEqual({ received: [259], handled: [267], focused: [267] })
  expect(h.store.rows).toEqual([])
})

test('regression (third trace): starting window ready across an empty first matchAll with openWindow returning null delivers to C (as released)', async () => {
  // Subcase A: C sends ready while the first matchAll snapshot is still pending (resolving [] at 1 ms,
  // before C's ack at 8 ms) -> as released, step 5 calls openWindow (returning null) and finishes
  // without waiting on C's turn, while C's in-flight ready offer still delivers at 8 ms and empties the store
  {
    const h = makeTurnHarness()
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    const gate = h.holdFirstMatchAll()
    h.setLive([C.client])

    const clickP = h.click('todoer:cold-ready', { source: 'todoer', item: 's3' })
    await h.clock.flushMicrotasks()
    const readyC = h.sendReady(C.client)
    await h.clock.advance(1)
    gate.resolve([])
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC])

    expect(C.summary()).toEqual({ received: [0], handled: [8], focused: [] })
    expect(h.openCalls()).toBe(1)
    expect(h.store.rows).toEqual([])
  }

  // Subcase A2: when the empty first matchAll returns AFTER C's ack (10 ms > 8 ms), the post-list
  // acknowledgement check catches it (as released): C is focused at 10 ms and openWindow is never called
  {
    const h = makeTurnHarness()
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    const gate = h.holdFirstMatchAll()
    h.setLive([C.client])

    const clickP = h.click('todoer:cold-ready-acked', { source: 'todoer', item: 's3b' })
    await h.clock.flushMicrotasks()
    const readyC = h.sendReady(C.client)
    await h.clock.advance(10)
    gate.resolve([])
    await h.clock.runUntilIdle()
    await Promise.all([clickP, readyC])

    expect(C.summary()).toEqual({ received: [0], handled: [8], focused: [10] })
    expect(h.openCalls()).toBe(0)
    expect(h.store.rows).toEqual([])
  }

  // Subcase B: C sends ready during the empty first matchAll, its received ack arrives only after
  // its 250 ms turn ends and openWindow returns null -> C still received the click, acted once, and emptied the store
  {
    const store = memoryStore()
    const clock = makeFakeClock(45_000)
    let relay!: ReturnType<typeof createNotificationClickRelay>
    const acted: string[] = []
    const holdAck = deferred<void>()
    const firstMatchAll = deferred<WindowClientLike[]>()
    let matchAllCalls = 0

    const wC = fakeClient('C', {
      focused: false,
      onPost: msg => {
        const m = msg as NotificationClickMessage
        if (m.type !== NOTIFICATION_CLICK_TYPE) return
        acted.push('C')
        void holdAck.promise.then(() =>
          relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: wC }, sw)
        )
      },
    })
    const sw: ServiceWorkerScopeLike = {
      registration: { scope: 'https://mind.page/' },
      clients: {
        async matchAll() {
          matchAllCalls++
          return matchAllCalls === 1 ? firstMatchAll.promise : [wC]
        },
        async openWindow() {
          return null
        },
      },
    }
    relay = createNotificationClickRelay(store, {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      makeId: seqIds(),
      ackTimeoutMs: 250,
      totalAckBudgetMs: 1500,
    })

    const done = relay.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:cold-null', data: { source: 'todoer', item: 's4' } }) }, sw)
    await clock.flushMicrotasks()
    const readyDone = relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: wC }, sw)
    await clock.flushMicrotasks()
    firstMatchAll.resolve([])
    await clock.runUntilIdle()
    await Promise.all([done, readyDone])
    holdAck.resolve()
    await clock.flushMicrotasks()

    expect(acted).toEqual(['C'])
    expect(store.rows).toEqual([])
  }
})

test('budget (7 windows): silent preferred G gets its own ackTimeoutMs wait so fallback A..E..F still reaches F (working and failing stores)', async () => {
  const brokenStore = (): PendingClickStore => ({
    async put() { throw new Error('IDB blocked') },
    async assignUnassigned() { throw new Error('IDB blocked') },
    async remove() { throw new Error('IDB blocked') },
    async listEligible() { throw new Error('IDB blocked') },
    async clear() { throw new Error('IDB blocked') },
  })

  const runSeven = async (failStore: boolean, fAnswersQuery: boolean) => {
    const memStore = failStore ? null : memoryStore()
    const store: PendingClickStore = memStore ?? brokenStore()
    const clock = makeFakeClock(50_000)
    let relay!: ReturnType<typeof createNotificationClickRelay>
    const clickOrder: string[] = []
    const acted: string[] = []

    const silents = ['A', 'B', 'C', 'D', 'E'].map((id, i) =>
      fakeClient(id, {
        focused: i === 0,
        onPost: msg => {
          if ((msg as { type?: string }).type === NOTIFICATION_CLICK_TYPE) clickOrder.push(id)
        },
      })
    )
    const wF = fakeClient('F', {
      onPost: msg => {
        const m = msg as NotificationClickQueryMessage | NotificationClickMessage
        if (m.type === NOTIFICATION_CLICK_QUERY && fAnswersQuery) {
          queueMicrotask(() =>
            void relay.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: false, canHandle: true }, source: wF }, sw)
          )
        } else if (m.type === NOTIFICATION_CLICK_TYPE) {
          clickOrder.push('F')
          acted.push('F')
          queueMicrotask(() => void relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: wF }, sw))
        }
      },
    })
    const wG = fakeClient('G', {
      onPost: msg => {
        const m = msg as NotificationClickQueryMessage | NotificationClickMessage
        if (m.type === NOTIFICATION_CLICK_QUERY) {
          queueMicrotask(() =>
            void relay.onMessage({ data: { type: NOTIFICATION_CLICK_STATUS, id: m.id, showing: true, canHandle: true }, source: wG }, sw)
          )
        } else if (m.type === NOTIFICATION_CLICK_TYPE) {
          clickOrder.push('G')
          // Preferred G stays silent on the ordinary click
        }
      },
    })
    const sw: ServiceWorkerScopeLike = {
      registration: { scope: 'https://mind.page/' },
      clients: { async matchAll() { return [...silents, wF, wG] }, async openWindow() { return null } },
    }
    relay = createNotificationClickRelay(store, {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      makeId: seqIds(),
      ackTimeoutMs: 250,
      totalAckBudgetMs: 1500,
    })

    const done = relay.onNotificationClick({ notification: fakeNotification({ tag: 'todoer:seven', data: { source: 'todoer', item: 's7' } }) }, sw)
    await clock.runUntilIdle()
    await done

    return {
      elapsed: clock.now() - 50_000,
      clickOrder,
      acted,
      focusF: wF.focusCalls(),
      focusOthers: [...silents, wG].reduce((n, w) => n + w.focusCalls(), 0),
      storedRows: memStore ? memStore.rows.length : 0,
    }
  }

  for (const [failStore, fAnswersQuery] of [
    [false, true],
    [true, true],
    [false, false],
    [true, false],
  ] as const) {
    expect(await runSeven(failStore, fAnswersQuery)).toEqual({
      elapsed: 1750, // 250 ms discovery + 250 ms preferred G + 5 * 250 ms silent A..E, then F answers immediately
      clickOrder: ['G', 'A', 'B', 'C', 'D', 'E', 'F'],
      acted: ['F'],
      focusF: 1,
      focusOthers: 0,
      storedRows: 0,
    })
  }
})

test('ready replay order (two owned clicks): review trace posts X then Y in order and C ends on Y (no ack-interval wait between posts)', async () => {
  // Subcase A (review 4 trace 1): A and B lack X and Y (8 ms discovery); X waits behind A's turn (8..258 ms),
  // Y is clicked at 50 ms (discovery 50..58 ms, then A's turn 58..308 ms); C syncs both and says ready at 52 ms.
  // Released posts X then Y at 52 ms (handled at 60 ms, final item Y); replay keeps X then Y and ends on Y.
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickX = h.click('todoer:X', { source: 'todoer', item: 'X' })
    await h.clock.advance(50)
    const clickY = h.click('todoer:Y', { source: 'todoer', item: 'Y' })
    await h.clock.advance(2) // t=52
    h.setLive([A.client, B.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickX, clickY, readyC])

    expect(C.receivedClicks).toEqual([
      { id: 'click-1', item: 'X', at: 258 },
      { id: 'click-2', item: 'Y', at: 308 },
    ])
    expect(C.handledClicks).toEqual([
      { id: 'click-1', item: 'X', at: 266 },
      { id: 'click-2', item: 'Y', at: 316 },
    ])
    expect(C.finalItem()).toBe('Y')
    expect(h.store.rows).toEqual([])
  }

  // Subcase B (no ack-interval wait): Y stays in discovery at 258 ms so Y's turn is free when X posts;
  // Y posts at 258 ms right after X without waiting for X's acknowledgement interval.
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickX = h.click('todoer:X', { source: 'todoer', item: 'X' })
    await h.clock.advance(40)
    B.state.silentQuery = true // Y's discovery runs 50..300 ms so Y's turn is free at 258 ms
    await h.clock.advance(10) // t=50
    const clickY = h.click('todoer:Y', { source: 'todoer', item: 'Y' })
    await h.clock.advance(2) // t=52
    h.setLive([A.client, B.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickX, clickY, readyC])

    expect(C.receivedClicks).toEqual([
      { id: 'click-1', item: 'X', at: 258 },
      { id: 'click-2', item: 'Y', at: 258 },
    ])
    expect(C.handledClicks).toEqual([
      { id: 'click-1', item: 'X', at: 266 },
      { id: 'click-2', item: 'Y', at: 266 },
    ])
    expect(C.finalItem()).toBe('Y')
    expect(h.store.rows).toEqual([])
  }

  // Subcase C (skipped earlier row): A acknowledges X at 108 ms while C waits in turn -> X is skipped for C
  // and Y posts to C immediately at 108 ms.
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandleItem: item => item === 'X', queryDelayMs: 8, clickDelayMs: 100 })
    const B = h.makeWin({ id: 'B', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickX = h.click('todoer:X', { source: 'todoer', item: 'X' })
    await h.clock.advance(40)
    B.state.silentQuery = true
    await h.clock.advance(10) // t=50
    const clickY = h.click('todoer:Y', { source: 'todoer', item: 'Y' })
    await h.clock.advance(2) // t=52
    h.setLive([A.client, B.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickX, clickY, readyC])

    expect(A.handledClicks).toEqual([{ id: 'click-1', item: 'X', at: 108 }])
    expect(C.receivedClicks).toEqual([{ id: 'click-2', item: 'Y', at: 108 }])
    expect(C.handledClicks).toEqual([{ id: 'click-2', item: 'Y', at: 116 }])
    expect(C.finalItem()).toBe('Y')
    expect(h.store.rows).toEqual([])
  }
})

test('ready replay order (owned then unowned): newer unowned click waits for older owned post and posts immediately after it', async () => {
  // Subcase A: X (click-1) is still owned (probing B 258..508 ms) while Y (click-2, clicked after B closed)
  // finished its single-window probe of A at 270 ms and is stored unowned. C says ready at 300 ms:
  // Y must wait until X posts at 508 ms, then post at once at 508 ms so C handles X then Y and ends on Y.
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickX = h.click('todoer:X', { source: 'todoer', item: 'X' })
    await h.clock.advance(20)
    h.setLive([A.client])
    const clickY = h.click('todoer:Y', { source: 'todoer', item: 'Y' })
    await h.clock.advance(280) // t=300: Y's handler exited at 270 ms (unowned); X is in B's turn 258..508 ms (owned)
    await clickY
    h.setLive([A.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickX, readyC])

    expect(C.receivedClicks).toEqual([
      { id: 'click-1', item: 'X', at: 508 },
      { id: 'click-2', item: 'Y', at: 508 },
    ])
    expect(C.handledClicks).toEqual([
      { id: 'click-1', item: 'X', at: 516 },
      { id: 'click-2', item: 'Y', at: 516 },
    ])
    expect(C.finalItem()).toBe('Y')
    expect(h.store.rows).toEqual([])
  }

  // Subcase B: C lacks X and has Y -> Y still posts at 508 ms right after X (no 250 ms ack wait on X)
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, canHandleItem: item => item === 'Y', clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickX = h.click('todoer:X', { source: 'todoer', item: 'X' })
    await h.clock.advance(20)
    h.setLive([A.client])
    const clickY = h.click('todoer:Y', { source: 'todoer', item: 'Y' })
    await h.clock.advance(280) // t=300
    await clickY
    h.setLive([A.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickX, readyC])

    expect(C.receivedClicks).toEqual([
      { id: 'click-1', item: 'X', at: 508 },
      { id: 'click-2', item: 'Y', at: 508 },
    ])
    expect(C.handledClicks).toEqual([{ id: 'click-2', item: 'Y', at: 516 }])
    expect(C.finalItem()).toBe('Y')
    expect(h.store.rows.map(r => r.id)).toEqual(['click-1'])
  }

  // Subcase C: clear arriving while C waits on owned X suppresses the queued unowned Y too
  {
    const h = makeTurnHarness()
    const A = h.makeWin({ id: 'A', focused: true, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const B = h.makeWin({ id: 'B', focused: false, showing: false, canHandle: false, queryDelayMs: 8, clickDelayMs: 8 })
    const C = h.makeWin({ id: 'C', focused: false, canHandle: true, clickDelayMs: 8 })
    h.setLive([A.client, B.client])

    const clickX = h.click('todoer:X', { source: 'todoer', item: 'X' })
    await h.clock.advance(20)
    h.setLive([A.client])
    const clickY = h.click('todoer:Y', { source: 'todoer', item: 'Y' })
    await h.clock.advance(280) // t=300
    await clickY
    h.setLive([A.client, C.client])
    const readyC = h.sendReady(C.client)
    await h.clock.advance(50) // t=350
    await h.sendClear(A.client)
    await h.clock.runUntilIdle()
    await Promise.all([clickX, readyC])

    expect(C.receivedClicks).toEqual([])
    expect(h.store.rows).toEqual([])
  }
})

test('cold open (review trace, healthy store): empty first list opens D at once while C holds a ready turn; Y finds D and D handles X then Y', async () => {
  const clock = makeFakeClock(0)
  const store = memoryStore()
  let relay!: ReturnType<typeof createNotificationClickRelay>
  const firstMatchAll = deferred<WindowClientLike[]>()
  let matchAllCalls = 0
  let liveWindows: WindowClientLike[] = []
  const openedCalls: { at: number; id: string }[] = []
  const openNames = ['D', 'E', 'F']

  let dClient: WindowClientLike | null = null
  let dListening = false
  const dReceivedListening: { id: string; item: string; at: number }[] = []
  const dHandled: { id: string; item: string; at: number }[] = []
  const dHandledIds = new Set<string>()
  const cReceived: { id: string; at: number }[] = []

  const wC: WindowClientLike = {
    id: 'C',
    focused: false,
    frameType: 'top-level',
    async focus() { return wC },
    postMessage(msg: unknown) {
      const m = msg as NotificationClickMessage
      if (m.type === NOTIFICATION_CLICK_TYPE) cReceived.push({ id: m.id, at: clock.now() })
    },
  }

  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() {
        matchAllCalls++
        if (matchAllCalls === 1) return firstMatchAll.promise
        return [...liveWindows]
      },
      async openWindow() {
        const id = openNames[openedCalls.length] ?? `W${openedCalls.length}`
        openedCalls.push({ at: clock.now(), id })
        const client: WindowClientLike = {
          id,
          focused: false,
          frameType: 'top-level',
          async focus() { return client },
          postMessage(msg: unknown) {
            const m = msg as NotificationClickMessage
            if (id !== 'D' || m.type !== NOTIFICATION_CLICK_TYPE || !dListening) return
            const item = String((m.data as { item?: unknown }).item)
            dReceivedListening.push({ id: m.id, item, at: clock.now() })
            clock.setTimeout(() => {
              if (!dHandledIds.has(m.id)) {
                dHandledIds.add(m.id)
                dHandled.push({ id: m.id, item, at: clock.now() })
              }
              void relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: client }, sw)
            }, 8)
          },
        }
        if (id === 'D') dClient = client
        liveWindows = [...liveWindows, client]
        return client
      },
    },
  }

  relay = createNotificationClickRelay(store, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })

  // t=0: X arrives; its first matchAll returns [] at 5 ms
  const clickX = relay.onNotificationClick(
    { notification: fakeNotification({ tag: 'todoer:X', data: { source: 'todoer', item: 'X' } }) },
    sw
  )
  await clock.advance(1)
  // t=1: C says ready, receives X (lacks X so never acks, holding X's turn until 251 ms), then closes
  liveWindows = [wC]
  const readyC = relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: wC }, sw)
  await clock.flushMicrotasks()
  expect(cReceived).toEqual([{ id: 'click-1', at: 1 }])
  liveWindows = []

  // t=5: X's first matchAll returns [] -> X calls openWindow at once, opening D
  await clock.advance(4)
  firstMatchAll.resolve([])
  await clock.flushMicrotasks()

  // t=60: Y arrives with a distinct click id; Y finds D already open (D is still loading)
  await clock.advance(55)
  const clickY = relay.onNotificationClick(
    { notification: fakeNotification({ tag: 'todoer:Y', data: { source: 'todoer', item: 'Y' } }) },
    sw
  )
  await clock.flushMicrotasks()

  // t=260: past C's 251 ms turn end, while D is still loading -> pin openWindow count, clients, and row destinations
  await clock.advance(200)
  expect(openedCalls).toHaveLength(1)
  expect(openedCalls).toEqual([{ at: 5, id: 'D' }])
  expect(store.rows.map(r => ({ id: r.id, clientId: r.clientId }))).toEqual([
    { id: 'click-1', clientId: 'D' },
    { id: 'click-2', clientId: null },
  ])

  // t=260: D finishes loading, listener stands, and D says ready -> handles both X then Y
  dListening = true
  const readyD = relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: dClient! }, sw)
  await clock.runUntilIdle()
  await Promise.all([clickX, clickY, readyC, readyD])

  expect(openedCalls).toEqual([{ at: 5, id: 'D' }])
  expect(dReceivedListening).toEqual([
    { id: 'click-1', item: 'X', at: 260 },
    { id: 'click-2', item: 'Y', at: 260 },
  ])
  expect(dHandled).toEqual([
    { id: 'click-1', item: 'X', at: 268 },
    { id: 'click-2', item: 'Y', at: 268 },
  ])
  expect(dHandled[dHandled.length - 1].item).toBe('Y')
  expect(store.rows).toEqual([])
})

test('cold open (review trace, Y initial store write fails): D opens at 5 ms so D listener stands before Y at 60 ms and both clicks reach D', async () => {
  const clock = makeFakeClock(0)
  const baseStore = memoryStore()
  let putCalls = 0
  const store: PendingClickStore = {
    async put(rec, t) {
      putCalls++
      if (putCalls === 2) throw new Error('IDB blocked on Y')
      return baseStore.put(rec, t)
    },
    assignUnassigned: (cid, t) => baseStore.assignUnassigned(cid, t),
    remove: (id, t) => baseStore.remove(id, t),
    listEligible: (cid, live, t) => baseStore.listEligible(cid, live, t),
    clear: () => baseStore.clear(),
  }

  let relay!: ReturnType<typeof createNotificationClickRelay>
  const firstMatchAll = deferred<WindowClientLike[]>()
  let matchAllCalls = 0
  let liveWindows: WindowClientLike[] = []
  const openedCalls: { at: number; id: string }[] = []
  const openNames = ['D', 'E', 'F']
  const readyPromises: Promise<void>[] = []

  let dListening = false
  const dHandled: { id: string; item: string; at: number }[] = []
  const dHandledIds = new Set<string>()

  const wC: WindowClientLike = {
    id: 'C',
    focused: false,
    frameType: 'top-level',
    async focus() { return wC },
    postMessage() {},
  }

  const sw: ServiceWorkerScopeLike = {
    registration: { scope: 'https://mind.page/' },
    clients: {
      async matchAll() {
        matchAllCalls++
        if (matchAllCalls === 1) return firstMatchAll.promise
        return [...liveWindows]
      },
      async openWindow() {
        const id = openNames[openedCalls.length] ?? `W${openedCalls.length}`
        openedCalls.push({ at: clock.now(), id })
        const client: WindowClientLike = {
          id,
          focused: false,
          frameType: 'top-level',
          async focus() { return client },
          postMessage(msg: unknown) {
            const m = msg as NotificationClickMessage
            if (id !== 'D' || m.type !== NOTIFICATION_CLICK_TYPE || !dListening) return
            const item = String((m.data as { item?: unknown }).item)
            clock.setTimeout(() => {
              if (!dHandledIds.has(m.id)) {
                dHandledIds.add(m.id)
                dHandled.push({ id: m.id, item, at: clock.now() })
              }
              void relay.onMessage({ data: { type: NOTIFICATION_CLICK_RECEIVED, id: m.id }, source: client }, sw)
            }, 8)
          },
        }
        liveWindows = [...liveWindows, client]
        if (id === 'D') {
          // D's listener stands and D sends ready 20 ms after opening (25 ms when opened at 5 ms)
          clock.setTimeout(() => {
            dListening = true
            readyPromises.push(relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: client }, sw))
          }, 20)
        }
        return client
      },
    },
  }

  relay = createNotificationClickRelay(store, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    makeId: seqIds(),
    ackTimeoutMs: 250,
    totalAckBudgetMs: 1500,
  })

  const clickX = relay.onNotificationClick(
    { notification: fakeNotification({ tag: 'todoer:X', data: { source: 'todoer', item: 'X' } }) },
    sw
  )
  await clock.advance(1)
  liveWindows = [wC]
  const readyC = relay.onMessage({ data: { type: NOTIFICATION_CLICK_READY }, source: wC }, sw)
  await clock.flushMicrotasks()
  liveWindows = []

  await clock.advance(4) // t=5
  firstMatchAll.resolve([])
  await clock.flushMicrotasks()

  await clock.advance(55) // t=60: Y's initial store.put fails, D is already open and listening since 25 ms
  const clickY = relay.onNotificationClick(
    { notification: fakeNotification({ tag: 'todoer:Y', data: { source: 'todoer', item: 'Y' } }) },
    sw
  )
  await clock.runUntilIdle()
  await Promise.all([clickX, clickY, readyC, ...readyPromises])

  expect(dHandled).toEqual([
    { id: 'click-2', item: 'Y', at: 68 },
    { id: 'click-1', item: 'X', at: 259 },
  ])
  expect(openedCalls).toHaveLength(1)
  expect(openedCalls).toEqual([{ at: 5, id: 'D' }])
  expect(baseStore.rows).toEqual([])
})
