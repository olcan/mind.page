// SWEEP SMOKE (standalone, like dev_smoke/function_smoke): drives scripts/sweep-v0-items.mjs
// end-to-end against the Firestore emulator — the CLI/envelope/profile guard matrix, anomaly
// refusals with zero writes, the non-mutating preflight, execute with per-item verification,
// the write-ahead journal (target binding; never skip authority), the post-scan concurrency
// fence, and classification-only resume. Run under the emulator:
//
//   firebase emulators:exec --only firestore 'node tests/e2e/sweep_smoke.mjs'
//
// Exits nonzero on the first failed expectation.

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { pathToFileURL } from 'node:url'

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('sweep smoke must run under `firebase emulators:exec` (FIRESTORE_EMULATOR_HOST unset)')
  process.exit(1)
}

const UID = 'sweep_e2e'
const PROJECT = 'olcanswiki'
const dir = mkdtempSync(join(tmpdir(), 'sweep-smoke-'))
await build({
  configFile: false,
  logLevel: 'silent',
  build: {
    lib: { entry: new URL('../../src/crypto.ts', import.meta.url).pathname, formats: ['es'], fileName: () => 'crypto.mjs' },
    outDir: dir,
    emptyOutDir: true,
    minify: false,
  },
})
const crypto = await import(pathToFileURL(join(dir, 'crypto.mjs')).href)

initializeApp({ credential: applicationDefault(), projectId: PROJECT })
const db = getFirestore()

// the account keys and envelope, exactly as a device would hold them after establishment
const SALT = Buffer.from(new Uint8Array(16).fill(9)).toString('base64') // canonical 16-byte b64
const SALT_OTHER = Buffer.from(new Uint8Array(16).fill(1)).toString('base64')
const V0_SECRET = Buffer.from('sweep-smoke-v0-secret-material==', 'utf8').toString('base64')
const V1_KEY_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256)
const v1key = await crypto.importV1Key(V1_KEY_BYTES, ['encrypt', 'decrypt'])
const envelopeOf = over =>
  JSON.stringify({ uid: UID, v: 1, salt: SALT, key: Buffer.from(V1_KEY_BYTES).toString('base64'), v0: V0_SECRET, ...over })
const ENVELOPE = envelopeOf({})

// ---- seed --------------------------------------------------------------------------------------
const T = 1700000000000
const item = (over = {}) => ({ user: UID, time: T, hidden: false, text: null, attr: null, ...over })
await db.collection('users').doc(UID).set({ kdf: { v: 1, salt: SALT } })
const plains = {
  'sweep-v0-a': JSON.stringify({ text: '#sweep_a v0 visible 111', attr: null }),
  'sweep-v0-b': JSON.stringify({ text: '#sweep_b v0 visible 222', attr: null }),
  'sweep-v0-hidden': JSON.stringify({ text: JSON.stringify({ name: 'global_store_x', item: { k: 1 } }), attr: null }),
}
const seedV0 = async () => {
  let n = 1
  for (const [id, plain] of Object.entries(plains))
    await db
      .collection('items')
      .doc(id)
      .set(
        item({
          cipher: await crypto.encryptWithSecret(plain, V0_SECRET),
          hidden: id.includes('hidden'),
          time: T + n++,
          extra: { nested: { deep: 41 } }, // unknown-field sentinel: must survive untouched
        })
      )
}
await seedV0()
const V1_PLAIN = JSON.stringify({ text: '#sweep_v1 already v1 333', attr: null })
await db.collection('items').doc('sweep-v1').set(item({ cipher: await crypto.encryptV1Text(V1_PLAIN, v1key), time: T + 4 }))
await db.collection('items').doc('sweep-clear').set(item({ text: '#sweep_shared clear by design', attr: { shared: { keys: ['k'] } }, time: T + 5 }))
await db.collection('items').doc('sweep-foreign').set(item({ user: 'someone_else', cipher: await crypto.encryptWithSecret('{"text":"foreign","attr":null}', V0_SECRET) }))
// anomalies (removed after the refusal rows): the app's frozen rule makes present non-strings CORRUPT
await db.collection('items').doc('anom-empty').set(item({ cipher: '' }))
await db.collection('items').doc('anom-number').set(item({ cipher: 7 }))
await db.collection('items').doc('anom-frame').set(item({ cipher: '9!not-a-real-frame' }))
await db.collection('items').doc('anom-plain').set(item({ text: 'private plaintext row' }))
await db.collection('items').doc('anom-empty-doc').set(item({}))
await db.collection('items').doc('anom-mixed-v0').set(item({ cipher: await crypto.encryptWithSecret('{"text":"m","attr":null}', V0_SECRET), text: 'leaked plaintext beside cipher' }))
await db.collection('items').doc('anom-mixed-v1').set(item({ cipher: await crypto.encryptV1Text('{"text":"m","attr":null}', v1key), attr: { anything: 1 } }))
await db.collection('items').doc('anom-shared-bare').set(item({ attr: { shared: { keys: ['k'] } } }))
// a second uid with a malformed profile
await db.collection('users').doc('sweep_badprof').set({ kdf: { v: 2, salt: SALT } })
await db.collection('items').doc('badprof-v0').set(item({ user: 'sweep_badprof', cipher: await crypto.encryptWithSecret('{"text":"x","attr":null}', V0_SECRET) }))
console.log('seeded')

