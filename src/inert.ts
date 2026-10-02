// Inert-region scanner + wire codec (bridge reviews 177-180): THE app grammar module.
// The readable successor to the vault_result_v1 base64 envelope; the TypeScript v1 path
// (vault_result.ts) is deleted and every app seam (render, editor, edit, routing,
// capability) consumes this module. Python twin: the vault's lib/mindpage_inert.py;
// parity vectors are pinned in both suites. LIVE since the 2026-08-31 attended
// cutover (design §2.2a): production replies are stored as inert regions.
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

// the app's global tag parser (untyped util.js; the app tsconfig is non-strict and the
// tests tsconfig needs the suppression, as in src/vault_result.ts)
// @ts-ignore
import { parseTags, prepareBlocks, removeSections, removeRemovedBlocks } from './util.js'
import { Marked, type Token, type Tokens } from 'marked'

// markers keep the existing ephemeral v1-named prefix (178 §2.2): the token is never
// persisted, and retaining it keeps the already-loaded stored-consumer marker refusals
// effective across cutover skew. OWNED LOCALLY (179 §3.2): a literal, not an import from
// the v1 module (v1 code is retired in a separate post-canary cleanup, review 184 §2.5).
const MARKER_FENCE = 'vault_result_v1'

export const INERT_OPEN = '<!--inert-->'
export const INERT_CLOSE = '<!--/inert-->'

// every close-shaped occurrence: `<!--` + k backslashes + `/inert-->` (178 §2.2);
// applied anywhere in the body, not only line-anchored -- one uniform rule
const CLOSE_SHAPED = /<!--(\\*)\/inert-->/g

