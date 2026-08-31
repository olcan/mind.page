import { expect, test } from '@playwright/test'

import _ from 'lodash'

// parseTags (reached by isVaultRouted via util.js) reads the browser globals `_`
// (lodash) and `window._shortcut_hosts` at call time; stub both before the imports
;(globalThis as any)._ = _
;(globalThis as any).window = { _shortcut_hosts: [] }

import {
  INERT_CLOSE,
  INERT_OPEN,
  containsOpaqueMarker,
  decodeInertSource,
  inertCandidateSpan,
  editInertText,
  encodeInert,
  escapeInertBody,
  isVaultRouted,
  scanInert,
  unescapeInertBody,
} from '../../src/inert.js'

// the new-only inert scanner/codec (bridge reviews 177-178): exact standalone marker
// lines, first-exact-close claiming, k -> k+1 close escape, framed/canonical states,
// UTF-16 half-open ranges, retained marker prefix, _log|_output outer ownership.
// Python twin vectors live in tests/test_mindpage_inert.py in the vault.

// the review-178 §2.2 escape vectors, identical to the python table
const ESCAPE_VECTORS: [string, string][] = [
  ['<!--/inert-->', '<!--\\/inert-->'], // k=0 -> 1
  ['<!--\\/inert-->', '<!--\\\\/inert-->'], // k=1 -> 2
  ['<!--\\\\/inert-->', '<!--\\\\\\/inert-->'], // k=2 -> 3
  ['<!--/inert--><!--\\/inert-->', '<!--\\/inert--><!--\\\\/inert-->'], // adjacent
  ['', ''],
  ['\n', '\n'],
  ['\nleading and trailing\n', '\nleading and trailing\n'],
  [INERT_OPEN, INERT_OPEN], // openers are never escaped (nested openers are body)
  ['plain <!-- comment --> text', 'plain <!-- comment --> text'],
]

test('escape is the exact injective map and round-trips over the full extent', () => {
  for (const [text, escaped] of ESCAPE_VECTORS) {
    expect(escapeInertBody(text)).toBe(escaped)
    expect(unescapeInertBody(escaped)).toBe(text)
    const region = encodeInert(text)
    expect(region).toBe(`${INERT_OPEN}\n${escaped}\n${INERT_CLOSE}`)
    expect(decodeInertSource(region)).toBe(text)
  }
})

test('empty and one-LF bodies stay distinct via the structural LFs', () => {
  expect(encodeInert('')).toBe(`${INERT_OPEN}\n\n${INERT_CLOSE}`)
  expect(encodeInert('\n')).toBe(`${INERT_OPEN}\n\n\n${INERT_CLOSE}`)
  expect(decodeInertSource(`${INERT_OPEN}\n\n${INERT_CLOSE}`)).toBe('')
  expect(decodeInertSource(`${INERT_OPEN}\n\n\n${INERT_CLOSE}`)).toBe('\n')
})

test('decode rejects unframed and noncanonical sources', () => {
  // OPEN\nCLOSE: the single LF cannot serve as both structural LFs
  expect(decodeInertSource(`${INERT_OPEN}\n${INERT_CLOSE}`)).toBeNull()
  expect(decodeInertSource(`${INERT_OPEN}\nbody`)).toBeNull() // no close at all
  expect(decodeInertSource(` ${INERT_OPEN}\nbody\n${INERT_CLOSE}`)).toBeNull() // indented
  // the review-178 §2.1 counterexample: inline bare close-shaped occurrence is framed
  // but NOT writer-canonical (encode would have escaped it)
  expect(decodeInertSource(`${INERT_OPEN}\nleading <!--/inert--> trailing\n${INERT_CLOSE}`)).toBeNull()
})

test('encoder rejects lone surrogates (unicode-scalar input domain)', () => {
  expect(() => encodeInert('bad \uD800 text')).toThrow('lone surrogate')
  expect(encodeInert('paired \u{1f680} ok')).toContain('\u{1f680}') // scalars pass
})

test('a lone-surrogate source is not canonical (writer-image membership)', () => {
  // review 179 §1: a source the writer cannot produce must not decode, and the
  // scanner must claim it closed+framed with canonical=false and no value
  const source = `${INERT_OPEN}\n\uD800\n${INERT_CLOSE}`
  expect(decodeInertSource(source)).toBeNull()
  const { candidates } = scanInert(source)
  expect(candidates).toHaveLength(1)
  expect(candidates[0].closed && candidates[0].framed).toBe(true)
  expect(candidates[0].canonical).toBe(false)
  expect(candidates[0].value).toBeNull()
})

test('spoiled closers are body; only the exact close line ends the region', () => {
  // 179 §3.1 backfill: indented and trailing-space would-be closers do not close
  for (const spoiled of [` ${INERT_CLOSE}`, `${INERT_CLOSE} `]) {
    const text = `${INERT_OPEN}\n${spoiled}\nreal\n${INERT_CLOSE}\nafter`
    const { grammarText, candidates } = scanInert(text)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].closed).toBe(true)
    expect(candidates[0].source).toBe(`${INERT_OPEN}\n${spoiled}\nreal\n${INERT_CLOSE}`)
    expect(grammarText).toBe(`${candidates[0].marker}\nafter`)
  }
})

