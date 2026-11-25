import { createHash } from 'crypto'
import { expect, test } from '@playwright/test'
import { resolve } from 'path'
import {
  FAKE_GITHUB_TOKEN,
  customToken,
  firestore,
  historyRecords as readHistoryRecords,
  install,
  interceptMindItems,
  itemRecord as readItemRecord,
  loadAdmin,
  loadAnonymous,
  laneProjectId,
  readItemState,
  secretFor,
  signIn,
  waitForApp,
  waitWritesSettled,
  type TestUser,
} from './helpers.js'
import { savedId } from './editor_helpers.js'

// write-path tests: signed in as the admin uid with ?user=anonymous, the app acts on the seeded
// anonymous account with write access (as on mindbox.io); these run after the baseline project
// (see playwright.config.ts) since they add items to the account
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

// mind.items to install via /_install <path> (dependencies are resolved recursively): the items
// defining _test_* functions (see `grep -l _test_` in mind.items) plus #tester, which runs them
// note the agent framework (#agent, welcome hook + check_agents task) is NOT listed: it must
// arrive as a dependency of the providers (via agent/chat's #_///agent), since providers cannot
// function without it -- the framework is what runs them on chat item changes. the /vault test row
// asserts this, keeping the dependency edge continuously verified for fresh-account installs
const INSTALL = ['tester', 'util/core', 'util/math', 'util/stat', 'util/sample', 'util/sim', 'util/plot', 'logger', 'agent/chat/claude', 'agent/chat/gpt', 'agent/chat/gemini', 'agent/chat/together', 'agent/chat/groq', 'agent/chat/ollama', 'agent/chat/openrouter', 'agent/chat/llama']

type TestResult = { ok: boolean; ms?: number; log?: string }

test('admin signs in and acts on the anonymous account with write access', async ({ page }) => {
  await loadAdmin(page)
  expect(await page.evaluate(() => window._user.uid)).toBe('anonymous')
  // admin sees all 121 seeded items, including the welcome template dropped from read-only views.
  // counted as items WITHOUT attr.source (which /_install sets and no seeded item has), so the
  // exact assertion holds in either admin file order -- admin_live.spec.ts may legitimately
  // self-install providers before this file when live validation is enabled
  expect(await page.evaluate(() => window._items().filter(item => !item.attr?.source).length)).toBe(121)
  // /_gc explicitly refuses the synthetic-anonymous principal (review 130 §2.2): this app's
  // anonymous mode is the component-level `anonymous` flag, not user.isAnonymous -- the command
  // must refuse before any scan even though readonly is false here (asserted, so the anonymous
  // flag is uniquely causal)
  expect(await page.evaluate(() => window._readonly), 'admin mode is not read-only').toBe(false)
  expect(
    await page.evaluate(async () => await (window._create('/_gc', { command: true, return_alerts: true }) as any)),
    '/_gc anonymous refusal'
  ).toContain('signed-in owner')
})

test('installs mind.items with tests', async ({ page }) => {
  await loadAdmin(page) // fails fast without the local checkout -- the only supported source
  test.info().annotations.push({ type: 'mind.items source', description: 'local checkout' })
  const exists = (name: string) => page.evaluate(name => window._exists(name), name)
  for (const path of INSTALL) {
    if (await exists(`#${path}`)) continue // already installed as a dependency of an earlier item
    expect(await install(page, path), `/_install ${path}`).toBeNull()
  }
  // items exist client-side before their firestore saves complete, and the app guards navigation
  // with a beforeunload prompt that headless tests bypass, so wait for every item to be saved
  // before other tests load the account
  await expect
    .poll(() => page.evaluate(() => window.__items.filter(item => !item.savedId).length), { timeout: 120_000 })
    .toBe(0)
})