// the app's _log|_output opener grammar, carried over VERBATIM from the deleted v1
// module vault_result.ts (178 §2.3): this scanner composes with the same landed
// _log|_output ownership -- ownership only, bytes preserved
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
  while (text.includes(`⟦${MARKER_FENCE}:${k}:`)) k++
  const lines = text.split('\n')
  const out: string[] = []
  const candidates: InertCandidate[] = []
  let state: 'plain' | 'log' | 'inert' = 'plain'
  let region: string[] = []
  let regionStart = 0
  let offset = 0 // UTF-16 code-unit offset of the current line's first character
  const finish = (closed: boolean, end: number) => {
    const marker = `⟦${MARKER_FENCE}:${k}:${candidates.length}⟧`
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

// the ephemeral grammar-marker pattern. Item's Marked extension matches these tokens so
// MARKED ITSELF decides placement (reviews 182-183): a marker Marked lexes in an ordinary
// INLINE context (top-level paragraph, list paragraph, blockquote, heading, table cell)
// becomes a dead-frame span, while a marker Marked lexes inside a CODE token is shown as
// the fixed INERT_FENCED_PLACEHOLDER (the trusted publisher's shape is top-level) -- no fence
// prediction. The pattern is anchored for a tokenizer's `^` match; callers needing a
// global scan build their own /g copy.
export const INERT_MARKER_SOURCE = `⟦${MARKER_FENCE}:\\d+:\\d+⟧`

// CHILD-TAG REGIONS (vault design mind_chat_children 2.2, revision 7): the canonical regions
// whose `#/name` tokens count as the item's child tags AND render as marks, decided by ONE rule
// over the grammar text that the index (itemTextChanged) and the renderer (toHTML) both apply,
// and ENFORCED by the renderer where the rule admits a region. The rule admits exactly the
// publisher's shape: a canonical region whose marker line DIRECTLY follows a CHAT BOUNDARY, an
// `<<agent(...)>>` delimiter line alone (a reply's opener, a child's stored shape) outside a
// fenced code block. The renderer prefixes the expansion of a delimiter the rule admits a region
// after (the chat template's `_html` block) with the RESET line below and a blank line, on lines
// of their own (chatResetOffsets; the rule itself reads every boundary as reset): the reset, ONE
// comment, ends a comment the owner left open before the reply (its `-->`), a declaration (its
// `>`) and the app's removed section (the removed pass that runs after expansion ends a section at
// this line); the blank line ends an html block of kinds 6-7, a paragraph or a list. Unmatched,
// the comment is invisible; inside an open comment or declaration, its text is theirs. The rule
// then reads the text AS THE RENDERER'S BLOCK PASSES LEAVE IT (src/util.js prepareBlocks and
// removeSections, the renderer's own functions, applied to the text with the resets in place)
// WITH THE INSTALLED MARKED: a region counts when its boundary line opens a paragraph of that
// text (not code, not an html block: the fence grammar and the html block kinds exactly as the
// renderer's own lexer reads them; a processing instruction or a CDATA section left open is such
// a block to its end, so a reply inside one is DECLINED, never healed: the reset's text would show
// after the browser's own end of the bogus comment) and no raw-text element of the browser is open
// before it (the html tokens so far read tag by tag, the app's static `_html` blocks among them,
// which the renderer emits raw, by the first word of their info string as marked-highlight reads
// it: a `<textarea>` or an `<xmp>` would show any reset as its text, so
// an open raw-text element is DECLINED too, the reply staying swallowed and untagged, as the
// publisher never writes one there). So a removed section that ate a fence's or a comment's
// closing line (the removed pass reads no fence of tildes and no comment), an `_md` block whose
// unwrapped content opens a fence, a closing fence with a trailing tab (no closer to Marked)
// leave the reply unframed AND untagged. Every other placement (after a blank line, after prose,
// after `<<user>>`, inside a fence, an `_md` fence the renderer unwraps, an html block, a link
// label) carries no child tags and renders no marks, framed or not. The owner's text is never
// scanned for tag-shaped content (review 4 R3): inline code or an escape in a question cannot
// disable the feature. Outside the rule's reading, by design: a macro's expansion (the publisher
// writes none before a reply; the delimiters' own expansion is the block the reset precedes).
export const AGENT_LINE = /^<<agent\b[^\n]*>>\s*$/
export const CHAT_BOUNDARY_RESET = '<!--/removed-->'
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
// the html blocks of kinds 1-5: a start at a line start, the end condition met on the start
// line or any later one
const HTML_BLOCKS: [RegExp, RegExp][] = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
]
// the line indices of a grammar text's chat boundaries: the `<<agent(...)>>` lines alone
// outside a fence, read as the installed Marked reads a fence (an opener of three or more
// backticks without a backtick in its info string, or tildes; the closer the same string, more
// fence characters allowed, then SPACES alone: a trailing tab keeps the fence open) with the html
// blocks of kinds 1-5 read at a line start, so a fence-looking line inside one is text; a
// boundary inside such a block counts (the renderer's reset ends a comment-like block there, and
// the second reading in childTagRegions decides what Marked makes of it)
export function chatBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>()
  let fence: RegExp | null = null // the open fence's closer
  let blockEnd: RegExp | null = null
  text.split('\n').forEach((line, index) => {
    if (fence) {
      if (fence.test(line)) fence = null
      return
    }
    if (blockEnd) {
      if (blockEnd.test(line)) blockEnd = null
    } else {
      const open = FENCE_OPEN.exec(line)
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        fence = new RegExp('^ {0,3}' + open[1] + '[~`]* *$') // Marked's closer: \\1[~`]* *(?=\\n|$)
        return
      }
      for (const [start, end] of HTML_BLOCKS) {
        const at = start.exec(line)
        if (!at) continue
        if (!end.test(line.slice(at[0].length))) blockEnd = end
        break
      }
    }
    if (AGENT_LINE.test(line)) boundaries.add(index)
  })
  return boundaries
}
// the boundaries the renderer resets, as the character offsets of their line starts (its macro
// pass sees offsets into the grammar text): those directly followed by an ADMITTED region (the
// markers childTagRegions returns), so the reset precedes exactly the replies that carry marks;
// a boundary the renderer's own passes move into code (an unwrapped `_md` block opening a tilde
// fence) gets none and shows no reset text beside the reply's own source
export function chatResetOffsets(grammarText: string, admitted: Set<string>): Set<number> {
  const offsets = new Set<number>()
  if (!admitted.size) return offsets
  const boundaries = chatBoundaries(grammarText)
  const lines = grammarText.split('\n')
  let offset = 0
  lines.forEach((line, index) => {
    if (boundaries.has(index) && index + 1 < lines.length && admitted.has(lines[index + 1])) offsets.add(offset)
    offset += line.length + 1
  })
  return offsets
}
// an html token's raw text read TAG BY TAG for the raw-text element it leaves open (`names`):
// inside an open element only its own end tag counts (its content is text, comments included);
// outside, a comment is skipped whole and a complete tag (quoted attribute values honored: an
// end tag spelled inside an attribute is no end tag) opens an element of the set; a lone `<` is
// text. An unclosed comment makes the rest of the token comment text.
const HTML_TAG = /<(\/?)([A-Za-z][\w:-]*)(?:\s+[^\s"'=<>`\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/y // sticky: a tag AT the `<`, no search ahead (review 6: a forward search re-read the token's remainder at every `<` of comparison text)
export function rawElementState(raw: string, open: string | null, names: RegExp): string | null {
  let i = 0
  while (i < raw.length) {
    if (open) {
      const close = new RegExp('</' + open + '(?=[\\s>/]|$)', 'ig')
      close.lastIndex = i
      const m = close.exec(raw)
      if (!m) return open
      open = null
      i = m.index + m[0].length
      continue
    }
    const lt = raw.indexOf('<', i)
    if (lt < 0) return null
    if (raw.startsWith('<!--', lt)) {
      const end = raw.indexOf('-->', lt + 4)
      if (end < 0) return null
      i = end + 3
      continue
    }
    HTML_TAG.lastIndex = lt
    const m = HTML_TAG.exec(raw)
    if (m) {
      if (!m[1] && names.test(m[2])) open = m[2].toLowerCase()
      i = lt + m[0].length
      continue
    }
    i = lt + 1
  }
  return open
}
// the raw-text elements of a browser: their content is text until their own end tag
const BROWSER_RAW = /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)$/i
// the raw-text state after a token tree, in document order (an image's label is discarded by the
// renderers and skipped)
function rawStateAfter(tokens: Token[], open: string | null, names: RegExp): string | null {
  for (const token of tokens) {
    const t = token as Tokens.Generic
    if (t.type === 'image') continue
    if (t.type === 'html') {
      open = rawElementState(String(t.raw), open, names)
      continue
    }
    // the app's static `_html(_*)` blocks are raw html to the item renderer (emitted unescaped,
    // their code wrapper unwrapped), by the language marked-highlight hands it: the info string's
    // first word (reviews 6-7; a backtick `*_removed` block is gone from the prepared text already,
    // a tilde one is live, as the renderer has it)
    if (t.type === 'code') {
      const lang = String(t.lang ?? '').match(/\S*/)![0]
      if (/^_html(?:_|$)/.test(lang)) open = rawElementState(String(t.text), open, names)
      continue
    }
    if (Array.isArray(t.tokens)) open = rawStateAfter(t.tokens, open, names)
    if (Array.isArray(t.items)) open = rawStateAfter(t.items, open, names)
    if (Array.isArray(t.header)) open = rawStateAfter(t.header, open, names)
    if (Array.isArray(t.rows)) for (const row of t.rows) open = rawStateAfter(row, open, names)
  }
  return open
}
let plain: Marked | null = null
export function childTagRegions(scan: InertScan): Set<string> {
  const eligible = new Set<string>()
  const canonical = new Set(scan.candidates.filter(c => c.canonical).map(c => c.marker))
  if (!canonical.size) return eligible
  const boundaries = chatBoundaries(scan.grammarText)
  if (!boundaries.size) return eligible
  // the text as the renderer's block passes leave it: the reset and the blank line before each
  // boundary (the macro pass's prefix; the delimiter line stands for the block it expands to),
  // then the renderer's own passes
  const withResets = scan.grammarText
    .split('\n')
    .map((line, index) => (boundaries.has(index) ? CHAT_BOUNDARY_RESET + '\n\t\n' + line : line))
    .join('\n')
  const prepared: string = removeRemovedBlocks(removeSections(prepareBlocks(withResets)))
  // the second reading, by the installed Marked: a boundary line (an agent line behind its blank
  // line, which a removed section leaves in place) admits the region after it when it opens a
  // paragraph and no raw-text element is open before it; the line a token starts on is the count
  // of newlines in the raw text before it (the source for the constructs here; a lone CR, or a
  // duplicate reference definition with a multiline url or title, can shift the count and leave
  // an ordinary framed reply untagged: a recorded limitation, as the inert renderer's)
  const lines = prepared.split('\n')
  const admitted = new Set<number>()
  plain ??= new Marked({ gfm: true, breaks: true })
  let line = 0
  let open: string | null = null
  for (const token of plain.lexer(prepared)) {
    const t = token as Tokens.Generic
    const raw = String(t.raw)
    if (t.type === 'paragraph' && !open && AGENT_LINE.test(lines[line] ?? '') && lines[line - 1] === '\t') admitted.add(line)
    open = rawStateAfter([token], open, BROWSER_RAW)
    line += raw.split('\n').length - 1
  }
  lines.forEach((text, index) => {
    if (admitted.has(index - 1) && canonical.has(text)) eligible.add(text)
  })
  return eligible
}

// fixed placeholder for a claimed candidate WITHOUT a value (unclosed, unframed, or
// noncanonical) -- assigned only via textContent, exactly like the v1 placeholder
export const INVALID_INERT_REGION = '⟦invalid inert region⟧'

// fixed SAFE TEXT substituted for a claimed region whose marker Marked lexes inside a
// CODE token (reviews 180-184 §1.1): Marked escapes html there, so a dead-frame element
// cannot materialize -- a region in ordinary inline flow gets the readable dead frame,
// a region in code gets this fixed non-leaking text. Grammar opacity is global either
// way (the bytes stay claimed regardless of placement).
export const INERT_FENCED_PLACEHOLDER = '⟦inert region⟧'

// SEARCH view (owner bug 2026-08-31; reviews 188 §2.2 + 189 §2.1): the grammar text
// with each of THIS render's markers replaced by its decoded value AT ITS POSITION,
// lowercased ONCE at the end -- for term/regex matching only, never parsing. ONE
// regex-callback pass over the CASE-PRESERVING text makes it collision-safe: an
// owner-typed uppercase lookalike cannot case-fold into a marker (the pattern is
// lowercase and the text is not folded before the pass), and callback output is never
// rescanned (a decoded value that happens to be marker-shaped stays literal).
export function inertSearchText(grammarText: string, values: Map<string, string>): string {
  return grammarText
    .replace(new RegExp(INERT_MARKER_SOURCE, 'g'), marker => values.get(marker) ?? marker)
    .toLowerCase()
}

// the centralized opaque-marker containment predicate (178 §5.1): whether TEXT (a whole
// embed/caption/body capture, not one token) contains any generated grammar marker.
// stored consumers call this through the versioned capability object instead of the
// eight historical literal `⟦vault_result_v1:` checks.
export function containsOpaqueMarker(text: string): boolean {
  return text.includes(`⟦${MARKER_FENCE}:`)
}

// restore raw candidate sources into a text whose candidate ranges are still markers
function restoreInertCandidates(text: string, candidates: InertCandidate[]): string {
  for (const candidate of candidates)
    if (text.includes(candidate.marker)) text = text.replace(candidate.marker, () => candidate.source)
  return text
}

// the bounded source-preserving edit seam over INERT regions -- the successor of
// editVaultText with the identical contract (design §2.3, reviews 148-149, carried
// forward per 178): the transform runs over the grammar view, exact raw sources are
// restored per retained marker, duplicates are rejected, drops are rejected unless
// `allowDrop`, and a fresh-scan postcondition rejects any move that unclaims restored
// bytes -- which also means transforms cannot MINT new regions (the fresh scan would
// claim more sources than were retained).
export function editInertText(
  rawText: string,
  transform: (grammarText: string) => string,
  { allowDrop = false }: { allowDrop?: boolean } = {}
): string {
  const scan = scanInert(rawText)
  const transformed = transform(scan.grammarText)
  const occurrences = (text: string, marker: string) => text.split(marker).length - 1
  for (const candidate of scan.candidates) {
    const count = occurrences(transformed, candidate.marker)
    if (count > 1) throw new Error('inert edit duplicated a region')
    if (count === 0 && !allowDrop) throw new Error('inert edit dropped a region')
  }
  const restored = restoreInertCandidates(transformed, scan.candidates)
  const retained = scan.candidates
    .filter(candidate => occurrences(transformed, candidate.marker) === 1)
    .map(candidate => candidate.source)
    .sort()
  const claimed = scanInert(restored)
    .candidates.map(candidate => candidate.source)
    .sort()
  if (retained.length !== claimed.length || retained.some((source, i) => source !== claimed[i]))
    throw new Error('inert edit moved a region out of a claimable position')
  return restored
}

// minimal html escape for decorated candidate sources (no lodash dependency here)
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

// EDITOR BACKDROP DECORATION (178 §4.2 as corrected by 180 §1.2): one classed span
// per candidate, emitted STRUCTURALLY by the editor's line loop in place of the marker
// line -- never by post-hoc replacement over highlighted html, where highlight.js
// tokenizes markers into fragments. NORMAL/dimmed for canonical candidates; WARNING for
// every claimed candidate without a value (unclosed EOF, missing structural LF,
// noncanonical escape spelling) -- all objectively known from the scanner; no
// early-close detector (178 §3). The span's textContent is exactly candidate.source,
// and the NUMERIC entity escaping keeps the content immune to the editor's later
// entity-matching section/delimiter regex passes (they match `&lt;`, never `&#60;`).
export function inertCandidateSpan(candidate: InertCandidate): string {
  const cls = candidate.value !== null ? 'inert-region' : 'inert-region inert-invalid'
  return `<span class="${cls}">${escapeHtml(candidate.source)}</span>`
}

// the browser routing predicate over the INERT grammar view -- the successor of the v1
// isVaultRouted with the identical roots table and fail-closed semantics (design §2.1):
// computed from the scanner's grammar view with the app's global tag parser, never
// resolved item state, so a route inside a claimed region is invisible.
// (the legacy #agent/native root retired 2026-09-18 with the bridge's alias: no item under it remains)
const VAULT_ROOTS = ['#agent/vault', '#_agent/vault']
export function isVaultRouted(rawText: string): boolean {
  const tags: string[] = (parseTags(scanInert(rawText).grammarText.toLowerCase()) as { raw: string[] }).raw
  return tags.some(tag => VAULT_ROOTS.some(root => tag === root || tag.startsWith(root + '/')))
}
