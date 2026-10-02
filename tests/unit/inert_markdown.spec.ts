import { expect, test } from '@playwright/test'
import { decodeEntities, grammarRefs, highlightCode, inertChildTags, renderInertMarkdown } from '../../src/inert_markdown.js'

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

test('app grammar, macros, tags, math, wiki and jinja are ordinary text', () => {
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
  // case, no inline handler, `renderTag`'s display) with `missing` from the item's computed state;
  // everything else stays text, and `inertChildTags` names exactly the tokens the marks render
  const ctx = { id: 'i1', label: '#chat', labelText: '#Chat', missingTags: new Set(['#chat/gone']) }
  const render = (body: string, c = ctx) => renderInertMarkdown(body, c)
  const marks = (h: string) => [...h.matchAll(/<mark([^>]*)>([^<]*)<\/mark>/g)].map(m => m[1] + '|' + m[2])
  const reltags = (h: string) => [...h.matchAll(/data-reltag="([^"]*)"/g)].map(m => m[1].replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).toLowerCase())
  const agree = (body: string) => expect(reltags(render(body)), body).toEqual(inertChildTags(body))
  // the mark: the absolute tag in the label's case, the relative token, the display without `#/`
  expect(marks(render('see #/alpha and #/gone'))).toEqual([
    ' title="&#35;Chat&#47;alpha" data-tag="&#35;Chat&#47;alpha" data-reltag="&#35;&#47;alpha"|alpha',
    ' class="missing" title="&#35;Chat&#47;gone" data-tag="&#35;Chat&#47;gone" data-reltag="&#35;&#47;gone"|gone',
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
  expect(render('#/gone', { ...ctx, missingTags: new Set() })).not.toContain('missing')
  expect(render('#/gone')).toContain('class="missing"')
  expect(renderInertMarkdown('#/gone')).not.toContain('<mark')
  // the extraction walks every structure
  expect(inertChildTags('- #/a\n- b #/b\n\n> #/c\n\n| h |\n|---|\n| #/d |\n\n[#/e](https://e.org) `#/no`')).toEqual(['#/a', '#/b', '#/c', '#/d', '#/e'])
})
