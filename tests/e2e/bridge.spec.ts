// e2e proof of the vault-web agent bridge PoC (design: vault notes/design/mind_bridge_v2.md):
// a request item created in the browser is answered by the vault's Python bridge listener
// (bin/mind_bridge.py) through the Firestore emulator, and the signed reply renders back in
// the app as a realtime remote update. Full round trip:
//   browser -> Firestore (emulator) -> vault listener -> Firestore -> browser
// The listener is spawned from the vault checkout (VAULT_DIR, default ~/vault) using its venv;
// the whole spec is skipped when no vault checkout is available.
// Request items carry a unique test-owned visible label plus a hidden #_agent/vault routing
// tag (the real /vault request shape): in the configured gate this lane runs behind the
// admin-installed corpus, which contains the #agent/vault provider item itself, and a second
// visible #agent/vault label would make _item(name, true) return null on the ambiguity.
import { expect, test } from '@playwright/test'
import { FieldValue } from 'firebase-admin/firestore'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
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
      // scrub BOTH ambient credentials (the vault .env may define them and the child's
      // load_dotenv does not override set vars); empty means absent to the CLI, and each
      // row overrides exactly the credential it needs
      MIND_BRIDGE_USER_SECRET: '',
      MIND_BRIDGE_USER_ENVELOPE_FILE: '',
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
    if (/bridge|vault/.test(text)) console.log(`[page] ${text.slice(0, 200)}`)
  })
  await loadAdmin(page)
  await page.evaluate(() => void window._create('#e2e_bridge_roundtrip #_agent/vault\n<<user>> hello bridge'))
  // the vault reply appears in item text via realtime sync, no reload
  await expect
    .poll(() => itemText(page, '#e2e_bridge_roundtrip'), { timeout: 30_000 })
    .toContain("<<agent('vault/default')>> echo(cost_limit=0.5): hello bridge")
  // and renders in the app like any other chat reply
  await expect(page.getByText(/echo\(cost_limit=/).first()).toBeVisible()
  // a replied item must not be answered again (trailing agent message guard, echo suppression)
  await page.waitForTimeout(2_000)
  const text = await itemText(page, '#e2e_bridge_roundtrip')
  expect(text.match(/<<agent\('vault\/default'\)>>/g)?.length, text).toBe(1)
})

test('personas resolve on the vault side, unknown personas get error replies', async ({ page }) => {
  await loadAdmin(page)
  await page.evaluate(() => void window._create('#e2e_bridge_opus #_agent/vault/opus\n<<user>> ping'))
  await page.evaluate(() => void window._create('#e2e_bridge_unknown #_agent/vault/nope\n<<user>> ping'))
  // opus resolves to the registry entry with its own authority (cost_limit=5.0)
  await expect
    .poll(() => itemText(page, '#e2e_bridge_opus'), { timeout: 30_000 })
    .toContain("<<agent('vault/opus')>> echo(cost_limit=5.0): ping")
  // unknown personas fail as replies listing available personas -- no request dies silently
  await expect
    .poll(() => itemText(page, '#e2e_bridge_unknown'), { timeout: 30_000 })
    .toContain("<<agent('vault')>> error: unknown persona 'nope' (available: default, opus)")
})

