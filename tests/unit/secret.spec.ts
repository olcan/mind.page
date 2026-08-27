import { expect, test } from '@playwright/test'
import {
  adoptValidatedSecret,
  establishCandidate,
  resolveFixedOwnerSecret,
  type AccountDoc,
  type AdoptSecretDeps,
  type CandidateEvidence,
  type FixedOwnerSecretDeps,
} from '../../src/secret.js'
import { commitOrStop, createHiddenCorpus, CorpusStopped } from '../../src/hidden_corpus.js'
import { hashSecretPhrase, encryptWithSecret } from '../../src/crypto.js'

// transition tests for the fixed-owner secret flow (see src/secret.ts): fail-closed fetch retry and
// phrase validation against real ciphertext — the corruption boundaries the e2e suite cannot drive
// deterministically. this flow is VALIDATION ONLY: registration moved to the caller's fresh
// candidate-keyed scan, because the documents fetched here are as old as the prompt

const doc = (id: string, data: Record<string, any>): AccountDoc => ({ id, data: () => ({ ...data }) })

function deps(overrides: Partial<FixedOwnerSecretDeps> & { uid?: string }): FixedOwnerSecretDeps & {
  calls: string[]
} {
  const calls: string[] = []
  const uid = overrides.uid ?? 'uid-1'
  return {
    calls,
    fetchAccountDocs: async () => {
      calls.push('fetch')
      return []
    },
    promptPhrase: async () => {
      calls.push('prompt')
      return 'phrase'
    },
    confirmRetry: async () => {
      calls.push('retry?')
      return true
    },
    reportWrongPhrase: async () => {
      calls.push('wrong')
    },
    hashPhrase: phrase => hashSecretPhrase(uid, phrase),
    signOut: () => {
      calls.push('signout')
    },
    ...overrides,
  }
}

test('a failed fetch retries until the server answers, never falling through', async () => {
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const cipher = await encryptWithSecret(JSON.stringify({ text: '#x', attr: null }), secret)
  let failures = 2
  const d = deps({
    fetchAccountDocs: async () => {
      d.calls.push('fetch')
      if (failures-- > 0) throw new Error('unavailable')
      return [doc('a', { cipher })]
    },
  })
  expect(await resolveFixedOwnerSecret(d)).toBe(secret)
  expect(d.calls.filter(call => call == 'fetch')).toHaveLength(3)
  expect(d.calls.filter(call => call == 'retry?')).toHaveLength(2)
  expect(d.calls).not.toContain('signout')
})

test('declining the retry signs out and throws, and no phrase is ever accepted', async () => {
  const d = deps({
    fetchAccountDocs: async () => {
      throw new Error('unavailable')
    },
    confirmRetry: async () => false,
  })
  await expect(resolveFixedOwnerSecret(d)).rejects.toThrow(/cancelled/)
  expect(d.calls).toContain('signout')
  expect(d.calls).not.toContain('prompt')
})

test('a wrong phrase re-prompts and a cancelled prompt signs out', async () => {
  const secret = await hashSecretPhrase('uid-1', 'right')
  const cipher = await encryptWithSecret(JSON.stringify({ text: '#x', attr: null }), secret)
  const phrases = ['wrong', 'right']
  const d = deps({
    fetchAccountDocs: async () => [doc('a', { cipher })],
    promptPhrase: async () => phrases.shift() ?? null,
  })
  expect(await resolveFixedOwnerSecret(d)).toBe(secret)
  expect(d.calls).toContain('wrong')

  const cancelled = deps({
    fetchAccountDocs: async () => [doc('a', { cipher })],
    promptPhrase: async () => null,
  })
  await expect(resolveFixedOwnerSecret(cancelled)).rejects.toThrow(/cancelled/)
  expect(cancelled.calls).toContain('signout')
})

