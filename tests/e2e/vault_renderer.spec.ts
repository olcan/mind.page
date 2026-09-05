import { expect, test, type Page } from '@playwright/test'
import { customToken, firestore, install, interceptMindItems, secretFor, waitForApp, type TestUser } from './helpers.js'

// the #template/vault renderer over REAL hidden documents (mind sync v2, slice 5b; design
// notes/design/mind_sync_store.md §3 and §6 in the vault). one self-contained personal account
// that installs the candidate renderer (and, through it, the generic #template utility) from the
// local mind.items checkout: a config item C whose navigation targets a section item S, their
// `_vault` stores written behind the app as encrypted hidden documents; phases: (a) adoption: C
// and S render their stored previews (C nests S's navigation), the badge compares the editable
// source with the pinned source, no source control; (b) the non-saving accessor: rendering,
// including the expanded context, schedules no store save for either owner and leaves the
// server ciphers unchanged, starting from a stale non-empty in-memory copy; (c) store-driven
// propagation through the renderer: a store-only replace of S's `_vault` re-renders S and the
// already-visible C without a reload or a visible-item write
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const USER: TestUser = { uid: 'vault_renderer_e2e', displayName: 'Vault Renderer', email: 'vault_renderer@e2e.test' }
const PHRASE = 'vault renderer e2e phrase'
const SECRET = secretFor(USER, PHRASE)
const C_PATH = 'agents/e2e_prc.md'
const S_PATH = 'agents/e2e_prs.md'
const label = (p: string) => '#vault/' + p.replace(/\.md$/, '')
const C = label(C_PATH)
const S = label(S_PATH)
const itemText = (p: string, source: string, deps: string[]) =>
  [
    `${label(p)} <<vault_badge()>>`,
    '```jinja_removed',
    source.replace(/(\\*)<{2}/g, (_m, bs: string) => bs + '\\<<'),
    '```',
    '<!-- template -->',
    '<<vault_render()>>',
    '<!-- /template -->',
    ['#_template/vault', ...deps.map(d => '#_' + label(d).slice(1))].join(' '),
  ].join('\n')
const C_SOURCE = '---\nbase: agents/e2e_prs.md\n---\nIntro\n![[agents/e2e_prs]]\n'
const S_SOURCE = 'Section text\n'
// the source-first view (mind sync presentation, slices P1/P2): the frontmatter block envelope
// and a hostile body whose every grammar construct must render inert
const H_PATH = 'agents/e2e_prh.md'
const H = label(H_PATH)
const H_FRONTMATTER = '# c &amp; $`x`$ #todo https://e.com\nname: hostile\nbase: "[[agents/e2e_prs]]"\nroot: [[AGENTS]] [[notes/x]]'
const H_BODY = [
  '# Heading with #tag and <<macro>>',
  'Prose A &amp; B with #todo, @{eval}@, $`x`$, `<tag>` and `&amp;` and `[[agents/e2e_prs]]` in code.',
  'Literal A &copycat and &amp=2 and &notit; stay as written.',
  'Valid A &semi; B decodes.',
  '- [query](https://example.com/?x=1&notebook=2)',
  '- [semi](https://example.com/?x=1&semi;y=2)',
  '<script>window.__h_script = 1</script>',
  '<!-- hidden -->secret<!-- /hidden -->',
  '- [ok](https://example.com?a=1&amp;b=2)',
  '- [Run](javascript:window.__h_js=1)',
  '- [ ] a task',
  '![img](https://example.com/i.png)',
  '![[agents/e2e_prs]] and [[AGENTS]] and [[notes/x]].',
  '',
].join('\n')
// the layout witness (presentation design 7.2): the same text as an ordinary item and as a managed source
const L_PATH = 'agents/e2e_prl.md'
const L = label(L_PATH)
const L_BODY = 'Para one.\n\nPara two.\n\n\nPara three.\n- a\n- b\nafter the list\n\n---\n\nlast\n\n\n' // two trailing blank lines after the final newline: rendered by neither
const lStore = () => ({ v: 2, path: L_PATH, pinned_source: L_BODY, head_preview: { kind: 'section', navigation: [{ text: L_BODY }], base: null, exact: null } })
const H_SOURCE = '---\n' + H_FRONTMATTER + '\n---\n' + H_BODY
const itemTextYaml = (p: string, frontmatter: string, body: string, deps: string[]) =>
  [
    `${label(p)} <<vault_badge()>>`,
    '```yaml_removed',
    frontmatter.replace(/(\\*)<{2}/g, (_m, bs: string) => bs + '\\<<'),
    '```',
    '```jinja_removed',
    body.replace(/(\\*)<{2}/g, (_m, bs: string) => bs + '\\<<'),
    '```',
    '<!-- template -->',
    '<<vault_render()>>',
    '<!-- /template -->',
    ['#_template/vault', ...deps.map(d => '#_' + label(d).slice(1))].join(' '),
  ].join('\n')
