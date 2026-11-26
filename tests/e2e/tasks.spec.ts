import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { OFFLINE_BROWSER_ARGS } from '../../src/e2e_lanes.js'
import { asUser, focusMindbox, mindbox, userSet } from './editor_helpers.js'
import { customToken, firestore, install, interceptMindItems, loadAnonymous, secretFor, signIn, waitForApp, type TestUser } from './helpers.js'

// the task-agents todoer (vault design notes/design/mind_task_agents.md, 2.2-2.4, 6; slice 3):
// one self-contained personal account with #todoer installed from the local mind.items checkout
// and its pinned item carrying both widgets. phases: (a) a delegation (/delegate) enqueues
// exactly one command document through the app's narrow hidden-document operation (the
// wrapper `task_command_<id>` with the body captured BEFORE the presentation edits), writes the
// [delegated] marker and the route tag, and moves the item to the delegated list at once
// through the pending overlay; the raw document is recorded as the vault's transport fixture;
// (b) the bridge's acknowledgment (a projection written behind the app) settles the overlay
// and the age; (c) a hand-back projection with the bridge's marker and one-shot unsnooze puts
// the item back on top of the main list; (d) a re-delegation carries the current epoch, and a
// take-back overlays the main list immediately while a further delegate is refused; (e) a
// body over the bridge's stored-size cap is refused before anything is written; (f) the drag
// gesture to the agent bin is the same enqueue. The next three rows (the first view's position in
// history after a launch; Back after a reload and a todo row's click; Back after a sign-out) run over an
// account of their own each. The last row is the running mark's (its other rows are in
// tests/e2e/layout.spec.ts), here because it writes behind the app: an Option-run releases the record
// that received its hold, on the anonymous notebook
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)
test.use({ hasTouch: true }) // phase (c4) sends real touch input (CDP); nothing else in the lane depends on touch

const USER: TestUser = { uid: 'tasks_e2e', displayName: 'Tasks Test', email: 'tasks@e2e.test' }
const PHRASE = 'tasks e2e phrase'
const SECRET = secretFor(USER, PHRASE)
const TASK = '#e2e_task'
// the agent's inert answer (the production shape, vault design 2.1) under the owner's line, with an
// owner amendment inside it: the raw bytes the bridge must receive and the app must never lose
const ANSWER = '<!--inert-->\nagent: no; the reversion needs an older cache. (owner: check the snapshot too)\n<!--/inert-->'
const TASK_TEXT = `${TASK}\n#todo fix the cache\nreverts on a returning device\n${ANSWER}`
// the row's snippet runs from the tag into the following lines (200 characters), hidden tags dropped
const SNIPPET = 'fix the cache reverts on a returning device'
// the recording of the produced documents as the vault's transport fixture is EXPLICIT
// (RECORD_FIXTURES=1); every other run checks that the committed fixture still decodes
const RECORD = process.env.RECORD_FIXTURES === '1'
const OTHER = '#e2e_other'
const OTHER_TEXT = `${OTHER}\n#todo write the release note`
// a NAMED todo's row starts with its label (the todoer, 2026-09-26: the unique label the row's
// click targets, which a snippet from the #todo tag on never shows), then the snippet
const OTHER_ROW = `${OTHER} #todo write the release note`
const FIXTURE = resolve('tests/e2e/fixtures/task_command.json')
// the launch row's own account (the last row): the todoer over a page that holds what its flow needs
// and nothing else, so its launches re-rank and scroll for the row's reasons alone
const LAUNCH_USER: TestUser = { uid: 'tasks_launch_e2e', displayName: 'Tasks Launch', email: 'tasks_launch@e2e.test' }
const LAUNCH_SECRET = secretFor(LAUNCH_USER, PHRASE)
// the reload row's own account (the row after it), of the same make
const RELOAD_USER: TestUser = { uid: 'tasks_reload_e2e', displayName: 'Tasks Reload', email: 'tasks_reload@e2e.test' }
const RELOAD_SECRET = secretFor(RELOAD_USER, PHRASE)
// the sign-out row's account: no todoer, two items
const SWITCH_USER: TestUser = { uid: 'tasks_switch_e2e', displayName: 'Tasks Switch', email: 'tasks_switch@e2e.test' }
// the waiting-rows and bells row's own account: #todoer installed from mind.items, both widgets
const WAITS_USER: TestUser = { uid: 'tasks_waits_e2e', displayName: 'Tasks Waits', email: 'tasks_waits@e2e.test' }
const WAITS_SECRET = secretFor(WAITS_USER, PHRASE)
// the service-worker notifications row's own account: real notification permission + active SW
const NOTIFY_SW_USER: TestUser = { uid: 'tasks_notify_sw_e2e', displayName: 'Tasks Notify SW', email: 'tasks_notify_sw@e2e.test' }
const NOTIFY_SW_SECRET = secretFor(NOTIFY_SW_USER, PHRASE)
// the bin-buttons, j/k row shortcuts, select-next, touch corner-size, and selected-row-border rows' account
const BIN_USER: TestUser = { uid: 'tasks_bin_e2e', displayName: 'Tasks Bin Buttons', email: 'tasks_bin@e2e.test' }
const BIN_SECRET = secretFor(BIN_USER, PHRASE)
// the shortcuts-menu row's own account: #todoer + #shortcuts installed from mind.items
const SHORTCUTS_USER: TestUser = { uid: 'tasks_shortcuts_e2e', displayName: 'Tasks Shortcuts', email: 'tasks_shortcuts@e2e.test' }

type Command = { doc: string; wrapper: { name: string; item: Record<string, any> }; raw: Record<string, any> }

async function cleanup() {
  const db = firestore()
  for (const { uid } of [USER, LAUNCH_USER, RELOAD_USER, SWITCH_USER, WAITS_USER, NOTIFY_SW_USER, BIN_USER, SHORTCUTS_USER]) {
    const docs = await db.collection('items').where('user', '==', uid).get()
    for (const doc of docs.docs) await doc.ref.delete()
    await db.collection('users').doc(uid).delete()
  }
}

async function enterPhrase(page: Page, prompt: RegExp, phrase: string, button: string) {
  await expect(page.getByText(prompt)).toBeVisible({ timeout: 60_000 })
  await page.fill('#modal-input', phrase)
  await page.locator('.modal .button.confirm', { hasText: button }).click()
}

// every command document of the account (the wrapper names start with the command prefix),
// decrypted with the account's stored secret (the app writes v0 under its default write gate)
async function commands(): Promise<Command[]> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const snap = await firestore().collection('items').where('user', '==', USER.uid).where('hidden', '==', true).get()
  const out: Command[] = []
  for (const doc of snap.docs) {
    try {
      const raw = doc.data()
      const plain = JSON.parse(await decryptWithSecret(raw.cipher, SECRET))
      const wrapper = JSON.parse(plain.text)
      if (typeof wrapper.name == 'string' && wrapper.name.startsWith('task_command_')) out.push({ doc: doc.id, wrapper, raw })
    } catch {} // an unrelated or differently keyed record
  }
  return out.sort((a, b) => (a.wrapper.item.at as number) - (b.wrapper.item.at as number))
}

// the bridge's store write behind the app (the app's hidden document shape, v0)
async function writeStore(id: string, name: string, item: unknown, user = USER, secret = SECRET) {
  const { encryptWithSecret } = await import('../../src/crypto.js')
  const time = Date.now()
  const cipher = await encryptWithSecret(JSON.stringify({ hidden: true, time, attr: null, text: JSON.stringify({ name, item }) }), secret)
  await firestore().collection('items').doc(id).set({ user: user.uid, time, hidden: true, text: null, attr: null, cipher })
}

// the decrypted text of a visible document as the SERVER holds it (the raw bytes, inert regions
// included, unlike the app's grammar-view read)
async function serverText(id: string, secret = SECRET): Promise<string | null> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const data = (await firestore().collection('items').doc(id).get()).data()
  if (!data?.cipher) return data?.text ?? null
  return JSON.parse(await decryptWithSecret(data.cipher, secret)).text ?? null
}

// the hidden document that holds a wrapper name (to rewrite a store in place, as another tab would)
async function storeDocId(name: string, user = USER, secret = SECRET): Promise<string | null> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const snap = await firestore().collection('items').where('user', '==', user.uid).where('hidden', '==', true).get()
  for (const doc of snap.docs) {
    try {
      const wrapper = JSON.parse(JSON.parse(await decryptWithSecret(doc.data().cipher, secret)).text)
      if (wrapper.name == name) return doc.id
    } catch {}
  }
  return null
}
// the store value the server holds under a wrapper name (decrypting every hidden document of
// the account, since names live inside the ciphertext), or null when none does
async function serverStore(name: string, user = USER, secret = SECRET): Promise<any> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const snap = await firestore().collection('items').where('user', '==', user.uid).where('hidden', '==', true).get()
  for (const doc of snap.docs) {
    try {
      const plain = JSON.parse(await decryptWithSecret(doc.data().cipher, secret))
      const wrapper = JSON.parse(plain.text)
      if (wrapper.name == name) return wrapper.item
    } catch {} // an unrelated or differently keyed record
  }
  return null
}

// the bridge's text write behind the app: the visible document's decrypted text replaced
async function rewriteText(id: string, edit: (text: string) => string, secret = SECRET) {
  const { decryptWithSecret, encryptWithSecret } = await import('../../src/crypto.js')
  const ref = firestore().collection('items').doc(id)
  const data = (await ref.get()).data()!
  const inner = JSON.parse(await decryptWithSecret(data.cipher, secret))
  inner.text = edit(inner.text)
  inner.time = Date.now()
  await ref.update({ time: inner.time, cipher: await encryptWithSecret(JSON.stringify(inner), secret) })
}

const read = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.read('') ?? null, name)
const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)
const command = (page: Page, text: string) =>
  page.evaluate(text => Promise.resolve(window._create(text, { command: true, return_alerts: true })).then(out => (typeof out == 'string' ? out : null)), text)

// a command typed into the mindbox and entered, as the owner does it: a handled /delegate or
// /takeback leaves the box EMPTY (their null return left the command in it; the owner,
// 2026-11-16). command() cannot see that: it normalizes every non-string result to null and
// neither enters the command into the box nor checks the box's value
async function entered(page: Page, text: string) {
  await focusMindbox(page)
  await mindbox(page).fill(text)
  await page.keyboard.press('Shift+Enter') // done once the modifier is released (Editor.svelte)
  await expect(mindbox(page)).toHaveValue('', { timeout: 30_000 })
}

// a refused gesture: the todoer reports it in the browser's alert (item code keeps the native
// dialogs; the harness dismisses them and keeps their messages) and the command handler returns
// the command text, which the app puts back in the box
const dialogs: string[] = []
async function refused(page: Page, text: string, message: RegExp) {
  const before = dialogs.length
  expect(await command(page, text)).toBeNull() // a string return goes to the editor, not the caller
  await expect.poll(() => page.evaluate(() => (window as any).MindBox.get()), { timeout: 10_000 }).toBe(text)
  await expect.poll(() => dialogs.length, { timeout: 10_000 }).toBeGreaterThan(before)
  expect(dialogs[dialogs.length - 1]).toMatch(message)
}

// the widgets' rows: the main list (the first widget) and the delegated list (the second), as
// [snippet text, pending kind or null, age or null] tuples in list order
type Row = [string, string | null, string | null]
async function lists(page: Page): Promise<{ main: Row[]; delegated: Row[] }> {
  return page.evaluate(() => {
    const widgets = [...document.querySelectorAll('.todoer-widget')]
    const rows = (widget: Element | undefined): Row[] =>
      [...(widget?.querySelectorAll('.list > .list-item-container') ?? [])].map(c => [
        (c.querySelector('.list-item')?.textContent ?? '').replace(/‎/g, '').replace(/\s+/g, ' ').trim(),
        c.getAttribute('data-pending'),
        c.querySelector('mark.age')?.textContent ?? null,
      ])
    return { main: rows(widgets[0]), delegated: rows(widgets[1]) }
  })
}

test.beforeAll(cleanup)
test.afterAll(cleanup)

