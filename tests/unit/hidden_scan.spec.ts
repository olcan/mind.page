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
  const classifies: string[] = []
  let closes = 0
  let live = true
  // the corpus's ACTIVE CANCELLATION, modelled exactly as createHiddenCorpus supplies it: it never
  // fulfils and rejects when the operation is cancelled
  const cancellation = deferred<never>()
  cancellation.promise.catch(() => {}) // raced, not always observed
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
    cancellation: cancellation.promise,
    classify: async id => {
      classifies.push(id)
      return (options.classify ?? (i => hidden(i, 'n')))(id)
    },
    pointRead: async id => {
      pointReads.push(id)
      return (options.point ?? (i => hidden(i, 'n')))(id)
    },
  }
  return {
    allocator,
    published,
    pointReads,
    classifies,
    closes: () => closes,
    // the corpus's stop: it releases the caller through the active cancellation AND flips the
    // sticky bit, in that order
    stop: () => {
      live = false
      cancellation.reject(new Error('cancelled'))
    },
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

test('a not-hidden point answer SUPPRESSES its raw row, without classifying it', async () => {
  const h = harness({ point: () => notHidden })
  const scan = h.scan()
  const batch = h.allocator.allocate([{ kind: 'blind', id: 'b' }], () => {})
  batch.records[0].finish()
  h.answerQuery(['a', 'b'])
  const result = await scan
  expect(result.apply.map(r => r.id)).toEqual(['a'])
  expect(h.classifies, 'the replaced row is never classified: the point answer is the evidence').toEqual(['a'])
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

test('the prefix CLOSES on every outcome, INCLUDING while the query is still held', async () => {
  const rejected = harness()
  const scan = rejected.scan()
  rejected.failQuery(new Error('offline'))
  await expect(scan).rejects.toThrow('offline')
  expect(rejected.closes()).toBe(1)

  // THE ONE THAT MATTERS. the corpus releases the caller, the boundary and the tail through its
  // active cancellation while the network read is STILL PENDING — so a scan that only rechecks
  // between awaits never reaches its own cleanup, and its prefix collector goes on retaining every
  // later listener record, potentially for the page's lifetime
  const held = harness()
  const scan2 = held.scan()
  await checkpoint()
  expect(held.closes(), 'nothing is closed while the query is genuinely in flight').toBe(0)
  held.stop() // the query is NEVER resolved
  await expect(scan2, 'the caller is released').rejects.toThrow('cancelled')
  expect(held.closes(), 'and the prefix closed exactly once, with the query still held').toBe(1)
  // only NOW does the read come back. nothing may follow it
  held.answerQuery(['a'])
  const batch = held.allocator.allocate([{ kind: 'blind', id: 'a' }], () => {})
  batch.records[0].finish()
  await checkpoint()
  expect(held.published, 'no late membership').toEqual([])
  expect(held.pointReads, 'no late point read').toEqual([])
  expect(held.classifies, 'and no late classification').toEqual([])

  const ok = harness()
  const scan3 = ok.scan()
  ok.answerQuery(['a'])
  await scan3
  expect(ok.closes()).toBe(1) // closed at membership, and the exit is idempotent
})

test('EVIDENCE PRECEDENCE: a definitive point answer beats a stale raw row that cannot be read', async () => {
  // classifying every raw row first and filtering afterwards let stale evidence decide the whole
  // scan: an undecryptable or malformed row rejected it even though a fresh point read had already
  // said what that document definitively is
  for (const [label, point, expected] of [
    ['hidden', hidden('b', 'fresh'), ['a', 'b']],
    ['not-hidden', notHidden, ['a']],
  ] as const) {
    const h = harness({
      classify: id => {
        if (id == 'b') throw new Error('undecryptable')
        return hidden(id, 'n')
      },
      point: () => point,
    })
    const scan = h.scan()
    const batch = h.allocator.allocate([{ kind: 'blind', id: 'b' }], () => {})
    batch.records[0].finish()
    h.answerQuery(['a', 'b'])
    const result = await scan
    expect(
      result.apply.map(r => r.id),
      `${label} point answer`
    ).toEqual(expected)
    expect(h.classifies, `${label}: the replaced row was never classified`).toEqual(['a'])
  }
})

test('EVIDENCE PRECEDENCE: an ADMITTED id is never classified, however broken its stale raw row', async () => {
  // the scan already promised never to apply an admitted id — classifying it anyway let its stale
  // row reject the whole operation on behalf of a document its real delivery owns
  const h = harness({
    classify: id => {
      if (id == 'a') throw new Error('undecryptable')
      return hidden(id, 'n')
    },
  })
  const scan = h.scan()
  const cell = fakeHandle()
  const batch = h.allocator.allocate([{ kind: 'admitted', id: 'a', handle: cell.handle }], () => {})
  const record = batch.records[0]
  if (record.kind != 'admitted') throw new Error('expected an admitted record')
  record.schedule(async () => {})
  await checkpoint()
  h.answerQuery(['a', 'b'])
  const result = await scan
  expect(result.admittedIds).toEqual(['a'])
  expect(result.apply.map(r => r.id)).toEqual(['b'])
  expect(h.classifies, "the admitted id's stale row is never read").toEqual(['b'])
  await cell.apply()
})

test('an ADMITTED record owns the whole id, including a blind record for it in the same group', async () => {
  // the group is skipped as a unit and this scan will not touch that id at all, so there is nothing
  // for the blind rejection to abort — and awaiting it would add a dependency on a callback whose
  // other admitted changes may be waiting on this very scan
  const h = harness()
  const scan = h.scan()
  const cell = fakeHandle()
  const batch = h.allocator.allocate(
    [
      { kind: 'blind', id: 'a' },
      { kind: 'admitted', id: 'a', handle: cell.handle },
    ],
    () => {}
  )
  const blindRecord = batch.records[0]
  if (blindRecord.kind != 'blind') throw new Error('expected a blind record')
  blindRecord.run(() => {
    throw new Error('boom') // its failure is the listener's fail-soft concern, not this scan's
  })
  h.answerQuery(['a'])
  const result = await scan
  expect(result.admittedIds, 'the id is owned by its delivery').toEqual(['a'])
  expect(result.apply, 'and nothing is applied for it').toEqual([])
  batch.abort() // the handle never had an Apply scheduled
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
  // the freshest evidence wins outright: the point answer is consulted BEFORE the raw row is
  // classified at all, so a query row that says otherwise never gets a vote
  const h = harness({ classify: () => notHidden, point: id => hidden(id, 'fresh') })
  const scan = h.scan()
  const batch = h.allocator.allocate([{ kind: 'blind', id: 'a' }], () => {})
  batch.records[0].finish()
  h.answerQuery(['a'])
  const result = await scan
  expect(result.apply.map(r => `${r.id}:${r.name}`)).toEqual(['a:fresh'])
})
