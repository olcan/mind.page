import { readFileSync } from 'fs'
import { test, expect } from '@playwright/test'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore'

// firestore.rules tests against the emulator (no browser); ids are unique to this file so that the
// seeded anonymous items (see seed.mjs) are left untouched
const ADMIN = 'y2swh7JY2ScO5soV7mJMHVltAOX2' // admin uid hard-coded in firestore.rules and index.svelte
let env: RulesTestEnvironment

test.beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'olcanswiki',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  })
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'items/rules-anon'), { user: 'anonymous', text: 'public', time: 1, attr: null })
    await setDoc(doc(db, 'items/rules-alice'), { user: 'alice', text: 'private', time: 1, attr: null })
    await setDoc(doc(db, 'items/rules-shared'), { user: 'alice', text: 'shared', time: 1, attr: { shared: { keys: ['k'] } } })
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
