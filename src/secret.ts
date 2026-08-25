// resolves the account secret for a signed-in owner on a fixed (shared) page, failing closed
// (extracted from getSecretPhrase in index.svelte so its transitions are unit-testable with
// injected dependencies, see tests/unit/secret.spec.ts):
//
// - the account is scanned with a SERVER-confirmed read: a cached read holding only visited
//   plaintext shared items would misclassify an encrypted account as unencrypted, and a failed
//   read retries or signs out — an unvalidated phrase would encrypt new data under a wrong key
// - an entered phrase is validated against found ciphertext (aes-gcm authentication throws on a
//   wrong key) before it is accepted
// - the account's hidden items are registered BEFORE the secret is returned/published: a
//   concurrent encrypted save that saw the settled secret early could create a duplicate of a
//   hidden document that registration had not reached yet

import { compareIds } from './hidden.js'
import { decryptWithSecret } from './crypto.js'

export type AccountDoc = { id: string; data: () => Record<string, any> }

export type FixedOwnerSecretDeps = {
  // server-only read of the account's items (e.g. getDocsFromServer, see index.svelte)
  fetchAccountDocs: () => Promise<AccountDoc[]>
  // prompt for the existing phrase; null means cancel
  promptPhrase: () => Promise<string | null>
  // report a failed fetch and ask whether to retry; false means sign out
  confirmRetry: () => Promise<boolean>
  // report a wrong phrase before re-prompting
  reportWrongPhrase: () => Promise<void>
  // stored form of a phrase (see hashSecretPhrase in crypto.ts, bound to the uid)
  hashPhrase: (phrase: string) => Promise<string>
  // register one decrypted hidden item (adopts pending creates, see registerHiddenItem)
  registerHiddenItem: (item: Record<string, any>) => void
  signOut: () => void
}

// returns the validated hashed secret, or null when the (server-confirmed) account holds no
// ciphertext — the caller then runs its new-phrase flow; throws 'secret phrase cancelled' after
// signing out on any cancellation
export async function resolveFixedOwnerSecret(deps: FixedOwnerSecretDeps): Promise<string | null> {
  // fetch until the server answers (fail closed), or sign out; NOTE: this must be an internal
  // loop — recursing into the caller's entry point would return its own in-flight promise
  let docs: AccountDoc[]
  while (true) {
    try {
      docs = await deps.fetchAccountDocs()
      break
    } catch (e) {
      console.error('could not fetch account items to validate secret phrase:', e)
      if (!(await deps.confirmRetry())) {
        deps.signOut()
        throw new Error('secret phrase cancelled')
      }
    }
  }

  const cipher = docs.map(doc => doc.data().cipher).find(cipher => cipher)
  if (!cipher) return null // no ciphertext anywhere (server-confirmed): caller runs the new-phrase flow

  // prompt and validate against the ciphertext
  let candidate: string
  while (true) {
    const phrase = await deps.promptPhrase()
    if (phrase == null) {
      deps.signOut()
      throw new Error('secret phrase cancelled')
    }
    candidate = await deps.hashPhrase(phrase)
    try {
      await decryptWithSecret(cipher, candidate) // throws on a wrong phrase
      break
    } catch (e) {
      await deps.reportWrongPhrase()
    }
  }

  // register the account's hidden items (e.g. global stores) decrypted with the validated
  // candidate — NOT the session secret, which is not published yet and must not be until this
  // completes (a pending save adopts the existing document instead of creating a duplicate);
  // only hidden documents are touched ('hidden' is a plaintext field — an unrelated corrupt
  // ordinary item must not fail this), in ascending id order so a pending create adopts the
  // MINIMUM-id duplicate (the index invariant; the query itself is ordered by descending time)
  // compareIds, not localeCompare: the index's canonical (minimum-id) selection is code-unit
  // ordered, and mixed-case firestore ids order differently under a locale collator — the two
  // must agree or registration adopts one record while cleanup retains a different one
  for (const doc of docs.filter(doc => doc.data().hidden).sort((a, b) => compareIds(a.id, b.id))) {
    try {
      const item: Record<string, any> = Object.assign(doc.data(), { id: doc.id })
      if (item.cipher) {
        const decrypted = JSON.parse(await decryptWithSecret(item.cipher, candidate))
        item.text = decrypted.text
        item.attr = decrypted.attr
        item.cipher = null
      }
      deps.registerHiddenItem(item)
    } catch (e) {
      // best-effort here: the phrase is validated regardless, and duplicate protection for a
      // pending create does not rest on this pass — every new-name create on a fixed page
      // re-confirms against the server and FAILS on any hidden-document error (see
      // saveHiddenItem in index.svelte)
      console.error('could not load hidden item:', e)
    }
  }
  return candidate
}
