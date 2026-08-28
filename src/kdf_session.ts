// The SESSION KEY ORCHESTRATOR (see the KDF migration design in the vault repo,
// notes/design/mind_page_kdf_migration.md, and reviews 85-86): ONE component-owned state machine
// for everything between "signed-in principal confirmed" and "keys usable".
//
// Everything effectful is injected, so the ORCHESTRATION — profile-first, envelope-vs-profile,
// the one-time upgrade prompt, one derivation per candidate phrase, generation fencing at every
// effect boundary, and the retryable-vs-declined distinction — is unit-tested in milliseconds.
//
// The rules it owns:
// - ONE per-generation PROFILE flight, shared by proactive acquisition, phrase offers and the
//   fixed-owner external handle; its try/catch covers ONLY the server read, so present-invalid
//   metadata or a failed provisioning transaction FAILS rather than being mistaken for offline
//   (review 85 §2.4). Transient outcomes (offline, rejection) never wedge the generation;
// - EVIDENCE is generation-bound and PROMOTABLE (review 86 §2.1): the component notes classified
//   v0/v1 ciphers as they pass its decrypt paths, and the acquisition flight consults the CURRENT
//   collection at its decision points — never a boolean frozen by its first caller;
// - first-phrase validation is the CORPUS POLICY, not one sticky row (§2.2): establishCandidate
//   (src/secret.ts) requires an exact v0 authentication whenever v0 evidence exists (the
//   NFC-equivalent-spelling hole) and iterates v1 evidence past authentication failures;
// - a phrase collected by the component's v0 prompt reaches this session through `offerPhrase` —
//   registered synchronously and CONSUMED BY THE ACTIVE FLIGHT as its candidate (§2.3): there is
//   no second profile/derivation/publication pipeline, and an offered phrase is validated against
//   corpus evidence (never against the v0 hash its own flow just published) before anything is
//   sealed. Only a freshly CHOSEN phrase (a new account with no ciphertext) may seal without
//   evidence — and even it validates when evidence exists;
// - a "not ready" outcome is NEVER cached: the slot clears on every settle. A deliberate DECLINE
//   sets a no-nag marker that suppresses further PROMPTS, not envelope/profile checks;
// - a valid same-uid envelope naming a DIFFERENT salt than the online-confirmed profile is
//   removed through `clearEnvelope` (§2.4) — otherwise a decline would leave it to be resurrected
//   by a later offline load, ready to back wrong-key writes once a writer exists;
// - `clear()` advances the generation, forgets all state including the decline marker and
//   evidence, disposes the in-flight worker, and clears persisted state through deps — the ONE
//   key-lifecycle primitive for sign-out, sign-in start, confirmed-null and mismatch;
//   `invalidate()` is the fence-only variant for the external-auth-transition reload, where the
//   persisted stores are governed by the flow that changed the auth state.

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

// the per-generation profile flight's resolution: the server-confirmed profile, or null for
// OFFLINE (the authoritative read failed — transient, never cached). null rather than a tagged
// union because the app tsconfig is non-strict, where discriminant narrowing of the tag fails
type ProfileResolution = KdfProfile | null

export type KdfAcquireOutcome =
  | { kind: 'ready'; keys: KdfSessionKeys }
  // not an error and not cached: the reader flag is off, no evidence can validate a prompt, the
  // prompt was declined, or we are offline with no envelope. the next call re-evaluates
  | { kind: 'not-ready'; reason: string }

// one classified cipher the component's decrypt paths saw — the corpus evidence a first phrase
// is validated against
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
  // the component's IN-FLIGHT v0 acquisition, if one is pending (the `secret` slot while its
  // prompt is up); null otherwise. `acquire` joins it before prompting — its prompt tail offers
  // the phrase here, so one prompt serves both regimes
  pendingV0: () => Promise<unknown> | null
  // ONE profile store per profile flight, bound to the uid at construction: a principal change
  // between a transaction's read and write cannot retarget it (review 85 §2.5)
  profileStore: (uid: string) => {
    // server-authoritative read of the users/{uid} data; REJECTS on network failure
    read: () => Promise<Record<string, unknown> | undefined>
    // the real runTransaction adapter (see provisionKdfProfile's deps)
    runTransaction: Parameters<typeof provisionKdfProfile>[0]['runTransaction']
  }
  randomSalt: () => Uint8Array
  // the upgrade prompt (device HAS a stored v0 secret): resolves the phrase or null on decline
  promptUpgrade: () => Promise<string | null>
  // the first-phrase prompt (no stored v0 secret; a v1-only or mixed corpus on a new device):
  // resolves the phrase or null on decline
  promptPhrase: () => Promise<string | null>
  // the v0 stored form of a phrase (uid-bound hash)
  hashPhrase: (phrase: string) => Promise<string>
  // publishes the v0 secret (in-memory `secret` and its persisted form) — the ONE-PHRASE-BOTH-
  // REGIMES rule for the session's own prompt: called before the acquisition resolves
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

