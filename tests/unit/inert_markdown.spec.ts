import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { decodeEntities, grammarRefs, highlightCode, inertChildTags, renderInertMarkdown } from '../../src/inert_markdown.js'
// parseTags (the app's own parser, which the tag links' rows are read back with) reads the lodash
// global `_` at call time
;(globalThis as any)._ = createRequire(import.meta.url)('lodash')
// @ts-expect-error util.js is plain js (the app's client lib) without a declaration file
import { parseTags } from '../../src/util.js'

// the inert Markdown policy for bridge replies (src/inert_markdown.ts): the vault renderer's
// policy ported for the dead frame. these rows check the produced html string with the REAL
// Marked dependency; the browser witness (tests/e2e/bridge.spec.ts) checks the dom the app
// builds from it. the string checks are on the html the browser parses: every text character
// outside [A-Za-z0-9 ] is a decimal reference, so no raw grammar character can exist in text.

const html = (body: string) => renderInertMarkdown(body)
const textOf = (h: string) => h.replace(/<[^>]*>/g, '') // the text pieces of the html string
// the text pieces without their references: what remains must be letters, digits, spaces,
// newlines, and the policy's own literal punctuation (the parentheses around a shown destination)
const bareText = (h: string) => textOf(h).replace(/&#\d+;/g, '')

test('the grammar carrier and the entity decoder', () => {
  expect(grammarRefs('a #tag <<m>> 1')).toBe('a &#35;tag &#60;&#60;m&#62;&#62; 1')
  expect(decodeEntities('A &amp; B &#35; &#x3C; &notit; &copycat ?x=1&amp=2')).toBe('A & B # < &notit; &copycat ?x=1&amp=2')
  expect(decodeEntities('&#0; &#1114112; &#xD800; &#1;')).toBe('� � � �') // outside the domain
})

test('the app layout: spacer lines, rules, quotes, list and table closing, controls replaced', () => {
  // the app's own line pass ahead of Marked (Item.svelte, the vault renderer's port; design
  // 9.6): an empty source line is the app's spacer (`&nbsp;<br>` at the end of the paragraph it
  // follows, its own paragraph after a block); a trailing or leading run is not rendered; a
  // newline inside a paragraph is a break; a blank line inside a code block is code; a rule
  // line is a rule even between prose lines (no setext heading); an empty quote line is the
  // app's non-breaking space; a list or a table is closed by the line after it; CRLF is LF and
  // the body's other control characters are the replacement character (the sentinels are the
  // pass's alone)
  const spacer = '<p>&#160;<br></p>\n'
  expect(html('one\n\ntwo')).toBe('<div class="inert-markdown"><p>one<br>&#160;<br></p>\n<p>two</p></div>')
  expect(html('one\n\n\ntwo')).toBe(`<div class="inert-markdown"><p>one<br>&#160;<br></p>\n${spacer}<p>two</p></div>`)
  expect(html('one\ntwo')).toBe('<div class="inert-markdown"><p>one<br>two</p></div>')
  expect(html('\n\nlead\n\n')).toBe('<div class="inert-markdown"><p>lead</p></div>')
  expect(html('# H\ntext')).toBe('<div class="inert-markdown"><h1>H</h1>\n<p>text</p></div>')
  expect(html('## h\n\n- a\n- b\n\n```\nx\n\ny\n```\n\nend')).toBe(
    `<div class="inert-markdown"><h2>h</h2>\n${spacer}<ul>\n<li><span class="list-item">a</span></li>\n<li><span class="list-item">b</span></li>\n</ul>\n${spacer}<pre><code>x&#10;&#10;y</code></pre>\n${spacer}<p>end</p></div>`
  )
  expect(html('a\n\n---\n\nb')).toBe(`<div class="inert-markdown"><p>a<br>&#160;<br></p>\n<hr>\n${spacer}<p>b</p></div>`)
  expect(html('before\n---\nafter')).toBe('<div class="inert-markdown"><p>before</p>\n<hr>\n<p>after</p></div>')
  expect(html('a\n=\nb')).toBe('<div class="inert-markdown"><p>a<br>&#61; &#160;<br>b</p></div>') // no setext heading
  expect(html('> a\n>\n> b')).toBe('<div class="inert-markdown"><blockquote>\n<p>a<br>&#160;<br>b</p>\n</blockquote></div>')
  expect(html('> > deep\n> up')).toBe('<div class="inert-markdown"><blockquote>\n<blockquote>\n<p>deep</p>\n</blockquote>\n<p>up</p>\n</blockquote></div>')
  expect(html('- a\n- b\nafter list')).toBe('<div class="inert-markdown"><ul>\n<li><span class="list-item">a</span></li>\n<li><span class="list-item">b</span></li>\n</ul>\n<p>after list</p></div>')
  expect(html('| h |\n|---|\n| c |\nafter table')).toContain('</table>\n<p>after table</p>')
  expect(html('xy' + String.fromCharCode(13) + '\nz')).toBe('<div class="inert-markdown"><p>xy<br>z</p></div>')
  expect(html('ctl' + String.fromCharCode(1) + 'x' + String.fromCharCode(2))).toBe('<div class="inert-markdown"><p>ctl&#65533;x&#65533;</p></div>')
  expect(html('```\n\n\ncode blank\n\n```\n\n')).toBe('<div class="inert-markdown"><pre><code>&#10;&#10;code blank&#10;</code></pre></div>')
})

test('lists carry the app\'s list-item wrapper and task rows are passive boxes with the app\'s classes', () => {
  // the app restores the text color on `span.list-item` (its `ul` and `ol` are bullet gray);
  // a task row is `li.checkbox` (`.checked` when ticked, dimmed by the app) with a `span.task`
  // box in place of a checkbox (no input, no handler); a list of task rows is `ul.checkbox`
  const nested = html('- a\n    - b\n        - c')
  expect(nested).toBe('<div class="inert-markdown"><ul>\n<li><span class="list-item">a<ul>\n<li><span class="list-item">b<ul>\n<li><span class="list-item">c</span></li>\n</ul>\n</span></li>\n</ul>\n</span></li>\n</ul></div>')
  expect(html('1. one\n2. two')).toBe('<div class="inert-markdown"><ol>\n<li><span class="list-item">one</span></li>\n<li><span class="list-item">two</span></li>\n</ol></div>')
  const tasks = html('- [ ] todo\n- [x] done\n')
  expect(tasks).toBe(
    '<div class="inert-markdown"><ul class="checkbox">\n<li class="checkbox"><span class="list-item"><span class="task"></span> todo</span></li>\n<li class="checkbox checked"><span class="list-item"><span class="task checked"></span> done</span></li>\n</ul></div>'
  )
  expect(tasks).not.toContain('<input')
  expect(html('- [ ] task\n- plain')).toContain('<ul>\n<li class="checkbox">') // a mixed list keeps its bullets
})

test('markdown structure renders with every text character referenced', () => {
  const out = html('## Heading\n\n- one\n- two\n\nSome *emphasis* and `code #x`.\n')
  expect(out.startsWith('<div class="inert-markdown">')).toBe(true)
  expect(out).toContain('<h2>Heading</h2>')
  expect(out).toContain('<li><span class="list-item">one</span></li>')
  expect(out).toContain('<em>emphasis</em>')
  expect(out).toContain('<code>code &#35;x</code>')
  // no raw grammar character in any text piece
  expect(bareText(out)).toMatch(/^[A-Za-z0-9 \n.]*$/)
})

test('app grammar, macros, tags, plain-dollar math, wiki and jinja are ordinary text', () => {
  const body = '<<window._pwned = 1>> #_autorun [[agents/worker]] {{ run.id }} $x$ @{eval}@ https://a.b/c'
  const out = html(body)
  expect(out).not.toContain('<mark')
  expect(out).not.toContain('<span class="math')
  // gfm autolinks the bare url into a link token, which the policy admits (an http destination)
  expect(out).toContain('<a href="https&#58;&#47;&#47;a&#46;b&#47;c" target="_blank" rel="noopener">https&#58;&#47;&#47;a&#46;b&#47;c</a>')
  expect(bareText(out)).toMatch(/^[A-Za-z0-9 \n]*$/)
  // and the browser decodes the references back to the literal spelling
  expect(textOf(out).replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))).toContain(body)
})

