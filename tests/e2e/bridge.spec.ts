// e2e witnesses for the INERT reply boundary (design: vault notes/design/mind_bridge_v2.md).
// The v0/v1 PoC listener rows and their bin/mind_bridge.py spawn setup were retired with the
// legacy executor (review 189 §2.2): end-to-end Python dispatch evidence lives in the vault's
// Firestore-emulator component smoke and the recorded attended production canary. What remains
// here are the APP-side witnesses: hostile render classification, read/render domain
// separation, startup/run opacity, and decoded-body search.
// Request items carry a unique test-owned visible label plus a hidden #_agent/vault routing
// tag (the real /vault request shape): in the configured gate this lane runs behind the
// admin-installed corpus, which contains the #agent/vault provider item itself, and a second
// visible #agent/vault label would make _item(name, true) return null on the ambiguity.
import { expect, test } from '@playwright/test'
import { firestore, loadAdmin, waitForApp } from './helpers.js'

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
        // the placeholder must hold ONLY text nodes: any element/attribute means
        // decoded or raw candidate bytes reached the html grammar
        placeholderElements: [...(item?.elem?.querySelectorAll('.vault-result *') ?? [])].length,
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
  expect(valid.placeholderElements, 'the placeholder holds text nodes only').toBe(0)
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
  expect(bad.placeholderElements, 'the placeholder holds text nodes only').toBe(0)
  expect(bad.liveNodes, 'no script/img/handler/javascript-link element was created').toBe(0)
  expect(bad.messages, 'the raw <<user>> is not a delimiter in the grammar view').toBe(1)
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
        // candidate bytes initially enter through textContent and never create
        // candidate-supplied elements/attributes (review 183 §1.3)
        frameChildElements: [...(content?.querySelectorAll('.vault-result *') ?? [])].length,
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
    expect(r.frameChildElements, `${rc.name}: candidate bytes create no child elements`).toBe(0)
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