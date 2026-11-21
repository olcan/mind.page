import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { customToken, firestore, install, interceptMindItems, loadUser, secretFor, waitForApp, type TestUser } from './helpers.js'

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
// fixture), and the sparkle shows the stop until the watcher goes, when it is the dim offer to
// start one; (e1) a menu a pointer opens has no entry highlighted until the pointer or an arrow
// comes and never two, Escape there gives the focus up, and a click outside lands on the menu's
// layer: it closes the menu and is nothing to the page under it; the focused offer shows a ring
// and stays dim; (e2 to e5, slice 6) a click on the offer starts nothing and opens the menu,
// whose Start Claude Watcher sends one start with the bridge's heartbeat as the page has it and
// shows as starting, and a click then opens the menu on Cancel Start, which names that
// start; after an outcome that is not known a click opens the menu; Resume Last Watcher names
// the last watcher the menu showed; Close Agent Session asks in the app's real dialog, sends
// nothing when it is cancelled, and names the take the menu showed though another watch took
// the account meanwhile (the four documents recorded as the vault's fixture); (f) another tab's update of
// the item, with the menu open here, replaces the controller: still one element, the menu gone;
// (g) a visual viewport much shorter than the window hides the sparkle and its return shows it
// (SIMULATED: a desktop lane has no on-screen keyboard); (g2) the item renamed, its code kept,
// is no longer the page's #vault: its sparkle goes, with its store still naming the watcher and
// the bridge fresh, and comes back when the item is #vault again.
// A second row, on the same account as a returning device, is the watched mark (the vault's
// design note, D25): what the item watcher follows is published as rules in the same value, and
// the item marks the items the rules name (its phases are at the row). The LAST row, on the
// same account as a returning device too, is the sparkle's end: (h) the item's deletion removes
// it at the task's next look; (i) installed again and watched, a successful sign-out leaves none
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)
// the bound of the polls that wait for the page or the server (30 s; the others carry their own).
// A pin of these rows may lower it on its own command, as an opt-in, so that a caught mutant fails
// in seconds: `E2E_POLL_MS=5000 tests/e2e/run.sh tests/e2e/sparkle.spec.ts ...`, after a control of
// the unmutated rows at the same bound. Never set for the gate, which needs no guard: a lower bound
// can only make a healthy row fail, never hide a failure. A positive bound below 30 s; any other
// value, or none, is the 30 s
const POLL_MS = (ms => (Number.isInteger(ms) && ms > 0 && ms < 30_000 ? ms : 30_000))(Number(process.env.E2E_POLL_MS))

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
// RECORD_FIXTURES=sessions records slice 6's fixture alone, and leaves the stop's as committed
const RECORD_SESSIONS = RECORD || process.env.RECORD_FIXTURES === 'sessions'
const FIXTURE = resolve('tests/e2e/fixtures/watch_command.json')
// slice 6's four commands, recorded the same way: the vault's consumer reads them
// (tests/test_mindpage_watch_commands.py). The last watcher's key is the bridge's own for this
// agent and session (sixteen hex digits of a SHA-256 over both), so the consumer's resume
// finds the watcher the recorded command names
const SESSIONS = resolve('tests/e2e/fixtures/watch_session_commands.json')
const SESSION = 'sess-e2e-1234'
const KEY = createHash('sha256').update(`claude\0${SESSION}`).digest('hex').slice(0, 16)

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
const watched = (page: Page, watcher: Record<string, any> | null) =>
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
      layers: parts('backdrop').length,
      shown: !!node && !node.hidden && rect.width > 0,
      title: node?.title ?? null,
      answering: node?.classList.contains('answering') ?? null,
      idle: node?.classList.contains('idle') ?? null,
    }
  })
const shown = (title: string, more: Record<string, unknown> = {}) => ({ nodes: 1, styles: 1, menus: 0, layers: 0, shown: true, title, answering: false, idle: false, ...more })
// with nobody watching the sparkle is dim: the offer, a start under way, or what became of one
const offered = (title: string, more: Record<string, unknown> = {}) => shown(title, { idle: true, ...more })
const OFFER = 'Start a watcher'
const STARTING = 'An agent is starting to watch'
// the menu's entries, the bridge's heartbeat as the page has it, and the one command document
// the account holds (the bridge, played here, deletes each once it is checked)
const entries = (page: Page) => page.locator(ENTRY).allTextContents()
const heartbeat = (page: Page) => page.evaluate(host => (window._item('#status', true) as any)._global_store._status.hosts[host].updated as number, HOST)
const sent = async (kind: string) => {
  await expect.poll(async () => (await commands()).map(c => c.wrapper.item.kind), { timeout: POLL_MS }).toEqual([kind])
  const [command] = await commands()
  expect(command.wrapper.name).toBe('watch_command_' + command.wrapper.item.id)
  expect([command.raw.hidden, command.raw.text, command.raw.user]).toEqual([true, null, USER.uid])
  await firestore().collection('items').doc(command.doc).delete()
  return command
}
const NODE = '[data-vault-sparkle="node"]'
const ENTRY = '[data-vault-sparkle="menu"] > button'

const dialogs: string[] = []

test.beforeAll(cleanup)
test.afterAll(cleanup)