const hStore = () => ({
  v: 2,
  path: H_PATH,
  pinned_source: H_SOURCE,
  head_preview: { kind: 'config', navigation: [{ target: S_PATH }], base: null, exact: { profile: 'bare', instructions: 'H instructions\n\nsee [[agents/e2e_prs]]', run_instructions: null, user_prompt: null } },
})
const cStore = (sText: string) => ({
  v: 2,
  path: C_PATH,
  pinned_source: C_SOURCE,
  head_preview: {
    kind: 'config',
    navigation: [{ text: 'Intro\n' }, { target: S_PATH }],
    base: null,
    exact: { profile: 'bare', instructions: 'C instructions ' + sText, run_instructions: null, user_prompt: null },
  },
})
const sStore = (text: string, pinned = S_SOURCE) => ({
  v: 2,
  path: S_PATH,
  pinned_source: pinned,
  head_preview: { kind: 'section', navigation: [{ text }], base: null, exact: null },
})

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

const rendered = (page: Page, name: string) =>
  page.evaluate(async name => {
    const item = window._item(name, true)
    if (!item) return null
    const expired = new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000))
    const elem = item.elem ?? (await Promise.race([window._render_item(item), expired]))
    if (!elem) return null
    const content = (elem as HTMLElement).querySelector('.content') as HTMLElement | null
    return {
      text: content?.textContent ?? '',
      // the carriers (frontmatter, code) and the projection's inert-markdown views, as text without the layout spacers
      carriers: [...(content?.querySelectorAll('pre code, .vault .vault-source') ?? [])].map(c => (c.textContent ?? '').replace(/\u00a0/g, '').trimEnd()),
      toggles: [...(content?.querySelectorAll('span.template_toggle') ?? [])].map(s => s.textContent ?? ''),
      badge: (elem as HTMLElement).querySelector('[title="managed by the vault sync"]')?.textContent ?? '',
    }
  }, name)

const savedId = (page: Page, name: string) => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)

// the app's hidden document shape, encrypted v0 with the account's stored secret
async function writeStore(id: string, name: string, item: unknown) {
  const { encryptWithSecret } = await import('../../src/crypto.js')
  const time = Date.now()
  const cipher = await encryptWithSecret(JSON.stringify({ hidden: true, time, attr: null, text: JSON.stringify({ name, item }) }), SECRET)
  await firestore().collection('items').doc(id).set({ user: USER.uid, time, hidden: true, text: null, attr: null, cipher })
}
const cipherOf = async (id: string) => (await firestore().collection('items').doc(id).get()).data()?.cipher ?? null
const updateTime = async (id: string) => (await firestore().collection('items').doc(id).get()).updateTime?.toMillis() ?? null
// the decrypted text of a visible document as the SERVER holds it (the app writes v0 ciphers
// under its default write gate), or null: the acknowledgement barrier for an app-side edit
async function serverText(id: string): Promise<string | null> {
  const { decryptWithSecret } = await import('../../src/crypto.js')
  const data = (await firestore().collection('items').doc(id).get()).data()
  if (!data?.cipher) return data?.text ?? null
  try {
    return JSON.parse(await decryptWithSecret(data.cipher, SECRET)).text ?? null
  } catch {
    return null
  }
}

