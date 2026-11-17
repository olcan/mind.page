import { expect, test } from '@playwright/test'

import _ from 'lodash'

// parseTags (util.js: the app's own parser, which the labeled texts below are read back with) reads
// the browser globals `_` (lodash) and `window._shortcut_hosts` at call time; stub both before the calls
;(globalThis as any)._ = _
;(globalThis as any).window = { _shortcut_hosts: [] }

// @ts-expect-error util.js is plain js (the app's client lib) without a declaration file
import { parseLabel, parseTags } from '../../src/util.js'
import { freeName, labeledText, nameLabel, nameRefusal } from '../../src/item_name.js'

// naming an unnamed item from the MindBox (src/item_name.ts): the typed name as a label, the names
// refused, the name offered, and where the label goes in the item's text

const INVALID = 'Invalid name: expected a visible absolute tag like `#name` (the `#` is optional).'

test('the typed name is a label with or without its #, as written', () => {
  expect(['thread_0', '#thread_0', '  Plan/B ', '', '##x'].map(nameLabel)).toEqual(['#thread_0', '#thread_0', '#Plan/B', '#', '##x'])
})

test('a name is accepted when it is one visible absolute tag that labels no item', () => {
  const labels = ['#thread_1', '#plan/b', '#taken']
  for (const label of ['#thread_0', '#thread', '#plan', '#plan/b/0', '#take', '#θ-1', '#Plan/C']) expect(nameRefusal(label, labels), label).toBe('')
})

test('a name that is no tag of the app syntax, a hidden or a relative one, or one ending in a slash is refused', () => {
  for (const label of ['#', '#a b', '#a.b', '#a,b', '##x', '#a#b', '#_hidden', '#/relative', '#plan/', ''])
    expect(nameRefusal(label, []), label).toBe(INVALID)
})

test('a name that labels an item already is refused, without case, and named as typed', () => {
  expect(nameRefusal('#taken', ['#thread_1', '#taken'])).toBe('An item is already labeled `#taken`.')
  expect(nameRefusal('#Taken', ['#taken'])).toBe('An item is already labeled `#Taken`.')
  expect(nameRefusal('#taken', ['#TAKEN'])).toBe('An item is already labeled `#taken`.')
  expect(nameRefusal('#plan/b', ['#plan/b'])).toBe('An item is already labeled `#plan/b`.')
})

test('the label of log items is refused: the app never names an item by it', () => {
  for (const label of ['#log', '#LOG']) expect(nameRefusal(label, []), label).toBe('`#log` is reserved for log items.')
  expect(nameRefusal('#log/a', [])).toBe('') // nested under it: an ordinary label
})

test('a zero-width space in the typed name is dropped before the name is checked, as a save drops it from an item text: the name is refused or accepted as the label the item would get', () => {
  // the tag grammar allows the character in a tag and a save removes it from the text, so each of
  // these was checked as one label and stored as another: a taken one, #log, and one the creation
  // of the child then looked up as typed and missed
  const ZWSP = '\u200B'
  const named = (typed: string, labels: string[]) => [nameLabel(typed), nameRefusal(nameLabel(typed), labels)]
  expect([named(`ta${ZWSP}ken`, ['#taken']), named(`lo${ZWSP}g`, []), named(`brand${ZWSP}new`, ['#brand', '#new'])]).toEqual([
    ['#taken', 'An item is already labeled `#taken`.'],
    ['#log', '`#log` is reserved for log items.'],
    ['#brandnew', ''],
  ])
})

test('the offered name is thread_<n> with the smallest n from 0 that labels no item and has no label nested under it', () => {
  // each offer is a name the dialog would accept as it stands
  const offers = (labels: string[], expected: string) => {
    expect(freeName(labels), labels.join(' ')).toBe(expected)
    expect(nameRefusal(nameLabel(expected), labels), expected).toBe('')
  }
  offers([], 'thread_0')
  offers(['#other', '#thread', '#thread/0'], 'thread_0')
  offers(['#thread_0'], 'thread_1')
  offers(['#thread_1', '#thread_2'], 'thread_0') // the smallest free one, whatever comes after
  offers(['#thread_0', '#thread_1', '#thread_3'], 'thread_2')
  offers(Array.from({ length: 11 }, (_, n) => `#thread_${n}`), 'thread_11') // by number, not by text
  offers(['#Thread_0'], 'thread_1') // without case
  offers(['#thread_0/0', '#thread_1/a/b'], 'thread_2') // a child left behind holds its parent's name
  // look-alikes hold nothing: another number as written, a longer name, a nested or a prefixed one
  offers(['#thread_00', '#thread_0x', '#thread_0_a', '#thread_', '#my/thread_0', '#xthread_0'], 'thread_0')
})

test('the label is put in front of the text, where the app reads an item label', () => {
  // the label the app reads afterwards (parseLabel, as /_install reads one), and the text after it untouched
  const labeled = (text: string, expected: string, label = '#thread_0') => {
    const result = labeledText(text, label)
    expect(result, text).toBe(expected)
    expect(parseLabel(result, true /* keep_case */), text).toBe(label)
    expect(result.slice(label.length + 1), text).toBe(text)
  }
  // on the first line when it starts with a tag (as the owner writes it by hand) or with a letter
  labeled('#todo [working] fix the cache\nmore', '#thread_0 #todo [working] fix the cache\nmore')
  labeled('#_pin/dot #shared a shared label', '#thread_0 #_pin/dot #shared a shared label')
  labeled('plain words\nmore', '#Plan/B plain words\nmore', '#Plan/B')
  labeled('Élan, then θ', '#thread_0 Élan, then θ')
  // on a line of its own when a prefix would change what the first line is, or it is no text at all
  for (const text of [
    '```js\nlet a = 1 // #in_code\n```',
    '    #in_code on an indented code line',
    '# A heading',
    '#!not a tag',
    '- a list item\n- another',
    '1. a numbered item',
    '> a quote',
    '| a | table |\n|---|---|',
    '<div class="x">html</div>',
    '<<macro()>> and text',
    '<!-- a comment -->',
    '$`x^2`$ math',
    '*emphasis* first',
    '42 is no letter',
    '\n#todo after an empty line',
    '',
  ])
    labeled(text, '#thread_0\n' + text)
  // why: joined to a fence's line, the label would open the block to the index
  const block = '```js\nlet a = 1 // #in_code\n```'
  expect(parseTags(labeledText(block, '#thread_0')).raw).toEqual(['#thread_0'])
  expect(parseTags('#thread_0 ' + block).raw).toEqual(['#thread_0', '#in_code'])
})
