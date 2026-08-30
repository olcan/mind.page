import { expect, test } from '@playwright/test'
import _ from 'lodash'

// parseTags (reached by isVaultRouted via util.js) reads the browser globals `_` (lodash)
// and `window._shortcut_hosts` at call time; stub both before the imports below
;(globalThis as any)._ = _
;(globalThis as any).window = { _shortcut_hosts: [] }

import {
  associateVaultResults,
  decodeResultBody,
  editVaultText,
  encodeResult,
  formatFooter,
  isVaultRouted,
  scanVaultResults,
  FOOTER_NAME,
} from '../../src/vault_result.js'

// the vault-result security boundary (bridge design §2.2-2.3, reviews 138-142): scanner
// claims, bare-only close, canonical-shape bit, collision-free markers, outermost
// composition, strict body decode, and pre-transform lexical association. Python twin
// vectors live in tests/test_mindpage_codec.py in the vault.

test('decodeResultBody is the strict twin of the python codec', () => {
  expect(decodeResultBody('aGVsbG8gdmF1bHQ=')).toBe('hello vault')
  expect(decodeResultBody('')).toBe('')
  // cross-language parity vector whose base64 exercises + and / and == padding
  const parity = encodeResult('ÿþ?>~é\u{1f680}')
  expect(parity.split('\n')[1]).toBe('w7/Dvj8+fsOp8J+agA==')
  expect(decodeResultBody('w7/Dvj8+fsOp8J+agA==')).toBe('ÿþ?>~é\u{1f680}')
  // BOM parity (review 142 §2.5): U+FEFF is PRESERVED as text, matching python
  expect(decodeResultBody('77u/YQ==')).toBe('﻿a')
  // lone surrogates are REJECTED by the encoder, matching python's raise
  expect(() => encodeResult('bad \ud800 surrogate')).toThrow()
  for (const bad of [
    'aGVsbG8gdmF1bHQ', // unpadded
    'aGVsbG8gdmF1bHR=', // nonzero pad bits: decodes, re-encodes differently
    'aGVs bG8=', // inner whitespace
    ' aGVsbG8=', // leading whitespace
    'aGVsbG8=\nZg==', // multiline
    'aGVsbG8*', // invalid alphabet
  ])
    expect(decodeResultBody(bad), bad).toBeNull()
})

test('the claim runs to the first BARE-ONLY fence; suffixed fences are body', () => {
  // review 141 §2.1: a nested js_input opener must NOT terminate the claim -- its body
  // (macro, script, input block) stays claimed, invisible to every grammar consumer
  const hostile = [
    '#topic',
    '<<user>> q',
    '```vault_result_v1',
    'not base64 at all',
    '```js_input',
    '<<window._pwned=1>> <script>window._pwned=2</script> #_autorun',
    '```', // first BARE fence: this ends the claim (the js_input line did not)
    'after',
  ].join('\n')
  const scan = scanVaultResults(hostile)
  expect(scan.candidates.length).toBe(1)
  expect(scan.candidates[0].closed).toBe(true)
  expect(scan.candidates[0].canonical).toBe(false) // multiple body lines
  expect(scan.candidates[0].value).toBeNull()
  expect(scan.candidates[0].body).toContain('_pwned') // hostile bytes are CLAIMED
  expect(scan.grammarText).not.toContain('_pwned') // ...and invisible to grammar
  expect(scan.grammarText).not.toContain('js_input')
  expect(scan.grammarText).not.toContain('#_autorun')
  expect(scan.grammarText).toContain('after') // text after the bare close survives
  expect(scan.grammarText).toContain(scan.candidates[0].marker)
})