// ---- driver ------------------------------------------------------------------------------------
const SCRIPT = new URL('../../scripts/sweep-v0-items.mjs', import.meta.url).pathname
let checks = 0
const check = (cond, what) => {
  checks++
  if (!cond) {
    console.error(`FAIL: ${what}`)
    process.exit(1)
  }
  console.log(`ok: ${what}`)
}
// ONE bounded child helper: a hung tool is a HARNESS FAILURE (immediate exit), never mistaken
// for an expected refusal — a timeout maps to check(false), not to code 1
function runChild(args, env, timeoutMs = 90000) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    return { code: 0, out }
  } catch (e) {
    if (e.signal) check(false, `child killed by ${e.signal} (timeout?): node ${args.join(' ')}`)
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}
function run(args, env = {}) {
  return runChild(args, { ...process.env, MIND_SWEEP_ENVELOPE: ENVELOPE, ...env })
}
const BASE = ['--project', PROJECT, '--uid', UID, '--emulator']
const v0Count = async id => crypto.classifyTextCipher((await db.collection('items').doc(id).get()).data().cipher)

// ---- CLI + envelope + profile guard matrix (each refuses before any write) ---------------------
check(run(['--project', PROJECT, '--project', PROJECT, '--uid', UID, '--emulator']).code == 1, 'duplicate --project refused')
check(run(['--project', PROJECT, '--emulator']).code == 1, 'missing --uid refused')
check(run([...BASE, '--execute']).code == 1, '--execute without --journal refused')
check(run([...BASE, '--limit', '1']).code == 1, '--limit without --execute refused')
check(run(['--project', PROJECT, '--uid', UID]).code == 1, 'emulator env without --emulator refused')
{
  const env = { ...process.env, MIND_SWEEP_ENVELOPE: ENVELOPE }
  delete env.FIRESTORE_EMULATOR_HOST
  check(runChild([...BASE], env, 30000).code == 1, '--emulator without emulator env refused (inverse guard)')
  const r = runChild(['--project', PROJECT, '--uid', UID, '--hold', '/tmp/x'], env, 30000)
  check(r.code == 1 && r.out.includes('emulator-only test seam'), '--hold without --emulator hits the hold-specific guard')
}
// PRODUCTION MANIFEST (pre-credential: no emulator env, no valid envelope needed — acceptance is
// proven by reaching the missing-envelope guard without loading credentials or touching firestore)
{
  const env = { ...process.env }
  delete env.FIRESTORE_EMULATOR_HOST
  delete env.MIND_SWEEP_ENVELOPE
  const prod = args => runChild(args, env, 30000)
  check(prod(['--project', 'other-project', '--uid', 'y2swh7JY2ScO5soV7mJMHVltAOX2']).out.includes('scoped to project'), 'production wrong project refused')
  check(prod(['--project', PROJECT, '--uid', 'someRandomUid123']).out.includes('two-account manifest'), 'production unknown uid refused')
  check(prod(['--project', PROJECT, '--uid', 'constructor']).out.includes('two-account manifest'), 'production INHERITED name (constructor) refused — own-property manifest')
  for (const real of ['y2swh7JY2ScO5soV7mJMHVltAOX2', 'tLpxg7IZcYS5kn6E0ZcD0CInwbY2'])
    check(prod(['--project', PROJECT, '--uid', real]).out.includes('MIND_SWEEP_ENVELOPE is required'), `production uid accepted pre-credential: ${real.slice(0, 6)}…`)
}
check(run(BASE, { MIND_SWEEP_ENVELOPE: '' }).code == 1, 'missing envelope refused')
check(run(BASE, { MIND_SWEEP_ENVELOPE: 'not json' }).code == 1, 'malformed envelope refused')
check(run(BASE, { MIND_SWEEP_ENVELOPE: envelopeOf({ uid: 'someone_else' }) }).code == 1, 'wrong-uid envelope refused')
check(run(BASE, { MIND_SWEEP_ENVELOPE: envelopeOf({ salt: SALT_OTHER }) }).code == 1, 'envelope salt != committed profile salt refused')
check(
  run(['--project', PROJECT, '--uid', 'sweep_badprof', '--emulator'], { MIND_SWEEP_ENVELOPE: envelopeOf({ uid: 'sweep_badprof' }) }).code == 1,
  'malformed committed profile refused'
)

