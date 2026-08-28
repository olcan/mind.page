// The SESSION KEY ORCHESTRATOR (see the KDF migration design in the vault repo,
// notes/design/mind_page_kdf_migration.md, and reviews 85-87): ONE component-owned state machine
// for everything between "signed-in principal confirmed" and "keys usable".
//
// Everything effectful is injected, so the ORCHESTRATION — profile-first, envelope-vs-profile,
// the one prompt, corpus establishment, generation fencing at every effect boundary, and the
// retryable-vs-declined distinction — is unit-tested in milliseconds.
//
// The rules it owns:
// - the SESSION OWNS THE PROMPT AND BOTH PUBLICATIONS when the kdf flag is on (review 87 §2.1/
//   §2.3): the component's v0 path calls acquire() instead of publishing a phrase first and
//   offering it after. There is no offer pipeline. READY means COMPLETE — the v0 secret and the
//   v1 key both established from one phrase; a v1 envelope alone is never a complete session;
// - TRUST COMES FROM ESTABLISHMENT, not from mutable storage: a stored v0 hash is honored only
//   if it predates this generation (the BASELINE, anchored before any prompt could have written
//   it) — anything newer validates against corpus evidence like any other candidate. A newly
//   CHOSEN phrase may seal without evidence only on an authoritative, generation-current
//   "account has no ciphertext" fact from deps, never on caller intent (§2.2);
// - ONE per-generation PROFILE flight, shared by proactive acquisition and the fixed-owner
//   external handle; its try/catch covers ONLY the server read, so present-invalid metadata or a
//   failed provisioning transaction FAILS rather than being mistaken for offline (review 85
//   §2.4). Transient outcomes never wedge the generation, and a clear() between the read and
//   provisioning stops before the transaction (review 87 §2.5);
// - EVERY consumer of an online-confirmed profile runs the envelope comparison: a valid same-uid
//   envelope naming a different salt is removed on the spot (§2.4), so a decline or an
//   interrupted fixed-owner flow followed by an offline load cannot resurrect an obsolete key;
// - EVIDENCE is generation-bound, promotable, and RETAINED IN FULL until establishment (§3.1):
//   the component notes every classified cipher, and the flight consults the current collection
//   at its decision points. establishCandidate (src/secret.ts) requires an exact v0
//   authentication whenever v0 evidence exists and iterates v1 evidence past corrupt rows;
//   derivation is LAZY — a candidate refused by v0 evidence or by no-evidence never pays Argon
//   (§3.2), and at most one derivation runs per flight;
// - a "not ready" outcome is NEVER cached. Declining the OPTIONAL upgrade prompt (a device with
//   a trusted stored v0 secret) is a session no-nag marker; cancelling a REQUIRED prompt (first
//   phrase or new phrase) is reported as 'cancelled' for the component's legacy sign-out
//   contract; and
// - `clear()` advances the generation, forgets all state, disposes the in-flight worker, and
//   clears persisted state through deps — for sign-out, sign-in start, confirmed-null and
//   mismatch; `invalidate()` is the fence-only variant for the external-auth-transition reload.

import { deriveKeyBytes } from './kdf.js'
import { establishCandidate, type CandidateEvidence } from './secret.js'
import {
  decodeKdfMetadata,
  decodeKeyEnvelope,
  decodeSalt,
  encodeKeyEnvelope,
  provisionKdfProfile,
  type KdfProfile,
} from './kdf_profile.js'

export type KdfSessionKeys = { uid: string; salt: string; key: CryptoKey }

export type KdfAcquireOutcome =
  | { kind: 'ready'; keys: KdfSessionKeys }
  // not an error and not cached: the reader flag is off, no evidence can validate a prompt, a
  // required prompt was cancelled, or we are offline without complete persisted keys. the next
  // call re-evaluates
  | { kind: 'not-ready'; reason: string }

