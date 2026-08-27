// the hidden INGRESS COORDINATOR — stage 2 of the design in the vault repo,
// notes/design/mind_page_hidden_ingress_coordinator.md (revision 10, cleared by review round 42).
// that document is normative; this module implements it and adds nothing beyond it.
//
// PURE and wired to nothing: no firestore, no index, no owner, no crypto. the listener will feed
// it deliveries and the writer will consume its gate, waits, echo waiters and authority in the
// stage-3 cutover. every schedule in the design's "Stage 2" list is pinned in
// tests/unit/hidden_ingress.spec.ts.
//
// what it replaces (at cutover, not before): the one-slot `receipts` map, `hiddenApplyOk`, the
// timer requeue and the dirty-sequence authority — one replaceable slot per document id stood for
// every delivery received, the latest decoded state and the application lifecycle at once, which
// is the root of the remaining ingress defects.

// RESOLVE = applied, REJECT = blocked. there is no third answer (no 'irrelevant': a redelivery
// must rerun the complete idempotent repair before it may heal an older partial-application block)
export type Apply = () => Promise<void>
export type Outcome = 'applied' | 'blocked'
type Phase = 'open' | 'ready' | 'running' | 'terminal'

// EVERY lifecycle operation targets an EXACT delivery through this handle: bare operations looked
// up by document id would recreate the precise mistake this coordinator removes — with
// overlapping deliveries for one id, terminalizing whichever one a lookup finds
export type DeliveryHandle = {
  // CAS on THIS handle's phase (open -> ready); rejection of `apply` blocks THIS handle
  ready(apply: Apply): void
  // abort path: CAS open|ready -> terminal blocked; a no-op on running (the Apply result owns
  // `done`) and on terminal
  block(): void
  // fulfills exactly once, with this delivery's terminal outcome
  done: Promise<Outcome>
}

export type Gate = 'blocked' | 'pending' | 'writable'

// a cancellable wait. cancellation while PENDING makes the promise never resolve; it cannot undo
// an already-resolved immediate subscription, so consumers still recheck their generation on
// continuation
export type Subscription<T> = { promise: Promise<T>; cancel(): void }

export type AuthorityLease = {
  // monotonic callback receipt ordinal. real ordinals start ABOVE zero: zero is the sentinel for
  // both the basis and the invalidation frontier, so an empty coordinator has a writable delivery
  // gate but UNUSABLE authority
  readonly receipt: number
  // fulfills exactly once, after the lease has terminalized, reached its receipt-ordered turn,
  // and had its ordered effect consumed — for a sealed candidate, any basis advance happens
  // BEFORE done resolves. revoke() cannot resolve it; late terminal calls share it
  readonly done: Promise<void>
  // NONTERMINAL and state-idempotent: invalidatedThrough = max(invalidatedThrough, receipt).
  // a no-op after seal() — it must not invalidate the sealed basis
  revoke(): void
  // settles the slot successfully; a sealed CANDIDATE advances the basis in its ordered turn
  seal(): void
  // revokes, then settles unsuccessfully
  fail(): void
}

type Delivery = {
  seq: number
  phase: Phase
  cipher?: string
  outcome?: Outcome
  apply?: Apply
  // resolves the reserved tail slot: ready() hands it the closure, block() hands it nothing
  release?: () => void
  resolveDone: (outcome: Outcome) => void
}

type Cell = {
  // OPEN work and UNHEALED blocks only: successful deliveries are pruned at their terminal
  // transition (nothing needs them afterward), and blocked ones are retained for healing but
  // COMPACTED — apply and cipher cleared once their echo waiters resolve
  deliveries: Map<number, Delivery>
  // the RECEIPT FRONTIER: advanced by every open(); echo arming and writer staleness both compare
  // it. there is no separate version counter — a writer can capture only while the gate is
  // writable, so every later relevant change begins with a new open()
  lastSeq: number
  tail: Promise<void> // application order; each slot reserved at RECEIPT
}

type EchoWaiter = {
  id: string
  cipher: string
  minSeq: number // armed against the per-id receipt frontier: an older already-open matching
  // cipher must not satisfy a newly armed waiter
  resolve: (outcome: Outcome) => void
}

type Waiter<T> = { resolve: (value: T) => void }