test('scan claims to first exact close, mints markers, reports exact ranges', () => {
  const text = `before\n${INERT_OPEN}\nbody line\n${INERT_CLOSE}\nafter`
  const { grammarText, candidates } = scanInert(text)
  expect(candidates).toHaveLength(1)
  const candidate = candidates[0]
  expect(candidate.closed && candidate.framed && candidate.canonical).toBe(true)
  expect(candidate.value).toBe('body line')
  expect(candidate.source).toBe(`${INERT_OPEN}\nbody line\n${INERT_CLOSE}`)
  // half-open UTF-16 range over the exact scanned string (178 §2.2): slice equality,
  // opener through close, excluding the following LF
  expect(text.slice(candidate.start, candidate.end)).toBe(candidate.source)
  expect(text[candidate.end]).toBe('\n')
  expect(grammarText).toBe(`before\n${candidate.marker}\nafter`)
})

test('ranges disambiguate repeated identical regions after an astral prefix', () => {
  // an astral character before two byte-identical regions (178 §2.2): offsets are
  // UTF-16 code units, so the surrogate pair counts as two
  const region = `${INERT_OPEN}\nsame\n${INERT_CLOSE}`
  const text = `\u{1f680}\n${region}\nmid\n${region}`
  const { candidates } = scanInert(text)
  expect(candidates).toHaveLength(2)
  expect(candidates[0].source).toBe(region)
  expect(candidates[1].source).toBe(region)
  expect(candidates[0].start).not.toBe(candidates[1].start)
  for (const candidate of candidates)
    expect(text.slice(candidate.start, candidate.end)).toBe(candidate.source)
  expect(candidates[0].start).toBe(3) // astral pair (2 code units) + LF
})

test('strictness: indented or cr-tainted markers are live text', () => {
  for (const spoiled of [` ${INERT_OPEN}`, `${INERT_OPEN} `, `${INERT_OPEN}\r`]) {
    const { grammarText, candidates } = scanInert(`${spoiled}\nbody`)
    expect(candidates).toHaveLength(0)
    expect(grammarText).toBe(`${spoiled}\nbody`)
  }
  // a CR-tainted would-be close inside a claimed region does not close it
  const text = `${INERT_OPEN}\n${INERT_CLOSE}\r\nreal body\n${INERT_CLOSE}`
  const { candidates } = scanInert(text)
  expect(candidates).toHaveLength(1)
  expect(candidates[0].closed).toBe(true)
  expect(candidates[0].canonical).toBe(false) // the CR line is a residual bare close
})

test('nested opener is body; unclosed claims to EOF with end === text.length', () => {
  const nested = `${INERT_OPEN}\n${INERT_OPEN}\nx\n${INERT_CLOSE}`
  expect(scanInert(nested).candidates).toHaveLength(1)
  expect(scanInert(nested).candidates[0].source).toBe(nested)
  const unclosed = `top\n${INERT_OPEN}\ndangling`
  const { grammarText, candidates } = scanInert(unclosed)
  expect(candidates).toHaveLength(1)
  expect(candidates[0].closed).toBe(false)
  expect(candidates[0].value).toBeNull()
  expect(candidates[0].end).toBe(unclosed.length)
  expect(unclosed.slice(candidates[0].start, candidates[0].end)).toBe(candidates[0].source)
  expect(grammarText).toBe(`top\n${candidates[0].marker}`)
})

test('unframed close is claimed without a value', () => {
  const { candidates } = scanInert(`${INERT_OPEN}\n${INERT_CLOSE}`)
  expect(candidates).toHaveLength(1)
  expect(candidates[0].closed).toBe(true)
  expect(candidates[0].framed).toBe(false)
  expect(candidates[0].value).toBeNull()
})

test('outermost-owner composition with _log|_output blocks (bytes preserved)', () => {
  // log owns first: an inert opener inside _log is body (this side preserves bytes)
  const logFirst = `\`\`\`_log\n${INERT_OPEN}\n\`\`\`\nafter`
  const logScan = scanInert(logFirst)
  expect(logScan.candidates).toHaveLength(0)
  expect(logScan.grammarText).toBe(logFirst)
  // the 178 §2.3 legacy trap, pinned: inside _log|_output ANY ``` line is the LOOSE
  // close -- a suffixed fence ends the log region, and the inert opener after it claims
  const loose = `\`\`\`_log\nx\n\`\`\`js_input\n${INERT_OPEN}\ny\n${INERT_CLOSE}`
  const looseScan = scanInert(loose)
  expect(looseScan.candidates).toHaveLength(1)
  expect(looseScan.candidates[0].value).toBe('y')
  expect(looseScan.grammarText).toBe(
    `\`\`\`_log\nx\n\`\`\`js_input\n${looseScan.candidates[0].marker}`
  ) // bytes preserved on this side; the loose close still ended log ownership
  // inert owns first: a _log opener inside a claimed region stays body
  const inertFirst = `${INERT_OPEN}\n\`\`\`_log\n${INERT_CLOSE}\nafter`
  const inertScan = scanInert(inertFirst)
  expect(inertScan.candidates).toHaveLength(1)
  expect(inertScan.candidates[0].source).toBe(`${INERT_OPEN}\n\`\`\`_log\n${INERT_CLOSE}`)
  expect(inertScan.grammarText).toBe(`${inertScan.candidates[0].marker}\nafter`)
})

