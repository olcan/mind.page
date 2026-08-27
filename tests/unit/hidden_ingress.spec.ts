import { expect, test } from '@playwright/test'
import { createHiddenIngress, type Apply, type Outcome } from '../../src/hidden_ingress.js'

// STAGE 2 of the hidden ingress coordinator (see notes/design/mind_page_hidden_ingress_coordinator
// in the vault repo, revision 13): the PURE schedules, with literal ids and ciphers, exact
// handles, deferred Apply closures, and no real timers. synchronization is DeliveryHandle.done and
// AuthorityLease.done — never microtask-count loops. one fresh coordinator per test.

// an explicit event-loop checkpoint: ONE macrotask, which drains every recursively queued
// microtask first — so any settled promise chain in the module has fully propagated, without
// coupling the assertion to today's number of tail hops (a guessed microtask count is exactly the
// failure mode that made two turns insufficient; round 44). used ONLY to assert that something
// did NOT happen — positive progress always awaits the real done promises
const checkpoint = () => new Promise<void>(res => setImmediate(res))

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

test('a higher success heals EVERY strictly older same-cell block', async () => {
  const c = createHiddenIngress()
  // TWO retained blocks: healing that stopped after the first deletion would leave the second
  // gating forever (round 44)
  const s1 = c.open('d')
  s1.ready(failing)
  expect(await s1.done).toBe('blocked')
  const s2 = c.open('d')
  s2.ready(failing)
  expect(await s2.done).toBe('blocked')
  const s3 = c.open('d')
  s3.ready(applied)
  expect(await s3.done).toBe('applied')
  expect(c.gate(), 'healed').toBe('writable')
  expect(c.hasOutstanding('d'), 'BOTH healed blocks are gone, the success is pruned').toBe(false)
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

test("a NEWER block survives an older success (ready-abort): S1 running, S2 ready then blocked, S1 applied — S2 still gates", async () => {
  // covers BOTH design labels: "S3 blocks after S2 was received; S2's later success does not heal
  // newer S3" and the ready-abort row — the newer retained block here exists BEFORE the older
  // success completes, which the deleted weaker variant never established (round 43)
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
  // frontiers are PER ID (round 45): advancing an unrelated cell must not move this one
  const unrelated = c.open('other')
  unrelated.ready(applied)
  const unrelated2 = c.open('other')
  unrelated2.ready(applied)
  const unrelated3 = c.open('other')
  unrelated3.ready(applied)
  expect(await unrelated3.done).toBe('applied')
  expect(c.receiptFrontier('other')).toBe(3)
  expect(c.receiptFrontier('d'), 'unchanged by unrelated traffic').toBe(2)
})

// ---- waits ----

test('whenActionable delivers writable and blocked, never pending; whenWritable only writable', async () => {
  const c = createHiddenIngress()
  expect(await c.whenActionable().promise, 'immediate on an empty coordinator').toBe('writable')

  const h = c.open('d')
  // TWO subscriptions per level, registered SYNCHRONOUSLY: several names wait concurrently in
  // production, and a drain that woke only one would strand an unrelated generation forever
  // (round 44)
  const actionable = c.whenActionable()
  const actionable2 = c.whenActionable()
  const writable = c.whenWritable()
  const writable2 = c.whenWritable()
  const resolved: string[] = []
  void actionable.promise.then(g => resolved.push('a1:' + g))
  void actionable2.promise.then(g => resolved.push('a2:' + g))
  void writable.promise.then(() => resolved.push('w1'))
  void writable2.promise.then(() => resolved.push('w2'))
  // ... and the transition happens in the SAME turn, before any yield: only synchronous
  // registration (no deferred push) can observe it (round 43)
  h.block()
  expect(await h.done).toBe('blocked')
  await Promise.resolve()
  expect(resolved.sort(), 'BOTH actionable waits saw blocked; the healing waits ignored it').toEqual([
    'a1:blocked',
    'a2:blocked',
  ])

  const heal = c.open('d')
  heal.ready(applied)
  expect(await heal.done).toBe('applied')
  await Promise.resolve()
  expect(resolved.sort(), 'BOTH healing waits resolved on writable').toEqual(['a1:blocked', 'a2:blocked', 'w1', 'w2'])

  // pending -> WRITABLE must wake a stored actionable wait too (round 45: a drain keyed only to
  // the blocked transition would strand a writer whose delivery simply succeeded)
  const h2 = c.open('d')
  const straight = c.whenActionable()
  let straightResolved: string | undefined
  void straight.promise.then(g => (straightResolved = g))
  h2.ready(applied)
  expect(await h2.done).toBe('applied')
  await Promise.resolve()
  expect(straightResolved, 'woken by the successful transition').toBe('writable')
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

test('a wait cancelled while pending ignores every later transition — both levels', async () => {
  const c = createHiddenIngress()
  expect(await c.whenWritable().promise, 'immediate on an initially writable coordinator').toBe(undefined)
  const h = c.open('d')
  const sub = c.whenActionable()
  let resolved = false
  void sub.promise.then(() => (resolved = true))
  sub.cancel()
  h.ready(failing) // pending -> blocked: the cancelled actionable wait must stay silent
  expect(await h.done).toBe('blocked')
  // cancel a whenWritable WHILE BLOCKED, before healing — the round-43 leak shape: the design
  // promises cancellation for both levels, and this waiter would otherwise be retained until a
  // writable that a permanently corrupt record can prevent forever
  // the sibling registers FIRST: a sloppy positional splice would remove IT rather than the
  // cancelled subscription, which registered second (round 45 mutation)
  const sibling = c.whenWritable()
  const healingWait = c.whenWritable()
  let healed = false
  let siblingHealed = false
  void healingWait.promise.then(() => (healed = true))
  void sibling.promise.then(() => (siblingHealed = true))
  healingWait.cancel()
  const heal = c.open('d')
  heal.ready(applied)
  expect(await heal.done).toBe('applied')
  await Promise.resolve()
  expect(resolved, 'cancelled actionable: never resolves').toBe(false)
  expect(healed, 'cancelled writable: never resolves either').toBe(false)
  // cancellation removed the EXACT subscription (round 45): an index-sloppy splice that removed a
  // neighbor would silence the live sibling instead
  expect(siblingHealed, 'the live sibling still resolved').toBe(true)
})

// ---- pruning and compaction ----

test('a blocked delivery is compacted after its echo waiter resolves, and later healing still works', async () => {
  const c = createHiddenIngress()
  const echo = c.armEcho('d', 'cipher-w')
  const h = c.open('d', 'cipher-w')
  // ordered observers attached BEFORE the application runs: awaiting done first would prove both
  // settle, not that the echo settles first (round 43)
  const order: string[] = []
  void echo.promise.then(() => order.push('echo'))
  void h.done.then(() => order.push('done'))
  h.ready(failing)
  expect(await h.done).toBe('blocked')
  expect(await echo.promise, 'resolved from the matching handle, as blocked').toBe('blocked')
  await Promise.resolve()
  expect(order, 'the echo resolves BEFORE done (and before compaction)').toEqual(['echo', 'done'])
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
  const echoSibling = c.armEcho('d', 'cipher-w') // FIRST, so a positional splice would hit it
  const echo = c.armEcho('d', 'cipher-w')
  let resolved = false
  let siblingOutcome: Outcome | undefined
  void echo.promise.then(() => (resolved = true))
  void echoSibling.promise.then(o => (siblingOutcome = o))
  echo.cancel()
  const match = c.open('d', 'cipher-w')
  match.ready(applied)
  // echo settlement precedes done, so ONE causal microtask after done suffices: a wrongly removed
  // sibling fails HERE immediately instead of spending the runner timeout as control flow
  expect(await match.done).toBe('applied')
  await Promise.resolve()
  expect(siblingOutcome, 'the live sibling resolved, as applied').toBe('applied')
  const other = c.armEcho('d', 'cipher-w')
  let otherResolved = false
  void other.promise.then(() => (otherResolved = true))
  // the SAME cipher under ANOTHER document id first: a cipher alone is not an exact echo
  // identity (round 44). d2's matching delivery must carry a seq ABOVE the waiter's minSeq
  // (frontiers are per-id, so a low foreign seq would be refused by the seq clause for the wrong
  // reason and mask a missing id check) — a throwaway first delivery raises it
  const filler = c.open('d2', 'cipher-unrelated')
  filler.ready(applied)
  expect(await filler.done).toBe('applied')
  const otherDoc = c.open('d2', 'cipher-w') // seq 2 > minSeq 1: only the id clause refuses this
  otherDoc.ready(applied)
  expect(await otherDoc.done).toBe('applied')
  await Promise.resolve()
  expect(otherResolved, 'a matching cipher on the WRONG id is not this echo').toBe(false)
  const wrong = c.open('d', 'cipher-OTHER')
  wrong.ready(applied)
  expect(await wrong.done).toBe('applied')
  await Promise.resolve()
  expect(resolved, 'cancelled stays silent').toBe(false)
  expect(otherResolved, 'a different cipher is not this echo either').toBe(false)
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

test('the basis survives a transient gate: pending suppresses then applies; blocked suppresses then heals', async () => {
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
  // PATH 1 (round 44's original): the gated delivery APPLIES — usability returns with no third
  // callback
  g.gate.resolve()
  expect(await delivery.done).toBe('applied')
  expect(c.authorityUsable(), 'usable when the noncandidate delivery applies').toBe(true)
  // PATH 2 (round 45): a separate delivery BLOCKS — a blocked gate suppresses too, and healing
  // restores usability
  const bad = c.open('d')
  bad.ready(failing)
  expect(await bad.done).toBe('blocked')
  expect(c.authorityUsable(), 'unusable while the gate is blocked').toBe(false)
  const heal = c.open('d')
  heal.ready(applied)
  expect(await heal.done).toBe('applied')
  expect(c.authorityUsable(), 'usable once the block heals').toBe(true)
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
  // SYNCHRONOUS revocation: fail = revoke, then settle — deferring the invalidation into the
  // tail turn would leave a stale-authority window (round 44). asserted before ANY await
  expect(c.authorityUsable(), 'unusable immediately at fail()').toBe(false)
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
  // the outside revocation CONSUMED an ordinal: without one, equality with the old basis would
  // also read unusable and this test would pass vacuously (round 43)
  expect(next.receipt, 'a fresh ordinal was taken between the two leases').toBe(lease.receipt + 2)
  next.seal()
  await next.done
  expect(c.authorityUsable(), 'and a newer candidate recovers').toBe(true)
})

test('done order: an unsettled older slot holds a sealed newer candidate; revoke() does not settle', async () => {
  const c = createHiddenIngress()
  const c1 = c.reserveAuthority(false)
  const c2 = c.reserveAuthority(true)
  c2.seal()
  let c1done = false
  let resolvedUsable: boolean | undefined
  void c1.done.then(() => (c1done = true))
  void c2.done.then(() => (resolvedUsable = c.authorityUsable()))
  // the older lease REVOKES — twice, pinning idempotence — but does NOT seal: revoke() is
  // nonterminal and must not settle the slot (round 43: a revoke that resolved settlement passed
  // every earlier row, because they always sealed in the same turn)
  c1.revoke()
  c1.revoke()
  await checkpoint()
  expect(c1done, "revoke() did not settle C1's slot").toBe(false)
  expect(resolvedUsable, "C2's ordered effect still waits for C1").toBe(undefined)
  // the BASIS waited too, not only done: advancing it directly in seal() would authorize a write
  // while the older callback is still unsettled (round 44)
  expect(c.authorityUsable(), 'the sealed basis has NOT advanced before its ordered turn').toBe(false)
  c1.seal()
  await c2.done
  expect(c1done).toBe(true)
  // C1 revoked at receipt 1; C2's basis is receipt 2 > invalidatedThrough 1 — usable, and the
  // decision was already observable when done resolved
  expect(resolvedUsable, 'the basis decision was observable at resolution').toBe(true)
})

test('authority overtaking: an older candidate cannot make authority usable after a newer invalidation', async () => {
  const c = createHiddenIngress()
  const older = c.reserveAuthority(true) // slow: will seal last
  const newer = c.reserveAuthority(false)
  newer.revoke() // a fromCache-shaped invalidation, newer by receipt
  newer.seal()
  older.seal() // the OLDER candidate finishes late
  await older.done
  await newer.done
  expect(c.authorityUsable(), 'basis (receipt 1) <= invalidatedThrough (receipt 2)').toBe(false)
})

// ---- the ADAPTER's callback finalizer (round 58) ----
// these model the production applyTask lifecycle in index.svelte, which arrive() in
// hidden_persistence.spec.ts deliberately omits — and which is where the defect lived. one
// callback: open a handle per admitted document, hand SOME of them an Apply, then sweep. the
// applications are awaited DETACHED, so the sweep runs while a handed-off slot may still be
// queued behind an older same-id one

// the finalizer as it must behave: block only what was never handed off
function finalize(handles: Array<{ handle: any; handedOff: boolean }>) {
  for (const { handle, handedOff } of handles) if (!handedOff) handle.block()
}

test('the callback finalizer does NOT abort a handed-off delivery still queued behind an older same-id slot', async () => {
  const c = createHiddenIngress()
  const g1 = gatedApply()
  // callback A opens and hands off S1 for id `d`; its application is held
  const s1 = c.open('d', 'cipher1')
  s1.ready(g1.apply)
  finalize([{ handle: s1, handedOff: true }])
  await g1.started.promise
  // callback B opens S2 for the SAME id. its Apply is handed off, but the slot is queued behind
  // running S1, so it is still `ready` — not `running` — when B's task returns and sweeps
  let s2ran = false
  const s2 = c.open('d', 'cipher2')
  s2.ready(() => ((s2ran = true), Promise.resolve()) as any)
  finalize([{ handle: s2, handedOff: true }])
  g1.gate.resolve()
  expect(await s1.done).toBe('applied')
  expect(await s2.done, 'the handed-off slot ran on its turn').toBe('applied')
  expect(s2ran, 'its body actually ran').toBe(true)
  expect(c.gate(), 'no retained block').toBe('writable')
})

test('the callback finalizer still blocks a handle that was never handed off', async () => {
  const c = createHiddenIngress()
  // an admitted document whose change took an early return: no Apply was ever produced for it
  const abandoned = c.open('d', 'cipher1')
  expect(c.gate(), 'open makes writers wait').toBe('pending')
  finalize([{ handle: abandoned, handedOff: false }])
  expect(await abandoned.done).toBe('blocked')
  expect(c.gate(), 'a retained block gates every writer').toBe('blocked')
})

test('a mixed callback sweeps only the abandoned handle, and a later success heals it', async () => {
  const c = createHiddenIngress()
  const handedOffHandle = c.open('d1', 'cipher1')
  handedOffHandle.ready(applied)
  const abandoned = c.open('d2', 'cipher2')
  finalize([
    { handle: handedOffHandle, handedOff: true },
    { handle: abandoned, handedOff: false },
  ])
  expect(await handedOffHandle.done).toBe('applied')
  expect(await abandoned.done).toBe('blocked')
  expect(c.gate(), "d2's block dominates").toBe('blocked')
  // healing is per CELL: only a higher delivery for d2 clears it
  const heal = c.open('d2', 'cipher3')
  heal.ready(applied)
  expect(await heal.done).toBe('applied')
  expect(c.gate(), 'healed').toBe('writable')
})
