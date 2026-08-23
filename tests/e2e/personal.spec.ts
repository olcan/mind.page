import { expect, test, type Page } from '@playwright/test'
import { ALICE, firestore, loadUser, secretFor, waitForApp } from './helpers'

// personal account path: first sign-in (welcome item, secret phrase), encrypted items, the secret on
// a new device, sharing by key with anonymous visitors, and sign-out
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const PHRASE = 'correct horse battery staple'

// answers a secret phrase prompt (see getSecretPhrase in index.svelte)
async function enterPhrase(page: Page, prompt: RegExp, phrase: string, button: string) {
  await expect(page.getByText(prompt)).toBeVisible({ timeout: 60_000 })
  await page.fill('#modal-input', phrase)
  await page.locator('.modal .button.confirm', { hasText: button }).click()
}

// the firestore document of an item, as stored (encrypted or not)
async function stored(page: Page, name: string) {
  const id = await page.evaluate(name => window._item(name)?.saved_id, name)
  expect(id, `${name} saved`).toBeTruthy()
  return (await firestore().collection('items').doc(id!).get()).data()!
}

// stores the secret as a returning device would have it, before signing in (see secretFor)
async function withSecret(page: Page) {
  await page.goto('/')
  await page.evaluate(secret => localStorage.setItem('mindpage_secret', secret), secretFor(ALICE, PHRASE))
}

const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)

test('first sign-in copies the welcome item and sets up a secret phrase that encrypts items', async ({ page }) => {
  await loadUser(page, ALICE)
  // an empty account is seeded with the anonymous account's welcome item (/_welcome), whose save
  // triggers the prompt for a new secret phrase
  await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
  await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
  await waitForApp(page)
  await expect
    .poll(() => page.evaluate(() => window._items().map(item => item.text.split(' ')[0])))
    .toEqual(['Welcome'])
  // the phrase is kept as a hash with the uid (see secretFor), never the phrase itself
  expect(await page.evaluate(() => localStorage.getItem('mindpage_secret'))).toBe(secretFor(ALICE, PHRASE))
  // items are stored encrypted: cipher only, text and attr nulled
  await page.evaluate(() => void window._create('#e2e_private secret text 12345'))
  await expect.poll(() => savedId(page, '#e2e_private'), { timeout: 30_000 }).toBeTruthy()
  const doc = await stored(page, '#e2e_private')
  expect(doc.user).toBe(ALICE.uid)
  expect(doc.text).toBeNull()
  expect(doc.attr).toBeNull()
  expect(doc.cipher).toMatch(/^[A-Za-z0-9+/=]{40,}$/)
  expect(await page.evaluate(() => window.__items.every(item => !!item.savedId))).toBe(true) // welcome item too
  // reloading with the stored secret decrypts without prompting
  await page.reload()
  await waitForApp(page)
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_private', true)?.text ?? null))
    .toContain('secret text 12345')
  expect(await page.locator('#modal-input').count()).toBe(0)
})

test('a new device must enter the phrase; a wrong one can only sign out', async ({ page }) => {
  await loadUser(page, ALICE) // fresh context: no secret in localStorage
  await enterPhrase(page, /Enter your secret phrase/, 'wrong phrase', 'Continue')
  await expect(page.getByText(/Unable to access your account/)).toBeVisible({ timeout: 60_000 })
  await page.locator('.modal .button.confirm', { hasText: 'Sign Out' }).click()
  // signed out: back to the anonymous account as a read-only visitor, credentials cleared
  await expect(page.getByText('Stay Anonymous', { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(
    await page.evaluate(() => [localStorage.getItem('mindpage_secret'), localStorage.getItem('mindpage_user')])
  ).toEqual([null, null])
  // the right phrase decrypts the account
  await loadUser(page, ALICE)
  await enterPhrase(page, /Enter your secret phrase/, PHRASE, 'Continue')
  await waitForApp(page)
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_private', true)?.text ?? null))
    .toContain('secret text 12345')
})

test('shared items are stored in the clear and visible to anonymous visitors by key', async ({ page, browser }) => {
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  await page.evaluate(() => void window._create('#e2e_shared hello visitors'))
  await expect.poll(() => savedId(page, '#e2e_shared'), { timeout: 30_000 }).toBeTruthy()
  expect((await stored(page, '#e2e_shared')).cipher).toBeTruthy()
  await page.evaluate(() => window._item('#e2e_shared')!.share('e2e-key'))
  await expect
    .poll(() => stored(page, '#e2e_shared'), { timeout: 30_000 })
    .toMatchObject({
      cipher: null,
      text: '#e2e_shared hello visitors',
      attr: { shared: { keys: ['e2e-key'] } },
    })
  const context = await browser.newContext() // a signed-out visitor
  try {
    const visitor = await context.newPage()
    await visitor.goto(`/?shared=${ALICE.uid}/e2e-key`)
    await waitForApp(visitor)
    expect(await visitor.evaluate(() => window._readonly)).toBe(true)
    expect(await visitor.evaluate(() => window._items().map(item => item.name))).toEqual(['#e2e_shared'])
    // the header names the sharer via /user/<uid> (the display name of the signed-in profile)
    await expect(visitor.locator('.header .status .center .subtitle')).toHaveText(/shared by Alice/)
  } finally {
    await context.close()
  }
  // unsharing encrypts the item again
  await page.evaluate(() => window._item('#e2e_shared')!.unshare('e2e-key'))
  await expect.poll(() => stored(page, '#e2e_shared'), { timeout: 30_000 }).toMatchObject({ text: null, attr: null })
  expect((await stored(page, '#e2e_shared')).cipher).toBeTruthy()
})

test('signing out clears the secret, the session and the local cache', async ({ page }) => {
  await withSecret(page)
  await loadUser(page, ALICE)
  await waitForApp(page)
  expect(await page.evaluate(() => window._items().length)).toBeGreaterThan(1)
  await page.evaluate(() => void window._create('/_signout', { command: true }))
  await expect(page.getByText('Stay Anonymous', { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(
    await page.evaluate(() => [localStorage.getItem('mindpage_secret'), localStorage.getItem('mindpage_user')])
  ).toEqual([null, null])
  expect(await page.evaluate(() => document.cookie)).not.toContain('__session=ey')
  // the firestore cache of the account was deleted (a fresh one is created for the anonymous account)
  await page.getByText('Stay Anonymous', { exact: true }).click()
  await waitForApp(page)
  expect(await page.evaluate(() => window._items().some(item => item.name == '#e2e_private'))).toBe(false)
})