test("math: the app's code-span forms become its math spans, exactly the single-backtick span", () => {
  // the owner (2026-10-04): a reply's TeX renders as the owner's does. the app's forms alone
  // (Item.svelte's line pass): a single-backtick code span between dollar signs on one line, `$`…`$`
  // inline and `$$`…`$$` display, wrapped as the app's span.math / span.math-display over the
  // delimited TeX; what the TeX may do is decided where a frame's spans are typeset (the app's inert
  // MathJax document, src/inert_math.ts), not here; a plain `$x$` stays text as it is in the owner's text
  expect(html('a $`x^2`$ b')).toBe('<div class="inert-markdown"><p>a <span class="math">&#36;x&#94;2&#36;</span> b</p></div>')
  expect(html('$$`\\sum_i x_i`$$')).toBe(
    '<div class="inert-markdown"><p><span class="math-display">&#36;&#36;&#92;sum&#95;i x&#95;i&#36;&#36;</span></p></div>'
  )
  expect(html('$`\\href{javascript:x}{y}`$')).toBe(
    '<div class="inert-markdown"><p><span class="math">' + grammarRefs('$\\href{javascript:x}{y}$') + '</span></p></div>'
  )
  // the app's own alternation: an unbalanced form is a dollar sign of text and the inline form
  expect(html('$$`x`$')).toBe('<div class="inert-markdown"><p>&#36;<span class="math">&#36;x&#36;</span></p></div>')
  expect(html('$`x`$$')).toBe('<div class="inert-markdown"><p><span class="math">&#36;x&#36;</span>&#36;</p></div>')
  // EXACTLY the single-backtick span (review 0 B3): a backtick inside is no form (Marked's code spans
  // and the text between them render as before, a child tag there included), a longer run is Marked's
  // own code span; the bridge's reader (lib/mindpage_child_tags.py, the parity table) agrees
  expect(html('$`a` #/x `b`$')).toBe('<div class="inert-markdown"><p>&#36;<code>a</code> &#35;&#47;x <code>b</code>&#36;</p></div>')
  expect(html('$``a`$ #/x``$')).toBe('<div class="inert-markdown"><p>&#36;<code>a&#96;&#36; &#35;&#47;x</code>&#36;</p></div>')
  expect(inertChildTags('$`a` #/x `b`$')).toEqual(['#/x'])
  expect(inertChildTags('$``a`$ #/x``$')).toEqual([])
  expect(inertChildTags('$$`a` #/x `b`$$')).toEqual(['#/x'])
  expect(inertChildTags('$$``a`$$ #/x``$$')).toEqual([])
  // a child tag inside the TeX is TeX (the math token has no children), and the form is no boundary
  // for one after it, as a code span is none
  expect(inertChildTags('$`#/x`$ and #/a')).toEqual(['#/a'])
  expect(inertChildTags('$`x`$#/a')).toEqual([])
  // plain dollars and a form across lines are text; so is a form inside Marked's raw block (`<code>`)
  // or inside a raw-text element of this policy (`<textarea>`), as a child tag there is
  expect(html('$x$ costs $5 and $`a\nb`$')).not.toContain('<span class="math')
  expect(html('<code>$`x`$</code>')).not.toContain('<span class="math')
  expect(html('x <textarea>$`x`$</textarea>')).not.toContain('<span class="math') // inline: the demotion, not a protected block
})

