// the init-perf harness's fail-closed guard (see init_perf.perf.ts): the harness seeds an exported
// corpus at its ORIGINAL document ids under a test account, so it must never reach a real
// project — it runs only when both emulators are configured at a loopback address. pure, so the
// unit suite pins it without a firebase app or a network
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d{1,5})?$/

export function localEmulator(value: string | undefined): boolean {
  return typeof value == 'string' && LOOPBACK.test(value.trim())
}

// throws unless every named variable points at a loopback emulator
export function requireLocalEmulators(env: Record<string, string | undefined>, names = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']): void {
  for (const name of names)
    if (!localEmulator(env[name]))
      throw new Error(`${name} must point at a loopback emulator (got ${JSON.stringify(env[name] ?? '')}): the init-perf harness never runs against a real project`)
}
