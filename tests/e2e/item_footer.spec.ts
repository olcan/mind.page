import { expect, test, type Page } from '@playwright/test'
import { loadAnonymous } from './helpers.js'

// the footer of an item, whatever its content leaves open (Item.svelte: toHTML's wrapper, and the
// insertion in afterUpdate). An item's markup is two fragments: the body (the content in its
// wrapper, .content), which the browser parses alone and closes at the end of its input, and the
// generated footer (.deps-and-dependents, the log, deps and dependents summaries), inserted after
// it as a fragment of its own. The footer's styles are all written for children of .item, and
// until 2026-11-18 the two were one string, closed in between by one `</div>`: a div left open in
// the content (the owner's `columns()` macro leaves one, on purpose) took that tag, .content stayed
// open and the footer and both summaries became its children: out of reach of their layout and
// toggle rules, so always shown, a line each, and a click on a summary changed nothing visible.
// Three rows: the owner's item beside its twin without the div; a table of contents, each an item
// of the app, with what each does now; and the parser's behavior that the design rests on, on a
// blank page.
// The first two on the read-only visitor's page, with local items (`_create` saves nothing there).

const COLUMNS = '<div style="column-width:300px;column-rule:1px solid #222">'
const LINES = Array.from({ length: 9 }, (_, i) => `line ${i + 1} of ordinary text that is long enough to be wrapped in a narrow column of the item`).join('\n')

// THE ORACLE, installed in a page: for a body (the wrapper's opening tag and the content) and a
// generated footer, what the browser built BEFORE, when the two were one string with `</div>` in
// between and the cache key's comment at the end, less the generated nodes; and what it builds for
// the body alone NOW. `equal` is isEqualNode of the two (and of the fragments of their templates,
// which isEqualNode does not enter): parsing the body alone builds the body's tree as the one
// string did. Both inputs are the caller's: the oracle says nothing about where a body ends.
// - In a REAL div, and in BOTH documents an item's markup is parsed in: the page's, where
//   scripting is on (the template writes an update of a shown item there), and the inert document
//   of a template's fragment, where it is off (Svelte builds a new item's div there and writes its
//   markup before the div enters the page: a `noscript` is read as text in the first and as
//   markup in the second).
// - The generated nodes are told apart by a mark of their own, never by the footer's class, which
//   an item's own markup can carry: an attribute on every element of the footer, and a form feed
//   for each of its line breaks (whitespace to the parser like a line break, and absent from the
//   body: a table moves an element out of itself but keeps whitespace, so generated whitespace
//   can stand alone inside the item's own nodes).
type Oracle = (body: string, footer: string) => { equal: boolean; before: string; now: string }
const installOracle = (page: Page) =>
  page.evaluate(() => {
    ;(window as unknown as { __oracle: Oracle }).__oracle = (body, footer) => {
      let key = 'zz'
      while ((body + footer).includes(key)) key += 'z'
      if ((body + footer).includes('\f')) throw new Error('the oracle marks generated whitespace by a form feed, which this markup holds')
      const one = body + '</div>' + footer.replace(/<(div|span|mark)\b/g, `<$1 data-${key}`).replace(/\n/g, '\f') + `<!--${key}-->`
      // a node and the fragments of the templates under it
      const scopes = (root: ParentNode): ParentNode[] => [root, ...[...root.querySelectorAll('template')].flatMap(template => scopes(template.content))]
      const same = (a: ParentNode & Node, b: ParentNode & Node): boolean => {
        const [inA, inB] = [a.querySelectorAll('template'), b.querySelectorAll('template')]
        return a.isEqualNode(b) && inA.length == inB.length && [...inA].every((template, index) => same(template.content, inB[index].content))
      }
      const results = [document, document.createElement('template').content.ownerDocument].map(owner => {
        const before = owner.createElement('div')
        before.innerHTML = one
        for (const scope of scopes(before)) {
          for (const element of scope.querySelectorAll(`[data-${key}]`)) element.remove()
          const nodes = owner.createTreeWalker(scope, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT)
          const gone: ChildNode[] = []
          for (let node = nodes.nextNode() as CharacterData | null; node; node = nodes.nextNode() as CharacterData | null) {
            if (node.nodeType == Node.TEXT_NODE && node.data.includes('\f')) node.data = node.data.replaceAll('\f', '')
            if (node.nodeType == Node.TEXT_NODE ? !node.data : node.data == key) gone.push(node)
          }
          for (const node of gone) node.remove()
        }
        const now = owner.createElement('div')
        now.innerHTML = body
        for (const scope of [...scopes(before), ...scopes(now)]) (scope as ParentNode & Node).normalize()
        return { equal: same(before, now), before: before.innerHTML, now: now.innerHTML }
      })
      return { equal: results.every(result => result.equal), before: results.map(result => result.before).join('\n        '), now: results.map(result => result.now).join('\n        ') }
    }
  })

