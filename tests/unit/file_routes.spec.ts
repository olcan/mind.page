import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { createServer, request as httpRequest, type Server } from 'http'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'

// the localhost-only routes over the ACTUAL middleware, in a child node process that runs IN a
// fixture checkout (so the static route serves the fixture's static/), under a synthetic home
// (its own proxy secret), beside a second synthetic home with a sentinel credential, and with a
// fresh loopback backend (vault design mind_task_agents 9.9; 7b-2a reviews 0-2). every fixture
// server is SCOPED to its checkout (LOCAL_ROUTES_SCOPE), as the e2e lanes are: a credential a
// worker can read (the child's, under the system temp directory) must open nothing of the
// host's. no emulator, no build, no real credential; the child is killed and awaited on every
// exit path
const APP = pathToFileURL(resolve(process.cwd(), 'src/server/app.mjs')).href
const SERVER = `
import { enableLocalProxy, middleware } from ${JSON.stringify(APP)}
enableLocalProxy()
const server = middleware.listen(0, '127.0.0.1', () => process.stdout.write('port ' + server.address().port + '\\n'))
`

type Child = { child: ChildProcess; port: number }

async function startServer(checkout: string, home: string): Promise<Child> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', SERVER], {
    cwd: checkout,
    env: { ...process.env, NO_HTTPS: '1', HOME: home, PWD: checkout, LOCAL_ROUTES_SCOPE: checkout },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let out = ''
      const deadline = setTimeout(() => reject(new Error('the server did not report its port in 15s')), 15_000)
      child.stdout!.on('data', chunk => {
        out += chunk
        const m = out.match(/port (\d+)/)
        if (m) {
          clearTimeout(deadline)
          resolve(Number(m[1]))
        }
      })
      child.on('error', error => {
        clearTimeout(deadline)
        reject(error)
      })
      child.on('exit', code => {
        clearTimeout(deadline)
        reject(new Error(`the server exited early: ${code}`))
      })
    })
    return { child, port }
  } catch (error) {
    await stopServer(child)
    throw error
  }
}

// killed and awaited: no test leaves a listener (with a credential in memory) behind
async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
  await exited
  clearTimeout(timer)
  expect(child.exitCode !== null || child.signalCode !== null, 'the server exited').toBe(true)
}

const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://localhost:${port}${path}`, { headers, redirect: 'manual' }).then(async r => ({
    status: r.status,
    text: await r.text(),
    location: r.headers.get('location'),
  }))

// a raw request (a url library would normalize a dotted path away)
const raw = (port: number, path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host: 'localhost', ...headers } }, res => {
      let text = ''
      res.on('data', c => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end()
  })

function echoBackend(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url == '/redirect-out') {
      res.writeHead(302, { Location: 'http://10.255.255.1:9/never' })
      return res.end()
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, secret_header: req.headers['x-mindpage-local-proxy'] ?? null }))
  })
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as any).port })),
  )
}

// the fixture: <root>/mind.page is the checkout (with a static/ directory and a note), <root>
// holds the other home's aliases; a second home carries a sentinel credential and a note
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mindpage-home-'))
  const other = mkdtempSync(join(tmpdir(), 'mindpage-other-home-'))
  const root = mkdtempSync(join(tmpdir(), 'mindpage-root-'))
  const checkout = join(root, 'mind.page')
  mkdirSync(join(checkout, 'static'), { recursive: true })
  mkdirSync(join(other, '.mindpage'))
  writeFileSync(join(other, '.mindpage', 'proxy_secret'), 'OTHER-HOME-SENTINEL-0123456789\n')
  writeFileSync(join(other, 'note.md'), 'another private note\n')
  writeFileSync(join(root, 'outside.md'), 'a note outside the checkout\n')
  writeFileSync(join(checkout, 'note.md'), 'a checkout note\n')
  writeFileSync(join(checkout, 'static', 'plain.txt'), 'a plain asset\n')
  symlinkSync(join(other, '.mindpage', 'proxy_secret'), join(checkout, 'static', 'planted.txt'))
  symlinkSync(join(other, 'note.md'), join(checkout, 'static', 'planted-note.txt'))
  // the selections sirv would make on its own (reviews 3-4: `/alias` and `/alias/` pick alias.html,
  // `/folder/` its index.html, `/htmfolder/` its index.htm, `/barefolder/` its bare index, an
  // encoded name its literal file), every one a link to the other home's file, and the icon
  // routes' computed targets under the localhost host directory (`other/`): a real icon beside a
  // planted one; an ordinary directory index inside the checkout
  symlinkSync(join(other, 'note.md'), join(checkout, 'static', 'alias.html'))
  for (const [dir, index] of [
    ['folder', 'index.html'],
    ['htmfolder', 'index.htm'],
    ['barefolder', 'index'],
  ]) {
    mkdirSync(join(checkout, 'static', dir))
    symlinkSync(join(other, 'note.md'), join(checkout, 'static', dir, index))
  }
  symlinkSync(join(other, 'note.md'), join(checkout, 'static', 'literal%3Bname.txt'))
  mkdirSync(join(checkout, 'static', 'other'))
  writeFileSync(join(checkout, 'static', 'other', 'favicon.ico'), 'an icon\n')
  symlinkSync(join(other, 'note.md'), join(checkout, 'static', 'other', 'apple-touch-icon.png'))
  mkdirSync(join(checkout, 'static', 'inside'))
  writeFileSync(join(checkout, 'static', 'inside', 'index.html'), '<p>inside</p>\n')
  const leaked = (text: string) => text.includes('OTHER-HOME-SENTINEL') || text.includes('another private note')
  return {
    home,
    other,
    root,
    checkout,
    leaked,
    remove: () => [home, other, root].forEach(d => rmSync(d, { recursive: true, force: true })),
  }
}

