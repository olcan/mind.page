import { expect, test } from '@playwright/test'
import { createHiddenIngress, type Apply, type Outcome } from '../../src/hidden_ingress.js'

// STAGE 2 of the hidden ingress coordinator (see notes/design/mind_page_hidden_ingress_coordinator
// in the vault repo, revision 10): the PURE schedules, with literal ids and ciphers, exact
// handles, deferred Apply closures, and no real timers. synchronization is DeliveryHandle.done and
// AuthorityLease.done — never microtask-count loops. one fresh coordinator per test.

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

// an Apply gated on a deferred: resolve applies, reject blocks. `started` resolves at the
// closure's ENTRY, so tests synchronize on the application actually running — never on a guessed
// number of microtask turns
function gatedApply() {
  const gate = deferred()
  const started = deferred()
  const runs: number[] = []
  const apply: Apply = () => {
    runs.push(runs.length + 1)
    started.resolve()
    return gate.promise
  }
  return { gate, started, runs, apply }
}

const applied: Apply = () => Promise.resolve()
const failing: Apply = () => Promise.reject(new Error('application failed'))

// ---- delivery lifecycle and the receipt-reserved tail ----

test('S2 ready before S1, but applications still run S1 then S2', async () => {
  const c = createHiddenIngress()
  const order: string[] = []
  const s1 = c.open('d')
  const s2 = c.open('d')
  // S2 becomes ready FIRST; its slot still waits behind S1's reserved slot
  s2.ready(() => ((order.push('s2'), Promise.resolve()) as any))
  s1.ready(() => ((order.push('s1'), Promise.resolve()) as any))
  expect(await s1.done).toBe('applied')
  expect(await s2.done).toBe('applied')
  expect(order).toEqual(['s1', 's2'])
})

test('a rejecting Apply blocks that same handle', async () => {
  const c = createHiddenIngress()
  const h = c.open('d', 'cipher-1')
  h.ready(failing)
  expect(await h.done).toBe('blocked')
  expect(c.gate()).toBe('blocked')
  expect(c.hasOutstanding('d'), 'the block is retained').toBe(true)
})

test('S1 blocks, then strictly higher same-cell S2 applied heals it', async () => {
  const c = createHiddenIngress()
  const s1 = c.open('d')
  s1.ready(failing)
  expect(await s1.done).toBe('blocked')
  const s2 = c.open('d')
  s2.ready(applied)
  expect(await s2.done).toBe('applied')
  expect(c.gate(), 'healed').toBe('writable')
  expect(c.hasOutstanding('d'), 'the healed block is gone, the success is pruned').toBe(false)
})

test("S3 blocks after S2 was received; S2's later success does NOT heal newer S3", async () => {
  const c = createHiddenIngress()
  const s2gate = gatedApply()
  const s2 = c.open('d')
  const s3 = c.open('d')
  s2.ready(s2gate.apply)
  s3.ready(failing) // S3 will block once its slot runs (behind S2)
  s2gate.gate.resolve() // S2 succeeds AFTER S3 was received
  expect(await s2.done).toBe('applied')
  expect(await s3.done).toBe('blocked')
  expect(c.gate(), 'the NEWER block survives an older success').toBe('blocked')
})

test('a success in an UNRELATED cell heals nothing', async () => {
  const c = createHiddenIngress()
  const bad = c.open('d1')
  bad.ready(failing)
  expect(await bad.done).toBe('blocked')
  const other = c.open('d2')
  other.ready(applied)
  expect(await other.done).toBe('applied')
  expect(c.gate(), 'the d1 block still gates').toBe('blocked')
  expect(c.hasOutstanding('d1')).toBe(true)
})

test('a duplicate delivery invokes its WHOLE Apply closure; only its newer success heals', async () => {
  const c = createHiddenIngress()
  const s1 = c.open('d')
  s1.ready(failing)
  expect(await s1.done).toBe('blocked')
  // the redelivery is a NEW delivery with its own full closure — the coordinator never treats it
  // as already done
  let reran = 0
  const s2 = c.open('d')
  s2.ready(() => ((reran++, Promise.resolve()) as any))
  expect(await s2.done).toBe('applied')
  expect(reran, 'the complete repair ran').toBe(1)
  expect(c.gate()).toBe('writable')
})

