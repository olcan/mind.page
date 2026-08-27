import { expect, test } from '@playwright/test'
import {
  planTargetSlice,
  normalizeScan,
  classifyHiddenDocument,
  type ClassifiedRow,
  type PointAnswer,
  type Marker,
} from '../../src/hidden_confirm.js'

// PURE tables for confirmTarget's planning (see src/hidden_confirm.ts). No timers, no promises,
// no fakes — these are decisions, and the point of extracting them is that they can be tabled

const hidden = (id: string, name: string, wrapper: unknown = { id }): ClassifiedRow => ({ id, kind: 'hidden', name, wrapper, eligible: true })
const ineligible = (id: string, name: string): ClassifiedRow => ({ id, kind: 'hidden', name, wrapper: { id }, eligible: false })
const absent = (id: string): ClassifiedRow => ({ id, kind: 'absent' })
const answerOf = (...rows: ClassifiedRow[]) => new Map(rows.map(r => [r.id, r]))

// ---- the affected-closure projection ----

test('the whole nonpending slice is replaced: every local row the answer disproves is removed', () => {
  // invalidating only the SELECTED candidate is not enough — the index retains same-name
  // duplicates, and removing one promotes the next stale one, which can then receive the very
  // update this rule prevents
  const plan = planTargetSlice({
    name: 'n',
    local: [
      { id: 'h', name: 'n', wrapper: {} },
      { id: 'j', name: 'n', wrapper: {} },
    ],
    answer: answerOf(hidden('k', 'n'), hidden('l', 'n'), absent('h'), absent('j')),
  })
  expect(plan.remove, 'destructive rows in canonical id order').toEqual(['h', 'j'])
  expect(plan.register.map(r => r.id), 'fresh rows in canonical id order').toEqual(['k', 'l'])
})

test('a local row the answer places under ANOTHER name projects to target-side absence only', () => {
  // local n:h, fresh q:h. passing the actual q row through would mutate an unrelated name outside
  // this confirmation's affected closure, on a chain it does not hold
  const plan = planTargetSlice({
    name: 'n',
    local: [{ id: 'h', name: 'n', wrapper: {} }],
    answer: answerOf(hidden('h', 'q')),
  })
  expect(plan.remove, 'h is absent FROM n').toEqual(['h'])
  expect(plan.register, 'and nothing is registered for q').toEqual([])
})

test('an unrelated row in the answer produces no effect at all', () => {
  const plan = planTargetSlice({
    name: 'n',
    local: [{ id: 'h', name: 'n', wrapper: {} }],
    answer: answerOf(hidden('h', 'n'), hidden('u', 'other')),
  })
  expect(plan.remove).toEqual([])
  expect(plan.register.map(r => r.id), 'only n rows').toEqual(['h'])
})

test('a local row the answer still confirms is neither removed nor duplicated', () => {
  const wrapper = { live: true }
  const plan = planTargetSlice({
    name: 'n',
    local: [{ id: 'h', name: 'n', wrapper }],
    answer: answerOf(hidden('h', 'n', { fresh: true })),
  })
  expect(plan.remove).toEqual([])
  expect(plan.register.map(r => r.id)).toEqual(['h'])
  expect(plan.register[0].wrapper, 'the FRESH wrapper wins').toEqual({ fresh: true })
})

test('an empty answer with local rows removes them all and resets the baseline once', () => {
  const plan = planTargetSlice({
    name: 'n',
    local: [
      { id: 'j', name: 'n', wrapper: {} },
      { id: 'h', name: 'n', wrapper: {} },
    ],
    answer: answerOf(absent('h'), absent('j')),
  })
  expect(plan.remove).toEqual(['h', 'j'])
  expect(plan.register, 'no fresh registration IS the baseline-reset branch').toEqual([])
})

// ---- the read-start marker proof ----

test('an OMITTED row matching the read-start proof is preserved, and carries the dependency', () => {
  // the writer's own create, issued and unacknowledged: the server has not published it yet, so a
  // complete read legitimately omits it. removing it would delete a record that exists
  const wrapper = { mine: true }
  const marker: Marker = { id: 'm', wrapper, token: 1 }
  const plan = planTargetSlice({
    name: 'n',
    local: [{ id: 'm', name: 'n', wrapper }],
    answer: answerOf(), // omits m entirely
    marker,
  })
  expect(plan.remove, 'not removed from a stale negative').toEqual([])
  expect(plan.preservedMarker, 'the controller must CAS the proof before mutating').toBe(marker)
  expect(plan.requiredMarker, 'and m is the selection, so the dependency is carried').toBe(marker)
  expect(plan.register, 'no fresh registration: the baseline still resets once').toEqual([])
})

