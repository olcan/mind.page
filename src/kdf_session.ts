// The SESSION KEY ORCHESTRATOR (see the KDF migration design in the vault repo,
// notes/design/mind_page_kdf_migration.md, and review 85): ONE component-owned state machine for
// everything between "signed-in principal confirmed" and "keys usable", replacing the two
// divergent acquisition paths (the bundle single-flight and the fixed-owner pipeline) whose drift
// produced review 85's findings.
//
// Everything effectful is injected, so the ORCHESTRATION — profile-first, envelope-vs-profile,
// the one-time upgrade prompt, one derivation per entered phrase, generation fencing at every
// effect boundary, and the retryable-vs-declined distinction — is unit-tested in milliseconds.
//
// The rules it owns:
// - the ONE try/catch covers ONLY the server read: metadata decoding and provisioning run outside
//   it, so present-invalid metadata or a failed provisioning transaction FAILS rather than being
//   mistaken for offline operation (review 85 §2.4);
// - a "not ready" outcome (flag off, ineligible, no way to prompt, declined) is NEVER cached as
//   the session: the next call re-evaluates. Only a real key bundle is retained. A deliberate
//   DECLINE sets a no-nag marker that suppresses further PROMPTS, not further envelope/profile
//   checks (§2.2);
// - ONE entered phrase produces BOTH regimes, in EITHER direction (§2.2): the session's own
//   prompt publishes the v0 secret through deps before resolving, and a phrase collected by the
//   component's v0 prompt reaches this session through `offerPhrase` — registered synchronously,
//   so a concurrent `acquire` that joined the pending v0 flight finds the offer instead of
//   raising a second prompt;
// - the profile document reference is captured ONCE per acquisition (deps.profileStore is
//   constructed per call with the uid it serves), so a principal change between a transaction's
//   read and write cannot retarget it (§2.5);
// - the FIXED-OWNER resolver (src/secret.ts) — whose prompt is corpus-validated with its own
//   retry/sign-out flows — acquires through an `external()` handle rather than a private
//   pipeline: profile and derivation run through this session's bound store and single worker
//   slot, and adoption is generation-fenced (§2.3); and
// - `clear()` advances the generation, forgets all state including the decline marker, disposes
//   any in-flight worker, and clears persisted state through deps — the ONE key-lifecycle
//   primitive for sign-out, sign-in start, confirmed-null and mismatch; `invalidate()` is the
//   fence-only variant for the external-auth-transition reload, where the persisted stores are
//   governed by the flow that changed the auth state.

import { deriveKeyBytes } from './kdf.js'
import {
  decodeKdfMetadata,
  decodeKeyEnvelope,
  decodeSalt,
  encodeKeyEnvelope,
  provisionKdfProfile,
  restoreKeyEnvelope,
  type KdfProfile,
} from './kdf_profile.js'

export type KdfSessionKeys = { uid: string; salt: string; key: CryptoKey }

export type KdfAcquireOutcome =
  // `reason?: undefined` keeps `.reason` a legal (undefined) read on the ready arm, so callers
  // and tests can inspect it without narrowing first
  | { kind: 'ready'; keys: KdfSessionKeys; reason?: undefined }
  // not an error and not cached: the reader flag is off, the device has no way to validate a
  // prompt, the prompt was declined, or we are offline with no envelope. the next call
  // re-evaluates from scratch
  | { kind: 'not-ready'; reason: string; keys?: undefined }

// the derived v1 half handed across the external (fixed-owner) seam: the key for decryption plus
// the raw bytes for the phrase-free envelope
export type DerivedKey = { key: CryptoKey; keyBytes: Uint8Array }

