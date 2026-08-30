// vault_result_v1 scanner + association (bridge design §2.2-2.3, reviews 138-142):
// the security boundary that keeps model output OPAQUE to every item grammar. One pure
// left-to-right OUTERMOST-OWNER scan claims reserved regions BEFORE any grammar consumer
// (tags, labels, macros, messages, Marked, runnable/input detection, typed block reads)
// sees their bytes; a pure LEXICAL association pass then decides envelope validity per
// raw delimiter group -- deliberately BEFORE the evaluating/message-transforming chat
// parser runs (review 142 §2.3). Python twin: the vault's lib/mindpage_codec.py; parity
// vectors pin both. Scope: CANDIDATE-RANGE opacity (review 142 ruling) -- an invalid
// candidate renders as the fixed placeholder while sibling text stays ordinary
// owner-authored item text (the trusted publisher is the only source of model bytes).

// the app's global tag parser (untyped util.js; the app tsconfig is non-strict and the
// tests tsconfig needs the suppression, as in src/zwsp.ts)
// @ts-ignore
import { parseTags } from './util.js'

export const RESULT_FENCE = 'vault_result_v1'

// claimant padding is EXPLICITLY spaces/tabs in both languages (review 142 §2.5 --
// language-native \s diverges: FEFF is JS-space-only, U+001C is Python-space-only)
const RESULT_OPEN = /^[ \t]*```vault_result_v1[ \t]*$/
// review 141 §2.1: only a BARE-ONLY fence line ends a claim -- a suffixed fence
// (```js_input) is BODY, not a terminator, else a nested opener would end the claim
// and expose its body.
const RESULT_CLOSE = /^[ \t]*```[ \t]*$/
// CANONICAL lines are LITERAL -- no padding at all (review 142 §2.1)
const CANONICAL_OPEN = '```' + RESULT_FENCE
const CANONICAL_CLOSE = '```'
// the app's _log|_output opener grammar (extractBlock in src/util.js): these regions OWN
// their body under the outermost rule, so a result opener inside them is ignored. NOTE:
// this scanner does NOT mask log/output bytes (their app grammar treatment is unchanged
// by this slice) -- ownership only; the Python twin canonical-masks them for bridge
// request parsing (an intentional, documented non-parity) but mirrors THESE regexes with
// explicit ECMAScript whitespace classes so outermost OWNERSHIP never diverges (review
// 143 §2.3: U+FEFF is JS-space-only, U+001C is Python-space-only).
const LOG_OPEN = /^\s*```(?:\S+:)?(?:_output|_log)(?:_hidden|_removed)?(?::\S*\.\S*)?(?:\s|$)/i
const LOG_CLOSE = /^\s*```/

export type VaultCandidate = {
  marker: string // the collision-free inert token substituted into grammarText
  body: string // the raw claimed body (lines between opener and close/EOF), joined by LF
  source: string // the EXACT raw claimed text (opener line through close/EOF), for restore
  closed: boolean // whether a bare-only close line was found (unclosed claims run to EOF)
  canonical: boolean // literal opener line + exactly ONE body line + literal bare close
  value: string | null // strictly decoded result text, or null if the BODY is invalid
}

export type VaultScan = {
  grammarText: string // the one view every grammar consumer receives
  candidates: VaultCandidate[]
}

// strict body decode, twin of decode_result_body in lib/mindpage_codec.py: exactly one
// line, no whitespace, canonical RFC 4648 padded base64 (decode/re-encode equality),
// strict UTF-8 with the BOM PRESERVED as text (review 142 §2.5: ignoreBOM=true keeps
// U+FEFF, matching Python's strict decoder; the exact body 77u/YQ== is pinned in both).
// returns null on any violation -- callers render the fixed placeholder or substitute
// the failure value, never partial output.
export function decodeResultBody(body: string): string | null {
  if (body.includes('\n') || body !== body.trim() || /\s/.test(body)) return null
  if (body === '') return ''
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0) return null
  let raw: Uint8Array
  try {
    raw = Uint8Array.from(atob(body), c => c.charCodeAt(0))
  } catch {
    return null
  }
  let binary = ''
  for (const byte of raw) binary += String.fromCharCode(byte)
  if (btoa(binary) !== body) return null // noncanonical padding / pad bits
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
  } catch {
    return null
  }
}

// canonical encoder. input domain is UNICODE SCALARS: a lone surrogate throws (review
// 142 §2.5 -- TextEncoder would silently replace it while Python raises; the twins
// reject identically instead)
export function encodeResult(text: string): string {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))
    throw new Error('lone surrogate in result text')
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return CANONICAL_OPEN + '\n' + btoa(binary) + '\n' + CANONICAL_CLOSE
}