// ---- anomaly refusal: the preflight lists every anomaly and writes nothing ---------------------
{
  const j = join(dir, 'anom.jsonl')
  const { code, out } = run([...BASE, '--execute', '--journal', j])
  check(code == 1, 'EXECUTE refuses while anomalies exist')
  for (const id of ['anom-empty', 'anom-number', 'anom-frame', 'anom-plain', 'anom-empty-doc', 'anom-mixed-v0', 'anom-mixed-v1', 'anom-shared-bare'])
    check(out.includes(`anomaly ${id}:`), `anomaly listed: ${id}`)
  check((await v0Count('sweep-v0-a')) == 'v0', 'no database write during the anomaly refusal')
  let journalExists = true
  try { readFileSync(j) } catch { journalExists = false }
  check(!journalExists, 'no journal was created during the anomaly refusal')
}
for (const id of ['anom-empty', 'anom-number', 'anom-frame', 'anom-plain', 'anom-empty-doc', 'anom-mixed-v0', 'anom-mixed-v1', 'anom-shared-bare'])
  await db.collection('items').doc(id).delete()

// EVERY candidate and EVERY v1 row are verified BEFORE any write: a lexicographically LATER bad
// row must protect the earlier good ones (zero writes), in execute mode
{
  const otherSecret = Buffer.from('another-secret-material-other!==').toString('base64')
  await db.collection('items').doc('zz-bad-v0').set(item({ cipher: await crypto.encryptWithSecret('{"text":"z","attr":null}', otherSecret), time: T + 50 }))
  let r = run([...BASE, '--execute', '--journal', join(dir, 'bad1.jsonl')])
  check(r.code == 1 && r.out.includes('zz-bad-v0'), 'a later wrong-secret v0 candidate refuses the whole run')
  check((await v0Count('sweep-v0-a')) == 'v0', 'earlier good candidates untouched (decrypt-all before write-any)')
  await db.collection('items').doc('zz-bad-v0').delete()
  const otherKey = await crypto.importV1Key(new Uint8Array(32).fill(5), ['encrypt', 'decrypt'])
  await db.collection('items').doc('zz-bad-v1').set(item({ cipher: await crypto.encryptV1Text('{"text":"z","attr":null}', otherKey), time: T + 51 }))
  r = run([...BASE, '--execute', '--journal', join(dir, 'bad2.jsonl')])
  check(r.code == 1 && r.out.includes('zz-bad-v1'), 'a second v1 row under another key refuses the run (every v1 checked)')
  check((await v0Count('sweep-v0-a')) == 'v0', 'still zero writes')
  await db.collection('items').doc('zz-bad-v1').delete()
}

