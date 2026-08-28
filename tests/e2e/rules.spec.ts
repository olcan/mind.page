import { readFileSync } from 'fs'
import { readHiddenMembership } from '../../src/hidden_delivery.js'
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
  getDocsFromServer,
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

test('the OWNER HIDDEN-SET query answers TARGET-ID absence in a NONEMPTY set, through the real adapter', async () => {
  // the shape the app reads hidden documents with, driven through the REAL membership adapter
  // (readHiddenMembership): "is this id currently hidden?" is the whole question a delivery asks.
  // an unrelated hidden document stays PRESENT throughout — production finds the target id in the
  // returned set, and an assertion on set emptiness would stay green for an adapter that read
  // rows[0] instead
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'items/rules-alice-hidden'), {
      user: 'alice',
      hidden: true,
      cipher: 'x',
      time: 1,
      attr: null,
    })
    await setDoc(doc(ctx.firestore(), 'items/rules-alice-hidden-other'), {
      user: 'alice',
      hidden: true,
      cipher: 'y',
      time: 1,
      attr: null,
    })
  })
  const db = env.authenticatedContext('alice').firestore()
  const membership = (id: string) =>
    readHiddenMembership(id, {
      queryHiddenSet: async () =>
        // getDocsFromServer, as production's adapter uses: the answer must be server-confirmed
        (
          await getDocsFromServer(
            query(collection(db, 'items'), where('user', '==', 'alice'), where('hidden', '==', true))
          )
        ).docs,
      stopped: () => false,
      // the emulator documents are not really encrypted; classification needs a hidden wrapper
      decrypt: async data => ({ ...data, text: JSON.stringify({ name: 'global_store_x' }) }),
    })
  const present = await membership('rules-alice-hidden')
  expect(present.kind, 'the present target is found among others').toBe('hidden')
  // the target is deleted; the unrelated document REMAINS. absence must be target-specific
  await env.withSecurityRulesDisabled(async ctx => deleteDoc(doc(ctx.firestore(), 'items/rules-alice-hidden')))
  expect(await membership('rules-alice-hidden'), 'target-id absence in a nonempty authorized set').toEqual({
    kind: 'not-hidden',
  })
})

test('the owner hidden-set query does not become a way to read someone else‘s documents', async () => {
  const db = env.authenticatedContext('mallory-ok').firestore()
  await assertFails(getDocs(query(collection(db, 'items'), where('user', '==', 'alice'), where('hidden', '==', true))))
})

test('an exact-id query for a MISSING id is denied too: the shape must stay the plain owner set', async () => {
  // documented here because it is not obvious and it decides the client's read shape: for a
  // missing id, constraining by documentId() makes the list rule evaluate against a resource it
  // cannot read fields from, and the request is denied — so "read one document" and "read the
  // owner's hidden set" have to be the same call. (this row proves the MISSING-id denial; it does
  // not claim an exact-id query for an existing owner document fails)
  const db = env.authenticatedContext('alice').firestore()
  await assertFails(
    getDocs(
      query(
        collection(db, 'items'),
        where('user', '==', 'alice'),
        where('hidden', '==', true),
        where(documentId(), '==', 'rules-does-not-exist')
      )
    )
  )
})

// ---- the round-83 rules refactor: positive allowlist + users/kdf protection --------------------
// the recursive /{document=**} match overlapped every dedicated rule, and Firestore grants on ANY
// matching allow — so a client-written `user` field could authorize webhook writes and every future
// collection was owner-writable by default. the shared owner policy now names its collections.

test('the shared owner policy still covers items, history and instances', async () => {
  const db = env.authenticatedContext('alice').firestore()
  await assertSucceeds(setDoc(doc(db, 'history/rules-h1'), { user: 'alice', item: 'x', time: 1 }))
  await assertSucceeds(setDoc(doc(db, 'instances/rules-i1'), { user: 'alice', init_time: 1 }))
  await assertSucceeds(getDoc(doc(db, 'history/rules-h1')))
  await assertSucceeds(deleteDoc(doc(db, 'instances/rules-i1')))
})

test('an UNKNOWN collection with a matching user field is denied: new collections are deny-by-default', async () => {
  // the read denial must be about the RULE, not about the document not existing (the old generic
  // rule also denied a missing document for want of resource.data.user) — so the document EXISTS
  await env.withSecurityRulesDisabled(async ctx =>
    setDoc(doc(ctx.firestore(), 'surprise/rules-s1'), { user: 'alice', data: 1 })
  )
  const db = env.authenticatedContext('alice').firestore()
  await assertFails(getDoc(doc(db, 'surprise/rules-s1')))
  await assertFails(updateDoc(doc(db, 'surprise/rules-s1'), { data: 2 }))
  await assertFails(deleteDoc(doc(db, 'surprise/rules-s1')))
  await assertFails(setDoc(doc(db, 'surprise/rules-s2'), { user: 'alice', data: 1 }))
})

