import { expect, test } from '@playwright/test'
import { raisesLiveSignal, receiveSnapshot } from '../../src/live_signal.js'

// the live server signal (see src/live_signal.ts): every receipt drops it; a server receipt's
// sealed application raises it while that receipt is still the latest and the ingress runs

const first = receiveSnapshot({ n: 0, current: false }, false)

test('receipts are numbered in order and know whether the snapshot is the server\'s', () => {
  expect(first).toEqual({ n: 1, current: true })
  expect(receiveSnapshot(first, true)).toEqual({ n: 2, current: false })
})

test('the latest server receipt\'s sealed application raises the signal', () => {
  expect(raisesLiveSignal({ applied: first, latest: first, stopped: false })).toBe(true)
})

test('a cache receipt never raises it, even as the latest', () => {
  const cached = receiveSnapshot(first, true)
  expect(raisesLiveSignal({ applied: cached, latest: cached, stopped: false })).toBe(false)
})

test('an older application completing after a newer receipt does not raise it', () => {
  const newer = receiveSnapshot(first, true) // a cache receipt overtook the application
  expect(raisesLiveSignal({ applied: first, latest: newer, stopped: false })).toBe(false)
  const newerServer = receiveSnapshot(first, false) // a newer server receipt: its own application decides
  expect(raisesLiveSignal({ applied: first, latest: newerServer, stopped: false })).toBe(false)
})

test('a stopped ingress does not raise it', () => {
  expect(raisesLiveSignal({ applied: first, latest: first, stopped: true })).toBe(false)
})
