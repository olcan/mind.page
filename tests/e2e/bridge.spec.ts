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
import { firestore, install, loadAdmin, waitForApp } from './helpers.js'
import { focusMindbox, mindbox, visible } from './editor_helpers.js'

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
  // stays selectable and its links wired as before
  const elemId = await page.evaluate(() => window._item('#e2e_inert_md', true)!.elem!.id)
  await page.locator(`[id="${elemId}"] .vault-result h2`).click()
  await page.waitForTimeout(300)
  expect(
    await page.evaluate(id => ({
      editing: !!document.querySelector(`[id="${id}"] textarea, .container.editing`),
      frame: !!document.querySelector(`[id="${id}"] .vault-result h2`),
    }), elemId),
    'no editor after a click inside the inert frame'
  ).toEqual({ editing: false, frame: true })
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
  await expect.poll(() => page.evaluate(label => [...(window._item(label, true)?.elem?.querySelectorAll('mark[title]') ?? [])].map(m => m.getAttribute('title')).filter(t => t?.startsWith(label + '/')), PARENT)).toEqual(['#e2e_icx/10', '#e2e_icx/b'])
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
  await page.locator(`[id="${gammaElem}"] .vault-result mark.dangling`).click()
  await page.waitForTimeout(300)
  expect(await mindbox(page).inputValue(), 'a click on the dangling mark changes nothing').toMatch(/^#e2e_cc\/gamma ?$/)
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
  // the mark inside the link's label navigates and the anchor does not fire (no new page)
  await page.evaluate(label => (window as any).MindBox.set(label, { scroll: true }), CHAT)
  await expect.poll(query).toMatch(/^#e2e_cc ?$/)
  await page.locator(`[id="${elemId}"] .vault-result a mark[data-tag]`).first().click()
  await expect.poll(query).toBe('#e2e_cc/alpha ')
  await page.waitForTimeout(300)
  expect(context.pages().length, 'the anchor did not open').toBe(1)
  // a DANGLING mark inside a link (review 0 B1): the click navigates nowhere AND still cancels the anchor
  await page.locator(`[id="${elemId}"] .vault-result a mark.dangling`).click()
  await page.waitForTimeout(300)
  expect(await query(), 'the dangling mark navigated nowhere').toBe('#e2e_cc/alpha ')
  expect(context.pages().length, 'and its anchor did not open').toBe(1)
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
  // the frame stays dead for everything else: a text click opens no editor
  await page.locator(`[id="${elemId}"] .vault-result h2`).click()
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
  await expect.poll(state, { timeout: 15_000 }).toEqual({ chat: [['alpha', false, false], ['beta', false, false]], plain: [['gamma', false, false]] })
  // each child holds expansion state: the macro-evaluating read records it (expandMacros' path)
  for (const name of ['alpha', 'beta', 'gamma'])
    expect(await page.evaluate(n => window._item(n)!.read('', { eval_macros: true }), `${CHAT}/${name}`)).toContain('created in run ab12cd34')
  // the app's own deletion (no confirmation): the plain tag turns missing and the frame's mark dangling alike
  expect(await page.evaluate(n => window._item(n)!.delete(false), `${CHAT}/gamma`)).toBe(true)
  await expect.poll(state, { timeout: 15_000 }).toEqual({ chat: [['alpha', false, false], ['beta', false, false]], plain: [['gamma', true, false]] })
  expect(await page.evaluate(n => window._item(n)!.delete(false), `${CHAT}/alpha`)).toBe(true)
  await expect.poll(state, { timeout: 15_000 }).toEqual({ chat: [['#/alpha', false, true], ['beta', false, false]], plain: [['gamma', true, false]] })
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
            return !config || !(el.getAttribute('href') ?? '').startsWith(config.url + '?path=') || el.hasAttribute('target') || el.hasAttribute('rel')
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
            return !config || !(el.getAttribute('href') ?? '').startsWith(config.url + '?path=') || el.hasAttribute('target') || el.hasAttribute('rel')
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
    return { frame: after('.vault-result'), rule: after('hr'), text: content.textContent, spacer }
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
      underFirst: lines(rect(first.closest('p')!).bottom - rect(first).bottom),
      underSecond: lines(rect(second.closest('p')!.nextElementSibling!).top - rect(second).bottom),
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
      tickedMark: getComputedStyle(first.querySelector('span.task.checked')!, ':after').content,
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
  // the mark: a text-presentation check mark in the text's own color (the owner's choice of
  // 2026-09-15; the earlier heavy check mark could resolve to the color emoji font's tinted glyph)
  expect(layout.tickedMark, 'a ticked box shows the app\'s mark').toContain('✓')
  expect(layout.tickedMark, 'never the heavy check mark').not.toContain('✔')
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
// cancelable click whose default the test itself cancels, so no external application launches)
test('wiki links: the owner text and the inert frame link under the setting, on, off, on', async ({ page }) => {
  await loadAdmin(page)
  const config = { url: 'vscode-insiders://olcan.auto-open-obsidian/file', root: '/Users/o c/v' }
  const href = (path: string) => `${config.url}?path=${encodeURIComponent(path)}&root=${encodeURIComponent(config.root)}`
  await page.evaluate(() => {
    window._create('#e2e_wiki_hidden the hidden one [[docs/z]]')
    window._create('#e2e_wiki_owner see [[docs/x]] and [[notes/A&B|see #topic]] and `[[docs/code]]` and [[../etc/passwd]] and [[/abs]]')
    window._create(
      "#e2e_wiki_reply reply\n<<user>> q\n<<agent('vault/default · run ab12cd34 · 1s')>>\n<!--inert-->\nsee [[docs/y|guide]] and [[../x]] and [x](https://h/)\n<!--/inert-->"
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
            return !config || !(el.getAttribute('href') ?? '').startsWith(config.url + '?path=') || el.hasAttribute('target') || el.hasAttribute('rel')
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
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_owner', true)?.elem?.querySelectorAll('a[data-wiki-link]').length), { timeout: 15_000 }).toBe(2)
  const on = await state('#e2e_wiki_owner')
  expect(on.anchors).toEqual([
    { href: href('docs/x'), title: 'docs/x', text: 'docs/x', html: 'docs/x', attributes: ['data-wiki-link', 'href', 'title'], wired: true },
    { href: href('notes/A&B'), title: 'notes/A&B', text: 'see #topic', html: 'see #topic', attributes: ['data-wiki-link', 'href', 'title'], wired: true },
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
  expect(reply.anchors).toEqual([{ href: href('docs/y'), title: 'docs/y', text: 'guide', html: 'guide', attributes: ['data-wiki-link', 'href', 'title'], wired: true }])
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
  expect(await page.evaluate(() => (window as any)._wiki_links_epoch)).toBe(2)
  // ON again: both back, without an edit
  expect(await page.evaluate(config => (window as any)._set_wiki_links(config), config)).toEqual(config)
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_reply', true)?.elem?.querySelectorAll('.vault-result a[data-wiki-link]').length), { timeout: 15_000 }).toBe(1)
  expect((await state('#e2e_wiki_reply')).anchors[0].href).toBe(href('docs/y'))
  await shown('#e2e_wiki_owner')
  await expect.poll(() => page.evaluate(() => window._item('#e2e_wiki_owner', true)?.elem?.querySelectorAll('a[data-wiki-link]').length), { timeout: 15_000 }).toBe(2)
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
  expect(await command('/wiki_links vscode-insiders://olcan.auto-open-obsidian/file /Users/o c/v')).toContain('wiki links: vscode-insiders://olcan.auto-open-obsidian/file under /Users/o c/v')
  expect(await page.evaluate(() => (window as any)._wiki_links)).toEqual({ url: 'vscode-insiders://olcan.auto-open-obsidian/file', root: '/Users/o c/v' })
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
  expect(await typed('/wiki_links vscode-insiders://olcan.auto-open-obsidian/file?q=1 /Users/o c/v')).toBe(
    '/wiki_links: refused vscode-insiders://olcan.auto-open-obsidian/file?q=1 /Users/o c/v (a url is <scheme>://<host>/<path> without a query)'
  )
  expect(await page.evaluate(() => (window as any)._wiki_links)).toBeNull()
  expect(await typed('/wiki_links vscode-insiders://olcan.auto-open-obsidian/file /Users/o c/v')).toBe('wiki links: vscode-insiders://olcan.auto-open-obsidian/file under /Users/o c/v')
  expect(await page.evaluate(() => (window as any)._wiki_links)).toEqual({ url: 'vscode-insiders://olcan.auto-open-obsidian/file', root: '/Users/o c/v' })
  // the store carries the accepted config (saved through the item's store)
  await expect.poll(() => page.evaluate(() => JSON.stringify((window._item('#wiki_links') as any)._global_store.wiki_links)), { timeout: 15_000 }).toBe(
    JSON.stringify({ url: 'vscode-insiders://olcan.auto-open-obsidian/file', root: '/Users/o c/v' })
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
  const config = { url: 'vscode-insiders://olcan.auto-open-obsidian/file', root: '/Users/o c/v' }
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
