import { expect, test } from '@playwright/test'
import {
  SHARED_HOST,
  SHARED_LOCAL_HOST,
  getHostDir,
  isProxyRequestAllowed,
  isLoopbackAddress,
  isSharedOrigin,
  sharedOriginRedirect,
  // @ts-expect-error host.js is plain js shared with the node server, without a declaration file
} from '../../src/host.js'

// the isolated-origin decision is a SECURITY control (see sharedOriginRedirect): a shared page
// runs its owner's code, and the origin is the only real boundary against it, so the rule for
// which pages move there is pinned directly rather than inferred from browser behavior

const decide = (over = {}) =>
  sharedOriginRedirect({
    host: 'mind.page',
    shared: 'alice/notes',
    uid: undefined,
    path: '/',
    search: '?shared=alice/notes',
    ...over,
  })

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

test('never redirects into a loop', () => {
  expect(decide({ host: SHARED_HOST })).toBeNull() // already there
})

test("someone else's shared page moves on a LOCAL host too, to the local isolated origin", () => {
  // local hosts used to be exempt, on the grounds that there was no second origin to move to.
  // that left the one place the origin split did not apply: a stranger's code ran on the
  // developer's own origin, beside their session, with the local proxy reachable
  for (const host of ['localhost', '127.0.0.1', 'local.dev', '[::1]'])
    expect(decide({ host, protocol: 'http:', port: '3100' }), host).toBe(
      `http://${SHARED_LOCAL_HOST}:3100/?shared=alice/notes`
    )
  // scheme and port are PRESERVED: the dev server and the e2e stack serve this origin themselves,
  // and the emulator switch keys on port 3100
  expect(decide({ host: 'localhost', protocol: 'https:', port: '' })).toBe(
    `https://${SHARED_LOCAL_HOST}/?shared=alice/notes`
  )
  expect(decide({ host: SHARED_LOCAL_HOST })).toBeNull() // already isolated: no loop
  // the owner's own shared page still stays put, locally as anywhere else
  expect(decide({ host: 'localhost', uid: 'alice' })).toBeNull()
})

test('isSharedOrigin covers BOTH isolated origins, and no near miss', () => {
  // every persistence rule keys on this one predicate (firestore cache, item store, github token,
  // the startup storage scrub in +page.js); pairing hostname comparisons by hand is how the local
  // origin kept persisting after the deployed one was fixed
  for (const host of [SHARED_HOST, SHARED_LOCAL_HOST]) expect(isSharedOrigin(host), host).toBe(true)
  for (const host of [
    'mind.page',
    'localhost',
    'local.dev',
    'olcan.com',
    'shared.mind.page.attacker.example', // suffix, not the origin
    'evil-shared.mind.page', // prefix, not the origin
    'shared.localhost.attacker.example',
    'SHARED.MIND.PAGE', // location.hostname is already lowercased; an exact match is intended
    '',
    undefined,
  ])
    expect(isSharedOrigin(host as any), String(host)).toBe(false)
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

// round-20 findings 4 and 5: `(address, origin)` was not enough. an absent Origin does NOT mean a
// non-browser caller — browsers omit it on GET/HEAD navigations and no-cors requests, which is the
// dangerous case — and comparing only the origin's HOSTNAME ignores scheme and port, so any page on
// any port of an allowed name qualified. review reproduced both against the previous code
const ALLOWED = { address: '127.0.0.1', host: 'localhost:3100', secure: false }
test('the proxy gate reads the whole request, not an address and a hostname', () => {
  const allow = (over: Record<string, unknown>) => isProxyRequestAllowed({ ...ALLOWED, ...over })
  // full origin equality: scheme, host AND port
  expect(allow({ origin: 'http://localhost:3100' }), 'exact same origin').toBe(true)
  expect(allow({ origin: 'http://localhost:9999' }), 'port mismatch').toBe(false)
  expect(allow({ origin: 'https://localhost:3100' }), 'scheme mismatch').toBe(false)
  expect(allow({ origin: 'http://127.0.0.1:3100' }), 'host mismatch, both local').toBe(false)
  expect(allow({ origin: 'https://attacker.example' }), 'foreign origin').toBe(false)
  expect(allow({ origin: 'null' }), 'opaque origin').toBe(false)
  expect(
    isProxyRequestAllowed({ address: '::1', host: '[::1]:3100', secure: false, origin: 'http://[::1]:3100' }),
    'ipv6 literal, matching'
  ).toBe(true)
  expect(
    isProxyRequestAllowed({
      address: '127.0.0.1',
      host: 'local.dev:443',
      secure: true,
      origin: 'https://local.dev:443',
    }),
    'https dev alias, matching'
  ).toBe(true)
  // shared.localhost is the LOCAL ISOLATED ORIGIN for foreign shared pages (see SHARED_LOCAL_HOST):
  // the proxy refuses it even though it is loopback and same-origin, because serving other
  // people's code there is the whole point of it
  expect(
    isProxyRequestAllowed({
      address: '127.0.0.1',
      host: 'shared.localhost:3100',
      secure: false,
      origin: 'http://shared.localhost:3100',
    }),
    'the local isolated origin is proxy-free'
  ).toBe(false)
  // no Origin: fetch metadata decides, and anything but same-origin is refused
  expect(allow({ secFetchSite: 'same-origin' }), 'same-origin navigation').toBe(true)
  expect(allow({ secFetchSite: 'cross-site' }), 'THE reproduced exploit: cross-site, no Origin').toBe(false)
  expect(allow({ secFetchSite: 'same-site' }), 'same-site is not same-origin').toBe(false)
  expect(allow({ secFetchSite: 'none' }), 'user-initiated navigation').toBe(false)
  // neither: fail CLOSED unless a local tool opts in with a header no page can set on a
  // navigation or a no-cors request
  expect(allow({}), 'no origin, no fetch metadata').toBe(false)
  expect(allow({ optIn: true }), 'explicit local opt-in').toBe(true)
  // the address and the request host are both still required to be local
  expect(allow({ address: '10.0.0.5', origin: 'http://localhost:3100' }), 'non-loopback peer').toBe(false)
  for (const host of ['localhost.attacker.example', 'local.dev.attacker.example', '192.168.86.101', 'mind.page'])
    expect(allow({ host: `${host}:3100`, origin: `http://${host}:3100` }), host).toBe(false)
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