// the per-generation profile flight's resolution: the server-confirmed profile, or null for
// OFFLINE (the authoritative read failed — transient, never cached). null rather than a tagged
// union because the app tsconfig is non-strict, where discriminant narrowing of the tag fails
type ProfileResolution = KdfProfile | null

// one classified cipher the component's decrypt paths saw — the corpus evidence a candidate
// phrase is validated against
export type EvidenceCipher = { kind: 'text'; cipher: string } | { kind: 'bytes'; cipher: Uint8Array }

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
  // removes ONLY the persisted envelope — for a valid envelope whose salt an online profile read
  // confirmed obsolete (the v0 secret stays useful and stays put)
  clearEnvelope: () => undefined
  clearPersisted: () => undefined // both v0 and v1 persisted state
  // the component's IN-FLIGHT LEGACY v0 acquisition (fixed-owner resolve, or the offline
  // fallback prompt), if one is pending; null otherwise — and NEVER the session-driven
  // acquisition itself (the component excludes it, or the join would deadlock on its own
  // flight). `acquire` joins it before prompting, since its settlement may adopt a session or
  // publish a v0 secret
  pendingV0: () => Promise<unknown> | null
  // AUTHORITATIVE EMPTINESS (review 87 §2.2): true only when initialization has completed from a
  // server-confirmed snapshot for this principal and no classified ciphertext was encountered —
  // the one state where a newly CHOSEN phrase is definitionally correct. NEVER caller intent
  corpusConfirmedEmpty: () => boolean
  // ONE profile store per profile flight, bound to the uid at construction: a principal change
  // between a transaction's read and write cannot retarget it (review 85 §2.5)
  profileStore: (uid: string) => {
    // server-authoritative read of the users/{uid} data; REJECTS on network failure
    read: () => Promise<Record<string, unknown> | undefined>
    // the real runTransaction adapter (see provisionKdfProfile's deps)
    runTransaction: Parameters<typeof provisionKdfProfile>[0]['runTransaction']
  }
  randomSalt: () => Uint8Array
  // the OPTIONAL upgrade prompt (device has a TRUSTED stored v0 secret): phrase, or null on
  // decline (session no-nag)
  promptUpgrade: () => Promise<string | null>
  // the REQUIRED existing-phrase prompt (no trusted stored v0; corpus evidence exists): phrase,
  // or null on cancel — reported as 'cancelled' for the component's sign-out contract
  promptPhrase: () => Promise<string | null>
  // the REQUIRED new-phrase flow (authoritatively empty account): the component's choose+confirm
  // loop; phrase, or null on cancel
  promptNewPhrase: () => Promise<string | null>
  // the v0 stored form of a phrase (uid-bound hash)
  hashPhrase: (phrase: string) => Promise<string>
  // publishes the v0 secret (in-memory `secret` and its persisted form) — called ONLY on
  // establishment, before the acquisition resolves (one phrase, both regimes)
  publishV0: (v0secret: string) => undefined
  // one authentication attempt of a candidate against one evidence row: true on success, false
  // on a REAL authentication failure, anything else propagates (never becomes "wrong phrase")
  attemptV0: (row: EvidenceCipher, v0secret: string) => Promise<boolean>
  attemptV1: (row: EvidenceCipher, key: CryptoKey) => Promise<boolean>
  // one worker per derivation, disposed by the session in finally and on clear()
  createWorker: () => { derive: Parameters<typeof deriveKeyBytes>[3]; dispose: (reason?: string) => undefined }
  importKey: (keyBytes: Uint8Array) => Promise<CryptoKey>
  onWarn: (message: string) => undefined
}