test('the sparkle shows who watches the account, and its menu stops that watch', async ({ page, context }) => {
  // a `beforeunload` prompt is accepted and recorded: dismissed, it would cancel the reload it
  // interrupts, and `page.reload()` would wait out the whole test's time for a navigation
  page.on('dialog', dialog => {
    const leaving = dialog.type() == 'beforeunload'
    dialogs.push(leaving ? `beforeunload: ${dialog.message()}` : dialog.message())
    void (leaving ? dialog.accept() : dialog.dismiss())
  })
  expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
  await page.addInitScript(() => localStorage.setItem('mindpage_github_token', 'e2e-local'))
  const token = await customToken(USER)
  await page.goto('/')
  await page.waitForFunction(() => !!window.firebase?.auth?.signInWithCustomToken, null, { timeout: POLL_MS })
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
  // the install returns before its writes are acknowledged, and the app asks "Discard unsaved
  // changes?" at a reload over an unsaved item: wait for the writes first
  await page.waitForFunction(() => (window as any).__items.every((item: any) => item.text == item.savedText), null, { timeout: POLL_MS })
  await page.reload({ timeout: 60_000 })
  await waitForApp(page)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: POLL_MS }).toBe(true)

  // (a) an install after the page's welcome: the item's own change draws the element, hidden
  // while nobody watches, and the app's install hook provisions the store (the hook the app
  // did not run before its fix of 2026-11-15)
  expect(await sparkle(page)).toMatchObject({ nodes: 0, styles: 0 })
  expect(await install(page, 'vault'), '/_install vault').toBeNull()
  await expect.poll(async () => (await sparkle(page)).nodes, { timeout: POLL_MS }).toBe(1)
  expect(await sparkle(page)).toMatchObject({ nodes: 1, styles: 1, menus: 0, layers: 0, shown: false })
  await expect.poll(async () => !!(await savedId(page, '#vault')) && !!(await savedId(page, '#status')), { timeout: POLL_MS }).toBe(true)
  const vaultStore = 'global_store_' + (await savedId(page, '#vault'))
  const statusStore = 'global_store_' + (await savedId(page, '#status'))
  const held = async (name: string) => (await hidden()).some(d => d.wrapper.name == name)
  await expect.poll(() => held(statusStore), { message: 'the #status store is provisioned (its welcome)', timeout: POLL_MS }).toBe(true)
  await expect.poll(() => held(vaultStore), { message: 'the #vault store is provisioned (its _on_install)', timeout: POLL_MS }).toBe(true)

  // (b) #vault off screen: the page shows a plain item alone, and the vault item has no
  // element; the bridge publishes its #status entry and who watches
  await page.evaluate(text => void window._create(text), `${NOTE} a plain item`)
  await expect.poll(() => savedId(page, NOTE), { timeout: POLL_MS }).toBeTruthy()
  await page.evaluate(label => (window as any).MindBox.set(label), NOTE)
  await expect.poll(() => page.evaluate(() => (window as any)._mindboxDebounced === false && window._item('#vault', true)?.elem == null), { timeout: POLL_MS }).toBe(true)
  await fresh(page)
  await watched(page, { name: AGENT, took: TOOK, state: 'watching' })
  await expect.poll(() => sparkle(page), { timeout: POLL_MS }).toEqual(shown(`${AGENT} is watching`))
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
  await expect.poll(() => sparkle(page), { timeout: POLL_MS }).toEqual(shown('gpt-6-astra-ultra is answering', { answering: true }))
  await watched(page, { name: AGENT, took: TOOK, state: 'watching' })
  await expect.poll(() => sparkle(page), { timeout: POLL_MS }).toEqual(shown(`${AGENT} is watching`))
  await fresh(page, 4 * 60_000) // the bridge's entry four minutes old: stale
  await expect.poll(async () => (await sparkle(page)).shown, { timeout: POLL_MS }).toBe(false)
  await fresh(page)
  await expect.poll(async () => (await sparkle(page)).shown, { timeout: POLL_MS }).toBe(true)

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
  await expect.poll(async () => (await sparkle(page)).menus, { timeout: POLL_MS }).toBe(0)
  expect(await sparkle(page)).toEqual(shown(`${AGENT} is watching`))

  // (e) Stop Watching: one command document through the app's hidden-document operation, naming
  // the watch the menu showed; the sparkle shows the stop until the watcher goes
  await page.locator(NODE).click()
  await page.locator(ENTRY).click()
  await expect.poll(async () => (await commands()).length, { timeout: POLL_MS }).toBe(1)
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
  await watched(page, null) // and the watcher it stopped is gone from the listing: the offer, dim
  await expect.poll(() => sparkle(page), { timeout: POLL_MS }).toEqual(offered(OFFER))

  // (e1) a menu a pointer opens. No entry is highlighted until the pointer or an arrow comes,
  // and one at most: the highlight is the focus, which the pointer over an entry takes there
  // and an arrow moves on, though the pointer still rests where it was; a mouse that leaves the
  // menu leaves no entry with it. Escape closes it and the sparkle takes no focus: the
  // keyboard is the page's
  const lit = () => page.evaluate(sel => [...document.querySelectorAll(sel)].map(b => getComputedStyle(b).backgroundColor != 'rgba(0, 0, 0, 0)'), ENTRY)
  await page.locator(NODE).click({ button: 'right' })
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  expect([(await focused())[0], await lit(), (await sparkle(page)).layers]).toEqual(['menu', [false, false], 1])
  await page.locator(ENTRY).nth(1).hover()
  expect([(await focused())[1], await lit()]).toEqual(['Start Codex Watcher', [false, true]])
  await page.keyboard.press('ArrowUp')
  expect([(await focused())[1], await lit()]).toEqual(['Start Claude Watcher', [true, false]])
  await page.mouse.move(20, 20)
  await expect.poll(lit).toEqual([false, false])
  expect((await focused())[0]).toBe('menu')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await sparkle(page)).menus).toBe(0)
  expect([(await focused())[0], (await sparkle(page)).layers, (await commands()).length], 'the keyboard is the page\'s: the sparkle took no focus').toEqual([null, 0, 0])
  // a click outside an open menu lands on its layer, wherever it is: over the plain item, whose
  // editor a click opens, the menu closes and the item is not touched
  const noteId = await page.evaluate(label => window._item(label, true)!.id, NOTE)
  const paragraph = (await page.locator(`#item-${noteId} p`).first().boundingBox())!
  const over = [paragraph.x + paragraph.width / 2, paragraph.y + paragraph.height / 2]
  const editing = () => page.evaluate(label => (window._item(label, true) as any).editing as boolean, NOTE)
  await page.locator(NODE).click({ button: 'right' })
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  expect(await page.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.dataset?.vaultSparkle ?? null, over)).toBe('backdrop')
  // the layer darkens and blurs the page under the menu
  expect(
    await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('[data-vault-sparkle="backdrop"]')!)
      return [style.backgroundColor, style.backdropFilter]
    }),
  ).toEqual(['rgba(0, 0, 0, 0.4)', 'blur(2px)'])
  await page.mouse.click(over[0], over[1])
  expect([await editing(), (await sparkle(page)).menus, (await sparkle(page)).layers, (await focused())[0], await query()], 'the click was the layer\'s').toEqual([false, 0, 0, null, NOTE])
  expect(await page.locator('.editor textarea:focus').count(), 'no item editor took the focus').toBe(0)
  // a mouse's press gives the sparkle no focus, whatever its click then does: a button that a
  // click focused can show its ring at a later key. One click opens the menu and a second
  // closes it: the sparkle has no focus then, and a key brings no ring to it
  await page.locator(NODE).click()
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  expect((await focused())[0]).toBe('menu')
  await page.locator(NODE).click()
  await expect.poll(async () => (await sparkle(page)).menus).toBe(0)
  await page.keyboard.press('Shift')
  expect([(await focused())[0], await page.locator(NODE).evaluate(node => node.matches(':focus-visible'))], 'a clicked sparkle holds no focus and shows no ring at a key').toEqual([null, false])
  await page.mouse.move(20, 20) // off the sparkle: the pointer rested on it

  // (e2) slice 6. Enter on the focused offer starts nothing: it opens the menu, on its first
  // start, and held there (its repeat goes to that entry, which has the focus by then) it still
  // starts nothing. A click on the offer starts nothing either: it opens the menu, whose Start
  // Claude Watcher sends one start with the bridge's heartbeat as the page has it; the sparkle
  // shows it at once and does not keep the keyboard, and a click then starts nothing more
  await page.locator(NODE).focus()
  await page.keyboard.down('Enter')
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  await page.keyboard.down('Enter') // the held key repeats
  await page.keyboard.up('Enter')
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  expect([await entries(page), await focused(), (await commands()).length]).toEqual([['Start Claude Watcher', 'Start Codex Watcher'], [null, 'Start Claude Watcher'], 0])
  await page.keyboard.press('Escape')
  expect(await focused()).toEqual(['node', ''])
  // the focus shows as a ring alone: under it the offer's star is as dim as it was (how bright
  // the star is says whether an agent watches), on its circle, a gray a little lighter than an
  // item's, which never dims; a pointer over the offer brightens the star, where one hovers
  const look = () =>
    page.evaluate(sel => {
      const node = document.querySelector(sel) as HTMLElement
      const style = getComputedStyle(node)
      return { ring: node.matches(':focus-visible'), star: style.color, circle: `${style.backgroundColor} ${style.opacity}`, outline: `${style.outlineWidth} ${style.outlineStyle}` }
    }, NODE)
  const DIM = 'rgba(245, 227, 137, 0.45)'
  const CIRCLE = 'rgb(34, 34, 34) 1'
  expect(await look()).toEqual({ ring: true, star: DIM, circle: CIRCLE, outline: '1px solid' })
  await page.locator(NODE).hover()
  expect([(await look()).star, (await look()).circle]).toEqual(['rgba(245, 227, 137, 0.9)', CIRCLE])
  await page.mouse.move(20, 20)
  expect((await look()).star).toBe(DIM)
  const beat = await heartbeat(page)
  await page.locator(NODE).click()
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  expect([await entries(page), (await commands()).length], 'a click on the offer starts nothing: it opens the menu').toEqual([['Start Claude Watcher', 'Start Codex Watcher'], 0])
  await page.locator(ENTRY).first().click()
  const start = await sent('start')
  expect(start.wrapper.item).toEqual({ id: start.wrapper.item.id, kind: 'start', agent: 'claude', seen: beat, at: start.wrapper.item.at })
  expect(await sparkle(page)).toEqual(offered(STARTING, { answering: true }))
  expect((await focused())[0], 'the keyboard is the page\'s again').toBeNull()
  await page.locator(NODE).click()
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  expect([await entries(page), (await commands()).length]).toEqual([['Cancel Start'], 0])
  await page.keyboard.press('Escape')
  // the bridge names the start: this tab's own mark is over, and the bridge's record shows
  const begun = { id: start.wrapper.item.id, agent: 'claude', at: new Date().toISOString(), state: 'starting', tab: true }
  await watched(page, { state: 'none', start: begun })
  await expect.poll(() => page.evaluate(() => (window as any)._vault_sparkle.marks.started), { timeout: POLL_MS }).toBeNull()
  expect(await sparkle(page)).toEqual(offered(STARTING, { answering: true }))

  // (e3) Cancel Start names the start the menu showed
  await page.locator(NODE).click()
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  expect([await entries(page), (await commands()).length]).toEqual([['Cancel Start'], 0])
  await page.locator(ENTRY).click()
  const cancel = await sent('cancel')
  expect(cancel.wrapper.item).toEqual({ id: cancel.wrapper.item.id, kind: 'cancel', start: begun.id, seen: await heartbeat(page), at: cancel.wrapper.item.at })
  expect(await sparkle(page)).toEqual(offered('Cancelling the start', { answering: true }))
  // the bridge could not tell what became of it: a click then opens the menu, and starts nothing
  await watched(page, { state: 'none', start: { ...begun, state: 'unknown', note: 'no watcher appeared' } })
  await expect.poll(() => sparkle(page), { timeout: POLL_MS }).toEqual(offered("A start's outcome is unknown: no watcher appeared"))
  await page.locator(NODE).click()
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  expect([await entries(page), (await commands()).length]).toEqual([['Start Claude Watcher', 'Start Codex Watcher', 'Cancel Start'], 0])
  await page.keyboard.press('Escape')

  // (e4) the last watcher that can be resumed: the right click opens the menu on the offer,
  // and the resume names that watcher by the bridge's key
  await watched(page, { state: 'none', last: { name: AGENT, agent: 'claude', key: KEY } })
  await expect.poll(() => sparkle(page), { timeout: POLL_MS }).toEqual(offered(OFFER))
  await page.locator(NODE).click({ button: 'right' })
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  expect(await entries(page)).toEqual(['Start Claude Watcher', 'Start Codex Watcher', 'Resume Last Watcher (Claude)'])
  await page.locator(ENTRY).nth(2).click()
  const resume = await sent('resume')
  expect(resume.wrapper.item).toEqual({ id: resume.wrapper.item.id, kind: 'resume', last: KEY, seen: await heartbeat(page), at: resume.wrapper.item.at })
  // the bridge names the resume, which ends this tab's mark of it (a watcher alone would only
  // hide the mark: the page cannot tell whose start a watcher was)
  const resumed = { id: resume.wrapper.item.id, agent: 'claude', resume: true, at: new Date().toISOString(), state: 'starting', tab: true }
  await watched(page, { state: 'none', start: resumed, last: { name: AGENT, agent: 'claude', key: KEY } })
  await expect.poll(() => page.evaluate(() => (window as any)._vault_sparkle.marks.started), { timeout: POLL_MS }).toBeNull()

  // (e5) Close Agent Session, for a watcher in a herdr tab the bridge can close: the app's own
  // dialog first; cancelled, nothing is sent; confirmed, the close names the take the menu
  // showed, though another watch took the account while the dialog was open
  // The watcher's herdr tab, as the bridge gives it, hangs on the sparkle for a browser's
  // extension that can bring the tab up (none here: the click is the menu's, below)
  const JUMP = { tab: 'w4:tB', host: 'm3ultra', herdr: 'm3ultra:default', session: SESSION }
  const hung = () => page.locator(NODE).getAttribute('data-vault-jump')
  expect(await hung(), 'nothing to bring up while nobody watches').toBeNull()
  await watched(page, { name: AGENT, took: TOOK, state: 'watching', tab: true, jump: JUMP })
  await expect.poll(() => sparkle(page), { timeout: POLL_MS }).toEqual(shown(`${AGENT} is watching`))
  expect(await hung()).toBe(JSON.stringify(JUMP))
  const dialog = page.locator('.modal')
  for (const answer of ['cancel', 'confirm']) {
    await page.locator(NODE).click()
    await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
    expect(await entries(page)).toEqual(['Stop Watching', 'Close Agent Session'])
    await page.locator(ENTRY).nth(1).click()
    await expect(dialog).toContainText(`Close ${AGENT}'s session?`)
    await expect(dialog).toContainText('Its herdr tab closes, which ends the agent. Its conversation can be resumed.')
    expect([(await sparkle(page)).menus, (await commands()).length]).toEqual([0, 0])
    if (answer == 'confirm') {
      await watched(page, { name: AGENT, took: LATER, state: 'watching', tab: true })
      await expect.poll(() => page.evaluate(() => (window as any)._vault_sparkle.shown?.took), { timeout: POLL_MS }).toBe(LATER)
    }
    await page.locator(`.modal .button.${answer}`).click()
    await expect.poll(() => page.evaluate(() => (window as any)._modal_visible())).toBe(false)
    if (answer == 'cancel') expect((await commands()).length, 'a close that is not confirmed sends nothing').toBe(0)
  }
  const close = await sent('close')
  expect(close.wrapper.item).toEqual({ id: close.wrapper.item.id, kind: 'close', took: TOOK, seen: await heartbeat(page), at: close.wrapper.item.at })
  const session = {
    user: USER.uid,
    secret: SECRET,
    host: HOST,
    agent: 'claude',
    session: SESSION,
    key: KEY,
    took: TOOK,
    commands: Object.fromEntries([start, cancel, resume, close].map(c => [c.wrapper.item.kind, { doc: c.doc, data: c.raw }])) as Record<string, { doc: string; data: Record<string, any> }>,
  }
  if (RECORD_SESSIONS) writeFileSync(SESSIONS, JSON.stringify(session, null, 2) + '\n')
  else {
    expect(existsSync(SESSIONS), 'the recorded fixture exists (RECORD_FIXTURES=1 records it)').toBe(true)
    const recorded = JSON.parse(readFileSync(SESSIONS, 'utf8'))
    const { decryptWithSecret } = await import('../../src/crypto.js')
    for (const [kind, command] of Object.entries(session.commands)) {
      const wrapper = JSON.parse(JSON.parse(await decryptWithSecret(recorded.commands[kind].data.cipher, recorded.secret)).text)
      const now = JSON.parse(JSON.parse(await decryptWithSecret(command.data.cipher, SECRET)).text)
      expect([wrapper.name, wrapper.item.kind], `the recorded ${kind}`).toEqual([`watch_command_${wrapper.item.id}`, kind])
      expect(Object.keys(wrapper.item).sort(), `the recorded ${kind} has the fields the app writes now`).toEqual(Object.keys(now.item).sort())
    }
    expect([recorded.key, recorded.took, recorded.session]).toEqual([KEY, TOOK, SESSION])
  }
  await watched(page, null)
  await expect.poll(() => sparkle(page), { timeout: POLL_MS }).toEqual(offered(OFFER))

  // (f) another tab updates the item while the menu is open here: this tab's controller is
  // replaced (the earlier code's menu, element and style go; one element stays), and the other
  // tab draws its own, one too
  await watched(page, { name: AGENT, took: TOOK, state: 'watching' })
  await expect.poll(async () => (await sparkle(page)).shown, { timeout: POLL_MS }).toBe(true)
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
  await expect.poll(() => sparkle(other), { timeout: POLL_MS }).toEqual(shown(`${AGENT} is watching`))
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
  // 30 s, never POLL_MS: the cleanup can be the task's, whose next look is up to 15 s away
  await expect.poll(() => sparkle(page), { timeout: 30_000 }).toMatchObject({ nodes: 0, styles: 0, menus: 0, layers: 0 })
  expect(await page.evaluate(() => (window._item('#vault_old', true) as any)?._global_store?._bridge?.watcher?.name)).toBe(AGENT)
  await relabel('#vault_old', '#vault')
  await expect.poll(() => sparkle(page), { timeout: POLL_MS }).toEqual(shown(`${AGENT} is watching`))
  // the account as this row leaves it is where the rows after it start: no save is in flight when
  // the row ends (the app's own test, hasLocalIntent). Unsent, the relabel's write left #vault_old
  // for the next row's page: `text == savedText` held at once, the relabel back being equal to
  // the text saved before the first relabel's save came back
  await page.waitForFunction(() => (window as any).__items.every((item: any) => !item.saveTask && !item.saving && !item.unackedWrites?.length), null, { timeout: POLL_MS })
  expect(dialogs, 'no alert of the sparkle or the installs').toEqual([])
})

