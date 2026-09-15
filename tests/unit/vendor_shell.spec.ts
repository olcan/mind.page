import { expect, test } from '@playwright/test'
import { readFileSync } from 'fs'
import { REWRITER, VENDOR_HOSTS, vendorShell, vendorText } from '../../src/server/vendor_shell.js'

// the vendored shell of a lane server (src/server/vendor_shell.js, applied by src/hooks.server.js
// under VENDOR_DIR): every cdn origin becomes the lane's own /vendor/<host>/ route, the runtime
// rewriter is injected once right after <head>, and nothing else changes

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link href="https://fonts.googleapis.com/css2?family=Open+Sans&display=swap" rel="stylesheet" />
    <link href="https://cdn.jsdelivr.net/npm/c3@0.7.20/c3.min.css" rel="stylesheet" />
    <script src="https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.1.2/es5/tex-svg.min.js"></script>
    <script>window.__hpcc_wasmFolder = 'https://unpkg.com/@hpcc-js/wasm@0.3.11/dist'</script>
    <script src="https://unpkg.com/@hpcc-js/wasm@0.3.11/dist/index.min.js"></script>
  </head>
  <body><div id="app"><a href="https://example.com/cdn.jsdelivr.net/x">not a cdn url</a></div></body>
</html>
`

test('the vendored shell: origins substituted, fonts untouched, the rewriter once after <head>', () => {
  const html = vendorShell(SHELL)
  expect(html).toContain('href="/vendor/cdn.jsdelivr.net/npm/c3@0.7.20/c3.min.css"')
  expect(html).toContain('src="/vendor/cdnjs.cloudflare.com/ajax/libs/mathjax/3.1.2/es5/tex-svg.min.js"')
  expect(html).toContain("window.__hpcc_wasmFolder = '/vendor/unpkg.com/@hpcc-js/wasm@0.3.11/dist'")
  expect(html).toContain('src="/vendor/unpkg.com/@hpcc-js/wasm@0.3.11/dist/index.min.js"')
  // fonts stay remote (never vendored: the gate renders with the fallback fonts, online or not)
  expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Open+Sans&display=swap"')
  // an origin that merely contains a cdn host name is not a cdn origin, nor is a lookalike host
  // whose dots differ (the host pattern escapes its dots)
  expect(html).toContain('href="https://example.com/cdn.jsdelivr.net/x"')
  expect(vendorText('https://unpkgXcom/a https://cdnXjsdelivrYnet/x https://unpkg.com/a')).toBe(
    'https://unpkgXcom/a https://cdnXjsdelivrYnet/x /vendor/unpkg.com/a',
  )
  for (const host of VENDOR_HOSTS) expect(html).not.toContain(`https://${host}/`)
  // the rewriter, once, directly after the <head> tag and therefore before every loader
  expect(html.split(REWRITER).length - 1).toBe(1)
  expect(html.indexOf(REWRITER)).toBe(html.indexOf('<head>') + '<head>'.length)
  expect(html.indexOf(REWRITER)).toBeLessThan(html.indexOf('<script src='))
  expect(REWRITER).toContain(JSON.stringify(VENDOR_HOSTS))
  // the rest of the shell is byte-identical: undoing the two changes restores the source
  expect(html.replace(REWRITER, '').replace(/\/vendor\/([^/]+)\//g, 'https://$1/')).toBe(SHELL)
})

test('the source shell loads its scripts from vendored hosts only', () => {
  // every script the shell loads over https comes from a host the lane servers vendor: a loader
  // on another host would fail in the gate's browsers, whose resolver refuses every remote host
  const source = readFileSync(new URL('../../src/app.html', import.meta.url), 'utf8')
  const hosts = [...source.matchAll(/<script\b[^>]*\bsrc="https:\/\/([^/"]+)\//g)].map(m => m[1])
  expect(hosts.length).toBeGreaterThan(0)
  for (const host of hosts) expect(VENDOR_HOSTS, `${host} is vendored`).toContain(host)
  // and the substitution covers exactly those loaders
  expect(vendorText(source).match(/<script\b[^>]*\bsrc="https:\/\//g)).toBeNull()
})
