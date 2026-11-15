import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { customToken, firestore, install, interceptMindItems, secretFor, waitForApp, type TestUser } from './helpers.js'

// the #vault item's sparkle (vault design notes/design/mind_bridge_watcher.md, 6.2 and 6.3; slice
// 5): one self-contained personal account with #status and #vault installed from the local
// mind.items checkout, and the bridge played by store writes behind the app. phases: (a) an
// install AFTER the page's welcome (no reload, so no _on_welcome): the app runs the item's
// _on_install, which provisions the store, and the item's own change draws the (hidden)
// element; (b) with
// #vault off screen, a published watcher shows the sparkle at the page's lower right, an answer
// by another agent pulses it under that agent's name, and a stale bridge hides it; (c) the
// keyboard opens the menu and Escape closes it without reaching the app, and a modal that opens
// over an open menu closes it and takes the keys; (d) a watch replaced while the menu is open
// closes the menu; (e) Stop Watching writes exactly one command document through the app's
// hidden-document operation, naming the watch the menu showed (recorded as the vault's transport
// fixture), and the sparkle shows the stop until the watcher goes; (f) another tab's update of
// the item, with the menu open here, replaces the controller: still one element, the menu gone;
// (g) a visual viewport much shorter than the window hides the sparkle and its return shows it
// (SIMULATED: a desktop lane has no on-screen keyboard); (g2) the item renamed, its code kept,
// is no longer the page's #vault: its sparkle goes, with its store still naming the watcher and
// the bridge fresh, and comes back when the item is #vault again; (h) the item's deletion
// removes it at the task's next look; (i) a successful sign-out leaves none
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const USER: TestUser = { uid: 'sparkle_e2e', displayName: 'Sparkle Test', email: 'sparkle@e2e.test' }
const PHRASE = 'sparkle e2e phrase'
const SECRET = secretFor(USER, PHRASE)
const HOST = 'e2e-host'
const AGENT = 'claude-fable-5-2-max'
const TOOK = '2026-11-15T10:00:00.000Z'
const LATER = '2026-11-15T11:00:00.000Z'
// a plain item of the owner's: the page shows it alone, and it is editable (an installed item is not)
const NOTE = '#e2e_sparkle_note'
// the recording of the produced document as the vault's transport fixture is EXPLICIT
// (RECORD_FIXTURES=1); every other run checks that the committed fixture still decodes
const RECORD = process.env.RECORD_FIXTURES === '1'
const FIXTURE = resolve('tests/e2e/fixtures/watch_command.json')

type Command = { doc: string; wrapper: { name: string; item: Record<string, any> }; raw: Record<string, any> }

async function cleanup() {
  const db = firestore()
  const docs = await db.collection('items').where('user', '==', USER.uid).get()
  for (const doc of docs.docs) await doc.ref.delete()
  await db.collection('users').doc(USER.uid).delete()
}

async function enterPhrase(page: Page, prompt: RegExp, phrase: string, button: string) {
  await expect(page.getByText(prompt)).toBeVisible({ timeout: 60_000 })
  await page.fill('#modal-input', phrase)
  await page.locator('.modal .button.confirm', { hasText: button }).click()
}

// every hidden document of the account with its decrypted wrapper (the app writes v0 under its
// default write gate, so the account's stored secret reads it)
async function hidden(): Promise<Command[]> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const snap = await firestore().collection('items').where('user', '==', USER.uid).where('hidden', '==', true).get()
  const out: Command[] = []
  for (const doc of snap.docs) {
    try {
      const raw = doc.data()
      const wrapper = JSON.parse(JSON.parse(await decryptWithSecret(raw.cipher, SECRET)).text)
      if (typeof wrapper.name == 'string') out.push({ doc: doc.id, wrapper, raw })
    } catch {} // an unrelated or differently keyed record
  }
  return out
}
const commands = async () => (await hidden()).filter(d => d.wrapper.name.startsWith('watch_command_'))

