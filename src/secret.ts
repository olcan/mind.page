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

import { classifyTextCipher, decryptWithSecret } from './crypto.js'

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

  // EVERY cipher value is CLASSIFIED, once, through the same structural preflight the decryptors
  // use — a truthy value is not evidence until its frame says which regime it is (review 82: a
  // malformed or future-version frame must never count against the phrase). "had ciphertext" is
  // preserved SEPARATELY from "usable evidence": zero ciphertext is the new-account path, but
  // ciphertext with zero usable rows is CORRUPT/UNSUPPORTED DATA and must fail closed before any
  // prompt — a wrong-phrase loop against data no phrase can open is a phishing surface
  const ciphers = docs
    .map(doc => doc.data().cipher)
    .filter((cipher): cipher is string => typeof cipher == 'string' && !!cipher)
  const evidence: CandidateEvidence[] = []
  for (const cipher of ciphers) {
    const kind = classifyTextCipher(cipher)
    if (kind == 'v0' || kind == 'v1') evidence.push({ kind, cipher })
    // malformed-frame / unsupported-version: not evidence about any phrase
  }
  if (!ciphers.length) return null // no ciphertext anywhere (server-confirmed): caller runs the new-phrase flow
  if (!evidence.length)
    throw new Error('account ciphertext is unsupported or corrupt: no phrase can be validated against it')

  // prompt and validate against the corpus evidence, per the establishCandidate policy
  let candidate: string
  while (true) {
    const phrase = await deps.promptPhrase()
    if (phrase == null) {
      deps.signOut()
      throw new Error('secret phrase cancelled')
    }
    candidate = await deps.hashPhrase(phrase)
    const verdict = await establishCandidate(evidence, {
      tryV0: async cipher => {
        try {
          await decryptWithSecret(cipher, candidate)
          return true
        } catch (e) {
          // ONLY a real authentication failure is evidence against the candidate. anything else —
          // a parser or integration bug — must propagate to its own handling, never become
          // "wrong phrase" (review 82)
          if (e instanceof DOMException && e.name == 'OperationError') return false
          throw e
        }
      },
      tryV1: async () => false, // no v1 corpus yet (stage 2 supplies the real attempt)
    })
    if (verdict.kind == 'established') break
    // NOT-ESTABLISHED: the honest outcome — the phrase did not unlock the available data
    await deps.reportWrongPhrase()
  }

  // NO REGISTRATION HERE. these documents are as old as the prompt: the caller takes one fresh
  // candidate-keyed scan through the corpus seam, in canonical id order, before it publishes or
  // stores the secret — which is what actually protects a concurrent encrypted save from
  // duplicating a record registration has not reached yet
  return candidate
}

// ---- adopting the validated candidate --------------------------------------------------------
// The other half of the flow, and the half whose ORDER is the contract. `resolveFixedOwnerSecret`
// deliberately registers nothing (its documents are as old as the prompt), so everything between a
// validated candidate and a published secret lives here rather than inline in the component:
//
// - the fresh candidate-keyed scan and its registration run as ONE corpus operation, so a delivery
//   for one of those ids is admitted and ordered behind the registration;
// - the registration BATCH is inside the fatal boundary. Registration, the adoption merge and the
//   owner publication all mutate, so a throw partway through leaves a PARTIALLY APPLIED index —
//   and without the boundary the caller rejects as if this had been a pre-application read
//   failure, leaving ingress live and queued corpus work running over a half-built index;
// - stop is rechecked AFTER the corpus await, because it can win in that continuation gap after
//   the corpus turn has already settled; and
// - the secret is published and persisted LAST. A save that saw it earlier could create a
//   duplicate of a record the scan had not registered yet.