test('a delegation enqueues one command document, marks the item, and moves it through the overlay', async ({ page }) => {
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
  expect(await install(page, 'todoer'), '/_install todoer').toBeNull()
  await page.reload()
  await waitForApp(page)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 30_000 }).toBe(true)

  // the pinned item with both widgets, then two todos
  await page.evaluate(() => (window._item('#todoer') as any).eval('create_pinned_item()'))
  await expect.poll(() => page.locator('.todoer-widget').count(), { timeout: 30_000 }).toBe(2)
  await page.evaluate(text => void window._create(text), TASK_TEXT)
  await page.evaluate(text => void window._create(text), OTHER_TEXT)
  await expect.poll(() => savedId(page, TASK), { timeout: 30_000 }).toBeTruthy()
  await expect.poll(() => savedId(page, OTHER), { timeout: 30_000 }).toBeTruthy()
  const taskId = (await savedId(page, TASK))!
  await expect.poll(async () => (await lists(page)).main.map(r => r[0]).sort()).toEqual([OTHER_ROW, `${TASK} #todo ${SNIPPET}`]) // sorted: the labels lead the texts
  expect((await lists(page)).delegated).toEqual([])
  // the capture is the RAW text the server holds (the answer region included), not the app's
  // grammar-view read, whose inert regions are tokens
  await expect.poll(() => serverText(taskId), { timeout: 30_000 }).toBe(TASK_TEXT)
  const captured = TASK_TEXT
  expect(await read(page, TASK), 'the grammar view carries a token, not the region').not.toContain('agent:')

  // (a) the delegation
  expect(await command(page, `/delegate ${TASK}`)).toBeNull()
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(1)
  const [delegate] = await commands()
  expect(delegate.wrapper.name).toBe('task_command_' + delegate.wrapper.item.id)
  expect(delegate.wrapper.item).toEqual({
    task: taskId,
    id: delegate.wrapper.item.id,
    kind: 'delegate',
    epoch: 0,
    at: delegate.wrapper.item.at,
    body: captured, // the body BEFORE the marker and the route tag
  })
  expect(delegate.raw.hidden).toBe(true)
  expect(delegate.raw.text).toBeNull()
  expect(delegate.raw.user).toBe(USER.uid)
  // the transport fixture for the vault (tests/test_mindpage_tasks.py delivers both documents
  // through the real ingress): the command and the target item as the server holds them
  const itemDoc = (await firestore().collection('items').doc(taskId).get()).data()!
  const fixture = { user: USER.uid, secret: SECRET, doc: delegate.doc, data: delegate.raw, item: taskId, item_data: itemDoc, body: captured }
  if (RECORD) {
    mkdirSync(resolve('tests/e2e/fixtures'), { recursive: true })
    writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + '\n')
  } else {
    expect(existsSync(FIXTURE), 'the recorded fixture exists (RECORD_FIXTURES=1 records it)').toBe(true)
    const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const { decryptWithSecret } = await import('../../src/crypto.js')
    const wrapper = JSON.parse(JSON.parse(await decryptWithSecret(recorded.data.cipher, recorded.secret)).text)
    expect([wrapper.name, wrapper.item.kind, wrapper.item.body]).toEqual([`task_command_${wrapper.item.id}`, 'delegate', recorded.body])
    expect(recorded.body, 'the recorded capture is the current one (RECORD_FIXTURES=1 re-records after a task text change)').toBe(captured)
  }
  // the presentation edits over the grammar view of the raw text: the marker after the tag
  // (suffix mode) and the route tag, once; the answer region survives byte for byte
  await expect.poll(() => serverText(taskId), { timeout: 30_000 }).toBe(`${TASK}\n#todo [delegated] fix the cache\nreverts on a returning device\n${ANSWER}\n#_agent/vault\n`)
  // the overlay: the item leaves the main list and shows delegated, pending, with no age yet
  await expect.poll(async () => await lists(page), { timeout: 30_000 }).toEqual({
    main: [[OTHER_ROW, null, null]],
    delegated: [[`? ${TASK} #todo [delegated] ${SNIPPET}`, 'delegate', '?']],
  })

  // (b) the bridge acknowledges: the projection written behind the app settles the overlay
  const STORE = 'e2e-task-store'
  const state = { held: 'agent', reason: 'delegated', epoch: 0, rev: 1, updated: Date.now(), worktree: null, phase: 'idle', acked: { [delegate.wrapper.item.id]: 'consumed' } }
  await writeStore(STORE, `global_store_${taskId}`, { _agent: { state } })
  await expect.poll(async () => await lists(page), { timeout: 30_000 }).toEqual({
    main: [[OTHER_ROW, null, null]],
    delegated: [[`<1m ${TASK} #todo [delegated] ${SNIPPET}`, null, '<1m']],
  })
  // the age keeps its absolute-time tooltip and is not a tag (no search on click)
  const age = page.locator('.todoer-widget').nth(1).locator('mark.age')
  expect(await age.getAttribute('title')).toBe(new Date(state.updated).toLocaleString())
  await age.click()
  expect(await page.evaluate(() => (window as any).MindBox.get())).not.toContain('<1m')

  // (b3) the row shows the bridge's stats when the projection carries them (vault design 9.6):
  // workers started and the summed nominal cost after the age, the first delegation's time and
  // `stats.agents` in the tooltip; a projection without stats shows the age alone (above)
  const since = Date.now() - 3_600_000
  await writeStore(STORE, `global_store_${taskId}`, { _agent: { state: { ...state, rev: 2, stats: { turns: 1, workers: 2, active: 0, cost: 1.5, since, agents: [['worker', 'claude-fable-5-2', 2, 1.4, 0, 0]] } } } })
  await expect.poll(async () => await lists(page), { timeout: 30_000 }).toEqual({
    main: [[OTHER_ROW, null, null]],
    delegated: [[`<1m · 2w · $1.50 ${TASK} #todo [delegated] ${SNIPPET}`, null, '<1m · 2w · $1.50']],
  })
  expect(await age.getAttribute('title')).toBe(`${new Date(state.updated).toLocaleString()}\ndelegated ${new Date(since).toLocaleString()}\nworker · claude-fable-5-2 ×2 · $1.40`)

  // (c) a hand-back: the bridge's marker and its _log block on the text (the block is the last
  // content, the route tag stays at the bottom), the projection and the one-shot unsnooze
  // an INFO line is faded (the app's console-info span); an unprefixed line (a STATUS one,
  // design 9.4) is left bare: the bright one
  const LOG = '```_log\n17:40 proposal drafted; gates next\nINFO: 17:41 handed back: question\nINFO: 17:41 turn 1 end 2m $0.42 · total 1 turn 0w $0.42\n```'
  await rewriteText(taskId, text => text.replace('[delegated]', '[question]').replace(/\n#_agent\/vault\n$/, `\n\n${LOG}\n#_agent/vault\n`))
  await expect.poll(() => serverText(taskId), { timeout: 30_000 }).toContain(`${ANSWER}\n\n${LOG}\n#_agent/vault\n`)
  // the rendered item ends with the log block (its level-highlighted lines do not defeat the
  // tail cleanup) and no empty paragraph holds the hidden tag under it
  await page.evaluate(name => void (location.hash = name), TASK) // show the item alone
  const content = () => page.evaluate(name => window._item(name, true)?.elem?.querySelector('.content')?.innerHTML ?? null, TASK)
  const tail = async () => (await content())?.slice(-700) ?? null // the assertion shows the tail on failure
  await expect.poll(tail, { timeout: 30_000 }).toMatch(/17:40 proposal drafted; gates next\n<span class="console-info">INFO: 17:41 handed back: question<\/span>\n<span class="console-info">INFO: 17:41 turn 1 end 2m \$0\.42 · total 1 turn 0w \$0\.42<\/span>\n?<\/code><\/pre>\s*$/)
  // and the two renderings differ in color: the INFO span faded, the bare line the block's own
  const colors = await page.evaluate(name => {
    const code = window._item(name, true)!.elem!.querySelector('code._log') as HTMLElement
    return [getComputedStyle(code.querySelector('.console-info')!).color, getComputedStyle(code).color]
  }, TASK)
  expect(colors[0], 'an INFO line is faded, an unprefixed one is not').not.toBe(colors[1])
  expect(await content()).not.toMatch(/<p>(?:\s|<mark class="[^"]*hidden[^"]*"[^>]*>[^<]*<\/mark>)*<\/p>\s*(?:<mark|<pre|$)/)
  await page.evaluate(() => void (location.hash = '')) // back to the pinned lists
  await expect.poll(() => page.locator('.todoer-widget').count(), { timeout: 30_000 }).toBe(2)
  await writeStore(STORE, `global_store_${taskId}`, {
    _agent: { state: { ...state, held: 'owner', reason: 'question', epoch: 1, rev: 2, updated: Date.now() } },
    _todoer: { unsnoozed: Date.now() },
  })
  // the widget's own save (clearing the one-shot unsnooze) carries the bridge's projection as
  // delivered, never this tab's older copy: no revert for the bridge to repair
  await expect.poll(async () => (await serverStore(`global_store_${taskId}`))?._todoer?.unsnoozed ?? null, { timeout: 30_000 }).toBeNull()
  expect((await serverStore(`global_store_${taskId}`))._agent.state.rev, 'the projection survives the widget\'s save').toBe(2)
  await expect.poll(async () => await lists(page), { timeout: 30_000 }).toEqual({
    main: [
      [`${TASK} #todo [question] ${SNIPPET}`, null, null], // the snippet drops the _log block
      [OTHER_ROW, null, null],
    ],
    delegated: [],
  })

  // (c2) the saved list order and another writer (2026-09-12): a tab holding part of the items
  // (a stale device mid-sync) or an older build wrote the main list's order; this tab re-sorts
  // to it and does NOT write it back (a delivery-caused render reproduces the delivered string);
  // a local change (a resurfacing) writes the order with the unknown id kept in place; a store
  // stamped by a NEWER build makes this build stop writing orders and ask for a reload
  const otherId = (await savedId(page, OTHER))!
  const pinId = await page.evaluate(() => {
    const container = document.querySelector('.todoer-widget')?.closest('[data-item-id]')
    return window._item('id:' + container?.getAttribute('data-item-id'), true)?.saved_id ?? null
  })
  expect(pinId, 'the pinned item is saved').toBeTruthy()
  const PIN = `global_store_${pinId}`
  await expect.poll(() => storeDocId(PIN), { timeout: 30_000 }).toBeTruthy() // the widget saved its order
  const pinDoc = (await storeDocId(PIN))!
  const pinStore = await serverStore(PIN)
  const stale = `zzz-unknown,${otherId},${taskId}`
  await writeStore(pinDoc, PIN, { ...pinStore, _todoer: { ...pinStore._todoer, '#todo': stale } })
  await expect.poll(async () => (await lists(page)).main.map(r => r[0]), { timeout: 30_000 }).toEqual([
    OTHER_ROW,
    `${TASK} #todo [question] ${SNIPPET}`,
  ])
  await page.waitForTimeout(2500) // the delivered order stands (a stable final string, not a write count)
  expect((await serverStore(PIN))._todoer['#todo'], 'the delivered order stands, the unknown id kept').toBe(stale)
  // a local change: the bridge's resurfacing floats the task, and the widget saves the new order
  await writeStore(STORE, `global_store_${taskId}`, {
    _agent: { state: { ...state, held: 'owner', reason: 'question', epoch: 1, rev: 3, updated: Date.now() } },
    _todoer: { unsnoozed: Date.now() },
  })
  await expect.poll(async () => (await serverStore(PIN))._todoer['#todo'], { timeout: 30_000 }).toBe(`zzz-unknown,${taskId},${otherId}`)
  expect((await serverStore(PIN))._todoer.version, 'the writer stamps its build').toBe(1)
  // a newer build wrote the store: this build stops writing orders and asks for a reload once
  const newer = `${otherId},${taskId}`
  await writeStore(pinDoc, PIN, { ...(await serverStore(PIN)), _todoer: { ...(await serverStore(PIN))._todoer, '#todo': newer, version: 99 } })
  await expect.poll(async () => (await lists(page)).main.map(r => r[0])[0], { timeout: 30_000 }).toBe(OTHER_ROW)
  await writeStore(STORE, `global_store_${taskId}`, {
    _agent: { state: { ...state, held: 'owner', reason: 'question', epoch: 1, rev: 4, updated: Date.now() } },
    _todoer: { unsnoozed: Date.now() },
  })
  await expect.poll(() => dialogs.some(d => /reload to keep your todo order/.test(d)), { timeout: 30_000 }).toBe(true) // at least one notice; the exact count is a backfill
  await page.waitForTimeout(2500)
  expect((await serverStore(PIN))._todoer['#todo'], 'the newer build\'s order stands').toBe(newer)
  // back to this build's stamp and the order the later phases expect (the task first)
  await writeStore(pinDoc, PIN, { ...(await serverStore(PIN)), _todoer: { ...(await serverStore(PIN))._todoer, '#todo': `${taskId},${otherId}`, version: 1 } })
  await expect.poll(async () => (await lists(page)).main.map(r => r[0])[0], { timeout: 30_000 }).toBe(`${TASK} #todo [question] ${SNIPPET}`)
  // ... and the tab's OWN copy of the store carries the stamp back: a delivery is not copied
  // onto the item while the tab owes a save for that store, and a copy left at the newer stamp
  // refuses every later order save silently (the notice shows once), which could explain a
  // reorder below that never persisted (seen once, 2026-09-25; the copy's state at that failure
  // was not captured). a timeout here is a failure to investigate, never to retry around
  await expect
    .poll(() => page.evaluate(id => (window._item('id:' + id, true) as any)?._global_store?._todoer?.version, pinId), { timeout: 30_000 })
    .toBe(1)

  // (c3) the context menu on a row after a touch press is prevented (the suppression the todoer
  // adds; whether the delayed touch drag then starts on the owner's laptop is their trial); a
  // mouse or keyboard menu is not. The listener contract only: synthetic events, no gesture,
  // no Sortable press
  const rowMenu = (press: string | null, menu: Record<string, unknown>) =>
    page.evaluate(([press, menu]) => {
      const row = document.querySelector('.todoer-widget .list > .list-item-container') as HTMLElement
      if (press == 'keyboard') row.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }))
      else if (press) row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: press }))
      const event = 'pointerType' in menu ? new PointerEvent('contextmenu', { bubbles: true, cancelable: true, ...menu }) : new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      row.dispatchEvent(event)
      return event.defaultPrevented
    }, [press, menu] as [string | null, Record<string, unknown>])
  expect(await rowMenu('touch', {}), 'a touch press, a menu without a pointer type: prevented').toBe(true)
  expect(await rowMenu('mouse', {}), 'a mouse press: not prevented').toBe(false)
  expect(await rowMenu('touch', { pointerType: '' }), 'a keyboard menu (an empty pointer type) after a touch press: not prevented').toBe(false)
  expect(await rowMenu(null, { pointerType: 'touch' }), 'the menu event\'s own touch type: prevented').toBe(true)
  expect(await rowMenu('touch', { pointerType: 'mouse' }), 'the menu event\'s own mouse type wins over the press: not prevented').toBe(false)

  // (c4) a quick sideways touch grabs its row without the drag delay (the list's touch-action and
  // the todoer's _grab_on_sideways_touch): real touch input through CDP. The first row, pressed
  // and moved 12 px sideways, is chosen at once (the in-page clock: under the 250 ms delay),
  // then dragged on below the second row and released, which reorders the list (the saved order
  // flips); a touch moved down is never chosen (a scroll). A widget re-render during the press
  // (a store change landing) replaces the list under the touch, and a starved renderer can let
  // the delay end first, so the press is retried until it is conclusive; the order is put back
  // for the later phases
  const cdp = await page.context().newCDPSession(page)
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
  const mainList = page.locator('.todoer-widget').first().locator('.list')
  const rowBox = async (text: string) => (await mainList.locator('> .list-item-container', { hasText: text }).boundingBox())!
  // the in-page clock: the press and the first move stamped by DOCUMENT-level capturing
  // pointer listeners (ahead of every listener on the list: Sortable's bubbling pointerdown
  // arms its timer later, and the todoer's capturing pointermove grabs later; a class observer
  // runs as a microtask right after the listener that changed the class, so a stamp taken by a
  // listener behind the todoer's would follow the choose), the choose by that class observer on
  // the list; the grab is conclusive only when the press and the move were observed on the
  // current list, the move came under the delay, and the row was chosen by the move (not before
  // it, as the delay path would have it)
  type Clock = { pressed: number; moved: number; chosen: number }
  const probe = () =>
    page.evaluate(() => {
      const w = window as any
      const list = document.querySelector('.todoer-widget .list') as HTMLElement
      const t: Clock = { pressed: 0, moved: 0, chosen: 0 }
      w.__touch = t
      w.__touchOff?.()
      const onDown = (e: PointerEvent) => e.pointerType == 'touch' && list.contains(e.target as Node) && (t.pressed = performance.now())
      const onMove = (e: PointerEvent) => e.pointerType == 'touch' && !t.moved && list.contains(e.target as Node) && (t.moved = performance.now())
      document.addEventListener('pointerdown', onDown, true)
      document.addEventListener('pointermove', onMove, true)
      w.__touchOff = () => {
        document.removeEventListener('pointerdown', onDown, true)
        document.removeEventListener('pointermove', onMove, true)
      }
      new MutationObserver(() => {
        if (!t.chosen && list.querySelector('.sortable-chosen')) t.chosen = performance.now()
      }).observe(list, { subtree: true, attributes: true, attributeFilter: ['class'] })
    })
  const probed = () => page.evaluate(() => (window as any).__touch as Clock)
  const grab = async (text: string) => {
    let grabbed: Clock | null = null
    for (let attempt = 0; attempt < 5 && !grabbed; attempt++) {
      await probe()
      const box = await rowBox(text)
      const y = box.y + box.height / 2
      await touch('touchStart', [{ x: box.x + 40, y }])
      await touch('touchMove', [{ x: box.x + 52, y }]) // 12 px sideways
      const t = await probed()
      if (t.pressed && t.moved && t.moved - t.pressed < 250 && t.chosen > t.moved) grabbed = t
      else {
        await touch('touchCancel', []) // no tap, no click on the row
        await page.waitForTimeout(1000)
      }
    }
    expect(grabbed, `the ${text} row was chosen by the sideways move, under the delay`).not.toBeNull()
  }
  // the grabbed row dragged to a point in six moves (Sortable's fallback drag follows the touch)
  // and released, with a render of EVERY widget injected at the second move (2026-09-25): a
  // store delivery does this under the full gate's load, and Sortable keeps the drag's state in
  // variables shared by all its instances, so the delegated widget's re-render, which destroys
  // its Sortables, ended the main list's drag without its events: the ghost row stayed in the
  // list, unchoose never came and the widget kept its dragging class for good (the row's one
  // failure in every full gate). the todoer now defers every widget's render while any widget
  // drags and runs them at the release; the first move started the drag, so by the second the
  // dragging widget and both widgets' pending renders are observable
  type Point = { x: number; y: number }
  const dragTo = async (from: Point, to: Point | (() => Promise<Point>), { inject = true } = {}) => {
    // the first move past Sortable's fallback tolerance starts the drag, which changes the
    // widget's layout (the bins show, the list narrows): a target inside a bin is resolved then
    await touch('touchMove', [{ x: from.x + 8, y: from.y }])
    await page.waitForTimeout(60)
    const target = typeof to == 'function' ? await to() : to
    for (let step = 1; step <= 6; step++) {
      await touch('touchMove', [{ x: from.x + ((target.x - from.x) * step) / 6, y: from.y + ((target.y - from.y) * step) / 6 }])
      await page.waitForTimeout(60)
      if (step == 2 && inject) {
        await page.evaluate(() => (window._item('#todoer') as any).eval('_rerender_todoer_widgets()'))
        expect(
          await page.evaluate(() => ({
            dragging: document.querySelectorAll('.todoer-widget.dragging').length,
            pending: [...document.querySelectorAll('.todoer-widget')].filter(w => (w as any)._renderPendingDragging).length,
          })),
          'the injected render found the drag on and deferred both widgets'
        ).toEqual({ dragging: 1, pending: 2 })
      }
    }
    await page.waitForTimeout(300) // the swap's animation
    await touch('touchEnd', [])
  }
  // the widget is a block while no row is dragged: it spans its item's text area whatever the
  // placeholder beside the item's number takes of it (a flex row is a formatting context of its own,
  // which the placeholder narrowed over the widget's whole height). A row beside the placeholder gives
  // way to it with everything it paints: its border when selected, its border and background when
  // chosen for a drag (a row's own box does not give way, so its .list-item paints them), here with
  // the room a watched item's mark adds to the placeholder (the vault item's 18 px margin). A later
  // row runs to the area's edge (a row is shifted 3 px to the left, which its width limit allows
  // for). And the number stays tappable where a long first row's own box lies under it, also while
  // that row shows a pending command (its overlay is on the .list-item: on the row's own box it made
  // a stacking context above the number's button). Every row is made long for the measure, by a
  // filler that is removed
  expect(
    await page.evaluate(() => {
      const widget = document.querySelector('.todoer-widget')!
      const content = widget.closest('.item')!
      const style = getComputedStyle(content)
      const area = content.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)
      const spacer = content.querySelector('[id^="menu-"]') as HTMLElement
      const rows = [...widget.querySelectorAll('.list > .list-item-container')]
      const fillers = rows.map(row => row.querySelector('.list-item')!.appendChild(Object.assign(document.createElement('span'), { textContent: ' filler'.repeat(80) })))
      spacer.style.marginLeft = '18px'
      const edge = spacer.getBoundingClientRect().left - 18 // the placeholder's margin edge: what stands beside it ends here
      // the boxes of the first row that paint a border or a background in a state, by their right ends
      const painted = (state: string) => {
        rows[0].classList.add(state)
        const boxes = [rows[0], rows[0].querySelector('.list-item')!].filter(box => {
          const style = getComputedStyle(box)
          return (parseFloat(style.borderTopWidth) > 0 && style.borderTopColor != 'rgba(0, 0, 0, 0)') || style.backgroundColor != 'rgba(0, 0, 0, 0)'
        })
        const ends = boxes.map(box => Math.round((box.getBoundingClientRect().right - edge) * 100) / 100)
        rows[0].classList.remove(state)
        return ends
      }
      // what a tap gets at a point inside both the first row's own box and the number's button, while
      // the row is pending
      const tapped = () => {
        const number = content.closest('.super-container')!.querySelector('.item-menu .index')!
        const [button, row] = [number.getBoundingClientRect(), rows[0].getBoundingClientRect()]
        const [left, right] = [Math.max(button.left, row.left), Math.min(button.right, row.right)]
        const [top, bottom] = [Math.max(button.top, row.top), Math.min(button.bottom, row.bottom)]
        if (left >= right || top >= bottom) return 'the row does not reach under the number'
        const pending = rows[0].getAttribute('data-pending')
        rows[0].setAttribute('data-pending', 'take_back')
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
        if (pending === null) rows[0].removeAttribute('data-pending')
        else rows[0].setAttribute('data-pending', pending)
        return hit && number.contains(hit) ? 'the number' : `${hit?.tagName}.${hit?.className}`
      }
      const result = {
        // the premise: more than one row, the first one beside the placeholder, which takes of the text area
        premise: [rows.length > 1, rows[0].getBoundingClientRect().top < spacer.getBoundingClientRect().bottom, edge < area],
        widget: Math.round(widget.getBoundingClientRect().right - area),
        selected: painted('selected'),
        chosen: painted('sortable-chosen'),
        later: Math.max(...rows.slice(1).map(row => Math.abs(Math.round(row.getBoundingClientRect().right - area)))),
        tapped: tapped(),
      }
      spacer.style.marginLeft = ''
      fillers.forEach(filler => filler.remove())
      return result
    }),
    'the widget spans the text area; what a selected or chosen first row paints ends at the placeholder; a later row runs to the edge; a tap on the number over a pending first row gets the number'
  ).toEqual({ premise: [true, true, true], widget: 0, selected: [0], chosen: [0], later: 0, tapped: 'the number' })
  await grab(SNIPPET)
  {
    // dragged on below the second row, released: the list reorders
    const first = await rowBox(SNIPPET)
    const second = await rowBox('write the release note')
    await dragTo({ x: first.x + 52, y: first.y + first.height / 2 }, { x: first.x + 52, y: second.y + second.height })
  }
  await expect.poll(async () => (await lists(page)).main.map(r => r[0]), { timeout: 30_000 }).toEqual([OTHER_ROW, `${TASK} #todo [question] ${SNIPPET}`])
  // the drag ended whole: no ghost or chosen row left behind (Sortable's plain hidden clone
  // would be a third row in the list assertion above), no widget still dragging, the deferred
  // renders run at the release
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          leftovers: document.querySelectorAll('.todoer-widget .sortable-fallback, .todoer-widget .sortable-ghost, .todoer-widget .sortable-chosen').length,
          dragging: document.querySelectorAll('.todoer-widget.dragging').length,
        })),
      { timeout: 10_000 }
    )
    .toEqual({ leftovers: 0, dragging: 0 })
  await expect.poll(async () => (await serverStore(PIN))._todoer['#todo'], { timeout: 30_000 }).toBe(`${otherId},${taskId}`)
  // a drop INTO A BIN with a render deferred carries no order hint (review 0): the row is outside
  // the list at the release, and a cancelled snooze restores it, so a hint recorded then (the
  // list without it) would put it first at the rebuild and persist that; the order stands
  await grab(SNIPPET)
  {
    const row = await rowBox(SNIPPET)
    await dragTo({ x: row.x + 52, y: row.y + row.height / 2 }, async () => {
      const bin = (await page.locator('.todoer-widget').first().locator('.snooze.bin').boundingBox())!
      return { x: bin.x + bin.width / 2, y: bin.y + bin.height / 2 }
    })
  }
  await expect(page.locator('.snooze-modal')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape') // no snooze time: the row is restored
  await expect(page.locator('.snooze-modal')).toBeHidden({ timeout: 10_000 })
  await expect.poll(async () => (await lists(page)).main.map(r => r[0]), { timeout: 30_000 }).toEqual([OTHER_ROW, `${TASK} #todo [question] ${SNIPPET}`])
  await page.waitForTimeout(2500) // a stable final string, not a write count (as in (c2))
  expect((await serverStore(PIN))._todoer['#todo'], 'the order stands after the cancelled bin drop').toBe(`${otherId},${taskId}`)
  // a drag while the save must WAIT (an unconfirmed corpus here; a dead stream or a resume hold
  // alike) keeps its order through the renders meanwhile (2026-09-26: the order hint stays until
  // a save persists it) and is persisted once the wait ends; the flag is the app's own window
  // property, put back afterwards
  await page.evaluate(() => void (window._server_confirmed = false))
  await grab(SNIPPET)
  {
    const first = await rowBox(SNIPPET) // the second row now: dragged back above the first
    const other = await rowBox('write the release note')
    await dragTo({ x: first.x + 52, y: first.y + first.height / 2 }, { x: first.x + 52, y: other.y }, { inject: false }) // no render during this drag: the hint is recorded regardless
  }
  await expect.poll(async () => (await lists(page)).main.map(r => r[0]), { timeout: 30_000 }).toEqual([`${TASK} #todo [question] ${SNIPPET}`, OTHER_ROW])
  // two renders before any save: the hint outlives the first (a hint consumed by one render lost the drag at the next)
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => (window._item('#todoer') as any).eval('_rerender_todoer_widgets()'))
    await page.waitForTimeout(1200)
  }
  expect((await lists(page)).main.map(r => r[0]), 'the drag survives the renders while its save waits').toEqual([`${TASK} #todo [question] ${SNIPPET}`, OTHER_ROW])
  expect((await serverStore(PIN))._todoer['#todo'], 'nothing written while the save waits').toBe(`${otherId},${taskId}`)
  await page.evaluate(() => void (window._server_confirmed = true))
  await expect.poll(async () => (await serverStore(PIN))._todoer['#todo'], { timeout: 30_000 }).toBe(`${taskId},${otherId}`)
  // a plain PRESS AND RELEASE on a row without a move (a click, minus the row's own click handler:
  // Sortable's pointerdown on the list and its mouseup on the document, the listener contract as
  // in (c3)) fires unchoose without a drag and saves nothing, and records no order hint (review
  // 0): a hint recorded then outlived the click, and the next remote reorder's render applied it
  // and persisted it over the newer order
  await page.evaluate(text => {
    const row = [...document.querySelectorAll('.todoer-widget .list > .list-item-container')].find(r => r.textContent!.includes(text)) as HTMLElement
    const box = row.getBoundingClientRect()
    const at = { clientX: box.left + 40, clientY: box.top + box.height / 2 }
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, ...at }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, ...at }))
  }, SNIPPET)
  await page.waitForTimeout(500)
  await writeStore(pinDoc, PIN, { ...(await serverStore(PIN)), _todoer: { ...(await serverStore(PIN))._todoer, '#todo': `${otherId},${taskId}` } })
  await expect.poll(async () => (await lists(page)).main.map(r => r[0]), { timeout: 30_000 }).toEqual([OTHER_ROW, `${TASK} #todo [question] ${SNIPPET}`])
  await page.waitForTimeout(2500)
  expect((await serverStore(PIN))._todoer['#todo'], 'the remote reorder stands after a click without a drag').toBe(`${otherId},${taskId}`)
  // a touch moved down (past the tap slop) is a scroll: never chosen, the delay notwithstanding
  await probe()
  {
    const box = await rowBox('write the release note')
    await touch('touchStart', [{ x: box.x + 40, y: box.y + box.height / 2 }])
    await touch('touchMove', [{ x: box.x + 41, y: box.y + box.height / 2 + 24 }])
    await page.waitForTimeout(400) // past the delay
    const t = await probed()
    expect([t.pressed > 0, t.moved > 0, t.chosen], 'a downward move (observed on the list) grabs nothing').toEqual([true, true, 0])
    await touch('touchEnd', [])
  }
  // the order the later phases expect (the task first)
  await writeStore(pinDoc, PIN, { ...(await serverStore(PIN)), _todoer: { ...(await serverStore(PIN))._todoer, '#todo': `${taskId},${otherId}` } })
  await expect.poll(async () => (await lists(page)).main.map(r => r[0])[0], { timeout: 30_000 }).toBe(`${TASK} #todo [question] ${SNIPPET}`)

  // (d) a re-delegation under the current epoch, then a take-back that overlays at once and
  // refuses a further delegate until acknowledged; both typed into the box, which each clears
  await entered(page, `/delegate ${TASK}`)
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(2)
  const again = (await commands())[1]
  expect([again.wrapper.item.kind, again.wrapper.item.epoch]).toEqual(['delegate', 1])
  expect(again.wrapper.item.body).toContain('#todo [question] fix the cache') // the capture, before the new marker
  expect(again.wrapper.item.body).toContain(ANSWER) // raw, region included
  await expect.poll(() => serverText(taskId), { timeout: 30_000 }).toContain('#todo [delegated] fix the cache')
  const afterAgain = (await serverText(taskId))!
  expect(afterAgain.match(/#_agent\/vault/g)?.length).toBe(1) // the route tag once
  expect(afterAgain).toContain(ANSWER)
  await expect.poll(async () => (await lists(page)).delegated.map(r => r[1]), { timeout: 30_000 }).toEqual(['delegate'])
  await entered(page, `/takeback ${TASK}`)
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(3)
  const takeback = (await commands())[2]
  expect(takeback.wrapper.item).toEqual({ task: taskId, id: takeback.wrapper.item.id, kind: 'takeback', epoch: 1, at: takeback.wrapper.item.at })
  await expect.poll(async () => await lists(page), { timeout: 30_000 }).toEqual({
    main: [
      [`${TASK} #todo [delegated] ${SNIPPET}`, 'takeback', null],
      [OTHER_ROW, null, null],
    ],
    delegated: [],
  })
  await refused(page, `/delegate ${TASK}`, /take-back .* pending/)
  expect((await commands()).length).toBe(3)

  // (e) the size gate: a body over the agreed app-side bound (the bridge writer's stored-size
  // cap) is refused here, nothing written
  await page.evaluate(text => void window._create(text), `#e2e_huge\n#todo a huge one\n${'x'.repeat(300_000)}`)
  await expect.poll(() => savedId(page, '#e2e_huge'), { timeout: 60_000 }).toBeTruthy()
  await refused(page, '/delegate #e2e_huge', /too large/)
  expect((await commands()).length).toBe(3)
  expect(await read(page, '#e2e_huge')).not.toContain('[delegated]')

  // (g) the transport claim (design 3.1): a server-created command document survives a LATER
  // queued whole-store save of its task (a stale or offline tab's save is a different
  // document), and a delegation enqueued offline reaches the server as its own document when
  // the device reconnects. The kept command is phase (a)'s, as the server holds it now
  const keptDoc = await firestore().collection('items').doc(delegate.doc).get()
  const kept = { id: delegate.doc, cipher: keptDoc.data()!.cipher as string, wrapper: delegate.wrapper }
  const third = '#e2e_offline'
  await page.evaluate(text => void window._create(text), `${third}\n#todo an offline one`)
  await expect.poll(() => savedId(page, third), { timeout: 30_000 }).toBeTruthy()
  const thirdId = (await savedId(page, third))!
  await page.context().setOffline(true)
  // the kept command's task gets an unrelated store field, queued offline: a sentinel no
  // gesture clears (the whole-store save carries the app's copy of the projection along)
  const SENTINEL = 'offline store save ' + Date.now()
  await page.evaluate(([name, sentinel]) => {
    const item = window._item(name)! as any
    item.global_store._e2e = { sentinel }
  }, [TASK, SENTINEL] as const)
  // an offline delegation of another todo: the overlay begins at the enqueue
  expect(await command(page, `/delegate ${third}`)).toBeNull()
  await expect.poll(async () => (await lists(page)).delegated.map(r => r[1]), { timeout: 30_000 }).toContain('delegate')
  expect((await commands()).length, 'nothing reached the server while offline').toBe(3)
  expect(await serverStore(`global_store_${taskId}`), 'the store save is still queued').not.toHaveProperty('_e2e')
  await page.context().setOffline(false)
  // the barrier: the server's decrypted hidden store carries the sentinel
  await expect.poll(async () => (await serverStore(`global_store_${taskId}`))?._e2e?.sentinel ?? null, { timeout: 60_000 }).toBe(SENTINEL)
  // the kept command document: the same document, the same ciphertext, the same payload
  const keptAfter = await firestore().collection('items').doc(kept.id).get()
  expect(keptAfter.exists, 'the command document survives the later store save').toBe(true)
  expect(keptAfter.data()!.cipher).toBe(kept.cipher)
  expect((await commands()).find(c => c.doc == kept.id)?.wrapper).toEqual(kept.wrapper)
  // the offline delegation landed as its own document
  await expect.poll(async () => (await commands()).length, { timeout: 60_000 }).toBe(4)
  const offline = (await commands())[3]
  expect([offline.wrapper.item.kind, offline.wrapper.item.task]).toEqual(['delegate', thirdId])
  await expect.poll(() => serverText(thirdId), { timeout: 30_000 }).toContain('[delegated]')

  // (f) the drag gesture: the other todo to the main widget's agent bin. A widget re-render
  // (a store or item change landing during the press) replaces the list under the pointer, so
  // the press is retried until the widget enters its dragging state
  const widget = page.locator('.todoer-widget').first()
  let dragging = false
  for (let attempt = 0; attempt < 5 && !dragging; attempt++) {
    const row = widget.locator('.list-item-container', { hasText: 'write the release note' })
    const box = (await row.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(400) // the widget's drag delay
    await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2 + 5, { steps: 5 })
    dragging = /dragging/.test((await widget.getAttribute('class')) ?? '')
    if (!dragging) {
      await page.mouse.up()
      await page.waitForTimeout(1000)
    }
  }
  expect(dragging, 'the widget entered its dragging state').toBe(true)
  const bin = (await widget.locator('.bin.agent').boundingBox())!
  await page.mouse.move(bin.x + bin.width / 2, bin.y + bin.height / 2, { steps: 20 })
  await page.mouse.up()
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(5)
  const dragged = (await commands())[4]
  expect([dragged.wrapper.item.kind, dragged.wrapper.item.task]).toEqual(['delegate', await savedId(page, OTHER)])
  await expect.poll(async () => (await lists(page)).delegated.map(r => r[1]), { timeout: 30_000 }).toEqual(['delegate', 'delegate'])

  // (i) the plain-text form (vault design 2.2): `/delegate <text>` creates the todo as /todo
  // does and delegates it once its save names it (the command's task is the new item's saved
  // id, the capture its created text), the command consumed (no retry offered: a retry would
  // create a second todo); the created item's id is a reference, a re-delegation as in (d)
  expect(await command(page, '/delegate check the backups')).toBeNull()
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(6)
  const plain = (await commands())[5]
  const plainId = plain.wrapper.item.task as string
  expect(plain.wrapper.item).toEqual({ task: plainId, id: plain.wrapper.item.id, kind: 'delegate', epoch: 0, at: plain.wrapper.item.at, body: '#todo check the backups' })
  expect([taskId, thirdId, await savedId(page, OTHER)], 'a new item').not.toContain(plainId)
  await expect.poll(() => serverText(plainId), { timeout: 30_000 }).toBe('#todo [delegated] check the backups\n#_agent/vault\n')
  await expect.poll(async () => (await lists(page)).delegated, { timeout: 30_000 }).toContainEqual(['? #todo [delegated] check the backups', 'delegate', '?'])
  await expect.poll(() => page.evaluate(() => (window as any).MindBox.get()), { timeout: 10_000 }).toBe('')
  expect(await command(page, `/delegate ${plainId}`)).toBeNull()
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(7)
  expect((await commands())[6].wrapper.item.task).toBe(plainId)
  const rows = await lists(page)
  expect([...rows.main, ...rows.delegated].filter(r => r[0].includes(plainId)), 'no todo made of the id').toEqual([])

  // (h) a TASK item that runs looks as any running item does (2026-11-18, the owner: the running
  // border and the dimming go for "running" items, "including chat/agent running items"): the
  // circle left of its number, no overlay and no blue border. Until then a task item (its store
  // carries the bridge's `_agent.state`, vault design 9.6) had the blue border without the
  // overlay and every other item both. The other todo, with no `_agent.state`, is the comparison
  const setRunning = (name: string, running: boolean) =>
    page.evaluate(([name, running]) => void ((window._item(name as string, true) as any).running = running), [name, running] as const)
  const BLUE = 'rgb(68, 170, 255)' // #4af, the circle's and the border's that went
  const marked = (name: string) =>
    page.evaluate(([name, blue]) => {
      const elem = window._item(name, true)!.elem!
      const container = elem.querySelector('.container') as HTMLElement
      const mark = elem.querySelector('.item-menu > .index > .running-mark') // the circle's element, there while the item runs
      return {
        running: container.classList.contains('running'),
        circle: !!mark && getComputedStyle(mark, '::before').borderTopColor == blue,
        overlay: getComputedStyle(elem.querySelector('.loading')!).visibility,
        border: getComputedStyle(container).borderTopColor == blue,
      }
    }, [name, BLUE])
  const taskStore = await serverStore(`global_store_${taskId}`)
  expect([!!taskStore._agent?.state, !!(await serverStore(`global_store_${otherId}`))?._agent?.state], 'the premise: a task item and one that is none').toEqual([true, false])
  for (const name of [TASK, OTHER]) {
    await page.evaluate(name => void (location.hash = name), name)
    await expect.poll(() => page.evaluate(name => !!window._item(name, true)?.elem, name), { timeout: 30_000 }).toBe(true)
    await setRunning(name, true)
    await expect.poll(() => marked(name), { timeout: 15_000 }).toEqual({ running: true, circle: true, overlay: 'hidden', border: false })
    await setRunning(name, false)
    await expect.poll(() => marked(name), { timeout: 15_000 }).toEqual({ running: false, circle: false, overlay: 'hidden', border: false })
  }

  // (j) projects (the vault's notes/design/mind_project_agent.md 2.4, 2.7, 4): a PROJECT asking
  // sits in the MAIN list while agent-held (its work continues); the owner answers through the
  // main widget's delegate (a command document, the overlay to the delegated list) and takes it
  // back with /takeback (the overlay to the main list); a bound CHILD (its projection carries
  // `parent`) sits in the delegated list when owner-held under the project's standing /land
  // (2.9: without it a proposal is the owner's and sits in the main list), marked ↳ with its
  // parent in the tooltip, and the owner accepts its proposal by an unchanged re-delegation (the command
  // document carries the capture as the server holds it); a take-back on the child overlays it
  // into the main list at once
  await page.evaluate(name => void (location.hash = ''), '')
  const childId = (await savedId(page, OTHER))!
  // the bridge's projections acknowledge every command the earlier phases left pending (the
  // take-back of (d), the drag of (f)), so the overlay yields to the projection's placement
  const ackedFor = async (id: string) => Object.fromEntries((await commands()).filter(c => c.wrapper.item.task == id).map(c => [c.wrapper.item.id, 'consumed']))
  const asking = { held: 'agent', reason: 'question', epoch: 3, rev: 9, updated: Date.now(), worktree: null, phase: 'idle', acked: await ackedFor(taskId), project: true, stats: { turns: 4, workers: 2, active: 1, cost: 3.5, since: 1, unknown: 0, sub: 0, children: 1 } }
  await writeStore(STORE, `global_store_${taskId}`, { ...taskStore, _agent: { state: asking } })
  const childState = { held: 'owner', reason: 'proposal', epoch: 1, rev: 2, updated: Date.now(), worktree: null, phase: 'idle', acked: await ackedFor(childId), parent: taskId }
  await writeStore('e2e-child-store', `global_store_${childId}`, { _agent: { state: childState } })
  // the rows' texts (the delegated widget prefixes its age mark; the other todo carries the
  // marker phase (f) wrote): a row is matched by its text's end and its pending mark
  const PROJECT_ROW = `${TASK} #todo [delegated] ${SNIPPET}`
  const CHILD_ROW = `↳ ${OTHER} #todo [delegated] write the release note` // the prefix, then the label
  const has = (rows: Row[], text: string, pending: string | null) => rows.filter(r => r[0].endsWith(text) && r[1] == pending).length == 1 // exactly one row
  await expect.poll(async () => has((await lists(page)).main, PROJECT_ROW, null), { timeout: 30_000 }).toBe(true)
  // the vault's project design 2.9 (the owner, 2026-09-30): a child's PROPOSAL on a project
  // without a standing /land is the owner's to accept, so it sits in the MAIN list beside its
  // parent; under the project's standing /land (`standing_land` on the parent's projection)
  // the parent lands it, and the child stays in the delegated list
  await expect.poll(async () => has((await lists(page)).main, CHILD_ROW, null), { timeout: 30_000 }).toBe(true)
  await writeStore(STORE, `global_store_${taskId}`, { ...taskStore, _agent: { state: { ...asking, rev: 10, standing_land: true } } })
  await expect.poll(async () => has((await lists(page)).delegated, CHILD_ROW, null), { timeout: 30_000 }).toBe(true)
  const placed = await lists(page) // the other todos of the lane sit where they sat
  expect(placed.main.some(r => r[0].endsWith(CHILD_ROW))).toBe(false)
  expect(placed.delegated.some(r => r[0].endsWith(PROJECT_ROW))).toBe(false)
  const childRow = page.locator('.todoer-widget').nth(1).locator('.list > .list-item-container', { hasText: 'write the release note' })
  expect(await childRow.getAttribute('title')).toMatch(/^child of .*fix the cache/)
  const before = (await commands()).length
  expect(await command(page, `/delegate ${TASK}`)).toBeNull() // the answer: the overlay to delegated
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(before + 1)
  await expect.poll(async () => has((await lists(page)).delegated, PROJECT_ROW, 'delegate'), { timeout: 30_000 }).toBe(true)
  expect(await command(page, `/takeback ${TASK}`)).toBeNull() // reclaimed: the overlay to main
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(before + 2)
  await expect.poll(async () => has((await lists(page)).main, PROJECT_ROW, 'takeback'), { timeout: 30_000 }).toBe(true)
  // the child: an unchanged re-delegation is its acceptance (the capture as the server holds it)
  const childText = (await serverText(childId))!
  const known = new Set((await commands()).map(c => c.wrapper.item.id)) // the commands so far
  expect(await command(page, `/delegate ${OTHER}`)).toBeNull()
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(before + 3)
  const accept = (await commands()).find(c => !known.has(c.wrapper.item.id))! // the new one
  expect([accept.wrapper.item.task, accept.wrapper.item.kind]).toEqual([childId, 'delegate'])
  expect([accept.wrapper.item.epoch, accept.wrapper.item.body]).toEqual([1, childText])
  await expect.poll(async () => has((await lists(page)).delegated, CHILD_ROW, 'delegate'), { timeout: 30_000 }).toBe(true)
  expect(await command(page, `/takeback ${OTHER}`)).toBeNull() // the owner reclaims the child
  await expect.poll(async () => has((await lists(page)).main, CHILD_ROW, 'takeback'), { timeout: 30_000 }).toBe(true)
  expect(has((await lists(page)).main, PROJECT_ROW, 'takeback')).toBe(true)

  // (k) a row's click targets its item by NAME (the app's: the unique label when it has one,
  // else the id reference), since the app lists a target's children and navigates them under
  // its label only; the re-render its search causes marks the clicked row selected. The click
  // lands at the row's right end, past its text (a mark carries its own tag click)
  const mainRow = (text: string) => page.locator('.todoer-widget').first().locator('.list > .list-item-container', { hasText: text })
  const clickRow = async (text: string) => {
    const row = mainRow(text).locator('.list-item')
    const box = (await row.boundingBox())!
    await row.click({ position: { x: box.width - 8, y: box.height / 2 } })
  }
  const boxText = () => page.evaluate(() => (window as any).MindBox.get().trim())
  const selectedRow = () => page.evaluate(() => document.querySelector('.todoer-widget .list-item-container.selected')?.getAttribute('data-id') ?? null)
  await clickRow('write the release note')
  await expect.poll(boxText, { timeout: 10_000 }).toBe(OTHER) // the unique label
  await expect.poll(selectedRow, { timeout: 10_000 }).toBe(await page.evaluate(name => window._item(name, true)!.id, OTHER))
  // the todo's line is marked in the selected item for the edit that may follow (the row's class above comes
  // from the query alone and says nothing of the mark): the target is the item, the range its own line's
  await expect
    .poll(
      () =>
        page.evaluate(name => {
          const item = window._item(name, true)!
          const line = item.text.split('\n').find(line => line.includes('write the release note'))!
          const target = document.querySelector('.container.target')
          return target?.getAttribute('data-item-id') == item.id && target.getAttribute('data-selection') == `${item.text.indexOf(line)},${item.text.indexOf(line) + line.length}`
        }, OTHER),
      { message: "the todo's line is marked in the selected item", timeout: 10_000 },
    )
    .toBe(true)
  // two todos sharing the label #todo have no unique label: the id reference
  for (const text of ['#todo twin one', '#todo twin two']) await page.evaluate(text => void window._create(text), text)
  await expect(mainRow('twin one')).toHaveCount(1)
  await expect(mainRow('twin two')).toHaveCount(1)
  // unnamed, their rows start with the snippet itself (the labeled rows above start with the label)
  expect((await lists(page)).main.map(r => r[0]).filter(t => t.includes('twin')).sort()).toEqual(['#todo twin one', '#todo twin two'])
  const twinId = (await mainRow('twin one').getAttribute('data-id'))!
  // selected by the SAVED id, the one an address resolves after a reload (the row's own id is the tab's)
  await expect.poll(() => page.evaluate(id => (window._item(id, true)!.saved_id as unknown as string | null) ?? null, twinId), { timeout: 30_000 }).toBeTruthy()
  const twinSaved = await page.evaluate(id => window._item(id, true)!.saved_id as unknown as string, twinId)
  expect(twinSaved, "the tab's own id of an item created in it is not its saved id").not.toBe(twinId)
  await clickRow('twin one')
  await expect.poll(boxText, { timeout: 10_000 }).toBe('id:' + twinSaved)
  await expect.poll(selectedRow, { timeout: 10_000 }).toBe(twinId)
  // the row of the todo already selected edits it where it is, its line selected, and leaves the box as it
  // is (set to the item's name, the box held the tab's own id again)
  await clickRow('twin one')
  const editing = () =>
    page.evaluate(() => {
      const box = document.activeElement as HTMLTextAreaElement
      return box?.tagName == 'TEXTAREA' && box.id != 'textarea-mindbox' ? { value: box.value, start: box.selectionStart, end: box.selectionEnd } : null
    })
  await expect.poll(editing, { message: "the todo's editor opens with its line selected", timeout: 10_000 }).toEqual({ value: '#todo twin one', start: 0, end: '#todo twin one'.length })
  expect(await boxText(), 'the box still holds the saved id').toBe('id:' + twinSaved)
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(id => (window._item(id, true) as any).editing as boolean, twinId), { message: 'the edit is closed again', timeout: 10_000 }).toBe(false)
  expect(await boxText()).toBe('id:' + twinSaved)
  // the same row clicked while ANOTHER name sits typed in the box and not yet applied (inside the box's
  // debounce): the page still shows this todo as its target, so the row edits it, and the pending name must
  // not take the target over while the edit waits for the page (the editor opened was the other item's, or
  // the box went over to it afterwards). The typed input and the row's click come in one call, the click
  // after the page has rendered the typed text, as a real click after a real key always does (delivered
  // before that DOM update, the click's select can leave the textarea showing the typed name), and well
  // inside the debounce
  const shownEntry = await page.evaluate(() => history.state.index as number)
  const turn = await page.evaluate(
    async ([id, other]) => {
      const w = window as any
      const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      box.focus({ preventScroll: true })
      box.value = other
      box.dispatchEvent(new Event('input'))
      const typed = w._editor_change_pending as boolean
      await new Promise(resolve => setTimeout(resolve))
      const pending = w._editor_change_pending as boolean
      ;(document.querySelector(`.todoer-widget .list > .list-item-container[data-id="${id}"] .list-item`) as HTMLElement).click()
      return { typed, pending, still: w._editor_change_pending as boolean }
    },
    [twinId, OTHER],
  )
  expect(turn, "the other name was still pending at the click, and the row's click superseded it for its own todo").toEqual({ typed: true, pending: true, still: false })
  await expect.poll(editing, { message: "the editor opened is the clicked todo's", timeout: 10_000 }).toEqual({ value: '#todo twin one', start: 0, end: '#todo twin one'.length })
  // past the debounce's time, the pending name has had its turn: nothing took the target over
  await page.waitForTimeout(700)
  expect([await boxText(), await editing(), await page.evaluate(() => history.state.index as number)], 'the box, the editor and the entry stay with the clicked todo').toEqual(['id:' + twinSaved, { value: '#todo twin one', start: 0, end: '#todo twin one'.length }, shownEntry])
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(id => (window._item(id, true) as any).editing as boolean, twinId), { timeout: 10_000 }).toBe(false)

  // (l) the child-customization hook (the vault's notes/design/mind_task_chat.md, section 3):
  // the todoer's _init (an #_init item, run at load) defines window._customize_child, and the
  // app calls it after it allocates a child's label (Ctrl+Enter on a unique label): a child of
  // a #todo becomes a TASK CHAT, its label retained, the route tag and #_autodep beside it and
  // the first user turn on the next line, the caret collapsed at the end so the first typed
  // character extends the turn; the tag applies to the chat's DESCENDANTS (2026-09-27): the
  // chat itself does not depend on the todo, while a child of it depends on it by label prefix
  // and continues it with no hidden tag; any other parent's child stays as the app makes it
  // (the suffix selected)
  expect(await page.evaluate(() => typeof (window as any)._customize_child)).toBe('function')
  const editorState = () =>
    page.evaluate(() => {
      const box = document.activeElement as HTMLTextAreaElement
      return box?.tagName == 'TEXTAREA' ? { value: box.value, start: box.selectionStart, end: box.selectionEnd } : null
    })
  const createChild = async (parent: string) => {
    await userSet(page, parent, { scroll: true })
    await page.waitForTimeout(500)
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
    await page.keyboard.press('Control+Enter')
    await expect.poll(async () => (await editorState())?.value?.startsWith(parent + '/') ?? false, { timeout: 10_000 }).toBe(true)
    return (await editorState())!
  }
  // the chat lineage the hook reads is the app's own: the #chat root (autodep, so its
  // label-prefixed items depend on it) and the #chat/vault route item, as an account has them
  for (const text of ['#chat #_autodep\nconfig', '#chat/vault #_agent/vault\ncommand item']) await page.evaluate(text => void window._create(text), text)
  await expect.poll(() => savedId(page, '#chat/vault'), { timeout: 30_000 }).toBeTruthy()
  const CHATTY = '#e2e_chatty'
  await page.evaluate(text => void window._create(text), `${CHATTY}\n#todo chat about me`)
  await expect.poll(() => savedId(page, CHATTY), { timeout: 30_000 }).toBeTruthy()
  const chat = await createChild(CHATTY)
  const CHAT_TEXT = `${CHATTY}/0 #_chat/vault #_autodep\n<<user>> `
  expect(chat).toEqual({ value: CHAT_TEXT, start: CHAT_TEXT.length, end: CHAT_TEXT.length })
  await page.keyboard.type('how is it going?')
  expect((await editorState())!.value, 'the first typed character extends the turn').toBe(CHAT_TEXT + 'how is it going?')
  await page.keyboard.press('Control+Enter') // done: saved as the task's chat (no bridge in this lane: it stays pending)
  await expect.poll(() => savedId(page, `${CHATTY}/0`), { timeout: 30_000 }).toBeTruthy()
  const box = () => page.evaluate(() => (window as any).MindBox.get())
  await expect.poll(box, { message: 'the box navigates to the new chat (its label, then a space)' }).toBe(`${CHATTY}/0 `)
  // the carrier adopts no parent: the chat's dependencies are the route item's closure, never
  // the todo (the ids as this tab holds them: an item created here keeps its temporary id
  // until the tab reloads, so the comparison is by the tab's own item handles)
  const idOf = (name: string) => page.evaluate(n => (window._item(n, true) as any)?.id ?? null, name)
  const chatDeps = await page.evaluate(name => (window._item(name, true) as any)?.dependencies ?? null, `${CHATTY}/0`)
  expect(chatDeps, 'the chat depends on the route item').toContain(await idOf('#chat/vault'))
  expect(chatDeps, 'the chat does not depend on the todo').not.toContain(await idOf(CHATTY))
  const continued = await createChild(`${CHATTY}/0`)
  const CONTINUED = `${CHATTY}/0/0\n<<user>> `
  const shapes = await page.evaluate(name => {
    const p = window._item(name, true) as any
    return JSON.stringify({ tags: p?.tags, hidden: p?.tags_hidden, label: p?.label, text: p?.text, deps: p?.dependencies })
  }, `${CHATTY}/0`)
  expect(continued, shapes).toEqual({ value: CONTINUED, start: CONTINUED.length, end: CONTINUED.length })
  // saved: the box navigates to the continuation too, although its label is followed by a
  // newline, not a space (the owner, 2026-09-27: the box was cleared, and the child's ancestry
  // with it)
  await page.keyboard.type('deeper')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => savedId(page, `${CHATTY}/0/0`), { timeout: 30_000 }).toBeTruthy()
  await expect.poll(box, { message: 'the box navigates to the continuation' }).toBe(`${CHATTY}/0/0 `)
  // a renamed node (parent tags, 2026-09-28: `#p/plan-b #_p/0/0` sits under #p/0/0 in the tree)
  // continues with the turn alone too: the hook's ancestor walk reaches the carrier through the
  // tag parent, and the app makes the child adopt the renamed node
  await page.evaluate(text => void window._create(text), `${CHATTY}/plan-b #_${CHATTY.slice(1)}/0/0\n<<user>> plan b`)
  await expect.poll(() => savedId(page, `${CHATTY}/plan-b`), { timeout: 30_000 }).toBeTruthy()
  const renamed = await createChild(`${CHATTY}/plan-b`)
  const RENAMED = `${CHATTY}/plan-b/0\n<<user>> `
  expect(renamed).toEqual({ value: RENAMED, start: RENAMED.length, end: RENAMED.length })
  await page.keyboard.type('under the rename')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => savedId(page, `${CHATTY}/plan-b/0`), { timeout: 30_000 }).toBeTruthy()
  const renamedDeps = await page.evaluate(name => (window._item(name, true) as any)?.dependencies ?? null, `${CHATTY}/plan-b/0`)
  expect(renamedDeps.slice(-3), 'the chain through the renamed node').toEqual([await idOf(`${CHATTY}/0`), await idOf(`${CHATTY}/0/0`), await idOf(`${CHATTY}/plan-b`)])
  const PLAIN = '#e2e_plain'
  await page.evaluate(text => void window._create(text), `${PLAIN}\nnot a todo, not a chat`)
  await expect.poll(() => savedId(page, PLAIN), { timeout: 30_000 }).toBeTruthy()
  const plainChild = await createChild(PLAIN)
  expect(plainChild, 'the suffix selected, as the app makes it').toEqual({ value: `${PLAIN}/0 `, start: PLAIN.length + 1, end: PLAIN.length + 3 })
  await page.keyboard.press('Escape')
  // an item BENEATH the task chat by label prefix alone (no tag, no user turn): the chat carries
  // #_autodep, so the app makes the chat its first dependency (a descendant adopts its parent)
  // and it is a chat item by the dependency rule; its child continues it with no hidden tag
  // (the real dependency behavior the hook reads)
  const UNDER = `${CHATTY}/0/plain`
  await page.evaluate(text => void window._create(text), `${UNDER}\nnotes under the chat`)
  await expect.poll(() => savedId(page, UNDER), { timeout: 30_000 }).toBeTruthy()
  const underDeps = await page.evaluate(name => (window._item(name, true) as any)?.dependencies ?? null, UNDER)
  expect(underDeps, 'the descendant depends on the chat').toContain(await idOf(`${CHATTY}/0`))
  const underChild = await createChild(UNDER)
  const UNDER_CHILD = `${UNDER}/0\n<<user>> `
  expect(underChild, 'a chat by dependency: continued').toEqual({ value: UNDER_CHILD, start: UNDER_CHILD.length, end: UNDER_CHILD.length })
  await page.keyboard.press('Escape')
  // a chat made BEFORE the tag (no #_autodep): its child needs the explicit parent tag
  const LEGACY = '#e2e_legacy'
  await page.evaluate(text => void window._create(text), `${LEGACY}\n#todo an older todo`)
  await expect.poll(() => savedId(page, LEGACY), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(text => void window._create(text), `${LEGACY}/0 #_chat/vault\n<<user>> made before the tag`)
  await expect.poll(() => savedId(page, `${LEGACY}/0`), { timeout: 30_000 }).toBeTruthy()
  const legacyChild = await createChild(`${LEGACY}/0`)
  const LEGACY_CHILD = `${LEGACY}/0/0 #_${LEGACY.slice(1)}/0\n<<user>> `
  expect(legacyChild, 'no autodep ancestor: the parent named').toEqual({ value: LEGACY_CHILD, start: LEGACY_CHILD.length, end: LEGACY_CHILD.length })
  await page.keyboard.press('Escape')
  // an UNNAMED todo, which its row selects by id as in (k) (the owner, 2026-11-16: a chat under such a
  // todo): the create key first asks for the todo's name, the next free `thread_<n>` offered (index.svelte,
  // onEditorDone; the dialog's own rows are in editor2.spec.ts); accepted, the label stands before the
  // #todo tag, as the owner writes it by hand, and the child is the task chat a named todo gets from the hook
  await userSet(page, 'id:' + twinId, { scroll: true })
  await page.waitForTimeout(500)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('Shift+Enter')
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve))) // an answer by that key would have landed (the Modal answers from a timer)
  await expect(page.locator('#modal-input')).toHaveValue('thread_0', { timeout: 10_000 })
  await expect(page.locator('#modal-input')).toBeFocused()
  await page.keyboard.press('Enter')
  const THREAD = '#thread_0/0 #_chat/vault #_autodep\n<<user>> '
  await expect.poll(editorState, { timeout: 10_000 }).toEqual({ value: THREAD, start: THREAD.length, end: THREAD.length })
  expect(await read(page, '#thread_0')).toBe('#thread_0 #todo twin one')
  await page.keyboard.press('Escape')
  // with text selected on the page, the quote is seeded only into the open editor draft after the
  // hook's turn marker (caret collapsed after it): the first acknowledged document holds the turn
  // marker alone, and after saving the stored turn holds the marker, quote and typed text
  await userSet(page, CHATTY, { scroll: true })
  await expect.poll(() => page.evaluate(n => !!window._item(n, true)?.elem?.querySelector('.content'), CHATTY), { timeout: 15_000 }).toBe(true)
  // the selection and the key in ONE turn of the page (the key dispatched where a real press with no focus
  // arrives, on the body): the list is rebuilt once more some tens of ms after the box's change, and a real
  // press, 3 to 35 ms after the selection, once came after that rebuild and found the selection gone with its
  // text node (a full gate of 2026-11-24: the chat opened without the quote)
  const selectedForChat = await asUser(
    page,
    n => {
      const root = window._item(n, true)!.elem!
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const val = walker.currentNode.nodeValue ?? ''
        const at = val.indexOf('chat about me')
        if (at < 0) continue
        ;(document.activeElement as HTMLElement | null)?.blur()
        window.getSelection()!.setBaseAndExtent(walker.currentNode, at, walker.currentNode, at + 'chat about me'.length)
        const selected = [window.getSelection()!.type, window.getSelection()!.isCollapsed, window.getSelection()!.toString()]
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
        return selected
      }
      return null
    },
    CHATTY,
  )
  expect(selectedForChat, 'premise: todo text was selected when Shift+Enter created the task chat').toEqual(['Range', false, 'chat about me'])
  const QUOTED_CHAT_SCAFFOLD = `${CHATTY}/1 #_chat/vault #_autodep\n<<user>> `
  const QUOTED_CHAT = `${QUOTED_CHAT_SCAFFOLD}"chat about me" `
  await expect.poll(editorState, { timeout: 10_000 }).toEqual({ value: QUOTED_CHAT, start: QUOTED_CHAT.length, end: QUOTED_CHAT.length })
  let chatSavedId = ''
  await expect
    .poll(
      async () => {
        const st = await page.evaluate(label => {
          const it = (window.__items as any[]).find(i => i.labelText == label)
          return it ? { savedId: (it.savedId ?? '') as string, saving: !!it.saving, editing: !!it.editing } : null
        }, `${CHATTY}/1`)
        if (st?.savedId && !st.saving) chatSavedId = st.savedId
        return !!st?.savedId && !st.saving && st.editing
      },
      { message: 'chat child initial create write acknowledged while editor is open', timeout: 30_000 }
    )
    .toBe(true)
  expect(await serverText(chatSavedId), 'first acknowledged document holds the turn marker scaffold alone').toBe(QUOTED_CHAT_SCAFFOLD)
  await page.keyboard.type('?')
  expect((await editorState())!.value, 'typing follows the quote after the hook text').toBe(QUOTED_CHAT + '?')
  await page.keyboard.press('Shift+Enter')
  await expect.poll(editorState, { timeout: 10_000 }).toBeNull()
  await expect.poll(() => serverText(chatSavedId), { timeout: 30_000 }).toBe(QUOTED_CHAT + '?')
  await expect
    .poll(() => page.evaluate(label => !(window.__items as any[]).find(i => i.labelText == label)?.saving, `${CHATTY}/1`), { timeout: 30_000 })
    .toBe(true)

  // CHAT CHILDREN (vault design mind_chat_children): under the INSTALLED chat template a chat's
  // reply tags its children with `#/name` and the children bind to the chat by autodep; the
  // stub #chat root above is replaced by the real template first (one #chat label)
  await firestore().collection('items').doc((await savedId(page, '#chat'))!).delete()
  await expect.poll(() => savedId(page, '#chat'), { timeout: 30_000 }).toBeNull()
  expect(await install(page, 'chat'), '/_install chat').toBeNull()
  await expect.poll(() => savedId(page, '#chat'), { timeout: 60_000 }).toBeTruthy()
  const CC = '#e2e_cc'
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  await page.evaluate(text => void window._create(text), `${CC}\n#todo structure me`)
  // the chat depends on the template root directly (#_chat): the lane's #chat/vault stub carries
  // #_agent/vault, which the lane has not, and a macro-evaluating read refuses an item with a
  // missing dependency, transitive ones included
  await page.evaluate(text => void window._create(text), `${CC}/0 #_chat #_autodep\n<<user>> what now?\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert('Two parts: #/alpha and #/beta.')}`)
  await page.evaluate(text => void window._create(text), `${CC}/0/alpha\n<<agent('vault/default · created in run ab12cd34')>>\n${inert('Alpha body')}`)
  for (const name of [CC, `${CC}/0`, `${CC}/0/alpha`]) await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
  // an item is shown before its element is read: after a _create the page holds only the item
  // created last, so another item's element is absent until a re-render happens to include it,
  // which the reads below raced (issues/The Delegation Row Reads A Null Elem.md)
  const shown = async (name: string) => {
    await userSet(page, name, { scroll: true })
    await expect.poll(() => page.evaluate(n => !!window._item(n, true)?.elem, name), { timeout: 30_000 }).toBe(true)
  }
  await shown(`${CC}/0`)
  const ccMarks = () =>
    page.evaluate(
      // the element can be absent at a tick right after the creations (issues/The Delegation Row Reads A Null Elem.md, 2026-10-05): the poll waits for it instead of failing on the throw
      n => [...(window._item(n, true)?.elem?.querySelectorAll('.vault-result mark[data-tag]') ?? [])].map(m => ({ tag: m.getAttribute('data-tag'), missing: m.classList.contains('missing'), dangling: m.classList.contains('dangling') })),
      `${CC}/0`
    )
  await expect.poll(ccMarks, { timeout: 15_000 }).toEqual([
    { tag: '#e2e_cc/0/alpha', missing: false, dangling: false },
    { tag: '#e2e_cc/0/beta', missing: false, dangling: true }, // a child not yet created: dangling, not missing (2026-10-03)
  ])
  // the delimiters expanded under the template (the message headers, not error spans), with the
  // boundary reset before the reply's header leaving no text behind
  const headers = await page.evaluate(n => {
    const e = window._item(n, true)!.elem!
    return { user: !!e.querySelector('.message.user'), agent: !!e.querySelector('.message.agent'), errors: e.querySelectorAll('.macro-error').length, text: (e.querySelector('.content') as HTMLElement | null)?.innerText ?? '' }
  }, `${CC}/0`)
  expect(headers).toMatchObject({ user: true, agent: true, errors: 0 })
  expect(headers.text).not.toMatch(/\?> \]\]>|<\/noscript>/)
  // the EXPANDED state carries the child tags (review 2): the chat's delimiters evaluate under the
  // installed template, a macro-evaluating read builds `item.expanded` from the expanded text (the
  // raw bodies and boundaries travel into that pass: item.inertBodies, item.childTagMarkers), and
  // its visible tags, the ones search prefers, hold them; the state lives on the app's own item
  // record (window.__items), not the handle
  const expanded = await page.evaluate(n => {
    const item = window._item(n, true) as any
    const record = () => (window as any).__items.find((i: any) => i.label == n)
    return Promise.resolve(item.read('', { eval_macros: true })).then(() => [...(record()?.expanded?.item?.tagsVisible ?? [])].sort())
  }, `${CC}/0`)
  expect(expanded, 'the expanded pass indexed the child tags').toEqual(['#e2e_cc/0', '#e2e_cc/0/alpha', '#e2e_cc/0/beta'])
  // the child depends on the chat (adopted through the chat's #_autodep), the chat not on the child
  const depsOf = (name: string) => page.evaluate(n => (window._item(n, true) as any)?.dependencies ?? null, name)
  expect(await depsOf(`${CC}/0/alpha`), 'the child adopts the chat').toContain(await idOf(`${CC}/0`))
  expect(await depsOf(`${CC}/0`), 'the chat gains no edge from its reply').not.toContain(await idOf(`${CC}/0/alpha`))
  // the child renders its agent message under the template: the body in its frame, the
  // attribution shown (no publisher footer: a run id and duration it does not have)
  await shown(`${CC}/0/alpha`)
  const alphaShape = await page.evaluate(n => {
    const e = window._item(n, true)!.elem!
    return { body: e.querySelector('.vault-result')?.textContent ?? '', attribution: e.textContent?.includes('created in run ab12cd34') ?? false }
  }, `${CC}/0/alpha`)
  expect(alphaShape.body).toContain('Alpha body')
  expect(alphaShape.attribution, 'the attribution is displayed').toBe(true)
  // a mark click in the chat navigates to the child
  await shown(`${CC}/0`)
  const ccElem = await page.evaluate(n => window._item(n, true)!.elem!.id, `${CC}/0`)
  await page.locator(`[id="${ccElem}"] .vault-result mark[data-tag="#e2e_cc/0/alpha"]`).click()
  await expect.poll(box).toBe(`${CC}/0/alpha `)

  // DESKTOP NOTIFICATIONS (vault design mind_task_agents 2.7, 2026-10-03): a projection change
  // into a state waiting on the owner, in the main list, shows one notification from the device's
  // elected window (this one: the election claimed in localStorage); its click targets the item as
  // the row's click does. The browser's Notification is replaced by a recorder (headless Chromium
  // shows nothing; the permission and the ask are the recorder's), installed before /notify on
  const NOTIFY = '#e2e_notify'
  await page.evaluate(text => void window._create(text), `${NOTIFY}\n#todo answer the agent\nsome context`)
  await expect.poll(() => savedId(page, NOTIFY), { timeout: 30_000 }).toBeTruthy()
  const notifyId = (await savedId(page, NOTIFY))!
  await page.evaluate(() => {
    const shown: any[] = ((window as any).__notified = [])
    class Recorder {
      static permission = 'default'
      static async requestPermission() {
        Recorder.permission = 'granted'
        return 'granted'
      }
      closed = false
      onclick: (() => void) | null = null
      constructor(public title: string, public options: any) {
        shown.push(this)
      }
      close() {
        this.closed = true
      }
    }
    ;(window as any).Notification = Recorder
  })
  expect(await command(page, '/notify on')).toBeNull()
  await expect.poll(() => dialogs[dialogs.length - 1], { timeout: 10_000 }).toBe('notifications: on for question, blocked, proposal, budget, done, reply, item; this device: granted')
  const NOTIFY_STORE = 'e2e-notify-store'
  const notifyState = (reason: string, epoch: number, rev: number, more: Record<string, unknown> = {}) => ({ _agent: { state: { held: 'owner', reason, epoch, rev, updated: Date.now(), worktree: null, phase: 'idle', acked: {}, ...more } } })
  const notified = () => page.evaluate(() => ((window as any).__notified as any[]).map(n => ({ title: n.title, tag: n.options.tag, body: n.options.body, requireInteraction: n.options.requireInteraction, closed: n.closed })))
  // the hand-back of a question (the bridge's projection write behind the app)
  await writeStore(NOTIFY_STORE, `global_store_${notifyId}`, notifyState('question', 1, 1))
  await expect.poll(notified, { timeout: 30_000 }).toEqual([{ title: '[question] answer the agent some context', tag: `todoer:${notifyId}`, body: NOTIFY, requireInteraction: true, closed: false }])
  expect(await page.evaluate(() => [JSON.parse(localStorage.getItem('mindpage_todoer_notifier')!).id, (window._item('#todoer') as any).store.notifier_id]), 'this window holds the election').toEqual([await page.evaluate(() => (window._item('#todoer') as any).store.notifier_id), expect.any(String)])
  // a stats refresh of the same state and a reason not enabled (`taken`, the owner's own take-back)
  // notify nothing; a blocked hand-back under a new epoch does: each write awaited on the item's
  // store before the next
  const applied = (rev: number) => expect.poll(() => page.evaluate(id => (window._item('id:' + id, true) as any)?._global_store?._agent?.state?.rev, notifyId), { timeout: 30_000 }).toBe(rev)
  await writeStore(NOTIFY_STORE, `global_store_${notifyId}`, notifyState('question', 1, 2, { stats: { workers: 1, cost: 0.5 } }))
  await applied(2)
  await writeStore(NOTIFY_STORE, `global_store_${notifyId}`, notifyState('taken', 2, 3))
  await applied(3)
  expect((await notified()).map(n => n.title), 'a stats refresh and a taken hand-back notify nothing').toEqual(['[question] answer the agent some context'])
  await writeStore(NOTIFY_STORE, `global_store_${notifyId}`, notifyState('blocked', 3, 4))
  await expect.poll(async () => (await notified()).map(n => n.title), { timeout: 30_000 }).toEqual(['[question] answer the agent some context', '[blocked] answer the agent some context'])
  // the minute scan (review 0, B1): a delivery the app announces to no hook (this tab owed a save
  // for that store) leaves the record the tab last saw behind the applied state; the scan,
  // run here directly (the task's minute is not waited for), notices it over the real items
  await page.evaluate(id => void ((window._item('#todoer') as any).store.notify_seen[window._item('id:' + id, true)!.id] = 'owner:taken:2:|main'), notifyId)
  expect(await page.evaluate(() => (window._item('#todoer') as any).eval('_scan_notify()'))).toBeGreaterThanOrEqual(1)
  await expect.poll(async () => (await notified()).map(n => n.title), { timeout: 10_000 }).toEqual(['[question] answer the agent some context', '[blocked] answer the agent some context', '[blocked] answer the agent some context'])
  // the click: the notification closed, the item targeted by its name (its todo line selected)
  await userSet(page, '')
  await page.evaluate(() => void (window as any).__notified.at(-1).onclick())
  await expect.poll(box, { timeout: 10_000 }).toMatch(new RegExp(`^${NOTIFY} ?$`))
  expect((await notified()).at(-1)!.closed, 'the clicked notification is closed').toBe(true)
  // off: a hand-back notifies nothing; on again: the next one does (the one skipped stays skipped)
  expect(await command(page, '/notify off')).toBeNull()
  await expect.poll(() => dialogs[dialogs.length - 1], { timeout: 10_000 }).toBe('notifications: off')
  await writeStore(NOTIFY_STORE, `global_store_${notifyId}`, notifyState('question', 4, 5))
  await applied(5)
  expect(await command(page, '/notify on')).toBeNull()
  await expect.poll(() => dialogs[dialogs.length - 1], { timeout: 10_000 }).toBe('notifications: on for question, blocked, proposal, budget, done, reply, item; this device: granted')
  await writeStore(NOTIFY_STORE, `global_store_${notifyId}`, notifyState('proposal', 5, 6))
  await expect.poll(async () => (await notified()).map(n => n.title), { timeout: 30_000 }).toEqual(['[question] answer the agent some context', '[blocked] answer the agent some context', '[blocked] answer the agent some context', '[proposal] answer the agent some context'])
  // a project's repeated check-in (2026-10-03, round 3): the bridge counts the resurfacings it
  // publishes (`surfaced`), so a second question under the same epoch and reason notifies again
  await writeStore(NOTIFY_STORE, `global_store_${notifyId}`, notifyState('question', 5, 7, { held: 'agent', project: true, surfaced: 1 }))
  await expect.poll(async () => (await notified()).length, { timeout: 30_000 }).toBe(5)
  await writeStore(NOTIFY_STORE, `global_store_${notifyId}`, notifyState('question', 5, 8, { held: 'agent', project: true, surfaced: 2 }))
  await expect.poll(async () => (await notified()).map(n => n.title).slice(-2), { timeout: 30_000 }).toEqual(['[question] answer the agent some context', '[question] answer the agent some context'])
  // A BRIDGE REPLY on a task chat (the owner's ask of 2026-10-04): the chat of phase (l) gains a
  // reply through the bridge's text write (the publisher footer and the inert body); the
  // notification carries the chat's label and the reply's first line, its click targets the chat
  const chatId = (await savedId(page, `${CHATTY}/0`))!
  const repliesBefore = (await notified()).length
  await rewriteText(chatId, text => `${text.replace(/\s*$/, '')}\n<<agent('vault/default · run ab12cd34 · 2s')>>\n<!--inert-->\nHere is the answer you asked for.\nmore below\n<!--/inert-->`)
  await expect.poll(async () => (await notified()).length, { timeout: 30_000 }).toBe(repliesBefore + 1)
  expect((await notified()).at(-1)).toMatchObject({ title: `[reply] ${CHATTY}/0`, body: 'Here is the answer you asked for.', tag: `todoer:${chatId}`, requireInteraction: true, closed: false })
  await userSet(page, '')
  await page.evaluate(() => void (window as any).__notified.at(-1).onclick())
  await expect.poll(box, { timeout: 10_000 }).toMatch(new RegExp(`^${CHATTY}/0 ?$`))
  // AN AGENT ITEM WRITE STAMP (vault design mind_item_edit section 9): an entry in `#todoer`'s
  // own store matching a non-todo item's hash gives one alert with its title and visible body
  // (HTML comment skipped); delivering the same entry again gives none
  const STAMPED = '#e2e_stamped'
  await page.evaluate(text => void window._create(text), `${STAMPED}\n<!-- internal -->\nUpdated by the watcher.\nMore.`)
  await expect.poll(() => savedId(page, STAMPED), { timeout: 30_000 }).toBeTruthy()
  const stampedId = (await savedId(page, STAMPED))!
  const stampedHash = await page.evaluate(name => String((window._item(name, true) as any).hash), STAMPED)
  const todoerId = (await savedId(page, '#todoer'))!
  const todoerStoreName = `global_store_${todoerId}`
  await expect
    .poll(async () => !!(await serverStore(todoerStoreName))?.notify?.reasons?.includes('item'), { timeout: 30_000 })
    .toBe(true)
  await expect
    .poll(() => page.evaluate(() => !(window._item('#todoer', true) as any)?.saving_global_store), { timeout: 30_000 })
    .toBe(true)
  const todoerDoc = (await storeDocId(todoerStoreName))!
  const todoerStore = await serverStore(todoerStoreName)
  const stampAt = Date.now()
  const stampsBefore = (await notified()).length
  await writeStore(todoerDoc, todoerStoreName, {
    ...todoerStore,
    _agent: { ...todoerStore?._agent, wrote: { [stampedId]: { by: 'watcher', at: stampAt, hash: stampedHash } } },
  })
  await expect.poll(async () => (await notified()).length, { timeout: 30_000 }).toBe(stampsBefore + 1)
  expect((await notified()).at(-1)).toMatchObject({
    title: `[item] ${STAMPED}`,
    body: 'Updated by the watcher.',
    tag: `todoer:${stampedId}`,
    requireInteraction: true,
    closed: false,
  })
  await writeStore(todoerDoc, todoerStoreName, {
    ...todoerStore,
    _agent: { ...todoerStore?._agent, wrote: { [stampedId]: { by: 'watcher', at: stampAt, hash: stampedHash } } },
    _e2e_touch: 1,
  })
  await expect
    .poll(() => page.evaluate(() => (window._item('#todoer', true) as any)?._global_store?._e2e_touch), { timeout: 30_000 })
    .toBe(1)
  expect((await notified()).length, 'the same entry delivered again notifies nothing').toBe(stampsBefore + 1)
  // THE SNOOZE DIALOG'S BOX (2026-10-21): the drop on the snooze bin opens the dialog with its
  // "notify on unsnooze" box unchecked (no hint: this device's permission is granted); checked,
  // a duration's click writes the flag beside the snooze time on the todo's own store; the time
  // moved into the past, the todoer's own sweep (its welcome task run again, the notifier's
  // baseline taken first) unsnoozes it and the notifier shows `[unsnoozed]` with the row's text,
  // kept on screen, its click targeting the todo
  await page.evaluate(() => {
    ;(window as any).MindBox.set('')
    document.body.scrollTop = 0
  })
  await mainList.locator('> .list-item-container', { hasText: 'answer the agent' }).scrollIntoViewIfNeeded() // the widget sits below the fold by now
  await grab('answer the agent')
  // a render landing on the chosen row before the drag's first move is deferred like one during
  // the drag (2026-10-28): the pinned item's re-render after the query change above destroyed the
  // list's Sortable about 160 ms after the grab, which released the press without events, and the
  // drag then found nothing (the lane's failure in most full gates since 2026-10-23); the row stays
  // chosen on its list, both widgets' renders pending, run at the release
  await page.evaluate(() => (window._item('#todoer') as any).eval('_rerender_todoer_widgets()'))
  const pressFacts = () =>
    page.evaluate(() => ({
      chosen: document.querySelectorAll('.todoer-widget .list .sortable-chosen').length,
      dragging: document.querySelectorAll('.todoer-widget.dragging').length,
      pending: [...document.querySelectorAll('.todoer-widget')].filter(w => (w as any)._renderPendingDragging).length,
    }))
  expect(await pressFacts(), 'the render injected on the chosen row found the press and deferred both widgets').toEqual({ chosen: 1, dragging: 0, pending: 2 })
  {
    const row = await rowBox('answer the agent')
    await dragTo(
      { x: row.x + 52, y: row.y + row.height / 2 },
      async () => {
        const bin = (await page.locator('.todoer-widget').first().locator('.snooze.bin').boundingBox())!
        return { x: bin.x + bin.width / 2, y: bin.y + bin.height / 2 }
      },
      { inject: false }
    )
  }
  const snoozeDialog = page.locator('.snooze-modal')
  await expect(snoozeDialog).toBeVisible({ timeout: 10_000 })
  // the deferred renders' marks cleared at the release; that the renders RAN is the todoer node table's
  // row (tests/todoer_test.js: _run_deferred_renders schedules each), since here another render rebuilds
  // both widgets' lists before the dialog's answer anyway (a list-identity witness passed with the
  // scheduled render removed, lane_races round 2)
  await expect.poll(pressFacts, { timeout: 10_000 }).toEqual({ chosen: 0, dragging: 0, pending: 0 })
  const notifyBox = snoozeDialog.locator('.notify input[type=checkbox]')
  await expect(notifyBox).toBeVisible()
  await expect(notifyBox).not.toBeChecked()
  await expect(snoozeDialog.locator('.notify label')).toHaveText('notify on unsnooze')
  await expect(snoozeDialog.locator('.notify .hint')).toBeHidden()
  await notifyBox.check()
  await snoozeDialog.locator('.button', { hasText: /^3h$/ }).click()
  await expect(snoozeDialog).toBeHidden({ timeout: 10_000 })
  const snoozeStore = async () => (await serverStore(`global_store_${notifyId}`))?._todoer ?? null
  await expect.poll(async () => { const t = await snoozeStore(); return t && { later: t.snoozed > Date.now() + 2 * 3_600_000, notify: t.notify ?? null } }, { timeout: 30_000 }).toEqual({ later: true, notify: true })
  await expect.poll(async () => (await lists(page)).main.some(r => r[0].includes('answer the agent')), { timeout: 30_000 }).toBe(false)
  const beforeSweep = (await notified()).length // counted first: the page's own minute sweep may unsnooze it before ours (either notifies once)
  // the snooze's time moved into the past (this tab's write: its hook records the new time)
  await page.evaluate(id => void ((window._item('id:' + id, true) as any).global_store._todoer.snoozed = Date.now() - 1000), notifyId)
  await expect.poll(async () => ((await snoozeStore())?.snoozed ?? 0) < Date.now(), { timeout: 30_000 }).toBe(true)
  expect(await page.evaluate(() => (window as any)._primary), 'this tab is the primary instance (the only one that sweeps)').toBe(true)
  await page.evaluate(() => (window._item('#todoer') as any).eval('_on_welcome()'))
  await expect.poll(async () => (await notified()).length, { timeout: 30_000 }).toBe(beforeSweep + 1)
  expect((await notified()).at(-1)).toEqual({ title: '[unsnoozed] answer the agent some context', tag: `todoer:${notifyId}`, body: NOTIFY, requireInteraction: true, closed: false })
  await expect.poll(async () => { const t = await snoozeStore(); return t && { snoozed: t.snoozed, notify: t.notify ?? null } }, { timeout: 30_000 }).toEqual({ snoozed: 0, notify: true })
  await expect.poll(async () => (await lists(page)).main.some(r => r[0].includes('answer the agent')), { timeout: 30_000 }).toBe(true)
  await page.waitForTimeout(1500) // a later observation (a render, the hook of the list's save) adds nothing
  expect((await notified()).length, 'one notification for the unsnooze').toBe(beforeSweep + 1)
  await userSet(page, '')
  await page.evaluate(() => void (window as any).__notified.at(-1).onclick())
  await expect.poll(box, { timeout: 10_000 }).toMatch(new RegExp(`^${NOTIFY} ?$`))
  // the box starts unchecked at EVERY opening (review B1): the app's modal keeps an unchanged
  // {@html} content's DOM across openings, so the box checked above would show checked again
  // unless the todoer resets it; the dialog cancelled by a background click puts the row back
  await page.evaluate(() => {
    ;(window as any).MindBox.set('')
    document.body.scrollTop = 0
  })
  await mainList.locator('> .list-item-container', { hasText: 'answer the agent' }).scrollIntoViewIfNeeded()
  await grab('answer the agent')
  {
    const row = await rowBox('answer the agent')
    await dragTo(
      { x: row.x + 52, y: row.y + row.height / 2 },
      async () => {
        const bin = (await page.locator('.todoer-widget').first().locator('.snooze.bin').boundingBox())!
        return { x: bin.x + bin.width / 2, y: bin.y + bin.height / 2 }
      },
      { inject: false }
    )
  }
  await expect(snoozeDialog).toBeVisible({ timeout: 10_000 })
  await expect(notifyBox).not.toBeChecked()
  await page.locator('.background.visible').click({ position: { x: 4, y: 4 } }) // no buttons: the background cancels the dialog
  await expect(snoozeDialog).toBeHidden({ timeout: 10_000 })
  await expect.poll(async () => (await lists(page)).main.some(r => r[0].includes('answer the agent')), { timeout: 30_000 }).toBe(true)

  // THE DONE BIN (the owner, 2026-11-17: "done" never deletes, it always converts the todo to
  // #done, named or not, small or large): a NAMED todo that fits its row (the agent's answer is
  // a token in the snippet), dropped on the done bin by a real drag, keeps its item: the todo
  // tag and nothing else is rewritten, through the app's own tag replacer over its grammar view
  // (the label, a longer tag, as written, so the item keeps its name; a second tag in another
  // case converted too; the answer's bytes as written, its own #todo too), the row leaves the
  // list, and no dialog comes on the way. Until then the todoer deleted such a todo, after the
  // app's "Delete ...?" for a named item (dismissed here, so the todo would have stayed as it
  // was, with the todoer's "could not complete" alert)
  const DONE = '#todo-e2e'
  const DONE_ANSWER = '<!--inert-->\nagent: closed; the #todo list is one shorter\n<!--/inert-->'
  await page.evaluate(text => void window._create(text), `${DONE} #todo close me (#ToDo)\n${DONE_ANSWER}`)
  await expect.poll(() => savedId(page, DONE), { timeout: 30_000 }).toBeTruthy()
  const doneId = (await savedId(page, DONE))!
  await expect.poll(() => serverText(doneId), { timeout: 30_000 }).toBe(`${DONE} #todo close me (#ToDo)\n${DONE_ANSWER}`)
  await page.evaluate(() => {
    ;(window as any).MindBox.set('')
    document.body.scrollTop = 0
  })
  await mainList.locator('> .list-item-container', { hasText: 'close me' }).scrollIntoViewIfNeeded()
  expect((await lists(page)).main.map(r => r[0]), 'the row: the label, then the snippet without the answer').toContain(`${DONE} #todo close me (#ToDo)`)
  const asked = dialogs.length
  await grab('close me')
  {
    const row = await rowBox('close me')
    await dragTo(
      { x: row.x + 52, y: row.y + row.height / 2 },
      async () => {
        const bin = (await page.locator('.todoer-widget').first().locator('.done.bin').boundingBox())!
        return { x: bin.x + bin.width / 2, y: bin.y + bin.height / 2 }
      },
      { inject: false }
    )
  }
  await expect.poll(() => serverText(doneId), { message: 'the done bin: the todo tags alone rewritten over the grammar view, the item kept', timeout: 30_000 }).toBe(`${DONE} #done close me (#done)\n${DONE_ANSWER}`)
  await expect.poll(async () => (await lists(page)).main.some(r => r[0].includes('close me')), { timeout: 30_000 }).toBe(false)
  expect(await page.evaluate(name => (window._item(name, true) as any)?.tags ?? null, DONE), 'the item stays under its name, no longer a todo').toEqual(['#todo-e2e', '#done'])
  expect(dialogs.slice(asked), 'no question and no refusal on the way').toEqual([])
})

