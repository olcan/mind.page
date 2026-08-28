// The SESSION KEY ORCHESTRATOR (see the KDF migration design in the vault repo,
// notes/design/mind_page_kdf_migration.md, and reviews 85-88): ONE component-owned state machine
// for everything between "signed-in principal confirmed" and "keys usable".
//
// Everything effectful is injected, so the ORCHESTRATION — profile-first, envelope-vs-profile,
// the prompt/establish loop, generation fencing at every effect boundary, and the
// retryable-vs-declined distinction — is unit-tested in milliseconds.
//
// The rules it owns:
// - the SESSION OWNS THE PROMPT AND BOTH PUBLICATIONS when the kdf flag is on (review 87 §2.1/
//   §2.3): the component's v0 path calls acquire() instead of publishing a phrase first. READY
//   means COMPLETE AND BOUND (review 88 §2.1): the persisted envelope carries the v0 hash the
//   SAME establishment produced, and a restore requires the current store, the envelope binding
//   and the generation BASELINE to agree — a v1 key beside an unrelated v0 hash, however stable,
//   is never a session;
// - TRUST COMES FROM ESTABLISHMENT, not from mutable storage: the baseline is anchored at the
//   session's first touch of the generation (flights, evidence notes and the external handle all
//   touch it before any prompt can run) and advances only through the session's own established
//   publications. A newly CHOSEN phrase may seal without evidence only on an authoritative,
//   generation-current "account has no ciphertext" fact from deps, never on caller intent
//   (reviews 87-88 §2.2);
// - a REQUIRED candidate that fails establishment RE-PROMPTS inside the flight (review 88 §2.4;
//   the design's pre-establishment re-prompt policy), recomputing the prompt regime from current
//   state each round; the optional trusted-hash upgrade stays one-shot with a no-nag decline,
//   which also releases the collected evidence (§4);
// - EVIDENCE is generation-bound, promotable, retained in full until establishment, and LIVE
//   THROUGH establishment (review 88 §2.3): the verdict must be computed over rows still current
//   after every await — the establishment attempts and the final derivation included — or a late
//   v0 row could bypass the mixed-corpus exact-v0 requirement and a late cipher could slip past
//   a fresh seal. establishCandidate (src/secret.ts) requires an exact v0 authentication
//   whenever v0 evidence exists and iterates v1 evidence past corrupt rows; derivation is LAZY
//   and memoized per candidate;
// - ONE per-generation PROFILE flight, shared by proactive acquisition and the fixed-owner
//   external handle; transient outcomes never wedge the generation, and a clear() between the
//   read and provisioning stops before the transaction. EVERY consumer of an online-confirmed
//   profile runs the envelope comparison and removes a contradicted envelope on the spot
//   (§2.4/§2.5 of review 87); and
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

