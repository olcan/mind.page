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
// the edit must COMPILE TO SOMETHING. this previously appended an html comment, which svelte strips
// — the compiled component was byte-for-byte identical, so vite logged an ssr-side page reload and
// the client correctly received nothing. the test then reported hmr as broken for two rounds. a
// data attribute on the always-rendered root is compiled AND visible in the dom, so the assertion
// can be the dom change itself rather than a log line
const PROBE_ANCHOR = '<div class="background"'
const PROBE_EDIT = '<div data-dev-smoke="1" class="background"'
const PROBE_MARK = '[data-dev-smoke="1"]'

// detached: the dev server is npm -> shell -> vite; killing the process GROUP reaches them all
const dev = spawn('npm', ['run', 'dev'], {
  env: { ...process.env, HMR_PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let out = ''
dev.stdout.on('data', chunk => (out += chunk))
dev.stderr.on('data', chunk => (out += chunk))

// cleanup is idempotent, ASYNC and every step is guarded independently, so a failure in one
// step (e.g. a read error during restore) cannot skip the others; it awaits browser closure and
// the dev process tree's exit (with a hard kill after a short timeout) so interrupted runs do
// not strand descendants. signals route through it as well, since default SIGINT/SIGTERM
// handling would exit without unwinding the finally below and could leave the tracked probe
// modified
let browser = null
let probe_original = null
let cleaning = null
// races a promise against a timer that is always cleared, so a settled promise never leaves a
// pending timer holding the process open
function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise(resolve => (timer = setTimeout(resolve, ms))),
  ]).finally(() => clearTimeout(timer))
}

function cleanup() {
  cleaning ??= (async () => {
    if (probe_original != null) {
      // restore only if the probe holds exactly the edited original: anything else means a
      // concurrent edit landed during the probe window and must not be overwritten
      try {
        const current = readFileSync(PROBE, 'utf8')
        if (current == probe_original.replace(PROBE_ANCHOR, PROBE_EDIT)) writeFileSync(PROBE, probe_original)
        else if (current != probe_original) {
          console.error(`NOT restoring ${PROBE}: it changed during the probe window (undo it manually)`)
          process.exitCode = 1 // the tracked file is left dirty: this run must not report success
        }
      } catch (e) {
        console.error(`probe restore failed: ${e}`)
        process.exitCode = 1
      }
    }
    try {
      // bounded AND cleared: a wedged browser close must not prevent the dev-server cleanup
      // below, and the losing timer must not keep node alive after a quick close
      await withTimeout(browser?.close(), 10_000)
    } catch {}
    try {
      const exited = new Promise(resolve => dev.on('exit', resolve))
      const kill = signal => {
        try {
          process.kill(-dev.pid, signal) // the whole group: npm's shell and vite descendants
        } catch {
          dev.kill(signal) // group already gone (or unsupported): signal the child directly
        }
      }
      // liveness is checked on the process GROUP (signal 0), not the npm parent's exitCode: the
      // parent can exit while a descendant ignoring SIGTERM lives on
      const groupAlive = () => {
        try {
          process.kill(-dev.pid, 0)
          return true
        } catch {
          return false
        }
      }
      kill('SIGTERM')
      await withTimeout(exited, 5000)
      if (dev.exitCode == null || groupAlive()) {
        kill('SIGKILL')
        // the npm parent's exit event may have fired long ago: what must be proven is that the
        // GROUP is gone, so poll liveness rather than waiting on that event
        for (let i = 0; i < 20 && groupAlive(); i++) await new Promise(resolve => setTimeout(resolve, 100))
        if (groupAlive()) {
          // stranded descendants hold the dev port and break the NEXT run: this must fail the
          // command, not merely narrate (the comment above describes a proof, so prove it)
          console.error('dev server process group survived SIGKILL')
          process.exitCode = 1
        }
      }
    } catch {}
  })()
  return cleaning
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void cleanup().then(() => process.exit(process.exitCode ?? 130))
  })

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
  let page_loads = 0
  page.on('load', () => page_loads++)
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

  // edit the probe and require BROWSER-side evidence: the edited DOM in this page. a log line only
  // says vite spoke, and the marker alone is not enough either — the edited file stays on disk, so
  // the marker appearing after a reload says nothing on its own. proving it ABSENT first is what
  // makes its appearance mean the edit propagated.
  // the propagation MECHANISM is recorded, not asserted: for this component vite decides a full
  // page reload ('(ssr) page reload <file>' in its log) rather than a hot replacement, because the
  // module is in the ssr graph. that is vite's own decision and the dev loop works either way, so
  // this test is about the change ARRIVING. it deliberately does not claim "without navigation" —
  // an earlier version did while accepting a reload, which is the same class of overclaim that
  // made this smoke report a nonexistent hmr break for two rounds
  probe_original = readFileSync(PROBE, 'utf8')
  if (!probe_original.includes(PROBE_ANCHOR)) throw new Error(`probe anchor not found in ${PROBE}`)
  if (await page.evaluate(mark => !!document.querySelector(mark), PROBE_MARK))
    throw new Error(`${PROBE_MARK} was already present before the edit: the probe proves nothing`)
  let navigations = 0
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) navigations++
  })
  writeFileSync(PROBE, probe_original.replace(PROBE_ANCHOR, PROBE_EDIT))
  let updated = false
  for (let i = 0; i < 40 && !updated; i++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    updated = await page.evaluate(mark => !!document.querySelector(mark), PROBE_MARK).catch(() => false)
  }
  if (!updated) throw new Error(`the edited component never reached this client (server log tail):\n${out.slice(-2000)}`)
  console.log(navigations ? `note: propagated by full page reload (${navigations} navigations)` : 'note: hot replacement, no navigation')
  await page.waitForTimeout(2000)
  // recheck after the settle: a reload can surface late errors
  const vite_errors = out.match(/(TypeError|ReferenceError|Internal server error)[^\n]*/g) ?? []
  if (errors.length || vite_errors.length)
    throw new Error(`dev smoke failed:\n${[...errors, ...vite_errors].join('\n')}`)
  console.log('dev smoke passed: page booted, hmr connected, an edited component reached this client')
} catch (e) {
  console.error(String(e?.message ?? e))
  process.exitCode = 1
} finally {
  await cleanup()
}
