// PRODUCTION HISTORY AUDIT (reviews 93-94) — owner-run, READ-ONLY (no mutation path exists).
//
// Every existing-item save since 7089dc4d (2024-06-27) published a PLAINTEXT copy of the item
// into `history` (the awaited in-place decrypt stripped the cipher before the history spread),
// and the old `/_backup` wrote plaintext history by design. Both paths are fixed; this script
// measures what the corpus actually holds so the owner can choose a policy — purge, re-encrypt,
// or explicitly accept — with evidence.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> \
//     node scripts/audit-history.mjs --project <project-id> (--uid <uid> | --all)
//
// The COMPLETE collection is paged by document id (never by `time`: ordering by a field excludes
// documents missing it), and every classification — time bucket and uid scope included — happens
// locally. Buckets follow the policy-relevant partition (review 94 §3.2):
//   private-plaintext   any `text` NOT provably expected-clear (the exposure to decide about)
//   expected-clear      `user == 'anonymous'` or truthy `attr.shared` (clear by design)
//   cipher-only         encrypted rows (no `text`)
//   neither             no text and no cipher
// Private-plaintext rows carrying BOTH text and cipher get a separate subcount (still counted
// as exposure; expected-clear rows are not in it). With --uid, non-target rows — other users
// AND rows missing a user — are still scanned and reported as an aggregate line.

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldPath } from 'firebase-admin/firestore'
import { parseArgs } from 'node:util'

// STRICT CLI (reviews 95-96 §3): a hand-rolled parser let `--uid` swallow the next flag or pass
// with no value, silently auditing a fictitious scope — and parseArgs alone is LAST-VALUE-WINS
// on repeated options, so `--project a --project b` would silently audit b. parseArgs rejects
// unknown flags and positionals; the token stream rejects DUPLICATES; the checks below reject
// malformed values and conflicting scopes. everything fails before any credential or read
let parsed
try {
  parsed = parseArgs({
    options: {
      project: { type: 'string' },
      uid: { type: 'string' },
      all: { type: 'boolean' },
    },
    allowPositionals: false,
    tokens: true,
  })
} catch (e) {
  console.error(String(e?.message ?? e))
  console.error('usage: node scripts/audit-history.mjs --project <project-id> (--uid <uid> | --all)')
  process.exit(1)
}
const seen = new Set()
for (const token of parsed.tokens) {
  if (token.kind != 'option') continue
  if (seen.has(token.name)) {
    console.error(`duplicate option --${token.name}: a repeated target or scope could silently audit the wrong one`)
    process.exit(1)
  }
  seen.add(token.name)
}
const { project, uid, all } = parsed.values

// TARGET GUARD (review 94 §3.3): the Admin SDK follows ambient credentials, and a leftover
// emulator variable silently redirects it — an audit that cannot say which database it read is
// not evidence
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('refusing to run: FIRESTORE_EMULATOR_HOST is set (this audit targets PRODUCTION)')
  process.exit(1)
}
if (typeof project != 'string' || !project || project.startsWith('-')) {
  console.error('usage: node scripts/audit-history.mjs --project <project-id> (--uid <uid> | --all)')
  process.exit(1)
}
if (uid !== undefined && (!uid || uid.startsWith('-'))) {
  console.error('--uid requires a nonempty uid value')
  process.exit(1)
}
if ((uid === undefined) === !all) {
  console.error('specify EXACTLY ONE of --uid <uid> (scoped report) or --all (no scope)')
  process.exit(1)
}

const app = initializeApp({ credential: applicationDefault(), projectId: project })
console.log(`auditing project ${project}, scope ${uid ? `uid ${uid}` : 'ALL users'} (read-only)`)

const db = getFirestore(app)
const months = new Map() // 'YYYY-MM' | 'no-time' | 'bad-time' -> bucket counts
const bucketOf = data => {
  const hasText = data.text !== null && data.text !== undefined
  const hasCipher = data.cipher !== null && data.cipher !== undefined
  const expectedClear = data.user === 'anonymous' || !!(data.attr && data.attr.shared)
  if (hasText) return expectedClear ? 'expectedClear' : 'privatePlaintext'
  if (hasCipher) return 'cipherOnly'
  return 'neither'
}
const monthOf = data => {
  const t = data.time
  if (t === null || t === undefined) return 'no-time'
  const when = typeof t == 'number' ? new Date(t) : typeof t?.toDate == 'function' ? t.toDate() : null
  if (!when || isNaN(when.getTime())) return 'bad-time'
  return `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}`
}

let scanned = 0
let otherUsers = { rows: 0, privatePlaintext: 0 }
let textAndCipher = 0
const samples = []
let last = null
for (;;) {
  let query = db.collection('history').orderBy(FieldPath.documentId()).limit(1000)
  if (last) query = query.startAfter(last)
  const page = await query.get()
  if (page.empty) break
  for (const doc of page.docs) {
    scanned++
    const data = doc.data()
    const bucket = bucketOf(data)
    if (uid && data.user !== uid) {
      otherUsers.rows++
      if (bucket == 'privatePlaintext') otherUsers.privatePlaintext++
      continue
    }
    const key = monthOf(data)
    const row = months.get(key) ?? { total: 0, privatePlaintext: 0, expectedClear: 0, cipherOnly: 0, neither: 0 }
    row.total++
    row[bucket]++
    months.set(key, row)
    if (bucket == 'privatePlaintext') {
      if (data.cipher !== null && data.cipher !== undefined) textAndCipher++
      if (samples.length < 20) samples.push(doc.id)
    }
  }
  last = page.docs[page.docs.length - 1]
  process.stderr.write(`\rscanned ${scanned} history rows ...`)
}
process.stderr.write('\n')

console.log(`\nhistory audit: ${scanned} rows scanned`)
console.log('month      total  private-plaintext  expected-clear  cipher-only  neither')
for (const [key, row] of [...months.entries()].sort()) {
  console.log(
    `${key.padEnd(10)} ${String(row.total).padStart(5)}  ${String(row.privatePlaintext).padStart(17)}  ` +
      `${String(row.expectedClear).padStart(14)}  ${String(row.cipherOnly).padStart(11)}  ${String(row.neither).padStart(7)}`
  )
}
if (textAndCipher) console.log(`\nrows carrying BOTH text and cipher (counted as private-plaintext): ${textAndCipher}`)
if (uid)
  console.log(
    `non-target/unknown rows (other or missing user): ${otherUsers.rows}, ` +
      `${otherUsers.privatePlaintext} private-plaintext`
  )
if (samples.length) {
  console.log(`\nsample private-plaintext row ids (up to 20):`)
  for (const id of samples) console.log(`  history/${id}`)
}
console.log('\nNOTE read-only. The purge / re-encrypt / accept decision belongs to the owner with these numbers in hand.')
await db.terminate()