// the watched mark: the mark of an item whose edit or deletion would wake an agent. The bridge,
// played as above, publishes what the item watcher follows as rules (`_bridge.watcher.follows`);
// the item matches them against the page's items. phases: (a) a published tag rule marks the
// items that carry the tag, as a tag or as their label, and no other: not the hidden form's
// carrier, and not an item that only has it as the app resolves a RELATIVE tag (the app's real
// `tags_raw` holds it; the watcher reads the tag as written, so the page leaves it unmarked and
// the menu's line says `marked`); the mark is the approved look in the real page, a 15px sparkle
// before the item's number; (b) a tag saved in the editor shows there, and while that item is
// edited the 23px sparkle is left of the edit menu's buttons; (c) a stale bridge clears the
// marks, and its return brings them back; (d) a watch of all items marks every item, by a
// stylesheet that names none: an item a rule named is drawn exactly as it was, by its number
// and in its edit menu, an item no rule ever named has the same sparkle, the menu's lines and
// the sparkle's tooltip say it, and a stale bridge clears these marks too; (e) a list of
// follows as dense as the bridge publishes is taller than a phone's window: the menu stays
// inside the window and scrolls, its entries where a pointer and the keyboard reach them; (f) a
// look that takes long, the app's listing of the items held up for it, is said in one more line
// of the menu and warned of in the console, once, and a look that is quick again removes the line;
// (g) beside the app's running mark (the ring left of a running item's number, 2026-11-18,
// tests/e2e/layout.spec.ts): on an item that is watched and runs both show, the sparkle nearest
// the number and the ring left of it, by the number and in the edit menu, and neither reaches the
// digits, the item's text or its run button; the room is the sum of what each says; an older
// item's stylesheet, which says none and sets the margin itself, adds up the same; the still
// circles of an item that can be pushed or previewed (2026-11-19) stand between the two, by the
// number and in the edit menu, at their height, and a click on one opens the item; and an item
// that is being saved is dimmed as it always was, running or not
test('the watched mark is on the items an agent follows, and the menu says what is followed', async ({ page }) => {
  const dialogs: string[] = []
  page.on('dialog', dialog => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`)
    void (dialog.type() == 'beforeunload' ? dialog.accept() : dialog.dismiss())
  })
  expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
  // a returning device: the account's secret is there, so no phrase is asked for (as tests/e2e/lifecycle.spec.ts)
  await page.addInitScript(secret => {
    localStorage.setItem('mindpage_github_token', 'e2e-local')
    localStorage.setItem('mindpage_secret', secret)
    localStorage.setItem('mindpage_kdf', 'off')
  }, SECRET)
  await loadUser(page, USER)
  await waitForApp(page)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: POLL_MS }).toBe(true)
  await expect.poll(async () => (await sparkle(page)).nodes, { timeout: POLL_MS }).toBe(1)

  const TAG = '#e2e_watched'
  const KID = '#e2e_mark_r/kid'
  const made = [`${TAG} is this item's own label`, `#e2e_mark_a an item that carries ${TAG}`, '#e2e_mark_h carries the hidden form #_e2e_watched', '#e2e_mark_r has a relative tag #/kid', '#e2e_mark_p a plain item']
  for (const text of made) {
    await page.evaluate(text => void window._create(text), text)
    await expect.poll(() => savedId(page, text.split(' ')[0]), { timeout: POLL_MS }).toBeTruthy()
  }
  // the items the marks' stylesheet names, by label, and the menu's lines
  const marks = () =>
    page.evaluate(() => {
      const sheet = document.querySelector('[data-vault-sparkle="watched"]')?.textContent ?? ''
      return [...new Set([...sheet.matchAll(/data-item-id="([^"]+)"/g)].map(m => m[1]))].map(id => ((window._item(id, true) as any)?.label as string | undefined) ?? id).sort()
    })
  const sheet = () => page.evaluate(() => document.querySelector('[data-vault-sparkle="watched"]')?.textContent ?? '')
  const EVERY = /^\.container\[data-item-id\] / // the one form that names no item: every item's box
  const lines = async () => {
    await page.locator(NODE).click()
    const said = await page.locator('[data-vault-sparkle="menu"] > div').allTextContents()
    await page.keyboard.press('Escape')
    return said
  }
  const follows = (rules: Record<string, any>[]) => watched(page, { name: AGENT, took: TOOK, state: 'watching', follows: rules })
  const RULE = { watch: 'todos', name: AGENT, since: new Date().toISOString() }

  // (a) the tag rule: its carriers and no other. The app reads the resolved relative tag on its
  // item, and so does the watcher (the reading corpus, below): the page marks by it
  expect(await page.evaluate(() => (window._item('#e2e_mark_r', true) as any).tags_raw)).toEqual(['#e2e_mark_r', KID])
  expect(await page.evaluate(() => (window._item('#e2e_mark_h', true) as any).tags_raw)).toEqual(['#e2e_mark_h', '#_e2e_watched'])
  await fresh(page)
  await follows([{ ...RULE, tags: [TAG, KID] }])
  await expect.poll(marks, { timeout: POLL_MS }).toEqual(['#e2e_mark_a', '#e2e_mark_r', TAG])
  expect(await lines()).toEqual([`watched: ${TAG}, ${KID} (3 items)`])
  // the sparkle's tooltip says it too, on a second line below who watches (the owner, 2026-11-18)
  expect((await sparkle(page)).title).toBe(`${AGENT} is watching\nwatched: ${TAG}, ${KID} (3 items)`)
  // the look, in the page: the plain item is shown alone and unmarked; the tag's own item is marked
  const look = (label: string, part: string) =>
    page.evaluate(([label, part]) => {
      const box = document.querySelector(`.container[data-item-id="${window._item(label, true)!.id}"] ${part}`)
      const style = box ? getComputedStyle(box, '::before') : null
      return style ? [style.content.slice(0, 26), style.width, style.backgroundImage.slice(0, 26)] : null
    }, [label, part])
  // every computed property of that mark, as one string: what the two forms of the stylesheet must draw alike
  const drawn = (label: string, part: string) =>
    page.evaluate(([label, part]) => {
      const box = document.querySelector(`.container[data-item-id="${window._item(label, true)!.id}"] ${part}`)
      const style = box ? getComputedStyle(box, '::before') : null
      return style ? [...style].map(name => `${name}: ${style.getPropertyValue(name)}`).join('; ') : null
    }, [label, part])
  const shows = async (label: string) => {
    await page.evaluate(label => (window as any).MindBox.set(label), label)
    await expect.poll(() => page.evaluate(label => (window as any)._mindboxDebounced === false && !!window._item(label, true)?.elem, label), { timeout: POLL_MS }).toBe(true)
  }
  const NUMBER = '.item-menu > .button.index'
  const SPARKLE = 'url("data:image/svg+xml,%3'
  // the mark's room by the number, in the real page: the sparkle takes none of the number's box,
  // which is as wide as its digits (its margins sum to minus its width, so the menu is as wide as
  // an unmarked item's: the app sizes the text's placeholder from a menu measured once for all
  // items of a digit count), and the placeholder, the float the app puts first in the item's
  // text, keeps the 18px left of the digits free with a margin that an unmarked item lacks
  const room = (label: string) =>
    page.evaluate(label => {
      const box = document.querySelector(`.container[data-item-id="${window._item(label, true)!.id}"]`)!
      const [menu, index, spacer] = ['.item-menu', '.item-menu > .button.index', '.item > [id^="menu-"]'].map(part => box.querySelector(part) as HTMLElement)
      const mark = getComputedStyle(index, '::before')
      return {
        digits: index.textContent!.trim().length,
        menu: menu.clientWidth,
        said: getComputedStyle(box).getPropertyValue('--item-mark-room').trim(), // the room as the item says it to the app
        placeholder: [spacer === spacer.parentElement!.firstElementChild, getComputedStyle(spacer).marginLeft],
        mark: mark.content == 'none' ? null : [mark.marginLeft, mark.marginRight],
      }
    }, label)
  await shows(TAG)
  expect(await look(TAG, NUMBER)).toEqual([SPARKLE, '15px', 'none'])
  const marked = await room(TAG)
  expect([marked.digits, marked.menu > 0, marked.said, marked.placeholder, marked.mark], 'the sparkle takes no room of the box, its 18px are said to the app, and the text keeps out of them').toEqual([1, true, '18px', [true, '18px'], ['-18px', '3px']])
  await shows('#e2e_mark_p')
  expect((await look('#e2e_mark_p', NUMBER))![0]).toBe('none')
  expect(await room('#e2e_mark_p'), 'an item nobody follows: a menu as wide, a placeholder with no margin').toEqual({ digits: 1, menu: marked.menu, said: '', placeholder: [true, '0px'], mark: null })

  // (b) the tag saved in the editor: the mark shows on the item, and in its edit menu while it is edited
  const id = await page.evaluate(() => window._item('#e2e_mark_p', true)!.id)
  const edit = async (id: string) => {
    const paragraph = page.locator(`#item-${id} p`).first()
    const box = (await paragraph.boundingBox())!
    await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
    await expect(page.locator(`#textarea-${id}`)).toBeVisible()
  }
  const close = async (id: string) => {
    await page.keyboard.press('Escape')
    await expect(page.locator(`#textarea-${id}`)).toBeHidden()
  }
  await edit(id)
  expect((await look('#e2e_mark_p', '.edit-menu'))![2], 'an item nobody follows has no sparkle in its edit menu').toBe('none')
  await page.locator(`#textarea-${id}`).fill(`#e2e_mark_p now carries ${TAG}`)
  await page.keyboard.press('Shift+Enter') // save
  await expect(page.locator(`#textarea-${id}`)).toBeHidden()
  await expect.poll(marks, { timeout: POLL_MS }).toEqual(['#e2e_mark_a', '#e2e_mark_p', '#e2e_mark_r', TAG])
  expect(await look('#e2e_mark_p', NUMBER)).toEqual([SPARKLE, '15px', 'none'])
  expect(await lines()).toEqual([`watched: ${TAG}, ${KID} (4 items)`])
  const by_number = await drawn('#e2e_mark_p', NUMBER)
  await edit(id)
  expect(await look('#e2e_mark_p', '.edit-menu')).toEqual(['""', '23px', SPARKLE])
  const in_editor = await drawn('#e2e_mark_p', '.edit-menu')
  await close(id)

  // (c) a stale bridge: the marks go with the sparkle, and come back with it
  await fresh(page, 4 * 60_000)
  await expect.poll(marks, { timeout: POLL_MS }).toEqual([])
  expect((await sparkle(page)).shown).toBe(false)
  await fresh(page)
  await expect.poll(marks, { timeout: POLL_MS }).toEqual(['#e2e_mark_a', '#e2e_mark_p', '#e2e_mark_r', TAG])

  // (d) a watch of all items: every item is marked, by a stylesheet that names none. The item a
  // rule named is drawn exactly as it was under that rule; the hidden form's carrier, which no
  // rule ever named, has the same sparkle by its number and in its edit menu; the menu and the
  // sparkle say it; and a stale bridge clears these marks as it clears any
  await follows([{ ...RULE, tags: [TAG] }, { ...RULE, watch: 'sweep', all: true }])
  await expect.poll(sheet, { timeout: POLL_MS }).toMatch(EVERY)
  expect(await marks(), 'the stylesheet names no item').toEqual([])
  await expect.poll(async () => (await sparkle(page)).title, { timeout: POLL_MS }).toBe(`${AGENT} is watching\nwatched: ${TAG} · all items`)
  expect(await lines()).toEqual([`watched: ${TAG}`, 'watched: all items'])
  expect(await drawn('#e2e_mark_p', NUMBER), 'by the number, every computed property as under the rule that named the item').toBe(by_number)
  await edit(id)
  expect(await drawn('#e2e_mark_p', '.edit-menu'), 'and in the edit menu').toBe(in_editor)
  await close(id)
  await shows('#e2e_mark_h')
  expect(await look('#e2e_mark_h', NUMBER)).toEqual([SPARKLE, '15px', 'none'])
  const unnamed = await page.evaluate(() => window._item('#e2e_mark_h', true)!.id)
  await edit(unnamed)
  expect(await look('#e2e_mark_h', '.edit-menu')).toEqual(['""', '23px', SPARKLE])
  await close(unnamed)
  await fresh(page, 4 * 60_000)
  await expect.poll(sheet, { timeout: POLL_MS }).toBe('')
  expect((await look('#e2e_mark_h', NUMBER))![0]).toBe('none')
  await fresh(page)
  await expect.poll(sheet, { timeout: POLL_MS }).toMatch(EVERY)

  // (e) the menu is never taller than the window (review 54, B2). Eight follows of eight long
  // tags are within the bridge's bounds (its own `rule` and `_bounded` publish them unchanged, 3,872
  // of its 4,096 bytes), and their lines, wrapped in a phone's width, are taller than its window.
  // The menu is opened from the keyboard, which then moves to its second entry. (No fullscreen
  // was asked for in this page, so the viewport is Playwright's to set.)
  const dense = Array.from({ length: 8 }, (_, n) => ({ ...RULE, watch: `area-${n}`, tags: Array.from({ length: 8 }, (_, m) => `#project-operations-area-weekly-planning-${n}-${m}`) }))
  await watched(page, { name: AGENT, took: TOOK, state: 'watching', tab: true, follows: dense })
  await expect.poll(() => page.evaluate(() => (window as any)._vault_sparkle.found?.rules.length ?? 0), { timeout: POLL_MS }).toBe(8)
  await page.setViewportSize({ width: 375, height: 667 })
  await page.locator(NODE).focus()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sparkle(page)).menus).toBe(1)
  await page.keyboard.press('ArrowDown')
  expect(
    await page.evaluate(() => {
      const menu = document.querySelector('[data-vault-sparkle="menu"]') as HTMLElement
      const inside = (box: DOMRect) => box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth
      // an entry's own rectangle is inside the window, and a pointer at its middle lands on it
      const entries = [...menu.querySelectorAll('button')].map(button => {
        const box = button.getBoundingClientRect()
        return [button.textContent, inside(box), document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === button]
      })
      const found = { window: [window.innerWidth, window.innerHeight], lines: menu.querySelectorAll(':scope > div').length, taller: menu.scrollHeight > window.innerHeight, menu: inside(menu.getBoundingClientRect()), entries, focused: document.activeElement?.textContent }
      menu.scrollTop = menu.scrollHeight // the excess scrolls: the last line comes into the window
      return { ...found, last: inside(menu.lastElementChild!.getBoundingClientRect()) }
    }),
    'the lines are taller than the window, and the menu, its entries and the focus the keyboard moved are inside it; the last line is reached by scrolling',
  ).toEqual({ window: [375, 667], lines: 8, taller: true, menu: true, entries: [['Stop Watching', true, true], ['Close Agent Session', true, true]], focused: 'Close Agent Session', last: true })
  await page.keyboard.press('Escape')

  // (f) the look times itself, by the page's own clock. The app's listing of the items, which a
  // tag rule's look makes, is held up for longer than the item's bound (a real wait, no fake
  // clock): the menu says how long the marking took, below the rule's line, and the console is
  // warned once. With the listing as it was, the next look is quick and the line is gone
  const warnings: string[] = []
  page.on('console', message => {
    if (message.type() == 'warning' && message.text().includes('marking the watched items')) warnings.push(message.text())
  })
  await page.evaluate(() => {
    const app = window as any
    const listing = (app.__e2e_listing = app._items)
    app._items = (...args: unknown[]) => {
      const until = performance.now() + 80
      while (performance.now() < until);
      return listing(...args)
    }
  })
  // (the menu is read only once the look for the rule has been made: a look closes an open menu)
  const looked = (tags: number) =>
    expect
      .poll(() => page.evaluate(tags => ((held: any) => held.follows.length == 1 && held.follows[0].tags.length == tags && held.found !== null)((window as any)._vault_sparkle), tags), { timeout: POLL_MS })
      .toBe(true)
  await follows([{ ...RULE, tags: [TAG] }])
  await looked(1)
  const [counted, took] = await lines()
  expect([counted, /^marking took (\d+) ms$/.test(took) && Number(took.match(/\d+/)![0]) >= 80], took).toEqual([`watched: ${TAG} (3 items)`, true])
  expect(warnings.length, warnings.join(' | ')).toBe(1)
  expect(warnings[0]).toMatch(/^vault: marking the watched items took \d+ ms \(3 items marked, 1 rule\)$/)
  await page.evaluate(() => {
    const app = window as any
    app._items = app.__e2e_listing
  })
  await follows([{ ...RULE, tags: [TAG, KID] }])
  await looked(2)
  expect(await lines()).toEqual([`watched: ${TAG}, ${KID} (4 items)`])
  expect(warnings.length, 'no second warning').toBe(1)

  // (g) the two marks together. A runnable item that carries the tag, in a narrow window, where
  // its first line runs up to its menu
  await page.setViewportSize({ width: 600, height: 800 })
  const RUN = '#e2e_mark_run'
  const RUN_TEXT = `${RUN} carries ${TAG} and can run: its first line is long enough to reach the room that the two marks keep free beside its number.\n` + '```js_input\n1\n```'
  await page.evaluate(text => void window._create(text), RUN_TEXT)
  await expect.poll(() => savedId(page, RUN), { timeout: POLL_MS }).toBeTruthy()
  await expect.poll(marks, { timeout: POLL_MS }).toContain(RUN)
  await shows(RUN)
  const runId = await page.evaluate(label => window._item(label, true)!.id, RUN)
  const BLUE = 'rgb(68, 170, 255)' // #4af, the ring's
  const runs = (running: boolean) => page.evaluate(([id, running]) => void ((window._item(id, true) as any).running = running), [runId, running] as const)
  const boxed = (running: boolean) => expect.poll(() => page.evaluate(([id, running]) => !!document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]${running ? '.running' : ':not(.running)'} .item-menu`), [runId, running] as const), { timeout: 15_000 }).toBe(true)
  // the boxes left of the number's own, by a hit test along its middle line (a pseudo-element
  // answers as its element), each as [from, to] in px left of the digits, the nearest first, read off whole pixels
  // (an edge can read up to a pixel wide of the box's own: `marksAre`); how far left of the
  // digits the nearest line of the text beside them ends, and the run button's two edges; the
  // placeholder's margin and padding, and the room the item says. `without` hides one of the
  // number's two marks for the measure (which mark is which: the ring is the number's child
  // `.running-mark`, the sparkle its `::before`), and `older` gives the
  // page, for the measure, the stylesheet as the item wrote it before 2026-11-18: no room said,
  // the margin and the run button's offset set by its own rules (the same sheet otherwise)
  // The measure is of the item in the SHOWN column (an element can be mounted in the offscreen
  // render column alone, where nothing is hit), found again after the frames it waits (a resize
  // can schedule a later scroll to the target, and a layout can replace the element); null when
  // it is not there. `beside` polls the WHOLE assertion on a measure and returns the measure
  // that passed, so nothing is asserted on a second, unguarded one
  type Options = { without?: string; older?: boolean }
  const measured = (options: Options = {}) =>
    page.evaluate(async ([id, without, older]) => {
      const shown = () => document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`) as HTMLElement | null
      const sheet = document.querySelector('[data-vault-sparkle="watched"]')!
      const written = sheet.textContent!
      if (older) sheet.textContent = written.split('\n').filter(rule => !rule.includes('{ --item-mark-room')).join('\n').replaceAll('var(--item-mark-room)', '18px')
      // (the ring is measured standing still: a hit test reads a turning box up to 2 px wide of it)
      // (the state circles are one box in the menu, `.state-marks`, each circle an element in it: tests/e2e/layout.spec.ts)
      const hide = document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '.running-mark::before { animation: none !important }' + (without ? ` .item-menu > .index${without} { display: none !important }` : '') }))
      shown()?.scrollIntoView({ block: 'center' })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const box = shown()
      const [index, spacer, run] = ['.item-menu > .index', '.item > [id^="menu-"]', '.item-menu > .run'].map(part => box?.querySelector(part) as HTMLElement | null)
      if (!box || !index?.firstChild || !spacer || !run) {
        hide.remove()
        if (older) sheet.textContent = written
        return null
      }
      const digits = document.createRange()
      digits.selectNodeContents(index.firstChild!)
      const [number, own, button] = [digits.getBoundingClientRect(), index.getBoundingClientRect(), run.getBoundingClientRect()]
      const y = (own.top + own.bottom) / 2
      const found: number[][] = [] // pixel by pixel leftwards from the number's own box: [left edge of the first pixel hit, right edge of the last]
      const circles: number[][] = [] // the same for the one box of the state circles: one mark at most
      for (let k = 1, pixel = Math.floor(own.left) - 1; k <= 80; k++, pixel--) {
        const hit = document.elementFromPoint(pixel + 0.5, y)
        if (hit?.closest('.item-menu > .state-marks')) circles[0] = [number.left - pixel, circles[0]?.[1] ?? number.left - pixel - 1]
        if (!index.contains(hit)) continue
        const last = found[found.length - 1]
        if (last && last[0] == number.left - pixel - 1) last[0] = number.left - pixel
        else found.push([number.left - pixel, number.left - pixel - 1])
      }
      let text = Infinity
      const walker = document.createTreeWalker(box.querySelector('.item')!, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent!.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const line of range.getClientRects()) if (line.width && line.bottom > own.top + 2 && line.top < own.bottom - 2) text = Math.min(text, number.left - line.right)
      }
      const placed = getComputedStyle(spacer)
      const result = {
        marks: found,
        circles,
        run: [Math.round(number.left - button.right), Math.round(number.left - button.left)],
        text,
        room: [placed.marginLeft, placed.paddingLeft],
        said: getComputedStyle(box).getPropertyValue('--item-mark-room').trim(),
        at: [Math.round(own.left), Math.round(y), innerWidth, innerHeight], // where the measure was made, for a failure's message
      }
      hide.remove()
      if (older) sheet.textContent = written
      return result
    }, [runId, options.without ?? '', !!options.older] as const)
  type Beside = NonNullable<Awaited<ReturnType<typeof measured>>>
  const beside = async (message: string, facts: (measure: Beside) => unknown[], expected: unknown[], options: Options = {}) => {
    let passed: Beside | null = null
    await expect.poll(async () => ((passed = await measured(options)), passed && facts(passed)), { message, timeout: 15_000 }).toEqual(expected)
    return passed!
  }
  // watched, not running: the sparkle alone, in its 18 px (the last of them inside the number's
  // own box, which begins 4 px before the digits), a run button left of them, the text left of it
  const marksAre = (marks: number[][], boxes: number[][]) => marks.length == boxes.length && marks.every((mark, at) => mark.every((edge, side) => Math.abs(edge - boxes[at][side]) <= 1))
  const alone = await beside('watched: the sparkle in its 18px, which the item says and the app keeps free', m => [marksAre(m.marks, [[18, 4]]), m.run[0], m.room, m.said], [true, 4 + 18, ['18px', '0px'], '18px'])
  expect([alone.text >= alone.run[1] + 1, alone.text < alone.run[1] + 40], `the text runs up to the run button (${alone.text}, ${alone.run})`).toEqual([true, true])
  // and running: the ring left of the sparkle, 3 px between them, the run button and the text
  // left of both; the room is the sum of the two, each by a property of its own
  await runs(true)
  await boxed(true)
  const both = await beside(
    'watched and running: the sparkle where it was and a second mark left of it, and the run button 18px further left',
    m => [marksAre(m.marks, [[18, 4], [36, 21]]), m.run, m.room, m.said],
    [true, alone.run.map(edge => edge + 18), ['18px', '18px'], '18px'],
  )
  expect(both.text, 'the text keeps out of where the run button now stands').toBeGreaterThanOrEqual(both.run[1] + 1)
  await beside('without the ring, the mark nearest the number remains: the sparkle', m => [marksAre(m.marks, [[18, 4]])], [true], { without: ' > .running-mark' })
  expect(await look(RUN, NUMBER), 'the sparkle is drawn as on any watched item').toEqual([SPARKLE, '15px', 'none'])
  expect(
    await page.evaluate(([id, part]) => (mark => (ring => [ring.content, ring.width, ring.borderTopStyle, ring.borderTopWidth, ring.borderTopColor, getComputedStyle(mark).order, mark.title])(getComputedStyle(mark, '::before')))(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] ${part} > .running-mark`) as HTMLElement), [runId, NUMBER]),
    'the ring is the app\'s: a solid stroke of 2px, on an element of its own before the sparkle, whose tooltip says that the item runs',
  ).toEqual(['""', '15px', 'solid', '2px', BLUE, '-1', 'running'])
  // THE TWO MARKS AT THE SAME HEIGHT, by pixels (the owner, 2026-11-19: the circle "seems off, a
  // bit too high; can you match it to the sparkle's alignment?"). The ring stands as the sparkle
  // does, an inline box on the number's baseline lowered 2px, so the two are rounded to the pixel
  // grid together: the rows the ring inks (blue) and the rows the sparkle inks (yellow) have the
  // same middle, where the item sits and with the item half a pixel lower. Read off a screenshot
  // of the 40px left of the digits (or as many as asked: the state circles' step, below, which
  // reads their orange and pink too), with the ring standing still
  const inked = async (left = 40) => {
    const still = await page.addStyleTag({ content: '.running-mark::before { animation: none !important }' })
    const clip = await page.evaluate(async ([id, left]) => {
      const index = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .item-menu > .index`) as HTMLElement
      index.scrollIntoView({ block: 'center' })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const digits = document.createRange()
      digits.selectNodeContents(index.firstChild!)
      const own = index.getBoundingClientRect()
      return { x: Math.floor(digits.getBoundingClientRect().left) - left, y: Math.floor(own.top) - 2, width: left, height: Math.ceil(own.height) + 4 }
    }, [runId, left] as const)
    const png = (await page.screenshot({ clip })).toString('base64')
    await still.evaluate(style => (style as Element).remove())
    return page.evaluate(async png => {
      const image = new Image()
      image.src = 'data:image/png;base64,' + png
      await image.decode()
      const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height })
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const { data, width, height } = context.getImageData(0, 0, image.width, image.height)
      const rows: Record<string, number[]> = { ring: [], sparkle: [], pushable: [], previewable: [] }
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const [r, g, b] = [0, 1, 2].map(channel => data[4 * (y * width + x) + channel])
          if (b - r > 25) rows.ring.push(y)
          else if (r - b > 50 && g < 0.7 * r) rows.pushable.push(y) // the orange #a52 (the sparkle's yellow keeps its green)
          else if (r - g > 40 && b - g > 40) rows.previewable.push(y) // the pink #c7c
          else if (r - b > 50) rows.sparkle.push(y)
        }
      return Object.fromEntries(Object.entries(rows).map(([mark, inked]) => [mark, [Math.min(...inked), Math.max(...inked) + 1]]))
    }, png)
  }
  for (const lower of [false, true]) {
    const nudge = lower ? await page.addStyleTag({ content: `.container[data-item-id="${runId}"] { top: 0.5px }` }) : null
    const ink = await inked()
    expect([ink.ring[1] - ink.ring[0], ink.ring[0] + ink.ring[1] - ink.sparkle[0] - ink.sparkle[1]], `the ring inks 15 rows, with the sparkle's middle${lower ? ', the item half a pixel lower' : ''} (${JSON.stringify(ink)})`).toEqual([15, 0])
    await nudge?.evaluate(style => (style as Element).remove())
  }
  // THE #vault ITEM'S OWN STATUS AND PROGRESS reach the ring (vault_show_status: a listed run's
  // status, escaped by the item, and the supervisor's progress for it): the bridge lists a run on
  // this item, with a status the supervisor posted, and the ring's tooltip is that text as
  // written, the ring filled to the progress and still, the item running on two references, the
  // row's and the #vault item's. DELISTED, the #vault item releases its reference and DEFERS its
  // clearing, since the item still runs on the row's: the status and the progress stay on the
  // ring (and the ring keeps the fill: a running reference is still held). The last step is the
  // row's own clear_status(), and proves an explicit clearing, not the item's
  const tip = () => page.evaluate(([id, part]) => (mark => (mark ? [mark.title, mark.classList.contains('filled'), getComputedStyle(mark, '::before').animationName == 'none', mark.style.getPropertyValue('--running-mark-fill')] : null))(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] ${part} > .running-mark`) as HTMLElement | null), [runId, NUMBER])
  const references = () => page.evaluate(id => (window.__items.find(item => item.id == id) as unknown as { running: number }).running, runId) // the item's running references
  const runSaved = await savedId(page, RUN)
  const POSTED = ["Searching the web for 'a <b> & c'", true, true, '50.000%']
  await publish(page, '#vault', store => {
    store._bridge.runs = { r1: { item: runSaved, status: 'Reading file docs/x.md', started: 1 } }
    store._supervisor = { runs: { r1: { status: "Searching the web for 'a <b> & c'", progress: 0.5 } } }
  })
  await expect.poll(async () => [await tip(), await references()], { message: 'the listed run\'s status is the ring\'s tooltip, its progress the ring\'s fill, on a second running reference', timeout: POLL_MS }).toEqual([POSTED, 2])
  await publish(page, '#vault', store => {
    store._bridge.runs = {}
    delete store._supervisor
  })
  await expect.poll(references, { message: 'delisted: the #vault item has released its reference', timeout: POLL_MS }).toBe(1)
  expect(await tip(), 'and has deferred its clearing while the item runs on the row\'s reference: the status and the fill are still on the ring').toEqual(POSTED)
  await page.evaluate(id => (window._item(id, true) as unknown as { clear_status: () => void }).clear_status(), runId)
  await expect.poll(tip, { message: 'cleared by the row: the ring turns, and says that the item runs', timeout: POLL_MS }).toEqual(['running', false, false, ''])
  // an older #vault item's stylesheet on this app: no room said, and the same picture
  const older = await beside('the older stylesheet says no room, and the marks, the run button and the room are the same', m => [marksAre(m.marks, [[18, 4], [36, 21]]), m.run, m.room, m.said], [true, both.run, both.room, ''], { older: true })
  expect(older.text).toBeGreaterThanOrEqual(older.run[1] + 1)
  // THE STATE CIRCLES (2026-11-19: an item that can be pushed, or previewed, shows a still ring
  // where its border was coloured; tests/e2e/layout.spec.ts has them alone). Beside the sparkle
  // itself: the sparkle nearest the digits, the circle left of it by the room the item says, the
  // ring left of the circle; the rooms add up, the item's in the margin and the app's in the
  // padding. `pushable` is set as item code sets it, `previewable` on the page's own record (the
  // app alone sets it), shown by the re-ranking that a change of the first causes. (The circles'
  // box, an image of 18px per circle with 3px of air on its left, reads 3px wider than its circle)
  const states = (pushable: boolean, previewable = false) =>
    page.evaluate(([id, pushable, previewable]) => {
      const item = window._item(id, true) as unknown as { pushable: boolean }
      ;(window.__items.find(item => item.id == id) as unknown as { previewable: boolean }).previewable = previewable
      item.pushable = !pushable
      item.pushable = pushable
    }, [runId, pushable, previewable] as const)
  await states(true)
  const three = await beside(
    'watched, running and pushable: the sparkle, the circle left of it, the ring left of the circle, and the run button left of all three',
    m => [marksAre(m.marks, [[18, 4], [54, 39]]), marksAre(m.circles, [[39, 21]]), m.run, m.room],
    [true, true, alone.run.map(edge => edge + 36), ['18px', '36px']],
  )
  expect(three.text, 'the text keeps out of all three').toBeGreaterThanOrEqual(three.run[1] + 1)
  // ALL FOUR AT ONE HEIGHT, by pixels as the two marks above: pushable and previewable too, the
  // ring, the two circles and the sparkle have one middle, the ring and each circle inking 15
  // rows, where the item sits and with the item half a pixel lower (a strip of 74px: from the
  // left the ring, the previewable circle, the pushable one and the sparkle, 18px each)
  await states(true, true)
  await beside('watched, running, pushable and previewable: the two circles between the sparkle and the ring', m => [marksAre(m.marks, [[18, 4], [72, 57]]), marksAre(m.circles, [[57, 21]])], [true, true])
  for (const lower of [false, true]) {
    const nudge = lower ? await page.addStyleTag({ content: `.container[data-item-id="${runId}"] { top: 0.5px }` }) : null
    const ink = await inked(74)
    const middle = (mark: string) => ink[mark][0] + ink[mark][1] - ink.sparkle[0] - ink.sparkle[1]
    expect([...['ring', 'previewable', 'pushable'].map(mark => ink[mark][1] - ink[mark][0]), ...['ring', 'previewable', 'pushable'].map(middle)], `the ring and the two circles ink 15 rows each, with the sparkle's middle${lower ? ', the item half a pixel lower' : ''} (${JSON.stringify(ink)})`).toEqual([15, 15, 15, 0, 0, 0])
    await nudge?.evaluate(style => (style as Element).remove())
  }
  await states(true)
  await runs(false)
  await boxed(false)
  const circled = await beside('watched and pushable: the sparkle where it was, the circle left of it', m => [marksAre(m.marks, [[18, 4]]), marksAre(m.circles, [[39, 21]]), m.run, m.room], [true, true, alone.run.map(edge => edge + 18), ['18px', '18px']])
  // a click on the circle is the circle's own, beside the sparkle too (with a mouse: the layout
  // spec's row): the call of the edit menu's push button, which in an account without the #pusher
  // item (this one) ends in the app's dialog that names the item, and no editor opens. (Until
  // 2026-11-19 it was a click on the item, as one on the border was, and opened the editor)
  const pushed = await page.evaluate(id => window._item(id)!.name, runId)
  await page.mouse.click(circled.at[0] + 4 - 36 + 7.5, circled.at[1])
  await expect
    .poll(() => page.evaluate(() => ((window as any)._modal_visible() ? (document.querySelector('.background.visible .modal')?.textContent ?? '').trim() : null)), { message: 'a click on the circle is the push button\'s call', timeout: 10_000 })
    .toBe(`can not push ${pushed}, #pusher must be installed first`)
  await expect(page.locator(`#textarea-${runId}`), 'and opens no editor').toHaveCount(0)
  await page.locator('.background.visible').click({ position: { x: 4, y: 4 } })
  await expect.poll(() => page.evaluate(() => (window as any)._modal_visible())).toBe(false)
  // (the circle has the room the item SAYS and nothing else: beside an older stylesheet's sparkle,
  // which says none, it stands in the sparkle's place, read with the sparkle hidden; the room
  // kept free is the same)
  await beside('an older stylesheet: the circle in the sparkle\'s place, the room the same', m => [marksAre(m.circles, [[21, 4]]), m.run, m.room], [true, alone.run.map(edge => edge + 18), ['18px', '18px']], { older: true, without: '::before' })
  await states(false)
  await beside('no longer pushable: the sparkle alone, as before', m => [marksAre(m.marks, [[18, 4]]), m.circles, m.run, m.room], [true, [], alone.run, alone.room])
  await runs(true)
  await boxed(true)
  // in the editor: the ring, then the sparkle, then the buttons, each 23px and 6px before the next,
  // in ONE row that ends at the item's right edge, out of flow, where the edit menu always stood
  // (a menu that wrapped into further rows was built, and the owner declined it, 2026-11-18: "just
  // let it extend all the way to the left or even get clipped on left side if needed"). What is
  // read: the room of the marks before the first button; the two marks' styles; the buttons and
  // the rows they stand in; where the row ends against the item's right edge, and whether it
  // begins left of the item's left edge; by how much it lies over the editor's top (5px); and the
  // height the layout holds for the item against the box's own
  const menu = () =>
    page.evaluate(id => {
      const box = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`) as HTMLElement
      const menu = box.querySelector('.edit-menu') as HTMLElement
      const running = menu.querySelector(':scope > .running-mark') as HTMLElement | null // the ring's element: the menu's last child, shown first
      const [ring, mark] = [running && getComputedStyle(running), getComputedStyle(menu, '::before')]
      const [own, item, editor] = [menu, box, box.querySelector('.editor')!].map(part => part.getBoundingClientRect())
      const buttons = [...menu.querySelectorAll('.button')].map(button => button.getBoundingClientRect())
      const stored = (window.__items.find(item => item.id == id) as unknown as { height: number }).height
      return {
        before: Math.round(buttons[0].left - own.left), // the marks' room: the menu is as wide as its row
        ring: ring ? [ring.order, ring.width, ring.marginRight, getComputedStyle(running!, '::before').borderTopColor] : null,
        mark: mark.content == 'none' ? null : [mark.order, mark.width, mark.marginRight, mark.backgroundImage.slice(0, 26)],
        states: (circles => (circles.content == 'none' ? null : [circles.order, circles.width, circles.height, circles.marginRight]))(getComputedStyle(menu, '::after')),
        buttons: buttons.length,
        rows: new Set(buttons.map(button => Math.round(button.top))).size,
        right: Math.round(own.right - item.right),
        past: own.left < item.left,
        over: Math.round(Math.max(...buttons.map(button => button.bottom)) - editor.top),
        heights: [stored, box.offsetHeight],
        agree: stored == box.offsetHeight,
      }
    }, runId)
  await edit(runId)
  expect(await menu(), 'edited while running and watched').toMatchObject({ before: 2 * (23 + 6), ring: ['-1', '23px', '6px', BLUE], mark: ['0', '23px', '6px', SPARKLE], rows: 1, right: 0, past: false, over: 5 })
  // the editor's ring has the same tooltip and the same fill, and the menu's last button keeps
  // its right corners (the ring's element is the menu's last child, and takes :last-child from it)
  const edited = () =>
    page.evaluate(id => {
      const menu = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .edit-menu`) as HTMLElement
      const [mark, last] = [menu.querySelector(':scope > .running-mark') as HTMLElement, [...menu.querySelectorAll(':scope > .button')].pop()!]
      const ring = getComputedStyle(mark, '::before')
      return { tip: mark.title, ring: [ring.width, ring.height, ring.borderTopWidth, ring.animationName == 'none', ring.backgroundImage.match(/^conic-gradient\(rgb\(68, 170, 255\) ([\d.]+)%/)?.[1] ?? null], corners: [getComputedStyle(last).borderTopRightRadius, getComputedStyle(last).borderBottomRightRadius] }
    }, runId)
  expect(await edited(), 'the editor\'s ring: 23px with a stroke of 3, turning, its tooltip that the item runs').toEqual({ tip: 'running', ring: ['23px', '23px', '3px', false, null], corners: ['5px', '5px'] })
  await page.evaluate(id => {
    const item = window._item(id, true) as unknown as { status: string; progress: number }
    item.status = 'waiting for the lanes …'
    item.progress = 0.75
  }, runId)
  await expect.poll(edited, { message: 'a status and a progress, in the editor: the tooltip and the fill', timeout: 15_000 }).toEqual({ tip: 'waiting for the lanes …', ring: ['23px', '23px', '3px', true, '75'], corners: ['5px', '5px'] })
  await page.evaluate(id => (window._item(id, true) as unknown as { clear_status: () => void }).clear_status(), runId)
  await expect.poll(edited, { timeout: 15_000 }).toMatchObject({ tip: 'running', ring: ['23px', '23px', '3px', false, null] })
  // THE STATE CIRCLES IN THE EDITOR, between the ring and the sparkle as by the number: the edit
  // menu's ::after, after the ring by its order (the ring stays the row's first, where its note is
  // placed), each circle 23px and 6px before the next, centred on the buttons as the ring and the
  // sparkle are; in neither state there is none, and the row is as it was. The item, pushable,
  // has one button more (push). What the row draws is read by its INK (`menuInk`): a screenshot of
  // the edit menu from its left edge to its first button, with the ring standing still, each mark
  // by its colour (the ring's blue, the previewable pink, the pushable orange, the sparkle's
  // yellow, told apart as `inked` tells them) as its columns from the menu's left edge and its rows
  const menuInk = async () => {
    const still = await page.addStyleTag({ content: '.running-mark::before { animation: none !important }' })
    const clip = await page.evaluate(async id => {
      const menu = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .edit-menu`) as HTMLElement
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const [own, button] = [menu.getBoundingClientRect(), menu.querySelector(':scope > .button')!.getBoundingClientRect()]
      return { x: Math.ceil(own.left), y: Math.floor(own.top), width: Math.floor(button.left) - Math.ceil(own.left), height: Math.ceil(own.height) }
    }, runId)
    const png = (await page.screenshot({ clip })).toString('base64')
    await still.evaluate(style => (style as Element).remove())
    return page.evaluate(async png => {
      const image = new Image()
      image.src = 'data:image/png;base64,' + png
      await image.decode()
      const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height })
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const { data, width, height } = context.getImageData(0, 0, image.width, image.height)
      const inked: Record<string, number[][]> = { ring: [], previewable: [], pushable: [], sparkle: [] }
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const [r, g, b] = [0, 1, 2].map(channel => data[4 * (y * width + x) + channel])
          if (b - r > 25) inked.ring.push([x, y])
          else if (r - b > 50 && g < 0.7 * r) inked.pushable.push([x, y])
          else if (r - g > 40 && b - g > 40) inked.previewable.push([x, y])
          else if (r - b > 50) inked.sparkle.push([x, y])
        }
      return Object.fromEntries(Object.entries(inked).map(([mark, pixels]) => [mark, pixels.length ? { cols: [Math.min(...pixels.map(p => p[0])), Math.max(...pixels.map(p => p[0])) + 1], rows: [Math.min(...pixels.map(p => p[1])), Math.max(...pixels.map(p => p[1])) + 1] } : null]))
    }, png)
  }
  // the marks' columns as found, each within a pixel of the place wanted (null: not drawn)
  const placed = (ink: Record<string, { cols: number[] } | null>, wanted: Record<string, number[] | null>) => Object.entries(wanted).every(([mark, cols]) => (cols ? !!ink[mark] && ink[mark]!.cols.every((edge, side) => Math.abs(edge - cols[side]) <= 1) : !ink[mark]))
  const first = () => page.evaluate(id => (menu => menu.querySelector(':scope > .running-mark')!.getBoundingClientRect().left - menu.getBoundingClientRect().left)(document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"] .edit-menu`)!), runId)
  const plain = await menu()
  expect([plain.states, plain.before, await first()], 'edited, in neither state: no circles, and the ring first').toEqual([null, 2 * (23 + 6), 0])
  await states(true, true)
  await expect.poll(menu, 'edited while running, watched, pushable and previewable: the ring at the row\'s left end, then the two circles, then the sparkle').toMatchObject({ before: 4 * (23 + 6), ring: ['-1', '23px', '6px', BLUE], mark: ['0', '23px', '6px', SPARKLE], states: ['-1', '52px', '23px', '6px'], buttons: plain.buttons + 1, rows: 1, right: 0, over: 5 })
  expect(await first(), 'the ring is still the row\'s first').toBe(0)
  const all = await menuInk()
  expect([placed(all, { ring: [0, 23], previewable: [29, 52], pushable: [58, 81], sparkle: [87, 110] }), ...['previewable', 'pushable'].map(mark => all[mark] && all[mark]!.rows[0] + all[mark]!.rows[1] - all.ring!.rows[0] - all.ring!.rows[1])], `by their ink: the ring, the pink circle, the orange one and the sparkle, 23px each and 6px apart, the circles centred as the ring is (${JSON.stringify(all)})`).toEqual([true, 0, 0])
  await runs(false)
  await expect.poll(menu, 'no longer running: the two circles first').toMatchObject({ before: 3 * (23 + 6), ring: null, states: ['-1', '52px', '23px', '6px'], rows: 1, right: 0, over: 5 })
  await states(true)
  await expect.poll(menu, 'pushable alone: its circle, then the sparkle').toMatchObject({ before: 2 * (23 + 6), ring: null, mark: ['0', '23px', '6px', SPARKLE], states: ['-1', '23px', '23px', '6px'], rows: 1, right: 0, over: 5 })
  expect(placed(await menuInk(), { ring: null, previewable: null, pushable: [0, 23], sparkle: [29, 52] }), 'by their ink: the orange circle first, then the sparkle').toBe(true)
  await states(false)
  await expect.poll(menu, 'in neither state and not running: the sparkle alone, the row as it was').toMatchObject({ before: 23 + 6, ring: null, mark: ['0', '23px', '6px', SPARKLE], states: null, buttons: plain.buttons, rows: 1, right: 0, past: false, over: 5 })
  await runs(true)
  await expect.poll(async () => (await menu()).ring, { timeout: 15_000 }).toEqual(['-1', '23px', '6px', BLUE])
  await runs(false)
  await expect.poll(menu, 'no longer running: the sparkle alone').toMatchObject({ before: 23 + 6, ring: null, mark: ['0', '23px', '6px', SPARKLE], rows: 1, right: 0, past: false, over: 5 })
  // a FULL menu in a phone's window: the item given every button (pushable, and from a source:
  // set on the page's own record of it, since this account has no pusher and the item was not
  // installed), watched and running, at 375px: the ring, the pushable circle, the sparkle and
  // eight buttons. Its row is wider than the item: still one row, ending at the item's right
  // edge, it begins left of the item's left edge (the marks first, where the list cuts them
  // off), and adds nothing to the item's height
  const sourced = (source: string | null) =>
    page.evaluate(([id, source]) => {
      const record = window.__items.find(item => item.id == id) as unknown as { attr: Record<string, unknown> | null }
      record.attr = source ? { ...(record.attr ?? {}), source } : Object.fromEntries(Object.entries(record.attr ?? {}).filter(([name]) => name != 'source'))
      ;(window._item(id, true) as unknown as { pushable: boolean }).pushable = !!source
    }, [runId, source] as const)
  await sourced('https://github.com/olcan/mind.items/blob/master/e2e_mark_run.md')
  await runs(true)
  await page.setViewportSize({ width: 375, height: 667 })
  await expect
    .poll(menu, { message: 'a full menu at 375px: one row of the ring, the circle, the sparkle and all eight buttons, ending at the item\'s right edge and beginning left of its left edge, 5px over the editor; the stored height the box\'s', timeout: 15_000 })
    .toMatchObject({ before: 3 * (23 + 6), ring: ['-1', '23px', '6px', BLUE], mark: ['0', '23px', '6px', SPARKLE], states: ['-1', '23px', '23px', '6px'], buttons: 8, rows: 1, right: 0, past: true, over: 5, agree: true })
  // watched or not changes no height. The item no longer runs, and the window is made as wide as
  // the row of the eight buttons, the circle and half a sparkle more: watched, the sparkle takes the row past
  // the item's left edge, not watched the row fits in the item; one row either way, and the
  // item's height, as the layout holds it and as the box has it, stays what it was. The watch is
  // changed as the watcher changes it, by its published rule: the #vault item rewrites its
  // stylesheet, and no property of this item's component changes. Each time the heights are read
  // once, two frames after the row changed
  await runs(false)
  const fit = await page.evaluate(id => {
    const box = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`) as HTMLElement
    const row = [...box.querySelectorAll('.edit-menu > .button')].reduce((sum, button) => sum + button.getBoundingClientRect().width, 0)
    return { row, beside: innerWidth - box.getBoundingClientRect().width } // the buttons' row, and what of the window is not the item's
  }, runId)
  await page.setViewportSize({ width: Math.ceil(fit.row + (23 + 6) + 14 + fit.beside), height: 667 })
  const changed = async (past: boolean, message: string) => {
    await expect.poll(async () => (found => [found.rows, found.past])(await menu()), { message, timeout: POLL_MS }).toEqual([1, past])
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    return (await menu()).heights
  }
  await expect
    .poll(async () => (found => [found.rows, found.past, found.agree])(await menu()), { message: 'the premise: watched at this width the one row begins left of the item\'s left edge, and the resized window\'s heights are settled', timeout: POLL_MS })
    .toEqual([1, true, true])
  const height = (await menu()).heights
  await follows([{ ...RULE, tags: [KID] }]) // the watch no longer names the item's tag
  expect(await changed(false, 'not watched: the row fits in the item'), 'not watched: the same height, stored and actual').toEqual(height)
  await follows([{ ...RULE, tags: [TAG, KID] }])
  expect(await changed(true, 'watched again: the row begins left of the item\'s left edge'), 'watched again: the same height').toEqual(height)
  await runs(true)
  await sourced(null)
  // an item that is being SAVED is dimmed as before, whether it runs or not: the save's write is
  // held at the network, and until it is let go the overlay covers the item's box, half black,
  // with the saving spinner of 25px, also while the run ends and begins again under the same
  // write (until 2026-11-18 a run at the same time put its own 40px spinner there instead); a
  // running item that is not being saved has no overlay (the item still runs, from the step above)
  let release = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  const WRITES = /Firestore\/Write\/channel/
  await page.route(WRITES, async route => {
    if (route.request().method() == 'POST') await held
    await route.continue()
  })
  const dimmed = () =>
    page.evaluate(id => {
      const box = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`) as HTMLElement
      const loading = box.querySelector('.loading') as HTMLElement
      const [style, outer, inner] = [getComputedStyle(loading), box.getBoundingClientRect(), loading.getBoundingClientRect()]
      return {
        saving: box.classList.contains('saving'),
        running: box.classList.contains('running'),
        overlay: style.visibility,
        shade: style.backgroundColor,
        covers: inner.left <= outer.left && inner.top <= outer.top && inner.right >= outer.right && inner.bottom >= outer.bottom,
        spinner: [loading.childElementCount, loading.firstElementChild ? getComputedStyle(loading.firstElementChild).getPropertyValue('--size').trim() : null], // how many, and of which size (the spinner's own property: its box turns)
      }
    }, runId)
  await page.locator(`#textarea-${runId}`).fill(RUN_TEXT.replace('can run', 'can run and is saved'))
  await page.keyboard.press('Shift+Enter') // save
  await expect(page.locator(`#textarea-${runId}`)).toBeHidden()
  const SAVING = { saving: true, overlay: 'visible', shade: 'rgba(0, 0, 0, 0.5)', covers: true, spinner: [1, '25px'] }
  await expect.poll(dimmed, 'saving while running: the overlay, with the saving spinner').toEqual({ ...SAVING, running: true })
  await runs(false)
  await expect.poll(dimmed, 'the run ends under the same write: the same overlay').toEqual({ ...SAVING, running: false })
  await runs(true)
  await expect.poll(dimmed, 'and begins again: the same overlay').toEqual({ ...SAVING, running: true })
  release()
  await expect.poll(dimmed, { message: 'saved, still running: no overlay', timeout: POLL_MS }).toEqual({ saving: false, running: true, overlay: 'hidden', shade: 'rgba(0, 0, 0, 0.5)', covers: true, spinner: [0, null] })
  await page.unroute(WRITES)
  await runs(false)
  await boxed(false)
  expect(dialogs, 'no alert of the sparkle or the items').toEqual([])
})

