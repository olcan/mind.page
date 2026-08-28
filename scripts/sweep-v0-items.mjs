// V0-RETIREMENT SWEEP (owner-run; reviews 111-112) — re-encrypts every remaining v0 item cipher
// to v1 for ONE account, from the vault side, per the KDF design's constraints
// (notes/design/mind_page_kdf_migration.md in the vault repo). The owner-decided scope is EXACTLY
// TWO accounts (the production target manifest below); the v0 reader stays in the app forever.
//
// SAFETY MODEL (each piece exists because review 111 showed its absence loses data):
//   - CONDITIONAL WRITES: every update carries Firestore's { lastUpdateTime } precondition from
//     the scan snapshot, so a save landing after the scan STOPS the run instead of being
//     overwritten by stale plaintext. Quiescence is an operator precaution, not the fence.
//   - WRITE-AHEAD JOURNAL (--journal, required for --execute): a target-bound header plus the
//     COMPLETE selected worklist's { id, beforeCipher } records, appended and fsynced ONCE
//     before the FIRST database write (any journal failure = zero db writes) — the full-corpus
//     recovery source, hidden rows included (which /_backup omits: it iterates only visible
//     items). The journal is NEVER consulted to skip work: current cipher classification is the
//     sole resume mechanism (a rewritten row classifies v1 and is simply no longer a candidate).
//   - ONE BOUND ENVELOPE (MIND_SWEEP_ENVELOPE = the complete localStorage.mindpage_key1 JSON),
//     decoded by the app's OWN decodeKeyEnvelope: uid-bound, salt REQUIRED to equal the
//     account's committed profile salt (decodeKdfMetadata), carrying the establishment's own
//     v0 secret and raw key. Two independently copied values could pair a stale key with the
//     wrong salt and publish rows the current session cannot open.
//   - NON-MUTATING FULL PREFLIGHT before any write: classify every row (the app's frozen rule —
//     a PRESENT non-string/empty cipher is CORRUPT, not clear; explicitly shared clear rows are
//     expected, other clear/plaintext/no-payload rows are anomalies), decrypt-verify EVERY v0
//     candidate with the envelope's v0 secret and EVERY v1 row with its key, and REFUSE on any
//     corrupt/malformed/anomalous/undecryptable row or a zero-v1-witness corpus (dry run
//     included). A dry run IS this preflight.
//   - CRYPTO PARITY: the app's own src/crypto.ts and src/kdf_profile.ts are bundled at startup
//     (vite library build) — frames, AAD, classification, envelope and profile taxonomy are the
//     app's exactly, never reimplemented.
//
// Bytes/images ('~'-framed, in Storage) are a separate deferred decision. `history` is items-only
// scope by design. Secrets are never printed.
//
// Usage: DRY RUN by default (the full non-mutating preflight; writes nothing); --execute
// requires --journal. The envelope is READ FROM A 0600 FILE, never typed inline — the exact,
// copy-safe production commands live in the vault's notes/mind_page_v0_sweep_runbook.md.

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldPath } from 'firebase-admin/firestore'
import { parseArgs } from 'node:util'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// THE PRODUCTION TARGET MANIFEST (review 111 §2.6): the owner's exact decided scope. Outside the
// emulator, --project and --uid must match — a generic single-account query is not enforcement.
const PRODUCTION_PROJECT = 'olcanswiki'
const PRODUCTION_UIDS = {
  y2swh7JY2ScO5soV7mJMHVltAOX2: 'main account (olcans@gmail.com)',
  tLpxg7IZcYS5kn6E0ZcD0CInwbY2: 'olcan@google.com',
}
const JOURNAL_FORMAT = 'mindpage-sweep-v1'

