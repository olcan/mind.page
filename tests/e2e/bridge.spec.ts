// e2e proof of the native-web agent bridge PoC (see vault ideas/native_web_agent_bridge.md):
// a request item created in the browser is answered by the vault's Python bridge listener
// (bin/mind_bridge.py) through the Firestore emulator, and the signed reply renders back in
// the app as a realtime remote update. Full round trip:
//   browser -> Firestore (emulator) -> native listener -> Firestore -> browser
// The listener is spawned from the vault checkout (VAULT_DIR, default ~/vault) using its venv;
// the whole spec is skipped when no vault checkout is available.
// Request items carry a unique test-owned visible label plus a hidden #_agent/native routing
// tag (the real /native request shape): in the configured gate this lane runs behind the
// admin-installed corpus, which contains the #agent/native provider item itself, and a second
// visible #agent/native label would make _item(name, true) return null on the ambiguity.
import { expect, test } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { delimiter, resolve } from 'path'
import { type Page } from '@playwright/test'
import { firestore, loadAdmin, loadUser, secretFor, waitForApp, type TestUser } from './helpers.js'

const VAULT = resolve(process.env.VAULT_DIR ?? `${process.env.HOME}/vault`)
const PYTHON = `${VAULT}/.venv/bin/python`

// dedicated personal account for the encrypted row: the personal suite owns ALICE (different
// phrase, plus deliberately malformed/v1/foreign-keyed ciphers) and runs concurrently on the same
// emulator corpus; the listener reads every item of its user and treats an undecryptable cipher
// as fatal by contract, so the accounts must not be shared
const BRIDGE_USER: TestUser = { uid: 'bridge_e2e', displayName: 'Bridge Test', email: 'bridge@e2e.test' }

let bridge: ChildProcessWithoutNullStreams

test.skip(!existsSync(PYTHON), 'vault checkout with venv required (set VAULT_DIR)')

// spawns a bridge listener for the given account and resolves once it is listening; bounded:
// rejects on spawn error, premature exit, or a startup timeout, and kills the child on failure
// (FIRESTORE_EMULATOR_HOST comes from `firebase emulators:exec`, see tests/e2e/run.sh)
async function spawnBridge(user: string, env: Record<string, string> = {}): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(PYTHON, [`${VAULT}/bin/mind_bridge.py`, '--user', user], {
    cwd: VAULT,
    // self-contained import path: the script does `from mindpage_bridge import ...`, which lives
    // in the vault's lib/ (normally supplied by the vault's interactive shell PYTHONPATH); an
    // ordinary shell would otherwise fail with ModuleNotFoundError
    env: {
      ...process.env,
      PYTHONPATH: `${VAULT}/lib${process.env.PYTHONPATH ? delimiter + process.env.PYTHONPATH : ''}`,
      ...env,
    } as NodeJS.ProcessEnv,
  })
  let stdout = '' // accumulated: the listening marker may straddle chunk boundaries
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString()
    console.log(`[bridge:${user}] ${data.toString().trim()}`)
  })
  child.stderr.on('data', (data: Buffer) => console.log(`[bridge:${user}:err] ${data.toString().trim()}`))
  // a post-ready death would otherwise surface only as a later poll timeout
  child.on('exit', (code, signal) => console.log(`[bridge:${user}] exited (code=${code}, signal=${signal})`))
  await new Promise<void>((ready, failed) => {
    let settled = false
    const settle = (fn: () => void) => settled || ((settled = true), clearTimeout(timer), fn())
    const timer = setTimeout(
      () => settle(() => (child.kill('SIGKILL'), failed(new Error(`bridge startup timed out in 15s; stdout: ${stdout}`)))),
      15_000
    )
    // registered after the accumulating listener above, so `stdout` already includes the chunk
    child.stdout.on('data', () => stdout.includes('listening') && settle(ready))
    child.on('error', e => settle(() => (child.kill('SIGKILL'), failed(new Error(`bridge failed to spawn: ${e}`)))))
    child.on('exit', code => settle(() => failed(new Error(`bridge exited during startup with code ${code}`))))
  })
  return child
}

// SIGTERM, await exit briefly, SIGKILL only on timeout (then wait up to 2s for the exit): an
// unkilled listener would contaminate the next run. a process that exits by signal leaves
// exitCode null and records signalCode, so both mark the already-exited state
async function stopBridge(child: ChildProcessWithoutNullStreams | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(done => child.once('exit', () => done()))
  child.kill('SIGTERM')
  let timer: NodeJS.Timeout | undefined
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>(done => (timer = setTimeout(() => done(true), 5_000))),
  ])
  clearTimeout(timer)
  if (timedOut) {
    child.kill('SIGKILL')
    await Promise.race([exited, new Promise<void>(done => setTimeout(done, 2_000))])
  }
}