test('raw html is visible text: comments in gray code typography, other html code-styled', () => {
  expect(html('<script>alert(1)</script>')).not.toContain('<script')
  expect(html('<script>alert(1)</script>')).toContain('<pre><code>&#60;script&#62;alert&#40;1&#41;&#60;&#47;script&#62;</code></pre>')
  const inline = html('text <!-- note --> more')
  expect(inline).toContain('<code class="inert-comment" style="background:none;padding:0;border-radius:0;color:#6a737d">&#60;&#33;&#45;&#45; note &#45;&#45;&#62;</code>')
  expect(html('<!-- block -->\n')).toContain('<pre class="inert-comment" style="white-space:pre-wrap;color:#6a737d"><code class="inert-comment">')
  expect(html('<img src=x onerror="pwn()">')).not.toContain('<img')
  expect(html('<img src=x onerror="pwn()">')).not.toContain('onerror=')
})

test('links: only http, https and mailto become anchors (noopener); images are placeholders', () => {
  expect(html('[x](https://a.b/)')).not.toContain('rel="opener"') // never an opener relationship
  expect(html('[ok](https://x.y/z?a=1&amp;b=2)')).toContain('<a href="https&#58;&#47;&#47;x&#46;y&#47;z&#63;a&#61;1&#38;b&#61;2" target="_blank" rel="noopener">ok</a>')
  expect(html('[mail](mailto:a@b.c)')).toContain('<a href="mailto&#58;a&#64;b&#46;c" target="_blank" rel="noopener">mail</a>')
  const js = html('[click](javascript:window._pwned=4)')
  expect(js).not.toContain('<a ')
  expect(js).toContain('click (javascript&#58;window&#46;&#95;pwned&#61;4)') // the destination shown after the text
  expect(html('[rel](#tag)')).not.toContain('<a ')
  const img = html('![alt](https://x.y/i.png)')
  expect(img).not.toContain('<img')
  expect(img).toContain('<span class="template_placeholder" title="image placeholder (not loaded, not a link)">https&#58;')
})

test('wiki links: the app-built anchor under the setting, text without it or for a refused target', () => {
  // the one exception of the policy (design wiki_links 2.7): the extension reads the setting from
  // window at parse time; the anchor is built from the tokenized target under the carrier
  const g = globalThis as any
  g.window = { _wiki_links: { url: 'x://h/f', root: '/r' } }
  try {
    const out = html('see [[docs/x|the guide]] and [[../x]] and `[[code]]`')
    expect(out).toContain('<a href="x&#58;&#47;&#47;h&#47;f&#63;path&#61;docs&#37;2Fx&#38;root&#61;&#37;2Fr" title="docs&#47;x" data-wiki-link>the guide</a>')
    expect(out).toContain('and &#91;&#91;&#46;&#46;&#47;x&#93;&#93; and <code>&#91;&#91;code&#93;&#93;</code>') // refused: text; code: code
    expect(out).not.toMatch(/target=|rel=|\son\w+=/)
    // a `#diff` reference under this setting (the query form, which carries no view): the same
    // app-built anchor as a plain file link; a refused target stays text with the fragment, and
    // a model's own `vscode:` destination is no anchor, as before
    const source = 'see [[worktrees/t#diff|the proposal]] and [[worktrees/t/AGENTS#diff]] and [[../x#diff]] and [d](vscode://h/f?path=x&view=diff)'
    const plain = html(source)
    expect(plain).toContain(
      '<a href="x&#58;&#47;&#47;h&#47;f&#63;path&#61;worktrees&#37;2Ft&#38;root&#61;&#37;2Fr" title="worktrees&#47;t" data-wiki-link>the proposal</a>'
    )
    expect(plain).toContain('and &#91;&#91;&#46;&#46;&#47;x&#35;diff&#93;&#93; and')
    expect(plain.match(/<a /g)).toHaveLength(2)
    // under a url with the placeholder: the diff view, packed with the path and the root into
    // the one text that stands in the placeholder's place, and named in the tooltip
    g.window = { _wiki_links: { url: 'x://h/link/{link}', root: '/r' } }
    const refs = (link: object) => Buffer.from(JSON.stringify(link)).toString('base64url').replace(/-/g, '&#45;').replace(/_/g, '&#95;')
    const diff = html(source)
    expect(diff).toContain(
      `<a href="x&#58;&#47;&#47;h&#47;link&#47;${refs({ v: 1, path: 'worktrees/t', root: '/r', view: 'diff' })}" title="diff of worktrees&#47;t" data-wiki-link>the proposal</a>`
    )
    expect(diff).toContain(
      `<a href="x&#58;&#47;&#47;h&#47;link&#47;${refs({ v: 1, path: 'worktrees/t/AGENTS', root: '/r', view: 'diff' })}" title="diff of worktrees&#47;t&#47;AGENTS" data-wiki-link>worktrees&#47;t&#47;AGENTS&#35;diff</a>`
    )
    expect(diff).toContain('and &#91;&#91;&#46;&#46;&#47;x&#35;diff&#93;&#93; and')
    expect(diff.match(/<a /g)).toHaveLength(2)
    expect(diff).not.toMatch(/target=|rel=|\son\w+=/)
  } finally {
    delete g.window
  }
  expect(html('see [[docs/x]]')).toContain('see &#91;&#91;docs&#47;x&#93;&#93;') // unconfigured: text
})

test('fenced code: plain without a highlighter, filtered spans with one', () => {
  expect(html('```\n#!x <<m>>\n```\n')).toContain('<pre><code>&#35;&#33;x &#60;&#60;m&#62;&#62;</code></pre>')
  const fake = {
    highlight: () => ({ value: '<span class="hljs-comment">// c &lt;x&gt;</span> <b>bold</b> rest' }),
    getLanguage: () => true,
  }
  expect(highlightCode('ignored', 'js', fake)).toBe(
    '<span class="inert-comment" style="color:#6a737d">&#47;&#47; c &#60;x&#62;</span> bold rest'
  )
  expect(highlightCode('x', 'js', null)).toBeNull()
  expect(highlightCode('x', 'js', { highlight: () => { throw new Error('boom') } })).toBeNull()
})

