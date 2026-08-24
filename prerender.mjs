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
  // the default view: rendered items up to hideIndex, as a fresh visitor sees them; the cleanup
  // below mutates the live page (this browser is disposable), where layout is measurable
  const columns = document.querySelector('.items')
  // app furniture that is useless frozen: the header (mindbox editor, status bar, user image) and
  // its layout spacer live inside the first column; also the hidden render column, hidden
  // sections, and any item rendering an editor replica
  columns
    .querySelectorAll('.header, .column-padding, .column.hidden, [style*="display: none"], [style*="display:none"]')
    .forEach(e => e.remove())
  columns.querySelectorAll('.super-container').forEach(e => {
    if (e.querySelector('.editor, textarea')) e.remove()
  })
  // remove embeds along with their text-free wrappers (e.g. video aspect boxes)
  columns.querySelectorAll('iframe, video, embed, object').forEach(el => {
    let e = el
    while (
      e.parentElement &&
      e.parentElement != columns &&
      e.parentElement.textContent.trim() == el.textContent.trim()
    )
      e = e.parentElement
    e.remove()
  })
  // sanitize: this html is injected into the page for everyone, so item-embedded scripts and
  // handlers must not execute in other people's browsers (the frozen render is read-only anyway)
  columns.querySelectorAll('script, textarea, input, button').forEach(e => e.remove())
  for (const elem of columns.querySelectorAll('*')) {
    for (const attr of [...elem.attributes]) {
      if (attr.name.startsWith('on') || (attr.name == 'href' && attr.value.trim().toLowerCase().startsWith('javascript:')))
        elem.removeAttribute(attr.name)
    }
  }
  // sweep leftover husks: tall boxes with no text, image or chart (measured on the live layout)
  for (let i = 0; i < 3; i++)
    columns.querySelectorAll('div, span, p').forEach(e => {
      if (e.clientHeight > 60 && !e.textContent.trim() && !e.querySelector('img, svg, canvas')) e.remove()
    })
  const text = columns.textContent.replace(/\s+/g, ' ').trim()
  return { html: columns.outerHTML, description: text.slice(0, 159) + (text.length > 160 ? '…' : '') }
})
await browser.close()

const db = getFirestore(getApps()[0] ?? initializeApp(firebaseConfig))
await db.collection('prerender').doc('anonymous').set({ html, description, url, time: Date.now() })
console.log(
  `captured frozen render of ${url}: ${(html.length / 1024).toFixed(0)}KB html, stored in firestore document ` +
    `prerender/anonymous (${local ? `emulator at ${process.env.FIRESTORE_EMULATOR_HOST}` : `PRODUCTION project ${firebaseConfig.projectId}`})`
)
process.exit(0)
