import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import _ from 'lodash'
import ts from 'typescript'

// exercises the REAL store-save, task-scheduler and wakeStoreSaves code extracted from
// src/routes/index.svelte with controlled timers, listeners and a stub hidden writer (as
// attr_save_task.spec.ts does for _update_attr_async)
const source = readFileSync(resolve(process.cwd(), 'src/routes/index.svelte'), 'utf8')

const extract = (pattern: RegExp, label: string) => {
  const match = source.match(pattern)
  if (!match) throw new Error(`${label} not found in index.svelte`)
  return match[0]
}

const storesSlice = extract(
  /    get local_store\(\): object \{[\s\S]*?(?=\n    \/\/ separate store used for debugging)/,
  'store methods'
)
const schedulerSlice = extract(
  /    invoke\(func\) \{[\s\S]*?(?=\n    \/\/ console logging functions pre-attached to this item)/,
  'scheduler methods'
)
const wakeSlice = extract(
  /  let storeSaveWaitSeq = 0[\s\S]*?function wakeStoreSaves\(raw\) \{[\s\S]*?\n  \}/,
  'wakeStoreSaves'
)

const compiled = ts.transpileModule(
  `class HarnessItem {
    id: string
    constructor(id: string) { this.id = id }
    invalidate_elem_cache(opts: any) { return onInvalidate(this.id, opts) }
    eval(code: string, opts: any) { return onEval(this.id, code, opts) }
${storesSlice}
${schedulerSlice}
  }
${wakeSlice}
  return { HarnessItem, wakeStoreSaves }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true } }
).outputText

const factory = new Function(
  '_',
  'setTimeout',
  'console',
  'items',
  'item',
  '_exists',
  '_item',
  'evalStack',
  'invalidateElemCache',
  'itemStore',
  'hiddenItemsByName',
  'saveHiddenItem',
  'itemDefinesFunction',
  'onInvalidate',
  'onEval',
  'getAnonymous',
  'getInitialized',
  compiled
    .replace(/\banonymous\b/g, 'getAnonymous()')
    .replace(/\binitialized\b/g, 'getInitialized()')
)

type TimerEntry = { id: number; delay: number; fn: () => void; fired: boolean }

function createHarness(opts: { anonymous: boolean; initialized: boolean }) {
  let anonymous = opts.anonymous
  let initialized = opts.initialized
  const timers: TimerEntry[] = []
  const errors: string[] = []
  const evalStack: string[] = []
  const items: any[] = []
  const localMap = new Map<string, string>()
  const localWrites: Array<{ key: string; value: any }> = []
  const hiddenItemsByName = new Map<string, { item: any }>()
  const hiddenWrites: Array<{ name: string; value: any }> = []
  const invalidations: Array<{ id: string; opts: any }> = []
  const listeners = new Map<string, { local?: (id: string) => void; global?: (id: string) => void }>()

  const fakeSetTimeout = (fn: () => void, delay = 0) => {
    const entry: TimerEntry = { id: timers.length + 1, delay, fn, fired: false }
    timers.push(entry)
    return entry.id
  }
  const fakeConsole = {
    error: (...args: any[]) => errors.push(args.map(String).join(' ')),
  }
  const item = (id: string) => {
    const found = items.find(i => i.id == id)
    if (!found) throw new Error(`missing item ${id}`)
    return found
  }
  const _exists = (id: string) => items.some(i => i.id == id)
  const itemStore = {
    get: (key: string) => localMap.get(key) ?? null,
    set: (key: string, value: string) => {
      localMap.set(key, value)
      localWrites.push({ key, value: JSON.parse(value) })
    },
    remove: (key: string) => {
      localMap.delete(key)
      localWrites.push({ key, value: null })
    },
  }
  const saveHiddenItem = (name: string, data: any) => {
    if (!initialized) throw new Error('saveHiddenItem called before initialized')
    if (anonymous) throw new Error('saveHiddenItem called on anonymous account')
    hiddenItemsByName.set(name, { item: _.cloneDeep(data) })
    hiddenWrites.push({ name, value: _.cloneDeep(data) })
    return true
  }
  const itemDefinesFunction = (raw: any, fnName: string) => {
    const l = listeners.get(raw.id)
    if (fnName == '_on_local_store_change') return !!l?.local
    if (fnName == '_on_global_store_change') return !!l?.global
    return false
  }
  const onInvalidate = (id: string, opts: any) => invalidations.push({ id, opts })
  const onEval = (id: string, code: string) => {
    const l = listeners.get(id)
    const localMatch = code.match(/^_on_local_store_change\('([^']+)'\)$/)
    if (localMatch && l?.local) return l.local(localMatch[1])
    const globalMatch = code.match(/^_on_global_store_change\('([^']+)',false\)$/)
    if (globalMatch && l?.global) return l.global(globalMatch[1])
  }

  let HarnessItem: new (id: string) => any
  const _item = (id: string) => new HarnessItem(id)

  const built = factory(
    _,
    fakeSetTimeout,
    fakeConsole,
    items,
    item,
    _exists,
    _item,
    evalStack,
    () => {},
    itemStore,
    hiddenItemsByName,
    saveHiddenItem,
    itemDefinesFunction,
    onInvalidate,
    onEval,
    () => anonymous,
    () => initialized
  )
  HarnessItem = built.HarnessItem
  const wakeStoreSaves: (raw: any) => void = built.wakeStoreSaves

  const addItem = (id: string, savedId: string | null = null, extra: Record<string, any> = {}) => {
    const raw: any = { id, savedId, listen: false, deepasync: false, ...extra }
    items.push(raw)
    return { raw, api: _item(id) }
  }
  const drain = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  const fireTimers = async (pred: (t: TimerEntry) => boolean = () => true) => {
    for (const t of timers.slice()) {
      if (!t.fired && pred(t)) {
        t.fired = true
        t.fn()
      }
    }
    await drain()
  }

  return {
    timers,
    errors,
    evalStack,
    items,
    localMap,
    localWrites,
    hiddenWrites,
    invalidations,
    listeners,
    addItem,
    wakeStoreSaves,
    drain,
    fireTimers,
    setInitialized: (v: boolean) => void (initialized = v),
    setAnonymous: (v: boolean) => void (anonymous = v),
  }
}

test('waking a parked save_global_store serializes behind an earlier async task, runs _on_done on evalStack, preserves options, and supersedes the 1 s timer', async () => {
  const h = createHarness({ anonymous: false, initialized: true })
  const { raw, api } = h.addItem('tmp1', null)
  api._global_store.k = 'v'
  api.save_global_store({ delay: 0, invalidate_elem_cache: true, force_render: false, render_delay: 420 })
  // initial 0 ms task parks its 1 s retry while savedId is missing
  await h.fireTimers(t => t.delay === 0)
  expect(h.timers.filter(t => !t.fired && t.delay === 1000)).toHaveLength(1)
  const retryTask = raw.tasks.save_global_store
  expect(retryTask).toBeTruthy()

  // hold an earlier same-name async task open while waking the parked retry
  let releaseEarlier!: () => void
  raw.running_tasks = {
    save_global_store: new Promise<void>(r => {
      releaseEarlier = r
    }),
  }
  const events: string[] = []
  let doneStack: string[] = []
  retryTask._on_done = () => {
    doneStack = h.evalStack.slice()
    events.push('done')
  }

  raw.savedId = 'doc1'
  h.wakeStoreSaves(raw)
  await h.drain()
  // must NOT bypass the running task chain
  expect(h.hiddenWrites).toEqual([])
  expect(events).toEqual([])

  // release the earlier async task -> parked save runs, saves, and calls _on_done with item on stack
  releaseEarlier()
  await h.drain()
  expect(h.hiddenWrites).toEqual([{ name: 'global_store_doc1', value: { k: 'v' } }])
  expect(h.invalidations).toEqual([{ id: 'tmp1', opts: { force_render: false, render_delay: 420 } }])
  expect(events).toEqual(['done'])
  expect(doneStack).toEqual(['tmp1'])
  expect(raw.tasks.save_global_store).toBeUndefined()

  // firing the old 1 s timer afterwards is a no-op
  await h.fireTimers(t => t.delay === 1000)
  expect(h.hiddenWrites).toHaveLength(1)
  expect(events).toEqual(['done'])
  expect(h.errors).toEqual([])
})

test('waking a parked save_local_store runs through the scheduler and supersedes its 1 s timer', async () => {
  const h = createHarness({ anonymous: true, initialized: true })
  const { raw, api } = h.addItem('tmp_local', null)
  api._local_store.direct = 'ok'
  api.save_local_store({ delay: 0, invalidate_elem_cache: false })
  await h.fireTimers(t => t.delay === 0)
  expect(h.timers.filter(t => !t.fired && t.delay === 1000)).toHaveLength(1)

  let doneStack: string[] = []
  raw.tasks.save_local_store._on_done = () => {
    doneStack = h.evalStack.slice()
  }

  raw.savedId = 'doc_local'
  h.wakeStoreSaves(raw)
  await h.drain()
  expect(h.localWrites).toEqual([{ key: 'mindpage_item_store_doc_local', value: { direct: 'ok' } }])
  expect(h.invalidations).toEqual([])
  expect(doneStack).toEqual(['tmp_local'])
  expect(raw.tasks.save_local_store).toBeUndefined()

  // old 1 s timer exits harmlessly
  await h.fireTimers(t => t.delay === 1000)
  expect(h.localWrites).toHaveLength(1)
  expect(h.errors).toEqual([])
})

test('a caller positive delay is not woken early on savedId, including when replacing a parked retry', async () => {
  const h = createHarness({ anonymous: true, initialized: true })
  const { raw: a, api: apiA } = h.addItem('delayed_initial', null)
  apiA._local_store.x = 1
  apiA.save_local_store({ delay: 500 })
  a.savedId = 'doc_a'
  h.wakeStoreSaves(a)
  await h.drain()
  expect(h.localWrites).toEqual([])
  expect(a.tasks.save_local_store).toBeTruthy()
  await h.fireTimers(t => t.delay === 500)
  expect(h.localWrites).toEqual([{ key: 'mindpage_item_store_doc_a', value: { x: 1 } }])

  // a parked retry replaced by a caller-delayed save must not be woken early either
  const { raw: b, api: apiB } = h.addItem('replaced_retry', null)
  apiB._global_store.y = 1
  apiB.save_global_store({ delay: 0 })
  await h.fireTimers(t => t.delay === 0)
  expect(h.timers.filter(t => !t.fired && t.delay === 1000)).toHaveLength(1)
  apiB._global_store.y = 2
  apiB.save_global_store({ delay: 750 })
  b.savedId = 'doc_b'
  h.wakeStoreSaves(b)
  await h.drain()
  expect(h.localWrites).toHaveLength(1) // still only doc_a
  expect(b.tasks.save_global_store).toBeTruthy()
  await h.fireTimers(t => t.delay === 750)
  await h.fireTimers(t => t.delay === 0)
  expect(h.localMap.get('mindpage_item_store_doc_b')).toBe(JSON.stringify({ _anonymous_global_store: { y: 2 } }))
})

test('signed-in startup: save_global_store stays parked while initialized is false and saves once initialized before the 1 s retry', async () => {
  const h = createHarness({ anonymous: false, initialized: false })
  const { raw, api } = h.addItem('startup_child', null)
  api._global_store.fromInit = 1
  api.save_global_store({ delay: 0 })
  await h.fireTimers(t => t.delay === 0)
  expect(h.timers.filter(t => !t.fired && t.delay === 1000)).toHaveLength(1)

  let errCount = 0
  let doneCount = 0
  raw.tasks.save_global_store._on_error = () => void errCount++
  raw.tasks.save_global_store._on_done = () => void doneCount++

  // create acknowledges BEFORE renderRange finishes (initialized still false)
  raw.savedId = 'doc_startup'
  h.wakeStoreSaves(raw)
  await h.drain()
  expect(h.hiddenWrites, 'must not call saveHiddenItem before initialized').toEqual([])
  expect(h.errors, 'must not throw saveHiddenItem called before initialized').toEqual([])
  expect(errCount).toBe(0)
  expect(raw.tasks.save_global_store, 'retry stays parked until initialized').toBeTruthy()

  // initialization finishes before the 1 s fallback fires -> fallback writes the hidden store once
  h.setInitialized(true)
  await h.fireTimers(t => t.delay === 1000)
  expect(h.hiddenWrites).toEqual([{ name: 'global_store_doc_startup', value: { fromInit: 1 } }])
  expect(doneCount).toBe(1)
  expect(errCount).toBe(0)
  expect(h.errors).toEqual([])
})

test('ordinary anonymous saves keep their body and notify _on_local_store_change once with listener-derived local writes', async () => {
  const h = createHarness({ anonymous: true, initialized: true })
  const { api } = h.addItem('anon_saved', 'doc_anon')
  const order: string[] = []
  h.listeners.set('anon_saved', {
    global: () => {
      order.push('global')
      api.local_store.derived = 'from-global'
    },
    local: () => {
      order.push('local')
    },
  })

  api.global_store.setting = 1
  await h.fireTimers(t => t.delay === 0) // runs save_global_store -> schedules save_local_store + runs _on_global_store_change
  expect(order).toEqual(['global'])
  expect(h.localWrites).toEqual([])
  await h.fireTimers(t => t.delay === 0) // runs save_local_store once with both values together
  expect(h.localWrites).toEqual([
    {
      key: 'mindpage_item_store_doc_anon',
      value: { _anonymous_global_store: { setting: 1 }, derived: 'from-global' },
    },
  ])
  expect(order).toEqual(['global', 'local'])
})

test('reading _global_store on an anonymous item does not schedule save_local_store while global_store still autosaves', async () => {
  const h = createHarness({ anonymous: true, initialized: true })
  h.localMap.set('mindpage_item_store_doc_read', JSON.stringify({ _anonymous_global_store: { x: 7 } }))
  const { raw, api } = h.addItem('anon_read', 'doc_read')
  expect(api._global_store).toEqual({ x: 7 })
  expect(raw.tasks?.save_local_store).toBeUndefined()
  expect(raw.tasks?.save_global_store).toBeUndefined()
  expect(h.timers).toHaveLength(0)

  expect(api.global_store).toEqual({ x: 7 })
  expect(raw.tasks?.save_global_store).toBeTruthy()
})

test('waking two parked stores on one unsaved anonymous item keeps the order their retries parked (global first)', async () => {
  const h = createHarness({ anonymous: true, initialized: true })
  const { raw, api } = h.addItem('anon_both_g_first', null)
  const events: Array<{ type: string; snapshot?: any }> = []
  h.listeners.set('anon_both_g_first', {
    global: () => {
      events.push({ type: 'global' })
      api.local_store.derived = 'from-global'
    },
    local: () => {
      events.push({ type: 'local', snapshot: JSON.parse(h.localMap.get('mindpage_item_store_doc_g_first') || 'null') })
    },
  })

  api.global_store.setting = 1
  await h.fireTimers(t => t.delay === 0)
  api.local_store.direct = 'ok'
  await h.fireTimers(t => t.delay === 0)
  expect(h.timers.filter(t => !t.fired && t.delay === 1000)).toHaveLength(2)

  // how each PARKED task ends, as item code is told (_on_done after its write, _on_cancel when replaced)
  const done: string[] = []
  const cancelled: string[] = []
  for (const name of ['save_local_store', 'save_global_store'] as const) {
    raw.tasks[name]._on_done = () => void done.push(name)
    raw.tasks[name]._on_cancel = () => void cancelled.push(name)
  }

  raw.savedId = 'doc_g_first'
  h.wakeStoreSaves(raw)
  await h.drain()
  // global retry woke first: cancelled the parked local retry via save_local_store(), ran the global
  // listener (which added derived), and scheduled one delay-0 local write; nothing persisted yet
  expect(events).toEqual([{ type: 'global' }])
  expect(h.localWrites).toEqual([])
  expect([done, cancelled], 'global completed; the parked local was replaced before writing, as on master').toEqual([['save_global_store'], ['save_local_store']])

  await h.fireTimers(t => t.delay === 0)
  const expected = { direct: 'ok', _anonymous_global_store: { setting: 1 }, derived: 'from-global' }
  expect(h.localWrites).toEqual([{ key: 'mindpage_item_store_doc_g_first', value: expected }])
  expect(events).toEqual([{ type: 'global' }, { type: 'local', snapshot: expected }])
  expect([done, cancelled]).toEqual([['save_global_store'], ['save_local_store']])

  await h.fireTimers(t => t.delay === 1000)
  expect(h.localWrites).toHaveLength(1)
  expect(events).toHaveLength(2)
  expect([done, cancelled], 'the stale 1 s timers end nothing a second time').toEqual([['save_global_store'], ['save_local_store']])
  expect(h.errors).toEqual([])
})

test('waking two parked stores on one unsaved anonymous item keeps the order their retries parked (local first)', async () => {
  const h = createHarness({ anonymous: true, initialized: true })
  const { raw, api } = h.addItem('anon_both_l_first', null)
  const events: Array<{ type: string; snapshot?: any }> = []
  h.listeners.set('anon_both_l_first', {
    global: () => {
      events.push({ type: 'global' })
      api.local_store.derived = 'from-global'
    },
    local: () => {
      events.push({ type: 'local', snapshot: JSON.parse(h.localMap.get('mindpage_item_store_doc_l_first') || 'null') })
    },
  })

  api.local_store.direct = 'ok'
  await h.fireTimers(t => t.delay === 0)
  api.global_store.setting = 1
  await h.fireTimers(t => t.delay === 0)
  expect(h.timers.filter(t => !t.fired && t.delay === 1000)).toHaveLength(2)

  // how each PARKED task ends, as item code is told (_on_done after its write, _on_cancel when replaced)
  const done: string[] = []
  const cancelled: string[] = []
  for (const name of ['save_local_store', 'save_global_store'] as const) {
    raw.tasks[name]._on_done = () => void done.push(name)
    raw.tasks[name]._on_cancel = () => void cancelled.push(name)
  }

  raw.savedId = 'doc_l_first'
  h.wakeStoreSaves(raw)
  await h.drain()
  // local retry woke first: it wrote the direct field, notified the local listener and COMPLETED
  // (_on_done, as on master's separately fired timers) before the global retry starts in a turn of its own
  expect(h.localWrites).toEqual([{ key: 'mindpage_item_store_doc_l_first', value: { direct: 'ok' } }])
  expect([done, cancelled], 'the local write succeeded, so its task is done, not cancelled').toEqual([['save_local_store'], []])
  expect(events).toEqual([{ type: 'local', snapshot: { direct: 'ok' } }])

  // the global retry's own zero-delay turn: it runs the global listener and schedules a follow-up
  // local write with both _anonymous_global_store and derived
  await h.fireTimers(t => t.delay === 0)
  expect(events).toEqual([{ type: 'local', snapshot: { direct: 'ok' } }, { type: 'global' }])
  expect([done, cancelled]).toEqual([['save_local_store', 'save_global_store'], []])

  await h.fireTimers(t => t.delay === 0)
  const expected = { direct: 'ok', _anonymous_global_store: { setting: 1 }, derived: 'from-global' }
  expect(h.localWrites).toEqual([
    { key: 'mindpage_item_store_doc_l_first', value: { direct: 'ok' } },
    { key: 'mindpage_item_store_doc_l_first', value: expected },
  ])
  expect(events).toEqual([
    { type: 'local', snapshot: { direct: 'ok' } },
    { type: 'global' },
    { type: 'local', snapshot: expected },
  ])

  await h.fireTimers(t => t.delay === 1000)
  expect(h.localWrites).toHaveLength(2)
  expect(events).toHaveLength(3)
  expect(h.errors).toEqual([])
})

test('signed-in startup: save_global_store reschedules without error when its run fires before initialized, then writes once after', async () => {
  const h = createHarness({ anonymous: false, initialized: false })
  const { raw, api } = h.addItem('preinit_timer', null)
  api._global_store.fromInit = 1
  api.save_global_store({ delay: 0 })
  await h.fireTimers(t => t.delay === 0)
  expect(h.timers.filter(t => !t.fired && t.delay === 1000)).toHaveLength(1)

  const retryTask = raw.tasks.save_global_store
  let errCount = 0
  let doneCount = 0
  let doneStack: string[] = []
  retryTask._on_error = () => void errCount++
  retryTask._on_done = () => {
    doneCount++
    doneStack = h.evalStack.slice()
  }

  // savedId arrives while initialized is false; wakeStoreSaves passes it over
  raw.savedId = 'doc_preinit'
  h.wakeStoreSaves(raw)
  await h.drain()
  expect(h.hiddenWrites).toEqual([])
  expect(raw.tasks.save_global_store).toBe(retryTask)

  // the 1 s retry timer fires BEFORE initialization finishes: must reschedule itself without throwing
  await h.fireTimers(t => t.delay === 1000)
  expect(h.errors).toEqual([])
  expect(errCount).toBe(0)
  expect(h.hiddenWrites).toEqual([])
  expect(doneCount).toBe(0)
  expect(raw.tasks.save_global_store).toBe(retryTask)
  expect(h.timers.filter(t => !t.fired && t.delay === 1000)).toHaveLength(1)

  // after initialization finishes, the next 1 s run writes the store once and runs _on_done once
  h.setInitialized(true)
  await h.fireTimers(t => t.delay === 1000)
  expect(h.hiddenWrites).toEqual([{ name: 'global_store_doc_preinit', value: { fromInit: 1 } }])
  expect(doneCount).toBe(1)
  expect(doneStack).toEqual(['preinit_timer'])
  expect(errCount).toBe(0)
  expect(h.errors).toEqual([])
  expect(raw.tasks.save_global_store).toBeUndefined()

  // also covers savedId arriving before the initial zero-delay task runs while initialized is false
  const h2 = createHarness({ anonymous: false, initialized: false })
  const { raw: raw2, api: api2 } = h2.addItem('early_id_preinit', null)
  api2._global_store.early = 2
  api2.save_global_store({ delay: 0 })
  const initTask = raw2.tasks.save_global_store
  let done2 = 0
  let err2 = 0
  initTask._on_done = () => void done2++
  initTask._on_error = () => void err2++

  raw2.savedId = 'doc_early'
  await h2.fireTimers(t => t.delay === 0)
  expect(h2.errors).toEqual([])
  expect(err2).toBe(0)
  expect(h2.hiddenWrites).toEqual([])
  expect(done2).toBe(0)
  expect(raw2.tasks.save_global_store).toBe(initTask)
  expect(h2.timers.filter(t => !t.fired && t.delay === 1000)).toHaveLength(1)

  h2.setInitialized(true)
  await h2.fireTimers(t => t.delay === 1000)
  expect(h2.hiddenWrites).toEqual([{ name: 'global_store_doc_early', value: { early: 2 } }])
  expect(done2).toBe(1)
  expect(err2).toBe(0)
  expect(h2.errors).toEqual([])
  expect(raw2.tasks.save_global_store).toBeUndefined()
})