test('child tags: the relative shorthands a reply may use as tags, recognized and rendered by one Marked', () => {
  // vault design mind_chat_children 2.2: `#/<segment>` at a boundary of its inline run, ending
  // where the app's tag ends, renders as the app's mark (title and data attributes in the label's
  // case, no inline handler, `renderTag`'s display), or as a DANGLING mark showing the token as
  // written when no item carries the tag (the item's computed missing state; the owner, 2026-10-03);
  // everything else stays text, and `inertChildTags` names exactly the tokens the marks render
  const ctx = { id: 'i1', label: '#chat', labelText: '#Chat', danglingTags: new Set(['#chat/gone']) }
  const render = (body: string, c = ctx) => renderInertMarkdown(body, c)
  const marks = (h: string) => [...h.matchAll(/<mark([^>]*)>([^<]*)<\/mark>/g)].map(m => m[1] + '|' + m[2])
  const reltags = (h: string) => [...h.matchAll(/data-reltag="([^"]*)"/g)].map(m => m[1].replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).toLowerCase())
  const agree = (body: string) => expect(reltags(render(body)), body).toEqual(inertChildTags(body))
  // the mark: the absolute tag in the label's case, the relative token, the display without `#/`;
  // a tag no item carries: the dangling class and the token as written
  expect(marks(render('see #/alpha and #/gone'))).toEqual([
    ' title="&#35;Chat&#47;alpha" data-tag="&#35;Chat&#47;alpha" data-reltag="&#35;&#47;alpha"|alpha',
    ' class="dangling" title="&#35;Chat&#47;gone" data-tag="&#35;Chat&#47;gone" data-reltag="&#35;&#47;gone"|&#35;&#47;gone',
  ])
  expect(inertChildTags('see #/alpha and #/gone')).toEqual(['#/alpha', '#/gone'])
  // legal names of the app's grammar: unicode, markdown punctuation, a literal backslash; case kept
  // in the mark and lowered in the extraction
  for (const name of ['θ_1', 'a*b*c', 'foo\\x41', 'Alpha', '9x', 'snake_case-ok'])
    expect(reltags(render(`#/${name} end`)), name).toEqual([`#/${name}`.toLowerCase()])
  expect(render('#/Alpha')).toContain('title="&#35;Chat&#47;Alpha"')
  expect(render('#/a*b*c')).not.toContain('<em>') // one tag, not emphasis
  // boundaries: a longer tag is never a prefix match; four slashes and other tags stay text
  for (const body of ['#/a/b', '#/ab/c', '#////x', '#//a/b', '#x', '#_x', 'x#/x', 'a#/x b', 'x#//x'])
    expect(render(body), body).not.toContain('<mark')
  // the sibling and parent's-sibling forms (the owner's ask, 2026-10-02) resolve as the index
  // resolves the item's own relative tags (resolveRelativeTag, shared): a root's `#//x` is the
  // root-level `#x`, its `#///y` nothing (text, while the token is claimed: the index drops the
  // unresolved tag the same way); under a nested label both resolve, the display drops the slashes
  expect(marks(render('#//x and #///y'))).toEqual([' title="&#35;x" data-tag="&#35;x" data-reltag="&#35;&#47;&#47;x"|x'])
  expect(render('#///y')).toBe('<div class="inert-markdown"><p>&#35;&#47;&#47;&#47;y</p></div>')
  expect(inertChildTags('#///y')).toEqual(['#///y'])
  const nested = { ...ctx, label: '#chat/4/0', labelText: '#Chat/4/0' }
  expect(marks(render('#//x #///y #/z', nested))).toEqual([
    ' title="&#35;Chat&#47;4&#47;x" data-tag="&#35;Chat&#47;4&#47;x" data-reltag="&#35;&#47;&#47;x"|x',
    ' title="&#35;Chat&#47;y" data-tag="&#35;Chat&#47;y" data-reltag="&#35;&#47;&#47;&#47;y"|y',
    ' title="&#35;Chat&#47;4&#47;0&#47;z" data-tag="&#35;Chat&#47;4&#47;0&#47;z" data-reltag="&#35;&#47;z"|z',
  ])
  expect(inertChildTags('#//x #///y #/z #////w')).toEqual(['#//x', '#///y', '#/z'])
  expect(reltags(render('#//x #///y #/z', nested))).toEqual(inertChildTags('#//x #///y #/z'))
  // a form resolving to a HIDDEN tag is text (review 15 B1: a root's `#//_autodep` or a two-level
  // label's `#///_autodep` would be the control tag itself; the index refuses it the same way),
  // while a nested underscore name stays an ordinary child tag; the tokens are claimed either way
  expect(render('#//_autodep')).not.toContain('<mark')
  expect(render('#///_autodep', { ...ctx, label: '#chat/4', labelText: '#Chat/4' })).not.toContain('<mark')
  expect(marks(render('#/_detail'))).toEqual([' title="&#35;Chat&#47;&#95;detail" data-tag="&#35;Chat&#47;&#95;detail" data-reltag="&#35;&#47;&#95;detail"|&#95;detail'])
  expect(inertChildTags('#//_autodep #///_autodep')).toEqual(['#//_autodep', '#///_autodep'])
  for (const body of ['#/x', '(#/x)', 'see #/x.', 'a\n#/x', '**#/x**', '> #/x', '>#/x', '- #/x', '| #/x |\n|---|']) agree(body), expect(reltags(render(body)), body).toEqual(['#/x'])
  // the deliberate rule: a nested inline run starts its own boundary
  expect(reltags(render('**#/x**'))).toEqual(['#/x'])
  // entities, escapes and protected positions are text
  for (const body of ['&#35;/x', '\\#/x', '`#/x`', '```\n#/x\n```', '~~~\n#/x\n~~~', '    #/x', '<b>#/x</b>', '[t](#/x)', '![i](#/x)'])
    expect(render(body), body).not.toContain('<mark'), agree(body)
  // inline raw html is text too (review 2 R1: the extension yields inside Marked's raw block and
  // inside the raw-text elements the token walk tracks in document order, so a nested run of
  // emphasis or a link label inside one is text as well: reviews 3-4 R1), and an image's label is not
  // rendered, so it carries no tag (R2); a link's label is rendered and does
  for (const body of [
    'example <script> #/x </script>',
    'a <style> #/x </style> b',
    '<pre> #/x </pre>',
    'a <style> **#/x** </style>',
    'a <textarea> **#/x** </textarea>',
    'a <title> [#/x](https://e.org) </title>',
    'a <xmp> *#/x* </xmp>',
    '<pre> *#/x* </pre>',
    '![#/hidden](https://e.org/i.png)',
    '![**#/hidden**](https://e.org/i.png)',
  ])
    expect(render(body), body).not.toContain('<mark'), expect(inertChildTags(body), body).toEqual([])
  // the suppression ends with the element, also when its close sits inside a nested run
  // (an element opened at a line start is one of Marked's html BLOCKS to the end of its closing
  // line, `#/y` on that line included: text, as the app shows it); an element that opens and
  // closes through BLOCK tokens (`<title>` or `<xmp>` alone on a line: review 4 R1) suppresses
  // the paragraphs between them and nothing after; an image's label is discarded by the renderer,
  // so a tag it opens there holds nothing open
  for (const body of [
    'a <style> #/x </style> #/y',
    'a <style> **x </style>** #/y',
    '<textarea>#/x</textarea>\n\n#/y',
    '<title>\n\n#/x\n\n</title>\n\n#/y',
    '<xmp>\n\n**#/x**\n\n</xmp>\n\n#/y',
    '![<style>](https://e.org/i.png) then #/y',
    // tag by tag (review 5 R1): an end tag spelled inside a quoted attribute closes nothing, a
    // raw-element opener inside a comment or an attribute opens nothing
    'a <style data-example="</style>"> #/x </style> #/y',
    'a <textarea title=\'</textarea>\'> **#/x** </textarea> #/y',
    'a <!-- <style> --> #/y',
    'a <span data-example="<style>"> #/y </span>',
  ])
    agree(body), expect(inertChildTags(body), body).toEqual(['#/y'])
  expect(inertChildTags('<style> #/x </style> #/y')).toEqual([])
  expect(inertChildTags('[#/x](https://e.org)')).toEqual(['#/x'])
  // a mark inside a link's label is a permitted shape (the frame's click listener cancels the anchor)
  expect(render('[see #/x](https://e.org)')).toMatch(/<a href="https&#58;&#47;&#47;e&#46;org" target="_blank" rel="noopener">see <mark /)
  agree('[see #/x](https://e.org)')
  // the `start` hook names the next candidate wherever it is (a bounded cut split emails and urls
  // before Marked saw them: review 7); a tag far down a body and the links around it stay whole
  expect(inertChildTags('word '.repeat(2000) + '#/far end')).toEqual(['#/far'])
  expect(renderInertMarkdown('x'.repeat(253) + ' name@example.org')).toContain('href="mailto&#58;name&#64;example&#46;org"') // no context: the plain renderer
  expect(renderInertMarkdown('x'.repeat(253) + ' https://example.org/path')).toContain('href="https&#58;&#47;&#47;example&#46;org&#47;path"')
  // no label, no context: text; the context is not retained across renders
  expect(render('#/x', { ...ctx, label: '', labelText: '' })).toBe('<div class="inert-markdown"><p>&#35;&#47;x</p></div>')
  expect(renderInertMarkdown('#/x')).toBe('<div class="inert-markdown"><p>&#35;&#47;x</p></div>')
  expect(render('#/gone', { ...ctx, danglingTags: new Set() })).not.toMatch(/missing|dangling/)
  expect(render('#/gone')).toContain('class="dangling"')
  expect(renderInertMarkdown('#/gone')).not.toContain('<mark')
  // the extraction walks every structure
  expect(inertChildTags('- #/a\n- b #/b\n\n> #/c\n\n| h |\n|---|\n| #/d |\n\n[#/e](https://e.org) `#/no`')).toEqual(['#/a', '#/b', '#/c', '#/d', '#/e'])
})