// THE FIRST VIEW'S POSITION IN HISTORY (the owner, 2026-11-17: after a launch, a todo row's click selected
// its item and scrolled to it, and the browser's Back then scrolled to the page's very top, far above the
// MindBox, instead of where the launch had left the page, just above it). The launch writes its first
// history entry before the header is on the page, so that entry recorded position 0, and only the scroll
// listener's write, 250 ms after the launch's scroll to the header, corrected it, on whichever entry was
// current by then. What a real account's launch does and a quiet lane's does not: the cache answers
// first, and the server's first revision brings a change made elsewhere, whose re-ranking pushes a second
// entry of the same empty query in between; a row's click then replaced that entry, so the first one,
// its 0 intact, was one Back away (a row's click is now the app's select, in an entry of its
// own). Since 2026-11-19 that re-ranking is written over the launch's own entry (`first` in index.svelte's
// onEditorChange: no second entry of the same query), so the first view is ONE entry, which the scroll
// listener's write reaches, and Back from the item is that entry; the first entry that holds no position is
// the one a launch with a query in the address leaves (the last phase). The row's own account holds the pinned widgets, a tall pinned item
// (the item a row names is ranked below the pinned ones, out of view from the header), one todo and one
// item rewritten behind the app while the page is closed. The launch is a returning device's (a new tab
// of the same profile), its index build stalled through the app's seam (`_initialize_stall_ms`, as the
// startup-race row of lifecycle.spec.ts does) so that the server's revision is normally received before
// the first view is laid out. The stall delays the index build and cannot fix when the server answers, and
// since 2026-11-19 the row no longer depends on it nor establishes it: the re-ranking adds no entry whether
// the revision arrives before the first position is written or after (the stall stays so that the change
// arrives around the launch, as on a real account, not seconds later). A launch with a query in the address leaves the
// same first entry behind (the query's entry is pushed before the listener's write): its Back is the
// row's last phase
// what the two launch rows below share: their account's making, a launch, and what they read off a page
const loaded = async (page: Page) => {
  await waitForApp(page)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 30_000 }).toBe(true)
}
// a new account with the todoer and its pinned widgets, a tall pinned item (the item a row names is ranked
// below the pinned ones, out of view from the header), an item another device changes (`<prefix>_elsewhere`)
// and, created last, one todo (`<prefix>_todo`: a rewrite of the other item then moves it above the todo, a
// change of the order); the page is closed with everything saved, and the other item's id returned
async function launchAccount(page: Page, user: TestUser, prefix: string) {
  expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
  await page.addInitScript(() => localStorage.setItem('mindpage_github_token', 'e2e-local'))
  await signIn(page, user)
  await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
  await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
  await waitForApp(page)
  expect(await install(page, 'todoer'), '/_install todoer').toBeNull()
  // every item saved before a page goes away (the reload below, the close after it)
  const saved = () => expect.poll(() => page.evaluate(() => window.__items.every(item => item.savedId && !item.saving)), { timeout: 60_000 }).toBe(true)
  await saved()
  await page.reload()
  await loaded(page)
  await page.evaluate(() => (window._item('#todoer') as any).eval('create_pinned_item()'))
  await expect.poll(() => page.locator('.todoer-widget').count(), { timeout: 30_000 }).toBe(2)
  const TALL = `#_pin/${prefix}_tall\n${'a tall pinned item\n\n'.repeat(20)}`
  for (const text of [TALL, `#${prefix}_elsewhere an item another device changes`, `#${prefix}_todo\n#todo reach the item below`]) await page.evaluate(text => void window._create(text), text)
  await expect.poll(() => savedId(page, `#${prefix}_elsewhere`), { timeout: 30_000 }).toBeTruthy()
  const elsewhereId = (await savedId(page, `#${prefix}_elsewhere`))!
  await saved()
  await page.close()
  return elsewhereId
}
// a launch in a new tab of the profile
async function launch(context: BrowserContext, url: string, stall = 0) {
  const launched = await context.newPage()
  expect(await interceptMindItems(launched)).toBe(true) // the installed items' /watch requests answered
  if (stall) await launched.addInitScript(ms => void (window._initialize_stall_ms = ms), stall)
  await launched.goto(url)
  await loaded(launched)
  return launched
}
const top = (page: Page) => page.evaluate(() => document.body.scrollTop)
const header = (page: Page) => page.evaluate(() => (document.querySelector('.header') as HTMLElement).offsetTop)
// within 2 px (scrollTo lands a fractional scrollTop); a failure names both positions
const at = (page: Page, y: () => Promise<number>, message: string) =>
  expect
    .poll(async () => ((now, want) => (Math.abs(now - want) <= 2 ? 'there' : `at ${now}, not ${want}`))(await top(page), await y()), { message, timeout: 10_000 })
    .toBe('there')
const entries = (page: Page) => page.evaluate(() => [(window as any)._history.length, (window as any)._history_index])
// the current entry holds the position shown, the scroll listener's write done
const recorded = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => !(window as any)._history_update_pending && (window as any)._history[(window as any)._history_index].scrollPosition === document.body.scrollTop), {
      message: 'the position shown is recorded',
      timeout: 10_000,
    })
    .toBe(true)
const box = (page: Page) => page.evaluate(() => (window as any).MindBox.get())
// the todo's row in the main list (a click at its right end, past its text, selects the item and scrolls to it)
const todoRow = (page: Page) => page.locator('.todoer-widget').first().locator('.list > .list-item-container', { hasText: 'reach the item below' }).locator('.list-item')

test("after a launch a todo row's click scrolls to its item, and Back returns to where the launch left the page, at the header; a launch with a query in the address writes it over its own entry and adds none; a position recorded at the page's very top is restored as recorded", async ({ page, context }) => {
  const TODO = '#e2e_launch_todo'
  const ELSEWHERE = '#e2e_launch_elsewhere'
  const elsewhereId = await launchAccount(page, LAUNCH_USER, 'e2e_launch')
  await rewriteText(elsewhereId, text => text + ', changed elsewhere', LAUNCH_SECRET)

  // (a) the launch: the change made elsewhere arrives with the server's revision and re-ranks the page
  // (whether before or after the first view's position is recorded is not established by this row, and
  // since 2026-11-19 it does not matter: the re-ranking is written over the launch's entry); the page
  // shows the header
  const launched = await launch(context, '/', 2_500)
  await expect.poll(() => launched.evaluate(name => window._item(name, true)?.text ?? null, ELSEWHERE), { timeout: 30_000 }).toContain('changed elsewhere')
  await at(launched, () => header(launched), 'the launch leaves the page at the header')
  await recorded(launched)
  // the re-ranking is written over the launch's own entry, whenever it comes (until 2026-11-19 it pushed a
  // second entry of the empty query, before the first one's position was recorded)
  expect(await entries(launched), "one entry: the re-ranking is written over the launch's own").toEqual([1, 0])
  expect(await header(launched), 'the header is below the top of the page').toBeGreaterThan(2)
  // (b) the row's click (at its right end, past its text) selects the item and scrolls to it, in an entry
  // of its own (the app's select, as a click on an item's number; the widget used to set the box,
  // which pushed from the launch's entry too: it is final); Back is the first view, at the header
  const row = todoRow(launched)
  await expect(row).toBeVisible()
  const rowBox = (await row.boundingBox())!
  await row.click({ position: { x: rowBox.width - 8, y: rowBox.height / 2 } })
  await expect.poll(() => box(launched), { timeout: 10_000 }).toBe(TODO)
  await expect.poll(async () => (await top(launched)) - (await header(launched)), { message: 'the click scrolled to the item, out of view from the header', timeout: 10_000 }).toBeGreaterThan(300)
  await recorded(launched)
  const itemTop = await top(launched)
  expect(await entries(launched), "the click's own entry: the first view is one Back away").toEqual([2, 1])
  await launched.goBack()
  await expect.poll(() => box(launched), { timeout: 10_000 }).toBe('')
  await at(launched, () => header(launched), 'Back returns to where the launch left the page')
  expect(await entries(launched)).toEqual([2, 0])
  // Forward and Back again, the first view's position recorded by now (the restore's own scroll)
  await recorded(launched)
  await launched.goForward()
  await at(launched, async () => itemTop, 'Forward returns to the item')
  await recorded(launched)
  await launched.goBack()
  await at(launched, () => header(launched), 'Back again returns to the header')
  // a position RECORDED at the page's very top is restored as recorded: the header stands for an entry
  // that recorded none, not for one that recorded 0
  await recorded(launched)
  await launched.evaluate(() => document.body.scrollTo(0, 0))
  await recorded(launched)
  expect(await top(launched)).toBe(0)
  await launched.goForward()
  await at(launched, async () => itemTop, 'Forward returns to the item')
  await recorded(launched)
  await launched.goBack()
  await at(launched, async () => 0, 'Back returns to the recorded top')
  expect(await entries(launched)).toEqual([2, 0])
  await launched.close()

  // (c) a launch with a query in the address: the page scrolls to the item it names, and the address's query
  // is written over the launch's own entry, the launch's own write as its first view is: ONE entry, of the
  // query, final (until 2026-11-19 the query's entry was pushed after the first view, which this launch never
  // showed and which Back then reached at the header: the launch wrote that entry before the header was on the
  // page, and it held no position)
  const named = await launch(context, '/' + TODO)
  await expect.poll(() => box(named), { timeout: 10_000 }).toBe(TODO + ' ')
  await expect.poll(async () => (await top(named)) - (await header(named)), { message: 'the launch scrolled to the named item', timeout: 10_000 }).toBeGreaterThan(300)
  await recorded(named)
  expect(await entries(named), "the address's query in the launch's own entry").toEqual([1, 0])
  expect(await named.evaluate(() => [history.state.index, history.state.editorText, history.state.final]), "the entry holds the address's query, final").toEqual([0, TODO + ' ', true])
})