test('marker namespace avoids collisions and keeps the retained prefix', () => {
  const text = `⟦vault_result_v1:0:\n${INERT_OPEN}\nx\n${INERT_CLOSE}`
  const { candidates } = scanInert(text)
  expect(candidates[0].marker).toBe('⟦vault_result_v1:1:0⟧')
})

test('crlf text forms no regions', () => {
  const crlf = `${INERT_OPEN}\r\nbody\r\n${INERT_CLOSE}\r\n`
  const { grammarText, candidates } = scanInert(crlf)
  expect(candidates).toHaveLength(0)
  expect(grammarText).toBe(crlf)
})

test('containsOpaqueMarker is the one containment predicate', () => {
  expect(containsOpaqueMarker('plain text')).toBe(false)
  expect(containsOpaqueMarker('x ⟦vault_result_v1:0:0⟧ y')).toBe(true)
  const { grammarText } = scanInert(`${INERT_OPEN}\nbody\n${INERT_CLOSE}`)
  expect(containsOpaqueMarker(grammarText)).toBe(true) // generated markers are caught
})

test('editInertText: retain, drop, reject duplicate/unsafe move/minted region', () => {
  const region = encodeInert('reply')
  const raw = `a\n${region}\nb`
  // retain via whole-line reorder between plain positions
  const reordered = editInertText(raw, g => {
    const [first, marker, last] = g.split('\n')
    return [last, marker, first].join('\n')
  })
  expect(reordered).toBe(`b\n${region}\na`)
  // drop requires allowDrop
  expect(() => editInertText(raw, g => g.split('\n').filter(l => !l.startsWith('⟦')).join('\n'))).toThrow('dropped')
  expect(editInertText(raw, g => g.split('\n').filter(l => !l.startsWith('⟦')).join('\n'), { allowDrop: true })).toBe(
    'a\nb'
  )
  // duplicate marker rejected
  expect(() => editInertText(raw, g => g + '\n' + g.split('\n')[1])).toThrow('duplicated')
  // moving the marker under a log opener unclaims the restored bytes
  expect(() => editInertText(raw, g => '```_log\n' + g)).toThrow('claimable')
  // transforms cannot MINT regions (179 §2.3 / the landed postcondition): a new inert
  // region introduced by the transform makes the fresh scan claim more than retained
  expect(() => editInertText(raw, g => g + '\n' + encodeInert('minted'))).toThrow('claimable')
})

test('inertCandidateSpan: classed escaped sources with exact textContent', () => {
  // the 178 §4.2 vectors at the span level (the editor's line loop emits these
  // structurally -- the browser witness proves the wiring): hostile html, astral,
  // ZWSP, repeated candidates; textContent reconstruction is exact per span
  const hostile = encodeInert('<script>alert(1)</script> & "quotes" <img onerror=x>')
  const zwsp = 'https://example.com/very​long​url'
  const text = `\u{1f680} ${zwsp}\n${hostile}\nmid\n${hostile}\n${INERT_OPEN}\nunclosed`
  const scan = scanInert(text)
  expect(scan.candidates).toHaveLength(3)
  const spans = scan.candidates.map(inertCandidateSpan)
  expect(spans[0]).toContain('class="inert-region"') // canonical: dimmed
  expect(spans[2]).toContain('class="inert-region inert-invalid"') // unclosed: warning
  for (const span of spans) expect(span).not.toContain('<script>') // escaped hostile
  // numeric-entity escaping: immune to the editor's later `&lt;`-matching passes
  expect(spans[0]).not.toContain('&lt;')
  const textContent = (span: string, i: number) => {
    const inner = span.replace(/<span[^>]*>/, '').replace(/<\/span>$/, '')
    const decoded = inner.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(+code))
    expect(decoded, `span ${i} textContent is the exact source`).toBe(scan.candidates[i].source)
  }
  spans.forEach((span, i) => textContent(span, i))
})

test('isVaultRouted: exact roots and descendants over the INERT grammar view', () => {
  expect(isVaultRouted('#agent/vault\nhello')).toBe(true)
  expect(isVaultRouted('#_agent/vault/opus\nhello')).toBe(true)
  expect(isVaultRouted('#agent/vaultish\nhello')).toBe(false) // slash boundary
  expect(isVaultRouted('note about #agent/openai')).toBe(false)
  // a route inside a CLAIMED region is invisible (the grammar view sees a marker)
  expect(isVaultRouted(`${INERT_OPEN}\n#agent/vault\n${INERT_CLOSE}`)).toBe(false)
  // a route inside an UNCLOSED region is equally claimed to EOF
  expect(isVaultRouted(`${INERT_OPEN}\n#agent/vault`)).toBe(false)
})