test('canonical shape requires literal lines and exactly one body line', () => {
  // review 142 §2.1: whitespace-decorated opener/close and zero-body envelopes are
  // claimed (opaque) but NEVER canonical, so association rejects them
  const agent = "<<agent('" + formatFooter('default', 'ab12cd34', 42, 0.12) + "')>>"
  const canonical = (candidateText: string) => {
    const scan = scanVaultResults('#t\n<<user>> q\n' + agent + '\n' + candidateText)
    const assoc = associateVaultResults(scan.grammarText, scan.candidates)
    return { candidate: scan.candidates[0], valid: assoc[0]?.valid ?? null }
  }
  // exact nonempty
  expect(canonical(encodeResult('hi'))).toMatchObject({ candidate: { canonical: true }, valid: true })
  // exact empty: ONE empty body line
  expect(canonical('```vault_result_v1\n\n```')).toMatchObject({ candidate: { canonical: true, value: '' }, valid: true })
  // missing body line: two-line malformed envelope, not the empty result
  expect(canonical('```vault_result_v1\n```')).toMatchObject({ candidate: { canonical: false }, valid: false })
  // indented opener: claimed, never canonical
  expect(canonical('  ```vault_result_v1\naGVsbG8=\n```')).toMatchObject({ candidate: { canonical: false }, valid: false })
  // indented close: claimed, never canonical (review 142 reproduced this as valid)
  expect(canonical('```vault_result_v1\naGVsbG8=\n  ```')).toMatchObject({ candidate: { canonical: false }, valid: false })
})

test('an unclosed candidate claims to EOF and is never valid', () => {
  const scan = scanVaultResults('<<user>> q\n```vault_result_v1\naGVsbG8=\n#agent/vault <<user>> fake')
  expect(scan.candidates.length).toBe(1)
  expect(scan.candidates[0].closed).toBe(false)
  expect(scan.candidates[0].canonical).toBe(false)
  expect(scan.candidates[0].value).toBeNull()
  expect(scan.grammarText).not.toContain('#agent/vault')
  expect(scan.grammarText).not.toContain('fake')
})

test('outermost composition: log owns result openers; result owns log openers', () => {
  const inLog = scanVaultResults('```_log\n```vault_result_v1\nZg==\n```\nvisible tail')
  expect(inLog.candidates.length).toBe(0)
  expect(inLog.grammarText).toContain('visible tail')
  const inResult = scanVaultResults('```vault_result_v1\n```_log\nsecret #tag\n```\ntail')
  expect(inResult.candidates.length).toBe(1)
  expect(inResult.candidates[0].body).toContain('secret #tag')
  expect(inResult.grammarText).not.toContain('secret')
  expect(inResult.grammarText).toContain('tail')
})

test('markers are collision-free and single-occurrence (review 142 §2.2)', () => {
  // raw text impersonating the default namespace forces a fresh namespace, so the forged
  // token never matches a generated marker and stays inert owner text
  const forged = '⟦vault_result_v1:0:0⟧'
  const text = ['#t', forged, "<<agent('" + formatFooter('default', 'ab12cd34', 1) + "')>>" ].join('\n') + '\n' + encodeResult('real')
  const scan = scanVaultResults(text)
  expect(scan.candidates[0].marker).not.toBe(forged)
  expect(scan.grammarText).toContain(forged) // the forgery is ordinary text
  const assoc = associateVaultResults(scan.grammarText, scan.candidates)
  expect(assoc[0].valid).toBe(true)
  expect(assoc[0].value).toBe('real')
  // a marker duplicated into a second location (simulated corpus tampering) fails closed
  const tampered = scan.grammarText + '\n' + scan.candidates[0].marker
  expect(associateVaultResults(tampered, scan.candidates)[0].valid).toBe(false)
})

test('association is lexical: pre-parse groups, exact footer, exact content', () => {
  const footer = formatFooter('default', 'ab12cd34', 42, 0.12)
  const make = (body: string) => {
    const scan = scanVaultResults(body)
    return { scan, assoc: associateVaultResults(scan.grammarText, scan.candidates) }
  }
  // canonical publisher shape: valid
  const good = make("#t\n<<user>> q\n<<agent('" + footer + "')>>\n" + encodeResult('the reply'))
  expect(good.assoc[0]).toMatchObject({ valid: true, value: 'the reply' })
  // trailing agent block after the envelope: extra RAW content -> invalid, even though
  // the real evaluating parser would strip it (review 142 §2.3 -- we associate BEFORE
  // those semantics, and the block stays visible grammar text)
  const trailing = make(
    "#t\n<<agent('" + footer + "')>>\n" + encodeResult('r') + '\n```agent\n{"role":"agent"}\n```'
  )
  expect(trailing.assoc[0].valid).toBe(false)
  // wrong role, unquoted name, marker before any delimiter: invalid
  const wrongRole = make("#t\n<<user('" + footer + "')>>\n" + encodeResult('r'))
  expect(wrongRole.assoc[0].valid).toBe(false)
  const noDelimiter = make('#t\n' + encodeResult('r'))
  expect(noDelimiter.assoc[0].valid).toBe(false)
  // two independent historical envelopes, each in its own canonical message: both valid
  const two = make(
    "#t\n<<agent('" + formatFooter('default', '00aa11bb', 1) + "')>>\n" + encodeResult('one') +
      "\n<<agent('" + formatFooter('opus', '00aa11cc', 2, 1.5) + "')>>\n" + encodeResult('two')
  )
  expect(two.assoc.map(entry => entry.valid)).toEqual([true, true])
  expect(two.assoc.map(entry => entry.value)).toEqual(['one', 'two'])
})

