import { expect, test } from '@playwright/test'
import { Marked } from 'marked'
import { createRequire } from 'node:module'

;(globalThis as any).window = { _shortcut_hosts: [] }
const lodash = createRequire(import.meta.url)('lodash')
;(globalThis as any)._ = lodash

import { collectLinkDefs, highlightLinks } from '../../src/editor_links.js'
import { wikiLinkExtension } from '../../src/wiki_links.js'

const READWISE_APP_URL = 'https://read.readwise.io/read/01m8b6pz0vv3wqhn3syg19ycvg'

const markedWithWiki = new Marked({ gfm: true, breaks: true })
markedWithWiki.use({ extensions: [wikiLinkExtension(() => ({ url: 'obsidian://open' }))] })

// minimal pre-link inline pass matching Editor.svelte's tag/code/title transforms
const highlightInline = (s: string): string =>
  lodash
    .escape(s)
    .replace(/^(\s{0,3}#{1,6}\s+)(.+)$/, (_m: string, pfx: string, title: string) => `${pfx}<span class="title">${title}</span>`)
    .replace(/(^|\s)(#tag)\b/g, '$1<mark>$2</mark>')
    .replace(/``([^`\n]+)``/g, '<span class="code">``$1``</span>')
    .replace(/`([^`\n]+)`/g, '<span class="code">`$1`</span>')

// mirrors Editor.svelte's updateTextDivs line loop (backtick fences, 4-space non-list lines, unclosed fallback)
const highlightEditorDoc = (doc: string): string => {
  const defs = collectLinkDefs(doc)
  let insideBlock = false
  let code = ''
  let html = ''
  for (const line of doc.split('\n')) {
    if (!insideBlock && /^\s*```/.test(line)) {
      insideBlock = true
      code = ''
      html += lodash.escape(line) + '\n'
    } else if (insideBlock && /^\s*```/.test(line)) {
      html += `<div class="block">${lodash.escape(code)}</div>\n`
      insideBlock = false
      html += lodash.escape(line) + '\n'
    } else if (insideBlock) {
      code += line + '\n'
    } else if (/^     *[^-*+ ]/.test(line)) {
      html += lodash.escape(line) + '\n'
    } else {
      html += highlightLinks(highlightInline(line), defs) + '\n'
    }
  }
  if (insideBlock) html += highlightLinks(highlightInline(code))
  return html
}

test('rule 1: a reference is coloured when any line has the shape of a definition for its label', () => {
  const doc = [
    '- a claim ([app][a1], [web][w1])',
    '[a1]: https://read.readwise.io/read/01m8b6pz0vv3wqhn3syg19ycvg',
    '   [W1]: https://alexwang.ai/posts/associative-memory/#rw=01m8:~:text=small',
    '[a  b]: https://example.org/space "Title"',
    "[a & b]: https://example.org/amp 'Single'",
    '[t1]: #mytag (Paren Title)',
    '[r1]: /rel/path',
    '[g1]: <https://example.org/angle>',
    '    [four]: https://example.org/four-spaces',
    '[bad]: https://example.org/a extra words',
    '[   ]: https://example.org/blank-label',
    '[empty]:',
  ].join('\n')
  const defs = collectLinkDefs(doc)
  expect([...defs].sort(), 'collectLinkDefs gathers all valid definition labels').toEqual([
    'a & b',
    'a b',
    'a1',
    'g1',
    'r1',
    't1',
    'w1',
  ])

  const cases: [string, string, ReadonlySet<string>, string][] = [
    [
      'defined refs (case-insensitive)',
      '- a claim ([app][a1], [web][w1], [APP][A1])',
      defs,
      '- a claim (<span class="link">[app][a1]</span>, <span class="link">[web][w1]</span>, <span class="link">[APP][A1]</span>)',
    ],
    [
      'whitespace-folded and entity-escaped labels',
      '[sp][ A\tb ] and [am][a & b]',
      defs,
      '<span class="link">[sp][ A\tb ]</span> and <span class="link">[am][a &amp; b]</span>',
    ],
    [
      'tag, relative, and angle definitions resolve references',
      '[t][t1] [r][r1] [g][g1]',
      defs,
      '<span class="link">[t][t1]</span> <span class="link">[r][r1]</span> <span class="link">[g][g1]</span>',
    ],
    [
      'undefined label, 4-space or malformed definition, and x[i][j] stay plain',
      '[app][a1] [web][missing] [four][four] [extra][bad] x[i][j]',
      defs,
      '<span class="link">[app][a1]</span> [web][missing] [four][four] [extra][bad] x[i][j]',
    ],
    ['x[i][j] with empty definitions stays plain', 'x[i][j]', new Set(), 'x[i][j]'],
    ['chained brackets match the defined tail', '[a][b][a1]', new Set(['a1']), '[a]<span class="link">[b][a1]</span>'],
    [
      'markdown link and reference link in both orders',
      '[web](https://example.org/a) and [app][a1] then [web](https://example.org/b)',
      new Set(['a1']),
      '<span class="link">[web](<span class="link">https://example.org/a</span>)</span> and <span class="link">[app][a1]</span> then <span class="link">[web](<span class="link">https://example.org/b</span>)</span>',
    ],
  ]
  for (const [name, raw, d, expected] of cases) {
    expect(highlightLinks(lodash.escape(raw), d), name).toBe(expected)
  }

  // inside heading title, and with inline code or tag in the label
  expect(highlightLinks('# <span class="title">Heading [app][a1]</span>', defs)).toBe(
    '# <span class="title">Heading <span class="link">[app][a1]</span></span>'
  )
  expect(highlightLinks('[<span class="code">`app`</span>][a1] and [see <mark>#tag</mark>][a1]', defs)).toBe(
    '<span class="link">[<span class="code">`app`</span>][a1]</span> and <span class="link">[see <mark>#tag</mark>][a1]</span>'
  )
})

test('rule 2: both shapes colour when definitions are passed and stay plain when omitted', () => {
  const emptyDefs = new Set<string>()
  const defs = new Set(['a1'])
  const accepted: [string, string, string][] = [
    ['plain wiki link', '[[notes/first]]', '<span class="link">[[notes/first]]</span>'],
    ['aliased wiki link', '[[notes/first|First Note]]', '<span class="link">[[notes/first|First Note]]</span>'],
    ['embed', '![[agents/worker]]', '<span class="link">![[agents/worker]]</span>'],
    [
      'two on one line',
      'see [[docs/a]] and [[docs/b|B]]',
      'see <span class="link">[[docs/a]]</span> and <span class="link">[[docs/b|B]]</span>',
    ],
    [
      'diff fragment, escaped ampersand, lone bracket',
      '[[worktrees/t#diff]] [[notes/A&B]] [[a]b]]',
      '<span class="link">[[worktrees/t#diff]]</span> <span class="link">[[notes/A&amp;B]]</span> <span class="link">[[a]b]]</span>',
    ],
  ]
  for (const [name, raw, expected] of accepted) {
    expect(highlightLinks(lodash.escape(raw), emptyDefs), name).toBe(expected)
  }
  expect(highlightLinks('# <span class="title">See [[docs/x]]</span>', emptyDefs)).toBe(
    '# <span class="title">See <span class="link">[[docs/x]]</span></span>'
  )
  expect(highlightLinks('[[notes/first|see <mark>#tag</mark>]]', emptyDefs)).toBe(
    '<span class="link">[[notes/first|see <mark>#tag</mark>]]</span>'
  )

  for (const refused of [
    '[[]]',
    '[[ ]]',
    '[[a|]]',
    '[[#heading]]',
    '[[../x]]',
    '[[a/../b]]',
    '[[./x]]',
    '[[a//b]]',
    '[[docs/]]',
    '[[/etc/passwd]]',
    '[[https://x.y/z]]',
    '[[mailto:x]]',
    '[[a\\b]]',
    '[[a"b]]',
    '[[a<b]]',
    '[[../a][a1]]',
  ]) {
    const escaped = lodash.escape(refused)
    expect(highlightLinks(escaped, defs), refused).toBe(escaped)
  }

  // omitting defs leaves both new shapes plain while keeping markdown link and bare URL colouring
  const mixed = lodash.escape('[in](https://example.org/in) https://example.org/bare [app][a1] [[notes/first]]')
  expect(highlightLinks(mixed), 'omitted defs keeps both new shapes plain').toBe(
    '<span class="link">[in](<span class="link">https://example.org/in</span>)</span> <span class="link">https://example.org/bare</span> [app][a1] [[notes/first]]'
  )
  expect(highlightLinks(mixed, defs), 'passed defs colours both new shapes').toBe(
    '<span class="link">[in](<span class="link">https://example.org/in</span>)</span> <span class="link">https://example.org/bare</span> <span class="link">[app][a1]</span> <span class="link">[[notes/first]]</span>'
  )
})

test('rule 3: nothing inside spans of earlier passes is recoloured', () => {
  const defs = new Set(['a1', 'b'])

  const opaqueCases: [string, string][] = [
    ['single-backtick code span ref', 'see <span class="code">`[app][a1]`</span> here'],
    ['single-backtick code span wiki', 'see <span class="code">`[[notes/x]]`</span> here'],
    ['double-backtick code span wiki', 'see <span class="code">``[[notes/x]]``</span> here'],
    ['math span', '<span class="math">$`x[i][a1] [[notes/x]]`$</span>'],
    [
      'macro span',
      '<span class="macro"><span class="macro-delimiter">&lt;&lt;</span>x[i][a1] [[notes/x]]<span class="macro-delimiter">&gt;&gt;</span></span>',
    ],
    [
      'hljs tag span',
      '<span class="hljs-tag">&lt;<span class="hljs-name">a</span> <span class="hljs-attr">title</span>=<span class="hljs-string">&quot;[app][a1] [[notes/x]]&quot;</span>&gt;</span>',
    ],
    ['unclosed ref bracket before code span', 'see [unclosed <span class="code">`x][a1]`</span> end'],
    ['unclosed wiki bracket before code span', 'see [[unclosed <span class="code">`x]]`</span> end'],
  ]
  for (const [name, input] of opaqueCases) {
    expect(highlightLinks(input, defs), name).toBe(input)
  }

  // existing markdown-link highlighting inside a code span stays as today while new shapes stay plain
  expect(
    highlightLinks('see <span class="code">`[in](https://example.org/in) [app][a1] [[notes/x]]`</span>', defs)
  ).toBe(
    'see <span class="code">`<span class="link">[in](<span class="link">https://example.org/in</span>)</span> [app][a1] [[notes/x]]`</span>'
  )

  // bare addresses, markdown destinations and definition addresses keep their one link span
  const addressCases: [string, string, string][] = [
    [
      'bare address with defined [a][b]',
      'https://example.org/b?f[a][b]=c',
      '<span class="link">https://example.org/b?f[a][b]=c</span>',
    ],
    [
      'bare address with [a][b] followed by real reference',
      'see https://example.org/b?f[a][b]=c and [app][b]',
      'see <span class="link">https://example.org/b?f[a][b]=c</span> and <span class="link">[app][b]</span>',
    ],
    [
      'bare address in parens',
      '(https://example.org/b?f[a][b]=c)',
      '(<span class="link">https://example.org/b?f[a][b]=c</span>)',
    ],
    [
      'markdown link destination with [a][b]',
      '[web](https://example.org/b?f[a][b]=c)',
      '<span class="link">[web](<span class="link">https://example.org/b?f[a][b]=c</span>)</span>',
    ],
    [
      'definition line address with [a][b]',
      '[a1]: https://example.org/b?f[a][b]=c',
      '[a1]: <span class="link">https://example.org/b?f[a][b]=c</span>',
    ],
    [
      'bare address with wiki brackets',
      'https://example.org/b?p=[[notes/first]]&q=1',
      '<span class="link">https://example.org/b?p=[[notes/first]]&amp;q=1</span>',
    ],
  ]
  for (const [name, raw, expected] of addressCases) {
    expect(highlightLinks(lodash.escape(raw), defs), name).toBe(expected)
  }
})

test('rule 4: escapes keep wiki openers and reference brackets plain while double backslashes and embeds colour', () => {
  const defs = new Set(['a1'])
  const wikiCases: [string, string, string, boolean][] = [
    ['single-backslash wiki escape stays plain', '\\[[docs/path]]', '\\[[docs/path]]', false],
    ['double-backslash wiki allows the link', '\\\\[[docs/path]]', '\\\\<span class="link">[[docs/path]]</span>', true],
    ['triple-backslash wiki escape stays plain', '\\\\\\[[docs/path]]', '\\\\\\[[docs/path]]', false],
    ['embed colours whole', '![[docs/path]]', '<span class="link">![[docs/path]]</span>', true],
    ['escaped bang leaves inner wiki link coloured', '\\![[docs/path]]', '\\!<span class="link">[[docs/path]]</span>', true],
    ['escaped bracket after bang stays plain', '!\\[[docs/path]]', '!\\[[docs/path]]', false],
    ['double-backslash embed colours whole', '\\\\![[docs/path]]', '\\\\<span class="link">![[docs/path]]</span>', true],
    ['escaped aliased wiki link stays plain', '\\[[docs/path|alias]]', '\\[[docs/path|alias]]', false],
    [
      'double-backslash aliased wiki link colours',
      '\\\\[[docs/path|alias]]',
      '\\\\<span class="link">[[docs/path|alias]]</span>',
      true,
    ],
  ]
  for (const [name, raw, expected, isLink] of wikiCases) {
    expect(markedWithWiki.parseInline(raw, { async: false }).includes('data-wiki-link'), `Marked oracle: ${name}`).toBe(
      isLink
    )
    expect(highlightLinks(lodash.escape(raw), defs), name).toBe(expected)
  }

  const refCases: [string, string, string][] = [
    ['escaped reference stays plain', '\\[app][a1]', '\\[app][a1]'],
    ['double-backslash reference colours', '\\\\[app][a1]', '\\\\<span class="link">[app][a1]</span>'],
    ['triple-backslash reference stays plain', '\\\\\\[app][a1]', '\\\\\\[app][a1]'],
  ]
  for (const [name, raw, expected] of refCases) {
    expect(highlightLinks(lodash.escape(raw), defs), name).toBe(expected)
  }
})

test('by choice: a definition directly under a list item colours the reference', () => {
  const doc = ['- claim [app][a]', '[a]: /x'].join('\n')
  expect([...collectLinkDefs(doc)]).toEqual(['a'])
  expect(highlightEditorDoc(doc).split('\n')[0]).toBe('- claim <span class="link">[app][a]</span>')
})

test('by choice: a definition-looking line continuing a paragraph or under a setext underline colours the reference', () => {
  const cases: [string, string][] = [
    ['continuing a paragraph', '[app][a]\n\nordinary prose\n[a]: https://example.org/path'],
    ['directly under reference line', '[app][a]\n[a]: https://example.org/path'],
    ['under a setext underline', '[app][a]\n\nHeading\n===\n[a]: /x'],
  ]
  for (const [name, doc] of cases) {
    expect([...collectLinkDefs(doc)], `${name}: collected`).toEqual(['a'])
    expect(highlightEditorDoc(doc).split('\n')[0], `${name}: coloured`).toBe('<span class="link">[app][a]</span>')
  }
})

test('by choice: tilde block, indented list marker, and multiline code span follow the editor line loop', () => {
  // inside a tilde block: editor treats lines as ordinary text, colouring markdown links and both new shapes
  const tildeDoc = [
    '~~~',
    '[in](https://example.org/in) [app][a] [[notes/x]]',
    '[a]: /x',
    '~~~',
  ].join('\n')
  expect(highlightEditorDoc(tildeDoc).split('\n')[1], 'inside tilde block').toBe(
    '<span class="link">[in](<span class="link">https://example.org/in</span>)</span> <span class="link">[app][a]</span> <span class="link">[[notes/x]]</span>'
  )

  // indented line starting with a list marker at item start (not matched by `^     *[^-*+ ]`): coloured
  const indentedListDoc = ['    - [in](https://example.org/in) [app][a] [[docs/x]]', '[a]: /x'].join('\n')
  expect(highlightEditorDoc(indentedListDoc).split('\n')[0], 'indented list marker at item start').toBe(
    '    - <span class="link">[in](<span class="link">https://example.org/in</span>)</span> <span class="link">[app][a]</span> <span class="link">[[docs/x]]</span>'
  )
  // contrast: 4-space indented non-list line stays plain in the editor loop
  const indentedCodeDoc = ['    [in](https://example.org/in) [app][a] [[docs/x]]', '[a]: /x'].join('\n')
  expect(highlightEditorDoc(indentedCodeDoc).split('\n')[0], '4-space non-list line stays plain').toBe(
    '    [in](https://example.org/in) [app][a] [[docs/x]]'
  )

  // code span crossing a line break: editor runs inline code per line, so both lines colour links
  const multilineCodeSpan = [
    'Type `[[notes/a]] [in](https://example.org/in)',
    'and [app][a]` literally.',
    '',
    '[a]: /x',
  ].join('\n')
  const mlLines = highlightEditorDoc(multilineCodeSpan).split('\n')
  expect(mlLines[0], 'multiline code span line 1').toBe(
    'Type `<span class="link">[[notes/a]]</span> <span class="link">[in](<span class="link">https://example.org/in</span>)</span>'
  )
  expect(mlLines[1], 'multiline code span line 2').toBe('and <span class="link">[app][a]</span>` literally.')
})

test('by choice: the fallback for an unfinished backtick block colours neither references nor wiki links', () => {
  const unclosed = [
    '[a1]: https://example.org/a',
    '',
    '[[notes/x]] and [app][a1]',
    '```',
    'see #tag and `code` and [in](https://example.org/in) and https://example.org/bare',
    '[[notes/x]] and ![[notes/embed]] and [app][a1]',
  ].join('\n')
  const lines = highlightEditorDoc(unclosed).split('\n')
  expect(lines[2], 'ordinary line before opener colours both shapes').toBe(
    '<span class="link">[[notes/x]]</span> and <span class="link">[app][a1]</span>'
  )
  expect(lines[4], 'fallback preserves other markup, markdown links and bare URLs').toBe(
    'see <mark>#tag</mark> and <span class="code">`code`</span> and <span class="link">[in](<span class="link">https://example.org/in</span>)</span> and <span class="link">https://example.org/bare</span>'
  )
  expect(lines[5], 'fallback leaves references and wiki links plain').toBe(
    '[[notes/x]] and ![[notes/embed]] and [app][a1]'
  )

  // backticks inside a tilde block leave the editor's backtick block unclosed -> fallback leaves tail plain
  const ticksInTilde = ['~~~', '```', '~~~', '[[outside]]'].join('\n')
  expect(highlightEditorDoc(ticksInTilde).split('\n')[3], 'backtick opener inside tilde enters fallback').toBe(
    '[[outside]]'
  )
})

test("compatibility: the landed file's 26 lines match the landed highlightLinks with definitions on, except the wiki fixture", () => {
  const defs = new Set(['other'])
  const landedLines: [string, string, string?][] = [
    ['tag link (raw)', lodash.escape('[tag](#mytag)')],
    ['tag link (after highlightTags)', '[tag](<mark>#mytag</mark>)'],
    ['fragment link', lodash.escape('[section](#heading-1)')],
    ['script link', lodash.escape('[run](javascript:window._x=1)')],
    ['label that is an address', lodash.escape('[https://example.com/a](https://example.com/b)')],
    ['label containing an address', lodash.escape('[see https://example.com/a here](https://example.com/b)')],
    ['two links in a line', lodash.escape('see [one](https://example.com/1) and [two](https://example.com/2)')],
    ['link inside a code span', 'see <span class="code">`[a](https://example.com/a)`</span> here'],
    ['link inside math', '<span class="math">$`[a](https://example.com/a)`$</span>'],
    [
      'link inside a macro',
      '<span class="macro"><span class="macro-delimiter">&lt;&lt;</span>[a](https://example.com/a)<span class="macro-delimiter">&gt;&gt;</span></span>',
    ],
    ['earlier-pass code span inside target', '[x](https://example.com/a<span class="code">`code`</span>)'],
    [
      'bare address with a colon after its host',
      lodash.escape('see https://alexwang.ai/posts/associative-memory/#rw=01m8:~:text=foo end'),
    ],
    ['bare address in round brackets with a colon after its host', lodash.escape('(https://example.com/a:~:text=foo)')],
    ['reference [app][a1]', lodash.escape('see [app][a1] here')],
    [
      'wiki link',
      lodash.escape('see [[docs/mind_page]] and [[docs/mind_page|MindPage]]'),
      'see <span class="link">[[docs/mind_page]]</span> and <span class="link">[[docs/mind_page|MindPage]]</span>',
    ],
    ['x[i][j]', lodash.escape('x[i][j]')],
    ['unfinished link (address)', lodash.escape('[unfinished](https://example.com/a')],
    ['unfinished link (colon tail)', lodash.escape('[unfinished](https://example.com/a:~:text=foo')],
    ['unfinished link (tag)', lodash.escape('[unfinished](#mytag')],
    ['unfinished link (empty)', lodash.escape('[unfinished](')],
    ['ordinary link', lodash.escape(`[app](${READWISE_APP_URL})`)],
    ['double-quoted title', lodash.escape('[note](https://example.com/a "My Title")')],
    ['single-quoted title', lodash.escape("[note](https://example.com/a 'My Title')")],
    ['definition inside a code span', '<span class="code">`[w1]: https://example.com/a:~:text=x`</span>'],
    ['tag inside label', '[see <mark>#tag</mark>](https://example.com/a)'],
    ['link inside a heading title', '# <span class="title">Heading [a](https://example.com/a)</span>'],
  ]
  expect(landedLines.length).toBe(26)
  for (const [name, line, expected] of landedLines) {
    expect(highlightLinks(line, defs), name).toBe(expected ?? highlightLinks(line))
  }
})
