// Seeds the Firestore emulator with the anonymous account's items (tests/e2e/fixtures), using the
// admin sdk without credentials (the emulator accepts any writes); run with the emulators up.
import { existsSync, readFileSync, readdirSync, watch } from 'fs'
import { basename, dirname, join } from 'path'
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
batch.set(db.collection('users').doc('markdown_e2e'), { displayName: 'Markdown' })
// a shared item of another user, readable by anyone (see firestore.rules) via ?shared=crawl_e2e/public
batch.set(db.collection('items').doc('e2e-crawl-shared'), {
  user: 'crawl_e2e',
  time: Date.now(),
  text: '#e2e_crawl a shared item for crawlers',
  attr: { shared: { keys: ['public'], indices: { public: 0 } } },
})
// the markdown rendering corpus (fixtures/markdown/*.md, one item per file, first #label is the
// item label): shared by the markdown_e2e user under key 'markdown', so it can be browsed and
// tested at /?shared=markdown_e2e/markdown without auth, isolated from the anonymous account
function markdownItem(file) {
  const text = readFileSync(file, 'utf8').replace(/\n$/, '')
  const label = text.match(/#[\w/]+/)?.[0] ?? basename(file, '.md')
  const index = markdownOrder.indexOf(basename(file)) // root item first (its label heads the page)
  return {
    id: 'md-' + label.slice(1).replace(/\//g, '-'), // deterministic ids keep the goldens stable
    user: 'markdown_e2e',
    time: 1700000000000 - index, // stable order
    text,
    // note a shared index is required for the item to be shown (not just accessible) on the
    // shared page: fixed mode shows the first hideIndex = count(indices[key] >= 0) items
    attr: { shared: { keys: ['markdown'], indices: { markdown: index }, labels: true } },
  }
}
const markdownDir = join(dir, 'fixtures/markdown')
const markdownFiles = readdirSync(markdownDir).filter(file => file.endsWith('.md'))
// page order: the root item first (its label heads the page), then its children in the order their
// tags appear in the root item's text, then (as a fallback) any unlisted files alphabetically
const rootTags = readFileSync(join(markdownDir, 'markdown.md'), 'utf8').match(/#[\w/]+/g) ?? []
const fileForTag = tag => tag.slice(1).replace(/\//g, '-') + '.md'
const markdownOrder = [...new Set(['markdown.md', ...rootTags.map(fileForTag), ...[...markdownFiles].sort()])]
for (const file of markdownFiles) {
  const item = markdownItem(join(markdownDir, file))
  batch.set(db.collection('items').doc(item.id), (({ id, ...data }) => data)(item))
}
await batch.commit()
console.log(
  `seeded ${items.length} anonymous and ${markdownFiles.length} markdown items ` +
    `into firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`
)

// with --watch, re-seed a markdown fixture whenever its file changes, so edits appear live in the
// app (the firestore listener applies them as remote updates); used by serve.sh
if (process.argv.includes('--watch')) {
  console.log(`watching ${markdownDir} for changes ...`)
  watch(markdownDir, (event, file) => {
    if (!file?.endsWith('.md')) return
    const path = join(markdownDir, file)
    if (!existsSync(path)) return // deletions are ignored (re-run serve.sh to remove items)
    try {
      const item = markdownItem(path)
      db.collection('items')
        .doc(item.id)
        .set((({ id, ...data }) => data)(item))
        .then(() => console.log(`re-seeded ${file}`))
    } catch (e) {
      console.error(`failed to re-seed ${file}:`, e.message)
    }
  })
  await new Promise(() => {}) // keep watching until killed
}
