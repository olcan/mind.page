import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { firestore, install, loadAdmin } from './helpers.js'

// the vault renderer contract row, on its own lane (playwright.config.ts: `contract`): it signs
// in as admin and installs what it needs itself, so it no longer waits behind the admin lane's
// install-and-test chain (admin.spec.ts)
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

// the SYNTHETIC consumer fixtures of the vault's mind sync design (v2 representation,
// notes/design/mind_sync_store.md in the vault): each .md file is one managed item's full text
// under a synthetic managed path (agents/e2e_*.md) and its .json sidecar is the `_vault` value
// of the item's store, converted once from the v1 fixtures the vault's Python encoder generated
// and checked in; they exercise the schema and nesting, not producer truth. in this ANONYMOUS
// row the store is injected in memory (the app's anonymous store path); real hidden documents,
// the non-saving accessor's no-write property, and store-driven propagation through the
// renderer are the personal-account row in vault_renderer.spec.ts. resolved like helpers.ts
// (cwd-relative: playwright runs from the mind.page root; ESM has no __dirname)
const FIXTURES = resolve(process.env.MIND_ITEMS_DIR ?? '../mind.items', 'tests', 'fixtures', 'vault_sync')
const MANIFEST = ['e2e_absent.md', 'e2e_config.md', 'e2e_large.md', 'e2e_nested.md', 'e2e_section.md', 'e2e_worker.md']
const PREFIX = '#vault/agents/e2e_' // every synthetic label starts with this
const RENDERER = '#template/vault'
const block = (text: string, lang: string) => text.split('```' + lang + '\n')[1]?.split('\n```')[0] ?? ''
const unescape = (body: string) => body.replace(/(\\+)<{2}/g, (_m, bs: string) => bs.slice(1) + '<<')
const label = (p: string) => '#vault/' + p.replace(/\.md$/, '')
// a managed item's text (the v2 skeleton: the escaped source, the template region, the tags)
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
// a `_vault` store value (the consumer accepts any object; wrapper identity and provenance are
// the vault's and the producer's, not a renderer check)
const storeOf = (p: string, pinned: string | null, head_preview: unknown) => ({ v: 2, path: p, pinned_source: pinned, head_preview })