// ---- wrong key material fails preflight against the LIVE corpus --------------------------------
check(
  run(BASE, { MIND_SWEEP_ENVELOPE: envelopeOf({ v0: Buffer.from('wrong-v0-secret-material-wrong==').toString('base64') }) }).code == 1,
  'envelope with wrong bound v0 secret fails candidate preflight'
)
check(
  run(BASE, { MIND_SWEEP_ENVELOPE: envelopeOf({ key: Buffer.from(new Uint8Array(32)).toString('base64') }) }).code == 1,
  'envelope with wrong key fails v1-row preflight'
)

// ---- no-v1-witness refusal for execute ---------------------------------------------------------
{
  const v1doc = (await db.collection('items').doc('sweep-v1').get()).data()
  await db.collection('items').doc('sweep-v1').delete()
  const { code, out } = run([...BASE, '--execute', '--journal', join(dir, 'jx.jsonl')])
  check(code == 1 && out.includes('no existing v1 row'), 'execute refuses with zero v1 witnesses')
  const dry = run(BASE)
  check(dry.code == 1 && dry.out.includes('no existing v1 row'), 'DRY RUN also refuses with zero v1 witnesses')
  await db.collection('items').doc('sweep-v1').set(v1doc)
}

// ---- dry run (the full non-mutating preflight) -------------------------------------------------
{
  const { code, out } = run(BASE)
  check(code == 0, 'dry run passes on the clean corpus')
  check(out.includes('v0=3') && out.includes('v1=1') && out.includes('shared-clear=1'), 'dry run counts are exact')
  check(out.includes('all 3 v0 candidates and 1 v1 rows decrypt-verified'), 'dry run decrypt-verifies everything')
  check((await v0Count('sweep-v0-a')) == 'v0', 'dry run wrote nothing')
}

// ---- execute: limit, then full; per-item verification ------------------------------------------
const JOURNAL = join(dir, 'journal.jsonl')
{
  const { code, out } = run([...BASE, '--execute', '--journal', JOURNAL, '--limit', '1'])
  check(code == 0 && out.includes('swept 1 of 3'), 'limited execute sweeps exactly one')
}
{
  const { code, out } = run([...BASE, '--execute', '--journal', JOURNAL])
  check(code == 0 && out.includes('swept 2 of 2'), 'full execute sweeps the remaining two (classification resume)')
}
{
  let n = 1
  for (const [id, plain] of Object.entries(plains)) {
    const d = (await db.collection('items').doc(id).get()).data()
    check(crypto.classifyTextCipher(d.cipher) == 'v1', `${id} is v1 at rest`)
    check((await crypto.decryptV1Text(d.cipher, v1key)) === plain, `${id} plaintext parity`)
    check(d.time === T + n++, `${id} time preserved`)
    check(d.hidden === id.includes('hidden'), `${id} hidden flag intact`)
    check(d.extra?.nested?.deep === 41, `${id} unknown nested field untouched`)
  }
  const { statSync } = await import('node:fs')
  check((statSync(JOURNAL).mode & 0o777) == 0o600, 'a freshly created journal is 0600')
  const lines = readFileSync(JOURNAL, 'utf8').trim().split('\n')
  const head = JSON.parse(lines[0])
  check(head.format == 'mindpage-sweep-v1' && head.uid == UID && head.salt == SALT, 'journal header is target-bound')
  const logged = lines.slice(1).map(l => JSON.parse(l))
  check(logged.length == 3, 'journal holds one before-cipher line per swept row')
  for (const { id, beforeCipher } of logged)
    check((await crypto.decryptWithSecret(beforeCipher, V0_SECRET)) === plains[id], `journal beforeCipher for ${id} decrypts to the original`)
  const v1d = (await db.collection('items').doc('sweep-v1').get()).data()
  check((await crypto.decryptV1Text(v1d.cipher, v1key)) === V1_PLAIN, 'pre-existing v1 row untouched')
  const c = (await db.collection('items').doc('sweep-clear').get()).data()
  check(c.text?.includes('clear by design'), 'shared-clear row untouched')
  check((await v0Count('sweep-foreign')) == 'v0', 'foreign-uid row untouched')
}
{
  const { code, out } = run(BASE) // NO journal at all: the truly journal-blind zero check
  check(code == 0 && out.includes('dry run complete: 0 candidates'), 'journal-blind no-journal dry rescan finds zero candidates')
}
check(run([...BASE, '--execute', '--journal', JOURNAL]).code == 0, 'reusing the matching validated journal is allowed')
{
  // a journal for a DIFFERENT target must be refused
  const other = join(dir, 'other.jsonl')
  writeFileSync(other, JSON.stringify({ format: 'mindpage-sweep-v1', project: PROJECT, uid: 'someone_else', salt: SALT }) + '\n')
  const { code, out } = run([...BASE, '--execute', '--journal', other])
  check(code == 1 && out.includes('journal uid does not match'), 'mismatched journal target refused')
}