// how many evidence rows are retained per regime: enough to iterate past a corrupt row to a
// valid one (review 86 §2.2), small enough that bytes buffers cannot accumulate
const EVIDENCE_ROWS_PER_REGIME = 3

export function createKdfSession(deps: KdfSessionDeps) {
  let generation = 0
  let session: KdfSessionKeys | null = null
  let inflight: Promise<KdfAcquireOutcome> | null = null
  let declined = false
  let activeWorker: { dispose: (reason?: string) => undefined } | null = null
  // classified corpus evidence for the current generation (see noteEvidence); released on
  // establishment and on forget()
  let evidence: CandidateEvidence<EvidenceCipher>[] = []
  // a phrase handed in by the component's v0 prompt tail, consumed as the active (or next)
  // flight's candidate; `fresh` marks a newly CHOSEN phrase (account with no ciphertext)
  let offered: { generation: number; phrase: string; fresh: boolean } | null = null
  // the ONE per-generation profile flight (kept across not-ready outcomes so a stronger caller
  // never pays a second read; transient outcomes clear it so nothing wedges)
  let profileFlight: { generation: number; uid: string; promise: Promise<ProfileResolution> } | null = null

  const notReady = (reason: string): KdfAcquireOutcome => ({ kind: 'not-ready', reason })

  // forget all in-memory state and advance the generation (shared by clear/invalidate; a plain
  // closure so neither method depends on `this`)
  const forget = (reason: string) => {
    generation++
    session = null
    inflight = null
    declined = false
    evidence = []
    offered = null
    profileFlight = null
    activeWorker?.dispose(reason)
    activeWorker = null
  }

  // the ONE profile resolution: try covers ONLY the server read (review 85 §2.4); decode and
  // provisioning failures propagate out of the caller's whole attempt
  const resolveProfile = async (store: ReturnType<KdfSessionDeps['profileStore']>): Promise<ProfileResolution> => {
    let profileData: Record<string, unknown> | undefined
    try {
      profileData = await store.read()
    } catch {
      return null // offline
    }
    const state = decodeKdfMetadata(profileData?.kdf) // present-invalid THROWS out of the attempt
    return state.kind == 'valid'
      ? state.profile
      : await provisionKdfProfile({ randomSalt: deps.randomSalt, runTransaction: store.runTransaction })
  }

  const getProfile = (uid: string) => {
    if (profileFlight && profileFlight.generation == generation && profileFlight.uid == uid) return profileFlight.promise
    const flight = {
      generation,
      uid,
      promise: resolveProfile(deps.profileStore(uid)), // store BOUND to this uid for the flight
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

  // the ONE derivation seam: a per-call worker held in the SINGLE activeWorker slot (disposed in
  // finally and by clear()). all derivations — session prompt, offered phrase, external handle —
  // run through here, and candidates are serialized by the single flight, so at most one worker
  // exists at a time
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

  // consume the offered candidate if it belongs to this generation
  const takeOffered = (myGeneration: number) => {
    if (!offered || offered.generation != myGeneration) return null
    const taken = offered
    offered = null
    return taken
  }

  const acquireOnce = async (myGeneration: number): Promise<KdfAcquireOutcome> => {
    const stale = () => myGeneration != generation
    const uid = deps.uid()
    if (!uid) return notReady('no confirmed principal')

    // 1. PROFILE FIRST (the salt is public; no phrase crosses any network retry)
    const profile = await getProfile(uid)
    if (stale()) return notReady('superseded')
    if (!profile) {
      // OFFLINE: envelope-only reuse (previously committed for this uid; its own validation —
      // uid, version, canonical encodings — is the whole check, since the salt it names WAS
      // server-confirmed when persisted); no salt invented
      const decoded = decodeKeyEnvelope(deps.storedEnvelope(), uid)
      if (!decoded) return notReady('offline without a committed envelope')
      const key = await deps.importKey(decoded.keyBytes)
      if (stale()) return notReady('superseded')
      return { kind: 'ready', keys: (session = { uid, salt: decoded.salt, key }) }
    }

    // 2. the ENVELOPE, against the confirmed profile. a valid same-uid envelope for a DIFFERENT
    //    salt is a previous provisioning epoch's key, confirmed obsolete by THIS online read:
    //    remove it NOW (review 86 §2.4) — left in place, a decline here would let a later
    //    offline load resurrect it
    const decoded = decodeKeyEnvelope(deps.storedEnvelope(), uid)
    if (decoded) {
      if (decoded.salt === profile.salt) {
        const key = await deps.importKey(decoded.keyBytes)
        if (stale()) return notReady('superseded')
        return { kind: 'ready', keys: (session = { uid, salt: profile.salt, key }) }
      }
      deps.clearEnvelope()
    }

    // 3. a PENDING component v0 acquisition is joined before any prompt (review 85 §2.2): its
    //    prompt tail registers an offer BEFORE the flight settles, and this flight consumes that
    //    offer as its candidate below. a REJECTED flight means the user cancelled that prompt —
    //    do not raise another one behind it
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

    // 4. the CANDIDATE: an offered phrase wins over prompting; without one, prompt — unless this
    //    session already declined (no-nag; clear() forgets it)
    const storedV0 = deps.storedV0()
    let candidate = takeOffered(myGeneration)
    let fromPrompt = false
    if (!candidate) {
      if (declined) return notReady('upgrade declined this session')
      // a FIRST phrase (no stored v0 secret) can only be validated against collected corpus
      // evidence. the CURRENT collection is consulted at this decision point — evidence noted
      // after this flight began still counts (review 86 §2.1: promotable, never a boolean frozen
      // by the first caller)
      if (!storedV0 && !evidence.length) return notReady('no evidence to validate a first phrase')
      const phrase = storedV0 ? await deps.promptUpgrade() : await deps.promptPhrase()
      if (stale()) return notReady('superseded')
      // a v0 prompt may have completed while ours was queued behind it: its offered phrase
      // supersedes whatever happened to our (redundant) modal, cancellation included
      candidate = takeOffered(myGeneration)
      if (!candidate) {
        if (phrase == null) {
          declined = true
          return notReady('declined')
        }
        candidate = { generation: myGeneration, phrase, fresh: false }
        fromPrompt = true
      }
    }

    // 5. the candidate's v0 hash. the session's OWN prompt on a returning device is validated by
    //    exact stored-hash equality — storedV0 was read BEFORE the prompt, so it cannot be the
    //    candidate's own publication. this is also the cheap pre-derivation refusal
    const v0secret = await deps.hashPhrase(candidate.phrase)
    if (stale()) return notReady('superseded')
    const byStoredHash = fromPrompt && !!storedV0
    if (byStoredHash && v0secret != storedV0) {
      deps.onWarn('phrase does not match this device’s stored secret; upgrade skipped')
      return notReady('wrong phrase')
    }

    // 6. derive ONCE for this candidate
    const derived = await deriveKey(candidate.phrase, profile)
    if (stale()) return notReady('superseded')

    // 7. ESTABLISHMENT (review 86 §2.2/§2.3): every candidate not validated by a pre-existing
    //    stored hash validates against the corpus policy — an OFFERED phrase is never checked
    //    against the v0 hash its own flow just published, and establishCandidate requires an
    //    exact v0 authentication whenever v0 evidence exists (an NFC-equivalent spelling can
    //    open v1 while hashing to a different legacy v0 secret). only a freshly CHOSEN phrase
    //    (an account with no ciphertext) may establish without evidence — and it too validates
    //    when evidence exists
    if (!byStoredHash) {
      if (evidence.length) {
        const verdict = await establishCandidate(evidence, {
          tryV0: row => deps.attemptV0(row, v0secret),
          tryV1: row => deps.attemptV1(row, derived.key),
        })
        if (stale()) return notReady('superseded')
        if (verdict.kind != 'established') {
          deps.onWarn('phrase did not open the encrypted data; upgrade skipped')
          return notReady('wrong phrase')
        }
      } else if (!candidate.fresh) {
        return notReady('no evidence to validate a first phrase')
      }
    }
    if (stale()) return notReady('superseded')

    // 8. ONE PHRASE, BOTH REGIMES: a session-prompted phrase publishes v0 BEFORE resolving (an
    //    offered phrase's own flow already published it)
    if (fromPrompt) deps.publishV0(v0secret)
    // 9. seal LAST, on this still-current established success; the evidence has served its
    //    purpose (buffers released)
    deps.persistEnvelope(encodeKeyEnvelope({ uid, salt: profile.salt, keyBytes: derived.keyBytes }))
    evidence = []
    return { kind: 'ready', keys: (session = { uid, salt: profile.salt, key: derived.key }) }
  }

  const startFlight = (): Promise<KdfAcquireOutcome> => {
    const myGeneration = generation
    const attempt = acquireOnce(myGeneration).finally(() => {
      if (inflight === attempt) inflight = null // ALWAYS: not-ready must stay retryable
      // release an unconsumed same-generation offer with the flight (no cross-flight reuse of a
      // retained phrase)
      if (offered?.generation == myGeneration) offered = null
    })
    inflight = attempt
    return attempt
  }

  return {
    /**
     * Notes one classified cipher as corpus evidence for first-phrase validation. Called by the
     * component's decrypt paths as ciphers stream through them; bounded per regime, deduplicated
     * for text, inert when disabled/ineligible/established. Evidence is generation-scoped and
     * consulted LIVE by the acquisition flight (promotable — review 86 §2.1).
     */
    noteEvidence(regime: 'v0' | 'v1', row: EvidenceCipher): undefined {
      if (!deps.enabled() || !deps.eligible() || session) return undefined
      if (evidence.filter(e => e.kind == regime).length >= EVIDENCE_ROWS_PER_REGIME) return undefined
      if (row.kind == 'text' && evidence.some(e => e.cipher.kind == 'text' && e.cipher.cipher == row.cipher))
        return undefined
      evidence.push({ kind: regime, cipher: row })
      return undefined
    },
    /**
     * Acquires (or returns) the session keys. Single-flight; a `not-ready` outcome is NEVER
     * retained — the slot clears on every settle — so a later call retries what a race made
     * impossible earlier, and a flight in progress consults evidence and offers that arrive
     * after it began.
     */
    acquire(): Promise<KdfAcquireOutcome> {
      if (!deps.enabled()) return Promise.resolve(notReady('kdf disabled'))
      if (!deps.eligible()) return Promise.resolve(notReady('ineligible page mode'))
      if (session) return Promise.resolve({ kind: 'ready', keys: session })
      if (inflight) return inflight
      return startFlight()
    },
    /**
     * Feeds a phrase the component's v0 prompt just collected into the acquisition as its
     * CANDIDATE — registered synchronously, consumed by the active flight (or a new one) at its
     * candidate point, so there is exactly one pipeline and at most one derivation. The phrase
     * is validated against corpus evidence before anything is sealed; `fresh` marks a newly
     * CHOSEN phrase (account with no ciphertext), which alone may seal without evidence — and
     * even it validates when evidence exists (review 86 §2.3). Never prompts; never publishes v0.
     */
    offerPhrase(phrase: string, options: { fresh?: boolean } = {}): Promise<KdfAcquireOutcome> {
      if (!deps.enabled()) return Promise.resolve(notReady('kdf disabled'))
      if (!deps.eligible()) return Promise.resolve(notReady('ineligible page mode'))
      if (session) return Promise.resolve({ kind: 'ready', keys: session })
      offered = { generation, phrase, fresh: !!options.fresh } // registered BEFORE any await
      if (inflight) return inflight // the active flight consumes it at its candidate point
      return startFlight()
    },
    /**
     * The EXTERNAL acquisition handle for the fixed-owner resolver (src/secret.ts), whose prompt
     * is corpus-validated with retry/sign-out flows this session does not own. The handle binds
     * the current generation and principal at creation; `profile` reuses the session's
     * per-generation profile flight and runs BEFORE the resolver's prompt, `derive` uses the
     * session's single worker slot, and `adopt` publishes externally derived keys — envelope
     * persisted, bundle cached — only if no clear() intervened (returns whether it did).
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
          const profile = await getProfile(boundUid)
          if (stale()) throw new Error('kdf acquisition superseded')
          if (!profile) throw new Error('could not read the account kdf profile')
          return profile
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
          evidence = []
          return true
        },
      }
    },
    /** The current keys, if this session holds them (readiness observable for the checklist). */
    current: () => session,
    /** The in-flight acquisition, if any — the component's v0 path joins it before prompting,
     * mirroring the session's own join of the pending v0 flight. */
    pending: () => inflight,
    /** The clear() counter: v0 publish sites captured before an await fence on it (§2.5 — a
     * pending prompt must not repopulate key state after sign-out). */
    generation: () => generation,
    /**
     * Fences WITHOUT touching persisted state: generation++, all in-memory state forgotten
     * (decline marker and evidence included), the in-flight worker disposed. For the
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