test('the exemption is WRAPPER-exact: a same-id proof against a different object does not preserve', () => {
  // registerHidden replaces the indexed object on a fresh same-id observation, and a same-id
  // rename does too. an id-only exemption would mistake either for the original local create
  const plan = planTargetSlice({
    name: 'n',
    local: [{ id: 'm', name: 'n', wrapper: { replaced: true } }],
    answer: answerOf(),
    marker: { id: 'm', wrapper: { original: true }, token: 1 },
  })
  expect(plan.remove, 'the indexed object is no longer the proof').toEqual(['m'])
  expect(plan.preservedMarker, 'nothing was preserved, so no CAS is owed').toBeUndefined()
  expect(plan.requiredMarker).toBeUndefined()
})

test('an INDEPENDENTLY observed marker id carries no dependency', () => {
  // the answer contains m under n on its own evidence: that is server proof, and forcing a marker
  // dependency would cause a needless reconfirmation
  const wrapper = { mine: true }
  const plan = planTargetSlice({
    name: 'n',
    local: [{ id: 'm', name: 'n', wrapper }],
    answer: answerOf(hidden('m', 'n', { fresh: true })),
    marker: { id: 'm', wrapper, token: 1 },
  })
  expect(plan.register.map(r => r.id)).toEqual(['m'])
  expect(plan.requiredMarker, 'independently observed: no dependency').toBeUndefined()
})

test('a fresh LOWER row wins selection, so a preserved marker carries no dependency', () => {
  // m is preserved (omitted, proof matches) but a fresh lower `a` is canonical. the dependency is
  // provenance: it is carried only when the preserved row is the one actually selected
  const wrapper = { mine: true }
  const marker: Marker = { id: 'm', wrapper, token: 1 }
  const plan = planTargetSlice({
    name: 'n',
    local: [{ id: 'm', name: 'n', wrapper }],
    answer: answerOf(hidden('a', 'n')),
    marker,
  })
  expect(plan.remove, 'm is preserved, not removed').toEqual([])
  expect(plan.register.map(r => r.id)).toEqual(['a'])
  // TWO DIFFERENT FACTS: the plan still preserved m because of M, so the CAS is owed even though
  // the final selection is a and carries no dependency
  expect(plan.preservedMarker, 'the CAS is still owed').toBe(marker)
  expect(plan.requiredMarker, 'a lower fresh row is independent evidence').toBeUndefined()
})

test('a preserved marker that IS the selection carries the dependency even beside higher fresh rows', () => {
  const wrapper = { mine: true }
  const marker: Marker = { id: 'a', wrapper, token: 1 }
  const plan = planTargetSlice({
    name: 'n',
    local: [{ id: 'a', name: 'n', wrapper }],
    answer: answerOf(hidden('z', 'n')),
    marker,
  })
  expect(plan.register.map(r => r.id)).toEqual(['z'])
  expect(plan.requiredMarker, 'a is canonical, so the plan depends on its proof').toBe(marker)
})

test('a marker for a row the name does not hold locally is irrelevant', () => {
  const plan = planTargetSlice({
    name: 'n',
    local: [{ id: 'h', name: 'n', wrapper: {} }],
    answer: answerOf(absent('h')),
    marker: { id: 'elsewhere', wrapper: {}, token: 1 },
  })
  expect(plan.remove).toEqual(['h'])
  expect(plan.preservedMarker).toBeUndefined()
  expect(plan.requiredMarker).toBeUndefined()
})

// ---- point-answer normalization ----

test('a HIDDEN point answer replaces the stale raw row and enters registration', () => {
  const raw = [{ id: 'd1', name: 'n', wrapper: { stale: true } }]
  const answers = new Map<string, PointAnswer>([['d1', { kind: 'hidden', name: 'q', wrapper: { fresh: true } }]])
  const out = normalizeScan(raw, answers)
  expect(out.apply, 'the point answer REPLACES the raw entry').toEqual([
    { id: 'd1', name: 'q', wrapper: { fresh: true } },
  ])
})