// an item's element, rendered if it is not on the page
const FOOTER = '.deps-and-dependents, .deps-summary, .dependents-summary, .log-summary'
type Part = { direct: boolean; style: Record<string, string>; fromBottom: number; left: number; width: number; height: number; children: string[] }
type Reading = { classes: string; itemHeight: number; below: number; parts: Record<string, Part | null>; columns: number[]; columnWidth: string }
// the footer, its two lists and the summaries of an item on the page: whether each is a child of
// the item (the lists of the footer), its computed style, its box against the item's, its
// children's `display`; and the left edges of the text's lines inside the columns div, if any
const footerOf = (page: Page, label: string) =>
  page.evaluate((label): Reading => {
    const elem = window._item(label)!.elem as HTMLElement
    const itemdiv = elem.querySelector('.item') as HTMLElement
    const box = itemdiv.getBoundingClientRect()
    const round = (value: number) => Math.round(value * 10) / 10
    const part = (selector: string, parent: Element | null): Part | null => {
      const e = itemdiv.querySelector(selector) as HTMLElement | null
      if (!e) return null
      const style = getComputedStyle(e)
      const rect = e.getBoundingClientRect()
      const properties = ['display', 'position', 'font-size', 'line-height', 'margin-left', 'padding-top', 'padding-bottom', 'bottom', 'cursor', 'justify-content', 'overflow-x', 'color', 'background-color', 'font-weight']
      return {
        direct: e.parentElement == parent,
        style: Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)])),
        // (an element that is not displayed has no box: zeros, whatever the item's place on the page)
        fromBottom: rect.height ? round(box.bottom - rect.bottom) : 0,
        left: rect.height ? round(rect.left - box.left) : 0,
        width: round(rect.width),
        height: round(rect.height),
        children: [...e.children].map(child => child.className + ':' + getComputedStyle(child).display),
      }
    }
    const footer = itemdiv.querySelector('.deps-and-dependents')
    const columns = itemdiv.querySelector('[style*="column-width"]')
    const lefts = new Set<number>()
    if (columns) {
      const walker = document.createTreeWalker(columns, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent!.trim() || node.parentElement!.closest('.deps-and-dependents, .deps-summary, .dependents-summary')) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const line of range.getClientRects()) if (line.width) lefts.add(Math.round(line.left - box.left))
      }
    }
    const content = itemdiv.querySelector('.content') as HTMLElement
    const text = columns ?? content.lastElementChild ?? content // the last of the item's own text
    return {
      classes: [...(elem.querySelector('.container') as HTMLElement).classList].filter(name => name.startsWith('show')).join(' '),
      itemHeight: round(box.height),
      below: round(box.bottom - text.getBoundingClientRect().bottom), // from the end of the text to the item's bottom edge
      parts: {
        footer: part('.deps-and-dependents', itemdiv),
        deps: part('.deps-and-dependents .deps', footer),
        dependents: part('.deps-and-dependents .dependents', footer),
        depsTitle: part('.deps-and-dependents .deps-title', footer?.querySelector('.deps') ?? null),
        depsSummary: part('.deps-summary', itemdiv),
        dependentsSummary: part('.dependents-summary', itemdiv),
      },
      columns: [...lefts].sort((a, b) => a - b),
      columnWidth: columns ? getComputedStyle(columns).columnWidth : '',
    }
  }, label)

// shows an item by its label (the query names it) and waits until it stands in a visible column
async function show(page: Page, label: string) {
  await page.evaluate(label => void (location.hash = label), label)
  await expect.poll(() => page.evaluate(label => !!window._item(label, true)?.elem?.closest('.column:not(.hidden)'), label), { message: `${label} shown`, timeout: 30_000 }).toBe(true)
}

test('the footer of an item that leaves a div open is the item\'s own: placed, styled and toggled as its twin\'s', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await loadAnonymous(page)
  for (const text of [
    "#zz_close/macros\n```js\nconst columns = () => '" + COLUMNS + "' // left open on purpose\n```",
    `<<columns()>> #zz_close/open #_zz_close/macros\n${LINES}`,
    `#zz_close/twin #_zz_close/macros\n${LINES}`,
    '#zz_close/open_user #_zz_close/open\na dependent of the item with the open div',
    '#zz_close/twin_user #_zz_close/twin\na dependent of its twin',
  ])
    await page.evaluate(text => void window._create(text), text)
  // the four states of each, by real clicks on its summaries: as rendered, the dependencies shown,
  // the dependents shown (the dependencies clicked off), both off again
  const states = async (label: string) => {
    await show(page, label)
    const id = await page.evaluate(label => window._item(label)!.id, label)
    const summary = (name: string) => page.locator(`#super-container-${id} .${name}-summary`)
    const readings = [await footerOf(page, label)]
    await summary('deps').click()
    readings.push(await footerOf(page, label))
    await summary('deps').click()
    await summary('dependents').click()
    readings.push(await footerOf(page, label))
    await summary('dependents').click()
    readings.push(await footerOf(page, label))
    return readings
  }
  const open = await states('#zz_close/open')
  const twin = await states('#zz_close/twin')
  expect(twin.map(reading => reading.classes), 'the toggles of the twin').toEqual(['', 'showDeps', 'showDependents', ''])
  expect(open.map(reading => reading.classes), 'the toggles of the item with the open div').toEqual(['', 'showDeps', 'showDependents', ''])
  // the premise, on the twin: a footer that is hidden until a summary is clicked, with one list at a time
  expect(twin.map(reading => [reading.parts.footer!.style.display, reading.parts.deps!.style.display, reading.parts.dependents!.style.display])).toEqual([
    ['none', 'none', 'none'],
    ['block', 'inline', 'none'],
    ['block', 'none', 'inline'],
    ['none', 'none', 'none'],
  ])
  expect(twin[0].parts.depsSummary!.style.position, "the twin's summaries sit on the item's bottom edge").toBe('absolute')
  for (const [state, reading] of open.entries()) {
    const named = `state ${state} (${reading.classes || 'as rendered'})`
    for (const [name, part] of Object.entries(reading.parts)) {
      const twins = twin[state].parts[name]!
      expect(part, `${name} of the item with the open div, ${named}`).not.toBeNull()
      expect(part!.direct, `${name} is a child of the item (of the footer, for a list), ${named}`).toBe(true)
      expect(part!.style, `${name} is styled as the twin's, ${named}`).toEqual(twins.style)
      expect(part!.children, `the children of ${name} show as the twin's, ${named}`).toEqual(twins.children)
      expect([part!.height, part!.fromBottom], `${name} is as high and as far from the item's bottom edge as the twin's, ${named}`).toEqual([twins.height, twins.fromBottom])
      // the summaries are placed against the item's own box, which both items share; the footer's
      // lists are lines of text, as wide as their tags
      if (name.endsWith('Summary') || name == 'footer') expect([part!.left, part!.width], `${name} stands where the twin's does, ${named}`).toEqual([twins.left, twins.width])
    }
    // as tall as its text needs: under the end of the text there is what the twin has there (the
    // item's padding as rendered, the shown footer otherwise) and no line more
    expect(reading.below, `nothing more under the text than under the twin's, ${named}`).toBe(twin[state].below)
    // and the text keeps the macro's columns
    expect(reading.columnWidth, `the macro's div lays out columns, ${named}`).toBe('300px')
    const columns = reading.columns.filter((left, index, lefts) => !index || left - lefts[index - 1] > 200)
    expect(columns.length, `the text stands in several columns (line lefts ${reading.columns}), ${named}`).toBeGreaterThanOrEqual(2)
  }
})

