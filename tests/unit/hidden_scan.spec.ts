import { expect, test } from '@playwright/test'
import { scanHiddenDocuments, type ScanDeps } from '../../src/hidden_scan.js'
import { createRecordAllocator, type RecordHandle } from '../../src/hidden_listener_records.js'
import type { Classification } from '../../src/hidden_confirm.js'

// the composition schedules for the ONE shared hidden scan (see src/hidden_scan.ts). the record
// allocator is the REAL one production imports — the intersection rules are about actual listener
// records, and a stand-in would prove nothing about them. everything else is deferred-driven: no
// real timers, no guessed microtask counts.
//
// a blind record is HELD by simply not giving it a body: the lane awaits the handover, so an
// unfinished record's `done` stays pending, which is exactly the race these rows are about

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

// ONE macrotask, draining recursively queued microtasks first. only for negative assertions
const checkpoint = () => new Promise<void>(res => setImmediate(res))

// a coordinator handle with the same CAS contract: whichever of ready/block lands first owns the
// outcome, and `done` FULFILLS with 'blocked'
function fakeHandle() {
  const d = deferred<'applied' | 'blocked'>()
  let phase: 'open' | 'ready' | 'terminal' = 'open'
  let apply: (() => Promise<void>) | undefined
  const handle: RecordHandle = {
    ready(a) {
      if (phase != 'open') return
      phase = 'ready'
      apply = a
    },
    block() {
      if (phase == 'terminal') return
      phase = 'terminal'
      d.resolve('blocked')
    },
    done: d.promise,
  }
  return {
    handle,
    async apply() {
      if (phase != 'ready') throw new Error(`cannot apply: phase is ${phase}`)
      await apply!()
      phase = 'terminal'
      d.resolve('applied')
    },
  }
}

const hidden = (id: string, name: string): Classification => ({ kind: 'hidden', wrapper: { id, name } })
const notHidden: Classification = { kind: 'not-hidden' }
const indeterminate: Classification = { kind: 'indeterminate', reason: 'unparseable' }

function harness(
  options: {
    classify?: (id: string) => Classification
    point?: (id: string) => Classification
  } = {}
) {
  const allocator = createRecordAllocator({ onBlindError: () => {} })
  const query = deferred<{ id: string; data: unknown }[]>()
  const published: string[][] = []
  const pointReads: string[] = []
  let closes = 0
  let live = true
  const deps: ScanDeps = {
    // WRAPPED so closure is directly observable: a leaked collector retains every later record,
    // and that leak has no other public consequence to assert on
    openPrefix: () => {
      const prefix = allocator.openPrefix()
      return {
        records: () => prefix.records(),
        close: () => {
          closes++
          prefix.close()
        },
      }
    },
    queryHidden: () => query.promise,
    publishMembership: ids => void published.push([...ids]),
    assertLive: () => {
      if (!live) throw new Error('cancelled')
    },
    classify: async id => (options.classify ?? (i => hidden(i, 'n')))(id),
    pointRead: async id => {
      pointReads.push(id)
      return (options.point ?? (i => hidden(i, 'n')))(id)
    },
  }
  return {
    allocator,
    published,
    pointReads,
    closes: () => closes,
    stop: () => void (live = false),
    answerQuery: (ids: string[]) => query.resolve(ids.map(id => ({ id, data: {} }))),
    failQuery: (e: unknown) => query.reject(e),
    scan: () => scanHiddenDocuments(deps),
  }
}

test('a blind intersection is awaited, point-read once, and its answer replaces the raw row', async () => {
  const h = harness({ point: id => hidden(id, 'fresh') })
  const scan = h.scan()
  // allocated BEFORE the query answers: this is the pre-exposure race the prefix exists to close
  const batch = h.allocator.allocate([{ kind: 'blind', id: 'a' }], () => {})
  h.answerQuery(['a', 'b'])
  await checkpoint()
  expect(h.pointReads).toEqual([]) // held: its own completion comes first
  expect(h.published).toEqual([['a', 'b']])
  batch.records[0].finish()
  const result = await scan
  expect(h.pointReads).toEqual(['a'])
  expect(result.apply.map(r => `${r.id}:${r.name}`)).toEqual(['a:fresh', 'b:n'])
  expect(result.admittedIds).toEqual([])
  expect(result.skippedIds).toEqual([])
})

test('an ADMITTED intersection is reported even after its delivery has already settled', async () => {
  const h = harness()
  const scan = h.scan()
  const cell = fakeHandle()
  const batch = h.allocator.allocate([{ kind: 'admitted', id: 'a', handle: cell.handle }], () => {})
  const record = batch.records[0]
  if (record.kind != 'admitted') throw new Error('expected an admitted record')
  record.schedule(async () => {})
  await checkpoint() // the handover waits on the captured lane position
  // it SETTLES before the query even answers — precisely the case a CURRENT gate reading cannot
  // see, and the reason the admitted fact has to be historical
  await cell.apply()
  await record.done
  h.answerQuery(['a'])
  const result = await scan
  expect(result.admittedIds).toEqual(['a'])
  expect(h.pointReads).toEqual([]) // its real delivery owns the id
  expect(result.apply).toEqual([]) // and the older query answer is never applied over it
})

