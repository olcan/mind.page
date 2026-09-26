import { expect, test } from '@playwright/test'
import { Marked } from 'marked'
import {
  parseWikiLinksConfig,
  wikiLinkExtension,
  wikiLinkHtml,
  wikiLinkRegExp,
  wikiLinkTarget,
  wikiLinkUrl,
} from '../../src/wiki_links.js'
// @ts-expect-error the vendored table extension is plain js without a declaration file
import markedExtendedTables from '../../src/vendor/marked-extended-tables.js'

// wiki links (src/wiki_links.ts; design: the vault's notes/design/wiki_links.md): the grammar
// (the vault's bin/extract_links.py pattern), the target rule, the handler url, the one anchor
// form under both carriers, the config validation, and the Marked extension over a real
// instance with the app's table extension. the browser witness (tests/e2e/bridge.spec.ts)
// checks the dom the app builds, the owner's pipeline and the inert frames alike.

const config = { url: 'vscode-insiders://olcan.auto-open-obsidian/file', root: '/Users/o c/v' }
const HREF = 'vscode-insiders://olcan.auto-open-obsidian/file?path=docs%2Fx&root=%2FUsers%2Fo%20c%2Fv'
const ANCHOR = `<a href="${HREF.replace(/&/g, '&amp;')}" title="docs/x" data-wiki-link>docs/x</a>`

// every match of the grammar in `text`: [embed, target, text]
const matches = (text: string) => [...text.matchAll(wikiLinkRegExp())].map(m => [m[1], m[2], m[3]])

test('the grammar: target, display text, embed, a lone bracket, no newline', () => {
  expect(matches('see [[docs/x]] and [[a/b|shown]]')).toEqual([
    ['', 'docs/x', undefined],
    ['', 'a/b', 'shown'],
  ])
  expect(matches('![[agents/worker]]')).toEqual([['!', 'agents/worker', undefined]])
  expect(matches('[[a]b]] [[a|b|c]]')).toEqual([
    ['', 'a]b', undefined],
    ['', 'a', 'b|c'],
  ])
  expect(matches('[[]] [[a\nb]] [[[x]]] [[a|]]')).toEqual([['', '[x', undefined]])
})

test('the target rule: paths only, fragments dropped, everything else refused', () => {
  for (const [target, path] of [
    ['docs/x', 'docs/x'],
    ['docs/x.md', 'docs/x.md'],
    [' dot/editorconfig ', 'dot/editorconfig'],
    ['a b/c d', 'a b/c d'],
    ['notes/x#heading', 'notes/x'],
    ['x#^block', 'x'],
    ['bin/tool', 'bin/tool'],
    ['notes/A&B', 'notes/A&B'],
  ])
    expect(wikiLinkTarget(target), target).toBe(path)
  for (const target of [
    '',
    ' ',
    '#heading',
    '../x',
    'a/../b',
    './x',
    'a//b',
    'docs/',
    '/etc/passwd',
    'https://x.y/z',
    'mailto:x',
    'javascript:x',
    'C:\\x',
    'a\\b',
    '<b>',
    'a"b',
    'a\u0001b',
  ])
    expect(wikiLinkTarget(target), JSON.stringify(target)).toBeNull()
})

test('the url and the anchor: encoding, the root optional, no target, rel or handler', () => {
  expect(wikiLinkUrl(config, 'docs/x')).toBe(HREF)
  expect(wikiLinkUrl({ url: 'x://h/f' }, 'a b/c&d+e%f.md')).toBe('x://h/f?path=a%20b%2Fc%26d%2Be%25f.md')
  expect(wikiLinkHtml(config, 'docs/x')).toBe(ANCHOR)
  expect(wikiLinkHtml(config, 'docs/x.md', ' shown "text" ')).toBe(
    `<a href="${HREF.replace('docs%2Fx', 'docs%2Fx.md').replace(/&/g, '&amp;')}" title="docs/x.md" data-wiki-link>shown &quot;text&quot;</a>`
  ) // an explicit suffix stays: the handler resolves the path as given
  expect(wikiLinkHtml(config, 'docs/x#h', '')).toContain('>docs/x#h</a>') // an empty text shows the target as written
  // the inert carrier: letters, digits and spaces literal, everything else a reference, so a
  // consumer's tag or url pass over the html finds nothing inside the anchor
  const refs = wikiLinkHtml({ url: 'x://h/f' }, 'a b', 'see #tag <x>', { refs: true })
  expect(refs).toBe(
    '<a href="x&#58;&#47;&#47;h&#47;f&#63;path&#61;a&#37;20b" title="a b" data-wiki-link>see &#35;tag &#60;x&#62;</a>'
  )
  for (const html of [ANCHOR, refs]) expect(html).not.toMatch(/target=|rel=|\son\w+=/)
  expect(wikiLinkHtml(null, 'docs/x')).toBeNull()
  expect(wikiLinkHtml(config, '../x')).toBeNull()
})