// STRICT CLI, the audit mold: parseArgs rejects unknown flags/positionals; the token stream
// rejects duplicates; value checks fail before any credential or read
let parsed
try {
  parsed = parseArgs({
    options: {
      project: { type: 'string' },
      uid: { type: 'string' },
      execute: { type: 'boolean' },
      journal: { type: 'string' },
      limit: { type: 'string' },
      emulator: { type: 'boolean' },
      hold: { type: 'string' },
    },
    allowPositionals: false,
    tokens: true,
  })
} catch (e) {
  console.error(String(e?.message ?? e))
  console.error(
    'usage: node scripts/sweep-v0-items.mjs --project <project-id> --uid <uid> [--execute --journal <file>] [--limit <n>] [--emulator [--hold <path>]]'
  )
  process.exit(1)
}
const seen = new Set()
for (const token of parsed.tokens) {
  if (token.kind != 'option') continue
  if (seen.has(token.name)) {
    console.error(`duplicate option --${token.name}: a repeated target could silently sweep the wrong one`)
    process.exit(1)
  }
  seen.add(token.name)
}
const { project, uid, execute, journal, limit, emulator, hold } = parsed.values

if (!project || !/^[\w-]+$/.test(project)) {
  console.error('--project <project-id> is required (explicit, never ambient)')
  process.exit(1)
}
if (!uid || !/^\w+$/.test(uid)) {
  console.error('--uid <uid> is required: the sweep is single-account by design')
  process.exit(1)
}
if (execute && !journal) {
  console.error('--execute requires --journal <file>: the write-ahead old-cipher journal is the recovery source')
  process.exit(1)
}
if (limit != null && !execute) {
  console.error('--limit applies to --execute only: a dry run always preflights the COMPLETE corpus')
  process.exit(1)
}
const limitCount = limit == null ? Infinity : Number(limit)
if (limit != null && (!Number.isInteger(limitCount) || limitCount <= 0)) {
  console.error('--limit must be a positive integer')
  process.exit(1)
}
// EMULATOR GUARD, both directions: ambient emulator env must never redirect a production sweep,
// and --emulator must never silently hit production. --hold is a smoke-only pacing seam.
if (process.env.FIRESTORE_EMULATOR_HOST && !emulator) {
  console.error(`FIRESTORE_EMULATOR_HOST is set (${process.env.FIRESTORE_EMULATOR_HOST}); pass --emulator if intended`)
  process.exit(1)
}
if (emulator && !process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('--emulator requires FIRESTORE_EMULATOR_HOST')
  process.exit(1)
}
if (hold && !emulator) {
  console.error('--hold is an emulator-only test seam')
  process.exit(1)
}
// THE PRODUCTION TARGET MANIFEST (see above)
if (!emulator) {
  if (project != PRODUCTION_PROJECT) {
    console.error(`production sweeps are scoped to project ${PRODUCTION_PROJECT} by owner decision`)
    process.exit(1)
  }
  if (!Object.hasOwn(PRODUCTION_UIDS, uid)) {
    console.error('production sweeps are scoped to the owner-reviewed two-account manifest; this uid is not in it')
    process.exit(1)
  }
}

const envelopeRaw = process.env.MIND_SWEEP_ENVELOPE
if (!envelopeRaw) {
  console.error('MIND_SWEEP_ENVELOPE is required: the COMPLETE localStorage.mindpage_key1 JSON from the device')
  process.exit(1)
}

