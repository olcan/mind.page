import { expect, test } from '@playwright/test'
import { createKdfSession, type KdfAcquireOutcome, type KdfSessionDeps } from '../../src/kdf_session.js'
import { encodeKeyEnvelope, encodeSalt } from '../../src/kdf_profile.js'

// the SESSION ORCHESTRATOR's state machine (src/kdf_session.ts), driven with injected effects —
// review 85 §6's table plus review 86 §5's schedule rows: these exist because helper tests could
// not see the component wiring defects (the broad offline catch, the cached not-ready, the frozen
// evidence boolean, the second offer pipeline, the resurrected envelope). Every row is
// milliseconds; no Argon, no worker, no browser.

const SALT = new Uint8Array(16).fill(7)
const SALT_B64 = encodeSalt(SALT)
const KEY = new Uint8Array(32).map((_, i) => i)
const FAKE_KEY = { fake: 'CryptoKey' } as unknown as CryptoKey

// outcome reader (plain narrowing — the union carries reason only on not-ready)
const reasonOf = (o: KdfAcquireOutcome) => (o.kind == 'not-ready' ? o.reason : o.kind)

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
    hashPhrase: async phrase => 'v0:' + phrase,
    publishV0: v0 => void log.push('publishV0:' + v0),
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

test('happy upgrade: profile, prompt validated by the stored v0 hash, one derivation, envelope last', async () => {
  const h = harness()
  h.storage.set('v0', 'v0:phrase') // a returning device
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

test('a matching envelope needs NO prompt and no derivation', async () => {
  const h = harness()
  h.storage.set('env', encodeKeyEnvelope({ uid: 'uid-1', salt: SALT_B64, keyBytes: KEY }))
  const outcome = await h.session.acquire()
  expect(outcome.kind).toBe('ready')
  expect(h.derivations()).toBe(0)
  expect(h.log).toEqual([])
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
  // a valid envelope is present — the old broad catch would have restored it
  h.storage.set('env', encodeKeyEnvelope({ uid: 'uid-1', salt: SALT_B64, keyBytes: KEY }))
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
  h.storage.set('env', encodeKeyEnvelope({ uid: 'uid-1', salt: SALT_B64, keyBytes: KEY }))
  await expect(h.session.acquire()).rejects.toThrow('transaction failed')
})

test('OFFLINE (the read itself fails) reuses a committed envelope; without one it is not-ready and RETRYABLE', async () => {
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
  expect(reasonOf(await h.session.acquire())).toBe('offline without a committed envelope')
  // the not-ready outcome was NOT cached (and neither was the offline profile flight):
  // connectivity returns, the next call succeeds
  readable = true
  h.storage.set('v0', 'v0:phrase')
  expect((await h.session.acquire()).kind).toBe('ready')

  // and with an envelope, offline reuse works without any prompt
  const h2 = harness({
    profileStore: () => ({
      read: async () => {
        throw new Error('offline')
      },
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  h2.storage.set('env', encodeKeyEnvelope({ uid: 'uid-1', salt: SALT_B64, keyBytes: KEY }))
  expect((await h2.session.acquire()).kind).toBe('ready')
  expect(h2.log).toEqual([])
})

test('a CONFIRMED salt mismatch clears the envelope — decline then offline cannot resurrect it (review 86 §2.4)', async () => {
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
    promptUpgrade: async () => null, // the user declines the upgrade
  })
  // a VALID same-uid envelope from a previous provisioning epoch (different salt)
  h.storage.set('env', encodeKeyEnvelope({ uid: 'uid-1', salt: encodeSalt(new Uint8Array(16).fill(9)), keyBytes: KEY }))
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('declined')
  expect(h.log, 'cleared BEFORE the prompt, on the online confirmation').toContain('clearEnvelope')
  expect(h.storage.get('env'), 'the obsolete envelope is gone').toBeUndefined()
  // a later OFFLINE load must not restore the old key
  online = false
  expect(reasonOf(await h.session.acquire()), 'not-ready, never a resurrected session').toBe(
    'upgrade declined this session'
  )
  expect(h.session.current()).toBeNull()
})

test('an envelope for a DIFFERENT salt falls through to the prompt; the new envelope replaces it', async () => {
  const h = harness()
  h.storage.set('env', encodeKeyEnvelope({ uid: 'uid-1', salt: encodeSalt(new Uint8Array(16).fill(9)), keyBytes: KEY }))
  h.storage.set('v0', 'v0:phrase')
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(h.log).toContain('clearEnvelope') // the obsolete epoch's envelope was removed, then replaced
  expect(h.log).toContain('promptUpgrade')
  expect(h.session.current()?.salt, 'the PROFILE salt, not the stale envelope’s').toBe(SALT_B64)
})

test('DECLINE is a session no-nag: later acquires do not re-prompt, and clear() forgets it', async () => {
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

test('a WRONG phrase against the stored v0 hash never derives, publishes, or persists', async () => {
  const h = harness({ promptUpgrade: async () => 'wrong' })
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('wrong phrase')
  expect(h.derivations()).toBe(0)
  expect(h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope')).toEqual([])
})

test('a FIRST phrase validates against collected v1 evidence, then publishes BOTH regimes', async () => {
  const h = harness()
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  const outcome = await h.session.acquire()
  expect(outcome.kind).toBe('ready')
  expect(h.log[0]).toBe('promptPhrase')
  // THE ONE-PHRASE-BOTH-REGIMES rule: v0 publishes before the acquisition resolves
  expect(h.log).toContain('publishV0:v0:phrase')
  // without evidence, the phrase cannot be validated at all
  const h2 = harness()
  expect(reasonOf(await h2.session.acquire())).toBe('no evidence to validate a first phrase')
  expect(h2.derivations(), 'and nothing derives for an unvalidatable prompt').toBe(0)
})

test('MIXED corpus: v1 success alone is INSUFFICIENT while v0 evidence exists (review 86 §2.2)', async () => {
  // the NFC-equivalence hole: a spelling can open the v1 row while hashing to a different exact
  // legacy v0 secret — establishCandidate requires the v0 authentication
  const h = harness({
    attemptV0: async () => false, // the candidate's v0 hash opens nothing
    attemptV1: async () => true, // yet its derived key opens v1 rows
  })
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  expect(reasonOf(await h.session.acquire())).toBe('wrong phrase')
  expect(h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope'), 'nothing sealed').toEqual([])
  expect(h.session.current()).toBeNull()
})

test('a CORRUPT first v1 row does not wedge validation: the second row establishes (review 86 §2.2)', async () => {
  const attempts: string[] = []
  const h = harness({
    attemptV1: async row => {
      attempts.push(row.kind == 'text' ? row.cipher : 'bytes')
      return row.kind == 'text' && row.cipher == 'v1-good'
    },
  })
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-corrupt' })
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(attempts, 'iterated past the corrupt row').toEqual(['v1-corrupt', 'v1-good'])
})

test('DEFERRED PROFILE: evidence noted after the flight began PROMOTES it (review 86 §2.1)', async () => {
  // the proactive trigger starts with NO evidence; a v1 decrypt joins while the profile read is
  // pending. the old frozen boolean returned the weaker "no evidence" result to BOTH callers
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

test('REVERSE OFFER SCHEDULE: an offer registered mid-flight is consumed as ITS candidate — no second pipeline (review 86 §2.3)', async () => {
  // the flight is paused at the profile read; the component's v0 prompt finishes (its flight
  // already settled, so pendingV0 is null) and offers the phrase. the SAME flight consumes it
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
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  const flight = h.session.acquire()
  await new Promise(r => setTimeout(r, 0))
  const offer = h.session.offerPhrase('phrase') // returns the SAME flight
  releaseRead({ kdf: { v: 1, salt: SALT_B64 } })
  const [a, o] = await Promise.all([flight, offer])
  expect(a.kind).toBe('ready')
  expect(o).toEqual(a)
  expect(reads, 'one profile read').toBe(1)
  expect(h.derivations(), 'one derivation across both paths').toBe(1)
  expect(h.log.filter(l => l.startsWith('prompt')), 'the session never prompted').toEqual([])
  expect(h.log.filter(l => l.startsWith('publishV0')), 'an offered phrase never re-publishes v0').toEqual([])
})

test('a WRONG offered candidate seals nothing: corpus validation gates the envelope (review 86 §2.3)', async () => {
  // the component's "Enter your secret phrase" flow publishes the v0 hash BEFORE any decrypt
  // authenticates it — the session must not trust that publication
  const h = harness()
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  // the offered phrase hashes to a non-matching candidate; attemptV0 (default) refuses it
  expect(reasonOf(await h.session.offerPhrase('wrong'))).toBe('wrong phrase')
  expect(h.log.filter(l => l == 'persistEnvelope' || l.startsWith('publishV0')), 'nothing sealed').toEqual([])
  expect(h.session.current()).toBeNull()
  expect(h.derivations(), 'the wrong candidate cost one derivation').toBe(1)
  // the right phrase afterwards succeeds (the wrong offer cached nothing)
  expect((await h.session.offerPhrase('phrase')).kind).toBe('ready')
})

test('a FRESH (newly chosen) phrase may seal without evidence — but validates when evidence exists', async () => {
  // fresh + empty account: nothing to validate against, the phrase is definitionally correct
  const h = harness()
  expect((await h.session.offerPhrase('phrase', { fresh: true })).kind).toBe('ready')
  expect(h.log, 'envelope only: no prompt, no v0 publication').toEqual(['persistEnvelope'])
  // fresh + evidence (a "new" phrase chosen over an account that actually has ciphertext): the
  // evidence still gates it
  const h2 = harness({ attemptV0: async () => false })
  h2.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  expect(reasonOf(await h2.session.offerPhrase('phrase', { fresh: true }))).toBe('wrong phrase')
  expect(h2.log.filter(l => l == 'persistEnvelope')).toEqual([])
  // and a non-fresh offer with NO evidence cannot establish at all
  const h3 = harness()
  expect(reasonOf(await h3.session.offerPhrase('phrase'))).toBe('no evidence to validate a first phrase')
  expect(h3.log.filter(l => l == 'persistEnvelope')).toEqual([])
})

test('acquire JOINS a pending v0 flight and consumes its offer — one prompt, both regimes (review 85 §2.2)', async () => {
  let resolveV0: (v: string) => void = () => {}
  const v0flight = new Promise<string>(resolve => (resolveV0 = resolve))
  const h = harness({ pendingV0: () => v0flight })
  h.session.noteEvidence('v0', { kind: 'text', cipher: 'v0-good' })
  const acquired = h.session.acquire()
  await new Promise(r => setTimeout(r, 0)) // let the acquisition reach the join
  // the v0 prompt tail: publish v0 (component-owned), REGISTER the offer, then settle the flight
  const offered = h.session.offerPhrase('phrase')
  resolveV0('v0:phrase')
  const [a, o] = await Promise.all([acquired, offered])
  expect(a.kind).toBe('ready')
  expect(o).toEqual(a)
  expect(h.derivations(), 'ONE derivation across both paths').toBe(1)
  expect(h.log.filter(l => l.startsWith('prompt')), 'the session never prompted').toEqual([])
})

test('a pending v0 flight that REJECTS (cancelled prompt) leaves acquire not-ready without a second prompt', async () => {
  const flight: Promise<string> = Promise.reject(new Error('cancelled'))
  flight.catch(() => undefined)
  const h = harness({ pendingV0: () => flight })
  h.storage.set('v0', 'v0:phrase')
  expect(reasonOf(await h.session.acquire())).toBe('v0 acquisition cancelled or failed')
  expect(h.log.filter(l => l.startsWith('prompt')), 'no nag behind their cancel').toEqual([])
})

test('EXTERNAL handle (fixed-owner): shared profile flight, session-slot derivation, fenced adoption', async () => {
  let reads = 0
  const h = harness({
    profileStore: () => ({
      read: async () => ((reads++), { kdf: { v: 1, salt: SALT_B64 } }),
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  const handle = h.session.external()
  expect(handle.uid).toBe('uid-1')
  const profile = await handle.profile()
  expect(profile).toEqual({ v: 1, salt: SALT_B64 })
  const derived = await handle.derive('phrase', profile!)
  expect(h.derivations()).toBe(1)
  expect(handle.adopt(SALT_B64, derived)).toBe(true)
  expect(h.log).toEqual(['persistEnvelope'])
  expect(h.session.current()?.salt, 'adopted as THE session').toBe(SALT_B64)
  // an acquire after adoption is a cache hit, and the PROFILE FLIGHT was shared: one read total
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(reads, 'the external profile() and any session acquisition share one flight').toBe(1)
})

test('external adoption after clear() is REFUSED: nothing persisted, nothing cached (§2.5)', async () => {
  const h = harness()
  const handle = h.session.external()
  const profile = await handle.profile()
  const derived = await handle.derive('phrase', profile!)
  h.session.clear('sign-out mid-adoption')
  const cleared = h.log.length // clearPersisted just logged
  expect(handle.stale()).toBe(true)
  expect(handle.adopt(SALT_B64, derived)).toBe(false)
  expect(h.log.length, 'no persistEnvelope after the refusal').toBe(cleared)
  expect(h.session.current()).toBeNull()
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

test('invalidate() fences and forgets in-memory state but KEEPS the persisted stores', async () => {
  const h = harness()
  h.storage.set('v0', 'v0:phrase')
  expect((await h.session.acquire()).kind).toBe('ready')
  h.session.invalidate('external auth transition')
  expect(h.session.current(), 'in-memory session forgotten').toBeNull()
  expect(h.log.filter(l => l == 'clearPersisted'), 'persisted stores untouched').toEqual([])
  expect(h.storage.get('env'), 'the envelope survives for the reloaded page').toBeTruthy()
  expect((await h.session.acquire()).kind, 'a fresh acquire still works from the kept envelope').toBe('ready')
})

test('noteEvidence is bounded, deduplicated, and inert when disabled', async () => {
  const attempts: string[] = []
  const h = harness({
    attemptV1: async row => (attempts.push(row.kind == 'text' ? row.cipher : 'bytes'), false),
  })
  for (let i = 0; i < 5; i++) h.session.noteEvidence('v1', { kind: 'text', cipher: `row-${i}` })
  h.session.noteEvidence('v1', { kind: 'text', cipher: 'row-0' }) // duplicate
  expect(reasonOf(await h.session.acquire())).toBe('wrong phrase')
  expect(attempts, 'at most the per-regime bound of rows was retained').toEqual(['row-0', 'row-1', 'row-2'])
  // disabled: nothing collects and acquisition refuses anyway
  const off = harness({ enabled: () => false })
  off.session.noteEvidence('v1', { kind: 'text', cipher: 'v1-good' })
  expect(reasonOf(await off.session.acquire())).toBe('kdf disabled')
})

test('disabled and ineligible are not-ready without any effect', async () => {
  const off = harness({ enabled: () => false })
  expect(reasonOf(await off.session.acquire())).toBe('kdf disabled')
  const foreign = harness({ eligible: () => false })
  expect(reasonOf(await foreign.session.acquire())).toBe('ineligible page mode')
  expect(off.log).toEqual([])
  expect(foreign.log).toEqual([])
})
