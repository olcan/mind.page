import { expect, test } from '@playwright/test'
import { createKdfSession, type KdfSessionDeps } from '../../src/kdf_session.js'
import { encodeKeyEnvelope, encodeSalt } from '../../src/kdf_profile.js'

// the SESSION ORCHESTRATOR's state machine (src/kdf_session.ts), driven with injected effects —
// review 85 §6's table: these rows exist because the previous helper tests could not see the
// component wiring defects (the broad offline catch, the cached not-ready, the second worker, the
// unfenced publications). Every row is milliseconds; no Argon, no worker, no browser.

const SALT = new Uint8Array(16).fill(7)
const SALT_B64 = encodeSalt(SALT)
const KEY = new Uint8Array(32).map((_, i) => i)
const FAKE_KEY = { fake: 'CryptoKey' } as unknown as CryptoKey

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
    pendingV0: () => null,
    storedEnvelope: () => storage.get('env') ?? null,
    persistEnvelope: encoded => void (storage.set('env', encoded), log.push('persistEnvelope')),
    clearPersisted: () => void (storage.delete('v0'), storage.delete('env'), log.push('clearPersisted')),
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
    validateV1: async () => true,
    createWorker: () => ({
      derive: async () => (derivations++, KEY),
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
  const first = await h.session.acquire()
  expect(first).toEqual({ kind: 'not-ready', reason: 'offline without a committed envelope' })
  // the not-ready outcome was NOT cached: connectivity returns, the next call succeeds
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

test('an envelope for a DIFFERENT salt falls through to the prompt; the new envelope replaces it', async () => {
  const h = harness()
  h.storage.set('env', encodeKeyEnvelope({ uid: 'uid-1', salt: encodeSalt(new Uint8Array(16).fill(9)), keyBytes: KEY }))
  h.storage.set('v0', 'v0:phrase')
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(h.log).toContain('promptUpgrade')
  expect(h.session.current()?.salt, 'the PROFILE salt, not the stale envelope’s').toBe(SALT_B64)
})

test('DECLINE is a session no-nag: later acquires do not re-prompt, and clear() forgets it', async () => {
  let prompts = 0
  const h = harness({ promptUpgrade: async () => (prompts++, null) })
  h.storage.set('v0', 'v0:phrase')
  expect((await h.session.acquire()).reason).toBe('declined')
  expect((await h.session.acquire()).reason, 'no second prompt').toBe('upgrade declined this session')
  expect(prompts).toBe(1)
  h.session.clear()
  h.storage.set('v0', 'v0:phrase') // clear() wiped persisted state through deps
  await h.session.acquire()
  expect(prompts, 'a fresh session may ask again').toBe(2)
})

test('a WRONG phrase against the stored v0 hash never derives, publishes, or persists', async () => {
  const h = harness({ promptUpgrade: async () => 'wrong' })
  h.storage.set('v0', 'v0:phrase')
  const outcome = await h.session.acquire()
  expect(outcome).toEqual({ kind: 'not-ready', reason: 'wrong phrase' })
  expect(h.derivations()).toBe(0)
  expect(h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope')).toEqual([])
})

test('a FIRST phrase (no stored v0) validates against the triggering v1 evidence, then publishes BOTH regimes', async () => {
  const h = harness({ validateV1: async () => true })
  const outcome = await h.session.acquire({ validationCipherKnown: true })
  expect(outcome.kind).toBe('ready')
  expect(h.log[0]).toBe('promptPhrase')
  // THE ONE-PHRASE-BOTH-REGIMES rule: v0 publishes before the acquisition resolves
  expect(h.log).toContain('publishV0:v0:phrase')
  // without evidence, the phrase cannot be validated at all
  const h2 = harness()
  expect((await h2.session.acquire()).reason).toBe('no evidence to validate a first phrase')
  expect(h2.derivations(), 'and nothing derives for an unvalidatable prompt').toBe(0)
})

test('a first phrase that FAILS v1 validation is refused with nothing published', async () => {
  const h = harness({ validateV1: async () => false })
  const outcome = await h.session.acquire({ validationCipherKnown: true })
  expect(outcome).toEqual({ kind: 'not-ready', reason: 'wrong phrase' })
  expect(h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope')).toEqual([])
})

test('STALE AT EVERY EFFECT BOUNDARY: a clear() during the prompt stops publication and persistence', async () => {
  const h = harness({
    promptUpgrade: async () => {
      h.session.clear('principal change mid-prompt')
      return 'phrase'
    },
  })
  h.storage.set('v0', 'v0:phrase')
  const outcome = await h.session.acquire()
  expect(outcome.reason).toBe('superseded')
  expect(
    h.log.filter(l => l.startsWith('publishV0') || l == 'persistEnvelope'),
    'zero effects'
  ).toEqual([])
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
  const outcome = await h.session.acquire()
  expect(outcome.reason).toBe('superseded')
  expect(h.session.current()).toBeNull()
  expect(h.log.filter(l => l == 'persistEnvelope')).toEqual([])
})

test('single-flight: concurrent acquires share one attempt; the slot clears on EVERY settle', async () => {
  let reads = 0
  const h = harness({
    profileStore: () => ({
      read: async () => (reads++, { kdf: { v: 1, salt: SALT_B64 } }),
      runTransaction: async body => body({ get: async () => ({}), set: () => {} }),
    }),
  })
  h.storage.set('v0', 'v0:phrase')
  const [a, b] = await Promise.all([h.session.acquire(), h.session.acquire()])
  expect(a.kind).toBe('ready')
  expect(b.kind).toBe('ready')
  expect(reads, 'one profile read for both callers').toBe(1)
})

test('OFFERED phrase (the v0 prompt was THE prompt): derives once, seals the envelope, never prompts', async () => {
  const h = harness()
  const outcome = await h.session.offerPhrase('phrase')
  expect(outcome.kind).toBe('ready')
  expect(h.derivations()).toBe(1)
  expect(h.log, 'no prompt, no v0 publication — only the envelope').toEqual(['persistEnvelope'])
  expect(h.session.current()?.salt).toBe(SALT_B64)
  // an offer with the session already held derives nothing more
  expect((await h.session.offerPhrase('phrase')).kind).toBe('ready')
  expect(h.derivations()).toBe(1)
})

test('an offer finding a MATCHING envelope (another tab upgraded) does not derive', async () => {
  const h = harness()
  h.storage.set('env', encodeKeyEnvelope({ uid: 'uid-1', salt: SALT_B64, keyBytes: KEY }))
  expect((await h.session.offerPhrase('phrase')).kind).toBe('ready')
  expect(h.derivations()).toBe(0)
})

test('an OFFLINE offer defers (not-ready), leaving the v0 regime untouched', async () => {
  const h = harness({
    profileStore: () => ({
      read: async () => {
        throw new Error('offline')
      },
      runTransaction: async () => {
        throw new Error('unreachable')
      },
    }),
  })
  expect((await h.session.offerPhrase('phrase')).reason).toBe('offline; v1 upgrade deferred')
  expect(h.derivations()).toBe(0)
  expect(h.log).toEqual([])
})

test('acquire JOINS a pending v0 flight and returns its registered offer — one prompt, both regimes (review 85 §2.2)', async () => {
  // the component's v0 prompt is mid-flight; no envelope, no stored v0 yet
  let resolveV0: (v: string) => void = () => {}
  const v0flight = new Promise<string>(resolve => (resolveV0 = resolve))
  const h = harness({ pendingV0: () => v0flight })
  const acquired = h.session.acquire({ validationCipherKnown: true })
  await new Promise(r => setTimeout(r, 0)) // let the acquisition reach the join
  // the v0 prompt tail: publish v0, REGISTER the offer, then settle the flight
  const offered = h.session.offerPhrase('phrase')
  resolveV0('v0:phrase')
  const [a, o] = await Promise.all([acquired, offered])
  expect(o.kind).toBe('ready')
  expect(a, 'the join returned the offer outcome').toEqual(o)
  expect(h.derivations(), 'ONE derivation across both paths').toBe(1)
  expect(
    h.log.filter(l => l.startsWith('prompt')),
    'the session never prompted'
  ).toEqual([])
})

test('a pending v0 flight that settles WITHOUT an offer leaves acquire not-ready and retryable', async () => {
  let flight: Promise<string> | null = Promise.reject(new Error('cancelled'))
  flight.catch(() => undefined) // pre-settled rejection; the join absorbs it
  const h = harness({ pendingV0: () => flight })
  expect((await h.session.acquire({ validationCipherKnown: true })).reason).toBe(
    'v0 acquisition settled without v1 keys'
  )
  // the flight is gone; the next acquire proceeds to its own prompt
  flight = null
  h.storage.set('v0', 'v0:phrase')
  expect((await h.session.acquire()).kind).toBe('ready')
})

test('EXTERNAL handle (fixed-owner): profile before prompt, session-slot derivation, fenced adoption', async () => {
  const h = harness()
  const handle = h.session.external()
  expect(handle.uid).toBe('uid-1')
  const profile = await handle.profile()
  expect(profile).toEqual({ v: 1, salt: SALT_B64 })
  const derived = await handle.derive('phrase', profile!)
  expect(h.derivations()).toBe(1)
  expect(handle.adopt(SALT_B64, derived)).toBe(true)
  expect(h.log).toEqual(['persistEnvelope'])
  expect(h.session.current()?.salt, 'adopted as THE session').toBe(SALT_B64)
  // and an acquire after adoption is a cache hit
  expect((await h.session.acquire()).kind).toBe('ready')
  expect(h.derivations()).toBe(1)
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
  // and the fence held: a clear()-style generation bump means stale in-flight work refuses
  expect((await h.session.acquire()).kind, 'a fresh acquire still works from the kept envelope').toBe('ready')
})

test('disabled and ineligible are not-ready without any effect', async () => {
  const off = harness({ enabled: () => false })
  expect((await off.session.acquire()).reason).toBe('kdf disabled')
  const foreign = harness({ eligible: () => false })
  expect((await foreign.session.acquire()).reason).toBe('ineligible page mode')
  expect(off.log).toEqual([])
  expect(foreign.log).toEqual([])
})
