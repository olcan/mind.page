// Seeds the Firestore emulator with the anonymous account's items (tests/e2e/fixtures), using the
// admin sdk without credentials (the emulator accepts any writes); run with the emulators up.
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'
const dir = dirname(fileURLToPath(import.meta.url))
const items = JSON.parse(readFileSync(join(dir, 'fixtures/anonymous_items.json'), 'utf8'))
initializeApp({ projectId: 'olcanswiki' })
const db = getFirestore()
let batch = db.batch()
for (const { id, ...data } of items) batch.set(db.collection('items').doc(id), data)
// user records served by /user/<uid> (see server.ts); signing in overwrites them with the auth profile
batch.set(db.collection('users').doc('y2swh7JY2ScO5soV7mJMHVltAOX2'), { displayName: 'Olcan (seeded)' })
batch.set(db.collection('users').doc('alice_e2e'), { displayName: 'Alice Test', mindpageDisplayName: 'Alice (custom)' })
await batch.commit()
console.log(`seeded ${items.length} anonymous items into firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`)
