import { expect, test } from '@playwright/test'
import {
  SHARED_HOST,
  getHostDir,
  isAllowedProxyOrigin,
  isLoopbackAddress,
  sharedOriginRedirect,
  // @ts-expect-error host.js is plain js shared with the node server, without a declaration file
} from '../../src/host.js'

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

// round-19 finding 5: the proxy gate read only the socket address, which identifies the browser
// PROCESS. a page on any origin can open a WebSocket to 127.0.0.1, and a WebSocket has no CORS
// response gate, so `Origin: https://attacker.example` handshook successfully and the outbound
// request happened. the origin is therefore part of the gate
test('proxy origins: our own local origins are allowed, foreign and opaque ones are not', () => {
  for (const origin of [
    undefined, // not browser-initiated (curl, a local script): a caller that is already local
    '',
    'http://localhost:3100',
    'https://localhost',
    'http://127.0.0.1:3000',
    'http://127.0.0.5', // the whole loopback block, as with isLoopbackAddress
    'http://[::1]:5173',
    'https://local.dev', // an EXACT local dev alias
  ])
    expect(isAllowedProxyOrigin(origin as any), String(origin)).toBe(true)
  for (const origin of [
    'https://attacker.example',
    'http://mind.page', // a DEPLOYED origin is not a local one: the proxy exists only locally
    'https://shared.mind.page',
    'null', // the opaque origin a sandboxed frame sends
    'not a url',
    'http://127.0.0.1.attacker.example', // suffix, not loopback
    // canonicalizeHost maps `localhost.<anything>` to 'localhost' for DISPLAY. reusing it here
    // would have let an attacker-registered domain pass, so the check is exact-match only
    'http://localhost.attacker.example',
    'http://localhost.localdomain',
    'http://192.168.86.101', // canonicalizeHost calls this localhost too; it is LAN, not loopback
    'http://local.dev.attacker.example',
  ])
    expect(isAllowedProxyOrigin(origin as any), String(origin)).toBe(false)
})

// round-19 finding 5 asked for the vite/preview wiring to be PINNED, not just asserted once by
// hand: the dev and preview servers mount the same middleware stack and bind the wildcard
// address, so a hook that loses its guard silently exposes the proxy to the whole LAN. this is a
// source-level check on purpose — it fails loudly if either call is dropped or renamed
test('both vite server hooks enable the local proxy and guard its upgrades', async () => {
  const fs = await import('fs')
  const config = fs.readFileSync(new URL('../../vite.config.mts', import.meta.url), 'utf8')
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const body = config.slice(config.indexOf(`${hook}: server => {`))
    expect(body, `${hook} is present`).not.toBe('')
    const scope = body.slice(0, body.indexOf('\n      },'))
    expect(scope, `${hook} enables the proxy`).toContain('enableLocalProxy()')
    expect(scope, `${hook} guards upgrades`).toContain('guardProxyUpgrades(server.httpServer)')
  }
})

// the cloud function must not merely REFUSE the arbitrary-target proxy (that was a property of
// the hosting frontend's socket address, not of this code) — it must never construct or mount it
test('the cloud function never enables the local proxy', async () => {
  const fs = await import('fs')
  const source = fs.readFileSync(new URL('../../src/firebase/functions.ts', import.meta.url), 'utf8')
  expect(source.replace(/\/\/.*$/gm, '')).not.toContain('enableLocalProxy')
})