test('the config: a handler url with a scheme and no query, an optional root', () => {
  expect(parseWikiLinksConfig(config)).toEqual(config)
  expect(parseWikiLinksConfig({ url: 'vscode://olcan.auto-open-obsidian/file', root: '', extra: 1 })).toEqual({
    url: 'vscode://olcan.auto-open-obsidian/file',
  })
  expect(parseWikiLinksConfig({ url: 'x+y.z-1://h', root: null })).toEqual({ url: 'x+y.z-1://h' })
  for (const value of [
    null,
    'x://h',
    {},
    { url: 'h/f' },
    { url: 'x://h/f?q=1' },
    { url: 'x://h/f#a' },
    { url: 'x://h/f g' },
    { url: 'javascript:alert(1)' },
    { url: 'x://h/f', root: 7 },
    { url: 'x://h/f', root: '/a\u0000b' },
  ])
    expect(parseWikiLinksConfig(value), JSON.stringify(value)).toBeNull()
})

test('the Marked extension: links in prose, cells and items; code untouched; refused spans literal', () => {
  let current: { url: string; root?: string } | null = config
  const marked = new Marked({ gfm: true })
  marked.use(markedExtendedTables())
  marked.use({ extensions: [wikiLinkExtension(() => current)] })
  const html = (text: string) => marked.parse(text, { async: false }) as string
  expect(html('see [[docs/x]] now')).toBe(`<p>see ${ANCHOR} now</p>\n`)
  expect(html('![[docs/x]]')).toBe(`<p>${ANCHOR}</p>\n`) // the embed's mark is consumed
  expect(html('[[docs/x|shown]]')).toContain('data-wiki-link>shown</a>')
  expect(html('- [[docs/x]]\n')).toContain(`<li>${ANCHOR}</li>`)
  // a table cell: the standard escaped pipe spells the alias (the table splits cells first)
  expect(html('| a |\n| - |\n| [[docs/x]] |\n')).toContain(`<td>${ANCHOR}</td>`)
  expect(html('| a |\n| - |\n| [[docs/x\\|shown]] |\n')).toContain('<td><a href="' + HREF.replace(/&/g, '&amp;') + '" title="docs/x" data-wiki-link>shown</a></td>')
  expect(html('`[[docs/x]]` and\n\n```\n[[docs/x]]\n```\n')).not.toContain('<a ')
  // a refused span is consumed and shown as written (never other grammar), an unmatched one is Marked's
  expect(html('[[../x]] [[/abs]] [[a<b]] [[]]')).toBe('<p>[[../x]] [[/abs]] [[a&lt;b]] [[]]</p>\n')
  expect(html('[[../foo]]\n\n[../foo]: https://example.com')).toBe('<p>[[../foo]]</p>\n')
  expect(html('[x][y]\n\n[y]: https://h/')).toBe('<p><a href="https://h/">x</a></p>\n') // Marked's own reference link
  // unconfigured: inert, Marked's grammar as before (the reference link included)
  current = null
  expect(html('see [[docs/x]] now')).toBe('<p>see [[docs/x]] now</p>\n')
  expect(html('[[../foo]]\n\n[../foo]: https://example.com')).toBe('<p>[<a href="https://example.com">../foo</a>]</p>\n')
})
