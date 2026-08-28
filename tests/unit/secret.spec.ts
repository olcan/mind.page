import { expect, test } from '@playwright/test'
import {
  accountHasCipher,
  adoptFreshFixedSecret,
  adoptValidatedSecret,
  establishCandidate,
  resolveFixedOwnerSecret,
  type AccountDoc,
  type AdoptSecretDeps,
  type CandidateEvidence,
  type FixedOwnerSecretDeps,
} from '../../src/secret.js'
import { commitOrStop, createHiddenCorpus, CorpusStopped } from '../../src/hidden_corpus.js'
import { encryptV1Text, importV1Key } from '../../src/crypto.js'
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
  expect((await resolveFixedOwnerSecret(d))?.v0Secret).toBe(secret)
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
  expect((await resolveFixedOwnerSecret(d))?.v0Secret).toBe(secret)
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
  const established = await resolveFixedOwnerSecret(d)
  expect(established?.v0Secret).toBe(secret)
  expect(established?.v1, 'pure v0 without the v1 seam').toBeNull()
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

test('the helper REFUSES an empty evidence list: the caller owns the no-usable-evidence path', async () => {
  await expect(establishCandidate([], { tryV0: async () => true, tryV1: async () => true })).rejects.toThrow(
    'caller bug'
  )
})

