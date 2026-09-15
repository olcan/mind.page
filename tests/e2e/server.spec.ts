import { expect, test } from '@playwright/test'
import { createHmac } from 'crypto'
import { execSync, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { createServer, type Server } from 'http'
import { delimiter, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { ADMIN, ALICE, PROFILE_ONLY, firestore, waitForApp } from './helpers.js'
import { E2E_LANES, lanePort, laneProject } from '../../src/e2e_lanes.js'
import { REWRITER, VENDOR_HOSTS } from '../../src/server/vendor_shell.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

// server.ts contract over http (no browser): the ssr shell and its session fields, pwa scopes and
// manifests, host-dependent icons, /user, webhooks, the cors proxy and the localhost-only dev routes

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')

// the local proxy's per-host secret (vault design mind_task_agents 9.7 and 9.9): the lane servers
// run under the run's THROWAWAY home (playwright.config.ts, E2E_HOME) and created their secret
// there, so it is this run's own, never the owner's: sending it, and a retained failure trace
// holding it, disclose nothing reusable. read when a test needs it, never at import (a fresh
// home has none until a server started)
function laneSecret(): string {
  const home = process.env.E2E_HOME
  if (!home) throw new Error('E2E_HOME is unset: the lane servers run under a throwaway home (playwright.config.ts)')
  return readFileSync(resolve(home, '.mindpage', 'proxy_secret'), 'utf8').trim()
}

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
    test.setTimeout(180_000) // captures in a real browser; the content cache is pinned to 100ms in tests
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
      // the capture's own browser (a separate launch, not a lane) resolves loopback only under the
      // gate (E2E_OFFLINE, tests/e2e/run.sh): prerender.mjs says so
      const captured = execSync('node prerender.mjs http://localhost:3100', { cwd: repo, stdio: 'pipe', timeout: 120_000 })
      expect(captured.toString(), 'the capture browser is offline').toContain('prerender: browser offline (loopback only)')
      await expect
        .poll(async () => (await request.get('/')).text(), { timeout: 30_000, intervals: [250] })
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
        // no settle wait: an injected inline script executes during PARSING, so it would already
        // have run by the time goto() resolves. waiting 3s afterwards proved nothing it did not
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

test("every cdn loader precedes kit's bootstrap in the BUILT shell, vendored by the lane", async ({ request }) => {
  // tests/unit/app_html.spec.ts pins the exact loader list and their classic/parser-blocking
  // properties in the SOURCE shell. what it cannot see is kit's bootstrap moving above them —
  // %sveltekit.head% precedes those tags, and the bootstrap is generated, not written by hand.
  // this reads the built response and is the whole remaining guarantee: it replaces a browser test
  // that intercepted the c3 request and waited 1.5s to prove the app had not started.
  // a lane server serves the shell VENDORED (src/hooks.server.js under VENDOR_DIR, see
  // src/server/vendor_shell.js): every cdn loader of the source shell as its /vendor/<host>/ copy,
  // none of the vendored origins left, and the rewriter once before the first loader
  const source = readFileSync(resolve(repo, 'src/app.html'), 'utf8')
  const loader = /<script\b[^>]*\bsrc="(https:\/\/[^/"]+\/[^"]+|\/vendor\/[^/"]+\/[^"]+)"[^>]*>/g
  const expected = [...source.matchAll(loader)].map(m => m[1].replace(/^https:\/\/([^/]+)\//, '/vendor/$1/'))
  expect(expected.length, 'the source shell loads cdn scripts').toBeGreaterThan(0)
  expect(
    expected.every(src => src.startsWith('/vendor/')),
    'every source loader is vendored',
  ).toBe(true)
  const html = await (await request.get('/')).text()
  const bootstrap = html.search(/\/_app\/immutable\/entry\/start\.[^"']+/)
  expect(bootstrap, "kit's generated bootstrap is present").toBeGreaterThan(-1)
  // the built external scripts must be EXACTLY the source ones — comparing the lists catches a
  // dropped loader and a build-injected extra alike, where a per-source lookup would miss the
  // second — and every one of them must still be classic, parser-blocking and above the bootstrap
  const built = [...html.matchAll(loader)]
  expect(built.map(m => m[1])).toEqual(expected)
  for (const host of VENDOR_HOSTS) expect(html, `${host} is vendored`).not.toContain(`https://${host}/`)
  expect(html.split(REWRITER).length - 1, 'the rewriter once').toBe(1)
  expect(html.indexOf(REWRITER), 'the rewriter precedes the loaders').toBeLessThan(built[0].index!)
  for (const tag of built) {
    expect(tag[0], `${tag[1]} is still parser-blocking`).not.toMatch(/\basync\b|\bdefer\b/)
    expect(tag[0], `${tag[1]} is still a classic script`).not.toMatch(/type="module"/)
    expect(tag.index, `${tag[1]} precedes the bootstrap`).toBeLessThan(bootstrap)
  }
})

test('a plain server without VENDOR_DIR serves the shell as written', async () => {
  // a throwaway `node server.mjs` on a free port under the LANE'S environment minus the vendoring
  // (the run's throwaway home, the same scoped roots, the explicit loopback bind; the config
  // gives the lane servers these, not the worker process): the cdn loaders verbatim, no /vendor/
  // route named, no rewriter (a production build and the owner's local server are this case),
  // and still a scoped, authenticated fixture server (a file route refuses the bare request)
  test.setTimeout(60_000)
  const home = process.env.E2E_HOME
  expect(home, 'the run home (playwright.config.ts)').toBeTruthy()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    LOCAL_ROUTES_SCOPE: [repo, resolve(process.env.MIND_ITEMS_DIR ?? join(repo, '../mind.items'))].join(delimiter),
    HOST: '127.0.0.1',
    NO_HTTPS: '1',
    PORT: '0',
    NODE_ENV: 'production',
  }
  delete env.VENDOR_DIR
  delete env.VENDOR_UNLISTED
  delete env.FIREBASE_CONFIG
  const child = spawn('node', ['server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  // one close promise for the startup failure and the teardown alike (a closed child never
  // emits again; a failed launch closes without exiting); a spawn error rejects the startup too
  const exited = new Promise<number | null>(done => child.once('close', code => done(code)))
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      let out = ''
      const seen = (chunk: Buffer) => {
        out += chunk
        const m = out.match(/listening on http:\/\/[^:\s]+:(\d+)/)
        if (m) resolvePort(Number(m[1]))
      }
      child.stdout.on('data', seen)
      child.stderr.on('data', seen)
      child.once('error', reject)
      void exited.then(code => reject(new Error(`the server exited ${code}: ${out}`)))
      setTimeout(() => reject(new Error(`no listening line in 30s: ${out}`)), 30_000).unref()
    })
    const base = `http://127.0.0.1:${port}`
    const html = await (await fetch(`${base}/`)).text()
    const source = readFileSync(resolve(repo, 'src/app.html'), 'utf8')
    const loader = /<script\b[^>]*\bsrc="(https:\/\/[^"]+)"[^>]*>/g
    const expected = [...source.matchAll(loader)].map(m => m[1])
    expect(expected.length).toBeGreaterThan(0)
    expect([...html.matchAll(loader)].map(m => m[1])).toEqual(expected)
    expect(html).not.toContain('/vendor/')
    expect(html).not.toContain('data-vendor-rewriter')
    expect((await fetch(`${base}/file/mind.page/package.json`)).status, 'authenticated').toBe(403)
    const outside = await fetch(`${base}/file_abs${resolve(repo, '..')}`, { headers: { 'x-mindpage-local-proxy': laneSecret() } })
    expect(outside.status, 'scoped: the checkouts\' parent is refused even to the secret').toBe(403)
  } finally {
    child.kill('SIGKILL')
    await exited
  }
})

test('item-style cdn loads reach the vendored route in the lane browser; a remote host fails', async ({ page }) => {
  // the runtime rewriter (src/server/vendor_shell.js) turns the absolute cdn urls item code
  // assigns (`script.src = ...` as in mind.items' load.js and todoer.js, a fetch) into the lane's
  // route; the browser's resolver refuses every remote host (playwright.config.ts), so a load can
  // only succeed through the route, and a script from a non-vendored host fails
  await page.goto('/')
  // the refusal reason of the remote load, from the browser: the resolver rule, not an http
  // error or an unsuitable response (which would also fire onerror with networking unrestricted)
  const failures: Record<string, string> = {}
  page.on('requestfailed', request => (failures[request.url()] = request.failure()?.errorText ?? ''))
  const result = await page.evaluate(async () => {
    const load = (src: string) =>
      new Promise<string>(done => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => done('loaded ' + script.getAttribute('src'))
        script.onerror = () => done('failed ' + script.getAttribute('src'))
        document.head.appendChild(script)
      })
    const jstat = await load('https://cdn.jsdelivr.net/npm/jstat/dist/jstat.min.js')
    const d3 = await fetch('https://cdn.jsdelivr.net/npm/d3@5.16.0/dist/d3.min.js')
    const remote = await load('https://example.com/nothing.js')
    return { jstat, jstatType: typeof (window as any).jStat, d3: [d3.ok, new URL(d3.url).pathname], remote }
  })
  expect(result.jstat).toBe('loaded /vendor/cdn.jsdelivr.net/npm/jstat/dist/jstat.min.js')
  expect(['function', 'object']).toContain(result.jstatType)
  expect(result.d3).toEqual([true, '/vendor/cdn.jsdelivr.net/npm/d3@5.16.0/dist/d3.min.js'])
  expect(result.remote).toBe('failed https://example.com/nothing.js')
  expect(failures['https://example.com/nothing.js'], 'refused by the resolver rule').toBe('net::ERR_NAME_NOT_RESOLVED')
})

// LANES (src/e2e_lanes.js): every lane's server reads its own project. two lane projects hold
// different values under the same ids; each server (its port) must serve its own for both the
// profile endpoint and the crawler page content — the default admin app is bound to the lane at
// the server bootstrap (src/server/app.mjs), and a first version bound only the content module
test('lanes: each server reads its own project, for profiles and for page content', async ({ request }) => {
  const lanes = E2E_LANES.slice(0, 2).map(lane => {
    const port = lanePort(lane)
    const project = laneProject(port, 'olcanswiki')
    const app = getApps().find(a => a.name == project) ?? initializeApp({ projectId: project }, project)
    return { port, project, db: getFirestore(app) }
  })
  expect(new Set(lanes.map(l => l.project)).size, 'two distinct lane projects').toBe(2)
  try {
    for (const [i, lane] of lanes.entries()) {
      await lane.db.collection('users').doc('e2e_lane_witness').set({ displayName: `lane witness ${i}` })
      await lane.db
        .collection('items')
        .doc('e2e-lane-witness')
        .set({
          user: 'lane_witness',
          time: Date.now(),
          text: `#e2e_lane_witness shared text of lane ${i}`,
          attr: { shared: { keys: ['public'], indices: { public: 0 } } },
        })
    }
    for (const [i, lane] of lanes.entries()) {
      expect(await (await request.get(`http://localhost:${lane.port}/user/e2e_lane_witness`)).text(), `lane ${i} profile`).toBe(`lane witness ${i}`)
      const html = await (
        await request.get(`http://localhost:${lane.port}/?shared=lane_witness/public`, { headers: { 'X-Forwarded-Host': 'mind.page' } })
      ).text()
      expect(html, `lane ${i} page content`).toContain(`shared text of lane ${i}`)
      expect(html, `lane ${i} never serves the other lane's content`).not.toContain(`shared text of lane ${1 - i}`)
    }
  } finally {
    for (const lane of lanes) {
      await lane.db.collection('users').doc('e2e_lane_witness').delete()
      await lane.db.collection('items').doc('e2e-lane-witness').delete()
    }
  }
})

test.describe('/user/<uid>', () => {
  test('returns the display name, preferring the custom one', async ({ request }) => {
    expect(await (await request.get(`/user/${ADMIN.uid}`)).text()).toBe('Olcan (seeded)')
    // a profile-only uid (see the fixture boundary note in seed.mjs)
    expect(await (await request.get(`/user/${PROFILE_ONLY.uid}`)).text()).toBe(PROFILE_ONLY.custom)
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
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            type: req.headers['content-type'] ?? null,
            body,
            secret_header: req.headers['x-mindpage-local-proxy'] ?? null, // must never arrive
          }),
        )
      })
    })
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
    const address = backend.address()
    origin = `http://127.0.0.1:${typeof address == 'object' && address ? address.port : 0}`
  })
  test.afterAll(() => new Promise<void>(resolve => backend.close(() => resolve())))

  // these are NON-BROWSER callers (playwright's request context sends no Origin and no fetch
  // metadata); every caller, browser or not, presents the lane's secret, which the gate consumes:
  // the backend never sees it
  let local: Record<string, string>
  test.beforeAll(() => {
    local = { 'x-mindpage-local-proxy': laneSecret() }
  })

  test('forwards requests with their path, query and body, the secret consumed', async ({ request }) => {
    const get = await request.get(`/proxy/${origin}/echo?x=1`, { headers: local })
    expect(get.status()).toBe(200)
    expect(await get.json()).toMatchObject({ method: 'GET', url: '/echo?x=1', secret_header: null })
    const post = await request.post(`/proxy/${origin}/echo`, { data: { a: 1 }, headers: local })
    expect(await post.json()).toMatchObject({ method: 'POST', url: '/echo', type: 'application/json', body: '{"a":1}' })
  })

  test('returns a backend redirect unfollowed (the scoped lane) and tolerates a collapsed scheme slash', async ({
    request,
  }) => {
    // the lane servers are SCOPED (playwright.config.ts): a redirect is returned to the caller
    // rather than followed (it could leave the loopback backends the scope allows); the
    // owner's unscoped servers keep following redirects
    const redirected = await request.get(`/proxy/${origin}/redirect`, { maxRedirects: 0, headers: local })
    expect(redirected.status()).toBe(302)
    expect(redirected.headers()['location']).toBe('/echo?from=redirect')
    const collapsed = await request.get(`/proxy/${origin.replace('://', ':/')}/echo`, { headers: local })
    expect(await collapsed.json()).toMatchObject({ url: '/echo' })
  })

  test('refuses an absent or wrong secret whatever the headers say', async ({ request }) => {
    // vault design mind_task_agents 9.9: forged browser metadata does not authorize forwarding
    const cases: Record<string, string>[] = [
      {},
      { 'x-mindpage-local-proxy': '1' }, // the pre-secret opt-in value
      { 'x-mindpage-local-proxy': 'wrong' },
      { 'x-mindpage-local-proxy': local['x-mindpage-local-proxy'] + 'x' },
      { 'sec-fetch-site': 'same-origin' },
      { origin: 'http://localhost:3100', 'sec-fetch-site': 'same-origin' },
    ]
    for (const headers of cases) {
      const refused = await request.get(`/proxy/${origin}/echo`, { headers, failOnStatusCode: false })
      expect(refused.status(), JSON.stringify(Object.keys(headers))).toBe(403)
    }
  })
})

