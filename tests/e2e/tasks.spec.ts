import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { customToken, firestore, install, interceptMindItems, secretFor, waitForApp, type TestUser } from './helpers.js'

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
// gesture to the agent bin is the same enqueue
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
const FIXTURE = resolve('tests/e2e/fixtures/task_command.json')

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
async function writeStore(id: string, name: string, item: unknown) {
  const { encryptWithSecret } = await import('../../src/crypto.js')
  const time = Date.now()
  const cipher = await encryptWithSecret(JSON.stringify({ hidden: true, time, attr: null, text: JSON.stringify({ name, item }) }), SECRET)
  await firestore().collection('items').doc(id).set({ user: USER.uid, time, hidden: true, text: null, attr: null, cipher })
}

// the decrypted text of a visible document as the SERVER holds it (the raw bytes, inert regions
// included, unlike the app's grammar-view read)
async function serverText(id: string): Promise<string | null> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const data = (await firestore().collection('items').doc(id).get()).data()
  if (!data?.cipher) return data?.text ?? null
  return JSON.parse(await decryptWithSecret(data.cipher, SECRET)).text ?? null
}

// the hidden document that holds a wrapper name (to rewrite a store in place, as another tab would)
async function storeDocId(name: string): Promise<string | null> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const snap = await firestore().collection('items').where('user', '==', USER.uid).where('hidden', '==', true).get()
  for (const doc of snap.docs) {
    try {
      const wrapper = JSON.parse(JSON.parse(await decryptWithSecret(doc.data().cipher, SECRET)).text)
      if (wrapper.name == name) return doc.id
    } catch {}
  }
  return null
}
// the store value the server holds under a wrapper name (decrypting every hidden document of
// the account, since names live inside the ciphertext), or null when none does
async function serverStore(name: string): Promise<any> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const snap = await firestore().collection('items').where('user', '==', USER.uid).where('hidden', '==', true).get()
  for (const doc of snap.docs) {
    try {
      const plain = JSON.parse(await decryptWithSecret(doc.data().cipher, SECRET))
      const wrapper = JSON.parse(plain.text)
      if (wrapper.name == name) return wrapper.item
    } catch {} // an unrelated or differently keyed record
  }
  return null
}

// the bridge's text write behind the app: the visible document's decrypted text replaced
async function rewriteText(id: string, edit: (text: string) => string) {
  const { decryptWithSecret, encryptWithSecret } = await import('../../src/crypto.js')
  const ref = firestore().collection('items').doc(id)
  const data = (await ref.get()).data()!
  const inner = JSON.parse(await decryptWithSecret(data.cipher, SECRET))
  inner.text = edit(inner.text)
  inner.time = Date.now()
  await ref.update({ time: inner.time, cipher: await encryptWithSecret(JSON.stringify(inner), SECRET) })
}