test('a server-confirmed account with no ciphertext returns null without prompting', async () => {
  const d = deps({ fetchAccountDocs: async () => [doc('a', { text: '#plain' }), doc('b', { text: '#also' })] })
  expect(await resolveFixedOwnerSecret(d)).toBeNull()
  expect(d.calls).not.toContain('prompt')
})

test('the candidate is returned WITHOUT touching hidden documents: registration is the caller‘s fresh scan', async () => {
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const hidden = async (name: string) => ({
    hidden: true,
    cipher: await encryptWithSecret(JSON.stringify({ text: JSON.stringify({ name, item: {} }), attr: null }), secret),
  })
  // a CORRUPT hidden document would have thrown inside the old registration pass. validation must
  // not depend on any hidden document decrypting: it rests on finding one readable ciphertext
  const rows = [
    doc('z9', await hidden('global_store_x')),
    doc('h1', { hidden: true, cipher: 'CORRUPT-HIDDEN-ITEM' }),
    doc('p1', { text: '#plain' }),
  ]
  const d = deps({
    fetchAccountDocs: async () => {
      d.calls.push('fetch')
      return rows
    },
  })
  expect(await resolveFixedOwnerSecret(d)).toBe(secret)
  // exactly one fetch, one prompt, no repeated pass over the (prompt-aged) documents
  expect(d.calls).toEqual(['fetch', 'prompt'])
})

// ---- adopting the validated candidate --------------------------------------------------------
// the ORDER is the contract (see adoptValidatedSecret): scan and register as one corpus operation,
// the batch inside the fatal boundary, stop rechecked in the post-await continuation gap, and the
// secret published LAST

function adoptHarness(
  overrides: Partial<AdoptSecretDeps<{ id: string }, { cancelled: () => boolean }>> & { stopped?: () => boolean } = {}
) {
  const log: string[] = []
  let stopped = false
  const corpus = createHiddenCorpus()
  const deps: AdoptSecretDeps<{ id: string }, { cancelled: () => boolean }> = {
    runCorpus: body => corpus.run(async run => void (await body(run))),
    scan: async () => [{ id: 'a' }, { id: 'b' }],
    register: rows => void log.push('register:' + rows.map(r => r.id).join(',')),
    commit: batch =>
      commitOrStop(batch, active => {
        log.push('stop')
        stopped = true
        corpus.stop(active)
      }),
    stopped: () => stopped,
    publish: s => void log.push('publish:' + s),
    ...overrides,
  }
  return { log, corpus, deps, stop: () => (stopped = true), isStopped: () => stopped }
}

test('the happy path registers BEFORE it publishes', async () => {
  const h = adoptHarness()
  expect(await adoptValidatedSecret('sec', h.deps)).toBe('sec')
  expect(h.log).toEqual(['register:a,b', 'publish:sec'])
})

test('a throw partway through the batch enters sticky stop BEFORE the caller rejects, and never publishes', async () => {
  // registration, the adoption merge and the owner publication all mutate: row one lands and row
  // two throws, so the index is partially applied and ingress must not stay live over it
  const boom = new Error('adoption merge failed')
  const mutated: string[] = []
  const h = adoptHarness({
    register: rows => {
      for (const row of rows) {
        if (row.id == 'b') throw boom
        mutated.push(row.id) // row one really did land: the index is PARTIALLY applied
      }
      return undefined
    },
  })
  const adopting = adoptValidatedSecret('sec', h.deps) // takes the tail FIRST
  let queuedRan = false
  const queuedState = h.corpus.run(async () => void (queuedRan = true)).catch(e => e)
  await expect(adopting, 'the caller keeps the exact error').rejects.toBe(boom)
  expect(h.isStopped(), 'and stop was observable first').toBe(true)
  expect(await queuedState, 'the queued corpus operation is stopped').toBeInstanceOf(CorpusStopped)
  expect(queuedRan, 'and its body never ran').toBe(false)
  expect(mutated, 'row one landed before row two threw — the index is partially applied').toEqual(['a'])
  expect(h.log, 'and nothing is published from it').toEqual(['stop'])
})