// ---- a logged-but-still-v0 id is WORK, never skipped -------------------------------------------
{
  const plain = JSON.stringify({ text: '#sweep_relapse v0 again', attr: null })
  const relapseCipher = await crypto.encryptWithSecret(plain, V0_SECRET)
  await db.collection('items').doc('sweep-relapse').set(item({ cipher: relapseCipher, time: T + 9 }))
  const HEAD = JSON.stringify({ format: 'mindpage-sweep-v1', project: PROJECT, uid: UID, salt: SALT })
  // an existing journal must validate as a RECOVERY SOURCE before any write
  const badBody = join(dir, 'badbody.jsonl')
  writeFileSync(badBody, HEAD + '\n' + JSON.stringify({ id: 'sweep-relapse', beforeCipher: 'x' }) + '\n')
  let r = run([...BASE, '--execute', '--journal', badBody])
  check(r.code == 1 && r.out.includes('not a v0 frame'), 'a journal body record with a non-v0 beforeCipher is refused')
  check((await v0Count('sweep-relapse')) == 'v0', 'and the candidate is untouched')
  // a STRUCTURALLY VALID v0 frame under another secret pins the decrypt-under-bound-secret branch
  const foreignCipher = await crypto.encryptWithSecret('{"text":"f","attr":null}', Buffer.from('another-secret-material-other!==').toString('base64'))
  const badAuth = join(dir, 'badauth.jsonl')
  writeFileSync(badAuth, HEAD + '\n' + JSON.stringify({ id: 'sweep-relapse', beforeCipher: foreignCipher }) + '\n')
  r = run([...BASE, '--execute', '--journal', badAuth])
  check(r.code == 1 && r.out.includes('does not decrypt under the bound v0 secret'), 'a foreign-secret journal record is refused')
  const relapseNow = async () => (await db.collection('items').doc('sweep-relapse').get()).data().cipher
  check((await relapseNow()) === relapseCipher, 'candidate cipher is BYTE-IDENTICAL after the refusal')
  const badShape = join(dir, 'badshape.jsonl')
  writeFileSync(badShape, HEAD + '\n' + JSON.stringify({ id: 'sweep-relapse', beforeCipher: relapseCipher, extra: 1 }) + '\n')
  r = run([...BASE, '--execute', '--journal', badShape])
  check(r.code == 1 && r.out.includes('not an { id, beforeCipher } record'), 'an extra-field journal record is refused')
  check((await relapseNow()) === relapseCipher, 'still byte-identical after the shape refusal')
  const truncated = join(dir, 'trunc.jsonl')
  writeFileSync(truncated, HEAD + '\n' + JSON.stringify({ id: 'sweep-relapse', beforeCipher: relapseCipher })) // no trailing newline
  r = run([...BASE, '--execute', '--journal', truncated])
  check(r.code == 1 && r.out.includes('not newline-terminated'), 'a truncated journal (no final newline) is refused')
  const j = join(dir, 'relapse.jsonl')
  writeFileSync(j, HEAD + '\n' + JSON.stringify({ id: 'sweep-relapse', beforeCipher: relapseCipher }) + '\n')
  r = run([...BASE, '--execute', '--journal', j])
  check(r.code == 0 && r.out.includes('swept 1 of 1'), 'a journal-logged id that is currently v0 is migrated, never skipped')
  check((await v0Count('sweep-relapse')) == 'v1', 'the relapsed row is v1 at rest')
  const { statSync, chmodSync } = await import('node:fs')
  check((statSync(j).mode & 0o777) == 0o600, 'the appended journal is 0600')
  chmodSync(j, 0o644)
  r = run([...BASE, '--execute', '--journal', j])
  check(r.code == 0, 'reusing the loosened journal succeeds (zero candidates path validates it)')
  check((statSync(j).mode & 0o777) == 0o600, 'a pre-existing 0644 journal is normalized to 0600 on reuse')
}

