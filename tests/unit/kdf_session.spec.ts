import { expect, test } from '@playwright/test'
import { createKdfSession, type KdfAcquireOutcome, type KdfSessionDeps } from '../../src/kdf_session.js'
import { encodeKeyEnvelope, encodeSalt } from '../../src/kdf_profile.js'

// the SESSION ORCHESTRATOR's state machine (src/kdf_session.ts), driven with injected effects —
// reviews 85-87: these rows exist because helper tests could not see the wiring defects (the
// broad offline catch, the cached not-ready, the frozen evidence boolean, the second offer
// pipeline, the envelope-only "ready" that split the two regimes, the poisoned stored hash, the
// resurrected envelope). Every row is milliseconds; no Argon, no worker, no browser.

const SALT = new Uint8Array(16).fill(7)
const SALT_B64 = encodeSalt(SALT)
const OTHER_SALT_B64 = encodeSalt(new Uint8Array(16).fill(9))
const KEY = new Uint8Array(32).map((_, i) => i)
const FAKE_KEY = { fake: 'CryptoKey' } as unknown as CryptoKey

// outcome reader (plain narrowing — the union carries reason only on not-ready)
const reasonOf = (o: KdfAcquireOutcome) => (o.kind == 'not-ready' ? o.reason : o.kind)

// a COMPLETE bound envelope (review 88 §2.1): the v0 hash of the establishment that derived it
const OTHER_KEY = new Uint8Array(32).fill(9)
const envelope = (v0Secret = 'v0:phrase', salt = SALT_B64, keyBytes: Uint8Array = KEY) =>
  encodeKeyEnvelope({ uid: 'uid-1', salt, keyBytes, v0Secret })

function harness(overrides: Partial<KdfSessionDeps> = {}) {
  const log: string[] = []
  const storage = new Map<string, string>()
  let workerDisposals = 0
  let derivations = 0
  const deps: KdfSessionDeps = {
    uid: () => 'uid-1',
    enabled: () => true,
    eligible: () => true,
    storedV0: () => storage.get('v0') ?? null,
    storedEnvelope: () => storage.get('env') ?? null,
    persistEnvelope: encoded => void (storage.set('env', encoded), log.push('persistEnvelope')),
    clearEnvelope: () => void (storage.delete('env'), log.push('clearEnvelope')),
    clearPersisted: () => void (storage.delete('v0'), storage.delete('env'), log.push('clearPersisted')),
    pendingV0: () => null,
    corpusConfirmedEmpty: () => false,
    profileStore: () => ({
      read: async () => ({ kdf: { v: 1, salt: SALT_B64 } }),
      runTransaction: async body =>
        body({
          get: async () => ({}),
          set: () => void log.push('provision-write'),
        }),
    }),
    randomSalt: () => SALT,
    promptUpgrade: async () => (log.push('promptUpgrade'), 'phrase'),
    promptPhrase: async () => (log.push('promptPhrase'), 'phrase'),
    promptNewPhrase: async () => (log.push('promptNewPhrase'), 'phrase'),
    reportWrongPhrase: async () => void log.push('wrongNotice'),
    hashPhrase: async phrase => 'v0:' + phrase,
    publishV0: v0 => void (storage.set('v0', v0), log.push('publishV0:' + v0)),
    // candidate attempts against collected evidence rows: the default corpus authenticates the
    // canonical 'phrase' candidate against rows marked -good (a row's cipher is its identity)
    attemptV0: async (row, v0secret) => row.kind == 'text' && row.cipher == 'v0-good' && v0secret == 'v0:phrase',
    attemptV1: async (row, key) => row.kind == 'text' && row.cipher == 'v1-good' && key === FAKE_KEY,
    createWorker: () => ({
      derive: async () => ((derivations++), KEY),
      dispose: () => void workerDisposals++,
    }),
    importKey: async () => FAKE_KEY,
    onWarn: m => void log.push('warn:' + m),
    ...overrides,
  }
  return {
    deps,
    log,
    storage,
    derivations: () => derivations,
    workerDisposals: () => workerDisposals,
    session: createKdfSession({ ...deps, ...overrides }),
  }
}

test('happy upgrade: profile, prompt validated by the TRUSTED stored hash, one derivation, envelope last', async () => {
  const h = harness()
  h.storage.set('v0', 'v0:phrase') // a returning device (pre-generation storage = the baseline)
  const outcome = await h.session.acquire()
  expect(outcome.kind).toBe('ready')
  expect(h.log).toEqual(['promptUpgrade', 'publishV0:v0:phrase', 'persistEnvelope'])
  expect(h.derivations()).toBe(1)
  expect(h.workerDisposals(), 'the acquisition worker is disposed').toBe(1)
  expect(h.session.current()?.salt).toBe(SALT_B64)
  // a second acquire returns the cached session without any new effect
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(h.derivations()).toBe(1)
})

test('COMPLETE persisted state (envelope AND v0 secret) restores silently', async () => {
  const h = harness()
  h.storage.set('v0', 'v0:phrase')
  h.storage.set('env', envelope())
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(h.derivations()).toBe(0)
  expect(h.log).toEqual([])
})

test('SPLIT-KEY GUARD: an envelope WITHOUT the v0 half is not a session — online recovery establishes BOTH (review 87 §2.1)', async () => {
  // the envelope matches the profile, but mindpage_secret is gone (partial local storage)
  const h = harness()
  h.storage.set('env', envelope())
  // without evidence the phrase cannot be validated: NOT ready, and no unrelated phrase accepted
  expect(reasonOf(await h.session.acquire())).toBe('no evidence to validate a first phrase')
  expect(h.log.filter(l => l.startsWith('prompt')), 'no prompt without a validator').toEqual([])
  // with v1 evidence, the REQUIRED existing-phrase prompt runs and the candidate must open it;
  // establishment republishes BOTH halves
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  const outcome = await h.session.acquire()
  expect(outcome.kind).toBe('ready')
  expect(h.log).toContain('promptPhrase')
  expect(h.log).toContain('publishV0:v0:phrase')
  expect(h.storage.get('v0'), 'the v0 half exists again').toBe('v0:phrase')
})

test('SPLIT-KEY GUARD: a wrong phrase against the incomplete-envelope state seals nothing', async () => {
  // attemptV1 refuses: the wrong candidate's derived key opens no v1 row. the required prompt
  // RE-PROMPTS after the notice (review 88 §2.4); cancelling the retry ends the flight
  const phrases: (string | null)[] = ['wrong', null]
  const h = harness({ promptPhrase: async () => phrases.shift() ?? null, attemptV1: async () => false })
  h.storage.set('env', envelope())
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  expect(reasonOf(await h.session.acquire())).toBe('cancelled')
  expect(h.log, 'one wrong-phrase notice between the attempts').toContain('wrongNotice')
  expect(h.log.filter(l => l.startsWith('publishV0')), 'no v0 published from an unestablished phrase').toEqual([])
  expect(h.session.current()).toBeNull()
})