test('a NOT-HIDDEN point answer only suppresses: zero production-body calls', () => {
  // replaying the visible side would bypass hasLocalIntent/deferRemoteChange and overwrite an
  // unsaved edit the live callback deliberately deferred
  const raw = [{ id: 'd1', name: 'n', wrapper: {} }]
  const answers = new Map<string, PointAnswer>([['d1', { kind: 'not-hidden' }]])
  const out = normalizeScan(raw, answers)
  expect(out.apply, 'nothing is applied').toEqual([])
  // omission from `apply` IS the suppression: there is no separate list
})

test('rows with no point answer stand, and everything applies in CANONICAL id order', () => {
  // point reads complete out of order; a pending create must not adopt a higher duplicate first
  const raw = [
    { id: 'z', name: 'n', wrapper: {} },
    { id: 'a', name: 'n', wrapper: { stale: true } },
    { id: 'm', name: 'n', wrapper: {} },
  ]
  const freshWrapper = { fresh: true }
  const answers = new Map<string, PointAnswer>([
    ['a', { kind: 'hidden', name: 'n', wrapper: freshWrapper }],
    ['m', { kind: 'not-hidden' }],
  ])
  const out = normalizeScan(raw, answers)
  expect(out.apply.map(r => r.id), 'canonical, not point-read completion order').toEqual(['a', 'z'])
  expect(out.apply[0].wrapper, 'exact wrapper identity').toBe(freshWrapper)
  // 'm' is simply absent from apply
})

// ---- pure classification ----

test('classification is complete and side-effect free, and fails closed on an unusable answer', () => {
  expect(classifyHiddenDocument('d', false, 'anything'), 'not hidden').toEqual({ kind: 'not-hidden' })
  expect(classifyHiddenDocument('d', true, JSON.stringify({ name: 'n', item: { v: 1 } }))).toEqual({
    kind: 'hidden',
    wrapper: { id: 'd', name: 'n', item: { v: 1 } },
  })
  // INDETERMINATE is not absence: the document exists and this read cannot say which name it
  // belongs to, so a confirmation must fail closed rather than synthesize target-side absence
  expect(classifyHiddenDocument('d', true, 'not json').kind).toBe('indeterminate')
  expect(classifyHiddenDocument('d', true, JSON.stringify({ item: {} })).kind, 'missing name').toBe('indeterminate')
  expect(classifyHiddenDocument('d', true, JSON.stringify({ name: '', item: {} })).kind, 'empty name').toBe('indeterminate')
  expect(classifyHiddenDocument('d', true, JSON.stringify('scalar')).kind, 'not an object').toBe('indeterminate')
  expect(classifyHiddenDocument('d', true, null).kind, 'no text').toBe('indeterminate')
})

test('a quarantined LOWER row is skipped, and the eligible row registers', () => {
  // counting a quarantined duplicate as a survivor would let registration skip that first row,
  // leaving a stale adoption selection or preventing a later eligible row from performing the one
  // rebase/publication. the quarantined id is NOT in `local`: quarantineNonCanonical removes it
  // from byId, and `local` is the nonpending byId slice
  const plan = planTargetSlice({
    name: 'n',
    local: [],
    answer: answerOf(ineligible('a', 'n'), hidden('k', 'n')),
  })
  expect(plan.remove).toEqual([])
  expect(plan.register.map(r => r.id), 'only the eligible row registers').toEqual(['k'])
})

test('a stale local row with only a quarantined fresh row: removed, and no fresh registration', () => {
  const plan = planTargetSlice({
    name: 'n',
    local: [{ id: 'h', name: 'n', wrapper: {} }],
    answer: answerOf(absent('h'), ineligible('k', 'n')),
  })
  expect(plan.remove, 'the disproved local row still goes').toEqual(['h'])
  expect(plan.register, 'nothing eligible to perform the rebase/publication').toEqual([])
})
test('server plaintext cannot inject controller-only transient state', () => {
  // persistence writes only name and item. a stored object carrying pending_create or adopt_id
  // would otherwise reach registerHidden as if it were live controller state — and an embedded id
  // must never beat the caller's
  const c = classifyHiddenDocument(
    'real',
    true,
    JSON.stringify({ id: 'forged', name: 'n', item: { v: 1 }, pending_create: true, adopt_id: 'x' })
  )
  expect(c).toEqual({ kind: 'hidden', wrapper: { id: 'real', name: 'n', item: { v: 1 } } })
  expect('pending_create' in (c as any).wrapper, 'no transient state').toBe(false)
  expect('adopt_id' in (c as any).wrapper).toBe(false)
})