// A PHONE (2026-11-19; the owner's todo, of an iPhone): where the browser reports that its
// primary pointer does not hover, no tooltip comes up for a tap, so there the menu itself says
// what the tooltips say. The row is the first row's account on a phone, as far as a desktop
// lane can play one (as tests/e2e/key_buttons.spec.ts: a narrow touch window of Chromium's
// emulation, whose primary pointer is coarse and does not hover). (a) a tap on the sparkle
// opens the menu, and below its entries, which are the desktop's, in their order, it says the
// sparkle's own words, then each watched line with its details under it, in the lines' own
// small type: inside the window, the details wrapped, each row where a finger reaches it; (b) a
// tap on any of these rows is a click that nothing answers; nothing of the sparkle, the menu,
// its entries or its layer can be selected there (their computed style), and a finger held on
// the menu's own edge under the rows, or on an entry's label, selects nothing and starts no
// selection (before the change the first selected a word of the entry above, the second a word
// of the label), where the same press on an item's text selects its word: the lane's proof
// that it can show a selection; (c) three watches, in the window too, and the words follow what
// the sparkle shows while the menu is open; (d) an entry's tap does what it did: Stop Watching
// sends the one stop. The hovering menu is the row above's, a desktop's, which holds the lines
// alone (a picture of it is taken here where pictures are asked for). iOS Safari is in no
// lane: what a long press selects on a real phone is not shown here
const PHONE = { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
// pictures of the row's states, written only where SPARKLE_SHOTS names a directory for them
const SHOTS = process.env.SPARKLE_SHOTS
type Clip = { x: number; y: number; width: number; height: number }
const shot = async (page: Page, name: string, clip?: Clip) => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), ...(clip ? { clip } : {}) })
}
// the menu as it is drawn, a row for each of its children in order: what it is (an entry by its
// key, a tooltip's words said in the menu by whose they are, any other row a line), its text
// and its tooltip
const menuRows = (page: Page) =>
  page.evaluate(() =>
    [...(document.querySelector('[data-vault-sparkle="menu"]')?.children ?? [])].map(child => {
      const row = child as HTMLElement
      return [row.dataset.vaultEntry ?? (row.dataset.vaultTip ? `says:${row.dataset.vaultTip}` : 'line'), row.textContent, row.title]
    }),
  )
