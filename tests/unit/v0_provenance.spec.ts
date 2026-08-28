import { expect, test } from '@playwright/test'
import { createV0Provenance } from '../../src/v0_provenance.js'

// the v0 slot/provenance bookkeeping (src/v0_provenance.ts) — review 90 §§2.3-2.4's schedules,
// staged deterministically: settlement orders, the resolved-slot continuation gap, and the
// writer refusal that outlives reader authentication.

test('success then corrupt data: an authenticated candidate is never cleared by a later failure', () => {
  const p = createV0Provenance()
  p.markProvisional('B')
  expect(p.beginRead('B')!.settle('ok')).toBe('keep')
  // a later well-framed but tampered row raises a REAL authentication failure
  expect(p.beginRead('B')!.settle('auth-failed'), 'the corrupt row cannot erase a correct reader key').toBe('keep')
  expect(p.isProvisional('B'), 'still provisional (unestablished) — but retained').toBe(true)
})

test('concurrent valid and corrupt reads keep the candidate in BOTH settlement orders', () => {
  for (const order of [
    ['ok', 'auth-failed'],
    ['auth-failed', 'ok'],
  ] as const) {
    const p = createV0Provenance()
    p.markProvisional('B')
    const first = p.beginRead('B')!
    const second = p.beginRead('B')!
    expect(first.settle(order[0]), `first settle (${order[0]})`).toBe('keep')
    expect(second.settle(order[1]), `second settle (${order[1]})`).toBe('keep')
    expect(p.isProvisional('B'), `retained for order ${order.join(',')}`).toBe(true)
  }
})

test('ALL attempts failing authentication clears the candidate — on the LAST settlement', () => {
  const p = createV0Provenance()
  p.markProvisional('B')
  const a = p.beginRead('B')!
  const b = p.beginRead('B')!
  expect(a.settle('auth-failed'), 'not yet: another attempt is still open').toBe('keep')
  expect(b.settle('auth-failed'), 'last settlement decides').toBe('clear-candidate')
  expect(p.isProvisional('B')).toBe(false)
  // non-authentication errors (parser/integration) are never evidence against the candidate
  const q = createV0Provenance()
  q.markProvisional('B')
  expect(q.beginRead('B')!.settle('other')).toBe('keep')
  expect(q.isProvisional('B')).toBe(true)
})

test('lifecycle clear and establishment make OLD completions inert', () => {
  const p = createV0Provenance()
  p.markProvisional('B')
  const parked = p.beginRead('B')!
  p.established() // publishV0 landed while the read was in flight
  expect(parked.settle('auth-failed'), 'a completion for a replaced record decides nothing').toBe('keep')
  expect(p.isProvisional('B'), 'nothing provisional remains').toBe(false)

  const q = createV0Provenance()
  q.markProvisional('B')
  const parked2 = q.beginRead('B')!
  q.clear() // sign-out / principal change
  expect(parked2.settle('auth-failed')).toBe('keep')
  q.markProvisional('C') // a NEW candidate after the clear
  expect(parked2.settle('auth-failed'), 'settling twice is also inert').toBe('keep')
  expect(q.isProvisional('C'), 'the new record is untouched by the old attempt').toBe(true)
})

test('a WRITER is refused under a provisional candidate even after reader authentication', () => {
  const p = createV0Provenance()
  p.markProvisional('B')
  p.beginRead('B')!.settle('ok') // reader authenticated
  expect(
    p.guardResolved({ resolved: 'B', generationChanged: false, slotCurrent: true, forWrite: true }),
    'authenticated is not established'
  ).toBe('refuse-write')
  // establishment lifts the refusal
  p.established()
  expect(p.guardResolved({ resolved: 'B', generationChanged: false, slotCurrent: true, forWrite: true })).toBe('ok')
})

test('the RESOLVED-SLOT gap (review 90 §2.3): a cleared or superseded slot is never republished', () => {
  const p = createV0Provenance()
  // clearAllKeyState ran in the Promise.resolve continuation gap: the slot is no longer the
  // awaited flight, so the resolved B must not be assigned or returned
  expect(p.guardResolved({ resolved: 'B', generationChanged: true, slotCurrent: false, forWrite: false })).toBe(
    'superseded'
  )
  // publishV0(A) replaced the slot without a generation change: still superseded — B must not
  // overwrite the newer establishment
  expect(p.guardResolved({ resolved: 'B', generationChanged: false, slotCurrent: false, forWrite: false })).toBe(
    'superseded'
  )
  // supersession outranks the write refusal (ownership first; refusal never masks it)
  p.markProvisional('B')
  expect(p.guardResolved({ resolved: 'B', generationChanged: true, slotCurrent: true, forWrite: true })).toBe(
    'superseded'
  )
  // the reader that still owns its slot proceeds
  expect(p.guardResolved({ resolved: 'B', generationChanged: false, slotCurrent: true, forWrite: false })).toBe('ok')
})

test('beginRead ignores foreign values: only the provisional candidate is accounted', () => {
  const p = createV0Provenance()
  p.markProvisional('B')
  expect(p.beginRead('A'), 'an established/legacy value needs no accounting').toBeNull()
  expect(p.isProvisional('B')).toBe(true)
})
