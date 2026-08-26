import { expect, test } from '@playwright/test'
// @ts-expect-error host.js is plain js shared with the node server, without a declaration file
import { SHARED_HOST, getHostDir, isLoopbackAddress, sharedOriginRedirect } from '../../src/host.js'

// the isolated-origin decision is a SECURITY control (see sharedOriginRedirect): a shared page
// runs its owner's code, and the origin is the only real boundary against it, so the rule for
// which pages move there is pinned directly rather than inferred from browser behavior

const decide = (over = {}) =>
  sharedOriginRedirect({ host: 'mind.page', shared: 'alice/notes', uid: undefined, path: '/', search: '?shared=alice/notes', ...over })

test("someone else's shared page moves to the isolated origin, with its url intact", () => {
  expect(decide()).toBe(`https://${SHARED_HOST}/?shared=alice/notes`)
  expect(decide({ path: '/x', search: '?shared=alice/notes', hash: '#item' })).toBe(
    `https://${SHARED_HOST}/x?shared=alice/notes#item`
  )
  // a signed-in visitor who is NOT the owner moves too: their session is exactly what is at risk
  expect(decide({ uid: 'bob' })).toBe(`https://${SHARED_HOST}/?shared=alice/notes`)
})

test('the owner stays on their own domain, where their shared page is theirs to write', () => {
  expect(decide({ uid: 'alice' })).toBeNull()
  // '?shared=<key>' carries no owner prefix: it is the visitor's own page by construction
  expect(decide({ shared: 'e2e-key', search: '?shared=e2e-key' })).toBeNull()
})

test('never redirects into a loop, and never on localhost', () => {
  expect(decide({ host: SHARED_HOST })).toBeNull() // already there
  expect(decide({ host: 'localhost' })).toBeNull()
  expect(decide({ host: '127.0.0.1' })).toBeNull() // canonicalized (dev/e2e stack)
  expect(decide({ host: 'local.dev' })).toBeNull()
})

test('a page that is not shared at all is untouched', () => {
  expect(decide({ shared: undefined })).toBeNull()
  expect(decide({ shared: '' })).toBeNull()
})

test('the isolated origin gets its own icons, distinct from the account domains', () => {
  // deliberate: a foreign shared page should not look like the tab you are signed in on
  expect(getHostDir(SHARED_HOST)).toBe('other')
  expect(getHostDir('mind.page')).toBe('mind.page')
  expect(getHostDir('mindbox.io')).toBe('mindbox.io')
})

test('loopback detection covers every form node reports, and nothing else', () => {
  // this predicate is the proxy's authorization boundary (see guardProxyUpgrades), and it had no
  // test at all. an exact-string check would reject valid loopback addresses like 127.118.40.220
  for (const address of ['127.0.0.1', '127.0.0.53', '127.118.40.220', '127.255.255.255', '::1', '::ffff:127.0.0.1'])
    expect(isLoopbackAddress(address), address).toBe(true)
  for (const address of [
    '10.0.0.248', // ordinary LAN
    '192.168.1.128',
    '128.0.0.1', // one bit off the loopback block
    '27.0.0.1',
    '::ffff:10.0.0.1', // mapped, but not loopback
    '2001:db8::1',
    '127.0.0.256', // invalid octet
    '127.0.0',
    'localhost', // a name, not an address
    '',
    undefined,
  ])
    expect(isLoopbackAddress(address as any), String(address)).toBe(false)
})