export type KdfSessionDeps = {
  // the confirmed principal for THIS acquisition. the caller confirms it against firebase auth
  // before calling; the session re-reads it only to fence generations
  uid: () => string | undefined
  // the reader/provisioning owner flag
  enabled: () => boolean
  // page-mode eligibility (never anonymous/readonly/foreign-shared)
  eligible: () => boolean
  // persisted state
  storedV0: () => string | null
  storedEnvelope: () => string | null
  persistEnvelope: (encoded: string) => undefined
  clearPersisted: () => undefined // both v0 and v1 persisted state
  // the component's IN-FLIGHT v0 acquisition, if one is pending (the `secret` slot while its
  // prompt is up); null otherwise. `acquire` joins it before prompting — its prompt tail offers
  // the phrase here, so one prompt serves both regimes
  pendingV0: () => Promise<unknown> | null
  // ONE profile store per acquisition, bound to the uid at construction: a server read plus the
  // provisioning transaction (whose candidate salt/merge-set rules live in kdf_profile.ts)
  profileStore: (uid: string) => {
    // server-authoritative read of the users/{uid} data; REJECTS on network failure
    read: () => Promise<Record<string, unknown> | undefined>
    // the real runTransaction adapter (see provisionKdfProfile's deps)
    runTransaction: Parameters<typeof provisionKdfProfile>[0]['runTransaction']
  }
  randomSalt: () => Uint8Array
  // the upgrade prompt (device HAS a stored v0 secret): resolves the phrase or null on decline
  promptUpgrade: () => Promise<string | null>
  // the first-phrase prompt (no stored v0 secret; a v1-only corpus on a new device): resolves the
  // phrase or null on decline
  promptPhrase: () => Promise<string | null>
  // the v0 stored form of a phrase (uid-bound hash)
  hashPhrase: (phrase: string) => Promise<string>
  // publishes the v0 secret (in-memory `secret` and its persisted form) — the ONE-PHRASE-BOTH-
  // REGIMES rule: called before the acquisition resolves, so neither consumer wins a race
  publishV0: (v0secret: string) => undefined
  // validates a derived candidate key when there is NO stored v0 secret to compare against:
  // typically "does it open the v1 cipher that triggered this acquisition". null cipher means no
  // evidence is available and the phrase cannot be validated — not-ready
  validateV1: (key: CryptoKey) => Promise<boolean>
  // one worker per derivation, disposed by the session in finally and on clear()
  createWorker: () => { derive: Parameters<typeof deriveKeyBytes>[3]; dispose: (reason?: string) => undefined }
  importKey: (keyBytes: Uint8Array) => Promise<CryptoKey>
  onWarn: (message: string) => undefined
}