// BACK AFTER A RELOAD AND A TODO ROW'S CLICK (the owner, 2026-11-17, on the fix the row above came with:
// after a reload, a todo row's click and Back logged "ignoring onPopState for current index", and the
// page stayed on the item). A page that a change made elsewhere had re-ranked sat on a second entry of the
// empty query, which is not final (since 2026-11-19 such a re-ranking is written over the launch's own
// entry, and the row makes its second entry by a query that names nothing, set and cleared again; the
// change then re-ranks the view in that entry): a reload keeps that entry in the browser, with its state and its index
// 1, and the row's click replaced it (the click is now the app's select, in an entry of its
// own after the kept one, and the first view's kept entry is two Backs away). A session that numbered its entries from 0 again made that entry its
// entry 0, so Back onto the first view's kept entry, index 0 too, read as the current one: the handler
// replaced it with the item's state ("inconsistent state"), ignored it, and the page stayed. The session
// continues at the kept entry's index instead, and takes an entry it does not know as the browser holds it.
// The first view is left 120 px below the header before the change arrives, so Back shows that the entry's
// own position is restored, not the header's
test("after a reload on a re-ranked first view, a todo row's click and Back return to the first view where it was left, Forward to the item, and the history handler warns of nothing", async ({ page, context }) => {
  const TODO = '#e2e_reload_todo'
  const elsewhereId = await launchAccount(page, RELOAD_USER, 'e2e_reload')
  const tab = await launch(context, '/')
  const warnings: string[] = []
  tab.on('console', msg => void (msg.type() == 'warning' && msg.text().includes('onPopState') && warnings.push(msg.text())))
  // what the page shows with what the handler logged, so that a failure names both
  const shows = (text: string, message: string) => expect.poll(async () => ({ box: await box(tab), warnings }), { message, timeout: 10_000 }).toEqual({ box: text, warnings: [] })
  await at(tab, () => header(tab), 'the launch leaves the page at the header')
  await recorded(tab)
  expect(await entries(tab), 'a quiet launch: one entry').toEqual([1, 0])
  const left = (await header(tab)) + 120
  await tab.evaluate(y => document.body.scrollTo(0, y), left)
  await recorded(tab)
  expect(await top(tab), 'the first view, left below the header').toBe(left)
  // a second entry of the first view, not final: a query that names nothing, set from the blurred box and
  // cleared again
  await userSet(tab, 'e2e_reload_nothing')
  await expect.poll(() => entries(tab), { message: 'the query that names nothing, in an entry of its own', timeout: 10_000 }).toEqual([2, 1])
  await userSet(tab, '')
  await expect.poll(() => tab.evaluate(() => [history.state.index, history.state.editorText, history.state.final]), { message: 'cleared again in the same entry', timeout: 10_000 }).toEqual([1, '', false])
  expect((await tab.evaluate(() => (window as any)._history[0].scrollPosition)) as number, "the first view's own entry holds where it was left").toBe(left)
  // the change made elsewhere re-ranks the first view, in that entry (it is not final)
  await rewriteText(elsewhereId, text => text + ', changed elsewhere', RELOAD_SECRET)
  await expect.poll(() => tab.evaluate(name => window._item(name, true)?.text ?? null, '#e2e_reload_elsewhere'), { timeout: 30_000 }).toContain('changed elsewhere')
  expect(await entries(tab), 'the re-ranking adds no entry').toEqual([2, 1])
  await recorded(tab)
  // the reload: the page starts on the entry the browser kept, at the header
  await tab.reload()
  await loaded(tab)
  await at(tab, () => header(tab), 'the reloaded page is at the header')
  await recorded(tab)
  expect(await tab.evaluate(() => [history.state.index, history.state.editorText, history.state.final]), 'the kept entry: the second one, of the empty query, not final').toEqual([1, '', false])
  // the row's click selects the item in an entry of its own (the app's select; it used to replace
  // the kept entry, which is not final). Back is the entry the page was reloaded on, at the header; Back
  // again is the first view's kept entry, where it was left
  const row = todoRow(tab)
  await expect(row).toBeVisible()
  const rowBox = (await row.boundingBox())!
  await row.click({ position: { x: rowBox.width - 8, y: rowBox.height / 2 } })
  await expect.poll(() => box(tab), { timeout: 10_000 }).toBe(TODO)
  await expect.poll(async () => (await top(tab)) - (await header(tab)), { message: 'the click scrolled to the item, out of view from the header', timeout: 10_000 }).toBeGreaterThan(300)
  await recorded(tab)
  const itemTop = await top(tab)
  await tab.goBack()
  await shows('', 'Back shows the first view')
  await at(tab, () => header(tab), 'Back returns to the entry the page was reloaded on, at the header')
  expect(await entries(tab), 'the session continued at the kept index: the item is its entry 2').toEqual([3, 1])
  await recorded(tab)
  await tab.goBack()
  await shows('', 'Back again shows the first view')
  await at(tab, async () => left, 'Back again returns to where the first view was left')
  expect(await entries(tab), "the first view's kept entry is the session's entry 0").toEqual([3, 0])
  await recorded(tab)
  await tab.goForward()
  await expect.poll(() => entries(tab), { timeout: 10_000 }).toEqual([3, 1])
  await recorded(tab)
  await tab.goForward()
  await shows(TODO, 'Forward twice shows the item')
  await at(tab, async () => itemTop, 'Forward returns to the item')
  expect(await entries(tab)).toEqual([3, 2])
})

// BACK AFTER A SIGN-OUT (review 1 of scroll_history, 2026-11-17). A free-text query stays out of the address,
// but its whole text is in its history entry, and the browser keeps that entry when the account signs out
// in the same tab: the page reloads as the anonymous notebook, and Back reaches it. A handler that took any
// state with an integer index put the account's query into the next notebook's MindBox and its list above
// the header, and handed it to that notebook's `_on_change` and `_on_search` listeners. Every entry the app
// writes names the account and the notebook it belongs to, and a state that does not name this one is
// replaced with the current state unread: the page stays as it is. The account's query is the entry before
// the one the sign-out happens on (a tag click's), so the first Back out of the visitor's own entries lands
// on it; the visitor's notebook gets a listener of its own (a visitor's item is local), heard to be live
// first
test("after a sign-out in the same tab, Back onto the account's entries keeps its query out of the next notebook (the MindBox, the list above the header, the listeners' input) and leaves the page where it is, with no link offered and nothing written there; Forward again restores the visitor's entry, and its link lands on the entry it names; a query typed on such a position starts the numbering anew", async ({ page }) => {
  const QUERY = 'switch row private words'
  const AHEAD = 'switch row words ahead'
  const CLEARED = JSON.stringify({ owner: '|anonymous|', unknown: true }) // what a position that held another notebook's entry holds
  const warnings: string[] = []
  page.on('console', msg => void (msg.type() == 'warning' && msg.text().includes('onPopState') && warnings.push(msg.text())))
  await signIn(page, SWITCH_USER)
  await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
  await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
  await waitForApp(page)
  // the account: a note the query finds, with a tag to click, and the tag's item; then the query, typed
  for (const text of ['#e2e_switch_tag the item of the tag', `#e2e_switch_note ${QUERY}, with #e2e_switch_tag`]) await page.evaluate(text => void window._create(text), text)
  await expect.poll(() => savedId(page, '#e2e_switch_note'), { timeout: 30_000 }).toBeTruthy()
  await expect.poll(() => page.evaluate(() => window.__items.every(item => item.savedId && !item.saving)), { timeout: 60_000 }).toBe(true)
  await focusMindbox(page)
  await mindbox(page).fill(QUERY)
  await expect.poll(() => page.evaluate(() => (window as any)._history[(window as any)._history_index].editorText), { timeout: 10_000 }).toBe(QUERY)
  expect(await page.evaluate(() => location.hash), 'a free-text query stays out of the address').toBe('')
  const [, queryIndex] = await entries(page)
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_switch_note')!.elem)).toBe(true)
  const noteId = await page.evaluate(() => window._item('#e2e_switch_note')!.id)
  await page.locator(`#item-${noteId} mark[title="#e2e_switch_tag"]`).click()
  await expect(mindbox(page)).toHaveValue('#e2e_switch_tag ', { timeout: 10_000 })
  expect(await entries(page), "the tag click's entry, after the query's").toEqual([queryIndex + 2, queryIndex + 1])
  expect(await page.evaluate(() => (window as any)._history[(window as any)._history_index - 1].editorText)).toBe(QUERY)
  // one entry more, a second free-text query, and Back from it: the sign-out happens with an entry of the
  // account's AHEAD as well (the visitor's launch replaces the entry it happens on, which keeps what is ahead)
  await page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).focus({ preventScroll: true })) // in place: the box can hold the focus already
  await expect(mindbox(page)).toBeFocused()
  await mindbox(page).fill(AHEAD)
  await expect.poll(() => page.evaluate(() => history.state?.editorText), { timeout: 10_000 }).toBe(AHEAD)
  expect(await entries(page), "the second query's entry, after the tag click's").toEqual([queryIndex + 3, queryIndex + 2])
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_switch_tag ', { timeout: 10_000 })

  // the sign-out, by the header's own control: the same tab reloads as the anonymous notebook, a visitor's
  await page.locator('img.user').click()
  await expect.poll(() => page.evaluate(() => window._init_time > 0 && window._readonly === true && window._user.uid == 'anonymous').catch(() => false), { timeout: 90_000 }).toBe(true)
  await waitForApp(page)
  expect(await entries(page), "the visitor's session starts its own numbering on the entry the account left").toEqual([1, 0])
  await expect(mindbox(page)).toHaveValue('')

  // FORWARD ONTO THE ACCOUNT'S ENTRY AHEAD STOPS (the stop, the owner 2026-11-18: the browser has moved
  // before the app hears of it, so the app goes back at once to the entry the page shows; see the stop's
  // row in editor.spec.ts for Back). The `popstate` carried the account's second query; nothing of it
  // reaches the notebook, the browser is on the visitor's entry again, and the note names the way it had
  // moved. Every state a popstate brings is noted beside the app, from here on
  await page.evaluate(() => void window.addEventListener('popstate', e => void ((window as any).__popped ??= []).push(e.state?.editorText), true))
  await page.goForward()
  await expect(page.locator('.stop-note.visible'), 'the note of a stop after Forward').toHaveText('nothing to go forward to')
  expect(await page.evaluate(() => (window as any).__popped), "Forward reached the account's entry, and the browser came back to the visitor's").toEqual([AHEAD, ''])
  expect(
    await page.evaluate(query => {
      const w = window as any
      return [(document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value, history.state.index, w._history.length, w._history_index, JSON.stringify([history.state, w._history]).includes(query)]
    }, AHEAD),
    "the page stays on the visitor's first view, its entry the browser's again, the account's query nowhere"
  ).toEqual(['', 0, 1, 0, false])
  // the note is passive (no modal since 2026-11-19): it goes at the next key, which reaches the page (Shift)
  await page.keyboard.press('Shift')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve)))))
  expect(await page.locator('.stop-note.visible').count(), 'the note goes at the next key').toBe(0)
  expect(warnings, 'the handler warned of nothing').toEqual([])
  // THE REST OF THE ROW RUNS WITHOUT THE NAVIGATION API (hidden here, as in a browser that lacks it): no
  // return can be said then, and the page stays on a position that holds no entry of the notebook's, as it
  // did before the stop: what follows is that behaviour, unchanged. First, the position the stop left: what
  // it held was cleared before the browser went back
  await page.evaluate(() => void Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }))
  await page.goForward()
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state)), { message: "the account's entry ahead was cleared by the stop; without the Navigation API the browser stays on it" }).toBe(CLEARED)
  await page.goBack()
  await expect.poll(() => page.evaluate(() => history.state?.index), { timeout: 10_000 }).toBe(0)
  // the visitor's first view, left 120 px below the header (the position it is restored at, further down)
  const left = (await header(page)) + 120
  // (set until it holds: the scroll of the entry just restored can land after the first)
  await expect
    .poll(async () => {
      await page.evaluate(y => document.body.scrollTo(0, y), left)
      await page.waitForTimeout(150)
      return top(page)
    })
    .toBe(left)
  await recorded(page)
  expect(await top(page)).toBe(left)
  // the visitor's own listener (a visitor's item is local) and the item its tag names
  await page.evaluate(() => {
    void window._create('#e2e_switch_other an item of the visitor')
    void window._create(
      '#e2e_switch_listener #_listen names #e2e_switch_other\n```js\nfunction _on_change(text) { (window.__heard ??= []).push(text) }\nfunction _on_search(text) { (window.__heard ??= []).push(text) }\n```'
    )
  })
  await expect.poll(() => page.evaluate(() => window._exists('#e2e_switch_listener') && window._exists('#e2e_switch_other'))).toBe(true)
  // two entries after the first view's: the listener's label, typed (the listener hears it: it is live),
  // and a tag click from the listener's item
  await focusMindbox(page)
  await mindbox(page).fill('#e2e_switch_listener')
  await expect.poll(() => page.evaluate(() => ((window as any).__heard ?? []).filter((text: string) => text == '#e2e_switch_listener').length), { message: 'the listener hears a change and a search', timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_switch_listener')!.elem)).toBe(true)
  const listenerId = await page.evaluate(() => window._item('#e2e_switch_listener')!.id)
  await page.locator(`#item-${listenerId} mark[title="#e2e_switch_other"]`).click()
  await expect(mindbox(page)).toHaveValue('#e2e_switch_other ', { timeout: 10_000 })
  expect(await entries(page), "the visitor's three entries").toEqual([3, 2])

  // what the visitor's notebook holds of the account's query, anywhere
  const held = () =>
    page.evaluate(query => {
      const w = window as any
      return {
        box: (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value.includes(query),
        list: [...document.querySelectorAll('.history-item')].some(e => (e.textContent ?? '').includes(query)),
        session: w._history.some((state: any) => String(state?.editorText).includes(query)),
        heard: (w.__heard ?? []).some((text: string) => String(text).includes(query)),
        entry: JSON.stringify(history.state).includes(query),
      }
    }, QUERY)
  const none = { box: false, list: false, session: false, heard: false, entry: false }
  const settled = () => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300))) // the listeners run from a timer
  const links = page.locator('.history-item') // the list above the header
  // the browser's state and the session's place: the index, and the position its entry there recorded
  const place = () => page.evaluate(() => [JSON.stringify(history.state), (window as any)._history_index, (window as any)._history[(window as any)._history_index].scrollPosition])
  // Back to the visitor's first view, at the position ITS ENTRY HOLDS, the typed query's link above the
  // header. That is the writer's own result, read off the session's copy: the step shows that Back restores
  // what the entry recorded, not, by a measure of its own, where the visitor left the list (the steps on the
  // rejected entry below use the row's own position). Since 2026-11-19 the first view stays ONE entry
  // through the re-ranking of the items created above (written over the launch's own entry), so it is the
  // entry on which the scrolls of the box's focus and of the typing are written (on the release of the day
  // before Back returned to `left` here; by the code that re-ranking's own entry took them: not probed).
  // The view is then put at `left` again for what follows
  const leftAt = (await page.evaluate(() => (window as any)._history[0].scrollPosition)) as number
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('#e2e_switch_listener')
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await at(page, async () => leftAt, "Back to the visitor's first view, at the position its entry holds")
  await recorded(page)
  await expect
    .poll(async () => {
      await page.evaluate(y => document.body.scrollTo(0, y), left)
      await page.waitForTimeout(150)
      return top(page)
    })
    .toBe(left)
  await recorded(page)
  await expect(links).toHaveText(['#e2e_switch_listener'])
  expect(await page.evaluate(() => (window as any).__popped ?? []), "no entry of the account's yet").not.toContain(QUERY)

  // Back onto the entry of the account's query: nothing of it reaches the notebook, the page stays, the
  // position is cleared and holds no entry of the visitor's, and no link is offered from it
  await page.goBack()
  await expect.poll(() => page.evaluate(() => (window as any).__popped.at(-1)), { message: "Back reached the entry of the account's query", timeout: 10_000 }).toBe(QUERY)
  await settled()
  expect(await held(), "the account's query is nowhere in the visitor's notebook, nor left in the browser's entry").toEqual(none)
  await expect(mindbox(page), 'the page stayed as it was').toHaveValue('')
  await at(page, async () => left, 'the page stayed where it was')
  expect(await place(), "cleared, and not stamped with the visitor's entry").toEqual([CLEARED, 0, left])
  await expect(links, 'no link from a position whose distance to the entries is unknown').toHaveCount(0)
  // a scroll there writes nothing: neither the position nor the session's entry takes the scrolled position
  await page.evaluate(y => document.body.scrollTo(0, y), left + 200)
  await settled()
  await expect.poll(() => page.evaluate(() => (window as any)._history_update_pending), { message: "the scroll listener's write has run" }).toBe(false)
  expect(await place(), 'a suppressed write leaves the position and the session\'s copy as they were').toEqual([CLEARED, 0, left])
  // once more, onto the account's entry before that one, and Forward again onto the cleared position
  await page.goBack()
  await settled()
  expect(await held()).toEqual(none)
  expect(await place()).toEqual([CLEARED, 0, left])
  await page.goForward()
  await settled()
  expect(await place(), 'the cleared position again').toEqual([CLEARED, 0, left])
  await expect(links).toHaveCount(0)

  // Forward onto the visitor's first view: an entry the session holds, restored where it was left (not where
  // the page was scrolled meanwhile), its link back above the header and one entry ahead
  await page.goForward()
  await expect.poll(() => page.evaluate(() => history.state?.index), { timeout: 10_000 }).toBe(0)
  await expect(mindbox(page)).toHaveValue('')
  await at(page, async () => left, "Forward onto the visitor's first view restores it where it was left")
  expect(await entries(page)).toEqual([3, 0])
  await expect(links).toHaveText(['#e2e_switch_listener'])
  await links.first().click()
  await expect(mindbox(page), 'the link lands on the entry it names').toHaveValue('#e2e_switch_listener')
  expect(await page.evaluate(() => [history.state.index, (window as any)._history_index])).toEqual([1, 1])

  // a query typed ON the cleared position is a new entry there and starts the numbering anew: how far the
  // position is from the visitor's earlier entries is not known, and the browser drops what lay ahead of it
  await page.goBack()
  await expect(mindbox(page)).toHaveValue('')
  await page.goBack()
  await settled()
  expect((await place())[0]).toBe(CLEARED)
  const run = await page.evaluate(() => (window as any)._history[0].run)
  await page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).focus({ preventScroll: true })) // in place: the box can hold the focus already
  await expect(mindbox(page)).toBeFocused()
  await mindbox(page).fill('typed on the cleared position')
  await expect.poll(() => page.evaluate(() => history.state?.editorText), { timeout: 10_000 }).toBe('typed on the cleared position')
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  expect(await entries(page), 'one entry held, numbered from 0 again').toEqual([1, 0])
  expect(await page.evaluate(() => [history.state.index, typeof history.state.run]), 'the first entry of a new run').toEqual([0, 'number'])
  expect(await page.evaluate(() => history.state.run), 'a new run').not.toBe(run)
  await page.goBack()
  await settled()
  expect((await place())[0], 'Back from it: the cleared position').toBe(CLEARED)
  await expect(mindbox(page), 'the page stays').toHaveValue('typed on the cleared position')
  await expect(links).toHaveCount(0)
  await page.goForward()
  await expect.poll(() => page.evaluate(() => history.state?.index), { timeout: 10_000 }).toBe(0)
  await expect(mindbox(page)).toHaveValue('typed on the cleared position')
  expect(await entries(page)).toEqual([1, 0])
  expect(await held()).toEqual(none)
  expect(warnings, 'the handler warned of nothing').toEqual([])
})

