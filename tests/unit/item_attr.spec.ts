import { expect, test } from '@playwright/test'
import { stripAttrToken } from '../../src/item_attr.js'

test('stripAttrToken drops an own token without mutating the input or other attributes', () => {
  const original = {
    sha: 'abc123',
    editable: false,
    pushable: false,
    source: 'https://github.com/olcan/mind.items/blob/master/load.md',
    path: 'load.md',
    repo: 'mind.items',
    branch: 'master',
    owner: 'olcan',
    token: 'ghp_fake_token',
    embeds: [{ path: 'load.js', sha: 'abc123', body: '// load.js' }],
    shared: { keys: ['k'], indices: { k: 0 } },
  }
  const stripped = stripAttrToken(original)
  expect(stripped).not.toBe(original)
  expect('token' in stripped).toBe(false)
  expect(stripped).toEqual({
    sha: 'abc123',
    editable: false,
    pushable: false,
    source: 'https://github.com/olcan/mind.items/blob/master/load.md',
    path: 'load.md',
    repo: 'mind.items',
    branch: 'master',
    owner: 'olcan',
    embeds: [{ path: 'load.js', sha: 'abc123', body: '// load.js' }],
    shared: { keys: ['k'], indices: { k: 0 } },
  })
  // original object untouched
  expect(original.token).toBe('ghp_fake_token')
  // idempotent: stripping again returns the same object reference
  expect(stripAttrToken(stripped)).toBe(stripped)
})

test('stripAttrToken drops empty, null, and undefined own token values', () => {
  for (const token of ['', null, undefined]) {
    const out = stripAttrToken({ sha: '1', token })
    expect('token' in out).toBe(false)
    expect(out).toEqual({ sha: '1' })
  }
  expect(stripAttrToken({ token: 'only' })).toEqual({})
})

test('stripAttrToken returns objects without an own token unchanged by reference', () => {
  const clean = { sha: 'abc', shared: null }
  expect(stripAttrToken(clean)).toBe(clean)
  const empty = {}
  expect(stripAttrToken(empty)).toBe(empty)
  // inherited `token` on a prototype is not an own property
  const proto = { token: 'inherited' }
  const child = Object.create(proto)
  child.sha = 'abc'
  expect(stripAttrToken(child)).toBe(child)
})

test('stripAttrToken passes nullish, primitive, and array values through unchanged', () => {
  expect(stripAttrToken(null)).toBeNull()
  expect(stripAttrToken(undefined)).toBeUndefined()
  expect(stripAttrToken('str')).toBe('str')
  expect(stripAttrToken(42)).toBe(42)
  const arr = ['a']
  expect(stripAttrToken(arr)).toBe(arr)
})