// where the menu and its rows are: whether the menu is inside the window, off its edges; each
// row's place, its type, how far its text is set in and how many lines it takes, and whether a
// finger at its middle reaches it
const menuLook = (page: Page) =>
  page.evaluate(() => {
    const menu = document.querySelector('[data-vault-sparkle="menu"]') as HTMLElement
    const rows = [...menu.children].map(child => {
      const box = child.getBoundingClientRect()
      const style = getComputedStyle(child)
      const [x, y] = [box.left + box.width / 2, box.top + box.height / 2]
      const lines = Math.round((box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight))
      return { left: box.left, top: box.top, bottom: box.bottom, x, y, type: `${style.fontSize} ${style.fontFamily}`, inset: parseFloat(style.paddingLeft), lines, reached: document.elementFromPoint(x, y) === child }
    })
    const box = menu.getBoundingClientRect()
    return { rows, left: box.left, right: box.right, top: box.top, bottom: box.bottom, inside: box.left > 0 && box.top > 0 && box.right < window.innerWidth && box.bottom < window.innerHeight }
  })
// what of the sparkle and its open menu can be selected, by the style the browser computes:
// the sparkle, the layer, the menu and each of its children, by name
const selectable = (page: Page) =>
  page.evaluate(() =>
    ([...document.querySelectorAll('[data-vault-sparkle="node"], [data-vault-sparkle="backdrop"], [data-vault-sparkle="menu"], [data-vault-sparkle="menu"] > *')] as HTMLElement[])
      .filter(part => getComputedStyle(part).userSelect != 'none')
      .map(part => part.dataset.vaultSparkle ?? part.dataset.vaultEntry ?? part.textContent),
  )