test('a referenced blind FAILURE rejects the scan rather than being swallowed', async () => {
  const h = harness()
  const scan = h.scan()
  const batch = h.allocator.allocate([{ kind: 'blind', id: 'a' }], () => {})
  const record = batch.records[0]
  if (record.kind != 'blind') throw new Error('expected a blind record')
  record.run(() => {
    throw new Error('boom')
  })
  h.answerQuery(['a'])
  await expect(scan).rejects.toThrow('boom')
  expect(h.pointReads).toEqual([]) // it never got as far as the point read
  expect(h.closes()).toBeGreaterThan(0)
})

test('an INDETERMINATE point answer fails closed instead of synthesizing absence', async () => {
  const h = harness({ point: () => indeterminate })
  const scan = h.scan()
  const batch = h.allocator.allocate([{ kind: 'blind', id: 'a' }], () => {})
  batch.records[0].finish()
  h.answerQuery(['a'])
  await expect(scan).rejects.toThrow('could not be classified')
})

test('a not-hidden point answer suppresses its raw row and is reported as skipped', async () => {
  const h = harness({ point: () => notHidden })
  const scan = h.scan()
  const batch = h.allocator.allocate([{ kind: 'blind', id: 'b' }], () => {})
  batch.records[0].finish()
  h.answerQuery(['a', 'b'])
  const result = await scan
  expect(result.apply.map(r => r.id)).toEqual(['a'])
  expect(result.skippedIds).toEqual(['b'])
})

test('OVERLAPPING records for one id are ONE point read, and independent ids read in parallel', async () => {
  const h = harness()
  const scan = h.scan()
  const batch = h.allocator.allocate(
    [
      { kind: 'blind', id: 'a' },
      { kind: 'blind', id: 'a' },
      { kind: 'blind', id: 'b' },
    ],
    () => {}
  )
  // 'b' is HELD; both 'a' records complete. the blind lane is strictly ordered, so 'a' is
  // released first — a per-record loop would then read 'a' TWICE and stall on 'b' in between
  batch.records.forEach(r => r.id == 'a' && r.finish())
  h.answerQuery(['a', 'b'])
  await checkpoint()
  expect(h.pointReads).toEqual(['a']) // 'a' did not wait for the unrelated held record
  batch.records.find(r => r.id == 'b')!.finish()
  await scan
  expect(h.pointReads).toEqual(['a', 'b']) // two records for 'a', one read
})

test('the prefix CLOSES on every outcome, not only a successful body continuation', async () => {
  const rejected = harness()
  const scan = rejected.scan()
  rejected.failQuery(new Error('offline'))
  await expect(scan).rejects.toThrow('offline')
  expect(rejected.closes()).toBe(1)

  const cancelled = harness()
  const scan2 = cancelled.scan()
  cancelled.stop()
  cancelled.answerQuery(['a'])
  await expect(scan2).rejects.toThrow('cancelled')
  expect(cancelled.closes()).toBe(1)

  const ok = harness()
  const scan3 = ok.scan()
  ok.answerQuery(['a'])
  await scan3
  expect(ok.closes()).toBe(1) // closed at membership, and the exit is idempotent
})

test('the prefix closes at MEMBERSHIP, so a record allocated afterwards is not point-read', async () => {
  const h = harness()
  const scan = h.scan()
  h.answerQuery(['a'])
  await checkpoint()
  // covered by corpus membership, not by the prefix: collecting it here would make every later
  // callback an intersection for the rest of the operation
  const batch = h.allocator.allocate([{ kind: 'blind', id: 'a' }], () => {})
  batch.records[0].finish()
  const result = await scan
  expect(h.pointReads).toEqual([])
  expect(result.apply.map(r => r.id)).toEqual(['a'])
})

test('an INDETERMINATE query row fails closed', async () => {
  const h = harness({ classify: id => (id == 'b' ? indeterminate : hidden(id, 'n')) })
  const scan = h.scan()
  h.answerQuery(['a', 'b'])
  await expect(scan).rejects.toThrow('could not be classified')
})

test('rows are applied in CANONICAL id order even when point reads complete out of order', async () => {
  const h = harness({ point: id => hidden(id, 'fresh') })
  const scan = h.scan()
  const batch = h.allocator.allocate(
    [
      { kind: 'blind', id: 'zz' },
      { kind: 'blind', id: 'aa' },
    ],
    () => {}
  )
  batch.records.forEach(r => r.finish())
  h.answerQuery(['zz', 'aa', 'mm'])
  const result = await scan
  expect(result.apply.map(r => r.id)).toEqual(['aa', 'mm', 'zz'])
})

test('a point answer that says HIDDEN survives a query row classified otherwise', async () => {
  // the freshest evidence wins: normalizeScan replaces BY ID, so a row the query read called
  // not-hidden has to be present for its newer point answer to replace it
  const h = harness({ classify: () => notHidden, point: id => hidden(id, 'fresh') })
  const scan = h.scan()
  const batch = h.allocator.allocate([{ kind: 'blind', id: 'a' }], () => {})
  batch.records[0].finish()
  h.answerQuery(['a'])
  const result = await scan
  expect(result.apply.map(r => `${r.id}:${r.name}`)).toEqual(['a:fresh'])
})