const read = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.read('') ?? null, name)
const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)
const command = (page: Page, text: string) =>
  page.evaluate(text => Promise.resolve(window._create(text, { command: true, return_alerts: true })).then(out => (typeof out == 'string' ? out : null)), text)

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
  await expect.poll(async () => (await lists(page)).main.map(r => r[0]).sort()).toEqual([`#todo ${SNIPPET}`, '#todo write the release note'])
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
    main: [['#todo write the release note', null, null]],
    delegated: [[`? #todo [delegated] ${SNIPPET}`, 'delegate', '?']],
  })

  // (b) the bridge acknowledges: the projection written behind the app settles the overlay
  const STORE = 'e2e-task-store'
  const state = { held: 'agent', reason: 'delegated', epoch: 0, rev: 1, updated: Date.now(), worktree: null, phase: 'idle', acked: { [delegate.wrapper.item.id]: 'consumed' } }
  await writeStore(STORE, `global_store_${taskId}`, { _agent: { state } })
  await expect.poll(async () => await lists(page), { timeout: 30_000 }).toEqual({
    main: [['#todo write the release note', null, null]],
    delegated: [[`<1m #todo [delegated] ${SNIPPET}`, null, '<1m']],
  })
  // the age keeps its absolute-time tooltip and is not a tag (no search on click)
  const age = page.locator('.todoer-widget').nth(1).locator('mark.age')
  expect(await age.getAttribute('title')).toBe(new Date(state.updated).toLocaleString())
  await age.click()
  expect(await page.evaluate(() => (window as any).MindBox.get())).not.toContain('<1m')

  // (c) a hand-back: the bridge's marker and its _log block on the text (the block is the last
  // content, the route tag stays at the bottom), the projection and the one-shot unsnooze
  const LOG = '```_log\nINFO: 17:41 handed back: question\n```'
  await rewriteText(taskId, text => text.replace('[delegated]', '[question]').replace(/\n#_agent\/vault\n$/, `\n\n${LOG}\n#_agent/vault\n`))
  await expect.poll(() => serverText(taskId), { timeout: 30_000 }).toContain(`${ANSWER}\n\n${LOG}\n#_agent/vault\n`)
  // the rendered item ends with the log block (its level-highlighted lines do not defeat the
  // tail cleanup) and no empty paragraph holds the hidden tag under it
  await page.evaluate(name => void (location.hash = name), TASK) // show the item alone
  const content = () => page.evaluate(name => window._item(name, true)?.elem?.querySelector('.content')?.innerHTML ?? null, TASK)
  const tail = async () => (await content())?.slice(-700) ?? null // the assertion shows the tail on failure
  await expect.poll(tail, { timeout: 30_000 }).toMatch(/console-info">INFO: 17:41 handed back: question<\/span>\n?<\/code><\/pre>\s*$/)
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
      [`#todo [question] ${SNIPPET}`, null, null], // the snippet drops the _log block
      ['#todo write the release note', null, null],
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
    '#todo write the release note',
    `#todo [question] ${SNIPPET}`,
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
  await expect.poll(async () => (await lists(page)).main.map(r => r[0])[0], { timeout: 30_000 }).toBe('#todo write the release note')
  await writeStore(STORE, `global_store_${taskId}`, {
    _agent: { state: { ...state, held: 'owner', reason: 'question', epoch: 1, rev: 4, updated: Date.now() } },
    _todoer: { unsnoozed: Date.now() },
  })
  await expect.poll(() => dialogs.some(d => /reload to keep your todo order/.test(d)), { timeout: 30_000 }).toBe(true) // at least one notice; the exact count is a backfill
  await page.waitForTimeout(2500)
  expect((await serverStore(PIN))._todoer['#todo'], 'the newer build\'s order stands').toBe(newer)
  // back to this build's stamp and the order the later phases expect (the task first)
  await writeStore(pinDoc, PIN, { ...(await serverStore(PIN)), _todoer: { ...(await serverStore(PIN))._todoer, '#todo': `${taskId},${otherId}`, version: 1 } })
  await expect.poll(async () => (await lists(page)).main.map(r => r[0])[0], { timeout: 30_000 }).toBe(`#todo [question] ${SNIPPET}`)

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
  let grabbed: Clock | null = null
  for (let attempt = 0; attempt < 5 && !grabbed; attempt++) {
    await probe()
    const box = await rowBox(SNIPPET)
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
  expect(grabbed, 'the row was chosen by the sideways move, under the delay').not.toBeNull()
  {
    // dragged on below the second row (Sortable's fallback drag follows the touch), released
    const first = await rowBox(SNIPPET)
    const second = await rowBox('write the release note')
    const from = first.y + first.height / 2
    const to = second.y + second.height
    for (let step = 1; step <= 6; step++) {
      await touch('touchMove', [{ x: first.x + 52, y: from + ((to - from) * step) / 6 }])
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(300) // the swap's animation
    await touch('touchEnd', [])
  }
  await expect.poll(async () => (await lists(page)).main.map(r => r[0]), { timeout: 30_000 }).toEqual(['#todo write the release note', `#todo [question] ${SNIPPET}`])
  await expect.poll(async () => (await serverStore(PIN))._todoer['#todo'], { timeout: 30_000 }).toBe(`${otherId},${taskId}`)
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
  await expect.poll(async () => (await lists(page)).main.map(r => r[0])[0], { timeout: 30_000 }).toBe(`#todo [question] ${SNIPPET}`)

  // (d) a re-delegation under the current epoch, then a take-back that overlays at once and
  // refuses a further delegate until acknowledged
  expect(await command(page, `/delegate ${TASK}`)).toBeNull()
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
  expect(await command(page, `/takeback ${TASK}`)).toBeNull()
  await expect.poll(async () => (await commands()).length, { timeout: 30_000 }).toBe(3)
  const takeback = (await commands())[2]
  expect(takeback.wrapper.item).toEqual({ task: taskId, id: takeback.wrapper.item.id, kind: 'takeback', epoch: 1, at: takeback.wrapper.item.at })
  await expect.poll(async () => await lists(page), { timeout: 30_000 }).toEqual({
    main: [
      [`#todo [delegated] ${SNIPPET}`, 'takeback', null],
      ['#todo write the release note', null, null],
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
})
