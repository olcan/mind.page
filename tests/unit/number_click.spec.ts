import { expect, test } from '@playwright/test'

import { numberClick, selectName, selectsAlready, type NumberClick } from '../../src/number_click.js'

// what a click on an item's number asks for (src/number_click.ts): by the number's state (green: the item
// matches the query) and the modifiers held; then the name a select gives an item, and the queries that
// are that selection already. The browser row that clicks real numbers is the number row of
// tests/e2e/editor.spec.ts

const click = (keys: string, matching: boolean): NumberClick =>
  numberClick(
    { altKey: keys.includes('alt'), metaKey: keys.includes('meta'), shiftKey: keys.includes('shift') },
    matching,
  )

test('a plain click moves the item of a green number up and selects the item of a plain one', () => {
  expect([click('', true), click('', false)]).toEqual(['touch', 'select'])
})

test('Shift+click selects whatever the number shows', () => {
  expect([click('shift', true), click('shift', false)]).toEqual(['select', 'select'])
})

test('Option, Cmd and Option+Cmd keep their jobs whatever the number shows, with or without Shift', () => {
  for (const matching of [true, false])
    for (const shift of ['', ' shift'])
      expect(
        ['alt', 'meta', 'alt meta'].map(keys => click(keys + shift, matching)),
        `matching: ${matching}, keys:${shift || ' none more'}`,
      ).toEqual(['down', 'up', 'back'])
})

test("a call without an event (a run's touch) moves the item up, green or not", () => {
  expect([numberClick(null, true), numberClick(null, false), numberClick(undefined, false)]).toEqual([
    'touch',
    'touch',
    'touch',
  ])
})

test('Ctrl is not read: a click with it alone is a plain click', () => {
  const event = { altKey: false, metaKey: false, shiftKey: false, ctrlKey: true } // the fields as a MouseEvent carries them
  expect([numberClick(event, true), numberClick(event, false)]).toEqual(['touch', 'select'])
})

test('an item is selected by its unique label, else by its saved id as soon as it has one, and by the id of its tab until then', () => {
  const names = [
    selectName({ id: '17', savedId: 'Abc', labelUnique: true, labelText: '#Plan/B' }),
    selectName({ id: '17', savedId: 'Abc', labelUnique: false, labelText: '#todo' }), // a shared label names no item
    selectName({ id: '17', savedId: 'Abc' }),
    selectName({ id: 'Abc', savedId: 'Abc' }), // an item the tab loaded: one id
    selectName({ id: '17', savedId: null }), // created in this tab and not yet acknowledged: the tab-only window
    selectName({ id: '17' }),
  ]
  expect(names).toEqual(['#Plan/B', 'id:Abc', 'id:Abc', 'id:Abc', 'id:17', 'id:17'])
})

test('a query is the selection already by the exact name or, for an id reference, by either id, trimmed and without case', () => {
  const unnamed = { id: '17', savedId: 'Abc', labelUnique: false, labelText: '#todo' }
  const named = { id: '17', savedId: 'Abc', labelUnique: true, labelText: '#Plan/B' }
  for (const query of ['id:Abc', ' id:abc  ', 'ID:ABC', 'id:17', 'id:17 '])
    expect(selectsAlready(query, unnamed), query).toBe(true)
  for (const query of ['#Plan/B', '#plan/b ', '  #PLAN/B']) expect(selectsAlready(query, named), query).toBe(true)
  expect(selectsAlready('id:17', { id: '17', savedId: null }), 'not yet acknowledged: the id of its tab').toBe(true)
})

test("nothing else is the same selection: a labeled item's id reference, a shared label, more terms, another id", () => {
  const unnamed = { id: '17', savedId: 'Abc', labelUnique: false, labelText: '#todo' }
  const named = { id: '17', savedId: 'Abc', labelUnique: true, labelText: '#Plan/B' }
  for (const query of ['id:Abc', 'id:17', '#plan', '#plan/b x', '#plan/b/c', ''])
    expect(selectsAlready(query, named), query).toBe(false)
  for (const query of ['#todo', 'id:Abc x', 'id:Ab', 'id:170', 'Abc', 'id:', ''])
    expect(selectsAlready(query, unnamed), query).toBe(false)
})