// the one outermost-owner scan (reviews 141-142). markers are COLLISION-FREE against the
// lexical source: the namespace suffix k is the smallest integer making the marker
// prefix absent from the raw text, so owner-authored text can never impersonate a
// generated marker (review 142 §2.2); each source (item, dependency) is scanned
// separately, so association corpora never mix namespaces.
export function scanVaultResults(text: string): VaultScan {
  let k = 0
  while (text.includes(`⟦${RESULT_FENCE}:${k}:`)) k++
  const lines = text.split('\n')
  const out: string[] = []
  const candidates: VaultCandidate[] = []
  let state: 'plain' | 'log' | 'result' = 'plain'
  let body: string[] = []
  let source: string[] = [] // opener + body (+ close), the exact claimed raw text
  let openerLiteral = false
  const finish = (closed: boolean, closeLiteral: boolean) => {
    const marker = `⟦${RESULT_FENCE}:${k}:${candidates.length}⟧`
    const raw = body.join('\n')
    // canonical shape (review 142 §2.1): literal opener, exactly ONE body line (which
    // may be empty -- ZERO body lines is the two-line malformed envelope, not the
    // canonical empty result), literal bare close
    const canonical = closed && openerLiteral && closeLiteral && body.length === 1
    const value = closed ? decodeResultBody(raw) : null
    candidates.push({ marker, body: raw, source: source.join('\n'), closed, canonical, value })
    out.push(marker)
    body = []
    source = []
  }
  for (const line of lines) {
    if (state === 'result') {
      source.push(line)
      if (RESULT_CLOSE.test(line)) {
        state = 'plain'
        finish(true, line === CANONICAL_CLOSE)
      } else body.push(line)
    } else if (state === 'log') {
      out.push(line)
      if (LOG_CLOSE.test(line)) state = 'plain'
    } else if (RESULT_OPEN.test(line)) {
      state = 'result'
      source.push(line)
      openerLiteral = line === CANONICAL_OPEN
    } else if (LOG_OPEN.test(line)) {
      state = 'log'
      out.push(line)
    } else {
      out.push(line)
    }
  }
  if (state === 'result') finish(false, false)
  return { grammarText: out.join('\n'), candidates }
}

// the exact bridge footer grammar (review 142 §2.4): ASCII persona, MANDATORY run id
// and duration, optional cost in the writer's exact format ($ + digits.2 digits).
// bare legacy names (vault/default alone) are quoted history, never a trusted envelope.
export const FOOTER_NAME = /^vault\/[a-z0-9_]+ · run [0-9a-f]{8}( · \$(?:0|[1-9][0-9]*)\.[0-9][0-9])? · (?:0|[1-9][0-9]*)s$/
// the one writer-side formatter the predicate mirrors
export function formatFooter(persona: string, run: string, seconds: number, cost?: number): string {
  // cents via the scaled nonnegative float, identically in both languages -- the
  // formatter IS the definition (toFixed alone diverges from python's format)
  const costPart = cost === undefined ? '' : ` · $${(Math.round(cost * 100) / 100).toFixed(2)}`
  return `vault/${persona} · run ${run}${costPart} · ${Math.round(seconds)}s`
}

// non-evaluating delimiter boundary (reviews 142-143): TWO jobs, deliberately separate.
// (1) BOUNDARY recognition mirrors the real parser (chat.js): SPACES-only indentation,
// case-insensitive roles, and an arbitrary one-line raw name (never evaluated) -- so
// <<USER>>, <<user(foo)>>, and <<user("Alice")>> all END the preceding group exactly as
// the real parser would. (2) The candidate-OWNING opener is separately required to be
// the exact literal lowercase unindented <<agent('<footer>')>> form.
const DELIMITER = /(?:^|\n) *<< *(system|user|_?agent|tool)(?: *\( *([^\n]*) *\))? *>>/gi

export type VaultAssociation = {
  marker: string
  valid: boolean // the message-level decision: render decoded value vs fixed placeholder
  value: string | null // present iff valid
}