export function createKdfSession(deps: KdfSessionDeps) {
  let generation = 0
  let session: KdfSessionKeys | null = null
  let inflight: Promise<KdfAcquireOutcome> | null = null
  let declined = false
  let activeWorker: { dispose: (reason?: string) => undefined } | null = null
  // classified corpus evidence for the current generation (see noteEvidence); retained in FULL
  // until establishment (review 87 §3.1 — a bounded sample froze corrupt rows in), released on
  // establishment and on forget()
  let evidence: CandidateEvidence<EvidenceCipher>[] = []
  // the TRUST BASELINE (review 87 §2.1): the stored v0 hash as anchored before any prompt of
  // this generation could have written storage, advanced only by the session's own established
  // publications. a stored hash that differs from the baseline is a mid-generation write by an
  // UNESTABLISHED flow and is never honored by the exact-hash comparison; it validates against
  // corpus evidence like any other candidate
  let baselineV0: { value: string | null } | null = null
  // the ONE per-generation profile flight (kept across not-ready outcomes so a stronger caller
  // never pays a second read; transient outcomes clear it so nothing wedges)
  let profileFlight: { generation: number; uid: string; promise: Promise<ProfileResolution> } | null = null

  const notReady = (reason: string): KdfAcquireOutcome => ({ kind: 'not-ready', reason })

  // lazy first-touch anchor (never at construction: deps read origin storage, and the component
  // constructs the session during SSR-safe setup). every flight and every noteEvidence touches
  // it before any prompt of the generation can run
  const baseline = () => (baselineV0 ??= { value: deps.storedV0() }).value

  // forget all in-memory state and advance the generation (shared by clear/invalidate; a plain
  // closure so neither method depends on `this`)
  const forget = (reason: string) => {
    generation++
    session = null
    inflight = null
    declined = false
    evidence = []
    baselineV0 = null
    profileFlight = null
    activeWorker?.dispose(reason)
    activeWorker = null
  }

  // the ONE profile resolution: try covers ONLY the server read (review 85 §2.4); decode and
  // provisioning failures propagate out of the caller's whole attempt, and a clear() that landed
  // during the read stops BEFORE the provisioning transaction (review 87 §2.5)
  const resolveProfile = async (
    store: ReturnType<KdfSessionDeps['profileStore']>,
    cancelled: () => boolean
  ): Promise<ProfileResolution> => {
    let profileData: Record<string, unknown> | undefined
    try {
      profileData = await store.read()
    } catch {
      return null // offline
    }
    if (cancelled()) throw new Error('kdf acquisition superseded')
    const state = decodeKdfMetadata(profileData?.kdf) // present-invalid THROWS out of the attempt
    return state.kind == 'valid'
      ? state.profile
      : await provisionKdfProfile({ randomSalt: deps.randomSalt, runTransaction: store.runTransaction })
  }

  const getProfile = (uid: string) => {
    if (profileFlight && profileFlight.generation == generation && profileFlight.uid == uid) return profileFlight.promise
    const myGeneration = generation
    const flight = {
      generation: myGeneration,
      uid,
      // store BOUND to this uid for the flight; the cancellation fence is the flight's own
      // generation, so a clear() during the read stops before provisioning
      promise: resolveProfile(deps.profileStore(uid), () => myGeneration != generation),
    }
    // an offline result or a rejection is transient: clear the flight so the next attempt
    // re-reads instead of replaying it for the rest of the generation
    flight.promise.then(
      profile => {
        if (!profile && profileFlight === flight) profileFlight = null
      },
      () => {
        if (profileFlight === flight) profileFlight = null
      }
    )
    profileFlight = flight
    return flight.promise
  }

  // EVERY consumer of an online-confirmed profile runs this comparison (review 87 §2.4): returns
  // the envelope's key bytes when it matches the profile exactly, and REMOVES a valid same-uid
  // envelope whose salt the profile contradicts — confirmed obsolete, it must not survive to be
  // resurrected by a later offline load
  const confirmEnvelope = (uid: string, profile: KdfProfile): Uint8Array | null => {
    const decoded = decodeKeyEnvelope(deps.storedEnvelope(), uid)
    if (!decoded) return null
    if (decoded.salt === profile.salt) return decoded.keyBytes
    deps.clearEnvelope()
    return null
  }

  // the ONE derivation seam: a per-call worker held in the SINGLE activeWorker slot (disposed in
  // finally and by clear()). candidates are serialized by the single flight and the component's
  // v0 single-flight, so a concurrent derivation is an INVARIANT VIOLATION and is refused rather
  // than silently racing two workers (review 87 §3.3)
  const deriveKey = async (phrase: string, profile: KdfProfile): Promise<DerivedKey> => {
    if (activeWorker) throw new Error('concurrent kdf derivation (invariant violation)')
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

  const acquireOnce = async (myGeneration: number): Promise<KdfAcquireOutcome> => {
    const stale = () => myGeneration != generation
    void baseline() // anchor the trust baseline before anything of this flight can prompt
    const uid = deps.uid()
    if (!uid) return notReady('no confirmed principal')

    // 1. PROFILE FIRST (the salt is public; no phrase crosses any network retry)
    const profile = await getProfile(uid)
    if (stale()) return notReady('superseded')
    if (!profile) {
      // OFFLINE: reuse is COMPLETE-STATE ONLY (review 87 §2.1) — the previously committed
      // envelope AND the stored v0 secret together. a lone envelope is not a session: reporting
      // it ready would let the next save collect an unrelated phrase for the missing v0 half
      const decoded = decodeKeyEnvelope(deps.storedEnvelope(), uid)
      if (!decoded || !deps.storedV0()) return notReady('offline without complete persisted keys')
      const key = await deps.importKey(decoded.keyBytes)
      if (stale()) return notReady('superseded')
      return { kind: 'ready', keys: (session = { uid, salt: decoded.salt, key }) }
    }

    // 2. the ENVELOPE, against the confirmed profile (mismatches are removed — §2.4). COMPLETE
    //    state restores silently; an envelope without the v0 half falls through to establishment
    const confirmed = confirmEnvelope(uid, profile)
    if (confirmed && deps.storedV0()) {
      const key = await deps.importKey(confirmed)
      if (stale()) return notReady('superseded')
      return { kind: 'ready', keys: (session = { uid, salt: profile.salt, key }) }
    }

    // 3. a PENDING component LEGACY v0 acquisition is joined before any prompt: a fixed-owner
    //    resolve may adopt a session, and any settlement may publish a v0 secret this flight can
    //    then complete against. a REJECTED flight means the user cancelled that prompt — do not
    //    raise another one behind it
    const pendingV0 = deps.pendingV0()
    if (pendingV0) {
      let rejected = false
      await pendingV0.then(
        () => undefined,
        () => void (rejected = true)
      )
      if (stale()) return notReady('superseded')
      if (session) return { kind: 'ready', keys: session } // established meanwhile (e.g. fixed adoption)
      if (rejected) return notReady('v0 acquisition cancelled or failed')
    }

    // 4. the ONE PROMPT, selected by state. the stored hash is TRUSTED only at the baseline
    //    (§2.1): a value written mid-generation by an unestablished flow validates against
    //    corpus evidence instead
    const storedV0 = deps.storedV0()
    const trustedV0 = storedV0 && storedV0 === baseline() ? storedV0 : null
    let phrase: string | null
    let required: boolean
    let freshSeal = false
    if (trustedV0) {
      if (declined) return notReady('upgrade declined this session')
      phrase = await deps.promptUpgrade()
      required = false
    } else if (evidence.length || storedV0) {
      // corpus evidence exists (or an UNTRUSTED stored hash suggests ciphertext somewhere):
      // the phrase is validated by establishment below
      phrase = await deps.promptPhrase()
      required = true
    } else if (deps.corpusConfirmedEmpty()) {
      // the ONE state where a newly chosen phrase is definitionally correct: the account is
      // authoritatively empty (§2.2). evidence arriving before establishment still validates
      phrase = await deps.promptNewPhrase()
      required = true
      freshSeal = true
    } else {
      return notReady('no evidence to validate a first phrase')
    }
    if (stale()) return notReady('superseded')
    if (phrase == null) {
      if (required) return notReady('cancelled')
      declined = true
      return notReady('declined')
    }
    const candidate = phrase

    // 5. the candidate's v0 hash; the trusted-hash comparison is the cheap pre-derivation refusal
    const v0secret = await deps.hashPhrase(candidate)
    if (stale()) return notReady('superseded')
    if (trustedV0 && v0secret != trustedV0) {
      deps.onWarn('phrase does not match this device’s stored secret; upgrade skipped')
      return notReady('wrong phrase')
    }

    // 6. ESTABLISHMENT with LAZY derivation (§3.2): v0 attempts and the no-evidence refusal pay
    //    no Argon; the first v1 attempt (or the final seal) derives exactly once
    let derivedMemo: Promise<DerivedKey> | null = null
    const deriveOnce = () => (derivedMemo ??= deriveKey(candidate, profile))
    if (!trustedV0) {
      const rows = evidence // consulted LIVE: rows noted after the flight began still count
      if (rows.length) {
        const verdict = await establishCandidate(rows, {
          tryV0: row => deps.attemptV0(row, v0secret),
          tryV1: async row => deps.attemptV1(row, (await deriveOnce()).key),
        })
        if (stale()) return notReady('superseded')
        if (verdict.kind != 'established') {
          deps.onWarn('phrase did not open the encrypted data; upgrade skipped')
          return notReady('wrong phrase')
        }
      } else if (!freshSeal) {
        // no evidence and not an authoritatively-fresh phrase: nothing can establish it
        return notReady('no evidence to validate a first phrase')
      }
    }

    // 7. derive (memoized — at most once per flight) and seal LAST, on this still-current
    //    established success. the session owns BOTH publications: v0 before resolving (one
    //    phrase, both regimes), the phrase-free envelope after
    const derived = await deriveOnce()
    if (stale()) return notReady('superseded')
    deps.publishV0(v0secret)
    baselineV0 = { value: v0secret } // the session's own established publication is trusted
    deps.persistEnvelope(encodeKeyEnvelope({ uid, salt: profile.salt, keyBytes: derived.keyBytes }))
    evidence = []
    return { kind: 'ready', keys: (session = { uid, salt: profile.salt, key: derived.key }) }
  }

  return {
    /**
     * Notes one classified cipher as corpus evidence for candidate validation. Called by the
     * component's decrypt paths as ciphers stream through them; deduplicated, inert when
     * disabled/ineligible/established, retained until establishment or forget. Evidence is
     * generation-scoped and consulted LIVE by the acquisition flight (promotable — review 86
     * §2.1).
     */
    noteEvidence(regime: 'v0' | 'v1', row: EvidenceCipher): undefined {
      if (!deps.enabled() || !deps.eligible() || session) return undefined
      void baseline() // evidence implies ciphertext existed before any prompt of this generation
      const duplicate = evidence.some(
        e =>
          e.kind == regime &&
          (row.kind == 'text'
            ? e.cipher.kind == 'text' && e.cipher.cipher == row.cipher
            : e.cipher.kind == 'bytes' && e.cipher.cipher === row.cipher)
      )
      if (!duplicate) evidence.push({ kind: regime, cipher: row })
      return undefined
    },
    /**
     * Acquires (or returns) the session keys — READY always means the COMPLETE one-phrase state
     * (v0 secret published and v1 key held). Single-flight; a `not-ready` outcome is NEVER
     * retained — the slot clears on every settle — so a later call retries what a race made
     * impossible earlier, and a flight in progress consults evidence that arrives after it
     * began. When the kdf flag is on, THIS is the prompt owner: the component's v0 path calls it
     * instead of prompting first and offering after (review 87 §2.1/§2.3).
     */
    acquire(): Promise<KdfAcquireOutcome> {
      if (!deps.enabled()) return Promise.resolve(notReady('kdf disabled'))
      if (!deps.eligible()) return Promise.resolve(notReady('ineligible page mode'))
      if (session) return Promise.resolve({ kind: 'ready', keys: session })
      if (inflight) return inflight
      const myGeneration = generation
      const attempt = acquireOnce(myGeneration).finally(() => {
        if (inflight === attempt) inflight = null // ALWAYS: not-ready must stay retryable
      })
      inflight = attempt
      return attempt
    },
    /**
     * The EXTERNAL acquisition handle for the fixed-owner resolver (src/secret.ts), whose prompt
     * is corpus-validated with retry/sign-out flows this session does not own. The handle binds
     * the current generation and principal at creation; `profile` reuses the session's
     * per-generation profile flight, runs BEFORE the resolver's prompt, and performs the same
     * envelope confirmation as the ordinary path (review 87 §2.4); `derive` uses the session's
     * single worker slot; `adopt` publishes externally derived keys only if no clear()
     * intervened. Both effectful calls check the fence BEFORE starting work (§2.5), so a stale
     * handle cannot begin a server read or a Worker under a new generation.
     */
    external() {
      const myGeneration = generation
      const boundUid = deps.uid()
      const stale = () => myGeneration != generation
      return {
        uid: boundUid,
        stale,
        // null when the kdf flag is off, the page mode is ineligible, or there is no principal —
        // the resolver then runs pure v0. read/decode/provision failures PROPAGATE (fail closed:
        // the resolver validates against server-confirmed state only, and its own account fetch
        // has already proven the server reachable)
        profile: async (): Promise<KdfProfile | null> => {
          if (!deps.enabled() || !deps.eligible() || !boundUid) return null
          if (stale()) throw new Error('kdf acquisition superseded')
          const profile = await getProfile(boundUid)
          if (stale()) throw new Error('kdf acquisition superseded')
          if (!profile) throw new Error('could not read the account kdf profile')
          confirmEnvelope(boundUid, profile) // §2.4: this consumer revokes mismatches too
          return profile
        },
        derive: async (phrase: string, profile: KdfProfile): Promise<DerivedKey> => {
          if (stale()) throw new Error('kdf acquisition superseded')
          const derived = await deriveKey(phrase, profile)
          if (stale()) throw new Error('kdf acquisition superseded')
          return derived
        },
        adopt: (salt: string, derived: DerivedKey): boolean => {
          if (stale() || !boundUid) return false
          deps.persistEnvelope(encodeKeyEnvelope({ uid: boundUid, salt, keyBytes: derived.keyBytes }))
          session = { uid: boundUid, salt, key: derived.key }
          evidence = []
          return true
        },
      }
    },
    /** The current keys, if this session holds them (readiness observable for the checklist). */
    current: () => session,
    /** The in-flight acquisition, if any. */
    pending: () => inflight,
    /** The clear() counter: the component's legacy publish sites fence on it (review 85 §2.5 — a
     * pending prompt must not repopulate key state after sign-out). */
    generation: () => generation,
    /**
     * Fences WITHOUT touching persisted state: generation++, all in-memory state forgotten
     * (decline marker, evidence and baseline included), the in-flight worker disposed. For the
     * external-auth-transition reload, where in-memory state must not publish past the fence but
     * the persisted stores are governed by the tab that changed the auth state (a same-account
     * sign-in elsewhere must not cost this device its keys).
     */
    invalidate(reason = 'invalidated'): undefined {
      forget(reason)
      return undefined
    },
    /**
     * THE key-lifecycle primitive: invalidate() plus persisted state cleared through deps.
     * Sign-out, sign-in start, sign-in failure and principal mismatch call this.
     */
    clear(reason = 'cleared'): undefined {
      forget(reason)
      deps.clearPersisted()
      return undefined
    },
  }
}
export type KdfSession = ReturnType<typeof createKdfSession>
export type KdfExternalAcquisition = ReturnType<KdfSession['external']>
