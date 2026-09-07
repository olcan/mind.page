import { expect, test } from '@playwright/test'
import { localEmulator, requireLocalEmulators } from '../../tests/e2e/init_perf_guard.js'

// the harness guard (see tests/e2e/init_perf_guard.ts): loopback emulators only, both required
for (const [value, ok] of [
  ['127.0.0.1:8080', true],
  ['localhost:9099', true],
  ['[::1]:8080', true],
  ['localhost', true],
  [undefined, false],
  ['', false],
  ['firestore.googleapis.com', false],
  ['10.0.0.5:8080', false],
  ['127.0.0.1.evil.example:8080', false],
] as const)
  test(`harness guard: ${JSON.stringify(value)} is ${ok ? '' : 'not '}a local emulator`, () => expect(localEmulator(value)).toBe(ok))

test('harness guard: both emulators are required, and a real host is refused', () => {
  expect(() => requireLocalEmulators({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).not.toThrow()
  expect(() => requireLocalEmulators({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toThrow(/FIREBASE_AUTH_EMULATOR_HOST/)
  expect(() => requireLocalEmulators({ FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).toThrow(/never runs against a real project/)
})
