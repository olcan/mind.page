import { expect, test } from '@playwright/test'
import { comparePinTerm } from '../../src/pin_sort.js'

// Parity tables for pin-term comparison (src/pin_sort.ts) against the inline localeCompare call
// it replaced in onEditorChange (index.svelte): exact same sign on every pair, including equal
// strings, empty strings, case-only and accent-only differences (sensitivity: 'base'), and
// embedded numbers (numeric: true), plus sorting a long mixed list both ways.

const legacyCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: 'base',
  })

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0)

test('equal and empty strings compare equal, and empty precedes non-empty', () => {
  for (const s of ['', '#_pin', '#_pin/a', '#_pin/dot/10', '#chat/pin/2', 'café']) {
    expect(comparePinTerm(s, s), `identity for ${JSON.stringify(s)}`).toBe(0)
    expect(sign(comparePinTerm(s, s))).toBe(sign(legacyCompare(s, s)))
  }
  for (const s of ['a', '0', '#_pin', '#_pin/1']) {
    expect(comparePinTerm('', s), `"" < ${JSON.stringify(s)}`).toBeLessThan(0)
    expect(comparePinTerm(s, ''), `${JSON.stringify(s)} > ""`).toBeGreaterThan(0)
    expect(sign(comparePinTerm('', s))).toBe(sign(legacyCompare('', s)))
    expect(sign(comparePinTerm(s, ''))).toBe(sign(legacyCompare(s, '')))
  }
})

test('distinct strings differing only by case, leading zeros, or accent match base-sensitivity collation', () => {
  // Each kind of pair can collate distinctly under some default locale (a POSIX variant orders a after A;
  // Swedish u before ü; Icelandic e before é): expect exact sign parity with the legacy localeCompare
  // expression in whatever default locale runs
  const pairs: [string, string][] = [
    ['a', 'A'],
    ['#_pin/Alpha', '#_pin/alpha'],
    ['#_pin/dot/Beta2', '#_pin/dot/beta2'],
    ['#_pin/01', '#_pin/1'],
    ['a002', 'A2'],
    ['e', 'é'],
    ['cafe', 'café'],
    ['#_pin/resume', '#_pin/résumé'],
    ['#_pin/uber', '#_pin/über'],
  ]
  for (const [a, b] of pairs) {
    expect(a, 'premise: distinct strings').not.toBe(b)
    expect(sign(comparePinTerm(a, b)), `sign parity (${a}, ${b})`).toBe(sign(legacyCompare(a, b)))
    expect(sign(comparePinTerm(b, a)), `sign parity (${b}, ${a})`).toBe(sign(legacyCompare(b, a)))
  }
})

test('embedded numbers order numerically rather than lexicographically', () => {
  // Explicit numeric ordering stays on identical prefixes across all locales
  const orderedPairs: [string, string][] = [
    ['a2', 'a10'],
    ['#_pin/2', '#_pin/10'],
    ['#_pin/9', '#_pin/10'],
    ['#_pin/dot/item2', '#_pin/dot/item10'],
    ['#_pin/dot/item9b', '#_pin/dot/item10a'],
    ['#chat/pin/1', '#chat/pin/2'],
    ['#chat/pin/2', '#chat/pin/10'],
    ['#chat/pin/10', '#chat/pin/100'],
  ]
  for (const [smaller, larger] of orderedPairs) {
    expect(comparePinTerm(smaller, larger), `${smaller} < ${larger}`).toBeLessThan(0)
    expect(comparePinTerm(larger, smaller), `${larger} > ${smaller}`).toBeGreaterThan(0)
    expect(sign(comparePinTerm(smaller, larger))).toBe(sign(legacyCompare(smaller, larger)))
    expect(sign(comparePinTerm(larger, smaller))).toBe(sign(legacyCompare(larger, smaller)))
  }
  // Mixed prefixes can sort apart before the numeric suffix (é after e in Icelandic, a after A under a
  // POSIX variant): sign parity with the legacy expression
  for (const [a, b] of [
    ['é2', 'e10'],
    ['e2', 'é10'],
    ['a2', 'A10'],
  ] as [string, string][]) {
    expect(sign(comparePinTerm(a, b)), `sign parity (${a}, ${b})`).toBe(sign(legacyCompare(a, b)))
    expect(sign(comparePinTerm(b, a)), `sign parity (${b}, ${a})`).toBe(sign(legacyCompare(b, a)))
  }
})

test('every pair and full sort of a long mixed list match the legacy localeCompare expression', () => {
  const terms = [
    '',
    '',
    '',
    '#_pin',
    '#_pin/1',
    '#_pin/01',
    '#_pin/2',
    '#_pin/10',
    '#_pin/11',
    '#_pin/20',
    '#_pin/100',
    '#_pin/a',
    '#_pin/A',
    '#_pin/a2',
    '#_pin/A10',
    '#_pin/b',
    '#_pin/B',
    '#_pin/cafe',
    '#_pin/café',
    '#_pin/dot',
    '#_pin/dot/0',
    '#_pin/dot/1',
    '#_pin/dot/2',
    '#_pin/dot/10',
    '#_pin/dot/a',
    '#_pin/dot/A',
    '#_pin/dot/e2',
    '#_pin/dot/é10',
    '#_pin/dot/z',
    '#_pin/item-2',
    '#_pin/item-10',
    '#_pin/resume',
    '#_pin/résumé',
    '#_pin/uber',
    '#_pin/über',
    '#_pin/z',
    '#chat/pin',
    '#chat/pin/1',
    '#chat/pin/2',
    '#chat/pin/10',
    '#todo/pin/a2',
    '#todo/pin/A2',
    '#todo/pin/a10',
  ]

  // Exhaustive pairwise sign parity
  for (const a of terms) {
    for (const b of terms) {
      expect(sign(comparePinTerm(a, b)), `pair (${JSON.stringify(a)}, ${JSON.stringify(b)})`).toBe(
        sign(legacyCompare(a, b)),
      )
    }
  }

  // Deterministic pseudo-shuffled long mixed list with secondary tie-breakers (mimicking
  // onEditorChange's three pin terms + recency fallback), sorted both ways
  const items = Array.from({ length: 160 }, (_, i) => ({
    id: `item_${i}`,
    dotted: i % 17 === 0 ? 1 : 0,
    dotTerm: i % 17 === 0 ? terms[(i * 7) % terms.length] : '',
    pinned: i % 5 === 0 ? 1 : 0,
    pinTerm: i % 5 === 0 ? terms[(i * 11 + 3) % terms.length] : '',
    pinnedMatch: i % 9 === 0 ? 1 : 0,
    pinnedMatchTerm: i % 9 === 0 ? terms[(i * 13 + 5) % terms.length] : '',
    time: ((i * 37) % 160) * 1000,
  }))

  const sortWith = (cmp: (a: string, b: string) => number) =>
    items
      .slice()
      .sort(
        (a, b) =>
          b.dotted - a.dotted ||
          cmp(a.dotTerm, b.dotTerm) ||
          b.pinned - a.pinned ||
          cmp(a.pinTerm, b.pinTerm) ||
          b.pinnedMatch - a.pinnedMatch ||
          cmp(a.pinnedMatchTerm, b.pinnedMatchTerm) ||
          b.time - a.time,
      )
      .map(it => it.id)

  expect(sortWith(comparePinTerm)).toEqual(sortWith(legacyCompare))
})
