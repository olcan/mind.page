import { expect, test } from '@playwright/test'

import { stepKeptTimes } from '../../src/kept_times.js'

// table of cases for stepKeptTimes (src/kept_times.ts): the three states of onEditorChange's
// optional keep_times argument and multi-step visit lifecycles

test('explicit keepTimes=true remembers the trimmed query (nothing when empty) and does not touch', () => {
  expect(stepKeptTimes(null, '#child ', true)).toEqual({ kept: '#child', touch: false })
  expect(stepKeptTimes(null, '  #parent/child\t', true)).toEqual({ kept: '#parent/child', touch: false })
  expect(stepKeptTimes(null, 'id:abc123', true)).toEqual({ kept: 'id:abc123', touch: false })
  expect(stepKeptTimes('#old', '#new ', true)).toEqual({ kept: '#new', touch: false })
  expect(stepKeptTimes('#same', '#same ', true)).toEqual({ kept: '#same', touch: false })
  expect(stepKeptTimes('#old', '', true)).toEqual({ kept: null, touch: false })
  expect(stepKeptTimes('#old', '   \t\n ', true)).toEqual({ kept: null, touch: false })
  expect(stepKeptTimes(null, '', true)).toEqual({ kept: null, touch: false })
  expect(stepKeptTimes(null, '/edit id:abc', true), 'raw slash command remembers nothing').toEqual({ kept: null, touch: false })
  expect(stepKeptTimes('#old', '/edit id:abc', true), 'raw slash command clears prior kept query').toEqual({ kept: null, touch: false })
  expect(stepKeptTimes('#old', '/', true), 'bare slash command remembers nothing').toEqual({ kept: null, touch: false })
  expect(stepKeptTimes(null, ' /edit id:abc', true), 'leading space makes slash text an active search').toEqual({ kept: '/edit id:abc', touch: false })
})

test('explicit keepTimes=false always drops the remembered query and touches, even for the same text', () => {
  expect(stepKeptTimes('#child', '#child ', false)).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes('#child', '#other ', false)).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes('#child', '', false)).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes(null, '#child ', false)).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes(null, '', false)).toEqual({ kept: null, touch: true })
})

test('omitted keepTimes keeps times only when the trimmed text matches the remembered query', () => {
  expect(stepKeptTimes('#child', '#child ')).toEqual({ kept: '#child', touch: false })
  expect(stepKeptTimes('#child', '#child')).toEqual({ kept: '#child', touch: false })
  expect(stepKeptTimes('#child', '  #child\t')).toEqual({ kept: '#child', touch: false })
  expect(stepKeptTimes('id:abc123', 'id:abc123')).toEqual({ kept: 'id:abc123', touch: false })

  expect(stepKeptTimes('#child', '#other ')).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes('#child', '#Child ')).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes('#child', '')).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes('#child', '   ')).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes(null, '#child ')).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes(null, '')).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes('', '')).toEqual({ kept: null, touch: true })
  expect(stepKeptTimes('/edit id:abc', '/edit id:abc'), 'raw slash command never matches a remembered query').toEqual({
    kept: null,
    touch: true,
  })
  expect(stepKeptTimes('/edit id:abc', ' /edit id:abc'), 'active search with leading space matches its remembered query').toEqual({
    kept: '/edit id:abc',
    touch: false,
  })
  expect(stepKeptTimes('#parent/child', '  #parent/child '), 'label containing slash keeps padding equivalence').toEqual({
    kept: '#parent/child',
    touch: false,
  })
})

test('a kept navigation to a raw slash command remembers nothing, so prepending a space touches', () => {
  // Back restores `/edit id:abc` (raw slash disables search); prepending a space makes it an
  // active search whose id:abc matches an item and must soft-touch as a typed query
  const afterBack = stepKeptTimes(null, '/edit id:abc', true)
  const afterSpace = stepKeptTimes(afterBack.kept, ' /edit id:abc')
  expect(
    { afterBack, afterSpace },
    'kept navigation to a raw slash command remembers nothing and prepending a space touches'
  ).toEqual({
    afterBack: { kept: null, touch: false },
    afterSpace: { kept: null, touch: true },
  })

  // an active search with a leading space can still be remembered; deleting the leading space
  // turns it into a raw slash command and drops the remembered query so re-adding the space touches
  let state = stepKeptTimes(null, ' /edit id:abc', true)
  expect(state, 'kept navigation to spaced slash text remembers it as an active search').toEqual({
    kept: '/edit id:abc',
    touch: false,
  })
  state = stepKeptTimes(state.kept, '/edit id:abc')
  expect(state, 'removing leading space to a raw slash command drops the remembered query').toEqual({
    kept: null,
    touch: true,
  })
  state = stepKeptTimes(state.kept, ' /edit id:abc')
  expect(state, 're-adding leading space after command touches').toEqual({ kept: null, touch: true })
})

test('kept visits survive repeated re-rankings and end on a pending draft, another query, clear, or explicit false', () => {
  // kept nav followed by repeated passive re-rankings stays untouched
  let state = stepKeptTimes(null, '#a ', true)
  expect(state).toEqual({ kept: '#a', touch: false })
  for (let i = 0; i < 3; i++) {
    state = stepKeptTimes(state.kept, '#a ')
    expect(state).toEqual({ kept: '#a', touch: false })
  }

  // typing a different draft (even before debounce fires) ends the kept visit even if typed back
  state = stepKeptTimes(state.kept, '#a x')
  expect(state).toEqual({ kept: null, touch: true })
  state = stepKeptTimes(state.kept, '#a ')
  expect(state).toEqual({ kept: null, touch: true })

  // explicit false ends the kept visit so a later passive re-ranking touches
  state = stepKeptTimes(null, '#a ', true)
  state = stepKeptTimes(state.kept, '#a ', false)
  expect(state).toEqual({ kept: null, touch: true })
  state = stepKeptTimes(state.kept, '#a ')
  expect(state).toEqual({ kept: null, touch: true })

  // kept nav to empty clears the remembered query so a later omitted call touches
  state = stepKeptTimes(null, '#a ', true)
  state = stepKeptTimes(state.kept, '', true)
  expect(state).toEqual({ kept: null, touch: false })
  state = stepKeptTimes(state.kept, '#a ')
  expect(state).toEqual({ kept: null, touch: true })
})
