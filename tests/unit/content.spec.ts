import { expect, test } from '@playwright/test'
// @ts-expect-error content.js is plain js (server lib) without a declaration file
import { sanitizeBlock } from '../../src/lib/server/content.js'

// the injected-content sanitizer's constrained svg profile: the frozen render's contract
// includes charts drawn and math typeset (see prerender.mjs), so mathjax svg output (fontCache
// 'local': per-equation glyph defs referenced via fragment <use>) and item-drawn chart svg must
// SURVIVE sanitization, while svg-specific execution vectors must not

test('mathjax-style svg survives: defs, paths, fragment use references and geometry', () => {
  const math = [
    '<svg width="10ex" height="3ex" viewBox="0 -900 4500 1300" role="img" focusable="false">',
    '<defs><path id="MJX-1-TEX-I-78" d="M52 289Q59 331 106 386T222 442Z"></path></defs>',
    '<g stroke="currentColor" fill="currentColor" stroke-width="0" transform="scale(1,-1)">',
    '<use href="#MJX-1-TEX-I-78" xlink:href="#MJX-1-TEX-I-78"></use>',
    '<rect x="100" y="0" width="60" height="60"></rect>',
    '<text x="0" y="0" font-family="serif" text-anchor="middle"><tspan dy="4">x</tspan></text>',
    '</g></svg>',
  ].join('')
  const clean = sanitizeBlock(math)
  expect(clean).toContain('<svg')
  expect(clean).toContain('viewbox="0 -900 4500 1300"') // lowercased; the html parser re-adjusts
  expect(clean).toContain('d="M52 289Q59 331 106 386T222 442Z"')
  expect(clean).toContain('href="#MJX-1-TEX-I-78"') // fragment reference preserved
  expect(clean).toContain('transform="scale(1,-1)"')
  expect(clean).toContain('<tspan dy="4">x</tspan>')
})

test('chart svg and canvas husks survive with gradients, clips and polylines', () => {
  const chart = [
    '<svg viewBox="0 0 300 150"><defs>',
    '<clipPath id="c"><rect width="300" height="150"></rect></clipPath>',
    '<linearGradient id="g"><stop offset="0" stop-color="red"></stop></linearGradient>',
    '</defs><g clip-path="url(#c)">',
    '<polyline points="0,10 50,40 100,20" stroke="url(#g)" fill="none" stroke-width="2"></polyline>',
    '<circle cx="50" cy="40" r="3"></circle><line x1="0" y1="0" x2="300" y2="0"></line>',
    '</g></svg><canvas width="300" height="150" class="chart"></canvas>',
  ].join('')
  const clean = sanitizeBlock(chart)
  expect(clean).toContain('points="0,10 50,40 100,20"')
  expect(clean).toContain('stop-color="red"')
  expect(clean).toContain('clip-path="url(#c)"')
  expect(clean).toContain('<canvas width="300" height="150" class="chart"></canvas>')
})

test('svg execution vectors are removed: foreignObject, script, smil, handlers, external use', () => {
  const hostile = [
    '<svg viewBox="0 0 10 10">',
    '<foreignObject><body onload="window.x=1"><script>window.x=1</script></body></foreignObject>',
    '<script href="data:text/javascript,alert(1)"></script>',
    '<animate attributeName="href" to="javascript:alert(1)" begin="0s"></animate>',
    '<set attributeName="onmouseover" to="alert(1)"></set>',
    '<use href="https://evil.example/sprite.svg#x"></use>',
    '<use xlink:href="//evil.example/s.svg#y"></use>',
    '<path d="M0 0" onclick="window.x=1"></path>',
    '<a href="javascript:alert(1)"><text x="0" y="0">click</text></a>',
    '</svg>',
  ].join('')
  const clean = sanitizeBlock(hostile)
  expect(clean).not.toContain('foreignObject')
  expect(clean).not.toContain('<script')
  expect(clean).not.toContain('animate')
  expect(clean).not.toContain('<set')
  expect(clean).not.toContain('evil.example') // external use references stripped entirely
  expect(clean).not.toContain('onclick')
  expect(clean).not.toContain('onload')
  expect(clean).not.toContain('javascript:')
  expect(clean).toContain('<path d="M0 0"></path>') // the shape itself survives
})

test('url-valued presentation attributes reject external references, including css-escaped ones', () => {
  const external =
    '<svg><rect fill="url(https://evil.example/x)" clip-path="url(//evil.example/x)" mask="url(javascript:alert(1))"></rect></svg>'
  const clean = sanitizeBlock(external)
  expect(clean).not.toContain('evil.example')
  expect(clean).not.toContain('javascript:')
  // css decodes backslash escapes, so a literal `url(` test is bypassable: `u\72l(` is `url(`
  const escaped = String.raw`<svg><rect fill="u\72l(https://evil.example/x)"></rect></svg>`
  expect(sanitizeBlock(escaped)).not.toContain('evil.example')
  // local fragment references (the legitimate case: gradients, clips, masks) still survive
  expect(sanitizeBlock('<svg><rect fill="url(#g)" clip-path="url(#c)"></rect></svg>')).toContain('fill="url(#g)"')
})

test('url()-valued paint and clipping attributes keep only local fragment references', () => {
  // round-9 finding 10: the scheme allow-list only sees href/src, so url(...) VALUES bypassed it
  // entirely — external references and a literal javascript: survived inside attribute values
  const hostile =
    '<svg viewBox="0 0 10 10">' +
    '<rect fill="url(https://evil.example/x)" clip-path="url(//evil.example/x)" mask="url(javascript:alert(1))"></rect>' +
    '<rect fill="url(#local)" stroke="url( \'#also-local\' )"></rect>' +
    '</svg>'
  const clean = sanitizeBlock(hostile)
  expect(clean).not.toContain('evil.example')
  expect(clean).not.toContain('javascript:')
  expect(clean).toContain('fill="url(#local)"') // local references are untouched ...
  expect(clean).toContain('also-local') // ... including quoted/spaced forms
})