// ---- abort ownership (compare-and-set on the exact handle) ----

test('block() before a late ready(): the ready no-ops', async () => {
  const c = createHiddenIngress()
  const h = c.open('d')
  let ran = false
  // block and ready in the SAME synchronous turn: the reserved slot has not consumed its release
  // yet, so only the phase CAS keeps the late closure from running when it does
  h.block()
  h.ready(() => ((ran = true), Promise.resolve()) as any)
  expect(await h.done).toBe('blocked')
  // drive the tail past the blocked slot, then prove the closure stayed dead
  const next = c.open('d')
  next.ready(applied)
  expect(await next.done).toBe('applied')
  expect(ran, 'the late closure never runs').toBe(false)
  expect(c.gate(), 'healed normally; a phase corrupted to ready would read pending').toBe('writable')
})

test('block() while its Apply is RUNNING is a no-op: the Apply result owns done', async () => {
  const c = createHiddenIngress()
  const g = gatedApply()
  const h = c.open('d')
  h.ready(g.apply)
  await g.started.promise // the application is RUNNING now
  expect(g.runs, 'running').toEqual([1])
  h.block() // must not terminalize a running application
  g.gate.resolve()
  expect(await h.done, 'the Apply result, not the block').toBe('applied')
  expect(c.gate()).toBe('writable')
})

test('blocking a ready handle behind an older running slot: its closure no-ops AND the tail settles', async () => {
  const c = createHiddenIngress()
  const g = gatedApply()
  const s1 = c.open('d')
  const s2 = c.open('d')
  s1.ready(g.apply)
  let s2ran = false
  s2.ready(() => ((s2ran = true), Promise.resolve()) as any)
  s2.block() // aborted while queued behind running S1
  expect(await s2.done).toBe('blocked')
  g.gate.resolve()
  expect(await s1.done).toBe('applied')
  expect(s2ran, 'the cancelled closure never ran').toBe(false)
  // the tail is NOT stuck: a third delivery still runs and settles
  const s3 = c.open('d')
  s3.ready(applied)
  expect(await s3.done, "the blocked handle's reserved slot settled rather than sticking").toBe('applied')
  expect(c.gate(), 'S3 healed the S2 block').toBe('writable')
})

test("READY-ABORT under the global gate: S1 running, S2 ready then blocked, S1 applied and pruned — S2's block still gates", async () => {
  const c = createHiddenIngress()
  const g = gatedApply()
  const s1 = c.open('d')
  const s2 = c.open('d')
  s1.ready(g.apply)
  s2.ready(applied)
  s2.block()
  expect(await s2.done).toBe('blocked')
  g.gate.resolve()
  expect(await s1.done).toBe('applied')
  // S1's success is OLDER than the S2 block: it heals nothing, and the retained block gates every
  // writer globally with no reliance on names the aborted slot never captured
  expect(c.gate()).toBe('blocked')
  expect(c.hasOutstanding('d')).toBe(true)
})

test('overlapping handles for ONE id: terminalizing one never touches the other', async () => {
  const c = createHiddenIngress()
  const a = c.open('d')
  const b = c.open('d')
  b.block() // the handle is the address: no lookup can confuse a and b
  expect(await b.done).toBe('blocked')
  a.ready(applied)
  expect(await a.done, 'a is untouched by b.block()').toBe('applied')
  // a's success is OLDER (lower seq) than b's block: the block survives
  expect(c.gate()).toBe('blocked')
})

// ---- the gate ----

test('gate precedence: blocked > pending > writable; an open handle counts as pending', async () => {
  const c = createHiddenIngress()
  expect(c.gate(), 'empty coordinator').toBe('writable')
  const open = c.open('d1') // undecoded: open
  expect(c.gate(), 'an open (undecoded) delivery is pending').toBe('pending')
  const bad = c.open('d2')
  bad.ready(failing)
  expect(await bad.done).toBe('blocked')
  expect(c.gate(), 'blocked dominates the still-open d1').toBe('blocked')
  open.ready(applied)
  expect(await open.done).toBe('applied')
  expect(c.gate(), 'the unhealed d2 block still dominates').toBe('blocked')
})