// AN OPTION-RUN RELEASES THE RECORD THAT RECEIVED ITS HOLD (review 2 of the running ring's
// follow-ups, 2026-11-19). An Option-click on a parent's Run button runs the parent's runnable
// dependencies first; the Option-run takes one counted running reference of each at its start and
// releases it when that dependency's run ends, or when the loop ends before it. A dependency can
// leave the page and come back under the same id while the loop waits (on a shared page, its key
// removed and restored from another tab: the removal takes the record out of the page, the
// addition makes a new one). The record then at that id is not the one the run holds, and another
// run can hold it: released by its id, the run's cleanup took THAT run's reference (the new record
// held at a count of 1 and half a ring ended at 0 and clear, and the other run's own release then
// logged `attempted running=false when already false`). A record that left the page is now a
// missing dependency, whose lookup has always stopped the loop: the new record is not run, and
// neither is the parent. The anonymous notebook, as a visitor: the parent and its first dependency
// are local items of the row's, the first one's run held open by the row (its input returns a
// promise of the row's, which the Option-run awaits: no `#_async`, which names a docs item of the
// corpus by its alias and would be a dependency of its own), and the queued dependency is a
// document of the anonymous account that the row writes, deletes and writes again behind the app,
// so that the page holds it under the document's id (a local item keeps the tab's own id). The queued
// dependency is the parent's root (its label `#e2e_optrun2`, the parent's `#e2e_optrun2/parent`), so
// the query that names the parent shows it as context, the new record too (a dependency alone is
// not shown). Every run records its item
test('an Option-run releases the record that received its hold, and not a new record under the same id', async ({ page }) => {
  const QUEUED = 'e2e-optrun2-queued' // the document's id, which the page's record of it takes
  const QUEUED_DOC = { user: 'anonymous', time: Date.now(), attr: null, text: '#e2e_optrun2 the dependency that leaves the page and comes back\n```js_input\n;(window.__optrun2 ??= []).push(_this.id)\n```' }
  const released: string[] = []
  page.on('console', message => void (message.type() == 'error' && message.text().includes('attempted running=false') && released.push(message.text())))
  // the raw record under an id (undefined without one), whether an item is on the page, and what its ring shows
  const raw = (id: string) =>
    page.evaluate(
      id => (found => found && { running: found.running, saving: !!found.saving, runnable: !!found.runnable, deps: [...found.deps], original: !!found.__e2e_original })((window as any).__items.find((item: any) => item.id == id)),
      id,
    )
  const shown = (id: string) => page.evaluate(id => !!document.querySelector(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${id}"]`), id)
  const ring = (id: string) =>
    page.evaluate(
      id => (mark => (mark ? [mark.title, mark.classList.contains('filled'), mark.style.getPropertyValue('--running-mark-fill'), getComputedStyle(mark, '::before').animationName != 'none'] : null))(document.getElementById('super-container-' + id)?.querySelector('.item-menu .running-mark') as HTMLElement | null),
      id,
    )
  const ran = () => page.evaluate(() => (window as any).__optrun2 ?? [])
  try {
    await loadAnonymous(page)
    await firestore().collection('items').doc(QUEUED).set(QUEUED_DOC)
    await expect.poll(async () => !!(await raw(QUEUED)), { message: 'the page holds the document under its id', timeout: 30_000 }).toBe(true)
    const [parent, first] = await page.evaluate(async () => {
      const made = async (text: string) => ((await (window as any)._create(text)) as { id: string }).id
      const first = await made('#e2e_optrun2_first the first dependency of an Option-run, whose run waits for the row\n```js_input\n;(window.__optrun2 ??= []).push(_this.id)\nreturn window.__optrun2_hold\n```')
      const parent = await made('#e2e_optrun2/parent #_e2e_optrun2_first #_e2e_optrun2 their parent\n```js_input\n;(window.__optrun2 ??= []).push(_this.id)\n```')
      location.hash = '#e2e_optrun2/parent'
      return [parent, first]
    })
    await expect
      .poll(
        async () => {
          const [up, held, queued] = [await raw(parent), await raw(first), await raw(QUEUED)]
          return [up?.deps, up?.runnable, held?.runnable, queued?.runnable, [up, held, queued].map(found => found?.running), [up, held, queued].some(found => found?.saving), await shown(parent), await shown(QUEUED)]
        },
        { message: 'the premise: the parent depends on the first and then the queued one, all are runnable, none runs or is being saved, the parent and the queued one are on the page', timeout: 30_000 },
      )
      .toEqual([[first, QUEUED], true, true, true, [0, 0, 0], false, true, true])
    // the Option-run, its first dependency held open by the row
    await page.evaluate(() => {
      const w = window as any
      w.__optrun2 = []
      w.__optrun2_hold = new Promise(resolve => (w.__optrun2_release = resolve))
    })
    await page.locator(`.column:not(.hidden) .container[data-item-id="${parent}"] .item-menu > .run`).click({ modifiers: ['Alt'] })
    await expect.poll(async () => [await ran(), (await raw(QUEUED))?.running], { message: 'the first dependency\'s run has begun and waits; the queued one is held by the Option-run', timeout: 15_000 }).toEqual([[first], 1])
    // while it waits, the queued dependency leaves the page and comes back under its id: a NEW record, which the row holds at 50%
    await page.evaluate(id => void ((window as any).__items.find((item: any) => item.id == id).__e2e_original = true), QUEUED)
    await firestore().collection('items').doc(QUEUED).delete()
    await expect.poll(() => raw(QUEUED), { message: 'deleted: the page holds no record under the id', timeout: 30_000 }).toBeUndefined()
    await firestore().collection('items').doc(QUEUED).set(QUEUED_DOC)
    await expect.poll(async () => [...(found => (found ? [found.running, found.original] : []))(await raw(QUEUED)), await shown(QUEUED)], { message: 'written again: a new record under the same id, which no run holds, on the page', timeout: 30_000 }).toEqual([0, false, true])
    await page.evaluate(id => {
      const item = (window as any)._item(id)
      item.running = true
      item.status = 'held by another run'
      item.progress = 0.5
    }, QUEUED)
    const HELD = ['held by another run', true, '50.000%', false]
    await expect.poll(async () => [(await raw(QUEUED))?.running, await ring(QUEUED)], { message: 'the new record, held by the row: half a ring', timeout: 30_000 }).toEqual([1, HELD])
    // the first dependency's run ends, and the Option-run with it: the new record keeps the row's reference and its half ring
    await page.evaluate(() => (window as any).__optrun2_release())
    await expect.poll(async () => (await raw(parent))?.running, { message: 'the Option-run is over: the parent\'s own reference is released', timeout: 15_000 }).toBe(0)
    await expect.poll(async () => [(await raw(QUEUED))?.running, await ring(QUEUED)], { message: 'the Option-run released the record it held, and not the new one: the row\'s reference and its half ring are kept', timeout: 15_000 }).toEqual([1, HELD])
    expect([await ran(), (await raw(first))?.running], 'the queued dependency had left the page, as a missing one: neither it nor the parent ran, and the first one\'s reference is released').toEqual([[first], 0])
    // the row releases its own reference of the new record: no count, no ring, and no release of a reference that was not held
    await page.evaluate(id => void ((window as any)._item(id).running = false), QUEUED)
    await expect.poll(async () => [(await raw(QUEUED))?.running, await ring(QUEUED)], { message: 'the row\'s own release: no count, no ring', timeout: 15_000 }).toEqual([0, null])
    expect(released, 'no release of a reference that was not held').toEqual([])
  } finally {
    await firestore().collection('items').doc(QUEUED).delete()
  }
})

// WAITING ROWS AND BELLS (vault design notes/design/mind_task_agents.md 2.8, 2026-11-23): a chat
// whose last turn is a bridge reply gets a row with a `reply` bell (cleared by the bell's click
// without touching the chat's text, persisting across a reload); such a row dropped on the snooze
// bin, a todo's bin, goes back with a word and nothing written; once the chat is made a todo (the
// tag typed after its name), its row shows the start of its first user turn and its second click
// opens the editor with that stretch selected (the chat is shaped as one the bridge created: an
// inert body with the same words stands before the turn); a todo's own
// bell follows `surfaced`, clears on click across a reload, and rings again at the next count; a
// delegated todo's check-in rings `checkin` and sends one non-sticky `[checkin]` notification under
// `/notify on checkin`.
test('waiting reply rows, a chat-todo question and its selection, todo bells, and checkin notifications', async ({ page }) => {
  const rowDialogs: string[] = []
  page.on('dialog', dialog => {
    rowDialogs.push(dialog.message())
    void dialog.accept()
  })
  expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
  await page.addInitScript(() => localStorage.setItem('mindpage_github_token', 'e2e-local'))
  await signIn(page, WAITS_USER)
  await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
  await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
  await waitForApp(page)
  const saved = () => expect.poll(() => page.evaluate(() => window.__items.every(item => item.savedId && !item.saving)), { message: 'all items saved', timeout: 60_000 }).toBe(true)
  const FOOTER = "<<agent('vault/default · run ab12cd34 · 1s')>>"
  const FOOTER2 = "<<agent('vault/default · run ef56ab78 · 2s')>>"
  const CLEAR_KEY = "1|'vault/default · run ab12cd34 · 1s'"
  const CLEAR_KEY2 = "1|'vault/default · run ef56ab78 · 2s'"
  // a chat with a reply and a stamped item from BEFORE the baselines begin in the account
  const CHAT_OLD = `#waits_old/0 #_agent/vault\n<<user>> an old question\n${FOOTER}\n<!--inert-->\nThe old answer.\n<!--/inert-->`
  const PRE_ITEM = '#waits_pre\nWritten before items_base existed.'
  await page.evaluate(text => void window._create(text), CHAT_OLD)
  await page.evaluate(text => void window._create(text), PRE_ITEM)
  await expect.poll(() => savedId(page, '#waits_old/0'), { message: 'the old chat saved', timeout: 30_000 }).toBeTruthy()
  await expect.poll(() => savedId(page, '#waits_pre'), { message: 'the pre-baseline item saved', timeout: 30_000 }).toBeTruthy()
  const chatOldId = (await savedId(page, '#waits_old/0'))!
  const preItemId = (await savedId(page, '#waits_pre'))!
  expect(await install(page, 'todoer'), '/_install todoer').toBeNull()
  await saved()
  const todoerId = (await savedId(page, '#todoer'))!
  const hashOf = (text: string) => page.evaluate(t => (window as any)._hash_64_fnv1a(t) as string, text)
  const preStampAt = Date.now() - 60_000
  const preStampHash = await hashOf(PRE_ITEM)
  const todoerStoreDoc0 = (await storeDocId(`global_store_${todoerId}`, WAITS_USER, WAITS_SECRET)) ?? 'e2e-waits-store-todoer'
  await writeStore(
    todoerStoreDoc0,
    `global_store_${todoerId}`,
    { _agent: { wrote: { [preItemId]: { by: 'claude', at: preStampAt, hash: preStampHash } } } },
    WAITS_USER,
    WAITS_SECRET,
  )
  await page.reload()
  await loaded(page)
  await page.evaluate(() => (window._item('#todoer') as any).eval('create_pinned_item()'))
  await expect.poll(() => page.locator('.todoer-widget').count(), { message: 'both todoer widgets mounted', timeout: 30_000 }).toBe(2)
  await page.evaluate(() => void window._create('#todo waits baseline'))
  await saved()
  await expect
    .poll(async () => {
      const store = await serverStore(`global_store_${todoerId}`, WAITS_USER, WAITS_SECRET)
      return [store?.rows_since > 0, Object.keys(store?.rows_base ?? { none: 0 }), !!store?.bells_base, store?.items_base ?? null]
    }, { message: 'the todoer writes its baselines on the server: the time, a mark of the old chat\'s reply, the bells\' counts, the pre-baseline write stamp', timeout: 60_000 })
    .toEqual([true, [String(chatOldId)], true, { [preItemId]: preStampAt }])

  const main = page.locator('.todoer-widget').first()
  const delegated = page.locator('.todoer-widget').nth(1)

  // 0. a reply and an agent write stamp from before the list began never become rows: not when the
  // chat is selected, not after an unrelated edit of the chat, not after a reload (the app moves an
  // item's time at each; review 0 of the thread notify_list); a replacement reply on it is a new one
  const oldRow = main.locator('.list-item-container[data-waits="reply"]', { hasText: '#waits_old/0' })
  const preRow = main.locator('.list-item-container[data-waits="item"]', { hasText: '#waits_pre' })
  const seenOld = () => page.evaluate(id => (window._item('#todoer') as any)?.store?.reply_seen?.[window._item('id:' + id, true)?.id ?? '']?.footer ?? null, chatOldId)
  await expect.poll(seenOld, { message: 'this tab holds the old chat\'s reply', timeout: 30_000 }).toBe("'vault/default · run ab12cd34 · 1s'")
  await expect(oldRow, 'a reply from before the list began has no row').toHaveCount(0)
  await expect
    .poll(() => page.evaluate(id => (window._item('id:' + id, true) as any)?.hash ?? null, preItemId), {
      message: 'the pre-baseline item holds its stamped hash',
      timeout: 15_000,
    })
    .toBe(preStampHash)
  await expect(preRow, 'a stamp that stood before the baseline shows nothing').toHaveCount(0)
  await page.evaluate(() => void (window as any).MindBox.set('#waits_old/0'))
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.container.target')?.getAttribute('data-item-id') === window._item('#waits_old/0', true)?.id), { message: 'the old chat is selected', timeout: 15_000 })
    .toBe(true)
  await page.evaluate(text => void window._item('#waits_old/0', true)!.write(text, ''), CHAT_OLD + '\na note added later')
  await saved()
  await page.evaluate(() => (window._item('#todoer') as any).eval('_rerender_todoer_widgets()'))
  await expect(oldRow, 'selected and edited, the old chat still has no row').toHaveCount(0)
  await page.evaluate(() => void (window as any).MindBox.set(''))
  await page.reload()
  await loaded(page)
  await expect.poll(() => page.locator('.todoer-widget').count(), { message: 'both widgets mounted after the old chat\'s reload', timeout: 30_000 }).toBe(2)
  await expect.poll(seenOld, { message: 'the reloaded tab holds the old chat\'s reply', timeout: 30_000 }).toBe("'vault/default · run ab12cd34 · 1s'")
  await expect(oldRow, 'after a reload the old chat still has no row').toHaveCount(0)
  await expect
    .poll(
      () =>
        page.evaluate(id => {
          const it = window._item('id:' + id, true) as any
          const gs = (window._item('#todoer') as any)?._global_store
          const stamp = gs?._agent?.wrote?.[id]
          return [it?.hash ?? null, gs?.items_base?.[id] ?? null, stamp?.at ?? null, stamp?.hash ?? null]
        }, preItemId),
      { message: 'the reloaded tab holds the pre-baseline item hash, items_base entry, and retained stamp', timeout: 15_000 },
    )
    .toEqual([preStampHash, preStampAt, preStampAt, preStampHash])
  await expect(preRow, 'after a reload the pre-baseline item stamp still has no row').toHaveCount(0)
  await page.evaluate(text => void window._item('#waits_old/0', true)!.write(text, ''), CHAT_OLD.replace(FOOTER, FOOTER2))
  await expect(oldRow, 'a replacement reply on the old chat is a new one: it has a row').toHaveCount(1, { timeout: 30_000 })
  await saved()

  // 1. a reply's row and its clear
  const CHAT_A = `#waits_a/0 #_agent/vault\n<<user>> what now?\n${FOOTER}\n<!--inert-->\nThe answer, see [the plan](https://example.com/plan) at https://example.com/x.\n<!--/inert-->`
  await page.evaluate(text => void window._create(text), CHAT_A)
  await expect.poll(() => savedId(page, '#waits_a/0'), { message: 'first chat saved', timeout: 30_000 }).toBeTruthy()
  const chatAId = (await savedId(page, '#waits_a/0'))!
  const replyRowA = main.locator('.list-item-container[data-waits="reply"]', { hasText: '#waits_a/0' })
  await expect(replyRowA, 'a chat whose last turn is a bridge reply has a row in the main list').toHaveCount(1, { timeout: 30_000 })
  await expect(replyRowA.locator('mark.waits'), 'the reply row shows a bell saying reply').toHaveText('reply')
  await expect(replyRowA.locator('.list-item'), 'the reply\'s line is drawn as written').toContainText('see [the plan](https://example.com/plan) at https://example.com/x.')
  await expect(replyRowA.locator('a'), 'nothing in a reply\'s line becomes a link in the list').toHaveCount(0)
  // the box names the chat while no row is marked: its row is marked as a todo's is (the owner's
  // report of 2026-11-24: only a todo's name rendered the list again, so a reply's row stayed
  // unmarked until something else rendered it)
  await page.evaluate(() => void (window as any).MindBox.set(''))
  await expect(main.locator('.list-item-container.selected'), 'the premise: no row is marked').toHaveCount(0)
  await page.evaluate(() => void (window as any).MindBox.set('#waits_a/0'))
  await expect(replyRowA, 'the box names the chat: its reply row is marked').toHaveClass(/(^| )selected( |$)/, { timeout: 5_000 })
  await page.evaluate(() => void (window as any).MindBox.set(''))
  await expect(main.locator('.list-item-container.selected'), 'the box names nothing again: no row is marked').toHaveCount(0)
  await main.scrollIntoViewIfNeeded()
  await replyRowA.locator('mark.waits').click()
  await expect(replyRowA, "the bell's click removes the reply row").toHaveCount(0, { timeout: 15_000 })
  await expect
    .poll(async () => (await serverStore(`global_store_${chatAId}`, WAITS_USER, WAITS_SECRET))?._todoer?.cleared ?? null, {
      message: "the bell's click records the clear in the chat's own store",
      timeout: 30_000,
    })
    .toEqual([CLEAR_KEY])
  expect(await serverText(chatAId, WAITS_SECRET), "clearing a reply leaves the chat's text unchanged").toBe(CHAT_A)
  await saved()
  await page.reload()
  await loaded(page)
  await expect.poll(() => page.locator('.todoer-widget').count(), { message: 'both widgets mounted after first reload', timeout: 30_000 }).toBe(2)
  await expect(main.locator('.list-item-container', { hasText: 'waits baseline' }), 'baseline todo rendered after first reload').toHaveCount(1, { timeout: 30_000 })
  await expect
    .poll(() => page.evaluate(id => !!(window._item('#todoer') as any)?.store?.reply_seen?.[id] && !(window._item('#todoer') as any)?.store?.loading, chatAId), {
      message: 'reloaded tab indexed the cleared chat reply',
      timeout: 30_000,
    })
    .toBe(true)
  expect(
    await page.evaluate(id => {
      const todoer = window._item('#todoer') as any
      const chat = window._item('id:' + id, true) as any
      return [todoer.store.reply_seen[chat.id].last, chat._global_store?._todoer?.cleared ?? null]
    }, chatAId),
    'the reloaded tab holds the chat\'s reply as its last turn, and the clear'
  ).toEqual([true, [CLEAR_KEY]])
  await expect(oldRow, 'after the reload the reply that was not cleared has its row').toHaveCount(1, { timeout: 30_000 })
  await expect(replyRowA, 'after a reload the cleared reply row stays away').toHaveCount(0)
  // a clear made on another device takes a mounted row away, with no reload
  const oldStoreDoc = (await storeDocId(`global_store_${chatOldId}`, WAITS_USER, WAITS_SECRET)) ?? 'e2e-waits-store-old'
  await writeStore(oldStoreDoc, `global_store_${chatOldId}`, { _todoer: { cleared: [CLEAR_KEY2] } }, WAITS_USER, WAITS_SECRET)
  await expect(oldRow, 'a clear written by another device takes the mounted row away').toHaveCount(0, { timeout: 30_000 })

  // 2. a todo's bin: a real drag of a second reply row onto the snooze bin puts it back, with a word and nothing written
  const QUESTION = 'what is the answer to the long question asked here\nand its second line'
  // shaped as a child chat the bridge created (the header, the creating run's attribution, its
  // inert body), whose body holds the question's own words BEFORE the owner's turn (review 1 of
  // the thread notify_list)
  const CHAT_B = `#waits_b/0 #_agent/vault\n<<agent('vault/default · run cd34ef56 · 3s')>>\n<!--inert-->\n${QUESTION}\n<!--/inert-->\n<<user>> ${QUESTION}\n${FOOTER}\n<!--inert-->\nThe answer for waits_b.\n<!--/inert-->`
  await page.evaluate(text => void window._create(text), CHAT_B)
  await expect.poll(() => savedId(page, '#waits_b/0'), { message: 'second chat saved', timeout: 30_000 }).toBeTruthy()
  const chatBId = (await savedId(page, '#waits_b/0'))!
  const replyRowB = main.locator('.list-item-container[data-waits="reply"]', { hasText: '#waits_b/0' })
  await expect(replyRowB, 'the second chat reply has a row in the main list').toHaveCount(1, { timeout: 30_000 })
  await saved()
  let dragging = false
  for (let attempt = 0; attempt < 5 && !dragging; attempt++) {
    await main.scrollIntoViewIfNeeded()
    const row = (await replyRowB.boundingBox())!
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(200)
    await page.mouse.move(row.x + row.width / 2 + 6, row.y + row.height / 2 + 5, { steps: 5 })
    dragging = /dragging/.test((await main.getAttribute('class')) ?? '')
    if (!dragging) {
      await page.mouse.up()
      await page.waitForTimeout(500)
    }
  }
  expect(dragging, 'the reply row entered its dragging state').toBe(true)
  const snoozeBin = (await main.locator('.snooze.bin').boundingBox())!
  await page.mouse.move(snoozeBin.x + snoozeBin.width / 2, snoozeBin.y + snoozeBin.height / 2, { steps: 20 })
  await page.waitForTimeout(200)
  await page.mouse.up()
  await expect
    .poll(() => rowDialogs.filter(message => message == 'cannot snooze #waits_b/0: not a #todo item').length, { message: 'a reply row dropped on the snooze bin is refused with a word', timeout: 10_000 })
    .toBe(1)
  await expect(page.locator('.snooze-modal'), 'no snooze dialog opens for a reply row').toBeHidden()
  await expect(replyRowB, 'the reply row is back in the main list').toHaveCount(1, { timeout: 15_000 })
  expect(await serverText(chatBId, WAITS_SECRET), "the refused drop leaves the chat's text unchanged").toBe(CHAT_B)
  expect((await serverStore(`global_store_${chatBId}`, WAITS_USER, WAITS_SECRET))?._todoer ?? null, 'and writes nothing into its store').toBeNull()

  // 3. the question: the chat made a todo by hand (the tag after its name); its row's text, then select and edit on two clicks
  await page.evaluate(text => void window._item('#waits_b/0', true)!.write(text, ''), CHAT_B.replace('#waits_b/0 ', '#waits_b/0 #todo '))
  await saved()
  const questionRow = main.locator('.list-item-container', { hasText: '#waits_b/0' })
  await expect(questionRow, 'the chat-todo has a row in the main list').toHaveCount(1, { timeout: 30_000 })
  await expect
    .poll(async () => (await questionRow.locator('.list-item').innerText()).replace(/\u200e/g, '').replace(/\s+/g, ' ').trim(), {
      message: 'the chat-todo row shows the start of its first user turn after its name',
      timeout: 15_000,
    })
    .toBe(`#waits_b/0 #todo ${QUESTION.replace(/\s+/g, ' ')}`)
  await main.scrollIntoViewIfNeeded()
  const qItem = questionRow.locator('.list-item')
  const qBox1 = (await qItem.boundingBox())!
  await qItem.click({ position: { x: qBox1.width - 12, y: qBox1.height / 2 } })
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.container.target')?.getAttribute('data-item-id') === window._item('#waits_b/0', true)?.id), {
      message: "the chat-todo row's first click selects the item",
      timeout: 15_000,
    })
    .toBe(true)
  await page.waitForTimeout(400) // settle past the drag-release click guard
  await main.scrollIntoViewIfNeeded()
  const qBox2 = (await qItem.boundingBox())!
  await qItem.click({ position: { x: qBox2.width - 12, y: qBox2.height / 2 } })
  // the TURN's stretch, where the turn holds it (the delimiter right before it): not the first
  // occurrence of its words in the item, which stands in the inert body above the turn
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const area = document.querySelector('.container.target textarea') as HTMLTextAreaElement | null
          if (!area) return null
          const clean = (text: string) => text.replace(/\u200b/g, '')
          return [clean(area.value.slice(area.selectionStart, area.selectionEnd)), clean(area.value.slice(0, area.selectionStart)).split('\n').at(-1)]
        }),
      { message: "the chat-todo row's second click opens the editor with the question selected where its turn holds it", timeout: 15_000 }
    )
    .toEqual([QUESTION, '<<user>> '])
  await page.keyboard.press('Escape')
  await expect(page.locator('.container.target textarea'), 'Escape closes the chat-todo editor').toHaveCount(0, { timeout: 10_000 })
  await page.evaluate(() => void (window as any).MindBox.set(''))

  // 4. a todo's bell: projection surfaced=1 rings question, click clears across reload, surfaced=2 rings again
  await page.evaluate(() => void window._create('#waits_t/0 #todo ask me something'))
  await expect.poll(() => savedId(page, '#waits_t/0'), { message: 'bell todo saved', timeout: 30_000 }).toBeTruthy()
  const todoId = (await savedId(page, '#waits_t/0'))!
  const state = (held: string, reason: string, surfaced: number, rev = surfaced + 1) => ({ held, reason, epoch: 1, rev, surfaced, updated: Date.now() })
  const todoStoreDoc = (await storeDocId(`global_store_${todoId}`, WAITS_USER, WAITS_SECRET)) ?? 'e2e-waits-store-t'
  await writeStore(todoStoreDoc, `global_store_${todoId}`, { _agent: { state: state('owner', 'question', 1) } }, WAITS_USER, WAITS_SECRET)
  const bellRow = main.locator('.list-item-container', { hasText: 'ask me something' })
  await expect(bellRow.locator('mark.waits'), 'a todo with surfaced=1 (owner question) shows a bell saying question').toHaveText('question', { timeout: 30_000 })
  await main.scrollIntoViewIfNeeded()
  await bellRow.locator('mark.waits').click()
  await expect(bellRow.locator('mark.waits'), "the bell's click removes the todo's bell").toHaveCount(0, { timeout: 15_000 })
  await expect(bellRow, "clearing a todo's bell keeps its row").toHaveCount(1)
  await expect
    .poll(async () => (await serverStore(`global_store_${todoId}`, WAITS_USER, WAITS_SECRET))?._todoer?.bell ?? null, {
      message: "the todo's store holds the cleared bell count",
      timeout: 30_000,
    })
    .toBe(1)
  await saved()
  await page.reload()
  await loaded(page)
  await expect.poll(() => page.locator('.todoer-widget').count(), { message: 'both widgets mounted after second reload', timeout: 30_000 }).toBe(2)
  await expect(bellRow, 'the todo row stays listed after a reload').toHaveCount(1, { timeout: 30_000 })
  await expect
    .poll(() => page.evaluate(id => (store => [store?._agent?.state?.surfaced ?? null, store?._todoer?.bell ?? null])((window._item('id:' + id, true) as any)?._global_store), todoId), {
      message: 'the reloaded tab holds the count the todo came up at and its clear',
      timeout: 30_000,
    })
    .toEqual([1, 1])
  await page.evaluate(() => (window._item('#todoer') as any).eval('_rerender_todoer_widgets()'))
  await expect(bellRow.locator('mark.waits'), 'after a reload the cleared todo has no bell').toHaveCount(0)
  const kept = ((await serverStore(`global_store_${todoId}`, WAITS_USER, WAITS_SECRET)) ?? {})._todoer ?? {}
  const todoStoreDoc2 = (await storeDocId(`global_store_${todoId}`, WAITS_USER, WAITS_SECRET)) ?? todoStoreDoc
  await writeStore(todoStoreDoc2, `global_store_${todoId}`, { _todoer: kept, _agent: { state: state('owner', 'blocked', 2) } }, WAITS_USER, WAITS_SECRET)
  await expect(bellRow.locator('mark.waits'), 'raising the surfaced count to two rings the todo bell again').toHaveText('blocked', { timeout: 30_000 })

  // 5. a check-in: /notify on checkin, delegated todo surfaced 0 -> 1 rings checkin and notifies once (non-sticky); same count later does not
  await page.evaluate(() => {
    const shown: any[] = ((window as any).__notified = [])
    class Recorder {
      static permission = 'default'
      static async requestPermission() {
        Recorder.permission = 'granted'
        return 'granted'
      }
      closed = false
      onclick: (() => void) | null = null
      constructor(public title: string, public options: any) {
        shown.push(this)
      }
      close() {
        this.closed = true
      }
    }
    ;(window as any).Notification = Recorder
  })
  expect(await command(page, '/notify on checkin'), '/notify on checkin succeeds').toBeNull()
  await expect
    .poll(() => rowDialogs.at(-1) ?? '', { message: '/notify on checkin enables checkin with granted permission', timeout: 10_000 })
    .toMatch(/on for .*checkin.*this device: granted/)
  await page.evaluate(() => void window._create('#waits_d/0 #todo do the delegated work'))
  await expect.poll(() => savedId(page, '#waits_d/0'), { message: 'delegated todo saved', timeout: 30_000 }).toBeTruthy()
  const workId = (await savedId(page, '#waits_d/0'))!
  const workStoreDoc = (await storeDocId(`global_store_${workId}`, WAITS_USER, WAITS_SECRET)) ?? 'e2e-waits-store-d'
  await writeStore(workStoreDoc, `global_store_${workId}`, { _agent: { state: state('agent', 'delegated', 0, 1) } }, WAITS_USER, WAITS_SECRET)
  const workRow = delegated.locator('.list-item-container', { hasText: 'do the delegated work' })
  await expect(workRow, 'the agent-held todo is listed in the delegated widget').toHaveCount(1, { timeout: 30_000 })
  await expect
    .poll(() => page.evaluate(id => (window._item('#todoer') as any)?.store?.notify_seen?.[window._item('id:' + id, true)?.id ?? ''] ?? null, workId), {
      message: 'the notifier recorded the delegated todo at surfaced=0',
      timeout: 30_000,
    })
    .toBe('agent:delegated:1:0|delegated')
  const notified = () => page.evaluate(() => ((window as any).__notified as any[]).map(n => ({ title: n.title, requireInteraction: n.options.requireInteraction })))
  expect(await notified(), 'no notification before the check-in').toEqual([])
  await writeStore(workStoreDoc, `global_store_${workId}`, { _agent: { state: state('agent', 'delegated', 1, 2) } }, WAITS_USER, WAITS_SECRET)
  await expect(workRow.locator('mark.waits'), 'a check-in shows a bell saying checkin in the delegated list').toHaveText('checkin', { timeout: 30_000 })
  await expect
    .poll(notified, { message: 'a check-in gives one non-sticky [checkin] notification', timeout: 30_000 })
    .toEqual([{ title: '[checkin] do the delegated work', requireInteraction: false }])
  // a later change with the SAME count that changes what the notifier records of the todo (its
  // epoch): once the notifier has recorded it, no second notification stands
  await writeStore(workStoreDoc, `global_store_${workId}`, { _agent: { state: { ...state('agent', 'delegated', 1, 9), epoch: 2 } } }, WAITS_USER, WAITS_SECRET)
  await expect
    .poll(() => page.evaluate(id => (window._item('#todoer') as any)?.store?.notify_seen?.[window._item('id:' + id, true)?.id ?? ''] ?? null, workId), {
      message: 'the notifier recorded the later change with the same count',
      timeout: 30_000,
    })
    .toBe('agent:delegated:2:1|delegated')
  expect(await notified(), 'a later projection change with the same count gives no second notification').toHaveLength(1)
  await expect(workRow.locator('mark.waits'), 'after a later projection change with the same count the checkin bell stays').toHaveText('checkin')

  // 6. /notify test <name>: unknown item is refused (alert + command kept); known item arms one
  //    5000 ms timer and shows nothing at once; releasing that held timer shows the sample card
  //    with the item's tag and data, and clicking it selects the item (literal 4999/5000 ms
  //    delay is pinned in external/mind.items/tests/todoer_test.js)
  const notifiedTest = () =>
    page.evaluate(() =>
      ((window as any).__notified as any[]).map(n => ({
        title: n.title,
        tag: n.options.tag,
        body: n.options.body,
        data: n.options.data,
        closed: n.closed,
      })),
    )
  await page.evaluate(() => void ((window as any).__notified.length = 0))
  const dlgBeforeUnknown = rowDialogs.length
  expect(await command(page, '/notify test #waits_missing'), 'unknown item command returned to box').toBeNull()
  await expect.poll(() => page.evaluate(() => (window as any).MindBox.get()), { message: 'unknown item keeps the command in the box', timeout: 10_000 }).toBe('/notify test #waits_missing')
  expect(rowDialogs.slice(dlgBeforeUnknown), 'unknown item alerts').toEqual(['/notify: no item is named #waits_missing'])
  await userSet(page, '')
  await page.evaluate(() => {
    const w = window as any
    const held: { id: number; ms: number; cb: (...args: unknown[]) => void; args: unknown[] }[] = (w.__rk_held = [])
    const origSet = (w.__rk_origSet = window.setTimeout)
    const origClear = (w.__rk_origClear = window.clearTimeout)
    let nextId = 1 << 30
    ;(window as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      ms == 5000 ? (held.push({ id: ++nextId, ms, cb, args }), nextId) : origSet(cb, ms, ...args)
    ;(window as any).clearTimeout = (id?: number) => {
      const i = held.findIndex(h => h.id == id)
      i >= 0 ? held.splice(i, 1) : origClear(id)
    }
  })
  try {
    expect(await command(page, '/notify test #waits_t/0'), '/notify test <name> command accepted').toBeNull()
    expect(await notifiedTest(), '/notify test <name> shows nothing at once').toEqual([])
    expect(await page.evaluate(() => (window as any).__rk_held.map((h: any) => h.ms)), '/notify test <name> arms one 5000 ms timer').toEqual([5000])
    await page.evaluate(() => {
      const w = window as any
      if (w.__rk_origSet) window.setTimeout = w.__rk_origSet
      if (w.__rk_origClear) window.clearTimeout = w.__rk_origClear
      delete w.__rk_origSet
      delete w.__rk_origClear
      for (const h of w.__rk_held.splice(0)) h.cb(...h.args)
    })
  } finally {
    await page.evaluate(() => {
      const w = window as any
      if (w.__rk_origSet) window.setTimeout = w.__rk_origSet
      if (w.__rk_origClear) window.clearTimeout = w.__rk_origClear
      delete w.__rk_origSet
      delete w.__rk_origClear
      delete w.__rk_held
    })
  }
  await expect
    .poll(() => notifiedTest().then(n => n.length), { message: '/notify test <name> shows one notification when its timer fires', timeout: 10_000 })
    .toBe(1)
  expect(await notifiedTest(), '/notify test <name> carries the item tag and data').toEqual([
    {
      title: '[blocked] ask me something',
      tag: `todoer:${todoId}`,
      body: '#waits_t/0',
      data: { source: 'todoer', item: todoId },
      closed: false,
    },
  ])
  await page.evaluate(() => (window as any).__notified[0].onclick())
  await expect
    .poll(() => page.evaluate(() => (window as any).MindBox.get().trim()), { message: 'clicking the test notification selects the item', timeout: 10_000 })
    .toBe('#waits_t/0')
  expect((await notifiedTest())[0]!.closed, 'clicked test notification is closed').toBe(true)

  // 7. agent-written item rows: a stamp in #todoer's store (`_agent.wrote`, mind_item.py shape)
  //    shows an `item` bell row in the main list even with `/notify` off, `b` clears it without
  //    touching item text, a second stamp brings it back, and a user edit removes the row
  expect(await command(page, '/notify off'), '/notify off succeeds before item-row step').toBeNull()
  await expect
    .poll(() => rowDialogs.at(-1) ?? '', { message: '/notify off reports notifications off', timeout: 10_000 })
    .toBe('notifications: off')
  await expect
    .poll(async () => (await serverStore(`global_store_${todoerId}`, WAITS_USER, WAITS_SECRET))?.notify ?? null, {
      message: '/notify off persisted on the server before stamping',
      timeout: 30_000,
    })
    .toBeNull()
  await page.evaluate(() => void ((window as any).__notified.length = 0))
  const ITEM_TEXT = '#waits_item\n<!-- hidden comment -->\nAgent wrote this note.\nSecond line.'
  await page.evaluate(text => void window._create(text), ITEM_TEXT)
  await expect.poll(() => savedId(page, '#waits_item'), { message: 'agent-written item saved', timeout: 30_000 }).toBeTruthy()
  const agentItemId = (await savedId(page, '#waits_item'))!
  await saved()
  const stampItem = async (itemId: string, text: string, at: number, author = 'claude') => {
    const current = (await serverStore(`global_store_${todoerId}`, WAITS_USER, WAITS_SECRET)) ?? {}
    const docId = (await storeDocId(`global_store_${todoerId}`, WAITS_USER, WAITS_SECRET)) ?? todoerStoreDoc0
    const prevWrote = current._agent?.wrote && typeof current._agent.wrote == 'object' ? current._agent.wrote : {}
    await writeStore(
      docId,
      `global_store_${todoerId}`,
      {
        ...current,
        _agent: {
          ...(current._agent ?? {}),
          wrote: { ...prevWrote, [itemId]: { by: author, at, hash: await hashOf(text) } },
        },
      },
      WAITS_USER,
      WAITS_SECRET,
    )
  }
  const itemHash1 = await hashOf(ITEM_TEXT)
  const stampAt1 = Date.now()
  await stampItem(agentItemId, ITEM_TEXT, stampAt1)
  const itemRow = main.locator('.list-item-container[data-waits="item"]', { hasText: '#waits_item' })
  await expect(itemRow, 'an item stamped as an agent write gets a row in the main list with /notify off').toHaveCount(1, { timeout: 30_000 })
  expect(await notified(), 'no desktop notification fires for the stamped item while /notify is off').toEqual([])
  await expect(itemRow.locator('mark.waits'), 'the agent-written item row shows a bell saying item').toHaveText('item')
  await expect
    .poll(async () => (await itemRow.locator('.list-item').innerText()).replace(/\s+/g, ' ').trim(), {
      message: 'the item row shows its bell, name, and first visible line without comments or second line',
      timeout: 10_000,
    })
    .toBe('item #waits_item Agent wrote this note.')
  await main.scrollIntoViewIfNeeded()
  const itemCell = itemRow.locator('.list-item')
  const itemBox = (await itemCell.boundingBox())!
  await page.mouse.click(itemBox.x + itemBox.width - 12, itemBox.y + itemBox.height / 2)
  await expect(itemRow, 'clicking the item row selects it').toHaveClass(/(^| )selected( |$)/, { timeout: 10_000 })
  const shortcutSnap = await page.evaluate(() => {
    const row = document.querySelector('.todoer-widget .list-item-container[data-waits="item"].selected')
    const active = ((window as any)._shortcuts?.todoer ?? [])
      .filter((e: any) => e.active())
      .map((e: any) => `${e.keys}:${e.does}`)
    return {
      hasPrev: !!row?.previousElementSibling?.getAttribute('data-id'),
      hasNext: !!row?.nextElementSibling?.getAttribute('data-id'),
      active,
    }
  })
  expect(shortcutSnap.hasPrev || shortcutSnap.hasNext, 'the selected item row has a neighbor in the main list').toBe(true)
  expect(
    shortcutSnap.active,
    'shortcuts menu lists navigation and b:clear the bell alone for a selected item row',
  ).toEqual([
    ...(shortcutSnap.hasNext ? ['j:the next row'] : []),
    ...(shortcutSnap.hasPrev ? ['k:the previous row'] : []),
    'b:clear the bell',
  ])
  await page.keyboard.press('b')
  await expect(itemRow, 'b clears the agent-written item row').toHaveCount(0, { timeout: 15_000 })
  await expect
    .poll(async () => (await serverStore(`global_store_${agentItemId}`, WAITS_USER, WAITS_SECRET))?._todoer?.cleared_items ?? null, {
      message: 'clearing with b records the kinded stamp key in the item store cleared_items field',
      timeout: 30_000,
    })
    .toEqual([`item|${stampAt1}|${itemHash1}`])
  expect(await serverText(agentItemId, WAITS_SECRET), 'clearing an item row with b leaves the item text unchanged').toBe(ITEM_TEXT)

  const ITEM_TEXT2 = '#waits_item\nAgent revised this note.\nSecond line.'
  await rewriteText(agentItemId, () => ITEM_TEXT2, WAITS_SECRET)
  const stampAt2 = stampAt1 + 1000
  await stampItem(agentItemId, ITEM_TEXT2, stampAt2)
  await expect(itemRow, 'a second stamp shows the agent-written item row again').toHaveCount(1, { timeout: 30_000 })
  await expect
    .poll(async () => (await itemRow.locator('.list-item').innerText()).replace(/\s+/g, ' ').trim(), {
      message: 'the row updates to the revised first visible line',
      timeout: 10_000,
    })
    .toBe('item #waits_item Agent revised this note.')

  await page.evaluate(() => void (window as any).MindBox.set('#waits_item'))
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.container.target')?.getAttribute('data-item-id') === window._item('#waits_item', true)?.id), {
      message: '#waits_item is the target item',
      timeout: 15_000,
    })
    .toBe(true)
  const targetArea = page.locator('.container.target textarea')
  await page.locator('.container.target .item').getByText('Agent revised this note.').click()
  await expect(targetArea, 'clicking the item opens its editor').toBeVisible({ timeout: 10_000 })
  await targetArea.fill(ITEM_TEXT2 + '\nOwner reviewed it.')
  await targetArea.press('Shift+Enter')
  await expect(targetArea, 'Shift+Enter saves and closes the editor').toHaveCount(0, { timeout: 15_000 })
  await expect(itemRow, 'editing the item by the user takes the waiting row away').toHaveCount(0, { timeout: 15_000 })
  await saved()
})

// SERVICE-WORKER DESKTOP NOTIFICATIONS (protocol v2: hello handshake; outlive page reload;
// kept-until-received when clicked while reloading before welcome; cold-open stores click addressed
// to the opened window's real clientId; sign-out clears outgoing cards and stored clicks).
// Launches Chrome for Testing (`channel: 'chromium'`, --headless=new) because Playwright's default
// headless shell hardcodes Notification.permission to 'denied' even after granting `notifications`
// permission on the context.
test('a worker notification survives reload, holds clicks across startup and cold open until received, and clears on sign-out', async ({ context: laneContext }, testInfo) => {
  const swBrowser = await chromium.launch({ channel: 'chromium', args: OFFLINE_BROWSER_ARGS })
  try {
    const context = await swBrowser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: await laneContext.storageState(),
      permissions: ['notifications'],
    })
    const page = await context.newPage()
    const rowDialogs: string[] = []
    page.on('dialog', dialog => {
      rowDialogs.push(dialog.message())
      void dialog.accept()
    })
    expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
    await page.addInitScript(() => localStorage.setItem('mindpage_github_token', 'e2e-local'))
    await signIn(page, NOTIFY_SW_USER)
    await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
    await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
    await waitForApp(page)
    const saved = (p: Page = page) =>
      expect.poll(() => p.evaluate(() => window.__items.every(item => item.savedId && !item.saving)), { message: 'all items saved', timeout: 60_000 }).toBe(true)

    expect(await install(page, 'todoer'), '/_install todoer').toBeNull()
    await saved()
    await page.reload()
    await loaded(page)
    await page.evaluate(() => (window._item('#todoer') as any).eval('create_pinned_item()'))
    await expect.poll(() => page.locator('.todoer-widget').count(), { message: 'both todoer widgets mounted', timeout: 30_000 }).toBe(2)
    await saved()

    // confirm the production/test build registered `/service-worker.js`, granted real permission,
    // and the active worker answered the protocol v2 `hello` handshake setting the page mark
    expect(await page.evaluate(() => Notification.permission), 'context granted real Notification.permission').toBe('granted')
    const regInfo = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      return { active: !!reg.active, scriptURL: reg.active?.scriptURL ?? null }
    })
    expect(regInfo.active, 'the test build registers an active service worker').toBe(true)
    expect(regInfo.scriptURL).toMatch(/\/service-worker\.js$/)
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { _notification_click_relay?: string })._notification_click_relay ?? null), {
        message: 'active worker answered hello and page set _notification_click_relay',
        timeout: 10_000,
      })
      .toBe('mindpage:notificationclick')

    // enable notifications (no window.Notification stub: real browser permission + real worker)
    expect(await command(page, '/notify on'), '/notify on succeeds').toBeNull()
    await expect
      .poll(() => rowDialogs.at(-1) ?? '', { message: '/notify on reports granted permission', timeout: 10_000 })
      .toBe('notifications: on for question, blocked, proposal, budget, done, reply, item; this device: granted')

    const SW_TODO = '#e2e_sw_notify'
    await page.evaluate(text => void window._create(text), `${SW_TODO}\n#todo survive page reload`)
    await expect.poll(() => savedId(page, SW_TODO), { message: 'todo saved', timeout: 30_000 }).toBeTruthy()
    const todoId = (await savedId(page, SW_TODO))!
    await saved()
    await expect
      .poll(() => page.evaluate(id => (window._item('#todoer') as any)?.store?.notify_seen?.[window._item('id:' + id, true)?.id ?? ''] ?? null, todoId), {
        message: 'notifier recorded initial todo state',
        timeout: 30_000,
      })
      .toBe('|main')

    const sw = context.serviceWorkers().find(w => w.url().endsWith('/service-worker.js')) ?? (await context.waitForEvent('serviceworker'))
    const box = (p: Page = page) => p.evaluate(() => (window as any).MindBox.get())
    const swNotifications = (tag?: string) =>
      sw.evaluate(async t => {
        const g = globalThis as any
        const list = await g.registration.getNotifications(t ? { tag: t } : undefined)
        return list.map((n: any) => ({ title: n.title, tag: n.tag, body: n.body, requireInteraction: n.requireInteraction, data: n.data }))
      }, tag)
    const dispatchClick = (tag: string) =>
      sw.evaluate(async t => {
        const g = globalThis as any
        const list = await g.registration.getNotifications({ tag: t })
        if (list.length !== 1) return { count: list.length }
        g.dispatchEvent(new g.NotificationEvent('notificationclick', { notification: list[0] }))
        return { count: list.length }
      }, tag)
    const pendingRows = () =>
      sw.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('mindpage-notification-clicks', 1)
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains('pending')) req.result.createObjectStore('pending', { keyPath: 'seq', autoIncrement: true })
          }
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        try {
          return await new Promise<Array<{ id: string; clientId: string | null; tag: string; item: unknown }>>((resolve, reject) => {
            const tx = db.transaction('pending', 'readonly')
            const req = tx.objectStore('pending').getAll()
            req.onsuccess = () =>
              resolve(
                (req.result as any[]).map(r => ({
                  id: r.id,
                  clientId: r.clientId,
                  tag: r.message?.tag ?? '',
                  item: r.message?.data?.item ?? null,
                }))
              )
            tx.onerror = () => reject(tx.error)
          })
        } finally {
          db.close()
        }
      })
    const windowClientIds = () =>
      sw.evaluate(async () => {
        const g = globalThis as any
        const wins = await g.clients.matchAll({ type: 'window', includeUncontrolled: true })
        return wins.map((w: any) => w.id as string)
      })
    // Hold Firestore's Listen channel on `p` so a reload initializes from its persistent cache
    // while `settleCorpusForWelcome()` stays paused (welcome and `_start_notifier` have not run).
    const LISTEN = /Firestore\/Listen\/channel/
    const holdListen = async (p: Page) => {
      let release!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      await p.route(LISTEN, async route => {
        await gate
        await route.continue().catch(() => {})
      })
      return async () => {
        release()
        await p.unroute(LISTEN).catch(() => {})
      }
    }

    const state = (reason: string, epoch: number, rev: number, surfaced: number) => ({
      _agent: { state: { held: 'owner', reason, epoch, rev, surfaced, updated: Date.now(), worktree: null, phase: 'idle', acked: {} } },
    })

    // 1. Hand-back triggers a worker notification (read back via registration.getNotifications)
    await writeStore('e2e-sw-notify-store', `global_store_${todoId}`, state('question', 1, 1, 1), NOTIFY_SW_USER, NOTIFY_SW_SECRET)
    const expectedNote = [{ title: '[question] survive page reload', tag: `todoer:${todoId}`, body: SW_TODO, requireInteraction: true, data: { source: 'todoer', item: todoId } }]
    await expect
      .poll(() => swNotifications(`todoer:${todoId}`), { message: 'todoer notification shown through the service worker', timeout: 30_000 })
      .toEqual(expectedNote)

    // 2. RELOAD THE PAGE: notification survives ordinary same-account reload; worker delivers click
    //    once the reloaded page is ready, deletes stored click on `received`, and preserves Back
    await page.reload()
    await loaded(page)
    await expect.poll(() => page.locator('.todoer-widget').count(), { message: 'widgets mounted after reload', timeout: 30_000 }).toBe(2)
    await expect
      .poll(() => page.evaluate(id => !!(window._item('#todoer') as any)?.store?.notify_seen?.[id], todoId), {
        message: 'reloaded tab ran _start_notifier and attached its worker message listener',
        timeout: 30_000,
      })
      .toBe(true)
    expect(await swNotifications(`todoer:${todoId}`), 'worker notification survives a page reload').toEqual(expectedNote)

    expect(await box(), 'MindBox starts empty after reload').toBe('')
    expect(await dispatchClick(`todoer:${todoId}`), 'worker located the surviving notification and dispatched notificationclick').toEqual({ count: 1 })
    await expect.poll(() => swNotifications(`todoer:${todoId}`), { message: 'worker closed the clicked notification', timeout: 10_000 }).toEqual([])
    await expect.poll(() => box(), { message: 'reloaded page received click message and selected the todo', timeout: 15_000 }).toMatch(new RegExp(`^${SW_TODO} ?$`))
    expect(
      await page.evaluate(id => document.querySelector('.container.target')?.getAttribute('data-item-id') === window._item('id:' + id, true)?.id, todoId),
      'selected item is the page target'
    ).toBe(true)
    await expect.poll(() => pendingRows(), { message: 'worker deleted stored click after received', timeout: 10_000 }).toEqual([])
    await page.goBack()
    await expect.poll(() => box(), { message: 'Back returns to the view from before the worker notification click', timeout: 10_000 }).toBe('')

    // 3. CLICK DELIVERED WHILE THE RELOADED PAGE HAS NOT YET REACHED ITS WELCOME:
    //    hold Firestore's Listen channel across reload so the page loads from cache but pauses
    //    inside settleCorpusForWelcome (todoer click listener not attached yet); the worker probes,
    //    gets no `received`, keeps the click stored addressed to that window, and delivers it once
    //    welcome finishes and todoer posts `ready`.
    const storeDoc = (await storeDocId(`global_store_${todoId}`, NOTIFY_SW_USER, NOTIFY_SW_SECRET)) ?? 'e2e-sw-notify-store'
    await writeStore(storeDoc, `global_store_${todoId}`, state('blocked', 2, 2, 2), NOTIFY_SW_USER, NOTIFY_SW_SECRET)
    await expect
      .poll(() => swNotifications(`todoer:${todoId}`), { message: 'second worker notification shown', timeout: 30_000 })
      .toEqual([{ title: '[blocked] survive page reload', tag: `todoer:${todoId}`, body: SW_TODO, requireInteraction: true, data: { source: 'todoer', item: todoId } }])

    let releaseReload = await holdListen(page)
    try {
      await page.reload()
      await expect.poll(() => page.evaluate(() => (window._init_time ?? 0) > 0 && (window.__items?.length ?? 0) > 0), {
        message: 'reloaded page hydrated from persistent cache while welcome is held',
        timeout: 30_000,
      }).toBe(true)
      expect(
        await page.evaluate(() => ({
          confirmed: !!(window as any)._server_confirmed,
          notifierStarted: !!(window._item('#todoer') as any)?.store?.notify_seen,
        })),
        'welcome has not yet run (todoer listener not attached)'
      ).toEqual({ confirmed: false, notifierStarted: false })
      expect(await swNotifications(`todoer:${todoId}`), 'notification survived held reload').toHaveLength(1)

      const reloadingClientIds = await windowClientIds()
      expect(reloadingClientIds, 'one reloading window client exists').toHaveLength(1)
      expect(await dispatchClick(`todoer:${todoId}`), 'dispatched click while welcome is held').toEqual({ count: 1 })
      await expect.poll(() => swNotifications(`todoer:${todoId}`), { message: 'worker closed clicked notification during held reload', timeout: 10_000 }).toEqual([])
      await expect
        .poll(() => pendingRows(), { message: 'worker kept unacknowledged click in IndexedDB unassigned', timeout: 10_000 })
        .toEqual([{ id: expect.any(String), clientId: null, tag: `todoer:${todoId}`, item: todoId }])
      expect(await box(), 'page has not handled the click before welcome').toBe('')
    } finally {
      await releaseReload()
    }
    await expect.poll(() => box(), { message: 'after welcome released, reloaded page received held click and selected the todo', timeout: 30_000 }).toMatch(new RegExp(`^${SW_TODO} ?$`))
    expect(
      await page.evaluate(id => document.querySelector('.container.target')?.getAttribute('data-item-id') === window._item('id:' + id, true)?.id, todoId),
      'selected item is the page target after held-welcome delivery'
    ).toBe(true)
    await expect.poll(() => pendingRows(), { message: 'worker deleted held click after received', timeout: 10_000 }).toEqual([])
    await page.goBack()
    await expect.poll(() => box(), { message: 'Back returns after held-welcome click', timeout: 10_000 }).toBe('')

    // 4. COLD OPEN: store the click as the worker REALLY does (no hand-inserted IDB row).
    //    Close every window, bridge clients.openWindow inside the worker to Playwright's context.newPage()
    //    (synthetic NotificationEvent lacks native OS activation for openWindow), dispatch a real
    //    notificationclick on the worker, verify the worker persists the click addressed to the opened
    //    window's real clientId, and confirm the opened window drains and acknowledges it on ready.
    await writeStore(storeDoc, `global_store_${todoId}`, state('proposal', 3, 3, 3), NOTIFY_SW_USER, NOTIFY_SW_SECRET)
    await expect
      .poll(() => swNotifications(`todoer:${todoId}`), { message: 'third worker notification shown for cold open', timeout: 30_000 })
      .toEqual([{ title: '[proposal] survive page reload', tag: `todoer:${todoId}`, body: SW_TODO, requireInteraction: true, data: { source: 'todoer', item: todoId } }])

    await page.close()
    await expect.poll(() => windowClientIds(), { message: 'all windows closed before cold open', timeout: 15_000 }).toEqual([])

    let page2: Page | null = null
    let releasePage2: (() => Promise<void>) | null = null
    await sw.evaluate(() => {
      const g = globalThis as any
      g.__origOpenWindow = g.clients.openWindow.bind(g.clients)
      g.__openRequestedUrl = null
      g.__resolveOpen = null
      g.clients.openWindow = (url: string) => {
        g.__openRequestedUrl = url
        return new Promise(resolve => {
          g.__resolveOpen = resolve
        })
      }
    })
    try {
      expect(await dispatchClick(`todoer:${todoId}`), 'worker dispatched cold-open notificationclick').toEqual({ count: 1 })
      await expect.poll(() => swNotifications(`todoer:${todoId}`), { message: 'worker closed cold-open notification', timeout: 10_000 }).toEqual([])
      await expect
        .poll(() => sw.evaluate(() => (globalThis as any).__openRequestedUrl as string | null), {
          message: 'worker called clients.openWindow with registration.scope',
          timeout: 10_000,
        })
        .toBe(`${testInfo.project.use.baseURL}/`)

      page2 = await context.newPage()
      releasePage2 = await holdListen(page2)
      await page2.goto(`${testInfo.project.use.baseURL}/`)
      await expect.poll(() => windowClientIds(), { message: 'newly opened tab appeared as a window client', timeout: 15_000 }).toHaveLength(1)
      const [page2ClientId] = await windowClientIds()
      // Resolve openWindow with page2's real WindowClient so the worker runs assignUnassigned with its real clientId
      await sw.evaluate(async id => {
        const g = globalThis as any
        const wins = await g.clients.matchAll({ type: 'window', includeUncontrolled: true })
        const win = wins.find((w: any) => w.id === id) ?? null
        g.__resolveOpen?.(win)
      }, page2ClientId)

      await expect
        .poll(() => pendingRows(), { message: 'worker stored cold-open click addressed to the opened window real clientId', timeout: 10_000 })
        .toEqual([{ id: expect.any(String), clientId: page2ClientId, tag: `todoer:${todoId}`, item: todoId }])

      await releasePage2()
      releasePage2 = null
      await loaded(page2)
      await expect.poll(() => box(page2!), { message: 'cold-opened window drained its click once ready and selected the todo', timeout: 30_000 }).toMatch(new RegExp(`^${SW_TODO} ?$`))
      expect(
        await page2.evaluate(id => document.querySelector('.container.target')?.getAttribute('data-item-id') === window._item('id:' + id, true)?.id, todoId),
        'cold-opened window targeted the item'
      ).toBe(true)
      await expect.poll(() => pendingRows(), { message: 'worker deleted cold-open click after received', timeout: 10_000 }).toEqual([])

      // 4b. /notify test <name> through the worker's path: hold the command's 5000 ms timer,
      //     assert nothing shows at once, release it, and assert the worker card and relayed click
      await userSet(page2, '')
      await expect.poll(() => box(page2!), { timeout: 5_000 }).toBe('')
      await page2.evaluate(() => {
        const w = window as any
        const held: { id: number; ms: number; cb: (...args: unknown[]) => void; args: unknown[] }[] = (w.__rk_held = [])
        const origSet = (w.__rk_origSet = window.setTimeout)
        const origClear = (w.__rk_origClear = window.clearTimeout)
        let nextId = 1 << 30
        ;(window as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
          ms == 5000 ? (held.push({ id: ++nextId, ms, cb, args }), nextId) : origSet(cb, ms, ...args)
        ;(window as any).clearTimeout = (id?: number) => {
          const i = held.findIndex(h => h.id == id)
          i >= 0 ? held.splice(i, 1) : origClear(id)
        }
      })
      try {
        expect(await command(page2, `/notify test ${SW_TODO}`), '/notify test <name> accepted on worker page').toBeNull()
        expect(await swNotifications(`todoer:${todoId}`), 'worker /notify test <name> shows nothing at once').toEqual([])
        expect(await page2.evaluate(() => (window as any).__rk_held.map((h: any) => h.ms)), 'worker /notify test <name> arms one 5000 ms timer').toEqual([5000])
        await page2.evaluate(() => {
          const w = window as any
          if (w.__rk_origSet) window.setTimeout = w.__rk_origSet
          if (w.__rk_origClear) window.clearTimeout = w.__rk_origClear
          delete w.__rk_origSet
          delete w.__rk_origClear
          for (const h of w.__rk_held.splice(0)) h.cb(...h.args)
        })
      } finally {
        await page2.evaluate(() => {
          const w = window as any
          if (w.__rk_origSet) window.setTimeout = w.__rk_origSet
          if (w.__rk_origClear) window.clearTimeout = w.__rk_origClear
          delete w.__rk_origSet
          delete w.__rk_origClear
          delete w.__rk_held
        })
      }
      await expect
        .poll(() => swNotifications(`todoer:${todoId}`), { message: 'worker /notify test <name> shows notification when its timer fires', timeout: 15_000 })
        .toEqual([{ title: '[proposal] survive page reload', tag: `todoer:${todoId}`, body: SW_TODO, requireInteraction: true, data: { source: 'todoer', item: todoId } }])
      expect(await dispatchClick(`todoer:${todoId}`), 'dispatched worker click on /notify test <name> card').toEqual({ count: 1 })
      await expect.poll(() => box(page2!), { message: 'relayed worker click on /notify test <name> selects the item', timeout: 10_000 }).toMatch(new RegExp(`^${SW_TODO} ?$`))
      await expect.poll(() => swNotifications(`todoer:${todoId}`), { message: 'worker closed clicked /notify test <name> card', timeout: 10_000 }).toEqual([])

      // 5. SIGN-OUT CLEARS OUTGOING WORKER NOTIFICATIONS AND STORED CLICKS:
      //    seed one active worker notification (`/notify test`) and one real worker-stored click
      //    (clicked during a held-welcome reload), then run `/_signout`; both must be gone after sign-out.
      const page2Dialogs: string[] = []
      page2.on('dialog', dialog => {
        page2Dialogs.push(dialog.message())
        void dialog.accept()
      })
      await writeStore(storeDoc, `global_store_${todoId}`, state('budget', 4, 4, 4), NOTIFY_SW_USER, NOTIFY_SW_SECRET)
      await expect.poll(() => swNotifications(`todoer:${todoId}`), { message: 'fourth worker notification shown before sign-out check', timeout: 30_000 }).toHaveLength(1)
      expect(await command(page2, '/notify test'), '/notify test shows second worker card').toBeNull()
      await expect.poll(() => swNotifications('todoer:test'), { message: 'test notification active on worker', timeout: 15_000 }).toHaveLength(1)

      releasePage2 = await holdListen(page2)
      await page2.reload()
      await expect.poll(() => page2!.evaluate(() => (window._init_time ?? 0) > 0 && (window.__items?.length ?? 0) > 0), {
        message: 'page2 hydrated from cache before sign-out',
        timeout: 30_000,
      }).toBe(true)
      expect(await dispatchClick(`todoer:${todoId}`), 'clicked one card during held reload so IDB holds a real pending click').toEqual({ count: 1 })
      await expect.poll(() => pendingRows(), { message: 'one real worker-stored click pending before sign-out', timeout: 10_000 }).toHaveLength(1)
      expect(await swNotifications('todoer:test'), 'other worker card still active before sign-out').toHaveLength(1)

      await page2.evaluate(() => void window._create('/_signout', { command: true }))
      await releasePage2()
      releasePage2 = null
      await expect.poll(() => page2!.evaluate(() => (window as any)._readonly === true && (window._init_time ?? 0) > 0).catch(() => false), {
        message: 'page2 completed sign-out reload',
        timeout: 60_000,
      }).toBe(true)
      await expect.poll(() => swNotifications(), { message: 'sign-out closed outgoing worker notifications', timeout: 10_000 }).toEqual([])
      await expect.poll(() => pendingRows(), { message: 'sign-out dropped outgoing stored pending clicks', timeout: 10_000 }).toEqual([])
    } finally {
      if (releasePage2) await releasePage2()
      await sw
        .evaluate(() => {
          const g = globalThis as any
          if (g.__origOpenWindow) g.clients.openWindow = g.__origOpenWindow
          delete g.__origOpenWindow
          delete g.__openRequestedUrl
          delete g.__resolveOpen
        })
        .catch(() => {})
      if (page2) await page2.close().catch(() => {})
    }
  } finally {
    await swBrowser.close()
  }
})

