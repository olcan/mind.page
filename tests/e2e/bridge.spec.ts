// e2e witnesses for the INERT reply boundary (design: vault notes/design/mind_bridge_v2.md).
// The v0/v1 PoC listener rows and their bin/mind_bridge.py spawn setup were retired with the
// legacy executor (review 189 §2.2): end-to-end Python dispatch evidence lives in the vault's
// Firestore-emulator component smoke and the recorded attended production canary. What remains
// here are the APP-side witnesses: hostile render classification, read/render domain
// separation, startup/run opacity, and decoded-body search.
// Request items carry a unique test-owned visible label plus a hidden #_agent/vault routing
// tag (the real /vault request shape); a second visible #agent/vault label would make
// _item(name, true) return null on the ambiguity.
import { expect, test } from '@playwright/test'
import {
  FAKE_GITHUB_TOKEN,
  firestore,
  historyRecords,
  install,
  itemRecord,
  loadAdmin,
  readItemState,
  waitForApp,
  waitWritesSettled,
} from './helpers.js'
import { focusMindbox, mindbox, savedId, visible } from './editor_helpers.js'

test('a canonical reply renders as inert markdown: structure, admitted links, literal grammar', async ({ page }) => {
  // design §2.2a amended 2026-09-05 (owner): the dead frame shows the decoded body as Markdown
  // STRUCTURE under the vault renderer's policy (src/inert_markdown.ts), assigned by innerHTML;
  // the app's own Markdown, macro, tag and url passes never see the decoded bytes
  await loadAdmin(page)
  const body = [
    '## Findings',
    '',
    '- first `#not_a_tag`',
    '- [docs](https://example.com/x?a=1&b=2)',
    '- [bad](javascript:window._pwned=9)',
    '',
    'Plain <<not_a_macro>> and #not_a_tag text.',
    '',
    '```js',
    'const x = 1 // note',
    '```',
  ].join('\n')
  await page.evaluate(
    body =>
      void window._create(
        "#e2e_inert_md reply\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n<!--inert-->\n" + body + '\n<!--/inert-->'
      ),
    body
  )
  await page.evaluate(() => void (location.hash = '#e2e_inert_md'))
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_inert_md', true)?.elem?.querySelector('.vault-result h2')), { timeout: 15_000 }).toBe(true)
  const shape = await page.evaluate(() => {
    const frame = window._item('#e2e_inert_md', true)!.elem!.querySelector('.vault-result')!
    const item = window._item('#e2e_inert_md', true) as any
    return {
      heading: frame.querySelector('h2')?.textContent,
      items: frame.querySelectorAll('li').length,
      anchors: [...frame.querySelectorAll('a')].map(a => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]),
      text: frame.textContent ?? '',
      code: frame.querySelector('pre code')?.textContent,
      marks: frame.querySelectorAll('mark').length, // no tag links from the frame's text
      pwned: (window as any)._pwned ?? null,
      tags: (item?.tags ?? []).join(' '),
    }
  })
  expect(shape.heading).toBe('Findings')
  expect(shape.items).toBe(3)
  expect(shape.anchors, 'only the https link is an anchor, with noopener; javascript: is shown as text').toEqual([
    ['https://example.com/x?a=1&b=2', '_blank', 'noopener'],
  ])
  expect(shape.text).toContain('bad (javascript:window._pwned=9)')
  // a REAL click inside the frame (mousedown, mouseup, click: the item's click handler rejects a
  // click without a recent mousedown) opens no editor (the owner, 2026-09-27); the frame's text
  // stays selectable and its links wired as before. The click is the block's (src/inert_blocks.ts: a
  // click anywhere on a section toggles its block, the owner, 2026-11-20): it closes the reply that
  // stood open in its selected item
  const elemId = await page.evaluate(() => window._item('#e2e_inert_md', true)!.elem!.id)
  await page.locator(`[id="${elemId}"] .vault-result h2`).click()
  await page.waitForTimeout(300)
  expect(
    await page.evaluate(id => ({
      editing: !!document.querySelector(`[id="${id}"] textarea, .container.editing`),
      frame: !!document.querySelector(`[id="${id}"] .vault-result h2`),
      closed: !!document.querySelector(`[id="${id}"] .inert-block.closed`),
    }), elemId),
    'no editor after a click inside the inert frame, which closed its block'
  ).toEqual({ editing: false, frame: true, closed: true })
  expect(shape.text).toContain('<<not_a_macro>>')
  expect(shape.code).toBe('const x = 1 // note')
  expect(shape.marks).toBe(0)
  expect(shape.pwned).toBeNull()
  expect(shape.tags, 'a #tag inside the reply is not an item tag').not.toContain('#not_a_tag')
})

test("a canonical reply's TeX renders as the owner's math, typeset by a plain document of the frame's own under the app's filter", async ({ page }) => {
  // the owner (2026-10-04): a reply's `$`x`$` and `$$`x`$$` become the app's math spans in the frame
  // (src/inert_markdown.ts mathExtension), typeset by a MathJax document of the frame's own
  // (src/inert_math.ts; reviews 0-2): a plain document (no menu) with a fresh TeX parser per frame
  // over a bounded package set, and the app's own filter of the frame's MathML. Asserted here: the
  // forms typeset (inline and display); no anchor (`\href`), class (`\class`), id (`\cssId`),
  // style (`\style`, `\fcolorbox`'s border), font field serialized into css (`\mmlToken`'s
  // `fontfamily`, `fontweight`, `fontstyle`) or resource-bearing value (`\style{cursor:url(…)}`,
  // `\color{url(…)}`) in the output, a color name and a font command admitted, no context menu
  // attached; a frame's
  // `\def` holds within the frame and reaches neither the next frame of the same item nor the
  // owner's math; `\unicode` is undefined in a frame and the owner's `\unicode` renders as ever;
  // the owner's document has no safe filters and its `\Huge` keeps its size, its `\href` an anchor;
  // a frame whose extension load fails, and a frame whose typeset fails, stay text and marked, the
  // item counts as rendered (no loading overlay left on the page) and the next typesets work; a
  // plain `$x$` is text in a frame as it is in the owner's text
  await loadAdmin(page)
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  const turn = (body: string) => `<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert(body)}`
  const frames = (label: string) =>
    page.evaluate(label => {
      const elem = window._item(label, true)?.elem
      if (!elem) return null
      return [...elem.querySelectorAll('.vault-result')].map(frame => {
        const attrs = [...frame.querySelectorAll('*')].flatMap(e => [...e.attributes].map(a => `${a.name}=${a.value}`))
        return {
          inline: frame.querySelectorAll('span.math > mjx-container:not([display])').length,
          display: frame.querySelectorAll('span.math-display > mjx-container[display="true"]').length,
          containers: frame.querySelectorAll('mjx-container').length,
          menus: frame.querySelectorAll('mjx-container[ctxtmenu_counter], mjx-container.CtxtMenu_Attached_0').length,
          errors: frame.querySelectorAll('[data-mml-node="merror"], mjx-merror').length,
          anchors: frame.querySelectorAll('a').length,
          classed: frame.querySelectorAll('.boom, #pwn').length,
          fixed: attrs.filter(a => /fixed/.test(a)).length,
          urls: attrs.filter(a => /url\(/.test(a)).length,
          monospace: attrs.filter(a => /monospace/.test(a)).length,
          css: attrs.filter(a => /opacity|font-family|font-weight|font-style/.test(a)).length,
          red: frame.querySelectorAll('[fill="red"]').length,
          bold: frame.querySelectorAll('[id$="-1D41B"]').length, // the glyph of \mathbf{b}: mathematical bold small b, MathJax's variant, no font attribute
          // a glyph is a <use> of a cached <path> whose id ends in the code point (fontCache local)
          sums: frame.querySelectorAll('[id$="-2211"]').length,
          zeros: frame.querySelectorAll('[id$="-30"]').length,
          failed: frame.querySelectorAll('span.math[_rendered="failed"]').length,
          text: [...frame.querySelectorAll('p')].map(p => p.textContent).join('\n'),
        }
      })
    }, label)
  // the FIRST frame with math on the page loads the frames' extensions: a load that fails (forced
  // here at the module's call: the loader made to reject once, which bypasses MathJax's package
  // loader; a package the loader itself failed stays failed until the page reloads) fails that
  // frame alone, marked, its TeX text, and the next frame loads again and typesets
  await page.evaluate(() => {
    const loader = (window as any).MathJax.loader
    const load = loader.load
    loader.load = function () {
      loader.load = load
      return Promise.reject(new Error('e2e: a forced extension load failure'))
    }
  })
  await page.evaluate(text => void window._create(text), `#e2e_inert_math_load reply\n${turn('unloadable $`x`$ math')}`)
  await page.evaluate(() => void (location.hash = '#e2e_inert_math_load'))
  await expect.poll(() => frames('#e2e_inert_math_load').then(f => f?.[0]?.failed ?? -1), { timeout: 15_000 }).toBe(1)
  expect((await frames('#e2e_inert_math_load'))![0]).toMatchObject({ containers: 0, failed: 1 })
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.loading.visible')), { timeout: 15_000 }).toBe(false)
  const first = [
    'inline $`x^2`$ and display:',
    '',
    '$$`\\sum_{i=1}^n x_i`$$',
    '',
    'plain $y$ costs $5; a link $`\\href{javascript:window._pwned=7}{link}`$ and a box $`\\fcolorbox{red;position:fixed;top:0;left:0}{white}{x}`$',
    '',
    'html-package attributes $`\\class{boom}{y}`$ $`\\cssId{pwn}{w}`$ $`\\style{position:fixed;top:0}{z}`$',
    '',
    'resource-bearing values $`\\style{cursor:url(https://example.invalid/cursor.svg),auto}{x}`$ $`\\color{url(https://example.invalid/paint.svg#p)}x`$ and a name $`\\textcolor{red}{r}`$',
    '',
    'an undefined macro $`\\unicode[monospace]{65}`$ and a definition $`\\def\\sum{0}`$ used in its frame: $`\\sum_i`$',
    '',
    'font fields serialized into css $`\\mmlToken{mi}[fontfamily="serif; opacity: 0.5"]{x}`$ $`\\mmlToken{mi}[fontfamily="serif",fontweight="normal; opacity: 0.5"]{x}`$ $`\\mmlToken{mi}[fontfamily="serif",fontstyle="normal; opacity: 0.5"]{x}`$ and a font command $`\\mathbf{b}`$',
  ].join('\n')
  const second = 'the next reply: $`\\sum_{i=1}^n x_i`$'
  await page.evaluate(text => void window._create(text), `#e2e_inert_math reply\n${turn(first)}\n${turn(second)}`)
  await page.evaluate(() => void (location.hash = '#e2e_inert_math'))
  await expect.poll(() => frames('#e2e_inert_math').then(f => f?.map(x => x.containers).join(',') ?? ''), { timeout: 20_000 }).toBe('17,1')
  const [one, two] = (await frames('#e2e_inert_math'))!
  expect(one, 'the first frame: sixteen inline results and the display one, nothing of the policy breached, no menu').toMatchObject({
    inline: 16,
    display: 1,
    menus: 0,
    errors: 0,
    anchors: 0,
    classed: 0,
    fixed: 0,
    urls: 0,
    monospace: 0,
    css: 0,
    failed: 0,
  })
  expect(one.red, 'a color name is admitted').toBeGreaterThan(0)
  expect(one.bold, "a font command renders through MathJax's variants").toBeGreaterThan(0)
  expect(one.sums, "the display sum, typeset before the frame's definition, is the summation operator").toBeGreaterThan(0)
  expect(one.zeros, "the frame's own definition applies to its later formula").toBeGreaterThan(0)
  expect(one.text).toContain('plain $y$ costs $5')
  expect(two, 'the next frame of the same item starts from a fresh parser: the definition did not reach it').toMatchObject({
    containers: 1,
    errors: 0,
    zeros: 0,
  })
  expect(two.sums).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any)._pwned ?? null)).toBeNull()
  // the owner's math typeset after the frames: the summation operator, never a frame's 0; the
  // owner's \href an anchor, its \unicode as ever (no monospace from the frame), its \Huge about
  // two and a half times the plain x (no size clamp: the page's document carries no safe filters,
  // and the safe extension is not even loaded, so no recreation of the page's document could add one)
  await page.evaluate(
    text => void window._create(text),
    '#e2e_owner_math owner $`\\sum_{i=1}^n x_i`$ and $`\\href{https://example.com/m}{m}`$ and $`\\unicode{65}`$ and $`x`$ and $`\\Huge x`$'
  )
  await page.evaluate(() => void (location.hash = '#e2e_owner_math'))
  const owner = () =>
    page.evaluate(() => {
      const elem = window._item('#e2e_owner_math', true)?.elem
      if (!elem) return null
      const heights = [...elem.querySelectorAll('mjx-container > svg')].map(svg => parseFloat(svg.getAttribute('height') ?? '0'))
      return {
        containers: elem.querySelectorAll('mjx-container').length,
        sums: elem.querySelectorAll('[id$="-2211"]').length,
        zeros: elem.querySelectorAll('[id$="-30"]').length,
        anchors: [...elem.querySelectorAll('mjx-container a')].map(a => a.getAttribute('href')),
        monospace: [...elem.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /monospace/.test(a.value))).length,
        hugeRatio: heights[4] / heights[3],
        safe: typeof (window as any).MathJax.startup.document.safe,
        safeLoaded: !!(window as any).MathJax._.ui?.safe,
        startupTypeset: (window as any).MathJax.config.startup.typeset,
      }
    })
  await expect.poll(() => owner().then(o => o?.containers ?? -1), { timeout: 15_000 }).toBe(5)
  const o = (await owner())!
  expect(o).toMatchObject({ zeros: 0, anchors: ['https://example.com/m'], monospace: 0, safe: 'undefined', safeLoaded: false, startupTypeset: false })
  expect(o.sums, "the owner's sum is the summation operator").toBeGreaterThan(0)
  expect(o.hugeRatio, "the owner's \\Huge is unclamped").toBeGreaterThan(2)
  // a frame whose typeset fails (an internal error, forced here: the TeX constructor the module
  // instantiates, the startup's registry entry, made to throw for as long as the failing item is
  // on the page: a re-render retries a frame, and would succeed with the real constructor) keeps
  // its TeX as text and its mark, the item counts as rendered (no loading overlay intercepting
  // the page), and once the constructor is back the owner's next math typesets
  await page.evaluate(() => {
    const constructors = (window as any).MathJax.startup.constructors
    ;(window as any).__e2e_tex = constructors.tex
    constructors.tex = function () {
      throw new Error('e2e: a forced typeset failure')
    }
  })
  await page.evaluate(text => void window._create(text), `#e2e_inert_math_fail reply\n${turn('failing $`x`$ math')}`)
  await page.evaluate(() => void (location.hash = '#e2e_inert_math_fail'))
  await expect.poll(() => frames('#e2e_inert_math_fail').then(f => f?.[0]?.failed ?? -1), { timeout: 15_000 }).toBe(1)
  const failed = (await frames('#e2e_inert_math_fail'))![0]
  expect(failed).toMatchObject({ containers: 0, failed: 1 })
  expect(failed.text, 'the TeX stays text').toContain('$x$')
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.loading.visible')), { timeout: 15_000 }).toBe(false)
  await page.evaluate(() => void ((window as any).MathJax.startup.constructors.tex = (window as any).__e2e_tex))
  await page.evaluate(text => void window._create(text), '#e2e_owner_math2 owner $`\\sum_{i=1}^n x_i`$')
  await page.evaluate(() => void (location.hash = '#e2e_owner_math2'))
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_owner_math2', true)?.elem?.querySelectorAll('[id$="-2211"]').length ?? 0), { timeout: 15_000 })
    .toBeGreaterThan(0)
})

test("a reply's typeset math survives the item's re-renders through the element cache: navigating the children typesets nothing again", async ({ page }) => {
  // the owner (2026-10-05): every formula of a reply was typeset again, with a visible flicker and reflow,
  // on changes as small as navigating a chat's children with the arrow keys (a query change re-renders the
  // item's html, frames included). The element cache (wrapMath's `_cache_key`, cacheElems) puts a typeset
  // span back in place of the fresh one, but a frame's spans carried no key; now they do (the frame fill):
  // the same nodes, no new TeX parser, no typeset call, for the frame's and the owner's formulas alike.
  // The chat's macros evaluate without error here (a stub defines them: the lane has no #chat), as a
  // production chat's do; an undefined macro's eval would invalidate the item's whole element cache, as
  // any code error does, and no formula would survive (the row's first cut in this lane)
  await loadAdmin(page)
  const CHAT = '#e2e_mc'
  const DEFS = '#e2e_mcdefs'
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  await page.evaluate(text => void window._create(text), `${DEFS} the chat delimiters, as values\n\`\`\`js\nconst user = ''\nconst agent = (...args) => ''\n\`\`\``)
  const child = (name: string) => `${CHAT}/${name} #_e2e_mcdefs\n<<agent('vault/default · run ab12cd34')>>\n${inert(`${name} body`)}`
  await page.evaluate(text => void window._create(text), child('a'))
  await page.evaluate(text => void window._create(text), child('b'))
  await page.evaluate(
    text => void window._create(text),
    `${CHAT} #_e2e_mcdefs chat with $\`y_0\`$ in the owner's text\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert('see #/a and #/b, with $`x^2`$ and\n\n$$`\\sum_{i=1}^n x_i`$$')}`
  )
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), CHAT)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  await expect.poll(query).toMatch(/^#e2e_mc ?$/)
  const counts = () =>
    page.evaluate(label => {
      const elem = window._item(label, true)?.elem
      const frame = elem?.querySelector('.vault-result')
      return {
        frame: frame?.querySelectorAll('mjx-container').length ?? 0,
        owner: elem ? [...elem.querySelectorAll('mjx-container')].filter(c => !c.closest('.vault-result')).length : 0,
        marks: frame?.querySelectorAll('mark[data-tag]').length ?? 0,
        errors: elem?.querySelectorAll('.macro-error').length ?? -1,
      }
    }, CHAT)
  await expect.poll(() => counts().then(c => `${c.frame},${c.owner},${c.marks},${c.errors}`), { timeout: 20_000 }).toBe('2,1,2,0')
  // the typeset nodes remembered, and the two typeset entry points and the item's cache invalidation
  // counted from here on
  await page.evaluate(label => {
    const w = window as any
    const elem = window._item(label, true)!.elem!
    const frame = elem.querySelector('.vault-result')!
    w.__mc = {
      frame,
      frameMath: [...frame.querySelectorAll('mjx-container')],
      ownerMath: [...elem.querySelectorAll('mjx-container')].filter(c => !c.closest('.vault-result')),
      tex: 0,
      typesets: 0,
      invalidations: 0,
    }
    // every _item() call hands out a FROZEN instance (index.svelte _item): the counter goes on the class
    const item = window._item(label, true)! as any
    const proto = Object.getPrototypeOf(item)
    const invalidate = proto.invalidate_elem_cache
    proto.invalidate_elem_cache = function (this: any, ...args: unknown[]) {
      if (this.id === item.id) w.__mc.invalidations++
      return invalidate.apply(this, args)
    }
    const constructors = w.MathJax.startup.constructors
    const TeX = constructors.tex
    constructors.tex = function (...args: unknown[]) {
      w.__mc.tex++
      return new TeX(...args)
    }
    const typesetPromise = w.MathJax.typesetPromise
    w.MathJax.typesetPromise = (...args: unknown[]) => {
      w.__mc.typesets++
      return typesetPromise(...args)
    }
  }, CHAT)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  // Down enters the first child, Right the next: two query changes, two re-renders of the chat item
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe('#e2e_mc/a ')
  await page.keyboard.press('ArrowRight')
  await expect.poll(query).toBe('#e2e_mc/b ')
  const after = () =>
    page.evaluate(label => {
      const w = window as any
      const elem = window._item(label, true)!.elem!
      const frame = elem.querySelector('.vault-result')!
      const frameMath = [...frame.querySelectorAll('mjx-container')]
      const ownerMath = [...elem.querySelectorAll('mjx-container')].filter(c => !c.closest('.vault-result'))
      return {
        frameRerendered: frame !== w.__mc.frame, // the premise: the item's html was re-rendered, the frame with it
        frameSame: frameMath.length === w.__mc.frameMath.length && frameMath.every((c, i) => c === w.__mc.frameMath[i] && c.isConnected),
        ownerSame: ownerMath.length === w.__mc.ownerMath.length && ownerMath.every((c, i) => c === w.__mc.ownerMath[i] && c.isConnected),
        tex: w.__mc.tex,
        typesets: w.__mc.typesets,
        invalidations: w.__mc.invalidations,
        selected: [...frame.querySelectorAll('mark[data-tag]')].map(m => m.classList.contains('selected')),
      }
    }, CHAT)
  await expect.poll(() => after().then(a => a.selected.join(',')), { message: 'the second child\'s mark selected' }).toBe('false,true')
  const a = await after()
  expect(a.frameRerendered, 'the frame was re-rendered by the navigation (the premise)').toBe(true)
  expect(a.invalidations, "the navigation ran no code that invalidates the item's element cache (the premise)").toBe(0)
  expect([a.frameSame, a.ownerSame], "the frame's and the owner's typeset nodes are the same, connected nodes").toEqual([true, true])
  expect([a.tex, a.typesets], 'no new TeX parser, no typeset call').toEqual([0, 0])
})

test("an edited reply re-typesets its frame's math as a whole: a definition edit reaches its use and a use edit keeps the definition, the reply's other frame untouched", async ({ page }) => {
  // inert_math_cache review 0 B1: a frame's formulas are typeset together by a parser of the frame's own,
  // so a definition in one formula reaches the formulas after it. A key per formula (the row's first cut)
  // left a use's cached typeset in place when only the definition was edited, and typeset an edited use
  // without the cached definition (the reviewer's reproduction); the key is the frame's whole body, so an
  // edit to any of a frame's formulas re-typesets the frame's math together, while the reply's other frame
  // keeps its typeset nodes. The edit is the editor's save (Shift+Enter, no run), which invalidates
  // nothing: the keys alone decide
  await loadAdmin(page)
  const LABEL = '#e2e_mc_edit'
  const DEFS = '#e2e_mcdefs2'
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  await page.evaluate(text => void window._create(text), `${DEFS} the chat delimiters, as values\n\`\`\`js\nconst user = ''\nconst agent = (...args) => ''\n\`\`\``)
  const text = (def: string, use: string) =>
    `${LABEL} #_e2e_mcdefs2 reply\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert(`$\`\\def\\sum{${def}}\`$ then $\`\\sum_${use}\`$`)}\n\nand\n\n${inert('$`\\sum_k`$')}`
  await page.evaluate(text => void window._create(text), text('0', 'i'))
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), LABEL)
  // the glyph defs of a frame's typeset (fontCache 'local': one <path> per glyph per container):
  // the digits, the summation sign and the italic subscripts
  const glyphs = (frameIndex: number) =>
    page.evaluate(
      ([label, i]) => {
        const frame = window._item(label, true)?.elem?.querySelectorAll('.vault-result')[i]
        const count = (suffix: string) => frame?.querySelectorAll(`[id$="-${suffix}"]`).length ?? -1
        return {
          pending: frame?.querySelectorAll('span.math:not([_rendered]), span.math-display:not([_rendered])').length ?? -1,
          zeros: count('30'),
          ones: count('31'),
          sums: count('2211'),
          i: count('1D456'),
          j: count('1D457'),
          k: count('1D458'),
        }
      },
      [LABEL, frameIndex] as const
    )
  const rendered = (def: 0 | 1, use: 'i' | 'j') => ({ pending: 0, zeros: def == 0 ? 1 : 0, ones: def == 1 ? 1 : 0, sums: 0, i: use == 'i' ? 1 : 0, j: use == 'j' ? 1 : 0, k: 0 })
  await expect.poll(() => glyphs(0), { timeout: 20_000 }).toEqual(rendered(0, 'i'))
  await expect.poll(() => glyphs(1)).toEqual({ pending: 0, zeros: 0, ones: 0, sums: 1, i: 0, j: 0, k: 1 }) // the definition stays in its frame
  const otherFrame = () =>
    page.evaluate(label => {
      const w = window as any
      const container = window._item(label, true)!.elem!.querySelectorAll('.vault-result')[1].querySelector('mjx-container')!
      const same = w.__mcOther ? container === w.__mcOther && container.isConnected : null
      w.__mcOther = container
      return same
    }, LABEL)
  await otherFrame() // remembered
  // the editor's save with the text changed: the use only, then the definition only
  const edit = async (def: string, use: string) => {
    const id = await page.evaluate(label => window._item(label, true)!.id, LABEL)
    const paragraph = page.locator(`#item-${id} p`).first()
    const box = (await paragraph.boundingBox())!
    await paragraph.click({ position: { x: box.width / 2, y: box.height / 2 } })
    const textarea = page.locator(`#textarea-${id}`)
    await expect(textarea).toBeVisible()
    await textarea.fill(text(def, use))
    await page.keyboard.press('Shift+Enter') // save, no run
    await expect(textarea).toBeHidden()
  }
  await edit('0', 'j')
  await expect.poll(() => glyphs(0), { timeout: 20_000 }).toEqual(rendered(0, 'j')) // the definition applies to the edited use
  expect(await otherFrame(), "the other frame's typeset node survives the edit").toBe(true)
  await edit('1', 'j')
  await expect.poll(() => glyphs(0), { timeout: 20_000 }).toEqual(rendered(1, 'j')) // the edited definition reaches the unchanged use
  expect(await otherFrame(), "the other frame's typeset node survives the second edit").toBe(true)
  await expect.poll(() => glyphs(1)).toEqual({ pending: 0, zeros: 0, ones: 0, sums: 1, i: 0, j: 0, k: 1 })
})

test("the owner's math typeset before a reply frame's is marked at once: a re-render while the frame's typeset waits keeps it, no delimiters are inserted around rendered output", async ({ page }) => {
  // the owner (2026-10-05, after inert_math_cache): "all inline math rendered with double dollar-signs on both
  // sides as in $$...$$", the item's text intact, a re-render fixing it. The typeset pass inserts `$$`
  // delimiters around a span whose text lacks them (the multi-line _math block's case) and tested that on
  // any span not yet marked `_rendered`; an item's job marked its spans only at its end, after the frames'
  // typesets, whose first prepare() on a page loads seven extension scripts, so a span already typeset but
  // unmarked was handed back by the element cache to a re-render during that wait, and the pass wrapped
  // its rendered output in `$$`. Now a typeset marks its spans as it completes, and the pass never inserts
  // delimiters around a container. Here the frame's typeset is held at its document's render through
  // MathJax's own retry signal (the frame document comes from HTMLHandler.prototype.create; its first
  // render() throws `{retry}` with a promise this test releases, and handleRetriesFor re-runs it after):
  // the owner's formulas are asserted typeset AND marked in that state, before any re-render (the early
  // mark), then a child navigation re-renders the item (the frame element replaced: the premise) and the
  // owner's spans come back from the element cache without delimiters; released, the frame typesets, and
  // the re-render's own pass is seen to have run (a second frame document, for the frame's unmarked spans)
  await loadAdmin(page)
  const CHAT = '#e2e_mm'
  const DEFS = '#e2e_mmdefs'
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  await page.evaluate(text => void window._create(text), `${DEFS} the chat delimiters, as values\n\`\`\`js\nconst user = ''\nconst agent = (...args) => ''\n\`\`\``)
  await page.evaluate(text => void window._create(text), `${CHAT}/a #_e2e_mmdefs\n<<agent('vault/default · run ab12cd34')>>\n${inert('a body')}`)
  await page.evaluate(() => {
    const w = window as any
    const proto = w.MathJax.startup.constructors.HTMLHandler.prototype
    const create = proto.create
    w.__e2e_hold_frame = true
    w.__e2e_frame_docs = 0
    proto.create = function (this: any, ...args: unknown[]) {
      const doc = create.apply(this, args)
      w.__e2e_frame_docs++
      if (!w.__e2e_hold_frame) return doc
      w.__e2e_hold_frame = false // the first frame document after arming, once
      const render = doc.render.bind(doc)
      let first = true
      doc.render = () => {
        if (first) {
          first = false
          w.__e2e_frame_held = true
          throw { retry: new Promise<void>(resolve => void (w.__e2e_release_frame = resolve)) }
        }
        return render()
      }
      return doc
    }
  })
  await page.evaluate(
    text => void window._create(text),
    `${CHAT} #_e2e_mmdefs chat with $\`y_0\`$ and $\`z^2\`$ in the owner's text\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert('see #/a, with $`x^2`$')}`
  )
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), CHAT)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  await expect.poll(query).toMatch(/^#e2e_mm ?$/)
  const state = () =>
    page.evaluate(label => {
      const w = window as any
      const elem = window._item(label, true)?.elem
      const frame = elem?.querySelector('.vault-result') ?? null
      const all = elem ? [...elem.querySelectorAll('span.math, span.math-display')] : []
      const shape = (spans: Element[]) => ({
        spans: spans.length,
        containers: spans.filter(s => s.querySelector('mjx-container')).length,
        marked: spans.filter(s => s.hasAttribute('_rendered')).length,
        // text of the span's own text nodes (inserted delimiters would be among them): a `$` present?
        dollars: spans.filter(s => /\$/.test([...s.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(''))).length,
      })
      return {
        owner: shape(all.filter(s => !s.closest('.vault-result'))),
        frame: shape(all.filter(s => !!s.closest('.vault-result'))),
        held: !!w.__e2e_frame_held,
        docs: w.__e2e_frame_docs as number,
        frameReplaced: w.__mm ? frame !== w.__mm.frame : null,
        ownerSame: w.__mm ? (() => {
          const now = elem ? [...elem.querySelectorAll('mjx-container')].filter(c => !c.closest('.vault-result')) : []
          return now.length === w.__mm.owner.length && now.every((c: Element, i: number) => c === w.__mm.owner[i] && c.isConnected)
        })() : null,
      }
    }, CHAT)
  // the window: the owner's formulas typeset, the frame's held
  await expect.poll(() => state().then(s => `${s.owner.containers},${s.frame.containers},${s.held}`), { timeout: 20_000 }).toBe('2,0,true')
  const before = await state()
  // the early mark: the owner's spans are marked as their typeset completes, while the frame's typeset waits
  // (soft, so the unfixed runtime also shows what the re-render then does to the unmarked spans)
  expect.soft(before.owner, "the owner's spans while the frame's typeset waits: typeset, marked, no delimiters").toEqual({ spans: 2, containers: 2, marked: 2, dollars: 0 })
  expect(before.docs, 'one frame document so far (the held one)').toBe(1)
  await page.evaluate(label => {
    const w = window as any
    const elem = window._item(label, true)!.elem!
    w.__mm = { frame: elem.querySelector('.vault-result'), owner: [...elem.querySelectorAll('mjx-container')].filter(c => !c.closest('.vault-result')) }
  }, CHAT)
  // a re-render while the frame waits: Down enters the child (the chat item re-renders, frames included)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe('#e2e_mm/a ')
  await expect.poll(() => state().then(s => s.frameReplaced), { message: 'the frame element replaced by the re-render (the premise)' }).toBe(true)
  // the re-render's typeset pass runs on a timeout: its verdict on the owner's spans is the mark it finds or
  // the delimiters it inserted (the unfixed runtime); the pass is seen to have run once released (below)
  await expect.poll(() => state().then(s => s.owner.marked + s.owner.dollars > 0), { timeout: 10_000 }).toBe(true)
  const during = await state()
  expect(during.owner, "the owner's spans after the re-render: typeset, marked, no delimiters").toEqual({ spans: 2, containers: 2, marked: 2, dollars: 0 })
  expect(during.ownerSame, "the owner's typeset nodes came back from the element cache").toBe(true)
  expect(during.frame.containers, 'the frame still waits').toBe(0)
  await page.evaluate(() => void (window as any).__e2e_release_frame())
  await expect.poll(() => state().then(s => `${s.frame.containers},${s.frame.marked}`), { timeout: 20_000 }).toBe('1,1')
  // the re-render's pass queued a typeset for the frame's spans (cached untypeset, unmarked at the time): its
  // job runs after the released one with a frame document of its own, and finds the math typeset
  await expect.poll(() => state().then(s => s.docs), { message: "the re-render's pass ran: a second frame document" }).toBeGreaterThanOrEqual(2)
  const after = await state()
  expect(after.owner, "the owner's spans after the frame's typeset").toEqual({ spans: 2, containers: 2, marked: 2, dollars: 0 })
  expect(after.frame, 'the frame: one formula, typeset, marked, no delimiters').toEqual({ spans: 1, containers: 1, marked: 1, dollars: 0 })
  expect(after.ownerSame, "the owner's typeset nodes are the ones from before the re-render").toBe(true)
})

test('the Down arrow prefers integer-named children, the smallest number first, over the children tagged in the item; Right and Left enumerate them in that order', async ({ page }) => {
  // the owner (2026-10-05): a chat's turns and replies are its integer-named children (#chat/0, #chat/1, ...);
  // Down from the chat should enter them in numeric order (1 before 10, not the label order) before the
  // preference stack it had (the first child tag in the item, then the shortest nested name, then a tag
  // child), and Right/Left enumerate the children in that same order (the owner's clarification): the
  // numbers ascending, then the tagged children as before
  await loadAdmin(page)
  const CHAT = '#e2e_ic'
  const DEFS = '#e2e_icdefs'
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  await page.evaluate(text => void window._create(text), `${DEFS} the chat delimiters, as values\n\`\`\`js\nconst user = ''\nconst agent = (...args) => ''\n\`\`\``)
  for (const name of ['b', 'a']) await page.evaluate(text => void window._create(text), `${CHAT}/${name} #_e2e_icdefs\n<<agent('vault/default · run ab12cd34')>>\n${inert(`${name} body`)}`)
  for (const n of ['2', '10', '1']) await page.evaluate(text => void window._create(text), `${CHAT}/${n} turn ${n}`)
  await page.evaluate(
    text => void window._create(text),
    `${CHAT} #_e2e_icdefs chat\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert('see #/b and #/a')}`
  )
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), CHAT)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  await expect.poll(query).toMatch(/^#e2e_ic ?$/)
  // the chat's frame renders its two child tags (the first of them, #/b, was Down's choice before)
  await expect
    .poll(() => page.evaluate(label => [...(window._item(label, true)?.elem?.querySelectorAll('.vault-result mark[data-tag]') ?? [])].map(m => m.getAttribute('data-tag')), CHAT), { timeout: 20_000 })
    .toEqual(['#e2e_ic/b', '#e2e_ic/a'])
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe('#e2e_ic/1 ')
  // Right and Left enumerate the children in the same order: the numbers ascending, then the tagged
  // children as before (#/b then #/a, the frame's order), wrapping around
  for (const next of ['#e2e_ic/2 ', '#e2e_ic/10 ', '#e2e_ic/b ', '#e2e_ic/a ', '#e2e_ic/1 ']) {
    await page.keyboard.press('ArrowRight')
    await expect.poll(query).toBe(next)
  }
  await page.keyboard.press('ArrowLeft')
  await expect.poll(query).toBe('#e2e_ic/a ')
})

test('a _context parent: Down enters the smallest integer child and Right/Left enumerate the numbers, tagged or not, then the visible tags', async ({ page }) => {
  // int_children review 0 B1: a parent tagged #_context steps its visible tags with the side arrows;
  // Down's entry into an untagged integer child was a dead end there, and a tagged one skipped the
  // untagged numbers. The numbers (here /1 and /2 untagged, /10 tagged) come first in numeric order,
  // the parent's other visible tags after them in their order
  await loadAdmin(page)
  const PARENT = '#e2e_icx'
  for (const n of ['10', 'b', '2', '1']) await page.evaluate(text => void window._create(text), `${PARENT}/${n} child ${n}`)
  await page.evaluate(text => void window._create(text), `${PARENT} #_context see #/10 and #/b`)
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), PARENT)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  await expect.poll(query).toMatch(/^#e2e_icx ?$/)
  await expect.poll(() => page.evaluate(label => [...(window._item(label, true)?.elem?.querySelectorAll('mark[title]:not(.child-tag)') ?? [])].map(m => m.getAttribute('title')).filter(t => t?.startsWith(label + '/')), PARENT)).toEqual(['#e2e_icx/10', '#e2e_icx/b'])
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe('#e2e_icx/1 ')
  for (const next of ['#e2e_icx/2 ', '#e2e_icx/10 ', '#e2e_icx/b ', '#e2e_icx/1 ']) {
    await page.keyboard.press('ArrowRight')
    await expect.poll(query).toBe(next)
  }
  await page.keyboard.press('ArrowLeft')
  await expect.poll(query).toBe('#e2e_icx/b ')
})

test('Down takes an immediate integer child, not one a parent tag moved deeper in the subtree', async ({ page }) => {
  // int_children review 0 B2: /1 carries a parent tag naming /branch, so its tree parent is the branch
  // (its ancestors: the branch, then the root); the root's immediate children are /2 and /branch, and
  // Down enters /2, as it did before the integer preference
  await loadAdmin(page)
  const ROOT = '#e2e_icm'
  // a parent tag's target must be a CHAT item (src/lineage.ts): the lane has no #chat, so a stub root is
  // created for the row and deleted at its end (as the tasks lane's row does), the branch depending on it
  const savedId = (label: string) => page.evaluate(label => window._item(label, true)?.saved_id ?? null, label)
  const hadChat = !!(await savedId('#chat'))
  if (!hadChat) await page.evaluate(text => void window._create(text), '#chat #_autodep\nconfig')
  await expect.poll(() => savedId('#chat'), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(text => void window._create(text), `${ROOT} see #/2`)
  await page.evaluate(text => void window._create(text), `${ROOT}/branch #_chat a branch`)
  await page.evaluate(text => void window._create(text), `${ROOT}/1 #_e2e_icm/branch moved under the branch`)
  await page.evaluate(text => void window._create(text), `${ROOT}/2 two`)
  await expect.poll(() => page.evaluate(label => (window._item(label, true) as any)?.ancestors ?? null, `${ROOT}/1`), { timeout: 15_000 }).toEqual(['#e2e_icm/branch', '#e2e_icm'])
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), ROOT)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  await expect.poll(query).toMatch(/^#e2e_icm ?$/)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe('#e2e_icm/2 ')
  if (!hadChat) {
    await firestore().collection('items').doc((await savedId('#chat'))!).delete()
    await expect.poll(() => savedId('#chat'), { timeout: 30_000 }).toBeNull()
  }
})

test('parents draw their direct tree children as real tag marks: order, placement, no repetition, path highlight, arrows, click, live remote updates, and shown-only', async ({ page, browser }) => {
  await loadAdmin(page)
  const P = '#e2e_ct'
  const D = '#e2e_ct_desc'
  const L = '#e2e_ct_list'
  const M = '#e2e_ct_menu'
  const I = '#e2e_ct_inert'
  const OTHER = '#e2e_ct_other'
  const savedId = (label: string, target: typeof page = page) =>
    target.evaluate(label => window._item(label, true)?.saved_id ?? null, label)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  const setQuery = async (q: string) => {
    await page.evaluate(q => (window as any).MindBox.set(q, { scroll: true }), q)
    await expect.poll(() => query().then(v => v.trim())).toBe(q.trim())
  }
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  const pressArrow = async (key: string, expected: string) => {
    await blur()
    await page.keyboard.press(key)
    await expect.poll(query, { message: `${key} navigates to ${expected}` }).toBe(expected)
  }
  const drawn = (label: string) =>
    page.evaluate(label => {
      const elem = window._item(label, true)?.elem
      if (!elem) return null
      return [...elem.querySelectorAll('mark.child-tag:not(.repeated)')]
        .filter(m => m.checkVisibility())
        .map(m => [
          m.getAttribute('title'),
          m.textContent,
          m.classList.contains('selected'),
          m.classList.contains('secondary-selected'),
        ])
    }, label)
  const drawnTitles = (label: string) => drawn(label).then(rows => rows?.map(r => r[0]) ?? null)

  // create a #chat stub if absent so the tag-parent override (#e2e_ct_desc/moved -> /branch) is accepted
  const hadChat = !!(await savedId('#chat'))
  const ctx2 = await browser.newContext()
  try {
    if (!hadChat) await page.evaluate(text => void window._create(text), '#chat #_autodep\nconfig')
    await expect.poll(() => savedId('#chat'), { timeout: 30_000 }).toBeTruthy()

    // create the tree in scrambled order so numeric and alphabetical ordering are witnessed
    for (const text of [
      `${OTHER} #_pin bystander item`,
      `${P} #_pin`,
      `${P}/b child b`,
      `${P}/10 child ten`,
      `${P}/uniqchild unique child`,
      `${P}/a child a`,
      `${P}/2 child two`,
      `${D} Overview with #/z and #_/hidden_kid`,
      `${D}/z child z`,
      `${D}/10 desc ten`,
      `${D}/a desc a`,
      `${D}/a/deep grandchild`,
      `${D}/2 desc two`,
      `${D}/hidden_kid hidden dep child`,
      `${D}/branch #_chat a chat branch`,
      `${D}/moved #_${D.slice(1)}/branch moved under branch`,
      `${L}\n- one\n- two`,
      `${L}/y list y`,
      `${L}/x list x`,
      `${M} #_menu`,
      `${M}/sub menu child`,
      `${I} chat\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n<!--inert-->\nsee #/listed and ${I}/abs_only\n<!--/inert-->`,
      `${I}/listed listed in reply`,
      `${I}/abs_only absolute tag link in reply`,
      `${I}/unlisted not in reply`,
    ]) {
      await page.evaluate(text => void window._create(text), text)
    }
    await expect.poll(() => savedId(`${I}/unlisted`), { timeout: 30_000 }).toBeTruthy()
    await expect
      .poll(() => page.evaluate(label => (window._item(label, true) as any)?.ancestors ?? null, `${D}/moved`), {
        timeout: 15_000,
      })
      .toEqual([`${D}/branch`, D])

    // 1. Name-only parent (#e2e_ct #_pin): drawn inline beside the label, numbered first then by name
    await setQuery(P)
    await expect
      .poll(() => drawn(P), { message: 'name-only parent draws direct children in numeric-then-name order' })
      .toEqual([
        [`${P}/2`, '2', false, false],
        [`${P}/10`, '10', false, false],
        [`${P}/a`, 'a', false, false],
        [`${P}/b`, 'b', false, false],
        [`${P}/uniqchild`, 'uniqchild', false, false],
      ])
    const nameOnlyLayout = await page.evaluate(
      ([label, other]) => {
        const item = window._item(label, true)!.elem!.querySelector('.item')!
        const lblEl = item.querySelector('mark.label') as HTMLElement
        const childEl = item.querySelector('mark.child-tag') as HTMLElement
        const lbl = lblEl.getBoundingClientRect()
        const firstChild = childEl.getBoundingClientRect()
        const pHeight = item.querySelector('.content p')!.getBoundingClientRect().height
        const otherPHeight = window._item(other, true)!.elem!.querySelector('.item .content p')!.getBoundingClientRect().height
        // exact baseline alignment via 0x0 inline-block probes removed immediately
        const probe = () => {
          const s = document.createElement('span')
          s.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden'
          return s
        }
        const pl = probe()
        const pc = probe()
        let baselineDiff = Infinity
        try {
          lblEl.appendChild(pl)
          childEl.appendChild(pc)
          baselineDiff = Math.abs(pc.getBoundingClientRect().bottom - pl.getBoundingClientRect().bottom)
        } finally {
          pl.remove()
          pc.remove()
        }
        const labelFontSize = parseFloat(getComputedStyle(lblEl).fontSize)
        const childFontSize = parseFloat(getComputedStyle(childEl).fontSize)
        return {
          inlineContainer: !!item.querySelector('.content p > .child-tags'),
          blockContainer: !!item.querySelector(':scope > .child-tags'),
          sameLine: Math.abs(firstChild.top - lbl.top) <= 4 && firstChild.left > lbl.right,
          sameBaseline: baselineDiff <= 0.5,
          sameLineHeight: Math.abs(pHeight - otherPHeight) <= 0.5,
          sizeRatio: Math.round((childFontSize / labelFontSize) * 100) / 100,
        }
      },
      [P, OTHER] as const,
    )
    expect(
      nameOnlyLayout,
      'name-only parent places children inline at 85% size on the same baseline with no line-height shift',
    ).toEqual({
      inlineContainer: true,
      blockContainer: false,
      sameLine: true,
      sameBaseline: true,
      sameLineHeight: true,
      sizeRatio: 0.85,
    })

    // 2. Content parent (#e2e_ct_desc): below content, no repetition of written #/z, hidden tag does
    // not suppress #/hidden_kid, grandchild /a/deep and tag-moved /moved are excluded from #e2e_ct_desc
    await setQuery(D)
    await expect
      .poll(() => drawnTitles(D), { message: 'content parent draws unshown direct children only' })
      .toEqual([`${D}/2`, `${D}/10`, `${D}/a`, `${D}/branch`, `${D}/hidden_kid`])
    const descFacts = await page.evaluate(label => {
      const item = window._item(label, true)!.elem!.querySelector('.item')!
      const firstLine = item.querySelector('.content p')!.getBoundingClientRect()
      const writtenEl = item.querySelector(`mark[title="${label}/z"]:not(.child-tag)`) as HTMLElement
      const childEl = item.querySelector(':scope > .child-tags mark.child-tag') as HTMLElement
      const firstChild = childEl.getBoundingClientRect()
      const lblFont = parseFloat(getComputedStyle(item.querySelector('mark.label')!).fontSize)
      const writtenFont = parseFloat(getComputedStyle(writtenEl).fontSize)
      const drawnFont = parseFloat(getComputedStyle(childEl).fontSize)
      return {
        inlineContainer: !!item.querySelector('.content .child-tags'),
        blockContainer: !!item.querySelector(':scope > .child-tags'),
        belowContent: firstChild.top >= firstLine.bottom - 2,
        zCount: [...item.querySelectorAll(`mark[title="${label}/z"]`)].filter(m => m.checkVisibility()).length,
        zDrawnRepeated: !!item.querySelector(`mark.child-tag.repeated[title="${label}/z"]`),
        writtenMatchesLabel: Math.abs(writtenFont - lblFont) <= 0.1,
        drawnToWrittenRatio: Math.round((drawnFont / writtenFont) * 100) / 100,
      }
    }, D)
    expect(descFacts, 'content parent places children below at 85% of written tag size and does not repeat #/z').toEqual({
      inlineContainer: false,
      blockContainer: true,
      belowContent: true,
      zCount: 1,
      zDrawnRepeated: true,
      writtenMatchesLabel: true,
      drawnToWrittenRatio: 0.85,
    })

    // Moved child sits under its tag parent (#e2e_ct_desc/branch) instead
    await setQuery(`${D}/branch`)
    await expect
      .poll(() => drawnTitles(`${D}/branch`), { message: 'tag parent draws its moved tag child' })
      .toEqual([`${D}/moved`])

    // List parent (#e2e_ct_list): children sit below the list
    await setQuery(L)
    await expect.poll(() => drawnTitles(L)).toEqual([`${L}/x`, `${L}/y`])
    const listBelow = await page.evaluate(label => {
      const item = window._item(label, true)!.elem!.querySelector('.item')!
      const ul = item.querySelector('.content ul')!.getBoundingClientRect()
      const firstChild = item.querySelector(':scope > .child-tags mark.child-tag')!.getBoundingClientRect()
      return firstChild.top >= ul.bottom - 2
    }, L)
    expect(listBelow, 'list parent places children below the list').toBe(true)

    // 3. Shown only: drawn children do NOT enter item's tags, text, deps, dependents, or search matches
    const state = await page.evaluate(label => {
      const raw = (window as any).__items.find((i: any) => i.label == label)!
      const api = window._item(label, true) as any
      return {
        text: raw.text,
        tags: [...raw.tags].sort(),
        tagsVisible: [...raw.tagsVisible].sort(),
        deps: api.dependencies.map((id: string) => (window._item(id, true) as any).label),
        dependents: api.dependents,
      }
    }, P)
    expect(state, 'drawn children never enter item tags, text, deps or dependents').toEqual({
      text: `${P} #_pin`,
      tags: [P, '#pin'],
      tagsVisible: [P],
      deps: ['#features/_pin'],
      dependents: [],
    })
    await setQuery('uniqchild')
    const searchMatch = await page.evaluate(
      ([p, c]) => ({
        parentMatching: (window as any).__items.find((i: any) => i.label == p)!.matching,
        parentTerms: (window as any).__items.find((i: any) => i.label == p)!.matchingTerms,
        childMatching: (window as any).__items.find((i: any) => i.label == c)!.matching,
      }),
      [P, `${P}/uniqchild`] as const,
    )
    expect(searchMatch, 'search for a child name matches the child, never the parent through drawn marks').toEqual({
      parentMatching: false,
      parentTerms: [],
      childMatching: true,
    })

    // 4. Click a drawn child mark -> navigates to child, highlights it on parent; grandparent gets secondary-selected
    await setQuery(P)
    await expect.poll(() => drawnTitles(P)).toContain(`${P}/10`)
    const parentId = await page.evaluate(label => window._item(label, true)!.id, P)
    await page.locator(`#item-${parentId} mark.child-tag[title="${P}/10"]`).click()
    await expect.poll(query, { message: 'click on drawn mark navigates to child' }).toBe(`${P}/10 `)
    await expect
      .poll(() => drawn(P), { message: 'parent highlights the active child on the path' })
      .toEqual([
        [`${P}/2`, '2', false, false],
        [`${P}/10`, '10', true, false],
        [`${P}/a`, 'a', false, false],
        [`${P}/b`, 'b', false, false],
        [`${P}/uniqchild`, 'uniqchild', false, false],
      ])

    await setQuery(`${D}/a/deep`)
    await expect
      .poll(() => drawn(D), { message: 'grandparent highlights path child as secondary-selected' })
      .toEqual([
        [`${D}/2`, '2', false, false],
        [`${D}/10`, '10', false, false],
        [`${D}/a`, 'a', false, true],
        [`${D}/branch`, 'branch', false, false],
        [`${D}/hidden_kid`, 'hidden_kid', false, false],
      ])
    await expect
      .poll(() => drawn(`${D}/a`), { message: 'parent highlights named grandchild as selected' })
      .toEqual([[`${D}/a/deep`, 'deep', true, false]])

    // 5. Arrow keys walk drawn children in exact shown order on a parent with NO written tags
    await setQuery(P)
    const shownOrder = (await drawnTitles(P))!
    await pressArrow('ArrowDown', `${shownOrder[0]} `)
    const walked = [shownOrder[0]]
    for (let i = 1; i < shownOrder.length; i++) {
      await pressArrow('ArrowRight', `${shownOrder[i]} `)
      walked.push(shownOrder[i])
      // highlight moves to each sibling in turn on the parent shown above
      const active = (await drawn(P))!.filter(r => r[2]).map(r => r[0])
      expect(active, `parent highlights ${shownOrder[i]} during Right walk`).toEqual([shownOrder[i]])
    }
    expect(walked, 'Right walks drawn children in exact shown order').toEqual(shownOrder)
    await pressArrow('ArrowRight', `${shownOrder[0]} `) // wraps to first
    await pressArrow('ArrowLeft', `${shownOrder[shownOrder.length - 1]} `) // Left wraps back
    await pressArrow('ArrowUp', `${P} `)

    // 6. Mixed list and Rule 7: with written #/z above drawn children, numbered children still come
    // first (app rule for numbered children), then written #/z in its place, then remaining drawn children;
    // removing the written list walks all drawn children in lineage order
    await setQuery(D)
    await blur()
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(query, {
        message: 'mixed list: Down enters lowest numbered child first even when written #/z stands above drawn numbers',
      })
      .toBe(`${D}/2 `)
    for (const next of [`${D}/10 `, `${D}/z `, `${D}/a `, `${D}/branch `, `${D}/hidden_kid `, `${D}/2 `]) {
      await blur()
      await page.keyboard.press('ArrowRight')
      await expect
        .poll(query, {
          message: `mixed list: Right follows numbered-first then written #/z then remaining drawn children -> ${next}`,
        })
        .toBe(next)
    }
    // drop the written tags from #e2e_ct_desc so only its one-line description remains (like #map)
    await page.evaluate(label => (window._item(label, true) as any).write(`${label} Overview`, ''), D)
    await setQuery(D)
    const descDrawnOrder = [`${D}/2`, `${D}/10`, `${D}/a`, `${D}/branch`, `${D}/hidden_kid`, `${D}/z`]
    await expect
      .poll(() => drawnTitles(D), { message: 'after dropping written list, all children draw below description' })
      .toEqual(descDrawnOrder)
    await pressArrow('ArrowDown', `${descDrawnOrder[0]} `)
    for (const next of [...descDrawnOrder.slice(1), descDrawnOrder[0]]) {
      await pressArrow('ArrowRight', `${next} `)
    }
    await pressArrow('ArrowLeft', `${descDrawnOrder[descDrawnOrder.length - 1]} `)
    await expect
      .poll(() => drawn(D).then(rows => rows!.filter(r => r[2]).map(r => r[0])), {
        message: 'path highlight works on parent whose written list was removed',
      })
      .toEqual([`${D}/z`])

    // 7. Live updates: create, rename, delete — locally and from a second page, redrawing ONLY parent
    await setQuery(P)
    await expect.poll(() => page.evaluate(o => !!window._item(o, true)?.elem?.querySelector('.content'), OTHER)).toBe(true)
    await page.evaluate(o => {
      ;(window._item(o, true)!.elem!.querySelector('.content') as HTMLElement).dataset.bystander = 'kept'
    }, OTHER)
    const bystanderKept = () =>
      page.evaluate(o => (window._item(o, true)!.elem!.querySelector('.content') as HTMLElement).dataset.bystander, OTHER)

    // local create, rename, delete
    await page.evaluate(text => void window._create(text), `${P}/0 local zero`)
    await expect.poll(() => drawnTitles(P), { message: 'local create adds child live' }).toEqual([
      `${P}/0`,
      `${P}/2`,
      `${P}/10`,
      `${P}/a`,
      `${P}/b`,
      `${P}/uniqchild`,
    ])
    expect(await bystanderKept(), 'bystander not redrawn on local child create').toBe('kept')

    await page.evaluate(([a, b]) => (window._item(a, true) as any).write(`${b} renamed`, ''), [`${P}/0`, `${P}/mid`] as const)
    await expect.poll(() => drawnTitles(P), { message: 'local rename updates parent live' }).toEqual([
      `${P}/2`,
      `${P}/10`,
      `${P}/a`,
      `${P}/b`,
      `${P}/mid`,
      `${P}/uniqchild`,
    ])
    expect(await bystanderKept(), 'bystander not redrawn on local child rename').toBe('kept')

    await page.evaluate(label => window._item(label, true)!.delete(false), `${P}/mid`)
    await expect.poll(() => drawnTitles(P), { message: 'local delete removes child live' }).toEqual([
      `${P}/2`,
      `${P}/10`,
      `${P}/a`,
      `${P}/b`,
      `${P}/uniqchild`,
    ])
    expect(await bystanderKept(), 'bystander not redrawn on local child delete').toBe('kept')

    // remote create, rename, delete from a second page of the same account
    const page2 = await ctx2.newPage()
    await loadAdmin(page2)
    await page2.evaluate(text => void window._create(text), `${P}/1 remote one`)
    await expect.poll(() => savedId(`${P}/1`, page2), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => drawnTitles(P), { message: 'remote create redraws parent live', timeout: 20_000 }).toEqual([
      `${P}/1`,
      `${P}/2`,
      `${P}/10`,
      `${P}/a`,
      `${P}/b`,
      `${P}/uniqchild`,
    ])
    expect(await bystanderKept(), 'bystander not redrawn on remote child create').toBe('kept')

    await page2.evaluate(([a, b]) => (window._item(a, true) as any).write(`${b} remote renamed`, ''), [`${P}/1`, `${P}/c`] as const)
    await expect.poll(() => drawnTitles(P), { message: 'remote rename redraws parent live', timeout: 20_000 }).toEqual([
      `${P}/2`,
      `${P}/10`,
      `${P}/a`,
      `${P}/b`,
      `${P}/c`,
      `${P}/uniqchild`,
    ])
    expect(await bystanderKept(), 'bystander not redrawn on remote child rename').toBe('kept')

    await page2.evaluate(label => window._item(label, true)!.delete(false), `${P}/c`)
    await expect.poll(() => drawnTitles(P), { message: 'remote delete redraws parent live', timeout: 20_000 }).toEqual([
      `${P}/2`,
      `${P}/10`,
      `${P}/a`,
      `${P}/b`,
      `${P}/uniqchild`,
    ])
    expect(await bystanderKept(), 'bystander not redrawn on remote child delete').toBe('kept')

    // 8. Not drawn while editing, and not drawn when parent label is duplicated
    const pElem = await page.evaluate(label => window._item(label, true)!.id, P)
    await blur()
    await page.keyboard.press('Enter')
    await expect(page.locator(`#textarea-${pElem}`)).toBeFocused()
    expect(await page.locator(`#super-container-${pElem} mark.child-tag`).count(), 'no drawn marks while editing').toBe(0)
    expect(await page.locator(`#textarea-${pElem}`).inputValue(), 'editor holds raw text without drawn children').toBe(`${P} #_pin`)
    await page.keyboard.press('Escape')
    await expect.poll(() => drawnTitles(P), { message: 'drawn marks return after closing editor' }).toEqual([
      `${P}/2`,
      `${P}/10`,
      `${P}/a`,
      `${P}/b`,
      `${P}/uniqchild`,
    ])

    // duplicate parent label suppresses drawn children on both copies; resolve each record by id
    // through window._item (raw __items entries have no .elem getter), require both rendered containers,
    // and check ArrowRight from a child while the parent label is duplicated
    await page.evaluate(text => void window._create(text), `${P} #_pin duplicate parent`)
    await setQuery(P)
    await expect
      .poll(
        () =>
          page.evaluate(
            label =>
              (window as any).__items
                .filter((i: any) => i.label == label)
                .map((i: any) => {
                  const elem = window._item(i.id, true)?.elem
                  const container = elem?.querySelector('.container')
                  return {
                    rendered: !!container,
                    drawn: container ? container.querySelectorAll('mark.child-tag:not(.repeated)').length : -1,
                  }
                }),
            P,
          ),
        { message: 'duplicated parent renders both containers and draws no children on either item' },
      )
      .toEqual([
        { rendered: true, drawn: 0 },
        { rendered: true, drawn: 0 },
      ])
    await setQuery(`${P}/2`)
    await blur()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)
    expect((await query()).trim(), 'duplicated parent provides no nesting context for ArrowRight').toBe(`${P}/2`)
    const dupId = await page.evaluate(
      label => (window as any).__items.find((i: any) => i.label == label && i.text.includes('duplicate'))!.id,
      P,
    )
    await page.evaluate(id => window._item(id, true)!.delete(false), dupId)
    await setQuery(P)
    await expect.poll(() => drawnTitles(P), { message: 'unique parent draws children again after duplicate removed' }).toEqual([
      `${P}/2`,
      `${P}/10`,
      `${P}/a`,
      `${P}/b`,
      `${P}/uniqchild`,
    ])

    // 9. Menu item (#_menu): never inline inside .content.menu flex paragraph; drawn in block below at 85%
    await setQuery(M)
    await expect.poll(() => drawnTitles(M), { message: 'menu item draws children in footer block' }).toEqual([`${M}/sub`])
    const menuFacts = await page.evaluate(label => {
      const item = window._item(label, true)!.elem!.querySelector('.item')!
      const childEl = item.querySelector(':scope > .child-tags mark.child-tag') as HTMLElement
      const baseFont = parseFloat(getComputedStyle(item).fontSize)
      const childFont = parseFloat(getComputedStyle(childEl).fontSize)
      return {
        insideMenu: !!item.querySelector('.content.menu mark.child-tag'),
        inFooterBlock: !!childEl,
        childDisplay: getComputedStyle(childEl).display,
        sizeRatio: Math.round((childFont / baseFont) * 100) / 100,
      }
    }, M)
    expect(menuFacts, 'menu item places drawn child tags below .content.menu at 85% inline size').toEqual({
      insideMenu: false,
      inFooterBlock: true,
      childDisplay: 'inline',
      sizeRatio: 0.85,
    })

    // 10. Agent's inert section listing a child: never draws inside .vault-result; omits relative #/child
    // already rendered as mark[data-tag] in the reply, while drawing other children (and absolute tag-links)
    await setQuery(I)
    await expect
      .poll(() =>
        page.evaluate(
          label => !!window._item(label, true)?.elem?.querySelector(`.vault-result mark[data-tag="${label}/listed"]`),
          I,
        ),
      )
      .toBe(true)
    const inertFacts = await page.evaluate(label => {
      const item = window._item(label, true)!.elem!.querySelector('.item')!
      return {
        drawnInsideInert: item.querySelectorAll('.vault-result mark.child-tag').length,
        replyMarkCount: [...item.querySelectorAll(`.vault-result mark[data-tag="${label}/listed"]`)].filter(m =>
          m.checkVisibility(),
        ).length,
        totalListedMarks: [...item.querySelectorAll(`mark[title="${label}/listed"]`)].filter(m => m.checkVisibility())
          .length,
        absTagLinkInReply: !!item.querySelector(`.vault-result code[data-tag-link="${label}/abs_only"]`),
        drawnBelow: [...item.querySelectorAll(':scope > .child-tags mark.child-tag:not(.repeated)')]
          .filter(m => m.checkVisibility())
          .map(m => m.getAttribute('title')),
      }
    }, I)
    expect(
      inertFacts,
      'agent inert section keeps drawn tags outside .vault-result and omits child already shown as mark[data-tag]',
    ).toEqual({
      drawnInsideInert: 0,
      replyMarkCount: 1,
      totalListedMarks: 1,
      absTagLinkInReply: true,
      drawnBelow: [`${I}/abs_only`, `${I}/unlisted`],
    })

    // 11. Undrawn non-unique (duplicated) direct child labels under a unique parent: not drawn on P,
    // so ArrowRight walks them through onKeyDown's `_labels(...).sort()` list in alphabetical order
    for (const text of [`${P}/dup_z first`, `${P}/dup_z second`, `${P}/dup_a first`, `${P}/dup_a second`]) {
      await page.evaluate(text => void window._create(text), text)
    }
    await expect
      .poll(
        () =>
          page.evaluate(
            label => (window as any).__items.filter((i: any) => i.label == label && i.savedId).length,
            `${P}/dup_a`,
          ),
        { timeout: 30_000 },
      )
      .toBe(2)
    await setQuery(`${P}/uniqchild`)
    expect(await drawnTitles(P), 'duplicated child labels are not drawn on parent').toEqual([
      `${P}/2`,
      `${P}/10`,
      `${P}/a`,
      `${P}/b`,
      `${P}/uniqchild`,
    ])
    await pressArrow('ArrowRight', `${P}/dup_a `)
    await pressArrow('ArrowRight', `${P}/dup_z `)
    await pressArrow('ArrowRight', `${P}/2 `)
  } finally {
    await ctx2.close()
    if (!hadChat) {
      const chatDoc = await savedId('#chat')
      if (chatDoc) {
        await firestore().collection('items').doc(chatDoc).delete()
        await expect.poll(() => savedId('#chat'), { timeout: 30_000 }).toBeNull()
      }
    }
  }
})

test('drawn child tags follow visibility across folded replies, hidden sections, and child-only highlight changes leave link handlers unwrapped', async ({ page }) => {
  await loadAdmin(page)
  const R = '#e2e_ctv_r'
  const H = '#e2e_ctv_h'
  const D = '#e2e_ctv_d'
  const L = '#e2e_ctv_l'
  const W = '#e2e_ctv_w'
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  const setQuery = async (q: string) => {
    await page.evaluate(q => (window as any).MindBox.set(q, { scroll: true }), q)
    await expect.poll(() => query().then(v => v.trim())).toBe(q.trim())
  }
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  const pressArrow = async (key: string, expected: string, message?: string) => {
    await blur()
    await page.keyboard.press(key)
    await expect.poll(query, { message: message ?? `${key} navigates to ${expected}` }).toBe(expected)
  }
  // visible non-label marks outside .deps-and-dependents as [title, isDrawnChild, isSelected]
  const visibleMarks = (label: string) =>
    page.evaluate(label => {
      const item = window._item(label, true)?.elem?.querySelector('.item')
      if (!item) return null
      return [...item.querySelectorAll('mark:not(.label,.deps-and-dependents *)')]
        .filter(m => m.checkVisibility())
        .map(m => [m.getAttribute('title'), m.classList.contains('child-tag'), m.classList.contains('selected')])
    }, label)
  const replyFrameVisible = (label: string) =>
    page.evaluate(label => {
      const item = window._item(label, true)?.elem?.querySelector('.item')
      const frame = item?.querySelector('.inert-block > .vault-result')
      return frame ? frame.checkVisibility() : null
    }, label)

  for (const text of [
    `${R} chat\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n<!--inert-->\nIntro line before the child tag.\n\nSecond line mentions #/listed here.\n<!--/inert-->`,
    `${R}/listed listed in reply`,
    `${R}/other other child`,
    `${H} Overview\n<!--hidden-->\n#/b\n<!--/hidden-->`,
    `${H}/z child z`,
    `${H}/b child b`,
    `${H}/a child a`,
    `${D} Overview\n<div hidden>\n#/b\n</div>`,
    `${D}/z child z`,
    `${D}/b child b`,
    `${D}/a child a`,
    `${L} Overview <a id="e2e-ctv-link" href="https://example.invalid/review" onclick="window.__ctvOwnClicks = (window.__ctvOwnClicks || 0) + 1; event.stopPropagation(); event.preventDefault();">review</a>`,
    `${L}/one sibling one`,
    `${L}/two sibling two`,
    `${W} chat\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n<!--inert-->\nIntro line before the listed children.\n\nSecond line lists #/b and #/a here.\n<!--/inert-->`,
    `${W}/a child a`,
    `${W}/b child b`,
    `${W}/c child c`,
  ]) {
    await page.evaluate(text => void window._create(text), text)
  }
  await expect.poll(() => page.evaluate(l => window._item(l, true)?.saved_id ?? null, `${W}/c`), { timeout: 30_000 }).toBeTruthy()

  // 1. Agent reply listing #/listed on its SECOND line:
  // (a) parent named (reply open): one visible mark for each child (listed in reply, other drawn), no repeat
  await setQuery(R)
  await expect
    .poll(() => visibleMarks(R), { message: 'open reply shows listed in frame and other drawn, with no repeat' })
    .toEqual([
      [`${R}/listed`, false, false],
      [`${R}/other`, true, false],
    ])

  // (b) other named (parent as context, reply folded to line 1): one visible clickable mark for each child
  await setQuery(`${R}/other`)
  await expect
    .poll(
      () =>
        page.evaluate(label => {
          const item = window._item(label, true)?.elem?.querySelector('.item')
          const frame = item?.querySelector('.inert-block > .vault-result')
          return frame ? frame.checkVisibility() : null
        }, R),
      { message: 'reply is folded while parent is context for other child' },
    )
    .toBe(false)
  await expect
    .poll(() => visibleMarks(R), {
      message: 'folded reply shows drawn marks for both listed and other (no child lost)',
    })
    .toEqual([
      [`${R}/listed`, true, false],
      [`${R}/other`, true, true],
    ])
  const rId = await page.evaluate(l => window._item(l, true)!.id, R)
  await page.locator(`#item-${rId} mark.child-tag[title="${R}/listed"]`).click()
  await expect.poll(query, { message: 'drawn mark revealed by folded reply is clickable' }).toBe(`${R}/listed `)

  // (c) manual block toggle both ways while parent is context for other: one visible mark per child each way
  await setQuery(`${R}/other`)
  await expect.poll(() => visibleMarks(R)).toEqual([
    [`${R}/listed`, true, false],
    [`${R}/other`, true, true],
  ])
  await page.locator(`#item-${rId} .inert-block .inert-line`).click()
  await expect
    .poll(() => visibleMarks(R), {
      message: 'toggling folded reply open hides repeated drawn mark immediately (no repeat)',
    })
    .toEqual([
      [`${R}/listed`, false, false],
      [`${R}/other`, true, true],
    ])
  // when an unnamed reply is open its empty .inert-line has zero height; clicking its first line toggles it closed
  await page.locator(`#item-${rId} .inert-block .vault-result p`).first().click()
  await expect
    .poll(() => visibleMarks(R), {
      message: 'toggling reply closed again restores drawn mark immediately (no missing child)',
    })
    .toEqual([
      [`${R}/listed`, true, false],
      [`${R}/other`, true, true],
    ])

  // 2. Parent with <!--hidden--> holding #/b: drawn a, b, z and Down then Right walk a, b, z
  await setQuery(H)
  await expect
    .poll(() => visibleMarks(H), { message: '<!--hidden--> mark does not suppress drawn b' })
    .toEqual([
      [`${H}/a`, true, false],
      [`${H}/b`, true, false],
      [`${H}/z`, true, false],
    ])
  await pressArrow('ArrowDown', `${H}/a `, 'Down skips invisible mark inside <!--hidden--> and enters a')
  await pressArrow('ArrowRight', `${H}/b `, 'Right from a steps to visible b (not skipping past hidden copy)')
  await pressArrow('ArrowRight', `${H}/z `, 'Right from b steps to z')
  await pressArrow('ArrowRight', `${H}/a `, 'Right from z wraps to a')

  // 3. Parent with owner <div hidden> around #/b: drawn a, b, z and Down then Right walk a, b, z
  await setQuery(D)
  await expect
    .poll(() => visibleMarks(D), { message: '<div hidden> mark does not suppress drawn b' })
    .toEqual([
      [`${D}/a`, true, false],
      [`${D}/b`, true, false],
      [`${D}/z`, true, false],
    ])
  await pressArrow('ArrowDown', `${D}/a `, 'Down skips invisible mark inside <div hidden> and enters a')
  await pressArrow('ArrowRight', `${D}/b `, 'Right from a steps to b')
  await pressArrow('ArrowRight', `${D}/z `, 'Right from b steps to z')
  await pressArrow('ArrowRight', `${D}/a `, 'Right from z wraps to a')

  // 4. Child-only highlight changes between drawn siblings leave parent's custom-onclick link unwrapped
  await setQuery(`${L}/one`)
  await expect.poll(() => visibleMarks(L)).toEqual([
    [`${L}/one`, true, true],
    [`${L}/two`, true, false],
  ])
  const lId = await page.evaluate(l => window._item(l, true)!.id, L)
  await page.evaluate(id => {
    const w = window as any
    w.__ctvOwnClicks = 0
    w.__ctvLinkCalls = 0
    w.__ctvOrigHandleLinkClick = w._handleLinkClick
    w._handleLinkClick = function (itemId: string, href: string, e: Event) {
      if (itemId == id) w.__ctvLinkCalls++
      return w.__ctvOrigHandleLinkClick.call(this, itemId, href, e)
    }
  }, lId)
  try {
    for (const [target, lit] of [
      [`${L}/two `, `${L}/two`],
      [`${L}/one `, `${L}/one`],
      [`${L}/two `, `${L}/two`],
      [`${L}/one `, `${L}/one`],
    ] as const) {
      await pressArrow('ArrowRight', target)
      await expect
        .poll(() => visibleMarks(L).then(rows => rows?.filter(r => r[2]).map(r => r[0])), {
          message: `lit drawn mark moved to ${lit}`,
        })
        .toEqual([lit])
    }
    await page.locator('#e2e-ctv-link').click()
    const counts = await page.evaluate(() => ({
      ownClicks: (window as any).__ctvOwnClicks,
      linkHandlerCalls: (window as any).__ctvLinkCalls,
    }))
    expect(counts, 'link onclick and _handleLinkClick each fire once after 4 sibling moves').toEqual({
      ownClicks: 1,
      linkHandlerCalls: 1,
    })
  } finally {
    await page.evaluate(() => {
      const w = window as any
      if (w.__ctvOrigHandleLinkClick) {
        w._handleLinkClick = w.__ctvOrigHandleLinkClick
        delete w.__ctvOrigHandleLinkClick
      }
    })
  }

  // 5. Arrow-key walk stays in one cyclic order across a folded/opened reply transition:
  // parent has children a, b, c and a reply listing #/b then #/a on its second line (c not listed).
  // Down enters b, Right walks b -> a -> c -> b, Left walks c -> a -> b, while the reply folds on c
  // (where drawn marks show a b c) and re-opens automatically on b and a.
  await setQuery(W)
  await expect.poll(() => replyFrameVisible(W), { message: 'walk reply is open while parent is target' }).toBe(true)
  await expect
    .poll(() => visibleMarks(W), { message: 'open walk reply shows listed b and a in frame and c drawn' })
    .toEqual([
      [`${W}/b`, false, false],
      [`${W}/a`, false, false],
      [`${W}/c`, true, false],
    ])
  await pressArrow('ArrowDown', `${W}/b `, 'Down from parent enters first reply child b')
  await expect.poll(() => replyFrameVisible(W), { message: 'walk reply stays open on listed child b' }).toBe(true)

  const rightVisited: string[] = [await query()]
  await pressArrow('ArrowRight', `${W}/a `, 'Right from b steps to listed child a')
  await expect.poll(() => replyFrameVisible(W), { message: 'walk reply stays open on listed child a' }).toBe(true)
  rightVisited.push(await query())
  await pressArrow('ArrowRight', `${W}/c `, 'Right from a steps to unlisted child c')
  await expect.poll(() => replyFrameVisible(W), { message: 'walk reply folds when reaching unlisted child c' }).toBe(false)
  await expect
    .poll(() => visibleMarks(W), { message: 'while walk reply is folded on c, drawn marks show a b c' })
    .toEqual([
      [`${W}/a`, true, false],
      [`${W}/b`, true, false],
      [`${W}/c`, true, true],
    ])
  rightVisited.push(await query())
  expect(rightVisited, 'Right round visits each child exactly once in order b, a, c').toEqual([
    `${W}/b `,
    `${W}/a `,
    `${W}/c `,
  ])
  await pressArrow('ArrowRight', `${W}/b `, 'Right from c while reply is folded wraps to b (keeps reply order)')
  await expect
    .poll(() => replyFrameVisible(W), { message: 'walk reply re-opens when Right wraps from folded c to b' })
    .toBe(true)

  const leftVisited: string[] = []
  await pressArrow('ArrowLeft', `${W}/c `, 'Left from b wraps back to unlisted child c')
  await expect
    .poll(() => replyFrameVisible(W), { message: 'walk reply folds again when Left reaches unlisted child c' })
    .toBe(false)
  await expect
    .poll(() => visibleMarks(W), { message: 'while walk reply is folded on c during Left round, drawn marks show a b c' })
    .toEqual([
      [`${W}/a`, true, false],
      [`${W}/b`, true, false],
      [`${W}/c`, true, true],
    ])
  leftVisited.push(await query())
  await pressArrow('ArrowLeft', `${W}/a `, 'Left from c while reply is folded steps to a (keeps reply order)')
  await expect
    .poll(() => replyFrameVisible(W), { message: 'walk reply re-opens when Left steps from folded c to a' })
    .toBe(true)
  leftVisited.push(await query())
  await pressArrow('ArrowLeft', `${W}/b `, 'Left from a steps back to b')
  await expect.poll(() => replyFrameVisible(W), { message: 'walk reply stays open on b at end of Left round' }).toBe(true)
  leftVisited.push(await query())
  expect(leftVisited, 'Left round visits each child exactly once in reverse order c, a, b').toEqual([
    `${W}/c `,
    `${W}/a `,
    `${W}/b `,
  ])
})

test("a reply's math present before MathJax's startup completes is typeset by the frame's own parser, never by a startup scan", async ({ page }) => {
  // inert_math review 2 R1: MathJax's automatic typesetting at startup scans the whole page with
  // the owner's parser; the app turns it off (src/app.html `startup.typeset: false`) and its own
  // passes wait for the startup (Item.svelte), so content rendered before the startup completes is
  // typeset by the right parser once it is done. The startup is held at its pageReady step (an
  // init script replaces the page's config's `startup.pageReady` with a promise this test
  // releases; the library's own methods exist by then, so the pending state is the unresolved
  // `startup.promise`); meanwhile a frame with a definition and an owner formula are created and
  // their raw spans seen attached; released, the owner's sum is the summation operator and the
  // frame's definition applies within the frame alone
  await page.addInitScript(() => {
    let current: any
    Object.defineProperty(window, 'MathJax', {
      configurable: true,
      get: () => current,
      set: (value: any) => {
        current = value
        // the page's configuration object (the library's own object, assigned later, carries `version`)
        if (current && !current.version)
          current.startup = {
            ...(current.startup ?? {}),
            pageReady: () => new Promise<void>(resolve => void ((window as any).__e2e_release_startup = resolve)),
          }
      },
    })
  })
  await loadAdmin(page)
  await page.evaluate(() => void (window as any).MathJax.startup.promise.then(() => ((window as any).__e2e_started = true)))
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  await page.evaluate(
    text => void window._create(text),
    `#e2e_early_frame reply\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert('early $`\\def\\sum{0}`$ then $`\\sum_i`$')}`
  )
  await page.evaluate(text => void window._create(text), '#e2e_early_owner owner $`\\sum_{i=1}^n x_i`$')
  await page.evaluate(() => void (location.hash = '#e2e_early_owner'))
  const spans = () =>
    page.evaluate(() => ({
      owner: window._item('#e2e_early_owner', true)?.elem?.querySelectorAll('span.math:not([_rendered])').length ?? 0,
      frame: window._item('#e2e_early_frame', true)?.elem?.querySelectorAll('.vault-result span.math:not([_rendered])').length ?? 0,
      held: typeof (window as any).__e2e_release_startup === 'function' && !(window as any).__e2e_started,
    }))
  await expect.poll(() => spans().then(s => `${s.owner},${s.frame},${s.held}`), { timeout: 15_000 }).toBe('1,2,true')
  await page.evaluate(() => void (window as any).__e2e_release_startup())
  const shape = () =>
    page.evaluate(() => {
      const owner = window._item('#e2e_early_owner', true)?.elem
      const frame = window._item('#e2e_early_frame', true)?.elem?.querySelector('.vault-result')
      return {
        started: !!(window as any).__e2e_started,
        ownerContainers: owner?.querySelectorAll('mjx-container').length ?? 0,
        ownerSums: owner?.querySelectorAll('[id$="-2211"]').length ?? 0,
        ownerZeros: owner?.querySelectorAll('[id$="-30"]').length ?? 0,
        frameContainers: frame?.querySelectorAll('mjx-container').length ?? 0,
        frameZeros: frame?.querySelectorAll('[id$="-30"]').length ?? 0,
      }
    })
  await expect.poll(() => shape().then(s => s.ownerContainers), { timeout: 30_000 }).toBe(1)
  const s = await shape()
  expect(s.started, 'the startup completed on release').toBe(true)
  expect(s.ownerSums, "the owner's sum is the summation operator").toBeGreaterThan(0)
  expect(s.ownerZeros, "the frame's definition did not reach the owner's parser").toBe(0)
  await page.evaluate(() => void (location.hash = '#e2e_early_frame'))
  await expect.poll(() => shape().then(s => s.frameContainers), { timeout: 30_000 }).toBe(2)
  expect((await shape()).frameZeros, "the frame's definition applies within the frame").toBeGreaterThan(0)
})

test("a reply's child tags are the item's tags: marks in the frame, navigation, search, the frame otherwise dead", async ({ page, context }) => {
  // vault design mind_chat_children 2.2: the `#/name` tokens of a canonical reply are visible
  // tags of the labeled item (resolved against its label), rendered in the dead frame as the
  // app's marks (title and data attributes, `renderTag`'s display, `missing` from the item's
  // state) and routed to the app's tag handler by the frame's capture listeners (a real click;
  // the keyboard navigation's synthetic non-bubbling mousedown); a mark inside a link's label
  // navigates without firing the anchor; everything else in the frame stays dead; the parent's
  // dependencies gain nothing (a visible tag is no edge); a child appearing or vanishing re-renders
  // the mark (the states live, dangling, live with the selection class reapplied; not node identity)
  await loadAdmin(page)
  const CHAT = '#e2e_cc'
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  const child = (name: string) =>
    `${CHAT}/${name}\n<<agent('vault/default · created in run ab12cd34')>>\n${inert(`${name} body <<not_a_macro>> #/deeper`)}`
  const body = ['## Findings', '', 'see #/alpha and #/beta, code `#/no`, [docs #/alpha](https://example.com/d), x#/none, [gone #/zed](https://example.com/z)', '', '```', '#/fenced', '```'].join('\n')
  // the owner's text names #e2e_cc/beta absolutely while the reply names it relatively (review 0 B1 of the
  // dangling_rank change: the mixed case)
  await page.evaluate(text => void window._create(text), `${CHAT} chat, also #e2e_cc/beta\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert(body)}`)
  await page.evaluate(text => void window._create(text), child('alpha'))
  await page.evaluate(() => void (location.hash = '#e2e_cc'))
  const marks = () =>
    page.evaluate(
      label =>
        [...window._item(label, true)!.elem!.querySelectorAll('.vault-result mark[data-tag]')].map(m => ({
          tag: m.getAttribute('data-tag'),
          rel: m.getAttribute('data-reltag'),
          text: m.textContent,
          missing: m.classList.contains('missing'),
          dangling: m.classList.contains('dangling'),
          selected: m.classList.contains('selected'),
          inAnchor: !!m.closest('a'),
        })),
      CHAT
    )
  await expect.poll(() => marks().then(m => m.length), { timeout: 15_000 }).toBe(4)
  const facts = (name: string) =>
    page.evaluate(n => {
      const i = window._item(n, true) as any
      return i ? { id: i.id as string, tags: [...i.tags].sort() as string[], deps: [...(i.dependencies ?? [])] as string[] } : null
    }, name)
  // a relative tag no item carries is DANGLING, not missing (the owner, 2026-10-03): the token as
  // written, no error border, not clickable
  expect(await marks()).toEqual([
    { tag: '#e2e_cc/alpha', rel: '#/alpha', text: 'alpha', missing: false, dangling: false, selected: false, inAnchor: false },
    { tag: '#e2e_cc/beta', rel: '#/beta', text: '#/beta', missing: false, dangling: true, selected: false, inAnchor: false },
    { tag: '#e2e_cc/alpha', rel: '#/alpha', text: 'alpha', missing: false, dangling: false, selected: false, inAnchor: true },
    { tag: '#e2e_cc/zed', rel: '#/zed', text: '#/zed', missing: false, dangling: true, selected: false, inAnchor: true },
  ])
  // (this fixture's `<<user>>`/`<<agent>>` macros error in the lanes' corpus, so the error border is asserted on the macro-free items below)
  // the lists (index.svelte updateMissingTags): the absolute occurrence keeps #e2e_cc/beta MISSING (the red
  // plain mark, the rank) and out of danglingTags, while the frame's relative mark above renders dangling
  // (an absent target, whichever list holds it); zed, relative only, is dangling
  const lists = (name: string) =>
    page.evaluate(n => {
      const i = ((window as any).__items as any[]).find(i => i.label == n)!
      return { missing: [...i.missingTags].sort(), dangling: [...i.danglingTags].sort() }
    }, name)
  const absoluteMark = () =>
    page.evaluate(
      n => [...window._item(n, true)!.elem!.querySelectorAll('.content mark:not(.label):not([data-tag])')].map(m => [m.className.split(' ').filter(Boolean).sort(), (m as HTMLElement).title]),
      CHAT
    )
  await expect.poll(() => lists(CHAT), { message: 'the mixed case: beta missing, zed dangling' }).toEqual({ missing: ['#e2e_cc/beta'], dangling: ['#e2e_cc/zed'] })
  expect(await absoluteMark(), "the owner's absolute mark").toEqual([[['missing'], '#e2e_cc/beta']])
  const chat = (await facts(CHAT))!
  const alpha = (await facts(`${CHAT}/alpha`))!
  expect(chat.tags, "the child tags are the item's; nothing from code, a link target or an unbounded token").toEqual(['#e2e_cc', '#e2e_cc/alpha', '#e2e_cc/beta', '#e2e_cc/zed'])
  expect(chat.deps, 'a visible tag is no dependency edge').not.toContain(alpha.id)
  expect(alpha.tags, "the child's own #/deeper is the CHILD's child tag").toEqual(['#e2e_cc/alpha', '#e2e_cc/alpha/deeper'])
  // a child's own `#//name` is a SIBLING tag and `#///name` the parent's sibling (the owner's ask,
  // 2026-10-02: a child's text naming another child): the item carries the resolved tags and its
  // frame's marks carry them with the relative form, as the index resolves the item's own tags
  await page.evaluate(text => void window._create(text), `${CHAT}/gamma\n<<agent('vault/default · created in run ab12cd34')>>\n${inert('see the sibling #//alpha and #///zeta')}`)
  await expect.poll(() => facts(`${CHAT}/gamma`).then(f => f?.tags ?? null), { timeout: 15_000 }).toEqual(['#e2e_cc/alpha', '#e2e_cc/gamma', '#zeta'])
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), `${CHAT}/gamma`)
  const gammaMarks = () =>
    page.evaluate(
      label =>
        [...(window._item(label, true)?.elem?.querySelectorAll('.vault-result mark[data-tag]') ?? [])].map(m => [
          m.getAttribute('data-tag'),
          m.getAttribute('data-reltag'),
          m.textContent,
          m.classList.contains('missing'),
          m.classList.contains('dangling'),
        ]),
      `${CHAT}/gamma`
    )
  // the sibling exists: a live mark showing the name; the parent's sibling does not: a dangling mark
  // showing the token as written, no error border, a real click doing nothing
  await expect.poll(gammaMarks, { timeout: 15_000 }).toEqual([
    ['#e2e_cc/alpha', '#//alpha', 'alpha', false, false],
    ['#zeta', '#///zeta', '#///zeta', false, true],
  ])
  const gammaElem = await page.evaluate(label => window._item(label, true)!.elem!.id, `${CHAT}/gamma`)
  // per block of an item: [a toggle's class on it, its frames shown]. A click anywhere on a block toggles it
  // (src/inert_blocks.ts), but a mark's click is the mark's alone: its frame stops it before the block hears it
  const blocks = (id: string) => page.evaluate(id => [...document.querySelectorAll(`[id="${id}"] .inert-block`)].map(block => [block.matches('.opened, .closed'), [...block.querySelectorAll(':scope > .vault-result')].every(frame => frame.getClientRects().length > 0)]), id)
  expect(await blocks(gammaElem), "the premise: the selected item's reply is open, with no toggle made").toEqual([[false, true]])
  await page.locator(`[id="${gammaElem}"] .vault-result mark.dangling`).click()
  await page.waitForTimeout(300)
  expect(await mindbox(page).inputValue(), 'a click on the dangling mark changes nothing').toMatch(/^#e2e_cc\/gamma ?$/)
  expect(await blocks(gammaElem), "nor does it toggle the block around the reply: the block is as it was").toEqual([[false, true]])
  expect(await page.evaluate(id => !!document.querySelector(`[id="${id}"] textarea, .container.editing`), gammaElem), 'no editor either').toBe(false)
  // the same in OWNER-typed bodies (no frame, no macros): a relative tag no item carries is a dangling
  // mark with the token as written and no handler, and the item has no error border; an absolute tag no
  // item carries stays a missing mark with the error border
  await page.evaluate(text => void window._create(text), `${CHAT}/plain\nplain #//nowhere`)
  await page.evaluate(text => void window._create(text), `${CHAT}/plain_abs\nplain #e2e_nowhere_abs`)
  await expect.poll(() => page.evaluate(n => window._item(n, true)?.saved_id ?? null, `${CHAT}/plain_abs`), { timeout: 30_000 }).toBeTruthy()
  const plainMarks = (label: string) =>
    page.evaluate(label => {
      const elem = window._item(label, true)?.elem
      return (
        elem && {
          marks: [...elem.querySelectorAll('.content mark:not(.label)')].map(m => [m.textContent, m.className, m.hasAttribute('onmousedown'), (m as HTMLElement).title]),
          error: !!elem.querySelector('.container.error'),
        }
      )
    }, label)
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), `${CHAT}/plain`)
  await expect.poll(() => plainMarks(`${CHAT}/plain`), { timeout: 15_000 }).toEqual({ marks: [['#//nowhere', 'dangling', false, '#e2e_cc/nowhere']], error: false })
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), `${CHAT}/plain_abs`)
  await expect.poll(() => plainMarks(`${CHAT}/plain_abs`), { timeout: 15_000 }).toEqual({ marks: [['e2e_nowhere_abs', 'missing', true, '#e2e_nowhere_abs']], error: true })
  // HIDDEN relative tags are dependencies and keep their missing diagnostic (review 0 B2): one absent,
  // one whose label two items carry; both `missing hidden`, never dangling, the error border on
  for (const text of [`${CHAT}/dup one`, `${CHAT}/dup two`, `${CHAT}/hid\nhidden deps #_//gone #_//dup`]) await page.evaluate(t => void window._create(t), text)
  await expect.poll(() => page.evaluate(n => window._item(n, true)?.saved_id ?? null, `${CHAT}/hid`), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), `${CHAT}/hid`)
  await expect.poll(() => plainMarks(`${CHAT}/hid`), { timeout: 15_000 }).toEqual({
    marks: [
      ['gone', 'missing hidden', true, '#e2e_cc/gone'],
      ['dup', 'missing hidden', true, '#e2e_cc/dup'],
    ],
    error: true,
  })
  // the LINK emitter on its own: an owner body's link destinations are item tags too (the tag parser
  // reads the whole text, `#//lost` inside `[..](#//lost)` included), so the link mark is `link dangling`
  // with the label markup kept and no handler, like the plain mark beside it; a live one stays a handled
  // `link`. (Its own name: the hidden row above carries `gone` as a dependency, which made a first
  // cut's link live under the other-carrier rule)
  await page.evaluate(t => void window._create(t), `${CHAT}/plain_link\n#//lost [**see** here](#//lost) and [go](#//alpha)`)
  await expect.poll(() => page.evaluate(n => window._item(n, true)?.saved_id ?? null, `${CHAT}/plain_link`), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), `${CHAT}/plain_link`)
  await expect
    .poll(
      () =>
        page.evaluate(label => {
          const elem = window._item(label, true)?.elem
          return elem && [...elem.querySelectorAll('.content mark:not(.label)')].map(m => [m.innerHTML, m.className, m.hasAttribute('onmousedown'), (m as HTMLElement).title])
        }, `${CHAT}/plain_link`),
      { timeout: 15_000 }
    )
    .toEqual([
      ['#//lost', 'dangling', false, '#e2e_cc/lost'],
      ['<strong>see</strong> here', 'link dangling', false, '#e2e_cc/lost'],
      ['go', 'link', true, '#e2e_cc/alpha'],
    ])
  await page.evaluate(() => void (location.hash = '#e2e_cc'))
  await expect.poll(() => marks().then(m => m.length), { timeout: 15_000 }).toBe(4)
  const elemId = await page.evaluate(label => window._item(label, true)!.elem!.id, CHAT)
  const query = () => mindbox(page).inputValue()
  const editing = () => page.evaluate(id => !!document.querySelector(`[id="${id}"] textarea, .container.editing`), elemId)
  // a real click on a mark navigates to the child (the box holds its label); no editor opens
  await page.locator(`[id="${elemId}"] .vault-result mark[data-tag="#e2e_cc/alpha"]`).first().click()
  await expect.poll(query).toBe('#e2e_cc/alpha ')
  expect(await editing(), 'no editor after the mark click').toBe(false)
  // and the reply's block is open for the child's tag (the mark is the search's match), with no toggle made
  await expect.poll(() => blocks(elemId), "the reply's block is open for the child's tag, with no toggle made").toEqual([[false, true]])
  // the mark inside the link's label navigates and the anchor does not fire (no new page)
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), CHAT)
  await expect.poll(query).toMatch(/^#e2e_cc ?$/)
  await page.locator(`[id="${elemId}"] .vault-result a mark[data-tag]`).first().click()
  await expect.poll(query).toBe('#e2e_cc/alpha ')
  await page.waitForTimeout(300)
  expect(context.pages().length, 'the anchor did not open').toBe(1)
  // (the box holds the child's tag, and the chat's reply is open for it: the reply's mark of that tag is its match)
  await expect(page.locator(`[id="${elemId}"] .vault-result mark.selected`).first(), "under the child's tag the reply's section is open").toBeVisible()
  // a DANGLING mark inside a link (review 0 B1): the click navigates nowhere AND still cancels the anchor
  await page.locator(`[id="${elemId}"] .vault-result a mark.dangling`).click()
  await page.waitForTimeout(300)
  expect(await query(), 'the dangling mark navigated nowhere').toBe('#e2e_cc/alpha ')
  expect(context.pages().length, 'and its anchor did not open').toBe(1)
  expect(await blocks(elemId), 'nor did its click toggle the block').toEqual([[false, true]])
  // the dangling mark is not clickable: the synthetic mousedown the keyboard navigation uses leaves
  // the box as it is, while the same mousedown on a live mark reaches the handler
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), CHAT)
  await expect.poll(query).toMatch(/^#e2e_cc ?$/)
  const synthetic = (tag: string) =>
    page.evaluate(
      ([id, tag]) => (document.querySelector(`[id="${id}"] .vault-result mark[data-tag="${tag}"]`) as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { altKey: true })),
      [elemId, tag] as const
    )
  await synthetic('#e2e_cc/beta')
  await page.waitForTimeout(300)
  expect(await query(), 'the dangling mark did nothing').toMatch(/^#e2e_cc ?$/)
  await synthetic('#e2e_cc/alpha')
  await expect.poll(query).toBe('#e2e_cc/alpha ')
  // the second child appears: its mark is live (the frame's render key follows the missing state and
  // the markup is re-rendered) with the selection class reapplied (the box holds its tag); vanishes:
  // dangling again, still selected; appears again. The STATES are asserted, not node identity
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), `${CHAT}/beta`)
  await expect.poll(() => marks().then(m => m[1].selected)).toBe(true)
  await page.evaluate(text => void window._create(text), child('beta'))
  await expect.poll(() => marks().then(m => m[1]), { timeout: 15_000 }).toEqual({ tag: '#e2e_cc/beta', rel: '#/beta', text: 'beta', missing: false, dangling: false, selected: true, inAnchor: false })
  await expect.poll(() => lists(CHAT), { message: 'beta exists: carried, in neither list' }).toEqual({ missing: [], dangling: ['#e2e_cc/zed'] })
  expect(await absoluteMark(), "the owner's absolute mark live (the box holds its tag: selected)").toEqual([[['selected'], '#e2e_cc/beta']])
  const betaDoc = () => page.evaluate(n => window._item(n, true)?.saved_id ?? null, `${CHAT}/beta`)
  await expect.poll(betaDoc, { timeout: 30_000 }).toBeTruthy() // saved: deletable on the server
  await firestore().collection('items').doc((await betaDoc())!).delete()
  await expect.poll(() => marks().then(m => m[1]), { timeout: 15_000 }).toEqual({ tag: '#e2e_cc/beta', rel: '#/beta', text: '#/beta', missing: false, dangling: true, selected: true, inAnchor: false })
  await expect.poll(() => lists(CHAT), { message: 'beta gone: missing again' }).toEqual({ missing: ['#e2e_cc/beta'], dangling: ['#e2e_cc/zed'] })
  expect(await absoluteMark(), "the owner's absolute mark missing again").toEqual([[['missing', 'selected'], '#e2e_cc/beta']])
  await page.evaluate(text => void window._create(text), child('beta'))
  await expect.poll(() => marks().then(m => m[1].dangling), { timeout: 15_000 }).toBe(false)
  await expect.poll(() => lists(CHAT)).toEqual({ missing: [], dangling: ['#e2e_cc/zed'] })
  // Down enters the first child from the chat (the chat's tag order: the owner's absolute #e2e_cc/beta
  // precedes the reply's child tags since the mixed case above), Right moves to the next sibling, Up returns
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), CHAT)
  await expect.poll(query).toMatch(/^#e2e_cc ?$/)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowDown')
  await expect.poll(query).toBe('#e2e_cc/beta ')
  await page.keyboard.press('ArrowRight')
  await expect.poll(query).toBe('#e2e_cc/alpha ')
  await page.keyboard.press('ArrowUp')
  await expect.poll(query).toMatch(/^#e2e_cc ?$/)
  // a tag search for a child lists the chat (the tag is its) with the mark selected
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), `${CHAT}/alpha`)
  await expect.poll(() => marks().then(m => m[0].selected)).toBe(true)
  expect(await visible(page), "the chat is listed under its child's tag").toContain(CHAT)
  // the search by the child's tag has its match INSIDE the reply, the selected mark (the reply reads `#/alpha`,
  // no word of the tag): the reply's section is open for it (src/inert_blocks.ts, holdsTag) and the mark is seen
  await expect(page.locator(`[id="${elemId}"] .vault-result mark.selected`).first(), 'the selected mark shows, with no click on the head').toBeVisible()
  // the frame stays dead for everything else: a text click opens no editor. It is the block's click (a click
  // anywhere on a section toggles its block), so the reply that the search held open is closed by it
  await page.locator(`[id="${elemId}"] .vault-result h2`).click()
  await expect.poll(() => page.evaluate(id => document.querySelector(`[id="${id}"] .inert-block`)!.matches('.closed'), elemId), 'the click on the text closed the block').toBe(true)
  await page.waitForTimeout(300)
  expect(await editing()).toBe(false)
  // PARITY (reviews 2-4, R3): one placement rule for the index and the renderer (src/inert.ts
  // childTagRegions): a region directly after a CHAT BOUNDARY, an `<<agent(...)>>` line alone
  // outside a fence, carries child tags and marks, and the renderer's boundary reset makes it
  // framed whatever comment or declaration the owner's text left open before it (a comment, a
  // declaration, a removed section, tag-shaped text in a question); the rule reads the text as the
  // renderer's block passes leave it with the installed Marked, so a removed section that ate a
  // fence's or a comment's closing line, a fence Marked keeps open, a processing-instruction block
  // or an open raw-text element (in the owner's html or a static _html block; its text would show
  // the reset) leaves the reply unframed AND untagged; every other placement carries neither,
  // framed or not (the image label of the unit table is left out here: its <img> fetches a url, a
  // network round trip this row does not need). The reset leaves no visible text, in a textarea's
  // value included.
  const agent = "<<agent('vault/default · run ab12cd34 · 1s')>>"
  const shapes: [string, string, boolean, boolean][] = [
    // name, the text after the label line, a frame rendered, child tags indexed and marked
    ['opener', `${agent}\n` + inert('#/x'), true, true],
    ['blank', '\n' + inert('#/x'), true, false],
    ['prose', 'prose\n' + inert('#/x'), true, false],
    ['user', '<<user>>\n' + inert('#/x'), true, false],
    ['trailing', `${agent} x\n` + inert('#/x'), true, false],
    ['fence', '\n```\n' + inert('#/x') + '\n```', false, false],
    ['fencedreply', '```\n' + `${agent}\n` + inert('#/x') + '\n```', false, false],
    ['md', '\n```_md\n' + inert('#/x') + '\n```', true, false],
    ['div', '<div>\n' + inert('#/x') + '\n</div>', true, false],
    ['link', '[\n' + inert('#/x') + '\n](https://example.com/)', true, false],
    ['taglink', '[\n' + inert('#/x') + '\n](#foo)', true, false], // (the link shape with a tag for its destination: a mark that acts on the press)
    ['comment', '<!-- c\n\n' + inert('#/x') + '\n-->', false, false],
    ['removed', '<!--removed-->\n\n' + inert('#/x') + '\n<!--/removed-->', false, false],
    ['rawblock', '<style>\n\n' + inert('#/x') + '\n</style>', false, false],
    ['healcomment', `<!-- c\n${agent}\n` + inert('#/x') + '\n-->', true, true],
    ['healremoved', `<!--removed-->\n${agent}\n` + inert('#/x') + '\n<!--/removed-->', true, true],
    ['rawopen', `<style>\n${agent}\n` + inert('#/x') + '\n</style>', false, false], // an open raw-text element declines the reply
    ['textarea', `<textarea>\nowner\n${agent}\n` + inert('#/x') + '\n</textarea>', false, false], // its value shows no reset (asserted below)
    ['tabfence', `~~~\ncode\n~~~\t\n${agent}\n` + inert('#/x'), false, false], // a trailing tab keeps Marked's fence open
    ['declaration', `\n<!OWNER\n${agent}\n` + inert('#/x'), true, true], // the reset's `>` ends a declaration block: healed, nothing shown
    ['pi', `\n<?owner\n${agent}\n` + inert('#/x'), false, false], // a processing instruction block swallows the reply: declined, no reset
    ['htmltextarea', '```_html\n<textarea>\n```\n' + `${agent}\n` + inert('#/x'), false, false], // an open textarea in a static _html block
    ['htmlclosed', '```_html\n<textarea></textarea>\n```\n' + `${agent}\n` + inert('#/x'), true, true],
    ['htmltilde', '~~~_html_removed\n<textarea>\n~~~\n' + `${agent}\n` + inert('#/x'), false, false], // a tilde removed block is not removed: raw html, an open textarea
    // a removed marker from a macro: the rule reads the literal marker inside the macro's quotes and
    // removes from there (the renderer expands it first), the boundary's blank line merges into the
    // leftover `<<'` and the reply is declined; the renderer, told so, resets nothing and the
    // expanded marker's section swallows the reply: neither, consistently (a macro's expansion is
    // outside the rule's reading by design)
    ['macroremoved', `<<'<!--removed-->'>>\n${agent}\n` + inert('#/x') + '\n<!--/removed-->', false, false],
    // the removed pass reads no tilde fence and no comment: a section starting in one eats its
    // closing line, so the reply ends up in code or in the comment, and the rule reads the same
    ['tilderemoved', `~~~\n<!--removed-->\n~~~\n\n${agent}\n` + inert('#/x') + '\n<!--/removed-->', false, false],
    ['commentremoved', `<!--\n<!--removed-->\n-->\n${agent}\n` + inert('#/x') + '\n<!--/removed-->', false, false],
    ['mdtilde', '```_md\n~~~\n```\n' + `${agent}\n` + inert('#/x'), false, false],
    ['mdcomment', '```_md\n<!--\n```\n' + `${agent}\n` + inert('#/x'), true, true],
    ['codequestion', `<<user>> Explain \`<style>\` and <!--\n${agent}\n` + inert('#/x'), true, true],
  ]
  for (const [name, rest, framed, tagged] of shapes) await page.evaluate(text => void window._create(text), `#e2e_sh_${name}\n${rest}`)
  for (const [name, , framed, tagged] of shapes) {
    const label = `#e2e_sh_${name}`
    await page.evaluate(label => void (location.hash = label), label)
    await expect.poll(() => page.evaluate(label => !!window._item(label, true)?.elem?.querySelector('.content'), label), { timeout: 15_000 }).toBe(true)
    const shape = await page.evaluate(label => {
      const item = window._item(label, true) as any
      return {
        frames: item.elem.querySelectorAll('.vault-result').length,
        marks: item.elem.querySelectorAll('.vault-result mark[data-tag]').length,
        tagged: (item.tags as string[]).includes(`${label}/x`),
        text: (item.elem.querySelector('.content') as HTMLElement | null)?.innerText ?? '', // rendered text: a style element's text is not shown
        values: [...item.elem.querySelectorAll('textarea')].map((t: HTMLTextAreaElement) => t.value).join('\n'), // a textarea shows its value
      }
    }, label)
    expect(shape.frames > 0, `${name}: a frame`).toBe(framed)
    expect(shape.tagged, `${name}: the child tag indexed`).toBe(tagged)
    expect(shape.marks > 0, `${name}: marks exactly where the tag is indexed`).toBe(tagged)
    expect(shape.text + '\n' + shape.values, `${name}: the reset shows nothing`).not.toMatch(/\/removed--|\]\]>/) // the reset's own text (a shape's text may show the owner's markers as code) and the fragment of review 6
  }
  // THE BLOCK INSIDE AN OWNER'S LINK (the `link` shape: a region in a Markdown link's label; src/inert_blocks.ts):
  // a click on the region's block (at its corner, beside the reply's mark) toggles the block and nothing else.
  // The owner's link, which holds the block, is not followed: no new page, the same url
  await page.evaluate(() => void (location.hash = '#e2e_sh_link'))
  const linkElem = await page.evaluate(() => window._item('#e2e_sh_link', true)!.elem!.id)
  const linked = () =>
    page.evaluate(id => {
      const block = document.querySelector(`[id="${id}"] .inert-block`)
      return block && { inLink: !!block.closest('a[href^="https://example.com"]'), closed: block.classList.contains('closed'), shown: block.querySelector(':scope > .vault-result')!.getClientRects().length > 0 }
    }, linkElem)
  await expect.poll(linked, "the block stands in the owner's link, open in its selected item").toEqual({ inLink: true, closed: false, shown: true })
  const url = page.url()
  await page.locator(`[id="${linkElem}"] .inert-block`).click({ position: { x: 3, y: 3 } })
  await expect.poll(linked, 'the click closes the block').toEqual({ inLink: true, closed: true, shown: false })
  await page.waitForTimeout(300)
  expect([context.pages().length, page.url()], "and the owner's link is not followed").toEqual([1, url])
  // INSIDE A TAG LINK of the owner's (the `taglink` shape: the same label, `#foo` for its destination). The app
  // renders such a link as a mark that goes to its tag on the PRESS (onmousedown), before any click: the press
  // stops at the block too, so the click toggles and the MindBox is as it was
  await page.evaluate(() => void (location.hash = '#e2e_sh_taglink'))
  const tagElem = await page.evaluate(() => window._item('#e2e_sh_taglink', true)!.elem!.id)
  const tagged = () =>
    page.evaluate(id => {
      const block = document.querySelector(`[id="${id}"] .inert-block`)
      return block && { inTag: !!block.closest('mark.link[onmousedown]'), closed: block.classList.contains('closed'), shown: block.querySelector(':scope > .vault-result')!.getClientRects().length > 0 }
    }, tagElem)
  await expect.poll(tagged, "the block stands in the owner's tag link, open in its selected item").toEqual({ inTag: true, closed: false, shown: true })
  const box = await query()
  await page.locator(`[id="${tagElem}"] .inert-block`).click({ position: { x: 3, y: 3 } })
  await expect.poll(tagged, 'the click closes the block').toEqual({ inTag: true, closed: true, shown: false })
  await page.waitForTimeout(300)
  expect(await query(), 'and the MindBox is as it was: the tag link is not followed').toBe(box)
  // a link of the status line keeps its own default action there: it is followed (the tag link's click
  // handler does not cancel it), the MindBox is as it was, and nothing toggles
  const plan = new URL('/server_id', page.url()).href
  await page.evaluate(text => void window._item('#e2e_sh_taglink')!.write(text, ''), `#e2e_sh_taglink\n[\n${inert(`see [the plan](${plan})`)}\n](#foo)`)
  const statusLink = page.locator(`[id="${tagElem}"] .inert-block > .inert-line > .inert-status a`)
  await expect(statusLink, 'the closed block shows its status line with the link').toBeVisible()
  const followed = context.waitForEvent('page', { timeout: 5_000 })
  await statusLink.click()
  expect((await followed).url(), 'the status link is followed').toBe(plan)
  await (await followed).close()
  expect([await query(), await tagged()], 'the MindBox and the block are as they were').toEqual([box, { inTag: true, closed: true, shown: false }])
})

test("a tag written in an inert section is a quiet link: a click fills the MindBox with the resolved tag, toggles nothing, opens no editor and tags nothing; its press is the browser's; a reply's child tag stays the item's mark", async ({ page }) => {
  // the owner, 2026-11-20 (src/inert_markdown.ts, TAG LINKS; what a tag is has its table in
  // tests/unit/inert_markdown.spec.ts): in every inert section a tag by the app's own rule shows as
  // `code.tag-link`, the item's inline code in a bluish tint, with the resolved tag as its tooltip.
  // a completed primary click on it that is a tap by the section's own test goes to the app's tag
  // handler through the frame's capture listeners, and stops in the frame; its press is left to the
  // browser (a drag from it selects, a secondary press navigates nothing), where a child mark still
  // acts on its press. nothing is tagged and nothing is looked up
  await loadAdmin(page)
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  const TODO = '#e2e_tl/work'
  const CHAT = '#e2e_tlc'
  const tree = ['agent', '- working: see #e2e_tl_bare and `#e2e_tl_code`, then #//sib', '    - [ ] plain `code`, hidden #_e2e_tl_hid, deeper #/a/b'].join('\n')
  for (const text of [
    `${TODO} tlword tidy the shed\n${inert(tree)}\na line of the owner under the tree`,
    `${CHAT} chat\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert('see #/kid and #e2e_tl_full, also `#/kid`')}`,
    `${CHAT}/kid\na child`,
  ])
    await page.evaluate(text => void window._create(text), text)
  await expect.poll(() => page.evaluate(n => window._item(n, true)?.saved_id ?? null, `${CHAT}/kid`), { timeout: 30_000 }).toBeTruthy()
  const select = (label: string) => page.evaluate(label => void (window as any).MindBox.set(label, { scroll: true }), label)
  const box = () => mindbox(page).inputValue()
  // the item on the page (not a mount in the offscreen column)
  const shown = async (label: string) => `.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${await page.evaluate(label => (window as any)._item(label, true).id, label)}"]`
  // an item's tag links as [the tag searched for, the tooltip, the text shown], and its frames' marks
  const links = async (label: string) =>
    page.evaluate(sel => [...document.querySelectorAll(`${sel} .vault-result code.tag-link`)].map(l => [l.getAttribute('data-tag-link'), (l as HTMLElement).title, l.textContent]), await shown(label))
  const marks = async (label: string) =>
    page.evaluate(sel => [...document.querySelectorAll(`${sel} .vault-result mark`)].map(m => [m.getAttribute('data-tag'), m.getAttribute('data-reltag'), m.textContent, m.className]), await shown(label))
  const facts = (label: string) =>
    page.evaluate(label => {
      const item = ((window as any).__items as any[]).find(i => i.label == label)!
      return { tags: [...item.tags].sort(), missing: [...item.missingTags], dangling: [...item.danglingTags] }
    }, label)
  // an item's editor, and per block [a toggle's class on it, its frames shown]
  const state = async (label: string) =>
    page.evaluate(
      sel => ({
        editing: !!document.querySelector(`${sel}.editing, ${sel} textarea`),
        blocks: [...document.querySelectorAll(`${sel} .inert-block`)].map(block => [block.matches('.opened, .closed'), [...block.querySelectorAll(':scope > .vault-result')].every(frame => frame.getClientRects().length > 0)]),
      }),
      await shown(label),
    )
  const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)
  // (a focused MindBox lies over the backdrop that focuses it)
  const focusBox = async () => void ((await focused()) == 'textarea-mindbox' || (await focusMindbox(page)))

  // THE TREE of a todo: a bare tag, a code span that is one tag, a relative tag (the label's sibling) and a
  // deeper relative path are links; the hidden tag and the ordinary code span are what they were
  await select(TODO)
  await expect.poll(() => links(TODO), { timeout: 15_000 }).toEqual([
    ['#e2e_tl_bare', '#e2e_tl_bare', '#e2e_tl_bare'],
    ['#e2e_tl_code', '#e2e_tl_code', '#e2e_tl_code'],
    ['#e2e_tl/sib', '#e2e_tl/sib', '#//sib'],
    ['#e2e_tl/work/a/b', '#e2e_tl/work/a/b', '#/a/b'],
  ])
  const todo = await shown(TODO)
  expect(
    await page.evaluate(sel => {
      const frame = document.querySelector(`${sel} .vault-result`)!
      const status = document.querySelector(`${sel} .inert-block > .inert-line > .inert-status`)!
      return {
        marks: frame.querySelectorAll('mark').length,
        plain: [...frame.querySelectorAll('code:not(.tag-link)')].map(code => code.textContent),
        hidden: frame.textContent!.includes('hidden #_e2e_tl_hid, deeper'),
        key: frame.getAttribute('data-inert-rendered')!.replace(/^[^|]*/, ''),
        status: status.textContent,
      }
    }, todo),
    'no mark stands in the tree (what the dangling key, the selected marks and the search by a tag read), and the status line repeats its first line',
  ).toEqual({ marks: 0, plain: ['code'], hidden: true, key: '|', status: 'working: see #e2e_tl_bare and #e2e_tl_code, then #//sib' })
  expect(await facts(TODO), 'nothing is tagged, and a tag no item carries is nothing missing').toEqual({ tags: [TODO], missing: [], dangling: [] })
  // THE LOOK: the item's inline code (its font and its box) for a bare tag and a code-span tag alike, with a
  // colour and a background of their own in which blue leads; no underline; the pointer
  const look = await page.evaluate(sel => {
    const style = (e: Element) => {
      const s = getComputedStyle(e)
      return { font: [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight].join(' | '), box: [s.padding, s.borderRadius, s.borderStyle].join(' | '), color: s.color, background: s.backgroundColor, line: s.textDecorationLine, cursor: s.cursor }
    }
    const frame = document.querySelector(`${sel} .vault-result`)!
    const [bare, span] = frame.querySelectorAll('code.tag-link')
    return { code: style(frame.querySelector('code:not(.tag-link)')!), bare: style(bare), span: style(span) }
  }, todo)
  const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number)
  expect(look.bare, 'a bare tag and a code-span tag look alike').toEqual(look.span)
  expect({ ...look.bare, color: look.code.color, background: look.code.background }, "the ordinary code span's font, box and pointer").toEqual(look.code)
  expect([look.bare.line, look.bare.cursor]).toEqual(['none', 'pointer'])
  for (const [mine, plain] of [
    [look.bare.color, look.code.color],
    [look.bare.background, look.code.background],
  ]) {
    expect(mine, 'a tint of its own').not.toBe(plain)
    expect(rgb(mine)[2], `blue leads in ${mine}`).toBeGreaterThan(Math.max(rgb(mine)[0], rgb(mine)[1]))
  }

  // THE CLOSED LINE shows its tags in the inline code style (the owner, 2026-11-20): the status line's copy
  // (src/inert_blocks.ts) keeps a tag link as the same element, with its tooltip, inside the one line,
  // which is as tall as a line of the item's text, as before. there the tag is the line's, NO LINK: it
  // has the PLAIN inline code look, none of the section's tint (the owner: a tint "would suggest a click
  // would follow the link"), and a click on it opens the section, as a click anywhere on the closed line
  // does, and searches for nothing (the frame's listeners do not reach the head)
  await page.evaluate(() => void (window as any).MindBox.set('tlword'))
  const closed = async () =>
    page.evaluate(sel => {
      const block = document.querySelector(`${sel} .inert-block`) as HTMLElement
      const status = block.querySelector(':scope > .inert-line > .inert-status')!
      const style = getComputedStyle(block)
      // the colour, the background and the pointer of an element as computed; `code` is what an ordinary
      // inline code span gets in that place (a span put into the status line for the reading, then taken out)
      const look = (e: Element) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor, getComputedStyle(e).cursor].join(' ')
      const tags = [...status.children]
      const span = status.appendChild(document.createElement('code'))
      span.textContent = 'x'
      const looks = { tags: tags.map(look), code: look(span), link: look(block.querySelector('.vault-result code.tag-link')!) }
      span.remove()
      return {
        shown: [status.getClientRects().length > 0, [...block.querySelectorAll(':scope > .vault-result')].some(frame => frame.getClientRects().length > 0)],
        // the block with its margins, in lines of the item's text
        lines: Math.round(((block.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom)) / parseFloat(getComputedStyle(block.closest('.content')!).lineHeight)) * 100) / 100,
        tags: tags.map(tag => [tag.tagName, tag.className, tag.getAttribute('title'), tag.textContent]),
        looks,
      }
    }, await shown(TODO))
  await expect.poll(async () => ({ ...(await closed()), looks: 0 }), 'the closed line is one line, and holds its tags as tag link elements with their tooltips').toEqual({
    shown: [true, false],
    lines: 1,
    tags: [
      ['CODE', 'tag-link', '#e2e_tl_bare', '#e2e_tl_bare'],
      ['CODE', 'tag-link', '#e2e_tl_code', '#e2e_tl_code'],
      ['CODE', 'tag-link', '#e2e_tl/sib', '#//sib'],
    ],
    looks: 0,
  })
  const { looks } = await closed()
  expect(looks.tags, 'in the closed line a tag has the plain inline code look: the colour, the background and the pointer of an ordinary code span there').toEqual([looks.code, looks.code, looks.code])
  expect(looks.link, "which is not the tint its link has in the section").not.toBe(looks.code)
  await page.locator(`${await shown(TODO)} .inert-block > .inert-line > .inert-status code.tag-link`).first().click()
  await expect.poll(() => state(TODO), 'a click on a tag in the closed line opens the section').toEqual({ editing: false, blocks: [[true, true]] })
  expect(await box(), 'and searches for nothing').toBe('tlword')

  // what the page hears of a tag link's presses and clicks, as `phase:type:button`: on the way down to it
  // (`capture`, at the window) and on the way back up (`bubble`: an event that was stopped in the frame
  // never gets there)
  await page.evaluate(() => {
    const w = window as any
    w.__tag_link_events = []
    for (const type of ['mousedown', 'click'])
      for (const capture of [true, false])
        window.addEventListener(type, e => (e.target as Element).closest?.('code.tag-link') && w.__tag_link_events.push(`${capture ? 'capture' : 'bubble'}:${type}:${(e as MouseEvent).button}`), capture)
  })
  const events = () => page.evaluate(() => ((window as any).__tag_link_events as string[]).splice(0))
  const CLICK = ['capture:mousedown:0', 'bubble:mousedown:0', 'capture:click:0'] // a press that went on to the page, and a click that stopped in the frame
  const OPEN = { editing: false, blocks: [[false, true]] } // open by the selection, no toggle made, no editor
  // the selected todo's n-th tag link: shown, at rest, with no selection standing and nothing heard yet
  const ready = async (n = 0) => {
    await page.evaluate(() => getSelection()!.removeAllRanges())
    await select(TODO)
    const link = page.locator(`${await shown(TODO)} .vault-result code.tag-link`).nth(n)
    await expect(link, 'the selected todo shows its tree').toBeVisible()
    await expect.poll(() => state(TODO), 'the premise: open by the selection, no toggle made').toEqual(OPEN)
    await link.scrollIntoViewIfNeeded()
    let last = ''
    await expect.poll(async () => last == (last = JSON.stringify(await link.boundingBox())), { intervals: [100] }).toBe(true)
    await events()
    return link
  }
  const selection = () => page.evaluate(() => [getSelection()!.type, getSelection()!.toString()])

  // A DRAG THAT STARTS ON A TAG LINK SELECTS TEXT, as on any word of a section (the owner copies tags): the
  // press is the browser's, and the click that ends the drag, on the link that holds the selection, is no
  // tap: nothing navigates, nothing toggles
  let link = await ready()
  const at = (await link.boundingBox())!
  await page.mouse.move(at.x + 8, at.y + at.height / 2)
  await page.mouse.down()
  await page.mouse.move(at.x + at.width - 8, at.y + at.height / 2, { steps: 5 })
  await page.mouse.up()
  const dragged = await selection()
  expect([dragged[0], dragged[1].length > 3 && '#e2e_tl_bare'.includes(dragged[1])], `the drag selected a part of the tag: ${dragged[1]}`).toEqual(['Range', true])
  expect(await events(), 'the press went on to the page, and the click that ended the drag stopped in the frame').toEqual(CLICK)
  expect([await box(), await state(TODO)], 'a drag from a tag link navigates nothing and toggles nothing').toEqual([TODO, OPEN])
  // THE CLICK THAT ONLY ENDS A SELECTION standing in the section is no tap either (the section's own rule): a
  // click on another tag link, beside the selected text, ends the selection and navigates nothing; the
  // next click on that link is the tap
  const second = page.locator(`${await shown(TODO)} .vault-result code.tag-link`).nth(1)
  await second.click()
  expect([(await selection())[0] == 'Range', await events()], 'the click ended the selection, and stopped in the frame').toEqual([false, CLICK])
  expect([await box(), await state(TODO)], 'the click that ends a selection navigates nothing and toggles nothing').toEqual([TODO, OPEN])
  await second.click()
  await expect.poll(box, 'the next click is the tap').toBe('#e2e_tl_code ')
  // A CLICK OF ANOTHER BUTTON, which no browser makes, navigates nothing (with no selection standing: the
  // button alone decides here), and A SECONDARY PRESS is the browser's too (its context menu; it can select
  // the word it lands on): it navigates nothing
  link = await ready()
  await link.evaluate(link => void link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 2 })))
  expect([(await selection())[0] == 'Range', await events()], 'a click of another button, with nothing selected, stops in the frame').toEqual([false, ['capture:click:2']])
  expect([await box(), await state(TODO)], 'a click of another button navigates nothing and toggles nothing').toEqual([TODO, OPEN])
  await link.click({ button: 'right' })
  expect(await events(), 'the secondary press went on to the page').toEqual(['capture:mousedown:2', 'bubble:mousedown:2'])
  expect([await box(), await state(TODO)], 'a secondary press navigates nothing and toggles nothing').toEqual([TODO, OPEN])

  // A CLICK ON EACH fills the MindBox with the resolved tag, as a click on a tag does (the tag and a space):
  // the whole tag wherever the click lands, since the text shown is the tag as written. it stops in the
  // frame, so it toggles no block and opens no editor (after the first, the todo is still listed, by the
  // tag's text in its tree, and its section is open by that match with no toggle on it)
  for (const [n, tag] of [
    [0, '#e2e_tl_bare'],
    [1, '#e2e_tl_code'],
    [2, '#e2e_tl/sib'],
  ] as const) {
    await (await ready(n)).click()
    await expect.poll(box, `a click on ${tag}`).toBe(tag + ' ')
    expect(await events(), 'the press went on to the page; the click acted and stopped in the frame').toEqual(CLICK)
    expect(await page.evaluate(() => [!!document.querySelector('.container.editing'), document.querySelectorAll('.inert-block:is(.opened, .closed)').length]), 'no editor, no toggle').toEqual([false, 0])
    if (n == 0) await expect.poll(() => state(TODO), "the todo's section under the tag's search").toEqual(OPEN)
  }
  // the premise of "stopped in the frame": a click beside a tag link, on the ordinary code span, reaches the
  // block, which closes (a click anywhere on a block toggles it)
  await ready()
  await page.locator(`${await shown(TODO)} .vault-result code:not(.tag-link)`).click()
  await expect.poll(() => state(TODO), 'the click beside a link reaches the block').toEqual({ editing: false, blocks: [[true, false]] })

  // A REPLY: the child tag is the item's mark as before and the item carries it; the full tag beside it, and
  // the same child form in a code span, are links, which the item does not carry
  await select(CHAT)
  await expect.poll(() => marks(CHAT), { timeout: 15_000 }).toEqual([['#e2e_tlc/kid', '#/kid', 'kid', '']])
  expect(await links(CHAT)).toEqual([
    ['#e2e_tl_full', '#e2e_tl_full', '#e2e_tl_full'],
    ['#e2e_tlc/kid', '#e2e_tlc/kid', '#/kid'],
  ])
  expect((await facts(CHAT)).tags, "the item's tags: its label and the child tag").toEqual([CHAT, `${CHAT}/kid`])
  await page.locator(`${await shown(CHAT)} .vault-result code.tag-link`).first().click()
  await expect.poll(box, 'a click on the full tag').toBe('#e2e_tl_full ')
  // the child mark's press, for comparison: it goes to the child, and moves no focus either
  await select(CHAT)
  const mark = page.locator(`${await shown(CHAT)} .vault-result mark[data-tag]`)
  await expect(mark).toBeVisible()
  await focusBox()
  await mark.click()
  await expect.poll(box, 'a click on the child mark').toBe(`${CHAT}/kid `)
  expect(await focused(), "the child mark's press moves no focus").toBe('textarea-mindbox')

  // THE CLOSED LINE AT A PHONE'S WIDTH, where it is longer than its block: still the one line, cut with an
  // ellipsis; a tag link in it does not wrap (inline code may) and stands inside the line's own box, so
  // nothing of the line spills out of the block
  await page.setViewportSize({ width: 375, height: 667 })
  await page.evaluate(() => void (window as any).MindBox.set('tlword'))
  const narrow = async () =>
    page.evaluate(sel => {
      const block = document.querySelector(`${sel} .inert-block`) as HTMLElement | null
      const head = block?.querySelector(':scope > .inert-line')?.getBoundingClientRect()
      const status = block?.querySelector(':scope > .inert-line > .inert-status') as HTMLElement | null
      if (!block || !head || !status || !status.getClientRects().length) return null
      const style = getComputedStyle(block)
      const within = (inner: DOMRect, outer: DOMRect) => inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5
      return {
        width: innerWidth,
        lines: Math.round(((block.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom)) / parseFloat(getComputedStyle(block.closest('.content')!).lineHeight)) * 100) / 100,
        cut: [status.scrollWidth > status.clientWidth, getComputedStyle(status).textOverflow],
        line: within(status.getBoundingClientRect(), head), // the status line's box is the head's: one line
        tags: [...status.querySelectorAll('code.tag-link')].map(tag => within(tag.getBoundingClientRect(), status.getBoundingClientRect())),
      }
    }, await shown(TODO))
  await expect.poll(narrow, "the closed line at a phone's width").toEqual({ width: 375, lines: 1, cut: [true, 'ellipsis'], line: true, tags: [true, true, true] })
})

test("an inline-code command in an inert section is a quiet link: one-tap /_update of an installed default-repo item runs directly; other commands confirm first without changing MindBox text or focus; drag and closed line run nothing", async ({ page }) => {
  // the owner, 2026-11-23 (src/inert_markdown.ts COMMAND LINKS, src/command_links.ts option B):
  // an inline-code command in an inert section shows as `code.command-link` in the tag link's look.
  // Only `/_update` of an already-installed item from the default repo (`olcan/mind.items`, served
  // locally by loadAdmin's interceptMindItems) runs at one tap; every other command first shows
  // "Run this command?" with the exact literal text (no Markdown/HTML/URL interpretation), where
  // Enter/Run runs it and Escape/Cancel runs nothing, keeping MindBox text and focus untouched.
  await loadAdmin(page)
  const evilRequests: string[] = []
  const attackerRequests: string[] = []
  const progressGate = { waiting: false, release: () => {} }
  await page.route('https://api.github.com/repos/olcan/mind.items/commits*', async route => {
    const file = new URL(route.request().url()).searchParams.get('path') ?? ''
    if (file === '**prog**.md') {
      await new Promise<void>(resolve => {
        progressGate.waiting = true
        progressGate.release = resolve
      })
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    }
    return route.fallback()
  })
  await page.route('https://evil.example/**', route => {
    evilRequests.push(route.request().url())
    return route.abort()
  })
  await page.route('https://api.github.com/repos/attacker/**', route => {
    attackerRequests.push(route.request().url())
    return route.abort()
  })
  page.on('request', req => {
    if (req.url().includes('evil.example')) evilRequests.push(req.url())
    if (req.url().includes('/repos/attacker/')) attackerRequests.push(req.url())
  })
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  const TODO = '#e2e_cl/work'
  const CMD = '#commands/e2e_cl_cmd'
  const LISTEN = '#e2e_cl_listen'
  const UNKNOWN = '/e2e_cl_missing $x **bold** <em id="e2e_alert_tag">hi</em>'
  const BAD_RENAME = '/_rename **bad** _tag_'
  const PROG_INSTALL = '/_install **prog**'
  const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'
  const HOSTILE = '/e2e_cl_evil `x` ![img](https://evil.example/px.png) [lnk](https://evil.example) <b id="e2e_evil">hi</b> https://evil.example/u $`a`$'
  const tree = [
    'agent',
    '- run `/_invert` or `/e2e_cl_cmd echo hi` (not `/Users/x/y` or `plain`)',
    `- more: \`/_zoom 1.05\`, \`/_count\`, \`/e2e_cl_cmd one two\`, \`/e2e_cl_cmd create\`, \`${UNKNOWN}\`, \`${BAD_RENAME}\`, \`${PROG_INSTALL}\`, \`#e2e_cl_tag\` cldraft`,
    `- updates: \`/_update mind_sync\`, \`/_update mind_sync mind.items preview\`, \`/_update #mind_sync\`, \`/_update mind_sync mind.items ${COMMIT_SHA}\`, \`/_update mind_sync mind.items preview attacker\``,
    `- hostile: \`\` ${HOSTILE} \`\``,
  ].join('\n')
  const cmdItem = [
    CMD,
    '```js',
    'function run(args, a, b) {',
    '  window.__e2e_cl_ran = (window.__e2e_cl_ran || []).concat([[args, a, b]])',
    "  if (a == 'echo') return 'would overwrite and focus box'",
    "  if (a == 'create') return { text: '#e2e_cl_created_item from handler', edit: false }",
    '}',
    '```',
  ].join('\n')
  const listenItem = [
    `${LISTEN} #_listen`,
    '```js',
    'function _on_create(text) {',
    '  window.__e2e_cl_created = (window.__e2e_cl_created || []).concat([text])',
    '}',
    '```',
  ].join('\n')
  for (const text of [cmdItem, listenItem, `${TODO} clword tidy the shed\n${inert(tree)}\na line of the owner under the tree`])
    await page.evaluate(text => void window._create(text), text)
  for (const label of [TODO, CMD, LISTEN])
    await expect.poll(() => page.evaluate(n => window._item(n, true)?.saved_id ?? null, label), { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(() => {
    ;(window as any).__e2e_cl_ran = []
    ;(window as any).__e2e_cl_created = []
    localStorage.removeItem('mindpage_inverted')
    localStorage.removeItem('mindpage_zoom')
  })
  const select = (label: string) => page.evaluate(label => void (window as any).MindBox.set(label, { scroll: true }), label)
  const box = () => mindbox(page).inputValue()
  const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)
  const focusBox = async () => void ((await focused()) == 'textarea-mindbox' || (await focusMindbox(page)))
  const blurBox = () => page.evaluate(() => void (document.activeElement as HTMLElement | null)?.blur())
  const shown = async (label: string) => `.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${await page.evaluate(label => (window as any)._item(label, true).id, label)}"]`
  const cmdLinks = async (label: string) =>
    page.evaluate(sel => [...document.querySelectorAll(`${sel} .vault-result code.command-link`)].map(l => [l.getAttribute('data-command-link'), (l as HTMLElement).title, l.textContent]), await shown(label))
  const state = async (label: string) =>
    page.evaluate(
      sel => ({
        editing: !!document.querySelector(`${sel}.editing, ${sel} textarea`),
        blocks: [...document.querySelectorAll(`${sel} .inert-block`)].map(block => [block.matches('.opened, .closed'), [...block.querySelectorAll(':scope > .vault-result')].every(frame => frame.getClientRects().length > 0)]),
      }),
      await shown(label),
    )
  const inverted = () => page.evaluate(() => [localStorage.getItem('mindpage_inverted'), getComputedStyle(document.documentElement).filter == 'invert(1)'])
  const zoomVal = () => page.evaluate(() => localStorage.getItem('mindpage_zoom'))
  const ran = () => page.evaluate(() => ((window as any).__e2e_cl_ran as string[][]).slice())
  const settle = () => page.evaluate(() => new Promise(r => setTimeout(r, 80)))
  const OPEN = { editing: false, blocks: [[false, true]] }
  const modal = page.locator('.modal')
  const expectConfirm = async (cmd: string, reason = `command ${cmd} shows Run this command? confirmation dialog`, full = false) => {
    await expect(modal, reason).toBeVisible({ timeout: 3000 })
    await expect(modal, reason).toContainText('Run this command?', { timeout: 3000 })
    if (full) {
      const info = await page.evaluate(() => {
        const m = document.querySelector('.modal')!
        const body = [...m.children].filter(el => !el.classList.contains('buttons'))
        const innerTags = body.flatMap(el => [...el.querySelectorAll('*')].map(n => n.tagName))
        return {
          paragraphs: body.map(el => el.tagName),
          innerTags,
          code: m.querySelector('code')?.textContent ?? null,
          buttons: [...m.querySelectorAll('.buttons .button')].map(b => b.textContent?.trim()),
        }
      })
      expect(info, `confirmation dialog renders exact literal text for ${cmd} with Run/Cancel buttons`).toEqual({
        paragraphs: ['P', 'P'],
        innerTags: ['CODE'],
        code: cmd,
        buttons: ['Cancel', 'Run'],
      })
    } else {
      await expect(modal.locator('code'), `confirmation dialog shows exact text for ${cmd}`).toHaveText(cmd)
    }
  }

  // RENDERING & LOOK: all inline-code commands render as `code.command-link` elements (path and plain
  // span stay ordinary code, the tag code span stays `code.tag-link`, no mark), styled like `code.tag-link`
  await select(TODO)
  const todo = await shown(TODO)
  await expect(page.locator(`${todo} .vault-result[data-inert-rendered]`)).toBeVisible({ timeout: 15_000 })
  expect(await cmdLinks(TODO), 'all inline-code commands render as command links').toEqual([
    ['/_invert', '/_invert', '/_invert'],
    ['/e2e_cl_cmd echo hi', '/e2e_cl_cmd echo hi', '/e2e_cl_cmd echo hi'],
    ['/_zoom 1.05', '/_zoom 1.05', '/_zoom 1.05'],
    ['/_count', '/_count', '/_count'],
    ['/e2e_cl_cmd one two', '/e2e_cl_cmd one two', '/e2e_cl_cmd one two'],
    ['/e2e_cl_cmd create', '/e2e_cl_cmd create', '/e2e_cl_cmd create'],
    [UNKNOWN, UNKNOWN, UNKNOWN],
    [BAD_RENAME, BAD_RENAME, BAD_RENAME],
    [PROG_INSTALL, PROG_INSTALL, PROG_INSTALL],
    ['/_update mind_sync', '/_update mind_sync', '/_update mind_sync'],
    ['/_update mind_sync mind.items preview', '/_update mind_sync mind.items preview', '/_update mind_sync mind.items preview'],
    ['/_update #mind_sync', '/_update #mind_sync', '/_update #mind_sync'],
    [`/_update mind_sync mind.items ${COMMIT_SHA}`, `/_update mind_sync mind.items ${COMMIT_SHA}`, `/_update mind_sync mind.items ${COMMIT_SHA}`],
    ['/_update mind_sync mind.items preview attacker', '/_update mind_sync mind.items preview attacker', '/_update mind_sync mind.items preview attacker'],
    [HOSTILE, HOSTILE, HOSTILE],
  ])
  const looks = await page.evaluate(sel => {
    const frame = document.querySelector(`${sel} .vault-result`)!
    const style = (e: Element) => {
      const s = getComputedStyle(e)
      return { font: [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight].join(' | '), box: [s.padding, s.borderRadius, s.borderStyle].join(' | '), color: s.color, background: s.backgroundColor, line: s.textDecorationLine, cursor: s.cursor }
    }
    return {
      marks: frame.querySelectorAll('mark').length,
      tags: [...frame.querySelectorAll('code.tag-link')].map(c => c.textContent),
      plain: [...frame.querySelectorAll('code:not(.tag-link):not(.command-link)')].map(c => c.textContent),
      cmd: style(frame.querySelector('code.command-link')!),
      tag: style(frame.querySelector('code.tag-link')!),
      code: style(frame.querySelector('code:not(.tag-link):not(.command-link)')!),
    }
  }, todo)
  expect([looks.marks, looks.tags, looks.plain]).toEqual([0, ['#e2e_cl_tag'], ['/Users/x/y', 'plain']])
  expect(looks.cmd, 'a command link has the exact look of a tag link').toEqual(looks.tag)
  expect([looks.cmd.line, looks.cmd.cursor]).toEqual(['none', 'pointer'])
  expect(looks.cmd.color).not.toBe(looks.code.color)

  // CLOSED LINE: plain inline code look (no tint, no pointer); clicking it opens the section and runs nothing
  await page.evaluate(() => void (window as any).MindBox.set('clword'))
  const closed = async () =>
    page.evaluate(sel => {
      const block = document.querySelector(`${sel} .inert-block`) as HTMLElement
      const status = block.querySelector(':scope > .inert-line > .inert-status')!
      const style = getComputedStyle(block)
      const look = (e: Element) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor, getComputedStyle(e).cursor].join(' ')
      const cmds = [...status.querySelectorAll('code.command-link')]
      const span = status.appendChild(document.createElement('code'))
      span.textContent = 'x'
      const plainLook = look(span)
      span.remove()
      return {
        shown: [status.getClientRects().length > 0, [...block.querySelectorAll(':scope > .vault-result')].some(frame => frame.getClientRects().length > 0)],
        lines: Math.round(((block.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom)) / parseFloat(getComputedStyle(block.closest('.content')!).lineHeight)) * 100) / 100,
        cmds: cmds.map(c => [c.tagName, c.className, c.getAttribute('title'), c.textContent]),
        looks: { cmds: cmds.map(look), plain: plainLook, open: look(block.querySelector('.vault-result code.command-link')!) },
      }
    }, await shown(TODO))
  await expect.poll(async () => ({ ...(await closed()), looks: 0 }), 'the closed line is one line and holds its command links').toEqual({
    shown: [true, false],
    lines: 1,
    cmds: [
      ['CODE', 'command-link', '/_invert', '/_invert'],
      ['CODE', 'command-link', '/e2e_cl_cmd echo hi', '/e2e_cl_cmd echo hi'],
    ],
    looks: 0,
  })
  const closedLooks = (await closed()).looks
  expect(closedLooks.cmds, 'in the closed line a command has the plain inline code look').toEqual([closedLooks.plain, closedLooks.plain])
  expect(closedLooks.open, 'which is not the tinted link look in the open frame').not.toBe(closedLooks.plain)
  await page.locator(`${await shown(TODO)} .inert-block > .inert-line > .inert-status code.command-link`).first().click()
  await expect.poll(() => state(TODO), 'clicking the closed line opens the section').toEqual({ editing: false, blocks: [[true, true]] })
  expect([await box(), await inverted(), await ran()], 'the closed line click runs nothing and leaves MindBox alone').toEqual(['clword', [null, false], []])
  await expect(modal).toBeHidden()

  // record what the window hears on command links (capture vs bubble)
  await page.evaluate(() => {
    const w = window as any
    w.__cmd_link_events = []
    for (const type of ['mousedown', 'click'])
      for (const capture of [true, false])
        window.addEventListener(type, e => (e.target as Element).closest?.('code.command-link') && w.__cmd_link_events.push(`${capture ? 'capture' : 'bubble'}:${type}:${(e as MouseEvent).button}`), capture)
  })
  const events = () => page.evaluate(() => ((window as any).__cmd_link_events as string[]).splice(0))
  const CLICK = ['capture:mousedown:0', 'bubble:mousedown:0', 'capture:click:0']
  const cmdAt = async (cmd: string) => {
    const attr = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const link = page.locator(`${await shown(TODO)} .vault-result code.command-link[data-command-link="${attr}"]`)
    await expect(link).toBeVisible()
    await link.scrollIntoViewIfNeeded()
    let last = ''
    await expect.poll(async () => last == (last = JSON.stringify(await link.boundingBox())), { intervals: [100] }).toBe(true)
    await events()
    return link
  }

  // UNFOCUSED MINDBOX: non-one-tap commands ask first ("Run this command?"); Escape and Cancel run
  // nothing, Enter runs the command; MindBox text and focus stay untouched in every case
  await select(TODO)
  await expect.poll(() => state(TODO)).toEqual(OPEN)
  await blurBox()
  expect(await focused(), 'premise: MindBox is unfocused').not.toBe('textarea-mindbox')

  await (await cmdAt('/_invert')).click()
  await expectConfirm('/_invert', 'non-one-tap /_invert asks first instead of running at one tap', true)
  expect(await events(), 'press reached the page; click stopped in the frame').toEqual(CLICK)
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  await settle()
  expect(await inverted(), 'Escape in confirmation dialog runs nothing').toEqual([null, false])
  expect(await box(), 'Escape keeps unfocused MindBox text').toBe(TODO)
  expect(await focused(), 'Escape does not focus unfocused MindBox').not.toBe('textarea-mindbox')

  await (await cmdAt('/_invert')).click()
  await expectConfirm('/_invert')
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await settle()
  expect(await inverted(), 'Cancel button in confirmation dialog runs nothing').toEqual([null, false])
  expect(await box(), 'Cancel button keeps unfocused MindBox text').toBe(TODO)
  expect(await focused(), 'Cancel button does not focus unfocused MindBox').not.toBe('textarea-mindbox')

  await (await cmdAt('/_invert')).click()
  await expectConfirm('/_invert')
  await page.keyboard.press('Enter')
  await expect(modal).toBeHidden()
  await expect.poll(inverted, { message: 'Enter in confirmation dialog runs /_invert', timeout: 3000 }).toEqual(['true', true])
  expect(await box(), 'confirmed /_invert keeps unfocused MindBox text').toBe(TODO)
  expect(await focused(), 'confirmed /_invert does not focus unfocused MindBox').not.toBe('textarea-mindbox')
  expect(await state(TODO), 'no toggle, no editor').toEqual(OPEN)

  await (await cmdAt('/e2e_cl_cmd echo hi')).click()
  await expectConfirm('/e2e_cl_cmd echo hi')
  await page.keyboard.press('Enter')
  await expect(modal).toBeHidden()
  await expect.poll(ran, 'confirmed /e2e_cl_cmd runs the #commands item').toEqual([['echo hi', 'echo', 'hi']])
  await settle()
  expect(await box(), 'item command returning a string keeps unfocused MindBox text').toBe(TODO)
  expect(await focused(), 'item command returning a string does not focus unfocused MindBox').not.toBe('textarea-mindbox')

  // confirmed unknown command carries `$`, emphasis, and HTML: dispatcher alert shows original command
  // as plain literal text (no backslash-escaped `$`, no `code` wrapper, no strong/em/HTML element)
  await (await cmdAt(UNKNOWN)).click()
  await expectConfirm(UNKNOWN)
  await page.keyboard.press('Enter')
  await expect(modal, 'unknown command alert renders original command as literal text').toContainText(`unknown command ${UNKNOWN}`)
  expect(
    await page.evaluate(() => ({
      strong: document.querySelectorAll('.modal strong').length,
      em: document.querySelectorAll('.modal em').length,
      code: document.querySelectorAll('.modal code').length,
      alertTag: !!document.querySelector('#e2e_alert_tag'),
    })),
    'unknown command alert renders command as plain literal text (no strong, em, code, or html element)',
  ).toEqual({ strong: 0, em: 0, code: 0, alertTag: false })
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  expect(await box(), 'unknown command alert keeps unfocused MindBox text').toBe(TODO)
  expect(await focused(), 'dismissing the alert does not focus unfocused MindBox').not.toBe('textarea-mindbox')

  // confirmed `/_rename` with invalid Markdown-formatted argument: refusal alert renders punctuation literally
  await (await cmdAt(BAD_RENAME)).click()
  await expectConfirm(BAD_RENAME)
  await page.keyboard.press('Enter')
  await expect(modal, 'invalid /_rename alert renders emphasis punctuation as literal text').toContainText(
    "/_rename: invalid tag '**bad**' (expected a visible absolute tag like #tag)",
  )
  expect(
    await page.evaluate(() => ({
      strong: document.querySelectorAll('.modal strong').length,
      em: document.querySelectorAll('.modal em').length,
    })),
    'invalid /_rename alert creates no strong or em elements',
  ).toEqual({ strong: 0, em: 0 })
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()

  // confirmed `/_install **prog**`: progress dialog renders path as literal text (no strong element)
  progressGate.waiting = false
  await (await cmdAt(PROG_INSTALL)).click()
  await expectConfirm(PROG_INSTALL)
  await page.keyboard.press('Enter')
  try {
    await expect.poll(() => progressGate.waiting, { message: 'install progress request intercepted', timeout: 10_000 }).toBe(true)
    await expect(modal, 'install progress modal renders path as literal text').toContainText('Installing **prog**.md ...')
    expect(
      await page.evaluate(() => document.querySelectorAll('.modal strong').length),
      'install progress modal creates no strong element from path',
    ).toBe(0)
  } finally {
    progressGate.release()
    progressGate.waiting = false
  }
  await page.evaluate(() => (window as any)._mindbox_return)
  await expect(modal).toBeHidden()

  // HOSTILE COMMAND: backticks, image, link, raw HTML, naked URL, `$` render as literal text only
  // inside the confirmation dialog — zero img/a/b elements, zero network requests to evil.example
  await (await cmdAt(HOSTILE)).click()
  await expectConfirm(HOSTILE, 'hostile command dialog renders exact text only with no Markdown, HTML, image, or link', true)
  expect(
    await page.evaluate(() => ({
      imgs: document.querySelectorAll('.modal img').length,
      links: document.querySelectorAll('.modal a').length,
      evilEl: !!document.querySelector('#e2e_evil'),
    })),
    'hostile command dialog creates no image, link, or injected element',
  ).toEqual({ imgs: 0, links: 0, evilEl: false })
  expect(evilRequests, 'hostile command dialog triggers no request to evil.example').toEqual([])
  await modal.locator('.button.cancel').click()
  await expect(modal).toBeHidden()
  await settle()
  expect(await box()).toBe(TODO)
  expect(await focused()).not.toBe('textarea-mindbox')

  // ONE-TAP `/_update` ON AN INSTALLED DEFAULT-REPO ITEM (`olcan/mind.items`, served locally), on the
  // writable ANONYMOUS notebook that `loadAdmin` opens with the publisher's fixture account: install
  // `mind_sync` (plain prose, no deps or _init), mark it stale, then tap `/_update mind_sync` (no
  // branch, so `master`; unfocused): it runs directly with NO "Run this command?" dialog, restores
  // the text, and leaves the MindBox unfocused and untouched. A `preview` update asks first here and
  // the row cancels it (one tap for `preview` is the publisher's own notebook only: the unit table
  // holds that option), and an owner argument (`attacker`) asks first too.
  expect(await install(page, 'mind_sync')).toBeNull()
  const origMindSync = await page.evaluate(() => {
    const it = window._item('#mind_sync') as any
    const orig = it.text as string
    it.write('#mind_sync stale', '')
    it.pushable = false
    return orig
  })
  await expect.poll(() => page.evaluate(() => window._item('#mind_sync', true)?.text)).toBe('#mind_sync stale')
  await select(TODO)
  await expect.poll(() => state(TODO)).toEqual(OPEN)
  await blurBox()
  await page.evaluate(() => {
    const w = window as any
    w.__e2e_cl_modals = []
    const m = document.querySelector('.modal')!
    const obs = new MutationObserver(() => {
      if (m.closest('.background.visible')) w.__e2e_cl_modals.push(m.textContent ?? '')
    })
    obs.observe(m, { childList: true, subtree: true, characterData: true })
    w.__e2e_cl_obs = obs
  })

  const dismissUpdated = async (reason: string) => {
    await expect(modal, reason).toContainText('Updated #mind_sync', { timeout: 15_000 })
    await modal.locator('.button.confirm', { hasText: 'OK' }).click()
    const skip = modal.locator('.button.cancel', { hasText: 'Skip' })
    await expect.poll(async () => (await modal.isHidden()) || (await skip.isVisible()), { timeout: 10_000 }).toBe(true)
    if (await skip.isVisible()) await skip.click()
    await expect(modal).toBeHidden()
  }

  // no-branch `/_update mind_sync` runs at one tap on the anonymous notebook (defaults to `master`),
  // leaving no GitHub token in live item attributes (checked while the write is still in flight,
  // before onSaveDone strips it) or in the saved `items` / newest `history` records
  await waitWritesSettled(page, '#mind_sync')
  const mindSyncId = (await savedId(page, '#mind_sync'))!
  expect(mindSyncId, 'installed #mind_sync has a saved id').toBeTruthy()
  await expect
    .poll(async () => (await historyRecords(mindSyncId)).length, {
      message: '#mind_sync pre-update history copies written',
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(2)
  const histIdsBeforeUpdate = new Set((await historyRecords(mindSyncId)).map(h => h.id))

  let releaseWrite!: () => void
  const writeGate = new Promise<void>(resolve => {
    releaseWrite = resolve
  })
  const writePattern = /Firestore\/Write\/channel/
  await page.route(writePattern, async route => {
    if (route.request().method() == 'POST') await writeGate
    await route.continue()
  })
  try {
    await (await cmdAt('/_update mind_sync')).click()
    await expect(modal, 'one-tap /_update completes directly without confirmation').toContainText('Updated #mind_sync', {
      timeout: 15_000,
    })
    expect(
      (await readItemState(page, '#mind_sync'))?.hasAttrToken,
      'one-tap /_update live item attributes hold no token',
    ).toBe(false)
    releaseWrite()
    await page.unroute(writePattern)
    await dismissUpdated('one-tap /_update completes directly without confirmation')
  } finally {
    releaseWrite()
    await page.unroute(writePattern).catch(() => {})
  }
  await waitWritesSettled(page, '#mind_sync')
  await expect
    .poll(async () => (await historyRecords(mindSyncId)).some(h => !histIdsBeforeUpdate.has(h.id)), {
      message: 'one-tap /_update wrote a new history copy',
      timeout: 30_000,
    })
    .toBe(true)
  const updatedItemRecord = await itemRecord(mindSyncId)
  const newestHistory = (await historyRecords(mindSyncId))
    .filter(h => !histIdsBeforeUpdate.has(h.id))
    .sort((a, b) => (b.raw.time ?? 0) - (a.raw.time ?? 0))[0]
  expect(
    newestHistory.raw.text,
    'one-tap /_update newest history copy carries updated text',
  ).toBe(origMindSync)
  expect(
    updatedItemRecord.rawSerialized,
    'one-tap /_update serialized items record holds no GitHub token',
  ).not.toContain(FAKE_GITHUB_TOKEN)
  expect(
    newestHistory.rawSerialized,
    'one-tap /_update newest history copy holds no GitHub token',
  ).not.toContain(FAKE_GITHUB_TOKEN)
  expect(
    await readItemState(page, '#mind_sync'),
    'one-tap /_update settled live item attributes hold no token',
  ).toMatchObject({
    textMatches: true,
    attrMatches: true,
    hasAttrToken: false,
    hasSavedAttrToken: false,
  })
  expect(
    await page.evaluate(() => ((window as any).__e2e_cl_modals as string[]).some(t => t.includes('Run this command?'))),
    'one-tap /_update never showed Run this command? dialog',
  ).toBe(false)
  expect(await page.evaluate(() => [(window._item('#mind_sync', true) as any)?.text, (window._item('#mind_sync', true) as any)?.attr?.branch])).toEqual([origMindSync, 'master'])
  expect(await box(), 'one-tap /_update keeps unfocused MindBox text').toBe(TODO)
  expect(await focused(), 'one-tap /_update does not focus unfocused MindBox').not.toBe('textarea-mindbox')

  // one-tap label-binding refusal: relabel the installed item to `#e2e_cl_renamed` (its attr.path
  // stays `mind_sync.md`) and create a second plain note labeled `#mind_sync`. Tapping the PATH-form
  // link dispatches by `#e2e_cl_renamed`, so the dispatcher refuses the label mismatch (logs to
  // console.error; the app's own `finally` cancels the alert modal for any failed root update),
  // shows no "Updated" dialog, and leaves BOTH notes untouched (with the raw path dispatched
  // instead, the plain note would be overwritten with install attributes).
  await page.evaluate(() => {
    const it = window._item('#mind_sync') as any
    it.write('#e2e_cl_renamed local copy', '')
    it.pushable = false
    window._create('#mind_sync plain note untouched')
  })
  await expect.poll(() => page.evaluate(() => window._item('#mind_sync', true)?.saved_id ?? null), { timeout: 30_000 }).toBeTruthy()
  await expect.poll(() => page.evaluate(() => [window._item('#e2e_cl_renamed', true)?.text, window._item('#mind_sync', true)?.text])).toEqual([
    '#e2e_cl_renamed local copy',
    '#mind_sync plain note untouched',
  ])
  await select(TODO)
  await expect.poll(() => state(TODO)).toEqual(OPEN)
  await blurBox()
  const labelMismatchErrors: string[] = []
  const onConsoleError = (msg: { type: () => string; text: () => string }) => {
    if (msg.type() === 'error') labelMismatchErrors.push(msg.text())
  }
  page.on('console', onConsoleError)
  const modalCountBeforeRefusal = await page.evaluate(() => ((window as any).__e2e_cl_modals as string[]).length)
  try {
    await (await cmdAt('/_update mind_sync')).click()
    let refusalOutcome = 'pending'
    await expect
      .poll(
        async () => {
          const updated = await page.evaluate(
            n => ((window as any).__e2e_cl_modals as string[]).slice(n).some(t => t.includes('Updated')),
            modalCountBeforeRefusal,
          )
          if (updated) refusalOutcome = 'updated'
          else if (labelMismatchErrors.some(t => t.includes('does not match specified label')))
            refusalOutcome = 'refused'
          return refusalOutcome
        },
        { message: 'one-tap path update settles to refusal or update', timeout: 15_000 },
      )
      .not.toBe('pending')
    expect(
      refusalOutcome,
      'one-tap path update bound to item label refuses label mismatch rather than updating plain note',
    ).toBe('refused')
  } finally {
    page.off('console', onConsoleError)
  }
  await page.evaluate(() => (window as any)._mindbox_return)
  await expect(modal, 'failed root /_update leaves no modal open').toBeHidden()
  expect(
    await page.evaluate(
      n => ((window as any).__e2e_cl_modals as string[]).slice(n).some(t => t.includes('Updated')),
      modalCountBeforeRefusal,
    ),
    'label-mismatch refusal showed no Updated dialog',
  ).toBe(false)
  expect(
    labelMismatchErrors.some(t => t.includes('does not match specified label')),
    'label-mismatch refusal logged dispatcher mismatch error to console',
  ).toBe(true)
  expect(
    await page.evaluate(() => {
      const plain = window._item('#mind_sync', true) as any
      return {
        renamed: window._item('#e2e_cl_renamed', true)?.text,
        plain: plain?.text,
        installAttrs: [plain?.attr?.owner ?? null, plain?.attr?.repo ?? null, plain?.attr?.path ?? null, plain?.attr?.branch ?? null],
      }
    }),
    'label-mismatch refusal leaves both renamed installed item and plain note (and its lack of install attrs) untouched',
  ).toEqual({
    renamed: '#e2e_cl_renamed local copy',
    plain: '#mind_sync plain note untouched',
    installAttrs: [null, null, null, null],
  })
  await page.evaluate(() => {
    window._item('#mind_sync', true)?.delete(false)
    const it = window._item('#e2e_cl_renamed') as any
    it.write('#mind_sync stale2', '')
    it.pushable = false
  })
  await expect.poll(() => page.evaluate(() => window._item('#mind_sync', true)?.text)).toBe('#mind_sync stale2')

  // on the anonymous notebook (loadAdmin, not the publisher's own notebook), `preview` asks first
  await (await cmdAt('/_update mind_sync mind.items preview')).click()
  await expectConfirm('/_update mind_sync mind.items preview', 'preview branch asks first on anonymous notebook (not publisher own notebook)')
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  expect(await page.evaluate(() => window._item('#mind_sync', true)?.text)).toBe('#mind_sync stale2')

  // a 40-hex commit id as the branch is NOT one tap — must ask first
  await (await cmdAt(`/_update mind_sync mind.items ${COMMIT_SHA}`)).click()
  await expectConfirm(`/_update mind_sync mind.items ${COMMIT_SHA}`, '40-hex commit id branch asks first and is not one tap')
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()

  // owner argument on `/_update` is NEVER one tap — must show the confirmation dialog
  await (await cmdAt('/_update mind_sync mind.items preview attacker')).click()
  await expectConfirm('/_update mind_sync mind.items preview attacker', '/_update with an owner argument asks first and is not one tap')
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  expect(attackerRequests, 'cancelled /_update with owner made no request to attacker').toEqual([])
  expect(await box()).toBe(TODO)
  expect(await focused()).not.toBe('textarea-mindbox')

  // FOCUSED MINDBOX WITH A DRAFT: Escape, Enter, Run button, item commands (undefined and
  // `{ text, edit: false }`), fall-through `/_count`, and one-tap `/_update #mind_sync` all
  // preserve BOTH the draft AND MindBox focus
  await page.evaluate(() => void (window as any).MindBox.set('clword'))
  await expect.poll(() => state(TODO)).toEqual({ editing: false, blocks: [[false, false]] })
  await focusBox()
  await mindbox(page).fill('cldraft')
  await expect(page.locator(`${await shown(TODO)} .vault-result code.command-link`).first()).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => state(TODO)).toEqual(OPEN)
  expect([await box(), await focused()], 'premise: MindBox holds the draft and has focus').toEqual(['cldraft', 'textarea-mindbox'])

  await (await cmdAt('/_invert')).click()
  await expectConfirm('/_invert')
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  expect(await inverted(), 'Escape with draft runs nothing').toEqual(['true', true])
  expect([await box(), await focused()], 'Escape keeps draft and focus').toEqual(['cldraft', 'textarea-mindbox'])

  await (await cmdAt('/_invert')).click()
  await expectConfirm('/_invert')
  await page.keyboard.press('Enter')
  await expect(modal).toBeHidden()
  await expect.poll(inverted, { message: 'Enter toggles inversion off', timeout: 3000 }).toEqual(['false', false])
  expect([await box(), await focused()], 'confirmed /_invert keeps draft and focus').toEqual(['cldraft', 'textarea-mindbox'])

  await (await cmdAt('/_zoom 1.05')).click()
  await expectConfirm('/_zoom 1.05')
  await modal.locator('.button.confirm').click()
  await expect(modal).toBeHidden()
  await expect.poll(zoomVal, { message: 'Run button ran /_zoom 1.05', timeout: 3000 }).toBe('1.05')
  expect([await box(), await focused()], 'Run button keeps draft and focus').toEqual(['cldraft', 'textarea-mindbox'])

  await (await cmdAt('/e2e_cl_cmd one two')).click()
  await expectConfirm('/e2e_cl_cmd one two')
  await page.keyboard.press('Enter')
  await expect(modal).toBeHidden()
  await expect.poll(ran, 'confirmed item command ran with its args').toEqual([
    ['echo hi', 'echo', 'hi'],
    ['one two', 'one', 'two'],
  ])
  expect([await box(), await focused()], 'item command returning undefined keeps draft and focus').toEqual(['cldraft', 'textarea-mindbox'])

  // confirmed `/_count` falls through to item creation while a draft sits in MindBox:
  // creates its item, passes '' (not the draft) to `_on_create` listeners, and keeps the draft & focus
  await page.evaluate(() => {
    ;(window as any).__e2e_cl_created = []
  })
  await (await cmdAt('/_count')).click()
  await expectConfirm('/_count')
  await page.keyboard.press('Enter')
  await expect(modal).toBeHidden()
  await expect
    .poll(() => page.evaluate(() => ((window as any).__items as any[]).find(i => /^\d+ items are selected$/.test(i.text))?.id ?? null), { timeout: 10_000 })
    .toBeTruthy()
  await expect
    .poll(() => page.evaluate(() => ((window as any).__e2e_cl_created as string[]).slice()), {
      message: 'confirmed /_count passes empty string to _on_create listeners instead of MindBox draft',
      timeout: 5000,
    })
    .toEqual([''])
  expect([await box(), await focused()], 'confirmed /_count keeps draft and focus').toEqual(['cldraft', 'textarea-mindbox'])
  await page.evaluate(() => {
    const created = ((window as any).__items as any[]).find(i => /^\d+ items are selected$/.test(i.text))
    if (created) window._item(created.id, true)?.delete(false)
  })

  // confirmed item command returning `{ text, edit: false }` (as `/todo` does) while a draft sits
  // in MindBox: creates the item, passes '' (not the restored draft) to `_on_create`, keeps draft & focus
  await page.evaluate(() => {
    ;(window as any).__e2e_cl_created = []
  })
  await (await cmdAt('/e2e_cl_cmd create')).click()
  await expectConfirm('/e2e_cl_cmd create')
  await page.keyboard.press('Enter')
  await expect(modal).toBeHidden()
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_cl_created_item', true)?.text ?? null), {
      message: 'confirmed handler returning { text, edit: false } creates its item',
      timeout: 10_000,
    })
    .toBe('#e2e_cl_created_item from handler')
  await expect
    .poll(() => page.evaluate(() => ((window as any).__e2e_cl_created as string[]).slice()), {
      message: 'confirmed handler returning { text, edit: false } passes empty string to _on_create listeners instead of MindBox draft',
      timeout: 5000,
    })
    .toEqual([''])
  expect([await box(), await focused()], 'confirmed handler creation keeps draft and focus').toEqual(['cldraft', 'textarea-mindbox'])
  await page.evaluate(() => window._item('#e2e_cl_created_item', true)?.delete(false))

  // one-tap `/_update #mind_sync` while MindBox is focused with a draft
  await page.evaluate(() => {
    ;(window as any).__e2e_cl_modals = []
  })
  await (await cmdAt('/_update #mind_sync')).click()
  await dismissUpdated('one-tap /_update #label completes without confirmation')
  await settle()
  expect(
    await page.evaluate(() => ((window as any).__e2e_cl_modals as string[]).some(t => t.includes('Run this command?'))),
    'one-tap /_update #label never showed Run this command? dialog',
  ).toBe(false)
  expect(await page.evaluate(() => [(window._item('#mind_sync', true) as any)?.text, (window._item('#mind_sync', true) as any)?.attr?.branch])).toEqual([origMindSync, 'master'])
  expect([await box(), await focused()], 'one-tap /_update #label keeps draft and focus').toEqual(['cldraft', 'textarea-mindbox'])

  // DRAG, SELECTION-ENDING CLICK, AND SECONDARY PRESS: none opens a dialog, runs a command, or toggles the block
  await blurBox()
  await select(TODO)
  await expect.poll(() => state(TODO)).toEqual(OPEN)
  await page.evaluate(() => getSelection()!.removeAllRanges())
  const inv = await cmdAt('/_invert')
  await expect
    .poll(() => inv.evaluate(el => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.left + 6, r.top + r.height / 2))
    }))
    .toBe(true)
  const at = (await inv.boundingBox())!
  await page.mouse.move(at.x + 6, at.y + at.height / 2)
  await page.mouse.down()
  await page.mouse.move(at.x + at.width - 6, at.y + at.height / 2, { steps: 5 })
  await page.mouse.up()
  const sel = await page.evaluate(() => [getSelection()!.type, getSelection()!.toString()])
  expect([sel[0], sel[1].length > 2 && '/_invert'.includes(sel[1])], `drag selected part of /_invert: ${sel[1]}`).toEqual(['Range', true])
  expect(await events(), 'drag press bubbled and its click stopped in the frame').toEqual(CLICK)
  expect([await inverted(), await state(TODO)], 'drag ran nothing and toggled nothing').toEqual([['false', false], OPEN])
  await expect(modal).toBeHidden()

  // a click on another command link while the selection stands ends the selection and runs nothing
  await (await cmdAt('/e2e_cl_cmd one two')).click()
  expect(await page.evaluate(() => getSelection()!.type == 'Range'), 'selection ended').toBe(false)
  expect([(await ran()).length, await state(TODO)], 'selection-ending click ran nothing and toggled nothing').toEqual([3, OPEN])
  await expect(modal).toBeHidden()

  // secondary press and non-primary click run nothing
  await (await cmdAt('/_invert')).click({ button: 'right' })
  expect(await events()).toEqual(['capture:mousedown:2', 'bubble:mousedown:2'])
  await (await cmdAt('/_invert')).evaluate(el => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 2 })))
  expect(await events()).toEqual(['capture:click:2'])
  expect([await inverted(), await state(TODO)], 'secondary press and non-primary click ran nothing').toEqual([['false', false], OPEN])
  await expect(modal).toBeHidden()

  // clean up installed #mind_sync, listener, and observer
  await page.evaluate(() => {
    ;(window as any).__e2e_cl_obs?.disconnect()
    window._item('#mind_sync', true)?.delete(false)
    window._item('#e2e_cl_listen', true)?.delete(false)
  })
})

test('a deleted child that held macro expansions turns its tags missing (dangling for the frame\'s relative marks): the marks in the frame and plain tags alike', async ({ page }) => {
  // the owner's report (2026-10-01): the bridge's children carry an `<<agent(...)>>` macro, so a
  // child once rendered or pre-expanded holds expansion state (expanded.item); deleting it cleared
  // its text with that stale expansion still merged into its tag counts (tagsExpandedWithMacros),
  // so its label stayed counted twice and no tagger turned `missing`: the chat's marks in the
  // inert frame, but equally a plain tag in another item. Both deletion paths (the app's own and
  // the listener's removal) drop the expansion state before the clearing text change. Each child
  // here has ONE tagger (a tag carried by two items is never missing)
  await loadAdmin(page)
  const CHAT = '#e2e_cc_gone'
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  // a macro the lane can evaluate stands in for the bridge's `<<agent(...)>>` line
  const child = (name: string) => `${CHAT}/${name}\n<<'created in run ab12cd34'>>\n${name} body`
  await page.evaluate(text => void window._create(text), `${CHAT} chat\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert('see #/alpha and #/beta')}`)
  await page.evaluate(text => void window._create(text), `${CHAT}/plain a plain tag ${CHAT}/gamma`)
  for (const name of ['alpha', 'beta', 'gamma']) await page.evaluate(text => void window._create(text), child(name))
  await page.evaluate(() => (window as any).MindBox.set('e2e_cc_gone', { scroll: true })) // a text query: every item renders
  // the state the marks report, [text, missing, dangling]: the chat's frame marks (relative: dangling
  // once their item is gone, the token as written) and the plain item's absolute tag mark (missing)
  const state = () =>
    page.evaluate(label => {
      const marks = (n: string, sel: string) =>
        [...(window._item(n, true)?.elem?.querySelectorAll(sel) ?? [])]
          .filter(m => /alpha|beta|gamma/.test(m.textContent ?? ''))
          .map(m => [m.textContent, m.classList.contains('missing'), m.classList.contains('dangling')])
      return { chat: marks(label, '.vault-result mark[data-tag]'), plain: marks(`${label}/plain`, 'mark') }
    }, CHAT)
  // (the head line of the reply's block, src/inert_blocks.ts, repeats the reply's first line as text: the deletion redraws the item, and the new head has the mark's new text)
  const head = () => page.evaluate(label => window._item(label, true)?.elem?.querySelector('.inert-block > .inert-line > .inert-status')?.textContent ?? null, CHAT)
  await expect.poll(state, { timeout: 15_000 }).toEqual({ chat: [['alpha', false, false], ['beta', false, false]], plain: [['gamma', false, false]] })
  expect(await head()).toBe('see alpha and beta')
  // each child holds expansion state: the macro-evaluating read records it (expandMacros' path)
  for (const name of ['alpha', 'beta', 'gamma'])
    expect(await page.evaluate(n => window._item(n)!.read('', { eval_macros: true }), `${CHAT}/${name}`)).toContain('created in run ab12cd34')
  // the app's own deletion (no confirmation): the plain tag turns missing and the frame's mark dangling alike
  expect(await page.evaluate(n => window._item(n)!.delete(false), `${CHAT}/gamma`)).toBe(true)
  await expect.poll(state, { timeout: 15_000 }).toEqual({ chat: [['alpha', false, false], ['beta', false, false]], plain: [['gamma', true, false]] })
  expect(await page.evaluate(n => window._item(n)!.delete(false), `${CHAT}/alpha`)).toBe(true)
  await expect.poll(state, { timeout: 15_000 }).toEqual({ chat: [['#/alpha', false, true], ['beta', false, false]], plain: [['gamma', true, false]] })
  expect(await head(), 'the head line has the mark as the frame shows it').toBe('see #/alpha and beta')
  // the listener's removal (the server's delete)
  const betaDoc = () => page.evaluate(n => window._item(n, true)?.saved_id ?? null, `${CHAT}/beta`)
  await expect.poll(betaDoc, { timeout: 30_000 }).toBeTruthy()
  await firestore().collection('items').doc((await betaDoc())!).delete()
  await expect.poll(state, { timeout: 15_000 }).toEqual({ chat: [['#/alpha', false, true], ['#/beta', false, true]], plain: [['gamma', true, false]] })
})

test('an inert body supplies visible tags only: a sibling form resolving to a control tag is refused', async ({ page }) => {
  // review 15 B1: a reply's `#//_autodep` under a root chat resolves to `#_autodep`, which the
  // lineage reads from tagsRaw as the carrier flag; the index refuses a resolved hidden tag from
  // an inert body and the frame shows the token as text, so the chat is no carrier and its
  // tag-free child adopts nothing; the owner's own `#_autodep` in ordinary text still works
  await loadAdmin(page)
  const inert = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
  const reply = (body: string) => `<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n${inert(body)}`
  for (const text of [
    `#e2e_ctl chat\n${reply('see #//_autodep and #///_autodep and #/safe')}`, // the control forms: text
    '#e2e_ctl/kid\n<<user>> tag-free child',
    `#e2e_ctl_real #_autodep\n${reply('see #/safe')}`, // the owner's own carrier tag: as before
    '#e2e_ctl_real/kid\n<<user>> tag-free child',
  ])
    await page.evaluate(t => void window._create(t), text)
  const facts = (name: string) =>
    page.evaluate(n => {
      const i = window._item(n, true) as any
      return i ? { tags: [...i.tags].sort(), deps: [...(i.dependencies ?? [])].map((id: string) => (window._item(id, true) as any).label) } : null
    }, name)
  // (the dependency lists are compared by membership: the seeded account's own items can join a
  // closure through the carrier tag's reference, as the parent-tag fixture of admin.spec.ts notes)
  await expect.poll(() => facts('#e2e_ctl_real/kid').then(f => f?.deps ?? null), { timeout: 15_000 }).toContain('#e2e_ctl_real')
  expect((await facts('#e2e_ctl'))!.tags).toEqual(['#e2e_ctl', '#e2e_ctl/safe']) // no #_autodep
  expect((await facts('#e2e_ctl/kid'))!.deps).not.toContain('#e2e_ctl') // adopts nothing
  expect((await facts('#e2e_ctl_real'))!.tags).toEqual(['#autodep', '#e2e_ctl_real', '#e2e_ctl_real/safe']) // the item API lists a hidden tag without its underscore
  await page.evaluate(() => void (location.hash = '#e2e_ctl'))
  await expect
    .poll(() => page.evaluate(() => [...(window._item('#e2e_ctl', true)?.elem?.querySelectorAll('.vault-result mark[data-tag]') ?? [])].map(m => m.getAttribute('data-reltag'))), { timeout: 15_000 })
    .toEqual(['#/safe'])
  expect(await page.evaluate(() => window._item('#e2e_ctl', true)?.elem?.querySelector('.vault-result')?.textContent ?? '')).toContain('#//_autodep and #///_autodep')
})

test('inert regions render dead: valid decoded text and malformed candidates', async ({ page }) => {
  // the combined hostile-result witness (bridge design §2.2, reviews 141-146) in TWO
  // phases: (a) a VALID envelope whose DECODED text carries every active item grammar,
  // and (b) a MALFORMED raw candidate whose BODY carries the same payloads. phase (a)
  // alone could false-green (a canonical base64 body is inert before decoding), so (b)
  // is what proves the scanner masks candidate ranges from item state/macros/tags.
  // serve the built route stylesheet with charset=windows-1252 (bytes unchanged) so that any raw
  // UTF-8 tick emitted into the stylesheet decodes to the garbled characters seen in the owner's
  // damaged window (2026-11-22) and fails the computed-content checks below
  let overriddenSheets = 0
  await page.route('**/_app/immutable/assets/*.css', async route => {
    overriddenSheets++
    const res = await route.fetch()
    await route.fulfill({ response: res, contentType: 'text/css; charset=windows-1252' })
  })
  await loadAdmin(page)
  const hostile = [
    '<<user>> q',
    '<<window._pwned = 1>>', // store-writing macro
    '<script>window._pwned = 2</script>', // inline script (the app executes these)
    '<img src=x onerror="window._pwned=3">', // event-handler attribute
    '[click](javascript:window._pwned=4)', // javascript: link
    '#_autorun #_style #chat/gpt', // special + provider tags
    '```js_input', // input block => runnable item
    'window._pwned = 5',
    '```',
  ].join('\n')
  const footer = "vault/default · run ab12cd34 · 1s"
  // (a) VALID region: the escaped body IS the hostile text (it contains no
  // close-shaped sequences), and the decoded display must change nothing
  await page.evaluate(
    ([footer, hostile]) => {
      void window._create(
        `#e2e_vault_valid its reply\n<<user>> q\n<<agent('${footer}')>>\n` +
          '<!--inert-->\n' +
          hostile +
          '\n<!--/inert-->'
      )
      ;(window as any)._hostile = hostile
    },
    [footer, hostile] as const
  )
  await page.evaluate(() => void (location.hash = '#e2e_vault_valid'))
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_vault_valid', true)?.elem), { timeout: 15_000 }).toBe(true)
  const state = (name: string) =>
    page.evaluate(name => {
      const item = window._item(name, true) as any
      return {
        pwned: (window as any)._pwned ?? null,
        runnable: !!item?.runnable,
        tags: (item?.tags ?? []).join(' '),
        rendered: item?.elem?.querySelector('.content')?.textContent ?? '',
        // the dead frame holds the inert-markdown policy's html only (design §2.2a, amended
        // 2026-09-05): every element is one the policy emits, none carries an event-handler
        // attribute, and no anchor has a non-http(s)/mailto destination -- any other element or
        // attribute means decoded bytes reached the html grammar
        frameViolations: [...(item?.elem?.querySelectorAll('.vault-result *') ?? [])].filter(el => {
          const allowed = ['DIV', 'P', 'PRE', 'CODE', 'SPAN', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'EM', 'STRONG', 'DEL', 'HR', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']
          if (!allowed.includes(el.tagName)) return true
          if ([...el.attributes].some(a => a.name.startsWith('on'))) return true
          if (el.tagName != 'A') return false
          // the wiki links exception (design wiki_links 2.7): the app-built anchor under the
          // setting, its href the configured handler's query, no target or rel
          if (el.hasAttribute('data-wiki-link')) {
            const config = (window as any)._wiki_links
            // its href is the app's own under the setting: the url with `{link}` replaced by
            // base64url text and nothing after it, else `url?path=`
            const href = el.getAttribute('href') ?? ''
            const [head, tail] = String(config?.url).split('{link}')
            const packed = href.startsWith(head) && href.endsWith(tail ?? '') && /^[A-Za-z0-9_-]+$/.test(href.slice(head.length, href.length - (tail ?? '').length))
            const built = tail === undefined ? href.startsWith(head + '?path=') : packed
            return !config || !built || el.hasAttribute('target') || el.hasAttribute('rel')
          }
          return !/^(?:https?|mailto):/i.test(el.getAttribute('href') ?? '')
        }).length,
        frameText: item?.elem?.querySelector('.vault-result')?.textContent ?? '',
        frameChildren: item?.elem?.querySelector('.vault-result')?.children.length ?? -1,
        frameRendered: item?.elem?.querySelector('.vault-result')?.hasAttribute('data-inert-rendered') ?? null,
        liveNodes: [
          ...(item?.elem?.querySelectorAll('.content script, .content img, .content [onerror], .content a[href^="javascript:"]') ??
            []),
        ].length,
        // count over the GRAMMAR VIEW (the internal item's lctext, not the _Item
        // wrapper's raw text): a malformed candidate legitimately still contains its
        // raw bytes in item.text, and the whole point is that the grammar view does not
        messages:
          (window.__items.find(entry => entry.labelText == name) as any)?.lctext?.match(/<<user>>/g)?.length ?? 0,
      }
    }, name)
  const valid = await state('#e2e_vault_valid')
  expect(valid.pwned, 'no macro/script/handler/link executed').toBeNull()
  expect(valid.runnable, 'decoded input block did not make the item runnable').toBe(false)
  expect(valid.tags, 'decoded tags did not enter item state').not.toContain('#_autorun')
  expect(valid.tags).not.toContain('#chat/gpt')
  expect(valid.rendered, 'the decoded payload displays literally').toContain('window._pwned = 1')
  expect(valid.frameViolations, 'the frame holds only the policy html: no foreign element, handler, or bad anchor').toBe(0)
  expect(valid.frameText, 'the hostile spellings display literally inside the frame').toContain('<<window._pwned = 1>>')
  expect(valid.frameText).toContain('<script>window._pwned = 2</script>')
  expect(valid.liveNodes, 'no script/img/handler/javascript-link element was created').toBe(0)
  expect(valid.messages, 'the decoded <<user>> is not a delimiter in the grammar view').toBe(1)
  // (b) MALFORMED candidate: the same payloads as RAW body, opaque and placeholdered
  await page.evaluate(
    hostile =>
      void window._create(
        '#e2e_vault_bad malformed\n<<user>> q\n<!--inert-->\nnot canonical <!--/inert--> x\n' + hostile + '\n<!--/inert-->'
      ),
    hostile
  )
  await page.evaluate(() => void (location.hash = '#e2e_vault_bad'))
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_vault_bad', true)?.elem), { timeout: 15_000 }).toBe(true)
  const bad = await state('#e2e_vault_bad')
  expect(bad.pwned, 'raw hostile body executed nothing').toBeNull()
  expect(bad.runnable, 'raw input block did not make the item runnable').toBe(false)
  expect(bad.tags, 'raw tags did not enter item state').not.toContain('#_autorun')
  expect(bad.tags).not.toContain('#chat/gpt')
  expect(bad.rendered, 'the invalid candidate renders the fixed placeholder').toContain('⟦invalid inert region⟧')
  expect(bad.rendered, 'raw candidate bytes are not displayed').not.toContain('window._pwned')
  // the malformed candidate's frame is EXACTLY the placeholder text node: no markdown rendering,
  // no child element, no rendered marker
  expect(bad.frameText, 'the invalid placeholder is the frame text').toBe('⟦invalid inert region⟧')
  expect(bad.frameChildren, 'the invalid placeholder is a text node').toBe(0)
  expect(bad.frameRendered, 'no markdown was rendered for a malformed candidate').toBe(false)
  expect(bad.liveNodes, 'no script/img/handler/javascript-link element was created').toBe(0)
  expect(bad.messages, 'the raw <<user>> is not a delimiter in the grammar view').toBe(1)
  // a CANONICAL body that merely equals the placeholder string is a valid value: it renders
  // as inert markdown (a child element, the rendered marker), unlike the malformed candidate
  await page.evaluate(
    () =>
      void window._create(
        "#e2e_vault_placeholder_body reply\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n<!--inert-->\n⟦invalid inert region⟧\n<!--/inert-->"
      )
  )
  await page.evaluate(() => void (location.hash = '#e2e_vault_placeholder_body'))
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_vault_placeholder_body', true)?.elem?.querySelector('.vault-result')), { timeout: 15_000 }).toBe(true)
  const lookalike = await state('#e2e_vault_placeholder_body')
  expect(lookalike.frameText).toBe('⟦invalid inert region⟧')
  expect(lookalike.frameChildren, 'a canonical body equal to the placeholder is still rendered as markdown').toBeGreaterThan(0)
  expect(lookalike.frameRendered).toBe(true)
  expect(lookalike.frameViolations).toBe(0)
  // the read path (grammar view) masks candidate bytes for every downstream parser
  expect(
    await page.evaluate(() => (window._item('#e2e_vault_bad') as any).read()),
    'the read path masks candidate bytes'
  ).not.toContain('window._pwned')

  // (c) FENCED placement (review 180 §1.1): a claimed region inside an ordinary code
  // fence cannot materialize a dead-frame element (Marked escapes html there), so it
  // renders the fixed non-leaking placeholder text -- never internal markup, never a
  // marker, never the body
  // (c1) RENDER classified by MARKED ITSELF (review 182 §1): each case places a
  // canonical region in a context whose fence ownership only Marked's real grammar
  // knows. A region Marked lexes inside code -> fixed placeholder, no frame; a region
  // Marked lexes at top level -> dead frame. None may leak a marker or the body.
  const renderCases: Array<{ name: string; body: string; lines: string[]; framed: boolean }> = [
    // a shorter run does not close a longer fence (Marked run-length rule) -> CODE
    { name: 'nested_len', body: 'nested_body', framed: false,
      lines: ['````js', '```not-a-close', '<!--inert-->', 'nested_body', '<!--/inert-->', '````'] },
    // a mixed backtick/tilde closer DOES close a backtick opener (Marked 18) -> the region
    // after it is TOP-LEVEL
    { name: 'mixed_close', body: 'mixed_answer', framed: true,
      lines: ['```js', 'code', '```~', '<!--inert-->', 'mixed_answer', '<!--/inert-->'] },
    // a region nested inside a list-item's fenced code (Marked recursive ownership) -> CODE.
    // this is the exact old defect (a top-level dead-frame div escaped inside the list code)
    { name: 'list_nested', body: 'list_body', framed: false,
      lines: ['- ```js', '  before', '<!--inert-->', 'list_body', '<!--/inert-->', '  after', '  ```'] },
    // a fence created by a MACRO after the opaque scan -> CODE. the expression has
    // no raw backtick (so it passes the app's balance predicate) and evaluates to a
    // three-backtick js opener; only Marked-native classification sees this fence
    { name: 'macro_fence', body: 'macro_body', framed: false,
      lines: ["<<String.fromCharCode(96).repeat(3) + 'js'>>", '<!--inert-->', 'macro_body', '<!--/inert-->', '```'] },
    // a region as an IMAGE DESTINATION (review 186 §4.1): the marker lands in the image
    // token's href, where Marked's default renderer would percent-encode it into a live
    // src request -- the renderer.image interception renders the fixed placeholder
    { name: 'image_dest', body: 'image_body', framed: false,
      lines: ['![alt](', '<!--inert-->', 'image_body', '<!--/inert-->', ')'] },
    // a trailing TAB after the closing run: the app pipeline normalizes trailing whitespace
    // before Marked, so this closes the ```js and the region is TOP-LEVEL (raw Marked would
    // keep it in code; either placement is safe -- the assertion pins whichever the pipeline
    // produces so a regression is caught)
    { name: 'tab_tail', body: 'tab_answer', framed: true,
      lines: ['```js', '```\t', '<!--inert-->', 'tab_answer', '<!--/inert-->', '```'] },
  ]
  for (const rc of renderCases) {
    const hashName = `#e2e_vault_${rc.name}`
    await page.evaluate(text => void window._create(text), `${hashName}\n${rc.lines.join('\n')}`)
    await page.evaluate(name => void (location.hash = name), hashName)
    await expect.poll(() => page.evaluate(name => !!window._item(name, true)?.elem, hashName), { timeout: 15_000 }).toBe(true)
    const r = await page.evaluate(name => {
      const content = window._item(name, true)?.elem?.querySelector('.content') as HTMLElement
      return {
        rendered: content?.textContent ?? '',
        frames: [...(content?.querySelectorAll('.vault-result') ?? [])].length,
        // THE §1 invariant: a dead-frame element must NEVER sit inside a code block (that
        // is exactly what Marked would escape as markup), and no code text may contain the
        // injected class name
        framesInCode: [...(content?.querySelectorAll('pre code .vault-result') ?? [])].length,
        codeText: [...(content?.querySelectorAll('pre code') ?? [])].map(c => c.textContent).join(''),
        // candidate bytes never create candidate-supplied elements/attributes (review 183 §1.3):
        // the frame's children are the inert-markdown policy's html only (design §2.2a, amended
        // 2026-09-05): allowed elements, no handler attributes, no non-http(s)/mailto anchor
        frameViolations: [...(content?.querySelectorAll('.vault-result *') ?? [])].filter(el => {
          const allowed = ['DIV', 'P', 'PRE', 'CODE', 'SPAN', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'EM', 'STRONG', 'DEL', 'HR', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']
          if (!allowed.includes(el.tagName)) return true
          if ([...el.attributes].some(a => a.name.startsWith('on'))) return true
          if (el.tagName != 'A') return false
          // the wiki links exception (design wiki_links 2.7): the app-built anchor under the
          // setting, its href the configured handler's query, no target or rel
          if (el.hasAttribute('data-wiki-link')) {
            const config = (window as any)._wiki_links
            // its href is the app's own under the setting: the url with `{link}` replaced by
            // base64url text and nothing after it, else `url?path=`
            const href = el.getAttribute('href') ?? ''
            const [head, tail] = String(config?.url).split('{link}')
            const packed = href.startsWith(head) && href.endsWith(tail ?? '') && /^[A-Za-z0-9_-]+$/.test(href.slice(head.length, href.length - (tail ?? '').length))
            const built = tail === undefined ? href.startsWith(head + '?path=') : packed
            return !config || !built || el.hasAttribute('target') || el.hasAttribute('rel')
          }
          return !/^(?:https?|mailto):/i.test(el.getAttribute('href') ?? '')
        }).length,
        // review 186 §4.1: a marker must never survive into a URL attribute (raw or
        // percent-encoded -- the ascii 'vault_result_v1:' substring survives encodeURI)
        markerUrls: [...(content?.querySelectorAll('img, a') ?? [])].filter(el =>
          ((el.getAttribute('src') ?? '') + (el.getAttribute('href') ?? '')).includes('vault_result_v1')
        ).length,
      }
    }, hashName)
    // invariants that hold for EVERY placement Marked chooses (review 182 §1):
    expect(r.rendered, `${rc.name}: no marker leaks into rendered text`).not.toContain('vault_result_v1:')
    expect(r.framesInCode, `${rc.name}: no dead-frame element inside a code block`).toBe(0)
    expect(r.codeText, `${rc.name}: no injected class name escaped as code text`).not.toContain('vault-result')
    expect(r.frameViolations, `${rc.name}: the frame holds only the policy html`).toBe(0)
    expect(r.markerUrls, `${rc.name}: no marker survives into a src/href attribute`).toBe(0)
    // the DISCRIMINATING assertion (review 183 §1.2): Marked's classification is pinned --
    // a top-level region is a dead frame with the decoded body and NOT the placeholder; a
    // code region is the fixed placeholder and NOT the body. A regression that flips either
    // placement fails here.
    expect(r.frames, `${rc.name}: expected ${rc.framed ? 'a top-level dead frame' : 'no frame (code)'}`).toBe(
      rc.framed ? 1 : 0
    )
    if (rc.framed) {
      expect(r.rendered, `${rc.name}: top-level shows the decoded body`).toContain(rc.body)
      expect(r.rendered, `${rc.name}: top-level does NOT show the placeholder`).not.toContain('⟦inert region⟧')
    } else {
      expect(r.rendered, `${rc.name}: code shows the fixed placeholder`).toContain('⟦inert region⟧')
      expect(r.rendered, `${rc.name}: code does NOT show the decoded body`).not.toContain(rc.body)
    }
  }

  // the dead frame is a block inside the paragraph flow: with text on the next line, the
  // newline's <br> after the frame only adds an empty line, so the stylesheet hides that one
  // <br> (and only that one: a deliberate blank line keeps its spacer); a rule needs nothing,
  // it ends its paragraph and the text after it starts a new one
  const breaksName = '#e2e_vault_breaks'
  await page.evaluate(
    text => void window._create(text),
    `${breaksName}\n<!--inert-->\nbreak_body\n\ninner_after_blank\n- item one\n- item two\n- [ ] open row\n- [x] done row\n\n- [ ] plan a\n    - [x] plan b\n        - [ ] plan c\n<!--/inert-->\nbelow the region\n---\nbelow the rule\n\nafter a blank line\n\n<!--inert-->\nsecond_body\n<!--/inert-->\n\nafter the frame blank\n- [ ] owner row\n- [x] owner done\n    - [ ] owner child`
  )
  await page.evaluate(name => void (location.hash = name), breaksName)
  await expect.poll(() => page.evaluate(name => !!window._item(name, true)?.elem?.querySelector('.vault-result[data-inert-rendered]'), breaksName), { timeout: 15_000 }).toBe(true)
  const breaks = await page.evaluate(name => {
    const content = window._item(name, true)?.elem?.querySelector('.content') as HTMLElement
    const after = (sel: string) => {
      const next = content.querySelector(sel)?.nextElementSibling as HTMLElement | null
      return next ? [next.tagName, getComputedStyle(next).display] : null
    }
    const spacer = [...content.querySelectorAll('br')].filter(br => getComputedStyle(br).display != 'none').length
    // (the frame stands in its block since 2026-11-19, src/inert_blocks.ts: the break follows the block)
    return { frame: after('.inert-block'), rule: after('hr'), text: content.textContent, spacer }
  }, breaksName)
  expect(breaks.frame, 'the <br> after the dead frame is hidden').toEqual(['BR', 'none'])
  expect(breaks.rule?.[0], 'a rule ends its paragraph: no break follows it').toBe('P')
  expect(breaks.text).toContain('below the region')
  expect(breaks.text).toContain('below the rule')
  expect(breaks.spacer, 'the other breaks (the blank line spacer among them) stay').toBeGreaterThan(0)
  // the LAYOUT, in the content's line height (the app zeroes block margins, and an empty
  // source line is one spacer line): text on the line after a frame sits on its own line with
  // no empty line between, a blank line after a frame is exactly one empty line (the item's
  // own paragraph spacing), and a blank line INSIDE the frame is one empty line too, laid out
  // as the app lays out its own items (the frame runs the app's line pass since round 2 of
  // the task agents, design 9.6: the spacer ends the paragraph it follows). The frame's list
  // carries the app's `span.list-item` wrapper (exactly one per row) and reads in the item's
  // text color, not the bullet gray of `ul`; its task rows are passive boxes (`span.task`, no
  // input) the app styles like its checkboxes, a ticked row dimmed, and a click on a box
  // changes nothing
  const layout = await page.evaluate(name => {
    const content = window._item(name, true)?.elem?.querySelector('.content') as HTMLElement
    const lh = parseFloat(getComputedStyle(content).lineHeight)
    const lines = (px: number) => Math.round((px / lh) * 10) / 10
    const [first, second] = [...content.querySelectorAll('.vault-result')] as HTMLElement[]
    const inner = [...first.querySelector('.inert-markdown')!.children] as HTMLElement[]
    const rect = (el: Element) => el.getBoundingClientRect()
    const rows = [...first.querySelectorAll('li')] as HTMLElement[]
    const box = first.querySelector('span.task') as HTMLElement
    const ticked = first.querySelector('li.checkbox.checked') as HTMLElement
    return {
      // (measured from the frame's open block, less the block's own margin under it: the item is selected)
      underFirst: lines(rect(first.closest('p')!).bottom - rect(first.closest('.inert-block')!).bottom - parseFloat(getComputedStyle(first.closest('.inert-block')!).marginBottom)),
      underSecond: lines(rect(second.closest('p')!.nextElementSibling!).top - rect(second.closest('.inert-block')!).bottom - parseFloat(getComputedStyle(second.closest('.inert-block')!).marginBottom)),
      inner: inner.map(el => el.tagName + ':' + (el.textContent ?? '').replace(/\s+/g, ' ').trim()),
      innerGap: lines(rect(inner[1]).top - rect(inner[0]).top),
      wrappers: rows.map(li => li.querySelectorAll(':scope > span.list-item').length),
      listColor: getComputedStyle(rows[0].querySelector('span.list-item')!).color,
      plainColor: getComputedStyle(content.querySelector('p')!).color,
      inputs: first.querySelectorAll('input').length,
      boxSize: [Math.round(rect(box).width), Math.round(rect(box).height)],
      appBox: (b => [Math.round(rect(b).width), Math.round(rect(b).height)])(content.querySelector('input[type=checkbox]')!),
      tickedOpacity: getComputedStyle(ticked).opacity,
      // the unticked passive box fades like a ticked row does, the box alone (the owner,
      // 2026-09-15); the app's own checkbox outside inert sections stays a live control at
      // full strength; a ticked row's passive box has no fade of its own (the row's applies)
      untickedBox: getComputedStyle(first.querySelector('span.task:not(.checked)')!).opacity,
      untickedRow: getComputedStyle(first.querySelector('span.task:not(.checked)')!.closest('li')!).opacity,
      tickedBox: getComputedStyle(first.querySelector('span.task.checked')!).opacity,
      appUnchecked: getComputedStyle(content.querySelector('input[type=checkbox]:not(:checked)')!).opacity,
      appUncheckedRow: getComputedStyle(content.querySelector('input[type=checkbox]:not(:checked)')!.closest('li')!).opacity,
      // an unticked passive child under a ticked parent: the parent's row fade applies, the box adds none
      nestedUnticked: getComputedStyle(first.querySelector('li.checkbox.checked span.task:not(.checked)')!).opacity,
      appNestedUnchecked: getComputedStyle(content.querySelector('li.checkbox.checked input[type=checkbox]:not(:checked)')!).opacity,
      tickedMark: getComputedStyle(first.querySelector('span.task.checked')!, '::after').content,
      appTickedMark: getComputedStyle(content.querySelector('input[type=checkbox]:checked')!, '::after').content,
      markColor: getComputedStyle(first.querySelector('span.task.checked')!).color,
      // the all-task nested list: no bullets, the boxes pulled into the bullet's place as the app's
      planList: (ul => [getComputedStyle(ul).listStyleType, ul.classList.contains('checkbox')])(first.querySelectorAll('ul')[1] as HTMLElement),
      planBox: (box => Math.round(rect(box).left - rect(box.closest('li')!).left))(first.querySelectorAll('ul')[1].querySelector('span.task') as HTMLElement),
      ownerBox: (box => Math.round(rect(box).left - rect(box.closest('li')!).left))(content.querySelector('input[type=checkbox]') as HTMLElement),
    }
  }, breaksName)
  expect(layout.underFirst, 'text on the next line: its own line under the frame, no empty line').toBe(1)
  expect(layout.underSecond, 'a blank line after the frame: one empty line').toBe(1)
  expect(layout.inner, 'a blank line inside the frame: the app\'s spacer at the end of the paragraph it follows').toEqual(['P:break_body', 'P:inner_after_blank', 'UL:item one item two open row done row', 'P:', 'UL:plan a plan b plan c'])
  expect(layout.innerGap, 'a blank line inside the frame: one text line and one empty line before the next paragraph').toBe(2)
  expect(layout.wrappers, 'exactly one list-item wrapper per row').toEqual([1, 1, 1, 1, 1, 1, 1])
  expect(layout.listColor, 'the list reads in the item\'s text color, not the bullet gray').toBe(layout.plainColor)
  expect(layout.inputs, 'task rows carry no input').toBe(0)
  expect(layout.boxSize, 'a passive box the size of the app\'s checkbox').toEqual(layout.appBox)
  expect(layout.tickedOpacity, 'a ticked row dims like the app\'s').toBe('0.5')
  // the mark: a text-presentation check mark (U+2713 U+FE0E) in the text's own color (the owner's
  // choice of 2026-09-15; the earlier heavy check mark could resolve to the color emoji font's
  // tinted glyph); checked for both the inert tree's passive box and the item's own checkbox under
  // the windows-1252 stylesheet override above
  expect(overriddenSheets, 'the built app stylesheet was served under the windows-1252 override').toBeGreaterThan(0)
  expect(layout.tickedMark, 'a ticked box shows the check mark (U+2713 U+FE0E)').toBe('"\u2713\ufe0e"')
  expect(layout.appTickedMark, 'a checked checkbox shows the check mark (U+2713 U+FE0E)').toBe('"\u2713\ufe0e"')
  expect(layout.markColor, 'the mark in the text\'s own color').toBe(layout.plainColor)
  expect([layout.untickedBox, layout.untickedRow], 'an unticked passive box fades like a ticked row, its text does not').toEqual(['0.5', '1'])
  expect([layout.appUnchecked, layout.appUncheckedRow], 'the app\'s own unchecked box stays a live control: no fade').toEqual(['1', '1'])
  expect(layout.tickedBox, 'a ticked row\'s box: the row\'s fade alone').toBe('1')
  expect([layout.nestedUnticked, layout.appNestedUnchecked], 'an unticked box under a ticked row, passive or the app\'s: no fade of its own (the row\'s applies once)').toEqual(['1', '1'])
  expect(layout.planList, 'an all-task list has no bullets (the app\'s ul.checkbox)').toEqual(['none', true])
  expect(layout.planBox, 'its boxes sit where the app\'s own do').toBe(layout.ownerBox)
  const before = await page.evaluate(name => window._item(name, true)!.text, breaksName)
  await page.locator('.vault-result span.task').first().click()
  await page.waitForTimeout(300) // a passive box: no editor either (the owner, 2026-09-27: a click inside a frame opens none)
  expect(await page.evaluate(name => !!window._item(name, true)!.elem!.querySelector('.container.editing'), breaksName), 'no editor from a click in the frame').toBe(false)
  expect(await page.evaluate(name => window._item(name, true)!.text, breaksName), 'the text is untouched: the box is passive').toBe(before)

  // (c1b) encoded marker LOOKALIKE in an ordinary image stays an ordinary image
  // (review 187 §2): owner text percent-encoding a marker shape must NOT trip the raw
  // interception -- the real region still frames, and the lookalike renders as an img
  {
    const hashName = '#e2e_vault_lookalike'
    const lines = [
      hashName,
      '![ordinary](%E2%9F%A6vault_result_v1%3A0%3A0%E2%9F%A7)',
      '',
      '<!--inert-->',
      'lookalike_body',
      '<!--/inert-->',
    ]
    await page.evaluate(text => void window._create(text), lines.join('\n'))
    await page.evaluate(name => void (location.hash = name), hashName)
    await expect.poll(() => page.evaluate(name => !!window._item(name, true)?.elem, hashName), { timeout: 15_000 }).toBe(true)
    const r = await page.evaluate(name => {
      const content = window._item(name, true)?.elem?.querySelector('.content') as HTMLElement
      return {
        rendered: content?.textContent ?? '',
        frames: [...(content?.querySelectorAll('.vault-result') ?? [])].length,
        images: [...(content?.querySelectorAll('img') ?? [])].length,
      }
    }, hashName)
    expect(r.frames, 'lookalike: the real region still frames').toBe(1)
    expect(r.rendered, 'lookalike: decoded body shown').toContain('lookalike_body')
    expect(r.images, 'lookalike: the ordinary encoded image is NOT suppressed').toBe(1)
    expect(r.rendered, 'lookalike: no placeholder for the ordinary image').not.toContain('⟦inert region⟧')
  }

  // (c1c) SEARCH reaches decoded bodies (owner bug 2026-08-31; review 188 §§2.1-2.3):
  // a term existing ONLY inside a canonical region body must match the item and
  // highlight inside its frame -- in visible ORDER (regex terms), and still after a
  // MACRO forces the expanded-item search path
  {
    const hashName = '#e2e_vault_searchable'
    const lines = [
      hashName,
      'prompt text here',
      '<!--inert-->',
      'zanzibar_reply_term',
      '<!--/inert-->',
      'suffix searchable_suffix <<1+1>>',
    ]
    await page.evaluate(text => void window._create(text), lines.join('\n'))
    // drive the real mindbox search (editor.spec idiom): backdrop click focuses it
    await page.locator('.header .backdrop').first().click()
    await page.locator('#textarea-mindbox').fill('zanzibar_reply_term')
    // the item matches on the decoded body alone (editor.spec matching idiom)...
    await expect
      .poll(
        () =>
          page.evaluate(
            name => window.__items.find(item => item.labelText == name)?.matching ?? false,
            hashName
          ),
        { timeout: 15_000 }
      )
      .toBe(true)
    // ...and the occurrence inside the dead frame is highlight-wrapped
    await expect
      .poll(
        () =>
          page.evaluate(name => {
            const elem = window._item(name, true)?.elem
            return [...(elem?.querySelectorAll('.vault-result .highlight') ?? [])].some(span =>
              (span.textContent ?? '').includes('zanzibar_reply_term')
            )
          }, hashName),
        { timeout: 15_000 }
      )
      .toBe(true)
    const matching = () =>
      page.evaluate(name => window.__items.find(item => item.labelText == name)?.matching ?? false, hashName)
    // regex ORDER follows the visible text (188 §2.2): body precedes the suffix
    await page.locator('#textarea-mindbox').fill('regex:zanzibar_reply_term[^]*searchable_suffix')
    await expect.poll(matching, { timeout: 15_000 }).toBe(true)
    await page.locator('#textarea-mindbox').fill('regex:searchable_suffix[^]*zanzibar_reply_term')
    await expect.poll(matching, { timeout: 15_000 }).toBe(false)
    // the EXPANDED-item path (188 §2.1): force macro expansion, then the same
    // reply-only term must still match through expanded.item's search text
    await page.evaluate(name => void (window._item(name, true) as any)?.read('', { eval_macros: true }), hashName)
    await expect
      .poll(
        () => page.evaluate(name => !!(window.__items.find(item => item.labelText == name) as any)?.expanded?.item, hashName),
        { timeout: 15_000 }
      )
      .toBe(true)
    await page.locator('#textarea-mindbox').fill('zanzibar_reply_term')
    await expect.poll(matching, { timeout: 15_000 }).toBe(true)
    // clear the search for the rows below
    await page.locator('#textarea-mindbox').fill('')
    await page.keyboard.press('Escape')
  }

  // (c2) EDITOR keeps its open block across the candidate (review 181 §2): a simple
  // ```js block (matching the editor's own fence grammar) with code before AND after the
  // region -- both segments stay block-highlighted, and the region renders the fixed
  // fallback (its dimmed source span is present in the backdrop)
  const fencedText = [
    '#e2e_vault_fenced',
    '```js',
    'const before = 1',
    '<!--inert-->',
    'fenced body',
    '<!--/inert-->',
    'const after = 2',
    '```',
    'after',
  ].join('\n')
  await page.evaluate(text => void window._create(text), fencedText)
  await page.evaluate(() => void (location.hash = '#e2e_vault_fenced'))
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_vault_fenced', true)?.elem), { timeout: 15_000 }).toBe(true)
  const fencedRender = await page.evaluate(
    () => window._item('#e2e_vault_fenced', true)?.elem?.querySelector('.content')?.textContent ?? ''
  )
  expect(fencedRender, 'the simple-fence placement also renders the placeholder').toContain('⟦inert region⟧')
  const fencedId = await page.evaluate(() => window._item('#e2e_vault_fenced')!.id)
  const fencedItem = page.locator(`[data-item-id="${fencedId}"]`)
  const fencedParagraph = fencedItem.locator('.content').first()
  const fBox = (await fencedParagraph.boundingBox())!
  await fencedParagraph.click({ position: { x: fBox.width / 2, y: 5 } })
  await expect(fencedItem.locator('textarea')).toBeVisible()
  const fencedEditor = await page.evaluate(id => {
    const elem = document.querySelector(`[data-item-id="${id}"]`)!
    const backdrop = elem.querySelector('.backdrop')!
    const blocks = [...backdrop.querySelectorAll('.block')]
    return {
      beforeHighlighted: blocks.some(b => b.textContent?.includes('const before')),
      afterHighlighted: blocks.some(b => b.textContent?.includes('const after')),
      regionSpan: backdrop.querySelector('.inert-region')?.textContent ?? null,
      backdropText: backdrop.textContent ?? '',
      value: (elem.querySelector('textarea') as HTMLTextAreaElement).value,
    }
  }, fencedId)
  expect(fencedEditor.beforeHighlighted, 'code before the region stays block-highlighted').toBe(true)
  expect(fencedEditor.afterHighlighted, 'code after the region stays block-highlighted').toBe(true)
  expect(fencedEditor.regionSpan, 'the editor shows the exact region source').toBe(
    '<!--inert-->\nfenced body\n<!--/inert-->'
  )
  expect(
    fencedEditor.backdropText === fencedEditor.value || fencedEditor.backdropText === fencedEditor.value + '\n',
    'the fenced editor backdrop reconstructs the textarea value'
  ).toBe(true)
  await fencedItem.locator('textarea').press('Escape')
  await expect(fencedItem.locator('textarea')).toBeHidden()

  // (d) EDITOR witness (review 180 §§1.2+2+4): open the editor on the VALID item --
  // the backdrop must carry the dimmed source span, reconstruct the exact textarea
  // text (modulo the synthetic trailing newline), and match caret delimiters in RAW
  // coordinates after the region
  await page.evaluate(() => void (location.hash = '#e2e_vault_valid'))
  const validId = await page.evaluate(() => window._item('#e2e_vault_valid')!.id)
  const validItem = page.locator(`[data-item-id="${validId}"]`)
  // click mid-paragraph, past the leading tag (a tag click navigates instead of
  // opening the editor -- the editor.spec idiom)
  const validParagraph = validItem.locator('.content p').first()
  const validBox = (await validParagraph.boundingBox())!
  await validParagraph.click({ position: { x: validBox.width / 2, y: validBox.height / 2 } })
  const textarea = validItem.locator('textarea')
  await expect(textarea).toBeVisible()
  const editorState = await page.evaluate(id => {
    const elem = document.querySelector(`[data-item-id="${id}"]`)!
    const backdrop = elem.querySelector('.backdrop')!
    const region = backdrop.querySelector('.inert-region')
    const value = (elem.querySelector('textarea') as HTMLTextAreaElement).value
    return {
      regionText: region?.textContent ?? null,
      invalid: !!backdrop.querySelector('.inert-invalid'),
      backdropText: backdrop.textContent ?? '',
      value,
    }
  }, validId)
  expect(editorState.regionText, 'the dimmed span carries the exact region source').toBe(
    '<!--inert-->\n' + (await page.evaluate(() => (window as any)._hostile)) + '\n<!--/inert-->'
  )
  expect(editorState.invalid, 'a canonical region is not warning-tinted').toBe(false)
  const reconstructed = editorState.backdropText
  expect(
    reconstructed === editorState.value || reconstructed === editorState.value + '\n',
    'backdrop textContent reconstructs the textarea value'
  ).toBe(true)
  // caret delimiter matching AFTER the region, in raw coordinates: type a paren pair
  // at the end and place the caret before the closer
  await textarea.focus()
  await page.evaluate(id => {
    const ta = document.querySelector(`[data-item-id="${id}"] textarea`) as HTMLTextAreaElement
    ta.setSelectionRange(ta.value.length, ta.value.length)
  }, validId)
  await textarea.pressSequentially('\n(x)')
  await textarea.press('ArrowLeft')
  await expect(
    validItem.locator('.backdrop .highlight.matched'),
    'delimiters after a region match in raw coordinates'
  ).toHaveCount(2)
  await textarea.press('Shift+Enter') // save (the appended paren line is harmless)
  await expect(textarea).toBeHidden()

  // (e) EDITOR warning state: the malformed item's claimed candidate is tinted
  await page.evaluate(() => void (location.hash = '#e2e_vault_bad'))
  const badId = await page.evaluate(() => window._item('#e2e_vault_bad')!.id)
  const badItem = page.locator(`[data-item-id="${badId}"]`)
  const badParagraph = badItem.locator('.content p').first()
  const badBox = (await badParagraph.boundingBox())!
  await badParagraph.click({ position: { x: badBox.width / 2, y: badBox.height / 2 } })
  await expect(badItem.locator('textarea')).toBeVisible()
  await expect(
    badItem.locator('.backdrop .inert-region.inert-invalid'),
    'a claimed candidate without a value is warning-tinted while editing'
  ).toHaveCount(1)
  await badItem.locator('textarea').press('Escape') // no edits: closes silently
  await expect(badItem.locator('textarea')).toBeHidden()
})

test('a candidate-bearing item: read/render domains stay separate and idle converges', async ({ page }) => {
  // review 149 §3: the renderer bypasses the shared item.expanded (its placeholder HTML
  // must never become semantic text), while the read path caches its grammar/marker
  // expansion normally -- so the background pre-expander converges once instead of
  // re-evaluating the outer macro on every ~250ms idle pass.
  await loadAdmin(page)
  // create the item AND run a macro-evaluating read in the SAME task, before Svelte
  // flushes, so the read populates item.expanded first. a side-effect counter proves the
  // macro is not re-run on every idle pass.
  const read = await page.evaluate(() => {
    ;(window as any)._macro_runs = 0
    void window._create(
      '#e2e_vault_cache <<(window._macro_runs++, 1 + 2)>>\n<!--inert-->\nnot canonical <!--/inert--> x\n<!--/inert-->'
    )
    return (window._item('#e2e_vault_cache') as any).read('', { eval_macros: true })
  })
  expect(read, 'the macro evaluated in the read').toContain('3')
  expect(read, 'the candidate is a masked marker in the read').not.toContain('not canonical')
  await page.evaluate(() => void (location.hash = '#e2e_vault_cache'))
  await expect.poll(() => page.evaluate(() => !!window._item('#e2e_vault_cache', true)?.elem), { timeout: 15_000 }).toBe(true)
  const content = await page.evaluate(
    () => window._item('#e2e_vault_cache', true)?.elem?.querySelector('.content')?.textContent ?? ''
  )
  expect(content, 'the macro rendered (cache not poisoned by a marker)').toContain('3')
  expect(content, 'the invalid candidate still shows the placeholder').toContain('⟦invalid inert region⟧')
  expect(content, 'no raw marker leaked into render').not.toContain('vault_result_v1:')
  // idle convergence: past several ~250ms background passes the macro count is stable
  const runsBefore = await page.evaluate(() => (window as any)._macro_runs as number)
  await page.waitForTimeout(1_500)
  expect(await page.evaluate(() => (window as any)._macro_runs as number), 'no permanent idle re-expansion').toBe(
    runsBefore
  )
  await page.evaluate(() => window._item('#e2e_vault_cache')?.delete(false))
})

test('a malformed candidate cannot execute a nested js block on startup', async ({ page }) => {
  // review 148 §1.1: special-tag-alias extraction runs before the initial itemTextChanged
  // pass, so it must scan INLINE -- a nested js block inside a malformed candidate must
  // not execute on reload
  await loadAdmin(page)
  await page.evaluate(() => {
    ;(window as any)._startup_pwned = false
    // a CLAIMED region whose body contains a real nested ```js block with a
    // _special_tag_aliases function: only a RAW extractBlock(item.text,'js') would find
    // and execute it (the region masks it from every inline/grammar-view scan).
    void window._create(
      '#e2e_startup_js\n<!--inert-->\n```js\n' +
        'window._startup_pwned = true\nfunction _special_tag_aliases() { return {} }\n```\n<!--/inert-->'
    )
  })
  await expect
    .poll(() => page.evaluate(() => window._item('#e2e_startup_js', true)?.saved_id ?? null), { timeout: 30_000 })
    .toBeTruthy()
  // reload: the startup alias extraction runs over the persisted item
  await page.reload()
  await waitForApp(page)
  await page.waitForTimeout(1_000)
  // after reload the window sentinel is cleared; only the nested js executing would set it
  expect(await page.evaluate(() => (window as any)._startup_pwned), 'the nested js did not execute on startup').not.toBe(
    true
  )
  await page.evaluate(() => window._item('#e2e_startup_js')?.delete(false))
})

test('/run copies only the real input, not a candidate-nested one', async ({ page }) => {
  // reviews 148 §1.2, 150 §2.3, 151 §3. three phases:
  // 1: an installed item with a real outer input plus a SIBLING candidate -- /run copies
  //    only the real input (the raw-match bug), the candidate stays on the parent, and
  //    the child (where cleanup/publication then run) carries no candidate at all
  // 2: a candidate INSIDE the selected input -- the child receives the exact raw
  //    envelope (its own scanner masks it), never a literal marker
  // 3 (run FIRST): an ORDINARY run on a candidate-bearing item whose candidate owns
  //    nested _output AND _log openers, with an input that emits fresh output AND a log
  //    -- pinning clearRunArtifacts and both append transforms on this very item; all
  //    three fixtures persist before ONE shared reload
  await loadAdmin(page)
  const candidate =
    '<!--inert-->\nnot canonical <!--/inert--> x\n```js_input\nwindow._candidate_input = true\n```_output\nnested output\n```_log\nnested log\n<!--/inert-->'
  const inner = '<!--inert-->\nnot canonical <!--/inert--> x\n<!--/inert-->'
  const names = ['#e2e_run_mixed/run', '#e2e_run_mixed', '#e2e_run_inner/run', '#e2e_run_inner', '#e2e_run_plain']
  const cleanup = () =>
    page.evaluate(names => {
      for (const name of names) if (window._exists(name)) window._item(name)!.delete(false)
    }, names)
  await cleanup() // fixed fixture names: clear residue from an earlier failed attempt
  try {
    // ALL THREE fixtures created and persisted before ONE shared reload (review 152 §3)
    await page.evaluate(
      ([candidate, inner]) => {
        void window._create('#e2e_run_mixed real\n```js_input\nwindow._real_input = true\n```\n' + candidate)
        void window._create('#e2e_run_inner real\n```js_input\nwindow._real_input = true\n' + inner + '\n```')
        void window._create(
          "#e2e_run_plain\n```js_input\n_this.log('fresh log')\n1 + 1\n```\n" +
            candidate +
            '\n```_output\nold output\n```\n```_log\nold log\n```'
        )
      },
      [candidate, inner] as const
    )
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_run_plain', true)?.saved_id ?? null), { timeout: 30_000 })
      .toBeTruthy()
    for (const name of ['#e2e_run_mixed', '#e2e_run_inner']) {
      await expect
        .poll(() => page.evaluate(name => window._item(name, true)?.saved_id ?? null, name), { timeout: 30_000 })
        .toBeTruthy()
      const id = await page.evaluate(name => window._item(name, true)?.saved_id ?? null, name)
      await firestore()
        .collection('items')
        .doc(id!)
        .update({ attr: { source: 'https://github.com/olcan/mind.items/blob/master/e2e.md' } })
    }
    // reload before clicking: the run button passes its component's render-time index
    // prop, which a mid-session create can reshuffle (recorded app backfill, review 151
    // §5) -- and mark nothing previewable so a residue item's rejected preview fetch
    // cannot strand the deferred run
    await page.reload()
    await waitForApp(page)
    const runItem = async (name: string) => {
      await page.evaluate(name => void (location.hash = name), name)
      const id = await page.evaluate(name => window._item(name)!.id, name)
      const run = page.locator(`[data-item-id="${id}"] .button.run`)
      await expect(run).toHaveCount(1, { timeout: 30_000 })
      await page.evaluate(() => window.__items.forEach(item => ((item as any).previewable = false)))
      await run.click()
    }
    // PHASE 3 FIRST (ordinary run, before any child creation can reshuffle indices):
    // fresh output AND log land beside the byte-exact candidate whose body holds nested
    // _output/_log openers -- pinning clearRunArtifacts and both append transforms
    await runItem('#e2e_run_plain')
    await expect
      .poll(() => page.evaluate(() => window._item('#e2e_run_plain')!.text), { timeout: 30_000 })
      .toContain('```_output\n2\n```') // fresh output appended on this item
    const plainText = await page.evaluate(() => window._item('#e2e_run_plain')!.text)
    expect(plainText, 'the candidate survived cleanup + both appends exactly').toContain(candidate)
    // the OUTER _log block: the grammar view masks the candidate's nested _log, and
    // typed read('_log') extraction excludes the separate js_input block -- so the
    // sentinel can only come from the appended block (review 152 §2.4, 153 §3)
    expect(
      await page.evaluate(() => (window._item('#e2e_run_plain') as any).read('_log')),
      'the fresh log landed in the outer _log block'
    ).toContain('fresh log')
    expect(plainText, 'the old output was cleared').not.toContain('old output')
    expect(plainText, 'the old log was removed').not.toContain('old log')
    // PHASE 1: sibling candidate -- only the real input is copied
    await runItem('#e2e_run_mixed')
    await expect.poll(() => page.evaluate(() => window._exists('#e2e_run_mixed/run')), { timeout: 30_000 }).toBe(true)
    const runText = await page.evaluate(() => window._item('#e2e_run_mixed/run')!.text)
    expect(runText, 'the real input was copied').toContain('window._real_input')
    expect(runText, 'the candidate-nested input was NOT copied').not.toContain('window._candidate_input')
    // the source-side selection left the parent untouched: its candidate is byte-exact
    // (the installed run's cleanup/publication then operate on the child, not here)
    expect(
      await page.evaluate(() => window._item('#e2e_run_mixed')!.text),
      'parent candidate source intact'
    ).toContain(candidate)
    // PHASE 2: candidate inside the selected input -- exact envelope, never a marker
    await runItem('#e2e_run_inner')
    await expect.poll(() => page.evaluate(() => window._exists('#e2e_run_inner/run')), { timeout: 30_000 }).toBe(true)
    const innerRunText = await page.evaluate(() => window._item('#e2e_run_inner/run')!.text)
    expect(innerRunText, 'the inner candidate rode along as its exact raw envelope').toContain(inner)
    expect(innerRunText, 'no literal marker escaped into the child').not.toContain('\u27e6vault_result_v1:')
  } finally {
    await cleanup()
  }
})
// the wiki links (src/wiki_links.ts; design: the vault's notes/design/wiki_links.md): the owner's
// text and a reply's inert frame under the account's setting, set and cleared in the page without
// an edit (the setter re-renders every item, a hidden one's cache included), the anchor's shape and
// its click path (the click stops at the anchor and keeps its default, verified with a synthetic
// cancelable click whose default the test itself cancels, so no external application launches);
// a `#diff` reference in each, under BOTH forms of the setting's url. The first ON is the query
// form (`url?path=…&root=…`), which carries no view: the reference is a plain file link, tooltip
// included. The second ON is a url with the `{link}` placeholder, the vault's own: a link's path,
// root and view are packed into ONE base64url text in the placeholder's place, with no query, and
// the diff view exists there alone. The frame audit admits an app-built anchor under either
// (`built` above); no other rule of the audit changes
test('wiki links: the owner text and the inert frame link under the setting, on, off, on', async ({ page }) => {
  await loadAdmin(page)
  const config = { url: 'vscode-insiders://olcan.auto-open-obsidian/file', root: '/Users/o c/v' }
  const href = (path: string) => `${config.url}?path=${encodeURIComponent(path)}&root=${encodeURIComponent(config.root)}`
  // the packed form: node's own encoder over the values' JSON, in the placeholder's place
  const packed = { url: 'vscode-insiders://olcan.auto-open-obsidian/link/{link}', root: '/Users/o c/v' }
  const link = (path: string, view?: string) =>
    packed.url.replace('{link}', Buffer.from(JSON.stringify({ v: 1, path, root: packed.root, ...(view ? { view } : {}) })).toString('base64url'))
  await page.evaluate(() => {
    window._create('#e2e_wiki_hidden the hidden one [[docs/z]]')
    window._create('#e2e_wiki_owner see [[docs/x]] and [[notes/A&B|see #topic]] and `[[docs/code]]` and [[../etc/passwd]] and [[/abs]] and [[worktrees/t/AGENTS#diff]]')
    window._create(
      "#e2e_wiki_reply reply\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n<!--inert-->\nsee [[docs/y|guide]] and [[../x]] and [x](https://h/) and [[worktrees/t#diff|the proposal]]\n<!--/inert-->"
    )
  })
  const shown = async (name: string) => {
    await page.evaluate(name => void (location.hash = name), name)
    await expect.poll(() => page.evaluate(name => !!window._item(name, true)?.elem?.querySelector('.content'), name), { timeout: 15_000 }).toBe(true)
  }
  // the anchors of an item's content (a frame's included) and the text of the content
  const state = (name: string) =>
    page.evaluate(name => {
      const content = window._item(name, true)?.elem?.querySelector('.content') as HTMLElement
      return {
        text: content?.textContent ?? '',
        anchors: [...(content?.querySelectorAll('a[data-wiki-link]') ?? [])].map((a: any) => ({
          href: a.getAttribute('href'),
          title: a.getAttribute('title'),
          text: a.textContent,
          html: a.innerHTML,
          attributes: [...a.attributes].map((x: Attr) => x.name).sort(),
          wired: typeof a.onclick == 'function',
        })),
        marks: [...(content?.querySelectorAll('a[data-wiki-link] mark') ?? [])].length,
        code: [...(content?.querySelectorAll('code') ?? [])].map(c => c.textContent),
        // the frame audit of the rows above (design 2.7), over these rows' frames
        frameViolations: [...(content?.querySelectorAll('.vault-result *') ?? [])].filter(el => {
          const allowed = ['DIV', 'P', 'PRE', 'CODE', 'SPAN', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'EM', 'STRONG', 'DEL', 'HR', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']
          if (!allowed.includes(el.tagName)) return true
          if ([...el.attributes].some(a => a.name.startsWith('on'))) return true
          if (el.tagName != 'A') return false
          if (el.hasAttribute('data-wiki-link')) {
            const config = (window as any)._wiki_links
            // its href is the app's own under the setting: the url with `{link}` replaced by
            // base64url text and nothing after it, else `url?path=`
            const href = el.getAttribute('href') ?? ''
            const [head, tail] = String(config?.url).split('{link}')
            const packed = href.startsWith(head) && href.endsWith(tail ?? '') && /^[A-Za-z0-9_-]+$/.test(href.slice(head.length, href.length - (tail ?? '').length))
            const built = tail === undefined ? href.startsWith(head + '?path=') : packed
            return !config || !built || el.hasAttribute('target') || el.hasAttribute('rel')
          }
          return !/^(?:https?|mailto):/i.test(el.getAttribute('href') ?? '')
        }).length,
      }
    }, name)
  await shown('#e2e_wiki_hidden') // rendered and cached without the setting
  await shown('#e2e_wiki_owner')
  const off = await state('#e2e_wiki_owner')
  expect(off.anchors, 'without the setting: no anchor').toEqual([])
  expect(off.text).toContain('[[docs/x]]') // literal, as before
  expect(off.text).toContain('[[../etc/passwd]]')
  // ON: the setter, no edit
  expect(await page.evaluate(config => (window as any)._set_wiki_links(config), config)).toEqual(config)
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_owner', true)?.elem?.querySelectorAll('a[data-wiki-link]').length), { timeout: 15_000 }).toBe(3)
  const on = await state('#e2e_wiki_owner')
  expect(on.anchors).toEqual([
    { href: href('docs/x'), title: 'docs/x', text: 'docs/x', html: 'docs/x', attributes: ['data-wiki-link', 'href', 'title'], wired: true },
    { href: href('notes/A&B'), title: 'notes/A&B', text: 'see #topic', html: 'see #topic', attributes: ['data-wiki-link', 'href', 'title'], wired: true },
    // a `#diff` reference under the query form: a plain file link, the target shown as written
    // (its `#diff` is no tag: the count of marks below)
    { href: href('worktrees/t/AGENTS'), title: 'worktrees/t/AGENTS', text: 'worktrees/t/AGENTS#diff', html: 'worktrees/t/AGENTS#diff', attributes: ['data-wiki-link', 'href', 'title'], wired: true },
  ])
  expect(on.marks, 'no tag mark inside an anchor').toBe(0)
  expect(on.code, 'the code span keeps its brackets').toContain('[[docs/code]]')
  expect(on.text, 'a refused target stays literal').toContain('[[../etc/passwd]] and [[/abs]]')
  // the click path: the click stops at the anchor (the item does not open its editor) and keeps
  // its default (the test's own listener, registered after the app's, cancels it and records)
  const click = await page.evaluate(() => {
    const a = window._item('#e2e_wiki_owner', true)!.elem!.querySelector('a[data-wiki-link]') as HTMLAnchorElement
    const seen: any = { bubbled: false }
    document.body.addEventListener('click', () => (seen.bubbled = true), { once: true })
    a.addEventListener(
      'click',
      e => {
        seen.stopped = e.cancelBubble
        seen.defaultPrevented = e.defaultPrevented
        e.preventDefault() // never hand the url to a handler here
      },
      { once: true }
    )
    a.focus() // as a real click focuses the anchor before its handler runs
    seen.focusedBefore = document.activeElement === a
    seen.outlineFocused = getComputedStyle(a).outlineStyle // the ring the app disables
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    seen.focusedAfter = document.activeElement === a // the handler blurs it (owner, 2026-09-27)
    seen.editing = !!document.querySelector('#e2e_wiki_owner textarea, .container.editing')
    return seen
  })
  expect(click).toEqual({
    bubbled: false,
    stopped: true,
    defaultPrevented: false,
    editing: false,
    focusedBefore: true,
    outlineFocused: 'none',
    focusedAfter: false,
  })
  // the inert frame: the app-built anchor, the refused reference and the web link as before
  await shown('#e2e_wiki_reply')
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_reply', true)?.elem?.querySelector('.vault-result a[data-wiki-link]') != null), { timeout: 15_000 }).toBe(true)
  const reply = await state('#e2e_wiki_reply')
  // (each twice since 2026-11-19: the head line of the reply's block repeats the reply's first line with
  // its links, src/inert_blocks.ts, and those are the same app-built anchors, wired by the same pass)
  const replyAnchors = [
    { href: href('docs/y'), title: 'docs/y', text: 'guide', html: 'guide', attributes: ['data-wiki-link', 'href', 'title'], wired: true },
    { href: href('worktrees/t'), title: 'worktrees/t', text: 'the proposal', html: 'the proposal', attributes: ['data-wiki-link', 'href', 'title'], wired: true },
  ]
  expect(reply.anchors).toEqual([...replyAnchors, ...replyAnchors])
  expect(reply.text).toContain('and [[../x]] and')
  expect(reply.frameViolations, 'the frame holds only the policy html, the wiki anchor included').toBe(0)
  expect(
    await page.evaluate(() => {
      const frame = window._item('#e2e_wiki_reply', true)!.elem!.querySelector('.vault-result')!
      const web = frame.querySelector('a:not([data-wiki-link])')!
      return [web.getAttribute('href'), web.getAttribute('target'), web.getAttribute('rel')]
    })
  ).toEqual(['https://h/', '_blank', 'noopener'])
  // the hidden item, cached before the setting: its cache missed
  await shown('#e2e_wiki_hidden')
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_hidden', true)?.elem?.querySelectorAll('a[data-wiki-link]').length), { timeout: 15_000 }).toBe(1)
  expect((await state('#e2e_wiki_hidden')).anchors[0].href).toBe(href('docs/z'))
  // OFF again: literal text, no anchor, without an edit; a refused config leaves the setting
  expect(await page.evaluate(() => (window as any)._set_wiki_links({ url: 'h/f' }))).toBeUndefined()
  expect(await page.evaluate(() => (window as any)._wiki_links)).toEqual(config)
  expect(await page.evaluate(() => (window as any)._set_wiki_links(null))).toBeNull()
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_hidden', true)?.elem?.querySelectorAll('a[data-wiki-link]').length), { timeout: 15_000 }).toBe(0)
  await shown('#e2e_wiki_owner')
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_owner', true)?.elem?.querySelectorAll('a[data-wiki-link]').length), { timeout: 15_000 }).toBe(0)
  expect((await state('#e2e_wiki_owner')).text).toContain('[[docs/x]]')
  await shown('#e2e_wiki_reply') // the already-rendered reply: its frame re-rendered without the anchor
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_reply', true)?.elem?.querySelectorAll('.vault-result a[data-wiki-link]').length), { timeout: 15_000 }).toBe(0)
  expect((await state('#e2e_wiki_reply')).text).toContain('see [[docs/y|guide]] and')
  expect((await state('#e2e_wiki_reply')).text).toContain('and [[worktrees/t#diff|the proposal]]')
  expect(await page.evaluate(() => (window as any)._wiki_links_epoch)).toBe(2)
  // ON again, without an edit, under the url with the placeholder: both back, each href the
  // setting's url with ONE base64url text in the placeholder's place and no query, and the diff
  // references now the diff view, named in the tooltip; the frame audit admits them
  expect(await page.evaluate(config => (window as any)._set_wiki_links(config), packed)).toEqual(packed)
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_reply', true)?.elem?.querySelectorAll('.vault-result a[data-wiki-link]').length), { timeout: 15_000 }).toBe(2)
  const again = await state('#e2e_wiki_reply')
  const againAnchors = [
    [link('docs/y'), 'docs/y', 'guide'],
    [link('worktrees/t', 'diff'), 'diff of worktrees/t', 'the proposal'],
  ]
  expect(again.anchors.map(a => [a.href, a.title, a.text]), "the head line's two, then the frame's").toEqual([...againAnchors, ...againAnchors])
  expect(again.frameViolations, 'the frame holds only the policy html, the packed wiki anchors included').toBe(0)
  await shown('#e2e_wiki_owner')
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_owner', true)?.elem?.querySelectorAll('a[data-wiki-link]').length), { timeout: 15_000 }).toBe(3)
  expect((await state('#e2e_wiki_owner')).anchors.map(a => [a.href, a.title, a.text])).toEqual([
    [link('docs/x'), 'docs/x', 'docs/x'],
    [link('notes/A&B'), 'notes/A&B', 'see #topic'],
    [link('worktrees/t/AGENTS', 'diff'), 'diff of worktrees/t/AGENTS', 'worktrees/t/AGENTS#diff'],
  ])
  expect(await page.evaluate(() => (window as any)._wiki_links_epoch)).toBe(3)
})

// the settings item (mind.items wiki_links; design 2.6): installed and rendered, its command saves
// the setting to its store and applies it; after a reload the setting is applied BEFORE the first
// render (the item's init hook: the setter's calls are recorded with the app's `__rendered` flag by
// an init script; that flag says the initial rendering COMPLETED, so the evidence is the first
// call's false flag together with the app's order, `initItems()` before `processed` and the first
// `renderRange`, and the pin that removes the item's init block and fails this row), and the
// welcome reapplication of an equal value changes nothing (the epoch).
// loadAdmin is the admin-as-anonymous mode, whose global store is backed by the local store, so
// the reload covers the first render of a device that holds the setting, not the store's
// travel to another device (a backfill)
test('wiki links: the settings item, its command, the store, and the first render after a reload', async ({ page }) => {
  await loadAdmin(page)
  // the item renders without an error indication (it declares no dependency, so it evaluates
  // no macro): the app's diagnostics (src/item_errors.ts: `macro error in item`, the item's
  // `error indication` line) recorded from before the install, and its error elements
  const errors: string[] = []
  page.on('console', m => {
    if (/macro error in item #?wiki_links|\[#wiki_links\] error indication/.test(m.text())) errors.push(m.text())
  })
  expect(await install(page, 'wiki_links')).toBeNull()
  await page.evaluate(() => void (location.hash = '#wiki_links'))
  await expect.poll(() => page.evaluate(() => window._item('#wiki_links')?.elem?.querySelector('.content')?.textContent ?? ''), { timeout: 15_000 }).toContain('/wiki_links')
  expect(await page.evaluate(() => window._item('#wiki_links')!.elem!.querySelectorAll('.content .macro-error, .content .console-error, .content mark.missing, .content .error').length)).toBe(0)
  expect(errors).toEqual([])
  // the command's feedback is the item's alert (window.alert: a native dialog here, recorded
  // and dismissed; Playwright dismisses an unhandled one silently); any other dialog is accepted,
  // as Playwright does unhandled (the app's beforeunload prompt on the reload below: dismissing
  // it would cancel the reload)
  const alerts: string[] = []
  page.on('dialog', dialog => {
    if (dialog.type() != 'alert') {
      void dialog.accept()
      return
    }
    alerts.push(dialog.message())
    void dialog.dismiss()
  })
  await page.evaluate(() => void window._create('#e2e_wiki_startup see [[docs/s]] here'))
  const command = async (text: string) => {
    const before = alerts.length
    await page.evaluate(text => void window._create(text, { command: true }), text)
    await expect.poll(() => alerts.length, { message: text, timeout: 15_000 }).toBeGreaterThan(before)
    return alerts[alerts.length - 1]
  }
  expect(await command('/wiki_links')).toContain('wiki links: off')
  expect(await command('/wiki_links h/f /r')).toContain('refused h/f /r') // nothing applied, nothing saved
  expect(await page.evaluate(() => (window as any)._wiki_links)).toBeNull()
  expect(await command('/wiki_links vscode-insiders://olcan.auto-open-obsidian/link/{link} /Users/o c/v')).toContain('wiki links: vscode-insiders://olcan.auto-open-obsidian/link/{link} under /Users/o c/v')
  expect(await page.evaluate(() => (window as any)._wiki_links)).toEqual({ url: 'vscode-insiders://olcan.auto-open-obsidian/link/{link}', root: '/Users/o c/v' })
  // the command TYPED into the mindbox, as the owner runs it: the editor augments the long url
  // with zero-width spaces (src/zwsp.ts; the precondition is asserted, or the row proves nothing),
  // and the command's arguments must not carry them (2026-09-26: the stored url held three, and
  // the editor launched by it never saw a valid extension id)
  await page.evaluate(() => void (window as any)._set_wiki_links(null))
  const typed = async (line: string) => {
    // the textarea sits behind a backdrop until focused (a refused command leaves it focused)
    if (!(await mindbox(page).evaluate(el => document.activeElement === el))) await focusMindbox(page)
    await mindbox(page).fill(line)
    await expect.poll(() => mindbox(page).inputValue(), { message: 'the editor augments the url' }).toContain('\u200b')
    const before = alerts.length
    await page.keyboard.press('Shift+Enter') // the mindbox's run key (see Editor.svelte and editor.spec.ts)
    await expect.poll(() => alerts.length, { message: `${line} answered`, timeout: 15_000 }).toBeGreaterThan(before)
    return alerts[alerts.length - 1]
  }
  // a REFUSED url (a query) echoes the argument the handler received: clean only when the command
  // boundary stripped the augmentation (the parser's own normalization never sees a refusal's echo)
  expect(await typed('/wiki_links vscode-insiders://olcan.auto-open-obsidian/link/{link}?q=1 /Users/o c/v')).toBe(
    '/wiki_links: refused vscode-insiders://olcan.auto-open-obsidian/link/{link}?q=1 /Users/o c/v (a url is <scheme>://<host>/<path> without a query)'
  )
  expect(await page.evaluate(() => (window as any)._wiki_links)).toBeNull()
  expect(await typed('/wiki_links vscode-insiders://olcan.auto-open-obsidian/link/{link} /Users/o c/v')).toBe('wiki links: vscode-insiders://olcan.auto-open-obsidian/link/{link} under /Users/o c/v')
  expect(await page.evaluate(() => (window as any)._wiki_links)).toEqual({ url: 'vscode-insiders://olcan.auto-open-obsidian/link/{link}', root: '/Users/o c/v' })
  // the store carries the accepted config (saved through the item's store)
  await expect.poll(() => page.evaluate(() => JSON.stringify((window._item('#wiki_links') as any)._global_store.wiki_links)), { timeout: 15_000 }).toBe(
    JSON.stringify({ url: 'vscode-insiders://olcan.auto-open-obsidian/link/{link}', root: '/Users/o c/v' })
  )
  await page.evaluate(() => void (location.hash = '#e2e_wiki_startup'))
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_startup', true)?.elem?.querySelectorAll('a[data-wiki-link]').length), { timeout: 15_000 }).toBe(1)
  // every item saved before the reload (the app guards navigation with a beforeunload prompt
  // while a save is pending; the dialog handler above accepts one anyway)
  await expect.poll(() => page.evaluate(() => (window as any)._server_confirmed), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__items.filter(item => !item.savedId).length), { timeout: 60_000 }).toBe(0)
  // the setter's calls of the next load, each with the app's rendered flag at the call (the
  // property is trapped before the app defines it; the app assigns the setter once, at its init)
  await page.addInitScript(() => {
    const calls: Array<{ rendered: unknown; value: unknown }> = []
    let real: any
    Object.defineProperty(window, '_set_wiki_links', {
      configurable: true,
      get: () =>
        real &&
        ((value: unknown) => {
          calls.push({ rendered: (window as any).__rendered, value })
          return real(value)
        }),
      set: fn => void (real = fn),
    })
    ;(window as any).__wikiSetterCalls = calls
  })
  await page.reload()
  await waitForApp(page)
  // the first render sees the setting: the init hook applied it (epoch 1) before any render
  const config = { url: 'vscode-insiders://olcan.auto-open-obsidian/link/{link}', root: '/Users/o c/v' }
  expect(await page.evaluate(() => [(window as any)._wiki_links_epoch, (window as any)._wiki_links])).toEqual([1, config])
  expect(await page.evaluate(() => (window as any).__wikiSetterCalls[0]), 'the init hook applied the store before the first render').toEqual({ rendered: false, value: config })
  await page.evaluate(() => void (location.hash = '#e2e_wiki_startup'))
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_startup', true)?.elem?.querySelectorAll('a[data-wiki-link]').length), { timeout: 15_000 }).toBe(1)
  // the welcome's reapplication of the same value: a second call, no change
  await expect.poll(() => page.evaluate(() => (window as any).__wikiSetterCalls.length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  expect(await page.evaluate(() => (window as any).__wikiSetterCalls.slice(1).map((c: any) => c.value))).toEqual([config])
  expect(await page.evaluate(() => (window as any)._wiki_links_epoch), 'an equal reapplication changes nothing').toBe(1)
  expect(await command('/wiki_links off')).toContain('wiki links: off')
  expect(await page.evaluate(() => (window as any)._wiki_links)).toBeNull()
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_startup', true)?.elem?.querySelectorAll('a[data-wiki-link]').length), { timeout: 15_000 }).toBe(0)
})

// THE INERT SECTIONS THAT CLOSE (src/inert_blocks.ts; the owner, 2026-11-19): the frames of an
// item's inert regions stand in blocks under one head line each. The decision's table is
// tests/unit/inert_blocks.spec.ts; these rows click real heads on rendered items
const region = (body: string) => `<!--inert-->\n${body}\n<!--/inert-->`
type Fold = {
  selected: boolean
  stored: boolean // the layout holds the height of the item's box
  blocks: { state: string; memory: string; matched: boolean; says: string | null; head: string; frames: number; lines: number }[]
}
// what the inert blocks of the item ON THE PAGE show (not a mount in the offscreen column): per
// block whether it is the one head line (its status shown, its frames not) or open (the frames
// shown, the status not), what a click left on it, whether the search opens it, what its marker
// says of it (aria-expanded), the head's name and status, and its height with its margins in lines
// of the item's text
const fold = (page: import('@playwright/test').Page, label: string): Promise<Fold | null> =>
  page.evaluate(label => {
    const w = window as any
    const item = w._item(label, true)
    const container = item && (document.querySelector(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${item.id}"]`) as HTMLElement | null)
    if (!container) return null
    const shown = (e: Element | null) => !!e && e.getClientRects().length > 0
    const lh = parseFloat(getComputedStyle(container.querySelector('.content')!).lineHeight)
    return {
      selected: container.classList.contains('target'),
      stored: container.offsetHeight == w.__items.find((i: any) => i.id == item.id).height,
      blocks: [...container.querySelectorAll('.inert-block')].map(block => {
        const frames = [...block.querySelectorAll(':scope > .vault-result')]
        const status = block.querySelector(':scope > .inert-line > .inert-status')
        const style = getComputedStyle(block)
        return {
          state: frames.every(shown) && !shown(status) ? 'open' : !frames.some(shown) && shown(status) ? 'line' : 'mixed',
          says: block.querySelector(':scope > .inert-line > .inert-toggle')?.getAttribute('aria-expanded') ?? null,
          memory: ['opened', 'closed'].filter(c => block.classList.contains(c)).join(' '),
          matched: block.classList.contains('matched'),
          head: [block.querySelector(':scope > .inert-line > .inert-name')?.textContent ?? '', status?.textContent ?? ''].join('|'),
          frames: frames.length,
          lines: Math.round((((block as HTMLElement).offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom)) / lh) * 100) / 100,
        }
      }),
    }
  }, label)
const query = (page: import('@playwright/test').Page, text: string) => page.evaluate(text => void (window as any).MindBox.set(text), text)
// the head line of an item's n-th block, on the page
const headOf = async (page: import('@playwright/test').Page, label: string, n = 0) => {
  const id = await page.evaluate(label => (window as any)._item(label, true).id, label)
  return page.locator(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${id}"] .inert-block`).nth(n).locator('> .inert-line')
}
// a click on the head's left end, where its small name stands (the status line can hold a link)
const clickHead = async (page: import('@playwright/test').Page, label: string, n = 0) => (await headOf(page, label, n)).click({ position: { x: 5, y: 8 } })

test("an inert section is one line until its item is selected, the search has a match inside it or its head is clicked: the click decides, across redraws, until its item's selection or the search changes", async ({ page }) => {
  await loadAdmin(page)
  const LABEL = '#e2e_fold'
  const text = (state: string, label = LABEL) => `${label} foldword tidy the shed\n${region(`agent\n- ${state}\n    - [x] empty the shelves\n    - [ ] sort the tools`)}\na line of the owner under the tree`
  const write = (label: string, text: string) => page.evaluate(([label, text]) => void (window as any)._item(label, true).write(text, ''), [label, text] as const)
  // a mark on the item's block element, and whether the block still is that element (nothing was built since).
  // A write renders its item twice, at once and a second later (`_Item.write` ends with a forced render: the
  // item's children, and so its blocks, are new again): the mark is left when none is pending
  const keep = async (label: string) => {
    await page.waitForFunction(label => !(window as any).__items.find((i: any) => i.id == (window as any)._item(label, true).id).tasks?.force_render, label)
    await page.evaluate(label => void (((window as any)._item(label, true).elem.querySelector('.inert-block') as any).__kept = true), label)
  }
  const kept = (label: string) => page.evaluate(label => !!((window as any)._item(label, true).elem.querySelector('.inert-block') as any).__kept, label)
  await page.evaluate(text => void window._create(text), text('working: sorting the tools'))
  const line = (head: string, more: object = {}) => ({ selected: false, stored: true, blocks: [{ state: 'line', memory: '', matched: false, says: 'false', head, frames: 1, lines: 1, ...more }] })
  const open = (head: string, lines: number, more: object = {}) => ({ selected: false, stored: true, blocks: [{ state: 'open', memory: '', matched: false, says: 'true', head, frames: 1, lines, ...more }] })
  const HEAD = 'agent|working: sorting the tools'

  // CLOSED BY DEFAULT: listed by a word of the owner's line (a match outside the section opens
  // nothing), the section is its head line, exactly as tall as a line of the item's text
  await query(page, 'foldword')
  await expect.poll(() => fold(page, LABEL), 'closed by default').toEqual(line(HEAD))
  // OPEN WHILE SELECTED, and nothing is remembered of it: closed again once another view shows the item
  await query(page, LABEL)
  await expect.poll(async () => (await fold(page, LABEL))?.blocks[0].state, 'open while the item is selected').toBe('open')
  const lines = (await fold(page, LABEL))!.blocks[0].lines
  expect(await fold(page, LABEL), 'the selection leaves nothing on the block').toEqual({ ...open(HEAD, lines), selected: true })
  // DESELECTED AND SELECTED WITH NOTHING BUILT. The query's FIRST word names the selected item, so a word that
  // misses the item, put first, deselects it while what matched the item, and so its html and its children, stay
  // as they are (the premise below: the same block element; a query that changes the item's matching terms
  // writes its html anew, which is how every other step here gets a new block). The block closes and opens by
  // css alone, and its marker is told by the selection's own turn (Item.svelte, saidTarget)
  await keep(LABEL)
  await query(page, `nothingsuch ${LABEL}`)
  await expect.poll(() => fold(page, LABEL), 'deselected with nothing built: closed, and the marker says so').toEqual(line(HEAD))
  await query(page, LABEL)
  await expect.poll(() => fold(page, LABEL), 'selected again with nothing built: open, and the marker says so').toEqual({ ...open(HEAD, lines), selected: true })
  expect(await kept(LABEL), 'the premise: nothing was built for either (the block is the same element)').toBe(true)
  await query(page, 'foldword')
  await expect.poll(() => fold(page, LABEL), 'closed again when no longer selected').toEqual(line(HEAD))

  // A CLICK ON THE HEAD opens it and decides from then on (and the layout holds the new height: `stored`, which
  // no update of the item's component brings here, only the toggle's own report)
  await clickHead(page, LABEL)
  await expect.poll(() => fold(page, LABEL), 'a click on the head opens the section').toEqual(open(HEAD, lines, { memory: 'opened' }))
  // A REDRAW (an agent's write of its tree: the item's children are all new) keeps what the click left
  await keep(LABEL)
  await write(LABEL, text('working: labelling the boxes'))
  const HEAD2 = 'agent|working: labelling the boxes'
  await expect.poll(() => fold(page, LABEL), 'open across a redraw, with the new status line').toEqual(open(HEAD2, lines, { memory: 'opened' }))
  expect(await kept(LABEL), 'the block is a new element').toBe(false)
  // UNTIL ITS ITEM'S SELECTION CHANGES. Opened by hand in an item that is not selected: once the item is selected
  // the section is open as any selected item's is, with nothing left of the click, and closed when the item is left
  await query(page, LABEL)
  await expect.poll(() => fold(page, LABEL), 'opened by hand, then selected: open, the toggle forgotten').toEqual({ ...open(HEAD2, lines), selected: true })
  await query(page, 'foldword')
  await expect.poll(() => fold(page, LABEL), 'and left again: closed').toEqual(line(HEAD2))
  // the toggle reports its item's new height itself: a click the block alone hears (a dispatched one that
  // does not bubble, so nothing else of the app hears it), and the layout's height of the item read in the
  // same turn, before any other update of the item can bring it
  const told = () =>
    page.evaluate(label => {
      const w = window as any
      const item = w._item(label, true)
      const container = document.querySelector(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${item.id}"]`) as HTMLElement
      const before = container.offsetHeight
      container.querySelector('.inert-block')!.dispatchEvent(new MouseEvent('click'))
      return [container.offsetHeight != before, container.offsetHeight == w.__items.find((i: any) => i.id == item.id).height]
    }, LABEL)
  expect(await told(), 'the height changed, and the layout holds it at once').toEqual([true, true])
  await expect.poll(() => fold(page, LABEL)).toEqual(open(HEAD2, lines, { memory: 'opened' }))
  expect(await told(), 'closed again likewise').toEqual([true, true])
  await expect.poll(() => fold(page, LABEL)).toEqual(line(HEAD2, { memory: 'closed' }))
  // closed by hand in the SELECTED item (a click on a section the selection holds open closes it); left and come
  // back to, it is open. The leave is the query that deselects with nothing built (above): the block is the same
  // element, which loses the toggle's class, and its marker says what shows after each step
  await query(page, LABEL)
  await expect.poll(() => fold(page, LABEL), 'selected: open, the toggle forgotten').toEqual({ ...open(HEAD2, lines), selected: true })
  await clickHead(page, LABEL)
  await expect.poll(() => fold(page, LABEL), 'closed by hand in the selected item').toEqual({ ...line(HEAD2, { memory: 'closed' }), selected: true })
  await keep(LABEL)
  await query(page, `nothingsuch ${LABEL}`)
  await expect.poll(() => fold(page, LABEL), 'left: closed as any item that is not selected, nothing left of the click').toEqual(line(HEAD2))
  await query(page, LABEL)
  await expect.poll(() => fold(page, LABEL), 'and come back to: open').toEqual({ ...open(HEAD2, lines), selected: true })
  expect(await kept(LABEL), 'the premise: nothing was built for either').toBe(true)

  // THE SELECTION ALONE, UNDER A SEARCH THAT STANDS. A select in the app is a query, so the steps above changed the
  // search too, which forgets every toggle by itself (below). Under ONE query an item's selection changes when the
  // item that the query names is renamed (an agent's write): it ceases to be the selected one, and is again
  const RENAMED = '#e2e_folded'
  const HERE = 'working: labelling the boxes'
  await clickHead(page, LABEL)
  await expect.poll(() => fold(page, LABEL)).toEqual({ ...line(HEAD2, { memory: 'closed' }), selected: true })
  await write(LABEL, text(HERE, RENAMED))
  await expect.poll(() => fold(page, RENAMED), 'renamed under the query that named it: no longer selected, and the toggle is forgotten').toEqual(line(HEAD2))
  await clickHead(page, RENAMED)
  await expect.poll(() => fold(page, RENAMED), 'opened by hand while it is not selected').toEqual(open(HEAD2, lines, { memory: 'opened' }))
  await write(RENAMED, text(HERE))
  await expect.poll(() => fold(page, LABEL), 'named by the query again: selected, open, the toggle forgotten').toEqual({ ...open(HEAD2, lines), selected: true })
  await write(LABEL, text(HERE, RENAMED))
  await expect.poll(() => fold(page, RENAMED), 'and closed once it is no longer selected').toEqual(line(HEAD2))
  expect(await page.evaluate(() => (window as any).MindBox.get()), 'the premise: one query throughout').toBe(LABEL)
  await write(RENAMED, text(HERE))
  await expect.poll(() => fold(page, LABEL), 'named by the query for the steps below: selected, open').toEqual({ ...open(HEAD2, lines), selected: true })
  // THE SAME WHILE THE ITEM SHOWS NO BODY, its editor open. The query is two words, the first the item's label: the
  // item is selected, and the query does not follow a rename (as a query of the label alone does). A section is
  // closed by hand and the editor opened; the label is renamed and saved in place (Cmd or Ctrl with S): the item is
  // no longer selected. The label is put back and the editor left: the item is selected again. Its selection
  // changed twice with no block on the page: the close is forgotten, the section is open and its marker says so
  const TWO = `${LABEL} foldword`
  await query(page, TWO)
  await expect.poll(() => fold(page, LABEL)).toEqual({ ...open(HEAD2, lines), selected: true })
  await clickHead(page, LABEL)
  await expect.poll(() => fold(page, LABEL), 'closed by hand in the selected item').toEqual({ ...line(HEAD2, { memory: 'closed' }), selected: true })
  const foldId = await page.evaluate(label => (window as any)._item(label, true).id as string, LABEL)
  const paragraph = page.locator(`#item-${foldId} p`).first()
  await paragraph.click({ position: { x: 40, y: (await paragraph.boundingBox())!.height - 12 } }) // (the owner's last line, under the closed section)
  const textarea = page.locator(`#textarea-${foldId}`)
  await expect(textarea).toBeVisible()
  await textarea.fill(text(HERE, RENAMED))
  await page.keyboard.press('ControlOrMeta+s') // save in place: the editor stays open
  // [the item's label, whether it is the selected one, whether a block of its is on the page]
  const edited = () => page.evaluate(id => [(window as any).__items.find((i: any) => i.id == id).label, (window as any).__items.find((i: any) => i.id == id).target, !!document.querySelector(`#item-${id} .inert-block`)], foldId)
  await expect.poll(edited, 'renamed and saved from its editor: no longer selected, with no body on the page').toEqual([RENAMED, false, false])
  expect([await textarea.isVisible(), await page.evaluate(() => (window as any).MindBox.get())], 'the premise: the editor is open still, under the one query').toEqual([true, TWO])
  await textarea.fill(text(HERE))
  await page.keyboard.press('Shift+Enter') // save, and leave the editor
  await expect(textarea).toBeHidden()
  await expect.poll(() => fold(page, LABEL), 'selected again on leaving the editor: the close is forgotten, the section open, its marker saying so').toEqual({ ...open(HEAD2, lines), selected: true })

  // A SEARCH MATCH INSIDE opens it for as long as the match lasts
  await query(page, 'shelves')
  await expect.poll(() => fold(page, LABEL), 'a match inside opens the section').toEqual(open(HEAD2, lines, { matched: true }))
  await expect.poll(() => page.evaluate(label => (window as any)._item(label, true).elem.querySelectorAll('.inert-block > .vault-result span.highlight').length, LABEL), 'the match is the highlighter\'s').toBeGreaterThan(0)
  // a click decides over the match (it is never a dead one): it closes the matched section, which stays closed
  // while that search stands, across a redraw too
  await clickHead(page, LABEL)
  await expect.poll(() => fold(page, LABEL), 'a click closes a section the search opened').toEqual(line(HEAD2, { memory: 'closed', matched: true }))
  await write(LABEL, text('working: sorting the tools'))
  await expect.poll(() => fold(page, LABEL), 'and it stays closed under that search, across a redraw').toEqual(line(HEAD, { memory: 'closed', matched: true }))
  // ANY CHANGE OF THE SEARCH forgets it. A word that misses the item leaves what matched the item, and so its html
  // and its block, as they were (the premise): the block loses the toggle's class and the match opens it again
  await keep(LABEL)
  await query(page, 'shelves nothingsuch')
  await expect.poll(() => fold(page, LABEL), 'a word added to the search: the toggle is forgotten, and the match opens the section').toEqual(open(HEAD, lines, { matched: true }))
  expect(await kept(LABEL), 'the premise: nothing was built').toBe(true)
  // A TOGGLE MADE BEFORE A SEARCH is forgotten by the search's change too, and for good: opened by hand under one
  // search, the section is closed under the next (the same block, again) and stays closed across a redraw
  await query(page, 'foldword')
  await expect.poll(() => fold(page, LABEL), 'under another search, with a new block: closed, nothing of the toggle is back').toEqual(line(HEAD))
  await clickHead(page, LABEL)
  await expect.poll(() => fold(page, LABEL)).toEqual(open(HEAD, lines, { memory: 'opened' }))
  await keep(LABEL)
  await query(page, 'foldword nothingsuch')
  await expect.poll(() => fold(page, LABEL), 'opened by hand before the search changed: closed').toEqual(line(HEAD))
  expect(await kept(LABEL), 'the premise: nothing was built').toBe(true)
  await write(LABEL, text(HERE))
  await expect.poll(() => fold(page, LABEL), 'and closed across a redraw: nothing is left in the memory').toEqual(line(HEAD2))

  // A CONTEXT ITEM (shown as context of the selected one: here the parent, by its label, of the selected child) IS AS
  // IT WAS: it is not selected, so its section is closed, and a toggle by hand on it is not forgotten when it ceases
  // to be context or becomes it again. Under one query, as above: the selected child is renamed and named again
  const KID = `${LABEL}/kid`
  const context = () => page.evaluate(label => document.querySelector(`.column:not(.hidden) .container[data-item-id="${(window as any)._item(label, true).id}"]`)?.classList.contains('target_context'), LABEL)
  await page.evaluate(text => void window._create(text), `${KID} the selected child`)
  await query(page, KID)
  await expect.poll(context, 'the parent is shown as context of the selected child').toBe(true)
  await expect.poll(() => fold(page, LABEL), 'a context item: closed').toEqual(line(HEAD2))
  await clickHead(page, LABEL)
  await expect.poll(() => fold(page, LABEL)).toEqual(open(HEAD2, lines, { memory: 'opened' }))
  await write(KID, `${LABEL}_kid the selected child`)
  await expect.poll(context, 'the child renamed: the parent is no longer context').toBe(false)
  await expect.poll(() => fold(page, LABEL), 'no longer context: the toggle stands').toEqual(open(HEAD2, lines, { memory: 'opened' }))
  await write(`${LABEL}_kid`, `${KID} the selected child`)
  await expect.poll(context, 'context again').toBe(true)
  await expect.poll(() => fold(page, LABEL), 'context again: the toggle stands').toEqual(open(HEAD2, lines, { memory: 'opened' }))
})

test('inert sections that follow each other are one block under one head, a line of the owner keeps them apart; a link in the head is followed without a toggle; an open block is full width', async ({ page, context }) => {
  await loadAdmin(page)
  const link = new URL('/server_id', page.url()).href
  const tree = region(`agent\n- working: sorting the tools · [notes](${link})\n    - [x] empty the shelves`)
  const request = region('request\nPlease tidy the shed.\n\nKeep the red toolbox.')
  const MERGED = '#e2e_fold_merged'
  const BLANK = '#e2e_fold_blank'
  const APART = '#e2e_fold_apart'
  const ALONE = '#e2e_fold_request'
  const PLAIN = '#e2e_fold_plain'
  const HIDDEN = '#e2e_fold_hidden'
  const LINKED = '#e2e_fold_linked'
  const DIRECTIVE = '#e2e_fold_directive'
  const BAD = '#e2e_fold_bad'
  const REPLY = '#e2e_fold_reply'
  for (const text of [
    // (as the bridge leaves a todo: the tree under the todo line, the request on the next line)
    `${MERGED} foldmore a todo\n${tree}\n${request}\nthe last line of the owner`,
    `${BLANK} foldmore\n${tree}\n\n\n${request}`,
    `${APART} foldmore\n${region('agent\n- question: keep the old paint tins?')}\na line of the owner between\n${region('request\nSort the paint.')}`,
    `${ALONE} foldmore\n${region('request\nSort the paint tins by colour.\n\nKeep the lids.')}`,
    `${PLAIN} foldmore no section here\na second line`,
    `${HIDDEN} foldmore\n<!--hidden-->\n${tree}\n<!--/hidden-->\n${request}`,
    `${LINKED} foldmore\n[\n${tree}\n](https://example.com/)\n${request}`,
    `${DIRECTIVE} foldmore a todo\n/land\n${request}`, // (a todo made from a chat with a directive line, before an agent wrote)
    `${BAD} foldmore\n<!--inert-->\nnot canonical <!--/inert--> x\n<!--/inert-->`,
    `${REPLY} foldmore a chat\n${region('The plan is ready.\n\nIt has three steps.')}`, // (a section without a small name)
  ])
    await page.evaluate(text => void window._create(text), text)
  await query(page, 'foldmore')
  const block = (state: string, head: string, frames: number, more: object = {}) => ({ state, memory: '', matched: false, says: String(state == 'open'), head, frames, lines: 1, ...more })

  // ONE BLOCK for the tree and the request under it, its line the agent's status; the same with blank lines between them
  const HEAD = 'agent|working: sorting the tools · notes'
  await expect.poll(() => fold(page, MERGED), 'two sections that follow each other: one block, one head').toEqual({ selected: false, stored: true, blocks: [block('line', HEAD, 2)] })
  await expect.poll(() => fold(page, BLANK), 'blank lines between two sections: one block still').toEqual({ selected: false, stored: true, blocks: [block('line', HEAD, 2)] })
  // the request's first line while no agent has written
  await expect.poll(() => fold(page, ALONE)).toEqual({ selected: false, stored: true, blocks: [block('line', 'request|Sort the paint tins by colour.', 1)] })
  // THE CLOSED LINE'S LOOK: no arrow (the marker draws nothing and takes no room: the line starts with the small
  // name, or with the status text where the section has none), and the small name stands on the MIDDLE of the
  // status text's line, not on its baseline. (the line's height, one line of the item's text, is `lines` above)
  const lineLook = (label: string) =>
    page.evaluate(label => {
      const head = (window as any)._item(label, true).elem.querySelector('.inert-block > .inert-line') as HTMLElement
      const [marker, name, status] = ['.inert-toggle', '.inert-name', '.inert-status'].map(part => head.querySelector(':scope > ' + part))
      const rect = (e: Element) => e.getBoundingClientRect()
      const middle = (e: Element) => rect(e).top + rect(e).height / 2
      return { arrow: getComputedStyle(marker!, '::before').content, start: rect(name ?? status!).left - rect(head).left, centred: name ? Math.abs(middle(name) - middle(status!)) < 0.5 : null }
    }, label)
  expect(await lineLook(MERGED), 'a closed line: no arrow, the name first, on the middle of the status text').toEqual({ arrow: 'none', start: 0, centred: true })
  expect(await lineLook(REPLY), 'a closed line without a name: no arrow, the status text first').toEqual({ arrow: 'none', start: 0, centred: null })
  // A LINK IN THE HEAD is followed, and toggles nothing
  const popup = context.waitForEvent('page')
  await (await headOf(page, MERGED)).locator('a').click()
  expect((await popup).url(), 'the link of the status line is followed').toBe(link)
  await (await popup).close()
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
  expect(await fold(page, MERGED), 'and the block is as it was: no toggle').toEqual({ selected: false, stored: true, blocks: [block('line', HEAD, 2)] })
  expect(await page.evaluate(label => !!(window as any)._item(label, true).elem.querySelector('.container.editing'), MERGED), 'no editor either').toBe(false)

  // OPEN: the sections follow each other under their small names (the first one's is the head's),
  // a full-width block in the look of toggle(): no left border on the block or on a frame
  await clickHead(page, MERGED)
  await expect.poll(async () => (await fold(page, MERGED))?.blocks[0].state).toBe('open')
  const look = await page.evaluate(label => {
    const elem = (window as any)._item(label, true).elem as HTMLElement
    const rect = (e: Element) => e.getBoundingClientRect()
    const block = elem.querySelector('.inert-block')!
    const [first, second] = [...block.querySelectorAll(':scope > .vault-result')]
    const item = rect(elem.querySelector('.item')!)
    const shown = (e: Element | null) => !!e && e.getClientRects().length > 0
    return {
      edges: [rect(block).left - item.left, item.right - rect(block).right],
      borders: [block, first, second].map(e => getComputedStyle(e).borderLeftWidth),
      rules: [getComputedStyle(block).borderTopStyle, getComputedStyle(block).borderBottomStyle],
      names: [first, second].map(frame => [frame.querySelector(':scope > .inert-name')?.textContent, shown(frame.querySelector(':scope > .inert-name'))]),
      head: [...block.querySelectorAll(':scope > .inert-line > *')].map(e => [e.className, shown(e)]),
      arrow: getComputedStyle(block.querySelector(':scope > .inert-line > .inert-toggle')!, '::before').content,
      // from the block's top edge: the head's name, then the first section
      tops: [rect(block.querySelector(':scope > .inert-line > .inert-name')!).top - rect(block).top, rect(first).top - rect(block).top],
      gap: rect(second).top - rect(first).bottom,
      under: (elem.querySelector('.content')!.textContent ?? '').includes('the last line of the owner'),
    }
  }, MERGED)
  expect(look).toEqual({
    edges: [0, 0],
    borders: ['0px', '0px', '0px'],
    rules: ['dashed', 'dashed'],
    names: [['agent', false], ['request', true]],
    head: [['inert-toggle', true], ['inert-name', true], ['inert-status', false]],
    arrow: 'none',
    tops: [7, 25], // (the rule's 1px, then the name 6px under it; the section 24px under the rule)
    gap: 10,
    under: true,
  })

  // A CLICK ANYWHERE ON THE BLOCK TOGGLES IT, in an open section too, unless something inside took the click or a
  // text selection made it no tap. [state, what a toggle left] of the merged block, which the click above opened
  const merged = () => fold(page, MERGED).then(f => f?.blocks.map(b => [b.state, b.memory]))
  const mergedBlock = page.locator(`.column:not(.hidden) .container[data-item-id="${await page.evaluate(label => (window as any)._item(label, true).id, MERGED)}"] .inert-block`)
  // the window's box of a word of the open request
  const word = (text: string) =>
    page.evaluate(
      ([label, text]) => {
        const frame = (window as any)._item(label, true).elem.querySelectorAll('.inert-block > .vault-result')[1] as HTMLElement
        const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const at = walker.currentNode.nodeValue!.indexOf(text)
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(walker.currentNode, at)
          range.setEnd(walker.currentNode, at + text.length)
          const r = range.getBoundingClientRect()
          return { x: r.x, y: r.y + r.height / 2, width: r.width }
        }
        return null
      },
      [MERGED, text] as const
    )
  const selection = () => page.evaluate(() => [getSelection()!.type, getSelection()!.toString()])
  // THE KEYBOARD FOCUS (the owner, 2026-11-20: a tap on a section took it from another item's editor). A press on
  // a block is an ordinary press on text, which takes the focus from whatever has it; the tap that TOGGLES gives
  // it back, and a click that toggles nothing gives nothing back. Another item's editor is opened for the steps
  // below. `hold` gives it the focus where the page stands, with a selection of its own (backward, so that its
  // direction is read too), and `held` reads what has the focus (an id, else a tag name) and that editor's state
  const plainId = await page.evaluate(label => (window as any)._item(label, true).id as string, PLAIN)
  await page.locator(`#item-${plainId} p`).first().click()
  await expect(page.locator(`#textarea-${plainId}`)).toBeFocused()
  const EDITOR = `textarea-${plainId}`
  const hold = (id: string, start: number, end: number) =>
    page.evaluate(
      ([id, start, end]) => {
        const textarea = document.getElementById(id) as HTMLTextAreaElement
        textarea.focus({ preventScroll: true })
        textarea.setSelectionRange(start, end, 'backward')
      },
      [id, start, end] as const
    )
  const held = (id: string) =>
    page.evaluate(id => {
      const textarea = document.getElementById(id) as HTMLTextAreaElement
      return {
        active: document.activeElement?.id || document.activeElement?.tagName,
        selected: [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection],
        text: textarea.value,
        shown: getComputedStyle(textarea).visibility,
        focused: textarea.closest('.editor')!.classList.contains('focused'),
      }
    }, id)
  // an element at the window's middle (or top) UNTIL IT STAYS THERE: three readings 300 ms apart that agree, in
  // the window. FIRST A LAYOUT PASS OF THE APP'S (its seam for tests, `__layout`): an editor that opens or closes
  // moves items, and the next layout pass, whenever it comes, scrolls the page up to the first item that moved
  // when that stands above the window. Left to itself that pass came at any moment of the steps below (a followed
  // link's page is one thing that brings it): in four runs of this row a word to press then stood far outside the
  // window (at 1417 of 720) or an item a quarter of the window lower
  const settle = (target: import('@playwright/test').Locator, block: 'center' | 'start' = 'center') =>
    expect
      .poll(
        async () => {
          await page.evaluate(() => new Promise(resolve => ((window as any).__layout(), setTimeout(resolve, 300))))
          await target.evaluate((element, block) => element.scrollIntoView({ block }), block)
          const tops: number[] = []
          for (let n = 0; n < 3; n++) {
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
            tops.push(await target.evaluate(element => Math.round(element.getBoundingClientRect().top)))
          }
          // (and no layout that a re-measure queued is still to come: a new item's first render queues one, which
          // waits for 500 ms without a scroll)
          return tops.every(top => top == tops[0] && top >= -1 && top < page.viewportSize()!.height) && !(await page.evaluate(() => (window as any).__layoutPending as boolean))
        },
        { message: 'the element stays where the row scrolled it', timeout: 30_000 }
      )
      .toBe(true)
  const centre = () => settle(mergedBlock)
  await centre()
  await hold(EDITOR, 5, 9)
  const editing = await held(EDITOR)
  expect({ ...editing, text: editing.text.length > 9 }, "the premise: the other item's editor has the focus, with a selection of its own").toEqual({ active: EDITOR, selected: [5, 9, 'backward'], text: true, shown: 'visible', focused: true })
  // a link in an open section is followed, and toggles nothing
  const followed = context.waitForEvent('page')
  await mergedBlock.locator('> .vault-result a').first().click()
  expect((await followed).url(), 'a link in an open section is followed').toBe(link)
  await (await followed).close()
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
  expect(await merged(), 'and the block is open as it was').toEqual([['open', 'opened']])
  expect((await held(EDITOR)).active, 'a followed link gives no focus back: the editor does not have it').not.toBe(EDITOR)
  // a drag that selects text in an open section is no tap: the text is selected and the block stays open. And the
  // drag TAKES the focus from the editor, as it always did (a copy then takes the selected text)
  await centre()
  await hold(EDITOR, 5, 9)
  expect(await held(EDITOR), 'the premise: the editor has the focus again').toEqual(editing)
  const tidy = (await word('tidy'))!
  expect(tidy.y > 0 && tidy.y < page.viewportSize()!.height, 'the premise: the word to drag over is in the window').toBe(true)
  await page.mouse.move(tidy.x + 1, tidy.y)
  await page.mouse.down()
  await page.mouse.move(tidy.x + tidy.width - 1, tidy.y, { steps: 4 })
  await page.mouse.up()
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
  expect([await selection(), await merged()], 'a drag in an open section selects its text, and the block stays open').toEqual([['Range', 'tidy'], [['open', 'opened']]])
  expect((await held(EDITOR)).active, 'and the drag took the keyboard focus from the editor, which gets none back').toBe('BODY')
  // the click that ends that selection (beside it: the browser collapses the selection at the press) is no tap
  // either, and the next click is one: it closes the block
  const shed = (await word('shed'))!
  await page.mouse.click(shed.x + shed.width / 2, shed.y)
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
  expect([(await selection())[0] == 'Range', await merged()], 'a click that ends a selection toggles nothing').toEqual([false, [['open', 'opened']]])
  await page.mouse.click(shed.x + shed.width / 2, shed.y)
  await expect.poll(merged, "a click on an open section's text closes the block").toEqual([['line', 'closed']])
  expect(await page.evaluate(label => !!(window as any)._item(label, true).elem.querySelector('.container.editing'), MERGED), 'and opens no editor').toBe(false)
  // A TAP THAT TOGGLES LEAVES THE FOCUS WHERE IT WAS: on the closed line, which it opens, and on the open
  // section's text, which it closes. The editor is the active element after each as it was before the press, with
  // its selection, its text and its look, and nothing scrolled (the block's item is where it was in the window)
  const top = () => mergedBlock.evaluate(block => Math.round(block.closest('.container')!.getBoundingClientRect().top))
  await centre()
  await hold(EDITOR, 5, 9)
  expect(await held(EDITOR), 'the premise: the editor has the focus before the tap on the closed line').toEqual(editing)
  const closedTop = await top()
  await clickHead(page, MERGED)
  await expect.poll(merged, 'a tap on the closed line opens the section').toEqual([['open', 'opened']])
  expect([await held(EDITOR), await top()], 'and the focus is where it was: the editor is the active element, with its selection, and nothing scrolled').toEqual([editing, closedTop])
  await hold(EDITOR, 5, 9)
  expect(await held(EDITOR), "the premise: the editor has the focus before the tap on the open section's text").toEqual(editing)
  const text = (await word('shed'))!
  await page.mouse.click(text.x + text.width / 2, text.y)
  await expect.poll(merged, "a tap on the open section's text closes it").toEqual([['line', 'closed']])
  expect([await held(EDITOR), await top()], 'and the focus is where it was, the same').toEqual([editing, closedTop])
  // what is typed then goes where the editor's selection is, straight after the real tap: nothing of the row gives
  // the editor the focus in between (and the text is put back, so that Escape leaves the editor with nothing to
  // discard)
  await page.keyboard.type('Z')
  expect((await held(EDITOR)).text, "a typed character replaces the editor's selection").toBe(editing.text.slice(0, 5) + 'Z' + editing.text.slice(9))
  await page.keyboard.press('Backspace')
  await page.keyboard.type(editing.text.slice(5, 9))
  expect((await held(EDITOR)).text, 'the text is as it was').toBe(editing.text)
  // THE NOTE OF WHAT HAD THE FOCUS LIVES FOR ONE GESTURE (the code review of 2026-11-20). A press on the closed line
  // that is released OUTSIDE the block, on the item's own last line, is no click of the block's (and too slow to
  // be the item's edit tap): the drag took the focus, as a drag does, and gets none back. A click that reaches the
  // block afterwards with no press of its own (a dispatched one, which nothing else hears) toggles it and leaves the
  // focus where it is: the block used to keep the editor from that press, and focused it then
  await centre()
  await hold(EDITOR, 5, 9)
  const from = (await (await headOf(page, MERGED)).boundingBox())!
  const outside = await mergedBlock.evaluate(block => (item => ({ x: item.left + 80, y: item.bottom - 18 }))(block.closest('.container')!.getBoundingClientRect()))
  await page.mouse.move(from.x + 5, from.y + 8)
  await page.mouse.down()
  await page.mouse.move(outside.x, outside.y, { steps: 4 })
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
  await page.mouse.up()
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)))
  await page.evaluate(() => getSelection()!.removeAllRanges())
  const mergedEditing = () => page.evaluate(label => !!(window as any)._item(label, true).elem.querySelector('.container.editing'), MERGED)
  expect([(await held(EDITOR)).active, await merged(), await mergedEditing()], 'the premise: the release outside toggled nothing and opened no editor, and the focus is on the body').toEqual(['BODY', [['line', 'closed']], false])
  await mergedBlock.evaluate(block => void block.dispatchEvent(new MouseEvent('click')))
  expect([await merged(), (await held(EDITOR)).active], 'a click with no press of its own toggles the block and leaves the focus alone').toEqual([[['open', 'opened']], 'BODY'])
  await mergedBlock.evaluate(block => void block.dispatchEvent(new MouseEvent('click')))
  await expect.poll(merged).toEqual([['line', 'closed']])
  await hold(EDITOR, 5, 9)
  // A TALL SECTION ABOVE THE EDITOR STAYS WHERE IT WAS TAPPED (the code review of 2026-11-20). A pinned item with a
  // long tree stands directly above the edited item (pinned items come first, then the one being edited). The tap
  // that opens it adds more than the 300 px that queue a layout, which finds the edited item moved, under the
  // window's bottom edge by then, and its editor focused again: the route's scroll to the caret would take the
  // section out of the window. The layout that the resize queued is waited for (`__layoutPending`, `__layoutCount`),
  // then the frames its callback and the caret scroll's wait (two and four): the section is where it was tapped, and
  // the editor has the focus, with its selection
  const TALL = '#e2e_fold_tall'
  await page.evaluate(text => void window._create(text), `${TALL} foldmore #_pin/zzz_e2e_fold\n${region('request\nA short one.\n\nIt adds little.')}\na line of the owner between\n${region(`agent\n- working: a long list\n${Array.from({ length: 30 }, (_, n) => `    - [ ] step ${n + 1}`).join('\n')}`)}`)
  try {
    await expect.poll(async () => (await fold(page, TALL))?.blocks.map(b => b.state), 'the pinned item shows its two sections, a short one and the tall one, closed').toEqual(['line', 'line'])
    await page.waitForFunction(label => (item => !!item.savedId && !item.saving)((window as any).__items.find((item: any) => item.id == (window as any)._item(label, true).id)), TALL)
    const tallId = await page.evaluate(label => (window as any)._item(label, true).id as string, TALL)
    const tall = page.locator(`.column:not(.hidden) .super-container:not(.hidden) > .container[data-item-id="${tallId}"]`)
    // (the focus first: an editor's focus updates every item, each is measured again, and a new item's first
    // measure queues a layout, which `settle` then waits out)
    await hold(EDITOR, 5, 9)
    await settle(tall.locator('.inert-block').nth(0))
    // [the section's item in the window, its height, where the editor stands under it, layouts run, one pending]
    const stands = () =>
      page.evaluate(
        ([tallId, id]) => {
          const [item, editor] = [document.querySelector(`.column:not(.hidden) .container[data-item-id="${tallId}"]`)!.getBoundingClientRect(), document.getElementById(id)!.getBoundingClientRect()]
          return { top: Math.round(item.top), height: Math.round(item.height), under: Math.round(editor.top - item.bottom), layouts: (window as any).__layoutCount as number, pending: (window as any).__layoutPending as boolean }
        },
        [tallId, EDITOR] as const
      )
    // the layout that a resize queued has run (the count is up from `before` and none is pending), and so have
    // the frames its callback and the caret scroll's wait
    const laidOut = async (before: number) => {
      await expect.poll(async () => (s => s.layouts > before && !s.pending)(await stands()), 'the layout that the resize queued has run').toBe(true)
      await page.evaluate(() => new Promise<void>(resolve => (function frame(n: number) { requestAnimationFrame(() => (n ? frame(n - 1) : resolve())) })(12)))
    }
    // the item grows by 400 px as item code would grow it, reported through its resize hook with `reason`; what
    // stood at that moment is read in the same turn
    const grow = (reason: string) =>
      page.evaluate(
        ([id, reason]) => {
          const w = window as any
          const item = document.querySelector(`.column:not(.hidden) .container[data-item-id="${id}"]`)!
          const stood = { top: Math.round(item.getBoundingClientRect().top), height: Math.round(item.getBoundingClientRect().height), layouts: w.__layoutCount as number }
          const filler = document.createElement('div')
          filler.style.height = '400px'
          item.querySelector('.content')!.appendChild(filler)
          w._item_hooks[id].resize(reason)
          return { ...stood, grew: Math.round(item.getBoundingClientRect().height) - stood.height, queued: (w.__layoutPending as boolean) || w.__layoutCount > stood.layouts }
        },
        [tallId, reason] as const
      )
    // (what stands at a PRESS is read at the press: a layout of the app's own can come at any moment before it)
    const arm = () => tall.evaluate(item => item.addEventListener('mousedown', () => void ((window as any).__tapped = { top: Math.round(item.getBoundingClientRect().top), layouts: (window as any).__layoutCount }), { capture: true, once: true }))
    const tappedAt = () => page.evaluate(() => (window as any).__tapped as { top: number; layouts: number })
    const states = () => fold(page, TALL).then(f => f?.blocks.map(b => b.state))
    const closed = await stands()
    expect([await held(EDITOR), closed.under >= 0 && closed.under < 100], 'the premise: the editor has the focus, directly under the closed sections').toEqual([editing, true])
    // A SHORT TOGGLE WHOSE OPENED PART THEN GROWS BY ITSELF (the code review's third reading: a picture that starts to
    // load when its part shows). The tap adds less than the 300 px that queue a layout; the growth that follows is
    // reported under the reason an image's load uses, and queues one. The owner tapped once and did nothing since:
    // the page stays where it was tapped, through that layout and through the next one of the same kind
    await arm()
    await clickHead(page, TALL, 0)
    await expect.poll(states, 'a tap opens the short section').toEqual(['open', 'line'])
    const short = { ...(await tappedAt()), ...(await stands()) }
    const loaded = await grow('img.onload')
    expect([short.height > closed.height && short.height - closed.height < 300, loaded.grew, loaded.queued, loaded.top + loaded.height + 400 + short.under > page.viewportSize()!.height], 'the premise: the tap added less than 300 px, then the item grew by 400 px, which queued a layout, and the editor under it is out of the window').toEqual([true, 400, true, true])
    await laidOut(loaded.layouts)
    expect([await held(EDITOR), (await stands()).top], "after a short toggle's tap, the layout that its part's own growth queued leaves the section where it was tapped, and the editor the focus").toEqual([editing, loaded.top])
    const more = await grow('img.onload')
    await laidOut(more.layouts)
    expect([await held(EDITOR), (await stands()).top], 'and so does a second such layout: nothing follows a caret until the owner acts again').toEqual([editing, more.top])
    // UNTIL THE OWNER'S NEXT INPUT: one key in the editor (a Shift, which moves no caret), and the same growth is
    // followed to the editor's caret as it always was: the editor is back in the window, the section no longer
    // where it was
    await page.keyboard.press('Shift')
    const typed = await grow('img.onload')
    await laidOut(typed.layouts)
    const scrolled = await page.evaluate(id => Math.round(document.getElementById(id)!.getBoundingClientRect().top), EDITOR)
    expect([(await held(EDITOR)).active, scrolled > 0 && scrolled < page.viewportSize()!.height, (await stands()).top < typed.top], "after a key of the owner's, a layout that such growth queued scrolls to the editor's caret, as before").toEqual([EDITOR, true, true])
    // THE TALL SECTION: its tap alone adds more than the 300 px, and queues the layout itself
    await hold(EDITOR, 5, 9)
    await settle(tall.locator('.inert-block').nth(1))
    const before = await stands()
    await arm()
    await clickHead(page, TALL, 1)
    await expect.poll(states, 'a tap opens the tall section').toEqual(['open', 'open'])
    const tapped = await tappedAt()
    const opened = await stands()
    expect([opened.height - before.height > 300, opened.pending || opened.layouts > tapped.layouts, tapped.top + opened.height + opened.under > page.viewportSize()!.height], 'the premise: the section grew by more than 300 px, which queued a layout, and the editor under it is out of the window').toEqual([true, true, true])
    await laidOut(tapped.layouts)
    expect([await held(EDITOR), (await stands()).top], 'after that layout the section is where it was tapped, and the editor has the focus, with its selection').toEqual([editing, tapped.top])
    // THE SAME FOR A TOGGLE OF ITEM CODE'S OWN, which reports its item's height through the item's resize hook, as
    // `toggle` (template.js, toggle(), and the lazy toggle: no such item is installed in this lane, so the row grows
    // the item's content itself and reports as their click does)
    await page.keyboard.press('Shift') // (an input of the owner's: what the tall section's tap left is ended)
    const hooked = await grow('toggle')
    expect([hooked.grew, hooked.queued], 'the premise: the item grew by 400 px more, which queued a layout').toEqual([400, true])
    await laidOut(hooked.layouts)
    expect([await held(EDITOR), (await stands()).top], "after a layout that a toggle of item code's own queued, the same").toEqual([editing, hooked.top])
  } finally {
    await page.evaluate(label => (window as any)._item(label, true)?.delete(false), TALL)
    await expect.poll(() => page.evaluate(label => !(window as any)._item(label, true), TALL), 'the pinned item is gone again').toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(page.locator(`#textarea-${plainId}`)).toHaveCount(0)

  // AN OPEN SECTION WITHOUT A NAME (a reply) starts with its own first line: no head line above it (the empty
  // head has no height), and the same space above its text as above the first line of the item's own text.
  // (it is opened with the MINDBOX focused, its caret at a known place: the tap leaves the focus there too. The
  // head stands at the window's top for it, so that the MindBox, in the header above, is out of the window: a
  // focus that scrolled would bring it back. A CARET, not a selection: a plain focus scrolls the page to a box's
  // caret, and did not to a selection restored in the same turn, in the lanes' Chromium, so a mutant without
  // `preventScroll` passed over a selection. [the MindBox is above the window, the item's place in the window])
  await settle(await headOf(page, REPLY), 'start')
  const stood = () => page.evaluate(label => [document.getElementById('textarea-mindbox')!.getBoundingClientRect().bottom < 0, Math.round((window as any)._item(label, true).elem.getBoundingClientRect().top)], REPLY)
  await hold('textarea-mindbox', 3, 3)
  const [box, stand] = [await held('textarea-mindbox'), await stood()]
  expect([box.active, box.selected.slice(0, 2), box.shown, box.focused, stand[0]], 'the premise: the MindBox has the focus, out of the window, its caret at a known place').toEqual(['textarea-mindbox', [3, 3], 'visible', true, true])
  await clickHead(page, REPLY)
  await expect.poll(async () => (await fold(page, REPLY))?.blocks[0].state).toBe('open')
  expect([await held('textarea-mindbox'), await stood()], 'a tap that opens a section leaves the focus in the MindBox, with its caret, and nothing scrolled').toEqual([box, stand])
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  const reply = await page.evaluate(label => {
    const elem = (window as any)._item(label, true).elem as HTMLElement
    const block = elem.querySelector('.inert-block')!
    const style = getComputedStyle(block)
    // the top of the line of text that holds `text`, under `root`
    const line = (root: Element, text: string) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) if (walker.currentNode.nodeValue!.includes(text)) break
      const range = document.createRange()
      range.selectNodeContents(walker.currentNode)
      return range.getClientRects()[0].top
    }
    const item = elem.querySelector('.item')!
    return {
      arrow: getComputedStyle(block.querySelector(':scope > .inert-line > .inert-toggle')!, '::before').content,
      head: block.querySelector(':scope > .inert-line')!.getBoundingClientRect().height,
      // the section's top under the rule, against the block's own top padding
      section: [block.querySelector(':scope > .vault-result')!.getBoundingClientRect().top - block.getBoundingClientRect().top - parseFloat(style.borderTopWidth), parseFloat(style.paddingTop)],
      // the space above the reply's first line of text (from the rule) and above the item's (from the item's top edge)
      above: [line(block.querySelector(':scope > .vault-result')!, 'The plan is ready.') - block.getBoundingClientRect().top - parseFloat(style.borderTopWidth), line(elem.querySelector('.content')!, 'a chat') - item.getBoundingClientRect().top],
    }
  }, REPLY)
  expect({ ...reply, above: Math.abs(reply.above[0] - reply.above[1]) <= 0.5 }, 'an open reply: no arrow, no head line, its first line under the block\'s own padding, as far from the rule as the item\'s text from the item\'s edge').toEqual({ arrow: 'none', head: 0, section: [10, 10], above: true })

  // APART: a line of the owner between two sections stays visible between two blocks, each with its own toggle
  await expect.poll(() => fold(page, APART)).toEqual({
    selected: false,
    stored: true,
    blocks: [block('line', 'agent|question: keep the old paint tins?', 1), block('line', 'request|Sort the paint.', 1)],
  })
  await clickHead(page, APART, 1)
  await expect.poll(async () => (await fold(page, APART))?.blocks.map(b => b.state), 'the second block opens alone').toEqual(['line', 'open'])
  const between = await page.evaluate(label => {
    const elem = (window as any)._item(label, true).elem as HTMLElement
    const [first, second] = [...elem.querySelectorAll('.inert-block')].map(e => e.getBoundingClientRect())
    const walker = document.createTreeWalker(elem.querySelector('.content')!, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) if (walker.currentNode.nodeValue!.includes('a line of the owner between')) break
    const range = document.createRange()
    range.selectNodeContents(walker.currentNode)
    const owner = range.getBoundingClientRect()
    return owner.height > 0 && first.bottom <= owner.top && owner.bottom <= second.top
  }, APART)
  expect(between, 'the owner\'s line shows between the two blocks').toBe(true)

  // NEVER ACROSS THE END OF A CONTAINER: a section in a hidden part of the item, or in the label of a link of the
  // owner's, is not joined by the section after that part. Joined, the second one and the block's only head
  // would be hidden with the first, or a part of the owner's link. [frames, in a link, shown] per block
  const placed = (label: string) =>
    page.evaluate(label => [...(window as any)._item(label, true).elem.querySelectorAll('.inert-block')].map((block: Element) => [block.querySelectorAll(':scope > .vault-result').length, !!block.closest('a'), block.getClientRects().length > 0]), label)
  await expect.poll(() => placed(HIDDEN), 'a hidden section and the section after it: two blocks, the second one shown').toEqual([[1, false, false], [1, false, true]])
  await expect.poll(() => placed(LINKED), "a section in a link's label and the section after it: two blocks, the second one outside the link").toEqual([[1, true, true], [1, false, true]])

  // A REMEMBERED TOGGLE BELONGS TO ITS SECTION, NOT TO ITS PLACE. The request of a todo that reads todo, directive,
  // request is opened by hand; the agent's first tree lands under the todo line, above the directive: the request
  // stays open, and the new tree, a block of its own, is closed as a new one is
  const kept = (label: string) => fold(page, label).then(f => f?.blocks.map(b => [b.state, b.memory, b.head, b.frames]))
  const REQUEST = 'request|Please tidy the shed.'
  await expect.poll(() => kept(DIRECTIVE)).toEqual([['line', '', REQUEST, 1]])
  await clickHead(page, DIRECTIVE)
  await expect.poll(() => kept(DIRECTIVE)).toEqual([['open', 'opened', REQUEST, 1]])
  await page.evaluate(([label, text]) => void (window as any)._item(label, true).write(text, ''), [DIRECTIVE, `${DIRECTIVE} foldmore a todo\n${tree}\n/land\n${request}`] as const)
  await expect.poll(() => kept(DIRECTIVE), 'a tree written above the directive line: the request keeps its choice and the tree has none').toEqual([['line', '', HEAD, 1], ['open', 'opened', REQUEST, 1]])
  // the adjacent case: the tree lands right above an opened request, the two are one block, and it is open as the request was
  const SORT = 'request|Sort the paint tins by colour.'
  await clickHead(page, ALONE)
  await expect.poll(() => kept(ALONE)).toEqual([['open', 'opened', SORT, 1]])
  await page.evaluate(([label, text]) => void (window as any)._item(label, true).write(text, ''), [ALONE, `${ALONE} foldmore\n${tree}\n${region('request\nSort the paint tins by colour.\n\nKeep the lids.')}`] as const)
  await expect.poll(() => kept(ALONE), 'a tree written right above an opened request: one block, open as the request was').toEqual([['open', 'opened', HEAD, 2]])
  // and a toggle of that block is every section's of it: closed by hand, the request is closed when it stands alone again
  await clickHead(page, ALONE)
  await expect.poll(() => kept(ALONE)).toEqual([['line', 'closed', HEAD, 2]])
  await page.evaluate(([label, text]) => void (window as any)._item(label, true).write(text, ''), [ALONE, `${ALONE} foldmore\n${region('request\nSort the paint tins by colour.\n\nKeep the lids.')}`] as const)
  await expect.poll(() => kept(ALONE), "the block's toggle was the request's too").toEqual([['line', 'closed', SORT, 1]])

  // NOTHING ELSE: an item without a section has no block, and a malformed region keeps its placeholder, unframed by a block
  const others = await page.evaluate(([plain, bad]) => {
    const elem = (label: string) => (window as any)._item(label, true).elem as HTMLElement
    const frame = elem(bad).querySelector('.vault-result')!
    return {
      plain: elem(plain).querySelectorAll('.inert-block, .inert-line, .vault-result').length,
      bad: [elem(bad).querySelectorAll('.inert-block').length, frame.textContent, frame.getClientRects().length > 0, getComputedStyle(frame).borderLeftWidth],
    }
  }, [PLAIN, BAD] as const)
  expect(others).toEqual({ plain: 0, bad: [0, '⟦invalid inert region⟧', true, '2px'] })

  // A CHANGE THAT SWITCHES THE SEARCH OFF IS A CHANGE OF THE SEARCH. The page does not search for a text that
  // STARTS with a slash (a command being typed): a space before the slash-word makes it a search, and taking the
  // space away ends the search with the same words in the box. The todo with the directive line is found by
  // ` /land`; its request, opened by hand, is closed once the space is gone (not selected, not matched: the toggle
  // is forgotten), and its marker says so
  await query(page, ' /land')
  await expect.poll(() => kept(DIRECTIVE), 'found by its directive line, behind a space: both sections closed').toEqual([['line', '', HEAD, 1], ['line', '', REQUEST, 1]])
  await clickHead(page, DIRECTIVE, 1)
  await expect.poll(() => kept(DIRECTIVE)).toEqual([['line', '', HEAD, 1], ['open', 'opened', REQUEST, 1]])
  await query(page, '/land')
  expect(await page.evaluate(() => (window as any).MindBox.get()), 'the premise: the same words in the box, without the space').toBe('/land')
  await expect.poll(() => fold(page, DIRECTIVE).then(f => f?.blocks.map(b => [b.state, b.memory, b.says])), 'the space removed, the search is off: the toggle is forgotten, the request closed, its marker saying so').toEqual([['line', '', 'false'], ['line', '', 'false']])
})

test("a phone's width: a closed section is one line, a long status line cut with an ellipsis; a tap on the head opens it to the item's full width", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  try {
    await loadAdmin(page)
    const LABEL = '#e2e_fold_phone'
    const long = 'working: sorting every tool of the shed by its size and its colour, then the screws, the nails and the hooks'
    await page.evaluate(text => void window._create(text), `${LABEL} foldphone\n${region(`agent\n- ${long}\n    - [ ] sort the tools`)}`)
    await query(page, 'foldphone')
    await expect.poll(() => fold(page, LABEL)).toEqual({ selected: false, stored: true, blocks: [{ state: 'line', memory: '', matched: false, says: 'false', head: 'agent|' + long, frames: 1, lines: 1 }] })
    const measure = () =>
      page.evaluate(label => {
        const elem = (window as any)._item(label, true).elem as HTMLElement
        const block = elem.querySelector('.inert-block')!.getBoundingClientRect()
        const item = elem.querySelector('.item')!.getBoundingClientRect()
        const status = elem.querySelector('.inert-status') as HTMLElement
        const middle = (e: Element) => e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2
        return {
          // no arrow, and the small name on the middle of the status text's line, as at the desktop width
          arrow: getComputedStyle(elem.querySelector('.inert-toggle')!, '::before').content,
          start: elem.querySelector('.inert-line > .inert-name')!.getBoundingClientRect().left - elem.querySelector('.inert-line')!.getBoundingClientRect().left,
          centred: Math.abs(middle(elem.querySelector('.inert-line > .inert-name')!) - middle(status)) < 0.5, // (within a pixel says nothing here: the name's box is 16px of the head's 17px)
          cut: status.scrollWidth > status.clientWidth,
          ellipsis: getComputedStyle(status).textOverflow,
          inside: block.left >= item.left && block.right <= item.right,
          edges: [block.left - item.left, item.right - block.right],
        }
      }, LABEL)
    const closed = await measure()
    expect([closed.cut, closed.ellipsis, closed.inside], 'the long status line is cut at the block\'s width, inside the item').toEqual([true, 'ellipsis', true])
    expect([closed.arrow, closed.start, closed.centred], "no arrow at a phone's width either: the line starts with the name, on the middle of the status text").toEqual(['none', 0, true])
    // the tap, once the head rests in the window (a phone's page is long: the page brings the head to the
    // window's middle itself, and the point is read until two reads agree and the head is what stands there)
    const point = () =>
      page.evaluate(label => {
        const head = (window as any)._item(label, true).elem.querySelector('.inert-line') as HTMLElement
        const rect = head.getBoundingClientRect()
        const at = [Math.round(rect.left + 8), Math.round(rect.top + rect.height / 2)]
        if (head.contains(document.elementFromPoint(at[0], at[1]))) return at // (the head's small name stands at that point)
        head.scrollIntoView({ block: 'center' })
        return null
      }, LABEL)
    let at: number[] | null = null
    await expect
      .poll(async () => {
        const before = at
        at = await point()
        return !!at && !!before && at.join() == before.join()
      }, 'the head rests in the window')
      .toBe(true)
    const tapped = page.evaluate(() => new Promise<boolean>(resolve => document.addEventListener('click', e => resolve(!!(e.target as Element).closest('.inert-line')), { capture: true, once: true })))
    await page.touchscreen.tap(at![0], at![1])
    expect(await tapped, 'the tap came with its click, on the head').toBe(true)
    await expect.poll(async () => (await fold(page, LABEL))?.blocks.map(b => [b.state, b.memory]), 'a tap on the head opens it').toEqual([['open', 'opened']])
    expect((await measure()).edges, 'open, the block is as wide as the item').toEqual([0, 0])
    expect(await page.evaluate(label => !!(window as any)._item(label, true).elem.querySelector('.container.editing'), LABEL), 'the tap opened no editor').toBe(false)
  } finally {
    await context.close()
  }
})

test("a shared page, by the keyboard alone: Tab reaches a section's marker, which says closed and shows as a ring around the block; Enter and Space toggle it; Tab goes on to the link on the section's second line", async ({ page }) => {
  // A shared (fixed) page has no MindBox, no search and no selected item, and the app leaves the keys
  // alone there: a closed section opens by its marker or not at all, and a link on its second line is
  // reached through it. (On the app's own page the window takes Tab for the MindBox, so no Tab reaches
  // a marker there; Enter and Space are the marker's own keys on both pages.) The marker is no arrow: it
  // lies over its block, draws nothing, and shows as a ring just inside the block under the keyboard's focus
  await loadAdmin(page)
  const LABEL = '#e2e_fold_keys'
  const KEY = 'e2e_fold_keys'
  const [first, second] = ['first', 'second'].map(name => new URL(`/server_id?${name}`, page.url()).href)
  await page.evaluate(text => void window._create(text), `${LABEL} shared with a section\n${region(`The plan is [here](${first}).\nThe notes are [there](${second}) with \`/_invert\` and \`plain\`.`)}`)
  const saved = () => page.evaluate(label => (window as any)._item(label, true)?.saved_id ?? null, LABEL)
  await expect.poll(saved, { timeout: 30_000 }).toBeTruthy()
  await page.evaluate(([label, key]) => void (window as any)._item(label).share(key, 0), [LABEL, KEY] as const) // indexed: shown on the page
  await expect.poll(async () => (await firestore().collection('items').doc((await saved())!).get()).data()?.attr?.shared?.keys ?? null, { timeout: 30_000 }).toEqual([KEY])
  const uid = await page.evaluate(() => (window as any)._user.uid)
  await page.goto(`/?shared=${uid}/${KEY}`)
  await waitForApp(page)
  await page.getByText('View Shared Page', { exact: true }).click({ timeout: 30_000 }) // the shared page's welcome
  // [the marker's role, name and state], whether the section shows, and where the focus is
  const read = () =>
    page.evaluate(() => {
      const block = document.querySelector('.inert-block')
      const marker = block?.querySelector(':scope > .inert-line > .inert-toggle')
      if (!block || !marker) return null
      const active = document.activeElement
      const [over, box, style] = [marker.getBoundingClientRect(), block.getBoundingClientRect(), getComputedStyle(marker)]
      return {
        marker: [marker.getAttribute('role'), marker.getAttribute('aria-label'), marker.getAttribute('aria-expanded')],
        // what the marker draws: no arrow, and its ring (none, or its style and width) over the block (the block's box inside its rules)
        shows: [getComputedStyle(marker, '::before').content, style.outlineStyle == 'none' ? 'none' : style.outlineStyle + ' ' + style.outlineWidth, Math.abs(over.width - block.clientWidth) < 1 && Math.abs(over.height - block.clientHeight) < 1 && over.top >= box.top && over.bottom <= box.bottom],
        open: [...block.querySelectorAll(':scope > .vault-result')].every(frame => frame.getClientRects().length > 0),
        focus: active === marker ? 'marker' : active instanceof HTMLAnchorElement ? (active.closest('.inert-line') ? 'head ' : 'section ') + active.href : (active?.tagName ?? ''),
      }
    })
  expect(await page.evaluate(() => [new URLSearchParams(location.search).has('shared'), !!document.querySelector('.container.target')]), 'the shared page, no selected item').toEqual([true, false])
  const RING = ['none', 'solid 1px', true]
  await expect.poll(read, 'the section is closed, and its marker is a button that says so and shows nothing').toMatchObject({ marker: ['button', 'section', 'false'], shows: ['none', 'none', true], open: false })
  for (let n = 0; n < 15 && (await read())!.focus != 'marker'; n++) await page.keyboard.press('Tab')
  expect(await read(), 'Tab reaches the marker, which shows as a ring over the closed line').toMatchObject({ focus: 'marker', shows: RING })
  await page.keyboard.press('Enter')
  expect(await read(), 'Enter opens the section, and the marker says so: its ring is over the open block').toEqual({ marker: ['button', 'section', 'true'], shows: RING, open: true, focus: 'marker' })
  await page.keyboard.press('Space')
  expect(await read(), 'Space closes it').toEqual({ marker: ['button', 'section', 'false'], shows: RING, open: false, focus: 'marker' })
  // closed, the next stop is the link of the status line, a control of its own
  await page.keyboard.press('Tab')
  expect((await read())!.focus, "closed: the next stop is the head's link").toBe('head ' + first)
  await page.keyboard.press('Shift+Tab')
  expect((await read())!.focus).toBe('marker')
  // open, the stops after the marker are the section's own links: the first line's, then the second line's
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  expect((await read())!.focus, "open: the next stop is the section's first link").toBe('section ' + first)
  await page.keyboard.press('Tab')
  expect((await read())!.focus, "then the link on the section's second line").toBe('section ' + second)

  // on a shared page an inline-code command has the plain inline-code look (no tint, no pointer);
  // tapping it opens no dialog, runs nothing, and still toggles the section
  await page.evaluate(() => localStorage.removeItem('mindpage_inverted'))
  const sharedLook = await page.evaluate(() => {
    const frame = document.querySelector('.inert-block .vault-result')!
    const style = (e: Element) => {
      const s = getComputedStyle(e)
      return [s.color, s.backgroundColor, s.cursor]
    }
    return {
      cmd: style(frame.querySelector('code.command-link')!),
      plain: style(frame.querySelector('code:not(.command-link):not(.tag-link)')!),
    }
  })
  expect(sharedLook.cmd, 'on a shared page an inline-code command has the plain inline-code look').toEqual(sharedLook.plain)
  await page.locator('.inert-block .vault-result code.command-link').click()
  await page.evaluate(() => new Promise(r => setTimeout(r, 80)))
  expect((await read())!.open, 'tapping an inline-code command on a shared page still toggles the section').toBe(false)
  await expect(page.locator('.modal'), 'tapping an inline-code command on a shared page opens no dialog').toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem('mindpage_inverted')), 'tapping an inline-code command on a shared page runs nothing').toBeNull()
})

// THE LOOK OF DRAWN CHILD TAGS (the owner, 2026-11-23: "easier to distinguish from regular content and
// maybe also a bit more subtle", "50% alpha", "right-aligned"): half alpha except on the selected
// path, and at the right in both placements. Beside a bare name the tags stay inside the item on a
// narrow screen: wrapped ones above an opened log, one long name broken over lines. The block of an
// item with content stays after the content, where the app has always drawn it (below its log)
test('drawn child tags stand back at half alpha with the selected path lit, at the right, and wrapped ones keep their taps above an open log', async ({ page }) => {
  await loadAdmin(page)
  const P = '#e2e_ctlook' // content: the tags in a block of their own, after the content
  const N = '#e2e_ctbare' // a bare name and a log: the tags beside the name
  const C = '#e2e_ctcols' // content that leaves a div open, as the owner's columns macro does, and a log
  const L = '#e2e_ctlong' // a bare name with one child whose name is longer than a narrow line
  const longKid = `${L}/customer_onboarding_checklist_for_the_mobile_application_release`
  const kids = [0, 1, 2, 3, 4, 5].map(n => `${N}/wrapped_child_${n}`)
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  const setQuery = async (q: string) => {
    await page.evaluate(q => (window as any).MindBox.set(q, { scroll: true }), q)
    await expect.poll(() => query().then(v => v.trim())).toBe(q)
  }
  await page.evaluate(
    texts => texts.forEach(text => void window._create(text)),
    [
      `${P}/a child a`,
      `${P}/b child b`,
      `${P} Some content`,
      ...kids.map(kid => `${kid} a child`),
      `${N}\n\`\`\`_log\nINFO: a line\n\`\`\``,
      `${C}/k a child`,
      `${C}\n<div style="column-width:300px;column-rule:1px solid #222">\nordinary text\nin columns\n\n\`\`\`_log\nINFO: a line\n\`\`\``,
      `${longKid} a child`,
      L,
    ],
  )
  for (const label of [P, N, C, L])
    await expect.poll(() => page.evaluate(l => window._item(l, true)?.saved_id ?? null, label), { message: `${label} saved`, timeout: 30_000 }).toBeTruthy()
  // the drawn marks that show, the box they stand in, and where they are in the item
  const look = (label: string) =>
    page.evaluate(label => {
      const item = window._item(label, true)?.elem?.querySelector('.item') as HTMLElement | null
      if (!item) return null
      const marks = ([...item.querySelectorAll('mark.child-tag')] as HTMLElement[]).filter(m => m.checkVisibility())
      const box = item.querySelector('.child-tags') as HTMLElement | null
      const code = item.querySelector('.content code._log') as HTMLElement | null // hidden while the log is closed
      const log = code?.closest('pre') as HTMLElement | null
      const name = item.querySelector('mark.label') as HTMLElement | null
      const rect = (e: Element) => e.getBoundingClientRect()
      // the gap between the last mark and the item's right edge, and the room left of the first
      // one: at the right means a small gap that is not negative (a mark past the edge)
      const gap = marks.length ? rect(item).right - Math.max(...marks.map(m => rect(m).right)) : null
      const tap = (m: HTMLElement) => m.contains(document.elementFromPoint(rect(m).left + rect(m).width / 2, rect(m).top + rect(m).height / 2))
      return {
        marks: marks.map(m => [m.getAttribute('title'), getComputedStyle(m).opacity, m.classList.contains('selected')]),
        box: box ? [box.tagName, !!box.closest('.content')] : null,
        atRight: gap == null ? null : gap >= 0 && gap < 24 && rect(marks[0]).left - rect(item).left > 100,
        nameLine: name && marks.length ? Math.abs(rect(name).top - rect(marks[0]).top) < 12 : null,
        lines: new Set(marks.map(m => Math.round(rect(m).top))).size,
        logShows: code ? code.checkVisibility() : null,
        aboveLog: code?.checkVisibility() && log && marks.length ? Math.max(...marks.map(m => rect(m).bottom)) <= rect(log).top + 1 : null,
        taps: marks.map(tap),
      }
    }, label)

  await setQuery(P)
  await expect
    .poll(() => look(P), { message: 'content: the tags in a block of their own after it, at half alpha, at the right' })
    .toEqual({ marks: [[`${P}/a`, '0.5', false], [`${P}/b`, '0.5', false]], box: ['DIV', false], atRight: true, nameLine: false, lines: 1, logShows: null, aboveLog: null, taps: [true, true] })

  await setQuery(`${P}/a`)
  await expect
    .poll(() => look(P).then(l => l?.marks), { message: 'the child on the selected path is fully lit, its sibling stays at half alpha' })
    .toEqual([[`${P}/a`, '1', true], [`${P}/b`, '0.5', false]])

  await setQuery(C)
  await expect
    .poll(() => look(C), { message: "an open columns div in the content, and a closed log: the tags in their block after it, at the item's right edge" })
    .toEqual({ marks: [[`${C}/k`, '0.5', false]], box: ['DIV', false], atRight: true, nameLine: false, lines: 1, logShows: false, aboveLog: null, taps: [true] })

  await setQuery(N)
  await expect
    .poll(() => look(N), { message: 'a bare name: the tags beside it, on its line, at half alpha, at the right' })
    .toEqual({ marks: kids.map(kid => [kid, '0.5', false]), box: ['SPAN', true], atRight: true, nameLine: true, lines: 1, logShows: false, aboveLog: null, taps: kids.map(() => true) })

  // a narrow screen: the tags beside the bare name wrap, and an opened log starts below them, so
  // each takes its own tap (review 5 of the thread child_tags: the log covered the wrapped ones)
  await page.setViewportSize({ width: 360, height: 800 })
  await setQuery(N)
  const nId = await page.evaluate(l => window._item(l, true)!.id, N)
  await expect.poll(() => look(N).then(l => (l?.lines ?? 0) > 1), { message: 'a narrow screen: the tags wrap' }).toBe(true)
  await page.locator(`#item-${nId} .log-summary`).click()
  await expect
    .poll(() => look(N).then(l => [l?.logShows, l?.aboveLog, l?.taps]), { message: 'a narrow screen, the log open: the wrapped tags end above the log and each takes its own tap' })
    .toEqual([true, true, kids.map(() => true)])
  await page.locator(`#item-${nId} mark.child-tag[title="${kids[5]}"]`).click()
  await expect.poll(() => query().then(v => v.trim()), { message: 'a tap on the last wrapped tag goes to that child' }).toBe(kids[5])

  // one name longer than the narrow line: it breaks over lines inside the item, every piece of it
  // between the item's edges, and takes a tap (review 6: the unbroken name's start stood past the
  // left edge, where no scroll reaches)
  await setQuery(L)
  const pieces = () =>
    page.evaluate(label => {
      const item = window._item(label, true)?.elem?.querySelector('.item') as HTMLElement | null
      const mark = item?.querySelector('mark.child-tag') as HTMLElement | null
      if (!item || !mark) return null
      const box = item.getBoundingClientRect()
      const rects = [...mark.getClientRects()]
      const first = rects[0]
      return {
        title: mark.getAttribute('title'),
        pieces: rects.length > 1,
        inside: rects.every(r => r.left >= box.left - 0.5 && r.right <= box.right + 0.5),
        tap: !!first && mark.contains(document.elementFromPoint(first.left + first.width / 2, first.top + first.height / 2)),
      }
    }, L)
  await expect
    .poll(pieces, { message: 'a narrow screen, one long name: it breaks over lines, each piece inside the item, and takes a tap' })
    .toEqual({ title: longKid, pieces: true, inside: true, tap: true })
})

test('drawn child tags stay in sync when a native details disclosure opens and closes', async ({ page }) => {
  await loadAdmin(page)
  const P = '#e2e_ctd'
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  const visibleMarks = (label: string) =>
    page.evaluate(label => {
      const item = window._item(label, true)?.elem?.querySelector('.item')
      if (!item) return null
      return [...item.querySelectorAll('mark:not(.label,.deps-and-dependents *)')]
        .filter(m => m.checkVisibility())
        .map(m => [m.getAttribute('title'), m.classList.contains('child-tag')])
    }, label)

  await page.evaluate(
    ([parent, child]) => {
      void window._create(child)
      void window._create(parent)
    },
    [
      `${P} Overview\n<details open>\n<summary onclick="event.stopPropagation()">Children</summary>\n#/b\n</details>`,
      `${P}/b child b`,
    ] as const,
  )
  await expect.poll(() => page.evaluate(l => window._item(l, true)?.saved_id ?? null, P), { message: 'parent item saved', timeout: 30_000 }).toBeTruthy()
  await page.evaluate(q => (window as any).MindBox.set(q, { scroll: true }), P)
  await expect.poll(() => query().then(v => v.trim()), { message: 'query held on parent' }).toBe(P)

  await expect
    .poll(() => visibleMarks(P), { message: 'initially open native <details> shows written child tag and hides drawn copy' })
    .toEqual([[`${P}/b`, false]])

  const pId = await page.evaluate(l => window._item(l, true)!.id, P)
  // stamp the rendered <details> node so we also confirm full afterUpdate never replaced the DOM
  await page.evaluate(id => {
    const details = document.querySelector(`#item-${id} details`) as any
    details.__ctdKept = true
  }, pId)

  const summary = page.locator(`#item-${pId} details > summary`)
  for (const round of [1, 2]) {
    await summary.click()
    await expect
      .poll(() => visibleMarks(P), {
        message: `round ${round} close: closing native <details> reveals drawn child tag (exactly one visible mark)`,
      })
      .toEqual([[`${P}/b`, true]])
    expect(await query().then(v => v.trim()), `round ${round} close: query stays on parent`).toBe(P)
    expect(
      await page.evaluate(id => ({
        open: (document.querySelector(`#item-${id} details`) as HTMLDetailsElement | null)?.open ?? null,
        kept: !!(document.querySelector(`#item-${id} details`) as any)?.__ctdKept,
        editing: !!document.querySelector(`[data-item-id="${id}"].editing`),
      }), pId),
      `round ${round} close: <details> closed in place without editing or re-rendering`,
    ).toEqual({ open: false, kept: true, editing: false })

    await summary.click()
    await expect
      .poll(() => visibleMarks(P), {
        message: `round ${round} open: opening native <details> hides repeated drawn child tag (exactly one visible mark)`,
      })
      .toEqual([[`${P}/b`, false]])
    expect(await query().then(v => v.trim()), `round ${round} open: query stays on parent`).toBe(P)
    expect(
      await page.evaluate(id => ({
        open: (document.querySelector(`#item-${id} details`) as HTMLDetailsElement | null)?.open ?? null,
        kept: !!(document.querySelector(`#item-${id} details`) as any)?.__ctdKept,
        editing: !!document.querySelector(`[data-item-id="${id}"].editing`),
      }), pId),
      `round ${round} open: <details> opened in place without editing or re-rendering`,
    ).toEqual({ open: true, kept: true, editing: false })
  }
})

test('_context parent with no numbered children deduplicates folded reply and drawn child tags case-insensitively', async ({ page }) => {
  await loadAdmin(page)
  const P = '#e2e_ctc'
  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  const setQuery = async (q: string) => {
    await page.evaluate(q => (window as any).MindBox.set(q, { scroll: true }), q)
    await expect.poll(() => query().then(v => v.trim()), { message: `query set to ${q}` }).toBe(q.trim())
  }
  const pressArrow = async (key: string, expected: string, message: string) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
    await page.keyboard.press(key)
    await expect.poll(query, { message }).toBe(expected)
  }
  const visibleMarks = (label: string) =>
    page.evaluate(label => {
      const item = window._item(label, true)?.elem?.querySelector('.item')
      if (!item) return null
      return [...item.querySelectorAll('mark:not(.label,.deps-and-dependents *)')]
        .filter(m => m.checkVisibility())
        .map(m => [m.getAttribute('title'), m.classList.contains('child-tag'), m.classList.contains('selected')])
    }, label)
  const replyFrameVisible = (label: string) =>
    page.evaluate(label => {
      const item = window._item(label, true)?.elem?.querySelector('.item')
      const frame = item?.querySelector('.inert-block > .vault-result')
      return frame ? frame.checkVisibility() : null
    }, label)

  for (const text of [
    `${P} #_context chat\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n<!--inert-->\nOrdinary first paragraph before the child tag.\n\nTry #/b.\n<!--/inert-->`,
    `${P}/a child a`,
    `${P}/B child B`,
    `${P}/c child c`,
  ]) {
    await page.evaluate(t => void window._create(t), text)
  }
  await expect.poll(() => page.evaluate(l => window._item(l, true)?.saved_id ?? null, `${P}/c`), { message: 'children saved', timeout: 30_000 }).toBeTruthy()

  // start on #p/a with reply folded: stable deduplicated order is reply's #/b, then drawn a, c
  await setQuery(`${P}/a`)
  await expect.poll(() => replyFrameVisible(P), { message: 'reply is folded while parent is context for a' }).toBe(false)
  await expect
    .poll(() => visibleMarks(P), { message: 'folded reply shows drawn marks a (selected), B, c' })
    .toEqual([
      [`${P}/a`, true, true],
      [`${P}/B`, true, false],
      [`${P}/c`, true, false],
    ])

  // without case-insensitive uniqBy, Right from a steps to drawn B (opening reply), then loops back to a and never reaches c
  await pressArrow('ArrowRight', `${P}/c `, 'Right from a deduplicates #/b vs #/B and reaches c')
  await expect.poll(() => replyFrameVisible(P), { message: 'reply stays folded on c' }).toBe(false)
  // _context without numbered children is bounded at the ends (does not wrap)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)
  expect(await query(), 'Right at last _context stop stays on c').toBe(`${P}/c `)

  // full Left walk across all three stops: c -> a -> b (preserving reply position and spelling)
  const leftVisited: string[] = [await query()]
  await pressArrow('ArrowLeft', `${P}/a `, 'Left from c returns to a')
  await expect.poll(() => replyFrameVisible(P), { message: 'reply stays folded on a during Left walk' }).toBe(false)
  leftVisited.push(await query())
  await pressArrow('ArrowLeft', `${P}/b `, 'Left from a reaches b with reply spelling')
  await expect.poll(() => replyFrameVisible(P), { message: 'reply opens when Left reaches b' }).toBe(true)
  await expect
    .poll(() => visibleMarks(P), { message: 'open reply on b hides drawn B as repeated' })
    .toEqual([
      [`${P}/b`, false, true],
      [`${P}/a`, true, false],
      [`${P}/c`, true, false],
    ])
  leftVisited.push(await query())
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.())
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  expect(await query(), 'Left at first _context stop stays on b').toBe(`${P}/b `)
  expect(leftVisited, 'Left walk visits each child once in reverse order c, a, b').toEqual([
    `${P}/c `,
    `${P}/a `,
    `${P}/b `,
  ])

  // full Right walk across all three stops: b -> a -> c
  const rightVisited: string[] = [await query()]
  await pressArrow('ArrowRight', `${P}/a `, 'Right from b steps to a')
  await expect.poll(() => replyFrameVisible(P), { message: 'reply folds when Right leaves b for a' }).toBe(false)
  rightVisited.push(await query())
  await pressArrow('ArrowRight', `${P}/c `, 'Right from a reaches c on full forward walk')
  await expect.poll(() => replyFrameVisible(P), { message: 'reply stays folded on c on full forward walk' }).toBe(false)
  rightVisited.push(await query())
  expect(rightVisited, 'Right walk visits each child once in order b, a, c').toEqual([
    `${P}/b `,
    `${P}/a `,
    `${P}/c `,
  ])
})

test('drawn child tags stay in sync when a #template toggle opens and closes', async ({ page }) => {
  await loadAdmin(page)
  const P = '#e2e_ctt'
  if (!(await page.evaluate(() => !!window._item('#template', true)))) {
    expect(await install(page, 'template'), '/_install template').toBeNull()
    await expect
      .poll(() => page.evaluate(() => ((window as any).__items as any[]).every(i => i.savedId && !i.saving)), {
        message: 'installed #template items finished saving before reload',
        timeout: 30_000,
      })
      .toBe(true)
    await page.reload()
    await waitForApp(page)
  }

  const query = () => page.evaluate(() => (document.getElementById('textarea-mindbox') as HTMLTextAreaElement).value)
  const visibleMarks = (label: string) =>
    page.evaluate(label => {
      const item = window._item(label, true)?.elem?.querySelector('.item')
      if (!item) return null
      return [...item.querySelectorAll('mark:not(.label,.deps-and-dependents *)')]
        .filter(m => m.checkVisibility())
        .map(m => [m.getAttribute('title'), m.classList.contains('child-tag')])
    }, label)

  await page.evaluate(
    ([parent, child]) => {
      void window._create(child)
      void window._create(parent)
    },
    [`${P} #_template\n<<toggle('See #/b','More','More')>>`, `${P}/b child b`] as const,
  )
  await expect.poll(() => page.evaluate(l => window._item(l, true)?.saved_id ?? null, P), { message: 'template parent saved', timeout: 30_000 }).toBeTruthy()
  await page.evaluate(q => (window as any).MindBox.set(q, { scroll: true }), P)
  await expect.poll(() => query().then(v => v.trim()), { message: 'query held on template parent' }).toBe(P)

  const pId = await page.evaluate(l => window._item(l, true)!.id, P)
  await expect
    .poll(() => visibleMarks(P), { message: 'initially closed #template toggle shows drawn child tag only' })
    .toEqual([[`${P}/b`, true]])
  expect(
    await page.evaluate(id => ({
      spanVisible: !!document.querySelector(`#item-${id} span.template_toggle`)?.checkVisibility(),
      divVisible: !!document.querySelector(`#item-${id} div.template_toggle`)?.checkVisibility(),
    }), pId),
    'initially closed #template toggle shows label span and hides content div',
  ).toEqual({ spanVisible: true, divVisible: false })

  // stamp the rendered toggle div so we also confirm full afterUpdate never replaced the DOM
  await page.evaluate(id => {
    const div = document.querySelector(`#item-${id} div.template_toggle`) as any
    div.__cttKept = true
  }, pId)

  const openTrigger = page.locator(`#item-${pId} span.template_toggle`)
  const closeTrigger = page.locator(`#item-${pId} div.template_toggle`)
  for (const round of [1, 2]) {
    await openTrigger.click()
    await expect
      .poll(() => visibleMarks(P), {
        message: `round ${round} open: opening #template toggle hides repeated drawn child tag (exactly one visible mark)`,
      })
      .toEqual([[`${P}/b`, false]])
    expect(await query().then(v => v.trim()), `round ${round} open: query stays on template parent`).toBe(P)
    expect(
      await page.evaluate(id => ({
        spanVisible: !!document.querySelector(`#item-${id} span.template_toggle`)?.checkVisibility(),
        divVisible: !!document.querySelector(`#item-${id} div.template_toggle`)?.checkVisibility(),
        kept: !!(document.querySelector(`#item-${id} div.template_toggle`) as any)?.__cttKept,
        editing: !!document.querySelector(`[data-item-id="${id}"].editing`),
      }), pId),
      `round ${round} open: #template toggle opened in place without editing or re-rendering`,
    ).toEqual({ spanVisible: false, divVisible: true, kept: true, editing: false })

    // click in the div's padding (not on the <mark> inside) to close the toggle
    await closeTrigger.click({ position: { x: 4, y: 4 } })
    await expect
      .poll(() => visibleMarks(P), {
        message: `round ${round} close: closing #template toggle restores drawn child tag (exactly one visible mark)`,
      })
      .toEqual([[`${P}/b`, true]])
    expect(await query().then(v => v.trim()), `round ${round} close: query stays on template parent`).toBe(P)
    expect(
      await page.evaluate(id => ({
        spanVisible: !!document.querySelector(`#item-${id} span.template_toggle`)?.checkVisibility(),
        divVisible: !!document.querySelector(`#item-${id} div.template_toggle`)?.checkVisibility(),
        kept: !!(document.querySelector(`#item-${id} div.template_toggle`) as any)?.__cttKept,
        editing: !!document.querySelector(`[data-item-id="${id}"].editing`),
      }), pId),
      `round ${round} close: #template toggle closed in place without editing or re-rendering`,
    ).toEqual({ spanVisible: true, divVisible: false, kept: true, editing: false })
  }
})
