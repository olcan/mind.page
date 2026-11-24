// pure helpers for tests/e2e/lifecycle.spec.ts's dead-client row, kept in their own module so
// standalone checks can exercise the exact filter and timeout rules outside Playwright

const EMULATOR_400_TEXT = 'Failed to load resource: the server responded with a status of 400 (Bad Request)'
const EMULATOR_CHANNEL_PATHS = new Set([
  '/google.firestore.v1.Firestore/Listen/channel',
  '/google.firestore.v1.Firestore/Write/channel',
])

export type ConsoleErrorLike = {
  text: string
  location: { url: string; lineNumber: number; columnNumber: number }
  argsCount: number
}

// Chromium's exact network-resource 400 diagnostic on the BACKCHANNEL (the long-poll GET, `RID=rpc`)
// of the configured Firestore emulator's Listen or Write WebChannel for this lane's database.
// Browser resource diagnostics carry no JS console arguments and report line 0, column 0 at the
// failed request URL; any app/SDK console.error, any pageerror, any other status, any resource
// error on another host, path, or database, and a 400 on a FORWARD request of either channel (a
// numbered `RID`: an outgoing write the client tried to send) still fail
export function isEmulatorChannel400(
  msg: ConsoleErrorLike,
  { emulatorHost, projectId }: { emulatorHost: string; projectId: string }
): boolean {
  if (!emulatorHost || !projectId) return false
  if (msg.text !== EMULATOR_400_TEXT) return false
  if (msg.argsCount !== 0) return false
  if (msg.location.lineNumber !== 0 || msg.location.columnNumber !== 0) return false
  let url: URL
  try {
    url = new URL(msg.location.url)
  } catch {
    return false
  }
  return (
    url.protocol === 'http:' &&
    url.host === emulatorHost &&
    EMULATOR_CHANNEL_PATHS.has(url.pathname) &&
    url.searchParams.get('RID') === 'rpc' &&
    url.searchParams.get('database') === `projects/${projectId}/databases/(default)`
  )
}

// extend a finite configured timeout by the derived wait so all other work keeps its original
// budget; leave an unlimited timeout (0) unlimited
export function timeoutWithWait(configuredMs: number, waitMs: number): number {
  return configuredMs > 0 ? configuredMs + waitMs : configuredMs
}