test('a decrypt failure is the SAME handle becoming blocked — no transient writable window', async () => {
  const c = createHiddenIngress()
  const h = c.open('d', 'cipher-x')
  expect(c.gate()).toBe('pending')
  // the listener's decrypt fails: it blocks THAT handle; the gate goes pending -> blocked with no
  // writable in between (one delivery transition, no frontier/cell atomicity gap)
  h.block()
  expect(c.gate()).toBe('blocked')
})

test('hasOutstanding: nonterminal true, retained block true, healed false — while the cell persists', async () => {
  const c = createHiddenIngress()
  expect(c.hasOutstanding('d'), 'no cell yet').toBe(false)
  const h = c.open('d')
  expect(c.hasOutstanding('d'), 'open').toBe(true)
  h.ready(failing)
  expect(await h.done).toBe('blocked')
  expect(c.hasOutstanding('d'), 'retained block').toBe(true)
  const heal = c.open('d')
  heal.ready(applied)
  expect(await heal.done).toBe('applied')
  expect(c.hasOutstanding('d'), 'healed and pruned').toBe(false)
  expect(c.receiptFrontier('d'), 'the cell persists: the frontier survives').toBe(2)
})

// ---- waits ----

test('whenActionable delivers writable and blocked, never pending; whenWritable only writable', async () => {
  const c = createHiddenIngress()
  expect(await c.whenActionable().promise, 'immediate on an empty coordinator').toBe('writable')

  const h = c.open('d')
  const actionable = c.whenActionable()
  const writable = c.whenWritable()
  let actionableResolved: string | undefined
  let writableResolved = false
  void actionable.promise.then(g => (actionableResolved = g))
  void writable.promise.then(() => (writableResolved = true))
  await Promise.resolve()
  expect(actionableResolved, 'pending resolves neither').toBe(undefined)

  h.ready(failing) // pending -> blocked
  expect(await h.done).toBe('blocked')
  await Promise.resolve()
  expect(actionableResolved, 'blocked IS deliverable to the initial wait').toBe('blocked')
  expect(writableResolved, 'the healing wait ignores blocked').toBe(false)

  const heal = c.open('d')
  heal.ready(applied)
  expect(await heal.done).toBe('applied')
  await Promise.resolve()
  expect(writableResolved, 'the healing wait resolves on writable').toBe(true)
})

test('whenActionable while already blocked resolves immediately; whenWritable does not', async () => {
  const c = createHiddenIngress()
  const h = c.open('d')
  h.ready(failing)
  expect(await h.done).toBe('blocked')
  expect(await c.whenActionable().promise, 'level-triggered').toBe('blocked')
  let resolved = false
  void c.whenWritable().promise.then(() => (resolved = true))
  await Promise.resolve()
  expect(resolved, 'writable-only keeps waiting while blocked — no immediate spin').toBe(false)
})

test('a wait cancelled while pending ignores every later transition', async () => {
  const c = createHiddenIngress()
  const h = c.open('d')
  const sub = c.whenActionable()
  let resolved = false
  void sub.promise.then(() => (resolved = true))
  sub.cancel()
  h.ready(applied)
  expect(await h.done).toBe('applied')
  await Promise.resolve()
  expect(resolved, 'cancelled: never resolves').toBe(false)
})

// ---- pruning and compaction ----

test('a blocked delivery is compacted after its echo waiter resolves, and later healing still works', async () => {
  const c = createHiddenIngress()
  const echo = c.armEcho('d', 'cipher-w')
  const h = c.open('d', 'cipher-w')
  h.ready(failing)
  expect(await h.done).toBe('blocked')
  // the echo resolved FIRST (as blocked), from the matching handle's terminal outcome
  expect(await echo.promise).toBe('blocked')
  // the observable half of compaction: the retained block still heals normally afterward. that
  // the cipher/apply references were cleared is reviewed at the two clearing assignments — a
  // behavioral test cannot prove a reference was dropped
  const heal = c.open('d')
  heal.ready(applied)
  expect(await heal.done).toBe('applied')
  expect(c.gate()).toBe('writable')
})

// ---- the echo frontier ----