// THE TABLE. Each entry is the text of an item with one dependency (`$` stands for its label and
// the hidden tag), read after a render:
//   tree       the item's own content as the app shows it: every child of the item but the cache
//              key's comment, the menu placeholder and the generated nodes (text by its first
//              characters, a tag's mark without its text); `updated` where an update of the shown
//              item builds another tree than the new item's markup did (the two documents of the
//              oracle: a `noscript`);
//   generated  the nodes that afterUpdate inserted, by class: they are the item's LAST children, as
//              many as the footer's fragment holds (the cache gives the fragment), so they are told
//              from the item's own nodes by their place, never by their class;
//   footerless the footer's line became a code block's text: no list, the summary alone;
//   own        a node of the item's own markup, by its id or a selector, and where it must stand
//              (its ancestors up to the item); it must be shown;
//   count      how many nodes of a selector the item holds;
//   value      what the item's textarea holds;
//   code       what the item's code block shows, in part;
//   same       the PARSER's part alone: both inputs of the oracle above are rebuilt from the two
//              fragments of the item's cache entry, AFTER toHTML has cut them, so `same` says that
//              parsing the body without the footer behind it builds the body's tree as the one
//              string did; it cannot say that toHTML cut at the right place or kept every byte of
//              the item's markup (`own`, `count`, `value` and `code` are for that). true unless
//              said, with the reason;
//   was        what the item did until 2026-11-18, where its footer was not right (by running this
//              content on the app of that day):
//                inside:    the footer and the summaries were children of .content or of the open element;
//                reopened:  they were the item's children, but the parser opened the unclosed formatting
//                           element again inside the footer and around the summary, so their rules missed;
//                swallowed: the open element took the footer as its own text or fragment: none on the page;
//                split:     the wrapper took the item's own div for the start of the generated footer.
// For every entry with a footer it is the item's own: asserted as the generated nodes' names, the
// footer hidden by its own rule and the summary placed by its own, the list a child of the footer,
// and the list's opening tag without the mark it travelled with (`_footer`), which no text shows.
type Shape = {
  text: string
  tree: string
  updated?: string
  generated?: string
  footerless?: true
  own?: { id?: string; selector?: string; path: string }
  count?: [string, number]
  value?: string
  code?: string
  same?: false
  was?: 'inside' | 'reopened' | 'swallowed' | 'split'
}
const SHAPES: Record<string, Shape> = {
  // an element left open: the footer was inside it
  'an open div before the label (the macro, typed)': { text: `${COLUMNS} $\ntext`, was: 'inside', tree: 'div.content(div(p(mark.label.unique mark.hidden br "text")))' },
  'two open divs': { text: '$\n<div><div>text', was: 'inside', tree: 'div.content(p(mark.label.unique mark.hidden) div(div("text")))' },
  'an open table cell': { text: '$\n<table><tr><td>cell', was: 'inside', tree: 'div.content(p(mark.label.unique mark.hidden) table(tbody(tr(td("cell")))))' },
  'an open table row': { text: '$\n<table><tr>', was: 'inside', tree: 'div.content(p(mark.label.unique mark.hidden) table(tbody(tr)))' },
  'an open select': { text: '$\n<select><option>a', was: 'inside', tree: 'div.content(p(mark.label.unique mark.hidden br select(option("a" p))))' },
  'a table that holds an open span outside its cells': { text: '$\n<table><span>loose', was: 'inside', tree: 'div.content(p(mark.label.unique mark.hidden) span("loose") table)' },
  // an unclosed formatting element: the parser no longer opens it again beside the footer, where the
  // one string left an empty copy of it (the one difference of the body's tree, hence `same: false`)
  'an unclosed <b> in a paragraph': { text: '$\nsome <b>bold text', was: 'reopened', same: false, tree: 'div.content(p(mark.label.unique mark.hidden br "some" b("bold text")))' },
  'an unclosed <font> in a paragraph of html': { text: '$\n<p><font color="red">x</p><p>y</p>', was: 'reopened', same: false, tree: 'div.content(p(mark.label.unique mark.hidden) p(font("x")) p(font("y")))' },
  'an unclosed <a> in a paragraph': { text: '$\nsee <a name="there">the anchor', was: 'reopened', same: false, tree: 'div.content(p(mark.label.unique mark.hidden br "see" a("the anchor")))' },
  'an unclosed <b> in an open blockquote': { text: '$\n<blockquote><b>quoted', was: 'reopened', same: false, tree: 'div.content(p(mark.label.unique mark.hidden) blockquote(b("quoted")))' },
  // nothing left open that one `</div>` did not close: right before, and the same now
  'balanced markdown': { text: '$\ntext with **bold** and `code`\n- one\n- two', tree: 'div.content(p(mark.label.unique mark.hidden br "text with" strong("bold") "and" code("code")) ul(li(span.list-item("one")) li(span.list-item("two"))))' },
  'balanced html with a comment and a table': { text: '$\n<!-- a comment -->\n<table><tr><td>cell</td></tr></table>', tree: 'div.content(p(mark.label.unique mark.hidden) table(tbody(tr(td("cell")))))' },
  'an open <p>': { text: '$\n<p>text', tree: 'div.content(p(mark.label.unique mark.hidden) p("text"))' },
  'an open <span> in a paragraph of html': { text: '$\n<p><span>text</p>', tree: 'div.content(p(mark.label.unique mark.hidden) p(span("text")))' },
  'open list items': { text: '$\n<ul><li>one<li>two', tree: 'div.content(p(mark.label.unique mark.hidden) ul(li(span.list-item("one")) li(span.list-item("two"))))' },
  'an open <details>': { text: '$\n<details><summary>s</summary>body', tree: 'div.content(p(mark.label.unique mark.hidden) details(summary("s") "body"))' },
  'an open <svg>': { text: '$\n<svg><g><circle r="1"></circle>', tree: 'div.content(p(mark.label.unique mark.hidden br svg(g(circle))))' },
  'a stray </div>': { text: '$\n<p>text</p></div><p>more</p>', tree: 'div.content(p(mark.label.unique mark.hidden) p("text")) p("more")' },
  'a stray </div>, then an open div': { text: '$\n<p>text</p></div><div>more', tree: 'div.content(p(mark.label.unique mark.hidden) p("text")) div("more")' },
  // an element that takes what follows as its own text or fragment: it took the footer with it, and
  // now holds what the author wrote and nothing else (the textarea held the footer's markup as text,
  // hence `same: false`; the template held it as nodes, which the oracle takes out of its fragment)
  'an open <textarea>': { text: '$\n<textarea>typed', was: 'swallowed', same: false, value: 'typed', tree: 'div.content(p(mark.label.unique mark.hidden) textarea("typed"))' },
  'an open <template>': { text: '$\n<template><div>t', was: 'swallowed', tree: 'div.content(p(mark.label.unique mark.hidden br template(div("t" p))))' },
  // THE BOUNDARY IS THE GENERATOR'S: an item's own div with the footer's class is the item's (the
  // wrapper split the text at the first such div: the group lost its children, and with the
  // boundary moved to the end of the content they would be the item's children, hidden by the
  // footer's rule), and so is a copy of the mark that the generated footer's opening tag carries
  'its own div with the footer\'s class, in a group': {
    text: '$\n```_html\n<div class="group"><div class="deps-and-dependents"><span id="zz_own">my own visible text</span></div><p>tail</p></div>\n```',
    was: 'split',
    own: { id: 'zz_own', path: 'div.deps-and-dependents < div.group < div.content' },
    tree: 'div.content(p(mark.label.unique mark.hidden) div.group(div.deps-and-dependents(span("my own visib")) p("tail")))',
  },
  'its own div with the mark of a generated footer': {
    text: '$\n<div class="deps-and-dependents" _footer="0"><span id="zz_marked">mine, marked as a generated one</span></div>\n\ntext after it',
    own: { id: 'zz_marked', path: 'div.deps-and-dependents < div.content' },
    tree: 'div.content(p(mark.label.unique mark.hidden) div.deps-and-dependents(span("mine, marked")) p(br) p("text after i"))',
  },
  // a block that the text leaves open takes the footer's line as its own text (the summaries are still
  // generated): a code block shows it as code, as it always did, without the mark; an `_html` block
  // is unwrapped into markup, where the footer is found by its mark and is the item's own
  'an unclosed code block at the end': { text: '$\ntext\n```\nconst answer = 42', generated: 'deps-summary', footerless: true, code: '<div class="deps-and-dependents"><span class="deps">', tree: 'div.content(p(mark.label.unique mark.hidden br "text") pre(code("const answer")))' },
  'an unclosed _html block at the end': { text: '$\ntext\n```_html\n<div class="box">boxed', was: 'inside', tree: 'div.content(p(mark.label.unique mark.hidden br "text") div.box("boxed"))' },
  // WHERE THE FOOTER'S LINE WENT IS MARKED'S TO SAY (2026-11-19). a line of three backticks is no
  // fence inside a `<pre>`, a textarea or an indented block, and the footer after it is markup:
  'a closed <pre> that holds a line of three backticks': { text: '$\n\n<pre>\n```\n</pre>', tree: 'div.content(p(mark.label.unique mark.hidden br br) pre("```"))' },
  'an indented code sample whose first line holds three backticks': { text: '$\ntext\n\n    ```js\n    const answer = 42\n\nmore text', tree: 'div.content(p(mark.label.unique mark.hidden br "text" br br) pre(code("```js\\nconst ")) p("more text"))' },
  'an open <textarea> that holds a line of three backticks': { text: '$\n<textarea>typed\n```\nmore', was: 'swallowed', same: false, value: 'typed\n```\nmore', tree: 'div.content(p(mark.label.unique mark.hidden) textarea("typed\\n```\\nmo"))' },
  // ... and a fence of tildes is one: the line is its code, shown as it always was
  'an unclosed fence of tildes at the end': { text: '$\ntext\n~~~text\nsome code', generated: 'deps-summary', footerless: true, code: '<div class="deps-and-dependents"><span class="deps">', tree: 'div.content(p(mark.label.unique mark.hidden br "text") pre(code.text("some code\\n<d")))' },
  // ... and behind a backslash the line is plain text (the text's last line ends in two: the first
  // escapes, the second continues the line): it reads as it always did, and its tags are live
  'a last line that ends in two backslashes': { text: '$\ntext \\\\', generated: 'deps-summary', footerless: true, tree: 'div.content(p(mark.label.unique mark.hidden br "text <div cl" span.deps(span.deps-title("1 dependenci") span(mark)))) p' },
  // THE GENERATED OPENING TAG IS THE LAST OF ITS KIND, whatever the item's text puts together: a line
  // continuation makes the marked tag out of two lines here, in the item's own group. it stays the
  // item's, with the attribute its author gave it; and where the footer's own line is a code block's
  // text there is no footer to cut off, and the author's div is not taken for one
  'its own div of the footer\'s class and mark, put together by a line continuation': {
    text: '$\n```_html\n<div class="group"><div class="deps-and-dependents" _foot\\\ner="0"><span id="zz_joined">mine</span></div><p>tail</p></div>\n```',
    own: { id: 'zz_joined', path: 'div.deps-and-dependents < div.group < div.content' },
    tree: 'div.content(p(mark.label.unique mark.hidden) div.group(div.deps-and-dependents(span("mine")) p("tail")))',
  },
  'the same div, before a code block that the text leaves open': {
    text: '$\n```_html\n<div class="group"><div class="deps-and-dependents" _foot\\\ner="0"><span id="zz_before">mine</span></div><p>tail</p></div>\n```\n```\nconst answer = 42',
    generated: 'deps-summary',
    footerless: true,
    own: { id: 'zz_before', path: 'div.deps-and-dependents < div.group < div.content' },
    code: '<div class="deps-and-dependents"><span class="deps">',
    tree: 'div.content(p(mark.label.unique mark.hidden) div.group(div.deps-and-dependents(span("mine")) p("tail")) pre(code("const answer")))',
  },
  // THE MARK IS THE APPENDED OPENING'S ALONE (the review of 2026-11-19). the item's own div spells
  // the marked tag and its line ends in two backslashes, which make text of the appended opening:
  // one paragraph then holds both spellings, the author's whole in an html token of its own and
  // the appended one split by the escape. by a mark that both carried, the author's div was cut
  // off as the footer (its text hidden, the mark shown in the paragraph's text). the appended
  // opening now carries a number that the text does not hold: the author's div is the item's own,
  // with its attribute, and the paragraph reads as it always did
  'its own div of the footer\'s class and mark, in a paragraph that ends in two backslashes': {
    text: '$\n\nText <div class="deps-and-dependents" _footer="0"><span id="zz_mine">mine</span></div> tail\\\\',
    generated: 'deps-summary',
    footerless: true,
    own: { id: 'zz_mine', path: 'div.deps-and-dependents < div.content' },
    count: ['.content > div.deps-and-dependents[_footer="0"]', 1],
    tree: 'div.content(p(mark.label.unique mark.hidden br br) p("Text") div.deps-and-dependents(span("mine")) "tail<div cla" span.deps(span.deps-title("1 dependenci") span(mark))) p',
  },
  // A TABLE'S CELLS ARE READ (the same review). a line continuation joins the footer's line onto
  // the table's last cell: the list is live markup there (the table extension renders a cell's
  // inline html), and is now the item's own; behind an escaping backslash it is the cell's text,
  // as it always was. the two endings together tell a walk that reads the cells' own tokens from
  // a rule for tables as such, which would be wrong for one of them
  'a table whose last cell ends in a backslash': { text: '$\n\nName | Path\n:--- | ---\nWindows | C:\\', was: 'inside', tree: 'div.content(p(mark.label.unique mark.hidden br br) table(thead(tr(th("Name") th("Path"))) tbody(tr(td("Windows") td("C:")))))' },
  'a table whose last cell ends in two backslashes': { text: '$\n\nName | Path\n:--- | ---\nWindows | C:\\\\', generated: 'deps-summary', footerless: true, tree: 'div.content(p(mark.label.unique mark.hidden br br) table(thead(tr(th("Name") th("Path"))) tbody(tr(td("Windows") td("C:<div class" span.deps(span.deps-title("1 dependenci") span(mark)))))))' },
  // what the review of the first fix found in it (2026-11-18), each right before that fix or since this one
  'a closed <noscript> that holds an end tag': { text: '$\n<noscript></div></noscript>', tree: 'div.content(p(mark.label.unique mark.hidden br noscript)) p', updated: 'div.content(p(mark.label.unique mark.hidden br noscript("</div>")))' },
  'a link around a form with an open table': {
    text: '$\n```_html\n<a href="#x"><form><table><span>fields\n```',
    was: 'inside',
    own: { selector: 'form', path: 'a < div.content' },
    count: ['a[href="#x"]', 1],
    tree: 'div.content(p(mark.label.unique mark.hidden) a(form(span("fields") table)))',
  },
  'a form whose controls are named as the properties a walk reads': { text: '$\n<form><input name="parentElement"><input name="localName"><div>open', was: 'inside', tree: 'div.content(p(mark.label.unique mark.hidden) form(input input div("open")))' },
  // the wrapper's own tail: hidden tags at the end are kept after the trimmed text, a `_log` block
  // at the end too (its summary is generated with the footer), trailing line breaks and whitespace go
  'hidden tags at the end': { text: '#zz_shape/TAIL\ntext\n#_zz_shape/dep', tree: 'div.content(p(mark.label.unique br "text") mark.hidden)' },
  'hidden tags at the end of an open div': { text: `${COLUMNS} #zz_shape/TAIL\ntext\n#_zz_shape/dep`, was: 'inside', tree: 'div.content(div(p(mark.label.unique br "text") mark.hidden))' },
  'a _log block at the end': { text: '$\ntext\n```_log\nINFO: a line\n```', generated: 'deps-and-dependents log-summary deps-summary', tree: 'div.content(p(mark.label.unique mark.hidden br "text") pre(code._log(span.console-info("INFO: a line"))))' },
  'a _log block at the end of an open div': { text: `${COLUMNS} $\ntext\n\`\`\`_log\nINFO: a line\n\`\`\``, was: 'inside', generated: 'deps-and-dependents log-summary deps-summary', tree: 'div.content(div(p(mark.label.unique mark.hidden br "text") pre(code._log(span.console-info("INFO: a line")))))' },
  'trailing line breaks and whitespace': { text: '$\ntext<br><br>\n\n   \n', tree: 'div.content(p(mark.label.unique mark.hidden br "text"))' },
  'trailing line breaks and whitespace in an open div': { text: `${COLUMNS} $\ntext<br><br>\n\n   \n`, was: 'inside', tree: 'div.content(div(p(mark.label.unique mark.hidden br "text")))' },
}