test('PRODUCTION: malformed and future-version ciphers are not evidence; valid rows still establish', async () => {
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const cipher = await encryptWithSecret(JSON.stringify({ text: '#x', attr: null }), secret)
  const d = deps({
    fetchAccountDocs: async () => [
      doc('junk', { cipher: 'CORRUPT-NOT-A-FRAME' }), // malformed: skipped, never counted against the phrase
      doc('future', { cipher: '9!' + 'ab'.repeat(12) + 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==' }), // future tag
      doc('good', { cipher }),
    ],
  })
  expect((await resolveFixedOwnerSecret(d))?.v0Secret).toBe(secret)
  expect(
    d.calls.filter(c => c == 'wrong'),
    'no wrong-phrase report for unusable rows'
  ).toHaveLength(0)
})

test('PRODUCTION: ciphertext with ZERO usable rows fails closed before any prompt', async () => {
  const d = deps({
    fetchAccountDocs: async () => [doc('junk', { cipher: 'CORRUPT-NOT-A-FRAME' })],
  })
  await expect(resolveFixedOwnerSecret(d)).rejects.toThrow('unsupported or corrupt')
  expect(d.calls).not.toContain('prompt') // no wrong-phrase loop against data no phrase can open
  expect(d.calls).not.toContain('wrong')
})

test('a non-authentication error in the RESOLVER propagates instead of becoming wrong-phrase', async () => {
  // review 83: the previous row injected a throwing tryV0 into the pure helper, so a restored
  // catch-all in the RESOLVER would have stayed green. this drives the real path: a structurally
  // valid v0 frame plus a hashPhrase returning a Symbol makes the real TextEncoder throw
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const cipher = await encryptWithSecret('x', secret)
  const d = deps({
    fetchAccountDocs: async () => [doc('a', { cipher })],
    hashPhrase: async () => Symbol('broken') as unknown as string,
  })
  await expect(resolveFixedOwnerSecret(d)).rejects.toThrow(TypeError)
  expect(
    d.calls.filter(c => c == 'wrong'),
    'never reported as a wrong phrase'
  ).toHaveLength(0)
})

test('the resolver iterates past a REAL authentication failure to the valid second frame', async () => {
  // review 83: with the preflight, a malformed first value is SKIPPED before any attempt, which
  // proves classification, not iteration. this first frame is structurally VALID but encrypted
  // under a different secret, so the attempt genuinely fails authentication (OperationError ->
  // false) and iteration continues to the frame the candidate can open
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const otherSecret = await hashSecretPhrase('uid-1', 'some other phrase')
  const foreign = await encryptWithSecret('not ours', otherSecret)
  const cipher = await encryptWithSecret(JSON.stringify({ text: '#x', attr: null }), secret)
  const d = deps({
    fetchAccountDocs: async () => [doc('foreign', { cipher: foreign }), doc('good', { cipher })],
  })
  expect((await resolveFixedOwnerSecret(d))?.v0Secret, 'established via the second frame').toBe(secret)
  expect(
    d.calls.filter(c => c == 'wrong'),
    'and no wrong-phrase report'
  ).toHaveLength(0)
})

test('PRESENT-but-invalid cipher values are corrupt, never the new-account path', async () => {
  // review 83/84: `cipher: 42`, `{}` or `''` used to vanish before the presence check, so a
  // corrupt account entered the choose-new-phrase flow. EACH value is pinned INDIVIDUALLY — a
  // combined corpus stayed green as long as any one value survived the filter
  for (const bad of [42, {}, ''] as const) {
    const d = deps({ fetchAccountDocs: async () => [doc('n', { cipher: bad })] })
    await expect(resolveFixedOwnerSecret(d), JSON.stringify(bad)).rejects.toThrow('unsupported or corrupt')
    expect(d.calls).not.toContain('prompt')
  }
  // and absent/null stays the legitimate no-cipher answer
  const clean = deps({ fetchAccountDocs: async () => [doc('p', { cipher: null }), doc('q', { text: '#plain' })] })
  expect(await resolveFixedOwnerSecret(clean)).toBeNull()
})

// ---- v1 evidence through the REAL derivation seam (stage 2) ------------------------------------

const SALT_B64 = 'BwcHBwcHBwcHBwcHBwcHBw==' // canonical 16x 0x07

test('a v1-only corpus establishes through the v1 seam, with ONE derivation reused for the result', async () => {
  const fixedKey = new Uint8Array(32).map((_, i) => i)
  const key = await importV1Key(fixedKey)
  const c1 = await encryptV1Text('one', key)
  const c2 = await encryptV1Text('two', key)
  let derivations = 0
  const d = deps({
    fetchAccountDocs: async () => [doc('a', { cipher: c1 }), doc('b', { cipher: c2 })],
    v1: {
      profile: async () => ({ v: 1, salt: SALT_B64 }),
      derive: async () => (derivations++, { key, keyBytes: fixedKey }),
    },
  })
  const established = await resolveFixedOwnerSecret(d)
  expect(established?.v0Secret, 'established by v1 evidence alone').toBe(await hashSecretPhrase('uid-1', 'phrase'))
  expect(established?.v1, 'the VALIDATION derivation is the result, not discarded (review 85 §2.3)').toEqual({
    salt: SALT_B64,
    key,
    keyBytes: fixedKey,
  })
  expect(derivations, 'one derivation per candidate phrase, memoized across rows AND the result').toBe(1)
})

test('a MIXED corpus established on v0 derives the v1 half once, AFTER validation', async () => {
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const v0cipher = await encryptWithSecret(JSON.stringify({ text: '#x', attr: null }), secret)
  const fixedKey = new Uint8Array(32).map((_, i) => i)
  const key = await importV1Key(fixedKey)
  const v1cipher = await encryptV1Text('hidden v1 row', key)
  const derivedFor: string[] = []
  const d = deps({
    fetchAccountDocs: async () => [doc('a', { cipher: v0cipher }), doc('b', { cipher: v1cipher })],
    v1: {
      profile: async () => ({ v: 1, salt: SALT_B64 }),
      derive: async phrase => (derivedFor.push(phrase), { key, keyBytes: fixedKey }),
    },
  })
  const established = await resolveFixedOwnerSecret(d)
  expect(established?.v0Secret).toBe(secret)
  expect(established?.v1?.key, 'the scan can open v1 rows under this key').toBe(key)
  expect(derivedFor, 'exactly one derivation, for the established phrase').toEqual(['phrase'])
})

test('a pure-v0 corpus with the seam enabled still derives once: the device earns its envelope', async () => {
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const cipher = await encryptWithSecret(JSON.stringify({ text: '#x', attr: null }), secret)
  const fixedKey = new Uint8Array(32).map((_, i) => i)
  const key = await importV1Key(fixedKey)
  let derivations = 0
  const d = deps({
    fetchAccountDocs: async () => [doc('a', { cipher })],
    v1: {
      profile: async () => ({ v: 1, salt: SALT_B64 }),
      derive: async () => (derivations++, { key, keyBytes: fixedKey }),
    },
  })
  expect((await resolveFixedOwnerSecret(d))?.v1?.salt).toBe(SALT_B64)
  expect(derivations).toBe(1)
})

test('the profile runs BEFORE any prompt, and its failure is fail-closed (no phrase collected)', async () => {
  const secret = await hashSecretPhrase('uid-1', 'phrase')
  const cipher = await encryptWithSecret(JSON.stringify({ text: '#x', attr: null }), secret)
  const d = deps({
    fetchAccountDocs: async () => [doc('a', { cipher })],
    v1: {
      profile: async () => {
        throw new Error('kdf metadata is not a map')
      },
      derive: async () => {
        throw new Error('unreachable')
      },
    },
  })
  await expect(resolveFixedOwnerSecret(d)).rejects.toThrow('kdf metadata is not a map')
  expect(d.calls, 'present-invalid fails closed before the prompt').not.toContain('prompt')
})

test('a v1-only corpus with NO derivation available is honestly not-established, never new-account', async () => {
  const fixedKey = new Uint8Array(32).map((_, i) => i)
  const key = await importV1Key(fixedKey)
  const cipher = await encryptV1Text('data', key)
  const phrases = ['phrase', null] // one failed attempt, then cancel
  const d = deps({
    fetchAccountDocs: async () => [doc('a', { cipher })],
    promptPhrase: async () => phrases.shift() ?? null,
    v1: {
      profile: async () => null, // kdf disabled/unavailable on this device
      derive: async () => {
        throw new Error('unreachable without a profile')
      },
    },
  })
  await expect(resolveFixedOwnerSecret(d), 'cancel signs out; the corpus was never called empty').rejects.toThrow(
    /cancelled/
  )
  expect(d.calls).toContain('signout')
})

test('a WRONG phrase against v1 evidence re-prompts; the right one establishes', async () => {
  const fixedKey = new Uint8Array(32).map((_, i) => i)
  const rightKey = await importV1Key(fixedKey)
  const wrongKey = await importV1Key(new Uint8Array(32).fill(9))
  const cipher = await encryptV1Text('data', rightKey)
  const phrases = ['wrong', 'right']
  const derivedFor: string[] = []
  const d = deps({
    fetchAccountDocs: async () => [doc('a', { cipher })],
    promptPhrase: async () => phrases.shift() ?? null,
    v1: {
      profile: async () => ({ v: 1, salt: 'BwcHBwcHBwcHBwcHBwcHBw==' }),
      derive: async phrase => (
        derivedFor.push(phrase),
        { key: phrase == 'right' ? rightKey : wrongKey, keyBytes: fixedKey }
      ),
    },
  })
  expect((await resolveFixedOwnerSecret(d))?.v0Secret).toBe(await hashSecretPhrase('uid-1', 'right'))
  expect(derivedFor, 'one derivation per phrase; the established one reused for the result').toEqual(['wrong', 'right'])
  expect(
    d.calls.filter(c => c == 'wrong'),
    'exactly one wrong-phrase report'
  ).toHaveLength(1)
})

// ---- the fixed-EMPTY complete acquisition (review 89 §2.2) -------------------------------------

const FIXED_PROFILE = { v: 1 as const, salt: 'BwcHBwcHBwcHBwcHBwcHBw==' }
const DERIVED = { key: { fake: 'k' } as unknown as CryptoKey, keyBytes: new Uint8Array(32) }

function freshDeps(overrides: Partial<Parameters<typeof adoptFreshFixedSecret>[0]> = {}) {
  const calls: string[] = []
  return {
    calls,
    deps: {
      profile: async () => (calls.push('profile'), FIXED_PROFILE),
      derive: async () => (calls.push('derive'), DERIVED),
      adopt: () => (calls.push('adopt'), true),
      promptNewPhrase: async () => (calls.push('prompt'), 'phrase'),
      hashPhrase: async (phrase: string) => 'v0:' + phrase,
      fetchAccountDocs: async () => (calls.push('refetch'), [] as AccountDoc[]),
      signOut: () => void calls.push('signout'),
      ...overrides,
    },
  }
}

test('fixed-empty: profile before the prompt, re-confirmed emptiness, then ONE complete adoption', async () => {
  const f = freshDeps()
  expect(await adoptFreshFixedSecret(f.deps)).toBe('v0:phrase')
  expect(f.calls).toEqual(['profile', 'prompt', 'derive', 'refetch', 'adopt'])
})

test('fixed-empty: ciphertext that appeared while the prompt was open ABORTS — nothing adopted (review 89 §2.2)', async () => {
  // the emptiness authority is prompt-aged: another device wrote the account's first cipher
  // under phrase A while this page waited for phrase B
  const f = freshDeps({
    fetchAccountDocs: async () => [doc('a', { cipher: 'AAAA' + 'ab'.repeat(12) + 'cipher' })],
  })
  await expect(adoptFreshFixedSecret(f.deps)).rejects.toThrow('no longer empty')
  expect(f.calls).not.toContain('adopt')
})

test('fixed-empty: cancel signs out; disabled kdf returns null for the legacy flow; stale adopt is superseded', async () => {
  const cancel = freshDeps({ promptNewPhrase: async () => null })
  await expect(adoptFreshFixedSecret(cancel.deps)).rejects.toThrow('cancelled')
  expect(cancel.calls).toContain('signout')
  const off = freshDeps({ profile: async () => null })
  expect(await adoptFreshFixedSecret(off.deps)).toBeNull()
  expect(off.calls).not.toContain('prompt')
  const stale = freshDeps({ adopt: () => false })
  await expect(adoptFreshFixedSecret(stale.deps)).rejects.toThrow('superseded')
})

test('accountHasCipher: presence is the rule — corrupt values count, null/absent do not', () => {
  expect(accountHasCipher([doc('a', { text: '#x' }), doc('b', { cipher: null })])).toBe(false)
  for (const bad of [42, {}, ''] as const) expect(accountHasCipher([doc('n', { cipher: bad })]), String(bad)).toBe(true)
  expect(accountHasCipher([doc('c', { cipher: 'AAAA' })])).toBe(true)
})