// ---- the concurrency fence: a post-scan save STOPS the run and loses nothing -------------------
{
  const pA = JSON.stringify({ text: '#conc_a', attr: null })
  const pB = JSON.stringify({ text: '#conc_b OLD', attr: null })
  await db.collection('items').doc('conc-a').set(item({ cipher: await crypto.encryptWithSecret(pA, V0_SECRET), time: T + 20 }))
  await db.collection('items').doc('conc-b').set(item({ cipher: await crypto.encryptWithSecret(pB, V0_SECRET), time: T + 21 }))
  const holdPath = join(dir, 'hold')
  const j = join(dir, 'conc.jsonl')
  const child = spawn('node', [SCRIPT, ...BASE, '--execute', '--journal', j, '--hold', holdPath], {
    env: { ...process.env, MIND_SWEEP_ENVELOPE: ENVELOPE },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise(res => child.on('exit', res)) // installed IMMEDIATELY: a fast exit is never missed
  let out = ''
  child.stdout.on('data', d => (out += d))
  child.stderr.on('data', d => (out += d))
  {
    const deadline = Date.now() + 60000
    while (!out.includes('holding before first write')) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        check(false, `held run never reached the pre-write seam; output: ${out.slice(0, 400)}`)
      }
      await new Promise(r => setTimeout(r, 50))
    }
  }
  // the scan is complete and held; a "live tab" now saves a NEWER version of conc-b
  const pB2 = JSON.stringify({ text: '#conc_b NEWER SAVE', attr: null })
  const newer = await crypto.encryptWithSecret(pB2, V0_SECRET)
  await db.collection('items').doc('conc-b').update({ cipher: newer, time: T + 99 })
  writeFileSync(holdPath, '1')
  let timer
  const code = await Promise.race([
    exited,
    new Promise(res => (timer = setTimeout(() => res('timeout'), 120000))),
  ])
  clearTimeout(timer) // an uncancelled timer kept the whole smoke alive for its full 120s
  if (code === 'timeout') child.kill('SIGKILL')
  check(code == 3, 'the run STOPS on the post-scan save (conditional write fence)')
  // BATCH WRITE-AHEAD: the failed later row's EXACT old cipher was durably journaled BEFORE any
  // write — it must decrypt to the pre-conflict plaintext, not merely share the id
  const jl = readFileSync(j, 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l))
  const concRec = jl.find(rec => rec.id == 'conc-b')
  check(!!concRec, "the conflicted row's beforeCipher was journaled ahead of the writes")
  check((await crypto.decryptWithSecret(concRec.beforeCipher, V0_SECRET)) === pB, 'and it decrypts to the exact pre-conflict plaintext')
  check(out.includes('conc-b') && out.includes('conditional write'), 'the stop names the conflicted row and stage')
  const b = (await db.collection('items').doc('conc-b').get()).data()
  check(b.cipher === newer && b.time === T + 99, 'the newer save is byte-for-byte untouched')
  check((await v0Count('conc-a')) == 'v1', 'the pre-conflict candidate was swept normally')
  // cleanup for a clean final state
  await db.collection('items').doc('conc-b').update({ cipher: await crypto.encryptV1Text(pB2, v1key) })
}
console.log(`sweep smoke: ${checks} checks passed`)