const selection = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? '')
// the next event of a kind on the page, by what it is sent to (an entry by its key, the sparkle,
// the layer or the menu's own box by its name, a row of the menu by its text, anything else as
// the page's): asked for before the input that causes it, and waited for after it, instead of
// a time
const next = (page: Page, type: string) =>
  page.evaluate(type => {
    ;(window as any).__next = new Promise<string>(done =>
      document.addEventListener(
        type,
        event => {
          const target = event.target as HTMLElement
          const part = target.closest<HTMLElement>('[data-vault-entry], [data-vault-sparkle]')
          const row = part?.dataset.vaultSparkle == 'menu' && part !== target
          done(!part ? 'the page' : row ? target.textContent ?? '' : part.dataset.vaultEntry ?? part.dataset.vaultSparkle!)
        },
        { capture: true, once: true },
      ),
    )
  }, type)
const came = (page: Page) => page.evaluate(() => (window as any).__next as Promise<string>)
// a finger's tap, by its outcome: the click the browser makes of it, and what that lands on
const tap = async (page: Page, x: number, y: number) => {
  await next(page, 'click')
  await page.touchscreen.tap(x, y)
  return came(page)
}
// a finger held down, long enough for the browser's own long press: a tap gesture of one second,
// which the browser synthesizes itself (CDP's Input.synthesizeTapGesture). Chromium then sends
// `contextmenu` and selects the word under the finger, where one can be selected. Touch input
// that a driver injects point by point (Input.dispatchTouchEvent) is never a long press:
// Chromium gives it no long press timer, and its release is a tap, however late it comes. The
// press is known by its outcome, the `contextmenu`: what that was sent to, and what is selected
const hold = async (page: Page, x: number, y: number) => {
  await next(page, 'contextmenu')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.synthesizeTapGesture', { x, y, duration: 1000, tapCount: 1, gestureSourceType: 'touch' })
  await cdp.detach()
  return [await came(page), await selection(page)]
}