// the app's OWN crypto + profile modules, bundled at startup — never a reimplementation
async function loadAppModules() {
  const { build } = await import('vite')
  const dir = await mkdtemp(join(tmpdir(), 'sweep-app-'))
  let crypto, profile
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        lib: {
          entry: {
            crypto: new URL('../src/crypto.ts', import.meta.url).pathname,
            kdf_profile: new URL('../src/kdf_profile.ts', import.meta.url).pathname,
          },
          formats: ['es'],
        },
        outDir: dir,
        emptyOutDir: true,
        minify: false,
      },
    })
    crypto = await import(pathToFileURL(join(dir, 'crypto.js')).href)
    profile = await import(pathToFileURL(join(dir, 'kdf_profile.js')).href)
  } catch (e) {
    await rm(dir, { recursive: true, force: true }) // build OR import failure cleans the temp dir
    throw e
  }
  return { crypto, profile, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const mode = execute ? 'EXECUTE' : 'DRY RUN'
console.log(
  `v0 sweep target: project=${project} uid=${uid}${emulator ? '' : ` (${PRODUCTION_UIDS[uid]})`} mode=${mode}${emulator ? ' (EMULATOR)' : ''}`
)

const { crypto, profile, cleanup } = await loadAppModules()
// refusals/stops raise CodedExit so the temp-dir cleanup in finally always runs
class CodedExit extends Error {
  constructor(code) {
    super('exit')
    this.code = code
  }
}
const refuse = (code, msg) => {
  console.error(msg)
  throw new CodedExit(code)
}
async function main() {
  // ---- the bound envelope (review 111 §2.3) ---------------------------------------------------
  const envelope = profile.decodeKeyEnvelope(envelopeRaw, uid)
  if (!envelope)
    refuse(1, 'MIND_SWEEP_ENVELOPE is not a valid envelope for this uid (malformed, wrong shape, or wrong account)')
  const v1key = await crypto.importV1Key(envelope.keyBytes, ['encrypt', 'decrypt'])
  const v0secret = envelope.v0Secret

  initializeApp({ credential: applicationDefault(), projectId: project })
  const db = getFirestore()

  // the committed profile must exist and its salt must equal the envelope's — a stale
  // same-account envelope must never publish rows the CURRENT session cannot open
  let committed
  try {
    committed = profile.decodeKdfMetadata((await db.collection('users').doc(uid).get()).data()?.kdf)
  } catch (e) {
    refuse(1, `preflight failed: users/{uid}.kdf is malformed: ${String(e?.message ?? e)}`)
  }
  if (committed.kind != 'valid')
    refuse(1, 'preflight failed: the account has no committed v1 profile — establish v1 in the app first')
  if (committed.profile.salt !== envelope.salt)
    refuse(1, 'preflight failed: envelope salt does not match the committed profile salt (stale envelope?)')

  // ---- the full scan + NON-MUTATING preflight (review 111 §2.4) --------------------------------
  const PAGE = 300
  let last = null
  let total = 0
  const candidates = [] // { id, cipher, time, updateTime }
  const v1rows = [] // { id, cipher }
  let sharedClear = 0
  const anomalies = [] // { id, kind }
  for (;;) {
    let q = db.collection('items').where('user', '==', uid).orderBy(FieldPath.documentId()).limit(PAGE)
    if (last) q = q.startAfter(last)
    const snap = await q.get()
    if (snap.empty) break
    for (const doc of snap.docs) {
      total++
      const data = doc.data()
      const cipher = data.cipher
      const clearText = data.text != null // null AND absent both count as no clear payload
      const clearAttr = data.attr != null
      if (cipher === undefined || cipher === null) {
        // NO cipher. the ONE expected clear shape is an explicitly shared row WITH a clear text
        // payload; a shared marker without payload, private plaintext, or an empty document are
        // anomalies to resolve before a destructive pass
        if (data.attr?.shared && clearText) sharedClear++
        else if (data.attr?.shared) anomalies.push({ id: doc.id, kind: 'shared marker without clear payload' })
        else anomalies.push({ id: doc.id, kind: clearText ? 'private plaintext' : 'no payload' })
        continue
      }
      if (typeof cipher != 'string' || cipher.length == 0) {
        // the app's frozen rule (src/secret.ts): a PRESENT non-string/empty cipher is CORRUPT
        anomalies.push({ id: doc.id, kind: 'corrupt cipher (present non-string or empty)' })
        continue
      }
      if (clearText || clearAttr) {
        // the app's encrypted save shape nulls BOTH clear fields; a cipher row still carrying
        // text/attr is mixed plaintext exposure the cipher-only rewrite would leave in place
        anomalies.push({ id: doc.id, kind: 'mixed plaintext and cipher' })
        continue
      }
      const kind = crypto.classifyTextCipher(cipher)
      if (kind == 'v1') v1rows.push({ id: doc.id, cipher })
      else if (kind == 'v0') candidates.push({ id: doc.id, cipher, time: data.time, updateTime: doc.updateTime })
      else anomalies.push({ id: doc.id, kind: `${kind} cipher frame` })
    }
    last = snap.docs[snap.docs.length - 1]
  }
  console.log(
    `scanned ${total} items: v0=${candidates.length} v1=${v1rows.length} shared-clear=${sharedClear} anomalies=${anomalies.length}`
  )
  if (anomalies.length) {
    for (const a of anomalies) console.error(`  anomaly ${a.id}: ${a.kind}`)
    refuse(1, 'REFUSED: resolve every anomaly before sweeping — nothing was written')
  }
  // decrypt-verify EVERY row against the bound envelope before anything is written: the v0
  // secret must open every candidate, and the key must open every existing v1 row (not merely
  // one arbitrary witness — a stale key could match a subset)
  for (const { id, cipher } of candidates) {
    try {
      await crypto.decryptWithSecret(cipher, v0secret)
    } catch {
      refuse(1, `REFUSED: v0 candidate ${id} does not decrypt with the envelope's v0 secret — nothing was written`)
    }
  }
  for (const { id, cipher } of v1rows) {
    try {
      await crypto.decryptV1Text(cipher, v1key)
    } catch {
      refuse(1, `REFUSED: v1 row ${id} does not decrypt with the envelope key (stale envelope?) — nothing was written`)
    }
  }
  if (v1rows.length == 0)
    refuse(1, 'REFUSED: no existing v1 row to authenticate the envelope key against — save one v1 item in the app first')
  console.log(`preflight ok: all ${candidates.length} v0 candidates and ${v1rows.length} v1 rows decrypt-verified`)
  if (!execute) {
    console.log(`dry run complete: ${candidates.length} candidates are sweepable; nothing was written`)
    return 0
  }
  // ---- the write-ahead journal (reviews 111-112) ------------------------------------------------
  // target-bound header; the COMPLETE selected worklist's { id, beforeCipher } lines are appended
  // and fsynced ONCE before the first database write (any journal failure = zero db writes, and
  // ~one fsync instead of thousands); NEVER read to decide work. an existing journal is validated
  // as a RECOVERY SOURCE: newline-terminated JSONL, the exact target header, and every body
  // record exactly { id, beforeCipher } with a v0-classifying cipher that decrypts under the
  // bound v0 secret (duplicates are legitimate history). validated even with zero candidates.
  const header = { format: JOURNAL_FORMAT, project, uid, salt: envelope.salt }
  const writeAll = (fd, text) => {
    const buf = Buffer.from(text, 'utf8')
    let off = 0
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off)
      if (!(n > 0)) throw new Error('journal write made no progress') // a zero return would loop forever
      off += n
    }
  }
  if (existsSync(journal) && readFileSync(journal, 'utf8').length > 0) {
    const content = readFileSync(journal, 'utf8')
    if (!content.endsWith('\n'))
      refuse(1, 'REFUSED: existing journal is not newline-terminated (truncated write?) — repair or use a fresh file')
    const lines = content.slice(0, -1).split('\n')
    let head
    try {
      head = JSON.parse(lines[0])
    } catch {
      refuse(1, 'REFUSED: existing journal has no parseable header — use a fresh file or the matching prior journal')
    }
    const headKeys = Object.keys(head ?? {}).sort().join(',')
    if (headKeys != 'format,project,salt,uid')
      refuse(1, 'REFUSED: existing journal header has unexpected shape — nothing was written')
    for (const k of ['format', 'project', 'uid', 'salt'])
      if (head[k] !== header[k]) refuse(1, `REFUSED: existing journal ${k} does not match this target — nothing was written`)
    for (let i = 1; i < lines.length; i++) {
      let rec
      try {
        rec = JSON.parse(lines[i])
      } catch {
        refuse(1, `REFUSED: existing journal line ${i + 1} is not valid JSON — nothing was written`)
      }
      const keys = Object.keys(rec ?? {}).sort().join(',')
      if (keys != 'beforeCipher,id' || typeof rec.id != 'string' || typeof rec.beforeCipher != 'string')
        refuse(1, `REFUSED: existing journal line ${i + 1} is not an { id, beforeCipher } record — nothing was written`)
      if (crypto.classifyTextCipher(rec.beforeCipher) != 'v0')
        refuse(1, `REFUSED: existing journal line ${i + 1} beforeCipher is not a v0 frame — not a recovery record`)
      try {
        await crypto.decryptWithSecret(rec.beforeCipher, v0secret)
      } catch {
        refuse(1, `REFUSED: existing journal line ${i + 1} beforeCipher does not decrypt under the bound v0 secret`)
      }
    }
  }
  let fd
  try {
    fd = openSync(journal, 'a', 0o600)
    const { fchmodSync } = await import('node:fs')
    fchmodSync(fd, 0o600) // normalize a pre-existing file: the journal holds retired-KDF ciphertext
    let ahead = readFileSync(journal, 'utf8').length == 0 ? JSON.stringify(header) + '\n' : ''
    for (const { id, cipher } of candidates.slice(0, Math.min(candidates.length, limitCount)))
      ahead += JSON.stringify({ id, beforeCipher: cipher }) + '\n'
    writeAll(fd, ahead)
    fsyncSync(fd) // the COMPLETE worklist's recovery records are durable before any db write
  } catch (e) {
    refuse(1, `REFUSED: journal write failed (${String(e?.message ?? e)}) — nothing was written to the database`)
  }

  if (candidates.length == 0) {
    closeSync(fd)
    console.log('nothing to sweep: zero v0 candidates')
    return 0
  }

  // smoke-only pacing seam: wait for the hold file before the first write (emulator-gated above)
  if (hold) {
    console.log('holding before first write (emulator test seam)')
    while (!existsSync(hold)) await new Promise(r => setTimeout(r, 50))
  }

  // ---- the conditional rewrite pass (review 111 §2.1) ------------------------------------------
  let swept = 0
  const fail = (id, stage, e) => {
    console.error(`STOPPED at ${id} (${stage}): ${String(e?.message ?? e)}`)
    console.error('the journal holds every prior cipher; rerun resumes by classification once the cause is fixed')
    throw new CodedExit(3)
  }
  for (const { id, cipher, time, updateTime } of candidates) {
    if (swept >= limitCount) break
    let plain
    try {
      plain = await crypto.decryptWithSecret(cipher, v0secret) // second decrypt, in-turn (cheap)
    } catch (e) {
      fail(id, 'v0 decrypt', e)
    }
    let next
    try {
      next = await crypto.encryptV1Text(plain, v1key)
      const back = await crypto.decryptV1Text(next, v1key)
      if (back !== plain) throw new Error('local roundtrip mismatch')
    } catch (e) {
      fail(id, 'v1 encrypt/local verify', e)
    }
    const ref = db.collection('items').doc(id)
    try {
      // THE FENCE: any save/delete/recreate after the scan fails this precondition and stops the
      // run before the row is changed — stale plaintext can never overwrite a newer save
      await ref.update({ cipher: next }, { lastUpdateTime: updateTime })
    } catch (e) {
      fail(id, 'conditional write (document changed since scan?)', e)
    }
    try {
      const after = (await ref.get()).data()
      if (typeof after?.cipher != 'string' || crypto.classifyTextCipher(after.cipher) != 'v1')
        throw new Error('readback is not v1')
      const back = await crypto.decryptV1Text(after.cipher, v1key)
      if (back !== plain) throw new Error('readback decrypt mismatch')
      if (after.time !== time) throw new Error('time changed')
    } catch (e) {
      fail(id, 'readback verify', e)
    }
    swept++
  }
  closeSync(fd)
  console.log(
    `swept ${swept} of ${candidates.length} v0 candidates to v1${swept < candidates.length ? ' (limit reached; rerun continues by classification)' : ''}`
  )
  return 0
}

let code
try {
  code = await main()
} catch (e) {
  if (e instanceof CodedExit) code = e.code
  else {
    console.error(`unexpected failure: ${String(e?.message ?? e)}`)
    code = 3
  }
} finally {
  await cleanup()
}
process.exit(code)