test('/test passes for all installed items', async ({ page }) => {
  // collect rendering/eval errors of installed items from the first render on: "macro error in
  // item X" (macro eval failures) and "[#x] Error:" (item errors, e.g. agent framework fatals)
  const macroErrors = new Set<string>()
  page.on('console', m => {
    const match = m.text().match(/^macro error in item ([^:]+):/) ?? m.text().match(/^\[(#[^\]]+)\] Error:/)
    if (match) macroErrors.add(match[1])
  })
  await loadAdmin(page) // interception on every load is loadAdmin's invariant (see helpers.ts)
  // every installed root must have survived the reload (see the save wait in the install test);
  // a lost item would otherwise only show as a smaller test count
  for (const path of INSTALL) expect(await page.evaluate(name => window._exists(name), `#${path}`), path).toBe(true)
  // catalog-driven transitive installs: the #chat catalog lists the llama-server aliases, so
  // they must arrive without being INSTALL roots (as every alias does)
  for (const name of ['#chat/next', '#chat/dsv4'])
    expect(await page.evaluate(name => window._exists(name), name), `${name} via the #chat catalog`).toBe(true)
  // /test confirms completion with a modal, so it is not awaited; results land in each item's global_store
  await page.evaluate(() => void window._create('/test', { command: true, return_alerts: true }))
  const done = page.getByText(/Completed \d+ tests? in \d+ items?\./)
  await expect(done).toBeVisible({ timeout: 240_000 })
  const summary = (await done.textContent())?.trim()
  await page.getByText('OK', { exact: true }).click()
  const results = await page.evaluate(() =>
    window
      ._items()
      .filter(item => item.global_store?._tests)
      .map(item => ({
        name: item.name,
        tests: item.global_store!._tests as Record<string, TestResult>,
      }))
  )
  const failures = results.flatMap(({ name, tests }) =>
    Object.entries(tests)
      .filter(([, result]) => !result.ok)
      .map(([test, result]) => `${name} ${test}: ${result.log ?? ''}`)
  )
  // per-item counts, e.g. to compare with /test on another account
  console.log(`${summary} ${results.map(({ name, tests }) => `${name} (${Object.keys(tests).length})`).join(', ')}`)
  expect(results.length, summary).toBeGreaterThan(0)
  expect(failures, `${summary}\n${failures.join('\n')}`).toEqual([])
  // no installed item may macro-error during rendering: console errors are otherwise unasserted
  // noise, which is how a doc item once shipped with unescaped delimiter macros (evaluated even
  // inside inline code spans) without failing any test. requires complete install closures --
  // /_install resolves text tags plus label-prefix autodep parents (src/install_deps.ts). the
  // synthetic autodep.test row below exercises that edge; THIS lane still follows the corpus's
  // explicit workaround tags (e.g. #_///template) and flips to the autodep path only when those
  // tags are removed after the fixed app deploys
  const errors = [...macroErrors].sort()
  expect(errors, `macro errors: ${errors.join(', ')}`).toEqual([])
})

test('/vault creates a tagged request item without breaking the agent framework', async ({ page }) => {
  // the vault "provider" (#agent/vault) is an agent item like every #agent/* item, but it has
  // NO js_input block (nothing runs web-side), so the framework does not start it on change
  // events (a request item created as its dependent): a block-less agent item is passive (the
  // owner's rule, 2026-09-27; before it, an inert block existed only because start_agent fatals
  // without one, and a doc-only item shipped exactly that bug, caught only in a live account).
  // this covers the /vault command, the explicit #_agent/vault tag on request items (the vault
  // bridge parses item text only), the passive policy, and the agent-framework contract (the
  // tombstones at the old names are inspected statically)
  const errors: string[] = []
  const starts: string[] = [] // the framework's own debug lines about #agent/vault
  page.on('console', m => {
    const match = m.text().match(/^\[(#[^\]]+)\] Error: (.*)$/s)
    if (match) errors.push(`${match[1]}: ${match[2].slice(0, 160)}`)
    if (/starting agent #agent\/vault/.test(m.text())) starts.push(m.text().slice(0, 160))
  })
  await loadAdmin(page)
  // the framework must have arrived via dependency resolution (providers -> agent/chat -> agent):
  // it is deliberately not in INSTALL, so this continuously verifies the install-time dependency
  // edge that fresh accounts rely on (without it, installed providers never reply at all)
  expect(await page.evaluate(() => window._exists('#agent')), '#agent installed as dependency').toBe(true)
  await page.evaluate(() => void window._create('/vault hello bridge', { command: true }))
  const text = () => page.evaluate(() => window._item('#chat/vault/0', true)?.text ?? '')
  await expect.poll(text, { message: 'request item #chat/vault/0' }).toContain('<<user>> hello bridge')
  expect(await text()).toContain('#_agent/vault') // explicit tag for the text-parsing vault bridge
  // let the agent framework react to the change: #agent/vault has no js_input block, so the
  // framework does NOT start it for the request item (the owner, 2026-09-27: the auto-start
  // marked the inert provider running, which lifted it under every new vault chat); it says so
  // once, and the provider stays idle and out of the active agents map
  await expect
    .poll(() => starts.some(line => /not starting agent #agent\/vault for modified dependent #chat\/vault\/0 \(no js_input block\)/.test(line)), { timeout: 10_000, message: 'the suppression line' })
    .toBe(true)
  expect(errors, errors.join('\n')).toEqual([])
  expect(starts.filter(line => !/not starting/.test(line)), 'never started').toEqual([])
  expect(
    await page.evaluate(() => ({
      running: !!(window._item('#agent/vault', true) as any)?.running,
      active: Object.keys((window._item('#agent', true) as any)?._global_store?.agents ?? {}),
    }))
  ).toEqual({ running: false, active: [] })
})

test('a role header asks before it truncates the chat below it', async ({ page }) => {
  // the #chat item's delimiter macro renders a role header whose click removes every message
  // below it and reruns the chat from the kept last user message: a destructive rewrite the
  // owner confirms first (2026-09-27); the chat's DESCENDANT chats (a continuation builds on
  // this transcript) are named in the dialog and deleted with it; Cancel leaves everything, OK
  // truncates and deletes, and a header with nothing below it only says so
  await loadAdmin(page)
  // the replies carry a name, as the bridge's do (a bare `<<agent>>` is the value, not the macro);
  // visible text on the name line keeps the first user header shown so the click below can reach it
  const text = "#chat/vault/1 topic #_agent/vault\n<<user>> first\n<<agent('e2e')>>\nreply\n<<user>> second\n<<agent('e2e')>>\nlater\n"
  await page.evaluate(text => void window._create(text), text)
  const item = () => page.evaluate(() => window._item('#chat/vault/1', true)?.text ?? '')
  await expect.poll(item, { message: 'the chat item' }).toContain('<<user>> second')
  // a continuation below it (#chat is autodep: the label prefix is its parent chat)
  await page.evaluate(() => void window._create('#chat/vault/1/0\n<<user>> deeper'))
  await expect.poll(() => page.evaluate(() => window._item('#chat/vault/1/0', true)?.dependencies?.includes(window._item('#chat/vault/1', true)!.id) ?? false), { timeout: 15_000 }).toBe(true)
  await page.evaluate(() => void (location.hash = '#chat/vault/1')) // shown, its headers rendered
  await expect
    .poll(() => page.evaluate(() => window._item('#chat/vault/1', true)?.elem?.querySelectorAll('.message .label').length ?? 0), { timeout: 15_000 })
    .toBe(4)
  const elemId = await page.evaluate(() => window._item('#chat/vault/1', true)!.elem!.id)
  const labels = page.locator(`[id="${elemId}"] .message .label`)
  await expect(labels).toHaveCount(4)
  await labels.nth(1).click() // the first agent header: itself and everything below go
  const modal = page.locator('.modal')
  const asked = 'Remove 3 messages below this user message, and the chat below it inheriting them (#chat/vault/1/0 with 1 message)? 4 messages in total. The chat continues from there.'
  await expect(modal).toContainText(asked)
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden() // closed (the component stays mounted)
  expect(await item(), 'Cancel: the text stays').toBe(text)
  expect(await page.evaluate(() => window._exists('#chat/vault/1/0')), 'Cancel: the continuation stays').toBe(true)
  await labels.nth(1).click()
  await expect(modal).toContainText(asked)
  await modal.locator('.button.confirm').click()
  await expect.poll(item, { message: 'OK: the messages below are gone' }).toBe('#chat/vault/1 topic #_agent/vault\n<<user>> first')
  await expect.poll(() => page.evaluate(() => window._exists('#chat/vault/1/0')), { message: 'OK: the continuation is deleted' }).toBe(false)
  await expect(labels).toHaveCount(1)
  await labels.first().click() // a user header with nothing below it
  await expect(modal).toContainText('nothing to remove below this message')
  await page.locator('.background.visible').click({ position: { x: 4, y: 4 } }) // an alert has no buttons: its background closes it
  await expect(modal).toBeHidden()
  expect(await item()).toBe('#chat/vault/1 topic #_agent/vault\n<<user>> first')
})

test('#chat own page is whole, hides the first user row only when bare, and scopes the trial look to inert chats', async ({
  page,
}) => {
  // covers the #chat item's own rendering (would have caught the 2026-11-23 unescaped macro
  // opener in embedded code/comments), the hidden first user row (bare name + hidden tags vs
  // visible text on the name line or a line of its own), and the inert-chat trial styling
  const chatConsoleErrors: string[] = []
  page.on('console', m => {
    if (m.type() !== 'error') return
    const text = m.text()
    if (/^(?:(?:code_)?macro error in item #chat:|\[#chat\])/.test(text)) chatConsoleErrors.push(text.slice(0, 200))
  })

  await loadAdmin(page)
  // standalone support: install #chat (and transitive deps incl. #agent/vault) when run alone
  if (!(await page.evaluate(() => window._exists('#chat')))) {
    expect(await install(page, 'chat'), '/_install chat').toBeNull()
    await expect
      .poll(() => page.evaluate(() => window.__items.filter(item => !item.savedId || item.saving).length), {
        timeout: 120_000,
        message: '#chat install saves settled',
      })
      .toBe(0)
  }

  // 1. #chat's own page is whole: no macro/console error, code blocks closed, no code spilled
  await page.evaluate(() => void (location.hash = '#chat'))
  await expect
    .poll(
      () => page.evaluate(() => !!window._item('#chat', true)?.elem?.querySelector('.content .core_js_table.ready')),
      { timeout: 15_000, message: '#chat own page rendered its js_table' }
    )
    .toBe(true)

  const chatPage = await page.evaluate(() => {
    const item = window._item('#chat', true)!
    const raw = (window as any).__items.find((i: any) => i.id == item.id)
    const elem = item.elem!
    const content = elem.querySelector('.content')!
    const children = [...content.children]
    const spilled = children
      .filter((el, idx) => {
        if (idx === 0 && el.tagName === 'P') return false // help paragraph
        if (el.classList.contains('core_js_table')) return false
        if (el.matches('mark.hidden')) return false
        return true
      })
      .map(el => `${el.tagName}:${el.className}:${(el.textContent ?? '').trim().slice(0, 80)}`)
    const helpText = children[0]?.textContent ?? ''
    return {
      hasErrorClass: !!(elem.matches('.error') || elem.querySelector(':scope > .container.error')),
      macroErrorCount: content.querySelectorAll('.macro-error').length,
      expandedError: raw?.expanded?.error ? String(raw.expanded.error) : null,
      hasExpandedText: typeof raw?.expanded?.text === 'string' && raw.expanded.text.length > 0,
      preCount: content.querySelectorAll('pre').length,
      messageCount: content.querySelectorAll('.message').length,
      hasFence: (content.textContent ?? '').includes('```'),
      helpLooksClean: helpText.includes('chat defines utilities') && !/const _delimiter|\.dep_chat|```/.test(helpText),
      spilled,
    }
  })

  expect(chatConsoleErrors, '#chat own page: no console error naming #chat').toEqual([])
  expect(chatPage.hasErrorClass, '#chat own page: item container has no error class').toBe(false)
  expect(chatPage.macroErrorCount, '#chat own page: no .macro-error elements').toBe(0)
  expect(chatPage.expandedError, '#chat own page: macro expansion recorded no error').toBeNull()
  expect(chatPage.hasExpandedText, '#chat own page: macro expansion succeeded').toBe(true)
  expect(chatPage.preCount, '#chat own page: code blocks closed (no spilled <pre> blocks)').toBe(0)
  expect(chatPage.messageCount, '#chat own page: no spilled .message blocks').toBe(0)
  expect(chatPage.hasFence, '#chat own page: no unclosed code fences in rendered text').toBe(false)
  expect(chatPage.helpLooksClean, '#chat own page: help text contains no spilled code').toBe(true)
  expect(chatPage.spilled, '#chat own page: no code spilled as text outside help and js_table').toEqual([])

  expect(await page.evaluate(() => window._exists('#agent/vault')), '#agent/vault exists for hidden tag').toBe(true)

  const createAndShow = async (label: string, text: string, expectedMessages: number) => {
    await page.evaluate(t => void window._create(t), text)
    await expect
      .poll(
        () =>
          page.evaluate(
            name => window._item(name, true)?.dependencies?.includes(window._item('#chat', true)!.id) ?? false,
            label
          ),
        { timeout: 15_000, message: `${label} depends on #chat` }
      )
      .toBe(true)
    await page.evaluate(name => void (location.hash = name), label)
    await expect
      .poll(
        () => page.evaluate(name => window._item(name, true)?.elem?.querySelectorAll('.content > .message').length ?? 0, label),
        { timeout: 15_000, message: `${label} rendered ${expectedMessages} message rows` }
      )
      .toBe(expectedMessages)
  }

  const inspectFirstUserRow = (label: string) =>
    page.evaluate(name => {
      const content = window._item(name, true)!.elem!.querySelector('.content')!
      const nameMark = content.querySelector('p:first-child mark:not(.hidden)') as HTMLElement
      const userRow = content.querySelector(':scope > div.message.user') as HTMLElement
      const msgP = userRow.nextElementSibling as HTMLElement
      const range = document.createRange()
      range.selectNodeContents(msgP)
      const msgLine = range.getClientRects()[0] ?? msgP.getBoundingClientRect()
      const nameRect = nameMark.getBoundingClientRect()
      const rowRect = userRow.getBoundingClientRect()
      return {
        hasClass: userRow.classList.contains('hideFirstUserRow'),
        display: getComputedStyle(userRow).display,
        rowWidth: rowRect.width,
        rowHeight: rowRect.height,
        rowRects: userRow.getClientRects().length,
        nameTop: nameRect.top,
        nameRight: nameRect.right,
        msgTop: msgLine.top,
        msgLeft: msgLine.left,
        rowBottom: rowRect.bottom,
      }
    }, label)

  // 2. First user row is hidden when name + hidden tag precedes the user row
  const hiddenLabel = '#chat/e2e_fur_hidden'
  await createAndShow(hiddenLabel, `${hiddenLabel} #_agent/vault\n<<user>> first message beside name\n`, 1)
  const hidden = await inspectFirstUserRow(hiddenLabel)
  expect(hidden.hasClass, 'first user row hidden (name + hidden tag): row has hideFirstUserRow class').toBe(true)
  expect(hidden.display, 'first user row hidden: display is none').toBe('none')
  expect(
    { width: hidden.rowWidth, height: hidden.rowHeight, rects: hidden.rowRects },
    'first user row hidden: row takes no room'
  ).toEqual({ width: 0, height: 0, rects: 0 })
  expect(
    Math.abs(hidden.msgTop - hidden.nameTop),
    'first user row hidden: message first line starts on the name tag line'
  ).toBeLessThan(6)
  expect(
    hidden.msgLeft,
    'first user row hidden: message first line starts beside the name tag'
  ).toBeGreaterThan(hidden.nameRight)

  // 3. First user row stays when visible text stands between name and user row
  const sameLineLabel = '#chat/e2e_fur_same_line'
  await createAndShow(sameLineLabel, `${sameLineLabel} note on name line\n<<user>> stays below header\n`, 1)
  const sameLine = await inspectFirstUserRow(sameLineLabel)
  expect(sameLine.hasClass, 'first user row stays (text on name line): no hideFirstUserRow class').toBe(false)
  expect(sameLine.display, 'first user row stays (text on name line): row is displayed').not.toBe('none')
  expect(sameLine.rowHeight, 'first user row stays (text on name line): row takes vertical room').toBeGreaterThan(0)
  expect(sameLine.msgTop, 'first user row stays (text on name line): message starts below user row').toBeGreaterThanOrEqual(
    sameLine.rowBottom - 1
  )

  const betweenLineLabel = '#chat/e2e_fur_between_line'
  await createAndShow(betweenLineLabel, `${betweenLineLabel}\nintro line\n<<user>> stays below header\n`, 1)
  const betweenLine = await inspectFirstUserRow(betweenLineLabel)
  expect(betweenLine.hasClass, 'first user row stays (line between): no hideFirstUserRow class').toBe(false)
  expect(betweenLine.display, 'first user row stays (line between): row is displayed').not.toBe('none')
  expect(betweenLine.rowHeight, 'first user row stays (line between): row takes vertical room').toBeGreaterThan(0)
  expect(betweenLine.msgTop, 'first user row stays (line between): message starts below user row').toBeGreaterThanOrEqual(
    betweenLine.rowBottom - 1
  )

  // a hidden tag on a line of its own after a line of four spaces is no tag to the app (it reads
  // that line as indented code): the text is drawn as it stands, in a paragraph of its own, so the
  // regular user row stays (reviews 0 and 1 of the thread first_user_row: the row was hidden, and
  // that paragraph with it). Hidden tags count on the name's line alone
  const spacedLabel = '#chat/e2e_fur_spaced'
  await createAndShow(spacedLabel, `${spacedLabel}\n    \n#_chat\n\n<<user>> stays below header\n`, 1)
  const spaced = await inspectFirstUserRow(spacedLabel)
  expect(spaced.hasClass, 'first user row stays (a tag after a line of spaces): no hideFirstUserRow class').toBe(false)
  expect(spaced.display, 'first user row stays (a tag after a line of spaces): row is displayed').not.toBe('none')
  expect(spaced.rowHeight, 'first user row stays (a tag after a line of spaces): row takes vertical room').toBeGreaterThan(0)
  const spacedText = await page.evaluate(name => {
    const content = window._item(name, true)!.elem!.querySelector('.content')!
    const p = [...content.querySelectorAll(':scope > p:not(:first-child)')].find(el => el.textContent!.includes('#_chat'))
    if (!p) return null
    return { text: p.textContent!.trim(), display: getComputedStyle(p).display, height: p.getBoundingClientRect().height }
  }, spacedLabel)
  expect(spacedText?.text, 'first user row stays (a tag after a line of spaces): the tag is drawn as text').toBe('#_chat')
  expect(spacedText?.display, 'first user row stays (a tag after a line of spaces): its paragraph is displayed').not.toBe('none')
  expect(spacedText?.height, 'first user row stays (a tag after a line of spaces): its paragraph takes vertical room').toBeGreaterThan(0)

  // 4. Trial look applies only in a chat holding an agent's inert section (.vault-result)
  const inspectTrialLook = (label: string) =>
    page.evaluate(name => {
      const content = window._item(name, true)!.elem!.querySelector('.content')!
      const userRows = [...content.querySelectorAll(':scope > div.message.user')] as HTMLElement[]
      const agentRows = [...content.querySelectorAll(':scope > div.message.agent')] as HTMLElement[]
      const visibleUser = userRows[1]
      const earlierAgent = agentRows[0]
      const lastAgent = agentRows[agentRows.length - 1]
      const parseRgb = (css: string) => (css.match(/\d+/g) ?? []).slice(0, 3).map(Number)
      const hrs = [earlierAgent, visibleUser, lastAgent].flatMap(row =>
        [...row.querySelectorAll('hr')].map(hr => ({
          cls: hr.className,
          visibility: getComputedStyle(hr).visibility,
          display: getComputedStyle(hr).display,
          width: hr.getBoundingClientRect().width,
        }))
      )
      const userLeftHr = visibleUser.querySelector('hr.left') as HTMLElement
      const userRightHr = visibleUser.querySelector('hr.right') as HTMLElement
      const userLabel = visibleUser.querySelector('.label') as HTMLElement
      const userRowRect = visibleUser.getBoundingClientRect()
      const userLabelRect = userLabel.getBoundingClientRect()
      const earlierAgentColor = getComputedStyle(earlierAgent.querySelector('.label')!).color
      const lastAgentColor = getComputedStyle(lastAgent.querySelector('.label')!).color
      const textFontSize = parseFloat(getComputedStyle(content).fontSize)
      const roleRows = [earlierAgent, visibleUser, lastAgent].map(row => ({
        labelFontSize: parseFloat(getComputedStyle(row.querySelector('.label')!).fontSize),
        rowFontSize: parseFloat(getComputedStyle(row).fontSize),
        marginTop: getComputedStyle(row).marginTop,
      }))
      return {
        hasVaultResult: !!content.querySelector('.vault-result'),
        hrs,
        earlierAgentColor,
        earlierAgentRgb: parseRgb(earlierAgentColor),
        lastAgentColor,
        lastAgentRgb: parseRgb(lastAgentColor),
        userLeftHrDisplay: getComputedStyle(userLeftHr).display,
        userLeftHrWidth: userLeftHr.getBoundingClientRect().width,
        userRightHrWidth: userRightHr.getBoundingClientRect().width,
        userLabelMarginLeft: getComputedStyle(userLabel).marginLeft,
        userLabelLeftOffset: userLabelRect.left - userRowRect.left,
        userLabelRightOffset: userRowRect.right - userLabelRect.right,
        textFontSize,
        roleRows,
      }
    }, label)

  const plainLabel = '#chat/e2e_fur_plain'
  await createAndShow(
    plainLabel,
    `${plainLabel}\n<<user>> first q\n<<agent('e2e')>>\nfirst reply\n<<user>> second q\n<<agent('e2e')>>\nsecond reply\n`,
    4
  )
  const plain = await inspectTrialLook(plainLabel)
  expect(plain.hasVaultResult, 'released look (no inert section): chat has no .vault-result').toBe(false)
  expect(
    plain.hrs.every(h => h.visibility === 'visible' && h.display !== 'none' && h.width > 0),
    'released look (no inert section): lines beside role names are visible'
  ).toBe(true)
  const [er, eg, eb] = plain.earlierAgentRgb
  const [lr, lg, lb] = plain.lastAgentRgb
  expect(er === eg && eg === eb, 'released look (no inert section): earlier agent row name is neutral').toBe(true)
  expect(lb > lr && lb > lg, 'released look (no inert section): last agent row name is blue').toBe(true)
  expect(plain.lastAgentColor, 'released look (no inert section): last agent row differs from earlier agent row').not.toBe(
    plain.earlierAgentColor
  )
  expect(plain.userLeftHrDisplay, 'released look (no inert section): user row left line is displayed').not.toBe('none')
  expect(plain.userLeftHrWidth, 'released look (no inert section): user row left line is wider than right line').toBeGreaterThan(
    plain.userRightHrWidth
  )
  expect(plain.userLabelLeftOffset, 'released look (no inert section): user row name sits toward the right').toBeGreaterThan(
    plain.userLabelRightOffset
  )
  expect(
    plain.roleRows.every(
      r => Math.abs(r.labelFontSize - r.rowFontSize) < 0.05 && Math.abs(r.labelFontSize - plain.textFontSize) < 0.05
    ),
    'released look (no inert section): role row names stay at text font size'
  ).toBe(true)
  expect(
    plain.roleRows.every(r => r.marginTop === '0px'),
    'released look (no inert section): role rows have no top margin'
  ).toBe(true)

  const inertLabel = '#chat/e2e_fur_inert'
  await createAndShow(
    inertLabel,
    `${inertLabel}\n<<user>> first q\n<<agent('vault/default')>>\n<!--inert-->\nfirst reply\n<!--/inert-->\n<<user>> second q\n<<agent('vault/default')>>\n<!--inert-->\nsecond reply\n<!--/inert-->\n`,
    4
  )
  await expect
    .poll(
      () => page.evaluate(name => window._item(name, true)?.elem?.querySelectorAll('.content .vault-result').length ?? 0, inertLabel),
      { timeout: 15_000, message: `${inertLabel} populated inert sections` }
    )
    .toBe(2)
  const inert = await inspectTrialLook(inertLabel)
  expect(inert.hasVaultResult, 'trial look (with inert section): chat holds .vault-result').toBe(true)
  expect(
    inert.hrs.every(h => h.visibility === 'hidden'),
    'trial look (with inert section): lines beside role names are not visible'
  ).toBe(true)
  const [ilr, ilg, ilb] = inert.lastAgentRgb
  expect(ilb <= ilr && ilb <= ilg, 'trial look (with inert section): last agent row name is not blue').toBe(true)
  expect(inert.lastAgentColor, 'trial look (with inert section): last agent row name matches non-last agent row color').toBe(
    plain.earlierAgentColor
  )
  expect(inert.lastAgentColor, 'trial look (with inert section): last agent row name differs from released blue').not.toBe(
    plain.lastAgentColor
  )
  expect(inert.userLeftHrDisplay, 'trial look (with inert section): user row left line is display none').toBe('none')
  expect(inert.userLabelMarginLeft, 'trial look (with inert section): user row name has zero left margin').toBe('0px')
  expect(inert.userLabelLeftOffset, 'trial look (with inert section): user row name stands at the left').toBeLessThanOrEqual(2)
  expect(inert.userLabelLeftOffset, 'trial look (with inert section): user row name is left of released position').toBeLessThan(
    plain.userLabelLeftOffset / 2
  )
  expect(
    inert.roleRows.every(
      r =>
        Math.abs(r.labelFontSize - r.rowFontSize * 0.8) < 0.05 &&
        Math.abs(r.labelFontSize - inert.textFontSize * 0.8) < 0.05
    ),
    'trial look (with inert section): role row names are 80% of text font size'
  ).toBe(true)
  expect(
    inert.roleRows.every(r => r.marginTop === '5px'),
    'trial look (with inert section): role rows have 5 px top margin'
  ).toBe(true)

  // 5. Chat inert-block top margin (the owner, 2026-11-24): 2px closed AND 2px open (not 10px
  // as in non-chat items, and not 5px when open), keeping the same distance from the agent role
  // row in both states
  const chatInertGeometry = (label: string) =>
    page.evaluate(name => {
      const item = window._item(name, true)
      const container = item && (document.querySelector(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${item.id}"]`) as HTMLElement | null)
      if (!container) return null
      const content = container.querySelector('.content') as HTMLElement
      const lh = parseFloat(getComputedStyle(content).lineHeight)
      const agentRows = [...content.querySelectorAll(':scope > div.message.agent')] as HTMLElement[]
      const blocks = [...content.querySelectorAll('.inert-block')] as HTMLElement[]
      return {
        selected: container.classList.contains('target'),
        blocks: blocks.map((block, i) => {
          const s = getComputedStyle(block)
          const open = [...block.querySelectorAll(':scope > .vault-result')].every(f => f.getClientRects().length > 0)
          const row = agentRows[i]
          return {
            open,
            margins: [s.marginTop, s.marginRight, s.marginBottom, s.marginLeft],
            gap: row ? Math.round((block.getBoundingClientRect().top - row.getBoundingClientRect().bottom) * 100) / 100 : null,
            lines: Math.round(((block.offsetHeight + parseFloat(s.marginTop) + parseFloat(s.marginBottom)) / lh) * 100) / 100,
          }
        }),
      }
    }, label)

  // unselected (closed): a leading non-matching term deselects the item without matching inside
  // either reply, so both chat inert blocks close naturally
  await page.evaluate(name => void (window as any).MindBox.set(`nothingsuch ${name}`), inertLabel)
  await expect
    .poll(() => chatInertGeometry(inertLabel).then(g => (g ? [g.selected, ...g.blocks.map(b => b.open)] : null)), {
      timeout: 15_000,
      message: 'chat item unselected with both inert blocks closed',
    })
    .toEqual([false, false, false])
  const chatClosed = (await chatInertGeometry(inertLabel))!
  expect(
    chatClosed.blocks.map(b => b.margins),
    'chat closed inert blocks keep 2px top margin (not the 10px non-chat margin)'
  ).toEqual([
    ['2px', '0px', '2px', '0px'],
    ['2px', '0px', '2px', '0px'],
  ])
  expect(chatClosed.blocks.map(b => b.lines), 'chat closed inert blocks stay exactly one line tall').toEqual([1, 1])

  // manually opened (.opened while unselected): top margin stays 2px and distance from agent row is unchanged
  const inertId = await page.evaluate(name => window._item(name, true)!.id, inertLabel)
  await page
    .locator(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${inertId}"] .inert-block > .inert-line`)
    .first()
    .click({ position: { x: 5, y: 8 } })
  await expect
    .poll(() => chatInertGeometry(inertLabel).then(g => g?.blocks.map(b => b.open) ?? null), {
      timeout: 15_000,
      message: 'first chat inert block opened by click',
    })
    .toEqual([true, false])
  const chatManualOpen = (await chatInertGeometry(inertLabel))!
  expect(
    chatManualOpen.blocks[0].margins,
    'chat manually opened inert block keeps 2px top margin (not 5px)'
  ).toEqual(['2px', '-10px', '5px', '-10px'])
  expect(
    chatManualOpen.blocks[0].gap,
    'chat manually opened inert block keeps the exact closed distance under the agent role row'
  ).toBe(chatClosed.blocks[0].gap)

  // selected (.container.target): both open blocks keep 2px top margin and the exact closed distance under each agent role row
  await page.evaluate(name => void (window as any).MindBox.set(name), inertLabel)
  await expect
    .poll(() => chatInertGeometry(inertLabel).then(g => (g ? [g.selected, ...g.blocks.map(b => b.open)] : null)), {
      timeout: 15_000,
      message: 'chat item selected with both inert blocks open',
    })
    .toEqual([true, true, true])
  const chatTargetOpen = (await chatInertGeometry(inertLabel))!
  expect(
    chatTargetOpen.blocks.map(b => b.margins),
    'chat selected open inert blocks keep 2px top margin (not 5px)'
  ).toEqual([
    ['2px', '-10px', '5px', '-10px'],
    ['2px', '-10px', '5px', '-10px'],
  ])
  expect(
    chatTargetOpen.blocks.map(b => b.gap),
    'chat selected open inert blocks keep the exact closed distance under each agent role row'
  ).toEqual(chatClosed.blocks.map(b => b.gap))

  // leave no writes in flight for the next row in this serial lane
  for (const label of [hiddenLabel, sameLineLabel, betweenLineLabel, spacedLabel, plainLabel, inertLabel]) {
    await waitWritesSettled(page, label)
  }
})

test('an autodep parent absent from every text tag is installed and joins the runtime graph', async ({ page }) => {
  await loadAdmin(page)
  // synthetic four-level hierarchy on a dedicated repo route (review 118 §4): the root depends
  // on #e2e_autodep in TEXT only, e2e_autodep.md's #_autodep makes the hierarchy autodep,
  // e2e_autodep/b.md is a genuine 404 (exercising the known-source probe), and the immediate
  // parent e2e_autodep/b/c.md is reachable ONLY via the label-prefix autodep edge resolved AFTER
  // text dependencies settle -- the corpus itself cannot provide this fixture while its explicit
  // workaround tags close the same edge
  let sha = 'e2e-autodep' // mutable: the updater-cycle stage below advances the synthetic repo
  const files: Record<string, string> = {
    'e2e_autodep.md': '#e2e_autodep #_autodep defines the root of a synthetic autodep hierarchy.\n',
    'e2e_autodep/b/c.md': '#e2e_autodep/b/c is a middle level with no dependencies of its own.\n',
    'e2e_autodep/b/c/d.md': '#e2e_autodep/b/c/d depends on #e2e_autodep explicitly and nothing else.\n',
  }
  // successful installs start watchLocalRepo(repo) without awaiting, which on localhost calls
  // fetchPreview for each installed source item via /file/<repo>/<path> BEFORE the (already
  // intercepted) /watch/... loop -- serve those from the same map, 404 fail-closed, so the
  // fixture stays hermetic (an unintercepted miss throws via the app fetch wrapper and opens an
  // error modal concurrently with the install modals)
  await page.route('**/file/autodep.test/**', route => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/file\/autodep\.test\//, ''))
    if (!(file in files)) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })
    return route.fulfill({ status: 200, contentType: 'text/plain', body: files[file] })
  })
  await page.route('https://api.github.com/repos/olcan/autodep.test/**', route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/repos/olcan/autodep.test/', '')
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path == 'commits') {
      // the updater resolves an embed-bearing item's ref to a commit with a PATH-LESS query first
      // (updater.js check_updates since the updater key change of 2026-09-23) and reads each path
      // at that commit: the repo's head commit for no path, the path's commit for a served file,
      // nothing for a file the repo lacks (the fixture answered every path-less query with
      // nothing, so the row failed with `no commit at olcan/autodep.test/master` until 2026-09-25)
      const file = url.searchParams.get('path')
      if (file != null && !(file in files)) return json(200, [])
      return json(200, [{ sha, commit: { message: 'synthetic', author: { date: new Date().toISOString() } } }])
    }
    if (path.startsWith('commits/')) {
      // single-commit fetch: update_item validates the target sha, and check_updates'
      // pushable marking reads the commit's files listing. file shas must be REAL git
      // blob shas of the served content -- the pusher/updater compare github_sha(text)
      // against them, and a placeholder could never match, permanently re-marking every
      // updated item pushable (which hid the pushable-clear assertion below)
      const blobSha = (content: string) =>
        createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex')
      return json(200, {
        sha: path.slice('commits/'.length),
        commit: { message: 'synthetic', author: { date: new Date().toISOString() } },
        files: Object.keys(files).map(filename => ({ filename, sha: blobSha(files[filename]) })),
      })
    }
    if (path.startsWith('contents/')) {
      const file = decodeURIComponent(path.slice('contents/'.length))
      if (!(file in files)) return json(404, { message: 'Not Found' })
      return json(200, {
        type: 'file',
        path: file,
        name: file.split('/').pop(),
        sha,
        content: Buffer.from(files[file]).toString('base64'),
        encoding: 'base64',
      })
    }
    // FAIL CLOSED, matching the mind.items interceptor: nothing may reach real github
    return json(404, { message: `unmodeled autodep.test api path in e2e interception: ${path}` })
  })
  expect(await install(page, 'e2e_autodep/b/c/d autodep.test master olcan'), '/_install e2e_autodep/b/c/d').toBeNull()
  const exists = (name: string) => page.evaluate(name => window._exists(name), name)
  expect(await exists('#e2e_autodep'), '#e2e_autodep via text dependency').toBe(true)
  expect(await exists('#e2e_autodep/b/c'), '#e2e_autodep/b/c via the autodep edge').toBe(true)
  expect(await exists('#e2e_autodep/b/c/d'), 'the installed root').toBe(true)
  expect(await exists('#e2e_autodep/b'), '#e2e_autodep/b stays uninstalled (genuine 404)').toBe(false)
  // the root's runtime dependency list must include its immediate parent
  expect(
    await page.evaluate(() => window._item('#e2e_autodep/b/c/d')!.dependencies.includes(window._item('#e2e_autodep/b/c')!.id)),
    'parent in runtime dependencies'
  ).toBe(true)
  // THE REAL UPDATER CYCLE (review 126 §3): prove the new update_item seam branch end to end.
  // Stage the broken state an update must heal -- delete the text-dep root AND the autodep
  // parent -- then advance the synthetic repo one sha with updated child text. The REAL
  // #updater's update_item (installed only for this row, never in the shared INSTALL; its
  // function evaluated from the item) must then: pass 1 -- reinstall the text dependency via
  // /_install and restart; restart pass -- with text deps local, consult window._autodep_parent
  // and install the missing parent through the same flow; land the new sha. Removing the
  // updater's seam branch fails the parent assertions below with everything else green.
  await page.evaluate(() => {
    for (const name of ['#e2e_autodep', '#e2e_autodep/b/c']) window._item(name)!.delete(false)
  })
  files['e2e_autodep/b/c/d.md'] = '#e2e_autodep/b/c/d depends on #e2e_autodep explicitly and nothing else. v2\n'
  sha = 'e2e-autodep-2'
  expect(await install(page, 'updater'), '/_install updater').toBeNull()
  await page.evaluate(() => {
    // init_updater runs only on welcome (page load), which this mid-session install skips --
    // seed the store fields the update/restart path reads
    const store = (window._item('#updater') as any).store
    store.modified_ids ??= []
    store.pending_updates ??= {}
  })
  // root /_install commands (which the updater's dependency flow issues via MindBox.create)
  // finish with REAL modals -- the "Installed <item>" OK confirmation, the updater's own
  // Continue confirmation for missing dependencies, and (once #updater exists as a welcome
  // item) a Reload/Skip recommendation. Production is interactive; the row clicks through
  // exactly as the install() helper does, never clicking Reload. Only a VISIBLE button is clicked
  // (lane_races review 0; the row's failure in two of seven gates, reproduced under load): the
  // modal keeps its last buttons in the DOM while hidden, their labels included, so a click resolved
  // by text to the hidden "Skip" of the reload prompt waited for visibility and landed on the same
  // button once the next modal, the second dependency confirm, showed it as its Cancel
  const visibleClick = async (label: string) => {
    const button = page.getByText(label, { exact: true })
    if (await button.isVisible().catch(() => false)) await button.click({ timeout: 2000 }).catch(() => {})
  }
  let clicking = true
  const clicks = (async () => {
    while (clicking) {
      for (const label of ['Continue', 'OK', 'Skip']) await visibleClick(label)
      await page.waitForTimeout(50)
    }
  })()
  let updated: unknown
  try {
    updated = await page.evaluate(async () => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('update_item timed out in 90s')), 90_000)
      )
      const run = (async () => {
        const update_item = await (window._item('#updater') as any).eval('update_item', {
          async: true,
          async_simple: true,
        })
        return update_item(window._item('#e2e_autodep/b/c/d'), { 'e2e_autodep/b/c/d.md': 'e2e-autodep-2' })
      })()
      return Promise.race([run, timeout])
    })
  } finally {
    clicking = false
    await clicks
  }
  expect(updated, 'update_item completed').toBe(true)
  // the healed closure: the text dependency reinstalled by pass 1, the autodep parent by the
  // updater's seam branch on the restart pass, and the updated text landed
  expect(await exists('#e2e_autodep'), 'text dependency reinstalled by the update').toBe(true)
  expect(await exists('#e2e_autodep/b/c'), 'autodep parent reinstalled by the updater seam branch').toBe(true)
  expect(await page.evaluate(() => window._item('#e2e_autodep/b/c/d')!.text), 'updated text landed').toContain('v2')
  expect(
    await page.evaluate(() =>
      window._item('#e2e_autodep/b/c/d')!.dependencies.includes(window._item('#e2e_autodep/b/c')!.id)
    ),
    'parent back in runtime dependencies'
  ).toBe(true)

  // THE PUSHABLE-CANCEL PHASE (review 143 §3.4): update_item must be able to CANCEL without
  // leaving metadata over old text -- the exact production stuck-item class (sha/token/embeds
  // advanced before the confirm; a later attr save then persisted new metadata with old text).
  // The candidate is EMBED-BEARING so one phase covers main sha AND embed metadata staging.
  files['e2e_autodep/b/c/d.md'] =
    '#e2e_autodep/b/c/d depends on #e2e_autodep explicitly and nothing else. v3\n```js:e.js\nplaceholder\n```\n'
  files['e2e_autodep/b/c/e.js'] = 'served_embed_body_v3()'
  sha = 'e2e-autodep-3'
  const updates3 = { 'e2e_autodep/b/c/d.md': 'e2e-autodep-3', 'e2e_autodep/b/c/e.js': 'e2e-autodep-3' }
  const itemState = () =>
    page.evaluate(() => {
      const item = window._item('#e2e_autodep/b/c/d')! as any
      return {
        text: item.text as string,
        sha: item.attr.sha as string,
        embeds: JSON.stringify(item.attr.embeds ?? null),
        pushable: !!item.pushable,
        // _global_store is the NON-auto-saving accessor (review 144 §5): reading
        // item.global_store itself schedules a save, polluting the observation
        marker: JSON.stringify(item._global_store?._updater ?? null),
      }
    })
  await page.evaluate(() => void ((window._item('#e2e_autodep/b/c/d') as any).pushable = true))
  const before = await itemState()
  expect(before.sha, 'phase precondition: at v2 sha').toBe('e2e-autodep-2')
  const runUpdate = async (clickLabel: string) => {
    let going = true
    const clicker = (async () => {
      while (going) {
        await visibleClick(clickLabel) // a visible button only (see the first loop)
        await page.waitForTimeout(50)
      }
    })()
    try {
      return await page.evaluate(async updates => {
        const update_item = await (window._item('#updater') as any).eval('update_item', {
          async: true,
          async_simple: true,
        })
        return update_item(window._item('#e2e_autodep/b/c/d'), updates)
      }, updates3)
    } finally {
      going = false
      await clicker
    }
  }
  // CANCEL: the marker must still be the PREVIOUS one while the modal is open (review
  // 144 §3/§5 -- publishing it early was durable and visible to other tabs, which
  // consume it as a completed update; restoring after Cancel cannot undo that), and the
  // complete item state must be preserved after the false return
  const pending = page.evaluate(async updates => {
    const update_item = await (window._item('#updater') as any).eval('update_item', {
      async: true,
      async_simple: true,
    })
    return update_item(window._item('#e2e_autodep/b/c/d'), updates)
  }, updates3)
  await expect(page.getByText('Overwrite unpushed changes', { exact: false })).toBeVisible({ timeout: 30_000 })
  expect((await itemState()).marker, 'marker unpublished while the modal is open').toBe(before.marker)
  await page.getByText('Cancel', { exact: true }).click()
  expect(await pending, 'cancelled update returns false').toBe(false)
  const cancelled = await itemState()
  expect(cancelled, 'cancel preserved the targeted state (text/sha/embeds/pushable/marker)').toEqual(before)
  // drive the exact persistence opportunity that stuck the production items, AWAITED
  await page.evaluate(() => (window._item('#e2e_autodep/b/c/d') as any).save())
  expect(await itemState(), 'state intact after an awaited save').toEqual(before)
  // OVERWRITE: the same update completes -- new sha, embed metadata staged then committed
  // together, served embed body inlined, pushable cleared by the post-write path
  expect(await runUpdate('Overwrite'), 'accepted update returns true').toBe(true)
  const accepted = await itemState()
  expect(accepted.sha).toBe('e2e-autodep-3')
  expect(accepted.text).toContain('v3')
  expect(accepted.text).toContain('served_embed_body_v3()')
  expect(JSON.parse(accepted.embeds)).toMatchObject([{ path: 'e2e_autodep/b/c/e.js', sha: 'e2e-autodep-3' }])
  expect(accepted.pushable, 'pushable cleared after a completed update').toBe(false)
  // the success MARKER published once per accepted write (review 145 §4: without
  // this, deleting the success assignment would still pass the phase)
  const marker = JSON.parse(accepted.marker)
  expect(marker.last_update, 'marker equals the accepted updates').toEqual(updates3)
  // the CERTIFICATION beside them (updater.js completion_marker, 2026-09-23) names the commit a
  // COMPLETE check read every path at, keyed to the finding object that check returned; this row
  // drives update_item with its own finding, which no check certified, so the field is an
  // explicit null (kept as such: a marker without the field would inherit a stored certification)
  expect(marker.certified, 'a caller-supplied finding is not certified').toBeNull()
  expect(Object.keys(marker).sort(), 'the marker\'s two fields').toEqual(['certified', 'last_update'])
  // the CAPABILITY FENCE (review 146 §3/§4): the live wrapper reports the boolean
  // acceptance contract, and a capability-absent proxy fails closed without its writer
  // ever being called (the in-function fence precedes token/staging work by source
  // order; this row pins the failed-closed result and writer non-invocation)
  expect(
    await page.evaluate(() => (window._item('#e2e_autodep/b/c/d') as any).write_accepts),
    'live wrapper reports the acceptance capability'
  ).toBe(true)
  expect(
    await page.evaluate(async updates => {
      const update_item = await (window._item('#updater') as any).eval('update_item', {
        async: true,
        async_simple: true,
      })
      const real = window._item('#e2e_autodep/b/c/d') as any
      const stale = Object.create(real, {
        write_accepts: { value: undefined }, // the stale-runtime shape
        write: {
          value: () => {
            throw new Error('stale writer must never be called')
          },
        },
      })
      return update_item(stale, { 'e2e_autodep/b/c/d.md': 'e2e-autodep-4' })
    }),
    'stale wrapper fails closed without calling its writer'
  ).toBe(false)

  // THE MARKER SIDE-CHANNEL REFUSAL (review 151 §2.2): a candidate inside a REAL embed
  // body renders as a source-local marker in the grammar view; embed_text is a side
  // channel later spliced into fetched main text, so the updater must REFUSE the update
  // outright rather than let a literal marker persist. (the pusher applies the same
  // one-line policy to its embed capture; its refusal throws before the AFFECTED
  // side-push write -- an earlier clean destination in the loop may already have pushed)
  await page.evaluate(() => {
    const item = window._item('#e2e_autodep/b/c/d') as any
    item.write(
      item.text.replace(
        'served_embed_body_v3()',
        'served_embed_body_v3()\n<!--inert-->\nnot canonical <!--/inert--> x\n<!--/inert-->'
      ),
      ''
    )
  })
  files['e2e_autodep/b/c/d.md'] =
    '#e2e_autodep/b/c/d depends on #e2e_autodep explicitly and nothing else. v4\n```js:e.js\nplaceholder\n```\n'
  sha = 'e2e-autodep-4'
  const beforeRefusal = await itemState()
  expect(
    await page.evaluate(async () => {
      const update_item = await (window._item('#updater') as any).eval('update_item', {
        async: true,
        async_simple: true,
      })
      return update_item(window._item('#e2e_autodep/b/c/d'), { 'e2e_autodep/b/c/d.md': 'e2e-autodep-4' })
    }),
    'marker-bearing real embed refuses the update'
  ).toBe(false)
  const afterRefusal = await itemState()
  expect(afterRefusal, 'refusal preserved the item exactly').toEqual(beforeRefusal)
  // the check_updates branch refuses the same shape (review 152 §2.2: its early
  // preflight runs before token and mark_pushables undo work)
  expect(
    await page.evaluate(async () => {
      const check_updates = await (window._item('#updater') as any).eval('check_updates', {
        async: true,
        async_simple: true,
      })
      return check_updates(window._item('#e2e_autodep/b/c/d'), true)
    }),
    'check_updates refuses the marker-bearing embed'
  ).toBe(false)
  expect(afterRefusal.text, 'the candidate raw bytes are intact').toContain(
    '<!--inert-->\nnot canonical <!--/inert--> x\n<!--/inert-->'
  )
  expect(afterRefusal.text, 'no literal marker was persisted').not.toContain('\u27e6vault_result_v1:')
  // OLD-APP SHAPE (review 180 §3.2): with the capability absent, the DEFAULT
  // check_updates path (mark_pushables = false) on an embed-bearing item must warn and
  // return false BEFORE any token/network/writer work -- never throw
  expect(
    await page.evaluate(async () => {
      const check_updates = await (window._item('#updater') as any).eval('check_updates', {
        async: true,
        async_simple: true,
      })
      const grammar = (window as any)._grammar
      const fetches: string[] = []
      const realFetch = window.fetch
      try {
        delete (window as any)._grammar
        ;(window as any).fetch = (...args: any[]) => {
          fetches.push(String(args[0]))
          return realFetch.apply(window, args as any)
        }
        const result = await check_updates(window._item('#e2e_autodep/b/c/d'))
        return { result, fetches: fetches.length }
      } catch (e) {
        return { threw: String(e) }
      } finally {
        ;(window as any)._grammar = grammar
        ;(window as any).fetch = realFetch
      }
    }),
    'stale-app default check_updates fails closed without I/O'
  ).toEqual({ result: false, fetches: 0 })

  // wait for saves before deleting below, so no create can land after its delete
  await expect
    .poll(() => page.evaluate(() => window.__items.filter(item => !item.savedId).length), { timeout: 120_000 })
    .toBe(0)
  // durable cleanup (review 120 §3): the /file route above is page-local but saved items are not --
  // every later page's startup would call watchLocalRepo('autodep.test') for them and hit the
  // unmocked local-preview seam. delete the three synthetic items and confirm the deletions are
  // durable in the emulator (local removal is immediate; the remote write can still be pending)
  const ids = await page.evaluate(() =>
    window.__items
      .filter(item => item.labelText?.startsWith('#e2e_autodep') || item.labelText == '#updater')
      .map(item => item.savedId!)
  )
  expect(ids, 'three synthetic items plus #updater').toHaveLength(4)
  await page.evaluate(() => {
    for (const name of ['#e2e_autodep/b/c/d', '#e2e_autodep/b/c', '#e2e_autodep', '#updater'])
      window._item(name)!.delete(false)
  })
  // Bearer owner is the emulator's admin bypass: rules otherwise 403 unauthenticated REST reads,
  // which cannot distinguish a deleted document from a present one
  for (const id of ids)
    await expect
      .poll(
        async () =>
          (
            await fetch(`http://localhost:8080/v1/projects/${laneProjectId()}/databases/(default)/documents/items/${id}`, {
              headers: { Authorization: 'Bearer owner' },
            })
          ).status,
        { message: `durable deletion of ${id}`, timeout: 30_000 }
      )
      .toBe(404)
})

test('an item created by admin syncs to a read-only visitor, and so does its deletion', async ({ page, browser }) => {
  await loadAdmin(page) // interception + fake token are loadAdmin's invariant (see helpers.ts)
  const context = await browser.newContext() // a signed-out visitor of the same account
  try {
    const visitor = await context.newPage()
    await loadAnonymous(visitor)
    const exists = () => visitor.evaluate(() => window._items().some(item => item.name == '#e2e_sync'))
    expect(await exists()).toBe(false)
    await page.evaluate(() => void window._create('#e2e_sync created by admin during e2e tests'))
    await expect.poll(exists, { timeout: 30_000 }).toBe(true) // remote add
    // the writer's explicit acceptance result (review 145 §4): a READ-ONLY wrapper
    // (via the _item options object) refuses with false -- the updater's capability
    // fence depends on this contract
    expect(
      await page.evaluate(() => (window._item as any)('#e2e_sync', { read_only: true }).write('nope')),
      'read-only write refused with false'
    ).toBe(false)
    const textBefore = await page.evaluate(() => window._item('#e2e_sync')!.text)
    expect(textBefore, 'text exactly unchanged by the refusal').toBe('#e2e_sync created by admin during e2e tests')
    // delete(false) skips the window.confirm prompt, which is auto-dismissed in headless browsers
    await page.evaluate(() => window._item('#e2e_sync')!.delete(false))
    await expect.poll(exists, { timeout: 30_000 }).toBe(false) // remote delete
  } finally {
    await context.close()
  }
})

test('vault routing: start, completion, and catch fences suppress web dispatch', async ({ page }) => {
  // the THREE-fence routing witness (bridge design §2.1, reviews 143 §3.2, 148 §4). fixture
  // uses the REAL corpus path -- the installed #chat/ollama provider and its /ollama
  // command -- with its endpoint intercepted, so no model or network call happens and
  // the in-flight request is directly observable and releasable.
  await loadAdmin(page)
  let calls = 0
  let release: (() => void) | null = null
  await page.route('**/api/chat**', async route => {
    calls++
    await new Promise<void>(resolve => (release = resolve))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ message: { role: 'assistant', content: 'fake web reply' } }),
    })
  })
  const runAgent = (name: string) =>
    page.evaluate(async name => {
      const run = await (window._item('#agent/chat') as any).eval('run_on_chat_item', {
        async: true,
        async_simple: true,
      })
      return run(window._item(name))
    }, name)
  const textOf = (name: string) => page.evaluate(name => window._item(name, true)?.text ?? '', name)
  const cleanup = () =>
    page.evaluate(() => {
      for (const name of ['#chat/ollama/0', '#chat/ollama/1', '#chat/ollama/2'])
        if (window._exists(name)) window._item(name)!.delete(false)
    })
  await cleanup() // clear any residue from an earlier failed run (fixed /N names)
  try {
    // PHASE 1 (start fence): the owner adds a vault marker to a web-routed chat item --
  // the web provider must never be invoked at all
  await page.evaluate(() => void window._create('/ollama hello', { command: true }))
  await expect.poll(() => textOf('#chat/ollama/0'), { timeout: 30_000 }).toContain('hello')
  await page.evaluate(() => {
    const item = window._item('#chat/ollama/0')!
    const [first, ...rest] = item.text.split('\n')
    item.write([first + ' #_agent/vault', ...rest].join('\n'), '')
  })
  expect(await textOf('#chat/ollama/0'), 'the vault marker is on the item').toContain('#_agent/vault')
  const callsBefore = calls
  await runAgent('#chat/ollama/0')
  expect(calls, 'start fence: the web provider was never invoked').toBe(callsBefore)
  expect(await textOf('#chat/ollama/0'), 'start fence: nothing was appended').not.toContain('fake web reply')
  // PHASE 2 (completion fence): a web-only chat item starts, the provider blocks, the
  // owner adds the vault route, the provider is released -- the reply must NOT publish
  await page.evaluate(() => void window._create('/ollama hello again', { command: true }))
  await expect.poll(() => textOf('#chat/ollama/1'), { timeout: 30_000 }).toContain('hello again')
  const pending = runAgent('#chat/ollama/1').catch(error => `run failed: ${error}`)
  await expect.poll(() => calls, { message: 'the web provider REALLY ran', timeout: 30_000 }).toBe(callsBefore + 1)
  await page.evaluate(() => {
    const item = window._item('#chat/ollama/1')!
    const [first, ...rest] = item.text.split('\n')
    item.write([first + ' #_agent/vault', ...rest].join('\n'), '')
  })
  const routedText = await textOf('#chat/ollama/1')
  release!()
  expect(await pending, 'completion run settles normally (fence returns undefined)').toBeUndefined()
  expect(await textOf('#chat/ollama/1'), 'completion fence: exact routed text, no reply appended').toBe(routedText)
  // CATCH fence (review 148 §4): a provider REJECTION after the vault marker is added
  // must not publish a web _log either. a fresh web-only item, provider set to reject.
  let rejectRoute: (() => void) | null = null
  await page.unroute('**/api/chat**')
  await page.route('**/api/chat**', async route => {
    calls++
    await new Promise<void>(resolve => (rejectRoute = resolve))
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
  })
  await page.evaluate(() => void window._create('/ollama and again', { command: true }))
  await expect.poll(() => textOf('#chat/ollama/2'), { timeout: 30_000 }).toContain('and again')
  const rejecting = runAgent('#chat/ollama/2')
  await expect.poll(() => calls, { message: 'the rejecting provider ran', timeout: 30_000 }).toBe(callsBefore + 2)
  await page.evaluate(() => {
    const item = window._item('#chat/ollama/2')!
    const [first, ...rest] = item.text.split('\n')
    item.write([first + ' #_agent/vault', ...rest].join('\n'), '')
  })
  const routedText2 = await textOf('#chat/ollama/2')
  rejectRoute!()
  expect(await rejecting, 'catch run settles normally (fence returns undefined)').toBeUndefined()
  expect(await textOf('#chat/ollama/2'), 'catch fence: no web _log published into the routed item').toBe(routedText2)
    expect(await textOf('#chat/ollama/2'), 'catch fence: no error log block').not.toContain('```_log')
  } finally {
    await cleanup()
  }
})

test('the autodep tag applies to descendants only, order-independently, before and after a reload', async ({ page }) => {
  // 2026-09-27 (the vault's autodep reviews 0-1): an item's own #_autodep never makes it adopt
  // its label-prefix parent; a uniquely labeled STRICT ancestor's tag does. The runtime graph
  // is recomputed from the ancestors' raw tags at every pass, so a nested carrier that the
  // descendant scan visits BEFORE its parent (the tab iterates the newest item first, so the
  // carrier is created AFTER the middle level; the order asserted below) drops its parent the
  // moment the root's tag goes, regains it when the tag returns, drops it when the root is
  // renamed (the old label's subtree recomputed too) and regains it when the name returns; a
  // reload agrees
  await loadAdmin(page)
  const idOf = (name: string) => page.evaluate(n => (window._item(n, true) as any)?.id ?? null, name)
  const depsOf = (name: string) => page.evaluate(n => (window._item(n, true) as any)?.dependencies ?? null, name)
  const create = async (text: string) => {
    await page.evaluate(text => void window._create(text), text)
    const name = text.split(/\s/)[0]
    await expect.poll(() => page.evaluate(n => window._item(n, true)?.saved_id ?? null, name), { timeout: 30_000 }).toBeTruthy()
  }
  await create('#e2e_ad #_autodep the root carrier')
  await create('#e2e_ad/b the middle level, no tag of its own')
  await create('#e2e_ad/b/c #_autodep a nested carrier, created after the middle: iterated before it')
  const root = await idOf('#e2e_ad')
  const middle = await idOf('#e2e_ad/b')
  const nested = await idOf('#e2e_ad/b/c')
  const order = await page.evaluate(ids => ids.map(id => window.__items.findIndex(item => item.id == id)), [nested, middle])
  expect(order[0], 'the precondition: the scan visits the nested carrier before the middle').toBeLessThan(order[1])
  expect(await depsOf('#e2e_ad'), 'the root carrier adopts no parent (its dependencies are its tags alone)').not.toContain(middle)
  expect(await depsOf('#e2e_ad/b'), 'the middle adopts the root (a carrying ancestor)').toContain(root)
  expect(await depsOf('#e2e_ad/b/c'), 'the nested carrier adopts the middle (the root carries)').toContain(middle)
  const setRoot = async (text: string) => {
    await page.evaluate(([id, text]) => (window._item(id, true) as any).write(text, ''), [root, text] as const)
    // the write persisted before anything reads the server again (the reload below)
    await expect
      .poll(
        () =>
          page.evaluate(id => {
            const item = window.__items.find(item => item.id == id)!
            return !item.saving && item.savedText
          }, root),
        { timeout: 30_000 }
      )
      .toBe(text)
  }
  await setRoot('#e2e_ad the root, its tag removed')
  await expect.poll(() => depsOf('#e2e_ad/b'), { timeout: 10_000 }).toEqual([])
  expect(await depsOf('#e2e_ad/b/c'), 'no carrying ancestor: the nested carrier drops its parent (its own tag is for its descendants)').not.toContain(middle)
  await setRoot('#e2e_ad #_autodep the root, its tag back')
  await expect.poll(() => depsOf('#e2e_ad/b'), { timeout: 10_000 }).toContain(root)
  expect(await depsOf('#e2e_ad/b/c'), 'the tag back: the nested carrier adopts the middle again').toContain(middle)
  // the root renamed, its tag kept: the old label's subtree has no carrying ancestor any more
  await setRoot('#e2e_zd #_autodep the root, renamed')
  await expect.poll(() => depsOf('#e2e_ad/b'), { timeout: 10_000 }).toEqual([])
  expect(await depsOf('#e2e_ad/b/c'), 'the carrier renamed away: the nested carrier drops its parent').not.toContain(middle)
  await setRoot('#e2e_ad #_autodep the root, its name back')
  await expect.poll(() => depsOf('#e2e_ad/b'), { timeout: 10_000 }).toContain(root)
  expect(await depsOf('#e2e_ad/b/c'), 'the name back: the nested carrier adopts the middle again').toContain(middle)
  await page.reload()
  await loadAdmin(page)
  const middleAfter = await idOf('#e2e_ad/b')
  expect(await depsOf('#e2e_ad/b/c'), 'the initialization pass agrees').toContain(middleAfter)
  expect(await depsOf('#e2e_ad/b'), 'the middle still adopts the root').toContain(await idOf('#e2e_ad'))
})

test('a hidden parent tag places a renamed chat under its tag parent: context, arrow keys, adoption, reload', async ({ page }) => {
  // parent tags (2026-09-28; the vault's notes/design/mind_page_parent_tag.md): `#p/plan-b #_p/0/0`
  // behaves as the nested child #p/0/0/plan-b would, its label kept short: the tag names the
  // parent, the tree's ancestry follows it (the context and the ranks), the arrow keys walk it, a
  // tag-free child under the renamed node adopts it (#_autodep along the same ancestry), the
  // shortening cuts at a segment; every derived fact survives a reload, after each mutation
  await loadAdmin(page)
  const T = '#e2e_pt'
  const create = (text: string) => page.evaluate(text => void window._create(text), text)
  const write = (name: string, text: string) => page.evaluate(([name, text]) => (window._item(name, true) as any).write(text, ''), [name, text] as const)
  // the tree's facts of an item, its closure as labels (the ids of items created in this tab change on reload)
  const view = (name: string) =>
    page.evaluate(name => {
      const i = window._item(name, true) as any
      if (!i) return null
      const label = (id: string) => (window._item(id, true) as any).label
      return { ancestors: i.ancestors, tag_parent: i.tag_parent, deps: i.dependencies.map(label), dependents: i.dependents.map(label).sort() }
    }, name)
  const settled = () =>
    expect
      .poll(
        () => page.evaluate(() => (window as any)._items().filter((i: any) => String(i.label).startsWith('#e2e_')).map((i: any) => [i.label, !!i.saving, !!i.saved_id]).filter((i: any) => i[1] || !i[2])),
        { message: 'every fixture item saved before the reload', timeout: 30_000 }
      )
      .toEqual([])
  for (const text of [
    `${T} the todo`,
    `${T}/0 #_chat/vault #_autodep\n<<user>> first`,
    `${T}/0/0\n<<user>> second`,
    `${T}/0/0/0\n<<user>> third`,
    `${T}/plan-b #_${T.slice(1)}/0/0\n<<user>> plan b`,
    `${T}/plan-b/0\n<<user>> under plan b`,
    `${T}/a #_chat/vault #_autodep\n<<user>> a`,
    `${T}/ab #_${T.slice(1)}/a\n<<user>> ab`,
    `${T}/deep/x #_${T.slice(1)}/0/0\n<<user>> renamed from two levels down`,
    `<< '${T}/0/0/m' >> #_${T.slice(1)}/0/0\n<<user>> a macro-labeled continuation of #e2e_pt/0/0`, // a chat like its siblings (the error state ranks before the nesting)
    `${T}/0/0/ref\n<<user>> see ${T}/plan-b/0`, // a chat below the carrier: its reference in a turn
    `${T}/r/s\nsee ${T}/plan-b/0`,
  ])
    await create(text)
  await expect.poll(() => savedId(page, `${T}/deep/x`), { timeout: 30_000 }).toBeTruthy()
  // the facts: the renamed node under its tag parent, a chat item continuing it; its tag-free
  // child adopting it (the renamed node's closure first, the chat prefix kept)
  const chatPrefix = await page.evaluate(() => {
    const c = window._item('#chat', true) as any
    return [...c.dependencies.map((id: string) => (window._item(id, true) as any).label), '#chat']
  })
  const planB = (await view(`${T}/plan-b`))!
  expect(planB.tag_parent).toBe(`${T}/0/0`)
  expect(planB.ancestors).toEqual([`${T}/0/0`, `${T}/0`, T])
  expect(planB.deps.slice(0, chatPrefix.length), 'a chat item').toEqual(chatPrefix)
  expect(planB.deps.slice(-2)).toEqual([`${T}/0`, `${T}/0/0`])
  const child = (await view(`${T}/plan-b/0`))!
  expect(child).toMatchObject({ tag_parent: null, ancestors: [`${T}/plan-b`, `${T}/0/0`, `${T}/0`, T] })
  expect(child.deps.slice(-3), 'adopts the renamed node').toEqual([`${T}/0`, `${T}/0/0`, `${T}/plan-b`])
  expect(child.deps.slice(0, chatPrefix.length)).toEqual(chatPrefix)
  // ('' is the macro-labeled continuation: its raw label is empty)
  expect((await view(`${T}/0/0`))!.dependents, 'the dependents index at the tag parent').toEqual(['', `${T}/0/0/0`, `${T}/0/0/ref`, `${T}/deep/x`, `${T}/plan-b`, `${T}/plan-b/0`])
  expect(planB.dependents, 'and at the renamed node').toEqual([`${T}/plan-b/0`])
  // the listing: the ancestry above the target in chain order, the shortening at the textual ancestor
  const shown = () => page.evaluate(() => [...document.querySelectorAll('.container mark.label')].map((m: any) => [m.title, m.textContent] as [string, string]))
  const navigate = async (name: string) => {
    await page.evaluate(name => (window as any).MindBox.set(name, { scroll: true }), name)
    await expect.poll(async () => (await shown()).some(([title]) => title == name), { timeout: 15_000 }).toBe(true)
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
    return shown()
  }
  const listed = await navigate(`${T}/plan-b/0`)
  expect(listed.slice(0, 5).map(([title]) => title), 'the chain above the target, in order').toEqual([T, `${T}/0`, `${T}/0/0`, `${T}/plan-b`, `${T}/plan-b/0`])
  expect(Object.fromEntries(listed)[`${T}/plan-b`], 'shortened against the textual ancestor').toBe('…/plan-b')
  expect(Object.fromEntries(await navigate(`${T}/ab`))[`${T}/ab`], 'a segment boundary: #e2e_pt/a is no ancestor of #e2e_pt/ab').toBe('…/ab')
  // the ranks by the tree's depths (a witness the textual arithmetic fails): under the query
  // #e2e_pt/0/0 the renamed nodes (/plan-b, and /deep/x two textual levels down) and the
  // macro-labeled child (/0/0/m, an expanded label) rank with /0/0/0 at depth 1, then the
  // tag-free /plan-b/0 at depth 2 (LISTED by the tree, as a nested label would be by its text);
  // under the query /plan-b/0 two items referring to it rank by their depth under its levels:
  // /0/0/ref (depth 1 under /0/0, a level of the query; textually depth 3 under the todo) before
  // /r/s (depth 2 under the todo either way)
  // the listed items by item id (a macro-labeled item has no label mark: its label is a plain tag
  // mark of the expansion, the raw label being empty), and their RANK positions (the item view's
  // `position`: the listing lays the ranked items out in columns, so the DOM order is not the rank)
  const listedIds = () => page.evaluate(() => [...document.querySelectorAll('.container[data-item-id]')].map(c => c.getAttribute('data-item-id')))
  const positions = (ids: Record<string, string>) =>
    page.evaluate(ids => Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, (window._item(id, true) as any).position as number])), ids)
  // the rank of items in the listing of a query, polled until every one is rendered (the show
  // toggle clicked until it is) and `ordered` holds (the listing reranks about a second after a
  // macro expansion, so an order is a condition to wait for)
  const ranked = async (query: string, ids: Record<string, string>, ordered: (order: Record<string, number>) => boolean) => {
    await page.evaluate(name => (window as any).MindBox.set(name, { scroll: true }), query)
    await expect
      .poll(
        async () => {
          const shownIds = await listedIds()
          const missing = Object.keys(ids).filter(name => !shownIds.includes(ids[name]))
          if (missing.length) {
            await page.evaluate(() => document.querySelector('.toggle.show')?.dispatchEvent(new Event('click')))
            return `missing ${missing.join(', ')}`
          }
          const order = await positions(ids)
          return ordered(order) ? 'ordered' : `unordered ${JSON.stringify(order)}`
        },
        { message: `the listing under ${query}`, timeout: 15_000 }
      )
      .toBe('ordered')
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  }
  const idsOf = async (names: string[]) => Object.fromEntries(await Promise.all(names.map(async name => [name, await page.evaluate(n => (window._item(n, true) as any).id, name)])))
  // the macro-labeled child is expanded (its label read from the macro) once it renders: shown by
  // its id first, as any macro item is at init or when first listed; its expanded label is the
  // first tag mark of its rendering; a chat item like the items it is ranked against (a chat's
  // rendering logs, and the error state is a rank key ahead of the nesting)
  const macroId = await page.evaluate(prefix => (window as any)._items().find((i: any) => i.text.startsWith(prefix))?.id ?? null, `<< '${T}/0/0/m' >>`)
  expect(macroId).toBeTruthy()
  await page.evaluate(id => (window as any).MindBox.set('id:' + id, { scroll: true }), macroId)
  await expect
    .poll(() => page.evaluate(id => (document.querySelector(`.container[data-item-id="${id}"] mark`) as HTMLElement)?.title ?? null, macroId), { message: 'the macro item rendered with its expanded label', timeout: 15_000 })
    .toBe(`${T}/0/0/m`)
  const depth1 = [`${T}/0/0/0`, `${T}/plan-b`, `${T}/deep/x`, `${T}/0/0/m`]
  await ranked(
    `${T}/0/0`,
    { ...(await idsOf([`${T}/0/0/0`, `${T}/plan-b`, `${T}/deep/x`, `${T}/plan-b/0`])), [`${T}/0/0/m`]: macroId },
    order => depth1.every(name => order[name] < order[`${T}/plan-b/0`]) // depth 1 before depth 2
  )
  // the tag-free child MATCHES the query by its levels (its index button says so), as a nested label would by its text
  expect(await page.evaluate(id => !!document.querySelector(`.container[data-item-id="${id}"] .button.index.matching`), (await idsOf([`${T}/plan-b/0`]))[`${T}/plan-b/0`]), '/plan-b/0 matches #e2e_pt/0/0').toBe(true)
  await ranked(`${T}/plan-b/0`, await idsOf([`${T}/0/0/ref`, `${T}/r/s`]), order => order[`${T}/0/0/ref`] < order[`${T}/r/s`]) // depth 1 under a level of the query before depth 2
  // the arrow keys: Up to the tag parent, Down to the shortest nested child, Right along the
  // nested children to the tag child after them and Left back through the tag parent's ring,
  // Down into the tag-free child; the todo's ring has the nested children only
  const box = () => page.evaluate(() => (window as any).MindBox.get())
  const press = async (key: string, expected: string) => {
    await page.keyboard.press(key)
    await expect.poll(box, { message: `${key} to ${expected}`, timeout: 10_000 }).toBe(expected)
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  }
  await navigate(`${T}/plan-b`)
  await press('ArrowUp', `${T}/0/0 `)
  await press('ArrowDown', `${T}/0/0/0 `)
  await press('ArrowRight', `${T}/0/0/ref `) // the ring: the nested children (/0/0/0, /0/0/ref), then the tag children by label
  await press('ArrowRight', `${T}/deep/x `)
  await press('ArrowRight', `${T}/plan-b `)
  await press('ArrowLeft', `${T}/deep/x `) // back through the tag parent's ring
  await press('ArrowLeft', `${T}/0/0/ref `)
  await press('ArrowLeft', `${T}/0/0/0 `)
  await navigate(`${T}/plan-b`)
  await press('ArrowDown', `${T}/plan-b/0 `)
  await navigate(`${T}/0`)
  await press('ArrowRight', `${T}/a `)
  await press('ArrowRight', `${T}/0 `)
  // mutations, each compared with a reload: the facts of the tree and the listing's order
  const G = '#e2e_gap'
  const facts = async () => {
    const out: Record<string, unknown> = {}
    for (const name of [`${T}/0`, `${T}/0/0`, `${T}/0/0/0`, `${T}/plan-b`, `${T}/plan-b/0`, `${T}/ab`, `${T}/plan-c`, `${T}/late`, `${G}/b/c`, `${G}/b/c/d`]) out[name] = await view(name)
    // the listing's head: the target's tree path (the rest renders in chunks, and ranks by time)
    const target = `${T}/plan-b/0`
    const depth = (await view(target))!.ancestors.length + 1
    await page.evaluate(name => (window as any).MindBox.set(name, { scroll: true }), target)
    await expect
      .poll(async () => (await shown()).slice(0, depth).map(([title]) => title), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([T, target]))
    out.listing = (await shown()).slice(0, depth).map(([title]) => title)
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
    return out
  }
  const reloaded = async (): Promise<Record<string, unknown>> => {
    await settled()
    const before = await facts()
    await loadAdmin(page) // signs in and navigates: the reload
    // wait for a server-confirmed, currently served revision: loadAdmin returns once the initial
    // cache snapshot has rendered, before the server snapshot reconciles a deleted duplicate that
    // the cache briefly re-added after the navigation aborted its delete ACK
    await expect
      .poll(() => page.evaluate(() => window._server_confirmed && window._server_current), {
        message: 'the reloaded page applied a server-confirmed corpus',
        timeout: 30_000,
      })
      .toBe(true)
    expect(await facts(), 'the same facts after a reload').toEqual(before)
    return before
  }
  // the carrier tag removed: the target is no chat item, the override lapses, the child adopts nothing
  await write(`${T}/0`, `${T}/0 #_chat/vault\n<<user>> first`)
  let seen = await reloaded()
  expect(seen[`${T}/plan-b`]).toMatchObject({ tag_parent: null, ancestors: [T] })
  expect(seen[`${T}/plan-b/0`]).toMatchObject({ ancestors: [`${T}/plan-b`, T], deps: [], dependents: [] })
  expect(seen[`${T}/0`], 'the carrier lost every dependent').toMatchObject({ dependents: [] })
  expect(seen[`${T}/0/0`]).toMatchObject({ dependents: ['', `${T}/deep/x`, `${T}/plan-b`] }) // the tags stay dependencies
  await write(`${T}/0`, `${T}/0 #_chat/vault #_autodep\n<<user>> first`)
  seen = await reloaded()
  expect(seen[`${T}/plan-b/0`]).toMatchObject({ ancestors: [`${T}/plan-b`, `${T}/0/0`, `${T}/0`, T] })
  // the parent tag changed, and changed back
  const ms = await page.evaluate(([name, text]) => {
    const started = performance.now()
    ;(window._item(name, true) as any).write(text, '')
    return performance.now() - started
  }, [`${T}/plan-b`, `${T}/plan-b #_${T.slice(1)}/0\n<<user>> plan b`] as const)
  console.log(`parent tags: a parent tag change over ${await page.evaluate(() => (window as any)._items().length)} items took ${ms.toFixed(1)} ms (the write's synchronous part: the derivation, the closures, the indexes)`)
  seen = await reloaded()
  expect(seen[`${T}/plan-b`]).toMatchObject({ tag_parent: `${T}/0`, ancestors: [`${T}/0`, T] })
  expect(seen[`${T}/0/0`], 'the old parent lost the renamed node and its child').toMatchObject({ dependents: ['', `${T}/0/0/0`, `${T}/0/0/ref`, `${T}/deep/x`] })
  expect((seen[`${T}/0`] as any).dependents, 'the new parent gained them').toEqual(expect.arrayContaining([`${T}/plan-b`, `${T}/plan-b/0`]))
  expect(seen.listing, 'the chain reordered through the new parent').toEqual([T, `${T}/0`, `${T}/plan-b`, `${T}/plan-b/0`])
  await write(`${T}/plan-b`, `${T}/plan-b #_${T.slice(1)}/0/0\n<<user>> plan b`)
  // the target created after its child, made ambiguous, then unique again
  await create(`${T}/plan-c #_${T.slice(1)}/late\n<<user>> plan c`)
  seen = await reloaded()
  expect(seen[`${T}/plan-c`]).toMatchObject({ tag_parent: null, ancestors: [T], deps: [] })
  await create(`${T}/late #_chat/vault #_autodep\n<<user>> late`)
  seen = await reloaded()
  expect(seen[`${T}/plan-c`]).toMatchObject({ tag_parent: `${T}/late`, ancestors: [`${T}/late`, T] })
  await create(`${T}/late\nduplicate`)
  await expect.poll(() => page.evaluate(name => (window as any)._items(name).length, `${T}/late`)).toBe(2)
  seen = await reloaded()
  expect(seen[`${T}/plan-c`]).toMatchObject({ tag_parent: null, ancestors: [T], deps: [] })
  const dupId = await page.evaluate(name => (window as any)._items(name).find((i: any) => i.text.includes('duplicate')).saved_id, `${T}/late`)
  await page.evaluate(name => (window as any)._items(name).find((i: any) => i.text.includes('duplicate')).delete(false), `${T}/late`)
  await expect.poll(async () => (await firestore().collection('items').doc(dupId).get()).exists, { timeout: 30_000 }).toBe(false)
  seen = await reloaded()
  expect(seen[`${T}/plan-c`]).toMatchObject({ tag_parent: `${T}/late`, ancestors: [`${T}/late`, T] })
  // #_autodep added above a missing level: the change reaches the grandchild across it
  for (const text of [`${G} a root`, `${G}/b/c\nc`, `${G}/b/c/d\nd`]) await create(text)
  seen = await reloaded()
  expect(seen[`${G}/b/c/d`]).toMatchObject({ ancestors: [`${G}/b/c`, `${G}/b`, G], deps: [] })
  await write(G, `${G} a root #_autodep`)
  seen = await reloaded()
  expect(seen[`${G}/b/c/d`]).toMatchObject({ deps: [`${G}/b/c`] })
  expect(seen[`${G}/b/c`]).toMatchObject({ deps: [] })
})