test('on a phone the menu says what the tooltips say, and a held finger selects nothing of it', async ({ browser }) => {
  const dialogs: string[] = []
  // a returning device: the account's secret is there, so no phrase is asked for
  const returning = async (page: Page) => {
    page.on('dialog', dialog => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`)
      void (dialog.type() == 'beforeunload' ? dialog.accept() : dialog.dismiss())
    })
    expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
    await page.addInitScript(secret => {
      localStorage.setItem('mindpage_github_token', 'e2e-local')
      localStorage.setItem('mindpage_secret', secret)
      localStorage.setItem('mindpage_kdf', 'off')
    }, SECRET)
    await loadUser(page, USER)
    await waitForApp(page)
    await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: POLL_MS }).toBe(true)
    await expect.poll(async () => (await sparkle(page)).nodes, { timeout: POLL_MS }).toBe(1)
  }
  const context = await browser.newContext(PHONE)
  const phone = await context.newPage()
  await returning(phone)
  expect(
    await phone.evaluate(() => [innerWidth, matchMedia('(hover: none)').matches, matchMedia('(hover: hover)').matches, 'ontouchstart' in window]),
    "a phone's window: 375 px, a primary pointer that does not hover, touch",
  ).toEqual([375, true, false, true])

  // the watched items are this row's own: a tag's item and one that carries the tag
  const TAG = '#e2e_phone'
  const ONE = '#e2e_phone_a'
  const WORD = 'selectable'
  for (const text of [`${TAG} is this item's own label`, `${ONE} a ${WORD} item that carries ${TAG}`]) {
    await phone.evaluate(text => void window._create(text), text)
    await expect.poll(() => savedId(phone, text.split(' ')[0]), { timeout: POLL_MS }).toBeTruthy()
  }
  const SINCE = '2026-11-18T09:01:02.000Z'
  const since = await phone.evaluate(since => new Date(since).toLocaleString(), SINCE)
  const RULE = { watch: 'phone', name: AGENT, since: SINCE }
  const OTHER = 'gpt-6-astra-ultra'
  const follows = (rules: Record<string, any>[], more: Record<string, any> = {}) => watched(phone, { name: AGENT, took: TOOK, state: 'watching', tab: true, follows: rules, ...more })
  const WATCHING = `${AGENT} is watching`
  const LINE = `watched: ${TAG} (2 items)`
  const DETAILS = `${AGENT} follows ${TAG} since ${since}`
  const ENTRIES = [['stop', 'Stop Watching', ''], ['close', 'Close Agent Session', '']]
  await fresh(phone)
  await follows([{ ...RULE, tags: [TAG] }])
  await expect.poll(async () => (await sparkle(phone)).title, { timeout: POLL_MS }).toBe(`${WATCHING}\n${LINE}`)

  // (a) the sparkle is the desktop's, tooltip and all; a tap opens the menu, which says the
  // tooltips' words below its entries
  const tapSparkle = async () => {
    const box = (await phone.locator(NODE).boundingBox())!
    expect(await tap(phone, box.x + box.width / 2, box.y + box.height / 2), "the tap's click is the sparkle's").toBe('node')
    await expect.poll(async () => (await sparkle(phone)).menus).toBe(1)
  }
  await tapSparkle()
  const ONE_WATCH = [...ENTRIES, ['says:sparkle', WATCHING, ''], ['line', LINE, ''], ['says:line', DETAILS, '']]
  expect(await menuRows(phone), "the entries, then the sparkle's words, the watched line and its details under it; nothing is left to a tooltip").toEqual(ONE_WATCH)
  const one = await menuLook(phone)
  const [words, line, details] = one.rows.slice(2)
  expect(line.type, "the lines' type is the menu's small one").toMatch(/^12px /)
  expect(
    { inside: one.inside, reached: one.rows.map(row => row.reached), types: [words.type, details.type], under: details.top == line.bottom, inset: [words.inset == line.inset, details.inset > line.inset], wrapped: [line.lines, details.lines > 1] },
    "the menu is inside the window, off its edges, and a finger reaches every row; the words and the details are in the lines' type, the details directly under their line, set in from it and wrapped",
  ).toEqual({ inside: true, reached: one.rows.map(() => true), types: [line.type, line.type], under: true, inset: [true, true], wrapped: [1, true] })
  await shot(phone, 'phone_375_one_watch')

  // (b) a tap on the words, the line or its details is a click on that row, which nothing
  // answers: the menu stays as it is, and nothing is sent
  const clicked: string[] = []
  for (const row of [words, line, details]) clicked.push(await tap(phone, row.x, row.y))
  expect([clicked, await menuRows(phone), (await commands()).length, await selection(phone)], 'taps on the rows below the entries').toEqual([[WATCHING, LINE, DETAILS], ONE_WATCH, 0, ''])
  // nothing of the sparkle, the layer, the menu, its entries and its rows can be selected, by
  // their style; and a finger held on the menu's own edge under the rows, and on an entry's
  // label, where the nearest text that could be selected was the entries': the long press
  // comes (its `contextmenu`, at the menu and at the entry), nothing is selected and no
  // selection starts; the menu is as it was, and nothing is sent
  const unguarded = await selectable(phone)
  await phone.evaluate(() => {
    const started: string[] = ((window as any).__started = [])
    document.addEventListener('selectstart', event => started.push((event.target as Node).nodeName), true)
  })
  const edge = await hold(phone, details.x, one.bottom - 3)
  const label = await hold(phone, one.rows[1].left + 30, one.rows[1].y)
  expect(
    { selectable: unguarded, edge, label, started: await phone.evaluate(() => (window as any).__started), rows: await menuRows(phone), sent: (await commands()).length },
    "nothing of the sparkle and its open menu can be selected, and a finger held on the menu's lower edge and on an entry's label selects nothing",
  ).toEqual({ selectable: [], edge: ['menu', ''], label: ['close', ''], started: [], rows: ONE_WATCH, sent: 0 })
  // the lane's proof that it can show a selection: the same press on an item's own text
  await phone.keyboard.press('Escape')
  await expect.poll(async () => (await sparkle(phone)).menus).toBe(0)
  await phone.evaluate(label => (window as any).MindBox.set(label), ONE)
  await expect.poll(() => phone.evaluate(label => !!window._item(label, true)?.elem?.querySelector('.item'), ONE), { timeout: POLL_MS }).toBe(true)
  const word = await phone.evaluate(
    ([label, word]) => {
      const walker = document.createTreeWalker(window._item(label, true)!.elem!.querySelector('.item')!, NodeFilter.SHOW_TEXT)
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const at = text.textContent!.indexOf(word)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(text, at)
        range.setEnd(text, at + word.length)
        const box = range.getBoundingClientRect()
        return [box.left + box.width / 2, box.top + box.height / 2]
      }
      return null
    },
    [ONE, WORD],
  )
  expect(word, "the item's word is on the page").toBeTruthy()
  expect([await hold(phone, word![0], word![1]), await phone.evaluate(() => (window as any).__started.length > 0)], "a finger held on an item's word selects it").toEqual([['the page', WORD], true])
  await phone.evaluate(() => getSelection()?.removeAllRanges())
  if (SHOTS) {
    // pictures alone: the watched item while it runs, the app's ring left of its sparkle; and
    // the same watch's menu on a desktop, whose pointer hovers
    const running = (on: boolean) => phone.evaluate(([label, on]) => void ((window._item(label as string, true) as any).running = on), [ONE, on] as const)
    await running(true)
    const clip = await phone.evaluate(async label => {
      const id = window._item(label, true)!.id
      for (let n = 0; n < 100 && !document.querySelector(`.container[data-item-id="${id}"].running .item-menu`); n++) await new Promise(done => setTimeout(done, 100))
      const box = document.querySelector(`.container[data-item-id="${id}"]`)!.getBoundingClientRect()
      return { x: 0, y: Math.max(0, box.top - 30), width: innerWidth, height: Math.min(box.height + 60, 220) }
    }, ONE)
    await shot(phone, 'phone_375_watched_mark_beside_running_ring', clip)
    await running(false)
    const desk = await browser.newContext()
    const desktop = await desk.newPage()
    await returning(desktop)
    await expect.poll(async () => (await sparkle(desktop)).title, { timeout: POLL_MS }).toBe(`${WATCHING}\n${LINE}`)
    await desktop.locator(NODE).click()
    await expect.poll(async () => (await sparkle(desktop)).menus).toBe(1)
    const menu = await menuLook(desktop)
    await shot(desktop, 'desktop_hover_one_watch', { x: menu.left - 60, y: menu.top - 40, width: menu.right - menu.left + 74, height: menu.bottom - menu.top + 82 })
    await desk.close()
  }

  // (c) three watches: every watch has its details under its line, and all of it is in the window
  const oneId = await savedId(phone, ONE)
  const THREE = [{ ...RULE, tags: [TAG] }, { ...RULE, watch: 'phones', labels: [`${TAG}*`] }, { watch: 'one', name: OTHER, since: SINCE, ids: [oneId] }]
  await follows(THREE)
  const LINES = [LINE, `watched: ${TAG}* (2 items)`, `watched: ${ONE}`]
  await expect.poll(async () => (await sparkle(phone)).title, { timeout: POLL_MS }).toBe(`${WATCHING}\nwatched: ${LINES.map(line => line.slice('watched: '.length)).join(' · ')}`)
  await tapSparkle()
  const THREE_WATCHES = [
    ...ENTRIES,
    ['says:sparkle', WATCHING, ''],
    ['line', LINES[0], ''],
    ['says:line', DETAILS, ''],
    ['line', LINES[1], ''],
    ['says:line', `${AGENT} follows ${TAG}* since ${since}`, ''],
    ['line', LINES[2], ''],
    ['says:line', `${OTHER} follows ${ONE} since ${since}`, ''],
  ]
  expect(await menuRows(phone)).toEqual(THREE_WATCHES)
  const three = await menuLook(phone)
  expect([three.inside, three.rows.map(row => row.reached)], 'three watches: the whole menu is inside the window, and a finger reaches every row').toEqual([true, three.rows.map(() => true)])
  await shot(phone, 'phone_375_three_watches')
  // the words are the sparkle's as it is now: an answer by another agent, with the menu open
  // (the same watch and the same rules, so the menu stays), and other watches close it, as
  // they always did
  await follows(THREE, { state: 'answering', by: OTHER })
  await expect.poll(async () => (await sparkle(phone)).answering, { timeout: POLL_MS }).toBe(true)
  expect(await menuRows(phone), 'the open menu says who answers').toEqual(THREE_WATCHES.map(row => (row[0] == 'says:sparkle' ? ['says:sparkle', `${OTHER} is answering`, ''] : row)))
  await follows([{ ...RULE, tags: [TAG] }])
  await expect.poll(async () => (await sparkle(phone)).title, { timeout: POLL_MS }).toBe(`${WATCHING}\n${LINE}`)
  expect((await sparkle(phone)).menus, 'other watches: the menu that showed the three closed').toBe(0)

  // (d) an entry's tap: Stop Watching sends the one stop, naming the watch shown
  await tapSparkle()
  expect(await menuRows(phone)).toEqual(ONE_WATCH)
  const stop = (await menuLook(phone)).rows[0]
  expect(await tap(phone, stop.x, stop.y), "the tap's click is the entry's").toBe('stop')
  expect((await sent('stop')).wrapper.item).toMatchObject({ kind: 'stop', took: TOOK })
  await expect
    .poll(async () => {
      const said = await sparkle(phone)
      return [said.menus, said.title]
    }, { timeout: POLL_MS })
    .toEqual([0, `Stopping ${AGENT}'s watch\n${LINE}`])
  expect(dialogs, 'no alert of the sparkle or the items').toEqual([])
  await context.close()
})