export function createHiddenIngress() {
  // cells persist for the page lifetime once created: proving no writer or waiter still
  // references one just to reference-count and recreate it would be needless ABA machinery.
  // inspection (receiptFrontier, hasOutstanding) and echo arming deliberately NEVER allocate
  const cells = new Map<string, Cell>()
  const echoWaiters: EchoWaiter[] = []
  const actionableWaiters: Waiter<Gate>[] = []
  const writableWaiters: Waiter<void>[] = []

  // ---- authority state (receipt-ordered; see the design's Authority section) ----
  let receiptSeq = 0
  let authorityBasisReceipt = 0
  let invalidatedThrough = 0
  let authorityTail: Promise<void> = Promise.resolve()

  // ---- the gate, derived by scanning cells (no cached counters without a measured problem) ----
  function gate(): Gate {
    let pending = false
    for (const cell of cells.values())
      for (const d of cell.deliveries.values()) {
        if (d.outcome == 'blocked') return 'blocked' // blocked dominates
        if (d.phase != 'terminal') pending = true
      }
    return pending ? 'pending' : 'writable'
  }

  // true while a handle for `id` is nonterminal OR a terminal block is retained; false again once
  // a higher success heals it — even though the empty cell persists
  const hasOutstanding = (id: string) => (cells.get(id)?.deliveries.size ?? 0) > 0

  // the per-id receipt frontier; zero sentinel for an absent id, and NO cell allocation
  const receiptFrontier = (id: string) => cells.get(id)?.lastSeq ?? 0

  // level-triggered notification: every mutation resolves exactly the waiter levels its resulting
  // gate satisfies. single-threaded, so there is no interleaving point between a wait's own
  // synchronous gate check and its insertion — no numeric epoch is needed
  function notifyWaiters() {
    const g = gate()
    if (g == 'pending') return
    for (const w of actionableWaiters.splice(0)) w.resolve(g)
    if (g == 'writable') for (const w of writableWaiters.splice(0)) w.resolve()
  }

  function settleEchoWaiters(delivery: Delivery, id: string) {
    if (delivery.cipher === undefined) return // no ciphertext, no echo (removals, transitions)
    for (let i = echoWaiters.length - 1; i >= 0; i--) {
      const w = echoWaiters[i]
      if (w.id !== id || w.cipher !== delivery.cipher || delivery.seq <= w.minSeq) continue
      echoWaiters.splice(i, 1)
      w.resolve(delivery.outcome!)
    }
  }

  // one path publishes every terminal outcome: CAS to terminal happened at the caller, this
  // finishes it — echo waiters first (a blocked delivery is compacted only AFTER they resolve),
  // then healing/pruning/compaction, then done, then the gate waiters
  function finalize(cell: Cell, id: string, delivery: Delivery, outcome: Outcome) {
    delivery.outcome = outcome
    settleEchoWaiters(delivery, id)
    if (outcome == 'applied') {
      // heal STRICTLY OLDER same-cell blocks, then prune this delivery: healing compares seq and
      // the echo waiter holds its own result, so no future operation needs it
      for (const [seq, d] of cell.deliveries) if (seq < delivery.seq && d.outcome == 'blocked') cell.deliveries.delete(seq)
      cell.deliveries.delete(delivery.seq)
    } else {
      // retained for healing, COMPACTED: a permanent corrupt record must not hold a listener
      // closure and ciphertext until reload. healing needs only seq and outcome
      delivery.apply = undefined
      delivery.cipher = undefined
    }
    delivery.resolveDone(outcome)
    notifyWaiters()
  }

  function open(id: string, cipher?: string): DeliveryHandle {
    let cell = cells.get(id)
    if (!cell) cells.set(id, (cell = { deliveries: new Map(), lastSeq: 0, tail: Promise.resolve() }))
    const seq = ++cell.lastSeq
    let resolveDone!: (outcome: Outcome) => void
    const done = new Promise<Outcome>(res => (resolveDone = res))
    const delivery: Delivery = { seq, phase: 'open', cipher, resolveDone }
    cell.deliveries.set(seq, delivery)
    // no waiter notification here: opening leaves the gate pending unless an existing block
    // already dominates, and neither state can satisfy a stored waiter (round 43)

    // reserve THIS delivery's application slot on the tail at receipt. the slot waits for
    // ready()/block() to release it, runs the closure if one arrived, and NEVER rejects — a
    // rejected tail would poison every later slot
    const released = new Promise<void>(res => (delivery.release = res))
    cell.tail = cell.tail.then(async () => {
      await released
      if (delivery.phase == 'terminal') return // blocked before its turn: the slot just settles
      delivery.phase = 'running'
      try {
        await delivery.apply!()
        delivery.phase = 'terminal'
        finalize(cell!, id, delivery, 'applied')
      } catch {
        delivery.phase = 'terminal'
        finalize(cell!, id, delivery, 'blocked')
      }
    })
    return {
      ready(apply: Apply) {
        if (delivery.phase != 'open') return // CAS: late ready after block() no-ops
        delivery.phase = 'ready'
        delivery.apply = apply
        delivery.release!()
      },
      block() {
        if (delivery.phase != 'open' && delivery.phase != 'ready') return // running|terminal own their outcome
        delivery.phase = 'terminal'
        delivery.apply = undefined
        delivery.release!() // the reserved slot settles instead of sticking forever
        finalize(cell!, id, delivery, 'blocked')
      },
      done,
    }
  }

  // ---- waits ----
  // `immediate` returns [value] when the wait should resolve NOW (level-triggered), undefined to
  // register. the one-element tuple lets void-valued waits resolve immediately without a sentinel
  // cancellation SPLICES the exact waiter out (as armEcho's does): a flag-only cancel retained
  // the waiter, its resolver, its promise and any attached save continuation until the gate next
  // satisfied its level — which a permanently corrupt record can prevent forever (round 43). with
  // removal, no cancelled flag is needed: cancellation and the synchronous splice-drain cannot
  // interleave in single-threaded JS
  function subscribe<T>(list: Waiter<T>[], immediate: () => [T] | undefined): Subscription<T> {
    const now = immediate()
    if (now) return { promise: Promise.resolve(now[0]), cancel() {} }
    const waiter: Waiter<T> = { resolve: () => {} }
    const promise = new Promise<T>(res => (waiter.resolve = res))
    list.push(waiter)
    return {
      promise,
      cancel() {
        const i = list.indexOf(waiter)
        if (i >= 0) list.splice(i, 1)
      },
    }
  }

  // the INITIAL wait: resolves when the gate is writable OR blocked (the writer's required
  // blocked behaviour — clear the saving mirror, notify once — can never run off a writable-only
  // promise); pending keeps waiting
  const whenActionable = (): Subscription<Gate> =>
    subscribe(actionableWaiters, () => {
      const g = gate()
      return g == 'pending' ? undefined : [g]
    })

  // the HEALING wait, installed once by the blocked handler: resolves only on writable. reusing
  // whenActionable while already blocked would resolve immediately and spin
  const whenWritable = (): Subscription<void> =>
    subscribe<void>(writableWaiters, () => (gate() == 'writable' ? [undefined] : undefined))

  // ---- echo ----
  // armed against the CURRENT per-id receipt frontier, immediately before the SDK call: an older
  // already-open matching cipher cannot satisfy a newly armed waiter. arming neither advances
  // lastSeq nor allocates a cell
  function armEcho(id: string, cipher: string): Subscription<Outcome> {
    const waiter: EchoWaiter = { id, cipher, minSeq: receiptFrontier(id), resolve: () => {} }
    const promise = new Promise<Outcome>(res => (waiter.resolve = res))
    echoWaiters.push(waiter)
    return {
      promise,
      cancel() {
        const i = echoWaiters.indexOf(waiter)
        if (i >= 0) echoWaiters.splice(i, 1)
      },
    }
  }

  // ---- authority ----
  function reserveAuthority(candidate: boolean): AuthorityLease {
    const receipt = ++receiptSeq
    let terminal = false
    let sealed = false
    let resolveSettled!: () => void
    const settled = new Promise<void>(res => (resolveSettled = res))
    let resolveDone!: () => void
    const done = new Promise<void>(res => (resolveDone = res))
    // the receipt-ordered settlement tail: this lease's ordered effect (a sealed candidate
    // advancing the basis) is consumed only after every earlier slot settled, and done resolves
    // only after that
    authorityTail = authorityTail.then(async () => {
      await settled
      if (sealed && candidate) authorityBasisReceipt = Math.max(authorityBasisReceipt, receipt)
      resolveDone()
    })
    return {
      receipt,
      done,
      revoke() {
        // every late operation after EITHER terminal owner is a no-op: after seal it must not
        // invalidate the sealed basis, and after fail the invalidation already happened
        if (terminal) return
        invalidatedThrough = Math.max(invalidatedThrough, receipt)
      },
      seal() {
        if (terminal) return // fail() already owns the terminal transition
        terminal = true
        sealed = true
        resolveSettled()
      },
      fail() {
        if (terminal) return // seal() already owns it: a late fail is a no-op
        terminal = true
        sealed = false
        invalidatedThrough = Math.max(invalidatedThrough, receipt)
        resolveSettled()
      },
    }
  }

  // outside-callback revocation: a FRESH ordinal, staling every earlier basis
  const invalidateAuthority = () => void (invalidatedThrough = Math.max(invalidatedThrough, ++receiptSeq))

  // usability is DERIVED, never granted at a moment: the delivery gate suppresses it transiently
  // (a noncandidate callback's admitted delivery) and restores it automatically on success, with
  // no counters, retained closures, tail-awaits or extra wakes
  const authorityUsable = () => authorityBasisReceipt > invalidatedThrough && gate() == 'writable'

  return {
    open,
    gate,
    hasOutstanding,
    receiptFrontier,
    whenActionable,
    whenWritable,
    armEcho,
    reserveAuthority,
    invalidateAuthority,
    authorityUsable,
  }
}

export type HiddenIngress = ReturnType<typeof createHiddenIngress>