test('installed items keep no GitHub token in items or history, strip legacy and in-memory tokens on save, and authenticate /_update and /_updates from the browser', async ({ page, browser }) => {
  const FAKE_TOKEN = FAKE_GITHUB_TOKEN
  const TOKEN_USER: TestUser = { uid: 'token_e2e', displayName: 'Token Test', email: 'token@e2e.test' }
  const TOKEN_PHRASE = 'token e2e secret phrase'
  const TOKEN_SECRET = secretFor(TOKEN_USER, TOKEN_PHRASE)

  const cleanupUser = async () => {
    const db = firestore()
    for (const col of ['items', 'history']) {
      const snap = await db.collection(col).where('user', '==', TOKEN_USER.uid).get()
      for (const doc of snap.docs) await doc.ref.delete()
    }
    await db.collection('users').doc(TOKEN_USER.uid).delete()
  }
  await cleanupUser()

  const itemRecord = (id: string) => readItemRecord(id, TOKEN_SECRET)
  const historyRecords = (id: string) => readHistoryRecords(id, TOKEN_SECRET)

  const dialogs: string[] = []
  const remoteChanges: string[] = []
  const githubAuths: { path: string; auth: string | null }[] = []
  let anonInstalledId: string | null = null
  let anonCreateSnapId: string | null = null

  const context = await browser.newContext()
  try {
    const personal = await context.newPage()
    personal.on('dialog', dialog => {
      const leaving = dialog.type() == 'beforeunload'
      dialogs.push(`${dialog.type()}: ${dialog.message()}`)
      void (leaving ? dialog.accept() : dialog.dismiss())
    })
    personal.on('console', m => {
      if (/remote change/i.test(m.text())) remoteChanges.push(m.text())
    })
    expect(await interceptMindItems(personal), 'mind.items local checkout required').toBe(true)
    // registered after interceptMindItems so Playwright invokes this recorder first, then falls back
    await personal.route('https://api.github.com/repos/olcan/mind.items/**', route => {
      const url = new URL(route.request().url())
      githubAuths.push({
        path: url.pathname.replace('/repos/olcan/mind.items/', '') + url.search,
        auth: route.request().headers()['authorization'] ?? null,
      })
      return route.fallback()
    })
    await personal.addInitScript(tok => localStorage.setItem('mindpage_github_token', tok), FAKE_TOKEN)
    await customToken(TOKEN_USER)
    await signIn(personal, TOKEN_USER, '/')
    await expect(personal.getByText(/Choose a .*secret phrase/)).toBeVisible({ timeout: 60_000 })
    await personal.fill('#modal-input', TOKEN_PHRASE)
    await personal.locator('.modal .button.confirm', { hasText: 'Continue' }).click()
    await expect(personal.getByText(/Confirm your new secret phrase/)).toBeVisible({ timeout: 60_000 })
    await personal.fill('#modal-input', TOKEN_PHRASE)
    await personal.locator('.modal .button.confirm', { hasText: 'Confirm' }).click()
    await waitForApp(personal)
    await expect.poll(() => personal.evaluate(() => window._server_confirmed), { timeout: 30_000 }).toBe(true)

    // (a) install on an encrypted personal account: token appears nowhere in items or history
    remoteChanges.length = 0
    githubAuths.length = 0
    expect(await install(personal, 'load'), '/_install load').toBeNull()
    await waitWritesSettled(personal, '#load')
    const loadId = (await savedId(personal, '#load'))!
    expect(loadId, '#load saved id').toBeTruthy()
    await expect.poll(async () => (await historyRecords(loadId)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    const afterInstallItem = await itemRecord(loadId)
    const afterInstallHistory = await historyRecords(loadId)
    expect(typeof afterInstallItem.raw.cipher, 'installed personal item is encrypted').toBe('string')
    expect(afterInstallItem.combined, 'install items record holds no token').not.toContain(FAKE_TOKEN)
    for (const h of afterInstallHistory)
      expect(h.combined, `install history record ${h.id} holds no token`).not.toContain(FAKE_TOKEN)
    expect(remoteChanges, 'install write not taken for a remote change').toEqual([])
    expect(await readItemState(personal, '#load'), 'installed item settled with no attr.token').toMatchObject({
      textMatches: true,
      attrMatches: true,
      hasAttrToken: false,
      hasSavedAttrToken: false,
    })

    // (b) sharing the item (unencrypted path): token still nowhere in items or history
    remoteChanges.length = 0
    const histBeforeShare = afterInstallHistory.length
    await personal.evaluate(() => window._item('#load')!.share('e2e-tok', 0))
    await expect
      .poll(async () => {
        const raw = (await itemRecord(loadId)).raw
        return raw.cipher === null && raw.attr?.shared?.keys?.includes('e2e-tok') === true
      }, { message: '#load shared in the clear', timeout: 30_000 })
      .toBe(true)
    await waitWritesSettled(personal, '#load')
    await expect.poll(async () => (await historyRecords(loadId)).length, { timeout: 30_000 }).toBeGreaterThan(histBeforeShare)
    const afterShareItem = await itemRecord(loadId)
    const afterShareHistory = await historyRecords(loadId)
    expect(afterShareItem.rawSerialized, 'shared items record holds no token').not.toContain(FAKE_TOKEN)
    for (const h of afterShareHistory)
      expect(h.combined, `shared history record ${h.id} holds no token`).not.toContain(FAKE_TOKEN)
    expect(remoteChanges, 'share write not taken for a remote change').toEqual([])
    expect(await readItemState(personal, '#load'), 'shared item settled with no attr.token').toMatchObject({
      textMatches: true,
      attrMatches: true,
      hasAttrToken: false,
      hasSavedAttrToken: false,
    })

    // (c) a record that already holds a token (written behind the app): reloading does not mark it
    // changed or save it in a loop, strips the token in memory at the read boundary, and the next
    // save removes it from both items and that save's history copy
    await firestore()
      .collection('items')
      .doc(loadId)
      .update({ attr: { ...afterShareItem.raw.attr, token: FAKE_TOKEN } })
    expect((await itemRecord(loadId)).rawSerialized, 'legacy record seeded with token behind the app').toContain(FAKE_TOKEN)
    await personal.reload()
    await waitForApp(personal)
    await expect.poll(() => personal.evaluate(() => window._server_confirmed), { timeout: 30_000 }).toBe(true)
    await personal.waitForTimeout(500)
    expect(await readItemState(personal, '#load'), 'legacy record enters memory without token and not changed').toMatchObject({
      saving: false,
      textMatches: true,
      attrMatches: true,
      hasAttrToken: false,
      hasSavedAttrToken: false,
    })
    expect((await itemRecord(loadId)).rawSerialized, 'loading a legacy record does not auto-save it').toContain(FAKE_TOKEN)
    const histBeforeLegacySave = (await historyRecords(loadId)).length
    remoteChanges.length = 0
    await personal.evaluate(() => {
      const item = window._item('#load')!
      item.write(item.text + '\n<!-- legacy-save -->', '')
    })
    await waitWritesSettled(personal, '#load')
    await expect.poll(async () => (await historyRecords(loadId)).length, { timeout: 30_000 }).toBeGreaterThan(histBeforeLegacySave)
    expect((await itemRecord(loadId)).rawSerialized, 'legacy record loses token on next save (items)').not.toContain(FAKE_TOKEN)
    const afterLegacyHistory = await historyRecords(loadId)
    for (const h of afterLegacyHistory)
      expect(h.combined, `legacy save history record ${h.id} holds no token`).not.toContain(FAKE_TOKEN)
    expect(remoteChanges, 'legacy save not taken for a remote change').toEqual([])
    expect(await readItemState(personal, '#load'), 'legacy item settled after save').toMatchObject({
      textMatches: true,
      attrMatches: true,
      hasAttrToken: false,
      hasSavedAttrToken: false,
    })

    // (d) token put into live item.attr (as an older #updater does):
    // first, /_backup copies live item.attr straight through encryptItem to history without
    // saveItem — encryptItem's own strip must keep the token out of that history copy;
    // second, saving the item while holding Write/channel so the local pending echo arrives
    // during hasLocalIntent proves saveItem strips before `written` (isOwnPendingChange skips
    // the echo and triggers no deferred getDocFromServer reconcile read on Listen/channel),
    // both records hold no token, and live item.attr is cleared in onSaveDone afterward
    await personal.evaluate(tok => {
      ;(window._item('#load') as any).attr.token = tok
    }, FAKE_TOKEN)
    const histBeforeBackup = afterLegacyHistory.length
    await personal.evaluate(() => void window._create('/_backup', { command: true, return_alerts: true }))
    await expect.poll(async () => (await historyRecords(loadId)).length, { timeout: 30_000 }).toBeGreaterThan(histBeforeBackup)
    const afterBackupHistory = await historyRecords(loadId)
    for (const h of afterBackupHistory)
      expect(h.combined, `/_backup history record ${h.id} holds no token`).not.toContain(FAKE_TOKEN)

    // now save the item with live item.attr.token still set; track any single-document
    // getDocFromServer read on Listen/channel (reconcileDeferred is its only caller for items/<id>,
    // entered only when isOwnPendingChange misclassifies the pending echo and defers it)
    const reconcileReads: string[] = []
    const onRequest = (req: { url: () => string; method: () => string; postData: () => string | null }) => {
      if (req.method() != 'POST' || !/Firestore\/Listen\/channel/.test(req.url())) return
      let body = req.postData() ?? ''
      try {
        body = decodeURIComponent(body)
      } catch {}
      if (body.includes(`documents/items/${loadId}`)) reconcileReads.push(body.slice(0, 200))
    }
    personal.on('request', onRequest)
    remoteChanges.length = 0
    const histBeforeLiveMut = afterBackupHistory.length
    let releaseLiveWrite!: () => void
    const liveWriteGate = new Promise<void>(resolve => {
      releaseLiveWrite = resolve
    })
    let liveWritePosted!: () => void
    const liveWriteSeen = new Promise<void>(resolve => {
      liveWritePosted = resolve
    })
    const liveWritePattern = /Firestore\/Write\/channel/
    await personal.route(liveWritePattern, async route => {
      if (route.request().method() == 'POST') {
        liveWritePosted()
        await liveWriteGate
      }
      await route.continue()
    })
    try {
      await personal.evaluate(() => {
        const item = window._item('#load')!
        item.write(item.text + '\n<!-- old-updater-save -->', '')
      })
      // wait until updateDoc's write hits the wire and its local hasPendingWrites echo has run
      // while savedText is still the old text (so only unackedWrites can classify it as ours)
      await liveWriteSeen
      await personal.waitForTimeout(250)
      releaseLiveWrite()
      await personal.unroute(liveWritePattern)
      await waitWritesSettled(personal, '#load')
      await expect.poll(async () => (await historyRecords(loadId)).length, { timeout: 30_000 }).toBeGreaterThan(histBeforeLiveMut)
      // give scheduleReconcile's setTimeout(..., 0) + getDocFromServer time to fire if deferred
      await personal.waitForTimeout(300)
    } finally {
      releaseLiveWrite()
      await personal.unroute(liveWritePattern).catch(() => {})
      personal.off('request', onRequest)
    }
    expect((await itemRecord(loadId)).combined, 'live attr.token mutation stripped from items record').not.toContain(FAKE_TOKEN)
    const afterLiveMutHistory = await historyRecords(loadId)
    for (const h of afterLiveMutHistory)
      expect(h.combined, `live attr.token mutation stripped from history record ${h.id}`).not.toContain(FAKE_TOKEN)
    expect(remoteChanges, 'live attr.token save not taken for a remote change').toEqual([])
    expect(reconcileReads, 'live attr.token save recognised as own pending write (no deferred reconcile read)').toEqual([])
    expect(await readItemState(personal, '#load'), 'live item.attr cleared and matches savedAttr after save').toMatchObject({
      textMatches: true,
      attrMatches: true,
      hasAttrToken: false,
      hasSavedAttrToken: false,
    })
    // opening and cancelling the editor must not trigger a spurious save (discardEdits compares attr vs savedAttr)
    const histBeforeCancel = afterLiveMutHistory.length
    await personal.evaluate(() => void (location.hash = '#load'))
    const loadContainer = personal.locator(`#super-container-${loadId} .container`)
    await expect(loadContainer).toBeVisible({ timeout: 15_000 })
    await loadContainer.click()
    await expect.poll(async () => (await readItemState(personal, '#load'))?.editing, { timeout: 15_000 }).toBe(true)
    await personal.keyboard.press('Escape')
    await expect.poll(async () => (await readItemState(personal, '#load'))?.editing, { timeout: 15_000 }).toBe(false)
    await personal.waitForTimeout(500)
    expect((await historyRecords(loadId)).length, 'open/cancel editor triggers no spurious save').toBe(histBeforeCancel)

    // (e) /_update and /_updates still authenticate using the browser's stored token; holding the
    // Firestore write channel during /_update also checks that the dispatcher never puts a token
    // onto live item.attr before onSaveDone runs
    githubAuths.length = 0
    remoteChanges.length = 0
    const histBeforeUpdate = (await historyRecords(loadId)).length
    let releaseWrite!: () => void
    const writeGate = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    const writePattern = /Firestore\/Write\/channel/
    await personal.route(writePattern, async route => {
      if (route.request().method() == 'POST') await writeGate
      await route.continue()
    })
    let updateOut: string | null | undefined
    try {
      const updateDone = personal
        .evaluate(() =>
          Promise.resolve(window._create('/_update #load', { command: true, return_alerts: true })).then(out =>
            typeof out == 'string' ? out : null
          )
        )
        .then(r => (updateOut = r))
      await expect
        .poll(async () => updateOut !== undefined || (await personal.getByText('OK', { exact: true }).isVisible()), {
          message: '/_update #load modal',
          timeout: 30_000,
        })
        .toBe(true)
      // while the write is still in flight (before onSaveDone), live item.attr must carry no token
      expect((await readItemState(personal, '#load'))?.hasAttrToken, '/_update dispatcher puts no token into live item.attr').toBe(false)
      releaseWrite()
      await personal.unroute(writePattern)
      if (updateOut === undefined) {
        await personal.getByText('OK', { exact: true }).click()
        await updateDone
      }
    } finally {
      releaseWrite()
      await personal.unroute(writePattern).catch(() => {})
    }
    expect(updateOut ?? null, '/_update #load succeeded without alert').toBeNull()
    await waitWritesSettled(personal, '#load')
    await expect.poll(async () => (await historyRecords(loadId)).length, { timeout: 30_000 }).toBeGreaterThan(histBeforeUpdate)
    expect(githubAuths.length, '/_update called GitHub API').toBeGreaterThan(0)
    expect(
      githubAuths.every(r => r.auth == `token ${FAKE_TOKEN}`),
      `/_update authenticates with browser token: ${JSON.stringify(githubAuths)}`
    ).toBe(true)
    expect((await itemRecord(loadId)).combined, '/_update items record holds no token').not.toContain(FAKE_TOKEN)
    for (const h of await historyRecords(loadId))
      expect(h.combined, `/_update history record ${h.id} holds no token`).not.toContain(FAKE_TOKEN)
    expect(remoteChanges, '/_update write not taken for a remote change').toEqual([])
    expect(await readItemState(personal, '#load'), '/_update item settled with no attr.token').toMatchObject({
      textMatches: true,
      attrMatches: true,
      hasAttrToken: false,
      hasSavedAttrToken: false,
    })

    // select #load in editingItems, then run /_updates
    await personal.evaluate(() => void (location.hash = '#load'))
    await expect(loadContainer).toBeVisible({ timeout: 15_000 })
    await loadContainer.click()
    await expect.poll(async () => (await readItemState(personal, '#load'))?.editing, { timeout: 15_000 }).toBe(true)
    githubAuths.length = 0
    const updatesAlert = await personal.evaluate(() =>
      Promise.resolve(window._create('/_updates', { command: true, return_alerts: true }))
    )
    expect(typeof updatesAlert == 'string' ? updatesAlert : null, '/_updates returned no alert').toBeNull()
    await expect(personal.locator('.modal')).toContainText('No updates available for load.md', { timeout: 30_000 })
    expect(githubAuths.length, '/_updates called GitHub API').toBeGreaterThan(0)
    expect(
      githubAuths.every(r => r.auth == `token ${FAKE_TOKEN}`),
      `/_updates authenticates with browser token: ${JSON.stringify(githubAuths)}`
    ).toBe(true)
    // dismiss modal and close editor
    await personal.keyboard.press('Escape')
    await expect(personal.locator('.modal')).toBeHidden({ timeout: 15_000 })
    await personal.keyboard.press('Escape')
    await expect.poll(async () => (await readItemState(personal, '#load'))?.editing, { timeout: 15_000 }).toBe(false)

    // (f) anonymous corpus: an install on the unencrypted anonymous account leaves no token
    await loadAdmin(page)
    expect(await install(page, 'wiki_links'), '/_install wiki_links on anonymous').toBeNull()
    await waitWritesSettled(page, '#wiki_links')
    anonInstalledId = (await savedId(page, '#wiki_links'))!
    expect(anonInstalledId, 'anonymous #wiki_links saved id').toBeTruthy()
    await expect.poll(async () => (await historyRecords(anonInstalledId!)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    expect((await itemRecord(anonInstalledId)).rawSerialized, 'anonymous install items record holds no token').not.toContain(FAKE_TOKEN)
    for (const h of await historyRecords(anonInstalledId))
      expect(h.rawSerialized, `anonymous install history record ${h.id} holds no token`).not.toContain(FAKE_TOKEN)

    // (g) pending cleartext create: the outgoing payload owns its own cloned attr map before
    // encryptItem, so in-place mutations on live item.attr while setDoc is pending (marker +
    // fake token) reach neither the created items doc nor its first history copy
    const CREATE_SNAP_LABEL = '#e2e_create_snap'
    const CREATE_SNAP_BODY = 'create-snap-payload'
    const CREATE_SNAP_MARKER = 'mutated-while-create-pending'
    const initialCreateAttr = {
      source: 'https://github.com/olcan/mind.items/blob/master/load.md',
      sha: 'sha-create-snap',
      shared: null,
    }
    let releaseCreateWrite!: () => void
    const createWriteGate = new Promise<void>(resolve => {
      releaseCreateWrite = resolve
    })
    let createWritePosted!: () => void
    const createWriteSeen = new Promise<void>(resolve => {
      createWritePosted = resolve
    })
    const createWritePattern = /Firestore\/Write\/channel/
    await page.route(createWritePattern, async route => {
      if (route.request().method() == 'POST') {
        let body = route.request().postData() ?? ''
        try {
          body = decodeURIComponent(body)
        } catch {}
        if (body.includes('/documents/items/') && body.includes(CREATE_SNAP_BODY)) {
          createWritePosted()
          await createWriteGate
        }
      }
      await route.continue()
    })
    try {
      await page.evaluate(
        ({ text, attr }) => {
          window._create(text, {}, attr)
        },
        { text: `${CREATE_SNAP_LABEL} ${CREATE_SNAP_BODY}`, attr: initialCreateAttr }
      )
      await createWriteSeen
      expect(await readItemState(page, CREATE_SNAP_LABEL), 'create write is pending before in-place attr mutation').toMatchObject({
        saving: true,
        savedId: null,
      })
      await page.evaluate(
        ({ label, marker, tok }) => {
          const liveAttr = (window._item(label) as any).attr
          liveAttr.pending_marker = marker
          liveAttr.token = tok
        },
        { label: CREATE_SNAP_LABEL, marker: CREATE_SNAP_MARKER, tok: FAKE_TOKEN }
      )
      releaseCreateWrite()
      await page.unroute(createWritePattern)
      await waitWritesSettled(page, CREATE_SNAP_LABEL)
    } finally {
      releaseCreateWrite()
      await page.unroute(createWritePattern).catch(() => {})
    }
    anonCreateSnapId = (await savedId(page, CREATE_SNAP_LABEL))!
    expect(anonCreateSnapId, 'create snapshot item saved id').toBeTruthy()
    await expect
      .poll(async () => (await firestore().collection('history').where('item', '==', anonCreateSnapId!).get()).size, {
        message: 'create snapshot history row written',
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1)
    const createdItem = await itemRecord(anonCreateSnapId)
    const createdHistory = await historyRecords(anonCreateSnapId)
    expect(createdHistory.length, 'create wrote one history copy').toBe(1)
    expect(createdItem.raw.attr, 'created items record holds initial attributes (no pending mutation or token)').toEqual(
      initialCreateAttr
    )
    expect(createdHistory[0].raw.attr, 'create history copy holds initial attributes (no pending mutation or token)').toEqual(
      initialCreateAttr
    )
    expect(createdItem.rawSerialized, 'created items record holds no marker').not.toContain(CREATE_SNAP_MARKER)
    expect(createdItem.rawSerialized, 'created items record holds no token').not.toContain(FAKE_TOKEN)
    expect(createdHistory[0].rawSerialized, 'create history copy holds no marker').not.toContain(CREATE_SNAP_MARKER)
    expect(createdHistory[0].rawSerialized, 'create history copy holds no token').not.toContain(FAKE_TOKEN)
    const settledCreate = await page.evaluate(label => {
      const raw = (window as any).__items.find((i: any) => i.labelText == label)
      return {
        liveMarker: raw?.attr?.pending_marker ?? null,
        hasLiveToken: !!(raw?.attr && 'token' in raw.attr),
        savedAttr: raw?.savedAttr ?? null,
      }
    }, CREATE_SNAP_LABEL)
    expect(settledCreate, 'live item keeps its own attr (without token) while savedAttr keeps initial snapshot').toEqual({
      liveMarker: CREATE_SNAP_MARKER,
      hasLiveToken: false,
      savedAttr: initialCreateAttr,
    })

    expect(dialogs, 'no unexpected dialogs or beforeunload prompts').toEqual([])
  } finally {
    await context.close()
    await cleanupUser()
    for (const id of [anonInstalledId, anonCreateSnapId]) {
      if (!id) continue
      const db = firestore()
      await db.collection('items').doc(id).delete().catch(() => {})
      const hist = await db.collection('history').where('item', '==', id).get()
      for (const d of hist.docs) await d.ref.delete()
    }
  }
})
