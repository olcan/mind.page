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
  expect(shape.text).toContain('<<not_a_macro>>')
  expect(shape.code).toBe('const x = 1 // note')
  expect(shape.marks).toBe(0)
  expect(shape.pwned).toBeNull()
  expect(shape.tags, 'a #tag inside the reply is not an item tag').not.toContain('#not_a_tag')
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
  await expect.poll(() => page.evaluate(name => !!window._item(name, true)!.elem!.querySelector('.container.editing'), breaksName), { timeout: 15_000 }).toBe(true) // the click opened the item for editing, as any click does
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
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    seen.editing = !!document.querySelector('#e2e_wiki_owner textarea, .container.editing')
    return seen
  })
  expect(click).toEqual({ bubbled: false, stopped: true, defaultPrevented: false, editing: false })
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