// the bridge's store write behind the app (the app's hidden document shape, v0): the store of
// the labelled item as the server holds it, edited and written back in place
async function publish(page: Page, label: string, edit: (store: Record<string, any>) => void) {
  const { encryptWithSecret } = await import('../../src/crypto.js')
  const name = 'global_store_' + (await savedId(page, label))
  const held = (await hidden()).find(d => d.wrapper.name == name)
  expect(held, `the ${label} item's store exists on the server`).toBeTruthy()
  const item = held!.wrapper.item
  edit(item)
  const time = Date.now()
  const cipher = await encryptWithSecret(JSON.stringify({ hidden: true, time, attr: null, text: JSON.stringify({ name, item }) }), SECRET)
  await firestore().collection('items').doc(held!.doc).set({ user: USER.uid, time, hidden: true, text: null, attr: null, cipher })
}
// the bridge's #status entry for its host, and who watches in the #vault listing
const fresh = (page: Page, age_ms = 0) =>
  publish(page, '#status', store => {
    store._status = { v: 1, hosts: { [HOST]: { v: 1, updated: Date.now() - age_ms, boot: 1, publisher: 'bridge', runs: [], finished: [], tasks: [] } } }
  })
const watched = (page: Page, watcher: Record<string, string> | null) =>
  publish(page, '#vault', store => {
    store._bridge = { v: 1, host: HOST, boot: 1, updated: Date.now(), runs: {}, queued: {}, workers: {}, worktrees: {}, ...(watcher ? { watcher } : {}) }
  })

const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)

// what the page holds of the sparkle: its parts by their marker, and the element's own state
const sparkle = (page: Page) =>
  page.evaluate(() => {
    const parts = (kind: string) => [...document.querySelectorAll(`[data-vault-sparkle="${kind}"]`)] as HTMLElement[]
    const node = parts('node')[0]
    const rect = node?.getBoundingClientRect()
    return {
      nodes: parts('node').length,
      styles: parts('style').length,
      menus: parts('menu').length,
      shown: !!node && !node.hidden && rect.width > 0,
      title: node?.title ?? null,
      answering: node?.classList.contains('answering') ?? null,
    }
  })
const shown = (title: string, more: Record<string, unknown> = {}) => ({ nodes: 1, styles: 1, menus: 0, shown: true, title, answering: false, ...more })
const NODE = '[data-vault-sparkle="node"]'
const ENTRY = '[data-vault-sparkle="menu"] > button'

const dialogs: string[] = []

test.beforeAll(cleanup)
test.afterAll(cleanup)