test('vault renderer contract', async ({ page }) => {
  await loadAdmin(page)
  const files = readdirSync(FIXTURES).filter(f => f.endsWith('.md')).sort()
  expect(files, 'the exact fixture manifest').toEqual(MANIFEST)
  const texts = files.map(file => readFileSync(resolve(FIXTURES, file), 'utf8'))
  const stores = files.map(file => JSON.parse(readFileSync(resolve(FIXTURES, file.replace(/\.md$/, '.json')), 'utf8')))
  // the in-memory store injection of this anonymous row (the app's anonymous store path), then a
  // forced render so the injected value is what the next read sees
  const setStore = (n: string, store: unknown) =>
    page.evaluate(
      ([n, store]) => {
        const item = window._item(n)!
        item.global_store = { _vault: store }
        ;(item as any).invalidate_elem_cache({ force_render: true, render_delay: 0 })
      },
      [n, store] as const
    )
  // the badge as rendered on screen; the forced render after an injection is asynchronous, so
  // every read of an injected item first waits for its badge to leave the pre-injection note
  const badgeOf = (n: string) =>
    page.evaluate(n => window._item(n, true)?.elem?.querySelector('[title="managed by the vault sync"]')?.textContent ?? null, n)
  const nameOf = (text: string) => text.split(/\s/)[0]
  const fixture = (file: string) => texts[files.indexOf(file)]
  // items are addressed by LOCAL id: a duplicated label renames both wrappers to id:<local-id>,
  // so names are ambiguous exactly in the killed-run state the pre-clean must recover from
  const localIdOf = (label: string) => page.evaluate(l => window._items().find(i => i.label == l)?.id ?? null, label)
  const savedIdOfId = (id: string) => page.evaluate(id => (window._item(id, true) as any)?.saved_id ?? null, id)
  const savedIdOf = async (label: string) => {
    const id = await localIdOf(label)
    return id ? savedIdOfId(id) : null
  }
  // DURABLE persistence (feedback 6/7): a create is awaited until the item has its saved id,
  // a delete is awaited until the emulator's document is gone (the app's deleteDoc is
  // fire-and-forget and the local array drops the item synchronously)
  const absent = async (ids: string[]) => {
    for (const id of ids) await expect.poll(async () => (await firestore().collection('items').doc(id).get()).exists, { timeout: 30_000 }).toBe(false)
  }
  const create = async (text: string) => {
    const before: string[] = await page.evaluate(l => window._items().filter(i => i.label == l).map(i => i.id), nameOf(text))
    await page.evaluate(t => void window._create(t), text)
    let id: string | null = null
    await expect.poll(async () => (id = await page.evaluate(([l, b]) => window._items().find(i => i.label == l && !b.includes(i.id))?.id ?? null, [nameOf(text), before] as const)), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => savedIdOfId(id!), { timeout: 30_000 }).toBeTruthy()
    return { id: id!, saved: (await savedIdOfId(id!)) as string }
  }
  const remove = async (localId: string, savedId: string | null) => {
    await page.evaluate(id => window._item(id)!.delete(false), localId)
    if (savedId) await absent([savedId])
  }
  // every local item under the synthetic prefix or the renderer, by LOCAL id (labels may be
  // duplicated after a killed run, when _item(label) would be ambiguous); pre-cleaning is the
  // recovery path after a killed or timed-out run, the finally path handles failures
  const clean = async () => {
    const local: { id: string; saved: string | null }[] = await page.evaluate(
      ([p, r]) => window._items().filter(i => i.label.startsWith(p) || i.label == r).map(i => ({ id: i.id, saved: (i as any).saved_id ?? null })),
      [PREFIX, RENDERER] as const
    )
    for (const { id, saved } of local) await remove(id, saved)
    expect(await page.evaluate(([p, r]) => window._items().filter(i => i.label.startsWith(p) || i.label == r).length, [PREFIX, RENDERER] as const)).toBe(0)
    return local.map(l => l.saved).filter((s): s is string => !!s)
  }
  // the projection is LAZY (init_perf): a read of the projection's views fills it first, as its
  // first open would, without toggling visibility (a re-rendered item carries a fresh toggle)
  const fillProjection = (n: string) =>
    page.evaluate(n => {
      const item = window._item(n, true)
      const content = item?.elem?.querySelector('.content') as HTMLElement | null | undefined
      for (const s of content?.querySelectorAll('span.template_toggle') ?? []) {
        const idc = [...s.classList].find(c => c.startsWith('id_'))
        if (idc && (s.textContent ?? '').includes('⋮ projection')) (window as any)._vault_lazy_fill?.(item!.id, idc)
      }
    }, n)
  const carriers = async (n: string) => {
    await fillProjection(n)
    return page.evaluate(n => {
      const content = window._item(n, true)!.elem?.querySelector('.content') as HTMLElement
      // the carriers and the inert-markdown views (text parts and projection fields since the presentation design's section 7)
      return [...(content?.querySelectorAll('pre code, .vault .vault-source') ?? [])].map(c => c.textContent ?? '')
    }, n)
  }
  const show = async (n: string) => {
    await page.evaluate(n => void (location.hash = n), n)
    await expect.poll(() => page.evaluate(n => !!window._item(n, true)?.elem, n), { timeout: 15_000 }).toBe(true)
  }
  await clean()
  try {
    expect(await install(page, 'template/vault'), '/_install template/vault').toBeNull()
    await expect.poll(() => savedIdOf(RENDERER), { timeout: 30_000 }).toBeTruthy()
    // install every fixture before rendering any (dependency tags must resolve first), then
    // inject every store
    for (const text of texts) await create(text)
    for (const [i, text] of texts.entries()) await setStore(nameOf(text), stores[i])
    for (const [i, file] of files.entries()) {
      const text = texts[i]
      const name = nameOf(text)
      const store = stores[i]
      const source = unescape(block(text, 'jinja_removed'))
      // the visible badge drops the path the label already carries (mind sync presentation P2)
      const expectedBadge = store.head_preview
        ? store.head_preview.kind + (source === store.pinned_source ? '' : ' · differs from the stored sync snapshot')
        : 'not in the stored sync snapshot'
      await show(name)
      await expect.poll(() => badgeOf(name), { timeout: 30_000 }).toBe(expectedBadge)
      const r = await page.evaluate(n => {
        const item = window._item(n, true)!
        const content = item.elem?.querySelector('.content') as HTMLElement
        const owner = (el: Element) => (el.getAttribute('onclick') ?? '').match(/_item\('([^']+)'\)/)?.[1] ?? ''
        // the projection is LAZY (init_perf): fill it as its first open would (without toggling
        // visibility), so its placeholder or its inner toggles are on the page for the checks below
        for (const s of content?.querySelectorAll('span.template_toggle') ?? []) {
          const idc = [...s.classList].find(c => c.startsWith('id_'))
          if (idc && (s.textContent ?? '').includes('⋮ projection')) (window as any)._vault_lazy_fill?.(item.id, idc)
        }
        // both halves of every toggle: the visible span and the revealed div, paired by id class
        const halves = [...(content?.querySelectorAll('span.template_toggle') ?? [])].map(s => {
          const idc = [...s.classList].find(c => c.startsWith('id_')) ?? ''
          const div = idc ? content.querySelector('div.template_toggle.' + idc) : null
          return {
            idc,
            spanOwner: owner(s),
            divOwner: div ? owner(div) : null,
            inVault: !!s.closest('.vault') && !!div?.closest('.vault'),
            labelHasBlock: !!s.querySelector('pre'),
            hidden: div?.classList.contains('hidden') ?? null,
            handlerLeak: (div?.textContent ?? '').includes('classList.toggle'),
            label: s.textContent ?? '',
          }
        })
        return {
          id: item.id,
          rendered: content?.textContent ?? '',
          containers: content?.querySelectorAll('.vault').length ?? 0,
          // every block carrier sits under a .vault ancestor (checked outward from the carrier)
          carriersOutsideVault: [...(content?.querySelectorAll('pre code') ?? [])].filter(c => !c.closest('.vault')).length,
          codeText: [...(content?.querySelectorAll('pre code') ?? [])].map(c => c.textContent ?? ''),
          // the badge is the placeholder span titled by vault_badge()
          badge: item.elem?.querySelector('[title="managed by the vault sync"]')?.textContent ?? '',
          carrierChildElements: [...(content?.querySelectorAll('pre code *') ?? [])].length,
          togglesInPre: [...(content?.querySelectorAll('pre .template_toggle') ?? [])].length,
          halves,
          // the expanded context (agent/chat.js: eval_macros with context 'expanded'): both macros
          // return plain text there (the removed blocks are the app's later pass, not the macros'),
          // or the render throws for an item without standalone context (presentation design 7.6)
          expanded: (() => {
            try {
              return String((item as any).eval_macros('<<vault_badge()>> <<vault_render()>>', { context: 'expanded' }))
            } catch (error) {
              return 'THROWN ' + String((error as Error).message ?? error)
            }
          })(),
        }
      }, name)
      expect(r.containers, `${file}: rendered under a .vault container`).toBeGreaterThan(0)
      expect(r.carriersOutsideVault, `${file}: every carrier has a .vault ancestor`).toBe(0)
      expect(r.codeText, `${file}: the editable source is the editor's, never a carrier`).not.toContain(source)
      expect(r.badge, `${file}: the live badge compares the source with the stored snapshot`).toBe(expectedBadge)
      expect(r.carrierChildElements, `${file}: carriers hold text only`).toBe(0)
      expect(r.togglesInPre, `${file}: no toggle inside a pre`).toBe(0)
      expect(r.halves.map(t => t.label), `${file}: no source control`).not.toContain('⋮ source')
      if (store.head_preview) expect(r.halves.length, `${file}: at least the navigation toggle`).toBeGreaterThan(0)
      else expect(r.rendered, `${file}: a null preview renders its placeholder`).toContain('no pinned preview (not in the stored sync snapshot)')
      for (const t of r.halves) {
        expect(t.divOwner, `${file}: toggle ${t.idc} has a revealed div bound to the outer item`).toBe(r.id)
        expect(t.spanOwner, `${file}: toggle ${t.idc} span bound to the outer item`).toBe(r.id)
        expect(t.inVault, `${file}: toggle ${t.idc} halves have a .vault ancestor`).toBe(true)
        expect(t.labelHasBlock, `${file}: toggle ${t.idc} label carries no block carrier`).toBe(false)
        expect(t.hidden, `${file}: toggle ${t.idc} starts collapsed`).toBe(true)
        expect(t.handlerLeak, `${file}: toggle ${t.idc} leaks no handler text into content`).toBe(false)
      }
      expect(r.expanded, `${file}: expanded context carries no markup`).not.toMatch(/<(div|span|pre|code)\b/)
      expect(r.expanded, `${file}: expanded context never carries the editable source`).not.toContain(source.trim())
      const h = store.head_preview
      if (!h) expect(r.expanded, `${file}: no pinned preview throws in the expanded context`).toContain('THROWN vault: no pinned preview')
      else if (h.kind == 'section') expect(r.expanded, `${file}: a section throws in the expanded context`).toContain('THROWN vault: a section carries no standalone context')
      else if (h.exact.instructions === null) expect(r.expanded, `${file}: null pinned instructions throw in the expanded context`).toContain('THROWN vault: the pinned instructions are null')
      else expect(r.expanded, `${file}: a config's expanded context is its pinned instructions`).not.toContain('THROWN')
    }
    // current-item identity, browser form: the config (A) nests the section (B); A's DOM shows
    // B-unique navigation output (from _this = B) with every toggle bound to A (asserted above),
    // and never B's source (a nested child returns only its navigation composition)
    const A = nameOf(fixture('e2e_config.md'))
    const B = nameOf(fixture('e2e_section.md'))
    const sectionSource = unescape(block(fixture('e2e_section.md'), 'jinja_removed'))
    await show(A)
    const nested = await carriers(A)
    expect(nested.some(t => t.replace(/\s+/g, '').startsWith('DocsB')), 'B-unique navigation rendered under A (as inert markdown: the emphasis element, then the B branch)').toBe(true)
    expect(nested, 'B source never rendered under A').not.toContain(sectionSource)
    // a nested toggle opens on its span and closes on its revealed div (both handlers bound to A)
    const nestedToggle = await page.evaluate(n => {
      const content = window._item(n, true)!.elem?.querySelector('.content') as HTMLElement
      const span = [...content.querySelectorAll('span.template_toggle')].find(s => (s.textContent ?? '').includes('![[agents/e2e_section]]'))
      return span ? ([...span.classList].find(c => c.startsWith('id_')) ?? null) : null
    }, A)
    expect(nestedToggle, 'the nested section toggle exists under A').toBeTruthy()
    const hiddenState = () => page.evaluate(idc => document.querySelector('div.template_toggle.' + idc)?.classList.contains('hidden') ?? null, nestedToggle!)
    // programmatic clicks: a real mouse click also starts editing the item, which is not the
    // toggle contract under test and would leave editing state behind
    const clickToggle = (sel: string) => page.evaluate(sel => (document.querySelector(sel) as HTMLElement).click(), sel)
    await clickToggle('span.template_toggle.' + nestedToggle)
    await expect.poll(hiddenState, { timeout: 5_000 }).toBe(false)
    await clickToggle('div.template_toggle.' + nestedToggle)
    await expect.poll(hiddenState, { timeout: 5_000 }).toBe(true)
    // no rescan: the nested item's marker-shaped text part renders as inert markdown (the reference a
    // tag link showing the path, never a nested toggle or template call; presentation design section 7)
    await show(nameOf(fixture('e2e_nested.md')))
    const nestedTexts = await carriers(nameOf(fixture('e2e_nested.md')))
    expect(nestedTexts.some(t => t.replace(/\s+/g, '') == 'agents/e2e_section'), 'marker-shaped text part rendered as the tag link text').toBe(true)
    expect(nestedTexts, 'never carried as the raw marker').not.toContain('\n![[agents/e2e_section]]\n')

    await test.step('projection text corpus: inert markdown, grammar characters as text', async () => {
      // section 3's corpus, rendered as inert markdown since the presentation design's section 7: the exact
      // fields carry the empty and leading/terminal-LF cases, navigation text parts (separated by a target so
      // they are never adjacent) carry the rest; grammar characters stay text, the URL is a plain anchor with
      // its exact destination, the code span is a code element, the rule is a rule, nothing becomes an app
      // tag, macro, or math
      const corpus = ['\n\nlead', 'trail\n\n', '&lt;', '😀 ünï é', '---', 'https://example.com/x?y=1', '#tag', '`code`', '<path>', '  padded  ', 'a\n\nb', 'a\tb']
      const navigation = corpus.flatMap(text => [{ text }, { target: 'agents/e2e_worker.md' }])
      const store = storeOf('agents/e2e_corpus.md', 'corpus\n', { kind: 'config', navigation, base: null, exact: { profile: 'bare', instructions: '', run_instructions: '\nlead', user_prompt: 'trail\n' } })
      await create(itemText('agents/e2e_corpus.md', 'corpus\n', ['agents/e2e_worker.md']))
      await setStore(label('agents/e2e_corpus.md'), store)
      await show(label('agents/e2e_corpus.md'))
      await expect.poll(() => badgeOf(label('agents/e2e_corpus.md')), { timeout: 30_000 }).toBe('config')
      await fillProjection(label('agents/e2e_corpus.md'))
      const got = await page.evaluate(n => {
        const content = window._item(n, true)!.elem?.querySelector('.content') as HTMLElement
        const views = [...content.querySelectorAll('.vault .vault-source')] as HTMLElement[]
        const text = views.map(v => (v.textContent ?? '').replace(/\s+/g, ' ').trim())
        return {
          text,
          anchors: views.flatMap(v => [...v.querySelectorAll('a')].map(a => a.getAttribute('href'))),
          codes: views.flatMap(v => [...v.querySelectorAll('code')].map(c => c.textContent)),
          rules: views.reduce((n, v) => n + v.querySelectorAll('hr').length, 0),
          marks: views.reduce((n, v) => n + v.querySelectorAll('mark, span.math, input, script').length, 0),
          headings: views.reduce((n, v) => n + v.querySelectorAll('h1, h2, h3').length, 0),
        }
      }, label('agents/e2e_corpus.md'))
      for (const text of ['lead', 'trail', '<', '😀 ünï é', 'https://example.com/x?y=1', '#tag', 'code', '<path>', 'padded', 'a b', 'a\tb'.replace(/\s+/g, ' ')])
        expect.soft(got.text, `projection text ${JSON.stringify(text)} is present as text`).toContain(text)
      expect.soft(got.anchors, 'the bare URL is a plain anchor with its exact destination').toEqual(['https://example.com/x?y=1'])
      expect.soft(got.codes, 'the code span is a code element; the literal tag placeholder is inline code too (presentation design 8.2)').toEqual(['code', '<path>'])
      expect.soft(got.rules, 'the rule is a rule, not a setext heading').toBe(1)
      expect.soft(got.headings, 'no heading from the rule').toBe(0)
      expect.soft(got.marks, 'no app tag mark, math, checkbox, or script from the corpus').toBe(0)
    })

    await test.step('rejected stores and envelopes fail closed', async () => {
      // stores that fail the observable contract: a control, a C1 character, a lone surrogate,
      // and a delimiter in a text part; a store naming another item's path; a missing store;
      // and a leftover v1 payload block in the text
      const badStores: [string, unknown][] = [
        ['agents/e2e_bad_control.md', storeOf('agents/e2e_bad_control.md', 'bad\n', { kind: 'section', navigation: [{ text: 'a\u0000b' }], base: null, exact: null })],
        ['agents/e2e_bad_c1.md', storeOf('agents/e2e_bad_c1.md', 'bad\n', { kind: 'section', navigation: [{ text: 'a\u0080b' }], base: null, exact: null })],
        ['agents/e2e_bad_surrogate.md', storeOf('agents/e2e_bad_surrogate.md', 'bad\n', { kind: 'section', navigation: [{ text: 'a\ud800b' }], base: null, exact: null })],
        ['agents/e2e_bad_delimiter.md', storeOf('agents/e2e_bad_delimiter.md', 'bad\n', { kind: 'section', navigation: [{ text: 'x<!-- /template -->y' }], base: null, exact: null })],
        // an otherwise VALID store (null preview) naming another item's path
        ['agents/e2e_bad_label.md', storeOf('agents/e2e_worker.md', null, null)],
        // a v1 payload object under the key
        ['agents/e2e_bad_v1.md', { v: 1, path: 'agents/e2e_bad_v1.md', source_head_relation: 'matches', head_preview: { kind: 'section', navigation: [], base: null, exact: null } }],
      ]
      const failed = (p: string) =>
        page.evaluate(n => {
          const item = window._item(n, true)!
          const content = item.elem?.querySelector('.content') as HTMLElement
          return { badge: item.elem?.querySelector('[title="managed by the vault sync"]')?.textContent ?? '', rendered: content?.textContent ?? '', containers: content?.querySelectorAll('.vault').length ?? 0 }
        }, label(p))
      for (const [p, store] of badStores) {
        await create(itemText(p, 'bad\n', []))
        await setStore(label(p), store)
        await show(label(p))
        await expect.poll(() => badgeOf(label(p)), { timeout: 30_000 }).toBe('vault store invalid')
        const r = await failed(p)
        expect.soft(r.badge, `${p}: badge fails closed`).toBe('vault store invalid')
        expect.soft(r.containers, `${p}: no composition`).toBe(0)
        expect.soft(r.rendered, `${p}: no partial interpretation`).not.toMatch(/a.b|x.y|e2e_worker\.md/)
      }
      await create(itemText('agents/e2e_no_store.md', 'bad\n', []))
      await show(label('agents/e2e_no_store.md'))
      await expect.poll(() => badgeOf(label('agents/e2e_no_store.md')), { timeout: 30_000 }).toBe('vault store missing')
      let r = await failed('agents/e2e_no_store.md')
      expect.soft(r.badge, 'a missing store fails closed').toBe('vault store missing')
      expect.soft(r.containers, 'a missing store composes nothing').toBe(0)
      const v1Text = itemText('agents/e2e_v1_text.md', 'bad\n', []).replace('<!-- template -->', '```vault_removed\nYQ==\n```\n<!-- template -->')
      await create(v1Text)
      await setStore(label('agents/e2e_v1_text.md'), storeOf('agents/e2e_v1_text.md', null, null))
      await show(label('agents/e2e_v1_text.md'))
      await expect.poll(() => badgeOf(label('agents/e2e_v1_text.md')), { timeout: 30_000 }).toBe('vault source invalid')
      r = await failed('agents/e2e_v1_text.md')
      expect.soft(r.badge, 'a leftover v1 payload block fails closed').toBe('vault source invalid')
      expect.soft(r.containers, 'a leftover v1 payload block composes nothing').toBe(0)
    })

    // the timed forced-remount record is a phase-2 attended procedure (design section 8): the
    // app keeps a programmatically rendered root mounted across hash navigation in a
    // history-dependent way, so an unmounted-root precondition could not be made stable here
    // a nested render reads the child's CURRENT store: after B's store changes and A is forced to
    // render, A's nested composition shows the new text (no stale nested cache through template();
    // store-driven propagation without a forced render is the personal-account row's contract)
    const bStore = JSON.parse(JSON.stringify(stores[files.indexOf('e2e_section.md')]))
    bStore.head_preview.navigation[0].text = '**Docs**\nB (edited)\n'
    await show(A)
    await setStore(B, bStore)
    await page.evaluate(n => void (window._item(n) as any).invalidate_elem_cache({ force_render: true, render_delay: 0 }), A)
    await expect.poll(async () => (await carriers(A)).some(t => t.replace(/\s+/g, '').startsWith('DocsB(edited)')), { timeout: 30_000 }).toBe(true)

    // HARD: missing-to-created recovery -- deleting a dependency makes the app's dependency
    // resolution fail before vault_render() runs (raw text, no composition); recreating it
    // (after its durable absence, so no two documents ever share the label) and reading A again
    // recovers the composition
    const worker = nameOf(fixture('e2e_worker.md'))
    const workerLocalId = (await localIdOf(worker)) as string
    await remove(workerLocalId, await savedIdOfId(workerLocalId))
    await expect
      .poll(
        () =>
          page.evaluate(n => {
            const item = window._item(n, true)!
            const error = String((window as any).__items[(item as any).index]?.expanded?.error?.message ?? '')
            return { containers: item.elem?.querySelectorAll('.vault').length ?? -1, missing: error.startsWith('eval missing dependencies') }
          }, A),
        { timeout: 30_000 }
      )
      .toEqual({ containers: 0, missing: true })
    await create(fixture('e2e_worker.md'))
    await setStore(worker, stores[files.indexOf('e2e_worker.md')])
    await show(worker)
    await expect.poll(() => badgeOf(worker), { timeout: 30_000 }).toBe('config')
    await show(A)
    await expect.poll(async () => (await carriers(A)).some(t => t.replace(/\s+/g, '').startsWith('DocsB(edited)')), { timeout: 30_000 }).toBe(true)

    // the cleanup path must recover a killed run's duplicate labels: two saved items under one
    // synthetic label (their names become id:<local-id>), both documents durably gone afterwards
    await test.step('duplicate-label cleanup', async () => {
      const dup = itemText('agents/e2e_dup.md', 'dup\n', [])
      const first = await create(dup)
      const second = await create(dup)
      expect(await page.evaluate(([a, b]) => [window._item(a, true)?.name, window._item(b, true)?.name], [first.id, second.id] as const), 'duplicate labels renamed').toEqual([`id:${first.id}`, `id:${second.id}`])
      const removed = await clean()
      expect(removed, 'both duplicates were addressed').toEqual(expect.arrayContaining([first.saved, second.saved]))
      await absent([first.saved, second.saved])
    })
  } finally {
    await clean()
  }
})