// pictures of selected-row states, written only where TASKS_SHOTS names a directory for them
const TASKS_SHOTS = process.env.TASKS_SHOTS
const taskShot = async (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
  if (!TASKS_SHOTS) return
  mkdirSync(TASKS_SHOTS, { recursive: true })
  await page.screenshot({ path: resolve(TASKS_SHOTS, `${name}.png`), ...(clip ? { clip } : {}) })
}

// BIN BUTTONS, j/k ROW KEYS, SELECT-NEXT AFTER ACTIONS, AND SELECTED ROW BAR (2026-11-24):
// runs in a desktop context with `hasTouch: false` (this spec's file-level `test.use` enables touch
// for phase c4, which would otherwise make `(pointer: coarse)` true) so wide/narrow desktop layout
// and mouse-sized corner buttons are genuinely exercised. The next row reuses BIN_USER on a
// phone-sized coarse-pointer touch page.
test('bin buttons on wide and narrow windows, j/k row keys, select-next after actions, and selected row bar', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, hasTouch: false })
  const page = await context.newPage()
  const dialogs: string[] = []
  const errors: string[] = []
  const answer = { accept: false }
  page.on('dialog', dialog => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`)
    void (dialog.type() == 'beforeunload' || answer.accept ? dialog.accept() : dialog.dismiss())
  })
  page.on('console', msg => void (msg.type() == 'error' && !/ERR_NAME_NOT_RESOLVED|#template\/example/.test(msg.text()) && errors.push(msg.text())))
  page.on('pageerror', err => void errors.push(`pageerror: ${err.message}`))
  try {
    expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
    await page.addInitScript(() => localStorage.setItem('mindpage_github_token', 'e2e-local'))
    await signIn(page, BIN_USER)
    await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
    await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
    await waitForApp(page)
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'desktop context has fine pointer').toBe(false)
    expect(await install(page, 'todoer'), '/_install todoer').toBeNull()
    expect(await install(page, 'key_buttons'), '/_install key_buttons').toBeNull()
    expect(await install(page, 'vault'), '/_install vault').toBeNull()
    const saved = () =>
      expect
        .poll(() => page.evaluate(() => window.__items.every(item => item.savedId && !item.saving)), { message: 'all items saved', timeout: 60_000 })
        .toBe(true)
    await saved()
    // Install a recording window._on_key BEFORE the reload so #todoer wraps it on load
    await page.addInitScript(() => {
      const w = window as any
      if (w.__rk_prior_installed) return
      w.__rk_prior_installed = true
      const seen: string[] = (w.__rk_prior_keys = [])
      const prev = w._on_key
      w._on_key = (key: string, e: KeyboardEvent) => {
        seen.push(key)
        return typeof prev == 'function' ? prev(key, e) : undefined
      }
    })
    await page.reload()
    await loaded(page)
    // ignore transient dependency-order messages logged while /_install created items one by one
    errors.length = 0
    await page.evaluate(() => (window._item('#todoer') as any).eval('create_pinned_item()'))
    await expect.poll(() => page.locator('.todoer-widget').count(), { message: 'both todoer widgets mounted', timeout: 30_000 }).toBe(2)
    // fresh bridge status so #vault's sparkle is drawn on desktop too (#vault pulls in #status)
    await page.evaluate(() => {
      const s = window._item('#status', true) as any
      const v = window._item('#vault', true) as any
      s._global_store._status = { hosts: { e2e: { publisher: 'bridge', updated: Date.now() } } }
      v._global_store._bridge = { host: 'e2e' }
      ;(window as any)._vault_sparkle?.show?.()
    })
    await expect(page.locator('[data-vault-sparkle="node"]'), 'desktop sparkle visible').toBeVisible()
    const desktopCorners = await page.evaluate(() => {
      const box = (sel: string) => {
        const r = document.querySelector(sel)!.getBoundingClientRect()
        return [Math.round(window.innerWidth - r.right), Math.round(window.innerHeight - r.bottom), Math.round(r.width), Math.round(r.height)]
      }
      return { sparkle: box('[data-vault-sparkle="node"]'), reload: box('[data-key-buttons="reload"]') }
    })
    expect(desktopCorners, 'desktop corner buttons are 24 px, reload a group gap (18 px) left of sparkle').toEqual({
      sparkle: [14, 10, 24, 24],
      reload: [14 + 24 + 18, 10, 24, 24],
    })

    for (const text of ['#done completed items', '#bl_task\n#todo fix the cache', '#bl_other\n#todo write the release note', '#bl_third\n#todo a todo to delete', '#bl_note an item no list holds']) {
      await page.evaluate(text => void window._create(text), text)
    }
    for (const name of ['#bl_task', '#bl_other', '#bl_third', '#bl_note']) {
      await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
    }
    await expect.poll(() => page.locator('.todoer-widget .list-item-container').count(), { timeout: 30_000 }).toBe(3)
    // ensure rows_since and bells_base baselines are recorded before creating the waiting reply chat and todo bell
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const st = (window._item('#todoer') as any)?._global_store
            return (st?.rows_since ?? 0) > 0 && !!st?.bells_base
          }),
        { timeout: 30_000 },
      )
      .toBe(true)
    const REPLY_CHAT = "#bl_reply/0 #_chat #_agent/vault\n<<user>> hi\n<<agent('vault/default · run ab12cd34 · 1s')>>\n<!--inert-->\nThe reply.\n<!--/inert-->"
    await page.evaluate(text => void window._create(text), REPLY_CHAT)
    await expect.poll(() => savedId(page, '#bl_reply/0'), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => page.locator('.todoer-widget').first().locator('.list-item-container').count(), { timeout: 30_000 }).toBe(4)

    // #todoer's own page js_table shows no private bin-button definitions and introduces no missing tags
    const todoerPage = await page.evaluate(() => {
      const t = window._item('#todoer', true) as any
      return { listsPrivate: /_BIN_BUTTONS|_bin_buttons|_BIN_KEYS|_row_buttons/.test(t?.elem?.innerText ?? ''), missing: t?.missingTags ?? [] }
    })
    expect(todoerPage, '#todoer page has no leaked private bin-button definitions or missing tags').toEqual({ listsPrivate: false, missing: [] })

    const guest = (name: string) => page.locator(`.key-buttons-guests > button[data-guest="${name}"]`)
    const guestState = () =>
      page.evaluate(() => {
        const g = document.querySelector('.key-buttons-guests') as HTMLElement | null
        const bg = document.querySelector('.key-buttons-bg') as HTMLElement | null
        const floor = bg?.querySelector('.key-buttons-bg-floor') as HTMLElement | null
        const strip = document.querySelector('.key-buttons-nav') as HTMLElement | null
        const btns = [...(g?.children ?? [])] as HTMLElement[]
        const last = btns[btns.length - 1]?.getBoundingClientRect()
        const firstNav = strip?.children[0]?.getBoundingClientRect()
        return {
          hidden: g?.hidden ?? true,
          cls: g?.className ?? null,
          bgCls: bg?.className ?? null,
          floorShown: !!floor && getComputedStyle(floor).display != 'none',
          ownPiece: !!document.querySelector('.todoer-bin-buttons'),
          names: btns.map(b => b.dataset.guest ?? ''),
          titles: btns.map(b => b.title),
          colors: Object.fromEntries(btns.map(b => [b.dataset.guest ?? '', getComputedStyle(b).color])),
          gapToStrip: last && firstNav ? Math.round(firstNav.left - last.right) : null,
        }
      })
    const mainRowNames = () =>
      page.evaluate(() => {
        const main = [...document.querySelectorAll('.todoer-widget')].find((w: any) => !w._snoozed && !w._delegated)
        return [...(main?.querySelectorAll('.list .list-item-container[data-id]') ?? [])].map(r => window._item(r.getAttribute('data-id')!, true)?.name ?? null)
      })
    const boxNow = () => page.evaluate(() => (window as any).MindBox.get().trim())
    const unfocus = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    const itemText = (name: string) =>
      page.evaluate(name => {
        const it = (window as any).__items.find((i: any) => i.name == name)
        return it ? { text: it.text, saved: it.savedText, editing: !!it.editing } : null
      }, name)

    // 1. j and k shortcuts + up/down buttons (Point 5)
    const rows0 = await mainRowNames()
    expect(rows0.length, 'four rows in main list').toBe(4)
    expect(await page.evaluate(() => typeof (window as any)._on_key), '_on_key hook installed').toBe('function')
    await userSet(page, '')
    await expect.poll(() => guestState().then(s => s.hidden), { timeout: 5_000 }).toBe(true)
    await unfocus()
    await page.keyboard.press('j')
    await expect.poll(boxNow, { message: 'plain j with no selection selects first row of main list', timeout: 5_000 }).toBe(rows0[0])
    await expect.poll(() => guestState().then(s => [s.colors.up, s.colors.down]), { message: 'first row dims up and lights down', timeout: 5_000 }).toEqual([
      'rgba(255, 255, 255, 0.25)',
      'rgb(255, 255, 255)',
    ])
    await page.keyboard.press('k')
    await page.waitForTimeout(200)
    expect(await boxNow(), 'k at top of list stays on first row').toBe(rows0[0])
    await page.keyboard.press('j')
    await expect.poll(boxNow, { message: 'j steps to second row', timeout: 5_000 }).toBe(rows0[1])
    await page.keyboard.press('k')
    await expect.poll(boxNow, { message: 'k steps back to first row', timeout: 5_000 }).toBe(rows0[0])
    await guest('down').click()
    await expect.poll(boxNow, { message: 'down button steps to second row', timeout: 5_000 }).toBe(rows0[1])
    await guest('up').click()
    await expect.poll(boxNow, { message: 'up button steps back to first row', timeout: 5_000 }).toBe(rows0[0])
    // empty box -> k selects last row of main list; j at bottom stays there
    await userSet(page, '')
    await expect.poll(boxNow, { timeout: 5_000 }).toBe('')
    await unfocus()
    await page.keyboard.press('k')
    await expect.poll(boxNow, { message: 'plain k with no selection selects last row of main list', timeout: 5_000 }).toBe(rows0[3])
    await expect.poll(() => guestState().then(s => [s.colors.up, s.colors.down]), { message: 'last row lights up and dims down', timeout: 5_000 }).toEqual([
      'rgb(255, 255, 255)',
      'rgba(255, 255, 255, 0.25)',
    ])
    await page.keyboard.press('j')
    await page.waitForTimeout(200)
    expect(await boxNow(), 'j at bottom of list stays on last row').toBe(rows0[3])
    // unlisted item in box -> treated as no row selected for j/k; guests hidden
    await userSet(page, '#bl_note')
    await expect.poll(() => guestState().then(s => s.hidden), { message: 'unlisted item shows no bin buttons', timeout: 5_000 }).toBe(true)
    await unfocus()
    await page.keyboard.press('j')
    await expect.poll(boxNow, { message: 'j with unlisted item selects first row of main list', timeout: 5_000 }).toBe(rows0[0])
    // modifiers ignored; focused field keeps j
    await userSet(page, '')
    await expect.poll(boxNow, { timeout: 5_000 }).toBe('')
    await unfocus()
    await page.keyboard.press('Shift+J')
    await page.keyboard.press('Control+j')
    await page.waitForTimeout(200)
    expect(await boxNow(), 'modified j/k do not select a row').toBe('')
    await page.locator('.header .backdrop').first().click()
    await expect(page.locator('#textarea-mindbox')).toBeFocused()
    await page.keyboard.press('j')
    expect(await boxNow(), 'focused MindBox keeps typed j').toBe('j')
    await userSet(page, '')
    await unfocus()

    // 2. Selected row bar: 4 px #6c6 bar outside left edge (`box-shadow: -4px 0 0 0 #6c6`) over a
    //    faint green tint with square left corners and ZERO layout change (first row beside the
    //    item's number AND a later row); opaque #1a241a tint and transparent border when grabbed or
    //    dragged; dashed placeholder without bar/tint and round corners; bin look without bar on
    //    #171717 with round corners over a bin; translucent tag/mark backgrounds.
    const mainWidget = page.locator('.todoer-widget').first()
    const selectedItem = '.todoer-widget .list-item-container.selected > .list-item'
    const laterIdx = rows0.indexOf('#bl_other')
    expect(laterIdx, '#bl_other is a later row (not row 0)').toBeGreaterThan(0)
    const measureRow = (rowIndex: number) =>
      page.evaluate(idx => {
        const main = [...document.querySelectorAll('.todoer-widget')].find((w: any) => !w._snoozed && !w._delegated)!
        const list = main.querySelector('.list') as HTMLElement
        const container = main.querySelectorAll('.list > .list-item-container')[idx] as HTMLElement
        const item = container.querySelector('.list-item') as HTMLElement
        const tag = item.querySelector('mark:not(.age):not(.waits)') as HTMLElement
        const lr = list.getBoundingClientRect()
        const ir = item.getBoundingClientRect()
        const tr = tag.getBoundingClientRect()
        const c = getComputedStyle(item)
        const sc = main.closest('.super-container') as HTMLElement
        const menu = sc.querySelector('.item-menu') as HTMLElement | null
        const menuIdx = sc.querySelector('.item-menu > .index') as HTMLElement | null
        const mr = menu?.getBoundingClientRect() ?? null
        return {
          selected: container.classList.contains('selected'),
          listLeft: lr.left,
          itemLeft: ir.left,
          itemLeftInList: ir.left - lr.left,
          itemWidth: ir.width,
          tagLeft: tr.left,
          tagLeftInList: tr.left - lr.left,
          border: c.border,
          margin: c.margin,
          padding: c.padding,
          menuPresent: !!menuIdx && (menuIdx.textContent ?? '').trim().length > 0,
          besideNumber: mr ? ir.top < mr.bottom && ir.bottom > mr.top : false,
        }
      }, rowIndex)
    const pinnedClip = (scroll: boolean) =>
      page.evaluate(doScroll => {
        const main = [...document.querySelectorAll('.todoer-widget')].find((w: any) => !w._snoozed && !w._delegated)!
        const sc = main.closest('.super-container') as HTMLElement
        if (doScroll) sc.scrollIntoView({ block: 'center' })
        const r = sc.getBoundingClientRect()
        const pad = 10
        const x = Math.max(0, Math.floor(r.left - pad))
        const y = Math.max(0, Math.floor(r.top - pad))
        return {
          x,
          y,
          width: Math.min(window.innerWidth - x, Math.ceil(r.width + 2 * pad)),
          height: Math.min(window.innerHeight - y, Math.ceil(r.height + 2 * pad)),
        }
      }, scroll)
    const rowStyle = (sel: string) =>
      page.evaluate(sel => {
        const el = document.querySelector(sel) as HTMLElement | null
        if (!el) return null
        const c = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return {
          shadow: c.boxShadow,
          bg: c.backgroundColor,
          border: c.border,
          borderColor: c.borderColor,
          color: c.color,
          radii: [c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomRightRadius, c.borderBottomLeftRadius],
          h: Math.round(r.height),
        }
      }, sel)

    // Measure unselected vs selected on BOTH the first row (beside the item's number) and a later
    // row (#bl_other): selecting moves neither the row's box (left edge, width) nor its first tag
    await userSet(page, '#bl_other')
    await expect
      .poll(() => mainWidget.locator('.list-item-container').nth(laterIdx).evaluate(el => el.classList.contains('selected')), {
        message: '#bl_other row marked selected',
        timeout: 5_000,
      })
      .toBe(true)
    const firstUnselected = await measureRow(0)
    const laterSelected = await measureRow(laterIdx)
    expect(firstUnselected.menuPresent && firstUnselected.besideNumber, 'first row stands beside the pinned item number').toBe(true)

    await userSet(page, rows0[0]!)
    await expect
      .poll(() => mainWidget.locator('.list-item-container').nth(0).evaluate(el => el.classList.contains('selected')), {
        message: 'first row marked selected',
        timeout: 5_000,
      })
      .toBe(true)
    const firstSelected = await measureRow(0)
    const laterUnselected = await measureRow(laterIdx)
    if (TASKS_SHOTS) {
      console.log('TASKS_ROW_METRICS', JSON.stringify({ firstUnselected, firstSelected, laterUnselected, laterSelected }))
    }

    expect(
      {
        selected: firstSelected.selected,
        itemLeft: firstSelected.itemLeft,
        itemLeftInList: firstSelected.itemLeftInList,
        itemWidth: firstSelected.itemWidth,
        tagLeft: firstSelected.tagLeft,
        tagLeftInList: firstSelected.tagLeftInList,
        border: firstSelected.border,
        margin: firstSelected.margin,
        padding: firstSelected.padding,
      },
      'selecting the first row (beside the item number) moves neither its box nor its first tag',
    ).toEqual({
      selected: true,
      itemLeft: firstUnselected.itemLeft,
      itemLeftInList: firstUnselected.itemLeftInList,
      itemWidth: firstUnselected.itemWidth,
      tagLeft: firstUnselected.tagLeft,
      tagLeftInList: firstUnselected.tagLeftInList,
      border: firstUnselected.border,
      margin: firstUnselected.margin,
      padding: firstUnselected.padding,
    })
    expect(
      {
        selected: laterSelected.selected,
        itemLeft: laterSelected.itemLeft,
        itemLeftInList: laterSelected.itemLeftInList,
        itemWidth: laterSelected.itemWidth,
        tagLeft: laterSelected.tagLeft,
        tagLeftInList: laterSelected.tagLeftInList,
        border: laterSelected.border,
        margin: laterSelected.margin,
        padding: laterSelected.padding,
      },
      'selecting a later row moves neither its box nor its first tag',
    ).toEqual({
      selected: true,
      itemLeft: laterUnselected.itemLeft,
      itemLeftInList: laterUnselected.itemLeftInList,
      itemWidth: laterUnselected.itemWidth,
      tagLeft: laterUnselected.tagLeft,
      tagLeftInList: laterUnselected.tagLeftInList,
      border: laterUnselected.border,
      margin: laterUnselected.margin,
      padding: laterUnselected.padding,
    })
    await taskShot(page, 'bb3_selected_first_row', await pinnedClip(true))

    await userSet(page, '#bl_other')
    await expect
      .poll(() => mainWidget.locator('.list-item-container').nth(laterIdx).evaluate(el => el.classList.contains('selected')), {
        message: '#bl_other row re-selected for drag states',
        timeout: 5_000,
      })
      .toBe(true)
    const GREEN = 'rgb(102, 204, 102)' // #6c6
    const GREEN_BAR = `${GREEN} -4px 0px 0px 0px`
    const TINT = 'rgba(102, 204, 102, 0.1)'
    const OPAQUE_TINT = 'rgb(26, 36, 26)' // #1a241a
    const SQUARE_LEFT = ['0px', '4px', '4px', '0px']
    const ROUND_ALL = ['4px', '4px', '4px', '4px']
    const TRANSPARENT = 'rgba(0, 0, 0, 0)'
    const selStyle = (await rowStyle(selectedItem))!
    expect(selStyle.shadow, 'selected row draws 4 px #6c6 bar outside left edge').toBe(GREEN_BAR)
    expect(selStyle.bg, 'selected row paints faint green tint').toBe(TINT)
    expect(selStyle.radii, 'selected row squares left corners and keeps right corners round').toEqual(SQUARE_LEFT)
    expect(selStyle.border, 'selected row keeps unselected transparent dashed border').toBe(`1px dashed ${TRANSPARENT}`)
    // grabbed (sortable-chosen before drag movement — set by class, as zz_binlook does)
    await page.evaluate(() => document.querySelector('.todoer-widget .list-item-container.selected')!.classList.add('sortable-chosen'))
    const grabbedStyle = (await rowStyle(selectedItem))!
    expect(grabbedStyle, 'grabbed selected row keeps bar, opaque #1a241a tint, square left corners, and transparent border').toEqual({
      shadow: GREEN_BAR,
      bg: OPAQUE_TINT,
      border: `1px solid ${TRANSPARENT}`,
      borderColor: TRANSPARENT,
      color: selStyle.color,
      radii: SQUARE_LEFT,
      h: selStyle.h,
    })
    await page.evaluate(() => document.querySelector('.todoer-widget .list-item-container.selected')!.classList.remove('sortable-chosen'))
    // real drag of selected row: verify dragged clone keeps bar/opaque tint/transparent border/square left,
    // ghost drops bar & tint with round corners and dashed #666 border, and hovering done/snooze bins
    // drops bar, restores #171717 background and round corners, and adopts bin colour (#6f6 / #fa4)
    await pinnedClip(true)
    let dragging = false
    for (let attempt = 0; attempt < 5 && !dragging; attempt++) {
      const box = (await mainWidget.locator('.list-item-container.selected').boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.waitForTimeout(400)
      await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 8, { steps: 5 })
      dragging = /dragging/.test((await mainWidget.getAttribute('class')) ?? '')
      if (!dragging) {
        await page.mouse.up()
        await page.waitForTimeout(400)
      }
    }
    expect(dragging, 'selected row entered real drag').toBe(true)
    const dragCloneStyle = await rowStyle('.todoer-widget .list-item-container.selected.sortable-drag > .list-item')
    const ghostStyle = await rowStyle('.todoer-widget .list-item-container.selected.sortable-ghost > .list-item')
    expect(
      [dragCloneStyle?.shadow, dragCloneStyle?.bg, dragCloneStyle?.borderColor, dragCloneStyle?.radii],
      'real dragged clone keeps bar, opaque #1a241a tint, square left corners, and transparent border',
    ).toEqual([GREEN_BAR, OPAQUE_TINT, TRANSPARENT, SQUARE_LEFT])
    expect(
      [ghostStyle?.border, ghostStyle?.shadow, ghostStyle?.bg, ghostStyle?.radii],
      'real ghost placeholder shows dashed #666 border, round corners, no bar, and no tint',
    ).toEqual(['1px dashed rgb(102, 102, 102)', 'none', TRANSPARENT, ROUND_ALL])
    await taskShot(page, 'bb3_selected_dragged', await pinnedClip(false))
    const doneBinBox = (await mainWidget.locator('.bin.done').boundingBox())!
    await page.mouse.move(doneBinBox.x + doneBinBox.width / 2, doneBinBox.y + doneBinBox.height / 2, { steps: 10 })
    await expect
      .poll(
        () =>
          rowStyle('.todoer-widget .list-item-container.selected.sortable-drag > .list-item').then(s => [
            s?.border,
            s?.color,
            s?.shadow,
            s?.bg,
            s?.radii,
          ]),
        {
          message: 'selected clone over done bin adopts #6f6 colour, #171717 background, round corners, and drops bar',
          timeout: 5_000,
        },
      )
      .toEqual(['1px solid rgb(102, 255, 102)', 'rgb(102, 255, 102)', 'none', 'rgb(23, 23, 23)', ROUND_ALL])
    await taskShot(page, 'bb3_selected_on_bin', await pinnedClip(false))
    const snoozeBinBox = (await mainWidget.locator('.bin.snooze').boundingBox())!
    await page.mouse.move(snoozeBinBox.x + snoozeBinBox.width / 2, snoozeBinBox.y + snoozeBinBox.height / 2, { steps: 10 })
    await expect
      .poll(
        () =>
          rowStyle('.todoer-widget .list-item-container.selected.sortable-drag > .list-item').then(s => [
            s?.border,
            s?.color,
            s?.shadow,
            s?.bg,
            s?.radii,
          ]),
        {
          message: 'selected clone over snooze bin adopts #fa4 colour, #171717 background, round corners, and drops bar',
          timeout: 5_000,
        },
      )
      .toEqual(['1px solid rgb(255, 170, 68)', 'rgb(255, 170, 68)', 'none', 'rgb(23, 23, 23)', ROUND_ALL])
    // return to list and release so #bl_other stays untouched in main list
    const listBox = (await mainWidget.locator('.list').boundingBox())!
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect.poll(() => mainWidget.evaluate(el => el.classList.contains('dragging')), { timeout: 5_000 }).toBe(false)

    // 3. Bell rule (Points 1 & 4): a reply row's bell removes its row and selects the next row;
    //    a todo row's bell clears its bell while keeping its row and leaving selection unchanged
    await userSet(page, '#bl_reply/0')
    await expect.poll(() => guestState().then(s => [s.names, s.titles]), { message: 'reply row gets up, down, bell only', timeout: 5_000 }).toEqual([
      ['up', 'down', 'bell'],
      ['Previous row (k)', 'Next row (j)', 'Clear the notification (b)'],
    ])
    expect((await guestState()).colors.bell, 'bell button is yellow #ff6').toBe('rgb(255, 255, 102)')
    await expect.poll(() => mainWidget.locator('.list-item-container.selected').count(), { timeout: 5_000 }).toBe(1)
    const rowsBeforeReplyBell = await mainRowNames()
    const replyIdx = rowsBeforeReplyBell.indexOf('#bl_reply/0')
    const expectedAfterReplyBell = rowsBeforeReplyBell[replyIdx + 1] ?? rowsBeforeReplyBell[replyIdx - 1]
    await guest('bell').click()
    await expect.poll(() => mainWidget.locator('.list-item-container[data-waits="reply"]').count(), { message: 'bell button clears reply row', timeout: 10_000 }).toBe(0)
    await expect.poll(boxNow, { message: 'clearing a reply row bell selects the next row', timeout: 10_000 }).toBe(expectedAfterReplyBell)

    // todo row with a bell (staged via projection surfaced=1, as in WAITS_USER row): bell clears while row and selection stay
    const taskSavedId = (await savedId(page, '#bl_task'))!
    const taskStoreDoc = (await storeDocId(`global_store_${taskSavedId}`, BIN_USER, BIN_SECRET)) ?? 'e2e-bin-store-task'
    await writeStore(
      taskStoreDoc,
      `global_store_${taskSavedId}`,
      { _agent: { state: { held: 'owner', reason: 'question', epoch: 1, rev: 2, surfaced: 1, updated: Date.now() } } },
      BIN_USER,
      BIN_SECRET,
    )
    const taskRow = mainWidget.locator('.list-item-container', { hasText: 'fix the cache' })
    await expect(taskRow.locator('mark.waits'), 'todo row shows question bell').toHaveText('question', { timeout: 30_000 })
    await userSet(page, '#bl_task')
    await expect.poll(() => guestState().then(s => s.names), { message: 'todo with bell shows bell button before bins', timeout: 5_000 }).toEqual([
      'up', 'down', 'bell', 'agent', 'done', 'snooze', 'cancel',
    ])
    await guest('bell').click()
    await expect(taskRow.locator('mark.waits'), 'bell button clears todo bell').toHaveCount(0, { timeout: 15_000 })
    await expect(taskRow, 'todo row stays in main list after bell clear').toHaveCount(1)
    await expect.poll(() => guestState().then(s => s.names), { message: 'bell button disappears once cleared', timeout: 5_000 }).toEqual([
      'up', 'down', 'agent', 'done', 'snooze', 'cancel',
    ])
    expect(await boxNow(), 'clearing a todo row bell leaves that todo selected').toBe('#bl_task')

    // 4. Wide desktop todo bin buttons, snooze picker cancel, open-editor draft guard, and done button + select-next
    await userSet(page, '#bl_task')
    await expect.poll(() => guestState().then(s => [s.names, s.titles]), { message: 'todo row tooltips name their keys', timeout: 5_000 }).toEqual([
      ['up', 'down', 'agent', 'done', 'snooze', 'cancel'],
      ['Previous row (k)', 'Next row (j)', 'Delegate to the agent (a)', 'Done (d)', 'Snooze (s)', 'Delete (x)'],
    ])
    const wideTodo = await guestState()
    expect(
      [wideTodo.cls, wideTodo.bgCls, wideTodo.floorShown, wideTodo.ownPiece, wideTodo.gapToStrip, wideTodo.colors.snooze],
      'wide window shows inline guest buttons group-gap from strip, orange snooze, no fallback piece',
    ).toEqual(['key-buttons-guests', 'key-buttons-bg desktop split', false, false, 18, 'rgb(255, 170, 68)'])
    // snooze button opens picker; closing without time snoozes nothing and keeps selection
    await guest('snooze').click()
    await expect(page.locator('.snooze-modal'), 'snooze button opens picker').toBeVisible({ timeout: 5_000 })
    await page.evaluate(() => (window as any)._modal_close())
    await expect(page.locator('.snooze-modal')).toBeHidden({ timeout: 5_000 })
    expect(await boxNow(), 'declined snooze keeps selection').toBe('#bl_task')
    // open #bl_task in its editor: draft refuses done, reverting to saved text allows done and selects next row
    const rowsBeforeDone = await mainRowNames()
    const taskIdx = rowsBeforeDone.indexOf('#bl_task')
    const expectedAfterDone = rowsBeforeDone[taskIdx + 1] ?? rowsBeforeDone[taskIdx - 1]
    await expect(page.locator('.container.target')).toBeVisible({ timeout: 5_000 })
    await unfocus()
    await page.keyboard.press('Enter')
    const editor = page.locator('.super-container .container.editing textarea').first()
    await expect(editor, '#bl_task editor opened').toBeVisible({ timeout: 5_000 })
    await editor.focus()
    await editor.evaluate(el => {
      const ta = el as HTMLTextAreaElement
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
    await page.keyboard.type(' typed since')
    const dlgBefore = dialogs.length
    await guest('done').click()
    await expect.poll(() => dialogs.slice(dlgBefore), { message: 'done refused with unsaved draft', timeout: 5_000 }).toEqual([
      'alert: can not complete #bl_task with unsaved changes: save or cancel your edit first',
    ])
    expect((await itemText('#bl_task'))?.saved, 'item stayed #todo while draft stood').toContain('#todo')
    expect(await boxNow(), 'refused done keeps selection').toBe('#bl_task')
    // revert editor to saved text (nothing typed differs) -> done succeeds and selects next row
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('#bl_task\n#todo fix the cache')
    await guest('done').click()
    await expect.poll(() => itemText('#bl_task').then(t => t?.saved ?? ''), { message: 'done with no unsaved diff completes and saves', timeout: 15_000 }).toContain('#done')
    await expect.poll(boxNow, { message: 'done button selects next row in list', timeout: 10_000 }).toBe(expectedAfterDone)
    await page.keyboard.press('Escape')

    // 5. Delegate via button -> selects next row with a history step (Back returns to delegated item);
    //    delegated list buttons & narrow window second row (430 px)
    //    Select #bl_note (final: true), then userSet #bl_other (pushed as a non-final entry on top of #bl_note)
    //    so #bl_other is the sole entry at the top; _delegate's write keeps it in place, and carried _select_next
    //    pushes #bl_third as its own step so Back returns to #bl_other (without carry it overwrites #bl_other and Back lands on #bl_note)
    await asUser(page, () => (window._item('#bl_note', true) as any)!.select())
    await expect.poll(boxNow, { timeout: 5_000 }).toBe('#bl_note')
    await userSet(page, '#bl_other')
    await expect.poll(boxNow, { timeout: 5_000 }).toBe('#bl_other')
    await expect.poll(() => guestState().then(s => s.names), { timeout: 5_000 }).toEqual(['up', 'down', 'agent', 'done', 'snooze', 'cancel'])
    const histIdxBeforeDelegate = await page.evaluate(() => (history.state?.index as number | undefined) ?? -1)
    // yield one macrotask before enqueue resolves so the click event dispatch has finished
    // (eventPhase === 0) when _select_next settles, just as WebCrypto v1 / real async waits do
    await page.evaluate(() => {
      const w = window as any
      const orig = w._enqueue_hidden_document
      w.__orig_enqueue_hidden_document = orig
      w._enqueue_hidden_document = async (...args: unknown[]) => {
        await new Promise(r => setTimeout(r, 30))
        return orig(...args)
      }
    })
    try {
      await guest('agent').click()
      await expect.poll(() => boxNow(), { message: 'delegate button selects remaining main row (#bl_third)', timeout: 15_000 }).toBe('#bl_third')
      await expect.poll(() => page.locator('.todoer-widget').nth(1).locator('.list-item-container').count(), { message: '#bl_other moved to delegated list', timeout: 15_000 }).toBe(1)
    } finally {
      await page.evaluate(() => {
        const w = window as any
        if (w.__orig_enqueue_hidden_document) {
          w._enqueue_hidden_document = w.__orig_enqueue_hidden_document
          delete w.__orig_enqueue_hidden_document
        }
      })
    }
    expect(
      await page.evaluate(() => (history.state?.index as number | undefined) ?? -1),
      'carried next-row selection after delegate added a history step',
    ).toBeGreaterThan(histIdxBeforeDelegate)
    await page.goBack()
    await expect.poll(boxNow, { message: 'Back returns to the delegated item (#bl_other)', timeout: 10_000 }).toBe('#bl_other')
    await expect.poll(() => guestState().then(s => [s.names, s.titles[3]]), { message: 'delegated row has take-back button', timeout: 5_000 }).toEqual([
      ['up', 'down', 'agent', 'owner'],
      'Take back from the agent (u)',
    ])
    // translucent white backgrounds on a row's tag (0.07) and age mark (0.04) so they adapt to the tint
    const markBgs = await page.evaluate(() => {
      const row = document.querySelectorAll('.todoer-widget')[1]?.querySelector('.list-item') as HTMLElement | null
      const tag = row?.querySelector('mark:not(.age):not(.waits)') as HTMLElement | null
      const age = row?.querySelector('mark.age') as HTMLElement | null
      return [tag ? getComputedStyle(tag).backgroundColor : null, age ? getComputedStyle(age).backgroundColor : null]
    })
    expect(markBgs, 'row tag and age mark use translucent white backgrounds').toEqual([
      'rgba(255, 255, 255, 0.07)',
      'rgba(255, 255, 255, 0.04)',
    ])
    // narrow window (430 px): second row above bottom bar at left edge, clickable at elementFromPoint
    await page.setViewportSize({ width: 430, height: 800 })
    await expect.poll(() => guestState().then(s => [s.cls, s.bgCls, s.floorShown]), { message: 'narrow window puts bin buttons on second row', timeout: 5_000 }).toEqual([
      'key-buttons-guests floor',
      'key-buttons-bg desktop floor',
      true,
    ])
    const floorHit = await page.evaluate(() => {
      const b = document.querySelector('.key-buttons-guests > button[data-guest="owner"]')!.getBoundingClientRect()
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) as HTMLElement | null
      return hit?.closest('button')?.getAttribute('data-guest') ?? null
    })
    expect(floorHit, 'second-row owner button is reachable at its centre').toBe('owner')
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect.poll(() => guestState().then(s => [s.cls, s.floorShown]), { message: 'widening returns bin buttons inline', timeout: 5_000 }).toEqual(['key-buttons-guests', false])

    // give the delegated list a second row and verify pressing agent on the first row enqueues
    // one command and keeps selection on the first row (does not advance to the second)
    await page.evaluate(() => void window._create('#bl_del2\n#todo second delegated todo'))
    await expect.poll(() => savedId(page, '#bl_del2'), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => mainRowNames().then(r => r.includes('#bl_del2')), { timeout: 15_000 }).toBe(true)
    await userSet(page, '#bl_del2')
    // (the MAIN row's buttons, with done among them: the delegated row selected before has an agent button
    // too, and a press on its buttons while the box names another item is refused, as it should be)
    await expect.poll(() => guestState().then(s => s.names.includes('agent') && s.names.includes('done')), { timeout: 5_000 }).toBe(true)
    await guest('agent').click()
    await expect.poll(() => page.locator('.todoer-widget').nth(1).locator('.list-item-container').count(), { message: 'delegated list holds two rows', timeout: 15_000 }).toBe(2)
    const delRowNames = await page.evaluate(() => {
      const del = [...document.querySelectorAll('.todoer-widget')].find((w: any) => !!w._delegated)
      return [...(del?.querySelectorAll('.list .list-item-container[data-id]') ?? [])].map(r => window._item(r.getAttribute('data-id')!, true)?.name ?? null)
    })
    expect(delRowNames.length, 'two rows in delegated list').toBe(2)
    await userSet(page, delRowNames[0]!)
    await expect.poll(() => guestState().then(s => s.names), { timeout: 5_000 }).toEqual(['up', 'down', 'agent', 'owner'])
    await page.evaluate(() => {
      const w = window as any
      const orig = w._enqueue_hidden_document
      w.__orig_redel_enqueue = orig
      w.__redel_enq = 0
      w._enqueue_hidden_document = async (...args: unknown[]) => {
        w.__redel_enq++
        return orig(...args)
      }
    })
    try {
      await guest('agent').click()
      await expect
        .poll(() => page.evaluate(() => [(window as any).__redel_enq, !!(window as any)._todoer_bin_busy]), { message: 're-delegate enqueued once and settled', timeout: 15_000 })
        .toEqual([1, false])
    } finally {
      await page.evaluate(() => {
        const w = window as any
        if (w.__orig_redel_enqueue) {
          w._enqueue_hidden_document = w.__orig_redel_enqueue
          delete w.__orig_redel_enqueue
        }
        delete w.__redel_enq
      })
    }
    expect(await boxNow(), 're-delegating first of two delegated rows keeps selection on it').toBe(delRowNames[0])

    // 6. Delete button on a todo WITHOUT a unique label (as `/todo buy milk` makes with other
    //    todos present): asks confirmation; Cancel keeps the row and selection; accepting deletes
    //    it and selects the next row; real drag to done bin also selects next row
    const UNNAMED_DEL = '#todo delete via button'
    const UNNAMED_PEER = '#todo unnamed peer todo'
    for (const text of [UNNAMED_DEL, UNNAMED_PEER, '#bl_drag_a\n#todo drag next target', '#bl_drag_b\n#todo drag to done']) {
      await page.evaluate(text => void window._create(text), text)
    }
    const findByText = (needle: string) =>
      page.evaluate(needle => {
        const it = (window as any).__items.find((i: any) => i.text === needle)
        return it ? { id: it.id as string, savedId: (it.savedId ?? '') as string, name: it.name as string, labelUnique: !!it.labelUnique } : null
      }, needle)
    await expect.poll(() => findByText(UNNAMED_DEL).then(it => it?.savedId ?? ''), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => findByText(UNNAMED_PEER).then(it => it?.savedId ?? ''), { timeout: 30_000 }).toBeTruthy()
    for (const name of ['#bl_drag_a', '#bl_drag_b']) {
      await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
    }
    const delTodo = (await findByText(UNNAMED_DEL))!
    expect(delTodo.labelUnique, 'delete-button fixture todo has no unique label').toBe(false)
    const delRef = 'id:' + delTodo.savedId
    const mainRowIds = () =>
      page.evaluate(() => {
        const main = [...document.querySelectorAll('.todoer-widget')].find((w: any) => !w._snoozed && !w._delegated)
        return [...(main?.querySelectorAll('.list .list-item-container[data-id]') ?? [])].map(r => r.getAttribute('data-id')!)
      })
    const selectedId = () => page.evaluate(() => window._item((window as any).MindBox.get().trim(), true)?.id ?? null)
    await expect.poll(() => mainRowIds().then(r => r.length), { timeout: 15_000 }).toBe(5)
    await userSet(page, delRef)
    await expect.poll(() => guestState().then(s => s.names.includes('cancel')), { timeout: 5_000 }).toBe(true)
    await expect.poll(() => mainWidget.locator('.list-item-container.selected').count(), { timeout: 5_000 }).toBe(1)
    const delDlg0 = dialogs.length
    answer.accept = false
    await guest('cancel').click()
    await expect.poll(() => dialogs.length, { message: 'delete button on unnamed todo asks confirmation', timeout: 5_000 }).toBeGreaterThan(delDlg0)
    expect(dialogs[delDlg0], 'confirm dialog names the unnamed todo').toBe(`confirm: Delete ${delTodo.name}?`)
    expect(await findByText(UNNAMED_DEL), 'declined delete keeps unnamed todo').not.toBeNull()
    expect(await mainWidget.locator(`.list-item-container[data-id="${delTodo.id}"]`).count(), 'declined delete keeps the row in the list').toBe(1)
    expect(await boxNow(), 'declined delete keeps selection on unnamed todo').toBe(delRef)
    // read DOM order AFTER selecting the unnamed todo (selecting can re-rank) right before accepting delete
    const rowsBeforeDel = await mainRowIds()
    const delIdx = rowsBeforeDel.indexOf(delTodo.id)
    const expectedAfterDelId = rowsBeforeDel[delIdx + 1] ?? rowsBeforeDel[delIdx - 1]
    answer.accept = true
    await guest('cancel').click()
    answer.accept = false
    await expect.poll(() => findByText(UNNAMED_DEL), { message: 'accepted delete removes unnamed todo', timeout: 15_000 }).toBeNull()
    await expect.poll(selectedId, { message: 'accepted delete of unnamed todo selects next row', timeout: 10_000 }).toBe(expectedAfterDelId)

    // real drag of #bl_drag_b to done bin selects its following/previous row
    const dragBId = (await page.evaluate(() => window._item('#bl_drag_b', true)?.id ?? null))!
    const rowsBeforeDrag = await mainRowIds()
    const dragIdx = rowsBeforeDrag.indexOf(dragBId)
    const expectedAfterDragId = rowsBeforeDrag[dragIdx + 1] ?? rowsBeforeDrag[dragIdx - 1]
    await userSet(page, '')
    await pinnedClip(true)
    let dragDone = false
    for (let attempt = 0; attempt < 5 && !dragDone; attempt++) {
      const row = mainWidget.locator('.list-item-container', { hasText: 'drag to done' })
      const box = await row.boundingBox()
      if (!box) {
        await page.waitForTimeout(200)
        continue
      }
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.waitForTimeout(400)
      await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 4, { steps: 5 })
      dragDone = /dragging/.test((await mainWidget.getAttribute('class')) ?? '')
      if (!dragDone) {
        await page.mouse.up()
        await page.waitForTimeout(400)
      }
    }
    expect(dragDone, '#bl_drag_b entered drag for done bin').toBe(true)
    const doneBox2 = (await mainWidget.locator('.bin.done').boundingBox())!
    await page.mouse.move(doneBox2.x + doneBox2.width / 2, doneBox2.y + doneBox2.height / 2, { steps: 15 })
    await expect.poll(() => mainWidget.locator('.bin.done .list-item-container').count(), { message: '#bl_drag_b hovered over done bin', timeout: 5_000 }).toBe(1)
    await page.mouse.up()
    await expect.poll(() => itemText('#bl_drag_b').then(t => t?.saved ?? ''), { message: 'real drag to done bin completed #bl_drag_b', timeout: 15_000 }).toContain('#done')
    await expect.poll(selectedId, { message: 'real drag to done bin selects next row', timeout: 10_000 }).toBe(expectedAfterDragId)

    // 7. Row button keys (a, d, s, x, b, u; d a todo's alone) through the app's own key path,
    //    not-rows classes, repeat guard, and forwarding to the prior window._on_key hook
    const RK_REPLY = "#rk_reply/0 #_chat #_agent/vault\n<<user>> hi\n<<agent('vault/default · run ab12cd34 · 1s')>>\n<!--inert-->\nRow keys reply.\n<!--/inert-->"
    for (const text of ['#rk_one\n#todo row keys first', '#rk_two\n#todo row keys second', '#rk_three\n#todo row keys third', RK_REPLY]) {
      await page.evaluate(text => void window._create(text), text)
    }
    for (const name of ['#rk_one', '#rk_two', '#rk_three', '#rk_reply/0']) {
      await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
    }
    await expect.poll(() => mainRowNames().then(r => ['#rk_one', '#rk_two', '#rk_three', '#rk_reply/0'].every(n => r.includes(n))), { timeout: 15_000 }).toBe(true)
    const delegatedRowNames = () =>
      page.evaluate(() => {
        const w = [...document.querySelectorAll('.todoer-widget')].find((w: any) => !!w._delegated)
        return [...(w?.querySelectorAll('.list .list-item-container[data-id]') ?? [])].map(r => window._item(r.getAttribute('data-id')!, true)?.name ?? null)
      })
    await page.evaluate(() => {
      ;(window as any).__rk_keys = []
      window.addEventListener('keydown', e => void queueMicrotask(() => (window as any).__rk_keys.push([e.code, e.defaultPrevented, e.repeat])))
    })
    const keys = () => page.evaluate(() => (window as any).__rk_keys.splice(0))
    const priorKeys = () => page.evaluate(() => (window as any).__rk_prior_keys.splice(0))
    const selectRow = async (name: string) => {
      await userSet(page, name)
      await expect.poll(boxNow, { timeout: 5_000 }).toBe(name)
      await unfocus()
    }

    // 7a. Not the rows': no row selected, unlisted item (#bl_note), Shift, typing in the box
    await userSet(page, '')
    await expect.poll(boxNow, { timeout: 5_000 }).toBe('')
    await unfocus()
    await keys()
    await priorKeys()
    const rowsBeforeKeys = await mainRowNames()
    await page.keyboard.press('d')
    await page.waitForTimeout(150)
    expect([await boxNow(), await mainRowNames(), await keys(), await priorKeys()], 'd with no row selected forwards to prior hook with default left').toEqual([
      '',
      rowsBeforeKeys,
      [['KeyD', false, false]],
      ['KeyD'],
    ])

    await selectRow('#bl_note')
    await keys()
    await priorKeys()
    const dlgNote = dialogs.length
    await page.keyboard.press('d')
    await page.keyboard.press('x')
    await page.waitForTimeout(150)
    expect([await boxNow(), (await itemText('#bl_note'))?.saved, dialogs.length - dlgNote, await keys(), await priorKeys()], 'd and x on an unlisted item forward to prior hook').toEqual([
      '#bl_note',
      '#bl_note an item no list holds',
      0,
      [['KeyD', false, false], ['KeyX', false, false]],
      ['KeyD', 'KeyX'],
    ])

    await selectRow('#rk_one')
    await expect.poll(() => guestState().then(s => s.names), { timeout: 5_000 }).toEqual(['up', 'down', 'agent', 'done', 'snooze', 'cancel'])
    await keys()
    await priorKeys()
    await page.keyboard.press('Shift+D')
    await page.waitForTimeout(150)
    expect([await boxNow(), (await itemText('#rk_one'))?.saved, await priorKeys()], 'Shift+D leaves todo and forwards to prior hook').toEqual([
      '#rk_one',
      '#rk_one\n#todo row keys first',
      ['ShiftLeft', 'KeyD'],
    ])

    await focusMindbox(page)
    await page.keyboard.type('d')
    await expect.poll(() => page.evaluate(() => (window as any).MindBox.get()), { message: 'd typed into MindBox enters text instead of completing todo', timeout: 5_000 }).toBe('#rk_oned')
    expect((await itemText('#rk_one'))?.saved, 'todo unchanged when d typed in box').toBe('#rk_one\n#todo row keys first')

    // 7b. Prior hook on a selected todo: receives unrelated key `t`
    await selectRow('#rk_one')
    await keys()
    await priorKeys()
    await page.keyboard.press('t')
    await page.waitForTimeout(150)
    expect([await keys(), await priorKeys()], 'prior _on_key hook receives t when a todo row is selected').toEqual([[['KeyT', false, false]], ['KeyT']])

    // 7c. s opens the snooze picker
    await keys()
    await priorKeys()
    await page.keyboard.press('s')
    await expect(page.locator('.snooze-modal'), 's opens the snooze picker').toBeVisible({ timeout: 5_000 })
    await page.evaluate(() => (window as any)._modal_close())
    await expect(page.locator('.snooze-modal')).toBeHidden({ timeout: 5_000 })
    expect([await boxNow(), (await keys())[0], await priorKeys()], 's was taken by rows and closed picker keeps selection').toEqual(['#rk_one', ['KeyS', true, false], []])

    // 7d. x asks first; declined question keeps the row and selection
    const dlgX = dialogs.length
    answer.accept = false
    await keys()
    await priorKeys()
    await page.keyboard.press('x')
    await expect.poll(() => dialogs.length, { message: 'x asks confirmation', timeout: 5_000 }).toBe(dlgX + 1)
    expect(dialogs[dlgX], 'x confirm dialog asks before delete').toMatch(/^confirm: /)
    await page.waitForTimeout(150)
    expect([await boxNow(), (await itemText('#rk_one'))?.saved, await priorKeys()], 'declined x keeps row and selection without forwarding').toEqual([
      '#rk_one',
      '#rk_one\n#todo row keys first',
      [],
    ])

    // 7e. Held d completes ONE todo, selects the next row, and does NOT forward to prior hook
    //     (choose a todo whose immediate following row is also a todo so dropping the repeat guard completes two)
    const rowsBeforeD = await mainRowNames()
    const heldIdx = rowsBeforeD.findIndex((n, i) => !!n && n.startsWith('#rk_') && n != '#rk_reply/0' && !!rowsBeforeD[i + 1] && rowsBeforeD[i + 1] != '#rk_reply/0')
    expect(heldIdx, 'found a #rk_ todo followed by another todo').toBeGreaterThanOrEqual(0)
    const heldTarget = rowsBeforeD[heldIdx]!
    const heldNext = rowsBeforeD[heldIdx + 1]!
    await selectRow(heldTarget)
    await keys()
    await priorKeys()
    await page.keyboard.down('d')
    await page.keyboard.down('d')
    await page.keyboard.down('d')
    await page.keyboard.up('d')
    await expect.poll(() => itemText(heldTarget).then(t => t?.saved ?? ''), { message: 'd completes the selected todo', timeout: 15_000 }).toContain('#done')
    await expect.poll(boxNow, { message: 'd selects the next row', timeout: 10_000 }).toBe(heldNext)
    await page.waitForTimeout(300)
    expect([await mainRowNames(), await keys(), await priorKeys()], 'held d completed one todo, claimed repeats, and did not forward to prior hook').toEqual([
      rowsBeforeD.filter(n => n != heldTarget),
      [['KeyD', true, false], ['KeyD', true, true], ['KeyD', true, true]],
      [],
    ])
    expect((await itemText(heldNext))?.saved ?? '', 'the next todo row was NOT completed by held d repeats').toContain('#todo')

    // 7f. Reply row: only up/down/bell shown; d and x leave the row (no confirm dialog) and forward to prior hook; b clears the row
    await selectRow('#rk_reply/0')
    await expect.poll(() => guestState().then(s => [s.names, s.titles]), { message: 'reply row shows up, down, and bell only', timeout: 5_000 }).toEqual([
      ['up', 'down', 'bell'],
      ['Previous row (k)', 'Next row (j)', 'Clear the notification (b)'],
    ])
    const dlgReply = dialogs.length
    await keys()
    await priorKeys()
    await page.keyboard.press('d')
    await page.keyboard.press('x')
    await page.waitForTimeout(150)
    expect(
      [await boxNow(), await mainWidget.locator('.list-item-container[data-waits="reply"]').count(), dialogs.length - dlgReply, await keys(), await priorKeys()],
      'd and x leave reply row untouched (no confirm) and forward to prior hook',
    ).toEqual(['#rk_reply/0', 1, 0, [['KeyD', false, false], ['KeyX', false, false]], ['KeyD', 'KeyX']])
    await keys()
    await priorKeys()
    await page.keyboard.press('b')
    await expect.poll(() => mainWidget.locator('.list-item-container[data-waits="reply"]').count(), { message: 'b clears the reply row', timeout: 10_000 }).toBe(0)
    expect([await keys(), await priorKeys()], 'b was taken by reply row without forwarding').toEqual([[['KeyB', true, false]], []])

    // 7g. a delegates and selects next row; d on delegated row forwards to prior hook; u takes back
    const delTarget = ['#rk_one', '#rk_two', '#rk_three'].find(n => n != heldTarget)!
    await selectRow(delTarget)
    const rowsBeforeA = await mainRowNames()
    const afterA = rowsBeforeA[rowsBeforeA.indexOf(delTarget) + 1] ?? rowsBeforeA[rowsBeforeA.indexOf(delTarget) - 1]
    await priorKeys()
    await page.keyboard.press('a')
    await expect.poll(() => delegatedRowNames().then(r => r.includes(delTarget)), { message: 'a delegates the todo', timeout: 15_000 }).toBe(true)
    await expect.poll(boxNow, { message: 'a selects the next row', timeout: 10_000 }).toBe(afterA)
    expect(await priorKeys(), 'a did not forward to prior hook').toEqual([])
    await selectRow(delTarget)
    await expect.poll(() => guestState().then(s => s.names), { timeout: 5_000 }).toEqual(['up', 'down', 'agent', 'owner'])
    await keys()
    await priorKeys()
    await page.keyboard.press('d')
    await page.waitForTimeout(150)
    expect([(await itemText(delTarget))?.saved?.includes('#done') ?? false, await keys(), await priorKeys()], 'd on a delegated row forwards to prior hook').toEqual([
      false,
      [['KeyD', false, false]],
      ['KeyD'],
    ])
    await priorKeys()
    await page.keyboard.press('u')
    await expect.poll(() => delegatedRowNames().then(r => r.includes(delTarget)), { message: 'u takes the todo back from delegated list', timeout: 15_000 }).toBe(false)
    await expect.poll(() => mainRowNames().then(r => r.includes(delTarget)), { message: 'u returns the todo to main list', timeout: 15_000 }).toBe(true)
    expect(await priorKeys(), 'u did not forward to prior hook').toEqual([])

    // 8. #todoer's own page: five short bullets, commands table (4 single-line closed rows),
    // functions table filtered to lowercase functions only (no names in capitals), and clicking
    // the description of /delegate, /notify, and todoer_widget opens a table of its forms
    await userSet(page, '#todoer', { scroll: true })
    await expect
      .poll(
        () => page.evaluate(() => document.querySelector('.container.target')?.getAttribute('data-item-id') === window._item('#todoer', true)?.id),
        { message: '#todoer is the targeted item', timeout: 15_000 },
      )
      .toBe(true)
    const todoerItem = page.locator('.super-container.target')
    await expect(todoerItem.locator('.core_js_table.ready'), '#todoer renders commands and functions tables').toHaveCount(2, { timeout: 30_000 })
    await expect(todoerItem.locator('.content > ul > li'), '#todoer visible text has five bullets').toHaveCount(5)
    const readTodoerTables = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.super-container.target .core_js_table')].map(table =>
          [...table.querySelectorAll(':scope > .function')].map(row => {
            const more = row.querySelector('.more') as HTMLElement | null
            return {
              name: (row.querySelector('.usage .name')?.textContent ?? '').trim(),
              expanded: row.classList.contains('expanded'),
              moreHidden: !more || getComputedStyle(more).display == 'none',
              height: Math.round((row as HTMLElement).getBoundingClientRect().height),
            }
          }),
        ),
      )
    const [cmdRows, fnRows] = await readTodoerTables()
    expect(cmdRows.map(r => r.name), '#todoer commands table lists its four commands').toEqual([
      '/todo [text]',
      '/delegate [item|text]',
      '/takeback [item]',
      '/notify [on [reason...]|off [reason...]|test [item]]',
    ])
    const singleLineHeight = cmdRows[0]!.height
    expect(
      cmdRows.every(r => !r.expanded && r.moreHidden && r.height <= 45 && Math.abs(r.height - singleLineHeight) <= 2),
      `each closed command row is one line high (rows: ${JSON.stringify(cmdRows)})`,
    ).toBe(true)
    expect(fnRows.map(r => r.name), '#todoer functions table lists only todoer_widget and create_pinned_item').toEqual([
      'todoer_widget',
      'create_pinned_item',
    ])
    expect(fnRows.filter(r => /^[A-Z]/.test(r.name)), '#todoer functions table lists no names in capitals').toEqual([])
    for (const [name, formRows] of [
      ['/delegate', 3],
      ['/notify', 7],
      ['todoer_widget', 5],
    ] as const) {
      const row = todoerItem.locator('.core_js_table .function', { has: page.locator('.usage .name', { hasText: name }) }).first()
      await row.locator('.desc').click({ position: { x: 20, y: 10 } })
      await expect(row, `${name} row expands on description click`).toHaveClass(/\bexpanded\b/, { timeout: 10_000 })
      await expect(todoerItem.locator('.core_js_table.ready')).toHaveCount(2, { timeout: 10_000 })
      await expect(row.locator('.more'), `${name} expanded forms panel is visible`).toBeVisible()
      await expect(row.locator('.more table > tbody > tr'), `${name} forms table has ${formRows} rows`).toHaveCount(formRows)
      await expect(row.locator('.more table'), `${name} forms render as one table`).toHaveCount(1)
      await expect(page.locator('.modal'), `${name} description click opens no code modal`).toBeHidden()
    }
    expect(errors, '#todoer page logs no error').toEqual([])

    // 9. /vault command caret placement: without Shift no editor opens and no error is logged;
    // plain /vault and /vault <words> typed in MindBox with Shift+Enter focus the new chat's editor
    // with the caret collapsed at the end (one space after the user delimiter for plain /vault);
    // and a chat's child keeps its caret at the end. #chat/vault/0 is created without Shift first,
    // so the measured Shift+Enter chats are later chats (not the first chat after reload)
    expect(
      await page.evaluate(() => [window._exists('#chat/vault'), typeof (window as any)._customize_child]),
      '#chat/vault and _customize_child are installed',
    ).toEqual([true, 'function'])
    const activeItemEditor = () =>
      page.evaluate(() => {
        const a = document.activeElement as HTMLTextAreaElement | null
        const container = a?.closest?.('.container[data-item-id]') as HTMLElement | null
        const item = container ? window._item('id:' + container.getAttribute('data-item-id'), true) : null
        return a?.tagName == 'TEXTAREA' && item
          ? { name: item.name, value: a.value, start: a.selectionStart, end: a.selectionEnd, len: a.value.length }
          : null
      })
    await userSet(page, '')
    await unfocus()
    // (the message holds a text field of its own: a field in the item's drawn text is not the editor's, and
    // the command must leave it as it is)
    const FIELD = '<textarea>draft</textarea>'
    const drawnField = () =>
      page.evaluate(() => {
        const field = document.querySelector('.container.target textarea') as HTMLTextAreaElement | null
        return field ? [field.id, field.value, field.selectionStart, field.selectionEnd] : null
      })
    await page.evaluate(field => void window._create('/vault ' + field, { command: true }), FIELD)
    await expect.poll(() => savedId(page, '#chat/vault/0'), { message: '/vault without Shift creates #chat/vault/0', timeout: 30_000 }).toBeTruthy()
    await expect
      .poll(
        () => page.evaluate(() => document.querySelector('.container.target')?.getAttribute('data-item-id') === window._item('#chat/vault/0', true)?.id),
        { message: '/vault without Shift targets #chat/vault/0', timeout: 10_000 },
      )
      .toBe(true)
    await expect.poll(drawnField, { message: "the message's own field is drawn in the item, untouched", timeout: 10_000 }).toEqual(['', 'draft', 0, 0])
    await page.evaluate(() => (window as any)._update_dom())
    await page.evaluate(() => (window as any)._update_dom())
    expect(await drawnField(), "/vault without Shift leaves the message's own field as it was").toEqual(['', 'draft', 0, 0])
    expect(
      await page.evaluate(() => {
        const it = window._item('#chat/vault/0', true) as any
        return { text: it?.text ?? null, editing: !!it?.editing }
      }),
      '/vault without Shift leaves #chat/vault/0 unedited',
    ).toEqual({ text: '#chat/vault/0 #_agent/vault\n<<user>> ' + FIELD, editing: false })
    expect(await activeItemEditor(), '/vault without Shift opens no item editor').toBeNull()
    expect(errors, '/vault without Shift logs no error').toEqual([])

    const runInMindbox = async (typed: string, expectedName: string, expectedValue: string, label: string) => {
      await userSet(page, '')
      await expect.poll(() => page.evaluate(() => (window as any).MindBox.get()), { timeout: 5_000 }).toBe('')
      await focusMindbox(page)
      await page.keyboard.type(typed)
      await expect(mindbox(page)).toHaveValue(typed)
      // the witness of the caret's FIRST frame: at the new editor's focus, the frame after it is sampled (at
      // the focus itself the app has not placed any caret yet, a chat's child included). A caret that is
      // moved later than that leaves room for a first key to land at the text's start
      await page.evaluate(() => {
        const w = window as any
        w.__caret_first = null
        const seen = (e: FocusEvent) => {
          const field = e.target as HTMLTextAreaElement | null
          if (field?.tagName != 'TEXTAREA' || field.id == 'textarea-mindbox') return
          document.removeEventListener('focusin', seen, true)
          requestAnimationFrame(() => void (w.__caret_first = [field.id, field.selectionStart, field.selectionEnd, field.value.length]))
        }
        document.addEventListener('focusin', seen, true)
      })
      await page.keyboard.press('Shift+Enter')
      await expect
        .poll(
          () => page.evaluate(n => document.querySelector('.container.target')?.getAttribute('data-item-id') === window._item(n, true)?.id, expectedName),
          { message: `${label} targets ${expectedName}`, timeout: 10_000 },
        )
        .toBe(true)
      const editorId = await page.evaluate(n => 'textarea-' + window._item(n, true)?.id, expectedName)
      await expect
        .poll(() => page.evaluate(() => (window as any).__caret_first), { message: `${label}: by the first frame after the editor's focus`, timeout: 10_000 })
        .toEqual([editorId, expectedValue.length, expectedValue.length, expectedValue.length])
      // and a character typed at once goes on from the text's end
      await page.keyboard.type('x')
      expect(await activeItemEditor(), `${label}: a typed character extends the text`).toEqual({
        name: expectedName,
        value: expectedValue + 'x',
        start: expectedValue.length + 1,
        end: expectedValue.length + 1,
        len: expectedValue.length + 1,
      })
      await page.keyboard.press('Backspace')
      expect((await activeItemEditor())?.value, `${label}: the character taken back`).toBe(expectedValue)
      await page.keyboard.press('Escape')
      await expect.poll(activeItemEditor, { message: `${label} editor closes on Escape`, timeout: 5_000 }).toBeNull()
      await expect.poll(() => savedId(page, expectedName), { message: `${expectedName} saved`, timeout: 30_000 }).toBeTruthy()
    }
    await runInMindbox('/vault', '#chat/vault/1', '#chat/vault/1 #_agent/vault\n<<user>> ', 'plain /vault Shift+Enter focuses editor with caret collapsed at end')
    await runInMindbox('/vault hello again', '#chat/vault/2', '#chat/vault/2 #_agent/vault\n<<user>> hello again', '/vault with words Shift+Enter focuses editor with caret collapsed after words')
    await runInMindbox('#chat/vault/1', '#chat/vault/1/0', '#chat/vault/1/0\n<<user>> ', 'chat child Shift+Enter keeps editor focused with caret collapsed at end')
    await userSet(page, '')

    await saved()
    expect(errors, 'no console errors or pageerrors on desktop bin-buttons row').toEqual([])
  } finally {
    await context.close()
  }
})

