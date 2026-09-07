import { expect, test } from '@playwright/test'
import { attrSaveStep, settleCorpus, WELCOME_CONFIRMATION_TIMEOUT_MS } from '../../src/welcome.js'

// the welcome boundary (see src/welcome.ts): welcome hooks wait for the corpus to settle — the
// server confirmation, or no confirmation to wait for now (offline, timeout); attribute saves
// (attrSaveStep, below) wait for the confirmation itself
const pending = () => new Promise<void>(() => {})
const at = <T>(value: T) => Promise.resolve(value) as unknown as Promise<void>

test('settles as confirmed when the confirmation arrives before the timeout', async () => {
  let confirm!: () => void
  const confirmation = new Promise<void>(resolve => (confirm = resolve))
  const settled = settleCorpus({ confirmation, online: true, timeoutMs: 10, delay: pending })
  confirm()
  expect(await settled).toBe('confirmed')
})

test('settles as offline at once when the device reports offline, confirmation or not', async () => {
  expect(await settleCorpus({ confirmation: pending(), online: false, timeoutMs: 10, delay: pending })).toBe('offline')
})

test('settles as timeout when the confirmation has not arrived by the timeout', async () => {
  let waited = 0
  const delay = (ms: number) => {
    waited = ms
    return at(undefined)
  }
  expect(await settleCorpus({ confirmation: pending(), online: true, timeoutMs: WELCOME_CONFIRMATION_TIMEOUT_MS, delay })).toBe(
    'timeout'
  )
  expect(waited, 'the timeout is the configured wait').toBe(WELCOME_CONFIRMATION_TIMEOUT_MS)
})

// the HELD attribute save (see attrSaveStep): one item-task turn per row; a save carries the
// whole item, so it must never be released by a fallback settlement, only by the confirmation
const turn = (confirmed: boolean, current: boolean, stored: boolean | undefined) =>
  attrSaveStep({ confirmed, current, stored, equal: (a, b) => a === b })

test('a pending toggle is held (retried) while unconfirmed — a timeout or offline fallback releases nothing', () => {
  // offline start or a timeout: settled for welcome hooks, still unconfirmed for saves
  expect(turn(false, false, true)).toBe('retry')
  expect(turn(false, false, true), 'held on every later turn too').toBe('retry')
})

test('the held toggle saves once the confirmation arrives with the value still pending', () => {
  expect(turn(true, false, true)).toBe('save')
  expect(turn(true, false, undefined), 'a never-persisted attribute saves too').toBe('save')
})

test('a remote revision that reset the pending toggle before the confirmation leaves nothing to save', () => {
  // the remote apply set the in-memory value from the server's attribute: equal, no write (the
  // accepted lost-toggle trade); the same for a value already persisted
  expect(turn(true, true, true)).toBe('unchanged')
})

test('the held save schedule: hold, hold, remote reset, confirmation → no save; hold, confirmation → save', () => {
  const schedule = (turns: [boolean, boolean, boolean | undefined][]) => turns.map(t => turn(...t))
  expect(schedule([[false, false, true], [false, false, true], [true, true, true]])).toEqual(['retry', 'retry', 'unchanged'])
  expect(schedule([[false, false, true], [true, false, true]])).toEqual(['retry', 'save'])
})
