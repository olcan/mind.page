import { expect, test } from '@playwright/test'
import { eventKey } from '../../src/event_key.js'

const event = (code: string, key: string, extra: Record<string, unknown> = {}) =>
  ({ code, key, ...extra }) as unknown as KeyboardEvent

test('a real press keeps its physical code', () => {
  // the layout keys and the chords every shortcut compares
  expect(eventKey(event('KeyS', 's', { metaKey: true }))).toBe('KeyS')
  expect(eventKey(event('Slash', '/'))).toBe('Slash')
  expect(eventKey(event('Backquote', '`'))).toBe('Backquote')
  expect(eventKey(event('Space', ' '))).toBe('Space')
  expect(eventKey(event('Digit1', '1'))).toBe('Digit1')
  // the guarded names: a real press reports the same name through `key`
  for (const name of ['Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'F5']) {
    expect(eventKey(event(name, name))).toBe(name)
  }
  expect(eventKey(event('Enter', 'Enter', { shiftKey: true }))).toBe('Enter')
})

test('a character typed on a remapped keycode is the character, never the key name', () => {
  // wtype assigns spare keycodes in order of first appearance, starting at 9 (Escape):
  // "Testing 1, 2, 3" put T on Escape, e on Digit1, s on Digit2, and so on
  expect(eventKey(event('Escape', 'T'))).toBe('T')
  expect(eventKey(event('Digit1', 'e'))).toBe('Digit1') // a code no branch reads as a name
  // the names a longer transcription reaches as it climbs the keycode table
  expect(eventKey(event('Backspace', 'x'))).toBe('x')
  expect(eventKey(event('Tab', 'y'))).toBe('y')
  expect(eventKey(event('Enter', 'z'))).toBe('z')
  expect(eventKey(event('ArrowUp', '.'))).toBe('.')
  expect(eventKey(event('Delete', ' '))).toBe(' ')
})

test('a character of any width is still a character, not a key name', () => {
  // `e.key` is a NAME or the character the key produces; the character can be one code unit,
  // a surrogate pair, or a base character with combining marks, so the test is "not a name"
  expect(eventKey(event('Escape', '😀'))).toBe('😀') // length 2 in UTF-16
  expect(eventKey(event('Tab', '😀'))).toBe('😀')
  expect(eventKey(event('Backspace', '🇬🇧'))).toBe('🇬🇧') // two surrogate pairs
  expect(eventKey(event('Enter', 'ḍ̇'))).toBe('ḍ̇') // base plus combining marks
  expect(eventKey(event('Escape', 'é'))).toBe('é')
  expect(eventKey(event('ArrowUp', '中'))).toBe('中')
})

test('the named key values a real press reports are kept', () => {
  // two or more ASCII alphanumerics starting with a letter: the UI Events key-value tables
  for (const name of ['Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'F12', 'Home']) {
    expect(eventKey(event(name, name))).toBe(name)
  }
  expect(eventKey(event('NumpadEnter', 'Enter'))).toBe('NumpadEnter') // a NAMED value, kept
  expect(eventKey(event('Escape', 'Dead'))).toBe('Escape') // a dead key composing
  expect(eventKey(event('Enter', 'Process'))).toBe('Enter') // an IME composing
})

test('an empty code falls back to key (ios pencil, android soft keyboards)', () => {
  expect(eventKey(event('', 'Unidentified'))).toBe('Unidentified')
  expect(eventKey(event('', ''))).toBe('')
  expect(eventKey({} as KeyboardEvent)).toBe('')
  expect(eventKey(undefined)).toBe('') // `onEditorDone` can be called without an event
  expect(eventKey(null)).toBe('')
  expect(eventKey({ code: 'Enter' } as KeyboardEvent)).toBe('Enter') // a synthetic caller's shape
})