// TAG LINKS (the owner, 2026-11-20): a tag written in an inert section is a quiet link that searches
// for it, by the app's own rule of what a tag is; it tags nothing. each link of a rendered body as
// [the tag it searches for, the text it shows], its title and its data attribute being the same tag
const decoded = (h: string) => h.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(+d))
const tagLinks = (h: string) =>
  [...h.matchAll(/<code class="tag-link" title="([^"]*)" data-tag-link="\1">([^<]*)<\/code>/g)].map(m => [decoded(m[1]), decoded(m[2])])
const link = (tag: string, shown = tag) => `<code class="tag-link" title="${grammarRefs(tag)}" data-tag-link="${grammarRefs(tag)}">${grammarRefs(shown)}</code>`
const wrapped = (inner: string) => `<div class="inert-markdown"><p>${inner}</p></div>`

test("tag links: a bare tag is a link where the app's own parser takes it as a tag in the text Marked left as text", () => {
  // a bare tag: the item's inline code by its element, the tag as its tooltip and its data, the text as written
  expect(html('see #todo/Alpha here')).toBe(wrapped('see ' + link('#todo/Alpha') + ' here'))
  // the start condition of parseTags: the start, whitespace (a line start included) or an opening parenthesis
  expect(tagLinks(html('#start of the text, after a #space, in (#paren) and\n#line start')).map(l => l[0])).toEqual(['#start', '#space', '#paren', '#line'])
  // THE APP'S RULE, ONCE: for each of these texts the links are exactly the tags parseTags reads in it,
  // in order. its start condition and its characters (a digit or a colour code is a tag to the app; a
  // second `#` ends one), and what it EXCLUDES: code blocks, a code span, math, an html tag or comment,
  // a script's content, a macro, an eval macro, a line indented by four spaces
  for (const body of [
    '#a at the start, a #b/c after a space, (#d) in parentheses, #e.',
    'x#no a/#no "#no" [#no] #yes',
    'line one\n#two starts a line\n\ta tab, then #three',
    "#1 and #fff are tags by the app's rule; a#b is not, and of #x#y the first alone",
    '\\#no &#35;no https://example.org/page#no #yes',
    '- #a item\n- [ ] #b task\n\n> #c quote\n\n# #d heading\n\n| #e | f |\n|---|---|\n| g | #h |',
    '```\n#no\n```\n\n#yes',
    '    #no\n\n#yes',
    'code `not #no` and ``#no too`` then #yes',
    'math $`#no`$ then #yes',
    'html <b title="#no"> #no</b> and <!-- #no --> then #yes',
    'a <script> #no </script> and a <style> #no </style> then #yes',
    '<<macro #no>> and @{ #no }@ then #yes',
    'a line\n     #no on a line indented by five spaces\n   #yes on one indented by three',
    // ... ALL THE WAY DOWN: an emphasis inside a macro, inside an eval macro or on an indented line holds
    // no tag either, nor does one that a macro begins or ends in; the tag after each is a tag
    'Try << **#topic** >> then #yes',
    '@{ **see #topic** }@ then #yes',
    'a line\n     four spaces and more: *see #topic* and **#topic**\nthen #yes',
    '**a << #no** b >> then #yes',
  ])
    expect(tagLinks(html(body)).map(l => l[0]), body).toEqual(parseTags(body).raw)
  // the same for a CODE SPAN that such an exclusion encloses (the app's parser reads no code span as a tag,
  // so these are spelled out): no link, where the span after the exclusion is one. an exclusion that lies
  // inside an emphasis is found there as anywhere; and where the app pairs backticks its own way (a span
  // of two backticks that holds one), Marked's span is the code span
  for (const body of ['<<m `#no` *see `#no`*>> then `#yes`', '@{ `#no` }@ then `#yes`', 'a line\n     four spaces: `#no`\nthen `#yes`', '**a <<m #no>> then `#yes`**', '``a`b`` and `#yes`'])
    expect(tagLinks(html(body)).map(l => l[0]), body).toEqual(['#yes'])
  // WHERE MARKED DECIDES, not the app's expression: a link's destination and an image stay as they are
  // (parseTags takes `(#x)` there), an html block stays html, a tag that Marked split stays text (one tag
  // to the app; emphasis, or an escape, to Marked), and a run that Marked lexes by itself starts its own
  // text (the inside of an emphasis: the child tags' rule, above; no tag to the app, which reads the `*`
  // before it). the label of a link that is followed holds no tag link: the next row
  for (const body of ['[t](#no)', '![#no](https://e.org/i.png)', '<div>\n#no\n</div>', '#a*b*c', '#a\\@b']) expect(html(body), body).not.toContain('tag-link')
  expect(tagLinks(html('**#bold** *see #em* [#label](https://e.org)')).map(l => l[0])).toEqual(['#bold', '#em'])
  // every structure is walked
  expect(html('- one #li')).toContain('<span class="list-item">one ' + link('#li') + '</span>')
  expect(html('| h |\n|---|\n| #cell |')).toContain('<td>' + link('#cell') + '</td>')
})