// the COMPLETE session value: one establishment's v0 secret and v1 key together (review 88 §2.1)
export type KdfSessionKeys = { uid: string; salt: string; key: CryptoKey; v0Secret: string }

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
  // the component's IN-FLIGHT LEGACY v0 acquisition (fixed-owner resolve, or the provisional
  // fallback prompt), if one is pending; null otherwise — and NEVER the session-driven
  // acquisition itself (the component excludes it, or the join would deadlock on its own
  // flight). `acquire` joins it before prompting, since its settlement may adopt a session or
  // publish a v0 secret
  pendingV0: () => Promise<unknown> | null
  // AUTHORITATIVE EMPTINESS (review 88 §2.2): true only when FULL-ACCOUNT initialization has
  // completed from a server-confirmed snapshot for this principal and no classified ciphertext
  // was encountered — the one state where a newly CHOSEN phrase is definitionally correct. NEVER
  // caller intent, and NEVER a fixed page (its query is a shared subset of the account)
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
  // the blocking wrong-phrase notice shown between required attempts (the same policy the fixed
  // resolver applies): resolves when the user acknowledges, and the flight re-prompts
  reportWrongPhrase: () => Promise<void>
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
  // until establishment, with a REVISION so establishment can prove it validated the complete
  // collection (review 88 §2.3). released on establishment, decline and forget()
  let evidence: CandidateEvidence<EvidenceCipher>[] = []
  let evidenceRevision = 0
  // the TRUST BASELINE (reviews 87-88 §2.1): the stored v0 hash as anchored at the session's
  // first touch of this generation — before any prompt could have written storage — advanced
  // only by the session's own established publications. a stored hash that differs from the
  // baseline is a mid-generation write by an UNESTABLISHED flow and is never honored by the
  // exact-hash comparison or an envelope restore
  let baselineV0: { value: string | null } | null = null
  // the ONE per-generation profile flight (kept across not-ready outcomes so a stronger caller
  // never pays a second read; transient outcomes clear it so nothing wedges)
  let profileFlight: { generation: number; uid: string; promise: Promise<ProfileResolution> } | null = null

  const notReady = (reason: string): KdfAcquireOutcome => ({ kind: 'not-ready', reason })

  // lazy first-touch anchor (never at construction: deps read origin storage, and the component
  // constructs the session during SSR-safe setup). every flight, every evidence note and the
  // external handle touch it before any prompt of the generation can run
  const baseline = () => (baselineV0 ??= { value: deps.storedV0() }).value

  // forget all in-memory state and advance the generation (shared by clear/invalidate; a plain
  // closure so neither method depends on `this`)
  const forget = (reason: string) => {
    generation++
    session = null
    inflight = null
    declined = false
    evidence = []
    evidenceRevision++
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
  // the decoded envelope when its salt matches the profile exactly, and REMOVES a valid same-uid
  // envelope whose salt the profile contradicts — confirmed obsolete, it must not survive to be
  // resurrected by a later offline load
  const confirmEnvelope = (uid: string, profile: KdfProfile) => {
    const decoded = decodeKeyEnvelope(deps.storedEnvelope(), uid)
    if (!decoded) return null
    if (decoded.salt === profile.salt) return decoded
    deps.clearEnvelope()
    return null
  }

  // a decoded envelope restores ONLY as the complete bound state (review 88 §2.1): the current
  // store, the envelope's own v0 binding, and the generation baseline must all agree — a v1 key
  // beside an unrelated or mid-generation v0 hash is not a session
  const boundV0 = (decoded: { v0Secret: string }): string | null => {
    const stored = deps.storedV0()
    return stored && stored === decoded.v0Secret && stored === baseline() ? stored : null
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

  // seal one COMPLETE establishment: v0 published (and the baseline advanced — the session's own
  // publication is trusted), then the BOUND phrase-free envelope, then the session value
  const seal = (uid: string, salt: string, v0secret: string, derived: DerivedKey): KdfSessionKeys => {
    deps.publishV0(v0secret)
    baselineV0 = { value: v0secret }
    deps.persistEnvelope(encodeKeyEnvelope({ uid, salt, keyBytes: derived.keyBytes, v0Secret: v0secret }))
    evidence = []
    evidenceRevision++
    return (session = { uid, salt, key: derived.key, v0Secret: v0secret })
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
      // OFFLINE: reuse is COMPLETE-AND-BOUND only (review 88 §2.1) — the envelope, the current
      // store and the baseline must name one establishment's v0 secret. anything less fails
      // closed rather than splitting the regimes
      const decoded = decodeKeyEnvelope(deps.storedEnvelope(), uid)
      const v0secret = decoded && boundV0(decoded)
      if (!decoded || !v0secret) return notReady('offline without complete persisted keys')
      const key = await deps.importKey(decoded.keyBytes)
      if (stale()) return notReady('superseded')
      return { kind: 'ready', keys: (session = { uid, salt: decoded.salt, key, v0Secret: v0secret }) }
    }

    // 2. the ENVELOPE, against the confirmed profile (mismatches are removed — review 87 §2.4),
    //    restoring ONLY the complete bound state
    const confirmed = confirmEnvelope(uid, profile)
    const confirmedV0 = confirmed && boundV0(confirmed)
    if (confirmed && confirmedV0) {
      const key = await deps.importKey(confirmed.keyBytes)
      if (stale()) return notReady('superseded')
      return { kind: 'ready', keys: (session = { uid, salt: profile.salt, key, v0Secret: confirmedV0 }) }
    }
    // a BINDING CONFLICT is terminal, never "recovered" (review 89 §2.1): a same-profile envelope
    // bound to establishment A beside a STABLE stored hash B means v1(A) ciphertext may exist —
    // exact-hashing B and sealing over A would strand it while attesting completeness. both
    // stores are preserved; which side to recover is a corpus question for a later design. the
    // DISTINCT case where the stored hash matches the envelope but not the baseline (a
    // mid-generation write) still falls through to ordinary corpus establishment
    if (confirmed) {
      const stored = deps.storedV0()
      if (stored && stored !== confirmed.v0Secret && stored === baseline())
        return notReady('key binding conflict')
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

    // 4. the PROMPT/ESTABLISH loop (review 88 §2.4): a required candidate that fails corpus
    //    establishment re-prompts, with the regime recomputed from CURRENT state each round —
    //    evidence may have arrived while a new-phrase prompt was open, and the next prompt must
    //    then be the existing-phrase flow. the optional trusted-hash upgrade stays one-shot
    while (true) {
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
        // authoritatively empty (reviews 87-88 §2.2). evidence arriving before the seal still
        // validates (the stable-revision loop below)
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
        // a declined upgrade also releases the collected evidence (review 88 §4): no future
        // attempt of this generation can consume it before clear()/invalidate() resets both
        evidence = []
        evidenceRevision++
        return notReady('declined')
      }
      const candidate = phrase

      // 5. the candidate's v0 hash; the trusted-hash comparison is the cheap one-shot refusal
      const v0secret = await deps.hashPhrase(candidate)
      if (stale()) return notReady('superseded')
      if (trustedV0) {
        if (v0secret != trustedV0) {
          deps.onWarn('phrase does not match this device’s stored secret; upgrade skipped')
          return notReady('wrong phrase')
        }
        const derived = await deriveKey(candidate, profile)
        if (stale()) return notReady('superseded')
        return { kind: 'ready', keys: seal(uid, profile.salt, v0secret, derived) }
      }

      // 6. ESTABLISHMENT against a STABLE evidence revision (review 88 §2.3), with LAZY memoized
      //    derivation: the verdict — and the final derivation — must both complete with the
      //    revision unchanged, or the policy re-runs over the fuller collection (memoized
      //    DERIVATION keeps Argon cheap; authentication attempts do re-run). refusals pay no
      //    Argon. the revision-checked DerivedKey is CARRIED OUT of the loop and sealed in the
      //    SAME synchronous continuation (review 89 §2.3) — a second await on the resolved memo
      //    would yield to the microtask queue and reopen the gap the checks just closed
      let derivedMemo: Promise<DerivedKey> | null = null
      const deriveOnce = () => (derivedMemo ??= deriveKey(candidate, profile))
      let established: DerivedKey | null = null
      let wrong = false
      while (established === null && !wrong) {
        const revision = evidenceRevision
        const rows = evidence.slice()
        if (!rows.length) {
          if (!freshSeal) return notReady('no evidence to validate a first phrase')
          const derived = await deriveOnce() // fresh seal: the last await before publication
          if (stale()) return notReady('superseded')
          if (evidenceRevision != revision) continue // rows arrived during the seal derivation
          established = derived
          break
        }
        const verdict = await establishCandidate(rows, {
          tryV0: row => deps.attemptV0(row, v0secret),
          tryV1: async row => deps.attemptV1(row, (await deriveOnce()).key),
        })
        if (stale()) return notReady('superseded')
        if (evidenceRevision != revision) continue // late rows: revisit REGARDLESS of the verdict
        if (verdict.kind != 'established') {
          wrong = true
          break
        }
        const derived = await deriveOnce()
        if (stale()) return notReady('superseded')
        if (evidenceRevision != revision) continue // rows arrived during the final derivation
        established = derived
      }
      if (wrong) {
        // ONE blocking notice on the required path (review 89 §3.2; onWarn stays with the
        // optional trusted-hash mismatch), then re-prompt with the regime recomputed
        await deps.reportWrongPhrase()
        if (stale()) return notReady('superseded')
        continue
      }

      // 7. seal in THIS continuation — no await separates the final revision check from the seal
      return { kind: 'ready', keys: seal(uid, profile.salt, v0secret, established!) }
    }
  }

  return {
    /**
     * Notes one classified cipher as corpus evidence for candidate validation. Called by the
     * component's decrypt paths as ciphers stream through them; deduplicated, inert when
     * disabled/ineligible/established/declined, retained until establishment or forget.
     * Evidence is generation-scoped, revisioned, and consulted LIVE by the acquisition flight —
     * through establishment itself (review 88 §2.3).
     */
    noteEvidence(regime: 'v0' | 'v1', row: EvidenceCipher): undefined {
      if (!deps.enabled() || !deps.eligible() || session || declined) return undefined
      void baseline() // evidence implies ciphertext existed before any prompt of this generation
      const duplicate = evidence.some(
        e =>
          e.kind == regime &&
          (row.kind == 'text'
            ? e.cipher.kind == 'text' && e.cipher.cipher == row.cipher
            : e.cipher.kind == 'bytes' && e.cipher.cipher === row.cipher)
      )
      if (!duplicate) {
        evidence.push({ kind: regime, cipher: row })
        evidenceRevision++
      }
      return undefined
    },
    /**
     * Acquires (or returns) the session keys — READY always means the COMPLETE BOUND one-phrase
     * state (v0 secret published and v1 key held, from one establishment). Single-flight; a
     * `not-ready` outcome is NEVER retained — the slot clears on every settle — and a flight in
     * progress consults evidence that arrives after it began, through establishment itself. When
     * the kdf flag is on, THIS is the prompt owner.
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
     * the current generation and principal at creation; `profile` anchors the baseline, reuses
     * the session's per-generation profile flight, runs BEFORE the resolver's prompt, and
     * performs the same envelope confirmation as the ordinary path; `derive` uses the session's
     * single worker slot; `adopt` is ONE SYNCHRONOUS COMPLETE PUBLICATION (review 88 §2.1) — it
     * publishes the v0 half, advances the baseline, persists the BOUND envelope and caches the
     * session, or refuses entirely if a clear() intervened. Both effectful calls check the fence
     * BEFORE starting work, so a stale handle cannot begin a server read or a Worker.
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
          void baseline() // anchor before the generation's first external effect too
          const profile = await getProfile(boundUid)
          if (stale()) throw new Error('kdf acquisition superseded')
          if (!profile) throw new Error('could not read the account kdf profile')
          confirmEnvelope(boundUid, profile) // review 87 §2.4: this consumer revokes mismatches too
          return profile
        },
        derive: async (phrase: string, profile: KdfProfile): Promise<DerivedKey> => {
          if (stale()) throw new Error('kdf acquisition superseded')
          const derived = await deriveKey(phrase, profile)
          if (stale()) throw new Error('kdf acquisition superseded')
          return derived
        },
        adopt: (v0secret: string, salt: string, derived: DerivedKey): boolean => {
          if (stale() || !boundUid) return false
          seal(boundUid, salt, v0secret, derived)
          return true
        },
      }
    },
    /** The current keys, if this session holds them (readiness observable for the checklist —
     * per the completeness rule, it attests BOTH bound regimes). */
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
