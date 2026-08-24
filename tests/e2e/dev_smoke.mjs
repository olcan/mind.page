#!/usr/bin/env node
// boots the vite dev server, loads the page in a browser and verifies live reload end to end,
// failing on any page or console error: the dev pipeline differs from the production build the
// e2e suite covers (vite transforms, ssr module runner, hmr websocket) and has broken
// independently of it (http/2 vs express, hmr port grabs, scanner quirks). run via
// `npm run test:dev-smoke`. KNOWN LIMITATION: the dev server talks to production firebase (as a
// signed-out, read-only visitor), so this smoke needs network access and the dev certs
// (ssl-dev/); a local no-network dev mode would remove that coupling but does not exist yet.
import { spawn } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { chromium } from '@playwright/test'

const HMR_PORT = process.env.HMR_PORT ?? '24777' // clear of the default, in case a dev server runs
const PROBE = 'src/components/Modal.svelte' // watched component used to drive a real hmr update
const SENTINEL = '\n<!-- dev smoke probe -->\n'

const dev = spawn('npm', ['run', 'dev'], { env: { ...process.env, HMR_PORT }, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
dev.stdout.on('data', chunk => (out += chunk))
dev.stderr.on('data', chunk => (out += chunk))

// all failures throw; cleanup (probe restore, browser, server) happens in one finally below and
// the exit status is set only after it, so a failing run cannot leave the tracked probe modified
let browser = null
let probe_original = null
try {
  // wait for the local url (https on 443 with certs, http otherwise; a busy port shifts it)
  let url
  for (let i = 0; i < 60 && !url; i++) {
    url = out.match(/Local: +(\S+)/)?.[1]
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!url) throw new Error(`dev server did not start:\n${out}`)
  console.log(`dev server at ${url}`)

  browser = await chromium.launch()
  const page = await browser.newPage({ ignoreHTTPSErrors: true })
  const errors = []
  const logs = []
  page.on('pageerror', error => errors.push(`pageerror: ${error}`))
  page.on('console', message => {
    logs.push(message.text())
    if (message.type() == 'error') errors.push(`console: ${message.text()}`)
  })
  await page.goto(url, { timeout: 30_000 })
  // the app boots to the sign-in prompt (production firebase, signed out)
  await page.getByText('Stay Anonymous', { exact: true }).waitFor({ timeout: 60_000 })

  // the hmr websocket must connect (its failures are silent: the client just stays "connecting...")
  for (let i = 0; i < 30 && !logs.some(log => log.includes('[vite] connected')); i++)
    await new Promise(resolve => setTimeout(resolve, 500))
  if (!logs.some(log => log.includes('[vite] connected'))) throw new Error(`hmr websocket did not connect:\n${out}`)

  // touch the probe and watch only events AFTER the mutation, so an earlier unrelated vite
  // reload cannot satisfy the check
  const out_offset = out.length
  const log_offset = logs.length
  probe_original = readFileSync(PROBE, 'utf8')
  writeFileSync(PROBE, probe_original + SENTINEL)
  let updated = false
  for (let i = 0; i < 30 && !updated; i++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    updated =
      /\[vite\][^\n]*(hot updated|page reload)/.test(out.slice(out_offset)) ||
      logs.slice(log_offset).some(log => /\[vite\][^\n]*updat/.test(log))
  }
  if (!updated) throw new Error(`file change did not reach the client:\n${out.slice(out_offset).slice(-2000)}`)
  await page.waitForTimeout(2000)

  const vite_errors = out.match(/(TypeError|ReferenceError|Internal server error)[^\n]*/g) ?? []
  if (errors.length || vite_errors.length)
    throw new Error(`dev smoke failed:\n${[...errors, ...vite_errors].join('\n')}`)
  console.log('dev smoke passed: page booted, hmr connected, file change reached the client')
} catch (e) {
  console.error(String(e?.message ?? e))
  process.exitCode = 1
} finally {
  // restore the probe only if it holds exactly the original plus the sentinel: anything else
  // means a concurrent edit landed during the probe window and must not be overwritten
  if (probe_original != null) {
    const current = readFileSync(PROBE, 'utf8')
    if (current == probe_original + SENTINEL) writeFileSync(PROBE, probe_original)
    else if (current != probe_original)
      console.error(`NOT restoring ${PROBE}: it changed during the probe window (remove the sentinel manually)`)
  }
  await browser?.close()
  dev.kill()
}