test.describe('localhost-only dev routes', () => {
  // the routes that serve HOST FILES take the proxy's secret (design 9.9; the alias and
  // credential cases run over the actual middleware in tests/unit/file_routes.spec.ts)
  let local: Record<string, string>
  test.beforeAll(() => {
    local = { 'x-mindpage-local-proxy': laneSecret() }
  })

  test('/file_abs serves local files to the secret and /preview a localStorage viewer', async ({ request }) => {
    const refused = await request.get(`/file_abs${resolve(repo, 'package.json')}`, { failOnStatusCode: false })
    expect(refused.status(), 'no secret').toBe(403)
    const abs = await request.get(`/file_abs${resolve(repo, 'package.json')}`, { headers: local })
    expect(abs.status()).toBe(200)
    expect(await abs.text()).toBe(readFileSync(resolve(repo, 'package.json'), 'utf8'))
    const preview = await request.get('/preview')
    expect(preview.status()).toBe(200)
    expect(await preview.text()).toContain('localStorage.getItem(')
  })

  test('/file serves the sibling mind.items checkout to the secret in the scoped lane, never the parent', async ({ request }) => {
    // the lane server's scope has two roots (playwright.config.ts): its own checkout and the
    // sibling mind.items checkout, the gate's install and preview seam (the app fetches the
    // previews of installed items through /file/mind.items/...); their parent is not a root
    const sibling = resolve(repo, '../mind.items/tester.md')
    test.skip(!existsSync(sibling), 'no ../mind.items checkout')
    expect((await request.get('/file/mind.items/tester.md', { failOnStatusCode: false })).status()).toBe(403)
    const file = await request.get('/file/mind.items/tester.md', { headers: local })
    expect(file.status()).toBe(200)
    expect(await file.text()).toBe(readFileSync(sibling, 'utf8'))
    const own = await request.get('/file/mind.page/package.json', { headers: local })
    expect(own.status()).toBe(200)
    expect((await request.get(`/file_abs${resolve(repo, '..')}`, { headers: local, failOnStatusCode: false })).status()).toBe(403)
  })

  test("the app's own fetch carries the lane secret: the preview seam works in a lane browser", async ({ page }) => {
    // the lane's browser origin is provisioned with the run's secret (playwright.config.ts, the
    // storage state), and the app's fetch wrapper attaches it to the file routes, so the app's
    // preview fetches of installed items (/file/mind.items/<name>.md) succeed as they did before
    // the routes were authenticated (a refused preview raises a modal that blocked a tasks row)
    test.skip(!existsSync(resolve(repo, '../mind.items/tester.md')), 'no ../mind.items checkout')
    await page.goto('/')
    await waitForApp(page) // the wrapper is installed by the app's boot, not by the load event
    const statuses = await page.evaluate(async () => [
      (await fetch('/file/mind.items/tester.md')).status,
      (await fetch('/file/mind.page/package.json')).status,
    ])
    expect(statuses).toEqual([200, 200])
  })

  test('are not available on other hosts', async ({ request }) => {
    const res = await request.get(`/file_abs${resolve(repo, 'package.json')}`, {
      headers: { Host: 'mind.page', ...local },
    })
    expect(res.status()).toBe(404)
  })

  test('never serve the proxy secret, secret or not', async ({ request }) => {
    const secretPath = resolve(process.env.E2E_HOME!, '.mindpage', 'proxy_secret')
    for (const headers of [{}, local]) {
      const res = await request.get(`/file_abs${secretPath}`, { headers, failOnStatusCode: false })
      expect(res.status()).toBe(403)
      expect((await res.text()).includes(local['x-mindpage-local-proxy'])).toBe(false)
    }
  })
})