test.beforeAll(async () => {
  bridge = await spawnBridge('anonymous')
})

test.afterAll(() => stopBridge(bridge))

// item text lookup by name, empty until the item exists (e.g. right after _create)
function itemText(page: Page, name: string): Promise<string> {
  return page.evaluate(name => window._item(name, true)?.text ?? '', name)
}

test('bridge replies to a request item created in the browser', async ({ page }) => {
  page.on('console', m => {
    const text = m.text()
    if (/bridge|native/.test(text)) console.log(`[page] ${text.slice(0, 200)}`)
  })
  await loadAdmin(page)
  await page.evaluate(() => void window._create('#e2e_bridge_roundtrip #_agent/native\n<<user>> hello bridge'))
  // the native reply appears in item text via realtime sync, no reload
  await expect
    .poll(() => itemText(page, '#e2e_bridge_roundtrip'), { timeout: 30_000 })
    .toContain("<<agent('native/default')>> echo(sandbox=read_only, cost_limit=0.5): hello bridge")
  // and renders in the app like any other chat reply
  await expect(page.getByText(/echo\(sandbox=read_only/).first()).toBeVisible()
  // a replied item must not be answered again (trailing agent message guard, echo suppression)
  await page.waitForTimeout(2_000)
  const text = await itemText(page, '#e2e_bridge_roundtrip')
  expect(text.match(/<<agent\('native\/default'\)>>/g)?.length, text).toBe(1)
})

test('personas resolve on the native side, unknown personas get error replies', async ({ page }) => {
  await loadAdmin(page)
  await page.evaluate(() => void window._create('#e2e_bridge_opus #_agent/native/opus\n<<user>> ping'))
  await page.evaluate(() => void window._create('#e2e_bridge_unknown #_agent/native/nope\n<<user>> ping'))
  // opus resolves to the registry entry with its own authority (cost_limit=5.0)
  await expect
    .poll(() => itemText(page, '#e2e_bridge_opus'), { timeout: 30_000 })
    .toContain("<<agent('native/opus')>> echo(sandbox=read_only, cost_limit=5.0): ping")
  // unknown personas fail as replies listing available personas -- no request dies silently
  await expect
    .poll(() => itemText(page, '#e2e_bridge_unknown'), { timeout: 30_000 })
    .toContain("<<agent('native')>> error: unknown persona 'nope' (available: default, opus)")
})

test('bridge replies to encrypted personal-account requests', async ({ page }) => {
  // personal (non-anonymous) accounts store each item's JSON aes-gcm-encrypted in a
  // `cipher` field with `text` null; the bridge decrypts with the account's stored
  // secret (the localStorage.mindpage_secret form) and writes back a re-encrypted
  // reply the app can decrypt -- proving v0 crypto compatibility in both directions.
  // NOTE: this row pins the v0 scheme on a fresh emulator account (KDF flags off), as
  // an explicit v0 PoC. The Python port must gain v1/mixed-corpus support BEFORE the
  // bridge ever serves a writer-enabled (mindpage_kdf_write) personal account; that
  // port change should add an explicit v1 row rather than repurpose this one.
  const PHRASE = 'bridge-e2e-phrase'
  const secret = secretFor(BRIDGE_USER, PHRASE)
  const listener = await spawnBridge(BRIDGE_USER.uid, { MIND_BRIDGE_USER_SECRET: secret })
  try {
    // seed the secret as a returning device would have it, before signing in
    await page.addInitScript(secret => localStorage.setItem('mindpage_secret', secret), secret)
    await loadUser(page, BRIDGE_USER)
    // brand-new empty account: loadUser only waits for initialization to START (and writability);
    // welcome copying/reconstruction/rendering may still be in flight, so wait for the app proper
    await waitForApp(page)
    await page.evaluate(() => void window._create('#e2e_bridge_secret #_agent/native\n<<user>> secret ping'))
    // the decrypted native reply appears in item text via realtime sync
    await expect
      .poll(() => itemText(page, '#e2e_bridge_secret'), { timeout: 30_000 })
      .toContain("<<agent('native/default')>> echo(sandbox=read_only, cost_limit=0.5): secret ping")
    // and the item is encrypted at rest, exactly as the personal suite pins it: text and attr
    // null, cipher base64, and no plaintext anywhere in the stored document
    const id = await page.evaluate(() => window._item('#e2e_bridge_secret', true)?.saved_id)
    expect(id, 'saved item id').toBeTruthy()
    const doc = (await firestore().collection('items').doc(id!).get()).data()!
    expect(doc.text, 'text must not be stored').toBeNull()
    expect(doc.attr, 'attr must not be stored').toBeNull()
    expect(doc.cipher).toMatch(/^[A-Za-z0-9+/=]{40,}$/)
    expect(JSON.stringify(doc)).not.toContain('secret ping')
  } finally {
    await stopBridge(listener)
  }
})
