import { expect, test } from '@playwright/test'
import _ from 'lodash'

// urlRegExp (used by insertZWSP) reads the browser globals `window._shortcut_hosts` and lodash
// `_` at CALL time; stub both before the calls below — no other browser surface is touched
;(globalThis as any).window = { _shortcut_hosts: [] }
;(globalThis as any)._ = _

import { insertZWSP, removeZWSP, zwspOffset } from '../../src/zwsp.js'

// the raw<->augmented offset contract (see src/zwsp.ts): the editor's textarea holds
// insertZWSP(text), while data-selection and MindBox selection offsets index the RAW text.
// the invariant that matters to every consumer: for any raw range [a, b],
//   removeZWSP(aug.slice(zwspOffset(aug, a), zwspOffset(aug, b))) == raw.slice(a, b)
// the tables run over the EXACT item that surfaced the bug (a todo whose two long urls take
// 13 insertions, dragging an unmapped full-text selection 13 raw characters short of the end)

const TODO =
  '#todo Ask vedant [gmail](https://mail.google.com/mail/u/0/#inbox/19f0c2748522c278) ' +
  '[mail](message://%3CCAFXOJNHzgNtJc7CbqiMf%2BNeH%2B0gGYVpZYT%3DyNoKquDvL3Vo5Lw%40mail.gmail.com%3E)'

test('insertZWSP round-trips and records its insertions', () => {
  const insertions: number[] = []
  const aug = insertZWSP(TODO, insertions)
  expect(removeZWSP(aug)).toBe(TODO) // lossless
  expect(aug.length).toBe(TODO.length + insertions.length) // one char per insertion
  expect(insertions.length).toBeGreaterThan(0) // the urls really are augmented
  // idempotent: re-augmenting an augmented value inserts nothing more
  expect(insertZWSP(aug)).toBe(aug)
  // no-url text is untouched
  expect(insertZWSP('#todo plain text, no urls at all')).toBe('#todo plain text, no urls at all')
})

test('zwspOffset maps raw offsets so sliced selections strip back to the raw range', () => {
  const aug = insertZWSP(TODO)
  const cases: [number, number][] = [
    [0, TODO.length], // the todoer's full-snippet selection — the reported bug
    [0, 0], // collapsed caret at start
    [TODO.length, TODO.length], // collapsed caret at end
    [6, 16], // 'Ask vedant' — before any url, identity region
    [0, TODO.indexOf('gmail.com%3E)')], // the exact truncated selection the owner observed
    [TODO.indexOf('message://'), TODO.length], // starts inside the augmented tail
  ]
  for (const [a, b] of cases) {
    const slice = aug.slice(zwspOffset(aug, a), zwspOffset(aug, b))
    expect(removeZWSP(slice), `raw range [${a},${b}]`).toBe(TODO.slice(a, b))
  }
  // the full-text selection reaches the true end — this is exactly what the unmapped
  // offsets failed (they left the last insertions.length raw characters unselected)
  expect(zwspOffset(aug, TODO.length)).toBe(aug.length)
  // identity on unaugmented values: offsets pass through untouched
  expect(zwspOffset(TODO, 25)).toBe(25)
  // an offset at an insertion boundary lands BEFORE the ZWSP (zero-width either way)
  const zwsp = aug.indexOf('\u200B')
  const rawAtZwsp = removeZWSP(aug.slice(0, zwsp)).length
  expect(zwspOffset(aug, rawAtZwsp)).toBe(zwsp)
  // out-of-range raw offsets clamp to the augmented length
  expect(zwspOffset(aug, TODO.length + 100)).toBe(aug.length)
})