test('a stop winning the post-scan continuation gap publishes nothing and persists nothing', async () => {
  // THE REAL GAP: the corpus run has already RESOLVED, so nothing inside the turn can see this stop
  // — a final check moved inside the body would miss it entirely
  let stopped = false
  const h = adoptHarness()
  const inner = h.deps.runCorpus
  h.deps.runCorpus = async body => {
    await inner(body) // the corpus turn settles first ...
    stopped = true // ... and the stop lands in the continuation gap, before adopt resumes
  }
  h.deps.stopped = () => stopped
  await expect(adoptValidatedSecret('sec', h.deps)).rejects.toThrow(/hidden ingress stopped/)
  expect(h.log, 'registration ran; publication did not').toEqual(['register:a,b'])
})

// ---- candidate validation over mixed/corrupt evidence (review 81 §2.5) -------------------------
// the policy rows: corrupt-before-valid, valid-before-corrupt, v1-only, v0-required-when-present,
// and the no-usable-evidence fail-closed outcome. authentication attempts are injected; the policy
// is pure

const row = (kind: 'v0' | 'v1', cipher: string): CandidateEvidence => ({ kind, cipher })

test('a corrupt row BEFORE a valid one no longer fails the candidate (the old prompt loop)', async () => {
  const tried: string[] = []
  const verdict = await establishCandidate([row('v0', 'corrupt'), row('v0', 'valid')], {
    tryV0: async c => (tried.push(c), c == 'valid'),
    tryV1: async () => false,
  })
  expect(verdict).toEqual({ kind: 'established' })
  expect(tried, 'iterated past the corrupt row').toEqual(['corrupt', 'valid'])
})

test('valid-before-corrupt establishes on the first attempt', async () => {
  const tried: string[] = []
  const verdict = await establishCandidate([row('v0', 'valid'), row('v0', 'corrupt')], {
    tryV0: async c => (tried.push(c), c == 'valid'),
    tryV1: async () => false,
  })
  expect(verdict).toEqual({ kind: 'established' })
  expect(tried, 'no attempt wasted past establishment').toEqual(['valid'])
})

test('v0 evidence is REQUIRED when present: v1 successes alone cannot establish', async () => {
  // v1 alone cannot distinguish composed from decomposed spellings of the legacy phrase; v0
  // deliberately can (its key keeps the exact original bytes)
  const verdict = await establishCandidate([row('v0', 'a'), row('v1', 'b')], {
    tryV0: async () => false,
    tryV1: async () => true,
  })
  expect(verdict).toEqual({ kind: 'not-established' })
})

test('a v1-only corpus is established by one successful v1 authentication', async () => {
  expect(
    await establishCandidate([row('v1', 'x'), row('v1', 'y')], {
      tryV0: async () => false,
      tryV1: async c => c == 'y',
    })
  ).toEqual({ kind: 'established' })
})

test('no usable evidence fails closed instead of blaming the phrase', async () => {
  expect(await establishCandidate([], { tryV0: async () => true, tryV1: async () => true })).toEqual({
    kind: 'no-usable-evidence',
  })
})

test('the resolver iterates ALL ciphers: a corrupt first item no longer causes a prompt loop', async () => {
  // the production wiring of the policy: two ciphers, the first corrupt, the phrase correct
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const cipher = await encryptWithSecret(JSON.stringify({ text: '#x', attr: null }), secret)
  const d = deps({
    fetchAccountDocs: async () => [doc('bad', { cipher: 'CORRUPT-NOT-DECRYPTABLE' }), doc('good', { cipher })],
  })
  expect(await resolveFixedOwnerSecret(d), 'established despite the corrupt first row').toBe(secret)
  expect(
    d.calls.filter(c => c == 'wrong'),
    'and no wrong-phrase report'
  ).toHaveLength(0)
})