// ONE READING, the ground of the watched mark: the `#vault` item marks by the app's label index
// and `tags_raw`, and the vault's item watcher selects by its own port of the app's reading (the
// vault's lib/mindpage_reading.py). The corpus is what both run over. The watcher's row is the
// vault's tests/test_mindpage_reading.py; this one saves each text as an item of the lane's
// account and takes the reading from the page: the key of the label index the item is under,
// and the `label` and `tags_raw` that item code sees. (As the row above, it signs the account
// of the first row in again)
test('the app reads every text of the reading corpus as the corpus says', async ({ page }) => {
  page.on('dialog', dialog => void (dialog.type() == 'beforeunload' ? dialog.accept() : dialog.dismiss()))
  expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
  await page.addInitScript(secret => {
    localStorage.setItem('mindpage_github_token', 'e2e-local')
    localStorage.setItem('mindpage_secret', secret)
    localStorage.setItem('mindpage_kdf', 'off')
  }, SECRET)
  await loadUser(page, USER)
  await waitForApp(page)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: POLL_MS }).toBe(true)

  type Reading = { label: string; label_text: string; tags: string[] }
  const rows: (Reading & { why: string; text: string })[] = JSON.parse(readFileSync(resolve('tests/e2e/fixtures/reading_corpus.json'), 'utf8')).texts
  expect(rows.length).toBeGreaterThanOrEqual(65)
  const changed: string[] = [] // the texts the app does not hold as given
  for (const row of rows) {
    const id = await page.evaluate(async text => ((await window._create(text)) as any)?.id as string | undefined, row.text)
    expect(typeof id, row.why).toBe('string')
    await expect.poll(() => page.evaluate(id => window._item(id!, true)?.saved_id ?? null, id), { timeout: POLL_MS }).toBeTruthy()
    // (as JSON: the app can cut a label's text inside a character, and half of one does not cross the page's boundary whole)
    const read: Reading & { text: string; keys: number } = JSON.parse(
      await page.evaluate(id => {
        const item = window._item(id!, true) as any
        const keys: string[] = (window as any)._labels((_label: string, ids: string[]) => ids.includes(item.id))
        return JSON.stringify({ text: item.text, label: keys[0] ?? '', label_text: item.label, tags: item.tags_raw, keys: keys.length })
      }, id)
    )
    expect({ label: read.label, label_text: read.label_text, tags: read.tags }, `${row.why}: ${JSON.stringify(row.text)}`).toEqual({ label: row.label, label_text: row.label_text, tags: row.tags })
    expect(read.keys, row.why).toBeLessThanOrEqual(1)
    if (read.text !== row.text) changed.push(row.why)
  }
  // an item's text is the corpus's, but for what the app drops at any save
  expect(changed).toEqual(['a zero-width space is no part of the text'])
})

// the sparkle's end, the spec's last row since 2026-11-21 (vault design notes/design/gate_speed.md:
// a pin of the rows above no longer waits for the deleted item's look): the first row's account
// as a returning device, as the rows above start, with the bridge fresh. Phases (h) and (i)
test('the deleted item draws no sparkle, and the sign-out after its install again leaves none', async ({ page }) => {
  const dialogs: string[] = []
  page.on('dialog', dialog => {
    const leaving = dialog.type() == 'beforeunload'
    dialogs.push(leaving ? `beforeunload: ${dialog.message()}` : dialog.message())
    void (leaving ? dialog.accept() : dialog.dismiss())
  })
  expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
  await page.addInitScript(secret => {
    localStorage.setItem('mindpage_github_token', 'e2e-local')
    localStorage.setItem('mindpage_secret', secret)
    localStorage.setItem('mindpage_kdf', 'off')
  }, SECRET)
  await loadUser(page, USER)
  await waitForApp(page)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: POLL_MS }).toBe(true)
  await expect.poll(async () => (await sparkle(page)).nodes, { timeout: POLL_MS }).toBe(1)
  await fresh(page)

  // (h) the item is deleted: its task's next look removes everything the sparkle owned
  await page.evaluate(() => window._item('#vault', true)!.delete(false))
  await expect.poll(() => sparkle(page), { timeout: 45_000 }).toMatchObject({ nodes: 0, styles: 0, menus: 0, layers: 0 })
  expect(await page.evaluate(() => '_vault_sparkle' in window)).toBe(false)

  // (i) installed again and watched, then a successful sign-out: the reloaded page has none
  expect(await install(page, 'vault'), '/_install vault again').toBeNull()
  await expect.poll(async () => !!(await savedId(page, '#vault')), { timeout: POLL_MS }).toBe(true)
  const reinstalled = 'global_store_' + (await savedId(page, '#vault'))
  await expect.poll(async () => (await hidden()).some(d => d.wrapper.name == reinstalled), { timeout: POLL_MS }).toBe(true)
  await watched(page, { name: AGENT, took: TOOK, state: 'watching' })
  await expect.poll(() => sparkle(page), { timeout: POLL_MS }).toEqual(shown(`${AGENT} is watching`))
  await page.evaluate(() => void window._create('/_signout', { command: true }))
  await expect.poll(() => page.evaluate(() => window._readonly === true && window._init_time > 0).catch(() => false), { timeout: 90_000 }).toBe(true)
  expect(await sparkle(page)).toMatchObject({ nodes: 0, styles: 0, menus: 0, layers: 0 })
  expect(dialogs, 'no alert of the sparkle or the installs').toEqual([])
})