test('the file routes take the secret, serve the checkout only, and never serve a credential', async () => {
  test.setTimeout(60_000)
  const f = fixture()
  let started: Child | undefined
  try {
    started = await startServer(f.checkout, f.home)
    const { port } = started
    const secretPath = join(f.home, '.mindpage', 'proxy_secret')
    const secret = readFileSync(secretPath, 'utf8').trim() // the child's own, created at start
    expect(secret.length).toBeGreaterThan(20)
    const auth = { 'x-mindpage-local-proxy': secret }
    // the checkout's files: refused without the secret (7b-1 B1), served with it, on both routes
    expect((await get(port, `/file_abs${join(f.checkout, 'note.md')}`)).status, 'no secret').toBe(403)
    expect(await get(port, `/file_abs${join(f.checkout, 'note.md')}`, auth), 'the secret').toMatchObject({
      status: 200,
      text: 'a checkout note\n',
    })
    expect((await get(port, '/file/mind.page/note.md')).status, '/file/, no secret').toBe(403)
    expect(await get(port, '/file/mind.page/note.md', auth), '/file/, the secret').toMatchObject({
      status: 200,
      text: 'a checkout note\n',
    })
    // outside the scope: refused even to the secret (a file beside the checkout, the parent)
    for (const path of [`/file_abs${join(f.root, 'outside.md')}`, `/file_abs${f.root}`, '/file/outside.md'])
      expect((await get(port, path, auth)).status, path).toBe(403)
    // the credentials: this server's own and another home's, refused even to the secret under
    // every alias (links planted inside the checkout, a dotted path), through both routes
    const aliases = join(f.checkout, 'aliases')
    mkdirSync(aliases)
    symlinkSync(secretPath, join(aliases, 'own'))
    symlinkSync(join(f.home, '.mindpage'), join(aliases, 'own-dir'))
    symlinkSync(join(f.other, '.mindpage', 'proxy_secret'), join(aliases, 'other'))
    for (const path of [
      `/file_abs${secretPath}`,
      `/file_abs${join(f.home, '.mindpage')}`,
      `/file_abs${join(f.other, '.mindpage', 'proxy_secret')}`,
      `/file_abs${join(aliases, 'own')}`,
      `/file_abs${join(aliases, 'own-dir')}/proxy_secret`,
      `/file_abs${join(aliases, 'other')}`,
      '/file/mind.page/aliases/own',
      '/file/mind.page/aliases/other',
      `/file_abs${join(f.checkout, 'static', 'planted.txt')}`,
    ]) {
      const refused = await get(port, path, auth)
      expect(refused.status, path).toBe(403)
      expect(refused.text.includes(secret) || f.leaked(refused.text), `${path} leaks`).toBe(false)
    }
    const dotted = await raw(port, `/file_abs${join(f.home, '.mindpage')}/../.mindpage/proxy_secret`, auth)
    expect(dotted.status, 'the dotted path').toBe(403)
    expect(dotted.text.includes(secret)).toBe(false)
    // the static assets (review 2 B2, reviews 3-4): the scoped reader serves the file it selects
    // itself, an ordinary asset, a directory's index, the icon routes' real targets, and refuses
    // whatever resolves outside the scope, secret or not: the planted links under static/ under
    // every spelling sirv would have resolved on its own, and a planted icon target
    expect(await get(port, '/plain.txt'), 'an asset').toMatchObject({ status: 200, text: 'a plain asset\n' })
    expect(await get(port, '/inside/'), 'a directory index').toMatchObject({ status: 200, text: '<p>inside</p>\n' })
    for (const icon of ['/icon.png', '/favicon.ico'])
      expect(await get(port, icon), icon).toMatchObject({ status: 200, text: 'an icon\n' })
    // a selected file outside the scope is 403; a spelling the reader does not resolve (no
    // extension guessing, no bare or .htm index, an encoded name kept literal) is 404
    const planted: [string, number][] = [
      ['/planted.txt', 403],
      ['/planted-note.txt', 403],
      ['/alias', 404],
      ['/alias/', 404],
      ['/alias.html', 403],
      ['/folder/', 403],
      ['/folder/index.html', 403],
      ['/htmfolder/', 404],
      ['/htmfolder/index.htm', 403],
      ['/barefolder/', 404],
      ['/barefolder/index', 403],
      ['/literal%3Bname.txt', 404],
      ['/apple-touch-icon.png', 403],
    ]
    // the icon target itself planted: the computed target is checked like any other
    rmSync(join(f.checkout, 'static', 'other', 'favicon.ico'))
    symlinkSync(join(f.other, 'note.md'), join(f.checkout, 'static', 'other', 'favicon.ico'))
    for (const [asset, status] of [...planted, ['/icon.png', 403], ['/favicon.ico', 403]] as [string, number][])
      for (const headers of [{}, auth]) {
        const refused = await get(port, asset, headers)
        expect(refused.status, asset).toBe(status)
        expect(f.leaked(refused.text), `${asset} leaks`).toBe(false)
      }
  } finally {
    if (started) await stopServer(started.child)
    f.remove()
  }
})

