// Inert-region scanner + wire codec (bridge reviews 177-178) -- NEW-ONLY and UNWIRED.
// The readable successor to the vault_result_v1 base64 envelope. Nothing on the loaded
// production path imports this module: the active scanner remains vault_result.ts until
// the quiescent app-first cutover (178 §2.3), at which point callers switch here and the
// v1 path is removed. Python twin: the vault's lib/mindpage_inert.py; parity vectors are
// pinned in both suites.
//
// Wire format (178 §1): exact standalone marker lines (no indentation, no trailing
// whitespace, LF-boundary recognition only -- a \r anywhere on the line disqualifies
// it), canonical writer framing OPEN + LF + escape(body) + LF + CLOSE with the two LFs
// STRUCTURAL, first-exact-close claiming, nested openers as body, unclosed claims to
// EOF. Close escape (178 §2.2): within every occurrence of `<!--` + k backslashes +
// `/inert-->`, encode rewrites k -> k+1 and decode rewrites every k >= 1 to k-1 --
// injective, and no escaped form is an exact close line. Three candidate states
// (178 §2.1): closed, framed (both structural LFs), canonical (framed AND re-encoding
// the decoded body reproduces the exact escaped body -- a residual bare close-shaped
// spelling is noncanonical). Only canonical candidates expose a value.

// markers keep the existing ephemeral prefix (178 §2.2): never persisted, and retaining
// it keeps the already-loaded stored-consumer marker refusals effective across cutover
import { RESULT_FENCE } from './vault_result.js'

export const INERT_OPEN = '<!--inert-->'
export const INERT_CLOSE = '<!--/inert-->'

// every close-shaped occurrence: `<!--` + k backslashes + `/inert-->` (178 §2.2);
// applied anywhere in the body, not only line-anchored -- one uniform rule
const CLOSE_SHAPED = /<!--(\\*)\/inert-->/g

// the app's _log|_output opener grammar, duplicated VERBATIM from vault_result.ts
// (178 §2.3: the active v1 module stays untouched; this new-only scanner composes with
// the same landed _log|_output ownership -- ownership only, bytes preserved)
const LOG_OPEN = /^\s*```(?:\S+:)?(?:_output|_log)(?:_hidden|_removed)?(?::\S*\.\S*)?(?:\s|$)/i
const LOG_CLOSE = /^\s*```/

// escape body text for the wire: every close-shaped backslash run k -> k+1
export function escapeInertBody(text: string): string {
  return text.replace(CLOSE_SHAPED, (_match, run: string) => `<!--${run}\\/inert-->`)
}

// reverse of escapeInertBody: every close-shaped run k >= 1 -> k-1; a residual k = 0
// occurrence is left unchanged here and rejected as noncanonical by decodeInertSource
export function unescapeInertBody(body: string): string {
  return body.replace(CLOSE_SHAPED, (match, run: string) =>
    run ? `<!--${run.slice(1)}/inert-->` : match
  )
}

// canonical writer framing. input domain is UNICODE SCALARS (178 §2.1): a lone UTF-16
// surrogate throws (matching Python's strict encoder), never silently replaced
export function encodeInert(text: string): string {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))
    throw new Error('lone surrogate in inert text')
  return INERT_OPEN + '\n' + escapeInertBody(text) + '\n' + INERT_CLOSE
}

// strictly decode one claimed region's EXACT extent back to body text, or return null.
// takes the full source, never a joined body -- OPEN\nCLOSE (unframed; its single LF
// cannot serve as both structural LFs) stays distinct from OPEN\n\nCLOSE (the canonical
// empty body). requires writer canonicality: re-encoding the decoded body must
// reproduce the exact escaped body (178 §2.1).
export function decodeInertSource(source: string): string | null {
  const prefix = INERT_OPEN + '\n'
  const suffix = '\n' + INERT_CLOSE
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return null
  if (source.length < prefix.length + suffix.length) return null // overlapping single LF
  const text = unescapeInertBody(source.slice(prefix.length, source.length - suffix.length))
  // canonical MEANS membership in the one writer's image (review 179 §1): the writer
  // itself is the predicate, so its lone-surrogate rejection binds here too
  try {
    if (encodeInert(text) !== source) return null
  } catch {
    return null // outside the writer's scalar domain
  }
  return text
}

export type InertCandidate = {
  marker: string // collision-free token substituted into grammarText (retained prefix)
  source: string // the EXACT raw claimed text (opener line through close line or EOF)
  start: number // range start: UTF-16 code-unit offset into the exact scanned string
  end: number // half-open range end; text.slice(start, end) === source; excludes the
  // following LF; an unclosed candidate has end === text.length
  closed: boolean // an exact close line was found (unclosed claims run to EOF)
  framed: boolean // closed with BOTH structural LFs (OPEN\nCLOSE is claimed, unframed)
  canonical: boolean // framed AND writer-canonical (decode/re-encode equality)
  value: string | null // decoded body text, present iff canonical
}

export type InertScan = {
  grammarText: string // the one view every grammar consumer receives
  candidates: InertCandidate[]
}

// the one outermost-owner scan (the landed v1 shape, new-only): first recognized opener
// owns its region -- an inert opener inside _log|_output is ignored (that grammar's
// loose close applies), while _log|_output openers inside a claimed inert region stay
// body (exact-close rule). markers are COLLISION-FREE against the lexical source under
// ONE namespace allocation (the smallest k whose marker prefix is absent from the raw
// text); each source is scanned separately.
export function scanInert(text: string): InertScan {
  let k = 0
  while (text.includes(`⟦${RESULT_FENCE}:${k}:`)) k++
  const lines = text.split('\n')
  const out: string[] = []
  const candidates: InertCandidate[] = []
  let state: 'plain' | 'log' | 'inert' = 'plain'
  let region: string[] = []
  let regionStart = 0
  let offset = 0 // UTF-16 code-unit offset of the current line's first character
  const finish = (closed: boolean, end: number) => {
    const marker = `⟦${RESULT_FENCE}:${k}:${candidates.length}⟧`
    const source = region.join('\n')
    const framed = closed && region.length >= 3 // opener + >=1 body line + close
    const value = framed ? decodeInertSource(source) : null
    candidates.push({
      marker,
      source,
      start: regionStart,
      end,
      closed,
      framed,
      canonical: value !== null,
      value,
    })
    out.push(marker)
    region = []
  }
  for (const line of lines) {
    if (state === 'inert') {
      region.push(line)
      if (line === INERT_CLOSE) {
        state = 'plain'
        finish(true, offset + line.length)
      }
    } else if (state === 'log') {
      out.push(line)
      if (LOG_CLOSE.test(line)) state = 'plain'
    } else if (line === INERT_OPEN) {
      state = 'inert'
      region.push(line)
      regionStart = offset
    } else if (LOG_OPEN.test(line)) {
      state = 'log'
      out.push(line)
    } else {
      out.push(line)
    }
    offset += line.length + 1 // the split LF
  }
  if (state === 'inert') finish(false, text.length)
  return { grammarText: out.join('\n'), candidates }
}

// fixed placeholder for a claimed candidate WITHOUT a value (unclosed, unframed, or
// noncanonical) -- assigned only via textContent, exactly like the v1 placeholder
export const INVALID_INERT_REGION = '⟦invalid inert region⟧'
