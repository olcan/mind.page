// HISTORY PURGE (owner remediation, reviews 93-97 aftermath) — DESTRUCTIVE, owner-run.
//
// The owner's recorded policy decision (2026-08-28) for the historical plaintext exposure is to
// PURGE THE ENTIRE `history` COLLECTION — every row, every user. History is a redundant edit-log
// convenience; items themselves are untouched.
//
// Usage:
//   node scripts/purge-history.mjs --project <project-id>                       # DRY RUN (default)
//   node scripts/purge-history.mjs --project <project-id> --delete-everything   # actually delete
//
// Safety model:
// - DRY RUN by default: without --delete-everything it only counts and reports what WOULD be
//   deleted, byte-for-byte the same scan the deletion pass uses.
// - the strict CLI of the audit (parseArgs, duplicate/unknown/positional rejection) plus the
//   same production target guard: explicit --project, FIRESTORE_EMULATOR_HOST refusal, resolved
//   target printed before any operation.
// - deletion targets ONLY the top-level `history` collection, by document reference from the
//   same id-paged scan the audit uses; nothing else is read or written.
// - deletes run through a BulkWriter with per-document error reporting; the run ends with a
//   verification recount, which must be zero.

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldPath } from 'firebase-admin/firestore'
import { parseArgs } from 'node:util'

let parsed
try {
  parsed = parseArgs({
    options: {
      project: { type: 'string' },
      'delete-everything': { type: 'boolean' },
    },
    allowPositionals: false,
    tokens: true,
  })
} catch (e) {
  console.error(String(e?.message ?? e))
  console.error('usage: node scripts/purge-history.mjs --project <project-id> [--delete-everything]')
  process.exit(1)
}
const seen = new Set()
for (const token of parsed.tokens) {
  if (token.kind != 'option') continue
  if (seen.has(token.name)) {
    console.error(`duplicate option --${token.name}`)
    process.exit(1)
  }
  seen.add(token.name)
}
const project = parsed.values.project
const doDelete = !!parsed.values['delete-everything']

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('refusing to run: FIRESTORE_EMULATOR_HOST is set (this tool targets PRODUCTION)')
  process.exit(1)
}
if (typeof project != 'string' || !project || project.startsWith('-')) {
  console.error('usage: node scripts/purge-history.mjs --project <project-id> [--delete-everything]')
  process.exit(1)
}

const app = initializeApp({ credential: applicationDefault(), projectId: project })
console.log(
  `${doDelete ? 'PURGING' : 'DRY RUN (no deletion; pass --delete-everything to delete)'} — ` +
    `project ${project}, collection history, scope EVERYTHING`
)

const db = getFirestore(app)
let scanned = 0
let deleted = 0
let failed = 0
const writer = doDelete ? db.bulkWriter() : null
if (writer)
  writer.onWriteError(error => {
    failed++
    console.error(`delete failed for ${error.documentRef.path}: ${error.message}`)
    return error.failedAttempts < 3 // retry transient failures up to 3 times
  })

let last = null
for (;;) {
  let query = db.collection('history').orderBy(FieldPath.documentId()).limit(1000)
  if (last) query = query.startAfter(last)
  const page = await query.get()
  if (page.empty) break
  for (const doc of page.docs) {
    scanned++
    if (writer) {
      writer.delete(doc.ref).then(
        () => void deleted++,
        () => undefined // counted by onWriteError
      )
    }
  }
  last = page.docs[page.docs.length - 1]
  process.stderr.write(`\r${doDelete ? 'deleting' : 'counting'}: ${scanned} rows ...`)
}
if (writer) await writer.close()
process.stderr.write('\n')

if (!doDelete) {
  console.log(`DRY RUN complete: ${scanned} history rows would be deleted. Nothing was changed.`)
  await db.terminate()
  process.exit(0)
}

console.log(`deletion pass complete: ${scanned} scanned, ${deleted} deleted, ${failed} failed`)
// VERIFICATION recount: the collection must now be empty
const remaining = await db.collection('history').orderBy(FieldPath.documentId()).limit(1).get()
if (!remaining.empty) {
  console.error('VERIFICATION FAILED: history still contains rows — rerun or investigate before proceeding')
  await db.terminate()
  process.exit(1)
}
console.log('VERIFIED: the history collection is empty.')
await db.terminate()
