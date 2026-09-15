import { expect, test } from '@playwright/test'
import express from 'express'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { spawn } from 'child_process'
import { assetFile, vendoredAssets } from '../../src/server/vendor.mjs'

// the vendored assets route (src/server/vendor.mjs) over a temporary cache and its own manifest:
// a pinned, cached url is served with its pinned type; anything else is a 404 recorded to the
// unlisted report (reason, url, referer) and never fetched. no lane server, no emulator

const repo = new URL('../..', import.meta.url).pathname

test('the route serves the pinned cache and records every other request without fetching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-route-'))
  const unlisted = join(dir, 'unlisted.txt')
  const cached = 'https://cdn.jsdelivr.net/npm/lib@1.0.0/lib.min.js?query=1'
  const absent = 'https://cdn.jsdelivr.net/npm/lib@1.0.0/absent.js'
  const manifest = { [cached]: { type: 'application/javascript' }, [absent]: { type: 'application/javascript' } }
  writeFileSync(assetFile(dir, cached), 'window.lib = 1')
  const app = express().use(vendoredAssets({ dir, unlisted, manifest }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const hit = await fetch(`${base}/vendor/cdn.jsdelivr.net/npm/lib@1.0.0/lib.min.js?query=1`)
    expect(hit.status).toBe(200)
    expect(hit.headers.get('content-type')).toContain('application/javascript')
    expect(await hit.text()).toBe('window.lib = 1')
    // the query is part of the url: without it the asset is another, unpinned one
    const bare = await fetch(`${base}/vendor/cdn.jsdelivr.net/npm/lib@1.0.0/lib.min.js`)
    expect(bare.status).toBe(404)
    const miss = await fetch(`${base}/vendor/cdn.jsdelivr.net/npm/lib@1.0.0/absent.js`, {
      headers: { referer: `${base}/page` },
    })
    expect(miss.status).toBe(404)
    expect(await miss.text()).toBe('not vendored: ' + absent)
    const unknown = await fetch(`${base}/vendor/unpkg.com/other@2/index.js`)
    expect(unknown.status).toBe(404)
    expect(readFileSync(unlisted, 'utf8')).toBe(
      `not in the manifest\t${cached.replace('?query=1', '')}\t\n` +
        `missing from the cache\t${absent}\t${base}/page\n` +
        'not in the manifest\thttps://unpkg.com/other@2/index.js\t\n',
    )
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
  // the route never fetches: the manifest is written host-side only (tests/e2e/vendor.mjs)
  expect(readFileSync(join(repo, 'src/server/vendor.mjs'), 'utf8')).not.toMatch(/\bfetch\(/)
})

test('the cache command: a fetched asset is cached and pinned, a failed fetch pins nothing', async () => {
  // `add` against a DISPOSABLE manifest and cache (VENDOR_MANIFEST, VENDOR_DIR) with a loopback
  // server deciding each fetch: a served asset lands in the cache and the manifest with its type;
  // a refused one exits 2 with the diagnosis, leaves no file (not even a partial one) and the
  // manifest untouched; `check` reads the same manifest. no dns, no remote host, nothing tracked
  const dir = mkdtempSync(join(tmpdir(), 'vendor-cli-'))
  const manifest = join(dir, 'manifest.json')
  const cache = join(dir, 'cache')
  const server = createServer((req, res) => {
    if (req.url == '/ok.js') return res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' }).end('window.ok = 1')
    res.writeHead(503).end('down')
  }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  // asynchronously: the loopback server lives in this process, which a synchronous spawn would
  // block from answering the command's fetch
  const run = (...args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
      const child = spawn('node', ['tests/e2e/vendor.mjs', ...args], {
        cwd: repo,
        env: { ...process.env, VENDOR_DIR: cache, VENDOR_MANIFEST: manifest },
        timeout: 4_000,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => (stdout += chunk))
      child.stderr.on('data', chunk => (stderr += chunk))
      child.on('close', status => done({ status, stdout, stderr }))
    })
  try {
    const added = await run('add', `${base}/ok.js`)
    expect(added.status, added.stderr).toBe(0)
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual({ [`${base}/ok.js`]: { type: 'application/javascript' } })
    expect(readFileSync(assetFile(cache, `${base}/ok.js`), 'utf8')).toBe('window.ok = 1')
    expect((await run('check')).status, 'the manifest is cached').toBe(0)
    const before = readFileSync(manifest, 'utf8')
    const failed = await run('add', `${base}/down.js`)
    expect(failed.status).toBe(2)
    expect(failed.stderr).toContain('vendored assets could not be fetched')
    expect(failed.stderr).toContain(`${base}/down.js: http 503`)
    expect(readFileSync(manifest, 'utf8')).toBe(before)
    expect(readdirSync(cache)).toEqual([basename(assetFile(cache, `${base}/ok.js`))])
    // a manifest the cache does not cover fails `check` and lists the gap
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(before), [`${base}/absent.js`]: { type: 'text/javascript' } }))
    const check = await run('check')
    expect(check.status).toBe(2)
    expect(check.stderr).toContain(`${base}/absent.js`)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