test('an older matching cipher already open when a waiter is armed does not satisfy it', async () => {
  const c = createHiddenIngress()
  const older = c.open('d', 'cipher-w') // already open BEFORE arming
  const echo = c.armEcho('d', 'cipher-w')
  let resolved: Outcome | undefined
  void echo.promise.then(o => (resolved = o))
  older.ready(applied)
  expect(await older.done).toBe('applied')
  await Promise.resolve()
  expect(resolved, 'seq <= minSeq: not our echo').toBe(undefined)
  // a STRICTLY LATER matching delivery does satisfy it
  const later = c.open('d', 'cipher-w')
  later.ready(applied)
  expect(await later.done).toBe('applied')
  expect(await echo.promise).toBe('applied')
})

test('a cancelled echo waiter ignores a later match; a non-matching cipher never resolves it', async () => {
  const c = createHiddenIngress()
  const echo = c.armEcho('d', 'cipher-w')
  let resolved = false
  void echo.promise.then(() => (resolved = true))
  echo.cancel()
  const match = c.open('d', 'cipher-w')
  match.ready(applied)
  expect(await match.done).toBe('applied')
  const other = c.armEcho('d', 'cipher-w')
  const wrong = c.open('d', 'cipher-OTHER')
  wrong.ready(applied)
  expect(await wrong.done).toBe('applied')
  await Promise.resolve()
  expect(resolved, 'cancelled stays silent').toBe(false)
  let otherResolved = false
  void other.promise.then(() => (otherResolved = true))
  await Promise.resolve()
  expect(otherResolved, 'a different cipher is not this echo').toBe(false)
})

test('arming an echo neither advances the frontier nor allocates a cell', async () => {
  const c = createHiddenIngress()
  const sub = c.armEcho('fresh', 'cipher-w')
  expect(c.receiptFrontier('fresh'), 'zero sentinel: no cell was allocated').toBe(0)
  expect(c.hasOutstanding('fresh')).toBe(false)
  expect(c.gate(), 'and the gate is untouched').toBe('writable')
  sub.cancel() // a synchronously-failed SDK call cancels; nothing leaks
})

// ---- authority ----

test('an empty coordinator: writable gate, UNUSABLE authority (zero sentinels)', async () => {
  const c = createHiddenIngress()
  expect(c.gate()).toBe('writable')
  expect(c.authorityUsable()).toBe(false)
})

test('a sealed candidate makes authority usable; the equality row: own-receipt revoke then seal never does', async () => {
  const c = createHiddenIngress()
  const good = c.reserveAuthority(true)
  good.seal()
  await good.done
  expect(c.authorityUsable(), 'the basis advanced; the gate is writable').toBe(true)

  const c2 = createHiddenIngress()
  const lease = c2.reserveAuthority(true)
  lease.revoke() // at its OWN receipt: it revoked its own basis
  lease.seal() // settles normally...
  await lease.done
  expect(c2.gate(), 'the gate is explicitly writable, isolating the inequality').toBe('writable')
  expect(c2.authorityUsable(), 'receipt > invalidatedThrough is FALSE at equality').toBe(false)
})

test('receipt-ordered invalidation: C1 fails LATE, newer sealed C2 still makes authority usable', async () => {
  const c = createHiddenIngress()
  const c1 = c.reserveAuthority(true) // reserves first, does NOT revoke at receipt
  const c2 = c.reserveAuthority(true)
  c2.seal() // newer candidate succeeds; its ordered turn waits behind C1
  let c2done = false
  void c2.done.then(() => (c2done = true))
  await Promise.resolve()
  expect(c2done, "C2's done stays pending while C1 is unsettled").toBe(false)
  c1.fail() // C1's FIRST revocation arrives late, at receipt 1
  await c2.done
  expect(c.authorityUsable(), "C2's basis (receipt 2) survives invalidatedThrough = 1").toBe(true)
})

test('the basis survives a transient gate: usability returns when the noncandidate delivery applies', async () => {
  const c = createHiddenIngress()
  const c1 = c.reserveAuthority(true)
  // noncandidate C2 (a hasPendingWrites snapshot) has an admitted delivery still pending
  const g = gatedApply()
  const delivery = c.open('d')
  delivery.ready(g.apply)
  const c2 = c.reserveAuthority(false)
  c1.seal()
  await c1.done
  expect(c.authorityUsable(), 'suppressed by the pending delivery, but the BASIS advanced').toBe(false)
  c2.seal()
  g.gate.resolve()
  expect(await delivery.done).toBe('applied')
  expect(c.authorityUsable(), 'usable when C2 applies — no third callback needed').toBe(true)
})