// what the app shows of an item, read where it stands (rendered first if it is not on the page).
// names and children by the native getters: a form answers `localName` or `childNodes` with a
// control of that name
type Shown = {
  key: boolean
  placeholder: boolean
  generated: string
  fragment: boolean
  hidden: string
  placed: string
  list: boolean
  mark: boolean
  listMarked: boolean
  tree: string
  same: ReturnType<Oracle>
  own: { display: string; path: string } | null
  count: number | null
  value: string | null
  code: string | null
}
const installReader = (page: Page) =>
  page.evaluate(() => {
    const get = <T,>(proto: object, name: string) => Object.getOwnPropertyDescriptor(proto, name)!.get as (this: unknown) => T
    const localName = get<string>(Element.prototype, 'localName')
    const childNodes = get<NodeList>(Node.prototype, 'childNodes')
    const parentElement = get<Element | null>(Node.prototype, 'parentElement')
    const className = (node: Node) => (node instanceof Element ? (node.getAttribute('class') ?? '') : '')
    ;(window as unknown as { __shown: (label: string, own?: string, count?: string) => Promise<Shown> }).__shown = async (label, own, count) => {
      const item = window._item(label)!
      const elem = item.elem ?? (await window._render_item(item))
      const itemdiv = elem.querySelector('.item') as HTMLElement
      // the two fragments of the markup shown: the cache holds them under the key that leads the body
      const key = itemdiv.firstChild as Comment
      const cache = (window as unknown as { _html_cache: Record<string, Map<string, { html: string; footer: string }>> })._html_cache[item.id]
      const entry = cache.get(key.data.trim().replace('html_cache_key=', ''))!
      const fragment = document.createElement('div')
      fragment.innerHTML = entry.footer
      const children = [...childNodes.call(itemdiv)]
      const generated = children.slice(children.length - fragment.childNodes.length)
      const names = (nodes: Node[]) => nodes.map(node => (node instanceof Element ? className(node) : node.nodeName)).join(' ')
      const tree = (node: Node): string => {
        if (node.nodeType == Node.TEXT_NODE) return node.textContent!.trim() ? JSON.stringify(node.textContent!.trim().slice(0, 12)) : ''
        if (!(node instanceof Element)) return ''
        const classes = className(node) ? '.' + className(node).trim().replace(/\s+/g, '.') : ''
        const inner = localName.call(node) == 'mark' ? '' : [...childNodes.call(node instanceof HTMLTemplateElement ? node.content : node)].map(tree).filter(Boolean).join(' ')
        return localName.call(node) + classes + (inner ? `(${inner})` : '')
      }
      const path = (element: Element) => {
        const steps: string[] = []
        for (let parent = parentElement.call(element); parent && parent != itemdiv; parent = parentElement.call(parent)) steps.push(localName.call(parent) + (className(parent) ? '.' + className(parent) : ''))
        return steps.join(' < ')
      }
      const footer = generated.find(node => className(node) == 'deps-and-dependents') as HTMLElement | undefined
      const summary = generated.find(node => className(node) == 'deps-summary') as HTMLElement | undefined
      const authored = own ? itemdiv.querySelector(own) : null
      return {
        key: key.nodeType == Node.COMMENT_NODE && key.data.includes('html_cache_key=') && entry.html.startsWith(`<!--${key.data}-->`),
        placeholder: itemdiv.firstElementChild!.id == 'menu-' + item.id && itemdiv.firstElementChild == key.nextSibling,
        // the generated nodes are the fragment's, one for one, at the item's end
        generated: names(generated.filter(node => node instanceof Element)),
        fragment: names([...fragment.childNodes]) == names(generated),
        hidden: footer ? getComputedStyle(footer).display : 'no footer',
        placed: summary ? getComputedStyle(summary).position : 'no summary',
        list: !!footer && footer.querySelector('.deps')?.parentElement == footer,
        mark: itemdiv.textContent!.includes('_footer'),
        listMarked: !!footer && footer.hasAttribute('_footer'),
        tree: children
          .filter(node => node != key && node != itemdiv.firstElementChild && !generated.includes(node))
          .map(tree)
          .filter(Boolean)
          .join(' '),
        same: (window as unknown as { __oracle: Oracle }).__oracle(entry.html.slice(entry.html.indexOf('-->') + 3), entry.footer),
        // shown: it has a box (an ancestor that is not displayed, as under the footer's rule, would leave it none)
        own: authored && { display: authored.getClientRects().length ? 'visible' : 'hidden', path: path(authored) },
        count: count ? itemdiv.querySelectorAll(count).length : null,
        value: itemdiv.querySelector('textarea')?.value ?? null,
        code: itemdiv.querySelector('pre code')?.textContent ?? null,
      }
    }
    // a forced render of an item where it stands: its div is in the page then, and the template
    // writes the new markup there; resolves once the markup under a new cache key is in and afterUpdate has run
    ;(window as unknown as { __again: (label: string) => Promise<void> }).__again = async label => {
      const item = window._item(label)!
      const itemdiv = item.elem!.querySelector('.item') as HTMLElement
      const key = (itemdiv.firstChild as Comment).data
      ;(item as unknown as { invalidate_elem_cache: (options: object) => void }).invalidate_elem_cache({ force_render: true, render_delay: 0 })
      for (let tries = 0; (itemdiv.firstChild as Comment).data == key; tries++) {
        if (tries > 400) throw new Error('no new markup for ' + label)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await new Promise(resolve => setTimeout(resolve))
    }
  })

test("contents of an item, each with its footer: the footer is the item's own, the item's own nodes stand where their author put them, and the body parses alone as it did with the footer behind it", async ({ page }) => {
  test.setTimeout(240_000)
  await loadAnonymous(page)
  await installOracle(page)
  await installReader(page)
  await page.evaluate(() => void window._create('#zz_shape/dep\nthe dependency of every shape'))
  for (const [index, [name, shape]] of Object.entries(SHAPES).entries()) {
    const label = `#zz_shape/s${index}`
    await page.evaluate(text => void window._create(text), shape.text.replace('$', `${label} #_zz_shape/dep`).replace('#zz_shape/TAIL', label))
    // as a new item's markup (written before its div is in the page), then as an update of the item shown
    for (const when of ['new', 'updated'] as const) {
      const shown = await page.evaluate(
        async ({ label, own, count, again }) => {
          const w = window as unknown as { __shown: (label: string, own?: string, count?: string) => Promise<Shown>; __again: (label: string) => Promise<void> }
          if (again) await w.__again(label)
          return w.__shown(label, own, count)
        },
        { label, own: shape.own && (shape.own.selector ?? '#' + shape.own.id), count: shape.count?.[0], again: when == 'updated' },
      )
      const named = `${name} (${when})`
      expect.soft([shown.key, shown.placeholder], `the cache key's comment leads the body and the placeholder follows it: ${named}`).toEqual([true, true])
      expect.soft([shown.generated, shown.fragment], `the generated nodes are the item's last children: ${named}`).toEqual([shape.generated ?? 'deps-and-dependents deps-summary', true])
      expect.soft([shown.hidden, shown.placed, shown.list], `the footer is hidden and the summary placed by their own rules, the list is the footer's child: ${named}`).toEqual(shape.footerless ? ['no footer', 'absolute', false] : ['none', 'absolute', true])
      expect.soft([shown.mark, shown.listMarked], `the mark of the generated footer's opening tag is in no text of the item, and not on the list: ${named}`).toEqual([false, false])
      expect.soft(shown.tree, `the content of: ${named}`).toBe((when == 'updated' && shape.updated) || shape.tree)
      expect.soft(shown.same.equal, `the body parses alone as it did with the footer behind it: ${named}\nbefore: ${shown.same.before}\nnow:    ${shown.same.now}`).toBe(shape.same ?? true)
      if (shape.own) expect.soft([shown.own?.display, shown.own?.path], `the item's own node ${shape.own.selector ?? '#' + shape.own.id} is shown, where the author put it: ${named}`).toEqual(['visible', shape.own.path])
      if (shape.count) expect.soft(shown.count, `the item holds ${shape.count[1]} of ${shape.count[0]}: ${named}`).toBe(shape.count[1])
      if (shape.value !== undefined) expect.soft(shown.value, `the textarea holds what the author typed: ${named}`).toBe(shape.value)
      if (shape.code !== undefined) expect.soft(shown.code, `the code block shows the footer's line as it always did: ${named}`).toContain(shape.code)
    }
  }
})

// THE PARSER, FOR THE TWO FRAGMENTS. What the design rests on, in one evaluation on a blank
// standards-mode page: the body written to a real div as the template writes it (`innerHTML`) and
// the footer inserted after it as afterUpdate does (`insertAdjacentHTML`). For every content the
// generated nodes are the div's last children and the footer's list is its own child; and the
// body's own tree is what the browser built for the one string (the oracle), except where that
// string had left a trace in the body, which is then stated. The contents are the ones a way of
// CLOSING the body went wrong on (the review of the first fix, 2026-11-18): end tags worked out for
// the body rearranged it, were worked out in a parser that reads `noscript` otherwise, or were
// found by a walk that a form's named controls can lead astray. No end tag is written now.
test('the parser closes a body at the end of its own input, and a footer inserted after it is its sibling', async ({ page }) => {
  await page.goto('/server_id') // the lane's origin
  await page.setContent('<!doctype html><html><head><title>blank</title></head><body></body></html>')
  await installOracle(page)
  const facts = await page.evaluate(() => {
    const OPENING = '<div class="content">'
    const GENERATED =
      '<div class="deps-and-dependents"><span class="deps"><span class="deps-title">1 dependencies</span> <span> <mark>#x</mark> </span></span> </div>\n' +
      '\n<div class="deps-summary"><span class="deps-triangle">▼</span><span class="deps-dot">⸱</span></div>'
    const model = (content: string) => {
      const item = document.createElement('div')
      document.body.append(item)
      item.innerHTML = '<!-- html_cache_key=k -->' + OPENING + content
      const body = item.childNodes.length
      item.insertAdjacentHTML('beforeend', GENERATED)
      const generated = [...item.childNodes].slice(body)
      const footer = generated[0] as HTMLElement
      return {
        item,
        // the footer's nodes, as written, are the div's last children, and the list is the footer's own child
        own: generated.map(node => (node instanceof Element ? node.className : node.nodeName)).join(' ') == 'deps-and-dependents #text deps-summary' && footer.firstElementChild?.className == 'deps',
        same: (window as unknown as { __oracle: Oracle }).__oracle(OPENING + content, GENERATED),
      }
    }
    const noscript = model('<noscript></div></noscript>')
    const link = model('<a href="#x"><form><table><span>fields')
    const named = model('<form><input name="parentElement"><input name="localName"><div>open')
    const marker = model('<div><!--mindpage-content-end--><textarea>hello')
    const template = model('<template><div>t')
    const columns = model('<div style="column-width:300px"><p>text')
    const bold = model('<p>some <b>bold text</p>')
    const stray = model('<p>text</p></div><p>more</p>')
    // what nothing written after the content could close: text elements, an unfinished tag, and a form
    // that lost its end tag inside a table after a stray end tag had closed the wrapper
    const style = model('<p>text</p><style>.x { color: red }')
    const plaintext = model('<p>text</p><plaintext>the rest')
    const unfinished = model('<p>text</p><span title="unfinished')
    const orphan = model('</div><form><table></form>')
    const form = named.item.querySelector('form')!
    // the other document an item's markup is parsed in (see the oracle): a div of a template's inert document
    const inert = document.createElement('template').content.ownerDocument.createElement('div')
    inert.innerHTML = OPENING + '<noscript></div></noscript>'
    return {
      mode: document.compatMode,
      own: [noscript, link, named, marker, template, columns, bold, stray, style, plaintext, unfinished, orphan].map(result => result.own),
      same: [noscript, link, named, columns, stray, orphan].map(result => result.same.equal),
      // a div of the page reads the end tag inside a noscript as its text
      noscript: [noscript.item.querySelector('noscript')!.textContent, noscript.item.querySelector('noscript')!.parentElement!.className],
      // and a div of the inert document reads it as markup: the end tag closes the wrapper
      inert: [inert.querySelector('noscript')!.textContent, inert.querySelector('.content > noscript') != null, inert.childNodes.length],
      // one link, around the form; the table moved its span before itself, inside the form
      link: [
        link.item.querySelectorAll('a').length,
        link.item.querySelector('form')!.parentElement!.localName,
        link.item.querySelector('span')!.parentElement!.localName,
        link.item.querySelector('span')!.nextElementSibling!.localName,
        link.item.querySelector('table')!.parentElement!.localName,
      ],
      // a form gives its named controls for the properties of their names: no walk up from it is safe
      named: [Object.prototype.toString.call(form.parentElement), typeof form.localName, form.parentNode == named.item.querySelector('.content')],
      // an open textarea holds what the author typed and nothing of the footer (the one string gave it the footer's markup as text)
      marker: [marker.item.querySelector('textarea')!.value, marker.same.equal, marker.same.before.includes('hello&lt;/div&gt;'), marker.item.querySelector('.content > div')!.firstChild!.nodeName],
      // an open template holds the author's fragment alone (the one string put the footer into it)
      template: [template.item.querySelector('template')!.content.childNodes.length, template.same.equal],
      // the one string left an empty copy of the unclosed element beside the footer
      bold: [bold.same.equal, bold.same.before.includes('<b></b>'), bold.same.now.includes('<b></b>'), bold.item.querySelectorAll('b').length],
    }
  })
  expect(facts.mode).toBe('CSS1Compat')
  expect(facts.own, "the generated nodes are the div's last children, for every content").toEqual(Array(12).fill(true))
  expect(facts.same, "the body's own tree is what the browser built before").toEqual(Array(6).fill(true))
  expect(facts.noscript).toEqual(['</div>', 'content'])
  expect(facts.inert).toEqual(['', true, 1])
  expect(facts.link).toEqual([1, 'a', 'form', 'table', 'form'])
  expect(facts.named).toEqual(['[object HTMLInputElement]', 'object', true])
  expect(facts.marker).toEqual(['hello', false, true, '#comment'])
  expect(facts.template).toEqual([1, true])
  expect(facts.bold).toEqual([false, true, false, 1])
})