test('webhook collections: reads as documented, and a client user-field injection cannot write', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'webhooks/rules-w1'), { user: 'alice', hook: 1 })
    // user: 'alice' INJECTED (review 85 §6): the OLD recursive rule granted writes for any
    // document carrying user == uid, and a user-less seed would let that bypass regress unseen —
    // the delete denial below must hold even when the field matches
    await setDoc(doc(ctx.firestore(), 'github_webhooks/rules-g1'), { user: 'alice', repo: 'r' })
  })
  const alice = env.authenticatedContext('alice').firestore()
  await assertSucceeds(getDoc(doc(alice, 'webhooks/rules-w1')))
  await assertSucceeds(getDoc(doc(alice, 'github_webhooks/rules-g1')))
  const mallory = env.authenticatedContext('mallory-ok').firestore()
  await assertFails(getDoc(doc(mallory, 'webhooks/rules-w1'))) // not their webhook
  // the OLD bypass: the generic rule granted a write for any document carrying user == uid.
  // create, update AND delete — "no client writes" means all three
  await assertFails(setDoc(doc(alice, 'webhooks/rules-w2'), { user: 'alice', hook: 2 }))
  await assertFails(setDoc(doc(alice, 'github_webhooks/rules-g2'), { user: 'alice', repo: 'r' }))
  await assertFails(updateDoc(doc(alice, 'webhooks/rules-w1'), { user: 'alice', hook: 3 }))
  await assertFails(deleteDoc(doc(alice, 'webhooks/rules-w1')))
  await assertFails(deleteDoc(doc(alice, 'github_webhooks/rules-g1')))
})

test('users: owner-only read/create/update; NO client delete; injected user field buys nothing', async () => {
  const alice = env.authenticatedContext('alice').firestore()
  await assertSucceeds(setDoc(doc(alice, 'users/alice'), { email: 'a@x', user: 'alice' }))
  await assertSucceeds(getDoc(doc(alice, 'users/alice')))
  const mallory = env.authenticatedContext('mallory-ok').firestore()
  await assertFails(getDoc(doc(mallory, 'users/alice')))
  await assertFails(setDoc(doc(mallory, 'users/alice'), { user: 'mallory-ok' })) // injection buys nothing
  // delete denied even for the owner: delete/recreate would re-provision a fresh salt over data
  // encrypted under the old one
  await assertFails(deleteDoc(doc(alice, 'users/alice')))
})

test('kdf metadata: exact shape enforced, immutable once set, and merge refreshes preserve it', async () => {
  const alice = env.authenticatedContext('alice').firestore()
  const SALT = 'BwcHBwcHBwcHBwcHBwcHBw==' // canonical base64 of 16x0x07
  // PRECONDITIONS INSIDE THE ROW (review 84: a focused --grep run must still prove everything):
  // the profile exists and carries an injected user field, so the old overlapping-rule bypass is
  // exercised here, not via state another test happened to leave
  await env.withSecurityRulesDisabled(async ctx =>
    setDoc(doc(ctx.firestore(), 'users/alice'), { email: 'a@x', user: 'alice' })
  )
  // exact-shape rejections
  for (const kdf of [
    { v: 2, salt: SALT },
    { v: '1', salt: SALT },
    { v: 1 },
    { salt: SALT },
    { v: 1, salt: SALT, extra: 1 },
    { v: 1, salt: 'not base64' },
    { v: 1, salt: 'BwcHBwcHBwcHBwcHBwcHBx==' }, // SAME 16 bytes, noncanonical pad bits
  ])
    await assertFails(setDoc(doc(alice, 'users/alice'), { kdf }, { merge: true }))
  // explicit null is present-invalid on the server too, matching decodeKdfMetadata (review 84)
  await assertFails(setDoc(doc(alice, 'users/alice'), { kdf: null }, { merge: true }))
  // FIRST PROVISIONING on a document that does not exist yet — the branch that can race the
  // fire-and-forget sign-in profile merge (a fresh uid, so no earlier row's state)
  const fresh = env.authenticatedContext('freshuser').firestore()
  await assertSucceeds(setDoc(doc(fresh, 'users/freshuser'), { kdf: { v: 1, salt: SALT } }, { merge: true }))
  // the valid shape lands on the existing profile
  await assertSucceeds(setDoc(doc(alice, 'users/alice'), { kdf: { v: 1, salt: SALT } }, { merge: true }))
  // IMMUTABLE: mutation, deletion, and a non-merge replace that would drop it are all denied
  await assertFails(
    setDoc(doc(alice, 'users/alice'), { kdf: { v: 1, salt: 'CAgICAgICAgICAgICAgICA==' } }, { merge: true })
  )
  await assertFails(setDoc(doc(alice, 'users/alice'), { email: 'a@x' })) // bare set = replace = kdf loss
  // an ordinary MERGE profile refresh without kdf preserves it and is allowed — the sign-in path
  await assertSucceeds(setDoc(doc(alice, 'users/alice'), { email: 'new@x', lastUpdateAt: 2 }, { merge: true }))
  const after = await getDoc(doc(alice, 'users/alice'))
  expect(after.data()?.kdf).toEqual({ v: 1, salt: SALT })
})