test("tag links: none in the label of a Markdown link that is followed, bare or in a code span; a reply's child mark there is unchanged", () => {
  // an agent writes `[#roadmap](url)`, or an issue link whose label is a hash and a number: a press on
  // the label opens the url, as before tag links. so nothing in such a label is a tag link, at any depth;
  // the tag after the link is one
  const anchor = (inner: string) => '<a href="' + grammarRefs('https://example.org/roadmap') + '" target="_blank" rel="noopener">' + inner + '</a>'
  for (const [label, inner] of [
    ['#roadmap', '&#35;roadmap'],
    ['`#roadmap`', '<code>&#35;roadmap</code>'],
    ['issue #12', 'issue &#35;12'],
    ['**see `#a` and #b**', '<strong>see <code>&#35;a</code> and &#35;b</strong>'],
  ])
    expect(html(`[${label}](https://example.org/roadmap) then #yes`), label).toBe(wrapped(anchor(inner) + ' then ' + link('#yes')))
  // a reply's child mark in such a label is what it was (the frame cancels the anchor at its press and its
  // click); a full tag beside it is the label's text. in a tree the one-segment form is text there, as before
  const ctx = { id: 'i1', label: '#chat', labelText: '#Chat', danglingTags: new Set<string>() }
  expect(renderInertMarkdown('[see #/alpha and #todo/alpha](https://example.org/roadmap)', ctx)).toBe(
    wrapped(anchor('see <mark title="&#35;Chat&#47;alpha" data-tag="&#35;Chat&#47;alpha" data-reltag="&#35;&#47;alpha">alpha</mark> and &#35;todo&#47;alpha')),
  )
  expect(renderInertMarkdown('[see #/alpha](https://example.org/roadmap)', null, '#Chat')).toBe(wrapped(anchor('see &#35;&#47;alpha')))
  // a link that is NOT followed is shown as its text and its destination, with no anchor: a tag in its
  // label is a link like any other
  expect(html('[see #x](#y)')).toBe(wrapped('see ' + link('#x') + ' (&#35;y)'))
})

