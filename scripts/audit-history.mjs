// PRODUCTION HISTORY AUDIT (review 93 §3) — owner-run, read-only.
//
// Every existing-item save since 7089dc4d (2024-06-27) published a PLAINTEXT copy of the item
// into the `history` collection (the awaited in-place decrypt stripped the cipher before the
// history spread), and the old `/_backup` command wrote plaintext history by design. Both paths
// are fixed in the stage-3 correction; this script measures what the production corpus actually
// holds so the owner can choose a policy (purge, re-encrypt, or explicitly accept) with evidence
// rather than assumption.
//
// Usage (owner credentials; READ-ONLY — this script never writes):
//   GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> node scripts/audit-history.mjs [uid]
//
// Reports, per calendar month: total history rows, rows with a non-null `text` (PLAINTEXT),
// rows with a `cipher`, and rows with neither. Plaintext rows for OTHER users (shared/anonymous
// items are stored in the clear by design) are counted separately when a uid is given.

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const uid = process.argv[2] ?? null
initializeApp({ credential: applicationDefault() })
const db = getFirestore()

const months = new Map() // 'YYYY-MM' -> { total, plaintext, cipher, neither }
const bump = (key, field) => {
  const row = months.get(key) ?? { total: 0, plaintext: 0, cipher: 0, neither: 0 }
  row.total++
  row[field]++
  months.set(key, row)
}

let scanned = 0
let plaintextSampleIds = []
let query = db.collection('history').orderBy('time')
if (uid) query = query.where('user', '==', uid)
let last = null
for (;;) {
  const page = await (last ? query.startAfter(last) : query).limit(1000).get()
  if (page.empty) break
  for (const doc of page.docs) {
    scanned++
    const data = doc.data()
    const when = data.time ? new Date(data.time) : null
    const key = when ? `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}` : 'no-time'
    const hasText = data.text !== null && data.text !== undefined
    const hasCipher = data.cipher !== null && data.cipher !== undefined
    if (hasText) {
      bump(key, 'plaintext')
      if (plaintextSampleIds.length < 20) plaintextSampleIds.push(doc.id)
    } else if (hasCipher) bump(key, 'cipher')
    else bump(key, 'neither')
  }
  last = page.docs[page.docs.length - 1]
  process.stderr.write(`\rscanned ${scanned} history rows ...`)
}
process.stderr.write('\n')

console.log(`history audit${uid ? ` for user ${uid}` : ''}: ${scanned} rows`)
console.log('month      total  plaintext  cipher  neither')
for (const [key, row] of [...months.entries()].sort()) {
  console.log(
    `${key.padEnd(10)} ${String(row.total).padStart(5)}  ${String(row.plaintext).padStart(9)}  ${String(row.cipher).padStart(6)}  ${String(row.neither).padStart(7)}`
  )
}
if (plaintextSampleIds.length) {
  console.log(`\nsample plaintext row ids (up to 20):`)
  for (const id of plaintextSampleIds) console.log(`  history/${id}`)
}
console.log(
  '\nNOTE read-only. Policy decision (purge / re-encrypt / accept) belongs to the owner with these numbers in hand.'
)
