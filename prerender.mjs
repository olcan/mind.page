// captures a "frozen render" of the public (anonymous) page in a real browser and stores it for
// no-javascript visitors and crawlers (served by src/lib/server/content.js, replacing the plain
// markdown fallback): the app's default view exactly as rendered — macros expanded, charts drawn,
// math typeset — read-only and frozen at capture time. items hidden under toggles stay hidden, as
// on the page itself. usage: node prerender.mjs [url] [--prod]  (default http://localhost:3100; a localhost
// url targets the firestore emulator, so local captures can never touch production)
import { chromium } from '@playwright/test'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { firebaseConfig } from './firebase-config.js'

const url = process.argv[2] ?? 'http://localhost:3100'
const local = !!new URL(url).hostname.match(/^(localhost|127\.0\.0\.1)$/)
if (local) process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'
// a non-local capture writes to PRODUCTION firestore: require an explicit flag
if (!local && !process.argv.includes('--prod')) {
  console.error(`refusing to capture ${url} without --prod (it would write to production firestore)`)
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(url, { timeout: 60_000 })
await page.getByText('Stay Anonymous', { exact: true }).click({ timeout: 60_000 })
await page.waitForFunction(() => window.__rendered === true, null, { timeout: 90_000 })
await page.waitForTimeout(2_000) // let charts, math and macros settle
const { html, description } = await page.evaluate(() => {
  // the default view: rendered items up to hideIndex, as a fresh visitor sees them
  const columns = document.querySelector('.items')
  const clone = columns.cloneNode(true)
  // drop hidden dom, which would ship invisible bytes: the app's hidden render column, hidden
  // sections within items, and anything else not displayed (items past hideIndex are not in the
  // dom at all, so the frozen render is the default view by construction)
  clone.querySelectorAll('.column.hidden, [style*="display: none"], [style*="display:none"]').forEach(e => e.remove())
  // sanitize: this html is injected into the page for everyone, so item-embedded scripts and
  // handlers must not execute in other people's browsers (the frozen render is read-only anyway)
  clone.querySelectorAll('script, iframe, textarea, input, button').forEach(e => e.remove())
  for (const elem of clone.querySelectorAll('*')) {
    for (const attr of [...elem.attributes]) {
      if (
        attr.name.startsWith('on') ||
        (attr.name == 'href' && attr.value.trim().toLowerCase().startsWith('javascript:'))
      )
        elem.removeAttribute(attr.name)
    }
  }
  const text = columns.textContent.replace(/\s+/g, ' ').trim()
  return { html: clone.outerHTML, description: text.slice(0, 159) + (text.length > 160 ? '…' : '') }
})
await browser.close()

const db = getFirestore(getApps()[0] ?? initializeApp(firebaseConfig))
await db.collection('prerender').doc('anonymous').set({ html, description, url, time: Date.now() })
console.log(
  `captured frozen render of ${url}: ${(html.length / 1024).toFixed(0)}KB html, stored in firestore document ` +
    `prerender/anonymous (${local ? `emulator at ${process.env.FIRESTORE_EMULATOR_HOST}` : `PRODUCTION project ${firebaseConfig.projectId}`})`
)
process.exit(0)