test('tag links: a code span that is exactly one tag; a relative tag resolved against the label; an unresolvable or a hidden one stays plain', () => {
  // INLINE CODE: the whole content is one tag by tagRegex (Marked's content: a longer backtick run, one
  // space of padding); a span that merely holds a hash-word stays the plain code span it was
  expect(html('`#todo/alpha`')).toBe(wrapped(link('#todo/alpha'))) // the same element as a bare tag's
  expect(tagLinks(html('``#a`` and ` #b `')).map(l => l[0])).toEqual(['#a', '#b'])
  for (const span of ['a #x', '#x #y', '#x.', 'x#y', '#', '#x#y', '#<b>']) expect(html('`' + span + '`'), span).toBe(wrapped('<code>' + grammarRefs(span) + '</code>'))
  // RELATIVE: the link's tag is the resolved, absolute one (resolveRelativeTag against the label as
  // written, here of two levels); the text shown stays as written, bare or in a code span
  const under = (label: string, body: string) => renderInertMarkdown(body, null, label)
  expect(tagLinks(under('#Chat/4', '#/kid #//sib #///up #/a/b and `#/kid`'))).toEqual([
    ['#Chat/4/kid', '#/kid'],
    ['#Chat/sib', '#//sib'],
    ['#up', '#///up'],
    ['#Chat/4/a/b', '#/a/b'],
    ['#Chat/4/kid', '#/kid'],
  ])
  // UNRESOLVABLE: a root's `#///x`, and every relative form in an item without a label, stays as it was
  // (text, or a plain code span); an absolute tag needs no label
  expect(under('#Chat', '#///up and `#///up`')).toBe(wrapped('&#35;&#47;&#47;&#47;up and <code>&#35;&#47;&#47;&#47;up</code>'))
  expect(under('', '#/kid #//sib #/a/b `#/kid`')).not.toContain('tag-link')
  expect(tagLinks(under('', '#/kid and #abs'))).toEqual([['#abs', '#abs']])
  // HIDDEN (the app's test: the resolved tag starts with `#_`): plain, written so or resolved so (a
  // root's `#//_x` is `#_x`); an underscore deeper in a tag hides nothing, as in the app
  expect(under('#Chat', '#_hidden `#_hidden` #//_auto `#//_auto`')).toBe(
    wrapped('&#35;&#95;hidden <code>&#35;&#95;hidden</code> &#35;&#47;&#47;&#95;auto <code>&#35;&#47;&#47;&#95;auto</code>'),
  )
  expect(tagLinks(under('#Chat', '#a/_b #/_kid'))).toEqual([
    ['#a/_b', '#a/_b'],
    ['#Chat/_kid', '#/_kid'],
  ])
})