test('the sparkle shows who watches the account, and its menu stops that watch', async ({ page, context }) => {
  page.on('dialog', dialog => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
  await page.addInitScript(() => localStorage.setItem('mindpage_github_token', 'e2e-local'))
  const token = await customToken(USER)
  await page.goto('/')
  await page.waitForFunction(() => !!window.firebase?.auth?.signInWithCustomToken, null, { timeout: 30_000 })
  await page.evaluate(token => {
    sessionStorage.setItem('mindpage_signin_pending', '1')
    document.cookie = '__session=signin_pending;max-age=600'
    void window.firebase.auth.signInWithCustomToken(window.firebase.auth.getAuth(window.firebase), token)
  }, token)
  await expect
    .poll(() => page.evaluate(() => window._init_time > 0 && window._readonly === false).catch(() => false), { timeout: 90_000 })
    .toBe(true)
  await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
  await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
  await waitForApp(page)
  expect(await install(page, 'status'), '/_install status').toBeNull()
  await page.reload()
  await waitForApp(page)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 30_000 }).toBe(true)

  // (a) an install after the page's welcome: the item's own change draws the element, hidden
  // while nobody watches, and the app's install hook provisions the store (the hook the app
  // did not run before its fix of 2026-11-15)
  expect(await sparkle(page)).toMatchObject({ nodes: 0, styles: 0 })
  expect(await install(page, 'vault'), '/_install vault').toBeNull()
  await expect.poll(async () => (await sparkle(page)).nodes, { timeout: 30_000 }).toBe(1)
  expect(await sparkle(page)).toMatchObject({ nodes: 1, styles: 1, menus: 0, shown: false })
  await expect.poll(async () => !!(await savedId(page, '#vault')) && !!(await savedId(page, '#status')), { timeout: 30_000 }).toBe(true)
  const vaultStore = 'global_store_' + (await savedId(page, '#vault'))
  const statusStore = 'global_store_' + (await savedId(page, '#status'))
  const held = async (name: string) => (await hidden()).some(d => d.wrapper.name == name)
  await expect.poll(() => held(statusStore), { message: 'the #status store is provisioned (its welcome)', timeout: 30_000 }).toBe(true)
  await expect.poll(() => held(vaultStore), { message: 'the #vault store is provisioned (its _on_install)', timeout: 30_000 }).toBe(true)

  // (b) #vault off screen: the page shows a plain item alone, and the vault item has no
  // element; the bridge publishes its #status entry and who watches
  await page.evaluate(text => void window._create(text), `${NOTE} a plain item`)
  await expect.poll(() => savedId(page, NOTE), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(label => (window as any).MindBox.set(label), NOTE)
  await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false && window._item('#vault', true)?.elem == null), { timeout: 30_000 }).toBe(true)
  await fresh(page)
  await watched(page, { name: AGENT, took: TOOK, state: 'watching' })
  await expect.poll(() => sparkle(page), { timeout: 30_000 }).toEqual(shown(`${AGENT} is watching`))
  expect(await page.evaluate(() => window._item('#vault', true)?.elem == null), '#vault is still off screen').toBe(true)
  // the element is the page's own: at its lower right, above the items
  const placed = await page.evaluate(sel => {
    const node = document.querySelector(sel) as HTMLElement
    const rect = node.getBoundingClientRect()
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return { parent: node.parentElement === document.body, right: Math.round(document.documentElement.clientWidth - rect.right), bottom: Math.round(window.innerHeight - rect.bottom), size: [rect.width, rect.height], top: !!top && node.contains(top) }
  }, NODE)
  expect(placed).toEqual({ parent: true, right: 14, bottom: 10, size: [24, 24], top: true })
  await watched(page, { name: AGENT, took: TOOK, state: 'answering', by: 'gpt-6-astra-ultra' })
  await expect.poll(() => sparkle(page), { timeout: 30_000 }).toEqual(shown('gpt-6-astra-ultra is answering a request', { answering: true }))
  await watched(page, { name: AGENT, took: TOOK, state: 'watching' })
  await expect.poll(() => sparkle(page), { timeout: 30_000 }).toEqual(shown(`${AGENT} is watching`))
  await fresh(page, 4 * 60_000) // the bridge's entry four minutes old: stale
  await expect.poll(async () => (await sparkle(page)).shown, { timeout: 30_000 }).toBe(false)
  await fresh(page)
  await expect.poll(async () => (await sparkle(page)).shown, { timeout: 30_000 }).toBe(true)

  // (c) the keyboard: Enter on the focused sparkle opens the menu with its entry focused,
  // and is not the app's Enter, which would open the shown item's editor (the plain item is
  // editable) and take the focus there; a digit pressed in the menu is not the app's either,
  // which would navigate to that item; Escape closes the menu, back to the sparkle
  const focused = () => page.evaluate(() => [(document.activeElement as HTMLElement | null)?.dataset?.vaultSparkle ?? null, document.activeElement?.textContent ?? null])
  const query = () => page.evaluate(() => (window as any).MindBox.get())
  await page.locator(NODE).focus()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  expect(await focused()).toEqual([null, 'Stop Watching'])
  await page.keyboard.press('2')
  await page.waitForFunction(() => (window as any)._mindboxDebounced === false)
  expect([await focused(), await query(), (await sparkle(page)).menus]).toEqual([[null, 'Stop Watching'], NOTE, 1])
  expect(await page.locator('.editor textarea:focus').count(), 'no item editor took the focus').toBe(0)
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await sparkle(page)).menus).toBe(0)
  expect([await focused(), await query()]).toEqual([['node', ''], NOTE])
  // a modal over an open menu: the menu closes, and the modal's keys are the modal's
  await page.keyboard.press('Space')
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  await page.evaluate(() => void (window as any)._modal('a modal over the menu', { confirm: 'OK' }))
  await expect.poll(() => page.evaluate(() => (window as any)._modal_visible())).toBe(true)
  await expect.poll(async () => (await sparkle(page)).menus).toBe(0)
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any)._modal_visible())).toBe(false)
  expect([(await sparkle(page)).menus, (await commands()).length]).toEqual([0, 0])

  // (d) the watch is replaced while the menu is open: the menu that showed the earlier one closes
  await page.locator(NODE).click()
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  await watched(page, { name: AGENT, took: LATER, state: 'watching' })
  await expect.poll(async () => (await sparkle(page)).menus, { timeout: 30_000 }).toBe(0)
  expect(await sparkle(page)).toEqual(shown(`${AGENT} is watching`))

  // (e) Stop Watching: one command document through the app's hidden-document operation, naming
  // the watch the menu showed; the sparkle shows the stop until the watcher goes
  await page.locator(NODE).click()
  await page.locator(ENTRY).click()
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(1)
  const [stop] = await commands()
  expect(stop.wrapper.name).toBe('watch_command_' + stop.wrapper.item.id)
  expect(stop.wrapper.item).toEqual({ id: stop.wrapper.item.id, kind: 'stop', took: LATER, at: stop.wrapper.item.at })
  expect([stop.raw.hidden, stop.raw.text, stop.raw.user]).toEqual([true, null, USER.uid])
  expect(await sparkle(page)).toEqual(shown(`Stopping ${AGENT}'s watch`, { answering: true }))
  const fixture = { user: USER.uid, secret: SECRET, doc: stop.doc, data: stop.raw, took: LATER }
  if (RECORD) {
    mkdirSync(resolve('tests/e2e/fixtures'), { recursive: true })
    writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + '\n')
  } else {
    expect(existsSync(FIXTURE), 'the recorded fixture exists (RECORD_FIXTURES=1 records it)').toBe(true)
    const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const { decryptWithSecret } = await import('../../src/crypto.js')
    const wrapper = JSON.parse(JSON.parse(await decryptWithSecret(recorded.data.cipher, recorded.secret)).text)
    expect([wrapper.name, wrapper.item.kind, wrapper.item.took]).toEqual([`watch_command_${wrapper.item.id}`, 'stop', recorded.took])
    expect(Object.keys(wrapper.item).sort(), 'the recorded command has the fields the app writes now').toEqual(Object.keys(stop.wrapper.item).sort())
  }
  await firestore().collection('items').doc(stop.doc).delete() // the bridge deletes what it dealt with
  await watched(page, null) // and the watcher it stopped is gone from the listing
  await expect.poll(async () => (await sparkle(page)).shown, { timeout: 30_000 }).toBe(false)

  // (f) another tab updates the item while the menu is open here: this tab's controller is
  // replaced (the earlier code's menu, element and style go; one element stays), and the other
  // tab draws its own, one too
  await watched(page, { name: AGENT, took: TOOK, state: 'watching' })
  await expect.poll(async () => (await sparkle(page)).shown, { timeout: 30_000 }).toBe(true)
  await page.locator(NODE).click()
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  const code = await page.evaluate(() => (window as any)._vault_sparkle.code)
  const other = await context.newPage()
  await other.goto('/')
  await waitForApp(other)
  await expect.poll(async () => (await sparkle(other)).shown, { timeout: 60_000 }).toBe(true)
  await other.evaluate(() => {
    const item = window._item('#vault', true)!
    item.write(item.read('').replace('lists what the vault', 'lists  what the vault'), '')
  })
  await expect.poll(() => page.evaluate(() => (window as any)._vault_sparkle?.code), { timeout: 60_000 }).not.toBe(code)
  expect(await sparkle(page)).toEqual(shown(`${AGENT} is watching`))
  await expect.poll(() => sparkle(other), { timeout: 30_000 }).toEqual(shown(`${AGENT} is watching`))
  await other.close()

  // (g) a visual viewport much shorter than the window, as a phone's keyboard leaves it
  // (simulated: the window is made to report a taller height than the viewport's), hides the
  // sparkle at the viewport's own event; its return shows it again
  await page.evaluate(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => window.visualViewport!.height + 300 })
    window.visualViewport!.dispatchEvent(new Event('resize'))
  })
  expect((await sparkle(page)).shown).toBe(false)
  await page.evaluate(() => {
    delete (window as any).innerHeight
    window.visualViewport!.dispatchEvent(new Event('resize'))
  })
  expect(await sparkle(page)).toEqual(shown(`${AGENT} is watching`))

  // (g2) the item renamed, with its code, its store and the bridge's fresh entry as they were:
  // it is not the page's #vault, so it shows nothing; named #vault again, it draws again. This
  // is the check on the app's real label lookup: the poll's bound allows the cleanup to be the
  // own-change hook's or the task's (the plain-node table drives the hook itself)
  const relabel = (from: string, to: string) =>
    page.evaluate(([from, to]) => {
      const item = window._item(from, true)!
      item.write(item.read('').replace(from + ' lists', to + ' lists'), '')
    }, [from, to])
  await relabel('#vault', '#vault_old')
  await expect.poll(() => sparkle(page), { timeout: 30_000 }).toMatchObject({ nodes: 0, styles: 0, menus: 0 })
  expect(await page.evaluate(() => (window._item('#vault_old', true) as any)?._global_store?._bridge?.watcher?.name)).toBe(AGENT)
  await relabel('#vault_old', '#vault')
  await expect.poll(() => sparkle(page), { timeout: 30_000 }).toEqual(shown(`${AGENT} is watching`))

  // (h) the item is deleted: its task's next look removes everything the sparkle owned
  await page.evaluate(() => window._item('#vault', true)!.delete(false))
  await expect.poll(() => sparkle(page), { timeout: 45_000 }).toMatchObject({ nodes: 0, styles: 0, menus: 0 })
  expect(await page.evaluate(() => '_vault_sparkle' in window)).toBe(false)

  // (i) installed again and watched, then a successful sign-out: the reloaded page has none
  expect(await install(page, 'vault'), '/_install vault again').toBeNull()
  await expect.poll(async () => !!(await savedId(page, '#vault')), { timeout: 30_000 }).toBe(true)
  const reinstalled = 'global_store_' + (await savedId(page, '#vault'))
  await expect.poll(async () => (await hidden()).some(d => d.wrapper.name == reinstalled), { timeout: 30_000 }).toBe(true)
  await watched(page, { name: AGENT, took: TOOK, state: 'watching' })
  await expect.poll(() => sparkle(page), { timeout: 30_000 }).toEqual(shown(`${AGENT} is watching`))
  await page.evaluate(() => void window._create('/_signout', { command: true }))
  await expect.poll(() => page.evaluate(() => window._readonly === true && window._init_time > 0).catch(() => false), { timeout: 90_000 }).toBe(true)
  expect(await sparkle(page)).toMatchObject({ nodes: 0, styles: 0, menus: 0 })
  expect(dialogs, 'no alert of the sparkle or the installs').toEqual([])
})