// PHONE TOUCH PAGE (Points 1, 2, 4): reuses BIN_USER as a returning device on a coarse-pointer
// 390x844 phone viewport. Verifies both corner buttons (reload and #vault sparkle) are 32 px
// centred on desktop's 24 px points, bin buttons sit on a second row lined up with reload,
// hide while a keyboard is up, and a tap on done completes the todo and selects the next row.
test('bin buttons on a phone touch page: 32 px corner buttons, second row lined up with reload, keyboard hide, and tap on done selects next', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('dialog', dialog => void (dialog.type() == 'beforeunload' ? dialog.accept() : dialog.dismiss()))
  page.on('console', msg => void (msg.type() == 'error' && !/ERR_NAME_NOT_RESOLVED|#template\/example/.test(msg.text()) && errors.push(msg.text())))
  page.on('pageerror', err => void errors.push(`pageerror: ${err.message}`))
  try {
    expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
    await page.addInitScript(secret => {
      localStorage.setItem('mindpage_github_token', 'e2e-local')
      localStorage.setItem('mindpage_secret', secret)
      localStorage.setItem('mindpage_kdf', 'off')
    }, BIN_SECRET)
    await signIn(page, BIN_USER)
    await loaded(page)
    await expect.poll(() => page.locator('.todoer-widget').count(), { timeout: 30_000 }).toBeGreaterThan(0)
    await page.evaluate(() => {
      const s = window._item('#status', true) as any
      const v = window._item('#vault', true) as any
      s._global_store._status = { hosts: { e2e: { publisher: 'bridge', updated: Date.now() } } }
      v._global_store._bridge = { host: 'e2e' }
      ;(window as any)._vault_sparkle?.show?.()
    })
    await expect(page.locator('[data-vault-sparkle="node"]'), 'phone sparkle visible').toBeVisible()
    await expect(page.locator('[data-key-buttons="reload"]'), 'phone reload visible').toBeVisible()
    const corners = await page.evaluate(() => {
      const r = document.querySelector('[data-key-buttons="reload"]')!.getBoundingClientRect()
      const s = document.querySelector('[data-vault-sparkle="node"]')!.getBoundingClientRect()
      return {
        coarse: matchMedia('(pointer: coarse)').matches,
        reload: [Math.round(r.left), Math.round(window.innerHeight - r.bottom), Math.round(r.width), Math.round(r.height)],
        sparkle: [Math.round(window.innerWidth - s.right), Math.round(window.innerHeight - s.bottom), Math.round(s.width), Math.round(s.height)],
      }
    })
    expect(corners, 'coarse-pointer phone shows both corner buttons at 32 px centred on desktop (26, 22)').toEqual({
      coarse: true,
      reload: [10, 6, 32, 32],
      sparkle: [10, 6, 32, 32],
    })

    for (const text of ['#bl_phone_1\n#todo first phone todo', '#bl_phone_2\n#todo second phone todo']) {
      await page.evaluate(text => void window._create(text), text)
    }
    for (const name of ['#bl_phone_1', '#bl_phone_2']) {
      await expect.poll(() => savedId(page, name), { timeout: 30_000 }).toBeTruthy()
    }
    const rowsNow = () =>
      page.evaluate(() => {
        const main = [...document.querySelectorAll('.todoer-widget')].find((w: any) => !w._snoozed && !w._delegated)
        return [...(main?.querySelectorAll('.list .list-item-container[data-id]') ?? [])].map(r => window._item(r.getAttribute('data-id')!, true)?.name ?? null)
      })
    await expect.poll(() => rowsNow().then(r => r.includes('#bl_phone_1') && r.includes('#bl_phone_2')), { timeout: 15_000 }).toBe(true)
    await userSet(page, '#bl_phone_1')
    const guests = page.locator('.key-buttons-guests')
    await expect(guests, 'second-row bin buttons visible on phone').toBeVisible({ timeout: 5_000 })
    await expect.poll(() => page.locator('.todoer-widget .list-item-container.selected').count(), { timeout: 5_000 }).toBe(1)
    const phoneLayout = await page.evaluate(() => {
      const g = document.querySelector('.key-buttons-guests') as HTMLElement
      const r = document.querySelector('[data-key-buttons="reload"]')!.getBoundingClientRect()
      const gr = g.getBoundingClientRect()
      const floor = document.querySelector('.key-buttons-bg > .key-buttons-bg-floor') as HTMLElement
      const fr = floor.getBoundingClientRect()
      return {
        cls: g.className,
        linedUp: Math.round(gr.left) === Math.round(r.left) && Math.round(gr.left) === 10,
        bottom: Math.round(window.innerHeight - gr.bottom),
        btnSizes: [...g.children].map(b => [Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]),
        floorShown: getComputedStyle(floor).display != 'none',
        floorBottom: Math.round(window.innerHeight - fr.bottom),
        floorHeight: Math.round(fr.height),
      }
    })
    expect(phoneLayout, 'phone second row lines up with 32 px reload button at left 10, bottom 50, with 32 px buttons and glass floor').toEqual({
      cls: 'key-buttons-guests floor touch',
      linedUp: true,
      bottom: 50,
      btnSizes: Array(6).fill([32, 32]),
      floorShown: true,
      floorBottom: 44,
      floorHeight: 44,
    })

    // simulated on-screen keyboard hides the bin buttons along with the main bar; closing brings them back
    await page.locator('.header .backdrop').first().click()
    await expect(page.locator('#textarea-mindbox')).toBeFocused()
    await page.evaluate(() => {
      const view = window.visualViewport!
      Object.defineProperty(view, 'height', { configurable: true, get: () => window.innerHeight - 336 })
      view.dispatchEvent(new Event('resize'))
    })
    await expect(guests, 'bin buttons hide while on-screen keyboard is up').toBeHidden({ timeout: 5_000 })
    await page.evaluate(() => {
      const view = window.visualViewport!
      delete (view as any).height
      view.dispatchEvent(new Event('resize'))
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    })
    await expect(guests, 'bin buttons return when keyboard closes').toBeVisible({ timeout: 5_000 })

    // real tap on done button completes #bl_phone_1 and selects the next row
    const phoneRows = await rowsNow()
    const p1Idx = phoneRows.indexOf('#bl_phone_1')
    const expectedNext = phoneRows[p1Idx + 1] ?? phoneRows[p1Idx - 1]
    await page.locator('.key-buttons-guests > button[data-guest="done"]').tap({ timeout: 5_000 })
    await expect.poll(() => page.evaluate(() => window._item('#bl_phone_1', true)?.text ?? ''), { message: 'tap on done completed #bl_phone_1', timeout: 15_000 }).toContain('#done')
    await expect.poll(() => page.evaluate(() => (window as any).MindBox.get().trim()), { message: 'tap on done selected next row on phone', timeout: 10_000 }).toBe(expectedNext)
    expect(errors, 'no console errors or pageerrors on phone bin-buttons row').toEqual([])
  } finally {
    await context.close()
  }
})

// SHORTCUTS MENU (#shortcuts + #todoer): self-contained account verifying plain `?` in the window
// (no row, todo first row, reply row with bell), all five tab buttons (keeping the dialog open),
// box & item editor typing vs modifier-open and caret restoration on `?` and Escape, yielding to
// another dialog, a second item's section (inactive & throwing tests), a hostile section rendered
// as text only (no elements/links/images/dialogs/requests/errors), and #shortcuts' own page.
test('shortcuts menu: now and reference views, box and editor contexts, caret return, second item, hostile text, and own page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, hasTouch: false })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const browserDialogs: string[] = []
  const errors: string[] = []
  const hostileRequests: string[] = []
  page.on('dialog', dialog => {
    browserDialogs.push(`${dialog.type()}: ${dialog.message()}`)
    void (dialog.type() == 'beforeunload' ? dialog.accept() : dialog.dismiss())
  })
  page.on('console', msg => void (msg.type() == 'error' && !/ERR_NAME_NOT_RESOLVED|#template\/example/.test(msg.text()) && errors.push(msg.text())))
  page.on('pageerror', err => void errors.push(`pageerror: ${err.message}`))
  page.on('request', req => {
    if (/hostile-shortcut|evil\.example/i.test(req.url())) hostileRequests.push(req.url())
  })
  try {
    expect(await interceptMindItems(page), 'mind.items local checkout required').toBe(true)
    await page.addInitScript(() => localStorage.setItem('mindpage_github_token', 'e2e-local'))
    await signIn(page, SHORTCUTS_USER)
    await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
    await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
    await waitForApp(page)
    expect(await install(page, 'todoer'), '/_install todoer').toBeNull()
    expect(await install(page, 'agent/vault'), '/_install agent/vault').toBeNull()
    const saved = () =>
      expect
        .poll(() => page.evaluate(() => window.__items.every(item => item.savedId && !item.saving)), { message: 'all items saved', timeout: 60_000 })
        .toBe(true)
    await saved()
    // ignore transient multi-item dependency-order errors from /_install todoer & agent/vault;
    // keep everything from /_install shortcuts onward (including reload and all test steps)
    errors.length = 0
    expect(await install(page, 'shortcuts'), '/_install shortcuts').toBeNull()
    await expect
      .poll(() => page.evaluate(() => typeof (window as any)._shortcuts_menu?.show), { message: 'controller stands after install without reload', timeout: 30_000 })
      .toBe('function')
    await saved()
    await page.reload()
    await loaded(page)
    expect(errors, 'no console errors or pageerrors during #shortcuts install and reload').toEqual([])
    await expect
      .poll(() => page.evaluate(() => typeof (window as any)._shortcuts_menu?.show), { message: 'controller stands after reload (_on_welcome)', timeout: 30_000 })
      .toBe('function')
    await page.evaluate(() => (window._item('#todoer') as any).eval('create_pinned_item()'))
    await expect.poll(() => page.locator('.todoer-widget').count(), { timeout: 30_000 }).toBe(2)

    // Create first todo and wait for todoer baselines so a reply chat created next gets its bell
    await page.evaluate(() => void window._create('#sm_one\n#todo first shortcuts todo'))
    await expect.poll(() => savedId(page, '#sm_one'), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => page.locator('.todoer-widget').first().locator('.list-item-container').count(), { timeout: 30_000 }).toBe(1)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const st = (window._item('#todoer') as any)?._global_store
            return (st?.rows_since ?? 0) > 0 && !!st?.bells_base
          }),
        { timeout: 30_000 },
      )
      .toBe(true)
    // Create reply chat then second todo so the main list has [todo, reply (middle), todo]
    const SM_REPLY =
      "#sm_reply/0 #_chat #_agent/vault\n<<user>> hi\n<<agent('vault/default · run cd34ef56 · 1s')>>\n<!--inert-->\nShortcuts reply.\n<!--/inert-->"
    await page.evaluate(text => void window._create(text), SM_REPLY)
    await expect.poll(() => savedId(page, '#sm_reply/0'), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => page.locator('.todoer-widget').first().locator('.list-item-container').count(), { timeout: 30_000 }).toBe(2)
    await page.evaluate(() => void window._create('#sm_two\n#todo second shortcuts todo'))
    await expect.poll(() => savedId(page, '#sm_two'), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => page.locator('.todoer-widget').first().locator('.list-item-container').count(), { timeout: 30_000 }).toBe(3)
    await expect.poll(() => page.evaluate(() => ((window as any)._shortcuts?.todoer ?? []).length), { timeout: 30_000 }).toBe(11)

    const mainRows = () =>
      page.evaluate(() => {
        const main = [...document.querySelectorAll('.todoer-widget')].find((w: any) => !w._snoozed && !w._delegated)
        return [...(main?.querySelectorAll('.list .list-item-container[data-id]') ?? [])].map(r => window._item(r.getAttribute('data-id')!, true)?.name ?? null)
      })
    expect(await mainRows(), 'main list order puts reply in the middle between two todos').toEqual(['#sm_two', '#sm_reply/0', '#sm_one'])

    const menu = page.locator('.modal .shortcuts-menu')
    const boxNow = () => page.evaluate(() => (window as any).MindBox.get())
    const unfocus = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    const TABS = ['now', 'window', 'box', 'editor', 'all']
    const shown = () =>
      page.evaluate(() => {
        const m = document.querySelector('.modal .shortcuts-menu') as HTMLElement | null
        if (!m || !m.closest('.background.visible') || getComputedStyle(m).visibility != 'visible') return null
        return {
          view: m.dataset.view,
          context: m.dataset.context,
          on: [...m.querySelectorAll('.tabs > button.on')].map(b => b.textContent),
          tabs: [...m.querySelectorAll('.tabs > button')].map(b => b.textContent),
          where: m.querySelector('.where')?.textContent ?? null,
          sections: [...m.querySelectorAll('.section')].map(s => [s.querySelector('.name')?.textContent, s.querySelectorAll('tr').length]),
          none: m.querySelector('.none')?.textContent ?? null,
        }
      })
    const rowsShown = () => page.evaluate(() => [...document.querySelectorAll('.modal .shortcuts-menu tr')].map(tr => (tr as HTMLElement).innerText))

    // 1. Plain ? in window with no row selected: opens on now with j and k alone
    await userSet(page, '')
    await unfocus()
    await page.keyboard.press('Shift+Slash')
    await expect(menu, 'plain ? in window opens shortcuts menu').toBeVisible({ timeout: 5_000 })
    expect(await shown(), 'now view in window with no row selected').toEqual({
      view: 'now',
      context: 'window',
      on: ['now'],
      tabs: TABS,
      where: 'what the keys do right now, in the window',
      sections: [['todoer', 2]],
      none: null,
    })
    expect(await rowsShown(), 'no row selected: j and k alone without conditions').toEqual([
      "j\tthe main list's first row",
      "k\tthe main list's last row",
    ])

    // 2. Every tab button switches view and keeps the menu open (stopPropagation)
    await menu.locator('.tabs > button', { hasText: 'window' }).click()
    await expect
      .poll(() => shown().then(s => s && [s.view, s.on, s.where, s.sections]), { message: 'window tab switches view and keeps menu open', timeout: 5_000 })
      .toEqual(['window', ['window'], null, [['todoer', 11]]])
    expect((await rowsShown())[0], 'reference view includes condition in brackets').toBe('j\tthe next row (a row is selected that is not the last of its list)')

    await menu.locator('.tabs > button', { hasText: 'box' }).click()
    await expect
      .poll(() => shown().then(s => s && [s.view, s.on, s.sections, s.none]), { message: 'box tab switches view and keeps menu open', timeout: 5_000 })
      .toEqual(['box', ['box'], [], 'no item has added a shortcut for this context'])

    await menu.locator('.tabs > button', { hasText: 'editor' }).click()
    await expect
      .poll(() => shown().then(s => s && [s.view, s.on, s.sections, s.none]), { message: 'editor tab switches view and keeps menu open', timeout: 5_000 })
      .toEqual(['editor', ['editor'], [], 'no item has added a shortcut for this context'])

    await menu.locator('.tabs > button', { hasText: 'all' }).click()
    await expect
      .poll(() => shown().then(s => s && [s.view, s.on, s.sections]), { message: 'all tab switches view and keeps menu open', timeout: 5_000 })
      .toEqual(['all', ['all'], [['todoer', 11]]])

    await menu.locator('.tabs > button', { hasText: 'now' }).click()
    await expect
      .poll(() => shown().then(s => s && [s.view, s.on, s.where, s.sections]), { message: 'now tab returns to now view and keeps menu open', timeout: 5_000 })
      .toEqual(['now', ['now'], 'what the keys do right now, in the window', [['todoer', 2]]])

    // Escape closes it; ? opens and closes it again
    await page.keyboard.press('Escape')
    await expect(menu, 'Escape closes shortcuts menu').toBeHidden({ timeout: 5_000 })
    await page.keyboard.press('Shift+Slash')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Shift+Slash')
    await expect(menu, 'same key closes shortcuts menu').toBeHidden({ timeout: 5_000 })

    // 3. First todo row selected: no k, and the keys of its buttons (j, a, d, s, x)
    await page.keyboard.press('j')
    await expect.poll(() => boxNow().then(b => b.trim()), { timeout: 5_000 }).toBe('#sm_two')
    await page.keyboard.press('Shift+Slash')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    expect(await rowsShown(), 'first todo row selected: j, a, d, s, x and no k').toEqual([
      'j\tthe next row',
      'a\tdelegate to the agent',
      'd\tdone',
      's\tsnooze',
      'x\tdelete, after a question',
    ])
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden({ timeout: 5_000 })

    // 4. Reply row in the middle (with bell): j, k, and b alone
    await page.keyboard.press('j')
    await expect.poll(() => boxNow().then(b => b.trim()), { timeout: 5_000 }).toBe('#sm_reply/0')
    await page.keyboard.press('Shift+Slash')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    expect(await rowsShown(), 'reply row in middle with bell: j, k, b alone').toEqual([
      'j\tthe next row',
      'k\tthe previous row',
      'b\tclear the bell',
    ])
    await page.keyboard.press('Shift+Slash')
    await expect(menu).toBeHidden({ timeout: 5_000 })

    // 5. In the box: plain ? types its character; Ctrl+? opens on box's now; both ? and Escape restore focus and caret
    await userSet(page, '')
    await focusMindbox(page)
    await page.keyboard.type('what?')
    await page.waitForTimeout(200)
    expect([await boxNow(), await menu.isVisible()], 'plain ? in box types character without opening menu').toEqual(['what?', false])
    await page.evaluate(() => {
      const box = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
      box.setSelectionRange(2, 2)
    })
    await page.keyboard.press('Control+Shift+Slash')
    await expect(menu, 'Ctrl+? opens menu from box').toBeVisible({ timeout: 5_000 })
    expect(
      await shown().then(s => s && [s.view, s.context, s.where, s.sections, s.none]),
      'box now view shows box context and empty now notice',
    ).toEqual(['now', 'box', 'what the keys do right now, in the box', [], 'no shortcut of an item does anything here right now'])
    expect(await boxNow(), 'Ctrl+? leaves box text untouched').toBe('what?')
    // let Modal.svelte's open-time {#if _visible}<script>setTimeout(blur)</script> finish before synchronous close
    await page.evaluate(() => new Promise(r => setTimeout(r, 0)))
    await page.keyboard.press('Shift+Slash')
    await expect(menu, '? closes menu opened from box').toBeHidden({ timeout: 5_000 })
    const boxCaret = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLTextAreaElement | null
        const field = document.getElementById('textarea-mindbox') as HTMLTextAreaElement
        return [el?.id ?? null, field.value, el?.selectionStart ?? -1, el?.selectionEnd ?? -1]
      })
    expect(await boxCaret(), 'closing with ? restores box focus and caret').toEqual(['textarea-mindbox', 'what?', 2, 2])
    await page.keyboard.press('Control+Shift+Slash')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Escape')
    await expect(menu, 'Escape closes menu opened from box').toBeHidden({ timeout: 5_000 })
    expect(await boxCaret(), 'closing with Escape restores box focus and caret').toEqual(['textarea-mindbox', 'what?', 2, 2])

    // 5b. Selection-dependent box entry + keyboard-only view switches/scroll + opening snapshot + selection return + held close key
    await page.evaluate(() => {
      const added = ((window as any)._shortcuts ??= {})
      added.steer_probe = [
        {
          keys: 'q',
          does: 'acts on the selection of the box',
          context: 'box',
          active: () => ((f: any) => f?.id == 'textarea-mindbox' && f.selectionStart != f.selectionEnd)(document.activeElement),
        },
        ...Array.from({ length: 60 }, (_, i) => ({ keys: `w${i}`, does: `window scroll key ${i}`, context: 'window' })),
      ]
    })
    await userSet(page, '')
    await unfocus()
    await focusMindbox(page)
    await page.keyboard.type('hello world')
    await page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).setSelectionRange(6, 11))
    await page.keyboard.press('Control+Shift+Slash')
    await expect(menu, 'Ctrl+? with box selection opens menu').toBeVisible({ timeout: 5_000 })
    expect(
      [await menu.getAttribute('data-view'), await menu.getAttribute('data-context'), (await rowsShown()).includes('q\tacts on the selection of the box')],
      'selection-dependent box entry is listed on open',
    ).toEqual(['now', 'box', true])
    // Reach a reference view, scroll a long list, wrap round, and return to now using KEYS ONLY
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => shown().then(s => s?.view), { message: 'ArrowRight switches to window view', timeout: 5_000 }).toBe('window')
    await page.keyboard.press('ArrowDown')
    const scrollAfterDown = await menu.evaluate(e => [Math.round(e.scrollTop), e.scrollHeight, e.clientHeight])
    expect(scrollAfterDown[0], 'ArrowDown moves long shortcuts list').toBeGreaterThan(0)
    expect(scrollAfterDown[1], 'long section overflows menu box').toBeGreaterThan(scrollAfterDown[2])
    await page.keyboard.press('PageDown')
    const scrollAfterPage = await menu.evaluate(e => Math.round(e.scrollTop))
    expect(scrollAfterPage, 'PageDown moves further down').toBeGreaterThan(scrollAfterDown[0])
    await page.keyboard.press('End')
    const scrollAtEnd = await menu.evaluate(e => [Math.round(e.scrollTop), e.scrollHeight - e.clientHeight])
    expect(scrollAtEnd[0], 'End scrolls to bottom of list').toBeGreaterThanOrEqual(scrollAtEnd[1] - 2)
    await page.keyboard.press('Home')
    expect(await menu.evaluate(e => Math.round(e.scrollTop)), 'Home returns to top of list').toBe(0)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => shown().then(s => s?.view), { message: 'ArrowLeft returns to now', timeout: 5_000 }).toBe('now')
    expect((await rowsShown()).includes('q\tacts on the selection of the box'), 'opening snapshot keeps selection-dependent entry back on now').toBe(true)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => shown().then(s => s?.view), { message: 'ArrowLeft wraps round to all', timeout: 5_000 }).toBe('all')
    await page.keyboard.press('Tab')
    await expect.poll(() => shown().then(s => s?.view), { message: 'Tab wraps round to now', timeout: 5_000 }).toBe('now')
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => shown().then(s => s?.view), { message: 'Shift+Tab wraps back to all', timeout: 5_000 }).toBe('all')
    await page.keyboard.press('Tab')
    await expect.poll(() => shown().then(s => s?.view), { message: 'Tab returns to now again', timeout: 5_000 }).toBe('now')
    expect((await rowsShown()).includes('q\tacts on the selection of the box'), 'selection-dependent entry still listed after Tab round-trip').toBe(true)
    await page.evaluate(() => new Promise(r => setTimeout(r, 0)))
    await page.keyboard.press('Shift+Slash')
    await expect(menu, '? closes menu after keyboard navigation').toBeHidden({ timeout: 5_000 })
    expect(await boxCaret(), 'closing after keyboard navigation restores box selection untouched').toEqual(['textarea-mindbox', 'hello world', 6, 11])

    // 5c. Held close key in a field: repeats (both with Shift held and after Shift is let go first) do not type into box or replace selection; fresh press types
    await page.keyboard.press('Control+Shift+Slash')
    await expect(menu, 'Ctrl+? reopens menu from box selection').toBeVisible({ timeout: 5_000 })
    await page.evaluate(() => new Promise(r => setTimeout(r, 0)))
    await page.keyboard.down('?')
    for (let i = 0; i < 4; i++) await page.keyboard.down('?') // Playwright dispatches repeat=true while key is held
    await page.keyboard.up('?')
    await expect(menu, 'held plain ? closes menu').toBeHidden({ timeout: 5_000 })
    await page.waitForTimeout(150)
    expect(await boxCaret(), 'held ? repeats do not type into box or replace selection').toEqual(['textarea-mindbox', 'hello world', 6, 11])

    // Shift let go before Slash while Slash is still held: repeats now carry '/' without Shift and must still be swallowed
    await page.keyboard.press('Control+Shift+Slash')
    await expect(menu, 'Ctrl+? reopens menu for Shift-up-first hold check').toBeVisible({ timeout: 5_000 })
    await page.evaluate(() => new Promise(r => setTimeout(r, 0)))
    await page.keyboard.down('Shift')
    await page.keyboard.down('Slash')
    await page.keyboard.up('Shift')
    for (let i = 0; i < 3; i++) await page.keyboard.down('Slash') // repeat=true with key='/' and shiftKey=false
    await page.keyboard.up('Slash')
    await expect(menu, 'Shift+Slash closes menu when Shift releases before Slash repeats').toBeHidden({ timeout: 5_000 })
    await page.waitForTimeout(150)
    expect(await boxCaret(), 'Slash repeats after releasing Shift do not type or replace selection').toEqual([
      'textarea-mindbox',
      'hello world',
      6,
      11,
    ])
    await page.keyboard.press('Slash')
    await page.waitForTimeout(150)
    expect([await menu.isVisible(), await boxCaret()], 'fresh Slash after release types into box and replaces selection').toEqual([
      false,
      ['textarea-mindbox', 'hello /', 7, 7],
    ])
    await page.keyboard.press('?')
    await page.waitForTimeout(150)
    expect([await menu.isVisible(), await boxCaret()], 'fresh plain ? after release also types into box').toEqual([
      false,
      ['textarea-mindbox', 'hello /?', 8, 8],
    ])
    // Take back the temporary probe section by writing an empty list
    await page.evaluate(() => {
      ;(window as any)._shortcuts.steer_probe = []
    })

    // 6. In an item's editor: plain ? types its character; Ctrl+? and Alt+? open on editor's now; both ? and Escape restore caret
    await userSet(page, '#sm_one')
    await expect(page.locator('.container.target')).toBeVisible({ timeout: 5_000 })
    await unfocus()
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName), { timeout: 5_000 }).not.toBe('TEXTAREA')
    await page.keyboard.press('Enter')
    const editor = page.locator('.super-container .container.editing textarea').first()
    await expect(editor).toBeVisible({ timeout: 5_000 })
    await editor.focus()
    const beforeEd = await editor.inputValue()
    await editor.evaluate(el => {
      const ta = el as HTMLTextAreaElement
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
    await page.keyboard.type('?')
    await page.waitForTimeout(200)
    expect([await editor.inputValue(), await menu.isVisible()], 'plain ? in editor types character without opening menu').toEqual([beforeEd + '?', false])
    await page.keyboard.press('Backspace')
    await expect.poll(() => editor.inputValue(), { timeout: 5_000 }).toBe(beforeEd)
    const editorId = await editor.evaluate(el => {
      const ta = el as HTMLTextAreaElement
      ta.setSelectionRange(3, 3)
      return ta.id
    })
    await page.keyboard.press('Control+Shift+Slash')
    await expect(menu, 'Ctrl+? opens menu from item editor').toBeVisible({ timeout: 5_000 })
    expect(
      await shown().then(s => s && [s.view, s.context, s.where, s.sections, s.none]),
      'editor now view shows editor context',
    ).toEqual(['now', 'editor', "what the keys do right now, in an item's editor", [], 'no shortcut of an item does anything here right now'])
    await page.evaluate(() => new Promise(r => setTimeout(r, 0)))
    await page.keyboard.press('Shift+Slash')
    await expect(menu, '? closes menu opened from editor').toBeHidden({ timeout: 5_000 })
    expect(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLTextAreaElement | null
        return [el?.id ?? null, el?.selectionStart ?? -1, el?.selectionEnd ?? -1]
      }),
      'closing with ? restores editor focus and caret',
    ).toEqual([editorId, 3, 3])
    await page.keyboard.press('Alt+Shift+Slash')
    await expect(menu, 'Alt+? opens menu from item editor').toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Escape')
    await expect(menu, 'Escape closes menu opened from editor').toBeHidden({ timeout: 5_000 })
    expect(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLTextAreaElement | null
        return [el?.id ?? null, el?.selectionStart ?? -1, el?.selectionEnd ?? -1]
      }),
      'closing with Escape restores editor focus and caret',
    ).toEqual([editorId, 3, 3])
    await page.keyboard.press('Escape') // cancel unmodified edit
    await expect(editor).toBeHidden({ timeout: 5_000 })

    // 6b. Todoer dirty unfocused editor: hides x, d, a while draft stands, restores them after draft is discarded
    await userSet(page, '#sm_two')
    await expect(page.locator('.container.target')).toBeVisible({ timeout: 5_000 })
    await unfocus()
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName), { timeout: 5_000 }).not.toBe('TEXTAREA')
    await page.keyboard.press('Enter')
    const dirtyEditor = page.locator('.super-container .container.editing textarea').first()
    await expect(dirtyEditor).toBeVisible({ timeout: 5_000 })
    await expect(dirtyEditor).toBeFocused({ timeout: 5_000 })
    await dirtyEditor.evaluate(el => {
      const ta = el as HTMLTextAreaElement
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
    await page.keyboard.type(' unsaved')
    // the focus is taken from the editor, and taken again until it stays away over the page's
    // update: a layout that ran while the editor had the focus gives its field the focus AGAIN
    // after that update (index.svelte, the layout's `update_dom().then`), which put the opening
    // key, or Escape, into the editor under the menu
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            ;(document.activeElement as HTMLElement | null)?.blur?.()
            await (window as any)._update_dom()
            await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
            return document.activeElement?.tagName ?? null
          }),
        { timeout: 5_000 },
      )
      .not.toBe('TEXTAREA')
    await page.keyboard.press('Shift+Slash')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    expect(await rowsShown(), 'dirty unfocused todo editor hides a, d, x and keeps j and s').toEqual(['j\tthe next row', 's\tsnooze'])
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden({ timeout: 5_000 })
    // Discard the draft and verify a, d, x return
    await dirtyEditor.focus()
    await page.keyboard.press('Escape')
    const discardBtn = page.locator('.modal .button.confirm', { hasText: 'Discard' })
    await expect(discardBtn, 'Escape on dirty edit asks to discard').toBeVisible({ timeout: 5_000 })
    await discardBtn.click()
    await expect(dirtyEditor, 'discarded editor closes').toBeHidden({ timeout: 5_000 })
    await unfocus()
    await page.keyboard.press('Shift+Slash')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    expect(await rowsShown(), 'after discarding draft, todoer lists a, d, x again').toEqual([
      'j\tthe next row',
      'a\tdelegate to the agent',
      'd\tdone',
      's\tsnooze',
      'x\tdelete, after a question',
    ])
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden({ timeout: 5_000 })

    // 7. Another dialog keeps the key
    await unfocus()
    await page.evaluate(() => void (window as any)._modal('other dialog keeps keys'))
    await expect(page.locator('.modal', { hasText: 'other dialog keeps keys' })).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Shift+Slash')
    await page.waitForTimeout(200)
    expect([await menu.isVisible(), await page.locator('.modal', { hasText: 'other dialog keeps keys' }).isVisible()], 'other dialog keeps ? and menu stays hidden').toEqual([false, true])
    await page.evaluate(() => (window as any)._modal_close())
    await expect(page.locator('.modal', { hasText: 'other dialog keeps keys' })).toBeHidden({ timeout: 5_000 })

    // 8. A second item adds a section with active, inactive, and throwing entries (plus a box/editor entry)
    const EXTRA_ITEM = [
      '#sm_extra #_welcome',
      '```js_removed',
      'function _on_item_change(id) {',
      '  if (id != _this.id) return',
      "  ;(window._shortcuts ??= {})['extra item'] = [",
      "    { keys: 'g', does: 'go now', when: 'ready', active: () => true },",
      "    { keys: 'n', does: 'says no', when: 'inactive now', active: () => false },",
      "    { keys: 'e', does: 'throws now', when: 'broken test', active: () => { throw new Error('extra gone') } },",
      "    { keys: 'c', does: 'field helper', when: 'in a field', context: ['box', 'editor'] },",
      '  ]',
      '}',
      '```',
    ].join('\n')
    await page.evaluate(text => void window._create(text), EXTRA_ITEM)
    await expect.poll(() => savedId(page, '#sm_extra'), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => page.evaluate(() => ((window as any)._shortcuts?.['extra item'] ?? []).length), { timeout: 15_000 }).toBe(4)

    await userSet(page, '')
    await unfocus()
    await page.keyboard.press('Shift+Slash')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    expect((await shown())?.sections, 'now in window includes second item active entry alone (skips no and throws)').toEqual([
      ['todoer', 2],
      ['extra item', 1],
    ])
    expect(await rowsShown(), 'second item active entry shown without condition').toEqual([
      "j\tthe main list's first row",
      "k\tthe main list's last row",
      'g\tgo now',
    ])
    await menu.locator('.tabs > button', { hasText: 'window' }).click()
    await expect.poll(() => shown().then(s => s?.sections), { timeout: 5_000 }).toEqual([
      ['todoer', 11],
      ['extra item', 3],
    ])
    await menu.locator('.tabs > button', { hasText: 'box' }).click()
    await expect.poll(() => shown().then(s => s?.sections), { timeout: 5_000 }).toEqual([['extra item', 1]])
    expect(await rowsShown(), 'box reference view shows second item field entry with condition').toEqual(['c\tfield helper (in a field)'])
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden({ timeout: 5_000 })

    // 9. Hostile section written from the page: text only (no elements, links, images, dialogs, requests, or errors)
    const hostileBeforeDialogs = browserDialogs.length
    const hostileBeforeRequests = hostileRequests.length
    const hostilePayloads = await page.evaluate(() => {
      const dblLt = '<'.repeat(2)
      const list = [
        '<img src="http://127.0.0.1:3100/hostile-shortcut-1.png" onerror="alert(\'xss-img\')">',
        '<div onmouseover="alert(\'xss-div\')">hover</div>',
        "<script>alert('xss-script')</script>",
        '[click](https://evil.example/link)',
        '![pic](http://127.0.0.1:3100/hostile-shortcut-2.png)',
        `${dblLt}alert(1)>>`,
        '#hostile_tag',
        '"double" & \'single\'',
        'line1\n\n# heading\n![pic3](http://127.0.0.1:3100/hostile-shortcut-3.png)\n[link2](https://evil.example/l2)\n<script>alert("xss-nl")</script>',
      ]
      const name = list.join(' | ')
      ;((window as any)._shortcuts ??= {})[name] = list.map((p, i) => ({
        keys: p,
        does: `d${i}: ${p}`,
        when: `w${i}: ${p}`,
        active: () => true,
      }))
      return list
    })

    await page.keyboard.press('Shift+Slash')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    const inspectModalDom = () =>
      page.evaluate(() => {
        const modal = document.querySelector('.modal')!
        const allTags = new Set<string>()
        for (const el of modal.querySelectorAll('*')) allTags.add(el.tagName.toLowerCase())
        const hostileSection = [...modal.querySelectorAll('.shortcuts-menu .section')].find(s =>
          (s.querySelector('.name')?.textContent ?? '').includes('hostile-shortcut-1.png'),
        ) as HTMLElement | undefined
        const sectionTags: Record<string, number> = {}
        if (hostileSection) {
          for (const el of hostileSection.querySelectorAll('*')) {
            const t = el.tagName.toLowerCase()
            sectionTags[t] = (sectionTags[t] ?? 0) + 1
          }
        }
        return {
          links: modal.querySelectorAll('a').length,
          images: modal.querySelectorAll('img').length,
          scripts: modal.querySelectorAll('script').length,
          extraTags: [...allTags].filter(t => !['div', 'button', 'table', 'tbody', 'tr', 'td', 'span'].includes(t)),
          sectionTags,
          sectionText: hostileSection?.innerText ?? '',
        }
      })

    const domNow = await inspectModalDom()
    expect(
      [domNow.links, domNow.images, domNow.scripts, domNow.extraTags, domNow.sectionTags],
      'hostile section on now adds no link, image, script, or foreign element',
    ).toEqual([0, 0, 0, [], { div: 1, table: 1, tbody: 1, tr: 9, td: 18 }])
    // Switch to all so hostile `when` strings are also rendered
    await menu.locator('.tabs > button', { hasText: 'all' }).click()
    await expect.poll(() => shown().then(s => s?.view), { timeout: 5_000 }).toBe('all')
    const domAll = await inspectModalDom()
    // Structure checked strictly inside the hostile section itself (1 .name div, 1 table/tbody, 9 tr, 18 td, 9 .when span)
    expect(
      [domAll.links, domAll.images, domAll.scripts, domAll.extraTags, domAll.sectionTags],
      'hostile section on all adds no link, image, script, or foreign element and keeps exact section structure',
    ).toEqual([0, 0, 0, [], { div: 1, table: 1, tbody: 1, tr: 9, td: 18, span: 9 }])
    for (const p of hostilePayloads) {
      const normalized = p.replace(/\s+/g, ' ')
      expect(domAll.sectionText, `hostile payload rendered as literal text: ${normalized}`).toContain(normalized)
    }
    expect(browserDialogs.slice(hostileBeforeDialogs), 'no browser dialog opened by hostile payloads').toEqual([])
    expect(hostileRequests.slice(hostileBeforeRequests), 'no network request left for hostile image URLs').toEqual([])
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden({ timeout: 5_000 })

    // 9b. Second item named #shortcuts: watch retires controller within its 15 s look and restores it once alone again
    const tRetire0 = Date.now()
    await page.evaluate(() => void window._create('#shortcuts a second item under the name'))
    await expect
      .poll(() => page.evaluate(() => typeof (window as any)._shortcuts_menu), { message: 'watch retires controller while two items carry #shortcuts', timeout: 25_000, intervals: [500] })
      .toBe('undefined')
    const retireMs = Date.now() - tRetire0
    await unfocus()
    await page.keyboard.press('Shift+Slash')
    await page.waitForTimeout(200)
    expect(await menu.isVisible(), '? does nothing while two #shortcuts items exist').toBe(false)
    const tRecover0 = Date.now()
    await page.evaluate(() => {
      const second = (window.__items as any[]).find(item => item.text.startsWith('#shortcuts a second item'))
      ;(window._item('id:' + second.id, true) as any).delete(false)
    })
    await expect
      .poll(() => page.evaluate(() => typeof (window as any)._shortcuts_menu?.show), { message: 'watch restores controller once #shortcuts is alone again', timeout: 25_000, intervals: [500] })
      .toBe('function')
    const recoverMs = Date.now() - tRecover0
    console.log(`SHORTCUTS_WATCH_MS: retire=${retireMs} recover=${recoverMs}`)
    await unfocus()
    await page.keyboard.press('Shift+Slash')
    await expect(menu, '? opens menu again after duplicate #shortcuts is removed').toBeVisible({ timeout: 5_000 })
    expect(await menu.getAttribute('data-view'), 'restored menu opens on now').toBe('now')
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden({ timeout: 5_000 })

    // 10. #shortcuts' own page: text drawn, code not shown, no missing tags
    await userSet(page, '#shortcuts')
    await expect(page.locator('.container.target')).toBeVisible({ timeout: 5_000 })
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const t = window._item('#shortcuts', true) as any
            const text = t?.elem?.innerText ?? ''
            return {
              drawn: text.length > 200 && text.includes('shows the keyboard shortcuts'),
              codeShown: /_shortcuts_create|function _shortcuts|_SHORTCUTS_CSS/.test(text),
              missing: t?.missingTags ?? [],
            }
          }),
        { message: "#shortcuts' own page draws its text without its code or missing tags", timeout: 5_000 },
      )
      .toEqual({ drawn: true, codeShown: false, missing: [] })

    expect(errors, 'no console errors or pageerrors on shortcuts menu row').toEqual([])
  } finally {
    await context.close()
  }
})