test("tag links in a reply: a child tag stays the item's mark, what the child tags do not take is a link; nothing is injected", () => {
  // a reply's region (the child-tag context): the one-segment relative forms are the item's child tags,
  // marks exactly as before; a full tag, a deeper relative path and a code span beside them are links
  const ctx = { id: 'i1', label: '#chat', labelText: '#Chat', danglingTags: new Set(['#chat/gone']) }
  const body = 'see #/alpha and #todo/alpha, #/a/b, `#/alpha` and #/gone'
  const reply = renderInertMarkdown(body, ctx)
  expect([...reply.matchAll(/<mark([^>]*)>([^<]*)<\/mark>/g)].map(m => m[1] + '|' + m[2])).toEqual([
    ' title="&#35;Chat&#47;alpha" data-tag="&#35;Chat&#47;alpha" data-reltag="&#35;&#47;alpha"|alpha',
    ' class="dangling" title="&#35;Chat&#47;gone" data-tag="&#35;Chat&#47;gone" data-reltag="&#35;&#47;gone"|&#35;&#47;gone',
  ])
  expect(tagLinks(reply)).toEqual([
    ['#todo/alpha', '#todo/alpha'],
    ['#Chat/a/b', '#/a/b'],
    ['#Chat/alpha', '#/alpha'],
  ])
  // the index reads the same child tags as before, and no link is one (no mark, no data-tag)
  expect(inertChildTags(body)).toEqual(['#/alpha', '#/gone'])
  expect(reply.match(/data-tag=/g)).toHaveLength(2)
  // the same body in a section that is no reply (an agent's tree, a request): no mark, every tag a link
  const tree = renderInertMarkdown(body, null, '#Chat')
  expect(tree).not.toContain('<mark')
  expect(tagLinks(tree).map(l => l[0])).toEqual(['#Chat/alpha', '#todo/alpha', '#Chat/a/b', '#Chat/alpha', '#Chat/gone'])
  // there too the app's exclusions hold for a one-segment form, and a raw-text element's content is text;
  // so is the text inside Marked's own raw block, in a reply and in a tree, as a child tag is none there
  expect(renderInertMarkdown('<<macro #/no>> a <style> #/no `#no` </style>', null, '#Chat')).not.toContain('tag-link')
  for (const context of [ctx, null]) expect(renderInertMarkdown('a <kbd> #no and #/no </kbd> <code> #no </code>', context, '#Chat')).not.toMatch(/tag-link|<mark/)
  // a code span inside such a pair is no link either, also under an emphasis; the span after the pair is one
  for (const context of [ctx, null])
    expect(tagLinks(renderInertMarkdown('a <kbd>`#no`</kbd> <code> `#no` **`#no`** </code> then `#yes`', context, '#Chat')).map(l => l[0])).toEqual(['#yes'])
  expect(tagLinks(renderInertMarkdown('a <kbd>k</kbd> #yes <b> #yes2 </b>', null, '#Chat')).map(l => l[0])).toEqual(['#yes', '#yes2'])
  // NOTHING INJECTED: a tag's characters cannot hold a quote, an angle bracket or an ampersand (the tag
  // ends there, and what follows is the text or the visible html it was), and whatever a tag or a label
  // holds is character references in the text and in both attribute values
  const odd = '#on=x/%22%3E@$^|+-'
  expect(html(odd + '<img src=x onerror=alert(1)> #q"onmouseover="x')).toBe(
    wrapped(link(odd) + '<code>&#60;img src&#61;x onerror&#61;alert&#40;1&#41;&#62;</code> ' + link('#q') + '&#34;onmouseover&#61;&#34;x'),
  )
  const hostile = renderInertMarkdown('#/x and `#/x`', null, '#L"><img src=x onerror=alert(1)>')
  expect(tagLinks(hostile)).toEqual([
    ['#L"><img src=x onerror=alert(1)>/x', '#/x'],
    ['#L"><img src=x onerror=alert(1)>/x', '#/x'],
  ])
  expect(hostile.replace(/<\/?(?:div|p|code)\b[^<>]*>/g, '')).toMatch(/^[A-Za-z0-9 &#;]*$/) // no other element, no raw character
  expect(bareText(html(odd + ' `' + odd + '`'))).toMatch(/^[A-Za-z0-9 ]*$/)
})

// COMMAND LINKS (the owner, 2026-11-23): an inline-code command in an inert section becomes a quiet
// link (`code.command-link`, with `title` and `data-command-link` holding the exact command text).
// A command outside an inert section is the owner's text and never reaches this renderer.
const cmdLinks = (h: string) =>
  [...h.matchAll(/<code class="command-link" title="([^"]*)" data-command-link="\1">([^<]*)<\/code>/g)].map(m => [decoded(m[1]), decoded(m[2])])
const cmdLink = (cmd: string) => `<code class="command-link" title="${grammarRefs(cmd)}" data-command-link="${grammarRefs(cmd)}">${grammarRefs(cmd)}</code>`

test("command links: an inline-code command is a quiet link by the app's own rule; paths, multi-line, non-ASCII, over-length, and excluded spans stay plain", () => {
  // the owner's example, a bare command name, double-backtick and single-space padding, and arguments with a tag
  const owner = '/_update key_buttons mind.items preview'
  expect(html('run `' + owner + '` now'), 'command-link rule links inline-code commands').toBe(
    wrapped('run ' + cmdLink(owner) + ' now'),
  )
  expect(html('`/_invert`'), 'command-link rule links a bare command name').toBe(wrapped(cmdLink('/_invert')))
  expect(
    cmdLinks(html('``/_push`` and ` /_zoom ` and `/_rename #old #new`')),
    'command-link rule handles double backticks, single-space padding, and tag arguments',
  ).toEqual([
    ['/_push', '/_push'],
    ['/_zoom', '/_zoom'],
    ['/_rename #old #new', '/_rename #old #new'],
  ])
  expect(html('`/_rename #old #new`'), 'command with tag argument is not a tag-link').not.toContain('tag-link')
  // exact length boundary: 200 characters allowed, 201 rejected
  const max200 = '/_cmd ' + 'a'.repeat(194)
  const over201 = '/_cmd ' + 'a'.repeat(195)
  expect(max200.length).toBe(200)
  expect(cmdLinks(html('`' + max200 + '` and `' + over201 + '`')), 'command-link length cap allows 200 and rejects 201').toEqual([
    [max200, max200],
  ])
  expect(html('`' + over201 + '`'), 'over-length command span renders as plain code').toBe(
    wrapped('<code>' + grammarRefs(over201) + '</code>'),
  )
  // bare prose (not a code span) and fenced code blocks are never command links
  expect(html(owner), 'bare prose command is never linked').not.toContain('command-link')
  expect(html('```\n' + owner + '\n```'), 'fenced code command is never linked').not.toContain('command-link')
  // kept out: paths, punctuation right after the name, empty/leading/trailing space, two lines
  for (const span of [
    '/Users/x/y',
    '/a/b',
    '/foo.bar',
    '/foo-bar',
    '//foo',
    '/',
    '/ foo',
    '/_invert ',
    '/_invert   ',
    '/_update\nkey_buttons',
    '/_update\r\nkey_buttons',
  ])
    expect(html('`' + span + '`'), `syntax/line exclusion rejects ${JSON.stringify(span)}`).not.toContain('command-link')
  expect(html('`  /_invert  `'), 'leading/trailing spaces beyond single-space padding rejected').not.toContain('command-link')
  // kept out by the printable-ASCII bound: non-ASCII (accents, look-alikes, ZWSP, bidi) and control chars (tab, bell)
  for (const span of [
    '/_update café',
    '/_update \u0430',
    '/_update foo\u200bbar',
    '/_update \u202ebar',
    '/_update\tfoo',
    '/_update foo\u0007bar',
  ])
    expect(html('`' + span + '`'), `printable-ASCII bound rejects ${JSON.stringify(span)}`).not.toContain('command-link')
  // same exclusions as a tag code span: followed Markdown link label (not an unfollowed link),
  // raw html blocks, raw-text elements, Marked raw blocks, image alt, macros, eval macros, 4-space lines
  expect(html('[`/_update a`](https://example.org) and [**`/_update b`**](https://example.org) then `/_yes`')).not.toContain('command-link" title="&#47;&#95;update')
  expect(cmdLinks(html('[`/_update a`](https://example.org) then `/_yes`'))).toEqual([['/_yes', '/_yes']])
  expect(cmdLinks(html('[`/_ok`](#dest)'))).toEqual([['/_ok', '/_ok']])
  for (const body of [
    '<div>\n`/_no`\n</div>\n\nthen `/_yes`',
    'a <script> `/_no` </script> then `/_yes`',
    'a <style> `/_no` </style> then `/_yes`',
    'a <pre> `/_no` </pre> then `/_yes`',
    'a <textarea> `/_no` </textarea> then `/_yes`',
    'a <title> `/_no` </title> then `/_yes`',
    'a <code> `/_no` **`/_no`** </code> then `/_yes`',
    'a <kbd>`/_no`</kbd> then `/_yes`',
    '![`/_no`](https://e.org/i.png) then `/_yes`',
    '<<m `/_no` *see `/_no`*>> then `/_yes`',
    '@{ `/_no` }@ then `/_yes`',
    'a line\n     four spaces: `/_no`\nthen `/_yes`',
  ])
    expect(cmdLinks(html(body)), body).toEqual([['/_yes', '/_yes']])
  // a tag's code span is still a tag link (never a command link), and inertChildTags is untouched
  expect(html('`#todo/alpha` and `/_invert`')).toBe(wrapped(link('#todo/alpha') + ' and ' + cmdLink('/_invert')))
  expect(inertChildTags('see #/kid and `/_update a`')).toEqual(['#/kid'])
  // security: HTML-special printable ASCII characters stay encoded via grammarRefs (no raw markup)
  const special = `/_cmd "a" <img src=x onerror=alert(1)> & 'b'`
  const rendered = html('`' + special + '`')
  expect(cmdLinks(rendered)).toEqual([[special, special]])
  expect(rendered.replace(/<\/?(?:div|p|code)\b[^<>]*>/g, '')).toMatch(/^[A-Za-z0-9 &#;]*$/)
})