test('a rejected WebSocket upgrade never reaches the backend', async () => {
  // round-18 finding 1: destroying the CLIENT socket does not stop the proxy — node keeps calling
  // its listener, so the outbound connection was still made and cookies forwarded (blind SSRF).
  // the question is therefore what the BACKEND saw, and it must be asked after a settling delay:
  // an earlier version checked the counter immediately, before the outbound request could land.
  // round-19 finding 5: a loopback ADDRESS only identifies the browser process. any page on any
  // origin can open a WebSocket to 127.0.0.1, and a WebSocket has no CORS response gate, so the
  // hostile-origin case below completed its handshake and made the outbound request
  const http = await import('http')
  const os = await import('os')
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i && i.family == 'IPv4' && !i.internal)?.address
  const seen: string[] = []
  const sockets: any[] = []
  const secret = laneSecret()
  const backend = http.createServer((_req, res) => res.end('ok'))
  backend.on('upgrade', (req, socket) => {
    // the header the gate consumed must never arrive (recorded by name, asserted below)
    seen.push(`${req.url} cookie=${req.headers.cookie ?? 'none'} secret=${req.headers['x-mindpage-local-proxy'] ?? 'none'}`)
    sockets.push(socket)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', () => resolve()))
  const port = (backend.address() as any).port // dynamic: a fixed port collides across runs
  const upgrade = (host: string, origin?: string, withSecret = true) =>
    new Promise<string>(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 4_000)
      const done = (outcome: string) => {
        clearTimeout(timer) // otherwise the run is held open by an armed timer
        resolve(outcome)
      }
      const req = http.request({
        host,
        port: 3100,
        path: `/proxy/ws://127.0.0.1:${port}/mutate?q=1`,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          Cookie: '__session=victim-cookie',
          ...(origin ? { Origin: origin } : {}),
          ...(withSecret ? { 'x-mindpage-local-proxy': secret } : {}),
        },
      })
      req.on('upgrade', (_res, socket) => {
        sockets.push(socket)
        done('upgraded')
      })
      req.on('error', e => done(`refused:${(e as any).code}`))
      req.on('response', res => done(`http:${res.statusCode}`))
      req.end()
    })
  try {
    // ALLOWED: the request's OWN origin — same scheme, same host, same port. the previous version
    // connected to 127.0.0.1 while sending Origin: http://localhost:3100 and asserted that this
    // MISMATCH upgrades, so what it pinned was a cross-origin request being accepted
    expect(await upgrade('127.0.0.1', 'http://127.0.0.1:3100'), 'same-origin loopback keeps proxying').toBe(
      'upgraded'
    )
    expect(seen.length, 'the backend served the allowed upgrade').toBe(1)
    expect(seen[0], 'the secret header was consumed before the upgrade').toContain(' secret=none')
    // same-origin WITHOUT the secret: refused (vault design mind_task_agents 9.9)
    expect(await upgrade('127.0.0.1', 'http://127.0.0.1:3100', false), 'no secret').toMatch(/^refused:/)
    // REFUSED, all from a loopback process: a hostile page, and two origins that differ from the
    // request's own only by host or by port. comparing hostnames alone accepted both of the latter.
    // a timeout is NOT accepted as equivalent to a refusal — it cannot tell "gate closed" from
    // "still connecting"
    expect(await upgrade('127.0.0.1', 'https://attacker.example'), 'foreign origin').toMatch(/^refused:/)
    expect(await upgrade('127.0.0.1', 'http://localhost:3100'), 'host mismatch').toMatch(/^refused:/)
    expect(await upgrade('127.0.0.1', 'http://127.0.0.1:9999'), 'port mismatch').toMatch(/^refused:/)
    // a browser can omit Origin entirely (GET/HEAD navigations, no-cors): without the secret,
    // absence fails closed; with it, the caller is a local tool and the upgrade proxies
    expect(await upgrade('127.0.0.1', undefined, false), 'no origin, no secret').toMatch(/^refused:/)
    expect(await upgrade('127.0.0.1'), 'no origin, the secret: a local tool').toBe('upgraded')
    if (lan) expect(await upgrade(lan, 'http://127.0.0.1:3100'), 'non-loopback caller').toMatch(/^refused:/)
    // ONE quiet window for every rejected probe above, rather than one per probe
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(seen, 'the backend saw nothing from any rejected caller').toHaveLength(2)
    expect(seen.every(line => line.endsWith(' secret=none')), 'no upgrade carried the header').toBe(true)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => backend.close(() => resolve()))
  }
})