test('bridge replies to encrypted personal-account requests', async ({ page }) => {
  // personal (non-anonymous) accounts store each item's JSON aes-gcm-encrypted in a
  // `cipher` field with `text` null; the bridge decrypts with the account's stored
  // secret (the localStorage.mindpage_secret form) and writes back a re-encrypted
  // reply the app can decrypt -- proving v0 crypto compatibility in both directions.
  // NOTE: this row pins the legacy v0-only mode on a fresh emulator account (KDF
  // flags off) as an explicit v0 PoC; the v1/mixed-corpus port is pinned by the
  // envelope row below, which serves both frames and writes replies as v1.
  const PHRASE = 'bridge-e2e-phrase'
  const secret = secretFor(BRIDGE_USER, PHRASE)
  const listener = await spawnBridge(BRIDGE_USER.uid, { MIND_BRIDGE_USER_SECRET: secret })
  try {
    // seed the secret as a returning device would have it, before signing in; the reader flag is
    // EXPLICITLY 'off' — this ROW deliberately pins the legacy v0-only MODE (the port itself
    // is mixed-corpus), and under the reader default an absent flag would enable acquisition
    // and prompt
    await page.addInitScript(secret => {
      localStorage.setItem('mindpage_secret', secret)
      localStorage.setItem('mindpage_kdf', 'off')
    }, secret)
    await loadUser(page, BRIDGE_USER)
    // brand-new empty account: loadUser only waits for initialization to START (and writability);
    // welcome copying/reconstruction/rendering may still be in flight, so wait for the app proper
    await waitForApp(page)
    await page.evaluate(() => void window._create('#e2e_bridge_secret #_agent/vault\n<<user>> secret ping'))
    // the decrypted vault reply appears in item text via realtime sync
    await expect
      .poll(() => itemText(page, '#e2e_bridge_secret'), { timeout: 30_000 })
      .toContain("<<agent('vault/default')>> echo(cost_limit=0.5): secret ping")
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

test('bridge serves a mixed v0/v1 corpus via the key envelope and replies v1', async ({ page }) => {
  // the v1/mixed-corpus port row (vault review 101 §2, landed with the port): a personal
  // account holding BOTH cipher versions is served by a bridge running on the account's key
  // ENVELOPE (the localStorage.mindpage_key1 form: v1 key + bound v0 secret in one
  // account-bound value, via MIND_BRIDGE_USER_ENVELOPE_FILE). the bridge must decrypt each
  // frame with its own credential and write EVERY reply as v1 -- a v0 write would re-create
  // retired-KDF ciphertext in a swept corpus. cross-parity is real in both directions: the
  // envelope comes from the app's own ENCODER and the v0 request from its v0 primitive
  // (src/kdf_profile.js, src/crypto.js), the v1 request is written by the BROWSER (writer on)
  // and asserted v1 at rest BEFORE the listener starts (so the mixed corpus is established,
  // not assumed), and the app decrypts and renders both bridge replies live
  const PHRASE = 'bridge-v1-phrase'
  const V1_USER: TestUser = { uid: 'bridge_v1_e2e', displayName: 'Bridge V1', email: 'bridge_v1@e2e.test' }
  const SALT = Buffer.from(new Uint8Array(16).fill(8)).toString('base64')
  const KEY_BYTES = new Uint8Array(32).map((_, i) => 96 + i)
  const { encryptWithSecret, importV1Key, decryptV1Text } = await import('../../src/crypto.js')
  const { encodeKeyEnvelope } = await import('../../src/kdf_profile.js')
  const v1key = await importV1Key(KEY_BYTES)
  const secret = secretFor(V1_USER, PHRASE)
  // the app's own envelope encoder: the same value a real device persists as mindpage_key1
  const envelope = encodeKeyEnvelope({ uid: V1_USER.uid, salt: SALT, keyBytes: KEY_BYTES, v0Secret: secret })
  // the committed profile (the metadata shape the app's session and the bridge's startup
  // fence both confirm against), and a v0-encrypted REQUEST already at rest
  await firestore().collection('users').doc(V1_USER.uid).set({ kdf: { v: 1, salt: SALT } }, { merge: true })
  await firestore()
    .collection('items')
    .doc('e2e-bridge-v0req')
    .set({
      user: V1_USER.uid,
      time: Date.now(),
      hidden: false,
      text: null,
      attr: null,
      cipher: await encryptWithSecret(
        JSON.stringify({ text: '#e2e_bridge_v0req #_agent/vault\n<<user>> v0 ping', attr: null }),
        secret
      ),
    })
  let browserId: string | undefined
  let listener: ChildProcessWithoutNullStreams | undefined
  try {
    // a returning v1 device: secret + envelope + writer ON (reader at its production default)
    await page.addInitScript(
      ([secret, envelope]) => {
        localStorage.setItem('mindpage_secret', secret)
        localStorage.setItem('mindpage_key1', envelope)
        localStorage.setItem('mindpage_kdf_write', 'on')
      },
      [secret, envelope]
    )
    await loadUser(page, V1_USER)
    await waitForApp(page)
    // the browser writes its request and it SETTLES BEFORE the listener exists, so the
    // browser-v1 direction is proven on the initial cipher -- were the writer flag ignored
    // and this stored as v0, the bridge's later v1 rewrite would mask it
    await page.evaluate(() => void window._create('#e2e_bridge_v1req #_agent/vault\n<<user>> v1 ping'))
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_bridge_v1req', true)?.saved_id), { timeout: 30_000 })
      .toBeTruthy()
    browserId = (await page.evaluate(() => window._item('#e2e_bridge_v1req', true)?.saved_id))!
    const initial = (await firestore().collection('items').doc(browserId).get()).data()!
    expect(initial.cipher, 'browser request is v1 at rest BEFORE any bridge ran').toMatch(/^1![0-9a-f]{24}/)
    const seeded = (await firestore().collection('items').doc('e2e-bridge-v0req').get()).data()!
    expect(seeded.cipher, 'seeded request is still v0 (untagged) -- a genuinely mixed corpus').toMatch(
      /^[0-9a-f]{24}/
    )
    // install the modal collector BEFORE the listener exists (review 150 §3.2): it must
    // observe the whole span of both live {cipher,time} reply rewrites and the ~2s
    // reconciliation that follows -- a snapshot or late observer misses transient modals.
    // error modals carry real text; spinner overlays are whitespace-only.
    await page.evaluate(() => {
      const seen: string[] = ((window as any)._modals_seen = [])
      const record = () =>
        document.querySelectorAll('.modal').forEach(m => {
          const text = (m.textContent ?? '').trim()
          if (text) seen.push(text)
        })
      new MutationObserver(record).observe(document.body, { childList: true, subtree: true })
      record()
    })
    // only NOW start the listener: its initial catch-up snapshot serves the mixed corpus.
    // the envelope reaches it as a 0600 file, exactly like production operation
    const envelopePath = test.info().outputPath('envelope.json')
    writeFileSync(envelopePath, envelope, { mode: 0o600 })
    listener = await spawnBridge(V1_USER.uid, { MIND_BRIDGE_USER_ENVELOPE_FILE: envelopePath })
    // both replies -- to the seeded v0 request and the browser's v1 request -- render live
    await expect
      .poll(() => itemText(page, '#e2e_bridge_v0req'), { timeout: 30_000 })
      .toContain("<<agent('vault/default')>> echo(cost_limit=0.5): v0 ping")
    await expect
      .poll(() => itemText(page, '#e2e_bridge_v1req'), { timeout: 30_000 })
      .toContain("<<agent('vault/default')>> echo(cost_limit=0.5): v1 ping")
    // warm-cache no-error-modal (owner-observed 2026-08-30, design §2.2): the collector
    // installed BEFORE the listener has observed both live reply rewrites; wait past the
    // ~2s reconciliation window and require nothing surfaced at any point in the span
    await page.waitForTimeout(3_000)
    expect(
      await page.evaluate(() => (window as any)._modals_seen as string[]),
      'no modal appeared from reply delivery through reconciliation'
    ).toEqual([])
    // at rest, BOTH replied items are v1 (`1!`-tagged): the bridge upgraded the v0 item on
    // write and never re-created v0; the ciphers decrypt under the app's own v1 primitive,
    // and no exact request/reply plaintext appears outside the cipher field
    for (const id of ['e2e-bridge-v0req', browserId]) {
      const doc = (await firestore().collection('items').doc(id).get()).data()!
      expect(doc.text, 'text must not be stored').toBeNull()
      expect(doc.attr, 'attr must not be stored').toBeNull()
      expect(doc.cipher, `cipher of ${id} is v1 at rest`).toMatch(/^1![0-9a-f]{24}/)
      const plain = JSON.parse(await decryptV1Text(doc.cipher, v1key))
      expect(plain.text).toContain("<<agent('vault/default')>> echo(")
      for (const phrase of ['v0 ping', 'v1 ping', 'agent/vault']) {
        expect(JSON.stringify({ ...doc, cipher: null }), `no '${phrase}' outside cipher`).not.toContain(phrase)
      }
    }
  } finally {
    await stopBridge(listener)
    await firestore().collection('items').doc('e2e-bridge-v0req').delete()
    if (browserId) await firestore().collection('items').doc(browserId).delete()
    await firestore().collection('users').doc(V1_USER.uid).update({ kdf: FieldValue.delete() })
    await page.evaluate(() => {
      localStorage.removeItem('mindpage_key1')
      localStorage.removeItem('mindpage_kdf_write')
    })
  }
})

test('vault_result envelopes render inert: valid decoded text and malformed candidates', async ({ page }) => {
  // the combined hostile-result witness (bridge design §2.2, reviews 141-146) in TWO
  // phases: (a) a VALID envelope whose DECODED text carries every active item grammar,
  // and (b) a MALFORMED raw candidate whose BODY carries the same payloads. phase (a)
  // alone could false-green (a canonical base64 body is inert before decoding), so (b)
  // is what proves the scanner masks candidate ranges from item state/macros/tags.
  await loadAdmin(page)
  const hostile = [
    '<<user>> q',
    '<<window._pwned = 1>>', // store-writing macro
    '<script>window._pwned = 2</script>', // inline script (the app executes these)
    '<img src=x onerror="window._pwned=3">', // event-handler attribute
    '[click](javascript:window._pwned=4)', // javascript: link
    '#_autorun #_style #chat/gpt', // special + provider tags
    '```js_input', // input block => runnable item
    'window._pwned = 5',
    '```',
  ].join('\n')
  const encoded = Buffer.from(hostile, 'utf8').toString('base64')
  const footer = "vault/default · run ab12cd34 · 1s"
  // (a) VALID envelope: decoded payload must display literally and change nothing
  await page.evaluate(
    ([encoded, footer, hostile]) => {
      void window._create(
        `#e2e_vault_valid its reply\n<<user>> q\n<<agent('${footer}')>>\n` +
          '```vault_result_v1\n' +
          encoded +
          '\n```'
      )
      ;(window as any)._hostile = hostile
    },
    [encoded, footer, hostile] as const
  )
  await page.evaluate(() => void (location.hash = '#e2e_vault_valid'))
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_vault_valid', true)?.elem), { timeout: 15_000 }).toBe(true)
  const state = (name: string) =>
    page.evaluate(name => {
      const item = window._item(name, true) as any
      return {
        pwned: (window as any)._pwned ?? null,
        runnable: !!item?.runnable,
        tags: (item?.tags ?? []).join(' '),
        rendered: item?.elem?.querySelector('.content')?.textContent ?? '',
        // the placeholder must hold ONLY text nodes: any element/attribute means
        // decoded or raw candidate bytes reached the html grammar
        placeholderElements: [...(item?.elem?.querySelectorAll('.vault-result *') ?? [])].length,
        liveNodes: [
          ...(item?.elem?.querySelectorAll('.content script, .content img, .content [onerror], .content a[href^="javascript:"]') ??
            []),
        ].length,
        // count over the GRAMMAR VIEW (the internal item's lctext, not the _Item
        // wrapper's raw text): a malformed candidate legitimately still contains its
        // raw bytes in item.text, and the whole point is that the grammar view does not
        messages:
          (window.__items.find(entry => entry.labelText == name) as any)?.lctext?.match(/<<user>>/g)?.length ?? 0,
      }
    }, name)
  const valid = await state('#e2e_vault_valid')
  expect(valid.pwned, 'no macro/script/handler/link executed').toBeNull()
  expect(valid.runnable, 'decoded input block did not make the item runnable').toBe(false)
  expect(valid.tags, 'decoded tags did not enter item state').not.toContain('#_autorun')
  expect(valid.tags).not.toContain('#chat/gpt')
  expect(valid.rendered, 'the decoded payload displays literally').toContain('window._pwned = 1')
  expect(valid.placeholderElements, 'the placeholder holds text nodes only').toBe(0)
  expect(valid.liveNodes, 'no script/img/handler/javascript-link element was created').toBe(0)
  expect(valid.messages, 'the decoded <<user>> is not a delimiter in the grammar view').toBe(1)
  // (b) MALFORMED candidate: the same payloads as RAW body, opaque and placeholdered
  await page.evaluate(
    hostile =>
      void window._create('#e2e_vault_bad malformed\n<<user>> q\n```vault_result_v1\nnot base64\n' + hostile + '\n```'),
    hostile
  )
  await page.evaluate(() => void (location.hash = '#e2e_vault_bad'))
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_vault_bad', true)?.elem), { timeout: 15_000 }).toBe(true)
  const bad = await state('#e2e_vault_bad')
  expect(bad.pwned, 'raw hostile body executed nothing').toBeNull()
  expect(bad.runnable, 'raw input block did not make the item runnable').toBe(false)
  expect(bad.tags, 'raw tags did not enter item state').not.toContain('#_autorun')
  expect(bad.tags).not.toContain('#chat/gpt')
  expect(bad.rendered, 'the invalid candidate renders the fixed placeholder').toContain('⟦invalid vault result⟧')
  expect(bad.rendered, 'raw candidate bytes are not displayed').not.toContain('window._pwned')
  expect(bad.placeholderElements, 'the placeholder holds text nodes only').toBe(0)
  expect(bad.liveNodes, 'no script/img/handler/javascript-link element was created').toBe(0)
  expect(bad.messages, 'the raw <<user>> is not a delimiter in the grammar view').toBe(1)
  // the read path (grammar view) masks candidate bytes for every downstream parser
  expect(
    await page.evaluate(() => (window._item('#e2e_vault_bad') as any).read()),
    'the read path masks candidate bytes'
  ).not.toContain('window._pwned')
})

test('a candidate-bearing item: read/render domains stay separate and idle converges', async ({ page }) => {
  // review 149 §3: the renderer bypasses the shared item.expanded (its placeholder HTML
  // must never become semantic text), while the read path caches its grammar/marker
  // expansion normally -- so the background pre-expander converges once instead of
  // re-evaluating the outer macro on every ~250ms idle pass.
  await loadAdmin(page)
  // create the item AND run a macro-evaluating read in the SAME task, before Svelte
  // flushes, so the read populates item.expanded first. a side-effect counter proves the
  // macro is not re-run on every idle pass.
  const read = await page.evaluate(() => {
    ;(window as any)._macro_runs = 0
    void window._create('#e2e_vault_cache <<(window._macro_runs++, 1 + 2)>>\n```vault_result_v1\nnot base64\n```')
    return (window._item('#e2e_vault_cache') as any).read('', { eval_macros: true })
  })
  expect(read, 'the macro evaluated in the read').toContain('3')
  expect(read, 'the candidate is a masked marker in the read').not.toContain('not base64')
  await page.evaluate(() => void (location.hash = '#e2e_vault_cache'))
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_vault_cache', true)?.elem), { timeout: 15_000 }).toBe(true)
  const content = await page.evaluate(
    () => window._item('#e2e_vault_cache', true)?.elem?.querySelector('.content')?.textContent ?? ''
  )
  expect(content, 'the macro rendered (cache not poisoned by a marker)').toContain('3')
  expect(content, 'the invalid candidate still shows the placeholder').toContain('⟦invalid vault result⟧')
  expect(content, 'no raw marker leaked into render').not.toContain('vault_result_v1:')
  // idle convergence: past several ~250ms background passes the macro count is stable
  const runsBefore = await page.evaluate(() => (window as any)._macro_runs as number)
  await page.waitForTimeout(1_500)
  expect(await page.evaluate(() => (window as any)._macro_runs as number), 'no permanent idle re-expansion').toBe(
    runsBefore
  )
  await page.evaluate(() => window._item('#e2e_vault_cache')?.delete(false))
})

test('a malformed candidate cannot execute a nested js block on startup', async ({ page }) => {
  // review 148 §1.1: special-tag-alias extraction runs before the initial itemTextChanged
  // pass, so it must scan INLINE -- a nested js block inside a malformed candidate must
  // not execute on reload
  await loadAdmin(page)
  await page.evaluate(() => {
    ;(window as any)._startup_pwned = false
    // a MALFORMED candidate whose body contains a real nested ```js block opener with a
    // _special_tag_aliases function: only a RAW extractBlock(item.text,'js') would find
    // and execute it. the candidate's bare close also closes the raw js match.
    void window._create(
      '#e2e_startup_js\n```vault_result_v1\nnot base64\n```js\n' +
        'window._startup_pwned = true\nfunction _special_tag_aliases() { return {} }\n```'
    )
  })
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_startup_js', true)?.saved_id ?? null), { timeout: 30_000 })
    .toBeTruthy()
  // reload: the startup alias extraction runs over the persisted item
  await page.reload()
  await waitForApp(page)
  await page.waitForTimeout(1_000)
  // after reload the window sentinel is cleared; only the nested js executing would set it
  expect(await page.evaluate(() => (window as any)._startup_pwned), 'the nested js did not execute on startup').not.toBe(
    true
  )
  await page.evaluate(() => window._item('#e2e_startup_js')?.delete(false))
})

test('/run copies only the real input, not a candidate-nested one', async ({ page }) => {
  // reviews 148 §1.2, 150 §2.3, 151 §3. three phases:
  // 1: an installed item with a real outer input plus a SIBLING candidate -- /run copies
  //    only the real input (the raw-match bug), the candidate stays on the parent, and
  //    the child (where cleanup/publication then run) carries no candidate at all
  // 2: a candidate INSIDE the selected input -- the child receives the exact raw
  //    envelope (its own scanner masks it), never a literal marker
  // 3 (run FIRST): an ORDINARY run on a candidate-bearing item whose candidate owns
  //    nested _output AND _log openers, with an input that emits fresh output AND a log
  //    -- pinning clearRunArtifacts and both append transforms on this very item; all
  //    three fixtures persist before ONE shared reload
  await loadAdmin(page)
  const candidate = '```vault_result_v1\nnot base64\n```js_input\nwindow._candidate_input = true\n```_output\nnested output\n```_log\nnested log\n```'
  const inner = '```vault_result_v1\nnot base64\n```'
  const names = ['#e2e_run_mixed/run', '#e2e_run_mixed', '#e2e_run_inner/run', '#e2e_run_inner', '#e2e_run_plain']
  const cleanup = () =>
    page.evaluate(names => {
      for (const name of names) if (window._exists(name)) window._item(name)!.delete(false)
    }, names)
  await cleanup() // fixed fixture names: clear residue from an earlier failed attempt
  try {
    // ALL THREE fixtures created and persisted before ONE shared reload (review 152 §3)
    await page.evaluate(
      ([candidate, inner]) => {
        void window._create('#e2e_run_mixed real\n```js_input\nwindow._real_input = true\n```\n' + candidate)
        void window._create('#e2e_run_inner real\n```js_input\nwindow._real_input = true\n' + inner + '\n```')
        void window._create(
          "#e2e_run_plain\n```js_input\n_this.log('fresh log')\n1 + 1\n```\n" +
            candidate +
            '\n```_output\nold output\n```\n```_log\nold log\n```'
        )
      },
      [candidate, inner] as const
    )
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_run_plain', true)?.saved_id ?? null), { timeout: 30_000 })
      .toBeTruthy()
    for (const name of ['#e2e_run_mixed', '#e2e_run_inner']) {
      await expect
        .poll(() => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name), { timeout: 30_000 })
        .toBeTruthy()
      const id = await page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)
      await firestore()
        .collection('items')
        .doc(id!)
        .update({ attr: { source: 'https://github.com/olcan/mind.items/blob/master/e2e.md' } })
    }
    // reload before clicking: the run button passes its component's render-time index
    // prop, which a mid-session create can reshuffle (recorded app backfill, review 151
    // §5) -- and mark nothing previewable so a residue item's rejected preview fetch
    // cannot strand the deferred run
    await page.reload()
    await waitForApp(page)
    const runItem = async (name: string) => {
      await page.evaluate(name => void (location.hash = name), name)
      const id = await page.evaluate(name => window._item(name)!.id, name)
      const run = page.locator(`[data-item-id="${id}"] .button.run`)
      await expect(run).toHaveCount(1, { timeout: 30_000 })
      await page.evaluate(() => window.__items.forEach(item => ((item as any).previewable = false)))
      await run.click()
    }
    // PHASE 3 FIRST (ordinary run, before any child creation can reshuffle indices):
    // fresh output AND log land beside the byte-exact candidate whose body holds nested
    // _output/_log openers -- pinning clearRunArtifacts and both append transforms
    await runItem('#e2e_run_plain')
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_run_plain')!.text), { timeout: 30_000 })
      .toContain('```_output\n2\n```') // fresh output appended on this item
    const plainText = await page.evaluate(() => window._item('#e2e_run_plain')!.text)
    expect(plainText, 'the candidate survived cleanup + both appends exactly').toContain(candidate)
    // the OUTER _log block: the grammar view masks the candidate's nested _log, and
    // typed read('_log') extraction excludes the separate js_input block -- so the
    // sentinel can only come from the appended block (review 152 §2.4, 153 §3)
    expect(
      await page.evaluate(() => (window._item('#e2e_run_plain') as any).read('_log')),
      'the fresh log landed in the outer _log block'
    ).toContain('fresh log')
    expect(plainText, 'the old output was cleared').not.toContain('old output')
    expect(plainText, 'the old log was removed').not.toContain('old log')
    // PHASE 1: sibling candidate -- only the real input is copied
    await runItem('#e2e_run_mixed')
    await expect.poll(() => page.evaluate(() => window._exists('#e2e_run_mixed/run')), { timeout: 30_000 }).toBe(true)
    const runText = await page.evaluate(() => window._item('#e2e_run_mixed/run')!.text)
    expect(runText, 'the real input was copied').toContain('window._real_input')
    expect(runText, 'the candidate-nested input was NOT copied').not.toContain('window._candidate_input')
    // the source-side selection left the parent untouched: its candidate is byte-exact
    // (the installed run's cleanup/publication then operate on the child, not here)
    expect(
      await page.evaluate(() => window._item('#e2e_run_mixed')!.text),
      'parent candidate source intact'
    ).toContain(candidate)
    // PHASE 2: candidate inside the selected input -- exact envelope, never a marker
    await runItem('#e2e_run_inner')
    await expect.poll(() => page.evaluate(() => window._exists('#e2e_run_inner/run')), { timeout: 30_000 }).toBe(true)
    const innerRunText = await page.evaluate(() => window._item('#e2e_run_inner/run')!.text)
    expect(innerRunText, 'the inner candidate rode along as its exact raw envelope').toContain(inner)
    expect(innerRunText, 'no literal marker escaped into the child').not.toContain('\u27e6vault_result_v1:')
  } finally {
    await cleanup()
  }
})