test.beforeAll(cleanup)
test.afterAll(cleanup)

test('the renderer reads real hidden stores, saves nothing, and follows store-only changes', async ({ page }) => {
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
    .poll(() => page.evaluate(() => window._init_time > 0 && window._readonly === false).catch(() => false), {
      timeout: 90_000,
    })
    .toBe(true)
  await enterPhrase(page, /Choose a .*secret phrase/, PHRASE, 'Continue')
  await enterPhrase(page, /Confirm your new secret phrase/, PHRASE, 'Confirm')
  await waitForApp(page)
  // the candidate renderer from the local checkout (its #_///template dependency comes with it)
  expect(await install(page, 'template/vault'), '/_install template/vault').toBeNull()
  await page.reload()
  await waitForApp(page)
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAuthoritative), { timeout: 30_000 }).toBe(true)
  expect(await page.evaluate(() => window._exists('#template/vault') && window._exists('#template')), 'renderer and #template installed').toBe(true)

  // the two managed items (S first: C's tag line depends on it), then their stores behind the app
  await page.evaluate(t => void window._create(t), itemText(S_PATH, S_SOURCE, []))
  await expect.poll(() => savedId(page, S), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(t => void window._create(t), itemText(C_PATH, C_SOURCE, [S_PATH]))
  await expect.poll(() => savedId(page, C), { timeout: 30_000 }).toBeTruthy()
  const sId = (await savedId(page, S))!
  const cId = (await savedId(page, C))!
  // before any store: both fail closed as missing
  await expect.poll(async () => (await rendered(page, S))?.badge, { timeout: 30_000 }).toBe('vault store missing')
  await expect.poll(async () => (await rendered(page, C))?.badge, { timeout: 30_000 }).toBe('vault store missing')
  const S_STORE_ID = 'e2e-prs-store'
  const C_STORE_ID = 'e2e-prc-store'
  await writeStore(S_STORE_ID, `global_store_${sId}`, { _vault: sStore('S one\n') })
  await writeStore(C_STORE_ID, `global_store_${cId}`, { _vault: cStore('one') })

  // (a) adoption: the stored previews render; C nests S; the badges compare the editable source
  // with the pinned source; no source control anywhere
  await expect.poll(async () => (await rendered(page, S))?.badge, { timeout: 30_000 }).toBe('section')
  await expect.poll(async () => (await rendered(page, C))?.badge, { timeout: 30_000 }).toBe('config')
  await expect.poll(async () => (await rendered(page, C))?.carriers ?? [], { timeout: 30_000 }).toContain('C instructions one')
  const c1 = (await rendered(page, C))!
  expect(c1.carriers, 'C nests S\'s navigation text').toContain('S one')
  expect(c1.carriers, 'the editable source is never a carrier').not.toContain(C_SOURCE)
  expect(c1.toggles.join('|'), 'no source control').not.toContain('⋮ source')
  expect(c1.toggles.some(t => t.includes('⋮ projection')), 'the projection sits behind one toggle').toBe(true)
  expect(c1.toggles.some(t => t.includes('instructions (bare profile)')), 'the instructions control').toBe(true)
  // an edited source shows the differs form the moment it renders, without any sync; the edit
  // must then be acknowledged by the server before phase (c)'s no-visible-write baseline
  const sEdited = itemText(S_PATH, S_SOURCE + 'edited\n', [])
  await page.evaluate(([n, t]) => void window._item(n)!.write(t, ''), [S, sEdited] as const)
  await expect.poll(async () => (await rendered(page, S))?.badge, { timeout: 30_000 }).toBe('section · differs from the stored sync snapshot')
  await expect.poll(() => serverText(sId), { timeout: 30_000 }).toBe(sEdited)

  // (b) the non-saving accessor: from a stale non-empty in-memory copy, evaluating both macros
  // of C and S in the ordinary and the expanded context schedules no store save for either
  // owner (the seam counter increments synchronously, scoped to the two owners, so the results
  // of the evaluations themselves are the completion witness) and leaves both server ciphers
  // unchanged
  const cipherS = await cipherOf(S_STORE_ID)
  const cipherC = await cipherOf(C_STORE_ID)
  expect(cipherS && cipherC, 'both stores exist on the server').toBeTruthy()
  const evaluated = await page.evaluate(([c, s]) => {
    const w = window as any
    w.__storeSaves = 0
    const proto = Object.getPrototypeOf(window._item(c)!)
    const original = proto.save_global_store
    proto.save_global_store = function (...args: unknown[]) {
      if (this.name == c || this.name == s) w.__storeSaves++
      return original.apply(this, args)
    }
    // a stale non-empty in-memory copy: the app's memory differs from the applied index
    ;(window._item(s) as any)._global_store._stale = 1
    const out: Record<string, string> = {}
    try {
      for (const n of [c, s]) {
        out[n + ':ordinary'] = String((window._item(n) as any).eval_macros('<<vault_badge()>> <<vault_render()>>'))
        try {
          out[n + ':expanded'] = String((window._item(n) as any).eval_macros('<<vault_badge()>> <<vault_render()>>', { context: 'expanded' }))
        } catch (error) {
          out[n + ':expanded'] = 'THROWN ' + String((error as Error).message ?? error) // presentation design 7.6
        }
      }
    } finally {
      proto.save_global_store = original
      delete (window._item(s) as any)._global_store._stale
    }
    return { out, saves: w.__storeSaves as number }
  }, [C, S] as const)
  expect(evaluated.out[C + ':ordinary'], 'C renders its composition in the ordinary context').toContain('class="vault"')
  expect(evaluated.out[C + ':ordinary'], 'C badge in the ordinary context').toContain('title="managed by the vault sync"')
  expect(evaluated.out[C + ':expanded'], 'C expanded context is its instructions').toContain('C instructions one')
  expect(evaluated.out[S + ':expanded'], 'S (a section) throws in the expanded context instead of a fixed string').toContain('THROWN')
  expect(evaluated.out[S + ':expanded'], 'with the reason').toContain('a section carries no standalone context')
  expect(evaluated.saves, 'no store save scheduled by rendering').toBe(0)
  expect(await cipherOf(S_STORE_ID), 'the S store cipher is unchanged').toBe(cipherS)
  expect(await cipherOf(C_STORE_ID), 'the C store cipher is unchanged').toBe(cipherC)

  // (c) store-driven propagation through the renderer: a store-only replace of S's `_vault`
  // re-renders S and the already-visible C, with both visible documents unwritten
  const before = { s: await updateTime(sId), c: await updateTime(cId) }
  await writeStore(S_STORE_ID, `global_store_${sId}`, { _vault: sStore('S two\n', S_SOURCE + 'edited\n') })
  // S's own view shows its source, not its text-only navigation (presentation decision 4), so its
  // re-render shows as the badge flipping back to the pinned form; C's nested view carries S two
  await expect.poll(async () => (await rendered(page, S))?.badge, { timeout: 30_000 }).toBe('section')
  await expect.poll(async () => (await rendered(page, C))?.carriers ?? [], { timeout: 30_000 }).toContain('S two')
  expect({ s: await updateTime(sId), c: await updateTime(cId) }, 'no visible-item write').toEqual(before)

  // (d) the source-first view through the REAL pipeline (presentation design sections 3 and 4):
  // the frontmatter block envelope, highlighted YAML with an inert comment, the body as inert
  // markdown (entities decoded once, code literal, a managed reference rendered as the app's own
  // tag-link markup whose mousedown reaches a recording callback installed in place of the app's
  // handler, an unmanaged hint, no script, checkbox, image, math, or
  // executable destination), the projection behind its toggle
  await page.evaluate(t => void window._create(t), itemTextYaml(H_PATH, H_FRONTMATTER, H_BODY, [S_PATH]))
  await expect.poll(() => savedId(page, H), { timeout: 30_000 }).toBeTruthy()
  const hId = (await savedId(page, H))!
  await writeStore('e2e-prh-store', `global_store_${hId}`, { _vault: hStore() })
  await expect.poll(async () => (await rendered(page, H))?.badge, { timeout: 30_000 }).toBe('config')
  const view = await page.evaluate(async name => {
    const item = window._item(name, true)!
    const elem = (item.elem ?? (await window._render_item(item))) as HTMLElement
    const content = elem.querySelector('.content') as HTMLElement
    const w = window as any
    const clicked: unknown[][] = []
    const original = w._handleTagClick
    w._handleTagClick = (...args: unknown[]) => {
      clicked.push(args)
    }
    const link = content.querySelector('.vault-source mark.link[title="#vault/agents/e2e_prs"]') as HTMLElement | null
    if (link) link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    // the frontmatter's own link (presentation design 7.4), dispatched separately
    const yamlLink = content.querySelector('pre.vault-frontmatter mark.link[title="#vault/agents/e2e_prs"]') as HTMLElement | null
    if (yamlLink) yamlLink.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    w._handleTagClick = original
    const yaml = content.querySelector('pre.vault-frontmatter') as HTMLElement | null
    return {
      yamlText: yaml?.textContent ?? null,
      yamlComment: !!yaml?.querySelector('.vault-comment'),
      yamlMarks: yaml ? [...yaml.querySelectorAll('mark')].map(m => m.getAttribute('title') + '=' + m.textContent) : null,
      yamlOther: yaml?.querySelectorAll('a, span.math').length ?? -1,
      projection: (() => {
        const div = [...content.querySelectorAll('div.template_toggle')].find(d => (d.getAttribute('title') ?? '').includes('projection')) as HTMLElement | undefined
        const inner = div?.querySelector('div.template_toggle[title*="instructions"] .vault-source') as HTMLElement | null | undefined
        return { paragraphs: inner?.querySelectorAll('p').length ?? -1, marks: inner ? [...inner.querySelectorAll('mark')].map(m => m.getAttribute('title')) : null, spacer: inner?.innerHTML.includes('&nbsp;<br>') ?? false }
      })(),
      yamlHighlighted: !!yaml?.querySelector('.hljs-attr'),
      heading: (content.querySelector('.vault-source h1') as HTMLElement | null)?.textContent ?? null,
      codes: [...content.querySelectorAll('.vault-source code')].map(c => c.textContent),
      prose: (content.querySelector('.vault-source p') as HTMLElement | null)?.textContent ?? null,
      hrefs: [...content.querySelectorAll('.vault-source a')].map(a => a.getAttribute('href')),
      literalProse: (content.querySelector('.vault-source') as HTMLElement | null)?.textContent?.includes('Literal A &copycat and &amp=2 and &notit; stay as written.') ?? false,
      semiProse: (content.querySelector('.vault-source') as HTMLElement | null)?.textContent?.includes('Valid A ; B decodes.') ?? false,
      anchors: content.querySelectorAll('.vault-source a').length,
      // the body's source view only (the projection's inert-markdown views sit inside div.vault)
      marks: [...([...content.querySelectorAll('.vault-source')].find(d => !d.closest('div.vault'))?.querySelectorAll('mark') ?? [])].map(m => m.getAttribute('title')),
      hint: (content.querySelector('.vault-source [title="not a managed file"]') as HTMLElement | null)?.textContent ?? null,
      checkboxes: content.querySelectorAll('input').length,
      images: content.querySelectorAll('img').length,
      scripts: content.querySelectorAll('script').length,
      math: content.querySelectorAll('span.math').length,
      hidden: content.textContent?.includes('secret') ?? false,
      scriptRan: w.__h_script === 1 || w.__h_js === 1,
      clicked,
      ownerId: item.id,
      toggles: [...content.querySelectorAll('span.template_toggle')].map(s => s.textContent ?? ''),
    }
  }, H)
  expect(view.yamlText, 'the frontmatter characters are shown exactly').toBe(H_FRONTMATTER)
  expect(view.yamlHighlighted && view.yamlComment, 'highlighted YAML with the renamed comment class').toBe(true)
  expect(view.yamlMarks, 'managed references inside the frontmatter are tag links showing their exact spelling; an unmanaged one is text').toEqual(['#vault/agents/e2e_prs=[[agents/e2e_prs]]', '#vault/AGENTS=[[AGENTS]]'])
  expect(view.yamlOther, 'no anchor or math inside the frontmatter').toBe(0)
  expect(view.projection, 'the projection fields render as inert markdown with the spacer and links').toEqual({ paragraphs: 2, marks: ['#vault/agents/e2e_prs'], spacer: true })
  expect(view.heading, 'the heading keeps its grammar characters as text').toBe('Heading with #tag and <<macro>>')
  expect(view.codes, 'code spans are literal').toEqual(expect.arrayContaining(['<tag>', '&amp;', '[[agents/e2e_prs]]']))
  expect(view.prose, 'prose entities decode once; the dollar-backtick span is a code span, not app math').toContain('Prose A & B with #todo, @{eval}@, $x$')
  expect(view.literalProse, 'incomplete or unknown references stay literal').toBe(true)
  expect(view.semiProse, 'the valid &semi; reference decodes to its semicolon').toBe(true)
  expect(view.hrefs, 'valid entities in destinations decode once (&amp;, &semi;); a parameter that only looks like one survives').toEqual([
    'https://example.com/?x=1&notebook=2',
    'https://example.com/?x=1;y=2',
    'https://example.com?a=1&b=2',
  ])
  expect(view.anchors, 'only the allowed links are anchors').toBe(3)
  expect(view.marks, 'the managed references (the root file included) are app tag links; the code-span one stays literal').toEqual(['#vault/agents/e2e_prs', '#vault/AGENTS'])
  expect(view.hint, 'the unmanaged reference is a hint').toBe('[[notes/x]]')
  expect([view.checkboxes, view.images, view.scripts, view.math], 'no checkbox, image, script, or math').toEqual([0, 0, 0, 0])
  expect(view.hidden, 'the hidden-section comment stays visible text').toBe(true)
  expect(view.scriptRan, 'nothing executed').toBe(false)
  expect(view.clicked.length && view.clicked[0][1], 'the managed link\'s mousedown reaches the recording tag-click callback with the label').toBe('#vault/agents/e2e_prs')
  expect(view.clicked.length && view.clicked[0][0], 'bound to the owning item\'s in-app id (as the app\'s own tag marks are)').toBe(view.ownerId)
  expect(view.clicked.length, 'the body link and the frontmatter link each reached the callback once').toBe(2)
  expect([view.clicked[1][0], view.clicked[1][1]], 'the frontmatter link is bound to the same item and label').toEqual([view.ownerId, '#vault/agents/e2e_prs'])
  expect(view.toggles.some(t => t.includes('⋮ projection')), 'the projection toggle').toBe(true)

  // (e) the layout witness (presentation design 7.2): the same paragraphs, blank lines, list, and
  // rule as an ordinary item and as a managed source lay out with the same elements
  await page.evaluate(t => void window._create(t), '#e2e_plain_layout\n\n' + L_BODY) // the label paragraph is removed below
  await page.evaluate(t => void window._create(t), itemTextYaml(L_PATH, '', L_BODY, []).replace('```yaml_removed\n\n```\n', ''))
  await expect.poll(() => savedId(page, L), { timeout: 30_000 }).toBeTruthy()
  const lId = (await savedId(page, L))!
  await writeStore('e2e-prl-store', `global_store_${lId}`, { _vault: lStore() })
  await expect.poll(async () => (await rendered(page, L))?.badge, { timeout: 30_000 }).toBe('section')
  // measure each item while it is the shown item (an item that is not laid out reports zero offsets)
  const show = async (n: string) => {
    await page.evaluate(n => void (location.hash = n), n)
    await expect.poll(() => page.evaluate(n => !!window._item(n, true)?.elem?.offsetParent, n), { timeout: 15_000 }).toBe(true)
  }
  const measure = (name: string, dropLabel: boolean, selector: string) =>
    page.evaluate(([n, drop, sel]) => {
      const shapeOf = (root: Element) => ({
        p: root.querySelectorAll('p').length,
        br: root.querySelectorAll('br').length,
        hr: root.querySelectorAll('hr').length,
        li: root.querySelectorAll('li').length,
        spacers: (root.innerHTML.match(/&nbsp;<br>/g) ?? []).length,
        // the block sequence with its text (whitespace removed: the app's pass keeps newline text nodes between list items)
        blocks: [...root.children].map(el => el.tagName.toLowerCase() + ':' + (el.textContent ?? '').replace(/\s+/g, '')),
        tops: [...root.children].map(el => Math.round(el.getBoundingClientRect().top - root.getBoundingClientRect().top)),
      })
      const elem = window._item(n as string, true)!.elem as HTMLElement
      const root = elem.querySelector(sel as string) as HTMLElement | null
      if (!root) return null
      const shape = shapeOf(root)
      if (drop) {
        // the ordinary item's label paragraph (label, break, spacer) is not part of the body
        const labelTop = shape.tops.length > 1 ? shape.tops[1] : 0
        const first = root.children[0]
        shape.p -= (first?.tagName == 'P' ? 1 : 0) + (first?.querySelectorAll('p').length ?? 0)
        shape.br -= first?.querySelectorAll('br').length ?? 0
        shape.spacers -= (root.children[0]?.innerHTML.match(/&nbsp;<br>/g) ?? []).length
        shape.blocks = shape.blocks.slice(1)
        shape.tops = shape.tops.slice(1).map(t => t - labelTop)
      }
      return shape
    }, [name, dropLabel, selector] as const)
  await show('#e2e_plain_layout')
  const plainLayout = await measure('#e2e_plain_layout', true, '.content')
  await show(L)
  const managedLayout = await measure(L, false, '.content .vault-source')
  const layout = { plain: plainLayout!, managed: managedLayout }
  const { tops: managedTops, ...managedShape } = layout.managed!
  const { tops: plainTops, ...plainShape } = layout.plain
  expect(managedShape, 'the managed source lays out like the ordinary item (block sequence and text, paragraphs, breaks, rule, list items, spacers)').toEqual(plainShape)
  expect(managedTops.length, 'the same number of blocks').toBe(plainTops.length)
  const offsets = managedTops.map((t, i) => t - plainTops[i])
  // the app's direct-child list paddings (2px above and below a list) do not reach a list inside the source
  // container: the accepted difference (presentation design 7.2); every other block sits within a pixel
  expect(offsets.every((d, i) => Math.abs(d) <= 1 || (i >= plainShape.blocks.findIndex(b => b.startsWith('ul:')) && Math.abs(d) <= 4)), `block offsets differ beyond the list padding: ${JSON.stringify({ plainTops, managedTops })}`).toBe(true)
  expect(plainShape.spacers, 'one spacer per blank line (five blank lines; neither the final newline nor the trailing blank lines)').toBe(5)
})
