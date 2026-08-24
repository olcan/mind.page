#!/usr/bin/env node
// boots the vite dev server and loads the page in a browser, failing on any page or console
// error: the dev pipeline differs from the production build the e2e suite covers (vite transforms,
// ssr module runner, hmr websocket) and has broken independently of it (http/2 vs express, hmr
// port grabs, scanner quirks). run via `npm run test:dev-smoke`; talks to production firebase as a
// signed-out visitor (read-only), so it needs network and the dev certs (ssl-dev/).
import { spawn } from 'child_process'
import { chromium } from '@playwright/test'

const HMR_PORT = process.env.HMR_PORT ?? '24777' // clear of the default, in case a dev server runs
const dev = spawn('npm', ['run', 'dev'], { env: { ...process.env, HMR_PORT }, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
dev.stdout.on('data', chunk => (out += chunk))
dev.stderr.on('data', chunk => (out += chunk))
const fail = message => {
  console.error(message)
  dev.kill()
  process.exit(1)
}
process.on('exit', () => dev.kill())

// wait for the local url (https on 443 with certs, http otherwise; a busy port shifts it)
let url
for (let i = 0; i < 60 && !url; i++) {
  url = out.match(/Local: +(\S+)/)?.[1]
  await new Promise(resolve => setTimeout(resolve, 500))
}
if (!url) fail(`dev server did not start:\n${out}`)
console.log(`dev server at ${url}`)

const browser = await chromium.launch()
const page = await browser.newPage({ ignoreHTTPSErrors: true })
const errors = []
page.on('pageerror', error => errors.push(`pageerror: ${error}`))
page.on('console', message => {
  if (message.type() == 'error') errors.push(`console: ${message.text()}`)
})
await page.goto(url, { timeout: 30_000 })
// the app boots to the sign-in prompt (production firebase, signed out) with the hmr socket up
await page.getByText('Stay Anonymous', { exact: true }).waitFor({ timeout: 60_000 })
await page.waitForTimeout(5_000)
const connected = await page.evaluate(() => true).catch(() => false)
const vite_errors = out.match(/(TypeError|ReferenceError|Internal server error)[^\n]*/g) ?? []
await browser.close()
dev.kill()

if (!connected || errors.length || vite_errors.length)
  fail(`dev smoke failed:\n${[...errors, ...vite_errors].join('\n')}`)
console.log('dev smoke passed: page booted with no errors')
