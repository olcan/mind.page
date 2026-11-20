import { expect, test } from '@playwright/test'

import { blockOpen, holdsTag, holdsTerm, remembered, sectionKeys, sectionName, toggled, type Toggle } from '../../src/inert_blocks.js'

// what decides whether an inert section shows open (src/inert_blocks.ts): what a manual toggle
// left while it stands, the search, the selection; a region's small name; and the keys a toggle is remembered by. The blocks themselves (the
// frames that follow each other, the head line, the click) and how long a toggle stands (until its item's
// selection or the search changes) are made of rendered frames: their rows are the collapse rows of tests/e2e/bridge.spec.ts

const open: Toggle = { open: true, selected: false, at: 1 }
const closed: Toggle = { open: false, selected: false, at: 1 }

test('a section is closed by default and open while its item is selected', () => {
  expect([blockOpen(undefined, false, false), blockOpen(undefined, false, true)]).toEqual([false, true])
})

test('what a manual toggle left decides while it stands: selected or not, and over a search match', () => {
  // [matched, selected]: a section closed by hand is closed and one opened by hand is open in all four
  const inputs = [false, true].flatMap(matched => [false, true].map(selected => [matched, selected]))
  expect(inputs.map(([matched, selected]) => [blockOpen(closed, matched, selected), blockOpen(open, matched, selected)])).toEqual(inputs.map(() => [false, true]))
})

test('with no toggle, a search match inside opens a section, selected or not', () => {
  expect([false, true].map(selected => blockOpen(undefined, true, selected))).toEqual([true, true])
})

test('a click leaves the opposite of what the section shows, with the selection it was made under', () => {
  // closed by default: opened; open by the selection: closed; open by a match: closed (never a dead click)
  expect(toggled(undefined, false, false, 1)).toEqual({ open: true, selected: false, at: 1 })
  expect(toggled(undefined, false, true, 2)).toEqual({ open: false, selected: true, at: 2 })
  expect(toggled(undefined, true, false, 3)).toEqual({ open: false, selected: false, at: 3 })
  // and a click on what a toggle left is the opposite again, which holds under the match and the selection
  const left = toggled(open, true, true, 4)
  expect(left).toEqual({ open: false, selected: true, at: 4 })
  expect(blockOpen(left, true, true)).toBe(false)
})

test('a term is found in a text without case, and no terms find nothing', () => {
  expect(holdsTerm('Reading the Code', 'code #tag')).toBe(true)
  expect(holdsTerm('reading the code', 'tree  list')).toBe(false)
  expect([holdsTerm('anything', ''), holdsTerm('anything', ' ')]).toEqual([false, false])
})

test("a region's small name is a first line of one lowercase word with more under it", () => {
  expect(['agent\n- working', 'request\ntext', 'parent\n\ntext'].map(sectionName)).toEqual(['agent', 'request', 'parent'])
  // a reply has none: a sentence, a capitalized word, a word alone, a word with its text on the line
  expect(['Here is the answer.\nmore', 'Done\nmore', 'agent', 'agent: no\nmore', 'agent plan\n- [ ] a', ''].map(sectionName)).toEqual([
    null,
    null,
    null,
    null,
    null,
    null,
  ])
})

test('a section is remembered by its name and its occurrence among that name, an unnamed one by its place among the unnamed', () => {
  // a todo made from a chat with a directive line: the request alone, then the agent's first tree above it.
  // the request keeps its key, and the new tree has one of its own (the tree does not take the request's)
  expect(sectionKeys(['request'])).toEqual(['request:0'])
  expect(sectionKeys(['agent', 'request'])).toEqual(['agent:0', 'request:0'])
  // a chat's replies have no name: the one written last has the next place, the earlier ones keep theirs
  expect(sectionKeys([null, null])).toEqual([':0', ':1'])
  expect(sectionKeys([null, null, null]).slice(0, 2)).toEqual([':0', ':1'])
  // names and replies are counted apart, each name by itself
  expect(sectionKeys(['agent', null, 'request', 'agent', null, 'parent'])).toEqual(['agent:0', ':0', 'request:0', 'agent:1', ':1', 'parent:0'])
  expect(sectionKeys([])).toEqual([])
})

test("a block remembers the latest manual toggle among its sections'", () => {
  const request: Toggle = { open: true, selected: false, at: 3 }
  // the new tree has none and the request under it was opened before: the block of the two is open
  expect(remembered([undefined, request])).toBe(request)
  expect(remembered([request, undefined])).toBe(request)
  // two sections that were toggled apart: the later toggle decides, wherever its section stands
  const later: Toggle = { open: false, selected: false, at: 5 }
  expect([remembered([request, later]), remembered([later, request])]).toEqual([later, later])
  expect([remembered([undefined, undefined]), remembered([])]).toEqual([undefined, undefined])
})

test("a child tag's mark is a match where its resolved tag is one of the terms, primary or secondary", () => {
  // the mark's title is its resolved tag (the reply reads `#/alpha`): the app's rule for a selected mark
  expect(holdsTag(['#e2e_cc/alpha', '#e2e_cc/beta'], '#e2e_cc/alpha ')).toBe(true)
  expect(holdsTag(['#E2E_cc/Alpha'], '#e2e_cc/alpha ')).toBe(true)
  expect(holdsTag(['#e2e_cc/alpha'], '#e2e_cc #e2e_cc/alpha'), 'a secondary term').toBe(true)
  // the whole tag, not a part of it: the parent's tag or a longer one is no match
  expect([holdsTag(['#e2e_cc/alpha'], '#e2e_cc '), holdsTag(['#e2e_cc/alpha'], '#e2e_cc/alpha/deep '), holdsTag(['#e2e_cc/alpha'], 'alpha ')]).toEqual([false, false, false])
  expect([holdsTag([], '#e2e_cc/alpha '), holdsTag(['#e2e_cc/alpha'], ' ')]).toEqual([false, false])
})
