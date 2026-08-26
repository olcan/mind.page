import { test } from '@playwright/test'

test('what happens on a foreign shared page', async ({ page }) => {
  test.setTimeout(60_000)
  const urls: string[] = []
  page.on('framenavigated', f => { if (f === page.mainFrame()) urls.push(f.url()) })
  page.on('console', m => { if (m.type() == 'error' || /shared|redirect|emulator/i.test(m.text())) console.log('CONSOLE:', m.text().slice(0, 160)) })
  page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0, 200)))
  await page.goto('/?shared=markdown_e2e/markdown').catch(e => console.log('GOTO ERR:', String(e).slice(0, 120)))
  await page.waitForTimeout(6000)
  console.log('FINAL URL:', page.url())
  console.log('NAVIGATIONS:', JSON.stringify(urls.slice(0, 8)))
  console.log('BODY HEAD:', (await page.evaluate(() => document.body?.innerText?.slice(0, 200)).catch(() => 'n/a')))
})