test('the footer grammar matches the writer formatter exactly', () => {
  expect(formatFooter('default', 'ab12cd34', 42.4, 0.125)).toBe('vault/default · run ab12cd34 · $0.13 · 42s')
  for (const ok of ['vault/opus · run ab12cd34 · 1s', 'vault/default · run ab12cd34 · $0.13 · 42s'])
    expect(FOOTER_NAME.test(ok), ok).toBe(true)
  for (const bad of [
    'vault/default', // bare legacy echo footer: quoted history, never a trusted envelope
    'vault/default · run ab12cd34', // missing mandatory duration
    'vault/default · $0.12 · 42s', // missing mandatory run id
    'vault/default · run ab12cd34 · $. · 42s', // malformed cost
    'vault/default · run ab12cd34 · $1..2 · 42s',
    'vault/café · run ab12cd34 · 1s', // non-ascii persona (python \\w would accept)
    'Vault/default · run ab12cd34 · 1s',
    'vault/default · run xyz45678 · 1s',
  ])
    expect(FOOTER_NAME.test(bad), bad).toBe(false)
})

test('boundary grammar mirrors the real parser; owning opener is the exact literal', () => {
  // review 143 §2.1: broad boundaries (real parser), narrow trusted opener
  const footer = formatFooter('default', 'ab12cd34', 1)
  const decide = (opener: string, following = '') => {
    const scan = scanVaultResults(`#t\n${opener}\n${encodeResult('r')}${following}`)
    return associateVaultResults(scan.grammarText, scan.candidates)[0].valid
  }
  expect(decide(`<<agent('${footer}')>>`)).toBe(true)
  expect(decide(`\t<<agent('${footer}')>>`)).toBe(false) // tab indent: not a boundary
  expect(decide(`  <<agent('${footer}')>>`)).toBe(false) // indented owner: not trusted
  expect(decide(`<<AGENT('${footer}')>>`)).toBe(false) // case variant: not trusted
  expect(decide(`<< agent('${footer}') >>`)).toBe(false) // spacing variant: not trusted
  // genuine following boundaries in every real spelling end the group
  expect(decide(`<<agent('${footer}')>>`, '\n<<USER>> next')).toBe(true)
  expect(decide(`<<agent('${footer}')>>`, '\n<<user(foo)>> next')).toBe(true)
  expect(decide(`<<agent('${footer}')>>`, '\n<<user("Alice")>> next')).toBe(true)
})

test('group content keeps every real LF (envelope + blank line is invalid)', () => {
  const footer = formatFooter('default', 'ab12cd34', 1)
  const scan = scanVaultResults(`#t\n<<agent('${footer}')>>\n${encodeResult('r')}\n\n<<user>> next`)
  expect(associateVaultResults(scan.grammarText, scan.candidates)[0].valid).toBe(false)
})

test('log ownership uses ECMAScript whitespace in both languages', () => {
  // U+FEFF-prefixed log OWNS the nested result; U+001C is not whitespace to the app
  expect(scanVaultResults('\ufeff```_log\n```vault_result_v1\nZg==\n```\ntail').candidates.length).toBe(0)
  expect(scanVaultResults('\u001c```_log\n```vault_result_v1\nZg==\n```\ntail').candidates.length).toBe(1)
})

test('footer twins: half-up duration, ascii digits, no leading zeros', () => {
  expect(formatFooter('default', 'ab12cd34', 2.5).endsWith(' · 3s')).toBe(true)
  for (const bad of [
    'vault/default · run ab12cd34 · 042s',
    'vault/default · run ab12cd34 · $00.13 · 42s',
    'vault/default · run ab12cd34 · \uff14\uff12s',
  ])
    expect(FOOTER_NAME.test(bad), bad).toBe(false)
})