// generic over the corpus run handle so the scan receives it DIRECTLY. threading it through a
// mutable closure variable instead is how a later caller ends up reading a different operation's
// handle
export type AdoptSecretDeps<Row, Run> = {
  // runs one corpus operation, rejecting with the body's own error
  runCorpus: (body: (run: Run) => Promise<void>) => Promise<void>
  // the fresh candidate-keyed scan, inside that operation
  scan: (run: Run) => Promise<Row[]>
  // ONE synchronous registration batch. `undefined`, not `void`: an async implementation would
  // type-check and then register after the boundary that is supposed to contain it
  register: (rows: Row[]) => undefined
  // the fatal boundary (see commitOrStop in hidden_corpus.ts), passed in so this module stays free
  // of the coordinator
  commit: (batch: () => undefined) => undefined
  // sticky ingress stop
  stopped: () => boolean
  // publish to the session AND persist. only reached when everything above succeeded
  publish: (secret: string) => undefined
}

export async function adoptValidatedSecret<Row, Run>(
  candidate: string,
  deps: AdoptSecretDeps<Row, Run>
): Promise<string> {
  await deps.runCorpus(async run => {
    const rows = await deps.scan(run)
    if (deps.stopped()) return // a late registration after stop must not touch the index
    deps.commit(() => deps.register(rows))
  })
  if (deps.stopped()) throw new Error('hidden ingress stopped: reload to recover')
  deps.publish(candidate)
  return candidate
}

// ---- candidate validation over mixed/corrupt evidence ------------------------------------------
// (Review 81 §2.5.) "Wrong phrase" is a POLICY conclusion, not a crypto outcome: AES-GCM cannot
// say why authentication failed, and the old first-truthy-cipher rule turned one corrupt item into
// a prompt loop. This is the deterministic policy — no verifier item, no sampling framework:
//
// - malformed/unsupported rows are NOT evidence about the phrase; they are skipped;
// - if any v0 evidence exists, a successful v0 authentication is REQUIRED: v1 alone cannot
//   distinguish composed from decomposed spellings of the legacy phrase, while v0 deliberately can
//   (its key keeps the exact original bytes);
// - a v1-only corpus is established by one successful v1 authentication;
// - all supported evidence failing means NOT ESTABLISHED — the honest "did not unlock the
//   available data", eligible for re-prompt;
// - no usable supported evidence at all is CORRUPT/UNSUPPORTED DATA, which must fail closed
//   rather than blame the phrase.
//
// Once a candidate IS established, later authentication failures under its keys are item
// corruption and must never re-prompt — that rule lives with the caller, which stops consulting
// this policy after establishment.

export type CandidateEvidence = { kind: 'v0' | 'v1'; cipher: string }

export type CandidateVerdict =
  | { kind: 'established' }
  // supported evidence existed and every attempt failed: may re-prompt
  | { kind: 'not-established' }
// NOTE there is no 'no-usable-evidence' verdict: the CALLER classifies the corpus and fails
// closed on ciphertext-with-zero-usable-rows BEFORE any prompt, so the helper never sees an empty
// list — and a verdict only an artificial input could produce is a state to delete, not to keep
// (review 82)

export async function establishCandidate(
  evidence: CandidateEvidence[],
  deps: {
    // one authentication attempt per row; resolves true on success, false on authentication
    // failure. malformed/unsupported classification happens BEFORE rows enter `evidence`
    tryV0: (cipher: string) => Promise<boolean>
    tryV1: (cipher: string) => Promise<boolean>
  }
): Promise<CandidateVerdict> {
  const v0 = evidence.filter(row => row.kind == 'v0')
  const v1 = evidence.filter(row => row.kind == 'v1')
  if (!v0.length && !v1.length) throw new Error('establishCandidate requires classified evidence (caller bug)')
  if (v0.length) {
    // v0 REQUIRED when present: iterate until one authenticates — a corrupt row before a valid
    // one is exactly the case the old first-cipher rule got wrong
    for (const row of v0) if (await deps.tryV0(row.cipher)) return { kind: 'established' }
    return { kind: 'not-established' }
  }
  for (const row of v1) if (await deps.tryV1(row.cipher)) return { kind: 'established' }
  return { kind: 'not-established' }
}