test('the generic proxy refuses every caller that is not a same-origin local one', async () => {
  // an earlier version made two LOOPBACK requests and saw two 200s, so despite its name it never
  // observed a refusal. round-20 finding 4 then showed the address is not the only question: a
  // browser omits Origin on GET/HEAD navigations and no-cors requests, and review reproduced a
  // cross-site request with no Origin being proxied, cookie and all. a canary backend answers what
  // actually reached it
  const http = await import('http')
  const os = await import('os')
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i && i.family == 'IPv4' && !i.internal)?.address
  const seen: string[] = []
  const backend = http.createServer((req, res) => {
    seen.push(`${req.url} cookie=${req.headers.cookie ?? 'none'}`)
    res.end('canary')
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', () => resolve()))
  const port = (backend.address() as any).port
  const proxied = (host: string, headers: Record<string, string>) =>
    new Promise<number>(resolve => {
      const req = http.get(
        { host, port: 3100, path: `/proxy/http://127.0.0.1:${port}/probe`, headers },
        res => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', () => resolve(0))
    })
  try {
    // ALLOWED: a same-origin browser request and a local tool, each with the lane's secret
    const auth = { 'x-mindpage-local-proxy': laneSecret() }
    expect(await proxied('127.0.0.1', { 'sec-fetch-site': 'same-origin', ...auth }), 'same-origin').toBe(200)
    expect(await proxied('127.0.0.1', auth), 'a local tool with the secret').toBe(200)
    expect(seen).toHaveLength(2)
    seen.length = 0
    // REFUSED: the secret missing or the pre-secret opt-in value, whatever else is claimed
    expect(await proxied('127.0.0.1', { 'sec-fetch-site': 'same-origin' }), 'same-origin, no secret').toBe(403)
    expect(await proxied('127.0.0.1', { 'x-mindpage-local-proxy': '1' }), 'the old opt-in value').toBe(403)
    // REFUSED: THE reproduced exploit — cross-site, no Origin, carrying our cookie. a top-level
    // navigation of this shape would serve attacker html under our own local origin
    expect(
      await proxied('127.0.0.1', { 'sec-fetch-site': 'cross-site', cookie: '__session=victim' }),
      'cross-site with no origin'
    ).toBe(403)
    expect(await proxied('127.0.0.1', { 'sec-fetch-site': 'none' }), 'user-initiated navigation').toBe(403)
    expect(await proxied('127.0.0.1', {}), 'neither origin nor fetch metadata: fail closed').toBe(403)
    expect(await proxied('127.0.0.1', { origin: 'https://attacker.example' }), 'foreign origin').toBe(403)
    if (lan)
      // a non-loopback caller cannot even connect: the lane server binds 127.0.0.1 alone
      // (vault design mind_task_agents 9.7); the gate's own address check is the unit table's
      expect(
        await proxied(lan, {
          'x-forwarded-for': '127.0.0.1',
          'x-forwarded-host': 'localhost',
          host: 'localhost',
          'sec-fetch-site': 'same-origin',
          ...auth,
        }),
        'a non-loopback caller, whatever it claims in headers'
      ).toBe(0)
    expect(seen, 'the backend saw nothing from any refused caller').toEqual([])
  } finally {
    await new Promise<void>(resolve => backend.close(() => resolve()))
  }
})
