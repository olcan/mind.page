// resolves the account secret for a signed-in owner on a fixed (shared) page, failing closed
// (extracted from getSecretPhrase in index.svelte so its transitions are unit-testable with
// injected dependencies, see tests/unit/secret.spec.ts):
//
// - the account is scanned with a SERVER-confirmed read: a cached read holding only visited
//   plaintext shared items would misclassify an encrypted account as unencrypted, and a failed
//   read retries or signs out — an unvalidated phrase would encrypt new data under a wrong key
// - an entered phrase is validated against found ciphertext (aes-gcm authentication throws on a
//   wrong key) before it is accepted
//
// VALIDATION ONLY: it returns a CANDIDATE and registers nothing. the caller runs one fresh
// candidate-keyed hidden scan through the corpus seam before publishing or storing the secret —
// the documents this flow fetched are prompt-aged by the time a human finishes typing, and the
// whole fetch/retry/prompt sequence has no business holding the corpus tail

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
  signOut: () => void
}

// returns the validated hashed secret CANDIDATE, or null when the (server-confirmed) account holds
// no ciphertext — the caller then runs its new-phrase flow; throws 'secret phrase cancelled' after
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

  // NO REGISTRATION HERE. these documents are as old as the prompt: the caller takes one fresh
  // candidate-keyed scan through the corpus seam, in canonical id order, before it publishes or
  // stores the secret — which is what actually protects a concurrent encrypted save from
  // duplicating a record registration has not reached yet
  return candidate
}
