import { expect, test } from '@playwright/test'
import { createHmac } from 'crypto'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { createServer, type Server } from 'http'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { ADMIN, ALICE, firestore } from './helpers.js'

// server.ts contract over http (no browser): the ssr shell and its session fields, pwa scopes and
// manifests, host-dependent icons, /user, webhooks, the cors proxy and the localhost-only dev routes

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')

// session fields serialized into the page by the server load (see +page.server.js)
function preloaded(html: string): Record<string, string> {
  const fields = [...html.matchAll(/(server_name|server_ip|client_ip)\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
  expect(fields.length, 'serialized session fields').toBeGreaterThan(0)
  return Object.fromEntries(fields.map(([, k, v]) => [k, v]))
}

test.describe('ssr shell', () => {
  test('serves the app with session fields, honoring the proxy-forwarded client ip', async ({ request }) => {
    const res = await request.get('/', { headers: { 'X-Forwarded-For': '203.0.113.7', 'Accept-Encoding': 'gzip' } })
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('text/html')
    expect(res.headers()['content-encoding'], 'compression').toBe('gzip')
    const html = await res.text()
    expect(html).toMatch(/<div id="?sapper"?[ >]/) // app root (attributes may follow, or be unquoted by a minifier)
    expect(html).toContain('<title>localhost</title>') // hostname, canonicalized (see util.js)
    expect(html).toContain('<link rel="manifest" href="manifest.json?v=') // relative, so scoped (see below)
    expect(html).toContain('href="other/favicon.ico?v=') // icons from the host directory under static/
    const session = preloaded(html)
    expect(session.client_ip).toBe('203.0.113.7') // trust proxy (firebase hosting)
    expect(session.server_name).toBeTruthy()
    expect(session.server_ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })

  test('renders for the product host and canonicalizes local hosts', async ({ request }) => {
    const product = await (await request.get('/', { headers: { Host: 'mind.page' } })).text()
    expect(product).toContain('<title>mind.page</title>')
    expect(product).toContain('href="mind.page/favicon.ico?v=')
    const local = await (await request.get('/', { headers: { Host: '127.0.0.1:3100' } })).text()
    expect(local).toContain('<title>localhost</title>')
  })

  test('unknown paths are 404', async ({ request }) => {
    const res = await request.get('/no-such-page')
    expect(res.status()).toBe(404)
    expect(await res.text()).toMatch(/Not [Ff]ound/)
    // except the chrome devtools probe, whose 404 would be noise in dev logs
    expect((await request.get('/.well-known/appspecific/com.chrome.devtools.json')).status()).toBe(204)
  })
})

test.describe('crawlable public pages', () => {
  // public (anonymous) and shared pages carry server-rendered content and meta tags for crawlers
  // and link unfurlers (see $lib/server/content); the app replaces the content on mount
  test('the public account serves its items without javascript', async ({ request }) => {
    const html = await (await request.get('/', { headers: { Host: 'mindbox.io' } })).text()
    expect(html).toMatch(/<meta name="description" content="[^"]+"/)
    expect(html).toContain('#load function for loading external libraries') // item text in the body
  })

  test('a shared page serves its item without javascript', async ({ request }) => {
    const html = await (
      await request.get('/?shared=crawl_e2e/public', { headers: { 'X-Forwarded-Host': 'mind.page' } })
    ).text()
    expect(html).toMatch(/<meta property="og:title" content="public @ mind.page"/) // forwarded host, not the function's
    expect(html).toContain('a shared item for crawlers')
  })

  test('a browser without javascript sees the content, not the spinner', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    try {
      const page = await context.newPage()
      await page.goto('/?shared=crawl_e2e/public')
      await expect(page.getByText('a shared item for crawlers')).toBeVisible()
      await expect(page.locator('.loading')).toBeHidden() // the noscript style hides the overlay
    } finally {
      await context.close()
    }
  })

  test('a frozen render replaces the markdown fallback once captured, keeping math and canvas', async ({ request }) => {
    test.setTimeout(240_000) // captures in a real browser, then polls through the 60s content cache
    // the frozen render's contract includes charts drawn and math typeset (see prerender.mjs):
    // seed an item whose capture must carry a mathjax svg equation and a canvas husk through the
    // final sanitizer (its constrained svg profile, see $lib/server/content.js)
    await firestore()
      .collection('items')
      .doc('e2e-frozen-math')
      .set({
        user: 'anonymous',
        time: Date.now(),
        text: '#e2e_frozen_math #_pin typeset $`e=mc^2`$ and keep <canvas width="80" height="40"></canvas>',
      })
    // capture the app's default view from the running server into the emulator (see prerender.mjs)
    try {
      execSync('node prerender.mjs http://localhost:3100', { cwd: repo, stdio: 'pipe', timeout: 120_000 })
      await expect
        .poll(async () => (await request.get('/')).text(), { timeout: 90_000, intervals: [5_000] })
        .toMatch(/ssr-content[^]*class="items/) // the captured items region, not the markdown fallback
      const html = await (await request.get('/')).text()
      // the injected block is sanitized: no scripts or handlers from item content (the page's own
      // kit scripts live outside the block)
      const block = html.slice(html.indexOf('class="ssr-content"'), html.indexOf('id="sapper"'))
      expect(block.length).toBeGreaterThan(1000)
      expect(block).not.toContain('<script')
      expect(block).not.toContain('onclick')
      expect(block).not.toContain('onmousedown')
      // the equation survives as mathjax svg (fontCache 'local': glyph defs + fragment <use>),
      // and the canvas husk survives (its pixels never serialize; layout is preserved)
      const item = block.slice(block.indexOf('e2e_frozen_math'))
      expect(item).toMatch(/<svg[^>]*viewbox=/i)
      expect(item).toMatch(/<use[^>]*href="#/)
      expect(item).toMatch(/<path[^>]*d="/)
      expect(item).toContain('<canvas width="80" height="40">')
    } finally {
      await firestore().collection('items').doc('e2e-frozen-math').delete()
      await firestore().collection('prerender').doc('anonymous').delete() // restore the markdown fallback
    }
  })

  test('item-authored html cannot execute in the injected page content', async ({ request, browser }) => {
    // a shared page renders ANOTHER user's items into this origin, ahead of the app container: a
    // surviving script or event handler would run before client boot could remove it, with access
    // to the secret in localStorage. item text is therefore rendered as markdown with its html
    // ESCAPED (see renderMarkdown in $lib/server/content.js). the payload is written and removed
    // here, under its own shared key, so no other test sees it
    await firestore()
      .collection('items')
      .doc('e2e-hostile')
      .set({
        user: 'crawl_e2e',
        time: Date.now(),
        text: [
          '#e2e_hostile payload follows',
          '<script>window.__XSS_RAN = 1</script>',
          '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onerror="window.__XSS_RAN = 1">',
          '<a href="javascript:window.__XSS_RAN = 1">click</a>',
          '<div onclick="window.__XSS_RAN = 1" style="background:url(javascript:1)">styled</div>',
          // markdown-AUTHORED forms: raw html is escaped, but marked GENERATES anchors from link
          // syntax with the url scheme passed through — these must be dropped by the sanitizer
          '[md link](javascript:window.__XSS_RAN%20=%201)',
          '![md image](javascript:window.__XSS_RAN%20=%201)',
          '[md ref][1]',
          '',
          '[1]: javascript:window.__XSS_RAN=1',
          '',
          '> a blockquote that must still render as one',
          '',
          // regex substitution patterns: as a string replacement these would splice page markup
          // into the block (see transformPageChunk in hooks.server.js)
          'patterns: $& and $\' and $` must stay literal',
        ].join('\n'),
        attr: { shared: { keys: ['hostile'], indices: { hostile: 0 } } },
      })
    try {
      const html = await (await request.get('/?shared=crawl_e2e/hostile')).text()
      const block = html.slice(html.indexOf('class="ssr-content"'), html.indexOf('id="sapper"'))
      expect(block).toContain('payload follows') // the item IS rendered
      expect(block).toContain('&lt;script&gt;') // ... with its html inert, as text
      expect(block).toContain('<blockquote>') // ... and markdown itself still renders
      // item text cannot splice page markup: exactly ONE app container, and the page ends normally
      expect(html.match(/id="sapper"/g) ?? []).toHaveLength(1)
      expect(block).toContain('patterns: $&amp; and $\' and $` must stay literal')
      expect(block).not.toMatch(/<script/i) // no active markup of any kind
      expect(block).not.toMatch(/<[a-z]+[^>]*\son\w+\s*=/i) // no event-handler attributes
      // no ACTIVE javascript: url on any tag (the escaped raw payload legitimately contains the
      // characters 'href="javascript:' as inert text) — markdown-authored links included
      expect(block).not.toMatch(/<[a-z][^>]*\s(href|src)\s*=\s*["']?javascript:/i)
      expect(block).toContain('<a>md link</a>') // the link parsed, and its href was dropped
      expect(block).not.toMatch(/<(iframe|object|embed|form)/i)
      // nothing in the injected block executes with javascript enabled: the app's own bundle is
      // blocked so only server-injected content can run (once the app boots it evaluates item
      // code by design — visiting a shared page runs that page owner's items, as on the app's own
      // pages; the server block must not be a second, pre-boot execution path)
      const context = await browser.newContext()
      try {
        const page = await context.newPage()
        await page.route(/_app\/immutable/, route => route.abort())
        await page.goto('/?shared=crawl_e2e/hostile')
        await page.waitForTimeout(3_000)
        expect(await page.evaluate(() => (window as any).__XSS_RAN ?? null)).toBeNull()
        await expect(page.getByText('payload follows')).toBeVisible() // and the text is readable
      } finally {
        await context.close()
      }
    } finally {
      await firestore().collection('items').doc('e2e-hostile').delete()
    }
  })

  test('a signed-in session gets no server-rendered content', async ({ request }) => {
    const html = await (await request.get('/', { headers: { Cookie: '__session=some-id-token' } })).text()
    expect(html).not.toContain('#load function for loading external libraries')
    expect(html).not.toMatch(/<meta property="og:title"/) // note the template carries a static description meta
    // the <!--ssr-content--> placeholder comment stays on every page (see hooks.server.js); only
    // the injected content div must be absent
    expect(html).not.toContain('class="ssr-content"')
  })
})

test.describe('pwa scopes', () => {
  // numeric prefixes allow multiple installs of the app on one device, with an optional display mode
  // letter (f: fullscreen, s: standalone, m: minimal-ui, b: browser), see server.ts
  for (const [prefix, display] of [
    ['/', 'standalone'],
    ['/2f/', 'fullscreen'],
    ['/3m/', 'minimal-ui'],
    ['/b/', 'browser'],
    ['/9/', 'standalone'],
  ]) {
    test(`${prefix} serves the app with a ${display} manifest scoped to it`, async ({ request }) => {
      const page = await request.get(prefix)
      expect(page.status()).toBe(200)
      expect(await page.text()).toMatch(/<div id="?sapper"?[ >]/) // served in place, not redirected
      const manifest = await (await request.get(prefix + 'manifest.json')).json()
      expect(manifest).toMatchObject({
        scope: prefix,
        start_url: prefix,
        display,
        name: 'localhost' + prefix.replace(/\/$/, ''),
        theme_color: '#111',
      })
      expect(manifest.icons.map((i: { src: string }) => i.src)).toContain('other/apple-touch-icon.png')
    })
  }
})

test.describe('icons', () => {
  for (const host of ['localhost', 'mind.page']) {
    test(`are served for ${host}`, async ({ request }) => {
      const headers: Record<string, string> = host == 'localhost' ? {} : { Host: host }
      for (const [path, type] of [
        ['/favicon.ico', /image\/(x-icon|vnd\.microsoft\.icon)/], // express 5 serves the iana type
        ['/icon.png', /image\/(x-icon|vnd\.microsoft\.icon)/], // favicon.ico under another name
        ['/apple-touch-icon.png', /image\/png/],
      ] as [string, RegExp][]) {
        const res = await request.get(path, { headers })
        expect(res.status(), path).toBe(200)
        expect(res.headers()['content-type'], path).toMatch(type)
        expect((await res.body()).length, path).toBeGreaterThan(100)
      }
    })
  }
})

test('/server_id identifies the server process', async ({ request }) => {
  const a = await request.get('/server_id')
  expect(a.status()).toBe(200)
  expect(a.headers()['content-type']).toContain('text/plain')
  const id = await a.text()
  expect(id).toMatch(/^\w{8,}$/)
  expect(await (await request.get('/server_id')).text()).toBe(id)
})

test.describe('/user/<uid>', () => {
  test('returns the display name, preferring the custom one', async ({ request }) => {
    expect(await (await request.get(`/user/${ADMIN.uid}`)).text()).toBe('Olcan (seeded)')
    expect(await (await request.get(`/user/${ALICE.uid}`)).text()).toBe('Alice (custom)') // mindpageDisplayName
  })

  test('returns an empty name for unknown users and 400 for invalid paths', async ({ request }) => {
    const unknown = await request.get('/user/nosuchuser')
    expect(unknown.status()).toBe(200)
    expect(await unknown.text()).toBe('')
    const invalid = await request.get('/user/not-a-uid!')
    expect(invalid.status()).toBe(400)
    expect(await invalid.text()).toContain('invalid user path')
  })
})

test.describe('webhooks', () => {
  test('/webhooks stores the payload for the user', async ({ request }) => {
    const body = { event: 'e2e', n: 1 }
    const res = await request.post(`/webhooks?user=${ALICE.uid}&source=e2e`, { data: body })
    expect(res.status()).toBe(200)
    await expect
      .poll(async () => {
        const snap = await firestore().collection('webhooks').where('user', '==', ALICE.uid).get()
        return snap.docs.map((d: any) => d.data())
      })
      .toMatchObject([{ user: ALICE.uid, source: 'e2e', body }])
  })

  test('/webhooks requires a user and answers crc challenges', async ({ request }) => {
    const missing = await request.post('/webhooks', { data: {} })
    expect(missing.status()).toBe(400)
    expect(await missing.text()).toContain('missing user')
    const crc = await request.get('/webhooks?crc_token=token123&crc_key=key456')
    expect(crc.status()).toBe(200)
    expect(await crc.json()).toEqual({
      response_token: 'sha256=' + createHmac('sha256', 'key456').update('token123').digest('base64'),
    })
  })

  test('/github_webhooks stores the payload', async ({ request }) => {
    const body = { ref: 'refs/heads/e2e', repository: { full_name: 'olcan/e2e' } }
    expect((await request.post('/github_webhooks', { data: body })).status()).toBe(200)
    await expect
      .poll(async () => (await firestore().collection('github_webhooks').get()).docs.map((d: any) => d.data().body))
      .toContainEqual(body)
  })
})

test.describe('cors proxy', () => {
  // /proxy/<backend>/<path> forwards to the backend (following redirects there), see server.ts
  let backend: Server
  let origin: string
  test.beforeAll(async () => {
    backend = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        if (req.url == '/redirect') {
          res.writeHead(302, { Location: '/echo?from=redirect' })
          return res.end()
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, url: req.url, type: req.headers['content-type'] ?? null, body }))
      })
    })
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
    const address = backend.address()
    origin = `http://127.0.0.1:${typeof address == 'object' && address ? address.port : 0}`
  })
  test.afterAll(() => new Promise<void>(resolve => backend.close(() => resolve())))

  test('forwards requests with their path, query and body', async ({ request }) => {
    const get = await request.get(`/proxy/${origin}/echo?x=1`)
    expect(get.status()).toBe(200)
    expect(await get.json()).toMatchObject({ method: 'GET', url: '/echo?x=1' })
    const post = await request.post(`/proxy/${origin}/echo`, { data: { a: 1 } })
    expect(await post.json()).toMatchObject({ method: 'POST', url: '/echo', type: 'application/json', body: '{"a":1}' })
  })

  test('follows backend redirects and tolerates a collapsed scheme slash', async ({ request }) => {
    const redirected = await request.get(`/proxy/${origin}/redirect`, { maxRedirects: 0 })
    expect(redirected.status()).toBe(200) // followed by the proxy, not by this client
    expect(await redirected.json()).toMatchObject({ url: '/echo?from=redirect' })
    const collapsed = await request.get(`/proxy/${origin.replace('://', ':/')}/echo`)
    expect(await collapsed.json()).toMatchObject({ url: '/echo' })
  })
})

test.describe('localhost-only dev routes', () => {
  test('/file_abs serves local files and /preview a localStorage viewer', async ({ request }) => {
    const abs = await request.get(`/file_abs${resolve(repo, 'package.json')}`)
    expect(abs.status()).toBe(200)
    expect(await abs.text()).toBe(readFileSync(resolve(repo, 'package.json'), 'utf8'))
    const preview = await request.get('/preview')
    expect(preview.status()).toBe(200)
    expect(await preview.text()).toContain('localStorage.getItem(')
  })

  test('/file serves files from checkouts next to the repo', async ({ request }) => {
    const sibling = resolve(repo, '../mind.items/tester.md')
    test.skip(!existsSync(sibling), 'no ../mind.items checkout')
    const file = await request.get('/file/mind.items/tester.md')
    expect(file.status()).toBe(200)
    expect(await file.text()).toBe(readFileSync(sibling, 'utf8'))
  })

  test('are not available on other hosts', async ({ request }) => {
    const res = await request.get(`/file_abs${resolve(repo, 'package.json')}`, { headers: { Host: 'mind.page' } })
    expect(res.status()).toBe(404)
  })
})