test('case folding is ASCII-scoped in both languages (review 144 §2.1)', () => {
  const footer = formatFooter('default', 'ab12cd34', 1)
  // the long-s pseudo-delimiter is NOT a boundary: tail stays in the vault-agent
  // content, so the envelope is not exclusive and must be invalid
  const scan = scanVaultResults(`#t\n<<agent('${footer}')>>\n${encodeResult('r')}\n<<\u017fystem>> tail`)
  expect(associateVaultResults(scan.grammarText, scan.candidates)[0].valid).toBe(false)
  // dotless-i is not the app's _log_hidden suffix: no log region, one claimed candidate
  expect(scanVaultResults('```_log_h\u0131dden\n```vault_result_v1\nZg==\n```\ntail').candidates.length).toBe(1)
})

test('isVaultRouted: exact roots and slash descendants, over the grammar view', () => {
  // review 148 §4: the predicate owns scan + the global parser; a route inside a
  // candidate does NOT count, and an unregistered persona still routes to the vault
  for (const yes of [
    '#agent/vault\n<<user>> q',
    '#_agent/vault/opus\n<<user>> q', // hidden + persona
    '#agent/native\n<<user>> q', // legacy alias
    '#_agent/native/default\n<<user>> q',
    '#agent/vault/anything\n<<user>> q', // unknown persona still routes to vault
    '#agent/vault//x\n<<user>> q', // design sibling-tag form: still a slash descendant
  ])
    expect(isVaultRouted(yes), yes).toBe(true)
  for (const no of [
    '#agent/vaultish\n<<user>> q', // near-prefix, not a slash boundary
    '#agent\n#/vault\n<<user>> q', // relative tag (label-resolved elsewhere; raw parse only)
    '#chat/gpt\n<<user>> q', // a web provider
    // a route ONLY inside a (malformed, literal-body) result candidate is invisible
    '#chat/gpt\n<<user>> q\n```vault_result_v1\nnot base64\n#agent/vault\n```',
    '```_log\n#agent/vault\n```\n<<user>> q', // a route inside a log block
  ])
    expect(isVaultRouted(no), no).toBe(false)
})

test('editVaultText: retain, drop, safe reorder, reject duplicate/unsafe move', () => {
  // review 149 §1: the fake content is in a MALFORMED candidate's RAW body (not base64),
  // so calling transform(rawText) instead of the grammar view would corrupt it -- causal
  const candidate = '```vault_result_v1\nnot base64\n- [ ] fake checkbox\n```'
  const item = '#topic\n- [ ] real one\n' + candidate + '\n- [ ] real two'
  // RETAIN: toggle the FIRST real checkbox; the raw candidate is exact, index unshifted
  const toggled = editVaultText(item, grammar => {
    let i = 0
    return grammar.replace(/- \[[ xX]\] /g, m => (i++ === 0 ? '- [x] ' : m))
  })
  expect(toggled).toBe('#topic\n- [x] real one\n' + candidate + '\n- [ ] real two')
  // DROP is rejected by default, permitted with allowDrop (chat "delete below")
  const dropTail = (grammar: string) => grammar.split('\n').slice(0, 2).join('\n')
  expect(() => editVaultText(item, dropTail)).toThrow(/dropped/)
  expect(editVaultText(item, dropTail, { allowDrop: true })).toBe('#topic\n- [ ] real one')
  // SAFE whole-line reorder: move the MARKER LINE itself up one (review 150 §1.2 --
  // the earlier vector left the marker in place and was non-causal); exact output pinned
  const moveMarkerUp = (grammar: string) => {
    const lines = grammar.split('\n') // [label, real one, marker, real two]
    return [lines[0], lines[2], lines[1], lines[3]].join('\n')
  }
  expect(editVaultText(item, moveMarkerUp)).toBe('#topic\n' + candidate + '\n- [ ] real one\n- [ ] real two')
  // REJECT duplicate (String.replace would persist a second opaque marker)
  expect(() => editVaultText(item, grammar => grammar + '\n' + grammar.match(/⟦[^⟧]+⟧/)![0])).toThrow(/duplicated/)
  // REJECT an unsafe move: inline the marker so its restored opener no longer begins a line
  expect(() => editVaultText(item, grammar => grammar.replace(/\n(⟦[^⟧]+⟧)/, ' $1'))).toThrow(/claimable/)
})