test('the proxy takes the secret, forwards without it, and reaches loopback backends only', async () => {
  test.setTimeout(60_000)
  const f = fixture()
  const backend = await echoBackend()
  let started: Child | undefined
  try {
    started = await startServer(f.checkout, f.home)
    const { port } = started
    const auth = { 'x-mindpage-local-proxy': readFileSync(join(f.home, '.mindpage', 'proxy_secret'), 'utf8').trim() }
    const loopback = `http://127.0.0.1:${backend.port}`
    // refused without the secret whatever the headers claim, forwarded WITHOUT the header
    expect((await get(port, `/proxy/${loopback}/echo`)).status, 'no secret').toBe(403)
    expect((await get(port, `/proxy/${loopback}/echo`, { 'sec-fetch-site': 'same-origin' })).status, 'forged').toBe(403)
    expect(
      (await get(port, `/proxy/${loopback}/echo`, { 'x-mindpage-local-proxy': '1' })).status,
      'the old opt-in',
    ).toBe(403)
    const forwarded = await get(port, `/proxy/${loopback}/echo?x=1`, auth)
    expect(forwarded.status).toBe(200)
    expect(JSON.parse(forwarded.text)).toEqual({ url: '/echo?x=1', secret_header: null })
    // one shared parser for the gate and the router (review 2 B1): user information
    // is refused, and any non-loopback backend host is refused before a connection
    expect((await get(port, `/proxy/http://user:pw@127.0.0.1:${backend.port}/echo`, auth)).status, 'userinfo').toBe(403)
    for (const remote of [
      'http://10.255.255.1:9',
      'https://example.com',
      'http://192.168.1.1',
      'http://[::ffff:10.0.0.1]:8',
    ])
      expect((await get(port, `/proxy/${remote}/probe`, auth)).status, remote).toBe(403)
    // a loopback backend's redirect elsewhere is NOT followed by a scoped server: the redirect
    // returns to the caller, the outside destination is never contacted
    const redirected = await get(port, `/proxy/${loopback}/redirect-out`, auth)
    expect(redirected.status, 'the redirect returned, not followed').toBe(302)
    expect(redirected.location).toBe('http://10.255.255.1:9/never')
  } finally {
    if (started) await stopServer(started.child)
    await new Promise<void>(resolve => backend.server.close(() => resolve()))
    f.remove()
  }
})