test('OFFLINE requires COMPLETE persisted state: a lone envelope fails closed (review 87 §2.1)', async () => {
  const offlineStore = () => ({
    read: async (): Promise<Record<string, unknown>> => {
      throw new Error('offline')
    },
    runTransaction: async () => {
      throw new Error('unreachable')
    },
  })
  const h = harness({ profileStore: offlineStore })
  h.storage.set('env', envelope())
  expect(reasonOf(await h.session.acquire())).toBe('offline without complete persisted keys')
  // with BOTH halves, offline reuse works without any prompt
  const h2 = harness({ profileStore: offlineStore })
  h2.storage.set('v0', 'v0:phrase')
  h2.storage.set('env', envelope())
  expect((await h2.session.acquire()).kind).toBe('ready')
  expect(h2.log).toEqual([])
})

test('an ABSENT profile provisions first, then the prompt path continues', async () => {
  const h = harness({
    profileStore: () => ({
      read: async () => ({}), // no kdf field: provisionable
      runTransaction: async body => body({ get: async () => ({}), set: () => {} }),
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(h.session.current()?.salt, 'the committed candidate salt').toBe(SALT_B64)
})

test('PRESENT-INVALID metadata REJECTS the acquisition — never mistaken for offline (review 85 §2.4)', async () => {
  const h = harness({
    profileStore: () => ({
      read: async () => ({ kdf: null }), // the read SUCCEEDS; the metadata is present-invalid
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  h.storage.set('env', envelope())
  await expect(h.session.acquire()).rejects.toThrow('kdf metadata is not a map')
  expect(h.session.current(), 'nothing published from invalid metadata').toBeNull()
})

test('confirmed-ABSENT plus a FAILED provisioning transaction rejects too', async () => {
  const h = harness({
    profileStore: () => ({
      read: async () => ({}),
      runTransaction: async () => {
        throw new Error('transaction failed')
      },
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  await expect(h.session.acquire()).rejects.toThrow('transaction failed')
})

test('OFFLINE without any envelope is not-ready and RETRYABLE (the profile flight is not wedged)', async () => {
  let readable = false
  const h = harness({
    profileStore: () => ({
      read: async () => {
        if (!readable) throw new Error('offline')
        return { kdf: { v: 1, salt: SALT_B64 } }
      },
      runTransaction: async body => body({ get: async () => ({}), set: () => {} }),
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('offline without complete persisted keys')
  readable = true
  expect((await h.session.acquire()).kind).toBe('ready')
})

test('a CONFIRMED salt mismatch clears the envelope; decline then a FRESH offline generation cannot resurrect it (reviews 86-87 §2.4)', async () => {
  let online = true
  const store = () => ({
    read: async () => {
      if (!online) throw new Error('offline')
      return { kdf: { v: 1, salt: SALT_B64 } }
    },
    runTransaction: async () => {
      throw new Error('unreachable')
    },
  })
  const h = harness({ profileStore: store, promptUpgrade: async () => null }) // the user declines
  // a VALID same-uid envelope from a previous provisioning epoch (different salt)
  h.storage.set('env', envelope('v0:phrase', OTHER_SALT_B64))
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('declined')
  expect(h.log, 'cleared BEFORE the prompt, on the online confirmation').toContain('clearEnvelope')
  expect(h.storage.get('env'), 'the obsolete envelope is gone').toBeUndefined()
  // the review-87 schedule: a FRESH generation (stores preserved) goes offline — the removal is
  // what protects it, not the cached online result or the decline marker
  h.session.invalidate('external auth transition')
  online = false
  expect(reasonOf(await h.session.acquire()), 'not-ready, never a resurrected session').toBe(
    'offline without complete persisted keys'
  )
  expect(h.session.current()).toBeNull()
})

test('the EXTERNAL profile() consumer revokes a mismatched envelope too (review 87 §2.4)', async () => {
  let online = true
  const h = harness({
    profileStore: () => ({
      read: async () => {
        if (!online) throw new Error('offline')
        return { kdf: { v: 1, salt: SALT_B64 } }
      },
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  h.storage.set('env', envelope('v0:phrase', OTHER_SALT_B64))
  const handle = h.session.external()
  expect(await handle.profile()).toEqual({ v: 1, salt: SALT_B64 })
  expect(h.log, 'the fixed-owner confirmation revoked the obsolete envelope').toContain('clearEnvelope')
  // the fixed flow dies here (tab closed mid-scan); a fresh offline generation finds nothing
  h.session.invalidate('tab reopened')
  online = false
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('offline without complete persisted keys')
})

test('an envelope for a DIFFERENT salt is cleared, then the prompt path replaces it', async () => {
  const h = harness()
  h.storage.set('env', envelope('v0:phrase', OTHER_SALT_B64))
  h.storage.set('v0', 'v0:phrase')
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(h.log).toContain('clearEnvelope')
  expect(h.log).toContain('promptUpgrade')
  expect(h.session.current()?.salt, 'the PROFILE salt, not the stale envelope’s').toBe(SALT_B64)
})

test('DECLINE of the optional upgrade is a session no-nag; clear() forgets it', async () => {
  let prompts = 0
  const h = harness({ promptUpgrade: async () => ((prompts++), null) })
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('declined')
  expect(reasonOf(await h.session.acquire()), 'no second prompt').toBe('upgrade declined this session')
  expect(prompts).toBe(1)
  h.session.clear()
  h.storage.set('v0', 'v0:phrase') // clear() wiped persisted state through deps
  await h.session.acquire()
  expect(prompts, 'a fresh session may ask again').toBe(2)
})

test('cancelling a REQUIRED prompt is reported as cancelled (the component signs out)', async () => {
  const h = harness({ promptPhrase: async () => null })
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  expect(reasonOf(await h.session.acquire())).toBe('cancelled')
  // and it is NOT a no-nag decline: the next acquire may prompt again
  const h2 = harness({ promptNewPhrase: async () => null, corpusConfirmedEmpty: () => true })
  expect(reasonOf(await h2.session.acquire())).toBe('cancelled')
})

test('a WRONG phrase against the TRUSTED stored hash never derives, publishes, or persists', async () => {
  const h = harness({ promptUpgrade: async () => 'wrong' })
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('wrong phrase')
  expect(h.derivations()).toBe(0)
  expect(h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope')).toEqual([])
})

test('POISON GUARD: a stored hash written MID-GENERATION is not trusted — it validates against evidence (review 87 §2.1)', async () => {
  const phrases: (string | null)[] = ['wrong', null]
  const h = harness({ promptPhrase: async () => (h.log.push('promptPhrase'), phrases.shift() ?? null) })
  // the baseline anchors on the first session touch: storage is EMPTY here
  expect(reasonOf(await h.session.acquire())).toBe('no evidence to validate a first phrase')
  // an unestablished component flow then publishes a wrong hash into storage (the production
  // prepublication), and evidence that refuses it arrives
  h.storage.set('v0', 'v0:wrong')
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  // entering the SAME wrong phrase must NOT become ready via the stored-hash comparison: the
  // untrusted hash routes to the REQUIRED prompt and corpus establishment, which refuses it
  expect(reasonOf(await h.session.acquire())).toBe('cancelled')
  expect(h.log, 'refused by establishment, not accepted by the hash').toContain('wrongNotice')
  expect(h.log.filter(l => l == 'persistEnvelope'), 'no envelope from a poisoned hash').toEqual([])
  expect(h.session.current()).toBeNull()
  // the RIGHT phrase now also REFUSES at the seal guard (review 90 §2.1): a current stored value
  // differing from the candidate is a contradiction — the poison is preserved for inspection,
  // never silently replaced, and nothing seals over it
  const ok = harness({ promptPhrase: async () => 'phrase' })
  await ok.session.acquire() // anchor baseline on empty storage
  ok.storage.set('v0', 'v0:wrong')
  ok.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  expect(reasonOf(await ok.session.acquire())).toBe('key binding conflict')
  expect(ok.storage.get('v0'), 'the contradictory store is preserved, not overwritten').toBe('v0:wrong')
  expect(ok.log.filter(l => l == 'persistEnvelope')).toEqual([])
})

test('a FIRST phrase validates against collected evidence, then publishes BOTH regimes', async () => {
  const h = harness()
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  const outcome = await h.session.acquire()
  expect(outcome.kind).toBe('ready')
  expect(h.log[0]).toBe('promptPhrase')
  expect(h.log).toContain('publishV0:v0:phrase')
  // without evidence, the phrase cannot be validated at all
  const h2 = harness()
  expect(reasonOf(await h2.session.acquire())).toBe('no evidence to validate a first phrase')
  expect(h2.derivations(), 'and nothing derives for an unvalidatable prompt').toBe(0)
})

test('NEW-PHRASE arm: only an AUTHORITATIVELY EMPTY account seals without evidence (review 87 §2.2)', async () => {
  // not confirmed empty (default): no new-phrase prompt, not-ready
  const blocked = harness()
  expect(reasonOf(await blocked.session.acquire())).toBe('no evidence to validate a first phrase')
  expect(blocked.log).toEqual([])
  // confirmed empty: the choose-a-new-phrase flow runs and seals both regimes
  const h = harness({ corpusConfirmedEmpty: () => true })
  const outcome = await h.session.acquire()
  expect(outcome.kind).toBe('ready')
  expect(h.log[0]).toBe('promptNewPhrase')
  expect(h.log).toContain('publishV0:v0:phrase')
  expect(h.log).toContain('persistEnvelope')
  // evidence arriving before the flight wins over the emptiness fact: it validates (and the
  // refusal re-prompts; cancelling ends the flight)
  const phrases: (string | null)[] = ['phrase', null]
  const raced = harness({
    corpusConfirmedEmpty: () => true,
    attemptV0: async () => false,
    promptPhrase: async () => (raced.log.push('promptPhrase'), phrases.shift() ?? null),
  })
  raced.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  expect(reasonOf(await raced.session.acquire()), 'evidence gates even a "fresh" phrase').toBe('cancelled')
  expect(raced.log[0], 'validated via the EXISTING-phrase prompt').toBe('promptPhrase')
  expect(raced.log).toContain('wrongNotice')
})

test('MIXED corpus: v1 success alone is INSUFFICIENT while v0 evidence exists (review 86 §2.2)', async () => {
  // the NFC-equivalence hole: a spelling can open the v1 row while hashing to a different exact
  // legacy v0 secret — establishCandidate requires the v0 authentication
  const phrases: (string | null)[] = ['phrase', null]
  const h = harness({
    attemptV0: async () => false, // the candidate's v0 hash opens nothing
    attemptV1: async () => true, // yet its derived key opens v1 rows
    promptPhrase: async () => phrases.shift() ?? null,
  })
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  expect(reasonOf(await h.session.acquire())).toBe('cancelled')
  expect(h.log).toContain('wrongNotice')
  expect(h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope'), 'nothing sealed').toEqual([])
  expect(h.session.current()).toBeNull()
})

test('EVIDENCE IS RETAINED IN FULL: three corrupt v1 rows plus a valid FOURTH still establish (review 87 §3.1)', async () => {
  const attempts: string[] = []
  const h = harness({
    attemptV1: async row => {
      attempts.push(row.kind == 'text' ? row.cipher : 'bytes')
      return row.kind == 'text' && row.cipher == 'v1-good'
    },
  })
  for (const cipher of ['bad-1', 'bad-2', 'bad-3', 'v1-good']) h.session.noteEvidence('v1', { kind: 'text', cipher })
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'bad-1' }) // duplicate: not re-attempted
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(attempts, 'iterated past every corrupt row to the valid fourth, no duplicates').toEqual([
    'bad-1',
    'bad-2',
    'bad-3',
    'v1-good',
  ])
})

test('LAZY DERIVATION: refusals pay no Argon; a v0-established candidate derives exactly once, after validation (review 87 §3.2)', async () => {
  // wrong phrase by corpus (v0 refusal): ZERO derivations, even across the retry prompt
  const phrases: (string | null)[] = ['wrong', null]
  const wrong = harness({ promptPhrase: async () => phrases.shift() ?? null })
  wrong.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  expect(reasonOf(await wrong.session.acquire())).toBe('cancelled')
  expect(wrong.derivations()).toBe(0)
  // v0-only establishment: the derivation happens once, for the seal, after v0 authenticated
  const order: string[] = []
  const h = harness({
    attemptV0: async (row, v0secret) => (order.push('attemptV0'), v0secret == 'v0:phrase'),
    createWorker: () => ({
      derive: async () => (order.push('derive'), KEY),
      dispose: () => undefined,
    }),
  })
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(order, 'validation before any derivation').toEqual(['attemptV0', 'derive'])
})

test('DEFERRED PROFILE: evidence noted after the flight began PROMOTES it (review 86 §2.1)', async () => {
  let releaseRead: (data: Record<string, unknown>) => void = () => {}
  let reads = 0
  const h = harness({
    profileStore: () => ({
      read: () => ((reads++), new Promise<Record<string, unknown>>(resolve => (releaseRead = resolve))),
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  const proactive = h.session.acquire() // the reader-phase trigger, evidence-blind
  await new Promise(r => setTimeout(r, 0)) // let it reach the profile read
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' }) // a v1 item arrives
  const joined = h.session.acquire() // ...and its decrypt joins the same flight
  releaseRead({ kdf: { v: 1, salt: SALT_B64 } })
  const [a, b] = await Promise.all([proactive, joined])
  expect(a.kind, 'the flight consulted CURRENT evidence at its decision point').toBe('ready')
  expect(b).toEqual(a)
  expect(reads, 'one profile read for both callers').toBe(1)
  expect(h.log.filter(l => l == 'promptPhrase'), 'one prompt').toHaveLength(1)
  expect(h.derivations()).toBe(1)
})

test('STALE AT EVERY EFFECT BOUNDARY: a clear() during the prompt stops publication and persistence', async () => {
  const h = harness({
    promptUpgrade: async () => {
      h.session.clear('principal change mid-prompt')
      return 'phrase'
    },
  })
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('superseded')
  expect(h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope'), 'zero effects').toEqual([])
  expect(h.session.current()).toBeNull()
})

test('a clear() during DERIVATION disposes the worker and drops the result', async () => {
  const h = harness({
    createWorker: () => ({
      derive: async () => {
        h.session.clear('sign-out mid-derivation')
        return KEY
      },
      dispose: () => undefined,
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('superseded')
  expect(h.session.current()).toBeNull()
  expect(h.log.filter(l => l == 'persistEnvelope')).toEqual([])
})

test('a clear() during the ABSENT profile read stops BEFORE provisioning (review 87 §2.5)', async () => {
  let releaseRead: (data: Record<string, unknown>) => void = () => {}
  let provisions = 0
  const h = harness({
    profileStore: () => ({
      read: () => new Promise<Record<string, unknown>>(resolve => (releaseRead = resolve)),
      runTransaction: async body => ((provisions++), body({ get: async () => ({}), set: () => {} })),
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  const flight = h.session.acquire()
  await new Promise(r => setTimeout(r, 0))
  h.session.clear('sign-out during the read')
  releaseRead({}) // the read resolves ABSENT — provisioning would normally follow
  await expect(flight).rejects.toThrow('superseded')
  expect(provisions, 'zero provisioning transactions after the clear').toBe(0)
})

test('single-flight: concurrent acquires share one attempt; the slot clears on EVERY settle', async () => {
  let reads = 0
  const h = harness({
    profileStore: () => ({
      read: async () => ((reads++), { kdf: { v: 1, salt: SALT_B64 } }),
      runTransaction: async body => body({ get: async () => ({}), set: () => {} }),
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  const [a, b] = await Promise.all([h.session.acquire(), h.session.acquire()])
  expect(a.kind).toBe('ready')
  expect(b.kind).toBe('ready')
  expect(reads, 'one profile read for both callers').toBe(1)
})

test('acquire JOINS a pending legacy v0 flight; a fixed adoption meanwhile completes it', async () => {
  let resolveV0: (v: string) => void = () => {}
  const v0flight = new Promise<string>(resolve => (resolveV0 = resolve))
  const h = harness({ pendingV0: () => v0flight })
  const acquired = h.session.acquire()
  await new Promise(r => setTimeout(r, 0)) // let the acquisition reach the join
  // the fixed-owner flow adopts through the external handle, then its v0 flight settles
  const handle = h.session.external()
  const profile = await handle.profile()
  const derived = await handle.derive('phrase', profile!)
  expect(handle.adopt('v0:phrase', SALT_B64, derived)).toBe(true)
  resolveV0('v0:phrase')
  expect((await acquired).kind, 'the join found the adopted session').toBe('ready')
  expect(h.log.filter(l => l.startsWith('prompt')), 'no prompt').toEqual([])
})

test('a pending v0 flight that REJECTS (cancelled prompt) leaves acquire not-ready without a second prompt', async () => {
  const flight: Promise<string> = Promise.reject(new Error('cancelled'))
  flight.catch(() => undefined)
  const h = harness({ pendingV0: () => flight })
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('v0 acquisition cancelled or failed')
  expect(h.log.filter(l => l.startsWith('prompt')), 'no nag behind their cancel').toEqual([])
})

test('EXTERNAL handle: the profile flight is SHARED, and profile() ANCHORS the baseline (review 88 §2.1)', async () => {
  let reads = 0
  const h = harness({
    profileStore: () => ({
      read: async () => ((reads++), { kdf: { v: 1, salt: SALT_B64 } }),
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  h.storage.set('v0', 'v0:phrase') // pre-generation storage: trusted at the baseline
  const handle = h.session.external()
  expect(await handle.profile()).toEqual({ v: 1, salt: SALT_B64 })
  // a session acquisition afterwards reuses the SAME resolved flight: still one read
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(reads, 'one read across the external consumer and the session flight').toBe(1)
  expect(h.log[0], 'the pre-anchored hash was trusted (upgrade prompt)').toBe('promptUpgrade')

  // and a v0 hash written AFTER the external profile() anchored the baseline is NOT trusted:
  // the required existing-phrase prompt runs instead of the upgrade comparison, and the
  // candidate can only establish AS the stored value (the seal guard forbids diverging from a
  // current non-null store — review 90 §2.1)
  const h2 = harness({
    promptPhrase: async () => (h2.log.push('promptPhrase'), 'late'),
    attemptV0: async (row, v0secret) => row.kind == 'text' && row.cipher == 'v0-good' && v0secret == 'v0:late',
  })
  const handle2 = h2.session.external()
  await handle2.profile()
  h2.storage.set('v0', 'v0:late') // post-anchor write (unestablished flow)
  h2.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  const outcome2 = await h2.session.acquire()
  expect(outcome2.kind).toBe('ready')
  expect(h2.log.filter(l => l.startsWith('prompt'))[0], 'required prompt, not the trusted-hash upgrade').toBe(
    'promptPhrase'
  )
  expect(outcome2.kind == 'ready' && outcome2.keys.v0Secret, 'established as itself, corpus-validated').toBe('v0:late')
})

test('external adoption after clear() is REFUSED: nothing persisted, nothing cached (review 85 §2.5)', async () => {
  const h = harness()
  const handle = h.session.external()
  const profile = await handle.profile()
  const derived = await handle.derive('phrase', profile!)
  h.session.clear('sign-out mid-adoption')
  const cleared = h.log.length // clearPersisted just logged
  expect(handle.stale()).toBe(true)
  expect(handle.adopt('v0:phrase', SALT_B64, derived)).toBe(false)
  expect(h.log.length, 'no persistEnvelope after the refusal').toBe(cleared)
  expect(h.session.current()).toBeNull()
})

test('a STALE external handle starts NO effects: zero reads and zero workers after clear() (review 87 §2.5)', async () => {
  let reads = 0
  let workers = 0
  const h = harness({
    profileStore: () => ({
      read: async () => ((reads++), { kdf: { v: 1, salt: SALT_B64 } }),
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
    createWorker: () => ((workers++), { derive: async () => KEY, dispose: () => undefined }),
  })
  const handle = h.session.external()
  h.session.clear('sign-out before any effect')
  await expect(handle.profile()).rejects.toThrow('superseded')
  await expect(handle.derive('phrase', { v: 1, salt: SALT_B64 })).rejects.toThrow('superseded')
  expect(reads, 'the server was never contacted').toBe(0)
  expect(workers, 'no worker was created').toBe(0)
})

test('external profile() is null when disabled and propagates present-invalid (fail closed)', async () => {
  const off = harness({ enabled: () => false })
  expect(await off.session.external().profile()).toBeNull()
  const bad = harness({
    profileStore: () => ({
      read: async () => ({ kdf: { v: 2, salt: SALT_B64 } }),
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  await expect(bad.session.external().profile()).rejects.toThrow('unsupported kdf version')
})

test('a CONCURRENT derivation is refused as an invariant violation, not silently raced (review 87 §3.3)', async () => {
  let releaseDerive: (k: Uint8Array) => void = () => {}
  const h = harness({
    createWorker: () => ({
      derive: () => new Promise<Uint8Array>(resolve => (releaseDerive = resolve)),
      dispose: () => undefined,
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  const flight = h.session.acquire() // reaches derivation and parks there
  await new Promise(r => setTimeout(r, 0))
  const handle = h.session.external()
  await expect(handle.derive('phrase', { v: 1, salt: SALT_B64 })).rejects.toThrow('concurrent kdf derivation')
  releaseDerive(KEY)
  expect((await flight).kind).toBe('ready')
})

test('invalidate() fences and forgets in-memory state but KEEPS the persisted stores', async () => {
  const h = harness()
  h.storage.set('v0', 'v0:phrase')
  expect((await h.session.acquire()).kind).toBe('ready')
  h.session.invalidate('external auth transition')
  expect(h.session.current(), 'in-memory session forgotten').toBeNull()
  expect(h.log.filter(l => l == 'clearPersisted'), 'persisted stores untouched').toEqual([])
  expect(h.storage.get('env'), 'the envelope survives for the reloaded page').toBeTruthy()
  // the baseline re-anchors on the surviving stores: the kept v0 secret is trusted again
  expect((await h.session.acquire()).kind, 'a fresh acquire works from the kept stores').toBe('ready')
})

test('BINDING CONFLICT is terminal, never destructively recovered (review 89 §2.1)', async () => {
  // both values predate the generation (an old build wrote hash B; envelope A survived): v1(A)
  // ciphertext may exist, so sealing B over A would strand it while attesting completeness.
  // fail closed: no prompt, no derivation, no publication, both stores preserved
  const h = harness()
  h.storage.set('env', envelope('v0:phrase')) // establishment A
  h.storage.set('v0', 'v0:other') // unrelated stable legacy hash B
  const before = h.storage.get('env')
  expect(reasonOf(await h.session.acquire())).toBe('key binding conflict')
  expect(h.log, 'zero effects').toEqual([])
  expect(h.derivations()).toBe(0)
  expect(h.storage.get('env'), 'envelope A preserved').toBe(before)
  expect(h.storage.get('v0'), 'hash B preserved').toBe('v0:other')
  expect(h.session.current()).toBeNull()
  // the DISTINCT mid-generation case still establishes via the corpus: stored == envelope.v0
  // but != baseline routes to the required prompt, not the conflict outcome and not trust
  const h2 = harness()
  h2.storage.set('env', envelope('v0:phrase'))
  await h2.session.acquire() // anchor baseline: v0 absent
  h2.storage.set('v0', 'v0:phrase') // mid-generation write matching the envelope binding
  h2.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  expect((await h2.session.acquire()).kind).toBe('ready')
  expect(h2.log.filter(l => l.startsWith('prompt'))[0], 'required prompt, corpus-validated').toBe('promptPhrase')
})

test('the SEAL shares the final revision check’s continuation: no microtask gap (review 89 §2.3)', async () => {
  // park importKey so the final derivation resolves under our control, then use nested
  // microtasks to land a note exactly where a REDUNDANT resolved-memo await would yield. the
  // corrected code has no yield there: at note time the session is already sealed
  let releaseImport: (k: CryptoKey) => void = () => {}
  let sealedAtNote: boolean | null = null
  const h = harness({
    importKey: () => new Promise<CryptoKey>(resolve => (releaseImport = resolve)),
  })
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  const flight = h.session.acquire()
  await new Promise(r => setTimeout(r, 0)) // parked inside importKey (the derivation tail)
  queueMicrotask(() =>
    queueMicrotask(() =>
      queueMicrotask(() => {
        sealedAtNote = h.session.current() != null
        h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-late-rejecting' })
      })
    )
  )
  releaseImport(FAKE_KEY)
  const outcome = await flight
  expect(outcome.kind).toBe('ready')
  // the invariant: a row can never land INSIDE the establishment window yet go unvalidated —
  // either it arrived after the seal (sealedAtNote) or the policy consulted it
  expect(sealedAtNote, 'the note ran').not.toBeNull()
  expect(sealedAtNote, 'no unvalidated row can precede the seal').toBe(true)
})

test('BOUND RESTORE: a v0 hash written MID-GENERATION cannot complete a parked restore (review 88 §2.1)', async () => {
  // the flight parks on the profile read with an envelope and NO v0; the poison then writes the
  // very hash the envelope names — presence is not provenance, and the baseline refuses it
  let releaseRead: (data: Record<string, unknown>) => void = () => {}
  const h = harness({
    profileStore: () => ({
      read: () => new Promise<Record<string, unknown>>(resolve => (releaseRead = resolve)),
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
    promptPhrase: async () => (h.log.push('promptPhrase'), null),
  })
  h.storage.set('env', envelope('v0:phrase'))
  const flight = h.session.acquire() // baseline anchors: v0 absent
  await new Promise(r => setTimeout(r, 0))
  h.storage.set('v0', 'v0:phrase') // mid-generation write matching the envelope
  releaseRead({ kdf: { v: 1, salt: SALT_B64 } })
  const outcome = await flight
  expect(outcome.kind, 'never silently ready from a mid-generation write').toBe('not-ready')
  expect(h.log, 'it fell through to the REQUIRED prompt instead').toContain('promptPhrase')
})

test('external adopt() is ONE COMPLETE PUBLICATION: v0 published, envelope bound, session cached (review 88 §2.1)', async () => {
  const h = harness()
  const handle = h.session.external()
  const profile = await handle.profile()
  const derived = await handle.derive('phrase', profile!)
  expect(handle.adopt('v0:phrase', SALT_B64, derived)).toBe(true)
  expect(h.log).toContain('publishV0:v0:phrase')
  expect(h.storage.get('v0'), 'the v0 half is published, not assumed').toBe('v0:phrase')
  expect(JSON.parse(h.storage.get('env')!).v0, 'the envelope carries its establishment').toBe('v0:phrase')
  expect(h.session.current()?.v0Secret).toBe('v0:phrase')
  // a fresh generation restores silently from the surviving BOUND stores (invalidate resets the
  // baseline, so this observes re-anchoring on the adopted publication — not baseline advance)
  h.session.invalidate('reload')
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(h.log.filter(l => l.startsWith('prompt'))).toEqual([])
})

test('LIVE EVIDENCE: a v0 row arriving during a parked v1 attempt forces the mixed-corpus policy (review 88 §2.3)', async () => {
  // the v1-only verdict would establish; the late v0 row must be consulted before anything seals
  let releaseV1: (ok: boolean) => void = () => {}
  let v1Calls = 0
  const phrases: (string | null)[] = ['phrase', null]
  const h = harness({
    attemptV1: () => ((v1Calls++), new Promise<boolean>(resolve => (releaseV1 = resolve))),
    attemptV0: async () => false, // the candidate cannot open the late v0 row
    promptPhrase: async () => phrases.shift() ?? null,
  })
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  const flight = h.session.acquire()
  await new Promise(r => setTimeout(r, 0)) // parked inside the v1 attempt
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-late' }) // late v0 evidence
  releaseV1(true) // the snapshot verdict says established — but the revision moved
  const outcome = await flight
  expect(reasonOf(outcome), 'the fuller collection refused the candidate').toBe('cancelled')
  expect(h.log).toContain('wrongNotice')
  expect(h.log.filter(l => l == 'persistEnvelope'), 'nothing sealed past the late row').toEqual([])
})

test('LIVE EVIDENCE: a cipher arriving during the FRESH-SEAL derivation is validated before sealing (review 88 §2.3)', async () => {
  let releaseDerive: (k: Uint8Array) => void = () => {}
  const phrases: (string | null)[] = ['phrase', null]
  const h = harness({
    corpusConfirmedEmpty: () => true,
    attemptV0: async () => false, // the "fresh" phrase cannot open the late cipher
    createWorker: () => ({
      derive: () => new Promise<Uint8Array>(resolve => (releaseDerive = resolve)),
      dispose: () => undefined,
    }),
    promptPhrase: async () => (h.log.push('promptPhrase'), phrases.shift() ?? null),
  })
  const flight = h.session.acquire() // promptNewPhrase, then parks in the seal derivation
  await new Promise(r => setTimeout(r, 0))
  expect(h.log[0]).toBe('promptNewPhrase')
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-late' })
  releaseDerive(KEY)
  const outcome = await flight
  expect(reasonOf(outcome), 'the zero-row decision was revisited').toBe('cancelled')
  expect(h.log, 'the retry regime became the EXISTING-phrase prompt').toContain('promptPhrase')
  expect(h.log.filter(l => l == 'persistEnvelope'), 'no seal over unvalidated ciphertext').toEqual([])
})

test('LIVE EVIDENCE: a late row RESCUES a stale refusal without a second prompt (review 88 §2.3)', async () => {
  // the snapshot verdict refuses (its only v1 row is corrupt); a valid row arrives while that
  // attempt is parked. the post-verdict revision check re-runs the policy instead of reporting a
  // wrong phrase the fuller collection would accept
  let releaseFirst: (ok: boolean) => void = () => {}
  let parkedOnce = false
  const h = harness({
    attemptV1: (row): Promise<boolean> => {
      if (row.kind == 'text' && row.cipher == 'v1-corrupt') {
        if (parkedOnce) return Promise.resolve(false) // the re-run refuses it immediately
        parkedOnce = true
        return new Promise<boolean>(resolve => (releaseFirst = resolve))
      }
      return Promise.resolve(row.kind == 'text' && row.cipher == 'v1-good')
    },
  })
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-corrupt' })
  const flight = h.session.acquire()
  await new Promise(r => setTimeout(r, 0)) // parked inside the corrupt row's attempt
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  releaseFirst(false) // the snapshot verdict is a REFUSAL — but the revision moved
  const outcome = await flight
  expect(outcome.kind, 'the fuller collection established').toBe('ready')
  expect(h.log.filter(l => l == 'wrongNotice'), 'no spurious wrong-phrase notice').toEqual([])
  expect(h.log.filter(l => l == 'promptPhrase'), 'one prompt').toHaveLength(1)
})

test('REQUIRED RETRY: wrong then right establishes in ONE flight (review 88 §2.4)', async () => {
  const phrases: (string | null)[] = ['wrong', 'phrase']
  const h = harness({ promptPhrase: async () => phrases.shift() ?? null })
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  const outcome = await h.session.acquire()
  expect(outcome.kind).toBe('ready')
  expect(h.log.filter(l => l == 'wrongNotice'), 'one notice between the attempts').toHaveLength(1)
  expect(h.log.filter(l => l.startsWith('warn:')), 'and NO second (non-blocking) warning').toEqual([])
  expect(h.derivations(), 'the refused candidate paid no derivation; the established one derived once').toBe(1)
  expect(outcome.kind == 'ready' && outcome.keys.v0Secret).toBe('v0:phrase')
})

test('DECLINE releases the evidence and notes become inert until the next generation (review 88 §4)', async () => {
  const h = harness({ promptUpgrade: async () => null })
  h.storage.set('v0', 'v0:phrase')
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  expect(reasonOf(await h.session.acquire())).toBe('declined')
  // the retained corpus is gone and later notes do not accumulate for the tab lifetime
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-more' })
  h.storage.delete('v0') // remove the trusted hash so the prompt regime depends on evidence
  expect(reasonOf(await h.session.acquire()), 'no evidence survives the decline').toBe(
    'no evidence to validate a first phrase'
  )
})

test('CONFLICT is representation-wide: a MID-GENERATION store against envelope A refuses pre-prompt (review 90 §2.1)', async () => {
  // review 90's counterexample: baseline anchors null; the profile read parks; B plus
  // B-authenticating evidence arrive; the old baseline-conditioned guard missed this and let B
  // seal over envelope A
  let releaseRead: (data: Record<string, unknown>) => void = () => {}
  const h = harness({
    profileStore: () => ({
      read: () => new Promise<Record<string, unknown>>(resolve => (releaseRead = resolve)),
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  h.storage.set('env', envelope('v0:phrase')) // establishment A
  const flight = h.session.acquire() // baseline anchors: stored v0 is null
  await new Promise(r => setTimeout(r, 0))
  h.storage.set('v0', 'v0:other') // mid-generation B
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  releaseRead({ kdf: { v: 1, salt: SALT_B64 } })
  expect(reasonOf(await flight)).toBe('key binding conflict')
  expect(h.log.filter(l => l.startsWith('prompt')), 'no prompt over a contradiction').toEqual([])
  expect(h.storage.get('env'), 'envelope preserved').toBeTruthy()
  expect(h.storage.get('v0'), 'store preserved').toBe('v0:other')
})

test('the SEAL GUARD refuses a publication over a representation that changed mid-prompt (review 90 §2.1)', async () => {
  const h = harness({
    promptUpgrade: async () => {
      h.log.push('promptUpgrade')
      h.storage.set('v0', 'v0:other') // the store changes while the prompt is open
      return 'phrase'
    },
  })
  h.storage.set('v0', 'v0:phrase') // trusted at the baseline
  expect(reasonOf(await h.session.acquire())).toBe('key binding conflict')
  expect(h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope'), 'nothing published').toEqual([])
  expect(h.storage.get('v0'), 'the newer store wins preservation').toBe('v0:other')
  expect(h.session.current()).toBeNull()
})

test('external adopt() is guarded by the same predicate: a contradictory store refuses adoption (review 90 §2.1)', async () => {
  const h = harness()
  const handle = h.session.external()
  const profile = await handle.profile()
  const derived = await handle.derive('phrase', profile!)
  h.storage.set('v0', 'v0:other') // a different establishment landed before adoption
  expect(handle.adopt('v0:phrase', SALT_B64, derived)).toBe(false)
  expect(h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope'), 'nothing adopted').toEqual([])
  expect(h.session.current()).toBeNull()
})

test('BOUND RESTORE is rechecked after importKey: a store changed mid-import is never cached (review 90 §2.2)', async () => {
  let releaseImport: (k: CryptoKey) => void = () => {}
  const h = harness({ importKey: () => new Promise<CryptoKey>(resolve => (releaseImport = resolve)) })
  h.storage.set('v0', 'v0:phrase')
  h.storage.set('env', envelope('v0:phrase')) // complete bound state A
  const flight = h.session.acquire()
  await new Promise(r => setTimeout(r, 0)) // parked inside importKey
  h.storage.set('v0', 'v0:other') // the store changes to B across the import
  releaseImport(FAKE_KEY)
  expect(reasonOf(await flight), 'terminal on the known drift, never cached ready').toBe('representation changed')
  expect(h.session.current(), 'no A session cached beside store B').toBeNull()

  // offline variant: the same parked import must stay not-ready
  let releaseImport2: (k: CryptoKey) => void = () => {}
  const h2 = harness({
    importKey: () => new Promise<CryptoKey>(resolve => (releaseImport2 = resolve)),
    profileStore: () => ({
      read: async () => {
        throw new Error('offline')
      },
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  h2.storage.set('v0', 'v0:phrase')
  h2.storage.set('env', envelope('v0:phrase'))
  const flight2 = h2.session.acquire()
  await new Promise(r => setTimeout(r, 0))
  h2.storage.set('v0', 'v0:other')
  releaseImport2(FAKE_KEY)
  expect(reasonOf(await flight2)).toBe('offline without complete persisted keys')
  expect(h2.session.current()).toBeNull()
})

test('ENVELOPE IDENTITY: a same-v0 KEY swap across a parked import is never cached (review 91 §2.1)', async () => {
  // E1(A,K1) is being restored; E2(A,K2) replaces it mid-import. the v0 binding still matches,
  // but the imported key is not what storage promises — nothing may cache, and the fallthrough
  // candidate (deriving K1) refuses at the key-aware seal guard
  let imports = 0
  let releaseImport: (k: CryptoKey) => void = () => {}
  const h = harness({
    importKey: () =>
      ++imports == 1 ? new Promise<CryptoKey>(resolve => (releaseImport = resolve)) : Promise.resolve(FAKE_KEY),
  })
  h.storage.set('v0', 'v0:phrase')
  h.storage.set('env', envelope('v0:phrase', SALT_B64, KEY)) // E1: key K1
  const flight = h.session.acquire()
  await new Promise(r => setTimeout(r, 0)) // parked inside importKey(K1)
  h.storage.set('env', envelope('v0:phrase', SALT_B64, OTHER_KEY)) // E2: same v0, key K2
  releaseImport(FAKE_KEY)
  expect(reasonOf(await flight), 'terminal immediately: no prompt or Argon spent on a known drift').toBe(
    'representation changed'
  )
  expect(h.log.filter(l => l.startsWith('prompt')), 'no prompt').toEqual([])
  expect(h.derivations(), 'no derivation').toBe(0)
  expect(h.session.current(), 'no mismatched key cached').toBeNull()
  expect(JSON.parse(h.storage.get('env')!).key, 'E2 preserved').toBe(JSON.parse(envelope('v0:phrase', SALT_B64, OTHER_KEY)).key)
})

test('ENVELOPE IDENTITY offline: a same-v0 salt/key replacement across a parked import fails closed (review 91 §2.1)', async () => {
  let imports = 0
  let releaseImport: (k: CryptoKey) => void = () => {}
  const h = harness({
    importKey: () =>
      ++imports == 1 ? new Promise<CryptoKey>(resolve => (releaseImport = resolve)) : Promise.resolve(FAKE_KEY),
    profileStore: () => ({
      read: async () => {
        throw new Error('offline')
      },
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  h.storage.set('env', envelope('v0:phrase', SALT_B64, KEY))
  const flight = h.session.acquire()
  await new Promise(r => setTimeout(r, 0))
  h.storage.set('env', envelope('v0:phrase', OTHER_SALT_B64, OTHER_KEY)) // same v0, new salt AND key
  releaseImport(FAKE_KEY)
  expect(reasonOf(await flight)).toBe('offline without complete persisted keys')
  expect(h.session.current()).toBeNull()
})

test('the SEAL/ADOPT guard is key-aware: K1 cannot overwrite a same-v0 K2 envelope (review 91 §2.1)', async () => {
  const h = harness()
  const handle = h.session.external()
  const profile = await handle.profile()
  const derived = await handle.derive('phrase', profile!) // keyBytes K1 (harness KEY)
  h.storage.set('v0', 'v0:phrase')
  h.storage.set('env', envelope('v0:phrase', SALT_B64, OTHER_KEY)) // same v0, key K2
  expect(handle.adopt('v0:phrase', SALT_B64, derived), 'contradictory key representation').toBe(false)
  expect(h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope'), 'nothing adopted').toEqual([])
  expect(h.session.current()).toBeNull()
})

test('CACHED READINESS is validated against the current representation (review 91 §2.2)', async () => {
  // (a) a full B/K2 replacement under a ready A/K1 session
  const h = harness()
  h.storage.set('v0', 'v0:phrase')
  h.storage.set('env', envelope('v0:phrase'))
  expect((await h.session.acquire()).kind).toBe('ready')
  h.storage.set('v0', 'v0:other')
  h.storage.set('env', envelope('v0:other', SALT_B64, OTHER_KEY))
  expect(h.session.current(), 'readiness is false the moment it is polled').toBeNull()
  expect(reasonOf(await h.session.acquire()), 'the cached call fails closed').toBe('representation changed')
  expect(h.log.filter(l => l.startsWith('prompt')), 'no prompt from the cached-return path').toEqual([])
  expect(h.storage.get('v0'), 'stores preserved').toBe('v0:other')
  // within THIS generation the drifted pair stays untrusted (the baseline still names A) —
  // only a fresh generation (reload / auth transition) re-anchors on the surviving stores and
  // may legitimately restore the complete bound B/K2 state
  expect(reasonOf(await h.session.acquire()), 'B is mid-generation: not silently adopted').toBe(
    'no evidence to validate a first phrase'
  )
  h.session.invalidate('cross-tab change noticed')
  const later = await h.session.acquire()
  expect(later.kind == 'ready' && later.keys.v0Secret, 'the fresh generation restores B').toBe('v0:other')

  // (b) a key-only swap (same salt and v0) also invalidates readiness
  const h2 = harness()
  h2.storage.set('v0', 'v0:phrase')
  h2.storage.set('env', envelope('v0:phrase'))
  expect((await h2.session.acquire()).kind).toBe('ready')
  h2.storage.set('env', envelope('v0:phrase', SALT_B64, OTHER_KEY))
  expect(h2.session.current()).toBeNull()
  expect(reasonOf(await h2.session.acquire())).toBe('representation changed')

  // (c) either persisted half disappearing invalidates readiness with no prompt or publication
  const h3 = harness()
  h3.storage.set('v0', 'v0:phrase')
  h3.storage.set('env', envelope('v0:phrase'))
  expect((await h3.session.acquire()).kind).toBe('ready')
  h3.storage.delete('v0')
  expect(h3.session.current()).toBeNull()
  expect(reasonOf(await h3.session.acquire())).toBe('representation changed')
  expect(h3.log.filter(l => l.startsWith('prompt') || l.startsWith('publishV0')), 'zero effects').toEqual([])
})

test('CACHED READINESS: the ENVELOPE half disappearing also invalidates readiness (review 92 §3)', async () => {
  const h = harness()
  h.storage.set('v0', 'v0:phrase')
  h.storage.set('env', envelope('v0:phrase'))
  expect((await h.session.acquire()).kind).toBe('ready')
  h.storage.delete('env')
  expect(h.session.current()).toBeNull()
  expect(reasonOf(await h.session.acquire())).toBe('representation changed')
})

test('the pending-join established-meanwhile branch validates the cached identity too (review 92 §3)', async () => {
  let resolveV0: (v: string) => void = () => {}
  const v0flight = new Promise<string>(resolve => (resolveV0 = resolve))
  const h = harness({ pendingV0: () => v0flight })
  const acquired = h.session.acquire()
  await new Promise(r => setTimeout(r, 0)) // parked at the join
  // a fixed adoption establishes A/K1 — and then the representation drifts before the join wakes
  const handle = h.session.external()
  const profile = await handle.profile()
  const derived = await handle.derive('phrase', profile!)
  expect(handle.adopt('v0:phrase', SALT_B64, derived)).toBe(true)
  h.storage.set('env', envelope('v0:phrase', SALT_B64, OTHER_KEY)) // key swapped under the cache
  resolveV0('v0:phrase')
  expect(reasonOf(await acquired), 'the joined branch fails closed like every cached return').toBe(
    'representation changed'
  )
  expect(h.session.current()).toBeNull()
})

test('OFFLINE identity isolates the SALT: a same-v0 same-key salt change across import fails closed (review 92 §3)', async () => {
  let imports = 0
  let releaseImport: (k: CryptoKey) => void = () => {}
  const h = harness({
    importKey: () =>
      ++imports == 1 ? new Promise<CryptoKey>(resolve => (releaseImport = resolve)) : Promise.resolve(FAKE_KEY),
    profileStore: () => ({
      read: async () => {
        throw new Error('offline')
      },
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  h.storage.set('env', envelope('v0:phrase', SALT_B64, KEY))
  const flight = h.session.acquire()
  await new Promise(r => setTimeout(r, 0))
  h.storage.set('env', envelope('v0:phrase', OTHER_SALT_B64, KEY)) // ONLY the salt changes
  releaseImport(FAKE_KEY)
  expect(reasonOf(await flight)).toBe('offline without complete persisted keys')
  expect(h.session.current()).toBeNull()
})

test('a PRESENT empty-string store is a value, not absence: it conflicts with a bound envelope (review 91 §3)', async () => {
  const h = harness()
  h.storage.set('env', envelope('v0:phrase'))
  h.storage.set('v0', '')
  expect(reasonOf(await h.session.acquire())).toBe('key binding conflict')
  expect(h.log.filter(l => l.startsWith('prompt')), 'no prompt over the contradiction').toEqual([])
})

test('disabled and ineligible are not-ready without any effect', async () => {
  const off = harness({ enabled: () => false })
  expect(reasonOf(await off.session.acquire())).toBe('kdf disabled')
  const foreign = harness({ eligible: () => false })
  expect(reasonOf(await foreign.session.acquire())).toBe('ineligible page mode')
  expect(off.log).toEqual([])
  expect(foreign.log).toEqual([])
})
