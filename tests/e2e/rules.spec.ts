import { readFileSync } from 'fs'
import { expect, test } from '@playwright/test'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
  where,
} from 'firebase/firestore'

// firestore.rules tests against the emulator (no browser); they use their own project so that the
// documents they create are invisible to the app, which uses the seeded project (see seed.mjs)
const PROJECT = 'rules-test'
const ADMIN = 'y2swh7JY2ScO5soV7mJMHVltAOX2' // admin uid hard-coded in firestore.rules and index.svelte
let env: RulesTestEnvironment

test.beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  })
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'items/rules-anon'), { user: 'anonymous', text: 'public', time: 1, attr: null })
    await setDoc(doc(db, 'items/rules-alice'), { user: 'alice', text: 'private', time: 1, attr: null })
    await setDoc(doc(db, 'items/rules-shared'), {
      user: 'alice',
      text: 'shared',
      time: 1,
      attr: { shared: { keys: ['k'] } },
    })
    await setDoc(doc(db, 'items/rules-blocked'), { user: 'mallory', text: 'x', time: 1, attr: null })
    await setDoc(doc(db, 'blocked_users/mallory'), { time: 1 })
  })
})
test.afterAll(async () => env?.cleanup())

test('anonymous items are readable without auth, but not writable', async () => {
  const db = env.unauthenticatedContext().firestore()
  await assertSucceeds(getDoc(doc(db, 'items/rules-anon')))
  await assertFails(updateDoc(doc(db, 'items/rules-anon'), { text: 'defaced' }))
  await assertFails(setDoc(doc(db, 'items/rules-new'), { user: 'anonymous', text: 'x', time: 1 }))
})

test('private items are readable only by their owner; shared items by anyone', async () => {
  const anon = env.unauthenticatedContext().firestore()
  const alice = env.authenticatedContext('alice').firestore()
  const bob = env.authenticatedContext('bob').firestore()
  await assertFails(getDoc(doc(anon, 'items/rules-alice')))
  await assertFails(getDoc(doc(bob, 'items/rules-alice')))
  await assertSucceeds(getDoc(doc(alice, 'items/rules-alice')))
  await assertSucceeds(getDoc(doc(anon, 'items/rules-shared')))
  await assertSucceeds(getDoc(doc(bob, 'items/rules-shared')))
})

test('owners can create, update and delete their own items only', async () => {
  const alice = env.authenticatedContext('alice').firestore()
  const bob = env.authenticatedContext('bob').firestore()
  await assertSucceeds(setDoc(doc(alice, 'items/rules-alice2'), { user: 'alice', text: 'y', time: 2, attr: null }))
  await assertFails(setDoc(doc(bob, 'items/rules-bob-as-alice'), { user: 'alice', text: 'y', time: 2 }))
  await assertFails(updateDoc(doc(bob, 'items/rules-alice'), { text: 'z' }))
  await assertFails(updateDoc(doc(alice, 'items/rules-alice'), { user: 'bob' })) // cannot hand off
  await assertFails(deleteDoc(doc(bob, 'items/rules-alice')))
  await assertSucceeds(deleteDoc(doc(alice, 'items/rules-alice2')))
})

test('admin can write anonymous items; blocked users are denied', async () => {
  const admin = env.authenticatedContext(ADMIN).firestore()
  const bob = env.authenticatedContext('bob').firestore()
  await assertSucceeds(setDoc(doc(admin, 'items/rules-anon2'), { user: 'anonymous', text: 'w', time: 3, attr: null }))
  await assertSucceeds(updateDoc(doc(admin, 'items/rules-anon2'), { text: 'w2' }))
  await assertFails(setDoc(doc(bob, 'items/rules-anon3'), { user: 'anonymous', text: 'w', time: 3 }))
  const mallory = env.authenticatedContext('mallory').firestore()
  await assertFails(getDoc(doc(mallory, 'items/rules-blocked')))
  await assertFails(getDoc(doc(mallory, 'items/rules-anon')))
})

// HOW A CLIENT ESTABLISHES ABSENCE (review 75). A delivery whose payload cannot speak for the
// hidden side takes one fresh read, and "the document is gone" has to be a real answer rather than
// a denial it cannot tell apart from a failure — a denied read blocks the delivery, and nothing is
// guaranteed to heal it
test('a direct get of a MISSING id is denied: the rule reads fields off a resource that does not exist', async () => {
  const db = env.authenticatedContext('alice').firestore()
  await assertFails(getDoc(doc(db, 'items/rules-does-not-exist')))
})

test('the OWNER HIDDEN-SET query answers absence, because its potential result set is authorized', async () => {
  // the shape the app already reads hidden documents with (the startup prefetch and the shared
  // scan). "is this id currently hidden?" is the whole question a delivery asks, and absence from
  // this set is a real answer — deleted or visible, which are the same thing to the hidden side
  await env.withSecurityRulesDisabled(async ctx =>
    setDoc(doc(ctx.firestore(), 'items/rules-alice-hidden'), {
      user: 'alice',
      hidden: true,
      cipher: 'x',
      time: 1,
      attr: null,
    })
  )
  const db = env.authenticatedContext('alice').firestore()
  const hiddenSet = () =>
    getDocs(query(collection(db, 'items'), where('user', '==', 'alice'), where('hidden', '==', true)))
  const rows = await assertSucceeds(hiddenSet())
  expect(
    rows.docs.map(d => d.id),
    'the hidden document is readable by its owner'
  ).toEqual(['rules-alice-hidden'])
  // and a deleted id is simply not in it — no denial to mistake for a read failure
  await env.withSecurityRulesDisabled(async ctx => deleteDoc(doc(ctx.firestore(), 'items/rules-alice-hidden')))
  expect((await assertSucceeds(hiddenSet())).empty, 'absence is an EMPTY RESULT').toBe(true)
})

test('the owner hidden-set query does not become a way to read someone else‘s documents', async () => {
  const db = env.authenticatedContext('mallory-ok').firestore()
  await assertFails(getDocs(query(collection(db, 'items'), where('user', '==', 'alice'), where('hidden', '==', true))))
})

test('adding an exact-id filter to that query breaks it: the shape must stay the plain owner set', async () => {
  // documented here because it is not obvious and it decides the client's read shape: constraining
  // by documentId() makes the list rule evaluate against a resource it cannot read fields from, and
  // the request is denied — so "read one document" and "read the owner's hidden set" are the same
  // call for us
  const db = env.authenticatedContext('alice').firestore()
  await assertFails(
    getDocs(
      query(
        collection(db, 'items'),
        where('user', '==', 'alice'),
        where('hidden', '==', true),
        where(documentId(), '==', 'anything')
      )
    )
  )
})