// pure LEXICAL association over grammarText (review 142 §2.3): a candidate is VALID only
// when its marker occurs EXACTLY ONCE in the whole grammarText, inside exactly one raw
// delimiter group whose opener is literally <<agent('<footer>')>> with the exact footer
// grammar, whose raw content is exactly '\n' + marker -- and the candidate is canonical
// with a valid body. everything else (raw-text impersonation is impossible by marker
// construction; wrong role, unquoted/evaluated names, extra content such as a trailing
// agent block, double markers, marker before the first delimiter) is invalid-in-place.
export function associateVaultResults(grammarText: string, candidates: VaultCandidate[]): VaultAssociation[] {
  // owning === the exact trusted opener: literal lowercase, unindented, single-quoted
  // footer, no stray spacing (review 143 §2.1) -- boundary matches are deliberately
  // BROADER (real-parser grammar) so real following delimiters always end the group
  type Group = { owner: string | null; content: string }
  const groups: Group[] = []
  const matches = [...grammarText.matchAll(DELIMITER)]
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const start = match.index! + match[0].length
    const end = i + 1 < matches.length ? matches[i + 1].index! : grammarText.length
    // the next match BEGINS at its boundary newline, so the slice already excludes it:
    // canonical content is exactly '\n' + marker with NO further trimming (review 143
    // §2.2 -- an extra trim ate one real content LF and validated envelope+blank-line)
    const content = grammarText.slice(start, end)
    const line = match[0].replace(/^\n/, '')
    const quoted = /^<<agent\('([^'\n]*)'\)>>$/.exec(line)
    groups.push({ owner: quoted ? quoted[1] : null, content })
  }
  return candidates.map(candidate => {
    const occurrences = grammarText.split(candidate.marker).length - 1
    const containing = groups.filter(group => group.content.includes(candidate.marker))
    const sole =
      occurrences === 1 &&
      containing.length === 1 &&
      containing[0].owner !== null &&
      FOOTER_NAME.test(containing[0].owner) &&
      containing[0].content === '\n' + candidate.marker
    const valid = sole && candidate.canonical && candidate.value !== null
    return { marker: candidate.marker, valid, value: valid ? candidate.value : null }
  })
}

// fixed inert placeholder text rendered for an INVALID candidate (design §2.2: never a
// fallback to markup; the renderer assigns decoded values and this constant only via
// textContent, so neither ever meets the html/macro/tag grammar)
export const INVALID_RESULT_PLACEHOLDER = '⟦invalid vault result⟧'

// restore raw candidate sources into a text whose candidate ranges are still markers:
// each retained marker (exactly one occurrence) is replaced with its exact raw source.
function restoreVaultCandidates(text: string, candidates: VaultCandidate[]): string {
  for (const candidate of candidates)
    if (text.includes(candidate.marker)) text = text.replace(candidate.marker, () => candidate.source)
  return text
}

// a bounded source-preserving edit (design §2.3 read-modify-write safety, reviews 148-149):
// run `transform` over the grammar view -- so a candidate's fake checkboxes/inputs/
// delimiters cannot shift indices or be matched -- then restore the EXACT raw envelopes.
// the contract the restore alone cannot guarantee (review 149 §1.1):
//   - DUPLICATE a marker: rejected (String.replace would persist the second opaque marker)
//   - DROP a marker: rejected UNLESS `allowDrop` (silent loss is unsafe for a checkbox
//     toggle; it is the intended result for chat's explicit "delete messages below")
//   - MOVE a marker into a position where the next scan no longer claims the restored
//     bytes (inline, or beneath an outer _log|_output opener): rejected by the
//     postcondition that the retained source multiset stays exactly claimed
export function editVaultText(
  rawText: string,
  transform: (grammarText: string) => string,
  { allowDrop = false }: { allowDrop?: boolean } = {}
): string {
  const scan = scanVaultResults(rawText)
  const transformed = transform(scan.grammarText)
  const occurrences = (text: string, marker: string) => text.split(marker).length - 1
  for (const candidate of scan.candidates) {
    const count = occurrences(transformed, candidate.marker)
    if (count > 1) throw new Error('vault edit duplicated a result candidate')
    if (count === 0 && !allowDrop) throw new Error('vault edit dropped a result candidate')
  }
  const restored = restoreVaultCandidates(transformed, scan.candidates)
  // POSTCONDITION: every retained candidate's exact source must still be claimed by a
  // fresh scan (catches a move that unclaims the restored bytes; permits whole-line
  // reordering between plain positions)
  const retained = scan.candidates
    .filter(candidate => occurrences(transformed, candidate.marker) === 1)
    .map(candidate => candidate.source)
    .sort()
  const claimed = scanVaultResults(restored)
    .candidates.map(candidate => candidate.source)
    .sort()
  if (retained.length !== claimed.length || retained.some((source, i) => source !== claimed[i]))
    throw new Error('vault edit moved a result candidate out of a claimable position')
  return restored
}

// the browser routing predicate (design §2.1, reviews 137-146): computed from the
// SCANNER'S grammar view with the app's global tag parser -- never resolved item state
// (tags_raw is label-resolved after init) -- so a route inside a malformed candidate is
// invisible, exactly as on the Python side. any direct tag equal to one of the four
// canonical/legacy visible/hidden roots, or such a root plus a '/' descendant, routes
// to the vault and SUPPRESSES web dispatch (an invalid/unregistered persona fails
// closed to the vault rather than falling through to a web provider).
const VAULT_ROOTS = ['#agent/vault', '#_agent/vault', '#agent/native', '#_agent/native']
export function isVaultRouted(rawText: string): boolean {
  const tags: string[] = (parseTags(scanVaultResults(rawText).grammarText.toLowerCase()) as { raw: string[] }).raw
  return tags.some(tag => VAULT_ROOTS.some(root => tag === root || tag.startsWith(root + '/')))
}