export function createKdfSession(deps: KdfSessionDeps) {
  let generation = 0
  let session: KdfSessionKeys | null = null
  let inflight: Promise<KdfAcquireOutcome> | null = null
  let pendingOffer: Promise<KdfAcquireOutcome> | null = null
  let declined = false
  let activeWorker: { dispose: (reason?: string) => undefined } | null = null

  const notReady = (reason: string): KdfAcquireOutcome => ({ kind: 'not-ready', reason })

  // the ONE profile resolution: try covers ONLY the server read (review 85 §2.4); decode and
  // provisioning failures propagate out of the caller's whole attempt
  const resolveProfile = async (store: ReturnType<KdfSessionDeps['profileStore']>) => {
    let profileData: Record<string, unknown> | undefined
    try {
      profileData = await store.read()
    } catch {
      return { offline: true as const }
    }
    const state = decodeKdfMetadata(profileData?.kdf) // present-invalid THROWS out of the attempt
    const profile: KdfProfile =
      state.kind == 'valid'
        ? state.profile
        : await provisionKdfProfile({ randomSalt: deps.randomSalt, runTransaction: store.runTransaction })
    return { offline: false as const, profile }
  }

  // the ONE derivation seam: a per-call worker held in the SINGLE activeWorker slot (disposed in
  // finally and by clear(), so no second unfenced worker can outlive the session — §2.3)
  const deriveKey = async (phrase: string, profile: KdfProfile): Promise<DerivedKey> => {
    const worker = deps.createWorker()
    activeWorker = worker
    let keyBytes: Uint8Array
    try {
      keyBytes = await deriveKeyBytes(phrase, decodeSalt(profile.salt), profile.v, worker.derive)
    } finally {
      worker.dispose()
      if (activeWorker === worker) activeWorker = null
    }
    return { key: await deps.importKey(keyBytes), keyBytes }
  }

  const acquireOnce = async (myGeneration: number, validationCipherKnown: boolean): Promise<KdfAcquireOutcome> => {
    const stale = () => myGeneration != generation
    const uid = deps.uid()
    if (!uid) return notReady('no confirmed principal')
    const store = deps.profileStore(uid) // BOUND to this uid for the whole acquisition

    // 1. PROFILE FIRST (the salt is public; no phrase crosses any network retry)
    const resolved = await resolveProfile(store)
    if (stale()) return notReady('superseded')
    if (resolved.offline) {
      // OFFLINE: envelope-only reuse (previously committed for this uid; its own validation —
      // uid, version, canonical encodings — is the whole check, since the salt it names WAS
      // server-confirmed when persisted); no salt invented
      const decoded = decodeKeyEnvelope(deps.storedEnvelope(), uid)
      if (!decoded) return notReady('offline without a committed envelope')
      const key = await deps.importKey(decoded.keyBytes)
      if (stale()) return notReady('superseded')
      return { kind: 'ready', keys: (session = { uid, salt: decoded.salt, key }) }
    }
    const profile = resolved.profile

    // 2. the ENVELOPE, against the confirmed profile
    const restored = restoreKeyEnvelope(deps.storedEnvelope(), uid, profile)
    if (restored) {
      const key = await deps.importKey(restored)
      if (stale()) return notReady('superseded')
      return { kind: 'ready', keys: (session = { uid, salt: profile.salt, key }) }
    }

    // 3. a PENDING component v0 acquisition is joined before any prompt (review 85 §2.2): its
    //    prompt tail registers an offer (offerPhrase) BEFORE the flight settles, so one phrase
    //    serves both regimes and two prompts never race. its rejection is its own business (the
    //    v0 path reports it); here it just ends the join
    const pendingV0 = deps.pendingV0()
    if (pendingV0) {
      await pendingV0.then(
        () => undefined,
        () => undefined
      )
      if (stale()) return notReady('superseded')
      if (session) return { kind: 'ready', keys: session } // adopted or offered meanwhile
      if (pendingOffer) return pendingOffer
      return notReady('v0 acquisition settled without v1 keys')
    }

    // 4. the ONE-TIME prompt — unless this session already declined (no-nag; clear() forgets it)
    if (declined) return notReady('upgrade declined this session')
    const storedV0 = deps.storedV0()
    // a FIRST phrase (no stored v0 secret) can only be validated against v1 evidence the caller
    // holds; without any, prompting would collect a phrase nothing can check — refuse BEFORE the
    // prompt and before any derivation
    if (!storedV0 && !validationCipherKnown) return notReady('no evidence to validate a first phrase')
    const phrase = storedV0 ? await deps.promptUpgrade() : await deps.promptPhrase()
    if (stale()) return notReady('superseded')
    if (phrase == null) {
      declined = true
      return notReady('declined')
    }
    const v0secret = await deps.hashPhrase(phrase)
    if (stale()) return notReady('superseded')
    if (storedV0 && v0secret != storedV0) {
      deps.onWarn('phrase does not match this device’s stored secret; upgrade skipped')
      return notReady('wrong phrase')
    }

    // 5. derive ONCE for this phrase
    const derived = await deriveKey(phrase, profile)
    if (stale()) return notReady('superseded')

    // 6. with NO stored v0 secret, the phrase is validated by the v1 evidence that triggered this
    //    acquisition (its presence was checked before the prompt)
    if (!storedV0) {
      if (!(await deps.validateV1(derived.key))) {
        if (stale()) return notReady('superseded')
        deps.onWarn('phrase did not open the encrypted data; upgrade skipped')
        return notReady('wrong phrase')
      }
      if (stale()) return notReady('superseded')
    }

    // 7. ONE PHRASE, BOTH REGIMES: publish v0 (in-memory + persisted) BEFORE resolving, so a v0
    //    consumer racing this acquisition finds the secret rather than raising a second prompt
    deps.publishV0(v0secret)
    // 8. persist the phrase-free envelope LAST, on this still-current success
    deps.persistEnvelope(encodeKeyEnvelope({ uid, salt: profile.salt, keyBytes: derived.keyBytes }))
    return { kind: 'ready', keys: (session = { uid, salt: profile.salt, key: derived.key }) }
  }

  // the OFFERED-PHRASE path: the component's v0 prompt already collected and validated the phrase
  // (its hash matches what it just published), so this derives the v1 half with NO prompt and NO
  // v0 publication of its own. offline is a deferral, not a failure — the v0 regime proceeds
  const offerOnce = async (myGeneration: number, phrase: string): Promise<KdfAcquireOutcome> => {
    const stale = () => myGeneration != generation
    const uid = deps.uid()
    if (!uid) return notReady('no confirmed principal')
    const store = deps.profileStore(uid)
    const resolved = await resolveProfile(store)
    if (stale()) return notReady('superseded')
    if (resolved.offline) return notReady('offline; v1 upgrade deferred')
    const profile = resolved.profile
    // an envelope may already match (another tab completed the upgrade): then nothing derives
    const restored = restoreKeyEnvelope(deps.storedEnvelope(), uid, profile)
    if (restored) {
      const key = await deps.importKey(restored)
      if (stale()) return notReady('superseded')
      return { kind: 'ready', keys: (session = { uid, salt: profile.salt, key }) }
    }
    const derived = await deriveKey(phrase, profile)
    if (stale()) return notReady('superseded')
    deps.persistEnvelope(encodeKeyEnvelope({ uid, salt: profile.salt, keyBytes: derived.keyBytes }))
    return { kind: 'ready', keys: (session = { uid, salt: profile.salt, key: derived.key }) }
  }

  return {
    /**
     * Acquires (or returns) the session keys. Single-flight; a `not-ready` outcome is NEVER
     * retained — the slot clears on every settle, and only a real bundle is cached — so a later
     * call retries what a race made impossible earlier (review 85 §2.2).
     * `validationCipherKnown` says the caller holds a v1 cipher `deps.validateV1` can test a
     * first-phrase candidate against (the decrypt path that triggered the acquisition).
     */
    acquire(options: { validationCipherKnown?: boolean } = {}): Promise<KdfAcquireOutcome> {
      if (!deps.enabled()) return Promise.resolve(notReady('kdf disabled'))
      if (!deps.eligible()) return Promise.resolve(notReady('ineligible page mode'))
      if (session) return Promise.resolve({ kind: 'ready', keys: session })
      if (pendingOffer) return pendingOffer // a phrase is already being sealed; join it
      if (inflight) return inflight
      const myGeneration = generation
      const attempt = acquireOnce(myGeneration, !!options.validationCipherKnown).finally(() => {
        if (inflight === attempt) inflight = null // ALWAYS: not-ready must stay retryable
      })
      inflight = attempt
      return attempt
    },
    /**
     * Derives and seals the v1 half from a phrase the component's v0 flow JUST collected,
     * validated and published (one-phrase-both-regimes in the other direction: the v0 prompt was
     * THE prompt). Registered synchronously — a concurrent `acquire` parked on the pending v0
     * flight returns this offer's outcome instead of prompting again. Never prompts; never
     * publishes v0.
     */
    offerPhrase(phrase: string): Promise<KdfAcquireOutcome> {
      if (!deps.enabled()) return Promise.resolve(notReady('kdf disabled'))
      if (!deps.eligible()) return Promise.resolve(notReady('ineligible page mode'))
      if (session) return Promise.resolve({ kind: 'ready', keys: session })
      if (pendingOffer) return pendingOffer
      const myGeneration = generation
      const offer = offerOnce(myGeneration, phrase).finally(() => {
        if (pendingOffer === offer) pendingOffer = null
      })
      pendingOffer = offer
      return offer
    },
    /**
     * The EXTERNAL acquisition handle for the fixed-owner resolver (src/secret.ts), whose prompt
     * is corpus-validated with retry/sign-out flows this session does not own. The handle binds
     * the current generation, principal and profile store at creation; `profile` runs BEFORE the
     * resolver's prompt (profile-first), `derive` uses the session's single worker slot, and
     * `adopt` publishes externally derived keys — envelope persisted, bundle cached — only if no
     * clear() intervened (returns whether it did).
     */
    external() {
      const myGeneration = generation
      const boundUid = deps.uid()
      const store = boundUid ? deps.profileStore(boundUid) : null
      const stale = () => myGeneration != generation
      return {
        uid: boundUid,
        stale,
        // null when the kdf flag is off, the page mode is ineligible, or there is no principal —
        // the resolver then runs pure v0. read/decode/provision failures PROPAGATE (fail closed:
        // the resolver validates against server-confirmed state only, and its own account fetch
        // has already proven the server reachable)
        profile: async (): Promise<KdfProfile | null> => {
          if (!deps.enabled() || !deps.eligible() || !store) return null
          const resolved = await resolveProfile(store)
          if (stale()) throw new Error('kdf acquisition superseded')
          if (resolved.offline) throw new Error('could not read the account kdf profile')
          return resolved.profile
        },
        derive: async (phrase: string, profile: KdfProfile): Promise<DerivedKey> => {
          const derived = await deriveKey(phrase, profile)
          if (stale()) throw new Error('kdf acquisition superseded')
          return derived
        },
        adopt: (salt: string, derived: DerivedKey): boolean => {
          if (stale() || !boundUid) return false
          deps.persistEnvelope(encodeKeyEnvelope({ uid: boundUid, salt, keyBytes: derived.keyBytes }))
          session = { uid: boundUid, salt, key: derived.key }
          return true
        },
      }
    },
    /** The current keys, if this session holds them (readiness observable for the checklist). */
    current: () => session,
    /** The in-flight acquisition or offer, if any — the component's v0 path joins it before
     * prompting, mirroring the session's own join of the pending v0 flight. */
    pending: () => pendingOffer ?? inflight,
    /** The clear() counter: v0 publish sites captured before an await fence on it (§2.5 — a
     * pending prompt must not repopulate key state after sign-out). */
    generation: () => generation,
    /**
     * Fences WITHOUT touching persisted state: generation++, all in-memory state forgotten
     * (decline marker included), the in-flight worker disposed. For the external-auth-transition
     * reload, where in-memory state must not publish past the fence but the persisted stores are
     * governed by the tab that changed the auth state (a same-account sign-in elsewhere must not
     * cost this device its keys).
     */
    invalidate(reason = 'invalidated'): undefined {
      generation++
      session = null
      inflight = null
      pendingOffer = null
      declined = false
      activeWorker?.dispose(reason)
      activeWorker = null
      return undefined
    },
    /**
     * THE key-lifecycle primitive: invalidate() plus persisted state cleared through deps.
     * Sign-out, sign-in start, sign-in failure and principal mismatch call this.
     */
    clear(reason = 'cleared'): undefined {
      this.invalidate(reason)
      deps.clearPersisted()
      return undefined
    },
  }
}
export type KdfSession = ReturnType<typeof createKdfSession>
export type KdfExternalAcquisition = ReturnType<KdfSession['external']>