test('cached policy primitives: a noncandidate that revokes invalidates; one that does not preserves the basis', async () => {
  const c = createHiddenIngress()
  const candidate = c.reserveAuthority(true)
  candidate.seal()
  await candidate.done
  expect(c.authorityUsable()).toBe(true)
  // a hasPendingWrites-shaped noncandidate: reserves, does NOT revoke, seals — basis preserved
  const overlay = c.reserveAuthority(false)
  overlay.seal()
  await overlay.done
  expect(c.authorityUsable(), 'candidate:false alone must not collapse into invalidation').toBe(true)
  // a fromCache-shaped noncandidate: revokes synchronously at receipt
  const cached = c.reserveAuthority(false)
  cached.revoke()
  expect(c.authorityUsable(), 'unusable at ITS RECEIPT').toBe(false)
  cached.seal()
  await cached.done
  expect(c.authorityUsable(), 'still unusable after its seal').toBe(false)
  // usable again only after a later eligible candidate
  const next = c.reserveAuthority(true)
  next.seal()
  await next.done
  expect(c.authorityUsable(), 'a later candidate re-establishes the basis').toBe(true)
})

test('terminal ownership: seal then late fail/revoke changes nothing; fail then late seal cannot advance', async () => {
  const c = createHiddenIngress()
  const sealed = c.reserveAuthority(true)
  sealed.seal()
  await sealed.done
  expect(c.authorityUsable()).toBe(true)
  sealed.fail() // late: a no-op
  sealed.revoke() // late: must NOT invalidate the sealed basis
  expect(c.authorityUsable(), 'usability unchanged by late terminal calls').toBe(true)

  const failed = c.reserveAuthority(true)
  failed.fail()
  failed.seal() // late: cannot advance the basis
  await failed.done
  expect(c.authorityUsable(), 'the failed lease never made authority usable').toBe(false)
  // ... and a LATER lease still progresses past it
  const later = c.reserveAuthority(true)
  later.seal()
  await later.done
  expect(c.authorityUsable(), 'the tail was not stuck behind the failed lease').toBe(true)
})

test('invalidateAuthority takes a fresh ordinal, staling every earlier basis', async () => {
  const c = createHiddenIngress()
  const lease = c.reserveAuthority(true)
  lease.seal()
  await lease.done
  expect(c.authorityUsable()).toBe(true)
  c.invalidateAuthority()
  expect(c.authorityUsable(), 'the outside revocation is newer than the basis').toBe(false)
  const next = c.reserveAuthority(true)
  next.seal()
  await next.done
  expect(c.authorityUsable(), 'and a newer candidate recovers').toBe(true)
})

test('done order: an unsettled older slot holds a sealed newer candidate, basis observable at resolution', async () => {
  const c = createHiddenIngress()
  const c1 = c.reserveAuthority(false)
  const c2 = c.reserveAuthority(true)
  c2.seal()
  let resolvedUsable: boolean | undefined
  void c2.done.then(() => (resolvedUsable = c.authorityUsable()))
  await Promise.resolve()
  await Promise.resolve()
  expect(resolvedUsable, "C2's ordered effect waits for C1").toBe(undefined)
  c1.seal()
  await c2.done
  expect(resolvedUsable, 'the basis decision was already observable when done resolved').toBe(true)
})

test('authority overtaking: an older candidate cannot make authority usable after a newer invalidation', async () => {
  const c = createHiddenIngress()
  const g = gatedApply()
  const older = c.reserveAuthority(true) // slow: will seal last
  const newer = c.reserveAuthority(false)
  newer.revoke() // a fromCache-shaped invalidation, newer by receipt
  newer.seal()
  older.seal() // the OLDER candidate finishes late
  await older.done
  await newer.done
  expect(c.authorityUsable(), 'basis (receipt 1) <= invalidatedThrough (receipt 2)').toBe(false)
  void g // unused gate silences no-unused lint in this schedule
})
